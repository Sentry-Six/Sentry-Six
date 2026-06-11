// Advanced Editor — export bridge.
//
// Builds the exportData payload for window.electronAPI.startExport. Reuses the
// same fields the simple modal uses (blur zones, SEI, etc.) but injects new
// `layoutData.layoutMode = 'advanced'` (per-camera sizing) and `overlayData`
// (normalized custom positions for timestamp / dashboard / minimap).

import { advancedEditorState, parseTileId } from './state.js';
import { filePathToUrl } from '../../lib/utils.js';
import { parseTimestampKeyToEpochMs } from '../../core/clipBrowser.js';
import { translateMessage, showExportCompletePanel, openExportModal, setSimpleModalAeMode } from '../../features/exportVideo.js';
import { notify } from '../notifications.js';

// Quality preset → reference canvas width in pixels.
// The canvas represents "3 cameras wide × 2 cameras tall" (the natural 3×2
// layout for 6-cam HW4). At each quality, per-camera target width matches the
// simple modal (mobile: 579, medium: 724, high: 1086, max: 1448 for HW4
// 1448-wide side cameras). So canvas_ref_width = 3 × per-camera-target.
//   simple modal: nativeW × {0.4, 0.5, 0.75, 1.0}
//   AE canvas:    3 × nativeW × {0.4, 0.5, 0.75, 1.0}
const QUALITY_REF_WIDTH = {
    mobile: 1740,  // 3 × 1448 × 0.4
    medium: 2172,  // 3 × 1448 × 0.5
    high:   3258,  // 3 × 1448 × 0.75
    max:    4344,  // 3 × 1448 × 1.0
};

let depsRef = null;
let closeAdvancedEditorCb = null;

// Refs to the SIMPLE export modal's progress UI — we reuse it so AE has
// the same look/UX (dashboard + minimap sub-progress bars, share/done panel).
function getSimpleModalProgressRefs() {
    return {
        modal:           document.getElementById('exportModal'),
        progressEl:      document.getElementById('exportProgress'),
        progressBar:     document.getElementById('exportProgressBar'),
        progressText:    document.getElementById('exportProgressText'),
        dashProgressEl:  document.getElementById('dashboardProgress'),
        dashProgressBar: document.getElementById('dashboardProgressBar'),
        dashProgressText:document.getElementById('dashboardProgressText'),
        miniProgressEl:  document.getElementById('minimapProgress'),
        miniProgressBar: document.getElementById('minimapProgressBar'),
        miniProgressText:document.getElementById('minimapProgressText'),
    };
}

export function initExportBridge(deps, options = {}) {
    depsRef = deps;
    closeAdvancedEditorCb = options.closeAdvancedEditor || null;
}

