'use strict';

const $ = (id) => document.getElementById(id);
const QUEUE_KEY = 'pending_reports_v1';
const GEO_TIMEOUT_MS = 8000;
const AUDIO_MAX_S = 30;
const AUDIO_MIN_S = 0.5;
const MAX_PX = 1280;
const DEFAULT_CENTER = [42.3601, -71.0589]; // Boston, used only when we have no fix
const FAIL = new URLSearchParams(location.search).get('fail') === '1';

const state = {
  photo: null,        // Blob, re-encoded JPEG (EXIF stripped)
  audio: null,        // { blob, duration_s, name } optional voice note, <= 30 s
  point: null,        // { lat, lng, accuracy_m }
  source: null,       // 'gps' | 'map' | 'address'
  address: '',        // reverse-geocoded or typed
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
// force: the user tapped "Use my location", so the fix replaces a typed address or map pin.
function locate(force = false) {
  if (force) state.forceGps = true;
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
      // Without a tap on "Use my location", a pin the user placed or an address they
      // looked up meanwhile beats a late fix.
      if (state.forceGps || (state.source !== 'map' && state.source !== 'address')) {
        lastSearched = '';
        if (document.activeElement === $('address')) $('address').blur();
        $('addr-results').hidden = true;
        addrMsg('');
        setPoint(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, 'gps');
      } else {
        showPlaced(); // put back the status line that "Finding your location…" replaced
      }
    } catch (e) {
      locationFailed(e.code, state.forceGps);
    }
  })().finally(() => { state.locating = null; state.forceGps = false; });
  return state.locating;
}

// code: 1 = permission denied, 2/3 = no fix / timeout, 0 = not supported here
// forced: the user asked for their location; tell them it failed even if a pin is already set.
function locationFailed(code, forced = false) {
  if (state.point && !forced) { showPlaced(); return; }
  const msg = code === 1 ? 'Location is blocked for this site.'
    : code === 0 ? 'Location is not available in this browser.'
    : "Couldn't get a location fix.";
  setLoc('bad', msg, state.point ? 'The pin stays where it was. Drag it, or type an address and tap Find.'
    : 'Type an address above and tap Find, or pick on the map.');
  showLocationHelp(code === 1 || code === 0);
  $('loc-btn').hidden = false;
  $('loc-btn').classList.remove('primary');
  $('loc-btn').textContent = 'Try again';
  $('map-btn').textContent = 'Pick on map';
  refresh();
}

// "Use my location" stays available whenever the pin came from a typed address or the map,
// so the user can always switch back to where they are standing.
function showLocButton() {
  const btn = $('loc-btn');
  btn.hidden = state.source === 'gps';
  btn.classList.remove('primary');
  btn.textContent = 'Use my location';
}

// The status line for the current pin, e.g. after a background GPS attempt was ignored.
function showPlaced() {
  if (!state.point) return;
  setLoc('ok', state.source === 'map' ? 'Pin placed on map' : 'Address found. Drag the pin if it is off.', state.address);
  showLocButton();
}

// source: 'gps' (device fix), 'map' (user moved the pin) or 'address' (typed address, geocoded).
// label: the address text to show, when the caller already knows it (typed address).
function setPoint(lat, lng, accuracy, source, label = null) {
  state.point = { lat, lng, accuracy_m: accuracy ?? null };
  state.source = source;
  showLocationHelp(false);
  const acc = accuracy ? ` · ±${Math.round(accuracy)} m` : '';
  // iOS "Precise Location" off or Wi-Fi-only fixes can be kilometres off.
  const rough = source === 'gps' && accuracy > 300;
  setLoc(rough ? 'busy' : 'ok',
    source === 'map' ? 'Pin placed on map'
      : source === 'address' ? 'Address found. Drag the pin if it is off.'
      : rough ? 'Approximate location' + acc + ' — tap Adjust on map' : 'Location found' + acc,
    label || `${lat.toFixed(5)}, ${lng.toFixed(5)}`);
  $('map-btn').textContent = 'Adjust on map';
  showLocButton();
  if (marker) {
    marker.setLatLng([lat, lng]);
    if (map && source !== 'map') map.setView([lat, lng], 18);
  } else if (source !== 'map') {
    // Show the map automatically so the user can see and confirm the spot,
    // even when the location came from GPS or a typed address.
    openMap();
  }
  if (label) {
    geocodeSeq++; // a slower reverse lookup for an older pin must not overwrite this
    setAddress(label);
  } else {
    reverseGeocode(lat, lng);
  }
  refresh();
}

