'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createConverterJobService } = require('../../../src/main/converter/jobService');
const { createJobStore } = require('../../../src/main/converter/jobStore');

const temporaryRoots = [];

afterAll(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true })));
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function video(name, overrides = {}) {
  return {
    kind: 'video',
    group: 'RecentClips',
    eventId: null,
    relativePath: `RecentClips/${name}.mp4`,
    sourcePath: `D:\\TeslaCam\\RecentClips\\${name}.mp4`,
    sourceBytes: 1_000_000,
    mtimeMs: 1_700_000_000_000,
    timestampKey: name,
    camera: 'front',
    ...overrides
  };
}

function asset(name = 'event.json', overrides = {}) {
  return {
    kind: 'asset',
    group: 'SentryClips',
    eventId: 'event-1',
    relativePath: `SentryClips/event-1/${name}`,
    sourcePath: `D:\\TeslaCam\\SentryClips\\event-1\\${name}`,
    sourceBytes: 123,
    mtimeMs: 1_700_000_000_000,
    assetType: name === 'event.json' ? 'event-json' : 'thumbnail',
    ...overrides
  };
}

function createMemoryStore(log = []) {
  const manifests = new Map();
  let sequence = 0;
  return {
    manifests,
    async create(initial) {
      const id = initial.id || `job-${++sequence}`;
      const manifest = clone({
        schemaVersion: 1,
        id,
        state: 'discovering',
        revision: 0,
        items: [],
        counters: initial.counters,
        summary: null,
        summaryDismissed: false,
        ...initial
      });
      manifests.set(id, manifest);
      log.push(`store:create:${id}`);
      return clone(manifest);
    },
    async transition(id, patch) {
      const current = manifests.get(id);
      if (!current) throw Object.assign(new Error('missing'), { code: 'JOB_NOT_FOUND' });
      const next = clone({ ...current, ...patch, revision: current.revision + 1 });
      manifests.set(id, next);
      log.push(`store:transition:${next.state}:${next.items.length}`);
      return clone(next);
    },
    async load(id) { return clone(manifests.get(id) || null); },
    async list() { return [...manifests.values()].map(clone); },
    async recover(id, inspect) {
      const current = clone(manifests.get(id));
      const facts = await inspect(current);
      const fromState = current.state;
      let action = 'manual-intervention';
      if (fromState === 'encoding') action = facts.candidateExists ? 'cleanup-and-restart-encoding' : 'restart-encoding';
      if (fromState === 'copying') action = facts.partialExists ? 'resume-copy' : 'restart-copy';
      if (fromState === 'replacing') action = 'finish-replacement';
      return this.transition(id, {
        state: 'paused',
        recovery: { fromState, ...(current.replacementPhase ? { phase: current.replacementPhase } : {}), action }
      });
    }
  };
}

function createChild(action, calls, active) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn(() => {
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    return true;
  });
  active.count += 1;
  active.max = Math.max(active.max, active.count);
  child.once('close', () => { active.count -= 1; });
  queueMicrotask(() => {
    if (action?.hold) action.hold.resolveChild(child);
    else {
      for (const chunk of action?.chunks || ['out_time_ms=500000\nprogress=continue\n', 'progress=end\n']) {
        child.stdout.emit('data', Buffer.from(chunk));
      }
      child.emit('close', action?.status ?? 0, null);
    }
  });
  calls.push(child);
  return child;
}

function harness(options = {}) {
  const log = [];
  const store = options.store || createMemoryStore(log);
  const scanItems = options.items || [video('2026-08-30_12-00-00-front')];
  const scanner = jest.fn(async function* scanner() {
    log.push('scanner:start');
    for (const item of scanItems) {
      log.push(`scanner:yield:${item.relativePath}`);
      yield clone(item);
    }
    log.push('scanner:end');
  });
  const planner = {
    select: jest.fn(async (codec) => ({ family: codec, codec: codec === 'h265' ? 'hevc_nvenc' : 'av1_nvenc', hardware: true })),
    selectCpuFallback: jest.fn(async (codec) => ({ family: codec, codec: codec === 'h265' ? 'libx265' : 'libsvtav1', hardware: false })),
    ...options.planner
  };
  const stagingManager = {
    captureSource: async () => ({ size: 1000000, sha256: 'c'.repeat(64), device: '1', inode: '2' }),
    stageSource: jest.fn(async ({ source }) => ({ stagedSource: source })),
    reserveEncodeOutput: jest.fn(async ({ jobId, itemId, persistTransaction }) => {
      const candidate = `C:\\temp\\${jobId}-${itemId}-candidate.mp4`;
      const ownedPaths = { encodedCandidate: candidate };
      const ownedArtifacts = { encodedCandidate: { path: candidate, nonce: 'nonce', state: 'intent' } };
      await persistTransaction({ step: 'encoded-candidate-intent', ownedPaths, ownedArtifacts });
      return { path: candidate, ownedPaths, ownedArtifacts };
    }),
    adoptEncodeOutput: jest.fn(async ({ ownedPaths, ownedArtifacts, persistTransaction }) => {
      const adopted = {
        ...ownedArtifacts.encodedCandidate,
        state: 'owned', size: 800_000, sha256: 'a'.repeat(64), device: '1', inode: '2'
      };
      const next = { ownedPaths, ownedArtifacts: { encodedCandidate: adopted } };
      await persistTransaction({ step: 'encoded-candidate-owned', ...next });
      return { path: ownedPaths.encodedCandidate, outputBytes: 800_000, ...next };
    }),
    publishSeparate: jest.fn(async ({ destination, publicationArtifact, persistTransaction }) => {
      await persistTransaction({ step: 'separate-complete', ownedPaths: {}, ownedArtifacts: {} });
      return { finalPath: destination, outputBytes: publicationArtifact.size, ownedPaths: {}, ownedArtifacts: {}, cleanupPending: [] };
    }),
    replaceOriginal: jest.fn(async ({ source, publicationArtifact, persistTransaction }) => {
      await persistTransaction({ phase: 'backup-deleted', ownedPaths: {}, ownedArtifacts: {} });
      return { finalPath: source, outputBytes: publicationArtifact.size, phase: 'backup-deleted', ownedPaths: {}, ownedArtifacts: {}, cleanupPending: [] };
    }),
    copyAsset: jest.fn(async ({ destination, persistTransaction }) => {
      await persistTransaction({ step: 'asset-complete', ownedPaths: {}, ownedArtifacts: {} });
      return { finalPath: destination, outputBytes: 123, ownedPaths: {}, ownedArtifacts: {}, cleanupPending: [] };
    }),
    cleanupOwnedArtifacts: jest.fn(async () => ({ cleaned: true })),
    recoverCopy: jest.fn(async () => ({ finalPath: 'E:\\Converted\\clip.mp4', ownedPaths: {}, ownedArtifacts: {}, cleanupPending: [] })),
    recoverReplacement: jest.fn(async () => ({ phase: 'backup-deleted', ownedPaths: {}, ownedArtifacts: {} })),
    ...options.stagingManager
  };
  const timelines = new Map();
  const readTimeline = jest.fn(async ({ item }) => {
    if (!timelines.has(item.id)) timelines.set(item.id, Object.freeze({
      samples: Object.freeze([
        Object.freeze({ ptsUs: 0, durationUs: 1_000_000, hasTelemetry: true, seiNals: Object.freeze([Buffer.from([1])]) }),
        Object.freeze({ ptsUs: 1_000_000, durationUs: 1_000_000, hasTelemetry: false, seiNals: Object.freeze([]) }),
        Object.freeze({ ptsUs: 2_000_000, durationUs: 1_000_000, hasTelemetry: true, seiNals: Object.freeze([Buffer.from([2])]) })
      ]),
      events: Object.freeze([])
    }));
    return timelines.get(item.id);
  });
  const writers = {
    h265: jest.fn(async ({ candidatePath }) => candidatePath),
    av1: jest.fn(async ({ candidatePath }) => candidatePath),
    ...options.writers
  };
  const verifyQueue = [...(options.verifyResults || [])];
  const verifier = jest.fn(async ({ candidate }) => {
    const next = verifyQueue.length ? verifyQueue.shift() : null;
    if (next instanceof Error) throw next;
    return next || {
      ok: true,
      reason: null,
      retryable: false,
      sourceBytes: 1_000_000,
      outputBytes: 800_000,
      details: {},
      publicationArtifact: { path: `${candidate}.snapshot`, token: 'token', sha256: 'b'.repeat(64), size: 800_000 }
    };
  });
  const spawnActions = [...(options.spawnActions || [])];
  const children = [];
  const active = { count: 0, max: 0 };
  const spawnProcess = jest.fn((_command, _args, _spawnOptions) => createChild(spawnActions.shift(), children, active));
  const inspectQueue = [...(options.inspectResults || [])];
  const inspectVideo = jest.fn(async (item) => {
    const next = inspectQueue.length ? inspectQueue.shift() : null;
    if (next instanceof Error) throw next;
    return next || { codec: 'h264', durationSeconds: 10, containerReserveBytes: 1_000, telemetryReserveBytes: 1_000 };
  });
  const sleeps = [];
  let now = 1_000;
  const clock = {
    now: jest.fn(() => now++),
    sleep: jest.fn(async (milliseconds) => { sleeps.push(milliseconds); })
  };
  const networkChecks = [...(options.networkChecks || [])];
  const network = {
    isRetryable: jest.fn((error) => error?.code === 'ENETDOWN' || error?.code === 'EHOSTUNREACH'),
    checkPath: jest.fn(async () => networkChecks.length ? networkChecks.shift() : true)
  };
  const checkStagingSpace = jest.fn(async () => ({
    sufficient: true,
    requiredBytes: 2_000_000,
    freeBytes: 3_000_000
  }));
  const revalidateDestinationParent = jest.fn(async () => undefined);
  const ensureDestinationParent = jest.fn(async () => ({
    atomicContainment: false,
    revalidate: revalidateDestinationParent
  }));
  const events = [];
  const service = createConverterJobService({
    store,
    scanner,
    planner,
    stagingManager,
    inspectVideo,
    readTimeline,
    writers,
    verifier,
    spawnProcess,
    ffmpegPath: 'C:\\tools\\ffmpeg.exe',
    pathApi: path.win32,
    clock,
    network,
    ensureDestinationParent,
    checkStagingSpace,
    queueLimit: options.queueLimit || 1,
    ...options.deps
  });
  service.subscribe((event) => events.push(event));
  return { service, store, scanner, planner, stagingManager, inspectVideo, readTimeline, writers,
    verifier, spawnProcess, children, active, events, log, sleeps, network, timelines,
    ensureDestinationParent, revalidateDestinationParent };
}

const CONFIG = Object.freeze({
  sourceRoot: 'D:\\TeslaCam',
  destinationRoot: 'E:\\ConvertedTeslaCam',
  codec: 'h265',
  profileId: 'balanced',
  networkMode: 'direct',
  outputMode: 'separate',
  includedGroups: ['RecentClips', 'SavedClips', 'SentryClips'],
  replacementConfirmed: false
});

