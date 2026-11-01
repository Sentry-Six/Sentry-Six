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
 * Providers:
 *  - 'versatiles' (default): OpenStreetMap vector tiles from the
 *    SentryUSB VersaTiles server (TILE_ORIGIN), drawn by MapLibre GL inside
 *    Leaflet (maplibre-gl-leaflet). Vector tiles stop at z14 and are
 *    overzoomed, so a follow-the-car map needs few requests.
 *  - 'osm': the OpenStreetMap Foundation's standard raster tiles. Also the
 *    raster stand-in for 'versatiles' wherever a bitmap is stitched in the
 *    main process (export static map: a handful of tiles per user-started
 *    export, sent with an identifying User-Agent per the OSMF tile policy).
 *
 * Saved ids from older releases ('google', 'google-satellite') migrate to
 * the default via normalizeProviderId().
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  // ALSO set the global when a `module` object exists: the minimap renderer
  // window runs with nodeIntegration, which injects `module` into the page,
  // so a CJS-only branch would leave window.MapProviders undefined there.
  if (root && typeof root === 'object') {
    root.MapProviders = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  // The SentryUSB self-hosted VersaTiles server: OpenStreetMap vector tiles,
  // styles, glyphs and sprites in the public server's path layout.
  const TILE_ORIGIN = 'https://tiles.sentryusb.com';
  const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  const VERSATILES_LINK = '<a href="https://versatiles.org/">VersaTiles</a>';

  const PROVIDERS = {
    'versatiles': {
      id: 'versatiles',
      label: 'tiles.sentryusb.com (OpenStreetMap)',
      type: 'vector',
      styleUrl: TILE_ORIGIN + '/assets/styles/colorful/style.json',
      darkStyleUrl: TILE_ORIGIN + '/assets/styles/colorful-dark/style.json',
      maxZoom: 20,
      attribution: VERSATILES_LINK + ' | ' + OSM_ATTRIBUTION,
      // Raster provider used where a bitmap must be stitched (export).
      rasterFallbackId: 'osm',
      // Credit drawn on exported minimaps
      exportCredit: '\u00a9 OpenStreetMap'
    },
    'osm': {
      id: 'osm',
      label: 'OpenStreetMap',
      type: 'raster',
      // The OSMF tile policy asks for this single hostname (no a/b/c).
      urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      subdomains: [],
      tileSize: 256,
      maxNativeZoom: 19,
      maxZoom: 19,
      fileExt: 'png',
      attribution: OSM_ATTRIBUTION,
      exportCredit: '© OpenStreetMap'
    }
  };

  const DEFAULT_PROVIDER_ID = 'versatiles';
  // Used when a vector style cannot load (renderer without WebGL, etc.).
  const FALLBACK_PROVIDER_ID = 'osm';

  const LEGACY_PROVIDER_IDS = {
    'google': 'versatiles',
    'google-satellite': 'versatiles'
  };

  // Identifies Sentry Studio to tile servers (Node and Electron renderers
  // otherwise send a generic or browser User-Agent).
  const USER_AGENT = 'Sentry-Studio/1.0 (Tesla Dashcam Viewer; https://sentry-six.com/sentry-studio)';
  const REFERER = 'https://sentry-six.com/';
  // URL filters for webRequest header injection.
  const TILE_REQUEST_URL_PATTERNS = [
    'https://tile.openstreetmap.org/*',
    TILE_ORIGIN + '/*'
  ];

  function normalizeProviderId(id) {
    if (Object.prototype.hasOwnProperty.call(PROVIDERS, id)) return id;
    if (Object.prototype.hasOwnProperty.call(LEGACY_PROVIDER_IDS, id)) return LEGACY_PROVIDER_IDS[id];
    return DEFAULT_PROVIDER_ID;
  }

  function getProvider(id) {
    return PROVIDERS[normalizeProviderId(id)];
  }

  function isVectorProvider(id) {
    return getProvider(id).type === 'vector';
  }

  /**
   * Provider to use where only raster tiles work (stitched export images).
   */
  function getRasterProvider(id) {
    const p = getProvider(id);
    return p.type === 'raster' ? p : PROVIDERS[p.rasterFallbackId || FALLBACK_PROVIDER_ID];
  }

  /**
   * Build a concrete tile URL for direct (non-Leaflet) downloads.
   * Vector providers resolve to their raster fallback.
   * @param {string} id - Provider id
   * @param {number} x - Tile X
   * @param {number} y - Tile Y
   * @param {number} zoom - Zoom level
   * @param {number} requestIndex - Running request counter, used to
   *   round-robin across the provider's subdomains (if any)
   * @returns {string} Tile URL
   */
  function buildTileUrl(id, x, y, zoom, requestIndex) {
    const p = getRasterProvider(id);
    const s = p.subdomains && p.subdomains.length
      ? p.subdomains[(requestIndex || 0) % p.subdomains.length]
      : '';
    return p.urlTemplate
      .replace('{s}', s)
      .replace('{x}', x)
      .replace('{y}', y)
      .replace('{z}', zoom);
  }

  /**
   * Leaflet TileLayer options for a raster provider.
   */
  function leafletRasterOptions(id, maxZoomCap) {
    const p = getRasterProvider(id);
    const cap = typeof maxZoomCap === 'number' ? maxZoomCap : p.maxZoom;
    const opts = {
      maxZoom: Math.min(p.maxZoom, cap),
      maxNativeZoom: p.maxNativeZoom,
      attribution: p.attribution
    };
    if (p.subdomains && p.subdomains.length) opts.subdomains = p.subdomains;
    return opts;
  }

  return {
    PROVIDERS,
    DEFAULT_PROVIDER_ID,
    FALLBACK_PROVIDER_ID,
    LEGACY_PROVIDER_IDS,
    USER_AGENT,
    REFERER,
    TILE_REQUEST_URL_PATTERNS,
    TILE_ORIGIN,
    normalizeProviderId,
    getProvider,
    getRasterProvider,
    isVectorProvider,
    buildTileUrl,
    leafletRasterOptions
  };
});
