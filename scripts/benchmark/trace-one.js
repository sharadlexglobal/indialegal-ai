#!/usr/bin/env node
/**
 * Live trace of the winning pipeline on ONE complex query.
 * Shows each sub-step's output so we can SEE what the pipeline does
 * with a real chamber-style multi-statute query.
 */
const fetch = require('node-fetch');

const Q = `Mere client ke against PMLA aur predicate offence 420 IPC dono mein FIR + ECIR hai. Agar predicate offence acquittal mein quash ho jaaye, toh PMLA continue ho sakti hai independently? Vijay Madanlal ke baad ka latest SC view`;

const IKAPI = 'https://ikapi.onrender.com/mcp';
const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const MODEL = 'deepseek-v4-flash';

async function deepseekJson(messages) {
  const r = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_KEY}` },
    body: JSON.stringify({
      model: MODEL, messages, response_format: { type: 'json_object' }, temperature: 0
    })
  });
  const j = await r.json();
  return JSON.parse(j.choices?.[0]?.message?.content || '{}');
}

async function ikapi(name, args) {
  const r = await fetch(IKAPI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  });
  const j = await r.json();
  const text = j.result?.content?.[0]?.text || '';
  try { return JSON.parse(text); } catch { return {}; }
}

(async () => {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('USER QUERY:');
  console.log(Q);
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // ── Step 1: DeepSeek decode ──
  console.log('▶ STEP 1 — DeepSeek V4 Flash decodes natural language → clean intent\n');
  const t1 = Date.now();
  const decoded = await deepseekJson([{
    role: 'user',
    content: `You are converting an Indian advocate's natural Hindi/Hinglish question into a CLEAN Indian Kanoon search.

USER: ${Q}

Court codes: supremecourt, delhi, bombay, kolkata, chennai, allahabad, andhra, chattisgarh, gauhati, jammu, srinagar, kerala, lucknow, orissa, uttaranchal, gujarat, himachal_pradesh, jharkhand, karnataka, madhyapradesh, patna, punjab, rajasthan, sikkim, meghalaya, delhidc, itat, cci, consumer, cat, drat, sebisat, greentribunal, aptel, highcourts, tribunals, judgments.

Return strict JSON:
{
  "statute": "<exact, e.g. 'PMLA', 'IPC', 'CrPC'>",
  "section": "<just the number e.g. '482', '45', '3'>",
  "court_code": "<exact code>",
  "stage": "<bail | quash | trial | appeal | other>",
  "clean_keywords": "<3-7 word legal keyword phrase>",
  "is_recent_query": <true|false>
}`
  }]);
  console.log(`  ⏱  ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  console.log('  Decoded intent:');
  console.log('  ', JSON.stringify(decoded, null, 2).split('\n').join('\n   '));
  console.log();

  // ── Step 2: IKAPI search ──
  console.log('▶ STEP 2 — IKAPI search with clean query (over-fetch 20)\n');
  const ik_query = [decoded.section ? `Section ${decoded.section}` : '',
                    decoded.statute || '',
                    decoded.clean_keywords || ''].filter(Boolean).join(' ');
  console.log(`  IKAPI args: query="${ik_query}", doctype="${decoded.court_code}", max_results=20${decoded.is_recent_query ? ', sort=mostrecent' : ''}`);
  const t2 = Date.now();
  const res = await ikapi('search_cases', {
    query: ik_query,
    doctype: decoded.court_code,
    ...(decoded.is_recent_query ? { sort: 'mostrecent' } : {}),
    max_results: 20
  });
  const candidates = res.results || [];
  console.log(`  ⏱  ${((Date.now() - t2) / 1000).toFixed(1)}s — fetched ${candidates.length} candidates`);
  console.log('\n  Raw IKAPI ranking (top 20 as returned by IKAPI relevance):');
  candidates.forEach((c, i) => {
    console.log(`    ${(i + 1).toString().padStart(2)}. ${(c.court || '?').slice(0, 22).padEnd(22)} ${(c.date || '?').slice(0, 10)} | ${(c.title || '?').slice(0, 70)}`);
  });
  console.log();

  // ── Step 3: DeepSeek reranks all 20 ──
  console.log('▶ STEP 3 — DeepSeek scores all 20 candidates (4-dimension, parallel)\n');
  const t3 = Date.now();
  const scored = await Promise.all(candidates.map(async (c) => {
    const s = await deepseekJson([{
      role: 'user',
      content: `Score this Indian Kanoon search result for the advocate's intent (0-10 each):

INTENT:
  statute: ${decoded.statute}, section: ${decoded.section}
  stage: ${decoded.stage}
  keywords: ${decoded.clean_keywords}

CANDIDATE:
  Title: ${c.title}
  Court: ${c.court}, Date: ${c.date || c.judgment_date}
  Snippet: ${(c.snippet || c.headline || '').slice(0, 700)}

Return strict JSON: {"provision_match": int, "stage_match": int, "citable_quote": int, "recency": int, "overall": int (0-10), "verdict": "<one-line reason>"}`
    }]);
    return { ...c, _score: s?.overall ?? 0, _verdict: s?.verdict || '', _details: s };
  }));
  scored.sort((a, b) => (b._score || 0) - (a._score || 0));
  console.log(`  ⏱  ${((Date.now() - t3) / 1000).toFixed(1)}s — scored all 20\n`);

  // ── Step 4: Top 5 + cut-off discussion ──
  console.log('▶ STEP 4 — Top 5 after DeepSeek rerank:\n');
  scored.slice(0, 5).forEach((s, i) => {
    console.log(`  🏆 #${i + 1}  Score: ${s._score}/10 | ${(s.court || '?').slice(0, 22)} ${(s.date || s.judgment_date || '?').slice(0, 10)}`);
    console.log(`        ${(s.title || '?').slice(0, 90)}`);
    console.log(`        verdict: ${(s._verdict || '').slice(0, 110)}`);
    console.log(`        breakdown: provision=${s._details?.provision_match}, stage=${s._details?.stage_match}, citable=${s._details?.citable_quote}, recency=${s._details?.recency}`);
    console.log();
  });

  console.log('▶ STEP 5 — What got dropped (bottom 5 of the 20):\n');
  scored.slice(-5).forEach((s, i) => {
    console.log(`  ❌ #${15 + i + 1} Score: ${s._score}/10 | ${(s.court || '?').slice(0, 22)} ${(s.date || s.judgment_date || '?').slice(0, 10)}`);
    console.log(`        ${(s.title || '?').slice(0, 90)}`);
    console.log(`        why dropped: ${(s._verdict || '').slice(0, 110)}`);
    console.log();
  });

  // ── Headline summary ──
  const top5_avg = scored.slice(0, 5).reduce((s, x) => s + x._score, 0) / 5;
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`Average top-5 score: ${top5_avg.toFixed(2)}/10`);
  console.log(`Total pipeline time: ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  console.log('═══════════════════════════════════════════════════════════════════');
})();
