#!/usr/bin/env node
/**
 * Multi-query trace of the 3-agent verification pipeline.
 *
 * Runs each query through:
 *   Agent 1 (soul extract)  -> IKAPI search -> top N candidates
 *   For each candidate (parallel): fetch full text -> Agent 2 (lens) -> Agent 3 (verdict)
 *
 * Edge-case fixes vs trace-3agent.js:
 *   1. Smart truncation for large judgments: head + middle + tail sample
 *      instead of dumb cut at 50K. (Puttaswamy 2.5MB caused undef verdict.)
 *   2. INAPPLICABLE safe fallback when Agent 3 returns malformed JSON.
 *   3. Agent 2 short-circuit: if it reports "not at all", skip Agent 3
 *      (already known answer — saves cost + time).
 *   4. Per-candidate concurrency cap to dodge DeepSeek rate-limits.
 *   5. Sequential per query but parallel candidates within a query.
 */
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const IKAPI = 'https://ikapi.onrender.com/mcp';
const DS_URL = 'https://api.deepseek.com/v1/chat/completions';
const DS_KEY = process.env.DEEPSEEK_API_KEY;
const DS_MODEL = 'deepseek-v4-flash';
const N_CANDIDATES_PER_QUERY = 5;

if (!DS_KEY) { console.error('DEEPSEEK_API_KEY required'); process.exit(1); }

// ── 8 real-chamber complex queries spanning daily practice ─────────────
const QUERIES = [
  {
    id: 'C01',
    area: 'Bail post-rejection',
    text: 'Mere client ko 379 IPC theft mein FIR, trial court mein bail reject hui, sessions court mein second bail ke chances Delhi mein',
    expected_doctype: 'delhi'
  },
  {
    id: 'C02',
    area: 'NI Act 138 — strict 15-day notice',
    text: 'Cheque bounce ka notice complainant ne 14 din mein bhej diya, complaint maintainable hai ya 15 din strict requirement hai? Latest SC view',
    expected_doctype: 'supremecourt'
  },
  {
    id: 'C03',
    area: '498A quash — settled',
    text: '498A IPC mein matrimonial dispute parties mein settle ho gaya, ab FIR quash karwana Delhi HC se',
    expected_doctype: 'delhi'
  },
  {
    id: 'C04',
    area: 'NDPS Section 50 defect',
    text: 'NDPS Section 50 ki search mein 2 gazetted officers ki jagah ek SHO ne search ki, recovery valid hai? Latest SC view on procedural defect',
    expected_doctype: 'supremecourt'
  },
  {
    id: 'C05',
    area: '125 CrPC interim maintenance',
    text: 'Wife ne 125 CrPC mein maintenance file ki, interim maintenance ka quantum kaise calculate hota hai Rajnesh v Neha ke baad',
    expected_doctype: 'supremecourt'
  },
  {
    id: 'C06',
    area: 'POCSO consent age',
    text: 'POCSO ke under consent age 18 hai, lekin 17 saal ki ladki ne consent diya tha romantic relationship — latest Delhi HC view on consensual relationship',
    expected_doctype: 'delhi'
  },
  {
    id: 'C07',
    area: 'Order 8 Rule 1 CPC',
    text: 'Commercial suit mein Order 8 Rule 1 CPC ke 30 din time-bar mein written statement file nahi kiya, condonation milegi ya deemed admission ho gayi?',
    expected_doctype: 'delhi'
  },
  {
    id: 'C08',
    area: 'NDPS Section 37 twin conditions',
    text: 'NDPS Section 37 twin conditions latest SC interpretation commercial quantity heroin recovery, bail ke chances kya hain',
    expected_doctype: 'supremecourt'
  }
];

// NOTE: smartTruncate removed. DeepSeek V4 Flash has 1M-token context
// (~4M chars). Even 2.5MB judgments fit comfortably. Truncation was
// dropping holdings buried mid-text. We now pass full text always.

// ── DeepSeek + IKAPI clients ──────────────────────────────────────

