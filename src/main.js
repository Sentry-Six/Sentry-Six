const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { writeCompactDashboardAss, writeDetailedDashboardAss, writeTeslaMobileDashboardAss, writeTeslaScreenDashAss, writeMinimapAss } = require('./assGenerator');
// Pure-JS PNG compositor used for blur masks. Replaces `sharp` so Linux (and other)
// users don't need the native libvips binaries bundled.
const { PNG } = require('pngjs');
function compositeBlurMasks(width, height, zones) {
  const canvas = new PNG({ width, height });
  canvas.data.fill(0);
  for (let i = 3; i < canvas.data.length; i += 4) canvas.data[i] = 255;

  for (const zone of zones) {
    const buf = Buffer.from(zone.maskImageBase64, 'base64');
    let overlay;
    try {
      overlay = PNG.sync.read(buf);
    } catch (err) {
      console.warn('[BLUR] Skipping zone - failed to decode PNG mask:', err.message);
      continue;
    }
    const copyW = Math.min(overlay.width, width);
    const copyH = Math.min(overlay.height, height);
    for (let y = 0; y < copyH; y++) {
      for (let x = 0; x < copyW; x++) {
        const srcIdx = (y * overlay.width + x) * 4;
        const dstIdx = (y * width + x) * 4;
        const sa = overlay.data[srcIdx + 3];
        if (sa === 0) continue;
        if (sa === 255) {
          canvas.data[dstIdx]     = overlay.data[srcIdx];
          canvas.data[dstIdx + 1] = overlay.data[srcIdx + 1];
          canvas.data[dstIdx + 2] = overlay.data[srcIdx + 2];
          canvas.data[dstIdx + 3] = 255;
        } else {
          const a = sa / 255;
          canvas.data[dstIdx]     = Math.round(overlay.data[srcIdx]     * a + canvas.data[dstIdx]     * (1 - a));
          canvas.data[dstIdx + 1] = Math.round(overlay.data[srcIdx + 1] * a + canvas.data[dstIdx + 1] * (1 - a));
          canvas.data[dstIdx + 2] = Math.round(overlay.data[srcIdx + 2] * a + canvas.data[dstIdx + 2] * (1 - a));
          canvas.data[dstIdx + 3] = 255;
        }
      }
    }
  }

  return PNG.sync.write(canvas);
}
const { checkUpdateWithTelemetry, processApiResponse } = require('./updateTelemetry');
const { settingsPath, loadSettings, saveSettings, registerSettingsIpc } = require('./main/settings');
const { SUPPORT_SERVER_URL, registerSupportChatIpc } = require('./main/supportChat');
const { registerDiagnosticsStorageIpc } = require('./main/diagnostics');
const { UPDATE_CONFIG, autoUpdater, getLatestVersionFromGitHub, registerAutoUpdateIpc, setupAutoUpdaterEvents } = require('./main/autoUpdate');
const { findFFmpegPath, preCacheFFmpegPath, formatExportDuration, detectGpuHardware, detectGpuEncoder, detectHEVCEncoder, findVaapiDevice, getGpuEncoder, setGpuEncoder, getGpuEncoderHEVC, setGpuEncoderHEVC } = require('./main/ffmpeg');
const { calculateMinimapSize, downloadStaticMapBackground, preRenderMinimap } = require('./main/minimap');
const crypto = require('crypto');

// ============================================
// DIAGNOSTICS: Console capture (must be early to catch all logs)
// ============================================
const mainLogBuffer = [];
const originalMainConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  info: console.info.bind(console)
};

function captureMainLog(level, args) {
  const entry = {
    t: Date.now(),
    l: level,
    m: args.map(arg => {
      try {
        if (arg instanceof Error) {
          return `${arg.name}: ${arg.message}\n${arg.stack || ''}`;
        }
        if (typeof arg === 'object') {
          return JSON.stringify(arg, null, 0);
        }
        return String(arg);
      } catch {
        return '[Unserializable]';
      }
    }).join(' ')
  };
  mainLogBuffer.push(entry);
  if (mainLogBuffer.length > 5000) mainLogBuffer.shift();
}

// Override console methods to capture all logs from startup
console.log = (...args) => { captureMainLog('log', args); originalMainConsole.log(...args); };
console.warn = (...args) => { captureMainLog('warn', args); originalMainConsole.warn(...args); };
console.error = (...args) => { captureMainLog('error', args); originalMainConsole.error(...args); };
console.info = (...args) => { captureMainLog('info', args); originalMainConsole.info(...args); };

// Get the configured update branch from settings (defaults to main)
function getUpdateBranch() {
  const settings = loadSettings();
  return settings.updateBranch || UPDATE_CONFIG.defaultBranch;
}

