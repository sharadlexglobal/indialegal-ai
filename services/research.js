/**
 * Legal Research orchestrator with 3-AGENT VERIFICATION.
 *
 * Pipeline (v3 — post self-verification audit):
 *   1. Voice agent calls /api/cases/:id/start-research with scope.
 *   2. INSERT research_jobs row, return jobId immediately.
 *   3. Background work:
 *        Agent 1: extract soul-question + clean keywords (DeepSeek)
 *        IKAPI search with clean keywords + doctype fallback (narrow → broad)
 *        For each top N candidate (parallel):
 *          - get_case_document (full text from IKAPI)
 *          - Agent 2: read full text through soul-lens (DeepSeek)
 *          - Agent 3: impartial verdict APPLICABLE/TANGENTIAL/INAPPLICABLE
 *          - Save full_text + verdict + reason + agent2 summary in DB
 *        Keep APPLICABLE first; fall back to TANGENTIAL if < 3 APPLICABLE.
 *        Upload kept judgments to Gemini File Search store.
 *   4. Frontend polls status, sees verdict-tagged judgments with reasoning.
 *
 * Why 3-agent verification: 86% manual agreement on a 7-judgment sample.
 * Catches PMLA-vs-NDPS mis-matches that snippet-only scoring let through.
 */

const fetch = require('node-fetch');
const { Buffer } = require('buffer');
const gemini = require('./gemini');
const verification = require('./verification');

const IKAPI_MCP_URL = process.env.IKAPI_MCP_URL || 'https://ikapi.onrender.com/mcp';
const OVER_FETCH_N = 10;        // 10 candidates -> full text -> verify each

async function ikapiCall(name, args, { timeoutMs = 180000 } = {}) {
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } };
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