export async function runAdvancedExport() {
    if (!window.electronAPI?.startExport) {
        console.warn('[AE] electronAPI.startExport unavailable');
        return;
    }

    const state = depsRef?.getState?.();
    const nativeVideo = depsRef?.getNativeVideo?.();
    const exportStateRef = depsRef?.getExportState?.();
    const baseFolderPath = depsRef?.getBaseFolderPath?.();
    if (!state || !nativeVideo || !exportStateRef) {
        showError('No clip loaded.');
        return;
    }

    // A simple-modal export may already be running (the AE stays reachable
    // while one encodes) — starting another would clobber its progress
    // listener and the shared export state.
    if (exportStateRef.isExporting) {
        notify('An export is already in progress.', { type: 'warn' });
        return;
    }

    const active = state.collection?.active;
    if (!active || !active.groups?.length) {
        showError('No clip loaded.');
        return;
    }

    const settings = advancedEditorState.settings;
    const cameras = [...settings.selectedCameras];
    if (cameras.length === 0) {
        showError('Select at least one camera.');
        return;
    }

    // ----- 1. Time range from current playback window -----
    const totalSec = (nativeVideo.cumulativeStarts || []).slice(-1)[0] || 0;
    const startSec = advancedEditorState.playback.startSec || 0;
    const endSec   = advancedEditorState.playback.endSec || totalSec;
    const startTimeMs = Math.round(startSec * 1000);
    const endTimeMs   = Math.round(endSec   * 1000);

    // ----- 2. Build segment list (validated BEFORE any state registration
    // or save dialog, so a bad clip can't leave isExporting stuck true) -----
    const groups = active.groups;
    const cumStarts = nativeVideo.cumulativeStarts || [];
    const segments = [];
    for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        const durationSec = nativeVideo.segmentDurations?.[i] || 60;
        const files = {};
        for (const camera of cameras) {
            const entry = group.filesByCamera?.get(camera);
            if (!entry?.file) continue;
            if (entry.file.path) {
                files[camera] = entry.file.path;
            } else if (entry.file.webkitRelativePath && baseFolderPath) {
                const sub = entry.file.webkitRelativePath.split('/').slice(1).join('/');
                files[camera] = baseFolderPath + '/' + sub;
            }
        }
        const timestamp = parseTimestampKeyToEpochMs(group.timestampKey);
        segments.push({
            index: i,
            durationSec,
            startSec: cumStarts[i] || 0,
            files,
            groupId: group.id,
            timestamp,
        });
    }
    if (!segments.some(s => Object.keys(s.files).length > 0)) {
        showError('No video files for selected cameras in this clip.');
        return;
    }

    // ----- 3. File save dialog -----
    const lastFolder = await safeGetSetting('lastExportFolder');
    const baseName = (active.groups[0]?.timestampKey || 'export').replace(/[:\s]/g, '_');
    const defaultPath = lastFolder
        ? `${lastFolder}/${baseName}.mp4`
        : `${baseName}.mp4`;

    const outputPath = await window.electronAPI.saveFile({
        title: 'Save Advanced Editor Export',
        defaultPath,
    });
    if (!outputPath) return;
    const exportDir = outputPath.replace(/[/\\][^/\\]*$/, '');
    if (exportDir) safeSetSetting('lastExportFolder', exportDir);

    // Register this export in the shared export state so the simple modal's
    // cancel / floating-progress machinery controls AE exports too. Without
    // this, cancelExport() was a no-op for AE exports — closing the modal hid
    // all progress while ffmpeg kept encoding with no way to stop it.
    // Everything from here to startExport runs inside try/catch: any failure
    // must reset this state or all future exports stay locked out.
    const exportId = `ae_export_${Date.now()}`;
    exportStateRef.cancelled = false;
    exportStateRef.isExporting = true;
    exportStateRef.currentExportId = exportId;

    const resetExportState = () => {
        exportStateRef.isExporting = false;
        exportStateRef.currentExportId = null;
        exportStateRef.cancelled = false;
    };

    try {
        // ----- 4. SEI extraction (only if dashboard or minimap requires it) -----
        let seiData = [];
        let mapPath = [];
        if (settings.includeDashboard || settings.includeMinimap) {
            const extracted = await extractSeiAndMapPath({
                groups, cumStarts, nativeVideo,
                startTimeMs, endTimeMs,
                wantMinimap: settings.includeMinimap,
                exportStateRef,
            });
            seiData = extracted.seiData;
            mapPath = extracted.mapPath;
        }

        // User cancelled during SEI extraction — stop before spawning ffmpeg.
        if (exportStateRef.cancelled) {
            resetExportState();
            return;
        }

        // ----- 5. Build layoutData (per-camera sizing) -----
        // Match the AE canvas's CURRENT aspect ratio so the export canvas has the
        // same shape as the preview. Tiles are normalized 0-1 — if the export
        // canvas were a different aspect than the AE canvas, a tile that looks
        // close to camera-aspect in the preview would become extremely wide (or
        // tall) at export time, causing big black letterbox bars around the
        // camera content inside each tile. WYSIWYG requires the two canvases to
        // share an aspect ratio. Fall back to 16:9 only when the canvas hasn't
        // been measured.
        const quality = settings.quality || 'high';
        const refW = QUALITY_REF_WIDTH[quality] || QUALITY_REF_WIDTH.high;
        const aeW = advancedEditorState.canvas.widthPx;
        const aeH = advancedEditorState.canvas.heightPx;
        const canvasAspect = (aeW > 0 && aeH > 0) ? (aeW / aeH) : (16 / 9);
        const refH = Math.round(refW / canvasAspect);

        const cameraLayouts = {};
        for (const [id, tile] of advancedEditorState.tiles.entries()) {
            const { type, name } = parseTileId(id);
            if (type !== 'camera') continue;
            if (!cameras.includes(name)) continue;
            cameraLayouts[name] = {
                x: tile.x * refW,
                y: tile.y * refH,
                width: tile.w * refW,
                height: tile.h * refH,
            };
        }
        const layoutData = {
            layoutMode: 'advanced',
            cameras: cameraLayouts,
            canvasWidth: refW,
            canvasHeight: refH,
        };

        // ----- 6. Build overlayData (normalized 0-1) -----
        const overlayData = {};
        const tsTile = advancedEditorState.tiles.get('overlay:timestamp');
        if (settings.includeTimestamp && tsTile) {
            overlayData.timestamp = { x: tsTile.x, y: tsTile.y, w: tsTile.w, h: tsTile.h };
        }
        const dashTile = advancedEditorState.tiles.get('overlay:dashboard');
        if (settings.includeDashboard && dashTile) {
            overlayData.dashboard = { x: dashTile.x, y: dashTile.y, w: dashTile.w, h: dashTile.h };
        }
        // Tesla Mobile has a SECOND dashboard tile for the date bar. Only send
        // it when the style is tesla-mobile (every other style ignores this).
        const dateTile = advancedEditorState.tiles.get('overlay:dashboardDate');
        if (settings.includeDashboard && settings.dashboardStyle === 'tesla-mobile' && dateTile) {
            overlayData.dashboardDate = { x: dateTile.x, y: dateTile.y, w: dateTile.w, h: dateTile.h };
        }
        const miniTile = advancedEditorState.tiles.get('overlay:minimap');
        if (settings.includeMinimap && miniTile) {
            overlayData.minimap = { x: miniTile.x, y: miniTile.y, w: miniTile.w, h: miniTile.h };
        }

        // ----- 7. Assemble exportData (same shape as simple modal + extras) -----
        const exportData = {
            segments,
            startTimeMs,
            endTimeMs,
            outputPath,
            cameras,
            baseFolderPath,
            quality,
            includeDashboard: settings.includeDashboard && seiData.length > 0,
            seiData,
            layoutData,
            overlayData,
            useMetric: !!depsRef?.getUseMetric?.(),
            glassBlur: parseInt(document.documentElement.style.getPropertyValue('--glass-blur') || '7', 10),
            dashboardStyle: settings.dashboardStyle,
            dashboardPosition: 'custom',
            dashboardSize: 'custom',
            // AE-only label/value scaling applied on top of the ASS writer's
            // base font formula. Simple modal exports omit these and the writer
            // defaults them to 1 (no scaling), preserving existing behavior.
            dashboardLabelScale: settings.dashboardLabelScale,
            dashboardValueScale: settings.dashboardValueScale,
            // Tesla Mobile two-tile mode: independent scale for the date-bar
            // tile (the data bar reuses dashboardLabelScale/dashboardValueScale).
            dashboardDateLabelScale: settings.dashboardDateLabelScale,
            dashboardDateValueScale: settings.dashboardDateValueScale,
            accelPedMode: window._accelPedMode || 'iconbar',
            // Unlike the simple modal, the AE allows timestamp + dashboard
            // together (each is its own tile) — main.js composes the drawtext
            // timestamp on top of the dashboard for advanced layouts.
            includeTimestamp: settings.includeTimestamp,
            timestampPosition: 'custom',
            timestampDateFormat: window._dateFormat || 'mdy',
            timestampTimeFormat: window._timeFormat || '12h',
            blurZones: (exportStateRef.blurZones || []).filter(z => cameras.includes(z.camera)),
            blurType: 'trueBlur',
            language: typeof window.getCurrentLanguage === 'function' ? window.getCurrentLanguage() : 'en',
            mirrorCameras: window._mirrorCameras !== false,
            includeMinimap: settings.includeMinimap && mapPath.length > 0,
            minimapPosition: 'custom',
            minimapSize: 'custom',
            minimapRenderMode: settings.minimapRenderMode,
            minimapDarkMode: false,
            mapPath,
            enableTimelapse: settings.enableTimelapse,
            timelapseSpeed: settings.timelapseSpeed,
        };

        // Close AE modal and open the simple export modal so the user sees the
        // same progress UI + completion panel as a regular export. The simple
        // modal's #exportProgress / #exportCompletePanel UI is the canonical
        // export experience — we feed it the same progress events.
        if (closeAdvancedEditorCb) closeAdvancedEditorCb();
        try { openExportModal(); } catch (err) { console.warn('[AE] Could not open simple modal:', err); }
        setSimpleModalAeMode(true);

        const refs = getSimpleModalProgressRefs();
        if (refs.progressEl) refs.progressEl.classList.remove('hidden');
        if (refs.progressBar) refs.progressBar.style.width = '0%';
        if (refs.progressText) refs.progressText.textContent = 'Preparing…';
        if (refs.dashProgressEl) refs.dashProgressEl.classList.add('hidden');
        if (refs.miniProgressEl) refs.miniProgressEl.classList.add('hidden');

        // Wire progress listener — mirrors exportVideo.js's listener so the
        // dashboard / minimap sub-bars behave identically.
        if (window.electronAPI.on) {
            window.electronAPI.removeAllListeners?.('export:progress');
            window.electronAPI.on('export:progress', (rid, progress) => {
                if (rid !== exportId) return;
                const r = getSimpleModalProgressRefs();

                if (progress.type === 'progress') {
                    const text = translateMessage(progress.message);
                    if (r.progressBar) r.progressBar.style.width = `${progress.percentage}%`;
                    if (r.progressText) r.progressText.textContent = text;
                } else if (progress.type === 'dashboard-progress') {
                    if (r.progressEl) r.progressEl.classList.remove('hidden');
                    if (r.dashProgressEl) r.dashProgressEl.classList.remove('hidden');
                    if (r.dashProgressBar) r.dashProgressBar.style.width = `${progress.percentage}%`;
                    if (r.dashProgressText) r.dashProgressText.textContent = translateMessage(progress.message);
                } else if (progress.type === 'minimap-progress') {
                    if (r.progressEl) r.progressEl.classList.remove('hidden');
                    if (r.miniProgressEl) r.miniProgressEl.classList.remove('hidden');
                    if (r.miniProgressBar) r.miniProgressBar.style.width = `${progress.percentage}%`;
                    if (r.miniProgressText) r.miniProgressText.textContent = translateMessage(progress.message);
                } else if (progress.type === 'downscaled') {
                    // Bbox exceeded the encoder-safe ceiling — main process scaled
                    // the layout down. Surface this so the user understands why
                    // the output resolution is lower than expected.
                    const o = progress.original;
                    const s = progress.scaled;
                    notify(
                        `Advanced Editor layout was too large for safe encoding ` +
                        `(${o.w}×${o.h}). Output resolution was reduced to ` +
                        `${s.w}×${s.h} to ensure the export succeeds.`,
                        { type: 'warn', timeoutMs: 8000 }
                    );
                } else if (progress.type === 'complete') {
                    resetExportState();
                    if (r.dashProgressEl) r.dashProgressEl.classList.add('hidden');
                    if (r.miniProgressEl) r.miniProgressEl.classList.add('hidden');
                    const text = translateMessage(progress.message);
                    if (progress.success) {
                        if (r.progressBar) r.progressBar.style.width = '100%';
                        if (r.progressText) r.progressText.textContent = text;
                        try { showExportCompletePanel(outputPath, text); }
                        catch (err) { console.warn('[AE] showExportCompletePanel failed:', err); }
                    } else {
                        if (r.progressText) r.progressText.textContent = text;
                        setSimpleModalAeMode(false);
                    }
                }
            });
        }

        await window.electronAPI.startExport(exportId, exportData);
    } catch (err) {
        console.error('[AE] Export error:', err);
        resetExportState();
        const r = getSimpleModalProgressRefs();
        if (r.progressText) r.progressText.textContent = `Export failed: ${err.message || err}`;
        setSimpleModalAeMode(false);
    }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

