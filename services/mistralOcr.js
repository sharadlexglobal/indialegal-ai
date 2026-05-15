/**
 * Mistral OCR client — fast text extraction from PDFs.
 *
 * Used to build the case timeline shown to the user as soon as a
 * CNR is fetched. Mistral OCR is ~2-4 s per page, much faster than
 * Datalab marker (which we run in parallel for permanent structured
 * extraction).
 *
 * API: POST https://api.mistral.ai/v1/ocr
 *   body: { model, document: { type: 'document_url', document_url } }
 * For PDFs not at a URL we base64-encode and pass document_base64.
 */

const fetch = require('node-fetch');

const URL_OCR = 'https://api.mistral.ai/v1/ocr';
const MODEL   = process.env.MISTRAL_OCR_MODEL || 'mistral-ocr-latest';

function _keyOrThrow() {
  const k = process.env.MISTRAL_API_KEY;
  if (!k) throw new Error('MISTRAL_API_KEY not set');
  return k;
}

// OCR a single PDF buffer. Returns { pages: [{index, markdown}], full_text }.
// Pages are returned in document order; full_text is them joined with
// page-boundary markers.
async function ocrPdfBuffer(buffer, { filename = 'document.pdf', timeoutMs = 90000 } = {}) {
  const key = _keyOrThrow();
  const b64 = buffer.toString('base64');
  const dataUri = `data:application/pdf;base64,${b64}`;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(URL_OCR, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        document: { type: 'document_url', document_url: dataUri },
        include_image_base64: false
      }),
      signal: ctl.signal
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Mistral OCR ${res.status}: ${txt.slice(0, 240)}`);
    }
    const j = await res.json();
    // Response shape:
    //   { pages: [{ index, markdown, images, dimensions }], model, usage_info }
    const pages = (j.pages || []).map(p => ({
      index: p.index,
      markdown: p.markdown || ''
    }));
    const full_text = pages
      .map(p => `\n\n--- PAGE ${p.index} ---\n${p.markdown}`)
      .join('').trim();
    return { pages, full_text, model: j.model, usage: j.usage_info };
  } finally {
    clearTimeout(timer);
  }
}

// Batch — concurrency 3, returns array in original order with
// { ok, result?, error? } for each item.
async function ocrBatch(items, { concurrency = 3, onProgress } = {}) {
  const results = new Array(items.length);
  let inflight = 0, completed = 0, idx = 0;
  return new Promise((resolve) => {
    function tick() {
      while (inflight < concurrency && idx < items.length) {
        const myIdx = idx++;
        inflight++;
        const item = items[myIdx];
        ocrPdfBuffer(item.buffer, { filename: item.filename })
          .then(r => { results[myIdx] = { ok: true, result: r, key: item.key, label: item.label }; })
          .catch(e => { results[myIdx] = { ok: false, error: e.message, key: item.key, label: item.label }; })
          .finally(() => {
            inflight--; completed++;
            if (onProgress) onProgress({ completed, total: items.length, lastIdx: myIdx });
            if (completed === items.length) return resolve(results);
            tick();
          });
      }
    }
    tick();
  });
}

module.exports = { ocrPdfBuffer, ocrBatch, MODEL };
