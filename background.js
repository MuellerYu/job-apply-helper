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
  const liveDoc = sender && sender.tab && (!sender.documentLifecycle || sender.documentLifecycle === 'active');
  if (msg && msg.type === 'queueHello' && sender && sender.tab) { if (!liveDoc) { sendResponse({ item: null }); return; } qHello(sender.tab.id).then(sendResponse); return true; }
  if (msg && msg.type === 'queueReport' && sender && sender.tab) { if (!liveDoc) { sendResponse({ ok: false }); return; } qReport(sender.tab.id, msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) })); return true; }
  if (msg && msg.type === 'queueCmd') { qCmd(msg, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) })); return true; }
  if (msg && msg.type === 'sleep') { setTimeout(() => sendResponse(true), Math.min(Math.max(Number(msg.ms) || 0, 0), 60000)); return true; }
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
  if (details.reason === 'update') {
    const { queuePageSeen: q } = await chrome.storage.local.get('queuePageSeen');
    if (q && Date.now() - q.t < 15000) {
      const url = chrome.runtime.getURL('queue.html');
      chrome.tabs.create({ url, active: !!q.active, ...(q.windowId ? { windowId: q.windowId, index: q.index } : {}) }).catch(() => chrome.tabs.create({ url }));
    }
  }
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
chrome.runtime.onStartup.addListener(() => qTx((Q) => {
  for (const it of Q.items) {
    if (it.status === 'running' || it.status === 'resumed') Object.assign(it, { status: 'pending', tabId: null, need: '' });
    else if (it.tabId) it.tabId = null;
  }
  Q.meta.windowId = null;
  Q.meta.groupId = null;
}).catch(() => {}));

const IS_DEV = !chrome.runtime.getManifest().update_url;
const DEV_FILES = ['manifest.json', 'content.js', 'defaults.js', 'background.js', 'options.js', 'options.html', 'config.json', 'view.html', 'view.js', 'queue.html', 'queue.js'];
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

const QI = (id) => 'qi:' + id;
const Q_DEFAULTS = { order: [], running: false, autoSubmit: true, maxParked: 12, timeoutMin: 30, concurrency: 5, note: '', preferHost: '', windowId: null, groupId: null };
const Q_LOGIN_ATS = new Set(['workday', 'oracle', 'icims', 'successfactors', 'taleo', 'ukg', 'dayforce', 'cornerstone', 'avature', 'eightfold', 'adp']);
const Q_PARK = new Set(['login', 'verify', 'captcha', 'ready']); // 要你在那个标签页里动手的：标签页留着
let QC = null;

async function qGet() {
  if (QC) return QC;
  const { qmeta } = await chrome.storage.local.get('qmeta');
  const meta = { ...Q_DEFAULTS, ...(qmeta || {}) };
  const got = meta.order.length ? await chrome.storage.local.get(meta.order.map(QI)) : {};
  QC = { meta, items: meta.order.map((id) => got[QI(id)]).filter(Boolean) };
  return QC;
}

let qChain = Promise.resolve();
function qTx(fn) {
  const run = qChain.then(async () => {
    const Q = await qGet();
    const before = new Map(Q.items.map((it) => [it.id, JSON.stringify(it)]));
    const metaBefore = JSON.stringify(Q.meta);
    const r = await fn(Q);
    Q.meta.order = Q.items.map((it) => it.id);
    const set = {};
    for (const it of Q.items) { const s = JSON.stringify(it); if (before.get(it.id) !== s) set[QI(it.id)] = it; }
    if (JSON.stringify(Q.meta) !== metaBefore) set.qmeta = Q.meta;
    if (Object.keys(set).length) await chrome.storage.local.set(set);
    return r;
  });
  qChain = run.catch((e) => console.warn('[投递队列]', e));
  return run;
}

function qUrlKey(u) {
  try {
    const x = new URL(u);
    return (x.hostname + x.pathname.replace(/^\/[a-z]{2}-[A-Z]{2}(?=\/)/, '').replace(/\/(apply|application)(\/.*)?$/, '').replace(/\/$/, '')).toLowerCase();
  } catch (_) { return String(u || '').toLowerCase(); }
}

