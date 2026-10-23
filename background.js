chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'openOptions') chrome.runtime.openOptionsPage();
  if (msg && msg.type === 'mailbox') {
    const ownOptions = sender.url === chrome.runtime.getURL('options.html');
    const action = msg.action;
    if (ownOptions && action === 'mailWatchNow') { mailWatchTick().then(sendResponse, () => sendResponse({ ok: false, error: '邮箱检查失败，请稍后再试。' })); return true; }
    if (action === 'mailCode' && sender.tab) {
      (async () => {
        const { mailbox = {} } = await chrome.storage.local.get('mailbox');
        if (!mailbox.enabled || !mailbox.email) return sendResponse({ ok: false, error: '请先在设置中连接并开启 Outlook 自动取码。' });
        sendResponse(await callHost({ action, email: mailbox.email, url: sender.url, since: msg.since, length: msg.length }, 30000));
      })().catch(() => sendResponse({ ok: false, error: '邮箱连接失败，请重新连接。' }));
      return true;
    }
    if (ownOptions && ['mailStart', 'mailPoll', 'mailStatus', 'mailDisconnect'].includes(action)) {
      callHost({ action, clientId: msg.clientId, email: msg.email, archive: !!(msg.watchEnabled && msg.autoArchive) }, 30000).then(sendResponse);
      return true;
    }
    sendResponse({ ok: false, error: '请从插件设置页连接邮箱。' });
    return;
  }
  if (msg && msg.type === 'ui5Text' && sender.tab) {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, frameIds: [sender.frameId || 0] }, world: 'MAIN', args: [String(msg.mark), String(msg.value)],
      func: async (mark, value) => {
        const h = document.querySelector('[data-wdaf-ui5="' + mark + '"]');
        const inner = h && h.shadowRoot && h.shadowRoot.querySelector('input, textarea');
        if (!inner) return 'noinput';
        const sl = (ms) => new Promise((r) => setTimeout(r, ms));
        inner.focus();
        Object.getOwnPropertyDescriptor(inner.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(inner, value);
        inner.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
        inner.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, composed: true, key: 'End' }));
        await sl(100);
        inner.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        await sl(150);
        inner.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
        inner.blur();
        await sl(100);
        if (String(h.value) !== value) h.value = value; // 组件显示和网站数据对齐（改过的栏有时还显示旧字）
        return 'ok';
      },
    }).then((r) => sendResponse({ ok: !!(r && r[0] && r[0].result === 'ok'), r: r && r[0] && r[0].result })).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg && msg.type === 'ui5SelSet' && sender.tab) {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, frameIds: [sender.frameId || 0] }, world: 'MAIN', args: [String(msg.mark), String(msg.text)],
      func: (mark, text) => {
        const h = document.querySelector('[data-wdaf-ui5="' + mark + '"]');
        if (!h) return 'nohost';
        const clean = (s) => String(s || '').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim();
        const o = [...h.children].find((x) => /^UI5-OPTION/.test(x.tagName) && clean(x.textContent) === text);
        if (!o) return 'noopt';
        h.value = o.value;
        const d = { detail: { selectedOption: o }, bubbles: true, composed: true };
        h.dispatchEvent(new CustomEvent('ui5-change', d));
        h.dispatchEvent(new CustomEvent('change', d));
        return 'ok';
      },
    }).then((r) => sendResponse({ ok: !!(r && r[0] && r[0].result === 'ok'), r: r && r[0] && r[0].result })).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg && msg.type === 'devCheck') devCheck();
  if (msg && msg.type === 'ai' && msg.payload) {
    const tid = sender && sender.tab ? sender.tab.id : 0;
    const act = String(msg.payload.action || '');
    if (/^(answer|review|operate|advance)$/.test(act)) {
      const now = Date.now();
      const arr = (aiCalls.get(tid) || []).filter((t) => now - t < 10 * 60000);
      arr.push(now);
      aiCalls.set(tid, arr);
      if (arr.length > 25) { sendResponse({ ok: false, error: '这页 10 分钟内调了 25 次 AI，疑似在循环，已停下这页' }); return; }
      const total = [...aiCalls.values()].reduce((s, a) => s + a.filter((t) => now - t < 10 * 60000).length, 0);
      if (total > 120) { sendResponse({ ok: false, error: '所有页 10 分钟内合计调了 120 次 AI，疑似在循环，已停下这页' }); return; }
    }
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
  if (msg && msg.type === 'queueHello' && sender && sender.tab) { if (!liveDoc) { sendResponse({ item: null }); return; } qHello(sender.tab.id, [sender.tab.url, sender.url]).then(sendResponse); return true; }
  if (msg && msg.type === 'queueReport' && sender && sender.tab) { if (!liveDoc) { sendResponse({ ok: false }); return; } qReport(sender.tab.id, msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) })); return true; }
  if (msg && msg.type === 'panelMark' && msg.kind === 'skip') {
    const keys = new Set((msg.urls || []).filter((u) => /^https?:/.test(u || '')).map(qUrlKey));
    qTx((Q) => { let n = 0; for (const it of Q.items) if (['pending', 'needs'].includes(it.status) && !it.tabId && (keys.has(qUrlKey(it.url)) || (it.lastUrl && keys.has(qUrlKey(it.lastUrl))))) { Object.assign(it, { status: 'skipped', need: '', note: '你在面板上点了「跳过这个」' }); n++; } return n; })
      .then((n) => sendResponse({ ok: true, n }), () => sendResponse({ ok: false }));
    return true;
  }
  if (msg && msg.type === 'submitSlot') {
    const now = Date.now();
    const slot = Math.max(now, (submitSlots.get(msg.host || '') || 0) + 25000);
    submitSlots.set(msg.host || '', slot);
    sendResponse({ wait: slot - now });
    return;
  }
  if (msg && msg.type === 'jobDone') {
    (async () => {
      const keys = new Set((msg.urls || []).filter((u) => /^https?:/.test(u || '')).map(qUrlKey));
      const { log = [] } = await chrome.storage.local.get('log');
      const r = log.find((x) => Q_DONE_LOG.test(x.status || '') && x.url && keys.has(qUrlKey(x.url)));
      sendResponse(r ? { done: true, status: r.status, when: new Date(r.time || 0).toLocaleString('zh-CN', { hour12: false }) } : { done: false });
    })();
    return true;
  }
  if (msg && msg.type === 'startAllTabs') {
    (async () => {
      const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }).catch(() => []);
      let sent = 0;
      for (const t of tabs) {
        const r = await new Promise((res) => chrome.tabs.sendMessage(t.id, { type: 'wdafStartAll' }, { frameId: 0 }, (x) => { void chrome.runtime.lastError; res(x); }));
        if (r && r.started) sent++;
      }
      sendResponse({ sent });
    })();
    return true;
  }
  if (msg && msg.type === 'queueDoneByUrl' && sender && sender.tab) {
    (async () => {
      const key = qUrlKey(String(msg.url || ''));
      let hit = null;
      await qTx((Q) => {
        hit = Q.items.find((x) => x.status !== 'submitted' && (qUrlKey(x.url) === key || (x.lastUrl && qUrlKey(x.lastUrl) === key)));
        if (hit) Object.assign(hit, { status: 'submitted', need: '', tabId: null, ended: Date.now(), note: '提交成功页（标签页之前跟队列断了，按职位网址找回）' });
      });
      if (hit) setTimeout(() => qCloseQuiet(sender.tab.id), 2500);
      sendResponse({ ok: !!hit });
    })();
    return true;
  }
  if (msg && msg.type === 'queueCmd') { qCmd(msg, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) })); return true; }
  if (msg && msg.type === 'armChooser' && sender && sender.tab && msg.path) { armChooser(sender.tab.id, msg.path).then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) })); return true; }
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

