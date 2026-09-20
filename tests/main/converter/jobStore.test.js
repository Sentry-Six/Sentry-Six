'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MANIFEST_VERSION,
  MANIFEST_LIMITS,
  createJobStore
} = require('../../../src/main/converter/jobStore');

function emptyGroups() {
  return {
    RecentClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 },
    SavedClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 },
    SentryClips: { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 }
  };
}

function emptyCounters(overrides = {}) {
  return {
    files: 0,
    sourceVideoBytes: 0,
    outputVideoBytes: 0,
    savedBytes: 0,
    copiedAssetBytes: 0,
    groups: emptyGroups(),
    ...overrides
  };
}

function summaryFromCounters(counters) {
  return {
    ...counters,
    source: `${counters.sourceVideoBytes} B`,
    output: `${counters.outputVideoBytes} B`,
    saved: `${counters.savedBytes} B`,
    copiedAssets: `${counters.copiedAssetBytes} B`
  };
}

function validConfig(overrides = {}) {
  return {
    sourceRoot: 'D:\\TeslaCam',
    destinationRoot: 'E:\\ConvertedTeslaCam',
    codec: 'h265',
    profileId: 'balanced',
    networkMode: 'auto',
    outputMode: 'separate',
    includedGroups: ['RecentClips', 'SavedClips', 'SentryClips'],
    groupOrder: ['SavedClips', 'SentryClips', 'RecentClips'],
    replacementConfirmed: false,
    ...overrides
  };
}

const GROUP_ORDERS = [
  ['SavedClips', 'SentryClips', 'RecentClips'],
  ['SavedClips', 'RecentClips', 'SentryClips'],
  ['SentryClips', 'SavedClips', 'RecentClips'],
  ['SentryClips', 'RecentClips', 'SavedClips'],
  ['RecentClips', 'SavedClips', 'SentryClips'],
  ['RecentClips', 'SentryClips', 'SavedClips']
];

function validVideoItem(overrides = {}) {
  return {
    id: 'item-1',
    state: 'queued',
    kind: 'video',
    group: 'SentryClips',
    eventId: '2026-08-30_12-34-56',
    relativePath: 'SentryClips/2026-08-30_12-34-56/2026-08-30_12-34-56-front.mp4',
    sourcePath: 'D:\\TeslaCam\\SentryClips\\2026-08-30_12-34-56\\2026-08-30_12-34-56-front.mp4',
    sourceBytes: 1_000,
    mtimeMs: 1_777_777_777,
    timestampKey: '2026-08-30_12-34-56',
    camera: 'front',
    ...overrides
  };
}

function activeJob(state, overrides = {}) {
  return {
    state,
    ...(state === 'replacing' ? {
      config: validConfig({
        destinationRoot: null,
        outputMode: 'replace',
        replacementConfirmed: true
      })
    } : {}),
    activeItemId: 'item-1',
    items: [validVideoItem({ state: 'processing', ...(state === 'replacing' ? {
      expectedSource: { size: 1000, sha256: 'c'.repeat(64), device: '1', inode: '2' }
    } : {}) })],
    ...overrides
  };
}

function job(id, overrides = {}) {
  return {
    schemaVersion: MANIFEST_VERSION,
    id,
    state: 'discovering',
    revision: 0,
    config: validConfig(),
    items: [],
    counters: emptyCounters(),
    summary: null,
    ...overrides
  };
}

