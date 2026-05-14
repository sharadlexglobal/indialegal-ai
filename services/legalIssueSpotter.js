/**
 * Legal-issue spotter — feed the extracted-data dump for a case to
 * DeepSeek V4 Flash and ask it to think like a senior Indian advocate:
 * identify every legal question / issue that arises from these facts.
 *
 * Output is structured JSON per issue, with factual basis, applicable
 * law, arguments-for-each-side, and strategic significance — exactly
 * what an advocate-friendly issue-list looks like in a junior's brief
 * to the senior.
 *
 *   spotIssues({ pool, caseId })
 *     - loads all case_segments rows + cases.rollup
 *     - flattens into a single legal-data dump
 *     - sends to DeepSeek with the senior-advocate prompt
 *     - persists the result on cases.legal_issues
 *     - returns the issues JSON
 */

const fetch = require('node-fetch');

const URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-v4-flash';

async function ds(messages, { timeoutMs = 240000, label = '' } = {}) {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.warn(`[issues:${label}] DEEPSEEK_API_KEY missing`);
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
      console.warn(`[issues:${label}] retry ${i + 1}: ${e.message}`);
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
  return null;
}

// Build a compact, dense data dump for DeepSeek covering the whole case.
// Cap each segment's content so the total fits comfortably in context.
function buildCaseDump({ caseTitle, segments, rollup }) {
  const lines = [];
  lines.push(`CASE: ${caseTitle || 'Untitled'}`);
  lines.push('');

  if (rollup) {
    if (rollup.brief) {
      lines.push('--- CASE BRIEF (synthesized) ---');
      lines.push(rollup.brief);
      lines.push('');
    }

    const timeline = rollup.timeline || [];
    if (timeline.length) {
      lines.push(`--- CHRONOLOGY (${timeline.length} events) ---`);
      for (const e of timeline.slice(0, 80)) {
        lines.push(`${e.date || '?'} — ${e.event || ''}`);
      }
      lines.push('');
    }

    const parties = rollup.party_graph || [];
    if (parties.length) {
      lines.push(`--- PARTIES (${parties.length}) ---`);
      for (const p of parties.slice(0, 30)) {
        const al = (p.aliases || []).slice(0, 4).join(', ');
        lines.push(`${p.canonical_name}${al ? ' [aliases: ' + al + ']' : ''}`);
      }
      lines.push('');
    }

    const stats = rollup.statutes_index || [];
    if (stats.length) {
      lines.push(`--- STATUTORY REFERENCES (${stats.length}) ---`);
      for (const s of stats.slice(0, 40)) lines.push(`• ${s.text}`);
      lines.push('');
    }

    const evid = rollup.evidence_index || [];
    if (evid.length) {
      lines.push(`--- DOCUMENTARY EVIDENCE (${evid.length}) ---`);
      for (const e of evid.slice(0, 30)) lines.push(`• ${e.exhibit}`);
      lines.push('');
    }

    const inc = rollup.inconsistencies || [];
    if (inc.length) {
      lines.push(`--- CROSS-DOCUMENT INCONSISTENCIES ---`);
      for (const i of inc) {
        lines.push(`• ${i.field}: seg${i.segment_a}="${(i.value_a || '').slice(0, 80)}" vs seg${i.segment_b}="${(i.value_b || '').slice(0, 80)}" — ${i.why_inconsistent || ''}`);
      }
      lines.push('');
    }

    const cm = rollup.causation_map || [];
    if (cm.length) {
      lines.push(`--- INTER-DOC CAUSATION ---`);
      for (const c of cm) {
        lines.push(`seg${c.from_segment} → seg${c.to_segment} (${c.relationship}): ${c.evidence || ''}`);
      }
      lines.push('');
    }
  }

  lines.push(`--- ${segments.length} SUB-DOCUMENTS ---`);
  for (const s of segments) {
    lines.push('');
    lines.push(`▸ seg${s.segment_index} | ${s.segment_type} | pp${s.page_start}-${s.page_end}${s.segment_name ? ' | ' + s.segment_name : ''}`);
    const f = s.facts || {};
    // Pick the most legally-loaded fields
    const keysOfInterest = [
      'one_line_summary', 'detailed_summary',
      'case_title', 'case_number', 'court', 'judge_or_bench',
      'parties', 'petitioner', 'respondent', 'relationship_between_parties',
      'subject_matter_summary', 'subject_matter_type',
      'property_description', 'monetary_amounts_in_dispute',
      'facts_chronology', 'key_incidents', 'transactions',
      'cause_of_action_date', 'cause_of_action_description', 'cause_of_action_paragraph',
      'sections', 'statutory_invocation', 'statutes_considered', 'articles_invoked',
      'precedents_cited',
      'main_prayers', 'interim_prayers', 'alternative_prayers', 'prayers',
      'order_outcome', 'operative_directions',
      'consideration_amount', 'effective_date',
      'documentary_evidence', 'specific_admissions', 'specific_denials',
      'preliminary_objections', 'grounds',
      'fir_number', 'fir_date', 'police_station', 'offences_alleged', 'accused_named',
      'notice_demand', 'notice_compliance_period'
    ];
    for (const k of keysOfInterest) {
      const v = f[k];
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
      if (Array.isArray(v)) {
        lines.push(`  ${k}:`);
        for (const item of v.slice(0, 8)) lines.push(`    • ${String(item).slice(0, 300)}`);
        if (v.length > 8) lines.push(`    ... +${v.length - 8} more`);
      } else {
        lines.push(`  ${k}: ${String(v).slice(0, 400)}`);
      }
    }
    // Plus 5 most-significant atoms per segment
    const atoms = (s.other_atoms || []).slice(0, 5);
    if (atoms.length) {
      lines.push('  notable_atoms:');
      for (const a of atoms) {
        if (!a || !a.atom_value) continue;
        lines.push(`    • [${a.atom_name || 'atom'}] ${String(a.atom_value).slice(0, 250)}`);
      }
    }
  }

  return lines.join('\n');
}

