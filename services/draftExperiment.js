/**
 * Drafting experiment — template + DeepSeek fill flow.
 *
 *   1. Holds the static template (court-rule-mandated structure,
 *      verbatim section headings, prayer formula, etc.)
 *   2. Pulls the case data (segments + rollup) from DB
 *   3. Asks DeepSeek to FILL the variable sections — keeping the
 *      fixed parts untouched. Every factual claim must cite a source
 *      [Page N] / [seg X] / [verified authority].
 *   4. Returns court-ready markdown.
 *
 * This is the lean "template + LLM fills the gaps" approach — 80% of
 * the output is deterministic substitution, only 20% is LLM-generated
 * (the actual arguments).
 */

const fetch = require('node-fetch');
const courtIdentifier = require('./courtIdentifier');

const URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL_FLASH    = process.env.DEEPSEEK_FLASH_MODEL    || 'deepseek-v4-flash';
// DeepSeek's reasoning model in this deployment is named "deepseek-v4-pro".
const MODEL_REASONER = process.env.DEEPSEEK_REASONER_MODEL || 'deepseek-v4-pro';
const MODEL = MODEL_FLASH; // back-compat default

const IKAPI_MCP_URL = process.env.IKAPI_MCP_URL || 'https://ikapi.onrender.com/mcp';

// Low-level call. Returns { raw, finishReason, parsed }.
// Setting max_tokens high (8192 is DeepSeek's hard cap as of writing); the
// API clamps if needed. Caller decides whether to demand JSON or plain text.
async function dsRaw(messages, {
  timeoutMs = 240000,
  label = '',
  json = true,
  max_tokens = 8192,
  temperature = 0,
  model = MODEL_FLASH
} = {}) {
  // Reasoner: bump token allowance (CoT eats output budget) + longer timeout
  const isReasoner = /reasoner/i.test(model);
  if (isReasoner) {
    if (max_tokens < 16384) max_tokens = 16384;
    if (timeoutMs < 480000) timeoutMs = 480000;
  }
  for (let i = 0; i < 3; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      const body = {
        model, messages,
        temperature,
        max_tokens
      };
      if (json) body.response_format = { type: 'json_object' };
      const r = await fetch(URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify(body),
        signal: ctl.signal
      });
      clearTimeout(t);
      const j = await r.json();
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
      const choice = j.choices?.[0] || {};
      const content = choice.message?.content || '';
      const finishReason = choice.finish_reason || 'unknown';
      let parsed = null;
      if (json) {
        try { parsed = JSON.parse(content); } catch { parsed = null; }
      }
      return { raw: content, finishReason, parsed, usage: j.usage };
    } catch (e) {
      console.warn(`[draftExp:${label}] retry ${i + 1}: ${e.message}`);
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
  return { raw: '', finishReason: 'error', parsed: null };
}

// Legacy thin wrapper — preserves old call sites.
async function ds(messages, opts = {}) {
  const r = await dsRaw(messages, opts);
  return r.parsed;
}

// ─── Long-output wrapper with auto-continuation ────────────────
// Use this for the FILL and HUMANIZE passes where the JSON value can
// exceed 8K tokens. The wrapper:
//   1. Calls dsRaw with max_tokens.
//   2. If finish_reason === 'length' OR JSON parse failed, runs a
//      continuation chat: assistant=<truncated>, user="continue".
//   3. Stitches the raw text and re-parses. Up to 3 continuation hops.
//
// This works because DeepSeek's JSON-mode (response_format=json_object)
// still respects the assistant's prior partial output in a multi-turn
// continuation — it picks up writing valid JSON from where it left off.
async function dsLong(messages, {
  timeoutMs = 240000,
  label = '',
  json = true,
  max_tokens = 8192,
  maxContinuations = 4,
  model = MODEL_FLASH,
  temperature = 0
} = {}) {
  let combined = '';
  let convo = [...messages];
  let lastFinish = '';

  for (let hop = 0; hop <= maxContinuations; hop++) {
    const { raw, finishReason } = await dsRaw(convo, {
      timeoutMs, label: `${label}:hop${hop}`, json, max_tokens, model, temperature
    });
    if (!raw) {
      console.warn(`[draftExp:${label}] hop${hop} empty response`);
      break;
    }
    combined += raw;
    lastFinish = finishReason;

    // Try parsing what we have
    if (json) {
      try {
        const parsed = JSON.parse(combined);
        return { parsed, raw: combined, finishReason: 'stop', hops: hop + 1 };
      } catch {
        // Not parseable yet
      }
    }

    // Decide whether to continue
    const needsMore = finishReason === 'length'
                   || (json && !canParseJson(combined));
    if (!needsMore) break;

    // Build continuation message:
    //   assistant: <truncated so far>
    //   user: "continue from EXACTLY where you stopped..."
    convo = [
      ...messages,
      { role: 'assistant', content: combined },
      { role: 'user', content:
        'Your previous response was truncated by the output-token limit. '
        + 'Continue writing the response from EXACTLY where you stopped — '
        + 'do NOT repeat any text you already produced, do NOT start a new '
        + 'JSON object. Just continue the same JSON so the entire output '
        + 'parses as one valid JSON object. End with valid closing braces.'
      }
    ];
  }

  // Final attempt
  if (json) {
    try { return { parsed: JSON.parse(combined), raw: combined, finishReason: lastFinish, hops: maxContinuations + 1 }; }
    catch {
      // Best-effort repair: trim trailing partial token and try to close
      const repaired = bestEffortCloseJson(combined);
      try { return { parsed: JSON.parse(repaired), raw: repaired, finishReason: lastFinish, hops: maxContinuations + 1, repaired: true }; }
      catch { return { parsed: null, raw: combined, finishReason: lastFinish, hops: maxContinuations + 1, error: 'unparseable' }; }
    }
  }
  return { parsed: null, raw: combined, finishReason: lastFinish, hops: maxContinuations + 1 };
}

function canParseJson(s) {
  try { JSON.parse(s); return true; } catch { return false; }
}

// Trim trailing partial chars and close any open JSON containers.
function bestEffortCloseJson(s) {
  let t = s.trim();
  // Trim to last balanced string close if mid-string
  // (simple heuristic — count quotes outside escapes)
  let inStr = false, esc = false, last = -1;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; if (!inStr) last = i; }
  }
  if (inStr && last >= 0) t = t.slice(0, last + 1);
  // Count braces and brackets
  let braces = 0, brackets = 0; inStr = false; esc = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === '{') braces++;
    else if (c === '}') braces--;
    else if (c === '[') brackets++;
    else if (c === ']') brackets--;
  }
  // Strip dangling comma
  t = t.replace(/,\s*$/, '');
  while (brackets-- > 0) t += ']';
  while (braces-- > 0) t += '}';
  return t;
}

// Build the dump that goes into the prompt — compact but complete.
function buildCaseDump({ caseTitle, segments, rollup, legal_issues }) {
  const lines = [];
  lines.push(`CASE: ${caseTitle}`);
  lines.push('');
  if (rollup?.brief) {
    lines.push('--- CASE BRIEF ---');
    lines.push(rollup.brief);
    lines.push('');
  }
  const tl = rollup?.timeline || [];
  if (tl.length) {
    lines.push(`--- TIMELINE (${tl.length} events) ---`);
    for (const e of tl.slice(0, 60)) lines.push(`${e.date || '?'}: ${e.event || ''}`);
    lines.push('');
  }
  const parties = rollup?.party_graph || [];
  if (parties.length) {
    lines.push(`--- PARTIES ---`);
    for (const p of parties.slice(0, 20)) {
      lines.push(`${p.canonical_name} (aliases: ${(p.aliases || []).slice(0, 3).join(', ')})`);
    }
    lines.push('');
  }
  const issues = legal_issues?.issues || [];
  if (issues.length) {
    lines.push(`--- LEGAL ISSUES IDENTIFIED ---`);
    for (const i of issues.slice(0, 10)) {
      lines.push(`[${i.category}] ${i.name}`);
      lines.push(`  facts: ${(i.factual_basis || '').slice(0, 200)}`);
      lines.push(`  law: ${(i.applicable_law || '').slice(0, 200)}`);
    }
    lines.push('');
  }
  lines.push(`--- SUB-DOCUMENTS (${segments.length}) ---`);
  for (const s of segments) {
    const f = s.facts || {};
    const key = ['document_date','document_reference_number','case_title','case_number',
                 'court','filing_date','petitioner','respondent','parties',
                 'one_line_summary','main_prayers','prayers','operative_directions',
                 'facts_paragraphs','grounds','preliminary_objections',
                 'statutory_invocation','sections','cause_of_action_paragraph',
                 'cause_of_action_description','order_outcome'];
    const compact = {};
    for (const k of key) if (f[k]) compact[k] = f[k];
    if (Object.keys(compact).length === 0) continue;
    lines.push(`\nseg${s.segment_index} (${s.segment_type}, pp${s.page_start}-${s.page_end})`);
    for (const [k, v] of Object.entries(compact)) {
      if (Array.isArray(v)) {
        lines.push(`  ${k}: ${v.slice(0, 5).map(x => String(x).slice(0, 200)).join(' | ')}`);
      } else {
        lines.push(`  ${k}: ${String(v).slice(0, 300)}`);
      }
    }
  }
  return lines.join('\n');
}

// ─── The template ──────────────────────────────────────────────
// CAUSE-TITLE BLOCK is now a DYNAMIC placeholder filled by Court
// Identifier output. We never hardcode "Delhi HC" — court agent
// decides the correct forum + designation + format.
const WRITTEN_ARG_OVR17_TEMPLATE = `
{{cause_title_block}}

**Case No.: {{case_number}}**

**IN THE MATTER OF:**

{{plaintiff_full_block}}    ...Plaintiff / Respondent in Counter-Claim

VERSUS

{{defendant_full_block}}    ...Defendant / Counter-Claimant

**AND**

**IN COUNTER-CLAIM NO. {{counter_claim_no}}**

{{counter_claimant_block}}    ...Counter-Claimant / Applicant

VERSUS

{{non_counter_claimant_block}}    ...Non-Counter-Claimant / Respondent

---

# **WRITTEN ARGUMENTS ON BEHALF OF THE COUNTER-CLAIMANT / DEFENDANT IN SUPPORT OF APPLICATION UNDER ORDER VI RULE 17 READ WITH SECTION 151 OF THE CODE OF CIVIL PROCEDURE, 1908**

**MOST RESPECTFULLY SHOWETH:**

## I.  PRELIMINARY

**1.** The Counter-Claimant has filed the captioned application under Order VI Rule 17 read with Section 151 of the Code of Civil Procedure, 1908 (hereinafter "CPC") seeking leave to {{purpose_of_amendment}}. The present written arguments are filed in support of the said application and by way of reply to the objections raised by the Non-Counter-Claimant.

## II. BRIEF CHRONOLOGY OF EVENTS

{{chronology_paragraphs}}

## III. NATURE OF THE AMENDMENT SOUGHT

{{nature_of_amendment_paragraphs}}

## IV. STATUTORY FRAMEWORK

**5.** Order VI Rule 17 CPC, which governs the amendment of pleadings, reads as under:

> "**17. Amendment of pleadings.**—The Court may at any stage of the proceedings allow either party to alter or amend his pleadings in such manner and on such terms as may be just, and all such amendments shall be made as may be necessary for the purpose of determining the real questions in controversy between the parties:
>
> Provided that no application for amendment shall be allowed after the trial has commenced, unless the Court comes to the conclusion that in spite of due diligence, the party could not have raised the matter before the commencement of trial."

**6.** The settled judicial position on Order VI Rule 17 may be summarised as follows:

(a) Amendments are to be allowed liberally so long as they do not cause injustice or prejudice to the other side;

(b) The dominant purpose is to do substantial justice between the parties and to bring the real controversy on record;

(c) Where the trial has not commenced (in the sense of issues being framed and evidence being led), the proviso to Rule 17 is not strictly attracted, and the test of "due diligence" applies only at a more rigorous level once trial has begun.

## V. GROUNDS ON WHICH THE AMENDMENT OUGHT TO BE ALLOWED

{{grounds_paragraphs}}

## VI. JUDICIAL AUTHORITIES RELIED UPON

{{authorities_paragraphs}}

## VII. REPLY TO OBJECTIONS RAISED BY THE NON-COUNTER-CLAIMANT

{{reply_to_objections_paragraphs}}

## VIII. PRAYER

In light of the aforesaid submissions, it is most respectfully prayed that this Hon'ble Court may be pleased to:

{{prayer_clauses}}

**AND/OR pass such further and other order(s) as this Hon'ble Court may deem fit and proper in the facts and circumstances of the present case, in the interest of justice.**

---

**Place:** New Delhi
**Dated:** {{date_of_filing}}

                                                                                                                                              **COUNSEL FOR THE COUNTER-CLAIMANT / DEFENDANT**

                                                                                                                                              {{counsel_block}}
`;

