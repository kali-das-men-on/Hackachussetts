// Report-an-issue server. No dependencies: Node 22's built-in Request.formData()
// parses the multipart upload.
//
//   node server.js            listens on 127.0.0.1:${PORT:-8610}
//   POST /api/reports         multipart form, see README / schema/
//   POST /api/reports?fail=1  forced 503, for testing the retry path
//   GET  /admin?key=...       list of stored reports (ADMIN_KEY env or data/admin_key)
//   GET  /admin/photos/<file>, /admin/audio/<file>?key=...   stored media (audio supports Range)

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./store');

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

store.init();
const ADMIN_KEY = process.env.ADMIN_KEY || loadOrCreateAdminKey();

function loadOrCreateAdminKey() {
  const file = path.join(store.DATA_DIR, 'admin_key');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const key = crypto.randomBytes(12).toString('base64url');
  fs.writeFileSync(file, key + '\n', { mode: 0o600 });
  return key;
}

// --- rate limit: 30 reports per 10 minutes per client IP --------------------
const WINDOW_MS = 10 * 60 * 1000;
const LIMIT = 30;
const hits = new Map();

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  return xff ? xff.split(',')[0].trim() : null;
}

function rateLimited(ip) {
  // Behind the proxy without a forwarded header every user looks the same,
  // so only limit when we can tell clients apart.
  if (!ip) return false;
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > LIMIT;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, ts] of hits) if (!ts.some((t) => now - t < WINDOW_MS)) hits.delete(ip);
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
  const existing = store.findByClientId(clientId);
  if (existing) return send(res, 200, { id: existing.id, status: existing.status, duplicate: true });

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
  const report = store.insert(
    {
      client_report_id: clientId,
      submitted_at: submittedAt && !isNaN(Date.parse(submittedAt)) ? new Date(submittedAt).toISOString() : null,
      photo_mime: kind[0],
      location: {
        lat: hasPoint ? lat : null,
        lng: hasPoint ? lng : null,
        accuracy_m: hasPoint ? num(form, 'accuracy_m', 0, 1e6) : null,
        source,
        address,
      },
      description: str(form, 'description', 500),
      category: null, // not asked from the user; filled in later by AI analysis of the description
      contact,
      meta: {
        device_id: str(form, 'device_id', 64),
        user_agent: (req.headers['user-agent'] || '').slice(0, 300) || null,
        was_queued_offline: str(form, 'queued', 5) === '1',
      },
    },
    bytes,
    kind[1],
    audio,
  );
  console.log(`${report.created_at} ${report.id} ${source} audio=${audio ? audio.duration_s ?? '?' : '-'}`);
  send(res, 201, { id: report.id, status: report.status });
}

// --- admin ------------------------------------------------------------------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function adminPage(res, key) {
  const rows = store
    .list()
    .map((r) => {
      const loc = r.location;
      const where = loc.lat !== null
        ? `<a href="https://www.openstreetmap.org/?mlat=${loc.lat}&mlon=${loc.lng}#map=18/${loc.lat}/${loc.lng}" target="_blank">${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}</a> ±${Math.round(loc.accuracy_m ?? 0)}m`
        : '';
      return `<tr>
        <td><a href="/admin/${esc(r.photo.path)}?key=${esc(key)}" target="_blank"><img src="/admin/${esc(r.photo.path)}?key=${esc(key)}" loading="lazy"></a></td>
        <td><b>${esc(r.id)}</b><br><small>${esc(r.created_at.replace('T', ' ').slice(0, 19))} UTC</small></td>
        <td>${where}<br>${esc(loc.address)}<br><small>${esc(loc.source)}</small></td>
        <td>${esc(r.description)}${r.category ? `<br><small>${esc(r.category)}</small>` : ''}${
          r.audio ? `<br><audio controls preload="none" src="/admin/${esc(r.audio.path)}?key=${esc(key)}"></audio><small>${esc(r.audio.duration_s ?? '?')} s voice note</small>` : ''}</td>
        <td>${esc(r.contact.email || r.contact.phone)}</td>
      </tr>`;
    })
    .join('');
  send(
    res,
    200,
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reports</title>
<style>body{font:14px system-ui;margin:16px}table{border-collapse:collapse;width:100%}td{border-bottom:1px solid #ddd;padding:8px;vertical-align:top}img{width:96px;height:96px;object-fit:cover;border-radius:6px}</style>
<h1>Reports (${store.list().length})</h1>
<p><a href="/api/reports?key=${esc(key)}">JSON</a></p>
<table>${rows || '<tr><td>No reports yet.</td></tr>'}</table>`,
    { 'Content-Type': 'text/html; charset=utf-8' },
  );
}

// --- static -----------------------------------------------------------------
function serveFile(res, file, cache) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': cache,
    });
    res.end(data);
  });
}

// Audio needs HTTP Range support: Safari refuses to play <audio> from a server that ignores it.
function serveMedia(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    const headers = {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'private, max-age=3600',
      'Accept-Ranges': 'bytes',
    };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (!m || (m[1] === '' && m[2] === '')) {
      res.writeHead(200, { ...headers, 'Content-Length': st.size });
      return req.method === 'HEAD' ? res.end() : fs.createReadStream(file).pipe(res);
    }
    let start = m[1] === '' ? Math.max(0, st.size - Number(m[2])) : Number(m[1]);
    let end = m[1] === '' || m[2] === '' ? st.size - 1 : Math.min(Number(m[2]), st.size - 1);
    if (start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file, { start, end }).pipe(res);
  });
}

// --- router -----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;
  try {
    if (p === '/api/reports' && req.method === 'POST') return await createReport(req, res, url);

    const authed = url.searchParams.get('key') === ADMIN_KEY;
    if (p === '/api/reports' && req.method === 'GET') return authed ? send(res, 200, store.list()) : send(res, 401, { error: 'key required' });
    if (p === '/admin') return authed ? adminPage(res, ADMIN_KEY) : send(res, 401, 'key required');
    if (p.startsWith('/admin/photos/')) {
      if (!authed) return send(res, 401, 'key required');
      const name = path.basename(p);
      return serveFile(res, path.join(store.PHOTO_DIR, name), 'private, max-age=3600');
    }
    if (p.startsWith('/admin/audio/')) {
      if (!authed) return send(res, 401, 'key required');
      return serveMedia(req, res, path.join(store.AUDIO_DIR, path.basename(p)));
    }
    if (p === '/healthz') return send(res, 200, { ok: true, reports: store.list().length });

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    const rel = p === '/' ? 'index.html' : path.normalize(p).replace(/^[/\\]+/, '');
    const file = path.join(WEB_DIR, rel);
    if (!file.startsWith(WEB_DIR + path.sep)) return send(res, 404, 'Not found');
    serveFile(res, file, 'no-cache');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`listening on http://${HOST}:${PORT}  (${store.list().length} reports stored)`);
  console.log(`admin: /admin?key=${ADMIN_KEY}`);
});
