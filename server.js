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

  // Stage 2 — Run in PARALLEL: Datalab structured extraction (atomic facts)
  // and Gemini File Search upload+indexing (semantic search). Independent
  // failures are fine. Voice readiness ('ready' status) tracks Gemini only.
  const extractTask = (async () => {
    try {
      await pool.query(
        `UPDATE cases SET facts_status='extracting', updated_at=NOW() WHERE id=$1`,
        [caseId]
      );
      const { checkUrl: extractUrl } = await datalab.submitExtract(buffer, filename);
      await pool.query(
        `UPDATE cases SET extract_check_url=$1, updated_at=NOW() WHERE id=$2`,
        [extractUrl, caseId]
      );
      const extractResult = await datalab.pollUntilDone(extractUrl);
      const facts = datalab.parseExtractResult(extractResult);
      await pool.query(
        `UPDATE cases SET facts=$1, facts_status='done', updated_at=NOW() WHERE id=$2`,
        [facts, caseId]
      );
    } catch (e) {
      console.warn(`[case ${caseId}] datalab extract failed:`, e.message);
      await pool.query(
        `UPDATE cases SET facts_status='failed', updated_at=NOW() WHERE id=$1`,
        [caseId]
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
    ? `WHERE kind = $1` : '';
  const params = kind === 'document' || kind === 'standalone_research'
    ? [kind] : [];
  const r = await pool.query(
    `SELECT id, title, filename, kind, status, page_count, token_estimate,
            facts_status,
            gemini_store_name IS NOT NULL AS has_store,
            facts IS NOT NULL AS has_facts,
            created_at
       FROM cases ${where} ORDER BY created_at DESC LIMIT 50`,
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

app.get('/api/cases/:id/research', async (req, res) => {
  const r = await pool.query(
    `SELECT id, plan, status, summary, created_at,
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`INDIALEGAL.AI strict-mode listening on ${PORT}`));
