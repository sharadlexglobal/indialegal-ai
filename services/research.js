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
const bus = require('./eventBus');

// ─── Verbatim-quote integrity validator ─────────────────────────────
//
// Agent 2 returns paragraph numbers along with verbatim quotes. Audit
// showed DeepSeek is correct on text (47/47 exact or near-exact match)
// but occasionally hallucinates the para number (4/40 wrong in audit).
// E.g. quoting Vijaysinh Chandubha Jadeja's famous para 57 but labelling
// it para 17. This breaks user trust the moment they look up the cite.
//
// Defense: after Agent 2 returns, for every quote, LOCATE the quote in
// the actual judgment text and read off the nearest preceding paragraph
// marker. Override DeepSeek's label only when our deterministic locator
// produces a different number.

function locateParaForQuote(quoteText, source) {
  if (!quoteText || !source) return null;
  const trimmed = String(quoteText).trim();
  const head = trimmed.slice(0, 40);
  if (head.length < 20) return null;
  const probe = head
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  let m;
  try { m = source.match(new RegExp(probe, 'i')); } catch { return null; }
  if (!m || m.index == null) return null;

  // CASE A — the quote ITSELF starts with a para marker (e.g. "57.").
  // If the match landed at a position where the preceding char is a
  // newline (i.e. the quote IS the start of paragraph 57), trust the
  // quote's own leading number.
  const selfMarker = trimmed.match(/^\(?(\d+(?:\.\d+)?)\)?[.)]\s/);
  if (selfMarker) {
    const numAt = m.index;
    if (numAt === 0 || /[\r\n]/.test(source[numAt - 1] || '\n')) {
      return selfMarker[1];
    }
  }

  // CASE B — the quote is in the BODY of a paragraph. Look backwards
  // ~2500 chars for the nearest paragraph marker.
  const start = Math.max(0, m.index - 2500);
  const window = source.slice(start, m.index);
  const re = /(^|\n)\s*(?:Para(?:graph)?\s+)?\(?(\d+(?:\.\d+)?)\)?[.)]\s/gi;
  const markers = [];
  let last;
  while ((last = re.exec(window)) !== null) {
    markers.push({ num: last[2] });
  }
  if (!markers.length) return null;
  return markers[markers.length - 1].num;
}

function normalizeParaClaim(s) {
  // Strip spaces, "Para ", trailing punctuation. Keep digits + optional dot.
  return String(s || '')
    .replace(/(^|\s)para(graph)?\s+/i, '')
    .replace(/[^\d.]/g, '')
    .replace(/^\.+|\.+$/g, '');
}

