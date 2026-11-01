const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const http = require('http');
const { execSync, spawn } = require('child_process');

// Auto-Update Configuration
const UPDATE_CONFIG = {
  owner: 'Sentry-Six',
  repo: 'Sentry-Six',
  defaultBranch: 'main'
};

// Update channels. `stable` follows published GitHub releases; `prerelease`
// also picks up releases flagged prerelease (RCs / betas). `branch` is used by
// the paths that read raw files from GitHub rather than going through
// electron-updater — the dev-install zip download, the version.json check, and
// the changelog fetch.
const UPDATE_CHANNELS = Object.freeze({
  stable: Object.freeze({
    id: 'stable',
    branch: 'main',
    releaseType: 'release',
    allowPrerelease: false
  }),
  prerelease: Object.freeze({
    id: 'prerelease',
    branch: 'Dev-SEI',
    releaseType: 'prerelease',
    allowPrerelease: true
  })
});
const DEFAULT_CHANNEL_ID = 'stable';

// Packaged Linux install that isn't an AppImage (i.e. a .deb). electron-updater
// can't install these, so we download and install the .deb ourselves via pkexec.
function isDebInstall() {
  return process.platform === 'linux' && app.isPackaged && !process.env.APPIMAGE;
}

// Dev override: fetch version.json, latest-linux.yml and the .deb from
// SENTRY_DEV_UPDATE_URL instead of GitHub. Only unpackaged Linux builds honour it,
// and only for a loopback host, so an installed app always updates from GitHub.
function updateBase() {
  const raw = (process.env.SENTRY_DEV_UPDATE_URL || '').replace(/\/+$/, '');
  if (!raw || process.platform !== 'linux' || app.isPackaged) return '';
  try {
    const host = new URL(raw).hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return raw;
  } catch { /* malformed URL -> ignore override */ }
  return '';
}

// Reject anything but a plain dotted version so it can't traverse the download path.
function isValidVersion(v) {
  return typeof v === 'string' && /^[0-9]+(\.[0-9]+){1,3}$/.test(v);
}

// Debian arch matching the electron-builder artifactName (${arch}).
function debArch() {
  return process.arch === 'arm64' ? 'arm64' : 'amd64';
}

// electron-builder writes latest-linux.yml for x64 and latest-linux-arm64.yml for arm64.
function updateManifestName() {
  return debArch() === 'arm64' ? 'latest-linux-arm64.yml' : 'latest-linux.yml';
}

function debFileName(version) {
  return `SentryStudio-${version}-linux-${debArch()}.deb`;
}

// A file in the release for a version (dev override, else the GitHub release).
function releaseAssetUrl(version, file) {
  const base = updateBase();
  return base
    ? `${base}/${file}`
    : `https://github.com/${UPDATE_CONFIG.owner}/${UPDATE_CONFIG.repo}/releases/download/v${version}/${file}`;
}

// The sha512 (base64) and size electron-builder recorded for a file in
// latest-linux.yml. Only the `files:` list format it writes is accepted.
function parseUpdateManifest(text, fileName) {
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const url = line.match(/^\s*-\s+url:\s*(\S+)\s*$/);
    if (url) {
      current = url[1].replace(/^['"]|['"]$/g, '') === fileName ? {} : null;
      continue;
    }
    if (!current) continue;
    const sha = line.match(/^\s+sha512:\s*(\S+)\s*$/);
    const size = line.match(/^\s+size:\s*(\d+)\s*$/);
    if (sha) current.sha512 = sha[1].replace(/^['"]|['"]$/g, '');
    if (size) current.size = Number(size[1]);
    if (current.sha512 && current.size) return current;
  }
  return null;
}

function sha512Base64(file) {
  const hash = crypto.createHash('sha512');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(1 << 20);
  try {
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('base64');
}

function matchesManifest(file, expected) {
  return fs.statSync(file).size === expected.size && sha512Base64(file) === expected.sha512;
}

// The verified .deb downloaded by update:install (and its manifest entry),
// awaiting update:installAndRestart.
let pendingDebPath = null;
let pendingDebExpected = null;

// electron-updater is optional - only needed for NSIS packaged installs
// Manual npm installs use the GitHub download method instead
let autoUpdater = null;
try {
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
} catch (err) {
  console.log('[UPDATE] electron-updater not available - using manual update method');
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

// HTTPS only. Plain http is allowed just for the unpackaged dev override's
// loopback server, and a redirect must stay on HTTPS too.
function clientFor(url) {
  const base = updateBase();
  if (url.startsWith('https://')) return https;
  if (base && url.startsWith(`${base}/`)) return http;
  throw new Error(`Refusing non-HTTPS update URL: ${url}`);
}

function httpsGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: { 'User-Agent': 'Sentry-Studio-Updater' }
    };
    clientFor(url).get(url, options, (res) => {
      if (REDIRECT_CODES.has(res.statusCode)) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) return reject(new Error('Too many redirects'));
        const next = new URL(res.headers.location, url).toString();
        return httpsGet(next, redirects + 1).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, data }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: { 'User-Agent': 'Sentry-Studio-Updater' }
    };

    const fail = (err) => {
      try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch { /* best effort */ }
      reject(err);
    };

    let redirects = 0;
    const handleResponse = (res) => {
      if (REDIRECT_CODES.has(res.statusCode)) {
        res.resume();
        if (++redirects > MAX_REDIRECTS) return reject(new Error('Too many redirects'));
        const next = new URL(res.headers.location, url).toString();
        let redirectReq;
        try {
          redirectReq = clientFor(next).get(next, options, handleResponse);
        } catch (err) {
          return reject(err);
        }
        redirectReq.on('error', reject);
        redirectReq.setTimeout(30000, () => { redirectReq.destroy(); reject(new Error('Redirect timeout')); });
        return;
      }
      // Only a 200 body is a real download; a 404/500 page must not be saved and
      // later handed to `dpkg -i` as if it were a package.
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
      }

      const totalSize = parseInt(res.headers['content-length'], 10);
      let downloadedSize = 0;
      const file = fs.createWriteStream(destPath);

      res.on('data', chunk => {
        downloadedSize += chunk.length;
        if (onProgress && totalSize) {
          onProgress(Math.round((downloadedSize / totalSize) * 100));
        }
      });
      res.on('error', (err) => { file.destroy(); fail(err); });

      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          if (totalSize && downloadedSize !== totalSize) {
            return fail(new Error(`Truncated download: ${downloadedSize}/${totalSize} bytes`));
          }
          resolve(destPath);
        });
      });
      file.on('error', (err) => fail(err));
    };

    try {
      clientFor(url).get(url, options, handleResponse).on('error', reject);
    } catch (err) {
      reject(err);
    }
  });
}

