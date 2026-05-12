#!/usr/bin/env node
/**
 * IKAPI quality benchmark.
 *
 * For each natural-language query (30 daily-practice scenarios), run THREE
 * search setups against the IKAPI MCP:
 *
 *   A. current pipeline:  doctype=highcourts/judgments, citation-sort,
 *                         mechanical keyword concat (the way the prod
 *                         pipeline does it today)
 *   B. recency-sorted:    same query, sort=mostrecent
 *   C. statute-only:      raw "Section X StatuteName" keywords with
 *                         doctype from expected_court (the dumbest baseline)
 *
 * For each top-5 candidate in each setup, ask DeepSeek V4 Flash to score:
 *   - provision_match  (0-10) does the headnote actually address the
 *                              specific section/provision asked
 *   - stage_match      (0-10) same procedural stage (bail / trial /
 *                              quash / etc.)
 *   - citable_quote    (0-10) is there a usable holding/ratio for an
 *                              advocate to cite in the asked matter
 *   - recency          (0-10) recent enough to still be good law
 *
 * Output: ./results/<timestamp>.{json,md} with raw data + diagnostic.
 */

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const IKAPI = process.env.IKAPI_MCP_URL || 'https://ikapi.onrender.com/mcp';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-v4-flash';

if (!DEEPSEEK_KEY) { console.error('DEEPSEEK_API_KEY required'); process.exit(1); }

const queries = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'queries.json'), 'utf-8')
);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── IKAPI MCP wrapper ────────────────────────────────────────────────

async function ikapi(name, args) {
  const body = {
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name, arguments: args }
  };
  const r = await fetch(IKAPI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body)
  });
  const j = await r.json();
  if (j.error) throw new Error(`IKAPI ${name}: ${JSON.stringify(j.error)}`);
  const text = j.result?.content?.[0]?.text || '';
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// ── Three search setups ────────────────────────────────────────────────

function setupA(q) {
  // current prod-style: pass the natural language verbatim, doctype loose
  return {
    query: q.natural,
    doctype: q.expected_court === 'supremecourt' ? 'supremecourt'
            : q.expected_court === 'delhi' ? 'highcourts'    // loose, like prod
            : 'judgments',
    max_results: 5
  };
}

function setupB(q) {
  // recency-sorted, same loose doctype
  return {
    query: q.natural,
    doctype: q.expected_court === 'supremecourt' ? 'supremecourt'
            : q.expected_court === 'delhi' ? 'highcourts'
            : 'judgments',
    sort: 'mostrecent',
    max_results: 5
  };
}

function setupC(q) {
  // strict statute-keyword baseline, exact court
  const key = `Section ${q.expected_section.split(/[\s,]/)[0]} ${q.expected_statute}`;
  return {
    query: key,
    doctype: q.expected_court,   // exact court code (delhi, supremecourt)
    max_results: 5
  };
}

// ── DeepSeek scorer ────────────────────────────────────────────────────

async function deepseekScore(query, candidate) {
  const prompt = `You are evaluating whether an Indian Kanoon search result actually answers a practising advocate's question.

USER'S QUESTION:
${query.natural}

EXPECTED PROVISION: ${query.expected_statute} Section ${query.expected_section}
EXPECTED STAGE: ${query.expected_stage}

SEARCH RESULT CANDIDATE:
Title: ${candidate.title || '?'}
Court: ${candidate.court || '?'}
Date: ${candidate.date || candidate.judgment_date || '?'}
Snippet: ${(candidate.snippet || candidate.headline || '').slice(0, 800)}

Score this candidate on FOUR dimensions, each 0-10:

1. provision_match: Does the snippet actually discuss the EXPECTED PROVISION above? 10 = direct, 5 = adjacent area, 0 = unrelated.
2. stage_match: Is this judgment about the SAME procedural stage (bail vs trial vs quash vs maintenance etc.)? 10 = exact stage, 0 = wrong stage.
3. citable_quote: Will an advocate find a usable ratio/holding here for the asked matter? 10 = clear principle, 0 = no holding.
4. recency: Newer is better for "current law" questions (default >2018 is good; landmark older cases also fine if foundational).

Reply with strict JSON only:
{
  "provision_match": <int>,
  "stage_match": <int>,
  "citable_quote": <int>,
  "recency": <int>,
  "overall": <int 0-10, weighted by your judgment>,
  "verdict": "<one short sentence saying what went right or wrong about this match>"
}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(DEEPSEEK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DEEPSEEK_KEY}`
        },
        body: JSON.stringify({
          model: DEEPSEEK_MODEL,
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          temperature: 0
        })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
      const txt = j.choices?.[0]?.message?.content || '{}';
      return JSON.parse(txt);
    } catch (e) {
      console.warn(`  DeepSeek score retry ${attempt + 1}: ${e.message}`);
      await sleep(1500 * (attempt + 1));
    }
  }
  return { provision_match: 0, stage_match: 0, citable_quote: 0, recency: 0, overall: 0, verdict: 'scoring failed' };
}

// ── Main loop ────────────────────────────────────────────────────────

