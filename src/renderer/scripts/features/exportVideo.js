/**
 * Export Video Functions
 * Handles video export with FFmpeg, markers, and progress tracking
 */

import { notify } from '../ui/notifications.js';
import { formatTimeHMS } from '../ui/timeDisplay.js';
import { initBlurZoneEditor, getNormalizedCoordinates, resetBlurZoneEditor, generateMaskImage, getCanvasDimensions } from '../ui/blurZoneEditor.js';
import { filePathToUrl } from '../lib/utils.js';
import { parseTimestampKeyToEpochMs } from '../core/clipBrowser.js';
import { t, getCurrentLanguage, onLanguageChange } from '../lib/i18n.js';

// Export state
export const exportState = {
    startMarkerPct: null,
    endMarkerPct: null,
    isExporting: false,
    currentExportId: null,
    ffmpegAvailable: false,
    gpuAvailable: false,
    gpuName: null,
    hevcAvailable: false,
    hevcName: null,
    cancelled: false,
    modalMinimized: false,
    currentStep: '',
    currentProgress: 0,
    blurZones: [], // Array of { coordinates: [{x, y}, ...], camera: string, maskImageBase64, maskWidth, maskHeight }
    blurZoneCamera: null, // Camera being edited
    blurZoneEditIndex: null, // Index of zone being edited (null = new zone)
    blurType: 'trueBlur',
    lastExportQuality: null // Track quality used for last export (to enforce share restrictions)
};

// Cached share config (expiration hours from server)
let _shareExpirationHours = 72; // default fallback

async function fetchShareConfig() {
    try {
        const config = await window.electronAPI?.getShareConfig?.();
        if (config?.expirationHours) {
            _shareExpirationHours = config.expirationHours;
        }
    } catch { /* use default */ }
    updateShareExpirationDisplay();
}

function getSelectedExpirationHours() {
    const select = $('shareClipDuration');
    return select ? parseFloat(select.value) : _shareExpirationHours;
}

function formatTimeLeft(ms) {
    if (ms <= 0) return 'Expired';
    const totalMin = Math.max(1, Math.ceil(ms / (1000 * 60)));
    if (totalMin < 60) return `${totalMin}m left`;
    const hours = Math.ceil(ms / (1000 * 60 * 60));
    if (hours < 24) return `${hours}h left`;
    const days = Math.round(hours / 24);
    return `${days}d left`;
}

function formatDuration(hours) {
    if (hours < 1) return `${Math.round(hours * 60)} minutes`;
    if (hours === 1) return '1 hour';
    if (hours < 24) return `${hours} hours`;
    if (hours === 24) return '1 day';
    if (hours === 168) return '7 days';
    return `${hours} hours`;
}

function updateShareExpirationDisplay() {
    const hours = getSelectedExpirationHours();
    const infoText = $('shareClipInfoText');
    if (infoText) {
        infoText.innerHTML = t('ui.export.shareClipInfo', { hours: formatDuration(hours) });
    }
    const expiryText = $('shareLinkExpiryText');
    if (expiryText) {
        expiryText.textContent = t('ui.export.shareLinkExpiry', { hours: formatDuration(hours) });
    }
}

// Track if modal listeners have been initialized
let blurZoneModalInitialized = false;

// DOM helper
const $ = id => document.getElementById(id);

// Dependencies set via init
let getState = null;
let getNativeVideo = null;
let getBaseFolderPath = null;
let getProgressBar = null;
let getFindSeiAtTime = null;
let getUseMetric = null;

/**
 * Initialize export module with dependencies
 * @param {Object} deps - Dependencies
 */
export function initExportModule(deps) {
    getState = deps.getState;
    getNativeVideo = deps.getNativeVideo;
    getBaseFolderPath = deps.getBaseFolderPath;
    getProgressBar = deps.getProgressBar;
    getFindSeiAtTime = deps.getFindSeiAtTime;
    getUseMetric = deps.getUseMetric;
}

// Export overlay settings keys
const EXPORT_OVERLAY_SETTINGS = {
    includeTimestamp: 'exportIncludeTimestamp',
    includeDashboard: 'exportIncludeDashboard',
    dashboardStyle: 'exportDashboardStyle',
    dashboardPosition: 'exportDashboardPosition',
    dashboardPositionTeslaMobile: 'exportDashboardPositionTeslaMobile',
    dashboardSize: 'exportDashboardSize',
    includeMinimap: 'exportIncludeMinimap',
    minimapPosition: 'exportMinimapPosition',
    minimapSize: 'exportMinimapSize',
    minimapRenderMode: 'exportMinimapRenderMode',
    enableTimelapse: 'exportEnableTimelapse',
    timelapseSpeed: 'exportTimelapseSpeed',
};

// Default values for export overlay settings
const EXPORT_OVERLAY_DEFAULTS = {
    includeTimestamp: true,
    includeDashboard: false,
    dashboardStyle: 'compact',
    dashboardPosition: 'bottom-center',
    dashboardPositionTeslaMobile: 'bottom-center',
    dashboardSize: 'medium',
    includeMinimap: false,
    minimapPosition: 'top-right',
    minimapSize: 'small',
    minimapRenderMode: 'ass',
    enableTimelapse: false,
    timelapseSpeed: '8'
};

/**
 * Load saved export overlay settings from settings.json
 */
async function loadExportOverlaySettings() {
    if (!window.electronAPI?.getSetting) return;

    // Setup save handlers first (only once)
    setupExportOverlaySaveHandlers();

    // Load each setting and apply to the corresponding element
    for (const [elementId, settingKey] of Object.entries(EXPORT_OVERLAY_SETTINGS)) {
        const element = $(elementId);
        if (!element) continue;

        try {
            const savedValue = await window.electronAPI.getSetting(settingKey);
            const defaultValue = EXPORT_OVERLAY_DEFAULTS[elementId];
            const value = savedValue !== undefined ? savedValue : defaultValue;

            if (element.type === 'checkbox') {
                element.checked = value === true;
            } else if (element.tagName === 'SELECT') {
                // Dashboard "default" style is hidden behind a feature gate
                // (no real ASS renderer yet — exports would look like Compact).
                // Fall back to Compact so users who saved Default in an earlier
                // build don't see a blank dropdown.
                if (elementId === 'dashboardStyle' && value === 'default') {
                    element.value = 'compact';
                    try { await window.electronAPI.setSetting(settingKey, 'compact'); } catch {}
                } else {
                    element.value = value;
                }
            }
        } catch (err) {
            console.warn(`Failed to load export setting ${settingKey}:`, err);
        }
    }

    // Update options visibility based on loaded checkbox states
    const dashboardCheckbox = $('includeDashboard');
    const dashboardOptions = $('dashboardOptions');
    if (dashboardCheckbox && dashboardOptions) {
        dashboardOptions.classList.toggle('hidden', !dashboardCheckbox.checked);
        // If dashboard is already enabled, disable timestamp option
        if (dashboardCheckbox.checked) {
            const timestampCheckbox = $('includeTimestamp');
            const timestampToggleRow = timestampCheckbox?.closest('.toggle-row');
            const timestampOptions = $('timestampOptions');
            if (timestampCheckbox) {
                timestampCheckbox.checked = false;
                timestampCheckbox.disabled = true;
                if (timestampToggleRow) timestampToggleRow.classList.add('disabled');
                if (timestampOptions) timestampOptions.classList.add('hidden');
            }
        }
    }

    // Update position/size rows based on loaded dashboard style (e.g. Tesla Mobile = top/bottom only)
    const loadedStyle = $('dashboardStyle')?.value;
    if (loadedStyle) {
        updateDashboardStyleOptions(loadedStyle);
    }

    const minimapCheckbox = $('includeMinimap');
    const minimapOptions = $('minimapOptions');
    if (minimapCheckbox && minimapOptions) {
        minimapOptions.classList.toggle('hidden', !minimapCheckbox.checked);
    }

    // Timelapse options visibility
    const timelapseCheckbox = $('enableTimelapse');
    const timelapseOptions = $('timelapseOptions');
    if (timelapseCheckbox && timelapseOptions) {
        timelapseOptions.classList.toggle('hidden', !timelapseCheckbox.checked);
        if (timelapseCheckbox.checked) {
            updateTimelapseDurationEstimate();
        }
    }

    // Update duration display now that all settings (including timelapse) are loaded
    updateExportRangeDisplay();
}

// Track if save handlers have been set up
let exportOverlaySaveHandlersInitialized = false;

/**
 * Setup change handlers to save export overlay settings
 */
function setupExportOverlaySaveHandlers() {
    if (exportOverlaySaveHandlersInitialized) return;
    exportOverlaySaveHandlersInitialized = true;

    for (const [elementId, settingKey] of Object.entries(EXPORT_OVERLAY_SETTINGS)) {
        const element = $(elementId);
        if (!element) continue;

        element.addEventListener('change', async () => {
            if (!window.electronAPI?.setSetting) return;

            let value;
            if (element.type === 'checkbox') {
                value = element.checked;
            } else if (element.tagName === 'SELECT') {
                value = element.value;
            }

            try {
                await window.electronAPI.setSetting(settingKey, value);
            } catch (err) {
                console.warn(`Failed to save export setting ${settingKey}:`, err);
            }

            // Handle options visibility for checkboxes
            if (elementId === 'includeMinimap') {
                const minimapOptions = $('minimapOptions');
                if (minimapOptions) {
                    minimapOptions.classList.toggle('hidden', !element.checked);
                }
            } else if (elementId === 'includeDashboard') {
                const dashboardOptions = $('dashboardOptions');
                if (dashboardOptions) {
                    dashboardOptions.classList.toggle('hidden', !element.checked);
                }
            } else if (elementId === 'enableTimelapse') {
                const timelapseOptions = $('timelapseOptions');
                if (timelapseOptions) {
                    timelapseOptions.classList.toggle('hidden', !element.checked);
                }
                if (element.checked) {
                    updateTimelapseDurationEstimate();
                }
                // Update header duration display and share link eligibility
                updateExportRangeDisplay();
            } else if (elementId === 'timelapseSpeed') {
                updateTimelapseDurationEstimate();
                // Update header duration display and share link eligibility
                updateExportRangeDisplay();
            }
        });
    }
}

// ============================================================
// Feature NEW Badge Management
// Badges disappear after first interaction, persisted in settings
// ============================================================
const FEATURE_BADGE_KEYS = {
    overlaysNewBadge: 'featureSeen_teslaMobileStyle',
    styleNewBadge: 'featureSeen_teslaMobileStyle',
    shareClipNewBadge: 'featureSeen_shareClip',
    shortcutsNavNewBadge: 'featureSeen_clipNavPreview',
    shortcutsNewBadge: 'featureSeen_clipNavPreview',
    nextClipNewDot: 'featureSeen_clipNavPreview',
    prevClipNewDot: 'featureSeen_clipNavPreview',
    previewNewBadge: 'featureSeen_clipNavPreview',
    minimapRenderModeNewDot: 'featureSeen_minimapStaticMap',
    minimapNewBadge: 'featureSeen_minimapStaticMap'
};

/**
 * Update dashboard option rows based on selected style.
 * - Tesla Mobile: full-width bar, only top/bottom position, no size selector.
 * - Tesla Screen Dash: in-car HUD with intrinsic positions, hide everything.
 */
function updateDashboardStyleOptions(style) {
    const posRow = $('dashboardPositionRow');
    const posTeslaRow = $('dashboardPositionTeslaMobileRow');
    const sizeRow = $('dashboardSizeRow');

    if (style === 'tesla-mobile') {
        if (posRow) posRow.style.display = 'none';
        if (posTeslaRow) posTeslaRow.style.display = '';
        if (sizeRow) sizeRow.style.display = 'none';
    } else if (style === 'tesla-screen-dash') {
        if (posRow) posRow.style.display = 'none';
        if (posTeslaRow) posTeslaRow.style.display = 'none';
        if (sizeRow) sizeRow.style.display = 'none';
    } else {
        if (posRow) posRow.style.display = '';
        if (posTeslaRow) posTeslaRow.style.display = 'none';
        if (sizeRow) sizeRow.style.display = '';
    }

    // Label/Value Size visibility — Only Detailed has both. Compact and
    // Default lack a meaningful label/value distinction so only Value Size
    // is exposed for them.
    const labelRow = $('dashboardLabelScaleRow');
    const valueRow = $('dashboardValueScaleRow');
    if (labelRow) labelRow.style.display = (style === 'detailed') ? '' : 'none';
    if (valueRow) valueRow.style.display = '';

    // Default-style Value Size is JS-capped at 1.0 in the AE preview because
    // the floating-widget panel can't grow past its tile fit, so options above
    // Medium are no-ops. Hide them for Default and snap the current value
    // down if needed so what's selected matches what's actually applied.
    syncValueScaleOptionsForStyle('dashboardValueScale', style);
}

function syncValueScaleOptionsForStyle(selectId, style) {
    const select = document.getElementById(selectId);
    if (!select) return;
    const maxScale = (style === 'default') ? 1 : Infinity;
    for (const opt of select.options) {
        const v = parseFloat(opt.value);
        opt.hidden = Number.isFinite(v) && v > maxScale;
    }
    const cur = parseFloat(select.value);
    if (Number.isFinite(cur) && cur > maxScale) {
        select.value = String(maxScale);
        if (window.electronAPI?.setSetting) {
            window.electronAPI.setSetting('exportDashboardValueScale', maxScale)
                .catch(err => console.warn('persist snapped value scale failed', err));
        }
    }
}

/**
 * Auto-configure the GPS minimap the first time the user picks Tesla Screen Dash.
 * The Tesla Dash look needs the satellite tile + heading arrow in the top-right —
 * we toggle on the existing minimap with a Tesla-style preset (dark, small,
 * top-right). Runs ONCE; if the user later disables the minimap, we respect that.
 */
