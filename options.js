
const YES_NO = [['', '（不自动回答）'], ['Yes', 'Yes'], ['No', 'No']];

const SCHEMA = [
  {
    title: '基本信息', hint: 'My Information 页。电话只填号码本身（不带 +1），国家代码会按 Country 自动选。',
    fields: [
      ['firstName', '名 First Name'],
      ['middleName', '中间名 Middle Name（可空）'],
      ['lastName', '姓 Last Name'],
      ['email', '邮箱 Email'],
      ['phone', '电话 Phone Number'],
      ['phoneType', '电话类型 Phone Device Type', [['Mobile', 'Mobile'], ['Home', 'Home'], ['Work', 'Work']]],
      ['phoneOS', '手机系统（电话类型要分 iPhone / Android 时用）', [['', '（不填）'], ['iPhone', 'iPhone'], ['Android', 'Android']]],
      ['country', '国家 Country'],
      ['address1', '地址 Address Line 1'],
      ['address2', '地址第二行 Address Line 2（可空）'],
      ['city', '城市 City'],
      ['state', '州 State（如 New York）'],
      ['postalCode', '邮编 Postal Code'],
      ['source', '从哪得知职位 How Did You Hear About Us'],
    ],
  },
  {
    title: '教育与技能', hint: 'My Experience 页。工作经历交给 Workday 解析简历；这里补教育、技能和链接。',
    fields: [
      ['school', '学校 School（用英文全称）'],
      ['schoolLocation', '学校所在地（如 New York, NY, USA）'],
      ['degree', '学位 Degree（如 Bachelor / Master）'],
      ['degreeFull', '学位全称（文本框用，如 M.S. in Project Management）'],
      ['highestCompleted', '已完成的最高学历（在读的不算，如 Bachelor）'],
      ['fieldOfStudy', '专业 Field of Study'],
      ['fieldOfStudyAlt', '专业列表里没有时选（如 Business Administration）'],
      ['gpa', 'GPA'],
      ['undergradGpa', '本科 GPA（4.0 制，问 undergraduate GPA 时用）'],
      ['stdTest', '考过的标化考试（SAT / ACT / GMAT / GRE；没考过写 None）'],
      ['eduStartMonth', '入学月份（1-12）'],
      ['eduStartYear', '入学年份'],
      ['eduEndMonth', '毕业月份（1-12）'],
      ['eduEndYear', '毕业年份（含预计）'],
      ['skills', '技能 Skills（逗号分隔）'],
      ['languages', '语言熟练度（如 Mandarin: Native; English: Fluent，可选 native / fluent / advanced / intermediate / basic）'],
      ['linkedin', 'LinkedIn 链接'],
      ['github', 'GitHub 链接'],
      ['website', '个人网站 / 作品集'],
    ],
  },
  {
    title: '常见申请问题', hint: 'Application Questions 页。问「不需要担保就能工作吗（without sponsorship）」这类题时，会根据「是否需要签证担保」自动反过来答。毕业时间、在读学位按上面「教育」里的毕业月份/年份和学位来答。',
    fields: [
      ['workAuthorized', '是否有在美国合法工作的身份（authorized to work）', [['Yes', 'Yes'], ['No', 'No']], 'warn'],
      ['needSponsorship', '现在或将来是否需要签证担保（sponsorship）', [['Yes', 'Yes'], ['No', 'No']], 'warn'],
      ['hasOPT', '现在是否持有 OPT', YES_NO],
      ['stemOpt', '是否符合 STEM OPT（24 个月延期）', YES_NO],
      ['f1Status', '是否 F-1 学生身份', YES_NO],
      ['stemMajor', '专业是否属于 STEM', YES_NO],
      ['treatyVisa', '能否办两国协定签证（E-3 / TN / H-1B1）', YES_NO],
      ['homeResidency', '是否有离境 / 回国居住要求（如 J 签证 212(e)）', YES_NO],
      ['conflictOfInterest', '是否有利益冲突（conflict of interest）', YES_NO],
      ['otherOffers', '是否正在面试别家实习 / 手上有别的 offer', YES_NO],
      ['inOffice', '能否每周到办公室 3-4 天', YES_NO],
      ['availableStart', '最早开始日期（文本题，如 June 1, 2027）'],
      ['govOfficial', '本人或亲属是否政府官员 / 公务员', YES_NO],
      ['referredBy', '是否被客户或合作方的高管推荐来的', YES_NO],
      ['aiUsage', 'AI 工具用到什么程度（选项开头的英文，如 I design or automate workflows with AI tools）'],
      ['over18', '是否年满 18 岁', YES_NO],
      ['previousWorker', '是否曾在该公司工作过', YES_NO],
      ['relatives', '是否有亲属在该公司工作', YES_NO],
      ['enrolled', '目前是否在读 / 实习后是否回学校继续读书', YES_NO],
      ['relocate', '是否愿意搬到工作地点（willing to relocate）', YES_NO],
      ['nonCompete', '是否受竞业 / 禁止招揽协议约束（non-compete）', YES_NO],
      ['pastParticipation', '是否某学生组织会员 / 做过公司的模拟项目、参加过活动（如 Forage）', YES_NO],
      ['previouslyApplied', '以前是否申请过该公司', YES_NO],
      ['essentialFunctions', '能否胜任岗位基本职能（essential functions）', YES_NO],
      ['driversLicense', '是否有有效驾照', YES_NO],
      ['toolsCoursework', '课堂作业里用过的编程 / 分析工具（逗号分隔，如 Python, SQL；没有写 None）'],
      ['toolsWork', '课堂以外（实习 / 研究 / 项目）用过的编程工具（逗号分隔）'],
      ['criminalRecord', '是否有犯罪记录（被定罪 / 认罪 / no contest）', YES_NO],
      ['securitiesLicense', '是否持有或曾持有证券 / 保险执照', YES_NO],
      ['bondDenied', '是否被担保公司拒保、赔付或撤销担保', YES_NO],
      ['judgments', '是否有未清偿的判决或留置权（欠款）', YES_NO],
      ['salary', '期望薪资（文本题，可空，如 100000）'],
      ['hourlyRate', '期望时薪（只问时薪时用，如 30）'],
      ['citizenship', '国籍（如 China）'],
      ['currentlySponsored', '现在是否正由某家公司担保签证（F-1 学生一般是 No）', YES_NO],
      ['smsConsent', '是否同意通过短信 / WhatsApp 接收申请相关通知', YES_NO],
      ['interviewTravelAssist', '去外地面试是否需要公司提供差旅协助', YES_NO],
      ['everTerminated', '是否曾被解雇 / 停职 / 劝退', YES_NO],
      ['plannedTimeOff', '实习期间是否计划休假', YES_NO],
      ['acceptPostedPay', '职位标明的薪资（如 $18/小时）能否接受', YES_NO],
      ['politicalDonations', '近几年是否给政治候选人 / 竞选捐款或做志愿者', YES_NO],
      ['needAccommodation', '是否需要合理便利（reasonable accommodation）', YES_NO],
      ['hasSpouse', '是否有配偶（只问配偶的题没有配偶时答 Not Applicable）', YES_NO],
      ['householdBoard', '同住的家人是否在外部公司 / 组织当董事、受托人或高管', YES_NO],
      ['confidentialInfo', '是否持有前雇主的机密信息 / 商业秘密（可能和新职位有关）', YES_NO],
      ['undergradSchool', '本科学校（英文全称，问本科学校时用）'],
      ['undergradSchoolAlt', '本科学校的另一种写法（列表里找不到全称时用）'],
      ['hometown', '家乡（如 Shanghai, China）'],
      ['hsGradYear', '高中毕业年份'],
      ['cpaPathway', 'CPA 资格路径（如 The traditional 150-credit hour pathway）'],
    ],
  },
  {
    title: '背景和经历（给 AI 看）', hint: '上传简历后点上面「用简历自动填写资料」可以自动生成。工作经历、项目是 JSON：每段写 company、title、location、start（MM/YYYY）、end（MM/YYYY，在职留空）、current、summary（一行一条要点）、reason（离职原因）。',
    fields: [
      ['background', '背景补充（自由填写：签证身份、住在哪、偏好、哪些题怎么答、不想写的事…Codex 答题和写 cover letter 时会参考）', 'textarea'],
      ['workHistory', '工作经历（JSON，最近的在前）', 'json'],
      ['projects', '项目 / 自己做的事（JSON，格式同上）', 'json'],
    ],
  },
  {
    title: '自愿披露（Voluntary Disclosures / Self Identify）', hint: '这些是自愿填写的平等就业信息，不影响录取。不想透露的项选「不愿透露」。',
    fields: [
      ['gender', '性别 Gender', [['DECLINE', '不愿透露'], ['Male', 'Male'], ['Female', 'Female']]],
      ['hispanic', '是否西语裔 Hispanic or Latino', [['DECLINE', '不愿透露'], ['No', 'No'], ['Yes', 'Yes']]],
      ['ethnicity', '种族 Race / Ethnicity', [['DECLINE', '不愿透露'], ['Asian', 'Asian'], ['White', 'White'],
        ['Black or African American', 'Black or African American'], ['Hispanic or Latino', 'Hispanic or Latino'],
        ['Native Hawaiian', 'Native Hawaiian or Other Pacific Islander'], ['American Indian', 'American Indian or Alaska Native'],
        ['Two or More', 'Two or More Races']]],
      ['sexualOrientation', '性取向 Sexual Orientation', [['DECLINE', '不愿透露'], ['Heterosexual', 'Heterosexual / Straight'],
        ['Gay', 'Gay'], ['Lesbian', 'Lesbian'], ['Bisexual', 'Bisexual']]],
      ['veteran', '退伍军人身份 Veteran Status', [['DECLINE', '不愿透露'], ['not a protected veteran', 'I am not a protected veteran'],
        ['identify as one or more', 'I identify as a protected veteran']]],
      ['disability', '残障情况 Disability', [['DECLINE', '不愿透露'], ['No, I do not', 'No, I do not have a disability'],
        ['Yes, I have', 'Yes, I have a disability']]],
    ],
  },
];

