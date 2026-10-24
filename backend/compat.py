"""Backend-only compatibility routes for the existing frontend.

The frontend has three views: resident submission, public issues/lookup, and a
small government dashboard. The original Node server exposed these routes; this
router gives the FastAPI/Supabase backend the same contract without changing any
frontend files.
"""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Cookie, HTTPException, Query, Request
from fastapi.responses import JSONResponse, RedirectResponse, Response
from pydantic import BaseModel

import main
from prompts import DEPARTMENT_OF

# Legacy compatibility values expected by the unchanged dashboard.
LEGACY_CATEGORIES = {
    "pothole": {"serious": "Road defect on a public way.", "target": "Review within 1 business day"},
    "sidewalk": {"serious": "Sidewalk and accessibility hazards need prompt review.", "target": "Make safe promptly"},
    "streetlight": {"serious": "Dark crossings, bus stops and school routes come first.", "target": "Review within 10 business days"},
    "trash": {"serious": "Dumping and sanitation hazards can require urgent collection.", "target": "Review within 24 hours"},
    "graffiti": {"serious": "Cosmetic issue unless it blocks signs or is threatening.", "target": "Routine removal target"},
    "other": {"serious": "Review based on safety and public responsibility.", "target": "Human review"},
}
TIERS = [
    {"id": "P1", "min": 80, "label": "Urgent", "respond": "within 24 hours", "hours": 24},
    {"id": "P2", "min": 60, "label": "High", "respond": "within 2 business days", "hours": 48},
    {"id": "P3", "min": 40, "label": "Medium", "respond": "within 10 business days", "hours": 240},
    {"id": "P4", "min": 0, "label": "Low", "respond": "with routine scheduled work", "hours": None},
]
VALID_RULES = [
    {"check": "photo_shows_issue", "label": "Photo shows the problem", "rule": "A clear photo matching the report."},
    {"check": "in_service_area", "label": "Inside town limits", "rule": "The location is in Amherst."},
    {"check": "in_scope", "label": "Town responsibility", "rule": "A town department handles this."},
]


router = APIRouter()

# The current frontend still knows these legacy display categories/departments.
# Internal AI/problem data remains in the new taxonomy; only compatibility
# responses are mapped so the unchanged UI renders them correctly.
CATEGORY_TO_UI = {
    "pothole": "pothole", "damaged_road_surface": "pothole", "road_sign_damaged": "other",
    "traffic_signal_broken": "streetlight", "lane_markings_faded": "other",
    "sidewalk_or_curb_damaged": "sidewalk", "abandoned_vehicle": "other",
    "streetlight_out": "streetlight", "streetlight_on_daytime": "streetlight",
    "power_line_down": "other", "utility_pole_damaged": "other",
    "flooding_drainage_blocked": "other", "storm_drain_clogged": "other",
    "water_pipe_leak": "other", "manhole_cover_open_missing": "other",
    "sewage_overflow": "other", "no_water_supply": "other",
    "fallen_tree": "other", "leaning_tree_dangerous": "other",
    "overgrown_vegetation": "other", "park_equipment_damaged": "other",
    "overflowing_bin": "trash", "illegal_dumping": "trash",
    "missed_garbage_collection": "trash", "dead_animal": "other", "litter_debris": "trash",
    "fire_hazard": "other", "structure_damage": "other", "broken_fence_barrier": "other",
    "suspicious_object": "other", "graffiti_vandalism": "graffiti",
    "air_pollution": "other", "noise_complaint": "other", "water_pollution": "other",
    "stray_animals": "other", "bus_stop_damaged": "other", "public_restroom_broken": "other",
    "public_building_damaged": "other", "accessibility_issue": "sidewalk", "other": "other",
}
DEPARTMENT_TO_UI = {
    "roads_traffic": "public_works", "street_lighting_electrical": "public_works",
    "water_drainage_sewer": "public_works", "trees_green_spaces": "parks_and_recreation",
    "sanitation_waste": "public_works", "public_safety": "police",
    "environment_pollution": "health_and_inspections",
    "public_property_facilities": "public_works", "other": "other",
}
VALID_STATUSES = {"received", "in_review", "assigned", "in_progress", "resolved", "rejected"}
DONE = {"resolved", "rejected"}

