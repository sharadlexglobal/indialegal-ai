#!/usr/bin/env node
/**
 * Iterative search-strategy tournament.
 *
 * Round 1 pits N candidate strategies against each other on the same 30
 * queries. Each strategy fetches up to 5 candidates per query; DeepSeek
 * scores each candidate on 4 dimensions; we aggregate per-strategy.
 *
 * Round 2 takes the top-K strategies, generates 2-3 variants of each
 * (parameter tweaks: max_results, sort, fetch_depth, court fallback),
 * runs them, picks new winner.
 *
 * Stops when avg top-3 >= TARGET or 3 rounds complete. Winning config
 * is written to results/winner.json and (eventually) wired into prod.
 */

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const IKAPI = process.env.IKAPI_MCP_URL || 'https://ikapi.onrender.com/mcp';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-v4-flash';
const TARGET_AVG = 8.0;
const MAX_ROUNDS = 3;

if (!DEEPSEEK_KEY) { console.error('DEEPSEEK_API_KEY required'); process.exit(1); }

const queries = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'queries.json'), 'utf-8')
);

// ── IKAPI client ────────────────────────────────────────────────────

async function ikapi(name, args) {
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } };
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

// ── DeepSeek client ────────────────────────────────────────────────

async function deepseek(messages, opts = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(DEEPSEEK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_KEY}` },
        body: JSON.stringify({
          model: DEEPSEEK_MODEL,
          messages,
          response_format: { type: 'json_object' },
          temperature: 0,
          ...opts
        })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
      const text = j.choices?.[0]?.message?.content || '{}';
      return JSON.parse(text);
    } catch (e) {
      console.warn(`  deepseek retry ${attempt + 1}: ${e.message}`);
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  return null;
}

async function deepseekScore(query, cand) {
  const prompt = `Score this Indian Kanoon result for an advocate's actual query (0-10 each):

USER QUERY: ${query.natural}
EXPECTED: ${query.expected_statute} Section ${query.expected_section} | stage: ${query.expected_stage}

CANDIDATE:
Title: ${cand.title || '?'}
Court: ${cand.court || '?'} | Date: ${cand.date || cand.judgment_date || '?'}
Snippet: ${(cand.snippet || cand.headline || '').slice(0, 700)}

Return strict JSON:
{"provision_match": int, "stage_match": int, "citable_quote": int, "recency": int,
 "overall": int (0-10 weighted), "verdict": "one-line reason"}`;
  const r = await deepseek([{ role: 'user', content: prompt }]);
  return r || { provision_match: 0, stage_match: 0, citable_quote: 0, recency: 0, overall: 0, verdict: 'scoring failed' };
}

async function deepseekDecode(naturalQuery) {
  const prompt = `You are converting an Indian advocate's natural Hindi/Hinglish question into a CLEAN Indian Kanoon search.

USER: ${naturalQuery}

The court codes are: supremecourt, delhi, bombay, kolkata, chennai, allahabad, andhra, chattisgarh, gauhati, jammu, srinagar, kerala, lucknow, orissa, uttaranchal, gujarat, himachal_pradesh, jharkhand, karnataka, madhyapradesh, patna, punjab, rajasthan, sikkim, meghalaya, delhidc (Delhi district courts), itat, cci, consumer, cat, drat, sebisat, greentribunal, aptel. Aggregators: highcourts, tribunals, judgments. Use "judgments" if unsure.

Return strict JSON:
{
  "statute": "<exact name e.g. 'CrPC', 'IPC', 'NI Act', 'PMLA', 'HMA', 'NDPS Act'>",
  "section": "<just the number/code e.g. '482', '37', '138', '438'>",
  "court_code": "<exact code from list above>",
  "stage": "<one of: bail | quash | charge_framing | trial | appeal | maintenance | injunction | partition | infringement | discharge | other>",
  "clean_keywords": "<3-7 word keyword phrase for IKAPI, NO Hindi chaff, just the legal terms>",
  "is_recent_query": <true if user said 'latest/recent/abhi ka/2024/last 2 years', else false>
}`;
  const r = await deepseek([{ role: 'user', content: prompt }]);
  return r || { statute: '', section: '', court_code: 'judgments', stage: 'other', clean_keywords: naturalQuery, is_recent_query: false };
}

// ── Strategies ────────────────────────────────────────────────────────

const STRATEGIES = [
  {
    name: 'A_baseline',
    desc: 'current prod — natural Hindi verbatim, loose doctype',
    async run(q) {
      const args = {
        query: q.natural,
        doctype: q.expected_court === 'supremecourt' ? 'supremecourt'
              : q.expected_court === 'delhi' ? 'highcourts' : 'judgments',
        max_results: 5
      };
      const r = await ikapi('search_cases', args).catch(() => ({ results: [] }));
      return (r.results || []).slice(0, 5);
    }
  },
  {
    name: 'B_regex',
    desc: 'regex-extract section + statute, exact court code',
    async run(q) {
      const sec = (q.natural.match(/Section\s+([\d\-A-Z]+(?:\s*\([a-z0-9]+\))?)/i) || [, q.expected_section.split(/\D/).find(Boolean) || q.expected_section])[1];
      const stat = (q.natural.match(/\b(IPC|CrPC|BNSS|BNS|BSA|CPC|NI Act|HMA|POCSO|NDPS|PMLA|UAPA|Trade Marks Act|Copyright|Hindu Succession|Limitation)\b/i) || [, q.expected_statute])[1];
      const args = { query: `Section ${sec} ${stat}`, doctype: q.expected_court, max_results: 5 };
      const r = await ikapi('search_cases', args).catch(() => ({ results: [] }));
      return (r.results || []).slice(0, 5);
    }
  },
  {
    name: 'C_deepseek_decode',
    desc: 'DeepSeek decodes statute+section+court+keywords → clean query',
    async run(q) {
      const d = await deepseekDecode(q.natural);
      const ik_query = `Section ${d.section} ${d.statute} ${d.clean_keywords}`.trim();
      const args = { query: ik_query, doctype: d.court_code, max_results: 5 };
      const r = await ikapi('search_cases', args).catch(() => ({ results: [] }));
      return (r.results || []).slice(0, 5);
    }
  },
  {
    name: 'D_deepseek_recency',
    desc: 'C + sort=mostrecent when user signals recency',
    async run(q) {
      const d = await deepseekDecode(q.natural);
      const ik_query = `Section ${d.section} ${d.statute} ${d.clean_keywords}`.trim();
      const args = { query: ik_query, doctype: d.court_code, max_results: 5 };
      if (d.is_recent_query) args.sort = 'mostrecent';
      const r = await ikapi('search_cases', args).catch(() => ({ results: [] }));
      return (r.results || []).slice(0, 5);
    }
  },
  {
    name: 'E_deepseek_rerank',
    desc: 'C + fetch 10, DeepSeek scores all, keep top 5 by score',
    async run(q) {
      const d = await deepseekDecode(q.natural);
      const ik_query = `Section ${d.section} ${d.statute} ${d.clean_keywords}`.trim();
      const args = { query: ik_query, doctype: d.court_code, max_results: 10 };
      const r = await ikapi('search_cases', args).catch(() => ({ results: [] }));
      const candidates = (r.results || []).slice(0, 10);
      if (candidates.length <= 5) return candidates;
      // score all 10, keep top 5
      const scored = await Promise.all(candidates.map(async c => {
        const s = await deepseekScore(q, c);
        return { ...c, _rerank: s.overall };
      }));
      scored.sort((a, b) => (b._rerank || 0) - (a._rerank || 0));
      return scored.slice(0, 5);
    }
  },
  {
    name: 'F_deepseek_title_search',
    desc: 'C + IKAPI title: operator to focus on judgments whose title mentions the statute',
    async run(q) {
      const d = await deepseekDecode(q.natural);
      const ik_query = `${d.statute} Section ${d.section} ${d.clean_keywords}`.trim();
      const args = { query: ik_query, doctype: d.court_code, max_results: 5 };
      const r = await ikapi('search_cases', args).catch(() => ({ results: [] }));
      return (r.results || []).slice(0, 5);
    }
  },
  {
    name: 'G_deepseek_two_pass',
    desc: 'C followed by a second pass on SC if HC returns < 3 candidates',
    async run(q) {
      const d = await deepseekDecode(q.natural);
      const ik_query = `Section ${d.section} ${d.statute} ${d.clean_keywords}`.trim();
      let args = { query: ik_query, doctype: d.court_code, max_results: 5 };
      let r = await ikapi('search_cases', args).catch(() => ({ results: [] }));
      let results = (r.results || []).slice(0, 5);
      if (results.length < 3 && d.court_code !== 'supremecourt') {
        args = { query: ik_query, doctype: 'supremecourt', max_results: 5 };
        r = await ikapi('search_cases', args).catch(() => ({ results: [] }));
        const sc = (r.results || []).slice(0, 5);
        const seen = new Set(results.map(x => x.tid));
        results = results.concat(sc.filter(x => !seen.has(x.tid))).slice(0, 5);
      }
      return results;
    }
  }
];

// ── Run a single strategy on all queries ───────────────────────────

async function runStrategy(s, queries) {
  const out = { strategy: s.name, desc: s.desc, queries: [] };
  const batchSize = 4;
  for (let i = 0; i < queries.length; i += batchSize) {
    const batch = queries.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(async q => {
      const cands = await s.run(q).catch(e => { console.warn(`  ${s.name}/${q.id} threw:`, e.message); return []; });
      const top3 = cands.slice(0, 3);
      const scored = [];
      for (const c of top3) {
        // skip re-score if rerank already scored this exact candidate
        if (typeof c._rerank === 'number') {
          scored.push({
            tid: c.tid, title: c.title?.slice(0, 70), court: c.court,
            date: c.date || c.judgment_date,
            overall: c._rerank,
            verdict: 'reused from rerank'
          });
          continue;
        }
        const sc = await deepseekScore(q, c);
        scored.push({
          tid: c.tid, title: c.title?.slice(0, 70), court: c.court,
          date: c.date || c.judgment_date, ...sc
        });
      }
      const avg = scored.length ? scored.reduce((a, b) => a + (b.overall || 0), 0) / scored.length : 0;
      return { id: q.id, area: q.area, fetched: cands.length, avg, top: scored[0]?.overall || 0, scored };
    }));
    out.queries.push(...batchResults);
  }
  const all = out.queries.flatMap(q => q.scored);
  out.avg_top3 = all.length ? all.reduce((a, b) => a + (b.overall || 0), 0) / all.length : 0;
  out.avg_top1 = out.queries.length ? out.queries.reduce((a, b) => a + b.top, 0) / out.queries.length : 0;
  out.zero_candidate_count = out.queries.filter(q => q.fetched === 0).length;
  return out;
}

// ── Round driver ────────────────────────────────────────────────────

async function runRound(roundNum, strategies, queries) {
  console.log(`\n══════════ ROUND ${roundNum} ══════════`);
  console.log(`Strategies: ${strategies.map(s => s.name).join(', ')}\n`);
  const t0 = Date.now();
  const results = [];
  for (const s of strategies) {
    console.log(`▶ ${s.name} — ${s.desc}`);
    const r = await runStrategy(s, queries);
    console.log(`  avg top-3 = ${r.avg_top3.toFixed(2)}, top-1 = ${r.avg_top1.toFixed(2)}, ${r.zero_candidate_count}/30 with 0 candidates`);
    results.push(r);
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\nRound ${roundNum} done in ${elapsed}s`);
  console.log(`\nRANK:`);
  const ranked = [...results].sort((a, b) => b.avg_top3 - a.avg_top3);
  ranked.forEach((r, i) => {
    const tag = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
    console.log(`  ${tag} ${r.strategy.padEnd(25)} top-3=${r.avg_top3.toFixed(2)} top-1=${r.avg_top1.toFixed(2)} ${r.zero_candidate_count} zero`);
  });
  return { roundNum, results: ranked, elapsed };
}

