// Advanced Editor — sidebar wiring.
// Each control reads/writes the SAME setting keys as the simple export modal
// so toggling in one place is reflected next time the other is opened.

import { advancedEditorState } from './state.js';
import { openBlurZoneEditorForCamera } from '../../features/exportVideo.js';

// Map element IDs in the AE sidebar -> shared settings keys.
// These mirror EXPORT_OVERLAY_SETTINGS in exportVideo.js so simple and advanced
// modals stay in sync.
const AE_SETTINGS_MAP = {
    aeIncludeTimestamp:     { key: 'exportIncludeTimestamp',    type: 'checkbox', stateField: 'includeTimestamp' },
    aeIncludeDashboard:     { key: 'exportIncludeDashboard',    type: 'checkbox', stateField: 'includeDashboard' },
    aeDashboardStyle:           { key: 'exportDashboardStyle',          type: 'select',   stateField: 'dashboardStyle' },
    aeDashboardLabelScale:      { key: 'exportDashboardLabelScale',     type: 'select',   stateField: 'dashboardLabelScale', parse: parseFloat },
    aeDashboardValueScale:      { key: 'exportDashboardValueScale',     type: 'select',   stateField: 'dashboardValueScale', parse: parseFloat },
    aeDashboardDateLabelScale:  { key: 'exportDashboardDateLabelScale', type: 'select',   stateField: 'dashboardDateLabelScale', parse: parseFloat },
    aeDashboardDateValueScale:  { key: 'exportDashboardDateValueScale', type: 'select',   stateField: 'dashboardDateValueScale', parse: parseFloat },
    aeIncludeMinimap:       { key: 'exportIncludeMinimap',      type: 'checkbox', stateField: 'includeMinimap' },
    aeMinimapRenderMode:    { key: 'exportMinimapRenderMode',   type: 'select',   stateField: 'minimapRenderMode' },
    aeEnableTimelapse:      { key: 'exportEnableTimelapse',     type: 'checkbox', stateField: 'enableTimelapse' },
    aeTimelapseSpeed:       { key: 'exportTimelapseSpeed',      type: 'select',   stateField: 'timelapseSpeed' },
};

const AE_QUALITY_KEY = 'exportLastQuality';

let depsRef = null;
let blurModalObserver = null;
let onSidebarChange = null;  // optional callback fired when any sidebar value changes

export function initSidebar(deps, options = {}) {
    depsRef = deps;
    onSidebarChange = options.onChange || null;

    wireSettingsControls();
    wireQualityRadios();
    wireDashboardStyleVisibility();
    wireMinimapModeVisibility();
    wireTimelapseVisibility();
    wireCameraToggles();
    wireBlurZoneControls();
}

// Called every time the modal opens — reload from settings + refresh dynamic UI.
export async function loadSidebarState() {
    if (!window.electronAPI?.getSetting) return;

    // Load each shared setting.
    for (const [elId, info] of Object.entries(AE_SETTINGS_MAP)) {
        const el = document.getElementById(elId);
        if (!el) continue;
        try {
            let saved = await window.electronAPI.getSetting(info.key);
            // Dashboard "default" style is feature-gated (option hidden in the
            // dropdown until writeDefaultDashboardAss renders the floating-widget
            // look). Fall back to Compact for anyone who saved Default earlier.
            if (info.stateField === 'dashboardStyle' && saved === 'default') {
                saved = 'compact';
                try { await window.electronAPI.setSetting(info.key, 'compact'); } catch {}
            }
            if (saved !== undefined) {
                if (info.type === 'checkbox') el.checked = saved === true;
                else el.value = saved;
                advancedEditorState.settings[info.stateField] = info.parse ? info.parse(saved) : saved;
            } else {
                // Fall back to the default already in the markup / state.
                if (info.type === 'checkbox') {
                    advancedEditorState.settings[info.stateField] = el.checked;
                } else {
                    advancedEditorState.settings[info.stateField] = info.parse ? info.parse(el.value) : el.value;
                }
            }
        } catch (err) {
            console.warn('[AE] Failed to load setting', info.key, err);
        }
    }

    // Quality (separate handling because it's radio buttons).
    try {
        const savedQuality = await window.electronAPI.getSetting(AE_QUALITY_KEY);
        const quality = savedQuality || 'high';
        const radio = document.querySelector(`input[name="aeExportQuality"][value="${quality}"]`);
        if (radio) radio.checked = true;
        advancedEditorState.settings.quality = quality;
    } catch (err) {
        console.warn('[AE] Failed to load quality', err);
    }

    // Refresh visibility of dependent option groups now that values are loaded.
    refreshOptionVisibility();
    renderAeBlurZoneList();
    updateAeBlurZoneStatus();
}

