// Advanced Editor — canvas controller.
// Owns tile creation, rendering, drag, resize, selection. Snap logic lives
// in snapEngine.js and is invoked from here during drag/resize.

import { advancedEditorState, cameraTileId, overlayTileId,
         parseTileId, clampTileToCanvas } from './state.js';
import { CAMERA_FALLBACK_RATIOS, detectNativeAspects } from './aspectRatio.js';
import { snapPositionAndSize } from './snapEngine.js';

// Default canvas tile order (mirrors layoutLab.js camera order)
const CAMERA_ORDER = [
    'left_pillar', 'front', 'right_pillar',
    'left_repeater', 'back', 'right_repeater'
];

// 'dashboardDate' is conditionally created — only when dashboardStyle is
// 'tesla-mobile' (see DASHBOARD_STYLE_TILES below). It's included here so
// buildLayout will pick it up when overlaysEnabled.dashboardDate is set.
const OVERLAY_KEYS = ['timestamp', 'dashboard', 'minimap', 'dashboardDate'];

const OVERLAY_LABELS = {
    timestamp: 'Timestamp',
    dashboard: 'Dashboard',
    dashboardDate: 'Date Bar',
    minimap: 'GPS Minimap',
};

// Per-style mapping of which dashboard tile(s) should exist on the canvas.
// Tesla Mobile renders a separate date bar that the user can move/size
// independently from the dashboard data bar — every other style is a
// single-tile overlay. Used by applyDashboardTilesForStyle() to drive the
// set-diff (add/remove/reset) when the user switches styles.
const DASHBOARD_STYLE_TILES = {
    compact:             ['dashboard'],
    default:             ['dashboard'],
    detailed:            ['dashboard'],
    'tesla-mobile':      ['dashboard', 'dashboardDate'],
    'tesla-screen-dash': ['dashboard'],
};

export function dashboardTilesForStyle(style) {
    return DASHBOARD_STYLE_TILES[style] || ['dashboard'];
}

const CAMERA_LABELS = {
    front: 'Front',
    back: 'Back',
    left_repeater: 'Left Repeater',
    right_repeater: 'Right Repeater',
    left_pillar: 'Left Pillar',
    right_pillar: 'Right Pillar',
};

// Magnitudes below which we treat the user's mouse delta as "no movement".
const MIN_DELTA_PX = 0.5;

let depsRef = null;
let canvasEl = null;
let snapGuideX = null;
let snapGuideY = null;

export function initCanvasController(deps) {
    depsRef = deps;
    canvasEl = document.getElementById('aeCanvas');
    snapGuideX = document.getElementById('aeSnapGuideX');
    snapGuideY = document.getElementById('aeSnapGuideY');

    if (!canvasEl) {
        console.warn('[AE] aeCanvas element missing.');
        return;
    }

    // Click anywhere on the canvas (outside a tile) deselects.
    canvasEl.addEventListener('mousedown', (e) => {
        if (e.target === canvasEl) selectTile(null);
    });

    ensureCanvasResizeObserver();

    // Track Shift for aspect override during resize.
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Shift') advancedEditorState.interaction.shiftHeld = true;
    });
    window.addEventListener('keyup', (e) => {
        if (e.key === 'Shift') advancedEditorState.interaction.shiftHeld = false;
    });
}

// --------------------------------------------------------------------------
// Layout setup — called on modal open
// --------------------------------------------------------------------------

// Snapshot the current tile positions so the layout survives a close→open
// cycle. Called from closeAdvancedEditor. The snapshot lives only in
// memory — an app restart wipes it and the AE falls back to defaults.
export function snapshotTileLayout() {
    const snap = new Map();
    for (const [id, tile] of advancedEditorState.tiles.entries()) {
        snap.set(id, { x: tile.x, y: tile.y, w: tile.w, h: tile.h });
    }
    advancedEditorState.sessionLayoutSnapshot = snap;
}

