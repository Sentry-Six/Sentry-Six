// Map tile providers: only terms-compliant sources (VersaTiles, the
// OpenStreetMap Foundation's tile server) and migration of settings saved
// by releases that offered Google tiles.

const fs = require('fs');
const path = require('path');
const MapProviders = require('../../src/shared/mapProviders');
const { generateMinimapAss } = require('../../src/assGenerator');

describe('map provider registry', () => {
  test('offers no Google endpoints', () => {
    const json = JSON.stringify(MapProviders.PROVIDERS);
    expect(json).not.toMatch(/google/i);
    expect(Object.keys(MapProviders.PROVIDERS).sort()).toEqual(['osm', 'versatiles']);
  });

  test('defaults to the VersaTiles vector style with light and dark variants', () => {
    const p = MapProviders.getProvider(undefined);
    expect(p.id).toBe('versatiles');
    expect(p.type).toBe('vector');
    expect(MapProviders.TILE_ORIGIN).toBe('https://tiles.sentryusb.com');
    expect(p.styleUrl).toBe('https://tiles.sentryusb.com/assets/styles/colorful/style.json');
    expect(p.darkStyleUrl).toBe('https://tiles.sentryusb.com/assets/styles/sentry-dark/style.json');
    expect(p.attribution).toMatch(/VersaTiles.*OpenStreetMap/);
    expect(p.attribution).not.toMatch(/WorldCover/);
  });

  test('migrates removed provider ids', () => {
    expect(MapProviders.normalizeProviderId('google')).toBe('versatiles');
    expect(MapProviders.normalizeProviderId('google-satellite')).toBe('versatiles');
    expect(MapProviders.normalizeProviderId('osm')).toBe('osm');
    expect(MapProviders.normalizeProviderId('nonsense')).toBe('versatiles');
    expect(MapProviders.getProvider('google').id).toBe('versatiles');
  });

  test('raster downloads use OSM for the vector default, on the single policy hostname', () => {
    expect(MapProviders.getRasterProvider('versatiles').id).toBe('osm');
    expect(MapProviders.buildTileUrl('versatiles', 1, 2, 3, 7)).toBe('https://tile.openstreetmap.org/3/1/2.png');
    expect(MapProviders.buildTileUrl('google', 1, 2, 3)).toBe('https://tile.openstreetmap.org/3/1/2.png');
  });

  test('Leaflet raster options respect zoom caps', () => {
    const osm = MapProviders.leafletRasterOptions('osm', 18);
    expect(osm.maxZoom).toBe(18);
    expect(osm.tileSize).toBeUndefined();
    expect(osm.subdomains).toBeUndefined();
  });

  test('every provider carries attribution and an export credit', () => {
    for (const p of Object.values(MapProviders.PROVIDERS)) {
      expect(p.attribution).toBeTruthy();
      expect(p.exportCredit).toBeTruthy();
    }
    expect(MapProviders.PROVIDERS.osm.attribution).toMatch(/OpenStreetMap/);
    expect(MapProviders.USER_AGENT).toMatch(/^Sentry-Studio\/\S+ \(.*https:\/\/sentry-six\.com/);
  });

  test('settings select lists exactly the registry providers', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf8');
    const select = html.match(/<select id="settingsMapProvider"[\s\S]*?<\/select>/)[0];
    const values = [...select.matchAll(/value="([^"]+)"/g)].map(m => m[1]).sort();
    expect(values).toEqual(Object.keys(MapProviders.PROVIDERS).sort());
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
