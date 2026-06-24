const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { spawn } = require('child_process');
const MapProviders = require('../shared/mapProviders');

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
// Downloads map tiles (Google by default, OSM fallback — see
// src/shared/mapProviders.js) and creates a composite background image
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
  
  // Try zoom levels from high to low, find one where bounds fit in ~2-4 tiles
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
  
  return 14; // Default fallback
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
    const headers = {
      'User-Agent': 'Sentry-Studio/1.0 (Tesla Dashcam Viewer; https://sentry-six.com/sentry-studio)'
    };
    if (!MapProviders.isGoogleProvider(providerId)) {
      headers['Referer'] = 'https://sentry-six.com/';
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
  const tileSize = 256; // OSM tiles are 256x256
  
  try {
    // Download all tiles. If Google's (unofficial, key-less) tile endpoint
    // fails mid-batch, retry that tile on OSM and keep the rest of the batch
    // on OSM so the stitched background comes from a single provider style.
    let activeProviderId = MapProviders.getProvider(providerId).id;
    let requestIndex = 0;
    for (let ty = topLeftTile.y; ty <= bottomRightTile.y; ty++) {
      for (let tx = topLeftTile.x; tx <= bottomRightTile.x; tx++) {
        const tilePath = path.join(tempDir, `tile_${tx}_${ty}.png`);
        try {
          await downloadMapTile(tx, ty, zoom, tilePath, activeProviderId, requestIndex++);
        } catch (tileErr) {
          if (!MapProviders.isGoogleProvider(activeProviderId)) throw tileErr;
          console.warn(`[MAP] ${activeProviderId} tile failed (${tileErr.message}) — switching batch to OpenStreetMap`);
          activeProviderId = MapProviders.FALLBACK_PROVIDER_ID;
          // Discard any Google tiles already downloaded so styles don't mix
          for (const t of tilePaths) {
            try { fs.unlinkSync(t.path); } catch {}
            await downloadMapTile(
              t.tileX, t.tileY, zoom, t.path, activeProviderId, requestIndex++
            );
            await new Promise(r => setTimeout(r, 100));
          }
          await downloadMapTile(tx, ty, zoom, tilePath, activeProviderId, requestIndex++);
        }
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

    console.log(`[MAP] Downloaded ${tilePaths.length} tiles`);
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
      zoom
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

// Create a hidden BrowserWindow for minimap rendering
async function createMinimapRenderer(minimapWidth, minimapHeight) {
  return new Promise((resolve, reject) => {
    // Security note: nodeIntegration + contextIsolation:false is acceptable here because
    // this is a hidden offscreen window that only loads local minimap-renderer.html.
    // No remote content is ever loaded into this window.
    const minimapWindow = new BrowserWindow({
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
    minimapWindow.webContents.session.webRequest.onBeforeSendHeaders(
      { urls: ['https://*.tile.openstreetmap.org/*'] },
      (details, callback) => {
        details.requestHeaders['User-Agent'] = 'Sentry-Studio/1.0 (Tesla Dashcam Viewer; https://sentry-six.com/sentry-studio)';
        details.requestHeaders['Referer'] = 'https://sentry-six.com/';
        callback({ requestHeaders: details.requestHeaders });
      }
    );

    const timeout = setTimeout(() => {
      console.error('[MINIMAP] Renderer load timeout');
      reject(new Error('Minimap renderer load timeout'));
    }, 15000);
    
    minimapWindow.webContents.once('did-fail-load', (event, errorCode, errorDescription) => {
      clearTimeout(timeout);
      console.error(`[MINIMAP] Renderer failed to load: ${errorDescription}`);
      reject(new Error(`Minimap renderer failed to load: ${errorDescription}`));
    });
    
    minimapWindow.webContents.once('did-finish-load', () => {
      clearTimeout(timeout);
      console.log('[MINIMAP] Renderer loaded successfully');
      setTimeout(() => resolve(minimapWindow), 500);
    });
    
    // Load minimap renderer HTML
    const rendererPath = path.join(__dirname, '..', 'renderer', 'minimap-renderer.html');
    console.log(`[MINIMAP] Loading renderer from: ${rendererPath}`);
    
    if (!fs.existsSync(rendererPath)) {
      clearTimeout(timeout);
      reject(new Error(`Minimap renderer not found at: ${rendererPath}`));
      return;
    }
    
    minimapWindow.loadFile(rendererPath);
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
  
  const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs, {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  
  let ffmpegError = null;
  ffmpegProcess.stderr.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('error') || msg.includes('Error')) {
      ffmpegError = msg;
    }
  });
  
  try {
    for (let frame = 0; frame < totalFrames; frame++) {
      if (cancelledExports.has(exportId)) {
        ffmpegProcess.stdin.end();
        minimapWindow.destroy();
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
    
    minimapWindow.destroy();
    return tempPath;
  } catch (err) {
    minimapWindow.destroy();
    try { fs.unlinkSync(tempPath); } catch {}
    throw err;
  }
}

module.exports = {
  calculateMinimapSize,
  downloadStaticMapBackground,
  preRenderMinimap
};
