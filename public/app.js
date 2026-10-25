// Inaccessibility UI. Plain JS, no build step.
// One form, three ways in: screenshot (file / paste / drop / screen capture),
// voice note (MediaRecorder, optional live transcript), text note.

const $ = (id) => document.getElementById(id);
const els = {
  status: $('status'), alert: $('alert'),
  navNew: $('nav-new'), navSaved: $('nav-saved'), savedCount: $('saved-count'),
  login: $('view-login'), loginForm: $('login-form'), passphrase: $('passphrase'),
  capture: $('view-capture'), captureHeading: $('capture-heading'), form: $('capture-form'),
  fileInput: $('file-input'), captureScreen: $('capture-screen'),
  record: $('record'), recordTimer: $('record-timer'), recordUnavailable: $('record-unavailable'),
  transcribeWrap: $('transcribe-wrap'), transcribe: $('transcribe'), transcript: $('transcript'),
  note: $('note'), url: $('url'),
  attachments: $('attachments'), attachCount: $('attach-count'),
  save: $('save'), discard: $('discard'),
  saved: $('view-saved'), savedList: $('saved-list'), savedEmpty: $('saved-empty'),
};

const state = {
  reportId: null,      // null = creating a new report; otherwise editing
  pending: [],         // { id, kind, blob, name, url }
  existing: [],        // files already stored: { name, type, kind, url }
  recorder: null, recognition: null, recStart: 0, recTimer: null, recChunks: [],
  counter: 0,
};

// ---------- feedback ----------
const say = (msg) => { els.alert.textContent = ''; els.status.textContent = msg; };
const fail = (msg) => { els.status.textContent = ''; els.alert.textContent = msg; };