const SETTINGS_SCHEMA = [
  ['startMode', '点 Apply 后的方式', [['autofillWithResume', 'Autofill with Resume（上传简历自动解析，推荐）'],
    ['useMyLastApplication', 'Use My Last Application（用上次在该公司的申请）'], ['applyManually', 'Apply Manually（手动填写）']]],
  ['stepDelay', '每页填完后等待（毫秒）', 'number'],
  ['aiReview', '每页填完让 Codex 复核整页（挑出填错的、补上漏掉的）', 'check'],
  ['acceptTerms', '自动勾选「我已阅读并同意条款 / consent」类复选框', 'check'],
  ['overwrite', '覆盖网页上已有的内容（Workday 解析简历填错时可打开）', 'check'],
  ['onlyMySchool', '只保留资料里的学校（自动删掉简历解析出的其他学历，比如本科、证书课程）', 'check'],
  ['autoSubmit', '到 Review 页后自动点 Submit（不推荐：建议自己检查一遍再提交）', 'check', 'warn'],
  ['showPanel', '在 Workday 页面右下角显示操作面板', 'check'],
  ['useAI', '插件答不了的题交给本机 Codex，按你的资料和简历作答（答过的会记住；资料里没有的事实它会留空）', 'check'],
  ['aiOperator', 'AI 操作员：插件填不上的控件（不认识的下拉、按钮），让 Codex 看着这道题一步步点选；做成功的步骤按网站记住，下次直接照做', 'check'],
  ['trustedInput', '真实键鼠兜底：插件模拟的点击 / 打字不管用时（Paylocity 这类下拉），用 Chrome 调试接口发真实键鼠（用的那一下 Chrome 顶上会闪一下「正在调试」的提示条）', 'check'],
  ['aiScreenshot', 'AI 操作员带截图：第一步或上一步没反应时，把这道题截图（控件框上编号）一起交给 Codex', 'check'],
  ['aiCoverLetter', 'Cover letter', [['always', '有 cover letter 上传栏就让 Codex 写一封并上传'], ['required', '只在必填时写'], ['off', '不写']]],
  ['aiWritingSample', 'Writing sample', [['always', '有 writing sample 上传栏就让 Codex 写一篇并上传（写一次，之后的申请共用）'], ['required', '只在必填时传'], ['off', '不传']]],
];