async function runResearch(pool, jobId) {
  const job = (await pool.query(
    `SELECT j.id, j.case_id, j.scope, c.gemini_store_name
       FROM research_jobs j JOIN cases c ON c.id = j.case_id
      WHERE j.id = $1`,
    [jobId]
  )).rows[0];
  if (!job) throw new Error(`research job ${jobId} not found`);
  if (!job.gemini_store_name) throw new Error('case has no gemini store');

  await pool.query(
    `UPDATE research_jobs SET status='running', updated_at=NOW() WHERE id=$1`,
    [jobId]
  );

  const scope = job.scope || {};
  const maxResults = Math.max(1, Math.min(scope.max_results ?? 5, 8));

  // ── Step 1 — Agent 1 (extract soul + clean keywords) ──
  const naturalish = [
    scope.keywords || '',
    Array.isArray(scope.sections) ? scope.sections.join(' ') : '',
    scope.principle || ''
  ].filter(Boolean).join(' — ');

  if (!naturalish) {
    await pool.query(
      `UPDATE research_jobs SET status='failed', error='no keywords in scope', updated_at=NOW() WHERE id=$1`,
      [jobId]
    );
    return;
  }

  const intent = await verification.extractSoul(naturalish);
  if (!intent || !intent.ikapi_search_keywords) {
    await pool.query(
      `UPDATE research_jobs SET status='failed', error='Agent 1 (soul extract) failed', updated_at=NOW() WHERE id=$1`,
      [jobId]
    );
    return;
  }

  // Honour explicit user-given fields over Agent 1's inference
  if (scope.doctype) intent.court_code = scope.doctype;
  console.log(`[research ${jobId}] intent:`, JSON.stringify({
    soul: intent.soul_question?.slice(0, 80),
    keywords: intent.ikapi_search_keywords,
    court: intent.court_code
  }));

  // ── Step 2 — IKAPI search with doctype fallback ──
  const filters = {};
  if (scope.from_date) filters.fromdate = scope.from_date;
  if (scope.to_date) filters.todate = scope.to_date;
  if (scope.author) filters.author = scope.author;
  if (scope.bench) filters.bench = scope.bench;
  if (intent.is_recent_query) filters.sort = 'mostrecent';

  const tryDoctypes = [intent.court_code, 'highcourts', 'judgments']
    .filter((v, i, a) => v && a.indexOf(v) === i);

  let candidates = [];
  let usedDoctype = intent.court_code;
  for (const dt of tryDoctypes) {
    try {
      const r = await ikapiCall('search_cases', {
        query: intent.ikapi_search_keywords,
        doctype: dt,
        ...filters,
        max_results: OVER_FETCH_N
      });
      const got = (r?.results || []).slice(0, OVER_FETCH_N);
      if (got.length) {
        candidates = got;
        usedDoctype = dt;
        if (dt !== intent.court_code) {
          console.log(`[research ${jobId}] doctype fallback ${intent.court_code} -> ${dt}`);
        }
        break;
      }
    } catch (e) {
      console.warn(`[research ${jobId}] IKAPI doctype=${dt} error: ${e.message}`);
    }
  }

  if (!candidates.length) {
    await pool.query(
      `UPDATE research_jobs SET status='done', summary=$1, updated_at=NOW() WHERE id=$2`,
      ['Indian Kanoon par is sawaal ke liye koi judgment nahi mila. Scope thoda widen karke try kar sakte hain.', jobId]
    );
    return;
  }

  console.log(`[research ${jobId}] IKAPI returned ${candidates.length} (doctype=${usedDoctype}), verifying each…`);

  // ── Step 3 — 3-agent verification per candidate (parallel) ──
  // Initialize all judgments with metadata; full text + verdict populated as we go.
  let judgments = candidates.map(c => ({
    tid: c.tid,
    title: c.title,
    court: c.court,
    date: c.date || c.judgment_date,
    citation: c.citation,
    cited_by: c.cited_by,
    query: intent.ikapi_search_keywords,
    verdict: 'pending',
    indexed: false
  }));

  // Save the initial list so the frontend sees something while verification runs
  await pool.query(
    `UPDATE research_jobs SET judgments=$1, updated_at=NOW() WHERE id=$2`,
    [JSON.stringify(judgments), jobId]
  );

  let dbWriteInFlight = Promise.resolve();
  function checkpoint() {
    dbWriteInFlight = pool.query(
      `UPDATE research_jobs SET judgments=$1, updated_at=NOW() WHERE id=$2`,
      [JSON.stringify(judgments), jobId]
    ).catch(e => console.warn(`[research ${jobId}] checkpoint failed:`, e.message));
  }

  await Promise.allSettled(judgments.map(async (j) => {
    try {
      const doc = await ikapiCall('get_case_document', { tid: j.tid });
      const text = (doc?.text || doc?.body || doc?.raw || '').toString();
      if (!text || text.length < 500) {
        j.verdict = 'INAPPLICABLE';
        j.verdict_reason = 'judgment text too short';
        return;
      }

      // SAVE full text in DB (P1 fix — persistent recovery if Gemini fails)
      j.full_text = text;
      j.text_length = text.length;

      // 3-agent verification
      const v = await verification.verifyCandidate(intent.soul_question, j, text);
      j.verdict = v.verdict;
      j.verdict_confidence = v.confidence;
      j.verdict_reason = v.reason;
      j.advocate_use = v.advocate_use;
      j.agent2_addresses = v.addresses;
      j.agent2_summary = v.summary;
      j.for_or_against_user = v.for_or_against_user;
    } catch (e) {
      console.warn(`[research ${jobId}] verify ${j.tid} failed:`, e.message);
      j.verdict = 'INAPPLICABLE';
      j.verdict_reason = `verification error: ${String(e.message || e).slice(0, 120)}`;
    } finally {
      checkpoint();
    }
  }));
  await dbWriteInFlight;

  // ── Step 4 — Pick what to INDEX in Gemini ──
  // Prefer APPLICABLE; fall back to TANGENTIAL only if APPLICABLE < 3.
  const applicable = judgments.filter(j => j.verdict === 'APPLICABLE');
  const tangential = judgments.filter(j => j.verdict === 'TANGENTIAL');

  let toIndex;
  if (applicable.length >= 3) {
    toIndex = applicable.slice(0, maxResults);
  } else {
    toIndex = [...applicable, ...tangential].slice(0, maxResults);
  }
  console.log(`[research ${jobId}] verdicts: ${applicable.length} APPLICABLE, ${tangential.length} TANGENTIAL, ${judgments.length - applicable.length - tangential.length} INAPPLICABLE. Indexing ${toIndex.length}.`);

  // ── Step 5 — Index selected judgments in Gemini File Search ──
  await Promise.allSettled(toIndex.map(async (j) => {
    if (!j.full_text) return;
    try {
      const filename = `judgment-${j.tid}-${(j.title || 'untitled').slice(0, 60).replace(/[^\w-]+/g, '_')}.txt`;
      const enriched =
        `Title: ${j.title || 'Untitled'}\n` +
        `Court: ${j.court || ''}\n` +
        `Date: ${j.date || ''}\n` +
        `Citation: ${j.citation || ''}\n` +
        `Source: Indian Kanoon tid ${j.tid}\n` +
        `Verdict: ${j.verdict}\n` +
        `Why: ${j.verdict_reason || ''}\n\n` +
        j.full_text;
      const buf = Buffer.from(enriched, 'utf-8');
      const { operationName } = await gemini.uploadAndImport(
        job.gemini_store_name, buf, filename, 'text/plain'
      );
      const { documentName } = await gemini.pollIndexingComplete(operationName);
      j.indexed = true;
      j.gemini_document = documentName;
    } catch (e) {
      console.warn(`[research ${jobId}] index ${j.tid} failed:`, e.message);
      j.index_error = String(e.message || e).slice(0, 200);
    } finally {
      checkpoint();
    }
  }));
  await dbWriteInFlight;

  // ── Step 6 — Final status + narration ──
  const indexedCount = judgments.filter(j => j.indexed).length;
  const summary = applicable.length
    ? `${applicable.length} judgments directly applicable mil gayi${tangential.length ? ', ' + tangential.length + ' related background bhi mili' : ''}. ` +
      `${indexedCount} indexed ho gayi humare case file ke saath. ` +
      `Aap ab voice session mein in pe direct question puch sakte hain.`
    : (tangential.length
        ? `Koi directly applicable judgment nahi mili, lekin ${tangential.length} related judgments mile. ${indexedCount} indexed kiye. Scope refine karne ka consider kariye.`
        : `${judgments.length} candidates mile lekin koi directly applicable nahi nikla. Scope refine karke try karenge?`);

  await pool.query(
    `UPDATE research_jobs SET status='done', summary=$1, updated_at=NOW() WHERE id=$2`,
    [summary, jobId]
  );
  console.log(`[research ${jobId}] done. ${summary}`);
}

module.exports = { runResearch };