// Active exports tracking
const activeExports = {};
const activeExportPaths = {}; // Track output paths for cleanup on cancel
const cancelledExports = new Set(); // Track cancelled exports by ID
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1384,
    minHeight: 861,
    title: 'Sentry Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false, // Required for file:// video playback from local TeslaCam folders
    },
  });
  mainWindow.setMenuBarVisibility(false);

  // Inject User-Agent and Referer headers for OSM tile requests
  // OSM now enforces their tile usage policy and blocks requests from file:// origins
  // that lack proper identification headers
  mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: ['https://*.tile.openstreetmap.org/*'] },
    (details, callback) => {
      details.requestHeaders['User-Agent'] = 'Sentry-Studio/1.0 (Tesla Dashcam Viewer; https://sentry-six.com/sentry-studio)';
      details.requestHeaders['Referer'] = 'https://sentry-six.com/';
      callback({ requestHeaders: details.requestHeaders });
    }
  );

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// Parse timestamp key from filename (format: YYYY-MM-DD_HH-MM-SS-camera.mp4)
function parseTimestampKeyFromFilename(filename) {
  if (!filename) return null;
  const match = filename.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}_${match[4]}-${match[5]}-${match[6]}`;
}

// Convert timestamp key to epoch milliseconds (Tesla filenames are in vehicle local time)
function parseTimestampKeyToEpochMs(timestampKey) {
  if (!timestampKey) return null;
  const match = String(timestampKey).match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, Y, Mo, D, h, mi, s] = match;
  return new Date(+Y, +Mo - 1, +D, +h, +mi, +s, 0).getTime();
}

// ============================================
// VIDEO EXPORT IMPLEMENTATION
// ============================================

/**
 * Apply blur zones to individual camera streams before grid/layout composition.
 * Shared by both custom-layout and grid-layout branches of performVideoExport.
 *
 * @param {Object} opts
 * @param {Array}  opts.blurZones       - Export blur zone definitions
 * @param {string} opts.blurType        - Blur type (currently always 'trueBlur')
 * @param {Array}  opts.streams         - Array of { camera, tag } objects (tags are mutated)
 * @param {Array}  opts.streamTags      - Optional streamTags array to keep in sync (grid path)
 * @param {number} opts.cameraW         - Per-camera output width
 * @param {number} opts.cameraH         - Per-camera output height
 * @param {Array}  opts.filters         - FFmpeg filter array (mutated)
 * @param {Array}  opts.cmd             - FFmpeg command array (mutated — mask inputs added)
 * @param {Array}  opts.tempFiles       - Temp file list (mutated — mask paths added)
 * @param {number} opts.inputCount      - Number of existing inputs at the point of call
 * @param {number} opts.extraOffset     - Additional index offset (e.g. +1 when baseInput exists)
 * @param {string} opts.exportId        - Export ID for temp file naming
 * @param {number} opts.FPS             - Frame rate
 */
async function applyBlurZonesToStreams({ blurZones, blurType, streams, streamTags, cameraW, cameraH, filters, cmd, tempFiles, inputCount, extraOffset, exportId, FPS }) {
  if (!blurZones.length) return false;

  const zonesByCamera = {};
  for (const zone of blurZones) {
    if (!zone || !zone.maskImageBase64 || !zone.camera) continue;
    if (!zonesByCamera[zone.camera]) zonesByCamera[zone.camera] = [];
    zonesByCamera[zone.camera].push(zone);
  }

  let maskInputOffset = 0;
  for (const [cam, zones] of Object.entries(zonesByCamera)) {
    const blurStream = streams.find(s => s.camera === cam);
    if (!blurStream) continue;

    const blurCameraStreamTag = blurStream.tag;
    console.log(`[BLUR] Applying ${zones.length} blur zone(s) to camera: ${cam} (method: ${blurType})`);

    try {
      const firstZone = zones[0];
      const maskW = firstZone.maskWidth || 1448;
      const maskH = firstZone.maskHeight || 938;

      const compositeMaskBuffer = compositeBlurMasks(maskW, maskH, zones);
      const maskPath = path.join(os.tmpdir(), `blur_mask_${exportId}_${cam}_${Date.now()}.png`);
      fs.writeFileSync(maskPath, compositeMaskBuffer);
      tempFiles.push(maskPath);

      let maskInputIdx = inputCount + 1 + extraOffset + maskInputOffset;
      maskInputOffset++;

      cmd.push('-loop', '1', '-framerate', FPS.toString(), '-i', maskPath);

      const blurredStreamTag = `[blurred_${cam}]`;

      filters.push(`${blurCameraStreamTag}split=2[blur_orig_${cam}][blur_base_${cam}]`);
      filters.push(`[${maskInputIdx}:v]scale=${cameraW}:${cameraH}:force_original_aspect_ratio=disable,format=gray,format=yuva420p[mask_alpha_${cam}]`);
      filters.push(`[blur_orig_${cam}]boxblur=10:10[blurred_temp_${cam}]`);
      filters.push(`[blurred_temp_${cam}][mask_alpha_${cam}]alphamerge[blurred_with_alpha_${cam}]`);
      filters.push(`[blur_base_${cam}][blurred_with_alpha_${cam}]overlay=0:0:format=auto${blurredStreamTag}`);

      blurStream.tag = blurredStreamTag;
      if (streamTags) {
        const streamIndex = streamTags.indexOf(blurCameraStreamTag);
        if (streamIndex !== -1) streamTags[streamIndex] = blurredStreamTag;
      }
    } catch (err) {
      console.error('[BLUR] Failed to apply blur zone:', err);
      return true;
    }
  }
  return false;
}

// Video Export Implementation
async function performVideoExport(event, exportId, exportData, ffmpegPath) {
  const { segments, startTimeMs, endTimeMs, outputPath, cameras, mobileExport, quality, includeDashboard, seiData, layoutData, useMetric, dashboardStyle = 'standard', dashboardPosition = 'bottom-center', dashboardSize = 'medium', includeTimestamp = false, timestampPosition = 'bottom-center', timestampDateFormat = 'mdy', timestampTimeFormat = '12h', blurZones = [], blurType = 'solid', language = 'en', includeMinimap = false, minimapPosition = 'top-right', minimapSize = 'small', minimapRenderMode = 'ass', minimapDarkMode = false, mapPath = [], mirrorCameras = true, accelPedMode = 'iconbar', enableTimelapse = false, timelapseSpeed = 1 } = exportData;

  console.log(`[EXPORT] Received exportData - includeMinimap: ${includeMinimap}, mapPath.length: ${mapPath?.length || 0}, minimapPosition: ${minimapPosition}, minimapSize: ${minimapSize}, renderMode: ${minimapRenderMode}`);

  const tempFiles = [];
  const CAMERA_ORDER = ['left_pillar', 'front', 'right_pillar', 'left_repeater', 'back', 'right_repeater'];
  const FPS = 36; // Tesla cameras record at ~36fps

  const sendProgress = (percentage, message) => {
    event.sender.send('export:progress', exportId, { type: 'progress', percentage, message });
  };

  const sendDashboardProgress = (percentage, message) => {
    event.sender.send('export:progress', exportId, { type: 'dashboard-progress', percentage, message });
  };

  const sendMinimapProgress = (percentage, message) => {
    event.sender.send('export:progress', exportId, { type: 'minimap-progress', percentage, message });
  };

  let completeSent = false;
  const sendComplete = (success, message, warning = null) => {
    completeSent = true;
    event.sender.send('export:progress', exportId, { type: 'complete', success, message, outputPath, warning });
  };

  const cleanup = () => tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch { } });

  // Minimap temp file path (set during pre-render)
  let minimapTempPath = null;
  // Square minimap dimension in pixels — set during pre-render, used later for
  // the screen-blend composite when Tesla Screen Dash is active.
  let minimapPixelSize = 0;

  // Track blur zone failures
  let blurFailed = false;

  // Check if export was cancelled before starting
  if (cancelledExports.has(exportId)) {
    console.log('Export cancelled before starting:', exportId);
    cancelledExports.delete(exportId);
    return Promise.reject(new Error('Export cancelled'));
  }

  try {
    console.log('[EXPORT] Starting video export...');
    sendProgress(2, { key: 'ui.export.analyzingSegments' });

    const durationSec = (endTimeMs - startTimeMs) / 1000;
    const selectedCameras = new Set(cameras || CAMERA_ORDER);

    // Find overlapping segments
    const relevantSegments = [];
    let cumMs = 0;
    for (const seg of segments) {
      const segDur = (seg.durationSec || 60) * 1000;
      const segStart = cumMs, segEnd = cumMs + segDur;
      if (segEnd > startTimeMs && segStart < endTimeMs) {
        relevantSegments.push({ ...seg, segStartMs: segStart, segEndMs: segEnd });
      }
      cumMs += segDur;
    }

    if (!relevantSegments.length) throw new Error('No segments found in export range');
    console.log(`[SEGMENTS] Found ${relevantSegments.length} segments for export`);

    // Start export timer - rendering begins now (dashboards, minimaps, blur zones, etc.)
    const exportStartTime = Date.now();
    console.log('[EXPORT] Export rendering started');

    // Build camera inputs for ALL cameras in order (use black for missing/unselected)
    const inputs = [];
    const cameraInputMap = new Map(); // Maps camera name to input index

    for (const camera of CAMERA_ORDER) {
      // Skip if not selected
      if (!selectedCameras.has(camera)) continue;

      const files = relevantSegments
        .map(seg => seg.files?.[camera])
        .filter(p => p && fs.existsSync(p));

      if (!files.length) continue; // Will use black source

      if (files.length === 1) {
        const seg = relevantSegments.find(s => s.files?.[camera] === files[0]);
        cameraInputMap.set(camera, inputs.length);
        inputs.push({
          camera,
          path: files[0],
          offset: Math.max(0, startTimeMs - seg.segStartMs) / 1000,
          isConcat: false
        });
      } else {
        const concatPath = path.join(os.tmpdir(), `export_${camera}_${Date.now()}.txt`);
        fs.writeFileSync(concatPath, files.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
        tempFiles.push(concatPath);

        const firstSeg = relevantSegments.find(s => s.files?.[camera] === files[0]);
        cameraInputMap.set(camera, inputs.length);
        inputs.push({
          camera,
          path: concatPath,
          offset: Math.max(0, startTimeMs - firstSeg.segStartMs) / 1000,
          isConcat: true
        });
      }
    }

    if (!inputs.length) throw new Error('No valid camera files found for export');

    sendProgress(5, { key: 'ui.export.buildingExport' });

    // Detect native camera resolution from source files
    // HW4: Front=2896×1876, Others=1448×938 (front is 2x larger)
    // HW3: All cameras=1280×960 (all same size)
    // We probe actual files to avoid hardcoding assumptions that cause aspect ratio issues
    const isFrontOnly = selectedCameras.size === 1 && selectedCameras.has('front');
    let w, h, crf;
    const q = quality || (mobileExport ? 'mobile' : 'high');

    // Probe native resolution from a camera file
    let nativeW = 1448, nativeH = 938; // HW4 side camera defaults
    let frontNativeW = 2896, frontNativeH = 1876; // HW4 front camera defaults
    try {
      // Prefer a non-front camera to get the "base" resolution
      const probeInput = inputs.find(i => i.camera !== 'front') || inputs[0];
      const probePath = probeInput.isConcat
        ? fs.readFileSync(probeInput.path, 'utf8').split('\n')[0].replace(/^file '|'$/g, '')
        : probeInput.path;
      const probeResult = spawnSync(ffmpegPath, [
        '-i', probePath, '-hide_banner'
      ], { timeout: 10000, windowsHide: true });
      const probeOutput = (probeResult.stderr || '').toString();
      const resMatch = probeOutput.match(/Video:.*?(\d{3,5})x(\d{3,5})/);
      if (resMatch) {
        nativeW = parseInt(resMatch[1]);
        nativeH = parseInt(resMatch[2]);
        console.log(`[RESOLUTION] Detected base camera resolution: ${nativeW}x${nativeH}`);
      }

      // Also probe the front camera if available and different from what we probed
      const frontInput = inputs.find(i => i.camera === 'front');
      if (frontInput && probeInput.camera !== 'front') {
        const frontPath = frontInput.isConcat
          ? fs.readFileSync(frontInput.path, 'utf8').split('\n')[0].replace(/^file '|'$/g, '')
          : frontInput.path;
        const frontProbe = spawnSync(ffmpegPath, [
          '-i', frontPath, '-hide_banner'
        ], { timeout: 10000, windowsHide: true });
        const frontOutput = (frontProbe.stderr || '').toString();
        const frontMatch = frontOutput.match(/Video:.*?(\d{3,5})x(\d{3,5})/);
        if (frontMatch) {
          frontNativeW = parseInt(frontMatch[1]);
          frontNativeH = parseInt(frontMatch[2]);
          console.log(`[RESOLUTION] Detected front camera resolution: ${frontNativeW}x${frontNativeH}`);
        }
      } else if (probeInput.camera === 'front') {
        // Only front camera was available for probing
        frontNativeW = nativeW;
        frontNativeH = nativeH;
      }
    } catch (e) {
      console.log('[RESOLUTION] Failed to probe camera resolution, using defaults:', e.message);
    }

    // Check if front camera is the same size as other cameras (HW3)
    const frontMatchesSides = (frontNativeW === nativeW && frontNativeH === nativeH);
    if (frontMatchesSides) {
      console.log('[RESOLUTION] All cameras same resolution (HW3 style) - no front camera scaling needed');
    }

    // Ensure even dimensions helper
    const makeEven = (n) => Math.round(n) + (Math.round(n) % 2);

    if (isFrontOnly) {
      // Front camera only - use full front camera resolution
      switch (q) {
        case 'mobile': w = makeEven(frontNativeW * 0.35); h = makeEven(frontNativeH * 0.35); crf = 28; break;
        case 'medium': w = makeEven(frontNativeW * 0.5);  h = makeEven(frontNativeH * 0.5);  crf = 26; break;
        case 'high':   w = makeEven(frontNativeW * 0.75); h = makeEven(frontNativeH * 0.75); crf = 23; break;
        case 'max':    w = makeEven(frontNativeW);         h = makeEven(frontNativeH);         crf = 20; break;
        default:       w = makeEven(frontNativeW * 0.5);  h = makeEven(frontNativeH * 0.5);  crf = 23;
      }
      console.log(`[RESOLUTION] Front camera only - using front native ${frontNativeW}x${frontNativeH}, output ${w}x${h}`);
    } else {
      // Multi-camera - scale to base (side) camera resolution
      // CRF is lowered vs single-camera because the grid has multiple independent
      // motion regions that are harder to compress; without this the encoder
      // spreads its bit budget thin and the front camera (downscaled from 2x native
      // on HW4) shows visible compression artifacts at every quality level
      switch (q) {
        case 'mobile': w = makeEven(nativeW * 0.4); h = makeEven(nativeH * 0.4); crf = 27; break;
        case 'medium': w = makeEven(nativeW * 0.5);  h = makeEven(nativeH * 0.5);  crf = 23; break;
        case 'high':   w = makeEven(nativeW * 0.75); h = makeEven(nativeH * 0.75); crf = 20; break;
        case 'max':    w = makeEven(nativeW);         h = makeEven(nativeH);         crf = 18; break;
        default:       w = makeEven(nativeW * 0.75); h = makeEven(nativeH * 0.75); crf = 20;
      }
    }

    // Detect GPU encoder
    const gpu = detectGpuEncoder(ffmpegPath);

    // Build FFmpeg command with memory optimization flags
    const cmd = [ffmpegPath, '-y'];

    // Memory optimization: limit input buffer sizes and reduce buffering
    // Note: thread_queue_size applies to all inputs, keeping it low reduces RAM
    cmd.push('-thread_queue_size', '512'); // Limit input queue size (default is often 8MB+ per input)
    cmd.push('-probesize', '32M'); // Limit probe size for format detection
    cmd.push('-analyzeduration', '10M'); // Limit analysis duration

    // Additional memory optimizations
    cmd.push('-fflags', '+genpts+discardcorrupt'); // Generate PTS and discard corrupt frames (reduces buffering)
    cmd.push('-flags', '+low_delay'); // Low delay mode (reduces buffering)

    // Add video inputs with memory-limiting flags
    for (const input of inputs) {
      cmd.push('-thread_queue_size', '16'); // Limit input buffer to 16 frames
      if (input.isConcat) cmd.push('-f', 'concat', '-safe', '0');
      // Use -ss before -i for better memory efficiency (FFmpeg can skip decoding)
      if (input.offset > 0) cmd.push('-ss', input.offset.toString());
      cmd.push('-i', input.path);
    }

    // Always add black source for missing cameras (lavfi doesn't need thread_queue_size)
    const blackInputIdx = inputs.length;
    cmd.push('-f', 'lavfi', '-i', `color=c=black:s=${w}x${h}:r=${FPS}:d=${durationSec}`);

    // Build filter complex - determine which cameras are active for grid
    const activeCamerasForGrid = CAMERA_ORDER.filter(c => selectedCameras.has(c));

    // Calculate output dimensions
    let totalW, totalH, cols, rows;
    let baseInputIdx = null;

    if (layoutData && layoutData.cameras && Object.keys(layoutData.cameras).length > 0) {
      // Use custom layout - map canvas positions to video coordinates
      const cameraLayouts = layoutData.cameras;

      // Get card dimensions from layout (all cards have the same size)
      // This is the size of each card on the canvas
      const firstLayout = cameraLayouts[Object.keys(cameraLayouts)[0]];
      const cardWidth = firstLayout?.width || 200;
      const cardHeight = firstLayout?.height || 112;

      // Scale factors: map canvas card size to native camera size
      // Each card on the canvas represents one camera at native size (w x h)
      const scaleX = w / cardWidth; // Map card width to camera width
      const scaleY = h / cardHeight; // Map card height to camera height

      // Calculate bounding box: find min position and max position + camera size
      let minX = Infinity, minY = Infinity;
      let maxRight = -Infinity, maxBottom = -Infinity;

      for (const camera of activeCamerasForGrid) {
        const layout = cameraLayouts[camera];
        if (!layout) continue;

        // Position in video coordinates (scale from canvas)
        const videoX = layout.x * scaleX;
        const videoY = layout.y * scaleY;

        // Camera ends at position + native size
        const cameraRight = videoX + w;
        const cameraBottom = videoY + h;

        if (videoX < minX) minX = videoX;
        if (videoY < minY) minY = videoY;
        if (cameraRight > maxRight) maxRight = cameraRight;
        if (cameraBottom > maxBottom) maxBottom = cameraBottom;
      }

      // Total output size is from 0 to max (we'll offset positions to start at 0)
      totalW = Math.ceil(maxRight - minX);
      totalH = Math.ceil(maxBottom - minY);

      // Ensure even dimensions for video encoding
      totalW = totalW + (totalW % 2);
      totalH = totalH + (totalH % 2);

      cols = 0; rows = 0; // Not used for custom layout
      console.log(`📐 Custom layout: ${totalW}x${totalH} (cameras at native ${w}x${h}, card ${cardWidth}x${cardHeight}, scale ${scaleX.toFixed(3)}x/${scaleY.toFixed(3)}y)`);

      // Add base canvas input for custom layout (after black source)
      baseInputIdx = inputs.length + 1;
      cmd.push('-f', 'lavfi', '-i', `color=c=black:s=${totalW}x${totalH}:r=${FPS}:d=${durationSec}`);
    } else {
      // Grid layout - calculate grid dimensions and total output resolution
      const numStreams = activeCamerasForGrid.length;
      if (numStreams <= 1) { cols = 1; rows = 1; }
      else if (numStreams === 2) { cols = 2; rows = 1; }
      else if (numStreams === 3) { cols = 3; rows = 1; }
      else if (numStreams === 4) { cols = 2; rows = 2; }
      else { cols = 3; rows = 2; }

      totalW = w * cols;
      totalH = h * rows;
    }

    let useAssDashboard = false;
    let assTempPath = null;
    let teslaMobileDashHeight = 0; // Height of Tesla Mobile dashboard bar
    let teslaMobileDateHeight = 0; // Height of Tesla Mobile date header bar
    let teslaMobileIsTop = false;  // Whether Tesla Mobile dashboard bar is at top

    if (includeDashboard && seiData && seiData.length > 0) {
      if (cancelledExports.has(exportId)) {
        console.log('Export cancelled before dashboard generation');
        throw new Error('Export cancelled');
      }

      try {
        sendDashboardProgress(5, 'Generating dashboard overlay...');
        const cumStarts = segments.map(seg => seg.startSec || 0);

        // For Tesla Mobile, calculate bar heights and extend canvas dimensions
        // Two bars: date header (always top) + dashboard (top or bottom of clip)
        // Bottom: [Date] [Clip] [Dashboard]
        // Top:    [Date] [Dashboard] [Clip]
        if (dashboardStyle === 'tesla-mobile') {
          teslaMobileDashHeight = Math.round(totalW / 38);
          teslaMobileDashHeight = teslaMobileDashHeight + (teslaMobileDashHeight % 2); // Even for encoder
          teslaMobileDateHeight = Math.round(totalW / 45); // Tight fit around date text
          teslaMobileDateHeight = teslaMobileDateHeight + (teslaMobileDateHeight % 2);
          teslaMobileIsTop = dashboardPosition === 'top' || dashboardPosition === 'top-center' || dashboardPosition === 'top-left' || dashboardPosition === 'top-right';
        }

        const totalPadding = teslaMobileDashHeight + teslaMobileDateHeight;
        const paddedH = totalH + totalPadding;

        const dashOpts = {
          playResX: totalW,
          playResY: paddedH,
          position: dashboardPosition,
          size: dashboardSize,
          useMetric,
          segments,
          cumStarts,
          dateFormat: timestampDateFormat,
          timeFormat: timestampTimeFormat,
          language,
          accelPedMode,
          videoH: totalH,               // Original video height (before padding)
          dateBarHeight: teslaMobileDateHeight, // Height of date header bar
          dashBarHeight: teslaMobileDashHeight  // Height of dashboard bar
        };

        if (dashboardStyle === 'detailed') {
          assTempPath = await writeDetailedDashboardAss(exportId, seiData, startTimeMs, endTimeMs, dashOpts);
        } else if (dashboardStyle === 'tesla-mobile') {
          // Update totalH to include both bars (affects encoder resolution checks)
          totalH = paddedH;
          assTempPath = await writeTeslaMobileDashboardAss(exportId, seiData, startTimeMs, endTimeMs, dashOpts);
        } else if (dashboardStyle === 'tesla-screen-dash') {
          // No canvas padding — overlay sits on the original frame
          assTempPath = await writeTeslaScreenDashAss(exportId, seiData, startTimeMs, endTimeMs, dashOpts);
        } else {
          assTempPath = await writeCompactDashboardAss(exportId, seiData, startTimeMs, endTimeMs, dashOpts);
        }
        tempFiles.push(assTempPath);
        useAssDashboard = true;

        sendDashboardProgress(100, 'Dashboard overlay ready');
        console.log(`[ASS] Generated dashboard: ${assTempPath}`);
      } catch (err) {
        if (err.message === 'Export cancelled' || cancelledExports.has(exportId)) {
          throw err;
        }
        console.error('[ASS] Failed to generate dashboard:', err);
        sendDashboardProgress(0, `Dashboard generation failed: ${err.message}. Continuing without overlay...`);
        useAssDashboard = false;
      }
    }

    // Minimap rendering (if enabled and we have GPS data)
    // Two modes: 'ass' (fast, vector-based) or 'leaflet' (slow, map tiles)
    let useAssMinimap = false;
    let useLeafletMinimap = false;
    let minimapAssTempPath = null;
    console.log(`[MINIMAP] Checking conditions: includeMinimap=${includeMinimap}, mapPath.length=${mapPath?.length || 0}, seiData.length=${seiData?.length || 0}, renderMode=${minimapRenderMode}`);

    if (includeMinimap && mapPath && mapPath.length > 0 && seiData && seiData.length > 0) {
      if (cancelledExports.has(exportId)) {
        console.log('Export cancelled before minimap render');
        throw new Error('Export cancelled');
      }

      if (minimapRenderMode === 'ass') {
        // ASS Mode: Download map tiles + overlay ASS route/markers
        try {
          const minimapDims = calculateMinimapSize(totalW, totalH, minimapSize);
          const minimapTargetSize = minimapDims.width; // Square minimap
          minimapPixelSize = minimapTargetSize;

          sendMinimapProgress(0, 'Downloading map tiles...');

          // Step 1: Download static map background image
          let mapBgPath = null;
          let mapBounds = null;
          let mapZoom = null;

          try {
            const mapResult = await downloadStaticMapBackground(
              exportId,
              mapPath,
              minimapTargetSize,
              ffmpegPath,
              minimapDarkMode
            );
            mapBgPath = mapResult.imagePath;
            mapBounds = mapResult.bounds;
            mapZoom = mapResult.zoom;
            tempFiles.push(mapBgPath);
            console.log(`[MINIMAP] Downloaded map background: ${mapBgPath}`);
          } catch (mapErr) {
            console.warn(`[MINIMAP] Failed to download map tiles: ${mapErr.message}. Using dark background.`);
            // Continue without map background - will use dark bg from ASS
          }

          sendMinimapProgress(30, 'Generating route overlay...');

          // Step 2: Generate ASS with route path and markers
          // If we have a map background, use standalone mode with map bounds
          // Otherwise, use normal mode with dark background
          if (mapBgPath && mapBounds) {
            // Standalone mode: ASS coordinates are 0,0 to minimapTargetSize
            minimapAssTempPath = await writeMinimapAss(
              exportId,
              seiData,
              mapPath,
              startTimeMs,
              endTimeMs,
              {
                standaloneMode: true,
                standaloneSize: minimapTargetSize,
                customBounds: mapBounds,
                includeBackground: false, // Map image is the background
                mapZoom
              }
            );
          } else {
            // Normal mode: ASS includes dark background
            minimapAssTempPath = await writeMinimapAss(
              exportId,
              seiData,
              mapPath,
              startTimeMs,
              endTimeMs,
              {
                standaloneMode: true,
                standaloneSize: minimapTargetSize,
                includeBackground: true // Use ASS dark background
              }
            );
          }
          tempFiles.push(minimapAssTempPath);

          sendMinimapProgress(50, 'Creating minimap video...');

          // Step 3: Create composite minimap video (map bg + ASS overlay)
          // This pre-renders the minimap so FFmpeg can just overlay it on the main video
          const minimapVideoPath = path.join(os.tmpdir(), `minimap_video_${exportId}_${Date.now()}.mov`);

          const escapedAssPath = minimapAssTempPath
            .replace(/\\/g, '/')
            .replace(/:/g, '\\:');

          // For Tesla Screen Dash, feather only the left edge and the bottom
          // edge of the minimap with thin gradient bands so they blend into
          // the underlying clip. The bulk of the map (top + right + center)
          // stays fully opaque. Two independent factors that multiply:
          //   left_factor  = clip(X / (0.2*W), 0, 1)   — leftmost 20% fades
          //   bottom_factor= clip((H-Y)/(0.2*H), 0, 1) — bottom 20% fades
          //   alpha = alpha_in * left_factor * bottom_factor
          // The top and right edges are unchanged (their factors stay at 1
          // because X is large near the right edge and Y is small near the
          // top). The bottom-left corner gets the strongest fade since both
          // factors approach zero there, giving a soft round-corner shape.
          const featherFilter = dashboardStyle === 'tesla-screen-dash'
            ? `,format=rgba,geq=r='r(X\\,Y)':g='g(X\\,Y)':b='b(X\\,Y)':a='alpha(X\\,Y)*min(1\\,X/W*5)*min(1\\,(H-Y)/H*5)'`
            : '';

          let minimapFfmpegArgs;
          if (mapBgPath) {
            // Use map image as background, loop it for video duration
            const escapedMapPath = mapBgPath.replace(/\\/g, '/');
            minimapFfmpegArgs = [
              '-y',
              '-loop', '1',
              '-i', mapBgPath,
              '-t', durationSec.toString(),
              '-vf', `scale=${minimapTargetSize}:${minimapTargetSize},format=rgba,ass='${escapedAssPath}'${featherFilter}`,
              '-c:v', 'qtrle',
              '-pix_fmt', 'argb',
              '-r', '36',
              minimapVideoPath
            ];
          } else {
            // Use black background with ASS (includes dark panel)
            minimapFfmpegArgs = [
              '-y',
              '-f', 'lavfi',
              '-i', `color=c=black@0:s=${minimapTargetSize}x${minimapTargetSize}:d=${durationSec}:r=36,format=rgba`,
              '-vf', `ass='${escapedAssPath}'${featherFilter}`,
              '-c:v', 'qtrle',
              '-pix_fmt', 'argb',
              '-r', '36',
              minimapVideoPath
            ];
          }

          console.log(`[MINIMAP] Creating composite video: ${ffmpegPath} ${minimapFfmpegArgs.join(' ')}`);

          await new Promise((resolve, reject) => {
            const proc = spawn(ffmpegPath, minimapFfmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
            let stderr = '';
            proc.stderr.on('data', d => stderr += d.toString());
            proc.on('close', code => {
              if (code === 0) resolve();
              else reject(new Error(`FFmpeg minimap composite failed: ${stderr.slice(-500)}`));
            });
            proc.on('error', reject);
          });

          // Use the composite video as the minimap (same as Leaflet mode)
          minimapTempPath = minimapVideoPath;
          tempFiles.push(minimapVideoPath);
          useLeafletMinimap = true; // Use video overlay mode
          useAssMinimap = false; // Not using direct ASS mode

          sendMinimapProgress(100, 'Minimap ready');
          console.log(`[MINIMAP] Created ASS minimap with map background: ${minimapVideoPath}`);
        } catch (err) {
          if (err.message === 'Export cancelled' || cancelledExports.has(exportId)) {
            throw err;
          }
          console.error('[MINIMAP] Failed to generate ASS minimap:', err);
          sendMinimapProgress(0, `Minimap generation failed: ${err.message}. Continuing without minimap...`);
          useAssMinimap = false;
          useLeafletMinimap = false;
        }
      } else {
        // Leaflet Mode: Slow BrowserWindow pre-rendering with map tiles
        try {
          const minimapDims = calculateMinimapSize(totalW, totalH, minimapSize);
          const minimapWidth = minimapDims.width;
          const minimapHeight = minimapDims.height;
          minimapPixelSize = minimapWidth;
          console.log(`[MINIMAP] Leaflet mode - Dimensions: ${minimapWidth}x${minimapHeight}, position: ${minimapPosition}`);

          sendMinimapProgress(0, 'Pre-rendering minimap overlay (Leaflet)...');

          minimapTempPath = await preRenderMinimap(
            exportId,
            seiData,
            mapPath,
            startTimeMs,
            endTimeMs,
            minimapWidth,
            minimapHeight,
            ffmpegPath,
            sendMinimapProgress,
            cancelledExports,
            minimapDarkMode
          );

          tempFiles.push(minimapTempPath);
          useLeafletMinimap = true;
          sendMinimapProgress(100, 'Minimap overlay ready (Leaflet)');
          console.log(`[MINIMAP] Pre-rendered Leaflet minimap: ${minimapTempPath}`);
        } catch (err) {
          if (err.message === 'Export cancelled' || cancelledExports.has(exportId)) {
            throw err;
          }
          console.error('[MINIMAP] Failed to pre-render Leaflet minimap:', err);
          sendMinimapProgress(0, `Minimap rendering failed: ${err.message}. Continuing without minimap...`);
          useLeafletMinimap = false;
        }
      }
    } else {
      console.log('[MINIMAP] Skipping - conditions not met');
    }

    let useTimestamp = includeTimestamp && !useAssDashboard;

    // Calculate timestamp basetime from first relevant segment
    let timestampBasetimeUs = null;
    if (useTimestamp) {
      // Find the first segment's timestamp from filename
      const firstSeg = relevantSegments[0];
      if (firstSeg) {
        const files = firstSeg.files || {};
        let filename = files.front ? path.basename(files.front) : null;
        if (!filename) {
          const firstCamera = Object.keys(files)[0];
          if (firstCamera) filename = path.basename(files[firstCamera]);
        }

        if (filename) {
          const timestampKey = parseTimestampKeyFromFilename(filename);
          if (timestampKey) {
            const segmentStartEpochMs = parseTimestampKeyToEpochMs(timestampKey);
            if (segmentStartEpochMs) {
              // Add the offset within the first segment (if export starts mid-segment)
              const firstSegStartMs = firstSeg.segStartMs || 0;
              const offsetWithinFirstSegMs = Math.max(0, startTimeMs - firstSegStartMs);
              const exportStartEpochMs = segmentStartEpochMs + offsetWithinFirstSegMs;
              timestampBasetimeUs = Math.floor(exportStartEpochMs * 1000); // Convert ms to microseconds
              console.log(`[TIMESTAMP] Basetime calculated: ${new Date(exportStartEpochMs).toISOString()}`);
            }
          }
        }
      }

      if (!timestampBasetimeUs) {
        console.warn('[TIMESTAMP] Could not calculate timestamp basetime, disabling timestamp overlay');
        useTimestamp = false;
      }
    }

    // Check for cancellation after dashboard/timestamp setup, before building filters
    if (cancelledExports.has(exportId)) {
      console.log('Export cancelled before building filters');
      throw new Error('Export cancelled');
    }

    const filters = [];
    const streamTags = [];

    if (layoutData && layoutData.cameras && Object.keys(layoutData.cameras).length > 0) {
      // Custom layout using overlay filters (base canvas already added as input)
      // Cameras use native size (w x h), only positioning comes from layout

      const cameraLayouts = layoutData.cameras;

      // Get card dimensions from layout (all cards have the same size)
      const firstLayout = cameraLayouts[Object.keys(cameraLayouts)[0]];
      const cardWidth = firstLayout?.width || 200;
      const cardHeight = firstLayout?.height || 112;

      // Calculate scale factors: map canvas card size to native camera size
      const scaleX = w / cardWidth;
      const scaleY = h / cardHeight;

      // Find minimum positions to offset all cameras (so output starts at 0,0)
      let minX = Infinity, minY = Infinity;
      for (const camera of activeCamerasForGrid) {
        const layout = cameraLayouts[camera];
        if (!layout) continue;
        const videoX = layout.x * scaleX;
        const videoY = layout.y * scaleY;
        if (videoX < minX) minX = videoX;
        if (videoY < minY) minY = videoY;
      }

      const cameraStreams = [];

      for (let i = 0; i < activeCamerasForGrid.length; i++) {
        const camera = activeCamerasForGrid[i];
        const layout = cameraLayouts[camera];
        if (!layout) continue;

        const inputIdx = cameraInputMap.get(camera);
        const hasVideo = inputIdx !== undefined;
        const srcIdx = hasVideo ? inputIdx : blackInputIdx;
        const isMirrored = mirrorCameras && ['back', 'left_repeater', 'right_repeater'].includes(camera);

        // Scale camera to native size (w x h) - exactly like old grid code
        // Ensure even dimensions
        const finalW = w + (w % 2);
        const finalH = h + (h % 2);

        // Calculate position from canvas layout (scale and offset)
        const x = Math.round((layout.x * scaleX) - minX);
        const y = Math.round((layout.y * scaleY) - minY);

        // Use smoother frame rate conversion
        // Normalize timestamps, convert frame rate, mirror if needed, scale to target size
        let chain = `[${srcIdx}:v]setpts=PTS-STARTPTS`;
        chain += `,fps=${FPS}:round=near`; // Smooth frame rate conversion
        if (hasVideo && isMirrored) chain += ',hflip';
        chain += `,scale=${finalW}:${finalH}:force_original_aspect_ratio=disable:flags=lanczos,setsar=1[v${i}]`;

        filters.push(chain);
        const streamTag = `[v${i}]`;
        cameraStreams.push({ camera, tag: streamTag, x, y });
      }

      // Apply blur zones to individual camera streams BEFORE grid composition
      const blurResult = await applyBlurZonesToStreams({
        blurZones, blurType, streams: cameraStreams, streamTags: null,
        cameraW: w + (w % 2), cameraH: h + (h % 2),
        filters, cmd, tempFiles, inputCount: inputs.length,
        extraOffset: baseInputIdx !== null ? 1 : 0, exportId, FPS
      });
      if (blurResult) blurFailed = true;

      // Chain overlays: start with base, overlay each camera in order
      let currentTag = `[${baseInputIdx}:v]`;
      for (let i = 0; i < cameraStreams.length; i++) {
        const stream = cameraStreams[i];
        const nextTag = i === cameraStreams.length - 1 ? '[grid]' : `[overlay${i}]`;
        filters.push(`${currentTag}${stream.tag}overlay=${stream.x}:${stream.y}:format=auto${nextTag}`);
        currentTag = nextTag;
      }

      // If no cameras, just copy base to grid
      if (cameraStreams.length === 0) {
        filters.push(`[${baseInputIdx}:v]copy[grid]`);
      }

    } else {
      // Grid layout (original code)
      const gridStreams = [];
      for (let i = 0; i < activeCamerasForGrid.length; i++) {
        const camera = activeCamerasForGrid[i];
        const inputIdx = cameraInputMap.get(camera);
        const hasVideo = inputIdx !== undefined;
        const srcIdx = hasVideo ? inputIdx : blackInputIdx;
        const isMirrored = mirrorCameras && ['back', 'left_repeater', 'right_repeater'].includes(camera);

        // Use minterpolate for smoother frame rate conversion to avoid pulsing
        // fps filter can cause frame drops/duplicates, minterpolate is smoother
        // Normalize timestamps, convert frame rate, mirror if needed, scale to target size
        let chain = `[${srcIdx}:v]setpts=PTS-STARTPTS`;
        chain += `,fps=${FPS}:round=near`; // Smooth frame rate conversion
        if (hasVideo && isMirrored) chain += ',hflip';
        chain += `,scale=${w}:${h}:force_original_aspect_ratio=disable:flags=lanczos,setsar=1[v${i}]`;

        filters.push(chain);
        gridStreams.push({ camera, tag: `[v${i}]` });
        streamTags.push(`[v${i}]`);
      }

      // Apply blur zones to individual camera streams BEFORE grid composition (grid layout)
      const blurResult = await applyBlurZonesToStreams({
        blurZones, blurType, streams: gridStreams, streamTags,
        cameraW: w + (w % 2), cameraH: h + (h % 2),
        filters, cmd, tempFiles, inputCount: inputs.length,
        extraOffset: 0, exportId, FPS
      });
      if (blurResult) blurFailed = true;

      const numStreams = activeCamerasForGrid.length;
      if (numStreams > 1) {
        const layout = [];
        for (let i = 0; i < numStreams; i++) {
          layout.push(`${(i % cols) * w}_${Math.floor(i / cols) * h}`);
        }
        filters.push(`${streamTags.join('')}xstack=inputs=${numStreams}:layout=${layout.join('|')}:fill=black[grid]`);
      } else {
        filters.push(`${streamTags[0]}copy[grid]`);
      }
    }

    // Determine if GPU encoding can be used
    // H.264 GPU encoders: 4096px limit, HEVC GPU encoders: 8192px limit
    const h264MaxRes = 4096;
    const hevcMaxRes = 8192;

    // Check HEVC encoder for high resolutions (Maximum quality often exceeds H.264 limits)
    const hevcGpu = detectHEVCEncoder(ffmpegPath);

    // Determine best encoder: prefer H.264 GPU, fall back to HEVC GPU for high res, then CPU
    let useGpu = false;
    let useHEVC = false;
    let activeEncoder = null;

    if (!mobileExport && gpu) {
      if (totalW <= h264MaxRes && totalH <= h264MaxRes) {
        // Resolution within H.264 GPU limits - use H.264 GPU
        useGpu = true;
        activeEncoder = gpu;
      } else if (hevcGpu && totalW <= hevcMaxRes && totalH <= hevcMaxRes) {
        // Resolution exceeds H.264 but within HEVC limits - use HEVC GPU
        useGpu = true;
        useHEVC = true;
        activeEncoder = hevcGpu;
        console.log(`[GPU] Resolution ${totalW}×${totalH} exceeds H.264 limit, using HEVC encoder`);
      }
    }

    let currentStreamTag = '[grid]'; // Track the current stream tag for chaining filters

    // Tesla Mobile: pad the canvas for date bar (always top) + dashboard bar (top or bottom)
    if (teslaMobileDashHeight > 0) {
      const totalPad = teslaMobileDashHeight + teslaMobileDateHeight;
      if (teslaMobileIsTop) {
        // Both bars at top: [Date][Dashboard][Video] — video shifts down by totalPad
        filters.push(`${currentStreamTag}pad=iw:ih+${totalPad}:0:${totalPad}:color=0x1A1A1A[padded]`);
      } else {
        // Date at top, dashboard at bottom: [Date][Video][Dashboard] — video shifts down by dateHeight
        filters.push(`${currentStreamTag}pad=iw:ih+${totalPad}:0:${teslaMobileDateHeight}:color=0x1A1A1A[padded]`);
      }
      currentStreamTag = '[padded]';
      console.log(`[TESLA-MOBILE] Padded canvas by ${totalPad}px (date:${teslaMobileDateHeight} + dash:${teslaMobileDashHeight}), dashboard at ${teslaMobileIsTop ? 'top' : 'bottom'}`);
    }

    // Add dashboard or timestamp overlay if enabled, otherwise ensure proper pixel format
    const padding = 20; // Padding from edges
    const positionExprs = {
      'bottom-center': `(W-w)/2:H-h-${padding}`,
      'bottom-left': `${padding}:H-h-${padding}`,
      'bottom-right': `W-w-${padding}:H-h-${padding}`,
      'top-center': `(W-w)/2:${padding}`,
      'top-left': `${padding}:${padding}`,
      'top-right': `W-w-${padding}:${padding}`
    };

    // Minimap position expressions (corner positions only)
    const minimapPosExprs = {
      'top-left': `${padding}:${padding}`,
      'top-right': `W-w-${padding}:${padding}`,
      'bottom-left': `${padding}:H-h-${padding}`,
      'bottom-right': `W-w-${padding}:H-h-${padding}`
    };

    // Add Leaflet minimap video as input if enabled (Leaflet mode only)
    let minimapInputIdx = -1;
    if (useLeafletMinimap && minimapTempPath) {
      minimapInputIdx = cmd.filter(arg => arg === '-i').length;
      cmd.push('-stream_loop', '-1', '-i', minimapTempPath);
      console.log(`[MINIMAP] Added Leaflet minimap input at index ${minimapInputIdx}: ${minimapTempPath}`);
    }

    // Build overlay pipeline based on enabled features
    // Order: Base video -> Dashboard ASS -> Minimap ASS -> Leaflet Minimap overlay

    if (useAssDashboard && assTempPath) {
      // ASS SUBTITLE DASHBOARD (compact style) - High-speed GPU-accelerated rendering
      // The ASS filter burns subtitles directly into the video at GPU encoder speed
      // This is MUCH faster than BrowserWindow capture loop (30min -> 3-5min)
      // Escape Windows path for FFmpeg (colons and backslashes need escaping)
      const escapedAssPath = assTempPath
        .replace(/\\/g, '/')           // Convert backslashes to forward slashes
        .replace(/:/g, '\\:');         // Escape colons (Windows drive letters)

      if (useAssMinimap && minimapAssTempPath) {
        // Dashboard ASS + Minimap ASS: Chain both ASS filters
        const escapedMinimapAssPath = minimapAssTempPath
          .replace(/\\/g, '/')
          .replace(/:/g, '\\:');
        filters.push(`${currentStreamTag}ass='${escapedAssPath}',ass='${escapedMinimapAssPath}'[out]`);
        console.log(`[ASS] Dashboard + ASS Minimap overlay`);
      } else if (useLeafletMinimap && minimapInputIdx >= 0 && dashboardStyle === 'tesla-screen-dash') {
        // Tesla Screen Dash: minimap flush against the corner (no gap), so
        // the map butts right up to the edge of the frame the way the Tesla
        // in-car display does.
        const tsdPos = minimapPosition === 'top-left' ? '0:0'
          : minimapPosition === 'bottom-left' ? '0:H-h'
          : minimapPosition === 'bottom-right' ? 'W-w:H-h'
          : 'W-w:0';
        filters.push(`${currentStreamTag}ass='${escapedAssPath}'[with_dash]`);
        filters.push(`[with_dash][${minimapInputIdx}:v]overlay=${tsdPos}:format=auto[out]`);
        console.log(`[ASS+MINIMAP] Tesla Screen Dash flush-corner overlay`);
      } else if (useLeafletMinimap && minimapInputIdx >= 0) {
        // Dashboard ASS + Leaflet Minimap video overlay
        const mapPos = minimapPosExprs[minimapPosition] || minimapPosExprs['top-right'];
        filters.push(`${currentStreamTag}ass='${escapedAssPath}'[with_dash]`);
        filters.push(`[with_dash][${minimapInputIdx}:v]overlay=${mapPos}:format=auto[out]`);
        console.log(`[ASS+MINIMAP] Dashboard + Leaflet Minimap overlay at ${minimapPosition}`);
      } else {
        // Dashboard only
        filters.push(`${currentStreamTag}ass='${escapedAssPath}'[out]`);
        console.log(`[ASS] Using ASS subtitle filter for compact dashboard: ${assTempPath}`);
      }
    } else if (useAssMinimap && minimapAssTempPath) {
      // ASS Minimap only (no dashboard)
      const escapedMinimapAssPath = minimapAssTempPath
        .replace(/\\/g, '/')
        .replace(/:/g, '\\:');
      filters.push(`${currentStreamTag}ass='${escapedMinimapAssPath}'[out]`);
      console.log(`[ASS] Using ASS minimap filter: ${minimapAssTempPath}`);
    } else if (useLeafletMinimap && minimapInputIdx >= 0) {
      // Leaflet Minimap only (no dashboard)
      const mapPos = minimapPosExprs[minimapPosition] || minimapPosExprs['top-right'];
      filters.push(`${currentStreamTag}[${minimapInputIdx}:v]overlay=${mapPos}:format=auto[out]`);
      console.log(`[MINIMAP] Leaflet Minimap overlay at ${minimapPosition}`);
    } else if (useTimestamp && timestampBasetimeUs) {
      // Timestamp-only overlay using FFmpeg drawtext filter (simpler, smaller like old version)
      // Position expressions for drawtext (x/y coordinates)
      const drawtextPositions = {
        'bottom-center': `x=(w-text_w)/2:y=h-th-${padding}`,
        'bottom-left': `x=${padding}:y=h-th-${padding}`,
        'bottom-right': `x=w-text_w-${padding}:y=h-th-${padding}`,
        'top-center': `x=(w-text_w)/2:y=${padding}`,
        'top-left': `x=${padding}:y=${padding}`,
        'top-right': `x=w-text_w-${padding}:y=${padding}`
      };
      const drawtextPos = drawtextPositions[timestampPosition] || drawtextPositions['bottom-center'];

      // Date format strings for strftime
      const dateFormats = {
        'mdy': '%m/%d/%Y',  // US: MM/DD/YYYY
        'dmy': '%d/%m/%Y',  // International: DD/MM/YYYY
        'ymd': '%Y-%m-%d'   // ISO: YYYY-MM-DD
      };
      const dateFormat = dateFormats[timestampDateFormat] || dateFormats['mdy'];
      // Time format: 12h uses %I (12-hour) with %p (AM/PM), 24h uses %H (24-hour)
      const timeFormat = timestampTimeFormat === '24h' ? '%H\\:%M\\:%S' : '%I\\:%M\\:%S %p';
      const timestampText = `${dateFormat} ${timeFormat}`;

      // Build drawtext filter with timestamp (similar to old version)
      const drawtextFilter = [
        "drawtext=font='Arial'",
        'expansion=strftime',
        `basetime=${timestampBasetimeUs}`,
        `text='${timestampText}'`,
        'fontcolor=white',
        'fontsize=36',
        'box=1',
        'boxcolor=black@0.4',
        'boxborderw=5',
        drawtextPos
      ].join(':');

      filters.push(`${currentStreamTag}${drawtextFilter}[out]`);
      console.log(`[TIMESTAMP] Using drawtext filter at position: ${timestampPosition}, format: ${timestampDateFormat}`);
    } else {
      filters.push(`${currentStreamTag}format=yuv420p[out]`);
    }

    // Time-lapse: drop frames then reset timestamps (instead of just speeding up PTS)
    // Using setpts alone keeps all frames but shifts timestamps, causing the encoder to see
    // massive inter-frame differences that destroy compression quality.
    // Selecting every Nth frame first means the encoder only processes frames it needs,
    // so motion estimation works properly and compression stays clean at any quality level.
    if (enableTimelapse && timelapseSpeed !== 1) {
      const lastIdx = filters.length - 1;
      filters[lastIdx] = filters[lastIdx].replace('[out]', '[pre_tl]');
      if (timelapseSpeed < 1) {
        // Slow-motion: just adjust timestamps (no frames to drop)
        filters.push(`[pre_tl]setpts=PTS/${timelapseSpeed}[out]`);
      } else {
        // Speed-up: select every Nth frame, then reset timestamps to output fps
        const nth = Math.round(timelapseSpeed);
        filters.push(`[pre_tl]select='not(mod(n\\,${nth}))',setpts=N/${FPS}/TB[out]`);
      }
      console.log(`[TIMELAPSE] Applied ${timelapseSpeed}x speed-up filter (frame selection)`);
    }

    // Encoder input normalization:
    //  - ASS-overlay branches don't end in a format= step, so force yuv420p for consistency
    //    with the non-ASS path. Helps QSV/HEVC encoders that are strict about input format.
    //  - HEVC QSV on Intel Gen 9.5 (UHD 620, etc.) fails to open the encoder with "Invalid
    //    argument" when width/height aren't 16-aligned. Pad the canvas to the next multiple
    //    of 16 for all GPU encoders — the extra pixels (at most 15 per axis) are imperceptible.
    {
      const lastIdx = filters.length - 1;
      filters[lastIdx] = filters[lastIdx].replace('[out]', '[pre_norm]');
      const padExpr = useGpu ? ',pad=ceil(iw/16)*16:ceil(ih/16)*16:0:0:color=0x1A1A1A' : '';
      filters.push(`[pre_norm]format=yuv420p${padExpr}[out]`);
    }

    // VAAPI (Linux AMD/Intel): append hwupload to the final filter and declare the
    // hardware device globally so ffmpeg can upload to the GPU. Only wire this up
    // if the render node actually exists — otherwise fall through to the software path.
    const isVaapi = useGpu && activeEncoder?.codec?.includes('vaapi');
    if (isVaapi) {
      const vaapiDev = findVaapiDevice();
      if (vaapiDev) {
        const lastIdx = filters.length - 1;
        filters[lastIdx] = filters[lastIdx].replace(/\[out\]$/, ',format=nv12,hwupload[out]');
        cmd.splice(2, 0, '-vaapi_device', vaapiDev);
      }
    }

    cmd.push('-filter_complex', filters.join(';'));
    cmd.push('-map', '[out]');

    // Time-lapse: remove audio (modified-speed audio is noise)
    if (enableTimelapse && timelapseSpeed !== 1) {
      cmd.push('-an');
    }

    // Encoder + output args are built via this helper so we can rebuild them with a
    // forced CPU path if the GPU encoder fails to initialize (e.g. hevc_qsv rejecting
    // certain resolutions on Intel Gen 9.5). See the retry branch in the spawn block below.
    const outputDurationSec = (enableTimelapse && timelapseSpeed !== 1) ? durationSec / timelapseSpeed : durationSec;
    const buildEncoderAndOutputArgs = (forceCpu) => {
      const args = [];
      const useGpuNow = !forceCpu && useGpu && activeEncoder;
      const enc = useGpuNow ? activeEncoder : null;

      if (useGpuNow) {
        args.push('-c:v', enc.codec);

        if (enc.codec === 'h264_nvenc' || enc.codec === 'hevc_nvenc') {
          // NVIDIA NVENC: CQP mode prevents quality pulsing/glitches
          const cq = Math.max(0, Math.min(51, crf));
          args.push('-preset', 'p4', '-rc', 'constqp', '-qp', cq.toString());
          args.push('-g', (FPS * 2).toString()); // Keyframe every 2 seconds
          args.push('-forced-idr', '1');
        } else if (enc.codec === 'h264_amf' || enc.codec === 'hevc_amf') {
          // AMD AMF: CQP mode with quality preset based on CRF
          let quality = 'quality';
          if (crf >= 28) quality = 'speed';
          else if (crf >= 24) quality = 'balanced';

          args.push('-quality', quality);
          args.push('-rc', 'cqp');
          args.push('-qp_i', Math.max(18, Math.min(46, crf)).toString());
          args.push('-qp_p', Math.max(18, Math.min(46, crf + 2)).toString());
          args.push('-qp_b', Math.max(18, Math.min(46, crf + 4)).toString());
          args.push('-g', (FPS * 2).toString());
        } else if (enc.codec === 'h264_videotoolbox' || enc.codec === 'hevc_videotoolbox') {
          // Apple VideoToolbox: Use bitrate mode for better compatibility
          const baseBitrate = 8000;
          const bitrateMultiplier = Math.max(0.3, 1 - (crf - 18) * 0.03);
          const targetBitrate = Math.round(baseBitrate * bitrateMultiplier);
          args.push('-b:v', `${targetBitrate}k`);
          args.push('-maxrate', `${Math.round(targetBitrate * 1.5)}k`);
          args.push('-bufsize', `${targetBitrate * 2}k`);
          args.push('-allow_sw', '1');
          args.push('-realtime', '0');
          args.push('-g', (FPS * 2).toString());
        } else if (enc.codec === 'h264_qsv' || enc.codec === 'hevc_qsv') {
          // Intel QuickSync: CQP mode
          const qsvQp = Math.max(18, Math.min(46, crf));
          args.push('-preset', 'medium');
          args.push('-global_quality', qsvQp.toString());
          args.push('-g', (FPS * 2).toString());
        } else if (enc.codec === 'h264_vaapi' || enc.codec === 'hevc_vaapi') {
          // VAAPI (Linux AMD/Intel): constant-QP rate control
          const vaapiQp = Math.max(18, Math.min(46, crf));
          args.push('-rc_mode', 'CQP');
          args.push('-qp', vaapiQp.toString());
          args.push('-g', (FPS * 2).toString());
        } else {
          console.log(`[WARN] Using generic settings for unknown GPU encoder: ${enc.codec}`);
          args.push('-preset', 'fast', '-crf', crf.toString());
          args.push('-g', (FPS * 2).toString());
        }
        console.log(`[GPU] Using GPU encoder: ${enc.name}`);
      } else {
        if (forceCpu && useGpu) {
          console.log('[ENCODER] Falling back to CPU encoder after GPU encoder init failure');
        } else if (gpu && (totalW > h264MaxRes || totalH > h264MaxRes)) {
          console.log(`[WARN] Resolution ${totalW}×${totalH} exceeds GPU limits, using CPU encoder`);
        }
        const maxThreads = Math.min(4, Math.floor(os.cpus().length / 2));
        args.push('-c:v', 'libx264', '-preset', mobileExport ? 'faster' : 'fast', '-crf', crf.toString());
        args.push('-threads', maxThreads.toString());
        args.push('-x264-params', `threads=${maxThreads}:thread-input=1:thread-lookahead=2`);
      }

      args.push('-t', outputDurationSec.toString());
      args.push('-movflags', '+faststart');

      // VideoToolbox handles pixel format internally; VAAPI uses nv12 via the
      // hwupload filter chain, so neither wants an explicit -pix_fmt.
      const isVideoToolbox = enc?.codec?.includes('videotoolbox');
      const isVaapiEnc = enc?.codec?.includes('vaapi');
      if (!isVideoToolbox && !isVaapiEnc) {
        args.push('-pix_fmt', 'yuv420p');
      }

      // GPU encoders: use constant frame rate to prevent frame drops.
      if (useGpuNow) {
        args.push('-vsync', 'cfr');
      }
      args.push('-r', FPS.toString());
      args.push('-max_muxing_queue_size', '1024');
      args.push(outputPath);

      return args;
    };

    // Record the index where encoder+output args begin so we can splice them out on retry.
    const encoderTailStart = cmd.length;
    cmd.push(...buildEncoderAndOutputArgs(false));

    console.log('[FFMPEG] FFmpeg:', cmd.slice(0, 20).join(' ') + '...');

    // Final cancellation check before spawning FFmpeg
    if (cancelledExports.has(exportId)) {
      console.log('Export cancelled before spawning FFmpeg process');
      throw new Error('Export cancelled');
    }

    sendProgress(8, useGpu ? { key: 'ui.export.exportingWithEncoder', params: { encoder: activeEncoder.name } } : { key: 'ui.export.exportingWithCpu' });

    // Execute FFmpeg - no pipe needed since dashboard is pre-rendered to file
    return new Promise((resolve, reject) => {
      let retriedWithCpu = false;

      const startProc = () => {
        const proc = spawn(cmd[0], cmd.slice(1), {
          stdio: ['pipe', 'pipe', 'pipe']
        });

        // Limit stderr buffer to prevent excessive RAM usage (keep only last 100KB)
        let stderr = '', lastPct = 0;
        const MAX_STDERR_SIZE = 100 * 1024;

        proc.stderr.on('data', (data) => {
          const dataStr = data.toString();
          stderr += dataStr;
          if (stderr.length > MAX_STDERR_SIZE) {
            stderr = stderr.slice(-MAX_STDERR_SIZE);
          }
          const match = dataStr.match(/time=(\d+):(\d+):(\d+)\.(\d+)/);
          if (match && outputDurationSec > 0) {
            const sec = +match[1] * 3600 + +match[2] * 60 + +match[3] + +match[4] / 100;
            const pctRaw = Math.min(95, (sec / outputDurationSec) * 100);
            const pct = Math.round(pctRaw * 10) / 10;
            const displayPct = Math.floor(pctRaw);
            if (pct > lastPct) {
              lastPct = pct;
              sendProgress(pct, { key: 'ui.export.exportingPercent', params: { percent: displayPct } });
            }
          }
        });

        proc.on('close', (code) => {
          if (code === 0) {
            delete activeExports[exportId];
            cancelledExports.delete(exportId);
            cleanup();

            const exportDurationMs = Date.now() - exportStartTime;
            const formattedDuration = formatExportDuration(exportDurationMs);

            console.log(`[EXPORT] ✅ Export completed in ${formattedDuration}`);

            const sizeMB = (fs.statSync(outputPath).size / 1048576).toFixed(1);
            const warning = blurFailed ? { key: 'ui.export.blurZoneFailed' } : null;
            sendComplete(true, { key: 'ui.export.exportCompleteMB', params: { size: sizeMB } }, warning);
            resolve(true);
            delete activeExportPaths[exportId];
            return;
          }

          console.error('FFmpeg error:', stderr.slice(-500));
          const errLower = stderr.toLowerCase();
          const isEncoderInitFailure =
            errLower.includes('could not open encoder') ||
            (errLower.includes('invalid argument') && /\b(qsv|nvenc|amf|videotoolbox|vost#)\b/.test(errLower));

          // Silent retry with CPU encoder when a GPU encoder refuses to initialize —
          // lets Max-quality exports succeed on hardware that can't handle the resolution
          // (e.g. HEVC QSV on Intel Gen 9.5 with non-16-aligned dimensions).
          // Skip for VAAPI: the filter chain already contains `hwupload` and cmd has
          // `-vaapi_device` baked in, so a naive libx264 retry would error on the
          // hwupload filter. We fail loudly instead and let the user pick a CPU export.
          if (isEncoderInitFailure && !retriedWithCpu && useGpu && !isVaapi && !cancelledExports.has(exportId)) {
            retriedWithCpu = true;
            console.log('[EXPORT] GPU encoder failed to initialize; retrying with CPU encoder');
            // Keep temp files (ASS subtitle etc.) — don't cleanup. Just rebuild cmd tail.
            cmd.length = encoderTailStart;
            cmd.push(...buildEncoderAndOutputArgs(true));
            // Scrub the partial output so the retry starts clean.
            try { fs.unlinkSync(outputPath); } catch { }
            delete activeExports[exportId];
            sendProgress(8, { key: 'ui.export.exportingWithCpu' });
            startProc();
            return;
          }

          delete activeExports[exportId];
          cancelledExports.delete(exportId);
          cleanup();

          if (errLower.includes('no space left on device')) {
            sendComplete(false, { key: 'ui.export.exportFailedNoSpace' });
          } else if (errLower.includes('permission denied')) {
            sendComplete(false, { key: 'ui.export.exportFailedPermission' });
          } else if (errLower.includes('no such file or directory')) {
            sendComplete(false, { key: 'ui.export.exportFailedPathNotFound' });
          } else if (errLower.includes('read-only file system')) {
            sendComplete(false, { key: 'ui.export.exportFailedReadOnly' });
          } else if (isEncoderInitFailure) {
            sendComplete(false, { key: 'ui.export.exportFailedGpuEncoderInit' });
          } else if (errLower.includes('invalid argument') && (errLower.includes('error opening output file') || errLower.includes('no such file') || errLower.includes('filename'))) {
            sendComplete(false, { key: 'ui.export.exportFailedInvalidPath' });
          } else if (errLower.includes('openencodesessionex failed') || errLower.includes('out of memory') || errLower.includes('cannot allocate memory')) {
            sendComplete(false, { key: 'ui.export.exportFailedGpuMemory' });
          } else if (errLower.includes('no nvenc capable devices found') || errLower.includes('cannot load nvenc')) {
            sendComplete(false, { key: 'ui.export.exportFailedGpuUnavailable' });
          } else if (errLower.includes('broken pipe') || errLower.includes('connection reset')) {
            sendComplete(false, { key: 'ui.export.exportFailedSourceLost' });
          } else {
            sendComplete(false, { key: 'ui.export.exportFailedCode', params: { code: code } });
          }
          const err = new Error(`Export failed with code ${code}`);
          err._completeSent = true;
          reject(err);
          try { fs.unlinkSync(outputPath); } catch { }
          delete activeExportPaths[exportId];
        });

        proc.on('error', (err) => {
          cleanup();
          cancelledExports.delete(exportId);
          sendComplete(false, `FFmpeg error: ${err.message}`);
          err._completeSent = true;
          reject(err);
        });

        activeExports[exportId] = proc;
        activeExportPaths[exportId] = outputPath;

        if (cancelledExports.has(exportId)) {
          console.log('Export cancelled immediately after spawning FFmpeg, killing process');
          proc.kill('SIGTERM');
          delete activeExports[exportId];
          cancelledExports.delete(exportId);
          reject(new Error('Export cancelled'));
          try { fs.unlinkSync(outputPath); } catch { }
          delete activeExportPaths[exportId];
          return;
        }
      };

      startProc();
    });

  } catch (error) {
    console.error('Export error:', error);
    cancelledExports.delete(exportId); // Clean up cancellation flag
    cleanup();
    throw error;
  }
}

app.whenReady().then(async () => {
  // Check for new packages after update (dev mode only)
  // This runs before window creation to ensure packages are installed
  const packageResult = await checkAndInstallPackages();

  if (packageResult.installed && packageResult.count > 0) {
    // New packages were installed - show dialog and ask to restart
    const response = await dialog.showMessageBox({
      type: 'info',
      title: 'New Packages Installed',
      message: `The update installed ${packageResult.count} new package(s).`,
      detail: 'Please restart the application with "npm start" for the changes to take effect.',
      buttons: ['Exit Now', 'Continue Anyway'],
      defaultId: 0,
      cancelId: 1
    });

    if (response.response === 0) {
      // User chose to exit
      app.quit();
      return;
    }
  }

  createWindow();

  // Pre-cache FFmpeg path in background after window is ready.
  // This eliminates the UI freeze on macOS when opening the export modal,
  // since findFFmpegPath uses spawnSync which blocks the main thread.
  setTimeout(() => preCacheFFmpegPath(), 2000);

  // Set up electron-updater event handlers (extracted to src/main/autoUpdate.js)
  setupAutoUpdaterEvents(mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Clean up all active FFmpeg processes before quitting
// This prevents orphaned processes that can block the Windows installer
app.on('before-quit', () => {
  console.log('[APP] before-quit: cleaning up active exports...');
  const exportIds = Object.keys(activeExports);
  if (exportIds.length > 0) {
    console.log(`[APP] Killing ${exportIds.length} active FFmpeg process(es)`);
    for (const exportId of exportIds) {
      const proc = activeExports[exportId];
      if (proc && !proc.killed) {
        try {
          // Use SIGKILL on Windows for immediate termination
          proc.kill('SIGKILL');
          console.log(`[APP] Killed export process: ${exportId}`);
        } catch (err) {
          console.error(`[APP] Failed to kill export ${exportId}:`, err.message);
        }
      }
      delete activeExports[exportId];
    }
  }
  cancelledExports.clear();
});

ipcMain.handle('dialog:openFolder', async (_event, startPath) => {
  const opts = { properties: ['openDirectory'] };
  if (startPath) opts.defaultPath = startPath;
  const result = await dialog.showOpenDialog(opts);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('dialog:openFile', async (_event, filters) => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: filters || [{ name: 'JSON Files', extensions: ['json'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// Settings module (extracted to src/main/settings.js)
registerSettingsIpc();

/**
 * Check if npm packages need to be installed after an update (dev mode only)
 * @returns {Promise<{needed: boolean, installed: boolean, error?: string}>}
 */
async function checkAndInstallPackages() {
  // Only run for dev mode (npm start users)
  if (app.isPackaged) {
    return { needed: false, installed: false };
  }

  try {
    const settings = loadSettings();
    const versionPath = path.join(__dirname, '..', 'version.json');

    // Read current version
    let currentVersion = '0.0.0';
    if (fs.existsSync(versionPath)) {
      try {
        const versionData = JSON.parse(fs.readFileSync(versionPath, 'utf-8'));
        currentVersion = versionData.version || '0.0.0';
      } catch (e) {
        console.log('[STARTUP] Could not read version.json');
      }
    }

    const lastRunVersion = settings.lastRunVersion || '0.0.0';

    // If version hasn't changed, no need to check
    if (currentVersion === lastRunVersion) {
      return { needed: false, installed: false };
    }

    console.log(`[STARTUP] Version changed from ${lastRunVersion} to ${currentVersion}, checking for new packages...`);

    // Run npm install and capture output
    const projectRoot = path.join(__dirname, '..');
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

    const result = spawnSync(npmCmd, ['install'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 120000, // 2 minute timeout
      shell: true
    });

    if (result.error) {
      console.error('[STARTUP] npm install error:', result.error);
      // Still update version so we don't keep trying
      settings.lastRunVersion = currentVersion;
      saveSettings(settings);
      return { needed: true, installed: false, error: result.error.message };
    }

    const output = (result.stdout || '') + (result.stderr || '');

    // Check if new packages were actually installed
    // npm install outputs "added X packages" when new packages are installed
    const addedMatch = output.match(/added (\d+) package/i);
    const packagesAdded = addedMatch ? parseInt(addedMatch[1], 10) : 0;

    // Update last run version
    settings.lastRunVersion = currentVersion;
    saveSettings(settings);

    if (packagesAdded > 0) {
      console.log(`[STARTUP] Installed ${packagesAdded} new package(s)`);
      return { needed: true, installed: true, count: packagesAdded };
    }

    console.log('[STARTUP] No new packages needed');
    return { needed: true, installed: false };

  } catch (err) {
    console.error('[STARTUP] Package check error:', err);
    return { needed: false, installed: false, error: err.message };
  }
}

ipcMain.handle('shell:openExternal', async (_event, url) => {
  await shell.openExternal(url);
});

// Export IPC Handlers
ipcMain.handle('dialog:saveFile', async (_event, options) => {
  const result = await dialog.showSaveDialog({
    title: options?.title || 'Save Export',
    defaultPath: options?.defaultPath || `tesla_export_${new Date().toISOString().slice(0, 10)}.mp4`,
    filters: options?.filters || [
      { name: 'Video Files', extensions: ['mp4'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled) return null;
  return result.filePath;
});

ipcMain.handle('export:start', async (event, exportId, exportData) => {
  console.log('[EXPORT] Starting export:', exportId);

  // Check if already cancelled before starting
  if (cancelledExports.has(exportId)) {
    console.log('Export cancelled before starting:', exportId);
    cancelledExports.delete(exportId);
    event.sender.send('export:progress', exportId, {
      type: 'complete',
      success: false,
      message: { key: 'ui.notifications.exportCancelled' }
    });
    return false;
  }

  try {
    const ffmpegPath = findFFmpegPath();
    if (!ffmpegPath) {
      throw new Error('FFmpeg not found. Please install FFmpeg or place it in the ffmpeg_bin directory.');
    }

    const result = await performVideoExport(event, exportId, exportData, ffmpegPath);
    return result;
  } catch (error) {
    console.error('Export failed:', error);
    cancelledExports.delete(exportId); // Clean up cancellation flag
    // Only send complete if performVideoExport didn't already send one via sendComplete
    // (FFmpeg close handler sends translated errors before rejecting)
    if (!error._completeSent) {
      event.sender.send('export:progress', exportId, {
        type: 'complete',
        success: false,
        message: `Export failed: ${error.message}`
      });
    }
    return false;
  }
});

ipcMain.handle('export:cancel', async (_event, exportId) => {
  // Mark as cancelled immediately so dashboard rendering loop can check it
  cancelledExports.add(exportId);

  const proc = activeExports[exportId];
  if (proc) {
    proc.kill('SIGTERM');
    delete activeExports[exportId];
    cancelledExports.delete(exportId); // Clean up immediately after killing
    // Delete partial output file after ffmpeg releases the handle
    const outputPath = activeExportPaths[exportId];
    if (outputPath) {
      setTimeout(() => {
        try { fs.unlinkSync(outputPath); } catch { }
      }, 500);
      delete activeExportPaths[exportId];
    }
    return true;
  }
  // Even if process not found, mark as cancelled so it won't start
  return true;
});

// ============================================
// CLIP SHARING - Upload export to Sentry Studio server
// ============================================
const CLIP_UPLOAD_URL = 'https://api.sentry-six.com/share/upload';
const CLIP_DELETE_URL = 'https://api.sentry-six.com/share/delete';
const CLIP_CONFIG_URL = 'https://api.sentry-six.com/share/config';

let _shareConfigCache = null;

ipcMain.handle('share:getConfig', async () => {
  if (_shareConfigCache) return _shareConfigCache;
  try {
    const urlObj = new URL(CLIP_CONFIG_URL);
    const httpModule = urlObj.protocol === 'https:' ? require('https') : require('http');
    const result = await new Promise((resolve, reject) => {
      const req = httpModule.request({
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname,
        method: 'GET',
        family: 0
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(5000, () => { req.destroy(); resolve(null); });
      req.end();
    });
    if (result && result.expirationHours) {
      _shareConfigCache = {
        expirationHours: result.expirationHours,
        minExpirationHours: result.minExpirationHours || 0.5,
        maxExpirationHours: result.maxExpirationHours || 168
      };
      return _shareConfigCache;
    }
  } catch (err) {
    console.warn('[SHARE] Failed to fetch config:', err.message);
  }
  return { expirationHours: 72, minExpirationHours: 0.5, maxExpirationHours: 168 };
});

const CLIP_RESERVE_URL = 'https://api.sentry-six.com/share/reserve';

ipcMain.handle('share:reserve', async (event, expirationHours) => {
  console.log('[SHARE] Reserving share code...');
  try {
    const urlObj = new URL(CLIP_RESERVE_URL);
    const httpModule = urlObj.protocol === 'https:' ? require('https') : require('http');
    const payload = JSON.stringify({ expirationHours: expirationHours || 72 });

    const result = await new Promise((resolve, reject) => {
      const req = httpModule.request({
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        family: 0
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (res.statusCode === 200 && data.success) {
              resolve(data);
            } else {
              reject(new Error(data.error || `Reserve failed (HTTP ${res.statusCode})`));
            }
          } catch {
            reject(new Error('Invalid server response'));
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Reserve request timed out')); });
      req.write(payload);
      req.end();
    });

    console.log(`[SHARE] Reserved code: ${result.code} → ${result.url}`);
    return result;
  } catch (err) {
    console.error('[SHARE] Reserve error:', err.message);
    throw err;
  }
});

ipcMain.handle('share:upload', async (event, filePath, options) => {
  const reserveCode = options?.reserveCode;
  const expirationHours = options?.expirationHours;
  console.log('[SHARE] Starting clip upload:', filePath, reserveCode ? `(reserved: ${reserveCode})` : '');

  try {
    if (!fs.existsSync(filePath)) {
      throw new Error('Export file not found');
    }

    const stat = fs.statSync(filePath);
    const totalBytes = stat.size;

    // Generate delete token client-side
    const deleteToken = crypto.randomBytes(24).toString('hex');

    // Build multipart form data manually to stream the file with progress tracking
    const boundary = `----SentrySixUpload${Date.now()}${Math.random().toString(36).slice(2)}`;
    const fileName = path.basename(filePath);

    // Form data fields: deleteToken + optional reserveCode + optional expirationHours + video file
    let formFieldsPart = `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="deleteToken"\r\n\r\n` +
      `${deleteToken}\r\n`;

    if (reserveCode) {
      formFieldsPart += `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="reserveCode"\r\n\r\n` +
        `${reserveCode}\r\n`;
    }

    if (expirationHours) {
      formFieldsPart += `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="expirationHours"\r\n\r\n` +
        `${expirationHours}\r\n`;
    }

    const formFieldsBuffer = Buffer.from(formFieldsPart);
    const filePart = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="video"; filename="${fileName}"\r\n` +
      `Content-Type: video/mp4\r\n\r\n`
    );
    const footerPart = Buffer.from(`\r\n--${boundary}--\r\n`);
    const contentLength = formFieldsBuffer.length + filePart.length + totalBytes + footerPart.length;

    return new Promise((resolve, reject) => {
      const urlObj = new URL(CLIP_UPLOAD_URL);
      const httpModule = urlObj.protocol === 'https:' ? require('https') : require('http');

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': contentLength
        },
        family: 0
      };

      const req = httpModule.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(body);
            if (res.statusCode === 200 && result.success) {
              console.log(`[SHARE] Upload complete: ${result.url}`);

              // Auto-save to local shared clips list
              try {
                const settings = loadSettings();
                const sharedClips = settings.sharedClips || [];
                sharedClips.unshift({
                  code: result.code,
                  url: result.url,
                  deleteToken: result.deleteToken || deleteToken,
                  expiresAt: result.expiresAt,
                  fileSize: result.fileSize,
                  fileName,
                  uploadedAt: new Date().toISOString()
                });
                // Keep max 50 entries
                settings.sharedClips = sharedClips.slice(0, 50);
                saveSettings(settings);
              } catch (saveErr) {
                console.error('[SHARE] Failed to save clip to settings:', saveErr.message);
              }

              event.sender.send('share:progress', { type: 'complete', ...result });
              resolve(result);
            } else {
              const errorMsg = result.error || `Upload failed (HTTP ${res.statusCode})`;
              console.error('[SHARE] Upload failed:', errorMsg);
              event.sender.send('share:progress', { type: 'error', error: errorMsg });
              reject(new Error(errorMsg));
            }
          } catch (parseErr) {
            console.error('[SHARE] Response parse error:', body.slice(0, 200));
            reject(new Error('Invalid server response'));
          }
        });
      });

      req.on('error', (err) => {
        console.error('[SHARE] Upload network error:', err.message);
        event.sender.send('share:progress', { type: 'error', error: err.message });
        reject(err);
      });

      // Write form fields first, then file header
      req.write(formFieldsBuffer);
      req.write(filePart);

      // Stream file with progress tracking
      let bytesUploaded = 0;
      let lastProgressPct = 0;
      const fileStream = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 }); // 256KB chunks

      fileStream.on('data', (chunk) => {
        req.write(chunk);
        bytesUploaded += chunk.length;
        const pct = Math.floor((bytesUploaded / totalBytes) * 100);
        if (pct > lastProgressPct) {
          lastProgressPct = pct;
          event.sender.send('share:progress', {
            type: 'progress',
            percentage: pct,
            bytesUploaded,
            totalBytes
          });
        }
      });

      fileStream.on('end', () => {
        req.write(footerPart);
        req.end();
        event.sender.send('share:progress', {
          type: 'progress',
          percentage: 100,
          bytesUploaded: totalBytes,
          totalBytes
        });
      });

      fileStream.on('error', (err) => {
        console.error('[SHARE] File read error:', err.message);
        req.destroy();
        reject(err);
      });
    });

  } catch (err) {
    console.error('[SHARE] Upload error:', err.message);
    event.sender.send('share:progress', { type: 'error', error: err.message });
    throw err;
  }
});

