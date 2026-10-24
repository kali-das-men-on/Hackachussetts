// Town staff dashboard: login, ranked list of reports, map, and actions.
// Data comes from /api/gov/* (frontend/gov.js); ranking and criteria from frontend/gov-criteria.js.
'use strict';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STATUS_LABEL = {
  received: 'Received', in_review: 'Under review', assigned: 'Crew assigned',
  in_progress: 'In progress', resolved: 'Complete', rejected: 'Invalid / closed',
};
const DEPT_LABEL = {
  public_works: 'Public Works', parks_and_recreation: 'Parks & Recreation', police: 'Police', fire: 'Fire',
  health_and_inspections: 'Health & Inspections', other: 'Other',
};
const TIER_COLOR = { P1: '#dc2626', P2: '#ea580c', P3: '#d97706', P4: '#71717a' }; // red / orange / amber / zinc
const CLOSED_COLOR = '#a1a1aa';

const state = { user: null, status: 'open', q: '', reports: [], criteria: null, selected: null };
let map, layer;
const markers = new Map();

async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    credentials: 'same-origin',
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && !path.endsWith('/login')) {
    showLogin();
    throw new Error('login required');
  }
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

// ---------- login ----------
function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#gov-id').focus();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    const { user } = await api('/api/gov/login', {
      method: 'POST',
      body: JSON.stringify({ id: $('#gov-id').value, pin: $('#gov-pin').value }),
    });
    $('#gov-pin').value = '';
    start(user);
  } catch (err) {
    $('#login-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/gov/logout', { method: 'POST', body: '{}' }).catch(() => {});
  state.user = null;
  showLogin();
});

function start(user) {
  state.user = user;
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#who').textContent = `${user.name} · ${user.id}`;
  initMap();
  requestAnimationFrame(movePill);
  load();
}

// ---------- data ----------
async function load() {
  $('#list').innerHTML = '<li class="muted">Loading…</li>';
  try {
    const data = await api(`/api/gov/reports?status=${state.status}`);
    state.reports = data.reports;
    state.criteria = data.criteria;
    render(true);
  } catch (err) {
    if (err.message !== 'login required') $('#list').innerHTML = `<li class="error">${esc(err.message)}</li>`;
  }
}

function members(r) {
  return r.reports && r.reports.length ? r.reports : [r];
}

function visible() {
  const q = state.q.toLowerCase();
  return state.reports.filter((r) => {
    if (!q) return true;
    const hay = [r.assessment.category, r.problem?.id, ...members(r).flatMap((m) => [m.id, m.user.location.address, m.user.description, m.ai?.summary])]
      .join(' ').toLowerCase();
    return hay.includes(q);
  });
}

