"""AI worker: analyzes reports that have no `ai` yet.

The public site (frontend/server.js) saves reports to Supabase but does not call
the model. This process polls civic_reports for rows where `ai` is null,
downloads the photo and voice note from Storage, runs agent.run_agent, saves the
result in `ai`, then merges the report into a problem (problems.attach). These
are the same steps backend/main.py runs after its own POST /api/reports.

Run (from the repo root):  .venv/bin/python backend/worker.py
Service on the Pi:         systemctl --user status hackachussetts-ai

Env (read from the repo-root .env, like main.py):
  DATABASE_URL, SUPABASE_SECRET_KEY, OPENROUTER_API_KEY, OPENROUTER_MODEL
  AI_POLL_SECONDS   how often to look for new reports (default 5)
  AI_BACKLOG_HOURS  only reports newer than this are analyzed (default 48)
  AI_MAX_ATTEMPTS   tries per report before giving up until restart (default 3)
  AI_MAX_PER_HOUR   model calls per hour, a spend brake (default 120)
"""
import hashlib
import signal
import sys
import time
import traceback

import main  # loads .env; provides db(), ready(), storage_download()
import agent
import problems
from psycopg.types.json import Jsonb

POLL = problems._int_env("AI_POLL_SECONDS", 5)
BACKLOG_HOURS = problems._int_env("AI_BACKLOG_HOURS", 48)
MAX_ATTEMPTS = problems._int_env("AI_MAX_ATTEMPTS", 3)
MAX_PER_HOUR = problems._int_env("AI_MAX_PER_HOUR", 120)

failures: dict[str, tuple[int, float]] = {}  # report id -> (attempts, retry after)
calls: list[float] = []  # times of recent model calls
stopping = False


class PhotoMissing(Exception):
    """The row's photo is not in the bucket; retrying won't help."""


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def pending(c):
    return c.execute(
        """SELECT id FROM civic_reports
           WHERE ai IS NULL AND created_at > now() - make_interval(hours => %s)
           ORDER BY created_at""",
        (BACKLOG_HOURS,),
    ).fetchall()


def analyze(rid: str):
    with main.db() as c:
        r = c.execute("SELECT * FROM civic_reports WHERE id = %s AND ai IS NULL", (rid,)).fetchone()
    if not r:
        return  # analyzed meanwhile (e.g. by backend/main.py)

    try:
        photo = main.storage_download(r["photo_path"])
    except RuntimeError as e:
        if "not_found" in str(e):
            raise PhotoMissing(f"photo {r['photo_path']} is not in Storage") from None
        raise
    audio = audio_format = None
    if r["audio_path"]:
        try:
            audio = main.storage_download(r["audio_path"])
            audio_format = r["audio_path"].rsplit(".", 1)[-1]
        except Exception as e:  # the report can still be judged from the photo and text
            log(f"{rid}: voice note not loaded ({e})")

    calls.append(time.time())
    ai = agent.run_agent(
        photo_bytes=photo, photo_mime=r["photo_mime"], description=r["description"],
        audio=audio, audio_format=audio_format,
        lat=r["lat"], lng=r["lng"], accuracy_m=r["accuracy_m"],
        location_source=r["location_source"], address=r["address"], category=r["category"],
    )
    with main.db() as c:
        c.execute(
            "UPDATE civic_reports SET ai = %s, photo_sha256 = coalesce(photo_sha256, %s), photo_dhash = %s WHERE id = %s AND ai IS NULL",
            (Jsonb(ai), hashlib.sha256(photo).hexdigest(), problems.photo_dhash(photo), rid),
        )
        pid = problems.attach(c, rid, compare=make_comparer({rid: photo}))
        why = c.execute("SELECT merge_reason FROM civic_reports WHERE id = %s", (rid,)).fetchone()["merge_reason"]
    log(f"{rid}: valid={ai['valid']} category={ai['category']} severity={ai['severity_score']} "
        f"problem={pid}{f' ({why})' if why else ' (new)' if pid else ''}")


def make_comparer(photos: dict):
    """compare(new_row, other_row) for problems.attach: asks the AI if two photos show one issue.
    `photos` caches downloaded photos by report id."""
    def photo_of(row):
        if row["id"] not in photos:
            photos[row["id"]] = main.storage_download(row["photo_path"])
        return photos[row["id"]]

    def compare(r, m):
        calls.append(time.time())
        d = problems.haversine_m(r["lat"], r["lng"], m["lat"], m["lng"])
        same = agent.same_issue(
            photo_a=photo_of(r), mime_a=r["photo_mime"], photo_b=photo_of(m), mime_b=m["photo_mime"],
            text_a=r["description"], text_b=m["description"], distance_m=d,
        )
        log(f"{r['id']} vs {m['id']} ({round(d)} m): AI says {'same' if same else 'different'} issue")
        return same

    return compare


def tick():
    with main.db() as c:
        rows = pending(c)
    now = time.time()
    for row in rows:
        if stopping:
            return
        rid = row["id"]
        attempts, retry_at = failures.get(rid, (0, 0))
        if attempts >= MAX_ATTEMPTS or now < retry_at:
            continue
        calls[:] = [t for t in calls if now - t < 3600]
        if len(calls) >= MAX_PER_HOUR:
            log(f"hourly limit of {MAX_PER_HOUR} model calls reached; waiting")
            return
        try:
            analyze(rid)
            failures.pop(rid, None)
        except PhotoMissing as e:
            failures[rid] = (MAX_ATTEMPTS, 0)
            log(f"{rid}: skipped, {e}")
        except Exception as e:
            attempts += 1
            failures[rid] = (attempts, time.time() + 60 * attempts)
            final = " (giving up until restart)" if attempts >= MAX_ATTEMPTS else ""
            log(f"{rid}: attempt {attempts} failed: {type(e).__name__}: {str(e)[:200]}{final}")


def stop(*_):
    global stopping
    stopping = True


def run():
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    if not agent._api_key():
        sys.exit("OPENROUTER_API_KEY is not set in .env")
    main.ready()
    log(f"AI worker started: model {agent.MODEL}, polling every {POLL}s, backlog {BACKLOG_HOURS}h")
    while not stopping:
        try:
            tick()
        except Exception:
            log("poll failed:")
            traceback.print_exc()
        for _ in range(POLL * 10):
            if stopping:
                break
            time.sleep(0.1)
    log("AI worker stopped")


if __name__ == "__main__":
    run()
