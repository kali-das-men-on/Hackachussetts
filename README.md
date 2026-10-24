# Hackachussetts

One-page, phone-first "report an issue" site. Photo, location, optional
description and/or 30-second voice note, optional email or phone, then
**Send**. No account. There is no category picker: the category is left empty
and is meant to be filled in later by AI analysis of the description.

Target: a first-time user files a report in under 10 seconds:
tap **Take photo** → shoot → tap **Send report**. Location is requested on the
same tap that opens the camera, so the fix arrives while the user is shooting.

## Run

```bash
cd frontend && npm install && node server.js  # http://127.0.0.1:8610  (PORT, HOST, DATA_DIR, ADMIN_KEY env vars)
```

Node ≥ 22. The server reads the repo-root `.env`, the same file `backend/main.py` uses:

| `.env` | Reports go to |
|---|---|
| `DATABASE_URL=postgresql://...` (or `postgresql+psycopg://...`) plus `SUPABASE_SECRET_KEY=sb_secret_...` | **Supabase**: rows in `civic_reports`, photos and voice notes in the private Storage bucket `civic-reports` |
| no Postgres `DATABASE_URL` | local files in `data/` |

`DATABASE_URL= node server.js` forces the local file store. `GET /healthz` shows which store is in use.
The Node server does not run the AI agent; `ai` is filled in only for reports sent through `backend/main.py`.

## Two panels

The page has two tabs (`#report` and `#issues`, so links and the back button work):

- **Report an issue**: the form described above.
- **Issues near me**: the public issues board.
  - **Nearby** lists issues within 5 km, closest first (uses the same location
    permission as the form). **Recent** lists the newest issues. Filter by
    All / Open / Fixed. A map shows one dot per issue, coloured by status.
  - Each issue shows its photo, category, address, a status badge, a 5-step
    progress bar and, when tapped, a timeline of status changes with the
    town's public notes.
  - **Check my reports**: type the email or phone used on a report to see
    those reports and their status. After sending a report, **Track its status**
    opens this lookup with the contact already filled in.

The board never shows contact details, device ids or voice notes. The server
builds the public view from a fixed list of fields (`publicIssue()` in
`frontend/server.js`, `civic_public_json()` in `schema/supabase.sql`). Lookups
use POST so the email does not end up in URLs or logs, and are limited to 20
per 10 minutes per client.

### Statuses

| Status | Shown as | Meaning |
|---|---|---|
| `received` | Received | New report |
| `in_review` | Under review | Staff are looking at it |
| `assigned` | Crew assigned | A crew or department has the job |
| `in_progress` | Being fixed | Work has started |
| `resolved` | Fixed | Done |
| `rejected` | Closed | Closed without a fix (the note says why) |

