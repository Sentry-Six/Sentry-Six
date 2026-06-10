/**
 * Diagnostics & Support ID System
 * Collects logs, system info, and uploads to get short shareable Support IDs
 */


// In-memory log storage. Capped as ring buffers: console output is captured
// for the whole session and playback is chatty (~10 lines per segment
// transition), so unbounded arrays of stringified entries grow renderer
// memory monotonically during long review sessions.
const MAX_LOG_ENTRIES = 5000;
const MAX_ERROR_ENTRIES = 2000;
const MAX_EVENT_ENTRIES = 2000;
const logBuffer = {
    console: [],
    errors: [],
    events: []
};

/** Push an entry, dropping the oldest once the cap is reached. */
function pushCapped(arr, entry, cap) {
    arr.push(entry);
    if (arr.length > cap) {
        // Trim in chunks so we don't shift() on every push at the cap
        arr.splice(0, arr.length - cap);
    }
}

// Original console methods (preserved for passthrough)
const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console)
};

/**
 * Initialize console interceptor to capture logs
 */
export function initDiagnostics() {
    // Intercept console.log
    console.log = (...args) => {
        captureLog('log', args);
        originalConsole.log(...args);
    };

    // Intercept console.warn
    console.warn = (...args) => {
        captureLog('warn', args);
        originalConsole.warn(...args);
    };

    // Intercept console.error
    console.error = (...args) => {
        captureLog('error', args);
        captureError(args);
        originalConsole.error(...args);
    };

    // Intercept console.info
    console.info = (...args) => {
        captureLog('info', args);
        originalConsole.info(...args);
    };

    // Capture uncaught errors
    window.addEventListener('error', (event) => {
        captureError([`Uncaught: ${event.message}`, `at ${event.filename}:${event.lineno}:${event.colno}`]);
    });

    // Capture unhandled promise rejections
    window.addEventListener('unhandledrejection', (event) => {
        captureError([`Unhandled Promise Rejection: ${event.reason}`]);
    });

    originalConsole.log('[Diagnostics] Console capture initialized');
}

/**
 * Capture a log entry
 */
function captureLog(level, args) {
    const entry = {
        t: Date.now(),
        l: level,
        m: args.map(arg => {
            try {
                if (arg instanceof Error) {
                    return `${arg.name}: ${arg.message}\n${arg.stack || ''}`;
                }
                if (typeof arg === 'object') {
                    return JSON.stringify(arg, null, 0);
                }
                return String(arg);
            } catch {
                return '[Unserializable]';
            }
        }).join(' ')
    };

    pushCapped(logBuffer.console, entry, MAX_LOG_ENTRIES);
}

/**
 * Capture an error entry
 */
function captureError(args) {
    const entry = {
        t: Date.now(),
        m: args.map(arg => {
            try {
                if (arg instanceof Error) {
                    return `${arg.name}: ${arg.message}\n${arg.stack || ''}`;
                }
                if (typeof arg === 'object') {
                    return JSON.stringify(arg, null, 0);
                }
                return String(arg);
            } catch {
                return '[Unserializable]';
            }
        }).join(' ')
    };

    pushCapped(logBuffer.errors, entry, MAX_ERROR_ENTRIES);
}

/**
 * Log a diagnostic event (for specific tracking)
 */
export function logDiagnosticEvent(eventName, data = {}) {
    pushCapped(logBuffer.events, {
        t: Date.now(),
        e: eventName,
        d: data
    }, MAX_EVENT_ENTRIES);
}

/**
 * Redact sensitive information from strings for privacy
 * - Usernames in file paths
 * - GPS coordinates and addresses from event.json location logs
 * @param {string} str - Original string (path or log message)
 * @returns {string} String with sensitive info redacted
 */
