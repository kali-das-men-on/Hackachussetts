# Install

Needs Node 22+ and Python 3.11+. Full details are in README.md.

## 1. Try it with demo data (no accounts or keys needed)

```bash
cd frontend && npm install
cp -r ../mock-data /tmp/mock
DATABASE_URL= DATA_DIR=/tmp/mock GOV_DEMO_PIN=246810 node server.js
```

- Resident site: http://127.0.0.1:8610
- Staff dashboard: http://127.0.0.1:8610/gov.html, sign in as `AMH-TMO-9001` / `246810`

There is no AI in this mode; the mock reports already have AI results.

## 2. Full setup with Supabase and the AI

1. Create a Supabase project and an OpenRouter account.
2. `cp .env.example .env` and fill in `DATABASE_URL`, `SUPABASE_SECRET_KEY`, `OPENROUTER_API_KEY`.
3. Create the tables and functions:
   ```bash
   cd frontend && npm install && npm run db:apply -- ../schema/supabase.sql
   ```
4. Start the site (terminal 1):
   ```bash
   cd frontend && node server.js
   ```
5. Start the AI worker (terminal 2):
   ```bash
   python3 -m venv .venv && .venv/bin/pip install -r backend/requirements.txt
   cd backend && ../.venv/bin/python worker.py
   ```

Send a report at http://127.0.0.1:8610. The worker log shows its analysis within about 15 seconds,
and it appears on the staff dashboard. Staff PINs are printed in `data/gov_users.json`
(or set `GOV_DEMO_PIN` in `.env`).

Phones need HTTPS for location and voice notes. Put the server behind an HTTPS proxy
(e.g. `tailscale funnel`, Caddy or nginx) to use it from a phone.

## Run as services (Linux, optional)

`~/.config/systemd/user/hackachussetts-report.service`:

```ini
[Unit]
Description=Hackachussetts site
After=network-online.target
[Service]
WorkingDirectory=/path/to/Hackachussetts/frontend
ExecStart=/usr/bin/node server.js
Restart=on-failure
[Install]
WantedBy=default.target
```

`~/.config/systemd/user/hackachussetts-ai.service`:

```ini
[Unit]
Description=Hackachussetts AI worker
After=network-online.target
[Service]
WorkingDirectory=/path/to/Hackachussetts/backend
ExecStart=/path/to/Hackachussetts/.venv/bin/python worker.py
Environment=PYTHONUNBUFFERED=1
Restart=always
RestartSec=10
[Install]
WantedBy=default.target
```

Then `systemctl --user daemon-reload && systemctl --user enable --now hackachussetts-report hackachussetts-ai`
(and `loginctl enable-linger $USER` so they run without a login).
