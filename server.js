require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const { Pool } = require('pg');

const { AccessToken } = require('livekit-server-sdk');
const datalab = require('./services/datalab');
const openai = require('./services/openai');
const gemini = require('./services/gemini');
const research = require('./services/research');
const bus = require('./services/eventBus');
const textAgent = require('./services/textAgent');
const extraction = require('./services/extraction');
const issueSpotter = require('./services/legalIssueSpotter');
const draftExperiment = require('./services/draftExperiment');
const {
  buildRealtimeSystemPrompt,
  FORBIDDEN_PHRASES,
  REFUSAL_BY_LANG
} = require('./prompts');

const app = express();
const upload = multer({ limits: { fileSize: 100 * 1024 * 1024 } });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(express.json({ limit: '20mb' }));

// Force no-cache on the entry HTML so version-bumped /app.js?v=N is
// always picked up. Static assets (with their own ?v= cache buster)
// are served normally below.
app.get(['/', '/index.html'], (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', async (_req, res) => {
  try {
    const r = await pool.query('SELECT 1 as ok');
    res.json({ ok: true, db: r.rows[0].ok === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/cases', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'pdf file required' });
    const title = (req.body.title || req.file.originalname || 'Untitled').trim().slice(0, 200);
    const ins = await pool.query(
      `INSERT INTO cases (title, filename, status) VALUES ($1, $2, 'processing') RETURNING id`,
      [title, req.file.originalname]
    );
    const caseId = ins.rows[0].id;
    processCase(caseId, req.file.buffer, req.file.originalname, title).catch(async (e) => {
      console.error(`[case ${caseId}] processing failed`, e);
      await pool.query(
        `UPDATE cases SET status='failed', error=$1, updated_at=NOW() WHERE id=$2`,
        [String(e.message || e), caseId]
      );
    });
    res.json({ id: caseId, status: 'processing' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

async function processCase(caseId, buffer, filename, title) {
  // Stage 1 — Datalab marker OCR (sequential; everything else needs page_count)
  await pool.query(
    `UPDATE cases SET status='ocr_running', updated_at=NOW() WHERE id=$1`, [caseId]
  );
  const { requestId, checkUrl } = await datalab.submitPdf(buffer, filename);
  await pool.query(
    `UPDATE cases SET request_id=$1, check_url=$2, updated_at=NOW() WHERE id=$3`,
    [requestId, checkUrl, caseId]
  );
  const result = await datalab.pollUntilDone(checkUrl);
  const flat = datalab.flattenForPrompt(result);
  const pageMap = datalab.extractPrintedPageMap(result);
  const tokenEstimate = Math.ceil(flat.length / 4);
  await pool.query(
    `UPDATE cases SET ocr_json=$1, ocr_markdown=$2, page_count=$3,
       token_estimate=$4, page_map=$5, status='ocr_done', updated_at=NOW() WHERE id=$6`,
    [result.json || null, flat, result.page_count || null, tokenEstimate,
     pageMap, caseId]
  );

  // Stage 2 — Run in PARALLEL:
  //   (a) NEW v2 extraction orchestrator — segments the PDF into
  //       sub-documents, runs type-specific Datalab extracts on each
  //       page-range, DeepSeek gap-fills + verifies atoms, then builds
  //       cross-segment intelligence (party graph, timeline, causation,
  //       audit, brief). Emits live SSE on `extract:<caseId>`.
  //   (b) Gemini File Search upload+indexing (semantic search).
  // Independent failures don't block each other.
  const extractTask = (async () => {
    try {
      await pool.query(
        `UPDATE cases SET facts_status='extracting', updated_at=NOW() WHERE id=$1`,
        [caseId]
      );
      const out = await extraction.runExtraction({
        pool, caseId, buffer, filename,
        flatMarkdown: flat,
        pageCount: result.page_count || null
      });
      // Roll the first segment's facts into the case-level `facts`
      // column too — keeps backwards compatibility with lookup_case_fact
      // and the old ctx-facts UI for atomic queries about the case
      // ("judge kaun hai", etc.). Voice/text agent's lookup tool
      // continues to work unchanged.
      const primary = out.segments[0]?.facts || {};
      await pool.query(
        `UPDATE cases SET facts=$1, facts_status='done', updated_at=NOW() WHERE id=$2`,
        [primary, caseId]
      );
    } catch (e) {
      console.warn(`[case ${caseId}] v2 extraction failed:`, e.message);
      await pool.query(
        `UPDATE cases SET facts_status='failed', error=$1, updated_at=NOW() WHERE id=$2`,
        [String(e.message || e).slice(0, 500), caseId]
      );
    }
  })();

  const geminiTask = (async () => {
    try {
      const storeName = await gemini.createStore(`case-${caseId}-${title.slice(0, 40)}`);
      const { operationName } = await gemini.uploadAndImport(storeName, buffer, filename);
      await pool.query(
        `UPDATE cases SET gemini_store_name=$1, gemini_file_name=$2,
           status='indexing', updated_at=NOW() WHERE id=$3`,
        [storeName, operationName, caseId]
      );
      const { documentName } = await gemini.pollIndexingComplete(operationName);
      await pool.query(
        `UPDATE cases SET gemini_file_name=$1, status='ready', updated_at=NOW() WHERE id=$2`,
        [documentName || operationName, caseId]
      );
    } catch (e) {
      console.warn(`[case ${caseId}] gemini indexing failed:`, e.message);
      await pool.query(
        `UPDATE cases SET status='failed', error=$1, updated_at=NOW() WHERE id=$2`,
        [`Gemini indexing failed: ${e.message}`, caseId]
      );
    }
  })();

  await Promise.allSettled([extractTask, geminiTask]);
}

app.get('/api/cases', async (req, res) => {
  // Optional ?kind=document|standalone_research to filter
  const kind = (req.query.kind || '').toString();
  const where = kind === 'document' || kind === 'standalone_research'
    ? `WHERE c.kind = $1` : '';
  const params = kind === 'document' || kind === 'standalone_research'
    ? [kind] : [];
  // Aggregate: for research sessions show total APPLICABLE+TANGENTIAL
  // judgments across all its done jobs. For document cases, this number
  // is also useful (indexed-research judgments attached to the file).
  const r = await pool.query(
    `SELECT c.id, c.title, c.filename, c.kind, c.status, c.page_count,
            c.token_estimate, c.facts_status,
            c.gemini_store_name IS NOT NULL AS has_store,
            c.facts IS NOT NULL AS has_facts,
            c.created_at,
            COALESCE((
              SELECT SUM(jsonb_array_length(COALESCE(j.judgments, '[]'::jsonb)))
                FROM research_jobs j
               WHERE j.case_id = c.id AND j.status = 'done'
            ), 0) AS judgment_count,
            COALESCE((
              SELECT COUNT(*) FROM research_jobs j WHERE j.case_id = c.id
            ), 0) AS research_count
       FROM cases c ${where} ORDER BY c.created_at DESC LIMIT 50`,
    params
  );
  res.json(r.rows);
});

app.get('/api/cases/:id', async (req, res) => {
  const r = await pool.query(
    `SELECT id, title, filename, status, page_count, token_estimate,
            gemini_store_name, facts, facts_status, page_map, error, created_at
       FROM cases WHERE id=$1`,
    [req.params.id]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'not found' });
  res.json(r.rows[0]);
});

// Just the facts for a case — used by the frontend Facts panel and (later)
// by a query router that answers atomic questions from this without
// hitting Gemini.
app.get('/api/cases/:id/facts', async (req, res) => {
  const r = await pool.query(
    `SELECT facts, facts_status FROM cases WHERE id=$1`, [req.params.id]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'not found' });
  res.json(r.rows[0]);
});

// V2 segment-aware fact lookup. Searches across every segment in the
// case for a field; returns matches with their source segment + pages.
// Used by the voice agent's lookup_case_fact tool.
app.get('/api/cases/:id/fact', async (req, res) => {
  try {
    const field = String(req.query.field || '').trim();
    if (!field) return res.status(400).json({ error: 'field required' });
    const sr = await pool.query(
      `SELECT segment_index, segment_type, page_start, page_end,
              facts -> $1 AS value
         FROM case_segments
        WHERE case_id = $2
          AND facts ? $1
          AND facts -> $1 IS NOT NULL
        ORDER BY segment_index ASC`,
      [field, req.params.id]
    );
    const hits = sr.rows
      .filter(r => r.value !== null && r.value !== '' &&
                   !(Array.isArray(r.value) && r.value.length === 0));
    if (hits.length) {
      return res.json({
        field,
        value: hits.length === 1 ? hits[0].value : hits.map(h => h.value),
        sources: hits.map(h =>
          `seg${h.segment_index} (${h.segment_type}, pp ${h.page_start}-${h.page_end})`),
        multi: hits.length > 1
      });
    }
    // V1 fallback
    const cr = await pool.query(`SELECT facts FROM cases WHERE id=$1`, [req.params.id]);
    if (!cr.rows.length) return res.status(404).json({ error: 'case not found' });
    const f = cr.rows[0].facts || {};
    const v = f[field];
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) {
      return res.json({ field, value: null, reason: 'not in any segment' });
    }
    res.json({ field, value: v, source: 'case-level (v1)' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Voice session — LiveKit path. Issues a participant JWT for joining a
// per-case room. The room name encodes the case id so the Python agent
// can identify which case the user is asking about.
app.post('/api/cases/:id/voice-room', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, title, status, gemini_store_name FROM cases WHERE id=$1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'case not found' });
    const c = r.rows[0];
    if (c.status !== 'ready' || !c.gemini_store_name) {
      return res.status(409).json({ error: `case status is ${c.status}` });
    }

    const roomName = `case-${c.id}-${Date.now().toString(36)}`;
    const identity = `user-${Date.now().toString(36)}`;

    const at = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      { identity, ttl: 60 * 60 }   // 1 hour
    );
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true
    });
    // Tell the agent worker which case this room is for via room metadata.
    // (Agent reads room.metadata when it joins.)
    at.metadata = JSON.stringify({ case_id: c.id, case_title: c.title });

    const token = await at.toJwt();

    res.json({
      url: process.env.LIVEKIT_URL,
      token,
      roomName,
      caseId: c.id,
      caseTitle: c.title
    });
  } catch (e) {
    console.error('voice-room error', e);
    res.status(500).json({ error: e.message });
  }
});

// Standalone Legal Research — no PDF needed. Create a virtual "case"
// (kind='standalone_research') plus an empty Gemini File Search store
// so the existing research-room + execute_legal_research pipeline
// works unchanged. Research findings index into THIS virtual case's
// store and become permanently searchable in future Speak sessions.
app.post('/api/research/new', async (req, res) => {
  try {
    const title = (req.body?.title || `Research session — ${new Date().toLocaleString()}`)
      .toString().trim().slice(0, 200);
    const ins = await pool.query(
      `INSERT INTO cases (title, filename, kind, status)
       VALUES ($1, $2, 'standalone_research', 'creating_store')
       RETURNING id`,
      [title, '']
    );
    const caseId = ins.rows[0].id;
    // create Gemini File Search store so research-room can immediately proceed
    try {
      const storeName = await gemini.createStore(`research-${caseId}-${title.slice(0, 40)}`);
      await pool.query(
        `UPDATE cases SET gemini_store_name=$1, status='ready', updated_at=NOW()
           WHERE id=$2`,
        [storeName, caseId]
      );
      res.json({ id: caseId, kind: 'standalone_research', title, status: 'ready' });
    } catch (e) {
      await pool.query(
        `UPDATE cases SET status='failed', error=$1, updated_at=NOW() WHERE id=$2`,
        [`Gemini store creation failed: ${e.message}`, caseId]
      );
      res.status(500).json({ error: 'could not initialise research store' });
    }
  } catch (e) {
    console.error('research/new error', e);
    res.status(500).json({ error: e.message });
  }
});

// ───── Legal Research (multi-turn scoping + IKAPI fetch + index) ─────

// Issues a LiveKit JWT for a research room. Agent detects mode from the
// 'research-' room name prefix and switches to research instructions.
app.post('/api/cases/:id/research-room', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, title, status, gemini_store_name FROM cases WHERE id=$1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'case not found' });
    const c = r.rows[0];
    if (c.status !== 'ready' || !c.gemini_store_name) {
      return res.status(409).json({ error: `case status is ${c.status}` });
    }
    const roomName = `research-${c.id}-${Date.now().toString(36)}`;
    const identity = `user-${Date.now().toString(36)}`;
    const at = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      { identity, ttl: 60 * 60 }
    );
    at.addGrant({
      roomJoin: true, room: roomName,
      canPublish: true, canSubscribe: true, canPublishData: true
    });
    at.metadata = JSON.stringify({ case_id: c.id, case_title: c.title, mode: 'research' });
    const token = await at.toJwt();
    res.json({ url: process.env.LIVEKIT_URL, token, roomName, caseId: c.id, caseTitle: c.title });
  } catch (e) {
    console.error('research-room error', e);
    res.status(500).json({ error: e.message });
  }
});

