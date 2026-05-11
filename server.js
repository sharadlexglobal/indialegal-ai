require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const { Pool } = require('pg');

const datalab = require('./services/datalab');
const openai = require('./services/openai');
const gemini = require('./services/gemini');
const { buildSystemPrompt, buildGeminiSystemPrompt } = require('./prompts');

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

// Upload PDF — kicks off async OCR + Gemini import. Returns case id.
app.post('/api/cases', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'pdf file required' });
    const title = (req.body.title || req.file.originalname || 'Untitled').trim().slice(0, 200);

    const ins = await pool.query(
      `INSERT INTO cases (title, filename, status) VALUES ($1, $2, 'processing') RETURNING id`,
      [title, req.file.originalname]
    );
    const caseId = ins.rows[0].id;

    // Fire & forget — process in background.
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
  // 1. Datalab — submit & poll
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

  // 2. Gemini File Search — best effort. Failure is non-fatal.
  try {
    const storeName = await gemini.createStore(`case-${caseId}-${title.slice(0, 40)}`);
    const { fileName } = await gemini.uploadAndImport(storeName, buffer, filename);
    await pool.query(
      `UPDATE cases SET gemini_store_name=$1, gemini_file_name=$2, status='ready', updated_at=NOW() WHERE id=$3`,
      [storeName, fileName, caseId]
    );
  } catch (e) {
    console.warn(`[case ${caseId}] gemini index skipped:`, e.message);
    await pool.query(
      `UPDATE cases SET status='ready', updated_at=NOW() WHERE id=$1`,
      [caseId]
    );
  }
}

app.get('/api/cases', async (_req, res) => {
  const r = await pool.query(
    `SELECT id, title, filename, status, page_count, token_estimate,
            created_at FROM cases ORDER BY created_at DESC LIMIT 50`
  );
  res.json(r.rows);
});

app.get('/api/cases/:id', async (req, res) => {
  const r = await pool.query(
    `SELECT id, title, filename, status, page_count, token_estimate,
            gemini_store_name, error, created_at FROM cases WHERE id=$1`,
    [req.params.id]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'not found' });
  res.json(r.rows[0]);
});

// Voice session — generate ephemeral OpenAI Realtime token with the case
// preloaded into the system prompt (which OpenAI's cache will keep warm
// for the rest of the session).
app.post('/api/cases/:id/voice-token', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, title, ocr_markdown, page_count, status FROM cases WHERE id=$1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'case not found' });
    const c = r.rows[0];
    if (c.status === 'processing' || c.status === 'failed') {
      return res.status(409).json({ error: `case status is ${c.status}` });
    }
    if (!c.ocr_markdown) return res.status(409).json({ error: 'OCR text missing' });

    const systemPrompt = buildSystemPrompt(c.title, c.ocr_markdown, c.page_count);
    const { token, model } = await openai.createEphemeralToken(systemPrompt);
    res.json({ token, model, caseTitle: c.title, pageCount: c.page_count });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Text-only grounded answer via Gemini File Search — used as fallback or quick lookup.
app.post('/api/cases/:id/ask', async (req, res) => {
  try {
    const q = (req.body && req.body.question || '').trim();
    if (!q) return res.status(400).json({ error: 'question required' });
    const r = await pool.query(
      `SELECT title, gemini_store_name FROM cases WHERE id=$1`,
      [req.params.id]
    );
    if (!r.rows.length || !r.rows[0].gemini_store_name) {
      return res.status(404).json({ error: 'no gemini store for this case' });
    }
    const sys = buildGeminiSystemPrompt(r.rows[0].title);
    const answer = await gemini.generateGroundedAnswer(r.rows[0].gemini_store_name, sys, q);
    res.json({ answer: answer.text });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`INDIALEGAL.AI listening on ${PORT}`));
