/**
 * Settings Modal
 * Handles the settings panel UI and preferences
 */

import { initKeybindSettings } from '../lib/keybinds.js';
import { getCurrentLanguage, setLanguage, getAvailableLanguages, onLanguageChange, t } from '../lib/i18n.js';
import { initFeatureBadges, FEATURE_BADGE_KEYS } from '../features/exportVideo.js';


/**
 * Initialize collapsible sections
 */
function initCollapsibleSections() {
    document.querySelectorAll('.collapsible-header').forEach(header => {
        header.addEventListener('click', () => {
            const section = header.closest('.collapsible-section');
            if (section) {
                section.classList.toggle('open');
            }
        });
    });
}

// DOM helper
const $ = id => document.getElementById(id);

// Dependencies set via init
let getState = null;
let getUseMetric = null;
let updateEventCameraHighlight = null;
let resetCameraOrder = null;
let openDevSettingsModal = null;
let setLayoutStyle = null;
let getLayoutStyle = null;

/**
 * Initialize settings modal with dependencies
 * @param {Object} deps - Dependencies
 */
export function initSettingsModalDeps(deps) {
    getState = deps.getState;
    getUseMetric = deps.getUseMetric;
    updateEventCameraHighlight = deps.updateEventCameraHighlight;
    resetCameraOrder = deps.resetCameraOrder;
    openDevSettingsModal = deps.openDevSettingsModal;
    setLayoutStyle = deps.setLayoutStyle;
    getLayoutStyle = deps.getLayoutStyle;
}

/**
 * Initialize the settings modal
 */
