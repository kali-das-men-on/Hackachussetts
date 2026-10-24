'use strict';

const $ = (id) => document.getElementById(id);
const QUEUE_KEY = 'pending_reports_v1';
const GEO_TIMEOUT_MS = 8000;
const MAX_PX = 1280;
const DEFAULT_CENTER = [42.3601, -71.0589]; // Boston, used only when we have no fix
const FAIL = new URLSearchParams(location.search).get('fail') === '1';

const state = {
  photo: null,        // Blob, re-encoded JPEG (EXIF stripped)
  point: null,        // { lat, lng, accuracy_m }
  source: null,       // 'gps' | 'map' | 'address'
  address: '',        // reverse-geocoded or typed
  category: null,
  locating: null,     // Promise while a GPS request is in flight
  sending: false,
  retry: false,       // last send hit a server error
};

// ---------- storage (every access can throw in private mode) ----------
function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}
const deviceId = lsGet('device_id', null) || (() => { const id = uuid(); lsSet('device_id', id); return id; })();

// ---------- photo ----------
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
    img.src = url;
  });
}

// Drawing to a canvas applies EXIF orientation and drops all EXIF (incl. GPS) on re-encode.
async function processPhoto(file) {
  const img = await loadImage(file);
  const scale = Math.min(1, MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/jpeg', 0.82));
}

async function onPhotoPicked(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    state.photo = await processPhoto(file);
  } catch {
    showBanner("Couldn't read that photo. Try taking it again.");
    return;
  }
  $('preview-img').src = URL.createObjectURL(state.photo);
  $('preview').hidden = false;
  $('photo-card').classList.add('has-photo');
  hideBanner();
  refresh();
  // The page is visible again now, so the permission prompt can actually be seen.
  if (!state.point) locate();
}

// ---------- location ----------
function setLoc(kind, status, detail = '') {
  $('loc-dot').className = 'dot ' + kind;
  $('loc-status').textContent = status;
  $('loc-detail').textContent = detail;
}

const UA = navigator.userAgent;
const IS_IOS = /iPhone|iPad|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IN_APP = /FBAN|FBAV|Instagram|Line\/|MicroMessenger|Snapchat|TikTok|LinkedInApp/i.test(UA);

// Steps to un-block location, worded for the browser the user is actually in.
function locationHelpSteps() {
  if (IN_APP) {
    return ['This in-app browser blocks location.', 'Open the ⋯ menu and choose "Open in Safari" / "Open in Chrome".'];
  }
  if (IS_IOS) {
    const app = /CriOS/.test(UA) ? 'Chrome' : /FxiOS/.test(UA) ? 'Firefox' : /EdgiOS/.test(UA) ? 'Edge' : null;
    if (app) {
      return [`iPhone Settings → Privacy & Security → Location Services → On.`,
        `Same screen → ${app} → "While Using the App".`, 'Come back and reload this page.'];
    }
    // Safari's default is "Ask", so a reload re-prompts unless something stricter is set.
    return ['Tap "Reload page", then tap Allow when Safari asks.',
      'No question shown? Tap aA (left of the address) → Website Settings → Location → Ask, then reload.',
      'Still nothing? iPhone Settings → Privacy & Security → Location Services → On → Safari Websites → "While Using the App".'];
  }
  if (/Android/.test(UA)) {
    const app = /SamsungBrowser/.test(UA) ? 'Samsung Internet' : /Firefox/.test(UA) ? 'Firefox' : 'Chrome';
    return ['Tap the icon left of the address bar → Permissions (or Location) → Allow.',
      `Still blocked? Android Settings → Location → On, and Settings → Apps → ${app} → Permissions → Location → Allow.`,
      'Reload this page.'];
  }
  return ['Click the icon left of the address bar → Location → Allow, then reload.'];
}

function showLocationHelp(show) {
  const box = $('loc-help');
  box.hidden = !show;
  if (!show) return;
  const ol = $('loc-help-steps');
  ol.replaceChildren(...locationHelpSteps().map((s) => Object.assign(document.createElement('li'), { textContent: s })));
}

function getPosition(opts) {
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, opts));
}