// The address box always shows the address of the pin, except while the user is typing in it.
function setAddress(line) {
  state.address = line.slice(0, 300);
  $('loc-detail').textContent = state.address;
  if (document.activeElement !== $('address')) $('address').value = state.address;
}

function addressLine(j) {
  const a = j.address || {};
  return [[a.house_number, a.road].filter(Boolean).join(' ') || a.amenity || a.building || j.name,
    a.city || a.town || a.village || a.suburb]
    .filter(Boolean).join(', ') || j.display_name || '';
}

function nominatim(pathAndQuery) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  return fetch(`https://nominatim.openstreetmap.org/${pathAndQuery}&accept-language=${encodeURIComponent(navigator.language || 'en')}`,
    { signal: ctl.signal })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .finally(() => clearTimeout(t));
}

let geocodeSeq = 0;
async function reverseGeocode(lat, lng) {
  const seq = ++geocodeSeq;
  try {
    const j = await nominatim(`reverse?format=jsonv2&zoom=18&lat=${lat}&lon=${lng}`);
    const line = addressLine(j);
    if (line && seq === geocodeSeq) setAddress(line);
  } catch { /* address is a nice-to-have; coordinates are enough */ }
}

// ---------- typed address -> map pin (Nominatim search) ----------
// Nominatim's usage policy forbids search-as-you-type, so this runs on Find / Enter / leaving the field.
let searchSeq = 0;
let lastSearched = '';

function addrMsg(text) {
  $('addr-msg').textContent = text || '';
  $('addr-msg').hidden = !text;
}

let searching = null; // Promise while a lookup is in flight
function searchAddress() {
  // Find + leaving the field can both fire; queue them so Send can wait on the last one.
  const p = (searching || Promise.resolve()).then(doSearchAddress).finally(() => {
    if (searching === p) searching = null;
  });
  searching = p;
  return p;
}

async function doSearchAddress() {
  const q = $('address').value.trim();
  $('addr-results').hidden = true;
  if (q.length < 3 || q === lastSearched || q === state.address) return;
  lastSearched = q;
  const seq = ++searchSeq;
  $('addr-btn').disabled = true;
  addrMsg('Searching…');
  // Prefer results near where the user is (or the last pin); results elsewhere are still allowed.
  const c = state.point || { lat: DEFAULT_CENTER[0], lng: DEFAULT_CENTER[1] };
  const box = [c.lng - 0.3, c.lat + 0.3, c.lng + 0.3, c.lat - 0.3].map((v) => v.toFixed(4)).join(',');
  let results;
  try {
    results = await nominatim(`search?format=jsonv2&addressdetails=1&limit=5&viewbox=${box}&q=${encodeURIComponent(q)}`);
  } catch {
    if (seq === searchSeq) {
      lastSearched = '';
      addrMsg(navigator.onLine === false ? "You're offline. The typed address will still be sent." : "Couldn't look up that address. It will still be sent as typed.");
    }
    return;
  } finally {
    if (seq === searchSeq) $('addr-btn').disabled = false;
  }
  if (seq !== searchSeq) return;
  if (!results.length) {
    addrMsg("Couldn't find that on the map. It will be sent as typed. You can also tap the map.");
    return;
  }
  addrMsg('');
  const pick = (r) => {
    const line = addressLine(r);
    lastSearched = line;
    $('address').value = line;
    setPoint(Number(r.lat), Number(r.lon), null, 'address', line);
  };
  pick(results[0]);
  if (results.length > 1) {
    // Show the other matches in case the first guess was the wrong "Main St".
    const items = results.map((r, i) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = r.display_name;
      if (i === 0) b.className = 'picked';
      b.addEventListener('click', () => {
        $('addr-results').querySelectorAll('button').forEach((x) => x.classList.toggle('picked', x === b));
        pick(r);
      });
      li.append(b);
      return li;
    });
    $('addr-results').replaceChildren(...items);
    $('addr-results').hidden = false;
  }
}

// ---------- address suggestions while typing (Photon) ----------
// Photon (photon.komoot.io) is an OpenStreetMap geocoder made for search-as-you-type,
// which Nominatim's policy does not allow. Requests are debounced and the previous one
// is cancelled, so fast typing sends about one request per pause.
const SUGGEST_MIN = 3;
const SUGGEST_DELAY_MS = 300;
const sug = { timer: null, ctl: null, items: [], active: -1, cache: new Map() };

function photonLine(p) {
  const street = [p.housenumber, p.street].filter(Boolean).join(' ');
  const town = p.city || p.town || p.village || p.district || p.county;
  // Named places (a park, a library) lead with the name; plain addresses with the street.
  const head = p.name && p.name !== p.street ? p.name : null;
  return [head, street || (head ? null : p.name), town].filter(Boolean).join(', ');
}

