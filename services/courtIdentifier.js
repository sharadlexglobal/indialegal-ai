/**
 * Court Identifier — a pre-drafting agent that decides EXACTLY which
 * court/forum a document is being prepared for. Without this, the
 * drafter hardcodes the wrong cause-title (HC vs District vs Tribunal),
 * which is a fatal blunder for any court filing.
 *
 * Signals consulted:
 *   • case_segments[].facts.court / judge_or_bench / case_number
 *   • cases.rollup.brief
 *   • title prefixes (CS(OS), W.P., Crl.M.C., Bail Appln., O.A., etc.)
 *   • judge designations (J., CJ., CCJ., ADJ., MM., CMM., etc.)
 *
 * Output: a normalised court_info object the template fills with
 * proper cause-title language. If ambiguous, returns confidence=low
 * with an explicit clarification question to ask the user.
 */

const fetch = require('node-fetch');

const URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-v4-flash';

async function ds(messages, { timeoutMs = 90000, label = '' } = {}) {
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
      console.warn(`[courtId:${label}] retry ${i + 1}: ${e.message}`);
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
  return null;
}

// Build all the raw court-related signals we can find across segments.
function harvestCourtSignals(segments, rollup) {
  const signals = {
    court_strings: [],
    judge_strings: [],
    case_numbers: [],
    designation_hints: [],
    document_dates: [],
    place_strings: []
  };
  for (const s of segments) {
    const f = s.facts || {};
    if (f.court) signals.court_strings.push(`seg${s.segment_index}: ${f.court}`);
    if (f.judge_or_bench) signals.judge_strings.push(`seg${s.segment_index}: ${f.judge_or_bench}`);
    if (f.judge) signals.judge_strings.push(`seg${s.segment_index}: ${f.judge}`);
    if (f.case_number) signals.case_numbers.push(`seg${s.segment_index}: ${f.case_number}`);
    if (f.case_title) signals.case_numbers.push(`seg${s.segment_index} title: ${f.case_title}`);
  }
  return signals;
}

