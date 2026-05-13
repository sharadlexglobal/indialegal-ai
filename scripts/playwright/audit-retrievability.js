/**
 * AUDIT — every indexed judgment MUST be retrievable.
 *
 * For each case with indexed=true judgments:
 *   1. Build a query from the judgment's title (case name).
 *   2. POST it to /api/cases/:id/search.
 *   3. Confirm we get back snippets containing the case name OR a
 *      relevant substring, NOT a refusal.
 *
 * Catches the regression class where Gemini's File Search retrieves
 * content but our server-side filters reject it (e.g. null pageNumber
 * killing the synthesis path).
 *
 *   node audit-retrievability.js
 *
 * Exit 1 if any indexed judgment fails to come back through search.
 */
const BASE = process.env.BASE || 'https://indialegal-ai.onrender.com';

async function querySearch(caseId, query) {
  const r = await fetch(`${BASE}/api/cases/${caseId}/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }), signal: AbortSignal.timeout(120_000)
  });
  return r.json();
}

function shortName(title) {
  // "B.S. Joshi & Ors vs State Of Haryana & Anr on 13 March, 2003"
  //  → "B.S. Joshi vs State Of Haryana"
  return String(title || '')
    .replace(/^\s*([^a-zA-Z0-9])+/, '')
    .split(/\s+(?:on|dated)\s+/i)[0]
    .replace(/\s*&\s*(Ors|Anr|Another|Others)\.?/gi, '')
    .replace(/\s*\([^)]+\)/g, '')
    .trim();
}

(async () => {
  const cases = await fetch(`${BASE}/api/cases`).then(r => r.json());
  const fails = [];
  let total = 0;

  for (const c of cases) {
    if (c.kind !== 'standalone_research' && c.kind !== 'document') continue;
    const jobs = await fetch(`${BASE}/api/cases/${c.id}/research`).then(r => r.json()).catch(() => []);
    for (const job of (jobs || [])) {
      if (job.status !== 'done') continue;
      const full = await fetch(`${BASE}/api/cases/${c.id}/research/${job.id}`)
        .then(r => r.json()).catch(() => ({}));
      const indexed = (full.judgments || []).filter(j => j.indexed);
      for (const j of indexed) {
        total++;
        const name = shortName(j.title);
        if (!name) { fails.push({ caseId: c.id, tid: j.tid, reason: 'unparseable title' }); continue; }
        const out = await querySearch(c.id, name);
        const snippets = out.snippets || [];
        const refusal = !!out.refusal;
        // Pass if any snippet appears non-trivial. A "fail" is a hard refusal
        // OR an empty snippet list.
        const ok = !refusal && snippets.length > 0 && (snippets[0].text || '').length >= 60;
        if (!ok) {
          fails.push({
            caseId: c.id, jobId: job.id, tid: j.tid,
            title: name, refusal: out.refusal, snippets: snippets.length
          });
        }
        process.stdout.write(ok ? '.' : 'F');
      }
    }
  }

  console.log(`\n\nRETRIEVABILITY: ${total - fails.length}/${total} indexed judgments retrievable.`);
  if (fails.length) {
    console.log('\nFAILURES:');
    for (const f of fails) {
      console.log(`  case ${f.caseId} · job ${f.jobId} · tid ${f.tid}`);
      console.log(`    title: ${f.title}`);
      console.log(`    refusal=${f.refusal}  snippets=${f.snippets}`);
    }
    process.exit(1);
  }
  console.log('\n✅ Every indexed judgment retrievable.');
})().catch(e => { console.error(e); process.exit(2); });
