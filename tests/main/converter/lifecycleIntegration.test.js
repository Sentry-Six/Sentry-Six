'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createConverterRuntime, createConverterLifecycle, startConverterBeforeWindow } = require('../../../src/main/converter/runtime');
const { createConverterJobService } = require('../../../src/main/converter/jobService');
const { registerConverterIpc } = require('../../../src/main/converter/ipc');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('lifecycle waited for unfinished work')), 1500);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture({ state = 'waiting', pendingInspection = false, failInspection = false, backgroundFailure = false, count = 1 } = {}) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sentry-six-lifecycle-'));
  const sourceRoot = path.join(root, 'source');
  const destinationRoot = path.join(root, 'destination');
  await Promise.all([fs.promises.mkdir(sourceRoot), fs.promises.mkdir(destinationRoot)]);
  const sourcePath = path.join(sourceRoot, 'clip.mp4');
  const original = Buffer.from('Disposable synthetic source; encoder output is deliberately pending.');
  await fs.promises.writeFile(sourcePath, original);
  const inspectionStarted = deferred();
  const inspection = deferred();
  const networkStarted = deferred();
  const networkCheck = deferred();
  const encoderStarted = deferred();
  const children = [];
  const observedSignals = [];
  const errors = [];
  const backgroundFailed = deferred();
  const fsProxy = new Proxy(fs.promises, { get(target, key) {
    if (key === 'lstat') return async (...args) => {
      if (args[0] === path.join(destinationRoot, 'RecentClips', 'clip.mp4') && (pendingInspection || failInspection)) {
        inspectionStarted.resolve();
        if (failInspection) throw Object.assign(new Error('inspection denied'), { code: 'EACCES' });
        return inspection.promise;
      }
      return target.lstat(...args);
    };
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const runtime = await createConverterRuntime({
    userDataPath: path.join(root, 'user-data'), tempPath: path.join(root, 'temp'),
    ffmpegPath: path.join(root, 'ffmpeg'), ffprobePath: path.join(root, 'ffprobe'),
    fs: fsProxy, pathApi: path, platform: process.platform,
    onError: error => { errors.push(error); backgroundFailed.resolve(); },
    network: { isRetryable: () => true, checkPath: (_target, options) => {
      observedSignals.push(options.signal); networkStarted.resolve(); return networkCheck.promise;
    } },
    // Keep store, recovery inspector, service, transactions and child lifecycle real.
    // Only media inspection/planning and the external encoder are controlled boundaries.
    factories: {
      createEncoderPlanner: () => ({ select: async () => ({ family: 'h265', codec: 'libx265', hardware: false }),
        selectCpuFallback: async () => { throw new Error('unexpected fallback'); } }),
      createConverterJobService: deps => createConverterJobService({ ...deps,
        store: backgroundFailure ? { ...deps.store, transition: async (id, patch) => {
          if (patch.state === 'waiting') throw Object.assign(new Error('persisted transition unavailable'), { code: 'EIO' });
          return deps.store.transition(id, patch);
        } } : deps.store,
        inspectVideo: async () => ({ codec: 'h264', durationSeconds: 10 }),
        readTimeline: async () => ({ samples: [], events: [] }) })
    },
    spawn: (_command, args) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('close', null, 'SIGTERM')); return true; };
      // A real partial candidate proves shutdown retains persisted ownership.
      fs.writeFileSync(args.at(-1), Buffer.from('synthetic partial encode'));
      children.push(child); encoderStarted.resolve(); return child;
    }
  });
  for (let index = 0; index < count; index++) {
    await runtime.store.create({ id: `job-${index}`, state, discoveryComplete: true,
      config: { sourceRoot, destinationRoot, includedGroups: ['RecentClips'], codec: 'h265',
        profileId: 'balanced', networkMode: 'direct', outputMode: 'separate', replacementConfirmed: false },
      activeItemId: state === 'encoding' ? 'item-1' : null,
      ...(state === 'paused_network' ? { recovery: { fromState: 'paused_network', action: 'resume-network',
        pathRole: 'discovery', resumeState: 'waiting' } } : {}),
      items: [{ id: 'item-1', state: state === 'encoding' ? 'processing' : 'queued', kind: 'video',
        group: 'RecentClips', eventId: null, relativePath: 'RecentClips/clip.mp4', sourcePath,
        sourceBytes: original.length, mtimeMs: 1, timestampKey: 'clip', camera: 'front' }]
    });
  }
  const handlers = new Map();
  const ipcMain = { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) };
  const app = { quit: jest.fn() };
  const createWindow = jest.fn();
  const lifecycle = createConverterLifecycle({ app, onError: error => { errors.push(error); },
    initialize: async ({ retainRuntime } = {}) => {
    retainRuntime?.(runtime);
    await runtime.start();
    registerConverterIpc({ ipcMain, dialog: { showOpenDialog: async () => ({ canceled: true }) }, service: runtime.service, capabilities: runtime.capabilities });
    return runtime;
  } });
  return { root, runtime, lifecycle, app, createWindow, handlers, children, observedSignals, errors, backgroundFailed,
    allowInspection: () => { failInspection = false; },
    networkStarted, networkCheck, encoderStarted, inspectionStarted, inspection,
    open: () => startConverterBeforeWindow({ lifecycle, createWindow }),
    async cleanup() {
      networkCheck.resolve(false); inspection.reject(Object.assign(new Error('test ended'), { code: 'ENOENT' }));
      inspection.promise.catch(() => {});
      await runtime.shutdown().catch(error => { if (!backgroundFailure) throw error; });
      expect(await fs.promises.readFile(sourcePath)).toEqual(original);
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  };
}

