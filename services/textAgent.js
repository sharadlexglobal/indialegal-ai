/**
 * Text-mode legal agent.
 *
 * Mirror of the LiveKit voice agent (agent/agent.py) but text-in / text-out:
 *   • Same Gemini 3 Flash LLM
 *   • Same three tools (lookup_case_fact, search_case_file, search_indian_kanoon)
 *   • Same system prompt — ported from agent/prompts.py to TEXT_CORE_RULES below
 *
 * Why a separate Node-side implementation:
 *   • Voice agent runs in Python (LiveKit Worker) — text agent runs in the
 *     same Node process as the rest of the API → zero IPC, in-process tools.
 *   • Both agents persist to conversation_messages so the user's thread is
 *     unified regardless of input modality.
 */

const fetch = require('node-fetch');
const gemini = require('./gemini');

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL = 'gemini-2.5-flash';   // text agent uses stable 2.5; voice uses 3-flash-preview

// ── System prompt (text variant — same spirit as agent/prompts.py) ───
// The text variant trims voice-only rhythm instructions (LISTEN-COMPOSE-
// SPEAK becomes irrelevant when typing). Everything else identical.
const TEXT_CORE_RULES = `
You are answering an Indian advocate in writing. You have NO prior knowledge
of law, statutes, court procedure, or any fact. Every factual statement
you write must come from a tool result in THIS turn. Previous turns'
tool results are also invalid in this turn.

THREE TOOLS — pick the right one for each user turn, in this order:

  TIER 1 — lookup_case_fact(field)
      FIRST CHOICE for atomic questions about the uploaded case that map
      to a single field. ~10ms.
      Fields: document_type, case_title, case_number, court, judge,
      filing_date, fir_number, fir_date, police_station, petitioner,
      respondent, advocate_for_petitioner, advocate_for_respondent,
      sections, prayer, next_hearing_date, key_orders_or_holdings,
      one_line_summary.
      If lookup returns value=null with any reason, IMMEDIATELY call
      search_case_file in the same turn with the user's original
      question. That is the mandatory fallback.

  TIER 2 — search_case_file(query)
      For complex / contextual / multi-fact questions about the uploaded
      case. Also for any question about indexed research judgments (the
      case's Gemini store holds them after research completes).

  TIER 3 — search_indian_kanoon(query, doctype?)
      ONLY for questions about Indian law OUTSIDE the uploaded file —
      a named precedent, a section by number, a doctrine in general,
      or an explicit instruction to look up case law.

OUTPUT FORMAT (TEXT):
You may use Markdown lightly:
  • Short paragraphs (≤ 3 sentences)
  • Bullet lists when ≥ 3 parallel items
  • **bold** for case names and statutory provisions only
  • Inline citation format:  "[Page 4]" for case-file pages, or
    "[Pankaj Bansal, SC 2023]" for external judgments
  • No headings, no horizontal rules, no tables
  • No emoji

CITATIONS:
  • Every claim about the case file must end with [Page N] referencing
    the printed page returned by the tool.
  • Every claim about external law must name the case (Title, Court,
    Year) inline — drawn from search_indian_kanoon results only.

LANGUAGE:
Detect the language of the user's most recent message and reply in
that language. Switch turn by turn if they switch.

CODE-MIX RULE (CRITICAL — when replying in Hindi/Punjabi/Marathi/etc.):
Sentence structure in the user's language, but ALWAYS keep in English:
  • All numbers — sections, articles, page numbers, dates, years
  • Statutory labels — Section, Article, Order, Rule
  • Act / Code names — IPC, CrPC, BNS, BNSS, NI Act, PMLA, Constitution
  • Court names — Supreme Court, Delhi High Court, ITAT
  • Case names — written as in the original
  • Latin legal terms — mens rea, prima facie, ratio decidendi

NO HEDGING. No "I think", "shayad", "lagbhag", "probably", "generally".
If a sentence would need a hedge, do not write it.

NO PREAMBLE. Do not restate the question. Do not say "Sure, ..." / "Of
course, ...". Lead with the answer.

If the question cannot be fully answered from the tool result, write
only what is supported and add ONE sentence in the user's language:
  Hindi:   "Iske aage ki baat is file mein nahi mili."
  English: "Beyond this, the file does not say more."
`.trim();

