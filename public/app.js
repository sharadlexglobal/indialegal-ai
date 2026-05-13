/* ─────────────────────────────────────────────────────────────────
   INDIALEGAL.AI — frontend
   Two screens:
     1) list       — research sessions + uploaded cases
     2) workspace  — unified thread (text + voice), context panel
   No frameworks. Vanilla JS + DOM.
   ───────────────────────────────────────────────────────────────── */

const $  = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));

const state = {
  activeCase: null,           // {id, title, kind, page_count, status}
  liveRoom: null,             // LiveKit Room
  researchStreams: new Map(), // jobId -> EventSource
  researchBlocks: new Map(),  // jobId -> DOM node in thread
  threadEl: null,
};

// ─────────────────── time + html helpers ───────────────────
const fmtTime = (iso) => {
  const d = new Date(iso || Date.now());
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
};
const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' });
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
);
// Lightweight markdown — only **bold**, *italic*, `code`, lists, paragraphs.
function md(text) {
  if (!text) return '';
  const lines = String(text).split('\n');
  const out = [];
  let inList = false;
  for (const raw of lines) {
    const line = raw.replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
    );
    const inline = (s) => s
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
    if (/^\s*[-•]\s+/.test(line)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(line.replace(/^\s*[-•]\s+/, ''))}</li>`);
    } else if (!line.trim()) {
      if (inList) { out.push('</ul>'); inList = false; }
    } else {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  if (inList) out.push('</ul>');
  return out.join('');
}
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const k of kids) {
    if (k == null) continue;
    n.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
  }
  return n;
}

// ─────────────────── routing ───────────────────
const screens = { list: $('#screen-list'), workspace: $('#screen-workspace') };
function go(name) {
  Object.values(screens).forEach(s => s.classList.add('hidden'));
  screens[name].classList.remove('hidden');
}

// ─────────────────── list screen ───────────────────
async function loadList() {
  const [casesR, researchR] = await Promise.all([
    fetch('/api/cases?kind=document').then(r => r.json()),
    fetch('/api/cases?kind=standalone_research').then(r => r.json()),
  ]);

  const cases = Array.isArray(casesR) ? casesR : [];
  const research = Array.isArray(researchR) ? researchR : [];

  const renderRows = (host, items, kind) => {
    host.innerHTML = '';
    if (!items.length) {
      host.appendChild(el('div', { class: 'row empty' },
        kind === 'document' ? 'No cases uploaded yet.' : 'No research sessions yet.'
      ));
      return;
    }
    for (const c of items) {
      let meta;
      if (kind === 'document') {
        meta = c.page_count ? `${c.page_count} pages` : (c.status || '—');
      } else {
        const j = Number(c.judgment_count || 0);
        const r = Number(c.research_count || 0);
        meta = r === 0
          ? 'no research yet'
          : `${r} session${r > 1 ? 's' : ''}  ·  ${j} judgment${j === 1 ? '' : 's'}`;
      }
      const row = el('div', { class: 'row',
        onclick: () => openWorkspace(c) },
        el('div', { class: 'row-title' }, c.title || 'Untitled'),
        el('div', { class: 'row-meta' }, meta),
        el('div', { class: 'row-meta' }, fmtDate(c.created_at))
      );
      host.appendChild(row);
    }
  };
  renderRows($('#cases-list'), cases, 'document');
  renderRows($('#research-list'), research, 'standalone_research');
}

// ─────────────────── sheets ───────────────────
function showSheet(id) { $('#' + id).classList.remove('hidden'); }
function hideSheet(id) { $('#' + id).classList.add('hidden'); }
$$('[data-close-sheet]').forEach(b => b.addEventListener('click', () => {
  b.closest('.sheet').classList.add('hidden');
}));

$('#new-upload').addEventListener('click', () => showSheet('upload-sheet'));
$('#new-research').addEventListener('click', () => showSheet('research-sheet'));

$('#research-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('#research-title').value.trim() || `Research — ${new Date().toLocaleString()}`;
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    const r = await fetch('/api/research/new', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'failed');
    hideSheet('research-sheet');
    $('#research-title').value = '';
    await loadList();
    openWorkspace({ id: j.id, title: j.title, kind: 'standalone_research', status: 'ready' });
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Begin';
  }
});

$('#upload-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = $('#upload-file').files[0];
  if (!file) return;
  const title = $('#upload-title').value.trim() || file.name;
  const fd = new FormData();
  fd.append('pdf', file);
  fd.append('title', title);
  const status = $('#upload-status');
  status.textContent = 'Uploading…';
  status.className = 'row-meta';
  try {
    const r = await fetch('/api/cases', { method: 'POST', body: fd });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'upload failed');
    status.textContent = 'Processing in background…';
    status.className = 'row-meta ok';
    setTimeout(() => {
      hideSheet('upload-sheet');
      $('#upload-form').reset();
      status.textContent = '';
      loadList();
    }, 600);
  } catch (err) {
    status.textContent = err.message;
    status.className = 'row-meta err';
  }
});

// ─────────────────── workspace ───────────────────
async function openWorkspace(c) {
  state.activeCase = c;
  state.threadEl = $('#thread');
  $('#ws-title').textContent = c.title || 'Untitled';
  $('#ws-meta').textContent = c.kind === 'document'
    ? `${c.page_count || '—'} pages`
    : 'research session';

  state.threadEl.innerHTML = '';
  state.researchBlocks.clear();
  // close any active SSE
  for (const s of state.researchStreams.values()) s.close();
  state.researchStreams.clear();

  go('workspace');

  // Load context (facts + research jobs) + conversation history in parallel
  await Promise.all([
    loadContext(c.id, c.kind),
    loadMessages(c.id),
  ]);

  // Auto-focus composer
  $('#composer-input').focus();
}

$('#back-to-list').addEventListener('click', () => {
  // Tear down active resources
  for (const s of state.researchStreams.values()) s.close();
  state.researchStreams.clear();
  if (state.liveRoom) { try { state.liveRoom.disconnect(); } catch {} state.liveRoom = null; }
  state.activeCase = null;
  go('list');
  loadList();
});

async function loadContext(caseId, kind) {
  // Facts (only meaningful for uploaded docs)
  const factsEl = $('#ctx-facts');
  factsEl.innerHTML = '';
  if (kind === 'document') {
    try {
      const r = await fetch(`/api/cases/${caseId}/facts`);
      const { facts, facts_status } = await r.json();
      const f = facts || {};
      const order = ['case_title','case_number','court','judge','petitioner','respondent','sections','filing_date','next_hearing_date','one_line_summary'];
      const labels = {
        case_title: 'Title', case_number: 'Case no.', court: 'Court', judge: 'Judge',
        petitioner: 'Petitioner', respondent: 'Respondent', sections: 'Sections',
        filing_date: 'Filed', next_hearing_date: 'Next hearing',
        one_line_summary: 'Summary'
      };
      let any = false;
      for (const k of order) {
        const v = f[k];
        if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
        any = true;
        factsEl.appendChild(el('dt', {}, labels[k] || k));
        factsEl.appendChild(el('dd', {}, Array.isArray(v) ? v.join(', ') : String(v)));
      }
      if (!any) factsEl.appendChild(el('dd', { class: 'row empty' },
        facts_status === 'done' ? 'No facts extracted.' : 'Extracting…'));
    } catch {
      factsEl.appendChild(el('dd', { class: 'row empty' }, '—'));
    }
  } else {
    factsEl.appendChild(el('dd', { class: 'row empty' }, 'Research-only session.'));
  }

  // Research list
  const rEl = $('#ctx-research');
  rEl.innerHTML = '';
  try {
    const r = await fetch(`/api/cases/${caseId}/research`);
    const jobs = await r.json();
    if (!jobs?.length) {
      rEl.appendChild(el('div', { class: 'ctx-research-item empty' }, 'None yet.'));
    } else {
      for (const j of jobs) {
        const label =
          j.plan
          || (j.scope && (j.scope.keywords || j.scope.principle))
          || `Research #${j.id}`;
        const item = el('div', { class: 'ctx-research-item',
          onclick: () => attachResearchBlock(j.id, /* reload */ true) },
          el('div', { class: 'ctx-research-title' }, String(label).slice(0, 80)),
          el('div', { class: 'ctx-research-meta' },
            `${j.status}  ·  ${j.judgment_count || 0} judgments  ·  ${fmtDate(j.created_at)}`)
        );
        rEl.appendChild(item);
      }
    }
  } catch {}
}

