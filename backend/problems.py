"""Merging reports of the same problem, and the crowd-based severity boost.

Every valid report belongs to exactly one *problem* (a row in civic_problems). Staff and the
public board see one issue per problem, with all its reports under it.

A new report joins an open problem (last reported within MERGE_WINDOW_DAYS) when one of these
holds, checked in this order; merge_reason on the report says which one:

  1. Same photo: byte-identical (photo_sha256) or near-identical (photo_dhash, a perceptual
     hash, within PHOTO_MATCH_BITS bits, so a re-saved or resized copy still matches), and
     within SAME_PHOTO_RADIUS_M (1 km) or either report has no coordinates. Category is ignored:
     the AI may label the same photo "pothole" once and "damaged_road_surface" the next time.
  2. Close and same kind: within MERGE_RADIUS_M (50 m) of a report in the problem, and the same
     category or a related one (CATEGORY_GROUPS, e.g. pothole and damaged_road_surface).
  3. Probably close, AI agrees: within the GPS uncertainty of the two reports (their accuracy_m
     added, at most MAX_RADIUS_M = 150 m), same department, and the AI compares the two photos
     and says they show the same issue (agent.same_issue). Needs a `compare` callback.

Never across: a problem more than MAX_SPAN_M (150 m) from the problem's first report (rules 2-3),
so a long street of separate potholes can't chain into one giant problem. Category "other"
only merges by rule 1 or 3. Reports without coordinates only merge by rule 1.

Severity of a problem = the highest AI severity among its reports, plus BUMP_PER_REPORTER for
each additional *separate* reporter (capped at MAX_CROWD_BONUS, total capped at 100). A report
from the same device / email / phone, or with the same photo, joins but doesn't count as a
separate reporter, so one person can't inflate a score by sending the same thing many times.

Reports the AI marks invalid, or never analyzed, are not attached at all.

A report that joins a problem staff already work on takes over its status (in_progress etc.),
with a note in its history, so the reporter sees the real progress.

All functions take an open psycopg connection `c` (dict rows, autocommit).
"""
import io
import math
import os
from datetime import timezone

from psycopg.types.json import Jsonb


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except ValueError:
        return default


MERGE_RADIUS_M = _int_env("MERGE_RADIUS_M", 50)
MAX_RADIUS_M = _int_env("MAX_MERGE_RADIUS_M", 150)
UNKNOWN_ACCURACY_M = 25  # assumed GPS accuracy when the phone didn't say
SAME_PHOTO_RADIUS_M = _int_env("SAME_PHOTO_RADIUS_M", 1000)
PHOTO_MATCH_BITS = _int_env("PHOTO_MATCH_BITS", 6)  # of 64
MAX_SPAN_M = _int_env("MAX_PROBLEM_SPAN_M", 150)
MAX_AI_COMPARISONS = _int_env("MAX_AI_COMPARISONS", 3)
NEVER_MERGE = {"other"}
MERGE_WINDOW_DAYS = _int_env("MERGE_WINDOW_DAYS", 45)
BUMP_PER_REPORTER = _int_env("BUMP_PER_REPORTER", 5)
MAX_CROWD_BONUS = _int_env("MAX_CROWD_BONUS", 30)
DONE = ("resolved", "rejected")

# Categories the AI uses for the same real-world thing. Same group counts as same category.
CATEGORY_GROUPS = [
    {"pothole", "damaged_road_surface"},
    {"sidewalk_or_curb_damaged", "accessibility_issue"},
    {"streetlight_out", "streetlight_on_daytime"},
    {"power_line_down", "utility_pole_damaged"},
    {"flooding_drainage_blocked", "storm_drain_clogged"},
    {"water_pipe_leak", "flooding_drainage_blocked"},
    {"fallen_tree", "leaning_tree_dangerous"},
    {"overflowing_bin", "litter_debris", "illegal_dumping", "missed_garbage_collection"},
    {"graffiti_vandalism", "public_building_damaged", "bus_stop_damaged"},
]

# Postgres advisory-lock key: attaching reports one at a time stops two reports
# of a brand-new problem, arriving together, from creating two problems.
LOCK_KEY = 7421001


def haversine_m(lat1, lng1, lat2, lng2) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi, dlmb = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def related(a, b) -> bool:
    if not a or not b or a in NEVER_MERGE or b in NEVER_MERGE:
        return False
    return a == b or any(a in g and b in g for g in CATEGORY_GROUPS)