# Demo government accounts match frontend/gov.js. Set GOV_DEMO_PIN in .env.
GOV_USERS = {
    "AMH-DPW-1001": {"id": "AMH-DPW-1001", "name": "Dana Rivera", "title": "DPW Operations Supervisor", "department": "public_works"},
    "AMH-DPW-1002": {"id": "AMH-DPW-1002", "name": "Chris Okafor", "title": "DPW Highway Foreman", "department": "public_works"},
    "AMH-PRK-2001": {"id": "AMH-PRK-2001", "name": "Priya Shah", "title": "Parks & Recreation Coordinator", "department": "parks_and_recreation"},
    "AMH-HLT-3001": {"id": "AMH-HLT-3001", "name": "Morgan Lee", "title": "Health Inspector", "department": "health_and_inspections"},
    "AMH-TMO-9001": {"id": "AMH-TMO-9001", "name": "Alex Chen", "title": "Town Manager's Office", "department": None},
}
GOV_PIN = main.os.getenv("GOV_DEMO_PIN", "246810")
SESSIONS: dict[str, tuple[dict, float]] = {}
LOOKUPS: dict[str, list[float]] = {}


def _iso(dt):
    return main.iso(dt)


def _legacy_category(category: str | None) -> str:
    return CATEGORY_TO_UI.get(category or "other", "other")


def _legacy_department(department: str | None) -> str | None:
    return DEPARTMENT_TO_UI.get(department or "other", "other") if department else None


def _history(row: dict) -> list[dict]:
    h = row.get("gov_status_history") or []
    if h:
        return h
    status = row.get("gov_status") or "received"
    out = [{"status": "received", "at": _iso(row["created_at"]), "note": None}]
    if status != "received":
        out.append({"status": status, "at": _iso(row.get("gov_updated_at") or row["created_at"]), "note": row.get("gov_feedback")})
    return out


def _public_issue(row: dict, distance_km: float | None = None) -> dict:
    ai = row.get("ai") or {}
    return {
        "id": row["id"],
        "created_at": _iso(row["created_at"]),
        "updated_at": _iso(row.get("gov_updated_at") or row["created_at"]),
        "status": row.get("gov_status") or "received",
        "status_history": _history(row),
        "category": _legacy_category(ai.get("category") or row.get("category")),
        "description": row.get("description"),
        "location": {"lat": row.get("lat"), "lng": row.get("lng"), "address": row.get("address")},
        "photo_url": f"/api/issues/{row['id']}/photo",
        "distance_km": round(distance_km, 2) if distance_km is not None else None,
    }


def _safe_staff_report(row: dict, now: float | None = None) -> dict:
    # Work from main's full schema, then adapt only fields the old dashboard reads.
    base = main.to_json(row)
    ai = dict(base.get("ai") or {})
    if ai:
        ai["category"] = _legacy_category(ai.get("category"))
        ai["department"] = _legacy_department(ai.get("department"))
    base["ai"] = ai or None
    base["user"].pop("meta", None)  # Node gov.js intentionally omits meta.
    gov = base["gov"]
    gov["status_history"] = _history(row)
    problem_score = row.get("p_severity_score")
    if gov.get("severity_score") is None and problem_score is not None:
        gov["severity_score"] = main.score(problem_score)
    base["gov"] = gov
    base["assessment"] = _assessment(base, row, now or time.time())
    return base


