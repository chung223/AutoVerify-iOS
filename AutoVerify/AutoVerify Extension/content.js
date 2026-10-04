/*
 * AutoVerify for iOS Safari — content script
 *
 * 所有推論都在這裡（content script / 分頁記憶體環境）完成，刻意不放在
 * background service worker：擴充功能背景程序在 iOS 上有約 80 MB 的記憶體
 * 上限，而 ORT runtime + 13.6 MB 模型很貼近那個天花板。分頁環境已實測可行。
 *
 * 模型：ddddocr CRNN + CTC（int8 動態量化），輸入 [1,1,64,W] 灰階，
 *      ArgMax 已內建於計算圖，JS 端只需做 CTC 的去重與去 blank。
 */
(() => {
  'use strict';

  const api = typeof browser !== 'undefined' ? browser : chrome;
  if (window.__autoVerifyLoaded) return;
  window.__autoVerifyLoaded = true;

  /* ------------------------------------------------------------------ 設定 */

  const IMG_KEYWORDS = new RegExp([
    'captcha', 'verify', 'code', 'auth', 'validate', 'seccode', 'vcode', 'imgcode',
    '验证码', '校验码', '校驗碼', '驗證', '驗證碼', '图形码', '圖片驗證',
    'codigo', 'verificacion', 'verification', 'verifizieren', 'codice',
    'код', 'проверка', 'капча', 'コード', '認証', '検証', '코드', '인증'
  ].join('|'), 'i');

  const IMG_EXCLUDE = /logo|icon|avatar|banner|qr|advert|loading|spinner|close|search|flag|sprite/i;

  const INPUT_KEYWORDS = IMG_KEYWORDS;

  const CFG = {
    initialDelay: 400,     // 進頁後等一下讓動態內容渲染
    debounce: 700,         // MutationObserver 去抖
    maxScans: 30,          // 掃描次數上限，避免無限迴圈
    retryDelay: 500        // 輸入框還看不見時重試一次
  };

  // siteRules: { "example.com": { img: "<css>", input: "<css>" } }
  // 有規則的網站直接用規則，完全跳過關鍵詞／尺寸啟發式。
  let settings = { enabled: true, asciiOnly: true, disabledHosts: [], siteRules: {}, lengthCheck: true };
  // charset 有 8210 個字串（57 KB）。開了 all_frames 之後，若放在 content_scripts
  // 會在每個頁面的每個 iframe 都解析一次，而驗證碼很少遇到——改成要用時才抓。
  let charset = null;
  let session = null;            // ORT session（整頁共用一次）
  let sessionPromise = null;     // 正在載入中的 promise
  let scans = 0;
  let observer = null;

  /* ------------------------------------------------------------ 狀態指示器 */

  let badgeHost = null, badgeText = null, badgeTimer = null;

  function badge(msg, tone) {
    if (!badgeHost) {
      badgeHost = document.createElement('div');
      badgeHost.style.cssText =
        'position:fixed;z-index:2147483647;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));' +
        'pointer-events:none;';
      const shadow = badgeHost.attachShadow({ mode: 'closed' });
      const el = document.createElement('div');
      el.style.cssText =
        'font:600 13px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;color:#fff;' +
        'background:rgba(20,22,28,.92);padding:7px 12px;border-radius:9px;' +
        'box-shadow:0 4px 14px rgba(0,0,0,.28);max-width:78vw;' +
        'transition:opacity .2s;backdrop-filter:blur(8px);';
      shadow.appendChild(el);
      badgeText = el;
      (document.body || document.documentElement).appendChild(badgeHost);
    }
    badgeText.textContent = msg;
    badgeText.style.background =
      tone === 'ok'  ? 'rgba(10,132,255,.95)' :
      tone === 'err' ? 'rgba(255,59,48,.95)'  : 'rgba(20,22,28,.92)';
    badgeText.style.opacity = '1';
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => { if (badgeText) badgeText.style.opacity = '0'; },
                            tone === 'ok' ? 1600 : 2600);
  }

  /* -------------------------------------------------------------- 診斷回報 */

  function tagged(stage, e) {
    const err = new Error(stage + ': ' + ((e && e.message) ? e.message : String(e)));
    err.stage = stage;
    return err;
  }

  // 把狀態丟到頁面上（同一個 DOM，頁面腳本聽得到）。測試頁靠這個把錯誤送回開發機，
  // 一般網站不會有人聽，等同 no-op。
  function report(kind, detail) {
    try {
      window.dispatchEvent(new CustomEvent('autoverify:' + kind, { detail }));
    } catch (e) { /* 不讓診斷本身變成故障點 */ }
  }

  /* -------------------------------------------------------------- 模型載入 */

  function loadSession() {
    if (session) return Promise.resolve(session);
    if (sessionPromise) return sessionPromise;

    badge('載入辨識模型…');
    const t0 = performance.now();

    // 用 ORT 1.14 而非新版：1.19 起官方只出「執行緒版」wasm，它匯入的是 shared memory，
    // 必須用 SharedArrayBuffer 支撐並一次預留 maximum（4 GB）位址空間，iOS Safari 給不出來，
    // 直接 RangeError: Out of memory。1.14/1.18 的非執行緒版是非共享記憶體，可懶惰成長。
    // 實測（暖機後同一工作階段）1.14 / 1.18 / 1.22 速度完全相同，所以升級沒有好處。
    ort.env.wasm.wasmPaths = api.runtime.getURL('');
    ort.env.wasm.numThreads = 1;      // 避開 SharedArrayBuffer / COOP-COEP
    ort.env.wasm.simd = true;
    ort.env.logLevel = 'error';

    // 兩件事分開包，失敗時才知道是哪一個掛掉——只說「載入失敗」等於沒有資訊
    const modelP = ort.InferenceSession.create(api.runtime.getURL('model.bin'))
      .catch(e => { throw tagged('模型', e); });
    const charsetP = fetch(api.runtime.getURL('charset.json'))
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .catch(e => { throw tagged('字元表', e); });

    sessionPromise = Promise.all([modelP, charsetP])
      .then(([s, cs]) => {
        session = s;
        charset = cs;
        const ms = (performance.now() - t0).toFixed(0);
        console.log(`[AutoVerify] 模型就緒 ${ms} ms（charset ${cs.length} 類）`);
        report('ready', { ms: Number(ms), classes: cs.length });
        return s;
      })
      .catch(e => {
        sessionPromise = null;
        const msg = (e && e.message) ? e.message : String(e);
        badge('載入失敗：' + msg, 'err');
        console.error('[AutoVerify] 載入失敗:', e);
        report('error', { stage: 'load', message: msg });
        throw e;
      });

    return sessionPromise;
  }

  /* ------------------------------------------------------ 前處理 / CTC 解碼 */

  // 與 ddddocr 一致：等比縮到高 64px、灰階、正規化到 [-1,1]
  function preprocess(source, w, h) {
    const H = 64, W = Math.max(1, Math.floor(w * H / h));
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(source, 0, 0, W, H);
    const d = cx.getImageData(0, 0, W, H).data;
    const input = new Float32Array(W * H);
    for (let i = 0; i < d.length; i += 4) {
      const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      input[i / 4] = (gray / 255 - 0.5) / 0.5;
    }
    return { input, W };
  }

  // ArgMax 內建於圖中，這裡只做 CTC greedy 的「去連續重複 + 去 blank(0)」
  function ctcDecode(data) {
    const out = [];
    let last = 0;
    for (const idx of data) {
      if (idx === last) continue;
      last = idx;
      if (idx !== 0) out.push(charset[idx]);
    }
    return out.join('');
  }

  // 把來源轉成 drawImage 吃得下的東西：<img>/<canvas> 直接用，
  // CSS background-image 則先把 URL 載成 Image。
  async function toDrawable(src) {
    if (src.kind === 'img' || src.kind === 'canvas') return src.el;
    const im = new Image();
    await new Promise((ok, err) => {
      im.onload = ok;
      im.onerror = () => err(new Error('背景圖載入失敗'));
      im.src = src.url;
    });
    return im;
  }

  async function recognise(src) {
    const s = await loadSession();
    const img = await toDrawable(src);
    const w = img.naturalWidth  || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return '';
    const { input, W } = preprocess(img, w, h);
    const tensor = new ort.Tensor('float32', input, [1, 1, 64, W]);
    const out = await s.run({ input1: tensor });
    let text = ctcDecode(out['output'].data);
    // 8210 類的 charset 含大量中文，雜訊上偶爾會吐出中文字。
    // 過濾只是避免把它打進輸入框，無法救回被誤判的那個字元
    //（ArgMax 在圖內，JS 端拿不到 logits，沒辦法限制候選類別）。
    if (settings.asciiOnly) text = text.replace(/[^0-9A-Za-z]/g, '');
    return text;
  }

  /* ---------------------------------------------------------------- DOM 判定 */

  const BG_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/i;

  function onScreen(el) {
    return el.offsetParent !== null || getComputedStyle(el).position === 'fixed';
  }

  // 尺寸與關鍵詞的共同判準；text 是可比對的字串（src / alt / class / id…）
  function looksLikeCaptcha(el, text) {
    const t = (text || '').toLowerCase();
    if (!t.startsWith('data:image/') && IMG_EXCLUDE.test(t)) return false;
    const r = el.getBoundingClientRect();
    const sizeOK    = r.width > 10 && r.width < 300 && r.height > 15 && r.height < 100;
    const sizeTypic = r.width > 80 && r.width < 150 && r.height > 15 && r.height < 60;
    const hasKw = IMG_KEYWORDS.test(t) || /码|碼|校验|校驗/.test(t);
    return (sizeOK && hasKw) || sizeTypic;
  }

  function isCaptchaImage(img) {
    if (!img.src || img.naturalWidth === 0 || img.naturalHeight === 0) return false;
    if (!onScreen(img)) return false;
    return looksLikeCaptcha(img, img.src + ' ' + (img.alt || ''));
  }

  // <canvas> 畫出來的驗證碼：drawImage 直接吃得下，判準改看 class/id/aria-label
  function isCaptchaCanvas(cv) {
    if (!cv.width || !cv.height || !onScreen(cv)) return false;
    const hint = [cv.id, cv.className, cv.getAttribute('aria-label'), cv.title]
      .filter(Boolean).join(' ');
    return looksLikeCaptcha(cv, hint);
  }

  // 用 CSS background-image 當驗證碼的元素
  function captchaBackgrounds() {
    const out = [];
    for (const el of document.querySelectorAll('div,span,a,i,b,button,label')) {
      if (!onScreen(el)) continue;
      const bg = getComputedStyle(el).backgroundImage;
      if (!bg || bg === 'none') continue;
      const m = bg.match(BG_URL);
      if (!m) continue;
      const hint = m[2] + ' ' + (el.id || '') + ' ' + (el.className || '') +
                   ' ' + (el.getAttribute('aria-label') || '');
      if (looksLikeCaptcha(el, hint)) out.push({ kind: 'bg', el, url: m[2] });
    }
    return out;
  }

  // 依 DOM 順序回傳所有候選來源
  function captchaSources() {
    const all = [
      ...Array.from(document.querySelectorAll('img')).filter(isCaptchaImage)
        .map(el => ({ kind: 'img', el })),
      ...Array.from(document.querySelectorAll('canvas')).filter(isCaptchaCanvas)
        .map(el => ({ kind: 'canvas', el }))
    ];
    // 背景圖要掃全頁的 div/span/…，成本高。只有前兩者都沒找到才付這個代價。
    if (all.length === 0) all.push(...captchaBackgrounds());
    return all.sort((a, b) =>
      (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
  }

  function isVisible(el) {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    return el.offsetParent !== null || st.position === 'fixed' || st.position === 'absolute';
  }

  function isCaptchaInput(el) {
    const hay = [el.name, el.id, el.placeholder, el.getAttribute('aria-label')]
      .filter(Boolean).join(' ').toLowerCase();
    return INPUT_KEYWORDS.test(hay);
  }

  // 驗證碼輸入框幾乎都會限制長度。實測（n=300）：11 個錯誤中有 8 個是「少一個字」，
  // 用長度過濾可擋掉 8/11 且完全不會誤擋正確答案（答對的長度必然正確）。
  function expectedLength(input) {
    const ml = input.maxLength;
    if (ml > 0 && ml <= 8) return ml;
    const pat = input.getAttribute('pattern');
    if (pat) {
      const m = pat.match(/\{\s*(\d+)\s*\}\s*\$?$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > 0 && n <= 8) return n;
      }
    }
    return 0;   // 不知道，就不做檢查
  }

  // React / Vue 會攔截 value setter，要用原生 setter 才觸發得到 onChange
  function setValue(input, value) {
    const proto = Object.getPrototypeOf(input);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /* ---------------------------------------------------------------- 主流程 */

  async function fill(src, input) {
    if (input.dataset.avBusy === '1') return;
    input.dataset.avBusy = '1';
    try {
      badge('辨識中…');
      const text = await recognise(src);
      if (!text) {
        badge('辨識不出結果', 'err');
        return;
      }
      const want = settings.lengthCheck ? expectedLength(input) : 0;
      if (want && text.length !== want) {
        // 長度對不上幾乎必錯。與其填錯浪費一次嘗試（有些站錯三次就鎖），不如交還給使用者。
        badge(`辨識為「${text}」但應為 ${want} 碼，未填入`, 'err');
        console.warn(`[AutoVerify] 長度不符：得到 ${text.length} 碼「${text}」，期望 ${want} 碼`);
        return;
      }
      setValue(input, text);
      badge(`已填入 ${text}`, 'ok');
      console.log('[AutoVerify] →', text);
    } catch (e) {
      // 跨來源圖片會污染 canvas，getImageData 丟 SecurityError——
      // 這種情況要看得出來，否則只會像「靜靜地不動」。
      if (e && (e.name === 'SecurityError' || /tainted|cross-origin/i.test(String(e)))) {
        badge('圖片跨網域，無法讀取', 'err');
        console.error('[AutoVerify] canvas 被跨來源圖片污染:', e);
      } else {
        console.error('[AutoVerify] 辨識失敗:', e);
      }
    } finally {
      input.dataset.avBusy = '0';
    }
  }

  /* --------------------------------------------------- 手動指定（選取模式） */

  // 產生夠穩定的 CSS 選擇器：優先用 id，其次 tag+class，最後才退到 nth-of-type
  function cssPath(el) {
    // id 唯一就直接用它——最短也最耐得住版面調整
    if (el.id) {
      const byId = '#' + CSS.escape(el.id);
      try {
        if (document.querySelectorAll(byId).length === 1) return byId;
      } catch (e) { /* id 不合法，往下走一般路徑 */ }
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      let sel = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      const cls = Array.from(node.classList)
        .filter(c => !/^(ng-|is-|has-|active|focus|hover)/.test(c) && c.length < 30)
        .slice(0, 2);
      if (cls.length) sel += '.' + cls.map(c => CSS.escape(c)).join('.');
      const sibs = node.parentNode
        ? Array.from(node.parentNode.children).filter(s => s.tagName === node.tagName)
        : [];
      if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(node) + 1})`;
      parts.unshift(sel);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  let pick = null;   // { stage: 'img' | 'input', img: Element, box: Element }

  function pickOverlay(msg) {
    if (!pick.box) {
      const host = document.createElement('div');
      host.style.cssText =
        'position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
      const shadow = host.attachShadow({ mode: 'closed' });
      const tip = document.createElement('div');
      tip.style.cssText =
        'position:fixed;left:50%;top:calc(14px + env(safe-area-inset-top));transform:translateX(-50%);' +
        'font:600 14px/1.4 -apple-system,sans-serif;color:#fff;background:rgba(10,132,255,.96);' +
        'padding:10px 16px;border-radius:11px;box-shadow:0 6px 20px rgba(0,0,0,.3);' +
        'white-space:nowrap;max-width:92vw;overflow:hidden;text-overflow:ellipsis;';
      const ring = document.createElement('div');
      ring.style.cssText =
        'position:fixed;border:2.5px solid #0a84ff;border-radius:6px;' +
        'background:rgba(10,132,255,.14);transition:all .06s;display:none;';
      shadow.append(tip, ring);
      document.documentElement.appendChild(host);
      pick.box = host; pick.tip = tip; pick.ring = ring;
    }
    pick.tip.textContent = msg;
  }

  function onPickMove(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === pick.box) return;
    const r = el.getBoundingClientRect();
    Object.assign(pick.ring.style, {
      display: 'block', left: r.left + 'px', top: r.top + 'px',
      width: r.width + 'px', height: r.height + 'px'
    });
    pick.hover = el;
  }

  async function onPickClick(e) {
    e.preventDefault(); e.stopPropagation();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return;

    if (pick.stage === 'img') {
      pick.img = el;
      pick.stage = 'input';
      pickOverlay('② 現在點驗證碼的「輸入框」');
      return;
    }

    const rules = { ...settings.siteRules };
    rules[location.hostname] = { img: cssPath(pick.img), input: cssPath(el) };
    await api.storage.local.set({ siteRules: rules });
    settings.siteRules = rules;
    const saved = rules[location.hostname];
    console.log('[AutoVerify] 已存規則', saved);
    exitPick();
    badge('已記住這個網站的位置', 'ok');
    scans = 0;
    scan();
  }

  function enterPick() {
    if (pick) return;
    pick = { stage: 'img', img: null, box: null };
    pickOverlay('① 點一下驗證碼「圖片」');
    addEventListener('mousemove', onPickMove, true);
    addEventListener('touchmove', ev => onPickMove(ev.touches[0]), true);
    addEventListener('click', onPickClick, true);
    addEventListener('keydown', onPickKey, true);
  }

  function onPickKey(e) { if (e.key === 'Escape') { exitPick(); badge('已取消'); } }

  function exitPick() {
    if (!pick) return;
    removeEventListener('mousemove', onPickMove, true);
    removeEventListener('click', onPickClick, true);
    removeEventListener('keydown', onPickKey, true);
    if (pick.box) pick.box.remove();
    pick = null;
  }

  /* ------------------------------------------------------------- 掃描主流程 */

  // 有手動規則就照規則走，回傳 [img, input] 或 null
  function resolveRule() {
    const r = settings.siteRules[location.hostname];
    if (!r) return null;
    try {
      const el = document.querySelector(r.img);
      const input = document.querySelector(r.input);
      if (!el || !input || !isVisible(input)) return null;
      if (el.tagName === 'IMG')    return [{ kind: 'img', el }, input];
      if (el.tagName === 'CANVAS') return [{ kind: 'canvas', el }, input];
      const m = getComputedStyle(el).backgroundImage.match(BG_URL);
      if (m) return [{ kind: 'bg', el, url: m[2] }, input];
      return null;
    } catch (e) {
      console.warn('[AutoVerify] 規則選擇器無效:', e);
    }
    return null;
  }

  // 按「換一張」時要重新辨識。<img> 有 load 事件；<canvas>／背景圖沒有，
  // 只能觀察屬性變動後延遲重跑。
  function bindReload(src, input) {
    const el = src.el;
    if (el.dataset.avBound) return;
    el.dataset.avBound = '1';
    if (src.kind === 'img') {
      el.addEventListener('load', () => setTimeout(() => fill(src, input), 60));
    } else {
      new MutationObserver(() => setTimeout(() => fill(src, input), 120))
        .observe(el, { attributes: true, attributeFilter: ['style', 'class', 'width', 'height'] });
    }
  }

  function scan(attempt = 0) {
    if (!settings.enabled) return;
    if (settings.disabledHosts.includes(location.hostname)) return;
    if (pick) return;   // 選取模式中不要自動填

    const ruled = resolveRule();
    if (ruled) {
      const [src, input] = ruled;
      if (input.value.trim() === '') fill(src, input);
      bindReload(src, input);
      return;
    }
    if (scans >= CFG.maxScans) {
      if (observer) observer.disconnect();
      return;
    }
    scans++;

    const candidates = Array.from(
      document.querySelectorAll("input[type='text'], input[type='tel'], input[type='number'], input:not([type])")
    ).filter(isCaptchaInput);

    const inputs = candidates.filter(el => isVisible(el) && !el.disabled && !el.readOnly);
    // 欄位可能還在動畫或延遲渲染，給一次重試機會
    if (inputs.length === 0) {
      if (candidates.length > 0 && attempt === 0) setTimeout(() => scan(1), CFG.retryDelay);
      return;
    }

    const sources = captchaSources();
    if (sources.length === 0) return;

    const used = new Set();
    for (let i = 0; i < Math.min(inputs.length, sources.length); i++) {
      const src = sources[i];
      const input = inputs.find(el => !used.has(el));
      if (!input) break;
      used.add(input);

      if (input.value.trim() === '') fill(src, input);
      bindReload(src, input);
    }
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  function start() {
    scan();
    observer = new MutationObserver(debounce(() => scan(), CFG.debounce));
    observer.observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['src']
    });
  }

  api.storage.local.get(['enabled', 'asciiOnly', 'disabledHosts', 'siteRules', 'lengthCheck']).then(st => {
    settings = {
      enabled: st.enabled !== false,
      asciiOnly: st.asciiOnly !== false,
      lengthCheck: st.lengthCheck !== false,
      disabledHosts: Array.isArray(st.disabledHosts) ? st.disabledHosts : [],
      siteRules: (st.siteRules && typeof st.siteRules === 'object') ? st.siteRules : {}
    };
    if (!settings.enabled) return;
    if (settings.disabledHosts.includes(location.hostname)) return;
    setTimeout(start, CFG.initialDelay);
  }).catch(() => setTimeout(start, CFG.initialDelay));

  // 讓 popup 能問狀態、也能手動觸發一次
  api.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg && msg.action === 'status') {
      respond({
        host: location.hostname,
        modelLoaded: !!session,
        scans,
        hasRule: !!settings.siteRules[location.hostname],
        picking: !!pick
      });
    } else if (msg && msg.action === 'rescan') {
      scans = 0;
      scan();
      respond({ ok: true });
    } else if (msg && msg.action === 'pick') {
      enterPick();
      respond({ ok: true });
    } else if (msg && msg.action === 'clearRule') {
      const rules = { ...settings.siteRules };
      delete rules[location.hostname];
      api.storage.local.set({ siteRules: rules });
      settings.siteRules = rules;
      respond({ ok: true });
    }
    return true;
  });
})();