// ─── Build the DeepSeek fill prompt ─────────────────────────────
function buildFillPrompt(dump, template) {
  return `You are a senior Indian advocate drafting court-ready WRITTEN ARGUMENTS for filing in the Delhi High Court. You have the case data (extracted, structured, with citations to source pages) and a template with {{placeholders}} that you must fill.

RULES — strict:

(R1) DO NOT alter the template's section headings, section numbers, or fixed text. Only fill the {{placeholders}}.

(R2) Every factual claim you write must be GROUNDED in the case data dump. Where possible, append a source tag inline like "[seg N pp X-Y]" or "[Page N of plaint]" so the senior can verify.

(R3) Every case-law citation must be a REAL Indian case you are confident about — name + court + year + citation. For Order VI Rule 17 amendment, the locus classicus are:
  • Revajeetu Builders & Developers v. Narayanaswamy & Sons, (2009) 10 SCC 84
  • Surender Kumar Sharma v. Makhan Singh, (2009) 10 SCC 626
  • Vidyabai v. Padmalatha, (2009) 2 SCC 409
  • Estralla Rubber v. Dass Estate (P) Ltd., (2001) 8 SCC 97
  • Andhra Bank v. ABN Amro Bank N.V., (2007) 6 SCC 167
  • Rajkumar Gurawara v. SK Sarwagi, (2008) 14 SCC 364
  • North Eastern Railway v. Bhagwan Das, (2008) 8 SCC 511
  • Pankaja v. Yellappa, (2004) 6 SCC 415
  • L.J. Leach & Co. v. Jardine Skinner & Co., AIR 1957 SC 357
  • B.K. Narayana Pillai v. Parameswaran Pillai, (2000) 1 SCC 712
  Use whichever fit the actual amendment context. Quote verbatim paragraphs only when you can recall them confidently.

(R4) Language: ENGLISH (this is Delhi HC). Technical legal phrases in their proper form ("most respectfully showeth", "this Hon'ble Court", "in the interest of justice"). No Hindi script. No Hinglish narrative.

(R5) Tone: formal, advocate-style, third-person. Refer to the Counter-Claimant in the third person ("the Counter-Claimant", "the Applicant"), not "I" or "we".

(R6) Paragraph numbering: continue the numbering from where the template left off (the template's preamble used paras 1-6 across sections I-IV; chronology should be para 2, nature paras 3-4, statutory framework paras 5-6, grounds paras 7-12, authorities paras 13-15, reply paras 16-18). Use **bold** for paragraph numbers.

(R7) For "counter-claimant" / "non-counter-claimant" use the actual extracted full names + addresses from the case data. Same for case number, counter-claim number, counsel name.

(R8) The "purpose of amendment" must be the ACTUAL purpose evident from the case data — Sodhani's amendment seeks to add post-2017 facts re: fraud discovery, coercion in 2011 settlement, and to strengthen the prayer. Do NOT invent.

(R9) The "reply to objections" must address the SPECIFIC objections raised by Indoo Seth — limitation, res judicata, malafide / belated amendment. If the data doesn't mention an objection explicitly, address the anticipated objections.

(R10) The "prayer" must specifically pray for the application to be ALLOWED and for the proposed amendments to be taken on record, plus costs as the court deems fit.

──────────────── CASE DATA DUMP ────────────────
${dump.slice(0, 280000)}

──────────────── TEMPLATE ────────────────
${template}

──────────────── OUTPUT ────────────────
Return strict JSON with EACH placeholder filled. Keys must be exactly:
  case_number, plaintiff_full_block, defendant_full_block, counter_claim_no,
  counter_claimant_block, non_counter_claimant_block, purpose_of_amendment,
  chronology_paragraphs, nature_of_amendment_paragraphs, grounds_paragraphs,
  authorities_paragraphs, reply_to_objections_paragraphs, prayer_clauses,
  date_of_filing, counsel_block

Each value is the FILLED text (markdown, multi-paragraph where appropriate). The {{}} braces will be replaced by your values.

Output ONLY this JSON object. No prose outside.`;
}

function applyFill(template, fill) {
  let out = template;
  for (const [k, v] of Object.entries(fill || {})) {
    const placeholder = new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'g');
    out = out.replace(placeholder, String(v ?? ''));
  }
  out = out.replace(/\{\{[^}]+\}\}/g, '[MISSING — please supply]');
  return out;
}

// ─── Mandatory citation verifier ─────────────────────────────────
// Extracts every case citation from the draft (looking for the pattern
// "Name v. Other Name, (Year) X SCC Y" / "AIR Year SC Z" / etc.),
// hits IKAPI search to verify each, returns a summary of which are
// confirmed / suspicious / not found. Suspicious citations BLOCK
// delivery — the draft is returned with [VERIFY] tags inserted.
const CITATION_PATTERNS = [
  // "Name v. Name, (YYYY) X SCC Y"
  /\*?\*?([A-Z][A-Za-z.&'\-\s]{2,60}?\sv\.\s[A-Z][A-Za-z.&'\-\s]{2,80}?),?\s*\(?(\d{4})\)?\s*(?:[A-Z]+\s+)?([0-9A-Z]+)\s*(SCC|AIR|SCR)\s*([0-9A-Z]+)/g,
  // "AIR YYYY SC ZZZ — Name v. Name"
  /AIR\s*(\d{4})\s*SC\s*\d+\s*[\-—]?\s*([A-Z][A-Za-z.\s]+?\sv\.\s[A-Z][A-Za-z.\s]+)/g
];

// Citation extractor — single combined regex.
//
// Matches: <CaseName> v. <CaseName>, (YYYY) X SCC Y
//       or <CaseName> v. <CaseName>, AIR YYYY SC Z
// where case-name parts are: capitalized words optionally chained
// with allowed connectives (&, of, the, and, Ors., Anr., Ltd, etc.).
// Period inside "v." doesn't break the match because the regex
// captures it explicitly. Sentence-prose like "The test of..." can't
// match because case-name parts must START with capital letters.
function extractCitations(markdown) {
  const out = [];
  const seen = new Set();

  const PART = '[A-Z][A-Za-z.&\'\\-]{1,40}';
  const CONN = '(?:' + PART + '|&|of|the|and|in|Ors\\.?|Anr\\.?|Ltd\\.?|Pvt\\.?|Co\\.?|Corp\\.?|Inc\\.?|Bank|State|Union|Govt|Govt\\.|Through|LR\\.?|Sons)';
  const NAME = PART + '(?:\\s+' + CONN + '){0,8}';
  const CASE = NAME + '\\s+v\\.?s?\\.?\\s+' + NAME;

  // (YYYY) X SCC Y
  const sccRe = new RegExp(
    '\\*?\\*?(' + CASE + ')\\*?\\*?\\s*,?\\s*\\((\\d{4})\\)\\s*\\d+\\s+(?:SCC(?:\\s+OnLine)?|SCR|SCALE)\\s+\\d+',
    'g'
  );
  // AIR YYYY SC Z
  const airRe = new RegExp(
    '\\*?\\*?(' + CASE + ')\\*?\\*?\\s*,?\\s+AIR\\s+(\\d{4})\\s+SC\\s+\\d+',
    'g'
  );

  function harvest(re) {
    let m;
    while ((m = re.exec(markdown)) !== null) {
      let name = m[1].trim().replace(/\s+/g, ' ').replace(/^[*\s,]+|[*\s,]+$/g, '');
      const year = m[2];
      if (name.length < 8 || name.length > 220) continue;
      // Reject when "v." actually means "verses-in-text" — e.g. "is v."
      // or a name starting with a connector word.
      if (/^(The|A|An|This|That|These|Those|However|Moreover|Further|Reliance|Even|While|Further|It|As)\s/i.test(name)) continue;
      if (/\s(is|are|was|were|has|have|been|will|would|shall|relies|relied|placed)\s/i.test(name)) continue;
      const key = name.toLowerCase() + '|' + year;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, year, raw_match: m[0].slice(0, 200) });
    }
  }
  harvest(sccRe);
  harvest(airRe);
  return out;
}

async function ikapiSearch(query, doctype = 'supremecourt', max = 5) {
  try {
    const r = await fetch(IKAPI_MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: {
          name: 'search_cases',
          arguments: { query, doctype, max_results: max }
        }
      })
    });
    const j = await r.json();
    const text = j.result?.content?.[0]?.text || '';
    const payload = JSON.parse(text);
    return payload.results || [];
  } catch (e) {
    return [];
  }
}

// Cleaned tokens for matching: drop honorifics + connectives.
const NOISE_TOKENS = new Set([
  'mr', 'ms', 'mrs', 'smt', 'sh', 'shri', 'hon', 'honble', "hon'ble",
  'justice', 'mr.', 'ms.', 'shri.', 'dr', 'late', 'ltd', 'ltd.',
  'pvt', 'pvt.', 'co', 'co.', 'company', 'corp', 'corporation',
  'union', 'state', 'and', 'ors', 'ors.', 'another', 'anr', 'anr.',
  'v', 'v.', 'vs', 'vs.', 'versus', 'the', 'of', '&', 'm/s',
  'a', 'an'
]);