// --------------------------------------------------------------------------
// Internal wiring helpers
// --------------------------------------------------------------------------

function wireSettingsControls() {
    for (const [elId, info] of Object.entries(AE_SETTINGS_MAP)) {
        const el = document.getElementById(elId);
        if (!el) continue;
        el.addEventListener('change', async () => {
            const raw = info.type === 'checkbox' ? el.checked : el.value;
            const value = info.parse ? info.parse(raw) : raw;
            advancedEditorState.settings[info.stateField] = value;
            if (window.electronAPI?.setSetting) {
                try { await window.electronAPI.setSetting(info.key, value); }
                catch (err) { console.warn('[AE] Failed to save setting', info.key, err); }
            }
            refreshOptionVisibility();
            if (onSidebarChange) onSidebarChange(info.stateField, value);
        });
    }
}

function wireQualityRadios() {
    const radios = document.querySelectorAll('input[name="aeExportQuality"]');
    radios.forEach(r => {
        r.addEventListener('change', async () => {
            if (!r.checked) return;
            advancedEditorState.settings.quality = r.value;
            if (window.electronAPI?.setSetting) {
                try { await window.electronAPI.setSetting(AE_QUALITY_KEY, r.value); }
                catch (err) { console.warn('[AE] Failed to save quality', err); }
            }
            if (onSidebarChange) onSidebarChange('quality', r.value);
        });
    });
}

function refreshOptionVisibility() {
    const dashOpts = document.getElementById('aeDashboardOptions');
    const dashChk = document.getElementById('aeIncludeDashboard');
    if (dashOpts && dashChk) dashOpts.classList.toggle('hidden', !dashChk.checked);

    // Per-style visibility of the Label/Value Size rows. Only Detailed has
    // both labels and values that are independently meaningful — Compact and
    // Default don't have a meaningful label/value distinction, so just hide
    // Label Size for them. Value Size applies to all three.
    const styleSelect = document.getElementById('aeDashboardStyle');
    const style = styleSelect?.value || 'compact';
    const labelRow = document.getElementById('aeDashboardLabelScaleRow');
    const valueRow = document.getElementById('aeDashboardValueScaleRow');
    if (labelRow) labelRow.classList.toggle('hidden', style !== 'detailed');
    if (valueRow) valueRow.classList.toggle('hidden', false);

    // Tesla Mobile only: show the independent Date Bar Size dropdown
    // because the date and dashboard data sit in two separate tiles.
    // Hide for every other style (the date bar tile doesn't exist).
    // The Date Label Size row stays hidden for now — the date bar
    // only has a single text value, no labels.
    const dateLabelRow = document.getElementById('aeDashboardDateLabelScaleRow');
    const dateValueRow = document.getElementById('aeDashboardDateValueScaleRow');
    if (dateLabelRow) dateLabelRow.classList.toggle('hidden', true);
    if (dateValueRow) dateValueRow.classList.toggle('hidden', style !== 'tesla-mobile');

    // Default-style Value Size is JS-capped at 1.0 (Medium) to prevent the
    // floating-widget panel from overflowing the tile, so anything above
    // Medium is a no-op. Hide those options for Default and snap the current
    // value back to Medium if the user was above it on a different style.
    syncValueScaleOptionsForStyle('aeDashboardValueScale', style);

    const miniOpts = document.getElementById('aeMinimapOptions');
    const miniChk = document.getElementById('aeIncludeMinimap');
    if (miniOpts && miniChk) miniOpts.classList.toggle('hidden', !miniChk.checked);

    const tlOpts = document.getElementById('aeTimelapseOptions');
    const tlChk = document.getElementById('aeEnableTimelapse');
    if (tlOpts && tlChk) tlOpts.classList.toggle('hidden', !tlChk.checked);
}