function photonDetail(p) {
  return [p.state, p.countrycode && p.countrycode.toUpperCase()].filter(Boolean).join(', ');
}

async function photon(q, bbox, signal) {
  const c = state.point || { lat: DEFAULT_CENTER[0], lng: DEFAULT_CENTER[1] };
  const params = new URLSearchParams({ q, limit: '6', lat: c.lat.toFixed(4), lon: c.lng.toFixed(4) });
  const lang = (navigator.language || 'en').slice(0, 2);
  if (['en', 'de', 'fr', 'it'].includes(lang)) params.set('lang', lang); // the languages Photon supports
  if (bbox) params.set('bbox', [c.lng - 0.4, c.lat - 0.4, c.lng + 0.4, c.lat + 0.4].map((v) => v.toFixed(4)).join(','));
  const r = await fetch('https://photon.komoot.io/api/?' + params, { signal });
  if (!r.ok) throw new Error(String(r.status));
  const j = await r.json();
  const seen = new Set();
  return (j.features || []).map((f) => ({
    line: photonLine(f.properties),
    detail: photonDetail(f.properties),
    lat: f.geometry.coordinates[1],
    lng: f.geometry.coordinates[0],
  })).filter((s) => s.line && !seen.has(s.line) && seen.add(s.line));
}

function closeSuggestions() {
  clearTimeout(sug.timer);
  if (sug.ctl) sug.ctl.abort();
  sug.items = [];
  sug.active = -1;
  $('addr-suggest').hidden = true;
  $('address').setAttribute('aria-expanded', 'false');
  $('address').removeAttribute('aria-activedescendant');
}

function renderSuggestions() {
  const list = $('addr-suggest');
  if (!sug.items.length) { closeSuggestions(); return; }
  list.replaceChildren(...sug.items.map((s, i) => {
    const li = document.createElement('li');
    li.id = 'addr-opt-' + i;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(i === sug.active));
    const main = document.createElement('div');
    main.textContent = s.line;
    const sub = document.createElement('div');
    sub.className = 'muted small';
    sub.textContent = s.detail;
    li.append(main, sub);
    // pointerdown + preventDefault keeps focus in the box, so its "change" lookup doesn't race the pick.
    li.addEventListener('pointerdown', (e) => { e.preventDefault(); pickSuggestion(i); });
    return li;
  }));
  list.hidden = false;
  $('address').setAttribute('aria-expanded', 'true');
  if (sug.active >= 0) $('address').setAttribute('aria-activedescendant', 'addr-opt-' + sug.active);
  else $('address').removeAttribute('aria-activedescendant');
}

function pickSuggestion(i) {
  const s = sug.items[i];
  if (!s) return;
  closeSuggestions();
  lastSearched = s.line; // so the Find / blur lookup does not run again for it
  $('address').value = s.line;
  $('addr-results').hidden = true;
  addrMsg('');
  $('address').blur(); // closes the phone keyboard so the map is visible
  setPoint(s.lat, s.lng, null, 'address', s.line);
}

function scheduleSuggestions() {
  clearTimeout(sug.timer);
  const q = $('address').value.trim();
  if (q.length < SUGGEST_MIN) { closeSuggestions(); return; }
  sug.timer = setTimeout(() => loadSuggestions(q), SUGGEST_DELAY_MS);
}

async function loadSuggestions(q) {
  if (sug.ctl) sug.ctl.abort();
  const ctl = new AbortController();
  sug.ctl = ctl;
  const t = setTimeout(() => ctl.abort(), 5000);
  const key = q.toLowerCase() + '|' + (state.point ? state.point.lat.toFixed(2) + ',' + state.point.lng.toFixed(2) : '');
  try {
    let items = sug.cache.get(key);
    if (!items) {
      items = await photon(q, true, ctl.signal);
      if (!items.length) items = await photon(q, false, ctl.signal); // nothing nearby: search everywhere
      sug.cache.set(key, items);
      if (sug.cache.size > 50) sug.cache.delete(sug.cache.keys().next().value);
    }
    // Only show them if the box still holds this text and still has focus.
    if (ctl.signal.aborted || $('address').value.trim() !== q || document.activeElement !== $('address')) return;
    sug.items = items;
    sug.active = -1;
    renderSuggestions();
  } catch {
    // Suggestions are optional; Find still works with the typed text.
  } finally {
    clearTimeout(t);
    if (sug.ctl === ctl) sug.ctl = null;
  }
}