async function runQuery(q) {
  console.log(`\n── ${q.id} ${q.area} ──`);
  console.log(`   ${q.natural.slice(0, 80)}...`);

  const setups = { A: setupA(q), B: setupB(q), C: setupC(q) };
  const out = { id: q.id, area: q.area, natural: q.natural, setups: {} };

  // run all 3 setups in parallel
  const searches = await Promise.allSettled(
    Object.entries(setups).map(async ([key, args]) => {
      const res = await ikapi('search_cases', args);
      return [key, args, res?.results || []];
    })
  );

  for (const s of searches) {
    if (s.status !== 'fulfilled') {
      console.warn(`  setup failed: ${s.reason?.message}`);
      continue;
    }
    const [key, args, results] = s.value;
    const top = results.slice(0, 5);
    console.log(`   ${key}: ${top.length} candidates (doctype=${args.doctype}${args.sort ? ', sort=' + args.sort : ''})`);

    const scored = [];
    // score top-3 of each setup (saves cost; tails rarely matter)
    for (const cand of top.slice(0, 3)) {
      const score = await deepseekScore(q, cand);
      scored.push({
        tid: cand.tid, title: cand.title?.slice(0, 80),
        court: cand.court, date: cand.date || cand.judgment_date,
        cited_by: cand.cited_by, ...score
      });
      console.log(`     - ${cand.court?.slice(0, 25)} ${cand.date?.slice(0, 10)} | overall=${score.overall} (${score.verdict?.slice(0, 70)})`);
    }
    out.setups[key] = { args, scored };
  }
  return out;
}

// ── Reporting ───────────────────────────────────────────────────────────

function aggregate(results) {
  const stats = { A: [], B: [], C: [] };
  for (const r of results) {
    for (const [k, v] of Object.entries(r.setups)) {
      const avg = v.scored.length
        ? v.scored.reduce((s, x) => s + (x.overall || 0), 0) / v.scored.length
        : 0;
      stats[k].push({ id: r.id, area: r.area, avg, top: v.scored[0]?.overall || 0 });
    }
  }
  return stats;
}

function buildMarkdown(results, stats) {
  const lines = [];
  lines.push('# IKAPI Quality Benchmark');
  lines.push(`Run: ${new Date().toISOString()}`);
  lines.push(`Queries: ${results.length}  ·  Setups: A (prod), B (recency), C (statute-only)\n`);

  // overall averages
  lines.push('## Headline numbers\n');
  lines.push('| Setup | Avg overall (top-3) | Avg overall (top-1) | What it is |');
  lines.push('|---|---|---|---|');
  for (const k of ['A', 'B', 'C']) {
    const arr = stats[k];
    const avgTop3 = (arr.reduce((s, x) => s + x.avg, 0) / arr.length).toFixed(2);
    const avgTop1 = (arr.reduce((s, x) => s + x.top, 0) / arr.length).toFixed(2);
    const label = k === 'A' ? 'Current pipeline (loose doctype, no sort)'
                : k === 'B' ? 'Recency-sorted'
                : 'Strict statute keyword + exact court code';
    lines.push(`| ${k} | ${avgTop3} | ${avgTop1} | ${label} |`);
  }
  lines.push('');

  // worst cases
  lines.push('## Worst-performing queries (Setup A — current prod)\n');
  const worst = [...stats.A].sort((a, b) => a.avg - b.avg).slice(0, 10);
  lines.push('| ID | Area | Avg | Top-1 |');
  lines.push('|---|---|---|---|');
  for (const w of worst) lines.push(`| ${w.id} | ${w.area} | ${w.avg.toFixed(1)} | ${w.top} |`);
  lines.push('');

  // per-query breakdown
  lines.push('## Per-query breakdown\n');
  for (const r of results) {
    lines.push(`### ${r.id}  ${r.area}`);
    lines.push(`Question: ${r.natural}\n`);
    lines.push('| Setup | Doctype | Sort | Top hit | overall | verdict |');
    lines.push('|---|---|---|---|---|---|');
    for (const k of ['A', 'B', 'C']) {
      const v = r.setups[k];
      if (!v) { lines.push(`| ${k} | — | — | — | — | failed |`); continue; }
      const t = v.scored[0];
      lines.push(`| ${k} | ${v.args.doctype} | ${v.args.sort || '-'} | ${(t?.title || '?').slice(0, 50)} (${t?.court?.slice(0, 12)}, ${t?.date?.slice(0, 7)}) | ${t?.overall ?? '-'} | ${(t?.verdict || '').slice(0, 90)} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ── Entry point ────────────────────────────────────────────────────────

(async () => {
  console.log(`Benchmark: ${queries.length} queries x 3 setups x top-3 scored`);
  const results = [];
  // run queries 4-at-a-time so we don't hammer IKAPI
  const chunkSize = 4;
  for (let i = 0; i < queries.length; i += chunkSize) {
    const batch = queries.slice(i, i + chunkSize);
    const r = await Promise.all(batch.map(runQuery));
    results.push(...r);
    // checkpoint to disk after every batch
    fs.writeFileSync(
      path.join(__dirname, 'results', `latest.json`),
      JSON.stringify(results, null, 2)
    );
  }
  const stats = aggregate(results);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'results', `${ts}.json`), JSON.stringify({ stats, results }, null, 2));
  fs.writeFileSync(path.join(__dirname, 'results', `${ts}.md`), buildMarkdown(results, stats));
  console.log(`\nDone. Report: scripts/benchmark/results/${ts}.md`);

  // headline summary to stdout
  console.log('\n=== HEADLINE NUMBERS ===');
  for (const k of ['A', 'B', 'C']) {
    const arr = stats[k];
    const avgTop3 = (arr.reduce((s, x) => s + x.avg, 0) / arr.length).toFixed(2);
    const avgTop1 = (arr.reduce((s, x) => s + x.top, 0) / arr.length).toFixed(2);
    console.log(`  Setup ${k}: avg top-3 = ${avgTop3}, avg top-1 = ${avgTop1}`);
  }
})();
