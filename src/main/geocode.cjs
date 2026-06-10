// Reverse geocoding for drive-list location pins.
//
// Runs in the MAIN process (Node https), which lets us:
//   • set a proper User-Agent (Nominatim's usage policy requires one),
//   • throttle to ≤1 request/second (the policy's hard limit),
//   • persist a disk cache so we geocode each unique spot only once, and
//   • sidestep the renderer CSP entirely.
//
// Coordinates are rounded to ~1 m for the cache key: drives that end at the
// same spot still collapse to one lookup, but two genuinely different
// doorsteps a few metres apart no longer share a cached (wrong) address —
// the old 4-decimal key (~11 m) was wide enough to merge adjacent houses.
// Bumping the precision orphans old 4-decimal cache entries (harmless; they
// just re-resolve once at the new precision).

const https = require('https');
const fs = require('fs');

const HOST = 'nominatim.openstreetmap.org';
const RATE_MS = 1100;          // ≤ 1 req/s per Nominatim policy (+ margin)
const KEY_DECIMALS = 5;        // ~1.1 m grouping — house-level distinct
const UA = 'Sentry-Studio/1.0 (https://sentry-six.com)';

let cache = null;              // { "lat,lng": label|null }
let cacheFile = null;
let lastFetchMs = 0;
let saveTimer = null;
const inflight = new Map();    // key -> Promise<label|null>

function init(filePath) {
  cacheFile = filePath;
  try { cache = JSON.parse(fs.readFileSync(filePath, 'utf8')) || {}; }
  catch { cache = {}; }
}

function keyFor(lat, lng) {
  return `${lat.toFixed(KEY_DECIMALS)},${lng.toFixed(KEY_DECIMALS)}`;
}

function scheduleSave() {
  if (saveTimer || !cacheFile) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.writeFileSync(cacheFile, JSON.stringify(cache)); } catch {}
  }, 2000);
}

// Pick the most "pin-like" short label from a Nominatim reverse result.
function shortLabel(j) {
  if (!j) return null;
  const a = j.address || {};
  if (j.name && j.name.trim()) return j.name.trim();              // POI/business name
  const road = a.road || a.pedestrian || a.footway || a.path || a.cycleway;
  if (road && a.house_number) return `${a.house_number} ${road}`; // "6730 Aviation Dr"
  if (road) return road;
  const place = a.neighbourhood || a.suburb || a.hamlet || a.village
    || a.town || a.city || a.municipality || a.county;
  if (place) return place;
  if (j.display_name) return j.display_name.split(',')[0].trim();
  return null;
}

// Resolves { ok: true, label } when Nominatim answered (label may be null —
// genuinely nothing at that spot), or { ok: false } on network error /
// timeout / non-2xx so the caller knows not to cache the miss.
function requestNominatim(lat, lng) {
  return new Promise((resolve) => {
    const path = `/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;
    const req = https.get(
      { host: HOST, path, headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: 12000 },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve({ ok: true, label: shortLabel(JSON.parse(data)) }); }
            catch { resolve({ ok: false }); }
          } else {
            resolve({ ok: false });
          }
        });
      },
    );
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
  });
}

// Serial queue. The drive list bursts all its lookups at once when it
// renders, so each fetch chains on the previous one with RATE_MS spacing —
// per-call delays computed against a shared timestamp would let the whole
// burst fire simultaneously and trip Nominatim's rate ban.
let queueTail = Promise.resolve();
function fetchNominatim(lat, lng) {
  const run = queueTail.then(async () => {
    const wait = RATE_MS - (Date.now() - lastFetchMs);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastFetchMs = Date.now();
    return requestNominatim(lat, lng);
  });
  queueTail = run.catch(() => {});
  return run;
}

// Returns a place label (string) or null. Answered lookups are cached
// (including "nothing here" nulls) and concurrent lookups for the same spot
// are coalesced; failures are not cached so they retry on a later call.
async function reverseGeocode(lat, lng) {
  if (!cache) cache = {};
  if (typeof lat !== 'number' || typeof lng !== 'number' || !isFinite(lat) || !isFinite(lng)) return null;
  const key = keyFor(lat, lng);
  if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];
  if (inflight.has(key)) return inflight.get(key);

  const p = fetchNominatim(lat, lng).then((res) => {
    inflight.delete(key);
    if (!res.ok) return null;
    cache[key] = res.label;
    scheduleSave();
    return res.label;
  });
  inflight.set(key, p);
  return p;
}

module.exports = { init, reverseGeocode };