const submitSlots = new Map(); // 网站 → 最近一次（或排好的）提交时间

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
  const cur = await chrome.storage.local.get(['configVersion', 'profile', 'settings', 'mailbox']);
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
  if (cfg.registration) set.registration = { email: String(cfg.registration.email || ''), password: String(cfg.registration.password || '') };
  if (cfg.mailbox) set.mailbox = { ...(cur.mailbox || {}), ...cfg.mailbox };
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


const MAIL_NOTICE_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAYElEQVR4nO3SSQoAIAhA0fYdtaN2qNqHkUMDwRfchOkTTLnU9jITAAAAAEiPp8IFiG7oBowNvIOlniaAFTKrCwM0A1b/tgBmh6qp3wrw3AQAAAD+ApwINeBmAgAA4DmgA825nKDH0YMmAAAAAElFTkSuQmCC';
let mailWatchBusy = false;
async function syncMailWatch() {
  const { mailbox = {} } = await chrome.storage.local.get('mailbox');
  if (mailbox.watchEnabled && mailbox.clientId && mailbox.email) {
    if (!mailbox.watchStartedAt) { await chrome.storage.local.set({ mailbox: { ...mailbox, watchStartedAt: Date.now() } }); return; }
    if (!(await chrome.alarms.get('mailWatch'))) await chrome.alarms.create('mailWatch', { delayInMinutes: 1, periodInMinutes: 5 });
  } else { await chrome.alarms.clear('mailWatch'); await chrome.alarms.clear('mailWatchSoon'); }
}
async function mailWatchTick() {
  if (mailWatchBusy) return { ok: false, error: '邮箱检查进行中，请稍后。' };
  mailWatchBusy = true;
  try {
    const { mailbox = {}, mailWatch = {}, mailNoticeUrls = {} } = await chrome.storage.local.get(['mailbox', 'mailWatch', 'mailNoticeUrls']);
    if (!mailbox.watchEnabled || !mailbox.email || !mailbox.clientId) return { ok: false, error: '请先连接 Outlook 并开启求职邮件跟踪。' };
    if (!mailbox.watchStartedAt) { await chrome.storage.local.set({ mailbox: { ...mailbox, watchStartedAt: Date.now() } }); return { ok: false, error: '已开启跟踪，请稍后再检查。' }; }
    const r = await callHost({ action: 'mailWatch', email: mailbox.email, archive: !!mailbox.autoArchive, startedAt: mailbox.watchStartedAt / 1000 }, 180000);
    if (!r.ok) {
      await chrome.storage.local.set({ mailWatch: { ...mailWatch, error: r.error || '邮箱检查失败', attemptedAt: Date.now() } });
      if (mailWatch.error !== r.error) await chrome.notifications.create('mail:connection', { type: 'basic', iconUrl: MAIL_NOTICE_ICON, title: '求职邮箱跟踪需要处理', message: r.error || '请在插件设置中检查邮箱连接。' }).catch(() => {});
      return r;
    }
    const delivered = mailWatch.email === mailbox.email ? (mailWatch.delivered || []) : [];
    const alerts = (r.alerts || []).filter((x) => !delivered.includes(x.id));
    const next = { email: mailbox.email, checkedAt: r.checkedAt * 1000, archived: r.archived || 0, history: r.history || [], delivered: [...delivered, ...alerts.map((x) => x.id)].slice(-5000), error: '' };
    for (const item of alerts) mailNoticeUrls['mail:' + item.id] = item.url;
    const urls = Object.fromEntries(Object.entries(mailNoticeUrls).slice(-150));
    await chrome.storage.local.set({ mailWatch: next, mailNoticeUrls: urls });
    if (alerts.length) {
      await chrome.action.setBadgeBackgroundColor({ color: '#0b6bcb' });
      await chrome.action.setBadgeText({ text: String(alerts.length) });
      for (const item of alerts.slice(0, 3)) {
        await chrome.notifications.create('mail:' + item.id, { type: 'basic', iconUrl: MAIL_NOTICE_ICON, title: item.kind === 'important' ? '求职邮件：需要行动' : '求职邮件：待你查看', message: item.subject || item.from || '收到新的招聘邮件，请打开 Outlook 查看。' }).catch(async () => { await chrome.storage.local.set({ mailWatch: { ...next, error: '系统未显示桌面通知；新邮件已保存在下方跟踪记录，工具栏也有提醒。' } }); });
      }
      if (alerts.length > 3) await chrome.notifications.create('mail:more', { type: 'basic', iconUrl: MAIL_NOTICE_ICON, title: '还有新的求职邮件', message: `另有 ${alerts.length - 3} 封邮件保留在收件箱，请查看插件里的跟踪记录。` }).catch(() => {});
    }
    if ((r.alerts || []).length) await callHost({ action: 'mailAck', email: mailbox.email, ids: r.alerts.map((x) => x.id) }, 15000);
    if (r.hasMore || (r.alerts || []).length >= 50) await chrome.alarms.create('mailWatchSoon', { delayInMinutes: 0.5 });
    return { ok: true, archived: next.archived, alerts: alerts.length, checkedAt: next.checkedAt };
  } finally { mailWatchBusy = false; }
}
chrome.notifications?.onClicked.addListener(async (id) => {
  if (!id.startsWith('mail:')) return;
  const { mailNoticeUrls = {} } = await chrome.storage.local.get('mailNoticeUrls');
  if (mailNoticeUrls[id]) await chrome.tabs.create({ url: mailNoticeUrls[id] });
  else chrome.runtime.openOptionsPage();
  await chrome.action.setBadgeText({ text: '' });
  await chrome.notifications.clear(id);
});
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'mailWatch' || a.name === 'mailWatchSoon') mailWatchTick().catch(() => {}); });
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.mailbox) syncMailWatch().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => syncMailWatch().catch(() => {}));
syncMailWatch().catch(() => {});