// ---------- API ----------
async function api(path, init = {}) {
  const res = await fetch(path, init);
  if (res.status === 401 && !path.startsWith('/api/session')) {
    showLogin();
    throw new Error('Please sign in.');
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch {}
    throw new Error(detail || `Request failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

// ---------- views ----------
function show(view) {
  for (const v of [els.login, els.capture, els.saved]) v.hidden = v !== view;
  els.navNew.setAttribute('aria-current', view === els.capture ? 'page' : 'false');
  els.navSaved.setAttribute('aria-current', view === els.saved ? 'page' : 'false');
}
function showLogin() { show(els.login); els.passphrase.focus(); }

// ---------- attachments ----------
function kindOf(type) {
  if (type.startsWith('image/')) return 'screenshot';
  if (type.startsWith('audio/')) return 'audio';
  return 'file';
}
const label = (kind) => (kind === 'screenshot' ? 'Screenshot' : kind === 'audio' ? 'Voice note' : 'File');
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function addPending(blob, name, quiet = false) {
  const kind = kindOf(blob.type || '');
  const item = { id: `p${++state.counter}`, kind, blob, name: name || `${kind}.${(blob.type.split('/')[1] || 'bin').split(';')[0]}`, url: URL.createObjectURL(blob) };
  state.pending.push(item);
  renderAttachments();
  if (!quiet) say(`${label(kind)} added (${fmtSize(blob.size)}). Not saved yet.`);
  return item;
}

function renderAttachments() {
  const all = [
    ...state.existing.map((f) => ({ ...f, saved: true })),
    ...state.pending.map((f) => ({ ...f, saved: false })),
  ];
  els.attachments.replaceChildren();
  const counts = {};
  for (const f of all) {
    const n = (counts[f.kind] = (counts[f.kind] || 0) + 1);
    const title = `${label(f.kind)} ${n}`;
    const li = document.createElement('li');
    const fig = document.createElement('figure');
    if (f.kind === 'screenshot') {
      const img = document.createElement('img');
      img.src = f.url; img.alt = `${title}${f.saved ? '' : ', not saved yet'}`; img.loading = 'lazy';
      fig.append(img);
    } else if (f.kind === 'audio') {
      const audio = document.createElement('audio');
      audio.controls = true; audio.src = f.url; audio.setAttribute('aria-label', title); audio.preload = 'metadata';
      fig.append(audio);
    } else {
      const a = document.createElement('a'); a.href = f.url; a.textContent = f.name; fig.append(a);
    }
    const cap = document.createElement('figcaption');
    cap.textContent = `${title} · ${f.saved ? 'saved' : 'not saved yet'}${f.blob ? ` · ${fmtSize(f.blob.size)}` : ''}`;
    fig.append(cap);
    const rm = document.createElement('button');
    rm.type = 'button'; rm.className = 'btn small danger'; rm.textContent = `Remove ${title.toLowerCase()}`;
    rm.addEventListener('click', () => removeAttachment(f, title));
    li.append(fig, rm);
    els.attachments.append(li);
  }
  els.attachCount.textContent = all.length ? `(${all.length})` : '(none)';
}

async function removeAttachment(f, title) {
  if (!f.saved) {
    state.pending = state.pending.filter((p) => p.id !== f.id);
    URL.revokeObjectURL(f.url);
    renderAttachments();
    say(`${title} removed.`);
    return;
  }
  if (!confirm(`Delete ${title.toLowerCase()} from the saved note?`)) return;
  try {
    const report = await api(`/api/reports/${state.reportId}/files/${encodeURIComponent(f.name)}`, { method: 'DELETE' });
    state.existing = report.files.map(toExisting(report.id));
    renderAttachments();
    say(`${title} deleted.`);
  } catch (err) { fail(err.message); }
}

const toExisting = (id) => (f) => ({ ...f, url: `/api/reports/${id}/files/${encodeURIComponent(f.name)}` });

// ---------- screenshot sources ----------
els.fileInput.addEventListener('change', () => {
  for (const file of els.fileInput.files) addPending(file, file.name);
  els.fileInput.value = '';
});

document.addEventListener('paste', (e) => {
  if (els.capture.hidden) return;
  const files = [...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
  if (!files.length) return;
  e.preventDefault();
  for (const f of files) addPending(f, f.name);
});

let dragDepth = 0;
document.addEventListener('dragenter', (e) => { if (!els.capture.hidden) { dragDepth++; document.body.classList.add('dropping'); } });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dropping'); } });
document.addEventListener('dragover', (e) => { if (!els.capture.hidden) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  dragDepth = 0; document.body.classList.remove('dropping');
  if (els.capture.hidden) return;
  e.preventDefault();
  for (const f of e.dataTransfer?.files || []) addPending(f, f.name);
});

if (navigator.mediaDevices?.getDisplayMedia) {
  els.captureScreen.hidden = false;
  els.captureScreen.addEventListener('click', async () => {
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const video = document.createElement('video');
      video.srcObject = stream; video.muted = true;
      await video.play();
      await new Promise((r) => (video.videoWidth ? r() : video.addEventListener('loadedmetadata', r, { once: true })));
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      addPending(blob, 'screen.png');
    } catch (err) {
      if (err.name !== 'NotAllowedError') fail(`Could not capture the screen: ${err.message}`);
      else say('Screen capture cancelled.');
    } finally {
      stream?.getTracks().forEach((t) => t.stop());
      els.captureScreen.focus();
    }
  });
}

// ---------- voice ----------
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (Recognition) {
  els.transcribeWrap.hidden = false;
  try { els.transcribe.checked = localStorage.getItem('transcribe') !== 'off'; } catch {}
  els.transcribe.addEventListener('change', () => { try { localStorage.setItem('transcribe', els.transcribe.checked ? 'on' : 'off'); } catch {} });
}

if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
  els.record.disabled = true;
  els.recordUnavailable.hidden = false;
}

function pickMime() {
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/aac']) {
    if (MediaRecorder.isTypeSupported?.(t)) return t;
  }
  return '';
}

els.record.addEventListener('click', async () => {
  if (state.recorder) return stopRecording();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    return fail(err.name === 'NotAllowedError' ? 'Microphone access was denied.' : `Could not start the microphone: ${err.message}`);
  }
  const mimeType = pickMime();
  const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  state.recChunks = [];
  rec.addEventListener('dataavailable', (e) => { if (e.data.size) state.recChunks.push(e.data); });
  rec.addEventListener('stop', () => {
    stream.getTracks().forEach((t) => t.stop());
    const type = rec.mimeType || mimeType || 'audio/webm';
    const blob = new Blob(state.recChunks, { type });
    const secs = Math.round((Date.now() - state.recStart) / 1000);
    if (blob.size) addPending(blob, `voice-note.${type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'}`, true);
    say(`Recording stopped after ${secs} second${secs === 1 ? '' : 's'}. ${blob.size ? `Voice note added (${fmtSize(blob.size)}). Not saved yet.` : 'Nothing was captured.'}`);
  });
  rec.start(1000);
  state.recorder = rec;
  state.recStart = Date.now();
  els.record.textContent = 'Stop recording';
  els.record.setAttribute('aria-pressed', 'true');
  els.recordTimer.textContent = '0:00';
  state.recTimer = setInterval(() => {
    const s = Math.round((Date.now() - state.recStart) / 1000);
    els.recordTimer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
  say('Recording. Press the button again to stop.');
  if (Recognition && els.transcribe.checked) startRecognition();
});

function stopRecording() {
  clearInterval(state.recTimer);
  els.recordTimer.textContent = '';
  els.record.textContent = 'Record voice note';
  els.record.setAttribute('aria-pressed', 'false');
  try { state.recorder?.stop(); } catch {}
  state.recorder = null;
  try { state.recognition?.stop(); } catch {}
  state.recognition = null;
}

function startRecognition() {
  const r = new Recognition();
  r.continuous = true; r.interimResults = false; r.lang = navigator.language || 'en-US';
  r.addEventListener('result', (e) => {
    let text = '';
    for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) text += e.results[i][0].transcript + ' ';
    if (!text.trim()) return;
    els.transcript.value = (els.transcript.value.trimEnd() + ' ' + text.trim()).trim();
  });
  r.addEventListener('end', () => { if (state.recorder && state.recognition === r) { try { r.start(); } catch {} } });
  r.addEventListener('error', () => {});
  try { r.start(); state.recognition = r; } catch {}
}

// ---------- context ----------
function captureContext() {
  const mq = (q) => (window.matchMedia ? window.matchMedia(q).matches : undefined);
  return {
    capturedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    language: navigator.language,
    platform: navigator.userAgentData?.platform || navigator.platform,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    screen: { width: screen.width, height: screen.height },
    devicePixelRatio: window.devicePixelRatio,
    rootFontSizePx: parseFloat(getComputedStyle(document.documentElement).fontSize),
    textZoom: Math.round((parseFloat(getComputedStyle(document.documentElement).fontSize) / 16) * 100) + '%',
    prefersReducedMotion: mq('(prefers-reduced-motion: reduce)'),
    prefersContrastMore: mq('(prefers-contrast: more)'),
    prefersColorScheme: mq('(prefers-color-scheme: dark)') ? 'dark' : 'light',
    forcedColors: mq('(forced-colors: active)'),
    pointerCoarse: mq('(pointer: coarse)'),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

// ---------- save ----------
els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.recorder) { stopRecording(); await new Promise((r) => setTimeout(r, 300)); }
  const note = els.note.value.trim(), transcript = els.transcript.value.trim(), url = els.url.value.trim();
  if (!note && !transcript && !state.pending.length && !state.existing.length) {
    fail('Add a screenshot, a voice note, or some text first.');
    els.note.focus();
    return;
  }
  els.save.disabled = true;
  say('Saving…');
  try {
    const fd = new FormData();
    for (const p of state.pending) fd.append('file', p.blob, p.name);
    if (state.reportId) {
      await api(`/api/reports/${state.reportId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note, transcript, url }) });
      if (state.pending.length) await api(`/api/reports/${state.reportId}/files`, { method: 'POST', body: fd });
    } else {
      fd.set('note', note); fd.set('transcript', transcript); fd.set('url', url); fd.set('context', JSON.stringify(captureContext()));
      await api('/api/reports', { method: 'POST', body: fd });
    }
    resetForm();
    await refreshCount();
    say('Saved. Ready for the next one.');
    els.note.focus();
  } catch (err) {
    fail(`Not saved: ${err.message}. Your note is still here, try again.`);
  } finally {
    els.save.disabled = false;
  }
});

function resetForm() {
  for (const p of state.pending) URL.revokeObjectURL(p.url);
  state.pending = []; state.existing = []; state.reportId = null;
  els.form.reset();
  if (Recognition) { try { els.transcribe.checked = localStorage.getItem('transcribe') !== 'off'; } catch {} }
  els.captureHeading.textContent = 'New note';
  els.discard.hidden = true;
  renderAttachments();
  if (location.hash) history.replaceState(null, '', location.pathname);
}

els.discard.addEventListener('click', () => { resetForm(); show(els.capture); say('Closed.'); els.note.focus(); });

async function openReport(id) {
  const report = await api(`/api/reports/${id}`);
  resetForm();
  state.reportId = report.id;
  state.existing = report.files.map(toExisting(report.id));
  els.note.value = report.note || ''; els.transcript.value = report.transcript || ''; els.url.value = report.url || '';
  els.captureHeading.textContent = `Editing note from ${fmtDate(report.createdAt)}`;
  els.discard.hidden = false;
  renderAttachments();
  show(els.capture);
  say(`Opened note from ${fmtDate(report.createdAt)}.`);
  els.captureHeading.tabIndex = -1; els.captureHeading.focus();
}

// ---------- saved list ----------
const fmtDate = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

async function refreshCount() {
  try {
    const { reports } = await api('/api/reports');
    els.savedCount.textContent = reports.length ? String(reports.length) : '';
    els.savedCount.setAttribute('aria-label', `${reports.length} saved`);
    return reports;
  } catch { return []; }
}

async function showSaved() {
  show(els.saved);
  const reports = await refreshCount();
  els.savedEmpty.hidden = reports.length > 0;
  els.savedList.replaceChildren();
  for (const r of reports) {
    const li = document.createElement('li');
    const art = document.createElement('article');
    const h = document.createElement('h2'); h.textContent = fmtDate(r.createdAt);
    art.append(h);
    if (r.url) { const p = document.createElement('p'); p.className = 'meta'; p.textContent = r.url; art.append(p); }
    const shots = r.files.filter((f) => f.kind === 'screenshot');
    const audios = r.files.filter((f) => f.kind === 'audio');
    if (shots.length) {
      const div = document.createElement('div'); div.className = 'thumbs';
      shots.forEach((f, i) => { const img = document.createElement('img'); img.src = `/api/reports/${r.id}/files/${encodeURIComponent(f.name)}`; img.alt = `Screenshot ${i + 1}`; img.loading = 'lazy'; div.append(img); });
      art.append(div);
    }
    const text = [r.note, r.transcript].filter(Boolean).join('\n');
    if (text) { const p = document.createElement('p'); p.className = 'note'; p.textContent = text.length > 280 ? text.slice(0, 277) + '…' : text; art.append(p); }
    const meta = document.createElement('p'); meta.className = 'meta';
    meta.textContent = [shots.length && `${shots.length} screenshot${shots.length > 1 ? 's' : ''}`, audios.length && `${audios.length} voice note${audios.length > 1 ? 's' : ''}`].filter(Boolean).join(', ') || 'Text only';
    art.append(meta);
    const actions = document.createElement('div'); actions.className = 'actions';
    const open = document.createElement('button'); open.type = 'button'; open.className = 'btn small'; open.textContent = 'Open';
    open.setAttribute('aria-label', `Open note from ${fmtDate(r.createdAt)}`);
    open.addEventListener('click', () => openReport(r.id).catch((err) => fail(err.message)));
    const json = document.createElement('a'); json.className = 'btn small'; json.href = `/api/reports/${r.id}`; json.textContent = 'JSON'; json.setAttribute('aria-label', `JSON for note from ${fmtDate(r.createdAt)}`);
    const del = document.createElement('button'); del.type = 'button'; del.className = 'btn small danger'; del.textContent = 'Delete';
    del.setAttribute('aria-label', `Delete note from ${fmtDate(r.createdAt)}`);
    del.addEventListener('click', async () => {
      if (!confirm(`Delete the note from ${fmtDate(r.createdAt)}? This cannot be undone.`)) return;
      try { await api(`/api/reports/${r.id}`, { method: 'DELETE' }); say('Note deleted.'); await showSaved(); els.navSaved.focus(); }
      catch (err) { fail(err.message); }
    });
    actions.append(open, json, del);
    art.append(actions);
    li.append(art);
    els.savedList.append(li);
  }
}

els.navNew.addEventListener('click', () => { show(els.capture); els.note.focus(); });
els.navSaved.addEventListener('click', () => showSaved().catch((err) => fail(err.message)));

// ---------- login ----------
els.loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: els.passphrase.value }) });
    els.passphrase.value = '';
    await start();
    say('Signed in.');
  } catch (err) { fail(err.message); }
});

// ---------- boot ----------
async function start() {
  const hash = new URLSearchParams(location.hash.slice(1));
  show(els.capture);
  renderAttachments();
  await refreshCount();
  if (hash.get('edit')) await openReport(hash.get('edit')).catch((err) => fail(err.message));
  else els.note.focus();
}

(async () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try {
    const res = await fetch('/api/session');
    const session = res.ok ? await res.json() : { authRequired: false, authenticated: true };
    if (session.authRequired && !session.authenticated) showLogin();
    else await start();
  } catch (err) {
    fail(`Cannot reach the server: ${err.message}`);
    show(els.capture);
  }
})();