function onAddressKey(e) {
  if ($('addr-suggest').hidden || !sug.items.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = sug.items.length;
    sug.active = e.key === 'ArrowDown' ? (sug.active + 1) % n : (sug.active - 1 + n) % n;
    renderSuggestions();
  } else if (e.key === 'Enter' && sug.active >= 0) {
    e.preventDefault(); // pick the highlighted suggestion instead of submitting the form
    pickSuggestion(sug.active);
  } else if (e.key === 'Escape') {
    closeSuggestions();
  }
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

let mapOpening = false;
async function openMap() {
  if (mapOpening) return;
  mapOpening = true;
  $('map').hidden = false;
  $('map-btn').hidden = true;
  try { await loadLeaflet(); } catch {
    mapOpening = false;
    $('map').hidden = true;
    $('map-btn').hidden = false;
    showBanner("Map couldn't load. Type an address instead.");
    return;
  }
  mapOpening = false;
  if (map) {
    map.invalidateSize();
    if (state.point) { marker.setLatLng([state.point.lat, state.point.lng]); map.setView([state.point.lat, state.point.lng], 18); }
    return;
  }
  const start = state.point ? [state.point.lat, state.point.lng] : DEFAULT_CENTER;
  map = L.map('map', { zoomControl: true, preferCanvas: true }).setView(start, state.point ? 18 : 13);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap',
  }).addTo(map);
  marker = L.marker(start, { draggable: true }).addTo(map);
  const place = (ll) => { marker.setLatLng(ll); setPoint(ll.lat, ll.lng, null, 'map'); };
  marker.on('dragend', () => place(marker.getLatLng()));
  map.on('click', (e) => place(e.latlng));
  $('map-hint').hidden = false;
  // Leaflet sizes its tiles to the container; recompute once it is visible.
  setTimeout(() => map && map.invalidateSize(), 0);
  if (!state.point) setLoc('busy', 'Tap the map where the problem is');
}

// ---------- voice note (MediaRecorder, 30 s max, optional) ----------
let rec = null; // { mr, stream, chunks, t0, tick, cap, done } while recording

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function recError(msg) {
  $('rec-err').textContent = msg || '';
  $('rec-err').hidden = !msg;
}

// Chrome/Firefox record WebM/Opus, Safari records MP4/AAC. The server accepts both.
function pickAudioMime() {
  return ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus']
    .find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

function audioExt(mime) {
  if (/mp4|aac/.test(mime)) return 'm4a';
  if (/ogg/.test(mime)) return 'ogg';
  if (/wav/.test(mime)) return 'wav';
  if (/mpeg|mp3/.test(mime)) return 'mp3';
  return 'webm';
}

function setAudio(a) {
  if (state.audio) URL.revokeObjectURL($('rec-audio').src);
  state.audio = a;
  $('rec-done').hidden = !a;
  $('rec-btn').hidden = !!a;
  if (a) {
    $('rec-audio').src = URL.createObjectURL(a.blob);
    $('rec-len').textContent = `Voice note · ${fmtTime(a.duration_s)}`;
  } else {
    $('rec-audio').removeAttribute('src');
  }
}

async function startRecording() {
  if (rec || state.audio) return;
  recError('');
  $('rec-btn').disabled = true; // the permission prompt is async; ignore taps until it resolves
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    $('rec-btn').disabled = false;
    recError(e.name === 'NotAllowedError' || e.name === 'SecurityError'
      ? 'Microphone is blocked for this site. Allow it in your browser settings, or type a description.'
      : "Couldn't open the microphone. Type a description instead.");
    return;
  }
  let mr;
  try {
    const mime = pickAudioMime();
    mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  } catch {
    stream.getTracks().forEach((t) => t.stop());
    $('rec-btn').disabled = false;
    recError("This browser can't record audio. Type a description instead.");
    return;
  }
  const r = { mr, stream, chunks: [], t0: Date.now() };
  mr.ondataavailable = (e) => { if (e.data && e.data.size) r.chunks.push(e.data); };
  r.done = new Promise((resolve) => { mr.onstop = () => { finishRecording(r); resolve(); }; });
  mr.onerror = () => { recError('Recording failed. Try again.'); stopRecording(); };
  stream.getAudioTracks().forEach((t) => { t.onended = () => stopRecording(); }); // mic taken away (call, unplugged)
  rec = r;
  mr.start();
  r.cap = setTimeout(stopRecording, AUDIO_MAX_S * 1000);
  r.tick = setInterval(() => { $('rec-time').textContent = fmtTime(Math.min(AUDIO_MAX_S, (Date.now() - r.t0) / 1000)); }, 200);
  $('rec-time').textContent = '0:00';
  $('rec-btn').hidden = true;
  $('rec-btn').disabled = false;
  $('rec-live').hidden = false;
}

