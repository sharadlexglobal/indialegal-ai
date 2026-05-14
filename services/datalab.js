const fetch = require('node-fetch');
const FormData = require('form-data');

const BASE = 'https://www.datalab.to';

// Universal-atomic legal-document schema (v2). Designed to extract
// every legally-relevant atom from ANY type of document an advocate
// might have in a case file — FIRs, charge sheets, pleadings,
// affidavits, deeds (sale/lease/gift/mortgage), wills, settlements,
// MOUs, agreements, decrees, interim orders, judgments, legal
// notices and their replies, postal receipts, challans, purchase
// orders, emails, letters, govt notifications, circulars, licenses,
// permissions, examination-in-chief and cross-examination transcripts,
// summons, warrants, vakalatnamas.
//
// Atomic principle: break compound things into the smallest useful
// unit — facts, incidents, transactions, parties, evidence, prayers,
// statutory references, operative directions each as their own list.
// Datalab fills what it finds; unfilled fields come back null.
const LEGAL_SCHEMA = {
  type: 'object',
  properties: {

    // ─── 1. DOCUMENT IDENTITY ───
    document_type: { type: 'string', description: "Type of document. Use ONE of (or closest): 'FIR', 'charge sheet', 'bail application', 'anticipatory bail', 'plaint', 'written statement', 'rejoinder', 'reply', 'replication', 'petition', 'writ petition', 'criminal misc', 'affidavit', 'counter affidavit', 'judgment', 'court order', 'interim order', 'decree', 'execution petition', 'sale deed', 'gift deed', 'lease deed', 'mortgage deed', 'agreement', 'MOU', 'settlement deed', 'family settlement', 'will', 'codicil', 'trust deed', 'power of attorney', 'legal notice', 'reply to legal notice', 'demand notice', 'postal receipt / track report', 'challan', 'purchase order', 'invoice', 'bill of lading', 'email communication', 'letter', 'government notification', 'government circular', 'government order', 'licence', 'permission', 'no-objection certificate', 'examination-in-chief', 'cross-examination', 'evidence affidavit', 'summons', 'warrant', 'vakalatnama', 'memorandum of appeal', 'caveat', 'application u/s 482 CrPC', 'application u/s 156(3) CrPC', 'application u/s 311 CrPC', 'compromise petition'." },
    document_title_or_heading: { type: 'string', description: 'The title / heading printed at the top of the document.' },
    document_date: { type: 'string', description: 'Date the document was executed, signed, or issued, in DD MMM YYYY form.' },
    document_reference_number: { type: 'string', description: 'Document / reference / registration / serial number as written on the document.' },

    // ─── 2. ISSUING AUTHORITY / SIGNATORIES / WITNESSES ───
    issuing_authority: { type: 'string', description: 'Who issued, executed, or authored this document — name of the court, police, government department, registrar, party, company, or individual. E.g. "Saket District Court", "SHO PS Hauz Khas", "Sub-Registrar III Delhi", "Ministry of Home Affairs", "Mr. X (individual capacity)", "ABC Pvt Ltd (Director Mr. Y)".' },
    signatories: { type: 'array', items: { type: 'string' }, description: 'Every person who signed the document, in the format "Name (designation/role)" — e.g. ["Mr. ABC (First Party)", "Ms. XYZ (Second Party)", "Mr. PQR (Sub-Registrar)"].' },
    attesting_witnesses: { type: 'array', items: { type: 'string' }, description: 'Attesting / identifying witnesses on the document (distinct from signatories — these are the persons who attest the signatures or identify the parties). Same "Name (role)" format.' },

    // ─── 3. PARTIES TO THE MATTER & RELATIONSHIPS ───
    parties: { type: 'array', items: { type: 'string' }, description: 'Every named party to the matter described in the document, in the format "Name (role)". Roles include: petitioner / respondent / plaintiff / defendant / applicant / non-applicant / appellant / opposite-party / complainant / accused / buyer / seller / lessor / lessee / mortgagor / mortgagee / donor / donee / testator / beneficiary / settlor / trustee / principal / agent / employer / employee / licensor / licensee.' },
    petitioner: { type: 'array', items: { type: 'string' }, description: 'Name(s) acting as petitioner / applicant / appellant / plaintiff / complainant in this matter.' },
    respondent: { type: 'array', items: { type: 'string' }, description: 'Name(s) acting as respondent / defendant / non-applicant / opposite-party / accused in this matter.' },
    relationship_between_parties: { type: 'string', description: 'Inter-se relationship of the principal parties — e.g. "husband-wife", "father-son", "vendor-purchaser", "lessor-lessee", "employer-employee", "principal-agent", "neighbours in property dispute", "competitors", "strangers / no prior relation".' },

    // ─── 4. COURT / CASE METADATA (when applicable) ───
    case_title: { type: 'string', description: '"X vs Y" case title.' },
    case_number: { type: 'string', description: 'Case / cause / appeal / suit number as written.' },
    court: { type: 'string', description: 'Court name (e.g. "Delhi High Court", "Saket District Court", "Supreme Court of India").' },
    judge_or_bench: { type: 'string', description: "Judge or bench name with prefix (e.g. \"Hon'ble Mr. Justice ABC\", \"DB: Justice X and Justice Y\")." },
    filing_date: { type: 'string', description: 'Date of institution / filing of the case.' },
    next_hearing_date: { type: 'string', description: 'Next listing date if mentioned.' },
    advocate_for_petitioner: { type: 'string', description: 'Counsel appearing for the petitioner side.' },
    advocate_for_respondent: { type: 'string', description: 'Counsel appearing for the respondent / state side.' },

    // ─── 5. SUBJECT MATTER OF DISPUTE / TRANSACTION ───
    subject_matter_summary: { type: 'string', description: 'One short sentence describing the subject matter of the dispute or transaction.' },
    subject_matter_type: { type: 'string', description: 'Nature of subject matter — "immovable property", "movable property", "money / debt", "specific performance", "injunction", "matrimonial", "custody", "criminal liability", "company / corporate", "tax", "service / employment", "constitutional", "tenancy", "succession", "consumer".' },
    property_description: { type: 'string', description: 'If immovable / movable property is involved, full description — address, area / extent, boundaries, khasra / khatauni / survey number, registration details.' },
    monetary_amounts_in_dispute: { type: 'array', items: { type: 'string' }, description: 'All monetary figures mentioned with their context — e.g. ["Rs. 25,00,000 paid as earnest money on 12-03-2019", "Rs. 6,67,87,000 alleged loss to complainant"].' },

    // ─── 6. FACTS, INCIDENTS, TRANSACTIONS ───
    facts_chronology: { type: 'array', items: { type: 'string' }, description: 'Dated events forming the factual background, each as a short sentence beginning with the date. List in CHRONOLOGICAL order, oldest first.' },
    key_incidents: { type: 'array', items: { type: 'string' }, description: 'Specific events that constitute the cause of action — assault, breach, demand, refusal, signing, execution, registration, payment, delivery, accident, arrest, recovery, search, seizure, etc. Each as one short sentence with date if known.' },
    transactions: { type: 'array', items: { type: 'string' }, description: 'Each transactional event with date + actor + counterparty + amount + mode. E.g. "On 03-01-2005, A paid Rs. 50,000 to B by cheque #123456 drawn on Bank XYZ".' },

    // ─── 7. CAUSE OF ACTION ───
    cause_of_action_date: { type: 'string', description: 'Date on which the cause of action arose (for limitation purposes).' },
    cause_of_action_description: { type: 'string', description: 'What act / omission by whom gave rise to the right to sue or prosecute.' },

    // ─── 8. EVIDENCE ───
    documentary_evidence: { type: 'array', items: { type: 'string' }, description: 'Each documentary exhibit referenced in the document, in the format "Ex. <tag>: <description> dated <date>". E.g. ["Ex. P-1: Sale deed dated 12-03-2019", "Ex. D-3: Bank statement dated 04-2020"].' },
    oral_evidence_witnesses: { type: 'array', items: { type: 'string' }, description: 'Witnesses whose oral evidence is referenced / recorded in this document, with their tag (PW-1, DW-2, CW-1) and one-line subject of their evidence if known.' },
    specific_admissions: { type: 'array', items: { type: 'string' }, description: 'Specific factual or legal admissions made BY any party in this document.' },
    specific_denials: { type: 'array', items: { type: 'string' }, description: 'Specific factual or legal denials made BY any party in this document.' },

    // ─── 9. STATUTORY REFERENCES & PRECEDENTS ───
    sections: { type: 'array', items: { type: 'string' }, description: 'Statutory sections invoked or referenced — e.g. ["302 IPC", "34 IPC", "120-B IPC", "439 CrPC", "138 NI Act", "498A IPC", "Section 13(1)(e) PC Act", "Section 3(5) BNS"].' },
    articles_invoked: { type: 'array', items: { type: 'string' }, description: 'Constitutional Articles referenced (e.g. ["Article 14", "Article 21", "Article 226"]).' },
    rules_invoked: { type: 'array', items: { type: 'string' }, description: 'Rules / Orders / Schedules referenced (e.g. ["Order 7 Rule 11 CPC", "Schedule I PMLA Rules"]).' },
    precedents_cited: { type: 'array', items: { type: 'string' }, description: 'Case-law citations referenced in the document — "Case Name vs Counterparty, Court, Year, Citation".' },

    // ─── 10. PRAYERS / RELIEFS ───
    main_prayers: { type: 'array', items: { type: 'string' }, description: 'Final reliefs / prayers sought, each as a short clause beginning with the action verb (quash, declare, direct, restrain, award, grant).' },
    interim_prayers: { type: 'array', items: { type: 'string' }, description: 'Interim / ad-interim reliefs sought.' },
    alternative_prayers: { type: 'array', items: { type: 'string' }, description: 'Alternative reliefs sought in case the main prayer fails.' },

    // ─── 11. ORDERS / OUTCOMES (for orders, decrees, judgments) ───
    order_outcome: { type: 'string', description: 'If the document IS an order / judgment / decree, the final outcome — "granted" / "dismissed" / "disposed" / "reserved" / "partly allowed" / "remanded" / "withdrawn".' },
    operative_directions: { type: 'array', items: { type: 'string' }, description: 'Specific directions in the operative part of the order / decree, each as one short clause.' },
    costs_awarded: { type: 'string', description: 'Costs ordered, if any (e.g. "Rs. 25,000 to be paid by respondent within 4 weeks").' },

    // ─── 12. AGREEMENT / DEED-SPECIFIC ATOMS ───
    consideration_amount: { type: 'string', description: 'Consideration amount for a sale / lease / mortgage / agreement (e.g. "Rs. 1.5 crore").' },
    consideration_payment_mode: { type: 'string', description: 'Mode and schedule of payment of consideration (cash / cheque / DD / RTGS / instalments).' },
    effective_date: { type: 'string', description: 'Effective / commencement date of the agreement or deed.' },
    termination_or_expiry_date: { type: 'string', description: 'Termination or expiry date of the agreement / lease / licence.' },
    governing_law: { type: 'string', description: 'Governing-law clause (e.g. "Indian Contract Act, 1872; laws of India").' },
    jurisdiction_clause: { type: 'string', description: 'Exclusive-jurisdiction clause naming the court(s).' },
    arbitration_clause: { type: 'string', description: 'Arbitration clause text or "absent" if there is none.' },
    key_obligations: { type: 'array', items: { type: 'string' }, description: 'Key obligations of each party, prefixed with party identifier — e.g. ["Party A: Pay Rs. 10 lakh on or before 30 June 2024", "Party B: Deliver title deeds within 30 days of payment"].' },

    // ─── 13. WILL-SPECIFIC ATOMS ───
    testator_name: { type: 'string', description: 'Name of the testator (only when document is a will).' },
    beneficiaries: { type: 'array', items: { type: 'string' }, description: 'Named beneficiaries with their share, in the format "Name (relation, share)".' },
    executor: { type: 'string', description: 'Executor of the will, if named.' },
    specific_bequests: { type: 'array', items: { type: 'string' }, description: 'Specific bequests — "To X, Rs. 50 lakh from FD No. ABC", "To Y, the flat at 28-A Prithviraj Road".' },

    // ─── 14. POLICE / CRIMINAL-SPECIFIC ATOMS ───
    fir_number: { type: 'string', description: 'FIR number as written.' },
    fir_date: { type: 'string', description: 'FIR registration date.' },
    police_station: { type: 'string', description: 'Police station of registration.' },
    offences_alleged: { type: 'array', items: { type: 'string' }, description: 'Offences alleged with section + statute (e.g. ["302 IPC — murder", "120-B IPC — criminal conspiracy"]).' },
    investigating_officer: { type: 'string', description: 'Investigating Officer (IO) name + designation + posting.' },
    accused_named: { type: 'array', items: { type: 'string' }, description: 'Accused persons named with sequence (Accused No. 1: name, age, address).' },
    arrest_status: { type: 'string', description: 'Whether each accused is in custody / on bail / absconding / at large, with date of arrest / release.' },
    recoveries: { type: 'array', items: { type: 'string' }, description: 'Items recovered / seized during investigation, each as "<item> recovered from <person> on <date> at <place>".' },

    // ─── 15. NOTICE / SERVICE / POSTAL ATOMS ───
    notice_recipient: { type: 'string', description: 'Person on whom legal notice is served / addressed.' },
    notice_demand: { type: 'string', description: 'What the legal notice demands of the recipient (e.g. "pay Rs. 5 lakh outstanding", "vacate premises", "withdraw the complaint").' },
    notice_compliance_period: { type: 'string', description: 'Time given for compliance (e.g. "15 days from receipt").' },
    notice_consequence_threatened: { type: 'string', description: 'Action threatened on non-compliance (suit, complaint u/s 138 NI Act, criminal complaint, etc.).' },
    mode_of_service: { type: 'string', description: 'Mode of service (registered post AD / speed post / UPC / courier / hand delivery / email).' },
    postal_or_tracking_number: { type: 'string', description: 'Postal / courier tracking / consignment number.' },

    // ─── 16. SUMMARIES ───
    one_line_summary: { type: 'string', description: 'Single short sentence — what this document is about.' },
    detailed_summary: { type: 'string', description: '3-5 sentence summary covering: what the document is, who the parties are, the subject matter, the key claim / demand / direction, and any operative outcome.' },
    key_orders_or_holdings: { type: 'array', items: { type: 'string' }, description: 'For order / judgment documents — the operative orders or principal holdings recorded, each as a short sentence.' }
  }
};

