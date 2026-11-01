/**
 * Centralized runtime state for Tesla Replay.
 *
 * Goal: gradually migrate global variables in `script.js` into this single object,
 * so behavior is easier to reason about and transitions (single/multi/collection)
 * don't "poison" playback state.
 *
 * We intentionally start small: only cross-cutting state that affects many parts
 * of the app is migrated first (collection mode, event popout, multi focus, scrubbing).
 *
 * This file is designed to be extended over time:
 * - move mp4/frames/decoder into `state.player`
 * - move clipGroups/index into `state.library`
 * - move preview pipeline into `state.previews`
 */

function createInitialState() {
  return {
    // Current top-level mode. This will expand over time, but even a simple
    // explicit mode prevents subtle "poisoned state" bugs during transitions.
    mode: 'clip', // 'clip' | 'collection'

    player: {
      // Decoded frames for the current clip/segment
      frames: null,

      // WebCodecs decoder for clip mode
      decoder: null,

      // Playback loop state (shared by single/multi/collection timelines).
      playing: false,
      playTimer: null
    },

    // Library/index derived from the TeslaCam folder
    library: {
      profileId: 'tesla',
      sourceKind: 'tesla',
      capabilities: {
        telemetry: true,
        gps: true,
        dashboard: true,
        map: true,
        export: true,
        driveMatching: true
      },
      clipGroups: [],
      clipGroupById: new Map(),
      folderLabel: null,
      // Virtual day-level collections: Map<dayString, collection>
      dayCollections: new Map()
    },

    // Current selection (what the user has selected in the clip list / controls)
    selection: {
      selectedGroupId: null,
      selectedCamera: 'front'
    },

    // Multi-camera playback state
    multi: {
      enabled: false,
      layoutId: 'six_default',
      masterCamera: 'front',
      masterTimeIndex: 0,
      // Slot -> stream object (contains per-stream VideoDecoder etc.)
      streams: new Map()
    },

    // Lazy preview pipeline for the clip list (thumbnails + minimaps)
    previews: {
      cache: new Map(), // groupId -> { status, thumbDataUrl, pathPoints }
      observer: null,   // IntersectionObserver
      queue: [],
      inFlight: 0,
      maxConcurrency: 1
    },

    ui: {
      // Multi-cam tile focus (null or 'tl'|'tc'|'tr'|'bl'|'bc'|'br')
      multiFocusSlot: null,

      // Scrubbing flags/timers
      isScrubbing: false,
      collectionScrubPreviewTimer: null,

      // Floating panel visibility toggles
      dashboardEnabled: true,
      mapEnabled: true,

      // Native video playback mode (GPU-accelerated, smooth)
      nativeVideoMode: true,

      // Playback speed (0.5, 1, 2, 3, 4)
      playbackRate: 1
    },

    collection: {
      // When active, progress bar represents milliseconds from the collection start.
      // Shape is documented in script.js where it's created.
      active: null
    },

    // SentryUSB drive data integration
    sentryUsb: {
      // Path to the drive-data.json file (persisted in file-based settings)
      dataPath: null,

      // Computed Drive objects from grouping StoreData routes
      drives: [],

      // Set<number> of drive IDs that have matching clips in the loaded library
      hasFootage: new Set(),

      // Whether drive data has been successfully loaded
      loaded: false,

      // Whether drive data is currently being parsed
      loading: false,
    }
  };
}

// Singleton used by the app.
export const state = createInitialState();

