/**
 * Live end-to-end: kick off a NEW research job from the UI, watch the
 * SSE timeline populate cards live, then assert that each APPLICABLE
 * card contains at least one verbatim quote with a paragraph label.
 *
 *   node test-verbatim.js
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.env.BASE || 'https://indialegal-ai.onrender.com';
const SHOTS = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

function log(...args) { console.log(new Date().toISOString().slice(11, 19), ...args); }

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newContext({
    viewport: { width: 1440, height: 1200 },
    deviceScaleFactor: 2
  }).then(c => c.newPage());

  page.on('pageerror', (e) => console.error('[page-error]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('[js-err]', m.text());
  });

  // 1) Create a fresh standalone research session via the API (faster than UI flow)
  log('creating research session…');
  const r = await fetch(`${BASE}/api/research/new`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Playwright verbatim test — 482 CrPC quash' })
  });
  const sess = await r.json();
  log('session id=', sess.id);

  // 2) Kick off research with a high-confidence query
  const jobR = await fetch(`${BASE}/api/cases/${sess.id}/start-research`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scope: {
        keywords: 'Section 482 CrPC quash FIR Bhajan Lal categories',
        doctype: 'supremecourt',
        max_results: 3
      },
      plan: 'Section 482 quash FIR — top 3 SC + Bhajan Lal'
    })
  });
  const jobJ = await jobR.json();
  log('job id=', jobJ.jobId);

  // 3) Open workspace directly (via list → click row)
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.masthead h1');

  // Click the row matching our new session
  const ok = await page.evaluate((title) => {
    const rows = document.querySelectorAll('#research-list .row');
    for (const r of rows) {
      if (r.querySelector('.row-title')?.textContent?.includes(title)) {
        r.click(); return true;
      }
    }
    return false;
  }, 'Playwright verbatim test');
  if (!ok) { log('!! could not find new session row'); }
  await page.waitForSelector('#screen-workspace:not(.hidden)');

  // 4) Click the new research item in the right panel → attaches SSE
  await page.waitForTimeout(800);
  await page.evaluate((label) => {
    const items = document.querySelectorAll('.ctx-research-item');
    for (const it of items) {
      if (it.querySelector('.ctx-research-title')?.textContent?.includes(label)) {
        it.click(); return true;
      }
    }
    // fallback: click newest
    items[0]?.click();
  }, 'Section 482');

  log('subscribed to SSE; waiting for live verdicts (max 5 min)…');
  // Poll for either applicable cards OR `done`/`failed` stage line.
  const deadline = Date.now() + 5 * 60 * 1000;
  let lastAppCount = 0;
  while (Date.now() < deadline) {
    const status = await page.evaluate(() => ({
      cards: document.querySelectorAll('.judgment-card').length,
      applicable: document.querySelectorAll('.judgment-card.applicable').length,
      withQuotes: document.querySelectorAll('.judgment-card .jc-quote').length,
      doneStage: !!Array.from(document.querySelectorAll('.rb-stage'))
        .find(n => n.textContent.includes('done in')),
      failed: !!Array.from(document.querySelectorAll('.rb-stage'))
        .find(n => n.textContent.startsWith('failed')),
    }));
    if (status.applicable > lastAppCount) {
      lastAppCount = status.applicable;
      log(`  → ${status.cards} cards · ${status.applicable} applicable · ${status.withQuotes} blockquotes`);
    }
    if (status.doneStage || status.failed) {
      log('finished:', status);
      break;
    }
    await page.waitForTimeout(3000);
  }

  // Final screenshot
  await page.screenshot({ path: `${SHOTS}/10-verbatim-after.png`, fullPage: true });

  // Detailed audit
  const audit = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.judgment-card'));
    return cards.map(card => ({
      tid: card.dataset.tid,
      title: card.querySelector('.jc-title')?.textContent,
      verdict: card.classList.contains('applicable') ? 'APPLICABLE'
            : card.classList.contains('tangential') ? 'TANGENTIAL'
            : card.classList.contains('inapplicable') ? 'INAPPLICABLE' : 'pending',
      quotes: Array.from(card.querySelectorAll('.jc-quote')).map(q => ({
        para: q.querySelector('.jc-para-no')?.textContent || '',
        text: q.querySelector('.jc-quote-text')?.textContent?.slice(0, 120) || ''
      })),
      hasSummary: !!card.querySelector('.jc-summary'),
    }));
  });

  console.log('\n=== AUDIT ===');
  for (const c of audit) {
    console.log(`\n  [${c.verdict}] tid=${c.tid}  ${c.title?.slice(0, 70)}`);
    console.log(`    ${c.quotes.length} quote(s)${c.hasSummary ? ' + summary' : ''}`);
    for (const q of c.quotes) {
      console.log(`    ${q.para}  "${q.text}…"`);
    }
  }
  const appCards = audit.filter(c => c.verdict === 'APPLICABLE');
  const appWithQuotes = appCards.filter(c => c.quotes.length > 0).length;
  console.log(`\n${appCards.length} APPLICABLE total · ${appWithQuotes} have verbatim quotes`);

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
