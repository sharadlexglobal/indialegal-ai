const $ = (s) => document.querySelector(s);
const fmt = (d) => new Date(d).toLocaleString();

let activeCase = null;
let room = null;

// ---------- Upload ----------
$('#file').addEventListener('change', (e) => {
  const f = e.target.files[0];
  $('#file-label').textContent = f ? f.name : 'Tap to choose PDF';
});

$('#upload-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = $('#file').files[0];
  if (!file) return;
  const title = $('#title').value || file.name.replace(/\.pdf$/i, '');
  const fd = new FormData();
  fd.append('pdf', file);
  fd.append('title', title);

  $('#upload-btn').disabled = true;
  $('#upload-status').textContent = 'Uploading…';
  $('#upload-status').className = 'status';
  try {
    const res = await fetch('/api/cases', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'upload failed');
    $('#upload-status').textContent = 'Uploaded. Processing in background…';
    $('#upload-status').className = 'status ok';
    $('#file').value = ''; $('#file-label').textContent = 'Tap to choose PDF'; $('#title').value = '';
    loadCases();
  } catch (err) {
    $('#upload-status').textContent = err.message;
    $('#upload-status').className = 'status err';
  } finally {
    $('#upload-btn').disabled = false;
  }
});

// ---------- Cases ----------
const STATUS_LABELS = {
  processing:  { label: 'Queued',                  hint: 'Just uploaded — getting started…',         cls: 'pending',  spin: true  },
  ocr_running: { label: 'Reading PDF',             hint: 'Datalab is OCR-ing the document (≈30-90s)', cls: 'pending',  spin: true  },
  ocr_done:    { label: 'OCR done, preparing AI',  hint: 'Sending to AI memory…',                     cls: 'pending',  spin: true  },
  indexing:    { label: 'Indexing in AI memory',   hint: 'Embedding for fast lookup (≈30-90s)',       cls: 'pending',  spin: true  },
  ready:       { label: 'Ready to speak',          hint: 'Tap Speak to start a voice session',        cls: 'ready',    spin: false },
  failed:      { label: 'Failed',                  hint: 'Something went wrong — see error',          cls: 'failed',   spin: false }
};

let casePollMs = 5000;

