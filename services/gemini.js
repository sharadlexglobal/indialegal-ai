const fetch = require('node-fetch');

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

async function createStore(displayName) {
  const res = await fetch(`${BASE}/fileSearchStores?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Gemini store error: ${JSON.stringify(data)}`);
  return data.name; // e.g. "fileSearchStores/abc123"
}

async function uploadAndImport(storeName, buffer, filename) {
  // Single-step: media.uploadToFileSearchStore with resumable upload protocol.
  const initRes = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/${storeName}:uploadToFileSearchStore?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(buffer.length),
        'X-Goog-Upload-Header-Content-Type': 'application/pdf',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ displayName: filename })
    }
  );
  const uploadUrl = initRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error(`Gemini upload init failed: ${await initRes.text()}`);

  const upRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(buffer.length),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize'
    },
    body: buffer
  });
  const upData = await upRes.json();
  if (!upRes.ok) throw new Error(`Gemini upload failed: ${JSON.stringify(upData)}`);
  // Response is an Operation; the eventual document name is in response.name after polling.
  return { fileName: upData.name || filename };
}

async function generateGroundedAnswer(storeName, systemPrompt, userText) {
  const res = await fetch(
    `${BASE}/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        tools: [{ fileSearch: { fileSearchStoreNames: [storeName] } }]
      })
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Gemini generate error: ${JSON.stringify(data)}`);
  const text = (data.candidates?.[0]?.content?.parts || [])
    .map(p => p.text || '')
    .join('\n')
    .trim();
  return { text, raw: data };
}

module.exports = { createStore, uploadAndImport, generateGroundedAnswer };
