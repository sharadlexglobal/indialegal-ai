/**
 * Text-mode legal agent — full parity with the voice agent.
 *
 *   • Same Gemini 3 Flash LLM
 *   • Same five tools:
 *        lookup_case_fact, search_case_file, search_indian_kanoon,
 *        execute_legal_research, check_research_progress
 *   • Document mode  → TEXT_CORE_RULES (briefing focus)
 *   • Research mode  → TEXT_RESEARCH_RULES (Phase 1 scope → Phase 2 plan → Phase 3 execute)
 *
 * Both modalities persist to conversation_messages → unified thread.
 */

const fetch = require('node-fetch');
const gemini = require('./gemini');
const research = require('./research');

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL = 'gemini-3-flash-preview';

// ── Core rules (briefing / Q&A) ──────────────────────────────────────
const TEXT_CORE_RULES = `
You are answering an Indian advocate in writing. You have NO prior knowledge
of law, statutes, court procedure, or any fact. Every factual statement
you write must come from a tool result in THIS turn. Previous turns'
tool results are also invalid in this turn.

FIVE TOOLS — pick the right one for each user turn, in this order:

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

  TIER 2 — search_case_file(query)  ← DEFAULT FOR ANY LEGAL-SUBSTANCE QUESTION
      For complex / contextual / multi-fact questions about the uploaded
      case. ALSO for any question about indexed research judgments — the
      case's Gemini store contains every judgment we've indexed for THIS
      case, including landmark authorities. ALWAYS try this FIRST for
      any question about a case name, a section, a principle, or a
      holding, because if we have it indexed locally it returns grounded
      page-cited snippets that are 100% trustworthy and instant.

  TIER 3 — search_indian_kanoon(query, doctype?)  ← LAST RESORT
      Use ONLY when:
        (a) search_case_file returned refusal / empty snippets, OR
        (b) the user explicitly says "look up" / "search Indian Kanoon"
            / "search externally", OR
        (c) the user asks about a brand-new case/doctrine that clearly
            wouldn't be in our indexed set.

  TIER 4 — execute_legal_research(scope)  ← AGENTIC RESEARCH PIPELINE
      Use when the user wants you to GO AND FIND + INDEX a set of
      judgments — not just a quick ad-hoc snippet. Triggers the
      3-agent pipeline (DeepSeek soul-extract → IKAPI fetch → Agent 2
      reads full text → Agent 3 verdict → Gemini File Search index).
      Returns { jobId }. The UI will live-stream the timeline as
      verdicts come in.
      Examples of user phrasings that mean THIS tool:
        "Section 482 par top 5 SC judgments lao aur index kar"
        "Bring me 7 last-year matrimonial quash cases"
        "Research PMLA Section 19 written grounds — top 5"
      You MUST get a clear scope from the user (keywords, court, count)
      BEFORE calling — see RESEARCH-MODE flow below if unclear.

  TIER 5 — check_research_progress()
      Returns status of the most recent research job for this case.
      Use when the user asks "ho gaya?", "kitna time aur lagega?",
      "research kaha tak pahunchi?".

OUTPUT FORMAT (TEXT):
You may use Markdown lightly:
  • Short paragraphs (≤ 3 sentences)
  • Bullet lists when ≥ 3 parallel items
  • **bold** for case names and statutory provisions only
  • Inline citation format:  "[Page 4]" for case-file pages, or
    "[Pankaj Bansal, SC 2023]" for external judgments
  • No headings, no horizontal rules, no tables, no emoji

CITATIONS:
  • Every claim about the case file must end with [Page N].
  • Every claim about external law must name the case (Title, Court,
    Year) inline — drawn from search_indian_kanoon results only.

LANGUAGE:
Reply in the SAME LANGUAGE AND SCRIPT the user used.

CODE-MIX RULE — ABSOLUTE, NEVER VIOLATE:
When the user writes in Hindi (Devanagari OR Hinglish-Roman), Punjabi,
Marathi, Gujarati, Bengali, Tamil, or Telugu:
  • If user wrote Hindi in Roman/Latin (Hinglish), reply in Hinglish.
    NEVER convert to Devanagari.
  • If user wrote in Devanagari, reply in Devanagari prose with law-
    words still in Latin (see below).
  • Sentence structure in user's language; ALWAYS keep in English (Latin):
      - All numbers — sections, articles, page numbers, dates, years
      - Statutory labels — Section, Article, Order, Rule, Schedule
      - Act / Code names — IPC, CrPC, BNS, BNSS, BSA, NI Act, PMLA,
        Companies Act, Income Tax Act, Indian Evidence Act
      - Constitutional refs — Article 21, Article 14, etc.
      - Court names — Supreme Court, Delhi High Court, ITAT, NCDRC
      - English case names — Pankaj Bansal vs Union of India, etc.
      - Latin legal terms — mens rea, prima facie, ratio decidendi

Example (user wrote Hinglish — you reply Hinglish):
  ✅ "Bhajan Lal mein Supreme Court ne FIR quash karne ke seven
      categories layi thi. Pehli — agar allegations face value pe
      bhi accept karein toh koi offence nahi banta."
  ❌ "भजन लाल मामले में सुप्रीम कोर्ट ने एफ.आई.आर..."  (forbidden mid-Hinglish)

If user wrote pure English, reply in pure English.

NO HEDGING. No "I think", "shayad", "lagbhag", "probably", "generally".
NO PREAMBLE. Do not restate the question. Lead with the answer.

If the question cannot be fully answered from the tool result, write
only what is supported and add ONE sentence in user's language:
  Hindi:   "Iske aage ki baat is file mein nahi mili."
  English: "Beyond this, the file does not say more."
`.trim();

