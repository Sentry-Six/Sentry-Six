// The app's product name changed from "Sentry-Studio" to "Sentry Studio",
// which moves Electron's userData folder (settings, caches, browser storage).
// Keep using the old folder when it holds the settings and the new one does
// not, so stable installs updating across the rename keep everything.
// Must run before any module reads app.getPath('userData').
const fs = require('fs');
const path = require('path');

const LEGACY_NAME = 'Sentry-Studio';

function resolveUserDataDir({ appData, current, exists }) {
  // Only the default location moves; an explicit --user-data-dir is kept.
  if (path.dirname(current) !== appData) return current;
  const legacy = path.join(appData, LEGACY_NAME);
  if (legacy === current) return current;
  if (exists(path.join(current, 'settings.json'))) return current;
  if (exists(path.join(legacy, 'settings.json'))) return legacy;
  return current;
}

function useLegacyUserDataIfNeeded(app) {
  const current = app.getPath('userData');
  const dir = resolveUserDataDir({ appData: app.getPath('appData'), current, exists: fs.existsSync });
  if (dir !== current) app.setPath('userData', dir);
  return dir;
}

module.exports = { resolveUserDataDir, useLegacyUserDataIfNeeded };
