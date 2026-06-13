/**
 * Auto-Update System
 * Handles checking for and installing application updates
 * Includes changelog display with version comparison
 */

// DOM helper
const $ = id => document.getElementById(id);

// State
let updateComplete = false;
let isDownloading = false;
let changelogData = null;

// DOM element references (lazily cached)
let updateModal = null;
let updateProgress = null;
let updateProgressBar = null;
let updateProgressText = null;
let currentVersionDisplay = null;
let latestVersionDisplay = null;
let changelogContent = null;
let skipUpdateBtn = null;
let installUpdateBtn = null;
let updateModalFooter = null;

function getElements() {
    if (!updateModal) {
        updateModal = $('updateModal');
        updateProgress = $('updateProgress');
        updateProgressBar = $('updateProgressBar');
        updateProgressText = $('updateProgressText');
        currentVersionDisplay = $('currentVersionDisplay');
        latestVersionDisplay = $('latestVersionDisplay');
        changelogContent = $('changelogContent');
        skipUpdateBtn = $('skipUpdateBtn');
        installUpdateBtn = $('installUpdateBtn');
        updateModalFooter = $('updateModalFooter');
    }
}

/**
 * Compare two semantic version strings
 * @param {string} v1 - First version
 * @param {string} v2 - Second version
 * @returns {number} -1 if v1 < v2, 0 if equal, 1 if v1 > v2
 */
function compareVersions(v1, v2) {
    const parts1 = v1.replace(/^v/i, '').split('.').map(Number);
    const parts2 = v2.replace(/^v/i, '').split('.').map(Number);
    
    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
        const p1 = parts1[i] || 0;
        const p2 = parts2[i] || 0;
        if (p1 < p2) return -1;
        if (p1 > p2) return 1;
    }
    return 0;
}

/**
 * Get changelog entries newer than the current version
 * @param {string} currentVersion - Current app version
 * @returns {Array} Array of version entries newer than current
 */
function getRelevantChangelog(currentVersion) {
    if (!changelogData?.versions) return [];
    
    return changelogData.versions.filter(entry => {
        return compareVersions(entry.version, currentVersion) > 0;
    });
}

/**
 * Generate HTML for changelog entries
 * @param {Array} entries - Changelog entries to display
 * @returns {string} HTML string
 */
function renderChangelog(entries) {
    if (!entries || entries.length === 0) {
        return '<div class="changelog-loading">No changelog available</div>';
    }
    
    const typeIcons = {
        feature: '✦',
        improvement: '↑',
        fix: '✓'
    };
    
    return entries.map(entry => `
        <div class="changelog-version">
            <div class="changelog-version-header">
                <span class="changelog-version-tag">v${entry.version}</span>
                <span class="changelog-version-date">${formatDate(entry.date)}</span>
            </div>
            <div class="changelog-version-title">${entry.title}</div>
            <div class="changelog-changes">
                ${entry.changes.map(change => `
                    <div class="changelog-item">
                        <span class="changelog-item-type ${change.type}">${typeIcons[change.type] || '•'}</span>
                        <span>${change.description}</span>
                    </div>
                `).join('')}
            </div>
        </div>
    `).join('');
}

/**
 * Format date string for display
 * @param {string} dateStr - ISO date string
 * @returns {string} Formatted date
 */
