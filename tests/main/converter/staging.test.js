'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  FileTransactionError,
  classifyPath,
  chooseStagingMode,
  checkStagingSpace,
  createFileTransaction
} = require('../../../src/main/converter/staging');

const roots = [];

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function temporaryRoot(label) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `sentry-six-staging-${label}-`));
  roots.push(root);
  return root;
}

async function write(filePath, bytes) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, bytes);
  return filePath;
}

async function artifact(root, bytes = Buffer.from('verified candidate bytes')) {
  const token = crypto.randomUUID();
  const directory = path.join(root, `sentry-six-verification-${token}`);
  const artifactPath = await write(path.join(directory, `${token}.mp4`), bytes);
  return { path: artifactPath, token, sha256: digest(bytes), size: bytes.length };
}

async function exists(filePath) {
  try {
    await fs.promises.lstat(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function ownedMetadata(recordedPath, nonce, state = 'owned', identityPath = recordedPath) {
  const bytes = await fs.promises.readFile(identityPath);
  const stat = await fs.promises.lstat(identityPath, { bigint: true });
  return {
    path: recordedPath,
    nonce,
    state,
    size: Number(stat.size),
    sha256: digest(bytes),
    device: String(stat.dev),
    inode: String(stat.ino)
  };
}

function replacementFixturePaths(source, jobId, itemId, candidateNonce, backupNonce = candidateNonce) {
  return {
    candidate: `${source}.sentry-six-${jobId}-${itemId}-${candidateNonce}.candidate`,
    backup: `${source}.sentry-six-${jobId}-${itemId}-${backupNonce}.backup`
  };
}

function partialFixturePath(destination, jobId, itemId, nonce) {
  return `${destination}.sentry-six-${jobId}-${itemId}-${nonce}.partial`;
}

async function writingMetadata(target, nonce, committed, pending = null) {
  const metadata = await ownedMetadata(target, nonce, 'writing');
  metadata.size = committed.size;
  metadata.sha256 = committed.sha256;
  metadata.journal = { committed: { ...committed }, pending: pending ? { ...pending } : null };
  return metadata;
}

function createConfiguredTransaction(options = {}) {
  const tx = createFileTransaction({
    validatePublicationArtifact: async () => true,
    persistTransaction: async () => {},
    removeOwned: ownershipSafeRemover(),
    renameExclusive: expectedOwnershipTransaction(),
    ...options
  });
  // Existing single-writer transaction fixtures capture input authority before
  // invoking the operation. Missing-authority behavior uses the real factory
  // directly in safetyRegression.test.js.
  const inputAuthority = async (target) => {
    const metadata = await ownedMetadata(target, 'fixture');
    return { size: metadata.size, sha256: metadata.sha256, device: metadata.device, inode: metadata.inode };
  };
  return { ...tx,
    replaceOriginal: async (operation) => tx.replaceOriginal({ ...operation,
      expectedSource: operation.expectedSource || await inputAuthority(operation.source) }),
    recoverReplacement: async (operation) => tx.recoverReplacement({ ...operation,
      expectedSource: operation.expectedSource || await inputAuthority(
        operation.ownedPaths?.replacementBackup && await exists(operation.ownedPaths.replacementBackup)
          ? operation.ownedPaths.replacementBackup : operation.source) })
  };
}

function durableCapabilityRegistry(state = new Map()) {
  const validator = jest.fn(async (value, context = {}) => {
    const record = `${value.path}|${value.sha256}|${value.size}`;
    if (context.mode === 'reconcile') {
      return state.get(value.token) === record
        && context.persistedArtifact?.token === value.token;
    }
    if (context.mode !== 'consume' || state.has(value.token)) return false;
    state.set(value.token, record);
    return true;
  });
  return { state, validator };
}

function streamingFsAdapter({ onRead, onWrite, forbidWholeFile = false, overrides = {} } = {}) {
  return {
    ...fs,
    promises: {
      ...fs.promises,
      ...overrides,
      open: async (target, ...args) => {
        const handle = await fs.promises.open(target, ...args);
        return {
          read: async (...readArgs) => {
            const result = await handle.read(...readArgs);
            if (result.bytesRead > 0) onRead?.(target, result.bytesRead);
            return result;
          },
          write: async (...writeArgs) => {
            const result = await handle.write(...writeArgs);
            if (result.bytesWritten > 0) onWrite?.(target, result.bytesWritten);
            return result;
          },
          readFile: forbidWholeFile
            ? async () => { throw new Error('full-file read forbidden'); }
            : (...readArgs) => handle.readFile(...readArgs),
          writeFile: forbidWholeFile
            ? async () => { throw new Error('full-file write forbidden'); }
            : (...writeArgs) => handle.writeFile(...writeArgs),
          stat: (...statArgs) => handle.stat(...statArgs),
          sync: (...syncArgs) => handle.sync(...syncArgs),
          close: (...closeArgs) => handle.close(...closeArgs)
        };
      }
    }
  };
}

function ownershipSafeRemover(overrides = {}) {
  return {
    atomicOwnershipCheck: true,
    guardedRemoval: true,
    remove: jest.fn(async ({ target, expected, guard }) => {
      if (overrides.remove) {
        const overridden = await overrides.remove({ target, expected, guard });
        if (overridden !== undefined) return overridden;
      }
      try {
        const stat = await fs.promises.lstat(target, { bigint: true });
        if (String(stat.dev) !== expected.device || String(stat.ino) !== expected.inode) {
          return { removed: false, ownershipMismatch: true };
        }
        await fs.promises.unlink(target);
        return { removed: true };
      } catch (error) {
        if (error.code === 'ENOENT') return { removed: false, missing: true };
        return { removed: false, failed: true };
      }
    })
  };
}

function expectedOwnershipTransaction() {
  return {
    atomicNoReplace: true,
    atomicExpectedOwnership: true,
    promote: jest.fn(async ({ from, to, expectedSource, removeSource = true }) => {
      const stat = await fs.promises.lstat(from, { bigint: true });
      if (expectedSource && (String(stat.dev) !== expectedSource.device || String(stat.ino) !== expectedSource.inode)) {
        return { atomicNoReplace: true, sourceRemoved: false, ownershipMismatch: true };
      }
      await fs.promises.link(from, to);
      if (removeSource) await fs.promises.unlink(from);
      return { atomicNoReplace: true, sourceRemoved: removeSource };
    })
  };
}

describe('explicitly unavailable destructive capabilities', () => {
  test('requires final-file guarded deletion before enabling replacement', async () => {
    const root = await temporaryRoot('guard-required');
    const tx = createConfiguredTransaction({ tempRoot: root,
      removeOwned: { ...ownershipSafeRemover(), guardedRemoval: false } });
    expect(tx.capabilities.replacement).toBe('unavailable');
  });

  test('guards the verified installed file while removing its original backup', async () => {
    const root = await temporaryRoot('guard-installed');
    const source = await write(path.join(root, '2026-09-20_12-00-00-front.mp4'), Buffer.from('original'));
    const publicationArtifact = await artifact(root);
    let guarded = false;
    const tx = createConfiguredTransaction({ tempRoot: root, removeOwned: ownershipSafeRemover({
      remove: async ({ target, guard }) => {
        if (!path.basename(target).startsWith('BACKUP-')) return;
        expect(guard).toMatchObject({ target: source, expected: {
          size: publicationArtifact.size, sha256: publicationArtifact.sha256
        } });
        const stat = await fs.promises.stat(source, { bigint: true });
        expect(guard.expected.inode).toBe(String(stat.ino));
        guarded = true;
      }
    }) });
    await tx.replaceOriginal({ jobId: 'guard-job', itemId: 'item-1', codec: 'h265', source,
      sourceRoot: root, publicationArtifact });
    expect(guarded).toBe(true);
    expect(await fs.promises.readFile(source)).toEqual(Buffer.from('verified candidate bytes'));
  });

  test('refuses replacement before creating a candidate when its volume has insufficient space', async () => {
    const root = await temporaryRoot('replacement-space');
    const source = await write(path.join(root, '2026-09-20_12-00-00-front.mp4'), Buffer.from('original'));
    const tx = createConfiguredTransaction({ tempRoot: root, replacementFreeSpace: async () => 0n });
    await expect(tx.replaceOriginal({ jobId: 'space-job', itemId: 'item-1', codec: 'h265', source,
      sourceRoot: root, publicationArtifact: await artifact(root) }))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_REPLACEMENT_SPACE' });
    expect(await fs.promises.readFile(source, 'utf8')).toBe('original');
    expect((await fs.promises.readdir(root)).some(name => /^(TEMP-|BACKUP-)/.test(name))).toBe(false);
  });

  test('composes without an ownership remover and reports the fail-closed transaction status', async () => {
    const root = await temporaryRoot('no-destructive-capability');
    const tempRoot = path.join(root, 'owned-temp');
    await fs.promises.mkdir(tempRoot);

    const tx = createFileTransaction({
      fs,
      pathApi: path,
      tempRoot,
      validatePublicationArtifact: async () => true,
      persistTransaction: async () => {}
    });

    expect(tx.capabilities).toEqual({
      separatePublication: 'hardlink-cleanup-pending',
      ownershipCleanup: 'unavailable',
      replacement: 'unavailable'
    });
  });

  test('retains cleanup-pending files but releases staged and encoder leases for the next item', async () => {
    const root = await temporaryRoot('cleanup-pending-lease-release');
    const tempRoot = path.join(root, 'owned-temp');
    await fs.promises.mkdir(tempRoot);
    const firstSource = await write(path.join(root, 'first.mp4'), Buffer.from('first source'));
    const secondSource = await write(path.join(root, 'second.mp4'), Buffer.from('second source'));
    const persisted = [];
    const tx = createFileTransaction({
      fs,
      pathApi: path,
      tempRoot,
      validatePublicationArtifact: async () => true,
      persistTransaction: async (snapshot) => persisted.push(JSON.parse(JSON.stringify(snapshot)))
    });

    const firstStage = await tx.stageSource({ source: firstSource, jobId: 'job-1', itemId: 'item-1' });
    const firstReservation = await tx.reserveEncodeOutput({ jobId: 'job-1', itemId: 'item-1' });
    await fs.promises.writeFile(firstReservation.path, Buffer.from('encoded output'));
    const firstEncoded = await tx.adoptEncodeOutput({
      jobId: 'job-1', itemId: 'item-1',
      ownedPaths: firstReservation.ownedPaths,
      ownedArtifacts: firstReservation.ownedArtifacts
    });
    const retained = {
      ownedPaths: { ...firstStage.ownedPaths, ...firstEncoded.ownedPaths },
      ownedArtifacts: { ...firstStage.ownedArtifacts, ...firstEncoded.ownedArtifacts }
    };

    await expect(tx.cleanupOwnedArtifacts({ ...retained, jobId: 'job-1', itemId: 'item-1' }))
      .resolves.toMatchObject({
        cleaned: false,
        cleanupPending: ['stagedSource', 'encodedCandidate'],
        ownedArtifacts: {
          stagedSource: { state: 'cleanup-pending' },
          encodedCandidate: { state: 'cleanup-pending' }
        }
      });
    expect(await exists(firstStage.stagedSource)).toBe(true);
    expect(await exists(firstEncoded.path)).toBe(true);

    const secondStage = await tx.stageSource({ source: secondSource, jobId: 'job-1', itemId: 'item-2' });
    const secondReservation = await tx.reserveEncodeOutput({ jobId: 'job-1', itemId: 'item-2' });
    expect(secondStage.stagedSource).not.toBe(firstStage.stagedSource);
    expect(secondReservation.path).not.toBe(firstEncoded.path);
    expect(persisted).toContainEqual(expect.objectContaining({
      step: 'owned-cleanup-pending',
      cleanupPending: ['stagedSource', 'encodedCandidate']
    }));
  });

  test('does not release an unavailable-cleanup lease until cleanup-pending is durable', async () => {
    const root = await temporaryRoot('cleanup-pending-persist-boundary');
    const tempRoot = path.join(root, 'owned-temp');
    await fs.promises.mkdir(tempRoot);
    const firstSource = await write(path.join(root, 'first.mp4'), Buffer.from('first source'));
    const secondSource = await write(path.join(root, 'second.mp4'), Buffer.from('second source'));
    const tx = createFileTransaction({
      fs,
      pathApi: path,
      tempRoot,
      validatePublicationArtifact: async () => true,
      persistTransaction: async (snapshot) => {
        if (snapshot.step === 'owned-cleanup-pending') throw new Error('journal unavailable');
      }
    });

    const firstStage = await tx.stageSource({ source: firstSource, jobId: 'job-1', itemId: 'item-1' });
    await expect(tx.cleanupOwnedArtifacts({
      jobId: 'job-1', itemId: 'item-1',
      ownedPaths: firstStage.ownedPaths,
      ownedArtifacts: firstStage.ownedArtifacts
    })).rejects.toMatchObject({ code: 'TRANSACTION_STATE_PERSIST_FAILED' });

    expect(await exists(firstStage.stagedSource)).toBe(true);
    await expect(tx.stageSource({ source: secondSource, jobId: 'job-1', itemId: 'item-2' }))
      .rejects.toMatchObject({ code: 'STAGING_BUSY' });
  });

  test('does not advertise a supplied promotion adapter without its proven atomic contract', async () => {
    const root = await temporaryRoot('invalid-promotion-capability');
    const tempRoot = path.join(root, 'owned-temp');
    await fs.promises.mkdir(tempRoot);

    const tx = createFileTransaction({
      fs,
      pathApi: path,
      tempRoot,
      validatePublicationArtifact: async () => true,
      persistTransaction: async () => {},
      renameExclusive: { atomicNoReplace: true }
    });

    expect(tx.capabilities.separatePublication).toBe('unavailable');
    expect(tx.capabilities.replacement).toBe('unavailable');
  });

  test('rejects replacement before validating or mutating the publication artifact', async () => {
    const root = await temporaryRoot('no-replacement-capability');
    const tempRoot = path.join(root, 'owned-temp');
    await fs.promises.mkdir(tempRoot);
    const validatePublicationArtifact = jest.fn(async () => true);
    const tx = createFileTransaction({ fs, pathApi: path, tempRoot, validatePublicationArtifact });

    await expect(tx.replaceOriginal({
      source: path.join(root, 'TeslaCam', 'clip.mp4'),
      sourceRoot: path.join(root, 'TeslaCam'),
      publicationArtifact: { path: path.join(root, 'snapshot.mp4'), token: 'token', sha256: 'a'.repeat(64), size: 1 },
      jobId: 'job-1',
      itemId: 'item-1'
    })).rejects.toMatchObject({ code: 'ATOMIC_PROMOTION_UNSUPPORTED' });
    expect(validatePublicationArtifact).not.toHaveBeenCalled();
  });

  test('allows no-overwrite hard-link publication to finish with explicit cleanup-pending ownership', async () => {
    const root = await temporaryRoot('hardlink-cleanup-pending');
    const tempRoot = path.join(root, 'owned-temp');
    const destination = path.join(root, 'destination', 'clip.mp4');
    await fs.promises.mkdir(tempRoot);
    await fs.promises.mkdir(path.dirname(destination));
    const publicationArtifact = await artifact(root, Buffer.from('verified output'));
    const tx = createFileTransaction({
      fs,
      pathApi: path,
      tempRoot,
      validatePublicationArtifact: async () => true,
      persistTransaction: async () => {}
    });

    const result = await tx.publishSeparate({ publicationArtifact, destination, jobId: 'job-1', itemId: 'item-1' });

    expect(await fs.promises.readFile(destination, 'utf8')).toBe('verified output');
    expect(result.cleanupPending.sort()).toEqual(['destinationPartial', 'publicationSnapshot']);
    expect(result.ownedArtifacts.destinationPartial.state).toBe('cleanup-pending');
    expect(result.ownedArtifacts.publicationSnapshot.state).toBe('cleanup-pending');
  });
});

async function transaction(label, overrides = {}) {
  const root = await temporaryRoot(label);
  const tempRoot = path.join(root, 'owned-temp');
  await fs.promises.mkdir(tempRoot);
  return {
    root,
    tempRoot,
    tx: createConfiguredTransaction({ fs, pathApi: path, tempRoot, ...overrides })
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true })));
});

