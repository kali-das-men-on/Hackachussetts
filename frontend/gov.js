// Government staff dashboard API (/gov.html uses it). Staff log in with a government id and PIN;
// the ids are fake demo accounts (GOV_USERS below).
//
//   POST /api/gov/login             {"id": "AMH-DPW-1001", "pin": "123456"} -> sets the gov_session cookie
//   POST /api/gov/logout
//   GET  /api/gov/me
//   GET  /api/gov/reports?status=open|closed|all   AI-ranked reports with criteria, budget, due date
//   POST /api/gov/reports/<id>/action  {"action": "in_progress"|"complete"|"invalid", "note": "..."}
//   GET  /api/gov/media/<photos|audio>/<file>      stored photo / voice note
//
// PINs: GOV_DEMO_PIN (env) gives every account that PIN, for local demos. Otherwise each account
// gets a random 6-digit PIN, saved on first run in <data dir>/gov_users.json (mode 600, git-ignored).
// Sessions live in memory (8 h) and end when the server restarts.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { assess, DONE, TIERS, VALID_RULES, CATEGORY } = require('./gov-criteria');
const { DEPARTMENTS } = require('./report-shape');

// Fake accounts. department null = sees and acts on every department.
const GOV_USERS = [
  { id: 'AMH-DPW-1001', name: 'Dana Rivera', title: 'DPW Operations Supervisor', department: 'public_works' },
  { id: 'AMH-DPW-1002', name: 'Chris Okafor', title: 'DPW Highway Foreman', department: 'public_works' },
  { id: 'AMH-PRK-2001', name: 'Priya Shah', title: 'Parks & Recreation Coordinator', department: 'parks_and_recreation' },
  { id: 'AMH-HLT-3001', name: 'Morgan Lee', title: 'Health Inspector', department: 'health_and_inspections' },
  { id: 'AMH-TMO-9001', name: 'Alex Chen', title: "Town Manager's Office", department: null },
];

const ACTIONS = { in_progress: 'in_progress', complete: 'resolved', invalid: 'rejected' };
const SESSION_MS = 8 * 3600e3;
const COOKIE = 'gov_session';

function loadPins(dir) {
  if (process.env.GOV_DEMO_PIN) {
    if (!/^\d{4,12}$/.test(process.env.GOV_DEMO_PIN)) throw new Error('GOV_DEMO_PIN must be 4-12 digits');
    return Object.fromEntries(GOV_USERS.map((u) => [u.id, process.env.GOV_DEMO_PIN]));
  }
  const file = path.join(dir, 'gov_users.json');
  let pins = {};
  try {
    pins = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // first run
  }
  let changed = false;
  for (const u of GOV_USERS) {
    if (!pins[u.id]) {
      pins[u.id] = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
      changed = true;
    }
  }
  if (changed) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(pins, null, 2) + '\n', { mode: 0o600 });
  }
  return pins;
}

