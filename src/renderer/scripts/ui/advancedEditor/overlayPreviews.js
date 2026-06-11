// Advanced Editor — live HTML previews for the three overlay types.
//
// IMPORTANT: these previews are visual approximations only. The final exported
// video is rendered server-side from ASS subtitle files (assGenerator.js) +
// FFmpeg overlays — the source of truth for what the export actually looks like
// remains those generators. The previews are "good enough so the user knows
// where the overlay will sit".

import { advancedEditorState } from './state.js';
import { findSeiAtTime } from '../../core/seiExtractor.js';
import { attachTileLayer, detachTileLayer } from '../mapTiles.js';

const MPS_TO_MPH = 2.23694;
const MPS_TO_KMH = 3.6;

const overlayInstances = new Map();  // overlayKey -> { update(sei), dispose() }

let depsRef = null;

export function initOverlayPreviews(deps) {
    depsRef = deps;
}

// Build/refresh preview content inside its tile.
export function mountOverlay(overlayKey, style) {
    const tileEl = document.querySelector(
        `.ae-tile[data-tile-type="overlay"][data-tile-name="${overlayKey}"]`
    );
    if (!tileEl) return;
    const contentEl = tileEl.querySelector('.ae-overlay-content');
    if (!contentEl) return;

    // Dispose previous instance for this overlay.
    const prev = overlayInstances.get(overlayKey);
    if (prev?.dispose) try { prev.dispose(); } catch {}
    overlayInstances.delete(overlayKey);
    contentEl.innerHTML = '';
    contentEl.style.cssText = 'width:100%; height:100%; pointer-events:none; overflow:hidden;';

    let instance = null;
    if (overlayKey === 'timestamp')          instance = makeTimestampPreview(contentEl);
    else if (overlayKey === 'minimap')       instance = makeMinimapPreview(contentEl);
    else if (overlayKey === 'dashboard')     instance = makeDashboardPreview(contentEl, style || 'compact', 'dashboard');
    else if (overlayKey === 'dashboardDate') instance = makeDashboardPreview(contentEl, style || 'compact', 'dashboardDate');

    if (instance) overlayInstances.set(overlayKey, instance);

    // A freshly-mounted overlay starts with the values it was cloned from
    // (which, for dashboard, are the live floating panel's values driven by
    // the MAIN player). Refresh immediately so the user sees the SEI at the
    // AE's current playback position, not main player state.
    refreshOverlayAtCurrentSec(overlayKey);

    // Re-apply text-size scaling vars whenever a dashboard tile re-mounts
    // (style switch, toggle off+on) so the new clone picks up the user's
    // choices. Covers both the data tile and the Tesla Mobile date tile.
    if (overlayKey === 'dashboard' || overlayKey === 'dashboardDate') applyDashboardScales();
}

function refreshOverlayAtCurrentSec(overlayKey) {
    const inst = overlayInstances.get(overlayKey);
    if (!inst?.update) return;
    const cur = advancedEditorState.playback.currentSec || 0;
    const { sei, absTimestampMs } = computeSeiAndTimestamp(cur);
    try { inst.update({ sei, absTimestampMs, currentSec: cur }); }
    catch (err) { console.warn('[AE] refreshOverlayAtCurrentSec failed:', overlayKey, err); }
}

export function unmountOverlay(overlayKey) {
    const inst = overlayInstances.get(overlayKey);
    if (inst?.dispose) try { inst.dispose(); } catch {}
    overlayInstances.delete(overlayKey);
}

export function unmountAllOverlays() {
    for (const overlayKey of [...overlayInstances.keys()]) unmountOverlay(overlayKey);
}

export function setDashboardStyle(style) {
    // Re-mount EVERY dashboard tile (data + Tesla Mobile date if present).
    // Each tile needs its own maker for the new style.
    if (advancedEditorState.tiles.has('overlay:dashboard')) {
        mountOverlay('dashboard', style);
    }
    if (advancedEditorState.tiles.has('overlay:dashboardDate')) {
        mountOverlay('dashboardDate', style);
    }
}

// Push the latest scale settings from state onto the currently-mounted
// dashboard previews. Called when the user changes any of the size
// dropdowns so the preview updates instantly.
//
// Two tile roots can exist:
//   - 'dashboard' (data tile, all styles) reads --dvd-label-scale and
//     --dvd-value-scale (existing pair).
//   - 'dashboardDate' (Tesla Mobile date tile only) reads
//     --dvd-date-label-scale and --dvd-date-value-scale (independent pair).
// Vars are set on the .ae-tile root so the cloned template inherits them.
export function applyDashboardScales() {
    const dataTileEl = document.querySelector(
        `.ae-tile[data-tile-type="overlay"][data-tile-name="dashboard"]`
    );
    if (dataTileEl) {
        applyDetailedScales(dataTileEl);
        // Default-style preview applies its scale via a JS-driven transform
        // (not pure CSS like Compact/Detailed) — ask it to recompute now.
        const inst = overlayInstances.get('dashboard');
        if (inst?.refit) try { inst.refit(); } catch {}
    }

    const dateTileEl = document.querySelector(
        `.ae-tile[data-tile-type="overlay"][data-tile-name="dashboardDate"]`
    );
    if (dateTileEl) {
        applyDateBarScales(dateTileEl);
        // Date preview's font-size is JS-driven (not CSS var-driven), so the
        // var write above isn't enough — ask it to recompute now.
        const inst = overlayInstances.get('dashboardDate');
        if (inst?.refit) try { inst.refit(); } catch {}
    }
}

function applyDetailedScales(root) {
    const labelScale = advancedEditorState.settings?.dashboardLabelScale ?? 1;
    const valueScale = advancedEditorState.settings?.dashboardValueScale ?? 1;
    root.style.setProperty('--dvd-label-scale', String(labelScale));
    root.style.setProperty('--dvd-value-scale', String(valueScale));
}

function applyDateBarScales(root) {
    const labelScale = advancedEditorState.settings?.dashboardDateLabelScale ?? 1;
    const valueScale = advancedEditorState.settings?.dashboardDateValueScale ?? 1;
    root.style.setProperty('--dvd-date-label-scale', String(labelScale));
    root.style.setProperty('--dvd-date-value-scale', String(valueScale));
}

