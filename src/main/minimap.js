const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const MapProviders = require('../shared/mapProviders');

// Identify Sentry Studio to the tile server.
function installTileRequestHeaders(session) {
  session.webRequest.onBeforeSendHeaders(
    { urls: MapProviders.TILE_REQUEST_URL_PATTERNS },
    (details, callback) => {
      details.requestHeaders['User-Agent'] = MapProviders.USER_AGENT;
      callback({ requestHeaders: details.requestHeaders });
    }
  );
}

// Calculate minimap size based on output resolution (square aspect ratio)
function calculateMinimapSize(outputWidth, outputHeight, sizeOption = 'medium') {
  const sizeMultipliers = {
    'small': 0.25,
    'medium': 0.35,
    'large': 0.45,
    'xlarge': 0.55
  };
  const multiplier = sizeMultipliers[sizeOption] || 0.25;
  
  // Use the smaller dimension to calculate size (square minimap)
  const baseSize = Math.min(outputWidth, outputHeight);
  const targetSize = Math.round(baseSize * multiplier);
  // Ensure even dimensions (round down, consistent with FFmpeg encoding requirements)
  const evenSize = Math.floor(targetSize / 2) * 2 || 2;
  
  return {
    width: evenSize,
    height: evenSize
  };
}

// ============================================
// STATIC MAP BACKGROUND FOR THE ASS MINIMAP
// The hidden MapLibre minimap window draws the whole route area once and the
// page is captured as the minimap background; writeMinimapAss then draws the
// route and car over it using the returned geographic bounds.
// ============================================

/**
 * Convert lat/lon to tile coordinates at a given zoom level
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude  
 * @param {number} zoom - Zoom level (0-19)
 * @returns {{x: number, y: number}} Tile coordinates
 */
