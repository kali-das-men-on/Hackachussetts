"""FastAPI backend for the report-an-issue frontend.

- POST /api/reports receives a report (photo, optional voice note, location,
  description, contact) and saves it: the row in Supabase Postgres
  (DATABASE_URL) and the photo / audio in a private Supabase Storage bucket
  (SUPABASE_SECRET_KEY).
- After responding, agent.py analyzes the report (validity, category,
  department, severity 0-100) and the result is saved in the row's `ai` column.
- GET routes return reports in the shared schema: id, client_report_id,
  created_at, user{...}, ai{...}, gov{...}.
- Serves the frontend from ../frontend/public (same origin as the API).

Run:  cd backend && uvicorn main:app --port 8610
"""
import os
import re
import sys
import threading
import traceback
from datetime import datetime, timezone
from pathlib import Path

import httpx
import psycopg
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException as StarletteHTTPException

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))  # so `import agent` works however uvicorn is started
load_dotenv(HERE.parent / ".env")
load_dotenv(HERE / ".env")

import agent  # noqa: E402  (needs .env loaded first)
from prompts import CATEGORIES  # noqa: E402

# --- config (all from .env) ---
OPENROUTER_KEY = os.getenv("OPENROUTER_API_KEY", "")
MODEL = os.getenv("OPENROUTER_MODEL", "openai/gpt-6-luna")

# Postgres. SQLAlchemy-style "postgresql+psycopg://" URLs are accepted too.
DB_URL = os.getenv("DATABASE_URL", "").replace("postgresql+psycopg://", "postgresql://", 1)

# Storage. The project URL is derived from DATABASE_URL unless SUPABASE_URL is set.
_ref = re.search(r"postgres\.([a-z0-9]{20})[:@]|db\.([a-z0-9]{20})\.supabase\.co", DB_URL)
SUPABASE_URL = (
    os.getenv("SUPABASE_URL")
    or (f"https://{_ref.group(1) or _ref.group(2)}.supabase.co" if _ref else "")
).rstrip("/")
SUPABASE_KEY = (
    os.getenv("SUPABASE_SECRET_KEY")
    or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    or os.getenv("SUPABASE_SERVICE_KEY")
    or ""
)
BUCKET = os.getenv("SUPABASE_BUCKET", "civic-reports")

MAX_PHOTO = 8 * 1024 * 1024
MAX_AUDIO = 3 * 1024 * 1024
# The shared schema example writes severity_score as a string ("64"). Set to False for a JSON number.
SCORE_AS_STRING = True

app = FastAPI(title="Report API")


@app.exception_handler(StarletteHTTPException)
async def http_error(request, exc):
    # The frontend shows body.error to the user, so use that key (not FastAPI's "detail").
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


# ---------- Supabase Postgres ----------
def db():
    if not DB_URL:
        raise RuntimeError("DATABASE_URL is not set")
    # prepare_threshold=None: Supabase's transaction pooler (port 6543) rejects prepared statements.
    return psycopg.connect(
        DB_URL, autocommit=True, prepare_threshold=None, connect_timeout=10, row_factory=dict_row
    )


_db_ready = False