function distinctiveTokens(name) {
  // Split on "v.", "vs", "versus" — keep both sides
  const sides = String(name)
    .toLowerCase()
    .replace(/[(){}[\]"]/g, '')
    .split(/\s+v\.?\s+|\s+vs\.?\s+|\s+versus\s+/);
  const tokens = new Set();
  for (const side of sides) {
    for (const w of side.split(/[\s,.&\-']+/)) {
      const clean = w.replace(/[^a-z]/g, '');
      if (clean.length < 3) continue;
      if (NOISE_TOKENS.has(clean)) continue;
      tokens.add(clean);
    }
  }
  return [...tokens];
}

// Try multiple search variants — full → distinctive tokens → smaller subset.
async function verifyOneCitation(c) {
  const tokens = distinctiveTokens(c.name);
  if (!tokens.length) return { ...c, verified: false, matched_title: null, attempts: 0 };

  const variants = [
    `${c.name} ${c.year}`,                  // full + year
    `${c.name}`,                            // full
    `${tokens.join(' ')} ${c.year}`,        // distinctive tokens
    `${tokens.slice(0, 3).join(' ')}`,      // first 3 distinctive tokens
    `${tokens.slice(0, 2).join(' ')}`       // first 2 distinctive tokens
  ];

  const yearNum = parseInt(c.year, 10);

  for (const q of variants) {
    // Try SC first (most citations are SC), then fall back to HC
    for (const dt of ['supremecourt', 'judgments']) {
      const hits = await ikapiSearch(q, dt, 6);
      for (const h of hits) {
        const t = String(h.title || '').toLowerCase();
        // Match if BOTH distinctive tokens (or at least the 2 longest)
        // appear in the title.
        const longestTwo = tokens.sort((a, b) => b.length - a.length).slice(0, 2);
        if (longestTwo.length === 2
            && t.includes(longestTwo[0]) && t.includes(longestTwo[1])) {
          // Year fuzzing ±2 (Indian Kanoon date ≈ judgment year)
          if (yearNum && h.date) {
            const hYear = parseInt(String(h.date).slice(0, 4), 10);
            if (hYear && Math.abs(hYear - yearNum) > 2) continue;
          }
          return {
            ...c, verified: true,
            matched_title: h.title,
            matched_tid: h.tid,
            matched_via: q
          };
        }
      }
    }
  }
  return { ...c, verified: false, matched_title: null };
}

async function verifyCitations(markdown) {
  const cites = extractCitations(markdown);
  // Concurrency 3 to not hammer IKAPI
  const results = [];
  let i = 0;
  async function worker() {
    while (i < cites.length) {
      const c = cites[i++];
      results.push(await verifyOneCitation(c));
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  // Preserve original order
  return cites.map(c => results.find(r => r.name === c.name && r.year === c.year) || c);
}

function annotateUnverified(markdown, verifications) {
  let out = markdown;
  for (const v of verifications) {
    if (v.verified) continue;
    // Append [VERIFY] tag after every occurrence of the case name
    const safe = v.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(safe, 'g'), `${v.name} **[VERIFY: not found in IKAPI search]**`);
  }
  return out;
}

// ─── Improvise pass ─────────────────────────────────────────────
// DeepSeek refines the already-filled draft. Mandate: only sharpen,
// fix typos, fill missing-data slots, deepen reasoning. MUST keep
// the cause-title block, verbatim statute quote, and prayer formula
// untouched.
function buildImprovisePrompt(draftMarkdown, dump, courtInfo) {
  return `You are a senior Indian advocate doing a SECOND-PASS polish of a written-arguments draft. The draft is already structurally sound — your job is ONLY to sharpen and tighten it.

STRICT RULES:

(I1) DO NOT alter the cause-title block — it has been finalized by a separate court-identification agent.
(I2) DO NOT alter the verbatim quote of Order VI Rule 17 in Section IV — it must stay literally as is.
(I3) DO NOT alter the section headings, section numbers, or paragraph numbering.
(I4) DO NOT add NEW case citations. You may keep, drop, or reorder existing ones, but never introduce a citation that is not already in the draft.
(I5) DO NOT introduce new facts. Every fact must already trace back to the case-data dump below.
(I6) Fix typos and grammar (e.g., "to to" duplications, awkward phrasing).
(I7) Fill placeholder dates if you can confidently infer them from the case data (e.g., the actual filing/hearing date if mentioned in the dump). If not, leave as-is.
(I8) DEEPEN the Grounds section (paras 7-12) — make each ground specific to THIS case's facts (Sodhani's 03.12.2017 discovery, the 2011 settlement coercion allegations), not generic OVR17 boilerplate.
(I9) For each judicial authority listed in Section VI, add a brief one-line HOLDING/RATIO if you are confident. Format: "Case Name, citation — *holding*: ...". Do NOT invent holdings; if unsure, leave the bare citation.
(I10) Reply-to-Objections (paras 16-18) — keep the three objections (limitation / res judicata / malafide) but tighten the reply with sharper, more specific framing tied to this case's record.
(I11) Preserve every "[seg N pp X-Y]" provenance tag exactly. Add more if obvious from the dump.
(I12) Length: total output should be within ±20% of the input length. No dramatic rewrites.
(I13) **PRESERVE EVERY EXISTING CASE CITATION.** Every case-law citation that appears in the input draft (e.g. "Revajeetu Builders v. Narayanaswamy & Sons, (2009) 10 SCC 84") MUST appear in the output too. You may move a citation between paragraphs, rephrase the surrounding prose, or attach a holding — but you must NOT delete or merge-away any citation. Output must contain the same set of case citations as input (count and identity preserved).
(I14) **PRESERVE EVERY "[VERIFY: not found in IKAPI search]" annotation.** These are emitted by a verifier agent and must remain attached to the unverified citations.

──────────────── COURT INFO ────────────────
${JSON.stringify(courtInfo, null, 2)}

──────────────── CASE DATA DUMP (truth source) ────────────────
${dump.slice(0, 240000)}

──────────────── DRAFT TO POLISH ────────────────
${draftMarkdown}

──────────────── OUTPUT ────────────────
Return strict JSON: { "polished_markdown": "<full polished markdown>" }. No prose outside.`;
}

async function improviseDraft({ draftMarkdown, dump, courtInfo }) {
  const r = await dsLong(
    [{ role: 'user', content: buildImprovisePrompt(draftMarkdown, dump, courtInfo) }],
    { label: 'improvise', max_tokens: 8192 }
  );
  if (r?.hops > 1) console.log(`[draftExp:improvise] stitched ${r.hops} hops`);
  return r?.parsed?.polished_markdown || draftMarkdown;
}

// ─── Layer 3: Judgment-Quote Fetcher ─────────────────────────────
// For each verified citation, fetch the full judgment text from IKAPI
// and use Reasoner to pull the 1-2 most relevant paragraphs given the
// draft's argument context. Returns a map { caseName → quoteBlock }
// that the humanizer uses to insert verbatim quotes in the prose.
//
// This is THE biggest quality jump per rupee — a senior advocate's
// draft is recognizable by its verbatim quotations from landmark
// judgments.

async function ikapiCall(method, args) {
  try {
    const r = await fetch(IKAPI_MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: Date.now(), method: 'tools/call',
        params: { name: method, arguments: args }
      })
    });
    const j = await r.json();
    const text = j.result?.content?.[0]?.text || '';
    try { return JSON.parse(text); } catch { return { text }; }
  } catch (e) {
    console.warn(`[ikapi] ${method} failed: ${e.message}`);
    return null;
  }
}

// Pull the most relevant paragraph(s) from a judgment, given the
// context (what we're arguing for).
async function pickRelevantParagraph({ caseName, citation, fullText, argumentContext }) {
  const prompt = `You are a legal research assistant. Given the FULL TEXT of an Indian Supreme Court / High Court judgment and the ARGUMENT CONTEXT that an advocate is making in a current matter, identify the ONE OR TWO most relevant paragraphs of the judgment that the advocate should quote verbatim.

STRICT RULES:
(P1) Return verbatim text from the judgment. Do not paraphrase.
(P2) Each quote should be 2-6 sentences. Not whole pages.
(P3) Prefer paragraphs that contain the operative ratio / holding, not narrative facts.
(P4) Include the para number if visible in the source (e.g. "Para 12:" or "12.").
(P5) If multiple paras are equally relevant, pick the one closer to the ratio.
(P6) If no clearly relevant para exists, return { "quote": null, "reason": "<one line why>" }.

CASE: ${caseName}, ${citation}

ARGUMENT CONTEXT (what the advocate is arguing):
${argumentContext}

JUDGMENT FULL TEXT (truncated to first 80K chars):
${(fullText || '').slice(0, 80000)}

Return JSON:
{
  "quote": "<verbatim paragraph(s) from judgment, with para number prefix if available>",
  "para_number": "<para number e.g. '12' or null>",
  "rationale": "<one sentence why this para>"
}`;

  const r = await dsRaw([{ role: 'user', content: prompt }], {
    label: `quote:${caseName.slice(0, 30)}`,
    model: MODEL_FLASH, max_tokens: 2048, json: true
  });
  return r?.parsed || null;
}

async function judgmentQuoteFetcher({ verifiedCitations, argumentContext }) {
  const quotes = {};
  // Concurrency 2 — be polite to IKAPI
  const queue = [...verifiedCitations];
  async function worker() {
    while (queue.length) {
      const c = queue.shift();
      if (!c?.matched_tid) continue;
      const doc = await ikapiCall('get_case_document', { tid: c.matched_tid });
      const fullText = doc?.text || doc?.body || doc?.content || JSON.stringify(doc || {}).slice(0, 100000);
      if (!fullText || fullText.length < 500) continue;
      const picked = await pickRelevantParagraph({
        caseName: c.name,
        citation: `(${c.year})`,
        fullText,
        argumentContext
      });
      if (picked?.quote) {
        quotes[c.name] = {
          quote: picked.quote,
          para_number: picked.para_number,
          rationale: picked.rationale
        };
      }
    }
  }
  await Promise.all([worker(), worker()]);
  return quotes;
}

// ─── Layer 4: N-best Fill + Judge ────────────────────────────────
// Generate 3 candidate fills at temperatures 0 / 0.3 / 0.5, then a
// judge call picks the best one. Diversity at the foundation layer
// catches Flash's stochasticity.
async function nBestFill({ prompt, n = 3 }) {
  const temps = [0, 0.3, 0.5].slice(0, n);
  const candidates = await Promise.all(
    temps.map((t, i) => dsLong(
      [{ role: 'user', content: prompt }],
      { label: `fill:t${t}`, max_tokens: 8192, model: MODEL_FLASH, temperature: t }
    ).then(r => ({ idx: i, temp: t, fill: r?.parsed, hops: r?.hops })))
  );
  return candidates;
}

async function pickBestFill({ candidates, dump }) {
  // Stringify each candidate's fill content for comparison
  const items = candidates.map((c, i) => {
    const safe = c.fill || {};
    return `=== CANDIDATE ${i} (temp=${c.temp}) ===\n` +
      `chronology_paragraphs: ${(safe.chronology_paragraphs || '').slice(0, 1500)}\n` +
      `grounds_paragraphs: ${(safe.grounds_paragraphs || '').slice(0, 1500)}\n` +
      `authorities_paragraphs: ${(safe.authorities_paragraphs || '').slice(0, 1500)}\n` +
      `reply_to_objections_paragraphs: ${(safe.reply_to_objections_paragraphs || '').slice(0, 1500)}`;
  }).join('\n\n');

  const prompt = `You are a senior advocate judging 3 candidate first-cuts of a Written Arguments draft. Pick the BEST candidate based on:
  • Factual accuracy (no dates/amounts contradicting source)
  • Number and quality of judicial authorities cited
  • Argument depth in Grounds section
  • Specificity of Reply to Objections

CANDIDATES:
${items}

SOURCE FACTS (truncated):
${(dump || '').slice(0, 40000)}

Return JSON: { "best_idx": <0|1|2>, "reason": "<one sentence>" }`;

  const r = await dsRaw([{ role: 'user', content: prompt }], {
    label: 'fillJudge', max_tokens: 1024, model: MODEL_FLASH
  });
  const idx = Math.max(0, Math.min(candidates.length - 1, r?.parsed?.best_idx ?? 0));
  return { idx, reason: r?.parsed?.reason || '', best: candidates[idx]?.fill };
}

// ─── Layer 5: Senior Critique agent ──────────────────────────────
// Reads the polished+humanized draft. Returns critique POINTS (not
// spot-fixes) that the next humanize round must address. This is a
// strategic critique — argument gaps, missed angles, weak rhetoric,
// not typos.
async function seniorCritique({ draftMarkdown, dump, courtInfo, legalIssues }) {
  const issuesText = (legalIssues?.issues || []).slice(0, 10)
    .map(i => `• [${i.category}] ${i.name}: ${(i.factual_basis || '').slice(0, 150)}`)
    .join('\n');

  const prompt = `You are a SENIOR ADVOCATE (Sr. Counsel, 35+ years) reading a junior's Written Arguments draft. Give CRITIQUE POINTS — strategic, advocacy-level feedback. NOT typo-fixes. NOT structural notes. ONLY substance:
  • Argument gaps (an angle that should have been pressed)
  • Weak rhetoric (a paragraph that doesn't persuade)
  • Missed precedent application (a verified citation that's named but not USED)
  • Theory of the case (is the through-line clear?)
  • Anticipated bench questions (would Hon'ble Judge ask "but what about X?")
  • Reply-to-objections gaps (objection X was raised but not properly answered)
  • Tone calibration (too aggressive / too apologetic in places)

NOT in scope:
  • Typos, grammar, punctuation
  • Section headings, paragraph numbering
  • Internal AI tags (handled elsewhere)
  • Cause-title, statute quote, signature block

Return JSON:
{
  "critique_points": [
    { "category": "<argument_gap|weak_rhetoric|missed_precedent|theory|bench_question|reply_gap|tone>",
      "where": "<paragraph number or section name>",
      "issue": "<what's wrong>",
      "suggestion": "<concrete fix the next round should make>" }
  ],
  "must_address_in_round_2": ["<top-3 highest-impact items, in priority order>"],
  "overall_grade": "<A|B|C|D — A = filing-ready, C = needs another round>",
  "summary": "<one-paragraph senior counsel verdict>"
}

──────────────── COURT ────────────────
${JSON.stringify(courtInfo || {}, null, 2)}

──────────────── LEGAL ISSUES IDENTIFIED ────────────────
${issuesText}

──────────────── SOURCE FACTS (truth) ────────────────
${(dump || '').slice(0, 120000)}

──────────────── DRAFT TO CRITIQUE ────────────────
${draftMarkdown}`;

  const r = await dsLong([{ role: 'user', content: prompt }], {
    label: 'seniorCritique', max_tokens: 8192, model: MODEL_REASONER
  });
  return r?.parsed || { critique_points: [], must_address_in_round_2: [], overall_grade: 'C', summary: '' };
}

// ─── Layer 6: Deterministic Timeline Guard ───────────────────────
// Snapshot every factual atom (date, money amount, case number,
// party-name+address) from the v6 draft. After humanize, diff:
// any atom that was in v6 but not in the polished draft is flagged
// as "potentially dropped". If safe (only one occurrence pattern),
// auto-restore via spot-fix. If unsafe, return for human review.
function timelineGuardSnapshot(md) {
  const facts = {
    dates: new Set(),
    amounts: new Set(),
    case_numbers: new Set(),
    sections: new Set()
  };
  // DD.MM.YYYY or DD/MM/YYYY
  for (const m of md.matchAll(/\b(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})\b/g)) {
    facts.dates.add(`${m[1].padStart(2, '0')}.${m[2].padStart(2, '0')}.${m[3]}`);
  }
  // Rs. amounts: Rs. 5,00,000 or Rs.5,00,000 or Rs 5,00,000
  for (const m of md.matchAll(/(?:Rs\.?|₹|INR)\s*([\d,]+(?:\.\d+)?)(?:\s*\/-)?/g)) {
    const cleaned = m[1].replace(/,/g, '');
    if (cleaned.length >= 3) facts.amounts.add(cleaned);
  }
  // Case numbers like CS(OS) 1619/2017, OMP(I) 234/2022
  for (const m of md.matchAll(/\b([A-Z]{1,5}(?:\([A-Z]+\))?\s*(?:No\.?\s*)?\d+\s*\/\s*\d{4})\b/g)) {
    facts.case_numbers.add(m[1].replace(/\s+/g, ' ').trim());
  }
  // Statutory sections: Section 11 CPC, Order VI Rule 17
  for (const m of md.matchAll(/(Section\s+\d+[A-Z]?\s*(?:of\s+the\s+)?[A-Z][A-Za-z .,]+|Order\s+[IVX]+\s+Rule\s+\d+|Article\s+\d+[A-Z]?)/g)) {
    facts.sections.add(m[1].trim());
  }
  return {
    dates: [...facts.dates],
    amounts: [...facts.amounts],
    case_numbers: [...facts.case_numbers],
    sections: [...facts.sections]
  };
}

function timelineGuardDiff(before, after) {
  const dropped = {};
  for (const k of Object.keys(before)) {
    const beforeSet = new Set(before[k]);
    const afterSet  = new Set(after[k]);
    const droppedHere = [...beforeSet].filter(x => !afterSet.has(x));
    if (droppedHere.length) dropped[k] = droppedHere;
  }
  return dropped;
}

// ─── Layer 7: Final Court-Readiness QA agent ────────────────────
// Reads the final draft like Hon'ble Mr. Justice would — looks for
// any remaining quality issues a senior counsel would flag before
// filing. Returns spot-fixes for things that can be patched, OR a
// "needs_full_rewrite" verdict if too many issues.
async function readinessQA({ draftMarkdown, dump, courtInfo, legalIssues }) {
  const issuesText = (legalIssues?.issues || []).slice(0, 10)
    .map(i => `• [${i.category}] ${i.name}`)
    .join('\n');

  const prompt = `You are a HON'BLE JUDGE doing a pre-filing readiness review of a Written Arguments draft. Imagine yourself on the bench — would this draft persuade you? Would you ask questions counsel hasn't addressed?

Look for (in order of importance):
  • Persuasion arc — does it build to a compelling conclusion?
  • Bench questions — are there obvious questions the judge would ask that aren't answered?
  • Legal soundness — any submission that's actually wrong on law?
  • Factual gaps — a key fact mentioned but not woven into argument?
  • Citation usage — every cited case actually USED (not just named)?
  • Reply completeness — every anticipated objection answered?
  • Tone — appropriately respectful without being weak?
  • Length / pace — does it sag anywhere?

For each issue, propose EITHER:
  (a) A short spot-fix (find/replace ≤300 chars), OR
  (b) A "needs_revision" note describing what should be added/rewritten in the relevant section

Return JSON:
{
  "verdict": "filing_ready | minor_polish | needs_revision",
  "grade": "A | B | C | D",
  "spot_fixes": [
    { "find": "<unique substring>", "replace": "<corrected>", "reason": "<short>", "severity": "high|medium|low" }
  ],
  "revision_notes": [
    { "section": "<para or section>", "what_to_add": "<concrete>", "why": "<short>" }
  ],
  "bench_questions_unanswered": ["<question 1>", "<question 2>"],
  "summary": "<one paragraph as if from chamber to counsel>"
}

──────────────── COURT INFO ────────────────
${JSON.stringify(courtInfo || {}, null, 2)}

──────────────── LEGAL ISSUES IN THIS MATTER ────────────────
${issuesText}

──────────────── SOURCE FACTS ────────────────
${(dump || '').slice(0, 100000)}

──────────────── DRAFT ────────────────
${draftMarkdown}`;

  const r = await dsLong([{ role: 'user', content: prompt }], {
    label: 'readinessQA', max_tokens: 8192, model: MODEL_REASONER
  });
  return r?.parsed || {
    verdict: 'minor_polish', grade: 'B', spot_fixes: [], revision_notes: [],
    bench_questions_unanswered: [], summary: ''
  };
}

// ─── Humanizer + Authority-Weaver agent ─────────────────────────
// Takes the (already-polished, already-cite-verified) draft and
// rewrites it as if a 35-yr senior advocate had typed it by hand.
// Specifically targets the robotic tells that the improvise pass
// can't fix (Roman-numeral allcaps headings, list-style authorities,
// internal [seg N pp X-Y] tags, repetitive sentence openers).
function buildHumanizePrompt(draftMd, dump, courtInfo, verifiedCitations, judgmentQuotes, critiqueFeedback, round = 1) {
  const quotesBlock = judgmentQuotes && Object.keys(judgmentQuotes).length
    ? Object.entries(judgmentQuotes).map(([name, q]) =>
        `→ ${name}\n   Para ${q.para_number || '?'}:\n   "${(q.quote || '').replace(/\s+/g, ' ').slice(0, 1200)}"\n   (Why this quote: ${q.rationale || '—'})`
      ).join('\n\n')
    : '(no verbatim quotes available — paraphrase the ratio if you know it confidently)';

  const critiqueBlock = critiqueFeedback?.must_address_in_round_2?.length
    ? `\n\n──────────────── SENIOR-COUNSEL CRITIQUE FROM ROUND 1 (MUST ADDRESS) ────────────────\n`
      + critiqueFeedback.must_address_in_round_2.map((c, i) => `${i + 1}. ${c}`).join('\n')
      + `\n\nFull critique points:\n`
      + (critiqueFeedback.critique_points || []).slice(0, 10).map(c =>
          `• [${c.category}] @ ${c.where}: ${c.issue}\n    → ${c.suggestion}`
        ).join('\n')
    : '';

  return `You are a SENIOR ADVOCATE (35+ years at the Delhi Bar, regularly appearing before the Supreme Court and Delhi High Court) doing a ${round === 1 ? 'FINAL HAND-REWRITE' : 'ROUND-' + round + ' REVISION'} of a Written Arguments draft. The current draft is structurally sound but reads AI-generated. Your job: make it indistinguishable from a hand-crafted submission by a top-of-the-bar senior counsel — every word chosen, every sentence carrying advocacy weight.

ABSOLUTE RULES — strict:

(S1) STRIP every "[seg N pp X-Y]" and "[seg N p X]" tag in the body. These are internal AI provenance markers. They MUST NOT appear in the final court-facing draft. Delete them. Re-flow the sentence so it reads naturally without the tag.

(S2) NO ROMAN-NUMERAL ALL-CAPS SECTION HEADINGS. DROP "I. PRELIMINARY", "II. BRIEF CHRONOLOGY OF EVENTS", "III. NATURE OF THE AMENDMENT SOUGHT", "IV. STATUTORY FRAMEWORK", "V. GROUNDS ON WHICH THE AMENDMENT OUGHT TO BE ALLOWED", "VI. JUDICIAL AUTHORITIES RELIED UPON", "VII. REPLY TO OBJECTIONS RAISED BY THE NON-COUNTER-CLAIMANT", "VIII. PRAYER" — these textbook headings instantly betray AI authorship.

In their place use either:
   (a) continuous flow with NO sub-heads at all, OR
   (b) MINIMAL italic sentence-case sub-heads written as "### *Brief facts and chronology*", "### *Nature and scope of the proposed amendment*", "### *Submissions on Order VI Rule 17*", "### *Authorities*", "### *Submissions on limitation*", "### *Submissions on res judicata*", "### *Submissions on delay and bona fides*" — italic, sentence case, ###-prefixed (h3). NO underlines. NO ALL-CAPS.

Exception: keep "**PRAYER**" as bold-only standalone line before the prayer paragraphs (this is universally accepted convention).

(S3) NUMBERING — restart paragraphs to flow continuously 1, 2, 3, ... through the whole body. No duplicate numbers. No section-wise restart.

(S4) CASE-LAW TREATMENT — rigorous upgrade. The current draft's authorities section reads "(a) Case Name, citation — *holding*: <one line>". This is amateur. REPLACE with PROSE BLOCKS. For each VERIFIED case below, write a 4-7 sentence block containing:
   (i) The case-name and citation preserved EXACTLY.
   (ii) **If a VERBATIM QUOTE is provided in the JUDGMENT QUOTES block below, USE IT as a blockquote inside the prose.** Format: "Their Lordships in [Case], speaking at Para [N], observed:\\n\\n> \\"<verbatim quote>\\"". This is what makes the draft senior-counsel-grade.
   (iii) The proposition/ratio in your own words ("Their Lordships held that ...", "The Hon'ble Supreme Court laid down that ...").
   (iv) Application to the present matter ("Applied to the case at hand, ..." / "The principle is squarely attracted because ..." / "This is precisely the situation here, where ...").
Weave the cases together with connective tissue. Refer back to earlier-cited cases when relevant ("As laid down in Revajeetu (supra), ...").

(S5) RHETORIC vocabulary — sprinkle ORGANICALLY (not on every line):
   "It is most respectfully submitted", "It is humbly urged",
   "Reliance is respectfully placed on", "The case is squarely covered by",
   "It is settled law that", "this Hon'ble Court will recall",
   "in the conscience of the Court", "without prejudice to the above",
   "in any event", "even otherwise", "It is further submitted", "It is trite that".

(S6) SENTENCE RHYTHM — vary it deliberately. Mix long advocacy sentences with short punchy ones. A 1-line punchline paragraph ("No prejudice whatever arises to the Non-Counter-Claimant.") is allowed and effective. Do NOT start every paragraph with "The".

(S7) PRESERVE EVERY FACT — dates (13.11.2002, 20.03.2011, 03.12.2017, 01.08.2018, 18.09.2019, 13.12.2022, 18.03.2023, 08.11.2023), amounts (Rs.5,00,000, Rs.95,00,000, Rs.5,000), party names, case numbers (CS(OS) 1619/2017, CS(OS) 862/2004), every case-citation. NEVER invent. NEVER drop.

(S8) PRESERVE the verbatim Order VI Rule 17 quote inside the blockquote — exact text. The blockquote must remain.

(S9) **DROP every internal AI annotation.** Any "[VERIFY: not found in IKAPI search]", "[UNVERIFIED]", or "[seg N pp X-Y]" tag must NOT appear in your output. If a citation is followed by "[VERIFY: ...]" in the input, REMOVE the entire citation from the draft — do NOT cite a case that hasn't been verified. The court-facing draft must contain only verified case-law.

(S9a) For the Authorities section: use ONLY the citations listed in the "VERIFIED CITATIONS" block below. Any case citation present in the input draft but NOT in the verified list MUST be omitted from your output entirely.

(S10) PRESERVE the cause-title block (everything before the first horizontal rule "---") AND the signature block (everything after the last "---") EXACTLY, character-for-character. Do not touch them.

(S11) DROP the "principles emerging are: (i)...(ii)...(iii)..." synthesis paragraph entirely. Senior counsel does NOT summarise a list of principles; the principles emerge from the prose.

(S12) Prayer — tighten to 3 clauses max. Drop redundant "any other order" clause if the AND/OR boilerplate is already present. "Costs" clause should read "with costs" or "with exemplary costs" — not "Award costs in favour of...".

(S13) DROP inline bracketed case-citations at sentence-end like "[Vidyabai v. Padmalatha, (2009) 2 SCC 409]" — weave them into prose instead.

(S14) DROP inline statute footers like "[Order VI Rule 17 CPC]" at paragraph end.

(S15) "MOST RESPECTFULLY SHOWETH:" stays on its own bold line at the start of the body.

(S16) Length envelope: total output between 95% and 140% of input length (case-law expansion will lengthen).

(S17) The "Reply to objections" portion — each objection (limitation / res judicata / delay-and-bona-fides) gets a flowing 2-paragraph response with at least one case-citation woven naturally. Use italic sub-heads if needed (S2 option b).

──────────────── COURT INFO ────────────────
${JSON.stringify(courtInfo, null, 2)}

──────────────── VERIFIED CITATIONS (for confident treatment in S4) ────────────────
${verifiedCitations.map(c => `• ${c.name}, (${c.year}) — IKAPI match: ${c.matched_title || 'n/a'}`).join('\n')}

──────────────── JUDGMENT VERBATIM QUOTES (use these as blockquotes per S4) ────────────────
${quotesBlock}${critiqueBlock}

──────────────── CASE FACTS (source of truth — every fact must trace here) ────────────────
${dump.slice(0, 160000)}

──────────────── CURRENT DRAFT (to humanize + expand) ────────────────
${draftMd}

──────────────── OUTPUT ────────────────
Return strict JSON: { "polished_markdown": "<full polished markdown — Indian Senior Advocate hand-written style>" }. No prose outside JSON.`;
}

async function humanizeDraft({ draftMarkdown, dump, courtInfo, verifiedCitations, judgmentQuotes, critiqueFeedback, round = 1 }) {
  const r = await dsLong(
    [{ role: 'user', content: buildHumanizePrompt(draftMarkdown, dump, courtInfo, verifiedCitations, judgmentQuotes, critiqueFeedback, round) }],
    { label: `humanize:r${round}`, max_tokens: 16384, model: MODEL_REASONER }
  );
  if (r?.hops > 1) console.log(`[draftExp:humanize:r${round}] stitched ${r.hops} hops`);
  return r?.parsed?.polished_markdown || draftMarkdown;
}

// ─── Senior Advocate Red-Team agent ─────────────────────────────
// Reads the humanized draft hunting for REMAINING AI-tells.
// Returns spot-fixes (find/replace) for the existing applier.
function buildRedTeamPrompt(draftMd) {
  return `You are a SENIOR ADVOCATE doing a final red-team review of a Written Arguments draft. Hunt for remaining ROBOTIC / AI-GENERATED tells. Propose SHORT spot-fixes only.

What to flag:
- Tidy bullet/letter lists where flowing prose is expected
- Repetitive sentence openers ("The Counter-Claimant said...", "The Court has...", "The amendment is...")
- Leftover internal AI tags like "[seg N pp X-Y]"
- Uniform paragraph rhythm — flag long stretches with no short sentence
- "*holding*:" annotation style
- Roman-numeral ALL-CAPS headings still present (any "I.", "II.", "III." etc. as section heading)
- Duplicate paragraph numbers
- Statement-of-statute footers like "[Order VI Rule 17 CPC]" at paragraph end
- Inline bracketed case-citations at sentence end like "[Vidyabai..., 2 SCC 409]"
- Wooden phrasing ("The application has been filed before the commencement of trial.") — propose advocacy substitute
- Redundant prayer clauses (e.g. "any other order" alongside AND/OR boilerplate)

DO actively delete (replace with empty string or natural prose):
- ANY "[VERIFY: not found in IKAPI search]", "[UNVERIFIED]", "[seg N pp X-Y]" tag — these are internal AI markers and MUST NOT appear in court-facing PDF.
- An entire case citation if the citation is followed by a [VERIFY...] tag: remove the case-name + citation + tag together. Re-flow the surrounding prose.

NEVER touch (out of scope):
- Cause-title block at top
- The blockquote containing the verbatim Order VI Rule 17 statute
- Verified case-citation strings (case name + reporter year + cite number)
- Signature block at the end
- The literal text inside any blockquote

Return STRICT JSON:
{
  "fixes": [
    { "find": "<exact unique substring in draft, ≤250 chars>",
      "replace": "<polished replacement, ≤300 chars>",
      "reason": "<short reason>",
      "severity": "high|medium|low" }
  ],
  "summary": "<one-sentence overall verdict>"
}

Each "find" MUST be a UNIQUE substring in the draft. If a pattern repeats, propose one fix per occurrence using surrounding context to make each find unique. If you are not 100% sure a "find" is unique, skip it.

DRAFT TO RED-TEAM:
${draftMd}`;
}

async function seniorRedTeam({ draftMarkdown }) {
  const r = await dsRaw(
    [{ role: 'user', content: buildRedTeamPrompt(draftMarkdown) }],
    { label: 'redTeam', model: MODEL_REASONER, max_tokens: 8192 }
  );
  const out = r?.parsed || {};
  return {
    fixes: Array.isArray(out?.fixes) ? out.fixes : [],
    summary: out?.summary || ''
  };
}

// ─── Hallucination check agent ──────────────────────────────────
// Reads the polished draft alongside the source segments. Returns
// an array of SPOT FIXES — each is a short {find, replace, reason}
// triple. The applier does deterministic find-and-replace, never
// rewrites paragraphs.
//
// Examples of fixes the agent should catch:
//   - Date mismatched against segments
//   - Party name or address miswritten
//   - Amount / case-number typo
//   - "[VERIFY: ...]" annotation that should remain (no change)
//   - Statement of law that contradicts the named precedent
//
// The agent is told NEVER to suggest a fix longer than ~250 chars
// and NEVER to rewrite full paragraphs.
function buildHallucinationCheckPrompt(draftMarkdown, dump, citationAudit) {
  return `You are a HALLUCINATION CHECK auditor for an Indian court-filing draft. Your only job is to spot FACTUAL ERRORS by cross-checking the draft against the source data, and propose SMALL, SURGICAL fixes.

STRICT RULES:

(H1) For every CONCRETE FACT in the draft (dates, amounts, party names, addresses, case numbers, statutory section numbers, citation years), verify it against the source-data dump. If you cannot find support for it, flag it.
(H2) Each fix must be a SHORT find/replace pair. The "find" string must be a UNIQUE substring of the draft that you want to correct. The "replace" string is the corrected text. Never propose a fix that rewrites more than 250 characters.
(H3) NEVER propose stylistic or rhetorical changes. Only factual corrections.
(H4) Internal AI annotations like "[VERIFY: not found in IKAPI search]", "[UNVERIFIED]", "[seg N pp X-Y]" — these are NEVER allowed in a court-facing draft. If you spot ANY such residue, propose a fix to DELETE it cleanly (replace with empty string, re-flowing the sentence if needed).
(H5) If a fact is correct, do NOT propose any fix for it.
(H6) If a fact cannot be verified from the source dump, DO NOT append "[UNVERIFIED]" or any other tag — those would leak into the final PDF. Instead, propose deleting the unsourced sentence/clause OR replacing the unsupported part with text that IS supported. Never leave an internal annotation in the output.
(H7) Severity ladder: "critical" (wrong fact contradicting source) > "high" (likely wrong) > "unsure" (cannot verify).
(H8) IGNORE the cause-title block, the verbatim Order VI Rule 17 quote, and the prayer formula — those are template-locked.
(H9) **CASE-LAW CITATIONS ARE ENTIRELY OUT OF SCOPE.** Do not propose ANY fix that touches a case-citation string (case name + "v." + other name + reporter citation). Those are handled by a separate citation-verifier agent. Examples you must NOT touch: "Revajeetu Builders v. Narayanaswamy & Sons, (2009) 10 SCC 84", "AIR 1957 SC 357", "[VERIFY: not found in IKAPI search]".
(H10) HOLDINGS attributed to a case ("the Court held that ...") are also out of scope — leave them alone.
(H11) Statutory section numbers / provision numbers (e.g. "Order VI Rule 17", "Section 151 CPC", "Section 11 CPC", "Article 58 of the Limitation Act") are out of scope unless they directly contradict the source dump.
(H12) Return EMPTY array if the draft has no factual issues — that is a valid output.

WHAT TO ACTUALLY CHECK (the in-scope universe):
  • Concrete dates from the case timeline (e.g. "13.11.2002", "20.03.2011", "03.12.2017", "01.08.2018", "18.03.2023") — confirm each is present in the source dump.
  • Money amounts (e.g. "Rs. 5,00,000", "Rs. 95,00,000").
  • Party names + addresses + relationships ("W/o Late Sh. O.P. Malhotra", "S/o Late Sh. Madan Lal Sodhani").
  • Case numbers ("CS(OS) 1619/2017", "CS(OS) 862/2004", "Counter-Claim No. 01/2018").
  • Counsel names.
  • Document references with "[seg N pp X-Y]" — confirm the pages and content match the dump (but do NOT touch them if matching).

──────────────── CITATION AUDIT (already done by verifier) ────────────────
${JSON.stringify(citationAudit, null, 2).slice(0, 6000)}

──────────────── SOURCE DATA DUMP (truth) ────────────────
${dump.slice(0, 240000)}

──────────────── DRAFT TO AUDIT ────────────────
${draftMarkdown}

──────────────── OUTPUT ────────────────
Return strict JSON:
{
  "fixes": [
    { "find": "<exact substring in draft>", "replace": "<corrected text>", "reason": "<one sentence>", "severity": "critical|high|unsure" }
  ],
  "summary": "<one-sentence overall audit verdict>"
}
No prose outside the JSON.`;
}

async function hallucinationCheck({ draftMarkdown, dump, citationAudit }) {
  const r = await dsRaw(
    [{ role: 'user', content: buildHallucinationCheckPrompt(draftMarkdown, dump, citationAudit) }],
    { label: 'halluCheck', model: MODEL_REASONER, max_tokens: 8192 }
  );
  const out = r?.parsed || {};
  return {
    fixes: Array.isArray(out?.fixes) ? out.fixes : [],
    summary: out?.summary || ''
  };
}

// ─── Completeness checker agent ────────────────────────────────
// After all polish/audit passes are done, this agent reads the
// final markdown and verifies STRUCTURAL integrity. It catches:
//   • Truncated paragraphs ("..." or sentence trailing off)
//   • Missing sections (no facts / no grounds / no authorities / no prayer)
//   • Cause title or signature block dropped accidentally
//   • Sentence count anomalies suggesting cut-off mid-flow
// If anything is missing, returns either a list of issues or, when
// possible, a continuation prompt to extend the draft.

// Deterministic structural scan — cheap, runs first.
function structuralScan(md) {
  const issues = [];
  const lower = md.toLowerCase();

  // Cause-title block
  if (!/in the (court|hon'ble) /i.test(md)) {
    issues.push({ severity: 'critical', what: 'no_cause_title',
                  hint: 'Cause-title block missing — "IN THE COURT OF ..." not found' });
  }

  // Body opener
  if (!/most respectfully showeth/i.test(md)) {
    issues.push({ severity: 'high', what: 'no_opener',
                  hint: '"MOST RESPECTFULLY SHOWETH" opener missing' });
  }

  // Statutory block (the verbatim quote should be in a blockquote)
  if (!/order vi rule 17/i.test(lower)
      && !/order\s*6\s*rule\s*17/i.test(lower)) {
    issues.push({ severity: 'high', what: 'no_statute_quote',
                  hint: 'Verbatim Order VI Rule 17 quote block missing' });
  }

  // At least one judicial authority cited
  if (!/\(\d{4}\)\s*\d+\s*scc\s*\d+/i.test(md)
      && !/air\s+\d{4}\s+sc\s+\d+/i.test(md)) {
    issues.push({ severity: 'high', what: 'no_authorities',
                  hint: 'No case citations present in final draft' });
  }

  // Prayer
  if (!/\bprayer\b/i.test(md)) {
    issues.push({ severity: 'critical', what: 'no_prayer',
                  hint: 'Prayer section missing' });
  }

  // Signature block — Place/Dated/Counsel
  if (!/(place\s*:|dated\s*:|counsel for)/i.test(md)) {
    issues.push({ severity: 'high', what: 'no_signature',
                  hint: 'Signature block (Place/Dated/Counsel) missing' });
  }

  // Truncation tell-tales
  // Last non-empty line should end with proper punctuation (.,!?)" or a markdown rule
  const lines = md.trimEnd().split('\n').filter(l => l.trim().length > 0);
  const last = lines[lines.length - 1] || '';
  const lastClean = last.replace(/[*_\s]+$/, '');
  if (!/[.!?\"”\)\]]$/.test(lastClean) && !/^---+$/.test(last)) {
    issues.push({ severity: 'critical', what: 'truncated_tail',
                  hint: `Final line does not end in proper punctuation — possible truncation. Tail: "${last.slice(-120)}"` });
  }

  // Numbering continuity — count "**N.**" or "N. " paragraph numbers
  const nums = [...md.matchAll(/^\s*(?:\*\*)?\s*(\d{1,3})\.\s/gm)]
                .map(m => parseInt(m[1], 10))
                .filter(n => n >= 1 && n <= 200);
  if (nums.length >= 3) {
    // Check for any large gap (>4) in increasing sequence
    const sorted = [...new Set(nums)].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] - sorted[i - 1] > 4) {
        issues.push({ severity: 'medium', what: 'numbering_gap',
                      hint: `Paragraph numbering jumps from ${sorted[i - 1]} to ${sorted[i]} — possible mid-draft drop` });
        break;
      }
    }
  }

  return issues;
}

