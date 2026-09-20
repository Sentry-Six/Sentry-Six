'use strict';

jest.mock('electron');

describe('converter preload API', () => {
  let api;
  let ipcRenderer;

  beforeEach(() => {
    jest.resetModules();
    const electron = require('electron');
    electron.contextBridge.exposeInMainWorld.mockClear();
    electron.ipcRenderer.invoke.mockClear();
    electron.ipcRenderer.on.mockClear();
    electron.ipcRenderer.removeListener.mockClear();
    require('../../src/preload');
    ipcRenderer = electron.ipcRenderer;
    api = electron.contextBridge.exposeInMainWorld.mock.calls[0][1];
  });

  test('exposes named converter operations without a generic converter invoke', async () => {
    await api.chooseConverterFolder('source', 'D:\\TeslaCam');
    await api.startConverter({ codec: 'h265' });
    await api.getCurrentConverterJob();
    await api.pauseConverter('job-1');
    await api.resumeConverter('job-1');
    await api.cancelConverter('job-1');
    await api.retryFailedConverter('job-1');
    await api.dismissConverterSummary('job-1');
    await api.getConverterCapabilities();

    expect(ipcRenderer.invoke.mock.calls).toEqual([
      ['converter:chooseFolder', { purpose: 'source', defaultPath: 'D:\\TeslaCam' }],
      ['converter:start', { codec: 'h265' }],
      ['converter:getCurrent'],
      ['converter:pause', { jobId: 'job-1' }],
      ['converter:resume', { jobId: 'job-1' }],
      ['converter:cancel', { jobId: 'job-1' }],
      ['converter:retryFailed', { jobId: 'job-1' }],
      ['converter:dismissSummary', { jobId: 'job-1' }],
      ['converter:getCapabilities']
    ]);
    expect(api.converterInvoke).toBeUndefined();
    expect(api.invoke).toBeUndefined();
  });

  test('returns an idempotent progress unsubscriber scoped to converter progress', async () => {
    const callback = jest.fn();
    const unsubscribe = api.onConverterProgress(callback);
    expect(typeof unsubscribe).toBe('function');
    expect(ipcRenderer.on).toHaveBeenCalledWith('converter:progress', expect.any(Function));
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('converter:subscribeProgress');

    const wrapper = ipcRenderer.on.mock.calls[0][1];
    wrapper({}, { jobId: 'job-1', revision: 1, snapshot: {} });
    expect(callback).toHaveBeenCalledWith({ jobId: 'job-1', revision: 1, snapshot: {} });

    unsubscribe();
    unsubscribe();
    expect(ipcRenderer.removeListener).toHaveBeenCalledTimes(1);
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith('converter:progress', wrapper);
    expect(ipcRenderer.invoke.mock.calls.filter(([channel]) => channel === 'converter:unsubscribeProgress')).toHaveLength(1);
  });

  test('keeps the main subscription until the last preload callback unsubscribes', () => {
    const first = jest.fn();
    const second = jest.fn();
    const unsubscribeFirst = api.onConverterProgress(first);
    const unsubscribeSecond = api.onConverterProgress(second);

    expect(ipcRenderer.invoke.mock.calls.filter(([channel]) => channel === 'converter:subscribeProgress')).toHaveLength(1);
    const firstWrapper = ipcRenderer.on.mock.calls[0][1];
    const secondWrapper = ipcRenderer.on.mock.calls[1][1];
    firstWrapper({}, { jobId: 'job-1', revision: 1, snapshot: { state: 'encoding' } });
    secondWrapper({}, { jobId: 'job-1', revision: 1, snapshot: { state: 'encoding' } });
    firstWrapper({}, { jobId: 'job-1', revision: 2, snapshot: { state: 'encoding' } });
    secondWrapper({}, { jobId: 'job-1', revision: 2, snapshot: { state: 'encoding' } });
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
    expect(ipcRenderer.invoke.mock.calls.filter(([channel]) => channel === 'converter:subscribeProgress')).toHaveLength(1);

    unsubscribeFirst();
    expect(ipcRenderer.invoke.mock.calls.filter(([channel]) => channel === 'converter:unsubscribeProgress')).toHaveLength(0);
    secondWrapper({}, { jobId: 'job-1', revision: 3, snapshot: { state: 'encoding' } });
    expect(second).toHaveBeenCalledTimes(3);

    unsubscribeSecond();
    expect(ipcRenderer.invoke.mock.calls.filter(([channel]) => channel === 'converter:unsubscribeProgress')).toHaveLength(1);
  });

  test('rejects a non-function progress callback before registering', () => {
    expect(() => api.onConverterProgress('not-a-function')).toThrow(TypeError);
    expect(ipcRenderer.on).not.toHaveBeenCalled();
  });
});
