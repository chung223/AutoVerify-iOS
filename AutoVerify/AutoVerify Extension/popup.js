const api = typeof browser !== 'undefined' ? browser : chrome;

const $ = id => document.getElementById(id);
let host = '';

async function currentTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function load() {
  const st = await api.storage.local.get(['enabled', 'asciiOnly', 'disabledHosts', 'lengthCheck']);
  const enabled = st.enabled !== false;
  const ascii = st.asciiOnly !== false;
  const disabled = Array.isArray(st.disabledHosts) ? st.disabledHosts : [];

  $('enabled').checked = enabled;
  $('ascii').checked = ascii;
  $('lenchk').checked = st.lengthCheck !== false;

  try {
    const tab = await currentTab();
    host = tab && tab.url ? new URL(tab.url).hostname : '';
  } catch (e) { host = ''; }

  $('host').textContent = host || '（無法取得網址）';
  $('site').checked = host ? !disabled.includes(host) : false;
  $('site').disabled = !host;

  // 問 content script 現在的狀態
  try {
    const tab = await currentTab();
    const res = await api.tabs.sendMessage(tab.id, { action: 'status' });
    if (res) {
      $('dot').classList.toggle('on', res.modelLoaded);
      $('stat').textContent = res.modelLoaded
        ? `模型已載入 · 已掃描 ${res.scans} 次`
        : `待命中 · 已掃描 ${res.scans} 次`;
      $('rulerow').hidden = !res.hasRule;
    }
  } catch (e) {
    $('stat').textContent = '這個分頁沒有執行（可能尚未授權或不是網頁）';
  }
}

// 進入選取模式後要關掉 popup，使用者才點得到頁面上的元素
$('pick').onclick = async () => {
  try {
    const tab = await currentTab();
    await api.tabs.sendMessage(tab.id, { action: 'pick' });
    window.close();
  } catch (e) {
    $('stat').textContent = '無法在這個分頁啟動選取';
  }
};

$('clearrule').onclick = async () => {
  try {
    const tab = await currentTab();
    await api.tabs.sendMessage(tab.id, { action: 'clearRule' });
    $('rulerow').hidden = true;
    $('stat').textContent = '已清除這個網站的規則';
  } catch (e) {
    $('stat').textContent = '清除失敗';
  }
};

$('enabled').onchange = e => api.storage.local.set({ enabled: e.target.checked });
$('ascii').onchange   = e => api.storage.local.set({ asciiOnly: e.target.checked });
$('lenchk').onchange  = e => api.storage.local.set({ lengthCheck: e.target.checked });

$('site').onchange = async e => {
  if (!host) return;
  const st = await api.storage.local.get('disabledHosts');
  const list = new Set(Array.isArray(st.disabledHosts) ? st.disabledHosts : []);
  if (e.target.checked) list.delete(host); else list.add(host);
  await api.storage.local.set({ disabledHosts: [...list] });
};

$('rescan').onclick = async () => {
  try {
    const tab = await currentTab();
    await api.tabs.sendMessage(tab.id, { action: 'rescan' });
    $('stat').textContent = '已要求重新掃描';
  } catch (e) {
    $('stat').textContent = '無法通知這個分頁';
  }
};

load();