// Fetch the latest version.json, honouring the dev override base URL when set.
async function fetchLatestVersionInfo(getUpdateBranch) {
  const base = updateBase();
  if (base) {
    const response = await httpsGet(`${base}/version.json?cb=${Date.now()}`);
    return response.statusCode === 200 ? JSON.parse(response.data) : null;
  }
  return getLatestVersionFromGitHub(getUpdateBranch);
}

// The manifest entry for a version's .deb, or why there isn't one. version.json
// changes when the release commit lands, before the Linux job uploads the
// package, so a missing manifest means the release isn't ready yet.
async function fetchDebManifestEntry(version) {
  const response = await httpsGet(releaseAssetUrl(version, updateManifestName()));
  if (response.statusCode === 404) return { notReady: true };
  const entry = response.statusCode === 200 ? parseUpdateManifest(response.data, debFileName(version)) : null;
  return entry ? { entry } : {};
}

// apt-get resolves dependencies a new release adds; dpkg -i would fail on them.
// Absolute paths so an attacker-controlled PATH can't substitute a binary in the
// privileged install. --allow-downgrades keeps switching back to stable working.
function debInstallCommand(debPath, exists = fs.existsSync) {
  return exists('/usr/bin/apt-get')
    ? ['/usr/bin/apt-get', 'install', '-y', '--allow-downgrades', debPath]
    : ['/usr/bin/dpkg', '-i', debPath];
}

/**
 * Resolve the configured update channel from a settings object.
 *
 * Falls back to the legacy `updateBranch` setting — the dropdown that shipped
 * until the 2026.6.11 UI overhaul removed it — so anyone who had opted into
 * Dev-SEI back then lands on the pre-release channel instead of being silently
 * moved to stable.
 *
 * @param {object} settings - Parsed settings.json contents
 * @returns {{id: string, branch: string, releaseType: string, allowPrerelease: boolean}}
 */
function resolveUpdateChannel(settings) {
  const channelId = settings && settings.updateChannel;
  if (channelId && UPDATE_CHANNELS[channelId]) return UPDATE_CHANNELS[channelId];

  const legacyBranch = settings && settings.updateBranch;
  if (legacyBranch && legacyBranch !== UPDATE_CONFIG.defaultBranch) {
    return UPDATE_CHANNELS.prerelease;
  }
  return UPDATE_CHANNELS[DEFAULT_CHANNEL_ID];
}

/**
 * Point electron-updater at a channel.
 *
 * `allowPrerelease` is the switch that actually does the work. With it on,
 * GitHubProvider walks the releases Atom feed (which includes pre-releases) and
 * takes the newest entry; with it off it asks for /releases/latest, which GitHub
 * excludes pre-releases from. That is what makes the toggle work here even
 * though Sentry Studio ships betas under ordinary version numbers — "Sentry
 * Studio Beta Release v2026.26.34" — flagged prerelease on the GitHub release
 * rather than carrying an -rc/-beta semver suffix.
 *
 * The feed's `releaseType` is NOT what switches channels. It is a publish-time
 * option describing what kind of release electron-builder should create;
 * GitHubProvider never reads it. It is set here only to keep the runtime feed
 * consistent with package.json's publish block.
 *
 * `allowDowngrade` is off by default and granted only for a deliberate revert.
 * Because betas carry ordinary version numbers, a beta's version is usually
 * HIGHER than the newest stable, so going back is a downgrade; but leaving the
 * permission on for everyone would also let a republished older release roll
 * ordinary stable users backwards. Sentry Drive scopes it the same way (its
 * revert-to-stable handler). The caller passes it explicitly and it is written
 * every time rather than only when true — a plain re-application must be able to
 * clear a grant that is no longer wanted, and this function runs at boot.
 *
 * Never assign `autoUpdater.channel`: its setter unconditionally sets
 * allowDowngrade = true, which would silently undo all of the above.
 *
 * No-ops without electron-updater (manual npm installs), which update by
 * downloading the branch zip instead.
 *
 * @param {object} channel - A UPDATE_CHANNELS entry
 * @param {{allowDowngrade?: boolean}} [opts] - Grant a downgrade for a revert
 * @returns {object} The channel that was applied
 */
