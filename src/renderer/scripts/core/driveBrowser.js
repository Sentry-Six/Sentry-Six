/**
 * Drive Browser Module
 * Renders the SentryUSB drives list panel and handles drive selection.
 */

import { escapeHtml } from '../lib/utils.js';
import { formatDriveDuration, formatDriveDistance } from './driveGrouper.js';

// Injected dependencies
let getState = null;
let getDriveState = null;
let driveList = null;
let onDriveSelected = null;
let getUseMetric = null;
let getShowDriveStats = null;

/**
 * Initialize the drive browser with dependencies.
 */
export function initDriveBrowser(deps) {
    getState = deps.getState;
    getDriveState = deps.getDriveState;
    driveList = deps.driveList;
    onDriveSelected = deps.onDriveSelected;
    getUseMetric = deps.getUseMetric;
    getShowDriveStats = deps.getShowDriveStats ?? (() => true);
}

// Active filter state
let activeTagFilter = '';
let selectedDriveId = null;

/**
 * Render the full drives list.
 * Efficient: only re-renders when called (not reactive).
 */
export function renderDriveList() {
    if (!driveList) return;

    const driveState = getDriveState?.();
    // Loading state: show while a parse/group is in-flight so the user knows
    // something is happening (a large drive-data.json on a slow disk can take
    // tens of seconds to stream + group).
    if (driveState?.loading) {
        driveList.innerHTML = `
            <div class="drive-list-placeholder drive-list-loading">
                <div class="loading-spinner"></div>
                <p class="drive-no-data-title" style="margin-top:14px">Loading drive data…</p>
                <p class="drive-no-data-desc">Streaming and grouping routes. Large drive-data.json files (1GB+) can take a minute.</p>
            </div>`;
        return;
    }
    if (!driveState?.loaded || !driveState.drives?.length) {
        driveList.innerHTML = `
            <div class="drive-list-placeholder drive-list-no-data">
                <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity:0.4;margin-bottom:10px;">
                    <rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M6 14h.01M10 10h4M10 14h4"/>
                </svg>
                <p class="drive-no-data-title">No drive data loaded</p>
                <p class="drive-no-data-desc">SentryUSB Drive Data shows your full driving history with GPS routes, speed, and FSD stats. Requires a SentryUSB <code>drive-data.json</code> file.</p>
                <button class="btn btn-secondary btn-small drive-select-file-btn" onclick="document.getElementById('browseDriveDataFileBtn')?.click()">Select drive-data.json</button>
                <a href="https://sentry-six.com/sentry-usb" target="_blank" class="drive-learn-more-link">Learn more about SentryUSB</a>
            </div>`;
        return;
    }

    const { drives, hasFootage } = driveState;
    const useMetric = getUseMetric?.() ?? false;

    // Apply tag filter
    const filtered = activeTagFilter
        ? drives.filter(d => d.tags.some(t => t.toLowerCase().includes(activeTagFilter.toLowerCase())))
        : drives;

    // Group by date (YYYY-MM-DD)
    const byDate = new Map();
    for (const drive of filtered) {
        if (!byDate.has(drive.date)) byDate.set(drive.date, []);
        byDate.get(drive.date).push(drive);
    }

    // Sort dates descending (newest first)
    const sortedDates = Array.from(byDate.keys()).sort((a, b) => b.localeCompare(a));

    driveList.innerHTML = '';

    if (sortedDates.length === 0) {
        driveList.innerHTML = `<div class="drive-list-placeholder">No drives match the current filter.</div>`;
        return;
    }

    for (const date of sortedDates) {
        // Date group header
        const dateHeader = document.createElement('div');
        dateHeader.className = 'drive-date-header';
        dateHeader.textContent = formatDateDisplay(date);
        driveList.appendChild(dateHeader);

        const dayDrives = byDate.get(date);
        // Sort drives within a day latest → earliest (newest at top)
        dayDrives.sort((a, b) => b.startMs - a.startMs);
        for (const drive of dayDrives) {
            const item = createDriveItem(drive, hasFootage?.has(drive.id) ?? false, useMetric);
            driveList.appendChild(item);
        }
    }

    highlightSelectedDrive();
}

/**
 * Create a single drive list item element.
 */