test('persisted waiting jobs expose Studio and IPC before encoding finishes, keep serial ownership and quit recoverably', async () => {
  const h = await fixture({ count: 2 });
  const opening = h.open();
  try {
    await bounded(opening);
    await bounded(h.encoderStarted.promise);
    expect(h.createWindow).toHaveBeenCalledTimes(1);
    expect(h.handlers.has('converter:cancel')).toBe(true);
    expect(h.children).toHaveLength(1);
    let idle = false;
    h.runtime.service.whenIdle('job-0').then(() => { idle = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(idle).toBe(false);
    expect((await h.runtime.store.load('job-1')).state).toBe('paused');
    await bounded(h.lifecycle.beforeQuit({ preventDefault() {} }));
    expect(h.app.quit).toHaveBeenCalledTimes(1);
    expect(h.children[0].killed).toBe(true);
    expect(h.children).toHaveLength(1);
    const saved = await h.runtime.store.load('job-0');
    expect(saved.state).toBe('paused');
    expect(saved.items[0].ownedPaths.encodedCandidate).toBeTruthy();
    expect(await fs.promises.readFile(saved.items[0].ownedPaths.encodedCandidate, 'utf8')).toBe('synthetic partial encode');
    expect((await h.runtime.store.load('job-1')).state).toBe('paused');
    await bounded(h.runtime.service.whenIdle('job-0'));
    await bounded(h.runtime.service.whenIdle('job-1'));
  } finally { await h.cleanup(); await opening.catch(() => {}); }
});

test('persisted paused-network recovery exposes controls and quits during a never-settling path check', async () => {
  const h = await fixture({ state: 'paused_network' });
  const opening = h.open();
  try {
    await bounded(opening);
    await bounded(h.networkStarted.promise);
    expect(h.createWindow).toHaveBeenCalledTimes(1);
    expect(h.handlers.has('converter:cancel')).toBe(true);
    expect((await h.runtime.store.load('job-0')).state).toBe('paused_network');
    await bounded(h.lifecycle.beforeQuit({ preventDefault() {} }));
    expect(h.observedSignals[0].aborted).toBe(true);
    expect((await h.runtime.store.load('job-0')).state).toBe('paused');
    expect(h.children).toHaveLength(0);
    // A late native result must not resume work after the app has quit.
    h.networkCheck.resolve(true);
    await new Promise(resolve => setImmediate(resolve));
    expect(h.children).toHaveLength(0);
  } finally { await h.cleanup(); await opening.catch(() => {}); }
});

test('quit retains a real runtime while startup reconciliation is still pending and never opens Studio afterward', async () => {
  const h = await fixture({ state: 'encoding', pendingInspection: true });
  const opening = h.open();
  opening.catch(() => {});
  try {
    await bounded(h.inspectionStarted.promise);
    await bounded(h.lifecycle.beforeQuit({ preventDefault() {} }));
    await expect(opening).rejects.toMatchObject({ code: 'SERVICE_SHUTDOWN' });
    expect(h.app.quit).toHaveBeenCalledTimes(1);
    expect(h.createWindow).not.toHaveBeenCalled();
    expect(h.handlers.size).toBe(0);
    expect((await h.runtime.store.load('job-0')).state).toBe('paused');
    expect(h.children).toHaveLength(0);
  } finally { await h.cleanup(); await opening.catch(() => {}); }
});

test('failed real reconciliation keeps IPC and Studio gated and does not launch earlier reconciled jobs', async () => {
  const h = await fixture({ state: 'encoding', failInspection: true, count: 2 });
  try {
    await h.runtime.store.transition('job-0', { state: 'waiting', activeItemId: null,
      items: (await h.runtime.store.load('job-0')).items.map(item => ({ ...item, state: 'queued' })) });
    await expect(bounded(h.open())).rejects.toMatchObject({ code: 'INSPECTION_FAILED' });
    expect(h.createWindow).not.toHaveBeenCalled();
    expect(h.handlers.size).toBe(0);
    expect(h.children).toHaveLength(0);
    await bounded(h.lifecycle.beforeQuit({ preventDefault() {} }));
    expect((await h.runtime.store.load('job-0')).state).toBe('paused');
  } finally { await h.cleanup(); }
});

test('retry uses the same retained runtime and deferred jobs after a real inspection failure', async () => {
  const h = await fixture({ state: 'encoding', failInspection: true, count: 2 });
  try {
    await h.runtime.store.transition('job-0', { state: 'waiting', activeItemId: null,
      items: (await h.runtime.store.load('job-0')).items.map(item => ({ ...item, state: 'queued' })) });
    await expect(h.open()).rejects.toMatchObject({ code: 'INSPECTION_FAILED' });
    h.allowInspection();
    expect(await bounded(h.open())).toBe(h.runtime);
    await bounded(h.encoderStarted.promise);
    expect(h.createWindow).toHaveBeenCalledTimes(1);
    expect(h.children).toHaveLength(1);
    await bounded(h.lifecycle.beforeQuit({ preventDefault() {} }));
    expect(h.children).toHaveLength(1);
    expect((await h.runtime.store.load('job-0')).state).toBe('paused');
    expect((await h.runtime.store.load('job-1')).state).toBe('paused');
  } finally { await h.cleanup(); }
});

test('observes background recovery rejection, preserves saved state and settles gated siblings on shutdown', async () => {
  const h = await fixture({ backgroundFailure: true, count: 2 });
  try {
    await bounded(h.open());
    await bounded(h.backgroundFailed.promise);
    expect(h.errors[0]).toMatchObject({ code: 'EIO' });
    expect(h.children).toHaveLength(0);
    expect((await h.runtime.store.load('job-0')).state).toBe('paused');
    expect((await h.runtime.store.load('job-1')).state).toBe('paused');
    await bounded(h.lifecycle.beforeQuit({ preventDefault() {} }));
    await bounded(h.runtime.service.whenIdle('job-1'));
    expect(h.app.quit).toHaveBeenCalledTimes(1);
    expect(h.errors.at(-1)).toMatchObject({ code: 'EIO' });
  } finally { await h.cleanup(); }
});
