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

// Parse a date string into a comparable number for sorting.
// Handles "23.05.2019", "05.09.2019", "13 December 2022", "2024-01-24" etc.
function parseDocDate(s) {
  if (!s) return 0;
  const str = String(s).trim();
  // Try ISO yyyy-mm-dd
  let m = str.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`).getTime();
  // Try DD.MM.YYYY / DD-MM-YYYY / DD/MM/YYYY
  m = str.match(/(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{4})/);
  if (m) return new Date(`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`).getTime();
  // Try "DD MMM YYYY" or "DD MMMM YYYY"
  m = str.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (m) {
    const d = new Date(`${m[2]} ${m[1]}, ${m[3]}`);
    if (!isNaN(d)) return d.getTime();
  }
  return 0;
}

// Build all the raw court-related signals — ranked by recency so the
// LLM can prefer the MOST RECENT judge for the cause title.
function harvestCourtSignals(segments, rollup) {
  const signals = {
    court_strings: [],
    judge_strings: [],
    case_numbers: [],
    most_recent_judge_hint: null
  };
  const judgeByDate = [];
  for (const s of segments) {
    const f = s.facts || {};
    if (f.court) signals.court_strings.push(`seg${s.segment_index}: ${f.court}`);
    const judge = f.judge_or_bench || f.judge;
    if (judge) {
      signals.judge_strings.push(`seg${s.segment_index}: ${judge}`);
      // Track for recency ranking
      const date = f.document_date || f.date_of_order || f.filing_date;
      const ts = parseDocDate(date);
      judgeByDate.push({
        segIdx: s.segment_index,
        segType: s.segment_type,
        judge,
        date: date || 'unknown',
        ts,
        isOrder: s.segment_type === 'court_order'
      });
    }
    if (f.case_number) signals.case_numbers.push(`seg${s.segment_index}: ${f.case_number}`);
    if (f.case_title) signals.case_numbers.push(`seg${s.segment_index} title: ${f.case_title}`);
  }
  // Sort by recency only (we want the CURRENT presiding judge).
  judgeByDate.sort((a, b) => b.ts - a.ts);

  // De-duplicate by judge surname so we can detect "many different
  // judges over time" (DC judges rotate) vs "one judge consistently".
  const surname = (j) => {
    const m = String(j || '').toUpperCase().match(/[A-Z][A-Z'\-]{2,}/g);
    if (!m) return '';
    // Drop honorifics + designations
    const noise = new Set(['MR','MS','MRS','SMT','SH','SHRI','DR','LD','HON',
      'HONBLE',"HON'BLE",'JUSTICE','ACJ','CCJ','ARC','CJ','ADJ','MM','CMM',
      'CJM','JMFC','THE','COURT','OF','SUPREME','HIGH','DELHI','NDD','PHC',
      'NEW']);
    return m.filter(x => !noise.has(x)).join(' ').trim() || '';
  };

  const distinctJudges = [];
  const seenSurnames = new Set();
  for (const j of judgeByDate) {
    const sn = surname(j.judge);
    if (!sn || seenSurnames.has(sn)) continue;
    seenSurnames.add(sn);
    distinctJudges.push({ ...j, surname: sn });
  }

  signals.distinct_judges_recent = distinctJudges.slice(0, 6);

  // If THREE OR MORE distinct judges appear anywhere in the case file,
  // that's structural rotation — we cannot confidently name the
  // current presiding officer. Use designation-only cause-title and
  // surface a clarification question.
  if (distinctJudges.length >= 3) {
    signals.most_recent_judge_hint =
      `AMBIGUOUS — ${distinctJudges.length} different judges have heard ` +
      `this matter over its lifetime (district-court judge rotation is ` +
      `normal): ` +
      distinctJudges.slice(0, 6).map(j =>
        `"${j.judge}" (${j.date}, seg${j.segIdx} ${j.segType})`).join('; ') +
      `. Do NOT pick any specific judge name. ` +
      `Set judge_name = null. Set judge_designation to the designation ` +
      `appearing in the most recent court_order (typically CCJ / ACJ / ` +
      `Civil Judge). Use the designation-only cause-title in this format: ` +
      `"IN THE COURT OF THE LD. CIVIL JUDGE, NEW DELHI DISTRICT, PATIALA ` +
      `HOUSE COURTS, NEW DELHI" (substitute the actual district + ` +
      `complex). MANDATORY: set user_clarification_needed to "Multiple ` +
      `judges have presided over this matter — please confirm the name ` +
      `of the CURRENT presiding officer for the cause title." Confidence ` +
      `should be at most 'medium' on judge_name even when the rest is high.`;
  } else if (distinctJudges.length === 2) {
    // 2 judges — borderline. Prefer court_order over plaint.
    const orderJudges = distinctJudges.filter(j => j.isOrder);
    const chosen = orderJudges[0] || distinctJudges[0];
    signals.most_recent_judge_hint =
      `BORDERLINE — 2 distinct judges in this matter. Most recent from ` +
      `a court_order (authoritative): "${chosen.judge}" ` +
      `(seg${chosen.segIdx}, ${chosen.date}). The other appears in a ` +
      `plaint / non-order document. Prefer the order-judge unless ` +
      `clearly outdated. If in doubt, output judge_name=null and use ` +
      `designation-only cause-title.`;
  } else if (judgeByDate.length) {
    const latest = judgeByDate[0];
    signals.most_recent_judge_hint =
      `Most recent judge: "${latest.judge}" from seg${latest.segIdx} ` +
      `(${latest.segType}, dated ${latest.date}). Use this for the ` +
      `cause-title.`;
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

${signals.most_recent_judge_hint || '(no recency hint available)'}

Court strings extracted from various sub-documents:
${(signals.court_strings || []).slice(0, 40).join('\n')}

Judge strings extracted (across multiple orders / hearings — multiple
judges may have heard the matter over time; for the CURRENT cause
title use the most recent / authoritative one as hinted above):
${(signals.judge_strings || []).slice(0, 40).join('\n')}

Case numbers / titles:
${(signals.case_numbers || []).slice(0, 40).join('\n')}

Brief from rollup:
${(rollup.brief || '').slice(0, 2000)}

────────────────── ADDITIONAL DISAMBIGUATION RULES ──────────────────

  (R5) Files in litigation pass through MULTIPLE judges over the years.
       For the cause-title of a fresh filing, use the MOST RECENT
       judge — the one named in the latest court_order segments.
  (R6) If the most_recent_judge_hint above is provided, STRONGLY
       prefer that judge unless other signals firmly contradict.
  (R7) If only a designation (CCJ / ADJ / Civil Judge) is available
       without a confirmed CURRENT name, output judge_name as null
       and write cause_title_block without a specific name —
       e.g. "IN THE COURT OF THE LD. CIVIL JUDGE, [district], [complex]"

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