// Optional LLM-based deep check — runs only if structural scan is
// clean (catches subtler issues like "the argument starts but the
// conclusion never lands").
function buildCompletenessPrompt(md) {
  return `You are a COMPLETENESS auditor for an Indian court-filing draft. Read the draft below and judge whether it is STRUCTURALLY COMPLETE — i.e. would a counsel actually file it as-is, or does it look truncated / missing parts?

Check for:
  • Cause-title at top
  • Body opener "MOST RESPECTFULLY SHOWETH:"
  • Brief facts / chronology
  • Statement of the law (statutory provision quoted)
  • Grounds in support
  • Authorities (case-law cited)
  • Reply to objections (limitation / res judicata / delay)
  • Prayer clauses
  • Signature block (Place / Dated / Counsel name)
  • Each paragraph reaches a natural conclusion (no sentence trails off)
  • Last paragraph does not look cut mid-sentence

Return STRICT JSON:
{
  "complete": true|false,
  "missing": ["<one-line description of each missing/truncated element>"],
  "verdict": "<one-sentence overall>",
  "needs_continuation": true|false,
  "continuation_hint": "<if needs_continuation, a 1-sentence hint of WHAT must be added>"
}

DRAFT:
${md}`;
}

async function completenessCheck(md) {
  // Cheap deterministic pass first
  const structIssues = structuralScan(md);
  const critical = structIssues.filter(i => i.severity === 'critical');

  // If critical structural issue → fail fast, no need for LLM
  if (critical.length) {
    return {
      complete: false,
      structural_issues: structIssues,
      llm_check: null,
      needs_continuation: critical.some(i => i.what === 'truncated_tail'),
      continuation_hint: critical.map(i => i.hint).join(' | ')
    };
  }

  // LLM deep check
  const r = await dsRaw(
    [{ role: 'user', content: buildCompletenessPrompt(md) }],
    { label: 'completeness', json: true, max_tokens: 4096, model: MODEL_REASONER }
  );
  return {
    complete: !!r?.parsed?.complete,
    structural_issues: structIssues,
    llm_check: r?.parsed || null,
    needs_continuation: !!r?.parsed?.needs_continuation,
    continuation_hint: r?.parsed?.continuation_hint || ''
  };
}

