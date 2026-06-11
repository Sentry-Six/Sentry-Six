/**
 * G-Force Meter Visualization
 * Displays lateral and longitudinal G-forces from vehicle telemetry
 */

// Constants
const GRAVITY = 9.81; // m/s² per G
const GFORCE_SCALE = 25; // pixels per G (radius of meter is ~28px, so 1G reaches near edge)
const GFORCE_HISTORY_MAX = 3;

// G-Force trail history (stores last few positions)
const gforceHistory = [];

// Last rendered position — this runs at 60Hz, so skip the 8 SVG attribute
// writes + class/text updates whenever the value hasn't visibly moved
// (constant while parked/cruising, which is most of Sentry footage)
let lastRenderKey = null;

// DOM element references (lazily cached)
let gforceDot = null;
let gforceTrail1 = null;
let gforceTrail2 = null;
let gforceTrail3 = null;
let gforceX = null;
let gforceY = null;

function getElements() {
    if (!gforceDot) {
        gforceDot = document.getElementById('gforceDot');
        gforceTrail1 = document.getElementById('gforceTrail1');
        gforceTrail2 = document.getElementById('gforceTrail2');
        gforceTrail3 = document.getElementById('gforceTrail3');
        gforceX = document.getElementById('gforceX');
        gforceY = document.getElementById('gforceY');
    }
}

/**
 * Update the G-Force meter visualization
 * @param {Object} sei - SEI telemetry data from video
 */
export function updateGForceMeter(sei) {
    getElements();
    if (!gforceDot) return;

    // Get acceleration values (in m/s²) - support both naming conventions
    const accX = sei?.linearAccelerationMps2X ?? sei?.linear_acceleration_mps2_x ?? 0;
    const accY = sei?.linearAccelerationMps2Y ?? sei?.linear_acceleration_mps2_y ?? 0;

    // Convert to G-force
    const gX = accX / GRAVITY;
    const gY = accY / GRAVITY;

    // Clamp to reasonable range (-2G to +2G for display)
    const clampedGX = Math.max(-2, Math.min(2, gX));
    const clampedGY = Math.max(-2, Math.min(2, gY));

    // Calculate dot position (center is 30,30 in the SVG viewBox)
    // X: positive = right (cornering left causes rightward force)
    // Y: positive = down (braking causes forward force, shown as down)
    const dotX = 30 + (clampedGX * GFORCE_SCALE);
    const dotY = 30 - (clampedGY * GFORCE_SCALE); // Invert Y so acceleration shows up

    // Sub-0.1px movement is invisible at this meter size — skip the DOM work,
    // but only once the trail has fully collapsed onto the dot. Skipping
    // before then froze the trail dots at their last moving positions for as
    // long as the reading stayed constant.
    const renderKey = `${dotX.toFixed(1)},${dotY.toFixed(1)}`;
    const trailSettled = gforceHistory.length >= GFORCE_HISTORY_MAX &&
        gforceHistory.every(p => p.x === dotX && p.y === dotY);
    if (renderKey === lastRenderKey && trailSettled) return;
    lastRenderKey = renderKey;

    // Update trail history
    gforceHistory.unshift({ x: dotX, y: dotY });
    if (gforceHistory.length > GFORCE_HISTORY_MAX) {
        gforceHistory.pop();
    }

    // Update dot position
    gforceDot.setAttribute('cx', dotX);
    gforceDot.setAttribute('cy', dotY);

    // Update trail dots
    if (gforceTrail1 && gforceHistory.length > 0) {
        gforceTrail1.setAttribute('cx', gforceHistory[0]?.x || 30);
        gforceTrail1.setAttribute('cy', gforceHistory[0]?.y || 30);
    }
    if (gforceTrail2 && gforceHistory.length > 1) {
        gforceTrail2.setAttribute('cx', gforceHistory[1]?.x || 30);
        gforceTrail2.setAttribute('cy', gforceHistory[1]?.y || 30);
    }
    if (gforceTrail3 && gforceHistory.length > 2) {
        gforceTrail3.setAttribute('cx', gforceHistory[2]?.x || 30);
        gforceTrail3.setAttribute('cy', gforceHistory[2]?.y || 30);
    }

    // Color the dot based on force type
    const totalG = Math.sqrt(gX * gX + gY * gY);
    gforceDot.classList.remove('braking', 'accelerating', 'cornering-hard');
    if (gY < -0.3) {
        gforceDot.classList.add('braking');
    } else if (gY > 0.3) {
        gforceDot.classList.add('accelerating');
    } else if (Math.abs(gX) > 0.5) {
        gforceDot.classList.add('cornering-hard');
    }

    // Update numeric displays
    if (gforceX) {
        gforceX.textContent = (gX >= 0 ? '+' : '') + gX.toFixed(1);
        gforceX.classList.remove('positive', 'negative', 'high');
        if (Math.abs(gX) > 0.8) gforceX.classList.add('high');
        else if (gX > 0.2) gforceX.classList.add('positive');
        else if (gX < -0.2) gforceX.classList.add('negative');
    }
    if (gforceY) {
        gforceY.textContent = (gY >= 0 ? '+' : '') + gY.toFixed(1);
        gforceY.classList.remove('positive', 'negative', 'high');
        if (Math.abs(gY) > 0.8) gforceY.classList.add('high');
        else if (gY > 0.2) gforceY.classList.add('positive');
        else if (gY < -0.2) gforceY.classList.add('negative');
    }
}

/**
 * Reset the G-Force meter to default state
 */
export function resetGForceMeter() {
    getElements();
    lastRenderKey = null;
    if (gforceDot) {
        gforceDot.setAttribute('cx', 30);
        gforceDot.setAttribute('cy', 30);
        gforceDot.classList.remove('braking', 'accelerating', 'cornering-hard');
    }
    if (gforceTrail1) { gforceTrail1.setAttribute('cx', 30); gforceTrail1.setAttribute('cy', 30); }
    if (gforceTrail2) { gforceTrail2.setAttribute('cx', 30); gforceTrail2.setAttribute('cy', 30); }
    if (gforceTrail3) { gforceTrail3.setAttribute('cx', 30); gforceTrail3.setAttribute('cy', 30); }
    gforceHistory.length = 0;
    if (gforceX) { gforceX.textContent = '0.0'; gforceX.classList.remove('positive', 'negative', 'high'); }
    if (gforceY) { gforceY.textContent = '0.0'; gforceY.classList.remove('positive', 'negative', 'high'); }
}