const qFind = (Q, tabId) => Q.items.find((x) => x.tabId === tabId && ['running', 'resumed', 'needs'].includes(x.status));

async function qHello(tabId) {
  const Q = await qGet();
  const it = qFind(Q, tabId);
  if (!it) return { item: null };
  return { item: { id: it.id, url: it.url, company: it.company, title: it.title, resume: it.resume, hops: it.hops || 0, status: it.status, need: it.need || '', submitAt: it.submitAt || 0 }, autoSubmit: !!Q.meta.autoSubmit };
}

async function qReport(tabId, m) {
  const out = await qTx(async (Q) => {
    const it = qFind(Q, tabId);
    if (!it) return null;
    const now = Date.now();
    const st = m.state;
    it.progress = now;
    if (m.url) it.lastUrl = String(m.url).slice(0, 500);
    if (st === 'progress') {
      if (it.status === 'needs') {
        if (it.need === 'login') Q.meta.preferHost = it.host;
        it.status = 'resumed';
        it.need = '';
        return { next: true };
      }
      return null;
    }
    if (st === 'hop') { it.hops = (it.hops || 0) + 1; return null; }
    if (st === 'submitting') { it.submitAt = now; return null; } // 点了提交：跳到新页面后靠它认出「这是提交成功页」
    it.note = String(m.note || '').slice(0, 400);
    if (Array.isArray(m.missing)) it.missing = m.missing.slice(0, 8).map((s) => String(s).slice(0, 80));
    it.ended = now;
    if (st === 'submitted' || st === 'dup' || st === 'closed') {
      it.status = st;
      it.need = '';
      const close = it.tabId;
      it.tabId = null;
      return { close, next: true };
    }
    it.status = 'needs';
    it.need = st;
    if (Q_PARK.has(st)) return { next: true }; // 标签页留着等你
    const close = it.tabId;
    it.tabId = null;
    return { close, next: true };
  });
  if (out && out.close) setTimeout(() => chrome.tabs.remove(out.close).catch(() => {}), 2500);
  if (out && out.next) setTimeout(qNext, 3000);
  return { ok: true };
}

async function qNext() {
  const picks = await qTx(async (Q) => {
    const M = Q.meta;
    if (!M.running) return [];
    const running = Q.items.filter((x) => x.status === 'running');
    const slots = Math.max(1, Math.min(10, Number(M.concurrency) || 1)) - running.length;
    if (slots <= 0) return [];
    const parked = Q.items.filter((x) => x.tabId && (x.status === 'resumed' || (x.status === 'needs' && Q_PARK.has(x.need)))).length;
    if (parked >= M.maxParked) {
      M.running = false;
      M.note = `有 ${parked} 个标签页在等你（登录 / 验证码 / 人机验证 / 等你点提交），先暂停。处理掉几个再点「开始」。`;
      return [];
    }
    const blocked = new Set(Q.items.filter((x) => x.tabId && x.status === 'needs' && x.need === 'login').map((x) => x.host));
    const busy = new Set(running.filter((x) => Q_LOGIN_ATS.has(x.ats)).map((x) => x.host));
    const out = [];
    for (let n = 0; n < slots; n++) {
      const ok = (x) => x.status === 'pending' && !blocked.has(x.host) && !(Q_LOGIN_ATS.has(x.ats) && busy.has(x.host));
      const it = (M.preferHost && Q.items.find((x) => ok(x) && x.host === M.preferHost)) || Q.items.find(ok);
      if (!it) break;
      if (M.preferHost && it.host !== M.preferHost) M.preferHost = '';
      Object.assign(it, { status: 'running', started: Date.now(), progress: Date.now(), hops: 0, need: '', note: '', missing: [], tries: (it.tries || 0) + 1 });
      if (Q_LOGIN_ATS.has(it.ats)) busy.add(it.host);
      out.push({ id: it.id, url: it.url });
    }
    if (!out.length && !running.length) {
      const left = Q.items.some((x) => x.status === 'pending');
      M.note = left ? '剩下的职位都在等你登录对应的网站（见「等你处理」）' : '队列跑完了';
      if (!left) M.running = false;
    } else if (out.length) M.note = '';
    return out;
  });
  for (const pick of picks) await qOpen(pick);
}