export function initSettingsModal() {
    const state = getState?.();
    const useMetric = getUseMetric?.();

    const settingsBtn = $('settingsBtn');
    const settingsModal = $('settingsModal');

    // Initialize collapsible sections (for export modal)
    initCollapsibleSections();

    // Sidebar tab navigation for horizontal settings layout
    if (settingsModal) {
        const navItems = settingsModal.querySelectorAll('.settings-nav-item');
        const accordions = settingsModal.querySelectorAll('.settings-accordion');

        navItems.forEach(navItem => {
            navItem.addEventListener('click', () => {
                const target = navItem.dataset.target;

                // Update active nav item
                navItems.forEach(n => n.classList.remove('active'));
                navItem.classList.add('active');

                // Show target accordion, hide others
                accordions.forEach(acc => {
                    if (acc.dataset.section === target) {
                        acc.classList.add('open');
                    } else {
                        acc.classList.remove('open');
                    }
                });

                // Scroll content to top
                const content = settingsModal.querySelector('.settings-content');
                if (content) content.scrollTop = 0;
            });
        });
    }

    const closeSettingsModal = $('closeSettingsModal');
    const closeSettingsBtn = $('closeSettingsBtn');

    const settingsDashboardToggle = $('settingsDashboardToggle');
    const settingsMapToggle = $('settingsMapToggle');
    const settingsMetricToggle = $('settingsMetricToggle');

    const dashboardToggle = $('dashboardToggle');
    const mapToggle = $('mapToggle');
    const metricToggle = $('metricToggle');

    const defaultFolderPath = $('defaultFolderPath');
    const browseDefaultFolderBtn = $('browseDefaultFolderBtn');
    const clearDefaultFolderBtn = $('clearDefaultFolderBtn');
    const defaultFolderStatus = $('defaultFolderStatus');

    const driveDataFilePath = $('driveDataFilePath');
    const browseDriveDataFileBtn = $('browseDriveDataFileBtn');
    const clearDriveDataFileBtn = $('clearDriveDataFileBtn');
    const driveDataFileStatus = $('driveDataFileStatus');

    // Initialize settings values
    if (settingsDashboardToggle && state) settingsDashboardToggle.checked = state.ui.dashboardEnabled;
    if (settingsMapToggle && state) settingsMapToggle.checked = state.ui.mapEnabled;
    if (settingsMetricToggle) settingsMetricToggle.checked = useMetric;

    // Load saved default folder
    if (window.electronAPI?.getSetting && defaultFolderPath) {
        window.electronAPI.getSetting('defaultFolder').then(savedFolder => {
            if (savedFolder) defaultFolderPath.value = savedFolder;
        });
    }

    // Load saved drive data file path
    if (window.electronAPI?.getSetting && driveDataFilePath) {
        window.electronAPI.getSetting('sentryUsbDataPath').then(savedPath => {
            if (savedPath) driveDataFilePath.value = savedPath;
        });
    }

    // Open settings modal
    if (settingsBtn) {
        settingsBtn.onclick = (e) => {
            e.preventDefault();
            if (settingsModal) {
                const currentState = getState?.();
                const currentUseMetric = getUseMetric?.();
                if (settingsDashboardToggle && currentState) settingsDashboardToggle.checked = currentState.ui.dashboardEnabled;
                if (settingsMapToggle && currentState) settingsMapToggle.checked = currentState.ui.mapEnabled;
                if (settingsMetricToggle) settingsMetricToggle.checked = currentUseMetric;

                // Sync map mode dropdown
                const settingsMapMode = $('settingsMapMode');
                if (settingsMapMode) settingsMapMode.value = window._mapDarkMode ? 'dark' : 'light';

                // Sync layout style toggle
                const settingsLayoutStyle = $('settingsLayoutStyle');
                if (settingsLayoutStyle) {
                    const currentStyle = getLayoutStyle?.() || 'modern';
                    settingsLayoutStyle.checked = currentStyle === 'classic';
                }

                const disableAutoUpdate = $('settingsDisableAutoUpdate');
                if (disableAutoUpdate && window.electronAPI?.getSetting) {
                    window.electronAPI.getSetting('disableAutoUpdate').then(savedValue => {
                        disableAutoUpdate.checked = savedValue === true;
                    });
                }

                settingsModal.classList.remove('hidden');
            }
            settingsBtn.blur();
        };
    }

    function closeSettings() {
        if (settingsModal) settingsModal.classList.add('hidden');
    }

    if (closeSettingsModal) closeSettingsModal.onclick = closeSettings;
    if (closeSettingsBtn) closeSettingsBtn.onclick = closeSettings;

    if (settingsModal) {
        settingsModal.onclick = (e) => {
            if (e.target === settingsModal) closeSettings();
        };
    }

    // Dashboard toggle
    if (settingsDashboardToggle) {
        settingsDashboardToggle.onchange = () => {
            if (dashboardToggle) {
                dashboardToggle.checked = settingsDashboardToggle.checked;
                dashboardToggle.dispatchEvent(new Event('change'));
            }
            settingsDashboardToggle.blur();
        };
    }

    // Dashboard layout setting
    const settingsDashboardLayout = $('settingsDashboardLayout');
    const settingsCompactDashboardFixedRow = $('settingsCompactDashboardFixedRow');
    const settingsCompactDashboardFixed = $('settingsCompactDashboardFixed');

    if (settingsDashboardLayout && window.electronAPI?.getSetting) {
        window.electronAPI.getSetting('dashboardLayout').then(savedLayout => {
            settingsDashboardLayout.value = savedLayout || 'default';

            // Show/hide fixed toggle based on saved layout
            if (savedLayout === 'compact') {
                if (settingsCompactDashboardFixedRow) settingsCompactDashboardFixedRow.classList.remove('hidden');
            } else {
                if (settingsCompactDashboardFixedRow) settingsCompactDashboardFixedRow.classList.add('hidden');
            }
        });

        // Load saved fixed/movable setting
        if (settingsCompactDashboardFixed && window.electronAPI?.getSetting) {
            window.electronAPI.getSetting('compactDashboardFixed').then(savedFixed => {
                settingsCompactDashboardFixed.checked = savedFixed !== false; // Default to true (fixed)
            });
        }

        settingsDashboardLayout.onchange = async () => {
            const layout = settingsDashboardLayout.value || 'default';
            if (window.electronAPI?.setSetting) {
                await window.electronAPI.setSetting('dashboardLayout', layout);
            }
            // Trigger layout update
            if (window.updateDashboardLayout) {
                window.updateDashboardLayout(layout);
            }

            // Show/hide fixed toggle based on selected layout
            if (layout === 'compact') {
                if (settingsCompactDashboardFixedRow) settingsCompactDashboardFixedRow.classList.remove('hidden');
            } else {
                if (settingsCompactDashboardFixedRow) settingsCompactDashboardFixedRow.classList.add('hidden');
            }
            settingsDashboardLayout.blur();
        };
    }

    // Compact dashboard fixed/movable toggle
    if (settingsCompactDashboardFixed && window.electronAPI?.getSetting) {
        settingsCompactDashboardFixed.onchange = async () => {
            const isFixed = settingsCompactDashboardFixed.checked;
            if (window.electronAPI?.setSetting) {
                await window.electronAPI.setSetting('compactDashboardFixed', isFixed);
            }
            // Update dashboard positioning
            if (window.updateCompactDashboardPositioning) {
                window.updateCompactDashboardPositioning(isFixed);
            }
            settingsCompactDashboardFixed.blur();
        };
    }

    // App theme (Dark/Light) setting
    const settingsAppTheme = $('settingsAppTheme');
    if (settingsAppTheme && window.electronAPI?.getSetting) {
        window.electronAPI.getSetting('appTheme').then(savedTheme => {
            const theme = savedTheme || 'dark';
            settingsAppTheme.value = theme;
            window.applyAppTheme?.(theme);
        });

        settingsAppTheme.onchange = async () => {
            const theme = settingsAppTheme.value || 'dark';
            if (window.electronAPI?.setSetting) {
                await window.electronAPI.setSetting('appTheme', theme);
            }
            window.applyAppTheme?.(theme);
            settingsAppTheme.blur();
        };
    }

    // Accelerator pedal display mode setting
    const settingsAccelPedMode = $('settingsAccelPedMode');
    if (settingsAccelPedMode && window.electronAPI?.getSetting) {
        window.electronAPI.getSetting('accelPedMode').then(savedMode => {
            settingsAccelPedMode.value = savedMode || 'iconbar';
            // Apply mode immediately
            if (window.updateAccelPedMode) {
                window.updateAccelPedMode(savedMode || 'iconbar');
            }
        });

        settingsAccelPedMode.onchange = async () => {
            const mode = settingsAccelPedMode.value || 'iconbar';
            if (window.electronAPI?.setSetting) {
                await window.electronAPI.setSetting('accelPedMode', mode);
            }
            // Apply mode to all dashboards
            if (window.updateAccelPedMode) {
                window.updateAccelPedMode(mode);
            }
            settingsAccelPedMode.blur();
        };
    }

    // Map toggle
    if (settingsMapToggle) {
        settingsMapToggle.onchange = () => {
            if (mapToggle) {
                mapToggle.checked = settingsMapToggle.checked;
                mapToggle.dispatchEvent(new Event('change'));
            }
            settingsMapToggle.blur();
        };
    }

    // Map mode dropdown (light/dark)
    const settingsMapMode = $('settingsMapMode');
    if (settingsMapMode && window.electronAPI?.getSetting) {
        window.electronAPI.getSetting('mapDarkMode').then(saved => {
            settingsMapMode.value = saved === true ? 'dark' : 'light';
        });

        settingsMapMode.onchange = async () => {
            const enabled = settingsMapMode.value === 'dark';
            window._mapDarkMode = enabled;
            if (window.electronAPI?.setSetting) {
                await window.electronAPI.setSetting('mapDarkMode', enabled);
            }
            if (window.applyMapDarkMode) {
                window.applyMapDarkMode(enabled);
            }
            settingsMapMode.blur();
        };
    }

    // Metric toggle
    if (settingsMetricToggle) {
        settingsMetricToggle.onchange = () => {
            if (metricToggle) {
                metricToggle.checked = settingsMetricToggle.checked;
                metricToggle.dispatchEvent(new Event('change'));
            }
            settingsMetricToggle.blur();
        };
    }

    // Date format setting
    const settingsDateFormat = $('settingsDateFormat');
    if (settingsDateFormat) {
        // Load saved date format
        if (window.electronAPI?.getSetting) {
            window.electronAPI.getSetting('dateFormat').then(savedValue => {
                settingsDateFormat.value = savedValue || 'ymd';
                window._dateFormat = savedValue || 'ymd';
            });
        } else {
            window._dateFormat = 'ymd';
        }

        settingsDateFormat.addEventListener('change', async function () {
            const format = this.value;
            window._dateFormat = format;
            if (window.electronAPI?.setSetting) {
                await window.electronAPI.setSetting('dateFormat', format);
            }
            // Dispatch event so other components can update
            window.dispatchEvent(new CustomEvent('dateFormatChanged', { detail: { format } }));
            settingsDateFormat.blur();
        });
    }

    // Time format setting (12h/24h)
    const settingsTimeFormat = $('settingsTimeFormat');
    if (settingsTimeFormat) {
        // Load saved time format
        if (window.electronAPI?.getSetting) {
            window.electronAPI.getSetting('timeFormat').then(savedValue => {
                settingsTimeFormat.value = savedValue || '12h';
                window._timeFormat = savedValue || '12h';
            });
        } else {
            window._timeFormat = '12h';
        }

        settingsTimeFormat.addEventListener('change', async function () {
            const format = this.value;
            window._timeFormat = format;
            if (window.electronAPI?.setSetting) {
                await window.electronAPI.setSetting('timeFormat', format);
            }
            // Dispatch event so other components can update
            window.dispatchEvent(new CustomEvent('timeFormatChanged', { detail: { format } }));
            settingsTimeFormat.blur();
        });
    }

    // Mirror cameras setting
    const settingsMirrorCameras = $('settingsMirrorCameras');
    if (settingsMirrorCameras) {
        // Load saved mirror setting (default true for backwards compatibility)
        if (window.electronAPI?.getSetting) {
            window.electronAPI.getSetting('mirrorCameras').then(savedValue => {
                const mirrorEnabled = savedValue !== false; // Default to true
                settingsMirrorCameras.checked = mirrorEnabled;
                window._mirrorCameras = mirrorEnabled;
            });
        } else {
            window._mirrorCameras = true;
        }

        settingsMirrorCameras.addEventListener('change', async function () {
            const mirrorEnabled = this.checked;
            window._mirrorCameras = mirrorEnabled;
            if (window.electronAPI?.setSetting) {
                await window.electronAPI.setSetting('mirrorCameras', mirrorEnabled);
            }
            // Dispatch event so other components can update
            window.dispatchEvent(new CustomEvent('mirrorCamerasChanged', { detail: { enabled: mirrorEnabled } }));
            settingsMirrorCameras.blur();
        });
    }

    // Language selector
    const settingsLanguage = $('settingsLanguage');
    if (settingsLanguage) {
        // Load saved language
        const currentLang = getCurrentLanguage();
        settingsLanguage.value = currentLang;

        settingsLanguage.addEventListener('change', async function () {
            const newLang = this.value;
            await setLanguage(newLang);
            settingsLanguage.blur();
        });

        // Listen for language changes from other sources (e.g., welcome guide)
        onLanguageChange((newLang) => {
            if (settingsLanguage.value !== newLang) {
                settingsLanguage.value = newLang;
            }
        });
    }

    // Layout style toggle (Modern floating vs Classic sidebar)
    const settingsLayoutStyle = $('settingsLayoutStyle');
    if (settingsLayoutStyle) {
        // Initialize checkbox state from current layout
        const currentStyle = getLayoutStyle?.() || 'modern';
        settingsLayoutStyle.checked = currentStyle === 'classic';

        settingsLayoutStyle.onchange = () => {
            const newStyle = settingsLayoutStyle.checked ? 'classic' : 'modern';
            setLayoutStyle?.(newStyle);
            settingsLayoutStyle.blur();
        };
    }

    // Browse for default folder
    if (browseDefaultFolderBtn) {
        browseDefaultFolderBtn.onclick = async (e) => {
            e.preventDefault();
            if (window.electronAPI?.openFolder) {
                try {
                    const folderPath = await window.electronAPI.openFolder(defaultFolderPath?.value || '');
                    if (folderPath) {
                        if (window.electronAPI?.setSetting) {
                            await window.electronAPI.setSetting('defaultFolder', folderPath);
                        }
                        if (defaultFolderPath) defaultFolderPath.value = folderPath;
                        if (defaultFolderStatus) {
                            defaultFolderStatus.textContent = 'Default folder saved';
                            defaultFolderStatus.className = 'folder-status success';
                            setTimeout(() => {
                                defaultFolderStatus.textContent = '';
                                defaultFolderStatus.className = 'folder-status';
                            }, 3000);
                        }
                    }
                } catch (err) {
                    console.error('Failed to select folder:', err);
                    if (defaultFolderStatus) {
                        defaultFolderStatus.textContent = 'Failed to select folder';
                        defaultFolderStatus.className = 'folder-status error';
                    }
                }
            } else {
                if (defaultFolderStatus) {
                    defaultFolderStatus.textContent = 'Folder selection requires Electron';
                    defaultFolderStatus.className = 'folder-status error';
                }
            }
            browseDefaultFolderBtn.blur();
        };
    }

    // Clear default folder
    if (clearDefaultFolderBtn) {
        clearDefaultFolderBtn.onclick = async (e) => {
            e.preventDefault();
            if (window.electronAPI?.setSetting) {
                await window.electronAPI.setSetting('defaultFolder', null);
            }
            if (defaultFolderPath) defaultFolderPath.value = '';
            if (defaultFolderStatus) {
                defaultFolderStatus.textContent = 'Default folder cleared';
                defaultFolderStatus.className = 'folder-status';
                setTimeout(() => { defaultFolderStatus.textContent = ''; }, 2000);
            }
            clearDefaultFolderBtn.blur();
        };
    }

    // Browse for drive data JSON file
    if (browseDriveDataFileBtn) {
        browseDriveDataFileBtn.onclick = async (e) => {
            e.preventDefault();
            if (window.electronAPI?.openFile) {
                try {
                    const filePath = await window.electronAPI.openFile([
                        { name: 'Drive Data', extensions: ['json'] },
                        { name: 'All Files', extensions: ['*'] }
                    ]);
                    if (filePath) {
                        if (window.electronAPI?.setSetting) {
                            await window.electronAPI.setSetting('sentryUsbDataPath', filePath);
                        }
                        if (driveDataFilePath) driveDataFilePath.value = filePath;
                        if (driveDataFileStatus) {
                            driveDataFileStatus.textContent = 'Drive data file saved. Loading…';
                            driveDataFileStatus.className = 'folder-status success';
                        }
                        // Trigger load in the main app
                        if (window._loadSentryUsbData) {
                            window._loadSentryUsbData(filePath).then(result => {
                                if (driveDataFileStatus) {
                                    if (result.success) {
                                        driveDataFileStatus.textContent = `Loaded ${result.driveCount} drives from ${result.routeCount} routes`;
                                        driveDataFileStatus.className = 'folder-status success';
                                    } else {
                                        driveDataFileStatus.textContent = `Error: ${result.error}`;
                                        driveDataFileStatus.className = 'folder-status error';
                                    }
                                    setTimeout(() => {
                                        if (driveDataFileStatus) driveDataFileStatus.textContent = '';
                                        if (driveDataFileStatus) driveDataFileStatus.className = 'folder-status';
                                    }, 5000);
                                }
                            });
                        }
                    }
                } catch (err) {
                    console.error('Failed to select drive data file:', err);
                    if (driveDataFileStatus) {
                        driveDataFileStatus.textContent = 'Failed to select file';
                        driveDataFileStatus.className = 'folder-status error';
                    }
                }
            }
            browseDriveDataFileBtn.blur();
        };
    }

    // Clear drive data file
    if (clearDriveDataFileBtn) {
        clearDriveDataFileBtn.onclick = async (e) => {
            e.preventDefault();
            if (window.electronAPI?.setSetting) {
                await window.electronAPI.setSetting('sentryUsbDataPath', null);
            }
            if (driveDataFilePath) driveDataFilePath.value = '';
            if (driveDataFileStatus) {
                driveDataFileStatus.textContent = 'Drive data cleared';
                driveDataFileStatus.className = 'folder-status';
                setTimeout(() => { driveDataFileStatus.textContent = ''; }, 2000);
            }
            // Clear drive state in main app
            if (window._clearSentryUsbData) window._clearSentryUsbData();
            clearDriveDataFileBtn.blur();
        };
    }

    // Initialize keybind settings
    initKeybindSettings();

    // Initialize feature badges (for settings-modal badges like shortcuts NEW)
    initFeatureBadges();

    // Skip duration setting
    const settingsSkipDuration = $('settingsSkipDuration');
    const skipForwardLabel = $('skipForwardLabel');
    const skipBackwardLabel = $('skipBackwardLabel');
    const skipBackBtn = $('skipBackBtn');
    const skipForwardBtn = $('skipForwardBtn');

    function updateSkipLabels(duration) {
        // Update settings modal labels
        if (skipForwardLabel) skipForwardLabel.textContent = `${t('ui.settings.skipForward')} ${duration}s`;
        if (skipBackwardLabel) skipBackwardLabel.textContent = `${t('ui.settings.skipBackward')} ${duration}s`;
        // Update playback bar button labels and titles
        if (skipBackBtn) {
            const backLabel = skipBackBtn.querySelector('.skip-label');
            if (backLabel) backLabel.textContent = duration;
            skipBackBtn.title = `${t('ui.settings.skipBackward')} ${duration} ${t('ui.settings.seconds')}`;
        }
        if (skipForwardBtn) {
            const fwdLabel = skipForwardBtn.querySelector('.skip-label');
            if (fwdLabel) fwdLabel.textContent = duration;
            skipForwardBtn.title = `${t('ui.settings.skipForward')} ${duration} ${t('ui.settings.seconds')}`;
        }
    }

    if (settingsSkipDuration) {
        // Load saved skip duration
        if (window.electronAPI?.getSetting) {
            window.electronAPI.getSetting('skipDuration').then(savedValue => {
                const duration = savedValue || 15;
                settingsSkipDuration.value = duration;
                updateSkipLabels(duration);
                window._skipDuration = duration;
            });
        } else {
            window._skipDuration = 15;
            updateSkipLabels(15);
        }

        settingsSkipDuration.addEventListener('change', async function () {
            const duration = parseInt(this.value, 10);
            window._skipDuration = duration;
            updateSkipLabels(duration);
            if (window.electronAPI?.setSetting) {
                await window.electronAPI.setSetting('skipDuration', duration);
            }
        });
    }

    // Support Chat button (in control bar)
    const supportChatBtn = $('supportChatBtn');
    if (supportChatBtn) {
        supportChatBtn.onclick = async () => {
            try {
                const { toggleSupportChat, initSupportChat } = await import('./supportChat.js');
                initSupportChat();
                toggleSupportChat();
            } catch (err) {
                console.error('Failed to open support chat:', err);
            }
            supportChatBtn.blur();
        };
    }

    // Support Chat button (in settings modal)
    const openSupportChatFromSettings = $('openSupportChatFromSettings');
    if (openSupportChatFromSettings) {
        openSupportChatFromSettings.onclick = async () => {
            try {
                // Close settings modal
                const settingsModal = $('settingsModal');
                if (settingsModal) settingsModal.classList.add('hidden');

                // Open support chat
                const { showSupportChat, initSupportChat } = await import('./supportChat.js');
                initSupportChat();
                showSupportChat();
            } catch (err) {
                console.error('Failed to open support chat from settings:', err);
            }
            openSupportChatFromSettings.blur();
        };
    }

    // Privacy Policy & Terms of Service links
    const openPrivacyPolicy = $('openPrivacyPolicy');
    if (openPrivacyPolicy) {
        openPrivacyPolicy.onclick = (e) => {
            e.preventDefault();
            if (window.electronAPI?.openExternal) {
                window.electronAPI.openExternal('https://sentry-six.com/privacy');
            }
        };
    }
    const openTermsOfService = $('openTermsOfService');
    if (openTermsOfService) {
        openTermsOfService.onclick = (e) => {
            e.preventDefault();
            if (window.electronAPI?.openExternal) {
                window.electronAPI.openExternal('https://sentry-six.com/terms');
            }
        };
    }

    // Initialize support chat on startup (for message polling)
    (async () => {
        try {
            const { checkForActiveTicket } = await import('./supportChat.js');
            await checkForActiveTicket();
        } catch (err) {
            console.error('Failed to initialize support chat:', err);
        }
    })();

    // Advanced settings toggle
    const advancedSettingsToggle = $('advancedSettingsToggle');
    const advancedSettingsSection = $('advancedSettingsSection');

    if (advancedSettingsToggle && advancedSettingsSection) {
        advancedSettingsToggle.onclick = (e) => {
            e.preventDefault();
            advancedSettingsSection.classList.toggle('hidden');
            advancedSettingsToggle.classList.toggle('expanded', !advancedSettingsSection.classList.contains('hidden'));
            advancedSettingsToggle.blur();
        };
    }

    // Check for updates button
    const checkForUpdatesBtn = $('checkForUpdatesBtn');
    if (checkForUpdatesBtn) {
        checkForUpdatesBtn.onclick = async () => {
            if (window.electronAPI?.checkForUpdates) {
                checkForUpdatesBtn.disabled = true;
                checkForUpdatesBtn.textContent = t('ui.settings.checking');
                try {
                    const result = await window.electronAPI.checkForUpdates();
                    if (result?.updateAvailable) {
                        // Update modal will be shown by the update:available event
                        checkForUpdatesBtn.textContent = t('ui.settings.updateFound');
                        checkForUpdatesBtn.style.background = 'rgba(76, 175, 80, 0.3)';
                    } else if (result?.error) {
                        checkForUpdatesBtn.textContent = t('ui.settings.checkFailed');
                        checkForUpdatesBtn.style.background = 'rgba(244, 67, 54, 0.3)';
                    } else {
                        checkForUpdatesBtn.textContent = t('ui.settings.upToDate') + ' ✓';
                        checkForUpdatesBtn.style.background = 'rgba(76, 175, 80, 0.3)';
                    }
                    // Reset button after 3 seconds
                    setTimeout(() => {
                        checkForUpdatesBtn.textContent = t('ui.settings.checkNow');
                        checkForUpdatesBtn.style.background = '';
                        checkForUpdatesBtn.disabled = false;
                    }, 3000);
                } catch (err) {
                    checkForUpdatesBtn.textContent = t('ui.settings.checkFailed');
                    checkForUpdatesBtn.style.background = 'rgba(244, 67, 54, 0.3)';
                    setTimeout(() => {
                        checkForUpdatesBtn.textContent = t('ui.settings.checkNow');
                        checkForUpdatesBtn.style.background = '';
                        checkForUpdatesBtn.disabled = false;
                    }, 3000);
                }
            }
            checkForUpdatesBtn.blur();
        };
    }

    // Sentry camera highlight toggle
    const settingsSentryCameraHighlight = $('settingsSentryCameraHighlight');
    if (settingsSentryCameraHighlight) {
        if (window.electronAPI?.getSetting) {
            window.electronAPI.getSetting('sentryCameraHighlight').then(savedValue => {
                const enabled = savedValue !== false;
                settingsSentryCameraHighlight.checked = enabled;
                window._sentryCameraHighlightEnabled = enabled;
                updateEventCameraHighlight?.();
            });
        } else {
            window._sentryCameraHighlightEnabled = true;
        }

        settingsSentryCameraHighlight.addEventListener('change', async function () {
            window._sentryCameraHighlightEnabled = this.checked;
            if (window.electronAPI?.setSetting) {
                await window.electronAPI.setSetting('sentryCameraHighlight', this.checked);
            }
            updateEventCameraHighlight?.();
            settingsSentryCameraHighlight.blur();
        });
    }

    // Saved camera highlight toggle
    const settingsSavedCameraHighlight = $('settingsSavedCameraHighlight');
    if (settingsSavedCameraHighlight) {
        if (window.electronAPI?.getSetting) {
            window.electronAPI.getSetting('savedCameraHighlight').then(savedValue => {
                const enabled = savedValue !== false;
                settingsSavedCameraHighlight.checked = enabled;
                window._savedCameraHighlightEnabled = enabled;
                updateEventCameraHighlight?.();
            });
        } else {
            window._savedCameraHighlightEnabled = true;
        }

        settingsSavedCameraHighlight.addEventListener('change', async function () {
            window._savedCameraHighlightEnabled = this.checked;
            if (window.electronAPI?.setSetting) {
                await window.electronAPI.setSetting('savedCameraHighlight', this.checked);
            }
            updateEventCameraHighlight?.();
            settingsSavedCameraHighlight.blur();
        });
    }

    // Reset camera order button (use onclick to prevent duplicate listeners)
    const resetCameraOrderBtn = $('resetCameraOrderBtn');
    if (resetCameraOrderBtn) {
        resetCameraOrderBtn.onclick = (e) => {
            e.preventDefault();
            resetCameraOrder?.();
            resetCameraOrderBtn.blur();
        };
    }

    // Glass blur slider
    const settingsGlassBlur = $('settingsGlassBlur');
    const glassBlurValue = $('glassBlurValue');

    function applyGlassBlur(value) {
        document.documentElement.style.setProperty('--glass-blur', `${value}px`);
        if (glassBlurValue) glassBlurValue.textContent = `${value}px`;
        if (settingsGlassBlur) settingsGlassBlur.value = value;
    }

    if (window.electronAPI?.getSetting) {
        window.electronAPI.getSetting('glassBlur').then(savedValue => {
            applyGlassBlur(savedValue !== undefined ? savedValue : 7);
        });
    }

    if (settingsGlassBlur) {
        settingsGlassBlur.addEventListener('input', function () {
            applyGlassBlur(parseInt(this.value, 10));
        });

        settingsGlassBlur.addEventListener('change', async function () {
            if (window.electronAPI?.setSetting) {
                await window.electronAPI.setSetting('glassBlur', parseInt(this.value, 10));
            }
            settingsGlassBlur.blur();
        });
    }

    // Include Dashboard toggle in export modal - show/hide options
    const includeDashboard = document.getElementById('includeDashboard');
    const dashboardOptions = document.getElementById('dashboardOptions');
    if (includeDashboard && dashboardOptions) {
        includeDashboard.addEventListener('change', () => {
            dashboardOptions.classList.toggle('hidden', !includeDashboard.checked);
        });
    }

    // Hidden Developer Settings trigger - click Settings title 5 times
    const settingsModalHeader = settingsModal?.querySelector('.modal-header h2');
    let settingsTitleClickCount = 0;
    let settingsTitleClickTimer = null;

    if (settingsModalHeader) {
        settingsModalHeader.style.cursor = 'default';
        settingsModalHeader.addEventListener('click', (e) => {
            e.stopPropagation();
            settingsTitleClickCount++;

            clearTimeout(settingsTitleClickTimer);
            settingsTitleClickTimer = setTimeout(() => { settingsTitleClickCount = 0; }, 10000);

            if (settingsTitleClickCount >= 5) {
                settingsTitleClickCount = 0;
                closeSettings();
                openDevSettingsModal?.();
            }
        });
    }
}

