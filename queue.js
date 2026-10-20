const $ = (s) => document.querySelector(s);
const cmd = (c, extra) => new Promise((r) => chrome.runtime.sendMessage({ type: 'queueCmd', cmd: c, ...(extra || {}) }, (x) => { void chrome.runtime.lastError; r(x || {}); }));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const LABEL = { pending: '待投', running: '正在投', resumed: '你处理后继续中', submitted: '已提交', dup: '已投过', closed: '职位已关', skipped: '跳过' };
const NEED = { login: '要登录 / 注册', verify: '要邮箱验证码', captcha: '要人机验证', ready: '等你点提交', stuck: '卡住了', timeout: '超时', error: '出错', closed: '标签页被关了', noform: '找不到申请表' };

async function refresh() {
  const s = await cmd('status', { full: true });
  if (!s.ok) return;
  const c = s.count || {};
  const needTotal = Object.entries(c).filter(([k]) => k.startsWith('needs:')).reduce((a, [, v]) => a + v, 0);
  const cards = [['总数', s.total], ['待投', c.pending || 0], ['已提交', c.submitted || 0], ['等你处理', needTotal], ['已投过', c.dup || 0], ['职位已关', c.closed || 0], ['跳过', c.skipped || 0]];
  for (const [k, v] of Object.entries(c)) if (k.startsWith('needs:')) cards.push([NEED[k.slice(6)] || k, v]);
  $('#stats').innerHTML = cards.map(([k, v]) => `<div class="stat"><b>${v}</b><span>${esc(k)}</span></div>`).join('');
  $('#note').hidden = !s.meta.note;
  $('#note').textContent = s.meta.note || '';
  const acts = s.actives || (s.active ? [s.active] : []);
  $('#src').textContent = s.meta.importSource ? `当前列表：${s.meta.importSource}（${s.meta.importVersion || ''}，候选池出新版会自动导入）` : '';
  $('#active').textContent = acts.length ? `正在投（${acts.length}）：` + acts.map((a) => `${a.company} — ${a.title}`).join('；') : (s.meta.running ? '运行中' : '没在运行');
  $('#start').disabled = !!s.meta.running;
  $('#pause').disabled = !s.meta.running;
  if (document.activeElement !== $('#maxParked')) $('#maxParked').value = s.meta.maxParked;
  if (document.activeElement !== $('#concurrency')) $('#concurrency').value = s.meta.concurrency || 1;
  $('#autoSubmit').checked = !!s.meta.autoSubmit;
  const needs = s.needs || [];
  $('#needs').innerHTML = needs.length ? '<tr><th>职位</th><th>原因</th><th></th></tr>' + needs.map((it) => `
    <tr data-id="${esc(it.id)}">
      <td><a href="${esc(it.url)}" target="_blank">${esc(it.company)} — ${esc(it.title)}</a><div class="why">${esc(it.host)} · ${esc(it.ats)}${it.tabId ? ' · 标签页开着' : ''}</div></td>
      <td><span class="tag">${esc(it.status === 'resumed' ? LABEL.resumed : NEED[it.need] || it.need)}</span><div class="why">${esc(it.note || '')}${it.missing && it.missing.length ? '<br>缺：' + esc(it.missing.join('；')) : ''}</div></td>
      <td><button data-a="focus">去处理</button><button data-a="retry" class="ghost">重试</button><button data-a="skip" class="ghost">跳过</button></td>
    </tr>`).join('') : '<tr><td class="hint">没有</td></tr>';
  const done = (s.done || []).filter((x) => x.status === 'submitted').sort((a, b) => (b.ended || 0) - (a.ended || 0)).slice(0, 200);
  $('#done').innerHTML = done.length ? done.map((it) => `<tr><td><a href="${esc(it.url)}" target="_blank">${esc(it.company)} — ${esc(it.title)}</a></td><td class="why">${it.ended ? new Date(it.ended).toLocaleString() : ''}</td></tr>`).join('') : '<tr><td class="hint">还没有</td></tr>';
}