async function autoConfigureTeslaScreenDashMinimap() {
    if (!window.electronAPI?.getSetting || !window.electronAPI?.setSetting) return;
    try {
        const alreadyConfigured = await window.electronAPI.getSetting('featureSeen_teslaScreenDash_autoConfigured');
        if (alreadyConfigured) return;

        const minimapToggle = $('includeMinimap');
        const minimapPosition = $('minimapPosition');
        const minimapSize = $('minimapSize');
        const minimapDarkMode = $('minimapDarkMode');
        const minimapRenderMode = $('minimapRenderMode');

        if (minimapToggle && !minimapToggle.checked) {
            minimapToggle.checked = true;
            minimapToggle.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (minimapPosition) {
            minimapPosition.value = 'top-right';
            minimapPosition.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (minimapSize) {
            minimapSize.value = 'small';
            minimapSize.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (minimapDarkMode && !minimapDarkMode.checked) {
            minimapDarkMode.checked = true;
            minimapDarkMode.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (minimapRenderMode) {
            minimapRenderMode.value = 'ass';
            minimapRenderMode.dispatchEvent(new Event('change', { bubbles: true }));
        }

        await window.electronAPI.setSetting('featureSeen_teslaScreenDash_autoConfigured', true);
    } catch (err) {
        console.warn('[teslaScreenDash] auto-config failed:', err);
    }
}

let featureBadgesInitialized = false;

/**
 * Initialize feature badges - check settings and show/hide accordingly
 * Called each time the export modal opens
 */
export async function initFeatureBadges() {
    if (!window.electronAPI?.getSetting) return;

    for (const [badgeId, settingKey] of Object.entries(FEATURE_BADGE_KEYS)) {
        const badge = $(badgeId);
        if (!badge) continue;

        try {
            const seen = await window.electronAPI.getSetting(settingKey);
            if (seen) {
                badge.classList.add('hidden');
            } else {
                badge.classList.remove('hidden');
            }
        } catch {
            badge.classList.remove('hidden');
        }
    }

    // Setup dismiss handlers (only once)
    if (!featureBadgesInitialized) {
        featureBadgesInitialized = true;

        // Style dropdown - dismiss both style dot and overlays badge
        const styleSelect = $('dashboardStyle');
        if (styleSelect) {
            styleSelect.addEventListener('change', () => {
                dismissFeatureBadge('styleNewBadge');
                dismissFeatureBadge('overlaysNewBadge');
                updateDashboardStyleOptions(styleSelect.value);
                if (styleSelect.value === 'tesla-screen-dash') {
                    autoConfigureTeslaScreenDashMinimap();
                }
            });
            // Apply initial state
            updateDashboardStyleOptions(styleSelect.value);
        }

        // Overlays section header click - dismiss overlays badge and style dot
        const overlaysSection = document.querySelector('[data-section="overlays"] .collapsible-header');
        if (overlaysSection) {
            overlaysSection.addEventListener('click', () => {
                dismissFeatureBadge('overlaysNewBadge');
                dismissFeatureBadge('styleNewBadge');
            });
        }

        // Share Clip toggle - dismiss on first interaction
        const shareToggle = $('shareClipToggle');
        if (shareToggle) {
            shareToggle.addEventListener('change', () => dismissFeatureBadge('shareClipNewBadge'));
        }

        // Preview video - dismiss on first play
        const previewVideo = $('exportPreviewVideo');
        if (previewVideo) {
            previewVideo.addEventListener('play', () => dismissFeatureBadge('previewNewBadge'), { once: true });
        }

        // Minimap render mode dropdown - dismiss minimap badges
        const minimapRenderMode = $('minimapRenderMode');
        if (minimapRenderMode) {
            minimapRenderMode.addEventListener('change', () => {
                dismissFeatureBadge('minimapRenderModeNewDot');
                dismissFeatureBadge('minimapNewBadge');
            });
        }

        // Use event delegation for settings-modal badges (may not be initialized when export modal opens)
        document.addEventListener('click', (e) => {
            // Shortcuts nav tab
            if (e.target.closest('.settings-nav-item[data-target="shortcuts"]')) {
                dismissFeatureBadge('shortcutsNavNewBadge');
            }
            // Shortcuts section header
            if (e.target.closest('[data-section="shortcuts"] .settings-accordion-header')) {
                dismissFeatureBadge('shortcutsNewBadge');
                dismissFeatureBadge('shortcutsNavNewBadge');
            }
        });
        document.addEventListener('focusin', (e) => {
            // Next/Prev Clip keybind inputs
            if (e.target.id === 'keybindNextClip' || e.target.id === 'keybindPrevClip') {
                dismissFeatureBadge('nextClipNewDot');
                dismissFeatureBadge('prevClipNewDot');
                dismissFeatureBadge('shortcutsNewBadge');
                dismissFeatureBadge('shortcutsNavNewBadge');
            }
        });
    }
}

/**
 * Dismiss a feature badge permanently
 */
async function dismissFeatureBadge(badgeId) {
    const badge = $(badgeId);
    if (!badge || badge.classList.contains('hidden')) return;
    badge.classList.add('hidden');
    const settingKey = FEATURE_BADGE_KEYS[badgeId];
    if (settingKey && window.electronAPI?.setSetting) {
        try {
            await window.electronAPI.setSetting(settingKey, true);
        } catch (err) {
            console.warn(`Failed to save badge state ${settingKey}:`, err);
        }
    }
}

/**
 * Update the timelapse duration estimate text based on selected speed and export range
 */
function updateTimelapseDurationEstimate() {
    const speedSelect = $('timelapseSpeed');
    const durationText = $('timelapseDurationText');
    if (!speedSelect || !durationText) return;

    const speed = parseFloat(speedSelect.value) || 8;

    // Try to calculate actual output duration from export range
    const nativeVideo = getNativeVideo?.();
    const totalSec = nativeVideo?.cumulativeStarts?.[nativeVideo.cumulativeStarts.length - 1] || 0;

    if (totalSec > 0) {
        const startPct = exportState.startMarkerPct ?? 0;
        const endPct = exportState.endMarkerPct ?? 100;
        const rangeSec = Math.abs((endPct - startPct) / 100 * totalSec);
        const outputSec = rangeSec / speed;

        // Format duration nicely
        const formatDuration = (sec) => {
            if (sec < 60) return `${Math.round(sec)}s`;
            const mins = Math.floor(sec / 60);
            const secs = Math.round(sec % 60);
            if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
            const hrs = Math.floor(mins / 60);
            const remainMins = mins % 60;
            return remainMins > 0 ? `${hrs}h ${remainMins}m` : `${hrs}h`;
        };

        durationText.textContent = `${formatDuration(rangeSec)} → ${formatDuration(outputSec)} at ${speed}x speed`;
    } else {
        durationText.textContent = speed < 1 ? `Output will be ~${1 / speed}x longer than selected range` : `Output will be ~${speed}x shorter than selected range`;
    }
}

/**
 * Detect available cameras from the current collection
 * HW3 vehicles only have 4 cameras (no pillars), HW3+/HW4 have 6 cameras
 * @param {Object} state - App state
 * @returns {Set<string>} Set of available camera names
 */
function detectAvailableCameras(state) {
    const availableCameras = new Set();
    const collection = state?.collection?.active;

    if (!collection?.groups) return availableCameras;

    // Scan all groups in the collection for available cameras
    for (const group of collection.groups) {
        if (group.filesByCamera) {
            for (const camera of group.filesByCamera.keys()) {
                availableCameras.add(camera);
            }
        }
    }

    return availableCameras;
}

/**
 * Update camera checkbox visibility based on available cameras
 * Hides pillar camera options for HW3 vehicles (4-cam systems)
 * @param {Set<string>} availableCameras - Set of available camera names
 */
function updateCameraCheckboxVisibility(availableCameras) {
    const allCameraCheckboxes = document.querySelectorAll('.option-card input[data-camera]');
    const hasPillarCameras = availableCameras.has('left_pillar') || availableCameras.has('right_pillar');

    allCameraCheckboxes.forEach(checkbox => {
        const camera = checkbox.dataset.camera;
        const card = checkbox.closest('.option-card');

        if (!card) return;

        // Check if this camera is a pillar camera
        const isPillarCamera = camera === 'left_pillar' || camera === 'right_pillar';

        if (isPillarCamera && !hasPillarCameras) {
            // Hide pillar cameras for HW3 vehicles
            card.style.display = 'none';
            checkbox.checked = false;
        } else {
            // Show and check available cameras
            card.style.display = '';
            checkbox.checked = availableCameras.has(camera);
        }
    });

    // Update the grid layout - switch to 2x2 for 4 cameras (option-grid defaults to 2 cols)
    const layoutSection = document.querySelector('.collapsible-section[data-section="layout"]');
    const optionGrid = layoutSection?.querySelector('.option-grid');
    if (optionGrid) {
        if (hasPillarCameras) {
            optionGrid.classList.add('option-grid-3');
        } else {
            optionGrid.classList.remove('option-grid-3');
        }
    }
}

/**
 * Set an export marker at current position
 * @param {string} type - 'start' or 'end'
 */
export function setExportMarker(type) {
    const state = getState?.();
    const progressBar = getProgressBar?.();

    if (!state?.collection?.active) {
        notify(t('ui.notifications.loadCollectionFirst'), { type: 'warn' });
        return;
    }

    const currentPct = parseFloat(progressBar?.value) || 0;

    if (type === 'start') {
        exportState.startMarkerPct = currentPct;
        if (exportState.endMarkerPct !== null && exportState.endMarkerPct <= currentPct) {
            exportState.endMarkerPct = null;
        }
        notify(t('ui.notifications.startMarkerSet'), { type: 'success' });
    } else {
        exportState.endMarkerPct = currentPct;
        if (exportState.startMarkerPct !== null && exportState.startMarkerPct >= currentPct) {
            exportState.startMarkerPct = null;
        }
        notify(t('ui.notifications.endMarkerSet'), { type: 'success' });
    }

    updateExportMarkers();
    updateExportButtonState();
}

/**
 * Update visual export markers on timeline
 */
export function updateExportMarkers() {
    const markersContainer = $('timelineMarkers');
    if (!markersContainer) return;

    // Get or create start marker
    let startMarker = markersContainer.querySelector('.export-marker.start');
    if (exportState.startMarkerPct !== null) {
        if (!startMarker) {
            startMarker = createMarkerElement('start');
            markersContainer.appendChild(startMarker);
        }
        startMarker.style.left = `${exportState.startMarkerPct}%`;
    } else if (startMarker) {
        startMarker.remove();
    }

    // Get or create end marker
    let endMarker = markersContainer.querySelector('.export-marker.end');
    if (exportState.endMarkerPct !== null) {
        if (!endMarker) {
            endMarker = createMarkerElement('end');
            markersContainer.appendChild(endMarker);
        }
        endMarker.style.left = `${exportState.endMarkerPct}%`;
    } else if (endMarker) {
        endMarker.remove();
    }

    // Get or create highlight between markers
    let highlight = markersContainer.querySelector('.export-range-highlight');
    if (exportState.startMarkerPct !== null && exportState.endMarkerPct !== null) {
        if (!highlight) {
            highlight = document.createElement('div');
            highlight.className = 'export-range-highlight';
            markersContainer.appendChild(highlight);
        }
        const startPct = Math.min(exportState.startMarkerPct, exportState.endMarkerPct);
        const endPct = Math.max(exportState.startMarkerPct, exportState.endMarkerPct);
        highlight.style.left = `${startPct}%`;
        highlight.style.width = `${endPct - startPct}%`;
    } else if (highlight) {
        highlight.remove();
    }
}

/**
 * Create a marker element with remove button
 * @param {string} type - 'start' or 'end'
 * @returns {HTMLElement}
 */
function createMarkerElement(type) {
    const marker = document.createElement('div');
    marker.className = `export-marker ${type}`;
    const markerType = type === 'start' ? t('ui.export.start') : t('ui.export.end');
    marker.title = `${t('ui.export.exportBtn')} ${markerType} point (drag to adjust)`;

    // Add remove button (X)
    const removeBtn = document.createElement('div');
    removeBtn.className = 'marker-remove';
    removeBtn.title = `Remove ${markerType} marker`;
    removeBtn.innerHTML = `<span class="material-symbols-outlined mi-sm">close</span>`;
    removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        removeMarker(type);
    });
    marker.appendChild(removeBtn);

    makeMarkerDraggable(marker, type);
    return marker;
}

/**
 * Remove a specific marker
 * @param {string} type - 'start' or 'end'
 */
function removeMarker(type) {
    if (type === 'start') {
        exportState.startMarkerPct = null;
    } else {
        exportState.endMarkerPct = null;
    }
    updateExportMarkers();
    updateExportButtonState();
}

function makeMarkerDraggable(marker, type) {
    let isDragging = false;

    marker.addEventListener('mousedown', (e) => {
        // Ignore clicks on the remove button
        if (e.target.closest('.marker-remove')) return;
        isDragging = true;
        marker.style.cursor = 'grabbing';
        e.preventDefault();
        e.stopPropagation();

        const onMouseMove = (moveEvent) => {
            if (!isDragging) return;
            const timelineContainer = marker.closest('.timeline-container');
            if (!timelineContainer) return;

            const rect = timelineContainer.getBoundingClientRect();
            const pct = Math.max(0, Math.min(100, ((moveEvent.clientX - rect.left) / rect.width) * 100));

            if (type === 'start') {
                exportState.startMarkerPct = pct;
            } else {
                exportState.endMarkerPct = pct;
            }

            updateExportMarkers();
        };

        const onMouseUp = () => {
            isDragging = false;
            marker.style.cursor = 'ew-resize';
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            updateExportButtonState();
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
}

/**
 * Update export button enabled state
 */
export function updateExportButtonState() {
    const state = getState?.();
    const setStartMarkerBtn = $('setStartMarkerBtn');
    const setEndMarkerBtn = $('setEndMarkerBtn');
    const exportBtn = $('exportBtn');

    const hasCollection = !!state?.collection?.active;

    if (setStartMarkerBtn) setStartMarkerBtn.disabled = !hasCollection;
    if (setEndMarkerBtn) setEndMarkerBtn.disabled = !hasCollection;
    if (exportBtn) exportBtn.disabled = !hasCollection;
}

// Lock or unlock the simple export modal for AE-driven exports. Locks the
// entire modal body (all sections) via `inert` + a dimmed class, and shows
// a banner indicating the layout came from the Advanced Editor. Idempotent
// and safe to call when the modal isn't visible.
export function setSimpleModalAeMode(on) {
    const modal = document.getElementById('exportModal');
    const banner = document.getElementById('aeExportBanner');
    const body = modal?.querySelector('.modal-body');
    if (!modal || !body) return;
    if (on) {
        modal.classList.add('ae-export-mode');
        body.inert = true;
        banner?.classList.remove('hidden');
    } else {
        modal.classList.remove('ae-export-mode');
        body.inert = false;
        banner?.classList.add('hidden');
    }
}

/**
 * Open the export modal
 */
export function openExportModal() {
    // If export is active and modal was minimized, just reopen without resetting
    if (exportState.isExporting && exportState.modalMinimized) {
        reopenExportModal();
        return;
    }

    const state = getState?.();
    if (!state?.collection?.active) {
        notify(t('ui.notifications.loadCollectionFirst'), { type: 'warn' });
        return;
    }

    const modal = $('exportModal');
    if (!modal) return;

    // Detect available cameras from the collection
    const availableCameras = detectAvailableCameras(state);
    updateCameraCheckboxVisibility(availableCameras);

    // Show modal first so dimensions are accurate
    modal.classList.remove('hidden');

    // Fetch share config (expiration hours) from server
    fetchShareConfig();

    // Load saved export overlay settings
    loadExportOverlaySettings();

    // Initialize dismissible NEW badges
    initFeatureBadges();

    updateExportRangeDisplay();
    checkFFmpegAvailability();

    // Initialize Layout Lab and collapsible sections after modal is visible
    import('../ui/layoutLab.js').then(({ initLayoutLab, setAvailableCameras }) => {
        // Pass available cameras to Layout Lab
        if (setAvailableCameras) setAvailableCameras(availableCameras);
        // Wait for next frame to ensure modal is fully rendered
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                initLayoutLab();

                // Initialize collapsible sections
                modal.querySelectorAll('.collapsible-header').forEach(header => {
                    // Remove existing listener to avoid duplicates
                    const newHeader = header.cloneNode(true);
                    header.parentNode.replaceChild(newHeader, header);
                    newHeader.addEventListener('click', () => {
                        const section = newHeader.closest('.collapsible-section');
                        if (section) section.classList.toggle('open');
                    });
                });
            });
        });
    });

    const progressEl = $('exportProgress');
    const progressBar = $('exportProgressBar');
    const progressText = $('exportProgressText');
    if (progressEl) progressEl.classList.add('hidden');
    if (progressBar) progressBar.style.width = '0%';
    if (progressText) progressText.textContent = t('ui.export.preparing');

    // Default filename will be recalculated at export time with the actual clip start time
    // Store collection name for later use
    const collName = state.collection.active?.label || 'export';
    exportState.safeName = collName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);

    // Restore last-used quality from settings (silently, async)
    const highQuality = document.querySelector('input[name="exportQuality"][value="high"]');
    if (highQuality) highQuality.checked = true; // Default first

    if (window.electronAPI?.getSetting) {
        window.electronAPI.getSetting('exportLastQuality').then(savedQuality => {
            if (savedQuality && ['mobile', 'medium', 'high', 'max'].includes(savedQuality)) {
                const qualityRadio = document.querySelector(`input[name="exportQuality"][value="${savedQuality}"]`);
                if (qualityRadio) {
                    qualityRadio.checked = true;
                    updateExportSizeEstimate();
                }
            }
        }).catch(() => { });

        // Check for saved blur zones and show restore banner
        window.electronAPI.getSetting('exportLastBlurZones').then(savedZones => {
            if (savedZones && Array.isArray(savedZones) && savedZones.length > 0 && exportState.blurZones.length === 0) {
                showBlurZoneRestoreBanner(savedZones);
            }
        }).catch(() => { });
    }

    const qualityInputs = document.querySelectorAll('input[name="exportQuality"]');
    qualityInputs.forEach(input => { input.onchange = updateExportSizeEstimate; });
    const cameraInputs = document.querySelectorAll('.option-card input[data-camera]');
    cameraInputs.forEach(input => { input.onchange = updateExportSizeEstimate; });
    updateExportSizeEstimate();

    const startBtn = $('startExportBtn');
    if (startBtn) startBtn.disabled = false;

    // Ensure close button is enabled when modal opens
    const closeBtn = $('closeExportModal');
    if (closeBtn) {
        closeBtn.disabled = false;
        closeBtn.style.cursor = 'pointer';
        closeBtn.style.opacity = '1';
    }

    // Initialize blur zone editor modal
    initBlurZoneEditorModal();

    // Update blur zone status display
    updateBlurZoneStatusDisplay();

    // Hide completion panel when opening fresh
    const completePanel = $('exportCompletePanel');
    if (completePanel) completePanel.classList.add('hidden');

    // Reset share upload UI
    const shareUploadProgress = $('shareUploadProgress');
    const shareLinkResult = $('shareLinkResult');
    const shareError = $('shareError');
    if (shareUploadProgress) shareUploadProgress.classList.add('hidden');
    if (shareLinkResult) shareLinkResult.classList.add('hidden');
    if (shareError) shareError.classList.add('hidden');

    // Initialize share clip toggle based on export duration
    initShareClipToggle();

    // Initialize minimap toggle and options
    const minimapCheckbox = $('includeMinimap');
    const minimapOptions = $('minimapOptions');
    const minimapNoGpsWarning = $('minimapNoGpsWarning');
    const minimapRenderMode = $('minimapRenderMode');
    const minimapModeDesc = $('minimapModeDesc');
    const minimapModeInfo = $('minimapModeInfo');

    if (minimapCheckbox) {
        // Enable minimap checkbox - GPS availability is checked during export
        // Note: Don't reset checked state here - it's loaded from settings in loadExportOverlaySettings()
        minimapCheckbox.disabled = false;

        // Hide warning by default
        if (minimapNoGpsWarning) minimapNoGpsWarning.classList.add('hidden');

        // Initialize options visibility based on current checkbox state (set by loadExportOverlaySettings)
        if (minimapOptions) {
            if (minimapCheckbox.checked) {
                minimapOptions.classList.remove('hidden');
            } else {
                minimapOptions.classList.add('hidden');
            }
        }
    }

    // Handle minimap render mode change
    if (minimapRenderMode && minimapModeDesc && minimapModeInfo) {
        const updateMinimapModeInfo = () => {
            const mode = minimapRenderMode.value;
            if (mode === 'ass') {
                minimapModeDesc.textContent = t('ui.export.minimapStaticDesc');
                minimapModeInfo.classList.remove('info-yellow');
                minimapModeInfo.classList.add('info-blue');
                minimapModeInfo.querySelector('.info-box-icon').textContent = '⚡';
            } else {
                minimapModeDesc.textContent = t('ui.export.minimapLiveDesc');
                minimapModeInfo.classList.remove('info-blue');
                minimapModeInfo.classList.add('info-yellow');
                minimapModeInfo.querySelector('.info-box-icon').textContent = '🗺️';
            }
        };

        minimapRenderMode.onchange = updateMinimapModeInfo;
        updateMinimapModeInfo(); // Set initial state
    }
}

