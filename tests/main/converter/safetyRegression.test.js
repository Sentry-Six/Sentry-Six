'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { createConverterJobService } = require('../../../src/main/converter/jobService');
const { createFilesystemTransactionAdapters } = require('../../../src/main/converter/filesystemTransactions');
const { createFileTransaction } = require('../../../src/main/converter/staging');
const { createRecoveryInspector } = require('../../../src/main/converter/runtime');
const { createJobStore } = require('../../../src/main/converter/jobStore');

// Conditional adapters below model a supplied platform contract ONLY in this
// single-writer disposable fixture. They are not safe production primitives.
function conditionalAdapters(failDestination) {
  return {
    removeOwned: { atomicOwnershipCheck: true, guardedRemoval: true, async remove({ target }) {
      await fs.promises.unlink(target); return { removed: true };
    } },
    renameExclusive: { atomicNoReplace: true, atomicExpectedOwnership: true,
      async promote({ from, to, removeSource, expectedSource }) {
        const actual = await authority(from);
        if (!expectedSource || Object.keys(actual).some((key) => actual[key] !== expectedSource[key])) {
          return { atomicNoReplace: true, sourceRemoved: false, ownershipMismatch: true };
        }
        if (to === failDestination) throw Object.assign(new Error('injected IO failure'), { code: 'EIO' });
        await fs.promises.link(from, to);
        if (removeSource) await fs.promises.unlink(from);
        return { atomicNoReplace: true, sourceRemoved: !!removeSource };
      } }
  };
}
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
async function authority(target) {
  const stat = await fs.promises.lstat(target, { bigint: true });
  return { device: String(stat.dev), inode: String(stat.ino), size: Number(stat.size),
    sha256: digest(await fs.promises.readFile(target)) };
}

