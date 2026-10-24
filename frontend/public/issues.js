'use strict';
// Second panel: public issues board (nearby / recent) and "check my reports".
// Uses $, state, locate, loadLeaflet, lsGet and the report map from app.js.

const NEARBY_KM = 5;

// The steps a report normally moves through; "rejected" ends it early.
const STEPS = ['received', 'in_review', 'assigned', 'in_progress', 'resolved'];
const STATUS_LABEL = {
  received: 'Received',
  in_review: 'Under review',
  assigned: 'Crew assigned',
  in_progress: 'Being fixed',
  resolved: 'Fixed',
  rejected: 'Closed',
};
const STATUS_HINT = {
  received: 'The town has the report.',
  in_review: 'Staff are looking at it.',
  assigned: 'A crew or department has the job.',
  in_progress: 'Work has started.',
  resolved: 'The town marked this as fixed.',
  rejected: 'Closed without a fix. See the note for why.',
};
const CATEGORY_LABEL = {
  pothole: 'Pothole', streetlight: 'Streetlight', trash: 'Trash', graffiti: 'Graffiti', sidewalk: 'Sidewalk', other: 'Other',
};

const board = { mode: 'nearby', status: 'all', seq: 0, map: null, layer: null };

// ---------- small DOM helper (text only, never innerHTML with report data) ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid);
  return el;
}

function timeAgo(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

function fmtWhen(iso) {
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function fmtDistance(km) {
  if (km == null) return null;
  return km < 1 ? `${Math.round(km * 1000 / 10) * 10} m away` : `${km.toFixed(1)} km away`;
}

function badge(status) {
  return h('span', { class: `badge s-${status}`, text: STATUS_LABEL[status] || status });
}

// Five-dot progress bar: Received → Under review → Crew assigned → Being fixed → Fixed.
function progress(issue) {
  const status = issue.status;
  // A closed report shows how far it got before it was closed.
  const at = Math.max(...issue.status_history.map((e) => STEPS.indexOf(e.status)));
  return h('div', { class: 'steps' + (status === 'rejected' ? ' closed' : status === 'resolved' ? ' fixed' : ''), 'aria-hidden': 'true' },
    STEPS.map((s, i) => h('span', { class: 'step' + (i <= at ? ' on' : '') })));
}

function timeline(issue) {
  return h('ol', { class: 'timeline' },
    issue.status_history.slice().reverse().map((e) =>
      h('li', { class: `s-${e.status}` },
        h('b', { text: STATUS_LABEL[e.status] || e.status }),
        h('span', { class: 'muted', text: ' · ' + fmtWhen(e.at) }),
        e.note ? h('div', { text: e.note }) : null)));
}

function issueCard(issue) {
  const title = (CATEGORY_LABEL[issue.category] || 'Issue') + ' · ' + issue.id;
  const where = [issue.location.address, fmtDistance(issue.distance_km)].filter(Boolean).join(' · ');
  const summary = h('summary', {},
    h('img', { src: issue.photo_url, alt: '', loading: 'lazy', class: 'thumb' }),
    h('div', { class: 'grow' },
      h('div', { class: 'issue-head' }, h('b', { text: title }), badge(issue.status)),
      h('div', { class: 'issue-desc', text: issue.description || 'No description' }),
      h('div', { class: 'muted', text: where }),
      h('div', { class: 'muted small', text: `Reported ${timeAgo(issue.created_at)}${issue.report_count > 1 ? ` · ${issue.report_count} reports` : ''} · updated ${timeAgo(issue.updated_at)}` }),
      progress(issue)));
  return h('details', { class: 'card issue', id: 'issue-' + issue.id },
    summary,
    h('div', { class: 'issue-more' },
      h('p', { class: 'muted', text: STATUS_HINT[issue.status] || '' }),
      h('img', { src: issue.photo_url, alt: 'Photo of the issue', loading: 'lazy', class: 'full' }),
      timeline(issue)));
}

// ---------- public board ----------
async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `Server error (${r.status})`);
  return body;
}

async function loadBoard() {
  const seq = ++board.seq;
  const list = $('board-list');
  const params = new URLSearchParams({ status: board.status, limit: '50' });
  let where = null;

  if (board.mode === 'nearby') {
    $('board-status').textContent = 'Finding your location…';
    if (!state.point && window.isSecureContext && 'geolocation' in navigator) await locate();
    if (seq !== board.seq) return;
    where = state.point;
    if (where) {
      params.set('lat', where.lat);
      params.set('lng', where.lng);
      params.set('radius_km', NEARBY_KM);
    }
  }

  $('board-status').textContent = 'Loading…';
  let data;
  try {
    data = await fetchJson('/api/issues?' + params);
  } catch (e) {
    if (seq !== board.seq) return;
    $('board-status').textContent = navigator.onLine === false ? "You're offline. Issues will load when you're back online." : e.message;
    list.replaceChildren();
    return;
  }
  if (seq !== board.seq) return;

  const n = data.issues.length;
  const filter = board.status === 'open' ? 'open ' : board.status === 'resolved' ? 'fixed ' : '';
  if (board.mode === 'nearby' && !where) {
    $('board-status').textContent = `Location unavailable, showing the ${n} most recent ${filter}issues instead.`;
  } else if (board.mode === 'nearby') {
    $('board-status').textContent = n ? `${n} ${filter}issue${n === 1 ? '' : 's'} within ${NEARBY_KM} km, closest first.`
      : `No ${filter}issues reported within ${NEARBY_KM} km.`;
  } else {
    $('board-status').textContent = n ? `${n} most recent ${filter}issue${n === 1 ? '' : 's'}.` : `No ${filter}issues yet.`;
  }
  list.replaceChildren(...data.issues.map(issueCard));
  drawBoardMap(data.issues, where);
}