async function qOpen(pick) {
  const setItem = (patch) => qTx((Q) => { const it = Q.items.find((x) => x.id === pick.id); if (it) Object.assign(it, patch); });
  const { log = [] } = await chrome.storage.local.get('log');
  const key = qUrlKey(pick.url);
  if (log.some((r) => r.status === '已提交' && qUrlKey(r.url) === key)) {
    await setItem({ status: 'dup', note: '投递记录里已提交过', ended: Date.now() });
    setTimeout(qNext, 500);
    return;
  }
  try {
    const M = (await qGet()).meta;
    let win = M.windowId ? await chrome.windows.get(M.windowId).catch(() => null) : null;
    let tabId;
    if (win) {
      tabId = (await chrome.tabs.create({ windowId: win.id, url: 'about:blank', active: true })).id;
      if (M.groupId != null) await chrome.tabs.group({ groupId: M.groupId, tabIds: tabId }).catch(() => qTx((Q2) => { Q2.meta.groupId = null; }));
    } else {
      win = await chrome.windows.create({ url: 'about:blank', focused: false, width: 1300, height: 950 });
      tabId = win.tabs[0].id;
      await qTx((Q2) => { Q2.meta.windowId = win.id; Q2.meta.groupId = null; });
    }
    await setItem({ tabId });
    await chrome.tabs.update(tabId, { url: pick.url });
  } catch (e) {
    await setItem({ status: 'needs', need: 'error', note: '打不开标签页：' + e, tabId: null });
    setTimeout(qNext, 3000);
  }
}

chrome.tabs.onCreated.addListener((tab) => {
  const u = tab.pendingUrl || tab.url || '';
  if (!tab.openerTabId || !u || u === 'about:blank' || /^chrome(-extension)?:/.test(u)) return;
  qTx((Q) => {
    const it = Q.items.find((x) => x.tabId === tab.openerTabId && x.status === 'running');
    if (!it || Q.items.some((x) => x.tabId === tab.id)) return null;
    it.tabId = tab.id;
    it.hops = (it.hops || 0) + 1;
    return tab.openerTabId;
  }).then((old) => { if (old) setTimeout(() => chrome.tabs.remove(old).catch(() => {}), 4000); }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId, info) => {
  qTx((Q) => {
    const it = Q.items.find((x) => x.tabId === tabId);
    if (!it) return false;
    it.tabId = null;
    if (info && info.isWindowClosing && info.windowId === Q.meta.windowId) {
      Q.meta.running = false;
      Q.meta.note = '「投递队列」窗口被关掉了，已暂停';
      if (it.status === 'running' || it.status === 'resumed') { it.status = 'pending'; it.tries = Math.max(0, (it.tries || 1) - 1); }
      return false;
    }
    if (it.status === 'running' || it.status === 'resumed') {
      it.status = 'needs';
      it.need = 'closed';
      it.note = '标签页被关掉了';
      return true;
    }
    return false;
  }).then((r) => { if (r) setTimeout(qNext, 1500); }).catch(() => {});
});

chrome.alarms.create('queueTick', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'queueTick') qTick(); });
async function qTick() {
  const Q = await qGet();
  for (const it of Q.items.filter((x) => x.tabId && ['running', 'resumed', 'needs'].includes(x.status))) {
    if (!(await chrome.tabs.get(it.tabId).catch(() => null))) {
      await qTx(() => { if (it.status === 'running' || it.status === 'resumed') Object.assign(it, { status: 'needs', need: 'closed', note: '标签页没了' }); it.tabId = null; });
    }
  }
  const close = await qTx((Q2) => {
    const now = Date.now();
    const out = [];
    for (const it of Q2.items) {
      if ((it.status === 'running' || it.status === 'resumed') && now - (it.progress || it.started || now) > Q2.meta.timeoutMin * 60000) {
        Object.assign(it, { status: 'needs', need: 'timeout', note: `${Q2.meta.timeoutMin} 分钟没有进展`, ended: now });
        if (it.tabId) out.push(it.tabId);
        it.tabId = null;
      }
    }
    return out;
  });
  for (const t of close) chrome.tabs.remove(t).catch(() => {});
  try {
    const r = await fetch(chrome.runtime.getURL('queue-import.ver'), { cache: 'no-store' });
    const ver = r.ok ? (await r.text()).trim() : '';
    if (ver && Q.meta.importVersion && ver !== Q.meta.importVersion) {
      const res = await qImport();
      console.log('[投递队列] 自动导入新列表', ver, res.added, res.total);
    }
  } catch (_) { /* 没有这个文件就算了 */ }
  if (Q.meta.running) qNext();
}

