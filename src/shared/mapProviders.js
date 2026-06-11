/**
 * Map tile provider registry — the single source of truth for every map in
 * the app: the main viewer map, the Advanced Editor minimap preview, the
 * hidden minimap renderer window, and the export static-map tile downloader.
 *
 * Loaded two ways:
 *  - As a classic <script> in index.html / minimap-renderer.html, where it
 *    exposes `window.MapProviders` (classic scripts run before ES modules,
 *    so module code can rely on the global).
 *  - Via require() in the main process for export tile downloads.
 *
 * The Google entries hit Google's public tile servers directly (the same
 * key-less mt{n}.google.com endpoint Sentry Drive uses) — NOT the Google
 * Maps JS API. That endpoint is unofficial, which is why every consumer
 * falls back to 'osm' at runtime when Google tiles stop loading.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  // ALSO set the global when a `module` object exists: the minimap renderer
  // window runs with nodeIntegration, which injects `module` into the page,
  // so a CJS-only branch would leave window.MapProviders undefined there and
  // every consumer would silently fall back to OSM.
  if (root && typeof root === 'object') {
    root.MapProviders = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const PROVIDERS = {
    'google': {
      id: 'google',
      label: 'Google Maps',
      urlTemplate: 'https://{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
      subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
      maxZoom: 20,
      attribution: '&copy; Google'
    },
    'google-satellite': {
      id: 'google-satellite',
      label: 'Google Satellite',
      urlTemplate: 'https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
      subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
      maxZoom: 20,
      attribution: '&copy; Google'
    },
    'osm': {
      id: 'osm',
      label: 'OpenStreetMap',
      urlTemplate: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      subdomains: ['a', 'b', 'c'],
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }
  };

  const DEFAULT_PROVIDER_ID = 'google';
  const FALLBACK_PROVIDER_ID = 'osm';

  // Known-good tile used to cheaply test whether Google tiles are reachable.
  const GOOGLE_PROBE_URL = 'https://mt1.google.com/vt/lyrs=m&x=0&y=0&z=0';

  function getProvider(id) {
    return PROVIDERS[id] || PROVIDERS[DEFAULT_PROVIDER_ID];
  }

  function isGoogleProvider(id) {
    return getProvider(id).id.indexOf('google') === 0;
  }

  /**
   * Build a concrete tile URL for direct (non-Leaflet) downloads.
   * @param {string} id - Provider id
   * @param {number} x - Tile X
   * @param {number} y - Tile Y
   * @param {number} zoom - Zoom level
   * @param {number} requestIndex - Running request counter, used to
   *   round-robin across the provider's subdomains
   * @returns {string} Tile URL
   */
  function buildTileUrl(id, x, y, zoom, requestIndex) {
    const p = getProvider(id);
    const s = p.subdomains[(requestIndex || 0) % p.subdomains.length];
    return p.urlTemplate
      .replace('{s}', s)
      .replace('{x}', x)
      .replace('{y}', y)
      .replace('{z}', zoom);
  }

  return {
    PROVIDERS,
    DEFAULT_PROVIDER_ID,
    FALLBACK_PROVIDER_ID,
    GOOGLE_PROBE_URL,
    getProvider,
    isGoogleProvider,
    buildTileUrl
  };
});
