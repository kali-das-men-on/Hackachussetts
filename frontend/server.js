// Report-an-issue server. Node 22's built-in Request.formData() parses the multipart upload;
// the only dependency is `pg`, for Supabase.
//
// Storage: reads the repo-root .env. With a Postgres DATABASE_URL, reports go to Supabase
// (Postgres + Storage, same table as backend/main.py); otherwise to local files in DATA_DIR.
// Report JSON = schema/report.schema.json: { id, client_report_id, created_at, user, ai, gov }.
//
//   node server.js            listens on 127.0.0.1:${PORT:-8610}
//   POST /api/reports         multipart form, see README / schema/
//   POST /api/reports?fail=1  forced 503, for testing the retry path
//   GET  /admin?key=...       list of stored reports (ADMIN_KEY env or data/admin_key)
//   GET  /admin/photos/<file>, /admin/audio/<file>?key=...   stored media (audio supports Range)
//   GET  /api/issues          public issues board (no contact info), ?lat&lng&radius_km&status
//   POST /api/issues/lookup   {"contact": email|phone} -> that reporter's issues and status
//   GET  /api/issues/<id>/photo
//   POST /api/reports/<id>/status?key=...   staff update of the gov fields (admin)
//   /gov.html, /api/gov/*     government staff dashboard (gov.js, gov-criteria.js)

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
require('./env').loadEnv(); // before ./store, which reads DATABASE_URL
const store = require('./store');
const { STATUSES, DEPARTMENTS, cleanGovChanges } = require('./report-shape');
const { createGov } = require('./gov');

const PORT = Number(process.env.PORT || 8610);
const HOST = process.env.HOST || '127.0.0.1';
const WEB_DIR = path.join(__dirname, 'public');
const MAX_PHOTO = 8 * 1024 * 1024;
const MAX_AUDIO = 3 * 1024 * 1024;
const MAX_AUDIO_SECONDS = 30;
const MAX_BODY = MAX_PHOTO + MAX_AUDIO + 256 * 1024;
const MIME = {
  '.webm': 'audio/webm',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json',
};

// Server-side secrets (admin key, gov PINs) live here, in both store modes.
const SECRETS_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ADMIN_KEY = process.env.ADMIN_KEY || loadOrCreateAdminKey();

function loadOrCreateAdminKey() {
  const dir = SECRETS_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'admin_key');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const key = crypto.randomBytes(12).toString('base64url');
  fs.writeFileSync(file, key + '\n', { mode: 0o600 });
  return key;
}

// --- rate limits per client IP, 10-minute window ----------------------------
// 30 reports; 20 contact lookups (so the lookup can't be used to probe many emails).
const WINDOW_MS = 10 * 60 * 1000;
const limiters = [];

function makeLimiter(limit) {
  const hits = new Map();
  limiters.push(hits);
  return (ip) => {
    // Behind the proxy without a forwarded header every user looks the same,
    // so only limit when we can tell clients apart.
    if (!ip) return false;
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
    recent.push(now);
    hits.set(ip, recent);
    return recent.length > limit;
  };
}
const rateLimited = makeLimiter(30);
const lookupLimited = makeLimiter(20);

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  return xff ? xff.split(',')[0].trim() : null;
}

setInterval(() => {
  const now = Date.now();
  for (const hits of limiters) for (const [ip, ts] of hits) if (!ts.some((t) => now - t < WINDOW_MS)) hits.delete(ip);
}, WINDOW_MS).unref();

