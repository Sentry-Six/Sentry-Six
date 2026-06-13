/**
 * Update Telemetry Module
 * Handles UID generation and API communication for update checks
 * Implements killswitch logic for force_manual updates
 */

const crypto = require('crypto');
const https = require('https');
const { app } = require('electron');
const os = require('os');

// Try to load node-machine-id at module level for proper bundling
let machineIdModule = null;
try {
  machineIdModule = require('node-machine-id');
} catch (err) {
  console.warn('[TELEMETRY] node-machine-id not available:', err.message);
}

// Configuration
const TELEMETRY_CONFIG = {
  apiHost: 'api.sentry-six.com',
  apiPath: '/update-check',
  salt: 'SENTRY_SIX_2026_PROD_SECRET',
  timeoutMs: 10000
};

// Cached UID (generated once per session)
let cachedUid = null;

/**
 * Get the machine ID using node-machine-id
 * Falls back to a generated ID if the library fails
 * @returns {string} Machine ID
 */
function getMachineId() {
  if (machineIdModule) {
    try {
      return machineIdModule.machineIdSync();
    } catch (err) {
      console.warn('[TELEMETRY] machineIdSync() failed, using fallback:', err.message);
    }
  }
  // Fallback: generate a pseudo-ID from hostname + platform + arch
  const fallbackData = `${os.hostname()}-${os.platform()}-${os.arch()}-${os.cpus()[0]?.model || 'unknown'}`;
  return crypto.createHash('md5').update(fallbackData).digest('hex');
}

/**
 * Generate an anonymized UID using SHA-256 hash of machine ID + salt
 * @returns {string} Anonymized UID (64-char hex string)
 */
function getUid() {
  if (cachedUid) {
    return cachedUid;
  }
  
  const rawId = getMachineId();
  cachedUid = crypto.createHash('sha256')
    .update(rawId + TELEMETRY_CONFIG.salt)
    .digest('hex');
  
  console.log('[TELEMETRY] UID generated');
  return cachedUid;
}

/**
 * Get the current platform identifier
 * @returns {string} Platform name (windows, darwin, linux)
 */
function getPlatform() {
  const platform = os.platform();
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return platform;
}

/**
 * Get the current architecture
 * @returns {string} Architecture (x64, arm64, etc.)
 */
function getArch() {
  return os.arch();
}

/**
 * Make an HTTPS POST request
 * @param {string} host - API host
 * @param {string} path - API path
 * @param {Object} data - Request payload
 * @param {number} timeoutMs - Request timeout in milliseconds
 * @returns {Promise<Object>} Response data
 */
function httpsPost(host, path, data, timeoutMs) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(data);
    
    const options = {
      hostname: host,
      port: 443,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': `Sentry-Studio/${app.getVersion()}`
      },
      timeout: timeoutMs,
      family: 0
    };
    
    const req = https.request(options, (res) => {
      let responseData = '';
      
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      
      res.on('end', () => {
        try {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            const parsed = JSON.parse(responseData);
            resolve(parsed);
          } else {
            reject(new Error(`API returned status ${res.statusCode}: ${responseData}`));
          }
        } catch (parseErr) {
          reject(new Error(`Failed to parse API response: ${parseErr.message}`));
        }
      });
    });
    
    req.on('error', (err) => {
      reject(err);
    });
    
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('API request timed out'));
    });
    
    req.write(postData);
    req.end();
  });
}

/**
 * Check for updates via the telemetry API
 * This is the main entry point for update checks with killswitch support
 * 
 * @returns {Promise<Object>} API response with update info and killswitch status
 * Response format:
 * {
 *   update_available: boolean,
 *   new_version: string,
 *   force_manual: boolean,
 *   message: string,
 *   download_url: string,
 *   api_error: boolean (only if API failed)
 * }
 */
async function checkUpdateWithTelemetry() {
  const payload = {
    fingerprint: getUid(),
    current_version: `v${app.getVersion()}`,
    platform: getPlatform(),
    arch: getArch()
  };
  
  console.log('[TELEMETRY] Sending update check');
  
  try {
    const response = await httpsPost(
      TELEMETRY_CONFIG.apiHost,
      TELEMETRY_CONFIG.apiPath,
      payload,
      TELEMETRY_CONFIG.timeoutMs
    );
    
    console.log('[TELEMETRY] API response:', {
      update_available: response.update_available,
      new_version: response.new_version,
      force_manual: response.force_manual,
      has_message: !!response.message
    });
    
    return response;
  } catch (err) {
    console.error('[TELEMETRY] API request failed:', err.message);
    // Return a fallback response indicating API failure
    // The caller should fall back to direct GitHub check
    return {
      api_error: true,
      error_message: err.message,
      update_available: false,
      force_manual: false
    };
  }
}

/**
 * Process the API response and determine the appropriate action
 * @param {Object} apiResponse - Response from checkUpdateWithTelemetry
 * @returns {Object} Processed result with action type
 */
function processApiResponse(apiResponse) {
  // API failed - use fallback
  if (apiResponse.api_error) {
    return {
      action: 'fallback_to_github',
      reason: apiResponse.error_message
    };
  }
  
  // Force manual update (killswitch activated)
  if (apiResponse.force_manual === true) {
    return {
      action: 'force_manual',
      message: apiResponse.message || 'A critical update is required. Please download the latest version manually.',
      download_url: apiResponse.download_url || 'https://github.com/Sentry-Six/Sentry-Six/releases/latest',
      new_version: apiResponse.new_version
    };
  }
  
  // Update available with optional message
  if (apiResponse.update_available === true) {
    return {
      action: 'update_available',
      new_version: apiResponse.new_version,
      message: apiResponse.message || null,
      download_url: apiResponse.download_url
    };
  }
  
  // No update available
  return {
    action: 'up_to_date',
    message: apiResponse.message || null
  };
}

module.exports = {
  checkUpdateWithTelemetry,
  processApiResponse
};