async function loadMessages(caseId) {
  state.threadEl.innerHTML = '';
  try {
    const r = await fetch(`/api/cases/${caseId}/messages`);
    const msgs = await r.json();
    for (const m of (msgs || [])) renderMessage(m);
    scrollThread();
  } catch (e) {
    console.warn('load messages failed', e);
  }
}

function renderMessage(m) {
  const node = el('div', { class: `msg ${m.role}` },
    el('div', { class: 'msg-head' },
      el('span', { class: 'msg-role' }, m.role === 'user' ? 'You' : 'Agent'),
      m.meta?.source ? el('span', { class: 'msg-source' }, m.meta.source) : null,
      el('span', { class: 'msg-time' }, fmtTime(m.created_at))
    ),
    el('div', { class: 'msg-body', html: md(m.content) })
  );

  // Inline tool-call lines for assistant messages
  if (m.role === 'assistant' && Array.isArray(m.meta?.tool_calls)) {
    const body = node.querySelector('.msg-body');
    for (const tc of m.meta.tool_calls) {
      body.insertBefore(toolLine(tc), body.firstChild);
    }
  }

  state.threadEl.appendChild(node);
  return node;
}

function toolLine(tc) {
  let label = tc.name;
  if (tc.name === 'lookup_case_fact') label = `lookup · ${tc.args?.field || ''}`;
  else if (tc.name === 'search_case_file') label = `search case file · "${(tc.args?.query || '').slice(0, 50)}"`;
  else if (tc.name === 'search_indian_kanoon') label = `Indian Kanoon · "${(tc.args?.query || '').slice(0, 50)}"`;
  const isErr = tc.result?.error;
  return el('div', { class: `tool-line${isErr ? ' error' : ''}` }, label);
}

