// Local file store for reports. Swap this module for a database adapter later;
// server.js only calls init(), findByClientId(), insert(), list().
//
// Layout:
//   data/reports.jsonl   one Report (schema/report.schema.json) per line, append-only
//   data/photos/<id>.jpg photo bytes
//   data/audio/<id>.webm optional voice note (webm | m4a | ogg | mp3 | wav)

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
const LOG_FILE = path.join(DATA_DIR, 'reports.jsonl');
const FIRST_ID = 1001;

const reports = [];
const byClientId = new Map();
let nextNum = FIRST_ID;

function init() {
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  if (!fs.existsSync(LOG_FILE)) return;
  for (const line of fs.readFileSync(LOG_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      reports.push(r);
      byClientId.set(r.client_report_id, r);
      nextNum = Math.max(nextNum, Number(r.id.slice(2)) + 1);
    } catch {
      // A torn last line from a crash mid-write; skip it.
    }
  }
}

function findByClientId(clientId) {
  return byClientId.get(clientId) || null;
}

// Node runs this synchronously on one thread, so concurrent requests can't
// interleave between reserving an id and writing the line.
// audio is optional: { bytes: Buffer, ext, mime, duration_s } or null.
function insert(fields, photoBytes, photoExt, audio = null) {
  const id = `R-${nextNum++}`;
  const photoPath = `photos/${id}.${photoExt}`;
  fs.writeFileSync(path.join(DATA_DIR, photoPath), photoBytes);
  let audioMeta = null;
  if (audio) {
    const audioPath = `audio/${id}.${audio.ext}`;
    fs.writeFileSync(path.join(DATA_DIR, audioPath), audio.bytes);
    audioMeta = { path: audioPath, mime: audio.mime, bytes: audio.bytes.length, duration_s: audio.duration_s };
  }
  const report = {
    id,
    client_report_id: fields.client_report_id,
    created_at: new Date().toISOString(),
    submitted_at: fields.submitted_at,
    status: 'received',
    photo: { path: photoPath, mime: fields.photo_mime, bytes: photoBytes.length },
    audio: audioMeta,
    location: fields.location,
    description: fields.description,
    category: fields.category,
    contact: fields.contact,
    meta: fields.meta,
  };
  fs.appendFileSync(LOG_FILE, JSON.stringify(report) + '\n');
  reports.push(report);
  byClientId.set(report.client_report_id, report);
  return report;
}

function list() {
  return reports.slice().reverse();
}

module.exports = { init, findByClientId, insert, list, DATA_DIR, PHOTO_DIR, AUDIO_DIR };
