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

import httpx
from dotenv import load_dotenv
from livekit import agents
from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
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
            return json.dumps({"results": []})
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
          field: one of these field names (exact spelling):
            "document_type", "case_title", "case_number",
            "court", "judge", "filing_date",
            "fir_number", "fir_date", "police_station",
            "petitioner", "respondent",
            "advocate_for_petitioner", "advocate_for_respondent",
            "sections", "prayer", "next_hearing_date",
            "key_orders_or_holdings", "one_line_summary"

        Returns a JSON string. Possible shapes:
          {"field": "<name>", "value": "<the value>"}        // present
          {"field": "<name>", "value": null, "reason": "not in case-sheet"}

        Map the user's spoken question to one of the field names above.
        Examples (user → field):
          "judge kaun hai"           → "judge"
          "kis court mein chal raha" → "court"
          "petitioner kaun hai"      → "petitioner"
          "kis section mein hai"     → "sections"
          "case number kya hai"      → "case_number"
          "FIR kab hua tha"          → "fir_date"
          "agli sunwai kab hai"      → "next_hearing_date"
          "yeh case kya hai"         → "one_line_summary"
        """
        try:
            if "facts" not in cache:
                async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as c:
                    r = await c.get(f"{NODE_URL}/api/cases/{case_id}/facts")
                    r.raise_for_status()
                    cache["facts"] = (r.json() or {}).get("facts") or {}
            facts = cache["facts"]
            if field not in facts:
                return json.dumps({
                    "field": field,
                    "value": None,
                    "reason": "unknown field name"
                })
            val = facts.get(field)
            if val is None or val == "" or (isinstance(val, list) and not val):
                return json.dumps({
                    "field": field,
                    "value": None,
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
                return r.text
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


class LegalAgent(Agent):
    def __init__(self, case_id: str, case_title: str, page_count: int | None):
        super().__init__(
            instructions=build_system_prompt(case_title, page_count),
            tools=[
                make_lookup_tool(case_id),       # 1st-tier: instant case-sheet
                make_search_tool(case_id),       # 2nd-tier: Gemini File Search
                search_indian_kanoon,            # 3rd-tier: external law
            ],
        )


class LegalResearchAgent(Agent):
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
