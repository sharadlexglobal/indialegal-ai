#!/usr/bin/env node
/**
 * Manual trace of the proposed 3-agent verification pipeline on ONE
 * complex query. Each agent runs explicitly so we can SEE if reading
 * the full judgment text changes the relevance verdict vs the old
 * snippet-only scoring.
 *
 *   Agent 1 (DeepSeek):  natural query -> soul-question
 *   Agent 2 (DeepSeek):  full judgment text through soul-lens -> summary
 *   Agent 3 (DeepSeek):  soul + summary -> APPLICABLE/TANGENTIAL/INAPPLICABLE
 *
 * NOTE: Agent 3 only sees soul + summary, never the full judgment —
 * by design, so it cannot stretch imagination.
 */
const fetch = require('node-fetch');

const Q = `Mere client ke against PMLA aur predicate offence 420 IPC dono mein FIR + ECIR hai. Agar predicate offence acquittal mein quash ho jaaye, toh PMLA continue ho sakti hai independently? Vijay Madanlal ke baad ka latest SC view`;

const IKAPI = 'https://ikapi.onrender.com/mcp';
const DS_URL = 'https://api.deepseek.com/v1/chat/completions';
const DS_KEY = process.env.DEEPSEEK_API_KEY;
const DS_MODEL = 'deepseek-v4-flash';