const $ = (s) => document.querySelector(s);
const state = { profile: {}, settings: {}, resumes: [], defaultResumeId: '', log: [] };

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') e.textContent = v;
    else if (k === 'className') e.className = v;
    else e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) e.append(c);
  return e;
}

function renderField(group, key, label, type, flag) {
  const id = `${group}-${key}`;
  let input;
  if (type === 'check') {
    input = el('input', { type: 'checkbox', id });
    return el('label', { className: `field check ${flag || ''}` }, [input, el('span', { text: label })]);
  }
  if (type === 'textarea' || type === 'json') {
    input = el('textarea', { id, rows: type === 'json' ? '10' : '5', spellcheck: 'false', ...(type === 'json' ? { 'data-json': '1' } : {}) });
    return el('label', { className: `field wide ${flag || ''}` }, [el('span', { text: label }), input]);
  }
  if (Array.isArray(type)) {
    input = el('select', { id }, type.map(([v, t]) => el('option', { value: v, text: t })));
  } else {
    input = el('input', { type: type === 'number' ? 'number' : 'text', id });
  }
  return el('label', { className: `field ${flag || ''}` }, [el('span', { text: label }), input]);
}

function renderForm() {
  const root = $('#form');
  for (const sec of SCHEMA) {
    root.append(el('section', { className: 'card' }, [
      el('h2', { text: sec.title }),
      el('p', { className: 'hint', text: sec.hint }),
      el('div', { className: 'grid' }, sec.fields.map(([k, l, t, f]) => renderField('profile', k, l, t, f))),
    ]));
  }
  root.append(el('section', { className: 'card' }, [
    el('h2', { text: '行为设置' }),
    el('div', { className: 'grid' }, SETTINGS_SCHEMA.map(([k, l, t, f]) => renderField('settings', k, l, t, f))),
  ]));
}