// ---------- list ----------
function fmtDate(iso) {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function validBadge(ai) {
  if (!ai) return '<span class="badge gray">AI not run</span>';
  return ai.valid ? '<span class="badge ok">Valid</span>' : '<span class="badge bad">Not valid</span>';
}

function card(r, i) {
  const a = r.assessment;
  const closed = ['resolved', 'rejected'].includes(r.gov.status);
  const sev = r.gov.severity_score ?? r.ai?.severity_score;
  return `<li class="item${state.selected === r.id ? ' sel' : ''}" data-id="${esc(r.id)}" style="--i:${Math.min(i, 12)}">
    <button class="row" aria-expanded="${state.selected === r.id}">
      <span class="rank" style="background:${closed ? CLOSED_COLOR : TIER_COLOR[a.priority.id]}">${i + 1}</span>
      <img src="${esc(r.photo_src)}" alt="" loading="lazy">
      <span class="main">
        <span class="title">${esc(cap(a.category))} · ${esc(r.user.location.address || coords(r))}</span>
        <span class="sub">${esc(r.ai?.summary || r.user.description || 'No description')}</span>
        <span class="tags">
          <span class="badge" style="border-color:${TIER_COLOR[a.priority.id]};color:${TIER_COLOR[a.priority.id]}">${a.priority.id} ${esc(a.priority.label)}</span>
          ${validBadge(r.ai)}
          <span class="badge gray">${esc(STATUS_LABEL[r.gov.status])}</span>
          ${a.overdue ? '<span class="badge bad">Past target</span>' : ''}
          ${members(r).length > 1 ? `<span class="badge many" title="${esc(members(r).map((m) => m.id).join(', '))}">${members(r).length} reports</span>` : ''}
        </span>
      </span>
      <span class="score" title="${esc(a.rank_reason)}"><b>${sev ?? '–'}</b><small>severity</small></span>
    </button>
    ${state.selected === r.id ? detail(r) : ''}
  </li>`;
}

function cap(s) {
  return s ? (s[0].toUpperCase() + s.slice(1)).replace(/_/g, ' ') : '';
}

// Known departments get a label; new names from the agent (e.g. roads_traffic) are shown as written.
function deptName(d) {
  return d ? DEPT_LABEL[d] || cap(d) : null;
}

function coords(r) {
  const l = r.user.location;
  return l.lat != null ? `${l.lat.toFixed(5)}, ${l.lng.toFixed(5)}` : 'No location';
}

function detail(r) {
  const a = r.assessment;
  const ai = r.ai;
  const g = r.gov;
  const sev = Number(g.severity_score ?? ai?.severity_score ?? 0);
  const checks = a.criteria.valid
    .map((v) => `<li class="${v.result === true ? 'pass' : v.result === false ? 'fail' : 'unk'}" title="${esc(v.rule)}">
        <b>${v.result === true ? '✓' : v.result === false ? '✗' : '?'} ${esc(v.label)}</b></li>`)
    .join('');
  const closed = ['resolved', 'rejected'].includes(g.status);
  return `<div class="detail">
    <div class="media">
      <a href="${esc(r.photo_src)}" target="_blank"><img src="${esc(r.photo_src)}" alt="Report photo"></a>
      ${r.user.audio ? `<audio controls preload="metadata" src="/api/gov/media/${esc(r.user.audio.path)}"></audio>` : ''}
      <p><b>${esc(r.id)}</b> · ${esc(fmtDate(r.created_at))}<br>
      ${esc(r.user.description || 'No description')}<br>
      <small class="muted">${esc(r.user.location.address || '')} ${r.user.location.lat != null ? `· <a target="_blank" href="https://www.openstreetmap.org/?mlat=${r.user.location.lat}&mlon=${r.user.location.lng}#map=18/${r.user.location.lat}/${r.user.location.lng}">map</a>` : ''}</small><br>
      <small class="muted">Contact: ${esc(r.user.contact?.email || r.user.contact?.phone || 'none given')}</small></p>
    </div>

    <div class="grid">
      <div class="box">
        <h3>Is it valid? ${validBadge(ai)}</h3>
        <ul class="checks">${checks}</ul>
        ${ai ? `<p class="reason">${esc(ai.valid_reason)}</p>` : ''}
      </div>
      <div class="box">
        <h3>How serious? <span class="badge" style="border-color:${TIER_COLOR[a.priority.id]};color:${TIER_COLOR[a.priority.id]}">${a.priority.id} ${esc(a.priority.label)}</span></h3>
        <div class="sev"><span style="width:${sev}%;background:${TIER_COLOR[a.priority.id]}"></span></div>
        <p><b>${ai || g.severity_score ? `${sev}/100` : 'Not scored'}</b>${g.severity_score ? ' (staff)' : ''} · respond ${esc(a.priority.respond)}</p>
        ${ai ? `<p class="reason">${esc(ai.severity_reason)}</p>` : ''}
        <p class="rule"><b>MA rule:</b> ${esc(a.criteria.serious)}</p>
        <p class="rule"><b>Target:</b> ${esc(a.criteria.target)}${a.due_at ? ` · due ${esc(fmtDate(a.due_at))}` : ''}${a.overdue ? ' <span class="badge bad">past target</span>' : ''}</p>
      </div>
      <div class="box">
        <h3>AI suggestion</h3>
        <p><b>Department:</b> ${esc(deptName(a.suggested_department) || 'none yet')}${g.department && g.department !== a.suggested_department ? ` <small>(assigned: ${esc(deptName(g.department))})</small>` : ''}</p>
        ${ai ? `<p class="reason">${esc(ai.department_reason)}</p>` : ''}
        <p><b>Budget estimate:</b> ${esc(a.budget.text)} <small class="muted">(${esc(a.budget.basis)}; rough planning range, not a quote)</small></p>
        <p class="muted"><small>Rank ${a.rank}: ${esc(a.rank_reason)}</small></p>
      </div>
    </div>

    ${reportsOf(r)}

    <form class="actions" data-id="${esc(r.id)}">
      <input name="note" maxlength="300" placeholder="Note to the reporter${members(r).length > 1 ? 's' : ''} (public; required for Invalid)">
      <div class="btns">
        <button type="button" data-action="in_progress" ${g.status === 'in_progress' ? 'disabled' : ''}>In progress</button>
        <button type="button" data-action="complete" class="ok" ${g.status === 'resolved' ? 'disabled' : ''}>Complete</button>
        <button type="button" data-action="invalid" class="bad" ${g.status === 'rejected' ? 'disabled' : ''}>Invalid</button>
      </div>
      <p class="msg" role="status">${closed ? `Closed as ${esc(STATUS_LABEL[g.status])}${g.updated_by ? ` by ${esc(g.updated_by)}` : ''}. You can reopen it with In progress.` : g.updated_by ? `Last update by ${esc(g.updated_by)}, ${esc(fmtDate(g.updated_at))}` : ''}</p>
    </form>
  </div>`;
}

// The other reports merged into this issue, with why each one was matched.
function reportsOf(r) {
  const list = members(r);
  if (list.length < 2) return '';
  const p = r.problem || {};
  return `<div class="box merged">
    <h3>${list.length} reports of this issue <small class="muted">${p.reporter_count ? `· ${p.reporter_count} separate reporter${p.reporter_count === 1 ? '' : 's'}` : ''}</small></h3>
    <p class="muted"><small>Merged because they have the same photo, or are close together with the same kind of issue, or the AI found the photos show the same thing. Actions below apply to all of them.</small></p>
    <ul class="merged-list">${list.map((m) => `<li>
      <a href="/api/gov/media/${esc(m.user.photo.path)}" target="_blank"><img src="/api/gov/media/${esc(m.user.photo.path)}" alt="" loading="lazy"></a>
      <span><b>${esc(m.id)}</b> · ${esc(fmtDate(m.created_at))}${m.ai?.severity_score != null ? ` · severity ${esc(m.ai.severity_score)}` : ''}<br>
      ${esc(m.user.description || m.ai?.summary || 'No description')}<br>
      <small class="muted">${m.id === r.id ? 'First report' : esc(m.problem?.merge_reason || 'merged')}${m.problem && !m.problem.counted ? ' · same reporter or photo as an earlier report' : ''}
      · contact: ${esc(m.user.contact?.email || m.user.contact?.phone || 'none')}</small></span>
    </li>`).join('')}</ul>
  </div>`;
}

// animate = staggered blur-fade of the list (only on a fresh load, not on every click).
function render(animate = false) {
  const items = visible();
  const open = state.reports.filter((r) => r.open ?? !['resolved', 'rejected'].includes(r.gov.status)).length;
  $("#counts").textContent = `${items.length} issue${items.length === 1 ? "" : "s"} shown${state.status !== 'closed' ? ` · ${open} open` : ''}`;
  for (const r of state.reports) r.photo_src = `/api/gov/media/${r.user.photo.path}`;
  $('#list').classList.toggle('enter', animate);
  $('#list').innerHTML = items.length ? items.map(card).join('') : '<li class="muted">No issues match.</li>';
  drawMap(items);
}

$('#list').addEventListener('click', async (e) => {
  const act = e.target.closest('button[data-action]');
  if (act) return doAction(act);
  const row = e.target.closest('button.row');
  if (!row) return;
  const id = row.closest('li').dataset.id;
  select(state.selected === id ? null : id, true);
});

function select(id, fromList) {
  state.selected = id;
  render();
  if (!id) return;
  const r = state.reports.find((x) => x.id === id);
  const m = markers.get(id);
  if (m && fromList) map.setView(m.getLatLng(), Math.max(map.getZoom(), 15));
  if (m) m.openPopup();
  if (!fromList) document.querySelector(`li[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  return r;
}

async function doAction(btn) {
  const form = btn.closest('form');
  const id = form.dataset.id;
  const note = form.note.value.trim();
  const msg = form.querySelector('.msg');
  if (btn.dataset.action === 'invalid' && !note) {
    msg.textContent = 'Add a note saying why it is invalid. The reporter sees it.';
    form.note.focus();
    return;
  }
  for (const b of form.querySelectorAll('button')) b.disabled = true;
  msg.textContent = 'Saving…';
  try {
    const { report } = await api(`/api/gov/reports/${encodeURIComponent(id)}/action`, {
      method: 'POST',
      body: JSON.stringify({ action: btn.dataset.action, note }),
    });
    const i = state.reports.findIndex((x) => x.id === id);
    state.reports[i] = report;
    render();
  } catch (err) {
    msg.textContent = err.message;
    for (const b of form.querySelectorAll('button')) b.disabled = false;
  }
}

// File missing from storage: say so instead of a broken image or a silent player.
$('#list').addEventListener('error', (e) => {
  const el = e.target;
  if (el.tagName === 'IMG') {
    el.classList.add('noimg');
    el.title = 'Photo file is missing from storage';
    if (el.closest('.media')) el.closest('a').insertAdjacentHTML('afterend', '<small class="missing">Photo file is missing from storage.</small>');
  } else if (el.tagName === 'AUDIO') {
    el.outerHTML = '<small class="missing">Voice note file is missing from storage.</small>';
  }
}, true);

// ---------- map ----------
function initMap() {
  if (map || !window.L) return;
  map = L.map('map', { preferCanvas: true }).setView([42.3732, -72.5199], 13); // Amherst, MA
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
  layer = L.layerGroup().addTo(map);
  $('#legend').innerHTML = Object.entries(TIER_COLOR).map(([k, c]) => `<span><i style="background:${c}"></i>${k}</span>`).join('')
    + `<span><i style="background:${CLOSED_COLOR}"></i>closed</span>`;
}

let fitted = false;
function drawMap(items) {
  if (!map) {
    $('#map').textContent = 'Map could not load (no connection to unpkg.com).';
    return;
  }
  layer.clearLayers();
  markers.clear();
  const pts = [];
  const focus = []; // first fit: reports the AI says are in the service area, so far-away ones don't zoom out to all of MA
  items.forEach((r, i) => {
    const l = r.user.location;
    if (l.lat == null) return;
    const closed = ['resolved', 'rejected'].includes(r.gov.status);
    const color = closed ? CLOSED_COLOR : TIER_COLOR[r.assessment.priority.id];
    const sel = state.selected === r.id;
    const m = L.circleMarker([l.lat, l.lng], { radius: sel ? 13 : 9, color: sel ? '#000' : '#fff', weight: sel ? 3 : 2, fillColor: color, fillOpacity: 1 })
      .bindPopup(`<b>#${i + 1} ${esc(r.id)}</b> ${esc(cap(r.assessment.category))}<br>${esc(l.address || '')}<br>${esc(STATUS_LABEL[r.gov.status])}`)
      .on('click', () => select(r.id, false))
      .addTo(layer);
    markers.set(r.id, m);
    pts.push([l.lat, l.lng]);
    if (r.ai?.valid_checks?.in_service_area !== false) focus.push([l.lat, l.lng]);
  });
  if (!fitted && pts.length) {
    map.fitBounds(focus.length ? focus : pts, { padding: [30, 30], maxZoom: 15 });
    fitted = true;
  }
  setTimeout(() => map.invalidateSize(), 0);
}

