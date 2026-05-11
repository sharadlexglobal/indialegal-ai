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

from prompts import build_system_prompt

load_dotenv()
logging.basicConfig(level=logging.INFO)
log = logging.getLogger("indialegal-agent")

NODE_URL = os.environ.get("NODE_URL", "https://indialegal-ai.onrender.com")
IKAPI_MCP_URL = os.environ.get("IKAPI_MCP_URL", "https://ikapi.onrender.com/mcp")
HTTP_TIMEOUT = httpx.Timeout(30.0, connect=5.0)
IKAPI_TIMEOUT = httpx.Timeout(60.0, connect=5.0)


def parse_case_id(room_name: str) -> str | None:
    """Room name pattern: case-{id}-{nonce}"""
    m = re.match(r"case-(\d+)-", room_name or "")
    return m.group(1) if m else None


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
            tools=[make_search_tool(case_id), search_indian_kanoon],
        )


async def entrypoint(ctx: JobContext):
    await ctx.connect()
    room = ctx.room
    case_id = parse_case_id(room.name)
    log.info("Agent joined room=%s case_id=%s", room.name, case_id)

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
        turn_detection="stt",
        min_endpointing_delay=0.07,
    )

    await session.start(
        agent=LegalAgent(case_id, case_title, page_count),
        room=room,
    )


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