async function submitPdf(buffer, filename) {
  const form = new FormData();
  form.append('file', buffer, { filename, contentType: 'application/pdf' });
  form.append('output_format', 'json');
  form.append('paginate', 'true');

  const res = await fetch(`${BASE}/api/v1/marker`, {
    method: 'POST',
    headers: {
      'X-Api-Key': process.env.DATALAB_API_KEY,
      ...form.getHeaders()
    },
    body: form
  });
  const data = await res.json();
  if (!data.success) throw new Error(`Datalab submit failed: ${JSON.stringify(data)}`);
  return { requestId: data.request_id, checkUrl: data.request_check_url };
}

async function pollUntilDone(checkUrl, { maxAttempts = 180, intervalMs = 2000 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(checkUrl, {
      headers: { 'X-Api-Key': process.env.DATALAB_API_KEY }
    });
    const data = await res.json();
    if (data.status === 'complete') return data;
    if (data.status === 'failed' || data.success === false) {
      throw new Error(`Datalab failed: ${data.error || JSON.stringify(data)}`);
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error('Datalab polling timed out');
}

// Build a map PDF-page-index -> printed page number (e.g. "47") by
// scanning Datalab's PageHeader / PageFooter / SectionHeader blocks.
// If a PDF page has no printable header/footer page number (cover, index,
// front matter) the page is omitted from the map — caller falls back to
// the PDF page index in that case.
function extractPrintedPageMap(result) {
  const map = {};
  const json = result?.json;
  if (!json) return map;

  const PAGE_PATTERNS = [
    /^\s*page\s+(\d+)(?:\s+of\s+\d+)?\s*$/i,    // "Page 47", "Page 47 of 100"
    /^\s*[-—\s]*(\d{1,4})[-—\s]*$/,              // "47", "- 47 -", "—47—"
    /^\s*(\d{1,4})\s*\/\s*\d{1,4}\s*$/           // "47/100"
  ];

  function tryExtract(text) {
    const trimmed = String(text || '').replace(/\s+/g, ' ').trim();
    if (!trimmed || trimmed.length > 30) return null;
    for (const pat of PAGE_PATTERNS) {
      const m = trimmed.match(pat);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > 0 && n < 10000) return n;
      }
    }
    return null;
  }

  function walk(block, pageNum) {
    if (!block) return;
    if (block.block_type === 'Page' || block.type === 'Page') {
      pageNum = block.page || block.page_number || pageNum;
    }
    const bt = String(block.block_type || block.type || '').toLowerCase();
    const looksHeaderFooter = bt.includes('header') || bt.includes('footer')
                            || bt === 'pagenumber' || bt === 'page_number';
    if (looksHeaderFooter && pageNum != null && !(pageNum in map)) {
      let txt = block.text;
      if (!txt && block.html) {
        txt = String(block.html).replace(/<[^>]+>/g, ' ');
      }
      const n = tryExtract(txt);
      if (n) map[pageNum] = n;
    }
    const children = block.children || block.blocks || [];
    for (const c of children) walk(c, pageNum);
  }

  if (Array.isArray(json)) {
    json.forEach((page, idx) => walk(page, idx + 1));
  } else {
    walk(json, 1);
  }
  return map;
}

