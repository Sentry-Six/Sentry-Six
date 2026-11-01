/**
 * Clip Browser Module
 * Handles clip list rendering, selection, and display item building.
 */

import { escapeHtml, cssEscape, filePathToUrl } from '../lib/utils.js';
import { formatEventTime } from '../ui/clipListHelpers.js';
import { t } from '../lib/i18n.js';
import { notify } from '../ui/notifications.js';

// Dependencies injected at init
let getState = null;
let getLibrary = null;
let getSelection = null;
let clipList = null;
let dayFilter = null;
let selectDayCollection = null;
let formatEventReason = null;
let getBaseFolderPath = null;
let onClipDeleted = null;

/**
 * Initialize the clip browser module with dependencies.
 */
export function initClipBrowser(deps) {
    getState = deps.getState;
    getLibrary = deps.getLibrary;
    getSelection = deps.getSelection;
    clipList = deps.clipList;
    dayFilter = deps.dayFilter;
    selectDayCollection = deps.selectDayCollection;
    formatEventReason = deps.formatEventReason;
    getBaseFolderPath = deps.getBaseFolderPath;
    onClipDeleted = deps.onClipDeleted;
}

/**
 * Render the clip list based on current day selection.
 */
export function renderClipList() {
    const library = getLibrary?.();
    if (!clipList) return;
    
    // Make available globally for language change updates
    window._renderClipList = renderClipList;
    
    clipList.innerHTML = '';

    // Remove any orphaned thumbnail tooltips from previous render
    document.querySelectorAll('.clip-thumb-tooltip').forEach(el => el.remove());

    const selectedDay = dayFilter?.value || '';
    if (!selectedDay || !library?.dayData) {
        const placeholder = document.createElement('div');
        placeholder.className = 'clip-list-placeholder';
        placeholder.textContent = t('ui.clipBrowser.subtitle');
        placeholder.style.cssText = 'padding: 16px; text-align: center; color: rgba(255,255,255,0.5); font-size: 12px;';
        clipList.appendChild(placeholder);
        return;
    }
    
    const dayData = library.dayData.get(selectedDay);
    if (!dayData) return;
    
    // 1. Recent Clips (at top)
    if (dayData.recent.length > 0) {
        const recentId = `recent:${selectedDay}`;
        const recentColl = library.dayCollections?.get(recentId);
        if (recentColl) {
            const item = createClipItem(recentColl, t('ui.clipBrowser.recent') + ' ' + t('ui.clipBrowser.title'), 'recent');
            clipList.appendChild(item);
        }
    }
    
    // 2. Sentry Events (individual folders)
    const sentryEvents = Array.from(dayData.sentry.entries())
        .map(([eventId, groups]) => ({ eventId, groups, type: 'sentry' }))
        .sort((a, b) => b.eventId.localeCompare(a.eventId));
    
    for (const event of sentryEvents) {
        const eventId = event.eventId;
        const collId = `sentry:${selectedDay}:${eventId}`;
        const coll = library.dayCollections?.get(collId);
        if (coll) {
            const timeStr = formatEventTime(eventId);
            const item = createClipItem(coll, `${t('ui.clipBrowser.sentry')} · ${timeStr}`, 'sentry');
            clipList.appendChild(item);
        }
    }
    
    // 3. Saved Events (individual folders)
    const savedEvents = Array.from(dayData.saved.entries())
        .map(([eventId, groups]) => ({ eventId, groups, type: 'saved' }))
        .sort((a, b) => b.eventId.localeCompare(a.eventId));
    
    for (const event of savedEvents) {
        const eventId = event.eventId;
        const collId = `saved:${selectedDay}:${eventId}`;
        const coll = library.dayCollections?.get(collId);
        if (coll) {
            const timeStr = formatEventTime(eventId);
            const item = createClipItem(coll, `${t('ui.clipBrowser.saved')} · ${timeStr}`, 'saved');
            clipList.appendChild(item);
        }
    }
    
    // 4. Custom folder clips (non-standard folder names)
    if (dayData.custom && dayData.custom.length > 0) {
        const customId = `custom:${selectedDay}`;
        const customColl = library.dayCollections?.get(customId);
        if (customColl) {
            const folderName = dayData.custom[0]?.tag || 'Custom';
            const item = createClipItem(customColl, `${folderName} Clips`, 'custom');
            clipList.appendChild(item);
        }
    }
    
    highlightSelectedClip();
}

