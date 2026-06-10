// Mock electron module for testing
const app = {
  getPath: jest.fn((name) => {
    if (name === 'userData') return '/tmp/sentry-test-userdata';
    if (name === 'appData') return '/tmp/sentry-test-appdata';
    return '/tmp/sentry-test';
  }),
  getVersion: jest.fn(() => '2026.12.13'),
  getAppPath: jest.fn(() => '/tmp/sentry-test-app'),
  isPackaged: false,
  quit: jest.fn()
};

const ipcMain = {
  handle: jest.fn(),
  on: jest.fn(),
  removeHandler: jest.fn()
};

const ipcRenderer = {
  invoke: jest.fn(),
  on: jest.fn(),
  removeListener: jest.fn(),
  removeAllListeners: jest.fn()
};

const contextBridge = {
  exposeInMainWorld: jest.fn()
};

const shell = {
  openExternal: jest.fn(),
  openPath: jest.fn()
};

const BrowserWindow = jest.fn();

module.exports = {
  app,
  ipcMain,
  ipcRenderer,
  contextBridge,
  shell,
  BrowserWindow
};