function scrollThread() {
  state.threadEl.scrollTop = state.threadEl.scrollHeight;
}

// ─────────────────── composer ───────────────────
const input = $('#composer-input');
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});

$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = input.value.trim();
  if (!msg || !state.activeCase) return;
  input.value = ''; input.style.height = 'auto';

  // optimistic user bubble
  const userNode = renderMessage({
    role: 'user', content: msg,
    meta: { source: 'text' }, created_at: new Date().toISOString()
  });
  scrollThread();

  // pending assistant bubble (we'll fill it in as SSE events arrive)
  const pending = el('div', { class: 'msg assistant' },
    el('div', { class: 'msg-head' },
      el('span', { class: 'msg-role' }, 'Agent'),
      el('span', { class: 'msg-source' }, 'thinking'),
      el('span', { class: 'msg-time' }, fmtTime())
    ),
    el('div', { class: 'msg-body' })
  );
  state.threadEl.appendChild(pending);
  scrollThread();
  const body = pending.querySelector('.msg-body');
  const sourceTag = pending.querySelector('.msg-source');

  try {
    const r = await fetch(`/api/cases/${state.activeCase.id}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg })
    });
    if (!r.ok || !r.body) throw new Error('chat stream failed');

    // Parse SSE stream from POST response
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop();
      for (const block of events) {
        if (!block.trim() || block.startsWith(':')) continue;
        const ev = parseSSE(block);
        if (!ev) continue;
        handleChatEvent(ev, body, sourceTag);
      }
    }
  } catch (err) {
    body.innerHTML = `<p><em>${esc(err.message)}</em></p>`;
    sourceTag.textContent = 'failed';
  }
});

function parseSSE(block) {
  let event = 'message', data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  try { return { event, data: JSON.parse(data) }; }
  catch { return { event, data }; }
}

function handleChatEvent(ev, bodyEl, sourceTag) {
  if (ev.event === 'tool_call') {
    sourceTag.textContent = ev.data.name;
    const line = toolLine({ name: ev.data.name, args: ev.data.args });
    bodyEl.appendChild(line);
    scrollThread();
  } else if (ev.event === 'final') {
    sourceTag.textContent = 'text';
    bodyEl.insertAdjacentHTML('beforeend', md(ev.data.text));
    scrollThread();
  } else if (ev.event === 'failed') {
    sourceTag.textContent = 'failed';
    bodyEl.insertAdjacentHTML('beforeend', `<p><em>${esc(ev.data.error || 'failed')}</em></p>`);
  } else if (ev.event === 'done') {
    /* nothing — final text already rendered */
  }
}

// ─────────────────── voice (LiveKit) ───────────────────
$('#mic-btn').addEventListener('click', async () => {
  if (state.liveRoom) {
    try { await state.liveRoom.disconnect(); } catch {}
    state.liveRoom = null;
    $('#mic-btn').classList.remove('recording');
    return;
  }
  if (!state.activeCase) return;
  const c = state.activeCase;
  const endpoint = c.kind === 'standalone_research' ? 'research-room' : 'voice-room';
  const tokRes = await fetch(`/api/cases/${c.id}/${endpoint}`, { method: 'POST' });
  const tok = await tokRes.json();
  if (!tokRes.ok) { alert(tok.error || 'voice unavailable'); return; }

  const room = new LivekitClient.Room({
    adaptiveStream: true, dynacast: true,
    audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  });
  state.liveRoom = room;

  // Attach agent audio
  room.on(LivekitClient.RoomEvent.TrackSubscribed, (track) => {
    if (track.kind === 'audio') track.attach($('#agent-audio'));
  });

  // Live transcripts — also persist to conversation_messages so reload preserves
  let lastSavedFinal = ''; // crude dedupe (Sarvam emits partials AND finals)
  room.on(LivekitClient.RoomEvent.TranscriptionReceived, async (segments, participant) => {
    const text = segments.map(s => s.text).join(' ').trim();
    if (!text) return;
    const isAgent = participant?.identity?.startsWith('agent-');
    const isFinal = segments.every(s => s.final);
    if (!isFinal) return;
    if (text === lastSavedFinal) return;
    lastSavedFinal = text;
    const role = isAgent ? 'assistant' : 'user';
    renderMessage({
      role, content: text,
      meta: { source: 'voice' },
      created_at: new Date().toISOString()
    });
    scrollThread();
    // fire-and-forget persistence
    fetch(`/api/cases/${c.id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, content: text, meta: { source: 'voice' } })
    }).catch(() => {});
  });

  room.on(LivekitClient.RoomEvent.Disconnected, () => {
    $('#mic-btn').classList.remove('recording');
    state.liveRoom = null;
  });

  await room.connect(tok.url, tok.token);
  await room.localParticipant.setMicrophoneEnabled(true);
  $('#mic-btn').classList.add('recording');
});