export async function buildLayout({ selectedCameras, overlaysEnabled }) {
    advancedEditorState.tiles.clear();
    if (canvasEl) canvasEl.querySelectorAll('.ae-tile').forEach(el => el.remove());

    // Capture canvas pixel dimensions for hit testing.
    measureCanvas();

    // Within-session layout cache: if the user closed and reopened AE in the
    // same app run, restore each tile's last-known position from here. Fresh
    // app launches start with snapshot=null and fall through to defaults.
    const snap = advancedEditorState.sessionLayoutSnapshot;

    // No persistence: every open starts with fresh defaults — same behavior
    // as the simple modal's Layout Lab. This is intentional. Persistence was
    // causing stale positions from previous sessions to "leak" into the
    // default grid, producing mismatched tile widths and confusing snap
    // behavior. If you want a custom layout, drag tiles within the session.

    // Native aspect ratios — fall back to defaults; refined as videos load.
    const aspects = detectNativeAspects(advancedEditorState.videoElements);

    // Default grid. Tile shape matches camera aspect so there are no
    // letterbox/pillarbox bars in the preview OR the exported video.
    const camsList = CAMERA_ORDER.filter(c => selectedCameras.has(c));
    const sampleAspect = aspects[camsList[0]] || 1.543;
    const canvasAspect = advancedEditorState.canvas.widthPx > 0 && advancedEditorState.canvas.heightPx > 0
        ? advancedEditorState.canvas.widthPx / advancedEditorState.canvas.heightPx
        : 16 / 9;
    const defaultCamLayout = computeDefaultGrid(camsList, sampleAspect, canvasAspect);
    // Snapshot the grid defaults so addCameraTile can restore a re-toggled
    // camera to its original slot (instead of dropping it at the scratch
    // top-left default). Cleared every buildLayout — represents THIS open's
    // initial layout, not a permanent preference.
    advancedEditorState.cameraDefaults.clear();
    for (const camera of camsList) {
        const d = defaultCamLayout[camera];
        if (d) advancedEditorState.cameraDefaults.set(camera, { x: d.x, y: d.y, w: d.w, h: d.h });
    }
    for (const camera of camsList) {
        const id = cameraTileId(camera);
        const dflt = defaultCamLayout[camera];
        const aspect = aspects[camera] || CAMERA_FALLBACK_RATIOS[camera] || 1.5;
        const s = snap?.get(id);
        advancedEditorState.tiles.set(id, {
            id,
            type: 'camera',
            name: camera,
            x: s?.x ?? dflt.x,
            y: s?.y ?? dflt.y,
            w: s?.w ?? dflt.w,
            h: s?.h ?? dflt.h,
            defaultX: dflt.x,
            defaultY: dflt.y,
            defaultW: dflt.w,
            defaultH: dflt.h,
            aspectLocked: true,
            nativeAspect: aspect,
            minW: 0.05,
            minH: 0.05,
            zIndex: 1,
            visible: true,
        });
    }

    // Overlay defaults (only created if enabled). The dashboard's INITIAL
    // placement depends on style — see dashboardDefaultGeometry() below —
    // but resize is free in all cases so users can shape the panel however
    // they want.
    const dashStyle = advancedEditorState.settings?.dashboardStyle;
    const defaultOverlayLayout = {
        timestamp:     { x: 0.40, y: 0.92, w: 0.20, h: 0.05 },
        dashboard:     dashboardDefaultGeometry(dashStyle, 'dashboard'),
        dashboardDate: dashboardDefaultGeometry(dashStyle, 'dashboardDate'),
        minimap:       { x: 0.78, y: 0.02, w: 0.20, h: 0.20 },
    };

    for (const overlay of OVERLAY_KEYS) {
        if (!overlaysEnabled[overlay]) continue;
        const id = overlayTileId(overlay);
        const dflt = defaultOverlayLayout[overlay];
        const s = snap?.get(id);

        // Dashboard tiles bypass the snap engine so the user can drop them
        // anywhere on the canvas without sibling/edge stickiness.
        const freelyPlaceable = (overlay === 'dashboard' || overlay === 'dashboardDate');

        advancedEditorState.tiles.set(id, {
            id,
            type: 'overlay',
            name: overlay,
            x: s?.x ?? dflt.x,
            y: s?.y ?? dflt.y,
            w: s?.w ?? dflt.w,
            h: s?.h ?? dflt.h,
            defaultX: dflt.x,
            defaultY: dflt.y,
            defaultW: dflt.w,
            defaultH: dflt.h,
            aspectLocked: false,
            nativeAspect: 1,
            minW: 0.05,
            minH: 0.03,
            zIndex: 10,
            visible: true,
            freelyPlaceable,
        });
    }

    renderAllTiles();
}

