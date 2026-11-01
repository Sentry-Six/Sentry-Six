jest.mock('electron');

const { EventEmitter } = require('events');
const { createMinimapRenderer } = require('../../src/main/minimap');

function fakeWindow() {
  const webContents = new EventEmitter();
  webContents.id = 7;
  webContents.session = {
    webRequest: { onBeforeSendHeaders: jest.fn() }
  };
  webContents.send = jest.fn();
  return {
    webContents,
    loadFile: jest.fn(),
    destroy: jest.fn(),
    isDestroyed: jest.fn(() => false)
  };
}

test('missing minimap renderer destroys its partially created window', async () => {
  const win = fakeWindow();

  await expect(createMinimapRenderer(320, 180, {
    createWindow: () => win,
    rendererExists: () => false,
    rendererPath: '/missing.html'
  })).rejects.toThrow('Minimap renderer not found');

  expect(win.destroy).toHaveBeenCalledTimes(1);
});

test('did-fail-load destroys the hidden minimap window', async () => {
  const win = fakeWindow();
  const result = createMinimapRenderer(320, 180, {
    createWindow: () => win,
    rendererExists: () => true,
    rendererPath: '/renderer.html'
  });

  win.webContents.emit('did-fail-load', {}, -1, 'decode failed');

  await expect(result).rejects.toThrow('decode failed');
  expect(win.destroy).toHaveBeenCalledTimes(1);
});

test('renderer load timeout destroys the hidden minimap window', async () => {
  jest.useFakeTimers();
  const win = fakeWindow();
  const result = createMinimapRenderer(320, 180, {
    createWindow: () => win,
    rendererExists: () => true,
    rendererPath: '/renderer.html'
  });

  jest.advanceTimersByTime(15000);

  await expect(result).rejects.toThrow('Minimap renderer load timeout');
  expect(win.destroy).toHaveBeenCalledTimes(1);
  jest.useRealTimers();
});