async function ds(messages, label = '') {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(DS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DS_KEY}` },
        body: JSON.stringify({
          model: DS_MODEL, messages,
          response_format: { type: 'json_object' }, temperature: 0
        })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
      return JSON.parse(j.choices?.[0]?.message?.content || '{}');
    } catch (e) {
      console.warn(`  [${label}] retry ${i + 1}: ${e.message}`);
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
  return null;
}

async function ikapi(name, args) {
  const r = await fetch(IKAPI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  });
  const j = await r.json();
  const text = j.result?.content?.[0]?.text || '';
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// ── AGENT 1 — Soul Extractor ───────────────────────────────────

async function agent1_soul(naturalQuery) {
  const prompt = `You extract the SOUL of an Indian advocate's natural-language legal question.
The "soul" is the precise legal-doctrinal question that, if answered by a
judgment, would actually solve the user's problem. Not keywords —
the crystallized question.

USER: ${naturalQuery}

Output strict JSON:
{
  "legal_area": "...",
  "exact_provision": "...",
  "procedural_stage": "...",
  "core_question": "<one sentence>",
  "user_facts": ["..."],
  "what_user_wants_to_do": "...",
  "soul_question": "<the form a judgment must directly answer to be useful>"
}`;
  return await ds([{ role: 'user', content: prompt }], 'soul');
}

// ── AGENT 2 — Judgment Reader (lens) ───────────────────────────

async function agent2_read(soulQuestion, fullJudgmentText) {
  const text = fullJudgmentText.slice(0, 50000);  // cap at 50K chars
  const prompt = `You read the full text of an Indian Kanoon judgment THROUGH THE LENS of
a single soul-question. Report ONLY what the judgment says about THIS
question. Do not summarize the whole judgment. If the judgment does not
address the soul-question, say so plainly. Do not invent connections.

SOUL_QUESTION:
${soulQuestion}

JUDGMENT_FULL_TEXT (truncated to 50K chars):
${text}

Output strict JSON:
{
  "discusses_same_provision": true|false,
  "addresses_soul_question": "directly" | "tangentially" | "not at all",
  "court_holding": "<1-2 sentences — ON THIS QUESTION>",
  "relevant_quotes": ["<verbatim quote 1>", "<verbatim quote 2>"],
  "for_or_against_user": "supports user's position" | "against user's position" | "neutral" | "not applicable",
  "summary_for_user": "<2-3 sentences from the angle of soul-question only>"
}

Rules:
- Quote verbatim, do not paraphrase quotes
- If addresses_soul_question is "not at all", relevant_quotes must be []
- summary_for_user must NEVER include positions the judgment did not actually take`;
  return await ds([{ role: 'user', content: prompt }], 'read');
}

// ── AGENT 3 — Impartial Gatekeeper ─────────────────────────────

async function agent3_verdict(soulQuestion, summaryForUser) {
  const prompt = `You are an IMPARTIAL gatekeeper. You receive only:
  1. A soul-question
  2. A summary from another agent
You do NOT see the full judgment, the court name, the date, the title.

Decide if the judgment AS DESCRIBED IN THE SUMMARY is STRAIGHT-TO-THE-POINT
applicable to the advocate's question.

THREE VERDICTS — be strict:

  APPLICABLE   — Summary shows judgment has a CLEAR HOLDING that directly
                 answers the soul-question. Advocate can cite it as
                 authority on this exact point.
  TANGENTIAL   — Same legal area but does not directly answer the
                 soul-question. Useful background, NOT citable for exact
                 point.
  INAPPLICABLE — Different question / provision / stage. Should NOT be
                 included.

ZERO TOLERANCE:
  - No "could be applied by analogy" — TANGENTIAL at best
  - No "general principle suggests" — TANGENTIAL
  - No "implies but does not say" — INAPPLICABLE
  - If summary says "does not address" — INAPPLICABLE

INPUT:
  soul_question: ${soulQuestion}
  summary_for_user: ${summaryForUser}

Output strict JSON:
{
  "verdict": "APPLICABLE" | "TANGENTIAL" | "INAPPLICABLE",
  "confidence": 0-10,
  "reason": "<ONE sentence — why this verdict>",
  "advocate_use": "<if APPLICABLE: one sentence on how to cite/use it. else empty string>"
}`;
  return await ds([{ role: 'user', content: prompt }], 'verdict');
}

// ── Main flow ──────────────────────────────────────────────────

(async () => {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('USER QUERY:');
  console.log(Q);
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log('▶ AGENT 1 — Soul Extractor\n');
  const t1 = Date.now();
  const soul = await agent1_soul(Q);
  console.log(`  ⏱  ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  console.log(JSON.stringify(soul, null, 2).split('\n').map(l => '  ' + l).join('\n'));
  console.log();

  // ── Fetch candidates via IKAPI ──
  console.log('▶ IKAPI search using clean keywords from soul\n');
  const ik_query = `Section ${soul.exact_provision.match(/\d+/)?.[0] || '3'} PMLA predicate offence quash independent`;
  console.log(`  query: "${ik_query}"`);
  const res = await ikapi('search_cases', {
    query: ik_query, doctype: 'supremecourt', max_results: 10
  });
  const candidates = res.results || [];
  console.log(`  ${candidates.length} candidates fetched\n`);
  candidates.slice(0, 5).forEach((c, i) => {
    console.log(`    ${i + 1}. tid=${c.tid} | ${c.court} ${c.date} | ${c.title.slice(0, 80)}`);
  });
  console.log();

  // ── For top 5: full text → Agent 2 → Agent 3 ──
  const top5 = candidates.slice(0, 5);
  console.log(`▶ Running 3-agent verification on top 5 candidates (parallel)\n`);

  const t2 = Date.now();
  const results = await Promise.all(top5.map(async (c, idx) => {
    const tag = `[${idx + 1}/${top5.length}] tid=${c.tid}`;
    try {
      const doc = await ikapi('get_case_document', { tid: c.tid }, { timeoutMs: 120000 });
      const text = (doc?.text || doc?.body || doc?.raw || '').toString();
      if (text.length < 500) return { ...c, error: 'judgment text too short', text_len: text.length };

      console.log(`  ${tag} — fetched ${text.length} chars, running Agent 2…`);
      const a2 = await agent2_read(soul.soul_question, text);

      console.log(`  ${tag} — Agent 2 done, running Agent 3…`);
      const a3 = await agent3_verdict(soul.soul_question, a2?.summary_for_user || '(no summary)');

      return { ...c, text_len: text.length, agent2: a2, agent3: a3 };
    } catch (e) {
      return { ...c, error: e.message };
    }
  }));
  console.log(`\n  All 5 done in ${((Date.now() - t2) / 1000).toFixed(0)}s\n`);

  // ── Print results ──
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('VERIFIED CANDIDATES — 3-agent verdict');
  console.log('═══════════════════════════════════════════════════════════════\n');

  results.forEach((r, i) => {
    console.log(`#${i + 1}  tid=${r.tid}  ${r.court || '?'}  ${r.date || '?'}`);
    console.log(`    ${(r.title || '?').slice(0, 90)}`);
    console.log(`    text fetched: ${r.text_len || 0} chars`);
    if (r.error) {
      console.log(`    ❌ ERROR: ${r.error}`);
    } else {
      const verdict = r.agent3?.verdict || 'UNKNOWN';
      const emoji = verdict === 'APPLICABLE' ? '✅'
                  : verdict === 'TANGENTIAL' ? '⚠'
                  : verdict === 'INAPPLICABLE' ? '❌'
                  : '?';
      console.log(`    ${emoji} Agent 3 verdict: ${verdict} (confidence ${r.agent3?.confidence}/10)`);
      console.log(`       reason: ${r.agent3?.reason || ''}`);
      if (r.agent3?.advocate_use) {
        console.log(`       advocate use: ${r.agent3.advocate_use}`);
      }
      console.log(`    Agent 2 lens-summary:`);
      console.log(`       "${(r.agent2?.summary_for_user || '').slice(0, 220)}"`);
      console.log(`       (addresses: ${r.agent2?.addresses_soul_question}, for_user: ${r.agent2?.for_or_against_user})`);
    }
    console.log();
  });

  const applicable = results.filter(r => r.agent3?.verdict === 'APPLICABLE').length;
  const tangential = results.filter(r => r.agent3?.verdict === 'TANGENTIAL').length;
  const inapplicable = results.filter(r => r.agent3?.verdict === 'INAPPLICABLE').length;
  const errored = results.filter(r => r.error).length;

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`SUMMARY:`);
  console.log(`  ✅ APPLICABLE:   ${applicable} / 5`);
  console.log(`  ⚠ TANGENTIAL:   ${tangential} / 5`);
  console.log(`  ❌ INAPPLICABLE: ${inapplicable} / 5`);
  if (errored) console.log(`  💥 errored:     ${errored} / 5`);
  console.log(`Total time: ${((Date.now() - t1) / 1000).toFixed(0)}s`);
  console.log('═══════════════════════════════════════════════════════════════');
})();
