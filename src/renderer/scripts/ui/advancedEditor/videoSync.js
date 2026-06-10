// Advanced Editor — multi-camera video sync.
//
// Spawns up to 6 fresh <video> elements (one per selected camera), inside
// their tile containers on the canvas. Drives them from a shared cumulative
// playhead in seconds. Master = front (or first available); other cameras
// follow master.currentTime with drift correction.

import { advancedEditorState } from './state.js';
import { filePathToUrl } from '../../lib/utils.js';
import { extractSeiFromEntry } from '../../core/seiExtractor.js';

const DRIFT_THRESHOLD_SEC = 0.15;
let depsRef = null;
let onTickCb = null;
let segments = [];           // [{ index, files: {camera: url}, duration }]
let cumStarts = [];          // length = segments.length + 1
let totalSec = 0;
let currentSegIdx = -1;
let masterCamera = null;

export function initVideoSync(deps, options = {}) {
    depsRef = deps;
    onTickCb = options.onTick || null;
}

// Build segment list from the loaded clip + camera selection. Mounts <video>
// elements inside each camera tile and seeks to startSec.
export async function loadVideosForCanvas({ cameras, startSec, endSec }) {
    disposeVideos();

    const state = depsRef?.getState?.();
    const nativeVideo = depsRef?.getNativeVideo?.();
    const active = state?.collection?.active;
    if (!active || !nativeVideo) {
        console.warn('[AE] No active clip or nativeVideo for loadVideosForCanvas');
        return;
    }

    const groups = active.groups || [];
    if (groups.length === 0) return;

    // Build per-segment URL map keyed by camera.
    segments = [];
    for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        const files = {};
        for (const camera of cameras) {
            const entry = g.filesByCamera?.get(camera);
            if (!entry) continue;
            const url = getEntryUrl(entry);
            if (url) files[camera] = url;
        }
        segments.push({ index: i, files });
    }

    // Mirror nativeVideo's cumulativeStarts so seek math is identical.
    cumStarts = (nativeVideo.cumulativeStarts || []).slice();
    if (cumStarts.length === 0) {
        // Fallback: assume 60s per segment.
        let cum = 0;
        cumStarts.push(0);
        for (let i = 0; i < segments.length; i++) {
            cum += 60;
            cumStarts.push(cum);
        }
    }
    totalSec = cumStarts[cumStarts.length - 1] || 60;

    // Clamp playback range.
    advancedEditorState.playback.startSec = Math.max(0, Math.min(startSec ?? 0, totalSec));
    advancedEditorState.playback.endSec = Math.max(
        advancedEditorState.playback.startSec + 0.1,
        Math.min(endSec ?? totalSec, totalSec)
    );
    advancedEditorState.playback.currentSec = advancedEditorState.playback.startSec;

    // Pick master: front if present, else first available.
    masterCamera = cameras.has('front') ? 'front' : [...cameras][0] || null;
    advancedEditorState.playback.masterVideoSlot = masterCamera;

    // Create video elements inside tiles.
    for (const camera of cameras) {
        const tileEl = document.querySelector(
            `.ae-tile[data-tile-type="camera"][data-tile-name="${camera}"]`
        );
        if (!tileEl) continue;
        // Remove placeholder.
        tileEl.querySelectorAll('.ae-tile-video-placeholder').forEach(el => el.remove());

        const vid = document.createElement('video');
        vid.className = 'ae-tile-video';
        vid.muted = true;
        vid.playsInline = true;
        vid.preload = 'metadata';
        vid.crossOrigin = 'anonymous';

        // Mirror back/repeater cameras to match main app behaviour.
        if (['back', 'left_repeater', 'right_repeater'].includes(camera)) {
            vid.classList.add('mirrored');
        }

        // Insert before resize handles so handles stay clickable.
        const firstHandle = tileEl.querySelector('.ae-handle');
        if (firstHandle) tileEl.insertBefore(vid, firstHandle);
        else tileEl.appendChild(vid);

        advancedEditorState.videoElements.set(camera, vid);
    }

    // Load segment containing startSec.
    currentSegIdx = findSegmentIdx(advancedEditorState.playback.startSec);
    if (currentSegIdx < 0) currentSegIdx = 0;
    await loadSegment(currentSegIdx);

    // Seek to local offset within the loaded segment.
    const offset = advancedEditorState.playback.startSec - (cumStarts[currentSegIdx] || 0);
    seekAllLocal(offset);

    // Kick off per-segment SEI extraction (fire-and-forget). Each segment's
    // result lands in advancedEditorState.aeSeiBySegment as it completes;
    // overlay updates read from that map and silently skip until the data
    // is present. The first/active segment is extracted first so the dashboard
    // populates correctly within a frame or two of the user opening AE.
    extractSeiForSegmentsInRange(groups, currentSegIdx).catch(err =>
        console.warn('[AE] Per-segment SEI extraction failed:', err)
    );
}