// ── Research mode (additional rules) ─────────────────────────────────
// Appended ON TOP of TEXT_CORE_RULES when caseKind === 'standalone_research'.
const TEXT_RESEARCH_RULES = `
══════════ RESEARCH-MODE FLOW (3 phases) ══════════

This is a research-only case — no uploaded PDF. The user's goal is
usually to find a focused set of judgments on a legal point and have
them indexed into THIS case for later querying.

PHASE 1 — SCOPING (back-and-forth)
  Decide what to research. If the user's first message already has a
  clear, complete scope (statute + provision + court + count), go
  straight to Phase 2. Otherwise ask ONE short clarifying question at
  a time (≤ 2 sentences). Capture:
    • legal issue / principle / section
    • court — see EXACT COURT CODES below
    • date range (optional)
    • how many judgments (default 5)
    • optional: judge name, named-case anchor

  During scoping you MAY call search_indian_kanoon for a preview, OR
  search_case_file to check what we already have indexed. Do NOT call
  execute_legal_research yet.

  ────── EXACT COURT CODES (use these for scope.doctype) ──────
    Aggregators: supremecourt, highcourts, tribunals, judgments
    HCs: delhi, bombay, kolkata, chennai, allahabad, andhra,
         chattisgarh, gauhati, jammu, srinagar, kerala, lucknow,
         orissa, uttaranchal, gujarat, himachal_pradesh, jharkhand,
         karnataka, madhyapradesh, patna, punjab, rajasthan,
         jodhpur, sikkim, meghalaya
    District: delhidc
    Tribunals: itat, cci, consumer, cat, cic, drat, sebisat,
               greentribunal, aptel
    If unsure, use "judgments".

PHASE 2 — PLAN + PERMISSION
  When you have enough scope, summarise the plan in 2-3 sentences and
  ASK for confirmation. Example:
    "Theek hai. Main Section 482 CrPC pe last 2 saal ke top 5 SC
     judgments dhund-ke unko 3-agent verification se filter karke
     index kar dunga. Shuru karu?"
  Then STOP. Do NOT call any tool. Wait for user's yes/no.

PHASE 3 — EXECUTE
  Only after the user clearly approves ("haan", "shuru karo", "go
  ahead", "okay", "haan ji", "kar lo", "yes"), call:
    execute_legal_research({
      keywords: "...",            ← required
      court_code: "...",          ← from court codes above
      sections: ["482 CrPC", ...] ← optional
      principle: "..."            ← optional
      from_date: "DD-MM-YYYY",    ← optional
      to_date: "DD-MM-YYYY",      ← optional
      max_results: 5              ← default 5; cap 8
    })
  After the tool returns, write ONE short sentence in user's language:
    "Background mein shuru kar diya. Live timeline neeche aa raha hai
     — APPLICABLE judgments verbatim paragraphs ke saath dikhenge."
  Do NOT call execute_legal_research again in the same session.

POST-RESEARCH
  Once the research is done, user may ask follow-up questions about
  the indexed judgments. Use search_case_file for those — the indexed
  judgments are in this case's Gemini store. NEVER answer from memory.
`.trim();