/**
 * Initialize Developer Settings Modal
 */
export function initDevSettingsModal() {
    const devSettingsModal = $('devSettingsModal');
    const closeDevSettingsModal_btn = $('closeDevSettingsModal');
    const closeDevSettingsBtn = $('closeDevSettingsBtn');

    function closeDevSettings() {
        if (devSettingsModal) devSettingsModal.classList.add('hidden');
        const devOutput = $('devOutput');
        if (devOutput) devOutput.classList.add('hidden');
    }

    function showDevOutput(text) {
        const devOutput = $('devOutput');
        const devOutputText = $('devOutputText');
        if (devOutput && devOutputText) {
            devOutputText.textContent = text;
            devOutput.classList.remove('hidden');
        }
    }

    if (closeDevSettingsModal_btn) closeDevSettingsModal_btn.onclick = closeDevSettings;
    if (closeDevSettingsBtn) closeDevSettingsBtn.onclick = closeDevSettings;

    if (devSettingsModal) {
        devSettingsModal.onclick = (e) => {
            if (e.target === devSettingsModal) closeDevSettings();
        };
    }

    // Open DevTools
    const devOpenConsole = $('devOpenConsole');
    if (devOpenConsole) {
        devOpenConsole.onclick = async () => {
            if (window.electronAPI?.devOpenDevTools) {
                const result = await window.electronAPI.devOpenDevTools();
                showDevOutput(result.success ? 'DevTools opened successfully' : 'Error: ' + result.error);
            }
            devOpenConsole.blur();
        };
    }

    // Reset Settings
    const devResetSettings = $('devResetSettings');
    if (devResetSettings) {
        devResetSettings.onclick = async () => {
            if (window.electronAPI?.devResetSettings) {
                if (confirm('Are you sure you want to reset all settings? This will reload the app.')) {
                    const result = await window.electronAPI.devResetSettings();
                    if (result.success) {
                        // Clear localStorage too for a true factory reset
                        localStorage.clear();
                        showDevOutput('Settings reset successfully.\nDeleted: ' + result.path + '\n\nReloading app...');
                        setTimeout(() => { window.electronAPI?.devReloadApp?.(); }, 1500);
                    } else {
                        showDevOutput('Error: ' + result.error);
                    }
                }
            }
            devResetSettings.blur();
        };
    }

    // Show App Paths
    const devShowPaths = $('devShowPaths');
    if (devShowPaths) {
        devShowPaths.onclick = async () => {
            if (window.electronAPI?.devGetAppPaths) {
                const paths = await window.electronAPI.devGetAppPaths();
                showDevOutput(
                    'Application Paths:\n─────────────────────────────────\n' +
                    'User Data:  ' + paths.userData + '\n' +
                    'Settings:   ' + paths.settings + '\n' +
                    'Version:    ' + paths.version + '\n' +
                    'App:        ' + paths.app + '\n' +
                    'Temp:       ' + paths.temp
                );
            }
            devShowPaths.blur();
        };
    }

    // Fake No GPU Toggle
    const devFakeNoGpu = $('devFakeNoGpu');
    if (devFakeNoGpu) {
        // Load current setting
        window.electronAPI?.getSetting?.('devFakeNoGpu').then(value => {
            devFakeNoGpu.checked = value === true;
        });

        devFakeNoGpu.onchange = async () => {
            const value = devFakeNoGpu.checked;
            await window.electronAPI?.setSetting?.('devFakeNoGpu', value);
            showDevOutput(value
                ? 'Fake No GPU: ENABLED\n\nFFmpeg will report no GPU encoder.\nRe-open Export panel to see the effect.'
                : 'Fake No GPU: DISABLED\n\nGPU encoder detection restored.\nRe-open Export panel to see the effect.');
            devFakeNoGpu.blur();
        };
    }

    // Disable API Requests Toggle
    const devDisableApiRequests = $('devDisableApiRequests');
    if (devDisableApiRequests) {
        // Load current setting
        window.electronAPI?.getSetting?.('devDisableApiRequests').then(value => {
            devDisableApiRequests.checked = value === true;
        });

        devDisableApiRequests.onchange = async () => {
            const value = devDisableApiRequests.checked;
            await window.electronAPI?.setSetting?.('devDisableApiRequests', value);
            showDevOutput(value
                ? 'API Requests: DISABLED\n\nNo update checks or API calls will be made.\nRestart app for full effect.'
                : 'API Requests: ENABLED\n\nUpdate checks and API calls restored.\nRestart app for full effect.');
            devDisableApiRequests.blur();
        };
    }

    // Reset Welcome Guide
    const devResetWelcomeGuide = $('devResetWelcomeGuide');
    if (devResetWelcomeGuide) {
        devResetWelcomeGuide.onclick = async () => {
            if (window._resetWelcomeGuide) {
                await window._resetWelcomeGuide();
                showDevOutput('Welcome Guide Reset\n\nThe welcome guide will appear on next app launch.\nOr click "Show Welcome Guide" to see it now.');
            } else {
                showDevOutput('Error: Welcome guide module not loaded');
            }
            devResetWelcomeGuide.blur();
        };
    }

    // Show Welcome Guide Now
    const devShowWelcomeGuide = $('devShowWelcomeGuide');
    if (devShowWelcomeGuide) {
        devShowWelcomeGuide.onclick = () => {
            if (window._openWelcomeGuide) {
                closeDevSettings();
                window._openWelcomeGuide();
            } else {
                showDevOutput('Error: Welcome guide module not loaded');
            }
            devShowWelcomeGuide.blur();
        };
    }

    // Reset Privacy & Terms
    const devResetWelcomeScreen = $('devResetWelcomeScreen');
    if (devResetWelcomeScreen) {
        devResetWelcomeScreen.onclick = async () => {
            if (window._resetWelcomeScreen) {
                await window._resetWelcomeScreen();
                showDevOutput('Privacy & Terms Reset\n\nThe Privacy & Terms dialog will appear on next app launch.\nOr click "Show Privacy & Terms" to see it now.');
            } else {
                showDevOutput('Error: Welcome screen module not loaded');
            }
            devResetWelcomeScreen.blur();
        };
    }

    // Show Privacy & Terms Now
    const devShowWelcomeScreen = $('devShowWelcomeScreen');
    if (devShowWelcomeScreen) {
        devShowWelcomeScreen.onclick = () => {
            if (window._showWelcomeScreen) {
                closeDevSettings();
                window._showWelcomeScreen();
            } else {
                showDevOutput('Error: Welcome screen module not loaded');
            }
            devShowWelcomeScreen.blur();
        };
    }

    // Reset NEW Badges (show all)
    const devResetBadges = $('devResetBadges');
    // Derive the unique set of badge setting keys from FEATURE_BADGE_KEYS so the
    // dev toggles always cover every registered badge. Adding a new badge in
    // exportVideo.js automatically extends both toggles below — no second list
    // to keep in sync.
    const getAllBadgeSettingKeys = () => [...new Set(Object.values(FEATURE_BADGE_KEYS))];

    if (devResetBadges) {
        devResetBadges.onclick = async () => {
            for (const key of getAllBadgeSettingKeys()) {
                await window.electronAPI?.setSetting?.(key, false);
            }
            // Show badges immediately
            document.querySelectorAll('.feature-new-badge, .share-new-badge, .style-new-dot').forEach(el => el.classList.remove('hidden'));
            showDevOutput('NEW Badges Reset\n\nAll NEW badges will now appear again in the Export modal.');
            devResetBadges.blur();
        };
    }

    // Dismiss All Badges (hide all)
    const devDismissBadges = $('devDismissBadges');
    if (devDismissBadges) {
        devDismissBadges.onclick = async () => {
            for (const key of getAllBadgeSettingKeys()) {
                await window.electronAPI?.setSetting?.(key, true);
            }
            // Hide badges immediately
            document.querySelectorAll('.feature-new-badge, .share-new-badge, .style-new-dot').forEach(el => el.classList.add('hidden'));
            showDevOutput('All Badges Dismissed\n\nAll NEW badges have been hidden.');
            devDismissBadges.blur();
        };
    }

    // Pre-release testing: explicitly bypass the update API and pull the
    // latest GitHub pre-release. Two-step flow (check -> install) so the
    // user sees the version + notes before committing to the download.
    // The "install" button stays disabled until a check has succeeded.
    const devCheckPrerelease = $('devCheckPrerelease');
    const devInstallPrerelease = $('devInstallPrerelease');
    const devPrereleaseTag = $('devPrereleaseTag');
    let pendingPrereleaseTag = null;

    if (devCheckPrerelease) {
        devCheckPrerelease.onclick = async () => {
            showDevOutput('Checking GitHub for latest pre-release...');
            devCheckPrerelease.disabled = true;
            try {
                const res = await window.electronAPI?.devCheckPrerelease?.();
                if (!res || !res.found) {
                    showDevOutput(`No pre-release found.\n${res?.error || ''}`);
                    if (devInstallPrerelease) {
                        devInstallPrerelease.disabled = true;
                        devInstallPrerelease.style.opacity = '0.4';
                    }
                    if (devPrereleaseTag) devPrereleaseTag.textContent = 'No pre-release checked';
                    pendingPrereleaseTag = null;
                    return;
                }
                pendingPrereleaseTag = res.tag;
                if (devPrereleaseTag) devPrereleaseTag.textContent = `Ready: ${res.tag}`;
                if (devInstallPrerelease) {
                    devInstallPrerelease.disabled = false;
                    devInstallPrerelease.style.opacity = '1';
                }
                const published = res.publishedAt ? new Date(res.publishedAt).toLocaleString() : 'unknown';
                showDevOutput(
                    `Latest pre-release\n` +
                    `────────────────\n` +
                    `Tag:       ${res.tag}\n` +
                    `Title:     ${res.name || '(none)'}\n` +
                    `Published: ${published}\n\n` +
                    `${res.body || '(no release notes)'}`
                );
            } finally {
                devCheckPrerelease.disabled = false;
                devCheckPrerelease.blur();
            }
        };
    }

    if (devInstallPrerelease) {
        devInstallPrerelease.onclick = async () => {
            if (!pendingPrereleaseTag) return;
            const ok = confirm(
                `Install pre-release ${pendingPrereleaseTag}?\n\n` +
                `This bypasses the update API and may break your installation. ` +
                `The app will restart when the download completes. Continue?`
            );
            if (!ok) return;
            showDevOutput(`Downloading ${pendingPrereleaseTag}... the app will restart when complete.`);
            const res = await window.electronAPI?.devInstallPrerelease?.(pendingPrereleaseTag);
            if (!res?.success) {
                showDevOutput(`Install failed: ${res?.error || 'unknown error'}`);
            }
            devInstallPrerelease.blur();
        };
    }

}

