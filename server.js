require('dotenv').config();
const express = require('express');
const multer = require('multer');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
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
const r2 = require('./services/r2');
const mistralOcr = require('./services/mistralOcr');
const timelineSvc = require('./services/timeline');
const {
  buildRealtimeSystemPrompt,
  FORBIDDEN_PHRASES,
  REFUSAL_BY_LANG
} = require('./prompts');

const app = express();

// ─── Behind Render's reverse proxy ─────────────────────────────
// Trust the first proxy hop so req.ip resolves to the real client IP
// (not Render's internal load-balancer IP). Without this, rate-limit
// would see every request as coming from one IP and would either
// flag all traffic or let none through.
app.set('trust proxy', 1);

// ─── Security headers ──────────────────────────────────────────
// Helmet sets 15+ HTTP security headers in one go: X-Frame-Options,
// X-Content-Type-Options, Strict-Transport-Security, X-DNS-Prefetch-
// Control, Referrer-Policy, etc. CSP relaxed to allow inline scripts
// + Google Fonts (used by wizard.css) + the LiveKit CDN.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      styleSrc:  ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:   ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc:    ["'self'", "data:", "https:"],
      connectSrc:["'self'", "wss:", "https:"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false,   // allow Google Fonts woff2 cross-origin
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// ─── CORS lockdown ─────────────────────────────────────────────
// Only allow same-origin + production domains. Third-party sites
// can't call our API from JavaScript.
const ALLOWED_ORIGINS = [
  'https://indialegal-ai.onrender.com',
  'https://indialegal.ai',
  'https://www.indialegal.ai'
];
app.use(cors({
  origin: (origin, cb) => {
    // Same-origin (no Origin header) is always fine.
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin) || /\.onrender\.com$/.test(new URL(origin).hostname)) {
      return cb(null, true);
    }
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

app.use(cookieParser());

// ─── Rate limiting ─────────────────────────────────────────────
// Per-IP throttles. Tightest on expensive routes (LLM-heavy or
// external API hops); generous on reads.
function makeLimiter({ windowMs, max, message }) {
  return rateLimit({
    windowMs, max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: message || 'Too many requests. Please try again later.' },
    skip: (req) => req.method === 'OPTIONS'
  });
}

const limitUpload = makeLimiter({
  windowMs: 60 * 1000, max: 5,
  message: 'Too many uploads. Please wait a minute and try again.'
});
const limitDraft = makeLimiter({
  windowMs: 60 * 60 * 1000, max: 2,
  message: 'Drafting is computationally expensive. Try again in an hour.'
});
const limitCnr = makeLimiter({
  windowMs: 60 * 60 * 1000, max: 10,
  message: 'Too many CNR lookups. Please wait a while.'
});
const limitGeneric = makeLimiter({
  windowMs: 60 * 1000, max: 60
});
const limitProcessFromCnr = makeLimiter({
  windowMs: 60 * 60 * 1000, max: 5,
  message: 'Too many process-from-CNR jobs. Please wait.'
});

// ─── Anonymous-cookie session ──────────────────────────────────
// Every visitor gets an opaque cookie identifier. Useful for future
// analytics / per-session draft history. No usage limits — legal
// documentation legitimately needs millions of tokens per case, and
// rate-limiting on routes is enough abuse protection.
function ensureSession(req, res, next) {
  let sid = req.cookies.sid;
  if (!sid || !/^[a-f0-9]{32}$/.test(sid)) {
    sid = crypto.randomBytes(16).toString('hex');
    res.cookie('sid', sid, {
      httpOnly: true, sameSite: 'lax', secure: true,
      maxAge: 365 * 24 * 60 * 60 * 1000
    });
  }
  req.sid = sid;
  next();
}

// Multer — disk-storage + 200 GB ceiling so multer itself NEVER rejects
// based on size. Files stream to /tmp and we read them off disk in the
// route handler. Memory footprint stays bounded regardless of upload size.
//   NB: downstream Datalab caps at ~199 MB per submission. Files larger
//   than that still need chunking, but multer is no longer the bottleneck.
const UPLOAD_DIR = path.join(os.tmpdir(), 'indialegal-uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const safe = String(file.originalname || 'upload.pdf')
        .replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`);
    }
  }),
  limits: {
    fileSize: 200 * 1024 * 1024 * 1024,   // 200 GB — multer hard ceiling
    files: 1,
    fields: 20
  }
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(express.json({ limit: '20mb' }));

// Issue / refresh anonymous session cookie for every API request.
// Static assets bypass it for performance.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return ensureSession(req, res, next);
  next();
});

// Generic per-IP throttle on all /api endpoints (60/min). Route-specific
// limiters layered below for expensive routes.
app.use('/api/', limitGeneric);

// Force no-cache on the entry HTML so version-bumped assets are
// always picked up. Static assets (with their own ?v= cache buster)
// are served normally below.

// New homepage — user-facing wizard
app.get(['/', '/index.html'], (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Legacy dashboard — moved to /admin
app.get(['/admin', '/admin.html'], (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Input validation schemas (zod) ────────────────────────────
// Validate at API boundary. Reject early with 400 instead of letting
// bad data reach DB / external APIs.
const cnrSchema = z.object({
  cnr: z.string().regex(/^[A-Z]{2}[A-Z0-9]{14}$/, 'CNR must be 16 chars [A-Z0-9]')
});
const titleSchema = z.string().trim().min(1).max(200);
const newResearchSchema = z.object({
  title: titleSchema.optional()
});

function validateBody(schema) {
  return (req, res, next) => {
    const r = schema.safeParse(req.body || {});
    if (!r.success) {
      return res.status(400).json({
        error: 'Invalid input',
        details: r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`)
      });
    }
    req.body = r.data;
    next();
  };
}

