/**
 * TeslaCam Index Builder
 * Parses Tesla dashcam folder structures and builds clip group indexes
 */

import { yieldToUI } from '../ui/loadingOverlay.js';
import { t } from '../lib/i18n.js';
import {
    getCameraLabel,
    getDashcamProfile,
    parseDashcamFilename
} from '../../../shared/dashcamProfiles.mjs';
import { buildDashcamCollections } from '../../../shared/dashcamCollections.mjs';

export function getRootFolderNameFromWebkitRelativePath(relPath) {
    if (!relPath || typeof relPath !== 'string') return null;
    const parts = relPath.split('/').filter(Boolean);
    return parts.length ? parts[0] : null;
}

export function getBestEffortRelPath(file, directoryName = null) {
    // 1) webkitdirectory input provides webkitRelativePath
    if (file?.webkitRelativePath) return file.webkitRelativePath;

    // 2) directory drop traversal: our helper stores entry.fullPath on the File as _teslaPath
    //    Example: "/TeslaCam/RecentClips/2025-...-front.mp4"
    const p = file?._teslaPath;
    if (typeof p === 'string' && p.length) {
        return p.startsWith('/') ? p.slice(1) : p;
    }

    // 3) fall back to whatever we know
    return directoryName ? `${directoryName}/${file.name}` : file.name;
}

export function parseTeslaCamPath(relPath) {
    const norm = (relPath || '').replace(/\\/g, '/');
    const parts = norm.split('/').filter(Boolean);

    // Known clip folder names (case-insensitive)
    const clipFolders = ['recentclips', 'sentryclips', 'savedclips'];
    
    // Find any known parent folder (TeslaCam, teslausb, or any folder containing clip subfolders)
    // First, look for a clip folder directly in the path
    const clipFolderIdx = parts.findIndex(p => clipFolders.includes(p.toLowerCase()));
    if (clipFolderIdx >= 0) {
        // Found a clip folder - use it as the tag
        const tag = parts[clipFolderIdx];
        const rest = parts.slice(clipFolderIdx + 1);
        return { tag, rest };
    }

    // Legacy: Find "TeslaCam" or "teslausb" segment if present
    const knownRoots = ['teslacam', 'teslausb'];
    const rootIdx = parts.findIndex(p => knownRoots.includes(p.toLowerCase()));
    if (rootIdx >= 0 && parts.length > rootIdx + 1) {
        const tag = parts[rootIdx + 1];
        const rest = parts.slice(rootIdx + 2);
        return { tag, rest };
    }

    // No known root: best effort tag from first folder if any
    if (parts.length >= 2) return { tag: parts[0], rest: parts.slice(1) };
    return { tag: 'Unknown', rest: parts.slice(1) };
}

export function parseClipFilename(name) {
    return parseDashcamFilename(name);
}

export function normalizeCamera(cameraRaw) {
    const c = (cameraRaw || '').toLowerCase();
    if (c === 'front') return 'front';
    if (c === 'back') return 'back';
    if (c === 'left_repeater' || c === 'left') return 'left_repeater';
    if (c === 'right_repeater' || c === 'right') return 'right_repeater';
    if (c === 'left_pillar') return 'left_pillar';
    if (c === 'right_pillar') return 'right_pillar';
    return c || 'unknown';
}

