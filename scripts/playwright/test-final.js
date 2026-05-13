const { chromium } = require('playwright');
const path = require('path');
const BASE = process.env.BASE || 'https://indialegal-ai.onrender.com';
const SHOTS = path.join(__dirname, 'shots');

(async () => {
  // 1) Kick off a fresh research job (NDPS Section 50 — known landmark territory)
  console.log('starting fresh research…');
  const r = await fetch(`${BASE}/api/research/new`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Final test — NDPS Section 50 search compliance' })
  });
  const sess = await r.json();
  console.log('session id=', sess.id);
  const jr = await fetch(`${BASE}/api/cases/${sess.id}/start-research`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scope: {
        keywords: 'NDPS Section 50 search compliance Baldev Singh Vijaysinh Chandubha Jadeja',
        doctype: 'supremecourt',
        max_results: 3
      },
      plan: 'NDPS Section 50 — landmarks on search compliance'
    })
  });
  const job = await jr.json();
  console.log('jobId=', job.jobId);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newContext({
    viewport: { width: 1440, height: 1200 },
    deviceScaleFactor: 2
  }).then(c => c.newPage());

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate((id) => {
    const rows = document.querySelectorAll('#research-list .row');
    for (const r of rows) {
      if (r.querySelector('.row-title')?.textContent?.includes('Final test')) {
        r.click(); return;
      }
    }
  }, sess.id);
  await page.waitForSelector('#screen-workspace:not(.hidden)');
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const items = document.querySelectorAll('.ctx-research-item');
    for (const it of items) {
      if (it.querySelector('.ctx-research-title')?.textContent?.includes('NDPS')) {
        it.click(); return;
      }
    }
    items[0]?.click();
  });

  console.log('waiting up to 5 min for done…');
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const s = await page.evaluate(() => ({
      done: !!Array.from(document.querySelectorAll('.rb-stage')).find(n => n.textContent.includes('done in')),
      cards: document.querySelectorAll('.judgment-card').length,
      app: document.querySelectorAll('.judgment-card.applicable').length,
    }));
    if (s.done) { console.log('done:', s); break; }
    await page.waitForTimeout(3000);
  }

  await page.screenshot({ path: `${SHOTS}/20-final-ndps.png`, fullPage: true });

  // Verify APPLICABLE comes BEFORE TANGENTIAL/INAPPLICABLE in DOM order
  const order = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.judgment-card')).map(c => {
      const verdict = ['applicable','tangential','inapplicable','pending']
        .find(v => c.classList.contains(v)) || 'unknown';
      return verdict;
    });
  });
  console.log('card order:', order);
  const firstNonApp = order.findIndex(v => v !== 'applicable');
  const anyAppAfter = firstNonApp >= 0 && order.slice(firstNonApp).includes('applicable');
  console.log('APPLICABLE clustered at top?', !anyAppAfter);

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