// Hide Value-Size options that exceed the per-style maximum and snap the
// current value down to the max if necessary. For Default we cap at 1.0
// because the floating-widget panel can't grow past its tile fit; all other
// styles allow the full range.
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
        advancedEditorState.settings.dashboardValueScale = maxScale;
        if (window.electronAPI?.setSetting) {
            window.electronAPI.setSetting('exportDashboardValueScale', maxScale)
                .catch(err => console.warn('[AE] persist snapped value scale failed', err));
        }
        if (onSidebarChange) onSidebarChange('dashboardValueScale', maxScale);
    }
}

function wireDashboardStyleVisibility() {
    const styleSelect = document.getElementById('aeDashboardStyle');
    if (!styleSelect) return;
    styleSelect.addEventListener('change', () => {
        // Phase 9 will use this to swap the live preview's renderer.
        if (onSidebarChange) onSidebarChange('dashboardStyle', styleSelect.value);
    });
}

function wireMinimapModeVisibility() {
    const select = document.getElementById('aeMinimapRenderMode');
    if (!select) return;
    select.addEventListener('change', () => {
        if (onSidebarChange) onSidebarChange('minimapRenderMode', select.value);
    });
}

function wireTimelapseVisibility() {
    // Visibility handled by refreshOptionVisibility on toggle change.
}

// --------------------------------------------------------------------------
// Camera toggles
// --------------------------------------------------------------------------

// Event delegation on the grid — catches change events from all current
// and future child inputs, so the listener survives DOM manipulations.
// Exported (and called both from initSidebar and openAdvancedEditor) so a
// missed init can be recovered without a page reload. The wired flag on
// the grid element prevents double-attaching.
export function wireCameraToggles() {
    const grid = document.getElementById('aeCameraToggles');
    if (!grid) {
        console.warn('[AE] #aeCameraToggles grid not found in DOM');
        return;
    }
    if (grid.dataset.aeCameraWired === '1') return;
    grid.dataset.aeCameraWired = '1';

    grid.addEventListener('change', (e) => {
        const input = e.target.closest('input[type="checkbox"][data-camera]');
        if (!input || !grid.contains(input)) return;
        const camera = input.dataset.camera;
        if (input.checked) advancedEditorState.settings.selectedCameras.add(camera);
        else advancedEditorState.settings.selectedCameras.delete(camera);
        if (onSidebarChange) onSidebarChange('selectedCameras', advancedEditorState.settings.selectedCameras);
    });
}

// Update camera-toggle visibility based on what the loaded clip actually has.
// Pass null to show all.
export function updateAvailableCameras(availableSet) {
    const grid = document.getElementById('aeCameraToggles');
    if (!grid) return;
    grid.querySelectorAll('label[data-camera]').forEach(label => {
        const camera = label.dataset.camera;
        const available = !availableSet || availableSet.has(camera);
        label.classList.toggle('hidden', !available);
        const input = label.querySelector('input[type="checkbox"]');
        if (input) {
            if (!available) {
                input.checked = false;
                advancedEditorState.settings.selectedCameras.delete(camera);
            } else if (!advancedEditorState.settings.selectedCameras.has(camera)) {
                input.checked = false;
            } else {
                input.checked = true;
            }
        }
    });
}

// --------------------------------------------------------------------------
// Blur zones — reuse simple-modal data via the shared exportState.blurZones
// --------------------------------------------------------------------------

