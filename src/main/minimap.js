const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { spawn } = require('child_process');
const MapProviders = require('../shared/mapProviders');

// Identify Sentry Studio to tile servers. The OSMF tile policy requires an
// identifying User-Agent, and a Referer for web views, on tile.openstreetmap.org.
function installTileRequestHeaders(session) {
  session.webRequest.onBeforeSendHeaders(
    { urls: MapProviders.TILE_REQUEST_URL_PATTERNS },
    (details, callback) => {
      details.requestHeaders['User-Agent'] = MapProviders.USER_AGENT;
      if (details.url.startsWith('https://tile.openstreetmap.org/')) {
        details.requestHeaders['Referer'] = MapProviders.REFERER;
      }
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
// STATIC MAP TILE DOWNLOADING FOR ASS MINIMAP
// Downloads raster map tiles (OpenStreetMap — the raster stand-in for the
// VersaTiles vector default, see src/shared/mapProviders.js) and creates a
// composite background image. A handful of tiles (at most 16) per
// user-started export, sent with an identifying User-Agent, keeps this
// within the OSMF tile usage policy.
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
 * Convert tile coordinates back to lat/lon (top-left corner of tile)
 * @param {number} x - Tile X
 * @param {number} y - Tile Y
 * @param {number} zoom - Zoom level
 * @returns {{lat: number, lon: number}}
 */
function tileToLatLon(x, y, zoom) {
  const n = Math.pow(2, zoom);
  const lon = x / n * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)));
  const lat = latRad * 180 / Math.PI;
  return { lat, lon };
}

/**
 * Calculate optimal zoom level for GPS bounds to fit in target size
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
  // the stitch can never balloon into thousands of tiles. The old code returned a
  // fixed zoom 14 here, which on a 6-7h drive produced a 182x72 = 13,104-tile grid
  // and a ~1MB FFmpeg command line that died with spawn ENAMETOOLONG.
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

/**
 * Download a single map tile from the given provider
 * @param {number} x - Tile X coordinate
 * @param {number} y - Tile Y coordinate
 * @param {number} zoom - Zoom level
 * @param {string} outputPath - Path to save the tile
 * @param {string} providerId - Provider id from the shared registry
 * @param {number} requestIndex - Running counter for subdomain round-robin
 * @returns {Promise<string>} Path to downloaded tile
 */
async function downloadMapTile(x, y, zoom, outputPath, providerId = 'osm', requestIndex = 0) {
  return new Promise((resolve, reject) => {
    const url = MapProviders.buildTileUrl(providerId, x, y, zoom, requestIndex);

    // The UA identifies us to any tile server (Node sends none by default);
    // the Referer is part of OSM's tile usage policy and only sent there.
    const headers = { 'User-Agent': MapProviders.USER_AGENT };
    if (MapProviders.getRasterProvider(providerId).id === 'osm') {
      headers['Referer'] = MapProviders.REFERER;
    }

    const file = fs.createWriteStream(outputPath);

    const request = https.get(url, { headers }, (response) => {
      if (response.statusCode === 200) {
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve(outputPath);
        });
      } else {
        file.close();
        fs.unlinkSync(outputPath);
        reject(new Error(`Failed to download tile: HTTP ${response.statusCode}`));
      }
    });
    
    request.on('error', (err) => {
      file.close();
      try { fs.unlinkSync(outputPath); } catch {}
      reject(err);
    });
    
    // Timeout after 10 seconds
    request.setTimeout(10000, () => {
      request.destroy();
      reject(new Error('Tile download timeout'));
    });
  });
}

/**
 * Download and stitch map tiles into a single background image for minimap
 * Uses FFmpeg to combine tiles and apply dark theme filter
 * @param {string} exportId - Export ID for temp file naming
 * @param {Array} mapPath - Array of [lat, lon] GPS coordinates
 * @param {number} targetSize - Target output size in pixels (square)
 * @param {string} ffmpegPath - Path to FFmpeg executable
 * @param {boolean} darkMode - Whether to apply dark theme filter to map tiles
 * @param {string} providerId - Tile provider id (see src/shared/mapProviders.js)
 * @param {function} [onProgress] - Receives {phase, completed, total} during tile download and stitch
 * @returns {Promise<{imagePath: string, bounds: Object, zoom: number}>}
 */