/**
 * Create a clip item element for the list.
 */
export function createClipItem(coll, title, typeClass) {
    const groups = coll.groups || [];
    const firstGroup = groups[0];
    const cameras = firstGroup ? Array.from(firstGroup.filesByCamera.keys()) : [];
    
    // Get eventMeta for reason icon
    let eventMeta = null;
    for (const g of groups) {
        if (g.eventMeta) {
            eventMeta = g.eventMeta;
            break;
        }
    }
    
    // Get folder path from first group's first file
    let folderPath = null;
    if (coll.deletion) {
        folderPath = coll.deletion.allowed ? coll.deletion.path : null;
    } else if (firstGroup && firstGroup.filesByCamera.size > 0) {
        const firstEntry = firstGroup.filesByCamera.values().next().value;
        if (firstEntry?.file?.path) {
            // Extract the parent folder path (e.g., /path/to/SentryClips/2024-01-15_10-30-00)
            const filePath = firstEntry.file.path;
            const lastSlash = filePath.lastIndexOf('/');
            const lastBackslash = filePath.lastIndexOf('\\');
            const lastSep = Math.max(lastSlash, lastBackslash);
            if (lastSep > 0) {
                folderPath = filePath.substring(0, lastSep);
            }
        }
    }
    
    const item = document.createElement('div');
    item.className = `clip-item event-item ${typeClass}-item`;
    item.dataset.groupid = coll.id;
    item.dataset.type = 'collection';
    if (folderPath) {
        item.dataset.folderpath = folderPath;
    }
    
    const segmentText = groups.length === 1 ? t('ui.clipBrowser.segment') : t('ui.clipBrowser.segments');
    const subline = `${groups.length} ${segmentText} · ${Math.max(1, cameras.length)} cam`;
    const badgeClass = typeClass;
    const badgeLabel = typeClass === 'custom'
        ? (coll.tag || 'Custom')
        : t(`ui.clipBrowser.${typeClass}`);
    
    // Build reason badge for SavedClips only (as text, not icon)
    let reasonBadge = '';
    if (typeClass === 'saved' && eventMeta?.reason && formatEventReason) {
        const reasonLabel = formatEventReason(eventMeta.reason);
        const alertClass = eventMeta.reason.includes('emergency') || eventMeta.reason.includes('collision') ? 'alert' : 'warning';
        reasonBadge = `<span class="badge reason-icon ${alertClass}" title="${escapeHtml(eventMeta.reason)}">${escapeHtml(reasonLabel)}</span>`;
    }
    
    // Only show delete button if we have a folder path (Electron mode)
    const deleteBtn = folderPath ? `
        <button class="clip-delete-btn" title="${escapeHtml(t('ui.clipBrowser.deleteClip'))}" data-folderpath="${escapeHtml(folderPath)}">
            <span class="material-symbols-outlined mi-sm">delete</span>
        </button>
    ` : '';
    
    item.innerHTML = `
        <div class="clip-meta clip-meta-full">
            <div class="clip-title">${escapeHtml(title)}</div>
            <div class="clip-badges">
                <span class="badge ${badgeClass}">${escapeHtml(badgeLabel)}</span>
                ${reasonBadge}
            </div>
            <div class="clip-sub">
                <div>${escapeHtml(subline)}</div>
            </div>
        </div>
        ${deleteBtn}
    `;
    
    // Add click handler for the main item (excluding delete button)
    item.onclick = (e) => {
        if (e.target.closest('.clip-delete-btn')) return;
        selectDayCollection?.(coll.key);
    };
    
    // Add click handler for delete button
    const deleteBtnEl = item.querySelector('.clip-delete-btn');
    if (deleteBtnEl) {
        deleteBtnEl.onclick = (e) => {
            e.stopPropagation();
            const path = deleteBtnEl.dataset.folderpath;
            if (path) {
                showDeleteConfirmModal(path, coll.id);
            }
        };
    }

    // Thumbnail hover preview for sentry/saved events
    if ((typeClass === 'sentry' || typeClass === 'saved') && folderPath) {
        attachThumbPreview(item, folderPath);
    }

    return item;
}

