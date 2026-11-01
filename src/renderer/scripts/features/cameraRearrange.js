/**
 * Camera Rearrangement (Drag & Drop)
 * Allows users to customize the camera layout by dragging tiles
 */

import { notify } from '../ui/notifications.js';
import { MULTI_LAYOUTS, DEFAULT_MULTI_LAYOUT } from '../lib/multiLayouts.js';
import { t } from '../lib/i18n.js';
import {
    getCameraLabel,
    getDashcamProfile
} from '../../../shared/dashcamProfiles.mjs';

// Custom camera orders are isolated by profile so a Tesla preference can never
// remap a GMC layout (and vice versa).
let customCameraOrders = {};

// Dependencies set via init
let getMultiCamGrid = null;
let getState = null;
let getMulti = null;
let loadNativeSegment = null;
let getNativeVideo = null;
let syncMultiVideos = null;
let playNative = null;
let updateEventCameraHighlight = null;

/**
 * Initialize camera rearrangement module with dependencies
 * @param {Object} deps - Dependencies
 */
export function initCameraRearrange(deps) {
    getMultiCamGrid = deps.getMultiCamGrid;
    getState = deps.getState;
    getMulti = deps.getMulti;
    loadNativeSegment = deps.loadNativeSegment;
    getNativeVideo = deps.getNativeVideo;
    syncMultiVideos = deps.syncMultiVideos;
    playNative = deps.playNative;
    updateEventCameraHighlight = deps.updateEventCameraHighlight;
}

/**
 * Get the current custom camera order
 */
export function getCustomCameraOrder() {
    return customCameraOrders[getActiveProfileId()] || null;
}

function getActiveProfileId() {
    return getState?.()?.library?.profileId || 'tesla';
}

/**
 * Initialize custom camera order from settings
 */
export async function initCustomCameraOrder() {
    if (window.electronAPI?.getSetting) {
        try {
            const savedByProfile = await window.electronAPI.getSetting('customCameraOrdersByProfile');
            if (savedByProfile && typeof savedByProfile === 'object') {
                customCameraOrders = savedByProfile;
            } else {
                // One-time compatibility read: the legacy setting belongs to Tesla.
                const legacyTeslaOrder = await window.electronAPI.getSetting('customCameraOrder');
                customCameraOrders = legacyTeslaOrder ? { tesla: legacyTeslaOrder } : {};
                if (legacyTeslaOrder) saveCustomCameraOrder();
            }
            console.log('Loaded profile camera orders:', customCameraOrders);
        } catch (e) {
            console.warn('Failed to load custom camera order:', e);
            customCameraOrders = {};
        }
    }
}

/**
 * Save custom camera order to settings
 */
export function saveCustomCameraOrder() {
    if (window.electronAPI?.setSetting) {
        window.electronAPI.setSetting('customCameraOrdersByProfile', customCameraOrders);
    }
}

/**
 * Reset camera order to default
 */
export function resetCameraOrder() {
    const state = getState?.();
    const nativeVideo = getNativeVideo?.();
    
    delete customCameraOrders[getActiveProfileId()];
    saveCustomCameraOrder();
    updateTileLabels();
    updateEventCameraHighlight?.();
    updateCompactDashboardPosition();
    
    if (state?.collection?.active && nativeVideo?.currentSegmentIdx >= 0) {
        loadNativeSegment?.(nativeVideo.currentSegmentIdx);
    }
    notify(t('ui.notifications.cameraOrderReset'), { type: 'info' });
}

/**
 * Get effective slots with custom camera order applied
 */
export function getEffectiveSlots() {
    const multi = getMulti?.();
    const layout = MULTI_LAYOUTS[multi?.layoutId] || MULTI_LAYOUTS[DEFAULT_MULTI_LAYOUT];
    const baseSlots = layout?.slots || [];
    const customCameraOrder = getCustomCameraOrder();
    
    if (!customCameraOrder) {
        return baseSlots;
    }
    
    return baseSlots.map(slotDef => {
        if (Object.prototype.hasOwnProperty.call(customCameraOrder, slotDef.slot)) {
            const customCamera = customCameraOrder[slotDef.slot];
            const originalSlotDef = baseSlots.find(s => s.camera === customCamera);
            return {
                ...slotDef,
                camera: customCamera,
                label: originalSlotDef?.label || customCamera
            };
        }
        return slotDef;
    });
}

/**
 * Initialize drag and drop for camera tiles
 */