// Keyboard shortcut: ⌘M / Ctrl+M = toggle mic
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'm') {
    e.preventDefault();
    $('#mic-btn').click();
  }
});

// ─────────────────── live research timeline (SSE) ───────────────────
// Called when:
//   • voice agent kicks off a research job (we discover via polling /research)
//   • user clicks an existing research item in the right panel
// Renders a research block inline in the thread that updates live.
async function attachResearchBlock(jobId, focus = false) {
  if (state.researchBlocks.has(jobId)) {
    if (focus) state.researchBlocks.get(jobId).scrollIntoView({ behavior: 'smooth' });
    return;
  }

  const block = el('div', { class: 'research-block' },
    el('div', { class: 'rb-head' }, `Research · job ${jobId}`)
  );
  state.threadEl.appendChild(block);
  state.researchBlocks.set(jobId, block);

  // Fetch initial snapshot so historical jobs show their data immediately
  try {
    const r = await fetch(`/api/cases/${state.activeCase.id}/research/${jobId}`);
    const job = await r.json();
    if (job.scope) {
      block.appendChild(el('div', { class: 'rb-soul' },
        el('span', {}, (job.plan || job.scope.keywords || '').slice(0, 200))));
    }
    if (Array.isArray(job.judgments)) {
      for (const j of job.judgments) renderJudgmentCard(block, j);
    }
    if (job.status === 'done' && job.summary) {
      block.appendChild(el('div', { class: 'rb-stage' }, `done · ${job.summary.slice(0, 200)}`));
      return; // no SSE needed
    }
  } catch {}

  // Open SSE for live updates
  const es = new EventSource(
    `/api/cases/${state.activeCase.id}/research/${jobId}/stream`
  );
  state.researchStreams.set(jobId, es);
  bindResearchSSE(es, block, jobId);

  if (focus) block.scrollIntoView({ behavior: 'smooth' });
}