def ready():
    """Create / upgrade the table on first use. RLS is on so Supabase's public REST API can't read it."""
    global _db_ready
    if _db_ready:
        return
    with db() as c:
        c.execute("CREATE SEQUENCE IF NOT EXISTS civic_report_seq START 1001")
        c.execute(
            """CREATE TABLE IF NOT EXISTS civic_reports (
                id            text PRIMARY KEY,
                created_at    timestamptz NOT NULL DEFAULT now(),
                status        text NOT NULL DEFAULT 'received',
                address       text,
                description   text,
                contact_email text,
                contact_phone text,
                category      text,
                ai_summary    text,
                photo_path    text NOT NULL,
                photo_mime    text NOT NULL,
                photo_bytes   integer NOT NULL,
                audio_path    text,
                audio_mime    text,
                audio_bytes   integer
            )"""
        )
        # Columns added for the nested user / ai / gov schema (safe to re-run).
        c.execute(
            """ALTER TABLE civic_reports
                ADD COLUMN IF NOT EXISTS client_report_id   text,
                ADD COLUMN IF NOT EXISTS submitted_at       timestamptz,
                ADD COLUMN IF NOT EXISTS lat                double precision,
                ADD COLUMN IF NOT EXISTS lng                double precision,
                ADD COLUMN IF NOT EXISTS accuracy_m         double precision,
                ADD COLUMN IF NOT EXISTS location_source   text,
                ADD COLUMN IF NOT EXISTS device_id          text,
                ADD COLUMN IF NOT EXISTS user_agent         text,
                ADD COLUMN IF NOT EXISTS was_queued_offline boolean NOT NULL DEFAULT false,
                ADD COLUMN IF NOT EXISTS audio_duration_s   double precision,
                ADD COLUMN IF NOT EXISTS ai                 jsonb,
                ADD COLUMN IF NOT EXISTS gov_status         text NOT NULL DEFAULT 'received',
                ADD COLUMN IF NOT EXISTS gov_department     text,
                ADD COLUMN IF NOT EXISTS gov_severity_score integer,
                ADD COLUMN IF NOT EXISTS gov_feedback       text,
                ADD COLUMN IF NOT EXISTS gov_internal_notes text,
                ADD COLUMN IF NOT EXISTS gov_updated_by     text,
                ADD COLUMN IF NOT EXISTS gov_updated_at     timestamptz"""
        )
        c.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS civic_reports_client_id ON civic_reports (client_report_id)"
        )
        c.execute("ALTER TABLE civic_reports ENABLE ROW LEVEL SECURITY")
    _db_ready = True


def iso(dt):
    if dt is None:
        return None
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def score(v):
    if v is None:
        return None
    return str(int(v)) if SCORE_AS_STRING else int(v)


def to_json(r: dict) -> dict:
    """One database row -> the shared report schema."""
    ai = None
    if r["ai"]:
        ai = {**r["ai"], "severity_score": score(r["ai"].get("severity_score"))}
    return {
        "id": r["id"],
        "client_report_id": r["client_report_id"],
        "created_at": iso(r["created_at"]),
        "user": {
            "submitted_at": iso(r["submitted_at"]),
            "photo": {"path": r["photo_path"], "mime": r["photo_mime"], "bytes": r["photo_bytes"]},
            "audio": (
                {
                    "path": r["audio_path"],
                    "mime": r["audio_mime"],
                    "bytes": r["audio_bytes"],
                    "duration_s": r["audio_duration_s"],
                }
                if r["audio_path"] else None
            ),
            "description": r["description"],
            "category": r["category"],
            "location": {
                "lat": r["lat"],
                "lng": r["lng"],
                "accuracy_m": r["accuracy_m"],
                "source": r["location_source"],
                "address": r["address"],
            },
            "contact": {"email": r["contact_email"], "phone": r["contact_phone"]},
            "meta": {
                "device_id": r["device_id"],
                "user_agent": r["user_agent"],
                "was_queued_offline": r["was_queued_offline"],
            },
        },
        "ai": ai,  # null until the agent has finished (a few seconds after submit)
        "gov": {
            "status": r["gov_status"],
            "department": r["gov_department"],
            "severity_score": score(r["gov_severity_score"]),
            "feedback": r["gov_feedback"],
            "internal_notes": r["gov_internal_notes"],
            "updated_by": r["gov_updated_by"],
            "updated_at": iso(r["gov_updated_at"]),
        },
    }


# ---------- Supabase Storage (REST) ----------
def _storage(method: str, url: str, **kw) -> httpx.Response:
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError("SUPABASE_SECRET_KEY (or SUPABASE_URL) is not set in .env")
    if SUPABASE_KEY.startswith("sb_publishable_"):
        raise RuntimeError(
            "SUPABASE_SECRET_KEY in .env is a publishable key. Storage needs the SECRET key "
            "(starts with sb_secret_) from Project Settings > API Keys."
        )
    headers = {"apikey": SUPABASE_KEY, **kw.pop("headers", {})}
    if SUPABASE_KEY.startswith("eyJ"):  # legacy service_role keys are JWTs and also go in Authorization
        headers["Authorization"] = f"Bearer {SUPABASE_KEY}"
    return httpx.request(method, f"{SUPABASE_URL}/storage/v1/{url}", headers=headers, timeout=30, **kw)


_bucket_ready = False


