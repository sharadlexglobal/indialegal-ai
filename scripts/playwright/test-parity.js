/**
 * Parity test — text chat must:
 *   1. Show empty-state hints on a brand-new session
 *   2. Kick off legal research when user types a research request
 *   3. Auto-attach the live SSE timeline to the thread (no manual click)
 */
const { chromium } = require('playwright');
const path = require('path');
const BASE = process.env.BASE || 'https://indialegal-ai.onrender.com';
const SHOTS = path.join(__dirname, 'shots');

(async () => {
  console.log('creating fresh research session…');
  const r = await fetch(`${BASE}/api/research/new`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Parity test — text-chat research' })
  });
  const sess = await r.json();
  console.log('session id=', sess.id);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newContext({
    viewport: { width: 1440, height: 1200 }, deviceScaleFactor: 2
  }).then(c => c.newPage());

  page.on('pageerror', (e) => console.error('[page-error]', e.message));

  // Open list → click our session
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    const rows = document.querySelectorAll('#research-list .row');
    for (const r of rows) {
      if (r.querySelector('.row-title')?.textContent?.includes('Parity test')) {
        r.click(); return;
      }
    }
  });
  await page.waitForSelector('#screen-workspace:not(.hidden)');
  await page.waitForTimeout(800);

  // 1) Empty hint must be visible
  const emptyHint = await page.evaluate(() => {
    const eh = document.querySelector('.empty-hint');
    return eh ? {
      visible: true,
      examples: Array.from(eh.querySelectorAll('.eh-item')).map(li => li.textContent),
    } : { visible: false };
  });
  console.log('empty-hint:', JSON.stringify(emptyHint));
  await page.screenshot({ path: `${SHOTS}/30-parity-empty.png`, fullPage: true });

  // 2) Click the FIRST example to populate composer, send
  await page.evaluate(() => {
    document.querySelector('.eh-item')?.click();
  });
  await page.waitForTimeout(300);
  await page.click('#send-btn');
  console.log('first message sent — waiting for scoping question or direct kick-off…');

  // Wait for the agent to either ask for confirmation OR call execute_legal_research
  await page.waitForTimeout(20000);
  const stateA = await page.evaluate(() => ({
    msgs: document.querySelectorAll('.msg').length,
    lastAssistant: document.querySelector('.msg.assistant:last-of-type .msg-body')?.innerText?.slice(0, 300),
    researchBlocks: document.querySelectorAll('.research-block').length,
  }));
  console.log('after 1st turn:', JSON.stringify(stateA));
  await page.screenshot({ path: `${SHOTS}/31-parity-scoping.png`, fullPage: true });

  // 3) Send approval to kick off research
  await page.fill('#composer-input', 'haan, shuru karo');
  await page.click('#send-btn');
  console.log('approval sent — waiting for research_started + cards…');

  // Wait up to 90s for the research block to appear with cards filling in
  const deadline = Date.now() + 4 * 60 * 1000;
  while (Date.now() < deadline) {
    const s = await page.evaluate(() => ({
      blocks: document.querySelectorAll('.research-block').length,
      cards: document.querySelectorAll('.judgment-card').length,
      app: document.querySelectorAll('.judgment-card.applicable').length,
      doneStage: !!Array.from(document.querySelectorAll('.rb-stage'))
        .find(n => n.textContent.includes('done in')),
    }));
    if (s.blocks > 0 && s.doneStage) { console.log('research done:', s); break; }
    await page.waitForTimeout(5000);
  }
  await page.screenshot({ path: `${SHOTS}/32-parity-final.png`, fullPage: true });

  // Final state
  const final = await page.evaluate(() => ({
    msgs: document.querySelectorAll('.msg').length,
    blocks: document.querySelectorAll('.research-block').length,
    cards: document.querySelectorAll('.judgment-card').length,
    app: document.querySelectorAll('.judgment-card.applicable').length,
    quotes: document.querySelectorAll('.jc-quote').length,
    autoAttached: !!document.querySelector('.thread .research-block'),
  }));
  console.log('FINAL:', JSON.stringify(final, null, 2));

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
