(() => {
  if (window.__wdafLoaded) return;
  if (/^(127\.0\.0\.1|localhost)$/.test(location.hostname) && /\/test-mock\//.test(location.pathname) && chrome.runtime && chrome.runtime.id !== 'mock') return;
  window.__wdafLoaded = true;
  const DEAD_CTX_RE = /Extension context invalidated|Receiving end does not exist|message port closed/i;
  window.addEventListener('unhandledrejection', (e) => { if (DEAD_CTX_RE.test(String((e.reason && e.reason.message) || e.reason || ''))) e.preventDefault(); });
  window.addEventListener('error', (e) => { if (DEAD_CTX_RE.test(String(e.message || ''))) e.preventDefault(); });
  document.querySelectorAll('#wdaf-host').forEach((h) => h.remove());

  const AUTO_KEY = 'wdaf-auto-running';
  const BUILD = '2026-10-20.291'; // 每次改代码都改这里：面板上 data-build 能看出浏览器里跑的是哪一版
  let QUEUE = null;
  let QUEUE_SUBMIT = false; // 队列设置：填完自动提交
  const sleep = (ms) => new Promise((r) => {
    if (QUEUE && document.hidden && ms >= 100) {
      try { chrome.runtime.sendMessage({ type: 'sleep', ms }, () => { void chrome.runtime.lastError; r(); }); return; } catch (_) { /* 插件断开了，用普通定时器 */ }
    }
    setTimeout(r, ms);
  });
  const dbg = (...a) => console.debug('[自动投递]', ...a); // 在网页的控制台里看插件每一步做了什么
  const alive = () => { try { return !!chrome.runtime?.id; } catch (_) { return false; } };
  const q = (sel, root = document) => root.querySelector(sel);
  const qa = (sel, root = document) => [...root.querySelectorAll(sel)];
  const isSR = () => /(^|\.)smartrecruiters\.com$/i.test(location.hostname);
  function shadowQa(sel) {
    const out = [];
    const walk = (root) => { for (const el of root.querySelectorAll('*')) if (el.shadowRoot) { out.push(...el.shadowRoot.querySelectorAll(sel)); walk(el.shadowRoot); } };
    walk(document);
    return out;
  }
  const shadowHost = (el) => { const r = el && el.getRootNode && el.getRootNode(); return r && typeof ShadowRoot !== 'undefined' && r instanceof ShadowRoot ? r.host : null; };
  function hostAttr(el, name) { for (let h = shadowHost(el); h; h = shadowHost(h)) { const v = h.getAttribute && h.getAttribute(name); if (v) return v; } return ''; }
  function hostHas(el, name) { for (let h = shadowHost(el); h; h = shadowHost(h)) if (h.hasAttribute && h.hasAttribute(name)) return true; return false; }
  const hostTags = (el) => { const t = []; for (let h = shadowHost(el); h; h = shadowHost(h)) t.push(h.tagName.toLowerCase()); return t.join(' '); };
  const srHostLabel = (h) => cleanLabel([...h.children].filter((c) => c.tagName === 'SPAN').map(textOf).join(' ') || h.getAttribute('label') || String(h.getAttribute('aria-label') || '').replace(/^select\s+/i, ''));
  function srDeep(root, sel) { const out = [...root.querySelectorAll(sel)]; for (const el of root.querySelectorAll('*')) if (el.shadowRoot) out.push(...srDeep(el.shadowRoot, sel)); return out; }
  function srFire(el) { const o = { bubbles: true, cancelable: true, composed: true, view: window }; for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) el.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, o)); }
  const textOf = (el) => (el ? (el.innerText || el.textContent || '') : '').replace(/\s+/g, ' ').trim();

  const WD_HOST = /(^|\.)myworkday(jobs|site)?\.com$/i.test(location.hostname);
  const isWD = () => WD_HOST || !!q('[data-automation-id="applyFlowPage"], [data-automation-id="jobPostingPage"], [data-automation-id="adventureButton"]');
  const WD_LOCALE = WD_HOST && location.pathname.match(/^\/([a-z]{2}-[A-Z]{2})(?=\/)/);
  const wdLocaleKey = 'wdaf-en:' + location.pathname.replace(/^\/[a-z]{2}-[A-Z]{2}/, '');
  if (WD_LOCALE && !/^en-/.test(WD_LOCALE[1]) && !sessionStorage.getItem(wdLocaleKey)) {
    try { sessionStorage.setItem(wdLocaleKey, '1'); } catch (_) { /* 无痕等情况存不了，也只是多跳一次 */ }
    console.log('[自动投递] Workday 页面是', WD_LOCALE[1], '版，换成英文版网址');
    location.replace(location.pathname.replace(/^\/[a-z]{2}-[A-Z]{2}/, '/en-US') + location.search + location.hash);
  }
  const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’‘]/g, "'").replace(/[ \s]+/g, ' ').replace(/[*✱]/g, '').trim();
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const DECLINE_RE = /decline|not wish|n.t wish|prefer not|choose not|do not want|don.t want|rather not|not to (answer|disclose|self.?identify|provide)/i;

  let S = { profile: {}, settings: {}, resumes: [], defaultResumeId: '', rules: [] };
  let running = false;

  const IN_FRAME = window !== window.top;
  let proxied = false;      // iframe：外层页面已经替我显示面板
  let awaitingAck = false;  // iframe：等外层回话，先不显示自己的面板
  let hostJobInfo = null;   // iframe：外层职位页传来的标题和描述（用来选简历）
  let proxyChild = null;    // 外层：申请表所在的 iframe
  let childState = null;    // 外层：iframe 传来的面板状态


  async function loadState() {
    const d = await chrome.storage.local.get(['profile', 'settings', 'resume', 'resumes', 'defaultResumeId', 'customRules', 'transcript']);
    if (typeof d.customRules === 'string') {
      const cleaned = dropGenericLearned(d.customRules);
      if (cleaned !== d.customRules) { d.customRules = cleaned; await chrome.storage.local.set({ customRules: cleaned }); }
    }
    S = {
      profile: wdafMergeProfile(d.profile),
      settings: { ...WDAF_DEFAULT_SETTINGS, ...(d.settings || {}) },
      resumes: wdafResumeList(d),
      defaultResumeId: d.defaultResumeId || '',
      transcript: d.transcript || null,
      rules: wdafParseRules(d.customRules ?? WDAF_DEFAULT_RULES),
    };
  }


  const jobKey = () => location.pathname.replace(/\/apply(\/.*)?$/, '');
  const jobInfoCache = new Map();
  let jobLocation = ''; // 只有一个工作地点的岗位，这里是那个地点

  function noneToken(el) {
    const ids = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    const help = ids.map((id) => textOf(document.getElementById(id))).join(' ') + ' ' + textOf(el.closest('.field-wrapper, .input-wrapper, .application-question, li, fieldset')?.parentElement?.querySelector?.('.help, .description, [class*=description]') || null);
    const m = help.match(/if (none|not applicable|no|n\/a)\b[^.]{0,30}?\b(enter|write|type|put|respond|answer|indicate)\b\s*(with\s*)?["“'‘]?(n\/?a|none|not applicable)\b/i);
    if (!m) return '';
    return /^n\/?a$/i.test(m[4]) ? 'n/a' : m[4];
  }

  function pageJobLocation() {
    const el = qa('.job__location, .app-title + .location, #header .location, .company-name + .location').find((e) => !e.closest('#wdaf-host') && textOf(e));
    if (!el) return '';
    const t = textOf(el).replace(/\s+/g, ' ').trim();
    const first = t.split(/\s*(?:;|\||\bor\b|\/)\s*/)[0].replace(/,?\s*(United States( of America)?|USA|US)$/i, '').trim();
    return first.length > 2 && first.length < 60 ? first : '';
  }

  function jobTitleFromPage() {
    if (isWD()) return textOf(q('[data-automation-id="jobTitleHeading"]')) || textOf(q('[data-automation-id="jobPostingHeader"]'));
    const h = qa('h1, h2').find((e) => isVisible(e) && !e.closest('#wdaf-host') && textOf(e).length > 3);
    return (h ? textOf(h) + ' ' : '') + document.title;
  }

  function jobApiPath() {
    const segs = location.pathname.replace(/\/apply(\/.*)?$/, '').split('/').filter(Boolean);
    const j = segs.indexOf('job');
    if (j < 1) return null;
    const site = segs[j - 1];
    const r = segs.indexOf('recruiting'); // myworkdaysite.com/recruiting/{公司}/{站点}/job/...
    const tenant = r >= 0 ? segs[r + 1] : location.hostname.split('.')[0];
    return `/wday/cxs/${tenant}/${site}/${segs.slice(j).join('/')}`;
  }

  async function getJobInfo() {
    if (hostJobInfo) return hostJobInfo; // iframe 里的申请表：用外层职位页的标题和描述
    const key = jobKey();
    if (jobInfoCache.has(key)) {
      const c = jobInfoCache.get(key);
      if (!c.title) c.title = jobTitleFromPage();
      return c;
    }
    const info = isWD()
      ? { title: jobTitleFromPage(), desc: textOf(q('[data-automation-id="jobPostingDescription"]')) }
      : { title: jobTitleFromPage(), desc: textOf(document.body).slice(0, 20000) };
    const api = isWD() && jobApiPath();
    if (api && !info.desc) {
      try {
        const r = await fetch(api, { headers: { Accept: 'application/json' }, credentials: 'include' });
        if (r.ok) {
          const p = (await r.json()).jobPostingInfo || {};
          info.title = info.title || p.title || '';
          const locs = [p.location, ...(p.additionalLocations || [])].filter(Boolean);
          jobLocation = locs.length === 1 ? String(locs[0]).replace(/^([A-Z]{2})-\s*(.+)$/, '$2, $1') : '';
          info.desc = String(p.jobDescription || '').replace(/<[^>]+>/g, ' ');
        }
      } catch (_) { /* 拿不到就只按标题判断 */ }
    }
    const ora = /\/CandidateExperience\/[^/]+\/sites\/([^/]+)\/job\/(\d+)/i.exec(location.pathname);
    if (ora) {
      try {
        const url = `${location.origin}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${ora[2]}%22,siteNumber=${ora[1]}`;
        const r = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'include' });
        const it = r.ok ? ((await r.json()).items || [])[0] : null;
        if (it) {
          info.title = it.Title || info.title;
          const d = [it.ExternalDescriptionStr, it.ExternalResponsibilitiesStr, it.ExternalQualificationsStr, it.CorporateDescriptionStr].filter(Boolean).join('\n');
          if (d) info.desc = d.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+\n/g, '\n');
        }
      } catch (_) { /* 拿不到就用页面文字 */ }
    }
    if (info.title || info.desc) jobInfoCache.set(key, info);
    return info;
  }

  const overrideKey = () => 'wdaf-resume:' + jobKey();

  async function chooseResume() {
    if (!S.resumes.length) return null;
    const forced = sessionStorage.getItem(overrideKey());
    const forcedResume = forced && S.resumes.find((r) => r.id === forced);
    if (forcedResume) return { resume: forcedResume, hits: [], manual: true };
    const queued = QUEUE && QUEUE.resume && S.resumes.find((r) => r.id === QUEUE.resume);
    if (queued) return { resume: queued, hits: ['候选池表格指定'], manual: false };
    const info = await getJobInfo();
    return wdafPickResume(S.resumes, S.defaultResumeId, info.title, info.desc);
  }

  let currentPick = null;
  async function refreshPick() {
    currentPick = await chooseResume();
    await checkCoverLetter();
    renderPanel();
  }

  async function addLog(status) {
    const url = location.href.split('#')[0].replace(/\/(confirmation|thank-?you|thanks|success)\/?(\?.*)?$/i, '').replace(/\/apply(\/.*)?$/, '');
    const { log = [] } = await chrome.storage.local.get('log');
    const pick = currentPick || (await chooseResume());
    const entry = {
      time: Date.now(),
      company: location.hostname.split('.')[0],
      title: jobTitleFromPage() || document.title,
      url,
      resume: pick ? pick.resume.label : '',
      status,
    };
    const i = log.findIndex((r) => r.url === url);
    if (i >= 0) log[i] = { ...log[i], ...entry };
    else log.push(entry);
    await chrome.storage.local.set({ log });
  }


  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
  }

  function mouseClick(el) {
    const o = { bubbles: true, cancelable: true, view: window };
    const p = { ...o, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerdown', p));
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new PointerEvent('pointerup', p));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  }

  function pressKey(el, key) {
    if (key === 'Escape' && !isWD()) return;
    const keyCode = { Enter: 13, Escape: 27, ArrowDown: 40 }[key] || 0;
    for (const type of ['keydown', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key, code: key, keyCode, which: keyCode, bubbles: true, cancelable: true }));
    }
  }

  function setText(el, value) {
    value = String(value);
    el.focus();
    let ok = false;
    try {
      el.select?.();
      ok = document.execCommand('insertText', false, value);
    } catch (_) { /* ignore */ }
    if (!ok || el.value !== value) {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true })); // composed：shadow DOM 里的输入框（SmartRecruiters）事件要传出去
    }
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    el.blur();
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  }

  async function waitFor(fn, timeout = 5000, interval = 150) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(interval);
    }
    return null;
  }

  function cleanLabel(s) {
    return String(s || '').replace(/SVGs? (are )?not supported by this browser\.?/gi, '').replace(/[*✱]/g, '').replace(/\b(required|select one)\b/gi, '').replace(/press (return|enter)( or tab)? to continue\.?/gi, '').replace(/\(\s*\)/g, '').replace(/\s+/g, ' ').trim();
  }

  const SR_ONLY = '.sr-only, .visually-hidden, .screen-reader-text, .screen-reader-only';
  function labelText(el) {
    if (!q(SR_ONLY, el)) return textOf(el);
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let s = '';
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const p = n.parentElement;
      if (p && !p.closest(SR_ONLY) && isVisible(p)) s += ' ' + n.nodeValue;
    }
    return s.replace(/\s+/g, ' ').trim() || textOf(el);
  }

  function precedingEl(el, skip) {
    let node = el;
    for (let depth = 0; depth < 7 && node && node !== document.body; depth++) {
      let sib = node.previousElementSibling;
      for (let k = 0; k < 3 && sib; k++, sib = sib.previousElementSibling) {
        if (sib.matches('script, style, template, noscript')) { k--; continue; } // 页面脚本的文字不是题目（JazzHR 读成了「window.resumeRequired = true」）
        if (sib.matches('input, select, textarea, button') || q('input, select, textarea', sib)) break;
        const t = labelText(sib);
        if (t && t.length <= 400 && !(skip && skip.test(cleanLabel(t)))) return { el: sib, text: t };
      }
      node = node.parentElement;
    }
    return null;
  }
  function precedingText(el, skip) {
    const r = precedingEl(el, skip);
    return r ? r.text : '';
  }

  const GENERIC_Q_RE = /^(please )?(select|choose|make a selection)?( one)?( of)?( the)? ?(options?|selection)?$|^please of the options?$|^(please )?(select|choose) (one|an option)$/i;
  function questionFor(el) {
    if (isSR() && shadowHost(el)) {
      const hl = hostAttr(el, 'label'); if (hl) return cleanLabel(hl);
      if ((el.type === 'checkbox' || el.type === 'radio') && textOf(shadowHost(el))) return cleanLabel(textOf(shadowHost(el)));
      const sp = srHostLabel(shadowHost(el)); if (sp) return sp; // 问卷文字题：spl-input 插槽里的 span（「Name (Signature Field):」）
    }
    const afi = el.closest && el.closest('.ant-form-item');
    if (afi) {
      const al = q('.ant-form-item-label label, .ant-form-item-label', afi);
      if (al && textOf(al)) return cleanLabel(textOf(al));
    }
    if (/(^|\.)lever\.co$/.test(location.hostname)) {
      const li = el.closest('li.application-question, .application-question');
      const lb = li && q('.application-label', li);
      const choice = el.type === 'radio' || el.type === 'checkbox'; // 选项自己的 label 是选项文字，题目还是 .application-label
      if (lb && textOf(lb) && (choice || !(el.labels && el.labels.length && textOf(el.labels[0]).length > 3))) return cleanLabel(textOf(lb).replace(/✱/g, ''));
    }
    const afe = el.closest && el.closest('.ashby-application-form-field-entry');
    if (afe) {
      const t = q('.ashby-application-form-question-title, label', afe);
      if (t && textOf(t) && t !== el.closest('label')) return cleanLabel(textOf(t));
    }
    if (location.hostname === 'docs.google.com') {
      const li = el.closest('[role="listitem"]');
      const hd = li && q('[role="heading"]', li);
      if (hd && textOf(hd)) return cleanLabel(textOf(hd));
    }
    const isChoice = el.type === 'radio' || el.type === 'checkbox' || isAriaChoice(el);
    const cands = [];
    if (!isChoice && el.labels && el.labels[0] && textOf(el.labels[0])) cands.push(textOf(el.labels[0]));
    const ownAria = el.getAttribute('aria-label') || '';
    if (!isChoice && !(el.labels && el.labels.length) && ownAria && !el.closest('[data-automation-id^="formField"]')
      && !/^[-—–\s]*type to search/i.test(ownAria) && !DATE_PART_RE.test(cleanLabel(ownAria))) cands.push(ownAria);
    const fs = el.closest('fieldset');
    if (fs) cands.push(textOf(q('legend', fs)));
    const ff = el.closest('[data-automation-id^="formField"]');
    if (ff) {
      for (const l of qa('label, legend', ff)) {
        if (isChoice && (l.htmlFor === el.id || l.contains(el))) continue;
        const target = l.htmlFor && document.getElementById(l.htmlFor);
        if (isChoice && target && (target.type === 'radio' || target.type === 'checkbox')) continue;
        const t = textOf(l);
        if (t) { cands.push(t); break; }
      }
    }
    if (!isChoice) {
      if (el.labels && el.labels[0]) cands.push(textOf(el.labels[0]));
      const lb = el.getAttribute('aria-labelledby');
      if (lb) cands.push(lb.split(/\s+/).map((id) => textOf(document.getElementById(id))).join(' '));
      cands.push(el.getAttribute('aria-label'));
    } else {
      const grp = el.closest('[role="radiogroup"], [role="group"]');
      const lb = grp && grp.getAttribute('aria-labelledby');
      if (lb) cands.push(lb.split(/\s+/).map((id) => textOf(document.getElementById(id))).join(' '));
      if (grp) cands.push(grp.getAttribute('aria-label'));
      const fg = el.closest('.form-group');
      const cl = fg && qa('label', fg).find((l) => !l.contains(el) && !q('input[type="radio"], input[type="checkbox"]', l)
        && !(l.htmlFor && /^(radio|checkbox)$/.test((document.getElementById(l.htmlFor) || {}).type || '')) && textOf(l));
      if (cl) cands.push(textOf(cl));
    }
    const found = cands.find((c) => c && c.trim());
    if (found && GENERIC_Q_RE.test(cleanLabel(found))) {
      const row = el.closest('tr');
      const prev = row && row.previousElementSibling && cleanLabel(textOf(row.previousElementSibling));
      const alt = prev && !GENERIC_Q_RE.test(prev) ? prev : cleanLabel(precedingText(row || el.parentElement || el));
      if (alt && !GENERIC_Q_RE.test(alt)) return alt;
    }
    if (found) return cleanLabel(found);
    if (isChoice && el.parentElement && qa('input', el.parentElement).length === 1) {
      const prev = el.parentElement.previousElementSibling;
      const pt = prev && !prev.matches('script, style') && !q('input, select, textarea', prev) ? textOf(prev) : '';
      if (pt && pt.length <= 400 && !GENERIC_Q_RE.test(cleanLabel(pt))) return cleanLabel(pt);
    }
    const fi = !isChoice && el.closest('.el-form-item');
    const anchor = isChoice ? (el.closest('[role="radiogroup"], [role="group"]') || el.parentElement?.parentElement || el) : (fi || el);
    const pe = precedingEl(anchor);
    if (pe && !isChoice && el.getAttribute('placeholder')) {
      const block = pe.el.nextElementSibling;
      const others = block ? qa('input:not([type="hidden"]), textarea, select', block).filter((x) => x !== el && isVisible(x)) : [];
      if (others.length) return cleanLabel(pe.text + ' ' + el.getAttribute('placeholder'));
    }
    return cleanLabel((pe && pe.text) || el.getAttribute('placeholder') || '');
  }

  const ASHBY_YESNO = '[class*="_yesno_"]';
  const isAshbyYesNo = (el) => el.tagName === 'BUTTON' && !!el.closest(ASHBY_YESNO) && /^(yes|no)$/i.test(textOf(el));
  const isPillButton = (el) => isAshbyYesNo(el) || (el.tagName === 'BUTTON' && !el.getAttribute('role') && el.type !== 'submit'
    && (/(^|\s)cx-select-pill-section(\s|$)/i.test(el.className) || (/(^|[\s_-])pill([\s_-]|$)/i.test(el.className) && !/(^|[\s_-])btn([\s_-]|$)/i.test(el.className))));
  const isAriaChoice = (el) => (el.tagName !== 'INPUT' && /^(radio|checkbox|menuitemradio|switch)$/.test(el.getAttribute('role') || '')) || isPillButton(el);
  const choiceWrapOn = (el) => { const w = el.parentElement && el.parentElement.closest('[role="radio"], [role="checkbox"]'); return !!w && w.getAttribute('aria-checked') === 'true'; };
  const liveChoice = (el) => {
    if (el.isConnected || el.tagName !== 'INPUT' || !el.name) return el;
    const root = el.getRootNode && el.getRootNode() !== el ? el.getRootNode() : document;
    return (root.querySelector ? root : document).querySelector(`input[name="${CSS.escape(el.name)}"][value="${CSS.escape(el.value)}"]`)
      || document.querySelector(`input[name="${CSS.escape(el.name)}"][value="${CSS.escape(el.value)}"]`) || el;
  };
  const isChecked = (el0) => { const el = liveChoice(el0); return el.tagName === 'INPUT' ? el.checked || choiceWrapOn(el) : ['aria-checked', 'aria-pressed', 'aria-selected'].some((a) => el.getAttribute(a) === 'true'); };

  function choiceLabel(el) {
    if (el.tagName === 'SPL-RADIO') return el.getAttribute('label') || textOf(el);
    if (isSR() && shadowHost(el)) { const own = el.labels && el.labels[0] ? textOf(el.labels[0]) : ''; const ht = textOf(shadowHost(el)); if (ht && cleanLabel(own).replace(/[*\s]/g, '').length < 2) return ht; }
    if (isAriaChoice(el)) return el.getAttribute('aria-label') || textOf(el);
    if (el.labels && el.labels[0]) return textOf(el.labels[0]);
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    return textOf(el.parentElement);
  }

  function precedingHeading(el) {
    let best = '';
    for (const h of qa('h2, h3, h4, h5, [role="heading"]')) {
      if (h.contains(el) || h.closest('#wdaf-host') || !isVisible(h)) continue;
      if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) best = textOf(h);
    }
    return best;
  }

  function formScope() {
    return q('[data-automation-id="applyFlowPage"]') || document.body;
  }


  const TEXT = ['text'];
  const TEXTISH = ['text', 'prompt', 'combo'];
  const PICK = ['listbox', 'prompt', 'select', 'combo', 'popcombo'];
  const SUBSCRIBE_RE = /job posting notifications|notify me of new|new (job )?(opportunities|positions|postings)|job alerts?|newsletter|talent (community|network|pool)|marketing (communications|emails?)|hear more about career|subscribe|recruiting updates/;
  const CRED_RE = /^(login|log-?in( id| name| email)?|user ?name|user ?id|create (a )?login|password|confirm password|re-?enter password)\b/i;
  const TOOL_KINDS = [...PICK, 'radio', 'checkgroup', 'text']; // 「用过哪些编程工具」：多选框组、下拉、文本框都可能
  const SOURCE_RE = /how did you (hear|learn|find|come across)|where did you (hear|learn|find|see)|^source\b|referral source|recruiting source|candidate source/;
  const SMS_OK_RE = /^(?!.*(marketing|promotional|newsletter|talent (community|network|pool)|job alerts?)).*(select ['"“]?yes['"”]? to opt-?in|opt-?in or ['"“]?no['"”]? to opt-?out|^text consent|consent to (receive )?(text|sms|automated call)|(receive|get) (communications?|messages?|notifications?|updates?|texts?|alerts?) (via|by|through|over) (sms|text|whatsapp)|\b(sms|whatsapp)\b.{0,60}(communications?|messages?|notifications?|updates?|alerts?|opt-?in|consent))/;
  const RULES = [
    { re: /^(phone )?extension$|phone extension|^ext\.?$/, key: null },
    { re: /interested in hearing about (new |other |future )?(opportunit|position|job)|weekly email|job alerts?|subscribe|newsletter|talent (community|network|pool)|notify me of new/, key: null },
    { re: CRED_RE, key: null },
    { re: SMS_OK_RE, key: 'smsConsent', kinds: [...PICK, 'radio'] },
    { re: SMS_OK_RE, key: 'smsTerms', kinds: ['checkbox'] },
    { re: /country.{0,25}citizenship|citizenship.{0,20}country|which country.{0,30}citizen|^(country of |your )?(citizenship|nationality)\??$/, key: 'citizenship', kinds: [...PICK, 'text'] },
    { re: /country phone code|phone country|country code/, key: 'country', kinds: PICK },
    { re: /country (do|did) you (currently )?(live|reside)|country of residence|current country|which country|country are you (applying|located|based) (from|in)/, key: 'country', kinds: PICK },
    { re: /phone device type|phone type|device type/, key: 'phoneType', kinds: PICK },
    { re: /\bphone\b|mobile number|\bcell\b/, key: 'phone', kinds: TEXT, self: true },
    { re: /e-?mail/, key: 'email', kinds: TEXT, self: true },
    { re: /preferred (first |given )?name|nickname|name (do )?you (prefer|go by)|(would like to be|prefer to be) called/, key: 'preferredName', kinds: TEXT },
    { re: /i (have|use) a preferred name|use (a |my )?preferred name/, key: 'preferredNameBox', kinds: ['checkbox'] },
    { re: /preferred (first |last |given |family )?name|nickname|local (given|family) name/, key: null },
    { re: /additional information that (could|would|might) be helpful|we don'?t need a cover letter|use the space below to tell us|anything else (you'?d like|we should know)/, key: null, kinds: TEXT },
    { re: /name.{0,40}(native language|native script|original script|local language|chinese characters|in chinese)|native[- ]language name|name in (your )?native/, key: 'nativeName', kinds: TEXT },
    { re: /^i (hereby )?(certify|attest|affirm|declare)\b.{0,400}\b(true|accurate|complete|correct)\b/, key: 'SIGN_DATE', kinds: TEXT },
    { re: /applicant certification|certification and acknowledg|by (typing|entering) (your|my) (full |legal )?name|type your (full |legal )?name (below|here|to)|electronic(ally)? sign/, key: 'FULLNAME', kinds: TEXT },
    { re: /middle name/, key: 'middleName', kinds: TEXT, self: true },
    { re: /first name|given name/, key: 'firstName', kinds: TEXT, self: true },
    { re: /second (last name|surname|family name)|maternal (last name|surname)|apellido/, key: null },
    { re: /last name|family name|surname/, key: 'lastName', kinds: TEXT, self: true },
    { re: /address line 1|^address$|^street\b|street (address|name|line)|address.{0,10}\bstreet\b/, key: 'address1Combo', kinds: ['combo'], self: true },
    { re: /address (line )?2\b|^(apt|apartment|suite|unit)\b/, key: 'address2', kinds: TEXT, self: true },
    { re: /address (line )?1\b|^address:?$|^street\b|street (address|name|line)|address.{0,10}\bstreet\b/, key: 'address1', kinds: TEXT, self: true },
    { re: /^location( \(city\))?$|^current (city|location)|city of residence|where are you (currently )?(located|based)/, key: 'cityLoc', kinds: [...PICK, 'text'], self: true },
    { re: /^city|\btown\b/, key: 'city', kinds: [...TEXT, 'combo'], self: true },
    { re: /postal|\bzip\b/, key: 'postalCode', kinds: [...TEXT, 'combo'], self: true },
    { re: /^(state|province|region|administrative area)/, key: 'state', kinds: [...PICK, 'text'], self: true }, // Paylocity 地址栏叫「Administrative Area」
    { re: /^country/, key: 'country', kinds: [...PICK, 'text'], first: true, self: true },
    { re: /sponsorship needs|what (type|kind) of (visa |work )?(sponsorship|authori[sz]ation)|(current|your) (immigration|visa) (status|type|category)|describe your (visa|immigration|sponsorship)/, key: null, kinds: TEXT },
    { re: /(first )?hear(d)? (about|of) (this|the) (job|position|role|opening|opportunity) online|^did you .{0,40}\bonline\b/, key: 'YES', kinds: [...PICK, 'radio'] },
    { re: /reason(s|\(s\))? for leaving (any|your|each|the|previous|prior|recent)\b|explain .{0,30}reason(s|\(s\))? for leaving/, key: 'leavingReasons', kinds: TEXT },
    { re: SOURCE_RE, key: 'source' },
    { re: /^(career communi\w*|job boards?)\b|which (job board|website|site)\b/, key: 'source', kinds: [...PICK, 'radio'] },
    { re: /stem\s*\/?\s*opt|24[- ]month (opt )?extension/, key: 'stemOpt', kinds: [...PICK, 'radio'] },
    { re: /(currently|presently|now) (being )?sponsored|sponsored by (another|a different|your current|a current|an?) (company|employer)|(current|existing) (employer )?sponsorship (from|by|with)/, key: 'currentlySponsored', kinds: [...PICK, 'radio'] },
    { re: /^(?!.*without).*\b(require|requires|need|needs)\b (\w+ ){0,3}(visa )?sponsor/, key: 'needSponsorship', kinds: [...PICK, 'radio', 'checkgroup'] },
    { re: /(hold|have) .{0,40}practical training|currently (hold|have|on) (an? )?opt\b|\bopt\b (status|ead) (currently|now)/, key: 'hasOPT', kinds: [...PICK, 'radio'] },
    { re: /used (any )?(portion|part) of .{0,60}(optional practical training|\bopt\b)|(have|has) used (your |any )?(opt|optional practical training)\b/, key: 'hasOPT', kinds: [...PICK, 'radio'] },
    { re: /\bin f-?1 (status|visa)|(are|is) you (currently )?(on|in|holding) (an? )?f-?1\b/, key: 'f1Status', kinds: [...PICK, 'radio'] },
    { re: /\bstem\b.{0,40}(eligible|designated|classified|qualifying)|(major|degree|program)\b.{0,40}\bstem\b/, key: 'stemMajor', kinds: [...PICK, 'radio'] },
    { re: /(have|has) you (ever )?(held|had|been (in|granted)) (an? )?h-?1b\b|h-?1b (petition|status).{0,40}(approved|held|on your behalf)/, key: 'heldH1b', kinds: [...PICK, 'radio'] },
    { re: /\bi-?140\b|immigrant (visa )?petition/, key: 'i140', kinds: [...PICK, 'radio'] },
    { re: /(have|has) you (ever )?(held|had|been (in|on)) (an? )?j-?1\b/, key: 'heldJ1', kinds: [...PICK, 'radio'] },
    { re: /(require|need) (curricular|cpt)\b.{0,60}(authori[sz]ation|training)|curricular practi(cal|ce) training\b.{0,40}(authori[sz]ation|require|need)/, key: 'needCpt', kinds: [...PICK, 'radio'] },
    { re: /visa classification based on an agreement|\b(e-3|tn|h-1b1)\b.{0,60}visa|treaty (visa|country|investor|trader)/, key: 'treatyVisa' },
    { re: /depart the united states|foreign residency requirement|home(-country)? (physical )?residency requirement|two-year (home )?residency|212\(e\)/, key: 'homeResidency' },
    { re: /(will|do|would) you (\w+ ){0,6}(require|need)\b.{0,40}sponsor/, key: 'needSponsorship', kinds: [...PICK, 'radio', 'checkgroup'] },
    { re: /without (\w+ ){0,4}sponsor/, key: 'AUTH_NO_SPONSOR', kinds: [...PICK, 'radio', 'checkgroup'] },
    { re: /authori[sz]ed to work\b.{0,40}\b(indefinitely|permanently|for any employer|without (any )?restriction)|(indefinitely|permanently) (authori[sz]ed|eligible)|unrestricted (work )?(authori[sz]ation|right to work)|(authori[sz]ed|eligible|legally (able|permitted)|right) to work\b.{0,40}\bwithout (any )?(restrictions?|limitations?|time limit)/, key: 'AUTH_NO_SPONSOR', kinds: [...PICK, 'radio', 'checkgroup'] },
    { re: /authori[sz]ed to work|legally (authori[sz]ed|eligible|permitted|qualified)|eligib\w* to work|right to work|work authori[sz]ation|^work eligibility/, key: 'workAuthorized', kinds: [...PICK, 'radio', 'checkgroup'] },
    { re: /(current|your|present) .{0,30}(visa|immigration|work authori[sz]ation) (status|type|category)|^(us |u\.s\. )?(visa|immigration) (status|type|category)\b/, key: 'visaStatus', kinds: [...PICK, 'radio'] },
    { re: /sponsor|visa status|h-?1b/, key: 'needSponsorship', kinds: [...PICK, 'radio', 'checkgroup'] },
    { re: /\b(16|18) years|age of (16|18)|at least (16|18)|over (16|18)\b/, key: 'over18' }, // Hy-Vee 问的是「at least 16」
    { re: /undergrad\w*.{0,40}(gpa|grade point)|(gpa|grade point).{0,40}undergrad|bachelor'?s?\b.{0,30}(gpa|grade point)/, key: 'undergradGpa' },
    { re: /standardi[sz]ed test|which (standardi[sz]ed )?(test|exam)s? (have you|did you) take|test you have taken/, key: 'stdTest', kinds: [...PICK, 'radio', 'checkgroup'] },
    { re: /composite score|^(math|quant\w*|verbal|reading|writing|critical reasoning)( ?\/ ?[\w ]+)? score|\b(sat|act|gmat|gre) (total |composite )?(score|percentile)/, key: 'stdTestScore', kinds: [...PICK, 'radio'] },
    { re: /(end|graduation|completion) (date )?month|^to month/, key: 'eduEndMonthName', kinds: PICK },
    { re: /(end|graduation|completion) (date )?year|^to year/, key: 'eduEndYear', kinds: [...PICK, 'text'] },
    { re: /start (date )?month|^from month/, key: 'eduStartMonthName', kinds: PICK },
    { re: /start (date )?year|^from year/, key: 'eduStartYear', kinds: [...PICK, 'text'] },
    { re: /\b(?!(?:a|an|the|any|your|accredited|current|four-year|degree)\b)[a-z]+ university (undergraduate|graduate|student|program|alum)|\buniversity of [a-z]+( [a-z]+)?\b.{0,40}(student|program|enrolled|alum)|graduate[d]? from an? [a-z]+( [a-z]+)? high school/, key: 'otherSchool', kinds: [...PICK, 'radio'] },
    { re: /^degree status$|status of (your )?degree|degree (completion )?status/, key: 'degreeStatus', kinds: [...PICK, 'radio'] },
    { re: /degree (granted|conferred|awarded|completed)|have you (graduated|completed your degree)/, key: 'degreeGranted' },
    { re: /level of education you are (currently )?(completing|pursuing)|current level of education|(degree|education)( level)? (that )?(you are|you're) currently (pursuing|enrolled in|working (on|towards?)|completing|obtaining|seeking)/, key: 'degree', kinds: PICK },
    { re: /graduation (date|year|month|term|semester)|(expected|anticipated) (date of )?graduation|when (do|will) you (expect to )?graduate|expect(ed|ing)? to graduate|graduat\w* (date|year)/, key: 'gradDate', kinds: [...PICK, 'text'] },
    { re: /^(?!.*(highest|complet|attain|obtain)).*((degree|education)\b.{0,30}pursu|(education|degree|academic) level|level of (education|degree|study)|degree type|class standing|year in school|year of study)/, key: 'degree', kinds: PICK },
    { re: /(school|university|college|institution)\b.{0,60}\bundergrad(uate)? (studies|degree|education)|undergrad(uate)? (school|university|college|institution)/, key: 'undergradSchool', kinds: [...PICK, 'text'] },
    { re: /undergrad\w*.{0,30}(major|discipline|field|area of study|concentration)|(major|discipline|field of study|area of study).{0,30}undergrad|bachelor'?s?( degree)?.{0,20}(major|discipline|field of study)/, key: 'undergradMajor' },
    { re: /(list|name|enter|provide|what is|which)( the| your)? (name of (the |your )?)?(university|college|school|institution)( you are| you're)? (currently )?(attend|enrolled|studying)|(university|college|school) you are currently attending/, key: 'school', kinds: TEXTISH },
    { re: /^name of (your )?(current )?(school|university|college|institution)$|^(current )?(school|university|college) name$/, key: 'school', kinds: [...TEXTISH, ...PICK] },
    { re: /class standing|year in school|academic (standing|level|year)/, key: 'classStanding', kinds: TEXT },
    { re: /^(where|at which (school|university|college|institution)|which (school|university|college|institution)) (are|do) you (currently )?(pursu|attend|stud|enrol)/, key: 'school', kinds: TEXTISH },
    { re: /^(what|which) (college|university|school|institution)( ?(or|\/) ?(college|university|school))? (are|do|will) you (currently |now )?(attend|enrol|stud|pursu)/, key: 'school', kinds: [...TEXTISH, ...PICK] }, // D.A. Davidson「What College/University are you currently attending?」是下拉
    { re: /total military experience|years of (military|active duty) (service|experience)|how (long|many years) (have|did) you serve/, key: 'militaryYears', kinds: [...PICK, 'radio'] },
    { re: /total (relevant )?(professional|work)( or military)? experience|years of (relevant )?(professional|work|full[- ]time) experience/, key: 'yearsExp', kinds: [...PICK, 'radio'] },
    { re: /currently (enrolled|pursuing|a student|attending)|current(ly)? (a )?student|enrolled (in|as)|return(ing)? to (school|your studies|university|college)|still (be )?(in school|a student)/, key: 'enrolled' },
    { re: /willing to relocate|open to relocat|able to relocate|willingness to relocate|consider relocat/, key: 'relocate' },
    { re: /conflicts? of interest|outside business activit|familial relationship|investment .{0,60}(greater than|more than|over) \d+ ?%|intellectual property ownership/, key: 'conflictOfInterest' },
    { re: /government official|civil service|public office|politically exposed/, key: 'govOfficial' },
    { re: /were you referred|referred (to this (position|role|job) )?by/, key: 'referredBy' },
    { re: /how (do )?you (currently )?use ai|describes how you use ai|use of (generative )?ai tools/, key: 'aiUsage' },
    { re: /non-?compet|non-?solicit|restrictive covenant/, key: 'nonCompete' },
    { re: /(are|were) you (currently )?(a |an )?member of|membership (in|of|with)|member of (the |any )?.{0,60}(organi[sz]ation|society|association|club|fraternity|sorority|chapter)/, key: 'pastParticipation', kinds: PICK.concat('radio') },
    { re: /^(?!.*(degree|graduat|bachelor|master|diploma|course|certif|licen)).*have you (ever )?(already )?(completed|participated in|attended|taken part in|done|finished|been part of|enrolled in) .{0,80}(simulation|forage|virtual (experience|internship)|program|programme|event|workshop|insight|webinar|challenge|competition|case study|academy|bootcamp|assessment)/, key: 'pastParticipation', kinds: PICK.concat('radio') },
    { re: /(currently work|worked|been employed)\b.{0,60}(one of the following|any of the following|following (organi[sz]ations|companies|firms|employers))/, key: 'listedEmployer', kinds: [...PICK, 'radio', 'checkgroup'] },
    { re: /currently (an? )?(employee|employed|working|contractor|consultant|temp\w*)\b.{0,40}\b(of|at|by|with|for)\b|contractor (performing|providing) services|(are|were) you (a |an )?contractor (for|at|with|to)/, key: 'previousWorker' },
    { re: /^(?!.*\breferences?\b)(.*)(previously (been )?(an? )?(employed|employee|worked)|former(ly)? (an )?employ|current or former|ever (been )?(employed|worked)|worked (for|at) .{0,60}(before|previously|in the past))/, key: 'previousWorker' },
    { re: /employees? .{0,80}(acquainted|you know|know personally)|know anyone (who )?(works|working|employed)/, key: 'acquaintances' },
    { re: /(previously|ever|before) (applied|submitted an application)|applied (to|for|with) .{0,60}(before|previously|in the past)|engaged in (the|a|any) recruit\w* process|interviewed for (a|any) (position|role)|spoken (to|with) anyone about a role/, key: 'previouslyApplied' },
    { re: /actively interviewing|interviewing (with|for) other|(received|have|hold) (an |any )?(other |competing |outstanding )?(job |internship )?offers?\b|competing offers?|offer (deadline|expiration)/, key: 'otherOffers' },
    { re: /recruiting (timelines?|deadlines?)|(timelines?|deadlines?) (we|that we) should (be aware|know)|other (interview|recruiting) (processes|timelines?|deadlines?)|any (upcoming )?(offer )?deadlines?/, key: 'recruitingTimelines' },
    { re: /^(your )?home ?town\b|where (are you|did you grow up) from|where did you grow up|city of origin|(what|where) is your home ?town\b/, key: 'hometown', kinds: [...TEXT, ...PICK] }, // 「What is your hometown or permanent city and state」
    { re: /(year|when) did you graduate (from )?high school|high school (graduation|grad) (year|date)|year of high school graduation/, key: 'hsGradYear' },
    { re: /(month and year|when|what date) .{0,40}\b(cpa eligible|eligible (to sit )?for the cpa|sit for the cpa)/, key: 'cpaEligibleDate', kinds: [...TEXT, ...PICK] },
    { re: /meet (the )?(educational|education) requirements? .{0,40}\b(sit|sitting) for the cpa|eligible to sit for the cpa|\bcpa (exam )?eligib/, key: 'cpaEligible', kinds: [...TEXT, ...PICK, 'radio'] },
    { re: /cpa eligibility (through|via|by)|meet(ing)? (the )?cpa (eligibility|licensure|education)|cpa (licensure |license )?pathway|150[- ]credit/, key: 'cpaPathway', kinds: [...TEXT, ...PICK, 'radio'] },
    { re: /essential functions/, key: 'essentialFunctions' },
    { re: /availability for interview|interview availability|(available|availability) (to|for) interview|times? (are you|you are) (available|free) (to|for) (an? )?interview/, key: 'interviewAvailability', kinds: TEXT },
    { re: /(internship|program|programme|co-?op|role|position) (is|runs|will run|takes place|lasts) (from|between) .{0,60}\b(to|through|thru|until|and)\b.{0,90}\bavailab|availab\w* (for|during|to work|to participate in) (the )?(entire|full|whole|complete) (duration|length|internship|program|programme|summer|period|\d+[- ]weeks?)|availab\w* (for|during) (these|the (internship|program|programme)) dates/, key: 'internshipDates' },
    { re: /how many hours .{0,60}\b(follow|following|watch|watching|read|reading|track|tracking|spend)\b.{0,40}\bmarkets?\b|hours (per|a|each) (day|week) .{0,60}\b(follow|following|watching|tracking)\b.{0,30}\bmarkets?\b/, key: 'marketHours' },
    { re: /favou?rite (book|read)s?\b.{0,60}(financ|market|invest|trading|econom)|\bbooks? (related to|about|on) (the )?(financial )?(markets?|investing|trading)/, key: 'favoriteMarketBook', kinds: TEXT },
    { re: /date of birth|birth ?date|\bd\.?o\.?b\.?\b|when were you born/, key: 'dob', kinds: [...TEXT, 'date'], self: true },
    { re: /(include|provide|list|enter)\b.{0,60}\b(professional )?references\b|references?\b.{0,40}\b(name|contact information)/, key: 'REFS_TEXT', kinds: TEXT },
    { re: /\b(are you|currently) (currently )?(completing|pursuing|enrolled in|working (on|towards?)|earning|studying for) (a |an |your )?(bachelor|undergraduate|undergrad\b|b\.?a\.?\/b\.?s)/, key: 'pursuingBachelor', kinds: ['radio', 'checkgroup', 'select', 'listbox', 'combo', 'popcombo'] },
    { re: /(include|provide|list|enter)\b.{0,60}\b(professional )?references\b|references?\b.{0,40}\b(name|contact information)|(willing|able) to provide\b.{0,30}\breferences/, key: 'YES', kinds: ['radio', 'select', 'listbox', 'combo', 'popcombo'] },
    { re: /^(?!.*\b(obtain|eligib\w*|able to|willing|get|apply for|qualify|sponsor)\b).*(security clearance|\bclearances?( ?\(s\))?$|clearance (level|status|type)|(active|current|hold|held|possess|have)\b.{0,40}\bclearance)/, key: 'securityClearance' },
    { re: /first[- ]?gen(eration)? professional|first (person )?in (my|your) family to (work|have a) (in )?(a )?(professional|corporate|white[- ]collar)/, key: 'firstGenProfessional', kinds: [...PICK, 'radio', 'checkgroup'] },
    { re: /first[- ]?gen(eration)? (college|university|student|graduate)|first (person )?in (my|your) family to (attend|graduate|go to)/, key: 'firstGen', kinds: [...PICK, 'radio', 'checkgroup'] },
    { re: /month (you|you'?ll) (will )?(be able to|can|could|are able to|plan to) (start|begin)|start(ing)? month|month .{0,25}(start|begin) (your |the )?internship/, key: 'startMonth', kinds: [...PICK, 'radio'] },
    { re: /(may|can) we contact (your )?(current|present) employer|contact (your )?(current|present) employer/, key: 'contactCurrentEmployer', kinds: [...PICK, 'radio'] },
    { re: /(do you (currently )?have|have you (already )?(secured|arranged|made|found)|already (have|secured)) (\w+ ){0,2}(housing|accommodation|a place to (live|stay))/, key: 'NO' }, // 文字框也答（Consigli「Do you have housing in the area where you are applying?」）
    { re: /(reliable|own|dependable) (means of )?transportation|transportation to (and from )?(the )?(office|job ?site|work)/, key: 'YES' },
    { re: /(willing|able|plan|prepared) to (arrange|secure|find|provide|cover) (for )?(your |my )?own (housing|accommodation|lodging)|responsible for (your |my )?own (housing|accommodation|lodging)/, key: 'YES', kinds: [...PICK, 'radio'] },
    { re: /(willing|agree|consent|able|prepared) to (submit to|undergo|complete|pass|take|participate in)( a| an| the)?( pre-?employment| standard)? (background|criminal|drug|credit)|(background (check|screen\w*|investigation)|drug (test|screen\w*)).{0,40}\b(willing|agree|consent)\b/, key: 'YES', kinds: [...PICK, 'radio'] },
    { re: /meet (all (of )?)?the (minimum|basic|required|stated) (qualifications|requirements)|minimum qualifications/, key: 'essentialFunctions' }, // 是否满足最低任职要求
    { re: /driv(ing|er'?s|ers) licen[cs]e|valid licen[cs]e to drive/, key: 'driversLicense' },
    { re: /highest degree.{0,30}in progress|(achieved|completed|obtained) or in progress/, key: 'degree' },
    { re: /highest (level of )?(education|degree)|highest degree/, key: 'highestCompleted' },
    { re: /exclu\w* .{0,140}(health ?care program|medicare|medicaid)|(medicare|medicaid|federal health ?care).{0,80}(exclu|debar|suspen|sanction)|\boig\b.{0,40}exclu|exclusion list|\bdebarred\b|suspended,? (or )?excluded/, key: 'healthcareExclusion', kinds: [...PICK, 'radio'] },
    { re: /\b(sec|cftc|finra|msrb|nfa)\b|securities and exchange commission|commodity futures|self-regulatory organization|municipal securities rulemaking|advisory affiliate|broker-?dealer|investment-related|subject of any (investigation|proceeding)|surety (company|bond)|refused a bond|bond (was )?(denied|revoked|paid out)|enjoined|injunction/, key: 'regulatoryNo', kinds: [...PICK, 'radio'] },
    { re: /political (contribution|action committee)|\bpac\b|eligible to vote for the candidate|solicit(ed)? (any )?(contribution|payment)s? (for|to) (an? )?(official|candidate)/, key: 'politicalNo', kinds: [...PICK, 'radio'] },
    { re: /convicted|pled guilty|plead(ed)? guilty|nolo contendere|no contest|criminal (record|offense|conviction|history)|felony|misdemeanor/, key: 'criminalRecord', kinds: [...PICK, 'radio'] },
    { re: /(presently|currently|ever( been)?) licensed in the (insurance|securities)|(hold|have) (any |an? )?(securities|insurance|finra) licen|finra licen|series \d+ licen/, key: 'securitiesLicense', kinds: [...PICK, 'radio'] },
    { re: /bonding company|bond (for you|denied|revoked)|been bonded|denied a bond/, key: 'bondDenied', kinds: [...PICK, 'radio'] },
    { re: /(unsatisfied|outstanding) (judg|lien)|judg(e)?ments? or liens|liens? against you/, key: 'judgments', kinds: [...PICK, 'radio'] },
    { re: /relatives?\b|family (or friends?|members?)|friends? or family|related to (an? |any |the )?(current |former |existing )?(employee|staff|associate|director|officer|partner|member|anyone|someone|person|individual)|close personal relationship/, key: 'relatives' },
    { re: /(salary|pay|compensation|wage)s? (or|\/) (hourly|pay rate|rate)|salary or hourly|annual or hourly/, key: 'salaryEither', kinds: TEXT },
    { re: /hourly (pay )?(rate|wage)|pay rate per hour|rate per hour|hourly (compensation|expectation)/, key: 'salaryHourlyOnly', kinds: TEXT },
    { re: /desired (total |annual |base )?(salary|pay|compensation)|salary (expectation|requirement)s?|expected (salary|compensation|pay)|compensation expectation|base compensation|(salary|pay|compensation) (are you )?(expect|looking for|requirement)|what are your (salary|pay|compensation)/, key: 'salary', kinds: TEXT },
    { re: /linkedin/, key: 'linkedin', kinds: TEXT, self: true },
    { re: /github/, key: 'github', kinds: TEXT, self: true },
    { re: /website|portfolio|personal url/, key: 'website', kinds: TEXT, self: true },
    { re: /location of (the )?(institution|school|university|college)|(institution|school|university|college) location/, key: 'schoolLocation', kinds: TEXTISH },
    { re: /^(?!.*\blocation\b).*(school|university|college|institution)/, key: 'school', kinds: [...TEXTISH, 'popcombo'] }, // Jane Street 的学校是 role=button 自制下拉
    { re: /^degree(?!.*(major|field|discipline|subject|concentration|area|granted|conferred|awarded))|degree (type|level|obtained|earned)/, key: 'degree' },
    { re: /gpa|grade point|overall result/, key: 'gpa', kinds: [...TEXT, ...PICK] },
    { re: /languages? (fluency|proficiency)|languages? .{0,60}(fluen|business-level|proficien)|which languages/, key: 'languageList', kinds: [...PICK, 'checkgroup'] },
    { re: /(come|work) (in|into|from) (the |our )?office|in[- ]office .{0,30}days|\d(-|–| to )\d days (per|a) week|days (per|a) week .{0,40}office/, key: 'inOffice' },
    { re: /earliest (availability|start|date)|availab\w* to (start|begin)|^start date$|when (can|could) you start|desired start date|how soon (are you|can you|could you|would you be) (available|able) to start/, key: 'availableStart', kinds: [...TEXT, 'date'] },
    { re: /^(second|2nd|additional|double|secondary) (major|field of study)|^minor\b/, key: null }, // Jane Street：Secondary Major / Field of study
    { re: /^(?!.*\bgpa\b)(?!.*(disabilit|major life|chronic|impairment)).*(field of study|\bmajor\b|discipline|area of study)/, key: 'fieldOfStudy' },
    { re: /(programming|software|statistical|coding) (tools?|languages?|packages?|software)\b.{0,160}\b(outside|beyond|independent|internship|thesis|research assistant|work experience|professional)/, key: 'toolsWork', kinds: TOOL_KINDS },
    { re: /(programming|software|statistical|coding) (tools?|languages?|packages?|software)\b.{0,160}\b(coursework|course ?work|classroom|class(es)? assignments?|courses?\b|academic)/, key: 'toolsCoursework', kinds: TOOL_KINDS },
    { re: /which (programming|software|statistical|coding) (tools?|languages?|packages?)|(programming|software|coding) (tools?|languages?)\b.{0,60}(used|familiar|proficien|experience|know|comfortable)/, key: 'toolsAll', kinds: TOOL_KINDS },
    { re: /^skills?$|^type to add skills/, key: 'skills', kinds: ['prompt'] },
    { re: /pronoun/, key: 'pronouns', kinds: PICK },
    { re: /^(what is your )?gender\b/, key: 'gender' },
    { re: /^(are you|do you (identify|consider yourself) as)( a)? (hispanic|latino)|^(?!.*(\brace\b|ethnic)).*(hispanic|latino)/, key: 'hispanic' },
    { re: /\braces?\b|ethnicity|ethnic/, key: 'ethnicity' }, // 「Select the races you identify with」（Navy Federal）是复数
    { re: /sexual orientation/, key: 'sexualOrientation' },
    { re: /transgender/, key: 'transgender', kinds: [...PICK, 'radio'] },
    { re: /transgender/, key: 'transgender' }, // 资料里没有答案 -> 标红让你答一次，之后记住
    { re: /gender|^sex$/, key: 'gender' },
    { re: /(military|armed forces|service ?members?).{0,80}spouses?|disclose your (military|veteran|service) status/, key: 'NONE_ABOVE', kinds: ['checkgroup', 'radio', ...PICK] },
    { re: /military spouse|spouse .{0,40}(military|armed forces|service ?member)/, key: 'militarySpouse' },
    { re: /veteran|military/, key: 'veteran' },
    { re: /interview.{0,120}\b(require|need|request)\b.{0,40}(travel|lodging|hotel|reimburse|assistance)|(travel|lodging) (assistance|reimbursement).{0,60}interview/, key: 'interviewTravelAssist', kinds: [...PICK, 'radio'] },
    { re: /(involuntarily )?(terminated|fired|dismissed|discharged|let go|suspended)\b.{0,30}\b(from|by) (any |a |your )?(previous |prior |past |former )?(employ|job|position|employer|work)|asked to resign|resign in lieu of/, key: 'everTerminated', kinds: [...PICK, 'radio'] },
    { re: /(planned|plan to take|anticipate|scheduled) .{0,30}(time off|vacation|leave|absence)|time off .{0,40}(during|throughout) (the )?(\d+[- ]week )?(internship|program|summer)/, key: 'plannedTimeOff', kinds: [...PICK, 'radio'] },
    { re: /(starting|hourly|pay) rate .{0,60}(would you (consider|accept)|is (this|that) (acceptable|ok)|are you (ok|comfortable|willing))|(consider|accept) (this|the) (position|role|offer) at (this|the) (pay|rate|salary)/, key: 'acceptPostedPay', kinds: [...PICK, 'radio'] },
    { re: /^(in the (past|last) .{0,30}?,? )?(has|does|is|did|was|have) your spouse\b(?!\s*(,|or\b|and\b|\/))/, key: 'noSpouse', kinds: [...PICK, 'radio'] },
    { re: /(have|did) you .{0,40}(donat|contribut|made .{0,20}(contribution|donation)|volunteer).{0,100}(candidate|campaign|political|part(y|ies)|elected|official|public office|\bpac\b)/, key: 'politicalDonations', kinds: [...PICK, 'radio'] },
    { re: /(household|family) (member|person)?.{0,60}\b(board member|trustee|director|executive|officer)\b|person within your household/, key: 'householdBoard', kinds: [...PICK, 'radio'] },
    { re: /(confidential information|trade secrets?|proprietary information).{0,120}(employer|employment|position)/, key: 'confidentialInfo', kinds: [...PICK, 'radio'] },
    { re: /(require|need|request)\b.{0,30}(reasonable )?accommodation|reasonable accommodation.{0,80}(require|need|request)/, key: 'needAccommodation', kinds: [...PICK, 'radio'] },
    { re: /disabilit/, key: 'disability' },
    { re: /^(?!.*(marketing|recruiting updates|job (alerts?|opportunit)|new (job )?opportunit|\bsms\b|text messag|newsletter|promotional|talent (community|network|pool)|receive (emails|updates|communications))).*(terms|consent|i agree|acknowledg|certify|attest|i have read|\bi accept\b|privacy (statement|policy|notice))/, key: 'TERMS', kinds: ['checkbox'] }, // 「I accept thePrivacy statement」（ACT Group，链接贴着前面的字）
    { re: /^name$|^your name|full name|signature$/, key: 'FULLNAME', kinds: TEXT, self: true },
  ];

  function valueFor(key) {
    const P = S.profile;
    if (key === 'FULLNAME') return [P.firstName, P.lastName].filter(Boolean).join(' ');
    if (key === 'SIGN_DATE') { const d = new Date(); const nm = [P.firstName, P.lastName].filter(Boolean).join(' '); return nm ? `${nm}, ${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}` : ''; }
    if (key === 'YES') return 'Yes';
    if (key === 'pursuingBachelor') return /bachelor|undergrad/i.test(P.degree || '') ? 'Yes' : 'No';
    if (key === 'pronouns') return altsFor('pronouns')[0] || '';
    if (key === 'startMonth') return altsFor('startMonth')[0] || '';
    if (key === 'contactCurrentEmployer') return 'N/A';
    if (key === 'hsGradYear') return P.hsGradYear ? String(P.hsGradYear) : '';
    if (key === 'hometown') return P.hometown || '';
    if (key === 'cpaPathway') return P.cpaPathway || '';
    if (key === 'noSpouse') return P.hasSpouse === 'No' ? 'Not Applicable' : '';
    if (key === 'smsTerms') return P.smsConsent === 'Yes' && S.settings.acceptTerms ? 'CHECK' : '';
    if (key === 'visaStatus') return P.f1Status === 'Yes' ? 'F-1' : '';
    if (key === 'salaryHourlyOnly') return P.hourlyRate || '';
    if (key === 'salaryEither') return P.salary && P.hourlyRate ? `$${Number(String(P.salary).replace(/[^\d.]/g, '')).toLocaleString('en-US')} per year or $${P.hourlyRate} per hour` : P.salary || (P.hourlyRate ? `$${P.hourlyRate} per hour` : '');
    if (key === 'regulatoryNo') return P.criminalRecord === 'No' && P.securitiesLicense === 'No' ? 'No' : '';
    if (key === 'politicalNo') return /china|mainland/i.test(P.citizenship || '') ? 'No' : '';
    if (key === 'undergradSchool') return P.undergradSchool || '';
    if (key === 'recruitingTimelines') return P.otherOffers === 'No' ? 'No, I do not currently have any other interview processes or offer deadlines.' : '';
    if (key === 'classStanding') return /^master/i.test(P.degree || '') ? "Graduate student (Master's)" : /^(phd|doctor)/i.test(P.degree || '') ? 'Graduate student (PhD)' : '';
    if (key === 'degreeStatus') return P.enrolled === 'No' ? 'Graduated' : 'In Progress';
    if (key === 'leavingReasons') {
      return workJobs().filter((j) => j.reason).slice(0, 4).map((j) => `${j.company} (${j.title}, ${j.start}–${j.current ? 'present' : j.end}): ${j.reason}`).join(' ') || '';
    }
    if (key === 'address1' && P.address1 && !P.address2 && /,\s*(apt|apartment|unit|suite|ste|#)\b/i.test(P.address1)
      && qa('label').some((l) => isVisible(l) && /address (line )?2\b/i.test(textOf(l)))) return String(P.address1).split(/,\s*(?=(apt|apartment|unit|suite|ste|#)\b)/i)[0].trim();
    if (key === 'address1Combo') return String(P.address1 || '').split(/,\s*(?=(apt|apartment|unit|suite|ste|#)\b)/i)[0].trim();
    if (key === 'address2' && !P.address2) { const m = String(P.address1 || '').match(/,\s*((apt|apartment|unit|suite|ste|#)\b.*)$/i); return m ? m[1].trim() : ''; }
    if (key === 'NONE_ABOVE') return 'None of the above';
    if (key === 'NO') return 'No';
    if (key === 'TERMS') return S.settings.acceptTerms ? 'CHECK' : '';
    if (key === 'preferredNameBox') return P.preferredName && P.preferredOnlyIfRequired !== 'Yes' ? 'CHECK' : '';
    if (key === 'AUTH_NO_SPONSOR') return P.needSponsorship === 'Yes' ? 'No' : P.workAuthorized;
    if (key === 'skills') return P.skills ? P.skills.split(/[,，;；]/).map((s) => s.trim()).filter(Boolean) : '';
    if (key === 'toolsCoursework' || key === 'toolsWork' || key === 'toolsAll') {
      const list = (s) => String(s || '').split(/[,，;；]/).map((x) => x.trim()).filter(Boolean);
      const ls = (key === 'toolsAll' ? [...new Set([...list(P.toolsWork), ...list(P.toolsCoursework)])] : list(P[key]))
        .filter((t, _, arr) => arr.length === 1 || !/^none$/i.test(t));
      return ls.length ? ls : '';
    }
    if (key === 'gradDate') return gradDateCands()[0] || '';
    if (key === 'phone') return phoneDigits(P.phone);
    if (key === 'cityLoc') return [P.city, P.state].filter(Boolean).join(', ');
    if (key === 'eduEndMonthName') return monthCands(P.eduEndMonth)[0] || '';
    if (key === 'eduStartMonthName') return monthCands(P.eduStartMonth)[0] || '';
    if (key === 'degreeGranted') return P.enrolled === 'Yes' ? 'In Progress' : P.enrolled === 'No' ? 'Yes' : '';
    if (key === 'acquaintances') return 'No';
    if (key === 'highestCompleted') return highestCands()[0] || '';
    if (key === 'listedEmployer') return 'None of the above';
    if (key === 'languageList') {
      const ls = Object.entries(languageLevels()).filter(([, lv]) => ['native', 'fluent'].includes(lv)).map(([l]) => l.replace(/\b\w/g, (c) => c.toUpperCase()));
      return ls.length ? ls : '';
    }
    if (key === 'stdTest') return /^none/i.test(P.stdTest || '') ? 'None of the above' : P.stdTest || '';
    if (key === 'stdTestScore') return /^none/i.test(P.stdTest || '') ? 'Did not take any of these tests' : '';
    if (key === 'militaryYears') return 'None';
    if (key === 'yearsExp') return `${Math.round(fullTimeYears() * 10) / 10} years`;
    return P[key] || '';
  }

  function descLines(text) {
    const t = String(text || '').trim();
    if (!t || t.includes('\n') || t.length < 160) return t;
    let parts = t.split(/(?<=\.)\s+(?=[A-Z])/);
    if (parts.length < 2) parts = t.split(/(?<=;)\s+/);
    parts = parts.map((x) => x.trim().replace(/;$/, '.')).filter(Boolean);
    return parts.length > 1 ? parts.map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join('\n') : t;
  }

  function phoneDigits(s) {
    let d = String(s || '').replace(/\D/g, '');
    if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
    return d;
  }

  function fullTimeYears() {
    const ym = (s) => { const m = String(s || '').match(/(\d{1,2})\/(\d{4})/); return m ? Number(m[2]) * 12 + Number(m[1]) : null; };
    const now = new Date();
    let months = 0;
    for (const j of Array.isArray(S.profile.workHistory) ? S.profile.workHistory : []) {
      if (!j || /\bintern|trainee|co-?op\b/i.test(j.title || '')) continue;
      const a = ym(j.start);
      const b = j.current ? now.getFullYear() * 12 + now.getMonth() + 1 : ym(j.end);
      if (a && b && b >= a) months += b - a + 1;
    }
    return months / 12;
  }

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  function gradDateCands() {
    const m = Number(S.profile.eduEndMonth);
    const y = String(S.profile.eduEndYear || '').trim();
    if (!y) return [];
    const out = [];
    if (m >= 1 && m <= 12) {
      out.push(`${MONTHS[m - 1]} ${y}`, `${MONTHS[m - 1].slice(0, 3)} ${y}`, `${String(m).padStart(2, '0')}/${y}`, `${m}/${y}`);
      out.push(`${m <= 5 ? 'Spring' : m <= 8 ? 'Summer' : 'Fall'} ${y}`);
      if (m === 12 || m === 1) out.push(`Winter ${y}`);
    }
    out.push(y);
    return out;
  }

  function degreeCands() {
    const d = String(S.profile.degree || '').trim();
    if (!d) return [];
    if (/^master/i.test(d)) return ['Master of Science', 'Masters of Science', "Master's of Science", 'Master of Science (M.S.)', "Master's Degree", "Master's", 'M.S.', 'MS', 'Masters', d, 'Graduate'];
    if (/^bachelor/i.test(d)) return [d, 'Bachelor', 'Bachelors', "Bachelor's", 'Undergraduate'];
    if (/^(phd|ph\.d|doctor)/i.test(d)) return [d, 'PhD', 'Ph.D', 'Doctorate', 'Doctoral'];
    return [d];
  }

  function highestCands() {
    const d = String(S.profile.highestCompleted || '').trim();
    if (!d) return [];
    if (/^bachelor/i.test(d)) return ["Bachelor's Degree", "Bachelor's", 'Bachelor', 'Bachelors', 'Undergraduate'];
    if (/^master/i.test(d)) return ["Master's Degree", "Master's", 'Master', 'Masters', 'Graduate'];
    return [d];
  }

  const US_STATES = {
    alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
    'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
    kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
    mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
    'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
    pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
    vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  };

  function monthCands(m) {
    m = Number(m);
    if (!(m >= 1 && m <= 12)) return [];
    return [MONTHS[m - 1], MONTHS[m - 1].slice(0, 3), String(m).padStart(2, '0'), String(m)];
  }

  function altsFor(key) {
    const P = S.profile;
    if (key === 'politicalNo') return ['No', 'N/A', 'Not Applicable'];
    if (key === 'phoneType') return [P.phoneType, ...(P.phoneOS ? [`${P.phoneType || 'Mobile'} - ${P.phoneOS}`, `Mobile - ${P.phoneOS}`, `Mobile (${P.phoneOS})`, P.phoneOS, P.phoneOS === 'iPhone' ? 'iOS' : P.phoneOS] : []), 'Mobile', 'Mobile Phone', 'Cell', 'Cell Phone', 'Cellular', 'Personal Mobile'].filter(Boolean);
    if (key === 'noSpouse') return P.hasSpouse === 'No' ? ['Not Applicable', 'N/A', 'NA', 'I do not have a spouse', 'Not married', 'No'] : [];
    if (key === 'visaStatus') return P.f1Status === 'Yes' ? ['F-1', 'F-1 Student', 'F-1 Student Visa', 'F1', 'F-1 Visa', 'Student (F-1)', 'F-1 CPT', 'F-1 (CPT)', 'CPT'] : [];
    if (key === 'cpaPathway') return [P.cpaPathway, 'traditional 150-credit hour pathway', '150-credit hour', '150 credit hour', '150 hours'].filter(Boolean);
    if (key === 'undergradSchool') return [P.undergradSchool, P.undergradSchoolAlt].filter(Boolean);
    if (key === 'startMonth') { const d = P.availableStart && new Date(P.availableStart); if (!d || isNaN(d)) return []; const m = MONTHS[d.getMonth()]; return [m, m.slice(0, 3), `${m} ${d.getFullYear()}`, String(d.getMonth() + 1).padStart(2, '0'), String(d.getMonth() + 1)]; }
    if (key === 'contactCurrentEmployer') return ['N/A', 'Not applicable', 'Not currently employed', 'I am not currently employed', 'Yes'];
    if (key === 'pronouns') { const g = norm(P.gender); return /^(male|man)$/.test(g) ? ['He / Him', 'He/Him', 'He/him', 'He'] : /^(female|woman)$/.test(g) ? ['She / Her', 'She/Her', 'She/her', 'She'] : []; }
    if (key === 'undergradMajor') return [P.undergradMajor, ...String(P.undergradMajorAlt || '').split(/[,;，；]/).map((x) => x.trim())].filter(Boolean);
    if (key === 'recruitingTimelines') return S.profile.otherOffers === 'No' ? ['No', 'None', 'Not at this time', 'N/A'] : [];
    if (key === 'gradDate') return gradDateCands();
    if (key === 'degree') return degreeCands();
    if (key === 'highestCompleted') return highestCands();
    if (key === 'stemOpt') return [P.stemOpt].filter(Boolean);
    if (key === 'degreeStatus') return P.enrolled === 'No' ? ['Graduated', 'Completed', 'Degree Received', 'Conferred'] : ['In Progress', 'Currently Enrolled', 'Currently Attending', 'Enrolled', 'Pursuing', 'Expected', 'Some Course Work Completed'];
    if (key === 'aiUsage' && P.aiUsage) return [P.aiUsage, 'I regularly use AI tools'];
    if (key === 'stdTest' && /^none/i.test(P.stdTest || '')) return ['None of the above', 'None', 'N/A', 'Not applicable', 'I have not taken any', 'Did not take'];
    if (key === 'stdTestScore' && /^none/i.test(P.stdTest || '')) return ['Did not take any of these tests', 'Did not take', 'Not applicable', 'N/A', 'None'];
    if (key === 'citizenship' && /^china$|chinese|people'?s republic/i.test(P.citizenship || '')) return ['China', 'Mainland China', "China (People's Republic of)", "People's Republic of China", 'China, Mainland', 'Chinese', 'CN'];
    if (key === 'militaryYears') return ['None', 'No military experience', 'I have no military experience', 'I have not served', 'Never served', 'Not applicable', 'N/A', '0'];
    if (key === 'listedEmployer') {
      const names = (Array.isArray(P.workHistory) ? P.workHistory : []).flatMap((j) => {
        const c = String(j?.company || '');
        const abbr = (c.match(/\(([A-Z]{2,6})\b/) || [])[1];
        return [c, c.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).slice(0, 2).join(' '), abbr];
      }).filter((x) => x && x.length >= 2);
      return [...new Set([...names, 'None of the above', 'None', 'No', 'N/A', 'Not applicable'])];
    }
    if (key === 'veteran' && /^not a protected veteran$/i.test(P.veteran || '')) return ['I am not a veteran', 'Not a veteran', 'I have never served in the military', 'Never served', 'I am not a protected veteran', 'not a protected veteran', 'No, I do not believe', 'No'];
    if (key === 'gender' && /^male$/i.test(P.gender || '')) return ['Male', 'Man', 'Cisgender man', 'Cisgender male', 'Cis man'];
    if (key === 'gender' && /^female$/i.test(P.gender || '')) return ['Female', 'Woman', 'Cisgender woman', 'Cisgender female', 'Cis woman'];
    if (key === 'disability' && /^no\b/i.test(P.disability || '')) return [P.disability, "No, I don't have a disability", "No, I don't", 'No'];
    if (key === 'previousWorker' && /^no$/i.test(P.previousWorker || '')) return ['No', 'I have never worked', 'Never worked', 'I have not worked', 'No, I have not', 'Not Applicable', 'N/A'];
    if (key === 'marketHours') return P.marketHours ? [P.marketHours, '4-5', '4 - 5', '4+', '4 or more', 'More than 4', 'Over 4', '4-6'] : [];
    if (key === 'REFS_TEXT') return refsText();
    if (key === 'securityClearance') return P.securityClearance === 'None' ? ['Never held a clearance', 'I have never held a security clearance', 'I have never held a clearance', 'Never held', 'No clearance', 'None', 'No', 'Not Applicable', 'N/A'] : [];
    if (key === 'source') return [...new Set([P.source, 'Job Board', 'Job Boards', 'Online Job Board', 'Job Posting', 'Job Site', 'Internet', 'Online', 'Website',
      'Non-Referral', 'Other/Non-Referral', 'Not Referred', 'No Referral'].filter(Boolean))];
    if (key === 'eduEndMonthName') return monthCands(P.eduEndMonth);
    if (key === 'eduStartMonthName') return monthCands(P.eduStartMonth);
    if (key === 'degreeGranted') return P.enrolled === 'Yes' ? ['In Progress', 'Pursuing', 'No'] : null;
    if (key === 'cityLoc') return [[P.city, P.state].filter(Boolean).join(', '), P.city].filter(Boolean);
    if (key === 'country' && /united states/i.test(P.country || '')) return [P.country, 'United States', 'USA', 'US'];
    if (key === 'state' && P.state) {
      const abbr = US_STATES[norm(P.state)] || Object.keys(US_STATES).find((k) => US_STATES[k] === P.state.toUpperCase());
      return [P.state, abbr && (abbr.length === 2 ? abbr : abbr.replace(/\b\w/g, (c) => c.toUpperCase()))].filter(Boolean);
    }
    if (key === 'fieldOfStudy') return [...new Set([S.profile.fieldOfStudy, S.profile.fieldOfStudyAlt, 'Business Administration',
      'Business Management and Administration', 'Business Administration and Management', 'Business Management'].filter(Boolean))];
    return null;
  }

  const OTHER_PARTY = /\b(employer|company|reference|referee|supervisor|manager|emergency|contact person|recruiter|spouse|relative)s?\b/;

  const splitMulti = (s) => (typeof s === 'string' && s.includes(' || ') ? s.split(' || ').map((x) => x.trim()).filter(Boolean) : s);

  function resolve(question, kind, f) {
    const nq = norm(question);
    if (!nq) return null;
    const otherParty = OTHER_PARTY.test(nq) || (f && (f.block === 'employer' || f.block === 'reference'
      || /work-?history|work-?experience|employment-?history|employer|education-?history|educationhistory|reference|supervisor/i.test(`${f.el.id || ''} ${f.el.name || ''}`)));
    let best = null;
    for (const r of S.rules) {
      if (r.src) continue; // Codex 猜的，见最后
      for (const k of r.keys) if (nq.includes(k) && (!best || k.length > best.k.length)) best = { k, r };
    }
    if (best) {
      const val = splitMulti(best.r.answer);
      return { value: kind === 'text' && Array.isArray(val) ? val.join(', ') : val, src: '自定义' };
    }
    const internPick = kind !== 'text' && nq.match(/if you are applying (to|for) an? intern(ship)?( position| role)?,? (please )?(select|choose|answer|pick) ["“']?([^"”'.]{2,40})/);
    if (internPick) { const o = internPick[6].trim(); return { key: 'internPick', value: o, alts: [o, o.replace(/\s*-\s*/g, '-'), 'N/A - Intern', 'N/A-Intern', 'N/A'] }; }
    if (/licens/.test(nq) && /disciplin|suspended|revoked/.test(nq) && S.profile.securitiesLicense === 'No') {
      return { key: 'securitiesLicense', value: 'N/A', alts: ['N/A', 'Not Applicable', 'No'] };
    }
    const jl = jobLocation || pageJobLocation();
    if (jl && (/preferred (work )?location|location (that )?you are most interested|most interested in .{0,30}location|location preference/.test(nq)
      || /which (posting |job |office )?location (are you|you are|you're) applying|location (are you|you are|you're) applying (to|for)|(posting|job) location (you are|you're) applying/.test(nq))
      && !/second|third|2nd|3rd/.test(nq)) {
      return { key: 'jobLocation', value: jl, alts: [jl, jl.split(',')[0]] };
    }
    const ft = nq.match(/(available|able) to (begin|start) .{0,40}full[- ]time.{0,30}\b(before|by) (\w+)\.? (\d{4})/);
    if (ft && S.profile.eduEndYear) {
      const mi = MONTHS.findIndex((mo) => mo.toLowerCase().startsWith(ft[4].slice(0, 3)));
      if (mi >= 0) {
        const grad = Number(S.profile.eduEndYear) * 12 + Number(S.profile.eduEndMonth || 12);
        return { key: 'fullTimeBy', value: grad < Number(ft[5]) * 12 + mi + 1 ? 'Yes' : 'No' };
      }
    }
    if (/(reside|live|living|located|based) (in|near)\b/.test(nq) && /\bor\b.{0,40}\b(willing|able|open|plan(ning)?|prepared) to (relocate|move)/.test(nq)) {
      const y = S.profile.relocate || 'Yes';
      return { key: 'relocate', value: kind === 'text' ? (/^y/i.test(y) ? 'Yes, I am willing to relocate.' : y) : y };
    }
    const resid = kind !== 'text' && nq.match(/\b(are you|do you) (currently )?(a )?(resident of|reside in|live in|living in) (the (state|commonwealth) of )?([a-z][a-z .]{2,30}?)(?= and\b| or\b|[?,.]|$)/);
    if (resid && S.profile.state && !/united states|\bu\.?s\.?a?\b|america|the us\b|this (state|area|country)/.test(resid[7])) {
      const place = resid[7].trim();
      const mine = [S.profile.state, S.profile.city].map(norm).filter(Boolean);
      return { key: 'residentOf', value: mine.some((m) => place.includes(m) || m.includes(place)) ? 'Yes' : 'No' };
    }
    const gpaT = kind !== 'text' && /\b(gpa|grade point average)\b/.test(nq) && !/undergrad/.test(nq)
      && (nq.match(/(\d\.\d{1,2})\s*(\/\s*4(\.0)?\s*)?(or (higher|above|greater|better|more)|and (above|higher|up)|\+)/) || nq.match(/(?:at least|minimum(?: of)?|above|over|greater than|exceed\w*)\s*(?:a )?(\d\.\d{1,2})/));
    if (gpaT && parseFloat(S.profile.gpa)) return { key: 'gpaThreshold', value: parseFloat(S.profile.gpa) >= parseFloat(gpaT[1]) ? 'Yes' : 'No' };
    const yrs = kind !== 'text' && nq.match(/^(do|does|have) you (have|possess)\b.{0,30}?(\d+)\s*\+?\s*(or more |plus )?years?\b.{0,80}experience/);
    if (yrs) return { key: 'yearsExp', value: fullTimeYears() >= Number(yrs[3]) ? 'Yes' : 'No' };
    if (S.profile.source && /^if ["“']?(job (posting|board|site)|online job|internet|website)s?\b["”']?.{0,40}(specify|which|name)/.test(nq)) {
      return { key: 'source', value: S.profile.source, alts: altsFor('source') };
    }
    if ((/^\(?if (yes|no|so|you answered|the answer|applicable|other)\b|^.{0,40}\bif ["“']?other\b|if not listed|^.{0,40}\bother\b.{0,40}please specify|please specify[.:]?$/.test(nq)
      || /^if ["“'][^"”']{1,80}["”']|^if referred/.test(nq)) && !/\brace\b|ethnic/.test(nq)) return null;
    if (f && kind === 'text' && /preferred/i.test(`${f.el.id || ''} ${f.el.name || ''} ${f.el.getAttribute('data-automation-id') || ''}`) && /first|given|last|family|middle/.test(nq)) {
      const P = S.profile;
      return { key: 'preferredName', value: !P.preferredName ? '' : /last|family/.test(nq) ? P.lastName : /middle/.test(nq) ? '' : P.preferredName };
    }
    for (const r of RULES) {
      if (r.kinds && !r.kinds.includes(kind)) continue;
      if (r.self && otherParty) continue;
      if (r.re.test(nq)) {
        const alts = r.key && altsFor(r.key);
        const ans = { key: r.key, value: r.key ? valueFor(r.key) : '', alts: alts && alts.length ? alts : null, first: !!r.first };
        if (r.key === 'preferredName') {
          const req = !!(f && isRequired(f));
          if (S.profile.preferredOnlyIfRequired === 'Yes' && !req) ans.value = '';
          else if (!ans.value && req) ans.value = S.profile.firstName || '';
        }
        if (f && kind === 'text' && /^(no|none)\.?$/i.test(String(ans.value || '').trim())) { const na = noneToken(f.el); if (na) ans.value = na; }
        if (r.key === 'otherSchool') { const sch = norm(S.profile.school || ''); ans.value = sch && (nq.includes(sch) || (/new york university/.test(sch) && /\bnyu\b/.test(nq))) ? 'Yes' : 'No'; }
        if (r.key === 'source') ans.fallback = ['Other', 'Other...', 'Others', 'Other (please specify)'];
        if (r.key === 'undergradSchool') ans.fallback = ['Other', 'Other (please specify)', 'Other School', 'Not Listed', 'School not listed'];
        if (/if (unlisted|not listed|not in the list)|(select|choose) ["“']?other["”']?/.test(nq) && ['fieldOfStudy', 'school', 'undergradSchool'].includes(r.key)) {
          const own = r.key === 'fieldOfStudy' ? S.profile.fieldOfStudy : r.key === 'school' ? S.profile.school : S.profile.undergradSchool;
          ans.alts = [own].filter(Boolean);
          ans.fallback = ['Other', 'Other (please specify)', 'Not Listed'];
        }
        if ((r.key === 'undergradGpa' || r.key === 'gpa') && !isNaN(parseFloat(ans.value))) ans.numeric = parseFloat(ans.value);
        if (r.key === 'militaryYears') ans.years = 0;
        if (r.key === 'yearsExp') ans.years = fullTimeYears();
        return kind === 'text' ? textVariant(ans) : ans;
      }
    }
    let guess = null;
    for (const r of S.rules) if (r.src) for (const k of r.keys) if (nq.includes(k) && (!guess || k.length > guess.k.length)) guess = { k, r };
    if (guess) { const val = splitMulti(guess.r.answer); return { value: kind === 'text' && Array.isArray(val) ? val.join(', ') : val, src: 'codex' }; }
    return null;
  }

  const NO_ALTS = ['No', 'I have never', 'Never', 'I have not', 'None', 'False']; // True / False 选项（Brighton Jones「I have signed a non-competition … agreement」）
  const YES_ALTS = ['Yes', 'I am willing', 'I agree', 'I am able', 'True'];
  const candsOf = (ans) => (Array.isArray(ans.value) ? ans.value : ans.alts || (/^no$/i.test(String(ans.value || '')) ? NO_ALTS : /^yes$/i.test(String(ans.value || '')) ? YES_ALTS : [ans.value]));

  const EDU_KEYS = new Set(['school', 'degree', 'fieldOfStudy', 'gpa']);
  const ADDRESS_KEYS = new Set(['address1', 'address2', 'city', 'state', 'postalCode', 'cityLoc']);
  const VISA_KEYS = new Set(['AUTH_NO_SPONSOR', 'workAuthorized', 'needSponsorship', 'currentlySponsored']);
  const CHOICE_KINDS = new Set(['radio', 'select', 'combo', 'listbox', 'popcombo']);


  const LANG_LEVELS = {
    native: ['Native', 'Native or Bilingual', 'Bilingual', 'Fluent', 'Expert', 'Full Professional', 'Advanced'],
    fluent: ['Fluent', 'Full Professional', 'Professional', 'Advanced', 'Proficient', 'Professional Working'],
    advanced: ['Advanced', 'Professional', 'Proficient', 'Professional Working', 'Intermediate'],
    intermediate: ['Intermediate', 'Limited Working', 'Conversational', 'Elementary'],
    basic: ['Basic', 'Elementary', 'Beginner', 'Limited'],
  };
  const LANG_ALIAS = { chinese: 'mandarin', 'mandarin chinese': 'mandarin', 'chinese mandarin': 'mandarin', 'chinese (mandarin)': 'mandarin' };

  function languageLevels() {
    const out = {};
    for (const part of String(S.profile.languages || '').split(/[;；,，\n]/)) {
      const [lang, level] = part.split(/[:：=]/).map((s) => norm(s || ''));
      const key = level && Object.keys(LANG_LEVELS).find((k) => level.startsWith(k));
      if (lang && key) out[LANG_ALIAS[lang] || lang] = key;
    }
    return out;
  }

  function languageAnswer(f, all) {
    if (!/^languages?\b/i.test(precedingHeading(f.el))) return null;
    const sec = precedingHeading(f.el);
    const langField = all.find((x) => /^language$/i.test(x.question) && precedingHeading(x.el) === sec);
    const lang = langField ? norm(fieldAnswer(langField)) : '';
    const level = languageLevels()[LANG_ALIAS[lang] || lang];
    if (!level) return null;
    if (f.kind === 'checkbox' && /fluent/i.test(f.question)) return { value: ['native', 'fluent'].includes(level) ? 'CHECK' : '' };
    if (PICK.includes(f.kind) && /comprehension|overall|reading|speaking|writing|proficien|fluency|level/i.test(f.question)) {
      return { value: LANG_LEVELS[level][0], alts: LANG_LEVELS[level] };
    }
    return null;
  }

  function textVariant(ans) {
    const P = S.profile;
    if (Array.isArray(ans.value)) return { ...ans, value: ans.value.join(', '), alts: null }; // 列表（编程工具）写进文本框：逗号隔开
    if (ans.key === 'degree' && P.degreeFull) return { ...ans, value: P.degreeFull, alts: null };
    if (ans.key === 'country' && /united states/i.test(P.country || '')) return { ...ans, value: 'United States', alts: null };
    if (ans.key === 'acquaintances') return { ...ans, value: 'None', alts: null };
    if (ans.key === 'recruitingTimelines') return { ...ans, alts: null }; // 文本框写整句，不要只写 No
    if ((ans.key === 'treatyVisa' || ans.key === 'homeResidency') && /^no$/i.test(ans.value)) return { ...ans, value: 'N/A', alts: null };
    return ans;
  }

  function resolveField(f) {
    const kind = f.s2 && ![...f.el.options].some((o) => o.value !== '') ? 'combo' : f.kind;
    const ans = resolve(f.question, kind, f);
    if (ans) return ans;
    if (f.els) return resolve(f.question + ' ' + f.els.map(choiceLabel).join(' '), f.kind, f);
    if (f.kind === 'select' && /^((please )?(choose|select)( one| an option)?|)$/i.test(f.question.trim())) {
      return resolve([...f.el.options].map((o) => o.text).join(' ').slice(0, 600), f.kind, f);
    }
    return null;
  }

  function refAnswer(f) {
    if (f.block !== 'reference' || f.refIdx == null || !['text', 'select', 'combo', 'listbox', 'popcombo', 'radio'].includes(f.kind)) return null;
    const R = (S.profile.references || [])[f.refIdx];
    if (!R) return null;
    const q = norm(f.question);
    const v = /^(\d\s*[.)]\s*)?(full )?name$/.test(q) ? R.name : /relationship/.test(q) ? R.relationship : /e-?mail/.test(q) ? R.email
      : /phone|telephone/.test(q) ? R.phone : /company|organi[sz]ation|employer/.test(q) ? R.company : /title|position/.test(q) ? R.title
      : /how long|years/.test(q) ? R.known : '';
    if (!v) return null;
    if (f.kind === 'text') return { key: 'reference', value: v };
    const alts = /relationship/.test(q) ? (/supervis|manager|boss/i.test(v) ? [v, 'Supervisor', 'Manager', 'Direct Supervisor', 'Former Supervisor', 'Professional', 'Work'] : [v, 'Colleague', 'Coworker', 'Co-worker', 'Peer', 'Professional', 'Work'])
      : /how long|years/.test(q) ? [v, '3+ years', '3-5 years', '3 - 5 years', 'More than 3 years', 'Over 3 years', '3-4 years', '3 years', '2-5 years', '1-3 years'] : [v];
    return { key: 'reference', value: v, alts };
  }
  function refsText() {
    return (S.profile.references || []).filter((r) => r.name).map((r) => [r.name, [r.relationship, r.company].filter(Boolean).join(', '), r.email, r.phone].filter(Boolean).join(' | ')).join('\n');
  }

  function alreadyMatches(f, ans) {
    const v = ans.value;
    if (Array.isArray(v)) return false;
    if (f.kind === 'text' || f.kind === 'date') return f.el.value === String(v);
    if (f.kind === 'listbox' || f.kind === 'popcombo') return !isEmpty(f) && !!pickAny([{ el: f.el, text: popText(f.el) }], candsOf(ans));
    if (f.kind === 'select') return !!selectText(f) && !!pickAny([{ el: f.el, text: selectText(f) }], candsOf(ans));
    if (VISA_KEYS.has(ans.key) && f.els) { const on = f.els.filter(isChecked); return !!on.length && !!pickAny(on.map((e) => ({ el: e, text: choiceLabel(e) })), candsOf(ans)); }
    if (f.kind === 'combo' && typeof v === 'string' && (ans.empAddr || ADDRESS_KEYS.has(ans.key) || ans.key === 'country')) {
      const wrap = f.el.id && document.getElementById(f.el.id + '-select-wrapper');
      const cur = String(f.el.value || '').trim() || (wrap ? textOf(wrap) : '');
      return !!cur && !!pickAny([{ el: f.el, text: cur }], candsOf(ans), 0);
    }
    return !isEmpty(f); // 单选、复选、多选搜索框：已有选择就不动
  }

  function pickOption(opts, answer, level) {
    if (!answer) return null;
    if (answer === 'DECLINE') return opts.find((o) => DECLINE_RE.test(o.text)) || null;
    const a = norm(answer);
    const T = opts.map((o) => ({ ...o, n: norm(o.text).replace(/^[^\p{L}\p{N}(]+/u, '') })).filter((o) => o.n);
    const wordStart = new RegExp('^' + esc(a) + '(?=$|[^a-z0-9-])');
    const wordAny = new RegExp('(?:^|[^a-z0-9-])' + esc(a) + '(?=$|[^a-z0-9-])');
    const ca = coreName(a);
    const tests = [(n) => n === a || coreName(n) === ca, (n) => wordStart.test(n), (n) => wordAny.test(n), (n) => n.length > 2 && a.includes(n)];
    for (let i = 0; i < tests.length; i++) {
      if (level !== undefined && i !== level) continue;
      const hit = T.find((o) => tests[i](o.n));
      if (hit) return hit;
    }
    return null;
  }

  function coreName(n) {
    return n.replace(/\s*\(?\+\d{1,4}\)?\s*$/, '').replace(/\s*\([^)]*\)\s*$/, '').replace(/^(microsoft|ms|google|adobe|oracle|sap)\s+/, '').trim();
  }

  const SKILL_ALIASES = {
    'power bi': ['Microsoft Power BI', 'Microsoft Power Business Intelligence'],
    excel: ['Microsoft Excel'],
    powerpoint: ['Microsoft PowerPoint'],
    mandarin: ['Chinese (Mandarin)', 'Mandarin Chinese', 'Chinese'],
  };
  const promptCands = (answer) => [answer, ...(SKILL_ALIASES[norm(answer)] || [])];

  let excludeRe = null;

  function pickAny(opts, cands, maxLevel = 3) {
    if (excludeRe) opts = opts.filter((o) => !excludeRe.test(o.text));
    if (opts.some((o) => /\S\s*\*+$/.test(o.text || ''))) opts = opts.map((o) => (/\S\s*\*+$/.test(o.text || '') ? { ...o, text: o.text.replace(/\s*\*+$/, '') } : o));
    for (let level = 0; level <= maxLevel; level++) {
      for (const c of cands) {
        const hit = pickOption(opts, c, level);
        if (hit) return hit;
      }
    }
    return null;
  }

  function pickRange(opts, x) {
    const num = '(\\d+(?:\\.\\d+)?)';
    const dec = (t) => (t.split('.')[1] || '').length;
    for (const o of opts) {
      const t = norm(o.text);
      let m = t.match(new RegExp(`^${num}\\s*(?:-|–|—|to)\\s*${num}$`));
      let lo; let hi; let d;
      if (m) { lo = +m[1]; hi = +m[2]; d = dec(m[2]); }
      else if ((m = t.match(new RegExp(`^${num}\\s*(?:\\+|and (?:above|higher|up)|or (?:above|higher|more))$`)))) { lo = +m[1]; hi = Infinity; d = dec(m[1]); }
      else if ((m = t.match(new RegExp(`^(?:below|under|less than|<)\\s*${num}$`)))) { lo = -Infinity; hi = +m[1] - 1e-9; d = dec(m[1]); }
      else if ((m = t.match(new RegExp(`^${num}$`)))) { lo = +m[1]; hi = +m[1]; d = dec(m[1]); }
      else continue;
      const r = Math.round(x * 10 ** d) / 10 ** d;
      if (r >= lo && r <= hi) return o;
    }
    return null;
  }

  function pickYears(opts, y) {
    const num = '(\\d+(?:\\.\\d+)?)';
    for (const o of opts) {
      const t = norm(o.text).replace(/\b(years?|yrs?)\b/g, ' ').replace(/\s+/g, ' ').trim();
      let m;
      if ((m = t.match(new RegExp(`^(?:less than|under|fewer than|<)\\s*${num}$`)))) { if (y < +m[1]) return o; }
      else if ((m = t.match(new RegExp(`^${num}\\s*(?:-|–|to)\\s*(less than\\s*)?${num}$`)))) { if (y >= +m[1] && (m[2] ? y < +m[3] : y <= +m[3])) return o; }
      else if ((m = t.match(new RegExp(`^(?:more than|over|greater than)\\s*${num}$`)))) { if (y > +m[1]) return o; }
      else if ((m = t.match(new RegExp(`^${num}\\s*(?:\\+|or more|and (?:above|more))$`)))) { if (y >= +m[1]) return o; }
    }
    return null;
  }

  function chooseOption(opts, cands, ans, withFallback = true) {
    return (ans && ans.numeric != null && pickRange(opts, ans.numeric))
      || (ans && ans.years != null && (pickAny(opts, cands, 1) || pickYears(opts, ans.years)))
      || pickAny(opts, cands)
      || (withFallback && ans && ans.fallback ? pickAny(opts, ans.fallback, 1) : null);
  }


  function isPromptInput(el) {
    return el.getAttribute('data-automation-id') === 'searchBox'
      || el.getAttribute('data-uxi-widget-type') === 'selectinput'
      || !!el.closest('[data-automation-id="multiselectInputContainer"]');
  }

  const PLACEHOLDER_OPT_RE = /^[-—–\s.]*(select|choose|please (select|choose)|no answer|none selected|pick one)\b[^a-z]*?[-—–\s.]*$|^[-—–\s.]*(select|choose|please select)\b|^[-—–\s.]*$/i;
  const isPlaceholderOpt = (o) => !!o && PLACEHOLDER_OPT_RE.test((o.text || '').trim());
  const SUBSCRIBE_FORM_RE = /\b(subscribe|newsletter|sign ?up for (our )?(updates|news|emails?|insights)|stay (informed|in touch|updated|connected)|get (our )?(latest )?(news|insights|updates))\b/i;
  const subscribeCache = new WeakMap();
  function isSubscribeForm(form) {
    if (!form) return false;
    if (subscribeCache.has(form)) return subscribeCache.get(form);
    const inputs = qa('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]), textarea, select', form).filter(isVisible);
    const btnText = qa('button, input[type=submit], [role=button]', form).map((b) => b.textContent || b.value || '').join(' ');
    const yes = inputs.length <= 3 && !q('input[type=file], textarea', form) && inputs.some((e) => e.type === 'email' || /e-?mail/i.test(e.name || e.id || e.placeholder || ''))
      && (SUBSCRIBE_FORM_RE.test(btnText) || SUBSCRIBE_FORM_RE.test((form.textContent || '').slice(0, 400)));
    subscribeCache.set(form, yes);
    return yes;
  }

  function collectFields() {
    const scope = formScope();
    const fields = [];
    const groups = new Map();
    const srInputs = isSR() ? shadowQa('input, textarea, select').filter((el) => !/dropdown-search|autocomplete/.test(hostTags(el))) : [];
    for (const el of [...qa('input, textarea, select, button[aria-haspopup="listbox"]', scope), ...srInputs]) {
      if (el.closest('#wdaf-host') || el.disabled) continue;
      if (el.tagName === 'INPUT' && el.getAttribute('role') !== 'combobox' && !el.closest('.ant-select')
        && (el.type === 'search' || /^search\b/i.test(el.placeholder || el.getAttribute('aria-label') || '') || /(^|[-_])(q|query|search|keywords?)($|[-_])/i.test(el.name || el.id || ''))) continue;
      if (el.closest('nav, [role="navigation"], header, [role="banner"], footer, [role="contentinfo"], [role="search"]') && !el.closest('form [id*="app" i], form[id*="app" i], #application, [data-qa="application"]')) continue;
      if (isSubscribeForm(el.closest('form'))) continue;
      if (el.id === 'location-input' && (q('input#selected-location')?.value || '').length > 5) continue; // Lever 所在地已从下拉选好：别再打字冲掉（Quest / Forbright 实测）
      if (/^(other response|其他回复)$/i.test(el.getAttribute('aria-label') || '')) {
        const li = el.closest('[role="listitem"]');
        if (!li || !q('[data-value="__other_option__"][aria-checked="true"]', li)) continue;
      }
      if (el.closest('.select2-container')) continue;
      if (el.tagName === 'INPUT' && el.type === 'checkbox' && el.closest(ASHBY_YESNO)) continue; // Ashby Yes / No 背后的 checkbox，按按钮答
      if (el.tagName === 'SELECT' && el.classList.contains('select2-hidden-accessible')) {
        const w = select2Widget(el);
        if (w && isVisible(w)) fields.push({ kind: 'select', el, s2: w });
        continue;
      }
      const choice = el.type === 'radio' || el.type === 'checkbox';
      const antd = el.tagName === 'INPUT' && el.closest('.ant-select');
      if (!(isVisible(el) || (antd && isVisible(antd)) || (choice && ([...(el.labels || [])].some(isVisible) || isVisible(el.parentElement))))) continue;
      const aid = el.getAttribute('data-automation-id') || '';
      if (aid === 'beecatcher' || el.getAttribute('aria-hidden') === 'true') continue; // 防机器人的隐藏陷阱框，绝不能填
      if (el.tagName === 'BUTTON') { fields.push({ kind: 'listbox', el }); continue; }
      if (el.tagName === 'SELECT') { fields.push({ kind: 'select', el }); continue; }
      if (el.tagName === 'TEXTAREA') { if (!el.readOnly) fields.push({ kind: 'text', el }); continue; }
      const t = el.type;
      if (['hidden', 'submit', 'button', 'password', 'file', 'image', 'reset'].includes(t)) continue;
      if (/^dateSection/.test(aid)) continue; // 日期单独处理
      if (t === 'radio' || t === 'checkbox') {
        const box = el.closest('fieldset, [role="radiogroup"], [role="group"], [data-automation-id^="formField"]');
        const sib = t === 'checkbox' && el.name && el.name.match(/^(.+?)[-_](\d{1,2})$/);
        const sibKey = sib && el.form && qa(`input[type="checkbox"][name^="${CSS.escape(sib[1])}"]`, el.form).filter((x) => new RegExp('^' + sib[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[-_]\\d{1,2}$').test(x.name)).length > 1 ? 'c:' + sib[1] : '';
        const gkey = t === 'radio' && el.name ? 'r:' + el.name : box || (t === 'checkbox' && el.name && el.form && el.form.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(el.name)}"]`).length > 1 ? 'c:' + el.name : sibKey || el);
        if (!groups.has(gkey)) groups.set(gkey, { kind: t, els: [] });
        groups.get(gkey).els.push(el);
        continue;
      }
      if (isPromptInput(el)) { fields.push({ kind: 'prompt', el }); continue; }
      if (isComboInput(el)) { fields.push({ kind: 'combo', el }); continue; }
      if (el.readOnly && (el.closest('.ol-date-picker__trigger') || /date/i.test(el.placeholder || ''))) { fields.push({ kind: 'date', el, vc: true }); continue; }
      if (el.readOnly && el.closest('.ol-popper__trigger')) { fields.push({ kind: 'combo', el, ol: true }); continue; }
      if (el.readOnly) continue;
      if (/^(date|month)$/.test(t)) { fields.push({ kind: 'date', el }); continue; }
      if (!isWD() && !questionFor(el) && el.tabIndex < 0) continue; // 下拉组件里藏的辅助输入框（没有题目、不能 Tab 到）
      fields.push({ kind: 'text', el });
    }
    for (const el of qa('[role="combobox"]:not(input):not(select):not(textarea)', scope)) {
      if (el.closest('#wdaf-host') || !isVisible(el) || (el.tagName === 'BUTTON' && el.getAttribute('aria-haspopup') === 'listbox') || q('input, select, textarea', el)) continue;
      fields.push({ kind: 'popcombo', el });
    }
    for (const el of qa('[role="button"][aria-controls][aria-expanded]:not(button)', scope)) {
      if (el.closest('#wdaf-host') || !isVisible(el) || q('input:not([type="hidden"]), select, textarea', el)) continue;
      const ctl = document.getElementById(el.getAttribute('aria-controls'));
      if (!ctl || !q('li, [role="option"]', ctl)) continue;
      if (!(ctl.getAttribute('role') === 'listbox' || /(options?|listbox|dropdown|menu)$/i.test(ctl.id) || /dropdown|select|combo/i.test(String(el.parentElement && el.parentElement.className)))) continue;
      fields.push({ kind: 'popcombo', el });
    }
    for (const el of qa('[role="radio"]:not(input), [role="checkbox"]:not(input), [role="menuitemradio"]:not(input), button[class*="pill" i]:not([role]), [class*="_yesno_"] > button', scope)) {
      if (el.tagName === 'BUTTON' && !el.getAttribute('role') && !isPillButton(el)) continue;
      if (el.closest('#wdaf-host') || !isVisible(el) || el.getAttribute('aria-disabled') === 'true') continue;
      const role = el.getAttribute('role') === 'checkbox' ? 'checkbox' : 'radio';
      const box = el.closest('[role="radiogroup"], [role="group"], .input-row, fieldset') || el.parentElement;
      const gkey = 'aria:' + role + ':' + (box.id || '') + ':' + [...groups.keys()].length;
      const k = [...groups.entries()].find(([, g]) => g.box === box && g.kind === role);
      if (k) k[1].els.push(el); else groups.set(gkey, { kind: role, els: [el], box });
    }
    if (isSR()) {
      for (const g of shadowQa('spl-radio-group')) {
        const els = [...g.querySelectorAll('spl-radio')];
        if (els.length && g.offsetWidth) fields.push({ kind: 'radio', el: els[0], els, srQ: srHostLabel(g), srReq: g.hasAttribute('required') });
      }
      for (const ac of shadowQa('spl-autocomplete')) {
        if (ac.matches('[data-test="location-autocomplete"], [label="City"]') || !ac.offsetWidth) continue; // 第 1 页的城市 srCity 管
        const inp = ac.shadowRoot && srDeep(ac.shadowRoot, 'input').find((i) => isVisible(i));
        if (inp) fields.push({ kind: 'combo', el: inp, srAc: ac, srQ: srHostLabel(ac), srReq: ac.hasAttribute('required') });
      }
    }
    for (const g of groups.values()) {
      if (g.kind === 'checkbox' && g.els.length === 1) fields.push({ kind: 'checkbox', el: g.els[0] });
      else fields.push({ kind: g.kind === 'radio' ? 'radio' : 'checkgroup', el: g.els[0], els: g.els });
    }
    fields.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    for (const f of fields) {
      f.question = f.srQ ? f.srQ : f.s2 ? select2Question(f.el, f.s2) : questionFor(f.el);
      if (f.kind === 'checkbox') f.question = (f.question + ' ' + choiceLabel(f.el)).trim();
      const part = (f.kind === 'select' || f.kind === 'text') && datePartOf(f.el, f.question);
      if (part) { f.datePart = part; if (!/month\s*\/\s*day|mm\s*\/\s*dd/i.test(f.question)) f.question = cleanLabel(precedingText(f.el, DATE_PART_RE)); }
    }
    markBlocks(fields);
    const occ = new Map();
    for (const f of fields) { const k = f.kind + '|' + f.question; f.occ = occ.get(k) || 0; occ.set(k, f.occ + 1); }
    return fields;
  }

  function markBlocks(fields) {
    let block = '';
    let empIdx = null;
    let byHeading = false; // 当前区块是按标题 / legend 认出来的：离开那一段就要清掉
    let refIdx = null; // 推荐人：D.A. Davidson（Lever）「1. Name / Relationship / Email Address / Phone Number / How long have you know this reference? / 2. Name …」
    for (const f of fields) {
      const q = norm(f.question);
      const rn = q.match(/^(\d)\s*[.)]\s*(full )?name$/);
      if (rn && Number(rn[1]) <= 5) { refIdx = Number(rn[1]) - 1; f.block = 'reference'; f.refIdx = refIdx; continue; }
      if (refIdx !== null) {
        if (/^(relationship|email( address)?|e-?mail|phone( number)?|telephone|company|organi[sz]ation|employer|title|position|job title|how long|years (known|of acquaintance))/.test(q)) { f.block = 'reference'; f.refIdx = refIdx; continue; }
        refIdx = null;
      }
      const gh = (f.el.id || '').match(/^(company-name|title|start-date-month|start-date-year|end-date-month|end-date-year|current-role)-(\d+)/);
      if (gh) { f.block = 'employer'; f.empIdx = Number(gh[2]); continue; }
      const ph = `${f.el.id || ''} ${f.el.name || ''}`.match(/work-?history\b[^0-9]{0,24}?(\d+)(?!\d)/i);
      if (ph) { f.block = 'employer'; f.empIdx = Number(ph[1]); continue; }
      const m = q.match(/^(\d+)\.\s*(employer|company)/);
      if (m) { block = 'employer'; empIdx = Number(m[1]) - 1; }
      else if (/employment history|work history|previous employers?/.test(q)) { block = 'employer'; empIdx = null; }
      else if (/professional references|references? (below|information)|^(\d+\.\s*)?references?\b/.test(q)) { block = 'reference'; empIdx = null; }
      else if (/^(institution|school|university|college) name|highest level of education|^education/.test(q)) { block = 'education'; empIdx = null; }
      else if (block === 'employer' && empIdx === null && /employer|company/.test(q)) empIdx = 0;
      let legendHit = null;
      for (let fs = !isWD() && f.el.closest('fieldset'); fs && !legendHit; fs = fs.parentElement && fs.parentElement.closest('fieldset')) {
        legendHit = textOf(fs.querySelector(':scope > legend')).match(/^(employment|work) (history|experience)\s*[#(]?\s*(\d+)\)?/i);
      }
      const eh = !isWD() && (legendHit || precedingHeading(f.el).match(/^(employment|work) (history|experience)\s*[#(]?\s*(\d+)\b/i));
      if (eh) { block = 'employer'; empIdx = Number(eh[3]) - 1; byHeading = true; }
      else if (byHeading) { block = ''; empIdx = null; byHeading = false; }
      if (isWD()) { // Workday：看区块标题
        const h = precedingHeading(f.el);
        if (/^(your |my )?(work experience|employment|experience)\b/i.test(h)) block = 'employer';
        else if (/^references?/i.test(h)) block = 'reference';
        else if (block === 'employer' || block === 'reference') block = '';
      }
      f.block = block;
      f.empIdx = block === 'employer' && !isWD() ? empIdx : null;
    }
  }

  function isComboInput(el) {
    if (el.tagName !== 'INPUT' || isPromptInput(el)) return false;
    if (el.getAttribute('aria-haspopup') === 'dialog' || /datepicker/i.test(el.getAttribute('data-provide') || '')) return false;
    return el.getAttribute('role') === 'combobox' || /^(list|both)$/.test(el.getAttribute('aria-autocomplete') || '');
  }

  const DATE_PART_RE = /^(year|month|day|yyyy|mm|dd)$/i;
  function datePartOf(el, question) {
    const own = norm(question) || norm((el.name || el.id || '').replace(/^.*?(year|month|day)$/i, '$1'));
    const byName = (el.name || el.id || '').match(/[._-](month|date|day|year)$/i);
    if (byName && /month\s*\/\s*day\s*\/\s*year|mm\s*\/\s*dd/i.test(question || '')) return { date: 'day' }[byName[1].toLowerCase()] || byName[1].toLowerCase();
    const m = own.match(/^(year|month|day|yyyy|mm|dd)$/);
    return m ? { yyyy: 'year', mm: 'month', dd: 'day' }[m[1]] || m[1] : null;
  }

  function hasSelection(el) {
    const box = el.closest('[data-automation-id^="formField"]') || el.parentElement?.parentElement?.parentElement;
    if (!box) return false;
    return !!q('[data-automation-id="selectedItem"]', box)
      || qa('[data-automation-id="selectedItemList"] li, [data-automation-id="selectedItemList"] [role="option"]', box).length > 0;
  }

  function comboBox(el) {
    return el.closest('.ant-select') || el.closest('.el-select') || el.closest('[class*="select__control"]') || el.closest('[class*="-control"]') || el.closest('.MuiAutocomplete-root')
      || el.parentElement?.parentElement || el;
  }
  const elSelectValue = (el) => { const p = q('.el-select__placeholder:not(.is-transparent)', comboBox(el)); return p ? textOf(p) : ''; };
  function comboValue(el) {
    if (el.value.trim()) return el.value.trim();
    if (elSelectValue(el)) return elSelectValue(el);
    const ant = el.closest('.ant-select') && q('.ant-select-selection-item', el.closest('.ant-select'));
    if (ant) return ant.getAttribute('title') || textOf(ant);
    const v = q('[class*="single-value"], [class*="singleValue"], [class*="multi-value__label"], [class*="multiValue"], .MuiChip-label, .Select-value-label', comboBox(el));
    return v ? textOf(v) : '';
  }

  function select2Widget(sel) {
    const c = sel.nextElementSibling;
    return c && c.classList.contains('select2-container') ? q('.select2-selection', c) : null;
  }
  function select2Empty(w) {
    if (w.classList.contains('select2-selection--multiple')) return !q('.select2-selection__choice', w);
    const r = q('.select2-selection__rendered', w);
    return !r || !!q('.select2-selection__placeholder', r) || !textOf(r).replace(/^×\s*/, '');
  }
  function select2Question(sel, w) {
    const own = [...(sel.labels || [])].find((l) => !l.contains(sel) && textOf(l));
    if (own) return cleanLabel(textOf(own));
    const ids = (w.getAttribute('aria-labelledby') || '').split(/\s+/).filter((id) => id && !/^select2-|-error$/.test(id));
    const t = ids.map((id) => textOf(document.getElementById(id))).join(' ').trim();
    if (t) return cleanLabel(t);
    const box = sel.parentElement;
    const lab = box && qa('select', box).length === 1 && qa('label, legend', box).find((l) => !l.contains(sel));
    return cleanLabel(lab ? textOf(lab) : precedingText(sel));
  }
  function selectText(f) {
    if (!f.el.value || (f.s2 && select2Empty(f.s2))) return '';
    return (f.el.selectedOptions[0]?.text || '').trim();
  }
  const select2Open = (w) => w.getAttribute('aria-expanded') === 'true' || !!w.closest('.select2-container')?.classList.contains('select2-container--open');
  const select2Has = (f, text) => !select2Empty(f.s2) && [...f.el.selectedOptions].some((o) => norm(o.text) === norm(text));
  function select2Options(w) {
    const rid = (q('.select2-selection__rendered', w)?.id || '').replace(/-container$/, '-results');
    const ul = (rid && document.getElementById(rid)) || q('.select2-container--open .select2-results__options');
    return ul ? qa('[role="option"], [role="treeitem"]', ul)
      .filter((li) => li.getAttribute('aria-disabled') !== 'true' && !li.classList.contains('select2-results__message'))
      .map((el) => ({ el, text: textOf(el) })) : [];
  }
  async function fillSelect2(f, pick, terms) {
    const w = f.s2;
    w.scrollIntoView({ block: 'center' });
    if (!select2Open(w)) mouseClick(w);
    if (!await waitFor(() => select2Open(w), 1500)) return false;
    let hit = (await waitFor(() => select2Options(w).length, 1000)) && pick(select2Options(w), 3);
    const search = q('.select2-container--open .select2-search__field');
    for (const maxLevel of hit || !search ? [] : [1, 3]) {
      for (const term of terms) {
        if (!running) break;
        typeInto(search, term);
        const t0 = Date.now();
        hit = await waitFor(() => (q('.select2-container--open .loading-results') ? null
          : pick(select2Options(w), maxLevel) || (Date.now() - t0 > 1500 ? 'none' : null)), 6000, 200);
        if (hit === 'none') hit = null;
        dbg('select2', f.question, '| 搜', term, '| 选项', select2Options(w).map((o) => o.text).slice(0, 8), '| 命中', hit && hit.text);
        if (hit) break;
      }
      if (hit) break;
    }
    if (hit) {
      const want = hit.text;
      hit.el.scrollIntoView({ block: 'nearest' });
      hit.el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      await sleep(300);
      if (!select2Has(f, want) && hit.el.isConnected) { mouseClick(hit.el); await sleep(300); }
      if (select2Has(f, want)) {
        if (select2Open(w)) mouseClick(w); // 多选的选完不会自己收起
        return true;
      }
      dbg('select2 点了但没选上', f.question, want, '| 现在是', selectText(f));
    }
    if (select2Open(w)) mouseClick(w); // 没选上：把下拉收起来
    return false;
  }

  function isEmpty(f) {
    switch (f.kind) {
      case 'text': case 'date': return !f.el.value.trim();
      case 'combo': return f.srAc ? !srAcPicked(f) : !comboValue(f.el);
      case 'select': return f.s2 ? select2Empty(f.s2) : (!f.el.value || !f.el.selectedOptions.length || isPlaceholderOpt(f.el.selectedOptions[0]));
      case 'listbox': return /^(select one|select|)$/i.test(textOf(f.el));
      case 'popcombo': return POP_EMPTY_RE.test(popText(f.el));
      case 'prompt': return !hasSelection(f.el);
      case 'radio': case 'checkgroup': return !f.els.some(isChecked);
      case 'checkbox': return !isChecked(f.el);
      default: return false;
    }
  }

  const errorRequired = new WeakSet();
  const REQ_ERR_RE = /^(this field is required|this is a required field|required|field is required|this question is required|please (select|choose|enter|fill( in| out)?|complete|answer|provide) .{0,40})\.?$/i;
  function markErrorRequired() {
    const out = [];
    const fields = collectFields();
    for (const e of qa('div, span, p, small, li, [role="alert"]')) {
      if (e.children.length > 1 || !isVisible(e) || e.closest('#wdaf-host') || !REQ_ERR_RE.test(textOf(e))) continue;
      let box = e.parentElement;
      for (let i = 0; i < 6 && box; i++, box = box.parentElement) {
        const file = q('input[type="file"]', box);
        if (file) { out.push(`上传栏：${cleanLabel(precedingText(fileZone(file)) || fileCtxOwn(file)).slice(0, 40)}`); break; }
        const upBtn = qa('button, [role="button"]', box).find((b) => UPLOAD_BTN_RE.test(cleanLabel(textOf(b))));
        if (upBtn) { out.push(`上传栏：${cleanLabel(precedingText(upBtn) || textOf(upBtn)).slice(0, 40)}`); break; }
        const hit = fields.filter((f) => (f.els || [f.el]).some((x) => box.contains(x)));
        if (!hit.length) continue;
        for (const f of hit.slice(0, 3)) { for (const x of f.els || [f.el]) errorRequired.add(x); out.push(f.question); }
        break;
      }
    }
    return [...new Set(out)];
  }
  function isRequired(f) {
    if ((f.els || [f.el]).some((x) => errorRequired.has(x))) return true;
    if (f.srReq != null) return f.srReq; // SmartRecruiters 问卷：组件上的 required
    if (isSR() && shadowHost(f.el)) return hostHas(f.el, 'required'); // SmartRecruiters：只看组件上的 required（Facebook / X 之前被误判成必填）
    const ff = f.el.closest('[data-automation-id^="formField"]') || f.el.closest('fieldset');
    if (f.el.getAttribute('aria-required') === 'true' || f.el.required) return true;
    if (f.s2 && f.s2.getAttribute('aria-required') === 'true') return true;
    if (f.kind === 'popcombo' && f.el.parentElement && f.el.parentElement.matches('.required, [aria-required="true"]')) return true; // Jane Street：div.standard-dropdown.required
    if (f.el.classList.contains('required') || [...(f.el.labels || [])].some((l) => l.classList.contains('required'))) return true;
    if ([...(f.el.labels || [])].some((l) => /(^|[\s_-])required([\s_-]|$)/i.test(l.className)) || q('.ant-form-item-required', f.el.closest('.ant-form-item') || document.createElement('i'))) return true;
    if (/required/i.test(f.el.getAttribute('aria-label') || '')) return true;
    if (q('label[class*="_required_"], .ashby-application-form-question-title[class*="_required_"]', f.el.closest('.ashby-application-form-field-entry') || document.createElement('i'))) return true;
    if ([...(f.el.labels || [])].some((l) => /\(required\)/i.test(l.textContent))) return true;
    if ([...(f.el.labels || [])].some((l) => /\*/.test(l.textContent)) && f.kind !== 'radio' && f.kind !== 'checkgroup') return true;
    if (f.el.closest('[role="radiogroup"][aria-required="true"]')) return true;
    if ((f.kind === 'radio' || f.datePart) && /\*|\(required\)/i.test(precedingText(f.el.closest('[role="radiogroup"]') || f.el, DATE_PART_RE))) return true;
    const pe = precedingEl(f.el.closest('[role="radiogroup"], [role="group"], .el-form-item') || f.el, DATE_PART_RE);
    if (pe && f.question && norm(cleanLabel(pe.text)) === norm(f.question) && !/optional/i.test(pe.text)
      && (/(^|[\s_-])required([\s_-]|$)/i.test(pe.el.className) || q('[class*="required" i]', pe.el))) return true;
    if (pe && f.question && norm(cleanLabel(pe.text)) === norm(f.question) && /\(required\)\s*:?\s*$/i.test(pe.text.trim())) return true;
    if (ff) {
      const lab = q('label, legend', ff);
      const ownLab = f.el.labels && f.el.labels[0];
      if (lab && /\*/.test(lab.textContent) && !(ownLab && ownLab !== lab && !/\*/.test(ownLab.textContent))) return true;
      if (ff.getAttribute('aria-required') === 'true') return true;
      const own = f.els || [f.el];
      if (qa('[aria-required="true"]', ff).some((r) => ff.matches('[data-automation-id^="formField"]') || own.some((e) => r === e || r.contains(e) || e.contains(r)))) return true;
    }
    return false;
  }


  const visibleListboxes = () => qa('[role="listbox"]')
    .filter((lb) => isVisible(lb) && !lb.closest('#wdaf-host') && lb.getAttribute('data-automation-id') !== 'selectedItemList');

  function listOptions(root) {
    const pill = '[data-automation-id="selectedItem"], [data-automation-id="selectedItemList"]';
    return qa('[role="option"], [data-automation-id="promptOption"], [data-automation-id="menuItem"]', root || document)
      .filter((o) => !o.closest('#wdaf-host') && isVisible(o) && !o.closest(pill) && !q(pill, o))
      .map((el) => ({ el, text: el.getAttribute('data-automation-label') || textOf(el) }));
  }

  function optionTarget(el) {
    return el.matches('[data-automation-id="promptOption"]') ? el : (q('[data-automation-id="promptOption"]', el) || el);
  }

  function listboxFor(btn, before) {
    const id = btn.getAttribute('aria-controls') || btn.getAttribute('aria-owns');
    const own = id && document.getElementById(id);
    if (own && isVisible(own)) return own.matches('[role="listbox"]') ? own : (q('[role="listbox"]', own) || own);
    const all = visibleListboxes();
    return all.find((l) => before && !before.has(l))
      || all.find((l) => !(before && before.has(l)) && l.getAttribute('data-automation-id') !== 'activeListContainer')
      || (before ? null : all[0]);
  }

  async function closeOpenListbox() {
    const popups = () => visibleListboxes().filter((l) => l.getAttribute('data-automation-id') !== 'activeListContainer');
    const open = popups()[0];
    if (!open) return;
    pressKey(document.activeElement && document.activeElement !== document.body ? document.activeElement : open, 'Escape');
    if (await waitFor(() => !popups().length, 800)) return;
    const owner = qa('button[aria-haspopup="listbox"][aria-expanded="true"]').find((b) => !b.closest('#wdaf-host'));
    if (owner) { owner.click(); await waitFor(() => !popups().length, 800); }
  }

  async function fillListbox(btn, cands, ans) {
    await closeOpenListbox();
    const before = new Set(visibleListboxes());
    btn.click();
    let lb = await waitFor(() => listboxFor(btn, before), 1200);
    if (!lb) { mouseClick(btn); lb = await waitFor(() => listboxFor(btn, before), 1500); }
    if (!lb) return false;
    let hit = null;
    for (const withFallback of ans?.fallback ? [false, true] : [false]) {
      lb.scrollTop = 0;
      await sleep(withFallback ? 120 : 0);
      hit = chooseOption(listOptions(lb), cands, ans, withFallback);
      for (let i = 0; !hit && i < 40; i++) {
        const before = lb.scrollTop;
        lb.scrollTop += Math.max(lb.clientHeight, 200);
        await sleep(120);
        hit = chooseOption(listOptions(lb), cands, ans, withFallback);
        if (lb.scrollTop === before) break;
      }
      if (hit) break;
    }
    if (!hit) {
      pressKey(btn, 'Escape');
      await sleep(150);
      if (isVisible(lb)) btn.click();
      return false;
    }
    const target = optionTarget(hit.el);
    target.scrollIntoView({ block: 'nearest' });
    target.click();
    await sleep(350);
    if (isVisible(lb) && /^(select one|)$/i.test(textOf(btn))) { mouseClick(target); await sleep(350); }
    return !/^(select one|)$/i.test(textOf(btn));
  }

  function pillCount(input) {
    const box = input.closest('[data-automation-id^="formField"]') || input.parentElement?.parentElement?.parentElement;
    return box ? qa('[data-automation-id="selectedItem"]', box).length : 0;
  }

  async function searchPrompt(input, term, cands, maxLevel, startPills) {
    input.focus();
    input.click();
    setText(input, term);
    input.focus();
    pressKey(input, 'Enter');
    for (let i = 0; i < 12; i++) {
      await sleep(250);
      if (pillCount(input) > startPills) return 'selected'; // 只有一个结果时 Workday 会直接选上
      const opts = listOptions().filter((o) => !/no items|no results/i.test(o.text));
      const hit = pickAny(opts, cands, maxLevel);
      if (hit) return hit;
    }
    return null;
  }

  async function fillPromptOne(input, answer) {
    const cands = promptCands(answer);
    const start = pillCount(input);
    let hit = null;
    for (const term of cands) {
      hit = await searchPrompt(input, term, cands, 1, start);
      if (hit) break;
    }
    if (!hit) hit = await searchPrompt(input, answer, cands, 3, start);
    if (hit === 'selected') { pressKey(input, 'Escape'); return true; }
    if (!hit) { pressKey(input, 'Escape'); return false; }
    const target = optionTarget(hit.el);
    target.click();
    await sleep(500);
    if (pillCount(input) <= start) {
      const hit2 = pickAny(listOptions(), cands);
      if (hit2) { optionTarget(hit2.el).click(); await sleep(500); }
    }
    if (pillCount(input) <= start && target.isConnected) { mouseClick(target); await sleep(400); }
    pressKey(input, 'Escape');
    await sleep(150);
    return pillCount(input) > start;
  }

  function refindPrompt(input, ffId) {
    if (input.isConnected || !ffId) return input;
    const ff = q(`[data-automation-id="${ffId}"]`);
    return (ff && qa('input', ff).find(isPromptInput)) || input;
  }

  async function fillPrompt(input, list, firstOnly) {
    const ffId = input.closest('[data-automation-id^="formField"]')?.getAttribute('data-automation-id');
    let any = false;
    for (const a of list) {
      input = refindPrompt(input, ffId);
      if (!input.isConnected) break;
      if (await fillPromptOne(input, a)) any = true;
      else if (hasSelection(refindPrompt(input, ffId))) any = true;
      if (firstOnly && any) break;
    }
    return any;
  }

  function clickChoice(el) {
    if (el.tagName === 'SPL-RADIO') { srFire((el.shadowRoot && el.shadowRoot.querySelector('label')) || el); return isChecked(el); } // SmartRecruiters：点影子里的 label 才选上
    el.click();
    const inner = el.tagName !== 'INPUT' && el.querySelector && el.querySelector('input[type="radio"]');
    if (!isChecked(el) && inner && inner.isConnected) inner.click();
    if (!isChecked(el) && el.isConnected) mouseClick(el.labels?.[0] || el);
    return isChecked(el);
  }
  async function clickChoiceReal(el) {
    if (isWD() && !isChecked(el) && (await trustedClick(el))) { await sleep(300); if (isChecked(el)) return true; }
    return isChecked(el) || clickChoice(el);
  }


  function setNative(el, value) {
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function typeInto(el, v) {
    el.focus();
    el.select?.();
    let ok = false;
    try { ok = document.execCommand('insertText', false, v); } catch (_) { /* ignore */ }
    if (!ok || el.value !== v) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  const POPUP_SEL = '[role="listbox"], [role="menu"], [role="status"], ul, [class*="drop" i], [class*="menu" i], [class*="list" i], [class*="popup" i], [class*="popover" i], [class*="result" i], [class*="suggest" i], [class*="empty" i]';
  const NO_OPTS_RE = /^(no (options|results|matches|items|data|records)|nothing found|not found)|no (results|matches|options) (were |was )?found/i;
  const comboBefore = new WeakMap(); // 输入框 → 点开前就看得见的菜单类元素
  const visiblePopups = () => qa(POPUP_SEL).filter((e) => !e.closest('#wdaf-host') && isVisible(e));
  function optionEls(root) {
    let els = qa('[role="option"]', root);
    if (!els.length) els = qa('[role="row"]', root).filter((r) => !q('[role="columnheader"]', r)).map((r) => q('[role="gridcell"]', r) || r);
    if (!els.length) els = qa('[role="listitem"]', root); // Paylocity 的下拉：div[role=list] > div[role=listitem]
    if (!els.length) els = qa('li', root);
    return els;
  }
  function newPopups(input) {
    const before = comboBefore.get(input);
    if (!before) return [];
    const r = input.getBoundingClientRect();
    return visiblePopups().filter((p) => {
      if (before.has(p) || p.contains(input) || qa('input, select, textarea', p).length > 1) return false;
      const b = p.getBoundingClientRect();
      return b.bottom > r.top - 600 && b.top < r.bottom + 600;
    });
  }
  function popupOptions(input) {
    const out = [];
    const seen = new Set();
    for (const p of newPopups(input)) {
      for (const el of optionEls(p)) {
        if (seen.has(el) || !isVisible(el) || q('input, select, textarea', el)) continue;
        seen.add(el);
        const t = textOf(el);
        if (t && t.length <= 150 && !NO_OPTS_RE.test(t)) out.push({ el, text: t });
      }
    }
    return out.filter((o) => !out.some((x) => x !== o && o.el.contains(x.el))); // 嵌套的 li 只留最里面的
  }

  function comboOptions(input) {
    const std = comboOptionsStd(input);
    return std.length ? std : popupOptions(input);
  }
  function comboOptionsStd(input) {
    if (input.closest('.ant-select')) {
      const ant = qa('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').filter(isVisible)
        .map((el) => ({ el, text: el.getAttribute('title') || textOf(q('.ant-select-item-option-content', el) || el) }))
        .filter((o) => o.text);
      if (ant.length) return ant;
    }
    const plc = input.id && document.getElementById(input.id + '-dropdown-list-container');
    if (plc && isVisible(plc)) {
      const rows = qa('[role="listitem"]', plc).filter(isVisible).map((el) => ({ el, text: textOf(el) })).filter((o) => o.text && !/^(no results|no options)/i.test(o.text));
      if (rows.length) return rows;
    }
    const id = input.getAttribute('aria-controls') || input.getAttribute('aria-owns');
    const own = id && document.getElementById(id);
    const roots = own && isVisible(own) ? [own] : qa('[role="listbox"]').filter((l) => isVisible(l) && !l.closest('#wdaf-host'));
    return roots.flatMap(optionEls).filter(isVisible)
      .map((el) => ({ el, text: textOf(el) }))
      .filter((o) => o.text && !/^(no options|no results|no items|loading)/i.test(o.text));
  }

  function comboSaysNoOptions(input) {
    if (qa('[class*="noOptions"], [class*="no-options"], [class*="menu-notice"]')
      .some((e) => isVisible(e) && /no (options|results|matches)/i.test(textOf(e)))) return true;
    return !!input && newPopups(input).some((p) => NO_OPTS_RE.test(textOf(p).slice(0, 80)));
  }

  function comboPicked(input, optText) {
    if (q('[class*="single-value"], [class*="singleValue"], [class*="multi-value"], [class*="multiValue"], .MuiChip-root, .Select-value-label, .ant-select-selection-item', comboBox(input))) return true;
    if (elSelectValue(input) && norm(elSelectValue(input)) === norm(optText)) return true; // el-select 选上后文字在旁边的 span 里
    const stillOpen = input.getAttribute('aria-expanded') === 'true' && qa('[role="listbox"]').some((l) => isVisible(l) && !l.closest('#wdaf-host'));
    if (stillOpen || input.getAttribute('aria-invalid') === 'true') return false;
    const v = norm(input.value);
    const o = norm(optText);
    return v === o || (v.length >= 3 && (o.startsWith(v + ',') || o.startsWith(v + ' (') || o.startsWith(v + ' -')));
  }

  async function fillAddressCombo(input, street) {
    const P = S.profile;
    const want = [P.city, P.postalCode].filter(Boolean).map(norm);
    if (!street || !want.length) return false;
    comboBefore.set(input, new Set(visiblePopups()));
    for (const term of [...new Set([[street, P.city, P.postalCode].filter(Boolean).join(' '), [street, P.city].filter(Boolean).join(' '), street])]) {
      if (!running) return false;
      if (document.activeElement !== input) mouseClick(input);
      if (input.value) { setNative(input, ''); await sleep(150); }
      typeInto(input, term);
      for (let i = 0; i < 25 && running; i++) {
        await sleep(200);
        const opts = comboOptions(input);
        const zip = P.postalCode && norm(P.postalCode);
        const hit = (zip && opts.find((o) => norm(o.text).includes(zip))) || opts.find((o) => want.some((w) => norm(o.text).includes(w)));
        if (hit) {
          dbg('地址联想', term, '→', hit.text);
          hit.el.scrollIntoView?.({ block: 'nearest' });
          hit.el.click();
          await sleep(800);
          if (input.value.trim() && input.getAttribute('aria-invalid') !== 'true') return true;
        }
        if (comboSaysNoOptions(input)) break;
      }
    }
    if (running) {
      typeInto(input, street);
      await sleep(400);
      input.blur();
      await sleep(500);
      if (norm(input.value) === norm(street) && input.getAttribute('aria-invalid') !== 'true') { dbg('地址联想没有，直接写街道', street); return true; }
    }
    comboDiag(input, [street]);
    if (input.value) typeInto(input, '');
    input.blur();
    return false;
  }

  async function openCombo(input) {
    if (!comboBefore.has(input) || !newPopups(input).length) comboBefore.set(input, new Set(visiblePopups()));
    const opened = () => input.getAttribute('aria-expanded') === 'true';
    const plOpen = () => !!(input.id && document.getElementById(input.id + '-dropdown-list-container'));
    const read = () => (opened() || plOpen() ? comboOptions(input) : popupOptions(input));
    const wait = async (n) => { for (let i = 0; i < n; i++) { await sleep(150); const o = read(); if (o.length) return o; } return null; };
    const sfBtn = (input.id && document.getElementById(input.id.replace(/_input$/, '_selectButton'))) || q('.rcmpaginatedselectbutton', input.parentElement || document);
    if (sfBtn && sfBtn !== input && isVisible(sfBtn)) mouseClick(sfBtn);
    else if (!opened()) mouseClick(input);
    let opts = await wait(sfBtn ? 8 : 6);
    if (opts) return opts;
    let tog = null;
    for (let w = input.parentElement, i = 0; w && i < 3 && !tog; w = w.parentElement, i++) {
      if (qa('input, select, textarea', w).filter(isVisible).length > 1) break;
      tog = qa('button, [role="button"], [class*="arrow" i], [class*="caret" i], [class*="toggle" i], [class*="indicator" i], [class*="chevron" i], [class*="trigger" i]', w)
        .find((b) => b !== input && !b.contains(input) && isVisible(b) && !/clear|remove|delete|reset|[×✕]/i.test(`${b.getAttribute('aria-label') || ''} ${b.getAttribute('title') || ''} ${b.className} ${textOf(b)}`));
    }
    if (tog) { mouseClick(tog); opts = await wait(6); if (opts) return opts; }
    if (!opened() && !plOpen()) { input.blur(); await sleep(150); input.focus(); pressKey(input, 'ArrowDown'); opts = await wait(4); if (opts) return opts; }
    return [];
  }

  const BIG_LIST_RE = /school|university|college|institution|discipline|major|field of study|location|city|country|state|province|company|employer|language|skill/i;

  async function clickComboOption(input, hit) {
    const optText = hit.text;
    const target = q('a[role="menuitem"], [role="menuitem"]', hit.el) || hit.el;
    target.scrollIntoView?.({ block: 'nearest' });
    if (target !== hit.el) mouseClick(target); else target.click();
    await sleep(350);
    if (!comboPicked(input, optText) && target.isConnected) { mouseClick(target); await sleep(350); }
    if (comboPicked(input, optText)) { input.blur(); return true; }
    dbg('combo 点了但没选上', questionFor(input), optText);
    return false;
  }

  const trustedTried = new WeakSet(); // 已经用真实键鼠试过的下拉
  async function fillCombo(input, cands, ans) {
    if (!running) return false;
    const opts = await openCombo(input);
    if (opts.length) {
      const big = opts.length >= 90 || (opts.length >= 50 && !!(input.id && document.getElementById(input.id + '-dropdown-list-container')));
      let hit = big ? (ans && ans.numeric != null && pickRange(opts, ans.numeric)) || pickAny(opts, cands.slice(0, 1)) : chooseOption(opts, cands, ans);
      if (!hit && opts.length === 1 && /^(thank you|thanks|ok(ay)?|i understand|understood|acknowledged?|i acknowledge|noted|i agree|yes,? i (understand|agree|acknowledge))\.?!?$/i.test(opts[0].text.trim())) hit = opts[0];
      if (!hit && ans && /^(workAuthorized|AUTH_NO_SPONSOR|needSponsorship|sponsorship)$/.test(ans.key || '') && S.profile.needSponsorship === 'Yes') {
        const req = opts.filter((o) => /requir\w*\b(\W+\w+){0,4}\W+sponsor/i.test(o.text) && !/\b(not|n't|never|no|without)\b(\W+\w+){0,3}\W+(requir|need|sponsor)/i.test(o.text));
        if (req.length === 1) hit = req[0];
      }
      if (!hit && ans && ans.key === 'startMonth' && S.profile.availableStart) {
        const want = new Date(S.profile.availableStart).getMonth();
        const idx = (t) => MONTHS.findIndex((m) => norm(t).startsWith(m.slice(0, 3).toLowerCase()));
        const ms = opts.map((o) => ({ o, i: idx(o.text) })).filter((x) => x.i >= 0);
        if (ms.length) hit = ms.sort((a, b) => Math.min(Math.abs(a.i - want), 12 - Math.abs(a.i - want)) - Math.min(Math.abs(b.i - want), 12 - Math.abs(b.i - want)) || b.i - a.i)[0].o;
      }
      dbg('combo', questionFor(input), `| 选项（${opts.length}）`, opts.map((o) => o.text).slice(0, 10), '| 命中', hit && hit.text);
      if (hit && await clickComboOption(input, hit)) return true;
      if (!hit && !big) { comboDiag(input, cands, opts); input.blur(); return false; }
    }
    const full = [...new Set(cands.filter(Boolean).map(String))];
    const firstWords = full.map((t) => t.split(/[\s,(/]+/)[0]).filter((w) => w.length >= 3 && !full.some((t) => norm(t) === norm(w)));
    const terms = [...new Set([...full, ...firstWords])];
    for (const maxLevel of [1, 3]) {
      for (const term of terms) {
        if (!running) return false;
        if (document.activeElement !== input) mouseClick(input);
        if (input.value) { setNative(input, ''); await sleep(150); }
        typeInto(input, term);
        let hit = null;
        let noneSince = 0;
        for (let i = 0; i < 30 && !hit && running; i++) {
          await sleep(200);
          hit = (ans && ans.numeric != null && pickRange(comboOptions(input), ans.numeric)) || pickAny(comboOptions(input), cands, maxLevel);
          if (hit) break;
          if (comboSaysNoOptions(input)) { noneSince = noneSince || Date.now(); if (Date.now() - noneSince > 1200) break; } else noneSince = 0;
        }
        dbg('combo', questionFor(input), '| 搜', term, '| 选项', comboOptions(input).map((o) => o.text).slice(0, 8), '| 命中', hit && hit.text);
        if (hit && await clickComboOption(input, hit)) return true;
      }
    }
    if (!trustedTried.has(input) && terms.length && running) {
      trustedTried.add(input);
      for (const term of terms.slice(0, 2)) {
        if (!running || !(await trustedType(input, term))) break;
        let hit = null;
        for (let i = 0; i < 25 && !hit; i++) { await sleep(200); hit = pickAny(comboOptions(input), cands, 3) || pickAny(popupOptions(input), cands, 3); }
        dbg('combo 真实键盘', questionFor(input), term, '| 命中', hit && hit.text);
        if (!hit) continue;
        if ((await trustedClick(hit.el)) && (await waitFor(() => comboPicked(input, hit.text), 1500, 150))) { input.blur(); logAI(`⌨️ 用真实键鼠选好：${questionFor(input).slice(0, 40)} → ${hit.text.slice(0, 30)}`); return true; }
        if (hit.el.isConnected && await clickComboOption(input, hit)) return true;
      }
    }
    comboDiag(input, cands);
    if (input.value) typeInto(input, '');
    pressKey(input, 'Escape');
    input.blur();
    return false;
  }

  const diagDone = new Set();
  function comboDiag(input, cands, opened) {
    try {
      const qn = questionFor(input);
      const key = location.href.split('#')[0] + '|' + qn;
      if (diagDone.has(key)) return;
      diagDone.add(key);
      const desc = (e) => e ? `${e.tagName.toLowerCase()}${e.id ? '#' + e.id.slice(0, 30) : ''}${e.getAttribute('role') ? '[role=' + e.getAttribute('role') + ']' : ''}.${String(e.className || '').split(' ').filter(Boolean).slice(0, 3).join('.')}` : 'null';
      const kids = (r) => qa('li, [role="option"], [class*="option" i], [class*="item" i]', r).filter(isVisible).slice(0, 3).map((o) => desc(o) + '「' + textOf(o).slice(0, 25) + '」').join(' ');
      const ctl = input.getAttribute('aria-controls') || input.getAttribute('aria-owns');
      const own = ctl && document.getElementById(ctl);
      const menus = qa('[role="listbox"], [role="menu"], ul[class*="list" i], [class*="dropdown" i], [class*="menu" i], [class*="results" i], [class*="options" i]')
        .filter((m) => isVisible(m) && !m.closest('#wdaf-host') && m !== own).slice(0, 4);
      const text = `🔍 下拉诊断 ${qn.slice(0, 50)} | 想填 ${cands.slice(0, 3).join(' / ')} | 打开后选项 ${opened ? opened.length + '：' + opened.slice(0, 6).map((o) => o.text.slice(0, 20)).join('，') : '无'} | 输入框 ${desc(input)} role=${input.getAttribute('role')} ac=${input.getAttribute('aria-autocomplete')} exp=${input.getAttribute('aria-expanded')} value=「${input.value.slice(0, 30)}」`
        + ` | aria-controls=${ctl || '无'} → ${own ? desc(own) + (isVisible(own) ? '(可见)' : '(不可见)') + ' 子项 ' + kids(own) : '找不到'}`
        + ` | 页面上的菜单 ${menus.map((m) => desc(m) + ' 子项 ' + kids(m)).join(' ‖ ') || '无'}`;
      dbg(text);
      askAI({ action: 'note', text: text.slice(0, 1500), url: location.href.split('#')[0], title: document.title.slice(0, 120), build: BUILD }, 15000).catch(() => {});
    } catch (e) { dbg('下拉诊断失败', e); }
  }

  function dateWanted(question, sec) {
    const label = norm(question);
    const P = S.profile;
    if (/^if (yes|no|so|you answered)\b/.test(label)) return null;
    if (/education/i.test(sec || '')) {
      if (/first|from|start/.test(label)) return { month: P.eduStartMonth, year: P.eduStartYear };
      if (/last|^to\b|end|graduat|expected/.test(label)) return { month: P.eduEndMonth, day: GRAD_DAY, year: P.eduEndYear };
    }
    if (/graduat|(complete|finish|completion of) (all |your |the )*(degree|program|studies)|eligible to (begin|start) (an )?(entry[- ]level )?full[- ]time/.test(label)) return { month: P.eduEndMonth, day: GRAD_DAY, year: P.eduEndYear };
    if (P.availableStart && /(desired|earliest|preferred|available|availability|possible) (start|starting)( date)?|start date|date (you are |you're )?available|when (can|could) you start|availab\w* (to|for) (start|begin|commence)|when (would|will|can|could) you (be able to |be available to )?(start|begin)|start(ing)? availability/.test(label)) {
      const d = new Date(P.availableStart);
      if (!isNaN(d)) return { month: d.getMonth() + 1, day: d.getDate(), year: d.getFullYear() };
    }
    if (/^date$|today|signed|signature date/.test(label)) {
      const d = new Date();
      return { month: d.getMonth() + 1, day: d.getDate(), year: d.getFullYear() };
    }
    return null;
  }

  const pad2 = (n) => String(n).padStart(2, '0');

  function naAnswer(f) {
    if (f.kind !== 'text' || !isRequired(f)) return null;
    const qn = norm(f.question);
    if (/reason(s|\(s\))? for leaving/.test(qn)) return null; // 离职原因：资料里有，按规则写，不填 N/A
    return /^(\(\w+\)\s*)?if (the answer is |you answered |your answer is )?["“']?yes\b|please (list|write|enter|type|put) ["“']?n\/?a\b|if not applicable,? (please )?(put|write|enter|type) ["“']?n\/?a\b/.test(qn) ? { value: 'N/A' } : null;
  }

  function workAnswer(f) {
    if (f.block !== 'employer' || f.empIdx == null) return null;
    const jobs = Array.isArray(S.profile.workHistory) ? S.profile.workHistory : [];
    const job = jobs[f.empIdx];
    const q = norm(f.question);
    if (!job) return f.kind === 'text' ? { value: 'N/A' } : /current employer/.test(q) ? { value: 'No' } : null;
    const part = (mmyy) => {
      const d = String(mmyy || '').match(/^(\d{1,2})\/(\d{4})$/);
      if (!d) return mmyy ? { value: mmyy } : null;
      if (f.datePart === 'month') return { value: MONTHS[Number(d[1]) - 1], alts: monthCands(d[1]) };
      if (f.datePart === 'day') return { value: '1', alts: ['1', '01'] };
      if (f.datePart === 'year') return { value: d[2] };
      if (/month/.test(q)) return { value: MONTHS[Number(d[1]) - 1], alts: monthCands(d[1]) };
      if (/year/.test(q)) return { value: d[2] };
      return { value: mmyy };
    };
    let v = null;
    let addr = false; // 雇主地址那几格：网站读简历预填的（Paylocity：街道写成「Shanghai, China」、国家默认 United States）对不上资料就覆盖
    if (/employer name|company name|^(\d+\.\s*)?(employer|company)$/.test(q)) v = job.company;
    else if (/current (employer|role|position|job)|currently (work|employed)|still employed/.test(q)) {
      if (f.kind === 'checkbox') return job.current ? { value: 'CHECK' } : null;
      v = job.current ? 'Yes' : 'No';
    }
    else if (/duration|date range|dates? of employment|employment dates|period of employment/.test(q)) return { value: 'RANGE', range: [job.start, job.current ? '' : job.end] };
    else if (/start date|date started|^from\b|start \(/.test(q)) return part(job.start);
    else if (/end date|date (ended|left)|^to\b|end \(/.test(q)) return job.current ? (/month|year/.test(q) ? null : { value: 'Present' }) : part(job.end);
    else if (/job title|position title|^title$|^position$/.test(q)) v = job.title;
    else if (/^country\b/.test(q)) { v = job.country || (/china/i.test(job.location || '') ? 'China' : null); return v ? { value: v, empAddr: true, first: true } : null; } // 先填国家：改了会刷新下面的地址栏
    else if (/^(state|province|region|administrative area)\b/.test(q)) addr = v = (/administrative area/.test(q) && job.adminArea) || job.state || (/china/i.test(job.country || job.location || '') ? job.city : null) || null; // Paylocity「Administrative Area」：资料里该雇主的 adminArea（区）；没有就按国家：中国的公司没有州，填城市（直辖市）
    else if (/^county\b/.test(q)) addr = v = job.county || null;
    else if (/^(zip|postal)/.test(q)) return job.zip ? { value: job.zip, key: 'empStreet', empAddr: true } : null; // Paylocity 的邮编也是联想框（200120 联想不出来）：直接写
    else if (/^(street|address)( line)? ?1\b/.test(q) && job.address) return { value: streetLines(job)[0], key: 'empStreet', empAddr: true };
    else if (/^(street|address)( line)? ?1?\b(?!.*2)/.test(q)) { v = job.address || job.location; return v ? { value: v, key: 'empStreet', empAddr: !!job.address } : null; }
    else if (/^address( line)? ?2\b/.test(q)) addr = v = job.address ? streetLines(job)[1] || null : null;
    else if (/^city\b/.test(q)) { v = job.city || (job.location || '').split(',')[0]; addr = !!job.city; }
    else if (/location|city/.test(q)) v = /zip/.test(q) && job.state && job.zip ? `${job.city}, ${job.state} ${job.zip}` : job.location;
    else if (/responsibilit|duties|nature of the work|summar|describe|^description$|job description/.test(q)) v = descLines(job.summary);
    else if (/reason for leaving|why did you leave/.test(q)) v = job.reason;
    else if (/phone/.test(q)) v = job.phone ? (/^\+(?!1\b)\d/.test(job.phone.trim()) ? '+' + job.phone.replace(/\D/g, '') : job.phone) : null;
    return v ? (addr ? { value: v, empAddr: true } : { value: v }) : null;
  }

  function streetLines(job) {
    const parts = String(job.address || '').split(/,\s*/).map((x) => x.trim()).filter(Boolean)
      .filter((x) => !job.adminArea || norm(x) !== norm(job.adminArea));
    const i = parts.findIndex((x) => /^\d+[a-z]?\s+[a-z]/i.test(x));
    if (i < 0) return [parts.join(', '), ''];
    return [parts[i], parts.filter((_, k) => k !== i).join(', ')];
  }

  function textDateAnswer(f) {
    if (f.kind !== 'text' || f.block === 'employer' || f.block === 'reference') return null;
    const q = norm(f.question);
    const ph = norm(f.el.getAttribute('placeholder'));
    const iso = /^yyyy-mm$/.test(ph) || /\byyyy-mm\b(?!-)|year-month/.test(q);
    if (iso && !/graduat|degree|school|education|enrol|stud(y|ies|ent)/.test(q)) return null;
    if (!iso && !/mm\s*\/\s*(yyyy|yy)|month\s*\/\s*year/.test(q + ' ' + ph)) return null;
    const fmt = (m, y) => (iso ? `${y}-${pad2(m)}` : `${pad2(m)}/${y}`);
    const P = S.profile;
    if (/\bend\b|graduat|completion|until|^to\b/.test(q)) {
      if (/present/.test(q) && P.enrolled === 'Yes') return { value: 'Present' }; // 「仍在读写 Present」
      return P.eduEndMonth && P.eduEndYear ? { value: fmt(P.eduEndMonth, P.eduEndYear) } : null;
    }
    if (/start|begin|from|attendance|enroll/.test(q)) return P.eduStartMonth && P.eduStartYear ? { value: fmt(P.eduStartMonth, P.eduStartYear) } : null;
    return null;
  }

  function otherFollowAnswer(f) {
    if (f.kind !== 'text' || !S.profile.source) return null;
    if (!/^\(?if (you (answered|selected|chose) )?["“']?(yes, )?other\b|^other,? (please )?(specify|explain)/.test(norm(f.question))) return null;
    const before = qa('input[role="combobox"], select, input[type="radio"]:checked', formScope())
      .filter((e) => !e.closest('#wdaf-host') && (e.compareDocumentPosition(f.el) & Node.DOCUMENT_POSITION_FOLLOWING))
      .slice(-4).reverse();
    for (const e of before) {
      const q = e.type === 'radio' ? textOf(e.closest('fieldset')?.querySelector('legend') || e.closest('[role="radiogroup"]') || e) : questionFor(e);
      const a = e.type === 'radio' ? choiceLabel(e) : e.tagName === 'SELECT' ? e.selectedOptions[0]?.text || '' : comboValue(e);
      if (!norm(a) || PLACEHOLDER_OPT_RE.test(a.trim())) return { value: '' };
      const isOther = /^other\b|^yes, other\b/.test(norm(a));
      const na = /if not applicable|put n\/?a|write n\/?a/.test(norm(f.question)) ? { value: 'N/A' } : null;
      if (SOURCE_RE.test(norm(q))) return isOther ? { key: 'source', value: S.profile.source } : na;
      if (/undergrad/.test(norm(q)) && /(school|university|college|institution)/.test(norm(q))) return isOther && S.profile.undergradSchool ? { key: 'undergradSchool', value: S.profile.undergradSchool } : na;
      return isOther ? null : na; // 别的题选了 Other：留给 AI 写；没选 Other 就 N/A
    }
    return null;
  }

  const AGREE_Q_RE = /terms|agreement|consent|disclaimer|privacy|acknowledg|attest|certif|i agree|read and agree|agree (with|to) the (above|following)|policy|notice|^i understand|^(please )?confirm/;
  const AGREE_SKIP_RE = /subject to|bound by|non-?compet|have you signed|marketing|newsletter|promotional|talent (community|network|pool)|future (job )?(opportunit|openings)|receive (emails|updates|communications)/;
  const AGREE_OPTS = ['I Agree', 'Agree', 'I Accept', 'Accept', 'I Acknowledge', 'Acknowledge', 'Acknowledged', 'I Consent', 'Consent', 'Confirmed', 'I Confirm', 'Confirm', 'Ok', 'OK', 'I Understand', 'I have read and agree', 'I have read'];
  function agreeAnswer(f) {
    if (!S.settings.acceptTerms || !['combo', 'select', 'listbox', 'radio', 'popcombo'].includes(f.kind)) return null;
    const q = norm(f.question);
    const stmt = /^i (hereby )?(certify|attest|acknowledge|understand|agree|authori[sz]e|confirm|declare)/.test(q) && !/marketing|newsletter|promotional|talent (community|network|pool)/.test(q);
    if (!AGREE_Q_RE.test(q) || (AGREE_SKIP_RE.test(q) && !stmt)) return null;
    const yesOk = /^(please )?(confirm|acknowledge)|^i (have )?(understand|acknowledge|agree|consent|confirm|certify|read|reviewed)/.test(q)
      || (/privacy|terms|consent|acknowledg|agree|policy|notice|disclaimer|attest/.test(q) && !/\b(do|does|have|has|are|were|did) you (currently )?(have|hold|possess|own|obtain)/.test(q));
    const alts = yesOk ? [...AGREE_OPTS, 'Yes'] : AGREE_OPTS;
    return { key: 'AGREE', value: alts[0], alts };
  }

  function ackAnswer(f) {
    if (!S.settings.acceptTerms) return null;
    if (f.kind === 'checkbox') return /^(i have read|i acknowledge|i understand|acknowledged|understood|i consent|i agree|i accept|(you|i) declare that (you|i) (have )?read)\b/i.test(choiceLabel(f.el).trim()) && !/marketing|newsletter|promotional|talent (community|network|pool)|job alert|text message|\bsms\b|whatsapp|future (job )?(opportunit|openings)/i.test(f.question) ? { value: 'CHECK' } : null;
    if (f.kind === 'checkgroup' && f.els.length === 1) { const t = choiceLabel(f.els[0]); return /^(i have read|i acknowledge|i understand|acknowledged|understood)\b/i.test(t.trim()) ? { value: t } : null; }
    if (f.kind !== 'radio' || f.els.length !== 1) return null;
    const t = choiceLabel(f.els[0]);
    return /i have read|i acknowledge|i understand|acknowledged/i.test(t) ? { value: t } : null;
  }

  const olPopper = () => qa('.el-popper.ol-select-list').find(isVisible);
  function closeOlList() { if (olPopper()) { document.body.click(); } }
  const olItems = (pop) => qa('.ol-select-list__item', pop).filter(isVisible).map((el) => ({ el, text: textOf(q('.ol-select-list__item--label', el) || el) }));
  async function olListOptions(input) {
    if (!olPopper()) { (input.closest('.ol-popper__trigger') || input).click(); await waitFor(olPopper, 1500); }
    const pop = olPopper();
    return pop ? olItems(pop) : [];
  }
  async function fillOlList(input, cands, ans) {
    let opts = await olListOptions(input);
    const pop = olPopper();
    if (!pop) { dbg('自定义下拉没弹出', questionFor(input)); return false; }
    let hit = opts.length ? chooseOption(opts, cands, ans) : null;
    const search = q('.ol-select-list__header input', pop);
    for (const c of cands) {
      if (hit || !search) break;
      setText(search, String(c));
      await sleep(500);
      opts = olItems(pop);
      hit = pickAny(opts, [c], 1);
    }
    if (!hit) { dbg('自定义下拉里没有', questionFor(input), cands.slice(0, 3)); closeOlList(); return false; }
    hit.el.click();
    await waitFor(() => norm(input.value) === norm(hit.text), 1500);
    closeOlList();
    return !!input.value.trim();
  }


  const POP_EMPTY_RE = /^$|make a selection|^select( one| an option)?\b|^choose\b|^please select|^[-—–\s]+$/i;
  const popText = (el) => cleanLabel(textOf(el)).replace(/^[-—–\s]+|[-—–\s]+$/g, '');
  async function openPopCombo(el) {
    comboBefore.set(el, new Set(visiblePopups()));
    if (el.getAttribute('aria-expanded') !== 'true') mouseClick(el);
    const ctlOpts = () => { const c = document.getElementById(el.getAttribute('aria-controls') || ''); return c && isVisible(c) ? optionEls(c).filter(isVisible).map((o) => ({ el: o, text: textOf(o) })).filter((o) => o.text && o.text.length <= 150) : []; };
    const opts = await waitFor(() => { const c = ctlOpts(); const o = (c.length ? c : popupOptions(el)).filter((x) => !POP_EMPTY_RE.test(popText(x.el))); return o.length ? o : null; }, 2500, 150);
    return opts || [];
  }
  function closePopCombo(el) {
    if (el.getAttribute('aria-expanded') === 'true' || newPopups(el).length) mouseClick(el);
  }
  async function fillPopCombo(el, cands, ans) {
    let opts = await openPopCombo(el);
    let hit = opts.length ? chooseOption(opts, cands, ans) : null;
    const pop = newPopups(el).find((x) => q('input', x));
    const search = pop && q('input:not([type="hidden"])', pop);
    for (const c of cands.filter(Boolean).map(String)) {
      if (hit || !search) break;
      typeInto(search, c);
      search.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));
      await sleep(700);
      opts = popupOptions(el).filter((x) => !POP_EMPTY_RE.test(popText(x.el)));
      hit = pickAny(opts, [c], 1);
    }
    dbg('popcombo', questionFor(el), '| 选项', opts.length, opts.slice(0, 8).map((o) => o.text), '| 命中', hit && hit.text);
    if (!hit) { comboDiag(el, cands, opts); closePopCombo(el); return false; }
    hit.el.scrollIntoView?.({ block: 'nearest' });
    mouseClick(hit.el);
    const ok = await waitFor(() => !POP_EMPTY_RE.test(popText(el)), 1500, 150);
    if (!ok) closePopCombo(el);
    return !!ok;
  }

  const visibleVc = () => qa('.vc-container').find(isVisible);
  async function openVc(input) {
    if (!visibleVc()) {
      (input.closest('.ol-date-picker__trigger') || input.closest('.el-input') || input).click();
      await waitFor(visibleVc, 1500);
    }
    if (!visibleVc()) dbg('日期：弹出日历没打开', questionFor(input));
    return !!visibleVc();
  }
  async function vcGoTo(d) {
    const want = d.getFullYear() * 12 + d.getMonth();
    const shown = () => qa('.vc-title, .vc-title-wrapper', visibleVc()).map((t) => {
      const m = textOf(t).match(/^([A-Za-z]+)\s+(\d{4})$/);
      const mi = m ? MONTHS.findIndex((mo) => mo.toLowerCase().startsWith(m[1].slice(0, 3).toLowerCase())) : -1;
      return m && mi >= 0 ? Number(m[2]) * 12 + mi : null;
    }).filter((x) => x != null);
    for (let i = 0; i < 72; i++) {
      const sh = shown();
      if (!sh.length) return false;
      if (sh.includes(want)) return true;
      const btn = q(sh[0] > want ? '.vc-arrow.vc-prev' : '.vc-arrow.vc-next', visibleVc());
      if (!btn) return false;
      btn.click();
      await sleep(120);
    }
    return false;
  }
  function vcDay(d) {
    const id = `id-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const vc = visibleVc();
    return vc && (q(`.vc-day.${id}:not(.is-not-in-month) .vc-day-content`, vc) || q(`.vc-day.${id} .vc-day-content`, vc) || q(`.vc-day.${id}`, vc));
  }
  async function fillVcDate(input, value) {
    const d = new Date(value);
    if (isNaN(d) || !(await openVc(input))) return false;
    if (!(await vcGoTo(d))) { dbg('日期：翻不到', d.toDateString()); return false; }
    const day = vcDay(d);
    if (!day) { dbg('日期：日历里没有这一天', d.toDateString()); return false; }
    day.click();
    await waitFor(() => input.value.trim(), 1500);
    return !!input.value.trim();
  }
  async function fillVcRange(input, range) {
    const parse = (s) => { const m = String(s || '').match(/^(\d{1,2})\/(\d{4})$/); return m ? new Date(Number(m[2]), Number(m[1]) - 1, 1) : null; };
    const start = parse(range[0]);
    if (!start) return false;
    let end = parse(range[1]);
    end = end ? new Date(end.getFullYear(), end.getMonth() + 1, 0) : new Date();
    if (end < start) end = start;
    if (!(await openVc(input))) return false;
    for (const d of [start, end]) {
      if (!(await vcGoTo(d))) { dbg('日期范围：翻不到', d.toDateString()); return false; }
      const day = vcDay(d);
      if (!day) { dbg('日期范围：日历里没有这一天', d.toDateString()); return false; }
      day.click();
      await sleep(300);
    }
    await waitFor(() => input.value.trim(), 1500);
    return !!input.value.trim();
  }

  function dateAnswer(f) {
    if (f.kind !== 'date' && !f.datePart) return null;
    const w = dateWanted(f.question, precedingHeading(f.el));
    if (!w) return null;
    if (f.kind === 'date') {
      if (!w.year || !w.month) return null;
      return { value: f.el.type === 'month' ? `${w.year}-${pad2(w.month)}` : `${w.year}-${pad2(w.month)}-${pad2(w.day || 1)}` };
    }
    const v = w[f.datePart];
    if (!v) return null;
    const cands = f.datePart === 'month' ? monthCands(v) : f.datePart === 'day' ? [String(Number(v)), pad2(v)] : [String(v)];
    return { value: cands[0], alts: cands };
  }

  async function fillField(f, ans) {
    excludeRe = ans.key === 'degree'
      ? new RegExp([!/mba|business admin/i.test(S.profile.degree || '') && '\\bm\\.?b\\.?a\\b|business administration', S.profile.enrolled !== 'No' && '[-–—]\\s*(complete|completed|graduated)\\s*$'].filter(Boolean).join('|') || '$^', 'i')
      : ans.key === 'source' ? /\buniversity\b|\bcampus\b|\bschool\b|\bcollege\b|academic|faculty|career (fair|services)/i
      : (ans.key === 'workAuthorized' || ans.key === 'AUTH_NO_SPONSOR') && S.profile.needSponsorship === 'Yes' ? /any employer|without (the need for |needing |requiring |requirement of )?(an? )?(employer |visa )?sponsor|(do not|don'?t|will not|won'?t|never) (need|require) (\w+ )?sponsor|no sponsorship|unrestricted|without restriction|permanent(ly)? (resident|authori)|u\.?s\.? citizen|green card/i
      : ans.key === 'visaStatus' ? /\bopt\b|stem|h-?1b|h-?4|l-?[12]|tn\b|e-?3|j-?[12]|o-?1|0-1|daca|citizen|permanent|green card|not applicable/i
      : ans.key === 'veteran' && /^not a protected veteran$/i.test(S.profile.veteran || '') ? /identify as (a |one or more)|\bi am a (protected )?veteran/i
      : null;
    try {
      if (ans.key === 'degree' && S.profile.enrolled !== 'No') {
        const base = excludeRe;
        excludeRe = new RegExp(base.source + '|[-–—]\\s*(incomplete|not completed)\\s*$', 'i');
        const r = await fillFieldInner(f, ans);
        if (r) return r;
        excludeRe = base;
      }
      return await fillFieldInner(f, ans);
    } finally { excludeRe = null; }
  }

  const isMultiCombo = (el) => !!q('[class*="is-multi"], [class*="multi-value"], .MuiChip-root', comboBox(el)) || el.getAttribute('aria-multiselectable') === 'true';

  async function fillFieldInner(f, ans) {
    const v = ans.value;
    const cands = candsOf(ans);
    switch (f.kind) {
      case 'text': {
        if (Array.isArray(v)) return false;
        if (ans.key === 'phone') {
          let cs = null;
          for (let b = f.el.parentElement, i = 0; b && i < 6 && !cs; b = b.parentElement, i++) cs = q('select.PhoneInputCountrySelect, select[name*="phonecountry" i], select[name*="phone_country" i]', b);
          const us = cs && [...cs.options].find((o) => /^US$/i.test(o.value) || /^united states( of america)?\b/i.test(o.text.trim()));
          if (us && cs.value !== us.value) { setNative(cs, us.value); await sleep(300); }
          if (cs) { setText(f.el, '+1' + String(v).replace(/\D/g, '')); return true; }
        }
        setText(f.el, v);
        return true;
      }
      case 'select': {
        const ready = () => !f.el.isConnected || [...f.el.options].some((o) => o.value !== '');
        if (!ready()) await waitFor(ready, 3000, 200);
        if (!f.el.isConnected) return 'stale'; // 等的时候页面把这个下拉框重建了，重新扫描再填
        const opts = [...f.el.options].filter((o) => o.value !== '' && !isPlaceholderOpt(o)).map((o) => ({ el: o, text: o.text }));
        const hit = chooseOption(opts, cands, ans);
        if (f.s2) {
          if (opts.length) return !!hit && fillSelect2(f, (os) => os.find((o) => norm(o.text) === norm(hit.text)), [hit.text]);
          const terms = [...new Set(cands.filter(Boolean).map(String))];
          return fillSelect2(f, (os, lv) => pickAny(os, cands, lv), terms);
        }
        if (!hit) return false;
        setNative(f.el, hit.el.value);
        return true;
      }
      case 'date':
        if (f.vc) return ans.range ? fillVcRange(f.el, ans.range) : fillVcDate(f.el, v);
        setNative(f.el, v);
        f.el.blur();
        return f.el.value === v;
      case 'listbox': return fillListbox(f.el, Array.isArray(v) ? [v[0]] : cands, ans);
      case 'prompt': return fillPrompt(f.el, cands, !Array.isArray(v));
      case 'popcombo': return fillPopCombo(f.el, Array.isArray(v) ? v : cands, ans);
      case 'combo': {
        if (f.srAc) return fillSrSelect(f, Array.isArray(v) ? v.map(String) : cands, ans);
        if (ans.key === 'address1Combo') return fillAddressCombo(f.el, v);
        if (ans.key === 'AI' && typeof v === 'string' && /address|postal|zip/i.test(`${f.el.id || ''} ${f.el.name || ''}`)) ans = { ...ans, key: 'empStreet' };
        if (ans.key === 'empStreet' && typeof v === 'string') { typeInto(f.el, v); await sleep(400); f.el.blur(); await sleep(200); return norm(f.el.value) === norm(v); }
        if (f.ol) return fillOlList(f.el, Array.isArray(v) ? v : cands, ans);
        if (!Array.isArray(v)) return fillCombo(f.el, cands, ans);
        let any = false; // 多选（技能、语言）：一个个加；单选下拉只填第一个
        const multi = isMultiCombo(f.el);
        for (const item of multi ? v : v.slice(0, 1)) if (await fillCombo(f.el, promptCands(item))) any = true;
        return any;
      }
      case 'radio': case 'checkgroup': {
        const opts = f.els.map((el) => ({ el, text: choiceLabel(el) }));
        if (f.kind === 'checkgroup' && Array.isArray(v)) {
          let any = false;
          for (const item of v) {
            const hit = pickAny(opts, promptCands(item), 1);
            if (hit && (isChecked(hit.el) || clickChoice(hit.el))) any = true;
          }
          return any;
        }
        const hit = chooseOption(opts, cands, ans);
        return hit ? (isChecked(hit.el) || (await clickChoiceReal(hit.el))) : false;
      }
      case 'checkbox':
        if (v !== 'CHECK' && !/^(yes|true|check)$/i.test(v)) return false;
        return clickChoiceReal(f.el);
      default: return false;
    }
  }


  function resumeFile(R) {
    const bin = atob(R.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], R.name, { type: R.type || 'application/pdf' });
  }

  const uploadedInputs = new WeakSet();
  const uploadedZones = new Set(); // 已经传过简历的栏（小节标题 + 上传框名字）

  function fileAnchor(input) {
    if (!input.classList || !input.classList.contains('dz-hidden-input')) return input;
    const hidden = qa('input.dz-hidden-input');
    const zones = qa('.dz-clickable').filter((z) => !z.closest('#wdaf-host'));
    return hidden.length === zones.length ? zones[hidden.indexOf(input)] || input : input;
  }
  function fileZone(input) {
    const a = fileAnchor(input);
    let zone = a === input ? input.parentElement : a;
    for (let p = zone, i = 0; p && i < 6 && textOf(p).length < 600; i++, p = p.parentElement) {
      if (qa('input[type="file"], .dz-clickable', p).filter((x) => x !== a && !a.contains(x)).length > (a === input ? 1 : 0)) break;
      zone = p;
    }
    return zone || document.body;
  }
  function fileCtxOwn(input) {
    const h = shadowHost(input); // SmartRecruiters：spl-dropzone 组件的 label / data-test，和它外面那一段的文字（「Resume」小节）
    return [input.id, input.name, input.getAttribute('aria-label'), ...[...(input.labels || [])].map(textOf), textOf(fileZone(input)), ...(h ? [h.getAttribute('label'), h.getAttribute('data-test'), textOf(h.parentElement).slice(0, 200)] : [])].join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }
  function fileCtx(input) {
    const zone = fileZone(input);
    return [fileCtxOwn(input), precedingText(zone), precedingHeading(input)].join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  const AUTOFILL_UP_RE = /autofill|auto-fill|autocomplete your application|parse your resume|import (your )?(resume|profile)/i;
  function inAutofillZone(el) {
    if (/apply-with-resume|autofill|parse/i.test(hostAttr(el, 'data-test'))) return true; // SmartRecruiters 顶上「用简历自动填」的上传框
    let e = el;
    for (let i = 0; i < 4 && e && e !== document.body; i++, e = e.parentElement) {
      if (AUTOFILL_UP_RE.test(textOf(e).slice(0, 300)) && qa('input[type="file"]', e).length <= 1) return true;
    }
    return false;
  }

  function resumeInputs() {
    const ctx = fileCtxOwn;
    const raw = [...qa('input[type="file"]'), ...(isSR() ? shadowQa('input[type="file"]') : [])].filter((i) => !i.disabled && !i.closest('#wdaf-host'));
    const real = raw.filter((i) => !inAutofillZone(i));
    const all = real.length ? real : raw;
    const scored = all.map((i) => ({ i, t: ctx(i) }));
    const resume = scored.filter((s) => /resume|\bcv\b|curriculum/.test(s.t) && !/cover|transcript|letter|portfolio|writing sample/.test(s.t));
    if (resume.length) return resume.map((s) => s.i);
    const vague = scored.filter((s) => !/resume|\bcv\b|curriculum|cover|transcript|letter|motivation|portfolio|writing|sample|certificat|licen|enrol|proof/.test(s.t));
    const byCtx = vague.find((s) => /resume|\bcv\b|curriculum/.test(fileCtx(s.i)) && !/cover|transcript|motivation|portfolio|writing sample/.test(fileCtx(s.i).replace(/upload your cv|resume\/cv|cv\/resume/g, '')));
    if (byCtx) return [byCtx.i];
    return all.length === 1 && !/cover|transcript|letter|portfolio|enrol|proof of|writing sample|certificat|licen/.test(fileCtx(all[0])) ? all : [];
  }

  async function uploadTranscript() {
    const T = S.transcript;
    if (!T || !T.data) return false;
    let n = 0;
    const inputs = qa('input[type="file"]').filter((i) => !i.disabled && !i.closest('#wdaf-host'))
      .filter((i) => { const t = fileCtxOwn(i); return /transcript/.test(t) && !/resume|\bcv\b|cover letter|enrol|proof of|acceptance letter/.test(t) && !(/\bgraduate\b/.test(t) && !/undergrad/.test(t)); })
      .filter((i, _, all) => !(all.length > 1 && /additional|another|second|other transcript/.test(fileCtxOwn(i))));
    for (const input of inputs) {
      if ((input.files && input.files.length) || uploadedInputs.has(input)) continue;
      const zkey = 'tr|' + location.pathname + '|' + (input.name || String(input.id).replace(/[-_]?\d+$/, '')) + '|' + precedingHeading(input);
      if (uploadedZones.has(zkey)) continue;
      uploadedZones.add(zkey);
      const zone = input.closest('[data-automation-id^="formField"]') || fileZone(input);
      if (textOf(zone).includes(T.name)) continue; // 已经传过
      uploadedInputs.add(input);
      const dt = new DataTransfer();
      dt.items.add(resumeFile(T));
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      setStatus(`正在上传成绩单：${T.name}…`);
      await waitFor(() => textOf(zone).includes(T.name) || /successfully uploaded/i.test(textOf(zone)), 8000, 400);
      n++;
    }
    return n > 0;
  }


  const RESUME_BTN_RE = /^(upload|attach|add)( a| your)? (resume|cv)$/i;
  const CL_BTN_RE = /^(upload|attach|add)( a| your)? cover letter$/i;
  function uploadDialogButton(re) {
    for (const b of qa('button, [role="button"], a', formScope())) {
      if (b.closest('#wdaf-host') || !re.test(cleanLabel(b.textContent || ''))) continue;
      if (isVisible(b)) return b;
      let outer = b.parentElement;
      for (let i = 0; outer && i < 3 && !isVisible(outer); i++) outer = outer.parentElement;
      if (!outer || !isVisible(outer)) continue;
      const btn = qa('[role="button"], button', outer).find(isVisible) || qa('[onclick]', outer).find(isVisible);
      if (btn) return btn;
      const area = (e) => e.offsetWidth * e.offsetHeight;
      const inner = qa('*', outer).filter((e) => isVisible(e) && area(e) > 100 && re.test(cleanLabel(e.textContent || ''))).sort((x, y) => area(y) - area(x))[0];
      return inner || outer;
    }
    return null;
  }
  const PRIVACY_LINK_RE = /^read and accept (the )?(data )?privacy (statement|policy|consent)/i;
  async function acceptPrivacyLink() {
    if (!S.settings.acceptTerms) return 0;
    const a = qa('a, [role="link"], button', formScope()).find((e) => isVisible(e) && !e.closest('#wdaf-host') && PRIVACY_LINK_RE.test(cleanLabel(textOf(e))));
    if (!a) return 0;
    const box = a.closest('td, li, .row, div') || a.parentElement;
    const hid = box && q('input[type="hidden"]', box);
    if (hid && hid.value) return 0; // 已经接受过
    a.click();
    const acc = await waitFor(() => qa('[role="dialog"] button, .fd-dialog button, .sf-overlay button, [class*="dialog" i] button, [class*="modal" i] button')
      .find((b) => isVisible(b) && !b.closest('#wdaf-host') && /^(i )?(accept|agree)$/i.test(cleanLabel(textOf(b)))), 4000, 200);
    if (!acc) { dbg('隐私声明弹窗里没找到 Accept'); return 0; }
    acc.click();
    await waitFor(() => !isVisible(acc), 3000, 200);
    dbg('隐私声明：已接受', hid && hid.value);
    return 1;
  }

  const pickerLabel = (b) => cleanLabel(`${precedingText(b) || ''} ${textOf(b)}`);
  async function uploadViaChooser(btn, name, b64) {
    if (S.settings.trustedInput === false) return false;
    const saved = await askAI({ action: 'saveUpload', name, data: b64 }, 30000).catch(() => null);
    if (!saved || !saved.ok || !saved.path) { dbg('上传：文件没存上', saved && saved.error); return false; }
    const armed = await new Promise((res) => { try { chrome.runtime.sendMessage({ type: 'armChooser', path: saved.path }, (x) => { void chrome.runtime.lastError; res(x || {}); }); } catch (_) { res({}); } });
    if (!armed.ok) { dbg('上传：没接管上选文件窗口', armed.error); return false; }
    const zone = btn.parentElement && btn.parentElement.parentElement ? btn.parentElement.parentElement : document.body;
    const before = textOf(zone);
    if (!(await trustedClick(btn))) btn.click();
    const ok = await waitFor(() => textOf(zone).includes(name) || (textOf(zone) !== before && /\.(pdf|docx?)\b/i.test(textOf(zone))), 15000, 400);
    dbg('上传（接管选文件窗口）', name, ok ? '成功' : '没看到文件名');
    return !!ok;
  }

  async function uploadViaDialog(btn, file, doneText) {
    const before = new Set(qa('input[type="file"]'));
    btn.click();
    const input = await waitFor(() => qa('input[type="file"]').find((i) => !i.disabled && !before.has(i))
      || qa('input[type="file"]').find((i) => !i.disabled && isVisible(i) && !i.files?.length && i.closest('[class*="globalContent" i], [role="dialog"], [class*="dialog" i], [class*="popup" i], [class*="modal" i]')), 5000, 200);
    if (!input) { dbg('上传弹窗里没找到上传框', textOf(btn)); return false; }
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return !!(await waitFor(() => textOf(document.body).includes(doneText), 15000, 400));
  }

  const GF_ADD_RE = /^(添加文件|add file|上传文件)$/i;
  const gformAddButtons = () => qa('[role="listitem"]').filter(isVisible).map((li) => ({ li, btn: qa('[role="button"], button', li).find((b) => isVisible(b) && GF_ADD_RE.test(textOf(b).trim())) })).filter((x) => x.btn);
  function gformButton(re) {
    const hit = gformAddButtons().find(({ li }) => re.test(textOf(q('[role="heading"]', li)) || ''));
    return hit ? hit.btn : null;
  }
  async function gformUpload(btn, file) {
    const li = btn.closest('[role="listitem"]');
    const pickers = () => qa('iframe').filter((f) => /\/picker/.test(f.src || '') && f.offsetWidth > 200);
    const before = new Set(qa('iframe'));
    btn.click();
    const fr = await waitFor(() => pickers().find((f) => !before.has(f)) || pickers().pop(), 8000, 300);
    if (!fr) { dbg('Google 表单：选择框没打开'); return false; }
    const uploaded = () => !qa('[role="button"], button', li).some((b) => isVisible(b) && GF_ADD_RE.test(textOf(b).trim()));
    for (let attempt = 0; attempt < 3; attempt++) {
      const input = await waitFor(() => {
        try {
          const d = fr.contentDocument;
          return d && /浏览|browse/i.test(textOf(d.body)) ? d.querySelector('input[type="file"]') : null;
        } catch (_) { return null; }
      }, 10000, 300);
      if (!input) break;
      await sleep(600);
      const inp = fr.contentDocument.querySelector('input[type="file"]') || input;
      const dt = new DataTransfer();
      dt.items.add(file);
      inp.files = dt.files;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      if (await waitFor(uploaded, 12000, 500)) return true;
      dbg('Google 表单：放进去了没开始上传，再试', attempt + 1, inp.files && inp.files.length);
    }
    return !!(await waitFor(uploaded, 8000, 500));
  }

  async function uploadResume() {
    const pick = await chooseResume();
    if (!pick) return false;
    currentPick = pick;
    const R = pick.resume;
    if (!isWD()) {
      for (const input of resumeInputs()) {
        if ((input.files && input.files.length) || uploadedInputs.has(input)) continue;
        const zkey = location.pathname + '|' + (input.name || String(input.id).replace(/[-_]?\d+$/, '')) + '|' + precedingHeading(input);
        if (uploadedZones.has(zkey)) continue;
        const sKey = 'wdaf-up|' + zkey;
        let seenName = false;
        for (let z = fileAnchor(input) === input ? input.parentElement : fileAnchor(input), i = 0; z && i < 6; z = z.parentElement, i++) {
          if (S.resumes.some((r) => textOf(z).includes(r.name))) { seenName = true; break; }
          if (z.parentElement && qa('input[type="file"]', z.parentElement).length > 1) break;
        }
        let up = { n: 0, t: 0 };
        try { const raw = sessionStorage.getItem(sKey); up = raw && raw.startsWith('{') ? JSON.parse(raw) : { n: Number(raw || 0), t: 0 }; } catch (_) { /* ignore */ }
        if (seenName || Date.now() - (up.t || 0) < 45000 || up.n >= 5) { uploadedZones.add(zkey); continue; }
        uploadedZones.add(zkey);
        try { sessionStorage.setItem(sKey, JSON.stringify({ n: up.n + 1, t: Date.now() })); } catch (_) { /* ignore */ }
        uploadedInputs.add(input);
        const zone = input.parentElement?.parentElement?.parentElement || document.body;
        if (S.resumes.some((r) => textOf(zone).includes(r.name))) continue; // 已经传过
        const dt = new DataTransfer();
        dt.items.add(resumeFile(R));
        input.files = dt.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        setStatus(`正在上传简历：${R.label}…`);
        await waitFor(() => textOf(zone).includes(R.name), 8000, 400);
        await sleep(1000);
        return true;
      }
      const gBtn = isGoogleForm() && gformButton(/resume|\bcv\b|简历/i);
      if (gBtn && !uploadedZones.has('gf|resume|' + location.href)) {
        uploadedZones.add('gf|resume|' + location.href);
        setStatus(`正在上传简历：${R.label}…`);
        if (await gformUpload(gBtn, resumeFile(R))) { await sleep(500); return true; }
      }
      const pBtn = pickerOnlyUploads().find((b) => /\bcv\b|resume|r[eé]sum[eé]|curriculum/i.test(pickerLabel(b)) && !/motivation|cover/i.test(pickerLabel(b)));
      if (pBtn && !uploadedZones.has('pick|resume|' + location.href)) {
        uploadedZones.add('pick|resume|' + location.href);
        setStatus(`正在上传简历：${R.label}…`);
        if (await uploadViaChooser(pBtn, R.name, R.data)) { logAI(`📎 简历 → ${R.label}（接管选文件窗口）`); await sleep(800); return true; }
      }
      const dBtn = uploadDialogButton(RESUME_BTN_RE);
      if (dBtn && !uploadedZones.has('dlg|resume|' + location.href) && !S.resumes.some((r) => textOf(document.body).includes(r.name))) {
        uploadedZones.add('dlg|resume|' + location.href);
        setStatus(`正在上传简历：${R.label}…`);
        if (await uploadViaDialog(dBtn, resumeFile(R), R.name)) { await sleep(800); return true; }
      }
      return false;
    }
    for (const input of qa('input[type="file"]', formScope())) {
      const zone = input.closest('[data-automation-id^="formField"], section, [role="group"]') || formScope();
      const zt = textOf(zone);
      if (/transcript|cover letter|writing sample/i.test(zt) && !/resume|\bcv\b/i.test(zt)) continue;
      if (/successfully uploaded/i.test(zt) || S.resumes.some((r) => zt.includes(r.name))) continue;
      if (q('[data-automation-id*="delete" i], [data-automation-id="file-upload-item"]', zone)) continue;
      const dt = new DataTransfer();
      dt.items.add(resumeFile(R));
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      setStatus(`正在上传简历：${R.label}…`);
      await waitFor(() => /successfully uploaded/i.test(textOf(zone)) || textOf(zone).includes(R.name), 20000, 400);
      await sleep(1500); // 给 Workday 解析简历的时间
      return true;
    }
    return false;
  }


  async function clickAddIn(headingRe) {
    for (const b of qa('button', formScope())) {
      if (!isVisible(b)) continue;
      const t = textOf(b) || b.getAttribute('aria-label') || '';
      if (!/^add( another)?\b/i.test(t)) continue;
      if (headingRe.test(precedingHeading(b)) || headingRe.test(b.getAttribute('aria-label') || '')) {
        b.click();
        await sleep(900);
        return true;
      }
    }
    return false;
  }

  function websiteInputs() {
    return qa('input[type="text"], input:not([type])', formScope())
      .filter((i) => isVisible(i) && /^url$/i.test(questionFor(i)) && /website/i.test(precedingHeading(i)));
  }

  function eduBlockSchool(el) {
    const sec = precedingHeading(el);
    if (!/^(your |my )?education\b/i.test(sec)) return null;
    for (const ff of qa('[data-automation-id^="formField"]', formScope())) {
      if (!/school|university|college|institution/i.test(textOf(q('label, legend', ff))) || precedingHeading(ff) !== sec) continue;
      const pill = q('[data-automation-id="selectedItem"]', ff);
      const inp = q('input:not([type="checkbox"]):not([type="radio"])', ff);
      return (pill ? pill.getAttribute('title') || textOf(pill) : inp?.value || '').trim();
    }
    return '';
  }

  function foreignEduBlock(el) {
    const school = eduBlockSchool(el);
    if (!school || !S.profile.school) return false;
    const a = norm(school);
    const b = norm(S.profile.school);
    return !(a.includes(b) || b.includes(a));
  }

  const wkey = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const wstem = (j) => wkey(String(j.company).split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).slice(0, 2).join(''));
  const workJobs = () => (Array.isArray(S.profile.workHistory) ? S.profile.workHistory.filter((j) => j && j.company) : []);
  const workProjects = () => (Array.isArray(S.profile.projects) ? S.profile.projects.filter((j) => j && j.company) : []);
  const workPrefixes = () => [...new Set(qa('input[id^="workExperience-"]', formScope())
    .map((el) => (el.id.match(/^(workExperience-[^-]+--)(jobTitle|companyName)$/) || [])[1]).filter(Boolean))];
  const workGet = (pre, name) => document.getElementById(pre + name);
  const workDateEls = (pre, which) => ['Month', 'Year'].map((p) => workGet(pre, `${which}-dateSection${p}-input`));
  function workYM(pre, which) {
    const [m, y] = workDateEls(pre, which).map((el) => (el ? el.value.replace(/\D/g, '') : ''));
    return m && y ? `${pad2(m)}/${y}` : '';
  }

  async function fixWorkBlock(pre, job) {
    let n = 0;
    const set = (el, v) => { setText(el, v); n++; };
    const co = workGet(pre, 'companyName');
    const title = workGet(pre, 'jobTitle');
    const cv = wkey(co?.value);
    const tv = wkey(title?.value);
    const jt = wkey(job.title);
    if (co && (!cv || !(cv.includes(wstem(job)) || wkey(job.company).includes(cv)) || (jt && cv.includes(jt)))) {
      setStatus(`工作经历的公司：${job.company}`);
      set(co, job.company);
    }
    if (title && job.title && tv !== jt && (!tv || jt.includes(tv) || tv.includes(jt) || tv.includes(wstem(job)))) {
      setStatus(`工作经历的职位：${job.company} → ${job.title}`);
      set(title, job.title);
    }
    const loc = workGet(pre, 'location');
    const lv = wkey(loc?.value);
    const jl = wkey(job.location);
    if (loc && jl && loc.value.trim() !== job.location && (!lv || lv.includes(jl) || jl.includes(lv))) set(loc, job.location);
    const desc = workGet(pre, 'roleDescription');
    if (desc) {
      let v = desc.value;
      const cut = v.search(/\n[ \t]*[A-Z][A-Z &\/,-]{2,40}[ \t]*(\n|$)/); // 单独一行的全大写节标题
      if (cut > 0) v = v.slice(0, cut);
      const lines = v.split('\n');
      const header = (l) => wkey(l).includes(wstem(job)) && (!jt || wkey(l).includes(jt) || /\|/.test(l) || l.trim().length < 60);
      while (lines.length && (wkey(lines[0]) === jl || header(lines[0]))) lines.shift();
      v = descLines(lines.join('\n').trim());
      if (!v && job.summary) v = descLines(job.summary);
      if (v && v !== desc.value.trim()) set(desc, v);
    }
    const cur = workGet(pre, 'currentlyWorkHere');
    if (cur && cur.type === 'checkbox' && cur.checked !== !!job.current) { cur.click(); n++; await sleep(300); }
    const dateFlagged = /field (from|to)\b.{0,20}\bis\b/i.test(visibleErrors().join(' '));
    for (const [which, want] of [['startDate', job.start], ['endDate', job.current ? '' : job.end]]) {
      const m = String(want || '').match(/^(\d{1,2})\/(\d{4})$/);
      const els = workDateEls(pre, which);
      if (!m || els.some((el) => !el) || (workYM(pre, which) && !dateFlagged)) continue;
      await wdTypeDate(els, [pad2(m[1]), m[2]]);
      n++;
      await sleep(150);
    }
    return n;
  }

  async function fixParsedWork() {
    const jobs = [...workJobs(), ...workProjects()];
    if (!jobs.length) return 0;
    const used = new Set();
    let n = 0;
    for (const pre of workPrefixes()) {
      const cv = wkey(workGet(pre, 'companyName')?.value);
      const tv = wkey(workGet(pre, 'jobTitle')?.value);
      const dv = wkey(workGet(pre, 'roleDescription')?.value.split('\n')[0]);
      const start = workYM(pre, 'startDate');
      const tries = [
        (j) => cv.length >= 3 && (cv.includes(wstem(j)) || wkey(j.company).includes(cv)),
        (j) => tv.length >= 3 && tv.includes(wstem(j)),
        (j) => tv.length >= 3 && tv === wkey(j.title),
        (j) => dv.length >= 3 && dv.includes(wstem(j)), // 公司名跑到了描述第一行（ATC：「公司名 | Independent」）
        (j) => !!start && start === j.start,
      ];
      let job = null;
      for (const t of tries) {
        const hits = jobs.filter((j) => !used.has(j) && t(j));
        if (hits.length === 1) { job = hits[0]; break; }
      }
      if (!job) continue;
      used.add(job);
      n += await fixWorkBlock(pre, job);
    }
    return n;
  }

  async function addWorkBlockButton() {
    const jobs = workJobs();
    const heads = () => qa('h2, h3, h4, h5, [role="heading"], legend', formScope()).filter((h) => isVisible(h) && /^(employment|work) (history|experience)\s*[#(]?\s*\d+\b/i.test(textOf(h)));
    const n = heads().length;
    if (!n || n >= jobs.length) return 0;
    const btn = qa('button, a[role="button"], a', formScope()).find((b) => isVisible(b) && !b.disabled && !b.classList.contains('is-disabled')
      && (/^add another (workplace|employer|job|position|experience|role)$/i.test(textOf(b)) || /^add (more|another)\b.{0,5}\(?(work experience|employment|work history|experience)\)?$/i.test(textOf(b))));
    if (!btn) return 0;
    setStatus(`添加工作经历：${jobs[n].company}`);
    btn.click();
    return (await waitFor(() => heads().length > n, 3000)) ? 1 : 0;
  }

  async function addEmploymentBlocks() {
    const jobs = workJobs();
    let n = qa('input[id^="company-name-"]').filter((e) => /^company-name-\d+$/.test(e.id)).length;
    if (!n || n >= jobs.length) return 0;
    let added = 0;
    for (; n < jobs.length; n++) {
      const last = document.getElementById(`company-name-${n - 1}`);
      const btn = last && qa('button', formScope()).find((b) => isVisible(b) && /^add another$/i.test(textOf(b))
        && (last.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING));
      if (!btn) break;
      setStatus(`添加工作经历：${jobs[n].company}`);
      btn.click();
      if (!(await waitFor(() => document.getElementById(`company-name-${n}`), 3000))) break;
      added++;
    }
    return added;
  }

  async function addWorkHistory() {
    const jobs = workJobs();
    if (!jobs.length) return 0;
    const have = () => workPrefixes().map((pre) => wkey(workGet(pre, 'companyName')?.value) + ' ' + wkey(workGet(pre, 'jobTitle')?.value)).join(' | ');
    const missing = jobs.filter((j) => !have().includes(wstem(j)));
    let n = 0;
    for (const job of missing) {
      const before = new Set(workPrefixes());
      setStatus(`添加工作经历：${job.company}`);
      if (!(await clickAddIn(/^(your |my )?(work )?experience\b/i))) break;
      const pre = await waitFor(() => workPrefixes().find((x) => !before.has(x)), 5000);
      if (!pre) break;
      n += await fixWorkBlock(pre, job);
    }
    return n;
  }

  async function fillExperienceSections() {
    const P = S.profile;
    let n = 0;
    if (S.settings.onlyMySchool && P.school) {
      for (let guard = 0; guard < 6; guard++) {
        const del = qa('button', formScope()).find((b) => isVisible(b)
          && /^delete\b/i.test(textOf(b) || b.getAttribute('aria-label') || '')
          && /^(your |my )?education\b/i.test(precedingHeading(b)) && foreignEduBlock(b));
        if (!del) break;
        setStatus(`删除不是 ${P.school} 的学历：${eduBlockSchool(del)}`);
        del.click();
        await sleep(900);
        n++;
      }
    }
    n += await fixParsedWork();
    n += await addWorkHistory();
    const fields = collectFields();
    const hasSchool = fields.some((f) => /school|university|college|institution/i.test(f.question));
    if (P.school && !hasSchool && (await clickAddIn(/^(your |my )?education/i))) n++;

    const hasLinkedinQ = fields.some((f) => /linkedin/i.test(f.question));
    const urls = [hasLinkedinQ ? '' : P.linkedin, P.github, P.website].filter(Boolean);
    for (let i = websiteInputs().length; i < urls.length; i++) {
      if (!(await clickAddIn(/website/i))) break;
    }
    websiteInputs().forEach((inp, i) => {
      if (urls[i] && (!inp.value.trim() || S.settings.overwrite) && inp.value !== urls[i]) { setText(inp, urls[i]); n++; }
    });
    return n;
  }



  async function wdTypeDate(els, values) {
    const box = els[0].closest('[data-automation-id^="formField"]') || els[0].parentElement?.parentElement;
    const aid = els[0].getAttribute('data-automation-id') || '';
    const disp = aid && box && q(`[data-automation-id="${aid.replace(/-input$/, '-display')}"]`, box);
    const first = disp || els[0];
    first.scrollIntoView?.({ block: 'center' });
    await sleep(200);
    const pt = viewportPoint(first);
    const real = pt && (await trusted([{ type: 'click', ...pt }, { type: 'wait', ms: 200 }, { type: 'keys', text: values.join('') }, { type: 'wait', ms: 200 }, { type: 'key', key: 'Tab' }])).ok
      && els.every((el, i) => Number(el.value.replace(/\D/g, '')) === Number(values[i]));
    if (real) return true;
    for (let i = 0; i < els.length; i++) await setDatePart(els[i], values[i]);
    document.activeElement?.blur();
    return true;
  }

  async function setDatePart(el, v) {
    el.focus();
    el.select?.();
    document.execCommand('insertText', false, v);
    await sleep(250);
  }

  const GRAD_DAY = 15; // 毕业日期要「日」时用月中，Review 页会显示出来，可以手动改


  function emptyRequiredDates() {
    if (!isWD()) return [];
    const out = [];
    for (const ff of qa('[data-automation-id^="formField"]', formScope())) {
      const parts = qa('input[data-automation-id^="dateSection"]', ff);
      if (!parts.length || !isVisible(ff)) continue;
      const lab = q('label, legend', ff);
      if (!lab || !(/\*/.test(lab.textContent) || q('[aria-required="true"]', ff))) continue;
      if (parts.every((i) => i.value.replace(/\D/g, ''))) continue;
      out.push({ kind: 'date', el: parts[0], question: cleanLabel(textOf(lab)).replace(/\*\s*$/, '').trim() });
    }
    return out;
  }

  async function fillDates() {
    let n = 0;
    const seen = new Set();
    for (const inp of qa('input[data-automation-id^="dateSection"]', formScope())) {
      const box = inp.closest('[data-automation-id^="formField"]') || inp.parentElement?.parentElement;
      if (!box || seen.has(box) || !isVisible(inp)) continue;
      seen.add(box);
      const label = norm(textOf(q('label, legend', box)) || questionFor(inp)); // 整组的「From」「To (Actual or Expected)」，不是框自己的「Year」
      const sec = precedingHeading(box);
      const P = S.profile;
      let want = null;
      if (/education/i.test(sec)) {
        if (foreignEduBlock(box)) continue;
        if (/first|from|start/.test(label)) want = { month: P.eduStartMonth, year: P.eduStartYear };
        else if (/last|^to\b|end|graduat|expected/.test(label)) want = { month: P.eduEndMonth, day: GRAD_DAY, year: P.eduEndYear };
      } else {
        want = dateWanted(label, sec); // 毕业、签字日期、期望入职日（ERCOT：What is your desired Start date?）
      }
      if (!want) continue;
      const parts = [['Month', want.month], ['Day', want.day], ['Year', want.year]]
        .map(([p, v]) => [p, q(`input[data-automation-id="dateSection${p}-input"]`, box), v])
        .filter(([, el]) => el);
      const errNow = visibleErrors().join(' ').toLowerCase();
      const flagged = !!label && new RegExp(`field ${esc(label)} is`).test(errNow);
      if (parts.every(([, el]) => el.value.replace(/\D/g, '')) && !S.settings.overwrite && !flagged) continue;
      if (parts.some(([, , v]) => !v)) continue;
      const digits = parts.map(([p, , v]) => (p === 'Year' ? String(v) : String(v).padStart(2, '0'))).join('');
      const first = q(`[data-automation-id="dateSection${parts[0][0]}-display"]`, box) || parts[0][1];
      first.scrollIntoView?.({ block: 'center' });
      await sleep(200);
      const pt = viewportPoint(first);
      const real = pt && (await trusted([{ type: 'click', ...pt }, { type: 'wait', ms: 200 }, { type: 'keys', text: digits }, { type: 'wait', ms: 200 }, { type: 'key', key: 'Tab' }])).ok
        && parts.every(([p, el, v]) => Number(el.value.replace(/\D/g, '')) === Number(v));
      if (!real) {
        for (const [p, el, v] of parts) await setDatePart(el, p === 'Year' ? String(v) : String(v).padStart(2, '0'));
        document.activeElement?.blur();
      }
      n++;
      await sleep(150);
    }
    return n;
  }


  const LEARN_HEADER = '# ↓ 你手动答过的题，插件自动记下来了，下次同样的题会自动答（可以改答案或整行删掉）';
  let pending = []; // 上次标红、插件没有规则可答的题；你手动答完后记下来

  function fieldAnswer(f) {
    switch (f.kind) {
      case 'listbox': return textOf(f.el);
      case 'popcombo': return isEmpty(f) ? '' : popText(f.el);
      case 'combo': return comboValue(f.el);
      case 'select': return selectText(f);
      case 'radio': case 'checkgroup':
        return f.els.filter(isChecked).map(choiceLabel).filter(Boolean).join(' || ');
      case 'prompt': {
        const box = f.el.closest('[data-automation-id^="formField"]') || f.el.parentElement?.parentElement?.parentElement;
        const it = box && q('[data-automation-id="selectedItem"]', box);
        return it ? (it.getAttribute('title') || textOf(it)) : '';
      }
      case 'text': return f.el.tagName === 'INPUT' && f.el.value.trim().length <= 60 ? f.el.value.trim() : '';
      default: return '';
    }
  }

  const REPEATED_SECTION = /^(languages?|education|work experience|experience|websites?|certifications?)\b/i;
  const NO_LEARN = /preferred (work )?location|preferred (first |given |last |family )?name|nickname|which (office|location)|location preference|employee id|signature|full name|legal name|^name$|reason(s|\(s\))? for leaving/i;
  const isGenericLabel = (q) => q.trim().split(/\s+/).length < 3;

  function learnable(f) {
    if (!f.question || f.kind === 'checkbox' || isGenericLabel(f.question) || NO_LEARN.test(f.question)) return false;
    if (REPEATED_SECTION.test(precedingHeading(f.el)) || f.block === 'employer' || f.block === 'reference') return false;
    const a = resolveField(f);
    return !a || a.src === '自定义' || !a.value; // 没有规则、自定义规则没对上、或资料里这项是空的
  }

  function rememberUnanswered(fields) {
    pending = fields
      .filter((f) => isEmpty(f) && (f.kind !== 'text' || isRequired(f)) && learnable(f))
      .map((f) => ({ question: f.question, kind: f.kind }));
  }

  function dropGenericLearned(text) {
    const i = text.indexOf(LEARN_HEADER);
    if (i < 0) return text;
    const head = text.slice(0, i + LEARN_HEADER.length);
    const rest = text.slice(i + LEARN_HEADER.length).split('\n').filter((line) => {
      const r = wdafParseRules(line)[0];
      return !(r && r.keys.length === 1 && (isGenericLabel(r.keys[0]) || NO_LEARN.test(r.keys[0]))); // 学错的「your full legal name => 你的姓名」也清掉（FedEx）
    });
    return head + rest.join('\n');
  }

  function collectLearned() {
    if (!pending.length) return [];
    const fields = collectFields();
    const out = [];
    for (const p of pending) {
      const f = fields.find((x) => x.kind === p.kind && x.question === p.question);
      if (!f || isEmpty(f)) continue;
      const ans = fieldAnswer(f).replace(/\s+/g, ' ').replace(/=>/g, ' ').trim();
      if (!ans || /^select one$/i.test(ans)) continue;
      out.push({ key: norm(p.question).replace(/\|/g, ' ').replace(/=>/g, ' ').trim(), answer: ans });
    }
    pending = [];
    return out;
  }

  async function saveLearned(learned, src = '') {
    if (!learned.length) return 0;
    const d = await chrome.storage.local.get('customRules');
    const keys = new Set(learned.map((l) => l.key));
    let text = String(d.customRules ?? WDAF_DEFAULT_RULES).split('\n').filter((line) => {
      const r = wdafParseRules(line)[0];
      return !(r && r.keys.length === 1 && keys.has(r.keys[0]));
    }).join('\n').replace(/\s+$/, '');
    if (!text.includes(LEARN_HEADER)) text += '\n\n' + LEARN_HEADER;
    text += '\n' + learned.map((l) => `${l.key} => ${l.answer}${src ? ` ⟨${src}⟩` : ''}`).join('\n') + '\n';
    await chrome.storage.local.set({ customRules: text });
    S.rules = wdafParseRules(text);
    return learned.length;
  }

  const learnFromUser = () => saveLearned(collectLearned());




  function viewportPoint(el) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    let x = r.left + Math.min(r.width / 2, 40);
    let y = r.top + r.height / 2;
    try {
      for (let w = window; w !== w.top; w = w.parent) {
        const fe = w.frameElement;
        if (!fe) return null;
        const fr = fe.getBoundingClientRect();
        x += fr.left + fe.clientLeft;
        y += fr.top + fe.clientTop;
      }
    } catch (_) { return null; }
    return { x: Math.round(x), y: Math.round(y) };
  }
  let trustedOff = ''; // 连不上调试接口（别的调试器占着）：这一页不再试
  function trusted(steps) {
    if (trustedOff || (S.settings && S.settings.trustedInput === false) || !alive() || chrome.runtime.id === 'mock') return Promise.resolve({ ok: false, error: trustedOff || 'off' });
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'trusted', steps }, (r) => {
          r = r || { ok: false, error: chrome.runtime.lastError?.message || '没有回应' };
          if (!r.ok && /another debugger|already attached|cannot (access|attach)|not allowed|permission/i.test(r.error || '')) trustedOff = r.error;
          if (!r.ok) dbg('真实键鼠没成', r.error);
          resolve(r);
        });
      } catch (e) { resolve({ ok: false, error: String(e) }); }
    });
  }
  async function trustedClick(el) {
    el.scrollIntoView?.({ block: 'center' });
    await sleep(200);
    const pt = viewportPoint(el);
    return !!pt && !!(await trusted([{ type: 'click', ...pt }])).ok;
  }
  async function trustedType(el, text, enter) {
    el.scrollIntoView?.({ block: 'center' });
    await sleep(200);
    const pt = viewportPoint(el);
    if (!pt) return false;
    const steps = [{ type: 'click', ...pt }, { type: 'wait', ms: 150 }, { type: 'selectAll', mac: /Mac/i.test(navigator.platform) }, { type: 'key', key: 'Backspace' }, { type: 'text', text: String(text) }];
    if (enter) steps.push({ type: 'wait', ms: 600 }, { type: 'key', key: 'Enter' });
    return !!(await trusted(steps)).ok;
  }
  if (isSR() && !IN_FRAME) {
    window.addEventListener('message', async (e) => {
      if (e.source !== window || !e.data || e.data.__wdafSrTest == null) return;
      const f = collectFields().filter((x) => x.srAc)[Number(e.data.__wdafSrTest) || 0];
      const steps = [];
      if (!f) { window.postMessage({ __wdafSrTestReply: { error: 'no field' } }, '*'); return; }
      const cnt = () => srAcOpts(f.srAc).length;
      f.el.scrollIntoView({ block: 'center' }); await sleep(300); steps.push('start:' + cnt() + ' focus:' + (document.activeElement && document.activeElement.tagName));
      f.el.focus(); await sleep(200); steps.push('focus:' + cnt());
      srFire(f.el); await sleep(600); steps.push('fire:' + cnt() + ' raw:' + srDeep(f.srAc.shadowRoot, '[role="option"]').map((o) => { const h = shadowHost(o); const cs = getComputedStyle(o); return [o.offsetWidth, JSON.stringify(textOf(o)), h && h.tagName, JSON.stringify(textOf(h)), JSON.stringify((h && h.textContent || '').trim().slice(0, 20)), cs.opacity, cs.visibility, isVisible(o)].join('/'); }).join(' ; '));
      mouseClick(f.el); await sleep(600); steps.push('mouseClick:' + cnt());
      f.el.click(); await sleep(600); steps.push('click:' + cnt());
      window.postMessage({ __wdafSrTestReply: { q: f.question.slice(0, 40), steps } }, '*');
    });
  }
  if (location.hostname === 'example.com' && !IN_FRAME) {
    window.addEventListener('message', async (e) => {
      if (e.source === window && e.data && e.data.__wdafQueue) { chrome.runtime.sendMessage({ type: 'queueCmd', ...e.data.__wdafQueue }, (r) => { void chrome.runtime.lastError; window.postMessage({ __wdafQueueReply: r || null }, '*'); }); return; }
      if (e.source === window && e.data && e.data.__wdafShotTest) { const shot = await opScreenshot(q('div') || document.body, []); window.postMessage({ __wdafShotResult: shot.length, head: shot.slice(0, 16) }, '*'); return; }
      if (e.source !== window || !e.data || !e.data.__wdafTrustedTest) return;
      const inp = q('#wdaf-test');
      const ok = !!inp && await trustedType(inp, 'Hello', true);
      window.postMessage({ __wdafTrustedResult: ok, error: trustedOff }, '*');
    });
  }

  async function opScreenshot(box, snap) {
    try {
      if (IN_FRAME || document.visibilityState !== 'visible' || (S.settings && S.settings.aiScreenshot === false) || !alive() || chrome.runtime.id === 'mock') return '';
      box.scrollIntoView?.({ block: 'center' });
      await sleep(250);
      const r = await new Promise((res) => { try { chrome.runtime.sendMessage({ type: 'capture' }, (x) => res(x || {})); } catch (_) { res({}); } });
      if (!r.ok || !r.url) { dbg('截图没成', r.error); return ''; }
      const raw = atob(r.url.split(',')[1]);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      const img = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const k = img.width / window.innerWidth;
      const rects = [box, ...snap.map((x) => x.el)].map((e) => e.getBoundingClientRect()).filter((rr) => rr.width && rr.height);
      const x0 = Math.max(0, Math.min(...rects.map((rr) => rr.left)) - 20);
      const y0 = Math.max(0, Math.min(...rects.map((rr) => rr.top)) - 30);
      const x1 = Math.min(window.innerWidth, Math.max(...rects.map((rr) => rr.right)) + 20);
      const y1 = Math.min(window.innerHeight, Math.max(...rects.map((rr) => rr.bottom)) + 20);
      if (x1 - x0 < 20 || y1 - y0 < 20) return '';
      const cv = new OffscreenCanvas(Math.round((x1 - x0) * k), Math.round((y1 - y0) * k));
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, x0 * k, y0 * k, cv.width, cv.height, 0, 0, cv.width, cv.height);
      ctx.lineWidth = 2;
      ctx.font = `bold ${Math.round(12 * k)}px sans-serif`;
      for (const it of snap) {
        const rr = it.el.getBoundingClientRect();
        if (!rr.width || !rr.height || rr.bottom < y0 || rr.top > y1 || rr.right < x0 || rr.left > x1) continue;
        const bx = (rr.left - x0) * k;
        const by = (rr.top - y0) * k;
        const label = String(it.d.i);
        ctx.strokeStyle = '#e11d48';
        ctx.strokeRect(bx, by, rr.width * k, rr.height * k);
        ctx.fillStyle = '#e11d48';
        ctx.fillRect(bx, Math.max(0, by - 14 * k), (label.length * 8 + 6) * k, 14 * k);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, bx + 3 * k, Math.max(11 * k, by - 3 * k));
      }
      const buf = new Uint8Array(await (await cv.convertToBlob({ type: 'image/png' })).arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return btoa(bin);
    } catch (e) { dbg('截图没成', e); return ''; }
  }

  const KNOCKOUT_RE = /\b(are|will|can|could|would|do|is)\b.{0,40}\b(you|candidates?)\b.{0,40}\b(willing|able|available|eligible|authori[sz]ed|legally|commit|comfortable)\b|willing(ness)? to (relocate|work|commute|travel)|able to (work|commute|relocate|start|attend|perform)|available (to|for) (work|start|the)|(work|be|report) (on-?site|in[- ]office|in the office|in person|onsite|hybrid)|minimum (qualifications|requirements)|meet (the |all |these )?(minimum |basic )?(qualifications|requirements)|at least 18|18 years|background (check|screen)|drug (test|screen)/;
  const KNOCKOUT_SKIP_RE = /sponsor|indefinite|permanent|any employer|unrestricted|without (any )?restriction|accommodation|assistance|disab|veteran|relative|criminal|convict|non-?compet|previously|ever been|\btext\b|\bsms\b|whatsapp|marketing|newsletter|contact (you|me)|referr/;
  const NEG_ANSWER_RE = /^(no\b|n\/a\b|not (willing|able|available|eligible|authori[sz]ed)|unable|i am not|i'm not|i do not|i don't|cannot|can't|decline|none\b)/i;
  const isKnockout = (question) => { const n = norm(question || ''); return KNOCKOUT_RE.test(n) && !KNOCKOUT_SKIP_RE.test(n); };
  const knockoutVeto = (question, value) => isKnockout(question) && (NEG_ANSWER_RE.test(String(value || '').trim()) || !String(value || '').trim());
  function knockoutSummary(fields) {
    return fields.filter((f) => !isEmpty(f) && (isKnockout(f.question) || /sponsor|authori[sz]ed to work|work authori[sz]ation/.test(norm(f.question))))
      .map((f) => `${f.question.replace(/\s+/g, ' ').slice(0, 34)} → ${String(fieldAnswer(f)).replace(/\s+/g, ' ').slice(0, 16)}`);
  }

  function textLimit(f) {
    const out = {};
    if (f.el.maxLength > 0 && f.el.maxLength < 100000) out.maxChars = f.el.maxLength;
    const m = norm(f.question).match(/(\d{2,5})\s*(?:-|to)?\s*(words?|characters?|chars?)\b/);
    if (m && /^w/.test(m[2])) out.maxWords = Number(m[1]);
    else if (m) out.maxChars = Math.min(out.maxChars || Infinity, Number(m[1]));
    return Object.keys(out).length ? out : null;
  }

  const isOtherPersonField = (f) => f.block === 'reference'
    || /\breferences?\b|\breferee|supervisor|emergency contact|contact person/.test(norm(f.question))
    || /reference|supervisor|emergency/i.test(`${f.el.id || ''} ${f.el.name || ''}`);

  const OP_SEL = 'input:not([type="hidden"]):not([type="file"]):not([type="password"]), select, textarea, button, a[role="button"], [role="button"], [role="option"], [role="gridcell"], [role="radio"], [role="checkbox"], [role="combobox"], [role="menuitem"], [role="menuitemradio"], [role="switch"], [role="treeitem"], li';
  const OP_DANGER_RE = /submit|apply|send|delete|remove|withdraw|cancel|sign ?(in|out|up)|log ?(in|out)|upload|attach|browse|^next\b|continue|^back$|previous|^save|download|import|clear/i;
  const opTried = new Set(); // 这一页已经让 AI 试过的题
  const recipeKey = (f) => location.hostname + '|' + norm(f.question).slice(0, 120);

  const ATS_FAMILY = ['myworkdayjobs.com', 'myworkdaysite.com', 'icims.com', 'oraclecloud.com', 'successfactors.com', 'sapsf.com', 'paylocity.com', 'paradox.ai',
    'greenhouse.io', 'lever.co', 'jobvite.com', 'taleo.net', 'ultipro.com', 'ukg.net', 'smartrecruiters.com', 'ashbyhq.com', 'workable.com', 'applytojob.com', 'paychex.com', 'adp.com'];
  const atsOf = () => ATS_FAMILY.find((d) => location.hostname === d || location.hostname.endsWith('.' + d)) || '';
  const atsRecipeKey = (f) => (atsOf() ? 'ats:' + atsOf() + '|' + norm(f.question).slice(0, 120) : '');

  function opBox(f) {
    const own = f.els || [f.el];
    let box = own[0];
    for (let i = 0; i < 8 && box.parentElement && box.parentElement !== document.body; i++) {
      const up = box.parentElement;
      const others = qa('input:not([type="hidden"]), select, textarea, [role="radio"], [role="combobox"], [role="checkbox"]', up)
        .filter((x) => isVisible(x) && !own.includes(x) && !box.contains(x));
      if (others.length || textOf(up).length > 2500) break;
      box = up;
    }
    return box;
  }

  function opSnapshot(f, box) {
    const items = [];
    const add = (el, popup) => {
      if (items.length >= 90 || el.closest('#wdaf-host') || !isVisible(el) || items.some((x) => x.el === el)) return;
      if (el.tagName === 'LI' && q(OP_SEL.replace(/, li$/, ''), el)) return; // li 里有更具体的控件，用那个
      const isField = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
      const state = ['checked', 'selected', 'expanded', 'pressed'].filter((a) => el.getAttribute('aria-' + a) === 'true' || (a === 'checked' && el.checked)).join(',');
      items.push({
        el, popup,
        d: {
          i: items.length, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', type: el.type || '',
          text: isField ? '' : textOf(el).slice(0, 80),
          label: (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '').slice(0, 60),
          value: isField ? String(el.value || '').slice(0, 60) : '',
          options: el.tagName === 'SELECT' ? [...el.options].map((o) => o.text.trim()).filter(Boolean).slice(0, 40) : undefined,
          state, popup,
        },
      });
    };
    for (const el of qa(OP_SEL, box)) add(el, false);
    for (const el of qa('[tabindex]:not([tabindex="-1"]), [onclick]', box)) add(el, false);
    for (const p of newPopups(f.el)) {
      for (const el of qa(OP_SEL, p)) add(el, true);
      for (const el of qa('[tabindex]:not([tabindex="-1"]), [onclick]', p)) add(el, true);
      for (const el of qa('div, span', p)) if (el.children.length <= 2 && textOf(el) && textOf(el).length <= 80 && !el.closest('button, li, [role]') && getComputedStyle(el).cursor === 'pointer') add(el, true);
      for (const el of qa('*', p)) if (!el.children.length && textOf(el) && textOf(el).length <= 80 && !el.closest('button, li, [role]')) add(el, true);
    }
    return items;
  }


  function opContext(f, box) {
    const outer = box.parentElement && box.parentElement !== document.body ? box.parentElement : box;
    const nearby = cleanLabel(textOf(outer)).replace(/\s+/g, ' ').slice(0, 1500);
    const all = collectFields();
    const i = all.findIndex((x) => x.el === f.el || (x.question === f.question && x.kind === f.kind));
    const prev = i > 0 ? all[i - 1] : null;
    return {
      section: precedingHeading(f.el) || '',
      nearby,
      previous: prev ? { question: prev.question.slice(0, 200), answer: isEmpty(prev) ? '' : String(fieldAnswer(prev)).slice(0, 120) } : null,
    };
  }

  function opWatch() {
    const added = [];
    const mo = new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (added.length < 300) added.push(n); });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      const out = [];
      for (const n of added) {
        const el = n.nodeType === 1 ? n : n.parentElement;
        if (!el || !el.isConnected || el.closest('#wdaf-host') || !isVisible(el)) continue;
        const t = cleanLabel(textOf(el)).replace(/\s+/g, ' ');
        if (!t) continue;
        if (t.length > 80) {
          const opts = qa('[role="option"], li', el).filter(isVisible);
          const line = opts.length ? `(list of ${opts.length} options: ${opts.slice(0, 4).map((o) => cleanLabel(textOf(o)).slice(0, 30)).join(' / ')})` : '';
          if (line && !out.includes(line)) out.push(line);
        } else if (!out.includes(t)) out.push(t);
        if (out.length >= 5) break;
      }
      return out;
    };
  }
  const opState = (el) => (el && el.isConnected
    ? { value: /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) ? String(el.value || '').slice(0, 60) : '', expanded: el.getAttribute('aria-expanded') || '', invalid: el.getAttribute('aria-invalid') || '' }
    : { gone: true });

  function opStillEmpty(f) {
    const g = collectFields().find((x) => x.kind === f.kind && x.question === f.question);
    return g ? isEmpty(g) : isEmpty(f);
  }

  async function opExec(item, a) {
    const el = item.el;
    if (!el.isConnected) return 'element gone';
    const name = cleanLabel(`${item.d.text} ${item.d.label}`);
    const isButtonish = el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button';
    switch (a.type) {
      case 'click':
        if (isButtonish && !isAriaChoice(el) && !item.popup && OP_DANGER_RE.test(name) && !/open the drop-?down|show (all|options)|toggle/i.test(name)) return 'blocked: dangerous button';
        el.scrollIntoView?.({ block: 'nearest' });
        mouseClick(el);
        return 'ok';
      case 'type': {
        if (!/^(INPUT|TEXTAREA)$/.test(el.tagName) || el.type === 'password' || el.readOnly) return 'blocked: not a text box';
        const v = String(a.text || '').slice(0, 300);
        if (el.tagName === 'TEXTAREA') { setText(el, v); return 'ok'; }
        if (el.value) { setNative(el, ''); await sleep(120); }
        typeInto(el, v);
        return 'ok';
      }
      case 'key': {
        const k = ['Enter', 'ArrowDown', 'ArrowUp', 'Tab'].find((x) => x.toLowerCase() === String(a.text || '').toLowerCase());
        if (!k) return 'blocked: key';
        pressKey(el, k);
        return 'ok';
      }
      case 'select': {
        if (el.tagName !== 'SELECT') return 'blocked: not a select';
        const o = [...el.options].find((x) => norm(x.text) === norm(a.text || '')) || [...el.options].find((x) => norm(x.text).includes(norm(a.text || '')) && a.text);
        if (!o) return 'no such option';
        setNative(el, o.value);
        return 'ok';
      }
      default: return 'blocked: unknown action';
    }
  }

  async function opReplay(f, steps, wanted) {
    const box = opBox(f);
    for (const s0 of steps) {
      if (!running) return false;
      if (s0.isWanted && !wanted) return false;
      const s = s0.isWanted ? { ...s0, elText: s0.type === 'click' ? wanted : s0.elText, text: s0.type === 'click' ? s0.text : wanted } : s0;
      const snap = opSnapshot(f, box);
      const stem = (x) => String(x.el.id || x.el.name || '').replace(/\d+/g, '');
      const item = snap.find((x) => x.d.tag === s.tag && x.d.role === s.role && norm(x.d.text) === norm(s.elText) && norm(x.d.label) === norm(s.label))
        || (s.elText && snap.find((x) => norm(x.d.text) === norm(s.elText)))
        || (s.isWanted && s.type === 'click' && pickAny(snap.filter((x) => x.d.text).map((x) => ({ el: x.el, text: x.d.text, x })), [wanted], 1)?.x)
        || (s.idStem && snap.find((x) => x.d.tag === s.tag && stem(x) === s.idStem))
        || (s.label && snap.find((x) => x.d.tag === s.tag && norm(x.d.label) === norm(s.label)));
      if (!item || (await opExec(item, s)) !== 'ok') { dbg('照学会的步骤做不下去', f.question, s); return false; }
      await sleep(600);
    }
    await sleep(400);
    if (opStillEmpty(f)) return false;
    if (!wanted) return true;
    const g = collectFields().find((x) => x.kind === f.kind && x.question === f.question) || f;
    return !!pickAny([{ el: g.el, text: String(fieldAnswer(g)) }], [wanted], 2);
  }

  async function opWithAI(f, wanted) {
    const box = opBox(f);
    const history = [];
    const steps = [];
    const info = await getJobInfo();
    const context = opContext(f, box);
    for (let n = 0; n < 6 && running && alive(); n++) {
      const snap = opSnapshot(f, box);
      if (!snap.length) return { ok: false, note: '这道题附近找不到控件' };
      setStatus(`🤖 AI 正在操作「${f.question.slice(0, 30)}」（第 ${n + 1} 步，每步十秒左右）…`);
      const lastStep = history[history.length - 1];
      const image = n === 0 || (lastStep && !lastStep.changes.length) ? await opScreenshot(box, snap) : '';
      const res = await askAI({
        action: 'operate', question: f.question, wanted, context, image, elements: snap.map((x) => x.d), history,
        profile: S.profile, confirmed: confirmedText(),
        resumePdf: ((currentPick && currentPick.resume) || S.resumes.find((r) => r.id === S.defaultResumeId) || S.resumes[0] || {}).data || '',
        job: { title: info.title || jobTitleFromPage(), company: jobCompany(), url: location.href },
      }, 120000);
      if (!res || !res.ok) return { ok: false, note: (res && res.error) || '没有回应' };
      if (res.done || res.giveUp) return { ok: !res.giveUp && !opStillEmpty(f), steps, note: res.reason };
      const a = res.action;
      const item = a && snap[a.target];
      const pickedText = item ? (a.type === 'type' || a.type === 'select' ? a.text : item.d.text || item.d.label) : '';
      const before = item ? JSON.stringify(opState(item.el)) : '';
      const stop = opWatch();
      let r = !item ? 'no such element'
        : isKnockout(f.question) && a.type !== 'key' && NEG_ANSWER_RE.test(String(pickedText || '').trim()) ? 'blocked: eligibility questions are never answered No'
        : await opExec(item, a);
      await sleep(700);
      let changes = stop();
      if (r === 'ok' && !changes.length && JSON.stringify(opState(item.el)) === before && (a.type === 'click' || a.type === 'type') && opStillEmpty(f)) {
        const stop2 = opWatch();
        const done = a.type === 'click' ? await trustedClick(item.el) : await trustedType(item.el, String(a.text || '').slice(0, 300));
        await sleep(700);
        const ch2 = stop2();
        if (done) { r = 'ok (real input)'; changes = ch2; }
      }
      dbg('AI 操作', f.question, a, item && item.d, '→', r, '|', res.reason, '| 变化', changes);
      history.push({ action: a, on: item ? (item.d.text || item.d.label || item.d.tag) : null, result: r, changes, after: opState(item && item.el), fieldStillEmpty: opStillEmpty(f) });
      if (r.startsWith('ok')) steps.push({ type: a.type, text: a.text || '', tag: item.d.tag, role: item.d.role, elText: item.d.text, label: item.d.label, idStem: String(item.el.id || item.el.name || '').replace(/\d+/g, '') });
      await sleep(100);
      if (r.startsWith('ok') && a.type !== 'type' && (item.popup || isAriaChoice(item.el) || /^(radio|checkbox)$/.test(item.el.type || '') || /^(option|gridcell|radio|menuitemradio|treeitem)$/.test(item.d.role)) && !opStillEmpty(f)) return { ok: true, steps };
    }
    return { ok: !opStillEmpty(f), steps };
  }

  async function aiOperate(fields) {
    if (S.settings.useAI === false || S.settings.aiOperator === false) return 0;
    let store = {};
    try { store = (await chrome.storage.local.get('aiRecipes')).aiRecipes || {}; } catch (_) { /* 测试页 */ }
    let fixed = 0;
    for (const f of fields.filter((x) => !x.datePart && x.kind !== 'checkbox' && x.kind !== 'date' && !CRED_RE.test(norm(x.question))
      && !isOtherPersonField(x) && !(x.block === 'employer' && !workAnswer(x))).slice(0, 3)) {
      if (!running || !alive()) break;
      const key = recipeKey(f);
      if (opTried.has(location.href + '|' + key)) continue;
      opTried.add(location.href + '|' + key);
      const a = (f.block === 'employer' ? workAnswer(f) : null) || resolveField(f);
      const wanted = a && a.value && !Array.isArray(a.value) && a.value !== 'CHECK' ? String(a.value) : null;
      comboBefore.set(f.el, new Set(visiblePopups()));
      const akey = atsRecipeKey(f);
      const recipe = store[key] || (akey && store[akey]);
      if (recipe && await opReplay(f, recipe, wanted)) {
        fixed++;
        logAI(`🧩 照学会的步骤填好：${f.question.slice(0, 40)}${store[key] ? '' : '（别家同系统学的）'}`);
        continue;
      }
      const res = await opWithAI(f, wanted);
      if (res.ok) {
        fixed++;
        if (res.steps.length) {
          if (wanted) for (const st of res.steps) if (norm(st.type === 'click' ? st.elText : st.text) === norm(wanted)) st.isWanted = true;
          store[key] = res.steps;
          if (akey) store[akey] = res.steps;
          try { await chrome.storage.local.set({ aiRecipes: store }); } catch (_) { /* 测试页 */ }
        }
        logAI(`🤖 AI 操作填好：${f.question.slice(0, 40)}（${res.steps.length} 步，已记住）`);
      } else {
        logAI(`🤖 AI 操作没成：${f.question.slice(0, 40)}${res.note ? '（' + res.note.slice(0, 60) + '）' : ''}`);
      }
    }
    return fixed;
  }


  function askAI(payload, timeout = 240000) {
    return new Promise((resolve) => {
      if (chrome.runtime.id === 'mock' && window.__wdafMockAI) { Promise.resolve(window.__wdafMockAI(payload)).then(resolve, (e) => resolve({ ok: false, error: String(e) })); return; }
      if (!alive() || chrome.runtime.id === 'mock') { resolve({ ok: false, error: '测试页面没有本地连接' }); return; }
      const t = setTimeout(() => resolve({ ok: false, error: '等 Codex 超时' }), timeout + 10000);
      try {
        chrome.runtime.sendMessage({ type: 'ai', payload, timeout }, (r) => {
          clearTimeout(t);
          resolve(r || { ok: false, error: chrome.runtime.lastError?.message || '没有回应' });
        });
      } catch (e) {
        clearTimeout(t);
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  function jobCompany() {
    if (QUEUE && QUEUE.company && /[A-Z]|\s/.test(QUEUE.company) && !/recruit|careers? page|^jobs?$/i.test(QUEUE.company)) return QUEUE.company.replace(/\s+-\s+career'?s page$/i, '').trim();
    const t = document.title.trim();
    if (/(^|\.)rippling\.com$/i.test(location.hostname)) {
      const slug = location.pathname.split('/').filter(Boolean)[0] || '';
      const alt = q('header img[alt], nav img[alt]')?.alt || '';
      if (alt && !/rippling|logo/i.test(alt)) return alt.trim();
      if (slug && !/^(jobs?|apply|en(-us)?)$/i.test(slug)) return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    }
    const sfCo = /successfactors|sapsf/i.test(location.hostname) && new URLSearchParams(location.search).get('company');
    if (sfCo) return sfCo.replace(/(prod|production)$/i, '').replace(/^\w/, (c) => c.toUpperCase());
    const atSign = t.match(/\s@\s+([^|–—]+?)\s*$/);
    if (atSign) return atSign[1].replace(/,?\s+(inc|llc|ltd|corp|co)\.?$/i, '').trim();
    let m = t.match(/\bat ([^|–—]+?)\s*$/i);
    if (m) return m[1].split(/\s+[-–—|]\s+/)[0].trim(); // 「at Perpay - Career's Page」只要 Perpay
    if (/\/CandidateExperience\//i.test(location.pathname)) {
      const img = q('img.app-header__logo-image, .app-header__logo img');
      const src = img ? decodeURIComponent((img.getAttribute('src') || '').split(/[?#]/)[0].split('/').pop() || '') : '';
      const nm = (img && img.alt && !/logo|home/i.test(img.alt) ? img.alt : src.replace(/\.(png|jpe?g|svg|gif|webp)$/i, '').replace(/[-_ ]*logo[-_ ]*/ig, ' ').replace(/[-_]+/g, ' ')).trim();
      return /[a-z]{3}/i.test(nm) && !/^(image|img|header|default|brand)$/i.test(nm) ? nm : '';
    }
    const og = q('meta[property="og:site_name"]')?.content;
    if (og && !/greenhouse|lever|workday|jobvite|icims|talemetry|candidate experience|rippling|ashby|workable|recruit/i.test(og)) return og.trim();
    m = t.match(/^([^|–—-]{2,40}?)\s+[-–—|]\s+/);
    if (m && !isWD() && !/recruit|\bapply\b|careers?|\bjobs?\b/i.test(m[1])) return m[1].trim();
    if (isWD()) return location.hostname.split('.')[0].replace(/^\w/, (c) => c.toUpperCase());
    m = location.pathname.match(/^\/([^/]+)\/jobs\//); // job-boards.greenhouse.io/<公司>/jobs/…
    return m ? m[1] : '';
  }
  const jobDesc = (info) => String(info.desc || '').split(/Apply for this job|Submit application/i)[0].slice(0, 8000);

  const confirmedText = () => S.rules.filter((r) => !r.src).map((r) => `${r.keys.join(' | ')} => ${r.answer}`).join('\n').slice(0, 5000);

  const AI_KINDS = new Set(['text', 'select', 'radio', 'checkgroup', 'combo', 'listbox', 'prompt', 'popcombo']);
  const isEssay = (f) => f.kind === 'text' && (f.el.tagName === 'TEXTAREA'
    || /\bwhy\b|describe|tell us|explain|excites?\b|interests? you|interested in|motivat|what makes you/i.test(f.question));
  const aiTried = new Set(); // 同一页同一道题只问一次
  let aiLog = []; // 面板上列出 Codex 这一页答了什么
  let aiLogPage = '';
  let aiNote = '';
  function logAI(line) {
    if (aiLogPage !== location.href) { aiLog = []; aiLogPage = location.href; }
    aiLog.push(line);
    renderPanel();
  }

  async function aiOptions(f) {
    switch (f.kind) {
      case 'select': return [...f.el.options].filter((o) => o.value !== '' && !isPlaceholderOpt(o)).map((o) => o.text.trim()).filter(Boolean);
      case 'radio': case 'checkgroup': return f.els.map(choiceLabel).filter(Boolean);
      case 'popcombo': { const os = (await openPopCombo(f.el)).map((o) => o.text); closePopCombo(f.el); await sleep(200); return os; }
      case 'combo': {
        if (f.srAc) { const os = (await srAcOptions(f)).map((o) => o.text); f.el.blur(); await sleep(200); return os; }
        if (f.ol) { const os = (await olListOptions(f.el)).map((o) => o.text); closeOlList(); return os; }
        const opts = await openCombo(f.el);
        f.el.blur();
        await sleep(150);
        return opts.map((o) => o.text);
      }
      case 'listbox': {
        await closeOpenListbox();
        const before = new Set(visibleListboxes());
        f.el.click();
        const lb = await waitFor(() => listboxFor(f.el, before), 1500);
        const seen = new Set();
        for (let i = 0; lb && i < 30; i++) {
          listOptions(lb).forEach((o) => seen.add(o.text));
          const before = lb.scrollTop;
          lb.scrollTop += Math.max(lb.clientHeight, 200);
          await sleep(120);
          if (lb.scrollTop === before) break;
        }
        pressKey(f.el, 'Escape');
        await sleep(150);
        if (lb && isVisible(lb)) f.el.click();
        await waitFor(() => !lb || !isVisible(lb), 1000);
        return [...seen].filter((t) => t && !/^select one$/i.test(t));
      }
      default: return [];
    }
  }

  async function aiAnswerMissing(fields) {
    if (S.settings.useAI === false) return 0;
    const todo = fields.filter((f) => AI_KINDS.has(f.kind) && f.question && !f.datePart && !CRED_RE.test(norm(f.question))
      && f.block !== 'employer' && f.block !== 'reference' && !aiTried.has(f.kind + '|' + f.question));
    if (!todo.length) return 0;
    const qs = [];
    for (const f of todo) {
      aiTried.add(f.kind + '|' + f.question);
      const options = f.kind === 'text' ? [] : await aiOptions(f);
      const complete = f.kind !== 'prompt' && !(f.kind === 'combo' && options.length >= 90);
      const multi = f.kind === 'checkgroup' || (f.kind === 'combo' && isMultiCombo(f.el)); // 多选题：Codex 可以答好几个，用 || 隔开
      const limit = f.kind === 'text' ? textLimit(f) : null;
      qs.push({ id: String(qs.length), question: f.question, type: isEssay(f) ? 'essay' : options.length ? 'choice' : 'text', options: options.slice(0, 120), optionsComplete: complete, multi, ...(limit ? { limit } : {}), f });
    }
    setStatus(`🤖 正在问 Codex：${qs.length} 道新题（十几秒）…`);
    const info = await getJobInfo();
    const res = await askAI({
      action: 'answer',
      questions: qs.map(({ f, ...x }) => x),
      profile: S.profile,
      confirmed: confirmedText(),
      resumePdf: ((currentPick && currentPick.resume) || S.resumes.find((r) => r.id === S.defaultResumeId) || S.resumes[0] || {}).data || '',
      job: { title: info.title || jobTitleFromPage(), company: jobCompany(), url: location.href, desc: jobDesc(info) },
    }, 240000);
    if (!res || !res.ok) {
      aiNote = `Codex 没答上：${(res && res.error) || '没有回应'}`;
      dbg(aiNote);
      return 0;
    }
    let n = 0;
    const learned = [];
    for (const a of res.answers || []) {
      const it = qs[Number(a.id)];
      if (!it || !it.f.el.isConnected) continue;
      if (knockoutVeto(it.question, a.answer)) { logAI(`🛡 没让 Codex 把资格题答成「${String(a.answer).slice(0, 20)}」：${it.question.slice(0, 40)}（留给你）`); continue; }
      const val = splitMulti(a.answer);
      const r = await fillField(it.f, { key: 'AI', value: val, alts: Array.isArray(val) ? null : [a.answer] });
      dbg('Codex 答', it.question, '=>', a.answer, '|', a.reason, '| 填上', r);
      if (!r || r === 'stale') continue;
      n++;
      if (it.f.kind === 'text' && it.f.el.isConnected && it.f.el.value.length < String(a.answer).length - 2) logAI(`⚠ 答案超出网页字数上限被截断：${it.question.slice(0, 40)}，请检查`);
      logAI(`${it.question.slice(0, 48)} → ${a.answer.replace(/\s+/g, ' ').slice(0, 48)}${a.answer.length > 48 ? '…' : ''}`);
      if (it.type !== 'essay' && learnable(it.f)) {
        const ans = fieldAnswer(it.f).replace(/\s+/g, ' ').replace(/=>/g, ' ').trim();
        if (ans) learned.push({ key: norm(it.question).replace(/\|/g, ' ').replace(/=>/g, ' ').trim(), answer: ans });
      }
      await sleep(200);
    }
    if (learned.length) await saveLearned(learned, `codex ${new Date().toISOString().slice(0, 10)} ${atsOf() || location.hostname}`);
    return n;
  }

  const CL_RE = /cover letter|covering letter|motivation letter|letter of (interest|motivation)|upload (your |a )?motivation|motivation (letter|statement)|personal statement|statement of (interest|purpose|motivation)/; // ACT Group「Upload your motivation」
  const clFileName = () => `${S.profile.firstName || 'My'}_${S.profile.lastName || 'Cover'}_Cover_Letter.pdf`.replace(/\s+/g, '_');
  function coverLetterInputs() {
    const mode = S.settings.aiCoverLetter || 'always';
    if (mode === 'off' || S.settings.useAI === false) return [];
    return qa('input[type="file"]').filter((i) => !i.disabled && !i.closest('#wdaf-host')).filter((i) => {
      const t = fileCtxOwn(i);
      const own = norm([i.id, i.name, i.getAttribute('aria-label'), ...[...(i.labels || [])].map(textOf)].join(' '));
      const byLabel = CL_RE.test(own) && !/resume|\bcv\b|transcript/.test(own.replace(CL_RE, ' '));
      if (!byLabel && (!CL_RE.test(t) || /resume|\bcv\b|transcript/.test(t.replace(CL_RE, ' ')))) return false;
      if ((i.files && i.files.length) || uploadedInputs.has(i)) return false;
      const zone = textOf(fileZone(i));
      if (zone.includes(clFileName())) return false; // 已经传过
      return mode === 'always' || i.required || i.getAttribute('aria-required') === 'true' || /\*/.test(zone.slice(0, 60))
        || [...(i.labels || [])].some((l) => /(^|[\s_-])required([\s_-]|$)/i.test(l.className)) || !!q('[class*="_required_"]', i.closest('.ashby-application-form-field-entry') || document.createElement('i')); // Ashby：星号是 CSS 画的
    });
  }
  function clKey() {
    const sp = new URLSearchParams(location.search);
    const embed = location.pathname.includes('/embed/') ? `?for=${sp.get('for') || ''}&token=${sp.get('token') || ''}` : '';
    return 'cl:' + location.hostname + jobKey() + embed;
  }
  let clHere = ''; // 这个职位已经写过的 cover letter（面板上显示「查看 cover letter」）
  async function checkCoverLetter() {
    try {
      const d = await chrome.storage.local.get('coverLetters');
      clHere = d.coverLetters && d.coverLetters[clKey()] ? clKey() : '';
      const hasWsField = qa('input[type="file"]').some((i) => !i.closest('#wdaf-host') && /writing sample|written sample|work sample|research sample/.test(fileCtxOwn(i)) && !/additional (files|documents)|other (files|documents)/.test(fileCtxOwn(i)));
      wsHere = hasWsField && d.coverLetters && d.coverLetters['ws:default'] && d.coverLetters['ws:default'].data ? 'ws:default' : '';
    } catch (_) { clHere = ''; wsHere = ''; }
  }
  let clJob = null; // { key, promise }
  const clDialogPending = () => S.settings.aiCoverLetter !== 'off' && S.settings.useAI !== false
    && ((isGoogleForm() && !!gformButton(/cover letter|motivation letter/i)) || (!!uploadDialogButton(CL_BTN_RE) && !textOf(document.body).includes(clFileName()))
      || pickerOnlyUploads().some((b) => CL_RE.test(norm(pickerLabel(b)))));
  function startCoverLetter() {
    if (!coverLetterInputs().length && !clDialogPending()) return;
    const key = clKey();
    if (clJob && clJob.key === key) return;
    const prefs = collectFields().filter((f) => /prefer/i.test(f.question) && !isEmpty(f))
      .map((f) => `${f.question}: ${fieldAnswer(f)}`).join('; ');
    clJob = {
      key,
      promise: (async () => {
        const d = await chrome.storage.local.get('coverLetters');
        const cache = d.coverLetters || {};
        if (cache[key]) return cache[key];
        const info = await getJobInfo();
        const res = await askAI({
          action: 'coverLetter',
          preferences: prefs,
          profile: S.profile,
          resumePdf: ((currentPick && currentPick.resume) || S.resumes.find((r) => r.id === S.defaultResumeId) || S.resumes[0] || {}).data || '',
          job: { title: info.title || jobTitleFromPage(), company: jobCompany(), url: location.href, desc: jobDesc(info) },
        }, 480000);
        if (!res || !res.ok) return { error: (res && res.error) || '没有回应' };
        cache[key] = { name: res.name, path: res.path, data: res.data, time: Date.now(), company: jobCompany(), title: info.title || jobTitleFromPage(), url: location.href.split('#')[0] };
        await chrome.storage.local.set({ coverLetters: cache });
        return cache[key];
      })(),
    };
  }
  async function finishCoverLetter() {
    const inputs = coverLetterInputs();
    const viaDialog = !inputs.length && clDialogPending();
    if ((!inputs.length && !viaDialog) || !clJob) return 0;
    setStatus('🤖 等 Codex 写完 cover letter（一般 2 分钟）…');
    const CL = await clJob.promise;
    if (!CL || CL.error) {
      aiNote = `cover letter 没写成：${(CL && CL.error) || ''}`;
      clJob = null;
      return 0;
    }
    let n = 0;
    if (viaDialog) {
      const clFile = resumeFile({ data: CL.data, name: clFileName(), type: 'application/pdf' });
      const g = isGoogleForm() && gformButton(/cover letter|motivation letter/i);
      const pc = pickerOnlyUploads().find((b) => CL_RE.test(norm(pickerLabel(b))));
      if (g) { if (await gformUpload(g, clFile)) { logAI(`Cover letter → ${CL.name}`); n++; } }
      else if (pc) { if (await uploadViaChooser(pc, clFileName(), CL.data)) { logAI(`Cover letter → ${CL.name}（接管选文件窗口）`); n++; } }
      else {
        const b = uploadDialogButton(CL_BTN_RE);
        if (b && await uploadViaDialog(b, clFile, clFileName())) { logAI(`Cover letter → ${CL.name}`); n++; }
      }
    }
    for (const input of inputs) {
      if (!input.isConnected) continue;
      uploadedInputs.add(input);
      const dt = new DataTransfer();
      dt.items.add(resumeFile({ data: CL.data, name: clFileName(), type: 'application/pdf' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await waitFor(() => textOf(fileZone(input)).includes(clFileName()), 8000, 400);
      logAI(`Cover letter → ${CL.name}`);
      n++;
    }
    clHere = clJob.key;
    renderPanel();
    return n;
  }

  const WS_RE = /writing sample|written sample|work sample|sample of (your )?(written|writing|analytical) work|research sample|analytical (writing|sample)/;
  const WS_KEY = 'ws:default';
  const wsFileName = () => `${S.profile.firstName || 'My'}_${S.profile.lastName || ''}_Writing_Sample.pdf`.replace(/\s+/g, '_').replace(/_+/g, '_');
  function writingSampleInputs() {
    const mode = S.settings.aiWritingSample || 'always';
    if (mode === 'off' || S.settings.useAI === false) return [];
    return qa('input[type="file"]').filter((i) => !i.disabled && !i.closest('#wdaf-host')).filter((i) => {
      const t = fileCtxOwn(i);
      if (!WS_RE.test(t) || /resume|\bcv\b|transcript|cover letter|additional (files|documents)|other (files|documents)/.test(t.replace(WS_RE, ' '))) return false;
      if ((i.files && i.files.length) || uploadedInputs.has(i)) return false;
      const zone = textOf(fileZone(i));
      if (zone.includes(wsFileName())) return false; // 已经传过
      return mode === 'always' || i.required || i.getAttribute('aria-required') === 'true' || /\*/.test(zone.slice(0, 60))
        || [...(i.labels || [])].some((l) => /(^|[\s_-])required([\s_-]|$)/i.test(l.className)) || !!q('[class*="_required_"]', i.closest('.ashby-application-form-field-entry') || document.createElement('i')); // Ashby：星号是 CSS 画的
    });
  }
  let wsHere = ''; // 插件里已经有 writing sample（面板上显示「查看 writing sample」）
  let wsJob = null;
  function startWritingSample() {
    if (wsJob || !writingSampleInputs().length) return;
    wsJob = (async () => {
      const d = await chrome.storage.local.get('coverLetters');
      const cache = d.coverLetters || {};
      if (cache[WS_KEY] && cache[WS_KEY].data) return cache[WS_KEY];
      const info = await getJobInfo();
      const res = await askAI({ action: 'writingSample', job: { title: info.title || jobTitleFromPage(), company: jobCompany(), url: location.href } }, 600000);
      if (!res || !res.ok) return { error: (res && res.error) || '没有回应' };
      const cache2 = (await chrome.storage.local.get('coverLetters')).coverLetters || {};
      cache2[WS_KEY] = { kind: 'writingSample', name: res.name, path: res.path, data: res.data, time: Date.now(), company: jobCompany(), title: 'Writing sample', url: location.href.split('#')[0] };
      await chrome.storage.local.set({ coverLetters: cache2 });
      return cache2[WS_KEY];
    })();
  }
  async function finishWritingSample() {
    const inputs = writingSampleInputs();
    if (!inputs.length || !wsJob) return 0;
    setStatus('🤖 等 Codex 写完 writing sample（第一次要几分钟，以后直接用同一篇）…');
    const WS = await wsJob;
    if (!WS || WS.error) {
      aiNote = `writing sample 没写成：${(WS && WS.error) || ''}`;
      wsJob = null;
      return 0;
    }
    let n = 0;
    for (const input of inputs) {
      if (!input.isConnected) continue;
      uploadedInputs.add(input);
      const dt = new DataTransfer();
      dt.items.add(resumeFile({ data: WS.data, name: wsFileName(), type: 'application/pdf' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await waitFor(() => textOf(fileZone(input)).includes(wsFileName()), 8000, 400);
      logAI(`Writing sample → ${WS.name}`);
      n++;
    }
    wsHere = WS_KEY;
    renderPanel();
    return n;
  }

  const DOC_RE = /self[- ]?assessment|questionnaire|assessment|statement|essay|response to|answers? to|reflection|values|exercise|written (answer|response)/;
  const DOC_SKIP_RE = /resume|\bcv\b|curriculum|cover letter|covering letter|transcript|writing sample|work sample|portfolio|photo|headshot|passport|licen[cs]e|certific|proof of|enrol|diploma|visa|i-?20|\bead\b|w-?[49]\b|reference letter|recommendation|identification|\bid\b/;
  const docJobs = new Map(); // 上传框 → Codex 写文档的 promise
  function docInputs() {
    if (S.settings.useAI === false || S.settings.aiCoverLetter === 'off') return [];
    return qa('input[type="file"]').filter((i) => !i.disabled && !i.closest('#wdaf-host') && !(i.files && i.files.length) && !uploadedInputs.has(i) && !inAutofillZone(i))
      .filter((i) => {
        const req = i.required || i.getAttribute('aria-required') === 'true' || [...(i.labels || [])].some((l) => /(^|[\s_-])required([\s_-]|$)/i.test(l.className))
          || !!q('[class*="_required_"]', i.closest('.ashby-application-form-field-entry') || document.createElement('i'));
        const t = norm(questionFor(i) + ' ' + fileCtxOwn(i));
        return req && DOC_RE.test(t) && !DOC_SKIP_RE.test(t) && !CL_RE.test(t) && !WS_RE.test(t);
      });
  }
  function startDocs() {
    for (const i of docInputs()) {
      if (docJobs.has(i)) continue;
      const label = cleanLabel(questionFor(i) || precedingText(fileZone(i)) || '').slice(0, 600);
      docJobs.set(i, (async () => {
        const info = await getJobInfo();
        return askAI({
          action: 'document', docLabel: label, profile: S.profile,
          resumePdf: ((currentPick && currentPick.resume) || S.resumes.find((r) => r.id === S.defaultResumeId) || S.resumes[0] || {}).data || '',
          job: { title: info.title || jobTitleFromPage(), company: jobCompany(), url: location.href, desc: jobDesc(info) },
        }, 420000);
      })());
    }
  }
  async function finishDocs() {
    let n = 0;
    for (const [input, job] of docJobs) {
      if (!input.isConnected || (input.files && input.files.length) || uploadedInputs.has(input)) continue;
      setStatus('🤖 等 Codex 写完要上传的文档（一两分钟）…');
      const r = await job;
      if (!r || !r.ok) { aiNote = '文档没写成：' + ((r && r.error) || '没有回应'); continue; }
      uploadedInputs.add(input);
      const dt = new DataTransfer();
      dt.items.add(resumeFile({ data: r.data, name: r.name, type: 'application/pdf' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      logAI(`📄 ${r.title || '文档'} → ${r.name}`);
      n++;
    }
    return n;
  }


  function currentStep() {
    const el = q('[data-automation-id="progressBarActiveStep"]');
    if (!el) return '';
    return textOf(el).replace(/^(current\s+)?step\s+\d+\s+of\s+\d+\s*/i, '').trim();
  }

  function clearHighlights() {
    for (const el of qa('[data-wdaf-missing]')) {
      el.style.outline = el.dataset.wdafOutline || '';
      delete el.dataset.wdafMissing;
    }
  }

  function highlight(fields) {
    for (const f of fields) {
      const box = f.el.closest('[data-automation-id^="formField"]') || f.el.closest('fieldset') || f.el;
      box.dataset.wdafOutline = box.style.outline;
      box.dataset.wdafMissing = '1';
      box.style.outline = '2px solid #e5484d';
      box.style.outlineOffset = '4px';
    }
    if (fields[0]) (fields[0].el.closest('[data-automation-id^="formField"]') || fields[0].el).scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  async function waitForFields(timeout = 8000) {
    const end = Date.now() + timeout;
    let last = -1;
    let stable = 0;
    while (Date.now() < end && running !== false) {
      const n = collectFields().length;
      if (n > 0 && n === last) { if (++stable >= 2) return n; } else stable = 0;
      last = n;
      await sleep(350);
    }
    return last;
  }

  const pageTranslated = () => /\btranslated-(ltr|rtl)\b/.test(document.documentElement.className) || !!q('font[style*="vertical-align: inherit"]');

  const isOracleCX = () => /\/CandidateExperience\//i.test(location.pathname);
  const ORA_FORM_SEL = '.profile-item-content--form, .standard-apply-flow-timeline-form';
  const oraOpenForm = () => qa(ORA_FORM_SEL).find(isVisible);
  const oraBlockText = (block) => { const f = oraOpenForm(); let t = textOf(block); if (f && block.contains(f)) t = t.replace(textOf(f), ' '); return t; };
  const oraKindOf = (box) => (q('[id^="educationalEstablishment-"]', box) ? 'education' : q('[id^="employerName-"]', box) ? 'experience' : '');
  let oraJob = null; // 正在加的那一段经历
  function oraNextJob(block) {
    const have = norm(oraBlockText(block));
    const key = (s) => norm(s).replace(/\(.*?\)|,.*$|\b(llp|llc|ltd|inc|co)\b\.?/g, ' ').replace(/\s+/g, ' ').trim();
    return workJobs().find((j) => !(have.includes(key(j.company)) || (j.title && have.includes(norm(j.title))))) || null;
  }
  function oracleItemAnswer(f) {
    if (!isOracleCX()) return null;
    const box = f.el.closest(ORA_FORM_SEL);
    if (!box) return null;
    const P = S.profile;
    const id = (f.el.id || '').replace(/-\d+$/, '');
    const SKIP = { value: '' };
    const mon = (m) => (Number(m) >= 1 ? { value: MONTHS[Number(m) - 1], alts: monthCands(m) } : SKIP);
    const ym = (mmyy, part) => { const d = String(mmyy || '').match(/^(\d{1,2})\/(\d{4})$/); return !d ? SKIP : part === 'month' ? mon(d[1]) : { value: d[2] }; };
    if (oraKindOf(box) === 'education') {
      switch (id) {
        case 'contentItemId': return { key: 'degree', value: altsFor('degree')[0] || P.degree, alts: altsFor('degree') };
        case 'educationalEstablishment': return { key: 'school', value: P.school, alts: altsFor('school') };
        case 'major': return { key: 'fieldOfStudy', value: P.fieldOfStudy || '' };
        case 'month-startDate': return mon(P.eduStartMonth);
        case 'year-startDate': return P.eduStartYear ? { value: String(P.eduStartYear) } : SKIP;
        case 'month-endDate': return mon(P.eduEndMonth);
        case 'year-endDate': return P.eduEndYear ? { value: String(P.eduEndYear) } : SKIP;
        case 'countryCode': return { value: 'United States', alts: ['United States', 'United States of America', 'US', 'USA'] };
        case 'gpa': return P.gpa ? { key: 'gpa', value: String(P.gpa) } : SKIP;
        default: return SKIP; // Minor 等
      }
    }
    if (oraKindOf(box) === 'experience') {
      const job = oraJob;
      if (!job) return SKIP;
      switch (id) {
        case 'employerName': return { value: job.company };
        case 'jobTitle': return { value: job.title };
        case 'month-startDate': return ym(job.start, 'month');
        case 'year-startDate': return ym(job.start, 'year');
        case 'month-endDate': return job.current ? SKIP : ym(job.end, 'month');
        case 'year-endDate': return job.current ? SKIP : ym(job.end, 'year');
        case 'achievements': return { value: descLines(job.summary) };
        case 'city': return job.location ? { value: job.location.split(',')[0] } : SKIP;
        default: return SKIP; // Supervisor Name / Title / Email / Phone、OK to Contact Supervisor
      }
    }
    return SKIP;
  }
  async function oraFillOpenForm(box, onlyFix = false) {
    const tried = new Set();
    for (let pass = 0; pass < 14 && alive(); pass++) {
      const todo = collectFields().filter((f) => box.contains(f.el) && !tried.has(f.el.id || f.question))
        .filter((f) => !onlyFix || /^(month|year)-(start|end)Date-/.test(f.el.id || '') || !!f.el.closest('.input-row--invalid'))
        .map((f) => ({ ...f, ans: oracleItemAnswer(f) }))
        .filter((f) => f.ans && f.ans.value && isEmpty(f))
        .sort((a, b) => Number(/^countryCode-/.test(b.el.id)) - Number(/^countryCode-/.test(a.el.id)));
      if (!todo.length) break;
      const f = todo[0];
      tried.add(f.el.id || f.question);
      setStatus(`填写：${f.question.slice(0, 40)}`);
      try { await fillField(f, f.ans); } catch (e) { console.warn('[Workday 助手] Oracle 小表填写失败', f.question, e); }
      await sleep(f.kind === 'text' ? 80 : 350);
    }
  }

  async function oraDropExtraEducation() {
    if (!isOracleCX() || !S.profile.school) return 0;
    let n = 0;
    for (const add of qa('button.apply-flow-profile-item-tile__new-tile').filter((b) => isVisible(b) && /^add education$/i.test(cleanLabel(textOf(b))))) {
      const blk = add.closest('apply-flow-block') || add.parentElement;
      for (const tile of qa('article.apply-flow-profile-item-tile', blk).filter(isVisible)) {
        if (textOf(tile).includes(S.profile.school)) continue;
        const del = qa('button', tile).find((b) => /^delete$/i.test((b.getAttribute('aria-label') || textOf(b)).trim()));
        if (!del) continue;
        dbg('Oracle 删掉多余的教育', textOf(tile).slice(0, 80));
        logAI(`教育只留 ${S.profile.school}：删掉 ${cleanLabel(textOf(tile)).slice(0, 60)}`);
        del.click();
        n++;
        await sleep(800);
      }
    }
    for (let guard = 0; guard < 6; guard++) {
      const item = qa('.beautiful-timeline-item').filter(isVisible).find((e) => /\b(university|college|institute|school|academy)\b/i.test(textOf(e)) && !textOf(e).includes(S.profile.school));
      if (!item) break;
      oraHover(item);
      await sleep(300);
      const del = q('.beautiful-timeline-item__delete-icon', item);
      if (!del) break;
      logAI(`教育只留 ${S.profile.school}：删掉 ${cleanLabel(textOf(item)).slice(0, 60)}`);
      del.click();
      n++;
      await waitFor(() => !item.isConnected || !isVisible(item), 4000, 200);
      await sleep(400);
    }
    return n;
  }


  const oraHover = (el) => { for (const ty of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove']) el.dispatchEvent(new MouseEvent(ty, { bubbles: !/enter/.test(ty), cancelable: true, view: window })); };
  async function oraFixInvalidItems() {
    if (!isOracleCX()) return 0;
    let n = 0;
    const tried = new Set();
    for (let guard = 0; guard < 6 && alive(); guard++) {
      if (oraOpenForm()) break;
      const item = qa('.beautiful-timeline-item').filter(isVisible).find((e) => q('.beautiful-timeline-item--invalid-block', e) && !tried.has(textOf(e)));
      if (!item) break;
      tried.add(textOf(item));
      const t = norm(textOf(item));
      oraJob = workJobs().find((j) => (j.title && t.includes(norm(j.title))) || t.includes(norm(String(j.company || '').split(/[ (]/)[0]))) || null;
      oraHover(item);
      await sleep(300);
      const edit = q('.beautiful-timeline-item__edit-icon', item);
      if (!edit) continue;
      edit.click();
      const box = await waitFor(oraOpenForm, 3000, 200);
      if (!box) continue;
      setStatus(`补全标红的条目：${cleanLabel(textOf(item)).slice(0, 40)}`);
      await oraFillOpenForm(box, true);
      const save = qa('.save-btn, button.apply-flow-profile-item-button--add', box.closest('timeline-form-inline') || box.parentElement || document).find(isVisible);
      if (!save) break;
      save.click();
      if (!(await waitFor(() => !oraOpenForm(), 5000, 250))) { dbg('Oracle 条目补全后保存不了', textOf(item).slice(0, 60)); break; }
      n++;
      await sleep(600);
    }
    oraJob = null;
    return n;
  }

  async function oracleAddItems() {
    if (!isOracleCX()) return 0;
    let added = 0;
    const addedNow = new Set(); // 这一轮加过的公司：同一家再出现就说明页面上认不出来，停下，免得重复加
    for (let guard = 0; guard < 8 && alive(); guard++) {
      let box = oraOpenForm();
      let block;
      if (!box) {
        const tiles = [...new Set([...qa('button.apply-flow-profile-item-tile__new-tile'),
          ...qa('button', formScope()).filter((b) => !b.closest(ORA_FORM_SEL) && /^(\+\s*)?add (work )?(experience|education)$/i.test(cleanLabel(textOf(b))))])].filter(isVisible);
        const pick = tiles.map((b) => {
          const blk = b.closest('apply-flow-block') || b.parentElement;
          const t = cleanLabel(textOf(b));
          if (/^(\+\s*)?add education$/i.test(t)) {
            const bt = norm(oraBlockText(blk));
            const hasEdu = bt.includes(norm(S.profile.school)) || (S.profile.fieldOfStudy && bt.includes(norm(S.profile.fieldOfStudy)) && (!S.profile.eduEndYear || bt.includes(String(S.profile.eduEndYear))));
            return !addedNow.has('education') && !qa('article.apply-flow-profile-item-tile', blk).filter(isVisible).length && !hasEdu && S.profile.school ? { b, blk } : null;
          }
          if (/^(\+\s*)?add (work )?experience$/i.test(t)) { const j = oraNextJob(blk); return j ? { b, blk, j } : null; }
          return null;
        }).find(Boolean);
        if (!pick) break;
        if (pick.j && addedNow.has(pick.j.company)) { dbg('Oracle：这段经历刚加过、页面上还认不出，停止再加', pick.j.company); break; }
        block = pick.blk;
        oraJob = pick.j || null;
        setStatus(oraJob ? `添加工作经历：${oraJob.company}` : `添加教育：${S.profile.school}`);
        pick.b.click();
        box = await waitFor(oraOpenForm, 4000, 200);
        if (!box) break;
      } else {
        block = box.closest('apply-flow-block') || document;
        if (oraKindOf(box) === 'experience' && !oraJob) oraJob = oraNextJob(block);
      }
      await oraFillOpenForm(box);
      const save = qa('.save-btn', box.closest('.standard-apply-flow-profile-item') || box.parentElement || document).find(isVisible)
        || qa('button.apply-flow-profile-item-button--add, button.timeline-work-add-button, button.timeline-education-add-button', box).find(isVisible);
      if (!save) { dbg('Oracle 小表没找到保存按钮'); break; }
      save.click();
      if (!(await waitFor(() => !oraOpenForm(), 5000, 250))) { dbg('Oracle 小表保存后还开着（有格子没填对）'); break; }
      addedNow.add(oraJob ? oraJob.company : 'education');
      oraJob = null;
      added++;
      await sleep(600);
    }
    return added;
  }

  async function oraDropStaleCoverLetter() {
    if (!isOracleCX() || S.settings.aiCoverLetter === 'off' || S.settings.useAI === false) return;
    if (!textOf(formScope()).includes(clFileName())) return;
    const rm = qa('button, a', formScope()).find((b) => isVisible(b) && /^remove cover letter$/i.test(cleanLabel(textOf(b))));
    if (!rm) return;
    try {
      const d = await chrome.storage.local.get('coverLetters');
      if (d.coverLetters && d.coverLetters[clKey()]) return; // 这个职位写过，挂着的就是它
    } catch (_) { return; }
    dbg('Oracle 带过来的 cover letter 不是这个职位的，移除重写');
    rm.click();
    await waitFor(() => !textOf(formScope()).includes(clFileName()), 4000, 200);
    await sleep(500);
  }

  function phoneCountryAnswer(f) {
    if (f.kind !== 'popcombo' && f.kind !== 'select' && f.kind !== 'combo') return null;
    const box = f.el.closest('[class*="phone-country" i], [data-dropdown-id*="country_code" i], [class*="country-code" i]');
    if (!box || !/united states/i.test(S.profile.country || 'United States')) return null;
    return { key: 'phoneCountry', value: 'United States (+1)', alts: ['United States (+1)', 'United States of America (+1)', 'United States', 'USA (+1)', 'US (+1)'] };
  }
  async function aiReviewPage() {
    if (S.settings.useAI === false || S.settings.aiReview === false) return 0;
    const all = collectFields().filter((f) => f.question && !CRED_RE.test(norm(f.question)) && !(f.el.type === 'password') && f.el.isConnected);
    if (!all.length) return 0;
    const section = (f) => {
      const parts = [];
      const h = precedingHeading(f.el);
      if (h) parts.push(h.slice(0, 60));
      for (let fs = f.el.closest('fieldset'); fs && parts.length < 4; fs = fs.parentElement && fs.parentElement.closest('fieldset')) {
        const lg = fs.querySelector(':scope > legend');
        if (lg && textOf(lg)) parts.push(textOf(lg).slice(0, 50));
      }
      const idh = String(f.el.id || f.el.name || '').replace(/[^A-Za-z0-9._-]/g, ' ').slice(0, 60);
      if (/history|experience|employ|educat|school|reference|address|work/i.test(idh)) parts.push('field id: ' + idh);
      if (f.block === 'employer' && f.empIdx != null) parts.push(`work history #${f.empIdx + 1}`);
      return parts.join(' > ');
    };
    const valueOf = (f) => (isEmpty(f) ? '' : f.kind === 'text' ? String(f.el.value || '').trim().slice(0, f.el.tagName === 'TEXTAREA' ? 1500 : 300) : String(fieldAnswer(f) || (f.kind === 'popcombo' ? popText(f.el) : '')).slice(0, 200));
    const optionsOf = (f) => {
      if (f.kind === 'select') return [...f.el.options].filter((o) => o.value !== '' && !isPlaceholderOpt(o)).map((o) => o.text.trim()).filter(Boolean).slice(0, 80);
      if (f.kind === 'radio' || f.kind === 'checkgroup') return f.els.map(choiceLabel).filter(Boolean).slice(0, 40);
      return undefined;
    };
    const list = all.slice(0, 90).map((f, i) => ({
      id: String(i), section: section(f), question: f.question.slice(0, 220), type: f.kind === 'text' ? (f.el.tagName === 'TEXTAREA' ? 'long text' : 'text') : f.kind === 'checkgroup' ? 'multi choice' : 'choice',
      required: isRequired(f), value: valueOf(f), options: optionsOf(f),
    }));
    const sig = location.href.split('#')[0] + '|' + list.map((x) => x.question + '=' + x.value).join('|');
    if (reviewedSigs.has(sig) && !lastPageErrors.length) return 0;
    reviewedSigs.add(sig);
    setStatus(`🔎 Codex 正在复核整页（${list.length} 题，半分钟左右）…`);
    const info = await getJobInfo();
    const res = await askAI({
      action: 'review', fields: list, pageErrors: lastPageErrors.slice(0, 8), profile: S.profile, confirmed: confirmedText(),
      resumePdf: ((currentPick && currentPick.resume) || S.resumes.find((r) => r.id === S.defaultResumeId) || S.resumes[0] || {}).data || '',
      job: { title: info.title || jobTitleFromPage(), company: jobCompany(), url: location.href },
    }, 240000);
    if (!res || !res.ok) { dbg('复核没成', res && res.error); return 0; }
    let n = 0;
    for (const fx of res.fixes || []) {
      const f = all[Number(fx.id)];
      if (!f || !f.el.isConnected) continue;
      if (knockoutVeto(f.question, fx.value)) { logAI(`🛡 拦下复核：没把资格题改成「${fx.value || '空'}」：${f.question.slice(0, 40)}`); dbg('复核要把资格题改成否定，拦下', f.question, fx); continue; }
      let ok = false;
      try {
        if (!fx.value) {
          if (f.kind === 'text') { setText(f.el, ''); ok = true; }
          else if (f.kind === 'select') { const ph = [...f.el.options].find((o) => o.value === '' || isPlaceholderOpt(o)); if (ph) { setNative(f.el, ph.value); ok = true; } }
        } else if (f.kind === 'text') { setText(f.el, fx.value); ok = true; }
        else ok = !!(await fillField(f, { key: 'AI', value: fx.value, alts: [fx.value] }));
      } catch (e) { dbg('复核改不上', f.question, e); }
      dbg('复核', f.question, '=>', fx.value || '(清空)', '|', fx.reason, '|', ok);
      if (!ok) continue;
      n++;
      logAI(`🔎 ${f.question.slice(0, 40)} → ${(fx.value || '清空').slice(0, 40)}（${String(fx.reason || '').slice(0, 30)}）`);
      await sleep(f.kind === 'text' ? 60 : 300);
    }
    return n;
  }
  const reviewedSigs = new Set();

  const NEVER_NEEDED_RE = /^address (line )?[34]\b/;
  const mustWriteCL = (f) => f.kind === 'text' && f.el.tagName === 'TEXTAREA' && /cover letter/i.test(f.question) && /\brequires? (a )?cover letter|cover letter is required/i.test(f.question);
  const stillNeeded = (f) => (isRequired(f) || mustWriteCL(f)) && isEmpty(f) && !NEVER_NEEDED_RE.test(norm(f.question));
  function isTalentSignupPage() {
    if (/\/closedjob\b/i.test(location.pathname)) return true;
    const h = qa('h1, h2').find((e) => isVisible(e) && !e.closest('#wdaf-host'));
    return !!h && /^(let'?s connect|join (our|the) talent (community|network|pool)|talent (community|network) sign ?up)/i.test(cleanLabel(textOf(h)));
  }
  const srAcOpts = (ac) => srDeep(ac.shadowRoot, '[role="option"]').map((o) => ({ el: o, text: textOf(o) || textOf(shadowHost(o)) })).filter((o) => o.text && isVisible(o.el) && !/^(no matches|no results|no options)/i.test(o.text));
  async function srClearAc(f) {
    f.el.focus();
    f.el.select?.();
    try { document.execCommand('delete'); } catch (_) { /* ignore */ }
    if (f.el.value) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(f.el, ''); }
    f.el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    f.el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Backspace', bubbles: true, composed: true }));
    await sleep(300);
  }
  function srAcPicked(f) {
    const v = norm(f.el.value || '');
    return !!v && srDeep(f.srAc.shadowRoot, '[role="option"]').some((o) => norm(textOf(o) || textOf(shadowHost(o)) || (shadowHost(o) || {}).textContent || '') === v);
  }
  async function srAcOptions(f) {
    f.el.scrollIntoView({ block: 'center' });
    for (let i = 0; i < 3; i++) {
      if (i) { f.el.blur(); await sleep(250); }
      f.el.focus();
      srFire(f.el);
      if (i === 2) f.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, bubbles: true, composed: true }));
      const o = await waitFor(() => { const x = srAcOpts(f.srAc); return x.length ? x : null; }, 2000, 200);
      if (o) return o;
    }
    dbg('SmartRecruiters 下拉打不开', f.question);
    return [];
  }
  async function fillSrSelect(f, cands, ans) {
    if (f.el.value && !srAcPicked(f)) await srClearAc(f); // 上次没选上留下的字先清掉，不然列表被它筛空（只剩 No matches）
    let opts = await srAcOptions(f);
    dbg('SmartRecruiters 下拉', f.question.slice(0, 40), '| 选项', opts.length, opts.map((o) => o.text).slice(0, 6));
    let hit = opts.length ? chooseOption(opts, cands, ans) : null;
    for (const term of hit ? [] : [...new Set(cands.filter(Boolean).map(String))].slice(0, 3)) {
      if (!running) break;
      await srClearAc(f);
      setText(f.el, term);
      f.el.dispatchEvent(new KeyboardEvent('keyup', { key: term.slice(-1), bubbles: true, composed: true }));
      opts = (await waitFor(() => { const o = srAcOpts(f.srAc); return o.length ? o : null; }, 3000, 300)) || [];
      if (!opts.length) { srFire(f.el); opts = (await waitFor(() => { const o = srAcOpts(f.srAc); return o.length ? o : null; }, 2000, 300)) || []; }
      hit = chooseOption(opts, cands, ans) || pickAny(opts, cands, 3);
      if (hit) break;
    }
    if (!hit) { dbg('SmartRecruiters 下拉没对上', f.question, cands, opts.map((o) => o.text).slice(0, 10)); if (f.el.value) await srClearAc(f); f.el.blur(); return false; }
    srFire(hit.el);
    await sleep(500);
    const ok = norm(f.el.value) === norm(hit.text) || /\bng-valid\b/.test(f.srAc.className);
    if (!ok) dbg('SmartRecruiters 下拉点了没选上', f.question, hit.text, f.el.value);
    return ok;
  }

  async function srCity() {
    if (!isSR()) return;
    const host = q('spl-autocomplete[data-test="location-autocomplete"], spl-autocomplete[label="City"]');
    if (!host || /\bng-valid\b/.test(host.className)) return;
    const deep = (root, sel) => { const out = [...root.querySelectorAll(sel)]; for (const el of root.querySelectorAll('*')) if (el.shadowRoot) out.push(...deep(el.shadowRoot, sel)); return out; };
    const inp = host.shadowRoot && deep(host.shadowRoot, 'input').find((i) => isVisible(i));
    if (!inp) return;
    const P = S.profile;
    const city = P.city;
    if (!city) return;
    for (const text of [city, `${city}, ${P.stateCode || US_STATES[norm(P.state || '')] || P.state || ''}`]) {
      inp.focus();
      setText(inp, text);
      inp.focus();
      inp.dispatchEvent(new KeyboardEvent('keyup', { key: 'y', bubbles: true, composed: true }));
      const optText = (o) => textOf(o) || textOf(shadowHost(o));
      const opt = await waitFor(() => [...deep(host.shadowRoot, '[role="option"], li'), ...deep(document, '.cdk-overlay-container [role="option"]')]
        .find((o) => isVisible(o) && norm(optText(o)).includes(norm(city))), 12000, 400);
      if (opt) { const target = textOf(opt) ? opt : (shadowHost(opt) || opt); mouseClick(target); target.click?.(); await sleep(600); if (/\bng-valid\b/.test(host.className)) { dbg('SmartRecruiters 城市选好了', optText(opt)); return; } }
    }
  }

  async function leverLocation() {
    const inp = q('input#location-input.location-input');
    const hid = q('input#selected-location[name="selectedLocation"]');
    if (!inp || !hid || !isVisible(inp) || (hid.value && hid.value.length > 5)) return;
    const P = S.profile;
    const city = P.city;
    if (!city) return;
    const st = P.stateCode || US_STATES[norm(P.state || '')] || P.state || '';
    for (const text of [`${city}, ${st}`.replace(/,\s*$/, ''), city, `${city}, ${st}`.replace(/,\s*$/, '')]) {
      typeInto(inp, '');
      await sleep(300);
      inp.focus();
      typeInto(inp, text);
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: text.slice(-1), bubbles: true }));
      inp.dispatchEvent(new KeyboardEvent('keyup', { key: text.slice(-1), bubbles: true }));
      const item = await waitFor(() => qa('.dropdown-results .dropdown-location, .dropdown-results > div').find((d) => isVisible(d) && norm(textOf(d)).includes(norm(city))), 15000, 400);
      if (item) { mouseClick(item); await sleep(500); if (hid.value) { dbg('Lever 所在地选好了', hid.value.slice(0, 80)); return; } }
    }
  }

  async function fillPage() {
    await loadState();
    clearHighlights();
    if (pageTranslated()) throw new Error('这页被浏览器翻译成中文了，插件只认英文原文。请点地址栏右边的翻译图标，选「英语」显示原文，再点一次「填写本页」或「自动到…」。');
    if (WD_HOST && (WD_LOCALE && !/^en-/.test(WD_LOCALE[1]) || /^(zh|ja|ko|fr|de|es|pt|it)\b/i.test(document.documentElement.lang || ''))) {
      throw new Error('这是 Workday 的' + (WD_LOCALE ? WD_LOCALE[1] : document.documentElement.lang) + ' 语言版页面，插件只认英文。请把网址里的语言段改成 en-US，或在页面最底下的语言选择里换成 English，再点一次「填写本页」。');
    }
    if (isSignInPage()) {
      setStatus('这是登录 / 创建账号页，请自己登录（插件不处理密码）。');
      return { filled: 0, missing: [] };
    }
    if (isTalentSignupPage()) throw new Error('这个职位已关闭，页面是「Let\'s connect / 加入人才库」登记表，不是申请。插件不填（不加入人才库）。');
    await leverLocation();
    await srCity();
    await waitForFields();
    const learned = await learnFromUser();
    if (learned) {
      setStatus(`🧠 已记住你答的 ${learned} 道题，以后遇到会自动答`);
      await sleep(1200);
    }
    let filled = 0;
    if (await uploadResume()) filled++;
    if (await uploadTranscript()) filled++;
    if (!isWD()) filled += await addEmploymentBlocks();
    if (isWD() && /experience/i.test(currentStep())) filled += await fillExperienceSections();

    const attempts = new Map(); // 每个字段最多试 2 次，避免死循环
    for (let pass = 0; pass < 30 && alive(); pass++) {
      let changed = 0;
      let tried = 0;
      const all = collectFields();
      for (const f of all) if (f.kind === 'text' && /\bmi\b|middle (name|initial)/i.test(f.question) && norm(f.el.value) === norm(valueFor('FULLNAME'))) setText(f.el, '');
      const fields = all
        .map((f) => ({ ...f, ans: oracleItemAnswer(f) || phoneCountryAnswer(f) || languageAnswer(f, all) || otherFollowAnswer(f) || (f.block === 'employer' ? workAnswer(f) : null) || refAnswer(f) || dateAnswer(f) || naAnswer(f) || workAnswer(f) || textDateAnswer(f) || ackAnswer(f) || (f.datePart ? null : resolveField(f) || agreeAnswer(f)) }))
        .filter((f) => !(f.ans && EDU_KEYS.has(f.ans.key) && foreignEduBlock(f.el)))
        .filter((f) => f.ans && f.ans.value && (isEmpty(f) || S.settings.overwrite || (f.ans.key === 'phone' && /\D/.test(f.el.value) && (isWD() || f.el.value.replace(/\D/g, '').slice(-10) !== String(f.ans.value).replace(/\D/g, '').slice(-10)))
          || (ADDRESS_KEYS.has(f.ans.key) && S.profile.address1) || (f.ans.empAddr && f.block === 'employer') || f.ans.key === 'phoneCountry' || (VISA_KEYS.has(f.ans.key) && CHOICE_KINDS.has(f.kind))) && !alreadyMatches(f, f.ans))
        .sort((a, b) => Number(b.ans.first) - Number(a.ans.first)); // 先填 Country：改了会刷新地址栏
      dbg(`第 ${pass + 1} 轮：认出 ${all.length} 题，要填 ${fields.length} 题\n认出：` + all.map((f) => `${f.kind}:${f.question.slice(0, 28)}`).join(' | ')
        + '\n要填：' + fields.map((f) => `${f.question.slice(0, 28)} => ${String(f.ans.value).slice(0, 25)}`).join(' | '));
      for (const f of fields) {
        if (!running) break;
        if (!f.el.isConnected) continue;
        const id = f.kind + '|' + f.question + '|' + (f.datePart || '') + '|' + f.occ;
        const n = attempts.get(id) || 0;
        if (n >= 2) continue;
        attempts.set(id, n + 1);
        tried++;
        setStatus(`填写：${f.question.slice(0, 40)}`);
        try {
          const r = await fillField(f, f.ans);
          if (r === 'stale') { attempts.set(id, n); break; } // 不算一次尝试
          if (r) changed++;
        } catch (e) {
          console.warn('[Workday 助手] 填写失败', f.question, e);
        }
        await sleep(f.kind === 'text' ? 60 : 250);
        if (f.ans.first || f.datePart) break; // 国家变了 / 年月日联动重建了下拉框，重新扫描
      }
      changed += await fillDates();
      if (!isWD()) changed += await addWorkBlockButton();
      filled += changed;
      if (!tried && !changed) break; // 没有可以再尝试的字段了
      await sleep(500);
    }

    filled += await oraDropExtraEducation();
    filled += await oraFixInvalidItems();
    filled += await oracleAddItems();
    for (const f of collectFields()) {
      if (f.kind === 'checkbox' && isChecked(f.el) && SUBSCRIBE_RE.test(norm(f.question + ' ' + textOf(f.el.parentElement) + ' ' + textOf(f.el.parentElement?.parentElement).slice(0, 200)))) { f.el.click(); if (isChecked(f.el)) mouseClick(f.el.labels?.[0] || f.el); filled++; await sleep(150); }
    }
    filled += await acceptPrivacyLink();
    for (const f of collectFields()) {
      if (f.kind !== 'checkbox' || f.block !== 'employer' || f.empIdx == null || !isChecked(f.el) || !/current(ly)? (work|employ|role|position|job)|still employed|i currently work|present/i.test(f.question)) continue;
      const job = (S.profile.workHistory || [])[f.empIdx];
      if (job && !job.current && job.end) { f.el.click(); if (isChecked(f.el)) mouseClick(f.el.labels?.[0] || f.el); filled++; await sleep(200); }
    }
    aiNote = '';
    await oraDropStaleCoverLetter();
    startCoverLetter();
    startWritingSample();
    startDocs();
    let after = collectFields();
    let missing = after.filter(stillNeeded);
    if (missing.length && alive()) {
      const n = await aiAnswerMissing(missing);
      if (n) {
        filled += n;
        await sleep(500);
        after = collectFields();
        missing = after.filter(stillNeeded);
      }
    }
    if (missing.length && alive()) {
      const n = await aiOperate(missing);
      if (n) {
        filled += n;
        await sleep(500);
        after = collectFields();
        missing = after.filter(stillNeeded);
      }
    }
    if (alive()) {
      const n = await aiReviewPage();
      if (n) {
        filled += n;
        await sleep(600);
        after = collectFields();
        missing = after.filter(stillNeeded);
      }
    }
    filled += await finishCoverLetter();
    filled += await finishWritingSample();
    filled += await finishDocs();
    missing = [...missing, ...emptyRequiredDates()];
    const ko = knockoutSummary(after);
    if (ko.length) logAI(`🛡 本页资格题：${ko.slice(0, 6).join('；')}`);
    highlight(missing);
    rememberUnanswered(after);
    return { filled, missing, learned };
  }


  const appKey = () => location.hostname + jobKey().replace(/\/section\/\d+.*$/, '');
  async function snapshotPage(step) {
    try {
      const answers = collectFields().filter((f) => f.question && !f.datePart).map((f) => ({
        q: f.question.replace(/\s+/g, ' ').slice(0, 160),
        a: isEmpty(f) ? '' : String(f.kind === 'text' ? f.el.value : f.kind === 'checkbox' ? (isChecked(f.el) ? 'Yes（已勾）' : '') : fieldAnswer(f)).replace(/\s+/g, ' ').slice(0, 300),
        req: !!isRequired(f),
      }));
      if (!answers.length) return;
      const d = await chrome.storage.local.get('appSnapshots');
      const all = d.appSnapshots || {};
      const k = appKey();
      const rec = all[k] || { company: jobCompany(), title: (jobTitleFromPage() || document.title).replace(/\s+/g, ' ').slice(0, 160), url: location.href.split('#')[0], pages: [] };
      step = String(step || document.title).slice(0, 80);
      rec.pages = rec.pages.filter((x) => x.step !== step);
      rec.pages.push({ step, time: Date.now(), answers });
      rec.time = Date.now();
      all[k] = rec;
      for (const x of Object.keys(all).sort((a, b) => (all[b].time || 0) - (all[a].time || 0)).slice(150)) delete all[x]; // 只留最近 150 份
      await chrome.storage.local.set({ appSnapshots: all });
    } catch (e) { dbg('答卷快照没存上', e); }
  }
  async function healthCard() {
    try {
      await waitFor(() => S.resumes.some((r) => r.name && textOf(document.body).includes(r.name)), 6000, 400);
      const rec = ((await chrome.storage.local.get('appSnapshots')).appSnapshots || {})[appKey()];
      const answers = rec ? rec.pages.flatMap((x) => x.answers) : [];
      const body = textOf(document.body);
      const lines = [];
      const resumeOn = S.resumes.some((r) => r.name && body.includes(r.name)) || qa('input[type="file"]').some((i) => i.files && i.files.length && /resume|\bcv\b/.test(fileCtxOwn(i)));
      lines.push(resumeOn ? '简历 ✓' : '简历 ✗（页面上没看到简历文件名，请确认）');
      if (body.includes(clFileName())) lines.push('cover letter ✓');
      if (S.transcript && S.transcript.name && body.includes(S.transcript.name)) lines.push('成绩单 ✓');
      const filled = (re) => new Set(answers.filter((x) => re.test(norm(x.q)) && x.a).map((x) => norm(x.a))).size;
      const edu = filled(/^(school|university|school or university|institution|college)( name)?\b/);
      const emp = filled(/^(company|employer)( name)?\b/);
      if (edu) lines.push(`教育 ${edu} 段`);
      if (emp) lines.push(`经历 ${emp} 段`);
      const ko = [...new Set(answers.filter((x) => x.a && (isKnockout(x.q) || /sponsor|authori[sz]ed to work|work authori[sz]ation/.test(norm(x.q))))
        .map((x) => `${x.q.slice(0, 30)} → ${x.a.slice(0, 14)}`))];
      const emptyReq = [...new Set(answers.filter((x) => x.req && !x.a).map((x) => x.q.slice(0, 40)))];
      logAI(`🩺 体检：${lines.join('，')}`);
      if (ko.length) logAI(`🛡 资格题：${ko.slice(0, 8).join('；')}`);
      if (emptyReq.length) logAI(`⚠ 前面几页有必填项是空着记下的：${emptyReq.slice(0, 5).join('；')}（请在 Review 页核对）`);
    } catch (e) { dbg('体检卡没出来', e); }
  }


  let lastPageErrors = [];
  const repairedPages = new Set();
  function pageErrors() {
    const errs = visibleErrors();
    for (const qn of markErrorRequired()) if (errs.length < 8) errs.push(`「${qn.slice(0, 60)}」必填`);
    for (const e of qa('[class*="error" i], [class*="invalid" i], [id*="error" i]', formScope())) {
      if (errs.length >= 8) break;
      if (!isVisible(e) || e.closest('#wdaf-host') || e.matches('h1, h2, h3, h4, header, title') || textOf(e) === document.title || qa('input, select, textarea', e).length) continue;
      const t = cleanLabel(textOf(e)).replace(/\s+/g, ' ');
      if (t && t.length <= 160 && !errs.includes(t)) errs.push(t);
    }
    return errs;
  }
  async function repairAndRetry(sig, wait) {
    const key = location.href.split('#')[0] + '|' + (isWD() ? currentStep() : '');
    const next = findNextButton();
    if (!next || repairedPages.has(key) || findSubmitButton() === next) return { moved: false };
    repairedPages.add(key);
    lastPageErrors = pageErrors();
    const bad = collectFields().filter((f) => (f.els || [f.el]).some((e) => e.getAttribute('aria-invalid') === 'true') || stillNeeded(f));
    for (const f of bad) { aiTried.delete(f.kind + '|' + f.question); opTried.delete(location.href + '|' + recipeKey(f)); }
    reviewedSigs.clear();
    dbg('下一步没过，自修一轮', lastPageErrors, bad.map((f) => f.question));
    setStatus(`下一步没过${lastPageErrors.length ? '（' + lastPageErrors.slice(0, 2).join('；').slice(0, 80) + '）' : ''}，自己修一轮再试…`);
    let rep;
    try { rep = await fillPage(); } finally { lastPageErrors = []; }
    if (!running) return { moved: false };
    if (rep.missing.length) return { moved: false, missing: rep.missing };
    const b = findNextButton();
    if (!b || findSubmitButton() === b) return { moved: false };
    await sleep(S.settings.stepDelay || 800);
    b.click();
    return { moved: !!(await waitFor(() => !running || pageSig() !== sig, wait, 400)) };
  }

  function visibleErrors() {
    const title = norm(document.title);
    return qa('[data-automation-id="errorMessage"], [data-automation-id*="errorBanner" i], [role="alert"]')
      .filter((e) => isVisible(e) && !e.closest('#wdaf-host'))
      .map(textOf)
      .filter((t) => t && norm(t) !== title && !/^apply\s*[-–—]/i.test(t));
  }

  const buttonText = (b) => cleanLabel(textOf(b) || b.value || b.getAttribute('aria-label') || '');
  const pageButtons = () => qa('button, input[type="submit"], input[type="button"], a[role="button"], [role="button"], a.btn' + (isSR() ? ', spl-button' : ''), formScope())
    .filter((b) => isVisible(b) && !b.closest('#wdaf-host') && !b.disabled);
  const NEXT_RE = /^(save (and|&) continue|save (and|&) next|skip (and|&) continue|next|next step|next section|next page|continue|continue to next (step|section|page)|proceed|下一步|下一页|继续)( ?[>›→»])?$/i; // Google 表单中文界面是「下一页」
  const SUBMIT_RE = /^(submit|submit application|submit my application|submit your application|apply|apply now|send application|complete application|finish|finish application|提交|提交申请)$/i;

  function findNextButton() {
    const byId = qa('[data-automation-id="pageFooterNextButton"], [data-automation-id="bottom-navigation-next-button"]').find(isVisible);
    if (byId) return byId;
    return pageButtons().find((b) => NEXT_RE.test(buttonText(b)));
  }

  function findSubmitButton() {
    return pageButtons().find((b) => SUBMIT_RE.test(buttonText(b)));
  }

  function isMixedSignupPage() {
    if (isWD() || !qa('input[type="password"]').some(isVisible)) return false;
    const others = qa('input:not([type="hidden"]):not([type="password"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]), select, textarea')
      .filter((e) => !e.closest('#wdaf-host') && (isVisible(e) || e.type === 'file') && !/user ?name|login|captcha/i.test(`${e.name} ${e.id} ${e.getAttribute('autocomplete') || ''}`));
    return others.length >= 4 || others.some((e) => e.type === 'file');
  }

  function isSignInPage() {
    if (!isWD()) return qa('input[type="password"]').some(isVisible) && !isMixedSignupPage(); // 通用网站：只有登录框的页面才算登录 / 注册页
    return isVisible(q('[data-automation-id="signInContent"]')) || /sign in|create account/i.test(currentStep());
  }

  const pageSig = () => isWD()
    ? currentStep() + '|' + location.pathname
    : location.href + '|' + document.title + '|' + collectFields().map((f) => f.question).join('|').slice(0, 800);

  const Q_DONE_RE = /application (has been |was )?(successfully )?(submitted|received|sent)|thank you for (applying|your application|submitting)|thanks for applying|successfully (applied|submitted)|we('ve| have) received your application|your application has been sent|application submitted|application success\b|we('re| are) thrilled that you('re| are) interested|感[谢謝](您)?(的申[请請]|申[请請]|花[时時][间間]申[请請]|投[递遞])|申[请請](已|已[经經])(提交|送出|收到)|已收到[你您]的申[请請]/i; // Greenhouse 按浏览器语言显示确认页（Garda 实测是中文「感謝您花時間申請」）
  const US_PERSON_RE = /legally requires? .{0,30}u\.?s\.? person|requires? ["“]?u\.?s\.? person["”]? status|must be (a )?u\.?s\.? (citizen|person)\b|(only|exclusively) (open|available) to u\.?s\.? citizens|u\.?s\.? citizenship (is )?(required|mandatory)|requires? u\.?s\.? citizenship/i;
  const Q_CLOSED_RE = /(this|the) (job|position|posting|requisition|role|opening)( posting)? (is )?(no longer|not) (available|accepting|open|active)|(job|position|posting|requisition) (has been |is )?(closed|filled|expired|removed)|no longer accepting applications|(is )?not (currently )?accepting (new )?applications|page (you are looking for|you requested|you're looking for) (doesn'?t|does not|could not|cannot|can'?t) (exist|be found)|job not found|(this|the) job (is|has) (closed|expired)|sorry,? (this|the) (job|position|posting) /i;
  const Q_DUP_RE = /you('ve| have) already applied|already (applied|submitted an application) (for|to) this|you have previously applied (for|to) this|application already received/i; // Lever：…/already-received「Application already received」（BPM LLP）
  const Q_APPLY_RE = /^(apply|apply now|apply for (this|the) (job|position|role|opportunity)|apply to (this )?(job|position|role)|apply online|apply here|apply on (the )?company('s)? (site|website)|start (your |my )?application|i'?m interested|submit (an )?application)$/i;
  let qReported = false; // 这一轮自动流程已经回报过结果
  let qLastState = '';
  let qLastProgress = 0;

  function qSend(m) {
    if (!QUEUE || !alive()) return Promise.resolve();
    return new Promise((r) => {
      try { chrome.runtime.sendMessage({ type: 'queueReport', url: location.href.split('#')[0], ...m }, () => { void chrome.runtime.lastError; r(); }); } catch (_) { r(); }
    });
  }
  function qOut(state, note, missing) {
    if (!QUEUE) return;
    if (state !== 'login') qReported = true; // 等登录不算结果：登录后接着跑，后面卡住还要报
    if (state === qLastState && state !== 'submitted') return; // 同一个结果只报一次
    qLastState = state;
    qLastProgress = 0; // 之后一有进展马上报（你登录完，队列就知道这个网站可以接着投了）
    dbg('队列回报', state, note);
    QUEUE.status = 'needs';
    QUEUE.need = state;
    qSend({ state, note: String(note || '').slice(0, 400), missing: (missing || []).map((f) => (typeof f === 'string' ? f : f && f.question) || '') });
  }
  function qProgress() {
    if (!QUEUE || Date.now() - qLastProgress < 15000) return;
    qLastProgress = Date.now();
    if (qLastState === 'login') qLastState = '';
    qSend({ state: 'progress' });
  }
  const Q_DONE_PATH = /\/(confirmation|thank-?you|thanks|success|submitted|application-?complete)(\/|$)/i;
  function qSuccessNow(before, path0) {
    if (path0 && location.pathname !== path0 && Q_DONE_PATH.test(location.pathname)) return true;
    const m = textOf(document.body).slice(0, 30000).match(Q_DONE_RE);
    return !!m && !String(before || '').includes(m[0]);
  }
  function captchaVisible() {
    return qa('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[title*="captcha" i], iframe[title*="challenge" i]')
      .some((f) => isVisible(f) && f.offsetHeight >= 60 && !/size=invisible/.test(f.src || '') && !(/recaptcha/.test(f.src || '') && /anchor/.test(f.src || '') && f.offsetWidth <= 260));
  }
  const codeAsked = (before) => /(verification|security|confirmation) code|one[- ]time (pass)?code|enter the code (we|that was) (sent|emailed)/i.test(textOf(document.body).slice(0, 20000))
    && !/(verification|security|confirmation) code|one[- ]time (pass)?code/i.test(String(before || '').slice(0, 20000));
  const UPLOAD_BTN_RE = /^(choose (a )?file|select (a )?file|browse|upload( your| a)? (cv|resume|r[eé]sum[eé]|motivation|cover letter|file|document)s?|attach( your)? (cv|resume|file))$/i;
  function pickerUploaded(b) {
    for (let z = b.parentElement, i = 0; z && i < 4; z = z.parentElement, i++) {
      if (qa('button, [role="button"]', z).filter((x) => x !== b && UPLOAD_BTN_RE.test(cleanLabel(textOf(x)))).length) break;
      if (/\.(pdf|docx?)\b/i.test(textOf(z))) return true;
    }
    return false;
  }
  function pickerOnlyUploads() {
    return qa('button, [role="button"]').filter((b) => isVisible(b) && !b.closest('#wdaf-host') && UPLOAD_BTN_RE.test(cleanLabel(textOf(b)))
      && !q('input[type="file"]', b.parentElement || b) && !q('input[type="file"]', b.parentElement?.parentElement || b)
      && !inAutofillZone(b) && !pickerUploaded(b));
  }
  function qPreSubmitProblem() {
    const pick = pickerOnlyUploads();
    if (pick.length) return `有 ${pick.length} 个上传栏只能手动选文件（${pick.map((b) => cleanLabel(precedingText(b) || textOf(b)).slice(0, 25)).join('、')}），请你手动上传后再点 Submit`;
    const nearFileName = (i) => { for (let e = i, k = 0; e && k < 5; e = e.parentElement, k++) if (/\.(pdf|docx?|txt|rtf)\b/i.test(textOf(e).slice(0, 600))) return true; return false; };
    const emptyReqFile = qa('input[type="file"]').filter((i) => !i.closest('#wdaf-host') && !i.disabled && !(i.files && i.files.length) && !inAutofillZone(i)
      && (i.required || i.getAttribute('aria-required') === 'true') && !nearFileName(i) && !uploadedInputs.has(i)
      && !/resume|\bcv\b|curriculum|cover letter|covering letter/.test(fileCtx(i)));
    if (emptyReqFile.length) return `有 ${emptyReqFile.length} 个必填上传栏空着（${emptyReqFile.map((i) => cleanLabel(questionFor(i) || precedingText(fileZone(i)) || '上传').slice(0, 60)).join('；')}），要你准备好文件传上去`;
    const body = textOf(document.body);
    const resumeShown = S.resumes.some((r) => r.name && body.includes(r.name));
    const emptyResume = qa('input[type="file"]').filter((i) => /resume|\bcv\b/.test(fileCtxOwn(i)) && !(i.files && i.files.length));
    if (emptyResume.length && !resumeShown) return '简历栏是空的';
    const miss = collectFields().filter((f) => stillNeeded(f));
    if (miss.length) return `还有 ${miss.length} 个必填项空着`;
    return '';
  }
  const SPAM_FLAG_RE = /flagged as (possible |potential |likely )?spam|(suspected|possible) (spam|bot|automated)|unusual (activity|traffic)|automated (submission|traffic) (was )?detected/i;
  const spamFlagged = (before) => { const m = textOf(document.body).match(SPAM_FLAG_RE); return !!m && !String(before || '').includes(m[0]); };
  const Q_BLOCKED_MSG = '⏸ 网站没收插件点的提交（多半是网站的防机器人检查）。表都填好了，请你自己点一下 Submit。';
  async function qSubmitGeneric() {
    const bad = qPreSubmitProblem();
    if (bad) { setStatus(`没自动提交：${bad}。请检查。`); qOut('ready', '没自动提交：' + bad); return; }
    if (captchaVisible()) { setStatus('🧩 提交前要过人机验证，请你点一下验证再点 Submit。'); qOut('captcha', '提交前要过人机验证'); return; }
    for (let attempt = 0; attempt < 2 && running; attempt++) {
      const btn = findSubmitButton();
      if (!btn) break;
      const before = textOf(document.body);
      const path0 = location.pathname;
      await qSend({ state: 'submitting' });
      setStatus('批量队列：自动提交…');
      btn.click();
      const r = await waitFor(() => (!running ? 'stop' : qSuccessNow(before, path0) ? 'ok' : codeAsked(before) ? 'verify' : captchaVisible() ? 'captcha' : spamFlagged(before) ? 'spam' : null), 45000, 700);
      if (r === 'ok') { await addLog('已提交'); setStatus('🎉 已提交！'); qOut('submitted', '页面显示提交成功'); return; }
      if (r === 'verify') { setStatus(`📧 提交后要邮箱验证码（发到 ${S.profile.email || '你的邮箱'}），请你填进页面再点提交。`); qOut('verify', `提交后要邮箱验证码（发到 ${S.profile.email || '邮箱'}）`); return; }
      if (r === 'captcha') { setStatus('🧩 提交时要人机验证，请你过一下验证。'); qOut('captcha', '提交时要人机验证'); return; }
      if (r === 'spam') { await addLog('提交被拒'); setStatus('⏸ 网站的防垃圾检查拦下了插件点的提交。表都填好了，请你自己点一下 Submit。'); qOut('ready', '网站的防垃圾检查拦下了插件点的提交，等你自己点 Submit'); return; }
      if (r === 'stop') return;
      if (attempt === 0) {
        lastPageErrors = pageErrors();
        reviewedSigs.clear();
        try { const rep = await fillPage(); if (rep.missing.length) { await addLog('提交被拒'); setStatus(`提交没过，还有 ${rep.missing.length} 个必填项没填`, rep.missing.map((f) => f.question)); return; } } finally { lastPageErrors = []; }
      }
    }
    const errs = pageErrors();
    if (errs.length) await addLog('提交被拒');
    setStatus(errs.length ? `点了提交没成功，页面报错：${errs.slice(0, 3).join('；')}` : Q_BLOCKED_MSG);
    qOut('ready', errs.length ? '点了提交没成功：' + errs.slice(0, 3).join('；') : '网站没收插件点的提交，等你点一下 Submit');
  }
  async function qWaitDone() {
    const before = textOf(document.body);
    const path0 = location.pathname;
    if (await waitFor(() => !alive() || qSuccessNow(before, path0), 24 * 3600 * 1000, 3000) && alive()) { await addLog('已提交'); qOut('submitted', '你处理后提交成功'); }
  }
  async function queueDrive() {
    const afterSubmit = (QUEUE.submitAt && Date.now() - QUEUE.submitAt < 15 * 60000) || (QUEUE.status === 'needs' && ['ready', 'verify', 'captcha'].includes(QUEUE.need));
    if (afterSubmit && (Q_DONE_RE.test(textOf(document.body).slice(0, 30000)) || Q_DONE_PATH.test(location.pathname))) { await addLog('已提交'); qOut('submitted', '提交成功页'); return; }
    for (let i = 0; i < 8; i++) {
      await sleep(i ? 3000 : 2500);
      if (!alive()) return;
      if (appDetected || running || proxyChild || isWD()) return;
      if (maybeApplication()) { onDetected(); return; }
      const body = textOf(document.body).slice(0, 6000);
      if (Q_DUP_RE.test(body) || /\/already-received\/?$/.test(location.pathname)) { qOut('dup', '页面说已经投过'); return; }
      if (Q_CLOSED_RE.test(body) || /[?&]error=true/.test(location.search)) { qOut('closed', '职位已关闭：' + ((body.match(Q_CLOSED_RE) || [])[0] || location.search)); return; }
      if (/application submission is (currently )?unavailable|please try again later/i.test(body) && /ashbyhq\.com$/.test(location.hostname)) { setStatus('⏸ Ashby 暂时不收申请（多半是网站的防机器人限制）。过一阵请你自己打开试。'); qOut('ready', 'Ashby 暂时不收申请（多半是防机器人限制），过一阵你自己试'); return; }
      if (S.profile.needSponsorship === 'Yes' && US_PERSON_RE.test(body)) { setStatus('⛔ 这个职位只收美国公民 / 绿卡 / U.S. Person，不投。'); qOut('ineligible', '只收美国公民 / U.S. Person：' + body.match(US_PERSON_RE)[0]); return; }
      const a = qa('a, button, [role="button"], input[type="submit"], input[type="button"]')
        .filter((e) => isVisible(e) && !e.closest('#wdaf-host'))
        .find((e) => Q_APPLY_RE.test(cleanLabel(textOf(e) || e.value || e.getAttribute('aria-label') || '').replace(/\s*[›»→>]+$/, '')));
      if (!a || (QUEUE.hops || 0) >= 6) continue;
      QUEUE.hops = (QUEUE.hops || 0) + 1;
      await qSend({ state: 'hop' });
      setStatus('批量队列：点 Apply…');
      const href = a.tagName === 'A' && a.getAttribute('href');
      if (href && !/^(#|javascript:)/i.test(href)) location.assign(a.href); // 同一个标签页打开，不弹新窗口
      else a.click();
      await sleep(4000);
    }
    if (!appDetected && !running && !proxyChild && !isWD()) qOut('noform', '没找到申请表或 Apply 按钮');
  }

  async function onReview() {
    await addLog('已填到 Review');
    await healthCard();
    if (QUEUE ? !QUEUE_SUBMIT : !S.settings.autoSubmit) {
      setStatus('✅ 已到 Review 页。请检查一遍，确认无误后自己点 Submit。');
      qOut('ready', '已到 Review 页，等你点 Submit');
      return;
    }
    const btn = findSubmitButton();
    if (!btn) { setStatus('到了 Review 页，但没找到 Submit 按钮'); return; }
    const bad = QUEUE && qPreSubmitProblem();
    if (bad) { setStatus(`没自动提交：${bad}。请检查。`); return; }
    const before = textOf(document.body);
    await qSend({ state: 'submitting' });
    btn.click();
    const ok = await waitFor(() => qSuccessNow(before) || /application submitted|congratulations/i.test(textOf(document.body).slice(0, 5000)) && !/application submitted|congratulations/i.test(before.slice(0, 5000)), 30000, 500);
    await addLog(ok ? '已提交' : '已点提交（未确认）');
    setStatus(ok ? '🎉 已提交！' : '点了 Submit，请确认页面是否提交成功');
    if (QUEUE) qOut(ok ? 'submitted' : 'stuck', ok ? 'Workday 显示已提交' : '点了 Submit，没看到提交成功');
  }

  async function runGeneric() {
    for (let guard = 0; guard < 30 && running && alive(); guard++) {
      if (isSignInPage()) {
        setStatus('请先登录或注册（可用 Chrome 密码管理器），登录后点「自动到提交前」继续…');
        qOut('login', '要登录或注册：' + location.hostname);
        await waitFor(() => !running || !isSignInPage(), QUEUE ? 24 * 3600 * 1000 : 10 * 60 * 1000, 1000);
        await sleep(2000);
        continue;
      }
      qProgress();
      if (Q_DONE_PATH.test(location.pathname) && Q_DONE_RE.test(textOf(document.body).slice(0, 20000))) {
        await addLog('已提交');
        setStatus('🎉 已提交（这是提交成功页）');
        qOut('submitted', '提交成功页');
        break;
      }
      setStatus('正在填写本页…');
      const rep = await fillPage();
      if (!running) break;
      if (rep.missing.length && rep.missing.every((f) => /security code|verification code|enter the (8|eight)[- ]character code/i.test(f.question))) {
        setStatus(`📧 这页要邮箱验证码：Greenhouse 把 8 位验证码发到了 ${S.profile.email || '你的邮箱'}，请填进页面上的格子再点提交。`);
        qOut('verify', `Greenhouse 邮箱验证码（发到 ${S.profile.email || '邮箱'}）`);
        break;
      }
      if (rep.missing.length) {
        setStatus(`本页还有 ${rep.missing.length} 个必填项没填（已标红）。你手动答完后再点「自动到提交前」继续，插件会记住你的答案，下次自动答。`, rep.missing.map((f) => f.question));
        break;
      }
      if (isMixedSignupPage()) {
        setStatus('✅ 本页资料填好了，只剩「Create a login」的密码要你自己设（可用 Chrome 密码管理器）。设好后自己点页面上的继续按钮，插件会接着填下一页。');
        qOut('login', '要设登录密码（Create a login）：' + location.hostname);
        const sig = pageSig();
        await waitFor(() => !running || (!isMixedSignupPage() && pageSig() !== sig), QUEUE ? 24 * 3600 * 1000 : 15 * 60 * 1000, 1000);
        if (!running) break;
        await sleep(2000);
        continue;
      }
      const next = findNextButton();
      if (next && findSubmitButton()) {
        setStatus('✅ 本页填好了。这页同时有「下一步」和「提交」按钮，请你检查后自己点。');
        break;
      }
      if (!next && !findSubmitButton()) {
        const sig = pageSig();
        const newUpload = () => S.resumes.length && resumeInputs().some((i) => !uploadedInputs.has(i) && !(i.files && i.files.length));
        if (await waitFor(() => !running || pageSig() !== sig || findNextButton() || findSubmitButton() || newUpload(), 8000, 500)) {
          if (!running) break;
          await sleep(1500);
          continue;
        }
      }
      if (!next) {
        await addLog('已填到提交前');
        await snapshotPage('最后一页');
        await healthCard();
        if (QUEUE && QUEUE_SUBMIT && findSubmitButton()) { await qSubmitGeneric(); break; }
        if (QUEUE) qOut('ready', findSubmitButton() ? '填到最后一页了，等你点 Submit' : '没找到下一步 / 提交按钮');
        setStatus(findSubmitButton()
          ? '✅ 已经填到最后一页。请从头检查一遍，确认无误后自己点 Submit。'
          : '✅ 本页填好了。没找到「下一步」按钮，请检查后自己继续或提交。');
        break;
      }
      await sleep(S.settings.stepDelay || 800);
      await snapshotPage(document.title + ' · ' + (collectFields()[0]?.question || '').slice(0, 30));
      const sig = pageSig();
      next.click();
      const moved = await waitFor(() => !running || pageSig() !== sig, 15000, 500);
      if (!running) break;
      if (!moved) {
        const rr = await repairAndRetry(sig, 15000);
        if (!running) break;
        if (rr.moved) { await sleep(1500); continue; }
        if (rr.missing) { setStatus(`本页还有 ${rr.missing.length} 个必填项没填（已标红）。你手动答完后再点「自动到提交前」继续，插件会记住你的答案，下次自动答。`, rr.missing.map((f) => f.question)); break; }
        const errs = pageErrors();
        setStatus(errs.length ? `页面报错，请手动处理：${errs.slice(0, 3).join('；')}` : '点了下一步，但页面没有变化，请检查有没有漏填的。');
        break;
      }
      await sleep(1500);
    }
  }

  async function runAuto() {
    if (running) return;
    running = true;
    qReported = false;
    if (Q_DONE_PATH.test(location.pathname) && Q_DONE_RE.test(textOf(document.body).slice(0, 20000))) {
      running = false;
      sessionStorage.removeItem(AUTO_KEY);
      await addLog('已提交');
      setStatus('🎉 已提交（这是提交成功页）');
      qOut('submitted', '提交成功页');
      renderPanel();
      return;
    }
    if (!QUEUE) {
      const done = await new Promise((res) => { try { chrome.runtime.sendMessage({ type: 'jobDone', urls: [location.href] }, (r) => res(chrome.runtime.lastError ? null : r)); } catch (_) { res(null); } });
      if (done && done.done) {
        running = false;
        sessionStorage.removeItem(AUTO_KEY);
        setStatus(`⛔ 这个职位已经交过（${done.when || ''} ${done.status || ''}），不再填，免得重复投递。真要再投，先在投递记录里删掉那条。`);
        renderPanel();
        return;
      }
    }
    sessionStorage.setItem(AUTO_KEY, '1');
    renderPanel();
    await loadState();
    try {
      if (!isWD()) { await runGeneric(); return; }
      for (let guard = 0; guard < 40 && running && alive(); guard++) {
        qProgress();
        const start = [S.settings.startMode, 'autofillWithResume', 'applyManually']
          .map((id) => q(`[data-automation-id="${id}"]`)).find(isVisible);
        if (start) {
          setStatus('选择申请方式…');
          start.click();
          await waitFor(() => q('[data-automation-id="applyFlowPage"]'), 15000, 300);
          await sleep(1000);
          continue;
        }
        const apply = q('[data-automation-id="adventureButton"]');
        if (apply && isVisible(apply) && !q('[data-automation-id="applyFlowPage"]')) {
          setStatus('点击 Apply…');
          apply.click();
          await waitFor(() => [S.settings.startMode, 'autofillWithResume', 'applyManually']
            .some((id) => isVisible(q(`[data-automation-id="${id}"]`))) || q('[data-automation-id="applyFlowPage"]'), 8000, 300);
          await sleep(500);
          continue;
        }
        if (isSignInPage()) {
          setStatus('请先登录或创建账号（可用 Chrome 密码管理器），登录后会自动继续…');
          qOut('login', '要登录或创建 Workday 账号：' + location.hostname.split('.')[0]);
          await waitFor(() => !running || !isSignInPage(), QUEUE ? 24 * 3600 * 1000 : 10 * 60 * 1000, 1000);
          await sleep(2000);
          continue;
        }
        const step = currentStep();
        if (!step) {
          setStatus('等待申请表加载…');
          if (!(await waitFor(() => currentStep() || isSignInPage(), 15000, 500))) {
            const body = textOf(document.body).slice(0, 6000);
            if (QUEUE && Q_CLOSED_RE.test(body)) { qOut('closed', '职位已关闭：' + body.match(Q_CLOSED_RE)[0]); break; }
            if (QUEUE && Q_DUP_RE.test(body)) { qOut('dup', '页面说已经投过'); break; }
            setStatus('没找到申请表。请先打开职位页或申请页。');
            break;
          }
          continue;
        }
        if (/review/i.test(step)) { await onReview(); break; }

        setStatus(`正在填写：${step}`);
        const rep = await fillPage();
        if (!running) break;
        if (rep.missing.length) {
          setStatus(`「${step}」还有 ${rep.missing.length} 个必填项没填（已标红）。你手动答完后再点「自动到 Review」继续，插件会记住你的答案，下次自动答。`, rep.missing.map((f) => f.question));
          break;
        }
        await sleep(S.settings.stepDelay || 800);
        const next = findNextButton();
        if (!next) { setStatus('找不到 Save and Continue 按钮'); break; }
        await snapshotPage(step);
        const sig = pageSig();
        next.click();
        const moved = await waitFor(() => !running || pageSig() !== sig, 20000, 400);
        if (!running) break;
        if (!moved) {
          const rr = await repairAndRetry(sig, 20000);
          if (!running) break;
          if (rr.moved) { await sleep(1200); continue; }
          if (rr.missing) { setStatus(`「${step}」还有 ${rr.missing.length} 个必填项没填（已标红）。你手动答完后再点「自动到 Review」继续，插件会记住你的答案，下次自动答。`, rr.missing.map((f) => f.question)); break; }
          const errs = pageErrors();
          setStatus(errs.length ? `页面报错，请手动处理：${errs.slice(0, 3).join('；')}` : '点了下一步，但页面没有变化，请检查。');
          break;
        }
        await sleep(1200);
      }
    } catch (e) {
      console.error('[Workday 助手]', e);
      setStatus('出错了：' + e.message);
    } finally {
      running = false;
      if (alive()) sessionStorage.removeItem(AUTO_KEY);
      renderPanel();
      if (QUEUE && alive()) {
        if (!qReported) qOut('stuck', statusText, missingList);
        else if (['verify', 'captcha', 'ready'].includes(qLastState)) qWaitDone();
      }
    }
  }

  async function fillOnce() {
    if (running) return;
    running = true;
    renderPanel();
    try {
      setStatus('正在填写本页…');
      const rep = await fillPage();
      setStatus(rep.missing.length
        ? `填了 ${rep.filled} 项，还有 ${rep.missing.length} 个必填项需要你手动填（已标红）。手动答过的题插件会记住。`
        : `填了 ${rep.filled} 项，本页必填项都已完成。`, rep.missing.map((f) => f.question));
    } catch (e) {
      console.error('[Workday 助手]', e);
      setStatus('出错了：' + e.message);
    } finally {
      running = false;
      renderPanel();
    }
  }

  document.addEventListener('click', (e) => {
    if (!(appDetected || isWD())) return;
    const b = e.target.closest && e.target.closest('button, input[type="submit"], [role="button"]');
    if (!b) return;
    if (isWD() ? /^submit( application)?$/i.test(textOf(b)) && /review/i.test(currentStep()) : SUBMIT_RE.test(buttonText(b))) addLog(QUEUE ? '已点提交' : '已提交');
    if (!running && pending.length && b === findNextButton()) saveLearned(collectLearned());
  }, true);


  let panel = null;
  let statusText = '准备就绪';
  let missingList = [];

  function setStatus(msg, missing) {
    statusText = msg;
    if (missing) missingList = missing;
    else if (!/还有/.test(msg)) missingList = [];
    renderPanel();
    noteStop(msg);
  }

  const STOP_RE = /必填项|请检查|请手动|请把|请点|请自己|没写成|没答上|出错|失败|超时|只认英文|报错/;
  let lastNote = '';
  function noteStop(msg) {
    if (!STOP_RE.test(msg) || /必填项都已完成/.test(msg) || IN_FRAME && proxyChild || Q_DONE_PATH.test(location.pathname)) return; // 确认页上不报停下 // 「本页必填项都已完成」是好消息，不算停下
    const key = location.href.split('#')[0] + '|' + msg;
    if (key === lastNote) return;
    lastNote = key;
    try {
      askAI({ action: 'note', text: msg, missing: missingList.slice(0, 20), url: location.href.split('#')[0], title: document.title.slice(0, 120), build: BUILD }, 15000).catch(() => {});
    } catch (_) { /* 测试页没有本地连接 */ }
  }

  function buildPanel() {
    const host = document.createElement('div');
    host.id = 'wdaf-host';
    host.dataset.build = BUILD;
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483646;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .box { width: 280px; font: 13px/1.45 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
          background: #fff; color: #1d2330; border: 1px solid #d5dae3; border-radius: 12px;
          box-shadow: 0 8px 28px rgba(0,0,0,.18); overflow: hidden; }
        .hd { display:flex; align-items:center; justify-content:space-between; padding: 8px 12px;
          background: #0b6bcb; color: #fff; font-weight: 600; cursor: pointer; user-select: none; }
        .bd { padding: 10px 12px 12px; }
        .btns { display:grid; grid-template-columns: 1fr 1fr; gap: 6px; }
        button { font: inherit; padding: 7px 8px; border-radius: 7px; border: 1px solid #0b6bcb;
          background: #0b6bcb; color: #fff; cursor: pointer; }
        button.ghost { background: #fff; color: #0b6bcb; }
        button.stop { background: #fff; color: #c4372b; border-color: #c4372b; }
        button:disabled { opacity: .5; cursor: default; }
        .st { margin-top: 8px; color: #3b4352; word-break: break-word; }
        ul { margin: 6px 0 0; padding-left: 18px; max-height: 120px; overflow: auto; color: #c4372b; }
        ul.ailog { color: #0b6bcb; list-style: none; padding-left: 0; }
        ul.ailog li::before { content: '🤖 '; }
        .min .bd { display: none; }
        .warn { margin-top: 6px; color: #9a6700; white-space: pre-line; }
        .rs { margin-bottom: 8px; }
        .rs label { display:block; color: #687082; font-size: 12px; margin-bottom: 3px; }
        .rs select { flex: 1; min-width: 0; font: inherit; padding: 5px 6px; border: 1px solid #d5dae3; border-radius: 6px; background: #fff; color: #1d2330; }
        .rrow { display: flex; gap: 6px; }
        .rrow button { padding: 4px 10px; white-space: nowrap; }
        .clview, .wsview { width: 100%; margin-top: 6px; padding: 4px 8px; }
        .why { color: #687082; font-size: 12px; margin-top: 3px; }
      </style>
      <div class="box">
        <div class="hd"><span>⚡ 自动投递</span><span class="tg">–</span></div>
        <div class="bd">
          <div class="rs">
            <label>本职位用的简历</label>
            <div class="rrow"><select class="rsel"></select><button class="ghost view" title="打开这份简历看看">查看</button></div>
            <div class="why"></div>
            <button class="ghost clview" title="打开这个职位 Codex 写的 cover letter">查看这次的 cover letter</button>
            <button class="ghost wsview" title="打开插件上传的 writing sample（Codex 写的，各申请共用）">查看 writing sample</button>
          </div>
          <div class="btns">
            <button class="fill">填写本页</button>
            <button class="auto">自动到 Review</button>
            <button class="stop">停止</button>
            <button class="ghost opts">设置</button>
            <button class="ghost allgo" title="让所有打开着的申请页一起开始「自动到提交前」">所有申请页一起开始</button>
          </div>
          <div class="st"></div>
          <ul class="miss"></ul>
          <ul class="ailog"></ul>
          <div class="warn"></div>
        </div>
      </div>`;
    const $ = (s) => root.querySelector(s);
    const send = (cmd, value) => proxyChild.postMessage({ __wdaf: 'cmd', cmd, value }, '*');
    $('.fill').onclick = () => (proxyChild ? send('fill') : fillOnce());
    $('.auto').onclick = () => (proxyChild ? send('auto') : runAuto());
    $('.stop').onclick = () => (proxyChild ? send('stop') : stopRun());
    $('.opts').onclick = () => chrome.runtime.sendMessage({ type: 'openOptions' });
    $('.allgo').onclick = () => chrome.runtime.sendMessage({ type: 'startAllTabs' }, (r) => { void chrome.runtime.lastError; setStatus(`已让 ${(r && r.sent) || 0} 个标签页开始（不是申请页的会自己忽略）`); });
    $('.clview').onclick = () => { if (shownCL) chrome.runtime.sendMessage({ type: 'viewResume', id: shownCL }); };
    $('.wsview').onclick = () => { if (shownWS) chrome.runtime.sendMessage({ type: 'viewResume', id: shownWS }); };
    $('.view').onclick = () => {
      if (!shownPickId) return;
      chrome.runtime.sendMessage({ type: 'viewResume', id: shownPickId }, (r) => {
        const err = chrome.runtime.lastError?.message || (r && !r.ok && r.error);
        dbg('查看简历', shownPickId, err ? '失败：' + err : '已打开');
        if (err) setStatus('打不开简历：' + err);
      });
    };
    $('.rsel').onchange = (e) => (proxyChild ? send('resume', e.target.value) : setResumeOverride(e.target.value));
    $('.hd').onclick = () => {
      $('.box').classList.toggle('min');
      $('.tg').textContent = $('.box').classList.contains('min') ? '+' : '–';
    };
    document.documentElement.appendChild(host);
    return { host, root, $ };
  }

  const isGoogleForm = () => location.hostname === 'docs.google.com' && /^\/forms\//.test(location.pathname)
    && /application|intern(ship)?\b|career|\bjobs?\b|recruit|hiring|candidate/i.test(document.title + ' ' + textOf(q('[role="heading"]')));
  let appDetected = false;
  const TRACKER_HOST = IN_FRAME && /(^|\.)(recruitics\.com|doubleclick\.net|googletagmanager\.com|google-analytics\.com|facebook\.com|linkedin\.com|hotjar\.com|clarity\.ms|appcast\.io|cookielaw\.org|onetrust\.com|recaptcha\.net|hcaptcha\.com)$/i.test(location.hostname);
  const isTrackerFrame = () => TRACKER_HOST || (IN_FRAME && window.innerWidth < 320 && window.innerHeight < 160
    && qa('input:not([type="hidden"]), select, textarea').filter((e) => isVisible(e)).length < 3);
  function looksLikeApplication() {
    if (isTrackerFrame()) return false;
    if (isSR() && /\/oneclick-ui\//.test(location.pathname)) return shadowQa('input, textarea').length >= 3;
    if (/paylocity\.com$/i.test(location.hostname) && /\/recruiting\/jobs\/details\//i.test(location.pathname)) return false;
    if (isWD()) return true;
    if (/\/CandidateExperience\/.*\/(easy-)?apply(\/|$)/i.test(location.pathname)) return true;
    if (/\/CandidateExperience\//i.test(location.pathname)) return false;
    if (isGoogleForm()) return true;
    if (APPLY_URL_RE.test(location.pathname + location.search) && qa('input:not([type="hidden"]), select, textarea, [role="combobox"], [role="radio"]').some((e) => !e.closest('#wdaf-host') && isVisible(e))) return true;
    const vis = qa('input:not([type="hidden"]), select, textarea').filter((e) => !e.closest('#wdaf-host') && (isVisible(e) || e.type === 'file'));
    if (vis.length < 3) return false;
    if (ATS_HOST) return true;
    const hay = (location.href + ' ' + document.title).toLowerCase();
    const jobby = /apply|application|career|job|recruit|talent|candidate|hiring|greenhouse|lever|icims|taleo|jobvite|talemetry|smartrecruiters|ashby|workable|successfactors|oraclecloud|bamboohr|jazzhr|breezy|recruitee|teamtailor|eightfold|phenom|avature|paradox/.test(hay);
    const hasEmail = vis.some((e) => e.type === 'email' || /e-?mail/i.test([e.name, e.id, e.placeholder, e.getAttribute('autocomplete'), e.getAttribute('aria-label'), ...[...(e.labels || [])].map((l) => l.textContent)].join(' ')));
    const hasResume = vis.some((e) => e.type === 'file') && /resume|\bcv\b/i.test(textOf(document.body).slice(0, 50000));
    return (jobby && (hasEmail || hasResume)) || (hasEmail && hasResume);
  }

  function stopRun() {
    running = false;
    sessionStorage.removeItem(AUTO_KEY);
    setStatus('已停止');
  }

  function setResumeOverride(id) {
    if (id) sessionStorage.setItem(overrideKey(), id);
    else sessionStorage.removeItem(overrideKey());
    refreshPick();
  }

  function localView() {
    return {
      status: statusText, missing: missingList, running, cl: clHere, ws: wsHere, ai: aiLogPage === location.href ? aiLog.slice(-10) : [], aiNote,
      auto: isWD() ? '自动到 Review' : '自动到提交前',
      resumes: S.resumes.map((r) => ({ id: r.id, label: r.label })),
      pick: currentPick && { id: currentPick.resume.id, label: currentPick.resume.label, hits: currentPick.hits, manual: !!currentPick.manual },
    };
  }

  function showStale() {
    if (!panel || !panel.host.isConnected) return;
    const { $ } = panel;
    ['.fill', '.auto', '.stop'].forEach((c) => { $(c).disabled = true; });
    $('.st').textContent = '插件已更新，请刷新本页（⌘R）后继续。';
  }

  function renderPanel() {
    if (!alive()) { showStale(); return; }
    if (IN_FRAME && (proxied || awaitingAck)) { // 面板由外层显示，把状态传上去
      if (proxied) window.top.postMessage({ __wdaf: 'state', ...localView() }, '*');
      if (panel) panel.host.style.display = 'none';
      return;
    }
    const proxy = !!(proxyChild && childState);
    if (!S.settings.showPanel || !(proxy || appDetected || isWD())) { if (panel) panel.host.style.display = 'none'; return; }
    if (!panel) panel = buildPanel();
    else if (!panel.host.isConnected) document.documentElement.appendChild(panel.host);
    panel.host.style.display = '';
    const { $ } = panel;
    const v = proxy ? childState : localView();
    $('.fill').disabled = v.running;
    $('.auto').disabled = v.running;
    $('.auto').textContent = v.auto;
    $('.stop').disabled = !v.running;
    $('.st').textContent = v.status;
    const ul = $('.miss');
    ul.textContent = '';
    for (const m of (v.missing || []).slice(0, 12)) {
      const li = document.createElement('li');
      li.textContent = m || '（没有标题的字段）';
      ul.appendChild(li);
    }
    renderResumePicker($, v);
    shownCL = v.cl || '';
    $('.clview').style.display = shownCL ? '' : 'none';
    shownWS = v.ws || '';
    $('.wsview').style.display = shownWS ? '' : 'none';
    const al = $('.ailog');
    al.textContent = '';
    for (const line of v.ai || []) {
      const li = document.createElement('li');
      li.textContent = line;
      al.appendChild(li);
    }
    const P = S.profile;
    const warns = [];
    if (!P.firstName || !P.email) warns.push('还没填个人资料');
    if (!S.resumes.length) warns.push('还没上传简历');
    $('.warn').textContent = [warns.length ? `⚠ ${warns.join('，')}，点「设置」去填。` : '', v.aiNote ? `⚠ ${v.aiNote}` : ''].filter(Boolean).join('\n');
  }

  let shownPickId = ''; // 面板上「查看」打开的那份：本职位现在用的简历
  let shownCL = ''; // 面板上「查看这次的 cover letter」打开的那封
  let shownWS = ''; // 面板上「查看 writing sample」打开的那篇
  function renderResumePicker($, v) {
    $('.rs').style.display = v.resumes.length ? '' : 'none';
    if (!v.resumes.length) return;
    const sel = $('.rsel');
    const pick = v.pick;
    shownPickId = (pick && pick.id) || '';
    $('.view').disabled = !shownPickId;
    const manual = !!(pick && pick.manual);
    const auto = !manual && pick ? pick.label : '…';
    const opts = [['', `自动选择（${auto}）`], ...v.resumes.map((r) => [r.id, r.label])];
    sel.textContent = '';
    for (const [v, t] of opts) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = t;
      sel.appendChild(o);
    }
    sel.value = manual ? pick.id : '';
    sel.disabled = v.running;
    $('.why').textContent = !pick ? ''
      : manual ? '已手动指定（只对这个职位生效）'
      : (pick.hits || []).length ? `命中：${pick.hits.slice(0, 5).join('、')}` : '没有明显关键词，用默认简历';
  }

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === 'local' && (changes.profile || changes.settings || changes.resume || changes.resumes || changes.defaultResumeId)) {
      if (!(appDetected || isWD())) return;
      await loadState();
      await refreshPick();
    }
  });

  const ATS_HOST = (/(^|\.)(paradox\.ai|applytojob\.com|paylocity\.com)$/i.test(location.hostname) && !/\/recruiting\/jobs\/details\//i.test(location.pathname))
    || (/(^|\.)myapps\.paychex\.com$/i.test(location.hostname) && /\/appone\//i.test(location.pathname));
  const APPLY_URL_RE = /\/apply(\/|$|\?)|\/application(s)?\b|job_app|\/candidate\/|\/appone\//i;
  const maybeApplication = () => !isTrackerFrame() && (isWD() || ATS_HOST || isGoogleForm() || (isSR() && /\/oneclick-ui\//.test(location.pathname)) || APPLY_URL_RE.test(location.pathname + location.search) || /\/CandidateExperience\/.*\/(easy-)?apply(\/|$)/i.test(location.pathname) || (!!q('input[type="email"], input[type="file"], input[name*="mail" i], input[id*="mail" i], input[autocomplete="email"], input[placeholder*="mail" i]') && looksLikeApplication()));

  async function onDetected() {
    appDetected = true;
    if (IN_FRAME && !isWD()) {
      awaitingAck = true;
      for (let i = 0; i <= 6; i++) setTimeout(() => { if (!proxied) window.top.postMessage({ __wdaf: 'hello' }, '*'); }, i * 500);
      setTimeout(() => { if (!proxied) { awaitingAck = false; renderPanel(); } }, 3500);
    }
    await refreshPick();
    if (sessionStorage.getItem(AUTO_KEY) && /application (has been |was )?(submitted|received)|thank you for (applying|your application|submitting)|successfully (applied|submitted)/i.test(textOf(document.body).slice(0, 20000))) sessionStorage.removeItem(AUTO_KEY);
    if (sessionStorage.getItem(AUTO_KEY)) {
      sessionStorage.removeItem(AUTO_KEY);
      setStatus('继续自动流程…');
      await sleep(1500);
      runAuto();
    } else if (QUEUE && !running) {
      setStatus('批量队列：开始自动填写…');
      await sleep(1500);
      if (!running) runAuto();
    }
  }

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.type !== 'wdafStartAll' || IN_FRAME) return;
      const ok = alive() && !running && (proxyChild || maybeApplication());
      if (ok) { if (proxyChild) proxyChild.postMessage({ __wdaf: 'cmd', cmd: 'auto' }, '*'); else runAuto(); }
      sendResponse({ started: !!ok });
    });
  } catch (_) { /* ignore */ }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object' || !d.__wdaf || e.source === window) return;
    if (IN_FRAME && e.source === window.top && d.__wdaf === 'cmd') {
      if (d.cmd === 'ping') { if (appDetected && !isWD() && !proxied) window.top.postMessage({ __wdaf: 'hello' }, '*'); }
      else if (d.cmd === 'ack') { proxied = true; awaitingAck = false; hostJobInfo = d.job || null; refreshPick(); }
      else if (d.cmd === 'fill') fillOnce();
      else if (d.cmd === 'auto') runAuto();
      else if (d.cmd === 'stop') stopRun();
      else if (d.cmd === 'resume') setResumeOverride(d.value);
      return;
    }
    if (!IN_FRAME && (d.__wdaf === 'hello' || d.__wdaf === 'state')) {
      proxyChild = e.source;
      if (d.__wdaf === 'hello') {
        const job = { title: jobTitleFromPage(), desc: textOf(document.body).slice(0, 20000) };
        proxyChild.postMessage({ __wdaf: 'cmd', cmd: 'ack', job }, '*');
        loadState().then(renderPanel);
      } else {
        childState = d;
        renderPanel();
      }
    }
  });

  let booted = false; // 页面加载完、首次渲染过去之后才开始干活
  let lastJobKey = jobKey();
  const timer = setInterval(() => {
    if (!booted) return;
    if (!alive()) { running = false; showStale(); clearInterval(timer); return; }
    if (panel && !panel.host.isConnected && (appDetected || isWD() || childState)) renderPanel();
    if (!appDetected && !isWD()) {
      if ((document.visibilityState === 'visible' || QUEUE) && maybeApplication()) onDetected();
      return;
    }
    if (jobKey() !== lastJobKey) {
      lastJobKey = jobKey();
      refreshPick();
    } else if (currentPick && !currentPick.manual && !hostJobInfo && !jobInfoCache.has(jobKey()) && jobTitleFromPage()) {
      refreshPick(); // 标题刚加载出来
    }
  }, 1000);

  (async () => {
    if (document.readyState !== 'complete') await new Promise((r) => window.addEventListener('load', r, { once: true }));
    await sleep(1200);
    booted = true;
    if (!IN_FRAME) { try { chrome.runtime.sendMessage({ type: 'devCheck' }); } catch (_) { /* ignore */ } }
    await loadState();
    try {
      if (document.prerendering) throw new Error('prerender');
      const r = await new Promise((res) => { setTimeout(() => res(null), 2000); chrome.runtime.sendMessage({ type: 'queueHello' }, (x) => { void chrome.runtime.lastError; res(x); }); });
      if (r && r.item) { QUEUE = r.item; QUEUE_SUBMIT = !!r.autoSubmit; dbg('批量队列任务', QUEUE); }
    } catch (_) { /* 测试页 / 插件断开 */ }
    if (!IN_FRAME) for (const f of qa('iframe')) { try { f.contentWindow.postMessage({ __wdaf: 'cmd', cmd: 'ping' }, '*'); } catch (_) { /* ignore */ } }
    if (maybeApplication()) onDetected();
    else renderPanel(); // 不是申请页：什么都不做，等上面的定时检查
    if (QUEUE && !IN_FRAME) queueDrive();
  })();
})();