function sameText(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function cookieValue(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

// deps: { store, send, readBody, clientIp, makeLimiter, serveMedia, dataDir }
function createGov(deps) {
  const { store, send, readBody, clientIp, makeLimiter, serveMedia } = deps;
  const pins = loadPins(deps.dataDir);
  const sessions = new Map(); // token -> { user, expires }
  const loginLimitedIp = makeLimiter(10);
  const loginLimitedId = makeLimiter(10); // per account, so one id can't be brute-forced from many IPs

  setInterval(() => {
    const now = Date.now();
    for (const [t, s] of sessions) if (s.expires < now) sessions.delete(t);
  }, 600e3).unref();

  function currentUser(req) {
    const token = cookieValue(req, COOKIE);
    const s = token && sessions.get(token);
    if (!s || s.expires < Date.now()) return null;
    return s.user;
  }

  function cookie(req, token, maxAge) {
    // Secure when served over HTTPS (the Tailscale funnel sets X-Forwarded-Proto).
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
  }

  async function readJson(req) {
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return null; // also blocks cross-site form posts
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
    } catch {
      return null;
    }
  }

  const publicUser = (u) => ({ id: u.id, name: u.name, title: u.title, department: u.department });

  async function login(req, res) {
    const body = await readJson(req);
    if (!body) return send(res, 400, { error: 'expected JSON' });
    const id = String(body.id || '').trim().toUpperCase().slice(0, 40);
    const pin = String(body.pin || '').trim().slice(0, 12);
    if (loginLimitedIp(clientIp(req)) || loginLimitedId(id)) return send(res, 429, { error: 'Too many attempts. Wait 10 minutes.' });
    const user = GOV_USERS.find((u) => u.id === id);
    if (!user || !sameText(pin, pins[user.id])) return send(res, 401, { error: 'Government ID or PIN is wrong.' });
    const token = crypto.randomBytes(24).toString('base64url');
    sessions.set(token, { user, expires: Date.now() + SESSION_MS });
    console.log(`gov login ${user.id}`);
    send(res, 200, { user: publicUser(user) }, { 'Set-Cookie': cookie(req, token, SESSION_MS / 1000) });
  }

  function logout(req, res) {
    const token = cookieValue(req, COOKIE);
    if (token) sessions.delete(token);
    send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) });
  }

  // Staff need the contact to follow up, but not the device id or user agent.
  function forStaff(r, now) {
    const { meta, ...user } = r.user;
    return { ...r, user, assessment: assess(r, now) };
  }

  // One entry per issue: reports merged into the same problem (backend/problems.py) are shown as
  // the problem's first report, with every report of it in `reports` (oldest first).
  const issueKey = (r) => r.problem?.id || r.id;
  function groupIssues(all, now) {
    const groups = new Map();
    for (const r of all) {
      const k = issueKey(r);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    return [...groups.values()].map((members) => {
      members.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
      const lead = members.find((m) => m.problem?.is_first_report) || members[0];
      const issue = forStaff(lead, now);
      issue.reports = members.map((m) => {
        const s = forStaff(m, now);
        delete s.assessment;
        return s;
      });
      issue.open = members.some((m) => !DONE.includes(m.gov.status));
      return issue;
    });
  }

  async function reports(res, url) {
    const status = url.searchParams.get('status') || 'open';
    if (!['open', 'closed', 'all'].includes(status)) return send(res, 400, { error: 'bad status filter' });
    const now = Date.now();
    const list = groupIssues(await store.list(), now)
      .filter((i) => status === 'all' || (status === 'open') === i.open)
      .sort((a, b) => b.assessment.rank - a.assessment.rank || a.created_at.localeCompare(b.created_at));
    send(res, 200, { reports: list, criteria: { tiers: TIERS, valid: VALID_RULES, categories: CATEGORY } });
  }

  async function action(req, res, user, id) {
    const body = await readJson(req);
    if (!body) return send(res, 400, { error: 'expected JSON' });
    const status = ACTIONS[body.action];
    if (!status) return send(res, 400, { error: `action must be one of ${Object.keys(ACTIONS).join(', ')}` });
    const r = await store.findById(id);
    if (!r) return send(res, 404, { error: 'report not found' });
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 300) : '';
    if (status === 'rejected' && !note) return send(res, 400, { error: 'Say why it is invalid (the reporter sees this note).' });
    const changes = { status, updated_by: user.id };
    if (note) changes.note = note;
    // Taking the job: record the department doing it (the AI's suggestion unless staff set one).
    // Only the six departments in schema/report.schema.json are allowed in gov.department.
    if (status === 'in_progress' && !r.gov.department) {
      const ai = DEPARTMENTS.includes(r.ai?.department) ? r.ai.department : null;
      changes.department = ai || user.department || 'other';
    }
    // The action is for the issue, so every report of it gets the same status and note.
    const all = await store.list();
    const members = all.filter((m) => issueKey(m) === issueKey(r));
    for (const m of members) await store.updateGov(m.id, changes);
    console.log(`gov ${user.id} ${members.map((m) => m.id).join(',')} -> ${status}`);
    const fresh = (await store.list()).filter((m) => issueKey(m) === issueKey(r));
    send(res, 200, { report: groupIssues(fresh, Date.now())[0] });
  }

  // Returns true when the request was a /api/gov route.
  async function handle(req, res, url) {
    const p = url.pathname;
    if (!p.startsWith('/api/gov/')) return false;
    if (p === '/api/gov/login' && req.method === 'POST') return login(req, res), true;
    if (p === '/api/gov/logout' && req.method === 'POST') return logout(req, res), true;
    const user = currentUser(req);
    if (!user) return send(res, 401, { error: 'login required' }), true;
    if (p === '/api/gov/me') return send(res, 200, { user: publicUser(user) }), true;
    if (p === '/api/gov/reports' && req.method === 'GET') return await reports(res, url), true;
    const m = /^\/api\/gov\/reports\/(R-\d+)\/action$/.exec(p);
    if (m && req.method === 'POST') return await action(req, res, user, m[1]), true;
    const media = /^\/api\/gov\/media\/((photos|audio)\/[^/]+)$/.exec(p);
    if (media) return await serveMedia(req, res, media[1], 'private, max-age=3600'), true;
    send(res, 404, { error: 'not found' });
    return true;
  }

  return { handle, users: GOV_USERS, pinSource: process.env.GOV_DEMO_PIN ? 'GOV_DEMO_PIN' : path.join(deps.dataDir, 'gov_users.json') };
}

module.exports = { createGov, GOV_USERS };
