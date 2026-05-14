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
  // Scroll the digest into view
  await page.evaluate(() => {
    const d = document.querySelector('.rb-digest');
    d?.scrollIntoView({ behavior: 'instant', block: 'start' });
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/51-digest-scrolled.png`, fullPage: false });
  await browser.close();
})();
