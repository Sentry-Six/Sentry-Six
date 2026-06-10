// Advanced Editor — module entry point.

import { advancedEditorState } from './state.js';
import { initSidebar, loadSidebarState, updateAvailableCameras, wireCameraToggles } from './sidebar.js';
import {
    initCanvasController, buildLayout, onCanvasResize,
    addCameraTile, removeCameraTile,
    addOverlayTile, removeOverlayTile,
    applyDashboardTilesForStyle, dashboardTilesForStyle,
    snapshotTileLayout
} from './canvasController.js';
import {
    initVideoSync, loadVideosForCanvas, disposeVideos
} from './videoSync.js';
import { initMiniTimeline, onPlaybackTick, refreshAfterLoad } from './miniTimeline.js';
import {
    initOverlayPreviews, mountOverlay, unmountOverlay,
    unmountAllOverlays, updateAllOverlays, setDashboardStyle,
    applyDashboardScales
} from './overlayPreviews.js';
import { initExportBridge, runAdvancedExport } from './exportBridge.js';

let deps = null;
let modalEl = null;
let closeBtnEl = null;
let exportBtnEl = null;
let resetLayoutBtnEl = null;
let disclaimerEl = null;
let disclaimerDismissEl = null;
let initialized = false;

const AE_DISCLAIMER_SETTING = 'aeOverlayDisclaimerDismissed';

// Tracks the previously-selected dashboard style across the onChange
// callback so the style-switch branch can compute a tile set-diff
// (Tesla Mobile adds the date-bar tile, switching away removes it).
// Seeded in openAdvancedEditor after loadSidebarState resolves.
let prevDashboardStyle = 'compact';