// Only call this while the page is visible: a prompt raised while the camera covers
// the page gets dismissed, and Safari/Chrome then report it as "denied".
function locate() {
  if (state.locating) return state.locating;
  if (!window.isSecureContext || !('geolocation' in navigator)) {
    locationFailed(0);
    return Promise.resolve();
  }
  setLoc('busy', 'Finding your location…');
  $('loc-btn').hidden = true;
  showLocationHelp(false);
  state.locating = (async () => {
    try {
      let pos;
      try {
        pos = await getPosition({ enableHighAccuracy: true, timeout: GEO_TIMEOUT_MS, maximumAge: 30000 });
      } catch (e) {
        if (e.code === 1) throw e;
        // No GPS fix in time (indoors, GPS off): a Wi-Fi/cell estimate is better than nothing.
        pos = await getPosition({ enableHighAccuracy: false, timeout: GEO_TIMEOUT_MS, maximumAge: 300000 });
      }
      // A map pin the user placed meanwhile beats a late fix.
      if (state.source !== 'map') setPoint(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, 'gps');
    } catch (e) {
      locationFailed(e.code);
    }
  })().finally(() => { state.locating = null; });
  return state.locating;
}

// code: 1 = permission denied, 2/3 = no fix / timeout, 0 = not supported here
function locationFailed(code) {
  if (state.point) return;
  const msg = code === 1 ? 'Location is blocked for this site.'
    : code === 0 ? 'Location is not available in this browser.'
    : "Couldn't get a location fix.";
  setLoc('bad', msg, 'Type an address or pick on the map instead.');
  showLocationHelp(code === 1 || code === 0);
  $('loc-manual').hidden = false;
  $('loc-btn').hidden = false;
  $('loc-btn').classList.remove('primary');
  $('loc-btn').textContent = 'Try again';
  $('map-btn').textContent = 'Pick on map';
  refresh();
}

function setPoint(lat, lng, accuracy, source) {
  state.point = { lat, lng, accuracy_m: accuracy ?? null };
  state.source = source;
  showLocationHelp(false);
  $('loc-manual').hidden = true;
  const acc = accuracy ? ` · ±${Math.round(accuracy)} m` : '';
  // iOS "Precise Location" off or Wi-Fi-only fixes can be kilometres off.
  const rough = source === 'gps' && accuracy > 300;
  setLoc(rough ? 'busy' : 'ok',
    source === 'map' ? 'Pin placed on map' : rough ? 'Approximate location' + acc + ' — tap Adjust on map' : 'Location found' + acc,
    `${lat.toFixed(5)}, ${lng.toFixed(5)}`);
  $('map-btn').textContent = 'Adjust on map';
  if (marker) { marker.setLatLng([lat, lng]); }
  reverseGeocode(lat, lng);
  refresh();
}

