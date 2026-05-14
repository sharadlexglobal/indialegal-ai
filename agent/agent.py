"""INDIALEGAL.AI LiveKit voice agent.

Pipeline:
  Browser mic --> Sarvam Saaras v3 STT
              --> Gemini 2.5 Flash LLM (with strict 9-layer prompt
                   + search_case_file tool that hits the Node backend)
              --> Sarvam Bulbul v3 TTS (native Indian voice)
              --> Browser audio

The agent identifies the case by parsing the LiveKit room name, which
the Node backend encoded as `case-{id}-{nonce}` when it issued the JWT.
"""

import asyncio
import json
import logging
import os
import re
from typing import AsyncIterable

import httpx
from dotenv import load_dotenv
from livekit import agents, rtc
from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    ModelSettings,
    RunContext,
    WorkerOptions,
    cli,
    function_tool,
)
from livekit.plugins import google, sarvam, silero

from prompts import build_system_prompt, build_research_system_prompt

load_dotenv()
logging.basicConfig(level=logging.INFO)
log = logging.getLogger("indialegal-agent")

NODE_URL = os.environ.get("NODE_URL", "https://indialegal-ai.onrender.com")
IKAPI_MCP_URL = os.environ.get("IKAPI_MCP_URL", "https://ikapi.onrender.com/mcp")
HTTP_TIMEOUT = httpx.Timeout(30.0, connect=5.0)
IKAPI_TIMEOUT = httpx.Timeout(60.0, connect=5.0)

# Hold LLM text until ~10 lines (400 chars) accumulate before sending
# the first chunk to Sarvam Bulbul TTS. Sarvam warms up prosody per call,
# so tiny sentence-by-sentence chunks make the voice/accent drift mid-
# response. One big first chunk = one warmed-up synthesis = stable voice.
async def _buffered_text_stream(text: AsyncIterable[str]) -> AsyncIterable[str]:
    buf = ""
    flushed = False
    async for chunk in text:
        if not chunk:
            continue
        if flushed:
            yield chunk
            continue
        buf += chunk
        if len(buf) >= 400:
            yield buf
            buf = ""
            flushed = True
    if buf:
        yield buf


def parse_room(room_name: str) -> tuple[str, str | None]:
    """Returns (mode, case_id). Mode is 'case' or 'research'."""
    m = re.match(r"(case|research)-(\d+)-", room_name or "")
    if not m:
        return ("case", None)
    return (m.group(1), m.group(2))


async def fetch_case_meta(case_id: str) -> dict:
    """Pull case title + page count from the Node backend so we can stuff
    them into the system prompt."""
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as c:
        r = await c.get(f"{NODE_URL}/api/cases/{case_id}")
        r.raise_for_status()
        return r.json()


async def _watch_research_and_announce(session, case_id: str, job_id) -> None:
    """Background poller — after the agent kicks off legal research, we
    can't just go silent for 2-4 minutes. Poll the job's status every
    15 s; when it's `done`, ask the agent to SPEAK the summary so the
    user hears the result without having to prompt. Bounded to 15 min."""
    for _ in range(60):
        await asyncio.sleep(15)
        try:
            async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as c:
                r = await c.get(f"{NODE_URL}/api/cases/{case_id}/research/{job_id}")
                if r.status_code != 200:
                    continue
                data = r.json()
        except Exception as e:
            log.warning("watch-research: poll error %s", e)
            continue

        status = data.get("status")
        if status == "done":
            summary = (data.get("summary") or "Research ho gayi.").strip()
            log.info("[research %s] done — speaking summary", job_id)
            try:
                # Two-stage announce: a short heads-up then the actual
                # summary. Keeps the user from being startled by a long
                # block of TTS landing mid-silence.
                await session.say(
                    "Aapki research complete ho gayi.",
                    allow_interruptions=True,
                )
                await session.say(summary, allow_interruptions=True)
            except Exception as e:
                log.error("watch-research: session.say failed: %s", e)
            return
        if status == "failed":
            log.warning("[research %s] failed", job_id)
            try:
                await session.say(
                    "Research mein dikkat aa gayi. Dobara try karte hain?",
                    allow_interruptions=True,
                )
            except Exception:
                pass
            return
    log.warning("[research %s] watcher timed out after 15 min", job_id)


