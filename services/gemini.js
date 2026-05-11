const fetch = require('node-fetch');
const { buildSearchSystemPrompt, buildVerifierSystemPrompt, REFUSAL_BY_LANG } = require('../prompts');

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const SEARCH_MODEL = 'gemini-2.5-flash';
const RW_MODEL = 'gemini-2.5-flash-lite';   // for query rewrite + lang detect + verifier

const SCORE_THRESHOLD_LOOKUP = 0.35;        // Layer 4 — specific Q&A
const SCORE_THRESHOLD_BROAD  = 0.20;        // Broad / overview / summary queries
const MIN_SYNTHESIS_LEN      = 60;          // chars Gemini must speak to count as real synthesis

const GREETING_RE = /^\s*(hi|hello|hey|namaste|namaskar|sat sri akal|adab|salaam|salam|haan ji|haan|good (morning|afternoon|evening|night)|thanks|thank you|shukriya|dhanyavad|dhanyavaad|theek|ok|okay)[\s,.!?]*$/i;

// Broad / synthesis-type questions — anywhere in the query.
const BROAD_RE = /\b(summar(y|ise|ize)|overview|main (point|argument|finding|issue|topic)s?|key (point|argument|finding|issue|takeaway)s?|gist|outline|what (is|are) (this|the)|about|sammari|saaransh|saransh|saraansh|sarvajanik|mukhya|seedha[- ]?seedha|kul milake|kya hai|brief|tldr|short)\b/i;

