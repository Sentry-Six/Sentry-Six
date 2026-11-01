const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { execSync } = require('child_process');

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

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: { 'User-Agent': 'Sentry-Studio-Updater' }
    };
    https.get(url, options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return httpsGet(res.headers.location).then(resolve).catch(reject);
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
    
    const handleResponse = (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const redirectReq = https.get(res.headers.location, options, handleResponse);
        redirectReq.on('error', reject);
        redirectReq.setTimeout(30000, () => { redirectReq.destroy(); reject(new Error('Redirect timeout')); });
        return;
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
      
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(destPath);
      });
      file.on('error', (err) => {
        fs.unlinkSync(destPath);
        reject(err);
      });
    };
    
    https.get(url, options, handleResponse).on('error', reject);
  });
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

  // Update IPC handlers
  ipcMain.handle('update:check', async () => {
    try {
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

      // Fallback to direct GitHub/electron-updater check
      console.log('[UPDATE] Falling back to direct check...');
      if (app.isPackaged && autoUpdater) {
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
    if (app.isPackaged && autoUpdater) {
      quitAndInstallOrExit();
    } else {
      app.quit();
    }
  });

  ipcMain.handle('update:exit', async () => {
    if (app.isPackaged && autoUpdater) {
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
  setupAutoUpdaterEvents
};