// Get list of shared clips from local settings
ipcMain.handle('share:getClips', async () => {
  try {
    const settings = loadSettings();
    return settings.sharedClips || [];
  } catch (err) {
    console.error('[SHARE] Failed to get clips:', err.message);
    return [];
  }
});

// Sync local shared clips with server (removes clips deleted by admin or expired)
ipcMain.handle('share:syncClips', async () => {
  try {
    const settings = loadSettings();
    const clips = settings.sharedClips || [];
    if (clips.length === 0) return clips;

    const codes = clips.map(c => c.code);
    const payload = JSON.stringify({ codes });
    const urlObj = new URL('https://api.sentry-six.com/share/check-codes');
    const httpModule = urlObj.protocol === 'https:' ? require('https') : require('http');

    const result = await new Promise((resolve, reject) => {
      const req = httpModule.request({
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        family: 0
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(10000, () => { req.destroy(); resolve(null); });
      req.write(payload);
      req.end();
    });

    if (!result || !result.statuses) {
      // Server unreachable, return local clips as-is
      return clips;
    }

    // Update local clips: remove deleted ones, update expiry times
    const updatedClips = [];
    for (const clip of clips) {
      const status = result.statuses[clip.code];
      if (!status || status.deleted) {
        console.log(`[SHARE] Removing clip ${clip.code} (deleted on server)`);
        continue;
      }
      // Update expiry from server
      if (status.expiresAt) {
        clip.expiresAt = status.expiresAt;
      }
      updatedClips.push(clip);
    }

    settings.sharedClips = updatedClips;
    saveSettings(settings);
    return updatedClips;
  } catch (err) {
    console.error('[SHARE] Sync clips error:', err.message);
    const settings = loadSettings();
    return settings.sharedClips || [];
  }
});

// Delete a shared clip (sends delete request to server + removes from local settings)
ipcMain.handle('share:deleteClip', async (_event, code, deleteToken) => {
  console.log('[SHARE] Deleting clip:', code);

  try {
    const urlObj = new URL(CLIP_DELETE_URL);
    const httpModule = urlObj.protocol === 'https:' ? require('https') : require('http');
    const payload = JSON.stringify({ code, deleteToken });

    const result = await new Promise((resolve, reject) => {
      const req = httpModule.request({
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        family: 0
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode, data: JSON.parse(body) });
          } catch {
            resolve({ statusCode: res.statusCode, data: { error: 'Invalid response' } });
          }
        });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });

    // Remove from local settings regardless of server response
    try {
      const settings = loadSettings();
      settings.sharedClips = (settings.sharedClips || []).filter(c => c.code !== code);
      saveSettings(settings);
    } catch (e) { /* ignore */ }

    if (result.statusCode === 200 && result.data.success) {
      console.log(`[SHARE] Clip ${code} deleted successfully`);
      return { success: true };
    } else {
      return { success: false, error: result.data.error || 'Delete failed' };
    }

  } catch (err) {
    console.error('[SHARE] Delete error:', err.message);
    // Still remove from local settings
    try {
      const settings = loadSettings();
      settings.sharedClips = (settings.sharedClips || []).filter(c => c.code !== code);
      saveSettings(settings);
    } catch (e) { /* ignore */ }
    return { success: false, error: err.message };
  }
});