describe('NAS path classification and staging choice', () => {
  test('classifies ordinary and extended UNC paths as network without consulting the adapter', async () => {
    const volumeInfo = jest.fn();
    await expect(classifyPath('\\\\server\\TeslaCam\\clip.mp4', { pathApi: path.win32, platform: 'win32', volumeInfo }))
      .resolves.toEqual({ kind: 'network', reason: 'unc' });
    await expect(classifyPath('\\\\?\\UNC\\server\\share\\clip.mp4', { pathApi: path.win32, platform: 'win32', volumeInfo }))
      .resolves.toEqual({ kind: 'network', reason: 'unc' });
    expect(volumeInfo).not.toHaveBeenCalled();
  });

  test('uses the mapped-drive adapter and fails ambiguous mounts to the safe direct fallback', async () => {
    const volumeInfo = jest.fn(async (candidate) => ({ remote: candidate.startsWith('Z:'), certain: true }));
    await expect(classifyPath('Z:\\TeslaCam\\clip.mp4', { pathApi: path.win32, platform: 'win32', volumeInfo }))
      .resolves.toEqual({ kind: 'network', reason: 'mapped-remote' });
    await expect(classifyPath('/Volumes/TeslaCam/clip.mp4', { pathApi: path.posix, platform: 'darwin' }))
      .resolves.toEqual({ kind: 'ambiguous', reason: 'volume-unknown' });
    expect(chooseStagingMode({ networkMode: 'auto', classification: { kind: 'ambiguous' }, space: { sufficient: true } }))
      .toEqual({ mode: 'direct', reason: 'ambiguous-volume' });
  });

  test('honors explicit direct/staging overrides and auto space fallback', () => {
    expect(chooseStagingMode({ networkMode: 'direct', classification: { kind: 'network' } }))
      .toEqual({ mode: 'direct', reason: 'forced-direct' });
    expect(chooseStagingMode({ networkMode: 'staging', classification: { kind: 'local' }, space: { sufficient: true } }))
      .toEqual({ mode: 'staging', reason: 'forced-staging' });
    expect(chooseStagingMode({ networkMode: 'auto', classification: { kind: 'network' }, space: { sufficient: false } }))
      .toEqual({ mode: 'direct', reason: 'insufficient-space' });
    expect(() => chooseStagingMode({ networkMode: 'staging', classification: { kind: 'network' }, space: { sufficient: false } }))
      .toThrow(expect.objectContaining({ code: 'INSUFFICIENT_STAGING_SPACE' }));
  });

  test('checks source, output allowance, working reserve, and safe integer bounds', async () => {
    const volumeInfo = { freeSpace: jest.fn(async () => 2_599) };
    await expect(checkStagingSpace({ sourceBytes: 1_000, outputBytes: 1_000, reserveBytes: 600, tempRoot: 'C:\\temp', volumeInfo }))
      .resolves.toEqual({ sufficient: false, requiredBytes: 2_600, freeBytes: 2_599 });
    await expect(checkStagingSpace({ sourceBytes: 1_000, outputBytes: 1_000, reserveBytes: 599, tempRoot: 'C:\\temp', volumeInfo }))
      .resolves.toEqual({ sufficient: true, requiredBytes: 2_599, freeBytes: 2_599 });
    await expect(checkStagingSpace({ sourceBytes: Number.MAX_SAFE_INTEGER, outputBytes: 1, reserveBytes: 0, tempRoot: 'C:\\temp', volumeInfo }))
      .rejects.toMatchObject({ code: 'INVALID_TRANSACTION_INPUT' });
  });
});

describe('owned encoder output lifecycle', () => {
  test('persists a nonce-bound intent before exposing an absent FFmpeg -n target', async () => {
    const snapshots = [];
    const { tempRoot, tx } = await transaction('encode-reserve', {
      persistTransaction: async (snapshot) => snapshots.push(snapshot)
    });

    const reserved = await tx.reserveEncodeOutput({
      jobId: 'job-1', itemId: 'item-1', extension: '.mp4'
    });

    expect(path.dirname(reserved.path)).toBe(tempRoot);
    expect(path.basename(reserved.path)).toMatch(/^job-1-item-1-[a-z0-9-]+-encoded\.mp4$/);
    expect(await exists(reserved.path)).toBe(false);
    expect(snapshots).toEqual([{
      step: 'encoded-candidate-intent',
      ownedPaths: { encodedCandidate: reserved.path },
      ownedArtifacts: {
        encodedCandidate: { path: reserved.path, nonce: reserved.nonce, state: 'intent' }
      }
    }]);
  });

  test('adopts only the exact reserved regular output with bigint identity and digest', async () => {
    const snapshots = [];
    const { tx } = await transaction('encode-adopt', {
      persistTransaction: async (snapshot) => snapshots.push(snapshot)
    });
    const reserved = await tx.reserveEncodeOutput({ jobId: 'job-1', itemId: 'item-1' });
    const bytes = Buffer.from('ffmpeg candidate');
    await write(reserved.path, bytes);

    const adopted = await tx.adoptEncodeOutput({
      jobId: 'job-1', itemId: 'item-1',
      ownedPaths: reserved.ownedPaths,
      ownedArtifacts: reserved.ownedArtifacts
    });

    expect(adopted.ownedPaths).toEqual({ encodedCandidate: reserved.path });
    expect(adopted.ownedArtifacts.encodedCandidate).toMatchObject({
      path: reserved.path,
      nonce: reserved.nonce,
      state: 'owned',
      size: bytes.length,
      sha256: digest(bytes),
      device: expect.stringMatching(/^\d+$/),
      inode: expect.stringMatching(/^\d+$/)
    });
    expect(snapshots.at(-1)).toEqual({
      step: 'encoded-candidate-owned',
      ownedPaths: adopted.ownedPaths,
      ownedArtifacts: adopted.ownedArtifacts
    });
  });

  test('refreshes an adopted candidate after an in-place telemetry rewrite', async () => {
    const snapshots = [];
    const { tx } = await transaction('encode-refresh', {
      persistTransaction: async (snapshot) => snapshots.push(snapshot)
    });
    const reserved = await tx.reserveEncodeOutput({ jobId: 'job-1', itemId: 'item-1' });
    await write(reserved.path, Buffer.from('ffmpeg'));
    const adopted = await tx.adoptEncodeOutput({
      jobId: 'job-1', itemId: 'item-1',
      ownedPaths: reserved.ownedPaths,
      ownedArtifacts: reserved.ownedArtifacts
    });
    const identity = {
      device: adopted.ownedArtifacts.encodedCandidate.device,
      inode: adopted.ownedArtifacts.encodedCandidate.inode
    };
    await fs.promises.writeFile(reserved.path, Buffer.from('telemetry-written'));

    const refreshed = await tx.adoptEncodeOutput({
      jobId: 'job-1', itemId: 'item-1',
      ownedPaths: adopted.ownedPaths,
      ownedArtifacts: adopted.ownedArtifacts
    });

    expect(refreshed.ownedArtifacts.encodedCandidate).toMatchObject({
      state: 'owned', size: 17, sha256: digest(Buffer.from('telemetry-written')), ...identity
    });
    expect(snapshots.at(-1)).toMatchObject({ step: 'encoded-candidate-owned' });
  });

  test('adopts an exact zero-byte failed output so cancellation can remove it safely', async () => {
    const remover = ownershipSafeRemover();
    const { tx } = await transaction('encode-empty-cleanup', { removeOwned: remover });
    const reserved = await tx.reserveEncodeOutput({ jobId: 'job-1', itemId: 'item-1' });
    await write(reserved.path, Buffer.alloc(0));

    const adopted = await tx.adoptEncodeOutput({
      jobId: 'job-1', itemId: 'item-1',
      ownedPaths: reserved.ownedPaths,
      ownedArtifacts: reserved.ownedArtifacts
    });
    expect(adopted.ownedArtifacts.encodedCandidate).toMatchObject({
      state: 'owned', size: 0, sha256: digest(Buffer.alloc(0))
    });
    await expect(tx.cleanupOwnedArtifacts({
      jobId: 'job-1', itemId: 'item-1',
      ownedPaths: adopted.ownedPaths,
      ownedArtifacts: adopted.ownedArtifacts
    })).resolves.toEqual({ cleaned: true });
    expect(await exists(reserved.path)).toBe(false);
  });

  test('rehydrates a persisted nonce intent after restart before cleanup or resume', async () => {
    const { tempRoot, tx } = await transaction('encode-restart-adopt');
    const reserved = await tx.reserveEncodeOutput({ jobId: 'job-1', itemId: 'item-1' });
    await write(reserved.path, Buffer.from('crash-left-candidate'));
    const restarted = createConfiguredTransaction({ fs, pathApi: path, tempRoot });

    await expect(restarted.adoptEncodeOutput({
      jobId: 'job-1', itemId: 'item-1',
      ownedPaths: reserved.ownedPaths,
      ownedArtifacts: reserved.ownedArtifacts
    })).resolves.toMatchObject({
      path: reserved.path,
      ownedArtifacts: { encodedCandidate: { state: 'owned', sha256: digest(Buffer.from('crash-left-candidate')) } }
    });
  });

  test('rejects aliased replacement outputs without adopting or deleting them', async () => {
    const { root, tx } = await transaction('encode-unsafe');
    const reserved = await tx.reserveEncodeOutput({ jobId: 'job-1', itemId: 'item-1' });
    const unrelated = await write(path.join(root, 'unrelated.mp4'), Buffer.from('unrelated'));
    await fs.promises.link(unrelated, reserved.path);

    await expect(tx.adoptEncodeOutput({
      jobId: 'job-1', itemId: 'item-1',
      ownedPaths: reserved.ownedPaths,
      ownedArtifacts: reserved.ownedArtifacts
    })).rejects.toMatchObject({ code: 'UNSAFE_OWNED_PATH' });
    expect(await fs.promises.readFile(unrelated, 'utf8')).toBe('unrelated');
  });

  test('cleans adopted output only through the ownership-safe remover', async () => {
    const remover = ownershipSafeRemover();
    const { tx } = await transaction('encode-cleanup', { removeOwned: remover });
    const reserved = await tx.reserveEncodeOutput({ jobId: 'job-1', itemId: 'item-1' });
    await write(reserved.path, Buffer.from('candidate'));
    const adopted = await tx.adoptEncodeOutput({
      jobId: 'job-1', itemId: 'item-1',
      ownedPaths: reserved.ownedPaths,
      ownedArtifacts: reserved.ownedArtifacts
    });

    await expect(tx.cleanupOwnedArtifacts({
      jobId: 'job-1', itemId: 'item-1',
      ownedPaths: adopted.ownedPaths,
      ownedArtifacts: adopted.ownedArtifacts
    })).resolves.toEqual({ cleaned: true });
    expect(remover.remove).toHaveBeenCalledWith(expect.objectContaining({
      target: reserved.path,
      expected: expect.objectContaining({ nonce: reserved.nonce, sha256: digest(Buffer.from('candidate')) })
    }));
    expect(await exists(reserved.path)).toBe(false);
  });

  test('retains exact adopted ownership for cleanup when the owned-state persist fails', async () => {
    let rejectOwned = true;
    const { tx } = await transaction('encode-adopt-persist-failure', {
      persistTransaction: async (snapshot) => {
        if (rejectOwned && snapshot.step === 'encoded-candidate-owned') throw new Error('store unavailable');
      }
    });
    const reserved = await tx.reserveEncodeOutput({ jobId: 'job-1', itemId: 'item-1' });
    await write(reserved.path, Buffer.from('candidate'));

    await expect(tx.adoptEncodeOutput({
      jobId: 'job-1', itemId: 'item-1',
      ownedPaths: reserved.ownedPaths,
      ownedArtifacts: reserved.ownedArtifacts
    })).rejects.toMatchObject({ code: 'TRANSACTION_STATE_PERSIST_FAILED' });
    expect(reserved.ownedArtifacts.encodedCandidate).toMatchObject({
      state: 'owned', size: 9, sha256: digest(Buffer.from('candidate')),
      device: expect.stringMatching(/^\d+$/), inode: expect.stringMatching(/^\d+$/)
    });

    rejectOwned = false;
    await expect(tx.cleanupOwnedArtifacts({
      jobId: 'job-1', itemId: 'item-1',
      ownedPaths: reserved.ownedPaths,
      ownedArtifacts: reserved.ownedArtifacts
    })).resolves.toEqual({ cleaned: true });
  });

  test('releases the encoded lease when cleanup persistence fails before deletion', async () => {
    let failCleanupIntent = true;
    const { tx } = await transaction('cleanup-intent-persist-failure', {
      persistTransaction: async (snapshot) => {
        if (failCleanupIntent && snapshot.step === 'owned-cleanup-intent') throw new Error('store unavailable');
      }
    });
    const reserved = await tx.reserveEncodeOutput({ jobId: 'job-1', itemId: 'item-1' });
    await write(reserved.path, Buffer.from('candidate'));
    const adopted = await tx.adoptEncodeOutput({
      jobId: 'job-1', itemId: 'item-1',
      ownedPaths: reserved.ownedPaths,
      ownedArtifacts: reserved.ownedArtifacts
    });
    await expect(tx.cleanupOwnedArtifacts({
      jobId: 'job-1', itemId: 'item-1',
      ownedPaths: adopted.ownedPaths,
      ownedArtifacts: adopted.ownedArtifacts
    })).rejects.toMatchObject({ code: 'TRANSACTION_STATE_PERSIST_FAILED' });

    failCleanupIntent = false;
    const next = await tx.reserveEncodeOutput({ jobId: 'job-1', itemId: 'item-2' });
    expect(next.path).toContain('job-1-item-2-');
  });
});

