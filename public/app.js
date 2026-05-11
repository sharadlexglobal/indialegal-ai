const $ = (s) => document.querySelector(s);
const fmt = (d) => new Date(d).toLocaleString();

let activeCase = null;
let pc = null;
let micStream = null;
let dc = null;

// Per-turn state for verifier + forbidden-phrase tracking
let currentTurn = null;

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
    const res = await fetch('/api/cases');
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
        <button class="case-action" ${ready ? '' : 'disabled'} data-id="${c.id}" data-title="${escapeHtml(c.title)}">Speak</button>
      `;
      ul.appendChild(li);
    }
    ul.querySelectorAll('.case-action').forEach(btn => {
      btn.addEventListener('click', () => openVoiceFor(btn.dataset.id, btn.dataset.title));
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

// ---------- Voice session ----------
function openVoiceFor(id, title) {
  activeCase = { id, title };
  $('#voice-card').classList.remove('hidden');
  $('#voice-case').textContent = `Case: ${title}`;
  $('#voice-status').textContent = '';
  $('#turn-log').innerHTML = '';
  $('#start-voice').classList.remove('hidden');
  $('#stop-voice').classList.add('hidden');
  loadFactsPanel(id);
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
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
  setStatus('Requesting microphone…');
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    setStatus('Loading case…');
    const tokRes = await fetch(`/api/cases/${activeCase.id}/voice-token`, { method: 'POST' });
    const tok = await tokRes.json();
    if (!tokRes.ok) throw new Error(tok.error || 'token failed');

    setStatus('Connecting…');
    pc = new RTCPeerConnection();
    pc.ontrack = (e) => { $('#ai-audio').srcObject = e.streams[0]; };
    for (const track of micStream.getTracks()) pc.addTrack(track, micStream);

    dc = pc.createDataChannel('oai-events');
    dc.addEventListener('open', () => setStatus('Connected. Start speaking.', 'ok'));
    dc.addEventListener('message', onRealtimeEvent);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const sdpRes = await fetch(
      `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(tok.model)}`,
      { method: 'POST', body: offer.sdp,
        headers: { Authorization: `Bearer ${tok.token}`, 'Content-Type': 'application/sdp' } }
    );
    const answerSdp = await sdpRes.text();
    if (!sdpRes.ok) throw new Error(`SDP exchange failed: ${answerSdp}`);
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

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

function cleanup() {
  if (pc) { try { pc.close(); } catch {} pc = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  dc = null; currentTurn = null;
}

function setStatus(msg, cls) {
  $('#voice-status').textContent = msg;
  $('#voice-status').className = 'status' + (cls ? ' ' + cls : '');
}

// ---------- Realtime event handling ----------
async function onRealtimeEvent(ev) {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }

  // Track the user's most recent utterance (for verifier context).
  if (m.type === 'conversation.item.input_audio_transcription.completed') {
    pushTurn('user', m.transcript || '');
  }

  // Layer 1 — model issued a function call.
  if (m.type === 'response.function_call_arguments.done' && m.name === 'search_case_file') {
    let args = {};
    try { args = JSON.parse(m.arguments || '{}'); } catch {}
    const query = args.query || '';
    pushTurn('search', query);

    let result;
    try {
      const r = await fetch(`/api/cases/${activeCase.id}/search`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      });
      result = await r.json();
    } catch (e) {
      result = { snippets: [], refusal: 'This is not stated in the file.' };
    }

    // Remember snippets used for this turn (Layer 8 verifier + UI display).
    if (!currentTurn) currentTurn = { snippets: [], draft: '', query };
    currentTurn.snippets = result.snippets || [];
    currentTurn.refusal = result.refusal || null;
    currentTurn.query = query;

    // SANITIZE before sending to Realtime — strip internal ids (S1/S2/SYN/S0)
    // and the "GREETING_ACK" marker so the model can NEVER pronounce them.
    // The model sees only one of these clean shapes: {greeting:true},
    // {refusal:"..."}, or {snippets:[{page,text}|{page,pages,text}]}.
    let toolPayload;
    if (result.refusal) {
      toolPayload = { refusal: result.refusal };
    } else if ((result.snippets || []).some(s => s.text === 'GREETING_ACK')) {
      toolPayload = { greeting: true };
    } else {
      toolPayload = {
        snippets: (result.snippets || []).map(s => {
          const out = { page: s.page, text: s.text };
          if (Array.isArray(s.pages) && s.pages.length > 1) out.pages = s.pages;
          return out;
        })
      };
    }

    sendDC({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: m.call_id,
        output: JSON.stringify(toolPayload)
      }
    });
    // CRITICAL — override session-level tool_choice for THIS response.
    // Session has tool_choice="required" (forces the first call). After the
    // tool returns we MUST tell the model to speak, not call the tool again,
    // otherwise it loops on the preamble ("main batata hu, batata hu...").
    sendDC({
      type: 'response.create',
      response: {
        tool_choice: 'none',
        instructions:
          'The search_case_file tool has just returned. You ALREADY have the data ' +
          'you need in the latest function_call_output. Speak the answer NOW, in the ' +
          "user's most recent language, in 2-4 short sentences, following all the rules " +
          'from your system prompt (cite [S1]/[S2]/[SYN], use refusal verbatim if present, ' +
          'no forbidden hedging phrases, no preamble like "let me check" or "main batata hu"). ' +
          'Do NOT call any tool in this response.'
      }
    });
  }

  // Capture assistant transcript as it streams (for verifier + phrase scan).
  if (m.type === 'response.audio_transcript.delta') {
    if (!currentTurn) currentTurn = { snippets: [], draft: '', query: '' };
    currentTurn.draft += m.delta || '';
  }

  // Turn complete — run verifier + forbidden phrase scan.
  if (m.type === 'response.done') {
    if (currentTurn && currentTurn.draft) {
      const draft = currentTurn.draft;
      pushTurn('assistant', draft);

      // Layer 7 — forbidden phrase scan
      const pCheck = await fetch('/api/check-phrases', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: draft })
      }).then(r => r.json()).catch(() => ({ hits: [] }));

      // Layer 8 — verifier (only when there were real snippets, not greetings)
      let verdict = { verdict: 'all_supported', unsupported_claims: [] };
      const realSnips = (currentTurn.snippets || []).filter(s => s.text !== 'GREETING_ACK');
      if (realSnips.length) {
        verdict = await fetch(`/api/cases/${activeCase.id}/verify`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ draft, snippets: realSnips })
        }).then(r => r.json()).catch(() => ({ verdict: 'partial', unsupported_claims: [] }));
      }

      renderWarnings(pCheck.hits, verdict, realSnips);
      currentTurn = null;
    }
  }
}

function sendDC(obj) {
  if (dc && dc.readyState === 'open') dc.send(JSON.stringify(obj));
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

function renderWarnings(phraseHits, verdict, snippets) {
  const log = $('#turn-log');
  const warns = [];
  if (phraseHits && phraseHits.length) {
    warns.push(`⚠ Hedging language detected: ${phraseHits.join(', ')}`);
  }
  if (verdict.verdict === 'partial' || verdict.verdict === 'unsupported') {
    const claims = (verdict.unsupported_claims || []).slice(0, 3).map(c => `"${c}"`).join(' · ');
    warns.push(`⚠ Unverified by file search: ${claims || '(claim not found in snippets)'}`);
  }
  if (snippets && snippets.length) {
    const pages = [...new Set(snippets.map(s => s.page).filter(p => p != null))].join(', ');
    if (pages) {
      const div = document.createElement('div');
      div.className = 'turn turn-cite';
      div.innerHTML = `<span class="turn-label">Cite</span><span class="turn-text">page ${pages}</span>`;
      log.appendChild(div);
    }
  }
  for (const w of warns) {
    const div = document.createElement('div');
    div.className = 'turn turn-warn';
    div.textContent = w;
    log.appendChild(div);
  }
  log.scrollTop = log.scrollHeight;
}