export function initAdvancedEditor(injected) {
    deps = injected;
    modalEl = document.getElementById('advancedEditorModal');
    closeBtnEl = document.getElementById('closeAdvancedEditorBtn');
    exportBtnEl = document.getElementById('aeExportBtn');
    resetLayoutBtnEl = document.getElementById('aeResetLayoutBtn');
    disclaimerEl = document.getElementById('aeOverlayDisclaimer');
    disclaimerDismissEl = document.getElementById('aeOverlayDisclaimerDismiss');

    if (initialized) return;
    initialized = true;

    // One-time-acknowledge disclaimer about overlay preview fidelity.
    if (disclaimerDismissEl) {
        disclaimerDismissEl.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (disclaimerEl) disclaimerEl.classList.add('hidden');
            try {
                await window.electronAPI?.setSetting?.(AE_DISCLAIMER_SETTING, true);
            } catch (err) {
                console.warn('[AE] Failed to persist disclaimer dismissal:', err);
            }
        });
    }

    if (closeBtnEl) {
        closeBtnEl.addEventListener('click', (e) => {
            e.preventDefault();
            closeAdvancedEditor();
        });
    }

    if (modalEl) {
        modalEl.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                closeAdvancedEditor();
            }
        });
        // Backdrop click closes — only when clicking the modal itself, not its content.
        // Collapsible section toggling lives in openAdvancedEditor() (matches the
        // simple modal's pattern exactly), so we don't intercept any other clicks here.
        modalEl.addEventListener('click', (e) => {
            if (e.target === modalEl) closeAdvancedEditor();
        });
    }

    if (exportBtnEl) {
        exportBtnEl.addEventListener('click', async (e) => {
            e.preventDefault();
            exportBtnEl.disabled = true;
            try {
                await runAdvancedExport();
            } finally {
                exportBtnEl.disabled = false;
            }
        });
    }

    if (resetLayoutBtnEl) {
        resetLayoutBtnEl.addEventListener('click', async (e) => {
            e.preventDefault();
            resetLayoutBtnEl.disabled = true;
            try { await resetLayout(); }
            finally { resetLayoutBtnEl.disabled = false; }
        });
    }

    initCanvasController(deps);
    initOverlayPreviews(deps);
    initExportBridge(deps, { closeAdvancedEditor });
    initVideoSync(deps, {
        onTick: (sec) => {
            onPlaybackTick(sec);
            updateAllOverlays(sec);
        }
    });
    initMiniTimeline();

    initSidebar(deps, {
        onChange: (field, value) => {
            if (field === 'selectedCameras') {
                syncCameraTiles();
                reloadVideos();
            } else if (field === 'includeTimestamp') {
                if (value) { addOverlayTile('timestamp'); mountOverlay('timestamp'); }
                else       { unmountOverlay('timestamp'); removeOverlayTile('timestamp'); }
            } else if (field === 'includeDashboard') {
                // Tesla Mobile uses TWO tiles (data + date), everything else is one.
                // dashboardTilesForStyle() returns the right set for the current style.
                const style = advancedEditorState.settings.dashboardStyle;
                const keys = dashboardTilesForStyle(style);
                if (value) {
                    for (const k of keys) {
                        addOverlayTile(k);
                        mountOverlay(k, style);
                    }
                } else {
                    for (const k of keys) {
                        unmountOverlay(k);
                        removeOverlayTile(k);
                    }
                }
            } else if (field === 'includeMinimap') {
                if (value) { addOverlayTile('minimap'); mountOverlay('minimap'); }
                else       { unmountOverlay('minimap'); removeOverlayTile('minimap'); }
            } else if (field === 'dashboardStyle') {
                // Switching style may add or remove tiles (Tesla Mobile's date
                // bar appears/disappears) — applyDashboardTilesForStyle handles
                // the diff. Then re-mount everything that survived/got added.
                const prevStyle = prevDashboardStyle;
                const newStyle = value;
                if (advancedEditorState.settings.includeDashboard) {
                    const { added } = applyDashboardTilesForStyle(prevStyle, newStyle);
                    // Mount previews for newly-added tiles. Survivors get
                    // re-mounted via setDashboardStyle below so they pick up
                    // the new style's CSS.
                    for (const k of added) mountOverlay(k, newStyle);
                    setDashboardStyle(newStyle);
                }
                prevDashboardStyle = newStyle;
            } else if (
                field === 'dashboardLabelScale'      || field === 'dashboardValueScale' ||
                field === 'dashboardDateLabelScale'  || field === 'dashboardDateValueScale'
            ) {
                applyDashboardScales();
            }
        }
    });

    window.addEventListener('resize', () => {
        if (advancedEditorState.isOpen) onCanvasResize();
    });
}