describe('relevant event asset transaction', () => {
  test('copies one bounded stream to the mirrored path and atomically preserves the source', async () => {
    const reads = [];
    const writes = [];
    const snapshots = [];
    const { root, tempRoot } = await transaction('asset-copy');
    const sourceRoot = path.join(root, 'TeslaCam');
    const destinationRoot = path.join(root, 'Converted');
    const relativePath = path.join('SentryClips', 'event-1', 'event.json');
    const source = await write(path.join(sourceRoot, relativePath), Buffer.from('asset-payload'));
    const destination = path.join(destinationRoot, relativePath);
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    const adapter = streamingFsAdapter({
      onRead: (target, size) => reads.push([target, size]),
      onWrite: (target, size) => writes.push([target, size]),
      forbidWholeFile: true
    });
    const tx = createConfiguredTransaction({
      fs: adapter, pathApi: path, tempRoot, chunkSize: 4,
      persistTransaction: async (snapshot) => snapshots.push(snapshot)
    });

    const result = await tx.copyAsset({
      source, sourceRoot, destination, destinationRoot,
      jobId: 'job-1', itemId: 'asset-1'
    });

    expect(result).toMatchObject({ finalPath: destination, outputBytes: 13 });
    expect(await fs.promises.readFile(source, 'utf8')).toBe('asset-payload');
    expect(await fs.promises.readFile(destination, 'utf8')).toBe('asset-payload');
    expect(reads.filter(([target]) => target === source).reduce((n, [, size]) => n + size, 0)).toBe(13);
    const partialWrites = writes.filter(([target]) => target.includes('.partial'));
    expect(partialWrites.reduce((n, [, size]) => n + size, 0)).toBe(13);
    expect(Math.max(...partialWrites.map(([, size]) => size))).toBeLessThanOrEqual(4);
    expect(snapshots.map((snapshot) => snapshot.step)).toEqual(expect.arrayContaining([
      'asset-partial-intent', 'asset-partial-writing', 'asset-partial-owned',
      'asset-promotion-intent', 'asset-complete-cleanup-pending'
    ]));
    expect(result.cleanupPending).toEqual(['destinationPartial']);
  });

  test('reports a verified copied asset when only final transaction persistence fails', async () => {
    const { root, tempRoot } = await transaction('asset-final-persist-failure');
    const sourceRoot = path.join(root, 'TeslaCam');
    const destinationRoot = path.join(root, 'Converted');
    const source = await write(path.join(sourceRoot, 'event.json'), Buffer.from('asset-payload'));
    const destination = path.join(destinationRoot, 'event.json');
    await fs.promises.mkdir(destinationRoot, { recursive: true });
    const tx = createConfiguredTransaction({ fs, pathApi: path, tempRoot });

    await expect(tx.copyAsset({
      source, sourceRoot, destination, destinationRoot,
      jobId: 'job-1', itemId: 'asset-1',
      persistTransaction: async ({ step }) => {
        if (step === 'asset-complete-cleanup-pending') throw new Error('manifest unavailable');
      }
    })).rejects.toMatchObject({
      code: 'TRANSACTION_STATE_PERSIST_FAILED',
      validFinal: { finalPath: destination, outputBytes: 13 }
    });
    expect(await fs.promises.readFile(destination, 'utf8')).toBe('asset-payload');
  });

  test('never overwrites an existing asset destination', async () => {
    const { root, tempRoot, tx } = await transaction('asset-collision');
    const sourceRoot = path.join(root, 'TeslaCam');
    const destinationRoot = path.join(root, 'Converted');
    const source = await write(path.join(sourceRoot, 'event.json'), Buffer.from('new'));
    const destination = await write(path.join(destinationRoot, 'event.json'), Buffer.from('existing'));

    await expect(tx.copyAsset({
      source, sourceRoot, destination, destinationRoot,
      jobId: 'job-1', itemId: 'asset-1'
    })).rejects.toMatchObject({ code: 'DESTINATION_COLLISION' });
    expect(await fs.promises.readFile(destination, 'utf8')).toBe('existing');
  });

  test('removes only its promoted alias when destination read-back rejects the asset', async () => {
    const remover = ownershipSafeRemover();
    const { root, tempRoot } = await transaction('asset-readback-failure');
    const sourceRoot = path.join(root, 'TeslaCam');
    const destinationRoot = path.join(root, 'Converted');
    const source = await write(path.join(sourceRoot, 'event.json'), Buffer.from('source-asset'));
    const destination = path.join(destinationRoot, 'event.json');
    await fs.promises.mkdir(destinationRoot);
    const tx = createConfiguredTransaction({ fs, pathApi: path, tempRoot, removeOwned: remover });

    await expect(tx.copyAsset({
      source, sourceRoot, destination, destinationRoot,
      jobId: 'job-1', itemId: 'asset-1',
      verifyReadable: async (target) => {
        if (target === destination) throw new Error('read-back rejected');
      }
    })).rejects.toMatchObject({ code: 'DESTINATION_VALIDATION_FAILED' });
    expect(await exists(destination)).toBe(false);
    expect(await fs.promises.readFile(source, 'utf8')).toBe('source-asset');
    expect(remover.remove).toHaveBeenCalledWith(expect.objectContaining({
      target: destination,
      allowIdentityAlias: true
    }));
  });

  test('rejects source or destination paths outside their declared roots before mutation', async () => {
    const { root, tx } = await transaction('asset-containment');
    const sourceRoot = path.join(root, 'TeslaCam');
    const destinationRoot = path.join(root, 'Converted');
    await fs.promises.mkdir(sourceRoot);
    await fs.promises.mkdir(destinationRoot);
    const source = await write(path.join(root, 'outside.json'), Buffer.from('outside'));
    const destination = path.join(destinationRoot, 'event.json');

    await expect(tx.copyAsset({
      source, sourceRoot, destination, destinationRoot,
      jobId: 'job-1', itemId: 'asset-1'
    })).rejects.toMatchObject({ code: 'SOURCE_OUTSIDE_ROOT' });
    expect(await exists(destination)).toBe(false);
  });
});

describe('single-file local staging', () => {
  test('copies one source once, fsyncs it, and refuses a second active staged file', async () => {
    const { root, tempRoot } = await transaction('stage-once');
    const source = await write(path.join(root, 'network', 'clip.mp4'), Buffer.from('source bytes'));
    let sourceOpens = 0;
    const adapter = {
      ...fs,
      promises: {
        ...fs.promises,
        open: async (target, ...args) => {
          if (target === source && args[0] === 'r') sourceOpens += 1;
          return fs.promises.open(target, ...args);
        }
      }
    };
    const tx = createConfiguredTransaction({ fs: adapter, pathApi: path, tempRoot });
    const first = await tx.stageSource({ source, jobId: 'job-1', itemId: 'item-1' });
    expect(await fs.promises.readFile(first.stagedSource, 'utf8')).toBe('source bytes');
    expect(sourceOpens).toBe(1);
    await expect(tx.stageSource({ source, jobId: 'job-1', itemId: 'item-2' }))
      .rejects.toMatchObject({ code: 'STAGING_BUSY' });
    await tx.cleanupOwnedArtifacts({ ownedPaths: first.ownedPaths, ownedArtifacts: first.ownedArtifacts,
      jobId: 'job-1', itemId: 'item-1' });
    expect(await exists(first.stagedSource)).toBe(false);
  });

  test('journals an interrupted copy for ownership-safe cleanup and leaves no active staging lease', async () => {
    const { root, tempRoot } = await transaction('stage-interrupt');
    const persisted = [];
    const source = await write(path.join(root, 'network', 'clip.mp4'), Buffer.from('source bytes'));
    const adapter = {
      ...fs,
      promises: {
        ...fs.promises,
        open: async (target, ...args) => {
          const handle = await fs.promises.open(target, ...args);
          if (!target.startsWith(tempRoot) || args[0] !== 'wx') return handle;
          return {
            writeFile: async (bytes) => {
              await handle.writeFile(bytes.subarray(0, 3));
              const error = new Error('local write interrupted');
              error.code = 'EIO';
              throw error;
            },
            sync: (...syncArgs) => handle.sync(...syncArgs),
            close: (...closeArgs) => handle.close(...closeArgs)
          };
        }
      }
    };
    const tx = createConfiguredTransaction({ fs: adapter, pathApi: path, tempRoot,
      persistTransaction: async (snapshot) => persisted.push(snapshot) });
    const firstFailure = await tx.stageSource({ source, jobId: 'job-1', itemId: 'item-1' })
      .catch((error) => error);
    expect(firstFailure).toMatchObject({ code: 'STAGING_FAILED', cleanupPending: ['stagedSource'] });
    expect(await fs.promises.readdir(tempRoot)).toEqual([
      path.basename(persisted.findLast(({ step }) => step === 'staged-source-cleanup-pending').ownedPaths.stagedSource)
    ]);
    await expect(tx.stageSource({ source, jobId: 'job-1', itemId: 'item-2' }))
      .rejects.not.toMatchObject({ code: 'STAGING_BUSY' });
  });
});

describe('separate destination publication', () => {
  test('publishes only the immutable Task 7 artifact through a sibling partial and consumes it', async () => {
    const { root, tx } = await transaction('publish');
    const publicationArtifact = await artifact(root);
    const mutableEncoderCandidate = await write(path.join(root, 'encoder-candidate.mp4'), Buffer.from('wrong mutable bytes'));
    const destination = path.join(root, 'nas', 'SavedClips', 'clip.mp4');
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    const checked = [];
    const result = await tx.publishSeparate({
      publicationArtifact,
      candidate: mutableEncoderCandidate,
      destination,
      jobId: 'job-1',
      itemId: 'item-1',
      verifyReadable: async (candidate) => checked.push(path.basename(candidate))
    });
    expect(result.finalPath).toBe(destination);
    expect(await fs.promises.readFile(destination, 'utf8')).toBe('verified candidate bytes');
    expect(await fs.promises.readFile(mutableEncoderCandidate, 'utf8')).toBe('wrong mutable bytes');
    expect(await exists(publicationArtifact.path)).toBe(false);
    expect(await exists(`${destination}.sentry-six-job-1-item-1.partial`)).toBe(false);
    expect(checked).toHaveLength(2);
    expect(checked[0]).toContain('.partial');
    expect(checked[1]).toBe('clip.mp4');
  });

  test('rejects snapshot size or digest changes before any destination write', async () => {
    const { root, tx } = await transaction('publish-mutation');
    const publicationArtifact = await artifact(root);
    const destination = path.join(root, 'nas', 'clip.mp4');
    await fs.promises.mkdir(path.dirname(destination));
    await fs.promises.appendFile(publicationArtifact.path, 'tampered');
    await expect(tx.publishSeparate({ publicationArtifact, candidate: path.join(root, 'encoder.mp4'), destination, jobId: 'job-1', itemId: 'item-1' }))
      .rejects.toMatchObject({ code: 'PUBLICATION_ARTIFACT_CHANGED' });
    expect(await exists(destination)).toBe(false);
    expect((await fs.promises.readdir(path.dirname(destination))).filter((name) => name.includes('.partial'))).toEqual([]);
    expect(await exists(publicationArtifact.path)).toBe(true);
  });

  test('never overwrites a final or partial collision and removes the transferred snapshot', async () => {
    const { root, tx } = await transaction('publish-collision');
    const destination = await write(path.join(root, 'nas', 'clip.mp4'), Buffer.from('unrelated'));
    const publicationArtifact = await artifact(root);
    await expect(tx.publishSeparate({ publicationArtifact, destination, jobId: 'job-1', itemId: 'item-1' }))
      .rejects.toMatchObject({ code: 'DESTINATION_COLLISION' });
    expect(await fs.promises.readFile(destination, 'utf8')).toBe('unrelated');
    expect(await exists(publicationArtifact.path)).toBe(false);

    await fs.promises.unlink(destination);
    const partialArtifact = await artifact(root, Buffer.from('second candidate'));
    let partial;
    const collisionTx = createConfiguredTransaction({
      fs,
      pathApi: path,
      tempRoot: path.join(root, 'owned-temp'),
      persistTransaction: async (snapshot) => {
        if (snapshot.step === 'separate-partial-intent') {
          partial = snapshot.ownedPaths.destinationPartial;
          await write(partial, Buffer.from('unrelated partial'));
        }
      }
    });
    await expect(collisionTx.publishSeparate({ publicationArtifact: partialArtifact, destination, jobId: 'job-1', itemId: 'item-2' }))
      .rejects.toMatchObject({ code: 'PARTIAL_COLLISION' });
    expect(await fs.promises.readFile(partial, 'utf8')).toBe('unrelated partial');
    expect(await exists(partialArtifact.path)).toBe(false);
  });

  test('opens the destination filesystem for one payload write and validates the publication token', async () => {
    const { root, tempRoot } = await transaction('publish-write-count');
    const destination = path.join(root, 'nas', 'clip.mp4');
    await fs.promises.mkdir(path.dirname(destination));
    const publicationArtifact = await artifact(root);
    let destinationWrites = 0;
    const adapter = {
      ...fs,
      promises: {
        ...fs.promises,
        open: async (target, ...args) => {
          if (path.dirname(target) === path.dirname(destination) && args[0] === 'wx') destinationWrites += 1;
          return fs.promises.open(target, ...args);
        }
      }
    };
    const validatePublicationArtifact = jest.fn(async (value) => value.token === publicationArtifact.token);
    const tx = createConfiguredTransaction({ fs: adapter, pathApi: path, tempRoot, validatePublicationArtifact });
    await tx.publishSeparate({ publicationArtifact, destination, jobId: 'job-1', itemId: 'item-1' });
    expect(destinationWrites).toBe(1);
    expect(validatePublicationArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ token: publicationArtifact.token }),
      expect.objectContaining({ mode: 'consume' })
    );
  });

  test('removes the exact owned partial and snapshot on read-back failure or cancellation', async () => {
    const { root, tx } = await transaction('publish-failure');
    const destination = path.join(root, 'nas', 'clip.mp4');
    await fs.promises.mkdir(path.dirname(destination));
    const publicationArtifact = await artifact(root);
    await expect(tx.publishSeparate({
      publicationArtifact,
      destination,
      jobId: 'job-1',
      itemId: 'item-1',
      verifyReadable: async () => { throw new Error('unreadable'); }
    })).rejects.toMatchObject({ code: 'DESTINATION_VALIDATION_FAILED' });
    expect(await exists(destination)).toBe(false);
    expect(await exists(publicationArtifact.path)).toBe(false);
    expect((await fs.promises.readdir(path.dirname(destination))).filter((name) => name.includes('.partial'))).toEqual([]);

    const cancelledArtifact = await artifact(root, Buffer.from('cancelled bytes'));
    const controller = new AbortController();
    controller.abort();
    await expect(tx.publishSeparate({ publicationArtifact: cancelledArtifact, destination, jobId: 'job-1', itemId: 'item-2', signal: controller.signal }))
      .rejects.toMatchObject({ code: 'CANCELLED' });
    expect(await exists(cancelledArtifact.path)).toBe(true);

    const midCopyArtifact = await artifact(root, Buffer.from('mid-copy cancel'));
    const midCopyController = new AbortController();
    await expect(tx.publishSeparate({
      publicationArtifact: midCopyArtifact,
      destination,
      jobId: 'job-1',
      itemId: 'item-3',
      signal: midCopyController.signal,
      verifyReadable: async () => midCopyController.abort()
    })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(await exists(destination)).toBe(false);
    expect(await exists(midCopyArtifact.path)).toBe(false);
  });

  test('removes an unverified newly-created final without touching unrelated names', async () => {
    const { root, tx } = await transaction('publish-final-invalid');
    const destination = path.join(root, 'nas', 'clip.mp4');
    await fs.promises.mkdir(path.dirname(destination));
    const publicationArtifact = await artifact(root);
    let validations = 0;
    await expect(tx.publishSeparate({
      publicationArtifact,
      destination,
      jobId: 'job-1',
      itemId: 'item-1',
      verifyReadable: async () => {
        validations += 1;
        if (validations === 2) throw new Error('final unreadable');
      }
    })).rejects.toMatchObject({ code: 'DESTINATION_VALIDATION_FAILED' });
    expect(await exists(destination)).toBe(false);
    expect(await exists(`${destination}.sentry-six-job-1-item-1.partial`)).toBe(false);
  });
});