export function cameraLabel(camera, profileId = 'tesla') {
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

export async function buildTeslaCamIndex(files, directoryName = null, onProgress = null) {
    const groups = new Map(); // id -> group
    let inferredRoot = directoryName || null;
    const eventAssetsByKey = new Map(); // `${tag}/${eventId}` -> { jsonFile, pngFile, mp4File }
    const detectedProfiles = new Set();
    let ignoredFileCount = 0;

    const totalFiles = files.length;
    const BATCH_SIZE = 500; // Process files in batches to prevent UI blocking
    let processed = 0;

    for (let i = 0; i < totalFiles; i++) {
        const file = files[i];
        const relPath = getBestEffortRelPath(file, directoryName);
        const parsedPath = parseTeslaCamPath(relPath);
        let tag = parsedPath.tag;
        const rest = parsedPath.rest;
        const filename = rest[rest.length - 1] || file.name;
        const lowerName = String(filename || '').toLowerCase();

        // Event assets (event.json / event.png / event.mp4) for SentryClips and SavedClips
        const tagLowerAsset = tag.toLowerCase();
        if ((tagLowerAsset === 'sentryclips' || tagLowerAsset === 'savedclips') && rest.length >= 2 && (lowerName === 'event.json' || lowerName === 'event.png' || lowerName === 'event.mp4')) {
            const eventId = rest[0];
            const key = `${tag}/${eventId}`;
            if (!eventAssetsByKey.has(key)) eventAssetsByKey.set(key, {});
            const entry = eventAssetsByKey.get(key);
            if (lowerName === 'event.json') entry.jsonFile = file;
            if (lowerName === 'event.png') entry.pngFile = file;
            if (lowerName === 'event.mp4') entry.mp4File = file;
            processed++;
            continue;
        }

        // Regular per-camera MP4
        const parsed = parseClipFilename(filename);
        if (!parsed) {
            if (lowerName.endsWith('.mp4')) ignoredFileCount++;
            processed++;
            continue;
        }
        detectedProfiles.add(parsed.profileId);

        // SentryClips/<eventId>/YYYY-...-front.mp4
        // SavedClips/<eventId>/YYYY-...-front.mp4
        // RecentClips/YYYY-...-front.mp4
        let eventId = null;
        const tagLower = tag.toLowerCase();
        const parsedProfile = getDashcamProfile(parsed.profileId);
        if (parsedProfile.normalizeCollectionTag) {
            tag = parsedProfile.customCollectionLabel;
        } else if ((tagLower === 'sentryclips' || tagLower === 'savedclips') && rest.length >= 2) {
            eventId = rest[0];
        }

        const groupId = `${tag}/${eventId ? eventId + '/' : ''}${parsed.timestampKey}`;
        if (!groups.has(groupId)) {
            groups.set(groupId, {
                id: groupId,
                profileId: parsed.profileId,
                tag,
                eventId,
                timestampKey: parsed.timestampKey,
                filesByCamera: new Map(),
                bestRelPathHint: relPath,
                eventMeta: null,
                eventJsonFile: null,
                eventPngFile: null,
                eventMp4File: null
            });
        }
        const g = groups.get(groupId);
        g.filesByCamera.set(parsed.camera, {
            file,
            relPath,
            profileId: parsed.profileId,
            tag,
            eventId,
            timestampKey: parsed.timestampKey,
            camera: parsed.camera
        });

        // try to infer folder label from relPath root if possible
        if (!inferredRoot && relPath) inferredRoot = relPath.split('/')[0] || null;

        processed++;

        // Yield to UI every BATCH_SIZE files to prevent blocking
        if (processed % BATCH_SIZE === 0) {
            if (onProgress) onProgress(processed, totalFiles, groups.size);
            await yieldToUI();
        }
    }

    // Final progress update
    if (onProgress) onProgress(totalFiles, totalFiles, groups.size);

    // Attach any event assets to groups in the same Sentry event folder
    for (const g of groups.values()) {
        if (!g.eventId) continue;
        const key = `${g.tag}/${g.eventId}`;
        const assets = eventAssetsByKey.get(key);
        if (!assets) continue;
        g.eventJsonFile = assets.jsonFile || null;
        g.eventPngFile = assets.pngFile || null;
        g.eventMp4File = assets.mp4File || null;
    }

    const arr = Array.from(groups.values());
    arr.sort((a, b) => (b.timestampKey || '').localeCompare(a.timestampKey || ''));
    return {
        groups: arr,
        inferredRoot,
        eventAssetsByKey,
        ignoredFileCount,
        profileId: detectedProfiles.size === 1
            ? Array.from(detectedProfiles)[0]
            : (detectedProfiles.size === 0 ? 'tesla' : null),
        mixedProfiles: detectedProfiles.size > 1
    };
}

/**
 * Build day collections from clip groups.
 * Returns { collections, allDates, dayData } — caller assigns to library.
 */
export function buildDayCollections(groups, options = {}) {
    return buildDashcamCollections(groups, options);
}