ipcMain.handle('fs:showItemInFolder', async (_event, filePath) => {
  shell.showItemInFolder(filePath);
});

// Store pending deletion for after reload
let pendingDeleteFolder = null;

ipcMain.handle('fs:deleteFolder', async (_event, folderPath) => {
  try {
    // Validate the path exists and is a directory
    if (!fs.existsSync(folderPath)) {
      return { success: false, error: 'Folder does not exist' };
    }

    const stats = fs.statSync(folderPath);
    if (!stats.isDirectory()) {
      return { success: false, error: 'Path is not a directory' };
    }

    // Try using shell.trashItem first (moves to recycle bin, works better with locked files on Windows)
    try {
      await shell.trashItem(folderPath);
      console.log('[DELETE] Successfully moved folder to trash:', folderPath);
      return { success: true };
    } catch (trashErr) {
      console.log('[DELETE] Trash failed, trying direct delete:', trashErr.message);
      // Fall back to direct delete
      fs.rmSync(folderPath, { recursive: true, force: true });
      console.log('[DELETE] Successfully deleted folder:', folderPath);
      return { success: true };
    }
  } catch (err) {
    console.error('[DELETE] Failed to delete folder:', folderPath, err);
    return { success: false, error: err.message };
  }
});

// Schedule folder deletion and reload window to release file handles
ipcMain.handle('fs:deleteFolderWithReload', async (_event, folderPath, baseFolderPath) => {
  try {
    // Validate the path exists
    if (!fs.existsSync(folderPath)) {
      return { success: false, error: 'Folder does not exist' };
    }

    const stats = fs.statSync(folderPath);
    if (!stats.isDirectory()) {
      return { success: false, error: 'Path is not a directory' };
    }

    // Store the pending deletion info
    pendingDeleteFolder = { folderPath, baseFolderPath };

    // Reload the main window to release all file handles
    if (mainWindow && !mainWindow.isDestroyed()) {
      console.log('[DELETE] Reloading window to release file handles...');
      mainWindow.webContents.reload();
      return { success: true, reloading: true };
    }

    return { success: false, error: 'Window not available' };
  } catch (err) {
    console.error('[DELETE] Failed to schedule deletion:', err);
    return { success: false, error: err.message };
  }
});