// ─── PDF magic-byte sniff ──────────────────────────────────────
// Real PDFs start with %PDF- (bytes 25 50 44 46 2D). Reject fake .pdf
// renames before they reach Datalab.
function looksLikePdf(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(5);
    fs.readSync(fd, buf, 0, 5, 0);
    fs.closeSync(fd);
    return buf.toString('ascii') === '%PDF-';
  } catch { return false; }
}

// ─── CNR fetch — proxies to bail-watch manager ──────────────────
// Submits CNR to bail-watch fan-out, polls until ready, returns
// the parsed case.json + manifest summary. The bail-watch system
// (separate service on Render Singapore) handles eCourts captcha,
// extraction, and stores the result in Cloudflare R2.
const BAILWATCH_BASE = process.env.BAILWATCH_BASE || 'https://bail-watch-app.onrender.com';

// In-memory map of cnrFetch job state. Keys are jobIds; values track
// status + final case data so the frontend can poll while bail-watch
// scrapes eCourts. Render edge proxy has ~100s response-start timeout,
// so we MUST return immediately and let the frontend poll.
const CNR_FETCH_TOPIC = (jobId) => `cnr-fetch:${jobId}`;
const cnrFetchJobs = new Map();   // jobId → { status, cnr, slug, data?, error?, startedAt }

function getOrCreateCnrFetchJob(jobId) {
  let j = cnrFetchJobs.get(jobId);
  if (!j) {
    j = { status: 'pending', startedAt: Date.now() };
    cnrFetchJobs.set(jobId, j);
  }
  return j;
}