export function disposeVideos() {
    pause();
    if (advancedEditorState.playback.rafId) {
        cancelAnimationFrame(advancedEditorState.playback.rafId);
        advancedEditorState.playback.rafId = null;
    }
    for (const vid of advancedEditorState.videoElements.values()) {
        try {
            vid.pause();
            vid.removeAttribute('src');
            vid.load();
            vid.remove();
        } catch {}
    }
    advancedEditorState.videoElements.clear();
    advancedEditorState.aeSeiBySegment.clear();
    segments = [];
    cumStarts = [];
    totalSec = 0;
    currentSegIdx = -1;
    masterCamera = null;
}

async function extractSeiForSegmentsInRange(groups, priorityIdx) {
    advancedEditorState.aeSeiBySegment.clear();

    // Determine which segments fall inside the AE export range; we don't waste
    // time extracting segments the user can't scrub to.
    const startSec = advancedEditorState.playback.startSec;
    const endSec = advancedEditorState.playback.endSec;
    const inRange = [];
    for (let i = 0; i < groups.length; i++) {
        const segStart = cumStarts[i] || 0;
        const segEnd = cumStarts[i + 1] || totalSec;
        if (segEnd > startSec && segStart < endSec) inRange.push(i);
    }

    // Extract the priority segment first so the overlays light up immediately
    // for the visible playhead, then the rest in order.
    const order = [
        priorityIdx,
        ...inRange.filter(i => i !== priorityIdx)
    ].filter(i => groups[i]);

    for (const i of order) {
        const group = groups[i];
        const masterCam = masterCamera || 'front';
        const entry = group.filesByCamera?.get(masterCam)
            || group.filesByCamera?.values().next().value;
        if (!entry) continue;
        try {
            const { seiData } = await extractSeiFromEntry(entry, null);
            if (Array.isArray(seiData) && seiData.length > 0) {
                advancedEditorState.aeSeiBySegment.set(i, seiData);
                // If this segment is the one the playhead is on, fire an
                // out-of-band tick so the overlays refresh immediately —
                // without this the dashboard sits on stale clone values
                // until the user next presses play or scrubs.
                const cur = advancedEditorState.playback.currentSec || 0;
                const curSeg = findSegmentIdx(cur);
                if (i === curSeg && onTickCb) onTickCb(cur);
            }
        } catch (err) {
            console.warn('[AE] SEI extract failed for segment', i, err);
        }
    }
}

export function play() {
    if (!masterCamera) return;
    const master = advancedEditorState.videoElements.get(masterCamera);
    if (!master) return;
    master.play().catch(err => console.warn('[AE] master play failed:', err));
    for (const [cam, vid] of advancedEditorState.videoElements.entries()) {
        if (cam !== masterCamera) vid.play().catch(() => {});
    }
    advancedEditorState.playback.isPlaying = true;
    startRaf();
}

export function pause() {
    for (const vid of advancedEditorState.videoElements.values()) {
        try { vid.pause(); } catch {}
    }
    advancedEditorState.playback.isPlaying = false;
}

export function togglePlayPause() {
    if (advancedEditorState.playback.isPlaying) pause();
    else play();
}

// Seek to a cumulative second across all cameras. Handles cross-segment seeks.
export async function seekCumulative(sec) {
    const startSec = advancedEditorState.playback.startSec;
    const endSec = advancedEditorState.playback.endSec;
    const clamped = Math.max(startSec, Math.min(endSec, sec));

    const segIdx = findSegmentIdx(clamped);
    if (segIdx < 0) return;

    if (segIdx !== currentSegIdx) {
        const wasPlaying = advancedEditorState.playback.isPlaying;
        if (wasPlaying) pause();
        currentSegIdx = segIdx;
        await loadSegment(segIdx);
        if (wasPlaying) play();
    }

    const offset = clamped - (cumStarts[segIdx] || 0);
    seekAllLocal(offset);
    advancedEditorState.playback.currentSec = clamped;
    if (onTickCb) onTickCb(clamped);
}