describe('recoverable replacement', () => {
  test.each(['h265', 'av1'])('uses readable source siblings for %s and removes them after verification', async (codec) => {
    const { root, tx } = await transaction('readable-names');
    const sourceRoot = path.join(root, 'TeslaCam');
    const source = await write(path.join(sourceRoot, 'SavedClips', 'clip.mp4'), Buffer.from('original'));
    const publicationArtifact = await artifact(root);
    let written;
    await tx.replaceOriginal({
      codec, publicationArtifact, source, sourceRoot, jobId: 'job-1', itemId: 'item-1',
      persistPhase: async (snapshot) => {
        if (snapshot.phase === 'candidate-written') written = snapshot;
      }
    });
    expect(written.ownedPaths.replacementCandidate).toBe(path.join(path.dirname(source), `TEMP-${codec.toUpperCase()}-clip.mp4`));
    expect(written.ownedPaths.replacementBackup).toBe(path.join(path.dirname(source), 'BACKUP-clip.mp4'));
    expect(written.ownedArtifacts.replacementCandidate.nonce).toBeTruthy();
    expect(await exists(written.ownedPaths.replacementCandidate)).toBe(false);
    expect(await exists(written.ownedPaths.replacementBackup)).toBe(false);
    expect(await fs.promises.readFile(source, 'utf8')).toBe('verified candidate bytes');
  });

  test.each([
    ['h265', 'TEMP-H265-clip.mp4'], ['h265', 'BACKUP-clip.mp4'],
    ['av1', 'TEMP-AV1-clip.mp4'], ['av1', 'BACKUP-clip.mp4']
  ])('refuses existing %s %s without claiming ownership or moving source', async (codec, name) => {
    const { root, tx } = await transaction('readable-collision');
    const sourceRoot = path.join(root, 'TeslaCam');
    const source = await write(path.join(sourceRoot, 'clip.mp4'), Buffer.from('original'));
    const collision = await write(path.join(sourceRoot, name), Buffer.from('unrelated'));
    const publicationArtifact = await artifact(root);
    const snapshots = [];
    await expect(tx.replaceOriginal({
      codec, publicationArtifact, source, sourceRoot, jobId: 'job-1', itemId: 'item-1',
      persistTransaction: async (snapshot) => snapshots.push(snapshot)
    })).rejects.toMatchObject({ code: 'REPLACEMENT_COLLISION' });
    expect(await fs.promises.readFile(source, 'utf8')).toBe('original');
    expect(await fs.promises.readFile(collision, 'utf8')).toBe('unrelated');
    expect(snapshots).toEqual([]);
  });

  test.each(['legacy', 'h265', 'av1'])('cleans only journal-owned exact %s candidates and never prefix lookalikes', async (format) => {
    const { root, tx } = await transaction('readable-cleanup');
    const sourceRoot = path.join(root, 'TeslaCam');
    const source = await write(path.join(sourceRoot, 'clip.mp4'), Buffer.from('original'));
    const codec = format === 'legacy' ? 'h265' : format;
    const candidate = format === 'legacy'
      ? `${source}.sentry-six-job-1-item-1-candidate-nonce.candidate`
      : path.join(sourceRoot, `TEMP-${codec.toUpperCase()}-clip.mp4`);
    await write(candidate, Buffer.from('candidate'));
    const metadata = await ownedMetadata(candidate, 'candidate-nonce');
    const operation = {
      codec, source, sourceRoot, jobId: 'job-1', itemId: 'item-1',
      ownedPaths: { replacementCandidate: candidate },
      ownedArtifacts: { replacementCandidate: { ...metadata, sha256: '0'.repeat(64) } }
    };
    await expect(tx.cleanupOwnedArtifacts(operation)).rejects.toMatchObject({ code: 'UNSAFE_OWNED_PATH' });
    expect(await exists(candidate)).toBe(true);
    operation.ownedArtifacts.replacementCandidate = metadata;
    await expect(tx.cleanupOwnedArtifacts(operation)).resolves.toMatchObject({ cleaned: true });
    expect(await exists(candidate)).toBe(false);
    const lookalike = await write(path.join(sourceRoot, `TEMP-${codec.toUpperCase()}-other.mp4`), Buffer.from('unrelated'));
    operation.ownedPaths.replacementCandidate = lookalike;
    operation.ownedArtifacts.replacementCandidate = await ownedMetadata(lookalike, 'candidate-nonce');
    await expect(tx.cleanupOwnedArtifacts(operation)).rejects.toMatchObject({ code: 'UNSAFE_OWNED_PATH' });
    expect(await fs.promises.readFile(lookalike, 'utf8')).toBe('unrelated');
    expect(await fs.promises.readFile(source, 'utf8')).toBe('original');
  });

  test('persists every Task 9 success phase, validates final, and deletes backup last', async () => {
    const { root, tx } = await transaction('replace');
    const sourceRoot = path.join(root, 'TeslaCam');
    const source = await write(path.join(sourceRoot, 'SavedClips', 'clip.mp4'), Buffer.from('original'));
    const publicationArtifact = await artifact(root);
    const snapshots = [];
    const result = await tx.replaceOriginal({
      publicationArtifact,
      source,
      sourceRoot,
      jobId: 'job-1',
      itemId: 'item-1',
      persistPhase: async (snapshot) => snapshots.push(snapshot),
      verifyReadable: async () => {}
    });
    expect(snapshots.map(({ phase }) => phase)).toEqual([
      'candidate-written', 'original-backed-up', 'candidate-promoted',
      'final-validated', 'backup-deleted'
    ]);
    expect(snapshots[0]).toMatchObject({
      ownedPaths: { publicationSnapshot: publicationArtifact.path },
      publicationArtifact
    });
    for (const snapshot of snapshots.slice(1, -1)) {
      expect(snapshot.ownedPaths).toHaveProperty('publicationSnapshot', publicationArtifact.path);
      expect(snapshot).toHaveProperty('publicationArtifact', publicationArtifact);
    }
    expect(snapshots.at(-1).ownedPaths).not.toHaveProperty('publicationSnapshot');
    expect(snapshots.at(-1)).not.toHaveProperty('publicationArtifact');
    expect(await fs.promises.readFile(source, 'utf8')).toBe('verified candidate bytes');
    expect(await exists(`${source}.sentry-six-job-1-item-1.candidate`)).toBe(false);
    expect(await exists(`${source}.sentry-six-job-1-item-1.backup`)).toBe(false);
    expect(await exists(publicationArtifact.path)).toBe(false);
  });

  test.each([
    ['candidate-written', 'phase persistence failed'],
    ['original-backed-up', 'phase persistence failed'],
    ['candidate-promoted', 'phase persistence failed'],
    ['final-validated', 'phase persistence failed']
  ])('rolls back when the %s boundary cannot be persisted', async (failedPhase) => {
    const { root, tx } = await transaction(`replace-${failedPhase}`);
    const sourceRoot = path.join(root, 'TeslaCam');
    const source = await write(path.join(sourceRoot, 'clip.mp4'), Buffer.from('original'));
    const publicationArtifact = await artifact(root);
    const phases = [];
    await expect(tx.replaceOriginal({
      publicationArtifact,
      source,
      sourceRoot,
      jobId: 'job-1',
      itemId: 'item-1',
      persistPhase: async ({ phase }) => {
        phases.push(phase);
        if (phase === failedPhase) throw new Error('manifest unavailable');
      },
      verifyReadable: async () => {}
    })).rejects.toBeInstanceOf(FileTransactionError);
    expect(await fs.promises.readFile(source, 'utf8')).toBe('original');
    expect(phases).toContain('rollback-started');
    expect(phases).toContain('backup-restored');
  });

  test.each(['h265', 'av1'])('rolls back readable %s after final validation failure and records rollback success', async (codec) => {
    const { root, tx } = await transaction('replace-invalid');
    const sourceRoot = path.join(root, 'TeslaCam');
    const source = await write(path.join(sourceRoot, 'clip.mp4'), Buffer.from('original'));
    const publicationArtifact = await artifact(root);
    const phases = [];
    await expect(tx.replaceOriginal({
      codec,
      publicationArtifact,
      source,
      sourceRoot,
      jobId: 'job-1',
      itemId: 'item-1',
      persistPhase: async ({ phase }) => phases.push(phase),
      verifyReadable: async (candidate) => {
        if (candidate === source) throw new Error('final invalid');
      }
    })).rejects.toMatchObject({ code: 'FINAL_VALIDATION_FAILED' });
    expect(phases.slice(-2)).toEqual(['rollback-started', 'backup-restored']);
    expect(await fs.promises.readFile(source, 'utf8')).toBe('original');
  });

  test('cleans a failed sibling candidate write and a failed candidate validation before touching the original', async () => {
    const { root, tempRoot } = await transaction('replace-candidate-failures');
    const sourceRoot = path.join(root, 'TeslaCam');
    const source = await write(path.join(sourceRoot, 'clip.mp4'), Buffer.from('original'));
    const writeArtifact = await artifact(root);
    const adapter = {
      ...fs,
      promises: {
        ...fs.promises,
        open: async (target, ...args) => {
          const handle = await fs.promises.open(target, ...args);
          if (!target.endsWith('.candidate') || args[0] !== 'wx') return handle;
          return {
            read: (...readArgs) => handle.read(...readArgs),
            write: async (bytes, offset, length, position) => {
              await handle.write(bytes, offset, Math.min(length, 2), position);
              throw new Error('candidate write interrupted');
            },
            stat: (...statArgs) => handle.stat(...statArgs),
            sync: (...syncArgs) => handle.sync(...syncArgs),
            close: (...closeArgs) => handle.close(...closeArgs)
          };
        }
      }
    };
    const failingTx = createConfiguredTransaction({ fs: adapter, pathApi: path, tempRoot });
    await expect(failingTx.replaceOriginal({
      publicationArtifact: writeArtifact,
      source,
      sourceRoot,
      jobId: 'job-1',
      itemId: 'item-1'
    })).rejects.toBeInstanceOf(FileTransactionError);
    expect(await fs.promises.readFile(source, 'utf8')).toBe('original');
    expect(await exists(`${source}.sentry-six-job-1-item-1.candidate`)).toBe(false);
    expect(await exists(writeArtifact.path)).toBe(true);

    const validationArtifact = await artifact(root);
    await expect(createConfiguredTransaction({ fs, pathApi: path, tempRoot }).replaceOriginal({
      publicationArtifact: validationArtifact,
      source,
      sourceRoot,
      jobId: 'job-1',
      itemId: 'item-2',
      verifyReadable: async (target) => {
        if (target.endsWith('.candidate')) throw new Error('candidate invalid');
      }
    })).rejects.toMatchObject({ code: 'FINAL_VALIDATION_FAILED' });
    expect(await fs.promises.readFile(source, 'utf8')).toBe('original');
    expect(await exists(validationArtifact.path)).toBe(false);
  });

  test('rolls back when backup deletion fails but leaves a valid final for backup-deleted persistence failure', async () => {
    const { root, tempRoot } = await transaction('replace-final-boundaries');
    const sourceRoot = path.join(root, 'TeslaCam');
    const source = await write(path.join(sourceRoot, 'clip.mp4'), Buffer.from('original'));
    const deleteArtifact = await artifact(root);
    let backupDeleteFailed = false;
    const failingDeleteTx = createConfiguredTransaction({
      fs,
      pathApi: path,
      tempRoot,
      removeOwned: ownershipSafeRemover({
        remove: async ({ target }) => {
          if (target.endsWith('.backup') && !backupDeleteFailed) {
            backupDeleteFailed = true;
            return { removed: false, failed: true };
          }
          return undefined;
        }
      })
    });
    await expect(failingDeleteTx.replaceOriginal({
      publicationArtifact: deleteArtifact,
      source,
      sourceRoot,
      jobId: 'job-1',
      itemId: 'item-1'
    })).rejects.toBeInstanceOf(FileTransactionError);
    expect(await fs.promises.readFile(source, 'utf8')).toBe('original');

    const persistArtifact = await artifact(root);
    const persisted = [];
    await expect(createConfiguredTransaction({ fs, pathApi: path, tempRoot }).replaceOriginal({
      publicationArtifact: persistArtifact,
      source,
      sourceRoot,
      jobId: 'job-1',
      itemId: 'item-2',
      persistPhase: async ({ phase }) => {
        persisted.push(phase);
        if (phase === 'backup-deleted') throw new Error('manifest unavailable');
      }
    })).rejects.toMatchObject({
      code: 'TRANSACTION_STATE_PERSIST_FAILED',
      validFinal: { finalPath: source, outputBytes: persistArtifact.size, phase: 'backup-deleted' }
    });
    expect(persisted).toContain('final-validated');
    expect(await fs.promises.readFile(source, 'utf8')).toBe('verified candidate bytes');
    expect(await exists(`${source}.sentry-six-job-1-item-2.backup`)).toBe(false);
    expect(await exists(persistArtifact.path)).toBe(false);
  });

  test('reports a verified separate result when only final transaction persistence fails', async () => {
    const { root, tempRoot } = await transaction('separate-final-persist-failure');
    const publicationArtifact = await artifact(root);
    const destination = path.join(root, 'nas', 'clip.mp4');
    await fs.promises.mkdir(path.dirname(destination));
    const tx = createConfiguredTransaction({ fs, pathApi: path, tempRoot });

    await expect(tx.publishSeparate({
      publicationArtifact,
      destination,
      jobId: 'job-1',
      itemId: 'item-1',
      persistTransaction: async ({ step }) => {
        if (step.startsWith('separate-complete')) throw new Error('manifest unavailable');
      }
    })).rejects.toMatchObject({
      code: 'TRANSACTION_STATE_PERSIST_FAILED',
      validFinal: { finalPath: destination, outputBytes: publicationArtifact.size }
    });
    expect(await fs.promises.readFile(destination, 'utf8')).toBe('verified candidate bytes');
  });

  test('retains a valid final and recoverable final-validated phase when snapshot cleanup fails', async () => {
    const { root, tempRoot } = await transaction('replace-cleanup-failure');
    const sourceRoot = path.join(root, 'TeslaCam');
    const source = await write(path.join(sourceRoot, 'clip.mp4'), Buffer.from('original'));
    const publicationArtifact = await artifact(root);
    const tx = createConfiguredTransaction({ fs, pathApi: path, tempRoot,
      removeOwned: ownershipSafeRemover({ remove: async ({ target }) => target === publicationArtifact.path
        ? { removed: false, failed: true } : undefined }) });
    const phases = [];
    const result = await tx.replaceOriginal({
      publicationArtifact,
      source,
      sourceRoot,
      jobId: 'job-1',
      itemId: 'item-1',
      persistPhase: async ({ phase }) => phases.push(phase)
    });
    expect(result.cleanupPending).toContain('publicationSnapshot');
    expect(phases.at(-1)).toBe('backup-deleted');
    expect(await fs.promises.readFile(source, 'utf8')).toBe('verified candidate bytes');
    expect(await exists(publicationArtifact.path)).toBe(true);
  });

  test.each([
    ['backup rename', (from, to, source) => to.endsWith('.backup') && from === source],
    ['candidate promotion', (from, to, source) => from.endsWith('.candidate') && to === source]
  ])('preserves the original when the %s fails', async (_label, shouldFail) => {
    const { root, tempRoot } = await transaction(`replace-rename-${_label.replace(' ', '-')}`);
    const sourceRoot = path.join(root, 'TeslaCam');
    const source = await write(path.join(sourceRoot, 'clip.mp4'), Buffer.from('original'));
    const publicationArtifact = await artifact(root);
    const renameExclusive = {
      atomicNoReplace: true,
      atomicExpectedOwnership: true,
      promote: async ({ from, to }) => {
          if (shouldFail(from, to, source)) {
            const error = new Error('simulated rename failure');
            error.code = 'EIO';
            throw error;
          }
          await fs.promises.link(from, to);
          await fs.promises.unlink(from);
          return { atomicNoReplace: true, sourceRemoved: true };
        }
    };
    const tx = createConfiguredTransaction({ fs, pathApi: path, tempRoot, renameExclusive });
    const phases = [];
    await expect(tx.replaceOriginal({
      publicationArtifact,
      source,
      sourceRoot,
      jobId: 'job-1',
      itemId: 'item-1',
      persistPhase: async ({ phase }) => phases.push(phase)
    })).rejects.toBeInstanceOf(FileTransactionError);
    expect(await fs.promises.readFile(source, 'utf8')).toBe('original');
    expect(phases).toContain('rollback-started');
    expect(phases).toContain('backup-restored');
  });

  test('records rollback-failed and preserves the backup when restoration fails', async () => {
    const { root, tempRoot } = await transaction('rollback-failed');
    const sourceRoot = path.join(root, 'TeslaCam');
    const source = await write(path.join(sourceRoot, 'clip.mp4'), Buffer.from('original'));
    const publicationArtifact = await artifact(root);
    const renameExclusive = {
      atomicNoReplace: true,
      atomicExpectedOwnership: true,
      promote: async ({ from, to }) => {
          if (to === source && from.includes('.backup')) {
            const error = new Error('restore failed');
            error.code = 'EIO';
            throw error;
          }
          await fs.promises.link(from, to);
          await fs.promises.unlink(from);
          return { atomicNoReplace: true, sourceRemoved: true };
        }
    };
    const tx = createConfiguredTransaction({ fs, pathApi: path, tempRoot, renameExclusive });
    const phases = [];
    await expect(tx.replaceOriginal({
      publicationArtifact,
      source,
      sourceRoot,
      jobId: 'job-1',
      itemId: 'item-1',
      persistPhase: async ({ phase }) => phases.push(phase),
      verifyReadable: async (candidate) => {
        if (candidate === source) throw new Error('final invalid');
      }
    })).rejects.toMatchObject({ code: 'ROLLBACK_FAILED' });
    expect(phases.at(-1)).toBe('rollback-failed');
    expect((await fs.promises.readdir(sourceRoot)).filter((name) => name.endsWith('.backup'))).toHaveLength(1);
  });

  test('executes Task 9 startup actions one safe step at a time', async () => {
    const { root, tx } = await transaction('recover');
    const sourceRoot = path.join(root, 'TeslaCam');
    const source = await write(path.join(sourceRoot, 'clip.mp4'), Buffer.from('original'));
    const names = replacementFixturePaths(source, 'job-1', 'item-1', 'candidate-nonce', 'backup-nonce');
    const candidate = await write(names.candidate, Buffer.from('verified candidate bytes'));
    const backup = names.backup;
    const publicationArtifact = await artifact(root);
    let ownedPaths = { replacementCandidate: candidate, replacementBackup: backup, publicationSnapshot: publicationArtifact.path };
    let ownedArtifacts = {
      replacementCandidate: await ownedMetadata(candidate, 'candidate-nonce'),
      replacementBackup: { path: backup, nonce: 'backup-nonce', state: 'intent' },
      publicationSnapshot: await ownedMetadata(publicationArtifact.path, 'snapshot-nonce')
    };
    const phases = [];
    const recovery = async (action, extra = {}) => {
      const result = await tx.recoverReplacement({ action, source, sourceRoot, ownedPaths, ownedArtifacts,
        publicationArtifact, jobId: 'job-1', itemId: 'item-1', persistPhase: async ({ phase }) => phases.push(phase), ...extra });
      ownedPaths = result.ownedPaths;
      ownedArtifacts = result.ownedArtifacts;
    };
    await recovery('backup-original');
    await recovery('promote-candidate');
    await recovery('validate-final', { verifyReadable: async () => {} });
    await recovery('delete-backup', { verifyReadable: async () => {} });
    expect(phases).toEqual(['original-backed-up', 'candidate-promoted', 'final-validated', 'backup-deleted']);
    expect(await fs.promises.readFile(source, 'utf8')).toBe('verified candidate bytes');
    expect(await exists(backup)).toBe(false);
  });

  test.each([undefined, 'h265', 'av1'].flatMap(codec => [
    ['restore-backup', false, true, true, 'original', 'backup-restored'],
    ['rollback-complete', true, false, true, 'original', 'backup-restored'],
    ['finish-replacement', true, false, false, 'verified candidate bytes', 'backup-deleted']
  ].map(entry => [...entry, codec])))('reconciles startup action %s and releases remaining snapshot ownership (%s %s %s %s %s %s)', async (
    action, sourceExists, backupExists, candidateExists, expectedSource, expectedPhase, codec
  ) => {
    const { root, tx } = await transaction(`recover-${action}`);
    const sourceRoot = path.join(root, 'TeslaCam');
    await fs.promises.mkdir(sourceRoot);
    const source = path.join(sourceRoot, 'clip.mp4');
    if (sourceExists) await write(source, Buffer.from(expectedSource));
    const names = replacementFixturePaths(source, 'job-1', 'item-1', 'candidate-nonce', 'backup-nonce');
    const candidate = codec ? path.join(sourceRoot, `TEMP-${codec.toUpperCase()}-clip.mp4`) : names.candidate;
    const backup = codec ? path.join(sourceRoot, 'BACKUP-clip.mp4') : names.backup;
    if (candidateExists) await write(candidate, Buffer.from('verified candidate bytes'));
    if (backupExists) await write(backup, Buffer.from('original'));
    const publicationArtifact = await artifact(root);
    const ownedPaths = {
      replacementCandidate: candidate,
      replacementBackup: backup,
      publicationSnapshot: publicationArtifact.path
    };
    const ownedArtifacts = {
      publicationSnapshot: await ownedMetadata(publicationArtifact.path, 'snapshot-nonce'),
      replacementCandidate: candidateExists
        ? await ownedMetadata(candidate, 'candidate-nonce')
        : await ownedMetadata(candidate, 'candidate-nonce', 'owned', source)
    };
    ownedArtifacts.replacementBackup = backupExists
      ? await ownedMetadata(backup, 'backup-nonce')
      : { path: backup, nonce: 'backup-nonce', state: 'intent' };
    const phases = [];
    const result = await tx.recoverReplacement({
      codec: codec || 'h265',
      action,
      source,
      sourceRoot,
      ownedPaths,
      ownedArtifacts,
      publicationArtifact,
      jobId: 'job-1',
      itemId: 'item-1',
      persistPhase: async ({ phase, ownedPaths: persisted, publicationArtifact: persistedArtifact }) => {
        phases.push(phase);
        if (phase === expectedPhase) {
          expect(persisted).not.toHaveProperty('publicationSnapshot');
          expect(persistedArtifact).toBeUndefined();
        }
      }
    });
    expect(result.phase).toBe(expectedPhase);
    expect(phases.at(-1)).toBe(expectedPhase);
    expect(await fs.promises.readFile(source, 'utf8')).toBe(expectedSource);
    expect(await exists(candidate)).toBe(false);
    expect(await exists(backup)).toBe(false);
    expect(await exists(publicationArtifact.path)).toBe(false);
  });

  test('restart recovery cleans verified ownership but manual intervention mutates nothing', async () => {
    const { root, tx } = await transaction('recover-restart-manual');
    const sourceRoot = path.join(root, 'TeslaCam');
    const source = await write(path.join(sourceRoot, 'clip.mp4'), Buffer.from('original'));
    const names = replacementFixturePaths(source, 'job-1', 'item-1', 'candidate-nonce', 'backup-nonce');
    const candidate = names.candidate;
    const backup = names.backup;
    const restartArtifact = await artifact(root);
    const restart = await tx.recoverReplacement({
      action: 'restart-replacement',
      source,
      sourceRoot,
      ownedPaths: { replacementCandidate: candidate, replacementBackup: backup, publicationSnapshot: restartArtifact.path },
      ownedArtifacts: {
        replacementCandidate: { path: candidate, nonce: 'candidate-nonce', state: 'intent' },
        replacementBackup: { path: backup, nonce: 'backup-nonce', state: 'intent' },
        publicationSnapshot: await ownedMetadata(restartArtifact.path, 'snapshot-nonce')
      },
      jobId: 'job-1',
      itemId: 'item-1',
      publicationArtifact: restartArtifact
    });
    expect(restart).toMatchObject({ action: 'restart-replacement', publicationArtifact: null });
    expect(await exists(restartArtifact.path)).toBe(false);

    const manualArtifact = await artifact(root, Buffer.from('manual candidate'));
    await expect(tx.recoverReplacement({
      action: 'manual-intervention',
      source,
      sourceRoot,
      ownedPaths: { replacementCandidate: candidate, replacementBackup: backup, publicationSnapshot: manualArtifact.path },
      publicationArtifact: manualArtifact
    })).rejects.toMatchObject({ code: 'MANUAL_INTERVENTION' });
    expect(await exists(manualArtifact.path)).toBe(true);
    expect(await fs.promises.readFile(source, 'utf8')).toBe('original');
  });
});