// ---------- filters ----------
document.querySelector('.seg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-status]');
  if (!b) return;
  for (const x of document.querySelectorAll('.seg button')) x.classList.toggle('on', x === b);
  movePill();
  state.status = b.dataset.status;
  state.selected = null;
  load();
});
$('#search').addEventListener('input', (e) => {
  state.q = e.target.value.trim();
  render();
});

// Sliding pill behind the active segment (motion-primitives AnimatedBackground).
const pill = document.createElement('span');
pill.className = 'pill';
document.querySelector('.seg').prepend(pill);
function movePill() {
  const on = document.querySelector('.seg button.on');
  if (!on) return;
  pill.style.width = `${on.offsetWidth}px`;
  pill.style.transform = `translateX(${on.offsetLeft}px)`;
}
window.addEventListener('resize', movePill);

// ---------- criteria panel ----------
$('#show-criteria').addEventListener('click', () => {
  const c = state.criteria;
  if (!c) return;
  $('#criteria-body').innerHTML = `<h2>How reports are judged (Massachusetts)</h2>
    <h3>Valid: all three must pass</h3>
    <ul>${c.valid.map((v) => `<li><b>${esc(v.label)}.</b> ${esc(v.rule)}</li>`).join('')}</ul>
    <h3>Priority from severity (0-100)</h3>
    <ul>${c.tiers.map((t) => `<li><b style="color:${TIER_COLOR[t.id]}">${t.id} ${esc(t.label)}</b> (${t.min}+): respond ${esc(t.respond)}</li>`).join('')}</ul>
    <p class="muted">Imminent danger (downed wires, sinkhole, flooding): call 911, this is not an emergency service.</p>
    <h3>By category</h3>
    <table>${Object.entries(c.categories).map(([k, v]) => `<tr><th>${esc(cap(k))}</th><td>${esc(v.serious)}<br><small class="muted">${esc(v.target)}. Budget: ${v.budget.map((b) => `$${b[0].toLocaleString()}-$${b[1].toLocaleString()} ${esc(b[2])}`).join('; ')}</small></td></tr>`).join('')}</table>
    <h3>AI rank</h3>
    <p>Severity (staff score if set, else AI), plus up to 15 for days open, plus 10 if past the category target. Reports the AI marks not valid are multiplied by 0.4. Reports not yet analyzed count as 30.</p>
    <p class="muted"><small>Sources: M.G.L. c.84 §15; 521 CMR 22 (Architectural Access Board); M.G.L. c.270 §16; M.G.L. c.87; Boston CityScore 311 targets. Budgets are rough planning ranges.</small></p>`;
  $('#criteria').showModal();
});

// ---------- boot ----------
api('/api/gov/me').then(({ user }) => start(user)).catch(() => {});