function latLonToTile(lat, lon, zoom) {
  const n = Math.pow(2, zoom);
  const x = Math.floor((lon + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}

/**
 * Calculate optimal zoom level for GPS bounds to fit in target size.
 * Zoom levels count 256-px tiles (Leaflet's convention).
 * @param {Object} bounds - GPS bounds {minLat, maxLat, minLon, maxLon}
 * @param {number} targetSize - Target image size in pixels
 * @returns {number} Optimal zoom level
 */
function calculateOptimalZoom(bounds, targetSize) {
  const { minLat, maxLat, minLon, maxLon } = bounds;
  
  // Preferred: highest zoom where the route fits in ~2-4 tiles (good detail)
  for (let zoom = 18; zoom >= 10; zoom--) {
    const topLeft = latLonToTile(maxLat, minLon, zoom);
    const bottomRight = latLonToTile(minLat, maxLon, zoom);

    const tilesX = bottomRight.x - topLeft.x + 1;
    const tilesY = bottomRight.y - topLeft.y + 1;

    // We want 2-4 tiles in each dimension for good detail
    if (tilesX <= 4 && tilesY <= 4 && tilesX >= 1 && tilesY >= 1) {
      return zoom;
    }
  }

  // Long multi-city drive: nothing from zoom 10-18 fits in 4 tiles. Keep zooming
  // out and take the highest zoom whose grid stays within MAX_TILES_PER_AXIS, so
  // the drawn area stays within MAX_STATIC_RENDER_PX. (A fixed zoom 14 here once
  // made a 6-7h drive need a 182x72 = 13,104-tile grid.)
  const MAX_TILES_PER_AXIS = 8;
  for (let zoom = 9; zoom >= 1; zoom--) {
    const topLeft = latLonToTile(maxLat, minLon, zoom);
    const bottomRight = latLonToTile(minLat, maxLon, zoom);

    const tilesX = bottomRight.x - topLeft.x + 1;
    const tilesY = bottomRight.y - topLeft.y + 1;

    if (tilesX <= MAX_TILES_PER_AXIS && tilesY <= MAX_TILES_PER_AXIS) {
      return zoom;
    }
  }

  return 1; // Whole-world view (at most 2x2 tiles) — never explodes
}

// Largest window the static background is drawn in. calculateOptimalZoom
// keeps the route within 8 tiles per axis (2048 px at 256 px per tile).
const MAX_STATIC_RENDER_PX = 2048;
const STATIC_RENDER_TIMEOUT_MS = 45000;

/**
 * Work out what the static minimap background shows: the route's bounds
 * plus 15% padding, at the 256-px tile zoom calculateOptimalZoom picks, in a
 * square window that holds the tile grid around the route.
 * @param {Array} mapPath - Array of [lat, lon] GPS coordinates
 * @param {number} targetSize - Minimap size in the export, in pixels
 * @returns {{center: number[], zoom: number, renderZoom: number, renderSize: number}}
 *   zoom is the tile zoom (also scales the route line); renderZoom and
 *   renderSize are the Leaflet zoom and window size actually drawn. When the
 *   grid is smaller than the export (or larger than MAX_STATIC_RENDER_PX) the
 *   window is resized and the zoom shifted by log2 of the ratio, so the
 *   ground covered stays the same and the image is never upscaled.
 */
function staticMapView(mapPath, targetSize) {
  let minLat = Infinity, maxLat = -Infinity;
  let minLon = Infinity, maxLon = -Infinity;

  for (const [lat, lon] of mapPath) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }

  // Add 15% padding
  const latRange = maxLat - minLat || 0.001;
  const lonRange = maxLon - minLon || 0.001;
  const latPad = latRange * 0.15;
  const lonPad = lonRange * 0.15;

  const bounds = {
    minLat: minLat - latPad,
    maxLat: maxLat + latPad,
    minLon: minLon - lonPad,
    maxLon: maxLon + lonPad
  };

  const zoom = calculateOptimalZoom(bounds, targetSize);
  const topLeftTile = latLonToTile(bounds.maxLat, bounds.minLon, zoom);
  const bottomRightTile = latLonToTile(bounds.minLat, bounds.maxLon, zoom);
  const tilesX = bottomRightTile.x - topLeftTile.x + 1;
  const tilesY = bottomRightTile.y - topLeftTile.y + 1;
  // A square of whole tiles at this zoom always holds the padded route.
  const gridSize = Math.max(tilesX, tilesY) * 256;
  const renderSize = Math.min(MAX_STATIC_RENDER_PX, Math.max(gridSize, Math.round(targetSize) || 0));
  const renderZoom = zoom + Math.log2(renderSize / gridSize);

  // Centre on the middle of the padded route in Web Mercator, so the route
  // sits in the middle of the image.
  const mercY = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
  const centerY = (mercY(bounds.minLat) + mercY(bounds.maxLat)) / 2;
  const centerLat = (2 * Math.atan(Math.exp(centerY)) - Math.PI / 2) * 180 / Math.PI;
  const centerLon = (bounds.minLon + bounds.maxLon) / 2;

  return { center: [centerLat, centerLon], zoom, renderZoom, renderSize };
}

// Static background results from minimap renderer windows, by webContents id.
const staticRenderCallbacks = new Map();

ipcMain.on('minimap:staticRendered', (event, result) => {
  const callback = staticRenderCallbacks.get(event.sender.id);
  if (callback) {
    staticRenderCallbacks.delete(event.sender.id);
    callback(result);
  }
});

/**
 * Ask a minimap renderer window to draw a static view and wait until
 * MapLibre reports it idle (style and every visible tile drawn).
 * @returns {Promise<{bounds: Object, zoom: number}>}
 */
function requestStaticRender(minimapWindow, view, timeoutMs = STATIC_RENDER_TIMEOUT_MS) {
  const id = minimapWindow.webContents.id;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      staticRenderCallbacks.delete(id);
      reject(new Error('Static map render timeout'));
    }, timeoutMs);
    staticRenderCallbacks.set(id, (result) => {
      clearTimeout(timeout);
      if (result && result.ok && result.bounds) resolve(result);
      else reject(new Error(`Static map render failed: ${(result && result.error) || 'unknown error'}`));
    });
    minimapWindow.webContents.send('minimap:renderStatic', view);
  });
}

/**
 * Draw the static minimap background with the hidden MapLibre minimap
 * window (tiles from tiles.sentryusb.com; the dark style for dark mode) and
 * capture it once as a PNG.
 * @param {string} exportId - Export ID for temp file naming
 * @param {Array} mapPath - Array of [lat, lon] GPS coordinates
 * @param {number} targetSize - Minimap size in the export, in pixels (square)
 * @param {boolean} darkMode - Draw the dark map style
 * @param {string} providerId - Map provider id (see src/shared/mapProviders.js)
 * @param {function} [onProgress] - Receives {phase} as the render starts
 * @param {Object} [overrides] - Test hooks: createRenderer, writeFile, timeoutMs
 * @returns {Promise<{imagePath: string, bounds: Object, zoom: number, attribution: string}>}
 */