// Patterns that signal Gemini is itself refusing (i.e. the document doesn't
// contain the answer). We treat these as "no synthesis" so the server-side
// refusal in the user's language fires instead.
const GEMINI_SELF_REFUSAL_RE = /\b(i (am|'m) sorry|i cannot|i can(no|')t (find|locate|provide|answer|determine)|does (not|n't) contain|does (not|n't) (mention|provide|state|specify|include|cover)|no (information|mention|reference|details?|data) (about|on|regarding|for)|not (mentioned|contained|stated|specified|provided|present|included|found|indicated|addressed) in (the|this) (document|file|provided)|is not (in|part of|within) (the|this) (document|file|provided)|the (document|file|provided (text|content)) does (not|n't))/i;

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
  // Response is an Operation (long-running). Return its name so the caller polls.
  return { operationName: upData.name || null };
}

// Poll a File Search upload operation until done. Returns the final document name.
async function pollIndexingComplete(operationName, { maxAttempts = 150, intervalMs = 2000 } = {}) {
  if (!operationName) throw new Error('operation name required');
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(
      `${BASE}/${operationName}?key=${process.env.GEMINI_API_KEY}`
    );
    const data = await res.json();
    if (!res.ok) throw new Error(`Operation poll failed: ${JSON.stringify(data)}`);
    if (data.done) {
      if (data.error) throw new Error(`Indexing failed: ${JSON.stringify(data.error)}`);
      const docName = data.response?.document || data.response?.name || null;
      return { documentName: docName, raw: data };
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error('Indexing poll timed out');
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
// Optimization: for short specific lookups (≤ 6 words, not a broad summary),
// skip the rewriter LLM call entirely — saves ~400ms per turn. Recall is
// fine because Gemini File Search already handles light morphology.
async function rewriteQueries(userQuery, isBroad = false) {
  const wordCount = (userQuery.trim().match(/\S+/g) || []).length;
  if (!isBroad && wordCount <= 6) return [userQuery];

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
// Now also captures Gemini's grounded synthesis text as a fallback "SYN" snippet
// so broad/overview questions don't trigger refusal when Gemini already
// produced a good document-grounded answer.
async function searchForRealtime(storeName, userQuery) {
  if (GREETING_RE.test(userQuery)) {
    return { snippets: [{ id: 'S0', page: 0, text: 'GREETING_ACK' }], refusal: null };
  }

  const isBroad = BROAD_RE.test(userQuery);
  const threshold = isBroad ? SCORE_THRESHOLD_BROAD : SCORE_THRESHOLD_LOOKUP;
  // run language detect + rewrite in parallel
  const [lang, queries] = await Promise.all([
    detectLanguage(userQuery),
    rewriteQueries(userQuery, isBroad)
  ]);

  // For broad queries, also include the original phrasing so Gemini synthesises
  // a real overview rather than just retrieving pinpoint chunks. Cap at 3 calls
  // (was 4) to shave ~300ms off the slowest fan-out.
  const broadenedQueries = isBroad
    ? [...new Set([userQuery, ...queries])].slice(0, 3)
    : queries.slice(0, 2);  // specific lookup — 2 calls is enough recall

  const sys = buildSearchSystemPrompt('case file');
  const calls = broadenedQueries.map(q =>
    fetch(`${BASE}/models/${SEARCH_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sys }] },
        contents: [{ role: 'user', parts: [{ text: q }] }],
        tools: [{ fileSearch: { fileSearchStoreNames: [storeName] } }],
        generationConfig: {
          temperature: 0,
          thinkingConfig: { thinkingBudget: 0 }   // skip thinking — pure retrieval
        }
      })
    }).then(r => r.json()).catch(() => null)
  );
  const results = await Promise.all(calls);

  // Pass 1 — collect chunks + their scores AND Gemini's grounded answer text per call.
  const seen = new Map();           // text-key → { page, score, text }
  const synthesisChunks = [];       // Gemini's actual prose answers, with pages cited
  const pagesSeen = new Set();      // union of pages referenced anywhere

  for (const r of results) {
    if (!r || !r.candidates) continue;
    const cand = r.candidates[0];

    // Gemini's synthesis answer for this query
    const answerText = (cand?.content?.parts || [])
      .map(p => p.text || '').join('\n').trim();

    const chunks = (cand?.groundingMetadata?.groundingChunks) || [];
    const supports = (cand?.groundingMetadata?.groundingSupports) || [];

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
      if (page != null) pagesSeen.add(page);
      if (!text || text.length < 20) return;
      if (score < threshold) return;
      const key = text.slice(0, 200);
      if (!seen.has(key) || seen.get(key).score < score) {
        seen.set(key, { page, score, text });
      }
    });

    if (answerText && answerText.length >= MIN_SYNTHESIS_LEN
        && !GEMINI_SELF_REFUSAL_RE.test(answerText)) {
      const pages = chunks
        .map(c => (c.retrievedContext || c.retrieved_context || {}).pageNumber)
        .filter(p => p != null);
      // If Gemini didn't ground ANY page, it's almost certainly speculating —
      // don't accept the synthesis.
      if (pages.length > 0) {
        synthesisChunks.push({ text: answerText, pages });
      }
    }
  }

  const sorted = [...seen.values()].sort((a, b) => b.score - a.score).slice(0, 6);

  // Path A — we have specific grounded chunks. Return them.
  if (sorted.length > 0) {
    const snippets = sorted.map((s, i) => ({
      id: `S${i + 1}`, page: s.page, text: s.text
    }));
    return { snippets, refusal: null };
  }

  // Path B — no chunks made the threshold, but Gemini synthesised something
  // grounded. For broad questions especially this is the right path.
  if (synthesisChunks.length > 0) {
    // pick the longest substantive synthesis (richest answer)
    synthesisChunks.sort((a, b) => b.text.length - a.text.length);
    const best = synthesisChunks[0];
    const pages = [...new Set([...(best.pages || []), ...pagesSeen])].sort((a, b) => a - b);
    return {
      snippets: [{
        id: 'SYN',
        page: pages[0] ?? null,
        pages,
        text: best.text
      }],
      refusal: null
    };
  }

  // Path C — truly nothing. Refusal in user's language.
  return { snippets: [], refusal: REFUSAL_BY_LANG[lang] || REFUSAL_BY_LANG.en };
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
  pollIndexingComplete,
  searchForRealtime,
  verifyClaims,
  detectLanguage
};