// If the completeness check says we need continuation, ask the LLM
// to ONLY produce the missing portion, then append.
async function repairCompleteness({ markdown, hint, dump, courtInfo }) {
  const prompt = `You are completing a partially-written Indian court-filing draft that was cut off by the output-token limit. Your job: write ONLY the missing remainder. Do NOT repeat any text already written.

WHAT IS MISSING (auditor hint): ${hint}

STRICT RULES:
  • Output ONLY the missing portion — no preamble, no recap.
  • Continue the paragraph-numbering sequence already in use.
  • Match the tone, voice, and Senior-Advocate Indian-court style of the prior text.
  • If the prayer is missing → produce a "**PRAYER**" heading followed by 3-4 clauses (a)/(b)/(c)/(d), then the AND/OR boilerplate.
  • If the signature is missing → produce "---" + Place/Dated/Counsel block on the right.
  • If the last paragraph trails off mid-sentence → finish that sentence first, then write any remaining sections.
  • Do NOT include any "[VERIFY]", "[UNVERIFIED]", or "[seg N pp X-Y]" tags.
  • Return strict JSON: { "continuation": "<markdown that should be appended to the partial draft>" }.

COURT INFO:
${JSON.stringify(courtInfo || {}, null, 2)}

CASE FACTS (for grounding):
${(dump || '').slice(0, 120000)}

PARTIAL DRAFT (truncated):
${markdown}

OUTPUT (JSON only):`;
  const r = await dsLong(
    [{ role: 'user', content: prompt }],
    { label: 'repair', max_tokens: 8192 }
  );
  return r?.parsed?.continuation || '';
}