export function initCameraDragAndDrop() {
    const multiCamGrid = getMultiCamGrid?.();
    if (!multiCamGrid) return;
    
    const tiles = multiCamGrid.querySelectorAll('.multi-tile');
    let draggedSlot = null;
    let draggedTile = null;
    let dragIndicator = null;
    
    // Create floating indicator element
    function createDragIndicator(label) {
        const el = document.createElement('div');
        el.className = 'camera-drag-indicator';
        el.textContent = label;
        document.body.appendChild(el);
        return el;
    }
    
    // Update indicator position to follow cursor
    function updateIndicatorPosition(e) {
        if (dragIndicator) {
            dragIndicator.style.left = e.clientX + 'px';
            dragIndicator.style.top = e.clientY + 'px';
        }
    }
    
    // Remove the indicator
    function removeDragIndicator() {
        if (dragIndicator) {
            dragIndicator.remove();
            dragIndicator = null;
        }
        document.removeEventListener('dragover', updateIndicatorPosition);
    }
    
    tiles.forEach(tile => {
        tile.setAttribute('draggable', 'true');
        
        tile.addEventListener('dragstart', (e) => {
            if (multiCamGrid.classList.contains('focused')) {
                e.preventDefault();
                return;
            }
            
            draggedSlot = tile.getAttribute('data-slot');
            draggedTile = tile;
            tile.classList.add('dragging');
            
            // Hide the default browser drag ghost - use transparent 1x1 image
            const emptyImg = new Image();
            emptyImg.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
            e.dataTransfer.setDragImage(emptyImg, 0, 0);
            
            // Create floating indicator with camera label
            const label = tile.querySelector('.multi-label')?.textContent || draggedSlot;
            dragIndicator = createDragIndicator(label);
            dragIndicator.style.left = e.clientX + 'px';
            dragIndicator.style.top = e.clientY + 'px';
            document.addEventListener('dragover', updateIndicatorPosition);
            
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', draggedSlot);
            
            multiCamGrid.classList.add('drag-active');
        });
        
        tile.addEventListener('dragend', () => {
            tile.classList.remove('dragging');
            multiCamGrid.classList.remove('drag-active');
            tiles.forEach(t => t.classList.remove('drag-over'));
            removeDragIndicator();
            draggedSlot = null;
            draggedTile = null;
        });
        
        tile.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            
            const targetSlot = tile.getAttribute('data-slot');
            if (targetSlot !== draggedSlot) {
                tile.classList.add('drag-over');
            }
        });
        
        tile.addEventListener('dragleave', () => {
            tile.classList.remove('drag-over');
        });
        
        tile.addEventListener('drop', (e) => {
            e.preventDefault();
            tile.classList.remove('drag-over');
            
            const targetSlot = tile.getAttribute('data-slot');
            if (!draggedSlot || targetSlot === draggedSlot) return;
            
            const effectiveSlots = getEffectiveSlots();
            const sourceSlotDef = effectiveSlots.find(s => s.slot === draggedSlot);
            const targetSlotDef = effectiveSlots.find(s => s.slot === targetSlot);
            
            if (!sourceSlotDef || !targetSlotDef) return;
            
            let customCameraOrder = getCustomCameraOrder();
            if (!customCameraOrder) {
                customCameraOrder = {};
                effectiveSlots.forEach(s => {
                    customCameraOrder[s.slot] = s.camera;
                });
                customCameraOrders[getActiveProfileId()] = customCameraOrder;
            }
            
            const sourceCamera = customCameraOrder[draggedSlot];
            const targetCamera = customCameraOrder[targetSlot];
            customCameraOrder[draggedSlot] = targetCamera;
            customCameraOrder[targetSlot] = sourceCamera;
            
            saveCustomCameraOrder();
            updateTileLabels();
            updateEventCameraHighlight?.();
            updateCompactDashboardPosition();
            
            const state = getState?.();
            const nativeVideo = getNativeVideo?.();
            
            if (state?.collection?.active && nativeVideo?.currentSegmentIdx >= 0) {
                const wasPlaying = nativeVideo.playing;
                const currentTime = nativeVideo.master?.currentTime || 0;
                
                loadNativeSegment?.(nativeVideo.currentSegmentIdx).then(() => {
                    if (nativeVideo.master) {
                        nativeVideo.master.currentTime = currentTime;
                        syncMultiVideos?.(currentTime);
                    }
                    if (wasPlaying) {
                        playNative?.();
                    }
                });
            }
            
            console.log('Swapped cameras:', draggedSlot, '<->', targetSlot);
        });
    });
}

/**
 * Update tile labels to match current camera assignments
 */
export function updateTileLabels() {
    const multiCamGrid = getMultiCamGrid?.();
    const effectiveSlots = getEffectiveSlots();
    
    effectiveSlots.forEach(({ slot, camera }) => {
        const tile = multiCamGrid?.querySelector(`.multi-tile[data-slot="${slot}"]`);
        if (tile) {
            const labelEl = tile.querySelector('.multi-label');
            if (labelEl) {
                // Translate camera name based on camera type
                const translatedLabel = getCameraTranslation(camera);
                labelEl.textContent = translatedLabel;
            }
        }
    });
}

/**
 * Get translated camera name
 */
function getCameraTranslation(camera) {
    const profileId = getActiveProfileId();
    if (!getDashcamProfile(profileId).localizedCameraLabels) {
        return getCameraLabel(profileId, camera);
    }
    if (camera === 'front') return t('ui.cameras.front');
    if (camera === 'back') return t('ui.cameras.back');
    if (camera === 'left_repeater') return t('ui.cameras.leftRepeater');
    if (camera === 'right_repeater') return t('ui.cameras.rightRepeater');
    if (camera === 'left_pillar') return t('ui.cameras.leftPillar');
    if (camera === 'right_pillar') return t('ui.cameras.rightPillar');
    return camera;
}

/**
 * Move compact dashboard to the tile containing the front camera
 */
export function updateCompactDashboardPosition() {
    const multiCamGrid = getMultiCamGrid?.();
    const compactDash = document.getElementById('dashboardVisCompact');
    if (!multiCamGrid || !compactDash) return;
    
    // Find which slot currently has the front camera
    const effectiveSlots = getEffectiveSlots();
    const frontSlot = effectiveSlots.find(s => s.camera === 'front');
    
    if (!frontSlot) return;
    
    // Find the tile with the front camera
    const frontTile = multiCamGrid.querySelector(`.multi-tile[data-slot="${frontSlot.slot}"]`);
    if (!frontTile) return;
    
    // Remove dashboard from current location
    const currentParent = compactDash.parentElement;
    if (currentParent && currentParent !== frontTile) {
        compactDash.remove();
    }
    
    // Add dashboard to front camera tile if not already there
    if (!frontTile.contains(compactDash)) {
        frontTile.appendChild(compactDash);
    }
}
