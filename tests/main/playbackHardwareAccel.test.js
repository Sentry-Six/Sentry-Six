/**
 * Tests for src/main/settings.js applyPlaybackHardwareAcceleration().
 *
 * Multi-cam playback decodes up to 6 <video> elements at once. On low-end
 * integrated GPUs the hardware video decoder runs out of concurrent decode
 * sessions and all but one stream freeze. The setting lets the user force
 * software video decoding via a Chromium switch applied before app 'ready'.
 */

jest.mock('electron');

const fs = require('fs');
const { app } = require('electron');
const { saveSettings, applyPlaybackHardwareAcceleration } = require('../../src/main/settings');

beforeEach(() => {
  app.commandLine.appendSwitch.mockClear();
  // The test userData dir doesn't exist on disk; persistence is irrelevant here
  // since saveSettings updates the in-memory cache that loadSettings reads.
  jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
});

afterEach(() => {
  fs.writeFileSync.mockRestore();
});

describe('applyPlaybackHardwareAcceleration', () => {
  test('keeps hardware decoding on by default (setting absent)', () => {
    saveSettings({});

    const enabled = applyPlaybackHardwareAcceleration();

    expect(enabled).toBe(true);
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
  });

  test('keeps hardware decoding on when explicitly enabled', () => {
    saveSettings({ hardwareVideoAcceleration: true });

    const enabled = applyPlaybackHardwareAcceleration();

    expect(enabled).toBe(true);
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
  });

  test('disables hardware video decode when the user turns it off', () => {
    saveSettings({ hardwareVideoAcceleration: false });

    const enabled = applyPlaybackHardwareAcceleration();

    expect(enabled).toBe(false);
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('disable-accelerated-video-decode');
  });
});