// Flatten the Datalab JSON tree into one readable string that preserves
// page boundaries so the model can cite "page N".
function flattenForPrompt(result) {
  const pieces = [];
  const json = result.json;
  if (!json) return result.markdown || '';

  // Datalab's JSON: top-level is a Block object with children = pages.
  function walkBlock(block, pageNum) {
    if (!block) return;
    if (block.block_type === 'Page' || block.type === 'Page') {
      pageNum = block.page || block.page_number || pageNum;
      pieces.push(`\n\n--- PAGE ${pageNum} ---\n`);
    }
    if (block.html) {
      // strip tags lazily
      const text = String(block.html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text && block.block_type !== 'Page') pieces.push(text);
    } else if (block.text) {
      pieces.push(block.text);
    }
    const children = block.children || block.blocks || [];
    for (const c of children) walkBlock(c, pageNum);
  }

  if (Array.isArray(json)) {
    json.forEach((page, idx) => walkBlock(page, idx + 1));
  } else {
    walkBlock(json, 1);
  }

  let out = pieces.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!out && result.markdown) out = result.markdown;
  return out;
}

async function submitExtract(buffer, filename, schema = LEGAL_SCHEMA, opts = {}) {
  const form = new FormData();
  form.append('file', buffer, { filename, contentType: 'application/pdf' });
  form.append('page_schema', JSON.stringify(schema));
  form.append('mode', opts.mode || 'balanced');
  if (opts.page_range) form.append('page_range', String(opts.page_range));
  if (opts.max_pages) form.append('max_pages', String(opts.max_pages));

  const res = await fetch(`${BASE}/api/v1/extract`, {
    method: 'POST',
    headers: {
      'X-Api-Key': process.env.DATALAB_API_KEY,
      ...form.getHeaders()
    },
    body: form
  });
  const data = await res.json();
  if (!data.success) throw new Error(`Datalab extract submit failed: ${JSON.stringify(data)}`);
  return { requestId: data.request_id, checkUrl: data.request_check_url };
}

