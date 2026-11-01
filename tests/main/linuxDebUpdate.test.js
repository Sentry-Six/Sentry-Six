/**
 * Linux .deb self-update: the package is installed as root, so it must match
 * latest-linux.yml, come over HTTPS, and ignore the dev override when packaged.
 */

jest.mock('electron');
jest.mock('electron-updater', () => ({ autoUpdater: { on: jest.fn(), setFeedURL: jest.fn() } }));
jest.mock('https', () => ({ get: jest.fn() }));

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const https = require('https');
const { app, ipcMain } = require('electron');
const { registerAutoUpdateIpc, linuxDebInternals } = require('../../src/main/autoUpdate');
const { clientFor, parseUpdateManifest, updateBase } = linuxDebInternals;

const VERSION = '2026.99.1';
const DEB = `SentryStudio-${VERSION}-linux-${process.arch === 'arm64' ? 'arm64' : 'amd64'}.deb`;
const MANIFEST = process.arch === 'arm64' ? 'latest-linux-arm64.yml' : 'latest-linux.yml';
const debBytes = Buffer.concat([Buffer.from('!<arch>\n'), crypto.randomBytes(4096)]);
const sha512 = buf => crypto.createHash('sha512').update(buf).digest('base64');
const manifestFor = (hash, size) =>
  `version: ${VERSION}\nfiles:\n  - url: ${DEB}\n    sha512: ${hash}\n    size: ${size}\npath: ${DEB}\nsha512: ${hash}\n`;

let routes = {};
function respond(url, callback) {
  const route = routes[url.replace(/\?.*$/, '')];
  const res = new PassThrough();
  if (!route) {
    res.statusCode = 404;
    res.headers = {};
    process.nextTick(() => { callback(res); res.end(); });
  } else if (route.redirect) {
    res.statusCode = 302;
    res.headers = { location: route.redirect };
    process.nextTick(() => { callback(res); res.end(); });
  } else {
    const body = Buffer.isBuffer(route.body) ? route.body : Buffer.from(route.body);
    res.statusCode = 200;
    res.headers = { 'content-length': String(body.length) };
    process.nextTick(() => { callback(res); res.end(body); });
  }
  const req = new EventEmitter();
  req.setTimeout = jest.fn();
  return req;
}

const handlers = {};
const originalPlatform = process.platform;

beforeAll(() => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  https.get.mockImplementation((url, options, callback) => respond(url, callback));
  registerAutoUpdateIpc({
    getMainWindow: jest.fn(() => null),
    getUpdateBranch: jest.fn(() => 'main'),
    loadSettings: jest.fn(() => ({})),
    saveSettings: jest.fn(() => true),
    checkUpdateWithTelemetry: jest.fn(),
    processApiResponse: jest.fn()
  });
  for (const [channel, handler] of ipcMain.handle.mock.calls) handlers[channel] = handler;
});

afterAll(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
});

beforeEach(() => {
  app.isPackaged = true;
  delete process.env.SENTRY_DEV_UPDATE_URL;
  delete process.env.APPIMAGE;
  const release = `https://github.com/Sentry-Six/Sentry-Six/releases/download/v${VERSION}`;
  routes = {
    'https://raw.githubusercontent.com/Sentry-Six/Sentry-Six/main/version.json': { body: JSON.stringify({ version: VERSION }) },
    [`${release}/${MANIFEST}`]: { body: manifestFor(sha512(debBytes), debBytes.length) },
    [`${release}/${DEB}`]: { redirect: `https://objects.githubusercontent.com/${DEB}` },
    [`https://objects.githubusercontent.com/${DEB}`]: { body: debBytes }
  };
});

describe('parseUpdateManifest', () => {
  test('reads the sha512 and size of the named file', () => {
    expect(parseUpdateManifest(manifestFor('abc==', 12), DEB)).toEqual({ sha512: 'abc==', size: 12 });
  });

  test('returns null when the file is not listed', () => {
    expect(parseUpdateManifest(manifestFor('abc==', 12), 'other.deb')).toBeNull();
  });
});

describe('update URLs', () => {
  test('plain http is refused', () => {
    expect(() => clientFor('http://example.com/x.deb')).toThrow(/non-HTTPS/);
  });

  test('a packaged app ignores the dev override', () => {
    process.env.SENTRY_DEV_UPDATE_URL = 'http://127.0.0.1:8099';
    expect(updateBase()).toBe('');
    expect(() => clientFor('http://127.0.0.1:8099/version.json')).toThrow(/non-HTTPS/);
  });

  test('an unpackaged app may use a loopback dev override', () => {
    app.isPackaged = false;
    process.env.SENTRY_DEV_UPDATE_URL = 'http://127.0.0.1:8099/';
    expect(updateBase()).toBe('http://127.0.0.1:8099');
    process.env.SENTRY_DEV_UPDATE_URL = 'http://example.com';
    expect(updateBase()).toBe('');
  });
});

describe('update:install on a .deb install', () => {
  test('downloads a package that matches latest-linux.yml', async () => {
    const result = await handlers['update:install']({});
    expect(result).toEqual({ success: true, needsRestart: true, isDeb: true });
  });

  test('an arm64 install verifies against latest-linux-arm64.yml', async () => {
    const originalArch = process.arch;
    Object.defineProperty(process, 'arch', { value: 'arm64' });
    try {
      const release = `https://github.com/Sentry-Six/Sentry-Six/releases/download/v${VERSION}`;
      const armDeb = `SentryStudio-${VERSION}-linux-arm64.deb`;
      routes[`${release}/latest-linux-arm64.yml`] = { body: manifestFor(sha512(debBytes), debBytes.length).replaceAll(DEB, armDeb) };
      routes[`${release}/${armDeb}`] = { body: debBytes };
      const result = await handlers['update:install']({});
      expect(result).toEqual({ success: true, needsRestart: true, isDeb: true });
    } finally {
      Object.defineProperty(process, 'arch', { value: originalArch });
    }
  });

  test('rejects a package whose hash does not match', async () => {
    const release = `https://github.com/Sentry-Six/Sentry-Six/releases/download/v${VERSION}`;
    routes[`${release}/${MANIFEST}`] = { body: manifestFor(sha512(Buffer.from('other')), debBytes.length) };
    const result = await handlers['update:install']({});
    expect(result).toEqual({ success: false, error: 'Update package failed verification' });
  });

  test('refuses to install without a manifest entry', async () => {
    const release = `https://github.com/Sentry-Six/Sentry-Six/releases/download/v${VERSION}`;
    delete routes[`${release}/${MANIFEST}`];
    const result = await handlers['update:install']({});
    expect(result).toEqual({ success: false, error: 'Could not verify the update package' });
  });

  test('refuses a redirect to plain http', async () => {
    const release = `https://github.com/Sentry-Six/Sentry-Six/releases/download/v${VERSION}`;
    routes[`${release}/${DEB}`] = { redirect: `http://objects.githubusercontent.com/${DEB}` };
    const result = await handlers['update:install']({});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/non-HTTPS/);
  });
});