async function identifyCourt({ pool, caseId }) {
  const cr = await pool.query(`SELECT title, rollup FROM cases WHERE id=$1`, [caseId]);
  if (!cr.rows.length) throw new Error('case not found');
  const sr = await pool.query(
    `SELECT segment_index, segment_type, page_start, page_end, facts
       FROM case_segments WHERE case_id=$1 ORDER BY segment_index ASC`,
    [caseId]
  );
  const segments = sr.rows;
  const rollup = cr.rows[0].rollup || {};
  const caseTitle = cr.rows[0].title || '';

  const signals = harvestCourtSignals(segments, rollup);

  // Hand all signals to DeepSeek with strict resolution rules.
  const out = await ds([{
    role: 'user',
    content: `You are a court-identification expert for Indian litigation.
Multiple sub-documents from a case file describe the court and judge
in slightly different forms — sometimes the extractor (Datalab OCR)
confused descriptions. Your job: RESOLVE the actual forum where the
case is being heard, with high confidence.

INDIAN COURT TAXONOMY (use this to disambiguate):

  • Supreme Court of India — designations: "Hon'ble Mr. Justice X",
    case prefixes: SLP(C), SLP(Crl), C.A., Crl.A., W.P.(C), W.P.(Crl).
  • High Courts (every state) — designations: "Hon'ble Mr. Justice X",
    case prefixes vary: CS(OS), W.P.(C), Crl.M.C., FAO, RFA, MAT.APP,
    Bail Appln., RC.REV.
  • District / Sessions Courts — designations: ADJ (Additional
    District Judge), DJ (District Judge), CCJ (Central / Civil Judge),
    Sr. Civ. J. (Senior Civil Judge), MM (Metropolitan Magistrate),
    CMM (Chief Metropolitan Magistrate), CJM (Chief Judicial
    Magistrate), JMFC (Judicial Magistrate First Class). In Delhi
    the major DC complexes are: Patiala House, Saket, Tis Hazari,
    Karkardooma, Rohini, Dwarka.
  • Tribunals — NCLT, NCLAT, ITAT, GSTAT, DRT, DRAT, AFT, CAT, SAT,
    APTEL, NGT, etc.

CRITICAL DISAMBIGUATION RULES:

  (R1) "CCJ" / "Civil Judge" / "Senior Civil Judge" → ALWAYS DISTRICT
       COURT, never High Court. If a sub-document says "High Court of
       Delhi, specifically the Court of Sh. X, Ld. CCJ" — that's an
       OCR / extraction confusion; the actual court is the DISTRICT
       COURT where the CCJ sits, NOT the High Court.
  (R2) Case-number prefix is a strong hint:
        - SLP(C) / SLP(Crl) → Supreme Court
        - CS(OS) by itself is AMBIGUOUS — both Delhi HC and Delhi
          District Court use this. Look at the JUDGE designation to
          disambiguate. If judge is "Hon'ble Mr. Justice X" → HC.
          If judge is "Sh. X, CCJ / ADJ / Civil Judge" → District.
        - Bail Appln. / Crl.M.C. → typically HC
        - C.M. APPL. / S.C.J. / Sr. Civ. J. → District
  (R3) If the case is filed in a District Court complex (Patiala
       House, Saket, etc.), the cause-title format is:
       "IN THE COURT OF SH. [NAME], LD. [DESIGNATION], [DISTRICT
       NAME] DISTRICT, [COMPLEX NAME], NEW DELHI"
  (R4) HC cause title is:
       "IN THE HIGH COURT OF DELHI AT NEW DELHI (ORDINARY ORIGINAL
       CIVIL JURISDICTION)" or similar with proper jurisdiction.

──────────── RAW SIGNALS FROM CASE FILE ────────────

Case title: ${caseTitle}

Court strings extracted from various sub-documents:
${(signals.court_strings || []).slice(0, 40).join('\n')}

Judge strings extracted:
${(signals.judge_strings || []).slice(0, 40).join('\n')}

Case numbers / titles:
${(signals.case_numbers || []).slice(0, 40).join('\n')}

Brief from rollup:
${(rollup.brief || '').slice(0, 2000)}

──────────── OUTPUT (strict JSON) ────────────

{
  "court_level": "supreme_court" | "high_court" | "district_court" | "sessions_court" | "magistrate_court" | "tribunal" | "consumer_forum" | "unknown",
  "court_specific_name": "<e.g. 'Delhi High Court' | 'Patiala House Courts, New Delhi' | 'NCLT Mumbai Bench' | 'Saket District Court' | etc.>",
  "judge_name": "<e.g. 'Sh. Dhiraj Mittal' | 'Hon'ble Mr. Justice Sanjeev Sachdeva' | null>",
  "judge_designation": "<e.g. 'CCJ' | 'ADJ' | 'Justice' | 'Member (Judicial)' | etc.>",
  "jurisdiction_type": "<e.g. 'Ordinary Original Civil' | 'Appellate' | 'Original' | 'Writ' | 'Civil — Pecuniary' | etc.>",
  "complex": "<Delhi DC complex if district court, else null>",
  "district": "<Central/South/North/etc. — if applicable>",
  "case_number_format": "<exact format e.g. 'CS DJ 1619/2017' | 'CS(OS) 1619/2017' | etc.>",
  "cause_title_block": "<EXACT cause-title heading line(s) to use in any draft for this forum, properly formatted with line breaks>",
  "confidence": "high" | "medium" | "low",
  "reasoning": "<short — which signals you used, how you resolved ambiguity>",
  "user_clarification_needed": "<if confidence < high, the exact question to ask the user — else empty string>"
}`
  }], { label: 'identify' });
  return out || { court_level: 'unknown', confidence: 'low',
    user_clarification_needed: 'Could not identify the court automatically — which court is this matter pending before?' };
}

module.exports = { identifyCourt, harvestCourtSignals };
