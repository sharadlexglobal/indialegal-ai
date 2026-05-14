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
const MODEL = 'deepseek-v4-flash';

const IKAPI_MCP_URL = process.env.IKAPI_MCP_URL || 'https://ikapi.onrender.com/mcp';

async function ds(messages, { timeoutMs = 240000, label = '' } = {}) {
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
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
      return JSON.parse(j.choices?.[0]?.message?.content || '{}');
    } catch (e) {
      console.warn(`[draftExp:${label}] retry ${i + 1}: ${e.message}`);
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
  return null;
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

function extractCitations(markdown) {
  const out = [];
  const seen = new Set();
  // Simple liberal pattern that catches "<Name> v[.] <Name>, (YYYY) ..."
  const re = /\*?\*?([A-Z][A-Za-z.&'\-\s]{2,80}\sv\.\s[A-Z][A-Za-z.&'\-\s]{2,80})\*?\*?,?\s*[\(\[]?(\d{4})[\)\]]?\s*([\dA-Z\s]+(SCC|AIR|SCR|SCALE|SCC OnLine))?/g;
  let m;
  while ((m = re.exec(markdown)) !== null) {
    const cite = (m[1] || '').trim().replace(/\s+/g, ' ');
    const year = m[2];
    if (cite.length < 8 || /(in|the|this|that|hon'ble|court|hereby|whereas)$/i.test(cite)) continue;
    const key = cite.toLowerCase() + '|' + year;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: cite, year, raw_match: m[0].slice(0, 200) });
  }
  return out;
}

async function ikapiSearch(query) {
  try {
    const r = await fetch(IKAPI_MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: {
          name: 'search_cases',
          arguments: { query, doctype: 'supremecourt', max_results: 3 }
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

async function verifyCitations(markdown) {
  const cites = extractCitations(markdown);
  const results = await Promise.all(cites.map(async (c) => {
    const hits = await ikapiSearch(`${c.name} ${c.year}`);
    const matched = hits.find(h => {
      const t = String(h.title || '').toLowerCase();
      const nameWords = c.name.toLowerCase().split(/\s+v\.\s+/);
      return nameWords.length === 2
        && t.includes(nameWords[0].split(' ').pop() || '')
        && t.includes(nameWords[1].split(' ')[0] || '');
    });
    return { ...c, verified: !!matched, matched_title: matched?.title || null };
  }));
  return results;
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

// ─── Public: run experiment with full pipeline ─────────────────
//
//   Step 1 — courtIdentifier  (decide HC vs DC vs Tribunal, fill cause-title)
//   Step 2 — buildCaseDump    (compact data feed for LLM)
//   Step 3 — DeepSeek fill    (placeholders → content with [seg] citations)
//   Step 4 — applyFill        (deterministic substitution)
//   Step 5 — verifyCitations  (MANDATORY — every cited case → IKAPI check)
//   Step 6 — annotateUnverified (any unverified citation → [VERIFY] tag)
//
async function runExperiment({ pool, caseId, templateName = 'written_arguments_o6r17' }) {
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

  // Step 1 — Identify the actual court (NEVER hardcoded)
  const courtInfo = await courtIdentifier.identifyCourt({ pool, caseId });

  const dump = buildCaseDump({
    caseTitle: cr.rows[0].title,
    segments: sr.rows,
    rollup: cr.rows[0].rollup || {},
    legal_issues: cr.rows[0].legal_issues || {}
  });

  // Step 3 — Fill the rest via DeepSeek (court block excluded — we
  // already have it from the identifier).
  const prompt = buildFillPrompt(dump, WRITTEN_ARG_OVR17_TEMPLATE)
    + `\n\nADDITIONAL — court already identified by a separate agent. Use the supplied cause_title_block VERBATIM; do NOT override.\nCourt info: ${JSON.stringify(courtInfo, null, 2)}`;
  const fill = await ds([{ role: 'user', content: prompt }], { label: 'fill' });
  if (!fill) throw new Error('DeepSeek fill returned nothing');

  // Inject the identifier's cause-title verbatim (never trust LLM with it)
  fill.cause_title_block = courtInfo.cause_title_block || fill.cause_title_block;

  // Step 4 — deterministic substitution
  let draftMarkdown = applyFill(WRITTEN_ARG_OVR17_TEMPLATE, fill);

  // Step 5 — mandatory citation verifier
  const verifications = await verifyCitations(draftMarkdown);
  const unverifiedCount = verifications.filter(v => !v.verified).length;

  // Step 6 — annotate any unverified citations
  if (unverifiedCount > 0) {
    draftMarkdown = annotateUnverified(draftMarkdown, verifications);
  }

  return {
    court_info: courtInfo,
    fill,
    draftMarkdown,
    citation_audit: {
      total: verifications.length,
      verified: verifications.length - unverifiedCount,
      unverified: unverifiedCount,
      details: verifications
    }
  };
}

module.exports = { runExperiment, WRITTEN_ARG_OVR17_TEMPLATE };
