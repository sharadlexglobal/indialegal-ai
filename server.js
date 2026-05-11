require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const { Pool } = require('pg');

const { AccessToken } = require('livekit-server-sdk');
const datalab = require('./services/datalab');
const openai = require('./services/openai');
const gemini = require('./services/gemini');
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
  const tokenEstimate = Math.ceil(flat.length / 4);
  await pool.query(
    `UPDATE cases SET ocr_json=$1, ocr_markdown=$2, page_count=$3,
       token_estimate=$4, status='ocr_done', updated_at=NOW() WHERE id=$5`,
    [result.json || null, flat, result.page_count || null, tokenEstimate, caseId]
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

app.get('/api/cases', async (_req, res) => {
  const r = await pool.query(
    `SELECT id, title, filename, status, page_count, token_estimate,
            facts_status,
            gemini_store_name IS NOT NULL AS has_store,
            facts IS NOT NULL AS has_facts,
            created_at
       FROM cases ORDER BY created_at DESC LIMIT 50`
  );
  res.json(r.rows);
});

app.get('/api/cases/:id', async (req, res) => {
  const r = await pool.query(
    `SELECT id, title, filename, status, page_count, token_estimate,
            gemini_store_name, facts, facts_status, error, created_at
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
    // Fetch ocr_markdown too so Gemini search can re-anchor page numbers to
    // Datalab's authoritative page mapping (page repair).
    const r = await pool.query(
      `SELECT gemini_store_name, ocr_markdown FROM cases WHERE id=$1`,
      [req.params.id]
    );
    if (!r.rows.length || !r.rows[0].gemini_store_name) {
      return res.status(404).json({ error: 'no store for case' });
    }
    const result = await gemini.searchForRealtime(
      r.rows[0].gemini_store_name,
      query,
      r.rows[0].ocr_markdown   // for page repair
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
