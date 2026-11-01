/**
 * Welcome Screen
 * Handles the mandatory security notice screen with privacy-version gating.
 * Shows on first run AND whenever the privacy version is bumped.
 */

import { t } from '../lib/i18n.js';

console.log('[WELCOME] Module loaded');

// Privacy version — bump this whenever the data-collection terms change
const CURRENT_PRIVACY_VERSION = 3;

// DOM helper
const $ = id => document.getElementById(id);

// State
let welcomeModal = null;
let acceptBtn = null;

function getElements() {
    if (!welcomeModal) {
        welcomeModal = $('softTcModal');
        acceptBtn = $('softTcAcceptBtn');
    }
}

/**
 * Apply the correct text variant to the modal
 * @param {boolean} isReturningUser - true if the user has completed first run before
 */
function applyModalVariant(isReturningUser) {
    const titleEl = document.querySelector('#softTcModal .modal-header h2');
    const subtitleEl = document.getElementById('softTcPrivacyTitle');
    const messageEl = document.getElementById('softTcPrivacyMessage');

    if (isReturningUser) {
        if (titleEl) titleEl.textContent = t('welcomeScreen.returningTitle') || 'Quick Update: Privacy & Security';
        if (subtitleEl) subtitleEl.textContent = t('welcomeScreen.returningSubtitle') || 'What Changed';
        if (messageEl) messageEl.textContent = t('welcomeScreen.returningMessage') || "Your dashcam footage stays on your device unless you choose to share a clip. Update checks send your OS, CPU architecture, app version and a pseudonymous install ID. Map tiles come from tiles.sentryusb.com or OpenStreetMap, which see roughly where you drive. If you turn on Place Names in Settings, drive start and end coordinates are sent to OpenStreetMap Nominatim.";
    } else {
        if (titleEl) titleEl.textContent = t('welcomeScreen.title') || 'Welcome to Sentry Studio';
        if (subtitleEl) subtitleEl.textContent = t('welcomeScreen.privacyTitle') || 'Privacy & Security';
        if (messageEl) messageEl.textContent = t('welcomeScreen.privacyMessage') || "By using Sentry Studio, you agree to our Terms of Service and Privacy Policy. Your dashcam footage stays on your device unless you choose to share a clip. Update checks send your OS, CPU architecture, app version and a pseudonymous install ID. Map tiles come from tiles.sentryusb.com or OpenStreetMap, which see roughly where you drive. If you turn on Place Names in Settings, drive start and end coordinates are sent to OpenStreetMap Nominatim.";
    }
}

// Track whether ESC handler has been added
let escHandlerAdded = false;

/**
 * Show the welcome modal
 * @param {boolean} isReturningUser - whether this is a returning user seeing updated terms
 */
function showWelcomeModal(isReturningUser = false) {
    getElements();
    if (!welcomeModal) return;

    // Apply the correct text variant before showing
    applyModalVariant(isReturningUser);
    
    // Show modal
    welcomeModal.classList.remove('hidden');
    
    // Set up external links for Terms and Privacy (use onclick to prevent duplicates)
    const termsLink = document.getElementById('softTcTermsLink');
    const privacyLink = document.getElementById('softTcPrivacyLink');
    
    if (termsLink) {
        termsLink.onclick = (e) => {
            e.preventDefault();
            window.electronAPI?.openExternal?.('https://sentry-six.com/terms');
        };
    }
    if (privacyLink) {
        privacyLink.onclick = (e) => {
            e.preventDefault();
            window.electronAPI?.openExternal?.('https://sentry-six.com/privacy');
        };
    }
    
    // Set up accept button handler (use onclick to prevent duplicate listeners)
    if (acceptBtn) {
        acceptBtn.onclick = async () => {
            console.log('[WELCOME] Accept button clicked, saving settings...');
            
            if (window.electronAPI?.setSetting) {
                await window.electronAPI.setSetting('firstRunComplete', true);
                await window.electronAPI.setSetting('acceptedPrivacyVersion', CURRENT_PRIVACY_VERSION);
            }
            
            // Hide modal
            hideWelcomeModal();
            
            // Trigger initial update check
            if (window.electronAPI?.checkForUpdates) {
                console.log('[WELCOME] Triggering initial update check');
                window.electronAPI.checkForUpdates();
            }
            
            // Show welcome guide/tour after privacy acceptance
            if (window._checkAndShowWelcomeGuide) {
                setTimeout(() => window._checkAndShowWelcomeGuide(), 500);
            }
        };
        
        // Active acknowledgment: disable Accept button for 2 seconds
        acceptBtn.disabled = true;
        acceptBtn.style.opacity = '0.5';
        acceptBtn.style.cursor = 'not-allowed';
        setTimeout(() => {
            acceptBtn.disabled = false;
            acceptBtn.style.opacity = '';
            acceptBtn.style.cursor = '';
            acceptBtn.focus();
        }, 2000);
    }
    
    // Prevent closing by clicking outside (use onclick to prevent duplicates)
    welcomeModal.onclick = (e) => {
        if (e.target === welcomeModal) {
            e.preventDefault();
            e.stopPropagation();
        }
    };
    
    // Prevent ESC key from closing (only add once)
    if (!escHandlerAdded) {
        document.addEventListener('keydown', function escHandler(e) {
            if (e.key === 'Escape' && welcomeModal && !welcomeModal.classList.contains('hidden')) {
                e.preventDefault();
                e.stopPropagation();
            }
        });
        escHandlerAdded = true;
    }
}

/**
 * Hide the welcome modal
 */
function hideWelcomeModal() {
    getElements();
    if (welcomeModal) {
        welcomeModal.classList.add('hidden');
    }
}

/**
 * Initialize the welcome screen system
 * Uses privacyVersion gating — shows modal if acceptedPrivacyVersion is missing or outdated
 */
export async function initWelcomeScreen() {
    getElements();
    
    console.log('[WELCOME] Initializing welcome screen...');
    
    if (window.electronAPI?.getSetting) {
        const firstRunComplete = await window.electronAPI.getSetting('firstRunComplete');
        const acceptedPrivacyVersion = await window.electronAPI.getSetting('acceptedPrivacyVersion');
        
        console.log('[WELCOME] Settings:', { firstRunComplete, acceptedPrivacyVersion, required: CURRENT_PRIVACY_VERSION });
        
        const needsPrivacyAcceptance = !acceptedPrivacyVersion || acceptedPrivacyVersion < CURRENT_PRIVACY_VERSION;
        
        if (needsPrivacyAcceptance) {
            const isReturningUser = firstRunComplete === true;
            console.log('[WELCOME] Showing modal:', isReturningUser ? 'returning user' : 'first run');
            showWelcomeModal(isReturningUser);
            
            return true; // Modal was shown
        }
    }
    
    console.log('[WELCOME] Privacy terms already accepted, skipping modal');
    return false; // Modal was not shown
}

/**
 * Reset the welcome screen (for developer testing)
 */
export async function resetWelcomeScreen() {
    if (window.electronAPI?.setSetting) {
        await window.electronAPI.setSetting('firstRunComplete', false);
        await window.electronAPI.setSetting('acceptedPrivacyVersion', 0);
    }
}

/**
 * Show the welcome screen manually (for developer testing)
 */
export function showWelcomeScreen() {
    showWelcomeModal(false);
}