// Called every animation frame with current cumulative seconds.
export function updateAllOverlays(currentCumSec) {
    const { sei, absTimestampMs } = computeSeiAndTimestamp(currentCumSec);
    for (const [key, inst] of overlayInstances.entries()) {
        if (inst?.update) {
            try { inst.update({ sei, absTimestampMs, currentSec: currentCumSec }); }
            catch (err) { console.warn('[AE] overlay update failed:', key, err); }
        }
    }
}

// Look up SEI and wall-clock timestamp for an AE cumulative second.
// Uses AE's own per-segment SEI cache rather than nativeVideo.seiData (which
// only ever holds the main player's current segment and therefore returns
// stale data for any AE segment the main player isn't on).
function computeSeiAndTimestamp(currentCumSec) {
    const nativeVideo = depsRef?.getNativeVideo?.();
    const cumStarts = nativeVideo?.cumulativeStarts || [];
    const segIdx = findSegmentIdx(cumStarts, currentCumSec);
    const cumStart = cumStarts[segIdx] || 0;
    const localSec = currentCumSec - cumStart;

    // SEI lookup: prefer AE's per-segment cache (cumulative-time accurate),
    // fall back to nativeVideo.seiData only if AE happens to be in the same
    // segment the main player has loaded (so it isn't stale).
    let sei = null;
    const segSei = advancedEditorState.aeSeiBySegment.get(segIdx);
    if (segSei?.length) {
        sei = findSeiAtTime(segSei, Math.round(localSec * 1000));
    } else if (nativeVideo?.seiData?.length && nativeVideo?.currentSegmentIdx === segIdx) {
        sei = findSeiAtTime(nativeVideo.seiData, Math.round(localSec * 1000));
    }

    const group = depsRef?.getState?.()?.collection?.active?.groups?.[segIdx];
    const segTimestampMs = parseTimestampKeyMs(group?.timestampKey);
    const absTimestampMs = segTimestampMs ? segTimestampMs + Math.round(localSec * 1000) : null;

    return { sei, absTimestampMs };
}

// --------------------------------------------------------------------------
// Timestamp
// --------------------------------------------------------------------------

function makeTimestampPreview(contentEl) {
    const span = document.createElement('span');
    span.style.cssText = `
        position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
        color:#fff; font-family:'Arial', sans-serif; font-weight:bold;
        background:rgba(0,0,0,0.55); padding:4px 10px; border-radius:3px;
        white-space:nowrap; font-size:clamp(10px, 4vmin, 22px);
    `;
    span.textContent = '--/--/---- --:--:--';
    contentEl.appendChild(span);

    return {
        update({ absTimestampMs }) {
            if (!absTimestampMs) return;
            const d = new Date(absTimestampMs);
            const useFormat = (window._timeFormat || '12h');
            const useDate = (window._dateFormat || 'mdy');
            span.textContent = `${formatDate(d, useDate)} ${formatClock(d, useFormat)}`;
        },
        dispose() { span.remove(); }
    };
}

function formatDate(d, mode) {
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yyyy = d.getFullYear();
    if (mode === 'dmy') return `${dd}/${mm}/${yyyy}`;
    if (mode === 'ymd') return `${yyyy}-${mm}-${dd}`;
    return `${mm}/${dd}/${yyyy}`;
}