async function qImport(data) {
  if (!data) {
    const r = await fetch(chrome.runtime.getURL('queue-import.json'), { cache: 'no-store' }).catch(() => null);
    if (!r || !r.ok) return { ok: false, error: '插件文件夹里没有 queue-import.json' };
    data = await r.json();
  }
  const rows = (data.items || []).filter((r) => r && r.id && r.url);
  const { log = [] } = await chrome.storage.local.get('log');
  const doneKeys = new Map(log.filter((r) => /已提交|已填到|已点提交/.test(r.status || '')).map((r) => [qUrlKey(r.url), r.status]));
  const res = await qTx((Q) => {
    const by = new Map(Q.items.map((x) => [x.id, x]));
    const out = [];
    const fresh = new Set();
    let added = 0;
    for (const r of rows) {
      const old = by.get(r.id);
      if (old) { Object.assign(old, { url: r.url, company: r.company, title: r.title, loc: r.loc, resume: r.resume, prio: r.prio, ats: r.ats, host: r.host }); out.push(old); by.delete(r.id); }
      else {
        const was = doneKeys.get(qUrlKey(r.url));
        out.push({ ...r, status: was ? 'dup' : 'pending', note: was ? '投递记录：' + was : '' });
        fresh.add(r.id);
        added++;
      }
    }
    const removed = [];
    for (const x of by.values()) (x.status === 'pending' ? removed : out).push(x);
    const cap = Number(data.perCompany) || 0;
    let list = out;
    if (cap) {
      const ck = (x) => String(x.company || '').toLowerCase().replace(/[^a-z0-9]/g, '') || x.host;
      const used = {};
      for (const x of out) if (x.status !== 'pending' && x.status !== 'skipped') used[ck(x)] = (used[ck(x)] || 0) + 1;
      const keep = new Set();
      for (const x of out.filter((y) => y.status === 'pending').sort((a, b) => (b.prio || 0) - (a.prio || 0))) {
        const k = ck(x);
        if ((used[k] || 0) < cap) { used[k] = (used[k] || 0) + 1; keep.add(x.id); }
      }
      list = out.filter((x) => x.status !== 'pending' || keep.has(x.id));
      for (const x of out) if (x.status === 'pending' && !keep.has(x.id)) { if (fresh.has(x.id)) added--; else removed.push(x); }
    }
    Q.items = list;
    Q.meta.importVersion = data.version || '';
    Q.meta.importSource = data.source || '';
    return { added, total: out.length, removed: removed.map((x) => QI(x.id)) };
  });
  if (res.removed.length) await chrome.storage.local.remove(res.removed);
  return { ok: true, added: res.added, total: res.total, removed: res.removed.length, ...(await qSummary()) };
}

const Q_NEED_TEXT = { login: '要登录 / 注册', verify: '要邮箱验证码', captcha: '要人机验证', ready: '等你点提交', stuck: '卡住了', timeout: '超时', error: '出错', closed: '标签页被关了', noform: '找不到申请表' };
async function qSummary(full) {
  const Q = await qGet();
  const count = {};
  for (const it of Q.items) {
    const k = it.status === 'needs' ? 'needs:' + it.need : it.status;
    count[k] = (count[k] || 0) + 1;
  }
  const slim = (it) => ({ id: it.id, company: it.company, title: it.title, url: it.url, lastUrl: it.lastUrl, host: it.host, ats: it.ats, prio: it.prio, resume: it.resume, status: it.status, need: it.need, needText: Q_NEED_TEXT[it.need] || '', note: it.note, missing: it.missing, tabId: it.tabId, tries: it.tries, ended: it.ended });
  const needs = Q.items.filter((x) => x.status === 'needs' || x.status === 'resumed').sort((a, b) => (b.ended || 0) - (a.ended || 0));
  const actives = Q.items.filter((x) => x.status === 'running');
  const active = actives[0];
  const { order, ...meta } = Q.meta;
  return {
    ok: true, meta, total: Q.items.length, count,
    active: active ? slim(active) : null,
    actives: actives.map(slim),
    needs: needs.slice(0, full ? 5000 : 300).map(slim),
    done: full ? Q.items.filter((x) => ['submitted', 'dup', 'closed', 'skipped'].includes(x.status)).map(slim) : undefined,
    pending: full ? Q.items.filter((x) => x.status === 'pending').map(slim) : undefined,
  };
}

