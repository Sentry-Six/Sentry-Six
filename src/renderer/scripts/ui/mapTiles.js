/**
 * Map Tiles Manager
 *
 * Owns which tile provider every Leaflet map in this window uses (main viewer
 * map + Advanced Editor minimap preview). Providers come from the shared
 * registry in src/shared/mapProviders.js (window.MapProviders).
 *
 * Every map draws the SentryUSB VersaTiles vector style (tiles.sentryusb.com)
 * with MapLibre GL inside Leaflet (vendor/maplibre-gl-leaflet). Dark mode
 * swaps the style to its dark variant. Where Chromium can, machines without
 * a usable GPU draw WebGL in software (the enable-unsafe-swiftshader switch
 * in src/main.js).
 *
 * If the style cannot draw (no WebGL at all, or the style fails to load
 * before it ever rendered, e.g. during a tile server outage), every map
 * shows the style's background colour with its routes on top for the rest
 * of the session, and a toast says the map is temporarily unavailable.
 */

import { notify } from './notifications.js';
import { t } from '../lib/i18n.js';

const SETTING_KEY = 'mapTileProvider';

// Maps registered for live layer swapping: Map<LeafletMap, {layer, opts}>
const registeredMaps = new Map();

let selectedProviderId = null;   // resolved from settings (null until loaded)
let mapUnavailable = false;      // style could not draw this session
let settingLoadPromise = null;
let darkMode = false;
let styleCache = null;

function registry() {
    return window.MapProviders;
}

// Fetched light and dark style JSON, so a dark-mode switch is a style diff
// with no network round trip.
function vectorStyles() {
    styleCache ||= registry().createStyleCache((url) => fetch(url));
    return styleCache;
}

function vectorStyle(p, dark) {
    return vectorStyles().get(dark ? p.darkStyleUrl : p.styleUrl);
}

