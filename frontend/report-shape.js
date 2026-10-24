// The report shape shared by both stores (schema/report.schema.json):
//   { id, client_report_id, created_at, user: {...}, ai: {...} | null, gov: {...} }
// These helpers mirror civic_status_history() / civic_public_json() in schema/supabase.sql,
// so the file store and Supabase return the same JSON.

// received -> in_review -> assigned -> in_progress -> resolved; rejected can happen at any point.
const STATUSES = ['received', 'in_review', 'assigned', 'in_progress', 'resolved', 'rejected'];
const DEPARTMENTS = ['public_works', 'parks_and_recreation', 'police', 'fire', 'health_and_inspections', 'other'];

function emptyGov() {
  return {
    status: 'received',
    department: null,
    severity_score: null, // string ("64") when set, as in the shared schema
    feedback: null,
    internal_notes: null,
    updated_by: null,
    updated_at: null,
    status_history: [],
  };
}

// Timeline for the board. Reports nobody has touched have no history: start it at creation.
function statusHistory(r) {
  const g = r.gov;
  if (g.status_history && g.status_history.length) return g.status_history;
  const h = [{ status: 'received', at: r.created_at, note: null }];
  if (g.status !== 'received') h.push({ status: g.status, at: g.updated_at || r.created_at, note: g.feedback });
  return h;
}

// Only these fields leave the server on the public board. Contact, device id, user agent,
// client id, the voice note (the reporter's own voice), ai reasons and internal notes stay private.
function publicIssue(r, distanceKm = null) {
  const loc = r.user.location || {};
  return {
    id: r.id,
    created_at: r.created_at,
    updated_at: r.gov.updated_at || r.created_at,
    status: r.gov.status,
    status_history: statusHistory(r),
    category: r.ai?.category || r.user.category || null,
    description: r.user.description,
    location: { lat: loc.lat ?? null, lng: loc.lng ?? null, address: loc.address ?? null },
    photo_url: `/api/issues/${encodeURIComponent(r.id)}/photo`,
    distance_km: distanceKm == null ? null : Math.round(distanceKm * 100) / 100,
  };
}

// Reports written by earlier versions of the Node server were flat
// ({status, status_history, photo, location, contact, ...}). Convert them on read.
function fromLegacy(r) {
  if (r.user) {
    r.gov = { ...emptyGov(), ...r.gov };
    r.ai = r.ai ?? null;
    return r;
  }
  const history = Array.isArray(r.status_history) ? r.status_history : [];
  const last = history[history.length - 1];
  return {
    id: r.id,
    client_report_id: r.client_report_id ?? null,
    created_at: r.created_at,
    user: {
      submitted_at: r.submitted_at ?? null,
      photo: r.photo,
      audio: r.audio ?? null,
      description: r.description ?? null,
      category: r.category ?? null,
      location: r.location,
      contact: r.contact || { email: null, phone: null },
      meta: r.meta || { device_id: null, user_agent: null, was_queued_offline: false },
    },
    ai: null,
    gov: {
      ...emptyGov(),
      status: last?.status || r.status || 'received',
      feedback: [...history].reverse().find((e) => e.note)?.note ?? null,
      updated_at: history.length > 1 ? last.at : null,
      status_history: history,
    },
  };
}

// Validate a staff update ({status, note, department, severity_score, internal_notes, updated_by}).
// Returns { changes } with only the given keys, or { error }.
function cleanGovChanges(input) {
  const out = {};
  const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : v == null ? '' : String(v).trim().slice(0, max));
  if (input.status != null && input.status !== '') {
    if (!STATUSES.includes(input.status)) return { error: `status must be one of ${STATUSES.join(', ')}` };
    out.status = input.status;
  }
  if ('note' in input) out.note = text(input.note, 300);
  if ('department' in input) {
    const d = text(input.department, 40);
    if (d && !DEPARTMENTS.includes(d)) return { error: `department must be one of ${DEPARTMENTS.join(', ')}` };
    out.department = d;
  }
  if ('severity_score' in input) {
    const s = text(input.severity_score, 3);
    if (s && !(/^\d{1,3}$/.test(s) && Number(s) <= 100)) return { error: 'severity_score must be 0-100' };
    out.severity_score = s === '' ? '' : String(Number(s));
  }
  if ('internal_notes' in input) out.internal_notes = text(input.internal_notes, 2000);
  if ('updated_by' in input) out.updated_by = text(input.updated_by, 100);
  return { changes: out };
}

// Apply cleaned changes to a report in memory. Same rules as set_report_gov() in SQL.
function applyGov(r, c, now = new Date().toISOString()) {
  const g = r.gov;
  const status = c.status || g.status;
  const note = c.note || null;
  const history = statusHistory(r).slice();
  if (status !== g.status || note) history.push({ status, at: now, note });
  g.status = status;
  g.status_history = history;
  if (note) g.feedback = note;
  if ('department' in c) g.department = c.department || null;
  if ('severity_score' in c) g.severity_score = c.severity_score === '' ? null : c.severity_score;
  if ('internal_notes' in c) g.internal_notes = c.internal_notes || null;
  if (c.updated_by) g.updated_by = c.updated_by;
  g.updated_at = now;
  return r;
}

module.exports = { STATUSES, DEPARTMENTS, emptyGov, statusHistory, publicIssue, fromLegacy, cleanGovChanges, applyGov };