function redactSensitiveInfo(str) {
    if (!str) return null;
    
    let result = str;
    
    // Redact usernames in file paths (handles both regular and JSON-escaped paths)
    // Windows: C:\Users\USERNAME\... -> C:\Users\[REDACTED]\...
    // Windows JSON: C:\\Users\\USERNAME\\... -> C:\\Users\\[REDACTED]\\...
    // macOS: /Users/USERNAME/... -> /Users/[REDACTED]/...
    // Linux: /home/USERNAME/... -> /home/[REDACTED]/...
    result = result
        // Windows paths with escaped backslashes (JSON): C:\\Users\\USERNAME\\
        .replace(/([A-Za-z]:\\\\Users\\\\)([^\\"\s]+)/g, '$1[REDACTED]')
        // Windows paths with single backslashes: C:\Users\USERNAME\
        .replace(/([A-Za-z]:\\Users\\)([^\\\s"']+)/g, '$1[REDACTED]')
        // macOS paths
        .replace(/(\/Users\/)([^\/\s"']+)/g, '$1[REDACTED]')
        // Linux paths
        .replace(/(\/home\/)([^\/\s"']+)/g, '$1[REDACTED]');
    
    // Redact GPS coordinates and addresses from event.json location logs
    // Pattern: "Showing event.json location: LAT LONG ADDRESS" -> "Showing event.json location: [LOCATION REDACTED]"
    result = result.replace(
        /((?:showing|event\.json|location)[:\s]+)(-?\d+\.\d+\s+-?\d+\.\d+.*?)$/gi,
        '$1[LOCATION REDACTED]'
    );
    
    // Also catch standalone GPS coordinates (lat/long pairs)
    // Pattern: two decimal numbers that look like coordinates
    result = result.replace(
        /(location[:\s]+)(-?\d{1,3}\.\d{3,}\s+-?\d{1,3}\.\d{3,})/gi,
        '$1[COORDS REDACTED]'
    );
    
    return result;
}

/**
 * Redact usernames from all log entries
 * @param {Array} logs - Array of log entries
 * @returns {Array} Logs with usernames redacted
 */
/**
 * Redact sensitive info from all log entries
 * @param {Array} logs - Array of log entries
 * @returns {Array} Logs with sensitive info redacted
 */
function redactLogs(logs) {
    if (!Array.isArray(logs)) return logs;
    return logs.map(log => ({
        ...log,
        m: redactSensitiveInfo(log.m) || log.m
    }));
}

/**
 * Collect all diagnostic data (minimal, privacy-focused)
 */
export async function collectDiagnostics() {
    const diagnostics = {
        v: 2, // Schema version - updated for minimal data
        ts: Date.now(),
        os: null,
        appVersion: null,
        pendingUpdate: false,
        settings: {},
        hardware: {},
        logs: {
            console: redactLogs(logBuffer.console.slice()), // All DevTools console logs (redacted)
            errors: redactLogs(logBuffer.errors.slice())    // All errors (redacted)
        },
        terminalLogs: [] // Main process logs
    };

    // Get app info from main process
    try {
        if (window.electronAPI?.getDiagnostics) {
            const mainData = await window.electronAPI.getDiagnostics();
            diagnostics.os = mainData.os || null;
            diagnostics.appVersion = mainData.appVersion || null;
            diagnostics.pendingUpdate = mainData.pendingUpdate || false;
            diagnostics.hardware = mainData.hardware || {};
            diagnostics.terminalLogs = redactLogs(mainData.logs || []);
        }
    } catch (e) {
        diagnostics.error = e.message;
    }

    // Get saved settings (only the specified ones)
    try {
        if (window.electronAPI?.getSetting) {
            // Core settings
            diagnostics.settings.useMetric = await window.electronAPI.getSetting('useMetric') || false;
            diagnostics.settings.glassBlur = await window.electronAPI.getSetting('glassBlur') ?? 7;
            diagnostics.settings.disableAutoUpdate = await window.electronAPI.getSetting('disableAutoUpdate') || false;
            
            // UI toggles - get from state or settings
            diagnostics.settings.classicSidebar = await window.electronAPI.getSetting('layoutStyle') === 'classic';
            
            // Default folder (redacted for privacy)
            const defaultFolder = await window.electronAPI.getSetting('defaultFolder');
            diagnostics.settings.defaultFolder = redactSensitiveInfo(defaultFolder);
            
            // Keybinds - only show which actions have shortcuts set (not the actual keys for privacy)
            const keybinds = await window.electronAPI.getSetting('keybinds');
            if (keybinds && typeof keybinds === 'object') {
                diagnostics.settings.shortcutsConfigured = Object.keys(keybinds);
            } else {
                diagnostics.settings.shortcutsConfigured = [];
            }
        }
    } catch (e) {
        diagnostics.settings.error = e.message;
    }
    
    // Get GPS/Dashboard toggle status from current UI state
    try {
        const dashboardToggle = document.getElementById('dashboardToggle');
        const mapToggle = document.getElementById('mapToggle');
        diagnostics.settings.dashboardEnabled = dashboardToggle?.checked ?? null;
        diagnostics.settings.gpsEnabled = mapToggle?.checked ?? null;
    } catch { /* ignore */ }

    return diagnostics;
}