def photo_dhash(data: bytes) -> str | None:
    """64-bit difference hash of a photo as 16 hex chars. Survives resizing and re-compression."""
    try:
        from PIL import Image, ImageOps

        img = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("L").resize((9, 8), Image.LANCZOS)
        px = list(img.getdata())
        bits = 0
        for y in range(8):
            for x in range(8):
                bits = (bits << 1) | (px[y * 9 + x] > px[y * 9 + x + 1])
        return f"{bits:016x}"
    except Exception:
        return None


def same_photo(a: dict, b: dict) -> bool:
    if a.get("photo_sha256") and a.get("photo_sha256") == b.get("photo_sha256"):
        return True
    ha, hb = a.get("photo_dhash"), b.get("photo_dhash")
    return bool(ha and hb) and (int(ha, 16) ^ int(hb, 16)).bit_count() <= PHOTO_MATCH_BITS


def gps_radius(a: dict, b: dict) -> float:
    acc = lambda r: r.get("accuracy_m") if r.get("accuracy_m") is not None else UNKNOWN_ACCURACY_M  # noqa: E731
    return max(MERGE_RADIUS_M, min(MAX_RADIUS_M, acc(a) + acc(b)))


def crowd_severity(base: int, reporters: int) -> tuple[int, str]:
    """(problem severity 0-100, plain-language note) from the top AI score and reporter count."""
    bonus = min(MAX_CROWD_BONUS, BUMP_PER_REPORTER * max(0, reporters - 1))
    severity = max(0, min(100, int(base) + bonus))
    note = f"Highest AI score {base}"
    if bonus:
        note += f", +{bonus} for {reporters} separate reporters"
    return severity, note + f" = {severity}"


def candidates(c, exclude_id):
    """Every report already in an open, recent problem, with its problem's first-report location."""
    return c.execute(
        """SELECT r.*, p.id AS pid, p.lat AS plat, p.lng AS plng, p.department AS pdept
           FROM civic_problems p JOIN civic_reports r ON r.problem_id = p.id
           WHERE p.status = 'open' AND r.id <> %s
             AND p.last_reported_at > now() - make_interval(days => %s)
           ORDER BY r.created_at""",
        (exclude_id, MERGE_WINDOW_DAYS),
    ).fetchall()


def find_problem(c, r, compare=None):
    """(problem id, reason) for the problem report `r` belongs to, or (None, None)."""
    ai = r["ai"]
    has_point = r["lat"] is not None and r["lng"] is not None
    rows = candidates(c, r["id"])

    def dist(m):
        if not has_point or m["lat"] is None:
            return None
        return haversine_m(r["lat"], r["lng"], m["lat"], m["lng"])

    def within_span(m):
        return m["plat"] is None or haversine_m(r["lat"], r["lng"], m["plat"], m["plng"]) <= MAX_SPAN_M

    # 1. same photo
    best = None
    for m in rows:
        d = dist(m)
        if same_photo(r, m) and (d is None or d <= SAME_PHOTO_RADIUS_M):
            key = (d if d is not None else 1e9, m["created_at"])
            if best is None or key < best[0]:
                best = (key, m)
    if best:
        return best[1]["pid"], f"same photo as {best[1]['id']}"
    if not has_point:
        return None, None

    # 2. close and same kind of issue
    best = None
    for m in rows:
        d = dist(m)
        if d is not None and d <= MERGE_RADIUS_M and within_span(m) and related(ai.get("category"), (m["ai"] or {}).get("category")):
            if best is None or d < best[0]:
                best = (d, m)
    if best:
        return best[1]["pid"], f"{round(best[0])} m from {best[1]['id']}, same kind of issue"

    # 3. within GPS uncertainty, same department, and the AI says the photos match
    if compare is None:
        return None, None
    near = []
    for m in rows:
        d = dist(m)
        if d is None or d > gps_radius(r, m) or not within_span(m):
            continue
        if (m["ai"] or {}).get("department") != ai.get("department"):
            continue
        near.append((d, m))
    near.sort(key=lambda x: x[0])
    asked = set()
    for d, m in near:
        if m["pid"] in asked or len(asked) >= MAX_AI_COMPARISONS:
            continue
        asked.add(m["pid"])
        try:
            if compare(r, m):
                return m["pid"], f"{round(d)} m from {m['id']}, AI says the photos show the same issue"
        except Exception as e:
            print(f"Photo comparison {r['id']} vs {m['id']} failed: {e}")
    return None, None


