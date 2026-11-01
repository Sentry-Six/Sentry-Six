const path = require('path');
const { resolveUserDataDir } = require('../../src/main/userDataDir');

const appData = path.join(path.sep, 'appdata');
const current = path.join(appData, 'Sentry Studio');
const legacy = path.join(appData, 'Sentry-Studio');
const has = (...files) => (file) => files.includes(file);

describe('resolveUserDataDir', () => {
  test('keeps the current folder when it already has settings', () => {
    expect(resolveUserDataDir({ appData, current, exists: has(path.join(current, 'settings.json'), path.join(legacy, 'settings.json')) })).toBe(current);
  });
  test('uses the legacy folder when only it has settings', () => {
    expect(resolveUserDataDir({ appData, current, exists: has(path.join(legacy, 'settings.json')) })).toBe(legacy);
  });
  test('fresh installs use the current folder', () => {
    expect(resolveUserDataDir({ appData, current, exists: has() })).toBe(current);
  });
  test('an explicit --user-data-dir outside appData is kept', () => {
    const custom = path.join(path.sep, 'tmp', 'profile');
    expect(resolveUserDataDir({ appData, current: custom, exists: has(path.join(legacy, 'settings.json')) })).toBe(custom);
  });
  test('a current folder that is the legacy one stays', () => {
    expect(resolveUserDataDir({ appData, current: legacy, exists: has() })).toBe(legacy);
  });
});
