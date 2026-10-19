(async () => {
  const id = new URLSearchParams(location.search).get('id') || '';
  const d = await chrome.storage.local.get(['resumes', 'resume', 'defaultResumeId', 'transcript', 'coverLetters']);
  const isTranscript = id === 'transcript';
  const isCL = id.startsWith('cl:') || id.startsWith('ws:');
  const list = wdafResumeList(d);
  const R = isTranscript ? d.transcript : isCL ? (d.coverLetters || {})[id]
    : list.find((r) => r.id === id) || list.find((r) => r.id === d.defaultResumeId);
  const $ = (s) => document.querySelector(s);
  if (!R || !R.data) {
    $('#f').remove();
    document.body.append(Object.assign(document.createElement('p'), { className: 'empty', textContent: isTranscript ? '插件里还没有成绩单。' : isCL ? '没找到这封 cover letter。' : '插件里没有这份简历，去设置页上传。' }));
    return;
  }
  const label = isTranscript ? '成绩单' : isCL ? `${R.kind === 'writingSample' ? 'Writing sample' : 'Cover letter'} · ${[R.company, R.title].filter(Boolean).join(' · ') || R.name}` : R.label || '简历';
  const bin = atob(R.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const type = R.type || 'application/pdf';
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  document.title = `${label} · ${R.name}`;
  $('#t').textContent = label;
  $('#m').textContent = isCL
    ? `${R.name}${R.time ? '，' + new Date(R.time).toLocaleString() + ' 写的' : ''}${R.path ? '，存在 ' + R.path : ''}`
    : `上传时文件名：${R.name}（${Math.round(bytes.length / 1024)} KB）`;
  Object.assign($('#dl'), { href: url, download: R.name, hidden: false });
  if (/pdf/i.test(type)) $('#f').src = url;
  else $('#f').replaceWith(Object.assign(document.createElement('p'), { className: 'empty', textContent: '这个格式浏览器预览不了，点右上角「下载」打开。' }));
})();
