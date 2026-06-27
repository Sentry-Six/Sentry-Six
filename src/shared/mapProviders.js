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
      // Styled via Google's legacy apistyle param (see googleApistyle): a
      // curated label set (administrative + roads, no POI) and an optional
      // night palette for dark mode — matching Sentry Drive. Providers with no
      // apistyle builder (OSM raster, satellite imagery) render unstyled.
      apistyle: googleApistyle,
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

  // Settings key + default for the map-labels toggle (Settings → Playback &
  // Overlays → Map → "Map Labels"). Default true matches Sentry Drive's
  // curated labeled map; turning it off appends an all-labels-off apistyle.
  const LABELS_SETTING_KEY = 'mapLabels';
  const DEFAULT_LABELS_ENABLED = true;

  // ─── Google apistyle (matches Sentry Drive) ───────────────────────────────
  // Encoding: ':' → %3A, '|' → %7C, '#' → %23. Assembled by googleApistyle().
  //
  // Labels are curated, not all-or-nothing: every label is turned off, then
  // only administrative (s.t:1 — city/neighborhood names) and road + highway
  // (s.t:3 / s.t:49 — street names & shields) labels are turned back on, so
  // POI/business labels stay hidden.
  const G_LABELS_OFF = 's.e%3Al%7Cp.v%3Aoff';
  const G_CURATED_LABELS = [
    's.t%3A1%7Cs.e%3Al%7Cp.v%3Aon',
    's.t%3A3%7Cs.e%3Al%7Cp.v%3Aon',
    's.t%3A49%7Cs.e%3Al%7Cp.v%3Aon'
  ];
  // Google's own night palette (colors verified pixel-by-pixel by Sentry
  // Drive): #242f3e base, #17263c water, #38414e roads, #5f6b7c highways,
  // #263c3f parks, #2b3645 buildings, #2f3948 transit; label text white with a
  // dark halo. Applied only in dark mode and only to the roadmap provider.
  const G_NIGHT = 's.e%3Ag%7Cp.c%3A%23242f3e,s.e%3Al.t.f%7Cp.c%3A%23ffffff,s.e%3Al.t.s%7Cp.c%3A%23242f3e,s.t%3A37%7Cs.e%3Ag%7Cp.c%3A%23263c3f,s.t%3A81%7Cs.e%3Ag%7Cp.c%3A%232b3645,s.t%3A6%7Cs.e%3Ag%7Cp.c%3A%2317263c,s.t%3A3%7Cs.e%3Ag%7Cp.c%3A%2338414e,s.t%3A3%7Cs.e%3Ag.s%7Cp.c%3A%23212a37,s.t%3A49%7Cs.e%3Ag%7Cp.c%3A%235f6b7c,s.t%3A49%7Cs.e%3Ag.f%7Cp.c%3A%235f6b7c,s.t%3A49%7Cs.e%3Ag.s%7Cp.c%3A%232a3340,s.t%3A4%7Cs.e%3Ag%7Cp.c%3A%232f3948';

  /**
   * Build the Google apistyle value for the given label/dark options.
   * @param {{labels?: boolean, dark?: boolean}} [opts]
   * @returns {string} apistyle value (rules joined by commas)
   */
  function googleApistyle(opts) {
    const labels = (opts && opts.labels !== undefined) ? opts.labels : DEFAULT_LABELS_ENABLED;
    const dark = !!(opts && opts.dark);
    const rules = [];
    if (dark) rules.push(G_NIGHT);
    rules.push(G_LABELS_OFF);
    if (labels) rules.push.apply(rules, G_CURATED_LABELS);
    return rules.join(',');
  }

  // Known-good tile used to cheaply test whether Google tiles are reachable.
  const GOOGLE_PROBE_URL = 'https://mt1.google.com/vt/lyrs=m&x=0&y=0&z=0';

  function getProvider(id) {
    return PROVIDERS[id] || PROVIDERS[DEFAULT_PROVIDER_ID];
  }

  function isGoogleProvider(id) {
    return getProvider(id).id.indexOf('google') === 0;
  }

  /**
   * Whether the provider renders its own dark style in-tile (via apistyle).
   * When true, callers must NOT layer a CSS/FFmpeg invert filter on top — the
   * night palette is already baked in. When false (OSM, satellite), the
   * caller's invert filter is the only way to get a dark map.
   * @param {string} id - Provider id
   * @returns {boolean}
   */
  function hasNativeDark(id) {
    return typeof getProvider(id).apistyle === 'function';
  }

  /**
   * Resolve a provider's tile URL template, applying its apistyle (curated
   * labels + optional night palette) when it has one. Used both for Leaflet
   * layers (placeholders kept) and as the base for buildTileUrl().
   * @param {string} id - Provider id
   * @param {{labels?: boolean, dark?: boolean}} [opts]
   * @returns {string} URL template with {s}/{x}/{y}/{z} placeholders
   */
  function getUrlTemplate(id, opts) {
    const p = getProvider(id);
    if (typeof p.apistyle === 'function') {
      const style = p.apistyle(opts);
      return style ? p.urlTemplate + '&apistyle=' + style : p.urlTemplate;
    }
    return p.urlTemplate;
  }

  /**
   * Build a concrete tile URL for direct (non-Leaflet) downloads.
   * @param {string} id - Provider id
   * @param {number} x - Tile X
   * @param {number} y - Tile Y
   * @param {number} zoom - Zoom level
   * @param {number} requestIndex - Running request counter, used to
   *   round-robin across the provider's subdomains
   * @param {{labels?: boolean}} [opts] - labels visible? (defaults to DEFAULT_LABELS_ENABLED)
   * @returns {string} Tile URL
   */
  function buildTileUrl(id, x, y, zoom, requestIndex, opts) {
    const p = getProvider(id);
    const s = p.subdomains[(requestIndex || 0) % p.subdomains.length];
    return getUrlTemplate(id, opts)
      .replace('{s}', s)
      .replace('{x}', x)
      .replace('{y}', y)
      .replace('{z}', zoom);
  }

  return {
    PROVIDERS,
    DEFAULT_PROVIDER_ID,
    FALLBACK_PROVIDER_ID,
    LABELS_SETTING_KEY,
    DEFAULT_LABELS_ENABLED,
    GOOGLE_PROBE_URL,
    getProvider,
    isGoogleProvider,
    hasNativeDark,
    getUrlTemplate,
    buildTileUrl
  };
});
