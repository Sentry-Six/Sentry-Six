import { MULTI_LAYOUTS, DEFAULT_MULTI_LAYOUT } from './scripts/lib/multiLayouts.js';
import { CLIPS_MODE_KEY, MULTI_LAYOUT_KEY, MULTI_ENABLED_KEY, SENTRY_CAMERA_HIGHLIGHT_KEY, SAVED_CAMERA_HIGHLIGHT_KEY } from './scripts/lib/storageKeys.js';
import { createClipsPanelMode } from './scripts/ui/panelMode.js';
import { filePathToUrl } from './scripts/lib/utils.js';
import { state } from './scripts/lib/state.js';
import { notify } from './scripts/ui/notifications.js';
import { showLoading, updateLoading, hideLoading, yieldToUI } from './scripts/ui/loadingOverlay.js';
import { updateGForceMeter, resetGForceMeter } from './scripts/ui/gforceMeter.js';
import { updateCompass, resetCompass } from './scripts/ui/compass.js';
import { initKeybindActions, initKeybindSettings, initGlobalKeybindListener } from './scripts/lib/keybinds.js';
import { initSteeringWheel, smoothSteeringTo, stopSteeringAnimation, resetSteeringWheel } from './scripts/ui/steeringWheel.js';
import { formatTimeHMS, updateTimeDisplayNew, updateRecordingTime } from './scripts/ui/timeDisplay.js';
import { 
    exportState, initExportModule, setExportMarker, updateExportMarkers, 
    updateExportButtonState, openExportModal, closeExportModal, reopenExportModal,
    updateExportRangeDisplay, updateExportSizeEstimate, checkFFmpegAvailability,
    startExport, cancelExport, confirmCancelExport, clearExportMarkers, renderSharedClipsList
} from './scripts/features/exportVideo.js';
import { initAutoUpdate } from './scripts/features/autoUpdate.js';
import { initWelcomeScreen, resetWelcomeScreen, showWelcomeScreen } from './scripts/features/welcomeScreen.js';
import { zoomPanState, initZoomPan, resetZoomPan, applyZoomPan, applyMirrorTransforms } from './scripts/ui/zoomPan.js';
import { initSettingsModalDeps, initSettingsModal, initDevSettingsModal, openDevSettings, initChangelogModal, initSettingsSearch } from './scripts/ui/settingsModal.js';
import { initWelcomeGuide, checkAndShowWelcomeGuide, resetWelcomeGuide, openWelcomeGuide } from './scripts/ui/welcomeGuide.js';
import { initDiagnostics, logDiagnosticEvent } from './scripts/ui/diagnostics.js';
import { 
    initCameraRearrange, initCustomCameraOrder, getCustomCameraOrder,
    resetCameraOrder, getEffectiveSlots, initCameraDragAndDrop, updateTileLabels, updateCompactDashboardPosition
} from './scripts/features/cameraRearrange.js';
import { initDraggablePanels, resetPanelPosition } from './scripts/ui/draggablePanels.js';
import { initAdvancedEditor, openAdvancedEditor } from './scripts/ui/advancedEditor/index.js';
import { initEventMarkers, updateEventTimelineMarker, updateEventCameraHighlight } from './scripts/ui/eventMarkers.js';
import { initSkipSeconds, skipSeconds } from './scripts/features/skipSeconds.js';
import { initMapVisualization, updateMapVisibility, updateMapMarker, clearMapMarker, getMapOrientation, setMapOrientation, getMapBearing } from './scripts/ui/mapVisualization.js';
import { attachTileLayer } from './scripts/ui/mapTiles.js';
import { initDashboardVisibility, updateDashboardVisibility, setDashboardParked } from './scripts/ui/dashboardVisibility.js';
import { hasValidGps, extractSeiFromEntry, findSeiAtTime } from './scripts/core/seiExtractor.js';
import { 
    getRootFolderNameFromWebkitRelativePath, cameraLabel, buildTeslaCamIndex, buildDayCollections
} from './scripts/core/teslaCamIndex.js';
import { initMultiCamFocus, clearMultiFocus, toggleMultiFocus, scheduleResync, syncMultiVideos } from './scripts/ui/multiCamFocus.js';
import {
    initClipBrowser, renderClipList, highlightSelectedClip,
    buildDisplayItems, parseTimestampKeyToEpochMs
} from './scripts/core/clipBrowser.js';
import { matchClipsTodrives } from './scripts/core/driveGrouper.js';
import { initDriveBrowser, renderDriveList, setDriveTagFilter } from './scripts/core/driveBrowser.js';
import { initI18n, t, onLanguageChange } from './scripts/lib/i18n.js';

// State
const player = state.player;
const library = state.library;
const selection = state.selection;
const multi = state.multi;
const previews = state.previews;
let seiType = null;
let enumFields = null;

// Sentry event metadata (event.json)
// Keyed by `${tag}/${eventId}` (e.g. `SentryClips/2025-12-11_17-58-00`)
const eventMetaByKey = new Map(); // key -> parsed JSON object

// DOM Elements
const $ = id => document.getElementById(id);
const dropOverlay = $('dropOverlay');
const folderInput = $('folderInput');
const overlayChooseFolderBtn = $('overlayChooseFolderBtn');
const loadingOverlay = $('loadingOverlay');
const loadingText = $('loadingText');
const loadingProgress = $('loadingProgress');
const loadingBar = $('loadingBar');
// Main video element (for single camera mode)
const videoMain = $('videoMain');
const progressBar = $('progressBar');
const playBtn = $('playBtn');
const skipBackBtn = $('skipBackBtn');
const skipForwardBtn = $('skipForwardBtn');
const dashboardVis = $('dashboardVis');
const videoContainer = $('videoContainer');
const clipList = $('clipList');
const clipBrowserSubtitle = $('clipBrowserSubtitle');
const dayFilter = $('dayFilter');
const chooseFolderBtn = $('chooseFolderBtn');
const clipsCollapseBtn = $('clipsCollapseBtn');
// Drives panel elements
const driveList = $('driveList');
const clipDriveTabBar = $('clipDriveTabBar');
const drivesTabCount = $('drivesTabCount');
const driveTagFilter = $('driveTagFilter');
const clipBrowserDayfilter = $('clipBrowserDayfilter');
const driveTagFilterRow = $('driveTagFilterRow');
const cameraSelect = $('cameraSelect');
const autoplayToggle = $('autoplayToggle');
const multiCamToggle = $('multiCamToggle');
const dashboardToggle = $('dashboardToggle');
const mapToggle = $('mapToggle');
const speedSelect = $('speedSelect');
const multiLayoutSelect = $('multiLayoutSelect');
const multiCamGrid = $('multiCamGrid');
// Video elements for 6-camera grid (slots: tl, tc, tr, bl, bc, br)
const videoTL = $('videoTL');
const videoTC = $('videoTC');
const videoTR = $('videoTR');
const videoBL = $('videoBL');
const videoBC = $('videoBC');
const videoBR = $('videoBR');

// Video element map by slot
const videoBySlot = {
    tl: videoTL, tc: videoTC, tr: videoTR,
    bl: videoBL, bc: videoBC, br: videoBR
};

// URL object references for cleanup
const videoUrls = new Map(); // video element -> objectURL

// Visualization Elements
const speedValue = $('speedValue');
const gearState = $('gearState');
const blinkLeft = $('blinkLeft');
const blinkRight = $('blinkRight');
const speedUnit = $('speedUnit');
const autosteerIcon = $('autosteerIcon');
const accelPedal = $('accelPedal');
const accelFill = $('accelFill');

// Compact dashboard elements (cached to avoid 36fps getElementById calls)
const speedValueCompact = $('speedValueCompact');
const speedUnitCompact = $('speedUnitCompact');
const gearStateCompact = $('gearStateCompact');
const blinkLeftCompact = $('blinkLeftCompact');
const blinkRightCompact = $('blinkRightCompact');
const steeringIconCompact = $('steeringIconCompact');
const autosteerIconCompact = $('autosteerIconCompact');
const apTextCompact = $('apTextCompact');
const brakeIconCompact = $('brakeIconCompact');
const accelPedalCompact = $('accelPedalCompact');
const accelFillCompact = $('accelFillCompact');
const dashboardVisCompact = $('dashboardVisCompact');

// Initialize with playback rate getter
initSteeringWheel(() => state.ui.playbackRate || 1);

// Reset dashboard and map to default state (no SEI data)
function resetDashboardElements() {
    // Reset speed
    if (speedValue) speedValue.textContent = '--';
    if (speedUnit) speedUnit.textContent = t('ui.dashboard.' + (useMetric ? 'kmh' : 'mph'));
    
    // Reset gear
    if (gearState) {
        gearState.textContent = '--';
        gearState.classList.remove('active');
    }
    
    // Reset blinkers
    blinkLeft?.classList.remove('active', 'paused');
    blinkRight?.classList.remove('active', 'paused');
    
    // Reset steering wheel
    resetSteeringWheel();
    
    // Reset autopilot
    if (autosteerIcon) autosteerIcon.classList.remove('active');
    if (apText) {
        apText.textContent = t('ui.dashboard.noData');
        apText.classList.remove('active');
    }
    
    // Reset brake and accelerator
    brakeIcon?.classList.remove('active');
    if (accelPedal) accelPedal.classList.remove('active');
    
    // Reset compact dashboard elements
    if (brakeIconCompact) brakeIconCompact.classList.remove('active');
    if (accelPedalCompact) accelPedalCompact.classList.remove('active');
    if (speedValueCompact) speedValueCompact.textContent = '--';
    if (speedUnitCompact) speedUnitCompact.textContent = t('ui.dashboard.' + (useMetric ? 'kmh' : 'mph'));
    if (gearStateCompact) {
        gearStateCompact.textContent = '--';
        gearStateCompact.classList.remove('active');
    }
    blinkLeftCompact?.classList.remove('active', 'paused');
    blinkRightCompact?.classList.remove('active', 'paused');
    if (steeringIconCompact) steeringIconCompact.style.transform = 'rotate(0deg)';
    if (autosteerIconCompact) autosteerIconCompact.classList.remove('active');
    if (apTextCompact) {
        apTextCompact.textContent = t('ui.dashboard.manual');
        apTextCompact.classList.remove('active');
    }
    
    // Reset extra data
    if (valSeq) valSeq.textContent = '--';
    if (valLat) valLat.textContent = '--';
    if (valLon) valLon.textContent = '--';
    if (valHeading) valHeading.textContent = '--';
    
    // Reset G-force meter
    resetGForceMeter();
    
    // Reset compass
    resetCompass();
}

function resetDashboardAndMap() {
    resetDashboardElements();
    
    // Reset map
    clearMapMarker();
    if (mapPolyline) {
        if (Array.isArray(mapPolyline)) {
            mapPolyline.forEach(p => p.remove());
        } else {
            mapPolyline.remove();
        }
        mapPolyline = null;
    }
    mapPath = [];
    window._lastMapBounds = null;
    window._lastMapPath = null;
    
    // Clear FSD event markers
    for (const m of fsdEventMarkers) m.remove();
    fsdEventMarkers = [];

    // Clear event location marker (Sentry/Saved clip static pin)
    if (eventLocationMarker) {
        eventLocationMarker.remove();
        eventLocationMarker = null;
    }
    
    // Clear SEI data cache and tracking flags
    if (nativeVideo) {
        stopTelemetryLoop();
        nativeVideo.seiData = [];
        nativeVideo.mapPath = [];
        nativeVideo.lastSeiTimeMs = -Infinity;
        nativeVideo.dashboardReset = false;
    }
}

