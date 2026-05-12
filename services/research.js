/**
 * Legal Research orchestrator.
 *
 * Flow:
 *   1. Voice agent calls /api/cases/:id/start-research with a structured scope
 *      after the user has approved its plan.
 *   2. We INSERT a research_jobs row, return jobId immediately.
 *   3. Background work:
 *        - IKAPI search_cases (multi-variant queries)
 *        - For top N tids → get_case_identity + get_case_document
 *        - Upload each judgment's text to the case's Gemini File Search store
 *          so future search_case_file calls will also surface them.
 *   4. Status + summary written back to the row, frontend polls /research/:jobId.
 */

const fetch = require('node-fetch');
const { Buffer } = require('buffer');
const gemini = require('./gemini');
const deepseek = require('./deepseek');

const IKAPI_MCP_URL = process.env.IKAPI_MCP_URL || 'https://ikapi.onrender.com/mcp';

// Benchmark-winning pipeline (top-3 = 7.06 vs baseline 1.14 = 6.2x quality):
//   1. DeepSeek decode user's natural query → clean keywords + exact court_code
//   2. IKAPI search with clean query, max_results = OVER_FETCH_N
//   3. DeepSeek scores all candidates (4-dimension relevance)
//   4. Sort by overall, keep top scope.max_results (default 5)
//   5. Existing logic: fetch full text, index in Gemini File Search
const OVER_FETCH_N = 20;            // benchmark sweet spot — fetch 20, keep N
const RERANK_SCORE_THRESHOLD = 4;   // drop candidates that score below this

async function ikapiCall(name, args, { timeoutMs = 60000 } = {}) {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args }
  };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(IKAPI_MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal
    });
    const json = await res.json();
    if (!res.ok || json.error) throw new Error(`IKAPI ${name}: ${JSON.stringify(json.error || json)}`);
    const text = json.result?.content?.[0]?.text || '';
    try { return JSON.parse(text); } catch { return { raw: text }; }
  } finally {
    clearTimeout(t);
  }
}

function buildScopeQueries(scope) {
  const seed = (scope?.keywords || scope?.query || '').toString().trim();
  if (!seed) return [];
  const sections = Array.isArray(scope?.sections) ? scope.sections : [];
  const queries = [seed];
  if (sections.length) queries.push(`${seed} ${sections.join(' ')}`);
  if (scope?.principle) queries.push(`${scope.principle} ${seed}`.trim());
  return [...new Set(queries)].slice(0, 3);
}

// Step 1 of winning pipeline — decode the agent's scope into a CLEAN search
// intent. If DeepSeek is unavailable we degrade gracefully to the agent's
// already-structured scope (the pre-Round-1 behaviour).
async function decodeIntent(scope) {
  const naturalish = [
    scope?.keywords || '',
    Array.isArray(scope?.sections) ? scope.sections.join(' ') : '',
    scope?.principle || ''
  ].filter(Boolean).join(' — ');
  if (!naturalish) return null;

  const decoded = await deepseek.decodeQuery(naturalish);
  if (!decoded) {
    // fall back: use agent's structured scope as-is
    const seed = `${scope.keywords || ''} ${(scope.sections || []).join(' ')}`.trim();
    return {
      statute: '', section: '',
      court_code: scope.doctype || 'judgments',
      stage: 'other',
      clean_keywords: seed,
      is_recent_query: false
    };
  }
  // honour explicit user-given court_code/dates over what DeepSeek inferred
  if (scope.doctype) decoded.court_code = scope.doctype;
  return decoded;
}

