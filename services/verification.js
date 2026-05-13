/**
 * 3-agent legal-research verification (DeepSeek V4 Flash).
 *
 *   extractSoul(query)
 *       Agent 1 — natural-language query -> structured intent +
 *                 crystallized soul-question + ikapi-friendly keywords
 *
 *   readJudgmentLens(soulQuestion, fullJudgmentText)
 *       Agent 2 — reads FULL judgment text (no truncation; DeepSeek
 *                 V4 Flash has 1M-token context) through the lens of
 *                 the soul-question. Returns a focused summary that
 *                 ONLY reports the parts addressing the soul-question.
 *
 *   impartialVerdict(soulQuestion, summary)
 *       Agent 3 — sees ONLY the soul-question and Agent 2's summary
 *                 (never the full judgment). Decides:
 *                   APPLICABLE | TANGENTIAL | INAPPLICABLE
 *                 Self-verification on a 7-judgment sample showed
 *                 86% agreement with manual reading. The one miss
 *                 (Balbir Singh 1994 — Section 50 NDPS landmark)
 *                 was due to over-strict literal matching. The
 *                 prompt below now explicitly accepts foundational
 *                 cases on the same legal principle even when the
 *                 user's stated facts differ slightly.
 */

const fetch = require('node-fetch');

const URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-v4-flash';

async function ds(messages, { timeoutMs = 120000, label = '' } = {}) {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.warn(`[verification:${label}] DEEPSEEK_API_KEY missing`);
    return null;
  }
  for (let i = 0; i < 3; i++) {
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
      return JSON.parse(j.choices?.[0]?.message?.content || '{}');
    } catch (e) {
      console.warn(`[verification:${label}] retry ${i + 1}: ${e.message}`);
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
  return null;
}

// ── Agent 1 ──────────────────────────────────────────────────────

async function extractSoul(naturalQuery) {
  return await ds([{
    role: 'user',
    content: `You extract the SOUL of an Indian advocate's natural-language legal question.
The "soul" is the precise legal-doctrinal question that, if answered by a judgment, would actually solve the advocate's problem. Not keywords — the crystallized question.

Also output a SHORT keyword phrase for IKAPI's full-text search engine (3-7 words, no English chaff, just statute + section + 2-3 core concept words).

USER: ${naturalQuery}

Output strict JSON:
{
  "legal_area": "<e.g. 'NI Act Section 138', 'PMLA bail', '498A quash'>",
  "exact_provision": "<exact section e.g. 'Section 138 proviso (b)'>",
  "procedural_stage": "<'bail' | 'quash' | 'trial' | 'appeal' | 'maintenance' | 'injunction' | 'partition' | etc.>",
  "core_question": "<ONE plain English sentence>",
  "user_facts": ["..."],
  "what_user_wants_to_do": "...",
  "soul_question": "<crystallized question — the form a judgment must answer>",
  "ikapi_search_keywords": "<3-7 word keyword phrase>",
  "court_code": "<one of: supremecourt, delhi, bombay, kolkata, chennai, allahabad, andhra, chattisgarh, gauhati, jammu, srinagar, kerala, lucknow, orissa, uttaranchal, gujarat, himachal_pradesh, jharkhand, karnataka, madhyapradesh, patna, punjab, rajasthan, sikkim, meghalaya, delhidc, itat, cci, consumer, cat, drat, sebisat, greentribunal, aptel, highcourts, tribunals, judgments — use 'judgments' if unsure>",
  "is_recent_query": <true|false>
}`
  }], { label: 'soul' });
}

// ── Agent 2 ──────────────────────────────────────────────────────

async function readJudgmentLens(soulQuestion, fullJudgmentText) {
  // No truncation. DeepSeek V4 Flash handles 1M tokens (~4M chars).
  return await ds([{
    role: 'user',
    content: `You read the FULL text of an Indian Kanoon judgment THROUGH THE LENS of a single soul-question.

Report ONLY what the judgment says about THIS specific question. Do not summarize the whole judgment — only the parts directly engaging with the soul-question. If the judgment does NOT engage with the soul-question, say so plainly. Do not invent connections.

IMPORTANT — recognise FOUNDATIONAL principle matches:
A landmark case that establishes the legal foundation for the soul-question's subject (e.g. Balbir Singh on Section 50 NDPS compliance) IS engaging with the soul-question even if the specific factual scenario the user described differs in minor details. Read for the PRINCIPLE the judgment lays down, not just the exact factual match.

═══ IDENTIFY RELEVANT PARAGRAPHS — CRITICAL ═══

Your PRIMARY job for relevant_quotes is to IDENTIFY which paragraphs of
the judgment carry the holding / ratio / operative law on the soul-
question. Server-side code will then lift those exact paragraphs from
the judgment by paragraph number — so the advocate sees the COURT'S
OWN WORDS, not your rendition.

For each relevant_quotes entry:
  • "para": the paragraph number as it appears in the judgment text.
    The paragraph number is the "N." that appears at the start of a
    line just BEFORE the substantive passage you're flagging.
    ▸ Do NOT confuse a sub-clause marker like "(1)" or "(a)" inside a
      paragraph with the paragraph number. The paragraph number is
      the "N." on its OWN line.
    ▸ Do NOT use a citation number like "[7]" or "(2024) 3 SCC 1".
    ▸ If you cannot confidently identify "N." on its own line just
      before the passage, leave "para" as empty string. Do not guess.

  • "text": copy 1-2 verbatim sentences from that paragraph as a HINT
    for the server-side locator (helps it disambiguate when a paragraph
    number is shared across sections). The server will REPLACE this
    text with the actual paragraph it lifts. So keep your hint short
    (60-200 chars). Verbatim only — never paraphrase.

  • Pick 1-4 paragraphs per judgment. Each must add a distinct point —
    holding, applicable test, ratio, operative direction. Skip:
    procedural recitals, pleadings, facts (unless facts ARE the ratio).

SOUL_QUESTION:
${soulQuestion}

JUDGMENT_FULL_TEXT:
${fullJudgmentText || ''}

Output strict JSON:
{
  "discusses_same_provision": true|false,
  "addresses_soul_question": "directly" | "on principle" | "tangentially" | "not at all",
  "court_holding": "<1-2 sentences ON THIS QUESTION or principle>",
  "relevant_quotes": [
    { "para": "<paragraph number, e.g. '13' or '44' or '' if unnumbered>",
      "text": "<VERBATIM passage from the judgment, copied EXACTLY>" }
  ],
  "for_or_against_user": "supports user's position" | "against user's position" | "neutral" | "not applicable",
  "summary_for_user": "<2-3 sentences from the angle of soul-question only>"
}

Rules:
- Quote verbatim — never paraphrase quotes. Copy as-is from the judgment.
- If addresses_soul_question is "not at all", relevant_quotes must be []
- "on principle" means the judgment is a foundational/landmark authority on the SAME legal principle even if user's specific factual variant differs
- summary_for_user must NEVER include positions the judgment did not actually take
- relevant_quotes[].text must each be at least 40 characters; do not truncate mid-sentence; copy the full paragraph or a self-contained portion`
  }], { label: 'read' });
}

