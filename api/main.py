"""Read-only FastAPI backend for the reports the Node server stores.

It reads the same files server.js writes — data/reports.jsonl and
data/photos/ — so you can stand up a Python backend without migrating
anything. When you later move reports into a database, replace the three
functions in the "data access" section; the routes and models stay the same.

Run:
    pip install -r requirements.txt
    uvicorn api.main:app --reload --port 8620      # http://127.0.0.1:8620/docs

Auth: set ADMIN_KEY to require ?key=... on the list/photo routes, matching the
Node server. If ADMIN_KEY is unset the routes are open (local dev).

Env:
    DATA_DIR    where reports.jsonl and photos/ live (default: ./data)
    ADMIN_KEY   optional shared key; when set, list/photo routes require ?key=
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse

from .models import Report

DATA_DIR = Path(os.environ.get("DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
REPORTS_FILE = DATA_DIR / "reports.jsonl"
PHOTO_DIR = DATA_DIR / "photos"
ADMIN_KEY = os.environ.get("ADMIN_KEY")

app = FastAPI(title="Hackachussetts Reports API", version="1.0.0")


# --- data access (swap these three for a DB adapter later) ------------------
def read_reports() -> list[Report]:
    """Parse every line of reports.jsonl into a validated Report.

    A torn final line (crash mid-write) is skipped, matching store.js.
    """
    if not REPORTS_FILE.exists():
        return []
    out: list[Report] = []
    with REPORTS_FILE.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(Report.model_validate_json(line))
            except (json.JSONDecodeError, ValueError):
                # Skip unparseable/invalid lines rather than failing the request.
                continue
    return out


def find_report(report_id: str) -> Optional[Report]:
    for r in read_reports():
        if r.id == report_id:
            return r
    return None


# --- auth -------------------------------------------------------------------
def require_key(key: Optional[str]) -> None:
    if ADMIN_KEY and key != ADMIN_KEY:
        raise HTTPException(status_code=401, detail="key required")


# --- routes -----------------------------------------------------------------
@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True, "reports": len(read_reports())}


@app.get("/api/reports", response_model=list[Report])
def list_reports(key: Optional[str] = Query(default=None)) -> list[Report]:
    """All reports, newest first — the same ordering the Node admin uses."""
    require_key(key)
    return list(reversed(read_reports()))


@app.get("/api/reports/{report_id}", response_model=Report)
def get_report(report_id: str, key: Optional[str] = Query(default=None)) -> Report:
    require_key(key)
    report = find_report(report_id)
    if report is None:
        raise HTTPException(status_code=404, detail="report not found")
    return report


@app.get("/api/reports/{report_id}/photo")
def get_photo(report_id: str, key: Optional[str] = Query(default=None)) -> FileResponse:
    require_key(key)
    report = find_report(report_id)
    if report is None:
        raise HTTPException(status_code=404, detail="report not found")
    # report.photo.path is like "photos/R-1001.jpg"; resolve under DATA_DIR and
    # confirm it stays inside PHOTO_DIR so a crafted path can't escape.
    photo_path = (DATA_DIR / report.photo.path).resolve()
    if not str(photo_path).startswith(str(PHOTO_DIR.resolve()) + os.sep) or not photo_path.is_file():
        raise HTTPException(status_code=404, detail="photo not found")
    return FileResponse(photo_path, media_type=report.photo.mime)
