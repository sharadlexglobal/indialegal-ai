// Run the full v7 drafting pipeline:
//   v6 fill+verify → improvise → hallucination check → spot-fix → re-verify → PDF
require('dotenv').config({ path: '/Users/sharadbansal/sharad claude/indialegal-ai/.env' });
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const draftExp = require('/Users/sharadbansal/sharad claude/indialegal-ai/services/draftExperiment');

const CASE_ID = parseInt(process.argv[2] || '68', 10);
const OUT_DIR = process.argv[3] || '/Users/sharadbansal/Downloads';

(async () => {
  const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isLocal ? false : { rejectUnauthorized: false }
  });

  console.log(`[v7] running on case ${CASE_ID} ...`);
  const t0 = Date.now();
  const result = await draftExp.runExperiment({
    pool, caseId: CASE_ID, improvise: true, halluCheck: true
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[v7] runExperiment done in ${elapsed}s`);

  // Save intermediate + final JSON
  fs.writeFileSync('/tmp/draft-exp-v7.json', JSON.stringify(result, null, 2));

  // Snapshot markdowns
  fs.writeFileSync('/tmp/v6-draft.md', result.v6Markdown || '');
  fs.writeFileSync('/tmp/v7-polished.md', result.polishedMarkdown || '');
  fs.writeFileSync('/tmp/v7-final.md', result.draftMarkdown || '');

  // PDF render of FINAL
  const pdfPath = path.join(OUT_DIR, `sodhani-written-args-OVR17-v7.pdf`);
  await draftExp.renderPdf({
    markdown: result.draftMarkdown,
    outPath: pdfPath,
    title: 'Written Arguments — Order VI Rule 17 — Sodhani v. Seth'
  });

  console.log('\n=== court info ===');
  console.log(`  level: ${result.court_info.court_level}`);
  console.log(`  court: ${result.court_info.court_specific_name}`);
  console.log(`  judge: ${result.court_info.judge_name || 'NULL (ambiguous)'}`);
  console.log(`  designation: ${result.court_info.judge_designation}`);

  console.log('\n=== citation audit (final) ===');
  console.log(`  total=${result.citation_audit.total} verified=${result.citation_audit.verified} unverified=${result.citation_audit.unverified}`);
  for (const v of result.citation_audit.details) {
    console.log(`  ${v.verified ? '✓' : '❌'} ${v.name.padEnd(55)} (${v.year})`);
  }

  console.log('\n=== hallucination audit ===');
  console.log(`  ${result.hallu_audit.summary}`);
  console.log(`  proposed=${result.hallu_audit.proposed_fixes.length} applied=${result.hallu_audit.applied_fixes.length} skipped=${result.hallu_audit.skipped_fixes.length}`);
  for (const f of result.hallu_audit.applied_fixes) {
    console.log(`  ✓ [${f.severity}] ${(f.reason || '').slice(0, 100)}`);
    console.log(`      find:    ${JSON.stringify(f.find).slice(0, 100)}`);
    console.log(`      replace: ${JSON.stringify(f.replace).slice(0, 100)}`);
  }
  for (const f of result.hallu_audit.skipped_fixes) {
    console.log(`  ~ SKIP (${f.skipped_reason}): ${(f.reason || '').slice(0, 80)}`);
  }

  console.log(`\n=== PDF ===`);
  console.log(`  ${pdfPath}`);
  console.log(`  size: ${fs.statSync(pdfPath).size} bytes`);

  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
