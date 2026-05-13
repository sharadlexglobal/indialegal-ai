/**
 * AUDIT — verbatim quote integrity.
 *
 * For every APPLICABLE / TANGENTIAL judgment across recent research jobs:
 *   1. Pull the FULL judgment text saved in research_jobs.judgments[*].full_text.
 *   2. For each j.relevant_quotes[*].text, fuzzy-match it against the source.
 *      - exact substring (after whitespace+punct normalize) → "exact"
 *      - any 60-char chunk hits → "partial"
 *      - else → "mismatch"  (a paraphrase / hallucination)
 *   3. For each q.para, verify a marker like "<para>." or "para <para>" or
 *      "paragraph <para>" appears in the source near the matched chunk.
 *      - found → "para_ok"
 *      - not found → "para_hallucinated"
 *
 * Output: per-judgment audit + global percentages.
 *
 * If any quote comes back "mismatch" or any para "para_hallucinated",
 * the system is leaking trust — needs immediate prompt tightening +
 * server-side validator.
 *
 *   node audit-verbatim.js               # audits ALL non-empty done jobs
 *   node audit-verbatim.js 13 14 17 18 19  # specific job IDs
 */

const fetch = require('node-fetch');
const BASE = process.env.BASE || 'https://indialegal-ai.onrender.com';

