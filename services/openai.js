const fetch = require('node-fetch');

const MODEL = 'gpt-realtime-2';

async function createEphemeralToken(systemPrompt) {
  const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      session: {
        type: 'realtime',
        model: MODEL,
        instructions: systemPrompt,
        audio: {
          output: { voice: 'cedar' },
          input: { transcription: { model: 'gpt-4o-mini-transcribe' } }
        }
      }
    })
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`OpenAI token error: ${JSON.stringify(data)}`);
  // New API: top-level { value: "ek_...", expires_at: ... }
  const token = data.value || (data.client_secret && data.client_secret.value);
  if (!token) throw new Error(`No ephemeral token in response: ${JSON.stringify(data)}`);
  return { token, model: MODEL };
}

module.exports = { createEphemeralToken, MODEL };
