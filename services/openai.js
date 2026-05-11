const fetch = require('node-fetch');

const MODEL = 'gpt-realtime-2';

const SEARCH_TOOL = {
  type: 'function',
  name: 'search_case_file',
  description:
    'MANDATORY: Look up content from the case file before answering ANY factual question. ' +
    'Pass the user question verbatim as the query. Returns a JSON object: ' +
    '{ "snippets": [{id, page, text}], "refusal": null | "<exact words to speak>" }. ' +
    'If refusal is non-null you must speak exactly that string. ' +
    'If snippets contain only {id:"S0", text:"GREETING_ACK"} the user only greeted you.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: "The user's most recent question, verbatim, in their own language."
      }
    },
    required: ['query']
  }
};

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
        tools: [SEARCH_TOOL],         // Layer 1 — tool registered
        tool_choice: 'required',       // Layer 1 — must call before answering
        audio: {
          output: { voice: 'cedar' },
          input: { transcription: { model: 'gpt-4o-mini-transcribe' } }
        }
      }
    })
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`OpenAI token error: ${JSON.stringify(data)}`);
  const token = data.value || (data.client_secret && data.client_secret.value);
  if (!token) throw new Error(`No ephemeral token in response: ${JSON.stringify(data)}`);
  return { token, model: MODEL };
}

module.exports = { createEphemeralToken, MODEL };