// Single source of truth: the deterministic locator. If DS agrees, keep
// the claim. If DS disagrees, trust the locator. If the locator can't
// decide (no marker in scope), drop the para to empty — honest blank
// beats misleading number. The locator already handles both "self
// marker" (quote starts with its own N. on a line) and "scan back to
// nearest preceding marker" cases.
function verifyOrFindPara(quoteText, source, deepseekClaim) {
  const claim = normalizeParaClaim(deepseekClaim);
  const located = locateParaForQuote(quoteText, source);

  if (!located && !claim) return '';
  if (!located && claim) {
    // Cannot independently verify — DROP. Empty para is honest.
    console.warn(`[verify-para] drop: ds=${claim} no locator support | "${String(quoteText).slice(0, 60)}..."`);
    return '';
  }
  if (located && !claim) return located;
  if (located === claim) return claim;

  // Disagreement — trust the deterministic locator.
  console.warn(`[verify-para] override: ds=${claim} -> ${located} | "${String(quoteText).slice(0, 60)}..."`);
  return located;
}

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
  const topic = `research:${jobId}`;
  const emit = (event, data = {}) => bus.emit(topic, event, data);
  const t0 = Date.now();

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
  emit('started', { jobId, scope: job.scope });

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

  emit('soul_extracting', {});
  const intent = await verification.extractSoul(naturalish);
  if (!intent || !intent.ikapi_search_keywords) {
    emit('failed', { reason: 'Agent 1 (soul extract) failed' });
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
  emit('soul_extracted', {
    soul_question: intent.soul_question,
    keywords: intent.ikapi_search_keywords,
    court_code: intent.court_code,
    legal_area: intent.legal_area,
    exact_provision: intent.exact_provision
  });

  // ── Step 2 — IKAPI search with doctype fallback ──
  const filters = {};
  if (scope.from_date) filters.fromdate = scope.from_date;
  if (scope.to_date) filters.todate = scope.to_date;
  if (scope.author) filters.author = scope.author;
  if (scope.bench) filters.bench = scope.bench;
  if (intent.is_recent_query) filters.sort = 'mostrecent';

  // Recall-aware multi-doctype fetch (post-audit fixes):
  //
  // Fix A: broaden when narrow doctype returns < 3 (not only on 0)
  // Fix B: if user named a specific HC AND mentioned a landmark case
  //        by name (capitalised proper noun), ALWAYS also query SC
  //        in parallel — landmarks live in SC, advocate often wants both
  //        the SC ratio + a HC application
  //
  // Merge by tid (dedupe), preserve insertion order so user's preferred
  // doctype's results come first.

  const intended = intent.court_code || 'judgments';
  const isSpecificHC = !['supremecourt', 'highcourts', 'tribunals', 'judgments'].includes(intended);
  const namedCaseRe = /\b[A-Z][a-z]{2,}\s+[A-Z][a-z]{2,}\b/;
  const hasNamedCase = namedCaseRe.test(intent.ikapi_search_keywords || '')
                     || namedCaseRe.test(scope.keywords || '');

  // Plan parallel-fetch doctypes
  const initialPlan = [intended];
  if (isSpecificHC && hasNamedCase) initialPlan.push('supremecourt');

  const fetched = new Map();   // tid -> result
  const usedDoctypes = new Set();

  async function fetchOne(dt) {
    try {
      const r = await ikapiCall('search_cases', {
        query: intent.ikapi_search_keywords,
        doctype: dt,
        ...filters,
        max_results: OVER_FETCH_N
      });
      usedDoctypes.add(dt);
      for (const r2 of (r?.results || [])) {
        if (!r2.tid || fetched.has(r2.tid)) continue;
        fetched.set(r2.tid, r2);
      }
      return true;
    } catch (e) {
      console.warn(`[research ${jobId}] IKAPI doctype=${dt} error: ${e.message}`);
      return false;
    }
  }

  emit('ikapi_search_start', { doctypes: initialPlan });
  // Round 1: parallel fetch from intended (+ SC if landmark named)
  await Promise.allSettled(initialPlan.map(fetchOne));
  console.log(`[research ${jobId}] round 1: ${fetched.size} unique candidates from doctypes [${[...usedDoctypes].join(',')}]`);
  emit('ikapi_round1_done', { count: fetched.size, doctypes: [...usedDoctypes] });

  // Round 2: if total < 3, broaden to next tier (sequential — only if needed)
  if (fetched.size < 3) {
    const broader = ['highcourts', 'judgments'].filter(d => !usedDoctypes.has(d));
    for (const dt of broader) {
      if (fetched.size >= 5) break;
      emit('ikapi_broaden', { doctype: dt });
      await fetchOne(dt);
      console.log(`[research ${jobId}] round 2 broaden to ${dt}: ${fetched.size} total`);
    }
  }

  let candidates = [...fetched.values()].slice(0, OVER_FETCH_N);
  const usedDoctype = [...usedDoctypes].join('+');

  if (!candidates.length) {
    emit('no_results', {});
    emit('done', { summary: 'Indian Kanoon par koi judgment nahi mila.', elapsed_ms: Date.now() - t0 });
    await pool.query(
      `UPDATE research_jobs SET status='done', summary=$1, updated_at=NOW() WHERE id=$2`,
      ['Indian Kanoon par is sawaal ke liye koi judgment nahi mila. Scope thoda widen karke try kar sakte hain.', jobId]
    );
    return;
  }

  console.log(`[research ${jobId}] IKAPI returned ${candidates.length} (doctype=${usedDoctype}), verifying each…`);
  emit('candidates', {
    count: candidates.length,
    doctypes: [...usedDoctypes],
    candidates: candidates.map(c => ({
      tid: c.tid, title: c.title, court: c.court, date: c.date || c.judgment_date
    }))
  });

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
      emit('fetch_text', { tid: j.tid, title: j.title });
      const doc = await ikapiCall('get_case_document', { tid: j.tid });
      const text = (doc?.text || doc?.body || doc?.raw || '').toString();
      if (!text || text.length < 500) {
        j.verdict = 'INAPPLICABLE';
        j.verdict_reason = 'judgment text too short';
        emit('verdict', {
          tid: j.tid, title: j.title, verdict: j.verdict,
          reason: j.verdict_reason, confidence: 10
        });
        return;
      }

      // SAVE full text in DB (P1 fix — persistent recovery if Gemini fails)
      j.full_text = text;
      j.text_length = text.length;
      emit('agent2_start', { tid: j.tid, title: j.title, text_length: text.length });

      // 3-agent verification
      const v = await verification.verifyCandidate(intent.soul_question, j, text);
      j.verdict = v.verdict;
      j.verdict_confidence = v.confidence;
      j.verdict_reason = v.reason;
      j.advocate_use = v.advocate_use;
      j.agent2_addresses = v.addresses;
      j.agent2_summary = v.summary;
      j.for_or_against_user = v.for_or_against_user;
      // Normalize quotes — Agent 2 may sometimes return strings (older
      // format) or objects. Coerce to [{para, text}] uniformly so the UI
      // doesn't have to guess.
      // ALSO: verify each para number against the source. If DeepSeek
      // hallucinates a number (audit showed 10% rate), the deterministic
      // locator overrides it. See verifyOrFindPara() above.
      j.relevant_quotes = (v.relevant_quotes || []).map(q => {
        const raw = typeof q === 'string'
          ? { para: '', text: q }
          : { para: String(q.para || '').trim(), text: String(q.text || '').trim() };
        const verified = verifyOrFindPara(raw.text, text, raw.para);
        return { para: verified, text: raw.text };
      }).filter(q => q.text && q.text.length >= 20);

      emit('verdict', {
        tid: j.tid,
        title: j.title,
        court: j.court,
        date: j.date,
        verdict: j.verdict,
        confidence: j.verdict_confidence,
        reason: j.verdict_reason,
        addresses: j.agent2_addresses,
        for_or_against_user: j.for_or_against_user,
        summary: j.agent2_summary,
        advocate_use: j.advocate_use,
        relevant_quotes: j.relevant_quotes
      });
    } catch (e) {
      console.warn(`[research ${jobId}] verify ${j.tid} failed:`, e.message);
      j.verdict = 'INAPPLICABLE';
      j.verdict_reason = `verification error: ${String(e.message || e).slice(0, 120)}`;
      emit('verdict', {
        tid: j.tid, title: j.title, verdict: j.verdict,
        reason: j.verdict_reason, confidence: 0
      });
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
  emit('verdicts_complete', {
    applicable: applicable.length,
    tangential: tangential.length,
    inapplicable: judgments.length - applicable.length - tangential.length,
    to_index: toIndex.length
  });

  // ── Step 5 — Index selected judgments in Gemini File Search ──
  await Promise.allSettled(toIndex.map(async (j) => {
    if (!j.full_text) return;
    try {
      emit('indexing_start', { tid: j.tid, title: j.title });
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
      emit('indexed', { tid: j.tid, title: j.title });
    } catch (e) {
      console.warn(`[research ${jobId}] index ${j.tid} failed:`, e.message);
      j.index_error = String(e.message || e).slice(0, 200);
      emit('index_failed', { tid: j.tid, title: j.title, error: j.index_error });
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
  emit('done', {
    summary,
    applicable: applicable.length,
    tangential: tangential.length,
    inapplicable: judgments.length - applicable.length - tangential.length,
    indexed: indexedCount,
    elapsed_ms: Date.now() - t0
  });
}

// Backfill — re-run the para-locator validator across all already-saved
// research jobs and rewrite their judgments[].relevant_quotes[].para
// where the locator confidently overrides. Called by the admin endpoint
// /api/admin/revalidate-paras.
async function revalidateAllParas(pool) {
  const r = await pool.query(
    `SELECT id, judgments FROM research_jobs
      WHERE status='done' AND judgments IS NOT NULL`
  );
  let touchedJobs = 0;
  let touchedQuotes = 0;
  for (const row of r.rows) {
    const judgments = row.judgments;
    if (!Array.isArray(judgments)) continue;
    let changed = false;
    for (const j of judgments) {
      const fullText = j.full_text;
      if (!fullText || !Array.isArray(j.relevant_quotes)) continue;
      for (const q of j.relevant_quotes) {
        const verified = verifyOrFindPara(q.text, fullText, q.para);
        if (verified !== (q.para || '')) {
          q.para = verified;
          touchedQuotes++;
          changed = true;
        }
      }
    }
    if (changed) {
      await pool.query(
        `UPDATE research_jobs SET judgments=$1, updated_at=NOW() WHERE id=$2`,
        [JSON.stringify(judgments), row.id]
      );
      touchedJobs++;
    }
  }
  return { jobs_touched: touchedJobs, quotes_corrected: touchedQuotes };
}

module.exports = { runResearch, revalidateAllParas, verifyOrFindPara, locateParaForQuote };
