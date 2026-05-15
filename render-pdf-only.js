// Re-render the PDF only — pull the cached final markdown.
const fs = require('fs');
const path = require('path');
const draftExp = require('./services/draftExperiment');

const SRC = '/tmp/v7-final.md';
const OUT = '/Users/sharadbansal/Downloads/sodhani-written-args-OVR17-v7.pdf';

(async () => {
  const md = fs.readFileSync(SRC, 'utf8');
  // Also save the intermediate HTML for inspection
  const html = draftExp.mdToHtml(md);
  fs.writeFileSync('/tmp/v7-draft.html', `<!doctype html><html><head></head><body>${html}</body></html>`);

  await draftExp.renderPdf({
    markdown: md,
    outPath: OUT,
    title: 'Written Arguments — Order VI Rule 17 — Sodhani v. Seth'
  });
  console.log(`PDF: ${OUT}`);
  console.log(`size: ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB`);
})().catch(e => { console.error(e); process.exit(1); });