async function downloadStaticMapBackground(exportId, mapPath, targetSize, ffmpegPath, darkMode = true, providerId = MapProviders.DEFAULT_PROVIDER_ID, onProgress = null) {
  if (!mapPath || mapPath.length === 0) {
    throw new Error('No GPS data for map background');
  }
  
  // Calculate bounds with padding
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
  
  // Calculate optimal zoom
  const zoom = calculateOptimalZoom(bounds, targetSize);
  console.log(`[MAP] Calculated zoom level: ${zoom} for bounds`);
  
  // Get tile range
  const topLeftTile = latLonToTile(bounds.maxLat, bounds.minLon, zoom);
  const bottomRightTile = latLonToTile(bounds.minLat, bounds.maxLon, zoom);
  
  const tilesX = bottomRightTile.x - topLeftTile.x + 1;
  const tilesY = bottomRightTile.y - topLeftTile.y + 1;
  
  const totalTiles = tilesX * tilesY;
  console.log(`[MAP] Downloading ${tilesX}x${tilesY} tiles (${totalTiles} total)`);

  // Safety net: zoom selection above bounds the grid, but never attempt a stitch
  // whose `-i` argument list would exceed the OS command-line limit (~32KB on
  // Windows) — that throws spawn ENAMETOOLONG and silently kills the map. Bail to
  // the caller's dark-panel fallback instead of failing the whole minimap.
  const MAX_SAFE_TILES = 256;
  if (totalTiles > MAX_SAFE_TILES) {
    throw new Error(`Map tile grid too large to stitch (${tilesX}x${tilesY}=${totalTiles} tiles)`);
  }

  // Report download progress without flooding IPC: emit ~150 updates across
  // the whole batch (plus the final tile) so the renderer counter ticks
  // smoothly even for very large grids.
  const reportStep = Math.max(1, Math.floor(totalTiles / 150));
  let tilesCompleted = 0;
  const reportTileProgress = () => {
    if (typeof onProgress !== 'function') return;
    if (tilesCompleted % reportStep === 0 || tilesCompleted === totalTiles) {
      onProgress({ phase: 'download', completed: tilesCompleted, total: totalTiles });
    }
  };

  // Create temp directory for tiles
  const tempDir = path.join(os.tmpdir(), `map_tiles_${exportId}_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const tilePaths = [];
  // Vector providers resolve to their raster stand-in.
  const activeProvider = MapProviders.getRasterProvider(providerId);
  const tileSize = activeProvider.tileSize || 256;

  try {
    let requestIndex = 0;
    for (let ty = topLeftTile.y; ty <= bottomRightTile.y; ty++) {
      for (let tx = topLeftTile.x; tx <= bottomRightTile.x; tx++) {
        const tilePath = path.join(tempDir, `tile_${tx}_${ty}.${activeProvider.fileExt || 'png'}`);
        await downloadMapTile(tx, ty, zoom, tilePath, activeProvider.id, requestIndex++);
        tilePaths.push({
          path: tilePath,
          tileX: tx,
          tileY: ty,
          gridX: tx - topLeftTile.x,
          gridY: ty - topLeftTile.y
        });

        tilesCompleted++;
        reportTileProgress();

        // Small delay to be nice to the tile servers
        await new Promise(r => setTimeout(r, 100));
      }
    }

    console.log(`[MAP] Downloaded ${tilePaths.length} tiles from ${activeProvider.id}`);
    // Hand off to the stitch phase so the renderer stops showing the tile
    // counter and reflects that work is still happening.
    if (typeof onProgress === 'function') {
      onProgress({ phase: 'stitch', completed: totalTiles, total: totalTiles });
    }
    
    // Use FFmpeg to stitch tiles together and apply dark theme
    const stitchedWidth = tilesX * tileSize;
    const stitchedHeight = tilesY * tileSize;
    const outputPath = path.join(os.tmpdir(), `map_bg_${exportId}_${Date.now()}.png`);
    
    // Build FFmpeg filter to tile the images together
    let inputs = [];
    let filterParts = [];
    
    // Add each tile as input
    for (const tile of tilePaths) {
      inputs.push('-i', tile.path);
    }
    
    // Dark theme filter (only applied when dark mode is enabled)
    const darkFilter = darkMode ? ',hue=s=0.7:b=-0.2,eq=brightness=-0.15:contrast=1.1' : '';

    // Create filter to position each tile
    if (tilePaths.length === 1) {
      // Single tile - scale and optionally apply dark filter
      filterParts.push(`[0:v]scale=${targetSize}:${targetSize}${darkFilter}[out]`);
    } else {
      // Multiple tiles - create canvas and overlay each
      // First, create a black canvas
      filterParts.push(`color=c=black:s=${stitchedWidth}x${stitchedHeight}:d=1[canvas]`);

      let currentLayer = '[canvas]';
      for (let i = 0; i < tilePaths.length; i++) {
        const tile = tilePaths[i];
        const x = tile.gridX * tileSize;
        const y = tile.gridY * tileSize;
        const nextLayer = i === tilePaths.length - 1 ? '[stitched]' : `[tmp${i}]`;
        filterParts.push(`${currentLayer}[${i}:v]overlay=${x}:${y}${nextLayer}`);
        currentLayer = nextLayer;
      }

      // Scale to target size and optionally apply dark theme filter
      filterParts.push(`[stitched]scale=${targetSize}:${targetSize}${darkFilter}[out]`);
    }
    
    const ffmpegArgs = [
      '-y',
      ...inputs,
      '-filter_complex', filterParts.join(';'),
      '-map', '[out]',
      '-frames:v', '1',
      outputPath
    ];
    
    console.log(`[MAP] Stitching tiles with FFmpeg...`);
    
    await new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath, ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', d => stderr += d.toString());
      proc.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg stitch failed: ${stderr}`));
      });
      proc.on('error', reject);
    });
    
    // Cleanup tile temp files
    fs.rmSync(tempDir, { recursive: true, force: true });
    
    // Calculate the actual geo bounds of the stitched image (tile edges)
    const actualTopLeft = tileToLatLon(topLeftTile.x, topLeftTile.y, zoom);
    const actualBottomRight = tileToLatLon(bottomRightTile.x + 1, bottomRightTile.y + 1, zoom);
    
    const actualBounds = {
      minLat: actualBottomRight.lat,
      maxLat: actualTopLeft.lat,
      minLon: actualTopLeft.lon,
      maxLon: actualBottomRight.lon
    };
    
    console.log(`[MAP] Created map background: ${outputPath}`);
    
    return {
      imagePath: outputPath,
      bounds: actualBounds,
      zoom,
      // Short on-video credit for the stitched tiles
      attribution: activeProvider.exportCredit || ''
    };
  } catch (err) {
    // Cleanup on error
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    throw err;
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
    
    // Inject headers for OSM tile requests (same as main window)
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
  downloadStaticMapBackground,
  installTileRequestHeaders,
  preRenderMinimap
};