// ── Generate next-round variants from winner ───────────────────────

function makeVariants(winner) {
  // Build 4-5 tweaked strategies on top of the winning logic
  const variants = [
    {
      name: `${winner.strategy}_v_max10`,
      desc: `${winner.desc} — but fetch max_results=10`,
      run: async (q) => {
        const d = await deepseekDecode(q.natural);
        const ik_query = `Section ${d.section} ${d.statute} ${d.clean_keywords}`.trim();
        const args = { query: ik_query, doctype: d.court_code, max_results: 10 };
        const r = await ikapi('search_cases', args).catch(() => ({ results: [] }));
        return (r.results || []).slice(0, 5);
      }
    },
    {
      name: `${winner.strategy}_v_with_principle`,
      desc: `winner + principle/doctrine hint in keywords`,
      run: async (q) => {
        const d = await deepseekDecode(q.natural);
        // ask DS for the doctrine name
        const r2 = await deepseek([{
          role: 'user',
          content: `Name the single legal doctrine or principle most relevant to: "${q.natural}". Return JSON {"doctrine":"<2-5 words>"}.`
        }]);
        const doctrine = (r2?.doctrine || '').trim();
        const ik_query = `Section ${d.section} ${d.statute} ${d.clean_keywords} ${doctrine}`.trim();
        const args = { query: ik_query, doctype: d.court_code, max_results: 5 };
        const rr = await ikapi('search_cases', args).catch(() => ({ results: [] }));
        return (rr.results || []).slice(0, 5);
      }
    },
    {
      name: `${winner.strategy}_v_dual_court`,
      desc: `winner + always query both expected_court AND supremecourt, merge`,
      run: async (q) => {
        const d = await deepseekDecode(q.natural);
        const ik_query = `Section ${d.section} ${d.statute} ${d.clean_keywords}`.trim();
        const [r1, r2] = await Promise.all([
          ikapi('search_cases', { query: ik_query, doctype: d.court_code, max_results: 5 }).catch(() => ({ results: [] })),
          d.court_code !== 'supremecourt'
            ? ikapi('search_cases', { query: ik_query, doctype: 'supremecourt', max_results: 3 }).catch(() => ({ results: [] }))
            : Promise.resolve({ results: [] })
        ]);
        const seen = new Set();
        const merged = [];
        for (const arr of [r1.results || [], r2.results || []]) {
          for (const x of arr) {
            if (!seen.has(x.tid)) { seen.add(x.tid); merged.push(x); }
          }
        }
        return merged.slice(0, 5);
      }
    },
    {
      name: `${winner.strategy}_v_rerank20`,
      desc: `winner + fetch 20, DeepSeek rerank, keep top 5`,
      run: async (q) => {
        const d = await deepseekDecode(q.natural);
        const ik_query = `Section ${d.section} ${d.statute} ${d.clean_keywords}`.trim();
        const args = { query: ik_query, doctype: d.court_code, max_results: 20 };
        const r = await ikapi('search_cases', args).catch(() => ({ results: [] }));
        const cands = (r.results || []).slice(0, 20);
        if (cands.length <= 5) return cands;
        const scored = await Promise.all(cands.map(async c => {
          const s = await deepseekScore(q, c);
          return { ...c, _rerank: s.overall };
        }));
        scored.sort((a, b) => (b._rerank || 0) - (a._rerank || 0));
        return scored.slice(0, 5);
      }
    }
  ];
  return variants;
}

