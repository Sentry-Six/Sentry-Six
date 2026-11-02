jest.mock('electron');

const { EventEmitter } = require('events');
const { createMinimapRenderer } = require('../../src/main/minimap');

function fakeWindow() {
  const webContents = new EventEmitter();
  webContents.id = 7;
  webContents.session = {
    webRequest: { onBeforeSendHeaders: jest.fn() }
  };
  webContents.send = jest.fn();
  return {
    webContents,
    loadFile: jest.fn(),
    destroy: jest.fn(),
    isDestroyed: jest.fn(() => false)
  };
}

test('missing minimap renderer destroys its partially created window', async () => {
  const win = fakeWindow();

  await expect(createMinimapRenderer(320, 180, {
    createWindow: () => win,
    rendererExists: () => false,
    rendererPath: '/missing.html'
  })).rejects.toThrow('Minimap renderer not found');

  expect(win.destroy).toHaveBeenCalledTimes(1);
});

test('did-fail-load destroys the hidden minimap window', async () => {
  const win = fakeWindow();
  const result = createMinimapRenderer(320, 180, {
    createWindow: () => win,
    rendererExists: () => true,
    rendererPath: '/renderer.html'
  });

  win.webContents.emit('did-fail-load', {}, -1, 'decode failed');

  await expect(result).rejects.toThrow('decode failed');
  expect(win.destroy).toHaveBeenCalledTimes(1);
});

test('renderer load timeout destroys the hidden minimap window', async () => {
  jest.useFakeTimers();
  const win = fakeWindow();
  const result = createMinimapRenderer(320, 180, {
    createWindow: () => win,
    rendererExists: () => true,
    rendererPath: '/renderer.html'
  });

  jest.advanceTimersByTime(15000);

  await expect(result).rejects.toThrow('Minimap renderer load timeout');
  expect(win.destroy).toHaveBeenCalledTimes(1);
  jest.useRealTimers();
});

describe('static minimap background', () => {
  const { ipcMain } = require('electron');
  const { renderStaticMapBackground, staticMapView } = require('../../src/main/minimap');
  const replyHandler = () => ipcMain.on.mock.calls.find(([channel]) => channel === 'minimap:staticRendered')[1];

  // A short drive (about 600 m): fits a 3x3 grid of 256-px tiles at zoom 16.
  const mapPath = [[53.4488, -113.4801], [53.4505, -113.4770], [53.4527, -113.4719]];

  // Web Mercator world pixels at a 256-px tile zoom (Leaflet's convention).
  const project = ([lat, lon], zoom) => {
    const scale = 256 * Math.pow(2, zoom);
    const sin = Math.sin(lat * Math.PI / 180);
    return {
      x: (lon + 180) / 360 * scale,
      y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale
    };
  };

  test('draws the tile grid around the route at the tile zoom', () => {
    const view = staticMapView(mapPath, 634);
    expect(view.zoom).toBe(16);
    expect(view.renderSize).toBe(768);
    expect(view.renderZoom).toBe(16);
    // The square window around the centre holds the whole route.
    const c = project(view.center, view.renderZoom);
    for (const point of mapPath) {
      const p = project(point, view.renderZoom);
      expect(Math.abs(p.x - c.x)).toBeLessThan(view.renderSize / 2);
      expect(Math.abs(p.y - c.y)).toBeLessThan(view.renderSize / 2);
    }
  });

  test('never draws smaller than the export: the zoom shifts to keep the same ground', () => {
    const view = staticMapView(mapPath, 1200);
    expect(view.zoom).toBe(16);
    expect(view.renderSize).toBe(1200);
    expect(view.renderZoom).toBeCloseTo(16 + Math.log2(1200 / 768), 10);
    // Same metres per window either way.
    const metresAcross = (zoom, size) => size / (256 * Math.pow(2, zoom));
    expect(metresAcross(view.renderZoom, 1200)).toBeCloseTo(metresAcross(16, 768), 12);
  });

  test('captures the drawn map once and returns its exact bounds', async () => {
    const win = fakeWindow();
    const png = Buffer.from('png');
    win.webContents.capturePage = jest.fn(async () => ({ toPNG: () => png }));
    const bounds = { minLat: 53.44, maxLat: 53.46, minLon: -113.49, maxLon: -113.46 };
    win.webContents.send = jest.fn((channel, view) => {
      expect(channel).toBe('minimap:renderStatic');
      expect(view).toEqual({ center: expect.any(Array), zoom: 16, dark: true, providerId: 'versatiles' });
      replyHandler()({ sender: { id: win.webContents.id } }, { ok: true, bounds, zoom: 16 });
    });
    const writeFile = jest.fn(async () => {});
    const createRenderer = jest.fn(async () => win);

    const result = await renderStaticMapBackground('e1', mapPath, 634, true, 'versatiles', null, { createRenderer, writeFile });

    expect(createRenderer).toHaveBeenCalledWith(768, 768);
    expect(win.webContents.capturePage).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenCalledWith(result.imagePath, png);
    expect(result).toMatchObject({ bounds, zoom: 16, attribution: '© OpenStreetMap' });
    expect(win.destroy).toHaveBeenCalledTimes(1);
  });

  test('a map that cannot draw rejects (the export uses its dark panel) and closes the window', async () => {
    const win = fakeWindow();
    win.webContents.capturePage = jest.fn();
    win.webContents.send = jest.fn(() => {
      replyHandler()({ sender: { id: win.webContents.id } }, { ok: false, error: 'style failed to load' });
    });

    await expect(renderStaticMapBackground('e2', mapPath, 634, false, 'versatiles', null, {
      createRenderer: async () => win, writeFile: jest.fn()
    })).rejects.toThrow('style failed to load');
    expect(win.webContents.capturePage).not.toHaveBeenCalled();
    expect(win.destroy).toHaveBeenCalledTimes(1);
  });

  test('a renderer that never answers times out and closes the window', async () => {
    const win = fakeWindow();
    await expect(renderStaticMapBackground('e3', mapPath, 634, false, 'versatiles', null, {
      createRenderer: async () => win, writeFile: jest.fn(), timeoutMs: 20
    })).rejects.toThrow('Static map render timeout');
    expect(win.destroy).toHaveBeenCalledTimes(1);
  });
});