def ensure_bucket():
    """Create the private bucket if it doesn't exist yet."""
    global _bucket_ready
    if _bucket_ready:
        return
    r = _storage("POST", "bucket", json={"id": BUCKET, "name": BUCKET, "public": False})
    # Creating an existing bucket is an error we can ignore.
    if r.status_code >= 400 and "exists" not in r.text.lower():
        raise RuntimeError(f"Storage bucket setup failed ({r.status_code}): {r.text[:200]}")
    _bucket_ready = True


def storage_upload(path: str, data: bytes, mime: str):
    r = _storage("POST", f"object/{BUCKET}/{path}", content=data, headers={"Content-Type": mime})
    if r.status_code >= 400:
        raise RuntimeError(f"Storage upload failed ({r.status_code}): {r.text[:200]}")


def storage_download(path: str) -> bytes:
    r = _storage("GET", f"object/{BUCKET}/{path}")
    if r.status_code >= 400:
        raise RuntimeError(f"Storage download failed ({r.status_code}): {r.text[:200]}")
    return r.content


def storage_delete(path: str):
    try:
        _storage("DELETE", f"object/{BUCKET}/{path}")
    except Exception:
        pass  # best effort cleanup


# ---------- AI ----------
def analyze_report(report_id: str, **inputs):
    """Background task: run the agent and save its result in the row's `ai` column."""
    try:
        ai = agent.run_agent(**inputs)
        with db() as c:
            c.execute("UPDATE civic_reports SET ai = %s WHERE id = %s", (Jsonb(ai), report_id))
    except Exception as e:
        print(f"Agent failed for {report_id}: {e}")


def ask_ai(system: str, messages: list) -> str:
    from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
    from langchain_openrouter import ChatOpenRouter

    llm = ChatOpenRouter(model=MODEL, api_key=OPENROUTER_KEY, temperature=0.2)
    msgs = [SystemMessage(content=system)]
    for role, text in messages:
        msgs.append(AIMessage(content=text) if role == "assistant" else HumanMessage(content=text))
    return llm.invoke(msgs).content.strip()


class ChatIn(BaseModel):
    message: str
    history: list[dict] = []


@app.post("/api/chat")
def chat(body: ChatIn):
    if not OPENROUTER_KEY:
        raise HTTPException(503, "OPENROUTER_API_KEY not set")
    history = [(h.get("role", "user"), str(h.get("content", ""))) for h in body.history[-8:]]
    try:
        reply = ask_ai(
            "You help residents report city issues (potholes, streetlights, trash, graffiti, "
            "sidewalks). Reply in 1-3 short sentences.",
            history + [("user", body.message[:1000])],
        )
    except Exception as e:
        raise HTTPException(502, f"AI error: {e}")
    return {"reply": reply}


# ---------- Reports ----------
def sniff_image(b: bytes):
    if b[:3] == b"\xff\xd8\xff":
        return "image/jpeg", "jpg"
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png", "png"
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        return "image/webp", "webp"


def sniff_audio(b: bytes):
    if b[:4] == b"\x1a\x45\xdf\xa3":
        return "audio/webm", "webm"
    if b[4:8] == b"ftyp":
        return "audio/mp4", "m4a"
    if b[:4] == b"OggS":
        return "audio/ogg", "ogg"
    if b[:4] == b"RIFF" and b[8:12] == b"WAVE":
        return "audio/wav", "wav"
    if b[:3] == b"ID3" or (len(b) > 1 and b[0] == 0xFF and b[1] & 0xE0 == 0xE0):
        return "audio/mpeg", "mp3"


def num(v, lo, hi):
    try:
        n = float(v)
        return n if lo <= n <= hi else None
    except (TypeError, ValueError):
        return None


