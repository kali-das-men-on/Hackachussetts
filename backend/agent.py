"""Report-triage agent.

Takes a report's photo, description, voice note and location and returns the
`ai` block of the report schema, including a severity_score from 0 to 100.

    from agent import run_agent
    ai = run_agent(photo_bytes=..., photo_mime="image/jpeg", description="...",
                   lat=42.39, lng=-72.52, address="...", audio=..., audio_format="webm")

How it works:
  1. A voice note (if any) is turned into text with OpenRouter's speech-to-text
     endpoint, because the chat model only accepts text and images.
  2. Whether the coordinates fall inside the service area is computed here, in
     code, and handed to the model as a fact.
  3. LangChain's ChatOpenRouter is called with the photo + text and must answer
     in the AgentOutput structure (prompts.py holds the instructions).
  4. The answer is cleaned up: score clamped to 0-100, `valid` computed from the
     three checks, `evidence` limited to sources that were really available.
"""
import base64
import os
from datetime import datetime, timezone
from typing import Literal

import httpx
from pydantic import BaseModel, Field

from prompts import CATEGORIES, DEPARTMENTS, SERVICE_AREA, SYSTEM_PROMPT, TAXONOMY_VERSION

MODEL = os.getenv("OPENROUTER_MODEL", "openai/gpt-6-luna")
STT_MODEL = os.getenv("OPENROUTER_STT_MODEL", "mistralai/voxtral-mini-transcribe-3-0")
OPENROUTER_URL = "https://openrouter.ai/api/v1"

Category = Literal[tuple(CATEGORIES)]
Department = Literal[tuple(DEPARTMENTS)]
Source = Literal["photo", "description", "audio", "location"]


class ValidChecks(BaseModel):
    photo_shows_issue: bool
    in_service_area: bool
    in_scope: bool


class AgentOutput(BaseModel):
    """What the model must return."""

    valid_checks: ValidChecks
    valid_reason: str
    evidence: list[Source]
    category: Category
    category_reason: str
    department: Department
    department_reason: str
    severity_score: int = Field(ge=0, le=100, description="0 = trivial, 100 = severe or imminent danger")
    severity_reason: str
    summary: str


class AgentError(Exception):
    pass


def _api_key() -> str:
    return os.getenv("OPENROUTER_API_KEY", "")


# ---------- helpers ----------
def in_service_area(lat, lng):
    """True / False from the coordinates, or None when there are none."""
    if lat is None or lng is None:
        return None
    south, west, north, east = SERVICE_AREA["bbox"]
    return south <= lat <= north and west <= lng <= east


def transcribe(audio: bytes, audio_format: str) -> str | None:
    """Voice note -> text via OpenRouter speech-to-text. None if it fails."""
    if not audio or not _api_key():
        return None
    try:
        r = httpx.post(
            f"{OPENROUTER_URL}/audio/transcriptions",
            headers={"Authorization": f"Bearer {_api_key()}"},
            json={
                "model": STT_MODEL,
                "input_audio": {"data": base64.b64encode(audio).decode(), "format": audio_format},
            },
            timeout=60,
        )
        r.raise_for_status()
        return (r.json().get("text") or "").strip() or None
    except Exception as e:
        print("Transcription failed:", e)
        return None


def _safe(text: str | None) -> str:
    """Report text is untrusted: stop it from closing or opening our tags."""
    return (text or "").replace("<", "&lt;").replace(">", "&gt;").strip() or "none provided"


def _build_messages(*, description, transcript, lat, lng, accuracy_m, location_source, address,
                    category, area, photo_bytes, photo_mime):
    from langchain_core.messages import HumanMessage, SystemMessage

    has_point = lat is not None and lng is not None
    where = f"address: {_safe(address)}"
    if has_point:
        acc = f", accuracy about {round(accuracy_m)} m" if accuracy_m is not None else ""
        where += f"; coordinates: {lat:.5f}, {lng:.5f}{acc}; source: {location_source or 'unknown'}"
    area_text = {True: "INSIDE", False: "OUTSIDE", None: "UNKNOWN (no coordinates given)"}[area]

    text = (
        f"<description>{_safe(description)}</description>\n"
        f"<voice_note_transcript>{_safe(transcript)}</voice_note_transcript>\n"
        f"<location>{where}</location>\n"
        f"service_area_check ({SERVICE_AREA['name']}): {area_text}\n"
        f"reporter_chosen_category: {category or 'none'}"
    )
    image_url = f"data:{photo_mime};base64,{base64.b64encode(photo_bytes).decode()}"
    return [
        SystemMessage(content=SYSTEM_PROMPT),
        HumanMessage(content=[
            {"type": "text", "text": text},
            {"type": "image_url", "image_url": {"url": image_url}},
        ]),
    ]


def _default_llm():
    from langchain_openrouter import ChatOpenRouter

    return ChatOpenRouter(model=MODEL, api_key=_api_key(), temperature=0)


# ---------- main entry point ----------
def run_agent(*, photo_bytes: bytes, photo_mime: str = "image/jpeg", description=None,
              audio: bytes | None = None, audio_format: str | None = None,
              lat=None, lng=None, accuracy_m=None, location_source=None, address=None,
              category=None, llm=None, transcript=None) -> dict:
    """Analyze one report. Returns the report's `ai` block. Raises AgentError on failure."""
    if llm is None and not _api_key():
        raise AgentError("OPENROUTER_API_KEY is not set")

    if transcript is None and audio:
        transcript = transcribe(audio, audio_format or "webm")
    area = in_service_area(lat, lng)

    messages = _build_messages(
        description=description, transcript=transcript, lat=lat, lng=lng, accuracy_m=accuracy_m,
        location_source=location_source, address=address, category=category, area=area,
        photo_bytes=photo_bytes, photo_mime=photo_mime,
    )

    out = None
    last_error = None
    for _ in range(2):  # one retry if the model returns something unparseable
        try:
            model = (llm or _default_llm()).with_structured_output(AgentOutput)
            out = model.invoke(messages)
            if isinstance(out, dict):
                out = AgentOutput.model_validate(out)
            if out is not None:
                break
        except Exception as e:
            last_error = e
    if out is None:
        raise AgentError(f"model call failed: {type(last_error).__name__}: {str(last_error)[:300]}")

    checks = out.valid_checks.model_dump()
    if area is not None:  # the coordinate check in code beats the model's guess
        checks["in_service_area"] = area

    available = {
        "photo": True,
        "description": bool((description or "").strip()),
        "audio": bool(transcript),
        "location": bool((address or "").strip()) or (lat is not None and lng is not None),
    }
    evidence = [s for s in dict.fromkeys(out.evidence) if available[s]]

    return {
        "processed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "model": MODEL,
        "taxonomy_version": TAXONOMY_VERSION,
        "valid": all(checks.values()),
        "valid_checks": checks,
        "valid_reason": out.valid_reason.strip(),
        "evidence": evidence,
        "category": out.category,
        "category_reason": out.category_reason.strip(),
        "department": out.department,
        "department_reason": out.department_reason.strip(),
        "severity_score": max(0, min(100, int(out.severity_score))),
        "severity_reason": out.severity_reason.strip(),
        "summary": out.summary.strip()[:300],
    }
