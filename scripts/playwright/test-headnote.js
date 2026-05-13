/**
 * Test the SCC-style headnote layout — both:
 *   • text-chat: when agent lists judgments, format matches the
 *     "Title bold + Issue + Held" headnote structure
 *   • research timeline cards: headnote prominent, summary collapsible
 *
 * Picks a case with existing indexed judgments (case 22) and asks a
 * follow-up question that should produce a SCC-headnote response.
 */
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
  // Open case 22 — has B.S. Joshi indexed
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

  // 1) Attach the existing research block so the cards render with new layout
  await page.evaluate(() => {
    const items = document.querySelectorAll('.ctx-research-item');
    items[0]?.click();
  });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SHOTS}/40-cards-headnote.png`, fullPage: true });

  // 2) Ask a question that should trigger an SCC-headnote-style response
  await page.fill('#composer-input',
    'Bhajan Lal aur B.S. Joshi mein kya difference hai? List karo with headnotes.');
  await page.click('#send-btn');
  await page.waitForTimeout(25000);
  await page.screenshot({ path: `${SHOTS}/41-chat-headnotes.png`, fullPage: true });

  // Inspect the chat response for headnote markers
  const audit = await page.evaluate(() => {
    const last = document.querySelector('.msg.assistant:last-of-type .msg-body');
    if (!last) return { ok: false };
    const html = last.innerHTML;
    const text = last.innerText;
    return {
      ok: true,
      hasBoldTitle: /<strong>[^<]+v\.[^<]+\(/.test(html),
      hasIssueLabel: /Issue:/i.test(text),
      hasHeldLabel: /Held:/i.test(text),
      head: text.slice(0, 600)
    };
  });
  console.log('chat audit:', JSON.stringify(audit, null, 2));

  // Inspect first card
  const cardAudit = await page.evaluate(() => {
    const c = document.querySelector('.judgment-card');
    if (!c) return { ok: false };
    return {
      ok: true,
      hasHeadnote: !!c.querySelector('.jc-headnote'),
      headnoteText: c.querySelector('.jc-headnote')?.innerText?.slice(0, 120),
      hasCollapsibleSummary: !!c.querySelector('.jc-expand'),
      hasQuotes: !!c.querySelector('.jc-quote'),
    };
  });
  console.log('card audit:', JSON.stringify(cardAudit, null, 2));

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