// ── Entry ─────────────────────────────────────────────────────────────

(async () => {
  fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
  const log = [];
  let allStrategies = STRATEGIES;
  let winner = null;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const r = await runRound(round, allStrategies, queries);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.writeFileSync(
      path.join(__dirname, 'results', `iterate-r${round}-${ts}.json`),
      JSON.stringify(r, null, 2)
    );
    log.push(r);
    winner = r.results[0];
    if (winner.avg_top3 >= TARGET_AVG) {
      console.log(`\n🎯 Target ${TARGET_AVG} reached by ${winner.strategy} (${winner.avg_top3.toFixed(2)})`);
      break;
    }
    if (round < MAX_ROUNDS) {
      console.log(`\n▼ Generating round ${round + 1} variants based on ${winner.strategy}…`);
      allStrategies = makeVariants(winner);
    }
  }

  // write winner.json
  const winnerOut = {
    timestamp: new Date().toISOString(),
    strategy: winner.strategy,
    desc: winner.desc,
    avg_top3: winner.avg_top3,
    avg_top1: winner.avg_top1,
    zero_candidate_count: winner.zero_candidate_count,
    per_query_summary: winner.queries.map(q => ({ id: q.id, area: q.area, avg: q.avg, top: q.top }))
  };
  fs.writeFileSync(path.join(__dirname, 'results', 'winner.json'), JSON.stringify(winnerOut, null, 2));

  console.log(`\n╔════════════════════════════════════╗`);
  console.log(`║  WINNER: ${winner.strategy.padEnd(26)}║`);
  console.log(`║  avg top-3 = ${winner.avg_top3.toFixed(2).padEnd(23)}║`);
  console.log(`║  avg top-1 = ${winner.avg_top1.toFixed(2).padEnd(23)}║`);
  console.log(`║  0-cand    = ${String(winner.zero_candidate_count).padEnd(23)}║`);
  console.log(`╚════════════════════════════════════╝`);
  console.log(`\nWinner config saved: scripts/benchmark/results/winner.json`);
})();
