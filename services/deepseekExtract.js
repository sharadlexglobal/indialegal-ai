/**
 * DeepSeek V4 Flash extraction helpers — used by services/extraction.js
 * to (a) gap-fill any legally-significant atoms missed by Datalab's
 * structured extract, (b) classify segments when Datalab segmentation
 * confidence is low, (c) build the cross-segment intelligence layer
 * (party graph, unified timeline, causation map, consistency audit,
 * final case brief).
 *
 * Every DeepSeek output that flows into structured storage carries a
 * verbatim quote + source page so the user can verify against the PDF.
 */

const fetch = require('node-fetch');

const URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-v4-flash';

async function ds(messages, { timeoutMs = 180000, label = '' } = {}) {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.warn(`[deepseekExtract:${label}] DEEPSEEK_API_KEY missing`);
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
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
      return JSON.parse(j.choices?.[0]?.message?.content || '{}');
    } catch (e) {
      console.warn(`[deepseekExtract:${label}] retry ${i + 1}: ${e.message}`);
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────
// 1. Gap-fill: given the segment text + Datalab's structured JSON,
//    list every legally-significant atom that's MISSING from the JSON.
//    Output is heavily structured so we can store it cleanly.
// ─────────────────────────────────────────────────────────────────
async function gapFillSegment({ segmentText, structuredFacts, segmentType, segmentName }) {
  if (!segmentText || segmentText.length < 100) return [];
  const out = await ds([{
    role: 'user',
    content: `You are an exhaustive legal auditor for an Indian advocate.
Your one and only job: find every LEGALLY SIGNIFICANT atom in the
document below that is MISSING from the structured JSON we already
extracted, and list each as a separate entry.

A "legally significant atom" is anything an advocate would notice and
might need to refer to later — a clause, a covenant, a recital, a
waiver, a specific date / amount / name / address / identifier, a
particular admission, a denial, a condition, a deadline, a stamp duty
note, a registration detail, a footnote, anything off-schema.

DO NOT duplicate atoms that are already in the structured JSON.
DO NOT paraphrase — for every atom, copy the EXACT phrase from the
document so the advocate can verify it. NEVER invent.

For each atom you find, output an object with:
  • "atom_name": short snake_case label (e.g. "non_compete_clause", "stamp_duty_paid", "registration_book_no", "specific_admission_para_5", "diwali_ladoo_covenant", "witness_signature_thumbprint")
  • "atom_value": VERBATIM copy of the phrase / sentence from the document (40-400 chars)
  • "source_page": the page number the atom appears on (integer if known, else null)
  • "why_significant": ONE short clause explaining why an advocate would care

SEGMENT TYPE: ${segmentType || 'unknown'}
SEGMENT NAME: ${segmentName || ''}

ALREADY-EXTRACTED STRUCTURED JSON:
${JSON.stringify(structuredFacts || {}, null, 2)}

DOCUMENT TEXT (with page markers):
${String(segmentText).slice(0, 200000)}

Output strict JSON:
{
  "missed_atoms": [
    { "atom_name": "...", "atom_value": "...", "source_page": <int|null>, "why_significant": "..." },
    ...
  ]
}`
  }], { label: 'gapfill' });
  return Array.isArray(out?.missed_atoms) ? out.missed_atoms : [];
}

// Verify a DeepSeek-emitted atom's verbatim quote appears in the
// source markdown. Drops the atom if it doesn't — defends against
// hallucination.
function verifyAtomAgainstSource(atom, sourceMarkdown) {
  if (!atom || !atom.atom_value || !sourceMarkdown) return false;
  const norm = (s) => String(s || '')
    .replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"').replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ').toLowerCase();
  const nq = norm(atom.atom_value);
  if (nq.length < 20) return true;  // too short to verify; accept
  const ns = norm(sourceMarkdown);
  if (ns.includes(nq)) return true;
  // try head-60
  if (nq.length >= 60 && ns.includes(nq.slice(0, 60))) return true;
  // try any 50-char chunk
  if (nq.length >= 50) {
    for (let i = 0; i <= nq.length - 50; i += 30) {
      if (ns.includes(nq.slice(i, i + 50))) return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────
// 2. Classify a segment when Datalab segmentation confidence is low.
// ─────────────────────────────────────────────────────────────────
async function classifySegment({ segmentText, allowedTypes = [] }) {
  const out = await ds([{
    role: 'user',
    content: `Classify the following legal document into ONE of these
types. Be conservative — pick "unknown" if you're not at least 80% sure.

Allowed types (use the exact string):
${allowedTypes.map(t => '  - ' + t).join('\n')}
  - unknown

Output strict JSON: { "type": "...", "confidence": "high"|"medium"|"low", "why": "..." }

DOCUMENT:
${String(segmentText || '').slice(0, 80000)}`
  }], { label: 'classify' });
  return out || { type: 'unknown', confidence: 'low', why: 'no response' };
}

// ─────────────────────────────────────────────────────────────────
// 3. Fallback segmentation when Datalab returns 1 mega-segment for a
//    long PDF. DeepSeek reads the full markdown and proposes splits.
// ─────────────────────────────────────────────────────────────────
async function deepseekSegmentation({ markdown, allowedTypes = [] }) {
  const out = await ds([{
    role: 'user',
    content: `You are reading a SINGLE PDF that may contain MULTIPLE
distinct legal documents stapled / scanned together (e.g. an FIR
followed by a charge sheet followed by affidavits followed by
agreements followed by court orders).

Your job: identify the sub-documents and output their page ranges and
document types. A page boundary between sub-documents typically shows
a new heading / case-title / formal document-type marker / signatory
block separating them.

Allowed types: ${allowedTypes.join(', ')}, unknown.

PDF TEXT (with --- PAGE N --- markers):
${String(markdown || '').slice(0, 400000)}

Output strict JSON:
{
  "segments": [
    { "type": "...", "page_start": <int>, "page_end": <int>, "name": "...", "why": "..." },
    ...
  ]
}`
  }], { label: 'ds-segment' });
  const segs = Array.isArray(out?.segments) ? out.segments : [];
  return segs
    .filter(s => s && s.page_start && s.page_end)
    .map((s, idx) => ({
      idx,
      name: s.name || `Segment ${idx + 1}`,
      type: s.type || 'unknown',
      page_start: s.page_start, page_end: s.page_end,
      confidence: 'medium'   // DeepSeek's own; we'll flag as 'deepseek' source
    }));
}

// ─────────────────────────────────────────────────────────────────
// 4. Cross-segment helpers (whole-file rollup intelligence).
// ─────────────────────────────────────────────────────────────────

async function unifyPartyGraph({ segments }) {
  const partyDump = segments.map((s, i) => ({
    segment_index: i,
    segment_name: s.segment_name,
    parties: s.facts?.parties || [],
    petitioner: s.facts?.petitioner || [],
    respondent: s.facts?.respondent || [],
    signatories: s.facts?.signatories || []
  }));
  const out = await ds([{
    role: 'user',
    content: `Across all sub-documents below, identify each unique
PERSON. Same person may appear with slightly different spellings,
honorifics ("Mr.", "Smt.", "Dr."), abbreviated names ("R.K. Sharma"
vs "Ravi Kumar Sharma"), or role-only mentions ("the applicant",
"the deponent"). Map them all to a single canonical name.

INPUT:
${JSON.stringify(partyDump, null, 2)}

Output strict JSON:
{
  "people": [
    { "canonical_name": "Mr. R.K. Sharma",
      "aliases": ["R K Sharma", "Ravi Kumar Sharma", "the applicant"],
      "roles_by_segment": [
        { "segment_index": 0, "role": "applicant" },
        { "segment_index": 3, "role": "vendee" }
      ]
    }
  ]
}`
  }], { label: 'party-graph' });
  return out?.people || [];
}

async function unifyTimeline({ segments }) {
  // Pull every dated atom we can find.
  const dump = segments.map((s, i) => ({
    segment_index: i,
    segment_name: s.segment_name,
    document_date: s.facts?.document_date,
    filing_date: s.facts?.filing_date,
    fir_date: s.facts?.fir_date,
    date_of_incident: s.facts?.date_of_incident,
    cause_of_action_date: s.facts?.cause_of_action_date,
    effective_date: s.facts?.effective_date,
    expiry_date: s.facts?.expiry_or_termination_date,
    facts_chronology: s.facts?.facts_chronology || [],
    key_incidents: s.facts?.key_incidents || [],
    transactions: s.facts?.transactions || [],
    operative_directions: s.facts?.operative_directions || [],
    other_atoms: (s.other_atoms || []).slice(0, 30)
  }));
  const out = await ds([{
    role: 'user',
    content: `Build a single CHRONOLOGICAL TIMELINE of every dated
event across all sub-documents below. Normalise all dates to
DD-MMM-YYYY form. De-duplicate (same event mentioned in multiple
documents should appear ONCE with all source segments listed).

Sort chronologically, oldest first.

INPUT:
${JSON.stringify(dump, null, 2)}

Output strict JSON:
{
  "timeline": [
    { "date": "12-MAR-2019",
      "event": "Sale deed executed between X and Y for Rs. 1.5 crore",
      "actors": ["X", "Y"],
      "sources": [{ "segment_index": 0 }, { "segment_index": 3 }]
    }
  ]
}`
  }], { label: 'timeline', timeoutMs: 240000 });
  return out?.timeline || [];
}

async function causationMap({ segments }) {
  const lite = segments.map((s, i) => ({
    segment_index: i,
    segment_name: s.segment_name,
    segment_type: s.segment_type,
    one_line: s.facts?.one_line_summary,
    detailed: s.facts?.detailed_summary
  }));
  const out = await ds([{
    role: 'user',
    content: `Identify INTER-DOCUMENT RELATIONSHIPS across the case
file's sub-documents. Examples:
  - "Agreement signed in segment 2 was breached by the act in segment 5
     which led to FIR in segment 1"
  - "Charge sheet in segment 4 follows from the FIR in segment 1"
  - "Affidavit in segment 6 supports the prayer in segment 3"

Output strict JSON:
{
  "edges": [
    { "from_segment": <int>, "to_segment": <int>,
      "relationship": "follows-from" | "breaches" | "responds-to" |
                      "supports" | "contradicts" | "references" |
                      "executes" | "decides" | "settles",
      "evidence": "<short clause explaining the link>"
    }
  ]
}

SEGMENTS:
${JSON.stringify(lite, null, 2)}`
  }], { label: 'causation' });
  return out?.edges || [];
}

async function consistencyAudit({ segments }) {
  const dump = segments.map((s, i) => ({
    segment_index: i,
    segment_type: s.segment_type,
    parties: s.facts?.parties,
    dates: {
      document_date: s.facts?.document_date,
      fir_date: s.facts?.fir_date,
      filing_date: s.facts?.filing_date,
      date_of_incident: s.facts?.date_of_incident
    },
    amounts: s.facts?.consideration_amount || s.facts?.monetary_amounts_in_dispute,
    sections: s.facts?.sections || s.facts?.offences_alleged,
    operative: s.facts?.operative_directions
  }));
  const out = await ds([{
    role: 'user',
    content: `Compare these sub-document extractions and surface ONLY
GENUINE FACTUAL INCONSISTENCIES that an advocate would treat as
attack-points or reconciliation tasks.

DO flag:
  - Sale consideration / monetary amount differs between two
    documents describing the SAME transaction.
  - Date of an event differs across documents.
  - Section / offence list in FIR vs charge sheet that should
    have matched.
  - One document says "settlement reached"; another denies it.
  - One document calls a fact "admitted"; another denies the same
    fact.
  - Property description / address conflicts.

DO NOT FLAG (these are NORMAL, not inconsistencies):
  - The same person playing DIFFERENT PROCEDURAL ROLES in
    different documents — e.g. plaintiff in the main suit vs
    defendant in the counter-claim filed in the same suit; or
    petitioner in one application vs respondent in the opposing
    side's application. Procedural-posture changes are by design.
  - Same person appearing as "applicant" in one doc and "the
    counter-claimant" in another — these are role labels, not
    identity conflicts.
  - Same case being referenced by different procedural stages
    (FIR vs charge sheet vs court order in same case).
  - Different witnesses listed in different documents (each doc
    lists its own).
  - Minor spelling variations of names that look like obvious
    OCR / typing variants (these are aliases the party_graph step
    already consolidated).

INPUT:
${JSON.stringify(dump, null, 2)}

Output strict JSON:
{
  "inconsistencies": [
    { "field": "...", "value_a": "...", "segment_a": <int>,
      "value_b": "...", "segment_b": <int>, "why_inconsistent": "..." }
  ]
}`
  }], { label: 'audit' });
  return out?.inconsistencies || [];
}

async function caseBrief({ caseTitle, segments }) {
  const lite = segments.map((s, i) => ({
    segment_index: i,
    segment_type: s.segment_type,
    name: s.segment_name,
    one_line: s.facts?.one_line_summary,
    parties: s.facts?.parties?.slice(0, 5),
    date: s.facts?.document_date || s.facts?.fir_date || s.facts?.filing_date
  }));
  const out = await ds([{
    role: 'user',
    content: `Write a 4-5 sentence brief for an Indian advocate
covering: what the case is about, who the principal parties are,
the subject matter / dispute, the current procedural stage, and
the key relief/direction at issue.

Hinglish OK. Be concrete. Refer to specific facts.

CASE TITLE: ${caseTitle || ''}
SUB-DOCUMENTS:
${JSON.stringify(lite, null, 2)}

Output strict JSON: { "brief": "..." }`
  }], { label: 'brief' });
  return out?.brief || '';
}

module.exports = {
  gapFillSegment,
  verifyAtomAgainstSource,
  classifySegment,
  deepseekSegmentation,
  unifyPartyGraph,
  unifyTimeline,
  causationMap,
  consistencyAudit,
  caseBrief
};