async def _ikapi_call(method: str, name: str, arguments: dict) -> dict:
    """Single helper for JSON-RPC calls to the IKAPI MCP server."""
    body = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": {"name": name, "arguments": arguments},
    }
    async with httpx.AsyncClient(timeout=IKAPI_TIMEOUT) as c:
        r = await c.post(
            IKAPI_MCP_URL,
            json=body,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
        )
        r.raise_for_status()
        return r.json()


@function_tool
async def search_indian_kanoon(
    context: RunContext,
    query: str,
    doctype: str | None = None,
) -> str:
    """Search Indian Kanoon for case law, statutes, sections, or precedents.

    Use this tool ONLY when the user's question is about Indian law OUTSIDE
    the uploaded case file — for example:
      - A named precedent ("Kesavananda Bharati", "Vishaka case")
      - A statutory section ("Section 482 CrPC", "Article 21")
      - A legal doctrine ("doctrine of basic structure", "anticipatory bail")
      - A general principle the user asks the AI to look up

    If the question is about content INSIDE the uploaded case file, use
    search_case_file instead — NOT this one.

    Args:
      query: Short search phrase, like "Section 482 CrPC inherent powers"
             or "Kesavananda Bharati basic structure".
      doctype: Optional. One of "supremecourt", "highcourts", "tribunals".
               Omit to search all.

    Returns a JSON string with this shape:
      {"results": [{"title": "...", "court": "...", "date": "...",
                    "citation": "...", "snippet": "..."}]}
    Cite each case naturally in speech: title, court, year.
    """
    try:
        args = {"query": query, "max_results": 5}
        if doctype:
            args["doctype"] = doctype
        data = await _ikapi_call("tools/call", "search_cases", args)
        if data.get("error"):
            log.warning("ikapi error: %s", data["error"])
            return json.dumps({"refusal": "Indian Kanoon abhi available nahi hai. Please thodi der baad try kariye."})
        content = data.get("result", {}).get("content", [])
        if not content:
            return json.dumps({
                "results": [],
                "refusal": "Indian Kanoon par is specific point ke liye koi clear judgment nahi mila. Scope thoda widen karenge?"
            })
        text = content[0].get("text") or ""
        try:
            payload = json.loads(text)
        except Exception:
            return json.dumps({"results": [{"raw": text[:500]}]})
        results = payload.get("results", []) or []
        cleaned = []
        for r in results[:5]:
            cleaned.append({
                "title": r.get("title"),
                "court": r.get("court"),
                "date": r.get("date") or r.get("judgment_date"),
                "citation": r.get("citation"),
                "snippet": (r.get("snippet") or "").strip()[:400],
            })
        if not cleaned:
            return json.dumps({
                "results": [],
                "refusal": "Indian Kanoon par is specific point ke liye koi clear judgment nahi mila. Scope thoda widen karenge?"
            })
        return json.dumps({"results": cleaned})
    except Exception as e:
        log.error("search_indian_kanoon error: %s", e)
        return json.dumps({"refusal": "Indian Kanoon abhi available nahi hai. Please thodi der baad try kariye."})