function loadSelectedProvider() {
    if (!settingLoadPromise) {
        settingLoadPromise = (async () => {
            try {
                const saved = await window.electronAPI?.getSetting?.(SETTING_KEY);
                selectedProviderId = registry().normalizeSelectedProviderId(saved);
                // Migrate ids from removed choices (the old Google entries and
                // OpenStreetMap) so Settings and exports agree on the new value.
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

// MapLibre GL needs WebGL2.
let webgl2Support;
function vectorRenderingAvailable() {
    if (webgl2Support === undefined) {
        try { webgl2Support = !!document.createElement('canvas').getContext('webgl2'); } catch { webgl2Support = false; }
    }
    return webgl2Support && typeof window.L?.maplibreGL === 'function' && typeof window.maplibregl?.Map === 'function';
}

export function getEffectiveProviderId() {
    return selectedProviderId || registry().DEFAULT_PROVIDER_ID;
}

export function getSelectedProviderId() {
    return selectedProviderId || registry().DEFAULT_PROVIDER_ID;
}

// The style's own background colour, shown under the routes when the map
// cannot draw.
function applyMapBackground(map, entry) {
    const container = map.getContainer?.();
    if (!container) return;
    if (!mapUnavailable) {
        container.style.removeProperty('background');
        return;
    }
    const p = registry().getProvider(getEffectiveProviderId());
    container.style.background = darkMode && entry.opts.followDarkMode ? p.darkBackgroundColor : p.backgroundColor;
}

function createLayer(providerId, opts = {}) {
    const p = registry().getProvider(providerId);
    const layer = window.L.maplibreGL({
        style: vectorStyle(p, darkMode && opts.followDarkMode),
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

function watchVectorLayer(layer) {
    if (!layer?._sentryVector) return;
    const glMap = layer.getMaplibreMap?.();
    if (!glMap) {
        markMapUnavailable('vector map did not start');
        return;
    }
    // The VersaTiles styles ask for a globe at low zoom; Leaflet is Web
    // Mercator, so the GL map must stay Mercator to line up.
    glMap.on('style.load', () => glMap.setProjection({ type: 'mercator' }));
    let rendered = false;
    glMap.once('load', () => {
        rendered = true;
        const p = registry().getProvider(getEffectiveProviderId());
        vectorStyles().prefetch([p.styleUrl, p.darkStyleUrl]);
    });
    glMap.on('error', (e) => {
        // Individual tile errors after the style loaded are transient; only
        // a style that never loads means the provider is unusable.
        if (rendered || mapUnavailable) return;
        console.warn('[MAP] Vector style error:', e?.error?.message || e);
        markMapUnavailable('style failed to load');
    });
}

function removeLayerFromMap(map, entry) {
    if (!entry.layer) return;
    map.removeLayer(entry.layer);
    entry.layer = null;
}

function addLayerToMap(map, entry, providerId) {
    applyMapBackground(map, entry);
    if (mapUnavailable) return;
    if (!vectorRenderingAvailable()) {
        markMapUnavailable('WebGL2 is not available');
        return;
    }
    try {
        entry.layer = createLayer(providerId, entry.opts);
        entry.layer.addTo(map);
        watchVectorLayer(entry.layer);
    } catch (err) {
        // WebGL unavailable or MapLibre failed to construct.
        console.warn('[MAP] Failed to create map layer:', err);
        entry.layer = null;
        markMapUnavailable('vector map unavailable');
    }
}

function markMapUnavailable(reason) {
    if (mapUnavailable) return;
    mapUnavailable = true;
    console.warn(`[MAP] Map unavailable (${reason}) — showing routes on the map background for this session`);
    // Drop the GL layers (and their WebGL contexts); the routes are Leaflet
    // layers and stay.
    for (const [map, entry] of registeredMaps) {
        try {
            removeLayerFromMap(map, entry);
        } catch (err) {
            console.warn('[MAP] Failed to remove map layer:', err);
            entry.layer = null;
        }
        applyMapBackground(map, entry);
    }
    try {
        notify(t('ui.settings.mapUnavailableNotice'), { type: 'warn', timeoutMs: 6000 });
    } catch { /* toast is best-effort */ }
}

function applyEffectiveProviderToAllMaps() {
    const effective = getEffectiveProviderId();
    for (const [map, entry] of registeredMaps) {
        try {
            removeLayerFromMap(map, entry);
        } catch (err) {
            console.warn('[MAP] Failed to remove map layer:', err);
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
 * registered for live style changes (provider setting, dark mode, outage).
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
        // A provider swap may have added a layer while the setting was
        // loading; drop it so it is not orphaned.
        removeLayerFromMap(map, entry);
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
 * Map dark mode changed: maps that follow dark mode switch to the dark style
 * (or, while the map is unavailable, to the dark background colour).
 */
export function setMapDarkMode(enabled) {
    const next = !!enabled;
    if (next === darkMode) return;
    darkMode = next;
    const p = registry().getProvider(getEffectiveProviderId());
    for (const [map, entry] of registeredMaps) {
        if (!entry.opts.followDarkMode) continue;
        applyMapBackground(map, entry);
        if (!entry.layer?._sentryVector) continue;
        try {
            entry.layer.getMaplibreMap()?.setStyle(vectorStyle(p, darkMode));
        } catch (err) {
            console.warn('[MAP] Failed to switch map style:', err);
        }
    }
}

/**
 * User picked a provider in Settings: persist it and swap all live maps.
 * An explicit choice also gives an unavailable map a fresh try.
 */
export async function setMapTileProvider(id) {
    selectedProviderId = registry().normalizeSelectedProviderId(id);
    mapUnavailable = false;
    settingLoadPromise = Promise.resolve(selectedProviderId);
    try {
        await window.electronAPI?.setSetting?.(SETTING_KEY, selectedProviderId);
    } catch (err) {
        console.warn('[MAP] Failed to persist map provider setting:', err);
    }
    applyEffectiveProviderToAllMaps();
}
