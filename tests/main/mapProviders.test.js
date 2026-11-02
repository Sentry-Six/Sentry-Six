// Map tile providers: every map draws from the Sentry Six tile server
// (VersaTiles), and settings saved by releases that offered Google or
// OpenStreetMap tiles migrate to it.

const fs = require('fs');
const path = require('path');
const MapProviders = require('../../src/shared/mapProviders');
const { generateMinimapAss } = require('../../src/assGenerator');

describe('map provider registry', () => {
  test('offers only the Sentry Six tile server', () => {
    const json = JSON.stringify(MapProviders.PROVIDERS);
    expect(json).not.toMatch(/google/i);
    expect(json).not.toMatch(/tile\.openstreetmap\.org/);
    expect(Object.keys(MapProviders.PROVIDERS)).toEqual(['versatiles']);
    expect(MapProviders.TILE_REQUEST_URL_PATTERNS).toEqual(['https://tiles.sentryusb.com/*']);
  });

  test('defaults to the VersaTiles vector style with light and dark variants', () => {
    const p = MapProviders.getProvider(undefined);
    expect(p.id).toBe('versatiles');
    expect(p.type).toBe('vector');
    expect(MapProviders.TILE_ORIGIN).toBe('https://tiles.sentryusb.com');
    expect(p.styleUrl).toBe('https://tiles.sentryusb.com/assets/styles/colorful/style.json');
    expect(p.darkStyleUrl).toBe('https://tiles.sentryusb.com/assets/styles/sentry-dark/style.json');
    expect(p.attribution).toMatch(/VersaTiles.*OpenStreetMap/);
    // The styles also draw land cover, ocean depth and terrain shading.
    expect(p.attribution).toMatch(/ESA WorldCover<\/a>.*CC BY 4\.0.*GEBCO.*Mapzen/);
    // The animated export minimap renders where only OpenStreetMap data is drawn.
    expect(p.exportCredit).toBe('\u00a9 OpenStreetMap');
    // Background colours shown when the style cannot draw.
    expect(p.backgroundColor).toBe('rgb(248, 244, 240)');
    expect(p.darkBackgroundColor).toBe('rgb(20, 28, 33)');
  });

  test('migrates removed provider ids', () => {
    expect(MapProviders.normalizeProviderId('google')).toBe('versatiles');
    expect(MapProviders.normalizeProviderId('google-satellite')).toBe('versatiles');
    expect(MapProviders.normalizeProviderId('osm')).toBe('versatiles');
    expect(MapProviders.normalizeProviderId('nonsense')).toBe('versatiles');
    expect(MapProviders.getProvider('google').id).toBe('versatiles');
    expect(MapProviders.getProvider('osm').id).toBe('versatiles');
  });

  test('a saved OpenStreetMap choice becomes the default', () => {
    expect(MapProviders.SELECTABLE_PROVIDER_IDS).toEqual(['versatiles']);
    expect(MapProviders.normalizeSelectedProviderId('osm')).toBe('versatiles');
    expect(MapProviders.normalizeSelectedProviderId('google-satellite')).toBe('versatiles');
    expect(MapProviders.normalizeSelectedProviderId(undefined)).toBe('versatiles');
    expect(MapProviders.normalizeSelectedProviderId('versatiles')).toBe('versatiles');
  });

  test('static minimap credits follow the relief layers drawn at that zoom', () => {
    // MapLibre zooms: terrain shading below 15, ocean depth below 13,
    // land cover at 10 and below.
    expect(MapProviders.exportCredit('versatiles', 16)).toBe('\u00a9 OpenStreetMap');
    expect(MapProviders.exportCredit('versatiles', 15)).toBe('\u00a9 OpenStreetMap');
    expect(MapProviders.exportCredit('versatiles', 14)).toBe('\u00a9 OpenStreetMap · Mapzen');
    expect(MapProviders.exportCredit('versatiles', 12)).toBe('\u00a9 OpenStreetMap · GEBCO · Mapzen');
    expect(MapProviders.exportCredit('versatiles', 10)).toBe('\u00a9 OpenStreetMap · ESA WorldCover · GEBCO · Mapzen');
    expect(MapProviders.exportCredit('versatiles')).toBe('\u00a9 OpenStreetMap');
    expect(MapProviders.USER_AGENT).toMatch(/^Sentry-Studio\/\S+ \(.*https:\/\/sentry-six\.com/);
  });

  test('no app code loads OpenStreetMap\'s raster tile server', () => {
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'vendor') walk(full);
        } else if (/\.(js|mjs|cjs|html)$/.test(entry.name)) {
          files.push(full);
        }
      }
    };
    walk(path.join(__dirname, '../../src'));
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      expect([file, fs.readFileSync(file, 'utf8').includes('tile.openstreetmap.org')]).toEqual([file, false]);
    }
  });

  test('settings offers no provider picker while only one provider is selectable', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf8');
    expect(MapProviders.SELECTABLE_PROVIDER_IDS).toHaveLength(1);
    expect(html).not.toMatch(/id="settingsMapProvider"/);
  });
});