const CDP_KEYS = { Enter: [13, 'Enter', '\r'], Tab: [9, 'Tab'], ArrowDown: [40, 'ArrowDown'], ArrowUp: [38, 'ArrowUp'], Escape: [27, 'Escape'], Backspace: [8, 'Backspace'] };
async function trustedInput(tabId, steps) {
  const target = { tabId };
  const send = (method, params) => chrome.debugger.sendCommand(target, method, params || {});
  const held = qEmu.has(tabId); // 队列标签页已经连着（焦点模拟）：直接用，用完也别断开
  try {
    if (!held) await chrome.debugger.attach(target, '1.3');
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
    if (!held) { try { await chrome.debugger.detach(target); } catch (_) { /* 已经断开 */ } }
  }
}

const qEmu = new Set();
async function qEmulateFocus(tabId) {
  if (qEmu.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    qEmu.add(tabId);
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true });
  } catch (e) { console.warn('[投递队列] 焦点模拟没开上', tabId, e && e.message); }
}
async function qUnemulate(tabId) {
  if (!qEmu.delete(tabId)) return;
  try { await chrome.debugger.detach({ tabId }); } catch (_) { /* 标签页已经关了 */ }
}
chrome.debugger.onDetach.addListener((src) => { if (src.tabId) qEmu.delete(src.tabId); });

