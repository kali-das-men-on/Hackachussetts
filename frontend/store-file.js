// Local file store, used when DATABASE_URL is not a Postgres URL. Same interface and the same
// report JSON as store-supabase.js (all functions return promises).
//
// Layout:
//   data/reports.jsonl   one report per line, shape = schema/report.schema.json (user / ai / gov)
//   data/photos/<id>.jpg photo bytes
//   data/audio/<id>.webm optional voice note (webm | m4a | ogg | mp3 | wav)

const fs = require('node:fs');
const path = require('node:path');
const { emptyGov, publicIssue, fromLegacy, applyGov } = require('./report-shape');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const LOG_FILE = path.join(DATA_DIR, 'reports.jsonl');
const FIRST_ID = 1001;
const DONE = ['resolved', 'rejected'];

const reports = [];
const byClientId = new Map();
const byId = new Map();
let nextNum = FIRST_ID;

function remember(r) {
  reports.push(r);
  if (r.client_report_id) byClientId.set(r.client_report_id, r);
  byId.set(r.id, r);
}

async function init() {
  fs.mkdirSync(path.join(DATA_DIR, 'photos'), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'audio'), { recursive: true });
  if (!fs.existsSync(LOG_FILE)) return;
  for (const line of fs.readFileSync(LOG_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = fromLegacy(JSON.parse(line));
      remember(r);
      nextNum = Math.max(nextNum, Number(r.id.slice(2)) + 1);
    } catch {
      // A torn last line from a crash mid-write; skip it.
    }
  }
}

async function findByClientId(clientId) {
  return byClientId.get(clientId) || null;
}

async function findById(id) {
  return byId.get(id) || null;
}

// Node runs this synchronously on one thread, so concurrent requests can't interleave
// between reserving an id and writing the line.
// user = the report's `user` block without photo/audio; photo = {bytes, ext, mime};
// audio = {bytes, ext, mime, duration_s} or null.
async function insert(clientReportId, user, photo, audio = null) {
  const id = `R-${nextNum++}`;
  const photoPath = `photos/${id}.${photo.ext}`;
  fs.writeFileSync(path.join(DATA_DIR, photoPath), photo.bytes);
  let audioMeta = null;
  if (audio) {
    const audioPath = `audio/${id}.${audio.ext}`;
    fs.writeFileSync(path.join(DATA_DIR, audioPath), audio.bytes);
    audioMeta = { path: audioPath, mime: audio.mime, bytes: audio.bytes.length, duration_s: audio.duration_s };
  }
  const report = {
    id,
    client_report_id: clientReportId,
    created_at: new Date().toISOString(),
    user: {
      submitted_at: user.submitted_at,
      photo: { path: photoPath, mime: photo.mime, bytes: photo.bytes.length },
      audio: audioMeta,
      description: user.description,
      category: user.category,
      location: user.location,
      contact: user.contact,
      meta: user.meta,
    },
    ai: null,
    gov: emptyGov(),
  };
  fs.appendFileSync(LOG_FILE, JSON.stringify(report) + '\n');
  remember(report);
  return report;
}

// Updates rewrite the whole file (small data); write a temp file and rename so a crash
// mid-write leaves the old file intact. Older flat lines are written back in the new shape.
function rewrite() {
  const tmp = LOG_FILE + '.tmp';
  fs.writeFileSync(tmp, reports.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.renameSync(tmp, LOG_FILE);
}

async function updateGov(id, changes) {
  const r = byId.get(id);
  if (!r) return null;
  applyGov(r, changes);
  rewrite();
  return r;
}

async function list() {
  return reports.slice().reverse();
}

async function count() {
  return reports.length;
}

function haversineKm(aLat, aLng, bLat, bLng) {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLng = (bLng - aLng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// Same filters as public_issues() in schema/supabase.sql.
async function issues({ lat, lng, radiusKm, status, limit }) {
  const near = lat != null && lng != null;
  const keep = (s) =>
    status === 'all' ? true : status === 'open' ? !DONE.includes(s) : status === 'closed' ? DONE.includes(s) : s === status;
  let items = reports
    .slice()
    .reverse()
    .filter((r) => keep(r.gov.status))
    .map((r) => {
      const loc = r.user.location || {};
      return { r, d: near && loc.lat != null ? haversineKm(lat, lng, loc.lat, loc.lng) : null };
    });
  if (near) items = items.filter((x) => x.d !== null && x.d <= radiusKm).sort((a, b) => a.d - b.d);
  return items.slice(0, limit).map((x) => publicIssue(x.r, x.d));
}

// contact = {email, phone} from splitContact(). Public fields only.
async function lookup(contact) {
  const email = contact.email && contact.email.toLowerCase();
  return reports
    .slice()
    .reverse()
    .filter((r) => (email ? (r.user.contact?.email || '').toLowerCase() === email : r.user.contact?.phone === contact.phone))
    .map((r) => publicIssue(r));
}

// media path is a report's user.photo.path / user.audio.path, e.g. "photos/R-1001.jpg".
async function readMedia(mediaPath) {
  const file = path.join(DATA_DIR, mediaPath);
  if (!file.startsWith(path.resolve(DATA_DIR) + path.sep) && !file.startsWith(DATA_DIR + path.sep)) return null;
  try {
    return await fs.promises.readFile(file);
  } catch {
    return null;
  }
}

module.exports = {
  kind: 'file',
  where: LOG_FILE,
  DATA_DIR,
  init, findByClientId, findById, insert, updateGov, list, count, issues, lookup, readMedia,
};
