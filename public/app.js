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
  // Facts (only meaningful for uploaded docs). Universal-atomic schema
  // has ~60 fields — group them so the panel stays scannable.
  const factsEl = $('#ctx-facts');
  factsEl.innerHTML = '';
  if (kind === 'document') {
    try {
      const r = await fetch(`/api/cases/${caseId}/facts`);
      const { facts, facts_status } = await r.json();
      const f = facts || {};
      renderFactGroups(factsEl, f, facts_status);
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

// Render the universal-atomic facts grouped in the same logical
// sections as the Datalab schema, so the advocate can scan top-to-
// bottom. Empty groups are dropped entirely (no clutter).
const FACT_GROUPS = [
  { head: 'Identity',
    fields: ['document_type','document_title_or_heading','document_date','document_reference_number'] },
  { head: 'Court',
    fields: ['case_title','case_number','court','judge_or_bench','filing_date','next_hearing_date','advocate_for_petitioner','advocate_for_respondent'] },
  { head: 'Parties',
    fields: ['parties','petitioner','respondent','relationship_between_parties'] },
  { head: 'Authority & signatures',
    fields: ['issuing_authority','signatories','attesting_witnesses'] },
  { head: 'Subject matter',
    fields: ['subject_matter_summary','subject_matter_type','property_description','monetary_amounts_in_dispute'] },
  { head: 'Facts',
    fields: ['facts_chronology','key_incidents','transactions','cause_of_action_date','cause_of_action_description'] },
  { head: 'Evidence',
    fields: ['documentary_evidence','oral_evidence_witnesses','specific_admissions','specific_denials'] },
  { head: 'Statute & precedent',
    fields: ['sections','articles_invoked','rules_invoked','precedents_cited'] },
  { head: 'Prayers',
    fields: ['main_prayers','interim_prayers','alternative_prayers'] },
  { head: 'Orders',
    fields: ['order_outcome','operative_directions','costs_awarded','key_orders_or_holdings'] },
  { head: 'Deed / agreement',
    fields: ['consideration_amount','consideration_payment_mode','effective_date','termination_or_expiry_date','governing_law','jurisdiction_clause','arbitration_clause','key_obligations'] },
  { head: 'Will',
    fields: ['testator_name','executor','beneficiaries','specific_bequests'] },
  { head: 'Criminal',
    fields: ['fir_number','fir_date','police_station','offences_alleged','investigating_officer','accused_named','arrest_status','recoveries'] },
  { head: 'Notice / service',
    fields: ['notice_recipient','notice_demand','notice_compliance_period','notice_consequence_threatened','mode_of_service','postal_or_tracking_number'] },
  { head: 'Summary',
    fields: ['one_line_summary','detailed_summary'] }
];

const FACT_LABELS = {
  document_type: 'Type', document_title_or_heading: 'Heading',
  document_date: 'Date', document_reference_number: 'Ref no.',
  case_title: 'Title', case_number: 'Case no.', court: 'Court',
  judge_or_bench: 'Judge / bench', filing_date: 'Filed',
  next_hearing_date: 'Next hearing',
  advocate_for_petitioner: 'Adv. (P)', advocate_for_respondent: 'Adv. (R)',
  parties: 'Parties', petitioner: 'Petitioner', respondent: 'Respondent',
  relationship_between_parties: 'Inter-se relation',
  issuing_authority: 'Issued by', signatories: 'Signatories',
  attesting_witnesses: 'Attesting witnesses',
  subject_matter_summary: 'Subject (gist)', subject_matter_type: 'Subject type',
  property_description: 'Property', monetary_amounts_in_dispute: 'Amounts',
  facts_chronology: 'Chronology', key_incidents: 'Key incidents',
  transactions: 'Transactions',
  cause_of_action_date: 'Cause of action (date)',
  cause_of_action_description: 'Cause of action',
  documentary_evidence: 'Doc. evidence', oral_evidence_witnesses: 'Oral witnesses',
  specific_admissions: 'Admissions', specific_denials: 'Denials',
  sections: 'Sections', articles_invoked: 'Articles',
  rules_invoked: 'Rules', precedents_cited: 'Precedents cited',
  main_prayers: 'Main prayers', interim_prayers: 'Interim prayers',
  alternative_prayers: 'Alt. prayers',
  order_outcome: 'Outcome', operative_directions: 'Operative directions',
  costs_awarded: 'Costs', key_orders_or_holdings: 'Key orders / holdings',
  consideration_amount: 'Consideration', consideration_payment_mode: 'Payment mode',
  effective_date: 'Effective', termination_or_expiry_date: 'Termination',
  governing_law: 'Governing law', jurisdiction_clause: 'Jurisdiction',
  arbitration_clause: 'Arbitration', key_obligations: 'Key obligations',
  testator_name: 'Testator', executor: 'Executor',
  beneficiaries: 'Beneficiaries', specific_bequests: 'Bequests',
  fir_number: 'FIR no.', fir_date: 'FIR date', police_station: 'PS',
  offences_alleged: 'Offences', investigating_officer: 'IO',
  accused_named: 'Accused', arrest_status: 'Arrest status',
  recoveries: 'Recoveries',
  notice_recipient: 'Notice to', notice_demand: 'Notice demand',
  notice_compliance_period: 'Compliance period',
  notice_consequence_threatened: 'Threatened action',
  mode_of_service: 'Mode of service', postal_or_tracking_number: 'Postal / tracking #',
  one_line_summary: 'One-line', detailed_summary: 'Summary'
};

function renderFactGroups(host, facts, status) {
  const isFilled = (v) =>
    v != null && v !== '' && !(Array.isArray(v) && v.length === 0);
  let anyShown = false;

  for (const group of FACT_GROUPS) {
    const filledInGroup = group.fields.filter(k => isFilled(facts[k]));
    if (!filledInGroup.length) continue;
    anyShown = true;
    host.appendChild(el('dt', { class: 'ctx-group-head' }, group.head));
    for (const k of filledInGroup) {
      const v = facts[k];
      host.appendChild(el('dt', { class: 'ctx-fact-key' }, FACT_LABELS[k] || k));
      const valStr = Array.isArray(v)
        ? v.join('  ·  ')
        : String(v);
      host.appendChild(el('dd', { class: 'ctx-fact-val' }, valStr));
    }
  }
  if (!anyShown) {
    host.appendChild(el('dd', { class: 'row empty' },
      status === 'done' ? 'No facts extracted.' :
      status === 'failed' ? 'Extraction failed.' : 'Extracting…'));
  }
}

async function loadMessages(caseId) {
  state.threadEl.innerHTML = '';
  try {
    const r = await fetch(`/api/cases/${caseId}/messages`);
    const msgs = await r.json();
    for (const m of (msgs || [])) renderMessage(m);
    if (!msgs?.length) renderEmptyHint();
    scrollThread();
  } catch (e) {
    console.warn('load messages failed', e);
    renderEmptyHint();
  }
}

// Empty-state hint — shows example questions so the user knows the
// thread accepts text input (not just voice). Different copy for
// document Q&A vs research mode.
function renderEmptyHint() {
  if (!state.activeCase) return;
  const isResearch = state.activeCase.kind === 'standalone_research';
  const examples = isResearch
    ? [
        'Section 482 CrPC pe top 5 SC judgments lao aur index karo',
        'PMLA Section 19 written grounds — last 2 saal ke landmark cases',
        '498A quash for matrimonial — SC ke top 5 dhundh kar verify karo'
      ]
    : [
        'judge kaun hai',
        'kis section mein hai',
        'FIR mein main allegation kya hai',
        'next hearing kab hai',
        'is case file ka one-line summary'
      ];
  const hint = el('div', { class: 'empty-hint' },
    el('p', { class: 'eh-line' },
      isResearch
        ? 'Type below to start research, or press ⌘M to talk.'
        : 'Type below, or press ⌘M to talk.'),
    el('p', { class: 'eh-sub' }, 'Try:'),
    el('ul', { class: 'eh-list' },
      ...examples.map(ex =>
        el('li', { class: 'eh-item',
          onclick: () => {
            const input = $('#composer-input');
            input.value = ex; input.focus();
            input.dispatchEvent(new Event('input'));
          }
        }, ex))
    )
  );
  state.threadEl.appendChild(hint);
}

function renderMessage(m) {
  // Once the user starts a conversation, drop the empty-state hint.
  const hint = state.threadEl?.querySelector('.empty-hint');
  if (hint) hint.remove();

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
  else if (tc.name === 'search_indian_kanoon') label = `precedent search · "${(tc.args?.query || '').slice(0, 50)}"`;
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
  } else if (ev.event === 'tool_result') {
    // If the agent JUST kicked off legal research, attach the live
    // SSE timeline inline so the user sees verdicts streaming.
    if (ev.data?.name === 'execute_legal_research' && ev.data?.result?.jobId) {
      attachResearchBlock(ev.data.result.jobId, /* focus */ true);
      // refresh the right-panel research list silently
      if (state.activeCase) loadContext(state.activeCase.id, state.activeCase.kind);
    }
  } else if (ev.event === 'research_started') {
    // Backend pre-announces the job before the LLM's final text arrives —
    // gives the timeline a head start.
    if (ev.data?.jobId) attachResearchBlock(ev.data.jobId, /* focus */ false);
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
      // Already-done research → auto-render the headnote digest from
      // the saved judgments. The advocate sees the consolidated SCC
      // list without scrolling each card.
      renderDigestFromJudgments(block, job.judgments);
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
    stage(`searching precedents — doctype: ${(d.doctypes || []).join(', ')}`);
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
    // Render the headnote digest from the live cards we accumulated.
    renderDigestFromCards(block);
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

// SCC-headnote digest — one consolidated list of every indexed judgment's
// headnote, in maroon, rendered automatically when research completes.
// Sources data from the cards already rendered in the block (the SSE path)
// OR from the saved judgments array (historical snapshot path).
function renderDigestFromCards(block) {
  if (!block || block.querySelector('.rb-digest')) return;
  const cards = $$('.judgment-card.applicable, .judgment-card.tangential', block);
  if (!cards.length) return;
  const items = cards.map(c => ({
    title: c.querySelector('.jc-title')?.textContent?.trim() || '',
    meta:  c.querySelector('.jc-meta')?.textContent?.trim() || '',
    headnote: c.querySelector('.jc-headnote')?.textContent?.trim() || '',
    verdict: ['applicable','tangential'].find(v => c.classList.contains(v)) || ''
  })).filter(it => it.title && it.headnote);
  if (!items.length) return;
  appendDigest(block, items);
}

function renderDigestFromJudgments(block, judgments) {
  if (!block || block.querySelector('.rb-digest')) return;
  const items = (judgments || [])
    .filter(j => j.verdict === 'APPLICABLE' || j.verdict === 'TANGENTIAL')
    .map(j => ({
      title: j.title || `tid ${j.tid}`,
      meta: [j.court, j.date && fmtDate(j.date)].filter(Boolean).join('  ·  '),
      headnote: j.verdict_reason || j.agent2_summary?.split('. ')[0] || '',
      verdict: (j.verdict || '').toLowerCase()
    }))
    .filter(it => it.title && it.headnote);
  if (!items.length) return;
  appendDigest(block, items);
}

function appendDigest(block, items) {
  const wrap = el('div', { class: 'rb-digest' },
    el('div', { class: 'rb-digest-head' },
      `Indexed judgments · headnotes  (${items.length})`)
  );
  for (const it of items) {
    wrap.appendChild(el('div', { class: `rb-digest-item ${it.verdict}` },
      el('div', { class: 'rb-digest-title' }, it.title),
      it.meta ? el('div', { class: 'jc-meta' }, it.meta) : null,
      el('div', { class: 'rb-digest-headnote' }, it.headnote)
    ));
  }
  block.appendChild(wrap);
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
  $$('.jc-verdict, .jc-reason, .jc-summary, .jc-quotes, .jc-headnote, .jc-expand', card)
    .forEach(n => n.remove());

  // ─── Headnote-first layout (SCC style) ───
  // Title is already in the card. Right under: verdict badge + the
  // ONE-LINE headnote (what makes this case relevant) so the advocate
  // gets the gist at a glance.
  card.appendChild(el('div', { class: 'jc-verdict' },
    `${d.verdict}  ·  ${d.confidence != null ? d.confidence + '/10' : ''}`));
  if (d.reason) {
    // The verdict reason IS the headnote — 1 line, italic, weighty.
    card.appendChild(el('div', { class: 'jc-headnote' }, d.reason));
  }

  // Verbatim quotes — court's own words, the proof.
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

  // DeepSeek's longer lens-summary goes under an expandable toggle so
  // the card stays scannable. Don't show by default; click "+ summary".
  if (d.summary) {
    const sumWrap = el('details', { class: 'jc-expand' },
      el('summary', {}, 'summary'),
      el('div', { class: 'jc-summary' }, d.summary)
    );
    card.appendChild(sumWrap);
  }

  // After a verdict lands, re-sort siblings so APPLICABLE rises to top.
  const block = card.closest('.research-block');
  if (block) reorderCards(block);
}

// ─────────────────── boot ───────────────────
loadList().catch(console.error);