def _assessment(report: dict, row: dict, now: float) -> dict:
    ai = report.get("ai") or {}
    category = ai.get("category") or _legacy_category(report["user"].get("category"))
    severity = report["gov"].get("severity_score")
    if severity is None:
        severity = ai.get("severity_score")
    if severity is None:
        severity = row.get("p_severity_score")
    severity = 30 if severity in (None, "") else int(severity)
    if severity >= 80:
        priority = {"id": "P1", "label": "Urgent", "respond": "within 24 hours", "hours": 24}
    elif severity >= 60:
        priority = {"id": "P2", "label": "High", "respond": "within 2 business days", "hours": 48}
    elif severity >= 40:
        priority = {"id": "P3", "label": "Medium", "respond": "within 10 business days", "hours": 240}
    else:
        priority = {"id": "P4", "label": "Low", "respond": "with routine scheduled work", "hours": None}
    created = report["created_at"]
    age_days = max(0, (now - datetime.fromisoformat(created.replace("Z", "+00:00")).timestamp()) / 86400)
    rank = severity + min(15, int(age_days))
    due_at = None
    if priority["hours"] is not None:
        due_at = datetime.fromtimestamp(datetime.fromisoformat(created.replace("Z", "+00:00")).timestamp() + priority["hours"] * 3600, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    valid_checks = ai.get("valid_checks") or {}
    criteria = {
        "serious": "Review risk of injury, affected people, accessibility and public responsibility.",
        "target": priority["respond"],
        "valid": [
            {"check": "photo_shows_issue", "label": "Photo shows the problem", "rule": "A clear photo matching the report.", "result": valid_checks.get("photo_shows_issue")},
            {"check": "in_service_area", "label": "Inside town limits", "rule": "The location is in Amherst.", "result": valid_checks.get("in_service_area")},
            {"check": "in_scope", "label": "Town responsibility", "rule": "A town department handles this.", "result": valid_checks.get("in_scope")},
        ],
    }
    return {
        "rank": rank,
        "rank_reason": f"Severity {severity}; crowd problem score {row.get('p_severity_score') or 'not merged yet'}.",
        "category": category,
        "priority": priority,
        "suggested_department": _legacy_department(ai.get("department")),
        "budget": {"low": 0, "high": 0, "text": "Review needed", "basis": "backend compatibility estimate"},
        "criteria": criteria,
        "due_at": due_at,
        "overdue": bool(due_at and datetime.fromisoformat(due_at.replace("Z", "+00:00")).timestamp() < now and report["gov"]["status"] not in DONE),
    }


def _row(report_id: str) -> dict | None:
    main.ready()
    with main.db() as c:
        return c.execute(main.REPORT_SELECT + " WHERE r.id = %s", (report_id,)).fetchone()


def _public_rows(status: str, lat: float | None, lng: float | None, radius_km: float, limit: int) -> list[dict]:
    main.ready()
    with main.db() as c:
        rows = c.execute("SELECT * FROM civic_reports ORDER BY created_at DESC LIMIT 1000").fetchall()
    out = []
    for r in rows:
        st = r.get("gov_status") or "received"
        if status == "open" and st in DONE:
            continue
        if status in DONE and st != status:
            continue
        if status == "closed" and st not in DONE:
            continue
        distance = None
        if lat is not None and lng is not None:
            if r.get("lat") is None or r.get("lng") is None:
                continue
            distance = problems.haversine_m(lat, lng, r["lat"], r["lng"]) / 1000
            if distance > radius_km:
                continue
        out.append((distance, r))
    if lat is not None and lng is not None:
        out.sort(key=lambda x: (x[0] is None, x[0], -x[1]["created_at"].timestamp()))
    else:
        out.sort(key=lambda x: x[1]["created_at"], reverse=True)
    return [_public_issue(r, d) for d, r in out[:max(1, min(200, limit))]]


@router.get("/api/issues")
def issues(status: str = Query("all"), lat: float | None = Query(None), lng: float | None = Query(None), radius_km: float = Query(5, ge=0.1, le=500), limit: int = Query(50, ge=1, le=200)):
    if status not in {"all", "open", "closed", *VALID_STATUSES}:
        raise HTTPException(400, "bad status filter")
    data = _public_rows(status, lat, lng, radius_km, limit)
    return {"issues": data, "total": len(data)}


@router.get("/api/issues/{report_id}/photo")
def issue_photo(report_id: str):
    row = _row(report_id)
    if not row:
        raise HTTPException(404, "not found")
    try:
        return Response(content=main.storage_download(row["photo_path"]), media_type=row["photo_mime"])
    except Exception:
        # Older rows can reference files that were never migrated into the current bucket.
        raise HTTPException(404, "photo not found")


class LookupIn(BaseModel):
    contact: str


@router.post("/api/issues/lookup")
def issue_lookup(body: LookupIn, request: Request):
    key = request.client.host if request.client else "unknown"
    now = time.time()
    values = [t for t in LOOKUPS.get(key, []) if now - t < 600]
    if len(values) >= 20:
        raise HTTPException(429, "Too many lookups, try again later.")
    values.append(now); LOOKUPS[key] = values
    value = body.contact.strip()[:254]
    if not (("@" in value and re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value)) or re.fullmatch(r"\+?[0-9 ()-]{7,20}", value)):
        raise HTTPException(400, "Enter the email or phone you used on the report.")
    normalized = re.sub(r"[^\d+]", "", value) if "@" not in value else value.lower()
    main.ready()
    with main.db() as c:
        rows = c.execute("SELECT * FROM civic_reports WHERE lower(contact_email) = %s OR contact_phone = %s ORDER BY created_at DESC LIMIT 100", (normalized, normalized)).fetchall()
    return {"issues": [_public_issue(r) for r in rows]}


