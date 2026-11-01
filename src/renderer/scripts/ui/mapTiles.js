/**
 * Map Tiles Manager
 *
 * Owns which tile provider every Leaflet map in this window uses (main viewer
 * map + Advanced Editor minimap preview). Providers come from the shared
 * registry in src/shared/mapProviders.js (window.MapProviders).
 *
 * The default provider is the SentryUSB VersaTiles vector style drawn by MapLibre GL
 * inside Leaflet (vendor/maplibre-gl-leaflet). Raster providers use plain
 * L.tileLayer. Dark mode swaps the vector style to its dark variant; raster
 * maps keep the older CSS filter (see applyMapDarkMode in script.js).
 *
 * Fallback: if the vector style cannot be used (no WebGL, or the style fails
 * to load before it ever rendered), the session falls back to OpenStreetMap
 * raster tiles on every registered map and shows a toast. The saved setting
 * is left untouched — the next launch tries VersaTiles again.
 */

import { notify } from './notifications.js';
import { t } from '../lib/i18n.js';

const SETTING_KEY = 'mapTileProvider';

// Maps registered for live layer swapping: Map<LeafletMap, {layer, opts}>
const registeredMaps = new Map();

let selectedProviderId = null;   // resolved from settings (null until loaded)
let sessionFallbackActive = false;
let settingLoadPromise = null;
let darkMode = false;

function registry() {
    return window.MapProviders;
}

function loadSelectedProvider() {
    if (!settingLoadPromise) {
        settingLoadPromise = (async () => {
            try {
                const saved = await window.electronAPI?.getSetting?.(SETTING_KEY);
                selectedProviderId = registry().normalizeProviderId(saved);
                // Migrate ids from removed providers (e.g. the old Google
                // entries) so Settings and exports agree on the new value.
                if (saved != null && saved !== selectedProviderId) {
                    window.electronAPI?.setSetting?.(SETTING_KEY, selectedProviderId);
                }
            } catch {
                selectedProviderId = registry().DEFAULT_PROVIDER_ID;
            }
            return selectedProviderId;
        })();
    }
    return settingLoadPromise;
}

function vectorRenderingAvailable() {
    return typeof window.L?.maplibreGL === 'function' && typeof window.maplibregl?.Map === 'function';
}

export function getEffectiveProviderId() {
    const selected = selectedProviderId || registry().DEFAULT_PROVIDER_ID;
    if (registry().isVectorProvider(selected) && (sessionFallbackActive || !vectorRenderingAvailable())) {
        return registry().FALLBACK_PROVIDER_ID;
    }
    return selected;
}

export function getSelectedProviderId() {
    return selectedProviderId || registry().DEFAULT_PROVIDER_ID;
}

/**
 * True when the visible maps draw a vector style, which handles dark mode
 * natively (no CSS filter needed).
 */
export function isVectorMapActive() {
    return registry().isVectorProvider(getEffectiveProviderId());
}

/**
 * True when raster tiles should get the dark-mode CSS filter.
 */
export function wantsDarkFilter() {
    return !isVectorMapActive();
}

function createLayer(providerId, opts = {}) {
    const p = registry().getProvider(providerId);
    if (p.type === 'vector') {
        const layer = window.L.maplibreGL({
            style: darkMode && opts.followDarkMode ? p.darkStyleUrl : p.styleUrl,
            maxZoom: Math.min(p.maxZoom, opts.maxZoomCap ?? p.maxZoom),
            // The GL map only mirrors Leaflet; Leaflet handles all input.
            interactive: false,
            // maplibre-gl-leaflet reports this string to Leaflet's
            // attribution control in place of the style's source credits.
            attributionControl: { customAttribution: p.attribution }
        });
        layer._sentryVector = true;
        return layer;
    }
    return window.L.tileLayer(p.urlTemplate, {
        ...registry().leafletRasterOptions(providerId, opts.maxZoomCap),
        ...(opts.layerOptions || {})
    });
}

function watchVectorLayer(layer) {
    if (!layer?._sentryVector) return;
    const glMap = layer.getMaplibreMap?.();
    if (!glMap) {
        triggerFallback('vector map did not start');
        return;
    }
    // The VersaTiles styles ask for a globe at low zoom; Leaflet is Web
    // Mercator, so the GL map must stay Mercator to line up.
    glMap.on('style.load', () => glMap.setProjection({ type: 'mercator' }));
    let rendered = false;
    glMap.once('load', () => { rendered = true; });
    glMap.on('error', (e) => {
        // Individual tile errors after the style loaded are transient; only
        // a style that never loads means the provider is unusable.
        if (rendered || sessionFallbackActive) return;
        console.warn('[MAP] Vector style error:', e?.error?.message || e);
        triggerFallback('style failed to load');
    });
}

function removeLayerFromMap(map, entry) {
    if (!entry.layer) return;
    map.removeLayer(entry.layer);
    entry.layer = null;
}

