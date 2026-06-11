/**
 * Map Tiles Manager
 *
 * Owns which tile provider every Leaflet map in this window uses (main viewer
 * map + Advanced Editor minimap preview). Providers come from the shared
 * registry in src/shared/mapProviders.js (window.MapProviders).
 *
 * Fallback: when a Google provider is active and Google's tile servers turn
 * out to be unreachable (probe failure, or repeated tile errors before the
 * first successful tile), the session falls back to OpenStreetMap on every
 * registered map, shows a toast, and notifies the main process so export
 * tile downloads and the minimap renderer window follow. The saved setting
 * is left untouched — the next launch tries Google again.
 */

import { notify } from './notifications.js';
import { t } from '../lib/i18n.js';

const SETTING_KEY = 'mapTileProvider';

// Maps registered for live layer swapping: Map<LeafletMap, {layer, opts}>
const registeredMaps = new Map();

let selectedProviderId = null;   // resolved from settings (null until loaded)
let sessionFallbackActive = false;
let settingLoadPromise = null;
let probeStarted = false;

// Tile error accounting for the "errors before first success" rule
let googleTileErrors = 0;
let googleTileLoaded = false;

function registry() {
    return window.MapProviders;
}

function loadSelectedProvider() {
    if (!settingLoadPromise) {
        settingLoadPromise = (async () => {
            try {
                const saved = await window.electronAPI?.getSetting?.(SETTING_KEY);
                selectedProviderId = registry().getProvider(saved).id;
            } catch {
                selectedProviderId = registry().DEFAULT_PROVIDER_ID;
            }
            return selectedProviderId;
        })();
    }
    return settingLoadPromise;
}

export function getEffectiveProviderId() {
    const selected = selectedProviderId || registry().DEFAULT_PROVIDER_ID;
    return sessionFallbackActive && registry().isGoogleProvider(selected)
        ? registry().FALLBACK_PROVIDER_ID
        : selected;
}

export function getSelectedProviderId() {
    return selectedProviderId || registry().DEFAULT_PROVIDER_ID;
}

function createLayer(providerId, opts = {}) {
    const p = registry().getProvider(providerId);
    return window.L.tileLayer(p.urlTemplate, {
        maxZoom: Math.min(p.maxZoom, opts.maxZoomCap ?? p.maxZoom),
        subdomains: p.subdomains,
        ...(opts.layerOptions || {})
    });
}

function watchLayerForFailure(layer, providerId) {
    if (!registry().isGoogleProvider(providerId)) return;
    layer.on('tileload', () => { googleTileLoaded = true; });
    layer.on('tileerror', () => {
        if (googleTileLoaded || sessionFallbackActive) return;
        googleTileErrors++;
        if (googleTileErrors >= 3) {
            triggerFallback('repeated tile errors');
        }
    });
}

// Probe one known tile via an <img> load (no CORS restrictions) so a blocked
// Google endpoint is detected even before the map requests visible tiles.
function probeGoogleReachable() {
    return new Promise(resolve => {
        const img = new Image();
        const timer = setTimeout(() => { img.src = ''; resolve(false); }, 5000);
        img.onload = () => { clearTimeout(timer); resolve(true); };
        img.onerror = () => { clearTimeout(timer); resolve(false); };
        img.src = registry().GOOGLE_PROBE_URL;
    });
}

function maybeStartProbe() {
    if (probeStarted || !registry().isGoogleProvider(getEffectiveProviderId())) return;
    probeStarted = true;
    probeGoogleReachable().then(ok => {
        // A tileload in the meantime also proves reachability — only fall
        // back when nothing from Google has loaded.
        if (!ok && !googleTileLoaded && !sessionFallbackActive) {
            triggerFallback('probe failed');
        }
    });
}

function triggerFallback(reason) {
    if (sessionFallbackActive) return;
    sessionFallbackActive = true;
    console.warn(`[MAP] Google tiles unavailable (${reason}) — falling back to OpenStreetMap for this session`);
    applyEffectiveProviderToAllMaps();
    try {
        notify(t('ui.settings.mapProviderFallbackNotice'), { type: 'warn', timeoutMs: 6000 });
    } catch { /* toast is best-effort */ }
    window.electronAPI?.notifyMapProviderFallback?.();
}

function applyEffectiveProviderToAllMaps() {
    const effective = getEffectiveProviderId();
    for (const [map, entry] of registeredMaps) {
        try {
            if (entry.layer) map.removeLayer(entry.layer);
            entry.layer = createLayer(effective, entry.opts);
            watchLayerForFailure(entry.layer, effective);
            entry.layer.addTo(map);
        } catch (err) {
            console.warn('[MAP] Failed to swap tile layer:', err);
        }
    }
}

/**
 * Attach a tile layer for the current provider to a Leaflet map and keep it
 * registered for live provider swaps (settings change or fallback).
 * The layer is added asynchronously (after the saved setting loads).
 *
 * @param {Object} map - Leaflet map instance
 * @param {Object} opts - { maxZoomCap?: number, layerOptions?: Object }
 */
export function attachTileLayer(map, opts = {}) {
    const entry = { layer: null, opts };
    registeredMaps.set(map, entry);
    loadSelectedProvider().then(() => {
        if (!registeredMaps.has(map)) return; // detached before setting loaded
        const effective = getEffectiveProviderId();
        entry.layer = createLayer(effective, opts);
        watchLayerForFailure(entry.layer, effective);
        entry.layer.addTo(map);
        maybeStartProbe();
    });
}

/**
 * Unregister a map (call before map.remove()).
 */
export function detachTileLayer(map) {
    registeredMaps.delete(map);
}

/**
 * User picked a provider in Settings: persist it and swap all live maps.
 * An explicit choice also clears the session fallback so Google gets a
 * fresh chance (and a fresh probe) immediately.
 */
export async function setMapTileProvider(id) {
    selectedProviderId = registry().getProvider(id).id;
    sessionFallbackActive = false;
    googleTileErrors = 0;
    googleTileLoaded = false;
    probeStarted = false;
    settingLoadPromise = Promise.resolve(selectedProviderId);
    try {
        await window.electronAPI?.setSetting?.(SETTING_KEY, selectedProviderId);
    } catch (err) {
        console.warn('[MAP] Failed to persist map provider setting:', err);
    }
    applyEffectiveProviderToAllMaps();
    maybeStartProbe();
}
