/**
 * Map Visualization
 * Handles map marker updates and visibility.
 * Supports two orientation modes:
 *   - heading-up: arrow points up, map rotates (like car GPS)
 *   - north-up: map stays fixed north, arrow rotates to show heading
 */

// Map state
let mapMarker = null;
let mapMarkerArrowImg = null; // Cached arrow <img> inside the marker icon
let currentMapArrowRotation = 0;
let currentMapBearing = 0; // Map rotation for heading-up mode
let zoomListenerAttached = false;
// Last rendered position/bearing/size — updateMapMarker runs at 60Hz, and
// Leaflet setView/setLatLng plus container transform writes are wasted work
// while the vehicle sits still (most Sentry footage)
let lastMarkerFrameKey = null;

// A static marker (the Sentry/Saved event location pin) that must stay
// visually upright while the map container rotates in heading-up mode.
// Without counter-rotation it spins with the container and renders sideways.
let uprightMarker = null;
let uprightMarkerEl = null; // cached inner <svg> to counter-rotate

// Orientation mode: 'heading-up' or 'north-up'
let mapOrientation = 'heading-up';

/**
 * Get current map orientation mode
 * @returns {'heading-up'|'north-up'}
 */
export function getMapOrientation() {
    return mapOrientation;
}

/**
 * Get current map bearing (degrees the container is rotated)
 * @returns {number}
 */
export function getMapBearing() {
    return mapOrientation === 'heading-up' ? currentMapBearing : 0;
}

/**
 * Set map orientation mode
 * @param {'heading-up'|'north-up'} mode
 */
export function setMapOrientation(mode) {
    mapOrientation = mode;
    const map = getMap?.();
    if (!map) return;

    const mapContainer = map.getContainer();
    if (mode === 'north-up') {
        // Remove container rotation
        if (mapContainer) {
            mapContainer.style.transition = 'transform 0.3s ease-out';
            mapContainer.style.transform = 'rotate(0deg) scale(1)';
        }
        // Update arrow to show actual heading
        if (mapMarker) {
            const iconEl = mapMarker._icon;
            if (iconEl) {
                const img = iconEl.querySelector('img');
                if (img) {
                    img.style.transform = `rotate(${currentMapBearing}deg)`;
                }
            }
        }
    } else {
        // Heading-up: re-apply container rotation
        if (mapContainer) {
            mapContainer.style.transition = 'transform 0.3s ease-out';
            mapContainer.style.transform = `rotate(${-currentMapBearing}deg) scale(1.42)`;
        }
        // Counter-rotate arrow so it points up
        if (mapMarker) {
            const iconEl = mapMarker._icon;
            if (iconEl) {
                const img = iconEl.querySelector('img');
                if (img) {
                    img.style.transform = `rotate(${currentMapBearing}deg)`;
                }
            }
        }
    }

    // Re-align the static event pin for the new orientation
    applyUprightMarkerRotation();
}

/**
 * Calculate arrow icon size based on map zoom level.
 * Uses a gentle linear scale so the arrow stays visible even when zoomed out.
 * Zoom 16+ → 80px, zoom 12 → ~48px, zoom 8 → ~28px
 */
function getArrowSizeForZoom(zoom) {
    const size = 28 + (zoom - 8) * 6.5;
    return Math.max(28, Math.min(120, Math.round(size)));
}

/**
 * Rebuild the marker icon at the current zoom & bearing.
 */
function rebuildMarkerIcon(map) {
    if (!mapMarker || !map) return;
    const size = getArrowSizeForZoom(map.getZoom());
    const half = Math.round(size / 2);
    // In heading-up mode, arrow counter-rotates to stay pointing up
    // In north-up mode, arrow shows actual heading
    const arrowRotation = currentMapBearing;
    const arrowIcon = L.divIcon({
        className: 'arrow-marker-icon',
        html: `<img src="../../assets/arrow.png" style="width:${size}px;height:${size}px;transform:rotate(${arrowRotation}deg);transform-origin:center center;display:block;" />`,
        iconSize: [size, size],
        iconAnchor: [half, half]
    });
    mapMarker.setIcon(arrowIcon);
}