$('#needs').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-a]');
  if (!b) return;
  const id = b.closest('tr').dataset.id;
  if (b.dataset.a === 'focus') await cmd('focus', { id });
  if (b.dataset.a === 'retry') await cmd('retry', { ids: [id], needs: Object.keys(NEED) });
  if (b.dataset.a === 'skip') await cmd('skip', { ids: [id] });
  refresh();
});
$('#start').onclick = async () => { await cmd('start'); refresh(); };
$('#startAll').onclick = () => chrome.runtime.sendMessage({ type: 'startAllTabs' }, (r) => { void chrome.runtime.lastError; $('#startAll').textContent = `已让 ${(r && r.sent) || 0} 个申请页开始`; setTimeout(() => { $('#startAll').textContent = '所有申请页一起开始'; }, 4000); });
$('#pause').onclick = async () => { await cmd('pause'); refresh(); };
$('#stop').onclick = async () => { await cmd('stop'); refresh(); };
$('#retry').onclick = async () => { const r = await cmd('retry'); $('#importStatus').textContent = `放回待投 ${r.retried || 0} 个`; refresh(); };
$('#autoSubmit').onchange = async (e) => { await cmd('set', { autoSubmit: e.target.checked }); refresh(); };
$('#maxParked').onchange = async (e) => { await cmd('set', { maxParked: Math.max(1, Number(e.target.value) || 12) }); refresh(); };
$('#concurrency').onchange = async (e) => { const s = await cmd('set', { concurrency: Math.max(1, Math.min(10, Number(e.target.value) || 1)) }); if (s.meta && s.meta.running) await cmd('start'); refresh(); };
$('#importJson').onclick = async () => {
  const r = await cmd('import');
  $('#importStatus').textContent = r.ok ? `导入了：新增 ${r.added}，共 ${r.total}` : (r.error || '导入失败');
  refresh();
};

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}
const ATS = [
  [/greenhouse\.io|grnh\.se/, 'greenhouse', 0], [/lever\.co/, 'lever', 0], [/ashbyhq\.com/, 'ashby', 0], [/smartrecruiters\.com/, 'smartrecruiters', 0],
  [/workable\.com/, 'workable', 0], [/paylocity\.com/, 'paylocity', 0], [/rippling\.com/, 'rippling', 0], [/pinpointhq\.com/, 'pinpoint', 0],
  [/applytojob\.com/, 'jazzhr', 0], [/bamboohr\.com/, 'bamboohr', 0], [/jobvite\.com/, 'jobvite', 1], [/paycomonline\.net/, 'paycom', 1],
  [/myworkdayjobs\.com|myworkdaysite\.com/, 'workday', 2], [/oraclecloud\.com/, 'oracle', 2], [/icims\.com/, 'icims', 2], [/successfactors\.(com|eu)/, 'successfactors', 2],
  [/taleo\.net/, 'taleo', 2], [/ultipro\.com|ukg\.net/, 'ukg', 2], [/dayforcehcm\.com/, 'dayforce', 2], [/csod\.com/, 'cornerstone', 2], [/avature\.net/, 'avature', 2],
  [/jobright\.ai|intern-list\.com|indeed\.com|linkedin\.com|glassdoor\.com|ziprecruiter\.com|simplify\.jobs/, 'aggregator', 3],
];
async function sha12(s) {
  const b = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 12);
}
$('#csv').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const rows = parseCsv((await f.text()).replace(/^﻿/, ''));
  const hdr = rows[0].map((h) => h.trim());
  const at = (names) => hdr.findIndex((h) => names.includes(h));
  const ix = { url: at(['链接', 'url', 'link']), company: at(['company', '公司']), title: at(['title', '岗位']), loc: at(['location', '地点']), resume: at(['建议简历版本', 'resume']), visa: at(['签证措辞']), prio: at(['优先分', 'priority']) };
  if (ix.url < 0) { $('#importStatus').textContent = 'CSV 里没有「链接」列'; return; }
  const { resumes = [] } = await chrome.storage.local.get('resumes');
  const resumeId = (label) => (resumes.find((r) => r.label.toLowerCase() === String(label || '').trim().toLowerCase()) || {}).id || '';
  const per = Math.max(1, Number($('#perCompany').value) || 3);
  const minPrio = Number($('#minPrio').value);
  const seen = new Set();
  let items = [];
  for (const r of rows.slice(1)) {
    const url = (r[ix.url] || '').trim();
    if (!/^https?:/.test(url) || seen.has(url)) continue;
    seen.add(url);
    const prio = Number(r[ix.prio]) || 0;
    if (prio < minPrio) continue;
    const h = new URL(url).hostname.toLowerCase();
    const [, ats, grp] = ATS.find(([re]) => re.test(h)) || [null, 'other', 1];
    items.push({ id: await sha12(url), url, company: (r[ix.company] || '').trim(), title: (r[ix.title] || '').trim(), loc: (r[ix.loc] || '').trim(), resume: resumeId(r[ix.resume]), visa: (r[ix.visa] || '').trim(), prio, ats, host: ats === 'workday' ? h.split('.')[0] + '.workday' : h, grp });
  }
  items.sort((a, b) => b.prio - a.prio);
  const cnt = {};
  items = items.filter((it) => { const k = it.company.toLowerCase().replace(/[^a-z0-9]/g, '') || it.host; cnt[k] = (cnt[k] || 0) + 1; return cnt[k] <= per; });
  const best = {};
  for (const it of items) best[it.host] = Math.max(best[it.host] ?? -99, it.prio);
  items.sort((a, b) => a.grp - b.grp || best[b.host] - best[a.host] || a.host.localeCompare(b.host) || b.prio - a.prio);
  items.forEach((it) => delete it.grp);
  const r = await cmd('import', { data: { version: 'csv-' + Date.now(), items } });
  $('#importStatus').textContent = r.ok ? `导入了 ${items.length} 个：新增 ${r.added}，共 ${r.total}` : (r.error || '导入失败');
  e.target.value = '';
  refresh();
};

async function heartbeat() {
  try {
    const t = await chrome.tabs.getCurrent();
    if (t) await chrome.storage.local.set({ queuePageSeen: { t: Date.now(), windowId: t.windowId, index: t.index, active: t.active } });
  } catch (_) { /* 拿不到就算了 */ }
}
refresh();
heartbeat();
setInterval(() => { refresh(); heartbeat(); }, 5000);