describe('owned path safety', () => {
  test('rejects traversal, nonportable IDs, symlink aliases, and cleanup outside exact recorded paths', async () => {
    const { root, tempRoot, tx } = await transaction('owned-safety');
    const outside = await write(path.join(root, 'outside.mp4'), Buffer.from('outside'));
    await expect(tx.cleanupOwnedArtifacts({
      ownedPaths: { stagedSource: outside },
      ownedArtifacts: { stagedSource: { path: outside, nonce: 'outside-nonce', state: 'intent' } },
      jobId: 'job-1',
      itemId: 'item-1'
    })).rejects.toMatchObject({ code: 'UNSAFE_OWNED_PATH' });
    expect(await exists(outside)).toBe(true);

    const target = await write(path.join(tempRoot, 'target.mp4'), Buffer.from('target'));
    const alias = path.join(tempRoot, 'job-1-item-1-source.mp4');
    await fs.promises.link(target, alias);
    const aliasStat = await fs.promises.lstat(alias);
    await expect(tx.cleanupOwnedArtifacts({
      ownedPaths: { stagedSource: alias },
      ownedArtifacts: { stagedSource: { path: alias, nonce: 'alias-nonce', state: 'owned', size: aliasStat.size,
        sha256: digest(Buffer.from('target')), device: String(aliasStat.dev), inode: String(aliasStat.ino) } },
      jobId: 'job-1', itemId: 'item-1'
    }))
      .rejects.toMatchObject({ code: 'UNSAFE_OWNED_PATH' });
    expect(await exists(target)).toBe(true);

    await expect(tx.stageSource({ source: outside, jobId: 'CON', itemId: '../item' }))
      .rejects.toMatchObject({ code: 'INVALID_TRANSACTION_INPUT' });
  });

  test('returns bounded stable errors without leaking paths or raw adapter failures', async () => {
    const { root, tempRoot } = await transaction('bounded-errors');
    const source = await write(path.join(root, 'secret-source.mp4'), Buffer.from('source'));
    const adapter = {
      ...fs,
      promises: {
        ...fs.promises,
        open: async (target, ...args) => {
          if (target === source) throw new Error(`raw secret failure at ${target}`);
          return fs.promises.open(target, ...args);
        }
      }
    };
    const tx = createConfiguredTransaction({ fs: adapter, pathApi: path, tempRoot });
    let failure;
    try {
      await tx.stageSource({ source, jobId: 'job-1', itemId: 'item-1' });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'STAGING_FAILED', message: 'The source file could not be staged.' });
    expect(JSON.stringify({ code: failure.code, message: failure.message })).not.toContain('secret-source');
    expect(JSON.stringify({ code: failure.code, message: failure.message })).not.toContain('raw secret');
  });

  test('rejects replacement through a source-root junction or a sibling-prefix alias', async () => {
    const { root, tx } = await transaction('replacement-containment');
    const sourceRoot = path.join(root, 'TeslaCam');
    const outsideRoot = path.join(root, 'TeslaCam-old');
    await fs.promises.mkdir(sourceRoot);
    const outside = await write(path.join(outsideRoot, 'clip.mp4'), Buffer.from('original'));
    const link = path.join(sourceRoot, 'escape');
    await fs.promises.symlink(outsideRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
    const publicationArtifact = await artifact(root);
    await expect(tx.replaceOriginal({
      publicationArtifact,
      source: path.join(link, 'clip.mp4'),
      sourceRoot,
      jobId: 'job-1',
      itemId: 'item-1'
    })).rejects.toMatchObject({ code: 'SOURCE_OUTSIDE_ROOT' });
    expect(await fs.promises.readFile(outside, 'utf8')).toBe('original');
    expect(await exists(publicationArtifact.path)).toBe(true);
  });
});