function buildSystemPrompt(caseTitle, pageCount, caseKind) {
  const isResearch = caseKind === 'standalone_research';
  const header = isResearch
    ? `RESEARCH SESSION: ${caseTitle}\n` +
      `No uploaded PDF — lookup_case_fact returns null for every field\n` +
      `(that is NORMAL, not an error).\n`
    : `CASE: ${caseTitle}\nTOTAL PAGES: ${pageCount || 'unknown'}\n`;
  const body = isResearch
    ? `${TEXT_CORE_RULES}\n\n${TEXT_RESEARCH_RULES}`
    : TEXT_CORE_RULES;
  // 3x verbatim repetition for the core rules
  return `${header}\n\n${body}\n\n${body}\n\n${body}`;
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
      'judgments. Returns grounded snippets with page numbers.',
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
      'External case-law search across Indian Kanoon. Use ONLY as a last ' +
      'resort after search_case_file, or for named precedents the user ' +
      'explicitly asks to look up.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING' },
        doctype: {
          type: 'STRING',
          description:
            'Optional court filter: supremecourt | highcourts | tribunals | ' +
            'delhi | bombay | kerala | etc. Omit to search all.'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'execute_legal_research',
    description:
      'Kick off the 3-agent research pipeline (soul-extract → IKAPI fetch → ' +
      'Agent 2 read full text → Agent 3 verdict → Gemini index). Triggers a ' +
      'background job. CALL ONLY AFTER user has approved your plan.',
    parameters: {
      type: 'OBJECT',
      properties: {
        keywords: { type: 'STRING', description: 'Main search phrase, e.g. "Section 482 CrPC quash FIR"' },
        court_code: { type: 'STRING', description: 'EXACT court code, e.g. "supremecourt", "delhi", "delhidc". Use "judgments" if unsure.' },
        sections: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Optional list of section refs, e.g. ["482 CrPC"]' },
        principle: { type: 'STRING', description: 'Optional legal principle / doctrine' },
        from_date: { type: 'STRING', description: 'Optional earliest date DD-MM-YYYY' },
        to_date: { type: 'STRING', description: 'Optional latest date DD-MM-YYYY' },
        author: { type: 'STRING', description: 'Optional authoring judge' },
        bench: { type: 'STRING', description: 'Optional bench judge' },
        max_results: { type: 'INTEGER', description: 'Default 5, max 8' }
      },
      required: ['keywords']
    }
  },
  {
    name: 'check_research_progress',
    description: 'Check status of most recent research job for this case.',
    parameters: { type: 'OBJECT', properties: {} }
  }
];

// ── In-process tool implementations ──────────────────────────────────

