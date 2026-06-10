/**
 * SEI Telemetry Extraction
 * Extracts GPS and vehicle telemetry data from Tesla dashcam video files
 */

import { filePathToUrl } from '../lib/utils.js';

/**
 * Check if SEI data contains valid GPS coordinates
 * @param {Object} sei - SEI telemetry data
 * @returns {boolean}
 */
export function hasValidGps(sei) {
    // Tesla SEI can be missing, zeroed, or invalid while parked / initializing GPS.
    const lat = Number(sei?.latitudeDeg ?? sei?.latitude_deg);
    const lon = Number(sei?.longitudeDeg ?? sei?.longitude_deg);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    // Treat (0,0) as "no fix" (real-world clips should never be there).
    if (lat === 0 && lon === 0) return false;
    // Basic sanity bounds.
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
    return true;
}

/**
 * Extract SEI telemetry from an ArrayBuffer using DashcamMP4 parser
 * @param {ArrayBuffer} buffer - Video file buffer
 * @returns {Promise<{seiData: Array, mapPath: Array}>}
 */
async function extractSeiFromBuffer(buffer) {
    if (!window.DashcamMP4 || !window.DashcamHelpers) {
        return { seiData: [], mapPath: [] };
    }
    
    const { SeiMetadata } = await window.DashcamHelpers.initProtobuf();
    const mp4 = new window.DashcamMP4(buffer);
    const frames = mp4.parseFrames(SeiMetadata);
    
    const seiData = [];
    const mapPath = [];
    let runningMs = 0;
    
    for (const frame of frames) {
        runningMs += frame.duration;
        if (frame.sei) {
            seiData.push({ timestampMs: runningMs, sei: frame.sei });
            if (hasValidGps(frame.sei)) {
                const lat = Number(frame.sei.latitudeDeg ?? frame.sei.latitude_deg);
                const lon = Number(frame.sei.longitudeDeg ?? frame.sei.longitude_deg);
                const apState = frame.sei.autopilotState ?? frame.sei.autopilot_state;
                const autopilot = apState != null && apState !== 0 && apState !== 'DISABLED';
                mapPath.push({ lat, lon, timestampMs: runningMs, autopilot });
            }
        }
    }
    
    return { seiData, mapPath };
}

/**
 * Extract SEI telemetry from a File object
 * @param {File} file - Video File object
 * @returns {Promise<{seiData: Array, mapPath: Array}>}
 */
async function extractSeiFromFile(file) {
    const buffer = await file.arrayBuffer();
    return extractSeiFromBuffer(buffer);
}

// Bounded LRU cache of parsed telemetry, keyed by source file identity.
// Without it, every segment switch re-reads and re-parses the whole MP4
// (seconds per clip). Each cached clip is roughly 0.5-1MB of SEI objects;
// the hard cap keeps the cache to a few MB no matter how long the session
// runs. Nothing mutates the cached arrays after extraction, so entries can
// be returned by reference.
const SEI_CACHE_MAX = 8;
const seiCache = new Map();

function seiCacheKey(entry) {
    if (entry?.file?.isElectronFile && entry.file?.path) return entry.file.path;
    const f = entry?.file;
    if (f instanceof File) return `${f.name}|${f.size}|${f.lastModified}`;
    return null;
}

/**
 * Extract SEI telemetry from an entry (handles both File objects and Electron paths)
 * Results are cached (bounded LRU) so revisiting a recent segment is instant.
 * @param {Object} entry - Clip entry with file property
 * @param {string} seiType - SEI type identifier
 * @returns {Promise<{seiData: Array, mapPath: Array}>}
 */
export async function extractSeiFromEntry(entry, seiType) {
    if (!entry) return { seiData: [], mapPath: [] };

    const cacheKey = seiCacheKey(entry);
    if (cacheKey && seiCache.has(cacheKey)) {
        const hit = seiCache.get(cacheKey);
        // Refresh LRU order
        seiCache.delete(cacheKey);
        seiCache.set(cacheKey, hit);
        return hit;
    }

    let result = { seiData: [], mapPath: [] };

    // If it's an Electron file with path, fetch via file:// protocol
    if (entry.file?.isElectronFile && entry.file?.path) {
        try {
            const fileUrl = filePathToUrl(entry.file.path);
            const response = await fetch(fileUrl);
            const buffer = await response.arrayBuffer();
            result = await extractSeiFromBuffer(buffer);
        } catch (err) {
            console.warn('Failed to extract SEI from Electron file:', err);
            return { seiData: [], mapPath: [] }; // don't cache transient read failures
        }
    } else if (entry.file && entry.file instanceof File) {
        // Regular File object
        result = await extractSeiFromFile(entry.file);
    }

    if (cacheKey) {
        seiCache.set(cacheKey, result);
        if (seiCache.size > SEI_CACHE_MAX) {
            seiCache.delete(seiCache.keys().next().value);
        }
    }
    return result;
}

/**
 * Find the closest SEI data for a given timestamp
 * @param {Array} seiData - Array of {timestampMs, sei} objects
 * @param {number} timestampMs - Target timestamp in milliseconds
 * @returns {Object|null} SEI data or null
 */
export function findSeiAtTime(seiData, timestampMs) {
    if (!seiData || !seiData.length) return null;
    
    // Binary search for the closest timestamp (data is sorted by timestampMs)
    let lo = 0, hi = seiData.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (seiData[mid].timestampMs <= timestampMs) lo = mid;
        else hi = mid - 1;
    }
    
    // lo is now the last entry with timestampMs <= target.
    // Check if lo+1 is closer (if it exists).
    let closest = seiData[lo];
    if (lo + 1 < seiData.length) {
        const diffLo = Math.abs(seiData[lo].timestampMs - timestampMs);
        const diffHi = Math.abs(seiData[lo + 1].timestampMs - timestampMs);
        if (diffHi < diffLo) closest = seiData[lo + 1];
    }
    
    return closest?.sei || null;
}