// --- helpers ----------------------------------------------------------------
function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function str(form, name, max) {
  const v = form.get(name);
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function num(form, name, min, max) {
  const v = str(form, name, 32);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function sniffImage(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ['image/jpeg', 'jpg'];
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ['image/png', 'png'];
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return ['image/webp', 'webp'];
  return null;
}

// Browsers record WebM/Opus (Chrome, Firefox), MP4/AAC (Safari) or Ogg (Firefox).
function sniffAudio(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return ['audio/webm', 'webm'];
  if (buf.subarray(4, 8).toString() === 'ftyp') return ['audio/mp4', 'm4a'];
  if (buf.subarray(0, 4).toString() === 'OggS') return ['audio/ogg', 'ogg'];
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WAVE') return ['audio/wav', 'wav'];
  if (buf.subarray(0, 3).toString() === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return ['audio/mpeg', 'mp3'];
  return null;
}

function splitContact(raw) {
  if (!raw) return { email: null, phone: null };
  if (raw.includes('@')) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? { email: raw.slice(0, 254), phone: null } : null;
  }
  const digits = raw.replace(/[^\d+]/g, '');
  return /^\+?\d{7,15}$/.test(digits) ? { email: null, phone: digits } : null;
}

// --- POST /api/reports ------------------------------------------------------
async function createReport(req, res, url) {
  if (url.searchParams.get('fail') === '1') return send(res, 503, { error: 'forced failure (?fail=1)' });
  if (rateLimited(clientIp(req))) return send(res, 429, { error: 'Too many reports, try again later.' });

  const ctype = req.headers['content-type'] || '';
  if (!ctype.startsWith('multipart/form-data')) return send(res, 415, { error: 'expected multipart/form-data' });

  let form;
  try {
    const body = await readBody(req);
    form = await new Request('http://local/', { method: 'POST', headers: { 'content-type': ctype }, body }).formData();
  } catch (e) {
    return send(res, e.status || 400, { error: e.status === 413 ? 'Upload too large' : 'Bad form data' });
  }

  const clientId = str(form, 'client_report_id', 64);
  if (!clientId) return send(res, 400, { error: 'client_report_id required' });
  const existing = await store.findByClientId(clientId);
  if (existing) return send(res, 200, { id: existing.id, status: existing.gov.status, duplicate: true });

  const photo = form.get('photo');
  if (!photo || typeof photo === 'string') return send(res, 400, { error: 'photo required' });
  const bytes = Buffer.from(await photo.arrayBuffer());
  if (bytes.length > MAX_PHOTO) return send(res, 413, { error: 'Photo too large' });
  const kind = sniffImage(bytes);
  if (!kind) return send(res, 400, { error: 'photo must be JPEG, PNG or WebP' });

  // Optional voice note. Checked before anything is written so a bad file never leaves a half-saved report.
  let audio = null;
  const audioFile = form.get('audio');
  if (audioFile && typeof audioFile !== 'string' && audioFile.size > 0) {
    if (audioFile.size > MAX_AUDIO) return send(res, 413, { error: 'Audio too large (max 3 MB)' });
    const audioBytes = Buffer.from(await audioFile.arrayBuffer());
    const audioKind = sniffAudio(audioBytes);
    if (!audioKind) return send(res, 400, { error: 'audio must be WebM, MP4/M4A, Ogg, MP3 or WAV' });
    // Length is reported by the device (the size cap above is the hard limit); allow 1 s of timer drift.
    const seconds = num(form, 'audio_duration_s', 0, 3600);
    if (seconds !== null && seconds > MAX_AUDIO_SECONDS + 1) return send(res, 400, { error: 'Audio is longer than 30 seconds' });
    audio = {
      bytes: audioBytes,
      ext: audioKind[1],
      mime: audioKind[0],
      duration_s: seconds === null ? null : Math.round(Math.min(seconds, MAX_AUDIO_SECONDS) * 10) / 10,
    };
  }

  const lat = num(form, 'lat', -90, 90);
  const lng = num(form, 'lng', -180, 180);
  const address = str(form, 'address', 300);
  const hasPoint = lat !== null && lng !== null;
  if (!hasPoint && !address) return send(res, 400, { error: 'location or address required' });

  let source = str(form, 'location_source', 10);
  if (!['gps', 'map', 'address'].includes(source)) source = hasPoint ? 'gps' : 'address';

  const contact = splitContact(str(form, 'contact', 254));
  if (!contact) return send(res, 400, { error: 'Contact must be an email or phone number' });

  const submittedAt = str(form, 'submitted_at', 40);
  // The report's `user` block (schema/report.schema.json); the store adds photo/audio paths.
  const user = {
    submitted_at: submittedAt && !isNaN(Date.parse(submittedAt)) ? new Date(submittedAt).toISOString() : null,
    description: str(form, 'description', 500),
    category: null, // the frontend has no category picker; the AI agent sets ai.category
    location: {
      lat: hasPoint ? lat : null,
      lng: hasPoint ? lng : null,
      accuracy_m: hasPoint ? num(form, 'accuracy_m', 0, 1e6) : null,
      source,
      address,
    },
    contact,
    meta: {
      device_id: str(form, 'device_id', 64),
      user_agent: (req.headers['user-agent'] || '').slice(0, 300) || null,
      was_queued_offline: str(form, 'queued', 5) === '1',
    },
  };
  let report;
  try {
    report = await store.insert(clientId, user, { bytes, ext: kind[1], mime: kind[0] }, audio);
  } catch (e) {
    console.error('save failed:', e.message);
    return send(res, 502, { error: 'Could not save the report. Please try again.' });
  }
  if (report.duplicate) return send(res, 200, { id: report.id, status: report.gov.status, duplicate: true });
  console.log(`${report.created_at} ${report.id} ${source} audio=${audio ? audio.duration_s ?? '?' : '-'}`);
  send(res, 201, { id: report.id, status: report.gov.status });
}

// --- public issues board ----------------------------------------------------
// publicIssue() (report-shape.js) and civic_public_json() (SQL) decide which fields are public.

function qnum(url, name, min, max) {
  const v = url.searchParams.get(name);
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

// GET /api/issues?lat=&lng=&radius_km=&status=open|resolved|<status>&limit=
// With lat/lng: nearest first, limited to radius_km (default 5). Without: newest first.
async function listIssues(res, url) {
  const lat = qnum(url, 'lat', -90, 90);
  const lng = qnum(url, 'lng', -180, 180);
  const near = lat !== null && lng !== null;
  const status = url.searchParams.get('status') || 'all';
  if (!['all', 'open', 'closed', ...STATUSES].includes(status)) return send(res, 400, { error: 'bad status filter' });
  const issues = await store.issues({
    lat: near ? lat : null,
    lng: near ? lng : null,
    radiusKm: qnum(url, 'radius_km', 0.1, 500) ?? 5,
    status,
    limit: qnum(url, 'limit', 1, 200) ?? 50,
  });
  send(res, 200, { issues, total: issues.length });
}

// POST /api/issues/lookup  {"contact": "email or phone"} -> that person's reports.
// POST so the email never lands in URLs, proxy logs or browser history.
async function lookupIssues(req, res) {
  if (lookupLimited(clientIp(req))) return send(res, 429, { error: 'Too many lookups, try again later.' });
  let body;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    return send(res, 400, { error: 'expected JSON' });
  }
  const contact = splitContact(typeof body.contact === 'string' ? body.contact.trim().slice(0, 254) : '');
  if (!contact || (!contact.email && !contact.phone)) return send(res, 400, { error: 'Enter the email or phone you used on the report.' });
  send(res, 200, { issues: await store.lookup(contact) });
}

// POST /api/reports/<id>/status?key=KEY  (JSON or the admin page form)
// Body: any of {status, note, department, severity_score, internal_notes, updated_by}.
// `note` is public: it is added to the status timeline and becomes gov.feedback.
// Returns the full updated report.
async function updateGov(req, res, id, fromForm) {
  let data;
  try {
    const raw = (await readBody(req)).toString('utf8');
    data = fromForm ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw || '{}');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
  } catch {
    return send(res, 400, { error: 'bad body' });
  }
  const { changes, error } = cleanGovChanges(data);
  if (error) return send(res, 400, { error });
  if (!Object.keys(changes).length) return send(res, 400, { error: 'nothing to change' });
  if (!changes.updated_by) changes.updated_by = 'admin';
  const r = await store.updateGov(id, changes);
  if (!r) return send(res, 404, { error: 'report not found' });
  if (fromForm) return send(res, 303, '', { Location: `/admin?key=${encodeURIComponent(ADMIN_KEY)}#${id}` });
  send(res, 200, r);
}

// --- admin ------------------------------------------------------------------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const DEPT_LABEL = {
  public_works: 'Public Works', parks_and_recreation: 'Parks & Rec', police: 'Police', fire: 'Fire',
  health_and_inspections: 'Health & Inspections', other: 'Other',
};