// Voice agent calls this once the user has approved its plan.
app.post('/api/cases/:id/start-research', async (req, res) => {
  try {
    const caseId = req.params.id;
    const scope = (req.body && req.body.scope) || {};
    const plan = (req.body && req.body.plan) || null;
    const cr = await pool.query(`SELECT gemini_store_name FROM cases WHERE id=$1`, [caseId]);
    if (!cr.rows.length || !cr.rows[0].gemini_store_name) {
      return res.status(404).json({ error: 'case not ready' });
    }
    const ins = await pool.query(
      `INSERT INTO research_jobs (case_id, scope, plan, status)
         VALUES ($1, $2, $3, 'confirmed') RETURNING id`,
      [caseId, scope, plan]
    );
    const jobId = ins.rows[0].id;
    // fire-and-forget background work
    research.runResearch(pool, jobId).catch(async (e) => {
      console.error(`[research ${jobId}] crashed`, e);
      await pool.query(
        `UPDATE research_jobs SET status='failed', error=$1, updated_at=NOW() WHERE id=$2`,
        [String(e.message || e), jobId]
      );
    });
    res.json({ jobId, status: 'confirmed' });
  } catch (e) {
    console.error('start-research error', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/cases/:id/research/:jobId', async (req, res) => {
  const r = await pool.query(
    `SELECT id, case_id, scope, plan, status, judgments, summary, error, created_at, updated_at
       FROM research_jobs WHERE id=$1 AND case_id=$2`,
    [req.params.jobId, req.params.id]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'job not found' });
  res.json(r.rows[0]);
});

// Admin: re-run the deterministic para-locator across all saved jobs and
// rewrite hallucinated DeepSeek para numbers. Used after deploying the
// locator fix to clean up historical data.
app.post('/api/admin/revalidate-paras', async (req, res) => {
  try {
    const out = await research.revalidateAllParas(pool);
    res.json(out);
  } catch (e) {
    console.error('revalidate-paras error', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/cases/:id/research', async (req, res) => {
  const r = await pool.query(
    `SELECT id, plan, scope, status, summary, created_at,
            jsonb_array_length(COALESCE(judgments, '[]'::jsonb)) AS judgment_count
       FROM research_jobs WHERE case_id=$1 ORDER BY created_at DESC LIMIT 20`,
    [req.params.id]
  );
  res.json(r.rows);
});

// Old OpenAI Realtime path kept as a fallback while LiveKit migration stabilises.
app.post('/api/cases/:id/voice-token', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, title, page_count, status, gemini_store_name
         FROM cases WHERE id=$1`, [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'case not found' });
    const c = r.rows[0];
    if (c.status === 'processing' || c.status === 'failed') {
      return res.status(409).json({ error: `case status is ${c.status}` });
    }
    if (!c.gemini_store_name) {
      return res.status(409).json({ error: 'case not indexed in file search yet' });
    }
    const systemPrompt = buildRealtimeSystemPrompt(c.title, c.page_count);
    const { token, model } = await openai.createEphemeralToken(systemPrompt);
    res.json({ token, model, caseId: c.id, caseTitle: c.title, pageCount: c.page_count });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Layer 1+3+4+5+6 — the strict search tool that Realtime calls every turn.
app.post('/api/cases/:id/search', async (req, res) => {
  try {
    const query = (req.body && req.body.query || '').toString().trim().slice(0, 800);
    if (!query) return res.status(400).json({ error: 'query required' });
    // Fetch ocr_markdown + page_map so we can re-anchor page numbers to
    // Datalab's authoritative page mapping AND translate to printed pages.
    const r = await pool.query(
      `SELECT gemini_store_name, ocr_markdown, page_map FROM cases WHERE id=$1`,
      [req.params.id]
    );
    if (!r.rows.length || !r.rows[0].gemini_store_name) {
      return res.status(404).json({ error: 'no store for case' });
    }
    const result = await gemini.searchForRealtime(
      r.rows[0].gemini_store_name,
      query,
      r.rows[0].ocr_markdown,   // page repair (PDF pages)
      r.rows[0].page_map        // PDF page -> printed page translation
    );
    res.json(result);
  } catch (e) {
    console.error('search error', e);
    const lang = await gemini.detectLanguage(req.body?.query || '').catch(() => 'en');
    res.json({ snippets: [], refusal: REFUSAL_BY_LANG[lang] || REFUSAL_BY_LANG.en });
  }
});

// Layer 7 — server-side detection (frontend uses this to decide a soft warning).
app.post('/api/check-phrases', (req, res) => {
  const txt = String(req.body?.text || '').toLowerCase();
  const hits = FORBIDDEN_PHRASES.filter(p => txt.includes(p));
  res.json({ hits });
});

// Layer 8 — verifier turn.
app.post('/api/cases/:id/verify', async (req, res) => {
  try {
    const draft = String(req.body?.draft || '').trim();
    const snippets = Array.isArray(req.body?.snippets) ? req.body.snippets : [];
    if (!draft) return res.status(400).json({ error: 'draft required' });
    const verdict = await gemini.verifyClaims(snippets, draft);
    res.json(verdict);
  } catch (e) {
    console.error('verify error', e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// SSE helpers
// ─────────────────────────────────────────────────────────────────────

function openSSE(req, res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'   // disable proxy buffering (nginx/render)
  });
  res.flushHeaders?.();
  // Keep-alive ping every 25s so proxies don't drop the connection
  const ping = setInterval(() => res.write(`: ping\n\n`), 25_000);
  req.on('close', () => clearInterval(ping));
  return {
    send(event, data) {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    },
    end() { clearInterval(ping); res.end(); }
  };
}

// Live SSE for case-file EXTRACTION progress (v2 orchestrator).
// Streams: extraction_started → segmenting → datalab_segments →
// (optional deepseek_segmentation_fallback) → per_segment_extraction →
// segment_started/extracted/gapfilled/atoms_verified/done per segment →
// rollup_local_done → party_graph_done → timeline_done → causation_done →
// audit_done → brief_done → extraction_done.
app.get('/api/cases/:id/extraction/stream', (req, res) => {
  const topic = `extract:${req.params.id}`;
  const sse = openSSE(req, res);
  let closed = false;
  const cleanup = bus.subscribe(topic, (entry) => {
    if (closed) return;
    sse.send(entry.event, entry.data);
    if (entry.event === 'extraction_done' || entry.event === 'extraction_failed') {
      closed = true;
      setTimeout(() => { cleanup(); sse.end(); }, 100);
    }
  });
  req.on('close', () => { closed = true; cleanup(); });
});

// Spot legal issues — feeds extracted data to DeepSeek as senior advocate.
// POST /api/cases/:id/spot-issues  (writes to cases.legal_issues, returns JSON)
// GET  /api/cases/:id/legal-issues (reads stored issues, idempotent)
app.post('/api/cases/:id/spot-issues', async (req, res) => {
  try {
    const out = await issueSpotter.spotIssues({ pool, caseId: req.params.id });
    res.json(out);
  } catch (e) {
    console.error('spot-issues error', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/cases/:id/legal-issues', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT legal_issues FROM cases WHERE id=$1`, [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    res.json(r.rows[0].legal_issues || null);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Drafting experiment — template + DeepSeek fill, returns court-ready
// markdown. POST /api/cases/:id/draft-experiment   (template_name optional)
app.post('/api/cases/:id/draft-experiment', async (req, res) => {
  try {
    const out = await draftExperiment.runExperiment({
      pool, caseId: req.params.id,
      templateName: req.body?.template_name || 'written_arguments_o6r17'
    });
    res.json(out);
  } catch (e) {
    console.error('draft-experiment error', e);
    res.status(500).json({ error: e.message });
  }
});

// Read all segments + rollup for a case.
app.get('/api/cases/:id/segments', async (req, res) => {
  try {
    const segs = await pool.query(
      `SELECT id, segment_index, segment_name, segment_type,
              page_start, page_end, confidence,
              facts, other_atoms, classification_source, created_at
         FROM case_segments
        WHERE case_id=$1
        ORDER BY segment_index ASC`,
      [req.params.id]
    );
    const c = await pool.query(`SELECT rollup, extraction_v FROM cases WHERE id=$1`, [req.params.id]);
    res.json({
      segments: segs.rows,
      rollup: c.rows[0]?.rollup || null,
      extraction_v: c.rows[0]?.extraction_v || 1
    });
  } catch (e) {
    console.error('segments fetch error', e);
    res.status(500).json({ error: e.message });
  }
});

// Live SSE stream for a research job. Streams the full event sequence
// (with replay for late subscribers) and closes after 'done' or 'failed'.
app.get('/api/cases/:id/research/:jobId/stream', (req, res) => {
  const topic = `research:${req.params.jobId}`;
  const sse = openSSE(req, res);
  let closed = false;
  const cleanup = bus.subscribe(topic, (entry) => {
    if (closed) return;
    sse.send(entry.event, entry.data);
    if (entry.event === 'done' || entry.event === 'failed') {
      closed = true;
      setTimeout(() => { cleanup(); sse.end(); }, 50);
    }
  });
  req.on('close', () => { closed = true; cleanup(); });
});

// ─────────────────────────────────────────────────────────────────────
// Conversation log + text chat
// ─────────────────────────────────────────────────────────────────────

// Get the full thread for a case (voice + text combined).
app.get('/api/cases/:id/messages', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, role, content, meta, created_at
         FROM conversation_messages
        WHERE case_id=$1
        ORDER BY created_at ASC, id ASC
        LIMIT 500`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (e) {
    console.error('messages list error', e);
    res.status(500).json({ error: e.message });
  }
});

// Public append endpoint — used by the frontend when LiveKit's
// TranscriptionReceived fires (so voice turns land in the same log).
app.post('/api/cases/:id/messages', async (req, res) => {
  try {
    const role = String(req.body?.role || '').trim();
    const content = String(req.body?.content || '').trim();
    const meta = req.body?.meta || null;
    if (!['user', 'assistant', 'tool'].includes(role)) {
      return res.status(400).json({ error: 'invalid role' });
    }
    if (!content) return res.status(400).json({ error: 'content required' });
    const row = await appendMessage(req.params.id, role, content, meta);
    res.json(row);
  } catch (e) {
    console.error('append message error', e);
    res.status(500).json({ error: e.message });
  }
});

// Append a message (used by voice agent post-turn AND by text endpoint).
async function appendMessage(caseId, role, content, meta = null) {
  const r = await pool.query(
    `INSERT INTO conversation_messages (case_id, role, content, meta)
     VALUES ($1, $2, $3, $4)
     RETURNING id, role, content, meta, created_at`,
    [caseId, role, content, meta]
  );
  return r.rows[0];
}

// Text agent — streaming SSE response.
//   POST /api/cases/:id/chat   body: { message: "..." }
// Streams events: user_saved, tool_call, tool_result, final, saved, done
app.post('/api/cases/:id/chat', async (req, res) => {
  const caseId = req.params.id;
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'message required' });

  const turnId = `${Date.now().toString(36)}`;
  const topic = `chat:${caseId}:${turnId}`;
  const sse = openSSE(req, res);
  const emit = (event, data) => {
    bus.emit(topic, event, data);
    sse.send(event, data);
  };

  try {
    // Persist user turn
    const userMsg = await appendMessage(caseId, 'user', message, { source: 'text' });
    emit('user_saved', userMsg);

    // Load recent history (last 20 turns) for multi-turn coherence
    const hr = await pool.query(
      `SELECT role, content FROM conversation_messages
        WHERE case_id=$1 AND role IN ('user','assistant')
        ORDER BY created_at DESC, id DESC LIMIT 20`,
      [caseId]
    );
    const history = hr.rows.reverse().slice(0, -1);   // drop the user msg we just inserted

    const { text, tool_calls } = await textAgent.runTurn({
      pool, caseId, userText: message, history, emit
    });

    const assistantMsg = await appendMessage(
      caseId, 'assistant', text, { source: 'text', tool_calls }
    );
    emit('saved', assistantMsg);
    emit('done', { ok: true });
  } catch (e) {
    console.error('chat error', e);
    emit('failed', { error: e.message });
  } finally {
    sse.end();
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`INDIALEGAL.AI strict-mode listening on ${PORT}`));
