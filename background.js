chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'openOptions') chrome.runtime.openOptionsPage();
  if (msg && msg.type === 'devCheck') devCheck();
  if (msg && msg.type === 'ai' && msg.payload) {
    callHost(msg.payload, msg.timeout || 300000).then(sendResponse);
    return true; // 异步回复
  }
  if (msg && msg.type === 'trusted' && sender && sender.tab) {
    trustedInput(sender.tab.id, msg.steps).then(sendResponse);
    return true;
  }
  if (msg && msg.type === 'capture' && sender && sender.tab) {
    captureFor(sender.tab).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg && msg.type === 'viewResume' && msg.id) {
    const t = sender && sender.tab;
    chrome.tabs.create({
      url: chrome.runtime.getURL('view.html?id=' + encodeURIComponent(msg.id)),
      ...(t ? { windowId: t.windowId, index: t.index + 1, openerTabId: t.id } : {}),
    }).then((tab) => sendResponse({ ok: true, tabId: tab.id }), (e) => sendResponse({ ok: false, error: String(e) }));
    return true; // 异步回复
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  await chrome.storage.local.set({ devBuildHash: await buildHash() }); // 记下这次加载的代码版本
  const imported = await importBundledConfig();
  await injectIntoOpenTabs();
  if (details.reason === 'install' || (imported && details.reason !== 'update')) chrome.runtime.openOptionsPage();
});

async function injectIntoOpenTabs() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }); } catch (_) { return; }
  for (const t of tabs) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ['defaults.js', 'content.js'] });
    } catch (_) { /* 打不开的页面（商店、浏览器自带页面等）跳过 */ }
  }
}
chrome.runtime.onStartup.addListener(importBundledConfig);

const IS_DEV = !chrome.runtime.getManifest().update_url;
const DEV_FILES = ['manifest.json', 'content.js', 'defaults.js', 'background.js', 'options.js', 'options.html', 'config.json', 'view.html', 'view.js'];
let lastDevCheck = 0;

async function buildHash() {
  let h = 0;
  for (const f of DEV_FILES) {
    try {
      const t = await (await fetch(chrome.runtime.getURL(f), { cache: 'no-store' })).text();
      for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
    } catch (_) { /* 文件读不到就跳过 */ }
  }
  return String(h);
}

async function devCheck() {
  if (!IS_DEV || Date.now() - lastDevCheck < 2000) return false;
  lastDevCheck = Date.now();
  const [{ devBuildHash }, now] = await Promise.all([chrome.storage.local.get('devBuildHash'), buildHash()]);
  if (!devBuildHash) { await chrome.storage.local.set({ devBuildHash: now }); return false; }
  if (now === devBuildHash) return false;
  chrome.runtime.reload(); // 重新加载后 onInstalled 会记下新版本、导入新的 config.json
  return true;
}

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function nonEmpty(obj) {
  return Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => v !== '' && v != null));
}

async function importBundledConfig() {
  let cfg;
  try {
    const r = await fetch(chrome.runtime.getURL('config.json'));
    if (!r.ok) return false;
    cfg = await r.json();
  } catch (_) {
    return false;
  }
  const cur = await chrome.storage.local.get(['configVersion', 'profile', 'settings']);
  if (!cfg.version || cur.configVersion === cfg.version) return false;

  const resumes = [];
  for (const r of cfg.resumes || []) {
    try {
      const res = await fetch(chrome.runtime.getURL(r.file));
      if (!res.ok) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      resumes.push({
        id: r.id,
        label: r.label,
        keywords: r.keywords || '',
        name: r.uploadName || r.file.split('/').pop(),
        type: 'application/pdf',
        size: bytes.length,
        data: toBase64(bytes),
      });
    } catch (e) {
      console.warn('导入简历失败', r.file, e);
    }
  }

  const set = {
    configVersion: cfg.version,
    profile: { ...(cur.profile || {}), ...nonEmpty(cfg.profile) },
  };
  if (cfg.settings) set.settings = { ...(cur.settings || {}), ...cfg.settings };
  if (resumes.length) {
    set.resumes = resumes;
    set.defaultResumeId = cfg.defaultResume || resumes[0].id;
  }
  if (Array.isArray(cfg.coverLetters) && cfg.coverLetters.length) {
    const cur2 = (await chrome.storage.local.get('coverLetters')).coverLetters || {};
    for (const c of cfg.coverLetters) {
      try {
        const old = cur2[c.key] || {};
        let data = old.data;
        if (!data) {
          const res = await fetch(chrome.runtime.getURL(c.file));
          if (!res.ok) continue;
          data = toBase64(new Uint8Array(await res.arrayBuffer()));
        }
        cur2[c.key] = { ...old, name: c.name || c.file.split('/').pop(), company: c.company, title: c.title, url: c.url, time: old.time || Date.parse(c.time) || Date.now(), path: c.path || old.path, data };
      } catch (e) {
        console.warn('导入 cover letter 失败', c.file, e);
      }
    }
    set.coverLetters = cur2;
  }
  if (cfg.transcript && cfg.transcript.file) {
    try {
      const res = await fetch(chrome.runtime.getURL(cfg.transcript.file));
      if (res.ok) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        set.transcript = { name: cfg.transcript.uploadName || cfg.transcript.file.split('/').pop(), type: 'application/pdf', size: bytes.length, data: toBase64(bytes) };
      }
    } catch (e) {
      console.warn('导入成绩单失败', cfg.transcript.file, e);
    }
  }
  await chrome.storage.local.set(set);
  await chrome.storage.local.remove('resume'); // 旧版单份简历
  return true;
}