/**
 * Close the export modal (minimizes during active export instead of canceling)
 */
export function closeExportModal() {
    const modal = $('exportModal');
    if (modal) modal.classList.add('hidden');

    // Restore modal body/footer if completion panel was showing
    const completePanel = $('exportCompletePanel');
    if (completePanel && !completePanel.classList.contains('hidden')) {
        completePanel.classList.add('hidden');
        const modalBody = modal?.querySelector('.modal-body');
        const modalFooter = modal?.querySelector('.modal-footer');
        if (modalBody) modalBody.classList.remove('hidden');
        if (modalFooter) modalFooter.classList.remove('hidden');
    }

    // Clean up share progress listener
    window.electronAPI?.removeAllListeners?.('share:progress');

    // Release preview video resource
    const previewVideo = $('exportPreviewVideo');
    if (previewVideo) {
        previewVideo.pause();
        previewVideo.removeAttribute('src');
        previewVideo.load();
    }
    const previewContainer = $('exportPreviewContainer');
    if (previewContainer) previewContainer.classList.add('hidden');

    // If exporting, show floating progress instead of canceling
    if (exportState.isExporting && exportState.currentExportId) {
        exportState.modalMinimized = true;
        showFloatingProgress();
    }
}

/**
 * Reset the close button back to × when export finishes or is cancelled
 */
function resetCloseButton() {
    const closeBtn = $('closeExportModal');
    if (closeBtn) {
        closeBtn.innerHTML = '&times;';
        closeBtn.title = '';
    }
}

/**
 * Reopen the export modal from the floating progress notification
 */
export function reopenExportModal() {
    const modal = $('exportModal');
    if (modal) {
        modal.classList.remove('hidden');
        exportState.modalMinimized = false;
        hideFloatingProgress();
    }
}

/**
 * Show the floating export progress notification
 */
function showFloatingProgress() {
    const floatingEl = $('exportFloatingProgress');
    if (floatingEl) {
        floatingEl.classList.remove('hidden');
        // Trigger animation after removing hidden
        requestAnimationFrame(() => {
            floatingEl.classList.add('show');
        });
        updateFloatingProgress(exportState.currentStep, exportState.currentProgress);
    }
}

/**
 * Hide the floating export progress notification
 */
function hideFloatingProgress() {
    const floatingEl = $('exportFloatingProgress');
    if (floatingEl) {
        floatingEl.classList.remove('show');
        setTimeout(() => {
            floatingEl.classList.add('hidden');
        }, 200);
    }
}

/**
 * Translate a message that may be a string or an object with translation key
 * @param {string|Object} message - Either a plain string or { key: string, params?: Object }
 * @returns {string} The translated message
 */
export function translateMessage(message) {
    if (!message) return '';
    if (typeof message === 'string') return message;
    if (typeof message === 'object' && message.key) {
        return t(message.key, message.params || {});
    }
    return String(message);
}

/**
 * Update the floating progress notification
 * @param {string|Object} step - Current step text or translation key object
 * @param {number} percentage - Progress percentage (0-100)
 */
function updateFloatingProgress(step, percentage) {
    const stepEl = $('exportFloatingStep');
    const barFill = $('exportFloatingBarFill');

    if (stepEl) stepEl.textContent = translateMessage(step) || t('ui.export.exporting');
    if (barFill) barFill.style.width = `${percentage || 0}%`;
}

/**
 * Capture a snapshot from video at a specific time
 * @param {number} timeSec - Time in seconds to capture
 * @param {HTMLVideoElement} videoElement - Video element to capture from
 * @returns {Promise<string>} - Data URL of the captured image
 */
async function captureVideoSnapshot(timeSec, videoElement) {
    return new Promise((resolve, reject) => {
        if (!videoElement) {
            reject(new Error('No video element provided'));
            return;
        }

        const wasPlaying = !videoElement.paused;
        const originalTime = videoElement.currentTime;

        // Seek to target time
        videoElement.currentTime = timeSec;

        const onSeeked = () => {
            videoElement.removeEventListener('seeked', onSeeked);

            // Create canvas and draw video frame
            const canvas = document.createElement('canvas');
            canvas.width = videoElement.videoWidth || videoElement.clientWidth;
            canvas.height = videoElement.videoHeight || videoElement.clientHeight;

            const ctx = canvas.getContext('2d');
            ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);

            // Restore original state
            videoElement.currentTime = originalTime;
            if (wasPlaying) {
                videoElement.play().catch(() => { });
            }

            resolve(canvas.toDataURL('image/png'));
        };

        videoElement.addEventListener('seeked', onSeeked, { once: true });

        // Timeout fallback
        setTimeout(() => {
            videoElement.removeEventListener('seeked', onSeeked);
            reject(new Error('Snapshot capture timeout'));
        }, 5000);
    });
}

/**
 * Open the blur zone editor for a specific camera
 * @param {string} snapshotCamera - Camera to capture snapshot from
 * @param {HTMLElement} editorModal - The editor modal element
 * @param {number|null} editIndex - Index of existing zone to edit, or null for new zone
 */
