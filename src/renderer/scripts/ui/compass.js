/**
 * Compass Visualization
 * Displays heading direction from vehicle telemetry
 */

// DOM element references (lazily cached)
let compassNeedle = null;
let compassValue = null;

// Last rendered heading — called at 60Hz, and SVG transform writes trigger
// repaints even when the value is identical (e.g. driving straight)
let lastHeading = null;

function getElements() {
    if (!compassNeedle) {
        compassNeedle = document.getElementById('compassNeedle');
        compassValue = document.getElementById('compassValue');
    }
}

/**
 * Update the compass visualization
 * @param {Object} sei - SEI telemetry data from video
 */
export function updateCompass(sei) {
    getElements();
    if (!compassNeedle) return;

    // Get heading - support both naming conventions
    let heading = parseFloat(sei?.headingDeg ?? sei?.heading_deg);
    if (!Number.isFinite(heading)) heading = 0;
    
    // Normalize to 0-360 range
    heading = ((heading % 360) + 360) % 360;

    // Skip the DOM writes when the needle wouldn't visibly move
    const rounded = Math.round(heading * 10) / 10;
    if (rounded === lastHeading) return;
    lastHeading = rounded;

    // Rotate the needle - heading 0° = North (pointing up)
    compassNeedle.setAttribute('transform', `rotate(${heading} 30 30)`);
    
    // Update numeric display
    if (compassValue) {
        // Format heading with cardinal direction
        const cardinals = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
        const index = Math.round(heading / 45) % 8;
        const cardinal = cardinals[index] || 'N';
        compassValue.textContent = `${Math.round(heading)}° ${cardinal}`;
    }
}

/**
 * Reset the compass to default state
 */
export function resetCompass() {
    getElements();
    lastHeading = null;
    if (compassNeedle) compassNeedle.setAttribute('transform', 'rotate(0 30 30)');
    if (compassValue) compassValue.textContent = '--';
}