def make_lookup_tool(case_id: str):
    """Tool that hits /api/cases/:id/facts for an instant atomic answer
    from the Datalab-extracted case-sheet. ~10ms vs 5s for Gemini File
    Search. Cache the facts JSON for the agent's lifetime (one HTTP
    fetch per session)."""

    cache: dict = {}

    @function_tool
    async def lookup_case_fact(context: RunContext, field: str) -> str:
        """Instant lookup of an atomic fact from the case-sheet that was
        pre-extracted from the uploaded PDF at upload time. ALWAYS try
        this FIRST for any question about a single specific field of
        the case. Sub-second. If this returns null/empty, only THEN
        fall back to search_case_file.

        Args:
          field: exact spelling of one of these universal-atomic
            fields (extracted by Datalab from the uploaded PDF):

            Identity / signatures:
              document_type, document_title_or_heading, document_date,
              document_reference_number, issuing_authority,
              signatories, attesting_witnesses

            Parties:
              parties, petitioner, respondent,
              relationship_between_parties

            Court metadata:
              case_title, case_number, court, judge_or_bench,
              filing_date, next_hearing_date,
              advocate_for_petitioner, advocate_for_respondent

            Subject matter:
              subject_matter_summary, subject_matter_type,
              property_description, monetary_amounts_in_dispute

            Facts / incidents:
              facts_chronology, key_incidents, transactions

            Cause of action:
              cause_of_action_date, cause_of_action_description

            Evidence:
              documentary_evidence, oral_evidence_witnesses,
              specific_admissions, specific_denials

            Statute / precedent:
              sections, articles_invoked, rules_invoked,
              precedents_cited

            Prayers:
              main_prayers, interim_prayers, alternative_prayers

            Orders:
              order_outcome, operative_directions, costs_awarded,
              key_orders_or_holdings

            Agreement / deed atoms:
              consideration_amount, consideration_payment_mode,
              effective_date, termination_or_expiry_date,
              governing_law, jurisdiction_clause, arbitration_clause,
              key_obligations

            Will atoms:
              testator_name, beneficiaries, executor,
              specific_bequests

            Criminal / police atoms:
              fir_number, fir_date, police_station, offences_alleged,
              investigating_officer, accused_named, arrest_status,
              recoveries

            Notice / service atoms:
              notice_recipient, notice_demand, notice_compliance_period,
              notice_consequence_threatened, mode_of_service,
              postal_or_tracking_number

            Summaries:
              one_line_summary, detailed_summary

        Returns a JSON string. Possible shapes:
          {"field": "<name>", "value": "<the value>"}        // present
          {"field": "<name>", "value": null, "reason": "not in case-sheet"}

        Map the user's spoken question to one of the field names above.
        Examples (user → field):
          "judge kaun hai"               → "judge_or_bench"
          "kis court mein chal raha"     → "court"
          "petitioner kaun hai"          → "petitioner"
          "kis section mein hai"         → "sections"
          "case number kya hai"          → "case_number"
          "FIR kab hua tha"              → "fir_date"
          "agli sunwai kab hai"          → "next_hearing_date"
          "yeh case kya hai"             → "one_line_summary"
          "facts kya hain"               → "facts_chronology"
          "main prayer kya hai"          → "main_prayers"
          "kya evidence hai"             → "documentary_evidence"
          "consideration kitni thi"      → "consideration_amount"
          "witness kaun the"             → "oral_evidence_witnesses"
          "kya recover hua"              → "recoveries"
          "notice kis ko bheji"          → "notice_recipient"
          "arbitration clause hai kya"   → "arbitration_clause"
        """
        try:
            # V2: hit the segment-aware /fact endpoint which searches
            # across every sub-document for this field. Returns either
            # single value with source, or multi-segment value list.
            async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as c:
                r = await c.get(
                    f"{NODE_URL}/api/cases/{case_id}/fact",
                    params={"field": field}
                )
                if r.status_code == 200:
                    return r.text
            # If /fact endpoint isn't deployed, fall back to legacy
            # whole-case facts blob.
            if "facts" not in cache:
                async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as c:
                    r = await c.get(f"{NODE_URL}/api/cases/{case_id}/facts")
                    r.raise_for_status()
                    cache["facts"] = (r.json() or {}).get("facts") or {}
            facts = cache["facts"]
            if field not in facts:
                return json.dumps({
                    "field": field, "value": None,
                    "reason": "unknown field name"
                })
            val = facts.get(field)
            if val is None or val == "" or (isinstance(val, list) and not val):
                return json.dumps({
                    "field": field, "value": None,
                    "reason": "not in case-sheet"
                })
            return json.dumps({"field": field, "value": val})
        except Exception as e:
            log.error("lookup_case_fact error: %s", e)
            return json.dumps({"field": field, "value": None, "reason": "lookup failed"})

    return lookup_case_fact