export async function openAdvancedEditor() {
    if (!modalEl) { console.warn('[AE] Modal element not found.'); return; }

    // Pause main app's videos so we're not decoding 12 streams.
    pauseMainAppVideos();

    modalEl.classList.remove('hidden');
    if (!modalEl.hasAttribute('tabindex')) modalEl.setAttribute('tabindex', '-1');
    modalEl.focus();

    advancedEditorState.isOpen = true;

    // Show the overlay-preview disclaimer unless the user has dismissed it.
    if (disclaimerEl) {
        try {
            const dismissed = await window.electronAPI?.getSetting?.(AE_DISCLAIMER_SETTING);
            disclaimerEl.classList.toggle('hidden', !!dismissed);
        } catch {
            // If the setting read fails, default to showing the disclaimer.
            disclaimerEl.classList.remove('hidden');
        }
    }

    // Collapsible section toggling — EXACT same pattern as the simple
    // export modal (exportVideo.js:803-818): double RAF, cloneNode to strip
    // any prior listeners, plain click handler that toggles `.open`. No
    // stopPropagation, no delegation — matches what works upstream.
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            modalEl.querySelectorAll('.collapsible-header').forEach(header => {
                const newHeader = header.cloneNode(true);
                header.parentNode.replaceChild(newHeader, header);
                newHeader.addEventListener('click', () => {
                    const section = newHeader.closest('.collapsible-section');
                    if (section) section.classList.toggle('open');
                });
            });
        });
    });

    try {
        const available = detectAvailableCameras();
        updateAvailableCameras(available);
        if (available) {
            const next = new Set();
            for (const c of advancedEditorState.settings.selectedCameras) {
                if (available.has(c)) next.add(c);
            }
            advancedEditorState.settings.selectedCameras = next;
        }
    } catch (err) {
        console.warn('[AE] Could not detect available cameras:', err);
    }

    await loadSidebarState();

    // Defensive re-wire of camera toggles on every open. If init somehow
    // missed wiring them (race with DOM ready, upstream error, etc.) this
    // guarantees the change handler is live. The function no-ops if the
    // grid is already wired.
    wireCameraToggles();

    // Seed prevDashboardStyle from the freshly-loaded settings so the first
    // onChange firing can compute the correct previous→next tile diff.
    prevDashboardStyle = advancedEditorState.settings.dashboardStyle || 'compact';

    requestAnimationFrame(async () => {
        // Tesla Mobile uses two tiles — both flagged in overlaysEnabled when
        // the dashboard is on AND the style is tesla-mobile.
        const dashOn = advancedEditorState.settings.includeDashboard;
        const isTeslaMobile = advancedEditorState.settings.dashboardStyle === 'tesla-mobile';
        await buildLayout({
            selectedCameras: advancedEditorState.settings.selectedCameras,
            overlaysEnabled: {
                timestamp:     advancedEditorState.settings.includeTimestamp,
                dashboard:     dashOn,
                dashboardDate: dashOn && isTeslaMobile,
                minimap:       advancedEditorState.settings.includeMinimap,
            },
        });
        onCanvasResize();

        // The modal animates in over a few frames, and the canvas (which uses
        // CSS aspect-ratio + flex sizing) doesn't reach its final pixel size
        // until layout settles. Capture the canvas size again at staggered
        // intervals so tiles get re-rendered at the correct pixel scale.
        // (Without these, tiles render at the canvas's INITIAL size and only
        // get corrected when the user first clicks a tile — onTileMouseDown
        // calls measureCanvas again.)
        requestAnimationFrame(() => {
            requestAnimationFrame(() => onCanvasResize());
        });
        setTimeout(onCanvasResize, 100);
        setTimeout(onCanvasResize, 300);

        // Mount overlay previews for any overlays that are enabled at open time.
        if (advancedEditorState.settings.includeTimestamp) mountOverlay('timestamp');
        if (advancedEditorState.settings.includeDashboard) {
            const style = advancedEditorState.settings.dashboardStyle;
            for (const k of dashboardTilesForStyle(style)) {
                mountOverlay(k, style);
            }
        }
        if (advancedEditorState.settings.includeMinimap)   mountOverlay('minimap');

        // Load videos and seed the timeline range from export markers.
        await reloadVideos();
        refreshAfterLoad();

        // Once videos are loaded and the playhead is at startSec, push one SEI
        // refresh to every mounted overlay. Without this the dashboard preview
        // stays on whatever values it cloned from the live floating panel
        // (which is driven by the MAIN player's currentTime, not AE's).
        updateAllOverlays(advancedEditorState.playback.currentSec || 0);
    });
}

export function closeAdvancedEditor() {
    if (!modalEl) return;
    // Snapshot the current layout BEFORE disposing — buildLayout reads this
    // on next open so the user's tile positions survive close→reopen.
    // In-memory only, cleared on app restart.
    snapshotTileLayout();
    disposeVideos();
    unmountAllOverlays();
    modalEl.classList.add('hidden');
    advancedEditorState.isOpen = false;
}