/**
 * Highlight the currently selected clip in the list.
 */
export function highlightSelectedClip() {
    const selection = getSelection?.();
    const state = getState?.();
    if (!clipList) return;
    
    for (const el of clipList.querySelectorAll('.clip-item')) {
        el.classList.toggle('selected', 
            el.dataset.groupid === selection?.selectedGroupId || 
            el.dataset.groupid === state?.collection?.active?.id
        );
    }
}


/**
 * Build display items for legacy Sentry collection mode.
 */
export function buildDisplayItems(eventMetaByKey = new Map()) {
    const library = getLibrary?.();
    if (!library?.clipGroups) return [];
    
    const items = [];
    const sentryBuckets = new Map();

    for (const g of library.clipGroups) {
        if (g.tag?.toLowerCase() === 'sentryclips' && g.eventId) {
            const key = `${g.tag}/${g.eventId}`;
            if (!sentryBuckets.has(key)) sentryBuckets.set(key, []);
            sentryBuckets.get(key).push(g);
        } else {
            items.push({ type: 'group', id: g.id, group: g });
        }
    }

    for (const [key, groups] of sentryBuckets.entries()) {
        groups.sort((a, b) => (a.timestampKey || '').localeCompare(b.timestampKey || ''));
        const [tag, eventId] = key.split('/');
        const id = `sentry:${key}`;

        const startEpochMs = parseTimestampKeyToEpochMs(groups[0]?.timestampKey) ?? 0;
        const lastStart = parseTimestampKeyToEpochMs(groups[groups.length - 1]?.timestampKey) ?? startEpochMs;
        const endEpochMs = lastStart + 60_000;
        const durationMs = Math.max(1, endEpochMs - startEpochMs);

        const segmentStartsMs = groups.map(g => {
            const t = parseTimestampKeyToEpochMs(g.timestampKey) ?? startEpochMs;
            return Math.max(0, t - startEpochMs);
        });

        const meta = groups[0]?.eventMeta || (eventMetaByKey.get(key) ?? null);
        let anchorMs = null;
        let anchorGroupId = groups[0].id;
        if (meta?.timestamp) {
            const eventEpoch = Date.parse(meta.timestamp);
            if (Number.isFinite(eventEpoch)) {
                anchorMs = Math.max(0, Math.min(durationMs, eventEpoch - startEpochMs));
                let anchorIdx = 0;
                for (let i = 0; i < segmentStartsMs.length; i++) {
                    if (segmentStartsMs[i] <= anchorMs) anchorIdx = i;
                }
                anchorGroupId = groups[anchorIdx]?.id || anchorGroupId;
            }
        }

        const sortEpoch = meta?.timestamp ? Date.parse(meta.timestamp) : lastStart;
        items.push({
            type: 'collection',
            id,
            sortEpoch: Number.isFinite(sortEpoch) ? sortEpoch : lastStart,
            collection: {
                id,
                key,
                tag,
                eventId,
                groups,
                meta,
                durationMs,
                segmentStartsMs,
                anchorMs,
                anchorGroupId
            }
        });
    }

    items.sort((a, b) => {
        const ta = a.type === 'collection'
            ? (a.sortEpoch ?? 0)
            : (parseTimestampKeyToEpochMs(a.group.timestampKey) ?? 0);
        const tb = b.type === 'collection'
            ? (b.sortEpoch ?? 0)
            : (parseTimestampKeyToEpochMs(b.group.timestampKey) ?? 0);
        return tb - ta;
    });

    return items;
}

/**
 * Parse timestamp key to epoch milliseconds (Tesla filenames are in vehicle local time).
 */
export function parseTimestampKeyToEpochMs(timestampKey) {
    const m = String(timestampKey || '').match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const [ , Y, Mo, D, h, mi, s ] = m;
    return new Date(+Y, +Mo - 1, +D, +h, +mi, +s, 0).getTime();
}

/**
 * Show delete confirmation modal (Step 1)
 */