function buildSystemPrompt(caseTitle, pageCount, caseKind) {
  const header =
    caseKind === 'standalone_research'
      ? `RESEARCH SESSION: ${caseTitle}\n` +
        `This is a research-only case (no uploaded PDF). lookup_case_fact will\n` +
        `return null for every field — that is normal. For any question, use\n` +
        `search_case_file (indexed judgments) or search_indian_kanoon.\n`
      : `CASE: ${caseTitle}\nTOTAL PAGES: ${pageCount || 'unknown'}\n`;
  // Verbatim 3x repetition, matching the voice agent's discipline
  return `${header}\n\n${TEXT_CORE_RULES}\n\n${TEXT_CORE_RULES}\n\n${TEXT_CORE_RULES}`;
}

// ── Function declarations for Gemini ─────────────────────────────────

const FUNCTION_DECLS = [
  {
    name: 'lookup_case_fact',
    description:
      'Instant lookup of ONE atomic field from the pre-extracted case-sheet. ' +
      'Use FIRST for any atomic question. ~10ms. If value=null, fall back to search_case_file.',
    parameters: {
      type: 'OBJECT',
      properties: {
        field: {
          type: 'STRING',
          description:
            'One of: document_type, case_title, case_number, court, judge, ' +
            'filing_date, fir_number, fir_date, police_station, petitioner, ' +
            'respondent, advocate_for_petitioner, advocate_for_respondent, ' +
            'sections, prayer, next_hearing_date, key_orders_or_holdings, ' +
            'one_line_summary'
        }
      },
      required: ['field']
    }
  },
  {
    name: 'search_case_file',
    description:
      'Semantic search through the uploaded case PDF AND any indexed research ' +
      'judgments. Returns grounded snippets with page numbers. Use for complex ' +
      'or multi-fact questions about the case file.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: "The user's question, verbatim." }
      },
      required: ['query']
    }
  },
  {
    name: 'search_indian_kanoon',
    description:
      'External case-law search across Indian Kanoon. Use ONLY for named ' +
      'precedents, statutory sections, doctrines, or explicit lookups outside ' +
      'the case file.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING' },
        doctype: {
          type: 'STRING',
          description:
            'Optional court filter: supremecourt | highcourts | tribunals | ' +
            'delhi | bombay | kerala | ... Omit to search all.'
        }
      },
      required: ['query']
    }
  }
];

// ── In-process tool implementations ──────────────────────────────────

async function toolLookupCaseFact(pool, caseId, args) {
  const field = String(args.field || '').trim();
  const r = await pool.query(`SELECT facts FROM cases WHERE id=$1`, [caseId]);
  if (!r.rows.length) return { field, value: null, reason: 'case not found' };
  const facts = r.rows[0].facts || {};
  if (!(field in facts)) return { field, value: null, reason: 'unknown field name' };
  const val = facts[field];
  if (val == null || val === '' || (Array.isArray(val) && val.length === 0)) {
    return { field, value: null, reason: 'not in case-sheet' };
  }
  return { field, value: val };
}

async function toolSearchCaseFile(pool, caseId, args) {
  const query = String(args.query || '').trim().slice(0, 800);
  if (!query) return { refusal: 'empty query' };
  const r = await pool.query(
    `SELECT gemini_store_name, ocr_markdown, page_map FROM cases WHERE id=$1`,
    [caseId]
  );
  if (!r.rows.length || !r.rows[0].gemini_store_name) {
    return { refusal: 'case file not yet indexed' };
  }
  try {
    const result = await gemini.searchForRealtime(
      r.rows[0].gemini_store_name,
      query,
      r.rows[0].ocr_markdown,
      r.rows[0].page_map
    );
    if (result.refusal) return { refusal: result.refusal };
    if (result.greeting) return { greeting: true };
    return { snippets: (result.snippets || []).map(s => ({
      page: s.page, pages: s.pages, text: (s.text || '').slice(0, 2000)
    })) };
  } catch (e) {
    return { refusal: 'search failed', error: e.message };
  }
}