describe('audited file-safety regressions using disposable files', () => {
  let root;
  beforeEach(async () => { root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'converter-safety-')); });
  afterEach(async () => { await fs.promises.rm(root, { recursive: true, force: true }); });

  async function fixture(adapters) {
    const source = path.join(root, 'clip.mp4');
    await fs.promises.writeFile(source, 'original');
    const token = crypto.randomUUID();
    const directory = path.join(root, `sentry-six-verification-${token}`);
    await fs.promises.mkdir(directory);
    const snapshot = path.join(directory, `${token}.mp4`);
    await fs.promises.writeFile(snapshot, 'converted');
    const publicationArtifact = { path: snapshot, token, size: 9, sha256: digest('converted') };
    let persisted;
    const tx = createFileTransaction({ tempRoot: root, ...adapters,
      validatePublicationArtifact: async () => true,
      persistTransaction: async (value) => { persisted = value; } });
    return { tx, source, publicationArtifact, operation: { source, sourceRoot: root,
      publicationArtifact, expectedSource: await authority(source), jobId: 'safety', itemId: 'clip' },
    persisted: () => persisted };
  }

  test('default source-removing promotion refuses before a lost unlink reply can destroy either path', async () => {
    const original = path.join(root, 'original');
    const backup = path.join(root, 'backup');
    await fs.promises.writeFile(original, 'original');
    const adapters = createFilesystemTransactionAdapters({ fs: { promises: { ...fs.promises,
      async unlink(target) { await fs.promises.unlink(target); throw Object.assign(new Error('lost reply'), { code: 'EIO' }); }
    } } });
    await expect(adapters.renameExclusive.promote({ from: original, to: backup,
      expectedSource: await authority(original), removeSource: true })).rejects.toMatchObject({ code: 'ATOMIC_PROMOTION_UNSUPPORTED' });
    expect(await fs.promises.readFile(original, 'utf8')).toBe('original');
    await expect(fs.promises.access(backup)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('default ownership cleanup never unlinks a file swapped after its check', async () => {
    const target = path.join(root, 'owned');
    await fs.promises.writeFile(target, 'owned');
    const expected = await authority(target);
    const adapters = createFilesystemTransactionAdapters({ fs: { promises: { ...fs.promises,
      async lstat(file, options) {
        const stat = await fs.promises.lstat(file, options);
        await fs.promises.rename(file, `${file}.retained`);
        await fs.promises.writeFile(file, 'newer user file');
        return stat;
      }
    } } });
    const result = await adapters.removeOwned.remove({ target, expected });
    expect(result.removed).toBe(false);
    expect(await fs.promises.readFile(target, 'utf8')).toMatch(/owned|newer user file/);
    expect(adapters.removeOwned.atomicOwnershipCheck).toBe(false);
  });

  test('unsupported platform refuses replacement and still publishes separate output with explicit retained artifacts', async () => {
    const f = await fixture(createFilesystemTransactionAdapters({ platform: 'linux' }));
    await expect(f.tx.replaceOriginal(f.operation)).rejects.toMatchObject({ code: 'ATOMIC_PROMOTION_UNSUPPORTED' });
    expect(await fs.promises.readFile(f.source, 'utf8')).toBe('original');
    const destination = path.join(root, 'separate.mp4');
    const result = await f.tx.publishSeparate({ ...f.operation, destination });
    expect(await fs.promises.readFile(destination, 'utf8')).toBe('converted');
    expect(result.cleanupPending.length).toBeGreaterThan(0);
    expect(f.tx.capabilities.replacement).toBe('unavailable');
  });

  (process.platform === 'win32' ? test.each : test.skip.each)(['h265', 'av1'])(
    'real Windows adapters replace %s and clean only their owned artifacts', async (codec) => {
      const f = await fixture(createFilesystemTransactionAdapters());
      const result = await f.tx.replaceOriginal({ ...f.operation, codec });
      expect(result.phase).toBe('backup-deleted');
      expect(await fs.promises.readFile(f.source, 'utf8')).toBe('converted');
      expect((await fs.promises.readdir(root)).filter(name => /^(TEMP-|BACKUP-)/.test(name))).toEqual([]);
    }, 60000);

  (process.platform === 'win32' ? test : test.skip)('real Windows adapters restore the original on final verification failure', async () => {
    const f = await fixture(createFilesystemTransactionAdapters());
    await expect(f.tx.replaceOriginal({ ...f.operation, codec: 'h265',
      verifyReadable: async (target) => { if (target === f.source) return false; return true; }
    })).rejects.toMatchObject({ code: 'FINAL_VALIDATION_FAILED' });
    expect(await fs.promises.readFile(f.source, 'utf8')).toBe('original');
    expect((await fs.promises.readdir(root)).filter(name => /^(TEMP-|BACKUP-)/.test(name))).toEqual([]);
  }, 60000);

  test('generic service cleanup preserves the last original after rollback fails', async () => {
    const source = path.join(root, 'clip.mp4');
    const f = await fixture(conditionalAdapters(source));
    await expect(f.tx.replaceOriginal(f.operation)).rejects.toMatchObject({ code: 'ROLLBACK_FAILED' });
    const persisted = f.persisted();
    const backup = persisted.ownedPaths.replacementBackup;
    expect(await fs.promises.readFile(backup, 'utf8')).toBe('original');
    const result = await f.tx.cleanupOwnedArtifacts({ ...f.operation, ...persisted });
    expect(await fs.promises.readFile(backup, 'utf8')).toBe('original');
    expect(result.cleaned).toBe(false);
    expect(result.cleanupPending).toContain('replacementBackup');
  });

  test('replacement rejects same-inode same-size content changed since encoding input capture', async () => {
    const f = await fixture(conditionalAdapters());
    await fs.promises.writeFile(f.source, 'newer!!!');
    await expect(f.tx.replaceOriginal(f.operation)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(await fs.promises.readFile(f.source, 'utf8')).toBe('newer!!!');
  });

  test('replacement without original input authority requires an explicit safe restart', async () => {
    const f = await fixture(conditionalAdapters());
    delete f.operation.expectedSource;
    await expect(f.tx.replaceOriginal(f.operation)).rejects.toMatchObject({ code: 'SOURCE_AUTHORITY_REQUIRED' });
    expect(await fs.promises.readFile(f.source, 'utf8')).toBe('original');
  });

  test('staged capture returns authority for exactly the input copied', async () => {
    const f = await fixture(conditionalAdapters());
    const staged = await f.tx.stageSource(f.operation);
    expect(staged.expectedSource).toEqual(f.operation.expectedSource);
    expect(await fs.promises.readFile(staged.stagedSource, 'utf8')).toBe('original');
  });

  test('production recovery inspector and real store restart an encode with its healthy source present', async () => {
    const source = path.join(root, 'clip.mp4');
    await fs.promises.writeFile(source, 'original');
    const store = createJobStore({ rootDir: path.join(root, 'jobs'), fs: fs.promises });
    const item = { id: 'clip', state: 'processing', kind: 'video', group: 'RecentClips', eventId: null,
      relativePath: 'clip.mp4', sourcePath: source, sourceBytes: 8, mtimeMs: 1,
      timestampKey: '2026-08-30_12-00-00', camera: 'front' };
    await store.create({ id: 'recovery', state: 'encoding', activeItemId: 'clip', items: [item],
      config: { sourceRoot: root, destinationRoot: path.join(root, 'destination'), codec: 'h265',
        profileId: 'balanced', networkMode: 'auto', outputMode: 'separate', includedGroups: ['RecentClips'], replacementConfirmed: false } });
    const recovered = await store.recover('recovery', createRecoveryInspector({ fs: fs.promises, pathApi: path }));
    expect(recovered.recovery.action).toBe('restart-encoding');
  });

  test('real store persists validated original authority and rejects malformed authority', async () => {
    const f = await fixture(conditionalAdapters());
    const store = createJobStore({ rootDir: path.join(root, 'jobs'), fs: fs.promises });
    const item = { id: 'clip', state: 'queued', kind: 'video', group: 'RecentClips', eventId: null,
      relativePath: 'clip.mp4', sourcePath: f.source, sourceBytes: 8, mtimeMs: 1,
      timestampKey: '2026-08-30_12-00-00', camera: 'front', expectedSource: f.operation.expectedSource };
    const config = { sourceRoot: root, destinationRoot: null, codec: 'h265', profileId: 'balanced',
      networkMode: 'auto', outputMode: 'replace', includedGroups: ['RecentClips'], replacementConfirmed: true };
    await store.create({ id: 'authority', config, items: [item] });
    expect((await store.load('authority')).items[0].expectedSource).toEqual(f.operation.expectedSource);
    await expect(store.create({ id: 'invalid', config,
      items: [{ ...item, expectedSource: { ...item.expectedSource, sha256: 'invalid' } }] })).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
  });

  test('legacy replacement recovery never invents authority from the current original', async () => {
    const f = await fixture(conditionalAdapters());
    await expect(f.tx.recoverReplacement({ ...f.operation, expectedSource: undefined,
      action: 'backup-original' })).rejects.toMatchObject({ code: 'SOURCE_AUTHORITY_REQUIRED' });
    expect(await fs.promises.readFile(f.source, 'utf8')).toBe('original');
  });

  test('real service and store retain original backup after publication and restoration both fail', async () => {
    const f = await fixture(conditionalAdapters(path.join(root, 'clip.mp4')));
    await fs.promises.writeFile(f.source, Buffer.alloc(1000000, 0x61));
    const store = createJobStore({ rootDir: path.join(root, 'jobs'), fs: fs.promises });
    const service = createConverterJobService({ store, stagingManager: f.tx, pathApi: path,
      ensureDestinationParent: async () => ({ revalidate: async () => {} }),
      scanner: async function* () { yield { kind: 'video', group: 'RecentClips', eventId: null,
        relativePath: 'clip.mp4', sourcePath: f.source, sourceBytes: 1000000, mtimeMs: 1,
        timestampKey: '2026-08-30_12-00-00', camera: 'front' }; },
      inspectVideo: async () => ({ codec: 'h264', durationSeconds: 1 }),
      readTimeline: async () => ({ samples: [], events: [] }),
      planner: { select: async () => ({ family: 'h265', codec: 'libx265', hardware: false }), selectCpuFallback: async () => ({}) },
      writers: { h265: async ({ candidatePath }) => candidatePath, av1: async ({ candidatePath }) => candidatePath },
      verifier: async () => ({ ok: true, outputBytes: 9, publicationArtifact: f.publicationArtifact }),
      ffmpegPath: 'synthetic-encoder',
      spawnProcess: (_command, args) => {
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.kill = () => { child.emit('close', null, 'SIGTERM'); return true; };
        fs.promises.writeFile(args[args.length - 1], 'converted').then(() => child.emit('close', 0, null));
        return child;
      }
    });
    const id = await service.start({ sourceRoot: root, destinationRoot: null, codec: 'h265', profileId: 'balanced',
      networkMode: 'direct', outputMode: 'replace', includedGroups: ['RecentClips'], replacementConfirmed: true });
    const recovered = await service.whenIdle(id);
    expect(recovered).toMatchObject({ state: 'paused', recovery: { action: 'manual-intervention' } });
    const persisted = await store.load(id);
    const backup = persisted.items[0].ownedPaths.replacementBackup;
    expect(await fs.promises.readFile(backup)).toEqual(Buffer.alloc(1000000, 0x61));
    expect(persisted.items[0].expectedSource.sha256).toBe(digest(Buffer.alloc(1000000, 0x61)));
    await service.shutdown();
    expect(await fs.promises.readFile(backup)).toEqual(Buffer.alloc(1000000, 0x61));
  });

  test('unsupported-cleanup copy recovery supplies partial ownership when resuming publication', async () => {
    const f = await fixture(createFilesystemTransactionAdapters({ platform: 'linux' }));
    const destination = path.join(root, 'copy.mp4');
    const published = await f.tx.publishSeparate({ ...f.operation, destination });
    // Disposable crash fixture: keep the completed partial, no final entry.
    await fs.promises.unlink(destination);
    const recovered = await f.tx.recoverCopy({ ...f.operation, ...published, destination, action: 'resume-copy' });
    expect(await fs.promises.readFile(recovered.finalPath, 'utf8')).toBe('converted');
    expect(recovered.cleanupPending).toContain('destinationPartial');
    expect(await fs.promises.readFile(f.source, 'utf8')).toBe('original');
  });

  test('recovery never grants a newer source authority during the backup-intent journal write', async () => {
    const adapters = conditionalAdapters();
    const actualPromote = adapters.renameExclusive.promote;
    let suppliedAuthority;
    adapters.renameExclusive.promote = async (operation) => {
      suppliedAuthority = operation.expectedSource;
      return actualPromote(operation);
    };
    const f = await fixture(adapters);
    const persistedAuthority = { ...f.operation.expectedSource };
    const nonce = crypto.randomUUID();
    const candidate = `${f.source}.sentry-six-safety-clip-${nonce}.candidate`;
    const backup = `${f.source}.sentry-six-safety-clip-${nonce}.backup`;
    await fs.promises.writeFile(candidate, 'converted');
    await expect(f.tx.recoverReplacement({ ...f.operation, action: 'backup-original',
      ownedPaths: { replacementCandidate: candidate, replacementBackup: backup },
      ownedArtifacts: {
        replacementCandidate: { path: candidate, nonce, state: 'owned', ...await authority(candidate) },
        replacementBackup: { path: backup, nonce, state: 'intent' }
      },
      persistTransaction: async (snapshot) => {
        if (snapshot.step === 'recovery-backup-intent') await fs.promises.writeFile(f.source, 'newer!!!');
      }
    })).rejects.toMatchObject({ code: 'UNSAFE_OWNED_PATH' });
    expect(suppliedAuthority).toMatchObject(persistedAuthority);
    expect(await fs.promises.readFile(f.source, 'utf8')).toBe('newer!!!');
    await expect(fs.promises.access(backup)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.promises.readFile(candidate, 'utf8')).toBe('converted');
  });

  test('unsupported cleanup safely records a profile-size failure without losing retry ownership', async () => {
    const f = await fixture(createFilesystemTransactionAdapters({ platform: 'linux' }));
    const sourceBytes = Buffer.alloc(1000000, 0x61);
    const rejectedBytes = Buffer.alloc(900000, 0x62);
    await fs.promises.writeFile(f.source, sourceBytes);
    const store = createJobStore({ rootDir: path.join(root, 'jobs'), fs: fs.promises });
    let encodes = 0;
    const service = createConverterJobService({ store, stagingManager: f.tx, pathApi: path,
      ensureDestinationParent: async () => ({ revalidate: async () => {} }),
      scanner: async function* () { yield { kind: 'video', group: 'RecentClips', eventId: null,
        relativePath: 'clip.mp4', sourcePath: f.source, sourceBytes: sourceBytes.length, mtimeMs: 1,
        timestampKey: '2026-08-30_12-00-00', camera: 'front' }; },
      inspectVideo: async () => ({ codec: 'h264', durationSeconds: 1 }),
      readTimeline: async () => ({ samples: [], events: [] }),
      planner: { select: async () => ({ family: 'h265', codec: 'libx265', hardware: false }), selectCpuFallback: async () => ({}) },
      writers: { h265: async ({ candidatePath }) => candidatePath, av1: async ({ candidatePath }) => candidatePath },
      verifier: async () => ({ ok: false, reason: 'profile-size', retryable: true,
        sourceBytes: sourceBytes.length, outputBytes: rejectedBytes.length }),
      ffmpegPath: 'synthetic-encoder',
      spawnProcess: (_command, args) => {
        encodes += 1;
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.kill = () => { child.emit('close', null, 'SIGTERM'); return true; };
        fs.promises.writeFile(args[args.length - 1], rejectedBytes).then(() => child.emit('close', 0, null));
        return child;
      }
    });
    const id = await service.start({ sourceRoot: root, destinationRoot: path.join(root, 'output'),
      codec: 'h265', profileId: 'balanced', networkMode: 'direct', outputMode: 'separate',
      includedGroups: ['RecentClips'], replacementConfirmed: false });
    const result = await service.whenIdle(id);
    expect(result).toMatchObject({ state: 'completed', counters: { files: 0 }, items: [{ state: 'failed',
      resultCode: 'cleanup-pending', attempts: 1, failure: { code: 'profile-size', retryable: true } }] });
    const persisted = await store.load(id);
    const candidate = persisted.items[0].ownedPaths.encodedCandidate;
    expect(digest(await fs.promises.readFile(candidate))).toBe(digest(rejectedBytes));
    expect(persisted.items[0].ownedArtifacts.encodedCandidate.sha256).toBe(digest(rejectedBytes));
    expect(await fs.promises.readFile(f.source)).toEqual(sourceBytes);
    await expect(service.retryFailed(id)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(encodes).toBe(1);
    expect((await store.load(id)).items[0].ownedPaths.encodedCandidate).toBe(candidate);
    await service.shutdown();
  });
});
