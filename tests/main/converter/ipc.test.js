'use strict';

const { EventEmitter } = require('events');
const path = require('path');

const { registerConverterIpc } = require('../../../src/main/converter/ipc');

function directoryStat() {
  return { isDirectory: () => true };
}

function createFs(entries = {}) {
  const values = new Map(Object.entries(entries).map(([key, value]) => [path.win32.normalize(key), value]));
  return {
    async lstat(target) {
      const entry = values.get(path.win32.normalize(target));
      if (!entry) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return entry.stat || directoryStat();
    },
    async realpath(target) {
      const entry = values.get(path.win32.normalize(target));
      if (!entry) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return entry.realpath || path.win32.normalize(target);
    }
  };
}

function createIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle: jest.fn((channel, handler) => {
      if (handlers.has(channel)) throw new Error(`duplicate handler: ${channel}`);
      handlers.set(channel, handler);
    }),
    removeHandler: jest.fn((channel) => handlers.delete(channel))
  };
}

function createSender() {
  const sender = new EventEmitter();
  sender.send = jest.fn();
  sender.isDestroyed = jest.fn(() => false);
  return sender;
}

function createService() {
  let listener = null;
  const snapshots = [];
  return {
    snapshots,
    start: jest.fn(async () => 'job-1'),
    list: jest.fn(async () => snapshots),
    pause: jest.fn(async (id) => ({ id, state: 'paused', revision: 2 })),
    resume: jest.fn(async (id) => ({ id, state: 'waiting', revision: 3 })),
    cancel: jest.fn(async (id) => ({ id, state: 'cancelled', revision: 4 })),
    retryFailed: jest.fn(async (id) => ({ id, state: 'waiting', revision: 5 })),
    dismissSummary: jest.fn(async (id) => ({ id, state: 'completed', revision: 6, summary: null, summaryDismissed: true })),
    subscribe: jest.fn((next) => {
      listener = next;
      return jest.fn(() => { listener = null; });
    }),
    emit(event) { listener?.(event); }
  };
}

function setup(overrides = {}) {
  const ipcMain = createIpcMain();
  const service = createService();
  const dialog = {
    showOpenDialog: jest.fn(async () => ({ canceled: false, filePaths: ['D:\\TeslaCam'] }))
  };
  const fs = createFs({
    'D:\\TeslaCam': { realpath: 'D:\\TeslaCam' },
    'E:\\Converted': { realpath: 'E:\\Converted' },
    'E:\\FutureParent': { realpath: 'E:\\FutureParent' },
    'D:\\TeslaCam\\inside': { realpath: 'D:\\TeslaCam\\inside' },
    'D:\\Alias': { realpath: 'D:\\TeslaCam' }
  });
  const registration = registerConverterIpc({
    ipcMain,
    dialog,
    service,
    fs,
    pathApi: path.win32,
    platform: 'win32',
    capabilities: {
      separatePublication: 'hardlink-cleanup-pending',
      ownershipCleanup: 'unavailable',
      replacement: 'unavailable',
      destinationContainment: 'pathname-revalidated-non-atomic'
    },
    ...overrides
  });
  const sender = createSender();
  const invoke = (channel, payload, selectedSender = sender) => {
    const handler = ipcMain.handlers.get(channel);
    if (!handler) throw new Error(`missing handler: ${channel}`);
    return handler({ sender: selectedSender }, payload);
  };
  return { ipcMain, service, dialog, registration, sender, invoke };
}

const CONFIG = Object.freeze({
  sourceRoot: 'D:\\TeslaCam',
  destinationRoot: 'E:\\FutureParent\\Converted',
  codec: 'h265',
  profileId: 'balanced',
  networkMode: 'auto',
  outputMode: 'separate',
  includedGroups: ['RecentClips', 'SavedClips', 'SentryClips'],
  replacementConfirmed: false
});

const GROUP_ORDERS = [
  ['SavedClips', 'SentryClips', 'RecentClips'],
  ['SavedClips', 'RecentClips', 'SentryClips'],
  ['SentryClips', 'SavedClips', 'RecentClips'],
  ['SentryClips', 'RecentClips', 'SavedClips'],
  ['RecentClips', 'SavedClips', 'SentryClips'],
  ['RecentClips', 'SentryClips', 'SavedClips']
];