async function renderStaticMapBackground(exportId, mapPath, targetSize, darkMode = true, providerId = MapProviders.DEFAULT_PROVIDER_ID, onProgress = null, overrides = {}) {
  if (!mapPath || mapPath.length === 0) {
    throw new Error('No GPS data for map background');
  }

  const view = staticMapView(mapPath, targetSize);
  console.log(`[MAP] Static map: zoom ${view.zoom} (drawn at ${view.renderZoom.toFixed(2)}), ${view.renderSize}px`);
  if (typeof onProgress === 'function') onProgress({ phase: 'render' });

  const createRenderer = overrides.createRenderer || createMinimapRenderer;
  const writeFile = overrides.writeFile || fs.promises.writeFile;
  const minimapWindow = await createRenderer(view.renderSize, view.renderSize);
  try {
    const result = await requestStaticRender(minimapWindow, {
      center: view.center,
      zoom: view.renderZoom,
      dark: !!darkMode,
      providerId
    }, overrides.timeoutMs);

    const image = await minimapWindow.webContents.capturePage();
    const outputPath = path.join(os.tmpdir(), `map_bg_${exportId}_${Date.now()}.png`);
    await writeFile(outputPath, image.toPNG());
    console.log(`[MAP] Created map background: ${outputPath}`);

    return {
      imagePath: outputPath,
      // The exact area drawn, so writeMinimapAss lines the route up with it
      bounds: result.bounds,
      zoom: view.zoom,
      // Short on-video credit; MapLibre draws at the Leaflet zoom - 1
      attribution: MapProviders.exportCredit(providerId, result.zoom - 1)
    };
  } finally {
    staticRenderCallbacks.delete(minimapWindow.webContents?.id);
    destroyWindow(minimapWindow);
  }
}

// Minimap renderer callbacks (for async frame capture)
const minimapReadyCallbacks = new Map();

// IPC handler for minimap ready signals
ipcMain.on('minimap:ready', (event) => {
  const webContentsId = event.sender.id;
  const callback = minimapReadyCallbacks.get(webContentsId);
  if (callback) {
    minimapReadyCallbacks.delete(webContentsId);
    callback();
  }
});

function destroyWindow(window) {
  if (!window) return;
  try {
    if (!window.isDestroyed?.()) window.destroy();
  } catch {}
}

