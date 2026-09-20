'use strict';

const { EventEmitter } = require('events');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createVerificationSnapshot } = require('../../../src/main/converter/verificationSnapshot');

const {
  createBoundedProcessRunner,
  createConverterLifecycle,
  createConverterRuntime,
  ensureContainedDestinationParent,
  createVolumeInfo,
  createVerificationSnapshotRegistry,
  startConverterBeforeWindow,
  startConverterWithRecoveryPrompt
} = require('../../../src/main/converter/runtime');

const roots = [];
afterAll(async () => Promise.all(roots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true }))));

async function temporaryRoot(label) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `sentry-six-runtime-${label}-`));
  roots.push(root);
  return root;
}

describe('contained destination hierarchy creation', () => {
  test('creates a missing mirrored parent and revalidates its canonical containment', async () => {
    const root = await temporaryRoot('destination-parent');
    const parent = path.join(root, 'RecentClips', 'event-1');
    const guard = await ensureContainedDestinationParent({
      destinationRoot: root,
      destination: path.join(parent, 'event.json'),
      fs: fs.promises,
      pathApi: path,
      platform: process.platform
    });
    expect((await fs.promises.lstat(parent)).isDirectory()).toBe(true);
    expect(guard).toEqual(expect.objectContaining({ atomicContainment: false, revalidate: expect.any(Function) }));
    await expect(guard.revalidate()).resolves.toBeUndefined();
  });

  test('rejects a lexical escape before creating any directory', async () => {
    const fakeFs = { mkdir: jest.fn(), realpath: jest.fn() };
    await expect(ensureContainedDestinationParent({
      destinationRoot: 'E:\\ConvertedTeslaCam',
      destination: 'E:\\outside\\clip.mp4',
      fs: fakeFs,
      pathApi: path.win32,
      platform: 'win32'
    })).rejects.toMatchObject({ code: 'UNSAFE_DESTINATION_PATH' });
    expect(fakeFs.mkdir).not.toHaveBeenCalled();
  });

  test('rejects a junction or symlink component before creating anything through it', async () => {
    const caseRoot = await temporaryRoot('destination-link');
    const root = path.join(caseRoot, 'destination');
    const outside = path.join(caseRoot, 'outside');
    await Promise.all([fs.promises.mkdir(root), fs.promises.mkdir(outside)]);
    const linked = path.join(root, 'RecentClips');
    try {
      await fs.promises.symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'ENOSYS', 'EACCES'].includes(error?.code)) return;
      throw error;
    }
    await expect(ensureContainedDestinationParent({
      destinationRoot: root,
      destination: path.join(linked, 'event-1', 'event.json'),
      fs: fs.promises,
      pathApi: path,
      platform: process.platform
    })).rejects.toMatchObject({ code: 'UNSAFE_DESTINATION_PATH' });
    await expect(fs.promises.lstat(path.join(outside, 'event-1'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('revalidation rejects a parent replaced after its identity was captured', async () => {
    const root = await temporaryRoot('destination-swap');
    const parent = path.join(root, 'RecentClips');
    const guard = await ensureContainedDestinationParent({ destinationRoot: root,
      destination: path.join(parent, 'clip.mp4'), fs: fs.promises, pathApi: path, platform: process.platform });
    await fs.promises.rename(parent, `${parent}-old`);
    await fs.promises.mkdir(parent);
    await expect(guard.revalidate()).rejects.toMatchObject({ code: 'UNSAFE_DESTINATION_PATH' });
  });

  test('characterizes the non-atomic fallback when a prior component is swapped before the next mkdir', async () => {
    const caseRoot = await temporaryRoot('destination-component-race');
    const root = path.join(caseRoot, 'destination');
    const outside = path.join(caseRoot, 'outside');
    const first = path.join(root, 'RecentClips');
    const second = path.join(first, 'event-1');
    await Promise.all([fs.promises.mkdir(root), fs.promises.mkdir(outside)]);
    const racedFs = new Proxy(fs.promises, { get(target, property) {
      if (property !== 'mkdir') {
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (targetPath, options) => {
        if (targetPath === second) {
          await target.rename(first, `${first}-old`);
          await target.symlink(outside, first, process.platform === 'win32' ? 'junction' : 'dir');
        }
        return target.mkdir(targetPath, options);
      };
    } });

    await expect(ensureContainedDestinationParent({ destinationRoot: root,
      destination: path.join(second, 'event.json'), fs: racedFs, pathApi: path,
      platform: process.platform })).rejects.toMatchObject({ code: 'UNSAFE_DESTINATION_PATH' });
    expect((await fs.promises.lstat(path.join(outside, 'event-1'))).isDirectory()).toBe(true);
  });

  test.each(['ENOENT', 'ENOTCONN', 'EHOSTUNREACH', 'ETIMEDOUT', 'EIO'])(
    'revalidation preserves retryable %s identity and cause', async (code) => {
      const root = await temporaryRoot(`destination-${code.toLowerCase()}`);
      const parent = path.join(root, 'RecentClips');
      let disconnected = false;
      const nativeError = Object.assign(new Error(`native ${code}`), { code, cause: new Error('share disappeared') });
      const transientFs = new Proxy(fs.promises, { get(target, property) {
        if (property === 'lstat') return async (targetPath, options) => {
          if (disconnected && targetPath === parent) throw nativeError;
          return target.lstat(targetPath, options);
        };
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      const guard = await ensureContainedDestinationParent({ destinationRoot: root,
        destination: path.join(parent, 'clip.mp4'), fs: transientFs, pathApi: path, platform: process.platform });
      disconnected = true;
      await expect(guard.revalidate()).rejects.toBe(nativeError);
    }
  );

  test('ancestor discovery preserves the terminal native ENOENT at an unavailable volume root', async () => {
    const nativeError = Object.assign(new Error('mapped share unavailable'), { code: 'ENOENT', cause: new Error('native') });
    const unavailableFs = { lstat: jest.fn(async () => { throw nativeError; }) };
    await expect(ensureContainedDestinationParent({ destinationRoot: 'Z:\\ConvertedTeslaCam',
      destination: 'Z:\\ConvertedTeslaCam\\RecentClips\\clip.mp4', fs: unavailableFs,
      pathApi: path.win32, platform: 'win32' })).rejects.toBe(nativeError);
  });
});

describe('bounded converter process runner', () => {
  test('runs an executable with an argument array and no shell without launching FFmpeg', async () => {
    const runner = createBoundedProcessRunner({ spawn: childProcess.spawn, timeoutMs: 5_000, maxOutputBytes: 4_096 });
    const result = await runner(process.execPath, ['-e', 'process.stdout.write("ok")'], { shell: false });

    expect(result).toEqual({ status: 0, signal: null, stdout: 'ok', stderr: '', timedOut: false });
  });

  test('rejects shell execution and bounds captured process output', async () => {
    const runner = createBoundedProcessRunner({ spawn: childProcess.spawn, timeoutMs: 5_000, maxOutputBytes: 32 });
    await expect(runner(process.execPath, ['-e', 'process.stdout.write("x".repeat(33))'], { shell: true }))
      .rejects.toMatchObject({ code: 'INVALID_PROCESS_REQUEST' });
    await expect(runner(process.execPath, ['-e', 'process.stdout.write("x".repeat(33))'], { shell: false }))
      .resolves.toMatchObject({ status: null, timedOut: false, outputLimitExceeded: true, stdout: '' });
  });

  test('terminates an owned child when its AbortSignal is cancelled', async () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = jest.fn(() => { queueMicrotask(() => child.emit('close', null, 'SIGTERM')); return true; });
    const spawn = jest.fn(() => child);
    const runner = createBoundedProcessRunner({ spawn, timeoutMs: 5_000 });
    const controller = new AbortController();
    const result = runner('C:\\tools\\probe.exe', ['-version'], { signal: controller.signal, shell: false });
    controller.abort();

    await expect(result).resolves.toMatchObject({ status: null, signal: 'SIGTERM', aborted: true });
    expect(spawn).toHaveBeenCalledWith('C:\\tools\\probe.exe', ['-version'], expect.objectContaining({
      shell: false, windowsHide: true
    }));
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});

describe('verification snapshot capability registry', () => {
  test('creates and accepts a real snapshot under a non-default temporary root', async () => {
    const tempRoot = await temporaryRoot('custom-snapshot');
    let created;
    const registry = createVerificationSnapshotRegistry({ tempRoot, createSnapshot: async (input) => {
      created = await createVerificationSnapshot(input);
      return created;
    } });
    try {
      const snapshot = await registry.createSnapshot({ bytes: Buffer.from('verified custom-root bytes') });
      expect(path.dirname(path.dirname(snapshot.path))).toBe(tempRoot);
      expect(await snapshot.read()).toEqual(Buffer.from('verified custom-root bytes'));
      expect(await registry.validate(snapshot, { mode: 'consume' })).toBe(true);
    } finally { await created?.cleanup(); }
  });

  test('cleans up a rejected freshly created snapshot through its bounded capability', async () => {
    const tempRoot = await temporaryRoot('rejected-snapshot');
    const created = await createVerificationSnapshot({ bytes: Buffer.from('rejected snapshot') });
    const registry = createVerificationSnapshotRegistry({ tempRoot, createSnapshot: async () => created });
    try {
      await expect(registry.createSnapshot({})).rejects.toMatchObject({ code: 'INVALID_PUBLICATION_ARTIFACT' });
      await expect(fs.promises.stat(created.path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await created.cleanup(); }
  });

  test('preserves rejection and cleanup failure visibility without deleting by a supplied path', async () => {
    const cleanupError = new Error('bounded cleanup failed');
    const registry = createVerificationSnapshotRegistry({ createSnapshot: async () => ({
      path: 'invalid', cleanup: async () => { throw cleanupError; }
    }) });
    await expect(registry.createSnapshot({})).rejects.toMatchObject({
      code: 'INVALID_PUBLICATION_ARTIFACT', cause: cleanupError
    });
  });

  test('does not clean up a rejected snapshot whose ownership was already transferred', async () => {
    const root = await temporaryRoot('rejected-transferred');
    const created = await createVerificationSnapshot({ bytes: Buffer.from('transferred bytes'), tempRoot: root });
    await created.transfer();
    let cleanupCalls = 0;
    const registry = createVerificationSnapshotRegistry({ tempRoot: path.join(root, 'different-root'),
      createSnapshot: async () => ({ ...created, transferred: true,
        cleanup: async () => { cleanupCalls++; await fs.promises.unlink(created.path); } }) });
    await expect(registry.createSnapshot({})).rejects.toMatchObject({ code: 'INVALID_PUBLICATION_ARTIFACT' });
    expect(cleanupCalls).toBe(0);
    expect(await fs.promises.readFile(created.path, 'utf8')).toBe('transferred bytes');
  });

  test('allows one live consume and an exact persisted restart reconciliation only', async () => {
    const bytes = Buffer.from('verified');
    const record = {
      path: path.join(os.tmpdir(), 'sentry-six-verification-test', 'token.mp4'),
      token: 'token',
      size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex')
    };
    const registry = createVerificationSnapshotRegistry({
      createSnapshot: jest.fn(async () => ({
        ...record,
        read: async () => bytes,
        cleanup: async () => {},
        transfer: async () => ({ path: record.path, token: record.token })
      })),
      pathApi: path,
      tempRoot: os.tmpdir()
    });

    const snapshot = await registry.createSnapshot({ bytes, size: bytes.length, sha256: record.sha256 });
    expect(await registry.validate(record, { mode: 'consume' })).toBe(true);
    expect(await registry.validate(record, { mode: 'consume' })).toBe(false);
    expect(await registry.validate(record, { mode: 'reconcile', persistedArtifact: record })).toBe(true);
    expect(await registry.validate({ ...record, token: 'forged' }, { mode: 'reconcile', persistedArtifact: record })).toBe(false);
  });
});

describe('runtime volume classification', () => {
  test('detects and caches a Windows mapped drive through a bounded no-shell OS query', async () => {
    const runCommand = jest.fn(async () => ({
      status: 0, signal: null, stdout: 'Network\r\n', stderr: '', timedOut: false
    }));
    const volumeInfo = createVolumeInfo({
      fs: { statfs: jest.fn(async () => ({ bavail: 10n, bsize: 4096n })) },
      pathApi: path.win32,
      platform: 'win32',
      runCommand,
      powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    });

    await expect(volumeInfo.classifyPath('Z:\\TeslaCam')).resolves.toEqual({ remote: true, certain: true });
    await expect(volumeInfo.classifyPath('Z:\\TeslaCam\\RecentClips')).resolves.toEqual({ remote: true, certain: true });
    await expect(volumeInfo.freeSpace('C:\\Temp')).resolves.toBe(40_960);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand.mock.calls[0][0]).toMatch(/powershell\.exe$/i);
    expect(runCommand.mock.calls[0][1]).toEqual(expect.arrayContaining(['Z:\\']));
    expect(runCommand.mock.calls[0][2]).toEqual({ shell: false });
  });
});

describe('converter runtime composition', () => {
  test('wires each concrete boundary once and exposes guarded replacement capabilities', async () => {
    const root = await temporaryRoot('fakes');
    const destinationRoot = path.join(root, 'destination');
    await fs.promises.mkdir(destinationRoot);
    const calls = {};
    const store = { list: jest.fn(async () => []) };
    const stagingManager = {};
    const planner = {};
    const adapters = { writers: { h265: jest.fn(), av1: jest.fn() }, verifier: jest.fn() };
    const service = { list: jest.fn(async () => []), recover: jest.fn(), shutdown: jest.fn(async () => {}) };
    const factories = {
      createJobStore: jest.fn(() => store),
      createFileTransaction: jest.fn((options) => { calls.transaction = options; return stagingManager; }),
      createEncoderPlanner: jest.fn((options) => { calls.planner = options; return planner; }),
      createConverterAdapters: jest.fn((options) => { calls.adapters = options; return adapters; }),
      createConverterJobService: jest.fn((options) => { calls.service = options; return service; })
    };

    const runtime = await createConverterRuntime({
      userDataPath: path.join(root, 'user-data'),
      tempPath: path.join(root, 'temp'),
      ffmpegPath: 'C:\\bundle\\ffmpeg.exe',
      ffprobePath: 'C:\\bundle\\ffprobe.exe',
      factories,
      spawn: jest.fn(),
      fs,
      pathApi: path,
      platform: 'win32'
    });

    expect(factories.createJobStore).toHaveBeenCalledTimes(1);
    expect(factories.createFileTransaction).toHaveBeenCalledTimes(1);
    expect(factories.createEncoderPlanner).toHaveBeenCalledTimes(1);
    expect(factories.createConverterAdapters).toHaveBeenCalledTimes(1);
    expect(factories.createConverterJobService).toHaveBeenCalledTimes(1);
    expect(calls.service).toMatchObject({ store, stagingManager, planner, writers: adapters.writers, verifier: adapters.verifier });
    expect(calls.service.scanner).toEqual(expect.any(Function));
    expect(calls.service.inspectVideo).toEqual(expect.any(Function));
    expect(calls.service.readTimeline).toEqual(expect.any(Function));
    expect(calls.service.classifyPath).toEqual(expect.any(Function));
    expect(calls.service.chooseStagingMode).toEqual(expect.any(Function));
    expect(calls.service.chooseStagingMode({
      networkMode: 'auto', classification: { kind: 'local' }, space: { sufficient: true }
    })).toBe('direct');
    expect(calls.service.checkStagingSpace).toEqual(expect.any(Function));
    expect(calls.service.inspectRecovery).toEqual(expect.any(Function));
    for (const code of ['ENOENT', 'ENOTCONN', 'ENETDOWN', 'EHOSTUNREACH', 'ECONNRESET', 'ETIMEDOUT', 'EIO']) {
      expect(calls.service.network.isRetryable({ code })).toBe(true);
    }
    expect(calls.service.network.isRetryable({ code: 'EACCES' })).toBe(false);
    await expect(calls.service.network.checkPath(destinationRoot)).resolves.toBe(true);
    const missingSource = path.join(root, 'missing-source', 'TeslaCam');
    const futureDestination = path.join(root, 'future-destination-root');
    await expect(calls.service.network.checkPath(missingSource)).resolves.toBe(false);
    await expect(calls.service.network.checkPath(futureDestination)).resolves.toBe(false);
    await expect(calls.service.network.checkPath(futureDestination, { allowAncestor: true })).resolves.toBe(true);
    expect(calls.transaction.removeOwned).toMatchObject({ atomicOwnershipCheck: process.platform === 'win32' });
    expect(calls.transaction.removeOwned.remove).toEqual(expect.any(Function));
    expect(calls.transaction.renameExclusive).toMatchObject({
      atomicNoReplace: true,
      atomicExpectedOwnership: process.platform === 'win32'
    });
    expect(calls.transaction.renameExclusive.promote).toEqual(expect.any(Function));
    expect(runtime.capabilities).toEqual({
      separatePublication: process.platform === 'win32' ? 'native-atomic' : 'hardlink-cleanup-pending',
      ownershipCleanup: process.platform === 'win32' ? 'atomic-expected-ownership' : 'unavailable',
      replacement: process.platform === 'win32' ? 'available' : 'unavailable',
      destinationContainment: 'pathname-revalidated-non-atomic'
    });

    await runtime.start();
    await runtime.start();
    await runtime.shutdown();
    await runtime.shutdown();
    expect(store.list).toHaveBeenCalledTimes(1);
    expect(service.shutdown).toHaveBeenCalledTimes(1);
  });

  test('creates a real singleton store/service and performs an empty startup recovery without launching FFmpeg', async () => {
    const root = await temporaryRoot('real');
    const spawn = jest.fn(() => { throw new Error('process launch was not expected'); });
    const runtime = await createConverterRuntime({
      userDataPath: path.join(root, 'user-data'),
      tempPath: path.join(root, 'temp'),
      ffmpegPath: path.join(root, 'ffmpeg'),
      ffprobePath: path.join(root, 'ffprobe'),
      spawn,
      fs,
      pathApi: path,
      platform: process.platform
    });

    await expect(runtime.start()).resolves.toEqual([]);
    await expect(runtime.service.list()).resolves.toEqual([]);
    await expect(runtime.shutdown()).resolves.toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });

  test('retries failed startup recovery and deliberately defers later jobs until the retry', async () => {
    const root = await temporaryRoot('recovery-retry');
    const store = {
      list: jest.fn(async () => [
        { id: 'job-1', state: 'copying' },
        { id: 'job-2', state: 'encoding' }
      ])
    };
    const recoveryFailure = Object.assign(new Error('recovery failed'), { code: 'RECOVERY_FAILED' });
    const service = {
      recover: jest.fn()
        .mockRejectedValueOnce(recoveryFailure)
        .mockImplementation(async (id) => ({ id, state: 'paused' })),
      continueRecovery: jest.fn(async () => {}),
      shutdown: jest.fn(async () => {})
    };
    const runtime = await createConverterRuntime({
      userDataPath: path.join(root, 'user-data'),
      tempPath: path.join(root, 'temp'),
      ffmpegPath: 'C:\\bundle\\ffmpeg.exe',
      ffprobePath: 'C:\\bundle\\ffprobe.exe',
      spawn: jest.fn(),
      fs,
      pathApi: path,
      factories: {
        createJobStore: () => store,
        createFileTransaction: () => ({}),
        createEncoderPlanner: () => ({}),
        createConverterAdapters: () => ({ writers: {}, verifier: jest.fn() }),
        createConverterJobService: () => service
      }
    });

    await expect(runtime.start()).rejects.toBe(recoveryFailure);
    expect(service.recover.mock.calls.map(([id]) => id)).toEqual(['job-1']);

    await expect(runtime.start()).resolves.toEqual([
      { id: 'job-1', state: 'paused' },
      { id: 'job-2', state: 'paused' }
    ]);
    expect(service.recover.mock.calls.map(([id]) => id)).toEqual(['job-1', 'job-1', 'job-2']);
    expect(store.list).toHaveBeenCalledTimes(2);
    await runtime.shutdown();
  });
});

describe('converter app lifecycle', () => {
  test('does not initialize converter services solely because the app quits early', async () => {
    const initialize = jest.fn();
    const app = { quit: jest.fn() };
    const lifecycle = createConverterLifecycle({ initialize, app });
    const event = { preventDefault: jest.fn() };

    await lifecycle.beforeQuit(event);

    await expect(lifecycle.start()).rejects.toMatchObject({ code: 'SERVICE_SHUTDOWN' });

    expect(initialize).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
  });

  test('initializes once and prevents quit until one asynchronous shutdown finishes', async () => {
    let finishShutdown;
    const runtime = { shutdown: jest.fn(() => new Promise((resolve) => { finishShutdown = resolve; })) };
    const app = { quit: jest.fn() };
    const lifecycle = createConverterLifecycle({ initialize: jest.fn(async () => runtime), app });

    await expect(Promise.all([lifecycle.start(), lifecycle.start()])).resolves.toEqual([runtime, runtime]);
    const firstEvent = { preventDefault: jest.fn() };
    const secondEvent = { preventDefault: jest.fn() };
    const first = lifecycle.beforeQuit(firstEvent);
    const second = lifecycle.beforeQuit(secondEvent);
    expect(firstEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(secondEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(runtime.shutdown).toHaveBeenCalledTimes(1);
    finishShutdown();
    await Promise.all([first, second]);
    expect(app.quit).toHaveBeenCalledTimes(1);

    const finalEvent = { preventDefault: jest.fn() };
    await lifecycle.beforeQuit(finalEvent);
    expect(finalEvent.preventDefault).not.toHaveBeenCalled();
  });

  test('does not permanently memoize a failed initialization attempt', async () => {
    const runtime = { shutdown: jest.fn(async () => {}) };
    const failure = Object.assign(new Error('startup recovery failed'), { code: 'RECOVERY_FAILED' });
    const initialize = jest.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(runtime);
    const lifecycle = createConverterLifecycle({ initialize, app: { quit: jest.fn() } });

    await expect(lifecycle.start()).rejects.toBe(failure);
    await expect(lifecycle.start()).resolves.toBe(runtime);
    expect(initialize).toHaveBeenCalledTimes(2);
  });

  test('propagates startup failure and does not open a renderer window', async () => {
    const failure = Object.assign(new Error('startup recovery failed'), { code: 'RECOVERY_FAILED' });
    const lifecycle = { start: jest.fn(async () => { throw failure; }) };
    const createWindow = jest.fn();

    await expect(startConverterBeforeWindow({ lifecycle, createWindow })).rejects.toBe(failure);
    expect(createWindow).not.toHaveBeenCalled();
  });

  test('retries production startup until recovery succeeds without duplicate windows', async () => {
    const runtime = { shutdown: jest.fn(async () => {}) };
    const failure = Object.assign(new Error('startup recovery failed'), { code: 'RECOVERY_FAILED' });
    const registerIpc = jest.fn();
    const lifecycle = {
      start: jest.fn()
        .mockRejectedValueOnce(failure)
        .mockRejectedValueOnce(failure)
        .mockImplementationOnce(async () => {
          registerIpc();
          return runtime;
        })
    };
    const dialog = {
      showMessageBox: jest.fn()
        .mockResolvedValueOnce({ response: 0 })
        .mockResolvedValueOnce({ response: 0 })
    };
    const app = { quit: jest.fn() };
    const createWindow = jest.fn();
    const scheduleRetry = jest.fn(async () => {});
    const onError = jest.fn();

    await expect(startConverterWithRecoveryPrompt({
      lifecycle, createWindow, dialog, app, scheduleRetry, onError
    })).resolves.toBe(runtime);

    expect(lifecycle.start).toHaveBeenCalledTimes(3);
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(2);
    expect(scheduleRetry).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(registerIpc).toHaveBeenCalledTimes(1);
    expect(createWindow).toHaveBeenCalledTimes(1);
    expect(app.quit).not.toHaveBeenCalled();
  });

  test('keeps IPC/window startup blocked when recovery fails and Quit is chosen', async () => {
    const failure = Object.assign(new Error('startup recovery failed'), { code: 'RECOVERY_FAILED' });
    const lifecycle = { start: jest.fn(async () => { throw failure; }) };
    const dialog = { showMessageBox: jest.fn(async () => ({ response: 1 })) };
    const app = { quit: jest.fn() };
    const createWindow = jest.fn();

    await expect(startConverterWithRecoveryPrompt({ lifecycle, createWindow, dialog, app })).resolves.toBeNull();

    expect(lifecycle.start).toHaveBeenCalledTimes(1);
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(createWindow).not.toHaveBeenCalled();
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  test('does not retry or duplicate a window when window creation itself fails', async () => {
    const runtime = { shutdown: jest.fn(async () => {}) };
    const lifecycle = { start: jest.fn(async () => runtime) };
    const windowFailure = new Error('window construction failed');
    const createWindow = jest.fn(() => { throw windowFailure; });
    const dialog = { showMessageBox: jest.fn() };
    const app = { quit: jest.fn() };

    await expect(startConverterWithRecoveryPrompt({ lifecycle, createWindow, dialog, app })).rejects.toBe(windowFailure);

    expect(lifecycle.start).toHaveBeenCalledTimes(1);
    expect(createWindow).toHaveBeenCalledTimes(1);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
  });
});