async function loadCases() {
  try {
    const res = await fetch('/api/cases?kind=document');
    const list = await res.json();
    const ul = $('#cases-list');
    ul.innerHTML = '';
    if (!list.length) {
      ul.innerHTML = '<li style="color:var(--muted);">No cases yet. Upload one above.</li>';
      casePollMs = 5000;
      return;
    }
    let anyInFlight = false;
    for (const c of list) {
      const sx = STATUS_LABELS[c.status] || { label: c.status, hint: '', cls: 'pending', spin: false };
      if (sx.spin) anyInFlight = true;
      const ready = c.status === 'ready' && c.has_store;
      const spinner = sx.spin ? '<span class="spin"></span>' : '';
      const li = document.createElement('li');
      li.innerHTML = `
        <div class="case-title">
          <div>${escapeHtml(c.title)}</div>
          <div class="case-meta">${c.page_count ? c.page_count + ' pages · ' : ''}${fmt(c.created_at)}</div>
          <div class="case-hint">${spinner}${escapeHtml(sx.hint)}</div>
        </div>
        <span class="badge ${sx.cls}">${sx.label}</span>
        <div class="case-buttons">
          <button class="case-action case-speak" ${ready ? '' : 'disabled'} data-id="${c.id}" data-title="${escapeHtml(c.title)}">Speak</button>
          <button class="case-action case-research" ${ready ? '' : 'disabled'} data-id="${c.id}" data-title="${escapeHtml(c.title)}">Research</button>
        </div>
      `;
      ul.appendChild(li);
    }
    ul.querySelectorAll('.case-speak').forEach(btn => {
      btn.addEventListener('click', () => openVoiceFor(btn.dataset.id, btn.dataset.title, 'case'));
    });
    ul.querySelectorAll('.case-research').forEach(btn => {
      btn.addEventListener('click', () => openVoiceFor(btn.dataset.id, btn.dataset.title, 'research'));
    });
    // Faster polling while any case is in-flight so the user sees prompt transitions.
    casePollMs = anyInFlight ? 2500 : 6000;
  } catch (e) { console.error(e); }
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

(function scheduleNextPoll() {
  setTimeout(async () => { await loadCases(); scheduleNextPoll(); }, casePollMs);
})();
loadCases();

// ---------- Standalone Research sessions ----------
async function loadResearchSessions() {
  try {
    const res = await fetch('/api/cases?kind=standalone_research');
    const list = await res.json();
    const ul = $('#research-list');
    ul.innerHTML = '';
    if (!list.length) {
      ul.innerHTML = '<li class="research-empty">No past research sessions yet.</li>';
      return;
    }
    for (const c of list) {
      const ready = c.status === 'ready' && c.has_store;
      const li = document.createElement('li');
      li.className = 'research-session-row';
      li.innerHTML = `
        <div class="research-session-meta">
          <div class="research-session-title">${escapeHtml(c.title)}</div>
          <div class="research-session-sub">${fmt(c.created_at)} · ${escapeHtml(c.status)}</div>
        </div>
        <div class="research-session-buttons">
          <button class="case-action research-continue" ${ready ? '' : 'disabled'} data-id="${c.id}" data-title="${escapeHtml(c.title)}">Continue research</button>
          <button class="case-action case-speak" ${ready ? '' : 'disabled'} data-id="${c.id}" data-title="${escapeHtml(c.title)}">Speak</button>
        </div>
      `;
      ul.appendChild(li);
    }
    ul.querySelectorAll('.research-continue').forEach(btn => {
      btn.addEventListener('click', () => openVoiceFor(btn.dataset.id, btn.dataset.title, 'research'));
    });
    ul.querySelectorAll('.case-speak').forEach(btn => {
      btn.addEventListener('click', () => openVoiceFor(btn.dataset.id, btn.dataset.title, 'case'));
    });
  } catch (e) { console.error(e); }
}
setInterval(loadResearchSessions, 6000);
loadResearchSessions();

$('#standalone-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const titleInput = $('#standalone-title');
  const title = (titleInput.value || '').trim();
  const btn = $('#start-standalone');
  btn.disabled = true;
  $('#standalone-status').textContent = 'Creating research session…';
  $('#standalone-status').className = 'status';
  try {
    const res = await fetch('/api/research/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'create failed');
    $('#standalone-status').textContent = 'Opening voice session…';
    $('#standalone-status').className = 'status ok';
    titleInput.value = '';
    openVoiceFor(data.id, data.title, 'research');
    loadResearchSessions();
  } catch (err) {
    $('#standalone-status').textContent = err.message;
    $('#standalone-status').className = 'status err';
  } finally {
    btn.disabled = false;
  }
});

// ---------- Voice session ----------
function openVoiceFor(id, title, mode = 'case') {
  activeCase = { id, title, mode };
  $('#voice-card').classList.remove('hidden');
  $('#voice-card-title').textContent = mode === 'research' ? '3. Legal Research session' : '3. Voice session';
  $('#voice-case').textContent = (mode === 'research' ? 'Research on: ' : 'Case: ') + title;
  $('#voice-status').textContent = '';
  $('#turn-log').innerHTML = '';
  $('#start-voice').classList.remove('hidden');
  $('#stop-voice').classList.add('hidden');
  if (mode === 'research') {
    $('#facts-panel').classList.add('hidden');
    $('#research-panel').classList.remove('hidden');
    loadResearchPanel(id);
  } else {
    $('#research-panel').classList.add('hidden');
    loadFactsPanel(id);
  }
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
}

async function loadResearchPanel(caseId) {
  try {
    const r = await fetch(`/api/cases/${caseId}/research`);
    const jobs = await r.json();
    const box = $('#research-list');
    if (!jobs.length) {
      box.innerHTML = '<div class="research-empty">No research jobs yet. Start a conversation to begin.</div>';
      return;
    }
    const RUNNING = jobs.some(j => j.status === 'running' || j.status === 'confirmed' || j.status === 'scoping');
    box.innerHTML = jobs.map(j => {
      const cls = j.status === 'done' ? 'done' : j.status === 'failed' ? 'failed' : 'running';
      const spinner = (j.status === 'running' || j.status === 'confirmed') ? '<span class="spin"></span>' : '';
      const summary = j.summary || j.plan || `Status: ${j.status}`;
      return `<div class="research-row ${cls}">
        ${spinner}<div class="r-text">
          <div class="r-title">${escapeHtml(j.plan || 'Research job')}</div>
          <div class="r-meta">${j.judgment_count || 0} judgments · ${escapeHtml(j.status)} · ${fmt(j.created_at)}</div>
          ${j.status === 'done' ? `<div class="r-summary">${escapeHtml(summary)}</div>` : ''}
        </div>
      </div>`;
    }).join('');
    if (RUNNING) setTimeout(() => loadResearchPanel(caseId), 5000);
  } catch (e) { console.error(e); }
}

const FACT_LABELS = [
  ['document_type', 'Type'],
  ['case_title', 'Title'],
  ['case_number', 'Case No.'],
  ['court', 'Court'],
  ['judge', 'Judge'],
  ['filing_date', 'Filed'],
  ['fir_number', 'FIR No.'],
  ['fir_date', 'FIR Date'],
  ['police_station', 'P.S.'],
  ['petitioner', 'Petitioner'],
  ['respondent', 'Respondent'],
  ['advocate_for_petitioner', 'Counsel (P)'],
  ['advocate_for_respondent', 'Counsel (R)'],
  ['sections', 'Sections'],
  ['prayer', 'Prayer'],
  ['next_hearing_date', 'Next Hearing'],
  ['one_line_summary', 'Summary']
];

async function loadFactsPanel(caseId) {
  const panel = $('#facts-panel');
  panel.classList.remove('hidden');
  panel.innerHTML = '<div class="facts-pending"><span class="spin"></span>Loading case facts…</div>';
  try {
    const r = await fetch(`/api/cases/${caseId}/facts`);
    const d = await r.json();
    if (d.facts_status === 'extracting' || !d.facts) {
      panel.innerHTML = `<div class="facts-pending"><span class="spin"></span>${
        d.facts_status === 'failed' ? 'Fact extraction failed — voice still works.' :
        'Extracting structured facts from the document…'
      }</div>`;
      // poll until ready
      if (d.facts_status === 'extracting') setTimeout(() => loadFactsPanel(caseId), 4000);
      return;
    }
    const fmtVal = (v) => {
      if (v == null || v === '') return null;
      if (Array.isArray(v)) return v.filter(Boolean).join(', ') || null;
      return String(v).trim() || null;
    };
    const rows = FACT_LABELS
      .map(([k, label]) => ({ label, val: fmtVal(d.facts[k]) }))
      .filter(x => x.val != null);
    if (!rows.length) {
      panel.innerHTML = '<div class="facts-pending">No structured facts found in this document.</div>';
      return;
    }
    panel.innerHTML = `<h3>Case facts</h3>
      <div class="facts-grid">${rows.map(r =>
        `<div class="k">${escapeHtml(r.label)}</div><div class="v">${escapeHtml(r.val)}</div>`
      ).join('')}</div>`;
  } catch (e) {
    panel.innerHTML = '<div class="facts-pending">Could not load facts.</div>';
  }
}

$('#start-voice').addEventListener('click', async () => {
  if (!activeCase) return;
  setStatus(activeCase.mode === 'research' ? 'Opening research session…' : 'Loading case…');
  try {
    const endpoint = activeCase.mode === 'research' ? 'research-room' : 'voice-room';
    const tokRes = await fetch(`/api/cases/${activeCase.id}/${endpoint}`, { method: 'POST' });
    const tok = await tokRes.json();
    if (!tokRes.ok) throw new Error(tok.error || 'token failed');

    setStatus('Requesting microphone…');
    setStatus('Connecting to room…');
    room = new LivekitClient.Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    // Agent audio — auto-attach when the Python agent publishes its TTS track.
    room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (track.kind === 'audio') {
        track.attach($('#ai-audio'));
        setStatus(`Connected to ${participant.identity}. Speak now.`, 'ok');
      }
    });

    // Live transcription events from Sarvam STT + agent TTS.
    room.on(LivekitClient.RoomEvent.TranscriptionReceived, (segments, participant) => {
      const text = segments.map(s => s.text).join(' ').trim();
      if (!text) return;
      const isAgent = participant && participant.identity && participant.identity.startsWith('agent-');
      pushTurn(isAgent ? 'assistant' : 'user', text);
    });

    room.on(LivekitClient.RoomEvent.Disconnected, () => {
      setStatus('Session ended.');
    });

    await room.connect(tok.url, tok.token);
    await room.localParticipant.setMicrophoneEnabled(true);

    $('#start-voice').classList.add('hidden');
    $('#stop-voice').classList.remove('hidden');
  } catch (e) {
    console.error(e); setStatus(e.message, 'err'); cleanup();
  }
});

$('#stop-voice').addEventListener('click', () => {
  cleanup(); setStatus('Session ended.');
  $('#start-voice').classList.remove('hidden'); $('#stop-voice').classList.add('hidden');
});

async function cleanup() {
  if (room) { try { await room.disconnect(); } catch {} room = null; }
  const audio = $('#ai-audio');
  if (audio.srcObject) {
    try { audio.srcObject.getTracks().forEach(t => t.stop()); } catch {}
    audio.srcObject = null;
  }
}

function setStatus(msg, cls) {
  $('#voice-status').textContent = msg;
  $('#voice-status').className = 'status' + (cls ? ' ' + cls : '');
}

// ---------- Turn log + warnings ----------
function pushTurn(kind, text) {
  if (!text || !text.trim()) return;
  const log = $('#turn-log');
  const div = document.createElement('div');
  div.className = 'turn turn-' + kind;
  const label = kind === 'user' ? 'You'
              : kind === 'assistant' ? 'AI'
              : kind === 'search' ? 'Search'
              : kind;
  div.innerHTML = `<span class="turn-label">${label}</span><span class="turn-text">${escapeHtml(text)}</span>`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