function wireBlurZoneControls() {
    const addBtn = document.getElementById('aeAddBlurZoneBtn');
    const cameraSelect = document.getElementById('aeBlurZoneCameraSelect');
    const blurEditorModal = document.getElementById('blurZoneEditorModal');

    if (addBtn && blurEditorModal) {
        addBtn.addEventListener('click', async () => {
            const camera = cameraSelect?.value || 'back';
            // Bump z-index so blur modal stacks above the AE modal.
            blurEditorModal.style.zIndex = '10002';
            await openBlurZoneEditorForCamera(camera, blurEditorModal);
        });
    }

    // Whenever the blur editor modal hides, re-render AE's list. This catches
    // both Save and Cancel/Close. Set up the observer once.
    if (blurEditorModal && !blurModalObserver) {
        blurModalObserver = new MutationObserver(() => {
            if (blurEditorModal.classList.contains('hidden')) {
                // Restore default z-index after close.
                blurEditorModal.style.zIndex = '';
                if (advancedEditorState.isOpen) {
                    renderAeBlurZoneList();
                    updateAeBlurZoneStatus();
                }
            }
        });
        blurModalObserver.observe(blurEditorModal, { attributes: true, attributeFilter: ['class'] });
    }
}

const CAMERA_LABEL = {
    front: 'Front',
    back: 'Back',
    left_repeater: 'Left Repeater',
    right_repeater: 'Right Repeater',
    left_pillar: 'Left Pillar',
    right_pillar: 'Right Pillar',
};

export function renderAeBlurZoneList() {
    const listEl = document.getElementById('aeBlurZoneList');
    if (!listEl) return;
    const exportState = depsRef?.getExportState?.();
    if (!exportState) { listEl.innerHTML = ''; return; }
    const zones = exportState.blurZones || [];

    if (zones.length === 0) { listEl.innerHTML = ''; return; }

    listEl.innerHTML = zones.map((zone, index) => `
        <div class="blur-zone-item" style="display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; background: rgba(255,255,255,0.05); border-radius: 6px; margin-bottom: 4px;">
            <span style="color: var(--text-secondary); font-size: 12px;">
                <strong>${CAMERA_LABEL[zone.camera] || zone.camera}</strong> · ${zone.coordinates.length} pts
            </span>
            <div style="display: flex; gap: 4px;">
                <button class="btn btn-secondary btn-small ae-blur-edit-btn" data-index="${index}" style="padding: 2px 8px; font-size: 11px;">Edit</button>
                <button class="btn btn-secondary btn-small ae-blur-remove-btn" data-index="${index}" style="padding: 2px 8px; font-size: 11px; color: #ff6b6b;">Remove</button>
            </div>
        </div>
    `).join('');

    listEl.querySelectorAll('.ae-blur-edit-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const index = parseInt(btn.dataset.index, 10);
            const zone = zones[index];
            if (!zone) return;
            const blurEditorModal = document.getElementById('blurZoneEditorModal');
            if (!blurEditorModal) return;
            blurEditorModal.style.zIndex = '10002';
            await openBlurZoneEditorForCamera(zone.camera, blurEditorModal, index);
        });
    });

    listEl.querySelectorAll('.ae-blur-remove-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const index = parseInt(btn.dataset.index, 10);
            zones.splice(index, 1);
            renderAeBlurZoneList();
            updateAeBlurZoneStatus();
        });
    });
}

export function updateAeBlurZoneStatus() {
    const statusEl = document.getElementById('aeBlurZoneStatus');
    if (!statusEl) return;
    const exportState = depsRef?.getExportState?.();
    const zones = exportState?.blurZones || [];
    if (zones.length === 0) {
        statusEl.classList.add('hidden');
        return;
    }
    statusEl.classList.remove('hidden');
    const cameras = [...new Set(zones.map(z => z.camera))];
    const names = cameras.map(c => CAMERA_LABEL[c] || c).join(', ');
    statusEl.innerHTML = `
        <span class="info-box-icon"><span class="material-symbols-outlined">info</span></span>
        <span>${zones.length} blur zone${zones.length === 1 ? '' : 's'} on ${names}</span>
    `;
}
