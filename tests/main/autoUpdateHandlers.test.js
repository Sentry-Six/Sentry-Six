/**
 * Tests for src/main/autoUpdate.js IPC handlers
 * Covers: quitAndInstall fallback in update:exit / update:installAndRestart,
 * and dev:installPrerelease feed restoration + listener cleanup.
 */

jest.mock('electron');
jest.mock('electron-updater', () => {
  const { EventEmitter } = require('events');
  const autoUpdater = new EventEmitter();
  Object.assign(autoUpdater, {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    allowDowngrade: false,
    setFeedURL: jest.fn(),
    checkForUpdates: jest.fn(),
    downloadUpdate: jest.fn(),
    quitAndInstall: jest.fn()
  });
  return { autoUpdater };
});

const { app, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const { registerAutoUpdateIpc } = require('../../src/main/autoUpdate');

const handlers = {};

// A real (if tiny) settings store, so update:setChannel can round-trip the
// choice the way it does in the app rather than writing into a throwaway object.
let settingsStore = {};

beforeAll(() => {
  registerAutoUpdateIpc({
    getMainWindow: jest.fn(() => null),
    getUpdateBranch: jest.fn(() => 'main'),
    loadSettings: jest.fn(() => settingsStore),
    saveSettings: jest.fn((next) => { settingsStore = next; return true; }),
    checkUpdateWithTelemetry: jest.fn(),
    processApiResponse: jest.fn()
  });
  for (const [channel, handler] of ipcMain.handle.mock.calls) {
    handlers[channel] = handler;
  }
  // registerAutoUpdateIpc installs a standing update-downloaded listener (it
  // releases a pending downgrade once one lands). beforeEach clears listeners
  // to isolate the dev-install tests, which would otherwise strip it too —
  // snapshot it here so it can be put back.
  standingDownloadedListeners = autoUpdater.listeners('update-downloaded');
});

let standingDownloadedListeners = [];

beforeEach(() => {
  app.isPackaged = true;
  app.quit.mockClear();
  settingsStore = {};
  autoUpdater.quitAndInstall.mockReset();
  autoUpdater.setFeedURL.mockClear();
  autoUpdater.checkForUpdates.mockReset().mockResolvedValue({});
  autoUpdater.downloadUpdate.mockReset().mockResolvedValue([]);
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.removeAllListeners('error');
  autoUpdater.removeAllListeners('update-downloaded');
  for (const listener of standingDownloadedListeners) {
    autoUpdater.on('update-downloaded', listener);
  }
});

describe('update:exit', () => {
  test('falls back to app.quit when quitAndInstall throws', async () => {
    autoUpdater.quitAndInstall.mockImplementation(() => {
      throw new Error("No valid update available, can't quit and install");
    });

    await handlers['update:exit']();

    expect(app.quit).toHaveBeenCalled();
  });
});

describe('update:installAndRestart', () => {
  test('falls back to app.quit when quitAndInstall throws', async () => {
    autoUpdater.quitAndInstall.mockImplementation(() => {
      throw new Error("No valid update available, can't quit and install");
    });

    await handlers['update:installAndRestart']();

    expect(app.quit).toHaveBeenCalled();
  });
});

describe('update:setChannel', () => {
  test('opting in enables prereleases and persists the choice', async () => {
    const result = await handlers['update:setChannel'](null, 'prerelease');

    expect(result).toMatchObject({ success: true, channel: 'prerelease', branch: 'Dev-SEI' });
    expect(autoUpdater.allowPrerelease).toBe(true);
    expect(settingsStore.updateChannel).toBe('prerelease');
  });

  test('opting in does not grant a downgrade', async () => {
    await handlers['update:setChannel'](null, 'prerelease');

    expect(autoUpdater.allowDowngrade).toBe(false);
  });

  // The reported bug: turning the toggle off left users stranded on the beta.
  // Betas ship under ordinary version numbers, so the newest stable is a LOWER
  // version and the move back is a downgrade.
  test('reverting from prerelease to stable permits the downgrade', async () => {
    await handlers['update:setChannel'](null, 'prerelease');
    autoUpdater.allowDowngrade = false; // prove the revert is what grants it

    await handlers['update:setChannel'](null, 'stable');

    expect(autoUpdater.allowPrerelease).toBe(false);
    expect(autoUpdater.allowDowngrade).toBe(true);
    expect(settingsStore.updateChannel).toBe('stable');
  });

  test('stable to stable is not treated as a revert', async () => {
    await handlers['update:setChannel'](null, 'stable');

    expect(autoUpdater.allowDowngrade).toBe(false);
  });

  // The re-check belongs to the renderer, which can display the result. A check
  // fired in here resolves to nobody, so a switch that finds nothing is silent —
  // the toggle then reads as broken, which is what was reported.
  test('does not fire its own check — the renderer owns the re-check', async () => {
    await handlers['update:setChannel'](null, 'prerelease');

    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  // A revert can outlive the session that started it: quit before the download
  // lands and allowDowngrade is back at its constructor default, leaving the
  // user on the beta with the app insisting it is up to date.
  test('records the pending downgrade so it survives a restart', async () => {
    await handlers['update:setChannel'](null, 'prerelease');
    await handlers['update:setChannel'](null, 'stable');

    expect(settingsStore.pendingDowngrade).toBe(true);
  });

  test('opting back in cancels an outstanding revert', async () => {
    await handlers['update:setChannel'](null, 'prerelease');
    await handlers['update:setChannel'](null, 'stable');
    await handlers['update:setChannel'](null, 'prerelease');

    expect(settingsStore.pendingDowngrade).toBeUndefined();
  });

  test('a stable-to-stable call keeps an outstanding revert alive', async () => {
    await handlers['update:setChannel'](null, 'prerelease');
    await handlers['update:setChannel'](null, 'stable');
    autoUpdater.allowDowngrade = false;

    await handlers['update:setChannel'](null, 'stable');

    expect(settingsStore.pendingDowngrade).toBe(true);
    expect(autoUpdater.allowDowngrade).toBe(true);
  });

  test('the permission is released once an update actually installs', async () => {
    await handlers['update:setChannel'](null, 'prerelease');
    await handlers['update:setChannel'](null, 'stable');

    autoUpdater.emit('update-downloaded', { version: '2026.26.34' });

    expect(settingsStore.pendingDowngrade).toBeUndefined();
    expect(autoUpdater.allowDowngrade).toBe(false);
  });

  test('rejects an unknown channel without touching settings', async () => {
    const result = await handlers['update:setChannel'](null, 'nightly');

    expect(result.success).toBe(false);
    expect(settingsStore.updateChannel).toBeUndefined();
    expect(settingsStore.updateBranch).toBeUndefined();
  });

  // A rejected channel must not leave the updater pointing somewhere new.
  test('rejects an unknown channel without re-pointing the updater', async () => {
    await handlers['update:setChannel'](null, 'prerelease');
    autoUpdater.setFeedURL.mockClear();

    await handlers['update:setChannel'](null, 'nightly');

    expect(autoUpdater.setFeedURL).not.toHaveBeenCalled();
    expect(autoUpdater.allowPrerelease).toBe(true);
  });
});

describe('dev:installPrerelease', () => {
  test('restores the stable release feed after a failed download', async () => {
    autoUpdater.downloadUpdate.mockRejectedValue(new Error('network down'));

    const result = await handlers['dev:installPrerelease'](null, 'v2026.24.29-rc1');

    expect(result.success).toBe(false);
    const feedCalls = autoUpdater.setFeedURL.mock.calls;
    expect(feedCalls[0][0].releaseType).toBe('prerelease');
    expect(feedCalls[feedCalls.length - 1][0].releaseType).toBe('release');
    expect(autoUpdater.allowPrerelease).toBe(false);
    // Cleanup genuinely undoes what the attempt changed. The install grants
    // allowDowngrade (an RC can sort below the installed stable); restoring the
    // user's channel withdraws it again, because nothing about a failed dev
    // install should leave an ordinary session willing to move backwards. A
    // real revert keeps its permission through the persisted pendingDowngrade
    // flag instead. See applyUpdateChannel in src/main/autoUpdate.js.
    expect(autoUpdater.allowDowngrade).toBe(false);
  });

  test('failed install does not leave a stale listener that quits on a later normal update', async () => {
    autoUpdater.downloadUpdate.mockRejectedValue(new Error('network down'));
    await handlers['dev:installPrerelease'](null, 'v2026.24.29-rc1');

    // Simulate a normal update finishing later in the same session
    autoUpdater.emit('update-downloaded', { version: '2026.24.29' });

    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  test('successful pre-release download still quits and installs', async () => {
    const result = await handlers['dev:installPrerelease'](null, 'v2026.24.29-rc1');
    expect(result).toEqual({ success: true, downloading: true });

    autoUpdater.emit('update-downloaded', { version: '2026.24.29-rc1' });

    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });
});
