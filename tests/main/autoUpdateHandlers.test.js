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

beforeAll(() => {
  registerAutoUpdateIpc({
    getMainWindow: jest.fn(() => null),
    getUpdateBranch: jest.fn(() => 'main'),
    loadSettings: jest.fn(() => ({})),
    checkUpdateWithTelemetry: jest.fn(),
    processApiResponse: jest.fn()
  });
  for (const [channel, handler] of ipcMain.handle.mock.calls) {
    handlers[channel] = handler;
  }
});

beforeEach(() => {
  app.isPackaged = true;
  app.quit.mockClear();
  autoUpdater.quitAndInstall.mockReset();
  autoUpdater.setFeedURL.mockClear();
  autoUpdater.checkForUpdates.mockReset().mockResolvedValue({});
  autoUpdater.downloadUpdate.mockReset().mockResolvedValue([]);
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.removeAllListeners('error');
  autoUpdater.removeAllListeners('update-downloaded');
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

describe('dev:installPrerelease', () => {
  test('restores the stable release feed after a failed download', async () => {
    autoUpdater.downloadUpdate.mockRejectedValue(new Error('network down'));

    const result = await handlers['dev:installPrerelease'](null, 'v2026.24.29-rc1');

    expect(result.success).toBe(false);
    const feedCalls = autoUpdater.setFeedURL.mock.calls;
    expect(feedCalls[0][0].releaseType).toBe('prerelease');
    expect(feedCalls[feedCalls.length - 1][0].releaseType).toBe('release');
    expect(autoUpdater.allowPrerelease).toBe(false);
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