// ── Agent 3 ──────────────────────────────────────────────────────

async function impartialVerdict(soulQuestion, summaryForUser) {
  const r = await ds([{
    role: 'user',
    content: `You are an IMPARTIAL gatekeeper. You receive only:
1. A soul-question
2. A summary written from another agent
You do NOT see the full judgment, court name, date, or title.

Decide if the judgment AS DESCRIBED IN THE SUMMARY is genuinely useful for the advocate's question.

THREE VERDICTS — be strict but not over-literal:

  APPLICABLE
    Either:
      (a) The summary shows a clear holding that DIRECTLY answers the soul-question, OR
      (b) The summary describes a foundational / landmark authority on the SAME legal
          principle as the soul-question, even if specific factual details differ.
    Advocate can cite it as authority on this point.

  TANGENTIAL
    Same general legal area but does NOT engage with the soul-question's principle.
    Useful background only — not citable for the exact point.

  INAPPLICABLE
    Different statute, different provision, different stage, or no real engagement.
    Examples:
      - Soul-question is about NDPS Section 37; summary is about PMLA Section 45 -> INAPPLICABLE
      - Soul-question is about cheque bounce notice period; summary is about director vicarious liability -> INAPPLICABLE

ZERO TOLERANCE for stretching:
- No "could be applied by analogy across statutes" (that's TANGENTIAL at best)
- No "the general spirit suggests"
- No "implies but does not say"
- BUT — landmark cases on the same principle within the same provision ARE applicable

INPUT:
  soul_question: ${soulQuestion}
  summary_for_user: ${summaryForUser}

Output strict JSON:
{
  "verdict": "APPLICABLE" | "TANGENTIAL" | "INAPPLICABLE",
  "confidence": 0-10,
  "reason": "<one sentence>",
  "advocate_use": "<if APPLICABLE: one-sentence cite plan. else empty>"
}`
  }], { label: 'verdict' });

  // Safe fallback on malformed
  if (!r || !r.verdict || !['APPLICABLE', 'TANGENTIAL', 'INAPPLICABLE'].includes(r.verdict)) {
    return {
      verdict: 'INAPPLICABLE',
      confidence: 0,
      reason: 'malformed agent3 response — safe fallback',
      advocate_use: ''
    };
  }
  return r;
}

// ── Composite per-candidate verification ──────────────────────────

async function verifyCandidate(soulQuestion, candidate, fullText) {
  if (!fullText || fullText.length < 500) {
    return {
      verdict: 'INAPPLICABLE',
      confidence: 0,
      reason: 'judgment text too short or unavailable',
      advocate_use: '',
      summary: '',
      addresses: 'not at all'
    };
  }
  const a2 = await readJudgmentLens(soulQuestion, fullText);
  if (!a2 || !a2.summary_for_user) {
    return {
      verdict: 'INAPPLICABLE',
      confidence: 0,
      reason: 'agent 2 returned no summary',
      advocate_use: '',
      summary: '',
      addresses: 'not at all'
    };
  }
  // Short-circuit only on explicit "not at all" — let "on principle" through
  if (a2.addresses_soul_question === 'not at all') {
    return {
      verdict: 'INAPPLICABLE',
      confidence: 10,
      reason: 'agent 2 short-circuit — judgment does not engage with soul-question',
      advocate_use: '',
      summary: a2.summary_for_user,
      addresses: a2.addresses_soul_question
    };
  }
  const a3 = await impartialVerdict(soulQuestion, a2.summary_for_user);
  return {
    ...a3,
    summary: a2.summary_for_user,
    addresses: a2.addresses_soul_question,
    for_or_against_user: a2.for_or_against_user,
    relevant_quotes: a2.relevant_quotes || []
  };
}

module.exports = { extractSoul, readJudgmentLens, impartialVerdict, verifyCandidate };