const IKAPI_MCP_URL = process.env.IKAPI_MCP_URL || 'https://ikapi.onrender.com/mcp';
async function toolSearchIndianKanoon(_pool, _caseId, args) {
  const body = {
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: {
      name: 'search_cases',
      arguments: {
        query: String(args.query || '').slice(0, 300),
        doctype: args.doctype || undefined,
        max_results: 5
      }
    }
  };
  try {
    const r = await fetch(IKAPI_MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    const text = j.result?.content?.[0]?.text || '';
    let payload;
    try { payload = JSON.parse(text); } catch { return { results: [], raw: text.slice(0, 400) }; }
    const results = (payload.results || []).slice(0, 5).map(x => ({
      title: x.title, court: x.court, date: x.date || x.judgment_date,
      citation: x.citation, snippet: (x.snippet || '').slice(0, 400)
    }));
    return { results };
  } catch (e) {
    return { results: [], error: e.message };
  }
}

const TOOL_IMPLS = {
  lookup_case_fact: toolLookupCaseFact,
  search_case_file: toolSearchCaseFile,
  search_indian_kanoon: toolSearchIndianKanoon
};

// ── Gemini call helpers ──────────────────────────────────────────────

async function callGemini(systemPrompt, contents) {
  const res = await fetch(
    `${GEMINI_URL}/models/${MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        tools: [{ functionDeclarations: FUNCTION_DECLS }],
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
        generationConfig: {
          temperature: 0.1,
          thinkingConfig: { thinkingBudget: 0 }
        }
      })
    }
  );
  const j = await res.json();
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

// ── Public: runTurn ──────────────────────────────────────────────────
//
//   pool        — pg pool
//   caseId      — case id (uploaded doc OR standalone_research)
//   userText    — the user's typed message
//   history     — [{role, content}] previous turns, oldest first
//   emit        — (event, data) => void  (drains to the SSE topic)
//
// Returns { text, tool_calls } once final text is produced.

async function runTurn({ pool, caseId, userText, history, emit }) {
  // Load case meta for prompt header
  const cr = await pool.query(
    `SELECT title, page_count, kind FROM cases WHERE id=$1`,
    [caseId]
  );
  if (!cr.rows.length) throw new Error('case not found');
  const caseMeta = cr.rows[0];
  const sys = buildSystemPrompt(
    caseMeta.title || 'Untitled', caseMeta.page_count, caseMeta.kind
  );

  // Build Gemini contents from history + current user turn
  const contents = [];
  for (const m of (history || [])) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    });
  }
  contents.push({ role: 'user', parts: [{ text: userText }] });

  const toolCalls = [];
  // Safety cap — 4 tool rounds is way more than legitimate flow needs
  for (let round = 0; round < 4; round++) {
    const j = await callGemini(sys, contents);
    const cand = j.candidates?.[0];
    if (!cand) throw new Error('Gemini returned no candidate');
    const parts = cand.content?.parts || [];

    // Pull out function calls and text parts
    const fnCalls = parts.filter(p => p.functionCall).map(p => p.functionCall);
    const textParts = parts.filter(p => typeof p.text === 'string' && p.text.length)
      .map(p => p.text);

    if (fnCalls.length === 0) {
      // Final answer
      const finalText = textParts.join('\n').trim();
      emit('final', { text: finalText });
      return { text: finalText, tool_calls: toolCalls };
    }

    // We have tool calls — append model turn AND execute each in parallel
    contents.push({ role: 'model', parts });

    const responses = await Promise.all(fnCalls.map(async (fc) => {
      const impl = TOOL_IMPLS[fc.name];
      const args = fc.args || {};
      emit('tool_call', { name: fc.name, args });
      let result;
      if (!impl) {
        result = { error: `unknown tool: ${fc.name}` };
      } else {
        try {
          result = await impl(pool, caseId, args);
        } catch (e) {
          result = { error: e.message };
        }
      }
      emit('tool_result', { name: fc.name, args, result });
      toolCalls.push({ name: fc.name, args, result });
      return {
        functionResponse: { name: fc.name, response: { content: result } }
      };
    }));

    contents.push({ role: 'user', parts: responses });
  }

  emit('failed', { reason: 'tool-loop budget exceeded' });
  return { text: 'Sorry — could not produce an answer in budget.', tool_calls: toolCalls };
}

module.exports = { runTurn };