export function isAdvancedEditorOpen() {
    return modalEl && !modalEl.classList.contains('hidden');
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function detectAvailableCameras() {
    const state = deps?.getState?.();
    const active = state?.collection?.active;
    if (!active) return null;
    const groups = active.groups || [];
    const cameras = new Set();
    for (const g of groups) {
        if (!g?.filesByCamera) continue;
        for (const camera of g.filesByCamera.keys()) cameras.add(camera);
    }
    return cameras.size > 0 ? cameras : null;
}

// Restore the AE to its initial state: every available camera re-checked,
// every tile back at the default grid position for the current style. Called
// from the floating "Reset Layout" button. Settings (style, scales, overlay
// toggles) are NOT touched — only tile positions and the camera selection.
async function resetLayout() {
    const available = detectAvailableCameras();
    if (available && available.size > 0) {
        advancedEditorState.settings.selectedCameras = new Set(available);
    }

    // Clear the within-session snapshot so buildLayout falls through to the
    // fresh default grid instead of restoring whatever was there before.
    advancedEditorState.sessionLayoutSnapshot = null;

    // Sync the sidebar checkboxes with the restored selection.
    updateAvailableCameras(available);

    // Unmount any existing overlay previews — buildLayout will recreate the
    // tiles and we need fresh DOM for the previews after.
    unmountAllOverlays();

    const settings = advancedEditorState.settings;
    const dashOn = settings.includeDashboard;
    const isTeslaMobile = settings.dashboardStyle === 'tesla-mobile';
    await buildLayout({
        selectedCameras: settings.selectedCameras,
        overlaysEnabled: {
            timestamp:     settings.includeTimestamp,
            dashboard:     dashOn,
            dashboardDate: dashOn && isTeslaMobile,
            minimap:       settings.includeMinimap,
        },
    });
    onCanvasResize();

    if (settings.includeTimestamp) mountOverlay('timestamp');
    if (settings.includeDashboard) {
        const style = settings.dashboardStyle;
        for (const k of dashboardTilesForStyle(style)) {
            mountOverlay(k, style);
        }
    }
    if (settings.includeMinimap) mountOverlay('minimap');

    // Push a frame of SEI so the dashboard preview shows live values at the
    // current playhead instead of stale clone data.
    updateAllOverlays(advancedEditorState.playback.currentSec || 0);

    // Reload video sources too — the selection may have changed.
    await reloadVideos();
}

function syncCameraTiles() {
    const selected = advancedEditorState.settings.selectedCameras;
    for (const camera of selected) {
        if (!advancedEditorState.tiles.has(`camera:${camera}`)) addCameraTile(camera);
    }
    for (const id of [...advancedEditorState.tiles.keys()]) {
        if (!id.startsWith('camera:')) continue;
        const camera = id.slice('camera:'.length);
        if (!selected.has(camera)) removeCameraTile(camera);
    }
}

async function reloadVideos() {
    const nativeVideo = deps?.getNativeVideo?.();
    const exportState = deps?.getExportState?.();
    if (!nativeVideo || !exportState) return;

    const totalSec = (nativeVideo.cumulativeStarts || []).slice(-1)[0] || 0;
    if (totalSec <= 0) return;

    const startPct = (exportState.startMarkerPct != null) ? exportState.startMarkerPct : 0;
    const endPct   = (exportState.endMarkerPct != null) ? exportState.endMarkerPct : 100;
    const startSec = Math.max(0, Math.min(startPct, endPct) / 100 * totalSec);
    const endSec   = Math.min(totalSec, Math.max(startPct, endPct) / 100 * totalSec);

    await loadVideosForCanvas({
        cameras: advancedEditorState.settings.selectedCameras,
        startSec,
        endSec
    });

    refreshAfterLoad();
}

function pauseMainAppVideos() {
    const nativeVideo = deps?.getNativeVideo?.();
    const videoBySlot = deps?.getVideoBySlot?.();
    try {
        nativeVideo?.master?.pause?.();
    } catch {}
    if (videoBySlot) {
        for (const v of Object.values(videoBySlot)) {
            try { v?.pause?.(); } catch {}
        }
    }
}
