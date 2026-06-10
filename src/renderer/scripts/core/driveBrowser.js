/**
 * Drive Browser Module
 * Renders the SentryUSB drives list panel and handles drive selection.
 */

import { escapeHtml } from '../lib/utils.js';
import { formatDriveDistance } from './driveGrouper.js';

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
 * Mirrors Sentry Drive's list card: journey times with origin/destination
 * pins, Departed/Arrived labels, reverse-geocoded place names, a red
 * disengagement row, and pill chips (distance, duration, FSD, footage).
 */
function createDriveItem(drive, hasClips, useMetric) {
    const item = document.createElement('div');
    item.className = 'drive-item';
    item.dataset.driveId = String(drive.id);

    const startTime = formatDriveTimeMs(drive.startMs);
    const endTime = formatDriveTimeMs(drive.endMs);
    const durStr = formatJourneyDuration(drive.durationMs);
    const distanceStr = formatDriveDistance(drive, useMetric);
    const showStats = getShowDriveStats?.() ?? true;

    // Place name if already resolved, else GPS coords as a fallback until
    // reverse-geocoding fills it in (see applyDriveLocations).
    const startPlace = drive._startName || gpsLabel(drive.startPoint);
    const endPlace = drive._endName || gpsLabel(drive.endPoint);

    const disengagements = drive.fsdDisengagements ?? 0;
    const disengageHtml = disengagements > 0
        ? `<div class="drive-diseng"><span class="material-symbols-outlined">warning</span>${disengagements} disengagement${disengagements !== 1 ? 's' : ''}</div>`
        : '';

    // FSD chip tone matches Sentry Drive: green >= 95%, accent 50-94%, slate below
    const fsd = drive.fsdPercent ?? 0;
    const fsdTone = fsd >= 95 ? 'drive-chip--green' : fsd >= 50 ? 'drive-chip--accent' : 'drive-chip--slate';
    const fsdChip = drive.hasFsd
        ? `<span class="drive-chip ${fsdTone}"><span class="material-symbols-outlined">auto_awesome</span>FSD ${fsd}%</span>`
        : '';

    const footageChip = hasClips
        ? `<span class="drive-chip drive-chip--green" title="Footage available — click to play"><span class="material-symbols-outlined">videocam</span>Footage</span>`
        : '';

    const accelChip = showStats && drive.accelPushCount > 0
        ? `<span class="drive-chip drive-chip--slate" title="Accelerator overrides while FSD active"><span class="material-symbols-outlined">bolt</span>${drive.accelPushCount}</span>`
        : '';

    const tagPills = (drive.tags ?? []).map(tag =>
        `<span class="tag-pill">${escapeHtml(tag)}</span>`
    ).join('');
    const tagsRow = tagPills ? `<div class="drive-tags">${tagPills}</div>` : '';

    item.innerHTML = `
        <div class="drive-journey">
            <div class="journey-times">
                <span class="jt-time">${escapeHtml(startTime)}</span>
                <span class="journey-track"><span class="jt-pin jt-pin--origin"></span><span class="jt-dash"></span><span class="jt-pin jt-pin--dest"></span></span>
                <span class="jt-time">${escapeHtml(endTime)}</span>
            </div>
            <div class="journey-labels">
                <span class="jt-label">Departed</span>
                <span class="jt-label">Arrived</span>
            </div>
            <div class="journey-locs">
                <span class="ep-place ep-place--start" data-ep="origin">${escapeHtml(startPlace)}</span>
                <span class="ep-place ep-place--end" data-ep="dest">${escapeHtml(endPlace)}</span>
            </div>
        </div>
        ${disengageHtml}
        <div class="drive-chips">
            <span class="drive-chip"><span class="material-symbols-outlined">straighten</span>${escapeHtml(distanceStr)}</span>
            <span class="drive-chip"><span class="material-symbols-outlined">schedule</span>${escapeHtml(durStr)}</span>
            ${fsdChip}${footageChip}${accelChip}
        </div>
        ${tagsRow}
    `;

    item.onclick = () => {
        selectedDriveId = drive.id;
        highlightSelectedDrive();
        onDriveSelected?.(drive);
    };

    // Resolve Departed/Arrived place names lazily when the card scrolls into
    // view — geocoding all 800+ drives up front would queue ~30 minutes of
    // rate-limited Nominatim lookups.
    item._drive = drive;
    observeForGeocoding(item);

    return item;
}

/** Duration in Sentry Drive's list format: "17 min" or "1h 2m". */
function formatJourneyDuration(ms) {
    const totalMin = Math.floor(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h > 0 ? `${h}h ${m}m` : `${m} min`;
}

/** Coordinate fallback label shown until reverse geocoding resolves. */
function gpsLabel(point) {
    return Array.isArray(point) ? `${point[0].toFixed(4)}, ${point[1].toFixed(4)}` : '';
}

function setEndpointLabel(item, role, name) {
    const place = item.querySelector(`.ep-place[data-ep="${role}"]`);
    if (place) place.textContent = name;
}

/**
 * Resolve start/end place names into the location line under each
 * Departed/Arrived header. Names cache on the drive object so re-renders
 * apply instantly; the main process caches across sessions (geocode.cjs).
 */
function applyDriveLocations(item, drive) {
    const api = window.electronAPI;
    const resolve = (role) => {
        const cacheKey = role === 'origin' ? '_startName' : '_endName';
        if (drive[cacheKey]) { setEndpointLabel(item, role, drive[cacheKey]); return; }
        const c = role === 'origin' ? drive.startPoint : drive.endPoint;
        if (!Array.isArray(c) || !api?.reverseGeocode) return;
        api.reverseGeocode({ lat: c[0], lng: c[1] }).then((res) => {
            const name = res && res.label;
            if (!name) return;
            drive[cacheKey] = name;
            if (item.isConnected) setEndpointLabel(item, role, name);
        }).catch(() => {});
    };
    resolve('origin');
    resolve('dest');
}

// Geocode only cards near the viewport (Nominatim allows 1 req/s).
let geocodeObserver = null;
function observeForGeocoding(item) {
    if (!window.electronAPI?.reverseGeocode) return;
    if (!geocodeObserver) {
        geocodeObserver = new IntersectionObserver((entries) => {
            for (const e of entries) {
                if (!e.isIntersecting) continue;
                geocodeObserver.unobserve(e.target);
                if (e.target._drive) applyDriveLocations(e.target, e.target._drive);
            }
        }, { root: driveList, rootMargin: '300px' });
    }
    geocodeObserver.observe(item);
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