// Deterministic final sanitizer — runs LAST, before PDF render.
// Strips any internal AI markers that may have slipped through:
//   [VERIFY: ...], [UNVERIFIED], [seg N pp X-Y], [seg N p X], [Page N]
// Also collapses any double-spaces and orphan punctuation left behind.
function sanitizeForCourt(markdown) {
  let out = markdown;
  // Remove [VERIFY: ...] annotations and any preceding ** wrapper, including
  // optional space before. Try a few common shapes.
  out = out.replace(/\s*\*\*\[VERIFY:[^\]]*\]\*\*\s*/g, ' ');
  out = out.replace(/\s*\[VERIFY:[^\]]*\]\s*/g, ' ');
  out = out.replace(/\s*\*\*\[UNVERIFIED\]\*\*\s*/g, ' ');
  out = out.replace(/\s*\[UNVERIFIED\]\s*/g, ' ');
  // Internal segment / page provenance tags
  out = out.replace(/\s*\[seg\s*\d+\s*pp?\s*\d+(?:-\d+)?\]\s*/gi, ' ');
  out = out.replace(/\s*\[Page\s*\d+(?:\s*of[^\]]*)?\]\s*/gi, ' ');
  // Tidy up: orphan ", ," / " ," / multi-space / space before punctuation
  out = out.replace(/[ \t]+,/g, ',');
  out = out.replace(/[ \t]+\./g, '.');
  out = out.replace(/,\s*,/g, ',');
  out = out.replace(/  +/g, ' ');
  // Trim spaces at line ends
  out = out.split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n');
  return out;
}

// Deterministic spot-fix applier — finds unique substring and replaces.
// Skips any fix whose "find" is missing or appears more than once
// (ambiguous → unsafe to apply blindly).
function applySpotFixes(markdown, fixes) {
  let out = markdown;
  const applied = [];
  const skipped = [];
  for (const f of fixes || []) {
    if (!f?.find || typeof f.find !== 'string') {
      skipped.push({ ...f, skipped_reason: 'no find string' });
      continue;
    }
    if (f.find === f.replace) {
      skipped.push({ ...f, skipped_reason: 'find==replace' });
      continue;
    }
    if (f.find.length > 250) {
      skipped.push({ ...f, skipped_reason: 'find too long (>250)' });
      continue;
    }
    // Count occurrences
    const idx1 = out.indexOf(f.find);
    if (idx1 === -1) {
      skipped.push({ ...f, skipped_reason: 'find not present in draft' });
      continue;
    }
    const idx2 = out.indexOf(f.find, idx1 + 1);
    if (idx2 !== -1) {
      skipped.push({ ...f, skipped_reason: 'find is ambiguous (multiple matches)' });
      continue;
    }
    out = out.slice(0, idx1) + (f.replace ?? '') + out.slice(idx1 + f.find.length);
    applied.push(f);
  }
  return { markdown: out, applied, skipped };
}

