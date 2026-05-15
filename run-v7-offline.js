// Offline v7 runner — uses cached seg-68.json + issues-68.json instead of DB.
// Pipeline: court id → fill → verify → improvise → hallu-check → spot-fix → re-verify → PDF
const fs = require('fs');
const path = require('path');
const draftExp = require('./services/draftExperiment');
const courtIdentifier = require('./services/courtIdentifier');

const CASE_ID = parseInt(process.argv[2] || '68', 10);
const OUT_DIR = process.argv[3] || '/Users/sharadbansal/Downloads';

(async () => {
  const seg = require('/tmp/seg-68.json');
  const issues = require('/tmp/issues-68.json');
  const caseTitle = seg.rollup?.case_title || seg.case_title || 'Indoo Seth v. Arun Kumar Sodhani';

  // Monkey-patch a fake pool that returns cached rows
  const fakePool = {
    async query(sql, params) {
      if (/FROM cases\s+WHERE/i.test(sql)) {
        return { rows: [{ title: caseTitle, rollup: seg.rollup, legal_issues: issues }] };
      }
      if (/FROM case_segments/i.test(sql)) {
        return { rows: seg.segments };
      }
      return { rows: [] };
    },
    end: async () => {}
  };

  console.log(`[v7-offline] case ${CASE_ID}, ${seg.segments.length} segments, ${issues.issues.length} issues`);
  const t0 = Date.now();
  const result = await draftExp.runExperiment({
    pool: fakePool, caseId: CASE_ID, improvise: true, halluCheck: true
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[v7-offline] done in ${elapsed}s`);

  fs.writeFileSync('/tmp/draft-exp-v7.json', JSON.stringify(result, null, 2));
  fs.writeFileSync('/tmp/v6-draft.md', result.v6Markdown || '');
  fs.writeFileSync('/tmp/v7-polished.md', result.polishedMarkdown || '');
  fs.writeFileSync('/tmp/v7-final.md', result.draftMarkdown || '');

  const pdfPath = path.join(OUT_DIR, 'sodhani-written-args-OVR17-v7.pdf');
  await draftExp.renderPdf({
    markdown: result.draftMarkdown,
    outPath: pdfPath,
    title: 'Written Arguments — Order VI Rule 17 — Sodhani v. Seth'
  });

  console.log('\n=== court info ===');
  console.log(`  level:       ${result.court_info.court_level}`);
  console.log(`  court:       ${result.court_info.court_specific_name}`);
  console.log(`  judge:       ${result.court_info.judge_name || 'NULL (ambiguous)'}`);
  console.log(`  designation: ${result.court_info.judge_designation}`);

  console.log('\n=== final citation audit ===');
  console.log(`  total=${result.citation_audit.total} verified=${result.citation_audit.verified} unverified=${result.citation_audit.unverified}`);
  for (const v of result.citation_audit.details) {
    console.log(`  ${v.verified ? '✓' : '❌'} ${v.name.padEnd(55)} (${v.year})`);
  }

  console.log('\n=== hallucination audit ===');
  console.log(`  ${result.hallu_audit.summary}`);
  console.log(`  proposed=${result.hallu_audit.proposed_fixes.length} applied=${result.hallu_audit.applied_fixes.length} skipped=${result.hallu_audit.skipped_fixes.length}`);
  for (const f of result.hallu_audit.applied_fixes) {
    console.log(`  ✓ [${f.severity}] ${(f.reason || '').slice(0, 110)}`);
    console.log(`      - find:    ${JSON.stringify(f.find).slice(0, 110)}`);
    console.log(`      - replace: ${JSON.stringify(f.replace).slice(0, 110)}`);
  }
  for (const f of result.hallu_audit.skipped_fixes) {
    console.log(`  ~ SKIP (${f.skipped_reason}): ${(f.reason || '').slice(0, 80)}`);
  }

  // L4 — n-best fill
  if (result.fill_candidates_meta) {
    console.log('\n=== fill candidates (N-best) ===');
    console.log(`  picked: candidate ${result.fill_candidates_meta.picked_idx} of ${result.fill_candidates_meta.candidate_count}`);
    console.log(`  reason: ${result.fill_candidates_meta.reason}`);
  }

  // L3 — judgment quotes
  if (result.judgment_quotes && Object.keys(result.judgment_quotes).length) {
    console.log('\n=== judgment quotes fetched (IKAPI verbatim) ===');
    for (const [name, q] of Object.entries(result.judgment_quotes)) {
      console.log(`  ✓ ${name} (para ${q.para_number || '?'})`);
      console.log(`    "${(q.quote || '').slice(0, 140)}..."`);
    }
  }

  // L5 — senior critique
  if (result.senior_critique_r1) {
    console.log('\n=== senior critique (round-1) ===');
    console.log(`  grade: ${result.senior_critique_r1.overall_grade}`);
    console.log(`  ${result.senior_critique_r1.summary}`);
    for (const m of (result.senior_critique_r1.must_address_in_round_2 || [])) {
      console.log(`    → ${m}`);
    }
  }

  // L6 — timeline guard
  if (result.timeline_audit) {
    console.log('\n=== timeline guard ===');
    console.log(`  dropped facts: ${result.timeline_audit.droppedCount}`);
    if (result.timeline_audit.droppedCount > 0) {
      for (const [k, arr] of Object.entries(result.timeline_audit.dropped)) {
        console.log(`    ${k}: ${arr.join(', ')}`);
      }
    }
  }

  // L7 — readiness QA
  if (result.readiness_report) {
    console.log('\n=== court-readiness QA (Hon\'ble Mr. Justice lens) ===');
    console.log(`  verdict: ${result.readiness_report.verdict}, grade: ${result.readiness_report.grade}`);
    console.log(`  ${result.readiness_report.summary}`);
    if (result.readiness_report.bench_questions_unanswered?.length) {
      console.log('  bench questions unanswered:');
      for (const q of result.readiness_report.bench_questions_unanswered) console.log(`    - ${q}`);
    }
    if (result.readiness_report.applied_fixes?.length) {
      console.log(`  readiness spot-fixes applied: ${result.readiness_report.applied_fixes.length}`);
    }
  }

  console.log('\n=== completeness check ===');
  if (result.completeness) {
    console.log(`  complete: ${result.completeness.complete}`);
    console.log(`  repair hops: ${result.completeness.repair_hops || 0}`);
    if (result.completeness.structural_issues?.length) {
      for (const i of result.completeness.structural_issues) {
        console.log(`  ⚠ [${i.severity}] ${i.what}: ${i.hint}`);
      }
    }
    if (result.completeness.llm_check?.verdict) {
      console.log(`  LLM verdict: ${result.completeness.llm_check.verdict}`);
    }
    if (result.completeness.llm_check?.missing?.length) {
      for (const m of result.completeness.llm_check.missing) console.log(`    - ${m}`);
    }
  }

  console.log(`\n=== PDF ===`);
  console.log(`  path: ${pdfPath}`);
  console.log(`  size: ${(fs.statSync(pdfPath).size / 1024).toFixed(1)} KB`);
})().catch(e => { console.error(e); process.exit(1); });
