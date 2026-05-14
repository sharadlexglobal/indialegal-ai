const { chromium } = require('playwright');
const path = require('path');
const BASE = process.env.BASE || 'https://indialegal-ai.onrender.com';
const SHOTS = path.join(__dirname, 'shots');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newContext({
    viewport: { width: 1440, height: 1400 }, deviceScaleFactor: 2
  }).then(c => c.newPage());
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    const rows = document.querySelectorAll('#research-list .row');
    for (const r of rows) {
      if (r.querySelector('.row-title')?.textContent?.includes('Playwright verbatim')) {
        r.click(); return;
      }
    }
  });
  await page.waitForSelector('#screen-workspace:not(.hidden)');
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const items = document.querySelectorAll('.ctx-research-item');
    items[0]?.click();
  });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${SHOTS}/50-digest.png`, fullPage: true });
  const audit = await page.evaluate(() => {
    const digest = document.querySelector('.rb-digest');
    return {
      digestRendered: !!digest,
      entries: document.querySelectorAll('.rb-digest-item').length,
      maroonHeadnotes: document.querySelectorAll('.rb-digest-headnote').length,
      cardHeadnoteColorOK: (() => {
        const hn = document.querySelector('.judgment-card.applicable .jc-headnote');
        if (!hn) return null;
        return getComputedStyle(hn).color;
      })()
    };
  });
  console.log(JSON.stringify(audit, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