// Map with one dot per issue, coloured by status. Optional: the list works without it.
async function drawBoardMap(issues, me) {
  const pts = issues.filter((i) => i.location.lat != null);
  const el = $('board-map');
  if (!pts.length) { el.hidden = true; return; }
  try { await loadLeaflet(); } catch { el.hidden = true; return; }
  el.hidden = false;
  if (!board.map) {
    board.map = L.map('board-map', { zoomControl: true, preferCanvas: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(board.map);
  }
  if (board.layer) board.layer.remove();
  board.layer = L.layerGroup().addTo(board.map);
  const css = getComputedStyle(document.documentElement);
  for (const i of pts) {
    const color = css.getPropertyValue(`--s-${i.status}`).trim() || '#888';
    L.circleMarker([i.location.lat, i.location.lng], { radius: 9, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 })
      .addTo(board.layer)
      .bindTooltip(`${CATEGORY_LABEL[i.category] || 'Issue'} · ${STATUS_LABEL[i.status]}`)
      .on('click', () => {
        const card = $('issue-' + i.id);
        if (card) { card.open = true; card.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      });
  }
  const ll = pts.map((i) => [i.location.lat, i.location.lng]);
  if (me) {
    L.circleMarker([me.lat, me.lng], { radius: 7, color: '#fff', weight: 3, fillColor: '#0b5fff', fillOpacity: 1 })
      .addTo(board.layer).bindTooltip('You');
    ll.push([me.lat, me.lng]);
  }
  board.map.invalidateSize();
  board.map.fitBounds(ll, { padding: [24, 24], maxZoom: 16 });
}

// ---------- check my reports ----------
async function onLookup(e) {
  e.preventDefault();
  const raw = $('lookup-contact').value.trim();
  const out = $('lookup-results');
  const err = $('lookup-err');
  err.hidden = true;
  if (!parseContact(raw).ok || !raw) {
    err.textContent = 'Enter the email or phone number you put on the report.';
    err.hidden = false;
    return;
  }
  $('lookup-btn').disabled = true;
  out.replaceChildren(h('p', { class: 'muted', text: 'Checking…' }));
  try {
    const data = await fetchJson('/api/issues/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact: raw }),
    });
    const n = data.issues.length;
    out.replaceChildren(
      h('p', { class: 'muted', text: n ? `${n} report${n === 1 ? '' : 's'} sent with this contact:` : 'No reports found for that email or phone.' }),
      ...data.issues.map(issueCard));
  } catch (ex) {
    out.replaceChildren();
    err.textContent = navigator.onLine === false ? "You're offline. Try again when you're back online." : ex.message;
    err.hidden = false;
  } finally {
    $('lookup-btn').disabled = false;
  }
}

// ---------- tabs (#report / #issues, so the back button and links work) ----------
let boardLoaded = false;
function showTab() {
  const issues = location.hash === '#issues';
  $('panel-report').hidden = issues;
  $('panel-issues').hidden = !issues;
  $('tab-report').classList.toggle('active', !issues);
  $('tab-issues').classList.toggle('active', issues);
  $('tab-report').setAttribute('aria-selected', String(!issues));
  $('tab-issues').setAttribute('aria-selected', String(issues));
  if (issues) {
    if (!$('lookup-contact').value) $('lookup-contact').value = lsGet('last_contact', '') || '';
    if (!boardLoaded) { boardLoaded = true; loadBoard(); }
    else if (board.map) setTimeout(() => board.map.invalidateSize(), 0);
  } else if (typeof map !== 'undefined' && map) {
    // Leaflet measured the report map while it was hidden; re-measure now it is visible.
    setTimeout(() => map.invalidateSize(), 0);
  }
  window.scrollTo(0, 0);
}

for (const b of document.querySelectorAll('.seg-btn')) {
  b.addEventListener('click', () => {
    board.mode = b.dataset.mode;
    document.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    loadBoard();
  });
}
for (const b of document.querySelectorAll('.chip')) {
  b.addEventListener('click', () => {
    board.status = b.dataset.status;
    document.querySelectorAll('.chip').forEach((x) => x.classList.toggle('active', x === b));
    loadBoard();
  });
}
$('lookup-form').addEventListener('submit', onLookup);
// After sending, "Track its status" opens the board with the user's own reports looked up.
$('track-link').addEventListener('click', () => {
  const contact = lsGet('last_contact', '');
  boardLoaded = false;
  if (contact) {
    $('lookup-contact').value = contact;
    $('lookup-form').requestSubmit();
  }
});
window.addEventListener('hashchange', showTab);
showTab();