// Create a hidden BrowserWindow for minimap rendering
async function createMinimapRenderer(minimapWidth, minimapHeight, overrides = {}) {
  return new Promise((resolve, reject) => {
    const createWindow = overrides.createWindow || (options => new BrowserWindow(options));
    const rendererPath = overrides.rendererPath ||
      path.join(__dirname, '..', 'renderer', 'minimap-renderer.html');
    const rendererExists = overrides.rendererExists || fs.existsSync;
    let minimapWindow;
    let timeout = null;
    let readyDelay = null;
    let settled = false;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (readyDelay) clearTimeout(readyDelay);
      timeout = null;
      readyDelay = null;
      const webContents = minimapWindow?.webContents;
      if (webContents) {
        webContents.removeListener?.('did-fail-load', onFailLoad);
        webContents.removeListener?.('did-finish-load', onFinishLoad);
        minimapReadyCallbacks.delete(webContents.id);
      }
    };

    const fail = error => {
      if (settled) return;
      settled = true;
      cleanup();
      destroyWindow(minimapWindow);
      reject(error);
    };

    const succeed = () => {
      if (settled) return;
      if (minimapWindow?.isDestroyed?.()) {
        fail(new Error('Minimap renderer closed before it became ready'));
        return;
      }
      settled = true;
      cleanup();
      resolve(minimapWindow);
    };

    const onFailLoad = (_event, _errorCode, errorDescription) => {
      console.error(`[MINIMAP] Renderer failed to load: ${errorDescription}`);
      fail(new Error(`Minimap renderer failed to load: ${errorDescription}`));
    };

    const onFinishLoad = () => {
      if (settled) return;
      if (timeout) clearTimeout(timeout);
      timeout = null;
      console.log('[MINIMAP] Renderer loaded successfully');
      readyDelay = setTimeout(succeed, 500);
    };

    try {
    // Security note: nodeIntegration + contextIsolation:false is acceptable here because
    // this is a hidden offscreen window that only loads local minimap-renderer.html.
    // No remote content is ever loaded into this window.
    minimapWindow = createWindow({
      width: minimapWidth,
      height: minimapHeight,
      show: false,
      frame: false,
      transparent: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        offscreen: true,
        // The renderer signals each frame via requestAnimationFrame; hidden
        // windows get their rAF/timers throttled (or suspended) by Chromium
        // on some machines, which stalls past the per-frame timeout and kills
        // the whole minimap pre-render ("Minimap render timeout").
        backgroundThrottling: false
      }
    });
    
    // Identify Sentry Studio on tile requests (same as main window)
    installTileRequestHeaders(minimapWindow.webContents.session);

    timeout = setTimeout(() => {
      console.error('[MINIMAP] Renderer load timeout');
      fail(new Error('Minimap renderer load timeout'));
    }, 15000);
    
    minimapWindow.webContents.once('did-fail-load', onFailLoad);
    
    minimapWindow.webContents.once('did-finish-load', onFinishLoad);
    
    // Load minimap renderer HTML
    console.log(`[MINIMAP] Loading renderer from: ${rendererPath}`);
    
    if (!rendererExists(rendererPath)) {
      fail(new Error(`Minimap renderer not found at: ${rendererPath}`));
      return;
    }
    
    Promise.resolve(minimapWindow.loadFile(rendererPath)).catch(fail);
    } catch (error) {
      fail(error);
    }
  });
}

// Render a single minimap frame and capture it
async function renderMinimapFrame(minimapWindow, lat, lon, heading, width, height) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      minimapReadyCallbacks.delete(minimapWindow.webContents.id);
      reject(new Error('Minimap render timeout'));
    }, 5000);
    
    minimapReadyCallbacks.set(minimapWindow.webContents.id, async () => {
      clearTimeout(timeout);
      try {
        const image = await minimapWindow.webContents.capturePage();
        const pngBuffer = image.toPNG();
        resolve(pngBuffer);
      } catch (err) {
        reject(err);
      }
    });
    
    minimapWindow.webContents.send('minimap:update', lat, lon, heading);
  });
}

// Render minimap frame by timestamp (uses client-side interpolation)
async function renderMinimapFrameByTime(minimapWindow, timestampMs, width, height) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      minimapReadyCallbacks.delete(minimapWindow.webContents.id);
      reject(new Error('Minimap render timeout'));
    }, 3000); // Shorter timeout since we're just moving marker
    
    minimapReadyCallbacks.set(minimapWindow.webContents.id, async () => {
      clearTimeout(timeout);
      try {
        const image = await minimapWindow.webContents.capturePage();
        const pngBuffer = image.toPNG();
        resolve(pngBuffer);
      } catch (err) {
        reject(err);
      }
    });
    
    minimapWindow.webContents.send('minimap:updateByTime', timestampMs);
  });
}