describe('vector style cache', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve));
  const ok = (url) => Promise.resolve({ ok: true, json: () => Promise.resolve({ url }) });

  test('serves fetched style JSON once it arrives, the URL until then', async () => {
    const { styleUrl, darkStyleUrl } = MapProviders.getProvider('versatiles');
    const requested = [];
    const cache = MapProviders.createStyleCache((url) => {
      requested.push(url);
      return url === darkStyleUrl ? ok(url) : Promise.resolve({ ok: false, status: 503 });
    });
    cache.prefetch([styleUrl, darkStyleUrl]);
    cache.prefetch([darkStyleUrl]);
    expect(cache.get(darkStyleUrl)).toBe(darkStyleUrl);
    await flush();
    expect(cache.get(darkStyleUrl)).toEqual({ url: darkStyleUrl });
    // A failed fetch keeps the URL and is retried by the next prefetch.
    expect(cache.get(styleUrl)).toBe(styleUrl);
    cache.prefetch([styleUrl, darkStyleUrl]);
    await flush();
    expect(requested).toEqual([styleUrl, darkStyleUrl, styleUrl]);
  });

  test('a fetch that throws leaves the URL in place', async () => {
    const cache = MapProviders.createStyleCache(() => { throw new Error('offline'); });
    cache.prefetch(['https://tiles.sentryusb.com/x.json']);
    await flush();
    expect(cache.get('https://tiles.sentryusb.com/x.json')).toBe('https://tiles.sentryusb.com/x.json');
  });
});

describe('exported minimap credit', () => {
  const seiData = [
    { timestampMs: 0, sei: { latitude_deg: 45.5, longitude_deg: -73.6, heading_deg: 0 } },
    { timestampMs: 1000, sei: { latitude_deg: 45.501, longitude_deg: -73.601, heading_deg: 10 } }
  ];
  const mapPath = seiData.map(d => [d.sei.latitude_deg, d.sei.longitude_deg]);
  const bounds = { minLat: 45.49, maxLat: 45.51, minLon: -73.61, maxLon: -73.59 };

  test('draws the tile credit over a map background', () => {
    const ass = generateMinimapAss(seiData, mapPath, 0, 1000, {
      standaloneMode: true, standaloneSize: 400, customBounds: bounds,
      includeBackground: false, attribution: '© OpenStreetMap'
    });
    expect(ass).toContain('Style: MinimapCredit');
    const line = ass.split('\n').find(l => l.includes(',MinimapCredit,'));
    expect(line).toMatch(/\\an3\\pos\(\d+,\d+\)\\fs\d+}© OpenStreetMap$/);
  });

  test('omits the credit when there is no map background', () => {
    const ass = generateMinimapAss(seiData, mapPath, 0, 1000, { standaloneMode: true, standaloneSize: 400 });
    expect(ass.split('\n').some(l => l.includes(',MinimapCredit,'))).toBe(false);
  });
});
