const fetch = require('node-fetch');
const { buildSearchSystemPrompt, buildVerifierSystemPrompt, REFUSAL_BY_LANG } = require('../prompts');

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const SEARCH_MODEL = 'gemini-2.5-flash';
const RW_MODEL = 'gemini-2.5-flash-lite';   // for query rewrite + lang detect + verifier
const SCORE_THRESHOLD = 0.5;                // Layer 4 confidence cutoff

const GREETING_RE = /^\s*(hi|hello|hey|namaste|namaskar|sat sri akal|adab|salaam|salam|haan ji|haan|good (morning|afternoon|evening|night)|thanks|thank you|shukriya|dhanyavad|dhanyavaad|theek|ok|okay)[\s,.!?]*$/i;

async function createStore(displayName) {
  const res = await fetch(`${BASE}/fileSearchStores?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Gemini store error: ${JSON.stringify(data)}`);
  return data.name;
}

async function uploadAndImport(storeName, buffer, filename) {
  const initRes = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/${storeName}:uploadToFileSearchStore?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(buffer.length),
        'X-Goog-Upload-Header-Content-Type': 'application/pdf',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ displayName: filename })
    }
  );
  const uploadUrl = initRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error(`Gemini upload init failed: ${await initRes.text()}`);

  const upRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(buffer.length),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize'
    },
    body: buffer
  });
  const upData = await upRes.json();
  if (!upRes.ok) throw new Error(`Gemini upload failed: ${JSON.stringify(upData)}`);
  return { fileName: upData.name || filename };
}

// Light wrapper for non-search generateContent calls (temperature 0).
async function _generate(model, systemPrompt, userText, extraConfig = {}) {
  const res = await fetch(
    `${BASE}/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        generationConfig: { temperature: 0, ...extraConfig }
      })
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Gemini ${model} error: ${JSON.stringify(data)}`);
  const text = (data.candidates?.[0]?.content?.parts || [])
    .map(p => p.text || '').join('\n').trim();
  return { text, raw: data };
}

// Layer 3 helper — quick language detect (used to pick the refusal line).
async function detectLanguage(text) {
  // cheap regex first
  if (/[ऀ-ॿ]/.test(text)) return 'hi';        // devanagari
  if (/[਀-੿]/.test(text)) return 'pa';        // gurmukhi
  if (/[ঀ-৿]/.test(text)) return 'bn';        // bengali
  if (/[઀-૿]/.test(text)) return 'gu';        // gujarati
  if (/[஀-௿]/.test(text)) return 'ta';        // tamil
  if (/[ఀ-౿]/.test(text)) return 'te';        // telugu
  try {
    const r = await _generate(
      RW_MODEL,
      'Reply with ONLY a 2-letter ISO 639-1 code identifying the language of the user text. Examples: en, hi, mr, pa, bn, gu, ta, te. For Hinglish reply hi. For Punjabi in latin script reply pa. For Marathi in latin script reply mr.',
      text
    );
    const code = (r.text || '').trim().toLowerCase().slice(0, 2);
    return REFUSAL_BY_LANG[code] ? code : 'en';
  } catch {
    return 'en';
  }
}

// Layer 3 — rewrite the user query into 3 retrieval-flavoured variations.
async function rewriteQueries(userQuery) {
  try {
    const r = await _generate(
      RW_MODEL,
      `Rewrite the user query into 3 short retrieval queries for searching an Indian legal document. Cover: (a) the user's exact words, (b) common Hindi-English synonyms a court file would use (e.g. bail/jamanat, applicant/petitioner/yachi, charge/aaropp), (c) the formal legal phrasing. Return strict JSON: {"queries": ["q1","q2","q3"]}. No explanation.`,
      userQuery,
      { responseMimeType: 'application/json' }
    );
    const parsed = JSON.parse(r.text);
    const qs = Array.isArray(parsed.queries) ? parsed.queries.filter(Boolean).slice(0, 3) : [];
    return qs.length ? qs : [userQuery];
  } catch {
    return [userQuery];
  }
}

// Layer 1 + 4 + 5 — grounded search with multi-query + confidence filter + S-id format.
async function searchForRealtime(storeName, userQuery) {
  // Greeting carve-out (in system prompt, but we short-circuit here too).
  if (GREETING_RE.test(userQuery)) {
    return { snippets: [{ id: 'S0', page: 0, text: 'GREETING_ACK' }], refusal: null };
  }

  const lang = await detectLanguage(userQuery);
  const queries = await rewriteQueries(userQuery);

  // Layer 3 — fan out 3 queries in parallel.
  const sys = buildSearchSystemPrompt('case file');
  const calls = queries.map(q =>
    fetch(`${BASE}/models/${SEARCH_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sys }] },
        contents: [{ role: 'user', parts: [{ text: q }] }],
        tools: [{ fileSearch: { fileSearchStoreNames: [storeName] } }],
        generationConfig: { temperature: 0 }
      })
    }).then(r => r.json()).catch(() => null)
  );
  const results = await Promise.all(calls);

  // Layer 4 — collect grounding chunks, dedupe by text, filter by score.
  const seen = new Map(); // key = text → { page, score }
  for (const r of results) {
    if (!r || !r.candidates) continue;
    const cand = r.candidates[0];
    const chunks = (cand?.groundingMetadata?.groundingChunks) || [];
    const supports = (cand?.groundingMetadata?.groundingSupports) || [];

    // score chunks by max support confidence pointing at them
    const chunkScore = new Array(chunks.length).fill(0);
    for (const s of supports) {
      const idxs = s.groundingChunkIndices || [];
      const confs = s.confidenceScores || [];
      idxs.forEach((idx, i) => {
        const c = confs[i] ?? 0;
        if (c > chunkScore[idx]) chunkScore[idx] = c;
      });
    }

    chunks.forEach((c, i) => {
      const ctx = c.retrievedContext || c.retrieved_context || {};
      const text = (ctx.text || '').trim();
      const page = ctx.pageNumber ?? ctx.page_number ?? null;
      const score = chunkScore[i] || ctx.relevanceScore || 0;
      if (!text || text.length < 20) return;
      if (score < SCORE_THRESHOLD) return;
      const key = text.slice(0, 200);
      if (!seen.has(key) || seen.get(key).score < score) {
        seen.set(key, { page, score, text });
      }
    });
  }

  const sorted = [...seen.values()].sort((a, b) => b.score - a.score).slice(0, 6);

  // Layer 6 — refusal default if nothing made the threshold.
  if (sorted.length === 0) {
    return { snippets: [], refusal: REFUSAL_BY_LANG[lang] || REFUSAL_BY_LANG.en };
  }

  const snippets = sorted.map((s, i) => ({
    id: `S${i + 1}`,
    page: s.page,
    text: s.text
  }));
  return { snippets, refusal: null };
}

// Layer 8 — verify the assistant's draft against the snippets used.
async function verifyClaims(snippets, draft) {
  const sys = buildVerifierSystemPrompt();
  const payload = JSON.stringify({ draft, snippets }, null, 2);
  try {
    const r = await _generate(RW_MODEL, sys, payload,
      { responseMimeType: 'application/json' });
    const parsed = JSON.parse(r.text);
    return {
      verdict: parsed.verdict || 'partial',
      unsupported_claims: Array.isArray(parsed.unsupported_claims) ? parsed.unsupported_claims : []
    };
  } catch (e) {
    return { verdict: 'partial', unsupported_claims: [], error: e.message };
  }
}

module.exports = {
  createStore,
  uploadAndImport,
  searchForRealtime,
  verifyClaims,
  detectLanguage
};
