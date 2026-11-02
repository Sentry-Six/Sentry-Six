/**
 * Map tile provider registry — the single source of truth for every map in
 * the app: the main viewer map, the Advanced Editor minimap preview, and the
 * hidden minimap renderer window that draws exported minimaps.
 *
 * Loaded two ways:
 *  - As a classic <script> in index.html / minimap-renderer.html, where it
 *    exposes `window.MapProviders` (classic scripts run before ES modules,
 *    so module code can rely on the global).
 *  - Via require() in the main process (export credits, request headers).
 *
 * Provider:
 *  - 'versatiles': OpenStreetMap vector tiles from the SentryUSB VersaTiles
 *    server (TILE_ORIGIN), drawn by MapLibre GL inside Leaflet
 *    (maplibre-gl-leaflet). Vector tiles stop at z14 and are overzoomed, so
 *    a follow-the-car map needs few requests. Every map, including exported
 *    static minimaps, draws from this server.
 *
 * Saved choices from older releases ('google', 'google-satellite', 'osm')
 * migrate to the default via normalizeSelectedProviderId().
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
  // The VersaTiles styles also draw ESA WorldCover land cover (CC BY 4.0) at
  // z0-10, GEBCO ocean depth up to z13 and Mapzen terrain shading up to z15
  // (MapLibre zooms). The animated export minimap renders at z16, where only
  // OpenStreetMap data remains; see exportCredit() for static minimaps.
  const RELIEF_ATTRIBUTION = '&copy; <a href="https://esa-worldcover.org/en/data-access">ESA WorldCover</a>'
    + ' (<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>)'
    + ' · <a href="https://www.gebco.net/">GEBCO</a>'
    + ' · <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">Mapzen</a>';

  const PROVIDERS = {
    'versatiles': {
      id: 'versatiles',
      label: 'tiles.sentryusb.com (OpenStreetMap)',
      type: 'vector',
      styleUrl: TILE_ORIGIN + '/assets/styles/colorful/style.json',
      darkStyleUrl: TILE_ORIGIN + '/assets/styles/sentry-dark/style.json',
      maxZoom: 20,
      attribution: VERSATILES_LINK + ' | ' + OSM_ATTRIBUTION + ' · ' + RELIEF_ATTRIBUTION,
      // The styles' background colours: what a map shows when the style
      // cannot draw (tile server outage, no WebGL), with routes on top.
      backgroundColor: 'rgb(248, 244, 240)',
      darkBackgroundColor: 'rgb(20, 28, 33)',
      // Credit drawn on exported minimaps at z15 and above
      exportCredit: '\u00a9 OpenStreetMap'
    }
  };

  const DEFAULT_PROVIDER_ID = 'versatiles';

  const LEGACY_PROVIDER_IDS = {
    'google': 'versatiles',
    'google-satellite': 'versatiles',
    'osm': 'versatiles'
  };

  // Providers a user can pick.
  const SELECTABLE_PROVIDER_IDS = ['versatiles'];

  // Identifies Sentry Studio to the tile server (Electron renderers
  // otherwise send a generic browser User-Agent).
  const USER_AGENT = 'Sentry-Studio/1.0 (Tesla Dashcam Viewer; https://sentry-six.com/sentry-studio)';
  // URL filters for webRequest header injection.
  const TILE_REQUEST_URL_PATTERNS = [
    TILE_ORIGIN + '/*'
  ];

  function normalizeProviderId(id) {
    if (Object.prototype.hasOwnProperty.call(PROVIDERS, id)) return id;
    if (Object.prototype.hasOwnProperty.call(LEGACY_PROVIDER_IDS, id)) return LEGACY_PROVIDER_IDS[id];
    return DEFAULT_PROVIDER_ID;
  }

  // A saved Settings choice: anything not selectable becomes the default.
  function normalizeSelectedProviderId(id) {
    const normalized = normalizeProviderId(id);
    return SELECTABLE_PROVIDER_IDS.includes(normalized) ? normalized : DEFAULT_PROVIDER_ID;
  }

  function getProvider(id) {
    return PROVIDERS[normalizeProviderId(id)];
  }

  function isVectorProvider(id) {
    return getProvider(id).type === 'vector';
  }

  /**
   * Credit for an exported static minimap drawn at the given MapLibre zoom.
   * The relief layers fade out as the map zooms in (see RELIEF_ATTRIBUTION),
   * so a close-up map credits only OpenStreetMap.
   */
  function exportCredit(id, mapLibreZoom) {
    const parts = [getProvider(id).exportCredit];
    const z = typeof mapLibreZoom === 'number' ? mapLibreZoom : Infinity;
    if (z < 11) parts.push('ESA WorldCover');
    if (z < 13) parts.push('GEBCO');
    if (z < 15) parts.push('Mapzen');
    return parts.join(' · ');
  }

  /**
   * Vector style JSON fetched once per URL, so a light/dark switch needs no
   * network round trip. The map server's styles differ only in paint values,
   * so MapLibre applies the switch as a diff and repaints without reloading
   * tiles. get() returns the URL until the JSON has arrived, or after a
   * failed fetch (which the next prefetch() retries).
   */
  function createStyleCache(fetchImpl) {
    const styles = new Map();
    return {
      prefetch(urls) {
        for (const url of urls) {
          if (!url || styles.has(url)) continue;
          const entry = { json: null };
          styles.set(url, entry);
          Promise.resolve()
            .then(() => fetchImpl(url))
            .then((res) => {
              if (!res.ok) throw new Error('HTTP ' + res.status);
              return res.json();
            })
            .then((json) => { entry.json = json; })
            .catch(() => { styles.delete(url); });
        }
      },
      get(url) {
        const entry = styles.get(url);
        return (entry && entry.json) || url;
      }
    };
  }

  return {
    PROVIDERS,
    DEFAULT_PROVIDER_ID,
    LEGACY_PROVIDER_IDS,
    SELECTABLE_PROVIDER_IDS,
    USER_AGENT,
    TILE_REQUEST_URL_PATTERNS,
    TILE_ORIGIN,
    normalizeProviderId,
    normalizeSelectedProviderId,
    getProvider,
    isVectorProvider,
    exportCredit,
    createStyleCache
  };
});