// Datalab document-segmentation endpoint. Splits a multi-document PDF
// (case file containing FIR + charge sheet + agreements + affidavits +
// orders + ...) into typed sub-documents with page ranges and
// confidence scores. We pass the full list of legal doc types we
// support as the `segmentation_schema` so Datalab classifies each
// segment into one of those buckets.
//
//   buffer       — raw PDF
//   filename     — original filename
//   expectedTypes — array of doc-type strings (use SEGMENT_TYPES_FOR_DATALAB
//                  from typeSchemas.js)
async function submitSegmentation(buffer, filename, expectedTypes = []) {
  // Per Datalab docs: passing an EMPTY segments array triggers AUTO-
  // DETECTION — Datalab finds segment boundaries by itself and labels
  // each with whatever name it chooses. We then post-classify each
  // segment via DeepSeek into our type registry. This is more robust
  // than a constrained schema (which empirically returned 0 segments
  // on the Sodhani 240-page test PDF).
  //
  // If caller passes expectedTypes, we ALSO include hints (both `type`
  // and `name` keys to be belt-and-suspenders against schema-version
  // drift); empty array → pure auto.
  const segments = (expectedTypes || []).map(t => ({
    type: t,
    name: t,
    description:
      `A ${String(t).replace(/_/g, ' ')} document — typically identified ` +
      `by its heading, case title, formal markers, and signature block.`
  }));
  const segmentationSchema = { segments };

  const form = new FormData();
  form.append('file', buffer, { filename, contentType: 'application/pdf' });
  form.append('output_format', 'markdown');
  form.append('mode', 'balanced');
  form.append('segmentation_schema', JSON.stringify(segmentationSchema));

  const res = await fetch(`${BASE}/api/v1/segment`, {
    method: 'POST',
    headers: {
      'X-Api-Key': process.env.DATALAB_API_KEY,
      ...form.getHeaders()
    },
    body: form
  });
  const data = await res.json();
  if (!data.success) throw new Error(`Datalab segment submit failed: ${JSON.stringify(data)}`);
  return { requestId: data.request_id, checkUrl: data.request_check_url };
}