export async function openBlurZoneEditorForCamera(snapshotCamera, editorModal, editIndex = null) {
    const state = getState?.();
    const nativeVideo = getNativeVideo?.();

    if (!state?.collection?.active) {
        notify(t('ui.notifications.loadCollectionFirst'), { type: 'warn' });
        return;
    }

    // Use current viewer playback time (cumulative position across all segments)
    const totalSec = nativeVideo?.cumulativeStarts?.[nativeVideo.cumulativeStarts.length - 1] || 60;
    const segIdx = nativeVideo?.currentSegmentIdx || 0;
    const cumStart = nativeVideo?.cumulativeStarts?.[segIdx] || 0;
    const masterTime = nativeVideo?.master?.currentTime || 0;
    const currentPlaybackSec = cumStart + masterTime;

    // Use current playback time directly (don't clamp to export range - user wants to see what's playing)
    const snapshotSec = Math.max(0, Math.min(totalSec, currentPlaybackSec));

    try {
        notify(t('ui.notifications.capturingSnapshot'));

        // Find the video file for the snapshot camera at the current playback position
        const groups = state.collection.active.groups || [];
        const cumStarts = nativeVideo?.cumulativeStarts || [];
        let targetSegment = 0;

        for (let i = 0; i < cumStarts.length - 1; i++) {
            if (snapshotSec >= cumStarts[i] && snapshotSec < cumStarts[i + 1]) {
                targetSegment = i;
                break;
            }
        }
        if (snapshotSec >= cumStarts[cumStarts.length - 1]) {
            targetSegment = groups.length - 1;
        }

        const group = groups[targetSegment];
        const entry = group?.filesByCamera?.get(snapshotCamera);

        if (!entry?.file) {
            notify(t('ui.notifications.couldNotFindVideoFile', { camera: snapshotCamera }), { type: 'error' });
            return;
        }

        // Create temporary video element
        const tempVideo = document.createElement('video');
        tempVideo.muted = true;
        tempVideo.playsInline = true;
        tempVideo.style.display = 'none';
        document.body.appendChild(tempVideo);

        // Load video file
        let videoUrl;
        if (entry.file.path) {
            videoUrl = filePathToUrl(entry.file.path);
        } else if (entry.file instanceof File) {
            videoUrl = URL.createObjectURL(entry.file);
        } else {
            notify(t('ui.notifications.unsupportedFileType'), { type: 'error' });
            return;
        }

        tempVideo.src = videoUrl;

        await new Promise((resolve, reject) => {
            tempVideo.onloadedmetadata = resolve;
            tempVideo.onerror = reject;
            setTimeout(reject, 10000);
        });

        // Calculate local time within segment
        const segmentStartSec = cumStarts[targetSegment] || 0;
        const localTimeSec = Math.min(snapshotSec - segmentStartSec, tempVideo.duration);

        // Capture snapshot
        const snapshotDataUrl = await captureVideoSnapshot(localTimeSec, tempVideo);

        // Get video dimensions before cleanup (setting src='' resets videoWidth/Height to 0)
        const videoWidth = tempVideo.videoWidth || 1448;
        const videoHeight = tempVideo.videoHeight || 938;

        // Clean up
        tempVideo.src = '';
        document.body.removeChild(tempVideo);
        if (videoUrl.startsWith('blob:')) {
            URL.revokeObjectURL(videoUrl);
        }

        // Store which camera this zone is for
        exportState.blurZoneCamera = snapshotCamera;
        exportState.blurZoneEditIndex = editIndex;

        // Load existing coordinates if editing
        const savedCoords = editIndex !== null ? exportState.blurZones[editIndex]?.coordinates : null;

        // Mirror the snapshot for cameras that are mirrored in viewer/export (back and repeaters only)
        // Respect the global mirrorCameras setting
        const shouldMirror = window._mirrorCameras !== false && ['back', 'left_repeater', 'right_repeater'].includes(snapshotCamera);

        // Initialize editor with snapshot
        editorModal.classList.remove('hidden');
        initBlurZoneEditor(snapshotDataUrl, videoWidth, videoHeight, savedCoords, shouldMirror);

    } catch (err) {
        console.error('Failed to capture snapshot:', err);
        notify(t('ui.notifications.failedToCaptureSnapshot', { error: err.message }), { type: 'error' });
    }
}

/**
 * Render the list of configured blur zones with edit/remove buttons
 */
function renderBlurZoneList() {
    const listEl = $('blurZoneList');
    if (!listEl) return;

    const cameraNames = {
        front: t('ui.cameras.front'),
        back: t('ui.cameras.back'),
        left_repeater: t('ui.cameras.leftRepeater'),
        right_repeater: t('ui.cameras.rightRepeater'),
        left_pillar: t('ui.cameras.leftPillar'),
        right_pillar: t('ui.cameras.rightPillar')
    };

    if (exportState.blurZones.length === 0) {
        listEl.innerHTML = '';
        return;
    }

    listEl.innerHTML = exportState.blurZones.map((zone, index) => `
        <div class="blur-zone-item" style="display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: rgba(255,255,255,0.05); border-radius: 6px; margin-bottom: 6px;">
            <span style="color: var(--text-secondary);">
                <strong>${cameraNames[zone.camera] || zone.camera}</strong> - ${zone.coordinates.length} points
            </span>
            <div style="display: flex; gap: 6px;">
                <button class="btn btn-secondary btn-small blur-zone-edit-btn" data-index="${index}" style="padding: 4px 10px; font-size: 12px;">Edit</button>
                <button class="btn btn-secondary btn-small blur-zone-remove-btn" data-index="${index}" style="padding: 4px 10px; font-size: 12px; color: #ff6b6b;">Remove</button>
            </div>
        </div>
    `).join('');

    // Add event listeners for edit/remove buttons
    listEl.querySelectorAll('.blur-zone-edit-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const index = parseInt(btn.dataset.index, 10);
            const zone = exportState.blurZones[index];
            if (zone) {
                const editorModal = $('blurZoneEditorModal');
                await openBlurZoneEditorForCamera(zone.camera, editorModal, index);
            }
        });
    });

    listEl.querySelectorAll('.blur-zone-remove-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const index = parseInt(btn.dataset.index, 10);
            exportState.blurZones.splice(index, 1);
            renderBlurZoneList();
            updateBlurZoneStatusDisplay(); // This handles dashboard availability
        });
    });
}

/**
 * Initialize blur zone editor modal event handlers
 */
function initBlurZoneEditorModal() {
    // Prevent duplicate initialization
    if (blurZoneModalInitialized) return;

    const addBtn = $('addBlurZoneBtn');
    const editorModal = $('blurZoneEditorModal');
    const closeBtn = $('closeBlurZoneEditorModal');
    const cancelBtn = $('cancelBlurZoneBtn');
    const saveBtn = $('saveBlurZoneBtn');

    if (!addBtn || !editorModal) return;

    blurZoneModalInitialized = true;

    addBtn.addEventListener('click', async () => {
        // Get camera from dropdown
        const cameraSelect = $('blurZoneCameraSelect');
        const snapshotCamera = cameraSelect?.value || 'back';

        await openBlurZoneEditorForCamera(snapshotCamera, editorModal);
    });

    const closeEditor = () => {
        editorModal.classList.add('hidden');
        resetBlurZoneEditor();
        exportState.blurZoneEditIndex = null;
    };

    if (closeBtn) closeBtn.addEventListener('click', closeEditor);
    if (cancelBtn) cancelBtn.addEventListener('click', closeEditor);

    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            try {
                const coords = getNormalizedCoordinates();

                if (!coords || coords.length < 3) {
                    notify(t('ui.notifications.blurZoneMinPoints'), { type: 'warn' });
                    return;
                }

                // Generate mask image
                const maskImageDataUrl = await generateMaskImage();
                if (!maskImageDataUrl) {
                    notify(t('ui.notifications.failedToGenerateMask'), { type: 'error' });
                    return;
                }

                // Extract base64 data
                const base64Data = maskImageDataUrl.split(',')[1];
                if (!base64Data) {
                    notify(t('ui.notifications.failedToExtractMaskData'), { type: 'error' });
                    return;
                }

                // Get canvas dimensions
                const canvasDims = getCanvasDimensions();
                if (!canvasDims) {
                    notify(t('ui.notifications.failedToGetCanvasDimensions'), { type: 'error' });
                    return;
                }

                const newZone = {
                    coordinates: coords,
                    camera: exportState.blurZoneCamera || 'back',
                    maskImageBase64: base64Data,
                    maskWidth: canvasDims.width,
                    maskHeight: canvasDims.height
                };

                // Update existing zone if editing, or add new zone
                if (exportState.blurZoneEditIndex !== null) {
                    exportState.blurZones[exportState.blurZoneEditIndex] = newZone;
                } else {
                    // Always add as new zone (allow multiple zones per camera)
                    exportState.blurZones.push(newZone);
                }

                updateBlurZoneStatusDisplay();
                notify(t('ui.notifications.blurZoneSaved'), { type: 'success' });
                closeEditor();
            } catch (err) {
                console.error('[BLUR ZONE] Save error:', err);
                notify(t('ui.notifications.failedToSaveBlurZone', { error: err.message }), { type: 'error' });
            }
        });
    }
}

/**
 * Show a restore banner for previously saved blur zones
 * @param {Array} savedZones - Array of saved blur zone objects from settings
 */
function showBlurZoneRestoreBanner(savedZones) {
    // Remove existing banner if any
    const existingBanner = $('blurZoneRestoreBanner');
    if (existingBanner) existingBanner.remove();

    const blurSection = $('blurZoneSection') || $('addBlurZoneBtn')?.closest('.collapsible-content');
    if (!blurSection) return;

    const banner = document.createElement('div');
    banner.id = 'blurZoneRestoreBanner';
    banner.className = 'blur-zone-restore-banner';
    banner.innerHTML = `
        <div class="restore-banner-content">
            <span class="restore-banner-icon"><span class="material-symbols-outlined">lock</span></span>
            <span class="restore-banner-text" data-i18n="ui.export.restoreBannerText" data-i18n-params='{"count":${savedZones.length}}'>${t('ui.export.restoreBannerText', { count: savedZones.length })}</span>
        </div>
        <div class="restore-banner-actions">
            <button class="btn btn-primary btn-small restore-banner-restore" data-i18n="ui.export.restoreBannerRestore">${t('ui.export.restoreBannerRestore')}</button>
            <button class="btn btn-secondary btn-small restore-banner-dismiss" data-i18n="ui.export.restoreBannerDismiss">${t('ui.export.restoreBannerDismiss')}</button>
        </div>
    `;

    // Insert at the top of the blur section
    blurSection.insertBefore(banner, blurSection.firstChild);

    // Restore button
    banner.querySelector('.restore-banner-restore').onclick = () => {
        exportState.blurZones = [...savedZones];
        updateBlurZoneStatusDisplay();
        banner.remove();
        notify(t('ui.export.restoreBannerRestored'), { type: 'success' });
    };

    // Dismiss button
    banner.querySelector('.restore-banner-dismiss').onclick = () => {
        banner.remove();
    };

    // Update banner text when language changes
    onLanguageChange(() => {
        const b = $('blurZoneRestoreBanner');
        if (!b) return;
        const textEl = b.querySelector('.restore-banner-text');
        if (textEl) textEl.textContent = t('ui.export.restoreBannerText', { count: savedZones.length });
        const restoreBtn = b.querySelector('.restore-banner-restore');
        if (restoreBtn) restoreBtn.textContent = t('ui.export.restoreBannerRestore');
        const dismissBtn = b.querySelector('.restore-banner-dismiss');
        if (dismissBtn) dismissBtn.textContent = t('ui.export.restoreBannerDismiss');
    });
}

/**
 * Update the blur zone status display in export modal
 */
function updateBlurZoneStatusDisplay() {
    const statusEl = $('blurZoneStatus');
    const statusTextEl = $('blurZoneStatusText');
    const addBtn = $('addBlurZoneBtn');

    // Render the blur zone list
    renderBlurZoneList();

    if (exportState.blurZones.length > 0) {
        if (statusEl) statusEl.classList.remove('hidden');
        const cameras = [...new Set(exportState.blurZones.map(z => z.camera))];
        const cameraNames = cameras.map(c => {
            const names = { front: t('ui.cameras.front'), back: t('ui.cameras.back'), left_repeater: t('ui.cameras.leftRepeater'), right_repeater: t('ui.cameras.rightRepeater'), left_pillar: t('ui.cameras.leftPillar'), right_pillar: t('ui.cameras.rightPillar') };
            return names[c] || c;
        });
        // Show blur zone count - dashboard status depends on blur type, handled separately
        if (statusTextEl) {
            statusTextEl.textContent = t('ui.export.blurZoneCount', { count: exportState.blurZones.length });
        }
        if (addBtn) addBtn.textContent = 'Add Zone';
    } else {
        if (statusEl) statusEl.classList.add('hidden');
        if (addBtn) addBtn.textContent = 'Add Zone';
    }

}

/**
 * Update export range display in modal
 */
export function updateExportRangeDisplay() {
    const nativeVideo = getNativeVideo?.();
    const startTimeEl = $('exportStartTime');
    const endTimeEl = $('exportEndTime');
    const durationEl = $('exportDuration');

    const state = getState?.();
    if (!state?.collection?.active) return;

    const totalSec = nativeVideo?.cumulativeStarts?.[nativeVideo.cumulativeStarts.length - 1] || 60;

    const startPct = exportState.startMarkerPct ?? 0;
    const endPct = exportState.endMarkerPct ?? 100;

    const startSec = (startPct / 100) * totalSec;
    const endSec = (endPct / 100) * totalSec;
    const durationSec = Math.abs(endSec - startSec);

    if (startTimeEl) startTimeEl.textContent = formatTimeHMS(Math.min(startSec, endSec));
    if (endTimeEl) endTimeEl.textContent = formatTimeHMS(Math.max(startSec, endSec));

    // Show effective duration when timelapse is enabled
    const timelapseEnabled = $('enableTimelapse')?.checked ?? false;
    const timelapseSpeed = timelapseEnabled ? (parseFloat($('timelapseSpeed')?.value) || 8) : 1;
    const durationLabel = $('exportDurationLabel');
    const durationItem = $('exportDurationItem');
    if (timelapseEnabled && timelapseSpeed !== 1) {
        const effectiveSec = durationSec / timelapseSpeed;
        if (durationEl) durationEl.textContent = `${formatTimeHMS(durationSec)} → ${formatTimeHMS(effectiveSec)}`;
        if (durationLabel) durationLabel.textContent = t('ui.export.timelapseDuration');
        if (durationItem) durationItem.classList.add('timelapse-active');
    } else {
        if (durationEl) durationEl.textContent = formatTimeHMS(durationSec);
        if (durationLabel) durationLabel.textContent = t('ui.export.duration');
        if (durationItem) durationItem.classList.remove('timelapse-active');
    }

    // Update share toggle availability based on new duration
    initShareClipToggle();
}

/**
 * Update estimated file size display
 */