async function ds(messages, label = '', timeoutMs = 90000) {
  for (let i = 0; i < 3; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      const r = await fetch(DS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DS_KEY}` },
        body: JSON.stringify({
          model: DS_MODEL, messages,
          response_format: { type: 'json_object' }, temperature: 0
        }),
        signal: ctl.signal
      });
      clearTimeout(t);
      const j = await r.json();
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
      return JSON.parse(j.choices?.[0]?.message?.content || '{}');
    } catch (e) {
      console.warn(`    [${label}] retry ${i + 1}: ${e.message}`);
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
  return null;
}

async function ikapi(name, args, timeoutMs = 60000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(IKAPI, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      signal: ctl.signal
    });
    clearTimeout(t);
    const j = await r.json();
    const text = j.result?.content?.[0]?.text || '';
    try { return JSON.parse(text); } catch { return { raw: text }; }
  } finally {
    clearTimeout(t);
  }
}

// ── Agents ────────────────────────────────────────────────────────

async function agent1_soul(naturalQuery) {
  return await ds([{
    role: 'user',
    content: `You extract the SOUL of an Indian advocate's natural-language legal question — the crystallized question, not keywords.

USER: ${naturalQuery}

Output strict JSON. NOTE the two separate output fields for query text:
- soul_question  -> long English sentence for downstream agents (Agent 2/3)
- ikapi_search_keywords -> SHORT 3-7 word keyword phrase for IKAPI's full-text search engine. NO English chaff, no question marks, just statute + section + 2-3 core legal concept words.

{
  "legal_area": "<e.g. 'NI Act Section 138', 'PMLA bail', '498A quash'>",
  "exact_provision": "<exact section e.g. 'Section 138 proviso (b)'>",
  "procedural_stage": "<'pre-complaint' | 'bail' | 'trial' | 'appeal' | 'quash' | etc.>",
  "core_question": "<ONE plain English sentence — user's real question>",
  "user_facts": ["..."],
  "what_user_wants_to_do": "...",
  "soul_question": "<crystallized English question — for Agents 2 and 3>",
  "ikapi_search_keywords": "<3-7 word keyword phrase for IKAPI — short, focused, no chaff>"
}

EXAMPLES of ikapi_search_keywords:

User asks about 15-day notice under Section 138 NI Act:
  ikapi_search_keywords: "Section 138 NI Act 15 day notice mandatory"

User asks about NDPS Section 50 search defect:
  ikapi_search_keywords: "Section 50 NDPS Act search procedural compliance"

User asks about 498A quash on settlement:
  ikapi_search_keywords: "Section 498A IPC quash settlement compoundability"

User asks about Rajnesh v Neha interim maintenance:
  ikapi_search_keywords: "Section 125 CrPC interim maintenance Rajnesh Neha"

User asks about NDPS Section 37 twin conditions:
  ikapi_search_keywords: "Section 37 NDPS Act twin conditions bail"

User asks about Order 8 Rule 1 CPC written statement time-bar:
  ikapi_search_keywords: "Order 8 Rule 1 CPC written statement deemed admission"

User asks about POSCO consensual relationship 17-year-old:
  ikapi_search_keywords: "POCSO Act consensual relationship minor age"

User asks about Section 379 IPC second bail in Delhi sessions:
  ikapi_search_keywords: "Section 437 CrPC second bail successive application"`
  }], 'soul');
}

async function agent2_read(soulQuestion, fullJudgmentText) {
  // No truncation — DeepSeek V4 Flash 1M-token context
  const text = fullJudgmentText || '';
  return await ds([{
    role: 'user',
    content: `Read this judgment THROUGH THE LENS of the soul-question. Report ONLY what the judgment says about THIS question. If it does not address the soul-question, say so plainly. Do not invent connections.

SOUL_QUESTION:
${soulQuestion}

JUDGMENT (head + middle + tail sample if large):
${text}

Output strict JSON:
{
  "discusses_same_provision": true|false,
  "addresses_soul_question": "directly" | "tangentially" | "not at all",
  "court_holding": "<1-2 sentences ON THIS QUESTION>",
  "relevant_quotes": ["<verbatim>", "..."],
  "for_or_against_user": "supports user's position" | "against user's position" | "neutral" | "not applicable",
  "summary_for_user": "<2-3 sentences from the angle of soul-question only>"
}

Rules:
- Quote verbatim, never paraphrase quotes
- If addresses_soul_question is "not at all", relevant_quotes must be []
- summary_for_user must NEVER include positions the judgment did not actually take`
  }], 'read');
}

async function agent3_verdict(soulQuestion, summaryForUser) {
  const r = await ds([{
    role: 'user',
    content: `You are an IMPARTIAL gatekeeper. You receive only:
1. A soul-question
2. A summary from another agent
You do NOT see the full judgment, court name, date, or title.

Decide if the judgment AS DESCRIBED IN THE SUMMARY is STRAIGHT-TO-THE-POINT applicable.

VERDICTS:
  APPLICABLE  - Direct clear holding on the soul-question. Advocate can cite.
  TANGENTIAL  - Same area, different specific question. Background, not citable on point.
  INAPPLICABLE - Different question/provision/stage. Skip.

ZERO TOLERANCE:
- No "could be applied by analogy"
- No "general principle suggests"
- No "implies but does not say"
- If summary says "does not address" -> INAPPLICABLE

INPUT:
  soul_question: ${soulQuestion}
  summary_for_user: ${summaryForUser}

Output strict JSON:
{
  "verdict": "APPLICABLE" | "TANGENTIAL" | "INAPPLICABLE",
  "confidence": 0-10,
  "reason": "<one sentence>",
  "advocate_use": "<if APPLICABLE: one-sentence cite plan. else empty>"
}`
  }], 'verdict');

  // Safe fallback for malformed responses
  if (!r || !r.verdict || !['APPLICABLE', 'TANGENTIAL', 'INAPPLICABLE'].includes(r.verdict)) {
    return {
      verdict: 'INAPPLICABLE',
      confidence: 0,
      reason: 'malformed agent3 response — safe fallback',
      advocate_use: ''
    };
  }
  return r;
}

// ── Per-query trace ────────────────────────────────────────────────

async function traceQuery(q) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`${q.id}  ${q.area}`);
  console.log(`  "${q.text}"`);
  console.log('═'.repeat(70));

  const t0 = Date.now();
  // Agent 1
  console.log(`  ▶ Agent 1 — soul...`);
  const soul = await agent1_soul(q.text);
  if (!soul?.soul_question) {
    console.log(`  ❌ Agent 1 failed`);
    return { ...q, error: 'soul-extraction-failed' };
  }
  console.log(`     soul: "${soul.soul_question.slice(0, 100)}..."`);

  // IKAPI search — use clean keywords field, NOT the verbose soul-question.
  // Plus doctype broadening fallback if narrow doctype returns nothing.
  const ik_query = (soul.ikapi_search_keywords || soul.exact_provision || soul.legal_area || q.text).slice(0, 200);
  console.log(`  ▶ IKAPI keyword query: "${ik_query}"`);

  const tryDoctypes = [q.expected_doctype, 'highcourts', 'judgments']
    .filter((v, i, a) => v && a.indexOf(v) === i);   // unique, non-null

  let candidates = [];
  let usedDoctype = q.expected_doctype;
  for (const dt of tryDoctypes) {
    try {
      const res = await ikapi('search_cases', {
        query: ik_query, doctype: dt, max_results: 10
      });
      const got = (res?.results || []).slice(0, N_CANDIDATES_PER_QUERY);
      if (got.length) {
        candidates = got;
        usedDoctype = dt;
        if (dt !== q.expected_doctype) {
          console.log(`     ⚠ fallback to doctype="${dt}" (narrow gave 0)`);
        }
        break;
      } else {
        console.log(`     doctype="${dt}" returned 0, trying next…`);
      }
    } catch (e) {
      console.log(`     doctype="${dt}" errored: ${e.message}`);
    }
  }
  console.log(`     fetched ${candidates.length}/${N_CANDIDATES_PER_QUERY} (final doctype=${usedDoctype})`);
  if (!candidates.length) {
    return { ...q, soul, used_doctype: usedDoctype, verifications: [], summary: { applicable: 0, tangential: 0, inapplicable: 0, errored: 0, elapsed_s: 0 } };
  }

  // 3-agent verification per candidate in parallel
  console.log(`  ▶ Verifying ${candidates.length} candidates in parallel...`);
  const verifications = await Promise.all(candidates.map(async (c, idx) => {
    const tag = `${q.id}.${idx + 1}`;
    try {
      // fetch full text
      const doc = await ikapi('get_case_document', { tid: c.tid }, 180000);
      const text = (doc?.text || doc?.body || doc?.raw || '').toString();
      if (text.length < 500) {
        return { tid: c.tid, title: c.title, error: 'text-too-short', text_len: text.length };
      }

      // Agent 2 (read through lens)
      const a2 = await agent2_read(soul.soul_question, text);
      if (!a2?.summary_for_user) {
        return { tid: c.tid, title: c.title, error: 'agent2-failed', text_len: text.length };
      }

      // Short-circuit: if Agent 2 says "not at all", skip Agent 3
      if (a2.addresses_soul_question === 'not at all') {
        return {
          tid: c.tid, title: c.title, court: c.court, date: c.date,
          text_len: text.length,
          a2_addresses: a2.addresses_soul_question,
          verdict: 'INAPPLICABLE',
          confidence: 10,
          reason: 'Agent 2 short-circuit — judgment does not address soul-question',
          summary: a2.summary_for_user
        };
      }

      // Agent 3 (impartial verdict)
      const a3 = await agent3_verdict(soul.soul_question, a2.summary_for_user);
      return {
        tid: c.tid, title: c.title, court: c.court, date: c.date,
        text_len: text.length,
        a2_addresses: a2.addresses_soul_question,
        verdict: a3.verdict,
        confidence: a3.confidence,
        reason: a3.reason,
        advocate_use: a3.advocate_use,
        summary: a2.summary_for_user
      };
    } catch (e) {
      return { tid: c.tid, title: c.title, error: e.message };
    }
  }));

  // Tally
  const applicable = verifications.filter(v => v.verdict === 'APPLICABLE').length;
  const tangential = verifications.filter(v => v.verdict === 'TANGENTIAL').length;
  const inapplicable = verifications.filter(v => v.verdict === 'INAPPLICABLE').length;
  const errored = verifications.filter(v => v.error).length;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);

  console.log(`     ✅ ${applicable} APPLICABLE  ⚠ ${tangential} TANGENTIAL  ❌ ${inapplicable} INAPPLICABLE  💥 ${errored} error  (${elapsed}s)`);
  verifications.forEach((v, i) => {
    const emoji = v.error ? '💥'
                : v.verdict === 'APPLICABLE' ? '✅'
                : v.verdict === 'TANGENTIAL' ? '⚠'
                : '❌';
    const headline = (v.title || '?').slice(0, 70);
    console.log(`       ${emoji} #${i + 1} ${v.court || '?'} ${v.date || '?'} | ${headline}`);
    if (v.reason) console.log(`           ${v.reason.slice(0, 110)}`);
  });

  return { ...q, soul, verifications, summary: { applicable, tangential, inapplicable, errored, elapsed_s: +elapsed } };
}