// Check for pending deletion after window reload
ipcMain.handle('fs:checkPendingDelete', async () => {
  if (!pendingDeleteFolder) {
    return { hasPending: false };
  }

  const { folderPath, baseFolderPath } = pendingDeleteFolder;
  pendingDeleteFolder = null; // Clear it

  console.log('[DELETE] Processing pending deletion after reload:', folderPath);

  try {
    // Try trash first
    try {
      await shell.trashItem(folderPath);
      console.log('[DELETE] Successfully moved folder to trash:', folderPath);
      return { hasPending: true, success: true, folderPath, baseFolderPath };
    } catch (trashErr) {
      console.log('[DELETE] Trash failed, trying direct delete:', trashErr.message);
      fs.rmSync(folderPath, { recursive: true, force: true });
      console.log('[DELETE] Successfully deleted folder:', folderPath);
      return { hasPending: true, success: true, folderPath, baseFolderPath };
    }
  } catch (err) {
    console.error('[DELETE] Failed to delete folder after reload:', folderPath, err);
    return { hasPending: true, success: false, error: err.message, folderPath };
  }
});

ipcMain.handle('ffmpeg:check', async () => {
  const ffmpegPath = findFFmpegPath();

  // Check for fake no GPU setting (developer mode)
  const settings = loadSettings();
  const fakeNoGpu = settings.devFakeNoGpu === true;

  let gpuInfo = null;
  let hevcInfo = null;

  if (ffmpegPath && !fakeNoGpu) {
    // Use cached encoder values if available (detection spawns ffmpeg subprocesses)
    // Cached values are already null on first run; detectGpuEncoder/detectHEVCEncoder cache internally
    const gpu = detectGpuEncoder(ffmpegPath);
    const hevc = detectHEVCEncoder(ffmpegPath);

    if (gpu) {
      gpuInfo = { name: gpu.name, codec: gpu.codec };
    }
    if (hevc) {
      hevcInfo = { name: hevc.name, codec: hevc.codec };
    }
  }

  return {
    available: !!ffmpegPath,
    path: ffmpegPath,
    gpu: gpuInfo,
    hevc: hevcInfo,
    fakeNoGpu: fakeNoGpu
  };
});