export function updateExportSizeEstimate() {
    const nativeVideo = getNativeVideo?.();
    const state = getState?.();
    const estimateEl = $('exportSizeEstimate');
    const warningEl = $('frontCamWarning');
    if (!estimateEl || !state?.collection?.active) return;

    const totalSec = nativeVideo?.cumulativeStarts?.[nativeVideo.cumulativeStarts.length - 1] || 60;
    const startPct = exportState.startMarkerPct ?? 0;
    const endPct = exportState.endMarkerPct ?? 100;
    const durationMin = Math.abs((endPct - startPct) / 100 * totalSec) / 60;

    const selectedCameras = document.querySelectorAll('.option-card input[data-camera]:checked');
    const cameraCount = selectedCameras.length || 6;
    const isFrontOnly = cameraCount === 1 && selectedCameras[0]?.dataset?.camera === 'front';
    const hasFrontAndOthers = cameraCount > 1 && Array.from(selectedCameras).some(cb => cb.dataset?.camera === 'front');

    // Detect actual camera resolution from loaded video elements
    // HW4: Front=2896×1876, Others=1448×938 (front is 2x larger)
    // HW3: All cameras=1280×960 (all same size)
    let baseW = 1448, baseH = 938; // Default: HW4 side camera
    let frontW = 2896, frontH = 1876; // Default: HW4 front camera
    const videoEls = document.querySelectorAll('.tile-video');
    for (const vid of videoEls) {
        if (vid.videoWidth > 0 && vid.videoHeight > 0) {
            // Use the first non-front video as base resolution, or any video
            const tile = vid.closest('.multi-tile');
            const slot = tile?.dataset?.slot;
            // Front camera is typically in slot 'tc' (top center)
            if (slot === 'tc') {
                frontW = vid.videoWidth;
                frontH = vid.videoHeight;
            } else if (baseW === 1448) {
                // First non-front camera found
                baseW = vid.videoWidth;
                baseH = vid.videoHeight;
            }
        }
    }
    // If no non-front video found, check main video
    const mainVid = document.getElementById('videoMain');
    if (baseW === 1448 && mainVid?.videoWidth > 0) {
        baseW = mainVid.videoWidth;
        baseH = mainVid.videoHeight;
        frontW = baseW;
        frontH = baseH;
    }

    const frontMatchesSides = (frontW === baseW && frontH === baseH);
    // Only show front camera warning when front is actually larger than other cameras
    if (warningEl) warningEl.classList.toggle('hidden', !hasFrontAndOthers || frontMatchesSides);

    let cols, rows;
    if (cameraCount <= 1) { cols = 1; rows = 1; }
    else if (cameraCount === 2) { cols = 2; rows = 1; }
    else if (cameraCount === 3) { cols = 3; rows = 1; }
    else if (cameraCount === 4) { cols = 2; rows = 2; }
    else { cols = 3; rows = 2; }

    const quality = document.querySelector('input[name="exportQuality"]:checked')?.value || 'high';
    const makeEven = (n) => Math.round(n) + (Math.round(n) % 2);
    let perCam;
    if (isFrontOnly) {
        perCam = {
            mobile: [makeEven(frontW * 0.25), makeEven(frontH * 0.25)],
            medium: [makeEven(frontW * 0.5), makeEven(frontH * 0.5)],
            high: [makeEven(frontW * 0.75), makeEven(frontH * 0.75)],
            max: [makeEven(frontW), makeEven(frontH)]
        }[quality] || [makeEven(frontW * 0.5), makeEven(frontH * 0.5)];
    } else {
        perCam = {
            mobile: [makeEven(baseW * 0.33), makeEven(baseH * 0.33)],
            medium: [makeEven(baseW * 0.5), makeEven(baseH * 0.5)],
            high: [makeEven(baseW * 0.75), makeEven(baseH * 0.75)],
            max: [makeEven(baseW), makeEven(baseH)]
        }[quality] || [makeEven(baseW * 0.75), makeEven(baseH * 0.75)];
    }

    const gridW = perCam[0] * cols;
    const gridH = perCam[1] * rows;

    // Show warning for Maximum quality (exceeds GPU encoder limits)
    const maxQualityWarningEl = $('maxQualityWarning');
    if (maxQualityWarningEl) {
        const isMaxQuality = quality === 'max';
        maxQualityWarningEl.classList.toggle('hidden', !isMaxQuality);
    }
    const pixels = gridW * gridH;
    const mbPerMin = pixels * 0.000018;
    const estimatedMB = Math.round(durationMin * mbPerMin);
    const estimatedGB = (estimatedMB / 1024).toFixed(1);

    let sizeText = estimatedMB > 1024 ? `~${estimatedGB} GB` : `~${estimatedMB} MB`;
    estimateEl.textContent = `${t('ui.export.output')}: ${gridW}×${gridH} • ${sizeText}`;
}

/**
 * Check if FFmpeg is available
 */
export async function checkFFmpegAvailability() {
    const statusEl = $('ffmpegStatus');
    const startBtn = $('startExportBtn');
    const dashboardCheckbox = $('includeDashboard');
    const dashboardOptions = $('dashboardOptions');
    const dashboardGpuWarning = $('dashboardGpuWarning');
    const dashboardToggleRow = dashboardCheckbox?.closest('.toggle-row');
    const timestampCheckbox = $('includeTimestamp');
    const timestampOptions = $('timestampOptions');
    const timestampToggleRow = timestampCheckbox?.closest('.toggle-row');

    // Set up dashboard checkbox toggle for options visibility
    if (dashboardCheckbox && dashboardOptions) {
        dashboardCheckbox.addEventListener('change', () => {
            if (dashboardCheckbox.checked) {
                dashboardOptions.classList.remove('hidden');
                // Dashboard includes timestamp, so disable timestamp-only option
                if (timestampCheckbox) {
                    timestampCheckbox.checked = false;
                    timestampCheckbox.disabled = true;
                    if (timestampToggleRow) timestampToggleRow.classList.add('disabled');
                    if (timestampOptions) timestampOptions.classList.add('hidden');
                }
            } else {
                dashboardOptions.classList.add('hidden');
                // Re-enable timestamp option when dashboard is disabled
                if (timestampCheckbox) {
                    timestampCheckbox.disabled = false;
                    if (timestampToggleRow) timestampToggleRow.classList.remove('disabled');
                }
            }
        });
    }

    // Set up timestamp checkbox toggle for options visibility
    if (timestampCheckbox && timestampOptions) {
        timestampCheckbox.addEventListener('change', () => {
            if (timestampCheckbox.checked) {
                timestampOptions.classList.remove('hidden');
            } else {
                timestampOptions.classList.add('hidden');
            }
        });
    }

    if (!statusEl) return;

    statusEl.innerHTML = `<span class="status-icon">⏳</span><span class="status-text">${t('ui.export.checkingFfmpeg')}</span>`;

    try {
        if (window.electronAPI?.checkFFmpeg) {
            const result = await window.electronAPI.checkFFmpeg();
            exportState.ffmpegAvailable = result.available;
            exportState.gpuAvailable = !!result.gpu;
            exportState.gpuName = result.gpu?.name || null;
            exportState.hevcAvailable = !!result.hevc;
            exportState.hevcName = result.hevc?.name || null;

            if (result.available) {
                // Build status text with GPU info
                let statusText = t('ui.export.ffmpegReady');
                if (result.gpu) {
                    statusText += ` • GPU: ${result.gpu.name}`;
                    if (result.hevc) {
                        statusText += ` + HEVC`;
                    }
                } else {
                    statusText += ` • ${t('ui.export.cpuOnly')}`;
                }
                if (result.fakeNoGpu) {
                    statusText += ' [DEV: Fake No GPU]';
                }

                statusEl.innerHTML = `<span class="status-icon" style="color: #4caf50;">✓</span><span class="status-text">${statusText}</span>`;
                if (startBtn) startBtn.disabled = false;

                // Dashboard overlay requires GPU - show warning if no GPU
                if (!result.gpu && dashboardGpuWarning) {
                    dashboardGpuWarning.classList.remove('hidden');
                } else if (dashboardGpuWarning) {
                    dashboardGpuWarning.classList.add('hidden');
                }

            } else {
                const isMac = navigator.platform.toLowerCase().includes('mac');
                if (isMac) {
                    statusEl.innerHTML = `<span class="status-icon" style="color: #f44336;">✗</span><span class="status-text">${t('ui.export.ffmpegRequiredMac')}</span>`;
                } else {
                    statusEl.innerHTML = `<span class="status-icon" style="color: #f44336;">✗</span><span class="status-text">${t('ui.export.ffmpegRequiredWin')}</span>`;
                }
                if (startBtn) startBtn.disabled = true;
                if (dashboardCheckbox) {
                    dashboardCheckbox.disabled = true;
                    dashboardCheckbox.checked = false;
                }
            }
        } else {
            statusEl.innerHTML = `<span class="status-icon" style="color: #ff9800;">⚠</span><span class="status-text">${t('ui.export.notAvailable')}</span>`;
            if (startBtn) startBtn.disabled = true;
            if (dashboardCheckbox) {
                dashboardCheckbox.disabled = true;
                dashboardCheckbox.checked = false;
            }
        }
    } catch (err) {
        statusEl.innerHTML = `<span class="status-icon" style="color: #f44336;">✗</span><span class="status-text">${t('ui.export.ffmpegError')}</span>`;
        if (startBtn) startBtn.disabled = true;
    }
}

/**
 * Start the export process
 */
