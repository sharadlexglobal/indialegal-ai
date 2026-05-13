/**
 * Baseline screenshots + DOM inspection of the live frontend.
 * No fixing — just SEE what the user sees today.
 *
 *   node baseline.js
 *
 * Drops PNGs into ./shots/  and a one-line per-screen note to stdout.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'https://indialegal-ai.onrender.com';
const SHOTS = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2
  });
  const page = await ctx.newPage();

  page.on('pageerror', (e) => console.error('[page-error]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('[console-error]', m.text());
  });

  // 1) List screen
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.masthead h1');
  await page.screenshot({ path: `${SHOTS}/01-list.png`, fullPage: true });
  const listSummary = await page.evaluate(() => ({
    masthead: document.querySelector('.masthead h1')?.textContent,
    strap: document.querySelector('.masthead .strap')?.textContent,
    researchRows: document.querySelectorAll('#research-list .row').length,
    caseRows: document.querySelectorAll('#cases-list .row').length,
  }));
  console.log('01-list:', JSON.stringify(listSummary));

  // 2) Open an existing research session (case 21 — white-collar trial run)
  const targetRow = await page.$(`#research-list .row:has(.row-title:text-is("White-collar crime trial run"))`);
  if (!targetRow) {
    // Fallback — first research row
    await page.click('#research-list .row:not(.empty)');
  } else {
    await targetRow.click();
  }
  await page.waitForSelector('#screen-workspace:not(.hidden)');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/02-workspace-empty.png`, fullPage: true });
  const wsSummary = await page.evaluate(() => ({
    title: document.querySelector('#ws-title')?.textContent,
    meta: document.querySelector('#ws-meta')?.textContent,
    messages: document.querySelectorAll('.msg').length,
    ctxResearchItems: document.querySelectorAll('.ctx-research-item').length,
  }));
  console.log('02-workspace:', JSON.stringify(wsSummary));

  // 3) Click an existing research session in the context panel to render
  //    the timeline of judgments inline.
  const ctxItem = await page.$('.ctx-research-item:not(.empty)');
  if (ctxItem) {
    await ctxItem.click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${SHOTS}/03-research-block.png`, fullPage: true });
    const rbSummary = await page.evaluate(() => {
      const block = document.querySelector('.research-block');
      return {
        haveBlock: !!block,
        cards: document.querySelectorAll('.judgment-card').length,
        applicable: document.querySelectorAll('.judgment-card.applicable').length,
        tangential: document.querySelectorAll('.judgment-card.tangential').length,
        inapplicable: document.querySelectorAll('.judgment-card.inapplicable').length,
        firstCardHTML: document.querySelector('.judgment-card')?.outerHTML?.slice(0, 800) || null,
      };
    });
    console.log('03-research-block:', JSON.stringify(rbSummary));
  } else {
    console.log('03-research-block: SKIP (no existing research)');
  }

  // 4) Try a text chat turn — to see the agent in action
  await page.fill('#composer-input', 'Bhajan Lal categories briefly');
  await page.click('#send-btn');
  // Wait for either tool-line OR final paragraph to appear
  await page.waitForTimeout(8000);
  await page.screenshot({ path: `${SHOTS}/04-chat.png`, fullPage: true });
  const chatSummary = await page.evaluate(() => {
    const last = document.querySelector('.msg.assistant:last-of-type');
    return {
      toolLines: document.querySelectorAll('.msg.assistant .tool-line').length,
      lastAssistantText: last?.querySelector('.msg-body')?.innerText?.slice(0, 400),
    };
  });
  console.log('04-chat:', JSON.stringify(chatSummary));

  await browser.close();
  console.log('\nshots saved to:', SHOTS);
})().catch((e) => { console.error(e); process.exit(1); });