// Camera-aspect-aware default grid. Tiles preserve `cameraAspect` so the
// video fills each tile exactly (no letterbox).
//
// IMPORTANT: tile positions ALIGN WITH SNAP TARGETS. The snap engine offers
// canvas edges (0, center, 1) and sibling edges as snap targets. If defaults
// don't already sit on those targets, dragging a tile away and back will
// pull it to a *different* position than the default — confusing the user.
// So:
//   - X: tiles ABUT each other starting at canvas left (x=0). Each col is
//     at x = col/cols. When tile w = 1/cols, the right edge of the rightmost
//     tile sits at canvas right (snap target). All sibling edges line up.
//   - Y: tiles ABUT each other starting at canvas top (y=0). Each row is
//     at y = row * tileH. Row-1 top = canvas top (snap target). Row-2 top
//     = row-1 bottom (sibling snap). Bottom empty space sits below the grid.
//
// Canvas is 16:9 (aspect 1.778). For a 3×2 grid of cameras at aspect 1.543:
//   total grid aspect = 3 * 1.543 / 2 = 2.31 (wider than 16:9).
// So tile width is capped by canvasW, not by canvasH.
function computeDefaultGrid(cameras, cameraAspect, canvasAspect) {
    const n = cameras.length;
    if (n === 0) return {};
    let cols, rows;
    if (n <= 1)      { cols = 1; rows = 1; }
    else if (n <= 2) { cols = 2; rows = 1; }
    else if (n <= 4) { cols = 2; rows = 2; }
    else             { cols = 3; rows = 2; }

    // ALWAYS fill canvas horizontally — every column gets tileW = 1/cols, so
    // tiles abut at exact pixel boundaries and the rightmost tile's right
    // edge sits at canvas right (snap target).
    const tileW = 1 / cols;

    // Tile height preserves camera aspect when possible, capped at 1/rows so
    // all rows still fit. Uses the ACTUAL canvas aspect (passed in) so this
    // works whether the canvas is 16:9, square, or anything else.
    const ar = canvasAspect || 16 / 9;
    let tileH = (tileW / cameraAspect) * ar;
    tileH = Math.min(tileH, 1 / rows);

    // Center the grid vertically — empty black space inside the canvas is
    // split equally between top and bottom. Horizontal centering is also
    // applied (no-op when gridW = 1.0, which is the normal case).
    const gridW = tileW * cols;
    const gridH = tileH * rows;
    const offsetX = (1 - gridW) / 2;
    const offsetY = (1 - gridH) / 2;

    const layout = {};
    cameras.forEach((cam, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        layout[cam] = {
            x: offsetX + col * tileW,
            y: offsetY + row * tileH,
            w: tileW,
            h: tileH,
        };
    });
    return layout;
}

// --------------------------------------------------------------------------
// Add / remove tiles when sidebar toggles change
// --------------------------------------------------------------------------

export function addCameraTile(camera) {
    const id = cameraTileId(camera);
    if (advancedEditorState.tiles.has(id)) return;

    const aspects = detectNativeAspects(advancedEditorState.videoElements);
    const aspect = aspects[camera] || CAMERA_FALLBACK_RATIOS[camera] || 1.5;

    // Prefer the original grid slot the camera had at AE-open time — that
    // way un-toggling and re-toggling a camera puts it back where it was,
    // at its original size. Fall back to a small top-left default only if
    // there's no remembered slot (camera wasn't in the initial set).
    const remembered = advancedEditorState.cameraDefaults.get(camera);
    const placement = remembered || { x: 0.05, y: 0.05, w: 0.30, h: 0.30 };

    advancedEditorState.tiles.set(id, {
        id, type: 'camera', name: camera,
        x: placement.x, y: placement.y, w: placement.w, h: placement.h,
        defaultX: placement.x, defaultY: placement.y,
        defaultW: placement.w, defaultH: placement.h,
        aspectLocked: true,
        nativeAspect: aspect,
        minW: 0.05, minH: 0.05,
        zIndex: 1,
        visible: true,
    });
    createTileEl(advancedEditorState.tiles.get(id));
    renderTilePosition(advancedEditorState.tiles.get(id));
}

export function removeCameraTile(camera) {
    removeTile(cameraTileId(camera));
}

export function addOverlayTile(overlayKey) {
    const id = overlayTileId(overlayKey);
    if (advancedEditorState.tiles.has(id)) return;
    // Initial placement comes from dashboardDefaultGeometry() — see below.
    // Resize is free in all cases (text scales with container width via
    // cqi font sizes).
    const dashStyle = advancedEditorState.settings?.dashboardStyle;
    const defaults = {
        timestamp:     { x: 0.40, y: 0.92, w: 0.20, h: 0.05 },
        dashboard:     dashboardDefaultGeometry(dashStyle, 'dashboard'),
        dashboardDate: dashboardDefaultGeometry(dashStyle, 'dashboardDate'),
        minimap:       { x: 0.78, y: 0.02, w: 0.20, h: 0.20 },
    };
    const d = defaults[overlayKey] || { x: 0.3, y: 0.3, w: 0.2, h: 0.2 };
    const freelyPlaceable = (overlayKey === 'dashboard' || overlayKey === 'dashboardDate');

    advancedEditorState.tiles.set(id, {
        id, type: 'overlay', name: overlayKey,
        x: d.x, y: d.y, w: d.w, h: d.h,
        defaultX: d.x, defaultY: d.y, defaultW: d.w, defaultH: d.h,
        aspectLocked: false, nativeAspect: 1,
        minW: 0.05, minH: 0.03,
        zIndex: 10,
        visible: true,
        freelyPlaceable,
    });
    createTileEl(advancedEditorState.tiles.get(id));
    renderTilePosition(advancedEditorState.tiles.get(id));
}