function formatDate(dateStr) {
    try {
        const date = new Date(dateStr);
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch {
        return dateStr;
    }
}

/**
 * Load changelog data from file
 */
async function loadChangelog() {
    try {
        if (window.electronAPI?.getChangelog) {
            changelogData = await window.electronAPI.getChangelog();
        }
    } catch (err) {
        console.error('Failed to load changelog:', err);
        changelogData = null;
    }
}

/**
 * Show the update modal with version info
 * @param {Object} updateInfo - Update information
 */
export async function showUpdateModal(updateInfo) {
    getElements();
    if (!updateModal) return;
    
    // Don't reset the modal if we're already downloading
    if (isDownloading) return;
    
    updateComplete = false;
    
    // Display version info
    if (currentVersionDisplay) currentVersionDisplay.textContent = updateInfo.currentVersion;
    if (latestVersionDisplay) latestVersionDisplay.textContent = updateInfo.latestVersion;
    
    // Reset state
    if (updateProgress) updateProgress.classList.add('hidden');
    if (updateModalFooter) updateModalFooter.style.display = '';
    updateModal.querySelector('.update-modal')?.classList.remove('updating');
    
    // Show loading state for changelog
    if (changelogContent) {
        changelogContent.innerHTML = '<div class="changelog-loading">Loading changelog...</div>';
    }
    
    // Show modal
    updateModal.classList.remove('hidden');
    
    // Load and display changelog
    await loadChangelog();
    if (changelogContent) {
        const relevantEntries = getRelevantChangelog(updateInfo.currentVersion);
        changelogContent.innerHTML = renderChangelog(relevantEntries);
    }
}

/**
 * Hide the update modal
 */
function hideUpdateModal() {
    getElements();
    isDownloading = false;
    if (updateModal) updateModal.classList.add('hidden');
}

/**
 * Handle the install update button click
 * With electron-updater, this starts the download
 */
export async function handleInstallUpdate() {
    getElements();
    if (!window.electronAPI?.installUpdate) return;
    
    // Mark as downloading to prevent modal reset
    isDownloading = true;
    
    // Show progress, hide buttons
    if (updateProgress) updateProgress.classList.remove('hidden');
    if (updateModalFooter) updateModalFooter.style.display = 'none';
    updateModal?.querySelector('.update-modal')?.classList.add('updating');
    
    if (updateProgressBar) updateProgressBar.style.width = '0%';
    if (updateProgressText) updateProgressText.textContent = 'Starting download...';
    
    try {
        const result = await window.electronAPI.installUpdate();
        
        if (!result.success) {
            // Check for errors
            if (result.error) {
                isDownloading = false;
                if (updateProgressText) updateProgressText.textContent = `Update failed: ${result.error}`;
                if (updateModalFooter) updateModalFooter.style.display = '';
                updateModal?.querySelector('.update-modal')?.classList.remove('updating');
            }
        }
        // If successful, the download starts and progress events will update the UI
        // When download completes, update:downloaded event will trigger showUpdateDownloadedState
    } catch (err) {
        console.error('Update install error:', err);
        isDownloading = false;
        if (updateProgressText) updateProgressText.textContent = `Error: ${err.message}`;
        if (updateModalFooter) updateModalFooter.style.display = '';
        updateModal?.querySelector('.update-modal')?.classList.remove('updating');
    }
}

/**
 * Show update complete message for dev/manual install mode (npm start users)
 */
function showDevModeUpdateComplete() {
    getElements();
    updateComplete = true;
    isDownloading = false;
    
    if (updateProgressBar) updateProgressBar.style.width = '100%';
    if (updateProgressText) {
        updateProgressText.textContent = 'Update installed successfully!';
    }
    
    if (updateModalFooter) {
        updateModalFooter.innerHTML = `
            <p class="restart-message">Please restart the app with <code>npm start</code></p>
            <button id="exitAppBtn" class="btn btn-primary">Exit App</button>
        `;
        updateModalFooter.style.display = '';
        
        const exitBtn = document.getElementById('exitAppBtn');
        if (exitBtn) {
            exitBtn.addEventListener('click', () => {
                if (window.electronAPI?.exitApp) {
                    window.electronAPI.exitApp();
                }
            });
        }
    }
    
    updateModal?.querySelector('.update-modal')?.classList.remove('updating');
}

/**
 * Show state when update has been downloaded and is ready to install
 */
function showUpdateDownloadedState() {
    getElements();
    updateComplete = true;
    isDownloading = false;
    
    if (updateProgressBar) updateProgressBar.style.width = '100%';
    if (updateProgressText) {
        updateProgressText.textContent = 'Update downloaded! Ready to install.';
    }
    
    if (updateModalFooter) {
        updateModalFooter.innerHTML = `
            <p class="restart-message">Click the button below to install the update and restart the app.</p>
            <button id="restartAppBtn" class="btn btn-primary">Install & Restart</button>
        `;
        updateModalFooter.style.display = '';
        
        const restartBtn = document.getElementById('restartAppBtn');
        if (restartBtn) {
            restartBtn.addEventListener('click', () => {
                if (window.electronAPI?.installAndRestart) {
                    window.electronAPI.installAndRestart();
                } else if (window.electronAPI?.exitApp) {
                    window.electronAPI.exitApp();
                }
            });
        }
    }
    
    updateModal?.querySelector('.update-modal')?.classList.remove('updating');
}

/**
 * Show the force manual update modal (killswitch activated)
 * This is a critical alert that requires manual download
 * @param {Object} info - Force manual update info from server
 */
function showForceManualModal(info) {
    getElements();
    if (!updateModal) return;
    
    // Display version info
    if (currentVersionDisplay) currentVersionDisplay.textContent = info.currentVersion || '---';
    if (latestVersionDisplay) latestVersionDisplay.textContent = info.new_version || '---';
    
    // Reset state
    if (updateProgress) updateProgress.classList.add('hidden');
    
    // Show critical message in changelog area
    if (changelogContent) {
        changelogContent.innerHTML = `
            <div class="force-manual-alert">
                <div class="force-manual-icon"><span class="material-symbols-outlined">warning</span></div>
                <div class="force-manual-title">Critical Update Required</div>
                <div class="force-manual-message">${info.message || 'A critical update is required. Please download the latest version manually.'}</div>
            </div>
        `;
    }
    
    // Replace footer with download button only (no "Update Now" or "Later")
    if (updateModalFooter) {
        updateModalFooter.innerHTML = `
            <button id="forceManualDownloadBtn" class="btn btn-primary btn-critical">
                <span class="material-symbols-outlined mi-sm">download</span>
                Download from GitHub
            </button>
        `;
        updateModalFooter.style.display = '';
        
        const downloadBtn = document.getElementById('forceManualDownloadBtn');
        if (downloadBtn) {
            downloadBtn.addEventListener('click', () => {
                const downloadUrl = info.download_url || 'https://github.com/Sentry-Six/Sentry-Six/releases/latest';
                if (window.electronAPI?.openExternal) {
                    window.electronAPI.openExternal(downloadUrl);
                }
            });
        }
    }
    
    // Add critical styling to modal
    updateModal.querySelector('.update-modal')?.classList.add('critical-update');
    
    // Show modal (cannot be dismissed by clicking outside)
    updateModal.classList.remove('hidden');
}

/**
 * Initialize the auto-update system
 */
export function initAutoUpdate() {
    getElements();
    
    // Set up update event listeners
    if (window.electronAPI?.on) {
        // Listen for update available event from main process
        window.electronAPI.on('update:available', (updateInfo) => {
            console.log('Update available:', updateInfo);
            showUpdateModal(updateInfo);
        });
        
        // Listen for force manual update (killswitch)
        window.electronAPI.on('update:forceManual', (info) => {
            console.log('Force manual update required (killswitch):', info);
            showForceManualModal(info);
        });
        
        // Listen for update progress
        window.electronAPI.on('update:progress', (progress) => {
            getElements();
            if (updateProgressBar) updateProgressBar.style.width = `${progress.percentage}%`;
            if (updateProgressText) updateProgressText.textContent = progress.message;
        });
        
        // Listen for update downloaded (ready to install)
        window.electronAPI.on('update:downloaded', (info) => {
            console.log('Update downloaded, ready to install', info);
            if (info?.isDevMode) {
                // Dev mode - show npm start restart message
                showDevModeUpdateComplete();
            } else {
                // Packaged install (NSIS on Windows, Squirrel.Mac on macOS) -
                // show Install & Restart button; electron-updater applies the
                // downloaded update via quitAndInstall().
                showUpdateDownloadedState();
            }
        });
    }
    
    // Button handlers
    if (skipUpdateBtn) {
        skipUpdateBtn.addEventListener('click', () => {
            hideUpdateModal();
            if (window.electronAPI?.skipUpdate) {
                window.electronAPI.skipUpdate();
            }
        });
    }
    
    if (installUpdateBtn) {
        installUpdateBtn.addEventListener('click', handleInstallUpdate);
    }
    
    // Close modal when clicking outside (but not during, after update, or critical update)
    if (updateModal) {
        updateModal.addEventListener('click', (e) => {
            const isUpdating = updateModal.querySelector('.update-modal')?.classList.contains('updating');
            const isCritical = updateModal.querySelector('.update-modal')?.classList.contains('critical-update');
            if (e.target === updateModal && !updateComplete && !isUpdating && !isCritical) {
                hideUpdateModal();
            }
        });
    }
}