function aiCell(ai) {
  if (!ai) return '<small class="muted">Not analyzed yet</small>';
  const bad = Object.entries(ai.valid_checks || {}).filter(([, v]) => !v).map(([k]) => k.replace(/_/g, ' '));
  return `<b>${esc(ai.category)}</b> · ${esc(DEPT_LABEL[ai.department] || ai.department)}
    <div class="sev"><span style="width:${Number(ai.severity_score) || 0}%"></span></div><small>severity ${esc(ai.severity_score)}/100</small>
    <br>${ai.valid ? '<span class="ok">valid</span>' : `<span class="bad">not valid</span> <small>(${esc(bad.join(', '))})</small>`}
    <p>${esc(ai.summary)}</p>
    <details><summary>Reasons</summary><small><b>Valid:</b> ${esc(ai.valid_reason)}<br><b>Category:</b> ${esc(ai.category_reason)}<br>
    <b>Department:</b> ${esc(ai.department_reason)}<br><b>Severity:</b> ${esc(ai.severity_reason)}<br>
    <b>Evidence:</b> ${esc((ai.evidence || []).join(', '))}<br>${esc(ai.model)} · ${esc(ai.processed_at)}</small></details>`;
}

function govForm(r, key) {
  const g = r.gov;
  const opt = (list, cur, labels = {}) => list.map((v) => `<option value="${v}"${v === cur ? ' selected' : ''}>${esc(labels[v] || v)}</option>`).join('');
  return `<form method="post" action="/admin/status/${esc(r.id)}?key=${esc(key)}">
    <select name="status">${opt(STATUSES, g.status)}</select>
    <select name="department"><option value="">department: ${esc(r.ai ? 'AI says ' + r.ai.department : 'none')}</option>${opt(DEPARTMENTS, g.department, DEPT_LABEL)}</select>
    <input name="severity_score" type="number" min="0" max="100" value="${esc(g.severity_score)}" placeholder="severity ${esc(r.ai?.severity_score ?? '0-100')}">
    <input name="note" maxlength="300" placeholder="public note (optional)">
    <textarea name="internal_notes" maxlength="2000" rows="2" placeholder="internal notes (staff only)">${esc(g.internal_notes)}</textarea>
    <button>Save</button>
    ${g.feedback ? `<small>Last public note: ${esc(g.feedback)}</small><br>` : ''}
    ${g.updated_at ? `<small>Updated ${esc(g.updated_at.replace('T', ' ').slice(0, 16))} by ${esc(g.updated_by)}</small>` : ''}
  </form>`;
}