def make_research_tools(case_id: str):
    """Tools specific to legal research sessions: kick off research,
    poll progress. Both round-trip through the Node backend so the
    actual IKAPI fan-out + Gemini indexing runs server-side."""

    @function_tool
    async def execute_legal_research(
        context: RunContext,
        keywords: str,
        court_code: str | None = None,
        sections: list[str] | None = None,
        principle: str | None = None,
        from_date: str | None = None,
        to_date: str | None = None,
        author: str | None = None,
        bench: str | None = None,
        max_results: int = 5,
    ) -> str:
        """Kick off the actual Indian Kanoon research + indexing.
        CALL THIS ONLY AFTER the user has explicitly approved your plan
        ('haan', 'shuru karo', 'go ahead', 'okay').

        Args:
          keywords: Main search phrase (e.g. "Section 482 CrPC quashing FIR").
          court_code: One of the EXACT COURT CODES from your system prompt.
              Examples: "supremecourt", "delhi" (Delhi HC), "delhidc"
              (Delhi District Courts), "bombay", "kerala", "itat", "cci".
              Use "judgments" if user didn't specify.
          sections: Optional list like ["482 CrPC", "439 CrPC"].
          principle: Optional principle/doctrine, e.g. "inherent powers".
          from_date: Optional earliest date in DD-MM-YYYY (e.g. "01-01-2023").
          to_date: Optional latest date in DD-MM-YYYY.
          author: Optional judge who authored the judgment.
          bench: Optional judge present on the bench.
          max_results: How many top judgments to fetch + index (default 5).

        Returns a JSON string: {"jobId": <int>, "status": "confirmed"}.
        After calling, say one short sentence that research is running
        in the background and that you'll let them know when done.
        """
        scope = {
            "keywords": keywords,
            "doctype": court_code,
            "sections": sections or [],
            "principle": principle,
            "from_date": from_date,
            "to_date": to_date,
            "author": author,
            "bench": bench,
            "max_results": max_results,
        }
        try:
            async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as c:
                r = await c.post(
                    f"{NODE_URL}/api/cases/{case_id}/start-research",
                    json={"scope": scope, "plan": keywords},
                )
                r.raise_for_status()
                body = r.json()

            # PROACTIVE ANNOUNCE — the original UX bug: after kicking off
            # research the agent went silent for the 2-4 minutes it took
            # to finish, and never told the user the result. Spawn a
            # background poller that wakes the agent up to speak the
            # summary as soon as `status == 'done'`.
            job_id = body.get("jobId")
            if job_id and context and getattr(context, "session", None):
                asyncio.create_task(
                    _watch_research_and_announce(context.session, case_id, job_id)
                )
            return json.dumps(body)
        except Exception as e:
            log.error("execute_legal_research error: %s", e)
            return json.dumps({"error": "could not start research, try again later"})

    @function_tool
    async def check_research_progress(context: RunContext) -> str:
        """Check status of the most recent research job for this case.
        Returns a JSON string with status and (if done) summary +
        judgment count. Speak the result in 1 sentence."""
        try:
            async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as c:
                r = await c.get(f"{NODE_URL}/api/cases/{case_id}/research")
                r.raise_for_status()
                jobs = r.json()
            if not jobs:
                return json.dumps({"status": "none"})
            latest = jobs[0]
            return json.dumps({
                "jobId": latest.get("id"),
                "status": latest.get("status"),
                "summary": latest.get("summary"),
                "judgment_count": latest.get("judgment_count") or 0,
            })
        except Exception as e:
            log.error("check_research_progress error: %s", e)
            return json.dumps({"status": "error"})

    return [execute_legal_research, check_research_progress]


def make_search_tool(case_id: str):
    """Returns a @function_tool bound to a specific case id so each room
    has its own search scope. The strict 9-layer logic lives server-side
    in /api/cases/:id/search — we just call it."""

    @function_tool
    async def search_case_file(context: RunContext, query: str) -> str:
        """MANDATORY before answering ANY factual question about the case.
        Pass the user's question verbatim. Returns a JSON string with
        one of these shapes:
          {"greeting": true}
          {"refusal": "..."}
          {"snippets": [{"page": N, "text": "..."}, ...]}
          {"snippets": [{"page": N, "pages": [...], "text": "..."}]}
        Use only the content within the returned JSON to answer."""
        try:
            async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as c:
                r = await c.post(
                    f"{NODE_URL}/api/cases/{case_id}/search",
                    json={"query": query},
                )
                r.raise_for_status()
                data = r.json()
        except Exception as e:
            log.error("search tool error: %s", e)
            return json.dumps({"refusal": "This is not stated in the file."})

        # Sanitize before handing to the LLM: strip internal `id` fields
        # (S1/SYN markers) and the GREETING_ACK literal, same as the
        # JS frontend did with the old OpenAI Realtime path. Otherwise
        # the model can read these tokens aloud.
        if data.get("refusal"):
            return json.dumps({"refusal": data["refusal"]})

        snippets = data.get("snippets") or []
        if any(s.get("text") == "GREETING_ACK" for s in snippets):
            return json.dumps({"greeting": True})

        clean = []
        for s in snippets:
            out = {"page": s.get("page"), "text": s.get("text")}
            pages = s.get("pages")
            if isinstance(pages, list) and len(pages) > 1:
                out["pages"] = pages
            clean.append(out)
        return json.dumps({"snippets": clean})

    return search_case_file