describe('converter IPC', () => {
  test('registers only the named converter handlers and registration is idempotent', () => {
    const h = setup();
    expect([...h.ipcMain.handlers.keys()].sort()).toEqual([
      'converter:cancel',
      'converter:chooseFolder',
      'converter:dismissSummary',
      'converter:getCapabilities',
      'converter:getCurrent',
      'converter:pause',
      'converter:resume',
      'converter:retryFailed',
      'converter:start',
      'converter:subscribeProgress',
      'converter:unsubscribeProgress'
    ]);

    const again = registerConverterIpc({ ipcMain: h.ipcMain, dialog: h.dialog, service: h.service });
    expect(again).toBe(h.registration);
    expect(h.ipcMain.handle).toHaveBeenCalledTimes(11);
  });

  test('chooses and canonicalizes an absolute directory with a bounded purpose', async () => {
    const h = setup();
    const result = await h.invoke('converter:chooseFolder', { purpose: 'source', defaultPath: 'D:\\TeslaCam' });

    expect(result).toEqual({ ok: true, value: 'D:\\TeslaCam' });
    expect(h.dialog.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
      properties: ['openDirectory'], defaultPath: 'D:\\TeslaCam'
    }));
  });

  test.each([
    [{ purpose: 'archive' }, 'INVALID_REQUEST'],
    [{ purpose: 'source', defaultPath: 'relative' }, 'INVALID_PATH'],
    [{ purpose: 'source', padding: 'x'.repeat(70_000) }, 'PAYLOAD_TOO_LARGE']
  ])('rejects malformed folder requests without opening a dialog', async (payload, code) => {
    const h = setup();
    await expect(h.invoke('converter:chooseFolder', payload)).resolves.toEqual({
      ok: false, error: { code, retryable: false }
    });
    expect(h.dialog.showOpenDialog).not.toHaveBeenCalled();
  });

  test('rejects accessor-backed payloads without invoking renderer-controlled getters', async () => {
    const h = setup();
    const getter = jest.fn(() => 'source');
    const payload = {};
    Object.defineProperty(payload, 'purpose', { enumerable: true, get: getter });

    await expect(h.invoke('converter:chooseFolder', payload)).resolves.toEqual({
      ok: false, error: { code: 'INVALID_REQUEST', retryable: false }
    });
    expect(getter).not.toHaveBeenCalled();
    expect(h.dialog.showOpenDialog).not.toHaveBeenCalled();
  });

  test('validates and canonicalizes a future destination before starting', async () => {
    const h = setup();
    const result = await h.invoke('converter:start', CONFIG);

    expect(result).toEqual({ ok: true, value: { jobId: 'job-1' } });
    expect(h.service.start).toHaveBeenCalledWith({
      ...CONFIG,
      sourceRoot: 'D:\\TeslaCam',
      destinationRoot: 'E:\\FutureParent\\Converted'
    });
  });

  test.each(GROUP_ORDERS.map((order) => [order]))('accepts group order permutation %#', async (groupOrder) => {
    const h = setup();
    await expect(h.invoke('converter:start', { ...CONFIG, groupOrder })).resolves.toMatchObject({ ok: true });
    expect(h.service.start).toHaveBeenCalledWith(expect.objectContaining({ groupOrder }));
  });

  test('keeps group order optional for older IPC clients', async () => {
    const h = setup();
    await expect(h.invoke('converter:start', CONFIG)).resolves.toMatchObject({ ok: true });
  });

  test.each([
    'not-an-array',
    ['SavedClips', 'SavedClips', 'RecentClips'],
    ['SavedClips', 'SentryClips'],
    ['SavedClips', 'SentryClips', 'OtherClips']
  ].map((order) => [order]))('rejects invalid group order %#', async (groupOrder) => {
    const h = setup();
    await expect(h.invoke('converter:start', { ...CONFIG, groupOrder })).resolves.toEqual({
      ok: false, error: { code: 'INVALID_GROUP_ORDER', retryable: false }
    });
  });

  test('rejects an unsafe job ID returned by the service', async () => {
    const h = setup();
    h.service.start.mockResolvedValue('../job');

    await expect(h.invoke('converter:start', CONFIG)).resolves.toEqual({
      ok: false, error: { code: 'INVALID_JOB_ID', retryable: false }
    });
  });

  test.each([
    [{ codec: 'vp9' }, 'INVALID_CODEC'],
    [{ profileId: 'tiny' }, 'INVALID_PROFILE'],
    [{ networkMode: 'fast' }, 'INVALID_NETWORK_MODE'],
    [{ outputMode: 'overwrite' }, 'INVALID_OUTPUT_MODE'],
    [{ includedGroups: [] }, 'INVALID_GROUP_SELECTION'],
    [{ includedGroups: ['RecentClips', 'Other'] }, 'INVALID_GROUP_SELECTION'],
    [{ sourceRoot: 'TeslaCam' }, 'INVALID_PATH'],
    [{ destinationRoot: 'Converted' }, 'INVALID_PATH'],
    [{ replacementConfirmed: true }, 'INVALID_REPLACEMENT_CONFIRMATION']
  ])('rejects invalid start config %#', async (change, code) => {
    const h = setup();
    const result = await h.invoke('converter:start', { ...CONFIG, ...change });
    expect(result).toEqual({ ok: false, error: { code, retryable: false } });
    expect(h.service.start).not.toHaveBeenCalled();
  });

  test.each([
    { destinationRoot: 'D:\\TeslaCam' },
    { destinationRoot: 'D:\\TeslaCam\\inside' },
    { sourceRoot: 'D:\\TeslaCam\\inside', destinationRoot: 'D:\\TeslaCam' },
    { destinationRoot: 'D:\\Alias\\future' }
  ])('rejects lexical and canonical source/destination overlap %#', async (change) => {
    const h = setup();
    const result = await h.invoke('converter:start', { ...CONFIG, ...change });
    expect(result).toEqual({ ok: false, error: { code: 'PATH_OVERLAP', retryable: false } });
    expect(h.service.start).not.toHaveBeenCalled();
  });

  test('requires exact replacement confirmation and reports unavailable capability before service mutation', async () => {
    const h = setup();
    const unconfirmed = await h.invoke('converter:start', {
      ...CONFIG, destinationRoot: null, outputMode: 'replace', replacementConfirmed: false
    });
    expect(unconfirmed).toEqual({
      ok: false, error: { code: 'REPLACEMENT_CONFIRMATION_REQUIRED', retryable: false }
    });

    const unavailable = await h.invoke('converter:start', {
      ...CONFIG, destinationRoot: null, outputMode: 'replace', replacementConfirmed: true
    });
    expect(unavailable).toEqual({
      ok: false, error: { code: 'REPLACEMENT_UNAVAILABLE', retryable: false }
    });
    expect(h.service.start).not.toHaveBeenCalled();
  });

  test('returns the active or latest visible job and redacts private or raw fields', async () => {
    const h = setup();
    h.service.snapshots.push({
      id: 'job-old', state: 'completed', revision: 4, updatedAt: 5, summaryDismissed: false,
      config: { ...CONFIG }, items: [], counters: {}, summary: { files: 1 }
    });
    h.service.snapshots.push({
      id: 'job-1', state: 'encoding', revision: 9, updatedAt: 10,
      config: { ...CONFIG }, items: [{ id: 'item-1', state: 'processing', sourcePath: 'D:\\TeslaCam\\clip.mp4', telemetry: 'secret' }],
      counters: {}, ownedPaths: { encodedCandidate: 'C:\\private.mp4' }, stderr: 'secret runner output'
    });

    const result = await h.invoke('converter:getCurrent');
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({ id: 'job-1', state: 'encoding', revision: 9 });
    expect(JSON.stringify(result)).not.toMatch(/secret|ownedPaths|stderr|telemetry/i);
  });

  test.each([
    ['converter:pause', 'pause'],
    ['converter:resume', 'resume'],
    ['converter:cancel', 'cancel'],
    ['converter:retryFailed', 'retryFailed'],
    ['converter:dismissSummary', 'dismissSummary']
  ])('validates a safe job ID for %s', async (channel, method) => {
    const h = setup();
    const valid = await h.invoke(channel, { jobId: 'job-1' });
    expect(valid.ok).toBe(true);
    expect(h.service[method]).toHaveBeenCalledWith('job-1');

    for (const jobId of ['../job', 'Job-1', 'con', 'a'.repeat(129)]) {
      await expect(h.invoke(channel, { jobId })).resolves.toEqual({
        ok: false, error: { code: 'INVALID_JOB_ID', retryable: false }
      });
    }
  });

  test('returns stable structured service errors without leaking exception text', async () => {
    const h = setup();
    h.service.pause.mockRejectedValue(Object.assign(new Error('D:\\secret telemetry bytes'), {
      code: 'JOB_NOT_PAUSED', retryable: true, stack: 'raw stack'
    }));
    const result = await h.invoke('converter:pause', { jobId: 'job-1' });
    expect(result).toEqual({ ok: false, error: { code: 'JOB_NOT_PAUSED', retryable: true } });
    expect(JSON.stringify(result)).not.toMatch(/secret|telemetry|stack/i);
  });

  test('maintains one progress subscription per sender and removes it on destroyed/unsubscribe/unregister', async () => {
    const h = setup();
    await h.invoke('converter:subscribeProgress');
    await h.invoke('converter:subscribeProgress');
    h.service.emit({
      type: 'snapshot', jobId: 'job-1', revision: 7,
      snapshot: { id: 'job-1', state: 'encoding', revision: 7, config: CONFIG, items: [], counters: {}, telemetry: 'secret' }
    });
    expect(h.sender.send).toHaveBeenCalledTimes(1);
    expect(h.sender.send).toHaveBeenCalledWith('converter:progress', expect.objectContaining({
      jobId: 'job-1', revision: 7, snapshot: expect.objectContaining({ id: 'job-1' })
    }));
    expect(JSON.stringify(h.sender.send.mock.calls)).not.toMatch(/secret|telemetry/i);

    h.sender.emit('destroyed');
    h.service.emit({ type: 'snapshot', jobId: 'job-1', revision: 8, snapshot: { id: 'job-1', state: 'waiting', revision: 8 } });
    expect(h.sender.send).toHaveBeenCalledTimes(1);

    const second = createSender();
    await h.invoke('converter:subscribeProgress', undefined, second);
    await h.invoke('converter:unsubscribeProgress', undefined, second);
    h.service.emit({ type: 'snapshot', jobId: 'job-1', revision: 9, snapshot: { id: 'job-1', state: 'waiting', revision: 9 } });
    expect(second.send).not.toHaveBeenCalled();

    await h.invoke('converter:subscribeProgress', undefined, second);
    h.registration.unregister();
    h.service.emit({ type: 'snapshot', jobId: 'job-1', revision: 10, snapshot: { id: 'job-1', state: 'waiting', revision: 10 } });
    expect(second.send).not.toHaveBeenCalled();
    expect(h.service.subscribe.mock.results[0].value).toHaveBeenCalledTimes(1);
    expect(h.ipcMain.handlers.size).toBe(0);
  });

  test('reference-counts duplicate subscriptions so one unsubscribe keeps the sender live', async () => {
    const h = setup();
    await h.invoke('converter:subscribeProgress');
    await h.invoke('converter:subscribeProgress');

    await h.invoke('converter:unsubscribeProgress');
    h.service.emit({
      type: 'snapshot', jobId: 'job-1', revision: 1,
      snapshot: { id: 'job-1', state: 'encoding', revision: 1 }
    });
    expect(h.sender.send).toHaveBeenCalledTimes(1);

    await h.invoke('converter:unsubscribeProgress');
    h.service.emit({
      type: 'snapshot', jobId: 'job-1', revision: 2,
      snapshot: { id: 'job-1', state: 'encoding', revision: 2 }
    });
    expect(h.sender.send).toHaveBeenCalledTimes(1);
  });

  test('bridges bounded service progress through the canonical converter progress payload', async () => {
    const h = setup();
    await h.invoke('converter:subscribeProgress');

    const progress = {
      outTimeUs: 500_000,
      phase: 'continue',
      raw: 'private process output',
      diagnostics: { command: 'ffmpeg -i D:\\private\\clip.mp4' },
      bytes: Buffer.from('private bytes')
    };
    const getter = jest.fn(() => 'must not be read');
    Object.defineProperty(progress, 'secret', { enumerable: true, get: getter });

    h.service.emit({
      type: 'progress',
      jobId: 'job-1',
      revision: 7,
      progress
    });

    expect(h.sender.send).toHaveBeenCalledWith('converter:progress', {
      jobId: 'job-1',
      revision: 7,
      snapshot: {
        id: 'job-1',
        revision: 7,
        progress: { outTimeUs: 500_000, phase: 'continue' }
      }
    });
    expect(getter).not.toHaveBeenCalled();
    expect(JSON.stringify(h.sender.send.mock.calls)).not.toMatch(/private|diagnostics|bytes|secret|raw/i);

    h.service.emit({
      type: 'progress', jobId: 'job-1', revision: 8,
      progress: { outTimeUs: -1, phase: 'continue' }
    });
    h.service.emit({
      type: 'progress', jobId: 'job-1', revision: 9,
      progress: { outTimeUs: Number.MAX_SAFE_INTEGER + 1, phase: 'continue' }
    });
    h.service.emit({
      type: 'progress', jobId: 'job-1', revision: 10,
      progress: { outTimeUs: 1, phase: 'private-phase' }
    });
    expect(h.sender.send).toHaveBeenCalledTimes(1);
  });

  test('keeps a live sender registered after one transient send failure', async () => {
    const h = setup();
    await h.invoke('converter:subscribeProgress');
    h.sender.send.mockImplementationOnce(() => { throw new Error('transient renderer backpressure'); });

    h.service.emit({
      type: 'progress', jobId: 'job-1', revision: 1,
      progress: { outTimeUs: 1, phase: 'continue' }
    });
    h.service.emit({
      type: 'progress', jobId: 'job-1', revision: 2,
      progress: { outTimeUs: 2, phase: 'end' }
    });

    expect(h.sender.send).toHaveBeenCalledTimes(2);
    expect(h.sender.send).toHaveBeenLastCalledWith('converter:progress', expect.objectContaining({ revision: 2 }));
  });

  test('bounds large progress snapshots while preserving counters and active-item paths', async () => {
    const h = setup();
    await h.invoke('converter:subscribeProgress');
    const items = Array.from({ length: 1_000 }, (_, index) => ({
      id: `item-${index}`,
      state: index === 999 ? 'processing'
        : index >= 994 ? 'failed'
          : index >= 992 ? 'completed'
            : 'queued',
      ...(index === 992 ? { resultCode: 'completed-cleanup-pending' } : {}),
      sourcePath: `D:\\TeslaCam\\${String(index).padStart(4, '0')}-${'x'.repeat(700)}.mp4`
    }));
    h.service.emit({
      type: 'snapshot', jobId: 'job-1', revision: 12,
      snapshot: {
        id: 'job-1', state: 'encoding', revision: 12, activeItemId: 'item-999',
        config: CONFIG, items, counters: { files: 4 }
      }
    });

    expect(h.sender.send).toHaveBeenCalledTimes(1);
    const snapshot = h.sender.send.mock.calls[0][1].snapshot;
    expect(snapshot.counters).toEqual({ files: 4 });
    expect(snapshot.itemCount).toBe(1_000);
    expect(snapshot.itemsTruncated).toBe(true);
    expect(snapshot.itemStateCounts).toEqual({
      queued: 992,
      completed: 2,
      skipped: 0,
      failed: 5
    });
    expect(snapshot.cleanupPendingCount).toBe(1);
    expect(snapshot.items.length).toBeLessThanOrEqual(256);
    expect(snapshot.items).toContainEqual(expect.objectContaining({ id: 'item-999', sourcePath: expect.any(String) }));
  });

  test('publishes an explicit bounded capability status', async () => {
    const h = setup();
    await expect(h.invoke('converter:getCapabilities')).resolves.toEqual({
      ok: true,
      value: {
        separatePublication: 'hardlink-cleanup-pending',
        ownershipCleanup: 'unavailable',
        replacement: 'unavailable',
        destinationContainment: 'pathname-revalidated-non-atomic'
      }
    });
  });

  test.each([
    'converter:getCurrent',
    'converter:getCapabilities',
    'converter:subscribeProgress',
    'converter:unsubscribeProgress'
  ])('rejects unexpected payloads on no-argument channel %s', async (channel) => {
    const h = setup();

    await expect(h.invoke(channel, { ignored: true })).resolves.toEqual({
      ok: false, error: { code: 'INVALID_REQUEST', retryable: false }
    });
  });
});