// Read directory contents (for folder traversal)
ipcMain.handle('fs:readDir', async (_event, dirPath) => {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries.map(entry => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
      path: path.join(dirPath, entry.name)
    }));
  } catch (err) {
    console.error('Error reading directory:', err);
    return [];
  }
});

// Check if path exists
ipcMain.handle('fs:exists', async (_event, filePath) => {
  return fs.existsSync(filePath);
});

// Get file stats
ipcMain.handle('fs:stat', async (_event, filePath) => {
  try {
    const stats = fs.statSync(filePath);
    return {
      size: stats.size,
      isDirectory: stats.isDirectory(),
      isFile: stats.isFile(),
      mtime: stats.mtime.toISOString()
    };
  } catch (err) {
    return null;
  }
});

// Read file contents (for event.json)
ipcMain.handle('fs:readFile', async (_event, filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error('Error reading file:', err);
    throw err;
  }
});

// Auto-update module (extracted to src/main/autoUpdate.js)
registerAutoUpdateIpc({
  getMainWindow: () => mainWindow,
  getUpdateBranch,
  loadSettings,
  checkUpdateWithTelemetry,
  processApiResponse
});

// Developer Settings IPC Handlers
ipcMain.handle('dev:openDevTools', async () => {
  if (mainWindow) {
    mainWindow.webContents.openDevTools();
    return { success: true };
  }
  return { success: false, error: 'No main window' };
});

