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

const IKAPI_MCP_URL = process.env.IKAPI_MCP_URL || 'https://ikapi.onrender.com/mcp';

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
  const queries = buildScopeQueries(scope);
  if (!queries.length) {
    await pool.query(
      `UPDATE research_jobs SET status='failed', error='no keywords in scope', updated_at=NOW() WHERE id=$1`,
      [jobId]
    );
    return;
  }

  const maxResults = Math.max(1, Math.min(scope.max_results ?? 5, 8));
  const doctype = scope.doctype || undefined;

  // 1) Search via IKAPI — fan out queries, dedupe by tid
  const seen = new Map();
  for (const q of queries) {
    try {
      const res = await ikapiCall('search_cases', {
        query: q,
        ...(doctype ? { doctype } : {}),
        max_results: maxResults
      });
      const list = res?.results || [];
      for (const r of list) {
        if (!r.tid || seen.has(r.tid)) continue;
        seen.set(r.tid, {
          tid: r.tid,
          title: r.title,
          court: r.court,
          date: r.date || r.judgment_date,
          citation: r.citation,
          cited_by: r.cited_by,
          query: q,
          indexed: false
        });
      }
    } catch (e) {
      console.warn(`[research ${jobId}] search '${q}' failed:`, e.message);
    }
  }

  let judgments = [...seen.values()];
  // Sort by cited_by desc as a quick relevance proxy
  judgments.sort((a, b) => (b.cited_by || 0) - (a.cited_by || 0));
  judgments = judgments.slice(0, maxResults);

  await pool.query(
    `UPDATE research_jobs SET judgments=$1, updated_at=NOW() WHERE id=$2`,
    [JSON.stringify(judgments), jobId]
  );

  // 2) For each judgment: fetch full text, upload to Gemini File Search store
  for (let i = 0; i < judgments.length; i++) {
    const j = judgments[i];
    try {
      const doc = await ikapiCall('get_case_document', { tid: j.tid }, { timeoutMs: 120000 });
      const text = (doc?.text || doc?.body || doc?.raw || '').toString();
      if (!text || text.length < 200) {
        j.error = 'empty document text';
        continue;
      }
      const filename = `judgment-${j.tid}-${(j.title || 'untitled').slice(0, 60).replace(/[^\w-]+/g, '_')}.txt`;
      // Prepend metadata header so retrieval includes searchable case provenance
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
    }

    // checkpoint after every judgment
    await pool.query(
      `UPDATE research_jobs SET judgments=$1, updated_at=NOW() WHERE id=$2`,
      [JSON.stringify(judgments), jobId]
    );
  }

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
