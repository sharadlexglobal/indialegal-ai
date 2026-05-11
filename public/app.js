const $ = (s) => document.querySelector(s);
const fmt = (d) => new Date(d).toLocaleString();

let activeCase = null;
let pc = null;
let micStream = null;

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
    $('#file').value = '';
    $('#file-label').textContent = 'Tap to choose PDF';
    $('#title').value = '';
    loadCases();
  } catch (err) {
    $('#upload-status').textContent = err.message;
    $('#upload-status').className = 'status err';
  } finally {
    $('#upload-btn').disabled = false;
  }
});

// ---------- Cases list ----------
async function loadCases() {
  try {
    const res = await fetch('/api/cases');
    const list = await res.json();
    const ul = $('#cases-list');
    ul.innerHTML = '';
    if (!list.length) {
      ul.innerHTML = '<li style="color:var(--muted);">No cases yet. Upload one above.</li>';
      return;
    }
    for (const c of list) {
      const li = document.createElement('li');
      const ready = c.status === 'ready' || c.status === 'ocr_done';
      li.innerHTML = `
        <div class="case-title">
          <div>${escapeHtml(c.title)}</div>
          <div class="case-meta">${c.page_count || '?'} pages · ${fmt(c.created_at)}</div>
        </div>
        <span class="badge ${c.status}">${c.status}</span>
        <button class="case-action" ${ready ? '' : 'disabled'} data-id="${c.id}" data-title="${escapeHtml(c.title)}">Speak</button>
      `;
      ul.appendChild(li);
    }
    ul.querySelectorAll('.case-action').forEach(btn => {
      btn.addEventListener('click', () => openVoiceFor(btn.dataset.id, btn.dataset.title));
    });
  } catch (e) {
    console.error(e);
  }
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

setInterval(loadCases, 5000);
loadCases();

// ---------- Voice session ----------
function openVoiceFor(id, title) {
  activeCase = { id, title };
  $('#voice-card').classList.remove('hidden');
  $('#voice-case').textContent = `Case: ${title}`;
  $('#voice-status').textContent = '';
  $('#start-voice').classList.remove('hidden');
  $('#stop-voice').classList.add('hidden');
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
}

$('#start-voice').addEventListener('click', async () => {
  if (!activeCase) return;
  setStatus('Requesting microphone…');
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });

    setStatus('Loading case into AI…');
    const tokRes = await fetch(`/api/cases/${activeCase.id}/voice-token`, { method: 'POST' });
    const tok = await tokRes.json();
    if (!tokRes.ok) throw new Error(tok.error || 'token failed');

    setStatus('Connecting…');
    pc = new RTCPeerConnection();
    pc.ontrack = (e) => { $('#ai-audio').srcObject = e.streams[0]; };
    for (const track of micStream.getTracks()) pc.addTrack(track, micStream);

    const dc = pc.createDataChannel('oai-events');
    dc.addEventListener('open', () => setStatus('Connected. Start speaking.', 'ok'));
    dc.addEventListener('message', (ev) => {
      try { const evt = JSON.parse(ev.data); console.log('rt', evt.type); } catch {}
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const sdpRes = await fetch(`https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(tok.model)}`, {
      method: 'POST',
      body: offer.sdp,
      headers: { Authorization: `Bearer ${tok.token}`, 'Content-Type': 'application/sdp' }
    });
    const answerSdp = await sdpRes.text();
    if (!sdpRes.ok) throw new Error(`SDP exchange failed: ${answerSdp}`);
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

    $('#start-voice').classList.add('hidden');
    $('#stop-voice').classList.remove('hidden');
  } catch (e) {
    console.error(e);
    setStatus(e.message, 'err');
    cleanup();
  }
});

$('#stop-voice').addEventListener('click', () => {
  cleanup();
  setStatus('Session ended.');
  $('#start-voice').classList.remove('hidden');
  $('#stop-voice').classList.add('hidden');
});

function cleanup() {
  if (pc) { try { pc.close(); } catch {} pc = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
}

function setStatus(msg, cls) {
  $('#voice-status').textContent = msg;
  $('#voice-status').className = 'status' + (cls ? ' ' + cls : '');
}
