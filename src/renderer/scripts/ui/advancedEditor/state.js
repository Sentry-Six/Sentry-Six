// Advanced Editor — runtime state.
// All tile positions/sizes are normalized 0-1 (fractions of canvas dimensions)
// so they survive window resizes and map cleanly to whatever output resolution
// the user picks at export time.

export const advancedEditorState = {
    isOpen: false,

    canvas: {
        el: null,
        widthPx: 0,
        heightPx: 0,
    },

    // Tile id format: `camera:<cameraKey>` or `overlay:<overlayKey>`
    // overlayKey ∈ { 'timestamp', 'dashboard', 'minimap', 'dashboardDate' }
    //
    // 'dashboardDate' is a sibling overlay key that ONLY exists when the
    // dashboard style is 'tesla-mobile'. Tesla Mobile renders two visually
    // distinct sections (a date bar and a data bar) that the user can
    // position/size independently — each gets its own tile. All other
    // dashboard styles use the single 'dashboard' tile.
    //
    // Tiles can carry an optional `freelyPlaceable: true` flag — when set,
    // the snap engine is bypassed for that tile (canvas edges and sibling
    // edges don't pull it). Used by the dashboard and dashboardDate tiles
    // so the user can drop them anywhere on the canvas without sticky snap.
    tiles: new Map(),

    // Remembers the original grid position/size of every camera tile from
    // the most recent buildLayout(). When the user un-toggles a camera and
    // toggles it back on, addCameraTile uses this map to restore the tile to
    // its original slot/size instead of plopping it at a scratch top-left
    // default. Cleared and rebuilt by buildLayout() on every AE open.
    cameraDefaults: new Map(),   // cameraKey -> { x, y, w, h }

    // Within-session layout cache. snapshotTileLayout() writes here when the
    // AE closes; buildLayout() reads here on open. Survives close→open cycles
    // but is in-memory only — an app restart wipes it and the AE falls back
    // to fresh defaults. null = no snapshot yet (first open in this session).
    sessionLayoutSnapshot: null, // Map<tileId, { x, y, w, h }>


    selectedTileId: null,

    interaction: {
        mode: null,            // 'drag' | 'resize' | null
        handle: null,          // 'nw'|'n'|'ne'|'e'|'se'|'s'|'sw'|'w'
        startMouseX: 0,
        startMouseY: 0,
        startTileX: 0,
        startTileY: 0,
        startTileW: 0,
        startTileH: 0,
        shiftHeld: false,
    },

    snap: {
        thresholdPx: 35,        // bumped from 18 — easier to snap a moved tile back
                                // near its default (user's expectation: "drop near
                                // home and it snaps in")
        activeGuideX: null,
        activeGuideY: null,
    },

    playback: {
        currentSec: 0,
        startSec: 0,
        endSec: 0,
        isPlaying: false,
        masterVideoSlot: null,
        rafId: null,
        isUserScrubbing: false,
    },

    videoElements: new Map(),  // cameraKey -> HTMLVideoElement

    // SEI per segment for the AE's own playhead. nativeVideo.seiData only ever
    // holds the main player's currently-loaded segment, which makes it useless
    // for the AE when the user has set start/end markers in a different
    // segment than where main was paused. We pre-extract SEI per segment on
    // AE open so overlay lookups can compute SEI at any cumulative second
    // independent of the main player's state.
    aeSeiBySegment: new Map(),  // segIdx -> seiData (array of {timestampMs, sei})

    settings: {
        quality: 'high',
        enableTimelapse: false,
        timelapseSpeed: '8',
        includeTimestamp: true,
        includeDashboard: false,
        dashboardStyle: 'compact',
        dashboardLabelScale: 1,
        dashboardValueScale: 1,
        // Tesla Mobile only: independent scale for the date bar tile. Other
        // styles ignore these — the existing dashboardLabelScale/ValueScale
        // continues to drive the data bar / single-tile layouts.
        dashboardDateLabelScale: 1,
        dashboardDateValueScale: 1,
        includeMinimap: false,
        minimapRenderMode: 'ass',
        selectedCameras: new Set([
            'left_pillar', 'front', 'right_pillar',
            'left_repeater', 'back', 'right_repeater'
        ]),
    },
};

// (Tile layout is NOT persisted across sessions — mirrors the simple modal's
// Layout Lab, which also starts each open from defaults. Saved layouts were
// causing stale positions from prior sessions to leak in and produce
// mismatched tile widths. If session-to-session persistence is wanted later,
// reintroduce a key here and load it in buildLayout.)

// Coordinate helpers -------------------------------------------------------

export function normToPx(norm, canvasDim) {
    return Math.round(norm * canvasDim);
}

export function pxToNorm(px, canvasDim) {
    return canvasDim > 0 ? px / canvasDim : 0;
}

// Constrain a tile (normalized) to remain entirely within the unit square.
// Mutates the input. Respects per-tile minW/minH if present.
export function clampTileToCanvas(tile) {
    const minW = tile.minW ?? 0.02;
    const minH = tile.minH ?? 0.02;
    tile.w = Math.max(minW, Math.min(tile.w, 1));
    tile.h = Math.max(minH, Math.min(tile.h, 1));
    tile.x = Math.max(0, Math.min(tile.x, 1 - tile.w));
    tile.y = Math.max(0, Math.min(tile.y, 1 - tile.h));
}

// Camera ID helpers --------------------------------------------------------

export function cameraTileId(camera) { return `camera:${camera}`; }
export function overlayTileId(overlayKey) { return `overlay:${overlayKey}`; }

export function parseTileId(id) {
    const [type, name] = id.split(':');
    return { type, name };
}