export function getDuration() {
    return advancedEditorState.playback.endSec - advancedEditorState.playback.startSec;
}

export function getCurrentSec() {
    return advancedEditorState.playback.currentSec;
}

export function getStartSec() { return advancedEditorState.playback.startSec; }
export function getEndSec()   { return advancedEditorState.playback.endSec; }

// --------------------------------------------------------------------------
// Internal helpers
// --------------------------------------------------------------------------

function getEntryUrl(entry) {
    if (!entry || !entry.file) return null;
    if (entry.file.isElectronFile && entry.file.path) {
        return filePathToUrl(entry.file.path);
    }
    if (entry.file instanceof File) {
        return URL.createObjectURL(entry.file);
    }
    if (entry.file.path) {
        return filePathToUrl(entry.file.path);
    }
    return null;
}

function findSegmentIdx(cumSec) {
    if (cumStarts.length < 2) return 0;
    for (let i = 0; i < cumStarts.length - 1; i++) {
        if (cumSec >= cumStarts[i] && cumSec < cumStarts[i + 1]) return i;
    }
    return cumStarts.length - 2;
}

async function loadSegment(segIdx) {
    const seg = segments[segIdx];
    if (!seg) return;
    const promises = [];
    for (const [camera, vid] of advancedEditorState.videoElements.entries()) {
        const url = seg.files[camera];
        if (!url) { vid.removeAttribute('src'); continue; }
        if (vid.src !== url) {
            vid.src = url;
            promises.push(new Promise((resolve) => {
                const cleanup = () => {
                    vid.removeEventListener('loadedmetadata', cleanup);
                    vid.removeEventListener('error', cleanup);
                    resolve();
                };
                vid.addEventListener('loadedmetadata', cleanup, { once: true });
                vid.addEventListener('error', cleanup, { once: true });
            }));
        }
    }
    await Promise.all(promises);
}

function seekAllLocal(localSec) {
    for (const vid of advancedEditorState.videoElements.values()) {
        try {
            if (vid.readyState >= 1) vid.currentTime = localSec;
            else vid.addEventListener('loadedmetadata',
                () => { vid.currentTime = localSec; }, { once: true });
        } catch {}
    }
}

function startRaf() {
    if (advancedEditorState.playback.rafId) cancelAnimationFrame(advancedEditorState.playback.rafId);
    const tick = async () => {
        if (!advancedEditorState.playback.isPlaying) {
            advancedEditorState.playback.rafId = null;
            return;
        }
        const master = advancedEditorState.videoElements.get(masterCamera);
        if (!master) { advancedEditorState.playback.rafId = null; return; }

        const cur = (cumStarts[currentSegIdx] || 0) + master.currentTime;

        // Auto-pause at endSec.
        if (cur >= advancedEditorState.playback.endSec) {
            pause();
            await seekCumulative(advancedEditorState.playback.endSec);
            return;
        }

        // Advance to next segment when master reaches end of current.
        const segEnd = cumStarts[currentSegIdx + 1] || totalSec;
        if (cur >= segEnd - 0.05 && currentSegIdx + 1 < segments.length) {
            // Move to next segment seamlessly.
            const wasPlaying = advancedEditorState.playback.isPlaying;
            pause();
            currentSegIdx += 1;
            await loadSegment(currentSegIdx);
            seekAllLocal(0);
            if (wasPlaying) play();
            return;
        }

        // Drift correction: pull followers toward master.
        for (const [cam, vid] of advancedEditorState.videoElements.entries()) {
            if (cam === masterCamera) continue;
            if (vid.readyState >= 1 && Math.abs(vid.currentTime - master.currentTime) > DRIFT_THRESHOLD_SEC) {
                try { vid.currentTime = master.currentTime; } catch {}
            }
        }

        advancedEditorState.playback.currentSec = cur;
        if (onTickCb) onTickCb(cur);

        advancedEditorState.playback.rafId = requestAnimationFrame(tick);
    };
    advancedEditorState.playback.rafId = requestAnimationFrame(tick);
}
