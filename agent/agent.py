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
HTTP_TIMEOUT = httpx.Timeout(30.0, connect=5.0)


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
            tools=[make_search_tool(case_id)],
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
            model="gemini-2.5-flash",
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