export async function startExport() {
    // Guard against duplicate exports (e.g. user clicks while SEI extraction is in progress)
    if (exportState.isExporting) {
        notify(t('ui.notifications.exportAlreadyInProgress') || 'Export already in progress', { type: 'warn' });
        return;
    }

    const state = getState?.();
    const nativeVideo = getNativeVideo?.();
    const baseFolderPath = getBaseFolderPath?.();

    if (!state?.collection?.active || !window.electronAPI?.startExport) {
        notify(t('ui.notifications.exportNotAvailable'), { type: 'error' });
        return;
    }

    if (!baseFolderPath) {
        notify(t('ui.notifications.exportRequiresFolder'), { type: 'warn' });
        return;
    }

    const cameraCheckboxes = document.querySelectorAll('.option-card input[data-camera]:checked');
    const cameras = Array.from(cameraCheckboxes).map(cb => cb.dataset.camera);

    if (cameras.length === 0) {
        notify(t('ui.notifications.selectAtLeastOneCamera'), { type: 'warn' });
        return;
    }

    // Get layout data from Layout Lab
    let layoutData = null;
    try {
        const layoutLab = await import('../ui/layoutLab.js');
        layoutData = layoutLab.getLayoutData();
    } catch (err) {
        console.error('Failed to get layout data:', err);
    }

    // Use the default filename generated when modal opened
    let filename = exportState.defaultFilename || `tesla_export_${new Date().toISOString().slice(0, 10)}.mp4`;

    const qualityInput = document.querySelector('input[name="exportQuality"]:checked');
    const quality = qualityInput?.value || 'high';

    // Track quality for share restriction enforcement
    exportState.lastExportQuality = quality;

    // Persist blur zones and quality for next export session
    try {
        if (window.electronAPI?.setSetting) {
            if (exportState.blurZones.length > 0) {
                await window.electronAPI.setSetting('exportLastBlurZones', exportState.blurZones);
            }
            await window.electronAPI.setSetting('exportLastQuality', quality);
        }
    } catch (e) { /* ignore save errors */ }

    const hasBlurZones = exportState.blurZones.length > 0;
    const blurType = 'trueBlur';
    const includeDashboardCheckbox = $('includeDashboard');
    let includeDashboard = includeDashboardCheckbox?.checked ?? false;

    // Check for blur zones on unselected cameras and warn user
    if (hasBlurZones) {
        const blurCameras = [...new Set(exportState.blurZones.map(z => z.camera))];
        const unselectedBlurCameras = blurCameras.filter(c => !cameras.includes(c));
        if (unselectedBlurCameras.length > 0) {
            const cameraNames = { front: t('ui.cameras.front'), back: t('ui.cameras.back'), left_repeater: t('ui.cameras.leftRepeater'), right_repeater: t('ui.cameras.rightRepeater'), left_pillar: t('ui.cameras.leftPillar'), right_pillar: t('ui.cameras.rightPillar') };
            const names = unselectedBlurCameras.map(c => cameraNames[c] || c).join(', ');
            notify(t('ui.export.blurZonesWarning', { cameras: names }), { type: 'warn' });
        }
    }

    const dashboardStyle = $('dashboardStyle')?.value || 'standard';
    const dashboardPosition = dashboardStyle === 'tesla-mobile'
        ? ($('dashboardPositionTeslaMobile')?.value || 'bottom-center')
        : ($('dashboardPosition')?.value || 'bottom-center');
    const dashboardSize = $('dashboardSize')?.value || 'medium';

    // Minimap settings
    const includeMinimapCheckbox = $('includeMinimap');
    const includeMinimap = includeMinimapCheckbox?.checked ?? false;
    const minimapPosition = $('minimapPosition')?.value || 'top-right';
    const minimapSize = $('minimapSize')?.value || 'small';
    const minimapRenderMode = $('minimapRenderMode')?.value || 'ass'; // 'ass' or 'leaflet'
    const minimapDarkMode = window._mapDarkMode === true;

    console.log(`[MINIMAP] UI state: checkbox=${includeMinimapCheckbox?.checked}, includeMinimap=${includeMinimap}`);
    console.log(`[MINIMAP] Position=${minimapPosition}, Size=${minimapSize}, RenderMode=${minimapRenderMode}`);

    const includeTimestampCheckbox = $('includeTimestamp');
    const includeTimestamp = includeTimestampCheckbox?.checked ?? false;
    const timestampPosition = $('timestampPosition')?.value || 'bottom-center';
    const timestampDateFormat = window._dateFormat || 'ymd'; // Use global date format setting
    const timestampTimeFormat = window._timeFormat || '12h'; // Use global time format setting (12h/24h)

    // Timelapse settings
    const enableTimelapseCheckbox = $('enableTimelapse');
    const enableTimelapse = enableTimelapseCheckbox?.checked ?? false;
    const timelapseSpeed = parseFloat($('timelapseSpeed')?.value) || 8;

    const totalSec = nativeVideo?.cumulativeStarts?.[nativeVideo.cumulativeStarts.length - 1] || 60;
    const startPct = exportState.startMarkerPct ?? 0;
    const endPct = exportState.endMarkerPct ?? 100;

    const startTimeMs = (Math.min(startPct, endPct) / 100) * totalSec * 1000;
    const endTimeMs = (Math.max(startPct, endPct) / 100) * totalSec * 1000;

    // Calculate filename from the clip's actual start time (accounting for trim markers)
    const exportGroups = state.collection.active?.groups || [];
    const firstTsKey = exportGroups[0]?.timestampKey || '';
    const firstEpochMs = parseTimestampKeyToEpochMs(firstTsKey);
    if (firstEpochMs) {
        const clipStartDate = new Date(firstEpochMs + startTimeMs);
        const y = clipStartDate.getFullYear();
        const mo = String(clipStartDate.getMonth() + 1).padStart(2, '0');
        const d = String(clipStartDate.getDate()).padStart(2, '0');
        const h = String(clipStartDate.getHours()).padStart(2, '0');
        const mi = String(clipStartDate.getMinutes()).padStart(2, '0');
        const dateTime = `${y}-${mo}-${d}_${h}-${mi}`;
        const safeName = exportState.safeName || 'export';
        filename = `tesla_${safeName}_${dateTime}.mp4`;
    }

    // Open file dialog FIRST for instant response, before any heavy processing
    const lastExportFolder = await window.electronAPI.getSetting('lastExportFolder');
    const defaultPath = lastExportFolder ? `${lastExportFolder}/${filename}` : filename;
    const outputPath = await window.electronAPI.saveFile({
        title: 'Save Tesla Export',
        defaultPath: defaultPath
    });

    if (!outputPath) {
        notify(t('ui.notifications.exportCancelled'), { type: 'info' });
        return;
    }

    // Remember the export folder for next time
    const exportDir = outputPath.replace(/[/\\][^/\\]*$/, '');
    if (exportDir) window.electronAPI.setSetting('lastExportFolder', exportDir);

    // Lock export state and disable button BEFORE SEI extraction to prevent duplicate exports
    // This is critical for NAS/network files where SEI extraction can take minutes
    const startBtn = $('startExportBtn');
    const progressEl = $('exportProgress');
    const exportProgressBar = $('exportProgressBar');
    const progressText = $('exportProgressText');

    exportState.isExporting = true;
    if (startBtn) startBtn.disabled = true;

    // Switch close button to minimize icon during export
    const closeBtn = $('closeExportModal');
    if (closeBtn) {
        closeBtn.innerHTML = '&minus;';
        closeBtn.title = t('ui.supportChat.minimize') || 'Minimize';
    }

    // Only extract SEI data if dashboard or minimap is enabled - skip entirely if both disabled to save RAM
    // Extract SEI data one segment at a time to avoid loading all files into memory simultaneously
    // This happens AFTER file dialog so user gets instant feedback
    let seiData = null;
    let mapPath = []; // GPS path for minimap

    if (includeDashboard || includeMinimap) {
        try {
            // Show persistent progress bar during SEI extraction (not just a toast)
            if (progressEl) progressEl.classList.remove('hidden');
            if (exportProgressBar) exportProgressBar.style.width = '0%';
            if (progressText) progressText.textContent = t('ui.notifications.extractingTelemetry') || 'Extracting telemetry data...';

            const cumStarts = nativeVideo?.cumulativeStarts || [];
            const groups = state.collection.active.groups || [];
            const allSeiData = [];
            const allMapPath = []; // Collect GPS coordinates

            if (!window.DashcamMP4 || !window.DashcamHelpers) {
                throw new Error('Dashcam parser not available');
            }

            const DashcamMP4 = window.DashcamMP4;
            const { SeiMetadata } = await window.DashcamHelpers.initProtobuf();

            // Helper to check for valid GPS coordinates
            // SEI uses latitude_deg/longitude_deg field names
            const hasValidGps = (sei) => {
                const lat = sei?.latitude_deg;
                const lon = sei?.longitude_deg;
                return lat !== undefined && lon !== undefined &&
                    Number.isFinite(lat) && Number.isFinite(lon) &&
                    !(Math.abs(lat) < 0.001 && Math.abs(lon) < 0.001);
            };

            // Count segments in range so we can show accurate progress
            const segmentsInRange = [];
            for (let i = 0; i < groups.length; i++) {
                const segStartMs = (cumStarts[i] || 0) * 1000;
                const segDurationMs = (nativeVideo?.segmentDurations?.[i] || 60) * 1000;
                const segEndMs = segStartMs + segDurationMs;
                if (segEndMs > startTimeMs && segStartMs < endTimeMs) {
                    segmentsInRange.push(i);
                }
            }
            const totalSegsToProcess = segmentsInRange.length;

            // Extract SEI data one segment at a time to minimize RAM usage
            for (let i = 0; i < groups.length; i++) {
                // Check for cancellation before processing each segment
                if (exportState.cancelled) {
                    console.log('SEI extraction cancelled by user');
                    seiData = null;
                    mapPath = [];
                    break;
                }

                const group = groups[i];
                const segStartMs = (cumStarts[i] || 0) * 1000;
                const segDurationMs = (nativeVideo?.segmentDurations?.[i] || 60) * 1000;
                const segEndMs = segStartMs + segDurationMs;

                if (segEndMs > startTimeMs && segStartMs < endTimeMs) {
                    // Update progress bar for SEI extraction
                    const segIdx = segmentsInRange.indexOf(i);
                    const seiPct = totalSegsToProcess > 0 ? Math.round(((segIdx + 1) / totalSegsToProcess) * 100) : 0;
                    if (exportProgressBar) exportProgressBar.style.width = `${seiPct}%`;
                    if (progressText) progressText.textContent = `${t('ui.notifications.extractingTelemetry') || 'Extracting telemetry data...'} (${segIdx + 1}/${totalSegsToProcess})`;

                    // Prefer front camera for SEI extraction, fallback to any available camera
                    let entry = group.filesByCamera?.get('front');
                    if (!entry) {
                        const firstCamera = group.filesByCamera?.keys().next().value;
                        entry = firstCamera ? group.filesByCamera?.get(firstCamera) : null;
                    }

                    if (entry?.file) {
                        try {
                            let buffer = null;

                            // Load file into buffer (one at a time)
                            if (entry.file?.isElectronFile && entry.file?.path) {
                                const fileUrl = filePathToUrl(entry.file.path);
                                const response = await fetch(fileUrl);
                                buffer = await response.arrayBuffer();
                            } else if (entry.file instanceof File) {
                                buffer = await entry.file.arrayBuffer();
                            } else if (entry.file.path) {
                                const fileUrl = filePathToUrl(entry.file.path);
                                const response = await fetch(fileUrl);
                                buffer = await response.arrayBuffer();
                            }

                            if (buffer) {
                                // Extract SEI data from this segment
                                const mp4 = new DashcamMP4(buffer);
                                const frames = mp4.parseFrames(SeiMetadata);

                                // Convert segment-relative timestamps to absolute time
                                for (const frame of frames) {
                                    if (frame.sei) {
                                        allSeiData.push({
                                            timestampMs: segStartMs + frame.timestamp,
                                            sei: frame.sei
                                        });

                                        // Extract GPS coordinates for minimap path
                                        if (includeMinimap && hasValidGps(frame.sei)) {
                                            allMapPath.push([frame.sei.latitude_deg, frame.sei.longitude_deg]);
                                        }
                                    }
                                }

                                // Explicitly clear buffer reference to help GC
                                buffer = null;
                            }
                        } catch (err) {
                            console.warn(`Failed to extract SEI from segment ${i}:`, err);
                            // Continue with other segments
                        }
                    }
                }
            }

            // Sort by timestamp for efficient lookup during rendering
            allSeiData.sort((a, b) => a.timestampMs - b.timestampMs);

            console.log(`[MINIMAP] SEI extraction complete: ${allSeiData.length} SEI frames, ${allMapPath.length} GPS points`);

            if (allSeiData.length > 0) {
                seiData = allSeiData;
                mapPath = allMapPath;
                console.log(`[MINIMAP] GPS data available: ${mapPath.length} points`);
            } else {
                if (includeDashboard) {
                    notify(t('ui.notifications.noTelemetryData'), { type: 'warn' });
                }
                if (includeMinimap && allMapPath.length === 0) {
                    notify(t('ui.export.minimapNoGpsDisabled'), { type: 'warn' });
                }
                seiData = null;
                mapPath = [];
            }
        } catch (err) {
            if (includeDashboard) {
                notify(t('ui.notifications.failedToExtractTelemetry'), { type: 'warn' });
            }
            if (includeMinimap) {
                notify(t('ui.export.minimapGpsExtractFailed'), { type: 'warn' });
            }
            seiData = null;
            mapPath = [];
        }

        // Reset progress bar after SEI extraction before FFmpeg phase
        if (exportProgressBar) exportProgressBar.style.width = '0%';
        if (progressText) progressText.textContent = t('ui.export.preparing') || 'Preparing...';
    }
    // If dashboard and minimap are both disabled, seiData remains null and no files are loaded into memory

    const segments = [];
    const groups2 = state.collection.active.groups || [];
    const cumStarts2 = nativeVideo?.cumulativeStarts || [];

    for (let i = 0; i < groups2.length; i++) {
        const group = groups2[i];
        const durationSec = nativeVideo?.segmentDurations?.[i] || 60;

        const files = {};
        for (const camera of cameras) {
            const entry = group.filesByCamera?.get(camera);
            if (entry?.file) {
                if (entry.file.path) {
                    files[camera] = entry.file.path;
                } else if (entry.file.webkitRelativePath && baseFolderPath) {
                    const relativePath = entry.file.webkitRelativePath;
                    const pathParts = relativePath.split('/');
                    const subPath = pathParts.slice(1).join('/');
                    files[camera] = baseFolderPath + '/' + subPath;
                }
            }
        }

        // Parse timestamp from group's timestampKey for ASS dashboard overlay
        const timestamp = parseTimestampKeyToEpochMs(group.timestampKey) || null;

        segments.push({
            index: i,
            durationSec,
            startSec: cumStarts2[i] || 0,
            files,
            groupId: group.id,
            timestamp // Epoch ms for this segment's start time (UTC)
        });
    }

    const hasFiles = segments.some(seg => Object.keys(seg.files).length > 0);
    if (!hasFiles) {
        notify(t('ui.notifications.noVideoFilesForExport'), { type: 'error' });
        exportState.isExporting = false;
        resetCloseButton();
        if (startBtn) startBtn.disabled = false;
        if (progressEl) progressEl.classList.add('hidden');
        return;
    }

    if (progressEl) progressEl.classList.remove('hidden');
    if (exportProgressBar) exportProgressBar.style.width = '0%';
    if (progressText) progressText.textContent = t('ui.export.preparing');

    // Show hint during export
    const minimizeHint = $('exportMinimizeHint');
    if (minimizeHint) minimizeHint.classList.remove('hidden');

    const exportId = `export_${Date.now()}`;
    exportState.currentExportId = exportId;

    // Get dashboard and minimap progress elements
    const dashboardProgressEl = $('dashboardProgress');
    const dashboardProgressBar = $('dashboardProgressBar');
    const dashboardProgressText = $('dashboardProgressText');
    const minimapProgressEl = $('minimapProgress');
    const minimapProgressBar = $('minimapProgressBar');
    const minimapProgressText = $('minimapProgressText');

    // Hide dashboard and minimap progress bars initially
    if (dashboardProgressEl) dashboardProgressEl.classList.add('hidden');
    if (minimapProgressEl) minimapProgressEl.classList.add('hidden');

    if (window.electronAPI?.on) {
        // Remove any stale listeners from previous exports to prevent ghost handlers
        window.electronAPI.removeAllListeners?.('export:progress');
        window.electronAPI.on('export:progress', (receivedExportId, progress) => {
            if (receivedExportId !== exportId) return;

            if (progress.type === 'progress') {
                const translatedMessage = translateMessage(progress.message);
                if (exportProgressBar) exportProgressBar.style.width = `${progress.percentage}%`;
                if (progressText) progressText.textContent = translatedMessage;

                // Track progress for floating notification
                exportState.currentStep = translatedMessage;
                exportState.currentProgress = progress.percentage;

                // Update floating notification if modal is minimized
                if (exportState.modalMinimized) {
                    updateFloatingProgress(translatedMessage, progress.percentage);
                }
            } else if (progress.type === 'dashboard-progress') {
                // Show dashboard progress bar
                // Ensure main progress is also visible to keep container from hiding
                if (progressEl) progressEl.classList.remove('hidden');
                if (dashboardProgressEl) dashboardProgressEl.classList.remove('hidden');
                if (dashboardProgressBar) dashboardProgressBar.style.width = `${progress.percentage}%`;
                if (dashboardProgressText) dashboardProgressText.textContent = progress.message;

                if (exportState.modalMinimized) {
                    updateFloatingProgress(progress.message, progress.percentage);
                }
            } else if (progress.type === 'minimap-progress') {
                // Show minimap progress bar
                // Ensure main progress is also visible to keep container from hiding
                if (progressEl) progressEl.classList.remove('hidden');
                if (minimapProgressEl) minimapProgressEl.classList.remove('hidden');
                if (minimapProgressBar) minimapProgressBar.style.width = `${progress.percentage}%`;
                if (minimapProgressText) minimapProgressText.textContent = progress.message;

                if (exportState.modalMinimized) {
                    updateFloatingProgress(progress.message, progress.percentage);
                }
            } else if (progress.type === 'complete') {
                exportState.isExporting = false;
                exportState.currentExportId = null;
                exportState.cancelled = false;
                exportState.modalMinimized = false;
                exportState.currentStep = '';
                exportState.currentProgress = 0;

                // Hide floating notification on complete
                hideFloatingProgress();
                resetCloseButton();

                // Hide hint and overlay progress bars
                const minHint = $('exportMinimizeHint');
                if (minHint) minHint.classList.add('hidden');
                if (dashboardProgressEl) dashboardProgressEl.classList.add('hidden');
                if (minimapProgressEl) minimapProgressEl.classList.add('hidden');

                const translatedMessage = translateMessage(progress.message);

                if (progress.success) {
                    if (exportProgressBar) exportProgressBar.style.width = '100%';
                    if (progressText) progressText.textContent = translatedMessage;
                    notify(translatedMessage, { type: 'success' });

                    // Show blur zone failure warning if applicable
                    if (progress.warning) {
                        const warningMessage = translateMessage(progress.warning);
                        notify(warningMessage, { type: 'error' });
                    }

                    // Show modal if it was minimized so user sees completion
                    const modal = $('exportModal');
                    if (modal?.classList.contains('hidden')) {
                        modal.classList.remove('hidden');
                    }

                    // Show completion panel instead of confirm dialog
                    showExportCompletePanel(outputPath, translatedMessage);
                } else {
                    if (progressText) progressText.textContent = translatedMessage;
                    notify(translatedMessage, { type: 'error' });
                    if (startBtn) startBtn.disabled = false;

                    // Show modal on error so user sees what happened
                    const modal = $('exportModal');
                    if (modal?.classList.contains('hidden')) {
                        modal.classList.remove('hidden');
                    }
                }
            }
        });
    }

    // Check for cancellation after SEI extraction but before starting export
    if (exportState.cancelled) {
        console.log('Export cancelled before starting FFmpeg');
        exportState.isExporting = false;
        exportState.currentExportId = null;
        resetCloseButton();
        if (startBtn) startBtn.disabled = false;
        return;
    }

    try {
        const exportData = {
            segments,
            startTimeMs,
            endTimeMs,
            outputPath,
            cameras,
            baseFolderPath,
            quality,
            // Only include dashboard if checkbox was checked AND we successfully extracted SEI data
            includeDashboard: includeDashboard && seiData !== null && seiData.length > 0,
            seiData: seiData || [], // Empty array if dashboard disabled - no RAM used
            layoutData: layoutData || null,
            useMetric: getUseMetric?.() ?? false, // Pass metric setting for dashboard overlay
            glassBlur: parseInt(document.documentElement.style.getPropertyValue('--glass-blur') || '7', 10), // Glass blur setting
            dashboardStyle, // Style: standard (full layout) or compact (streamlined)
            dashboardPosition, // Position: bottom-center, bottom-left, bottom-right, top-center, etc.
            dashboardSize, // Size: small (20%), medium (30%), large (40%)
            accelPedMode: window._accelPedMode || 'iconbar', // Accelerator pedal display mode: solid, iconbar, sidebar
            // Timestamp-only option (independent of dashboard, uses simple drawtext filter)
            includeTimestamp: includeTimestamp && !includeDashboard, // Only if dashboard is not enabled
            timestampPosition, // Position: bottom-center, bottom-left, etc.
            timestampDateFormat, // Date format: mdy (US), dmy (International), ymd (ISO)
            timestampTimeFormat, // Time format: 12h (AM/PM), 24h
            // Blur zone data - filter to only selected cameras, send all zones
            blurZones: exportState.blurZones.filter(z => cameras.includes(z.camera)),
            blurType: 'trueBlur',
            // Language for dashboard text translations (Gear, Autopilot states, etc.)
            language: getCurrentLanguage(),
            // Mirror cameras setting (back and repeaters)
            mirrorCameras: window._mirrorCameras !== false,
            // Minimap settings
            includeMinimap: includeMinimap && mapPath.length > 0,
            minimapPosition,
            minimapSize,
            minimapRenderMode, // 'ass' (fast, vector) or 'leaflet' (slow, map tiles)
            minimapDarkMode, // Dark mode CSS filter for map tiles
            mapPath,
            // Time-lapse settings
            enableTimelapse,
            timelapseSpeed // Speed multiplier (0.5, 2, 4, 8, 16, 32, 64)
        };

        console.log(`[MINIMAP] Export data: includeMinimap=${exportData.includeMinimap}, mapPath.length=${mapPath.length}, position=${minimapPosition}, size=${minimapSize}, renderMode=${minimapRenderMode}`);

        await window.electronAPI.startExport(exportId, exportData);
    } catch (err) {
        console.error('Export error:', err);
        notify(t('ui.notifications.exportFailedWithError', { error: err.message }), { type: 'error' });
        exportState.isExporting = false;
        exportState.currentExportId = null;
        exportState.cancelled = false; // Reset cancellation flag
        resetCloseButton();
        if (startBtn) startBtn.disabled = false;
    }
}