// Pre-render minimap overlay to a temp video file
async function preRenderMinimap(exportId, seiData, mapPath, startTimeMs, endTimeMs, minimapWidth, minimapHeight, ffmpegPath, sendProgress, cancelledExports, darkMode = false, providerId = MapProviders.DEFAULT_PROVIDER_ID) {
  // Capture at 12fps instead of the video's 36fps: every frame is a separate
  // BrowserWindow capturePage round-trip, which dominates export time on long
  // clips (a 5-minute clip is ~10,800 captures at 36fps). The overlay filter
  // syncs by timestamp and holds each minimap frame until the next one, so a
  // 12fps corner map on a 36fps video just updates its marker 12x/second —
  // visually equivalent at minimap size for a 3x faster pre-render.
  // Still optimized with:
  // 1. Locked map view (no tile updates after initial load)
  // 2. Interpolated GPS positions for smooth movement
  // 3. Only marker CSS transforms (GPU accelerated)
  const FPS = 12;
  const durationSec = (endTimeMs - startTimeMs) / 1000;
  const totalFrames = Math.ceil(durationSec * FPS);
  
  const tempPath = path.join(os.tmpdir(), `minimap_${exportId}_${Date.now()}.mov`);
  
  console.log(`[MINIMAP] Creating renderer window ${minimapWidth}x${minimapHeight}`);
  console.log(`[MINIMAP] Smooth mode: ${totalFrames} frames at ${FPS}fps with interpolation`);
  const minimapWindow = await createMinimapRenderer(minimapWidth, minimapHeight);
  let ffmpegProcess = null;

  try {
  // Set the tile provider before the view locks so the right tiles load
  minimapWindow.webContents.send('minimap:setProvider', providerId);
  console.log(`[MINIMAP] Tile provider: ${providerId}`);

  // Send the map path data for the polyline (this also locks the view)
  minimapWindow.webContents.send('minimap:init', mapPath);
  console.log(`[MINIMAP] Sent ${mapPath.length} GPS points to renderer`);
  
  // Prepare GPS data for interpolation
  const gpsInterpolationData = seiData
    .filter(d => d.sei && d.sei.latitude_deg !== undefined && d.sei.longitude_deg !== undefined)
    .map(d => ({
      t: d.timestampMs,
      lat: d.sei.latitude_deg,
      lon: d.sei.longitude_deg,
      heading: d.sei.heading_deg || 0
    }));
  
  // Send GPS data for client-side interpolation
  minimapWindow.webContents.send('minimap:setGpsData', gpsInterpolationData);
  console.log(`[MINIMAP] Sent ${gpsInterpolationData.length} GPS points for interpolation`);
  
  // Send dark mode setting to renderer
  if (darkMode) {
    minimapWindow.webContents.send('minimap:setDarkMode', darkMode);
  }
  
  
  // Wait for map tiles to load (only happens once!)
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  const ffmpegArgs = [
    '-y',
    '-f', 'image2pipe',
    '-framerate', FPS.toString(),
    '-i', 'pipe:0',
    '-c:v', 'qtrle',
    '-pix_fmt', 'argb',
    '-r', FPS.toString(),
    tempPath
  ];
  
  console.log(`[MINIMAP] Starting FFmpeg: ${ffmpegPath} ${ffmpegArgs.join(' ')}`);
  
  ffmpegProcess = spawn(ffmpegPath, ffmpegArgs, {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  
  let ffmpegError = null;
  ffmpegProcess.stderr.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('error') || msg.includes('Error')) {
      ffmpegError = msg;
    }
  });
  
    for (let frame = 0; frame < totalFrames; frame++) {
      if (cancelledExports.has(exportId)) {
        ffmpegProcess.stdin.end();
        try { fs.unlinkSync(tempPath); } catch {}
        throw new Error('Export cancelled');
      }
      
      const frameTimeMs = startTimeMs + (frame / FPS) * 1000;
      
      // Use timestamp-based update (renderer handles interpolation)
      const pngBuffer = await renderMinimapFrameByTime(minimapWindow, frameTimeMs, minimapWidth, minimapHeight);
      ffmpegProcess.stdin.write(pngBuffer);
      
      if (frame % FPS === 0 || frame === totalFrames - 1) {
        const pct = Math.round((frame / totalFrames) * 100);
        sendProgress(pct, `Pre-rendering minimap... ${pct}%`);
      }
    }
    
    ffmpegProcess.stdin.end();
    
    await new Promise((resolve, reject) => {
      ffmpegProcess.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`FFmpeg minimap encoding failed with code ${code}: ${ffmpegError || 'Unknown error'}`));
        }
      });
      ffmpegProcess.on('error', reject);
    });
    
    return tempPath;
  } catch (err) {
    try { ffmpegProcess?.stdin?.end(); } catch {}
    try { if (ffmpegProcess && !ffmpegProcess.killed) ffmpegProcess.kill(); } catch {}
    try { fs.unlinkSync(tempPath); } catch {}
    throw err;
  } finally {
    minimapReadyCallbacks.delete(minimapWindow.webContents?.id);
    destroyWindow(minimapWindow);
  }
}

module.exports = {
  calculateMinimapSize,
  createMinimapRenderer,
  destroyWindow,
  installTileRequestHeaders,
  preRenderMinimap,
  renderStaticMapBackground,
  staticMapView
};