describe('Task 10 fix round 1 durability contracts', () => {
  test('requires durable capability validation at construction and persistence before mutation', async () => {
    const root = await temporaryRoot('required-boundaries');
    const tempRoot = path.join(root, 'temp');
    await fs.promises.mkdir(tempRoot);
    expect(() => createFileTransaction({ fs, pathApi: path, tempRoot, persistTransaction: async () => {} }))
      .toThrow(expect.objectContaining({ code: 'INVALID_TRANSACTION_INPUT' }));

    let openedForWrite = false;
    const adapter = {
      ...fs,
      promises: {
        ...fs.promises,
        open: async (target, ...args) => {
          if (args[0] === 'wx') openedForWrite = true;
          return fs.promises.open(target, ...args);
        }
      }
    };
    const tx = createFileTransaction({
      fs: adapter,
      pathApi: path,
      tempRoot,
      validatePublicationArtifact: async () => true,
      removeOwned: ownershipSafeRemover()
    });
    const source = await write(path.join(root, 'source.mp4'), Buffer.from('source bytes'));
    await expect(tx.stageSource({ source, jobId: 'job-1', itemId: 'item-1' }))
      .rejects.toMatchObject({ code: 'TRANSACTION_STATE_PERSIST_FAILED' });
    expect(openedForWrite).toBe(false);
  });

  test('persists intent before exclusive creation and bounded identity metadata after creation', async () => {
    const events = [];
    const { root, tempRoot } = await transaction('intent-order');
    const source = await write(path.join(root, 'source.mp4'), Buffer.from('source bytes'));
    const adapter = {
      ...fs,
      promises: {
        ...fs.promises,
        open: async (target, ...args) => {
          if (args[0] === 'wx') events.push(`open:${path.basename(target)}`);
          return fs.promises.open(target, ...args);
        }
      }
    };
    const tx = createConfiguredTransaction({
      fs: adapter,
      pathApi: path,
      tempRoot,
      persistTransaction: async (snapshot) => events.push(`persist:${snapshot.step}`)
    });
    const result = await tx.stageSource({ source, jobId: 'job-1', itemId: 'item-1' });

    expect(events).toEqual([
      'persist:staged-source-intent',
      expect.stringMatching(/^open:job-1-item-1-[a-f0-9-]{36}-source\.mp4$/),
      'persist:staged-source-writing',
      'persist:staged-source-chunk-pending',
      'persist:staged-source-chunk-committed',
      'persist:staged-source-owned'
    ]);
    expect(result.ownedArtifacts.stagedSource).toEqual(expect.objectContaining({
      path: result.stagedSource,
      nonce: expect.any(String),
      state: 'owned',
      size: 12,
      sha256: digest(Buffer.from('source bytes')),
      device: expect.any(String),
      inode: expect.any(String)
    }));
  });

  test('streams bounded chunks without FileHandle readFile/writeFile and cancels between chunks', async () => {
    const { root, tempRoot } = await transaction('streaming');
    const sourceBytes = Buffer.from('abcdefghijklmnopqrstuvwxyz');
    const source = await write(path.join(root, 'source.mp4'), sourceBytes);
    let sourceReads = 0;
    let stagedWrites = 0;
    const adapter = streamingFsAdapter({
      forbidWholeFile: true,
      onRead: (target) => { if (target === source) sourceReads += 1; },
      onWrite: (target) => { if (target.startsWith(tempRoot)) stagedWrites += 1; }
    });
    const tx = createConfiguredTransaction({ fs: adapter, pathApi: path, tempRoot, chunkSize: 5 });
    const staged = await tx.stageSource({ source, jobId: 'job-1', itemId: 'item-1' });
    expect(sourceReads).toBeGreaterThan(1);
    expect(stagedWrites).toBeGreaterThan(1);
    expect(await fs.promises.readFile(staged.stagedSource)).toEqual(sourceBytes);

    await tx.cleanupOwnedArtifacts({
      ownedPaths: staged.ownedPaths,
      ownedArtifacts: staged.ownedArtifacts,
      jobId: 'job-1',
      itemId: 'item-1'
    });
    const controller = new AbortController();
    let cancelReads = 0;
    const cancelAdapter = streamingFsAdapter({
      forbidWholeFile: true,
      onRead: (target) => {
        if (target === source && ++cancelReads === 1) controller.abort();
      }
    });
    const cancelTx = createConfiguredTransaction({ fs: cancelAdapter, pathApi: path, tempRoot, chunkSize: 5 });
    await expect(cancelTx.stageSource({
      source,
      jobId: 'job-1',
      itemId: 'item-2',
      signal: controller.signal
    })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(cancelReads).toBe(1);
  });

  test('fresh-manager cleanup requires persisted identity and never deletes an unrelated same-name file', async () => {
    const persisted = [];
    const { root, tempRoot } = await transaction('restart-identity');
    const source = await write(path.join(root, 'source.mp4'), Buffer.from('source bytes'));
    const first = createConfiguredTransaction({
      fs,
      pathApi: path,
      tempRoot,
      persistTransaction: async (snapshot) => persisted.push(JSON.parse(JSON.stringify(snapshot)))
    });
    const staged = await first.stageSource({ source, jobId: 'job-1', itemId: 'item-1' });
    const fresh = createConfiguredTransaction({ fs, pathApi: path, tempRoot });
    await fresh.cleanupOwnedArtifacts({
      ownedPaths: staged.ownedPaths,
      ownedArtifacts: staged.ownedArtifacts,
      jobId: 'job-1',
      itemId: 'item-1'
    });
    expect(await exists(staged.stagedSource)).toBe(false);

    const restartedWriter = createConfiguredTransaction({ fs, pathApi: path, tempRoot,
      persistTransaction: async (snapshot) => persisted.push(JSON.parse(JSON.stringify(snapshot))) });
    const stagedAgain = await restartedWriter.stageSource({ source, jobId: 'job-1', itemId: 'item-2' });
    await fs.promises.unlink(stagedAgain.stagedSource);
    await fs.promises.writeFile(stagedAgain.stagedSource, Buffer.from('other bytes!'));
    await expect(fresh.cleanupOwnedArtifacts({
      ownedPaths: stagedAgain.ownedPaths,
      ownedArtifacts: stagedAgain.ownedArtifacts,
      jobId: 'job-1',
      itemId: 'item-2'
    })).rejects.toMatchObject({ code: 'UNSAFE_OWNED_PATH' });
    expect(await fs.promises.readFile(stagedAgain.stagedSource, 'utf8')).toBe('other bytes!');
    expect(persisted.map(({ step }) => step)).toEqual(expect.arrayContaining([
      'staged-source-intent', 'staged-source-owned'
    ]));
  });

  test('separate publication keeps a durable valid final when partial unlink fails after atomic create', async () => {
    const { root, tempRoot } = await transaction('separate-unlink-pending');
    const destination = path.join(root, 'nas', 'clip.mp4');
    await fs.promises.mkdir(path.dirname(destination));
    const publicationArtifact = await artifact(root);
    const persisted = [];
    const tx = createConfiguredTransaction({
      fs,
      pathApi: path,
      tempRoot,
      renameExclusive: undefined,
      persistTransaction: async (snapshot) => persisted.push(snapshot)
    });
    const result = await tx.publishSeparate({ publicationArtifact, destination, jobId: 'job-1', itemId: 'item-1' });
    const partial = result.ownedPaths.destinationPartial;
    expect(result).toMatchObject({ finalPath: destination, cleanupPending: ['destinationPartial'] });
    expect(await fs.promises.readFile(destination, 'utf8')).toBe('verified candidate bytes');
    expect(await fs.promises.readFile(partial, 'utf8')).toBe('verified candidate bytes');
    expect((await fs.promises.lstat(destination)).ino).toBe((await fs.promises.lstat(partial)).ino);
    expect(persisted.at(-1)).toMatchObject({
      step: 'separate-complete-cleanup-pending',
      ownedArtifacts: { destinationPartial: { state: 'cleanup-pending' } }
    });
  });

  test('replacement and recovery preserve promoted finals when candidate alias cleanup fails', async () => {
    const { root, tempRoot } = await transaction('replacement-unlink-pending');
    const sourceRoot = path.join(root, 'TeslaCam');
    const source = await write(path.join(sourceRoot, 'clip.mp4'), Buffer.from('original'));
    const publicationArtifact = await artifact(root);
    const transactionAdapter = {
      atomicNoReplace: true,
      atomicExpectedOwnership: true,
      promote: async ({ from, to }) => {
        await fs.promises.link(from, to);
        if (from.endsWith('.candidate')) {
          return { atomicNoReplace: true, sourceRemoved: false };
        }
        await fs.promises.unlink(from);
        return { atomicNoReplace: true, sourceRemoved: true };
      }
    };
    const tx = createConfiguredTransaction({ fs, pathApi: path, tempRoot, renameExclusive: transactionAdapter });
    const result = await tx.replaceOriginal({
      publicationArtifact,
      source,
      sourceRoot,
      jobId: 'job-1',
      itemId: 'item-1'
    });
    const candidate = result.ownedPaths.replacementCandidate;
    expect(result.cleanupPending).toContain('replacementCandidate');
    expect(await fs.promises.readFile(source, 'utf8')).toBe('verified candidate bytes');
    expect(await exists(candidate)).toBe(true);

    const recovered = await createConfiguredTransaction({ fs, pathApi: path, tempRoot }).recoverReplacement({
      action: 'finish-replacement',
      source,
      sourceRoot,
      ownedPaths: result.ownedPaths,
      ownedArtifacts: result.ownedArtifacts,
      publicationArtifact,
      jobId: 'job-1',
      itemId: 'item-1'
    });
    expect(recovered.phase).toBe('backup-deleted');
    expect(await exists(candidate)).toBe(false);
    expect(await fs.promises.readFile(source, 'utf8')).toBe('verified candidate bytes');
  });

  test('implements restart/resume/finalize copy recovery and same-identity alias cleanup', async () => {
    const { root, tempRoot } = await transaction('copy-recovery');
    const destination = path.join(root, 'nas', 'clip.mp4');
    await fs.promises.mkdir(path.dirname(destination));
    const publicationArtifact = await artifact(root);
    const partial = partialFixturePath(destination, 'job-1', 'item-1', 'partial-nonce');
    await fs.promises.copyFile(publicationArtifact.path, partial);
    await fs.promises.link(partial, destination);
    const ownedPaths = { publicationSnapshot: publicationArtifact.path, destinationPartial: partial };
    const ownedArtifacts = {
      publicationSnapshot: await ownedMetadata(publicationArtifact.path, 'snapshot-nonce'),
      destinationPartial: await ownedMetadata(partial, 'partial-nonce', 'cleanup-pending')
    };
    const registry = durableCapabilityRegistry(new Map([
      [publicationArtifact.token, `${publicationArtifact.path}|${publicationArtifact.sha256}|${publicationArtifact.size}`]
    ]));
    const tx = createConfiguredTransaction({
      fs,
      pathApi: path,
      tempRoot,
      validatePublicationArtifact: registry.validator
    });
    const finalized = await tx.recoverCopy({
      action: 'finalize-copy',
      destination,
      jobId: 'job-1',
      itemId: 'item-1',
      ownedPaths,
      ownedArtifacts,
      publicationArtifact
    });
    expect(finalized.finalPath).toBe(destination);
    expect(await exists(partial)).toBe(false);
    expect(await fs.promises.readFile(destination, 'utf8')).toBe('verified candidate bytes');
    expect(registry.validator).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ mode: 'reconcile' }));

    const restarted = await tx.recoverCopy({ action: 'restart-copy', destination: path.join(root, 'nas', 'new.mp4'), ownedPaths: {}, ownedArtifacts: {} });
    expect(restarted.action).toBe('restart-copy');
  });

  test('resume-copy keeps a verified final when promotion leaves a partial alias', async () => {
    const { root, tempRoot } = await transaction('resume-copy-unlink-pending');
    const destination = path.join(root, 'nas', 'clip.mp4');
    await fs.promises.mkdir(path.dirname(destination));
    const publicationArtifact = await artifact(root);
    const partial = partialFixturePath(destination, 'job-1', 'item-1', 'partial-nonce');
    await fs.promises.copyFile(publicationArtifact.path, partial);
    const ownedPaths = { publicationSnapshot: publicationArtifact.path, destinationPartial: partial };
    const ownedArtifacts = {
      publicationSnapshot: await ownedMetadata(publicationArtifact.path, 'snapshot-nonce'),
      destinationPartial: await ownedMetadata(partial, 'partial-nonce')
    };
    const registry = durableCapabilityRegistry(new Map([
      [publicationArtifact.token, `${publicationArtifact.path}|${publicationArtifact.sha256}|${publicationArtifact.size}`]
    ]));
    const tx = createConfiguredTransaction({ fs, pathApi: path, tempRoot,
      renameExclusive: undefined, validatePublicationArtifact: registry.validator });
    const result = await tx.recoverCopy({
      action: 'resume-copy', destination, jobId: 'job-1', itemId: 'item-1',
      ownedPaths, ownedArtifacts, publicationArtifact
    });
    expect(result.cleanupPending).toEqual(['destinationPartial']);
    expect(await fs.promises.readFile(destination, 'utf8')).toBe('verified candidate bytes');
    expect(await exists(partial)).toBe(true);
  });

  test('rejects forged capabilities, durable replay, and permits persisted restart reconciliation only', async () => {
    const { root, tempRoot } = await transaction('capability-registry');
    const forged = await artifact(root);
    const forgedDestination = path.join(root, 'nas', 'forged.mp4');
    await fs.promises.mkdir(path.dirname(forgedDestination));
    const rejecting = createConfiguredTransaction({
      fs,
      pathApi: path,
      tempRoot,
      validatePublicationArtifact: async () => false
    });
    await expect(rejecting.publishSeparate({
      publicationArtifact: forged,
      destination: forgedDestination,
      jobId: 'job-1',
      itemId: 'item-1'
    })).rejects.toMatchObject({ code: 'INVALID_PUBLICATION_ARTIFACT' });
    expect(await exists(forged.path)).toBe(true);
    expect(await exists(forgedDestination)).toBe(false);

    const shared = new Map();
    const registry = durableCapabilityRegistry(shared);
    const publicationArtifact = await artifact(root, Buffer.from('replay bytes'));
    const first = createConfiguredTransaction({ fs, pathApi: path, tempRoot, validatePublicationArtifact: registry.validator });
    await first.publishSeparate({
      publicationArtifact,
      destination: path.join(root, 'nas', 'first.mp4'),
      jobId: 'job-1',
      itemId: 'item-2'
    });
    await write(publicationArtifact.path, Buffer.from('replay bytes'));
    const restarted = createConfiguredTransaction({ fs, pathApi: path, tempRoot, validatePublicationArtifact: registry.validator });
    await expect(restarted.publishSeparate({
      publicationArtifact,
      destination: path.join(root, 'nas', 'replay.mp4'),
      jobId: 'job-1',
      itemId: 'item-3'
    })).rejects.toMatchObject({ code: 'INVALID_PUBLICATION_ARTIFACT' });
    expect(await exists(path.join(root, 'nas', 'replay.mp4'))).toBe(false);
  });

  test('retains snapshot ownership across rollback-failed and restores after a transient restart failure', async () => {
    const { root, tempRoot } = await transaction('rollback-restart');
    const sourceRoot = path.join(root, 'TeslaCam');
    const source = await write(path.join(sourceRoot, 'clip.mp4'), Buffer.from('original'));
    const publicationArtifact = await artifact(root);
    let restoreFailures = 0;
    const renameExclusive = {
      atomicNoReplace: true,
      atomicExpectedOwnership: true,
      promote: async ({ from, to }) => {
          if (from.endsWith('.backup') && to === source && restoreFailures++ === 0) {
            const error = new Error('transient restore failure');
            error.code = 'EIO';
            throw error;
          }
          await fs.promises.link(from, to);
          await fs.promises.unlink(from);
          return { atomicNoReplace: true, sourceRemoved: true };
        }
    };
    let rollbackFailed;
    const first = createConfiguredTransaction({
      fs,
      pathApi: path,
      tempRoot,
      renameExclusive,
      persistTransaction: async (snapshot) => {
        if (snapshot.phase === 'rollback-failed') rollbackFailed = JSON.parse(JSON.stringify(snapshot));
      }
    });
    await expect(first.replaceOriginal({
      publicationArtifact,
      source,
      sourceRoot,
      jobId: 'job-1',
      itemId: 'item-1',
      verifyReadable: async (target) => {
        if (target === source) throw new Error('force rollback');
      }
    })).rejects.toMatchObject({ code: 'ROLLBACK_FAILED' });
    expect(rollbackFailed).toMatchObject({
      phase: 'rollback-failed',
      ownedPaths: { publicationSnapshot: publicationArtifact.path },
      publicationArtifact
    });
    expect(await exists(publicationArtifact.path)).toBe(true);

    const registry = durableCapabilityRegistry(new Map([
      [publicationArtifact.token, `${publicationArtifact.path}|${publicationArtifact.sha256}|${publicationArtifact.size}`]
    ]));
    const recovered = await createConfiguredTransaction({
      fs,
      pathApi: path,
      tempRoot,
      validatePublicationArtifact: registry.validator
    }).recoverReplacement({
      action: 'restore-backup',
      source,
      sourceRoot,
      jobId: 'job-1',
      itemId: 'item-1',
      ownedPaths: rollbackFailed.ownedPaths,
      ownedArtifacts: rollbackFailed.ownedArtifacts,
      publicationArtifact
    });
    expect(recovered.phase).toBe('backup-restored');
    expect(await fs.promises.readFile(source, 'utf8')).toBe('original');
    expect(await exists(publicationArtifact.path)).toBe(false);
  });

  test('surfaces snapshot cleanup-pending without removing a valid separate or replacement result', async () => {
    const { root, tempRoot } = await transaction('snapshot-cleanup-pending');
    const separateArtifact = await artifact(root);
    const separateDestination = path.join(root, 'nas', 'clip.mp4');
    await fs.promises.mkdir(path.dirname(separateDestination));
    const sourceRoot = path.join(root, 'TeslaCam');
    const source = await write(path.join(sourceRoot, 'replace.mp4'), Buffer.from('original'));
    const replacementArtifact = await artifact(root, Buffer.from('replacement bytes'));
    const blocked = new Set([separateArtifact.path, replacementArtifact.path]);
    const tx = createConfiguredTransaction({ fs, pathApi: path, tempRoot,
      removeOwned: ownershipSafeRemover({ remove: async ({ target }) => blocked.has(target)
        ? { removed: false, failed: true } : undefined }) });
    const separate = await tx.publishSeparate({
      publicationArtifact: separateArtifact,
      destination: separateDestination,
      jobId: 'job-1',
      itemId: 'item-1'
    });
    expect(separate.cleanupPending).toContain('publicationSnapshot');
    expect(await fs.promises.readFile(separateDestination, 'utf8')).toBe('verified candidate bytes');
    expect(separate.ownedPaths.publicationSnapshot).toBe(separateArtifact.path);

    const replacement = await tx.replaceOriginal({
      publicationArtifact: replacementArtifact,
      source,
      sourceRoot,
      jobId: 'job-1',
      itemId: 'item-2'
    });
    expect(replacement.cleanupPending).toContain('publicationSnapshot');
    expect(await fs.promises.readFile(source, 'utf8')).toBe('replacement bytes');
    expect(replacement.ownedPaths.publicationSnapshot).toBe(replacementArtifact.path);
  });

  test('fails closed when atomic no-overwrite promotion is unavailable', async () => {
    const { root, tempRoot } = await transaction('unsupported-promotion');
    const publicationArtifact = await artifact(root);
    const destination = path.join(root, 'nas', 'clip.mp4');
    await fs.promises.mkdir(path.dirname(destination));
    const adapter = {
      ...fs,
      promises: {
        ...fs.promises,
        link: async () => {
          const error = new Error('hard links unsupported');
          error.code = 'ENOSYS';
          throw error;
        }
      }
    };
    const tx = createConfiguredTransaction({ fs: adapter, pathApi: path, tempRoot, renameExclusive: undefined });
    await expect(tx.publishSeparate({ publicationArtifact, destination, jobId: 'job-1', itemId: 'item-1' }))
      .rejects.toMatchObject({ code: 'ATOMIC_PROMOTION_UNSUPPORTED' });
    expect(await exists(destination)).toBe(false);
    expect((await fs.promises.readdir(path.dirname(destination))).filter((name) => name.includes('.partial'))).toEqual([]);
  });

  test('accepts only a proven injected atomic no-overwrite promotion adapter', async () => {
    const { root, tempRoot } = await transaction('injected-promotion');
    const destination = path.join(root, 'nas', 'clip.mp4');
    await fs.promises.mkdir(path.dirname(destination));
    const rejectedArtifact = await artifact(root);
    const invalid = createConfiguredTransaction({
      fs,
      pathApi: path,
      tempRoot,
      renameExclusive: { promote: async () => ({ sourceRemoved: true }) }
    });
    await expect(invalid.publishSeparate({ publicationArtifact: rejectedArtifact, destination,
      jobId: 'job-1', itemId: 'item-1' })).rejects.toMatchObject({ code: 'ATOMIC_PROMOTION_UNSUPPORTED' });
    expect(await exists(destination)).toBe(false);

    const acceptedArtifact = await artifact(root, Buffer.from('adapter bytes'));
    const proven = createConfiguredTransaction({
      fs,
      pathApi: path,
      tempRoot,
      renameExclusive: {
        atomicNoReplace: true,
        promote: async ({ from, to, removeSource }) => {
          await fs.promises.link(from, to);
          if (removeSource) await fs.promises.unlink(from);
          return { atomicNoReplace: true, sourceRemoved: removeSource };
        }
      }
    });
    await expect(proven.publishSeparate({ publicationArtifact: acceptedArtifact, destination,
      jobId: 'job-1', itemId: 'item-2' })).resolves.toMatchObject({ finalPath: destination });
    expect(await fs.promises.readFile(destination, 'utf8')).toBe('adapter bytes');
  });

  test.each([
    ['separate-partial-intent', 'separate'],
    ['replacement-candidate-intent', 'replacement'],
    ['replacement-backup-intent', 'backup']
  ])('persists %s before its filesystem mutation', async (failedStep, mode) => {
    const { root, tempRoot } = await transaction(`persist-${mode}`);
    const publicationArtifact = await artifact(root);
    let exclusiveOpens = 0;
    let backupLinks = 0;
    const adapter = {
      ...fs,
      promises: {
        ...fs.promises,
        open: async (target, ...args) => {
          if (args[0] === 'wx') exclusiveOpens += 1;
          return fs.promises.open(target, ...args);
        },
        link: async (from, to) => {
          if (to.endsWith('.backup')) backupLinks += 1;
          return fs.promises.link(from, to);
        }
      }
    };
    const tx = createConfiguredTransaction({
      fs: adapter,
      pathApi: path,
      tempRoot,
      persistTransaction: async ({ step }) => {
        if (step === failedStep) throw new Error('manifest unavailable');
      }
    });
    if (mode === 'separate') {
      const destination = path.join(root, 'nas', 'clip.mp4');
      await fs.promises.mkdir(path.dirname(destination));
      await expect(tx.publishSeparate({ publicationArtifact, destination, jobId: 'job-1', itemId: 'item-1' }))
        .rejects.toMatchObject({ code: 'TRANSACTION_STATE_PERSIST_FAILED' });
      expect(exclusiveOpens).toBe(0);
    } else {
      const sourceRoot = path.join(root, 'TeslaCam');
      const source = await write(path.join(sourceRoot, 'clip.mp4'), Buffer.from('original'));
      await expect(tx.replaceOriginal({ publicationArtifact, source, sourceRoot, jobId: 'job-1', itemId: 'item-1' }))
        .rejects.toBeInstanceOf(FileTransactionError);
      if (mode === 'replacement') expect(exclusiveOpens).toBe(0);
      else expect(backupLinks).toBe(0);
      expect(await fs.promises.readFile(source, 'utf8')).toBe('original');
    }
  });
});

