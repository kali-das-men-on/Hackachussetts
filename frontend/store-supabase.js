// Supabase store, used when DATABASE_URL is a Postgres URL. Same interface as store-file.js.
//   rows:   civic_reports in Postgres (schema/supabase.sql), shared with backend/main.py
//   files:  private Storage bucket "civic-reports", photos/<id>.<ext> and audio/<id>.<ext>
// Report JSON is built in SQL by civic_report_json() / civic_public_json(), so this file and
// backend/main.py return the same shape.
//
// Env: DATABASE_URL, SUPABASE_SECRET_KEY (sb_secret_... or a legacy service_role JWT),
//      SUPABASE_URL (optional, derived from DATABASE_URL), SUPABASE_BUCKET (default civic-reports).

const { Pool } = require('pg');
const { pgConfig } = require('./env');

const DB_URL = process.env.DATABASE_URL;
const BUCKET = process.env.SUPABASE_BUCKET || 'civic-reports';
const KEY = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

// The project ref is in the pooler user name (postgres.<ref>) or the direct host (db.<ref>.supabase.co).
function projectUrl() {
  if (process.env.SUPABASE_URL) return process.env.SUPABASE_URL.replace(/\/+$/, '');
  const m = /postgres\.([a-z0-9]{20})[:@]|db\.([a-z0-9]{20})\.supabase\.co/.exec(DB_URL);
  return m ? `https://${m[1] || m[2]}.supabase.co` : '';
}
const SUPABASE_URL = projectUrl();

let pool;
function db() {
  // Supabase's transaction pooler (port 6543) doesn't keep prepared statements between
  // transactions; pg only prepares named queries, and this file uses none.
  pool ||= new Pool({ ...pgConfig(DB_URL), max: 5, idleTimeoutMillis: 30_000 });
  return pool;
}

async function one(sql, params) {
  const { rows } = await db().query(sql, params);
  return rows[0] || null;
}

// ---------- Storage REST ----------
function storageHeaders(extra = {}) {
  const h = { apikey: KEY, ...extra };
  if (KEY.startsWith('eyJ')) h.Authorization = `Bearer ${KEY}`; // legacy service_role JWT
  return h;
}

async function storage(method, objectPath, body, mime) {
  const url = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectPath.split('/').map(encodeURIComponent).join('/')}`;
  return fetch(url, {
    method,
    headers: storageHeaders(mime ? { 'Content-Type': mime } : {}),
    body,
    signal: AbortSignal.timeout(30_000),
  });
}

async function upload(objectPath, bytes, mime) {
  const r = await storage('POST', objectPath, bytes, mime);
  if (!r.ok) throw new Error(`Storage upload ${objectPath} failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
}

async function remove(objectPath) {
  await storage('DELETE', objectPath).catch(() => {}); // best-effort cleanup
}

async function ensureBucket() {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
    method: 'POST',
    headers: storageHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
  });
  // Creating an existing bucket is an error we can ignore.
  if (!r.ok) {
    const text = await r.text();
    if (!/exists|duplicate/i.test(text)) throw new Error(`Storage bucket setup failed (${r.status}): ${text.slice(0, 200)}`);
  }
}

// ---------- store interface ----------
async function init() {
  if (!SUPABASE_URL) throw new Error('Cannot tell the Supabase project from DATABASE_URL; set SUPABASE_URL');
  if (!KEY) throw new Error('SUPABASE_SECRET_KEY is not set');
  if (KEY.startsWith('sb_publishable_')) throw new Error('SUPABASE_SECRET_KEY is a publishable key; Storage needs the secret key (sb_secret_...)');
  const fn = await one("SELECT to_regprocedure('set_report_gov(text,jsonb)') IS NOT NULL AS ok");
  if (!fn.ok) throw new Error('Supabase is missing the schema functions. Run: npm run db:schema');
  await ensureBucket();
}