Every change is appended to the report's `gov.status_history` (`[{status, at, note}]`).
Staff change the `gov` fields from the admin table (`/admin?key=KEY`: status, department,
severity, a public note and internal notes per report, next to the AI's analysis) or with
`POST /api/reports/R-xxxx/status?key=KEY` and a JSON body with any of
`status`, `note`, `department`, `severity_score`, `internal_notes`, `updated_by`.
The note is public (timeline and `gov.feedback`); internal notes are never public.

### Mock data

`mock-data/` holds 18 made-up reports (R-2001 to R-2018) around Amherst,
Northampton and Boston, in every status, with placeholder photos. All contacts
are `@example.com`. Use **`demo@example.com`** in "Check my reports" to see 5 of them.

```bash
cp -r mock-data /tmp/mock && cd frontend && DATA_DIR=/tmp/mock ADMIN_KEY=test node server.js
# open http://127.0.0.1:8610/#issues
```

Copy the folder first, because status changes and new reports are written into it.
Regenerate with `python3 scripts/make_mock_data.py` (needs Pillow). The script
also writes `mock-data/seed.sql`, the same reports as SQL for Supabase.

### Supabase

`schema/supabase.sql` is the working schema and is applied to the live project. It is safe to re-run:

```bash
cd frontend && npm run db:schema      # or: psql "$DATABASE_URL" -f schema/supabase.sql
```

**Report shape** (`schema/report.schema.json`, returned by `GET /api/reports` on both servers):

```
{ id, client_report_id, created_at,
  user: { submitted_at, photo{path,mime,bytes}, audio{path,mime,bytes,duration_s}|null,
          description, category, location{lat,lng,accuracy_m,source,address},
          contact{email,phone}, meta{device_id,user_agent,was_queued_offline} },
  ai:   { processed_at, model, taxonomy_version, valid, valid_checks{...}, valid_reason, evidence[],
          category, category_reason, department, department_reason,
          severity_score ("0"-"100"), severity_reason, summary } | null,
  gov:  { status, department, severity_score, feedback, internal_notes, updated_by, updated_at,
          status_history[{status, at, note}] } }
```

**Table `civic_reports`**: one row per report. `user` is flat columns, `ai` is one jsonb column, `gov` is `gov_*` columns.

| JSON | Column(s) |
|---|---|
| `id` | `id` text PK, `R-` + `civic_report_seq` (starts 1001) |
| `client_report_id` | `client_report_id`, unique index |
| `user.photo` / `user.audio` | `photo_path, photo_mime, photo_bytes` / `audio_path, audio_mime, audio_bytes, audio_duration_s` |
| `user.location` | `lat, lng, accuracy_m, location_source, address` |
| `user.description`, `user.category`, `user.submitted_at` | same names |
| `user.contact` | `contact_email, contact_phone` |
| `user.meta` | `device_id, user_agent, was_queued_offline` |
| `ai` | `ai` jsonb, written by `backend/agent.py` |
| `gov.*` | `gov_status, gov_department, gov_severity_score` (int), `gov_feedback, gov_internal_notes, gov_updated_by, gov_updated_at, gov_status_history` (jsonb) |
| (legacy) | `status` (kept equal to `gov_status`), `ai_summary` (unused) |

Checks: `gov_status`, `gov_department` and `location_source` must be one of their allowed values,
and `gov_severity_score` must be 0-100. Every column has a `COMMENT`, so the Supabase table editor
shows what it holds.

**Files**: private Storage bucket `civic-reports`, keys `photos/<id>.<ext>` and `audio/<id>.<ext>`
(the `path` values above). Both servers use the secret key for these.

**Functions:**

| Function | Used by | Returns | `anon` can call |
|---|---|---|---|
| `civic_report_json(row)` | `GET /api/reports`, admin | full report (includes contact) | no |
| `public_issues(lat, lng, radius_km, status_filter, max_rows)` | `GET /api/issues` | public fields only | yes |
| `lookup_issues(contact)` | `POST /api/issues/lookup` | that reporter's issues, public fields only | no (rate-limited on the server) |
| `set_report_gov(id, changes jsonb)` | `POST /api/reports/{id}/status` | updated full report | no |

RLS is on with no policies, so the public REST API cannot read the table. The public board shows
`id, created_at, updated_at, status, status_history, category` (the AI's, else the reporter's),
`description, location{lat,lng,address}, photo_url`. It never shows contact details, device id,
the voice note, AI reasons or internal notes.

`npm run db:apply -- FILE.sql` runs any SQL file against `DATABASE_URL` in one transaction
(for machines without `psql`).

## Town staff dashboard

`/gov.html` (or `/gov`), served by the same Node server. Staff sign in with a government ID and PIN, then see:

- **List** of reports ranked by the AI, highest first. Each one shows the photo, priority (P1-P4),
  whether the AI found it valid, the status, and "Past target" when it's overdue.
  Click a report for the AI's reasoning, the MA rule that applies, the AI's suggested department,
  a rough budget estimate and the action buttons.
- **Map** with one dot per report, coloured by priority. Clicking a dot selects the report in the list.
- **Actions:** **In progress**, **Complete** or **Invalid**, each with an optional public note to the
  reporter. Invalid requires a note. These set `gov.status` to `in_progress` / `resolved` / `rejected`,
  add a step to `gov.status_history` with `updated_by` = the staff ID, and show up on the public issues board.
  If no department is assigned yet, In progress assigns the AI's suggested department.
- **Filters:** Open / Closed / All, "Only my department" (on by default for department accounts), and search.
- **Criteria** button: the full rules below.

### Fake government IDs

These are demo accounts only, defined in `frontend/gov.js`.

| Government ID | Name | Role | Default filter |
|---|---|---|---|
| `AMH-DPW-1001` | Dana Rivera | DPW Operations Supervisor | Public Works |
| `AMH-DPW-1002` | Chris Okafor | DPW Highway Foreman | Public Works |
| `AMH-PRK-2001` | Priya Shah | Parks & Recreation Coordinator | Parks & Recreation |
| `AMH-HLT-3001` | Morgan Lee | Health Inspector | Health & Inspections |
| `AMH-TMO-9001` | Alex Chen | Town Manager's Office | all departments |

**PINs:** if `GOV_DEMO_PIN` is set, every account uses that PIN. Otherwise each account gets a
random 6-digit PIN on first run, saved in `data/gov_users.json` (or `$DATA_DIR/gov_users.json`;
mode 600, git-ignored). Sessions are HttpOnly, SameSite=Strict cookies that last 8 hours and are
held in memory, so restarting the server signs everyone out. Logins are limited to 10 attempts
per 10 minutes, both per client and per ID.

### Run locally

```bash
# Demo data (18 mock reports with AI analysis), no database touched:
cp -r mock-data /tmp/mock
cd frontend && DATABASE_URL= DATA_DIR=/tmp/mock GOV_DEMO_PIN=246810 node server.js
# open http://127.0.0.1:8610/gov.html, sign in as AMH-TMO-9001 / 246810

# Real reports in Supabase (actions change the live rows):
cd frontend && GOV_DEMO_PIN=246810 PORT=8611 node server.js     # http://127.0.0.1:8611/gov.html
```

Copy `mock-data/` first, because actions are written back into it. `python3 scripts/make_mock_data.py`
regenerates it, including `mock-data/seed.sql` (the same reports for Supabase; not applied to the live project).

### How reports are judged (Massachusetts)

Rules are in `frontend/gov-criteria.js`. The AI's checks and score come from `backend/agent.py` (`backend/prompts.py`).

**Valid** = all three AI checks pass:

| Check | Rule |
|---|---|
| Photo shows the problem | Clear photo of a real defect that matches the text |
| Inside town limits | State highways go to MassDOT (857-368-4636), DCR parkways to DCR |
| Town responsibility | Public way, sidewalk, streetlight, park or public property. Private property goes to the owner or code enforcement |

**How serious**: severity 0-100 (the staff score if set, else the AI's) gives the priority:

| Priority | Severity | Respond |
|---|---|---|
| P1 Urgent | 80-100 | within 24 hours (imminent danger: 911) |
| P2 High | 60-79 | within 2 business days |
| P3 Medium | 40-59 | within 10 business days |
| P4 Low | 0-39 | with routine scheduled work |

| Category | MA rule shown to staff | Target ("past target" after) |
|---|---|---|
| Pothole | M.G.L. c.84 §15: the town is liable for defects in a public way once it has notice, up to $5,000 per claim | 1 business day (Boston CityScore) |
| Sidewalk | 521 CMR 22: no level change over ¼ in, 36 in clear path; also c.84 §15 | make safe in 2 days |
| Streetlight | dark crossings, bus stops and school routes first | 10 business days (Boston CityScore) |
| Trash | M.G.L. c.270 §16: dumping on public ways or land, fine up to $5,500 | 24 hours (Boston CityScore) |
| Graffiti | usually cosmetic; offensive content right away | 45 business days (Boston CityScore) |
| Other | blocked sidewalk breaks the 36 in path (521 CMR 22); public trees, M.G.L. c.87 | 5 business days (Boston parks target) |

**AI rank** = severity + up to 15 points for days open + 10 if past target. Reports the AI marks
not valid are multiplied by 0.4, and reports the AI hasn't analyzed yet count as severity 30.

**Budget** is a rough planning range for one job, by category and severity band (<40, 40-79, 80+),
for example a pothole is $100-$300 (cold patch), $300-$1,500 (hot-mix patch) or $5,000-$25,000
(mill and overlay). It is not a quote. Replace the numbers in `CATEGORY` in `gov-criteria.js` with your DPW's unit prices.

### API

```
POST /api/gov/login                  {"id", "pin"} -> Set-Cookie gov_session
POST /api/gov/logout
GET  /api/gov/me
GET  /api/gov/reports?status=open|closed|all   reports (schema/report.schema.json, minus user.meta)
                                     + "assessment": {rank, rank_reason, priority, suggested_department,
                                       budget, criteria, due_at, overdue}
POST /api/gov/reports/R-xxxx/action  {"action": "in_progress"|"complete"|"invalid", "note"}
GET  /api/gov/media/photos/R-xxxx.jpg, /api/gov/media/audio/R-xxxx.webm
```

All `/api/gov/*` routes except login need the session cookie. POST bodies must be JSON
(`Content-Type: application/json`), which together with SameSite=Strict blocks cross-site form posts.

## Project layout

| Folder / file | What |
|---|---|
| `frontend/` | **Everything for the site**: the Node server (`server.js`; `gov.js` + `gov-criteria.js` for the staff dashboard; `store.js` picks `store-supabase.js` or `store-file.js`; `report-shape.js`, `env.js`, `db-apply.js`) and the browser files |
| `frontend/public/` | What the browser downloads: `index.html`, `app.js` (report form), `issues.js` (issues board), `style.css`, `icon.svg`; `gov.html`, `gov-app.js`, `gov.css` (staff dashboard). Only this folder is served, so the server code is not exposed. |
| `api/` | FastAPI backend (Python), reads the stored reports |
| `backend/` | FastAPI backend on Supabase (`main.py`), maintained separately |
| `schema/` | JSON Schema and SQL for a report; `supabase.sql` for the issues board |
| `mock-data/` | Made-up reports for the issues board, plus `seed.sql` (generated by `scripts/make_mock_data.py`) |
| `data/` | Stored reports, photos and audio, shared with `api/` (git-ignored) |

## Where reports go

With Supabase configured (see above), in `civic_reports` and the `civic-reports` bucket.
Without it, locally:

| Path | What |
|---|---|
| `data/reports.jsonl` | one report per line, shape = `schema/report.schema.json`. Lines in the older flat shape are converted when read and rewritten on the next update |
| `data/photos/R-xxxx.jpg` | photo, resized to ≤1280 px and EXIF-stripped on the phone |
| `data/audio/R-xxxx.webm` | optional voice note, ≤ 30 s (`.webm` from Chrome/Firefox, `.m4a` from Safari) |
| `data/admin_key` | key for the admin views (created on first run, in both modes) |
| `data/gov_users.json` | staff dashboard PINs (created on first run unless `GOV_DEMO_PIN` is set) |

`api/` (the read-only FastAPI app) still expects the older flat shape and has not been updated.

### Sample data for testing

`data/` is git-ignored because the live site writes real reports and the admin
key there. `sample-data/` is a committed snapshot of the test reports (6 reports
with photos, one with a voice note), same layout as `data/`. It includes the
contact details entered while testing; it does not include `admin_key`.

```bash
cd frontend && DATA_DIR=../sample-data ADMIN_KEY=test node server.js   # admin: /admin?key=test
DATA_DIR=sample-data ADMIN_KEY=test uvicorn api.main:app --port 8620    # FastAPI, from the repo root
```

Set `ADMIN_KEY` when pointing at `sample-data/`; otherwise the server writes an
`admin_key` file into it. New reports sent to that server are written there too,
so copy the folder first if you want to keep it pristine.

## See all the reports

Every submitted report is visible three ways. The admin key is printed to the
console on startup and saved to `data/admin_key` (override with the `ADMIN_KEY`
env var).

| View | URL | What you get |
|---|---|---|
| Admin table | `GET /admin?key=KEY` | HTML table of every report with photo thumbnails, location (linked to OpenStreetMap), description, a player for the voice note, and contact |
| JSON (Node) | `GET /api/reports?key=KEY` | all reports as a JSON array, newest first |
| Photo | `GET /admin/photos/R-xxxx.jpg?key=KEY` | the stored photo for one report |
| Voice note | `GET /admin/audio/R-xxxx.webm?key=KEY` | the stored audio for one report (supports HTTP Range) |

```bash
# local
open "http://127.0.0.1:8610/admin?key=$(cat data/admin_key)"

# on the Pi (public URL)
open "https://raspberrypi-1.tail4620bc.ts.net:10000/admin?key=KEY"
```

Raw data lives in `data/reports.jsonl` (one report per line) with photos in
`data/photos/` and voice notes in `data/audio/`. You can read these directly or
with the FastAPI backend below.

## API

```
POST /api/reports   multipart/form-data
  photo             file     required (JPEG/PNG/WebP, ≤ 8 MB)
  audio             file     optional voice note, ≤ 30 s and ≤ 3 MB
                             (WebM, MP4/M4A, Ogg, MP3 or WAV; type is checked from the file bytes)
  audio_duration_s  number   length of `audio` in seconds, as measured on the device; > 31 is rejected
  client_report_id  string   required, UUID from the device (dedupes retries)
  lat, lng          number   required unless `address` is given
  accuracy_m        number
  location_source   gps | map | address
  address           string   ≤ 300
  description       string   ≤ 500
  contact           string   email or phone
  submitted_at, device_id, queued
→ 201 { "id": "R-1001", "status": "received" }
→ 200 { ..., "duplicate": true }   same client_report_id sent again
→ 400 bad audio type, audio longer than 30 s, missing photo/location, bad contact
→ 413 photo over 8 MB or audio over 3 MB

There is no `category` field. A stray `category` is ignored and the stored
report always has `"category": null`, to be filled in by AI analysis of the
description. The server cannot decode audio, so the 30 s limit relies on
`audio_duration_s` from the device; the 3 MB cap is the hard limit.

POST /api/reports?fail=1   forced 503 (or open the page with ?fail=1)
GET  /admin?key=KEY        table of reports with photos and voice notes
GET  /api/reports?key=KEY  all reports as JSON
```

## FastAPI backend (Python)

The stored reports are ready to read from Python: `api/` is a read-only FastAPI
app that parses the same `data/reports.jsonl` and serves photos from
`data/photos/`, so you can build on the reports without migrating anything.

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
uvicorn api.main:app --reload --port 8620      # docs at http://127.0.0.1:8620/docs
```

| File | What |
|---|---|
| `api/models.py` | Pydantic v2 models, 1:1 with `schema/report.schema.json` |
| `api/main.py` | FastAPI app — reads `reports.jsonl`, serves reports + photos |
| `requirements.txt` | pinned `fastapi`, `uvicorn`, `pydantic` |

```
GET /healthz                        { "ok": true, "reports": N }
GET /api/reports[?key=KEY]          all reports, newest first (list[Report])
GET /api/reports/{id}[?key=KEY]     one report
GET /api/reports/{id}/photo[?key=KEY]   the stored photo
GET /api/reports/{id}/audio[?key=KEY]   the voice note (404 if the report has none)
```

Env: `DATA_DIR` (default `./data`) points at the data the Node server writes;
set `ADMIN_KEY` to require `?key=` on the routes (matches the Node server; unset
= open, for local dev). When reports move to a database, swap the three
functions in the "data access" block of `api/main.py` — the models and routes
stay the same.

## Failure handling

- Typed address: the address box is always shown. Suggestions drop down while typing (Photon, an OpenStreetMap geocoder built for autocomplete; nearby places first, debounced, one request per pause); picking one moves the map pin. **Find** (or Enter, or leaving the box) looks it up with Nominatim and moves the map pin there; other matches are listed to pick from. If the lookup fails, the address is sent as typed. Moving the pin updates the box to the pin's address. Lookups run only on those actions, not on every keystroke, as Nominatim's usage policy requires.
- Location denied / 8 s timeout → type an address or "Pick on map" (Leaflet, loaded only then). Never blocks sending.
- Offline / network error → report saved in `localStorage` (photo and voice note included), resent automatically when back online (dedupe by `client_report_id`).
- Server error → banner + **Retry**, photo and voice note kept.
- Double tap on Send → button disabled while sending.
- Voice note: needs HTTPS and a browser with `MediaRecorder`; otherwise the recorder is hidden. Mic blocked → inline message, the report can still be sent. Recording stops itself at 30 s, and is finished automatically if Send is tapped mid-recording.

## Hosting on the Pi

```bash
systemctl --user status hackachussetts-report        # ~/.config/systemd/user/hackachussetts-report.service
sudo tailscale funnel --bg --https=10000 http://127.0.0.1:8610
```

Public URL (works without Tailscale): https://raspberrypi-1.tail4620bc.ts.net:10000/ — QR code in `report-qr.png`.