ipcMain.handle('dev:resetSettings', async () => {
  try {
    if (fs.existsSync(settingsPath)) {
      fs.unlinkSync(settingsPath);
      console.log('[DEV] Settings reset - deleted:', settingsPath);
    }
    return { success: true, path: settingsPath };
  } catch (err) {
    console.error('Reset settings error:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('dev:forceLatestVersion', async () => {
  // Note: With electron-updater, version is managed by package.json
  // This just returns the current version for display purposes
  return { success: true, version: app.getVersion(), note: 'Version is managed by electron-updater' };
});

ipcMain.handle('dev:setOldVersion', async () => {
  // Note: With electron-updater, version is managed by package.json
  // This can't actually change the version - just triggers a manual update check
  console.log('[DEV] Triggering manual update check...');
  if (!autoUpdater) {
    return { success: false, error: 'electron-updater not available in dev mode' };
  }
  try {
    await autoUpdater.checkForUpdates();
    return { success: true, note: 'Manual update check triggered' };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('dev:getCurrentVersion', async () => {
  return { version: app.getVersion() };
});

ipcMain.handle('dev:getAppPaths', async () => {
  return {
    userData: app.getPath('userData'),
    settings: settingsPath,
    app: app.getAppPath(),
    temp: app.getPath('temp'),
    isPackaged: app.isPackaged
  };
});

ipcMain.handle('dev:reloadApp', async () => {
  if (mainWindow) {
    mainWindow.reload();
    return { success: true };
  }
  return { success: false, error: 'No main window' };
});


// System info IPC handler (for Settings "Learn More" section)
ipcMain.handle('system:getInfo', async () => {
  const platform = os.platform();
  let osName = platform;
  if (platform === 'win32') osName = 'Windows';
  else if (platform === 'darwin') osName = 'macOS';
  else if (platform === 'linux') osName = 'Linux';
  return {
    os: osName,
    arch: os.arch(),
    appVersion: app.getVersion()
  };
});

// Diagnostics & Support ID IPC Handlers
ipcMain.handle('diagnostics:get', async () => {
  try {
    const currentVersion = app.getVersion();

    // Check for pending update
    let pendingUpdate = null; // null = up to date, string = pending version
    try {
      const latestVersion = await getLatestVersionFromGitHub(getUpdateBranch);
      if (latestVersion && currentVersion && latestVersion.version !== currentVersion) {
        pendingUpdate = latestVersion.version; // Store the pending version
      }
    } catch { /* ignore update check errors */ }

    // Get OS name (friendly format)
    const getOSName = () => {
      const platform = os.platform();
      if (platform === 'win32') return 'Windows';
      if (platform === 'darwin') return 'macOS';
      if (platform === 'linux') {
        // Try to get distro name from /etc/os-release
        try {
          const osRelease = fs.readFileSync('/etc/os-release', 'utf-8');
          const nameMatch = osRelease.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
          if (nameMatch) return nameMatch[1];
        } catch { /* ignore */ }
        return 'Linux';
      }
      return platform;
    };

    // Check FFmpeg and GPU
    const ffmpegPath = findFFmpegPath();
    const ffmpegDetected = ffmpegPath !== null;

    // Detect GPU if not already done
    if (ffmpegDetected && getGpuEncoder() === null) {
      detectGpuEncoder(ffmpegPath);
    }

    // Detect actual GPU hardware
    const gpuHardware = detectGpuHardware();

    return {
      os: getOSName(),
      appVersion: currentVersion || 'unknown',
      pendingUpdate,
      hardware: {
        cpuModel: os.cpus()[0]?.model || 'unknown',
        ramTotal: os.totalmem(),
        ramFree: os.freemem(),
        gpuDetected: getGpuEncoder() !== null || gpuHardware !== null,
        gpuHardware: gpuHardware,  // Actual GPU name (e.g., "NVIDIA GeForce RTX 4070 Super")
        gpuEncoder: getGpuEncoder()?.name || null,  // Encoder type (e.g., "NVIDIA NVENC")
        ffmpegDetected
      },
      logs: mainLogBuffer.slice() // All main process logs
    };
  } catch (err) {
    console.error('Failed to collect diagnostics:', err);
    return { error: err.message };
  }
});


// Diagnostics storage module (extracted to src/main/diagnostics.js)
registerDiagnosticsStorageIpc(SUPPORT_SERVER_URL);

// Support chat module (extracted to src/main/supportChat.js)
registerSupportChatIpc();