let geocodeSeq = 0;
async function reverseGeocode(lat, lng) {
  const seq = ++geocodeSeq;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&lat=${lat}&lon=${lng}`,
      { signal: ctl.signal, headers: { 'Accept-Language': navigator.language || 'en' } });
    clearTimeout(t);
    if (!r.ok || seq !== geocodeSeq) return;
    const j = await r.json();
    const a = j.address || {};
    const line = [[a.house_number, a.road].filter(Boolean).join(' '), a.city || a.town || a.village || a.suburb]
      .filter(Boolean).join(', ') || j.display_name;
    if (line && seq === geocodeSeq) {
      state.address = line.slice(0, 300);
      $('loc-detail').textContent = state.address;
    }
  } catch { /* address is a nice-to-have; coordinates are enough */ }
}

// ---------- map (Leaflet, loaded only when asked for) ----------
let map = null;
let marker = null;
let leafletLoading = null;

function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (leafletLoading) return leafletLoading;
  leafletLoading = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    s.onload = resolve;
    s.onerror = () => { leafletLoading = null; reject(new Error('leaflet')); };
    document.head.appendChild(s);
  });
  return leafletLoading;
}

async function openMap() {
  $('map').hidden = false;
  $('map-btn').hidden = true;
  try { await loadLeaflet(); } catch {
    $('map').hidden = true;
    $('map-btn').hidden = false;
    $('loc-manual').hidden = false;
    showBanner("Map couldn't load. Type an address instead.");
    return;
  }
  if (map) { map.invalidateSize(); return; }
  const start = state.point ? [state.point.lat, state.point.lng] : DEFAULT_CENTER;
  map = L.map('map', { zoomControl: true }).setView(start, state.point ? 18 : 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap',
  }).addTo(map);
  marker = L.marker(start, { draggable: true }).addTo(map);
  const place = (ll) => { marker.setLatLng(ll); setPoint(ll.lat, ll.lng, null, 'map'); };
  marker.on('dragend', () => place(marker.getLatLng()));
  map.on('click', (e) => place(e.latlng));
  if (!state.point) setLoc('busy', 'Tap the map where the problem is');
}

// ---------- form ----------
function parseContact(raw) {
  const v = raw.trim();
  if (!v) return { ok: true, value: '' };
  if (v.includes('@')) return { ok: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), value: v };
  return { ok: /^\+?\d{7,15}$/.test(v.replace(/[^\d+]/g, '')), value: v };
}

function hasLocation() {
  return !!state.point || $('address').value.trim().length > 2;
}

function refresh() {
  const btn = $('send-btn');
  if (state.sending) { btn.disabled = true; btn.textContent = 'Sending…'; return; }
  btn.disabled = !state.photo;
  btn.textContent = !state.photo ? 'Add a photo to send' : state.retry ? 'Retry' : 'Send report';
}

function showBanner(msg, info = false) {
  const b = $('banner');
  b.textContent = msg;
  b.className = 'banner' + (info ? ' info' : '');
  b.hidden = false;
}
function hideBanner() { $('banner').hidden = true; }

function collectFields() {
  const typed = $('address').value.trim();
  const f = {
    client_report_id: uuid(),
    submitted_at: new Date().toISOString(),
    device_id: deviceId,
    location_source: state.point ? state.source : 'address',
    address: typed || state.address || '',
    description: $('description').value.trim(),
    category: state.category || '',
    contact: $('contact').value.trim(),
  };
  if (state.point) {
    f.lat = String(state.point.lat);
    f.lng = String(state.point.lng);
    if (state.point.accuracy_m != null) f.accuracy_m = String(state.point.accuracy_m);
  }
  return f;
}

class NetworkError extends Error {}

async function postReport(fields, photo) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== '' && v != null) fd.append(k, v);
  fd.append('photo', photo, 'photo.jpg');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30000);
  let r;
  try {
    r = await fetch('/api/reports' + (FAIL ? '?fail=1' : ''), { method: 'POST', body: fd, signal: ctl.signal });
  } catch {
    throw new NetworkError('network');
  } finally {
    clearTimeout(t);
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(body.error || `Server error (${r.status})`);
    e.status = r.status;
    throw e;
  }
  return body;
}

async function onSend() {
  if (state.sending || !state.photo) return;

  const contact = parseContact($('contact').value);
  $('contact-err').hidden = contact.ok;
  if (!contact.ok) { $('contact').focus(); return; }

  state.sending = true;
  refresh();
  hideBanner();

  if (!hasLocation() && state.locating) await state.locating;
  if (!hasLocation()) {
    state.sending = false;
    refresh();
    locationFailed(2);
    showBanner('Add where this is: type an address or pick on the map.', true);
    $('address').focus();
    return;
  }

  const fields = collectFields();
  try {
    if (navigator.onLine === false) throw new NetworkError('offline');
    const res = await postReport(fields, state.photo);
    showDone(res.id, false);
  } catch (e) {
    if (e instanceof NetworkError) {
      // Same client_report_id is reused on resend, so the server never double-counts.
      if (await enqueue(fields, state.photo)) showDone(null, true);
      else showBanner("No connection, and this browser can't save the report. Try again when online.");
    } else {
      showBanner(`${e.message}. Your photo is kept — tap Retry.`);
      state.retry = true;
    }
  } finally {
    state.sending = false;
    refresh();
  }
}

// ---------- offline queue ----------
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

async function enqueue(fields, photo) {
  const q = lsGet(QUEUE_KEY, []);
  q.push({ fields: { ...fields, queued: '1' }, photo: await blobToDataUrl(photo) });
  return lsSet(QUEUE_KEY, q);
}

let flushing = false;
async function flushQueue() {
  if (flushing || navigator.onLine === false) return;
  let q = lsGet(QUEUE_KEY, []);
  if (!q.length) return;
  flushing = true;
  try {
    while (q.length) {
      const item = q[0];
      try {
        const blob = await (await fetch(item.photo)).blob();
        await postReport(item.fields, blob);
      } catch (e) {
        if (e instanceof NetworkError || e.status >= 500 || e.status === 429) break;
        // 4xx means the server will never accept it; drop rather than retry forever.
      }
      q = lsGet(QUEUE_KEY, []).filter((x) => x.fields.client_report_id !== item.fields.client_report_id);
      lsSet(QUEUE_KEY, q);
    }
  } finally {
    flushing = false;
    showPending();
  }
}

function showPending() {
  const n = lsGet(QUEUE_KEY, []).length;
  if (n && !$('form-view').hidden && $('banner').hidden) {
    showBanner(`${n} saved report${n > 1 ? 's' : ''} waiting to send. We'll send ${n > 1 ? 'them' : 'it'} when you're online.`, true);
  } else if (!n && $('banner').classList.contains('info') && /waiting to send/.test($('banner').textContent)) {
    hideBanner();
  }
}

// ---------- done / reset ----------
function showDone(id, queued) {
  state.retry = false;
  $('form-view').hidden = true;
  $('send-bar').hidden = true;
  $('done-view').hidden = false;
  document.querySelector('.done').classList.toggle('queued', queued);
  $('done-title').textContent = queued ? 'Saved' : 'Report sent';
  $('done-ref').textContent = queued ? '' : id;
  $('done-msg').textContent = queued
    ? "You're offline. We'll send it automatically when you're back online — keep this page open or come back later."
    : 'Thanks! Keep this reference number if you contact the town.';
  lsSet('last_contact', $('contact').value.trim());
  window.scrollTo(0, 0);
}

function reset() {
  state.photo = null;
  state.category = null;
  $('preview').hidden = true;
  $('photo-card').classList.remove('has-photo');
  $('description').value = '';
  document.querySelectorAll('#chips button').forEach((b) => b.setAttribute('aria-checked', 'false'));
  hideBanner();
  $('done-view').hidden = true;
  $('form-view').hidden = false;
  $('send-bar').hidden = false;
  refresh();
  // Location is kept (likely the same spot); refresh it in the background if it came from GPS.
  if (state.source === 'gps') { state.point = null; locate(); }
  showPending();
}

// ---------- wiring ----------
$('photo-camera').addEventListener('change', onPhotoPicked);
$('photo-library').addEventListener('change', onPhotoPicked);
$('loc-btn').addEventListener('click', () => locate());
$('reload-btn').addEventListener('click', () => location.reload());
$('map-btn').addEventListener('click', openMap);
$('address').addEventListener('input', () => {
  if (!state.point) setLoc($('address').value.trim() ? 'ok' : 'bad', 'Using the address you typed', '');
  refresh();
});
$('chips').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-cat]');
  if (!b) return;
  const on = state.category !== b.dataset.cat;
  state.category = on ? b.dataset.cat : null;
  document.querySelectorAll('#chips button').forEach((x) => x.setAttribute('aria-checked', String(on && x === b)));
});
$('contact').addEventListener('input', () => { $('contact-err').hidden = true; });
$('send-btn').addEventListener('click', onSend);
$('again-btn').addEventListener('click', reset);
window.addEventListener('online', flushQueue);
setInterval(flushQueue, 30000);

$('contact').value = lsGet('last_contact', '') || '';
// Already granted: locate now. Already blocked: show the fix-it steps before the user takes a photo.
if (navigator.permissions && navigator.permissions.query) {
  navigator.permissions.query({ name: 'geolocation' }).then((p) => {
    if (p.state === 'granted') locate();
    else if (p.state === 'denied') locationFailed(1);
    p.onchange = () => { if (p.state === 'granted' && !state.point) locate(); };
  }).catch(() => {});
}
if (!window.isSecureContext) locationFailed(0);
refresh();
showPending();
flushQueue();