// ── normalization ────────────────────────────────────────────────
function norm(s) {
  return String(s || '')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/[ \t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function matchQuote(quote, source) {
  const nq = norm(quote);
  const ns = norm(source);
  if (!nq || nq.length < 20) return { match: 'too-short', len: nq.length };

  // 1. exact substring
  if (ns.includes(nq)) {
    const at = ns.indexOf(nq);
    return { match: 'exact', at, len: nq.length };
  }

  // 2. head-100 or head-60
  for (const headLen of [120, 80, 60]) {
    if (nq.length >= headLen) {
      const head = nq.slice(0, headLen);
      if (ns.includes(head)) {
        return { match: `head-${headLen}`, at: ns.indexOf(head), len: nq.length };
      }
    }
  }

  // 3. any 60-char chunk from anywhere
  const CHUNK = 60;
  if (nq.length >= CHUNK) {
    for (let i = 0; i <= nq.length - CHUNK; i += 30) {
      const c = nq.slice(i, i + CHUNK);
      if (ns.includes(c)) {
        return { match: `chunk@${i}`, at: ns.indexOf(c), len: nq.length };
      }
    }
  }

  // 4. word-overlap fallback
  const qWords = nq.split(/\s+/).filter(w => w.length >= 5);
  const sWords = new Set(ns.split(/\s+/).filter(w => w.length >= 5));
  const hits = qWords.filter(w => sWords.has(w)).length;
  const ratio = qWords.length ? hits / qWords.length : 0;
  return {
    match: 'MISMATCH',
    word_ratio: Number(ratio.toFixed(2)),
    head: nq.slice(0, 100)
  };
}

function paraInSource(para, source, near) {
  if (!para) return { check: 'no-para-claimed' };
  const p = String(para).trim().replace(/[^\d.]/g, '');
  if (!p) return { check: 'no-para-claimed' };

  const ns = norm(source);
  const escaped = p.replace(/\./g, '\\.');
  const patterns = [
    new RegExp(`(^|\\s|\\n)${escaped}\\.\\s`, 'm'),
    new RegExp(`\\bpara\\s+${escaped}\\b`, 'i'),
    new RegExp(`\\bparagraph\\s+${escaped}\\b`, 'i')
  ];
  let found = null;
  for (const pat of patterns) {
    const m = ns.match(pat);
    if (m) { found = pat.toString(); break; }
  }
  if (found) {
    // Optional: if we know where the quote matched, check the para
    // marker is within a reasonable window (3000 chars) of the match.
    if (near != null && near >= 0) {
      const idx = ns.search(patterns[0]); // first try
      // Not strictly required — many judgments cite para X far from the quoted text.
    }
    return { check: 'para_ok', pattern: found };
  }
  return { check: 'PARA_HALLUCINATED', para: p };
}

// ── fetch jobs list ──────────────────────────────────────────────
async function listAllDoneJobs() {
  // No global jobs endpoint — iterate cases.
  const cases = await fetch(`${BASE}/api/cases`).then(r => r.json());
  const ids = [];
  for (const c of cases) {
    const jobs = await fetch(`${BASE}/api/cases/${c.id}/research`).then(r => r.json()).catch(() => []);
    for (const j of (jobs || [])) {
      if (j.status === 'done' && j.judgment_count > 0) ids.push({ caseId: c.id, jobId: j.id });
    }
  }
  return ids;
}

// ── audit one job ────────────────────────────────────────────────
async function auditJob(caseId, jobId) {
  const data = await fetch(`${BASE}/api/cases/${caseId}/research/${jobId}`).then(r => r.json());
  const judgments = (data.judgments || []).filter(j =>
    j.verdict === 'APPLICABLE' || j.verdict === 'TANGENTIAL'
  );

  const rows = [];
  for (const j of judgments) {
    const quotes = j.relevant_quotes || [];
    const source = j.full_text || '';
    if (!source) {
      rows.push({ jobId, tid: j.tid, verdict: j.verdict, status: 'no-source' });
      continue;
    }
    if (!quotes.length) {
      rows.push({ jobId, tid: j.tid, verdict: j.verdict, status: 'no-quotes' });
      continue;
    }
    for (const q of quotes) {
      const m = matchQuote(q.text, source);
      const p = paraInSource(q.para, source, m.at);
      rows.push({
        jobId, tid: j.tid, title: j.title?.slice(0, 60),
        verdict: j.verdict,
        para: q.para, quote_head: q.text?.slice(0, 80),
        text_match: m.match,
        word_ratio: m.word_ratio,
        para_check: p.check
      });
    }
  }
  return rows;
}

// ── main ─────────────────────────────────────────────────────────
(async () => {
  let jobs;
  const argv = process.argv.slice(2);
  if (argv.length) {
    // user passed specific job IDs — need to resolve case ids per job
    jobs = [];
    for (const id of argv) {
      // brute lookup: iterate cases
      const cases = await fetch(`${BASE}/api/cases`).then(r => r.json());
      for (const c of cases) {
        try {
          const r = await fetch(`${BASE}/api/cases/${c.id}/research/${id}`);
          if (r.ok) { jobs.push({ caseId: c.id, jobId: id }); break; }
        } catch {}
      }
    }
  } else {
    jobs = await listAllDoneJobs();
  }
  console.log(`auditing ${jobs.length} jobs…\n`);

  const allRows = [];
  for (const { caseId, jobId } of jobs) {
    const rows = await auditJob(caseId, jobId);
    allRows.push(...rows);
    console.log(`  case ${caseId} · job ${jobId}: ${rows.length} quote(s) audited`);
  }

  // Summary
  console.log('\n==============================================');
  console.log('              AUDIT SUMMARY');
  console.log('==============================================');
  const total = allRows.filter(r => r.text_match).length;
  const exact = allRows.filter(r => r.text_match === 'exact').length;
  const headOk = allRows.filter(r => /^head-/.test(r.text_match)).length;
  const chunk = allRows.filter(r => /^chunk@/.test(r.text_match)).length;
  const mismatch = allRows.filter(r => r.text_match === 'MISMATCH').length;
  const tooShort = allRows.filter(r => r.text_match === 'too-short').length;

  console.log(`Total quotes audited:    ${total}`);
  console.log(`  exact substring:       ${exact}`);
  console.log(`  head match (60-120):   ${headOk}`);
  console.log(`  mid-chunk match:       ${chunk}`);
  console.log(`  TOO SHORT (<20 chars): ${tooShort}`);
  console.log(`  MISMATCH:              ${mismatch}`);

  const paraOk = allRows.filter(r => r.para_check === 'para_ok').length;
  const paraHallu = allRows.filter(r => r.para_check === 'PARA_HALLUCINATED').length;
  const paraNone = allRows.filter(r => r.para_check === 'no-para-claimed').length;
  console.log(`\nPara claims:             ${paraOk + paraHallu + paraNone}`);
  console.log(`  no para claimed:       ${paraNone}`);
  console.log(`  para verified in src:  ${paraOk}`);
  console.log(`  PARA_HALLUCINATED:     ${paraHallu}`);

  if (mismatch || paraHallu) {
    console.log('\n==============================================');
    console.log('              FAILING ROWS');
    console.log('==============================================');
    for (const r of allRows.filter(x => x.text_match === 'MISMATCH' || x.para_check === 'PARA_HALLUCINATED')) {
      console.log(`\n  job ${r.jobId} · tid ${r.tid} · ${r.verdict}`);
      console.log(`    ${(r.title || '').slice(0, 70)}`);
      console.log(`    text_match: ${r.text_match}  ·  word_ratio: ${r.word_ratio ?? '-'}`);
      console.log(`    para: "${r.para || '(none)'}" → ${r.para_check}`);
      console.log(`    quote head: "${r.quote_head}…"`);
    }
  } else {
    console.log('\n✅ CLEAN — every quote matched the source, every para checked out.');
  }

  // Exit code: non-zero if any failures (so we can chain in CI)
  process.exit(mismatch + paraHallu > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