const qChooser = new Map(); // tabId → { path, until, attachedHere }
async function armChooser(tabId, path) {
  const target = { tabId };
  let attachedHere = false;
  if (!qEmu.has(tabId)) { await chrome.debugger.attach(target, '1.3'); qEmu.add(tabId); attachedHere = true; }
  await chrome.debugger.sendCommand(target, 'Page.enable');
  await chrome.debugger.sendCommand(target, 'Page.setInterceptFileChooserDialog', { enabled: true });
  qChooser.set(tabId, { path, until: Date.now() + 20000, attachedHere });
  setTimeout(() => { const c = qChooser.get(tabId); if (c && c.path === path) disarmChooser(tabId, c); }, 21000); // 没弹窗就收回
  return { ok: true };
}
async function disarmChooser(tabId, c) {
  qChooser.delete(tabId);
  try { await chrome.debugger.sendCommand({ tabId }, 'Page.setInterceptFileChooserDialog', { enabled: false }); } catch (_) { /* 已断开 */ }
  if (c && c.attachedHere) qUnemulate(tabId);
}
chrome.debugger.onEvent.addListener(async (src, method, params) => {
  if (method !== 'Page.fileChooserOpened' || !src.tabId) return;
  const c = qChooser.get(src.tabId);
  try {
    if (c && Date.now() < c.until) await chrome.debugger.sendCommand({ tabId: src.tabId }, 'DOM.setFileInputFiles', { files: [c.path], backendNodeId: params.backendNodeId });
  } catch (e) { console.warn('[上传] 放文件失败', e && e.message); }
  disarmChooser(src.tabId, c);
});

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
const Q_PARK = new Set(['login', 'verify', 'captcha', 'ready', 'stuck', 'timeout', 'noform', 'error']); // 没投完就留着的（10-21 定的规矩：投完了再关）
const aiCalls = new Map(); // 标签页 → 最近 10 分钟 AI 调用时间戳（防循环，见 onMessage 的 'ai'）
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

function qGhId(x) {
  const p = x.searchParams;
  const jid = p.get('gh_jid') || '';
  if (/^\d{5,}$/.test(jid)) return jid;
  if (/(^|\.)greenhouse\.io$/.test(x.hostname)) {
    const tok = p.get('token') || '';
    if (/\/embed\/job_app/.test(x.pathname) && /^\d{5,}$/.test(tok)) return tok;
    const m = x.pathname.match(/\/jobs\/(\d{5,})/);
    if (m) return m[1];
  }
  return '';
}

function qUrlKey(u) {
  try {
    const x = new URL(u);
    const gh = qGhId(x);
    if (gh) return 'greenhouse:' + gh;
    const pl = /(^|\.)paylocity\.com$/i.test(x.hostname) && x.pathname.match(/\/jobs\/(?:apply|details)\/(\d+)/i);
    if (pl) return 'paylocity:' + pl[1];
    return (x.hostname + x.pathname.replace(/^\/[a-z]{2}-[A-Z]{2}(?=\/)/, '').replace(/\/(confirmation|thank-?you|thanks|success|submitted|application-?complete)\/?$/i, '')
      .replace(/\/(apply|application)(\/.*)?$/, '').replace(/\/$/, '')).toLowerCase();
  } catch (_) { return String(u || '').toLowerCase(); }
}

const qFind = (Q, tabId) => Q.items.find((x) => x.tabId === tabId && ['running', 'resumed', 'needs'].includes(x.status));