describe('Task 10 fix round 2 ownership and chunk journal contracts', () => {
  test('accepts a declared unsupported remover with replacement disabled', async () => {
    const root = await temporaryRoot('required-remove-owned');
    const tempRoot = path.join(root, 'temp');
    await fs.promises.mkdir(tempRoot);
    expect(createFileTransaction({
      fs,
      pathApi: path,
      tempRoot,
      validatePublicationArtifact: async () => true,
      persistTransaction: async () => {},
      removeOwned: { atomicOwnershipCheck: false, remove: async () => ({ removed: true }) }
    }).capabilities.replacement).toBe('unavailable');
  });

  test('embeds the persisted random nonce in every generated owned filename', async () => {
    const { root, tempRoot } = await transaction('nonce-filenames');
    const source = await write(path.join(root, 'source.mp4'), Buffer.from('source bytes'));
    const removeOwned = ownershipSafeRemover();
    const tx = createConfiguredTransaction({ fs, pathApi: path, tempRoot, removeOwned, renameExclusive: undefined });
    const staged = await tx.stageSource({ source, jobId: 'job-1', itemId: 'item-1' });
    expect(path.basename(staged.stagedSource)).toContain(staged.ownedArtifacts.stagedSource.nonce);

    const publicationArtifact = await artifact(root);
    const destination = path.join(root, 'nas', 'clip.mp4');
    await fs.promises.mkdir(path.dirname(destination));
    const published = await tx.publishSeparate({ publicationArtifact, destination, jobId: 'job-1', itemId: 'item-2' });
    expect(path.basename(published.ownedPaths.destinationPartial))
      .toContain(published.ownedArtifacts.destinationPartial.nonce);
  });

  test('never calls portable unlink after a failed copy or deletes a replacement pathname', async () => {
    const { root, tempRoot } = await transaction('copy-unlink-race');
    const source = await write(path.join(root, 'source.mp4'), Buffer.from('source bytes'));
    let createdTarget;
    let portableUnlinkCalled = false;
    const adapter = {
      ...fs,
      promises: {
        ...fs.promises,
        open: async (target, ...args) => {
          const handle = await fs.promises.open(target, ...args);
          if (args[0] !== 'wx') return handle;
          createdTarget = target;
          return {
            read: (...readArgs) => handle.read(...readArgs),
            write: async (...writeArgs) => {
              await handle.write(...writeArgs);
              throw new Error('copy interrupted');
            },
            stat: (...statArgs) => handle.stat(...statArgs),
            sync: (...syncArgs) => handle.sync(...syncArgs),
            close: (...closeArgs) => handle.close(...closeArgs)
          };
        },
        unlink: async (target) => {
          portableUnlinkCalled = true;
          await fs.promises.unlink(target);
          await fs.promises.writeFile(target, Buffer.from('unrelated replacement'));
          return fs.promises.unlink(target);
        }
      }
    };
    const removeOwned = ownershipSafeRemover({ remove: async () => ({ removed: false, failed: true }) });
    const tx = createConfiguredTransaction({ fs: adapter, pathApi: path, tempRoot, removeOwned, chunkSize: 4 });
    let failure;
    try {
      await tx.stageSource({ source, jobId: 'job-1', itemId: 'item-1' });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'STAGING_FAILED', cleanupPending: ['stagedSource'] });
    expect(portableUnlinkCalled).toBe(false);
    expect(await exists(createdTarget)).toBe(true);
  });

  test('requests bigint stats and preserves adjacent 64-bit inode identities exactly', async () => {
    const { root, tempRoot } = await transaction('bigint-identity');
    const source = await write(path.join(root, 'source.mp4'), Buffer.from('source bytes'));
    const exactInodes = [9007199254740992n, 9007199254740993n];
    let targetIndex = -1;
    const pathInodes = new Map();
    const statOptions = [];
    const adapter = {
      ...fs,
      promises: {
        ...fs.promises,
        lstat: async (target, options) => {
          statOptions.push(options);
          const stat = await fs.promises.lstat(target, options);
          if (pathInodes.has(target)) stat.ino = options?.bigint ? pathInodes.get(target) : Number(pathInodes.get(target));
          return stat;
        },
        open: async (target, ...args) => {
          const handle = await fs.promises.open(target, ...args);
          const index = args[0] === 'wx' ? ++targetIndex : -1;
          if (index >= 0) pathInodes.set(target, exactInodes[index]);
          return {
            read: (...readArgs) => handle.read(...readArgs),
            write: (...writeArgs) => handle.write(...writeArgs),
            sync: (...syncArgs) => handle.sync(...syncArgs),
            close: (...closeArgs) => handle.close(...closeArgs),
            stat: async (options) => {
              const stat = await handle.stat(options);
              if (index < 0) return stat;
              stat.ino = options?.bigint ? exactInodes[index] : Number(exactInodes[index]);
              return stat;
            }
          };
        }
      }
    };
    const first = await createConfiguredTransaction({ fs: adapter, pathApi: path, tempRoot,
      removeOwned: ownershipSafeRemover() }).stageSource({ source, jobId: 'job-1', itemId: 'item-1' });
    const second = await createConfiguredTransaction({ fs: adapter, pathApi: path, tempRoot,
      removeOwned: ownershipSafeRemover() }).stageSource({ source, jobId: 'job-1', itemId: 'item-2' });
    expect(first.ownedArtifacts.stagedSource.inode).toBe('9007199254740992');
    expect(second.ownedArtifacts.stagedSource.inode).toBe('9007199254740993');
    expect(statOptions.filter(Boolean).every((options) => options.bigint === true)).toBe(true);
  });

  test('persists bounded pending-before-write and committed-after-fsync chunk journal states', async () => {
    const events = [];
    const { root, tempRoot } = await transaction('chunk-journal-order');
    const source = await write(path.join(root, 'source.mp4'), Buffer.from('abcdefghij'));
    const adapter = streamingFsAdapter({
      onWrite: () => events.push('write')
    });
    const tx = createConfiguredTransaction({
      fs: adapter,
      pathApi: path,
      tempRoot,
      chunkSize: 5,
      removeOwned: ownershipSafeRemover(),
      persistTransaction: async (snapshot) => {
        const journal = snapshot.ownedArtifacts?.stagedSource?.journal;
        if (snapshot.step === 'staged-source-chunk-pending') events.push(`pending:${journal.pending.size}`);
        if (snapshot.step === 'staged-source-chunk-committed') events.push(`committed:${journal.committed.size}`);
      }
    });
    const staged = await tx.stageSource({ source, jobId: 'job-1', itemId: 'item-1' });
    expect(events).toEqual(['pending:5', 'write', 'committed:5', 'pending:10', 'write', 'committed:10']);
    expect(staged.ownedArtifacts.stagedSource.journal).toEqual({
      committed: { size: 10, sha256: digest(Buffer.from('abcdefghij')) },
      pending: null
    });
  });

  test('reconciles after fsync-before-commit crash and resumes only an exact pending boundary', async () => {
    const { root, tempRoot } = await transaction('chunk-journal-resume');
    const bytes = Buffer.from('abcdefghij');
    const source = await write(path.join(root, 'source.mp4'), bytes);
    let durable;
    const first = createConfiguredTransaction({
      fs,
      pathApi: path,
      tempRoot,
      chunkSize: 5,
      removeOwned: ownershipSafeRemover(),
      persistTransaction: async (snapshot) => {
        if (snapshot.step === 'staged-source-chunk-committed' && snapshot.ownedArtifacts.stagedSource.journal.committed.size === 5) {
          throw new Error('crash after fsync');
        }
        durable = JSON.parse(JSON.stringify(snapshot));
      }
    });
    await expect(first.stageSource({ source, jobId: 'job-1', itemId: 'item-1' }))
      .rejects.toMatchObject({ code: 'TRANSACTION_STATE_PERSIST_FAILED', cleanupPending: ['stagedSource'] });
    expect(durable.ownedArtifacts.stagedSource.journal).toMatchObject({
      committed: { size: 0 },
      pending: { size: 5 }
    });
    expect(await fs.promises.readFile(durable.ownedPaths.stagedSource, 'utf8')).toBe('abcde');

    const resumed = await createConfiguredTransaction({ fs, pathApi: path, tempRoot, chunkSize: 5,
      removeOwned: ownershipSafeRemover() }).stageSource({
      source,
      jobId: 'job-1',
      itemId: 'item-1',
      resume: { ownedPaths: durable.ownedPaths, ownedArtifacts: durable.ownedArtifacts }
    });
    expect(await fs.promises.readFile(resumed.stagedSource)).toEqual(bytes);
    expect(resumed.ownedArtifacts.stagedSource.journal.pending).toBeNull();
    expect(resumed.ownedArtifacts.stagedSource.journal.committed.size).toBe(bytes.length);
  });

  test('surfaces and persists non-snapshot cleanup failure without clearing ownership', async () => {
    const persisted = [];
    const { root, tempRoot } = await transaction('cleanup-pending-owned');
    const source = await write(path.join(root, 'source.mp4'), Buffer.from('source bytes'));
    const tx = createConfiguredTransaction({
      fs,
      pathApi: path,
      tempRoot,
      removeOwned: ownershipSafeRemover({ remove: async () => ({ removed: false, failed: true }) }),
      persistTransaction: async (snapshot) => persisted.push(snapshot)
    });
    const staged = await tx.stageSource({ source, jobId: 'job-1', itemId: 'item-1' });
    const cleanup = await tx.cleanupOwnedArtifacts({
      ownedPaths: staged.ownedPaths,
      ownedArtifacts: staged.ownedArtifacts,
      jobId: 'job-1',
      itemId: 'item-1'
    });
    expect(cleanup).toMatchObject({ cleaned: false, cleanupPending: ['stagedSource'] });
    expect(cleanup.ownedArtifacts.stagedSource.state).toBe('cleanup-pending');
    expect(persisted.at(-1)).toMatchObject({
      step: 'owned-cleanup-pending',
      ownedPaths: { stagedSource: staged.stagedSource },
      ownedArtifacts: { stagedSource: { state: 'cleanup-pending' } }
    });
    expect(await exists(staged.stagedSource)).toBe(true);
  });

  test('replacement fails closed before mutation without a proven expected-ownership transaction adapter', async () => {
    const { root, tempRoot } = await transaction('replacement-adapter-required');
    const sourceRoot = path.join(root, 'TeslaCam');
    const source = await write(path.join(sourceRoot, 'clip.mp4'), Buffer.from('original'));
    const publicationArtifact = await artifact(root);
    const tx = createFileTransaction({
      fs,
      pathApi: path,
      tempRoot,
      removeOwned: ownershipSafeRemover(),
      validatePublicationArtifact: async () => true,
      persistTransaction: async () => {}
    });
    await expect(tx.replaceOriginal({ publicationArtifact, source, sourceRoot, jobId: 'job-1', itemId: 'item-1' }))
      .rejects.toMatchObject({ code: 'ATOMIC_PROMOTION_UNSUPPORTED' });
    expect(await fs.promises.readFile(source, 'utf8')).toBe('original');
    expect((await fs.promises.readdir(sourceRoot)).filter((name) => name.includes('.sentry-six-'))).toEqual([]);
  });

  test('persists destination partial cleanup-pending when validation fails and safe removal is unavailable', async () => {
    const persisted = [];
    const { root, tempRoot } = await transaction('partial-cleanup-pending');
    const publicationArtifact = await artifact(root);
    const destination = path.join(root, 'nas', 'clip.mp4');
    await fs.promises.mkdir(path.dirname(destination));
    const tx = createConfiguredTransaction({
      fs,
      pathApi: path,
      tempRoot,
      removeOwned: ownershipSafeRemover({
        remove: async ({ target }) => target.endsWith('.partial') ? { removed: false, failed: true } : undefined
      }),
      persistTransaction: async (snapshot) => persisted.push(JSON.parse(JSON.stringify(snapshot)))
    });
    const failure = await tx.publishSeparate({
      publicationArtifact,
      destination,
      jobId: 'job-1',
      itemId: 'item-1',
      verifyReadable: async (target) => { if (target.endsWith('.partial')) throw new Error('invalid'); }
    }).catch((error) => error);
    expect(failure).toMatchObject({
      code: 'DESTINATION_VALIDATION_FAILED',
      cleanupPending: ['destinationPartial']
    });
    expect(persisted.at(-1)).toMatchObject({
      step: 'separate-failed-cleanup-pending',
      ownedArtifacts: { destinationPartial: { state: 'cleanup-pending' } },
      cleanupPending: ['destinationPartial']
    });
    expect(await exists(persisted.at(-1).ownedPaths.destinationPartial)).toBe(true);
  });

  test('persists candidate cleanup-pending when rollback cannot safely remove it', async () => {
    let rollbackFailed;
    const { root, tempRoot } = await transaction('candidate-cleanup-pending');
    const sourceRoot = path.join(root, 'TeslaCam');
    const source = await write(path.join(sourceRoot, 'clip.mp4'), Buffer.from('original'));
    const publicationArtifact = await artifact(root);
    const tx = createConfiguredTransaction({
      fs,
      pathApi: path,
      tempRoot,
      removeOwned: ownershipSafeRemover({
        remove: async ({ target }) => target.endsWith('.candidate') ? { removed: false, failed: true } : undefined
      }),
      persistTransaction: async (snapshot) => {
        if (snapshot.phase === 'rollback-failed') rollbackFailed = JSON.parse(JSON.stringify(snapshot));
      }
    });
    await expect(tx.replaceOriginal({
      publicationArtifact,
      source,
      sourceRoot,
      jobId: 'job-1',
      itemId: 'item-1',
      verifyReadable: async (target) => { if (target.endsWith('.candidate')) throw new Error('invalid'); }
    })).rejects.toMatchObject({ code: 'ROLLBACK_FAILED' });
    expect(rollbackFailed).toMatchObject({
      phase: 'rollback-failed',
      ownedArtifacts: { replacementCandidate: { state: 'cleanup-pending' } },
      cleanupPending: ['replacementCandidate']
    });
    expect(await fs.promises.readFile(source, 'utf8')).toBe('original');
    expect(await exists(rollbackFailed.ownedPaths.replacementCandidate)).toBe(true);
  });

  test('never removes or moves an unrelated file swapped into a replacement source pathname', async () => {
    const { root, tempRoot } = await transaction('replacement-path-swap');
    const sourceRoot = path.join(root, 'TeslaCam');
    const source = await write(path.join(sourceRoot, 'clip.mp4'), Buffer.from('original'));
    const publicationArtifact = await artifact(root);
    let promotions = 0;
    let swappedPath;
    const renameExclusive = {
      atomicNoReplace: true,
      atomicExpectedOwnership: true,
      promote: async ({ from, to }) => {
        promotions += 1;
        if (promotions === 2) {
          swappedPath = from;
          await fs.promises.unlink(from);
          await fs.promises.writeFile(from, Buffer.from('unrelated swap'));
          return { atomicNoReplace: true, sourceRemoved: false, ownershipMismatch: true };
        }
        await fs.promises.link(from, to);
        await fs.promises.unlink(from);
        return { atomicNoReplace: true, sourceRemoved: true };
      }
    };
    const tx = createConfiguredTransaction({ fs, pathApi: path, tempRoot, renameExclusive });
    await expect(tx.replaceOriginal({ publicationArtifact, source, sourceRoot, jobId: 'job-1', itemId: 'item-1' }))
      .rejects.toMatchObject({ code: 'ROLLBACK_FAILED' });
    expect(await fs.promises.readFile(source, 'utf8')).toBe('original');
    expect(await fs.promises.readFile(swappedPath, 'utf8')).toBe('unrelated swap');
  });

  test('persists copy-recovery cleanup-pending and retries only through removeOwned', async () => {
    const persisted = [];
    const { root, tempRoot } = await transaction('recovery-cleanup-pending');
    const destination = path.join(root, 'nas', 'clip.mp4');
    await fs.promises.mkdir(path.dirname(destination));
    const publicationArtifact = await artifact(root);
    const partial = partialFixturePath(destination, 'job-1', 'item-1', 'partial-nonce');
    await fs.promises.copyFile(publicationArtifact.path, partial);
    await fs.promises.link(partial, destination);
    const ownedPaths = { publicationSnapshot: publicationArtifact.path, destinationPartial: partial };
    const ownedArtifacts = {
      publicationSnapshot: await ownedMetadata(publicationArtifact.path, 'snapshot-nonce'),
      destinationPartial: await ownedMetadata(partial, 'partial-nonce', 'cleanup-pending')
    };
    const registry = durableCapabilityRegistry(new Map([
      [publicationArtifact.token, `${publicationArtifact.path}|${publicationArtifact.sha256}|${publicationArtifact.size}`]
    ]));
    const tx = createConfiguredTransaction({
      fs,
      pathApi: path,
      tempRoot,
      validatePublicationArtifact: registry.validator,
      removeOwned: ownershipSafeRemover({
        remove: async ({ target }) => target === partial ? { removed: false, failed: true } : undefined
      }),
      persistTransaction: async (snapshot) => persisted.push(snapshot)
    });
    const result = await tx.recoverCopy({ action: 'finalize-copy', destination, jobId: 'job-1', itemId: 'item-1',
      ownedPaths, ownedArtifacts, publicationArtifact });
    expect(result.cleanupPending).toEqual(['destinationPartial']);
    expect(result.ownedArtifacts.destinationPartial.state).toBe('cleanup-pending');
    expect(persisted.at(-1)).toMatchObject({
      step: 'copy-complete-cleanup-pending',
      cleanupPending: ['destinationPartial']
    });
    expect(await fs.promises.readFile(destination, 'utf8')).toBe('verified candidate bytes');
    expect(await exists(partial)).toBe(true);
  });
});