# ---------- Government dashboard compatibility ----------
@router.post("/api/gov/login")
def gov_login(body: dict, request: Request):
    gid = str(body.get("id", "")).strip().upper()[:40]
    pin = str(body.get("pin", "")).strip()[:12]
    user = GOV_USERS.get(gid)
    expected = main.os.getenv("GOV_DEMO_PIN", "246810")
    if not user or not hmac.compare_digest(pin, expected):
        raise HTTPException(401, "Government ID or PIN is wrong.")
    token = secrets.token_urlsafe(32)
    SESSIONS[token] = (user, time.time() + 8 * 3600)
    secure = "; Secure" if request.headers.get("x-forwarded-proto") == "https" else ""
    return JSONResponse({"user": user}, headers={"Set-Cookie": f"gov_session={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800{secure}"})


@router.post("/api/gov/logout")
def gov_logout():
    return JSONResponse({"ok": True}, headers={"Set-Cookie": "gov_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"})


def _gov_user(cookie: str | None):
    if not cookie:
        raise HTTPException(401, "login required")
    token = cookie.split("=", 1)[1] if "=" in cookie else cookie
    item = SESSIONS.get(token)
    if not item or item[1] < time.time():
        SESSIONS.pop(token, None)
        raise HTTPException(401, "login required")
    return item[0]


@router.get("/api/gov/me")
def gov_me(gov_session: str | None = Cookie(None)):
    return {"user": _gov_user(gov_session)}


@router.get("/api/gov/reports")
def gov_reports(status: str = Query("open"), gov_session: str | None = Cookie(None)):
    user = _gov_user(gov_session)
    if status not in {"open", "closed", "all"}:
        raise HTTPException(400, "bad status filter")
    main.ready()
    with main.db() as c:
        rows = c.execute(main.REPORT_SELECT + " ORDER BY r.created_at DESC").fetchall()
    now = time.time(); out = []
    for row in rows:
        st = row.get("gov_status") or "received"
        if status == "open" and st in DONE: continue
        if status == "closed" and st not in DONE: continue
        report = _safe_staff_report(row, now)
        if user["department"] and report["assessment"]["suggested_department"] != user["department"] and report["gov"].get("department") != user["department"]:
            # The frontend can toggle "all"; it still receives all here and filters locally.
            pass
        out.append(report)
    out.sort(key=lambda r: r["assessment"]["rank"], reverse=True)
    return {"reports": out, "criteria": {"tiers": TIERS, "valid": VALID_RULES, "categories": LEGACY_CATEGORIES}}


@router.post("/api/gov/reports/{report_id}/action")
def gov_action(report_id: str, body: dict, gov_session: str | None = Cookie(None)):
    user = _gov_user(gov_session)
    action = body.get("action")
    status = {"in_progress": "in_progress", "complete": "resolved", "invalid": "rejected"}.get(action)
    if not status:
        raise HTTPException(400, "action must be one of in_progress, complete, invalid")
    note = str(body.get("note") or "").strip()[:300]
    if status == "rejected" and not note:
        raise HTTPException(400, "Say why it is invalid (the reporter sees this note).")
    row = _row(report_id)
    if not row:
        raise HTTPException(404, "report not found")
    changes = {"status": status, "updated_by": user["id"]}
    if note: changes["note"] = note
    if status == "in_progress" and not row.get("gov_department"):
        changes["department"] = _legacy_department((row.get("ai") or {}).get("department")) or user.get("department") or "other"
    main.ready()
    with main.db() as c:
        updated = c.execute("SELECT set_report_gov(%s, %s) AS j", (report_id, main.Jsonb(changes))).fetchone()["j"]
    row = _row(report_id)
    return {"report": _safe_staff_report(row, time.time())}


@router.get("/api/gov/media/{media_path:path}")
def gov_media(media_path: str, gov_session: str | None = Cookie(None)):
    _gov_user(gov_session)
    if not re.fullmatch(r"(photos|audio)/R-\d+\.[A-Za-z0-9]+", media_path):
        raise HTTPException(404, "not found")
    main.ready()
    with main.db() as c:
        row = c.execute("SELECT photo_path, photo_mime, audio_path, audio_mime FROM civic_reports WHERE photo_path = %s OR audio_path = %s", (media_path, media_path)).fetchone()
    if not row: raise HTTPException(404, "not found")
    is_audio = media_path == row["audio_path"]
    path, mime = (row["audio_path"], row["audio_mime"]) if is_audio else (row["photo_path"], row["photo_mime"])
    try:
        data = main.storage_download(path)
    except Exception:
        raise HTTPException(404, "media not found")
    return Response(content=data, media_type=mime)


@router.get("/gov")
def gov_redirect():
    return RedirectResponse("/gov.html", status_code=302)


# Include compatibility routes before the static frontend mount.
main.app.include_router(router)