const Q_DONE_LOG = /已提交|已点提交/;
async function qAlreadyDone(Q, it, urls) {
  const keys = new Set(urls.filter((u) => /^https?:/.test(u || '')).map(qUrlKey).filter(Boolean));
  if (!keys.size) return '';
  const { log = [] } = await chrome.storage.local.get('log');
  if (log.some((r) => Q_DONE_LOG.test(r.status || '') && (r.time || 0) < (it.started || Date.now()) && keys.has(qUrlKey(r.url)))) return '投递记录里已提交过（跳转后认出）';
  for (const x of Q.items) {
    if (x.id === it.id) continue;
    const same = (x.url && keys.has(qUrlKey(x.url))) || (x.lastUrl && /^(greenhouse|paylocity):/.test(qUrlKey(x.lastUrl)) && keys.has(qUrlKey(x.lastUrl)));
    if (!same) continue;
    if (x.status === 'submitted' || x.status === 'dup') return '队列里同一个职位已经投过（跳转后认出）';
    if (x.tabId && ['running', 'resumed', 'needs'].includes(x.status)) return '另一个标签页在投同一个职位';
  }
  return '';
}

async function qSyncFromLog() {
  const { log = [] } = await chrome.storage.local.get('log');
  const done = new Map();
  for (const r of log) if (Q_DONE_LOG.test(r.status || '') && r.url) done.set(qUrlKey(r.url), r);
  if (!done.size) return 0;
  return qTx((Q) => {
    let n = 0;
    for (const it of Q.items) {
      if (!['pending', 'needs', 'stuck'].includes(it.status) || it.force) continue;
      if (it.tabId && it.status === 'needs') continue; // 队列自己开着的标签页在等你，交了它自己会回报
      const r = done.get(qUrlKey(it.url)) || (it.lastUrl && done.get(qUrlKey(it.lastUrl)));
      if (!r) continue;
      Object.assign(it, { status: 'submitted', note: '队列外提交（' + r.status + '）', ended: r.time || Date.now() });
      n++;
    }
    return n;
  });
}
let qSyncTimer = null;
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local' || !ch.log) return;
  clearTimeout(qSyncTimer);
  qSyncTimer = setTimeout(() => qSyncFromLog().catch((e) => console.warn('[投递队列] 同步提交记录', e)), 1500);
});
setTimeout(() => qSyncFromLog().catch(() => {}), 3000);

async function qHello(tabId, urls = []) {
  const Q = await qGet();
  const it = qFind(Q, tabId);
  if (!it) return { item: null };
  if (it.status === 'running' && !it.submitAt && !it.force) {
    const why = await qAlreadyDone(Q, it, urls);
    if (why) {
      await qTx((Q2) => { const x = Q2.items.find((y) => y.id === it.id); if (x) Object.assign(x, { status: 'dup', note: why, ended: Date.now(), tabId: null }); });
      setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 800);
      setTimeout(qNext, 2000);
      return { item: null };
    }
  }
  return { item: { id: it.id, url: it.url, company: it.company, title: it.title, resume: it.resume, hops: it.hops || 0, status: it.status, need: it.need || '', submitAt: it.submitAt || 0 }, autoSubmit: !!Q.meta.autoSubmit };
}

async function qCloseQuiet(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => { window.onbeforeunload = null; window.addEventListener('beforeunload', (e) => e.stopImmediatePropagation(), true); } }).catch(() => {});
  await chrome.tabs.remove(tabId).catch(() => {});
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
        return { next: true, resume: true };
      }
      return null;
    }
    if (st === 'hop') { it.hops = (it.hops || 0) + 1; return null; }
    if (st === 'submitting') { it.submitAt = now; return null; } // 点了提交：跳到新页面后靠它认出「这是提交成功页」
    it.note = String(m.note || '').slice(0, 400);
    if (Array.isArray(m.missing)) it.missing = m.missing.slice(0, 8).map((s) => String(s).slice(0, 80));
    it.ended = now;
    if (st === 'submitted' || st === 'dup' || st === 'closed' || st === 'ineligible' || st === 'skipped') { // skipped：你在面板上点了「跳过这个」
      it.status = st;
      it.need = '';
      const close = it.tabId;
      it.tabId = null;
      return { close, next: true };
    }
    it.status = 'needs';
    it.need = st;
    return { next: true, park: true };
  });
  if (out && out.close) setTimeout(() => qCloseQuiet(out.close), 2500);
  if (out && out.park) qUnemulate(tabId);
  if (out && out.resume) qEmulateFocus(tabId);
  if (out && out.next) setTimeout(qNext, 3000);
  return { ok: true };
}