async function safeGetSetting(key) {
    if (!window.electronAPI?.getSetting) return null;
    try { return await window.electronAPI.getSetting(key); }
    catch { return null; }
}

async function safeSetSetting(key, value) {
    if (!window.electronAPI?.setSetting) return;
    try { await window.electronAPI.setSetting(key, value); }
    catch {}
}

async function extractSeiAndMapPath({ groups, cumStarts, nativeVideo, startTimeMs, endTimeMs, wantMinimap, exportStateRef }) {
    const allSei = [];
    const allMap = [];

    if (!window.DashcamMP4 || !window.DashcamHelpers) return { seiData: allSei, mapPath: allMap };
    const DashcamMP4 = window.DashcamMP4;
    let SeiMetadata;
    try { ({ SeiMetadata } = await window.DashcamHelpers.initProtobuf()); }
    catch { return { seiData: allSei, mapPath: allMap }; }

    const hasGps = (sei) => {
        const lat = sei?.latitude_deg;
        const lon = sei?.longitude_deg;
        return lat !== undefined && lon !== undefined
            && Number.isFinite(lat) && Number.isFinite(lon)
            && !(Math.abs(lat) < 0.001 && Math.abs(lon) < 0.001);
    };

    for (let i = 0; i < groups.length; i++) {
        // Cancelled mid-extraction — stop reading/parsing segment buffers.
        if (exportStateRef?.cancelled) break;

        const group = groups[i];
        const segStartMs = (cumStarts[i] || 0) * 1000;
        const segDurationMs = (nativeVideo.segmentDurations?.[i] || 60) * 1000;
        const segEndMs = segStartMs + segDurationMs;
        if (segEndMs <= startTimeMs || segStartMs >= endTimeMs) continue;

        let entry = group.filesByCamera?.get('front');
        if (!entry) {
            const k = group.filesByCamera?.keys()?.next?.()?.value;
            entry = k ? group.filesByCamera.get(k) : null;
        }
        if (!entry?.file) continue;

        // Mirror to the simple modal's progress bar so the user sees SEI extraction.
        const r = getSimpleModalProgressRefs();
        if (r.progressEl) r.progressEl.classList.remove('hidden');
        if (r.progressText) r.progressText.textContent = `Extracting telemetry (${i + 1}/${groups.length})…`;

        try {
            let buffer = null;
            if (entry.file.isElectronFile && entry.file.path) {
                const url = filePathToUrl(entry.file.path);
                buffer = await (await fetch(url)).arrayBuffer();
            } else if (entry.file instanceof File) {
                buffer = await entry.file.arrayBuffer();
            } else if (entry.file.path) {
                const url = filePathToUrl(entry.file.path);
                buffer = await (await fetch(url)).arrayBuffer();
            }
            if (!buffer) continue;

            const mp4 = new DashcamMP4(buffer);
            const frames = mp4.parseFrames(SeiMetadata);
            for (const f of frames) {
                if (!f.sei) continue;
                allSei.push({ timestampMs: segStartMs + f.timestamp, sei: f.sei });
                if (wantMinimap && hasGps(f.sei)) {
                    allMap.push([f.sei.latitude_deg, f.sei.longitude_deg]);
                }
            }
        } catch (err) {
            console.warn(`[AE] SEI extraction failed for segment ${i}:`, err);
        }
    }

    allSei.sort((a, b) => a.timestampMs - b.timestampMs);
    return { seiData: allSei, mapPath: allMap };
}

function showError(message) {
    console.warn('[AE]', message);
    // Surface the error inside the simple modal's progress text rather than alert().
    const r = getSimpleModalProgressRefs();
    if (r.progressEl) r.progressEl.classList.remove('hidden');
    if (r.progressText) r.progressText.textContent = String(message);
}