function applyUpdateChannel(channel, opts = {}) {
  if (!autoUpdater) return channel;

  autoUpdater.allowPrerelease = channel.allowPrerelease;
  autoUpdater.allowDowngrade = !!opts.allowDowngrade;
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: UPDATE_CONFIG.owner,
    repo: UPDATE_CONFIG.repo,
    releaseType: channel.releaseType
  });

  // Switching channels invalidates anything the previous channel resolved.
  // checkForUpdates() hands back an in-flight promise rather than starting a
  // fresh check, so without this the post-switch re-check can be answered by a
  // result computed against the old feed. updateInfoAndProvider is never cleared
  // by electron-updater on the not-available branch either, so a stale offer
  // from the other channel would otherwise remain installable.
  autoUpdater.checkForUpdatesPromise = null;
  autoUpdater.updateInfoAndProvider = null;
  return channel;
}

/**
 * Fetch the latest version.json from GitHub (for manual/dev installs)
 */
async function getLatestVersionFromGitHub(getUpdateBranch) {
  const cacheBuster = Date.now();
  const url = `https://raw.githubusercontent.com/${UPDATE_CONFIG.owner}/${UPDATE_CONFIG.repo}/${getUpdateBranch()}/version.json?cb=${cacheBuster}`;
  const response = await httpsGet(url);
  
  if (response.statusCode === 200) {
    return JSON.parse(response.data);
  }
  return null;
}

/**
 * Compare two semantic version strings
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

function copyDirectoryRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  
  const entries = fs.readdirSync(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Register all auto-update IPC handlers
 * @param {object} deps - Dependencies
 * @param {function} deps.getMainWindow - Returns the main BrowserWindow
 * @param {function} deps.getUpdateBranch - Returns the configured update branch
 * @param {function} deps.loadSettings - Returns settings object
 * @param {function} deps.saveSettings - Persists a settings object
 * @param {function} deps.checkUpdateWithTelemetry - Telemetry check function
 * @param {function} deps.processApiResponse - Process telemetry API response
 */