const Q_UNDERGRAD_ONLY = (t) => /\bunder ?grad(uate)?s?\b/i.test(t || '') && !/\bgrad(uate)?s?\b|\bmasters?\b|\bmba\b|\bph\.?d\b|\bpost-?grad/i.test(String(t).replace(/\bunder ?grad(uate)?s?\b/gi, ''));

async function qNext() {
  const picks = await qTx(async (Q) => {
    const M = Q.meta;
    for (const x of Q.items) if ((x.status === 'pending' || (x.status === 'needs' && !x.tabId)) && Q_UNDERGRAD_ONLY(x.title)) Object.assign(x, { status: 'ineligible', need: '', note: '只招本科生（你在读硕士）：' + String(x.title).slice(0, 80), ended: Date.now() });
    if (!M.running) return [];
    const running = Q.items.filter((x) => x.status === 'running');
    const slots = Math.max(1, Math.min(10, Number(M.concurrency) || 1)) - running.length;
    if (slots <= 0) return [];
    const parked = Q.items.filter((x) => x.tabId && x.status === 'needs' && Q_PARK.has(x.need)).length;
    if (parked >= M.maxParked) {
      M.running = false;
      M.note = `有 ${parked} 个标签页在等你（登录 / 验证码 / 人机验证 / 等你点提交），先暂停。处理掉几个、或把「最多留几个标签页等你」调大，再点「开始」。`;
      return [];
    }
    const blocked = new Set(Q.items.filter((x) => x.status === 'needs' && x.need === 'login').map((x) => x.host)); // 要登录的网站（标签页关了也算）：其他职位先不开
    const busy = new Set(running.filter((x) => Q_LOGIN_ATS.has(x.ats)).map((x) => x.host));
    const serial = new Set(Q.items.filter((x) => x.tabId || x.status === 'running').map(qSerialKey).filter(Boolean));
    const out = [];
    for (let n = 0; n < slots; n++) {
      const ok = (x) => x.status === 'pending' && !blocked.has(x.host) && !(Q_LOGIN_ATS.has(x.ats) && busy.has(x.host)) && !(qSerialKey(x) && serial.has(qSerialKey(x)));
      const it = (M.preferHost && Q.items.find((x) => ok(x) && x.host === M.preferHost)) || Q.items.find(ok);
      if (!it) break;
      if (M.preferHost && it.host !== M.preferHost) M.preferHost = '';
      Object.assign(it, { status: 'running', started: Date.now(), progress: Date.now(), hops: 0, need: '', note: '', missing: [], tries: (it.tries || 0) + 1 });
      if (Q_LOGIN_ATS.has(it.ats)) busy.add(it.host);
      if (qSerialKey(it)) serial.add(qSerialKey(it));
      out.push({ id: it.id, url: it.url, force: !!it.force });
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
  if (!pick.force && log.some((r) => Q_DONE_LOG.test(r.status || '') && qUrlKey(r.url) === key)) {
    await setItem({ status: 'dup', note: '投递记录里已提交过', ended: Date.now() });
    setTimeout(qNext, 500);
    return;
  }
  let tabId;
  try {
    const M = (await qGet()).meta;
    let win = M.windowId ? await chrome.windows.get(M.windowId).catch(() => null) : null;
    if (win) {
      tabId = (await chrome.tabs.create({ windowId: win.id, url: 'about:blank', active: false })).id;
      if (M.groupId != null) await chrome.tabs.group({ groupId: M.groupId, tabIds: tabId }).catch(() => qTx((Q2) => { Q2.meta.groupId = null; }));
    } else {
      win = await chrome.windows.create({ url: 'about:blank', focused: false, width: 1300, height: 950 });
      tabId = win.tabs[0].id;
      await qTx((Q2) => { Q2.meta.windowId = win.id; Q2.meta.groupId = null; });
    }
    await setItem({ tabId });
    await chrome.tabs.update(tabId, { url: pick.url });
    qEmulateFocus(tabId);
  } catch (e) {
    if (/cannot be edited right now|dragging a tab/i.test(String(e))) {
      if (tabId) chrome.tabs.remove(tabId).catch(() => {});
      await setItem({ status: 'pending', need: '', note: '', tabId: null });
      setTimeout(qNext, 5000);
      return;
    }
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

const Q_ERRPAGE_RE = /^(隐私设置错误|privacy error|your connection is not private|您的连接不是私密连接|无法访问此网站|this site can.t be reached|该网页无法正常运作|this page isn.t working)$/i;
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.title || !Q_ERRPAGE_RE.test(info.title.trim())) return;
  qReport(tabId, { state: 'closed', note: '网站打不开（' + info.title.trim() + '）' }).catch(() => {});
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
  for (const it of Q.items) if ((it.status === 'running' || it.status === 'resumed') && it.tabId) qEmulateFocus(it.tabId);
  const close = await qTx((Q2) => {
    const now = Date.now();
    const out = [];
    for (const it of Q2.items) {
      if ((it.status === 'running' || it.status === 'resumed') && now - (it.progress || it.started || now) > Q2.meta.timeoutMin * 60000) {
        Object.assign(it, { status: 'needs', need: 'timeout', note: `${Q2.meta.timeoutMin} 分钟没有进展（标签页留着）`, ended: now });
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

function qUrlCompany(u) {
  try {
    const x = new URL(u);
    const h = x.hostname.toLowerCase();
    const seg = x.pathname.split('/').filter(Boolean);
    if (/(^|\.)greenhouse\.io$/.test(h)) { const f = x.searchParams.get('for'); if (f) return 'gh:' + f.toLowerCase(); if (seg[0] && seg[0] !== 'embed') return 'gh:' + seg[0].toLowerCase(); return ''; }
    if (h === 'jobs.lever.co' && seg[0]) return 'lever:' + seg[0].toLowerCase();
    if (h === 'jobs.ashbyhq.com' && seg[0]) return 'ashby:' + seg[0].toLowerCase();
    if (/smartrecruiters\.com$/.test(h)) { const i = seg.indexOf('company'); const c = i >= 0 ? seg[i + 1] : seg[0]; return c && !/^oneclick-ui$/i.test(c) ? 'sr:' + c.toLowerCase() : ''; }
    if (/myworkdayjobs\.com$|myworkdaysite\.com$/.test(h)) return 'wd:' + (h.split('.')[0] === 'wd1' || h.split('.')[0] === 'wd5' ? (seg[1] || '') : h.split('.')[0]);
    if (/oraclecloud\.com$/.test(h)) return 'oracle:' + h.split('.')[0];
    if (/icims\.com$/.test(h)) return 'icims:' + h.split('.')[0].replace(/^careers-/, '');
    if (/rippling\.com$/.test(h) && seg[0]) return 'rippling:' + seg[0].toLowerCase();
    return '';
  } catch (_) { return ''; }
}
function qSerialKey(x) {
  try {
    const u = new URL(x.lastUrl || x.url);
    const seg = u.pathname.split('/').filter(Boolean);
    if (/(^|\.)ashbyhq\.com$/.test(u.hostname) && seg[0]) return 'ashby:' + seg[0].toLowerCase();
  } catch (_) { /* ignore */ }
  const co = String(x.company || '').toLowerCase().replace(/\b(company of america|corporation|corp|incorporated|inc|llc|l\.l\.c|ltd|limited|co|group|holdings?|the)\b\.?/g, ' ').replace(/[^a-z0-9]+/g, '');
  return co ? 'co:' + co : '';
}
function qCompanyKeyer(items) {
  const parent = new Map();
  const find = (a) => { while (parent.has(a) && parent.get(a) !== a) a = parent.get(a); return a; };
  const union = (a, b) => { if (!a || !b) return; const ra = find(a), rb = find(b); if (!parent.has(ra)) parent.set(ra, ra); if (!parent.has(rb)) parent.set(rb, rb); if (ra !== rb) parent.set(rb, ra); };
  const name = (x) => { const n = String(x.company || '').toLowerCase().replace(/[^a-z0-9]/g, ''); return n ? 'co:' + n : 'host:' + x.host; };
  for (const x of items) for (const u of [x.url, x.lastUrl]) { const k = u && qUrlCompany(u); if (k) union(name(x), k); }
  return (x) => find(name(x));
}

const Q_UNSUPPORTED = /^$/;
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
    const seenKey = new Map(Q.items.filter((x) => x.status !== 'pending').map((x) => [qUrlKey(x.url), x.status]));
    for (const r of rows) {
      const k = qUrlKey(r.url);
      const old = by.get(r.id);
      if (seenKey.has(k) && !(old && old.status !== 'pending')) continue;
      seenKey.set(k, 'pending');
      if (old) { Object.assign(old, { url: r.url, company: r.company, title: r.title, loc: r.loc, resume: r.resume, prio: r.prio, ats: r.ats, host: r.host }); out.push(old); by.delete(r.id); }
      else {
        const was = doneKeys.get(k);
        const unsupported = !was && Q_UNSUPPORTED.test(String(r.url || '') + ' ' + String(r.ats || ''));
        out.push({ ...r, status: was ? 'dup' : unsupported ? 'skipped' : 'pending', note: was ? '投递记录：' + was : unsupported ? '插件暂不支持这个招聘系统（SmartRecruiters 新版申请页）' : '' });
        fresh.add(r.id);
        added++;
      }
    }
    const removed = [];
    for (const x of by.values()) (x.status === 'pending' ? removed : out).push(x);
    const cap = Number(data.perCompany) || 0;
    let list = out;
    if (cap) {
      const ck = qCompanyKeyer(out);
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
    const needs = new Set(m.needs || ['stuck', 'timeout', 'error', 'closed', 'noform', 'login', 'verify', 'captcha', 'ready']);
    const n = await qTx((Q) => {
      let k = 0;
      for (const it of Q.items) {
        const forced = m.force && m.ids && m.ids.includes(it.id) && (it.status === 'dup' || it.status === 'ineligible') && !it.tabId; // ineligible：标错了的（Selective Treasury 是被串到别的职位才关的）
        if (!forced && (it.status !== 'needs' || it.tabId || !needs.has(it.need) || (m.ids && !m.ids.includes(it.id)) || (m.host && it.host !== m.host))) continue;
        Object.assign(it, { status: 'pending', need: '', note: '', ...(forced ? { force: true } : {}) });
        k++;
      }
      return k;
    });
    return { ...(await qSummary()), retried: n };
  }
  if (c === 'ineligible') {
    const tabs = await qTx((Q) => {
      const t = [];
      for (const it of Q.items) if ((m.ids || []).includes(it.id) && it.status !== 'running') { if (it.tabId) t.push(it.tabId); Object.assign(it, { status: 'ineligible', need: '', note: String(m.note || '不符合条件').slice(0, 200), ended: Date.now(), tabId: null }); }
      return t;
    });
    for (const t of tabs) await qCloseQuiet(t);
    return { ...(await qSummary()), closed: tabs };
  }
  if (c === 'rerun') {
    const Q = await qGet();
    const started = [];
    for (const it of Q.items.filter((x) => x.tabId && (m.ids || []).includes(x.id))) {
      const r = await chrome.tabs.sendMessage(it.tabId, { type: 'wdafStartAll' }).catch(() => null);
      if (r && r.started) started.push(it.id);
    }
    return { ok: true, started };
  }
  if (c === 'acceptDialogs') {
    const tabs = (await chrome.tabs.query({})).filter((t) => !m.tabId || t.id === m.tabId);
    const done = [];
    for (const t of tabs) {
      const target = { tabId: t.id };
      const held = qEmu.has(t.id);
      try {
        if (!held) await chrome.debugger.attach(target, '1.3');
        await chrome.debugger.sendCommand(target, 'Page.handleJavaScriptDialog', { accept: true });
        done.push(t.id);
      } catch (_) { /* 这个页没有对话框 */ }
      if (!held) { try { await chrome.debugger.detach(target); } catch (_) { /* 已断开 */ } }
    }
    return { ok: true, handled: done };
  }
  if (c === 'log') {
    const { log = [] } = await chrome.storage.local.get('log');
    return { ok: true, log: log.slice(-(m.n || 30)).map((r) => ({ url: r.url, status: r.status, time: r.time, title: (r.title || '').slice(0, 80) })) };
  }
  if (c === 'unlog' && m.match) {
    const re = new RegExp(m.match, 'i');
    const { log = [] } = await chrome.storage.local.get('log');
    const removed = log.filter((r) => re.test(String(r.url || '')) || re.test(String(r.title || '')));
    await chrome.storage.local.set({ log: log.filter((r) => !removed.includes(r)) });
    return { ok: true, removed: removed.map((r) => ({ url: String(r.url || '').slice(0, 120), status: r.status, time: r.time })) };
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
    const re = m.match ? new RegExp(m.match, 'i') : null;
    let n = 0;
    await qTx((Q) => { for (const it of Q.items) if (((m.ids || []).includes(it.id) || (re && re.test(String(it.url || '') + ' ' + String(it.ats || '') + ' ' + String(it.company || '') + ' ' + String(it.lastUrl || '')) && it.status === (c === 'skip' ? 'pending' : 'skipped'))) && it.status !== 'running') { it.status = c === 'skip' ? 'skipped' : 'pending'; if (c === 'unskip') it.note = ''; n++; } });
    return { ...(await qSummary()), changed: n };
    
  }
  if (c === 'submitted') {
    await qTx((Q) => { for (const it of Q.items) if ((m.ids || []).includes(it.id) && it.status !== 'running') Object.assign(it, { status: 'submitted', need: '', note: m.note || '你确认已提交', ended: it.ended || Date.now(), tabId: null }); });
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