/**
 * Show confirmation modal before canceling an active export.
 * If not currently exporting, cancels immediately without confirmation.
 */
export function confirmCancelExport() {
    if (!exportState.isExporting) {
        cancelExport();
        return;
    }
    const modal = $('cancelExportConfirmModal');
    if (modal) modal.classList.remove('hidden');
}

/**
 * Cancel an ongoing export
 */
export async function cancelExport() {
    // Set cancellation flag immediately so SEI extraction loop can check it
    exportState.cancelled = true;

    if (exportState.currentExportId && window.electronAPI?.cancelExport) {
        await window.electronAPI.cancelExport(exportState.currentExportId);
        notify(t('ui.notifications.exportCancelled'), { type: 'info' });
    }

    exportState.isExporting = false;
    exportState.currentExportId = null;
    exportState.cancelled = false;
    exportState.modalMinimized = false;
    exportState.currentStep = '';
    exportState.currentProgress = 0;

    // Hide floating progress if visible
    hideFloatingProgress();
    resetCloseButton();

    // Hide hint
    const minimizeHint = $('exportMinimizeHint');
    if (minimizeHint) minimizeHint.classList.add('hidden');

    const progressEl = $('exportProgress');
    const startBtn = $('startExportBtn');

    if (progressEl) progressEl.classList.add('hidden');
    if (startBtn) startBtn.disabled = false;

    // Restore modal body/footer if completion panel was showing
    const completePanel = $('exportCompletePanel');
    if (completePanel && !completePanel.classList.contains('hidden')) {
        completePanel.classList.add('hidden');
        const modal2 = $('exportModal');
        const modalBody = modal2?.querySelector('.modal-body');
        const modalFooter = modal2?.querySelector('.modal-footer');
        if (modalBody) modalBody.classList.remove('hidden');
        if (modalFooter) modalFooter.classList.remove('hidden');
    }

    // Clean up share progress listener
    window.electronAPI?.removeAllListeners?.('share:progress');

    // Close modal completely when cancelled
    const modal = $('exportModal');
    if (modal) modal.classList.add('hidden');
}

/**
 * Initialize the share clip toggle based on export duration
 */
function initShareClipToggle() {
    const shareToggle = $('shareClipToggle');
    const shareToggleRow = $('shareClipToggleRow');
    const shareWarning = $('shareClipWarning');
    const shareInfo = $('shareClipInfo');
    const durationRow = $('shareClipDurationRow');
    const durationSelect = $('shareClipDuration');

    if (!shareToggle) return;

    const nativeVideo = getNativeVideo?.();
    const totalSec = nativeVideo?.cumulativeStarts?.[nativeVideo.cumulativeStarts.length - 1] || 60;
    const startPct = exportState.startMarkerPct ?? 0;
    const endPct = exportState.endMarkerPct ?? 100;
    const rawDurationSec = Math.abs((endPct - startPct) / 100 * totalSec);
    const maxDurationSec = 10 * 60; // 10 minutes

    // If timelapse is enabled, use effective output duration (raw / speed)
    const timelapseEnabled = $('enableTimelapse')?.checked ?? false;
    const timelapseSpeed = timelapseEnabled ? (parseFloat($('timelapseSpeed')?.value) || 8) : 1;
    const effectiveDurationSec = rawDurationSec / timelapseSpeed;

    if (effectiveDurationSec > maxDurationSec) {
        // Export too long for sharing
        shareToggle.checked = false;
        shareToggle.disabled = true;
        if (shareToggleRow) shareToggleRow.classList.add('disabled');
        if (shareWarning) shareWarning.classList.remove('hidden');
        if (shareInfo) shareInfo.classList.add('hidden');
        if (durationRow) durationRow.style.display = 'none';
    } else {
        shareToggle.disabled = false;
        if (shareToggleRow) shareToggleRow.classList.remove('disabled');
        if (shareWarning) shareWarning.classList.add('hidden');
        const isChecked = shareToggle.checked;
        if (shareInfo) shareInfo.classList.toggle('hidden', !isChecked);
        if (durationRow) durationRow.style.display = isChecked ? '' : 'none';
    }

    // Apply max quality restriction based on current toggle state
    updateMaxQualityForSharing(shareToggle.checked);

    // Update toggle state when share is toggled
    shareToggle.onchange = () => {
        const checked = shareToggle.checked;
        if (shareInfo) shareInfo.classList.toggle('hidden', !checked);
        if (durationRow) durationRow.style.display = checked ? '' : 'none';
        updateMaxQualityForSharing(checked);
        updateShareExpirationDisplay();
    };

    // Update info text when duration changes
    if (durationSelect) {
        durationSelect.onchange = () => updateShareExpirationDisplay();
    }
}

/**
 * Disable or enable the Maximum quality option based on share clip state.
 * If Maximum was selected when sharing is enabled, switch to High.
 */
function updateMaxQualityForSharing(sharingEnabled) {
    const maxRadio = document.querySelector('input[name="exportQuality"][value="max"]');
    if (!maxRadio) return;

    const maxCard = maxRadio.closest('.option-card');

    if (sharingEnabled) {
        // If max is currently selected, switch to high
        if (maxRadio.checked) {
            const highRadio = document.querySelector('input[name="exportQuality"][value="high"]');
            if (highRadio) {
                highRadio.checked = true;
            }
        }
        maxRadio.disabled = true;
        if (maxCard) maxCard.classList.add('disabled');
    } else {
        maxRadio.disabled = false;
        if (maxCard) maxCard.classList.remove('disabled');
    }

    // Refresh size estimate to reflect any quality change
    updateExportSizeEstimate();
}

/**
 * Show the export completion panel (replaces native confirm dialog)
 */
export function showExportCompletePanel(outputPath, message) {
    const completePanel = $('exportCompletePanel');
    const modalBody = completePanel?.closest('.modal-content')?.querySelector('.modal-body');
    const modalFooter = completePanel?.closest('.modal-content')?.querySelector('.modal-footer');
    const completeTitleEl = $('exportCompleteTitle');
    const completeMessageEl = $('exportCompleteMessage');
    const doneBtn = $('exportDoneBtn');
    const openFolderBtn = $('exportOpenFolderBtn');
    const shareBtn = $('exportShareBtn');
    const shareUploadProgress = $('shareUploadProgress');
    const shareLinkResult = $('shareLinkResult');
    const shareError = $('shareError');

    if (!completePanel) return;

    // Re-enable the simple modal body if an AE-driven export had locked it.
    // No-op for regular (simple-modal-driven) exports.
    setSimpleModalAeMode(false);

    // Get file size for display
    const fileSizeText = message || 'Export completed successfully';

    // Set completion text
    if (completeTitleEl) completeTitleEl.textContent = 'Export Complete!';
    if (completeMessageEl) completeMessageEl.textContent = fileSizeText;

    // Reset share UI
    if (shareUploadProgress) shareUploadProgress.classList.add('hidden');
    if (shareLinkResult) shareLinkResult.classList.add('hidden');
    if (shareError) shareError.classList.add('hidden');

    // Load video preview of exported clip
    const previewContainer = $('exportPreviewContainer');
    const previewVideo = $('exportPreviewVideo');
    if (previewContainer && previewVideo) {
        try {
            previewVideo.src = filePathToUrl(outputPath);
            previewContainer.classList.remove('hidden');
        } catch (e) {
            console.warn('[EXPORT] Failed to load preview:', e);
            previewContainer.classList.add('hidden');
        }
    }

    // Hide modal body and footer, show completion panel
    if (modalBody) modalBody.classList.add('hidden');
    if (modalFooter) modalFooter.classList.add('hidden');
    completePanel.classList.remove('hidden');

    // Check if share was pre-selected
    const shareToggle = $('shareClipToggle');
    const wasShareSelected = shareToggle?.checked && !shareToggle?.disabled;

    // Block sharing if exported at maximum quality (prevents bypass of quality restriction
    // by rendering at max quality with share toggle off, then sharing post-export)
    const wasMaxQuality = exportState.lastExportQuality === 'max';

    // Show share button unless max quality was used
    // If share was pre-selected, label it "Confirm & Upload" so user can preview first
    if (shareBtn) {
        shareBtn.disabled = false; // Reset from any previous export/upload
        shareBtn.style.opacity = '';
        shareBtn.style.cursor = '';
        shareBtn.classList.remove('hidden');
        shareBtn.classList.toggle('hidden', wasMaxQuality);
        // Update button label — find the text node after the SVG
        const textNodes = [...shareBtn.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim());
        const label = wasShareSelected && !wasMaxQuality ? 'Confirm & Upload' : 'Share Clip';
        if (textNodes.length > 0) {
            textNodes[textNodes.length - 1].textContent = `\n                        ${label}\n                    `;
        }
    }

    // Wire up button handlers
    if (doneBtn) {
        doneBtn.onclick = () => {
            // Release preview video resource
            if (previewVideo) {
                previewVideo.pause();
                previewVideo.removeAttribute('src');
                previewVideo.load();
            }
            if (previewContainer) previewContainer.classList.add('hidden');
            completePanel.classList.add('hidden');
            if (modalBody) modalBody.classList.remove('hidden');
            if (modalFooter) modalFooter.classList.remove('hidden');
            closeExportModal();
        };
    }

    if (openFolderBtn) {
        openFolderBtn.onclick = () => {
            window.electronAPI?.showItemInFolder(outputPath);
        };
    }

    if (shareBtn) {
        shareBtn.onclick = () => {
            shareBtn.disabled = true;
            shareBtn.classList.add('hidden');
            uploadShareClip(outputPath);
        };
    }

    // Copy link button
    const copyBtn = $('shareLinkCopyBtn');
    if (copyBtn) {
        copyBtn.onclick = () => {
            const linkInput = $('shareLinkInput');
            if (linkInput?.value) {
                navigator.clipboard.writeText(linkInput.value).then(() => {
                    const origText = copyBtn.textContent;
                    copyBtn.textContent = 'Copied!';
                    setTimeout(() => { copyBtn.textContent = origText; }, 2000);
                });
            }
        };
    }

    // Share was pre-selected — user can preview the clip, then click "Confirm & Upload"
    // (no auto-upload; the shareBtn click handler above handles it)
}