function fillForm() {
  for (const [group, obj] of [['profile', state.profile], ['settings', state.settings]]) {
    for (const [k, v] of Object.entries(obj)) {
      const input = document.getElementById(`${group}-${k}`);
      if (!input) continue;
      if (input.type === 'checkbox') input.checked = !!v;
      else if (input.dataset.json) input.value = JSON.stringify(v || [], null, 2);
      else input.value = v ?? '';
    }
  }
  renderResumes();
  renderTranscript();
  renderCoverLetters();
}


function renderGuesses() {
  const box = $('#guessList');
  if (!box) return;
  box.textContent = '';
  const lines = $('#customRules').value.split('\n');
  const rows = lines.map((line, i) => ({ line, i, m: line.match(/^(.*?=>.*?)\s*⟨([^⟩]*)⟩\s*$/) })).filter((x) => x.m && !x.line.trim().startsWith('#'));
  if (!rows.length) { box.append(el('p', { className: 'hint', text: '没有待确认的。' })); return; }
  for (const r of rows) {
    const ok = el('button', { type: 'button', className: 'ghost', text: '确认' });
    const del = el('button', { type: 'button', className: 'ghost danger', text: '删掉' });
    const apply = async (replacement) => {
      const cur = $('#customRules').value.split('\n');
      const at = cur.indexOf(r.line);
      if (at < 0) return renderGuesses();
      if (replacement == null) cur.splice(at, 1); else cur[at] = replacement;
      $('#customRules').value = rulesShown = cur.join('\n');
      await chrome.storage.local.set({ customRules: rulesShown });
      renderGuesses();
      toast('已更新 ✓');
    };
    ok.addEventListener('click', () => apply(r.m[1].trim()));
    del.addEventListener('click', () => apply(null));
    box.append(el('div', { className: 'resume' }, [
      el('div', { className: 'top' }, [el('span', { text: r.m[1].trim() }), el('span', { className: 'row' }, [ok, del])]),
      el('span', { className: 'hint', text: r.m[2] }),
    ]));
  }
}

async function renderSnapshots() {
  const box = $('#snapList');
  if (!box) return;
  box.textContent = '';
  const all = (await chrome.storage.local.get('appSnapshots')).appSnapshots || {};
  const items = Object.values(all).sort((a, b) => (b.time || 0) - (a.time || 0));
  if (!items.length) { box.append(el('p', { className: 'hint', text: '还没有。插件自动推进申请时会记下来。' })); return; }
  for (const rec of items) {
    const det = el('details', { className: 'resume' });
    const n = rec.pages.reduce((k, x) => k + x.answers.length, 0);
    det.append(el('summary', { text: `${rec.company || ''} · ${rec.title || ''}（${rec.pages.length} 页，${n} 题，${new Date(rec.time).toLocaleString()}）` }));
    if (rec.url) det.append(el('a', { href: rec.url, target: '_blank', rel: 'noopener', text: '申请页' }));
    for (const pg of rec.pages) {
      det.append(el('h4', { text: pg.step }));
      const ul = el('ul');
      for (const x of pg.answers) ul.append(el('li', { text: `${x.q}${x.req ? ' *' : ''} → ${x.a || '（空）'}` }));
      det.append(ul);
    }
    box.append(det);
  }
}