class _BufferedTTSMixin:
    """Buffer the first ~TTS_INITIAL_BUFFER_CHARS of every LLM response
    before handing to TTS, so Sarvam Bulbul's first synthesis call has
    enough text to lock in a stable voice/accent. Without this, LiveKit
    streams text sentence-by-sentence and each Sarvam call warms up
    independently — causing the audible accent shift mid-response."""

    async def tts_node(
        self,
        text: AsyncIterable[str],
        model_settings: ModelSettings,
    ) -> AsyncIterable[rtc.AudioFrame]:
        buffered = _buffered_text_stream(text)
        async for frame in Agent.default.tts_node(self, buffered, model_settings):
            yield frame


class LegalAgent(_BufferedTTSMixin, Agent):
    def __init__(self, case_id: str, case_title: str, page_count: int | None):
        super().__init__(
            instructions=build_system_prompt(case_title, page_count),
            tools=(
                # Same toolkit as research agent so the user can kick off
                # legal research from a document-mode session too
                # (e.g. "is case ke liye 482 quash ke 5 judgments index kar do").
                [make_lookup_tool(case_id),       # tier 1 — atomic facts
                 make_search_tool(case_id),       # tier 2 — case-file + indexed
                 search_indian_kanoon]            # tier 4 — narrow named-case
                + make_research_tools(case_id)    # tier 3+5 — execute + status
            ),
        )


class LegalResearchAgent(_BufferedTTSMixin, Agent):
    """Multi-turn research scoper. Different prompt (RESEARCH_RULES),
    different tools. Includes the case-sheet lookup so the agent can
    quickly check facts about the uploaded PDF during scoping
    ('what was the court of the original case?').
    Also includes search_case_file so after research is done, the
    user can ask about indexed judgments WITHOUT switching to Speak
    mode."""
    def __init__(self, case_id: str, case_title: str, page_count: int | None):
        super().__init__(
            instructions=build_research_system_prompt(case_title, page_count),
            tools=(
                make_research_tools(case_id)
                + [
                    make_lookup_tool(case_id),
                    make_search_tool(case_id),   # query indexed judgments after research
                    search_indian_kanoon,
                ]
            ),
        )


async def entrypoint(ctx: JobContext):
    await ctx.connect()
    room = ctx.room
    mode, case_id = parse_room(room.name)
    log.info("Agent joined room=%s mode=%s case_id=%s", room.name, mode, case_id)

    if not case_id:
        log.error("Could not parse case_id from room name %r", room.name)
        return

    try:
        meta = await fetch_case_meta(case_id)
        case_title = meta.get("title") or "Untitled case"
        page_count = meta.get("page_count")
    except Exception as e:
        log.error("Failed to fetch case meta for %s: %s", case_id, e)
        case_title = "Untitled case"
        page_count = None

    session = AgentSession(
        stt=sarvam.STT(
            model="saaras:v3",
            language="unknown",     # auto-detect across 11 Indian languages
            mode="transcribe",
            flush_signal=True,
        ),
        llm=google.LLM(
            model="gemini-3-flash-preview",
            temperature=0.1,
        ),
        tts=sarvam.TTS(
            target_language_code="hi-IN",   # default Hindi; switches per language detection on the LLM side
            model="bulbul:v3",
            speaker="shubh",
            pace=1.0,
            temperature=0.6,
        ),
        vad=silero.VAD.load(),
        # Hindi/Punjabi/Marathi mein natural pauses 200-300ms ke
        # hote hain shabdon ke beech. 70ms wala aggressive setting
        # STT-VAD ko fight kara raha tha — 400ms balanced hai.
        turn_detection="stt",
        min_endpointing_delay=0.4,
        min_interruption_duration=0.5,
    )

    agent = (
        LegalResearchAgent(case_id, case_title, page_count)
        if mode == "research"
        else LegalAgent(case_id, case_title, page_count)
    )
    await session.start(agent=agent, room=room)


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