/**
 * Counter-rotate the registered "upright" marker (the event pin) so it stays
 * vertically upright regardless of the heading-up container rotation. The
 * pin's tip is its icon anchor (bottom-center), so we pivot there to keep the
 * tip pinned to its location. The inner <svg> is rotated (not the
 * .event-marker-pin wrapper) to avoid clobbering its one-shot bounce animation.
 */
function applyUprightMarkerRotation() {
    if (!uprightMarker) return;
    if (!uprightMarkerEl || !uprightMarkerEl.isConnected) {
        uprightMarkerEl = uprightMarker._icon?.querySelector('svg') || null;
    }
    if (uprightMarkerEl) {
        const rot = mapOrientation === 'heading-up' ? currentMapBearing : 0;
        uprightMarkerEl.style.transformOrigin = '50% 100%';
        uprightMarkerEl.style.transform = `rotate(${rot}deg)`;
    }
}

/**
 * Register (or clear, with null) a static marker that should stay upright as
 * the map rotates — currently the Sentry/Saved event location pin.
 * @param {Object|null} marker - Leaflet marker, or null to unregister
 */
export function setUprightMarker(marker) {
    uprightMarker = marker || null;
    uprightMarkerEl = null;
    applyUprightMarkerRotation();
}

// Dependencies set via init
let getMap = null;
let getMapVis = null;
let getMapPolyline = null;
let getState = null;

/**
 * Initialize map visualization module with dependencies
 * @param {Object} deps - Dependencies
 */
export function initMapVisualization(deps) {
    getMap = deps.getMap;
    getMapVis = deps.getMapVis;
    getMapPolyline = deps.getMapPolyline;
    getState = deps.getState;
}

/**
 * Update map visibility based on user toggle
 */
export function updateMapVisibility() {
    const mapVis = getMapVis?.();
    const map = getMap?.();
    const mapPolyline = getMapPolyline?.();
    const state = getState?.();

    if (!mapVis) return;
    mapVis.classList.toggle('user-hidden', !state?.ui?.mapEnabled);

    if (state?.ui?.mapEnabled && map) {
        setTimeout(() => {
            map.invalidateSize();
            if (mapPolyline) {
                let bounds;
                if (Array.isArray(mapPolyline) && mapPolyline.length > 0) {
                    bounds = mapPolyline[0].getBounds();
                    for (let i = 1; i < mapPolyline.length; i++) {
                        bounds = bounds.extend(mapPolyline[i].getBounds());
                    }
                } else if (mapPolyline.getBounds) {
                    bounds = mapPolyline.getBounds();
                }
                if (bounds) map.fitBounds(bounds, { padding: [20, 20] });
            } else if (mapMarker) {
                map.setView(mapMarker.getLatLng(), 16);
            }
        }, 150);
    }
}

/**
 * Update map marker position and heading
 * @param {Object} sei - SEI telemetry data
 * @param {Function} hasValidGps - Function to check if GPS is valid
 */