// ─── The prompt — senior-advocate issue-spotter ────────────────────
function buildIssuePrompt(dump) {
  return `You are a SENIOR ADVOCATE practising at the Delhi High Court for 30+ years.
You have just received a junior's structured brief of a case file (below).
Your task: identify EVERY legal question / issue that an advocate would
genuinely need to address in this matter, based on the actual facts in the
brief. Be exhaustive, specific to THIS case (no generic checklists), and
think strategically — like you are preparing for arguments.

INSTRUCTIONS:

(1) Cover all four layers of issues:
    • SUBSTANTIVE — rights, obligations, remedies, validity of instruments,
      title, contract, tort, fraud, coercion, misrepresentation, etc.
    • PROCEDURAL — limitation, jurisdiction, maintainability, res judicata,
      cause of action, amendment, joinder, service, abatement, etc.
    • EVIDENTIARY — admissibility, burden of proof, presumptions, secondary
      evidence, hearsay, hostile witness, examination chief / cross.
    • STRATEGIC / HIDDEN — issues a less-experienced lawyer would miss:
      stamp duty insufficiency, registration defects, computation of court
      fees, valuation, alternative remedies, indemnity, election of remedies,
      adverse inference, equitable defenses, hot-tubbing of experts, etc.

(2) For EVERY issue, ground it in SPECIFIC FACTS from the brief — name the
    specific document, date, amount, party, or statute that raises it.
    NEVER invent facts; if the brief doesn't support an issue, do not
    raise it. If a fact is missing that would settle the issue, list it
    under "fact_to_verify".

(3) Cite applicable law precisely:
    • Statute + Section (e.g. "Section 17 Registration Act, 1908")
    • Leading cases ONLY when you are confident of the citation — name +
      court + year (e.g. "B.S. Joshi v State of Haryana, SC, 2003"); if
      unsure, say "(precedent on this point exists — to verify)".

(4) Argue both sides. For each issue, state the petitioner's likely
    contention AND the respondent's likely contention. Do not be one-sided.

(5) Add a STRATEGIC_SIGNIFICANCE field — why this issue matters: is it a
    threshold issue that can kill the case, a strong attack point, a
    defensive shield, an evidentiary trap, etc.

(6) Sort issues by STRATEGIC_PRIORITY (1 = most decisive, 10 = peripheral).

(7) Also identify any RED FLAGS — things in the brief that look wrong,
    suspicious, or actionable for a counter-attack (forged signature,
    inconsistent dates across documents, unregistered settlement,
    inadequate stamp duty, etc.).

(8) Finally, give a TOP-3 STRATEGIC RECOMMENDATIONS section: the three
    moves you would advise to maximise the client's position.

DATA (extracted by a 14-step pipeline; every atom is verbatim-verified
against the source document, with page citations available):

${dump.slice(0, 380000)}

Output STRICT JSON in this shape:

{
  "case_one_liner": "<one-sentence framing of the dispute as you see it>",
  "issues": [
    {
      "priority": <1-10>,
      "category": "substantive" | "procedural" | "evidentiary" | "strategic",
      "name": "<short label, max 12 words>",
      "factual_basis": "<which specific facts / docs / dates raise this>",
      "applicable_law": "<statute(s) + section(s) + leading precedent(s)>",
      "petitioner_argument": "<one paragraph — concrete, fact-anchored>",
      "respondent_argument": "<one paragraph — concrete, fact-anchored>",
      "strategic_significance": "<why this matters strategically>",
      "fact_to_verify": "<any fact missing from the brief that would settle this — or null>"
    }
  ],
  "red_flags": [
    { "flag": "<one-line>", "factual_basis": "<which doc / clause>", "actionable_as": "<what to do about it>" }
  ],
  "top_strategic_moves": [
    { "move": "<one-line>", "rationale": "<why this maximises position>" }
  ]
}`;
}

async function spotIssues({ pool, caseId }) {
  const cr = await pool.query(`SELECT title, rollup FROM cases WHERE id=$1`, [caseId]);
  if (!cr.rows.length) throw new Error('case not found');
  const caseTitle = cr.rows[0].title || '';
  const rollup = cr.rows[0].rollup || {};

  const sr = await pool.query(
    `SELECT segment_index, segment_name, segment_type, page_start, page_end,
            facts, other_atoms
       FROM case_segments WHERE case_id=$1 ORDER BY segment_index ASC`,
    [caseId]
  );
  const segments = sr.rows;
  if (!segments.length) throw new Error('case has no extracted segments');

  const dump = buildCaseDump({ caseTitle, segments, rollup });
  const prompt = buildIssuePrompt(dump);
  const out = await ds([{ role: 'user', content: prompt }], { label: 'spot' });
  if (!out) throw new Error('DeepSeek returned nothing');

  // Persist on cases.legal_issues
  try {
    await pool.query(
      `UPDATE cases SET legal_issues=$1::jsonb, updated_at=NOW() WHERE id=$2`,
      [JSON.stringify(out), caseId]
    );
  } catch (e) {
    console.warn('legal_issues persist failed:', e.message);
  }

  return out;
}

module.exports = { spotIssues, buildCaseDump, buildIssuePrompt };
