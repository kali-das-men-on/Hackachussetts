# Hackachussetts

One-page, phone-first "report an issue" site. Photo, location, optional
description/category, optional email or phone, then **Send**. No account.

Target: a first-time user files a report in under 10 seconds:
tap **Take photo** → shoot → tap **Send report**. Location is requested on the
same tap that opens the camera, so the fix arrives while the user is shooting.

## Run

```bash
node server.js                 # http://127.0.0.1:8610  (PORT, HOST, DATA_DIR, ADMIN_KEY env vars)
```

No dependencies (Node ≥ 20; uses the built-in `Request.formData()` for uploads).

## Where reports go

Stored locally until a database is connected:

| Path | What |
|---|---|
| `data/reports.jsonl` | one report per line, shape = `schema/report.schema.json` |
| `data/photos/R-xxxx.jpg` | photo, resized to ≤1280 px and EXIF-stripped on the phone |
| `data/admin_key` | key for the admin views (created on first run) |

`schema/schema.sql` is the matching table for Postgres/SQLite. To move to a
database, replace `store.js` (`init`, `findByClientId`, `insert`, `list`).

## See all the reports

Every submitted report is visible three ways. The admin key is printed to the
console on startup and saved to `data/admin_key` (override with the `ADMIN_KEY`
env var).

| View | URL | What you get |
|---|---|---|
| Admin table | `GET /admin?key=KEY` | HTML table of every report with photo thumbnails, location (linked to OpenStreetMap), category, description and contact |
| JSON (Node) | `GET /api/reports?key=KEY` | all reports as a JSON array, newest first |
| Photo | `GET /admin/photos/R-xxxx.jpg?key=KEY` | the stored photo for one report |

```bash
# local
open "http://127.0.0.1:8610/admin?key=$(cat data/admin_key)"

# on the Pi (public URL)
open "https://raspberrypi-1.tail4620bc.ts.net:10000/admin?key=KEY"
```

Raw data lives in `data/reports.jsonl` (one report per line) with photos in
`data/photos/` — you can read these directly or with the FastAPI backend below.

## API

```
POST /api/reports   multipart/form-data
  photo             file     required (JPEG/PNG/WebP, ≤ 8 MB)
  client_report_id  string   required, UUID from the device (dedupes retries)
  lat, lng          number   required unless `address` is given
  accuracy_m        number
  location_source   gps | map | address
  address           string   ≤ 300
  description       string   ≤ 500
  category          pothole | streetlight | trash | graffiti | sidewalk | other
  contact           string   email or phone
  submitted_at, device_id, queued
→ 201 { "id": "R-1001", "status": "received" }
→ 200 { ..., "duplicate": true }   same client_report_id sent again

POST /api/reports?fail=1   forced 503 (or open the page with ?fail=1)
GET  /admin?key=KEY        table of reports with photos
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
```

Env: `DATA_DIR` (default `./data`) points at the data the Node server writes;
set `ADMIN_KEY` to require `?key=` on the routes (matches the Node server; unset
= open, for local dev). When reports move to a database, swap the three
functions in the "data access" block of `api/main.py` — the models and routes
stay the same.

## Failure handling

- Location denied / 8 s timeout → address box + "Pick on map" (Leaflet, loaded only then). Never blocks sending.
- Offline / network error → report saved in `localStorage`, resent automatically when back online (dedupe by `client_report_id`).
- Server error → banner + **Retry**, photo kept.
- Double tap on Send → button disabled while sending.

## Hosting on the Pi

```bash
systemctl --user status hackachussetts-report        # ~/.config/systemd/user/hackachussetts-report.service
sudo tailscale funnel --bg --https=10000 http://127.0.0.1:8610
```

Public URL (works without Tailscale): https://raspberrypi-1.tail4620bc.ts.net:10000/ — QR code in `report-qr.png`.