// Submit a CNR fetch job. Returns { jobId } instantly. Frontend opens
// the SSE stream below for live progress + final data.
app.post('/api/cnr-fetch', limitCnr, validateBody(cnrSchema), async (req, res) => {
  const cnr = String(req.body?.cnr || '').trim().toUpperCase();
  if (!/^[A-Z]{2}[A-Z0-9]{14}$/.test(cnr)) {
    return res.status(400).json({ error: 'Invalid CNR format' });
  }
  const jobId = crypto.randomBytes(12).toString('hex');
  const slug = inferSlugFromCnr(cnr);

  const job = getOrCreateCnrFetchJob(jobId);
  job.cnr = cnr; job.slug = slug; job.status = 'pending';

  // Respond IMMEDIATELY so Render edge doesn't time us out.
  res.json({ jobId, cnr, slug, status: 'pending' });

  // Background — emits events to topic; the final data sits in job.data.
  const topic = CNR_FETCH_TOPIC(jobId);
  const emit = (event, data = {}) => bus.emit(topic, event, data);

  (async () => {
    try {
      emit('looking_up', { cnr });

      // Cache hit?
      const cached = await tryFetchCaseJson(slug, cnr);
      if (cached) {
        const data = normaliseCaseJson(cached, cnr);
        job.status = 'ready';
        job.data = data;
        emit('case_ready', data);
        return;
      }

      // Submit a fresh fan-out
      emit('submitting_to_ecourts', {});
      const submitR = await fetch(`${BAILWATCH_BASE}/api/fetch-cnrs/fanout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseType: 'unknown', slug, cnrs: [cnr] })
      });
      if (!submitR.ok) {
        const t = await submitR.text().catch(() => '');
        job.status = 'failed';
        job.error = 'eCourts submit failed: ' + t.slice(0, 200);
        emit('failed', { error: job.error });
        return;
      }

      emit('scraping', {});

      // Poll for completion — try up to 5 minutes
      const deadline = Date.now() + 5 * 60 * 1000;
      let attempt = 0;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 5000));
        attempt++;
        emit('polling', { attempt, elapsed_s: Math.round((Date.now() - job.startedAt) / 1000) });
        const got = await tryFetchCaseJson(slug, cnr);
        if (got) {
          const data = normaliseCaseJson(got, cnr);
          job.status = 'ready';
          job.data = data;
          emit('case_ready', data);
          return;
        }
      }
      job.status = 'timeout';
      job.error = 'Timed out waiting for eCourts (5 min). The case may still arrive — please retry in a minute.';
      emit('timeout', { error: job.error });
    } catch (e) {
      job.status = 'failed';
      job.error = e.message;
      emit('failed', { error: e.message });
    }
  })();

  // Cleanup old jobs every now and then so the Map doesn't grow forever
  if (cnrFetchJobs.size > 200) {
    const now = Date.now();
    for (const [k, v] of cnrFetchJobs) {
      if (now - v.startedAt > 30 * 60 * 1000) cnrFetchJobs.delete(k);
    }
  }
});

// SSE stream for cnr-fetch job progress. If the job is already complete,
// emits the final state immediately (so a late connector still gets the
// data) then closes.
app.get('/api/cnr-fetch/:jobId/stream', (req, res) => {
  const jobId = req.params.jobId;
  const job = cnrFetchJobs.get(jobId);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Replay terminal state if already done
  if (job && job.status === 'ready') {
    send('case_ready', job.data);
    res.end();
    return;
  }
  if (job && (job.status === 'failed' || job.status === 'timeout')) {
    send(job.status === 'timeout' ? 'timeout' : 'failed', { error: job.error });
    res.end();
    return;
  }
  if (!job) {
    send('failed', { error: 'Unknown jobId. The job may have expired — please retry.' });
    res.end();
    return;
  }

  const topic = CNR_FETCH_TOPIC(jobId);
  const onEvt = (event, data) => send(event, data);
  bus.on(topic, onEvt);

  const hb = setInterval(() => res.write(':hb\n\n'), 20000);
  req.on('close', () => { clearInterval(hb); bus.off(topic, onEvt); });
});

// Convenience JSON poll endpoint — for clients that prefer poll over SSE.
app.get('/api/cnr-fetch/:jobId', (req, res) => {
  const job = cnrFetchJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown jobId' });
  res.json({
    status: job.status,
    cnr: job.cnr, slug: job.slug,
    data: job.data || null,
    error: job.error || null,
    elapsed_s: Math.round((Date.now() - job.startedAt) / 1000)
  });
});

function inferSlugFromCnr(cnr) {
  // Without case-type knowledge, default to a generic slug. bail-watch
  // accepts any slug — the case-type is recorded in case.json itself.
  return 'generic';
}

async function tryFetchCaseJson(slug, cnr) {
  try {
    const r = await fetch(`${BAILWATCH_BASE}/api/cases/${slug}/${cnr}`);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function normaliseCaseJson(raw, cnr) {
  // bail-watch returns the saved case.json shape. Normalise to what
  // the front-end expects (title, court, judge, orderCount, lastHearing).
  const parties = raw.parties || raw.partyDetails || {};
  const petitioner = parties.petitioner || parties.plaintiff || raw.petitioner || '';
  const respondent = parties.respondent || parties.defendant || raw.respondent || '';
  const title = raw.title || raw.caseTitle
                 || (petitioner && respondent ? `${petitioner} v. ${respondent}` : 'Untitled matter');
  return {
    cnr,
    title,
    caseNumber:  raw.caseNumber || raw.case_no || '',
    court:       raw.court || raw.establishment || '',
    judge:       raw.judge || raw.coram || '',
    orderCount:  (raw.orders || []).length || raw.orderCount || 0,
    lastHearing: raw.lastHearing || raw.lastListed || raw.lastHearingDate || '',
    raw          // keep raw payload for downstream use
  };
}

// ─── Process-from-CNR: kick off OCR + timeline build ────────────
// After the user confirms the CNR fetch, this endpoint:
//   1. Creates a `cases` row keyed to the CNR
//   2. Reads bail-watch's case.json + manifest from R2
//   3. Streams each order PDF from R2 → Mistral OCR → DeepSeek timeline-event extract
//   4. Emits live SSE events on `cnr-process:<caseId>` for the wizard
//   5. Returns { caseId } immediately; client polls SSE for progress
const PROCESS_TOPIC = (caseId) => `cnr-process:${caseId}`;

app.post('/api/case/from-cnr/:cnr/process', limitProcessFromCnr, async (req, res) => {
  try {
    const cnr = String(req.params.cnr || '').trim().toUpperCase();
    if (!/^[A-Z]{2}[A-Z0-9]{14}$/.test(cnr)) {
      return res.status(400).json({ error: 'Invalid CNR' });
    }
    const slug = String(req.body?.slug || 'generic');
    const titleHint = String(req.body?.title || '').slice(0, 200);

    // De-dupe — if we already have a row for this CNR, reuse it.
    let caseId;
    const existing = await pool.query(
      `SELECT id FROM cases WHERE cnr=$1 ORDER BY id DESC LIMIT 1`, [cnr]
    );
    if (existing.rows.length) {
      caseId = existing.rows[0].id;
      await pool.query(
        `UPDATE cases SET status='processing', updated_at=NOW() WHERE id=$1`,
        [caseId]
      );
    } else {
      const ins = await pool.query(
        `INSERT INTO cases (title, filename, status, kind, cnr, bail_watch_slug)
         VALUES ($1, $2, 'processing', 'cnr', $3, $4) RETURNING id`,
        [titleHint || `Case ${cnr}`, '', cnr, slug]
      );
      caseId = ins.rows[0].id;
    }

    // Respond now; do the heavy work async
    res.json({ caseId, status: 'processing' });

    // ── Background work ──────────────────────────────────────
    const topic = PROCESS_TOPIC(caseId);
    const emit = (event, data = {}) => bus.emit(topic, event, data);

    (async () => {
      try {
        emit('started', { cnr, slug });

        // Pull case.json from R2 (bail-watch's record)
        emit('fetch_case_json', {});
        const caseJson = await r2.getCaseJson(slug, cnr);
        if (caseJson) {
          await pool.query(
            `UPDATE cases SET case_json=$1, updated_at=NOW() WHERE id=$2`,
            [caseJson, caseId]
          );
        }

        // Determine list of order PDFs
        emit('fetch_manifest', {});
        const manifest = await r2.getCaseManifest(slug, cnr);
        const orders = (manifest?.orders || caseJson?.orders || [])
          .map((o, i) => ({
            order_index: o.orderNo || o.index || i + 1,
            order_date: o.orderDate || o.date || '',
            order_type: o.type || o.section || 'order',
            r2_key:     o.key || `case-types/${slug}/${cnr}/order-${o.orderNo || i + 1}.pdf`,
            bytes:      o.bytes
          }));
        emit('orders_listed', { count: orders.length, orders });

        if (!orders.length) {
          emit('no_orders', {});
          await pool.query(
            `UPDATE cases SET status='ready', updated_at=NOW() WHERE id=$1`,
            [caseId]
          );
          emit('done', { events: 0 });
          return;
        }

        // Insert pending rows for each order
        for (const o of orders) {
          await pool.query(
            `INSERT INTO case_orders
               (case_id, order_index, r2_key, order_date, order_type, bytes, ocr_status)
             VALUES ($1, $2, $3, $4, $5, $6, 'pending')
             ON CONFLICT DO NOTHING`,
            [caseId, o.order_index, o.r2_key, o.order_date, o.order_type, o.bytes || null]
          );
        }

        // Fetch all PDF buffers from R2 (concurrency 4)
        emit('fetching_pdfs', { count: orders.length });
        const buffers = await fetchAllPdfs(orders, (done, total) => {
          emit('fetch_progress', { done, total });
        });

        // Mistral OCR all in parallel (concurrency 3)
        emit('ocr_starting', { count: buffers.length });
        const ocrItems = buffers.map(b => ({
          buffer: b.buffer, key: b.order.r2_key,
          label: `order-${b.order.order_index}`,
          orderIndex: b.order.order_index, orderDate: b.order.order_date
        }));
        const ocrResults = await mistralOcr.ocrBatch(ocrItems, {
          concurrency: 3,
          onProgress: ({ completed, total }) => {
            emit('ocr_progress', { completed, total });
          }
        });

        // Persist OCR text, kick off timeline extract per order
        const allEventLists = [];
        for (let i = 0; i < ocrResults.length; i++) {
          const r = ocrResults[i];
          const order = orders[i];
          if (!r.ok) {
            await pool.query(
              `UPDATE case_orders SET ocr_status='failed', ocr_error=$1, updated_at=NOW()
               WHERE case_id=$2 AND order_index=$3`,
              [r.error.slice(0, 500), caseId, order.order_index]
            );
            emit('ocr_failed', { order_index: order.order_index, error: r.error });
            continue;
          }
          const full = r.result.full_text;
          await pool.query(
            `UPDATE case_orders SET full_text=$1, page_count=$2, ocr_status='ocr_done', updated_at=NOW()
             WHERE case_id=$3 AND order_index=$4`,
            [full, (r.result.pages || []).length, caseId, order.order_index]
          );
          emit('ocr_done', { order_index: order.order_index, chars: full.length });

          // Timeline extraction for this order — kick off, don't await all
          try {
            const evs = await timelineSvc.extractEventsFromOrder({
              orderIndex: order.order_index,
              orderDate: order.order_date,
              orderText: full
            });
            allEventLists.push(evs);
            await pool.query(
              `UPDATE case_orders SET events=$1, ocr_status='timeline_done', updated_at=NOW()
               WHERE case_id=$2 AND order_index=$3`,
              [JSON.stringify(evs), caseId, order.order_index]
            );
            emit('timeline_progress', {
              order_index: order.order_index, events_added: evs.length
            });
          } catch (e) {
            console.warn(`[cnr-process ${caseId}] timeline extract failed for order ${order.order_index}: ${e.message}`);
          }
        }

        // Merge + persist final timeline
        const seedEvents = caseJson ? timelineSvc.seedFromCaseJson(caseJson) : [];
        const merged = timelineSvc.mergeEvents(allEventLists, seedEvents);
        await pool.query(
          `UPDATE cases SET timeline=$1, status='ready', updated_at=NOW() WHERE id=$2`,
          [JSON.stringify(merged), caseId]
        );
        emit('timeline_complete', { events: merged });
        emit('done', { events: merged.length });
      } catch (e) {
        console.error(`[cnr-process ${caseId}] error`, e);
        const topic2 = PROCESS_TOPIC(caseId);
        bus.emit(topic2, 'error', { error: e.message });
        await pool.query(
          `UPDATE cases SET status='failed', error=$1, updated_at=NOW() WHERE id=$2`,
          [String(e.message || e).slice(0, 1000), caseId]
        ).catch(() => {});
      }
    })().catch(e => console.error(`[cnr-process ${caseId}] uncaught`, e));
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// Helper — sequentially get PDF buffers with concurrency 4
async function fetchAllPdfs(orders, onProgress) {
  const out = new Array(orders.length);
  const CONCURRENCY = 4;
  let idx = 0, done = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (idx < orders.length) {
      const myIdx = idx++;
      const order = orders[myIdx];
      try {
        const { buffer } = await r2.getObjectBuffer(order.r2_key);
        out[myIdx] = { order, buffer };
      } catch (e) {
        out[myIdx] = { order, error: e.message };
      }
      done++;
      if (onProgress) onProgress(done, orders.length);
    }
  }));
  return out.filter(x => x?.buffer);
}

// SSE stream for the CNR-process progress
app.get('/api/case/:id/cnr-process/stream', (req, res) => {
  const topic = PROCESS_TOPIC(req.params.id);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const onEvt = (event, data) => send(event, data);
  bus.on(topic, onEvt);
  // Heartbeat to keep the connection alive through Render's proxy
  const hb = setInterval(() => res.write(':hb\n\n'), 20000);
  req.on('close', () => { clearInterval(hb); bus.off(topic, onEvt); });
});

// Fetch the saved case state — used by frontend after SSE done
app.get('/api/case/:id/full', async (req, res) => {
  try {
    const idCheck = z.coerce.number().int().positive().safeParse(req.params.id);
    if (!idCheck.success) return res.status(400).json({ error: 'Invalid id' });
    const caseId = idCheck.data;
    const c = await pool.query(
      `SELECT id, title, cnr, status, case_json, timeline, created_at, updated_at
         FROM cases WHERE id=$1`, [caseId]);
    if (!c.rows.length) return res.status(404).json({ error: 'Case not found' });
    const orders = await pool.query(
      `SELECT order_index, order_date, order_type, r2_key, summary,
              ocr_status, page_count, bytes, events
         FROM case_orders WHERE case_id=$1 ORDER BY order_index ASC`,
      [caseId]);
    res.json({ ...c.rows[0], orders: orders.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Stream/redirect an order PDF — uses presigned R2 URL so the
// browser fetches from Cloudflare directly (saves our bandwidth).
app.get('/api/case/:id/order/:n/pdf', async (req, res) => {
  try {
    const idCheck = z.coerce.number().int().positive().safeParse(req.params.id);
    const nCheck = z.coerce.number().int().positive().safeParse(req.params.n);
    if (!idCheck.success || !nCheck.success) return res.status(400).end();
    const r = await pool.query(
      `SELECT r2_key FROM case_orders WHERE case_id=$1 AND order_index=$2`,
      [idCheck.data, nCheck.data]);
    if (!r.rows.length) return res.status(404).end();
    const url = await r2.presignDownloadUrl(r.rows[0].r2_key, { expiresIn: 600 });
    res.redirect(url);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', async (_req, res) => {
  try {
    const r = await pool.query('SELECT 1 as ok');
    res.json({ ok: true, db: r.rows[0].ok === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/cases', limitUpload, upload.single('pdf'), async (req, res) => {
  // With disk-storage multer, req.file is { path, originalname, size, mimetype, ... }
  // — buffer is NOT populated. We read the file lazily into a Buffer below.
  let uploadedPath = null;
  try {
    if (!req.file) return res.status(400).json({ error: 'pdf file required' });
    uploadedPath = req.file.path;

    // MIME + magic-byte check — reject fake .pdf renames
    if (req.file.mimetype && req.file.mimetype !== 'application/pdf' &&
        req.file.mimetype !== 'application/octet-stream') {
      fs.unlink(uploadedPath, () => {});
      return res.status(415).json({ error: 'Only PDF files are accepted.' });
    }
    if (!looksLikePdf(uploadedPath)) {
      fs.unlink(uploadedPath, () => {});
      return res.status(415).json({
        error: 'File does not appear to be a valid PDF (header check failed).'
      });
    }

    const rawTitle = String(req.body.title || req.file.originalname || 'Untitled');
    const titleCheck = titleSchema.safeParse(rawTitle);
    if (!titleCheck.success) {
      fs.unlink(uploadedPath, () => {});
      return res.status(400).json({ error: 'Invalid title' });
    }
    const title = titleCheck.data;
    const ins = await pool.query(
      `INSERT INTO cases (title, filename, status) VALUES ($1, $2, 'processing') RETURNING id`,
      [title, req.file.originalname]
    );
    const caseId = ins.rows[0].id;
    const originalname = req.file.originalname;
    const fileSize = req.file.size;

    // Respond immediately; processing happens async.
    res.json({ id: caseId, status: 'processing', sizeBytes: fileSize });

    // ── Async processing — read file from disk, process, cleanup ──
    // NB: readFileSync on truly massive files (>1 GB) will pressure RAM.
    // Downstream Datalab caps at ~199 MB anyway. Chunking layer (planned)
    // will replace this read with a streaming chunker.
    (async () => {
      try {
        const buffer = fs.readFileSync(uploadedPath);
        await processCase(caseId, buffer, originalname, title);
      } catch (e) {
        console.error(`[case ${caseId}] processing failed`, e);
        await pool.query(
          `UPDATE cases SET status='failed', error=$1, updated_at=NOW() WHERE id=$2`,
          [String(e.message || e).slice(0, 1000), caseId]
        ).catch(() => {});
      } finally {
        fs.unlink(uploadedPath, () => {});  // best-effort cleanup
      }
    })();
  } catch (e) {
    console.error('upload route error:', e);
    if (uploadedPath) fs.unlink(uploadedPath, () => {});
    if (!res.headersSent) res.status(500).json({ error: e.message });
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
app.post('/api/research/new', validateBody(newResearchSchema), async (req, res) => {
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
app.post('/api/cases/:id/draft-experiment', limitDraft, async (req, res) => {
  try {
    const idCheck = z.coerce.number().int().positive().safeParse(req.params.id);
    if (!idCheck.success) return res.status(400).json({ error: 'Invalid case id' });
    const out = await draftExperiment.runExperiment({
      pool, caseId: idCheck.data,
      templateName: req.body?.template_name || 'written_arguments_o6r17'
    });

    // Auto-render the final markdown to a downloadable PDF via api2pdf.
    // If api2pdf fails (key missing, network), the response still includes
    // the markdown so the client can fall back to printing from the browser.
    if (out?.draftMarkdown && process.env.API2PDF_KEY) {
      try {
        const titleBase = req.body?.template_name || 'draft';
        const pdfMeta = await draftExperiment.renderPdfViaApi2Pdf({
          markdown: out.draftMarkdown,
          title: titleBase,
          filename: `${titleBase}-case-${idCheck.data}`
        });
        out.pdf = pdfMeta;
      } catch (e) {
        console.warn(`[draft ${idCheck.data}] api2pdf render failed:`, e.message);
        out.pdf = { error: e.message };
      }
    }

    res.json(out);
  } catch (e) {
    console.error('draft-experiment error', e);
    res.status(500).json({ error: e.message });
  }
});

// On-demand PDF render — for the case where frontend already holds the
// markdown (e.g. user clicks "Re-download PDF" without re-running the
// whole drafting pipeline).
app.post('/api/render-pdf', limitGeneric, async (req, res) => {
  try {
    const schema = z.object({
      markdown: z.string().min(50).max(2_000_000),
      title:    z.string().trim().min(1).max(200).optional(),
      filename: z.string().trim().min(1).max(120).optional()
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid input',
        details: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`)
      });
    }
    const meta = await draftExperiment.renderPdfViaApi2Pdf(parsed.data);
    res.json({ pdf: meta });
  } catch (e) {
    console.error('render-pdf error', e);
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