def is_repeat_reporter(c, problem_id, r) -> bool:
    """True if someone with the same device / email / phone / photo already reported this problem."""
    others = c.execute(
        "SELECT device_id, contact_email, contact_phone, photo_sha256, photo_dhash FROM civic_reports WHERE problem_id = %s AND id <> %s",
        (problem_id, r["id"]),
    ).fetchall()
    for o in others:
        if r["device_id"] and o["device_id"] == r["device_id"]:
            return True
        if r["contact_email"] and (o["contact_email"] or "").lower() == r["contact_email"].lower():
            return True
        if r["contact_phone"] and o["contact_phone"] == r["contact_phone"]:
            return True
        if same_photo(r, o):
            return True
    return False


def recompute(c, problem_id, touch: bool):
    """Rebuild a problem's totals, severity and open/closed status from its member reports."""
    rows = c.execute(
        "SELECT id, counted, ai, gov_status FROM civic_reports WHERE problem_id = %s ORDER BY created_at, id",
        (problem_id,),
    ).fetchall()
    if not rows:
        c.execute("DELETE FROM civic_problems WHERE id = %s", (problem_id,))
        return
    sev = lambda row: int(row["ai"]["severity_score"])  # noqa: E731
    top = rows[0]
    for row in rows[1:]:
        if sev(row) > sev(top):
            top = row
    reporters = sum(1 for row in rows if row["counted"])
    severity, note = crowd_severity(sev(top), reporters)
    status = "closed" if all(row["gov_status"] in DONE for row in rows) else "open"
    c.execute(
        """UPDATE civic_problems SET
        report_count = %s, reporter_count = %s, base_severity = %s,
        severity_score = %s, severity_note = %s, status = %s,
        summary = %s, department = %s, top_report_id = %s,
        last_reported_at = CASE WHEN %s THEN now() ELSE last_reported_at END
        WHERE id = %s""",
        (
            len(rows), reporters, sev(top), severity, note, status,
            top["ai"].get("summary"), top["ai"].get("department"), top["id"], touch, problem_id,
        ),
    )


def inherit_status(c, problem_id, r):
    """A new report of an issue staff already work on shows that issue's status, not 'received'."""
    lead = c.execute(
        """SELECT gov_status, gov_department FROM civic_reports
           WHERE problem_id = %s AND id <> %s AND gov_status <> 'received'
           ORDER BY gov_updated_at DESC NULLS LAST LIMIT 1""",
        (problem_id, r["id"]),
    ).fetchone()
    if not lead or r["gov_status"] != "received" or lead["gov_status"] in DONE:
        return
    at = r["created_at"].astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    hist = (r.get("gov_status_history") or []) or [{"status": "received", "at": at, "note": None}]
    hist = hist + [{
        "status": lead["gov_status"], "at": at,
        "note": "Others reported this issue too; it is already being handled.",
    }]
    c.execute(
        """UPDATE civic_reports SET gov_status = %s, status = %s, gov_department = coalesce(gov_department, %s),
           gov_status_history = %s, gov_updated_at = now(), gov_updated_by = 'merge' WHERE id = %s""",
        (lead["gov_status"], lead["gov_status"], lead["gov_department"], Jsonb(hist), r["id"]),
    )


def attach(c, report_id, compare=None):
    """Put an analyzed report into a (new or existing) problem. Returns the problem id or None.
    compare(new_row, other_row) -> bool is an optional AI photo comparison (rule 3)."""
    with c.transaction():
        c.execute("SELECT pg_advisory_xact_lock(%s)", (LOCK_KEY,))
        r = c.execute("SELECT * FROM civic_reports WHERE id = %s", (report_id,)).fetchone()
        if not r:
            return None
        if r["problem_id"]:  # already done
            return r["problem_id"]
        ai = r["ai"]
        if not ai or ai.get("valid") is not True:
            return None  # unanalyzed or invalid reports never create or boost a problem

        pid, reason = find_problem(c, r, compare)
        if pid is None:
            n = c.execute("SELECT nextval('civic_problem_seq') AS n").fetchone()["n"]
            pid = f"P-{n}"
            c.execute(
                """INSERT INTO civic_problems
                   (id, category, department, lat, lng, address, summary, first_report_id, top_report_id)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (pid, ai.get("category"), ai.get("department"), r["lat"], r["lng"], r["address"],
                 ai.get("summary"), r["id"], r["id"]),
            )
            counted = True
        else:
            counted = not is_repeat_reporter(c, pid, r)

        c.execute(
            "UPDATE civic_reports SET problem_id = %s, counted = %s, merge_reason = %s WHERE id = %s",
            (pid, counted, reason, r["id"]),
        )
        if reason:
            inherit_status(c, pid, r)
        recompute(c, pid, touch=counted)
        return pid