def parse_time(v):
    try:
        return datetime.fromisoformat(v.strip().replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None


def store_report(photo_bytes, photo_kind, audio_bytes, audio_kind, f: dict):
    """Upload the files and insert the row. Blocking, so it runs in a thread.
    Returns (report_id, is_duplicate)."""
    ready()
    cid = f["client_report_id"]
    if cid:  # the same report sent again (retry / offline queue)
        with db() as c:
            row = c.execute("SELECT id FROM civic_reports WHERE client_report_id = %s", (cid,)).fetchone()
        if row:
            return row["id"], True

    ensure_bucket()
    with db() as c:
        n = c.execute("SELECT nextval('civic_report_seq') AS n").fetchone()["n"]
    rid = f"R-{n}"

    uploaded = []
    try:
        photo_path = f"photos/{rid}.{photo_kind[1]}"
        storage_upload(photo_path, photo_bytes, photo_kind[0])
        uploaded.append(photo_path)
        audio_path = None
        if audio_kind:
            audio_path = f"audio/{rid}.{audio_kind[1]}"
            storage_upload(audio_path, audio_bytes, audio_kind[0])
            uploaded.append(audio_path)

        with db() as c:
            c.execute(
                """INSERT INTO civic_reports
                   (id, client_report_id, submitted_at, address, description, category,
                    contact_email, contact_phone, lat, lng, accuracy_m, location_source,
                    device_id, user_agent, was_queued_offline,
                    photo_path, photo_mime, photo_bytes,
                    audio_path, audio_mime, audio_bytes, audio_duration_s)
                   VALUES (%s,%s,%s,%s,%s,%s, %s,%s,%s,%s,%s,%s, %s,%s,%s, %s,%s,%s, %s,%s,%s,%s)""",
                (
                    rid, cid, f["submitted_at"], f["address"], f["description"], f["category"],
                    f["email"], f["phone"], f["lat"], f["lng"], f["accuracy_m"], f["location_source"],
                    f["device_id"], f["user_agent"], f["queued"],
                    photo_path, photo_kind[0], len(photo_bytes),
                    audio_path, audio_kind[0] if audio_kind else None,
                    len(audio_bytes) if audio_kind else None, f["audio_duration_s"],
                ),
            )
    except psycopg.errors.UniqueViolation:
        # Two copies of the same report arrived at once; keep the first one.
        for p in uploaded:
            storage_delete(p)
        with db() as c:
            row = c.execute("SELECT id FROM civic_reports WHERE client_report_id = %s", (cid,)).fetchone()
        return row["id"], True
    except Exception:
        for p in uploaded:  # don't leave orphaned files behind
            storage_delete(p)
        raise
    return rid, False


@app.post("/api/reports")
async def create_report(
    request: Request,
    photo: UploadFile = File(None),
    audio: UploadFile = File(None),
    audio_duration_s: str = Form(None),
    client_report_id: str = Form(None),
    lat: str = Form(None),
    lng: str = Form(None),
    accuracy_m: str = Form(None),
    location_source: str = Form(None),
    address: str = Form(None),
    description: str = Form(None),
    category: str = Form(None),
    contact: str = Form(None),
    contact_phone: str = Form(None),
    submitted_at: str = Form(None),
    device_id: str = Form(None),
    queued: str = Form(None),
):
    if request.query_params.get("fail") == "1":  # the frontend's retry-test hook
        return JSONResponse({"error": "forced failure (?fail=1)"}, status_code=503)

    # Validate everything before saving anything.
    if photo is None:
        raise HTTPException(400, "photo required")
    photo_bytes = await photo.read()
    if len(photo_bytes) > MAX_PHOTO:
        raise HTTPException(413, "Photo too large")
    photo_kind = sniff_image(photo_bytes)
    if not photo_kind:
        raise HTTPException(400, "photo must be JPEG, PNG or WebP")

    audio_bytes = audio_kind = None
    seconds = None
    if audio is not None:
        audio_bytes = await audio.read()
        if audio_bytes:
            if len(audio_bytes) > MAX_AUDIO:
                raise HTTPException(413, "Audio too large (max 3 MB)")
            audio_kind = sniff_audio(audio_bytes)
            if not audio_kind:
                raise HTTPException(400, "audio must be WebM, MP4/M4A, Ogg, MP3 or WAV")
            seconds = num(audio_duration_s, 0, 3600)
            if seconds is not None and seconds > 31:  # the device measures it; allow 1 s of drift
                raise HTTPException(400, "Audio is longer than 30 seconds")
            seconds = None if seconds is None else round(min(seconds, 30), 1)

    la, ln = num(lat, -90, 90), num(lng, -180, 180)
    has_point = la is not None and ln is not None
    address = (address or "").strip()[:300] or None
    if not has_point and not address:
        raise HTTPException(400, "location or address required")
    source = location_source if location_source in ("gps", "map", "address") else ("gps" if has_point else "address")

    # `contact` may hold an email or a phone number; `contact_phone` is a phone.
    contact = (contact or "").strip()
    email = phone = None
    if contact:
        if "@" in contact:
            if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", contact):
                raise HTTPException(400, "Contact must be an email or phone number")
            email = contact[:254]
        else:
            phone = re.sub(r"[^\d+]", "", contact)
    if (contact_phone or "").strip():
        phone = re.sub(r"[^\d+]", "", contact_phone)
    if phone is not None and not re.fullmatch(r"\+?\d{7,15}", phone):
        raise HTTPException(400, "Contact must be an email or phone number")

    category = (category or "").strip() or None
    if category and category not in CATEGORIES:
        category = "other"
    description = (description or "").strip()[:500] or None

    fields = {
        "client_report_id": (client_report_id or "").strip()[:64] or None,
        "submitted_at": parse_time(submitted_at),
        "address": address,
        "description": description,
        "category": category,
        "email": email,
        "phone": phone,
        "lat": la if has_point else None,
        "lng": ln if has_point else None,
        "accuracy_m": num(accuracy_m, 0, 1e6) if has_point else None,
        "location_source": source,
        "device_id": (device_id or "").strip()[:64] or None,
        "user_agent": (request.headers.get("user-agent") or "")[:300] or None,
        "queued": queued == "1",
        "audio_duration_s": seconds,
    }

    try:
        report_id, duplicate = await run_in_threadpool(
            store_report, photo_bytes, photo_kind, audio_bytes, audio_kind, fields
        )
    except Exception:
        traceback.print_exc()  # full detail in the server console
        raise HTTPException(502, "Could not save the report. Please try again.")

    if duplicate:
        return JSONResponse({"id": report_id, "status": "received", "duplicate": True}, status_code=200)

    # Analyze in the background so the resident doesn't wait for the model.
    threading.Thread(
        target=analyze_report,
        args=(report_id,),
        kwargs=dict(
            photo_bytes=photo_bytes, photo_mime=photo_kind[0], description=description,
            audio=audio_bytes if audio_kind else None, audio_format=audio_kind[1] if audio_kind else None,
            lat=fields["lat"], lng=fields["lng"], accuracy_m=fields["accuracy_m"],
            location_source=source, address=address, category=category,
        ),
        daemon=True,
    ).start()
    return JSONResponse({"id": report_id, "status": "received"}, status_code=201)


@app.get("/api/reports")
def list_reports():
    ready()
    with db() as c:
        rows = c.execute("SELECT * FROM civic_reports ORDER BY created_at DESC").fetchall()
    return [to_json(r) for r in rows]


@app.get("/api/reports/{report_id}")
def get_report(report_id: str):
    ready()
    with db() as c:
        row = c.execute("SELECT * FROM civic_reports WHERE id = %s", (report_id,)).fetchone()
    if not row:
        raise HTTPException(404, "report not found")
    return to_json(row)


@app.get("/api/reports/{report_id}/{kind}")
def get_media(report_id: str, kind: str):
    if kind not in ("photo", "audio"):
        raise HTTPException(404, "not found")
    ready()
    with db() as c:
        row = c.execute(
            f"SELECT {kind}_path AS path, {kind}_mime AS mime FROM civic_reports WHERE id = %s",
            (report_id,),
        ).fetchone()
    if not row or not row["path"]:
        raise HTTPException(404, "not found")
    try:
        data = storage_download(row["path"])
    except Exception:
        traceback.print_exc()
        raise HTTPException(502, "Could not load the file")
    return Response(content=data, media_type=row["mime"])


@app.get("/healthz")
def healthz():
    try:
        ready()
        with db() as c:
            n = c.execute("SELECT count(*) AS n FROM civic_reports").fetchone()["n"]
    except Exception as e:
        return JSONResponse({"ok": False, "error": f"database: {type(e).__name__}"}, status_code=503)
    return {
        "ok": True,
        "reports": n,
        "ai": bool(OPENROUTER_KEY),
        "storage": bool(SUPABASE_KEY) and not SUPABASE_KEY.startswith("sb_publishable_"),
    }


# Serve the frontend so it is same-origin with the API (mounted last).
app.mount("/", StaticFiles(directory=HERE.parent / "frontend" / "public", html=True), name="frontend")