function emptyCounters() {
  return {
    files: 0, sourceVideoBytes: 0, outputVideoBytes: 0, savedBytes: 0, copiedAssetBytes: 0,
    groups: {
      RecentClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 },
      SavedClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 },
      SentryClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 }
    }
  };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('converter job orchestration', () => {
  test.each(['h265', 'av1'])('binds conditional replacement to persisted authority and codec %s', async (codec) => {
    const expectedSource = { device: '1', inode: '2', size: 1000000, sha256: 'c'.repeat(64) };
    const h = harness({ stagingManager: {
      captureSource: async () => expectedSource,
      replaceOriginal: async ({ source, codec: receivedCodec, expectedSource: received, publicationArtifact }) => {
        const persisted = [...h.store.manifests.values()][0].items[0];
        if (receivedCodec !== codec || JSON.stringify(received) !== JSON.stringify(expectedSource)
            || JSON.stringify(persisted.expectedSource) !== JSON.stringify(expectedSource)) {
          throw Object.assign(new Error('missing authority'), { code: 'SOURCE_AUTHORITY_REQUIRED' });
        }
        return { finalPath: source, outputBytes: publicationArtifact.size, ownedPaths: {}, ownedArtifacts: {} };
      }
    } });
    const id = await h.service.start({ ...CONFIG, codec, destinationRoot: null, outputMode: 'replace', replacementConfirmed: true });
    const completed = await h.service.whenIdle(id);
    expect(completed.items[0].state).toBe('completed');
  });

  test('failed rollback pauses recovery and retains backup ownership through cancel and retry', async () => {
    const h = harness({ stagingManager: {
      captureSource: async () => ({ device: '1', inode: '2', size: 1000000, sha256: 'c'.repeat(64) }),
      replaceOriginal: async ({ source, persistTransaction }) => {
        const backup = `${source}.backup`;
        await persistTransaction({ phase: 'rollback-failed', ownedPaths: { replacementBackup: backup },
          ownedArtifacts: { replacementBackup: { path: backup, nonce: 'fixture', state: 'owned',
            device: '1', inode: '2', size: 1000000, sha256: 'c'.repeat(64) } } });
        throw Object.assign(new Error('restore failed'), { code: 'ROLLBACK_FAILED' });
      }
    } });
    const id = await h.service.start({ ...CONFIG, destinationRoot: null, outputMode: 'replace', replacementConfirmed: true });
    const paused = await h.service.whenIdle(id);
    expect(paused.state).toBe('paused');
    expect(paused.recovery.action).toBe('manual-intervention');
    expect((await h.store.load(id)).items[0].ownedPaths.replacementBackup).toBeDefined();
    await expect(h.service.cancel(id)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    await expect(h.service.retryFailed(id)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect((await h.store.load(id)).items[0].ownedPaths.replacementBackup).toBeDefined();
  });

  test('serializes concurrent starts so only one active job can be created', async () => {
    const gate = deferred();
    const h = harness({ spawnActions: [{ hold: { resolveChild: gate.resolve } }] });
    const results = await Promise.allSettled([
      h.service.start(CONFIG),
      h.service.start({ ...CONFIG, codec: 'av1' })
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'JOB_ACTIVE' }) })
    ]);
    const child = await gate.promise;
    child.emit('close', 0, null);
    await h.service.whenIdle(results.find((result) => result.status === 'fulfilled').value);
  });

  test('overlaps bounded discovery with conversion, persists before enqueue, and never runs two encodes', async () => {
    const first = deferred();
    const second = deferred();
    const h = harness({
      items: [video('one'), video('two'), video('three')],
      spawnActions: [{ hold: { resolveChild: first.resolve } }, { hold: { resolveChild: second.resolve } }, {}]
    });
    const id = await h.service.start(CONFIG);
    const firstChild = await first.promise;
    await flush();

    expect(h.store.manifests.get(id).items.map((item) => item.relativePath)).toEqual([
      'RecentClips/one.mp4', 'RecentClips/two.mp4', 'RecentClips/three.mp4'
    ]);
    expect(h.log).not.toContain('scanner:end');
    expect(h.log.indexOf('store:transition:discovering:1')).toBeLessThan(h.log.indexOf('scanner:yield:RecentClips/two.mp4'));
    expect(h.spawnProcess).toHaveBeenCalledTimes(1);
    firstChild.emit('close', 0, null);
    const secondChild = await second.promise;
    secondChild.emit('close', 0, null);
    await h.service.whenIdle(id);

    expect(h.active.max).toBe(1);
    expect((await h.service.get(id)).items).toHaveLength(3);
  });

  test('skips already-converted video before encode and copies relevant assets to the mirrored path', async () => {
    const h = harness({
      items: [video('hevc'), asset('event.json')],
      inspectResults: [{ codec: 'h265' }]
    });
    const id = await h.service.start(CONFIG);
    await h.service.whenIdle(id);

    expect(h.spawnProcess).not.toHaveBeenCalled();
    expect(h.ensureDestinationParent).toHaveBeenCalledWith({
      destinationRoot: 'E:\\ConvertedTeslaCam',
      destination: 'E:\\ConvertedTeslaCam\\SentryClips\\event-1\\event.json'
    });
    expect(h.ensureDestinationParent.mock.invocationCallOrder[0])
      .toBeLessThan(h.stagingManager.copyAsset.mock.invocationCallOrder[0]);
    expect(h.revalidateDestinationParent).toHaveBeenCalledTimes(1);
    expect(h.revalidateDestinationParent.mock.invocationCallOrder[0])
      .toBeLessThan(h.stagingManager.copyAsset.mock.invocationCallOrder[0]);
    expect(h.stagingManager.copyAsset).toHaveBeenCalledWith(expect.objectContaining({
      source: 'D:\\TeslaCam\\SentryClips\\event-1\\event.json',
      destination: 'E:\\ConvertedTeslaCam\\SentryClips\\event-1\\event.json',
      destinationRoot: 'E:\\ConvertedTeslaCam'
    }));
    expect((await h.service.get(id)).items.map((item) => item.state)).toEqual(['skipped', 'completed']);
  });

  test('default network policy pauses and resumes when destination containment reports ENOTCONN', async () => {
    const nativeError = Object.assign(new Error('share disconnected'), {
      code: 'ENOTCONN',
      cause: new Error('native network provider failure')
    });
    let attempt = 0;
    const ensureDestinationParent = jest.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw nativeError;
      return { atomicContainment: false, revalidate: jest.fn(async () => undefined) };
    });
    const h = harness({ items: [asset('event.json')], deps: {
      network: undefined,
      ensureDestinationParent
    } });

    const id = await h.service.start(CONFIG);
    await h.service.whenIdle(id);

    expect(ensureDestinationParent).toHaveBeenCalledTimes(2);
    expect(h.events.map(({ type }) => type).filter((type) => ['paused_network', 'network_reconnected'].includes(type)))
      .toEqual(['paused_network', 'network_reconnected']);
    expect((await h.service.get(id)).items[0]).toMatchObject({ state: 'completed', resultCode: 'copied' });
  });

  test('containment retry probes the existing destination root instead of the future asset filename', async () => {
    const destinationRoot = CONFIG.destinationRoot;
    const future = `${destinationRoot}\\SentryClips\\event-1\\event.json`;
    const checks = [];
    const network = {
      isRetryable: jest.fn((error) => error?.code === 'ENOTCONN'),
      checkPath: jest.fn(async (target) => { checks.push(target); return target === destinationRoot; })
    };
    const nativeError = Object.assign(new Error('share disconnected'), { code: 'ENOTCONN' });
    const ensureDestinationParent = jest.fn()
      .mockRejectedValueOnce(nativeError)
      .mockResolvedValue({ atomicContainment: false, revalidate: jest.fn(async () => undefined) });
    const h = harness({ items: [asset('event.json')], deps: { network, ensureDestinationParent } });

    const id = await h.service.start(CONFIG);
    await h.service.whenIdle(id);

    expect(checks).toEqual([destinationRoot]);
    expect(checks).not.toContain(future);
    expect(network.checkPath).toHaveBeenCalledWith(destinationRoot, expect.objectContaining({ allowAncestor: true, signal: expect.any(AbortSignal) }));
    expect((await h.service.get(id)).items[0]).toMatchObject({ state: 'completed' });
  });

  test('containment retry probes the existing destination root instead of the future video filename', async () => {
    const destinationRoot = CONFIG.destinationRoot;
    const future = `${destinationRoot}\\RecentClips\\one.mp4`;
    const checks = [];
    const network = {
      isRetryable: jest.fn((error) => error?.code === 'ENOTCONN'),
      checkPath: jest.fn(async (target) => { checks.push(target); return target === destinationRoot; })
    };
    const nativeError = Object.assign(new Error('share disconnected'), { code: 'ENOTCONN' });
    const ensureDestinationParent = jest.fn()
      .mockRejectedValueOnce(nativeError)
      .mockResolvedValue({ atomicContainment: false, revalidate: jest.fn(async () => undefined) });
    const h = harness({ items: [video('one')], deps: { network, ensureDestinationParent } });

    const id = await h.service.start(CONFIG);
    await h.service.whenIdle(id);

    expect(checks).toEqual([destinationRoot]);
    expect(checks).not.toContain(future);
    expect(network.checkPath).toHaveBeenCalledWith(destinationRoot, expect.objectContaining({ allowAncestor: true, signal: expect.any(AbortSignal) }));
    expect((await h.service.get(id)).items[0]).toMatchObject({ state: 'completed', resultCode: 'converted' });
  });

  test.each(['h265', 'av1'])('passes the exact parked/driving timeline object unchanged to the %s writer', async (codec) => {
    const h = harness();
    const id = await h.service.start({ ...CONFIG, codec });
    await h.service.whenIdle(id);
    const item = (await h.service.get(id)).items[0];
    const timeline = h.timelines.get(item.id);

    expect(h.writers[codec]).toHaveBeenCalledWith(expect.objectContaining({ timeline }));
    expect(h.writers[codec].mock.calls[0][0].timeline).toBe(timeline);
    expect(h.writers[codec].mock.calls[0][0].timeline.samples.map((sample) => sample.hasTelemetry))
      .toEqual([true, false, true]);
    expect(h.ensureDestinationParent).toHaveBeenCalledWith({
      destinationRoot: 'E:\\ConvertedTeslaCam',
      destination: 'E:\\ConvertedTeslaCam\\RecentClips\\2026-08-30_12-00-00-front.mp4'
    });
    expect(h.ensureDestinationParent.mock.invocationCallOrder[0])
      .toBeLessThan(h.stagingManager.publishSeparate.mock.invocationCallOrder[0]);
    expect(h.revalidateDestinationParent).toHaveBeenCalledTimes(1);
    expect(h.revalidateDestinationParent.mock.invocationCallOrder[0])
      .toBeLessThan(h.stagingManager.publishSeparate.mock.invocationCallOrder[0]);
  });

  test('passes one real AbortSignal through inspection, timeline, writers, verifier, and every normal Task 10 call', async () => {
    const h = harness();
    const id = await h.service.start({ ...CONFIG, networkMode: 'staging' });
    await h.service.whenIdle(id);

    const signal = h.inspectVideo.mock.calls[0][2];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(h.readTimeline.mock.calls[0][0].signal).toBe(signal);
    expect(h.writers.h265.mock.calls[0][0].signal).toBe(signal);
    expect(h.verifier.mock.calls[0][0].signal).toBe(signal);
    for (const operation of [
      h.stagingManager.stageSource,
      h.stagingManager.reserveEncodeOutput,
      h.stagingManager.adoptEncodeOutput,
      h.stagingManager.publishSeparate,
      h.stagingManager.cleanupOwnedArtifacts
    ]) {
      expect(operation.mock.calls.length).toBeGreaterThan(0);
      expect(operation.mock.calls.every(([options]) => options.signal === signal)).toBe(true);
    }
  });

  test.each(['inspect', 'timeline', 'writer', 'verifier', 'stage', 'reserve', 'adopt', 'publish', 'replace', 'asset-copy'])(
    'shutdown aborts the same real signal while %s work is active',
    async (phase) => {
      const entered = deferred();
      const blocker = (signal) => new Promise((_resolve, reject) => {
        entered.resolve(signal);
        if (signal.aborted) {
          reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }));
          return;
        }
        signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })), { once: true });
      });
      const deps = {};
      const writers = {};
      const stagingManager = {};
      if (phase === 'inspect') deps.inspectVideo = jest.fn((_item, _path, signal) => blocker(signal));
      if (phase === 'timeline') deps.readTimeline = jest.fn(({ signal }) => blocker(signal));
      if (phase === 'writer') writers.h265 = jest.fn(({ signal }) => blocker(signal));
      if (phase === 'verifier') deps.verifier = jest.fn(({ signal }) => blocker(signal));
      if (phase === 'stage') stagingManager.stageSource = jest.fn(({ signal }) => blocker(signal));
      if (phase === 'reserve') stagingManager.reserveEncodeOutput = jest.fn(({ signal }) => blocker(signal));
      if (phase === 'adopt') stagingManager.adoptEncodeOutput = jest.fn(({ signal }) => blocker(signal));
      if (phase === 'publish') stagingManager.publishSeparate = jest.fn(({ signal }) => blocker(signal));
      if (phase === 'replace') stagingManager.replaceOriginal = jest.fn(({ signal }) => blocker(signal));
      if (phase === 'asset-copy') stagingManager.copyAsset = jest.fn(({ signal }) => blocker(signal));
      const items = phase === 'asset-copy' ? [asset()] : undefined;
      const config = phase === 'replace'
        ? { ...CONFIG, outputMode: 'replace', destinationRoot: null, replacementConfirmed: true }
        : phase === 'stage' ? { ...CONFIG, networkMode: 'staging' } : CONFIG;
      const h = harness({ deps, writers, stagingManager, items });
      const id = await h.service.start(config);
      const signal = await entered.promise;

      await h.service.shutdown();

      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(true);
      expect(await h.service.get(id)).toMatchObject({ state: 'paused' });
    }
  );

  test('adopts FFmpeg output before telemetry writing and refreshes ownership before cleanup', async () => {
    const order = [];
    const h = harness({ items: [video('writer-fails'), video('writer-succeeds')] });
    const baseAdopt = h.stagingManager.adoptEncodeOutput.getMockImplementation();
    h.stagingManager.adoptEncodeOutput.mockImplementation(async (operation) => {
      order.push('adopt');
      return baseAdopt(operation);
    });
    h.writers.h265
      .mockImplementationOnce(async () => {
        order.push('writer');
        throw Object.assign(new Error('writer failed'), { code: 'TELEMETRY_WRITE_FAILED' });
      })
      .mockImplementationOnce(async () => { order.push('writer'); });

    const id = await h.service.start(CONFIG);
    await h.service.whenIdle(id);

    expect(order.slice(0, 2)).toEqual(['adopt', 'writer']);
    expect((await h.service.get(id)).items.map((item) => item.state)).toEqual(['failed', 'completed']);
    expect(h.stagingManager.cleanupOwnedArtifacts).toHaveBeenCalledWith(expect.objectContaining({
      ownedArtifacts: { encodedCandidate: expect.objectContaining({ state: 'owned' }) }
    }));
    expect(h.stagingManager.adoptEncodeOutput).toHaveBeenCalledTimes(4);
  });

  test('uses planner preference then its proven CPU fallback after a hardware process failure', async () => {
    const h = harness({ spawnActions: [{ status: 1 }, { status: 0 }] });
    const id = await h.service.start(CONFIG);
    await h.service.whenIdle(id);

    expect(h.planner.select).toHaveBeenCalledWith('h265');
    expect(h.planner.selectCpuFallback).toHaveBeenCalledWith('h265');
    expect(h.spawnProcess).toHaveBeenCalledTimes(2);
    expect(h.stagingManager.cleanupOwnedArtifacts.mock.calls[0][0]).toMatchObject({
      ownedArtifacts: { encodedCandidate: { state: 'owned' } }
    });
    expect((await h.service.get(id)).items[0]).toMatchObject({ state: 'completed', encoder: 'libx265' });
  });

  test('delegates auto staging to the injected Task 10 classifier, free-space check, and policy', async () => {
    const classifyPath = jest.fn(async () => ({ kind: 'network' }));
    const checkStagingSpace = jest.fn(async () => ({ sufficient: true, requiredBytes: 2_000_000, freeBytes: 3_000_000 }));
    const chooseStagingMode = jest.fn(() => 'staging');
    const h = harness({ deps: { classifyPath, checkStagingSpace, chooseStagingMode } });

    const id = await h.service.start({ ...CONFIG, networkMode: 'auto' });
    await h.service.whenIdle(id);

    expect(classifyPath).toHaveBeenCalledWith('D:\\TeslaCam\\RecentClips\\2026-08-30_12-00-00-front.mp4');
    expect(checkStagingSpace).toHaveBeenCalledWith({ sourceBytes: 1_000_000, outputBytes: 1_000_000 });
    expect(chooseStagingMode).toHaveBeenCalledWith({
      networkMode: 'auto', classification: { kind: 'network' },
      space: { sufficient: true, requiredBytes: 2_000_000, freeBytes: 3_000_000 }
    });
    expect(h.stagingManager.stageSource).toHaveBeenCalledTimes(1);
  });

  test('checks real free space before every forced staging copy', async () => {
    const order = [];
    const checkStagingSpace = jest.fn(async () => {
      order.push('space');
      return { sufficient: true, requiredBytes: 2_000_000, freeBytes: 3_000_000 };
    });
    const stageSource = jest.fn(async ({ source }) => {
      order.push('stage');
      return { stagedSource: source };
    });
    const h = harness({ deps: { checkStagingSpace }, stagingManager: { stageSource } });

    const id = await h.service.start({ ...CONFIG, networkMode: 'staging' });
    await h.service.whenIdle(id);

    expect(checkStagingSpace).toHaveBeenCalledWith({ sourceBytes: 1_000_000, outputBytes: 1_000_000 });
    expect(stageSource).toHaveBeenCalledTimes(1);
    expect(order.slice(0, 2)).toEqual(['space', 'stage']);
  });

  test('fails forced staging before copying when the real space check is insufficient', async () => {
    const checkStagingSpace = jest.fn(async () => ({
      sufficient: false,
      requiredBytes: 2_000_000,
      freeBytes: 1_000_000
    }));
    const stageSource = jest.fn();
    const h = harness({ deps: { checkStagingSpace }, stagingManager: { stageSource } });

    const id = await h.service.start({ ...CONFIG, networkMode: 'staging' });
    await h.service.whenIdle(id);

    expect(checkStagingSpace).toHaveBeenCalledTimes(1);
    expect(stageSource).not.toHaveBeenCalled();
    expect((await h.service.get(id)).items[0]).toMatchObject({
      state: 'failed',
      failure: { code: 'insufficient-staging-space' }
    });
  });

  test('retries one profile-size miss with Task 6 bitrate math and succeeds', async () => {
    const h = harness({ verifyResults: [
      { ok: false, reason: 'profile-size', retryable: true, sourceBytes: 1_000_000, outputBytes: 900_000, details: {} },
      { ok: true, reason: null, retryable: false, sourceBytes: 1_000_000, outputBytes: 800_000, details: {},
        publicationArtifact: { path: 'C:\\snapshot.mp4', token: 't', sha256: 'c'.repeat(64), size: 800_000 } }
    ] });
    const id = await h.service.start(CONFIG);
    await h.service.whenIdle(id);

    expect(h.spawnProcess).toHaveBeenCalledTimes(2);
    expect(h.verifier).toHaveBeenCalledTimes(2);
    const bitrates = h.spawnProcess.mock.calls.map(([, args]) => Number(args[args.indexOf('-b:v') + 1]));
    expect(bitrates[1]).toBeLessThan(bitrates[0]);
    expect((await h.service.get(id)).items[0]).toMatchObject({ state: 'completed', attempts: 2 });
  });

  test('keeps the verification reason when cleanup blocks a size retry', async () => {
    const h = harness({ verifyResults: [
      { ok: false, reason: 'profile-size', retryable: true, sourceBytes: 1000000, outputBytes: 900000 }
    ], stagingManager: { cleanupOwnedArtifacts: jest.fn(async () => ({ cleaned: false, cleanupPending: ['encodedCandidate'] })) } });
    const id = await h.service.start(CONFIG);
    await h.service.whenIdle(id);
    expect((await h.service.get(id)).items[0]).toMatchObject({
      state: 'failed', resultCode: 'cleanup-pending', failure: { code: 'profile-size', retryable: true }
    });
  });

  test('fails a second profile-size miss, cleans ownership, and continues the next file', async () => {
    const miss = { ok: false, reason: 'profile-size', retryable: true, sourceBytes: 1_000_000, outputBytes: 900_000, details: {} };
    const h = harness({ items: [video('bad'), video('good')], verifyResults: [miss, miss] });
    const id = await h.service.start(CONFIG);
    await h.service.whenIdle(id);
    const snapshot = await h.service.get(id);

    expect(snapshot.items.map((item) => item.state)).toEqual(['failed', 'completed']);
    expect(snapshot.items[0].failure).toEqual({ code: 'profile-size', retryable: true });
    expect(h.stagingManager.cleanupOwnedArtifacts).toHaveBeenCalled();
  });

  test('gives only libaom-av1 two fresh size corrections and makes a third miss terminal', async () => {
    const miss = { ok: false, reason: 'profile-size', retryable: true, sourceBytes: 1_000_000, outputBytes: 700_000, details: {} };
    let reservation = 0;
    const reservedPaths = [];
    const reserveEncodeOutput = jest.fn(async ({ jobId, itemId, persistTransaction }) => {
      reservation += 1;
      const nonce = `nonce-${reservation}`;
      const candidate = `C:\\temp\\${jobId}-${itemId}-${nonce}-candidate.mp4`;
      reservedPaths.push(candidate);
      const ownedPaths = { encodedCandidate: candidate };
      const ownedArtifacts = { encodedCandidate: { path: candidate, nonce, state: 'intent' } };
      await persistTransaction({ step: 'encoded-candidate-intent', ownedPaths, ownedArtifacts });
      return { path: candidate, ownedPaths, ownedArtifacts };
    });
    const h = harness({
      verifyResults: [miss, miss, miss],
      planner: { select: jest.fn(async () => ({ family: 'av1', codec: 'libaom-av1', hardware: false })) },
      stagingManager: { reserveEncodeOutput }
    });
    const id = await h.service.start({ ...CONFIG, codec: 'av1' });
    await h.service.whenIdle(id);

    expect(h.spawnProcess).toHaveBeenCalledTimes(3);
    expect(h.verifier).toHaveBeenCalledTimes(3);
    expect(new Set(reservedPaths).size).toBe(3);
    expect(h.stagingManager.cleanupOwnedArtifacts.mock.calls.filter(([operation]) =>
      operation.ownedPaths?.encodedCandidate)).toHaveLength(3);
    expect((await h.service.get(id)).items[0]).toMatchObject({ state: 'failed', attempts: 3,
      failure: { code: 'profile-size' } });
  });

  test.each([
    ['libsvtav1', false], ['av1_nvenc', true], ['libx265', false]
  ])('%s retains the one-correction budget', async (encoder, hardware) => {
    const miss = { ok: false, reason: 'profile-size', retryable: true, sourceBytes: 1_000_000, outputBytes: 700_000, details: {} };
    const codec = encoder === 'libx265' ? 'h265' : 'av1';
    const h = harness({ verifyResults: [miss, miss, miss], planner: {
      select: jest.fn(async () => ({ family: codec, codec: encoder, hardware }))
    } });
    const id = await h.service.start({ ...CONFIG, codec });
    await h.service.whenIdle(id);
    expect(h.spawnProcess).toHaveBeenCalledTimes(2);
    expect(h.verifier).toHaveBeenCalledTimes(2);
  });

  test('counts a valid promoted final once when only post-publication cleanup remains', async () => {
    const partial = 'E:\\ConvertedTeslaCam\\clip.partial';
    const pending = {
      ownedPaths: { destinationPartial: partial },
      ownedArtifacts: { destinationPartial: {
        path: partial, nonce: 'partial-nonce', state: 'cleanup-pending', size: 800000,
        sha256: 'f'.repeat(64), device: '7', inode: '8'
      } }
    };
    const finalPath = 'E:\\ConvertedTeslaCam\\RecentClips\\one.mp4';
    const h = harness({
      stagingManager: {
        publishSeparate: jest.fn(async ({ persistTransaction }) => {
          await persistTransaction({ step: 'separate-complete-cleanup-pending', ...pending });
          const error = Object.assign(new Error('cleanup failed'), {
            code: 'PUBLICATION_CLEANUP_FAILED',
            validFinal: { finalPath, outputBytes: 800000, cleanupPending: ['destinationPartial'], ...pending }
          });
          throw error;
        }),
        cleanupOwnedArtifacts: jest.fn(async (operation) => operation.ownedPaths.destinationPartial
          ? { cleaned: false, cleanupPending: ['destinationPartial'], ...pending }
          : { cleaned: true })
      }
    });
    const id = await h.service.start(CONFIG);
    await h.service.whenIdle(id);

    expect(await h.service.get(id)).toMatchObject({
      state: 'completed',
      counters: { files: 1 },
      items: [{ state: 'completed', resultCode: 'completed-cleanup-pending', outputPath: finalPath }]
    });
    await expect(h.service.retryFailed(id)).rejects.toMatchObject({ code: 'NO_FAILED_ITEMS' });
    expect(h.spawnProcess).toHaveBeenCalledTimes(1);
  });

  test('keeps a durable published final completed when encoded-candidate cleanup remains pending', async () => {
    const finalPath = 'E:\\ConvertedTeslaCam\\RecentClips\\durable.mp4';
    const cleanupOwnedArtifacts = jest.fn(async (operation) => {
      if (!operation.ownedPaths?.encodedCandidate) return { cleaned: true };
      return {
        cleaned: false,
        cleanupPending: ['encodedCandidate'],
        ownedPaths: operation.ownedPaths,
        ownedArtifacts: operation.ownedArtifacts
      };
    });
    const h = harness({
      items: [video('durable')],
      stagingManager: {
        publishSeparate: jest.fn(async () => ({
          finalPath, outputBytes: 800000, ownedPaths: {}, ownedArtifacts: {}, cleanupPending: []
        })),
        cleanupOwnedArtifacts
      }
    });

    const id = await h.service.start(CONFIG);
    await h.service.whenIdle(id);

    expect(await h.service.get(id)).toMatchObject({
      state: 'completed', counters: { files: 1, outputVideoBytes: 800000 },
      items: [{ state: 'completed', resultCode: 'completed-cleanup-pending', outputPath: finalPath }]
    });
    const persisted = h.store.manifests.get(id).items[0];
    expect(persisted.ownedPaths).toHaveProperty('encodedCandidate');
    expect(persisted.ownedArtifacts.encodedCandidate.state).toBe('owned');
    await expect(h.service.retryFailed(id)).rejects.toMatchObject({ code: 'NO_FAILED_ITEMS' });
    expect(h.spawnProcess).toHaveBeenCalledTimes(1);
  });

  test('counts a valid copied asset once when its final persistence leaves cleanup pending', async () => {
    const finalPath = 'E:\\ConvertedTeslaCam\\SentryClips\\event-1\\event.json';
    const partial = `${finalPath}.partial`;
    const pending = {
      ownedPaths: { destinationPartial: partial },
      ownedArtifacts: { destinationPartial: {
        path: partial, nonce: 'asset-nonce', state: 'cleanup-pending', size: 123,
        sha256: 'a'.repeat(64), device: '1', inode: '2'
      } }
    };
    const h = harness({
      items: [asset('event.json')],
      stagingManager: {
        copyAsset: jest.fn(async () => {
          throw Object.assign(new Error('final persistence failed'), {
            code: 'TRANSACTION_STATE_PERSIST_FAILED',
            validFinal: { finalPath, outputBytes: 123, cleanupPending: ['destinationPartial'], ...pending }
          });
        }),
        cleanupOwnedArtifacts: jest.fn(async () => ({ cleaned: false, cleanupPending: ['destinationPartial'], ...pending }))
      }
    });

    const id = await h.service.start(CONFIG);
    await h.service.whenIdle(id);

    expect(await h.service.get(id)).toMatchObject({
      state: 'completed', counters: { files: 0, copiedAssetBytes: 123 },
      items: [{ state: 'completed', resultCode: 'completed-cleanup-pending', outputPath: finalPath }]
    });
    await expect(h.service.retryFailed(id)).rejects.toMatchObject({ code: 'NO_FAILED_ITEMS' });
  });

  test('isolates cleanup-pending ownership from the next queued item failure', async () => {
    const partial = 'E:\\ConvertedTeslaCam\\first.partial';
    const pending = {
      ownedPaths: { destinationPartial: partial },
      ownedArtifacts: { destinationPartial: {
        path: partial, nonce: 'first-nonce', state: 'cleanup-pending', size: 800000,
        sha256: 'f'.repeat(64), device: '7', inode: '8'
      } }
    };
    const h = harness({
      items: [video('first'), video('second')],
      inspectResults: [null, Object.assign(new Error('unsupported'), { code: 'UNSUPPORTED_CODEC' })],
      stagingManager: {
        publishSeparate: jest.fn(async () => ({
          finalPath: 'E:\\ConvertedTeslaCam\\RecentClips\\first.mp4', outputBytes: 800000,
          cleanupPending: ['destinationPartial'], ...pending
        })),
        cleanupOwnedArtifacts: jest.fn(async (operation) => operation.ownedPaths?.destinationPartial === partial
          ? { cleaned: false, cleanupPending: ['destinationPartial'], ...pending }
          : { cleaned: true })
      }
    });

    const id = await h.service.start(CONFIG);
    await h.service.whenIdle(id);
    const persisted = h.store.manifests.get(id);

    expect(persisted.items[0]).toMatchObject({ state: 'completed', ...pending });
    expect(persisted.items[1]).toMatchObject({ state: 'failed' });
    expect(persisted.items[1]).not.toHaveProperty('ownedPaths.destinationPartial');
  });

  test('scopes ordinary per-file failures and continues without persisting exception text', async () => {
    const h = harness({
      items: [video('malformed'), video('good')],
      inspectResults: [Object.assign(new Error('SECRET runner stderr C:\\private'), { code: 'INVALID_MP4' })]
    });
    const id = await h.service.start(CONFIG);
    await h.service.whenIdle(id);
    const text = JSON.stringify(await h.service.get(id));

    expect((await h.service.get(id)).items.map((item) => item.state)).toEqual(['failed', 'completed']);
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('private');
  });

  test('pauses only at a safe file boundary and resumes remaining persisted work', async () => {
    const gate = deferred();
    const h = harness({ items: [video('one'), video('two')], spawnActions: [{ hold: { resolveChild: gate.resolve } }, {}] });
    const id = await h.service.start(CONFIG);
    const child = await gate.promise;
    await h.service.pause(id);
    expect(child.kill).not.toHaveBeenCalled();
    child.emit('close', 0, null);
    await flush();
    expect((await h.service.get(id)).state).toBe('paused');
    expect(h.spawnProcess).toHaveBeenCalledTimes(1);

    await h.service.resume(id);
    await h.service.whenIdle(id);
    expect((await h.service.get(id)).items.map((item) => item.state)).toEqual(['completed', 'completed']);
  });

  test('cancels only its active child and delegates exact owned cleanup to staging', async () => {
    const gate = deferred();
    const h = harness({ spawnActions: [{ hold: { resolveChild: gate.resolve } }] });
    const id = await h.service.start(CONFIG);
    const child = await gate.promise;
    await h.service.cancel(id);
    await h.service.whenIdle(id);

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(h.stagingManager.cleanupOwnedArtifacts).toHaveBeenCalledWith(expect.objectContaining({
      jobId: id,
      itemId: expect.any(String),
      ownedPaths: expect.objectContaining({ encodedCandidate: expect.any(String) })
    }));
    expect((await h.service.get(id)).state).toBe('cancelled');
  });

  test('composes staged-source and encoded-candidate ownership instead of replacing prior obligations', async () => {
    const gate = deferred();
    const stagedSource = 'C:\\temp\\staged-source.mp4';
    const h = harness({
      spawnActions: [{ hold: { resolveChild: gate.resolve } }],
      stagingManager: {
        stageSource: jest.fn(async ({ persistTransaction }) => {
          const ownedPaths = { stagedSource };
          const ownedArtifacts = { stagedSource: {
            path: stagedSource, nonce: 'stage-nonce', state: 'owned', size: 1000000,
            sha256: 'c'.repeat(64), device: '3', inode: '4'
          } };
          await persistTransaction({ step: 'staged-source-owned', ownedPaths, ownedArtifacts });
          return { stagedSource, ownedPaths, ownedArtifacts };
        })
      }
    });
    const id = await h.service.start({ ...CONFIG, networkMode: 'staging' });
    await gate.promise;

    expect(h.store.manifests.get(id).items[0]).toMatchObject({
      ownedPaths: {
        stagedSource,
        encodedCandidate: expect.stringContaining('candidate.mp4')
      },
      ownedArtifacts: {
        stagedSource: { state: 'owned' },
        encodedCandidate: { state: 'intent' }
      }
    });
    await h.service.cancel(id);
  });

  test('retryFailed requeues only failed items without rescanning verified work', async () => {
    const h = harness({ inspectResults: [Object.assign(new Error('bad'), { code: 'INVALID_MP4' })] });
    const id = await h.service.start(CONFIG);
    await h.service.whenIdle(id);
    h.inspectVideo.mockImplementation(async () => ({ codec: 'h264', durationSeconds: 10, containerReserveBytes: 1000, telemetryReserveBytes: 1000 }));

    await h.service.retryFailed(id);
    await h.service.whenIdle(id);
    expect(h.scanner).toHaveBeenCalledTimes(1);
    expect((await h.service.get(id)).items[0].state).toBe('completed');
  });

  test('serializes retry commands, resets the per-run attempt budget, and rejects invalid retry states', async () => {
    const miss = { ok: false, reason: 'profile-size', retryable: true, sourceBytes: 1000000, outputBytes: 900000 };
    const h = harness({ verifyResults: [miss, miss] });
    const id = await h.service.start(CONFIG);
    await h.service.whenIdle(id);
    expect((await h.service.get(id)).items[0].attempts).toBe(2);

    const results = await Promise.allSettled([h.service.retryFailed(id), h.service.retryFailed(id)]);
    await h.service.whenIdle(id);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(h.spawnProcess).toHaveBeenCalledTimes(3);
    expect((await h.service.get(id)).items[0]).toMatchObject({ state: 'completed', attempts: 1 });
    await expect(h.service.retryFailed(id)).rejects.toMatchObject({ code: 'NO_FAILED_ITEMS' });

    const cancelledGate = deferred();
    const cancelled = harness({ spawnActions: [{ hold: { resolveChild: cancelledGate.resolve } }] });
    const cancelledId = await cancelled.service.start(CONFIG);
    await cancelledGate.promise;
    await cancelled.service.cancel(cancelledId);
    await expect(cancelled.service.retryFailed(cancelledId)).rejects.toMatchObject({ code: 'JOB_NOT_RETRYABLE' });
  });

  test('rehydrates and cleans a Task 9 interrupted encode candidate before restarting that item', async () => {
    const h = harness({ items: [] });
    await h.store.create({
      id: 'recover-encode-job', config: CONFIG, counters: {
        files: 0, sourceVideoBytes: 0, outputVideoBytes: 0, savedBytes: 0, copiedAssetBytes: 0,
        groups: {
          RecentClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 },
          SavedClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 },
          SentryClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 }
        }
      },
      state: 'encoding', activeItemId: 'item-1',
      items: [{ ...video('recover-encode'), id: 'item-1', state: 'processing', eligibleVideo: true,
        ownedPaths: { encodedCandidate: 'C:\\temp\\recover-encode-job-item-1-candidate.mp4' },
        ownedArtifacts: { encodedCandidate: {
          path: 'C:\\temp\\recover-encode-job-item-1-candidate.mp4', nonce: 'nonce', state: 'intent'
        } } }]
    });

    await h.service.recover('recover-encode-job', async () => ({ candidateExists: true }));
    await h.service.whenIdle('recover-encode-job');

    expect(h.stagingManager.cleanupOwnedArtifacts.mock.calls[0][0]).toMatchObject({
      ownedArtifacts: { encodedCandidate: { state: 'owned' } }
    });
    expect(h.scanner).not.toHaveBeenCalled();
    expect((await h.service.get('recover-encode-job')).items[0].state).toBe('completed');
  });

  test('executes Task 9 passive discovery recovery and drains persisted plus newly discovered siblings', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sentry-six-job-service-discovery-recover-'));
    temporaryRoots.push(root);
    const store = createJobStore({ rootDir: root, fs: fs.promises });
    await store.create({
      id: 'recover-discovery-job', config: CONFIG, state: 'discovering', discoveryComplete: false,
      counters: {
        files: 0, sourceVideoBytes: 0, outputVideoBytes: 0, savedBytes: 0, copiedAssetBytes: 0,
        groups: {
          RecentClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 },
          SavedClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 },
          SentryClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 }
        }
      },
      summary: null,
      items: [{ ...video('one'), id: 'item-000001', state: 'queued', attempts: 0 }]
    });
    const h = harness({ store, items: [video('one'), video('two')] });

    await h.service.recover('recover-discovery-job', async () => ({}));
    await h.service.whenIdle('recover-discovery-job');

    const completed = await h.service.get('recover-discovery-job');
    expect(completed).toMatchObject({ state: 'completed', discoveryComplete: true });
    expect(completed.items.map((item) => item.relativePath)).toEqual([
      'RecentClips/one.mp4', 'RecentClips/two.mp4'
    ]);
    expect(completed.items.map((item) => item.state)).toEqual(['completed', 'completed']);
  });

  test('requeues the interrupted current item before executing Task 9 waiting recovery', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sentry-six-job-service-waiting-recover-'));
    temporaryRoots.push(root);
    const store = createJobStore({ rootDir: root, fs: fs.promises });
    const counters = {
      files: 0, sourceVideoBytes: 0, outputVideoBytes: 0, savedBytes: 0, copiedAssetBytes: 0,
      groups: {
        RecentClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 },
        SavedClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 },
        SentryClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 }
      }
    };
    await store.create({
      id: 'recover-waiting-job', config: CONFIG, state: 'waiting', discoveryComplete: true,
      activeItemId: 'item-000001', counters, summary: null,
      items: [
        { ...video('one'), id: 'item-000001', state: 'processing', attempts: 0 },
        { ...video('two'), id: 'item-000002', state: 'queued', attempts: 0 }
      ]
    });
    const h = harness({ store, items: [] });

    await h.service.recover('recover-waiting-job', async () => ({}));

    expect(await h.service.get('recover-waiting-job')).toMatchObject({
      state: 'completed', items: [{ state: 'completed' }, { state: 'completed' }], counters: { files: 2 }
    });
    expect(h.scanner).not.toHaveBeenCalled();
  });

  test('resumes a canonical paused-network destination check before restarting the item and siblings', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sentry-six-job-service-network-recover-'));
    temporaryRoots.push(root);
    const store = createJobStore({ rootDir: root, fs: fs.promises });
    const counters = {
      files: 0, sourceVideoBytes: 0, outputVideoBytes: 0, savedBytes: 0, copiedAssetBytes: 0,
      groups: {
        RecentClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 },
        SavedClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 },
        SentryClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 }
      }
    };
    await store.create({
      id: 'recover-network-job', config: CONFIG, state: 'paused_network', discoveryComplete: true,
      activeItemId: 'item-000001', counters, summary: null,
      recovery: { fromState: 'paused_network', action: 'resume-network', pathRole: 'destination' },
      items: [
        { ...video('network-first'), id: 'item-000001', state: 'processing', attempts: 0 },
        { ...video('network-second'), id: 'item-000002', state: 'queued', attempts: 0 }
      ]
    });
    const h = harness({ store, items: [], networkChecks: [false, true] });

    await h.service.recover('recover-network-job', async () => {
      throw new Error('canonical paused-network state should not be inspected');
    });

    expect(h.network.checkPath.mock.calls).toEqual([
      ['E:\\ConvertedTeslaCam', expect.objectContaining({ allowAncestor: true, signal: expect.any(AbortSignal) })],
      ['E:\\ConvertedTeslaCam', expect.objectContaining({ allowAncestor: true, signal: expect.any(AbortSignal) })]
    ]);
    expect(await h.service.get('recover-network-job')).toMatchObject({
      state: 'completed', items: [{ state: 'completed' }, { state: 'completed' }], counters: { files: 2 }
    });
    expect(h.scanner).not.toHaveBeenCalled();
  });

  test('recovers Task 9 copy actions through Task 10 then resumes without archive rewalk', async () => {
    const h = harness({ items: [] });
    await h.store.create({
      id: 'recover-job', config: CONFIG, counters: {
        files: 0, sourceVideoBytes: 0, outputVideoBytes: 0, savedBytes: 0, copiedAssetBytes: 0,
        groups: {
          RecentClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 },
          SavedClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 },
          SentryClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 }
        }
      },
      state: 'copying', activeItemId: 'item-1',
      items: [{ ...video('recover'), id: 'item-1', state: 'processing', eligibleVideo: true,
        publicationArtifact: { path: 'C:\\snapshot.mp4', token: 't', sha256: 'd'.repeat(64), size: 800000 },
        ownedPaths: { publicationSnapshot: 'C:\\snapshot.mp4', destinationPartial: 'E:\\partial' },
        ownedArtifacts: {} }]
    });

    await h.service.recover('recover-job', async () => ({ partialExists: true }));
    expect(h.stagingManager.recoverCopy).toHaveBeenCalledWith(expect.objectContaining({
      action: 'resume-copy', signal: expect.any(AbortSignal)
    }));
    expect(h.revalidateDestinationParent).toHaveBeenCalledTimes(1);
    expect(h.revalidateDestinationParent.mock.invocationCallOrder[0])
      .toBeLessThan(h.stagingManager.recoverCopy.mock.invocationCallOrder[0]);
    expect(h.scanner).not.toHaveBeenCalled();
  });

  test('finishes a recovered publication and then drains persisted queued siblings in order', async () => {
    const h = harness({ items: [] });
    const publicationArtifact = { path: 'C:\\snapshot.mp4', token: 't', sha256: 'd'.repeat(64), size: 800000 };
    await h.store.create({
      id: 'recover-siblings-job', config: CONFIG, discoveryComplete: true, counters: {
        files: 0, sourceVideoBytes: 0, outputVideoBytes: 0, savedBytes: 0, copiedAssetBytes: 0,
        groups: {
          RecentClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 },
          SavedClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 },
          SentryClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 }
        }
      },
      state: 'copying', activeItemId: 'item-1',
      items: [
        { ...video('recover-first'), id: 'item-1', state: 'processing', eligibleVideo: true,
          publicationArtifact, ownedPaths: { publicationSnapshot: publicationArtifact.path }, ownedArtifacts: {} },
        { ...video('queued-second'), id: 'item-2', state: 'queued' }
      ]
    });

    await h.service.recover('recover-siblings-job', async () => ({ partialExists: true }));
    await h.service.whenIdle('recover-siblings-job');

    const completed = await h.service.get('recover-siblings-job');
    expect(completed.items.map((item) => item.state)).toEqual(['completed', 'completed']);
    expect(completed.counters.files).toBe(2);
    expect(h.spawnProcess).toHaveBeenCalledTimes(1);
    expect(h.scanner).not.toHaveBeenCalled();
  });

  test('retains a recovered publication artifact until its owned snapshot cleanup is confirmed', async () => {
    const publicationArtifact = {
      path: 'C:\\snapshot.mp4', token: 'recovery-token', sha256: 'd'.repeat(64), size: 800000
    };
    const pending = {
      ownedPaths: { publicationSnapshot: publicationArtifact.path },
      ownedArtifacts: { publicationSnapshot: {
        path: publicationArtifact.path, nonce: 'snapshot-nonce', state: 'cleanup-pending', size: 800000,
        sha256: publicationArtifact.sha256, device: '1', inode: '2'
      } }
    };
    const cleanupOwnedArtifacts = jest.fn(async () => ({
      cleaned: false, ...pending, cleanupPending: ['publicationSnapshot']
    }));
    const h = harness({
      items: [],
      stagingManager: {
        recoverCopy: jest.fn(async () => ({
          finalPath: 'E:\\ConvertedTeslaCam\\clip.mp4', ...pending, cleanupPending: ['publicationSnapshot']
        })),
        cleanupOwnedArtifacts
      }
    });
    await h.store.create({
      id: 'recover-publication-cleanup', config: CONFIG, discoveryComplete: true,
      counters: {
        files: 0, sourceVideoBytes: 0, outputVideoBytes: 0, savedBytes: 0, copiedAssetBytes: 0,
        groups: {
          RecentClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 },
          SavedClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 },
          SentryClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 }
        }
      },
      state: 'copying', activeItemId: 'item-1', publicationArtifact, ...pending,
      items: [{ ...video('recover-publication'), id: 'item-1', state: 'processing', eligibleVideo: true,
        publicationArtifact, ...pending }]
    });

    await h.service.recover('recover-publication-cleanup', async () => ({ partialExists: true }));

    expect(cleanupOwnedArtifacts).toHaveBeenCalledWith(expect.objectContaining({
      publicationArtifact,
      ownedPaths: { publicationSnapshot: publicationArtifact.path }
    }));
    expect(h.store.manifests.get('recover-publication-cleanup').items[0]).toMatchObject({
      state: 'completed', resultCode: 'completed-cleanup-pending', publicationArtifact, ...pending
    });
  });

  test('serializes real-store recovery so one action and one counter update occur', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sentry-six-job-service-recover-gate-'));
    temporaryRoots.push(root);
    const store = createJobStore({ rootDir: root, fs: fs.promises });
    const publicationArtifact = {
      path: 'C:\\snapshot.mp4', token: 'recover-token', sha256: 'd'.repeat(64), size: 800000
    };
    const ownedPaths = {
      publicationSnapshot: publicationArtifact.path,
      destinationPartial: 'E:\\ConvertedTeslaCam\\clip.partial'
    };
    const ownedArtifacts = {
      publicationSnapshot: {
        path: publicationArtifact.path, nonce: 'snapshot-nonce', state: 'owned', size: 800000,
        sha256: publicationArtifact.sha256, device: '1', inode: '2'
      },
      destinationPartial: {
        path: ownedPaths.destinationPartial, nonce: 'partial-nonce', state: 'owned', size: 800000,
        sha256: publicationArtifact.sha256, device: '1', inode: '3'
      }
    };
    await store.create({
      id: 'serialized-recovery', config: CONFIG, state: 'copying', discoveryComplete: true,
      activeItemId: 'item-000001', counters: emptyCounters(), summary: null,
      publicationArtifact, ownedPaths, ownedArtifacts,
      items: [{ ...video('serialized-recovery'), id: 'item-000001', state: 'processing', attempts: 1,
        eligibleVideo: true, publicationArtifact, ownedPaths, ownedArtifacts }]
    });
    const entered = deferred();
    const release = deferred();
    const recoverCopy = jest.fn(async () => {
      entered.resolve();
      await release.promise;
      return { finalPath: 'E:\\ConvertedTeslaCam\\RecentClips\\serialized-recovery.mp4',
        ownedPaths: {}, ownedArtifacts: {}, cleanupPending: [] };
    });
    const h = harness({ store, items: [], stagingManager: { recoverCopy } });

    const first = h.service.recover('serialized-recovery', async () => ({ partialExists: true }));
    await entered.promise;
    const second = h.service.recover('serialized-recovery', async () => ({ partialExists: true }));
    await flush();
    release.resolve();
    const results = await Promise.allSettled([first, second]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')?.reason).toMatchObject({ code: 'JOB_ACTIVE' });
    expect(recoverCopy).toHaveBeenCalledTimes(1);
    await expect(store.load('serialized-recovery')).resolves.toMatchObject({
      state: 'completed', counters: { files: 1 }, items: [{ state: 'completed' }]
    });

    await h.service.recover('serialized-recovery', async () => {
      throw new Error('completed recovery must be idempotent');
    });
    expect(recoverCopy).toHaveBeenCalledTimes(1);
    expect((await store.load('serialized-recovery')).counters.files).toBe(1);
  });

  test('does not rerun or recount an item durably completed before recovery bookkeeping crashed', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sentry-six-recovery-idempotent-counter-'));
    temporaryRoots.push(root);
    const store = createJobStore({ rootDir: root, fs: fs.promises });
    const counters = emptyCounters();
    counters.files = 1;
    counters.sourceVideoBytes = 1000000;
    counters.outputVideoBytes = 800000;
    counters.savedBytes = 200000;
    counters.groups.RecentClips = { files: 1, sourceBytes: 1000000, outputBytes: 800000, savedBytes: 200000 };
    const completed = {
      ...video('already-completed'), id: 'item-000001', state: 'completed', attempts: 1,
      eligibleVideo: true, outputPath: 'E:\\ConvertedTeslaCam\\RecentClips\\already-completed.mp4',
      outputBytes: 800000, resultCode: 'converted'
    };
    await store.create({
      id: 'idempotent-recovery', config: CONFIG, state: 'paused', discoveryComplete: true,
      activeItemId: completed.id, counters, summary: null,
      recovery: { fromState: 'copying', action: 'restart-copy' },
      items: [completed]
    });
    const recoverCopy = jest.fn(async () => ({
      finalPath: completed.outputPath, ownedPaths: {}, ownedArtifacts: {}, cleanupPending: []
    }));
    const h = harness({ store, items: [], stagingManager: { recoverCopy } });

    await h.service.recover('idempotent-recovery', async () => ({}));

    expect(recoverCopy).not.toHaveBeenCalled();
    await expect(store.load('idempotent-recovery')).resolves.toMatchObject({
      state: 'completed', counters: { files: 1, sourceVideoBytes: 1000000, outputVideoBytes: 800000 }
    });
  });

  test.each(['shutdown', 'cancel'])(
    '%s aborts and awaits blocked real-store recovery inspection without resuming work',
    async (command) => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `sentry-six-recovery-${command}-`));
      temporaryRoots.push(root);
      const store = createJobStore({ rootDir: root, fs: fs.promises });
      await store.create({
        id: `blocked-recovery-${command}`, config: CONFIG, state: 'encoding', discoveryComplete: true,
        activeItemId: 'item-000001', counters: emptyCounters(), summary: null,
        items: [{ ...video(`blocked-${command}`), id: 'item-000001', state: 'processing', attempts: 1,
          eligibleVideo: true }]
      });
      const entered = deferred();
      const fallbackRelease = deferred();
      const inspect = jest.fn(async (_manifest, context = {}) => {
        entered.resolve(context.signal);
        if (!context.signal) return fallbackRelease.promise;
        if (!context.signal.aborted) {
          await new Promise((resolve) => context.signal.addEventListener('abort', resolve, { once: true }));
        }
        throw Object.assign(new Error('inspection cancelled'), { code: 'CANCELLED' });
      });
      const h = harness({ store, items: [] });
      const recovery = h.service.recover(`blocked-recovery-${command}`, inspect);
      const signal = await entered.promise;

      const stopping = command === 'shutdown'
        ? h.service.shutdown()
        : h.service.cancel(`blocked-recovery-${command}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      fallbackRelease.resolve({});
      await stopping;
      await recovery;

      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(true);
      expect(h.spawnProcess).not.toHaveBeenCalled();
      await expect(store.load(`blocked-recovery-${command}`)).resolves.toMatchObject({
        state: command === 'shutdown' ? 'paused' : 'cancelled'
      });
      if (command === 'shutdown') {
        await expect(h.service.recover(`blocked-recovery-${command}`, async () => ({})))
          .rejects.toMatchObject({ code: 'SERVICE_SHUTDOWN' });
      }
    }
  );

  test('turns Task 9 restart-copy into a fresh Task 10 publication from the retained snapshot', async () => {
    const h = harness({
      items: [],
      stagingManager: { recoverCopy: jest.fn(async () => ({ action: 'restart-copy' })) }
    });
    const publicationArtifact = { path: 'C:\\snapshot.mp4', token: 't', sha256: 'd'.repeat(64), size: 800000 };
    await h.store.create({
      id: 'restart-copy-job', config: CONFIG, counters: {
        files: 0, sourceVideoBytes: 0, outputVideoBytes: 0, savedBytes: 0, copiedAssetBytes: 0,
        groups: {
          RecentClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 },
          SavedClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 },
          SentryClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 }
        }
      },
      state: 'copying', activeItemId: 'item-1',
      publicationArtifact,
      items: [{ ...video('restart-copy'), id: 'item-1', state: 'processing', eligibleVideo: true,
        publicationArtifact, ownedPaths: { publicationSnapshot: publicationArtifact.path }, ownedArtifacts: {} }]
    });

    await h.service.recover('restart-copy-job', async () => ({}));
    const recoverySignal = h.stagingManager.recoverCopy.mock.calls[0][0].signal;
    expect(recoverySignal).toBeInstanceOf(AbortSignal);
    expect(h.stagingManager.publishSeparate).toHaveBeenCalledWith(expect.objectContaining({
      publicationArtifact, signal: recoverySignal
    }));
    expect(h.revalidateDestinationParent).toHaveBeenCalledTimes(2);
    expect(h.revalidateDestinationParent.mock.invocationCallOrder[1])
      .toBeLessThan(h.stagingManager.publishSeparate.mock.invocationCallOrder[0]);
    expect((await h.service.get('restart-copy-job')).state).toBe('completed');
  });

  test('ownership-cleans an interrupted asset partial and safely restarts its bounded copy', async () => {
    const h = harness({ items: [] });
    await h.store.create({
      id: 'recover-asset-job', config: CONFIG, counters: {
        files: 0, sourceVideoBytes: 0, outputVideoBytes: 0, savedBytes: 0, copiedAssetBytes: 0,
        groups: {
          RecentClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 },
          SavedClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 },
          SentryClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 }
        }
      },
      state: 'copying', activeItemId: 'asset-1',
      items: [{ ...asset('event.json'), id: 'asset-1', state: 'processing', eligibleVideo: false,
        ownedPaths: { destinationPartial: 'E:\\partial' },
        ownedArtifacts: { destinationPartial: { path: 'E:\\partial', nonce: 'n', state: 'owned' } } }]
    });

    await h.service.recover('recover-asset-job', async () => ({ partialExists: true }));
    const recoverySignal = h.stagingManager.cleanupOwnedArtifacts.mock.calls[0][0].signal;
    expect(recoverySignal).toBeInstanceOf(AbortSignal);
    expect(h.stagingManager.cleanupOwnedArtifacts).toHaveBeenCalledWith(expect.objectContaining({
      itemId: 'asset-1', signal: recoverySignal
    }));
    expect(h.stagingManager.copyAsset).toHaveBeenCalledWith(expect.objectContaining({
      destination: 'E:\\ConvertedTeslaCam\\SentryClips\\event-1\\event.json', signal: recoverySignal
    }));
    expect(h.revalidateDestinationParent).toHaveBeenCalledTimes(1);
    expect(h.revalidateDestinationParent.mock.invocationCallOrder[0])
      .toBeLessThan(h.stagingManager.copyAsset.mock.invocationCallOrder[0]);
    expect(await h.service.get('recover-asset-job')).toMatchObject({
      state: 'completed', counters: { files: 0, copiedAssetBytes: 123 }
    });
  });

  test('retains asset transaction ownership and cleanup-pending state when copy and cleanup fail', async () => {
    const partial = 'E:\\ConvertedTeslaCam\\event.partial';
    const ownership = {
      ownedPaths: { destinationPartial: partial },
      ownedArtifacts: { destinationPartial: {
        path: partial, nonce: 'asset-nonce', state: 'cleanup-pending', size: 12,
        sha256: 'e'.repeat(64), device: '5', inode: '6'
      } }
    };
    const h = harness({
      items: [asset('event.json')],
      stagingManager: {
        copyAsset: jest.fn(async ({ persistTransaction }) => {
          await persistTransaction({ step: 'asset-partial-owned', ...ownership });
          const error = Object.assign(new Error('destination failed'), {
            code: 'DESTINATION_WRITE_FAILED', cleanupPending: ['destinationPartial']
          });
          throw error;
        }),
        cleanupOwnedArtifacts: jest.fn(async () => ({
          cleaned: false, cleanupPending: ['destinationPartial'], ...ownership
        }))
      }
    });

    const id = await h.service.start(CONFIG);
    await h.service.whenIdle(id);
    const persisted = h.store.manifests.get(id);

    expect(persisted.items[0]).toMatchObject({
      state: 'failed', resultCode: 'cleanup-pending', ...ownership
    });
    expect(persisted).toMatchObject({ ...ownership });
  });

  test.each(['h265', 'av1'].flatMap(codec =>
    ['backup-deleted', 'original-backed-up', 'candidate-promoted', 'final-validated', 'restart-replacement']
      .map(phase => [phase, codec])))(
    'finishes recovered replacement or explicitly pauses the intermediate %s phase (%s)', async (phase, codec) => {
    const h = harness({ items: [], stagingManager: {
      recoverReplacement: async ({ codec: receivedCodec }) => {
        if (receivedCodec !== codec) throw new Error('missing recovery codec');
        return phase === 'restart-replacement' ? { action: phase, ownedPaths: {}, ownedArtifacts: {} }
          : { phase, ownedPaths: {}, ownedArtifacts: {} };
      },
      replaceOriginal: async ({ codec: receivedCodec, source, publicationArtifact }) => {
        if (receivedCodec !== codec) throw new Error('missing restart codec');
        return { phase: 'backup-deleted', finalPath: source, outputBytes: publicationArtifact.size, ownedPaths: {}, ownedArtifacts: {} };
      }
    } });
    const replaceConfig = { ...CONFIG, codec, destinationRoot: null, outputMode: 'replace', replacementConfirmed: true };
    const publicationArtifact = { path: 'C:\\snapshot.mp4', token: 't', sha256: 'e'.repeat(64), size: 800000 };
    await h.store.create({
      id: 'recover-replace-job', config: replaceConfig, counters: {
        files: 0, sourceVideoBytes: 0, outputVideoBytes: 0, savedBytes: 0, copiedAssetBytes: 0,
        groups: {
          RecentClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 },
          SavedClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 },
          SentryClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 }
        }
      },
      state: 'replacing', activeItemId: 'item-1', replacementPhase: 'final-validated',
      publicationArtifact,
      items: [{ ...video('recover-replace'), id: 'item-1', state: 'processing', eligibleVideo: true,
        expectedSource: { size: 1000000, sha256: 'c'.repeat(64), device: '1', inode: '2' },
        publicationArtifact, replacementPhase: 'final-validated', ownedPaths: {}, ownedArtifacts: {} }]
    });

    await h.service.recover('recover-replace-job', async () => ({}));
    expect(await h.service.get('recover-replace-job')).toMatchObject(['backup-deleted', 'restart-replacement'].includes(phase) ? {
      state: 'completed',
      items: [{ state: 'completed', outputPath: 'D:\\TeslaCam\\RecentClips\\recover-replace.mp4' }]
    } : {
      state: 'paused', activeItemId: 'item-1', replacementPhase: phase,
      recovery: { fromState: 'replacing', phase, action: 'manual-intervention' },
      items: [{ state: 'processing' }]
    });
  });

  test('recovers the exact candidate-written replacement after a persisted network pause', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sentry-six-network-replacement-'));
    temporaryRoots.push(root);
    const store = createJobStore({ rootDir: root, fs: fs.promises });
    const config = { ...CONFIG, destinationRoot: null, outputMode: 'replace', replacementConfirmed: true };
    const publicationArtifact = {
      path: 'C:\\snapshot.mp4', token: 'replacement-token', sha256: 'e'.repeat(64), size: 800000
    };
    const ownedPaths = {
      publicationSnapshot: publicationArtifact.path,
      replacementCandidate: 'D:\\TeslaCam\\RecentClips\\network-replace.candidate'
    };
    const ownedArtifacts = {
      publicationSnapshot: {
        path: publicationArtifact.path, nonce: 'snapshot-nonce', state: 'owned', size: 800000,
        sha256: publicationArtifact.sha256, device: '1', inode: '2'
      },
      replacementCandidate: {
        path: ownedPaths.replacementCandidate, nonce: 'candidate-nonce', state: 'intent'
      }
    };
    await store.create({
      id: 'network-replacement', config, state: 'paused_network', discoveryComplete: true,
      activeItemId: 'item-000001', counters: emptyCounters(), summary: null,
      replacementPhase: 'candidate-written', publicationArtifact, ownedPaths, ownedArtifacts,
      recovery: {
        fromState: 'paused_network', action: 'resume-network', pathRole: 'source',
        resumeState: 'replacing', phase: 'candidate-written'
      },
      items: [{ ...video('network-replace'), id: 'item-000001', state: 'processing', attempts: 1,
        expectedSource: { size: 1000000, sha256: 'c'.repeat(64), device: '1', inode: '2' },
        eligibleVideo: true, replacementPhase: 'candidate-written', publicationArtifact, ownedPaths, ownedArtifacts }]
    });
    const recoverReplacement = jest.fn(async () => ({
      phase: 'backup-deleted', ownedPaths: {}, ownedArtifacts: {}, cleanupPending: []
    }));
    const h = harness({ store, items: [], networkChecks: [true], stagingManager: { recoverReplacement } });

    await h.service.recover('network-replacement', async () => ({
      candidateExists: true, sourceExists: true
    }));

    expect(h.network.checkPath).toHaveBeenCalledWith(
      'D:\\TeslaCam\\RecentClips\\network-replace.mp4', expect.objectContaining({ allowAncestor: false, signal: expect.any(AbortSignal) })
    );
    expect(recoverReplacement).toHaveBeenCalledWith(expect.objectContaining({
      action: 'backup-original', signal: expect.any(AbortSignal)
    }));
    await expect(store.load('network-replacement')).resolves.toMatchObject({
      state: 'completed', counters: { files: 1 }, items: [{ state: 'completed' }]
    });
  });

  test('pauses on a network fault, retries only the affected path with capped backoff, and does not rescan', async () => {
    const networkError = Object.assign(new Error('share down'), { code: 'ENETDOWN', path: 'D:\\TeslaCam\\RecentClips\\one.mp4' });
    const h = harness({
      items: [video('one')],
      inspectResults: [networkError, { codec: 'h264', durationSeconds: 10, containerReserveBytes: 1000, telemetryReserveBytes: 1000 }],
      networkChecks: [false, false, true],
      deps: { networkBackoff: { initialMs: 25, maximumMs: 50 } }
    });
    const id = await h.service.start(CONFIG);
    await h.service.whenIdle(id);

    expect(h.network.checkPath).toHaveBeenCalledTimes(3);
    expect(h.network.checkPath.mock.calls.every(([target]) => target === networkError.path)).toBe(true);
    expect(h.network.checkPath.mock.calls.every(([, options]) => options?.allowAncestor === false)).toBe(true);
    expect(h.sleeps).toEqual([25, 50]);
    expect(h.scanner).toHaveBeenCalledTimes(1);
    expect(h.events.some((event) => event.type === 'paused_network')).toBe(true);
  });

  test('a permanently missing source remains paused without a false reconnect or retry reset', async () => {
    const checked = deferred();
    const sleeping = deferred();
    const sourceError = Object.assign(new Error('source missing'), {
      code: 'ENETDOWN', path: 'D:\\TeslaCam\\RecentClips\\missing-source.mp4'
    });
    const network = {
      isRetryable: jest.fn((error) => error?.code === 'ENETDOWN'),
      checkPath: jest.fn(async (_target, options) => {
        checked.resolve();
        return options?.allowAncestor === true;
      })
    };
    const clock = {
      now: jest.fn(() => 1_000),
      sleep: jest.fn(() => sleeping.promise)
    };
    const h = harness({
      items: [video('missing-source')],
      inspectResults: [sourceError],
      deps: { network, clock }
    });

    const id = await h.service.start(CONFIG);
    await checked.promise;
    expect(network.checkPath).toHaveBeenCalledWith(sourceError.path, expect.objectContaining({ allowAncestor: false, signal: expect.any(AbortSignal) }));
    expect(h.events.filter(({ type }) => type === 'network_reconnected')).toHaveLength(0);
    expect(h.inspectVideo).toHaveBeenCalledTimes(1);

    await h.service.cancel(id);
    await expect(h.service.get(id)).resolves.toMatchObject({ state: 'cancelled' });
  });

  test('persists canonical paused-network recovery before waiting on the affected source', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sentry-six-job-service-network-persist-'));
    temporaryRoots.push(root);
    const store = createJobStore({ rootDir: root, fs: fs.promises });
    const waiting = deferred();
    const reconnect = deferred();
    const network = {
      isRetryable: jest.fn((error) => error?.code === 'ENETDOWN'),
      checkPath: jest.fn(async () => {
        waiting.resolve();
        await reconnect.promise;
        return true;
      })
    };
    const fault = Object.assign(new Error('source unavailable'), { code: 'ENETDOWN' });
    const h = harness({
      store,
      inspectResults: [fault, { codec: 'h264', durationSeconds: 10, containerReserveBytes: 1000, telemetryReserveBytes: 1000 }],
      deps: { network }
    });
    const id = await h.service.start(CONFIG);
    await waiting.promise;

    await expect(store.load(id)).resolves.toMatchObject({
      state: 'paused_network', activeItemId: 'item-000001',
      recovery: { fromState: 'paused_network', action: 'resume-network', pathRole: 'source' }
    });

    reconnect.resolve();
    await h.service.whenIdle(id);
    await expect(store.load(id)).resolves.toMatchObject({ state: 'completed' });
  });

  test('keeps a producer network wait out of an active consumer transaction and resumes the same iterator', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sentry-six-producer-network-concurrency-'));
    temporaryRoots.push(root);
    const store = createJobStore({ rootDir: root, fs: fs.promises });
    const consumerEntered = deferred();
    const consumerRelease = deferred();
    const networkWaiting = deferred();
    const reconnect = deferred();
    let traversalAttempts = 0;
    const scanner = jest.fn(async function* (_config, { retryOperation }) {
      yield video('consumer-active');
      await consumerEntered.promise;
      await retryOperation({
        path: 'D:\\TeslaCam\\SentryClips',
        operation: async () => {
          traversalAttempts += 1;
          if (traversalAttempts === 1) throw Object.assign(new Error('directory unavailable'), { code: 'ENETDOWN' });
          return true;
        }
      });
      yield video('after-reconnect');
    });
    const stageSource = jest.fn(async ({ source }) => {
      consumerEntered.resolve();
      await consumerRelease.promise;
      return { stagedSource: source };
    });
    const network = {
      isRetryable: jest.fn((error) => error?.code === 'ENETDOWN'),
      checkPath: jest.fn(async () => {
        networkWaiting.resolve();
        await reconnect.promise;
        return true;
      })
    };
    const h = harness({
      store,
      deps: { scanner, network },
      stagingManager: { stageSource }
    });
    const id = await h.service.start({ ...CONFIG, networkMode: 'staging' });
    await networkWaiting.promise;
    const duringFault = await store.load(id);

    reconnect.resolve();
    consumerRelease.resolve();
    await h.service.whenIdle(id);

    expect(duringFault).toMatchObject({
      state: 'staging', activeItemId: 'item-000001', discoveryComplete: false
    });
    expect(duringFault).not.toHaveProperty('recovery');
    expect(traversalAttempts).toBe(2);
    expect(scanner).toHaveBeenCalledTimes(1);
    expect(h.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      'paused_network', 'network_reconnected'
    ]));
    await expect(store.load(id)).resolves.toMatchObject({
      state: 'completed', discoveryComplete: true,
      counters: { files: 2 }, items: [{ state: 'completed' }, { state: 'completed' }]
    });
  });

  test('uses Task 10 destination error classification to retry only the affected asset transaction', async () => {
    const destination = 'E:\\ConvertedTeslaCam\\SentryClips\\event-1\\event.json';
    const checks = [false, true];
    const network = {
      isRetryable: jest.fn(() => false),
      isPathUnavailable: jest.fn((error, affectedPath) => error?.code === 'DESTINATION_WRITE_FAILED'
        && affectedPath === destination),
      checkPath: jest.fn(async () => checks.shift())
    };
    const copyAsset = jest.fn()
      .mockImplementationOnce(async ({ persistTransaction }) => {
        const partial = `${destination}.partial`;
        await persistTransaction({
          step: 'asset-partial-intent',
          ownedPaths: { destinationPartial: partial },
          ownedArtifacts: { destinationPartial: { path: partial, nonce: 'n', state: 'intent' } }
        });
        throw Object.assign(new Error('bounded destination failure'), { code: 'DESTINATION_WRITE_FAILED' });
      })
      .mockResolvedValue({ finalPath: destination, outputBytes: 123, ownedPaths: {}, ownedArtifacts: {}, cleanupPending: [] });
    const h = harness({
      items: [asset('event.json')],
      stagingManager: { copyAsset },
      deps: { network, networkBackoff: { initialMs: 10, maximumMs: 20 } }
    });

    const id = await h.service.start(CONFIG);
    await h.service.whenIdle(id);

    expect(copyAsset).toHaveBeenCalledTimes(2);
    expect(network.isPathUnavailable).toHaveBeenCalledWith(expect.objectContaining({ code: 'DESTINATION_WRITE_FAILED' }), destination);
    expect(network.checkPath.mock.calls).toEqual([
      [CONFIG.destinationRoot, expect.objectContaining({ allowAncestor: true, signal: expect.any(AbortSignal) })],
      [CONFIG.destinationRoot, expect.objectContaining({ allowAncestor: true, signal: expect.any(AbortSignal) })]
    ]);
    expect(h.scanner).toHaveBeenCalledTimes(1);
    expect((await h.service.get(id)).items[0].state).toBe('completed');
  });

  test('attributes a Task 10 video publication fault to the destination before restarting that file', async () => {
    const destination = 'E:\\ConvertedTeslaCam\\RecentClips\\one.mp4';
    const checks = [true];
    const network = {
      isRetryable: jest.fn(() => false),
      isPathUnavailable: jest.fn((error, affectedPath) => error?.code === 'DESTINATION_WRITE_FAILED'
        && affectedPath === destination),
      checkPath: jest.fn(async () => checks.shift())
    };
    const publishSeparate = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('destination unavailable'), { code: 'DESTINATION_WRITE_FAILED' }))
      .mockResolvedValue({ finalPath: destination, outputBytes: 800000, ownedPaths: {}, ownedArtifacts: {}, cleanupPending: [] });
    const h = harness({
      items: [video('one')],
      stagingManager: { publishSeparate },
      deps: { network }
    });

    const id = await h.service.start(CONFIG);
    await h.service.whenIdle(id);

    expect(network.isPathUnavailable).toHaveBeenCalledWith(expect.objectContaining({ code: 'DESTINATION_WRITE_FAILED' }), destination);
    expect(network.checkPath).toHaveBeenCalledWith(CONFIG.destinationRoot, expect.objectContaining({ allowAncestor: true, signal: expect.any(AbortSignal) }));
    expect(publishSeparate).toHaveBeenCalledTimes(2);
    expect(h.scanner).toHaveBeenCalledTimes(1);
    expect((await h.service.get(id)).items[0].state).toBe('completed');
  });

  test('reconciles the entire staged ownership set before a network retry creates a new nonce', async () => {
    let stageSequence = 0;
    const stagedPaths = [];
    const stageSource = jest.fn(async ({ persistTransaction }) => {
      stageSequence += 1;
      const stagedSource = `C:\\temp\\stage-${stageSequence}.mp4`;
      stagedPaths.push(stagedSource);
      const ownedPaths = { stagedSource };
      const ownedArtifacts = { stagedSource: {
        path: stagedSource, nonce: `stage-${stageSequence}`, state: 'owned', size: 1000000,
        sha256: 'a'.repeat(64), device: '1', inode: String(stageSequence)
      } };
      await persistTransaction({ step: 'staged-source-owned', ownedPaths, ownedArtifacts });
      return { stagedSource, ownedPaths, ownedArtifacts };
    });
    const networkFault = Object.assign(new Error('staged read unavailable'), { code: 'ENETDOWN' });
    const readTimeline = jest.fn()
      .mockRejectedValueOnce(networkFault)
      .mockResolvedValue({ samples: [], events: [] });
    const cleanupOwnedArtifacts = jest.fn(async () => ({ cleaned: true }));
    const h = harness({
      stagingManager: { stageSource, cleanupOwnedArtifacts },
      networkChecks: [true],
      deps: { readTimeline }
    });

    const id = await h.service.start({ ...CONFIG, networkMode: 'staging' });
    await h.service.whenIdle(id);

    expect(stageSource).toHaveBeenCalledTimes(2);
    expect(stagedPaths[1]).not.toBe(stagedPaths[0]);
    expect(cleanupOwnedArtifacts.mock.calls[0][0]).toMatchObject({
      ownedPaths: { stagedSource: stagedPaths[0] },
      ownedArtifacts: { stagedSource: { nonce: 'stage-1' } }
    });
    expect((await h.service.get(id)).items[0].state).toBe('completed');
  });

  test('blocks retry with a retained original and reconciles ordinary artifacts before one serialized retry run', async () => {
    const ownership = {
      ownedPaths: {
        stagedSource: 'C:\\temp\\old-stage.mp4',
        publicationSnapshot: 'C:\\temp\\old-snapshot.mp4',
        destinationPartial: 'E:\\ConvertedTeslaCam\\old.partial',
        replacementCandidate: 'D:\\TeslaCam\\old.candidate',
        replacementBackup: 'D:\\TeslaCam\\old.backup'
      },
      ownedArtifacts: {}
    };
    for (const [index, [key, artifactPath]] of Object.entries(ownership.ownedPaths).entries()) {
      ownership.ownedArtifacts[key] = {
        path: artifactPath, nonce: `old-${index}`, state: 'owned', size: 1,
        sha256: 'b'.repeat(64), device: '1', inode: String(index + 1)
      };
    }
    const publicationArtifact = {
      path: ownership.ownedPaths.publicationSnapshot, token: 'old-token', sha256: 'b'.repeat(64), size: 1
    };
    const counters = {
      files: 0, sourceVideoBytes: 0, outputVideoBytes: 0, savedBytes: 0, copiedAssetBytes: 0,
      groups: {
        RecentClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 },
        SavedClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 },
        SentryClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 }
      }
    };
    async function seeded(cleanupOwnedArtifacts) {
      const h = harness({ items: [], stagingManager: { cleanupOwnedArtifacts } });
      await h.store.create({
        id: `retry-owned-${cleanupOwnedArtifacts.getMockName()}`, config: CONFIG, state: 'completed',
        discoveryComplete: true, counters, summary: {},
        items: [{ ...video('retry-owned'), id: 'item-000001', state: 'failed', attempts: 2,
          eligibleVideo: true, failure: { code: 'encoder-failed', retryable: true },
          publicationArtifact, ...ownership }]
      });
      return h;
    }

    const blockedCleanup = jest.fn(async (operation) => ({
      cleaned: false, cleanupPending: Object.keys(operation.ownedPaths),
      ownedPaths: operation.ownedPaths, ownedArtifacts: operation.ownedArtifacts
    })).mockName('blocked');
    const blocked = await seeded(blockedCleanup);
    await expect(blocked.service.retryFailed('retry-owned-blocked')).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(blocked.spawnProcess).not.toHaveBeenCalled();
    expect(blocked.store.manifests.get('retry-owned-blocked').items[0].ownedPaths).toEqual(ownership.ownedPaths);

    // A different fixture with only ordinary artifacts may use generic cleanup.
    delete ownership.ownedPaths.replacementBackup;
    delete ownership.ownedArtifacts.replacementBackup;

    const successfulCleanup = jest.fn(async () => ({ cleaned: true })).mockName('successful');
    const successful = await seeded(successfulCleanup);
    const results = await Promise.allSettled([
      successful.service.retryFailed('retry-owned-successful'),
      successful.service.retryFailed('retry-owned-successful')
    ]);
    await successful.service.whenIdle('retry-owned-successful');
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(successfulCleanup.mock.calls[0][0]).toMatchObject({ ...ownership, publicationArtifact });
    expect(successful.spawnProcess).toHaveBeenCalledTimes(1);
    const completed = successful.store.manifests.get('retry-owned-successful').items[0];
    expect(completed.state).toBe('completed');
    for (const oldPath of Object.values(ownership.ownedPaths)) {
      expect(Object.values(completed.ownedPaths || {})).not.toContain(oldPath);
    }
  });

  test('counts only completed eligible videos, keeps loose clips out of group rows, and formats GB/TB summaries', async () => {
    const gib = 1024 ** 3;
    const h = harness({
      items: [
        video('grouped', { group: 'SavedClips', sourceBytes: 2 * gib }),
        video('loose', { group: null, relativePath: 'loose.mp4', sourceBytes: 2 * 1024 ** 4 }),
        asset('event.json')
      ],
      verifyResults: [
        { ok: true, sourceBytes: 2 * gib, outputBytes: gib, publicationArtifact: { path: 'C:\\a', token: 'a', sha256: 'a'.repeat(64), size: gib } },
        { ok: true, sourceBytes: 2 * 1024 ** 4, outputBytes: 1024 ** 4, publicationArtifact: { path: 'C:\\b', token: 'b', sha256: 'b'.repeat(64), size: 1024 ** 4 } }
      ]
    });
    const id = await h.service.start(CONFIG);
    await h.service.whenIdle(id);
    const summary = (await h.service.get(id)).summary;

    expect(summary.files).toBe(2);
    expect(summary.groups.SavedClips.files).toBe(1);
    expect(Object.values(summary.groups).reduce((n, group) => n + group.files, 0)).toBe(1);
    expect(summary.source).toMatch(/TiB$/);
    expect(summary.groups.SavedClips.sourceBytes).toBe(2 * gib);
    expect(summary.copiedAssetBytes).toBe(123);
  });

  test('spawns no-shell argument arrays, parses progress without persistence, and emits frozen revisioned snapshots', async () => {
    const h = harness({ spawnActions: [{ chunks: ['frame=2\nout_time_ms=250000\nprogress=continue\n', 'progress=end\n'] }] });
    const listener = jest.fn(() => { throw new Error('listener isolation'); });
    const unsubscribe = h.service.subscribe(listener);
    const id = await h.service.start(CONFIG);
    await h.service.whenIdle(id);
    unsubscribe();
    const [, args, options] = h.spawnProcess.mock.calls[0];

    expect(Array.isArray(args)).toBe(true);
    expect(args).toEqual(expect.arrayContaining(['-progress', 'pipe:1', '-n', '-i']));
    expect(options).toMatchObject({ shell: false, windowsHide: true });
    expect(h.events.some((event) => event.type === 'progress' && event.progress.outTimeUs === 250000)).toBe(true);
    expect(h.events.every((event) => Object.isFrozen(event))).toBe(true);
    expect(h.events.every((event) => Number.isSafeInteger(event.revision))).toBe(true);
    expect(JSON.stringify(h.events)).not.toContain('frame=2');
    expect(JSON.stringify(h.events)).not.toContain('candidate.mp4');
    expect(JSON.stringify(h.events)).not.toContain('.snapshot');
    expect(await h.service.get(id)).not.toHaveProperty('ownedPaths');
    expect((await h.service.get(id)).items[0]).not.toHaveProperty('ownedArtifacts');
  });

  test('dismisses a summary durably and list/get return detached immutable snapshots', async () => {
    const h = harness();
    const id = await h.service.start(CONFIG);
    await h.service.whenIdle(id);
    await h.service.dismissSummary(id);
    const snapshot = await h.service.get(id);
    const listed = await h.service.list();

    expect(snapshot).toMatchObject({ state: 'completed', summary: null, summaryDismissed: true });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.items)).toBe(true);
    expect(listed[0]).not.toBe(snapshot);
    expect(() => { snapshot.state = 'failed'; }).toThrow();
  });

  test('uses one real singleton store through encode, asset transaction, completion, and restart', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sentry-six-job-service-store-'));
    temporaryRoots.push(root);
    const store = createJobStore({ rootDir: root, fs: fs.promises });
    const h = harness({
      store,
      items: [video('convert-me'), asset('event.json')]
    });
    const id = await h.service.start(CONFIG);
    await h.service.whenIdle(id);
    await expect(h.service.get(id)).resolves.toMatchObject({ state: 'completed' });

    const restarted = createJobStore({ rootDir: root, fs: fs.promises });
    await expect(restarted.load(id)).resolves.toMatchObject({
      state: 'completed',
      revision: expect.any(Number),
      items: [{ state: 'completed', outputBytes: 800000 }, { state: 'completed', outputBytes: 123 }],
      counters: {
        files: 1,
        sourceVideoBytes: 1000000,
        outputVideoBytes: 800000,
        savedBytes: 200000,
        copiedAssetBytes: 123,
        groups: { RecentClips: { files: 1, sourceBytes: 1000000, outputBytes: 800000, savedBytes: 200000 } }
      },
      summary: {
        files: 1,
        sourceVideoBytes: 1000000,
        outputVideoBytes: 800000,
        savedBytes: 200000,
        copiedAssetBytes: 123,
        groups: { RecentClips: { files: 1, sourceBytes: 1000000, outputBytes: 800000, savedBytes: 200000 } }
      }
    });
  });

  test('shutdown pauses recoverably, terminates owned work, and a fresh service drains queued siblings', async () => {
    const gate = deferred();
    const h = harness({ items: [video('one'), video('two')], spawnActions: [{ hold: { resolveChild: gate.resolve } }] });
    const id = await h.service.start(CONFIG);
    const child = await gate.promise;
    await Promise.all([h.service.shutdown(), h.service.shutdown()]);

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(h.stagingManager.cleanupOwnedArtifacts).toHaveBeenCalled();
    expect(await h.service.get(id)).toMatchObject({
      state: 'paused',
      recovery: { fromState: 'encoding', action: 'restart-encoding' },
      items: [{ state: 'queued' }, { state: 'queued' }]
    });
    await expect(h.service.start(CONFIG)).rejects.toMatchObject({ code: 'SERVICE_SHUTDOWN' });

    const restarted = harness({ store: h.store, items: [] });
    await restarted.service.resume(id);
    await restarted.service.whenIdle(id);
    expect(await restarted.service.get(id)).toMatchObject({
      state: 'completed',
      items: [{ state: 'completed' }, { state: 'completed' }],
      counters: { files: 2 }
    });
  });

  test('passes one cancellation signal through verification and cleans only owned artifacts on cancel', async () => {
    const entered = deferred();
    const verifier = jest.fn(({ signal }) => new Promise((_resolve, reject) => {
      entered.resolve(signal);
      signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })), { once: true });
    }));
    const h = harness({ deps: { verifier } });
    const id = await h.service.start(CONFIG);
    const signal = await entered.promise;

    await h.service.cancel(id);

    expect(signal.aborted).toBe(true);
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(h.stagingManager.cleanupOwnedArtifacts).toHaveBeenCalledWith(expect.objectContaining({
      ownedArtifacts: expect.objectContaining({ encodedCandidate: expect.objectContaining({ state: 'owned' }) })
    }));
    expect(await h.service.get(id)).toMatchObject({ state: 'cancelled', items: [{ state: 'cancelled' }] });
  });

  test('requires explicit recovery after shutdown leaves active ownership cleanup pending', async () => {
    const gate = deferred();
    const h = harness({
      spawnActions: [{ hold: { resolveChild: gate.resolve } }],
      stagingManager: {
        cleanupOwnedArtifacts: jest.fn(async (operation) => ({
          cleaned: false,
          cleanupPending: Object.keys(operation.ownedPaths || {}),
          ownedPaths: operation.ownedPaths,
          ownedArtifacts: operation.ownedArtifacts
        }))
      }
    });
    const id = await h.service.start(CONFIG);
    await gate.promise;
    await h.service.shutdown();

    expect(await h.service.get(id)).toMatchObject({
      state: 'paused', activeItemId: 'item-000001',
      recovery: { fromState: 'encoding', action: 'cleanup-and-restart-encoding' },
      items: [{ state: 'processing', resultCode: 'cleanup-pending' }]
    });
    await expect(h.service.resume(id)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  });

  test('restart resumes interrupted discovery, deduplicates persisted items, and drains every sibling', async () => {
    const firstItemPersisted = deferred();
    const firstScanner = jest.fn(async function* (_config, { signal }) {
      yield video('one');
      firstItemPersisted.resolve();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    });
    const first = harness({ deps: { scanner: firstScanner } });
    const id = await first.service.start(CONFIG);
    await firstItemPersisted.promise;
    await first.service.shutdown();

    expect(await first.service.get(id)).toMatchObject({ state: 'paused', discoveryComplete: false });

    const resumedScanner = jest.fn(async function* () {
      yield video('one');
      yield video('two');
      yield video('three');
    });
    const second = harness({ store: first.store, deps: { scanner: resumedScanner } });
    await second.service.resume(id);
    await second.service.whenIdle(id);

    const completed = await second.service.get(id);
    expect(completed).toMatchObject({ state: 'completed', discoveryComplete: true });
    expect(completed.items.map((item) => item.relativePath)).toEqual([
      'RecentClips/one.mp4', 'RecentClips/two.mp4', 'RecentClips/three.mp4'
    ]);
    expect(completed.items.map((item) => item.state)).toEqual(['completed', 'completed', 'completed']);
    expect(resumedScanner).toHaveBeenCalledTimes(1);
  });

  test('treats a real scanner AbortError during shutdown as paused and resumes from a fresh real store', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sentry-six-job-service-scanner-abort-'));
    temporaryRoots.push(root);
    const store = createJobStore({ rootDir: root, fs: fs.promises });
    const entered = deferred();
    const abortingScanner = jest.fn(async function* (_config, { signal }) {
      entered.resolve(signal);
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      const error = new Error('scanner aborted');
      error.name = 'AbortError';
      throw error;
    });
    const first = harness({ store, deps: { scanner: abortingScanner } });
    const id = await first.service.start(CONFIG);
    await entered.promise;

    await first.service.shutdown();

    await expect(store.load(id)).resolves.toMatchObject({
      state: 'paused', discoveryComplete: false, summary: null
    });
    expect((await store.load(id))).not.toHaveProperty('failure');

    const restartedStore = createJobStore({ rootDir: root, fs: fs.promises });
    const second = harness({ store: restartedStore, items: [video('after-restart')] });
    await second.service.resume(id);
    await second.service.whenIdle(id);
    await expect(restartedStore.load(id)).resolves.toMatchObject({
      state: 'completed', discoveryComplete: true, items: [{ state: 'completed' }]
    });
  });

  test('never completes an incompletely discovered job when a scanner ends with AbortError', async () => {
    const scanner = jest.fn(async function* () {
      yield video('persisted-before-abort');
      const error = new Error('directory traversal aborted');
      error.name = 'AbortError';
      throw error;
    });
    const h = harness({ deps: { scanner } });
    const id = await h.service.start(CONFIG);
    await h.service.whenIdle(id);

    expect(await h.service.get(id)).toMatchObject({
      state: 'paused', discoveryComplete: false,
      recovery: { fromState: 'waiting', action: 'resume-discovery' },
      items: [{ state: 'completed' }], counters: { files: 1 }
    });
  });
});