/**
 * Open the developer settings modal
 */
export function openDevSettings() {
    const devSettingsModal = $('devSettingsModal');
    if (devSettingsModal) {
        devSettingsModal.classList.remove('hidden');
    }
}

/**
 * Initialize changelog modal and settings version display
 */
export function initChangelogModal() {
    const changelogModal = $('changelogModal');
    const closeChangelogModal = $('closeChangelogModal');
    const closeChangelogBtn = $('closeChangelogBtn');
    const viewChangelogBtn = $('viewChangelogBtn');
    const settingsCurrentVersion = $('settingsCurrentVersion');

    // Load and display current version in settings
    if (settingsCurrentVersion && window.electronAPI?.devGetCurrentVersion) {
        window.electronAPI.devGetCurrentVersion().then(versionInfo => {
            settingsCurrentVersion.textContent = 'v' + (versionInfo.version || 'unknown');
        });
    }

    function closeChangelog() {
        if (changelogModal) changelogModal.classList.add('hidden');
    }

    if (closeChangelogModal) closeChangelogModal.onclick = () => { closeChangelog(); closeChangelogModal.blur(); };
    if (closeChangelogBtn) closeChangelogBtn.onclick = () => { closeChangelog(); closeChangelogBtn.blur(); };

    if (changelogModal) {
        changelogModal.onclick = (e) => {
            if (e.target === changelogModal) closeChangelog();
        };
    }

    // View Changelog button
    if (viewChangelogBtn) {
        viewChangelogBtn.onclick = async () => {
            if (changelogModal) {
                changelogModal.classList.remove('hidden');

                const fullChangelogContent = $('fullChangelogContent');
                if (fullChangelogContent) {
                    fullChangelogContent.innerHTML = '<div class="changelog-loading">Loading changelog...</div>';

                    // Load changelog
                    if (window.electronAPI?.getChangelog) {
                        const changelog = await window.electronAPI.getChangelog();
                        fullChangelogContent.innerHTML = renderFullChangelog(changelog.versions || []);
                    } else {
                        fullChangelogContent.innerHTML = '<div class="changelog-loading">Unable to load changelog</div>';
                    }
                }
            }
            viewChangelogBtn.blur();
        };
    }
}