async function runResearch(pool, jobId) {
  const job = (await pool.query(
    `SELECT j.id, j.case_id, j.scope, c.gemini_store_name
       FROM research_jobs j JOIN cases c ON c.id = j.case_id
      WHERE j.id = $1`,
    [jobId]
  )).rows[0];
  if (!job) throw new Error(`research job ${jobId} not found`);
  if (!job.gemini_store_name) throw new Error(`case has no gemini store`);

  await pool.query(
    `UPDATE research_jobs SET status='running', updated_at=NOW() WHERE id=$1`,
    [jobId]
  );

  const scope = job.scope || {};
  const maxResults = Math.max(1, Math.min(scope.max_results ?? 5, 8));

  // ─── Step 1: DeepSeek decodes scope into clean intent ─────────────
  const intent = await decodeIntent(scope);
  if (!intent || !intent.clean_keywords) {
    await pool.query(
      `UPDATE research_jobs SET status='failed', error='could not decode scope', updated_at=NOW() WHERE id=$1`,
      [jobId]
    );
    return;
  }

  console.log(`[research ${jobId}] decoded intent:`, JSON.stringify(intent));

  // optional date / author / bench filters from agent scope
  const filters = {};
  if (scope.from_date) filters.fromdate = scope.from_date;
  if (scope.to_date) filters.todate = scope.to_date;
  if (scope.author) filters.author = scope.author;
  if (scope.bench) filters.bench = scope.bench;
  if (intent.is_recent_query) filters.sort = 'mostrecent';

  // ─── Step 2: IKAPI search — clean query, exact court, over-fetch 20 ──
  const ik_query = [intent.section ? `Section ${intent.section}` : '',
                    intent.statute || '',
                    intent.clean_keywords || ''].filter(Boolean).join(' ').trim();

  const searchRes = await ikapiCall('search_cases', {
    query: ik_query,
    doctype: intent.court_code || 'judgments',
    ...filters,
    max_results: OVER_FETCH_N
  }).catch(e => {
    console.warn(`[research ${jobId}] IKAPI search failed:`, e.message);
    return { results: [] };
  });

  const candidates = (searchRes?.results || []).slice(0, OVER_FETCH_N);
  if (!candidates.length) {
    await pool.query(
      `UPDATE research_jobs SET status='done', summary=$1, updated_at=NOW() WHERE id=$2`,
      ['No judgments found on Indian Kanoon for this query. Try refining the scope.', jobId]
    );
    return;
  }

  console.log(`[research ${jobId}] IKAPI returned ${candidates.length}, reranking with DeepSeek…`);

  // ─── Step 3: DeepSeek reranks all candidates in parallel ──────────
  const scored = await Promise.all(candidates.map(async (c) => {
    const s = await deepseek.scoreCandidate(intent, c);
    return {
      ...c,
      _score: s?.overall ?? 0,
      _verdict: s?.verdict || ''
    };
  }));

  // ─── Step 4: Keep top maxResults above threshold ──────────────────
  scored.sort((a, b) => (b._score || 0) - (a._score || 0));
  let judgments = scored
    .filter(s => (s._score || 0) >= RERANK_SCORE_THRESHOLD)
    .slice(0, maxResults)
    .map(s => ({
      tid: s.tid,
      title: s.title,
      court: s.court,
      date: s.date || s.judgment_date,
      citation: s.citation,
      cited_by: s.cited_by,
      query: ik_query,
      relevance_score: s._score,
      relevance_verdict: s._verdict,
      indexed: false
    }));

  // graceful fallback: if rerank drops everything below threshold,
  // still keep the top-3 so the user has something
  if (judgments.length === 0) {
    judgments = scored.slice(0, Math.min(3, scored.length)).map(s => ({
      tid: s.tid,
      title: s.title,
      court: s.court,
      date: s.date || s.judgment_date,
      citation: s.citation,
      cited_by: s.cited_by,
      query: ik_query,
      relevance_score: s._score,
      relevance_verdict: s._verdict + ' (below threshold but kept as fallback)',
      indexed: false
    }));
  }

  console.log(`[research ${jobId}] kept ${judgments.length}/${candidates.length} after rerank`);

  await pool.query(
    `UPDATE research_jobs SET judgments=$1, updated_at=NOW() WHERE id=$2`,
    [JSON.stringify(judgments), jobId]
  );

  // 2) Process all judgments IN PARALLEL — this is the biggest win.
  // pollIndexingComplete blocks for 30s-5min per judgment on Google's side.
  // Sequentially that is 5-15 minutes total; in parallel total time
  // ≈ max(individual times) ≈ 2-3 minutes.
  // Checkpoint to DB whenever any single judgment completes so the
  // frontend keeps seeing progress every few seconds.

  let dbWriteInFlight = Promise.resolve();
  function checkpoint() {
    dbWriteInFlight = pool.query(
      `UPDATE research_jobs SET judgments=$1, updated_at=NOW() WHERE id=$2`,
      [JSON.stringify(judgments), jobId]
    ).catch(e => console.warn(`[research ${jobId}] checkpoint failed:`, e.message));
  }

  async function processOne(j) {
    try {
      const doc = await ikapiCall('get_case_document', { tid: j.tid }, { timeoutMs: 120000 });
      const text = (doc?.text || doc?.body || doc?.raw || '').toString();
      if (!text || text.length < 200) {
        j.error = 'empty document text';
        return;
      }
      const filename = `judgment-${j.tid}-${(j.title || 'untitled').slice(0, 60).replace(/[^\w-]+/g, '_')}.txt`;
      const enriched =
        `Title: ${j.title || 'Untitled'}\n` +
        `Court: ${j.court || ''}\n` +
        `Date: ${j.date || ''}\n` +
        `Citation: ${j.citation || ''}\n` +
        `Source: Indian Kanoon tid ${j.tid}\n\n` +
        text;
      const buf = Buffer.from(enriched, 'utf-8');

      const { operationName } = await gemini.uploadAndImport(
        job.gemini_store_name, buf, filename, 'text/plain'
      );
      const { documentName } = await gemini.pollIndexingComplete(operationName);
      j.indexed = true;
      j.gemini_document = documentName;
    } catch (e) {
      console.warn(`[research ${jobId}] judgment ${j.tid} failed:`, e.message);
      j.error = String(e.message || e).slice(0, 200);
    } finally {
      checkpoint();
    }
  }

  await Promise.allSettled(judgments.map(processOne));
  await dbWriteInFlight;  // ensure the last checkpoint flushed

  const indexedCount = judgments.filter(j => j.indexed).length;
  const failedCount = judgments.length - indexedCount;
  const summary =
    `Total ${judgments.length} judgments mil gayi. ${indexedCount} successfully indexed ho gayi humare case file ke saath. ` +
    (failedCount ? `${failedCount} fetch nahi ho payi. ` : '') +
    `Ab aap inhe normal voice session mein puch sakte hain.`;

  await pool.query(
    `UPDATE research_jobs SET status='done', summary=$1, updated_at=NOW() WHERE id=$2`,
    [summary, jobId]
  );
}

module.exports = { runResearch };