function renderCoverLetters() {
  const box = $('#clList');
  box.textContent = '';
  const items = Object.entries(state.coverLetters || {}).filter(([, c]) => c && c.data).sort(([, a], [, b]) => (b.time || 0) - (a.time || 0));
  if (!items.length) { box.append(el('p', { className: 'hint', text: '还没有。遇到有 cover letter 上传栏的申请，Codex 写完会出现在这里。' })); return; }
  for (const [key, c] of items) {
    const view = el('button', { type: 'button', className: 'ghost', text: '查看' });
    view.addEventListener('click', () => window.open('view.html?id=' + encodeURIComponent(key)));
    const meta = [c.kind === 'writingSample' ? 'Writing sample（各申请共用）' : '', c.company, c.title].filter(Boolean).join(' · ');
    const when = c.time ? new Date(c.time).toLocaleString() : '';
    const link = c.url ? el('a', { href: c.url, target: '_blank', text: '职位页' }) : null;
    box.append(el('div', { className: 'resume' }, [
      el('div', { className: 'top' }, [el('b', { text: c.name || key }), view]),
      el('span', { className: 'hint', text: [meta, when].filter(Boolean).join('，') }),
      link,
    ]));
  }
}

function readForm() {
  for (const [group, obj] of [['profile', state.profile], ['settings', state.settings]]) {
    for (const k of Object.keys(obj)) {
      const input = document.getElementById(`${group}-${k}`);
      if (!input) continue;
      if (input.type === 'checkbox') obj[k] = input.checked;
      else if (input.type === 'number') obj[k] = Number(input.value) || 0;
      else if (input.dataset.json) {
        try { const v = JSON.parse(input.value.trim() || '[]'); if (!Array.isArray(v)) throw new Error('要是 [ … ] 列表'); obj[k] = v; }
        catch (e) { toast(`「${k}」不是有效的 JSON，没保存这一项：${e.message}`); }
      } else obj[k] = input.value.trim();
    }
  }
}

function renderLog() {
  const tbody = $('#logTable tbody');
  tbody.textContent = '';
  const rows = [...state.log].reverse();
  for (const r of rows) {
    const link = el('a', { href: r.url, target: '_blank', rel: 'noopener', text: r.title || r.url });
    tbody.append(el('tr', {}, [
      el('td', { text: new Date(r.time).toLocaleString() }),
      el('td', { text: r.company || '' }),
      el('td', {}, link),
      el('td', { text: r.resume || '' }),
      el('td', { text: r.status || '' }),
    ]));
  }
  $('#logCount').textContent = `共 ${state.log.length} 条`;
}

function toast(msg) {
  $('#toast').textContent = msg;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => ($('#toast').textContent = ''), 2500);
}

async function load() {
  const d = await chrome.storage.local.get(['profile', 'settings', 'resume', 'resumes', 'defaultResumeId', 'customRules', 'log', 'transcript', 'coverLetters']);
  state.transcript = d.transcript || null;
  state.coverLetters = d.coverLetters || {};
  state.profile = wdafMergeProfile(d.profile);
  state.settings = { ...WDAF_DEFAULT_SETTINGS, ...(d.settings || {}) };
  state.resumes = wdafResumeList(d);
  state.defaultResumeId = d.defaultResumeId || (state.resumes[0] && state.resumes[0].id) || '';
  state.log = d.log || [];
  $('#customRules').value = rulesShown = d.customRules ?? WDAF_DEFAULT_RULES;
  fillForm();
  renderLog();
  renderGuesses();
  renderSnapshots();
}

let rulesShown = '';
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.coverLetters) { state.coverLetters = changes.coverLetters.newValue || {}; renderCoverLetters(); }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.customRules) return;
  const box = $('#customRules');
  if (box.value === rulesShown) box.value = rulesShown = changes.customRules.newValue ?? WDAF_DEFAULT_RULES;
  renderGuesses();
});
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.appSnapshots) renderSnapshots(); });