export function removeOverlayTile(overlayKey) {
    removeTile(overlayTileId(overlayKey));
}

// Per-style default geometry for dashboard tiles. Each shape is sized to
// match what the corresponding renderer needs:
//   - compact      → thin horizontal bar at the bottom (matches the compact
//                    .dashboard-vis-compact panel).
//   - default      → wider, taller floating panel (the #dashboardVis floating
//                    widget is 480×260 with extras expanded — roughly 1.85:1).
//   - detailed     → tall narrow right-edge panel mirroring the
//                    writeDetailedDashboardAss default.
//   - tesla-mobile + 'dashboard'     → full-width data bar at the bottom
//                                      (where the dashboard data sits in the
//                                      legacy stacked layout).
//   - tesla-mobile + 'dashboardDate' → narrow centered date bar at the top.
//   - tesla-screen-dash              → falls back to compact shape (the
//                                      screen-dash HUD scales itself).
function dashboardDefaultGeometry(style, overlayKey = 'dashboard') {
    if (style === 'tesla-mobile') {
        // Match the ASS render's proportions exactly so users get the same
        // skinny look they'll see in the exported video:
        //   teslaMobileDashHeight = canvasW / 38  (main.js:595)
        //   teslaMobileDateHeight = canvasW / 45  (main.js:597)
        // In a 16:9 canvas, height = width × 9/16 = 0.5625 × width, so:
        //   dash h-frac = (W/38) / (0.5625W) ≈ 0.047
        //   date h-frac = (W/45) / (0.5625W) ≈ 0.040
        // Both bars span full width; data sits flush at the bottom and
        // date sits flush at the top (mirroring the FFmpeg pad layout
        // for non-AE Tesla Mobile exports).
        if (overlayKey === 'dashboardDate') return { x: 0.00, y: 0.00,  w: 1.00, h: 0.040 };
        return                                     { x: 0.00, y: 0.953, w: 1.00, h: 0.047 };
    }
    if (overlayKey === 'dashboardDate') {
        // Defensive: a date tile only exists for tesla-mobile, but if asked
        // for any other style return a small bar so nothing renders as 0×0.
        return { x: 0.00, y: 0.00, w: 1.00, h: 0.040 };
    }
    if (style === 'detailed') return { x: 0.78, y: 0.19, w: 0.20, h: 0.62 };
    if (style === 'default')  return { x: 0.20, y: 0.74, w: 0.60, h: 0.22 };
    return { x: 0.00, y: 0.84, w: 1.00, h: 0.14 };  // compact / fallback
}

// Switch the on-canvas dashboard tile(s) when the dashboard style changes.
// Computes a set-diff between the previous style's required tiles and the
// new style's required tiles, then:
//   - Removes overlay keys that are no longer needed (e.g. dashboardDate
//     when switching away from tesla-mobile)
//   - Adds overlay keys that are now needed (e.g. dashboardDate when
//     switching INTO tesla-mobile)
//   - Resets the geometry of surviving tiles to the new style's defaults
//     (so e.g. compact's bottom bar becomes tesla-mobile's bottom bar at
//     the same place, but switching detailed→compact reshapes the panel).
//
// Returns an object describing the diff so the caller can mount/unmount
// previews accordingly.
export function applyDashboardTilesForStyle(prevStyle, newStyle) {
    const prevSet = new Set(dashboardTilesForStyle(prevStyle));
    const nextSet = new Set(dashboardTilesForStyle(newStyle));

    const removed = [];
    const added = [];
    const survived = [];

    for (const key of prevSet) {
        if (!nextSet.has(key)) removed.push(key);
        else survived.push(key);
    }
    for (const key of nextSet) {
        if (!prevSet.has(key)) added.push(key);
    }

    for (const key of removed) {
        removeTile(overlayTileId(key));
    }
    for (const key of survived) {
        // Reset survivor geometry to the new style's default so e.g.
        // compact's thin bottom bar becomes the detailed right-edge panel
        // when the user picks Detailed.
        const tile = advancedEditorState.tiles.get(overlayTileId(key));
        if (!tile) continue;
        const dflt = dashboardDefaultGeometry(newStyle, key);
        tile.x = dflt.x; tile.y = dflt.y; tile.w = dflt.w; tile.h = dflt.h;
        tile.defaultX = dflt.x; tile.defaultY = dflt.y;
        tile.defaultW = dflt.w; tile.defaultH = dflt.h;
        renderTilePosition(tile);
    }
    for (const key of added) {
        addOverlayTile(key);
    }

    return { removed, added, survived };
}