function bindResearchSSE(es, block, jobId) {
  const stage = (text) => block.appendChild(el('div', { class: 'rb-stage' }, text));
  const cardsByTid = new Map();

  // Make sure existing cards from the snapshot are indexed
  $$('.judgment-card', block).forEach(c => {
    const tid = c.dataset.tid;
    if (tid) cardsByTid.set(tid, c);
  });

  const ensureCard = (tid, title, court, date) => {
    if (!tid) return null;
    let card = cardsByTid.get(String(tid));
    if (card) return card;
    card = renderJudgmentCard(block, { tid, title, court, date, verdict: 'pending' });
    cardsByTid.set(String(tid), card);
    return card;
  };

  es.addEventListener('soul_extracted', (e) => {
    const d = JSON.parse(e.data);
    block.appendChild(el('div', { class: 'rb-soul' },
      el('span', {}, d.soul_question || ''),
      d.keywords ? el('span', { class: 'kw' }, `  · ${d.keywords}`) : null
    ));
  });
  es.addEventListener('ikapi_search_start', (e) => {
    const d = JSON.parse(e.data);
    stage(`searching Indian Kanoon — doctype: ${(d.doctypes || []).join(', ')}`);
  });
  es.addEventListener('ikapi_broaden', (e) => {
    const d = JSON.parse(e.data);
    stage(`broadening to ${d.doctype} (recall low)`);
  });
  es.addEventListener('candidates', (e) => {
    const d = JSON.parse(e.data);
    stage(`${d.count} candidates fetched`);
    for (const c of (d.candidates || [])) ensureCard(c.tid, c.title, c.court, c.date);
    scrollThread();
  });
  es.addEventListener('fetch_text', (e) => {
    const d = JSON.parse(e.data);
    const card = ensureCard(d.tid, d.title);
    if (card) appendStage(card, 'reading full text…');
  });
  es.addEventListener('agent2_start', (e) => {
    const d = JSON.parse(e.data);
    const card = cardsByTid.get(String(d.tid));
    if (card) appendStage(card, `Agent 2: reading ${d.text_length} chars`);
  });
  es.addEventListener('verdict', (e) => {
    const d = JSON.parse(e.data);
    const card = ensureCard(d.tid, d.title, d.court, d.date);
    finalizeJudgmentCard(card, d);   // d already includes relevant_quotes
    scrollThread();
  });
  es.addEventListener('indexing_start', (e) => {
    const d = JSON.parse(e.data);
    const card = cardsByTid.get(String(d.tid));
    if (card) appendStage(card, 'indexing into case store…');
  });
  es.addEventListener('indexed', (e) => {
    const d = JSON.parse(e.data);
    const card = cardsByTid.get(String(d.tid));
    if (card) appendStage(card, 'indexed ✓');
  });
  es.addEventListener('verdicts_complete', (e) => {
    const d = JSON.parse(e.data);
    stage(`verdicts: ${d.applicable} applicable · ${d.tangential} tangential · ${d.inapplicable} inapplicable`);
  });
  es.addEventListener('done', (e) => {
    const d = JSON.parse(e.data);
    stage(`done in ${(d.elapsed_ms/1000).toFixed(1)}s · ${d.summary || ''}`);
    es.close();
    state.researchStreams.delete(jobId);
    scrollThread();
  });
  es.addEventListener('failed', (e) => {
    const d = JSON.parse(e.data);
    stage(`failed: ${d.reason || d.error || ''}`);
    es.close();
    state.researchStreams.delete(jobId);
  });
  es.onerror = () => { /* SSE will auto-reconnect; nothing to do here */ };
}