function stopRecording() {
  if (!rec) return Promise.resolve();
  const r = rec;
  if (r.mr.state !== 'inactive') r.mr.stop();
  return r.done;
}

function finishRecording(r) {
  clearInterval(r.tick);
  clearTimeout(r.cap);
  r.stream.getTracks().forEach((t) => t.stop()); // releases the mic indicator
  if (rec === r) rec = null;
  $('rec-live').hidden = true;
  const seconds = Math.min(AUDIO_MAX_S, (Date.now() - r.t0) / 1000);
  const type = r.mr.mimeType || (r.chunks[0] && r.chunks[0].type) || 'audio/webm';
  const blob = new Blob(r.chunks, { type });
  if (seconds < AUDIO_MIN_S || blob.size < 500) {
    $('rec-btn').hidden = false;
    recError('That was too short. Tap again and speak for a moment.');
    return;
  }
  setAudio({ blob, duration_s: Math.round(seconds * 10) / 10, name: `voice.${audioExt(type)}` });
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
    contact: $('contact').value.trim(),
  };
  if (state.audio) f.audio_duration_s = String(state.audio.duration_s);
  if (state.point) {
    f.lat = String(state.point.lat);
    f.lng = String(state.point.lng);
    if (state.point.accuracy_m != null) f.accuracy_m = String(state.point.accuracy_m);
  }
  return f;
}

class NetworkError extends Error {}

async function postReport(fields, photo, audio) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== '' && v != null) fd.append(k, v);
  fd.append('photo', photo, 'photo.jpg');
  if (audio) fd.append('audio', audio.blob, audio.name);
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

  // A recording still running when Send is tapped is finished first, so it is not lost.
  if (rec) await stopRecording();

  // Tapping Send blurs the address box, which starts a lookup; let it place the pin first.
  if (searching) await searching;
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
    const res = await postReport(fields, state.photo, state.audio);
    showDone(res.id, false);
  } catch (e) {
    if (e instanceof NetworkError) {
      // Same client_report_id is reused on resend, so the server never double-counts.
      if (await enqueue(fields, state.photo, state.audio)) showDone(null, true);
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

async function enqueue(fields, photo, audio) {
  const q = lsGet(QUEUE_KEY, []);
  q.push({
    fields: { ...fields, queued: '1' },
    photo: await blobToDataUrl(photo),
    audio: audio ? { data: await blobToDataUrl(audio.blob), name: audio.name } : null,
  });
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
        const audio = item.audio ? { blob: await (await fetch(item.audio.data)).blob(), name: item.audio.name } : null;
        await postReport(item.fields, blob, audio);
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
  $('track-link').hidden = queued;
  $('track-link').textContent = $('contact').value.trim() ? 'Track its status' : 'See issues near you';
  window.scrollTo(0, 0);
}

function reset() {
  state.photo = null;
  setAudio(null);
  recError('');
  $('preview').hidden = true;
  $('photo-card').classList.remove('has-photo');
  $('description').value = '';
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
$('loc-btn').addEventListener('click', () => locate(true));
$('reload-btn').addEventListener('click', () => location.reload());
$('map-btn').addEventListener('click', openMap);
$('address').addEventListener('input', () => {
  $('addr-results').hidden = true;
  addrMsg('');
  if (!state.point) setLoc($('address').value.trim() ? 'ok' : 'bad', 'Using the address you typed', 'Pick a suggestion or tap Find to show it on the map.');
  scheduleSuggestions();
  refresh();
});
$('address').addEventListener('keydown', onAddressKey);
$('address').addEventListener('blur', () => setTimeout(closeSuggestions, 0));
$('addr-form').addEventListener('submit', (e) => {
  e.preventDefault();
  closeSuggestions();
  $('address').blur(); // closes the phone keyboard so the map is visible
  searchAddress();
});
// Leaving the field after editing it also looks the address up (covers users who never tap Find).
$('address').addEventListener('change', () => searchAddress());
$('rec-btn').addEventListener('click', startRecording);
$('rec-stop').addEventListener('click', stopRecording);
$('rec-delete').addEventListener('click', () => { setAudio(null); recError(''); });
// No mic API (old browser, or plain http): hide the recorder instead of showing a dead button.
if (!window.isSecureContext || !window.MediaRecorder || !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
  $('audio-box').hidden = true;
}
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