async function qCmd(m, sender) {
  const c = m.cmd;
  if (c === 'here') {
    const t = sender && sender.tab;
    if (!t) return { ok: false, error: '要从网页里发这个命令' };
    await qTx((Q) => { Q.meta.windowId = t.windowId; Q.meta.groupId = t.groupId >= 0 ? t.groupId : null; });
    return qSummary();
  }
  if (c === 'status') return qSummary(m.full);
  if (c === 'import') return qImport(m.data);
  if (c === 'start') { await qTx((Q) => { Q.meta.running = true; Q.meta.note = ''; }); qNext(); return qSummary(); }
  if (c === 'pause') { await qTx((Q) => { Q.meta.running = false; Q.meta.note = '已暂停（正在跑的这一个会跑完）'; }); return qSummary(); }
  if (c === 'set') {
    await qTx((Q) => { for (const k of ['autoSubmit', 'maxParked', 'timeoutMin', 'concurrency']) if (k in m) Q.meta[k] = m[k]; });
    return qSummary();
  }
  if (c === 'retry') {
    const needs = new Set(m.needs || ['stuck', 'timeout', 'error', 'closed', 'noform']);
    const n = await qTx((Q) => {
      let k = 0;
      for (const it of Q.items) {
        if (it.status !== 'needs' || it.tabId || !needs.has(it.need) || (m.ids && !m.ids.includes(it.id)) || (m.host && it.host !== m.host)) continue;
        Object.assign(it, { status: 'pending', need: '' });
        k++;
      }
      return k;
    });
    return { ...(await qSummary()), retried: n };
  }
  if (c === 'log') {
    const { log = [] } = await chrome.storage.local.get('log');
    return { ok: true, log: log.slice(-(m.n || 30)).map((r) => ({ url: r.url, status: r.status, time: r.time, title: (r.title || '').slice(0, 80) })) };
  }
  if (c === 'stop') {
    await qTx((Q) => { Q.meta.running = false; Q.meta.note = '已停止：正在投的放回待投了，点「开始」接着投'; });
    return qCmd({ cmd: 'reset' });
  }
  if (c === 'reset') {
    const tabs = await qTx((Q) => {
      const t = [];
      for (const it of Q.items) if (it.status === 'running' || it.status === 'resumed') { if (it.tabId) t.push(it.tabId); Object.assign(it, { status: 'pending', tabId: null, need: '' }); }
      return t;
    });
    for (const t of [...new Set(tabs)]) await chrome.tabs.remove(t).catch(() => {});
    return qSummary();
  }
  if (c === 'skip' || c === 'unskip') {
    await qTx((Q) => { for (const it of Q.items) if ((m.ids || []).includes(it.id) && it.status !== 'running') it.status = c === 'skip' ? 'skipped' : 'pending'; });
    return qSummary();
  }
  if (c === 'focus' && m.id) {
    const Q = await qGet();
    const it = Q.items.find((x) => x.id === m.id);
    if (!it) return { ok: false };
    const t = it.tabId && await chrome.tabs.get(it.tabId).catch(() => null);
    if (t) { await chrome.windows.update(t.windowId, { focused: true }); await chrome.tabs.update(t.id, { active: true }); }
    else await chrome.tabs.create({ url: it.lastUrl || it.url });
    return { ok: true };
  }
  if (c === 'clear') {
    const Q = await qGet();
    await chrome.storage.local.remove([...Q.items.map((x) => QI(x.id)), 'qmeta']);
    QC = null;
    return qSummary();
  }
  return { ok: false, error: '不认识的命令 ' + c };
}