async function findByClientId(clientId) {
  const row = await one('SELECT civic_report_json(r) AS j FROM civic_reports r WHERE client_report_id = $1', [clientId]);
  return row && row.j;
}

async function findById(id) {
  const row = await one('SELECT civic_report_json(r) AS j FROM civic_reports r WHERE id = $1', [id]);
  return row && row.j;
}

async function insert(clientReportId, user, photo, audio = null) {
  const { n } = await one("SELECT nextval('civic_report_seq') AS n");
  const id = `R-${n}`;
  const photoPath = `photos/${id}.${photo.ext}`;
  const audioPath = audio ? `audio/${id}.${audio.ext}` : null;
  const uploaded = [];
  try {
    await upload(photoPath, photo.bytes, photo.mime);
    uploaded.push(photoPath);
    if (audio) {
      await upload(audioPath, audio.bytes, audio.mime);
      uploaded.push(audioPath);
    }
    const loc = user.location;
    const row = await one(
      `INSERT INTO civic_reports
         (id, client_report_id, submitted_at, description, category,
          lat, lng, accuracy_m, location_source, address,
          contact_email, contact_phone, device_id, user_agent, was_queued_offline,
          photo_path, photo_mime, photo_bytes, audio_path, audio_mime, audio_bytes, audio_duration_s)
       VALUES ($1,$2,$3,$4,$5, $6,$7,$8,$9,$10, $11,$12,$13,$14,$15, $16,$17,$18,$19,$20,$21,$22)
       RETURNING civic_report_json(civic_reports) AS j`,
      [
        id, clientReportId, user.submitted_at, user.description, user.category,
        loc.lat, loc.lng, loc.accuracy_m, loc.source, loc.address,
        user.contact.email, user.contact.phone, user.meta.device_id, user.meta.user_agent, user.meta.was_queued_offline,
        photoPath, photo.mime, photo.bytes.length,
        audioPath, audio?.mime ?? null, audio ? audio.bytes.length : null, audio?.duration_s ?? null,
      ],
    );
    return row.j;
  } catch (e) {
    for (const p of uploaded) await remove(p); // don't leave orphaned files behind
    if (e.code === '23505' && clientReportId) {
      // Two copies of the same report arrived at once; keep the first one.
      const first = await findByClientId(clientReportId);
      if (first) return { ...first, duplicate: true };
    }
    throw e;
  }
}

async function updateGov(id, changes) {
  const row = await one('SELECT set_report_gov($1, $2::jsonb) AS j', [id, JSON.stringify(changes)]);
  return row && row.j;
}

async function list() {
  const { rows } = await db().query('SELECT civic_report_json(r) AS j FROM civic_reports r ORDER BY created_at DESC');
  return rows.map((r) => r.j);
}

async function count() {
  return Number((await one('SELECT count(*) AS n FROM civic_reports')).n);
}

async function issues({ lat, lng, radiusKm, status, limit }) {
  const { rows } = await db().query('SELECT public_issues($1, $2, $3, $4, $5) AS j', [lat, lng, radiusKm, status, limit]);
  return rows.map((r) => r.j);
}

// contact = {email, phone} from splitContact().
async function lookup(contact) {
  const { rows } = await db().query('SELECT lookup_issues($1) AS j', [contact.email || contact.phone]);
  return rows.map((r) => r.j);
}

// media path is a report's user.photo.path / user.audio.path. Returns a Buffer or null.
async function readMedia(mediaPath) {
  const r = await storage('GET', mediaPath);
  if (r.status === 400 || r.status === 404) return null; // Storage answers 400 "not_found" for missing objects
  if (!r.ok) throw new Error(`Storage download ${mediaPath} failed (${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

module.exports = {
  kind: 'supabase',
  where: `${SUPABASE_URL} (bucket ${BUCKET})`,
  init, findByClientId, findById, insert, updateGov, list, count, issues, lookup, readMedia,
};
