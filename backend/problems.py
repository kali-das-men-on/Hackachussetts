"""Merging reports of the same problem, and the crowd-based severity boost.

Every valid report belongs to exactly one *problem* (a row in civic_problems).
A new report joins an existing problem when all of these hold:
  - same department AND same category (the department follows from the
    category, see prompts.py),
  - within MERGE_RADIUS_M metres (50) of ANY report already in the problem, so
    GPS noise on a phone can't split reports of one real-world issue,
  - within MAX_SPAN_M metres (150) of the problem's first report, so a long
    street of separate potholes can't chain into one giant problem,
  - the problem is open and was last reported within MERGE_WINDOW_DAYS.
Otherwise it starts a new problem. Reports without coordinates (address only)
can't be matched by distance, so they always start their own problem.
Category "other" (the catch-all that goes to human review) never auto-merges.

Severity of a problem = the highest AI severity among its reports, plus
BUMP_PER_REPORTER for each additional *separate* reporter, with that bonus
capped at MAX_CROWD_BONUS (and the total capped at 100). A report from the
same device / email / phone, or with an identical photo, still joins the
problem but does not count as a separate reporter, so one person (or a bot)
can't inflate a score by sending the same thing many times.

Reports the AI marks invalid, or that the AI never analyzed, are not attached
at all, so junk can't create or boost a problem.

All functions take an open psycopg connection `c` (dict rows, autocommit).
"""
import math
import os


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except ValueError:
        return default


MERGE_RADIUS_M = _int_env("MERGE_RADIUS_M", 50)
MAX_SPAN_M = _int_env("MAX_PROBLEM_SPAN_M", 150)
NEVER_MERGE = {"other"}  # catch-all category: unrelated issues must not be merged or boosted together
MERGE_WINDOW_DAYS = _int_env("MERGE_WINDOW_DAYS", 45)
BUMP_PER_REPORTER = _int_env("BUMP_PER_REPORTER", 5)
MAX_CROWD_BONUS = _int_env("MAX_CROWD_BONUS", 30)

# Postgres advisory-lock key: attaching reports one at a time stops two reports
# of a brand-new problem, arriving together, from creating two problems.
LOCK_KEY = 7421001


def haversine_m(lat1, lng1, lat2, lng2) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi, dlmb = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def crowd_severity(base: int, reporters: int) -> tuple[int, str]:
    """(problem severity 0-100, plain-language note) from the top AI score and reporter count."""
    bonus = min(MAX_CROWD_BONUS, BUMP_PER_REPORTER * max(0, reporters - 1))
    severity = max(0, min(100, int(base) + bonus))
    note = f"Highest AI score {base}"
    if bonus:
        note += f", +{bonus} for {reporters} separate reporters"
    return severity, note + f" = {severity}"


def nearest_open_problem(c, category, department, lat, lng):
    """The open problem with the same department + category that has a report within the merge
    radius of this point (the closest wins), or None."""
    if lat is None or lng is None or not category or not department or category in NEVER_MERGE:
        return None
    dlat = MERGE_RADIUS_M / 111_320.0
    dlng = MERGE_RADIUS_M / (111_320.0 * max(0.2, math.cos(math.radians(lat))))
    rows = c.execute(
        """SELECT p.id, p.lat AS plat, p.lng AS plng, r.lat AS rlat, r.lng AS rlng
           FROM civic_problems p JOIN civic_reports r ON r.problem_id = p.id
           WHERE p.status = 'open' AND p.category = %s AND p.department = %s
             AND p.last_reported_at > now() - make_interval(days => %s)
             AND r.lat BETWEEN %s AND %s AND r.lng BETWEEN %s AND %s""",
        (category, department, MERGE_WINDOW_DAYS, lat - dlat, lat + dlat, lng - dlng, lng + dlng),
    ).fetchall()
    best = None
    for row in rows:
        d = haversine_m(lat, lng, row["rlat"], row["rlng"])
        if d > MERGE_RADIUS_M:
            continue
        if row["plat"] is not None and haversine_m(lat, lng, row["plat"], row["plng"]) > MAX_SPAN_M:
            continue
        if best is None or (d, row["id"]) < best:
            best = (d, row["id"])
    return {"id": best[1]} if best else None


def is_repeat_reporter(c, problem_id, r) -> bool:
    """True if someone with the same device / email / phone / photo already reported this problem."""
    row = c.execute(
        """SELECT 1 FROM civic_reports
        WHERE problem_id = %(pid)s AND id <> %(rid)s AND (
                (%(dev)s::text IS NOT NULL AND device_id = %(dev)s)
        OR (%(em)s::text  IS NOT NULL AND lower(contact_email) = lower(%(em)s))
        OR (%(ph)s::text  IS NOT NULL AND contact_phone = %(ph)s)
        OR (%(sha)s::text IS NOT NULL AND photo_sha256 = %(sha)s)
        ) LIMIT 1""",
        {
            "pid": problem_id, "rid": r["id"], "dev": r["device_id"], "em": r["contact_email"],
            "ph": r["contact_phone"], "sha": r["photo_sha256"],
        },
    ).fetchone()
    return row is not None


def recompute(c, problem_id, touch: bool):
    """Rebuild a problem's totals and severity from its member reports."""
    rows = c.execute(
        "SELECT id, counted, ai FROM civic_reports WHERE problem_id = %s ORDER BY created_at, id",
        (problem_id,),
    ).fetchall()
    sev = lambda row: int(row["ai"]["severity_score"])  # noqa: E731
    top = rows[0]
    for row in rows[1:]:
        if sev(row) > sev(top):
            top = row
    reporters = sum(1 for row in rows if row["counted"])
    severity, note = crowd_severity(sev(top), reporters)
    c.execute(
        """UPDATE civic_problems SET
        report_count = %s, reporter_count = %s, base_severity = %s,
        severity_score = %s, severity_note = %s,
        summary = %s, department = %s, top_report_id = %s,
        last_reported_at = CASE WHEN %s THEN now() ELSE last_reported_at END
        WHERE id = %s""",
        (
            len(rows), reporters, sev(top), severity, note,
            top["ai"].get("summary"), top["ai"].get("department"), top["id"], touch, problem_id,
        ),
    )


def attach(c, report_id):
    """Put an analyzed report into a (new or existing) problem. Returns the problem id or None."""
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

        p = nearest_open_problem(c, ai.get("category"), ai.get("department"), r["lat"], r["lng"])
        if p is None:
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
            pid = p["id"]
            counted = not is_repeat_reporter(c, pid, r)

        c.execute("UPDATE civic_reports SET problem_id = %s, counted = %s WHERE id = %s", (pid, counted, r["id"]))
        recompute(c, pid, touch=counted)
        return pid