function createDriveItem(drive, hasClips, useMetric) {
    const item = document.createElement('div');
    item.className = 'drive-item';
    item.dataset.driveId = String(drive.id);

    const durationStr = formatDriveDuration(drive.durationMs);
    const distanceStr = formatDriveDistance(drive, useMetric);
    const timeRange = `${formatDriveTimeMs(drive.startMs)} – ${formatDriveTimeMs(drive.endMs)}`;
    const clipCount = `${drive.clipCount} clip${drive.clipCount !== 1 ? 's' : ''}`;
    const showStats = getShowDriveStats?.() ?? true;

    // Footage badge
    const footageBadge = hasClips
        ? `<span class="badge drive-footage-badge" title="Footage available">Footage</span>`
        : '';

    // FSD badge with percentage
    const fsdBadge = drive.hasFsd
        ? `<span class="badge drive-fsd-badge" title="${Math.round(drive.fsdPercent)}% of clips with FSD active">FSD ${Math.round(drive.fsdPercent)}%</span>`
        : '';

    // Tag badges (max 3)
    const tagBadges = drive.tags.slice(0, 3).map(tag =>
        `<span class="badge drive-tag-badge">${escapeHtml(tag)}</span>`
    ).join('');

    // Accel pushes + FSD disengagements (shown when stats toggle is on)
    const accelStat = showStats && drive.accelPushCount > 0
        ? `<span class="drive-stat drive-stat-muted" title="Accelerator overrides while FSD active">
               <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" stroke="none">
                   <path d="M11 21h-1l1-7H7.5c-.88 0-.33-.75-.31-.78C8.27 10.87 10.42 7.28 13 3h1l-1 7h3.5c.49 0 .56.33.47.51L11 21z"/>
               </svg>
               ${drive.accelPushCount}
           </span>`
        : '';
    const disengageStat = showStats && drive.fsdDisengagements > 0
        ? `<span class="drive-stat drive-stat-muted" title="FSD disengagements">
               <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" stroke="none">
                   <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
               </svg>
               ${drive.fsdDisengagements}
           </span>`
        : '';

    item.innerHTML = `
        <div class="drive-item-main">
            <div class="drive-item-time">${escapeHtml(timeRange)}</div>
            <div class="drive-item-stats">
                <span class="drive-stat">
                    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                    </svg>
                    ${escapeHtml(durationStr)}
                </span>
                <span class="drive-stat">
                    <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" stroke="none">
                        <path d="M12 2L4.5 20.3l.5.2L12 17l7 3.5.5-.2z"/>
                    </svg>
                    ${escapeHtml(distanceStr)}
                </span>
                <span class="drive-stat drive-stat-muted">${escapeHtml(clipCount)}</span>
                ${accelStat}${disengageStat}
            </div>
            <div class="drive-item-badges">
                ${footageBadge}${fsdBadge}${tagBadges}
            </div>
        </div>
    `;

    item.onclick = () => {
        selectedDriveId = drive.id;
        highlightSelectedDrive();
        onDriveSelected?.(drive);
    };

    return item;
}

/**
 * Highlight the currently selected drive.
 */
export function highlightSelectedDrive() {
    if (!driveList) return;
    for (const el of driveList.querySelectorAll('.drive-item')) {
        el.classList.toggle('selected', el.dataset.driveId === String(selectedDriveId));
    }
}

/**
 * Set the tag filter and re-render.
 */
export function setDriveTagFilter(tag) {
    activeTagFilter = tag || '';
    renderDriveList();
}

/**
 * Update the drive list subtitle/status in the header.
 */
export function updateDriveBrowserStatus(statusEl) {
    if (!statusEl) return;
    const driveState = getDriveState?.();
    if (!driveState?.loaded) {
        statusEl.textContent = 'No drive data';
        return;
    }
    const { drives, hasFootage } = driveState;
    const footageCount = hasFootage?.size ?? 0;
    const oldest = drives[0]?.date ?? '';
    const newest = drives[drives.length - 1]?.date ?? '';
    const dateRange = oldest === newest ? oldest : `${oldest} – ${newest}`;
    const footagePart = footageCount > 0 ? ` · ${footageCount} with footage` : ' · load matching clips folder';
    statusEl.textContent = `${drives.length} drive${drives.length !== 1 ? 's' : ''} · ${dateRange}${footagePart}`;
}

/**
 * Format an epoch ms timestamp as HH:MM (or h:MM AM/PM) using the user's time format preference.
 */
function formatDriveTimeMs(ms) {
    if (!ms) return '--:--';
    const d = new Date(ms);
    const h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    if ((window._timeFormat ?? '12h') === '12h') {
        const ampm = h >= 12 ? 'PM' : 'AM';
        const h12 = h % 12 || 12;
        return `${h12}:${m} ${ampm}`;
    }
    return `${String(h).padStart(2, '0')}:${m}`;
}

/**
 * Format a YYYY-MM-DD string as a display date.
 */
function formatDateDisplay(dateStr) {
    if (!dateStr || dateStr.length < 10) return dateStr;
    try {
        const [y, m, d] = dateStr.split('-').map(Number);
        return new Date(y, m - 1, d).toLocaleDateString(undefined, {
            weekday: 'short', year: 'numeric', month: 'short', day: 'numeric'
        });
    } catch {
        return dateStr;
    }
}