function showDeleteConfirmModal(folderPath, collectionId) {
    // Remove existing modal if any
    const existingModal = document.getElementById('deleteConfirmModal');
    if (existingModal) existingModal.remove();
    
    const modal = document.createElement('div');
    modal.id = 'deleteConfirmModal';
    modal.className = 'modal';
    modal.innerHTML = `
        <div class="modal-content delete-confirm-modal">
            <div class="modal-header">
                <span class="material-symbols-outlined mi-lg">delete</span>
                <h2>${escapeHtml(t('ui.clipBrowser.deleteConfirmTitle'))}</h2>
                <button id="closeDeleteModal" class="modal-close">&times;</button>
            </div>
            <div class="modal-body modal-body-padded">
                <p class="delete-confirm-message">${escapeHtml(t('ui.clipBrowser.deleteConfirmMessage'))}</p>
                <div class="delete-confirm-path">
                    <span class="delete-path-label">${escapeHtml(t('ui.clipBrowser.deleteConfirmPath'))}</span>
                    <code class="delete-path-value">${escapeHtml(folderPath)}</code>
                </div>
                <p class="delete-confirm-warning">
                    <span class="material-symbols-outlined mi-sm">warning</span>
                    ${escapeHtml(t('ui.clipBrowser.deleteConfirmWarning'))}
                </p>
            </div>
            <div class="modal-footer">
                <button id="confirmDeleteBtn" class="btn btn-danger">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="margin-right: 6px;">
                        <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
                    </svg>
                    ${escapeHtml(t('ui.clipBrowser.deleteBtn'))}
                </button>
                <button id="cancelDeleteBtn" class="btn btn-secondary">${escapeHtml(t('ui.clipBrowser.cancelBtn'))}</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    const closeModal = () => modal.remove();
    
    document.getElementById('closeDeleteModal').onclick = closeModal;
    document.getElementById('cancelDeleteBtn').onclick = closeModal;
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };
    
    // First confirmation - show second confirmation modal
    document.getElementById('confirmDeleteBtn').onclick = () => {
        closeModal();
        showFinalDeleteConfirmModal(folderPath, collectionId);
    };
}

/**
 * Show final delete confirmation modal (Step 2 - "Are you sure?")
 */
function showFinalDeleteConfirmModal(folderPath, collectionId) {
    const modal = document.createElement('div');
    modal.id = 'deleteConfirmModal';
    modal.className = 'modal';
    modal.innerHTML = `
        <div class="modal-content delete-confirm-modal">
            <div class="modal-header">
                <span class="material-symbols-outlined mi-lg">error</span>
                <h2>${escapeHtml(t('ui.clipBrowser.deleteFinalConfirmTitle'))}</h2>
                <button id="closeDeleteModal" class="modal-close">&times;</button>
            </div>
            <div class="modal-body modal-body-padded">
                <p class="delete-confirm-message delete-final-message">${escapeHtml(t('ui.clipBrowser.deleteFinalConfirmMessage'))}</p>
                <div class="delete-confirm-path">
                    <code class="delete-path-value">${escapeHtml(folderPath)}</code>
                </div>
            </div>
            <div class="modal-footer">
                <button id="confirmDeleteBtn" class="btn btn-danger">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="margin-right: 6px;">
                        <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
                    </svg>
                    ${escapeHtml(t('ui.clipBrowser.deleteConfirmBtn'))}
                </button>
                <button id="cancelDeleteBtn" class="btn btn-secondary">${escapeHtml(t('ui.clipBrowser.cancelBtn'))}</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    const closeModal = () => modal.remove();
    
    document.getElementById('closeDeleteModal').onclick = closeModal;
    document.getElementById('cancelDeleteBtn').onclick = closeModal;
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };
    
    document.getElementById('confirmDeleteBtn').onclick = async () => {
        const confirmBtn = document.getElementById('confirmDeleteBtn');
        confirmBtn.disabled = true;
        confirmBtn.innerHTML = `
            <svg class="spinner" viewBox="0 0 24 24" width="14" height="14" style="margin-right: 6px;">
                <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" stroke-dasharray="31.4 31.4" stroke-linecap="round"/>
            </svg>
            Deleting...
        `;
        
        try {
            const state = getState?.();
            const isCurrentlyPlaying = state?.collection?.active?.id === collectionId;
            
            // If this is the currently playing clip, we need to reload the window to release file handles
            // Chromium's video decoder holds handles that can't be released from renderer
            if (isCurrentlyPlaying && window.electronAPI?.deleteFolderWithReload) {
                console.log('[DELETE] Currently playing clip - will reload window to release handles');
                closeModal();
                
                // Get base folder path for re-scanning after reload
                const basePath = getBaseFolderPath?.() || '';
                
                const result = await window.electronAPI.deleteFolderWithReload(folderPath, basePath);
                if (result.success && result.reloading) {
                    // Window will reload - deletion will happen after reload
                    return;
                } else if (!result.success) {
                    throw new Error(result.error || 'Failed to schedule deletion');
                }
            }
            
            // For non-playing clips, delete directly
            if (window.electronAPI?.deleteFolder) {
                const result = await window.electronAPI.deleteFolder(folderPath);
                
                if (result.success) {
                    closeModal();
                    // Notify parent to refresh the clip list
                    if (onClipDeleted) {
                        onClipDeleted(collectionId, folderPath, false);
                    }
                    // Show success notification
                    notify(t('ui.clipBrowser.deleteSuccess'), { type: 'success' });
                } else {
                    throw new Error(result.error || 'Unknown error');
                }
            } else {
                throw new Error('Delete not available');
            }
        } catch (err) {
            console.error('Failed to delete clip:', err);
            notify(`${t('ui.clipBrowser.deleteFailed')}: ${err.message}`, { type: 'error' });
            confirmBtn.disabled = false;
            confirmBtn.innerHTML = `
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="margin-right: 6px;">
                    <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
                </svg>
                ${escapeHtml(t('ui.clipBrowser.deleteConfirmBtn'))}
            `;
        }
    };
}