/**
 * Render full changelog (all versions)
 */
function renderFullChangelog(versions) {
    if (!versions || versions.length === 0) {
        return '<div class="changelog-loading">No changelog available</div>';
    }

    const typeIcons = {
        feature: '✦',
        improvement: '↑',
        fix: '✓'
    };

    const formatDate = (dateStr) => {
        try {
            const date = new Date(dateStr);
            return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        } catch {
            return dateStr;
        }
    };

    return versions.map(entry => `
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
 * Initialize settings search functionality
 */
export function initSettingsSearch() {
    const searchInput = $('settingsSearchInput');
    const clearBtn = $('settingsSearchClear');
    const noResults = $('settingsNoResults');
    const settingsModal = $('settingsModal');
    if (!searchInput || !settingsModal) return;

    const accordions = settingsModal.querySelectorAll('.settings-accordion');
    const navItems = settingsModal.querySelectorAll('.settings-nav-item');
    let isSearching = false;

    function getActiveSection() {
        const active = settingsModal.querySelector('.settings-nav-item.active');
        return active?.dataset?.target || 'display';
    }

    function restoreSidebarState() {
        const activeSection = getActiveSection();
        accordions.forEach(acc => {
            acc.classList.remove('search-hidden', 'search-match');
            acc.querySelectorAll('.toggle-row, .select-row, .slider-row, .action-row, .keybind-row-compact, .input-row').forEach(row => {
                row.classList.remove('search-hidden');
            });
            acc.classList.toggle('open', acc.dataset.section === activeSection);
        });
        navItems.forEach(n => n.classList.remove('search-highlight'));
    }

    function performSearch(query) {
        const q = query.trim().toLowerCase();
        clearBtn?.classList.toggle('hidden', q.length === 0);

        if (!q) {
            isSearching = false;
            restoreSidebarState();
            if (noResults) noResults.classList.add('hidden');
            return;
        }

        isSearching = true;
        let anyVisible = false;

        accordions.forEach(acc => {
            const title = acc.querySelector('.settings-accordion-title')?.textContent?.toLowerCase() || '';
            const sectionMatch = title.includes(q);

            // Check individual rows
            const rows = acc.querySelectorAll('.toggle-row, .select-row, .slider-row, .action-row, .keybind-row-compact, .input-row');
            let rowMatch = false;
            rows.forEach(row => {
                const text = row.textContent.toLowerCase();
                if (text.includes(q) || sectionMatch) {
                    row.classList.remove('search-hidden');
                    rowMatch = true;
                } else {
                    row.classList.add('search-hidden');
                }
            });

            if (sectionMatch || rowMatch) {
                acc.classList.remove('search-hidden');
                acc.classList.add('open', 'search-match');
                anyVisible = true;
            } else {
                acc.classList.add('search-hidden');
                acc.classList.remove('open', 'search-match');
            }
        });

        // Highlight matching nav items
        navItems.forEach(nav => {
            const target = nav.dataset.target;
            const matchingAcc = settingsModal.querySelector(`.settings-accordion[data-section="${target}"]`);
            nav.classList.toggle('search-highlight', matchingAcc?.classList.contains('search-match') || false);
        });

        if (noResults) noResults.classList.toggle('hidden', anyVisible);
    }

    searchInput.addEventListener('input', () => performSearch(searchInput.value));

    clearBtn?.addEventListener('click', () => {
        searchInput.value = '';
        performSearch('');
        searchInput.focus();
    });

    // Clear search when modal is closed
    const closeBtn = $('closeSettingsModal');
    const doneBtn = $('closeSettingsBtn');
    const resetSearch = () => { searchInput.value = ''; performSearch(''); };
    closeBtn?.addEventListener('click', resetSearch);
    doneBtn?.addEventListener('click', resetSearch);
}

// Populate OS & Architecture on load (always visible)
(async function populateSystemInfo() {
    if (window.electronAPI?.getSystemInfo) {
        try {
            const info = await window.electronAPI.getSystemInfo();
            const osEl = document.getElementById('securityDetailOS');
            const archEl = document.getElementById('securityDetailArch');
            if (osEl) osEl.textContent = info.os || '---';
            if (archEl) archEl.textContent = info.arch || '---';
        } catch (err) {
            console.log('[SETTINGS] Could not load system info:', err);
        }
    }
})();

// System & Security "Learn More" toggle — registered at module scope for reliability
document.addEventListener('click', (e) => {
    const link = e.target.closest('#securityLearnMoreLink');
    if (!link) return;
    e.preventDefault();
    e.stopPropagation();
    const details = document.getElementById('securityLearnMoreDetails');
    if (!details) return;
    const isHidden = details.classList.contains('hidden');
    details.classList.toggle('hidden');
    link.textContent = isHidden ? (t('ui.settings.hideDetails') || 'Hide Details') : (t('ui.settings.learnMore') || 'Learn More');
});