// ── Driver ────────────────────────────────────────────────────────

(async () => {
  console.log(`MULTI-QUERY 3-AGENT TRACE`);
  console.log(`Queries: ${QUERIES.length}   Candidates per query: ${N_CANDIDATES_PER_QUERY}`);
  console.log(`Total expected: ${QUERIES.length} soul calls + ${QUERIES.length * N_CANDIDATES_PER_QUERY} agent2/agent3 chains`);
  const t0 = Date.now();
  const results = [];
  for (const q of QUERIES) {
    const r = await traceQuery(q);
    results.push(r);
    fs.writeFileSync(
      path.join(__dirname, 'results', 'trace-multi-latest.json'),
      JSON.stringify(results, null, 2)
    );
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`OVERALL SUMMARY`);
  console.log('═'.repeat(70));
  console.log(`Total time: ${elapsed}s`);
  console.log();
  console.log('| ID  | Area                              | ✅ | ⚠ | ❌ | 💥 | s  |');
  console.log('|-----|-----------------------------------|----|----|----|----|-----|');
  for (const r of results) {
    const s = r.summary || { applicable: '-', tangential: '-', inapplicable: '-', errored: '-', elapsed_s: '-' };
    console.log(`| ${r.id} | ${(r.area || '').padEnd(33)} |  ${s.applicable} |  ${s.tangential} |  ${s.inapplicable} |  ${s.errored} | ${s.elapsed_s} |`);
  }
  console.log();
  const totalApp = results.reduce((s, r) => s + (r.summary?.applicable || 0), 0);
  const totalTan = results.reduce((s, r) => s + (r.summary?.tangential || 0), 0);
  const totalInap = results.reduce((s, r) => s + (r.summary?.inapplicable || 0), 0);
  const totalErr = results.reduce((s, r) => s + (r.summary?.errored || 0), 0);
  const totalCand = results.reduce((s, r) => s + (r.verifications?.length || 0), 0);
  console.log(`Across ${totalCand} verified candidates:`);
  console.log(`  ✅ APPLICABLE:    ${totalApp}  (${(100 * totalApp / totalCand).toFixed(0)}%)`);
  console.log(`  ⚠ TANGENTIAL:    ${totalTan}  (${(100 * totalTan / totalCand).toFixed(0)}%)`);
  console.log(`  ❌ INAPPLICABLE:  ${totalInap}  (${(100 * totalInap / totalCand).toFixed(0)}%)`);
  console.log(`  💥 errored:      ${totalErr}`);

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.writeFileSync(
    path.join(__dirname, 'results', `trace-multi-${ts}.json`),
    JSON.stringify(results, null, 2)
  );
  console.log(`\nFull results: scripts/benchmark/results/trace-multi-${ts}.json`);
})();
