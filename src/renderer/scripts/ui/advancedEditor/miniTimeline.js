// Advanced Editor — mini-timeline.
// Range is locked to the export window (startSec..endSec). Scrubber uses
// 0..1000 ticks for sub-second precision; values are mapped to seconds.

import { advancedEditorState } from './state.js';
import {
    togglePlayPause, seekCumulative,
    getDuration, getStartSec, getEndSec, getCurrentSec
} from './videoSync.js';

let playBtn, scrubber, currentTimeLabel, durationLabel, modalEl;
let initialized = false;

export function initMiniTimeline() {
    if (initialized) return;
    initialized = true;
    playBtn = document.getElementById('aePlayPauseBtn');
    scrubber = document.getElementById('aeScrubber');
    currentTimeLabel = document.getElementById('aeCurrentTime');
    durationLabel = document.getElementById('aeDuration');
    modalEl = document.getElementById('advancedEditorModal');

    if (playBtn) {
        playBtn.addEventListener('click', () => {
            togglePlayPause();
            updatePlayIcon();
        });
    }

    if (scrubber) {
        scrubber.addEventListener('pointerdown', () => {
            advancedEditorState.playback.isUserScrubbing = true;
        });
        scrubber.addEventListener('pointerup', () => {
            advancedEditorState.playback.isUserScrubbing = false;
        });
        scrubber.addEventListener('input', () => {
            const tick = parseInt(scrubber.value, 10) || 0;
            const sec = getStartSec() + (tick / 1000) * getDuration();
            seekCumulative(sec);
            updateLabels(sec);
        });
    }

    // Space toggles play/pause when AE is open + focus is inside the modal.
    if (modalEl) {
        modalEl.addEventListener('keydown', (e) => {
            if (e.key === ' ' || e.code === 'Space') {
                const tag = (document.activeElement?.tagName || '').toLowerCase();
                if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
                e.preventDefault();
                togglePlayPause();
                updatePlayIcon();
            }
        });
    }
}

// Called every animation tick from videoSync.
export function onPlaybackTick(currentSec) {
    if (!advancedEditorState.playback.isUserScrubbing && scrubber) {
        const duration = getDuration();
        if (duration > 0) {
            const tick = Math.round(((currentSec - getStartSec()) / duration) * 1000);
            scrubber.value = String(Math.max(0, Math.min(1000, tick)));
        }
    }
    updateLabels(currentSec);
}

export function refreshAfterLoad() {
    // Called after loadVideosForCanvas; update labels with the new range.
    updateLabels(getCurrentSec());
    if (scrubber) scrubber.value = '0';
    updatePlayIcon();
}

function updateLabels(currentSec) {
    if (currentTimeLabel) currentTimeLabel.textContent = formatTime(currentSec - getStartSec());
    if (durationLabel)    durationLabel.textContent = formatTime(getDuration());
}

function updatePlayIcon() {
    if (!playBtn) return;
    const icon = playBtn.querySelector('.material-symbols-outlined');
    if (!icon) return;
    icon.textContent = advancedEditorState.playback.isPlaying ? 'pause' : 'play_arrow';
}

function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const s = Math.floor(sec);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}
