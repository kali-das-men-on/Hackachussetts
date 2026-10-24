#!/usr/bin/env python3
"""Generate mock reports for the public issues board.

Writes, in the same layout as data/ (so the Node server can serve it with
DATA_DIR=../mock-data):

    mock-data/reports.jsonl   one Report per line (schema/report.schema.json: user / ai / gov)
    mock-data/photos/*.jpg    placeholder photos (drawn here, no real images)
    mock-data/seed.sql        the same reports as INSERTs for the Supabase
                              `civic_reports` table (see schema/supabase.sql)

All contacts are fake @example.com addresses. Several reports share
demo@example.com so the "check my reports" lookup has something to show.

Run from the repo root:   python3 scripts/make_mock_data.py
Needs Pillow (pip install pillow). Output is deterministic.
"""

from __future__ import annotations

import json
import random
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "mock-data"
NOW = datetime(2026, 10, 24, 16, 0, tzinfo=timezone.utc)  # fixed so reruns give the same file
FIRST_ID = 2001  # real reports start at R-1001; keep mock ids clearly separate

COLORS = {
    "pothole": (92, 84, 76),
    "streetlight": (30, 40, 70),
    "trash": (70, 110, 60),
    "graffiti": (150, 70, 120),
    "sidewalk": (130, 120, 105),
    "other": (80, 95, 110),
}

# (hours ago, category, description, address, lat, lng, status path, contact email)
# Status path = statuses the report moved through, each with hours after creation and a public note.
REPORTS = [
    (2, "pothole", "Deep pothole in the bike lane, cyclists swerving into traffic.",
     "Massachusetts Ave near Commonwealth Ave, Amherst", 42.38902, -72.52417, [], "demo@example.com"),
    (5, "streetlight", "Streetlight out, the whole crosswalk is dark at night.",
     "N Pleasant St & Triangle St, Amherst", 42.38595, -72.51945, [("in_review", 3, None)], "sam.r@example.com"),
    (9, "trash", "Overflowing trash can, bags piled next to it.",
     "Amherst Town Common, S Pleasant St", 42.37540, -72.51985, [("in_review", 2, None), ("assigned", 6, "Sent to DPW sanitation.")], "lee.k@example.com"),
    (20, "graffiti", "Graffiti on the bus shelter glass.",
     "Haigis Mall bus stop, UMass", 42.38817, -72.52855, [("in_review", 4, None), ("assigned", 10, "Facilities crew scheduled."),
      ("in_progress", 18, "Crew on site removing paint.")], "demo@example.com"),
    (30, "sidewalk", "Raised sidewalk slab, someone tripped here yesterday.",
     "Lincoln Ave near Fearing St, Amherst", 42.38330, -72.52700, [("in_review", 5, None)], "jo.m@example.com"),
    (44, "pothole", "Pothole at the stop sign, about 30 cm across.",
     "Fearing St & Butterfield Terrace, Amherst", 42.38630, -72.51770,
     [("in_review", 6, None), ("assigned", 20, "Added to this week's patching route."), ("in_progress", 40, None)], None),
    (60, "streetlight", "Two lamps flickering along the path to the library.",
     "Campus Pond path, UMass Amherst", 42.38955, -72.52740,
     [("in_review", 3, None), ("assigned", 12, "Electrical shop ticket opened."), ("in_progress", 30, None),
      ("resolved", 50, "Both lamps replaced.")], "demo@example.com"),
    (75, "trash", "Illegal dumping: old mattress and couch by the curb.",
     "Phillips St, Amherst", 42.37950, -72.51600, [("in_review", 10, None), ("assigned", 30, "Bulk pickup requested.")], "pat.q@example.com"),
    (96, "other", "Fallen tree branch blocking half the sidewalk.",
     "Sunset Ave & Lincoln Ave, Amherst", 42.38450, -72.52920,
     [("in_review", 2, None), ("assigned", 5, "Tree crew dispatched."), ("in_progress", 8, None),
      ("resolved", 14, "Branch removed, sidewalk clear.")], "ana.v@example.com"),
    (120, "sidewalk", "Curb ramp crumbling, hard to get a wheelchair up.",
     "N Pleasant St & Fearing St, Amherst", 42.38660, -72.51920, [("in_review", 20, "Inspector will measure the ramp.")], "demo@example.com"),
    (150, "graffiti", "Tagging on the side of the parking garage.",
     "Campus Center garage, UMass", 42.39110, -72.52610,
     [("in_review", 8, None), ("assigned", 40, None), ("in_progress", 100, None), ("resolved", 130, "Wall repainted.")], None),
    (200, "pothole", "Several potholes after the rain, water pooling.",
     "University Dr near Amity St, Amherst", 42.37280, -72.53430, [("in_review", 30, None), ("assigned", 90, "Scheduled for resurfacing.")], "lee.k@example.com"),
    (260, "other", "Broken bench, the slats are snapped.",
     "Kendrick Park, Amherst", 42.38160, -72.51830, [("rejected", 40, "Private property, forwarded to the owner.")], "demo@example.com"),
    (300, "streetlight", "Pedestrian signal button doesn't work.",
     "Main St & S Pleasant St, Amherst", 42.37455, -72.51940,
     [("in_review", 10, None), ("assigned", 50, None), ("in_progress", 120, None), ("resolved", 200, "Signal button replaced.")], "sam.r@example.com"),
    (340, "trash", "Recycling bins knocked over and never picked up.",
     "Main St, Northampton", 42.31850, -72.63150, [("in_review", 24, None)], "ana.v@example.com"),
    (400, "pothole", "Pothole in the right lane, cars hitting it hard.",
     "King St, Northampton", 42.32600, -72.63650,
     [("in_review", 20, None), ("assigned", 60, None), ("in_progress", 200, None), ("resolved", 300, "Patched.")], "pat.q@example.com"),
    (450, "sidewalk", "Sidewalk heaved by tree roots, big trip hazard.",
     "Beacon St, Boston", 42.35580, -71.07020, [("in_review", 48, None), ("assigned", 150, "Added to sidewalk repair list.")], None),
    (500, "graffiti", "Spray paint on the T station entrance.",
     "Park Street Station, Boston", 42.35640, -71.06240, [("in_review", 12, None), ("assigned", 40, None)], "jo.m@example.com"),
]


