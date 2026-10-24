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
cd frontend && node server.js  # http://127.0.0.1:8610  (PORT, HOST, DATA_DIR, ADMIN_KEY env vars)
```

No dependencies (Node ≥ 20; uses the built-in `Request.formData()` for uploads).

## Project layout

| Folder / file | What |
|---|---|
| `frontend/` | **Everything for the site**: the Node server (`server.js`, `store.js`, `package.json`) and the browser files |
| `frontend/public/` | What the browser downloads: `index.html`, `app.js`, `style.css`, `icon.svg`. Only this folder is served, so the server code is not exposed. |
| `api/` | FastAPI backend (Python), reads the stored reports |
| `schema/` | JSON Schema and SQL for a report |
| `data/` | Stored reports, photos and audio, shared with `api/` (git-ignored) |

## Where reports go

Stored locally until a database is connected:

| Path | What |
|---|---|
| `data/reports.jsonl` | one report per line, shape = `schema/report.schema.json` |
| `data/photos/R-xxxx.jpg` | photo, resized to ≤1280 px and EXIF-stripped on the phone |
| `data/audio/R-xxxx.webm` | optional voice note, ≤ 30 s (`.webm` from Chrome/Firefox, `.m4a` from Safari) |
| `data/admin_key` | key for the admin views (created on first run) |

`schema/schema.sql` is the matching table for Postgres/SQLite. To move to a
database, replace `frontend/store.js` (`init`, `findByClientId`, `insert`, `list`).

### Sample data for testing

`data/` is git-ignored because it holds real reports (contact details, device
ids, photos) and the admin key. `sample-data/` is a cleaned copy that is safe to
share: same layout as `data/`, 4 reports (one with a voice note), no contact
details, device ids or admin key, and the voice note is a synthetic tone.

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

- Location denied / 8 s timeout → address box + "Pick on map" (Leaflet, loaded only then). Never blocks sending.
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