export function updateMapMarker(sei, hasValidGps) {
    const map = getMap?.();
    const state = getState?.();

    if (!map || !sei) return;

    const get = (camel, snake) => sei[camel] ?? sei[snake];
    const lat = get('latitudeDeg', 'latitude_deg') || 0;
    const lon = get('longitudeDeg', 'longitude_deg') || 0;
    const heading = get('headingDeg', 'heading_deg') || 0;

    if (hasValidGps(sei)) {
        const latlng = [lat, lon];

        if (Math.abs(lat) < 0.001 || Math.abs(lon) < 0.001) {
            if (mapMarker) {
                mapMarker.remove();
                mapMarker = null;
                mapMarkerArrowImg = null;
                lastMarkerFrameKey = null;
            }
            return;
        }

        const targetHeading = ((heading % 360) + 360) % 360;
        const transitionDuration = Math.max(0.03, 0.15 / (state?.ui?.playbackRate || 1));

        // Smooth the bearing transition to avoid jerky rotation
        let bearingDelta = targetHeading - (currentMapBearing % 360);
        if (bearingDelta > 180) bearingDelta -= 360;
        if (bearingDelta < -180) bearingDelta += 360;
        currentMapBearing += bearingDelta;

        // Attach zoom listener once to rescale arrow on zoom change
        if (!zoomListenerAttached) {
            map.on('zoomend', () => rebuildMarkerIcon(map));
            zoomListenerAttached = true;
        }

        const arrowSize = getArrowSizeForZoom(map.getZoom());
        const halfArrow = Math.round(arrowSize / 2);

        // In both modes the arrow img rotates by currentMapBearing:
        //   heading-up: counter-rotates against container rotation → points up
        //   north-up: shows actual heading direction
        const arrowRotation = currentMapBearing;

        // Nothing visibly changed since last frame — skip all Leaflet/DOM work
        const frameKey = `${lat.toFixed(6)},${lon.toFixed(6)},${currentMapBearing.toFixed(1)},${arrowSize},${mapOrientation}`;
        if (mapMarker && frameKey === lastMarkerFrameKey) return;
        lastMarkerFrameKey = frameKey;

        const mapContainer = map.getContainer();

        if (mapOrientation === 'heading-up') {
            // Heading-up: arrow always points up, map rotates underneath
            if (mapContainer) {
                mapContainer.style.transition = `transform ${transitionDuration}s ease-out`;
                mapContainer.style.transform = `rotate(${-currentMapBearing}deg) scale(1.42)`;
                mapContainer.style.transformOrigin = 'center center';
            }
        } else {
            // North-up: map stays fixed, no container rotation
            if (mapContainer) {
                mapContainer.style.transition = '';
                mapContainer.style.transform = 'rotate(0deg) scale(1)';
            }
        }

        if (!mapMarker) {
            const arrowIcon = L.divIcon({
                className: 'arrow-marker-icon',
                html: `<img src="../../assets/arrow.png" style="width:${arrowSize}px;height:${arrowSize}px;transform:rotate(${arrowRotation}deg);transform-origin:center center;display:block;" />`,
                iconSize: [arrowSize, arrowSize],
                iconAnchor: [halfArrow, halfArrow]
            });

            mapMarker = L.marker(latlng, { icon: arrowIcon }).addTo(map);
            mapMarkerArrowImg = mapMarker._icon?.querySelector('img') || null;
        } else {
            mapMarker.setLatLng(latlng);
            // Update arrow rotation and size (img element cached — re-query
            // only if the icon element was rebuilt, e.g. after setIcon)
            if (!mapMarkerArrowImg || !mapMarkerArrowImg.isConnected) {
                mapMarkerArrowImg = mapMarker._icon?.querySelector('img') || null;
            }
            if (mapMarkerArrowImg) {
                mapMarkerArrowImg.style.width = `${arrowSize}px`;
                mapMarkerArrowImg.style.height = `${arrowSize}px`;
                mapMarkerArrowImg.style.transform = `rotate(${arrowRotation}deg)`;
            }
        }

        // Keep the static event pin upright against the container rotation
        applyUprightMarkerRotation();

        // Store for recenter button
        window._mapCurrentMarkerLatLng = latlng;

        // Update compass icon rotation
        if (window._updateMapCompass) {
            window._updateMapCompass(currentMapBearing);
        }

        map.setView(latlng, map.getZoom(), { animate: false });
    } else if (mapMarker) {
        mapMarker.remove();
        mapMarker = null;
        mapMarkerArrowImg = null;
        lastMarkerFrameKey = null;
    }
}

/**
 * Clear map marker
 */
export function clearMapMarker() {
    if (mapMarker) {
        mapMarker.remove();
        mapMarker = null;
    }
    mapMarkerArrowImg = null;
    lastMarkerFrameKey = null;
    currentMapArrowRotation = 0;
    currentMapBearing = 0;
    window._mapCurrentMarkerLatLng = null;

    // Reset container rotation
    const map = getMap?.();
    if (map) {
        const mapContainer = map.getContainer();
        if (mapContainer) {
            mapContainer.style.transition = 'transform 0.3s ease-out';
            mapContainer.style.transform = 'rotate(0deg) scale(1)';
        }
    }

    // Bearing is now 0 — make sure the event pin (if still present) is upright
    applyUprightMarkerRotation();
}