describe('Task 10 fix round 3 promotion and recovery contracts', () => {
  test('separate publication never asks an atomic-no-replace adapter to remove the partial source', async () => {
    const { root, tempRoot } = await transaction('separate-no-source-removal');
    const publicationArtifact = await artifact(root);
    const destination = path.join(root, 'nas', 'clip.mp4');
    await fs.promises.mkdir(path.dirname(destination));
    const calls = [];
    const renameExclusive = {
      atomicNoReplace: true,
      promote: async ({ from, to, removeSource }) => {
        calls.push({ from, to, removeSource });
        await fs.promises.link(from, to);
        if (removeSource) await fs.promises.unlink(from);
        return { atomicNoReplace: true, sourceRemoved: removeSource };
      }
    };
    const result = await createConfiguredTransaction({ fs, pathApi: path, tempRoot, renameExclusive })
      .publishSeparate({ publicationArtifact, destination, jobId: 'job-1', itemId: 'item-1' });
    expect(calls).toEqual([expect.objectContaining({ removeSource: false })]);
    expect(result.cleanupPending).toEqual(['destinationPartial']);
    expect(await fs.promises.readFile(result.ownedPaths.destinationPartial, 'utf8')).toBe('verified candidate bytes');
    expect(await fs.promises.readFile(destination, 'utf8')).toBe('verified candidate bytes');
  });

  test('requires atomic expected-ownership capability whenever an adapter is asked to remove its source', async () => {
    const { root, tempRoot } = await transaction('source-removal-capability');
    const sourceRoot = path.join(root, 'TeslaCam');
    const source = await write(path.join(sourceRoot, 'clip.mp4'), Buffer.from('original'));
    const publicationArtifact = await artifact(root);
    const promote = jest.fn();
    const tx = createConfiguredTransaction({
      fs,
      pathApi: path,
      tempRoot,
      renameExclusive: { atomicNoReplace: true, promote }
    });
    await expect(tx.replaceOriginal({ publicationArtifact, source, sourceRoot, jobId: 'job-1', itemId: 'item-1' }))
      .rejects.toMatchObject({ code: 'ATOMIC_PROMOTION_UNSUPPORTED' });
    expect(promote).not.toHaveBeenCalled();
    expect(await fs.promises.readFile(source, 'utf8')).toBe('original');
  });

  test('resume verifies identity and committed bytes on the same r+ handle before writing', async () => {
    const { root, tempRoot } = await transaction('resume-same-handle');
    const source = await write(path.join(root, 'source.mp4'), Buffer.from('abcdefghij'));
    let durable;
    const first = createConfiguredTransaction({
      fs,
      pathApi: path,
      tempRoot,
      chunkSize: 5,
      persistTransaction: async (snapshot) => {
        if (snapshot.step === 'staged-source-chunk-committed') throw new Error('crash after fsync');
        durable = JSON.parse(JSON.stringify(snapshot));
      }
    });
    await expect(first.stageSource({ source, jobId: 'job-1', itemId: 'item-1' }))
      .rejects.toMatchObject({ code: 'TRANSACTION_STATE_PERSIST_FAILED' });
    const stagedPath = durable.ownedPaths.stagedSource;
    let swapped = false;
    const swapAdapter = {
      ...fs,
      promises: {
        ...fs.promises,
        open: async (target, ...args) => {
          if (target === stagedPath && args[0] === 'r+' && !swapped) {
            swapped = true;
            await fs.promises.unlink(target);
            await fs.promises.writeFile(target, Buffer.from('ZZZZZ'));
          }
          return fs.promises.open(target, ...args);
        }
      }
    };
    await expect(createConfiguredTransaction({ fs: swapAdapter, pathApi: path, tempRoot, chunkSize: 5 }).stageSource({
      source,
      jobId: 'job-1',
      itemId: 'item-1',
      resume: { ownedPaths: durable.ownedPaths, ownedArtifacts: durable.ownedArtifacts }
    })).rejects.toBeInstanceOf(FileTransactionError);
    expect(swapped).toBe(true);
    expect(await fs.promises.readFile(stagedPath, 'utf8')).toBe('ZZZZZ');
  });

  test.each([
    ['before-write committed boundary', Buffer.alloc(0)],
    ['after-fsync pending boundary', Buffer.from('abcde')]
  ])('resumes a separate partial from the exact %s before final promotion', async (_label, partialBytes) => {
    const { root, tempRoot } = await transaction(`recover-separate-${partialBytes.length}`);
    const publicationArtifact = await artifact(root, Buffer.from('abcdefghij'));
    const destination = path.join(root, 'nas', 'clip.mp4');
    await fs.promises.mkdir(path.dirname(destination));
    const partial = await write(partialFixturePath(destination, 'job-1', 'item-1', 'partial-nonce'), partialBytes);
    const committed = { size: 0, sha256: digest(Buffer.alloc(0)) };
    const pending = { size: 5, sha256: digest(Buffer.from('abcde')) };
    const ownedPaths = { destinationPartial: partial, publicationSnapshot: publicationArtifact.path };
    const ownedArtifacts = {
      destinationPartial: await writingMetadata(partial, 'partial-nonce', committed, pending),
      publicationSnapshot: await ownedMetadata(publicationArtifact.path, 'snapshot-nonce')
    };
    const registry = durableCapabilityRegistry(new Map([
      [publicationArtifact.token, `${publicationArtifact.path}|${publicationArtifact.sha256}|${publicationArtifact.size}`]
    ]));
    const destinationExistsDuringCopy = [];
    const result = await createConfiguredTransaction({ fs, pathApi: path, tempRoot, chunkSize: 5,
      validatePublicationArtifact: registry.validator,
      persistTransaction: async (snapshot) => {
        if (snapshot.step?.startsWith('copy-recovery-partial-chunk-')) {
          destinationExistsDuringCopy.push(await exists(destination));
        }
      }
    }).recoverCopy({
      action: 'resume-copy', destination, publicationArtifact, ownedPaths, ownedArtifacts,
      jobId: 'job-1', itemId: 'item-1'
    });
    expect(destinationExistsDuringCopy.length).toBeGreaterThan(0);
    expect(destinationExistsDuringCopy).not.toContain(true);
    expect(await fs.promises.readFile(destination, 'utf8')).toBe('abcdefghij');
    expect(result.cleanupPending).toContain('destinationPartial');
  });

  test.each([
    ['before-write committed boundary', Buffer.alloc(0)],
    ['after-fsync pending boundary', Buffer.from('abcde')]
  ])('resumes a replacement candidate from the exact %s before promotion', async (_label, candidateBytes) => {
    const { root, tempRoot } = await transaction(`recover-replacement-${candidateBytes.length}`);
    const sourceRoot = path.join(root, 'TeslaCam');
    await fs.promises.mkdir(sourceRoot);
    const source = path.join(sourceRoot, 'clip.mp4');
    const names = replacementFixturePaths(source, 'job-1', 'item-1', 'candidate-nonce', 'backup-nonce');
    const candidate = await write(names.candidate, candidateBytes);
    const backup = await write(names.backup, Buffer.from('original'));
    const publicationArtifact = await artifact(root, Buffer.from('abcdefghij'));
    const committed = { size: 0, sha256: digest(Buffer.alloc(0)) };
    const pending = { size: 5, sha256: digest(Buffer.from('abcde')) };
    const ownedPaths = {
      replacementCandidate: candidate,
      replacementBackup: backup,
      publicationSnapshot: publicationArtifact.path
    };
    const ownedArtifacts = {
      replacementCandidate: await writingMetadata(candidate, 'candidate-nonce', committed, pending),
      replacementBackup: await ownedMetadata(backup, 'backup-nonce'),
      publicationSnapshot: await ownedMetadata(publicationArtifact.path, 'snapshot-nonce')
    };
    const registry = durableCapabilityRegistry(new Map([
      [publicationArtifact.token, `${publicationArtifact.path}|${publicationArtifact.sha256}|${publicationArtifact.size}`]
    ]));
    const sourceExistsDuringCopy = [];
    const result = await createConfiguredTransaction({ fs, pathApi: path, tempRoot, chunkSize: 5,
      validatePublicationArtifact: registry.validator,
      persistTransaction: async (snapshot) => {
        if (snapshot.step?.startsWith('recovery-candidate-chunk-')) {
          sourceExistsDuringCopy.push(await exists(source));
        }
      }
    }).recoverReplacement({
      action: 'promote-candidate', source, sourceRoot, publicationArtifact, ownedPaths, ownedArtifacts,
      jobId: 'job-1', itemId: 'item-1'
    });
    expect(sourceExistsDuringCopy.length).toBeGreaterThan(0);
    expect(sourceExistsDuringCopy).not.toContain(true);
    expect(result.phase).toBe('candidate-promoted');
    expect(await fs.promises.readFile(source, 'utf8')).toBe('abcdefghij');
  });

  test.each(['separate partial', 'replacement candidate'])(
    'requires manual intervention for an indeterminate mid-chunk %s',
    async (kind) => {
      const { root, tempRoot } = await transaction(`recover-indeterminate-${kind.replace(' ', '-')}`);
      const publicationArtifact = await artifact(root, Buffer.from('abcdefghij'));
      const committed = { size: 0, sha256: digest(Buffer.alloc(0)) };
      const pending = { size: 5, sha256: digest(Buffer.from('abcde')) };
      const registry = durableCapabilityRegistry(new Map([
        [publicationArtifact.token, `${publicationArtifact.path}|${publicationArtifact.sha256}|${publicationArtifact.size}`]
      ]));
      if (kind === 'separate partial') {
        const destination = path.join(root, 'nas', 'clip.mp4');
        await fs.promises.mkdir(path.dirname(destination));
        const partial = await write(
          partialFixturePath(destination, 'job-1', 'item-1', 'partial-nonce'),
          Buffer.from('abc')
        );
        const ownedPaths = { destinationPartial: partial, publicationSnapshot: publicationArtifact.path };
        const ownedArtifacts = {
          destinationPartial: await writingMetadata(partial, 'partial-nonce', committed, pending),
          publicationSnapshot: await ownedMetadata(publicationArtifact.path, 'snapshot-nonce')
        };
        await expect(createConfiguredTransaction({ fs, pathApi: path, tempRoot, chunkSize: 5,
          validatePublicationArtifact: registry.validator }).recoverCopy({
          action: 'resume-copy', destination, publicationArtifact, ownedPaths, ownedArtifacts,
          jobId: 'job-1', itemId: 'item-1'
        })).rejects.toMatchObject({ code: 'MANUAL_INTERVENTION' });
        expect(await exists(destination)).toBe(false);
        expect(await fs.promises.readFile(partial, 'utf8')).toBe('abc');
        return;
      }

      const sourceRoot = path.join(root, 'TeslaCam');
      await fs.promises.mkdir(sourceRoot);
      const source = path.join(sourceRoot, 'clip.mp4');
      const names = replacementFixturePaths(source, 'job-1', 'item-1', 'candidate-nonce', 'backup-nonce');
      const candidate = await write(names.candidate, Buffer.from('abc'));
      const backup = await write(names.backup, Buffer.from('original'));
      const ownedPaths = {
        replacementCandidate: candidate,
        replacementBackup: backup,
        publicationSnapshot: publicationArtifact.path
      };
      const ownedArtifacts = {
        replacementCandidate: await writingMetadata(candidate, 'candidate-nonce', committed, pending),
        replacementBackup: await ownedMetadata(backup, 'backup-nonce'),
        publicationSnapshot: await ownedMetadata(publicationArtifact.path, 'snapshot-nonce')
      };
      await expect(createConfiguredTransaction({ fs, pathApi: path, tempRoot, chunkSize: 5,
        validatePublicationArtifact: registry.validator }).recoverReplacement({
        action: 'promote-candidate', source, sourceRoot, publicationArtifact, ownedPaths, ownedArtifacts,
        jobId: 'job-1', itemId: 'item-1'
      })).rejects.toMatchObject({ code: 'MANUAL_INTERVENTION' });
      expect(await exists(source)).toBe(false);
      expect(await fs.promises.readFile(candidate, 'utf8')).toBe('abc');
    }
  );

  test.each([
    ['promoted source', (target, source) => target === source],
    ['candidate path', (target) => target.endsWith('.candidate')]
  ])('returns persisted cleanupPending when rollback cannot remove the %s', async (_label, shouldFailRemoval) => {
    const { root, tempRoot } = await transaction(`rollback-cleanup-${_label.replace(' ', '-')}`);
    const sourceRoot = path.join(root, 'TeslaCam');
    const source = await write(path.join(sourceRoot, 'clip.mp4'), Buffer.from('original'));
    const publicationArtifact = await artifact(root);
    let rollbackFailed;
    const tx = createConfiguredTransaction({
      fs,
      pathApi: path,
      tempRoot,
      removeOwned: ownershipSafeRemover({
        remove: async ({ target }) => shouldFailRemoval(target, source) ? { removed: false, failed: true } : undefined
      }),
      persistTransaction: async (snapshot) => {
        if (snapshot.phase === 'rollback-failed') rollbackFailed = JSON.parse(JSON.stringify(snapshot));
      }
    });
    const failure = await tx.replaceOriginal({
      publicationArtifact,
      source,
      sourceRoot,
      jobId: 'job-1',
      itemId: 'item-1',
      verifyReadable: async (target) => {
        if (_label === 'candidate path' ? target.endsWith('.candidate') : target === source) throw new Error('invalid');
      }
    }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'ROLLBACK_FAILED', cleanupPending: ['replacementCandidate'] });
    expect(rollbackFailed).toMatchObject({
      phase: 'rollback-failed',
      cleanupPending: ['replacementCandidate'],
      ownedArtifacts: { replacementCandidate: { state: 'cleanup-pending' } }
    });
  });
});