async function save() {
  readForm();
  rulesShown = $('#customRules').value;
  await chrome.storage.local.set({
    profile: state.profile,
    settings: state.settings,
    customRules: rulesShown,
  });
  toast('已保存 ✓');
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function download(name, text, type) {
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}


const UPDATE_URL = 'https://raw.githubusercontent.com/MuellerYu/job-apply-helper/main/version.json';
async function checkUpdate() {
  const box = $('#updateNote');
  if (!UPDATE_URL || !box) return;
  try {
    const [mine, latest] = await Promise.all([
      fetch(chrome.runtime.getURL('version.json'), { cache: 'no-store' }).then((r) => r.json()),
      fetch(UPDATE_URL + '?t=' + Date.now(), { cache: 'no-store' }).then((r) => r.json()),
    ]);
    if (latest.seq && mine.seq && latest.seq > mine.seq) {
      box.textContent = `有新版本（${latest.build}，你现在是 ${mine.build}）：双击插件文件夹里的「更新.command」（或在终端运行 bash 更新.command），然后刷新任意网页。${latest.notes ? '更新内容：' + latest.notes : ''}`;
      box.hidden = false;
    }
  } catch (_) { /* 没网或没有 version.json：不提示 */ }
}

renderForm();
load();
checkUpdate();

$('#save').addEventListener('click', save);
$('#customRules').addEventListener('input', () => renderGuesses());
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); }
});


async function saveResumes() {
  await chrome.storage.local.set({ resumes: state.resumes, defaultResumeId: state.defaultResumeId });
  await chrome.storage.local.remove('resume');
  toast('简历已保存 ✓');
  runTester();
}

function renderResumes() {
  const list = $('#resumeList');
  list.textContent = '';
  if (!state.resumes.length) list.append(el('p', { className: 'hint', text: '还没有简历，点下面「添加一份简历」。' }));
  state.resumes.forEach((r, i) => {
    const label = el('input', { type: 'text', value: r.label || '', placeholder: '名称，比如 Finance' });
    const def = el('input', { type: 'radio', name: 'defaultResume' });
    def.checked = r.id === state.defaultResumeId;
    const file = el('input', { type: 'file', accept: '.pdf,.doc,.docx', hidden: '' });
    const fileBtn = el('label', { className: 'ghost file-btn' }, ['换文件', file]);
    const view = el('button', { type: 'button', className: 'ghost', text: '查看' });
    view.disabled = !r.data;
    const del = el('button', { type: 'button', className: 'ghost danger', text: '删除' });
    const kw = el('textarea', { rows: '2', placeholder: '关键词，逗号分隔，比如 audit, internal control, sox' });
    kw.value = r.keywords || '';
    const info = r.data ? `上传时文件名：${r.name}（${Math.round(r.size / 1024)} KB）` : '还没选文件';
    list.append(el('div', { className: 'resume' }, [
      el('div', { className: 'top' }, [label, el('label', { className: 'def' }, [def, '默认']), view, fileBtn, del]),
      el('span', { className: 'hint', text: info }),
      kw,
    ]));
    view.addEventListener('click', () => window.open('view.html?id=' + encodeURIComponent(r.id)));
    label.addEventListener('change', () => { r.label = label.value.trim(); saveResumes(); });
    kw.addEventListener('change', () => { r.keywords = kw.value; saveResumes(); });
    def.addEventListener('change', () => { state.defaultResumeId = r.id; saveResumes(); });
    del.addEventListener('click', () => {
      if (!confirm(`删除「${r.label || '这份简历'}」？`)) return;
      state.resumes.splice(i, 1);
      if (state.defaultResumeId === r.id) state.defaultResumeId = state.resumes[0] ? state.resumes[0].id : '';
      renderResumes();
      saveResumes();
    });
    file.addEventListener('change', async () => {
      const f = file.files[0];
      if (!f) return;
      if (f.size > 5 * 1024 * 1024) { toast('文件超过 5MB，Workday 不接受'); return; }
      Object.assign(r, { name: f.name, type: f.type || 'application/pdf', size: f.size, data: await fileToBase64(f) });
      if (!r.label) r.label = f.name.replace(/\.\w+$/, '');
      renderResumes();
      saveResumes();
    });
  });
}

function renderTranscript() {
  const box = $('#transcriptRow');
  box.textContent = '';
  const T = state.transcript;
  if (!T || !T.data) { box.append(el('span', { className: 'hint', text: '成绩单：还没有（在插件文件夹的 config.json 里设置 transcript）' })); return; }
  const view = el('button', { type: 'button', className: 'ghost', text: '查看' });
  view.addEventListener('click', () => window.open('view.html?id=transcript'));
  box.append(el('div', { className: 'top' }, [el('b', { text: '成绩单' }), el('span', { className: 'hint', text: `上传时文件名：${T.name}（${Math.round(T.size / 1024)} KB）` }), view]));
}