// Cache of folder paths we've already checked for thumb.png
const thumbExistsCache = new Map();

export function clearThumbnailCache() {
    thumbExistsCache.clear();
}

/**
 * Attach a thumbnail hover preview to a clip item.
 * Shows thumb.png from the event folder on mouseenter.
 */
function attachThumbPreview(item, folderPath) {
    let tooltip = null;
    let hideTimeout = null;
    let hovering = false;

    const sep = folderPath.includes('\\') ? '\\' : '/';
    const thumbPath = folderPath + sep + 'thumb.png';

    item.addEventListener('mouseenter', async (e) => {
        hovering = true;
        clearTimeout(hideTimeout);

        // Check cache first
        if (thumbExistsCache.has(thumbPath)) {
            if (!thumbExistsCache.get(thumbPath)) return; // known missing
        } else if (window.electronAPI?.exists) {
            const exists = await window.electronAPI.exists(thumbPath);
            thumbExistsCache.set(thumbPath, exists);
            if (!exists) return;
        } else {
            return; // no API to check
        }

        // If mouse left during the async check, don't show
        if (!hovering) return;

        // If the item was removed from the DOM during the async check, don't show
        if (!document.body.contains(item)) return;

        // Create tooltip if not already present
        if (!tooltip) {
            tooltip = document.createElement('div');
            tooltip.className = 'clip-thumb-tooltip';
            const img = document.createElement('img');
            img.src = filePathToUrl(thumbPath);
            img.alt = 'Thumbnail';
            img.onerror = () => {
                thumbExistsCache.set(thumbPath, false);
                if (tooltip) { tooltip.remove(); tooltip = null; }
            };
            tooltip.appendChild(img);
        }

        document.body.appendChild(tooltip);
        positionTooltip(tooltip, item);
    });

    item.addEventListener('mouseleave', () => {
        hovering = false;
        hideTimeout = setTimeout(() => {
            if (tooltip && tooltip.parentNode) tooltip.remove();
        }, 80);
    });
}

/**
 * Position the thumbnail tooltip next to a clip item.
 */
function positionTooltip(tooltip, anchor) {
    const rect = anchor.getBoundingClientRect();
    // Position to the right of the clip list item
    tooltip.style.top = `${rect.top}px`;
    tooltip.style.left = `${rect.right + 8}px`;

    // After rendering, check if it overflows the viewport and adjust
    requestAnimationFrame(() => {
        const tr = tooltip.getBoundingClientRect();
        // If overflows right edge, show on left side instead
        if (tr.right > window.innerWidth - 8) {
            tooltip.style.left = `${rect.left - tr.width - 8}px`;
        }
        // If overflows bottom, shift up
        if (tr.bottom > window.innerHeight - 8) {
            tooltip.style.top = `${window.innerHeight - tr.height - 8}px`;
        }
    });
}