function registerAutoUpdateIpc(deps) {
  // Mac App Store builds update exclusively via the App Store — skip all GitHub update logic
  if (process.mas) {
    console.log('[UPDATE] Mac App Store build detected — auto-update disabled');
    return;
  }

  const { getMainWindow, getUpdateBranch, loadSettings, saveSettings, checkUpdateWithTelemetry, processApiResponse } = deps;

  const getActiveChannel = () => resolveUpdateChannel(loadSettings());

  // A revert to stable can need more than one session to finish: the user flips
  // the toggle, the download is still running (or never started) when they quit,
  // and on the next launch allowDowngrade is back at its constructor default of
  // false — leaving them on the beta with the app insisting it is up to date.
  // The permission is therefore persisted until an update actually lands.
  const isDowngradePending = () => loadSettings().pendingDowngrade === true;

  function setDowngradePending(pending) {
    const settings = loadSettings();
    if (pending) settings.pendingDowngrade = true;
    else delete settings.pendingDowngrade;
    saveSettings(settings);
  }

  // Apply the persisted channel up front so the session's first update check
  // already targets the right feed rather than electron-builder's default.
  //
  // This is load-bearing, not belt-and-braces: electron-updater's constructor
  // runs `allowPrerelease = hasPrereleaseComponents(currentVersion)`, which is
  // false for every plain calendar version Sentry Studio ships — so without
  // re-applying here, a machine running a beta would silently be put back on the
  // stable track on every launch.
  const startupChannel = getActiveChannel();
  const startupDowngrade = isDowngradePending();
  applyUpdateChannel(startupChannel, { allowDowngrade: startupDowngrade });
  console.log(
    `[UPDATE] Update channel: ${startupChannel.id} (branch ${startupChannel.branch})` +
    (startupDowngrade ? ' — downgrade to stable still pending' : '')
  );

  // The revert has completed once something actually installs; drop the
  // permission so an ordinary session cannot be rolled backwards later.
  if (autoUpdater) {
    autoUpdater.on('update-downloaded', () => {
      if (!isDowngradePending()) return;
      setDowngradePending(false);
      autoUpdater.allowDowngrade = false;
      console.log('[UPDATE] Downgrade to stable completed — permission cleared');
    });
  }

  /**
   * Check for updates - handles both packaged (NSIS) and development (npm start) modes
   */
  async function checkForUpdatesManual() {
    try {
      console.log('[UPDATE] Manual update check (dev mode)...');
      const latestVersion = await getLatestVersionFromGitHub(getUpdateBranch);
      
      if (!latestVersion) {
        console.log('[UPDATE] No remote version available');
        return { updateAvailable: false, error: 'Could not fetch version info' };
      }
      
      const currentVer = app.getVersion();
      const latestVer = latestVersion.version;
      
      console.log(`[UPDATE] Current: v${currentVer}, Latest: v${latestVer}`);
      
      // Different, not just newer. This path reads version.json off the
      // channel's own branch, so switching channels can legitimately point at a
      // LOWER version — reverting from Dev-SEI to main usually does. Testing for
      // "newer" reported "up to date" and offered no way back.
      if (compareVersions(currentVer, latestVer) !== 0) {
        console.log('[UPDATE] Different version available on this channel!');
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('update:available', {
            currentVersion: currentVer,
            latestVersion: latestVer,
            releaseName: latestVersion.releaseName || 'New Update',
            releaseDate: latestVersion.releaseDate,
            isDevMode: true
          });
        }
        return { updateAvailable: true, currentVersion: currentVer, latestVersion: latestVer };
      } else {
        console.log('[UPDATE] App is up to date');
        return { updateAvailable: false, currentVersion: currentVer, latestVersion: latestVer };
      }
    } catch (err) {
      console.error('[UPDATE] Manual check failed:', err.message);
      return { updateAvailable: false, error: err.message };
    }
  }

  /**
   * Perform update for manual/development installs
   */
  async function performManualUpdate(event) {
    const sendProgress = (percentage, message) => {
      const mainWindow = getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:progress', { percentage, message });
      }
    };
    
    try {
      sendProgress(5, 'Fetching latest version info...');
      const latestVersion = await getLatestVersionFromGitHub(getUpdateBranch);
      
      const zipUrl = `https://github.com/${UPDATE_CONFIG.owner}/${UPDATE_CONFIG.repo}/archive/refs/heads/${getUpdateBranch()}.zip`;
      const tempDir = path.join(os.tmpdir(), 'sentry-six-update');
      const zipPath = path.join(tempDir, 'update.zip');
      
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
      fs.mkdirSync(tempDir, { recursive: true });
      
      sendProgress(10, 'Downloading update...');
      await downloadFile(zipUrl, zipPath, (pct) => {
        sendProgress(10 + Math.round(pct * 0.5), `Downloading... ${pct}%`);
      });
      
      sendProgress(60, 'Extracting update...');
      
      const extractDir = path.join(tempDir, 'extracted');
      fs.mkdirSync(extractDir, { recursive: true });
      
      if (process.platform === 'win32') {
        execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`, { windowsHide: true });
      } else {
        execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: 'ignore' });
      }
      
      sendProgress(75, 'Installing update...');
      
      const extractedContents = fs.readdirSync(extractDir);
      const sourceDir = path.join(extractDir, extractedContents[0]);
      
      const appDir = path.join(__dirname, '..', '..');
      
      const filesToCopy = fs.readdirSync(sourceDir, { withFileTypes: true });
      for (const entry of filesToCopy) {
        const srcPath = path.join(sourceDir, entry.name);
        const destPath = path.join(appDir, entry.name);
        
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        
        if (entry.isDirectory()) {
          copyDirectoryRecursive(srcPath, destPath);
        } else {
          fs.copyFileSync(srcPath, destPath);
        }
      }
      
      sendProgress(90, 'Cleaning up...');
      
      fs.rmSync(tempDir, { recursive: true, force: true });
      
      console.log(`[UPDATE] Updated to v${latestVersion?.version || 'latest'}`);
      
      sendProgress(100, 'Update complete!');
      
      const mainWindow = getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:downloaded', { version: latestVersion?.version, isDevMode: true });
      }
      
      return { success: true, needsRestart: true, isDevMode: true };
    } catch (err) {
      console.error('Manual update failed:', err);
      return { success: false, error: err.message };
    }
  }

  const sendUpdateError = (message) => {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:error', { message });
    }
  };

  // Remove the temp dir holding a downloaded .deb, if any.
  function clearPendingDeb() {
    if (!pendingDebPath) return;
    try { fs.rmSync(path.dirname(pendingDebPath), { recursive: true, force: true }); } catch { /* best effort */ }
    pendingDebPath = null;
    pendingDebExpected = null;
  }

  /** Report a newer version only when its .deb and manifest are on the release. */
  async function checkDebUpdate() {
    const currentVersion = app.getVersion();
    const latest = await fetchLatestVersionInfo(getUpdateBranch);
    const latestVersion = latest && isValidVersion(latest.version) ? latest.version : null;
    if (!latestVersion || compareVersions(currentVersion, latestVersion) >= 0) {
      return { checked: true, updateAvailable: false, currentVersion, latestVersion: currentVersion };
    }
    const manifest = await fetchDebManifestEntry(latestVersion);
    if (!manifest.entry) {
      console.log(`[UPDATE] ${latestVersion} has no Linux package on its release yet`);
      return { checked: true, updateAvailable: false, currentVersion, latestVersion: currentVersion };
    }
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:available', {
        currentVersion,
        latestVersion,
        releaseName: latest.releaseName || 'New Update',
        releaseDate: latest.releaseDate
      });
    }
    return { checked: true, updateAvailable: true, currentVersion, latestVersion };
  }

  /** Download the new .deb; installDebAndRestart installs it on restart. */
  async function performDebUpdate() {
    const sendProgress = (percentage, message) => {
      const mainWindow = getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:progress', { percentage, message });
      }
    };

    let destPath = null;
    try {
      sendProgress(5, 'Fetching latest version info...');
      const latest = await fetchLatestVersionInfo(getUpdateBranch);
      if (!latest || !latest.version) {
        return { success: false, error: 'Could not fetch version info' };
      }
      const version = latest.version;
      if (!isValidVersion(version)) {
        return { success: false, error: 'Invalid update version' };
      }

      // A private 0700 dir (random name) is the download target: another local
      // user can't pre-create or symlink the path we later install as root.
      // The package is installed as root, so it must match the sha512 and size
      // electron-builder recorded for it in the release's update manifest.
      const fileName = debFileName(version);
      const manifest = await fetchDebManifestEntry(version);
      if (manifest.notReady) {
        return { success: false, error: 'This update is still being published. Try again in a few minutes.' };
      }
      const expected = manifest.entry;
      if (!expected) {
        return { success: false, error: 'Could not verify the update package' };
      }

      clearPendingDeb();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-upd-'));
      destPath = path.join(dir, fileName);

      sendProgress(10, 'Downloading update...');
      await downloadFile(releaseAssetUrl(version, fileName), destPath, (pct) => {
        sendProgress(10 + Math.round(pct * 0.85), `Downloading... ${pct}%`);
      });

      if (!matchesManifest(destPath, expected)) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
        return { success: false, error: 'Update package failed verification' };
      }

      // Confirm it's really a Debian archive before offering to install it.
      const fd = fs.openSync(destPath, 'r');
      const magic = Buffer.alloc(8);
      fs.readSync(fd, magic, 0, 8, 0);
      fs.closeSync(fd);
      if (magic.toString('binary') !== '!<arch>\n') {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
        return { success: false, error: 'Downloaded file is not a valid package' };
      }

      pendingDebPath = destPath;
      pendingDebExpected = expected;
      sendProgress(100, 'Update downloaded');

      const mainWindow = getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:downloaded', { version, isDeb: true });
      }
      return { success: true, needsRestart: true, isDeb: true };
    } catch (err) {
      console.error('[UPDATE] .deb download failed:', err.message);
      if (destPath) { try { fs.rmSync(path.dirname(destPath), { recursive: true, force: true }); } catch { /* best effort */ } }
      return { success: false, error: err.message };
    }
  }

  // Guards against a second click spawning a competing dpkg while one is running.
  let debInstalling = false;

  /** Install the downloaded .deb via pkexec, then relaunch. dpkg -i over the
   *  running app is safe; relaunch only on a clean exit. */
  function installDebAndRestart() {
    if (debInstalling) return;
    if (!pendingDebPath || !fs.existsSync(pendingDebPath)) {
      clearPendingDeb();
      sendUpdateError('Update file is no longer available. Please check for updates again.');
      return;
    }
    // Checked again right before the privileged install.
    if (!pendingDebExpected || !matchesManifest(pendingDebPath, pendingDebExpected)) {
      clearPendingDeb();
      sendUpdateError('Update package failed verification. Please check for updates again.');
      return;
    }
    debInstalling = true;
    // stderr is captured for diagnostics.
    const child = spawn('/usr/bin/pkexec', debInstallCommand(pendingDebPath), {
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    if (child.stderr) child.stderr.on('data', (d) => { stderr += d.toString(); });
    let handled = false;
    child.on('error', (err) => {
      handled = true;
      debInstalling = false;
      console.error('[UPDATE] pkexec failed to launch:', err.message);
      sendUpdateError('Could not start the installer.');
    });
    child.on('exit', (code) => {
      if (handled) return;
      if (code === 0) {
        const deb = pendingDebPath;
        pendingDebPath = null;
        pendingDebExpected = null;
        try { fs.rmSync(path.dirname(deb), { recursive: true, force: true }); } catch { /* best effort */ }
        app.relaunch();
        app.exit(0);
      } else {
        // Non-zero includes the user cancelling the password prompt (126/127).
        debInstalling = false;
        console.error(`[UPDATE] dpkg -i exited with code ${code}${stderr ? ': ' + stderr.trim() : ''}`);
        sendUpdateError('Install was cancelled or failed.');
      }
    });
  }

  // Update IPC handlers
  ipcMain.handle('update:check', async () => {
    try {
      // Dev override: compare against the local version.json (no telemetry API / release).
      if (updateBase()) {
        const latest = await fetchLatestVersionInfo(getUpdateBranch);
        const currentVer = app.getVersion();
        const updateAvailable = !!(latest && latest.version && compareVersions(currentVer, latest.version) < 0);
        if (updateAvailable) {
          const mainWindow = getMainWindow();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('update:available', {
              currentVersion: currentVer,
              latestVersion: latest.version,
              releaseName: latest.releaseName || 'New Update',
              releaseDate: latest.releaseDate
            });
          }
        }
        return { checked: true, updateAvailable, currentVersion: currentVer, latestVersion: (latest && latest.version) || currentVer };
      }

      // Step 1: Check with telemetry API (for killswitch and update status)
      console.log('[UPDATE] Checking with telemetry API...');
      const apiResponse = await checkUpdateWithTelemetry();
      const processedResult = processApiResponse(apiResponse);
      
      // Handle force_manual (killswitch)
      if (processedResult.action === 'force_manual') {
        console.log('[UPDATE] Force manual update required (killswitch activated)');
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('update:forceManual', {
            message: processedResult.message,
            download_url: processedResult.download_url,
            new_version: processedResult.new_version,
            currentVersion: app.getVersion()
          });
        }
        return {
          checked: true,
          updateAvailable: true,
          forceManual: true,
          message: processedResult.message,
          download_url: processedResult.download_url,
          currentVersion: app.getVersion(),
          latestVersion: processedResult.new_version
        };
      }
      
      // A .deb install announces an update only once its package is on the release.
      if (isDebInstall()) return await checkDebUpdate();

      // Handle update available from API
      if (processedResult.action === 'update_available') {
        console.log('[UPDATE] Update available from API:', processedResult.new_version);
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('update:available', {
            currentVersion: app.getVersion(),
            latestVersion: processedResult.new_version,
            releaseName: 'New Update',
            serverMessage: processedResult.message
          });
        }
        return {
          checked: true,
          updateAvailable: true,
          currentVersion: app.getVersion(),
          latestVersion: processedResult.new_version,
          serverMessage: processedResult.message
        };
      }
      
      // Handle up_to_date from API.
      //
      // The telemetry API only knows the stable line — it is sent a version and
      // nothing about channels — so its "you are current" verdict cannot be
      // trusted to end the check. Two cases it gets wrong:
      //   - on the pre-release channel, a newer beta it has never heard of;
      //   - after switching back to stable from a beta, where the running
      //     version is HIGHER than the newest stable and the revert is a
      //     downgrade the API will never report.
      // In both, defer to the channel-aware electron-updater check below and
      // only report "up to date" if that agrees. force_manual is handled above
      // and still wins, so the killswitch is unaffected.
      if (processedResult.action === 'up_to_date') {
        if (!(app.isPackaged && autoUpdater)) {
          console.log('[UPDATE] App is up to date (from API)');
          return {
            checked: true,
            updateAvailable: false,
            currentVersion: app.getVersion(),
            latestVersion: app.getVersion(),
            serverMessage: processedResult.message
          };
        }
        console.log('[UPDATE] API reports up to date — confirming against the channel feed');
      }

      // Fallback to direct GitHub/electron-updater check. A .deb install skips
      // electron-updater (on Linux it only supports AppImage) and reads version.json.
      console.log('[UPDATE] Falling back to direct check...');
      if (app.isPackaged && autoUpdater && !isDebInstall()) {
        const result = await autoUpdater.checkForUpdates();
        // Take electron-updater's own verdict. Deriving one from updateInfo was
        // wrong twice over: updateInfo is populated on the NOT-available branch
        // too (doCheckForUpdates returns {isUpdateAvailable:false, updateInfo}),
        // so any version difference read as an offer — and compareVersions is
        // not semver-aware, so it can disagree with the comparator that actually
        // gates the download. The visible symptom was "Update found" with no
        // modal, then update:install rejecting with "Please check update first"
        // because no provider had been staged.
        //
        // isUpdateAvailable already accounts for the revert case: it is
        // `newer || (allowDowngrade && older)`, and the downgrade permission is
        // granted and persisted for exactly that transition.
        const updateAvailable = result?.isUpdateAvailable === true;
        return {
          checked: true,
          updateAvailable,
          currentVersion: app.getVersion(),
          latestVersion: result?.updateInfo?.version || app.getVersion()
        };
      } else {
        const result = await checkForUpdatesManual();
        return { checked: true, ...result };
      }
    } catch (err) {
      console.error('[UPDATE] Check failed:', err.message);
      return { checked: false, updateAvailable: false, error: err.message };
    }
  });

  ipcMain.handle('update:install', async (event) => {
    try {
      if (isDebInstall()) {
        // Linux .deb: download the package, install it on restart via pkexec.
        return await performDebUpdate();
      }
      if (app.isPackaged) {
        if (autoUpdater) {
          // Both Windows (NSIS) and macOS (Squirrel.Mac) flow through electron-updater.
          // electron-updater downloads the delta using the .blockmap file published
          // alongside the installer/zip, so users re-download only changed chunks
          // instead of the full ~275 MB DMG / 150 MB EXE.
          await autoUpdater.checkForUpdates();
          await autoUpdater.downloadUpdate();
          return { success: true, downloading: true };
        } else {
          return { success: false, error: 'Auto-updater not available' };
        }
      } else {
        const result = await performManualUpdate(event);
        return result;
      }
    } catch (err) {
      console.error('[UPDATE] Download failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  // quitAndInstall throws if no update was actually downloaded, which would
  // leave the app running with no way to exit — fall back to a plain quit.
  function quitAndInstallOrExit() {
    try {
      autoUpdater.quitAndInstall(false, true);
    } catch (err) {
      console.error('[UPDATE] quitAndInstall failed, quitting normally:', err.message);
      app.quit();
    }
  }

  ipcMain.handle('update:installAndRestart', async () => {
    // electron-updater is a hard dependency, so `autoUpdater` is non-null in dev
    // too — without the isPackaged gate that update:exit already has, this hit
    // quitAndInstall, threw, and fell through to a plain app.quit(): the app
    // vanished and nothing was installed. Dev installs update by branch zip.
    if (pendingDebPath) {
      installDebAndRestart();
    } else if (app.isPackaged && autoUpdater) {
      quitAndInstallOrExit();
    } else {
      app.quit();
    }
  });

  ipcMain.handle('update:exit', async () => {
    // "Exit" means quit, not install. A pending .deb stays for the next launch's
    // check; only update:installAndRestart runs the privileged install.
    if (!pendingDebPath && app.isPackaged && autoUpdater) {
      // Both platforms apply the downloaded update via Squirrel on quit.
      quitAndInstallOrExit();
    } else {
      app.quit();
    }
  });

  ipcMain.handle('update:skip', async () => {
    return { skipped: true };
  });

  ipcMain.handle('update:getChannel', async () => {
    const channel = getActiveChannel();
    return { channel: channel.id, branch: channel.branch };
  });

  ipcMain.handle('update:setChannel', async (_event, channelId) => {
    const channel = UPDATE_CHANNELS[channelId];
    if (!channel) {
      return { success: false, error: `Unknown update channel: ${channelId}` };
    }

    const previous = getActiveChannel();

    // Leaving the pre-release channel is the one case that needs to move
    // *backwards*: betas here carry ordinary version numbers, so the newest
    // stable is usually a lower version than the beta being left behind. The
    // permission is recorded so it survives a quit before the download lands;
    // opting back in cancels a revert that was still outstanding.
    const isRevertToStable = previous.id === 'prerelease' && channel.id === 'stable';
    const downgrade = isRevertToStable || (channel.id === 'stable' && isDowngradePending());

    // One write, so a failed save can never leave the channel and the pending
    // downgrade disagreeing with each other.
    const settings = loadSettings();
    settings.updateChannel = channel.id;
    // Keep the legacy branch key in step. It is what older builds sharing this
    // settings file read directly, and resolveUpdateChannel still honours it.
    settings.updateBranch = channel.branch;
    if (downgrade) settings.pendingDowngrade = true;
    else delete settings.pendingDowngrade;
    const saved = saveSettings(settings);

    applyUpdateChannel(channel, { allowDowngrade: downgrade });

    console.log(
      `[UPDATE] Channel set to ${channel.id} (branch ${channel.branch})` +
      (isRevertToStable ? ' — downgrade to stable permitted' : '')
    );

    // The re-check is deliberately NOT fired here. Calling checkForUpdates()
    // inside the handler returns its answer to nobody: the renderer only learns
    // of an update through the update:available event, so a switch that finds
    // nothing — the common case when reverting — produced no feedback at all and
    // read as a broken toggle. The renderer now runs the check itself through
    // update:check, which returns a result it can display in the same states the
    // Check Now button already uses. Sentry Drive drives it from the renderer
    // for the same reason.

    return { success: saved, channel: channel.id, branch: channel.branch };
  });

  // Pre-release testing handlers. Fetches the latest GitHub release with
  // `prerelease: true` and, on install, flips the autoUpdater into a
  // prerelease+downgrade-allowed mode so the pre-release installs even
  // when its semver sorts below the currently-installed stable version
  // (e.g. 2026.12.15-rc1 < 2026.12.15). The feed and flags are reset to the
  // user's configured channel after the download completes so ordinary update
  // cycles are not permanently flipped.
  //
  // This is the one-shot dev-tools path; users who want to stay on pre-releases
  // should switch the update channel in Settings instead.
  ipcMain.handle('dev:checkPrerelease', async () => {
    try {
      const url = `https://api.github.com/repos/${UPDATE_CONFIG.owner}/${UPDATE_CONFIG.repo}/releases?per_page=10`;
      const response = await httpsGet(url);
      if (response.statusCode !== 200) {
        return { found: false, error: `GitHub API returned ${response.statusCode}` };
      }
      const releases = JSON.parse(response.data);
      const pre = releases.find(r => r.prerelease && !r.draft);
      if (!pre) {
        return { found: false, error: 'No pre-release found on GitHub' };
      }
      console.log(`[UPDATE] Dev check found pre-release: ${pre.tag_name}`);
      return {
        found: true,
        tag: pre.tag_name,
        name: pre.name,
        body: pre.body,
        publishedAt: pre.published_at
      };
    } catch (err) {
      console.error('[UPDATE] Dev pre-release check failed:', err.message);
      return { found: false, error: err.message };
    }
  });

  ipcMain.handle('dev:installPrerelease', async (event, tag) => {
    if (!app.isPackaged || !autoUpdater) {
      return {
        success: false,
        error: 'Pre-release install only works on packaged builds (NSIS / DMG). In dev mode (npm start), check out the tag in git instead.'
      };
    }
    try {
      console.log(`[UPDATE] Dev-triggered pre-release install: ${tag}`);

      autoUpdater.allowPrerelease = true;
      autoUpdater.allowDowngrade = true;
      autoUpdater.setFeedURL({
        provider: 'github',
        owner: UPDATE_CONFIG.owner,
        repo: UPDATE_CONFIG.repo,
        releaseType: 'prerelease'
      });

      // cleanup() must undo everything the prerelease attempt changed —
      // flags, feed, and BOTH event listeners. Removing the sibling listener
      // matters: a stale update-downloaded listener left behind by a failed
      // attempt would force quitAndInstall in the middle of a later normal
      // update in the same session.
      const onError = () => cleanup();
      const onDownloaded = () => {
        cleanup();
        // Both platforms apply the downloaded update via Squirrel on quit.
        // Same quitAndInstall signature used by the normal update flow.
        autoUpdater.quitAndInstall(false, true);
      };
      const cleanup = () => {
        // Restore the user's configured channel, NOT a hardcoded stable feed —
        // a dev-tools install must not silently drag someone off the
        // pre-release channel they opted into.
        applyUpdateChannel(getActiveChannel());
        autoUpdater.removeListener('error', onError);
        autoUpdater.removeListener('update-downloaded', onDownloaded);
      };
      autoUpdater.once('error', onError);
      autoUpdater.once('update-downloaded', onDownloaded);

      try {
        await autoUpdater.checkForUpdates();
        await autoUpdater.downloadUpdate();
        return { success: true, downloading: true };
      } catch (err) {
        cleanup();
        throw err;
      }
    } catch (err) {
      console.error('[UPDATE] Pre-release install failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('update:getChangelog', async () => {
    try {
      const cacheBuster = Date.now();
      const url = `https://raw.githubusercontent.com/${UPDATE_CONFIG.owner}/${UPDATE_CONFIG.repo}/${getUpdateBranch()}/changelog.json?cb=${cacheBuster}`;
      const response = await httpsGet(url);
      
      if (response.statusCode === 200) {
        return JSON.parse(response.data);
      }
      
      console.log('[UPDATE] Remote changelog not available, falling back to local');
      const changelogPath = path.join(__dirname, '..', '..', 'changelog.json');
      if (fs.existsSync(changelogPath)) {
        const data = fs.readFileSync(changelogPath, 'utf8');
        return JSON.parse(data);
      }
      return { versions: [] };
    } catch (err) {
      console.error('[UPDATE] Failed to load changelog:', err);
      return { versions: [] };
    }
  });
}

/**
 * Set up electron-updater event handlers on the main window
 * @param {BrowserWindow} mainWindow
 */
function setupAutoUpdaterEvents(mainWindow) {
  if (!autoUpdater) return;
  
  autoUpdater.on('checking-for-update', () => {
    console.log('[UPDATE] Checking for updates...');
  });
  
  autoUpdater.on('update-available', (info) => {
    console.log('[UPDATE] Update available:', info.version);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:available', {
        currentVersion: app.getVersion(),
        latestVersion: info.version,
        releaseName: info.releaseName || 'New Update',
        releaseDate: info.releaseDate
      });
    }
  });
  
  autoUpdater.on('update-not-available', () => {
    console.log('[UPDATE] App is up to date');
  });
  
  autoUpdater.on('download-progress', (progress) => {
    console.log(`[UPDATE] Download progress: ${Math.round(progress.percent)}%`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:progress', {
        percentage: Math.round(progress.percent),
        message: `Downloading... ${Math.round(progress.percent)}%`
      });
    }
  });
  
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[UPDATE] Update downloaded:', info.version);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:downloaded', {
        version: info.version
      });
    }
  });
  
  autoUpdater.on('error', (err) => {
    console.error('[UPDATE] Error:', err.message);
  });
}

module.exports = {
  UPDATE_CONFIG,
  UPDATE_CHANNELS,
  DEFAULT_CHANNEL_ID,
  autoUpdater,
  applyUpdateChannel,
  getLatestVersionFromGitHub,
  registerAutoUpdateIpc,
  resolveUpdateChannel,
  setupAutoUpdaterEvents,
  linuxDebInternals: { clientFor, parseUpdateManifest, updateBase, debInstallCommand }
};