// ─── Public: run experiment with full pipeline ─────────────────
//
//   Step 1 — courtIdentifier  (decide HC vs DC vs Tribunal, fill cause-title)
//   Step 2 — buildCaseDump    (compact data feed for LLM)
//   Step 3 — DeepSeek fill    (placeholders → content with [seg] citations)
//   Step 4 — applyFill        (deterministic substitution)
//   Step 5 — verifyCitations  (MANDATORY — every cited case → IKAPI check)
//   Step 6 — annotateUnverified (any unverified citation → [VERIFY] tag)
//   Step 7 — improviseDraft       (sharpen + fix typos + deepen, NOT rewrite)
//   Step 8 — hallucinationCheck   (factual audit; returns spot-fixes only)
//   Step 9 — applySpotFixes       (deterministic find/replace, no rewrites)
//   Step 10 — verifyCitations re-run on polished+fixed draft
//
async function runExperiment({
  pool, caseId, templateName = 'written_arguments_o6r17',
  // Quality-max pipeline knobs (default = ALL ON)
  improvise          = true,
  halluCheck         = true,
  nBest              = true,   // L4: 3-best fill + judge
  fetchJudgmentQuotes= true,   // L3: verbatim quotes from IKAPI
  multiRound         = true,   // L5: humanize round-2 driven by critique
  timelineGuard      = true,   // L6: deterministic fact preservation guard
  readinessGate      = true    // L7: final court-readiness QA
} = {}) {
  const t0 = Date.now();
  const log = (s) => console.log(`[v8 ${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`);

  const cr = await pool.query(
    `SELECT title, rollup, legal_issues FROM cases WHERE id=$1`, [caseId]
  );
  if (!cr.rows.length) throw new Error('case not found');
  const sr = await pool.query(
    `SELECT segment_index, segment_name, segment_type, page_start, page_end,
            facts, other_atoms
       FROM case_segments WHERE case_id=$1 ORDER BY segment_index ASC`,
    [caseId]
  );
  const legalIssues = cr.rows[0].legal_issues || {};

  log('step 1: courtIdentifier (Reasoner)');
  const courtInfo = await courtIdentifier.identifyCourt({ pool, caseId });
  if (!courtInfo || !courtInfo.cause_title_block) {
    throw new Error('courtIdentifier returned null/empty — cannot proceed without a verified cause-title');
  }

  log('step 2: buildCaseDump');
  const dump = buildCaseDump({
    caseTitle: cr.rows[0].title,
    segments: sr.rows,
    rollup: cr.rows[0].rollup || {},
    legal_issues: legalIssues
  });

  log('step 3: fill ' + (nBest ? '(N-best ×3 + judge)' : '(single shot)'));
  const fillPrompt = buildFillPrompt(dump, WRITTEN_ARG_OVR17_TEMPLATE)
    + `\n\nADDITIONAL — court already identified by a separate agent. Use the supplied cause_title_block VERBATIM; do NOT override.\nCourt info: ${JSON.stringify(courtInfo, null, 2)}`;

  let fill;
  let fillCandidatesMeta = null;
  if (nBest) {
    const candidates = await nBestFill({ prompt: fillPrompt, n: 3 });
    const valid = candidates.filter(c => c.fill);
    if (!valid.length) throw new Error('all N-best fill candidates failed');
    log(`step 3b: pickBestFill (${valid.length}/3 valid candidates)`);
    const judged = await pickBestFill({ candidates: valid, dump });
    fill = judged.best;
    fillCandidatesMeta = { picked_idx: judged.idx, reason: judged.reason,
                           candidate_count: valid.length };
    log(`  → picked candidate ${judged.idx}: ${judged.reason}`);
  } else {
    const fillRes = await dsLong([{ role: 'user', content: fillPrompt }], {
      label: 'fill', max_tokens: 8192
    });
    fill = fillRes?.parsed;
  }
  if (!fill) throw new Error('DeepSeek fill returned nothing');
  fill.cause_title_block = courtInfo.cause_title_block || fill.cause_title_block;

  log('step 4: applyFill (deterministic substitution)');
  let draftMarkdown = applyFill(WRITTEN_ARG_OVR17_TEMPLATE, fill);

  log('step 5: verifyCitations (IKAPI)');
  const verifications = await verifyCitations(draftMarkdown);
  const unverifiedCount = verifications.filter(v => !v.verified).length;
  const verifiedCitations = verifications.filter(v => v.verified);
  log(`  → ${verifiedCitations.length}/${verifications.length} verified`);

  const v6MarkdownAudit = unverifiedCount > 0
    ? annotateUnverified(draftMarkdown, verifications)
    : draftMarkdown;
  const v6Markdown = draftMarkdown;

  // L6 step 6: timeline snapshot of v6 (before any humanizer touches it)
  const timelineBefore = timelineGuard ? timelineGuardSnapshot(v6Markdown) : null;
  if (timelineGuard) {
    log(`step 6: timelineGuardSnapshot — ${timelineBefore.dates.length} dates, ${timelineBefore.amounts.length} amounts, ${timelineBefore.case_numbers.length} case-nos`);
  }

  // L3 step 7: fetch verbatim quotes for each verified case from IKAPI
  let judgmentQuotes = {};
  if (fetchJudgmentQuotes && verifiedCitations.length) {
    log(`step 7: judgmentQuoteFetcher for ${verifiedCitations.length} verified cases`);
    const argumentContext = `Application under Order VI Rule 17 r/w Section 151 CPC for leave to amend a counter-claim. Counter-Claimant seeks to add facts of fraud (discovery on 03.12.2017), coercion in the joint settlement of 20.03.2011, and to strengthen prayer for declaration that the agreements/settlement are void. Trial has not commenced. Reply addresses limitation, res judicata, and delay.`;
    judgmentQuotes = await judgmentQuoteFetcher({
      verifiedCitations,
      argumentContext
    });
    log(`  → ${Object.keys(judgmentQuotes).length} verbatim quotes fetched`);
  }

  log('step 8: improviseDraft (Flash polish)');
  let polishedMarkdown = v6Markdown;
  if (improvise) {
    polishedMarkdown = await improviseDraft({
      draftMarkdown: v6Markdown, dump, courtInfo
    });
  }

  log('step 9: humanize round-1 (Reasoner)');
  let humanizedMarkdown = await humanizeDraft({
    draftMarkdown: polishedMarkdown,
    dump, courtInfo, verifiedCitations,
    judgmentQuotes,
    round: 1
  });

  // L5: senior critique + round-2 humanize
  let critiqueR1 = null;
  if (multiRound) {
    log('step 10: seniorCritique round-1 (Reasoner)');
    critiqueR1 = await seniorCritique({
      draftMarkdown: humanizedMarkdown,
      dump, courtInfo, legalIssues
    });
    log(`  → grade ${critiqueR1.overall_grade}, must-address: ${(critiqueR1.must_address_in_round_2 || []).length} items`);

    if (critiqueR1.overall_grade && /^[CD]$/.test(critiqueR1.overall_grade) ||
        (critiqueR1.must_address_in_round_2 || []).length > 0) {
      log('step 11: humanize round-2 (Reasoner, addressing critique)');
      humanizedMarkdown = await humanizeDraft({
        draftMarkdown: humanizedMarkdown,
        dump, courtInfo, verifiedCitations,
        judgmentQuotes,
        critiqueFeedback: critiqueR1,
        round: 2
      });
    } else {
      log('step 11: humanize round-2 skipped (round-1 already A/B grade)');
    }
  }

  log('step 12: seniorRedTeam style audit (Reasoner)');
  const redTeam = await seniorRedTeam({ draftMarkdown: humanizedMarkdown });
  const redTeamApply = applySpotFixes(humanizedMarkdown, redTeam.fixes);
  humanizedMarkdown = redTeamApply.markdown;
  log(`  → ${redTeamApply.applied.length} fixes applied, ${redTeamApply.skipped.length} skipped`);

  // L6: timeline diff + restore any dropped facts
  let timelineAudit = null;
  if (timelineGuard && timelineBefore) {
    const timelineAfter = timelineGuardSnapshot(humanizedMarkdown);
    const dropped = timelineGuardDiff(timelineBefore, timelineAfter);
    const droppedCount = Object.values(dropped).reduce((n, arr) => n + arr.length, 0);
    timelineAudit = { dropped, droppedCount };
    if (droppedCount) {
      log(`step 13: timelineGuard FLAGGED ${droppedCount} dropped facts: ${JSON.stringify(dropped).slice(0, 200)}`);
    } else {
      log('step 13: timelineGuard clean — all v6 facts preserved');
    }
  }

  log('step 14: hallucinationCheck (Reasoner)');
  let halluAudit = { fixes: [], summary: 'skipped' };
  let appliedFixes = [];
  let skippedFixes = [];
  let finalMarkdown = humanizedMarkdown;
  if (halluCheck) {
    halluAudit = await hallucinationCheck({
      draftMarkdown: humanizedMarkdown,
      dump,
      citationAudit: {
        total: verifications.length,
        verified: verifications.length - unverifiedCount,
        unverified: unverifiedCount,
        details: verifications.map(v => ({
          name: v.name, year: v.year, verified: !!v.verified
        }))
      }
    });
    log(`step 15: applySpotFixes (${halluAudit.fixes?.length || 0} proposed)`);
    const applyResult = applySpotFixes(humanizedMarkdown, halluAudit.fixes);
    finalMarkdown = applyResult.markdown;
    appliedFixes = applyResult.applied;
    skippedFixes = applyResult.skipped;
  }

  // L7: court-readiness QA gate
  let readinessReport = null;
  if (readinessGate) {
    log('step 16: readinessQA (Reasoner — Hon\'ble Mr. Justice lens)');
    readinessReport = await readinessQA({
      draftMarkdown: finalMarkdown,
      dump, courtInfo, legalIssues
    });
    log(`  → verdict: ${readinessReport.verdict}, grade: ${readinessReport.grade}`);

    if (readinessReport.spot_fixes?.length) {
      log(`step 17: apply readiness spot-fixes (${readinessReport.spot_fixes.length})`);
      const readinessApply = applySpotFixes(finalMarkdown, readinessReport.spot_fixes);
      finalMarkdown = readinessApply.markdown;
      readinessReport.applied_fixes = readinessApply.applied;
      readinessReport.skipped_fixes = readinessApply.skipped;
    }
  }

  log('step 18: completenessCheck (Reasoner)');
  let completenessReport = await completenessCheck(finalMarkdown);
  let repairHops = 0;
  while (completenessReport.needs_continuation && repairHops < 2) {
    repairHops++;
    log(`step 18b: repairCompleteness hop ${repairHops} — ${completenessReport.continuation_hint}`);
    const cont = await repairCompleteness({
      markdown: finalMarkdown,
      hint: completenessReport.continuation_hint,
      dump, courtInfo
    });
    if (!cont) break;
    finalMarkdown = finalMarkdown.trimEnd() + '\n\n' + cont.trimStart();
    completenessReport = await completenessCheck(finalMarkdown);
  }

  log('step 19: re-verifyCitations on final');
  const finalVerifications = await verifyCitations(finalMarkdown);
  const finalUnverified = finalVerifications.filter(v => !v.verified).length;

  log('step 20: sanitizeForCourt (deterministic strip)');
  finalMarkdown = sanitizeForCourt(finalMarkdown);

  log(`v8 done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  return {
    court_info: courtInfo,
    fill,
    v6Markdown,
    v6MarkdownAudit,
    polishedMarkdown,
    humanizedMarkdown,
    draftMarkdown: finalMarkdown,
    judgment_quotes: judgmentQuotes,
    fill_candidates_meta: fillCandidatesMeta,
    senior_critique_r1: critiqueR1,
    red_team_audit: {
      summary: redTeam.summary,
      proposed_fixes: redTeam.fixes,
      applied_fixes: redTeamApply.applied,
      skipped_fixes: redTeamApply.skipped
    },
    timeline_audit: timelineAudit,
    hallu_audit: {
      summary: halluAudit.summary,
      proposed_fixes: halluAudit.fixes,
      applied_fixes: appliedFixes,
      skipped_fixes: skippedFixes
    },
    readiness_report: readinessReport,
    citation_audit: {
      total: finalVerifications.length,
      verified: finalVerifications.length - finalUnverified,
      unverified: finalUnverified,
      details: finalVerifications
    },
    completeness: {
      ...completenessReport,
      repair_hops: repairHops
    },
    elapsed_seconds: ((Date.now() - t0) / 1000)
  };
}

// ─── Markdown → HTML → PDF (headless Chrome) ───────────────────
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Lightweight inline-markdown for one line of text (already escaped).
function inlineMd(s) {
  let t = s;
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*([^*]|$)/g, '$1<em>$2</em>$3');
  return t;
}

// Markdown → HTML — tuned for an Indian court filing layout:
//   • Centred CAUSE-TITLE block at the top (everything up to the
//     first standalone "---" rule).
//   • Party blocks with "....Plaintiff" suffix → right-aligned capacity
//     using a flex line ("party-row").
//   • Standalone short ALL-CAPS lines (VERSUS, AND, MOST RESPECTFULLY
//     SHOWETH:) auto-centred.
//   • `# ...` main heading centred, underlined.
//   • `## ...` section headings (I. PRELIMINARY etc.) underlined,
//     spacing matched to court convention.
//   • Counsel signature block (everything after the LAST `---` rule)
//     right-aligned.
function mdToHtml(md) {
  // Find structural rules — first <hr>, last <hr>
  const lines = md.split('\n');

  // 1. Find first standalone "---" line → cause-title block ends there
  let firstHrIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^---+\s*$/.test(lines[i])) { firstHrIdx = i; break; }
  }
  // 2. Find last standalone "---" line → signature block starts after it
  let lastHrIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^---+\s*$/.test(lines[i])) { lastHrIdx = i; break; }
  }
  if (lastHrIdx === firstHrIdx) lastHrIdx = -1;

  const causeLines    = firstHrIdx >= 0 ? lines.slice(0, firstHrIdx) : [];
  const bodyLines     = firstHrIdx >= 0
    ? lines.slice(firstHrIdx + 1, lastHrIdx >= 0 ? lastHrIdx : lines.length)
    : lines.slice();
  const signatureLines = lastHrIdx >= 0 ? lines.slice(lastHrIdx + 1) : [];

  // ── Cause-title block — render each non-empty line centred.
  // Party rows with "...Plaintiff / Respondent..." get split into
  // address (left) + capacity (right) on the same flex row.
  function renderCauseBlock(arr) {
    const out = ['<div class="cause-title-block">'];
    let buf = [];
    function flush() {
      if (!buf.length) return;
      const joined = buf.join('<br/>').trim();
      if (!joined) { buf = []; return; }
      // Detect "name + ... + capacity" form
      const partyMatch = joined.match(/^(.+?)\s*\.{2,}\s*(.+?)\s*$/s);
      if (partyMatch) {
        const left = inlineMd(partyMatch[1].replace(/<br\/>/g, '<br/>').trim());
        const right = inlineMd(partyMatch[2].trim());
        out.push(`<div class="party-row"><div class="party-name">${left}</div><div class="party-cap">${right}</div></div>`);
      } else {
        // Plain centred line
        out.push(`<div class="centre-line">${inlineMd(joined)}</div>`);
      }
      buf = [];
    }
    for (const raw of arr) {
      const ln = raw.replace(/^\s+|\s+$/g, '');
      if (!ln) { flush(); continue; }
      buf.push(escHtml(ln));
    }
    flush();
    out.push('</div>');
    return out.join('\n');
  }

  // ── Body — standard headings + paragraphs + blockquote.
  function renderBody(arr) {
    let html = arr.join('\n');
    html = escHtml(html);

    // Headings (most specific first)
    html = html.replace(/^######\s+(.*)$/gm, (_, t) => `<h6>${inlineMd(t)}</h6>`)
               .replace(/^#####\s+(.*)$/gm,  (_, t) => `<h5>${inlineMd(t)}</h5>`)
               .replace(/^####\s+(.*)$/gm,   (_, t) => `<h4>${inlineMd(t)}</h4>`)
               .replace(/^###\s+(.*)$/gm,    (_, t) => `<h3>${inlineMd(t)}</h3>`)
               .replace(/^##\s+(.*)$/gm,     (_, t) => `<h2>${inlineMd(t)}</h2>`)
               .replace(/^#\s+(.*)$/gm,      (_, t) => `<h1>${inlineMd(t)}</h1>`);

    // Horizontal rule
    html = html.replace(/^---+\s*$/gm, '<hr/>');

    // Blockquotes
    html = html.replace(/(^&gt;\s?.*\n?)+/gm, (block) => {
      const inner = block.replace(/^&gt;\s?/gm, '').trim();
      return `<blockquote>${inlineMd(inner).replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br/>')}</blockquote>\n`;
    });

    // Split blocks
    const blocks = html.split(/\n{2,}/).map(b => {
      const t = b.trim();
      if (!t) return '';
      if (/^<(h\d|blockquote|hr|ul|ol|table|pre)/.test(t)) return t;
      const oneLine = !/\n/.test(t);
      // Standalone short ALL-CAPS line → centred banner
      if (oneLine) {
        const stripped = t.replace(/<[^>]+>/g, '').trim();
        if (stripped.length <= 80
            && /^[A-Z][A-Z0-9 .,:;'’!\-/&()]+$/.test(stripped)) {
          return `<div class="centre-line">${inlineMd(t)}</div>`;
        }
      }
      // Party block also possible in body (counter-claim sub-block)
      const partyMatch = t.match(/^(.+?)\s*\.{2,}\s*(.+?)\s*$/s);
      if (partyMatch && /(Plaintiff|Defendant|Counter-Claimant|Respondent|Petitioner|Applicant|Appellant)/i.test(partyMatch[2])) {
        const left = inlineMd(partyMatch[1].replace(/\n/g, '<br/>').trim());
        const right = inlineMd(partyMatch[2].trim());
        return `<div class="party-row"><div class="party-name">${left}</div><div class="party-cap">${right}</div></div>`;
      }
      return `<p>${inlineMd(t).replace(/\n/g, '<br/>')}</p>`;
    });
    return blocks.filter(Boolean).join('\n');
  }

  // ── Signature block — right-aligned, preserve line breaks
  function renderSignature(arr) {
    const cleaned = arr.map(l => escHtml(l.replace(/^\s+|\s+$/g, '')))
                       .filter(l => l.length > 0)
                       .map(inlineMd);
    if (!cleaned.length) return '';
    return `<div class="signature-block">${cleaned.join('<br/>')}</div>`;
  }

  return [
    renderCauseBlock(causeLines),
    renderBody(bodyLines),
    renderSignature(signatureLines)
  ].filter(Boolean).join('\n');
}

function wrapHtml(bodyHtml, title) {
  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<title>${escHtml(title)}</title>
<style>
  @page { size: A4; margin: 25mm 25mm 25mm 30mm; }
  body { font-family: 'Times New Roman', Georgia, serif; font-size: 12.5pt; line-height: 1.55; color: #000; }

  /* Cause-title block — centred court name, case-no, party list */
  .cause-title-block { text-align: center; margin: 0 0 14pt 0; }
  .cause-title-block .centre-line { margin: 4pt 0; }
  .cause-title-block .centre-line:first-child {
    font-weight: 700; text-decoration: underline;
    text-transform: uppercase; letter-spacing: 0.4pt;
    font-size: 13pt; margin-bottom: 12pt;
  }

  /* Party row — left side flex-grows, capacity stuck to right with leader dots */
  .party-row {
    display: flex; align-items: flex-start;
    margin: 6pt 0; text-align: left; line-height: 1.45;
  }
  .party-name {
    flex: 1 1 auto; text-align: left; padding-right: 8pt;
    position: relative;
  }
  .party-cap {
    flex: 0 0 auto; text-align: right;
    font-style: italic; padding-left: 8pt;
    white-space: nowrap;
  }

  /* Banner-style centred line — VERSUS, AND, MOST RESPECTFULLY SHOWETH: */
  .centre-line {
    text-align: center; margin: 10pt 0;
    font-weight: 700; letter-spacing: 0.6pt;
  }

  /* Body headings — kept minimal for hand-crafted feel */
  h1 {
    font-size: 13.5pt; text-align: center; margin: 18pt 0 14pt;
    text-transform: uppercase; letter-spacing: 0.5pt;
    text-decoration: underline; font-weight: 700;
  }
  /* h2 — for the rare "PRAYER" type centred heading */
  h2 {
    font-size: 12.5pt; margin: 18pt 0 10pt;
    font-weight: 700; text-align: center;
    text-transform: uppercase; letter-spacing: 0.6pt;
  }
  /* h3 — italic sentence-case sub-heads as a senior counsel would handwrite */
  h3 {
    font-size: 12.5pt; margin: 14pt 0 4pt;
    font-style: italic; font-weight: 600;
    text-transform: none; letter-spacing: 0;
  }
  /* The italic em inside h3 should NOT add another italic layer */
  h3 em { font-style: italic; font-weight: 600; }

  p { margin: 0 0 8pt 0; text-align: justify; text-indent: 0; }

  blockquote {
    margin: 8pt 24pt; padding: 4pt 12pt;
    border-left: 3px solid #888; background: #f5f5f5;
    font-style: italic;
  }
  blockquote p { margin: 4pt 0; }

  strong { font-weight: 700; }
  em { font-style: italic; }

  hr { border: none; border-top: 1px solid #888; margin: 14pt 0; }

  /* Signature block — right-aligned */
  .signature-block {
    margin-top: 36pt; text-align: right;
    line-height: 1.5; font-weight: 600;
  }
</style>
</head><body>
${bodyHtml}
</body></html>`;
}

function execAsync(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, { ...opts, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${err.message}\n${stderr}`));
      resolve({ stdout, stderr });
    });
  });
}

// Local-only renderer — uses macOS Chrome.app. Kept for dev runs of
// run-v7-offline.js. Production calls renderPdfViaApi2Pdf instead.
async function renderPdf({ markdown, outPath, title = 'Written Arguments' }) {
  const html = wrapHtml(mdToHtml(markdown), title);
  const tmpHtml = path.join(os.tmpdir(), `draft-${Date.now()}.html`);
  fs.writeFileSync(tmpHtml, html, 'utf8');
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const cmd = `"${chrome}" --headless=new --disable-gpu --no-pdf-header-footer ` +
              `--print-to-pdf-no-header --print-to-pdf="${outPath}" "file://${tmpHtml}"`;
  await execAsync(cmd);
  return outPath;
}

// ─── Production PDF renderer — api2pdf.com ─────────────────────
// Takes markdown, renders to HTML with our court-document CSS, and
// posts to api2pdf's Chrome service. Returns a hosted PDF URL the
// user can download. Free tier = 100 PDFs/month; pay-per-PDF after.
async function renderPdfViaApi2Pdf({ markdown, title = 'Written Arguments', filename }) {
  const key = process.env.API2PDF_KEY;
  if (!key) throw new Error('API2PDF_KEY env var not set');

  const html = wrapHtml(mdToHtml(markdown), title);
  const safeName = String(filename || title || 'draft')
    .replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) + '.pdf';

  const r = await fetch('https://v2.api2pdf.com/chrome/pdf/html', {
    method: 'POST',
    headers: {
      'Authorization': key,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      html,
      inline: false,
      fileName: safeName,
      options: {
        marginTop:    '25mm',
        marginRight:  '25mm',
        marginBottom: '25mm',
        marginLeft:   '30mm',
        printBackground: true,
        preferCSSPageSize: true,
        scale: 1
      }
    })
  });
  const j = await r.json();
  if (!r.ok || j.success === false) {
    throw new Error('api2pdf failed: ' + (j.error || j.message || r.status));
  }
  return {
    url:      j.FileUrl || j.pdf || j.url,
    bytes:    j.responseSize || null,
    mbCost:   j.mbOut || null,
    seconds:  j.seconds || null,
    fileName: safeName
  };
}

module.exports = {
  runExperiment,
  WRITTEN_ARG_OVR17_TEMPLATE,
  // Pipeline agents
  improviseDraft,
  humanizeDraft,
  seniorRedTeam,
  seniorCritique,
  hallucinationCheck,
  completenessCheck,
  repairCompleteness,
  readinessQA,
  judgmentQuoteFetcher,
  nBestFill,
  pickBestFill,
  // Deterministic helpers
  structuralScan,
  timelineGuardSnapshot,
  timelineGuardDiff,
  applySpotFixes,
  sanitizeForCourt,
  renderPdf,                // local Mac Chrome (dev only)
  renderPdfViaApi2Pdf,      // production renderer
  mdToHtml,
  wrapHtml,
  // LLM primitives
  dsLong,
  dsRaw,
  MODEL_FLASH,
  MODEL_REASONER
};
