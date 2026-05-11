const fetch = require('node-fetch');
const FormData = require('form-data');

const BASE = 'https://www.datalab.to';

// Schema for Indian legal documents. Datalab's structured extraction
// uses standard JSON Schema; field descriptions guide the extractor.
// Keep fields tight — too many dilutes quality and slows extraction.
const LEGAL_SCHEMA = {
  type: 'object',
  properties: {
    document_type: { type: 'string', description: "Type of document (e.g. 'bail application', 'judgment', 'court order', 'FIR copy', 'complaint', 'reply', 'rejoinder', 'contract', 'sale deed', 'will')." },
    case_title: { type: 'string', description: "Full case title (e.g. 'XYZ vs State of NCT of Delhi')." },
    case_number: { type: 'string', description: "Case / cause / appeal number as written (e.g. 'Bail Appln. 1234/2024', 'Crl.A. 567/2023')." },
    court: { type: 'string', description: "Name of the court (e.g. 'Delhi High Court', 'Saket District Court', 'Supreme Court of India')." },
    judge: { type: 'string', description: "Name of the presiding judge or bench, with prefix (e.g. \"Hon'ble Mr. Justice ABC\")." },
    filing_date: { type: 'string', description: 'Date the case / document was filed, in DD MMM YYYY form if possible.' },
    fir_number: { type: 'string', description: 'FIR number if mentioned anywhere in the document.' },
    fir_date: { type: 'string', description: 'Date the FIR was registered.' },
    police_station: { type: 'string', description: 'Name of the police station where the FIR was registered.' },
    petitioner: { type: 'array', items: { type: 'string' }, description: 'Name(s) of the petitioner / applicant / appellant / plaintiff.' },
    respondent: { type: 'array', items: { type: 'string' }, description: 'Name(s) of the respondent / opposite party / non-applicant / defendant.' },
    advocate_for_petitioner: { type: 'string', description: 'Counsel(s) appearing for the petitioner / applicant.' },
    advocate_for_respondent: { type: 'string', description: 'Counsel(s) appearing for the respondent / state / opposite party.' },
    sections: { type: 'array', items: { type: 'string' }, description: 'Statutory sections invoked (e.g. [\"302 IPC\", \"34 IPC\", \"120-B IPC\", \"439 CrPC\"]).' },
    prayer: { type: 'string', description: 'What the petitioner is asking the court to do (the relief / prayer clause).' },
    next_hearing_date: { type: 'string', description: 'Next listing or hearing date if mentioned.' },
    key_orders_or_holdings: { type: 'array', items: { type: 'string' }, description: 'Operative orders or principal holdings recorded in the document, each as a short sentence.' },
    one_line_summary: { type: 'string', description: 'A single short sentence describing what this document is about.' }
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

async function submitExtract(buffer, filename, schema = LEGAL_SCHEMA) {
  const form = new FormData();
  form.append('file', buffer, { filename, contentType: 'application/pdf' });
  form.append('page_schema', JSON.stringify(schema));
  form.append('mode', 'balanced');

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

module.exports = {
  submitPdf, pollUntilDone, flattenForPrompt,
  submitExtract, parseExtractResult, LEGAL_SCHEMA
};