// Back-compat shim — old name still re-exported but now just runs the
// single-tile reset path (no add/remove). Prefer applyDashboardTilesForStyle.
export function resetDashboardTileForStyle(style) {
    const tile = advancedEditorState.tiles.get(overlayTileId('dashboard'));
    if (!tile) return;
    const dflt = dashboardDefaultGeometry(style, 'dashboard');
    tile.x = dflt.x; tile.y = dflt.y; tile.w = dflt.w; tile.h = dflt.h;
    tile.defaultX = dflt.x; tile.defaultY = dflt.y;
    tile.defaultW = dflt.w; tile.defaultH = dflt.h;
    renderTilePosition(tile);
}

function removeTile(id) {
    advancedEditorState.tiles.delete(id);
    const el = canvasEl?.querySelector(`.ae-tile[data-tile-id="${cssEscape(id)}"]`);
    if (el) el.remove();
    if (advancedEditorState.selectedTileId === id) advancedEditorState.selectedTileId = null;
}

// --------------------------------------------------------------------------
// Rendering
// --------------------------------------------------------------------------

function renderAllTiles() {
    if (!canvasEl) return;
    canvasEl.querySelectorAll('.ae-tile').forEach(el => el.remove());
    for (const tile of advancedEditorState.tiles.values()) {
        createTileEl(tile);
        renderTilePosition(tile);
    }
}

function createTileEl(tile) {
    if (!canvasEl) return;
    const el = document.createElement('div');
    el.className = `ae-tile ae-tile-${tile.type}`;
    el.dataset.tileId = tile.id;
    el.dataset.tileType = tile.type;
    el.dataset.tileName = tile.name;
    el.style.zIndex = String(tile.zIndex);

    const label = tile.type === 'camera'
        ? (CAMERA_LABELS[tile.name] || tile.name)
        : (OVERLAY_LABELS[tile.name] || tile.name);
    const labelEl = document.createElement('div');
    labelEl.className = 'ae-tile-label';
    labelEl.textContent = label;
    el.appendChild(labelEl);

    // Inner content placeholder. Phase 8/9 will replace with <video> / overlay HTML.
    const contentEl = document.createElement('div');
    contentEl.className = tile.type === 'camera' ? 'ae-tile-video-placeholder' : 'ae-overlay-content';
    if (tile.type === 'camera') {
        contentEl.style.cssText = 'width:100%; height:100%; display:flex; align-items:center; justify-content:center; color:rgba(255,255,255,0.4); font-size:11px;';
        contentEl.textContent = `(${label} preview — video loads in Phase 8)`;
    } else {
        contentEl.style.cssText = 'width:100%; height:100%; display:flex; align-items:center; justify-content:center; color:rgba(255,255,255,0.5); font-size:11px; font-style:italic;';
        contentEl.textContent = `${label} overlay`;
    }
    el.appendChild(contentEl);

    // 8 resize handles — visible only on .selected via CSS.
    ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(h => {
        const handleEl = document.createElement('div');
        handleEl.className = `ae-handle ae-handle-${h}`;
        handleEl.dataset.handle = h;
        el.appendChild(handleEl);
    });

    // Wire interactions.
    el.addEventListener('mousedown', (e) => onTileMouseDown(e, tile));
    el.addEventListener('contextmenu', (e) => onTileContextMenu(e, tile));

    canvasEl.appendChild(el);
}

// --------------------------------------------------------------------------
// Z-order context menu
// --------------------------------------------------------------------------

let ctxMenuEl = null;

function onTileContextMenu(e, tile) {
    e.preventDefault();
    e.stopPropagation();
    showZOrderMenu(tile, e.clientX, e.clientY);
}