// Show a static map marker from event.json location data (for Sentry/Saved clips)
function showEventJsonLocation(coll, { recenter = true } = {}) {
    if (!map || !coll?.groups?.length) return;
    
    // Get eventMeta from any group in the collection
    let eventMeta = null;
    for (const g of coll.groups) {
        if (g.eventMeta) {
            eventMeta = g.eventMeta;
            break;
        }
    }
    
    if (!eventMeta) return;
    
    // Parse coordinates
    const rawLat = parseFloat(eventMeta.est_lat);
    const rawLon = parseFloat(eventMeta.est_lon);

    if (!Number.isFinite(rawLat) || !Number.isFinite(rawLon) || (Math.abs(rawLat) < 0.001 && Math.abs(rawLon) < 0.001)) {
        return; // Invalid coordinates
    }

    // Tesla's est_lat/est_lon is an approximation and can land slightly off the
    // GPS trace we draw from in-video SEI samples. If we have a polyline loaded,
    // snap the pin to the closest sample on that path (within ~500m) so it
    // visually sits on the route at the correct point in time.
    let lat = rawLat;
    let lon = rawLon;
    const path = nativeVideo?.mapPath;
    if (Array.isArray(path) && path.length > 0) {
        const cosLat = Math.cos(rawLat * Math.PI / 180);
        let bestIdx = -1;
        let bestMetersSq = Infinity;
        for (let i = 0; i < path.length; i++) {
            const dLatM = (path[i].lat - rawLat) * 111000;
            const dLonM = (path[i].lon - rawLon) * 111000 * cosLat;
            const sq = dLatM * dLatM + dLonM * dLonM;
            if (sq < bestMetersSq) { bestMetersSq = sq; bestIdx = i; }
        }
        if (bestIdx >= 0 && bestMetersSq < 500 * 500) {
            lat = path[bestIdx].lat;
            lon = path[bestIdx].lon;
        }
    }

    console.log('Showing event.json location:', lat, lon, eventMeta.street || '', eventMeta.city || '');

    // Store event metadata for display
    state.collection.eventMeta = eventMeta;
    
    // Create a static marker icon (different from moving GPS arrow)
    const eventIcon = L.divIcon({
        className: 'event-location-marker',
        html: `<div class="event-marker-pin">
            <svg viewBox="0 0 24 24" width="32" height="32" fill="#e53935">
                <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
            </svg>
        </div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 32],
        popupAnchor: [0, -32]
    });
    
    // Clear any existing event location marker before adding new one
    if (eventLocationMarker) {
        eventLocationMarker.remove();
        eventLocationMarker = null;
    }
    
    // Create marker and add popup with location info
    const latlng = L.latLng(lat, lon);
    // Note: This is a static event location marker, separate from the moving GPS marker
    eventLocationMarker = L.marker(latlng, { icon: eventIcon }).addTo(map);
    
    // Center map on location (skipped on re-call after polyline fitBounds)
    if (recenter) {
        map.setView(latlng, 16);
    }
    map.invalidateSize();
}

// Format event reason for display
function formatEventReason(reason) {
    const reasonMap = {
        'sentry_aware_object_detection': t('ui.eventTypes.objectDetected'),
        'vehicle_auto_emergency_braking': t('ui.eventTypes.emergencyBraking'),
        'user_interaction_dashcam_icon_tapped': t('ui.eventTypes.manualSave'),
        'user_interaction_dashcam_panel_save': t('ui.eventTypes.manualSave'),
        'user_interaction_dashcam_launcher_action_tapped': t('ui.eventTypes.manualSave'),
        'user_interaction_honk': t('ui.eventTypes.honk'),
        'sentry_aware_accel': t('ui.eventTypes.accelerationDetected'),
        'collision': t('ui.eventTypes.collisionDetected'),
        'user_interaction_dashcam': t('ui.eventTypes.manualSave')
    };
    return reasonMap[reason] || reason.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

const apText = $('apText');
const brakeIcon = $('brakeIcon');
const toggleExtra = $('toggleExtra');
const extraDataContainer = document.querySelector('.extra-data-container');
const mapVis = $('mapVis');

// Map State
let map = null;
let mapPolyline = null;
let eventLocationMarker = null; // Static marker for Sentry/Saved clip event locations
let mapPath = [];
let fsdEventMarkers = []; // Circle markers for FSD disengagements and accel pushes

// Extra Data Elements
const valLat = $('valLat');
const valLon = $('valLon');
const valHeading = $('valHeading');
const valSeq = $('valSeq');

// Constants
const MPS_TO_MPH = 2.23694;
const MPS_TO_KMH = 3.6;
let useMetric = false; // Will be loaded from settings

// Initialize
(async function init() {
    // Check for pending deletion (after window reload to release file handles)
    if (window.electronAPI?.checkPendingDelete) {
        const pendingResult = await window.electronAPI.checkPendingDelete();
        if (pendingResult.hasPending) {
            if (pendingResult.success) {
                console.log('[DELETE] Pending deletion completed successfully:', pendingResult.folderPath);
                // Store base folder path to reload after i18n is ready
                window._pendingDeleteBasePath = pendingResult.baseFolderPath;
            } else {
                console.error('[DELETE] Pending deletion failed:', pendingResult.error);
            }
        }
    }
    
    // Initialize i18n (language system)
    await initI18n();
    
    // Set initial subtitle text if no folder is loaded
    if (!library.folderLabel) {
        clipBrowserSubtitle.textContent = t('ui.clipBrowser.subtitle');
    }
    
    // Listen for language changes and update dashboard labels
    onLanguageChange((lang) => {
        console.log('Language changed to:', lang);
        
        // Update speed unit labels
        if (speedUnit) speedUnit.textContent = t('ui.dashboard.' + (useMetric ? 'kmh' : 'mph'));
        if (speedUnitCompact) speedUnitCompact.textContent = t('ui.dashboard.' + (useMetric ? 'kmh' : 'mph'));
        
        // Update "Manual" / "No Data" text if currently displayed
        if (apText && apText.textContent === 'Manual') {
            apText.textContent = t('ui.dashboard.manual');
        } else if (apText && apText.textContent === 'No Data') {
            apText.textContent = t('ui.dashboard.noData');
        }
        
        if (apTextCompact && apTextCompact.textContent === 'Manual') {
            apTextCompact.textContent = t('ui.dashboard.manual');
        }
        
        // Update clip browser subtitle with proper translation
        if (!library.folderLabel) {
            clipBrowserSubtitle.textContent = t('ui.clipBrowser.subtitle');
        } else if (dayFilter && dayFilter.value && library.clipGroups) {
            // A date is selected - show "FolderName: X clips on Date"
            clipBrowserSubtitle.textContent = `${library.folderLabel}: ${library.clipGroups.length} ${t('ui.clipBrowser.clipsOn')} ${formatDateDisplay(dayFilter.value)}`;
        } else if (library.allDates && library.allDates.length > 0) {
            // Folder loaded but no date selected - show "FolderName: X dates available"
            clipBrowserSubtitle.textContent = `${library.folderLabel}: ${library.allDates.length} ${t('ui.clipBrowser.datesAvailable')}`;
        } else {
            // Just the folder name
            clipBrowserSubtitle.textContent = library.folderLabel;
        }
        
        // Re-render clip list to update translated labels
        if (window._renderClipList) {
            window._renderClipList();
        }
        
        // Update camera tile labels
        updateTileLabels();
    });
    
    // Map dark mode - applies CSS filter to Leaflet tile pane
    window._mapDarkMode = false;
    function applyMapDarkMode(enabled) {
        const mapEl = document.getElementById('map');
        if (mapEl) {
            const tilePane = mapEl.querySelector('.leaflet-tile-pane');
            if (tilePane) {
                tilePane.style.filter = enabled
                    ? 'invert(100%) hue-rotate(180deg) brightness(0.85) contrast(1.2)'
                    : '';
            }
        }
    }
    window.applyMapDarkMode = applyMapDarkMode;

    // Init Map
    try {
        if (window.L) {
            map = L.map('map', { 
                zoomControl: false, 
                attributionControl: false,
                dragging: false,         // Disable left-click drag (conflicts with dashboard)
                touchZoom: true,
                scrollWheelZoom: true,   // Enable scroll wheel zoom
                doubleClickZoom: true,
                boxZoom: false,
                keyboard: false
            }).setView([0, 0], 2);
            // Tile source comes from the shared provider registry (Google by
            // default, OpenStreetMap as the automatic fallback) — see
            // scripts/ui/mapTiles.js and src/shared/mapProviders.js.
            attachTileLayer(map);
            
            // Apply dark mode if previously saved
            if (window._mapDarkMode) applyMapDarkMode(true);
            
            // Enable right-click drag for panning (to avoid conflict with dashboard left-click drag)
            let mapDragStart = null;
            let mapDragStartCenter = null;
            let isMapDragging = false;
            const mapEl = document.getElementById('map');
            const mapVis = document.getElementById('mapVis');
            
            // Disable context menu on map
            mapEl.addEventListener('contextmenu', e => {
                e.preventDefault();
                e.stopPropagation();
            });
            
            // Also prevent context menu on mapVis container
            mapVis.addEventListener('contextmenu', e => {
                if (e.target === mapEl || mapEl.contains(e.target)) {
                    e.preventDefault();
                    e.stopPropagation();
                }
            });
            
            mapEl.addEventListener('mousedown', e => {
                if (e.button === 2) { // Right-click
                    e.preventDefault();
                    e.stopPropagation();
                    isMapDragging = true;
                    mapDragStart = { x: e.clientX, y: e.clientY };
                    mapDragStartCenter = map.getCenter();
                    mapEl.style.cursor = 'grabbing';
                }
            });
            
            document.addEventListener('mousemove', e => {
                if (isMapDragging && mapDragStart && mapDragStartCenter) {
                    e.preventDefault();
                    e.stopPropagation();
                    let dx = e.clientX - mapDragStart.x;
                    let dy = e.clientY - mapDragStart.y;
                    // Counter-rotate drag vector by map bearing so drag direction
                    // matches screen direction even when the map container is rotated
                    const bearing = getMapBearing();
                    if (bearing) {
                        const rad = (bearing * Math.PI) / 180;
                        const cos = Math.cos(rad);
                        const sin = Math.sin(rad);
                        const rdx = dx * cos + dy * sin;
                        const rdy = -dx * sin + dy * cos;
                        dx = rdx;
                        dy = rdy;
                    }
                    // Convert pixel offset to lat/lng offset
                    const startPoint = map.latLngToContainerPoint(mapDragStartCenter);
                    const newPoint = L.point(startPoint.x - dx, startPoint.y - dy);
                    const newCenter = map.containerPointToLatLng(newPoint);
                    map.setView(newCenter, map.getZoom(), { animate: false });
                }
            });
            
            document.addEventListener('mouseup', e => {
                if (e.button === 2 && isMapDragging) {
                    e.preventDefault();
                    e.stopPropagation();
                    isMapDragging = false;
                    mapDragStart = null;
                    mapDragStartCenter = null;
                    mapEl.style.cursor = 'default';
                }
            });
            
            // Helper to re-center map based on current polyline or cached path
            function recenterMap() {
                if (!map) return;
                map.invalidateSize();

                // Highest priority: event marker (sentry/saved)
                if (eventLocationMarker) {
                    map.setView(eventLocationMarker.getLatLng(), 16, { animate: true });
                    return;
                }

                // During drive playback, center on the current arrow position
                // at a close zoom instead of fitting the whole route
                if (window._mapCurrentMarkerLatLng) {
                    map.setView(window._mapCurrentMarkerLatLng, 16, { animate: true });
                    return;
                }

                // Prefer existing polylines' bounds (not during playback)
                if (mapPolyline) {
                    let bounds = null;
                    if (Array.isArray(mapPolyline) && mapPolyline.length > 0) {
                        bounds = mapPolyline[0].getBounds();
                        for (let i = 1; i < mapPolyline.length; i++) {
                            bounds = bounds.extend(mapPolyline[i].getBounds());
                        }
                    } else if (mapPolyline.getBounds) {
                        bounds = mapPolyline.getBounds();
                    }
                    if (bounds) {
                        map.fitBounds(bounds, { padding: [20, 20], animate: true, maxZoom: 16 });
                        return;
                    }
                }

                // Fallback to path data
                const path = (nativeVideo.mapPath?.length ? nativeVideo.mapPath : window._lastMapPath) || [];
                if (path.length > 0) {
                    const allCoords = path.map(p => [p.lat, p.lon]);
                    const bounds = L.latLngBounds(allCoords);
                    map.fitBounds(bounds, { padding: [20, 20], animate: true, maxZoom: 16 });
                    return;
                }

                // Fallback to cached bounds (saved/sentry pin)
                if (window._lastMapBounds) {
                    map.fitBounds(window._lastMapBounds, { padding: [20, 20], animate: true, maxZoom: 16 });
                    return;
                }
            }
            
            // Store original bounds for re-centering
            window._mapOriginalBounds = null;
            
            // Re-center button - resets both zoom and position
            const mapRecenterBtn = document.getElementById('mapRecenterBtn');
            if (mapRecenterBtn) {
                // Fallback click handler (in case mouseup is suppressed)
                mapRecenterBtn.addEventListener('click', e => {
                    e.stopPropagation();
                    e.preventDefault();
                    recenterMap();
                });

                // Use mousedown + mouseup to avoid drag interference
                let recenterMouseDown = false;
                mapRecenterBtn.addEventListener('mousedown', e => {
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    recenterMouseDown = true;
                }, true);
                
                mapRecenterBtn.addEventListener('mouseup', e => {
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    if (recenterMouseDown) {
                        recenterMouseDown = false;
                        // Perform re-center
                        recenterMap();
                    }
                }, true);
                
                mapRecenterBtn.addEventListener('click', e => {
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    e.preventDefault();
                }, true);
            }

            // Orientation toggle button (heading-up / north-up)
            const mapOrientationBtn = document.getElementById('mapOrientationBtn');
            if (mapOrientationBtn) {
                const compassSvg = mapOrientationBtn.querySelector('svg');
                mapOrientationBtn.addEventListener('click', e => {
                    e.stopPropagation();
                    e.preventDefault();
                    const current = getMapOrientation();
                    const next = current === 'heading-up' ? 'north-up' : 'heading-up';
                    setMapOrientation(next);
                    // Reset compass rotation for north-up, or keep it live for heading-up
                    if (compassSvg) {
                        compassSvg.style.transform = next === 'north-up' ? 'rotate(0deg)' : '';
                    }
                    mapOrientationBtn.title = next === 'heading-up'
                        ? 'Heading up — tap for north up'
                        : 'North up — tap for heading up';
                });

                // Rotate compass icon to match current bearing during heading-up
                window._updateMapCompass = (bearing) => {
                    if (compassSvg && getMapOrientation() === 'heading-up') {
                        compassSvg.style.transform = `rotate(${-bearing}deg)`;
                    }
                };
            }
        }
    } catch(e) { console.error('Leaflet init failed', e); }
    
    // Re-center map when window is resized or goes fullscreen
    let resizeTimeout;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            if (map && mapPolyline && nativeVideo.mapPath?.length > 0) {
                map.invalidateSize();
                const allCoords = nativeVideo.mapPath.map(p => [p.lat, p.lon]);
                map.fitBounds(L.latLngBounds(allCoords), { padding: [20, 20] });
            }
        }, 100);
    });
    
    // Also handle fullscreen changes
    document.addEventListener('fullscreenchange', () => {
        if (map && mapPolyline && nativeVideo.mapPath?.length > 0) {
            setTimeout(() => {
                map.invalidateSize();
                const allCoords = nativeVideo.mapPath.map(p => [p.lat, p.lon]);
                map.fitBounds(L.latLngBounds(allCoords), { padding: [20, 20] });
            }, 100);
        }
    });

    try {
        const { SeiMetadata, enumFields: ef } = await DashcamHelpers.initProtobuf();
        seiType = SeiMetadata;
        enumFields = ef;
    } catch (e) {
        console.error('Failed to init protobuf:', e);
        notify(t('ui.notifications.failedToInitMetadataParser'), { type: 'error' });
    }

    // Clip Browser buttons
    chooseFolderBtn.onclick = (e) => {
        e.preventDefault();
        openFolderPicker();
        chooseFolderBtn.blur();
    };

    if (dayFilter) {
        dayFilter.onchange = async () => {
            const selectedDate = dayFilter.value;
            updateDayFilterMarker();
            if (selectedDate && folderStructure?.dateHandles?.has(selectedDate)) {
                // Lazy load: fetch files for this date from NAS
                await loadDateContent(selectedDate);
            } else {
                renderClipList();
            }
            dayFilter.blur();
        };
    }

    // Panel layout mode (floating/collapsed or docked/hidden based on layout style)
    const panelMode = createClipsPanelMode({ map, clipsCollapseBtn });
    panelMode.initClipsPanelMode();
    clipsCollapseBtn.onclick = (e) => { e.preventDefault(); panelMode.toggleCollapsedMode(); clipsCollapseBtn.blur(); };
    
    // Store panelMode functions globally for settings modal access
    window._panelMode = panelMode;

    cameraSelect.onchange = () => {
        const g = selection.selectedGroupId ? library.clipGroupById.get(selection.selectedGroupId) : null;
        if (!g) return;

        if (multi.enabled) {
            // In multi-cam, the dropdown selects the master camera (telemetry + timeline).
            multi.masterCamera = cameraSelect.value;
        } else {
            selection.selectedCamera = cameraSelect.value;
        }
        // Note: Camera changes are handled by selectDayCollection() in native video mode
    };

    multiCamToggle.onchange = () => {
        multi.enabled = !!multiCamToggle.checked;
        localStorage.setItem(MULTI_ENABLED_KEY, multi.enabled ? '1' : '0');
        if (multiLayoutSelect) multiLayoutSelect.disabled = !multi.enabled;
        // Note: Multi-cam toggle changes are applied on next segment load in native video mode
    };

    // Dashboard (SEI overlay) toggle
    dashboardToggle.onchange = () => {
        state.ui.dashboardEnabled = !!dashboardToggle.checked;
        if (window.electronAPI?.setSetting) {
            window.electronAPI.setSetting('dashboardEnabled', state.ui.dashboardEnabled);
        }
        updateDashboardVisibility();
    };

    // Map toggle
    mapToggle.onchange = () => {
        state.ui.mapEnabled = !!mapToggle.checked;
        if (window.electronAPI?.setSetting) {
            window.electronAPI.setSetting('mapEnabled', state.ui.mapEnabled);
        }
        updateMapVisibility();
    };

    // Metric toggle (hidden, controlled via settings modal)
    const metricToggle = $('metricToggle');
    if (metricToggle) {
        metricToggle.checked = useMetric;
        metricToggle.onchange = () => {
            useMetric = metricToggle.checked;
            if (window.electronAPI?.setSetting) {
                window.electronAPI.setSetting('useMetric', useMetric);
            }
            // Update speed unit display for both dashboards
            if (speedUnit) speedUnit.textContent = useMetric ? 'KM/H' : 'MPH';
            if (speedUnitCompact) speedUnitCompact.textContent = useMetric ? 'KM/H' : 'MPH';
        };
    }

    // Playback speed selector
    if (speedSelect) {
        // Restore saved playback rate
        const savedRate = localStorage.getItem('playbackRate');
        if (savedRate) {
            state.ui.playbackRate = parseFloat(savedRate) || 1;
            speedSelect.value = state.ui.playbackRate.toString();
        }
        speedSelect.onchange = () => {
            const rate = parseFloat(speedSelect.value) || 1;
            applyPlaybackRate(rate);
            localStorage.setItem('playbackRate', rate.toString());
            speedSelect.blur();
        };
    }

    // Initialize dashboard/map/metric toggles from file-based settings (default ON)
    if (window.electronAPI?.getSetting) {
        window.electronAPI.getSetting('dashboardEnabled').then(saved => {
            state.ui.dashboardEnabled = saved === undefined ? true : saved === true;
            if (dashboardToggle) dashboardToggle.checked = state.ui.dashboardEnabled;
            updateDashboardVisibility();
        });
        window.electronAPI.getSetting('mapEnabled').then(saved => {
            state.ui.mapEnabled = saved === undefined ? true : saved === true;
            if (mapToggle) mapToggle.checked = state.ui.mapEnabled;
            updateMapVisibility();
        });
        window.electronAPI.getSetting('useMetric').then(saved => {
            useMetric = saved === true;
            const metricToggle = $('metricToggle');
            if (metricToggle) metricToggle.checked = useMetric;
            if (speedUnit) speedUnit.textContent = useMetric ? 'KM/H' : 'MPH';
        });
        window.electronAPI.getSetting('accelPedMode').then(saved => {
            const mode = saved || 'iconbar';
            if (window.updateAccelPedMode) {
                window.updateAccelPedMode(mode);
            }
        });
        window.electronAPI.getSetting('mapDarkMode').then(saved => {
            window._mapDarkMode = saved === true;
            applyMapDarkMode(window._mapDarkMode);
        });
    } else {
        // Fallback to defaults
        state.ui.dashboardEnabled = true;
        state.ui.mapEnabled = true;
        if (dashboardToggle) dashboardToggle.checked = state.ui.dashboardEnabled;
        if (mapToggle) mapToggle.checked = state.ui.mapEnabled;
        // Apply default accel ped mode
        if (window.updateAccelPedMode) {
            window.updateAccelPedMode('iconbar');
        }
    }

    // Load dashboard layout setting and apply
    let dashboardLayout = 'default';
    window.dashboardLayout = dashboardLayout; // Initialize global
    if (window.electronAPI?.getSetting) {
        window.electronAPI.getSetting('dashboardLayout').then(savedLayout => {
            dashboardLayout = savedLayout || 'default';
            window.dashboardLayout = dashboardLayout;
            updateDashboardLayout(dashboardLayout);
        });
    }
    
    // Global function to update dashboard layout (used by settings modal)
    window.updateDashboardLayout = async (layout) => {
        dashboardLayout = layout || 'default';
        window.dashboardLayout = dashboardLayout; // Store globally for dashboardVisibility
        const defaultDash = dashboardVis;
        const compactDash = dashboardVisCompact;

        // Hide all dashboards first
        if (defaultDash) defaultDash.classList.add('hidden');
        if (compactDash) { compactDash.classList.add('hidden'); compactDash.classList.remove('visible'); }

        if (dashboardLayout === 'compact') {
            if (compactDash) compactDash.classList.remove('hidden');
            if (state?.ui?.dashboardEnabled && compactDash) {
                compactDash.classList.add('visible');
                compactDash.classList.remove('user-hidden');
            }
            const isFixed = await window.electronAPI?.getSetting?.('compactDashboardFixed') ?? true;
            if (window.updateCompactDashboardPositioning) {
                window.updateCompactDashboardPositioning(isFixed);
            }
        } else {
            if (defaultDash) defaultDash.classList.remove('hidden');
        }
        updateDashboardVisibility();
    };
    
    // Global function to update accelerator pedal display mode for all dashboards
    window.updateAccelPedMode = (mode) => {
        // Store globally so export flow can read it (exportVideo.js uses window._accelPedMode)
        window._accelPedMode = mode;
        
        // Remove all mode classes
        const modes = ['mode-solid', 'mode-iconbar', 'mode-sidebar'];
        
        if (accelPedal) {
            modes.forEach(m => accelPedal.classList.remove(m));
            accelPedal.classList.add(`mode-${mode}`);
        }
        
        if (accelPedalCompact) {
            modes.forEach(m => accelPedalCompact.classList.remove(m));
            accelPedalCompact.classList.add(`mode-${mode}`);
        }
    };
    
    // Global function to update compact dashboard positioning (fixed vs movable)
    window.updateCompactDashboardPositioning = (isFixed) => {
        if (!dashboardVisCompact) return;
        
        if (isFixed) {
            // Fixed mode: remove draggable, attach to front camera
            dashboardVisCompact.classList.add('fixed-to-camera');
            dashboardVisCompact.classList.remove('draggable');
            // Reset drag offset and clear transform
            resetPanelPosition(dashboardVisCompact);
            dashboardVisCompact.style.cursor = '';
            
            // Re-attach to front camera first - move it to the tile
            if (updateCompactDashboardPosition) {
                updateCompactDashboardPosition();
            }
            
            // Use double requestAnimationFrame to ensure DOM update and CSS recalculation happens
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    // Clear all inline positioning styles to let CSS handle it
                    // The CSS rule .multi-tile .dashboard-vis-compact will take over
                    dashboardVisCompact.style.position = '';
                    dashboardVisCompact.style.top = '';
                    dashboardVisCompact.style.right = '';
                    dashboardVisCompact.style.bottom = '';
                    dashboardVisCompact.style.left = '';
                    dashboardVisCompact.style.width = '';
                    dashboardVisCompact.style.height = '';
                    dashboardVisCompact.style.padding = '';
                    dashboardVisCompact.style.zIndex = '';
                    // Clear transform - CSS will set translateX(-50%)
                    dashboardVisCompact.style.transform = '';
                    dashboardVisCompact.style.pointerEvents = '';
                });
            });
        } else {
            // Movable mode: make it draggable like default dashboard
            dashboardVisCompact.classList.remove('fixed-to-camera');
            dashboardVisCompact.classList.add('draggable');
            // Move to body if it's inside a tile
            const parent = dashboardVisCompact.parentElement;
            if (parent && parent.classList.contains('multi-tile')) {
                document.body.appendChild(dashboardVisCompact);
            }
            // Use requestAnimationFrame to ensure DOM/CSS updates are applied
            requestAnimationFrame(() => {
                // Find the front camera tile to position dashboard at its bottom
                const multiCamGrid = document.getElementById('multiCamGrid');
                let initialTop = '20px';
                let initialLeft = '20px';
                
                if (multiCamGrid && getEffectiveSlots) {
                    try {
                        // Find which slot currently has the front camera
                        const effectiveSlots = getEffectiveSlots();
                        const frontSlot = effectiveSlots.find(s => s.camera === 'front');
                        
                        if (frontSlot) {
                            // Find the tile with the front camera
                            const frontTile = multiCamGrid.querySelector(`.multi-tile[data-slot="${frontSlot.slot}"]`);
                            if (frontTile) {
                                const tileRect = frontTile.getBoundingClientRect();
                                const dashHeight = 56; // Height of compact dashboard
                                const dashWidth = 480; // Width of compact dashboard
                                const padding = 8; // Small padding from bottom
                                
                                // Position at bottom of front camera tile
                                const topPos = tileRect.bottom - dashHeight - padding;
                                initialTop = `${Math.max(0, topPos)}px`;
                                
                                // Center horizontally within the tile, but keep on screen
                                const centerX = tileRect.left + (tileRect.width / 2);
                                const leftPos = centerX - (dashWidth / 2);
                                // Ensure it doesn't go off the left or right edge
                                const minLeft = 10; // Minimum margin from left edge
                                const maxLeft = window.innerWidth - dashWidth - 10; // Maximum margin from right edge
                                initialLeft = `${Math.max(minLeft, Math.min(leftPos, maxLeft))}px`;
                            }
                        }
                    } catch (e) {
                        console.warn('Failed to position compact dashboard at front camera:', e);
                        // Fall back to default position
                    }
                }
                
                // Set initial positioning via inline styles (these override CSS)
                dashboardVisCompact.style.position = 'fixed';
                dashboardVisCompact.style.top = initialTop;
                dashboardVisCompact.style.left = initialLeft;
                dashboardVisCompact.style.right = 'auto';
                dashboardVisCompact.style.bottom = 'auto';
                dashboardVisCompact.style.width = '480px';
                dashboardVisCompact.style.height = '56px';
                dashboardVisCompact.style.padding = '6px 10px';
                dashboardVisCompact.style.zIndex = '101';
                dashboardVisCompact.style.pointerEvents = 'auto';
                dashboardVisCompact.style.cursor = 'grab';
                // Set initial transform - draggablePanels will update it with !important for compact dashboard
                dashboardVisCompact.style.transform = 'translate3d(0, 0, 0)';
                // Reset drag offset to start fresh
                resetPanelPosition(dashboardVisCompact);
                // Make it draggable - it will update the transform via inline style
                initDraggablePanels([dashboardVisCompact]);
            });
        }
    };
    
    // Initialize compact dashboard positioning on load
    async function initCompactDashboardPositioning() {
        if (!dashboardVisCompact) return;
        
        const isFixed = await window.electronAPI?.getSetting?.('compactDashboardFixed') ?? true;
        if (window.updateCompactDashboardPositioning) {
            window.updateCompactDashboardPositioning(isFixed);
        }
    }
    
    // Initialize on load
    if (window.electronAPI?.getSetting) {
        initCompactDashboardPositioning();
    }
    
    // Apply initial visibility state
    updateDashboardVisibility();
    updateMapVisibility();

    // Multi-cam layout preset - force six_default
    multi.layoutId = 'six_default';
    if (multiLayoutSelect) {
        multiLayoutSelect.value = multi.layoutId;
        multiLayoutSelect.onchange = () => {
            setMultiLayout(multiLayoutSelect.value || DEFAULT_MULTI_LAYOUT);
        };
    }


    // Skip buttons (use configurable duration, default 15 seconds)
    if (skipBackBtn) skipBackBtn.onclick = (e) => { e.preventDefault(); skipSeconds(-(window._skipDuration || 15)); skipBackBtn.blur(); };
    if (skipForwardBtn) skipForwardBtn.onclick = (e) => { e.preventDefault(); skipSeconds(window._skipDuration || 15); skipForwardBtn.blur(); };

    // Export buttons
    const setStartMarkerBtn = $('setStartMarkerBtn');
    const setEndMarkerBtn = $('setEndMarkerBtn');
    const exportBtn = $('exportBtn');
    const exportModal = $('exportModal');
    const closeExportModalBtn = $('closeExportModal');
    const startExportBtn = $('startExportBtn');
    const cancelExportBtn = $('cancelExportBtn');

    if (setStartMarkerBtn) {
        setStartMarkerBtn.onclick = (e) => { e.preventDefault(); setExportMarker('start'); setStartMarkerBtn.blur(); };
    }
    if (setEndMarkerBtn) {
        setEndMarkerBtn.onclick = (e) => { e.preventDefault(); setExportMarker('end'); setEndMarkerBtn.blur(); };
    }
    if (exportBtn) {
        exportBtn.onclick = (e) => { e.preventDefault(); openExportModal(); exportBtn.blur(); };
    }
    const openAdvEditorBtn = $('openAdvancedEditorBtn');
    if (openAdvEditorBtn) {
        openAdvEditorBtn.onclick = (e) => {
            e.preventDefault();
            openAdvancedEditor();
            openAdvEditorBtn.blur();
        };
    }
    if (closeExportModalBtn) {
        closeExportModalBtn.onclick = (e) => { 
            e.preventDefault(); 
            // During export, this will minimize the modal and show floating progress
            closeExportModal(); 
        };
    }
    if (cancelExportBtn) {
        cancelExportBtn.onclick = (e) => { e.preventDefault(); confirmCancelExport(); };
    }
    const confirmCancelBtn = $('confirmCancelExportBtn');
    const dismissCancelBtn = $('dismissCancelExportBtn');
    if (confirmCancelBtn) {
        confirmCancelBtn.onclick = (e) => {
            e.preventDefault();
            const modal = $('cancelExportConfirmModal');
            if (modal) modal.classList.add('hidden');
            cancelExport();
        };
    }
    if (dismissCancelBtn) {
        dismissCancelBtn.onclick = (e) => {
            e.preventDefault();
            const modal = $('cancelExportConfirmModal');
            if (modal) modal.classList.add('hidden');
        };
    }
    if (startExportBtn) {
        startExportBtn.onclick = (e) => { e.preventDefault(); startExport(); };
    }
    // Close modal on backdrop click (minimize during export, close otherwise)
    if (exportModal) {
        exportModal.onclick = (e) => {
            if (e.target === exportModal) {
                closeExportModal();
            }
        };
    }
    
    // My Shared Clips modal
    const mySharedClipsBtn = $('mySharedClipsBtn');
    const sharedClipsModal = $('sharedClipsModal');
    const closeSharedClipsModal = $('closeSharedClipsModal');
    
    if (mySharedClipsBtn) {
        mySharedClipsBtn.onclick = async (e) => {
            e.preventDefault();
            mySharedClipsBtn.blur();
            if (sharedClipsModal) {
                sharedClipsModal.classList.remove('hidden');
                await renderSharedClipsList();
            }
        };
    }
    if (closeSharedClipsModal) {
        closeSharedClipsModal.onclick = () => {
            if (sharedClipsModal) sharedClipsModal.classList.add('hidden');
        };
    }
    if (sharedClipsModal) {
        sharedClipsModal.onclick = (e) => {
            if (e.target === sharedClipsModal) sharedClipsModal.classList.add('hidden');
        };
    }
    
    // Floating export progress - reopen modal button
    const exportFloatingOpenBtn = $('exportFloatingOpenBtn');
    if (exportFloatingOpenBtn) {
        exportFloatingOpenBtn.onclick = (e) => { e.preventDefault(); reopenExportModal(); };
    }
    


    // Initialize native video playback system
    initNativeVideoPlayback();

    // Listen for mirror cameras setting changes to re-apply transforms
    window.addEventListener('mirrorCamerasChanged', () => {
        applyMirrorTransforms();
    });

    // Listen for date format changes to update the clips dropdown
    // Update existing option text in-place instead of rebuilding from library.allDates,
    // because library.allDates may only contain the currently loaded date's data
    window.addEventListener('dateFormatChanged', () => {
        if (!dayFilter) return;
        for (const opt of dayFilter.options) {
            if (!opt.value) continue; // Skip "Select Date" placeholder
            // Strip any marker prefix, reformat with new date format, marker will be reapplied
            opt.textContent = formatDateDisplay(opt.value);
        }
        updateDayFilterMarker();
    });

    // Multi focus mode (click a tile to expand)
    // Debounced to prevent rapid clicking issues
    let lastFocusToggle = 0;
    if (multiCamGrid) {
        multiCamGrid.addEventListener('click', (e) => {
            // Don't toggle focus if we just finished panning
            if (zoomPanState.wasPanning) return;
            
            // Debounce rapid clicks (200ms minimum between toggles)
            const now = Date.now();
            if (now - lastFocusToggle < 200) return;
            lastFocusToggle = now;
            
            const tile = e.target.closest?.('.multi-tile');
            if (!tile) return;
            const slot = tile.getAttribute('data-slot');
            if (!slot) return;
            toggleMultiFocus(slot);
        });
    }

    // Multi-cam enabled preference (default ON if no prior preference)
    const savedMulti = localStorage.getItem(MULTI_ENABLED_KEY);
    multi.enabled = savedMulti == null ? !!multiCamToggle?.checked : savedMulti === '1';
    if (multiCamToggle) multiCamToggle.checked = multi.enabled;
    if (multiLayoutSelect) multiLayoutSelect.disabled = !multi.enabled;

    // Initialize custom camera order from localStorage
    initCustomCameraOrder();
    
    // Initialize drag-and-drop for camera rearrangement
    initCameraDragAndDrop();
    
    // Handle pending deletion result (folder was deleted after reload)
    if (window._pendingDeleteBasePath) {
        const basePath = window._pendingDeleteBasePath;
        delete window._pendingDeleteBasePath;
        
        // Show success notification
        notify(t('ui.clipBrowser.deleteSuccess'), { type: 'success' });
        
        // Reload the folder to refresh the clip list
        if (basePath && window.electronAPI?.readDir) {
            console.log('[DELETE] Reloading folder after deletion:', basePath);
            baseFolderPath = basePath;
            setTimeout(() => {
                traverseDirectoryElectron(basePath).catch(err => {
                    console.error('[DELETE] Failed to reload folder:', err);
                });
            }, 500);
        }
    }
})();

// Mode Transitions
function setMode(nextMode) {
    const normalized = (nextMode === 'collection') ? 'collection' : 'clip';
    if (state.mode === normalized) return;

    // Stop playback timers and prevent overlapping loops across transitions.
    pause();

    // Close transient UI.
    clearMultiFocus();

    // Clear mode-specific state.
    if (normalized === 'clip') {
        state.collection.active = null;
    } else {
        selection.selectedGroupId = null;
    }

    state.mode = normalized;
}

function setMultiLayout(layoutId) {
    const next = MULTI_LAYOUTS[layoutId] ? layoutId : DEFAULT_MULTI_LAYOUT;
    multi.layoutId = next;
    localStorage.setItem(MULTI_LAYOUT_KEY, next);
    if (multiLayoutSelect) multiLayoutSelect.value = next;

    // Set grid column mode for the layout
    const layout = MULTI_LAYOUTS[next];
    if (multiCamGrid && layout) {
        multiCamGrid.setAttribute('data-columns', layout.columns || 3);
    }

    if (multi.enabled && state.ui.nativeVideoMode && state.collection.active) {
        // In native video mode, reload the current segment with new layout
        // Use >= 0 check to properly handle segment 0 (0 is falsy in JS)
        const segIdx = nativeVideo.currentSegmentIdx >= 0 ? nativeVideo.currentSegmentIdx : 0;
        const wasPlaying = nativeVideo.playing;
        const currentTime = nativeVideo.master?.currentTime || 0;
        
        loadNativeSegment(segIdx).then(() => {
            // Restore playback position and state
            if (nativeVideo.master) {
                nativeVideo.master.currentTime = currentTime;
                syncMultiVideos(currentTime);
            }
            if (wasPlaying) {
                playNative();
            }
        });
    }
}

// Initialize zoom/pan module
initZoomPan({
    getMultiCamGrid: () => multiCamGrid,
    getState: () => state
});

initMultiCamFocus({
    getMultiCamGrid: () => multiCamGrid,
    getState: () => state,
    getNativeVideo: () => nativeVideo,
    getVideoBySlot: () => videoBySlot
});

initDashboardVisibility({
    getDashboardVis: () => dashboardVis,
    getState: () => state
});

initMapVisualization({
    getMap: () => map,
    getMapVis: () => mapVis,
    getMapPolyline: () => mapPolyline,
    getState: () => state
});

initDraggablePanels([dashboardVis, mapVis]);

// Handle clip deletion - refresh the clip list
// unloadOnly: if true, just unload the video without refreshing (used before delete to release file handles)
function handleClipDeleted(collectionId, folderPath, unloadOnly = false) {
    console.log('[DELETE] Clip deleted:', collectionId, folderPath, unloadOnly ? '(unload only)' : '');
    
    // Clear current selection if it was the deleted clip
    if (state.collection?.active?.id === collectionId) {
        state.collection.active = null;
        pauseNative();
        resetDashboardAndMap();
        
        // Force release file handles by removing and recreating video elements
        // Chromium's video decoder holds file handles even after clearing src
        if (nativeVideo) {
            // Clean up URL object references (revoke blob URLs)
            videoUrls.forEach((url, vid) => {
                if (url && url.startsWith('blob:')) {
                    URL.revokeObjectURL(url);
                }
            });
            videoUrls.clear();
            
            // Completely hide the video container to release all resources
            const videoGrid = document.getElementById('videoGrid');
            const multiCamGrid = document.getElementById('multiCamGrid');
            
            // Hide video grids and main container
            if (videoGrid) videoGrid.style.display = 'none';
            if (multiCamGrid) multiCamGrid.style.display = 'none';
            if (videoContainer) videoContainer.style.visibility = 'hidden';
            
            // Remove all video elements entirely (not just recreate)
            if (videoGrid) {
                const videos = Array.from(videoGrid.querySelectorAll('video'));
                videos.forEach(vid => {
                    vid.pause();
                    vid.removeAttribute('src');
                    vid.load();
                    vid.remove();
                });
            }
            
            // Also remove videoMain
            if (videoMain) {
                videoMain.pause();
                videoMain.removeAttribute('src');
                videoMain.load();
                videoMain.remove();
            }
            
            // Clear native video state
            stopTelemetryLoop();
            nativeVideo.master = null;
            nativeVideo.seiData = null;
            nativeVideo.mapPath = null;
            nativeVideo.currentSegmentIdx = -1;
        }
        
        // Hide overlays
        if (dashboardVis) dashboardVis.classList.add('hidden');
        if (mapVis) mapVis.classList.add('hidden');
    }
    
    // If unloadOnly, don't refresh - we're just releasing file handles before delete
    if (unloadOnly) return;
    
    // Re-scan the folder to refresh the library
    if (baseFolderPath && window.electronAPI?.readDir) {
        traverseDirectoryElectron(baseFolderPath).then(() => {
            // Re-render the clip list with updated data
            renderClipList();
        }).catch(err => {
            console.error('[DELETE] Failed to refresh folder:', err);
        });
    }
}

initClipBrowser({
    getState: () => state,
    getLibrary: () => library,
    getSelection: () => selection,
    clipList,
    dayFilter,
    selectDayCollection,
    formatEventReason,
    getBaseFolderPath: () => baseFolderPath,
    onClipDeleted: handleClipDeleted
});

// Initialize drive browser
const SHOW_DRIVE_STATS_KEY = 'showDriveStats';
let showDriveStats = localStorage.getItem(SHOW_DRIVE_STATS_KEY) !== '0';

const SHOW_FSD_EVENTS_KEY = 'showFsdEvents';
let showFsdEvents = localStorage.getItem(SHOW_FSD_EVENTS_KEY) !== '0';

initDriveBrowser({
    getState: () => state,
    getDriveState: () => state.sentryUsb,
    driveList,
    getUseMetric: () => useMetric,
    getShowDriveStats: () => showDriveStats,
    onDriveSelected: (drive) => {
        if (!state.sentryUsb.hasFootage?.has(drive.id)) {
            notify(`No footage for this drive (${drive.date}) in the loaded clips folder.`, { type: 'info' });
            return;
        }
        selectDriveCollection(drive);
    }
});

const settingsShowDriveStats = document.getElementById('settingsShowDriveStats');
if (settingsShowDriveStats) {
    settingsShowDriveStats.checked = showDriveStats;
    settingsShowDriveStats.addEventListener('change', () => {
        showDriveStats = settingsShowDriveStats.checked;
        localStorage.setItem(SHOW_DRIVE_STATS_KEY, showDriveStats ? '1' : '0');
        renderDriveList();
    });
}

const settingsShowFsdEvents = document.getElementById('settingsShowFsdEvents');
if (settingsShowFsdEvents) {
    settingsShowFsdEvents.checked = showFsdEvents;
    settingsShowFsdEvents.addEventListener('change', () => {
        showFsdEvents = settingsShowFsdEvents.checked;
        localStorage.setItem(SHOW_FSD_EVENTS_KEY, showFsdEvents ? '1' : '0');
        refreshFsdEventMarkers();
    });
}

// Drives tab bar switching
function switchToClipsTab() {
    if (!clipList || !driveList || !clipDriveTabBar) return;
    clipList.style.display = '';
    driveList.style.display = 'none';
    if (clipBrowserDayfilter) clipBrowserDayfilter.style.display = '';
    if (driveTagFilterRow) driveTagFilterRow.style.display = 'none';
    clipDriveTabBar.querySelectorAll('.clip-drive-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.panel === 'clips');
    });
}

function switchToDrivesTab() {
    if (!clipList || !driveList || !clipDriveTabBar) return;
    clipList.style.display = 'none';
    driveList.style.display = '';
    if (clipBrowserDayfilter) clipBrowserDayfilter.style.display = 'none';
    if (driveTagFilterRow) driveTagFilterRow.style.display = '';
    clipDriveTabBar.querySelectorAll('.clip-drive-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.panel === 'drives');
    });
    renderDriveList();
}

if (clipDriveTabBar) {
    clipDriveTabBar.addEventListener('click', (e) => {
        const tab = e.target.closest('.clip-drive-tab');
        if (!tab) return;
        if (tab.dataset.panel === 'clips') switchToClipsTab();
        else if (tab.dataset.panel === 'drives') switchToDrivesTab();
    });
}

/**
 * Draw or redraw FSD event markers (disengagements + accel pushes) on the map.
 * Reads from the active collection's driveFsdEvents and the showFsdEvents toggle.
 * Call after polylines are drawn, or when the toggle changes.
 */
function refreshFsdEventMarkers() {
    // Remove existing event markers
    for (const m of fsdEventMarkers) m.remove();
    fsdEventMarkers = [];

    if (!map || !showFsdEvents) return;

    const events = state.collection.active?.driveFsdEvents;
    if (!events?.length) return;

    for (const ev of events) {
        if (!isFinite(ev.lat) || !isFinite(ev.lng)) continue;

        const isDisengage = ev.type === 'disengagement';
        // Match SentryUSB Web UI: red "D" for disengagement, amber "A" for accel push
        const color = isDisengage ? '#ef4444' : '#f59e0b';
        const letter = isDisengage ? 'D' : 'A';
        const title = isDisengage ? 'FSD Disengagement' : 'Accel Push';

        const marker = L.marker([ev.lat, ev.lng], {
            icon: L.divIcon({
                className: '',
                html: `<div title="${title}" style="width:16px;height:16px;border-radius:50%;background:${color};border:2px solid #fff;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:bold;color:#fff;line-height:1;box-shadow:0 1px 4px rgba(0,0,0,0.5)">${letter}</div>`,
                iconSize: [16, 16],
                iconAnchor: [8, 8],
            }),
        }).bindTooltip(title, { permanent: false, direction: 'top', offset: [0, -10] });

        marker.addTo(map);
        fsdEventMarkers.push(marker);
    }
}

/**
 * Load a virtual collection containing only the clips that belong to a drive.
 * Handles drives spanning multiple days (e.g. past midnight) by loading all
 * calendar dates the drive spans and combining their clip groups.
 */
async function selectDriveCollection(drive) {
    // Collect all unique calendar dates this drive spans (from its route timestamp keys)
    const neededDates = [...new Set(drive.routeTimestampKeys.map(k => k.split('_')[0]).filter(Boolean))];

    if (window.electronAPI && folderStructure?.dateHandles) {
        // Load the primary date first (this populates library.clipGroups via mergeIntoLibrary)
        const primaryDate = neededDates[0] ?? drive.date;
        const hasPrimary = library.clipGroups.some(g => g.timestampKey?.startsWith(primaryDate + '_'));
        if (!hasPrimary && folderStructure.dateHandles.has(primaryDate)) {
            await loadDateContentElectron(primaryDate);
        }

        // For any extra dates (e.g., drive crosses midnight into the next day),
        // gather their files and append their groups directly to library.clipGroups
        // without triggering a full mergeIntoLibrary (which would replace the primary date's clips).
        for (const date of neededDates.slice(1)) {
            const hasDate = library.clipGroups.some(g => g.timestampKey?.startsWith(date + '_'));
            if (!hasDate && folderStructure.dateHandles.has(date)) {
                const extraFiles = await gatherFilesForDateElectron(date);
                if (extraFiles.length > 0) {
                    const extraBuilt = await buildTeslaCamIndex(extraFiles, folderStructure?.root?.name);
                    library.clipGroups = [...library.clipGroups, ...extraBuilt.groups];
                    for (const g of extraBuilt.groups) library.clipGroupById.set(g.id, g);
                }
            }
        }
    }

    const driveKeys = new Set(drive.routeTimestampKeys);
    const matchingGroups = library.clipGroups
        .filter(g => g.timestampKey && driveKeys.has(g.timestampKey))
        .sort((a, b) => (a.timestampKey || '').localeCompare(b.timestampKey || ''));

    if (matchingGroups.length === 0) {
        notify('No matching clips found for this drive.', { type: 'info' });
        return;
    }

    // Build a virtual collection with the same shape as buildCollectionFromGroups
    const startEpochMs = parseTimestampKeyToEpochMs(matchingGroups[0].timestampKey) ?? 0;
    const lastStart = parseTimestampKeyToEpochMs(matchingGroups[matchingGroups.length - 1].timestampKey) ?? startEpochMs;
    const durationMs = Math.max(1, lastStart + 60_000 - startEpochMs);
    const segmentStartsMs = matchingGroups.map(g => {
        const t = parseTimestampKeyToEpochMs(g.timestampKey) ?? startEpochMs;
        return Math.max(0, t - startEpochMs);
    });

    // Drive GPS points/FSD events are fetched lazily: the drive-list IPC reply
    // omits them so loading 800+ drives doesn't ship hundreds of MB over IPC
    // (structured-clone of that payload froze the whole app). One drive ≈ 1MB.
    if (!drive.points && window.electronAPI?.getSentryUsbDriveDetail) {
        try {
            const detail = await window.electronAPI.getSentryUsbDriveDetail(drive.id);
            if (detail?.success) {
                drive.points = detail.points;
                drive.fsdEvents = detail.fsdEvents;
            }
        } catch (err) {
            console.warn('[SentryUSB] Failed to fetch drive detail:', err);
        }
    }

    // Convert full drive route to mapPath format for GPS map pre-population.
    // drive.points are 5-tuples: [lat, lng, 0, speedMps, autopilotActive(0|1)]
    const driveMapPath = (drive.points ?? []).map(p => ({
        lat: p[0], lon: p[1], timestampMs: 0, autopilot: p[4] > 0
    }));

    const collKey = `drive-${drive.id}`;
    const coll = {
        id: collKey,
        key: collKey,
        day: drive.date,
        clipType: 'RecentClips',
        tag: 'RecentClips',
        groups: matchingGroups,
        meta: null,
        durationMs,
        segmentStartsMs,
        anchorMs: 0,
        anchorGroupId: matchingGroups[0]?.id || null,
        sortEpoch: lastStart + 60_000,
        driveMapPath: driveMapPath.length > 0 ? driveMapPath : null,
        driveFsdEvents: drive.fsdEvents ?? [],
    };

    if (!library.dayCollections) library.dayCollections = new Map();
    library.dayCollections.set(collKey, coll);

    // Load the collection without switching the sidebar tab —
    // user stays on the Drives tab to browse, video plays in the main area.
    selectDayCollection(collKey);
}

// Drive tag filter input
if (driveTagFilter) {
    let driveFilterDebounce = null;
    driveTagFilter.addEventListener('input', () => {
        clearTimeout(driveFilterDebounce);
        driveFilterDebounce = setTimeout(() => {
            setDriveTagFilter(driveTagFilter.value.trim());
        }, 200);
    });
}

// Initialize settings modal with dependencies
initSettingsModalDeps({
    getState: () => state,
    getUseMetric: () => useMetric,
    updateEventCameraHighlight,
    resetCameraOrder,
    openDevSettingsModal: openDevSettings,
    setLayoutStyle: (style) => window._panelMode?.setLayoutStyle?.(style),
    getLayoutStyle: () => window._panelMode?.getLayoutStyle?.() || 'modern'
});
initSettingsModal();
initSettingsSearch();
initDevSettingsModal();
initChangelogModal();

// Initialize diagnostics system (captures console logs for Support ID)
initDiagnostics();
logDiagnosticEvent('app_initialized');

// Initialize Welcome Guide for first-time users
initWelcomeGuide();

// Expose welcome guide functions for developer settings
window._resetWelcomeGuide = resetWelcomeGuide;
window._openWelcomeGuide = openWelcomeGuide;

// Expose welcome screen (Privacy & Terms) functions for developer settings
window._resetWelcomeScreen = resetWelcomeScreen;
window._showWelcomeScreen = showWelcomeScreen;

// Expose notify function globally for modules
window.showNotification = notify;

// Discrete playback-speed steps (must mirror #speedSelect <option> values in index.html).
const SPEED_OPTIONS = [0.5, 1, 2, 3, 4];

/**
 * Apply a playback rate, sync the dropdown UI, and persist to localStorage.
 * Used by both the speedSelect onchange handler and the speed keybinds.
 */
function setPlaybackSpeed(rate) {
    const r = parseFloat(rate) || 1;
    applyPlaybackRate(r);
    if (speedSelect) speedSelect.value = String(r);
    localStorage.setItem('playbackRate', String(r));
}

/**
 * Step through SPEED_OPTIONS by `dir` (+1 = faster, -1 = slower). Clamps at ends.
 */
function bumpPlaybackSpeed(dir) {
    const cur = state.ui.playbackRate || 1;
    let i = SPEED_OPTIONS.indexOf(cur);
    if (i === -1) {
        // Current rate isn't an exact option (shouldn't normally happen) — snap to nearest
        i = SPEED_OPTIONS.reduce((best, v, idx) =>
            Math.abs(v - cur) < Math.abs(SPEED_OPTIONS[best] - cur) ? idx : best, 0);
    }
    const next = Math.max(0, Math.min(SPEED_OPTIONS.length - 1, i + dir));
    if (SPEED_OPTIONS[next] !== cur) setPlaybackSpeed(SPEED_OPTIONS[next]);
}

// Initialize keybind actions
initKeybindActions({
    playPause: () => {
        const playBtn = $('playBtn');
        if (playBtn && !playBtn.disabled) playBtn.click();
    },
    skipForward: () => {
        skipSeconds(window._skipDuration || 15);
    },
    skipBackward: () => {
        skipSeconds(-(window._skipDuration || 15));
    },
    speedUp: () => bumpPlaybackSpeed(+1),
    speedDown: () => bumpPlaybackSpeed(-1),
    speedReset: () => setPlaybackSpeed(1),
    speedMax: () => setPlaybackSpeed(SPEED_OPTIONS[SPEED_OPTIONS.length - 1]),
    toggleDash: () => {
        const dashboardToggle = $('dashboardToggle');
        if (dashboardToggle) {
            dashboardToggle.checked = !dashboardToggle.checked;
            dashboardToggle.dispatchEvent(new Event('change'));
            const settingsDashboardToggle = $('settingsDashboardToggle');
            if (settingsDashboardToggle) settingsDashboardToggle.checked = dashboardToggle.checked;
        }
    },
    toggleMap: () => {
        const mapToggle = $('mapToggle');
        if (mapToggle) {
            mapToggle.checked = !mapToggle.checked;
            mapToggle.dispatchEvent(new Event('change'));
            const settingsMapToggle = $('settingsMapToggle');
            if (settingsMapToggle) settingsMapToggle.checked = mapToggle.checked;
        }
    },
    toggleMetric: () => {
        const metricToggle = $('metricToggle');
        if (metricToggle) {
            metricToggle.checked = !metricToggle.checked;
            metricToggle.dispatchEvent(new Event('change'));
            const settingsMetricToggle = $('settingsMetricToggle');
            if (settingsMetricToggle) settingsMetricToggle.checked = metricToggle.checked;
        }
    },
    toggleClips: () => {
        const clipsCollapseBtn = $('clipsCollapseBtn');
        if (clipsCollapseBtn) clipsCollapseBtn.click();
    },
    setMarkerIn: () => {
        const setStartMarkerBtn = $('setStartMarkerBtn');
        if (setStartMarkerBtn && !setStartMarkerBtn.disabled) setStartMarkerBtn.click();
    },
    setMarkerOut: () => {
        const setEndMarkerBtn = $('setEndMarkerBtn');
        if (setEndMarkerBtn && !setEndMarkerBtn.disabled) setEndMarkerBtn.click();
    },
    nextClip: () => {
        const items = Array.from(document.querySelectorAll('#clipList .clip-item'));
        if (items.length === 0) return;
        const idx = items.findIndex(el => el.classList.contains('selected'));
        const next = items[idx + 1] || items[0]; // wrap to first
        const key = next.dataset.groupid;
        if (key) selectDayCollection(key);
        next.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
    prevClip: () => {
        const items = Array.from(document.querySelectorAll('#clipList .clip-item'));
        if (items.length === 0) return;
        const idx = items.findIndex(el => el.classList.contains('selected'));
        const prev = items[idx - 1] || items[items.length - 1]; // wrap to last
        const key = prev.dataset.groupid;
        if (key) selectDayCollection(key);
        prev.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
});

// Initialize global keybind listener
initGlobalKeybindListener();

// Auto-load default folder on startup
async function loadDefaultFolderOnStartup() {
    let savedFolder = null;
    if (window.electronAPI?.getSetting) {
        savedFolder = await window.electronAPI.getSetting('defaultFolder');
    }
    if (savedFolder && window.electronAPI?.readDir) {
        try {
            console.log('Auto-loading default dashcam folder:', savedFolder);
            baseFolderPath = savedFolder;
            showLoading('Loading default folder...', 'Looking for dashcam clips');
            await traverseDirectoryElectron(savedFolder);
        } catch (err) {
            hideLoading();
            console.error('Failed to load default folder:', err);
            // Don't show error - folder might have been moved/deleted
        }
    }
}

// Call after a short delay to allow UI to initialize
setTimeout(loadDefaultFolderOnStartup, 500);

// In-flight load tracker: dedupes concurrent loads of the same file (e.g., the
// settings file picker firing while the startup auto-load is still streaming a
// large drive-data.json) so we don't pile up parallel reads of a 1GB file.
const _inFlightSentryUsbLoads = new Map();

/**
 * Load and parse a SentryUSB drive-data.json file.
 * Streaming parse + drive grouping happen in the main process — the renderer
 * receives only the final small `drives` array. This handles files that exceed
 * V8's max string length (~512MB), which a renderer-side fs:readFile + JSON.parse
 * cannot.
 * @param {string} filePath - Absolute path to drive-data.json
 * @returns {Promise<{success: boolean, driveCount?: number, routeCount?: number, error?: string}>}
 */
async function loadSentryUsbData(filePath) {
    if (!filePath) return { success: false, error: 'No file path provided' };

    // If the same file is already being loaded, return that promise instead of
    // kicking off a second parallel parse of a potentially 1GB file.
    if (_inFlightSentryUsbLoads.has(filePath)) {
        console.log('[SentryUSB] Load already in flight for', filePath, '— reusing promise');
        return _inFlightSentryUsbLoads.get(filePath);
    }

    const sentryUsb = state.sentryUsb;
    sentryUsb.loading = true;
    // Reflect the loading state in the Drives tab so the user sees something
    // is happening instead of the "No drive data loaded" placeholder.
    try { renderDriveList(); } catch {}

    const promise = (async () => {
        try {
            const result = await window.electronAPI.loadSentryUsbDrives(filePath);
            if (!result?.success) {
                const err = result?.error || 'Unknown load error';
                console.error('[SentryUSB] Failed to load drive data:', err);
                return { success: false, error: err };
            }
            const { topKeys, routesLen, drives, driveCount, routeCount } = result;
            console.log(`[SentryUSB] File keys: ${(topKeys || []).join(', ')} | Routes: ${routesLen ?? 'not found'}`);

            sentryUsb.dataPath = filePath;
            sentryUsb.drives = drives;
            sentryUsb.loaded = true;

            // Cross-reference with currently loaded clips.
            // Pass folderStructure.dates as a fallback so drives from dates other than
            // the currently-loaded date still get the Footage badge (Electron mode loads
            // clips one date at a time, so library.clipGroups is date-scoped).
            sentryUsb.hasFootage = matchClipsTodrives(drives, library.clipGroups, folderStructure?.dates);

            console.log(`[SentryUSB] Loaded ${driveCount} drives from ${routeCount} routes`);
            console.log(`[SentryUSB] Footage matched: ${sentryUsb.hasFootage.size}/${driveCount} drives`);
            if (drives.length > 0) {
                console.log(`[SentryUSB] Sample route keys (drive 1):`, drives[0].routeTimestampKeys?.slice(0, 3));
            }
            if (library.clipGroups.length > 0) {
                console.log(`[SentryUSB] Sample clip keys:`, library.clipGroups.slice(0, 3).map(g => g.timestampKey));
            } else {
                console.log(`[SentryUSB] No clips loaded yet — matching will re-run when clips load`);
            }
            return { success: true, driveCount, routeCount };
        } catch (err) {
            console.error('[SentryUSB] Failed to load drive data:', err);
            return { success: false, error: err?.message || String(err) };
        } finally {
            sentryUsb.loading = false;
            _inFlightSentryUsbLoads.delete(filePath);
            // Always refresh the Drives tab and badge after the load settles so
            // success → drive list, failure → empty placeholder.
            try { updateDrivesTabVisibility(); } catch {}
            try { renderDriveList(); } catch {}
        }
    })();
    _inFlightSentryUsbLoads.set(filePath, promise);
    return promise;
}

/**
 * Clear loaded SentryUSB drive data and refresh the Drives tab placeholder.
 */
function clearSentryUsbData() {
    const sentryUsb = state.sentryUsb;
    sentryUsb.drives = [];
    sentryUsb.hasFootage = new Set();
    sentryUsb.loaded = false;
    sentryUsb.dataPath = null;

    switchToClipsTab();
    updateDrivesTabVisibility();
    renderDriveList(); // Refresh to show the "no data" placeholder
}

/**
 * Update the Drives tab count badge. The tab bar is always visible.
 */
function updateDrivesTabVisibility() {
    if (!clipDriveTabBar) return;
    if (drivesTabCount) {
        const hasData = state.sentryUsb.loaded && state.sentryUsb.drives.length > 0;
        drivesTabCount.textContent = hasData ? String(state.sentryUsb.drives.length) : '';
    }
}

// Expose globally so settingsModal.js can call them without circular import
window._loadSentryUsbData = loadSentryUsbData;
window._clearSentryUsbData = clearSentryUsbData;

// Re-render drive list when time format changes so times update immediately
window.addEventListener('timeFormatChanged', () => {
    if (driveList && driveList.style.display !== 'none') renderDriveList();
});

// Auto-load drive data on startup
async function loadSentryUsbDataOnStartup() {
    let savedPath = null;
    if (window.electronAPI?.getSetting) {
        savedPath = await window.electronAPI.getSetting('sentryUsbDataPath');
    }
    if (savedPath) {
        console.log('[SentryUSB] Auto-loading drive data from:', savedPath);
        await loadSentryUsbData(savedPath);
    }
}

// Load after clips folder startup (slight delay to avoid competing with folder load)
setTimeout(loadSentryUsbDataOnStartup, 800);

// Check for updates on startup (unless API requests are disabled in developer settings).
// Runs silently in the background — if an update is available, the existing
// update-available / force-manual modals surface it. No blocking UI on startup.
async function checkForUpdatesOnStartup() {
    let apiRequestsDisabled = false;

    // Load from file-based settings - check developer setting for disabling API requests
    try {
        const savedValue = await window.electronAPI.getSetting('devDisableApiRequests');
        apiRequestsDisabled = savedValue === true;
    } catch (err) {
        console.log('[SETTINGS] Could not load devDisableApiRequests setting:', err);
    }

    // Check if privacy terms have been accepted - don't auto-update if welcome screen is needed
    let acceptedPrivacyVersion = 0;
    try {
        acceptedPrivacyVersion = await window.electronAPI.getSetting('acceptedPrivacyVersion') || 0;
    } catch (err) {
        console.log('[SETTINGS] Could not load settings:', err);
    }

    // Only check for updates if API requests are enabled AND privacy terms are accepted
    const shouldSkipUpdate = acceptedPrivacyVersion < 2;

    if (apiRequestsDisabled) {
        console.log('[UPDATE] Skipping auto-update check - API requests disabled in developer settings');
    } else if (!shouldSkipUpdate && window.electronAPI?.checkForUpdates) {
        console.log('[UPDATE] Auto-checking for updates on startup');
        try {
            await window.electronAPI.checkForUpdates();
        } catch (err) {
            console.log('[UPDATE] Check failed:', err?.message || err);
        }
    } else if (shouldSkipUpdate) {
        console.log('[UPDATE] Skipping auto-update check - waiting for welcome screen acceptance');
    }
}

// Delay update check to allow app to fully initialize (not applicable in MAS builds)
if (!window.electronAPI?.isMas) {
    setTimeout(checkForUpdatesOnStartup, 2000);
}

// Show welcome guide for first-time users (only if privacy already accepted)
// If privacy modal is showing, the guide will be triggered after acceptance via welcomeScreen.js
window._checkAndShowWelcomeGuide = checkAndShowWelcomeGuide;
(async () => {
    if (window.electronAPI?.getSetting) {
        const acceptedVersion = await window.electronAPI.getSetting('acceptedPrivacyVersion');
        if (acceptedVersion && acceptedVersion >= 2) {
            setTimeout(checkAndShowWelcomeGuide, 1000);
        }
    }
})();

// Fast tooltips - JS-based, appended to body to escape all stacking contexts
(function initTooltips() {
    const tip = document.createElement('div');
    tip.className = 'tooltip-popup';
    document.body.appendChild(tip);
    let showTimer = null;
    let currentEl = null;

    function show(el) {
        const text = el.getAttribute('data-tip');
        if (!text || el.disabled) return;
        tip.textContent = text;
        // Position above the element, centered
        const rect = el.getBoundingClientRect();
        tip.style.left = '0px';
        tip.style.top = '0px';
        tip.classList.add('visible');
        // Measure after making visible (but opacity transition handles appearance)
        const tipRect = tip.getBoundingClientRect();
        let left = rect.left + rect.width / 2 - tipRect.width / 2;
        let top = rect.top - tipRect.height - 6;
        // Clamp to viewport
        if (left < 4) left = 4;
        if (left + tipRect.width > window.innerWidth - 4) left = window.innerWidth - 4 - tipRect.width;
        if (top < 4) { top = rect.bottom + 6; } // flip below if no room above
        tip.style.left = left + 'px';
        tip.style.top = top + 'px';
    }

    function hide() {
        clearTimeout(showTimer);
        showTimer = null;
        currentEl = null;
        tip.classList.remove('visible');
    }

    document.addEventListener('mouseover', (e) => {
        const el = e.target.closest('[data-tip]');
        if (!el || !el.getAttribute('data-tip') || el.disabled) { if (currentEl) hide(); return; }
        if (el === currentEl) return;
        clearTimeout(showTimer);
        currentEl = el;
        showTimer = setTimeout(() => show(el), 150);
    });
    document.addEventListener('mouseout', (e) => {
        const el = e.target.closest('[data-tip]');
        if (el === currentEl) hide();
    });
    // Hide on scroll/click
    document.addEventListener('scroll', hide, true);
    document.addEventListener('mousedown', hide);

    // Convert existing title attributes to data-tip
    document.querySelectorAll('[title]').forEach(el => {
        if (!el.getAttribute('data-tip')) el.setAttribute('data-tip', el.title);
        el.removeAttribute('title');
    });
    // Observe DOM for dynamically added title attributes
    new MutationObserver(mutations => {
        for (const m of mutations) {
            if (m.type === 'attributes' && m.attributeName === 'title') {
                const el = m.target;
                if (el.title) {
                    el.setAttribute('data-tip', el.title);
                    el.removeAttribute('title');
                }
            }
        }
    }).observe(document.body, { attributes: true, attributeFilter: ['title'], subtree: true });
})();

// File Handling - Use File System Access API for lazy directory traversal
// This prevents the browser from loading all files into memory at once

async function openFolderPicker() {
    // Use Electron's native APIs for both path resolution and directory traversal
    // This gives us actual file paths for FFmpeg export
    
    if (window.electronAPI?.openFolder && window.electronAPI?.readDir) {
        try {
            const savedFolder = window.electronAPI?.getSetting ? await window.electronAPI.getSetting('defaultFolder') : '';
            const folderPath = await window.electronAPI.openFolder(savedFolder || '');
            if (!folderPath) {
                return; // User cancelled
            }
            
            baseFolderPath = folderPath;
            console.log('Selected folder path:', baseFolderPath);
            
            showLoading('Scanning folder...', 'Looking for dashcam clips');
            await traverseDirectoryElectron(folderPath);
            return;
        } catch (err) {
            hideLoading();
            console.error('Folder picker error:', err);
            notify(t('ui.notifications.failedToOpenFolder', { error: err.message }), { type: 'error' });
            return;
        }
    }
    
    // Fallback to File System Access API (no export support)
    if ('showDirectoryPicker' in window) {
        try {
            showLoading('Opening folder...', 'Please select a dashcam folder');
            baseFolderPath = null; // No actual path available
            const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
            await traverseDirectoryHandle(dirHandle);
        } catch (err) {
            hideLoading();
            if (err.name !== 'AbortError') {
                console.error('Folder picker error:', err);
                notify(t('ui.notifications.failedToOpenFolder', { error: err.message }), { type: 'error' });
            }
        }
    } else {
        // Fallback to webkitdirectory for unsupported browsers
        folderInput.click();
    }
}

// Traverse directory using Electron's fs APIs (provides actual file paths)
async function traverseDirectoryElectron(dirPath) {
    // Normalize path separators and extract folder name
    const normalizedPath = dirPath.replace(/\\/g, '/');
    const folderName = normalizedPath.split('/').pop();
    const folderNameLower = folderName.toLowerCase();
    
    // Create a pseudo directory handle structure for compatibility
    rootDirHandle = { name: folderName, kind: 'directory' };
    folderStructure = {
        root: rootDirHandle,
        recentClips: null,
        sentryClips: null,
        savedClips: null,
        dates: new Set(),
        dateHandles: new Map()
    };
    
    // Check if the selected folder itself is a clip folder
    const isClipFolder = ['recentclips', 'sentryclips', 'savedclips'].includes(folderNameLower);
    
    try {
        if (isClipFolder) {
            // User selected a clip folder directly (e.g., SentryClips)
            const pseudoEntry = { name: folderName, path: dirPath, isDirectory: true };
            if (folderNameLower === 'recentclips') {
                folderStructure.recentClips = pseudoEntry;
                await scanRecentClipsElectron(dirPath);
            } else if (folderNameLower === 'sentryclips') {
                folderStructure.sentryClips = pseudoEntry;
                await scanEventFolderElectron(dirPath, 'sentry');
            } else if (folderNameLower === 'savedclips') {
                folderStructure.savedClips = pseudoEntry;
                await scanEventFolderElectron(dirPath, 'saved');
            }
        } else {
            // User selected a parent folder (e.g., TeslaCam, teslausb, or any custom name)
            // Scan for clip subfolders
            const entries = await window.electronAPI.readDir(dirPath);
            
            let foundClipFolders = false;
            for (const entry of entries) {
                if (!entry.isDirectory) continue;
                const name = entry.name.toLowerCase();
                
                if (name === 'recentclips') {
                    folderStructure.recentClips = entry;
                    await scanRecentClipsElectron(entry.path);
                    foundClipFolders = true;
                } else if (name === 'sentryclips') {
                    folderStructure.sentryClips = entry;
                    await scanEventFolderElectron(entry.path, 'sentry');
                    foundClipFolders = true;
                } else if (name === 'savedclips') {
                    folderStructure.savedClips = entry;
                    await scanEventFolderElectron(entry.path, 'saved');
                    foundClipFolders = true;
                }
            }
            
            // If no Tesla folder structure found, check for loose video clips directly in the folder
            if (!foundClipFolders) {
                await scanLooseClipsElectron(dirPath);
            }
        }
    } catch (err) {
        console.error('Error scanning folder:', err);
    }
    
    hideLoading();
    
    if (!folderStructure.dates.size) {
        notify(t('ui.notifications.noDashcamClipsFound'), { type: 'warn' });
        return;
    }
    
    // Build date list and update UI
    const sortedDates = Array.from(folderStructure.dates).sort().reverse();
    library.allDates = sortedDates;
    library.folderLabel = folderName;
    library.clipGroups = [];
    library.clipGroupById = new Map();
    library.dayCollections = new Map();
    library.dayData = new Map();
    
    clipBrowserSubtitle.textContent = folderName;
    dayFilter.innerHTML = `<option value="">${t('ui.clipBrowser.selectDate')}</option>`;
    sortedDates.forEach(date => {
        const opt = document.createElement('option');
        opt.value = date;
        opt.textContent = formatDateDisplay(date);
        dayFilter.appendChild(opt);
    });
    
    // Hide drop overlay
    dropOverlay.classList.add('hidden');
    
    if (sortedDates.length > 0) {
        dayFilter.value = sortedDates[0];
        updateDayFilterMarker();
        await loadDateContentElectron(sortedDates[0]);
    }
    
    notify(t('ui.notifications.foundDatesWithClips', { count: sortedDates.length }), { type: 'success' });
}

// Scan RecentClips using Electron fs
async function scanRecentClipsElectron(dirPath) {
    try {
        const entries = await window.electronAPI.readDir(dirPath);
        
        for (const entry of entries) {
            if (entry.isDirectory) {
                // Date subfolder
                const date = entry.name;
                if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                    folderStructure.dates.add(date);
                    if (!folderStructure.dateHandles.has(date)) {
                        folderStructure.dateHandles.set(date, { recent: entry, sentry: new Map(), saved: new Map() });
                    } else {
                        folderStructure.dateHandles.get(date).recent = entry;
                    }
                }
            } else if (entry.isFile && entry.name.endsWith('.mp4')) {
                // Flat file structure - extract date from filename
                const match = entry.name.match(/^(\d{4}-\d{2}-\d{2})_/);
                if (match) {
                    const date = match[1];
                    folderStructure.dates.add(date);
                    if (!folderStructure.dateHandles.has(date)) {
                        folderStructure.dateHandles.set(date, { recent: { path: dirPath, isFlat: true }, sentry: new Map(), saved: new Map() });
                    }
                }
            }
        }
    } catch (err) {
        console.warn('Error scanning RecentClips:', err);
    }
}

// Scan Sentry/Saved clips using Electron fs
async function scanEventFolderElectron(dirPath, clipType) {
    try {
        const entries = await window.electronAPI.readDir(dirPath);
        
        for (const entry of entries) {
            if (!entry.isDirectory) continue;
            
            // Event folders have format: YYYY-MM-DD_HH-MM-SS
            const match = entry.name.match(/^(\d{4}-\d{2}-\d{2})_/);
            if (match) {
                const date = match[1];
                folderStructure.dates.add(date);
                
                if (!folderStructure.dateHandles.has(date)) {
                    folderStructure.dateHandles.set(date, { recent: null, sentry: new Map(), saved: new Map() });
                }
                
                const dateData = folderStructure.dateHandles.get(date);
                if (clipType === 'sentry') {
                    dateData.sentry.set(entry.name, entry);
                } else {
                    dateData.saved.set(entry.name, entry);
                }
            }
        }
    } catch (err) {
        console.warn(`Error scanning ${clipType} clips:`, err);
    }
}

// Helper: extract date from a Tesla-style or generic video filename
function extractDateFromFilename(filename) {
    const teslaMatch = filename.match(/^(\d{4}-\d{2}-\d{2})_/);
    if (teslaMatch) return teslaMatch[1];
    const compactMatch = filename.match(/(\d{4})(\d{2})(\d{2})/);
    if (compactMatch) return `${compactMatch[1]}-${compactMatch[2]}-${compactMatch[3]}`;
    return 'Unknown';
}

// Register a loose date entry in folderStructure
function registerLooseDate(date, dirPath, subfolders = null) {
    folderStructure.dates.add(date);
    if (!folderStructure.dateHandles.has(date)) {
        folderStructure.dateHandles.set(date, { 
            recent: null, 
            sentry: new Map(), 
            saved: new Map(),
            loose: { path: dirPath, isLoose: true, subfolders: subfolders || [] },
            isCustomStructure: true
        });
    } else {
        const dateData = folderStructure.dateHandles.get(date);
        dateData.isCustomStructure = true;
        if (!dateData.loose) {
            dateData.loose = { path: dirPath, isLoose: true, subfolders: subfolders || [] };
        } else if (subfolders) {
            // Merge subfolder paths
            const existing = dateData.loose.subfolders || [];
            dateData.loose.subfolders = [...existing, ...subfolders.filter(s => !existing.includes(s))];
        }
    }
}

// Scan for loose video clips in a folder (no Tesla folder structure)
// Also recurses into subfolders (1 level) to find event-style folders with Tesla-named clips
async function scanLooseClipsElectron(dirPath) {
    try {
        const entries = await window.electronAPI.readDir(dirPath);
        let foundTeslaFiles = false;
        const subfolderPaths = []; // Track subfolders that contain Tesla clips
        
        for (const entry of entries) {
            if (entry.isFile) {
                const nameLower = entry.name.toLowerCase();
                // Check for video files
                if (nameLower.endsWith('.mp4') || nameLower.endsWith('.avi') || nameLower.endsWith('.mov') || nameLower.endsWith('.mkv')) {
                    const date = extractDateFromFilename(entry.name);
                    registerLooseDate(date, dirPath);
                    if (date !== 'Unknown') foundTeslaFiles = true;
                }
            } else if (entry.isDirectory) {
                // Recurse 1 level into subfolders to find Tesla-named clips
                // This handles custom folders like "Honk/2025-01-15_10-30-00/2025-...-front.mp4"
                try {
                    const subEntries = await window.electronAPI.readDir(entry.path);
                    let hasClipsInSub = false;
                    for (const subEntry of subEntries) {
                        if (!subEntry.isFile) continue;
                        const subNameLower = subEntry.name.toLowerCase();
                        if (subNameLower.endsWith('.mp4')) {
                            const date = extractDateFromFilename(subEntry.name);
                            if (date !== 'Unknown') {
                                subfolderPaths.push(entry.path);
                                registerLooseDate(date, dirPath, [entry.path]);
                                hasClipsInSub = true;
                                foundTeslaFiles = true;
                            }
                        }
                    }
                } catch (subErr) {
                    // Skip inaccessible subfolders
                }
            }
        }
        
        // Mark as custom structure if we found Tesla-named files
        if (foundTeslaFiles) {
            folderStructure.isCustomStructure = true;
        }
    } catch (err) {
        console.warn('Error scanning loose clips:', err);
    }
}

/**
 * Gather all Electron file entries for a single date from folderStructure.
 * Returns raw file-like objects without building an index.
 * Used by both loadDateContentElectron and selectDriveCollection (multi-date).
 */
async function gatherFilesForDateElectron(date) {
    if (!folderStructure?.dateHandles?.has(date)) return [];
    const dateData = folderStructure.dateHandles.get(date);
    const files = [];

    // RecentClips
    if (dateData.recent) {
        try {
            const entries = await window.electronAPI.readDir(dateData.recent.path);
            for (const entry of entries) {
                if (!entry.isFile || !entry.name.endsWith('.mp4')) continue;
                if (dateData.recent.isFlat && !entry.name.startsWith(date)) continue;
                files.push({
                    name: entry.name,
                    path: entry.path,
                    webkitRelativePath: `${folderStructure.root.name}/RecentClips/${entry.name}`,
                    isElectronFile: true
                });
            }
        } catch (err) {
            console.warn('Error loading RecentClips:', err);
        }
    }

    // SentryClips events
    for (const [eventId, eventEntry] of dateData.sentry.entries()) {
        try {
            const entries = await window.electronAPI.readDir(eventEntry.path);
            for (const entry of entries) {
                if (!entry.isFile) continue;
                files.push({
                    name: entry.name,
                    path: entry.path,
                    webkitRelativePath: `${folderStructure.root.name}/SentryClips/${eventId}/${entry.name}`,
                    isElectronFile: true
                });
            }
        } catch (err) {
            console.warn(`Error loading Sentry event ${eventId}:`, err);
        }
    }

    // SavedClips events
    for (const [eventId, eventEntry] of dateData.saved.entries()) {
        try {
            const entries = await window.electronAPI.readDir(eventEntry.path);
            for (const entry of entries) {
                if (!entry.isFile) continue;
                files.push({
                    name: entry.name,
                    path: entry.path,
                    webkitRelativePath: `${folderStructure.root.name}/SavedClips/${eventId}/${entry.name}`,
                    isElectronFile: true
                });
            }
        } catch (err) {
            console.warn(`Error loading Saved event ${eventId}:`, err);
        }
    }

    // Loose clips
    if (dateData.loose) {
        const fileMatchesDate = (filename, targetDate) => {
            if (targetDate === 'Unknown') {
                return !filename.match(/^(\d{4}-\d{2}-\d{2})_/) && !filename.match(/(\d{4})(\d{2})(\d{2})/);
            }
            const fileDate = extractDateFromFilename(filename);
            return fileDate === targetDate || fileDate === 'Unknown';
        };
        const addFileEntry = (entry, relPathPrefix) => {
            files.push({
                name: entry.name,
                path: entry.path,
                webkitRelativePath: `${folderStructure.root.name}/${relPathPrefix}${entry.name}`,
                isElectronFile: true,
                isLooseClip: true
            });
        };
        try {
            const entries = await window.electronAPI.readDir(dateData.loose.path);
            for (const entry of entries) {
                if (!entry.isFile) continue;
                const nameLower = entry.name.toLowerCase();
                if (nameLower.endsWith('.mp4') || nameLower.endsWith('.avi') || nameLower.endsWith('.mov') || nameLower.endsWith('.mkv')) {
                    if (fileMatchesDate(entry.name, date)) addFileEntry(entry, '');
                }
            }
            for (const subPath of (dateData.loose.subfolders || [])) {
                try {
                    const subFolderName = subPath.replace(/\\/g, '/').split('/').pop();
                    const subEntries = await window.electronAPI.readDir(subPath);
                    for (const subEntry of subEntries) {
                        if (!subEntry.isFile) continue;
                        const subNameLower = subEntry.name.toLowerCase();
                        if (subNameLower.endsWith('.mp4') || subNameLower.endsWith('.json') || subNameLower.endsWith('.png')) {
                            if (subNameLower.endsWith('.mp4') && !fileMatchesDate(subEntry.name, date)) continue;
                            addFileEntry(subEntry, `${subFolderName}/`);
                        }
                    }
                } catch (subErr) {
                    console.warn('Error loading subfolder clips:', subErr);
                }
            }
        } catch (err) {
            console.warn('Error loading loose clips:', err);
        }
    }

    return files;
}

// Load date content using Electron fs
async function loadDateContentElectron(date) {
    if (!folderStructure?.dateHandles?.has(date)) {
        notify(t('ui.notifications.noDataForDate', { date: date }), { type: 'warn' });
        return;
    }

    showLoading('Loading clips...', `Loading ${date}...`);

    const files = await gatherFilesForDateElectron(date);

    hideLoading();

    if (files.length === 0) {
        notify(t('ui.notifications.noClipsFoundForDate', { date: date }), { type: 'info' });
        return;
    }

    // Build index with path information
    const built = await buildTeslaCamIndex(files, folderStructure?.root?.name);
    mergeIntoLibrary(built, date);

    // Update export button state after collection loads
    setTimeout(updateExportButtonState, 100);

    notify(t('ui.notifications.loadedFilesForDate', { count: files.length, date: formatDateDisplay(date) }), { type: 'success' });
}

function formatDateDisplay(dateStr) {
    try {
        const [year, month, day] = dateStr.split('-');
        const dateFormat = window._dateFormat || 'ymd';
        
        // Format based on global date format setting
        switch (dateFormat) {
            case 'mdy':
                return `${month}/${day}/${year}`;
            case 'dmy':
                return `${day}/${month}/${year}`;
            case 'ymd':
            default:
                return `${year}-${month}-${day}`;
        }
    } catch {
        return dateStr;
    }
}

// Store root directory handle for lazy loading
let rootDirHandle = null;
let folderStructure = null; // { recentClips: handle, sentryClips: handle, savedClips: handle, dates: Set }
let baseFolderPath = null; // Full file system path (only available when using Electron dialog)

// Quick folder structure scan - only reads folder names, not files
async function traverseDirectoryHandle(dirHandle) {
    showLoading('Scanning folder structure...', 'Finding available dates...');
    await yieldToUI();
    
    rootDirHandle = dirHandle;
    folderStructure = {
        root: dirHandle,
        recentClips: null,
        sentryClips: null,
        savedClips: null,
        dates: new Set(),
        // Store handles for event folders: Map<date, Map<clipType, handle[]>>
        dateHandles: new Map()
    };

    // Check if the selected folder itself is a clip folder
    const folderNameLower = dirHandle.name.toLowerCase();
    const isClipFolder = ['recentclips', 'sentryclips', 'savedclips'].includes(folderNameLower);

    // Find the main clip folders
    try {
        if (isClipFolder) {
            // User selected a clip folder directly (e.g., SentryClips)
            if (folderNameLower === 'recentclips') {
                folderStructure.recentClips = dirHandle;
                await scanRecentClipsForDates(dirHandle);
            } else if (folderNameLower === 'sentryclips') {
                folderStructure.sentryClips = dirHandle;
                await scanEventFolderForDates(dirHandle, 'sentry');
            } else if (folderNameLower === 'savedclips') {
                folderStructure.savedClips = dirHandle;
                await scanEventFolderForDates(dirHandle, 'saved');
            }
        } else {
            // User selected a parent folder (e.g., TeslaCam, teslausb, or any custom name)
            // Scan for clip subfolders
            let foundClipFolders = false;
            for await (const entry of dirHandle.values()) {
                if (entry.kind !== 'directory') continue;
                const name = entry.name.toLowerCase();
                if (name === 'recentclips') {
                    folderStructure.recentClips = entry;
                    await scanRecentClipsForDates(entry);
                    foundClipFolders = true;
                } else if (name === 'sentryclips') {
                    folderStructure.sentryClips = entry;
                    await scanEventFolderForDates(entry, 'sentry');
                    foundClipFolders = true;
                } else if (name === 'savedclips') {
                    folderStructure.savedClips = entry;
                    await scanEventFolderForDates(entry, 'saved');
                    foundClipFolders = true;
                }
            }
            
            // If no Tesla folder structure found, check for loose video clips directly in the folder
            if (!foundClipFolders) {
                await scanLooseClipsForDates(dirHandle);
            }
        }
    } catch (err) {
        console.error('Error scanning folder structure:', err);
    }

    hideLoading();

    if (!folderStructure.dates.size) {
        notify(t('ui.notifications.noDashcamClipsFound'), { type: 'warn' });
        return;
    }

    // Build date list and update UI
    const sortedDates = Array.from(folderStructure.dates).sort().reverse();
    library.allDates = sortedDates;
    library.folderLabel = dirHandle.name;
    library.clipGroups = [];
    library.clipGroupById = new Map();
    library.dayCollections = new Map();
    library.dayData = new Map();

    // Update UI
    clipBrowserSubtitle.textContent = `${dirHandle.name}: ${sortedDates.length} ${t('ui.clipBrowser.datesAvailable')}`;
    updateDayFilterOptions();
    
    // Hide drop overlay
    dropOverlay.classList.add('hidden');
    
    // Auto-select most recent date
    if (sortedDates.length && dayFilter) {
        dayFilter.value = sortedDates[0];
        updateDayFilterMarker();
        await loadDateContent(sortedDates[0]);
    }
}

// Scan RecentClips folder for dates (supports both date subfolders and flat file structure)
async function scanRecentClipsForDates(handle) {
    try {
        for await (const entry of handle.values()) {
            if (entry.kind === 'directory') {
                // Date subfolders (e.g., 2025-12-15)
                const folderMatch = entry.name.match(/^(\d{4}-\d{2}-\d{2})/);
                if (folderMatch) {
                    const date = folderMatch[1];
                    folderStructure.dates.add(date);
                    if (!folderStructure.dateHandles.has(date)) {
                        folderStructure.dateHandles.set(date, { recent: entry, sentry: new Map(), saved: new Map() });
                    } else {
                        folderStructure.dateHandles.get(date).recent = entry;
                    }
                }
            } else if (entry.kind === 'file') {
                const nameLower = entry.name.toLowerCase();
                if (nameLower.endsWith('.mp4')) {
                    // Flat file structure: YYYY-MM-DD_HH-MM-SS-camera.mp4
                    const match = entry.name.match(/^(\d{4}-\d{2}-\d{2})_/);
                    if (match) {
                        const date = match[1];
                        folderStructure.dates.add(date);
                        if (!folderStructure.dateHandles.has(date)) {
                            folderStructure.dateHandles.set(date, { recent: handle, sentry: new Map(), saved: new Map() });
                        } else {
                            folderStructure.dateHandles.get(date).recent = handle;
                        }
                    }
                }
            }
        }
    } catch (err) {
        console.warn('Error scanning RecentClips:', err);
    }
}

// Scan SentryClips/SavedClips folders for dates (dates are in subfolder names)
async function scanEventFolderForDates(handle, clipType) {
    try {
        for await (const entry of handle.values()) {
            if (entry.kind === 'directory') {
                // Event folder name format: YYYY-MM-DD_HH-MM-SS
                const match = entry.name.match(/^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})$/);
                if (match) {
                    const date = match[1];
                    const eventId = entry.name;
                    folderStructure.dates.add(date);
                    
                    // Store handle reference for this date/event
                    if (!folderStructure.dateHandles.has(date)) {
                        folderStructure.dateHandles.set(date, { recent: null, sentry: new Map(), saved: new Map() });
                    }
                    const dateData = folderStructure.dateHandles.get(date);
                    if (clipType === 'sentry') {
                        dateData.sentry.set(eventId, entry);
                    } else {
                        dateData.saved.set(eventId, entry);
                    }
                }
            }
        }
    } catch (err) {
        console.warn(`Error scanning ${clipType} folder:`, err);
    }
}

// Scan for loose video clips directly in a folder (no Tesla folder structure) - File System Access API
async function scanLooseClipsForDates(dirHandle) {
    try {
        for await (const entry of dirHandle.values()) {
            if (entry.kind !== 'file') continue;
            const nameLower = entry.name.toLowerCase();
            
            // Check for video files
            if (nameLower.endsWith('.mp4') || nameLower.endsWith('.avi') || nameLower.endsWith('.mov') || nameLower.endsWith('.mkv')) {
                // Try to extract date from Tesla-style filename: YYYY-MM-DD_HH-MM-SS-camera.mp4
                let date = null;
                const teslaMatch = entry.name.match(/^(\d{4}-\d{2}-\d{2})_/);
                if (teslaMatch) {
                    date = teslaMatch[1];
                } else {
                    // Try other common date formats in filenames
                    // YYYYMMDD format
                    const compactMatch = entry.name.match(/(\d{4})(\d{2})(\d{2})/);
                    if (compactMatch) {
                        date = `${compactMatch[1]}-${compactMatch[2]}-${compactMatch[3]}`;
                    } else {
                        // Group all undated files under "Unknown"
                        date = 'Unknown';
                    }
                }
                
                folderStructure.dates.add(date);
                if (!folderStructure.dateHandles.has(date)) {
                    folderStructure.dateHandles.set(date, { 
                        recent: null, 
                        sentry: new Map(), 
                        saved: new Map(),
                        loose: dirHandle
                    });
                } else {
                    const dateData = folderStructure.dateHandles.get(date);
                    if (!dateData.loose) {
                        dateData.loose = dirHandle;
                    }
                }
            }
        }
    } catch (err) {
        console.warn('Error scanning loose clips:', err);
    }
}

// Load content for a specific date (called when user selects a date)
async function loadDateContent(date) {
    if (!folderStructure?.dateHandles?.has(date)) {
        renderClipList();
        return;
    }

    const dateData = folderStructure.dateHandles.get(date);
    
    // Check if we're using Electron (objects with path property) or browser File System API (directory handles)
    const isElectron = dateData.recent?.path || 
                       (dateData.sentry.size > 0 && dateData.sentry.values().next().value?.path) ||
                       (dateData.saved.size > 0 && dateData.saved.values().next().value?.path) ||
                       dateData.loose?.isLoose;
    
    if (isElectron) {
        await loadDateContentElectron(date);
        return;
    }

    // Browser File System Access API path
    showLoading('Loading clips...', `Loading ${date}...`);
    await yieldToUI();

    const files = [];

    // Load RecentClips for this date
    if (dateData.recent && typeof dateData.recent.values === 'function') {
        updateLoading('Loading clips...', 'Loading RecentClips...');
        await yieldToUI();
        try {
            for await (const entry of dateData.recent.values()) {
                if (entry.kind === 'file') {
                    const name = entry.name;
                    const nameLower = name.toLowerCase();
                    if (name.startsWith(date) && (nameLower.endsWith('.mp4') || nameLower.endsWith('.json') || nameLower.endsWith('.png'))) {
                        try {
                            const file = await entry.getFile();
                            Object.defineProperty(file, 'webkitRelativePath', {
                                value: `${folderStructure.root.name}/RecentClips/${name}`,
                                writable: false
                            });
                            files.push(file);
                        } catch { /* skip inaccessible files */ }
                    }
                }
            }
        } catch (err) {
            console.warn('Error loading RecentClips:', err);
        }
    }

    // Load SentryClips events for this date
    let eventCount = 0;
    const totalEvents = dateData.sentry.size + dateData.saved.size;
    
    for (const [eventId, eventHandle] of dateData.sentry) {
        eventCount++;
        updateLoading('Loading clips...', `Loading Sentry event ${eventCount}/${totalEvents}...`);
        await yieldToUI();
        await loadEventFolder(eventHandle, 'SentryClips', eventId, files);
    }

    // Load SavedClips events for this date
    for (const [eventId, eventHandle] of dateData.saved) {
        eventCount++;
        updateLoading('Loading clips...', `Loading Saved event ${eventCount}/${totalEvents}...`);
        await yieldToUI();
        await loadEventFolder(eventHandle, 'SavedClips', eventId, files);
    }
    
    // Load loose clips (folder with just video files, no Tesla structure)
    if (dateData.loose && typeof dateData.loose.values === 'function') {
        updateLoading('Loading clips...', 'Loading video clips...');
        await yieldToUI();
        try {
            for await (const entry of dateData.loose.values()) {
                if (entry.kind !== 'file') continue;
                const nameLower = entry.name.toLowerCase();
                
                // Check for video files
                if (nameLower.endsWith('.mp4') || nameLower.endsWith('.avi') || nameLower.endsWith('.mov') || nameLower.endsWith('.mkv')) {
                    // Filter by date if not "Unknown"
                    if (date !== 'Unknown') {
                        const teslaMatch = entry.name.match(/^(\d{4}-\d{2}-\d{2})_/);
                        const compactMatch = entry.name.match(/(\d{4})(\d{2})(\d{2})/);
                        let fileDate = null;
                        if (teslaMatch) {
                            fileDate = teslaMatch[1];
                        } else if (compactMatch) {
                            fileDate = `${compactMatch[1]}-${compactMatch[2]}-${compactMatch[3]}`;
                        }
                        if (fileDate && fileDate !== date) continue;
                    } else {
                        // For "Unknown" date, only include files without recognizable dates
                        const teslaMatch = entry.name.match(/^(\d{4}-\d{2}-\d{2})_/);
                        const compactMatch = entry.name.match(/(\d{4})(\d{2})(\d{2})/);
                        if (teslaMatch || compactMatch) continue;
                    }
                    
                    try {
                        const file = await entry.getFile();
                        Object.defineProperty(file, 'webkitRelativePath', {
                            value: `${folderStructure.root.name}/${entry.name}`,
                            writable: false
                        });
                        file.isLooseClip = true;
                        files.push(file);
                    } catch { /* skip inaccessible files */ }
                }
            }
        } catch (err) {
            console.warn('Error loading loose clips:', err);
        }
    }

    hideLoading();

    if (!files.length) {
        notify(t('ui.notifications.noClipsFoundForDate', { date: date }), { type: 'info' });
        renderClipList();
        return;
    }

    // Build index for just this date's files
    await handleFolderFilesForDate(files, date);
}

// Load files from a single event folder (browser File System Access API)
async function loadEventFolder(eventHandle, clipType, eventId, files) {
    // Skip if this is an Electron path object (handled by loadDateContentElectron)
    if (eventHandle.path && !eventHandle.values) return;
    
    try {
        for await (const entry of eventHandle.values()) {
            if (entry.kind === 'file') {
                const name = entry.name.toLowerCase();
                if (name.endsWith('.mp4') || name.endsWith('.json') || name.endsWith('.png')) {
                    try {
                        const file = await entry.getFile();
                        Object.defineProperty(file, 'webkitRelativePath', {
                            value: `${folderStructure.root.name}/${clipType}/${eventId}/${entry.name}`,
                            writable: false
                        });
                        files.push(file);
                    } catch { /* skip inaccessible files */ }
                }
            }
        }
    } catch (err) {
        console.warn(`Error loading event folder ${eventId}:`, err);
    }
}

// Shared helper: merge built index into library, reset selection, render, auto-select
function mergeIntoLibrary(built, date) {
    library.clipGroups = built.groups;
    library.clipGroupById = new Map(library.clipGroups.map(g => [g.id, g]));
    const dayResult = buildDayCollections(library.clipGroups);
    library.dayCollections = dayResult.collections;
    library.allDates = dayResult.allDates;
    library.dayData = dayResult.dayData;

    selection.selectedGroupId = null;
    state.collection.active = null;
    previews.cache.clear();
    previews.queue.length = 0;
    previews.inFlight = 0;

    clipBrowserSubtitle.textContent = `${library.folderLabel}: ${library.clipGroups.length} ${t('ui.clipBrowser.clipsOn')} ${formatDateDisplay(date)}`;
    renderClipList();

    const dayValues = library.dayCollections ? Array.from(library.dayCollections.values()) : [];
    if (dayValues.length) {
        dayValues.sort((a, b) => (b.sortEpoch ?? 0) - (a.sortEpoch ?? 0));
        const latest = dayValues[0];
        if (latest?.key) {
            selectDayCollection(latest.key);
        }
    }

    ingestSentryEventJson(built.eventAssetsByKey);

    // If SentryUSB drive data is loaded, re-match drives against the new clip set.
    if (state.sentryUsb?.loaded && state.sentryUsb.drives?.length > 0) {
        state.sentryUsb.hasFootage = matchClipsTodrives(
            state.sentryUsb.drives, library.clipGroups, folderStructure?.dates
        );
        updateDrivesTabVisibility();
        renderDriveList();
    }
}

// Process files for a single date
async function handleFolderFilesForDate(files, date) {
    if (!seiType) {
        notify(t('ui.notifications.metadataParserNotReady'), { type: 'warn' });
        return;
    }

    const built = await buildTeslaCamIndex(files, folderStructure?.root?.name);
    mergeIntoLibrary(built, date);
}

// Default click = choose folder (streamlined TeslaCam flow).
dropOverlay.onclick = (e) => {
    if (e?.target?.closest?.('#overlayChooseFolderBtn')) return;
    openFolderPicker();
};
overlayChooseFolderBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openFolderPicker();
    overlayChooseFolderBtn.blur();
};

// Fallback for browsers without showDirectoryPicker
folderInput.onchange = async e => {
    const rawFiles = e.target.files;
    const totalCount = rawFiles?.length ?? 0;
    if (!totalCount) return;
    
    const files = Array.from(rawFiles);
    const root = getRootFolderNameFromWebkitRelativePath(files[0]?.webkitRelativePath);
    e.target.value = '';
    
    if (totalCount > 1000) {
        showLoading('Loading files...', `${totalCount.toLocaleString()} items found`);
        await yieldToUI();
    }
    
    handleFolderFiles(files, root);
};

function setMultiCamGridVisible(visible) {
    if (!multiCamGrid) return;
    multiCamGrid.classList.toggle('hidden', !visible);
    // Hide the single video when multi is active.
    if (videoMain) videoMain.classList.toggle('hidden', visible);
    if (!visible) clearMultiFocus();
}

function resetMultiStreams() {
    for (const s of multi.streams.values()) {
        try { s.decoder?.close?.(); } catch { /* ignore */ }
    }
    multi.streams.clear();
}

function updateDayFilterOptions() {
    if (!dayFilter || !library.allDates) return;
    
    const currentDay = dayFilter.value;
    const dates = library.allDates;
    
    // Rebuild day filter dropdown
    dayFilter.innerHTML = `<option value="">${t('ui.clipBrowser.selectDate')}</option>`;
    for (const d of dates) {
        const opt = document.createElement('option');
        opt.value = d;
        opt.textContent = formatDateDisplay(d);
        dayFilter.appendChild(opt);
    }
    
    // Preserve selection if still valid, otherwise default to most recent
    if (currentDay && dates.includes(currentDay)) {
        dayFilter.value = currentDay;
    } else {
        dayFilter.value = dates[0] || '';
    }
    
    // Add persistent marker to selected date
    updateDayFilterMarker();
}

function updateDayFilterMarker() {
    if (!dayFilter) return;
    const selected = dayFilter.value;
    for (const opt of dayFilter.options) {
        if (!opt.value) continue; // Skip "Select Date" placeholder
        const baseText = opt.textContent.replace(/^▸\s*/, '');
        opt.textContent = (opt.value === selected) ? `▸ ${baseText}` : baseText;
    }
}

async function handleFolderFiles(fileList, directoryName = null) {
    if (!seiType) {
        notify(t('ui.notifications.metadataParserNotReady'), { type: 'warn' });
        return;
    }

    // Show loading overlay immediately for large folders
    const totalRaw = fileList?.length ?? 0;
    const isLargeFolder = totalRaw > 1000;
    if (isLargeFolder) {
        showLoading('Filtering files...', `${totalRaw.toLocaleString()} items to scan`);
        await yieldToUI();
    }

    // Filter files in batches to prevent blocking for huge file lists
    const FILTER_BATCH = 2000;
    const files = [];
    const rawFiles = Array.isArray(fileList) ? fileList : Array.from(fileList);
    
    for (let i = 0; i < rawFiles.length; i++) {
        const f = rawFiles[i];
        const n = f?.name?.toLowerCase?.() || '';
        if (n.endsWith('.mp4') || n.endsWith('.json') || n.endsWith('.png')) {
            files.push(f);
        }
        // Yield periodically during filtering for very large folders
        if (isLargeFolder && i > 0 && i % FILTER_BATCH === 0) {
            updateLoading('Filtering files...', `${i.toLocaleString()} / ${totalRaw.toLocaleString()} scanned`, (i / totalRaw) * 30);
            await yieldToUI();
        }
    }

    if (!files.length) {
        hideLoading();
        notify(t('ui.notifications.noSupportedFilesFound'), { type: 'warn' });
        return;
    }

    // Show loading for index building
    if (isLargeFolder || files.length > 500) {
        showLoading('Indexing clips...', `${files.length.toLocaleString()} media files found`);
        await yieldToUI();
    }

    // Build index with progress callback
    const onProgress = (processed, total, groupCount) => {
        const percent = 30 + (processed / total) * 60; // 30-90% range for indexing
        updateLoading(
            'Indexing clips...',
            `${processed.toLocaleString()} / ${total.toLocaleString()} files · ${groupCount.toLocaleString()} clip groups`,
            percent
        );
    };

    const built = await buildTeslaCamIndex(files, directoryName, isLargeFolder ? onProgress : null);
    
    if (isLargeFolder) {
        updateLoading('Building collections...', `${built.groups.length.toLocaleString()} clip groups`, 92);
        await yieldToUI();
    }

    library.clipGroups = built.groups;
    library.clipGroupById = new Map(library.clipGroups.map(g => [g.id, g]));
    library.folderLabel = built.inferredRoot || directoryName || 'Folder';

    // Build virtual day-level collections (Sentry Studio–style day timelines)
    const dayResult = buildDayCollections(library.clipGroups);
    library.dayCollections = dayResult.collections;
    library.allDates = dayResult.allDates;
    library.dayData = dayResult.dayData;

    // Build day index (YYYY-MM-DD) for Recent/Saved/Sentry clips
    const dayIndex = new Map();
    for (const g of library.clipGroups) {
        const key = String(g.timestampKey || '');
        const day = key.split('_')[0] || 'Unknown';
        if (!dayIndex.has(day)) dayIndex.set(day, []);
        dayIndex.get(day).push(g.id);
    }
    library.dayIndex = dayIndex;

    // Reset selection + previews
    selection.selectedGroupId = null;
    state.collection.active = null;
    previews.cache.clear();
    previews.queue.length = 0;
    previews.inFlight = 0;

    if (isLargeFolder) {
        updateLoading('Rendering...', '', 98);
        await yieldToUI();
    }

    // Update UI
    clipBrowserSubtitle.textContent = `${library.folderLabel}: ${library.allDates?.length || 0} ${t('ui.clipBrowser.datesAvailable')}`;
    
    // Update day filter options and render clip list
    updateDayFilterOptions();
    renderClipList();

    // Re-run clip-to-drive matching with newly loaded clips
    if (state.sentryUsb.loaded && state.sentryUsb.drives.length > 0) {
        state.sentryUsb.hasFootage = matchClipsTodrives(state.sentryUsb.drives, library.clipGroups, folderStructure?.dates);
        // Refresh drive list if currently visible
        if (driveList && driveList.style.display !== 'none') {
            renderDriveList();
        }
    }

    // Autoselect most recent collection if available
    const dayValues = library.dayCollections ? Array.from(library.dayCollections.values()) : [];
    if (dayValues.length) {
        dayValues.sort((a, b) => (b.sortEpoch ?? 0) - (a.sortEpoch ?? 0));
        const latest = dayValues[0];
        if (latest?.key) {
            selectDayCollection(latest.key);
        }
    } else if (library.clipGroups.length) {
        const items = buildDisplayItems();
        const first = items[0];
        if (first?.type === 'collection') selectSentryCollection(first.id);
        else if (first?.type === 'group') selectClipGroup(first.id);
    }

    // Hide overlays once we have a folder loaded
    hideLoading();
    dropOverlay.classList.add('hidden');

    // Parse any Sentry event.json files in the background and attach metadata to groups.
    ingestSentryEventJson(built.eventAssetsByKey);
}

function selectClipGroup(groupId) {
    const g = library.clipGroupById.get(groupId);
    if (!g) return;
    setMode('clip');
    selection.selectedGroupId = groupId;
    highlightSelectedClip();
    progressBar.step = 1;

    // Choose default camera/master: front preferred, else first available
    const defaultCam = g.filesByCamera.has('front') ? 'front' : (g.filesByCamera.keys().next().value || 'front');
    selection.selectedCamera = defaultCam;
    multi.masterCamera = multi.masterCamera || defaultCam;
    if (!g.filesByCamera.has(multi.masterCamera)) multi.masterCamera = defaultCam;
    updateCameraSelect(g);
    cameraSelect.value = multi.enabled ? multi.masterCamera : selection.selectedCamera;
    // Note: Clip group loading is handled by selectDayCollection() in native video mode
}

function selectSentryCollection(collectionId) {
    console.log('%c[SELECT] selectSentryCollection called with:', 'color: orange; font-weight: bold', collectionId);
    const items = buildDisplayItems();
    const it = items.find(x => x.type === 'collection' && x.id === collectionId);
    if (!it) return;

    const c = it.collection;
    setMode('collection');
    // Ensure a clean start. If we came from an actively playing clip, segment loading clears timers,
    // which can leave playing=true but no timer loop. Pause first so autoplay can reliably start.
    pause();
    
    // Reset dashboard and map when switching clips (clears stale SEI data)
    resetDashboardAndMap();
    
    state.collection.active = {
        ...c,
        currentSegmentIdx: -1,
        currentGroupId: null,
        currentLocalFrameIdx: 0,
        loadToken: 0
    };
    highlightSelectedClip();

    // Configure progress bar as millisecond timeline.
    progressBar.min = 0;
    progressBar.max = Math.floor(state.collection.active.durationMs);
    // Keep step=1 so playback can advance smoothly (Safari may snap programmatic values to step).
    // User scrubs are quantized in the oninput handler.
    progressBar.step = 1;
    progressBar.value = Math.floor(state.collection.active.anchorMs ?? 0);
    playBtn.disabled = false;
    progressBar.disabled = false;

    // Load at anchor (event time) if known, else start.
    const startMs = state.collection.active.anchorMs ?? 0;
    showCollectionAtMs(startMs).then(() => {
        if (autoplayToggle?.checked) setTimeout(() => play(), 0);
    }).catch(() => { /* ignore */ });
}

function selectDayCollection(dayKey) {
    try {
        console.log('%c[SELECT] selectDayCollection called with:', 'color: lime; font-weight: bold', dayKey);
        console.log('Available day collections:', library.dayCollections ? Array.from(library.dayCollections.keys()) : 'none');
        
        const coll = library.dayCollections?.get(dayKey);
        if (!coll) {
            console.error('Day collection not found:', dayKey);
            return;
        }
        
        console.log('Day collection:', coll.id, 'groups:', coll.groups?.length, 'duration:', coll.durationMs);

    setMode('collection');
    pause();
    pauseNative();

    // Reset dashboard and map when switching clips (clears stale SEI data)
    resetDashboardAndMap();
    
    // Show event.json location on map for Sentry/Saved clips (if available)
    showEventJsonLocation(coll);

    // Reset native video state for new collection
    nativeVideo.currentSegmentIdx = -1;
    nativeVideo.isTransitioning = false;

    state.collection.active = {
        ...coll,
        currentSegmentIdx: -1,
        currentGroupId: null,
        currentLocalFrameIdx: 0,
        loadToken: 0
    };
    highlightSelectedClip();

    // Enable native video mode for smooth playback
    state.ui.nativeVideoMode = true;

    // Enable multi-cam by default for day collections.
    multi.enabled = true;
    if (multiCamToggle) {
        multiCamToggle.checked = true;
        localStorage.setItem(MULTI_ENABLED_KEY, '1');
    }
    
    // Ensure layout is applied to grid
    const layoutId = multi.layoutId || DEFAULT_MULTI_LAYOUT;
    const layout = MULTI_LAYOUTS[layoutId];
    if (multiCamGrid && layout) {
        multiCamGrid.setAttribute('data-columns', layout.columns || 3);
    }

    // Initialize segment duration tracking with estimates, then probe actual durations
    const numSegs = coll.groups?.length || 0;
    const groups = coll.groups || [];
    
    // Start with 60s estimates for immediate UI responsiveness
    nativeVideo.segmentDurations = new Array(numSegs).fill(60);
    nativeVideo.cumulativeStarts = [];
    let cum = 0;
    for (let i = 0; i <= numSegs; i++) {
        nativeVideo.cumulativeStarts.push(cum);
        if (i < numSegs) cum += 60;
    }
    
    // Configure progress bar as percentage (0-100) for entire day with smooth stepping
    progressBar.min = 0;
    progressBar.max = 100;
    progressBar.step = 0.01; // Smooth sliding
    progressBar.value = 0;

    // Update event timeline marker and camera highlight
    updateEventTimelineMarker();
    updateEventCameraHighlight();

    // Calculate anchorMs from event metadata for Sentry/Saved clips
    let anchorMs = 0;
    let eventMeta = null;
    for (const g of groups) {
        if (g.eventMeta) {
            eventMeta = g.eventMeta;
            break;
        }
    }
    // Also check eventMetaByKey if not found in groups
    if (!eventMeta && coll.tag && coll.eventId) {
        const key = `${coll.tag}/${coll.eventId}`;
        eventMeta = eventMetaByKey.get(key);
    }
    if (eventMeta?.timestamp) {
        const eventEpoch = Date.parse(eventMeta.timestamp);
        const startEpochMs = parseTimestampKeyToEpochMs(groups[0]?.timestampKey) ?? 0;
        if (Number.isFinite(eventEpoch) && startEpochMs > 0) {
            anchorMs = Math.max(0, eventEpoch - startEpochMs);
        }
    }
    
    // Calculate start position: 15 seconds before event time, or 0 if no anchor
    const startOffsetMs = Math.max(0, anchorMs - 15000); // 15 seconds before event
    const startOffsetSec = startOffsetMs / 1000;

    // Probe actual segment durations in the background for accurate seek positioning
    // This runs concurrently with loading the first segment
    console.log('Starting duration probe for', groups.length, 'segments');
    probeSegmentDurations(groups).then(probedDurations => {
        console.log('Duration probe completed:', probedDurations);
        if (!state.collection.active || state.collection.active.id !== coll.id) return; // Stale
        
        // Update durations with actual values
        nativeVideo.segmentDurations = probedDurations;
        nativeVideo.cumulativeStarts = [];
        let cumulative = 0;
        for (let i = 0; i <= probedDurations.length; i++) {
            nativeVideo.cumulativeStarts.push(cumulative);
            if (i < probedDurations.length) cumulative += probedDurations[i];
        }
        
        // Update time display with accurate total duration
        const totalSec = nativeVideo.cumulativeStarts[probedDurations.length] || 60;
        const vid = nativeVideo.master;
        const segIdx = nativeVideo.currentSegmentIdx >= 0 ? nativeVideo.currentSegmentIdx : 0;
        const cumStart = nativeVideo.cumulativeStarts[segIdx] || 0;
        const currentSec = cumStart + (vid?.currentTime || 0);
        updateTimeDisplayNew(Math.floor(currentSec), Math.floor(totalSec));
        
        // Refresh event timeline marker with accurate durations
        updateEventTimelineMarker();
        
        console.log('Timeline updated with actual durations, total:', totalSec.toFixed(1) + 's');
    }).catch(err => {
        console.warn('Duration probing failed, using estimates:', err);
    });

    // Load the correct segment directly (avoids loading segment 0 then seeking, which caused camera desync)
    if (startOffsetSec > 0) {
        // Calculate which segment contains the event time using 60s estimates
        const targetSegIdx = Math.min(Math.floor(startOffsetSec / 60), numSegs - 1);
        const localOffset = startOffsetSec - (targetSegIdx * 60);
        
        console.log('Loading directly at event segment', targetSegIdx, 'localOffset:', localOffset.toFixed(1) + 's');
        
        loadNativeSegment(targetSegIdx).then(() => {
            const totalSec = nativeVideo.cumulativeStarts[numSegs] || 60;
            updateTimeDisplayNew(Math.floor(startOffsetSec), Math.floor(totalSec));
            
            playBtn.disabled = false;
            progressBar.disabled = false;
            
            // Seek within the segment to the correct local offset
            const vid = nativeVideo.master;
            if (vid) {
                const seekTo = Math.min(localOffset, vid.duration || 60);
                vid.currentTime = seekTo;
                syncMultiVideos(seekTo);
                
                // Update progress bar position
                const pct = (startOffsetSec / totalSec) * 100;
                progressBar.value = Math.min(100, pct);
            }
            
            if (autoplayToggle?.checked) {
                setTimeout(() => playNative(), 100);
            }
        }).catch(err => {
            console.error('Failed to load event segment, falling back to segment 0:', err);
            // Fallback: load segment 0
            loadNativeSegment(0).then(() => {
                playBtn.disabled = false;
                progressBar.disabled = false;
            }).catch(e => {
                notify(t('ui.notifications.failedToLoadVideo', { error: e?.message || String(e) }), { type: 'error' });
            });
        });
    } else {
        // No event anchor - load from the beginning
        loadNativeSegment(0).then(() => {
            const totalSec = nativeVideo.cumulativeStarts[numSegs] || 60;
            updateTimeDisplayNew(0, totalSec);
            
            playBtn.disabled = false;
            progressBar.disabled = false;
            
            if (autoplayToggle?.checked) {
                setTimeout(() => playNative(), 100);
            }
        }).catch(err => {
            console.error('Failed to load native segment:', err);
            notify(t('ui.notifications.failedToLoadVideo', { error: err?.message || String(err) }), { type: 'error' });
        });
    }

    // Update export button state after collection loads
    setTimeout(updateExportButtonState, 100);
    } catch (err) {
        console.error('Error in selectDayCollection:', err);
        notify(t('ui.notifications.errorSelectingDay', { error: err?.message || String(err) }), { type: 'error' });
    }
}

function updateCameraSelect(group) {
    const cams = Array.from(group.filesByCamera.keys());
    cameraSelect.innerHTML = '';
    const ordered = ['front', 'back', 'left_repeater', 'right_repeater', 'left_pillar', 'right_pillar', ...cams];
    const seen = new Set();
    for (const cam of ordered) {
        if (seen.has(cam)) continue;
        seen.add(cam);
        if (!group.filesByCamera.has(cam)) continue;
        const opt = document.createElement('option');
        opt.value = cam;
        opt.textContent = cameraLabel(cam);
        cameraSelect.appendChild(opt);
    }
    cameraSelect.disabled = cameraSelect.options.length === 0;
    cameraSelect.value = selection.selectedCamera;
}

async function ingestSentryEventJson(eventAssetsByKey) {
    if (!eventAssetsByKey || eventAssetsByKey.size === 0) return;
    // Read every event.json in parallel — sequential awaits cost one IPC
    // round-trip per event, which adds up fast on folders with many events.
    const reads = [];
    for (const [key, assets] of eventAssetsByKey.entries()) {
        if (!assets?.jsonFile) continue;
        // Handle both browser File objects and Electron path objects
        const readPromise = (assets.jsonFile.isElectronFile && assets.jsonFile.path)
            ? window.electronAPI.readFile(assets.jsonFile.path)
            : assets.jsonFile.text();
        reads.push(readPromise.then(
            text => ({ key, text }),
            err => ({ key, err })
        ));
    }
    let needsRender = false;
    for (const { key, text, err } of await Promise.all(reads)) {
        if (err) {
            console.warn(`Error reading event.json for ${key}:`, err);
            continue;
        }
        try {
            const meta = JSON.parse(text);
            eventMetaByKey.set(key, meta);
            // Attach meta to all groups in the same Sentry event folder
            const [tag, eventId] = key.split('/');
            for (const g of library.clipGroups) {
                if (g.tag === tag && g.eventId === eventId) g.eventMeta = meta;
            }
            needsRender = true;
            // Refresh map if this event is currently active (fixes map not showing on auto-select)
            if (state.collection.active?.groups?.some(g => g.tag === tag && g.eventId === eventId)) {
                showEventJsonLocation(state.collection.active);
                // Also refresh timeline marker and camera highlight
                updateEventTimelineMarker();
                updateEventCameraHighlight();
                
                // Seek to 15 seconds before event time now that we have the metadata
                if (meta?.timestamp) {
                    const eventEpoch = Date.parse(meta.timestamp);
                    const groups = state.collection.active.groups || [];
                    const startEpochMs = parseTimestampKeyToEpochMs(groups[0]?.timestampKey) ?? 0;
                    if (Number.isFinite(eventEpoch) && startEpochMs > 0) {
                        const anchorMs = Math.max(0, eventEpoch - startEpochMs);
                        const startOffsetMs = Math.max(0, anchorMs - 15000);
                        const startOffsetSec = startOffsetMs / 1000;
                        if (startOffsetSec > 0) {
                            seekNativeDayCollectionBySec(startOffsetSec);
                        }
                    }
                }
            }
        } catch (err) {
            console.warn(`Error parsing event.json for ${key}:`, err);
        }
    }
    // Re-render clip list once after all event.json files are processed (not per-file)
    if (needsRender) renderClipList();
}

// Playback Logic
playBtn.onclick = () => {
    const isPlaying = state.ui.nativeVideoMode ? nativeVideo.playing : player.playing;
    isPlaying ? pause() : play();
    playBtn.blur();
};
function previewAtSliderValue() {
    // Native video mode with day collection: seek across entire day
    if (state.ui.nativeVideoMode && state.collection.active) {
        const pct = +progressBar.value || 0;
        const totalSec = nativeVideo.cumulativeStarts[nativeVideo.cumulativeStarts.length - 1] || 1;
        const targetSec = (pct / 100) * totalSec;
        seekNativeDayCollectionBySec(targetSec);
        return;
    }
    
    // Native video single clip: seek using percentage
    if (state.ui.nativeVideoMode && nativeVideo.master) {
        const pct = +progressBar.value || 0;
        seekNative(pct);
        return;
    }
    
    pause();
    if (state.collection.active) {
        // Keep step=1 for playback smoothness, but quantize user scrubs to reduce segment churn.
        const quantum = 100; // ms
        const raw = +progressBar.value || 0;
        const snapped = Math.round(raw / quantum) * quantum;
        progressBar.value = String(snapped);
        // Debounce heavy segment loads while dragging to avoid black frames and decoder churn.
        if (state.ui.collectionScrubPreviewTimer) clearTimeout(state.ui.collectionScrubPreviewTimer);
        state.ui.collectionScrubPreviewTimer = setTimeout(() => {
            state.ui.collectionScrubPreviewTimer = null;
            showCollectionAtMs(snapped);
        }, 120);
    } else {
        showFrame(+progressBar.value);
    }
}

function maybeAutoplayAfterSeek() {
    // Only resume playback if we were playing before the scrub started
    if (!state.ui.wasPlayingBeforeScrub) return;
    // If the user is still dragging or an async seek is in progress, don't restart yet.
    if (state.ui.isScrubbing || nativeVideo.isSeeking) return;
    setTimeout(() => play(), 0);
}

// Preview while dragging/scrubbing
progressBar.addEventListener('input', () => {
    previewAtSliderValue();
});

// Commit when the user releases the slider (click or drag end)
progressBar.addEventListener('change', () => {
    state.ui.isScrubbing = false;
    if (state.ui.collectionScrubPreviewTimer) { clearTimeout(state.ui.collectionScrubPreviewTimer); state.ui.collectionScrubPreviewTimer = null; }
    
    // Native video mode: final seek
    if (state.ui.nativeVideoMode && state.collection.active) {
        const pct = +progressBar.value || 0;
        const totalSec = nativeVideo.cumulativeStarts[nativeVideo.cumulativeStarts.length - 1] || 1;
        seekNativeDayCollectionBySec((pct / 100) * totalSec);
        return;
    }
    if (state.ui.nativeVideoMode && nativeVideo.master) {
        const pct = +progressBar.value || 0;
        seekNative(pct);
        return;
    }
    
    // For collections: do the final seek immediately on release (not debounced).
    if (state.collection.active) {
        pause();
        const quantum = 100;
        const raw = +progressBar.value || 0;
        const snapped = Math.round(raw / quantum) * quantum;
        progressBar.value = String(snapped);
        showCollectionAtMs(snapped).then(() => maybeAutoplayAfterSeek()).catch(() => { /* ignore */ });
        return;
    }
    previewAtSliderValue();
    maybeAutoplayAfterSeek();
});
progressBar.addEventListener('pointerdown', () => {
    state.ui.isScrubbing = true;
    // Remember if we were playing before the scrub started
    state.ui.wasPlayingBeforeScrub = state.ui.nativeVideoMode ? nativeVideo.playing : player.playing;
});
progressBar.addEventListener('pointerup', () => { state.ui.isScrubbing = false; maybeAutoplayAfterSeek(); });
progressBar.addEventListener('pointercancel', () => { state.ui.isScrubbing = false; });

// Keyboard controls
document.addEventListener('keydown', (e) => {
    if (!player.frames && !state.collection.active) return;

    // Ignore keyboard shortcuts when an interactive element is focused
    // (buttons, inputs, selects) to avoid double-triggering
    const activeEl = document.activeElement;
    const isInteractive = activeEl && (
        activeEl.tagName === 'BUTTON' ||
        activeEl.tagName === 'INPUT' ||
        activeEl.tagName === 'SELECT' ||
        activeEl.tagName === 'TEXTAREA' ||
        activeEl.isContentEditable
    );

    if (e.code === 'Escape') {
        if (state.ui.multiFocusSlot) {
            e.preventDefault();
            clearMultiFocus();
        }
    }
});

function play() {
    // Use native video playback in native mode (GPU-accelerated, smooth)
    if (state.ui.nativeVideoMode) {
        playNative();
        return;
    }
    
    if (player.playing) return;
    if (!player.frames || !player.frames.length) {
        // In Sentry collection mode we may not have a segment loaded yet; load it, then start.
        if (state.collection.active) {
            player.playing = true;
            updatePlayButton();
            showCollectionAtMs(+progressBar.value || 0)
                .then(() => { if (player.playing) playNext(); })
                .catch(() => { pause(); });
            return;
        }
        return;
    }
    player.playing = true;
    updatePlayButton();
    
    // Dave Plummer Optimization: Drift-correcting clock
    // Reset the reference clock to "now". 
    // We will schedule future frames based on this baseline + cumulative duration.
    player.nextFrameTime = performance.now();
    playNext();
}

function pause() {
    // Use native video pause in native mode
    if (state.ui.nativeVideoMode) {
        pauseNative();
        return;
    }
    
    player.playing = false;
    updatePlayButton();
    if (player.playTimer) { clearTimeout(player.playTimer); player.playTimer = null; }
    // When pausing, we should flush the pipeline so the last requested frame actually appears
    if (player.decoder && player.decoder.state === 'configured') {
        player.decoder.flush().catch(() => {});
    }
    
    // Stop steering wheel animation when paused
    stopSteeringAnimation();
}

function updatePlayButton() {
    const isPlaying = state.ui.nativeVideoMode ? nativeVideo.playing : player.playing;
    playBtn.innerHTML = isPlaying 
        ? '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
        : '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
}

function playNext() {
    if (!player.playing) return;

    // Sentry Collection Mode Handling
    if (state.collection.active) {
        if (player.playTimer) { clearTimeout(player.playTimer); player.playTimer = null; }
        
        // If loading a segment, spin-wait briefly (could be optimized further but fine for boundary)
        if (state.collection.active.loading) {
            player.playTimer = setTimeout(playNext, 20); 
            player.nextFrameTime = performance.now(); // Reset clock while loading
            return;
        }

        const currentMs = +progressBar.value;
        const idx = Math.min(Math.max(state.collection.active.currentLocalFrameIdx || 0, 0), (player.frames?.length || 1) - 1);
        const frameDur = player.frames?.[idx]?.duration || 33;
        const playbackRate = state.ui.playbackRate || 1;
        
        // Advance time (at playback speed)
        const nextMs = currentMs + (frameDur * playbackRate);
        if (nextMs > +progressBar.max) {
            pause();
            return;
        }

        progressBar.value = Math.floor(nextMs);

        // Schedule next tick (adjusted for playback speed)
        // 1. Calculate ideal time for next frame
        const adjustedFrameDur = frameDur / playbackRate;
        player.nextFrameTime += adjustedFrameDur;
        const now = performance.now();
        let delay = player.nextFrameTime - now;

        // 2. Drift correction: if we are lagging significantly (>100ms), reset the clock to avoid catch-up fast-forwarding
        if (delay < -100) {
            player.nextFrameTime = now;
            delay = 0;
        }

        showCollectionAtMs(nextMs)
            .then(() => {
                if (!player.playing) return;
                // Wait for the calculated delay
                player.playTimer = setTimeout(playNext, Math.max(0, delay));
            })
            .catch(() => pause());
        return;
    }

    // Standard Clip Mode
    let next = +progressBar.value + 1;
    if (!player.frames || next >= player.frames.length) {
        pause();
        return;
    }

    // Optimization: Check decoder backpressure
    // If the decoder queue is backing up, skip scheduling a new frame draw this tick to let it drain.
    // We still advance the clock (drop frame) to maintain sync, OR we just wait.
    // For smooth playback, we want to feed it. If it's full, we wait.
    if (player.decoder && player.decoder.decodeQueueSize > 5) {
        // Backpressure detected. Re-schedule immediately to check again, 
        // effectively busy-waiting (or small sleep) until queue drains.
        // Don't advance 'next' yet.
        player.playTimer = setTimeout(playNext, 5); 
        return;
    }

    progressBar.value = next;
    showFrame(next);

    const frameDur = player.frames[next].duration || 33;
    const playbackRate = state.ui.playbackRate || 1;
    
    // Drift-correcting scheduling (adjusted for playback speed)
    const adjustedFrameDur = frameDur / playbackRate;
    player.nextFrameTime += adjustedFrameDur;
    const now = performance.now();
    let delay = player.nextFrameTime - now;

    // Sync recovery
    if (delay < -100) {
        player.nextFrameTime = now;
        delay = 0;
    }

    player.playTimer = setTimeout(playNext, Math.max(0, delay));
}

function showFrame(index) {
    if (!player.frames?.[index]) return;
    
    // Update visualization and time display
    // Note: In native video mode, telemetry is updated via onMasterTimeUpdate() instead
    updateVisualization(player.frames[index].sei);
    updateTimeDisplay(index);
}

function findFrameIndexAtLocalMs(localMs) {
    if (!player.frames?.length) return 0;
    let lo = 0, hi = player.frames.length - 1;
    while (lo < hi) {
        const mid = Math.floor((lo + hi + 1) / 2);
        if ((player.frames[mid].timestamp || 0) <= localMs) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

async function showCollectionAtMs(ms) {
    if (!state.collection.active) return;
    const token = ++state.collection.active.loadToken;
    const clamped = Math.max(0, Math.min(state.collection.active.durationMs, ms));

    // Find segment index by start offsets
    const starts = state.collection.active.segmentStartsMs;
    let segIdx = 0;
    for (let i = 0; i < starts.length; i++) {
        if (starts[i] <= clamped) segIdx = i;
        else break;
    }

    const segStart = starts[segIdx] || 0;
    const localMs = Math.max(0, clamped - segStart);

    if (segIdx !== state.collection.active.currentSegmentIdx) {
        // Update segment index (legacy WebCodecs loading removed - native video uses loadNativeSegment)
        state.collection.active.currentSegmentIdx = segIdx;
        if (!state.collection.active || state.collection.active.loadToken !== token) return;
    }

    // Render the nearest frame in the current segment.
    const idx = findFrameIndexAtLocalMs(localMs);
    state.collection.active.currentLocalFrameIdx = idx;
    progressBar.value = Math.floor(clamped);
    showFrame(idx);
}

// Visualization Logic - support both camelCase (protobufjs) and snake_case
function updateVisualization(sei) {
    if (!sei) return;

    // This runs at ~60Hz during playback — skip all DOM work when the user
    // has hidden both overlays it feeds.
    const dashOn = !!state?.ui?.dashboardEnabled;
    const mapOn = !!state?.ui?.mapEnabled;
    if (!dashOn && !mapOn) return;

    // Helper to get field value (supports both naming conventions)
    const get = (camel, snake) => sei[camel] ?? sei[snake];

    // Speed (use absolute value to avoid negative display when in reverse)
    const mps = Math.abs(get('vehicleSpeedMps', 'vehicle_speed_mps') || 0);
    const speed = useMetric ? Math.round(mps * MPS_TO_KMH) : Math.round(mps * MPS_TO_MPH);
    
    // Speed
    if (speedValue) speedValue.textContent = speed;
    if (speedUnit) speedUnit.textContent = useMetric ? 'KM/H' : 'MPH';
    if (speedValueCompact) speedValueCompact.textContent = speed;
    if (speedUnitCompact) speedUnitCompact.textContent = useMetric ? 'KM/H' : 'MPH';

    // Gear
    const gear = get('gearState', 'gear_state');
    let gearText = '--';
    if (gear === 0) gearText = 'Park';
    else if (gear === 1) gearText = 'Drive';
    else if (gear === 2) gearText = 'Reverse';
    else if (gear === 3) gearText = 'Neutral';
    
    if (gearState) gearState.textContent = gearText;
    if (gearStateCompact) gearStateCompact.textContent = gearText;

    // Blinkers - Tesla uses 400ms on / 300ms off (700ms cycle)
    const isCurrentlyPlaying = state.ui.nativeVideoMode ? nativeVideo.playing : player.playing;
    const leftBlinkerOn = !!get('blinkerOnLeft', 'blinker_on_left');
    const rightBlinkerOn = !!get('blinkerOnRight', 'blinker_on_right');

    // Reset blink animation phase on activation (off→on) so cycle starts from "on" state
    const prevLeft = updateVisualization._prevLeft || false;
    const prevRight = updateVisualization._prevRight || false;
    if (leftBlinkerOn && !prevLeft) {
        for (const el of [blinkLeft, blinkLeftCompact]) {
            if (!el) continue;
            el.style.animation = 'none';
            void el.offsetHeight;
            el.style.animation = '';
        }
    }
    if (rightBlinkerOn && !prevRight) {
        for (const el of [blinkRight, blinkRightCompact]) {
            if (!el) continue;
            el.style.animation = 'none';
            void el.offsetHeight;
            el.style.animation = '';
        }
    }
    updateVisualization._prevLeft = leftBlinkerOn;
    updateVisualization._prevRight = rightBlinkerOn;

    blinkLeft?.classList.toggle('active', leftBlinkerOn);
    blinkRight?.classList.toggle('active', rightBlinkerOn);
    blinkLeft?.classList.toggle('paused', !isCurrentlyPlaying);
    blinkRight?.classList.toggle('paused', !isCurrentlyPlaying);
    blinkLeftCompact?.classList.toggle('active', leftBlinkerOn);
    blinkRightCompact?.classList.toggle('active', rightBlinkerOn);
    blinkLeftCompact?.classList.toggle('paused', !isCurrentlyPlaying);
    blinkRightCompact?.classList.toggle('paused', !isCurrentlyPlaying);

    // Steering - smooth animation handles both default and compact dashboards
    const targetAngle = get('steeringWheelAngle', 'steering_wheel_angle') || 0;
    smoothSteeringTo(targetAngle);

    // Autopilot
    const apState = get('autopilotState', 'autopilot_state');
    const isActive = apState === 1 || apState === 2;
    
    if (autosteerIcon) autosteerIcon.classList.toggle('active', isActive);
    apText?.classList.toggle('active', isActive);
    gearState?.classList.toggle('active', isActive);
    
    let apTextContent = t('ui.dashboard.manual');
    if (apState === 1) apTextContent = t('ui.dashboard.selfDriving');
    else if (apState === 2) apTextContent = t('ui.dashboard.autosteer');
    else if (apState === 3) apTextContent = t('ui.dashboard.tacc');
    
    if (apText) apText.textContent = apTextContent;
    if (autosteerIconCompact) autosteerIconCompact.classList.toggle('active', isActive);
    if (apTextCompact) {
        apTextCompact.textContent = apTextContent;
        apTextCompact.classList.toggle('active', isActive);
    }
    if (gearStateCompact) gearStateCompact.classList.toggle('active', isActive);

    // Brake
    const brakeActive = !!get('brakeApplied', 'brake_applied');
    brakeIcon?.classList.toggle('active', brakeActive);
    if (brakeIconCompact) brakeIconCompact.classList.toggle('active', brakeActive);

    // Accelerator pedal - lights up when pressed with pressure bar
    const accelPosRaw = get('acceleratorPedalPosition', 'accelerator_pedal_position') || 0;
    // Normalize to 0-100 range (SEI data can be 0-1 or 0-100 depending on version)
    const accelPct = accelPosRaw > 1 ? Math.min(100, accelPosRaw) : Math.min(100, accelPosRaw * 100);
    const isPressed = accelPct > 5;
    const topInset = 100 - accelPct;
    
    if (accelPedal) accelPedal.classList.toggle('active', isPressed);
    if (accelFill) accelFill.style.clipPath = `inset(${topInset}% 0 0 0)`;
    if (accelPedalCompact) accelPedalCompact.classList.toggle('active', isPressed);
    if (accelFillCompact) accelFillCompact.style.clipPath = `inset(${topInset}% 0 0 0)`;

    // Extra Data
    const seqNo = get('frameSeqNo', 'frame_seq_no');
    const lat = get('latitudeDeg', 'latitude_deg') || 0;
    const lon = get('longitudeDeg', 'longitude_deg') || 0;
    const heading = get('headingDeg', 'heading_deg') || 0;
    const accX = get('linearAccelerationMps2X', 'linear_acceleration_mps2_x') || 0;
    const accY = get('linearAccelerationMps2Y', 'linear_acceleration_mps2_y') || 0;
    const accZ = get('linearAccelerationMps2Z', 'linear_acceleration_mps2_z') || 0;
    
    if (valSeq) valSeq.textContent = seqNo ?? '--';
    if (valLat) valLat.textContent = lat.toFixed(6);
    if (valLon) valLon.textContent = lon.toFixed(6);
    if (valHeading) valHeading.textContent = heading.toFixed(1) + '°';
    
    // Acceleration values (valAccX/Y/Z removed - elements don't exist in HTML)
    // G-force meter already displays this information

    // G-Force Meter Update
    updateGForceMeter(sei);

    // Compass Update
    updateCompass(sei);

    // Leaflet work (marker, pan, container transform) is not free even when
    // the map panel is display:none — skip it entirely while hidden.
    if (mapOn) updateMapMarker(sei, hasValidGps);
}

// Toggle Extra Data - prevent all event bubbling to avoid interfering with playback
toggleExtra.addEventListener('mousedown', (e) => e.stopPropagation());
toggleExtra.addEventListener('pointerdown', (e) => e.stopPropagation());
toggleExtra.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    extraDataContainer.classList.toggle('expanded');
    // Refresh data if expanding while paused
    if (extraDataContainer.classList.contains('expanded') && player.frames && progressBar.value) {
         updateVisualization(player.frames[+progressBar.value].sei);
    }
    // Blur so Space key works for play/pause immediately after
    toggleExtra.blur();
};

// Prevent dashboard interactions from bubbling to videoContainer
dashboardVis.addEventListener('mousedown', (e) => {
    // Only stop propagation if not on the drag handle
    if (!e.target.closest('.vis-header')) {
        e.stopPropagation();
    }
});
dashboardVis.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.vis-header')) {
        e.stopPropagation();
    }
});

// Local wrapper for time display
function updateTimeDisplay(frameIndex) {
    if (state.collection.active) {
        const currentSec = Math.floor((+progressBar.value || 0) / 1000);
        const totalSec = Math.floor((state.collection.active.durationMs || 0) / 1000);
        updateTimeDisplayNew(currentSec, totalSec);
        return;
    }
    if (!player.frames || !player.frames[frameIndex]) return;
    const currentSec = Math.floor(player.frames[frameIndex].timestamp / 1000);
    const totalSec = player.frames.length > 0 ? Math.floor(player.frames[player.frames.length - 1].timestamp / 1000) : 0;
    updateTimeDisplayNew(currentSec, totalSec);
}

// Skip Seconds
initSkipSeconds({
    getState: () => state,
    getNativeVideo: () => nativeVideo,
    getProgressBar: () => progressBar,
    getPlayer: () => player,
    seekNativeDayCollectionBySec,
    showCollectionAtMs,
    showFrame
});

// Native Video Playback System
const nativeVideo = {
    master: null,           // Master video element (drives timeline)
    streams: new Map(),     // slot -> { video, file, url }
    playing: false,
    currentSegmentIdx: -1,
    syncInterval: null,
    seiData: [],            // Pre-extracted SEI: [{timestampMs, sei}, ...]
    mapPath: [],            // GPS path for map polyline
    segmentDurations: [],   // Actual duration of each segment in seconds
    cumulativeStarts: [],   // Cumulative start time of each segment in seconds
    isTransitioning: false, // Guard to prevent double-triggering segment transitions
    isSeeking: false,       // Guard to prevent progress bar updates during user-initiated seeks
    _pendingSeekSec: null,  // Queued seek target for "latest wins" pattern
    lastSeiTimeMs: -Infinity, // Track last timestamp where SEI data was found
    dashboardReset: false,  // Track if dashboard has been reset for no-SEI section
    telemetryRafId: null    // requestAnimationFrame ID for ~60Hz telemetry polling
};

/**
 * Probe video durations for all segments upfront to enable accurate seek positioning.
 * Uses temporary video elements to get actual durations without full loading.
 * @param {Array} groups - Array of clip groups with filesByCamera maps
 * @returns {Promise<number[]>} - Array of segment durations in seconds
 */
async function probeSegmentDurations(groups) {
    if (!groups || groups.length === 0) return [];
    
    console.log('Probing durations for', groups.length, 'segments...');
    const durations = [];
    
    // Helper to get video URL from entry (same as in loadNativeSegment)
    const getVideoUrl = (entry) => {
        if (!entry) return null;
        if (entry.file?.isElectronFile && entry.file?.path) {
            const fileUrl = filePathToUrl(entry.file.path);
            return { url: fileUrl, isBlob: false };
        }
        if (entry.file && entry.file instanceof File) {
            const url = URL.createObjectURL(entry.file);
            return { url, isBlob: true };
        }
        return null;
    };
    
    // Probe each segment's duration using a temporary video element
    for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        // Prefer front camera for duration, fall back to any available camera
        const entry = group.filesByCamera.get('front') || 
                      group.filesByCamera.values().next().value;
        const urlData = getVideoUrl(entry);
        
        if (!urlData) {
            console.warn('No video file for segment', i, '- using 60s estimate');
            durations.push(60);
            continue;
        }
        
        try {
            const duration = await new Promise((resolve, reject) => {
                const tempVid = document.createElement('video');
                tempVid.preload = 'metadata';
                tempVid.muted = true;
                
                const cleanup = () => {
                    tempVid.src = '';
                    tempVid.load();
                    if (urlData.isBlob) {
                        URL.revokeObjectURL(urlData.url);
                    }
                };
                
                const timeout = setTimeout(() => {
                    cleanup();
                    reject(new Error('Timeout'));
                }, 5000); // 5s timeout per segment
                
                tempVid.onloadedmetadata = () => {
                    clearTimeout(timeout);
                    const dur = tempVid.duration;
                    cleanup();
                    resolve(Number.isFinite(dur) ? dur : 60);
                };
                
                tempVid.onerror = () => {
                    clearTimeout(timeout);
                    cleanup();
                    reject(new Error('Load error'));
                };
                
                tempVid.src = urlData.url;
            });
            
            durations.push(duration);
        } catch (err) {
            console.warn('Failed to probe segment', i, ':', err.message, '- using 60s estimate');
            durations.push(60);
        }
    }
    
    console.log('Probed durations:', durations.map(d => d.toFixed(1) + 's').join(', '));
    return durations;
}

function initNativeVideoPlayback() {
    console.log('Initializing native video playback');
    console.log('videoMain:', videoMain?.id);
    console.log('videoBySlot:', Object.fromEntries(Object.entries(videoBySlot).map(([k, v]) => [k, v?.id])));
    
    // Set up event listeners on ALL video elements
    // Master events will only fire when that element is actually the master
    const allVideos = [videoMain, ...Object.values(videoBySlot)].filter(Boolean);
    console.log('All videos:', allVideos.length, 'elements');
    
    allVideos.forEach(vid => {
        vid.addEventListener('timeupdate', () => {
            if (vid === nativeVideo.master) onMasterTimeUpdate();
        });
        vid.addEventListener('ended', () => {
            if (vid === nativeVideo.master) onMasterEnded();
        });
        vid.addEventListener('loadedmetadata', () => {
            if (vid === nativeVideo.master) onMasterLoaded();
            // Sync non-master videos to master time
            else if (nativeVideo.master && nativeVideo.master !== vid) {
                vid.currentTime = nativeVideo.master.currentTime;
            }
        });
        vid.addEventListener('play', () => {
            if (vid === nativeVideo.master) {
                nativeVideo.playing = true;
                updatePlayButton();
                startTelemetryLoop();
            }
        });
        vid.addEventListener('pause', () => {
            if (vid === nativeVideo.master) {
                nativeVideo.playing = false;
                updatePlayButton();
                stopTelemetryLoop();
            }
        });
    });
}

// Telemetry Animation Loop — polls SEI data at ~60Hz via requestAnimationFrame
// The HTML5 timeupdate event only fires ~4Hz which skips intermediate speed values
function telemetryAnimationLoop() {
    const vid = nativeVideo.master || videoMain;
    if (!vid || !nativeVideo.playing) {
        nativeVideo.telemetryRafId = null;
        return;
    }
    
    if (!nativeVideo.isTransitioning) {
        const currentVidMs = (vid.currentTime || 0) * 1000;
        
        const sei = findSeiAtTime(nativeVideo.seiData, currentVidMs);
        if (sei) {
            setDashboardParked(false);
            updateVisualization(sei);
            nativeVideo.lastSeiTimeMs = currentVidMs;
            nativeVideo.dashboardReset = false;
        } else {
            // No telemetry near this time (parked) -> show PARKED, hide gauges.
            setDashboardParked(true);
            const lastSei = nativeVideo.lastSeiTimeMs ?? -Infinity;
            const timeSinceLastSei = currentVidMs - lastSei;
            if (timeSinceLastSei > 2000 && !nativeVideo.dashboardReset) {
                resetDashboardElements();
                nativeVideo.dashboardReset = true;
            }
        }
    }
    
    nativeVideo.telemetryRafId = requestAnimationFrame(telemetryAnimationLoop);
}

function startTelemetryLoop() {
    if (!nativeVideo.telemetryRafId) {
        nativeVideo.telemetryRafId = requestAnimationFrame(telemetryAnimationLoop);
    }
}

function stopTelemetryLoop() {
    if (nativeVideo.telemetryRafId) {
        cancelAnimationFrame(nativeVideo.telemetryRafId);
        nativeVideo.telemetryRafId = null;
    }
}

function onMasterTimeUpdate() {
    const vid = nativeVideo.master || videoMain;
    if (!vid) return;
    
    // Skip time updates during segment transitions to prevent time display glitches
    if (nativeVideo.isTransitioning) return;
    
    // Skip progress bar updates while user is scrubbing or seeking to prevent fighting with user input
    const skipProgressUpdate = state.ui.isScrubbing || nativeVideo.isSeeking;
    
    const currentVidSec = vid.currentTime || 0;
    const currentVidMs = currentVidSec * 1000;
    
    // Telemetry is now updated at ~60Hz by telemetryAnimationLoop — only update here as fallback
    // when the rAF loop isn't running (e.g. during scrub/seek while paused)
    if (!nativeVideo.telemetryRafId) {
        const sei = findSeiAtTime(nativeVideo.seiData, currentVidMs);
        if (sei) {
            setDashboardParked(false);
            updateVisualization(sei);
            nativeVideo.lastSeiTimeMs = currentVidMs;
            nativeVideo.dashboardReset = false;
        } else {
            // No telemetry near this time (parked) -> show PARKED, hide gauges.
            setDashboardParked(true);
            const lastSei = nativeVideo.lastSeiTimeMs ?? -Infinity;
            const timeSinceLastSei = currentVidMs - lastSei;
            if (timeSinceLastSei > 2000 && !nativeVideo.dashboardReset) {
                resetDashboardElements();
                nativeVideo.dashboardReset = true;
            }
        }
    }
    
    // For day collections, calculate position using actual segment durations
    if (state.collection.active && state.ui.nativeVideoMode) {
        // Use >= 0 check to properly handle segment 0 (0 is falsy in JS)
        const segIdx = nativeVideo.currentSegmentIdx >= 0 ? nativeVideo.currentSegmentIdx : 0;
        const cumStart = nativeVideo.cumulativeStarts[segIdx] || 0;
        const currentSec = cumStart + currentVidSec;
        const totalSec = nativeVideo.cumulativeStarts[nativeVideo.cumulativeStarts.length - 1] || 1;
        
        updateTimeDisplayNew(Math.floor(currentSec), Math.floor(totalSec));
        updateRecordingTime({ collection: state.collection.active, segIdx, videoCurrentTime: nativeVideo.master?.currentTime || 0 });
        
        // Progress bar as smooth percentage (skip if user is scrubbing)
        if (!skipProgressUpdate) {
            const pct = (currentSec / totalSec) * 100;
            progressBar.value = Math.min(100, pct);
        }
        return;
    }
    
    // Single clip mode
    const totalSec = vid.duration || 0;
    updateTimeDisplayNew(currentVidSec, totalSec);
    if (totalSec > 0 && !skipProgressUpdate) {
        progressBar.value = (currentVidSec / totalSec) * 100;
    }
    
    // Sync other videos to master
    syncMultiVideos(currentVidSec);
}

function onMasterLoaded() {
    const vid = nativeVideo.master || videoMain;
    if (!vid) return;
    
    const actualDuration = vid.duration || 60;
    const segIdx = nativeVideo.currentSegmentIdx || 0;
    
    // Update segment duration with actual value
    if (nativeVideo.segmentDurations && segIdx < nativeVideo.segmentDurations.length) {
        const oldDur = nativeVideo.segmentDurations[segIdx];
        nativeVideo.segmentDurations[segIdx] = actualDuration;
        
        // Recalculate cumulative starts from this segment onward
        if (nativeVideo.cumulativeStarts && oldDur !== actualDuration) {
            let cum = nativeVideo.cumulativeStarts[segIdx];
            for (let i = segIdx; i < nativeVideo.segmentDurations.length; i++) {
                nativeVideo.cumulativeStarts[i] = cum;
                cum += nativeVideo.segmentDurations[i];
            }
            nativeVideo.cumulativeStarts[nativeVideo.segmentDurations.length] = cum;
        }
    }
    
    progressBar.disabled = false;
    playBtn.disabled = false;
}

function onMasterEnded() {
    console.log('onMasterEnded called, isTransitioning:', nativeVideo.isTransitioning, 'segIdx:', nativeVideo.currentSegmentIdx);
    
    // Guard against double-triggering during segment transitions
    if (nativeVideo.isTransitioning) {
        console.log('onMasterEnded: Already transitioning, ignoring');
        return;
    }
    
    // If in day collection, advance to next segment automatically
    if (state.collection.active && state.ui.nativeVideoMode) {
        // Use >= 0 check instead of || 0 to properly handle segment index 0
        const currentIdx = nativeVideo.currentSegmentIdx >= 0 ? nativeVideo.currentSegmentIdx : 0;
        const nextSegIdx = currentIdx + 1;
        
        console.log('Advancing from segment', currentIdx, 'to', nextSegIdx, 'of', state.collection.active.groups.length);
        
        if (nextSegIdx < state.collection.active.groups.length) {
            // Set transition guard to prevent re-triggering
            nativeVideo.isTransitioning = true;
            
            // NOTE: If the video ended naturally, it was playing - so we should continue playing
            // The pause event fires before ended, so nativeVideo.playing is already false here
            // We ALWAYS want to continue playing when auto-advancing on ended
            
            loadNativeSegment(nextSegIdx).then(() => {
                nativeVideo.isTransitioning = false;
                // Always continue playing when auto-advancing (video only ends if it was playing)
                console.log('Segment loaded, starting playback');
                playNative();
            }).catch(err => {
                nativeVideo.isTransitioning = false;
                console.error('Failed to load segment', nextSegIdx, '- skipping to next:', err);
                // Skip to the next segment instead of stopping playback entirely
                const skipIdx = nextSegIdx + 1;
                if (skipIdx < state.collection.active.groups.length) {
                    nativeVideo.currentSegmentIdx = nextSegIdx;
                    onMasterEnded();
                } else {
                    console.log('No more segments to try');
                    nativeVideo.playing = false;
                    updatePlayButton();
                }
            });
            return;
        } else {
            console.log('Reached end of all segments');
        }
    }
    // End of day or single clip - pause
    nativeVideo.playing = false;
    updatePlayButton();
}

// Load a segment using native video elements (fast, GPU-accelerated)
async function loadNativeSegment(segIdx) {
    if (!state.collection.active) return;
    
    const group = state.collection.active.groups?.[segIdx];
    if (!group) {
        console.error('No group found for segment', segIdx);
        return;
    }
    
    console.log('Loading native segment', segIdx, 'group:', group.id, 'cameras:', Array.from(group.filesByCamera.keys()));
    
    // Pause all videos before changing sources to prevent race conditions
    if (nativeVideo.master) {
        nativeVideo.master.pause();
    }
    Object.values(videoBySlot).forEach(vid => {
        if (vid && vid.src) vid.pause();
    });
    
    nativeVideo.currentSegmentIdx = segIdx;
    state.collection.active.currentSegmentIdx = segIdx;
    
    // Clear stale SEI data immediately to prevent old segment data from showing during transition
    stopTelemetryLoop();
    nativeVideo.seiData = [];
    nativeVideo.mapPath = [];
    nativeVideo.lastSeiTimeMs = -Infinity;
    nativeVideo.dashboardReset = false;
    
    // Clean up old URLs
    videoUrls.forEach((url, vid) => {
        if (url.startsWith('blob:')) {
            URL.revokeObjectURL(url);
        }
    });
    videoUrls.clear();
    
    // Helper to get video URL from entry (handles both File objects and Electron paths)
    const getVideoUrl = (entry) => {
        if (!entry) return null;
        
        // If it's an Electron file with path, use file:// protocol
        if (entry.file?.isElectronFile && entry.file?.path) {
            const fileUrl = filePathToUrl(entry.file.path);
            return { url: fileUrl, isBlob: false };
        }
        
        // Regular File object - create blob URL
        if (entry.file && entry.file instanceof File) {
            const url = URL.createObjectURL(entry.file);
            return { url, isBlob: true };
        }
        
        return null;
    };
    
    if (multi.enabled) {
        // Load all cameras (use custom order if set)
        const slotsArr = getEffectiveSlots();
        
        console.log('Multi-cam layout:', multi.layoutId, 'slots:', slotsArr, 'custom:', !!getCustomCameraOrder());
        
        for (const slotDef of slotsArr) {
            const { slot, camera } = slotDef;
            const vid = videoBySlot[slot];
            if (!vid) {
                console.warn('No video element for slot:', slot);
                continue;
            }
            
            const entry = group.filesByCamera.get(camera);
            const urlData = getVideoUrl(entry);
            if (urlData) {
                videoUrls.set(vid, urlData.url);
                vid.src = urlData.url;
                vid.load();
                console.log('Loaded', camera, 'into slot', slot, urlData.isBlob ? '(blob)' : '(file://)');
            } else {
                vid.src = '';
                console.log('No file for camera', camera, 'in slot', slot);
            }
        }
        
        // Set master to front camera — fall back to first camera that has a file
        const masterCam = multi.masterCamera || 'front';
        let masterSlotDef = slotsArr.find(s => s.camera === masterCam);
        
        // If the preferred master camera has no file for this segment, pick the first slot that does
        if (!group.filesByCamera.has(masterSlotDef?.camera)) {
            const fallback = slotsArr.find(s => group.filesByCamera.has(s.camera));
            if (fallback) {
                console.warn('Master camera', masterCam, 'missing for segment, falling back to', fallback.camera);
                masterSlotDef = fallback;
            }
        }
        
        const masterSlot = masterSlotDef?.slot;
        nativeVideo.master = masterSlot ? videoBySlot[masterSlot] : videoMain;
        
        console.log('Master camera:', masterCam, 'slot:', masterSlot, 'video:', nativeVideo.master?.id);
        
        setMultiCamGridVisible(true);
        
        // Update tile labels to reflect custom camera order
        updateTileLabels();
        updateCompactDashboardPosition();
        
        // Apply mirror transforms to repeater cameras
        applyMirrorTransforms();
    } else {
        // Single camera
        const cam = selection.selectedCamera || 'front';
        const entry = group.filesByCamera.get(cam) || group.filesByCamera.values().next().value;
        
        const urlData = getVideoUrl(entry);
        if (urlData) {
            videoUrls.set(videoMain, urlData.url);
            videoMain.src = urlData.url;
            videoMain.load();
            console.log('Loaded single camera', cam, urlData.isBlob ? '(blob)' : '(file://)');
        } else {
            console.error('No file found for camera', cam);
        }
        
        nativeVideo.master = videoMain;
        setMultiCamGridVisible(false);
    }
    
    // Show dashboard and map panels
    dashboardVis.classList.add('visible');
    mapVis.classList.add('visible');
    
    // Pre-extract SEI telemetry from master camera file (runs in background)
    const masterCam = multi.masterCamera || 'front';
    const masterEntry = group.filesByCamera.get(masterCam) || group.filesByCamera.values().next().value;
    if (masterEntry && seiType) {
        extractSeiFromEntry(masterEntry, seiType).then(({ seiData, mapPath }) => {
            nativeVideo.seiData = seiData;
            // If the active collection has a full drive route, use it for the map
            // polyline instead of the per-clip SEI path so the entire route is visible.
            const driveMapPath = state.collection.active?.driveMapPath;
            const effectiveMapPath = (driveMapPath?.length > 0) ? driveMapPath : mapPath;
            nativeVideo.mapPath = effectiveMapPath;
            if (effectiveMapPath?.length) {
                window._lastMapPath = effectiveMapPath; // cache for re-center
            }
            // Draw route on map with autopilot-aware coloring
            if (map && effectiveMapPath.length > 0) {
                const mapPath = effectiveMapPath; // shadow for the block below
                // Remove existing polylines
                if (mapPolyline) {
                    if (Array.isArray(mapPolyline)) {
                        mapPolyline.forEach(p => p.remove());
                    } else {
                        mapPolyline.remove();
                    }
                }
                
                // Colors match SentryUSB Web UI: green=FSD engaged, blue=manual
                const AUTOPILOT_COLOR = '#22c55e';
                const MANUAL_COLOR    = '#3b82f6';

                // Build segments with consistent autopilot state
                const segments = [];
                let currentSegment = [];
                let currentAutopilot = mapPath[0].autopilot;

                for (const point of mapPath) {
                    if (point.autopilot !== currentAutopilot && currentSegment.length > 0) {
                        segments.push({ coords: currentSegment, autopilot: currentAutopilot });
                        currentSegment = [currentSegment[currentSegment.length - 1]]; // overlap for continuity
                        currentAutopilot = point.autopilot;
                    }
                    currentSegment.push([point.lat, point.lon]);
                }
                if (currentSegment.length > 0) {
                    segments.push({ coords: currentSegment, autopilot: currentAutopilot });
                }

                // Create polylines for each segment
                const polylines = segments.map(seg => {
                    const color = seg.autopilot ? AUTOPILOT_COLOR : MANUAL_COLOR;
                    return L.polyline(seg.coords, { color, weight: 4, opacity: 1, smoothFactor: 0, noClip: true }).addTo(map);
                });

                mapPolyline = polylines;

                // Draw FSD event markers if enabled (must come before start/end markers
                // since refreshFsdEventMarkers clears fsdEventMarkers first)
                refreshFsdEventMarkers();

                // Start (green) and end (red) dot markers — match SentryUSB Web UI
                const startCoord = [mapPath[0].lat, mapPath[0].lon];
                const endCoord   = [mapPath[mapPath.length - 1].lat, mapPath[mapPath.length - 1].lon];
                const dotIcon = (bg) => L.divIcon({
                    className: '',
                    html: `<div style="width:10px;height:10px;border-radius:50%;background:${bg};border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,0.5)"></div>`,
                    iconSize: [10, 10],
                    iconAnchor: [5, 5],
                });
                const startMarker = L.marker(startCoord, { icon: dotIcon('#22c55e') }).addTo(map);
                const endMarker   = L.marker(endCoord,   { icon: dotIcon('#ef4444') }).addTo(map);
                // Push into fsdEventMarkers so they're cleaned up on next drive selection
                fsdEventMarkers.push(startMarker, endMarker);

                // Re-run event-location snap now that mapPath is populated — the
                // first call (from ingestSentryEventJson) may have happened before
                // SEI extraction finished, leaving the pin at Tesla's raw est_lat/lon.
                if (state.collection.active?.groups?.some(g => g.eventMeta)) {
                    showEventJsonLocation(state.collection.active, { recenter: false });
                }

                // Fit bounds to all points
                const allCoords = mapPath.map(p => [p.lat, p.lon]);
                const bounds = L.latLngBounds(allCoords);
                window._lastMapBounds = bounds; // cache for recenter
                map.invalidateSize();
                map.fitBounds(bounds, { padding: [20, 20] });
                // For long drive routes fitBounds can zoom far out; enforce a minimum zoom of 14.
                if (map.getZoom() < 14) {
                    const mid = mapPath[Math.floor(mapPath.length / 2)];
                    map.setView([mid.lat, mid.lon], 15, { animate: false });
                }

                // Re-invalidate after layout settles so tiles render correctly
                setTimeout(() => {
                    if (map) map.invalidateSize();
                }, 1000);
            }
        }).catch(err => console.warn('SEI extraction failed:', err));
    }
    
    // Wait for master to be ready
    if (!nativeVideo.master) {
        console.error('No master video element');
        return;
    }
    
    console.log('Waiting for master video to load, current readyState:', nativeVideo.master.readyState, 'src:', nativeVideo.master.src?.substring(0, 60));
    
    // Wait for video to be ready
    await new Promise((resolve, reject) => {
        const vid = nativeVideo.master;
        let resolved = false;
        
        const cleanup = () => {
            vid.removeEventListener('canplay', onLoaded);
            vid.removeEventListener('error', onError);
        };
        
        const onLoaded = () => {
            if (resolved) return;
            resolved = true;
            cleanup();
            clearTimeout(timeout);
            console.log('Master video ready, readyState:', vid.readyState, 'duration:', vid.duration?.toFixed(2));
            resolve();
        };
        
        const onError = (e) => {
            if (resolved) return;
            resolved = true;
            cleanup();
            clearTimeout(timeout);
            console.error('Video load error:', e);
            reject(e);
        };
        
        const timeout = setTimeout(() => {
            if (resolved) return;
            resolved = true;
            cleanup();
            // Don't reject - just continue and hope for the best
            console.warn('Timeout waiting for video to load, continuing anyway. readyState:', vid.readyState);
            resolve();
        }, 5000);
        
        // Wait for canplay (ensures at least one frame is decoded and ready to render)
        // Do NOT use loadedmetadata alone - it fires before frame decode on some codecs
        // Do NOT use a requestAnimationFrame readyState shortcut - readyState may be stale
        // from a previously loaded source before load() has fully reset the element
        vid.addEventListener('canplay', onLoaded, { once: true });
        vid.addEventListener('error', onError, { once: true });
    });
    
    // Wait for ALL non-master multi-cam videos to also reach canplay
    // This prevents desync where master is ready but other cameras are still loading
    if (multi.enabled) {
        const otherVids = Object.entries(videoBySlot)
            .filter(([, vid]) => vid && vid.src && vid !== nativeVideo.master)
            .map(([slot, vid]) => ({ slot, vid }));
        
        if (otherVids.length > 0) {
            console.log('Waiting for', otherVids.length, 'non-master cameras to load...');
            await Promise.all(otherVids.map(({ slot, vid }) => 
                new Promise(resolve => {
                    if (vid.readyState >= 3) {
                        resolve();
                        return;
                    }
                    const timer = setTimeout(() => {
                        vid.removeEventListener('canplay', onReady);
                        console.warn('Timeout waiting for', slot, 'readyState:', vid.readyState);
                        resolve();
                    }, 3000);
                    const onReady = () => {
                        clearTimeout(timer);
                        resolve();
                    };
                    vid.addEventListener('canplay', onReady, { once: true });
                })
            ));
            console.log('All cameras ready');
        }
    }
    
    // Reset ALL videos to start (ensure clean state after loading new segment)
    if (nativeVideo.master) {
        nativeVideo.master.currentTime = 0;
    }
    // Sync non-master videos to time 0 so all cameras start at the same position
    syncMultiVideos(0);
    
    // Re-apply playback rate after loading new segment
    applyPlaybackRate(state.ui.playbackRate);
    
    console.log('Segment', segIdx, 'loaded and ready to play');
    
    // Note: Playback is NOT auto-started here. Callers are responsible for calling playNative() if needed.
}

function playNative() {
    console.log('playNative called, master:', nativeVideo.master?.id, 
        'segIdx:', nativeVideo.currentSegmentIdx,
        'readyState:', nativeVideo.master?.readyState,
        'duration:', nativeVideo.master?.duration?.toFixed(2),
        'currentTime:', nativeVideo.master?.currentTime?.toFixed(2));
    
    if (!nativeVideo.master || !nativeVideo.master.src) {
        console.error('playNative: No master video or src');
        return;
    }
    
    nativeVideo.playing = true;
    player.playing = true;
    updatePlayButton();
    
    // Play master
    nativeVideo.master.play().then(() => {
        console.log('Master video now playing');
    }).catch(err => {
        console.error('Failed to play master video:', err);
    });
    
    // Play all multi-cam videos
    if (multi.enabled) {
        Object.entries(videoBySlot).forEach(([slot, vid]) => {
            if (vid && vid.src && vid !== nativeVideo.master) {
                vid.play().catch(err => {
                    console.warn('Failed to play', slot, ':', err.message);
                });
            }
        });
    }
}

function pauseNative() {
    nativeVideo.playing = false;
    player.playing = false;
    updatePlayButton();
    
    // Pause all videos
    if (nativeVideo.master) {
        nativeVideo.master.pause();
    }
    Object.values(videoBySlot).forEach(vid => {
        if (vid && vid.src) {
            vid.pause();
        }
    });
    
    // Stop steering wheel animation when paused
    stopSteeringAnimation();
}


// Apply playback rate to all video elements
function applyPlaybackRate(rate) {
    const playbackRate = parseFloat(rate) || 1;
    state.ui.playbackRate = playbackRate;
    
    // Apply to master video
    if (nativeVideo.master) {
        nativeVideo.master.playbackRate = playbackRate;
    }
    
    // Apply to all multi-cam videos
    Object.values(videoBySlot).forEach(vid => {
        if (vid) {
            vid.playbackRate = playbackRate;
        }
    });
    
    // Also apply to videoMain in case it's being used
    if (videoMain) {
        videoMain.playbackRate = playbackRate;
    }
    
    // Update CSS variable for map marker transitions (faster at higher speeds)
    const transitionDuration = Math.max(0.03, 0.15 / playbackRate);
    document.documentElement.style.setProperty('--map-transition-duration', `${transitionDuration}s`);
    
    console.log('Playback rate set to:', playbackRate);
}

function seekNative(pct) {
    const vid = nativeVideo.master || videoMain;
    if (!vid || !vid.duration) return;
    
    const targetTime = (pct / 100) * vid.duration;
    vid.currentTime = targetTime;
    
    // Sync others
    syncMultiVideos(targetTime);
}

// Seek to a position (in seconds) within the entire day collection using actual durations
async function seekNativeDayCollectionBySec(targetSec) {
    if (!state.collection.active) return;
    
    const cumStarts = nativeVideo.cumulativeStarts;
    if (!cumStarts.length) return;
    
    // "Latest wins" pattern: if a seek is in progress, queue this one and return.
    // When the current seek finishes it will pick up the queued target.
    if (nativeVideo.isSeeking) {
        nativeVideo._pendingSeekSec = targetSec;
        return;
    }
    
    nativeVideo.isSeeking = true;
    
    try {
        const totalSec = cumStarts[cumStarts.length - 1];
        const clampedSec = Math.max(0, Math.min(totalSec, targetSec));
        
        // Find which segment contains this time using cumulative starts
        let segIdx = 0;
        for (let i = 0; i < cumStarts.length - 1; i++) {
            if (clampedSec >= cumStarts[i] && clampedSec < cumStarts[i + 1]) {
                segIdx = i;
                break;
            }
            if (i === cumStarts.length - 2) segIdx = i; // Last segment
        }
        
        const localSec = clampedSec - (cumStarts[segIdx] || 0);
        
        // Load segment if different
        const wasPlaying = nativeVideo.playing;
        if (segIdx !== nativeVideo.currentSegmentIdx) {
            await loadNativeSegment(segIdx);
        }
        
        // Seek within segment
        const vid = nativeVideo.master;
        if (vid) {
            vid.currentTime = Math.min(localSec, vid.duration || 60);
            syncMultiVideos(vid.currentTime);
            
            // Update progress bar and time display immediately
            const pct = (clampedSec / totalSec) * 100;
            progressBar.value = Math.min(100, pct);
            updateTimeDisplayNew(Math.floor(clampedSec), Math.floor(totalSec));
            
            // Resume playback if it was playing before seek
            if (wasPlaying) {
                playNative();
            }
        }
    } catch (err) {
        console.error('Seek failed:', err);
    } finally {
        // Always clear seeking flag, then drain any queued seek
        setTimeout(() => {
            nativeVideo.isSeeking = false;
            const pending = nativeVideo._pendingSeekSec;
            if (pending != null) {
                nativeVideo._pendingSeekSec = null;
                seekNativeDayCollectionBySec(pending);
            }
        }, 100);
    }
}

// Event Timeline Markers
initEventMarkers({
    getState: () => state,
    getNativeVideo: () => nativeVideo,
    getEventMetaByKey: () => eventMetaByKey,
    parseTimestampKeyToEpochMs,
    seekNativeDayCollectionBySec
});

// Export Functions
// Initialize export module with dependencies
initExportModule({
    getState: () => state,
    getNativeVideo: () => nativeVideo,
    getBaseFolderPath: () => baseFolderPath,
    getProgressBar: () => progressBar,
    getUseMetric: () => useMetric
});

initAdvancedEditor({
    getState: () => state,
    getNativeVideo: () => nativeVideo,
    getBaseFolderPath: () => baseFolderPath,
    getVideoBySlot: () => videoBySlot,
    getExportState: () => exportState,
    getUseMetric: () => useMetric,
    findSeiAtTime
});

// Call updateExportButtonState initially
setTimeout(updateExportButtonState, 500);

// Welcome Screen System (must run before auto-update)
console.log('[SCRIPT] Initializing welcome screen...');
initWelcomeScreen();

// Auto-Update System (disabled in Mac App Store builds)
if (!window.electronAPI?.isMas) {
    initAutoUpdate();
}

// Camera Rearrangement
initCameraRearrange({
    getMultiCamGrid: () => multiCamGrid,
    getState: () => state,
    getMulti: () => multi,
    loadNativeSegment,
    getNativeVideo: () => nativeVideo,
    syncMultiVideos,
    playNative,
    updateEventCameraHighlight
});