async function toolLookupCaseFact(_ctx, args) {
  const { pool, caseId } = _ctx;
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

async function toolSearchCaseFile(_ctx, args) {
  const { pool, caseId } = _ctx;
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
async function toolSearchIndianKanoon(_ctx, args) {
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
    const strip = (s) => String(s || '')
      .replace(/<\/?b>/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    const results = (payload.results || []).slice(0, 5).map(x => ({
      title: strip(x.title), court: strip(x.court),
      date: x.date || x.judgment_date,
      citation: x.citation, snippet: strip(x.snippet).slice(0, 400)
    }));
    return { results };
  } catch (e) {
    return { results: [], error: e.message };
  }
}

// Kicks off the 3-agent research pipeline as a background job. Returns
// { jobId } immediately. The SSE topic `research:<jobId>` will fire
// real-time events that the frontend renders inline in the thread.
//
// Also emits a `research_started` event on the CHAT topic so the
// frontend can call attachResearchBlock(jobId) without waiting for
// the agent's final text.
async function toolExecuteLegalResearch(_ctx, args) {
  const { pool, caseId, emit } = _ctx;
  // Verify case is ready (has store)
  const cr = await pool.query(`SELECT gemini_store_name FROM cases WHERE id=$1`, [caseId]);
  if (!cr.rows.length || !cr.rows[0].gemini_store_name) {
    return { error: 'case not ready (no Gemini store)' };
  }

  const scope = {
    keywords: args.keywords,
    doctype: args.court_code,
    sections: args.sections || [],
    principle: args.principle,
    from_date: args.from_date,
    to_date: args.to_date,
    author: args.author,
    bench: args.bench,
    max_results: Math.max(1, Math.min(args.max_results ?? 5, 8))
  };
  const plan = args.principle
    ? `${args.keywords} — ${args.principle}`
    : args.keywords;

  const ins = await pool.query(
    `INSERT INTO research_jobs (case_id, scope, plan, status)
       VALUES ($1, $2, $3, 'confirmed') RETURNING id`,
    [caseId, scope, plan]
  );
  const jobId = ins.rows[0].id;

  // fire-and-forget background work — research.js emits SSE on
  // `research:<jobId>` topic; UI subscribes via attachResearchBlock.
  research.runResearch(pool, jobId).catch(async (e) => {
    console.error(`[research ${jobId}] crashed:`, e);
    await pool.query(
      `UPDATE research_jobs SET status='failed', error=$1, updated_at=NOW() WHERE id=$2`,
      [String(e.message || e), jobId]
    );
  });

  // Tell the chat SSE consumer that a research job has begun, so it can
  // attach the live timeline block to the thread immediately (before
  // the agent's final text arrives).
  if (emit) emit('research_started', { jobId: String(jobId) });

  return { jobId: String(jobId), status: 'confirmed', scope };
}

async function toolCheckResearchProgress(_ctx) {
  const { pool, caseId } = _ctx;
  const r = await pool.query(
    `SELECT id, status, summary,
            jsonb_array_length(COALESCE(judgments, '[]'::jsonb)) AS judgment_count
       FROM research_jobs WHERE case_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [caseId]
  );
  if (!r.rows.length) return { status: 'none' };
  const j = r.rows[0];
  return {
    jobId: String(j.id),
    status: j.status,
    summary: j.summary,
    judgment_count: j.judgment_count || 0
  };
}

const TOOL_IMPLS = {
  lookup_case_fact:        toolLookupCaseFact,
  search_case_file:        toolSearchCaseFile,
  search_indian_kanoon:    toolSearchIndianKanoon,
  execute_legal_research:  toolExecuteLegalResearch,
  check_research_progress: toolCheckResearchProgress
};

// ── Gemini call helper ──────────────────────────────────────────────

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

async function runTurn({ pool, caseId, userText, history, emit }) {
  const cr = await pool.query(
    `SELECT title, page_count, kind FROM cases WHERE id=$1`,
    [caseId]
  );
  if (!cr.rows.length) throw new Error('case not found');
  const caseMeta = cr.rows[0];
  const sys = buildSystemPrompt(
    caseMeta.title || 'Untitled', caseMeta.page_count, caseMeta.kind
  );

  const contents = [];
  for (const m of (history || [])) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    });
  }
  contents.push({ role: 'user', parts: [{ text: userText }] });

  // Shared context passed to every tool impl
  const toolCtx = { pool, caseId, emit };

  const toolCalls = [];
  for (let round = 0; round < 4; round++) {
    const j = await callGemini(sys, contents);
    const cand = j.candidates?.[0];
    if (!cand) throw new Error('Gemini returned no candidate');
    const parts = cand.content?.parts || [];

    const fnCalls = parts.filter(p => p.functionCall).map(p => p.functionCall);
    const textParts = parts.filter(p => typeof p.text === 'string' && p.text.length)
      .map(p => p.text);

    if (fnCalls.length === 0) {
      const finalText = textParts.join('\n').trim();
      emit('final', { text: finalText });
      return { text: finalText, tool_calls: toolCalls };
    }

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
          result = await impl(toolCtx, args);
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
