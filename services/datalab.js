const fetch = require('node-fetch');
const FormData = require('form-data');

const BASE = 'https://www.datalab.to';

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

module.exports = { submitPdf, pollUntilDone, flattenForPrompt };