const NATIVE_HOST = 'com.jobhelper.codex';
function parseResume() {
  const out = $('#parseStatus');
  const r = state.resumes.find((x) => x.id === state.defaultResumeId) || state.resumes[0];
  if (!r || !r.data) { out.textContent = '先在上面添加一份简历（PDF）。'; return; }
  out.textContent = '正在让 Codex 读简历（半分钟到一分钟）…';
  try {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, { action: 'parseResume', resumePdf: r.data }, (res) => {
      const err = chrome.runtime.lastError?.message;
      if (err || !res || !res.ok) { out.textContent = '没读成：' + (err || (res && res.error) || '没有回应') + '（先运行 native-host/install.sh 安装本地连接）'; return; }
      readForm();
      let n = 0;
      for (const [k, v] of Object.entries(res.profile || {})) {
        if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
        const cur = state.profile[k];
        if (cur == null || cur === '' || (Array.isArray(cur) && !cur.length)) { state.profile[k] = v; n++; }
      }
      fillForm();
      out.textContent = `已按简历填好 ${n} 项（已有的没动）。请从上往下检查一遍，补上简历里没有的（签证、常见问题、自愿披露），再点最下面「保存」。`;
    });
  } catch (e) {
    out.textContent = '没读成：' + e;
  }
}

function testCodex() {
  const out = $('#codexStatus');
  out.textContent = '正在连接…';
  try {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, { action: 'ping' }, (r) => {
      const err = chrome.runtime.lastError?.message;
      out.textContent = err ? `连不上：${err}（运行插件文件夹里的 native-host/install.sh 安装）`
        : r && r.ok ? `已连上 ${r.codex}，下一封 cover letter 是第 ${r.next} 封，存在 ${r.coverLetters}` : `连不上：${r && r.error}`;
    });
  } catch (e) {
    out.textContent = '连不上：' + e;
  }
}

function runTester() {
  const title = $('#testTitle').value.trim();
  if (!title) { $('#testResult').textContent = ''; return; }
  const pick = wdafPickResume(state.resumes, state.defaultResumeId, title, '');
  $('#testResult').textContent = !pick ? '还没有简历'
    : pick.hits.length ? `会用「${pick.resume.label}」——命中：${pick.hits.join('、')}`
    : `会用默认的「${pick.resume.label}」（标题里没有关键词；实际投递时还会参考职位描述）`;
}

$('#resumeAdd').addEventListener('click', () => {
  const r = { id: 'r' + Date.now().toString(36), label: '', keywords: '', name: '', size: 0, data: '' };
  state.resumes.push(r);
  if (!state.defaultResumeId) state.defaultResumeId = r.id;
  renderResumes();
});
$('#testTitle').addEventListener('input', runTester);
$('#codexTest').addEventListener('click', testCodex);
$('#parseResume').addEventListener('click', parseResume);

$('#exportCsv').addEventListener('click', () => {
  const lines = [['时间', '公司', '职位', '简历', '状态', '链接']];
  for (const r of state.log) lines.push([new Date(r.time).toLocaleString(), r.company, r.title, r.resume, r.status, r.url]);
  download('workday-applications.csv', '﻿' + lines.map((l) => l.map(csvCell).join(',')).join('\n'), 'text/csv');
});

$('#clearLog').addEventListener('click', async () => {
  if (!confirm('确定清空全部投递记录？')) return;
  state.log = [];
  await chrome.storage.local.set({ log: [] });
  renderLog();
});

$('#exportJson').addEventListener('click', () => {
  readForm();
  const data = { profile: state.profile, settings: state.settings, customRules: $('#customRules').value };
  download('workday-autofill-settings.json', JSON.stringify(data, null, 2), 'application/json');
});

$('#importJson').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    await chrome.storage.local.set({
      profile: wdafMergeProfile(data.profile),
      settings: { ...WDAF_DEFAULT_SETTINGS, ...(data.settings || {}) },
      customRules: data.customRules ?? WDAF_DEFAULT_RULES,
    });
    await load();
    toast('已导入 ✓');
  } catch (err) {
    toast('导入失败：' + err.message);
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.log) { state.log = changes.log.newValue || []; renderLog(); }
  if (changes.configVersion) load(); // 刚从 config.json 导入了资料
});