function showZOrderMenu(tile, clientX, clientY) {
    hideZOrderMenu();
    const menu = document.createElement('div');
    menu.className = 'ae-ctx-menu';
    menu.style.cssText = [
        'position: fixed',
        `left: ${clientX}px`,
        `top: ${clientY}px`,
        'background: rgba(20, 20, 25, 0.96)',
        'border: 1px solid oklch(0.82 0.18 150 / 0.35)',
        'border-radius: 6px',
        'padding: 4px 0',
        'min-width: 170px',
        'box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5)',
        'z-index: 100000',
        'font-family: inherit',
        'font-size: 12px',
        'user-select: none',
    ].join(';');

    const items = [
        { label: 'Bring to Front',     action: () => bringTileToFront(tile.id) },
        { label: 'Bring Forward',      action: () => moveTileForward(tile.id) },
        { label: 'Send Backward',      action: () => moveTileBackward(tile.id) },
        { label: 'Send to Back',       action: () => sendTileToBack(tile.id) },
    ];
    for (const it of items) {
        const btn = document.createElement('div');
        btn.textContent = it.label;
        btn.style.cssText = 'padding: 7px 14px; cursor: pointer; color: #fff;';
        btn.addEventListener('mouseenter', () => { btn.style.background = 'oklch(0.82 0.18 150 / 0.20)'; });
        btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            try { it.action(); } catch (err) { console.warn('[AE] ctx action failed:', err); }
            hideZOrderMenu();
        });
        menu.appendChild(btn);
    }
    document.body.appendChild(menu);
    ctxMenuEl = menu;

    // Keep menu on-screen: nudge it left/up if it overflows the viewport.
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 6}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 6}px`;

    // Dismiss on any outside click / Escape.
    const dismiss = (ev) => {
        if (ev.type === 'keydown' && ev.key !== 'Escape') return;
        hideZOrderMenu();
    };
    setTimeout(() => {
        document.addEventListener('mousedown', dismiss, { once: true });
        document.addEventListener('keydown', dismiss);
        menu._dismiss = dismiss;
    }, 0);
}

function hideZOrderMenu() {
    if (!ctxMenuEl) return;
    if (ctxMenuEl._dismiss) {
        document.removeEventListener('keydown', ctxMenuEl._dismiss);
    }
    ctxMenuEl.remove();
    ctxMenuEl = null;
}

// Z-index helpers — get the current min/max across all tiles so we can
// place a tile relative to them.
function zRange() {
    let min = Infinity, max = -Infinity;
    for (const t of advancedEditorState.tiles.values()) {
        if (t.zIndex < min) min = t.zIndex;
        if (t.zIndex > max) max = t.zIndex;
    }
    if (!Number.isFinite(min)) min = 1;
    if (!Number.isFinite(max)) max = 1;
    return { min, max };
}

function applyTileZIndex(tile) {
    const el = canvasEl?.querySelector(`.ae-tile[data-tile-id="${cssEscape(tile.id)}"]`);
    if (el) el.style.zIndex = String(tile.zIndex);
}

export function bringTileToFront(tileId) {
    const tile = advancedEditorState.tiles.get(tileId);
    if (!tile) return;
    const { max } = zRange();
    tile.zIndex = max + 1;
    applyTileZIndex(tile);
}

export function sendTileToBack(tileId) {
    const tile = advancedEditorState.tiles.get(tileId);
    if (!tile) return;
    const { min } = zRange();
    tile.zIndex = Math.max(1, min - 1);
    applyTileZIndex(tile);
}

export function moveTileForward(tileId) {
    const tile = advancedEditorState.tiles.get(tileId);
    if (!tile) return;
    tile.zIndex += 1;
    applyTileZIndex(tile);
}

export function moveTileBackward(tileId) {
    const tile = advancedEditorState.tiles.get(tileId);
    if (!tile) return;
    tile.zIndex = Math.max(1, tile.zIndex - 1);
    applyTileZIndex(tile);
}

function renderTilePosition(tile) {
    const el = canvasEl?.querySelector(`.ae-tile[data-tile-id="${cssEscape(tile.id)}"]`);
    if (!el) return;
    const W = advancedEditorState.canvas.widthPx;
    const H = advancedEditorState.canvas.heightPx;
    // Compute the right and bottom edges in pixel space, then derive width
    // from them. This guarantees that adjacent tiles (e.g. F at x=1/3 and RP
    // at x=2/3) abut at the SAME pixel boundary — otherwise rounding each
    // tile's left+width independently can leave 1-2px gaps between adjacent
    // tiles when w * W produces a non-integer.
    const left   = Math.round(tile.x * W);
    const top    = Math.round(tile.y * H);
    const right  = Math.round((tile.x + tile.w) * W);
    const bottom = Math.round((tile.y + tile.h) * H);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.width = `${right - left}px`;
    el.style.height = `${bottom - top}px`;
}

function renderAllPositions() {
    for (const tile of advancedEditorState.tiles.values()) renderTilePosition(tile);
}

function measureCanvas() {
    if (!canvasEl) return;
    advancedEditorState.canvas.el = canvasEl;
    // Use clientWidth/clientHeight (content + padding, NOT border) so tile
    // positioning is symmetric. getBoundingClientRect includes the 2px
    // canvas border on each side, which made tiles at x=1.0 extend past the
    // content area and get clipped on the right — but tiles at x=0 sat at
    // content left with no compensation, leaving an asymmetric gap.
    advancedEditorState.canvas.widthPx = canvasEl.clientWidth;
    advancedEditorState.canvas.heightPx = canvasEl.clientHeight;
}

// Called when the modal becomes visible OR the window resizes. A
// ResizeObserver also calls this whenever the canvas itself changes size —
// catches modal sizing transitions that don't fire window.resize (e.g. when
// the sidebar collapses/expands and the flex layout reflows the canvas).
export function onCanvasResize() {
    measureCanvas();
    renderAllPositions();
}

let canvasResizeObserver = null;
function ensureCanvasResizeObserver() {
    if (canvasResizeObserver || !canvasEl) return;
    if (typeof ResizeObserver === 'undefined') return;
    canvasResizeObserver = new ResizeObserver(() => {
        if (advancedEditorState.isOpen) onCanvasResize();
    });
    canvasResizeObserver.observe(canvasEl);
}

// --------------------------------------------------------------------------
// Selection
// --------------------------------------------------------------------------

function selectTile(id) {
    advancedEditorState.selectedTileId = id;
    if (!canvasEl) return;
    canvasEl.querySelectorAll('.ae-tile.selected').forEach(el => el.classList.remove('selected'));
    if (id) {
        const el = canvasEl.querySelector(`.ae-tile[data-tile-id="${cssEscape(id)}"]`);
        if (el) el.classList.add('selected');
    }
}

// --------------------------------------------------------------------------
// Drag / resize
// --------------------------------------------------------------------------

function onTileMouseDown(e, tile) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    measureCanvas();
    selectTile(tile.id);

    const W = advancedEditorState.canvas.widthPx;
    const H = advancedEditorState.canvas.heightPx;

    const isHandle = e.target?.classList?.contains('ae-handle');
    const handle = isHandle ? e.target.dataset.handle : null;

    advancedEditorState.interaction.mode = isHandle ? 'resize' : 'drag';
    advancedEditorState.interaction.handle = handle;
    advancedEditorState.interaction.startMouseX = e.clientX;
    advancedEditorState.interaction.startMouseY = e.clientY;
    advancedEditorState.interaction.startTileX = tile.x;
    advancedEditorState.interaction.startTileY = tile.y;
    advancedEditorState.interaction.startTileW = tile.w;
    advancedEditorState.interaction.startTileH = tile.h;

    const tileEl = canvasEl.querySelector(`.ae-tile[data-tile-id="${cssEscape(tile.id)}"]`);
    if (tileEl) tileEl.classList.add('dragging');

    const onMove = (mv) => {
        const dxPx = mv.clientX - advancedEditorState.interaction.startMouseX;
        const dyPx = mv.clientY - advancedEditorState.interaction.startMouseY;

        if (Math.abs(dxPx) < MIN_DELTA_PX && Math.abs(dyPx) < MIN_DELTA_PX
            && advancedEditorState.interaction.mode === 'drag') return;

        const proposedPx = computeProposedPx(tile, dxPx, dyPx, W, H);

        // Tiles flagged `freelyPlaceable: true` bypass the snap engine
        // entirely — they can be dropped anywhere on the canvas without
        // sticking to edges or sibling tiles. Used by dashboard and
        // dashboardDate (Tesla Mobile date bar) so users can position both
        // sections wherever they like. All other tiles snap normally.
        const isDashboardTile = tile.freelyPlaceable === true;

        // Run snap engine — pure math in pixels. Snap targets are only:
        // canvas edges/center + sibling edges/centers. (Matches layoutLab.js.)
        const otherTilesPx = [];
        for (const other of advancedEditorState.tiles.values()) {
            if (other.id === tile.id) continue;
            otherTilesPx.push({
                id: other.id,
                x: other.x * W, y: other.y * H,
                w: other.w * W, h: other.h * H,
            });
        }
        const snapped = isDashboardTile
            ? { ...proposedPx, guides: { x: null, y: null } }
            : snapPositionAndSize({
                draggedId: tile.id,
                proposed: proposedPx,
                mode: advancedEditorState.interaction.mode === 'drag'
                    ? 'drag'
                    : `resize-${advancedEditorState.interaction.handle}`,
                otherTiles: otherTilesPx,
                canvasW: W, canvasH: H,
                threshold: advancedEditorState.snap.thresholdPx,
                // Cameras: aspect is ALWAYS locked — Shift override is
                // disallowed so the user can never create a tile shape that
                // would force letterboxing/pillarboxing of the camera content.
                // Overlays still honor Shift so their containers can be
                // freely reshaped.
                aspectLocked: tile.aspectLocked && !(tile.type !== 'camera' && advancedEditorState.interaction.shiftHeld),
                nativeAspect: tile.nativeAspect,
            });

        // Apply snapped values (px) → tile (normalized).
        let newX = snapped.x;
        let newY = snapped.y;
        let newW = snapped.w;
        let newH = snapped.h;

        // Clamp to canvas in px before normalization.
        newW = Math.max(tile.minW * W, Math.min(newW, W));
        newH = Math.max(tile.minH * H, Math.min(newH, H));

        // Camera tiles: after clamping, re-enforce native aspect. The snap
        // engine respects aspectLocked, but axis-independent canvas-edge
        // clamping above can still drift the aspect (e.g. a tile dragged
        // past the right edge gets W capped without H adjusting). For
        // cameras we re-derive H from W (or W from H if H would overflow)
        // so the user can never end up with a tile shape that requires
        // letterboxing.
        if (tile.type === 'camera' && tile.nativeAspect) {
            const desiredH = newW / tile.nativeAspect;
            if (desiredH <= H) {
                newH = desiredH;
            } else {
                newH = H;
                newW = H * tile.nativeAspect;
            }
        }

        newX = Math.max(0, Math.min(newX, W - newW));
        newY = Math.max(0, Math.min(newY, H - newH));

        tile.x = newX / W;
        tile.y = newY / H;
        tile.w = newW / W;
        tile.h = newH / H;
        clampTileToCanvas(tile);
        renderTilePosition(tile);

        updateSnapGuides(snapped.guides);
    };

    const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (tileEl) tileEl.classList.remove('dragging');
        advancedEditorState.interaction.mode = null;
        advancedEditorState.interaction.handle = null;
        hideSnapGuides();
        };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

function computeProposedPx(tile, dxPx, dyPx, W, H) {
    const ix = advancedEditorState.interaction;
    const startX = ix.startTileX * W;
    const startY = ix.startTileY * H;
    const startW = ix.startTileW * W;
    const startH = ix.startTileH * H;

    if (ix.mode === 'drag') {
        return { x: startX + dxPx, y: startY + dyPx, w: startW, h: startH };
    }

    // Resize per handle.
    let x = startX, y = startY, w = startW, h = startH;
    const handle = ix.handle;

    if (handle.includes('e')) w = startW + dxPx;
    if (handle.includes('w')) { w = startW - dxPx; x = startX + dxPx; }
    if (handle.includes('s')) h = startH + dyPx;
    if (handle.includes('n')) { h = startH - dyPx; y = startY + dyPx; }

    // Enforce minimum size in px.
    const minW = tile.minW * W;
    const minH = tile.minH * H;
    if (w < minW) {
        if (handle.includes('w')) x -= (minW - w);
        w = minW;
    }
    if (h < minH) {
        if (handle.includes('n')) y -= (minH - h);
        h = minH;
    }
    return { x, y, w, h };
}

function updateSnapGuides(guides) {
    if (!snapGuideX || !snapGuideY) return;
    if (guides?.x != null) {
        snapGuideX.style.left = `${guides.x}px`;
        snapGuideX.classList.remove('hidden');
    } else {
        snapGuideX.classList.add('hidden');
    }
    if (guides?.y != null) {
        snapGuideY.style.top = `${guides.y}px`;
        snapGuideY.classList.remove('hidden');
    } else {
        snapGuideY.classList.add('hidden');
    }
}

function hideSnapGuides() {
    snapGuideX?.classList?.add('hidden');
    snapGuideY?.classList?.add('hidden');
}

// --------------------------------------------------------------------------
// Misc
// --------------------------------------------------------------------------

// Browser-safe CSS.escape polyfill for older Electron builds.
function cssEscape(s) {
    if (window.CSS?.escape) return window.CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`);
}

export function resetLayout() {
    const cameras = new Set();
    const overlays = {};
    for (const [id, t] of advancedEditorState.tiles.entries()) {
        const { type, name } = parseTileId(id);
        if (type === 'camera') cameras.add(name);
        else overlays[name] = true;
    }
    return buildLayout({ selectedCameras: cameras, overlaysEnabled: overlays });
}
