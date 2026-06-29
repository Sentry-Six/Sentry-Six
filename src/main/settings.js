const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// File-based settings storage for reliable persistence
const settingsPath = path.join(app.getPath('userData'), 'settings.json');

// In-memory cache — loaded once from disk, then served from RAM
let _settingsCache = null;

function loadSettings() {
  if (_settingsCache !== null) return _settingsCache;
  try {
    if (fs.existsSync(settingsPath)) {
      const data = fs.readFileSync(settingsPath, 'utf-8');
      _settingsCache = JSON.parse(data);
      return _settingsCache;
    }
  } catch (err) {
    console.error('Failed to load settings:', err);
  }
  _settingsCache = {};
  return _settingsCache;
}

function saveSettings(settings) {
  _settingsCache = settings; // Update cache immediately
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('Failed to save settings:', err);
    return false;
  }
}

// Apply the playback hardware-acceleration preference as a Chromium switch.
// MUST run before app 'ready'. Multi-cam playback decodes up to 6 <video>
// elements at once; on low-end integrated GPUs (e.g. Intel HD Graphics 630)
// the hardware video decoder runs out of concurrent decode sessions and all
// but one stream freeze. When the user turns hardware video acceleration off
// we force software video decoding. Default (setting absent) keeps it on so
// existing users are unaffected.
// Returns true if hardware decoding stays enabled, false if it was disabled.
function applyPlaybackHardwareAcceleration() {
  const settings = loadSettings();
  if (settings.hardwareVideoAcceleration === false) {
    app.commandLine.appendSwitch('disable-accelerated-video-decode');
    return false;
  }
  return true;
}

function registerSettingsIpc() {
  ipcMain.handle('settings:get', async (event, key) => {
    const settings = loadSettings();
    return settings[key];
  });

  ipcMain.handle('settings:set', async (event, key, value) => {
    const settings = loadSettings();
    settings[key] = value;
    return saveSettings(settings);
  });
}

module.exports = { settingsPath, loadSettings, saveSettings, registerSettingsIpc, applyPlaybackHardwareAcceleration };
