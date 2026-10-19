// 内容脚本和设置页共用的默认值。
// 下拉/单选类答案会拿去和网页上的选项文字做匹配；"DECLINE" 表示选「不愿透露」类选项。

const WDAF_DEFAULT_PROFILE = {
  // 基本信息
  firstName: '', middleName: '', lastName: '',
  preferredName: '', preferredOnlyIfRequired: '', nativeName: '',
  interviewAvailability: '', // 面试时间（问「哪些时段能面试」时填的一句话） // nativeName：母语写的全名（如中文汉字），问 Name in Native Language 时用 // 常用名（英文名等）：填了就用在 Preferred / Nickname 题上，空着就不填
  email: '', phone: '', phoneType: 'Mobile', phoneOS: '', // 手机系统（iPhone / Android），电话类型题要分系统时用
  country: 'United States of America',
  address1: '', address2: '', city: '', state: '', postalCode: '',
  source: 'Indeed',
  // 教育
  school: '', schoolLocation: '', degree: '', degreeFull: '', fieldOfStudy: '', fieldOfStudyAlt: '', gpa: '',
  eduStartMonth: '', eduStartYear: '', eduEndMonth: '', eduEndYear: '',
  skills: '',
  // 工作经历（最近的在前）：表单要一段段填雇主、职位、起止年月、工作内容、离职原因时用
  workHistory: [],
  languages: '', // 语言熟练度：native / fluent / advanced / intermediate / basic
  // 链接
  linkedin: '', github: '', website: '',
  // 常见问题（留空 = 不自动回答）
  workAuthorized: 'Yes', needSponsorship: 'Yes',
  hasOPT: '', stemOpt: '', // 现在是否持有 OPT；是否符合 STEM OPT 延期
  f1Status: '', stemMajor: '', // 是否 F-1 身份；专业是否 STEM
  treatyVisa: '', homeResidency: '', // 能否办两国协定签证（E-3/TN/H-1B1）；是否有回国居住要求（J 签证 212(e)）
  conflictOfInterest: '', otherOffers: '', // 是否有利益冲突；是否正在面试别家 / 有别的 offer
  inOffice: '', availableStart: '', // 能否每周到办公室 3-4 天；最早开始日期（文本题，如 June 1, 2027）
  govOfficial: '', referredBy: '', // 本人 / 亲属是否政府官员；是否被客户或合作方的高管推荐来的
  aiUsage: '', // AI 工具用到什么程度（选项开头的写法，如 I design or automate workflows with AI tools）
  over18: 'Yes', previousWorker: 'No', relatives: 'No', salary: '',
  // 以下留空 = 遇到这类题不自动答（标红留给你，或交给 Codex）
  smsConsent: '', currentlySponsored: '', interviewTravelAssist: '', everTerminated: '', plannedTimeOff: '',
  acceptPostedPay: '', politicalDonations: '', needAccommodation: '', hasSpouse: '', householdBoard: '', confidentialInfo: '', hourlyRate: '',
  undergradSchool: '', undergradSchoolAlt: '', undergradMajor: '', undergradMajorAlt: '', hometown: '', hsGradYear: '', cpaPathway: '', citizenship: '',
  background: '', // 给 AI 看的背景补充（自由填写：身份、偏好、经历细节、不想答的事…），Codex 答题、写 cover letter 时会参考
  projects: [], // 项目 / 自己做的事（JSON，同 workHistory 的格式）
  enrolled: 'Yes', relocate: 'Yes', nonCompete: 'No', pastParticipation: 'No',
  previouslyApplied: 'No', essentialFunctions: 'Yes', driversLicense: '',
  toolsCoursework: '', toolsWork: '', // 课堂作业 / 课堂以外用过的编程、分析工具（逗号分隔，如 Python, SQL；没有写 None）
  // 背景调查（留空 = 不自动答，遇到会标红让你自己答）
  criminalRecord: '', securitiesLicense: '', bondDenied: '', judgments: '',
  highestCompleted: '', // 已完成的最高学历（在读的不算），如 Bachelor
  undergradGpa: '', // 本科 GPA（4.0 制），问 undergraduate GPA 时用
  stdTest: '', // 考过的标化考试（SAT / ACT / GMAT / GRE），没考过写 None
  // 自愿披露（EEO）
  gender: 'DECLINE', hispanic: 'DECLINE', ethnicity: 'DECLINE', sexualOrientation: 'DECLINE', transgender: '',
  veteran: 'DECLINE', disability: 'DECLINE',
};