function renderJudgmentCard(parent, j) {
  const verdict = (j.verdict || 'pending').toLowerCase();
  const card = el('div', { class: `judgment-card ${verdict}`,
    onclick: (e) => {
      // Don't toggle on text-selection of quotes / summary
      if (window.getSelection?.()?.toString()) return;
      card.classList.toggle('expanded');
    } },
    el('div', { class: 'jc-title' }, j.title || `tid ${j.tid}`),
    el('div', { class: 'jc-meta' },
      [j.court, j.date && fmtDate(j.date)].filter(Boolean).join('  ·  ') || '—')
  );
  card.dataset.tid = String(j.tid || '');
  if (j.verdict && j.verdict !== 'pending') finalizeJudgmentCard(card, {
    verdict: j.verdict, reason: j.verdict_reason, confidence: j.verdict_confidence,
    summary: j.agent2_summary,
    relevant_quotes: j.relevant_quotes
  });
  parent.appendChild(card);
  return card;
}

function appendStage(card, text) {
  card.appendChild(el('div', { class: 'jc-stage' }, text));
}

// Verdict-based card ordering. Lower number = sorts higher in the
// timeline. APPLICABLE first, then TANGENTIAL, then everything else.
const VERDICT_RANK = { applicable: 0, tangential: 1, pending: 2, inapplicable: 3 };

function reorderCards(parent) {
  // Re-sort all judgment cards within `parent` (a research-block).
  // Stable-ish sort: same-verdict cards preserve insertion order.
  const cards = Array.from(parent.querySelectorAll('.judgment-card'));
  cards.forEach((c, i) => { c.dataset._idx = String(i); });
  cards.sort((a, b) => {
    const ra = VERDICT_RANK[[...a.classList].find(c => VERDICT_RANK[c] != null)] ?? 99;
    const rb = VERDICT_RANK[[...b.classList].find(c => VERDICT_RANK[c] != null)] ?? 99;
    if (ra !== rb) return ra - rb;
    return Number(a.dataset._idx) - Number(b.dataset._idx);
  });
  for (const c of cards) parent.appendChild(c);
}

function finalizeJudgmentCard(card, d) {
  // Remove old verdict bits if present (re-runs)
  card.classList.remove('pending', 'applicable', 'tangential', 'inapplicable');
  card.classList.add((d.verdict || 'INAPPLICABLE').toLowerCase());
  $$('.jc-verdict, .jc-reason, .jc-summary, .jc-quotes', card).forEach(n => n.remove());
  card.appendChild(el('div', { class: 'jc-verdict' },
    `${d.verdict}  ·  ${d.confidence != null ? d.confidence + '/10' : ''}`));
  if (d.reason) card.appendChild(el('div', { class: 'jc-reason' }, d.reason));

  // Verbatim quotes — THE trust criterion. Show before the summary so
  // the advocate sees the court's own words first.
  const quotes = Array.isArray(d.relevant_quotes) ? d.relevant_quotes : [];
  if (quotes.length) {
    const qWrap = el('div', { class: 'jc-quotes' });
    for (const q of quotes) {
      if (!q || !q.text || q.text.length < 20) continue;
      const block = el('blockquote', { class: 'jc-quote' });
      if (q.para) {
        block.appendChild(el('span', { class: 'jc-para-no' }, `¶ ${q.para}`));
      }
      block.appendChild(el('span', { class: 'jc-quote-text' }, q.text));
      qWrap.appendChild(block);
    }
    if (qWrap.childNodes.length) card.appendChild(qWrap);
  }

  if (d.summary) card.appendChild(el('div', { class: 'jc-summary' }, d.summary));

  // After a verdict lands, re-sort siblings so APPLICABLE rises to top.
  const block = card.closest('.research-block');
  if (block) reorderCards(block);
}

// ─────────────────── boot ───────────────────
loadList().catch(console.error);