// Reads polled segmentation result. Datalab returns either
// `segmentation_results` (with `name`, `pages`, `confidence`,
// optionally `type`) or null. Normalises into a uniform array of
// {name, type, page_start, page_end, confidence}.
function parseSegmentationResult(result) {
  const raw = result.segmentation_results || result.segmentation || result.segments || [];
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((s, i) => {
    const pages = Array.isArray(s.pages) ? s.pages
                  : (s.page_range ? String(s.page_range).split(/[-,]/).map(n => parseInt(n, 10))
                                  : []);
    const page_start = pages[0] || s.page_start || s.from || null;
    const page_end   = pages[pages.length - 1] || s.page_end || s.to || page_start;
    return {
      idx: i,
      name: s.name || s.label || `Segment ${i + 1}`,
      type: s.type || s.document_type || null,
      page_start, page_end,
      confidence: s.confidence || 'medium'
    };
  }).filter(s => s.page_start != null);
}

// Reads the polled extract result and normalises into a plain JS object.
function parseExtractResult(result) {
  let raw = result.extraction_schema_json;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = null; }
  }
  // Some extractors return null fields for missing data — keep them as-is so
  // the UI can render "—" for missing fields.
  return raw || null;
}

// Take the OCR'd flat markdown for a SLICE of pages [start, end].
// Used by the orchestrator to give DeepSeek the text of each segment
// for the gap-fill pass.
//
// flattenForPrompt emits a `\n\n--- PAGE N ---\n` boundary; we split
// permissively so leading/trailing whitespace doesn't break us.
function markdownForPageRange(flatMarkdown, page_start, page_end, pageCount = null) {
  if (!flatMarkdown) return '';
  // Strategy 1: marker-based slice.
  const parts = flatMarkdown.split(/\n*--- PAGE (\d+) ---\n?/);
  const distinctMarkers = new Set();
  const out = [];
  for (let i = 1; i < parts.length; i += 2) {
    const pageNum = parseInt(parts[i], 10);
    if (!Number.isFinite(pageNum)) continue;
    distinctMarkers.add(pageNum);
    if (pageNum >= page_start && pageNum <= page_end) {
      out.push(`--- PAGE ${pageNum} ---\n${(parts[i + 1] || '').trim()}`);
    }
  }
  const markerSlice = out.join('\n\n').trim();

  // Trust the marker slice ONLY when the markdown has dense page
  // markers (≥ 50% of pageCount, or no pageCount given). Many scanned
  // PDFs come back from Datalab with sparse / single page markers —
  // the marker slice then over- or under-represents the segment.
  const markersSparse = pageCount &&
    distinctMarkers.size < Math.max(2, Math.floor(pageCount * 0.5));

  if (markerSlice && !markersSparse) return markerSlice;

  // Strategy 2: char-proportional fallback. Map page_start..page_end
  // to a proportional char slice of the markdown so each segment gets
  // approximately its share even when page boundaries are sparse.
  if (pageCount && flatMarkdown.length > 2000) {
    const stripped = flatMarkdown.replace(/^\s*--- PAGE \d+ ---\n/, '');
    const charsPerPage = stripped.length / pageCount;
    const startOff = Math.max(0, Math.floor((page_start - 1) * charsPerPage));
    const endOff = Math.min(stripped.length, Math.ceil(page_end * charsPerPage));
    if (endOff > startOff) {
      const slice = stripped.slice(startOff, endOff).trim();
      if (slice) return `[approx pages ${page_start}-${page_end}]\n${slice}`;
    }
  }

  // Last resort: empty (don't return whole markdown — that would
  // cause phantom-segment hallucination in DeepSeek gap-fill).
  return markerSlice;
}

module.exports = {
  submitPdf, pollUntilDone, flattenForPrompt, extractPrintedPageMap,
  submitExtract, parseExtractResult, LEGAL_SCHEMA,
  submitSegmentation, parseSegmentationResult,
  markdownForPageRange
};