const WDAF_DEFAULT_SETTINGS = {
  startMode: 'autofillWithResume', // 点 Apply 后选哪种方式
  aiReview: true,                  // 每页填完让 Codex 复核整页（挑错、补漏）
  acceptTerms: true,               // 自动勾选「我已阅读并同意条款」
  overwrite: false,                // 覆盖网页上已有的内容（比如 Workday 解析简历填错的）
  onlyMySchool: true,              // 只保留资料里的学校，删掉简历解析出的其他学历
  autoSubmit: false,               // 到 Review 页后自动点 Submit
  useAI: true,                     // 插件答不了的题交给本机 Codex（需要装本地连接）
  aiOperator: true,                // 插件填不上的控件（不认识的下拉 / 按钮）让 Codex 一步步操作，做成功的按网站记住
  trustedInput: true,              // 合成事件不管用时（Paylocity 这类只认真实键盘的下拉）用 Chrome 调试接口发真实键鼠，用完马上断开
  aiScreenshot: true,              // AI 操作员第一步（或上一步没反应时）带上这道题的截图（框上编号）
  aiCoverLetter: 'always',         // cover letter：always 有上传栏就写 / required 只在必填时写 / off 不写
  aiWritingSample: 'off',       // writing sample：always 有上传栏就让 Codex 写一篇（写一次，之后共用）/ required 只在必填时 / off 不传
  showPanel: true,
  stepDelay: 800,                  // 每页填完后等待多少毫秒再点下一步
};

const WDAF_DEFAULT_RULES = `# 每行一条：问题关键词 => 答案
# 关键词不区分大小写，可以用 | 分隔多个；只要问题里包含任意一个关键词就会命中。
# 自定义规则优先于内置规则；多条都命中时，关键词最长（最具体）的那条生效。
# 答案会去匹配下拉框/单选项的文字，或直接填进文本框。
# 插件答不了、你手动答了的题，会自动记在最下面，下次遇到同样的题就自动答。
# 去掉行首的 # 即可启用，例如：
# non-compete|non-solicitation => No
# willing to relocate => Yes
# start date|available to start => May 2027
`;

// 合并已保存的资料和默认值；这几项必须有答案，旧版本存下的空值也用默认值补上
function wdafMergeProfile(saved) {
  const p = { ...WDAF_DEFAULT_PROFILE, ...(saved || {}) };
  for (const k of ['workAuthorized', 'needSponsorship', 'source']) if (!p[k]) p[k] = WDAF_DEFAULT_PROFILE[k];
  // 旧版本默认存的是 LinkedIn，统一改成 Indeed
  if (p.source === 'LinkedIn' && !(saved && saved.sourceV2)) p.source = WDAF_DEFAULT_PROFILE.source;
  p.sourceV2 = true;
  return p;
}

// ---------------------------------------------------------------- 多份简历：按职位自动选

function wdafKeywordList(s) {
  return String(s || '').split(/[,，;\n]/).map((k) => k.trim().toLowerCase()).filter(Boolean);
}

// 职位标题命中关键词 +5 分，职位描述命中 +1 分。
// 别的简历要比默认简历至少高 2 分才换（描述里零星提到一两个词不算数），否则用默认简历。
function wdafPickResume(resumes, defaultId, title, desc) {
  if (!resumes || !resumes.length) return null;
  const t = ' ' + String(title || '').toLowerCase() + ' ';
  const d = ' ' + String(desc || '').toLowerCase() + ' ';
  const has = (text, k) => new RegExp('(^|[^a-z0-9])' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)').test(text);
  const def = resumes.find((r) => r.id === defaultId) || resumes[0];
  const scored = resumes.map((r) => {
    let score = 0;
    const hits = [];
    for (const k of wdafKeywordList(r.keywords)) {
      if (has(t, k)) { score += 5; hits.push(k); } else if (has(d, k)) { score += 1; hits.push(k); }
    }
    return { resume: r, score, hits };
  });
  const defScored = scored.find((s) => s.resume === def);
  const best = scored.reduce((a, b) => (b.score > a.score ? b : a), defScored);
  return best.score - defScored.score >= 2 ? best : defScored;
}

// 兼容只有一份简历的旧版本存储
function wdafResumeList(d) {
  if (d.resumes && d.resumes.length) return d.resumes;
  if (d.resume) return [{ ...d.resume, id: 'main', label: '简历', keywords: '' }];
  return [];
}

// 解析自定义规则文本 -> [{ keys: ['a', 'b'], answer: 'Yes' }]
function wdafParseRules(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('=>'))
    .map((line) => {
      const i = line.indexOf('=>');
      const keys = line.slice(0, i).split('|').map((k) => k.trim().toLowerCase()).filter(Boolean);
      let answer = line.slice(i + 2).trim();
      // 行尾「⟨codex 2026-10-19 paylocity.com⟩」：这条是 Codex 猜的、还没经你确认（插件把它排在内置规则后面）
      const m = answer.match(/\s*⟨([^⟩]*)⟩\s*$/);
      if (m) answer = answer.slice(0, m.index).trim();
      return { keys, answer, src: m ? (m[1].trim().split(/\s+/)[0] || 'codex') : '', note: m ? m[1].trim() : '' };
    })
    .filter((r) => r.keys.length && r.answer);
}