async function adminPage(res, key) {
  const reports = await store.list();
  const media = (p) => `/admin/${esc(p)}?key=${esc(key)}`;
  const rows = reports
    .map((r) => {
      const u = r.user;
      const loc = u.location;
      const where = loc.lat != null
        ? `<a href="https://www.openstreetmap.org/?mlat=${loc.lat}&mlon=${loc.lng}#map=18/${loc.lat}/${loc.lng}" target="_blank">${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}</a>${loc.accuracy_m != null ? ` ±${Math.round(loc.accuracy_m)}m` : ''}`
        : '';
      return `<tr id="${esc(r.id)}">
        <td><a href="${media(u.photo.path)}" target="_blank"><img src="${media(u.photo.path)}" loading="lazy"></a></td>
        <td><b>${esc(r.id)}</b><br><small>${esc(r.created_at.replace('T', ' ').slice(0, 19))} UTC</small></td>
        <td>${where}<br>${esc(loc.address)}<br><small>${esc(loc.source)}</small></td>
        <td>${esc(u.description)}${u.category ? `<br><small>reporter: ${esc(u.category)}</small>` : ''}${
          u.audio ? `<br><audio controls preload="none" src="${media(u.audio.path)}"></audio><small>${esc(u.audio.duration_s ?? '?')} s voice note</small>` : ''}</td>
        <td>${esc(u.contact.email || u.contact.phone)}</td>
        <td class="ai">${aiCell(r.ai)}</td>
        <td>${govForm(r, key)}</td>
      </tr>`;
    })
    .join('');
  send(
    res,
    200,
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reports</title>
<style>body{font:14px system-ui;margin:16px}table{border-collapse:collapse;width:100%}td{border-bottom:1px solid #ddd;padding:8px;vertical-align:top}
img{width:96px;height:96px;object-fit:cover;border-radius:6px}td.ai{max-width:260px}td.ai p{margin:4px 0}
form{display:grid;gap:4px;min-width:200px}.muted{color:#777}.ok{color:#137333}.bad{color:#b3261e}
.sev{height:6px;background:#eee;border-radius:3px;margin:4px 0 0;width:120px}.sev span{display:block;height:100%;background:#d93025;border-radius:3px}</style>
<h1>Reports (${reports.length})</h1>
<p><a href="/api/reports?key=${esc(key)}">JSON</a> · stored in ${esc(store.kind)}</p>
<table><tr><th>Photo</th><th>Report</th><th>Location</th><th>Description</th><th>Contact</th><th>AI analysis</th><th>Town (gov)</th></tr>
${rows || '<tr><td colspan="7">No reports yet.</td></tr>'}</table>`,
    { 'Content-Type': 'text/html; charset=utf-8' },
  );
}

// --- static -----------------------------------------------------------------
// Site files: gzip text files (kept in memory per file version) and answer repeat
// visits with 304 via ETag, so a returning phone downloads almost nothing.
const gzCache = new Map(); // file -> { etag, gz }
const COMPRESS = new Set(['.html', '.js', '.css', '.svg', '.json']);

function serveStatic(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const ext = path.extname(file);
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: etag, Vary: 'Accept-Encoding' };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    const gzip = COMPRESS.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    fs.readFile(file, (err2, data) => {
      if (err2) return send(res, 404, 'Not found');
      if (!gzip) {
        res.writeHead(200, headers);
        return res.end(req.method === 'HEAD' ? undefined : data);
      }
      let hit = gzCache.get(file);
      if (!hit || hit.etag !== etag) {
        hit = { etag, gz: zlib.gzipSync(data, { level: 9 }) };
        gzCache.set(file, hit);
      }
      res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': hit.gz.length });
      res.end(req.method === 'HEAD' ? undefined : hit.gz);
    });
  });
}

// Photo / voice note from the store (local file or Supabase Storage), as a Buffer.
// Audio needs HTTP Range support: Safari refuses to play <audio> from a server that ignores it.
const MEDIA_PATH = /^(photos|audio)\/R-\d+\.(jpg|png|webp|webm|m4a|ogg|mp3|wav)$/;

async function serveMedia(req, res, mediaPath, cache) {
  if (!MEDIA_PATH.test(mediaPath)) return send(res, 404, 'Not found');
  const data = await store.readMedia(mediaPath);
  if (!data) return send(res, 404, 'Not found');
  const size = data.length;
  const headers = {
    'Content-Type': MIME[path.extname(mediaPath)] || 'application/octet-stream',
    'Cache-Control': cache,
    'Accept-Ranges': 'bytes',
  };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (!m || (m[1] === '' && m[2] === '')) {
    res.writeHead(200, { ...headers, 'Content-Length': size });
    return res.end(req.method === 'HEAD' ? undefined : data);
  }
  const start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
  const end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start > end || start >= size) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    return res.end();
  }
  res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
  res.end(req.method === 'HEAD' ? undefined : data.subarray(start, end + 1));
}

// --- router -----------------------------------------------------------------
const gov = createGov({ store, send, readBody, clientIp, makeLimiter, serveMedia, dataDir: SECRETS_DIR });

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://local');
  } catch {
    return send(res, 400, 'Bad request'); // e.g. "//": must not crash the process
  }
  const p = url.pathname;
  try {
    if (await gov.handle(req, res, url)) return;
    if (p === '/gov') return send(res, 302, '', { Location: '/gov.html' });
    if (p === '/api/reports' && req.method === 'POST') return await createReport(req, res, url);
    if (p === '/api/issues' && req.method === 'GET') return await listIssues(res, url);
    if (p === '/api/issues/lookup' && req.method === 'POST') return await lookupIssues(req, res);
    const photoMatch = /^\/api\/issues\/(R-\d+)\/photo$/.exec(p);
    if (photoMatch) {
      const r = await store.findById(photoMatch[1]);
      if (!r) return send(res, 404, 'Not found');
      // A report's photo never changes once saved.
      return await serveMedia(req, res, r.user.photo.path, 'public, max-age=86400');
    }

    const authed = url.searchParams.get('key') === ADMIN_KEY;
    const statusMatch = /^\/(api\/reports|admin\/status)\/(R-\d+)(\/status)?$/.exec(p);
    if (statusMatch && req.method === 'POST' && (statusMatch[1] === 'admin/status' || statusMatch[3])) {
      if (!authed) return send(res, 401, { error: 'key required' });
      return await updateGov(req, res, statusMatch[2], statusMatch[1] === 'admin/status');
    }
    if (p === '/api/reports' && req.method === 'GET') return authed ? send(res, 200, await store.list()) : send(res, 401, { error: 'key required' });
    if (p === '/admin') return authed ? await adminPage(res, ADMIN_KEY) : send(res, 401, 'key required');
    const mediaMatch = /^\/admin\/((photos|audio)\/[^/]+)$/.exec(p);
    if (mediaMatch) {
      if (!authed) return send(res, 401, 'key required');
      return await serveMedia(req, res, mediaMatch[1], 'private, max-age=3600');
    }
    if (p === '/healthz') {
      try {
        return send(res, 200, { ok: true, store: store.kind, reports: await store.count() });
      } catch (e) {
        return send(res, 503, { ok: false, store: store.kind, error: e.message });
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    const rel = p === '/' ? 'index.html' : path.normalize(p).replace(/^[/\\]+/, '');
    const file = path.join(WEB_DIR, rel);
    if (!file.startsWith(WEB_DIR + path.sep)) return send(res, 404, 'Not found');
    serveStatic(req, res, file);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'server error' });
  }
});

store
  .init()
  .then(() => store.count())
  .then((n) => {
    server.listen(PORT, HOST, () => {
      console.log(`listening on http://${HOST}:${PORT}  (${n} reports in ${store.kind}: ${store.where})`);
      console.log(`admin: /admin?key=${ADMIN_KEY}`);
      console.log(`gov dashboard: /gov.html  ids: ${gov.users.map((u) => u.id).join(', ')}  (PINs: ${gov.pinSource})`);
    });
  })
  .catch((e) => {
    console.error(`Could not open the ${store.kind} store: ${e.message}`);
    process.exit(1);
  });