function formatClock(d, mode) {
    if (mode === '24h') {
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const ss = String(d.getSeconds()).padStart(2, '0');
        return `${hh}:${mm}:${ss}`;
    }
    let h = d.getHours();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    const hh = String(h).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss} ${ampm}`;
}

// --------------------------------------------------------------------------
// Minimap — Leaflet
// --------------------------------------------------------------------------

function makeMinimapPreview(contentEl) {
    contentEl.style.background = '#0e1a2b';

    if (typeof window.L === 'undefined') {
        contentEl.innerHTML = '<div style="color:#fff; font-size:11px; padding:10px;">Leaflet not loaded</div>';
        return null;
    }

    const mapDiv = document.createElement('div');
    mapDiv.style.cssText = 'width:100%; height:100%;';
    contentEl.appendChild(mapDiv);

    let map = null;
    let polyline = null;
    let marker = null;
    let resizeObs = null;

    try {
        // Defer init to next frame so the tile has its final size.
        requestAnimationFrame(() => {
            map = window.L.map(mapDiv, {
                zoomControl: false,
                attributionControl: false,
                dragging: false,
                scrollWheelZoom: false,
                doubleClickZoom: false,
                touchZoom: false,
            });
            // Tile layer from the shared provider registry (Google with OSM
            // fallback); 18 preserves this preview's original zoom ceiling.
            attachTileLayer(map, { maxZoomCap: 18 });

            const nativeVideo = depsRef?.getNativeVideo?.();
            const path = nativeVideo?.mapPath || [];
            if (path.length > 0) {
                polyline = window.L.polyline(path, { color: '#5ee9a0', weight: 3 }).addTo(map);
                map.fitBounds(polyline.getBounds(), { padding: [10, 10] });
                marker = window.L.circleMarker(path[0], {
                    radius: 5, color: '#fff', fillColor: '#5ee9a0', fillOpacity: 1
                }).addTo(map);
            } else {
                map.setView([0, 0], 2);
            }

            // Invalidate on tile resize (the tile element itself).
            const tileEl = contentEl.closest('.ae-tile');
            if (tileEl && 'ResizeObserver' in window) {
                resizeObs = new ResizeObserver(() => {
                    if (map) map.invalidateSize(false);
                });
                resizeObs.observe(tileEl);
            }
        });
    } catch (err) {
        console.warn('[AE] minimap init failed:', err);
    }

    return {
        update({ sei }) {
            if (!map || !marker || !sei) return;
            const lat = sei.latitudeDeg ?? sei.latitude_deg;
            const lon = sei.longitudeDeg ?? sei.longitude_deg;
            if (typeof lat === 'number' && typeof lon === 'number' && (lat !== 0 || lon !== 0)) {
                marker.setLatLng([lat, lon]);
            }
        },
        dispose() {
            try { if (resizeObs) resizeObs.disconnect(); } catch {}
            try { if (map) detachTileLayer(map); } catch {}
            try { if (map) map.remove(); } catch {}
        }
    };
}

// --------------------------------------------------------------------------
// Dashboard
// --------------------------------------------------------------------------

function makeDashboardPreview(contentEl, style, overlayKey = 'dashboard') {
    // Tesla Mobile renders as two independent tiles — route by overlayKey
    // so each maker clones the right template (date bar vs data bar).
    if (style === 'tesla-mobile') {
        if (overlayKey === 'dashboardDate') return makeTeslaMobileDatePreview(contentEl);
        return makeTeslaMobileDataPreview(contentEl);
    }
    // All other styles are single-tile (only mounted on the 'dashboard' tile).
    if (style === 'compact')             return makeCompactDashboardPreview(contentEl);
    if (style === 'default')             return makeDefaultDashboardPreview(contentEl);
    if (style === 'detailed')            return makeDetailedDashboardPreview(contentEl);
    if (style === 'tesla-screen-dash')   return makeTeslaScreenDashPreview(contentEl);
    return makeCompactDashboardPreview(contentEl);  // default
}

// --- Compact: clone the existing #dashboardVisCompact and drive by class.
function makeCompactDashboardPreview(contentEl) {
    contentEl.style.background = 'transparent';
    const source = document.getElementById('dashboardVisCompact');
    if (!source) {
        contentEl.innerHTML = '<div style="color:#fff; padding:6px;">Compact preview unavailable.</div>';
        return null;
    }
    const clone = source.cloneNode(true);
    clone.id = '';                 // drop duplicate id
    // Strip visibility-killing classes (the source may carry .hidden /
    // .user-hidden when the user has compact off in the main view) and
    // explicitly add .visible so the .dashboard-vis-compact { display:none }
    // base rule is overridden.
    clone.classList.remove('hidden', 'user-hidden');
    clone.classList.add('visible');
    // Make sure no descendant of the clone retains a duplicate id.
    clone.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
    clone.style.position = 'static';
    clone.style.width = '100%';
    clone.style.height = '100%';
    clone.style.left = 'unset';
    clone.style.top = 'unset';
    clone.style.bottom = 'unset';
    clone.style.right = 'unset';
    clone.style.transform = 'none';
    contentEl.appendChild(clone);

    return {
        update({ sei }) {
            if (!sei) return;
            updateCompactScoped(clone, sei, !!depsRef?.getUseMetric?.());
        },
        dispose() { clone.remove(); }
    };
}

function updateCompactScoped(scope, sei, useMetric) {
    const get = (camel, snake) => sei[camel] ?? sei[snake];

    // Speed
    const mps = Math.abs(get('vehicleSpeedMps', 'vehicle_speed_mps') || 0);
    const speed = useMetric ? Math.round(mps * MPS_TO_KMH) : Math.round(mps * MPS_TO_MPH);
    const speedEl = scope.querySelector('.speed-value-compact');
    const speedUnit = scope.querySelector('.speed-unit-compact');
    if (speedEl) speedEl.textContent = String(speed);
    if (speedUnit) speedUnit.textContent = useMetric ? 'KM/H' : 'MPH';

    // Gear
    const gear = get('gearState', 'gear_state');
    let gearText = '--';
    if (gear === 0) gearText = 'Park';
    else if (gear === 1) gearText = 'Drive';
    else if (gear === 2) gearText = 'Reverse';
    else if (gear === 3) gearText = 'Neutral';
    const gearEl = scope.querySelector('.gear-state-compact');
    if (gearEl) gearEl.textContent = gearText;

    // Blinkers
    const leftOn = !!get('blinkerOnLeft', 'blinker_on_left');
    const rightOn = !!get('blinkerOnRight', 'blinker_on_right');
    const bL = scope.querySelector('.turn-signal-compact.left');
    const bR = scope.querySelector('.turn-signal-compact.right');
    if (bL) { bL.classList.toggle('active', leftOn); bL.classList.toggle('paused', !advancedEditorState.playback.isPlaying); }
    if (bR) { bR.classList.toggle('active', rightOn); bR.classList.toggle('paused', !advancedEditorState.playback.isPlaying); }

    // Autopilot
    const apState = get('autopilotState', 'autopilot_state');
    const isActive = apState === 1 || apState === 2;
    let apText = 'Manual';
    if (apState === 1) apText = 'Self-Driving';
    else if (apState === 2) apText = 'Autosteer';
    else if (apState === 3) apText = 'TACC';
    const apTextEl = scope.querySelector('.autopilot-label-compact');
    if (apTextEl) { apTextEl.textContent = apText; apTextEl.classList.toggle('active', isActive); }
    const autosteerIcon = scope.querySelector('.autosteer-icon-compact');
    if (autosteerIcon) autosteerIcon.classList.toggle('active', isActive);
    if (gearEl) gearEl.classList.toggle('active', isActive);

    // Brake
    const brakeActive = !!get('brakeApplied', 'brake_applied');
    const brakeIcon = scope.querySelector('.brake-icon-compact');
    if (brakeIcon) brakeIcon.classList.toggle('active', brakeActive);

    // Accelerator
    const accelPosRaw = get('acceleratorPedalPosition', 'accelerator_pedal_position') || 0;
    const accelPct = accelPosRaw > 1 ? Math.min(100, accelPosRaw) : Math.min(100, accelPosRaw * 100);
    const isPressed = accelPct > 5;
    const topInset = 100 - accelPct;
    const accelPedal = scope.querySelector('.accel-pedal-container-compact');
    const accelFill = scope.querySelector('.accel-fill-compact');
    if (accelPedal) accelPedal.classList.toggle('active', isPressed);
    if (accelFill) accelFill.style.clipPath = `inset(${topInset}% 0 0 0)`;
}

// --- Default: clone the live #dashboardVis floating panel.
// This is the look of the floating widget over the main player (speed/gear/
// blinkers/G-force/compass). For the ASS-rendered themed Detailed style,
// see makeDetailedDashboardPreview below.
//
// The floating widget is laid out at a fixed 480×260 pixel canvas — all of
// its inner padding/margins/sizes are absolute pixels that don't reflow.
// Stretching it to fill an arbitrary AE tile (which is what we used to do)
// caused content to overflow and labels to clip. Instead we render the
// clone at its NATIVE 480×260 and apply a transform: scale that fits it to
// whatever the tile shape is, centered. The user's Value Size dropdown
// is folded in as an additional scale multiplier so spacing scales with
// the text. Label Size has no separate effect for Default since the
// widget doesn't have a meaningful label/value distinction.
const DEFAULT_PANEL_W = 480;
const DEFAULT_PANEL_H = 260;

function makeDefaultDashboardPreview(contentEl) {
    contentEl.style.background = 'transparent';
    contentEl.style.position = 'relative';
    contentEl.style.overflow = 'hidden';

    const source = document.getElementById('dashboardVis');
    if (!source) {
        contentEl.innerHTML = '<div style="color:#fff; padding:6px;">Default preview unavailable.</div>';
        return null;
    }
    const clone = source.cloneNode(true);
    clone.id = '';
    // Convert every descendant id="x" into data-ae-id="x" so we can target them
    // without conflicting with the live floating panel (which still owns the ids).
    clone.querySelectorAll('[id]').forEach(el => {
        const origId = el.getAttribute('id');
        if (origId) el.setAttribute('data-ae-id', origId);
        el.removeAttribute('id');
    });

    // Strip visibility-killing classes that the source may carry.
    clone.classList.remove('hidden', 'user-hidden');
    clone.classList.add('visible');

    // Force native pixel size. transform applied separately below.
    clone.style.cssText = [
        'position: absolute',
        'top: 0', 'left: 0', 'right: auto', 'bottom: auto',
        `width: ${DEFAULT_PANEL_W}px`,
        `height: ${DEFAULT_PANEL_H}px`,
        'transform: none',
        'transform-origin: top left',
        'cursor: default',
        'z-index: 1',
        'pointer-events: none',
        'display: block',
    ].join(';');

    // Drag handle / toggle button are useless in the preview — hide them.
    const dragHandle = clone.querySelector('.vis-header');
    if (dragHandle) dragHandle.style.display = 'none';
    const toggleBtn = clone.querySelector('.toggle-btn');
    if (toggleBtn) toggleBtn.style.display = 'none';
    // Show the extra-data block by default since the toggle is hidden.
    const extraContainer = clone.querySelector('.extra-data-container');
    if (extraContainer) extraContainer.classList.add('expanded');
    // Recording time is meaningless here — hide.
    const recordingTime = clone.querySelector('.recording-time');
    if (recordingTime) recordingTime.style.display = 'none';

    contentEl.appendChild(clone);

    // Preview marker sits in the contentEl (NOT the clone) so the transform
    // doesn't move it, and it stays anchored to the actual tile corner.
    const marker = document.createElement('div');
    marker.style.cssText = 'position:absolute; right:6px; top:4px; font-size:9px; color:#fff; opacity:.5; z-index:3; pointer-events:none;';
    marker.textContent = 'preview';
    contentEl.appendChild(marker);

    // Fit-to-tile: recompute scale + centering whenever the tile resizes.
    // baseScale fits the natural 480×260 panel inside the tile. Value Size
    // is treated as a SHRINK-ONLY multiplier (capped at 1.0) so picking
    // Small/Medium scales the panel down, and Large/XL/Huge stay at the
    // exact-fit baseScale. This avoids the cut-off the user hit earlier
    // where the panel overflowed the tile at Large+. To make the panel
    // visually bigger, resize the tile itself. Label Size has no effect
    // on Default (the widget doesn't have a meaningful label/value split).
    const fitToTile = () => {
        const tileW = contentEl.clientWidth;
        const tileH = contentEl.clientHeight;
        if (!tileW || !tileH) return;
        const userScale = Math.min(1, advancedEditorState.settings?.dashboardValueScale ?? 1);
        const baseScale = Math.min(tileW / DEFAULT_PANEL_W, tileH / DEFAULT_PANEL_H);
        const scale = baseScale * userScale;
        const scaledW = DEFAULT_PANEL_W * scale;
        const scaledH = DEFAULT_PANEL_H * scale;
        const offsetX = (tileW - scaledW) / 2;
        const offsetY = (tileH - scaledH) / 2;
        clone.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
    };

    let ro = null;
    if ('ResizeObserver' in window) {
        ro = new ResizeObserver(fitToTile);
        ro.observe(contentEl);
    }
    // Initial fit on the next frame (clientWidth/Height may not be settled yet).
    requestAnimationFrame(fitToTile);

    // Per-instance G-force trail history (the main meter keeps its own).
    const gforceHistory = [];

    return {
        update({ sei }) {
            if (!sei) return;
            updateDefaultScoped(clone, sei, !!depsRef?.getUseMetric?.(), gforceHistory);
        },
        refit: fitToTile,
        dispose() {
            try { if (ro) ro.disconnect(); } catch {}
            clone.remove();
            marker.remove();
        }
    };
}

function aeId(scope, key) {
    return scope.querySelector(`[data-ae-id="${key}"]`);
}

function updateDefaultScoped(scope, sei, useMetric, gforceHistory) {
    const get = (camel, snake) => sei[camel] ?? sei[snake];
    const isPlaying = !!advancedEditorState.playback.isPlaying;

    // Speed / unit
    const mps = Math.abs(get('vehicleSpeedMps', 'vehicle_speed_mps') || 0);
    const speed = useMetric ? Math.round(mps * MPS_TO_KMH) : Math.round(mps * MPS_TO_MPH);
    const speedEl = aeId(scope, 'speedValue') || scope.querySelector('.speed-value');
    const speedUnit = aeId(scope, 'speedUnit') || scope.querySelector('.speed-unit');
    if (speedEl) speedEl.textContent = String(speed);
    if (speedUnit) speedUnit.textContent = useMetric ? 'KM/H' : 'MPH';

    // Gear
    const gear = get('gearState', 'gear_state');
    const gearText = gear === 0 ? 'Park' : gear === 1 ? 'Drive' : gear === 2 ? 'Reverse' : gear === 3 ? 'Neutral' : '--';
    const gearEl = aeId(scope, 'gearState') || scope.querySelector('.gear-state');
    if (gearEl) gearEl.textContent = gearText;

    // Autopilot
    const apState = get('autopilotState', 'autopilot_state');
    const isActive = apState === 1 || apState === 2;
    const apText = apState === 1 ? 'Self-Driving' : apState === 2 ? 'Autosteer' : apState === 3 ? 'TACC' : 'Manual';
    const apEl = aeId(scope, 'apText') || scope.querySelector('.autopilot-label');
    const autosteerIcon = aeId(scope, 'autosteerIcon') || scope.querySelector('.autosteer-icon');
    if (apEl) { apEl.textContent = apText; apEl.classList.toggle('active', isActive); }
    if (autosteerIcon) autosteerIcon.classList.toggle('active', isActive);
    if (gearEl) gearEl.classList.toggle('active', isActive);

    // Blinkers
    const leftOn = !!get('blinkerOnLeft', 'blinker_on_left');
    const rightOn = !!get('blinkerOnRight', 'blinker_on_right');
    const bL = aeId(scope, 'blinkLeft') || scope.querySelector('.turn-signal.left');
    const bR = aeId(scope, 'blinkRight') || scope.querySelector('.turn-signal.right');
    if (bL) { bL.classList.toggle('active', leftOn); bL.classList.toggle('paused', !isPlaying); }
    if (bR) { bR.classList.toggle('active', rightOn); bR.classList.toggle('paused', !isPlaying); }

    // Brake
    const brakeActive = !!get('brakeApplied', 'brake_applied');
    const brakeIcon = aeId(scope, 'brakeIcon') || scope.querySelector('.brake-icon');
    if (brakeIcon) brakeIcon.classList.toggle('active', brakeActive);

    // Accelerator
    const accelRaw = get('acceleratorPedalPosition', 'accelerator_pedal_position') || 0;
    const accelPct = accelRaw > 1 ? Math.min(100, accelRaw) : Math.min(100, accelRaw * 100);
    const isPressed = accelPct > 5;
    const topInset = 100 - accelPct;
    const accelPedal = aeId(scope, 'accelPedal') || scope.querySelector('.accel-pedal-container');
    const accelFill = aeId(scope, 'accelFill') || scope.querySelector('.accel-fill');
    if (accelPedal) accelPedal.classList.toggle('active', isPressed);
    if (accelFill) accelFill.style.clipPath = `inset(${topInset}% 0 0 0)`;

    // Steering — set transform directly (no smoothing; tick already runs ~60Hz).
    const angle = get('steeringWheelAngle', 'steering_wheel_angle') || 0;
    const steeringIcon = aeId(scope, 'steeringIcon') || scope.querySelector('.autosteer-wrapper');
    if (steeringIcon) steeringIcon.style.transform = `rotate(${angle}deg)`;

    // Extra data
    const seqNo = get('frameSeqNo', 'frame_seq_no');
    const lat = get('latitudeDeg', 'latitude_deg');
    const lon = get('longitudeDeg', 'longitude_deg');
    const heading = get('headingDeg', 'heading_deg');
    const seqEl = aeId(scope, 'valSeq');
    const latEl = aeId(scope, 'valLat');
    const lonEl = aeId(scope, 'valLon');
    const headEl = aeId(scope, 'valHeading');
    if (seqEl) seqEl.textContent = seqNo ?? '--';
    if (latEl) latEl.textContent = (typeof lat === 'number') ? lat.toFixed(6) : '--';
    if (lonEl) lonEl.textContent = (typeof lon === 'number') ? lon.toFixed(6) : '--';
    if (headEl) headEl.textContent = (typeof heading === 'number') ? `${heading.toFixed(1)}°` : '--';

    // G-Force meter
    updateGForceScoped(scope, sei, gforceHistory);

    // Compass
    updateCompassScoped(scope, sei);
}

function updateGForceScoped(scope, sei, history) {
    const GRAVITY = 9.81;
    const GFORCE_SCALE = 25;
    const GFORCE_HISTORY_MAX = 3;
    const dot = aeId(scope, 'gforceDot');
    if (!dot) return;
    const accX = sei?.linearAccelerationMps2X ?? sei?.linear_acceleration_mps2_x ?? 0;
    const accY = sei?.linearAccelerationMps2Y ?? sei?.linear_acceleration_mps2_y ?? 0;
    const gX = accX / GRAVITY;
    const gY = accY / GRAVITY;
    const clampedGX = Math.max(-2, Math.min(2, gX));
    const clampedGY = Math.max(-2, Math.min(2, gY));
    const dotX = 30 + (clampedGX * GFORCE_SCALE);
    const dotY = 30 - (clampedGY * GFORCE_SCALE);

    history.unshift({ x: dotX, y: dotY });
    if (history.length > GFORCE_HISTORY_MAX) history.pop();

    dot.setAttribute('cx', dotX);
    dot.setAttribute('cy', dotY);
    const t1 = aeId(scope, 'gforceTrail1');
    const t2 = aeId(scope, 'gforceTrail2');
    const t3 = aeId(scope, 'gforceTrail3');
    if (t1 && history[0]) { t1.setAttribute('cx', history[0].x); t1.setAttribute('cy', history[0].y); }
    if (t2 && history[1]) { t2.setAttribute('cx', history[1].x); t2.setAttribute('cy', history[1].y); }
    if (t3 && history[2]) { t3.setAttribute('cx', history[2].x); t3.setAttribute('cy', history[2].y); }

    const gxEl = aeId(scope, 'gforceX');
    const gyEl = aeId(scope, 'gforceY');
    if (gxEl) gxEl.textContent = (gX >= 0 ? '+' : '') + gX.toFixed(1);
    if (gyEl) gyEl.textContent = (gY >= 0 ? '+' : '') + gY.toFixed(1);
}

function updateCompassScoped(scope, sei) {
    const needle = aeId(scope, 'compassNeedle');
    if (!needle) return;
    let heading = parseFloat(sei?.headingDeg ?? sei?.heading_deg);
    if (!Number.isFinite(heading)) heading = 0;
    heading = ((heading % 360) + 360) % 360;
    needle.setAttribute('transform', `rotate(${heading} 30 30)`);
    const valEl = aeId(scope, 'compassValue');
    if (valEl) {
        const cardinals = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
        const idx = Math.round(heading / 45) % 8;
        valEl.textContent = `${Math.round(heading)}° ${cardinals[idx] || 'N'}`;
    }
}

// --- Detailed (themed): clone #dashboardVisDetailed and drive each row.
// Mirrors the vertical 10-row panel produced by writeDetailedDashboardAss
// in src/assGenerator.js so the AE preview matches the actual export.
function makeDetailedDashboardPreview(contentEl) {
    contentEl.style.background = 'transparent';
    const source = document.getElementById('dashboardVisDetailed');
    if (!source) {
        contentEl.innerHTML = '<div style="color:#fff; padding:6px;">Detailed preview unavailable.</div>';
        return null;
    }
    const clone = source.cloneNode(true);
    clone.id = '';
    // The template is intentionally `display:none` at rest; strip that and
    // make sure the clone fills the tile.
    clone.style.cssText = [
        'position: absolute',
        'top: 0', 'left: 0',
        'width: 100%', 'height: 100%',
        'display: flex',
        'pointer-events: none',
        'z-index: 1',
    ].join(';');
    clone.removeAttribute('aria-hidden');
    // NOTE: do NOT call applyDetailedScales(clone) here — writing the scale
    // vars inline on the clone shadows the parent .ae-tile's vars (inline
    // styles win over inherited values), so subsequent slider changes that
    // update the tile-level vars would be ignored until a full remount.
    // Vars are seeded on the .ae-tile by mountOverlay()'s tail
    // (applyDashboardScales) and inherit down into the clone naturally.

    // Preview marker.
    const marker = document.createElement('div');
    marker.style.cssText = 'position:absolute; right:6px; top:4px; font-size:9px; color:#fff; opacity:.5; z-index:2; pointer-events:none;';
    marker.textContent = 'preview';
    clone.appendChild(marker);

    contentEl.appendChild(clone);

    return {
        update({ sei, absTimestampMs }) {
            if (!sei && !absTimestampMs) return;
            updateDetailedThemed(clone, sei, absTimestampMs, !!depsRef?.getUseMetric?.());
        },
        dispose() { clone.remove(); }
    };
}

function updateDetailedThemed(scope, sei, absTimestampMs, useMetric) {
    // Date/time header
    if (absTimestampMs) {
        const d = new Date(absTimestampMs);
        const dt = scope.querySelector('.dvd-datetime');
        if (dt) dt.textContent = `${formatDate(d, window._dateFormat || 'mdy')} ${formatClock(d, window._timeFormat || '12h')}`;
    }
    if (!sei) return;
    const get = (camel, snake) => sei[camel] ?? sei[snake];

    // Speed
    const mps = Math.abs(get('vehicleSpeedMps', 'vehicle_speed_mps') || 0);
    const speed = useMetric ? Math.round(mps * MPS_TO_KMH) : Math.round(mps * MPS_TO_MPH);
    const speedEl = scope.querySelector('.dvd-speed-value');
    const speedUnit = scope.querySelector('.dvd-speed-unit');
    if (speedEl) speedEl.textContent = String(speed);
    if (speedUnit) speedUnit.textContent = useMetric ? 'KM/H' : 'MPH';

    // Gear (uppercased to match ASS output)
    const gear = get('gearState', 'gear_state');
    const gearText = gear === 0 ? 'PARK' : gear === 1 ? 'DRIVE' : gear === 2 ? 'REVERSE' : gear === 3 ? 'NEUTRAL' : '--';
    const gearEl = scope.querySelector('.dvd-gear-value');
    if (gearEl) gearEl.textContent = gearText;

    // Steering — rotate the icon + show angle text
    const angle = Math.round(get('steeringWheelAngle', 'steering_wheel_angle') || 0);
    const steerIcon = scope.querySelector('.dvd-steering-icon');
    if (steerIcon) steerIcon.style.transform = `rotate(${angle}deg)`;
    const steerAngle = scope.querySelector('.dvd-steering-angle');
    if (steerAngle) steerAngle.textContent = `${angle}°`;

    // Autopilot active turns the wheel orange in the ASS render — apply the
    // `active` class to the icon WRAPPER (the CSS keys highlighting off that).
    const apState = get('autopilotState', 'autopilot_state');
    const apActive = apState === 1 || apState === 2;
    const steerWrap = scope.querySelector('.dvd-steering-icon-wrap');
    if (steerWrap) steerWrap.classList.toggle('active', apActive);

    // Accelerator — % number + fill bar
    const accelRaw = get('acceleratorPedalPosition', 'accelerator_pedal_position') || 0;
    const accelPct = Math.round(accelRaw > 1 ? Math.min(100, accelRaw) : Math.min(100, accelRaw * 100));
    const accelPctEl = scope.querySelector('.dvd-accel-pct');
    if (accelPctEl) accelPctEl.textContent = `${accelPct}%`;
    const accelFill = scope.querySelector('.dvd-accel-fill');
    if (accelFill) accelFill.style.width = `${accelPct}%`;

    // Brake — ON in red, OFF in white
    const brake = !!get('brakeApplied', 'brake_applied');
    const brakeEl = scope.querySelector('.dvd-brake-state');
    if (brakeEl) {
        brakeEl.textContent = brake ? 'ON' : 'OFF';
        brakeEl.classList.toggle('on', brake);
    }

    // Blinkers
    const leftOn = !!get('blinkerOnLeft', 'blinker_on_left');
    const rightOn = !!get('blinkerOnRight', 'blinker_on_right');
    const bL = scope.querySelector('.dvd-blink-left');
    const bR = scope.querySelector('.dvd-blink-right');
    if (bL) bL.classList.toggle('active', leftOn);
    if (bR) bR.classList.toggle('active', rightOn);

    // Autopilot state text
    let apText = 'OFF';
    if (apState === 1) apText = 'FSD SUPERVISED';
    else if (apState === 2) apText = 'AUTOPILOT';
    else if (apState === 3) apText = 'TACC';
    const apEl = scope.querySelector('.dvd-ap-state');
    if (apEl) {
        apEl.textContent = apText;
        apEl.classList.toggle('active', apActive || apState === 3);
    }

    // GPS — coords + "Heading: X.X°" (matches ASS render format)
    const lat = get('latitudeDeg', 'latitude_deg');
    const lon = get('longitudeDeg', 'longitude_deg');
    const heading = get('headingDeg', 'heading_deg');
    const coordsEl = scope.querySelector('.dvd-gps-coords');
    const headingEl = scope.querySelector('.dvd-gps-heading');
    if (coordsEl) {
        coordsEl.textContent = (typeof lat === 'number' && typeof lon === 'number')
            ? `${lat.toFixed(6)}, ${lon.toFixed(6)}`
            : '--, --';
    }
    if (headingEl) {
        headingEl.textContent = (typeof heading === 'number')
            ? `Heading: ${heading.toFixed(1)}°`
            : 'Heading: --';
    }

    // G-Force — "Lateral: +X.XX G" / "Longitudinal: +X.XX G" (matches ASS)
    const GRAVITY = 9.81;
    const accX = get('linearAccelerationMps2X', 'linear_acceleration_mps2_x') || 0;
    const accY = get('linearAccelerationMps2Y', 'linear_acceleration_mps2_y') || 0;
    const gLat = accX / GRAVITY;
    const gLon = accY / GRAVITY;
    const gLatEl = scope.querySelector('.dvd-gforce-lat');
    const gLonEl = scope.querySelector('.dvd-gforce-lon');
    if (gLatEl) gLatEl.textContent = `Lateral: ${(gLat >= 0 ? '+' : '')}${gLat.toFixed(2)} G`;
    if (gLonEl) gLonEl.textContent = `Longitudinal: ${(gLon >= 0 ? '+' : '')}${gLon.toFixed(2)} G`;
}

// --- Tesla Mobile date bar (top tile).
// Clones #dashboardVisTeslaMobileDate and re-renders the centered date/time
// text from the SEI/timestamp on each update. Matches the ASS format
// "Day, Month D, YYYY   H:MM AM/PM" produced by writeTeslaMobileDashboardAss.
function makeTeslaMobileDatePreview(contentEl) {
    contentEl.style.background = 'transparent';
    const source = document.getElementById('dashboardVisTeslaMobileDate');
    if (!source) {
        contentEl.innerHTML = '<div style="color:#fff; padding:6px;">Tesla Mobile date preview unavailable.</div>';
        return null;
    }
    const clone = source.cloneNode(true);
    clone.id = '';
    clone.removeAttribute('aria-hidden');
    // Source template carries `.hidden` (global rule: display:none !important).
    // The clone must NOT inherit it, or the panel never renders inside the tile.
    clone.classList.remove('hidden');
    contentEl.appendChild(clone);

    const dateTextEl = clone.querySelector('.dvm-date-text');

    // Drive font-size from the tile's pixel height every resize.
    // Earlier `cqh` approach was either flaky or being collapsed to 0 in
    // the Electron build at small tile heights — measured pixel math is
    // bulletproof. Target: text fills ~78% of tile height (so even a 30px
    // skinny date bar still renders ~23px of legible white text), but
    // also fits within the tile width with 8px side padding. User scale
    // multiplier from the Date Bar Size dropdown is applied on top.
    const fitDateText = () => {
        if (!dateTextEl || !contentEl.isConnected) return;
        const tileH = contentEl.clientHeight;
        const tileW = contentEl.clientWidth;
        if (tileH <= 0 || tileW <= 0) return;
        const userScale = advancedEditorState.settings?.dashboardDateValueScale ?? 1;
        // Start with 78% of tile height. Clamp to a minimum of 10px so the
        // text never disappears entirely on tiny tiles.
        let target = Math.max(10, tileH * 0.78);
        target = target * userScale;
        // Then shrink to fit width if the rendered text would overflow.
        dateTextEl.style.fontSize = `${target}px`;
        const measured = dateTextEl.scrollWidth;
        const available = Math.max(40, tileW - 16); // matches CSS 8px padding × 2
        if (measured > available) {
            target = target * (available / measured);
            target = Math.max(10, target);
            dateTextEl.style.fontSize = `${target}px`;
        }
    };

    let ro = null;
    if ('ResizeObserver' in window) {
        ro = new ResizeObserver(fitDateText);
        ro.observe(contentEl);
    }
    // Initial fit on the next frame (clientWidth/Height settle then).
    requestAnimationFrame(fitDateText);

    return {
        update({ absTimestampMs }) {
            if (!dateTextEl) return;
            if (absTimestampMs) {
                dateTextEl.textContent = formatTeslaMobileDateString(new Date(absTimestampMs));
            }
            // Re-fit after text change in case width crossed the threshold.
            fitDateText();
        },
        refit: fitDateText,
        dispose() {
            try { if (ro) ro.disconnect(); } catch {}
            clone.remove();
        }
    };
}

// Matches the ASS render exactly: "Monday, May 16, 2026   9:39 PM"
function formatTeslaMobileDateString(d) {
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];
    const dayName = dayNames[d.getDay()];
    const monthName = monthNames[d.getMonth()];
    const dayNum = d.getDate();
    const year = d.getFullYear();
    // Tesla Mobile uses minute-precision (no seconds), 12h or 24h per setting.
    const timeFormat = window._timeFormat || '12h';
    let timeStr;
    if (timeFormat === '24h') {
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        timeStr = `${hh}:${mm}`;
    } else {
        let h = d.getHours();
        const ampm = h >= 12 ? 'PM' : 'AM';
        h = h % 12; if (h === 0) h = 12;
        const mm = String(d.getMinutes()).padStart(2, '0');
        timeStr = `${h}:${mm} ${ampm}`;
    }
    return `${dayName}, ${monthName} ${dayNum}, ${year}   ${timeStr}`;
}

// --- Tesla Mobile data bar (bottom tile).
// Clones #dashboardVisTeslaMobileData and drives each circle/icon by class
// to mirror the ASS render: brake/gear/blinkers/speed/AP/steering/accel.
// Blinker animation is intentionally OMITTED — we just show the current
// SEI frame's on/off state, which matches scrub usage better.
function makeTeslaMobileDataPreview(contentEl) {
    contentEl.style.background = 'transparent';
    const source = document.getElementById('dashboardVisTeslaMobileData');
    if (!source) {
        contentEl.innerHTML = '<div style="color:#fff; padding:6px;">Tesla Mobile data preview unavailable.</div>';
        return null;
    }
    const clone = source.cloneNode(true);
    clone.id = '';
    clone.removeAttribute('aria-hidden');
    // Source template carries `.hidden` (global rule: display:none !important).
    // The clone must NOT inherit it, or the bar never renders inside the tile.
    clone.classList.remove('hidden');
    contentEl.appendChild(clone);

    return {
        update({ sei }) {
            if (!sei) return;
            updateTeslaMobileDataScoped(clone, sei, !!depsRef?.getUseMetric?.());
        },
        dispose() { clone.remove(); }
    };
}

function updateTeslaMobileDataScoped(scope, sei, useMetric) {
    const get = (camel, snake) => sei[camel] ?? sei[snake];

    // Speed
    const mps = Math.abs(get('vehicleSpeedMps', 'vehicle_speed_mps') || 0);
    const speed = useMetric ? Math.round(mps * MPS_TO_KMH) : Math.round(mps * MPS_TO_MPH);
    const speedNum = scope.querySelector('.dvm-speed-num');
    const speedUnit = scope.querySelector('.dvm-speed-unit');
    if (speedNum) speedNum.textContent = String(speed);
    if (speedUnit) speedUnit.textContent = useMetric ? 'KM/H' : 'MPH';

    // Gear letter (matches ASS: D/R/P/N/--)
    const gear = get('gearState', 'gear_state');
    const gearLetter = gear === 1 ? 'D' : gear === 2 ? 'R' : gear === 0 ? 'P' : gear === 3 ? 'N' : '--';
    const gearLetterEl = scope.querySelector('.dvm-gear-letter');
    if (gearLetterEl) gearLetterEl.textContent = gearLetter;

    // Autopilot — text + color + drives the gear circle's accent color.
    const apState = get('autopilotState', 'autopilot_state');
    const apActive = apState === 1 || apState === 2;
    // Tesla Mobile ASS uses short labels — match getApText() ('AUTOPILOT'/'FSD'/'TACC'/'OFF').
    const apText = apState === 1 ? 'FSD' : apState === 2 ? 'AUTOPILOT' : apState === 3 ? 'TACC' : 'OFF';
    const apEl = scope.querySelector('.dvm-ap');
    if (apEl) {
        apEl.textContent = apText;
        apEl.classList.toggle('on', apActive);
    }
    const gearCircle = scope.querySelector('.dvm-circle.gear');
    if (gearCircle) gearCircle.classList.toggle('ap-on', apActive);

    // Blinkers — static (no flash animation in the preview)
    const leftOn = !!get('blinkerOnLeft', 'blinker_on_left');
    const rightOn = !!get('blinkerOnRight', 'blinker_on_right');
    const arrowLeft = scope.querySelector('.dvm-arrow.left');
    const arrowRight = scope.querySelector('.dvm-arrow.right');
    if (arrowLeft) arrowLeft.classList.toggle('on', leftOn);
    if (arrowRight) arrowRight.classList.toggle('on', rightOn);

    // Brake — circle background and icon both flip on
    const brakeActive = !!get('brakeApplied', 'brake_applied');
    const brakeCircle = scope.querySelector('.dvm-circle.brake');
    if (brakeCircle) brakeCircle.classList.toggle('on', brakeActive);

    // Accelerator — circle on when pedal > 5%
    const accelRaw = get('acceleratorPedalPosition', 'accelerator_pedal_position') || 0;
    const accelPct = accelRaw > 1 ? Math.min(100, accelRaw) : Math.min(100, accelRaw * 100);
    const accelActive = accelPct > 5;
    const accelCircle = scope.querySelector('.dvm-circle.accel');
    if (accelCircle) accelCircle.classList.toggle('on', accelActive);

    // Steering wheel — rotate the SVG (ASS uses negative angle to match real wheel)
    const angle = get('steeringWheelAngle', 'steering_wheel_angle') || 0;
    const steeringIcon = scope.querySelector('.dvm-steering-icon');
    if (steeringIcon) steeringIcon.style.transform = `rotate(${-angle}deg)`;
    const steeringCircle = scope.querySelector('.dvm-circle.steering');
    if (steeringCircle) steeringCircle.classList.toggle('on', apActive);
}

// --- Tesla Screen Dash: HUD-style.
function makeTeslaScreenDashPreview(contentEl) {
    contentEl.style.background = 'rgba(20,20,25,0.92)';
    contentEl.style.borderRadius = '6px';
    contentEl.innerHTML = `
        <div style="display:grid; grid-template-rows:1fr auto; gap:4px;
                    width:100%; height:100%; padding:8px; box-sizing:border-box;
                    color:#fff; font-family:Arial,sans-serif;">
            <div style="display:flex; align-items:center; justify-content:center; gap:10px;">
                <div style="display:flex; flex-direction:column; align-items:center;">
                    <div class="ae-tsd-speed" style="font-size:clamp(22px,7vmin,46px); font-weight:bold;">0</div>
                    <div class="ae-tsd-unit" style="font-size:clamp(9px,2.5vmin,12px); opacity:.7;">MPH</div>
                </div>
                <div class="ae-tsd-ap" style="font-size:clamp(10px,3vmin,14px); padding:2px 8px; border-radius:8px; background:rgba(255,255,255,0.08); opacity:.85;">Manual</div>
            </div>
            <div style="display:flex; align-items:center; justify-content:space-between; font-size:clamp(9px,2.5vmin,12px);">
                <span class="ae-tsd-gear" style="font-weight:bold;">--</span>
                <span class="ae-tsd-blinkers" style="opacity:.7;">◀ ▶</span>
                <span class="ae-tsd-steer" style="opacity:.7;">0°</span>
            </div>
        </div>
        <div style="position:absolute; right:4px; top:2px; font-size:9px; color:#fff; opacity:.5;">preview</div>
    `;
    return {
        update({ sei }) {
            if (!sei) return;
            const useMetric = !!depsRef?.getUseMetric?.();
            const get = (a, b) => sei[a] ?? sei[b];
            const mps = Math.abs(get('vehicleSpeedMps', 'vehicle_speed_mps') || 0);
            const speed = useMetric ? Math.round(mps * MPS_TO_KMH) : Math.round(mps * MPS_TO_MPH);
            contentEl.querySelector('.ae-tsd-speed').textContent = String(speed);
            contentEl.querySelector('.ae-tsd-unit').textContent = useMetric ? 'KM/H' : 'MPH';
            const gear = get('gearState', 'gear_state');
            contentEl.querySelector('.ae-tsd-gear').textContent = ['P','D','R','N'][gear] || '--';
            const ap = get('autopilotState', 'autopilot_state');
            const apTxt = ap === 1 ? 'FSD Active' : ap === 2 ? 'Autosteer' : ap === 3 ? 'TACC' : 'Manual';
            contentEl.querySelector('.ae-tsd-ap').textContent = apTxt;
            const leftOn = !!get('blinkerOnLeft','blinker_on_left');
            const rightOn = !!get('blinkerOnRight','blinker_on_right');
            contentEl.querySelector('.ae-tsd-blinkers').textContent =
                `${leftOn ? '◀' : '◁'} ${rightOn ? '▶' : '▷'}`;
            const angle = Math.round(get('steeringWheelAngle', 'steering_wheel_angle') || 0);
            contentEl.querySelector('.ae-tsd-steer').textContent = `${angle}°`;
        },
        dispose() {}
    };
}

// --------------------------------------------------------------------------
// Misc helpers
// --------------------------------------------------------------------------

function findSegmentIdx(cumStarts, cumSec) {
    if (!cumStarts || cumStarts.length < 2) return 0;
    for (let i = 0; i < cumStarts.length - 1; i++) {
        if (cumSec >= cumStarts[i] && cumSec < cumStarts[i + 1]) return i;
    }
    return cumStarts.length - 2;
}

// Convert YYYY-MM-DD_HH-MM-SS to epoch ms (local). Returns null if invalid.
function parseTimestampKeyMs(key) {
    if (!key || typeof key !== 'string') return null;
    const m = key.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const [, y, mo, d, h, mi, s] = m;
    return new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
}
