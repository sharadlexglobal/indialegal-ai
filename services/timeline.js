/**
 * Case timeline aggregator.
 *
 * Takes OCR'd text from each order PDF + optional bail-watch case.json
 * and asks DeepSeek (Flash) to extract every dated event in the matter,
 * sorted chronologically. Output is structured JSON ready to render.
 *
 * Each event:
 *   { date: "DD.MM.YYYY", what: "<one-line description>",
 *     source: "Order N, p.X" | "Case file metadata",
 *     order_index?: number }
 */

const fetch = require('node-fetch');

const URL_DS = 'https://api.deepseek.com/v1/chat/completions';
const MODEL  = process.env.DEEPSEEK_FLASH_MODEL || 'deepseek-v4-flash';

function _keyOrThrow() {
  const k = process.env.DEEPSEEK_API_KEY;
  if (!k) throw new Error('DEEPSEEK_API_KEY not set');
  return k;
}

// Run DeepSeek with JSON-mode + retry. Returns parsed object.
async function ds(messages, { timeoutMs = 180000, label = '' } = {}) {
  const key = _keyOrThrow();
  for (let i = 0; i < 3; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(URL_DS, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL, messages,
          response_format: { type: 'json_object' },
          temperature: 0,
          max_tokens: 8192
        }),
        signal: ctl.signal
      });
      clearTimeout(timer);
      const j = await res.json();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
      return JSON.parse(j.choices?.[0]?.message?.content || '{}');
    } catch (e) {
      clearTimeout(timer);
      if (i === 2) throw e;
      console.warn(`[timeline:${label}] retry ${i + 1}: ${e.message}`);
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

// Build a single-order events extract. Limited to ~25 events per
// order (typically far fewer — most orders have 1-3 dated events).
async function extractEventsFromOrder({ orderIndex, orderDate, orderText }) {
  if (!orderText || orderText.length < 50) return [];

  // Truncate to keep prompt small + cheap
  const snippet = orderText.slice(0, 30000);

  const prompt = `You are reading a single court order from an Indian case file. Extract EVERY dated event mentioned in the order — events that happened on a specific date, including:
- Order date itself
- Filing / institution dates
- Hearing dates referenced
- Document execution dates (agreements, deeds, settlements)
- Service dates
- Compliance / payment dates
- Any other concrete date with an action attached

STRICT RULES:
(1) Only events with a definite date (year required). Skip vague references like "earlier", "last year".
(2) Output dates in DD.MM.YYYY format (or YYYY only if month/day unknown).
(3) Each event description: ONE line, factual, no advocacy language.
(4) Skip purely procedural noise like "matter taken up", "list on next date" UNLESS a substantive event happened.

Return strict JSON:
{
  "events": [
    { "date": "DD.MM.YYYY", "what": "<one-line factual>", "confidence": "high|medium|low" }
  ]
}

ORDER INDEX: ${orderIndex}
ORDER DATE (from metadata, if known): ${orderDate || 'unknown'}

ORDER TEXT:
${snippet}`;

  const out = await ds([{ role: 'user', content: prompt }], { label: `order-${orderIndex}` });
  const evs = Array.isArray(out?.events) ? out.events : [];
  return evs.map(e => ({
    date: String(e.date || '').trim(),
    what: String(e.what || '').trim(),
    confidence: e.confidence || 'medium',
    order_index: orderIndex
  })).filter(e => e.date && e.what);
}

// Merge events across all orders + case.json metadata into one
// chronological timeline. De-duplicates and prefers higher-confidence
// versions of the same event.
function mergeEvents(allEventLists, caseJsonEvents = []) {
  const all = [...caseJsonEvents];
  for (const list of allEventLists) for (const ev of list) all.push(ev);

  // Group by date + similar text — dedupe
  const seen = new Map();   // key: date + first-30-chars-of-what
  for (const ev of all) {
    const k = ev.date + '|' + (ev.what || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 30);
    const existing = seen.get(k);
    if (!existing) { seen.set(k, ev); continue; }
    // Keep the higher-confidence one
    if (rankConfidence(ev.confidence) > rankConfidence(existing.confidence)) {
      seen.set(k, ev);
    }
  }

  // Sort chronologically — parse DD.MM.YYYY → epoch
  const events = [...seen.values()].sort((a, b) => parseDate(a.date) - parseDate(b.date));
  return events;
}

function rankConfidence(c) {
  return c === 'high' ? 3 : c === 'medium' ? 2 : c === 'low' ? 1 : 0;
}

function parseDate(s) {
  if (!s) return 0;
  // DD.MM.YYYY
  const m = String(s).match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})/);
  if (m) return Date.UTC(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]));
  // YYYY-MM-DD
  const m2 = String(s).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m2) return Date.UTC(parseInt(m2[1]), parseInt(m2[2]) - 1, parseInt(m2[3]));
  // YYYY only
  const y = String(s).match(/^(\d{4})$/);
  if (y) return Date.UTC(parseInt(y[1]), 0, 1);
  return 0;
}

// Helper — convert bail-watch case.json metadata into seed timeline events.
// Things like filing_date, registration_date, last_hearing — pre-known
// dates from eCourts.
function seedFromCaseJson(raw = {}) {
  const out = [];
  function add(date, what, conf = 'high') {
    if (date) out.push({ date, what, confidence: conf, source: 'eCourts metadata' });
  }
  add(raw.filing_date,        'Case filed before the Court');
  add(raw.registration_date,  'Case registered');
  add(raw.first_hearing_date, 'First hearing');
  // Hearings — pull each as an event
  (raw.hearings || raw.history || []).forEach(hg => {
    const d = hg.date || hg.hearingDate || hg.listed_on;
    const purpose = hg.purpose || hg.next_purpose || hg.stage || hg.business || 'Hearing';
    if (d) out.push({
      date: d, what: purpose, confidence: 'high', source: 'eCourts hearing record'
    });
  });
  return out;
}

module.exports = { extractEventsFromOrder, mergeEvents, seedFromCaseJson };