def font(size: int):
    for name in ("DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def draw_photo(category: str, seed: int, path: Path) -> int:
    """A simple placeholder scene: road/sky, a shape per category, a label."""
    rnd = random.Random(seed)
    w, h = 640, 480
    base = COLORS[category]
    img = Image.new("RGB", (w, h), base)
    d = ImageDraw.Draw(img)
    # Sky and ground.
    d.rectangle([0, 0, w, h * 0.45], fill=tuple(min(255, c + 90) for c in base))
    d.rectangle([0, h * 0.45, w, h], fill=tuple(max(0, c - 20) for c in base))
    for _ in range(40):  # some texture
        x, y = rnd.randrange(w), rnd.randrange(int(h * 0.45), h)
        r = rnd.randrange(2, 8)
        shade = tuple(max(0, min(255, c + rnd.randrange(-25, 25))) for c in base)
        d.ellipse([x - r, y - r, x + r, y + r], fill=shade)
    cx = w // 2 + rnd.randrange(-60, 60)
    if category == "pothole":
        d.ellipse([cx - 130, 300, cx + 130, 400], fill=(35, 30, 28), outline=(20, 18, 16), width=6)
    elif category == "streetlight":
        d.rectangle([cx - 8, 90, cx + 8, 420], fill=(60, 60, 65))
        d.rectangle([cx - 60, 80, cx + 10, 100], fill=(60, 60, 65))
        d.ellipse([cx - 80, 90, cx - 40, 120], fill=(40, 40, 40))
    elif category == "trash":
        d.rectangle([cx - 60, 230, cx + 60, 400], fill=(40, 70, 45))
        for i in range(4):
            bx = cx - 150 + i * 80
            d.ellipse([bx, 360, bx + 90, 430], fill=(20, 20, 20))
    elif category == "graffiti":
        d.rectangle([60, 120, w - 60, 380], fill=(200, 200, 195))
        for _ in range(6):
            pts = [(rnd.randrange(80, w - 80), rnd.randrange(140, 360)) for _ in range(4)]
            d.line(pts, fill=(rnd.randrange(150, 255), rnd.randrange(0, 120), rnd.randrange(80, 255)), width=10)
    elif category == "sidewalk":
        d.polygon([(0, 340), (w, 300), (w, h), (0, h)], fill=(175, 170, 160))
        d.line([(cx - 100, 330), (cx, 360), (cx + 120, 320)], fill=(60, 55, 50), width=8)
    else:
        d.line([(cx - 200, 380), (cx + 180, 300)], fill=(90, 60, 30), width=24)
        for i in range(5):
            d.ellipse([cx - 160 + i * 70, 280, cx - 100 + i * 70, 340], fill=(60, 110, 50))
    label = f"{category.upper()}  ·  mock photo"
    f = font(26)
    tw = d.textlength(label, font=f)
    d.rounded_rectangle([16, 16, 16 + tw + 24, 60], radius=10, fill=(0, 0, 0))
    d.text((28, 22), label, fill=(255, 255, 255), font=f)
    img.save(path, "JPEG", quality=70)
    return path.stat().st_size


# Mock `ai` blocks (what backend/agent.py would return), one per REPORTS entry, same order:
# (severity 0-100, department, photo_shows_issue, in_service_area, in_scope, severity reason)
# Service area is Amherst (backend/prompts.py), so Northampton and Boston reports are out of area.
AI = [
    (78, "public_works", True, True, True, "Deep pothole in a bike lane on a main road; cyclists swerve into traffic, a clear injury risk."),
    (66, "public_works", True, True, True, "Dark crosswalk at night on a busy street; pedestrians are hard to see."),
    (35, "public_works", True, True, True, "Overflowing public bin; a nuisance and a litter source, little safety risk."),
    (18, "public_works", True, True, True, "Graffiti on a bus shelter; cosmetic, no safety impact, not offensive as far as the photo shows."),
    (70, "public_works", True, True, True, "Raised slab on a walkway, well over the 1/4 inch limit; someone already tripped."),
    (58, "public_works", True, True, True, "About 30 cm pothole at a stop sign; can damage tires and rims, moderate risk."),
    (42, "public_works", True, True, True, "Two flickering lamps on a busy footpath; reduced visibility at night."),
    (48, "public_works", True, True, True, "Mattress and couch dumped at the curb; blocks part of the way and invites more dumping."),
    (64, "parks_and_recreation", True, True, True, "Branch blocks half the sidewalk, forcing people into the street; wheelchair users cannot pass."),
    (68, "public_works", True, True, True, "Crumbling curb ramp; wheelchair users cannot cross here, an accessibility failure."),
    (15, "public_works", True, True, True, "Tagging on a garage wall; cosmetic only."),
    (55, "public_works", True, True, True, "Several potholes with standing water; hides the depth from drivers."),
    (12, "parks_and_recreation", True, True, False, "Broken bench, minor risk; the bench is on private property."),
    (60, "public_works", True, True, True, "Pedestrian signal button does not work at a busy downtown crossing."),
    (30, "public_works", True, False, True, "Knocked-over recycling bins; minor. Location is Northampton, outside Amherst."),
    (57, "public_works", True, False, True, "Pothole in a travel lane; moderate risk. Location is Northampton, outside Amherst."),
    (62, "public_works", True, False, True, "Heaved sidewalk, trip hazard. Location is Boston, outside Amherst."),
    (20, "public_works", False, False, True, "Graffiti at a T station; cosmetic. Photo is a placeholder and the location is Boston."),
]

SUMMARY_FMT = "{desc}, at {addr}."
DEPT_REASON = {
    "public_works": "Roads, sidewalks, streetlights and public trash are Public Works.",
    "parks_and_recreation": "Public trees, parks and benches are Parks and Recreation.",
}


def ai_block(i: int, cat: str, desc: str, addr: str, created: datetime) -> dict:
    sev, dept, photo_ok, in_area, in_scope, sev_reason = AI[i]
    checks = {"photo_shows_issue": photo_ok, "in_service_area": in_area, "in_scope": in_scope}
    if all(checks.values()):
        valid_reason = "The photo shows the problem, the location is in Amherst and it is on public property."
    else:
        why = []
        if not photo_ok:
            why.append("the photo does not clearly show the problem")
        if not in_area:
            why.append("the location is outside Amherst")
        if not in_scope:
            why.append("it is on private property, not a town responsibility")
        valid_reason = "Not valid: " + "; ".join(why) + "."
    return {
        "processed_at": iso(created + timedelta(minutes=1)),
        "model": "mock",
        "taxonomy_version": "amherst-2026-10",
        "valid": all(checks.values()),
        "valid_checks": checks,
        "valid_reason": valid_reason,
        "evidence": ["photo", "description", "location"],
        "category": cat,
        "category_reason": f"The photo and description show a {cat} issue.",
        "department": dept,
        "department_reason": DEPT_REASON[dept],
        "severity_score": str(sev),
        "severity_reason": sev_reason,
        "summary": SUMMARY_FMT.format(desc=desc.rstrip("."), addr=addr)[:200],
    }


def iso(t: datetime) -> str:
    return t.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def sql(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def main() -> None:
    assert len(AI) == len(REPORTS)
    (OUT / "photos").mkdir(parents=True, exist_ok=True)
    (OUT / "audio").mkdir(parents=True, exist_ok=True)
    reports = []
    for i, (hours_ago, cat, desc, addr, lat, lng, path, email) in enumerate(REPORTS):
        rid = f"R-{FIRST_ID + i}"
        created = NOW - timedelta(hours=hours_ago, minutes=17 * i)
        history = [{"status": "received", "at": iso(created), "note": None}]
        for status, after_h, note in path:
            history.append({"status": status, "at": iso(created + timedelta(hours=after_h)), "note": note})
        photo_path = f"photos/{rid}.jpg"
        size = draw_photo(cat, i, OUT / photo_path)
        ai = ai_block(i, cat, desc, addr, created)
        touched = len(history) > 1
        notes = [h["note"] for h in history if h["note"]]
        reports.append({
            "id": rid,
            "client_report_id": str(uuid.UUID(int=random.Random(i).getrandbits(128), version=4)),
            "created_at": iso(created),
            "user": {
                "submitted_at": iso(created - timedelta(seconds=1)),
                "photo": {"path": photo_path, "mime": "image/jpeg", "bytes": size},
                "audio": None,
                "description": desc,
                "category": None,
                "location": {"lat": lat, "lng": lng, "accuracy_m": 8.0, "source": "gps", "address": addr},
                "contact": {"email": email, "phone": None},
                "meta": {"device_id": None, "user_agent": "mock-data", "was_queued_offline": False},
            },
            "ai": ai,
            "gov": {
                "status": history[-1]["status"],
                "department": ai["department"] if history[-1]["status"] in ("assigned", "in_progress", "resolved") else None,
                "severity_score": None,
                "feedback": notes[-1] if notes else None,
                "internal_notes": None,
                "updated_by": "mock-staff" if touched else None,
                "updated_at": history[-1]["at"] if touched else None,
                "status_history": history if touched else [],
            },
        })

    with (OUT / "reports.jsonl").open("w", encoding="utf-8") as fh:
        for r in sorted(reports, key=lambda r: r["created_at"]):
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")

    # Supabase seed for civic_reports (schema/supabase.sql). Photos are not uploaded by this:
    # put mock-data/photos/R-xxxx.jpg in the civic-reports bucket at photos/R-xxxx.jpg.
    cols = ("id, client_report_id, created_at, submitted_at, description, category, lat, lng, accuracy_m, "
            "location_source, address, contact_email, contact_phone, user_agent, photo_path, photo_mime, photo_bytes, "
            "ai, status, gov_status, gov_department, gov_feedback, gov_updated_by, gov_updated_at, gov_status_history")
    rows = []
    for r in reports:
        u, g, loc = r["user"], r["gov"], r["user"]["location"]
        rows.append("(" + ", ".join([
            sql(r["id"]), sql(r["client_report_id"]), sql(r["created_at"]), sql(u["submitted_at"]),
            sql(u["description"]), sql(u["category"]), sql(loc["lat"]), sql(loc["lng"]), sql(loc["accuracy_m"]),
            sql(loc["source"]), sql(loc["address"]), sql(u["contact"]["email"]), sql(u["contact"]["phone"]),
            sql(u["meta"]["user_agent"]), sql(u["photo"]["path"]), sql(u["photo"]["mime"]), sql(u["photo"]["bytes"]),
            sql(json.dumps(r["ai"])) + "::jsonb", sql(g["status"]), sql(g["status"]), sql(g["department"]),
            sql(g["feedback"]), sql(g["updated_by"]), sql(g["updated_at"]),
            sql(json.dumps(g["status_history"])) + "::jsonb",
        ]) + ")")
    (OUT / "seed.sql").write_text(
        "-- Mock reports (R-2001..). Generated by scripts/make_mock_data.py; do not edit.\n"
        "-- Run schema/supabase.sql first. Upload mock-data/photos/R-xxxx.jpg to bucket civic-reports at photos/R-xxxx.jpg.\n"
        "-- Remove again with: DELETE FROM civic_reports WHERE user_agent = 'mock-data';\n"
        f"INSERT INTO civic_reports\n  ({cols})\nVALUES\n  "
        + ",\n  ".join(rows)
        + "\nON CONFLICT (id) DO NOTHING;\n",
        encoding="utf-8",
    )
    print(f"wrote {len(reports)} reports to {OUT.relative_to(ROOT)}/")


if __name__ == "__main__":
    main()