/**
 * Upload the exported clip to Sentry Studio server for sharing
 */
async function uploadShareClip(filePath) {
    // Block upload if exported at maximum quality (defense-in-depth)
    if (exportState.lastExportQuality === 'max') {
        console.warn('[SHARE] Upload blocked: cannot share clips exported at maximum quality');
        notify('Sharing is not available for clips exported at maximum quality.', { type: 'error' });
        return;
    }

    const shareUploadProgress = $('shareUploadProgress');
    const shareUploadProgressBar = $('shareUploadProgressBar');
    const shareUploadProgressText = $('shareUploadProgressText');
    const shareLinkResult = $('shareLinkResult');
    const shareLinkInput = $('shareLinkInput');
    const shareError = $('shareError');
    const shareErrorText = $('shareErrorText');
    const shareBtn = $('exportShareBtn');
    const expirationHours = getSelectedExpirationHours();

    // Disable Done button during upload
    const doneBtn = $('exportDoneBtn');
    if (doneBtn) {
        doneBtn.disabled = true;
        doneBtn.style.opacity = '0.4';
        doneBtn.style.cursor = 'not-allowed';
    }

    // Show upload progress
    if (shareUploadProgress) shareUploadProgress.classList.remove('hidden');
    if (shareLinkResult) shareLinkResult.classList.add('hidden');
    if (shareError) shareError.classList.add('hidden');
    if (shareUploadProgressBar) shareUploadProgressBar.style.width = '0%';
    if (shareUploadProgressText) shareUploadProgressText.textContent = 'Reserving share link...';

    // Reserve a share code first so we can show the link immediately
    let reserveCode = null;
    try {
        const reservation = await window.electronAPI?.reserveShareCode?.(expirationHours);
        if (reservation?.code && reservation?.url) {
            reserveCode = reservation.code;
            // Show the link immediately while upload continues
            if (shareLinkResult) shareLinkResult.classList.remove('hidden');
            if (shareLinkInput) shareLinkInput.value = reservation.url;
            if (shareUploadProgressText) shareUploadProgressText.textContent = 'Uploading to Sentry Studio...';
        }
    } catch (err) {
        console.warn('[SHARE] Reserve failed, falling back to direct upload:', err.message);
        if (shareUploadProgressText) shareUploadProgressText.textContent = 'Uploading to Sentry Studio...';
    }

    // Listen for progress updates
    const progressHandler = (progress) => {
        if (progress.type === 'progress') {
            if (shareUploadProgressBar) shareUploadProgressBar.style.width = `${progress.percentage}%`;
            const uploadedMB = (progress.bytesUploaded / 1048576).toFixed(1);
            const totalMB = (progress.totalBytes / 1048576).toFixed(1);
            if (shareUploadProgressText) {
                shareUploadProgressText.textContent = `Uploading... ${uploadedMB} / ${totalMB} MB (${progress.percentage}%)`;
            }
        } else if (progress.type === 'complete') {
            // Upload succeeded - show link (update if not already shown from reservation)
            if (shareUploadProgress) shareUploadProgress.classList.add('hidden');
            if (shareLinkResult) shareLinkResult.classList.remove('hidden');
            if (shareLinkInput) shareLinkInput.value = progress.url;

            // Re-enable Done button
            if (doneBtn) {
                doneBtn.disabled = false;
                doneBtn.style.opacity = '';
                doneBtn.style.cursor = '';
            }

            notify('Clip shared successfully!', { type: 'success' });

            // Remove listener
            window.electronAPI?.off('share:progress', progressHandler);
        } else if (progress.type === 'error') {
            // Upload failed
            if (shareUploadProgress) shareUploadProgress.classList.add('hidden');
            if (shareError) shareError.classList.remove('hidden');
            if (shareErrorText) shareErrorText.textContent = `Upload failed: ${progress.error}`;
            // Hide the pre-shown link on error
            if (shareLinkResult) shareLinkResult.classList.add('hidden');

            // Re-enable Done button
            if (doneBtn) {
                doneBtn.disabled = false;
                doneBtn.style.opacity = '';
                doneBtn.style.cursor = '';
            }

            // Re-show share button for retry
            if (shareBtn) {
                shareBtn.classList.remove('hidden');
                shareBtn.disabled = false;
            }

            // Remove listener
            window.electronAPI?.off('share:progress', progressHandler);
        }
    };

    if (window.electronAPI?.on) {
        window.electronAPI.on('share:progress', progressHandler);
    }

    try {
        await window.electronAPI.uploadShareClip(filePath, {
            reserveCode,
            expirationHours
        });
    } catch (err) {
        console.error('[SHARE] Upload failed:', err);
        // Error is handled by the progress handler
        if (shareUploadProgress) shareUploadProgress.classList.add('hidden');
        if (shareError) shareError.classList.remove('hidden');
        if (shareErrorText) shareErrorText.textContent = `Upload failed: ${err.message || 'Unknown error'}`;
        if (doneBtn) {
            doneBtn.disabled = false;
            doneBtn.style.opacity = '';
            doneBtn.style.cursor = '';
        }
        if (shareBtn) {
            shareBtn.classList.remove('hidden');
            shareBtn.disabled = false;
        }
        window.electronAPI?.off('share:progress', progressHandler);
    }
}

// Currently selected shared clip data (for detail panel and delete confirmation)
let _selectedClipData = null;

/**
 * Render the shared clips list in the My Shared Clips modal
 */
export async function renderSharedClipsList() {
    const listEl = document.getElementById('sharedClipsList');
    const emptyEl = document.getElementById('sharedClipsEmpty');
    const detailEl = document.getElementById('sharedClipDetail');
    const layoutEl = document.querySelector('.shared-clips-layout');

    if (!listEl) return;

    // Reset detail panel
    if (detailEl) detailEl.classList.add('hidden');
    _selectedClipData = null;

    let clips = [];
    try {
        // Sync with server to remove clips deleted by admin or expired
        clips = await window.electronAPI?.syncSharedClips() || [];
    } catch (err) {
        console.error('[SHARE] Failed to sync shared clips:', err);
        // Fallback to local clips if sync fails
        try {
            clips = await window.electronAPI?.getSharedClips() || [];
        } catch { /* ignore */ }
    }

    if (clips.length === 0) {
        if (emptyEl) emptyEl.classList.remove('hidden');
        if (layoutEl) layoutEl.style.display = 'none';
        listEl.innerHTML = '';
        return;
    }

    if (emptyEl) emptyEl.classList.add('hidden');
    if (layoutEl) layoutEl.style.display = '';

    const now = Date.now();

    listEl.innerHTML = clips.map(clip => {
        const expiresAt = new Date(clip.expiresAt).getTime();
        const isExpired = expiresAt <= now;
        const remainingMs = expiresAt - now;
        const sizeMB = clip.fileSize ? (clip.fileSize / 1048576).toFixed(1) : '?';
        const statusClass = isExpired ? 'expired' : 'active';
        const statusText = isExpired ? 'Expired' : formatTimeLeft(remainingMs);
        const displayName = clip.fileName || clip.code;

        return `
        <div class="shared-clip-item ${statusClass}" data-code="${clip.code}">
            <div class="shared-clip-info">
                <div class="shared-clip-name" title="${displayName}">${displayName}</div>
                <div class="shared-clip-meta">
                    <span class="shared-clip-size">${sizeMB} MB</span>
                    <span class="shared-clip-status ${statusClass}">${statusText}</span>
                </div>
            </div>
        </div>`;
    }).join('');

    // Wire up click-to-select on each clip row
    listEl.querySelectorAll('.shared-clip-item').forEach(item => {
        item.onclick = () => {
            const code = item.dataset.code;
            const clip = clips.find(c => c.code === code);
            if (!clip) return;

            // Toggle selection
            const wasSelected = item.classList.contains('selected');
            listEl.querySelectorAll('.shared-clip-item').forEach(el => el.classList.remove('selected'));

            const hintEl = document.getElementById('sharedClipsHint');
            if (wasSelected) {
                // Deselect
                if (detailEl) detailEl.classList.add('hidden');
                if (hintEl) hintEl.classList.remove('hidden');
                _selectedClipData = null;
                return;
            }
            if (hintEl) hintEl.classList.add('hidden');

            item.classList.add('selected');
            _selectedClipData = clip;

            // Populate detail panel
            const expiresAt = new Date(clip.expiresAt).getTime();
            const isExpired = expiresAt <= now;
            const remainingMs = expiresAt - now;
            const sizeMB = clip.fileSize ? (clip.fileSize / 1048576).toFixed(1) : '?';

            const nameEl = document.getElementById('sharedClipDetailName');
            const sizeEl = document.getElementById('sharedClipDetailSize');
            const statusEl = document.getElementById('sharedClipDetailStatus');
            const previewVideo = document.getElementById('sharedClipPreviewVideo');
            const copyBtn = document.getElementById('sharedClipCopyBtn');
            const openBtn = document.getElementById('sharedClipOpenBtn');
            const deleteBtn = document.getElementById('sharedClipDeleteBtn');

            if (nameEl) nameEl.textContent = clip.fileName || clip.code;
            if (sizeEl) sizeEl.textContent = `${sizeMB} MB`;
            if (statusEl) {
                statusEl.textContent = isExpired ? 'Expired' : formatTimeLeft(remainingMs);
                statusEl.className = `shared-clip-status ${isExpired ? 'expired' : 'active'}`;
            }

            // Load video preview (first frame) from server
            if (previewVideo && clip.url && !isExpired) {
                const videoUrl = clip.url.replace(/\/([^/]+)$/, '/video/$1');
                previewVideo.src = videoUrl + '#t=0.5';
                previewVideo.load();
            } else if (previewVideo) {
                previewVideo.removeAttribute('src');
            }

            // Show/hide buttons based on expired state
            if (copyBtn) copyBtn.style.display = isExpired ? 'none' : '';
            if (openBtn) openBtn.style.display = isExpired ? 'none' : '';
            if (deleteBtn) {
                deleteBtn.innerHTML = `<span class="material-symbols-outlined mi-sm">delete</span> <span data-i18n="ui.sharedClips.delete">${t('ui.sharedClips.delete')}</span>`;
            }

            if (detailEl) detailEl.classList.remove('hidden');
            if (hintEl) hintEl.classList.add('hidden');
        };
    });

    // Wire up detail panel action buttons
    _wireDetailButtons(listEl, emptyEl, layoutEl);
}

/**
 * Wire up the detail panel action buttons (copy, open, delete)
 */
function _wireDetailButtons(listEl, emptyEl, layoutEl) {
    const copyBtn = document.getElementById('sharedClipCopyBtn');
    const openBtn = document.getElementById('sharedClipOpenBtn');
    const deleteBtn = document.getElementById('sharedClipDeleteBtn');

    if (copyBtn) {
        copyBtn.onclick = () => {
            if (!_selectedClipData?.url) return;
            navigator.clipboard.writeText(_selectedClipData.url).then(() => {
                const origHTML = copyBtn.innerHTML;
                copyBtn.innerHTML = '<span class="material-symbols-outlined mi-sm">check</span> Copied!';
                setTimeout(() => { copyBtn.innerHTML = origHTML; }, 1500);
            });
        };
    }

    if (openBtn) {
        openBtn.onclick = () => {
            if (_selectedClipData?.url) {
                window.electronAPI?.openExternal(_selectedClipData.url);
            }
        };
    }

    if (deleteBtn) {
        deleteBtn.onclick = () => {
            if (!_selectedClipData) return;
            // Open delete confirmation modal
            const deleteModal = document.getElementById('deleteSharedClipModal');
            const deleteNameEl = document.getElementById('deleteClipName');
            if (deleteNameEl) deleteNameEl.textContent = _selectedClipData.fileName || _selectedClipData.code;
            if (deleteModal) deleteModal.classList.remove('hidden');
        };
    }

    // Wire up delete confirmation modal buttons
    const cancelDeleteBtn = document.getElementById('cancelDeleteClipBtn');
    const confirmDeleteBtn = document.getElementById('confirmDeleteClipBtn');
    const closeDeleteModalBtn = document.getElementById('closeDeleteSharedClipModal');
    const deleteModal = document.getElementById('deleteSharedClipModal');
    const detailEl = document.getElementById('sharedClipDetail');

    const closeDeleteModal = () => {
        if (deleteModal) deleteModal.classList.add('hidden');
    };

    if (cancelDeleteBtn) cancelDeleteBtn.onclick = closeDeleteModal;
    if (closeDeleteModalBtn) closeDeleteModalBtn.onclick = closeDeleteModal;

    if (confirmDeleteBtn) {
        confirmDeleteBtn.onclick = async () => {
            if (!_selectedClipData) return;

            const code = _selectedClipData.code;
            const token = _selectedClipData.deleteToken;

            confirmDeleteBtn.disabled = true;
            confirmDeleteBtn.textContent = 'Deleting...';

            try {
                await window.electronAPI?.deleteSharedClip(code, token);

                closeDeleteModal();

                // Remove from list with animation
                const item = listEl?.querySelector(`.shared-clip-item[data-code="${code}"]`);
                if (item) {
                    item.style.opacity = '0';
                    item.style.transform = 'translateX(20px)';
                    item.style.transition = 'all 0.25s ease';
                    setTimeout(() => {
                        item.remove();
                        if (listEl.children.length === 0) {
                            if (emptyEl) emptyEl.classList.remove('hidden');
                            if (layoutEl) layoutEl.style.display = 'none';
                        }
                    }, 250);
                }

                // Hide detail panel
                if (detailEl) detailEl.classList.add('hidden');
                _selectedClipData = null;

            } catch (err) {
                console.error('[SHARE] Delete failed:', err);
            } finally {
                confirmDeleteBtn.disabled = false;
                confirmDeleteBtn.textContent = 'Delete Clip';
            }
        };
    }
}

/**
 * Clear export markers
 */
export function clearExportMarkers() {
    exportState.startMarkerPct = null;
    exportState.endMarkerPct = null;
    updateExportMarkers();
    updateExportButtonState();
}