function addLayerToMap(map, entry, providerId) {
    try {
        entry.layer = createLayer(providerId, entry.opts);
        entry.layer.addTo(map);
        watchVectorLayer(entry.layer);
    } catch (err) {
        // WebGL unavailable or MapLibre failed to construct.
        console.warn('[MAP] Failed to create map layer:', err);
        if (registry().isVectorProvider(providerId) && !sessionFallbackActive) {
            entry.layer = null;
            triggerFallback('vector map unavailable');
        }
    }
}

function triggerFallback(reason) {
    if (sessionFallbackActive) return;
    sessionFallbackActive = true;
    console.warn(`[MAP] VersaTiles map unavailable (${reason}) — using OpenStreetMap tiles for this session`);
    applyEffectiveProviderToAllMaps();
    try {
        notify(t('ui.settings.mapProviderFallbackNotice'), { type: 'warn', timeoutMs: 6000 });
    } catch { /* toast is best-effort */ }
    window.applyMapDarkMode?.(darkMode);
}

function applyEffectiveProviderToAllMaps() {
    const effective = getEffectiveProviderId();
    for (const [map, entry] of registeredMaps) {
        try {
            removeLayerFromMap(map, entry);
        } catch (err) {
            console.warn('[MAP] Failed to remove tile layer:', err);
            entry.layer = null;
        }
        addLayerToMap(map, entry, effective);
    }
}

// Map data credits must stay visible (OpenStreetMap ODbL, CC BY sources).
// The control can live outside the map element so it does not rotate with
// the heading-up map.
function ensureAttribution(map, container) {
    if (map.attributionControl) return;
    map.attributionControl = window.L.control.attribution({ prefix: false }).addTo(map);
    const el = map.attributionControl.getContainer();
    el.classList.add('sentry-map-attribution');
    if (container) {
        el.classList.add('sentry-map-attribution--detached');
        container.appendChild(el);
    }
}

// Attribution links open in the system browser instead of navigating the
// app window.
let attributionLinksHandled = false;
function handleAttributionLinks() {
    if (attributionLinksHandled) return;
    attributionLinksHandled = true;
    document.addEventListener('click', (e) => {
        const link = e.target?.closest?.('.sentry-map-attribution a[href]');
        if (!link) return;
        e.preventDefault();
        e.stopPropagation();
        if (/^https:\/\//.test(link.href)) window.electronAPI?.openExternal?.(link.href);
    }, true);
}

/**
 * Attach a tile layer for the current provider to a Leaflet map and keep it
 * registered for live provider swaps (settings change or fallback).
 * The layer is added asynchronously (after the saved setting loads).
 *
 * @param {Object} map - Leaflet map instance
 * @param {Object} opts - { maxZoomCap?: number, layerOptions?: Object,
 *   followDarkMode?: boolean (use the dark vector style in map dark mode),
 *   attributionContainer?: Element (host the credits outside the map) }
 */
export function attachTileLayer(map, opts = {}) {
    const entry = { layer: null, opts };
    ensureAttribution(map, opts.attributionContainer);
    handleAttributionLinks();
    registeredMaps.set(map, entry);
    return loadSelectedProvider().then(() => {
        if (!registeredMaps.has(map)) return; // detached before setting loaded
        addLayerToMap(map, entry, getEffectiveProviderId());
    });
}

/**
 * Unregister a map (call before map.remove()).
 */
export function detachTileLayer(map) {
    registeredMaps.delete(map);
}

/**
 * Map dark mode changed. Vector maps that follow dark mode switch style;
 * returns true when the change was handled without a CSS filter.
 */
export function setMapDarkMode(enabled) {
    const next = !!enabled;
    const changed = next !== darkMode;
    darkMode = next;
    if (!isVectorMapActive()) return false;
    if (!changed) return true;
    const p = registry().getProvider(getEffectiveProviderId());
    for (const entry of registeredMaps.values()) {
        if (!entry.opts.followDarkMode || !entry.layer?._sentryVector) continue;
        try {
            entry.layer.getMaplibreMap()?.setStyle(darkMode ? p.darkStyleUrl : p.styleUrl);
        } catch (err) {
            console.warn('[MAP] Failed to switch map style:', err);
        }
    }
    return true;
}

/**
 * User picked a provider in Settings: persist it and swap all live maps.
 * An explicit choice also clears the session fallback so VersaTiles gets a
 * fresh chance immediately.
 */
export async function setMapTileProvider(id) {
    selectedProviderId = registry().normalizeProviderId(id);
    sessionFallbackActive = false;
    settingLoadPromise = Promise.resolve(selectedProviderId);
    try {
        await window.electronAPI?.setSetting?.(SETTING_KEY, selectedProviderId);
    } catch (err) {
        console.warn('[MAP] Failed to persist map provider setting:', err);
    }
    applyEffectiveProviderToAllMaps();
    // Re-apply dark mode: vector styles handle it, raster maps use a filter.
    window.applyMapDarkMode?.(darkMode);
}
