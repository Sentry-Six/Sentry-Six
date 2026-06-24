/**
 * Dashboard Visibility
 * Handles dashboard overlay visibility toggle
 */

// Dependencies set via init
let getDashboardVis = null;
let getState = null;

/**
 * Initialize dashboard visibility module with dependencies
 * @param {Object} deps - Dependencies
 */
export function initDashboardVisibility(deps) {
    getDashboardVis = deps.getDashboardVis;
    getState = deps.getState;
}

/**
 * Update dashboard visibility based on user toggle
 */
export function updateDashboardVisibility() {
    const dashboardVis = getDashboardVis?.();
    const state = getState?.();

    if (!dashboardVis) return;

    // Get current dashboard layout setting
    const compactDash = document.getElementById('dashboardVisCompact');
    const dashboardLayout = window.dashboardLayout || 'default';
    const enabled = !!state?.ui?.dashboardEnabled;

    // Hide all first
    dashboardVis.classList.add('user-hidden');
    if (compactDash) { compactDash.classList.add('user-hidden', 'hidden'); compactDash.classList.remove('visible'); }

    // Show the active layout if enabled
    if (dashboardLayout === 'compact' && compactDash) {
        if (enabled) {
            compactDash.classList.remove('user-hidden', 'hidden');
            compactDash.classList.add('visible');
        }
    } else {
        dashboardVis.classList.toggle('user-hidden', !enabled);
    }
}

// Dashboard layout containers that support the parked state. Toggling the class
// on all of them is safe (only the active layout is visible).
const PARKED_CONTAINER_IDS = ['dashboardVis', 'dashboardVisCompact'];

/**
 * Toggle the "parked" telemetry-gap state on the live dashboard. When parked,
 * CSS hides the gauges and shows a centered PARKED label while the clock stays.
 * Independent of the user's on/off toggle. Idempotent (safe to call per frame).
 * @param {boolean} parked
 */
export function setDashboardParked(parked) {
    for (const id of PARKED_CONTAINER_IDS) {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('telemetry-parked', parked);
    }
}
