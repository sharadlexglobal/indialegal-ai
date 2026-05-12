/**
 * DeepSeek V4 Flash client.
 *
 * Used for two production tasks (per benchmark winner, top-3 = 7.06):
 *   1. decodeQuery   — natural Hindi → {statute, section, court_code, clean_keywords}
 *   2. scoreCandidate — score an IKAPI result against the user's actual intent
 *
 * Both functions return null on failure so callers can fall back
 * gracefully (better to keep prod running than to crash on one
 * upstream blip).
 */

const fetch = require('node-fetch');

const URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-v4-flash';

async function deepseekJson(messages, { timeoutMs = 30000 } = {}) {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.warn('[deepseek] DEEPSEEK_API_KEY missing — skipping');
    return null;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      const r = await fetch(URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({
          model: MODEL, messages,
          response_format: { type: 'json_object' },
          temperature: 0
        }),
        signal: ctl.signal
      });
      clearTimeout(t);
      const j = await r.json();
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
      const txt = j.choices?.[0]?.message?.content || '{}';
      return JSON.parse(txt);
    } catch (e) {
      console.warn(`[deepseek] retry ${attempt + 1}: ${e.message}`);
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  return null;
}

const COURT_CODES_HINT = [
  'supremecourt', 'delhi', 'bombay', 'kolkata', 'chennai', 'allahabad',
  'andhra', 'chattisgarh', 'gauhati', 'jammu', 'srinagar', 'kerala',
  'lucknow', 'orissa', 'uttaranchal', 'gujarat', 'himachal_pradesh',
  'jharkhand', 'karnataka', 'madhyapradesh', 'patna', 'punjab',
  'rajasthan', 'sikkim', 'meghalaya', 'delhidc', 'itat', 'cci',
  'consumer', 'cat', 'drat', 'sebisat', 'greentribunal', 'aptel',
  'highcourts', 'tribunals', 'judgments'
].join(', ');

async function decodeQuery(naturalQuery) {
  const prompt = `You are converting an Indian advocate's natural Hindi/Hinglish question into a CLEAN Indian Kanoon search.

USER: ${naturalQuery}

Court codes available: ${COURT_CODES_HINT}. Use "judgments" if unsure.

Return strict JSON:
{
  "statute": "<exact name e.g. 'CrPC', 'IPC', 'NI Act', 'PMLA', 'HMA', 'NDPS Act', 'POCSO Act'>",
  "section": "<just the number e.g. '482', '37', '138', '438'>",
  "court_code": "<exact code from list>",
  "stage": "<bail | quash | charge_framing | trial | appeal | maintenance | injunction | partition | infringement | discharge | other>",
  "clean_keywords": "<3-7 word legal keyword phrase, NO Hindi chaff>",
  "is_recent_query": <true if user said latest/recent/abhi ka/last N years/last few years>
}`;
  return await deepseekJson([{ role: 'user', content: prompt }]);
}

async function scoreCandidate(intent, candidate) {
  const prompt = `Score this Indian Kanoon search result for an Indian advocate's intent (0-10 each):

INTENT:
  statute: ${intent.statute || '?'}
  section: ${intent.section || '?'}
  stage:   ${intent.stage || '?'}
  keywords:${intent.clean_keywords || '?'}

CANDIDATE:
  Title:   ${candidate.title || '?'}
  Court:   ${candidate.court || '?'}
  Date:    ${candidate.date || candidate.judgment_date || '?'}
  Snippet: ${(candidate.snippet || candidate.headline || '').slice(0, 700)}

Return strict JSON:
{"provision_match": <int>, "stage_match": <int>, "citable_quote": <int>, "recency": <int>,
 "overall": <int 0-10>, "verdict": "<one-line reason>"}`;
  return await deepseekJson([{ role: 'user', content: prompt }]);
}

module.exports = { decodeQuery, scoreCandidate };