const CDP_KEYS = { Enter: [13, 'Enter', '\r'], Tab: [9, 'Tab'], ArrowDown: [40, 'ArrowDown'], ArrowUp: [38, 'ArrowUp'], Escape: [27, 'Escape'], Backspace: [8, 'Backspace'] };
async function trustedInput(tabId, steps) {
  const target = { tabId };
  const send = (method, params) => chrome.debugger.sendCommand(target, method, params || {});
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  try {
    for (const s of steps || []) {
      if (s.type === 'click') {
        const at = { x: Number(s.x) || 0, y: Number(s.y) || 0 };
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at });
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'left', buttons: 1, clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', buttons: 0, clickCount: 1 });
      } else if (s.type === 'text') {
        await send('Input.insertText', { text: String(s.text || '').slice(0, 500) });
      } else if (s.type === 'keys') {
        for (const ch of String(s.text || '').slice(0, 60)) {
          const up = ch.toUpperCase();
          const code = /\d/.test(ch) ? 'Digit' + ch : /[a-z]/i.test(ch) ? 'Key' + up : '';
          const vk = /\d/.test(ch) ? 48 + Number(ch) : /[a-z]/i.test(ch) ? up.charCodeAt(0) : 0;
          await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text: ch, unmodifiedText: ch });
          await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
          await new Promise((r) => setTimeout(r, 40));
        }
      } else if (s.type === 'key') {
        const k = CDP_KEYS[s.key];
        if (!k) continue;
        const base = { key: k[1], code: k[1], windowsVirtualKeyCode: k[0], nativeVirtualKeyCode: k[0] };
        await send('Input.dispatchKeyEvent', k[2] ? { type: 'keyDown', ...base, text: k[2], unmodifiedText: k[2] } : { type: 'rawKeyDown', ...base });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      } else if (s.type === 'selectAll') {
        const mod = s.mac ? 4 : 2; // Meta / Ctrl
        await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: mod, commands: ['selectAll'] });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: mod });
      } else if (s.type === 'wait') {
        await new Promise((r) => setTimeout(r, Math.min(Number(s.ms) || 100, 3000)));
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    try { await chrome.debugger.detach(target); } catch (_) { /* 已经断开 */ }
  }
}

async function captureFor(tab) {
  const t = await chrome.tabs.get(tab.id);
  if (!t.active) return { ok: false, error: '标签页不在前台' };
  const url = await chrome.tabs.captureVisibleTab(t.windowId, { format: 'png' });
  return { ok: true, url };
}

const HOST = 'com.jobhelper.codex';
function callHost(payload, timeoutMs) {
  return new Promise((resolve) => {
    let port = null;
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      try { port && port.disconnect(); } catch (_) { /* ignore */ }
      resolve(r);
    };
    try {
      port = chrome.runtime.connectNative(HOST);
    } catch (e) {
      finish({ ok: false, error: '没装本地连接：' + e });
      return;
    }
    port.onMessage.addListener((m) => finish(m));
    port.onDisconnect.addListener(() => finish({ ok: false, error: chrome.runtime.lastError?.message || '本地连接断开了' }));
    port.postMessage(payload);
    setTimeout(() => finish({ ok: false, error: '等 Codex 超时' }), timeoutMs);
  });
}