function proxiedFs(overrides = {}) {
  return new Proxy(fs.promises, {
    get(target, property) {
      if (Object.prototype.hasOwnProperty.call(overrides, property)) return overrides[property];
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function pauseDuringQuarantineSnapshot(targetPath) {
  let release;
  let reached;
  let pausedOnce = false;
  let temporaryOpened = false;
  let writeOperationStarted = false;
  const reachedPause = new Promise((resolve) => { reached = resolve; });
  const releasePause = new Promise((resolve) => { release = resolve; });
  return {
    fs: proxiedFs({
      async mkdir(target, options) {
        const rootPath = path.dirname(path.dirname(targetPath));
        if (pausedOnce && (target === rootPath || target === path.dirname(targetPath))) writeOperationStarted = true;
        return fs.promises.mkdir(target, options);
      },
      async open(target, flags, mode) {
        if (target.endsWith('job.json.tmp')) temporaryOpened = true;
        const handle = await fs.promises.open(target, flags, mode);
        if (!target.startsWith(`${targetPath}.corrupt-`) || flags !== 'wx') return handle;
        return {
          writeFile: (...args) => handle.writeFile(...args),
          async sync() {
            if (!pausedOnce) {
              pausedOnce = true;
              reached();
              await releasePause;
            }
            return handle.sync();
          },
          close: () => handle.close()
        };
      }
    }),
    reachedPause,
    release,
    temporaryWasOpened: () => temporaryOpened,
    writeWasStarted: () => writeOperationStarted
  };
}

function replaceOnManifestNamespaceMutation(targetPath, replacementManifest) {
  let manifestStats = 0;
  let mutationAttempts = 0;
  return {
    fs: proxiedFs({
      async lstat(target, options) {
        if (target === targetPath) manifestStats += 1;
        return fs.promises.lstat(target, options);
      },
      async unlink(target) {
        if (target === targetPath) {
          mutationAttempts += 1;
          const replacementPath = path.join(path.dirname(targetPath), 'external-new.json');
          await fs.promises.writeFile(replacementPath, JSON.stringify(replacementManifest));
          await fs.promises.rename(replacementPath, targetPath);
        }
        return fs.promises.unlink(target);
      }
    }),
    identityChecks: () => manifestStats,
    mutationAttempts: () => mutationAttempts
  };
}

function rewriteLiveAfterSnapshotCreation(targetPath, replacementBytes) {
  let rewritten = false;
  let hardlinkCalls = 0;
  async function rewriteOnce() {
    if (rewritten) return;
    rewritten = true;
    await fs.promises.writeFile(targetPath, replacementBytes);
  }
  return {
    fs: proxiedFs({
      async link(source, destination) {
        hardlinkCalls += 1;
        const result = await fs.promises.link(source, destination);
        await rewriteOnce();
        return result;
      },
      async open(target, flags, mode) {
        const handle = await fs.promises.open(target, flags, mode);
        if (!target.startsWith(`${targetPath}.corrupt-`) || flags !== 'wx') return handle;
        return {
          writeFile: (...args) => handle.writeFile(...args),
          async sync() {
            await rewriteOnce();
            return handle.sync();
          },
          close: () => handle.close()
        };
      }
    }),
    hardlinkCalls: () => hardlinkCalls
  };
}

describe('converter job store', () => {
  test.each(GROUP_ORDERS.map((order, index) => [index, order]))('persists group order permutation %#', async (index, groupOrder) => {
    const store = createJobStore({ rootDir, fs: fs.promises });
    await store.save(job(`order-${index}`, { config: validConfig({ groupOrder }) }));
    await expect(store.load(`order-${index}`)).resolves.toMatchObject({ config: { groupOrder } });
  });

  test('defaults an absent group order when reading an old manifest', async () => {
    const store = createJobStore({ rootDir, fs: fs.promises });
    const oldManifest = job('old-order');
    delete oldManifest.config.groupOrder;
    await store.save(oldManifest);
    await expect(store.load('old-order')).resolves.toMatchObject({
      config: { groupOrder: ['SavedClips', 'SentryClips', 'RecentClips'] }
    });
  });

  test.each([
    'not-an-array',
    ['SavedClips', 'SavedClips', 'RecentClips'],
    ['SavedClips', 'SentryClips'],
    ['SavedClips', 'SentryClips', 'OtherClips']
  ].map((order) => [order]))('rejects invalid persisted group order %#', async (groupOrder) => {
    const store = createJobStore({ rootDir, fs: fs.promises });
    await expect(store.save(job('bad-order', { config: validConfig({ groupOrder }) })))
      .rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
  });

  test('persists bounded discovery completion state for restart-safe queue draining', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'converter-job-store-discovery-'));
    const store = createJobStore({ rootDir: root, fs: fs.promises });
    try {
      await store.create(job('discovery-cursor-job', { discoveryComplete: false }));
      await store.transition('discovery-cursor-job', { discoveryComplete: true });

      await expect(store.load('discovery-cursor-job')).resolves.toMatchObject({ discoveryComplete: true });
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  let temporaryRoot;
  let rootDir;

  beforeEach(async () => {
    temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sentry-job-store-'));
    rootDir = path.join(temporaryRoot, 'converter-jobs');
  });

  afterEach(async () => {
    await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
  });

  test('creates, loads, and lists versioned manifests without Electron', async () => {
    const store = createJobStore({ rootDir, fs: fs.promises });
    const first = await store.create({ id: 'job-b', config: validConfig() });
    const second = await store.create({ id: 'job-a', state: 'waiting', config: validConfig() });

    expect(first).toEqual({
      schemaVersion: 1,
      id: 'job-b',
      state: 'discovering',
      revision: 0,
      config: validConfig(),
      items: [],
      counters: emptyCounters(),
      summary: null
    });
    expect(second.state).toBe('waiting');
    expect(await store.load('job-b')).toEqual(first);
    expect((await store.list()).map((entry) => entry.id)).toEqual(['job-a', 'job-b']);
  });

  test.each([
    '../outside',
    '..',
    '.',
    'nested/job',
    'nested\\job',
    'C:\\outside',
    'job with spaces',
    '-leading-dash'
  ])('rejects unsafe job id %j before resolving a manifest path', async (id) => {
    const store = createJobStore({ rootDir, fs: fs.promises });

    await expect(store.create({ id })).rejects.toMatchObject({ code: 'INVALID_JOB_ID' });
    await expect(store.load(id)).rejects.toMatchObject({ code: 'INVALID_JOB_ID' });
    await expect(fs.promises.access(path.join(temporaryRoot, 'outside'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test.each(['CaseJob', 'UPPER', 'con', 'prn', 'aux', 'nul', 'com1', 'com9', 'lpt1', 'lpt9', 'casejob.', 'casejob '])(
    'rejects the non-portable Windows job id %j on every platform',
    async (id) => {
      const store = createJobStore({ rootDir, fs: fs.promises });
      await expect(store.create({ id, config: validConfig() })).rejects.toMatchObject({ code: 'INVALID_JOB_ID' });
    }
  );

  test('uses one lowercase path and queue identity for a portable job id', async () => {
    const store = createJobStore({ rootDir, fs: fs.promises });
    const created = await store.create({ id: 'casejob', config: validConfig() });

    expect(created.id).toBe('casejob');
    await expect(store.load('CaseJob')).rejects.toMatchObject({ code: 'INVALID_JOB_ID' });
    await expect(store.save(job('CaseJob'))).rejects.toMatchObject({ code: 'INVALID_JOB_ID' });
    expect(await fs.promises.readdir(rootDir)).toEqual(['casejob']);
  });

  test('generates a lowercase portable id when create omits it', async () => {
    const store = createJobStore({ rootDir, fs: fs.promises });
    const created = await store.create({ config: validConfig() });
    expect(created.id).toMatch(/^[a-z0-9][a-z0-9_-]{0,127}$/);
  });

  test.each(['CaseItem', 'con', 'prn', 'aux', 'nul', 'com1', 'com9', 'lpt1', 'lpt9', 'item.', 'item '])(
    'rejects the non-portable item id %j before Task 10 can embed it in an artifact path',
    async (itemId) => {
      const store = createJobStore({ rootDir, fs: fs.promises });
      await expect(store.save(job('portable-item-job', {
        items: [validVideoItem({ id: itemId })]
      }))).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
    }
  );

  test('refuses a job directory link that resolves outside the store root', async () => {
    const outside = path.join(temporaryRoot, 'outside-job');
    const linkedJob = path.join(rootDir, 'linked-job');
    await fs.promises.mkdir(outside, { recursive: true });
    await fs.promises.mkdir(rootDir, { recursive: true });
    try {
      await fs.promises.symlink(outside, linkedJob, 'junction');
    } catch (error) {
      if (error.code === 'EPERM') return;
      throw error;
    }

    const store = createJobStore({ rootDir, fs: fs.promises });
    await expect(store.save(job('linked-job'))).rejects.toMatchObject({ code: 'UNSAFE_JOB_PATH' });
    await expect(fs.promises.access(path.join(outside, 'job.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('opens, writes, flushes, and closes the temporary manifest before rename, then flushes the directory', async () => {
    const events = [];
    const jobDir = path.join(rootDir, 'durable-job');
    const adapter = proxiedFs({
      async open(target, flags, mode) {
        if (target === jobDir) {
          events.push('open-directory');
          return {
            async sync() { events.push('sync-directory'); },
            async close() { events.push('close-directory'); }
          };
        }
        const handle = await fs.promises.open(target, flags, mode);
        if (!target.endsWith('job.json.tmp')) return handle;
        events.push('open-temporary');
        return {
          async writeFile(value, options) {
            events.push('write-temporary');
            return handle.writeFile(value, options);
          },
          async sync() {
            events.push('sync-temporary');
            return handle.sync();
          },
          async close() {
            events.push('close-temporary');
            return handle.close();
          }
        };
      },
      async rename(from, to) {
        events.push('rename-manifest');
        return fs.promises.rename(from, to);
      }
    });

    await createJobStore({ rootDir, fs: adapter }).save(job('durable-job'));

    expect(events).toEqual([
      'open-temporary',
      'write-temporary',
      'sync-temporary',
      'close-temporary',
      'rename-manifest',
      'open-directory',
      'sync-directory',
      'close-directory'
    ]);
    await expect(fs.promises.access(path.join(jobDir, 'job.json.tmp'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('keeps the last committed manifest when rename fails and removes only its temporary file', async () => {
    const initialStore = createJobStore({ rootDir, fs: fs.promises });
    await initialStore.save(job('rename-failure', { state: 'waiting' }));
    const adapter = proxiedFs({
      async rename() {
        const error = new Error('sensitive operating-system detail');
        error.code = 'EIO';
        throw error;
      }
    });

    const failingStore = createJobStore({ rootDir, fs: adapter });
    await expect(failingStore.save(job('rename-failure', activeJob('encoding', { revision: 1 }))))
      .rejects.toMatchObject({ code: 'MANIFEST_WRITE_FAILED', message: 'The job manifest could not be saved.' });

    expect(await initialStore.load('rename-failure')).toMatchObject({ state: 'waiting' });
    await expect(fs.promises.access(path.join(rootDir, 'rename-failure', 'job.json.tmp')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('never follows a pre-existing temporary-file hardlink outside the job directory', async () => {
    const store = createJobStore({ rootDir, fs: fs.promises });
    await store.save(job('stale-temporary', { state: 'waiting' }));
    const unrelated = path.join(temporaryRoot, 'unrelated.txt');
    const temporary = path.join(rootDir, 'stale-temporary', 'job.json.tmp');
    await fs.promises.writeFile(unrelated, 'unrelated contents');
    await fs.promises.link(unrelated, temporary);

    await store.save(job('stale-temporary', activeJob('encoding', { revision: 1 })));

    expect(await fs.promises.readFile(unrelated, 'utf8')).toBe('unrelated contents');
    expect(await store.load('stale-temporary')).toMatchObject({ state: 'encoding', revision: 1 });
  });

  test('serializes concurrent writes for the same job so a temporary file is never shared', async () => {
    let releaseFirstWrite;
    const firstWriteMayContinue = new Promise((resolve) => { releaseFirstWrite = resolve; });
    let temporaryOpens = 0;
    let firstWriteStarted;
    const firstWriteHasStarted = new Promise((resolve) => { firstWriteStarted = resolve; });
    const adapter = proxiedFs({
      async open(target, flags, mode) {
        const handle = await fs.promises.open(target, flags, mode);
        if (!target.endsWith('job.json.tmp')) return handle;
        temporaryOpens += 1;
        const thisOpen = temporaryOpens;
        return {
          async writeFile(value, options) {
            if (thisOpen === 1) {
              firstWriteStarted();
              await firstWriteMayContinue;
            }
            return handle.writeFile(value, options);
          },
          sync: () => handle.sync(),
          close: () => handle.close()
        };
      }
    });
    const store = createJobStore({ rootDir, fs: adapter });

    const first = store.save(job('serialized', activeJob('encoding', { revision: 1 })));
    await firstWriteHasStarted;
    const second = store.save(job('serialized', { state: 'paused', revision: 2 }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(temporaryOpens).toBe(1);

    releaseFirstWrite();
    await Promise.all([first, second]);
    expect(temporaryOpens).toBe(2);
    expect(await store.load('serialized')).toMatchObject({ state: 'paused', revision: 2 });
  });

  test('validates manifest version and state on save and quarantines invalid persisted schemas', async () => {
    const store = createJobStore({ rootDir, fs: fs.promises });
    await expect(store.save(job('wrong-version', { schemaVersion: 2 })))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_MANIFEST_VERSION' });
    await expect(store.save(job('wrong-state', { state: 'made-up-state' })))
      .rejects.toMatchObject({ code: 'INVALID_MANIFEST' });

    const invalidDir = path.join(rootDir, 'persisted-invalid');
    await fs.promises.mkdir(invalidDir, { recursive: true });
    await fs.promises.writeFile(path.join(invalidDir, 'job.json'), JSON.stringify(job('persisted-invalid', { schemaVersion: 99 })));

    await expect(store.load('persisted-invalid')).rejects.toMatchObject({ code: 'CORRUPT_MANIFEST' });
    expect(JSON.parse(await fs.promises.readFile(path.join(invalidDir, 'job.json'), 'utf8')).schemaVersion).toBe(99);
    expect((await fs.promises.readdir(invalidDir)).filter((name) => name.startsWith('job.json.corrupt-'))).toHaveLength(1);
  });

  test('quarantines a valid manifest whose id does not match its containing job directory', async () => {
    const mismatchedDir = path.join(rootDir, 'expected-id');
    await fs.promises.mkdir(mismatchedDir, { recursive: true });
    await fs.promises.writeFile(path.join(mismatchedDir, 'job.json'), JSON.stringify(job('different-id')));

    const store = createJobStore({ rootDir, fs: fs.promises });
    await expect(store.load('expected-id')).rejects.toMatchObject({ code: 'CORRUPT_MANIFEST' });
    expect((await fs.promises.readdir(mismatchedDir)).some((name) => name.startsWith('job.json.corrupt-'))).toBe(true);
  });

  test('binds an existing manifest identity before save can overwrite it', async () => {
    const targetDir = path.join(rootDir, 'expected-id');
    await fs.promises.mkdir(targetDir, { recursive: true });
    await fs.promises.writeFile(path.join(targetDir, 'job.json'), JSON.stringify(job('different-id')));
    const store = createJobStore({ rootDir, fs: fs.promises });

    await expect(store.save(job('expected-id', { revision: 1 }))).rejects.toMatchObject({ code: 'CORRUPT_MANIFEST' });
    expect(JSON.parse(await fs.promises.readFile(path.join(targetDir, 'job.json'), 'utf8')).id).toBe('different-id');
  });

  test('rejects a stale whole-manifest save instead of replacing a newer revision', async () => {
    const store = createJobStore({ rootDir, fs: fs.promises });
    await store.save(job('revision-bound', { state: 'waiting', revision: 4 }));

    await expect(store.save(job('revision-bound', { state: 'paused', revision: 3 })))
      .rejects.toMatchObject({ code: 'STALE_MANIFEST_REVISION' });
    expect(await store.load('revision-bound')).toMatchObject({ state: 'waiting', revision: 4 });
  });

  test('persists meaningful transitions and revisions across store instances', async () => {
    const firstStore = createJobStore({ rootDir, fs: fs.promises });
    await firstStore.create({ id: 'transitioned', config: validConfig() });
    const transitioned = await firstStore.transition('transitioned', {
      state: 'encoding',
      activeItemId: 'clip-1',
      items: [validVideoItem({ id: 'clip-1', state: 'processing' })]
    });

    expect(transitioned).toMatchObject({ state: 'encoding', activeItemId: 'clip-1', revision: 1 });
    const restartedStore = createJobStore({ rootDir, fs: fs.promises });
    expect(await restartedStore.load('transitioned')).toEqual(transitioned);
  });

  test('preserves a completed summary after application restart', async () => {
    const firstStore = createJobStore({ rootDir, fs: fs.promises });
    const groups = emptyGroups();
    groups.SentryClips = { files: 1, sourceBytes: 1_000, outputBytes: 500, savedBytes: 500 };
    const completedCounters = emptyCounters({
      files: 1,
      sourceVideoBytes: 1_000,
      outputVideoBytes: 500,
      savedBytes: 500,
      copiedAssetBytes: 25,
      groups
    });
    await firstStore.save(job('completed-summary', {
      state: 'completed',
      revision: 8,
      counters: completedCounters,
      summary: {
        ...completedCounters,
        source: '1000 B',
        output: '500 B',
        saved: '500 B',
        copiedAssets: '25 B'
      }
    }));

    const restartedStore = createJobStore({ rootDir, fs: fs.promises });
    expect(await restartedStore.load('completed-summary')).toMatchObject({
      state: 'completed',
      summary: { savedBytes: 500, copiedAssetBytes: 25 }
    });
  });

  test('persists an explicitly dismissed completed summary without weakening completed counters', async () => {
    const store = createJobStore({ rootDir, fs: fs.promises });
    const counters = emptyCounters({
      files: 1,
      sourceVideoBytes: 1_000,
      outputVideoBytes: 800,
      savedBytes: 200,
      groups: {
        ...emptyGroups(),
        RecentClips: { files: 1, sourceBytes: 1_000, outputBytes: 800, savedBytes: 200 }
      }
    });
    await store.save(job('dismissed-summary', {
      state: 'completed',
      counters,
      summary: null,
      summaryDismissed: true
    }));

    await expect(createJobStore({ rootDir, fs: fs.promises }).load('dismissed-summary'))
      .resolves.toMatchObject({ state: 'completed', counters, summary: null, summaryDismissed: true });
    await expect(store.save(job('invalid-undismissed-summary', {
      state: 'completed', counters, summary: null, summaryDismissed: false
    }))).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
  });

  test('allows zero size only for adopted encodedCandidate cleanup ownership', async () => {
    const store = createJobStore({ rootDir, fs: fs.promises });
    const encodedPath = 'C:\\converter\\empty-candidate.mp4';
    const metadata = {
      path: encodedPath, nonce: 'empty-candidate', state: 'owned', size: 0,
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      device: '1', inode: '2'
    };
    await expect(store.save(job('empty-encoded-cleanup', activeJob('encoding', {
      ownedPaths: { encodedCandidate: encodedPath },
      ownedArtifacts: { encodedCandidate: metadata },
      items: [validVideoItem({ state: 'processing',
        ownedPaths: { encodedCandidate: encodedPath },
        ownedArtifacts: { encodedCandidate: metadata } })]
    })))).resolves.toMatchObject({ ownedArtifacts: { encodedCandidate: { size: 0 } } });

    await expect(store.save(job('empty-published-artifact', activeJob('copying', {
      ownedPaths: { destinationPartial: 'E:\\partial.mp4' },
      ownedArtifacts: { destinationPartial: { ...metadata, path: 'E:\\partial.mp4' } }
    })))).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
  });

  test('quarantines corrupt JSON without overwriting an unrelated quarantine file or exposing its contents', async () => {
    const jobDir = path.join(rootDir, 'corrupt-job');
    const unrelatedName = 'job.json.corrupt-unrelated';
    const secretText = 'password=hunter2';
    await fs.promises.mkdir(jobDir, { recursive: true });
    await fs.promises.writeFile(path.join(jobDir, 'job.json'), `{ broken ${secretText}`);
    await fs.promises.writeFile(path.join(jobDir, unrelatedName), 'leave me alone');

    const store = createJobStore({ rootDir, fs: fs.promises });
    let failure;
    try {
      await store.load('corrupt-job');
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: 'CORRUPT_MANIFEST', message: 'The job manifest is corrupt and was quarantined.' });
    expect(failure.message).not.toContain(secretText);
    expect(await fs.promises.readFile(path.join(jobDir, 'job.json'), 'utf8')).toContain(secretText);
    expect(await fs.promises.readFile(path.join(jobDir, unrelatedName), 'utf8')).toBe('leave me alone');
    const quarantines = (await fs.promises.readdir(jobDir)).filter((name) => name.startsWith('job.json.corrupt-'));
    expect(quarantines).toHaveLength(2);
    expect(await fs.promises.readFile(path.join(jobDir, quarantines.find((name) => name !== unrelatedName)), 'utf8'))
      .toContain(secretText);
  });

  test('copies the exact raw bytes read into an immutable quarantine snapshot before an in-place live rewrite', async () => {
    const id = 'immutable-quarantine';
    const jobDir = path.join(rootDir, id);
    const manifestPath = path.join(jobDir, 'job.json');
    const originalInvalidBytes = Buffer.from([0xff, 0xfe, 0x00, 0x7b, 0x22, 0x78]);
    const replacementManifest = job(id, { state: 'waiting', revision: 9 });
    const replacementBytes = Buffer.from(JSON.stringify(replacementManifest));
    await fs.promises.mkdir(jobDir, { recursive: true });
    await fs.promises.writeFile(manifestPath, originalInvalidBytes);
    const rewrite = rewriteLiveAfterSnapshotCreation(manifestPath, replacementBytes);
    const store = createJobStore({ rootDir, fs: rewrite.fs });

    await expect(store.load(id)).rejects.toMatchObject({ code: 'CORRUPT_MANIFEST' });

    expect(rewrite.hardlinkCalls()).toBe(0);
    expect(await fs.promises.readFile(manifestPath)).toEqual(replacementBytes);
    const quarantines = (await fs.promises.readdir(jobDir)).filter((name) => name.startsWith('job.json.corrupt-'));
    expect(quarantines).toHaveLength(1);
    expect(await fs.promises.readFile(path.join(jobDir, quarantines[0]))).toEqual(originalInvalidBytes);
    await expect(store.load(id)).resolves.toMatchObject({ id, state: 'waiting', revision: 9 });
  });

  test('list returns valid jobs while quarantining corrupt manifests', async () => {
    const store = createJobStore({ rootDir, fs: fs.promises });
    await store.create({ id: 'valid-job', config: validConfig() });
    const corruptDir = path.join(rootDir, 'corrupt-job');
    await fs.promises.mkdir(corruptDir);
    await fs.promises.writeFile(path.join(corruptDir, 'job.json'), 'not json');

    expect((await store.list()).map((entry) => entry.id)).toEqual(['valid-job']);
    expect((await fs.promises.readdir(corruptDir)).some((name) => name.startsWith('job.json.corrupt-'))).toBe(true);
  });

  test('serializes load quarantine and a same-id save through the complete non-destructive snapshot', async () => {
    const id = 'queued-load';
    const jobDir = path.join(rootDir, id);
    const manifestPath = path.join(jobDir, 'job.json');
    await fs.promises.mkdir(jobDir, { recursive: true });
    await fs.promises.writeFile(manifestPath, 'not json');
    const pause = pauseDuringQuarantineSnapshot(manifestPath);
    const store = createJobStore({ rootDir, fs: pause.fs });

    const loading = store.load(id);
    await pause.reachedPause;
    let saveSettled = false;
    let saveFailure;
    const saving = store.save(job(id, { state: 'waiting', revision: 1 })).then((value) => {
      saveSettled = true;
      return value;
    }, (error) => {
      saveSettled = true;
      saveFailure = error;
      return null;
    });
    for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(saveSettled).toBe(false);
    expect(pause.writeWasStarted()).toBe(false);
    expect(pause.temporaryWasOpened()).toBe(false);

    pause.release();
    await expect(loading).rejects.toMatchObject({ code: 'CORRUPT_MANIFEST' });
    await saving;
    expect(saveFailure).toMatchObject({ code: 'CORRUPT_MANIFEST' });
    expect(await fs.promises.readFile(manifestPath, 'utf8')).toBe('not json');
  });

  test('serializes list quarantine and a same-id save through the complete non-destructive snapshot', async () => {
    const id = 'queued-list';
    const jobDir = path.join(rootDir, id);
    const manifestPath = path.join(jobDir, 'job.json');
    await fs.promises.mkdir(jobDir, { recursive: true });
    await fs.promises.writeFile(manifestPath, 'not json');
    const pause = pauseDuringQuarantineSnapshot(manifestPath);
    const store = createJobStore({ rootDir, fs: pause.fs });

    const listing = store.list();
    await pause.reachedPause;
    let saveSettled = false;
    let saveFailure;
    const saving = store.save(job(id, { state: 'waiting', revision: 1 })).then((value) => {
      saveSettled = true;
      return value;
    }, (error) => {
      saveSettled = true;
      saveFailure = error;
      return null;
    });
    for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(saveSettled).toBe(false);
    expect(pause.writeWasStarted()).toBe(false);
    expect(pause.temporaryWasOpened()).toBe(false);

    pause.release();
    expect(await listing).toEqual([]);
    await saving;
    expect(saveFailure).toMatchObject({ code: 'CORRUPT_MANIFEST' });
    expect(await fs.promises.readFile(manifestPath, 'utf8')).toBe('not json');
  });

  test('never mutates live job.json after a separate identity check, so an adversarial newer replacement survives', async () => {
    const id = 'identity-race';
    const jobDir = path.join(rootDir, id);
    const manifestPath = path.join(jobDir, 'job.json');
    await fs.promises.mkdir(jobDir, { recursive: true });
    await fs.promises.writeFile(manifestPath, 'not json');
    const replacement = job(id, { state: 'waiting', revision: 9 });
    const hook = replaceOnManifestNamespaceMutation(manifestPath, replacement);
    const store = createJobStore({ rootDir, fs: hook.fs });

    await expect(store.load(id)).rejects.toMatchObject({ code: 'CORRUPT_MANIFEST' });
    expect(hook.identityChecks()).toBeGreaterThan(0);
    expect(hook.mutationAttempts()).toBe(0);
    expect(await fs.promises.readFile(manifestPath, 'utf8')).toBe('not json');

    const replacementPath = path.join(jobDir, 'external-valid.json');
    await fs.promises.writeFile(replacementPath, JSON.stringify(replacement));
    await fs.promises.rename(replacementPath, manifestPath);
    expect(await store.load(id)).toMatchObject({ id, state: 'waiting', revision: 9 });
  });

  test.each([
    ['telemetry payload bytes', { telemetryPayload: Buffer.from('sensitive') }],
    ['generic payload byte arrays', { payloadBytes: [0, 1, 2, 3] }],
    ['codec NALs', { seiNals: ['001122'] }],
    ['codec NAL units', { nalUnits: ['001122'] }],
    ['telemetry fingerprints', { telemetryFingerprint: 'private-fingerprint' }],
    ['credentials', { apiToken: 'private-token' }],
    ['exception output', { failure: { code: 'decode-failed', stack: 'private stack text' } }]
  ])('rejects %s instead of persisting it', async (_label, unsafeValue) => {
    const store = createJobStore({ rootDir, fs: fs.promises });
    let failure;
    try {
      await store.save(job('minimal-data', { items: [{ id: 'clip-1', ...unsafeValue }] }));
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: 'SENSITIVE_MANIFEST_DATA' });
    expect(failure.message).toBe('The job manifest contains data that must not be persisted.');
    await expect(fs.promises.access(path.join(rootDir, 'minimal-data', 'job.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('round-trips only the allowlisted downstream transaction DTO', async () => {
    const store = createJobStore({ rootDir, fs: fs.promises });
    const manifest = job('allowlisted-dto', activeJob('copying', {
      revision: 7,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_001_000,
      ownedPaths: {
        stagedSource: 'C:\\converter\\staged.mp4',
        encodedCandidate: 'C:\\converter\\candidate.mp4',
        publicationSnapshot: 'C:\\converter\\snapshot.mp4',
        destinationPartial: 'E:\\ConvertedTeslaCam\\clip.mp4.partial'
      },
      ownedArtifacts: {
        encodedCandidate: {
          path: 'C:\\converter\\candidate.mp4',
          nonce: '637221aa-387d-40e2-889a-3dd083502c28',
          state: 'writing',
          size: 0,
          sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          device: '12',
          inode: '35',
          journal: {
            committed: { size: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
            pending: null
          }
        },
        stagedSource: {
          path: 'C:\\converter\\staged.mp4',
          nonce: '4c0ab6f1-1afd-4f57-ad53-ac5b664dfa71',
          state: 'owned',
          size: 1_000,
          sha256: 'b'.repeat(64),
          device: '12',
          inode: '34'
        },
        destinationPartial: {
          path: 'E:\\ConvertedTeslaCam\\clip.mp4.partial',
          nonce: '6931cd21-5bdd-4bd1-81ae-6b7f3fd740bf',
          state: 'cleanup-pending',
          size: 500,
          sha256: 'a'.repeat(64),
          device: '56',
          inode: '78'
        },
        publicationSnapshot: {
          path: 'C:\\converter\\snapshot.mp4',
          nonce: '9a3fc709-41ec-40bf-9708-ab8c62865ae5',
          state: 'owned',
          size: 500,
          sha256: 'a'.repeat(64),
          device: '90',
          inode: '12'
        }
      },
      publicationArtifact: {
        path: 'C:\\converter\\snapshot.mp4',
        token: 'snapshot-capability-1',
        sha256: 'a'.repeat(64),
        size: 500
      }
    }));

    await store.save(manifest);
    expect(await store.load(manifest.id)).toEqual(manifest);
  });

  test('accepts scanner-compatible loose clip metadata without widening the DTO', async () => {
    const store = createJobStore({ rootDir, fs: fs.promises });
    const manifest = job('scanner-compatible', {
      items: [validVideoItem({
        group: null,
        eventId: null,
        mtimeMs: 1_777_777_777.25
      })]
    });

    await store.save(manifest);
    expect(await store.load(manifest.id)).toEqual(manifest);
  });

  test.each([
    ['path mismatch', {
      ownedPaths: { stagedSource: 'C:\\converter\\staged.mp4' },
      ownedArtifacts: { stagedSource: { path: 'C:\\converter\\other.mp4', nonce: 'nonce-1', state: 'intent' } }
    }],
    ['owned metadata missing digest', {
      ownedPaths: { stagedSource: 'C:\\converter\\staged.mp4' },
      ownedArtifacts: { stagedSource: { path: 'C:\\converter\\staged.mp4', nonce: 'nonce-1', state: 'owned', size: 10, device: 1, inode: 2 } }
    }],
    ['intent with fabricated identity', {
      ownedPaths: { stagedSource: 'C:\\converter\\staged.mp4' },
      ownedArtifacts: { stagedSource: { path: 'C:\\converter\\staged.mp4', nonce: 'nonce-1', state: 'intent', size: 10, sha256: 'a'.repeat(64), device: 1, inode: 2 } }
    }],
    ['intent with fabricated journal', {
      ownedPaths: { stagedSource: 'C:\\converter\\staged.mp4' },
      ownedArtifacts: { stagedSource: { path: 'C:\\converter\\staged.mp4', nonce: 'nonce-1', state: 'intent',
        journal: { committed: { size: 0, sha256: 'a'.repeat(64) }, pending: null } } }
    }],
    ['unsafe numeric inode identity', {
      ownedPaths: { stagedSource: 'C:\\converter\\staged.mp4' },
      ownedArtifacts: { stagedSource: { path: 'C:\\converter\\staged.mp4', nonce: 'nonce-1', state: 'owned',
        size: 10, sha256: 'a'.repeat(64), device: 1, inode: Number.MAX_SAFE_INTEGER + 1 } }
    }],
    ['journal committed beyond owned size', {
      ownedPaths: { stagedSource: 'C:\\converter\\staged.mp4' },
      ownedArtifacts: { stagedSource: { path: 'C:\\converter\\staged.mp4', nonce: 'nonce-1', state: 'writing',
        size: 5, sha256: 'a'.repeat(64), device: '9007199254740992', inode: '9007199254740993',
        journal: { committed: { size: 6, sha256: 'b'.repeat(64) }, pending: null } } }
    }],
    ['publication without durable ownership', {
      ownedPaths: { publicationSnapshot: 'C:\\converter\\snapshot.mp4' },
      publicationArtifact: { path: 'C:\\converter\\snapshot.mp4', token: 'syntactic-token', sha256: 'a'.repeat(64), size: 10 }
    }]
  ])('rejects unsafe owned-artifact metadata: %s', async (_label, fields) => {
    const store = createJobStore({ rootDir, fs: fs.promises });
    await expect(store.save(job(`owned-artifact-${_label.replaceAll(' ', '-')}`, fields)))
      .rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
  });

  test('persists only bounded failure codes rather than arbitrary exception output', async () => {
    const store = createJobStore({ rootDir, fs: fs.promises });
    const failed = job('bounded-failure', {
      state: 'failed',
      failure: { code: 'decode-failed', retryable: false }
    });
    await store.save(failed);
    expect(await store.load(failed.id)).toMatchObject({ failure: { code: 'decode-failed', retryable: false } });
  });

  test.each([
    ['top-level', () => job('unknown-top', { arbitrary: true })],
    ['config', () => job('unknown-config', { config: validConfig({ arbitrary: true }) })],
    ['item', () => job('unknown-item', { items: [validVideoItem({ arbitrary: true })] })],
    ['counters', () => job('unknown-counters', { counters: emptyCounters({ arbitrary: true }) })],
    ['owned path', () => job('unknown-owned', { ownedPaths: { arbitrary: 'C:\\temp\\x' } })],
    ['publication', () => job('unknown-publication', {
      publicationArtifact: { path: 'C:\\temp\\x', token: 'capability', sha256: 'a'.repeat(64), size: 1, arbitrary: true }
    })]
  ])('rejects an unknown %s manifest field', async (_label, buildManifest) => {
    const store = createJobStore({ rootDir, fs: fs.promises });
    await expect(store.save(buildManifest())).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
  });

  test.each([
    ['unknown codec', () => job('bad-codec', { config: validConfig({ codec: 'h264' }) })],
    ['missing separate destination', () => job('bad-destination', { config: validConfig({ destinationRoot: null }) })],
    ['unconfirmed replacement', () => job('bad-replacement', {
      config: validConfig({ outputMode: 'replace', destinationRoot: null, replacementConfirmed: false })
    })],
    ['traversing item path', () => job('bad-relative', { items: [validVideoItem({ relativePath: '../escape.mp4' })] })],
    ['negative item bytes', () => job('bad-bytes', { items: [validVideoItem({ sourceBytes: -1 })] })],
    ['asset without type', () => job('bad-asset', {
      items: [validVideoItem({ kind: 'asset', timestampKey: undefined, camera: undefined })]
    })],
    ['failed item without code', () => job('bad-item-failure', { items: [validVideoItem({ state: 'failed' })] })],
    ['counter arithmetic mismatch', () => job('bad-counters', {
      counters: emptyCounters({ sourceVideoBytes: 100, outputVideoBytes: 50, savedBytes: 40 })
    })],
    ['completed summary mismatch', () => job('bad-summary', {
      state: 'completed',
      summary: summaryFromCounters(emptyCounters({ copiedAssetBytes: 1 }))
    })],
    ['relative owned path', () => job('bad-owned', { ownedPaths: { encodedCandidate: 'relative.mp4' } })],
    ['invalid publication digest', () => job('bad-publication', {
      publicationArtifact: { path: 'C:\\temp\\x', token: 'capability', sha256: 'not-a-digest', size: 1 }
    })],
    ['active item not in queue', () => job('bad-active', { activeItemId: 'missing-item' })],
    ['transaction state without active item', () => job('bad-transaction', { state: 'copying' })]
  ])('rejects semantic manifest violation: %s', async (_label, buildManifest) => {
    const store = createJobStore({ rootDir, fs: fs.promises });
    await expect(store.save(buildManifest())).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
  });

  test.each([
    { fromState: 'copying', action: 'restart-encoding' },
    { fromState: 'replacing', action: 'validate-final' },
    { fromState: 'replacing', phase: 'candidate-promoted', action: 'resume-copy' },
    { fromState: 'encoding', action: 'cleanup-and-restart-encoding', arbitrary: true }
  ])('rejects malformed paused recovery %j instead of stranding it', async (recovery) => {
    const store = createJobStore({ rootDir, fs: fs.promises });
    await expect(store.save(job('bad-recovery', activeJob('paused', {
      replacementPhase: recovery.phase,
      recovery
    })))).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
  });

  test('validates every persisted replacement phase/action pair against the exact phase table', async () => {
    const actions = [
      'backup-original', 'promote-candidate', 'validate-final', 'restart-replacement',
      'restore-backup', 'delete-backup', 'finish-replacement', 'rollback-complete',
      'manual-intervention'
    ];
    const allowed = {
      'candidate-written': new Set([
        'backup-original', 'promote-candidate', 'validate-final', 'restart-replacement',
        'restore-backup', 'delete-backup', 'finish-replacement', 'manual-intervention'
      ]),
      'original-backed-up': new Set([
        'promote-candidate', 'validate-final', 'restore-backup', 'delete-backup',
        'finish-replacement', 'manual-intervention'
      ]),
      'candidate-promoted': new Set([
        'promote-candidate', 'validate-final', 'restore-backup', 'delete-backup',
        'finish-replacement', 'manual-intervention'
      ]),
      'final-validated': new Set(['restore-backup', 'delete-backup', 'finish-replacement', 'manual-intervention']),
      'backup-deleted': new Set(['restore-backup', 'delete-backup', 'finish-replacement', 'manual-intervention']),
      'rollback-started': new Set(['restore-backup', 'rollback-complete', 'manual-intervention']),
      'backup-restored': new Set(['restore-backup', 'rollback-complete', 'manual-intervention']),
      'rollback-failed': new Set(['restore-backup', 'rollback-complete', 'manual-intervention'])
    };
    const store = createJobStore({ rootDir, fs: fs.promises });

    for (const [phase, permitted] of Object.entries(allowed)) {
      for (const action of actions) {
        const manifest = job(`persisted-${phase}-${action}`, activeJob('paused', {
          config: validConfig({ destinationRoot: null, outputMode: 'replace', replacementConfirmed: true }),
          replacementPhase: phase,
          recovery: { fromState: 'replacing', phase, action }
        }));
        if (permitted.has(action)) await expect(store.save(manifest)).resolves.toMatchObject({ recovery: { action } });
        else await expect(store.save(manifest)).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
      }
    }
  });

  test('quarantines a malformed persisted paused recovery instead of returning it idempotently', async () => {
    const id = 'stranded-recovery';
    const jobDir = path.join(rootDir, id);
    await fs.promises.mkdir(jobDir, { recursive: true });
    await fs.promises.writeFile(path.join(jobDir, 'job.json'), JSON.stringify(job(id, activeJob('paused', {
      recovery: { fromState: 'copying', action: 'restart-encoding' }
    }))));
    const store = createJobStore({ rootDir, fs: fs.promises });

    await expect(store.recover(id, async () => ({}))).rejects.toMatchObject({ code: 'CORRUPT_MANIFEST' });
    expect((await fs.promises.readdir(jobDir)).some((name) => name.startsWith('job.json.corrupt-'))).toBe(true);
  });

  test('rejects an oversized persisted manifest through a bounded file-handle read', async () => {
    expect(MANIFEST_LIMITS).toMatchObject({
      bytes: 4 * 1024 * 1024,
      depth: 16,
      nodes: 150_000,
      stringCodeUnits: 2 * 1024 * 1024
    });
    const id = 'oversized-json';
    const jobDir = path.join(rootDir, id);
    const manifestPath = path.join(jobDir, 'job.json');
    await fs.promises.mkdir(jobDir, { recursive: true });
    await fs.promises.writeFile(manifestPath, 'x');
    await fs.promises.truncate(manifestPath, MANIFEST_LIMITS.bytes + 1);
    let manifestOpened = false;
    const adapter = proxiedFs({
      async readFile(target, ...args) {
        if (target === manifestPath) throw new Error('unbounded read must not be called');
        return fs.promises.readFile(target, ...args);
      },
      async open(target, flags, mode) {
        if (target === manifestPath) manifestOpened = true;
        return fs.promises.open(target, flags, mode);
      }
    });

    await expect(createJobStore({ rootDir, fs: adapter }).load(id)).rejects.toMatchObject({
      code: 'MANIFEST_READ_FAILED',
      message: 'The job manifest could not be read.'
    });
    expect(manifestOpened).toBe(false);
    const quarantines = (await fs.promises.readdir(jobDir)).filter((name) => name.startsWith('job.json.corrupt-'));
    expect(quarantines).toHaveLength(0);
    expect((await fs.promises.stat(manifestPath)).size).toBe(MANIFEST_LIMITS.bytes + 1);
  });

  test('rejects aggregate many-max-path input before stringify or filesystem allocation', async () => {
    const repeatedLongPath = `D:\\${'a'.repeat(32_760)}`;
    const items = Array.from({ length: 100 }, (_unused, index) => validVideoItem({
      id: `aggregate-${index}`,
      sourcePath: repeatedLongPath
    }));
    const stringifySpy = jest.spyOn(JSON, 'stringify');
    const callsBeforeSave = stringifySpy.mock.calls.length;
    const store = createJobStore({ rootDir, fs: fs.promises });
    try {
      await expect(store.save(job('aggregate-budget', { items }))).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
      expect(stringifySpy.mock.calls.length).toBe(callsBeforeSave);
    } finally {
      stringifySpy.mockRestore();
    }
    await expect(fs.promises.access(path.join(rootDir, 'aggregate-budget'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('accounts for JSON escape expansion during iterative preflight instead of building oversized JSON', async () => {
    const escapeHeavyPath = `D:\\${'\u0001'.repeat(32_760)}`;
    const items = Array.from({ length: 25 }, (_unused, index) => validVideoItem({
      id: `escaped-${index}`,
      sourcePath: escapeHeavyPath
    }));
    const stringifySpy = jest.spyOn(JSON, 'stringify');
    const callsBeforeSave = stringifySpy.mock.calls.length;
    const store = createJobStore({ rootDir, fs: fs.promises });
    try {
      await expect(store.save(job('escaped-budget', { items }))).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
      expect(stringifySpy.mock.calls.length).toBe(callsBeforeSave);
    } finally {
      stringifySpy.mockRestore();
    }
  });

  test('rejects a deeply nested unknown field with a bounded store error instead of recursive traversal', async () => {
    const nested = {};
    let cursor = nested;
    for (let depth = 0; depth < 20_000; depth += 1) {
      cursor.next = {};
      cursor = cursor.next;
    }
    const store = createJobStore({ rootDir, fs: fs.promises });

    await expect(store.save(job('deep-json', {
      config: validConfig({ unknownNestedValue: nested })
    }))).rejects.toMatchObject({
      code: 'INVALID_MANIFEST',
      message: 'The job manifest schema is invalid.'
    });
  });

  test('rejects hostile item counts before copying or serializing item contents', async () => {
    const store = createJobStore({ rootDir, fs: fs.promises });
    await expect(store.save(job('too-many-items', {
      items: new Array(25_001).fill(null)
    }))).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
  });

  test('rejects oversized path strings at the DTO boundary', async () => {
    const store = createJobStore({ rootDir, fs: fs.promises });
    await expect(store.save(job('oversized-string', {
      config: validConfig({ sourceRoot: `D:\\${'a'.repeat(32_769)}` })
    }))).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
  });

  test('bounds quarantine adapter failures without exposing raw contents or exception output', async () => {
    const id = 'quarantine-failure';
    const jobDir = path.join(rootDir, id);
    const manifestPath = path.join(jobDir, 'job.json');
    const secret = 'secret raw corrupt payload';
    await fs.promises.mkdir(jobDir, { recursive: true });
    await fs.promises.writeFile(manifestPath, `{ ${secret}`);
    const adapter = proxiedFs({
      async open(target, flags, mode) {
        if (target.startsWith(`${manifestPath}.corrupt-`)) {
          throw new Error('private adapter exception output');
        }
        return fs.promises.open(target, flags, mode);
      }
    });

    let failure;
    try {
      await createJobStore({ rootDir, fs: adapter }).load(id);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'MANIFEST_QUARANTINE_FAILED',
      message: 'The corrupt job manifest could not be quarantined.'
    });
    expect(failure.message).not.toContain(secret);
    expect(failure.message).not.toContain('private adapter');
    expect(await fs.promises.readFile(manifestPath, 'utf8')).toContain(secret);
  });

  test.each(['true', null, 1])(
    'fails copying recovery closed when a known path fact is nonboolean: %j',
    async (invalidFact) => {
      const id = `copy-nonboolean-${invalidFact === null ? 'null' : String(invalidFact)}`;
      const store = createJobStore({ rootDir, fs: fs.promises });
      await store.save(job(id, activeJob('copying')));

      const recovered = await store.recover(id, async () => ({ partialExists: invalidFact }));
      expect(recovered.recovery.action).toBe('manual-intervention');
    }
  );

  test.each(['false', null, 0])(
    'fails replacement recovery closed when a known path fact is nonboolean: %j',
    async (invalidFact) => {
      const id = `replace-nonboolean-${invalidFact === null ? 'null' : String(invalidFact)}`;
      const store = createJobStore({ rootDir, fs: fs.promises });
      await store.save(job(id, activeJob('replacing', { replacementPhase: 'candidate-written' })));

      const recovered = await store.recover(id, async () => ({
        candidateExists: true,
        sourceExists: true,
        backupExists: invalidFact,
        finalValid: false
      }));
      expect(recovered.recovery.action).toBe('manual-intervention');
    }
  );

  test.each(['copying', 'replacing'])(
    'fails %s recovery closed when inspection returns unknown facts',
    async (state) => {
      const id = `unknown-facts-${state}`;
      const store = createJobStore({ rootDir, fs: fs.promises });
      await store.save(job(id, activeJob(state, state === 'replacing' ? { replacementPhase: 'candidate-written' } : {})));

      const recovered = await store.recover(id, async () => ({
        unexpectedArtifactExists: true,
        ...(state === 'copying'
          ? { partialExists: true }
          : { candidateExists: true, sourceExists: true, backupExists: false, finalValid: false })
      }));
      expect(recovered.recovery.action).toBe('manual-intervention');
    }
  );

  test('bounds inspection fact getter exceptions and leaves the committed revision unchanged', async () => {
    const id = 'hostile-fact-getter';
    const store = createJobStore({ rootDir, fs: fs.promises });
    await store.save(job(id, activeJob('copying', { revision: 7 })));
    const facts = {};
    Object.defineProperty(facts, 'candidateExists', {
      enumerable: true,
      get() { throw new Error('private inspection exception output'); }
    });

    await expect(store.recover(id, async () => facts)).rejects.toMatchObject({
      code: 'INSPECTION_FAILED',
      message: 'The interrupted job paths could not be inspected.'
    });
    expect(await store.load(id)).toMatchObject({ state: 'copying', revision: 7 });
  });

  test('reads a stateful known fact getter once and fails closed instead of using a later value', async () => {
    const id = 'stateful-fact-getter';
    const store = createJobStore({ rootDir, fs: fs.promises });
    await store.save(job(id, activeJob('copying')));
    let reads = 0;
    const facts = {};
    Object.defineProperty(facts, 'partialExists', {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? true : 1;
      }
    });

    const recovered = await store.recover(id, async () => facts);
    expect(reads).toBe(1);
    expect(recovered.recovery.action).toBe('manual-intervention');
  });

  test('recovers interrupted encoding as a persisted paused action without deleting owned paths', async () => {
    const store = createJobStore({ rootDir, fs: fs.promises });
    await store.save(job('encoding-job', activeJob('encoding', {
      revision: 3,
      ownedPaths: { encodedCandidate: 'D:\\temp\\candidate.mp4' }
    })));

    const recovered = await store.recover('encoding-job', async () => ({ candidateExists: true }));

    expect(recovered).toMatchObject({
      state: 'paused',
      revision: 4,
      recovery: { fromState: 'encoding', action: 'cleanup-and-restart-encoding' }
    });
    expect(await createJobStore({ rootDir, fs: fs.promises }).load('encoding-job')).toEqual(recovered);
  });

  test.each([
    ['discovering', 'resume-discovery'],
    ['waiting', 'resume-queue']
  ])('persists a restart-safe %s recovery action', async (state, action) => {
    const id = `recover-${state}`;
    const store = createJobStore({ rootDir, fs: fs.promises });
    await store.save(job(id, { state, discoveryComplete: state === 'waiting' }));

    const recovered = await store.recover(id, async () => ({}));

    expect(recovered).toMatchObject({ state: 'paused', recovery: { fromState: state, action } });
  });

  test('resumes discovery rather than only the queue when waiting crashed before scan exhaustion', async () => {
    const store = createJobStore({ rootDir, fs: fs.promises });
    await store.save(job('recover-waiting-partial-scan', { state: 'waiting', discoveryComplete: false }));

    const recovered = await store.recover('recover-waiting-partial-scan', async () => ({}));

    expect(recovered).toMatchObject({
      state: 'paused', recovery: { fromState: 'waiting', action: 'resume-discovery' }
    });
  });

  test('accepts a canonical paused-network recovery action with only a bounded path role', async () => {
    const store = createJobStore({ rootDir, fs: fs.promises });
    await store.save(job('recover-paused-network', activeJob('paused_network', {
      recovery: { fromState: 'paused_network', action: 'resume-network', pathRole: 'destination' }
    })));

    await expect(store.recover('recover-paused-network', async () => {
      throw new Error('an already canonical recovery must not be reinspected');
    })).resolves.toMatchObject({
      state: 'paused_network',
      recovery: { fromState: 'paused_network', action: 'resume-network', pathRole: 'destination' }
    });
  });

  test('persists the exact replacement operation and phase across a canonical network pause', async () => {
    const candidate = 'D:\\TeslaCam\\clip.candidate';
    const config = validConfig({ destinationRoot: null, outputMode: 'replace', replacementConfirmed: true });
    const store = createJobStore({ rootDir, fs: fs.promises });
    const manifest = job('recover-network-replacing', activeJob('paused_network', {
      config,
      replacementPhase: 'candidate-written',
      ownedPaths: { replacementCandidate: candidate },
      ownedArtifacts: { replacementCandidate: { path: candidate, nonce: 'candidate-nonce', state: 'intent' } },
      recovery: {
        fromState: 'paused_network', action: 'resume-network', pathRole: 'source',
        resumeState: 'replacing', phase: 'candidate-written'
      }
    }));

    await expect(store.save(manifest)).resolves.toMatchObject({
      state: 'paused_network', replacementPhase: 'candidate-written',
      recovery: { resumeState: 'replacing', phase: 'candidate-written' }
    });
    await expect(createJobStore({ rootDir, fs: fs.promises }).recover('recover-network-replacing', async () => {
      throw new Error('canonical network recovery must remain idempotent');
    })).resolves.toMatchObject({
      state: 'paused_network', replacementPhase: 'candidate-written',
      recovery: { resumeState: 'replacing', phase: 'candidate-written' }
    });
  });

  test.each([
    [{ resumeState: 'copying', phase: 'candidate-written' }, 'phase outside replacement'],
    [{ resumeState: 'replacing' }, 'replacement without phase'],
    [{ resumeState: 'encoding', replacementOwnership: true }, 'replacement ownership outside replacement'],
    [{ resumeState: 'encoding', noActiveItem: true }, 'transaction resume without active item']
  ])('rejects a paused-network cross-field mismatch: %s', async (shape) => {
    const candidate = 'D:\\TeslaCam\\clip.candidate';
    const store = createJobStore({ rootDir, fs: fs.promises });
    const replacement = shape.replacementOwnership ? {
      ownedPaths: { replacementCandidate: candidate },
      ownedArtifacts: { replacementCandidate: { path: candidate, nonce: 'candidate-nonce', state: 'intent' } }
    } : {};
    const manifest = job('bad-network-resume', activeJob('paused_network', {
      config: validConfig({ destinationRoot: null, outputMode: 'replace', replacementConfirmed: true }),
      ...(shape.phase ? { replacementPhase: shape.phase } : {}),
      ...replacement,
      recovery: {
        fromState: 'paused_network', action: 'resume-network', pathRole: 'source',
        resumeState: shape.resumeState,
        ...(shape.phase ? { phase: shape.phase } : {})
      }
    }));
    if (shape.noActiveItem) delete manifest.activeItemId;
    await expect(store.save(manifest)).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
  });

  test.each(['staging', 'writing-telemetry', 'verifying'])(
    'maps interrupted %s work to ownership-safe encoding recovery',
    async (state) => {
      const id = `recover-${state}`;
      const store = createJobStore({ rootDir, fs: fs.promises });
      await store.save(job(id, activeJob(state, {
        ownedPaths: { encodedCandidate: 'D:\\temp\\candidate.mp4' }
      })));

      const recovered = await store.recover(id, async () => ({ candidateExists: true }));

      expect(recovered).toMatchObject({
        state: 'paused',
        recovery: { fromState: 'encoding', action: 'cleanup-and-restart-encoding' }
      });
    }
  );

  test('uses an exhaustive copying truth table and fails every unlisted layout closed', async () => {
    const expected = {
      '000': 'restart-copy',
      '011': 'finalize-copy',
      '100': 'resume-copy'
    };
    const store = createJobStore({ rootDir, fs: fs.promises });
    for (let value = 0; value < 8; value += 1) {
      const bits = value.toString(2).padStart(3, '0');
      const id = `copy-${bits}`;
      const facts = {
        partialExists: bits[0] === '1',
        finalExists: bits[1] === '1',
        finalValid: bits[2] === '1'
      };
      await store.save(job(id, activeJob('copying', { revision: 5 })));
      const recovered = await store.recover(id, async () => facts);
      expect(recovered.recovery.action).toBe(expected[bits] || 'manual-intervention');
    }
  });

  test('finalizes a durable final plus partial only when inspection proves they are the same identity', async () => {
    const store = createJobStore({ rootDir, fs: fs.promises });
    await store.save(job('copy-final-partial-alias', activeJob('copying')));

    const recovered = await store.recover('copy-final-partial-alias', async () => ({
      partialExists: true,
      finalExists: true,
      finalValid: true,
      partialFinalSameIdentity: true
    }));

    expect(recovered.recovery.action).toBe('finalize-copy');
  });

  test.each(['candidateExists', 'sourceExists', 'backupExists'])(
    'treats unrelated %s evidence during copying as manual intervention',
    async (extraFact) => {
      const id = `copy-extra-${extraFact.toLowerCase()}`;
      const store = createJobStore({ rootDir, fs: fs.promises });
      await store.save(job(id, activeJob('copying')));
      const recovered = await store.recover(id, async () => ({ [extraFact]: true }));
      expect(recovered.recovery.action).toBe('manual-intervention');
    }
  );

  const replacementTruthTables = {
    'candidate-written': {
      '1100': 'backup-original',
      '1010': 'promote-candidate',
      '0110': 'validate-final',
      '0100': 'restart-replacement',
      '0010': 'restore-backup',
      '0111': 'delete-backup',
      '0101': 'finish-replacement'
    },
    'original-backed-up': {
      '1010': 'promote-candidate',
      '0110': 'validate-final',
      '0010': 'restore-backup',
      '0111': 'delete-backup',
      '0101': 'finish-replacement'
    },
    'candidate-promoted': {
      '1010': 'promote-candidate',
      '0110': 'validate-final',
      '0010': 'restore-backup',
      '0111': 'delete-backup',
      '0101': 'finish-replacement'
    },
    'final-validated': {
      '0111': 'delete-backup',
      '0101': 'finish-replacement',
      '0010': 'restore-backup'
    },
    'backup-deleted': {
      '0101': 'finish-replacement',
      '0111': 'delete-backup',
      '0010': 'restore-backup'
    },
    'rollback-started': {
      '0100': 'rollback-complete',
      '0010': 'restore-backup'
    },
    'backup-restored': {
      '0100': 'rollback-complete',
      '0010': 'restore-backup'
    },
    'rollback-failed': {
      '0100': 'rollback-complete',
      '0010': 'restore-backup'
    }
  };

  test.each(Object.entries(replacementTruthTables))(
    'uses the exhaustive replacement truth table for %s',
    async (replacementPhase, expected) => {
      const store = createJobStore({ rootDir, fs: fs.promises });
      for (let value = 0; value < 16; value += 1) {
        const bits = value.toString(2).padStart(4, '0');
        const id = `${replacementPhase}-${bits}`;
        const facts = {
          candidateExists: bits[0] === '1',
          sourceExists: bits[1] === '1',
          backupExists: bits[2] === '1',
          finalValid: bits[3] === '1'
        };
        await store.save(job(id, activeJob('replacing', { revision: 11, replacementPhase })));
        const recovered = await store.recover(id, async () => facts);
        expect(recovered.recovery.action).toBe(expected[bits] || 'manual-intervention');
      }
    }
  );

  test.each(Object.keys(replacementTruthTables))(
    'treats contradictory source+candidate+backup evidence as manual intervention in %s',
    async (replacementPhase) => {
      const id = `contradiction-${replacementPhase}`;
      const store = createJobStore({ rootDir, fs: fs.promises });
      await store.save(job(id, activeJob('replacing', { replacementPhase })));
      const recovered = await store.recover(id, async () => ({
        sourceExists: true,
        candidateExists: true,
        backupExists: true,
        finalValid: false
      }));
      expect(recovered.recovery.action).toBe('manual-intervention');
    }
  );

  test.each(Object.keys(replacementTruthTables))(
    'treats an unrelated copy partial as manual intervention in replacement phase %s',
    async (replacementPhase) => {
      const id = `extra-partial-${replacementPhase}`;
      const store = createJobStore({ rootDir, fs: fs.promises });
      await store.save(job(id, activeJob('replacing', { replacementPhase })));
      const recovered = await store.recover(id, async () => ({
        partialExists: true,
        sourceExists: true,
        candidateExists: true
      }));
      expect(recovered.recovery.action).toBe('manual-intervention');
    }
  );

  test('fails closed on an inconsistent replacement layout and never persists arbitrary inspection output', async () => {
    const store = createJobStore({ rootDir, fs: fs.promises });
    await store.save(job('inconsistent-replacement', activeJob('replacing', {
      replacementPhase: 'original-backed-up'
    })));

    const recovered = await store.recover('inconsistent-replacement', async () => ({
      sourceExists: true,
      candidateExists: true,
      backupExists: true,
      telemetryPayload: 'must-not-persist'
    }));

    expect(recovered).toMatchObject({
      state: 'paused',
      recovery: { action: 'manual-intervention' }
    });
    expect(JSON.stringify(recovered)).not.toContain('must-not-persist');
  });

  test('converts inspection exceptions to a bounded error and leaves the manifest unchanged', async () => {
    const store = createJobStore({ rootDir, fs: fs.promises });
    await store.save(job('inspection-failure', activeJob('copying', { revision: 9 })));

    await expect(store.recover('inspection-failure', async () => {
      throw new Error('private network credential in arbitrary exception');
    })).rejects.toMatchObject({
      code: 'INSPECTION_FAILED',
      message: 'The interrupted job paths could not be inspected.'
    });
    expect(await store.load('inspection-failure')).toMatchObject({ state: 'copying', revision: 9 });
  });
});
