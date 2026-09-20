'use strict';

const crypto = require('crypto');
const nodeFs = require('fs');
const nodePath = require('path');

const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
const SHA256 = /^[a-f0-9]{64}$/;
const OWNED_PATH_FIELDS = new Set([
  'stagedSource', 'encodedCandidate', 'publicationSnapshot',
  'destinationPartial', 'replacementCandidate', 'replacementBackup'
]);
const DIRECTORY_SYNC_UNSUPPORTED = new Set(['EISDIR', 'EINVAL', 'EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP']);

const ERROR_MESSAGES = Object.freeze({
  INVALID_TRANSACTION_INPUT: 'The file transaction request is invalid.',
  INSUFFICIENT_STAGING_SPACE: 'There is not enough local space to stage this file.',
  STAGING_BUSY: 'Another file is already staged.',
  STAGING_FAILED: 'The source file could not be staged.',
  CANCELLED: 'The file transaction was cancelled.',
  INVALID_PUBLICATION_ARTIFACT: 'The verified publication artifact is invalid.',
  PUBLICATION_ARTIFACT_CHANGED: 'The verified publication artifact changed before publication.',
  PUBLICATION_ARTIFACT_CONSUMED: 'The verified publication artifact was already consumed.',
  PUBLICATION_CLEANUP_FAILED: 'The verified publication artifact could not be cleaned up.',
  DESTINATION_COLLISION: 'The destination already exists.',
  PARTIAL_COLLISION: 'An unrelated partial file already exists.',
  DESTINATION_WRITE_FAILED: 'The destination could not be written safely.',
  ATOMIC_PROMOTION_UNSUPPORTED: 'This filesystem does not support safe atomic publication.',
  DESTINATION_VALIDATION_FAILED: 'The destination did not pass read-back validation.',
  SOURCE_OUTSIDE_ROOT: 'The replacement source is outside the selected source root.',
  SOURCE_CHANGED: 'The original changed after input capture. Retain it and restart with a stable source.',
  SOURCE_AUTHORITY_REQUIRED: 'The original input version is unknown. Preserve recovery files and restart safely.',
  REPLACEMENT_COLLISION: 'An unrelated replacement artifact already exists.',
  REPLACEMENT_FAILED: 'The original file could not be replaced safely.',
  INSUFFICIENT_REPLACEMENT_SPACE: 'There is not enough free space beside the original for its verified replacement.',
  REPLACEMENT_SPACE_UNAVAILABLE: 'Free space on the original volume could not be checked safely.',
  FINAL_VALIDATION_FAILED: 'The replaced file did not pass final validation.',
  ROLLBACK_FAILED: 'Automatic replacement rollback could not be completed.',
  TRANSACTION_STATE_PERSIST_FAILED: 'The file transaction phase could not be persisted.',
  OWNED_CLEANUP_FAILED: 'An owned artifact could not be cleaned up safely.',
  UNSAFE_OWNED_PATH: 'An owned artifact path failed its safety check.',
  MANUAL_INTERVENTION: 'This file transaction requires manual intervention.',
  RECOVERY_ACTION_INVALID: 'The recovery action is invalid.'
});

class FileTransactionError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] || 'The file transaction failed.');
    this.name = 'FileTransactionError';
    this.code = code;
  }
}

function transactionError(code) {
  return new FileTransactionError(code);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function validSafeInteger(value, { positive = false } = {}) {
  return Number.isSafeInteger(value) && value >= (positive ? 1 : 0);
}

function validateId(value) {
  if (typeof value !== 'string' || !SAFE_ID.test(value) || WINDOWS_RESERVED_NAME.test(value)) {
    throw transactionError('INVALID_TRANSACTION_INPUT');
  }
  return value;
}

function validateAbsolutePath(value, pathApi) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32_768 || value.includes('\0')
      || (!pathApi.isAbsolute(value) && !nodePath.win32.isAbsolute(value) && !nodePath.posix.isAbsolute(value))) {
    throw transactionError('INVALID_TRANSACTION_INPUT');
  }
  return pathApi.resolve(value);
}

function normalizeComparison(value, pathApi, platform) {
  const normalized = pathApi.normalize(pathApi.resolve(value));
  return platform === 'win32' || pathApi === nodePath.win32 ? normalized.toLowerCase() : normalized;
}

function samePath(left, right, pathApi, platform) {
  return normalizeComparison(left, pathApi, platform) === normalizeComparison(right, pathApi, platform);
}

function isContained(root, candidate, pathApi, platform) {
  const comparableRoot = normalizeComparison(root, pathApi, platform);
  const comparableCandidate = normalizeComparison(candidate, pathApi, platform);
  const relative = pathApi.relative(comparableRoot, comparableCandidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative));
}

function identity(stat) {
  const exactPart = (value) => typeof value === 'bigint'
    ? (value >= 0n ? value.toString() : null)
    : (Number.isSafeInteger(value) && value >= 0 ? String(value) : null);
  const device = stat && exactPart(stat.dev);
  const inode = stat && exactPart(stat.ino);
  return device !== null && inode !== null ? `${device}:${inode}` : null;
}

function sameIdentity(left, right) {
  const leftIdentity = identity(left);
  const rightIdentity = identity(right);
  return leftIdentity && rightIdentity
    ? leftIdentity === rightIdentity
    : left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function isRegularFile(stat) {
  return stat && typeof stat.isFile === 'function' && stat.isFile()
    && (!stat.isSymbolicLink || !stat.isSymbolicLink());
}

async function classifyPath(targetPath, options = {}) {
  const pathApi = options.pathApi || nodePath;
  const platform = options.platform || process.platform;
  if (typeof targetPath !== 'string' || targetPath.length === 0 || targetPath.includes('\0')) {
    throw transactionError('INVALID_TRANSACTION_INPUT');
  }
  if (platform === 'win32' && (/^\\\\[^?]/.test(targetPath) || /^\\\\\?\\UNC\\/i.test(targetPath))) {
    return { kind: 'network', reason: 'unc' };
  }

  const adapter = options.volumeInfo;
  let volume;
  try {
    if (typeof adapter === 'function') volume = await adapter(targetPath);
    else if (adapter && typeof adapter.classifyPath === 'function') volume = await adapter.classifyPath(targetPath);
    else if (adapter && typeof adapter.getVolumeInfo === 'function') volume = await adapter.getVolumeInfo(targetPath);
    else if (adapter && typeof adapter.isRemoteDrive === 'function') {
      const remote = await adapter.isRemoteDrive(targetPath);
      if (typeof remote === 'boolean') volume = { remote, certain: true };
    }
  } catch (_error) {
    volume = null;
  }
  if (volume && volume.remote === true) return { kind: 'network', reason: 'mapped-remote' };
  if (volume && volume.remote === false && volume.certain === true) return { kind: 'local', reason: 'volume-local' };

  const resolved = pathApi.resolve(targetPath);
  if (platform === 'win32' && /^[a-zA-Z]:[\\/]/.test(resolved)) {
    return { kind: 'ambiguous', reason: 'volume-unknown' };
  }
  return { kind: 'ambiguous', reason: 'volume-unknown' };
}

async function checkStagingSpace(options = {}) {
  const { sourceBytes, outputBytes = sourceBytes, reserveBytes = 512 * 1024 * 1024, tempRoot, volumeInfo } = options;
  if (!validSafeInteger(sourceBytes) || !validSafeInteger(outputBytes) || !validSafeInteger(reserveBytes)
      || sourceBytes > Number.MAX_SAFE_INTEGER - outputBytes
      || sourceBytes + outputBytes > Number.MAX_SAFE_INTEGER - reserveBytes) {
    throw transactionError('INVALID_TRANSACTION_INPUT');
  }
  let freeBytes;
  try {
    if (volumeInfo && typeof volumeInfo.freeSpace === 'function') freeBytes = await volumeInfo.freeSpace(tempRoot);
    else if (volumeInfo && typeof volumeInfo.getFreeSpace === 'function') freeBytes = await volumeInfo.getFreeSpace(tempRoot);
    else if (typeof volumeInfo === 'function') {
      const result = await volumeInfo(tempRoot);
      freeBytes = result?.freeBytes;
    }
  } catch (_error) {
    freeBytes = null;
  }
  if (!validSafeInteger(freeBytes)) throw transactionError('INVALID_TRANSACTION_INPUT');
  const requiredBytes = sourceBytes + outputBytes + reserveBytes;
  return { sufficient: freeBytes >= requiredBytes, requiredBytes, freeBytes };
}

function chooseStagingMode(options = {}) {
  const { networkMode, classification, space } = options;
  if (!['auto', 'staging', 'direct'].includes(networkMode)
      || !classification || !['network', 'local', 'ambiguous'].includes(classification.kind)) {
    throw transactionError('INVALID_TRANSACTION_INPUT');
  }
  if (networkMode === 'direct') return { mode: 'direct', reason: 'forced-direct' };
  if (networkMode === 'staging') {
    if (!space || typeof space.sufficient !== 'boolean') throw transactionError('INVALID_TRANSACTION_INPUT');
    if (!space.sufficient) throw transactionError('INSUFFICIENT_STAGING_SPACE');
    return { mode: 'staging', reason: 'forced-staging' };
  }
  if (classification.kind === 'ambiguous') return { mode: 'direct', reason: 'ambiguous-volume' };
  if (classification.kind === 'local') return { mode: 'direct', reason: 'local-source' };
  if (!space || typeof space.sufficient !== 'boolean') throw transactionError('INVALID_TRANSACTION_INPUT');
  if (!space.sufficient) return { mode: 'direct', reason: 'insufficient-space' };
  return { mode: 'staging', reason: 'network-source' };
}

function createFileTransaction(options = {}) {
  const fileSystem = options.fs || nodeFs;
  const pfs = fileSystem.promises || fileSystem;
  const pathApi = options.pathApi || nodePath;
  const platform = options.platform || process.platform;
  const tempRoot = validateAbsolutePath(options.tempRoot, pathApi);
  if (typeof options.validatePublicationArtifact !== 'function') {
    throw transactionError('INVALID_TRANSACTION_INPUT');
  }
  if (options.removeOwned !== undefined && (!options.removeOwned
      || typeof options.removeOwned.atomicOwnershipCheck !== 'boolean'
      || typeof options.removeOwned.remove !== 'function')) {
    throw transactionError('INVALID_TRANSACTION_INPUT');
  }
  const ownershipCleanupAvailable = options.removeOwned?.atomicOwnershipCheck === true
    && typeof options.removeOwned.remove === 'function';
  const separatePromotionAvailable = options.renameExclusive?.atomicNoReplace === true
    && typeof options.renameExclusive.promote === 'function';
  const replacementAvailable = ownershipCleanupAvailable
    && options.removeOwned?.guardedRemoval === true
    && separatePromotionAvailable
    && options.renameExclusive?.atomicExpectedOwnership === true;
  const capabilities = Object.freeze({
    separatePublication: separatePromotionAvailable
      ? ownershipCleanupAvailable ? 'native-atomic' : 'hardlink-cleanup-pending'
      : options.renameExclusive === undefined ? 'hardlink-cleanup-pending' : 'unavailable',
    ownershipCleanup: ownershipCleanupAvailable ? 'atomic-expected-ownership' : 'unavailable',
    replacement: replacementAvailable ? 'available' : 'unavailable'
  });
  const chunkSize = validSafeInteger(options.chunkSize, { positive: true }) ? options.chunkSize : 1024 * 1024;
  const ownedIdentities = new Map();
  let activeStagedPath = null;
  let activeEncodedPath = null;

  async function lstatOrNull(target) {
    try {
      return await pfs.lstat(target, { bigint: true });
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function exactLstat(target) {
    const stat = await pfs.lstat(target, { bigint: true });
    if (typeof stat.dev !== 'bigint' || typeof stat.ino !== 'bigint') throw transactionError('UNSAFE_OWNED_PATH');
    return stat;
  }

  async function exactHandleStat(handle) {
    const stat = await handle.stat({ bigint: true });
    if (typeof stat.dev !== 'bigint' || typeof stat.ino !== 'bigint') throw transactionError('UNSAFE_OWNED_PATH');
    return stat;
  }

  function statSize(stat) {
    const value = typeof stat.size === 'bigint' ? Number(stat.size) : stat.size;
    if (!Number.isSafeInteger(value) || value < 0) throw transactionError('UNSAFE_OWNED_PATH');
    return value;
  }

  async function canonicalExisting(target) {
    return pathApi.resolve(await pfs.realpath(target));
  }

  async function canonicalForNew(target) {
    let cursor = pathApi.resolve(target);
    const suffix = [];
    while (true) {
      try {
        await pfs.lstat(cursor);
        break;
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
        const parent = pathApi.dirname(cursor);
        if (samePath(parent, cursor, pathApi, platform)) throw transactionError('UNSAFE_OWNED_PATH');
        suffix.unshift(pathApi.basename(cursor));
        cursor = parent;
      }
    }
    const realAncestor = await canonicalExisting(cursor);
    return pathApi.resolve(realAncestor, ...suffix);
  }

  async function assertRegularUnaliased(target, code = 'UNSAFE_OWNED_PATH') {
    let stat;
    let real;
    try {
      stat = await exactLstat(target);
      if (!isRegularFile(stat)
          || (typeof stat.nlink === 'bigint' ? stat.nlink !== 1n : stat.nlink !== 1)) throw transactionError(code);
      real = await canonicalExisting(target);
    } catch (error) {
      if (error instanceof FileTransactionError) throw error;
      throw transactionError(code);
    }
    if (!samePath(real, target, pathApi, platform)) throw transactionError(code);
    const recorded = ownedIdentities.get(normalizeComparison(target, pathApi, platform));
    if (recorded && identity(stat) && recorded !== identity(stat)) throw transactionError(code);
    return stat;
  }

  async function rememberOwned(target) {
    const stat = await assertRegularUnaliased(target);
    const value = identity(stat);
    if (value) ownedIdentities.set(normalizeComparison(target, pathApi, platform), value);
    return stat;
  }

  function releaseOwnedLease(target) {
    if (activeStagedPath && samePath(activeStagedPath, target, pathApi, platform)) activeStagedPath = null;
    if (activeEncodedPath && samePath(activeEncodedPath, target, pathApi, platform)) activeEncodedPath = null;
  }

  function forgetOwned(target) {
    ownedIdentities.delete(normalizeComparison(target, pathApi, platform));
    releaseOwnedLease(target);
  }

  async function syncDirectory(directory) {
    let handle;
    try {
      handle = await pfs.open(directory, 'r');
      await handle.sync();
    } catch (error) {
      if (!error || !DIRECTORY_SYNC_UNSUPPORTED.has(error.code)) throw error;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  function abortIfRequested(signal) {
    if (signal?.aborted) throw transactionError('CANCELLED');
  }

  function normalizeArtifactUnchecked(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
      throw transactionError('INVALID_PUBLICATION_ARTIFACT');
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 4 || keys.some((key) => typeof key !== 'string' || !['path', 'token', 'sha256', 'size'].includes(key))) {
      throw transactionError('INVALID_PUBLICATION_ARTIFACT');
    }
    const descriptors = Object.fromEntries(keys.map((key) => [key, Object.getOwnPropertyDescriptor(value, key)]));
    if (Object.values(descriptors).some((descriptor) => !descriptor || descriptor.get || descriptor.set)) {
      throw transactionError('INVALID_PUBLICATION_ARTIFACT');
    }
    const token = descriptors.token.value;
    const expectedSha256 = descriptors.sha256.value;
    const size = descriptors.size.value;
    const rawPath = descriptors.path.value;
    if (typeof token !== 'string' || token.length === 0 || token.length > 512 || token.includes('\0')
        || typeof expectedSha256 !== 'string' || !SHA256.test(expectedSha256)
        || !validSafeInteger(size, { positive: true })) {
      throw transactionError('INVALID_PUBLICATION_ARTIFACT');
    }
    let artifactPath;
    try {
      artifactPath = validateAbsolutePath(rawPath, pathApi);
    } catch (_error) {
      throw transactionError('INVALID_PUBLICATION_ARTIFACT');
    }
    return Object.freeze({ path: artifactPath, token, sha256: expectedSha256, size });
  }

  function normalizeArtifact(value) {
    try {
      return normalizeArtifactUnchecked(value);
    } catch (error) {
      if (error instanceof FileTransactionError) throw error;
      throw transactionError('INVALID_PUBLICATION_ARTIFACT');
    }
  }

  function safeStatPart(value) {
    if (typeof value === 'bigint' && value >= 0n) return value.toString();
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }

  function artifactMetadata(target, nonce, state, stat, digestValue, size, journal) {
    const result = { path: target, nonce, state };
    if (state !== 'intent') {
      const device = safeStatPart(stat.dev);
      const inode = safeStatPart(stat.ino);
      if (device === null || inode === null) throw transactionError('UNSAFE_OWNED_PATH');
      Object.assign(result, {
        size,
        sha256: digestValue,
        device,
        inode
      });
      if (journal) result.journal = journal;
    }
    return result;
  }

  function metadataMatchesStat(metadata, stat) {
    return metadata && metadata.state !== 'intent'
      && metadata.device === safeStatPart(stat.dev)
      && metadata.inode === safeStatPart(stat.ino)
      && metadata.size === statSize(stat);
  }

  function metadataMatchesIdentity(metadata, stat) {
    return metadata && metadata.device === safeStatPart(stat.dev) && metadata.inode === safeStatPart(stat.ino);
  }

  async function hashOpenHandle(handle, signal) {
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(chunkSize);
    let size = 0;
    while (true) {
      abortIfRequested(signal);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
      if (!Number.isSafeInteger(size)) throw transactionError('INVALID_TRANSACTION_INPUT');
    }
    return { size, sha256: hash.digest('hex') };
  }

  async function readExactFile(target, metadata, changedCode = 'PUBLICATION_ARTIFACT_CHANGED', signal) {
    let handle;
    try {
      const linkStat = await exactLstat(target);
      if (!isRegularFile(linkStat)) throw transactionError(changedCode);
      const real = await canonicalExisting(target);
      if (!samePath(real, target, pathApi, platform)) throw transactionError(changedCode);
      handle = await pfs.open(target, 'r');
      const before = await exactHandleStat(handle);
      if (!isRegularFile(before)) throw transactionError(changedCode);
      const observed = await hashOpenHandle(handle, signal);
      const after = await exactHandleStat(handle);
      if (!sameIdentity(before, after) || observed.size !== metadata.size
          || statSize(before) !== metadata.size || statSize(after) !== metadata.size
          || observed.sha256 !== metadata.sha256) throw transactionError(changedCode);
      return { ...observed, stat: after };
    } catch (error) {
      if (error instanceof FileTransactionError) throw error;
      throw transactionError(changedCode);
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  async function copyExclusive(source, target, {
    expected, signal, collisionCode, failureCode, onCreated, onChunkPending, onChunkCommitted,
    onResumeReconciled, resume
  }) {
    let sourceHandle;
    let targetHandle;
    try {
      const sourceLinkStat = await exactLstat(source);
      if (!isRegularFile(sourceLinkStat)) throw transactionError(failureCode);
      const real = await canonicalExisting(source);
      if (!samePath(real, source, pathApi, platform)) throw transactionError(failureCode);
      sourceHandle = await pfs.open(source, 'r');
      const sourceBefore = await exactHandleStat(sourceHandle);
      targetHandle = await pfs.open(target, resume ? 'r+' : 'wx', 0o600);
      const targetBefore = await exactHandleStat(targetHandle);
      const hash = crypto.createHash('sha256');
      const buffer = Buffer.allocUnsafe(chunkSize);
      let size = 0;
      if (resume) {
        if (!resume.metadata || !resume.journal || !metadataMatchesIdentity(resume.metadata, targetBefore)
            || !isRegularFile(targetBefore)) throw transactionError('MANUAL_INTERVENTION');
        const actualSize = statSize(targetBefore);
        const targetHash = crypto.createHash('sha256');
        let targetOffset = 0;
        while (targetOffset < actualSize) {
          abortIfRequested(signal);
          const request = Math.min(buffer.length, actualSize - targetOffset);
          const { bytesRead } = await targetHandle.read(buffer, 0, request, targetOffset);
          if (bytesRead !== request) throw transactionError('MANUAL_INTERVENTION');
          targetHash.update(buffer.subarray(0, bytesRead));
          targetOffset += bytesRead;
        }
        const targetAfterRead = await exactHandleStat(targetHandle);
        if (!sameIdentity(targetBefore, targetAfterRead) || statSize(targetAfterRead) !== actualSize) {
          throw transactionError('MANUAL_INTERVENTION');
        }
        const actualSha256 = targetHash.digest('hex');
        const committed = resume.journal.committed;
        const pending = resume.journal.pending;
        let boundary = null;
        let matchedPending = false;
        if (committed && actualSize === committed.size && actualSha256 === committed.sha256) boundary = committed;
        else if (pending && actualSize === pending.size && actualSha256 === pending.sha256) {
          boundary = pending;
          matchedPending = true;
        }
        if (!boundary) throw transactionError('MANUAL_INTERVENTION');
        size = boundary.size;
        let remaining = size;
        while (remaining > 0) {
          const request = Math.min(buffer.length, remaining);
          const { bytesRead } = await sourceHandle.read(buffer, 0, request, null);
          if (bytesRead !== request) throw transactionError(failureCode);
          hash.update(buffer.subarray(0, bytesRead));
          remaining -= bytesRead;
        }
        if (hash.copy().digest('hex') !== boundary.sha256) throw transactionError(failureCode);
        if (matchedPending && onResumeReconciled) {
          await onResumeReconciled({ size, sha256: boundary.sha256, stat: targetAfterRead });
        }
      } else if (onCreated) {
        await onCreated({ size: 0, sha256: sha256(Buffer.alloc(0)), stat: targetBefore });
      }
      while (true) {
        abortIfRequested(signal);
        const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        const nextSize = size + bytesRead;
        const nextSha256 = hash.copy().update(buffer.subarray(0, bytesRead)).digest('hex');
        if (!Number.isSafeInteger(nextSize)) throw transactionError(failureCode);
        if (onChunkPending) await onChunkPending({ size: nextSize, sha256: nextSha256, stat: targetBefore });
        let offset = 0;
        while (offset < bytesRead) {
          abortIfRequested(signal);
          const { bytesWritten } = await targetHandle.write(buffer, offset, bytesRead - offset, size + offset);
          if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) throw transactionError(failureCode);
          offset += bytesWritten;
        }
        await targetHandle.sync();
        const progressStat = await exactHandleStat(targetHandle);
        if (!sameIdentity(targetBefore, progressStat) || statSize(progressStat) !== nextSize) throw transactionError(failureCode);
        hash.update(buffer.subarray(0, bytesRead));
        size = nextSize;
        if (onChunkCommitted) await onChunkCommitted({ size, sha256: nextSha256, stat: progressStat });
      }
      await targetHandle.sync();
      const sourceAfter = await exactHandleStat(sourceHandle);
      const sourcePathAfter = await exactLstat(source);
      const targetAfter = await exactHandleStat(targetHandle);
      const targetPathStat = await exactLstat(target);
      const observedSha256 = hash.digest('hex');
      if (!sameIdentity(sourceLinkStat, sourceBefore) || !sameIdentity(sourceBefore, sourceAfter)
          || !sameIdentity(sourceAfter, sourcePathAfter)
          || sourceBefore.mtimeNs !== sourceAfter.mtimeNs || sourceBefore.ctimeNs !== sourceAfter.ctimeNs
          || (expected?.device && (expected.device !== String(sourceAfter.dev) || expected.inode !== String(sourceAfter.ino)))
          || statSize(sourceBefore) !== size || statSize(sourceAfter) !== size
          || statSize(targetAfter) !== size || !sameIdentity(targetBefore, targetAfter)
          || !sameIdentity(targetAfter, targetPathStat)
          || (expected && (expected.size !== size || expected.sha256 !== observedSha256))) {
        throw transactionError(failureCode);
      }
      await targetHandle.close();
      targetHandle = null;
      await sourceHandle.close();
      sourceHandle = null;
      await syncDirectory(pathApi.dirname(target));
      return { size, sha256: observedSha256, stat: targetAfter,
        expectedSource: { size, sha256: observedSha256, device: String(sourceAfter.dev), inode: String(sourceAfter.ino) } };
    } catch (error) {
      if (targetHandle) await targetHandle.close().catch(() => {});
      if (sourceHandle) await sourceHandle.close().catch(() => {});
      if (error && error.code === 'EEXIST') throw transactionError(collisionCode);
      if (error instanceof FileTransactionError) throw error;
      throw transactionError(failureCode);
    }
  }

  async function cleanupPublicationArtifact(value, metadata) {
    if (!value) return { cleaned: true };
    const artifact = normalizeArtifact(value);
    const stat = await lstatOrNull(artifact.path);
    if (!stat) return { cleaned: true };
    if (!metadata || !isRegularFile(stat) || !metadataMatchesStat(metadata, stat)) {
      throw transactionError('UNSAFE_OWNED_PATH');
    }
    await readExactFile(artifact.path, metadata, 'UNSAFE_OWNED_PATH');
    const real = await canonicalExisting(artifact.path);
    if (!samePath(real, artifact.path, pathApi, platform)) throw transactionError('UNSAFE_OWNED_PATH');
    if (!ownershipCleanupAvailable) return { cleaned: false, code: 'publication-cleanup-failed' };
    try {
      const result = await options.removeOwned.remove({ target: artifact.path, expected: { ...metadata } });
      if (result?.ownershipMismatch) throw transactionError('UNSAFE_OWNED_PATH');
      if (!result || result.failed || (!result.removed && !result.missing)) {
        return { cleaned: false, code: 'publication-cleanup-failed' };
      }
      return { cleaned: true };
    } catch (error) {
      if (error instanceof FileTransactionError) throw error;
      return { cleaned: false, code: 'publication-cleanup-failed' };
    }
  }

  async function validatePublicationCapability(value, mode, persistedArtifact) {
    const artifact = normalizeArtifact(value);
    let valid;
    try {
      valid = await options.validatePublicationArtifact(artifact, { mode, persistedArtifact });
    } catch (_error) {
      valid = false;
    }
    if (valid !== true) throw transactionError('INVALID_PUBLICATION_ARTIFACT');
    return artifact;
  }

  async function validateReadable(target, metadata, verifyReadable, failureCode) {
    await readExactFile(target, metadata, failureCode);
    if (verifyReadable) {
      if (typeof verifyReadable !== 'function') throw transactionError('INVALID_TRANSACTION_INPUT');
      try {
        const result = await verifyReadable(target);
        if (result === false) throw new Error('invalid');
      } catch (_error) {
        throw transactionError(failureCode);
      }
    }
  }

  async function promoteNoReplace(from, to, collisionCode, { expectedSource, removeSource = false } = {}) {
    let finalCreated = false;
    try {
      if (options.renameExclusive) {
        if (options.renameExclusive.atomicNoReplace !== true
            || (removeSource && options.renameExclusive.atomicExpectedOwnership !== true)
            || typeof options.renameExclusive.promote !== 'function') {
          throw transactionError('ATOMIC_PROMOTION_UNSUPPORTED');
        }
        const result = await options.renameExclusive.promote({
          from, to, expectedSource, removeSource
        });
        if (!result || result.atomicNoReplace !== true || typeof result.sourceRemoved !== 'boolean') {
          throw transactionError('ATOMIC_PROMOTION_UNSUPPORTED');
        }
        if (result.ownershipMismatch) throw transactionError('UNSAFE_OWNED_PATH');
        if (!removeSource && result.sourceRemoved) throw transactionError('ATOMIC_PROMOTION_UNSUPPORTED');
        finalCreated = true;
        await syncDirectory(pathApi.dirname(to));
        return { finalCreated, sourceRemoved: result.sourceRemoved, cleanupPending: !result.sourceRemoved };
      } else {
        try {
          await pfs.link(from, to);
          finalCreated = true;
        } catch (error) {
          if (error && ['ENOSYS', 'ENOTSUP', 'EXDEV', 'EOPNOTSUPP'].includes(error.code)) {
            throw transactionError('ATOMIC_PROMOTION_UNSUPPORTED');
          }
          throw error;
        }
      }
      await syncDirectory(pathApi.dirname(to));
      return { finalCreated, sourceRemoved: false, cleanupPending: true };
    } catch (error) {
      if (error && ['EEXIST', 'EACCES', 'EPERM'].includes(error.code)) throw transactionError(collisionCode);
      if (error instanceof FileTransactionError) throw error;
      throw transactionError('DESTINATION_WRITE_FAILED');
    }
  }

  async function persist(operation, snapshot) {
    const callback = operation?.persistTransaction || options.persistTransaction;
    if (typeof callback !== 'function') throw transactionError('TRANSACTION_STATE_PERSIST_FAILED');
    try {
      await callback(JSON.parse(JSON.stringify(snapshot)));
      if (snapshot.phase && typeof operation?.persistPhase === 'function' && operation.persistPhase !== callback) {
        await operation.persistPhase(JSON.parse(JSON.stringify(snapshot)));
      }
    } catch (_error) {
      throw transactionError('TRANSACTION_STATE_PERSIST_FAILED');
    }
  }

  function newNonce() {
    return crypto.randomUUID().toLowerCase();
  }

  function transactionOwnedKeys(step, phase) {
    if (phase) return ['replacementCandidate', 'replacementBackup', 'publicationSnapshot'];
    if (step?.startsWith('staged-source-')) return ['stagedSource'];
    if (step?.startsWith('encoded-candidate-')) return ['encodedCandidate'];
    if (step?.startsWith('asset-')) return ['destinationPartial'];
    if (step?.startsWith('separate-') || step?.startsWith('copy-') || step?.startsWith('recovery-copy-')) {
      return ['destinationPartial', 'publicationSnapshot'];
    }
    if (step?.startsWith('replacement-') || step?.startsWith('rollback-') || step?.startsWith('recovery-')) {
      return ['replacementCandidate', 'replacementBackup', 'publicationSnapshot'];
    }
    return [];
  }

  function transactionSnapshot({ step, phase, ownedPaths, ownedArtifacts, publicationArtifact, cleanupPending,
    clearOwnedKeys = [] }) {
    const snapshot = { ownedPaths: { ...ownedPaths }, ownedArtifacts: { ...ownedArtifacts } };
    if (step) snapshot.step = step;
    if (phase) snapshot.phase = phase;
    if (publicationArtifact && ownedPaths.publicationSnapshot) snapshot.publicationArtifact = publicationArtifact;
    if (cleanupPending?.length) snapshot.cleanupPending = [...cleanupPending];
    const inferredClears = transactionOwnedKeys(step, phase).filter((key) => !ownedPaths[key]);
    const clears = [...new Set([...clearOwnedKeys, ...inferredClears])];
    if (clears.length) snapshot.clearOwnedKeys = clears;
    if (clears.includes('publicationSnapshot')) snapshot.clearPublicationArtifact = true;
    return snapshot;
  }

  async function inspectExactFile(target, signal, code = 'UNSAFE_OWNED_PATH') {
    let handle;
    try {
      const linkStat = await exactLstat(target);
      if (!isRegularFile(linkStat)) throw transactionError(code);
      const real = await canonicalExisting(target);
      if (!samePath(real, target, pathApi, platform)) throw transactionError(code);
      handle = await pfs.open(target, 'r');
      const before = await exactHandleStat(handle);
      const observed = await hashOpenHandle(handle, signal);
      const after = await exactHandleStat(handle);
      const namedAfter = await exactLstat(target);
      if (!sameIdentity(linkStat, before) || !sameIdentity(before, after) || !sameIdentity(after, namedAfter)
          || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
          || observed.size !== statSize(before) || observed.size !== statSize(after)) {
        throw transactionError(code);
      }
      return { ...observed, stat: after };
    } catch (error) {
      if (error instanceof FileTransactionError) throw error;
      throw transactionError(code);
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  function validateSourceAuthority(expected) {
    if (!expected || !SHA256.test(expected.sha256 || '') || !validSafeInteger(expected.size)
        || !/^[0-9]+$/.test(expected.device || '') || !/^[0-9]+$/.test(expected.inode || '')) {
      throw transactionError('SOURCE_AUTHORITY_REQUIRED');
    }
    return Object.freeze({ size: expected.size, sha256: expected.sha256,
      device: expected.device, inode: expected.inode });
  }

  async function captureSource(operation = {}) {
    const source = validateAbsolutePath(operation.source, pathApi);
    const observed = await inspectExactFile(source, operation.signal, 'SOURCE_CHANGED');
    return { size: observed.size, sha256: observed.sha256,
      device: String(observed.stat.dev), inode: String(observed.stat.ino) };
  }

  async function assertSourceAuthority(source, expected, signal) {
    validateSourceAuthority(expected);
    const observed = await captureSource({ source, signal });
    if (['size', 'sha256', 'device', 'inode'].some((key) => observed[key] !== expected[key])) {
      throw transactionError('SOURCE_CHANGED');
    }
    return observed;
  }

  async function removeExactOwned(target, metadata, { allowMissing = true, allowIdentityAlias = false, guard } = {}) {
    const stat = await lstatOrNull(target);
    if (!stat) {
      if (allowMissing) {
        forgetOwned(target);
        return false;
      }
      throw transactionError('UNSAFE_OWNED_PATH');
    }
    if (!metadata || (!allowIdentityAlias && metadata.path !== target) || !metadata.nonce || metadata.state === 'intent'
        || !metadataMatchesStat(metadata, stat)
        || ((typeof stat.nlink === 'bigint' ? stat.nlink !== 1n : stat.nlink !== 1)
          && metadata.state !== 'cleanup-pending')) {
      throw transactionError('UNSAFE_OWNED_PATH');
    }
    await readExactFile(target, metadata, 'UNSAFE_OWNED_PATH');
    if (!ownershipCleanupAvailable) throw transactionError('OWNED_CLEANUP_FAILED');
    try {
      const result = await options.removeOwned.remove({
        target,
        expected: { ...metadata },
        allowIdentityAlias,
        ...(guard ? { guard } : {})
      });
      if (result?.ownershipMismatch) throw transactionError('UNSAFE_OWNED_PATH');
      if (!result || result.failed || (!result.removed && !result.missing)
          || (result.missing && !allowMissing)) throw transactionError('OWNED_CLEANUP_FAILED');
      await syncDirectory(pathApi.dirname(target));
      forgetOwned(target);
      return result.removed === true;
    } catch (error) {
      if (error instanceof FileTransactionError) throw error;
      throw transactionError('OWNED_CLEANUP_FAILED');
    }
  }

  async function removeReplacementBackup(backup, metadata, finalPath, artifact) {
    if (options.removeOwned?.guardedRemoval !== true) throw transactionError('ATOMIC_PROMOTION_UNSUPPORTED');
    const stat = await exactLstat(finalPath);
    if (!isRegularFile(stat)) throw transactionError('FINAL_VALIDATION_FAILED');
    // The native adapter verifies and locks this exact final while removing
    // the backup. A prior path-based read alone cannot authorize that removal.
    const guard = { target: finalPath, expected: {
      device: String(stat.dev), inode: String(stat.ino), size: artifact.size, sha256: artifact.sha256
    } };
    return removeExactOwned(backup, metadata, { allowMissing: false, guard });
  }

  async function assertReplacementSpace(source, bytes) {
    let free;
    try {
      if (options.replacementFreeSpace) free = await options.replacementFreeSpace(pathApi.dirname(source));
      else {
        const stat = await pfs.statfs(pathApi.dirname(source), { bigint: true });
        free = BigInt(stat.bavail) * BigInt(stat.bsize);
      }
      if ((typeof free !== 'bigint' && !Number.isSafeInteger(free)) || free < 0) throw new Error('invalid space');
      free = BigInt(free);
    } catch (_) { throw transactionError('REPLACEMENT_SPACE_UNAVAILABLE'); }
    if (free < BigInt(bytes) + 512n * 1024n * 1024n) throw transactionError('INSUFFICIENT_REPLACEMENT_SPACE');
  }

  async function capturePublication(operation, artifact, mode, persistedMetadata) {
    const stat = await exactLstat(artifact.path).catch(() => { throw transactionError('PUBLICATION_ARTIFACT_CHANGED'); });
    if (!isRegularFile(stat) || (typeof stat.nlink === 'bigint' && stat.nlink !== 1n)) {
      throw transactionError('PUBLICATION_ARTIFACT_CHANGED');
    }
    const metadata = artifactMetadata(artifact.path, persistedMetadata?.nonce || newNonce(),
      persistedMetadata?.state || 'owned', stat, artifact.sha256, artifact.size);
    await readExactFile(artifact.path, metadata, 'PUBLICATION_ARTIFACT_CHANGED', operation.signal);
    await validatePublicationCapability(artifact, mode, persistedMetadata);
    return metadata;
  }

  async function assertSourceContained(source, sourceRoot) {
    const root = validateAbsolutePath(sourceRoot, pathApi);
    const target = validateAbsolutePath(source, pathApi);
    let realRoot;
    let realTarget;
    try {
      realRoot = await canonicalExisting(root);
      const sourceStat = await exactLstat(target);
      if (!isRegularFile(sourceStat)) throw new Error('unsafe source');
      realTarget = await canonicalExisting(target);
    } catch (_error) {
      throw transactionError('SOURCE_OUTSIDE_ROOT');
    }
    if (!isContained(root, target, pathApi, platform) || !isContained(realRoot, realTarget, pathApi, platform)
        || !samePath(realTarget, target, pathApi, platform)) {
      throw transactionError('SOURCE_OUTSIDE_ROOT');
    }
    return { source: target, sourceRoot: root, realRoot };
  }

  function stagedPath(jobId, itemId, nonce, source) {
    const extension = pathApi.extname(source) || '.mp4';
    return pathApi.join(tempRoot, `${jobId}-${itemId}-${nonce}-source${extension}`);
  }

  function encodedPath(jobId, itemId, nonce, extension = '.mp4') {
    if (typeof extension !== 'string' || !/^\.[a-z0-9]{1,16}$/.test(extension)) {
      throw transactionError('INVALID_TRANSACTION_INPUT');
    }
    return pathApi.join(tempRoot, `${jobId}-${itemId}-${nonce}-encoded${extension}`);
  }

  function publicationPaths(destination, jobId, itemId, nonce) {
    return { destinationPartial: `${destination}.sentry-six-${jobId}-${itemId}-${nonce}.partial` };
  }

  function replacementPaths(source, jobId, itemId, candidateNonce, backupNonce = candidateNonce, codec) {
    if (codec !== undefined) {
      if (!['h265', 'av1'].includes(codec)) throw transactionError('INVALID_TRANSACTION_INPUT');
      return {
        replacementCandidate: pathApi.join(pathApi.dirname(source), `TEMP-${codec.toUpperCase()}-${pathApi.basename(source)}`),
        replacementBackup: pathApi.join(pathApi.dirname(source), `BACKUP-${pathApi.basename(source)}`)
      };
    }
    return {
      replacementCandidate: `${source}.sentry-six-${jobId}-${itemId}-${candidateNonce}.candidate`,
      replacementBackup: `${source}.sentry-six-${jobId}-${itemId}-${backupNonce}.backup`
    };
  }

  function recordedReplacementPaths(source, jobId, itemId, artifacts, codec) {
    const legacy = replacementPaths(source, jobId, itemId,
      artifacts.replacementCandidate?.nonce, artifacts.replacementBackup?.nonce);
    if (codec === undefined) return legacy;
    const readable = replacementPaths(source, jobId, itemId, undefined, undefined, codec);
    // The persisted exact source-derived name selects the format. A job codec
    // alone must not reinterpret a legacy transaction during startup.
    return Object.keys(readable).some(field => artifacts[field]?.path
      && samePath(artifacts[field].path, readable[field], pathApi, platform)) ? readable : legacy;
  }

  async function completeRecoveredCopy({
    operation, artifact, target, field, stepPrefix, ownedPaths, ownedArtifacts, failureCode
  }) {
    let metadata = ownedArtifacts[field];
    if (!metadata) throw transactionError('UNSAFE_OWNED_PATH');
    if (metadata.journal) {
      const copied = await copyExclusive(artifact.path, target, {
        expected: artifact,
        signal: operation.signal,
        collisionCode: 'PARTIAL_COLLISION',
        failureCode,
        resume: { metadata, journal: metadata.journal },
        onResumeReconciled: async (progress) => {
          const proposed = {
            ...ownedArtifacts[field],
            state: 'writing',
            size: progress.size,
            sha256: progress.sha256,
            journal: { committed: { size: progress.size, sha256: progress.sha256 }, pending: null }
          };
          await persist(operation, transactionSnapshot({ step: `${stepPrefix}-resume-reconciled`, ownedPaths,
            ownedArtifacts: { ...ownedArtifacts, [field]: proposed }, publicationArtifact: artifact }));
          ownedArtifacts[field] = proposed;
        },
        onChunkPending: async (progress) => {
          ownedArtifacts[field].state = 'writing';
          ownedArtifacts[field].journal.pending = { size: progress.size, sha256: progress.sha256 };
          await persist(operation, transactionSnapshot({ step: `${stepPrefix}-chunk-pending`, ownedPaths,
            ownedArtifacts, publicationArtifact: artifact }));
        },
        onChunkCommitted: async (progress) => {
          const proposed = {
            ...ownedArtifacts[field],
            state: 'writing',
            size: progress.size,
            sha256: progress.sha256,
            journal: { committed: { size: progress.size, sha256: progress.sha256 }, pending: null }
          };
          await persist(operation, transactionSnapshot({ step: `${stepPrefix}-chunk-committed`, ownedPaths,
            ownedArtifacts: { ...ownedArtifacts, [field]: proposed }, publicationArtifact: artifact }));
          ownedArtifacts[field] = proposed;
        }
      });
      ownedArtifacts[field] = artifactMetadata(target, metadata.nonce, 'owned', copied.stat,
        copied.sha256, copied.size, ownedArtifacts[field].journal);
      await persist(operation, transactionSnapshot({ step: `${stepPrefix}-owned`, ownedPaths,
        ownedArtifacts, publicationArtifact: artifact }));
      metadata = ownedArtifacts[field];
    }
    if (metadata.size !== artifact.size || metadata.sha256 !== artifact.sha256) {
      throw transactionError('MANUAL_INTERVENTION');
    }
    await readExactFile(target, metadata, failureCode, operation.signal);
    return metadata;
  }

  async function stageSource(operation = {}) {
    const jobId = validateId(operation.jobId);
    const itemId = validateId(operation.itemId);
    const source = validateAbsolutePath(operation.source, pathApi);
    abortIfRequested(operation.signal);
    if (activeStagedPath) throw transactionError('STAGING_BUSY');
    const expectedSource = operation.expectedSource ? validateSourceAuthority(operation.expectedSource) : null;
    const resumeState = operation.resume;
    const nonce = resumeState?.ownedArtifacts?.stagedSource?.nonce || newNonce();
    const destination = stagedPath(jobId, itemId, nonce, source);
    if (resumeState && !samePath(resumeState.ownedPaths?.stagedSource, destination, pathApi, platform)) {
      throw transactionError('UNSAFE_OWNED_PATH');
    }
    activeStagedPath = destination;
    const ownedPaths = resumeState ? { ...resumeState.ownedPaths } : { stagedSource: destination };
    const ownedArtifacts = resumeState ? { ...resumeState.ownedArtifacts } : {
      stagedSource: artifactMetadata(destination, nonce, 'intent')
    };
    try {
      const realTempRoot = await canonicalExisting(tempRoot);
      const canonicalDestination = await canonicalForNew(destination);
      if (!isContained(realTempRoot, canonicalDestination, pathApi, platform)) throw transactionError('UNSAFE_OWNED_PATH');
      let resumeCopy = null;
      if (resumeState) {
        const journal = ownedArtifacts.stagedSource.journal;
        if (!journal || ownedArtifacts.stagedSource.state === 'intent') throw transactionError('UNSAFE_OWNED_PATH');
        resumeCopy = { metadata: ownedArtifacts.stagedSource, journal };
      } else {
        await persist(operation, transactionSnapshot({ step: 'staged-source-intent', ownedPaths, ownedArtifacts }));
      }
      const copied = await copyExclusive(source, destination, {
        expected: expectedSource,
        signal: operation.signal,
        collisionCode: 'PARTIAL_COLLISION',
        failureCode: 'STAGING_FAILED',
        resume: resumeCopy,
        onResumeReconciled: async (progress) => {
          const proposed = {
            ...ownedArtifacts.stagedSource,
            state: 'writing',
            size: progress.size,
            sha256: progress.sha256,
            journal: { committed: { size: progress.size, sha256: progress.sha256 }, pending: null }
          };
          await persist(operation, transactionSnapshot({ step: 'staged-source-resume-reconciled', ownedPaths,
            ownedArtifacts: { ...ownedArtifacts, stagedSource: proposed } }));
          ownedArtifacts.stagedSource = proposed;
        },
        onCreated: async (progress) => {
          const journal = { committed: { size: 0, sha256: progress.sha256 }, pending: null };
          ownedArtifacts.stagedSource = artifactMetadata(destination, ownedArtifacts.stagedSource.nonce,
            'writing', progress.stat, progress.sha256, progress.size, journal);
          await persist(operation, transactionSnapshot({ step: 'staged-source-writing', ownedPaths, ownedArtifacts }));
        },
        onChunkPending: async (progress) => {
          ownedArtifacts.stagedSource.journal.pending = { size: progress.size, sha256: progress.sha256 };
          await persist(operation, transactionSnapshot({ step: 'staged-source-chunk-pending', ownedPaths, ownedArtifacts }));
        },
        onChunkCommitted: async (progress) => {
          const proposed = {
            ...ownedArtifacts.stagedSource,
            size: progress.size,
            sha256: progress.sha256,
            journal: { committed: { size: progress.size, sha256: progress.sha256 }, pending: null }
          };
          await persist(operation, transactionSnapshot({ step: 'staged-source-chunk-committed', ownedPaths,
            ownedArtifacts: { ...ownedArtifacts, stagedSource: proposed } }));
          ownedArtifacts.stagedSource = proposed;
        }
      });
      ownedArtifacts.stagedSource = artifactMetadata(destination, ownedArtifacts.stagedSource.nonce,
        'owned', copied.stat, copied.sha256, copied.size, ownedArtifacts.stagedSource.journal);
      await persist(operation, transactionSnapshot({ step: 'staged-source-owned', ownedPaths, ownedArtifacts }));
      abortIfRequested(operation.signal);
      return { stagedSource: destination, ownedPaths, ownedArtifacts, sourceBytes: copied.size, expectedSource: copied.expectedSource };
    } catch (error) {
      activeStagedPath = null;
      if (await lstatOrNull(destination).catch(() => null)) {
        ownedArtifacts.stagedSource.state = 'cleanup-pending';
        try {
          await persist(operation, transactionSnapshot({ step: 'staged-source-cleanup-pending', ownedPaths,
            ownedArtifacts, cleanupPending: ['stagedSource'] }));
        } catch (_persistError) { /* primary failure remains authoritative */ }
        const failure = error instanceof FileTransactionError ? error : transactionError('STAGING_FAILED');
        failure.cleanupPending = ['stagedSource'];
        throw failure;
      }
      if (error instanceof FileTransactionError) {
        if (error.code === 'CANCELLED' || error.code === 'STAGING_BUSY' || error.code === 'PARTIAL_COLLISION'
            || error.code === 'INVALID_TRANSACTION_INPUT' || error.code === 'UNSAFE_OWNED_PATH'
            || error.code === 'TRANSACTION_STATE_PERSIST_FAILED') throw error;
      }
      throw transactionError('STAGING_FAILED');
    }
  }

  async function reserveEncodeOutput(operation = {}) {
    const jobId = validateId(operation.jobId);
    const itemId = validateId(operation.itemId);
    if (activeEncodedPath) throw transactionError('STAGING_BUSY');
    const nonce = newNonce();
    const target = encodedPath(jobId, itemId, nonce, operation.extension || '.mp4');
    const canonicalRoot = await canonicalExisting(tempRoot);
    const canonicalTarget = await canonicalForNew(target);
    if (!isContained(canonicalRoot, canonicalTarget, pathApi, platform) || await lstatOrNull(target)) {
      throw transactionError('UNSAFE_OWNED_PATH');
    }
    const ownedPaths = { encodedCandidate: target };
    const ownedArtifacts = { encodedCandidate: artifactMetadata(target, nonce, 'intent') };
    await persist(operation, transactionSnapshot({
      step: 'encoded-candidate-intent', ownedPaths, ownedArtifacts
    }));
    activeEncodedPath = target;
    return { path: target, nonce, ownedPaths, ownedArtifacts };
  }

  async function adoptEncodeOutput(operation = {}) {
    const jobId = validateId(operation.jobId);
    const itemId = validateId(operation.itemId);
    const ownedPaths = { ...(operation.ownedPaths || {}) };
    const ownedArtifacts = { ...(operation.ownedArtifacts || {}) };
    const metadata = ownedArtifacts.encodedCandidate;
    const target = validateAbsolutePath(ownedPaths.encodedCandidate, pathApi);
    if (!metadata || !['intent', 'owned'].includes(metadata.state) || metadata.path !== target || !metadata.nonce
        || (activeEncodedPath && !samePath(activeEncodedPath, target, pathApi, platform))) {
      throw transactionError('UNSAFE_OWNED_PATH');
    }
    const expected = encodedPath(jobId, itemId, metadata.nonce, pathApi.extname(target));
    if (!samePath(expected, target, pathApi, platform)) throw transactionError('UNSAFE_OWNED_PATH');
    const observed = await inspectExactFile(target, operation.signal, 'UNSAFE_OWNED_PATH');
    if (metadata.state === 'owned' && !metadataMatchesIdentity(metadata, observed.stat)) {
      throw transactionError('UNSAFE_OWNED_PATH');
    }
    ownedArtifacts.encodedCandidate = artifactMetadata(
      target, metadata.nonce, 'owned', observed.stat, observed.sha256, observed.size
    );
    operation.ownedArtifacts.encodedCandidate = { ...ownedArtifacts.encodedCandidate };
    activeEncodedPath = target;
    await rememberOwned(target);
    await persist(operation, transactionSnapshot({
      step: 'encoded-candidate-owned', ownedPaths, ownedArtifacts
    }));
    return { path: target, outputBytes: observed.size, ownedPaths, ownedArtifacts };
  }

  async function copyAsset(operation = {}) {
    const jobId = validateId(operation.jobId);
    const itemId = validateId(operation.itemId);
    const sourceInfo = await assertSourceContained(operation.source, operation.sourceRoot);
    const destinationRoot = validateAbsolutePath(operation.destinationRoot, pathApi);
    const destination = validateAbsolutePath(operation.destination, pathApi);
    const realDestinationRoot = await canonicalExisting(destinationRoot)
      .catch(() => { throw transactionError('UNSAFE_OWNED_PATH'); });
    const canonicalDestination = await canonicalForNew(destination)
      .catch(() => { throw transactionError('UNSAFE_OWNED_PATH'); });
    if (!isContained(destinationRoot, destination, pathApi, platform)
        || !isContained(realDestinationRoot, canonicalDestination, pathApi, platform)) {
      throw transactionError('UNSAFE_OWNED_PATH');
    }
    if (await lstatOrNull(destination)) throw transactionError('DESTINATION_COLLISION');

    const nonce = newNonce();
    const ownedPaths = publicationPaths(destination, jobId, itemId, nonce);
    const ownedArtifacts = {
      destinationPartial: artifactMetadata(ownedPaths.destinationPartial, nonce, 'intent')
    };
    let finalCreated = false;
    let finalVerified = false;
    try {
      const canonicalPartial = await canonicalForNew(ownedPaths.destinationPartial);
      if (!samePath(pathApi.dirname(canonicalPartial), pathApi.dirname(canonicalDestination), pathApi, platform)) {
        throw transactionError('UNSAFE_OWNED_PATH');
      }
      await persist(operation, transactionSnapshot({ step: 'asset-partial-intent', ownedPaths, ownedArtifacts }));
      const copied = await copyExclusive(sourceInfo.source, ownedPaths.destinationPartial, {
        expected: null,
        signal: operation.signal,
        collisionCode: 'PARTIAL_COLLISION',
        failureCode: 'DESTINATION_WRITE_FAILED',
        onCreated: async (progress) => {
          const journal = { committed: { size: 0, sha256: progress.sha256 }, pending: null };
          ownedArtifacts.destinationPartial = artifactMetadata(
            ownedPaths.destinationPartial, nonce, 'writing', progress.stat,
            progress.sha256, progress.size, journal
          );
          await persist(operation, transactionSnapshot({ step: 'asset-partial-writing', ownedPaths, ownedArtifacts }));
        },
        onChunkPending: async (progress) => {
          ownedArtifacts.destinationPartial.journal.pending = { size: progress.size, sha256: progress.sha256 };
          await persist(operation, transactionSnapshot({ step: 'asset-partial-chunk-pending', ownedPaths, ownedArtifacts }));
        },
        onChunkCommitted: async (progress) => {
          const proposed = {
            ...ownedArtifacts.destinationPartial,
            size: progress.size,
            sha256: progress.sha256,
            journal: { committed: { size: progress.size, sha256: progress.sha256 }, pending: null }
          };
          await persist(operation, transactionSnapshot({
            step: 'asset-partial-chunk-committed', ownedPaths,
            ownedArtifacts: { destinationPartial: proposed }
          }));
          ownedArtifacts.destinationPartial = proposed;
        }
      });
      ownedArtifacts.destinationPartial = artifactMetadata(
        ownedPaths.destinationPartial, nonce, 'owned', copied.stat,
        copied.sha256, copied.size, ownedArtifacts.destinationPartial.journal
      );
      await persist(operation, transactionSnapshot({ step: 'asset-partial-owned', ownedPaths, ownedArtifacts }));
      await validateReadable(ownedPaths.destinationPartial, ownedArtifacts.destinationPartial,
        operation.verifyReadable, 'DESTINATION_VALIDATION_FAILED');
      await persist(operation, transactionSnapshot({ step: 'asset-promotion-intent', ownedPaths, ownedArtifacts }));
      const promotion = await promoteNoReplace(ownedPaths.destinationPartial, destination, 'DESTINATION_COLLISION', {
        expectedSource: ownedArtifacts.destinationPartial,
        removeSource: false
      });
      finalCreated = true;
      if (promotion.sourceRemoved) throw transactionError('ATOMIC_PROMOTION_UNSUPPORTED');
      ownedArtifacts.destinationPartial.state = 'cleanup-pending';
      await validateReadable(destination, ownedArtifacts.destinationPartial,
        operation.verifyReadable, 'DESTINATION_VALIDATION_FAILED');
      finalVerified = true;
      const cleanupPending = ['destinationPartial'];
      await persist(operation, transactionSnapshot({
        step: 'asset-complete-cleanup-pending', ownedPaths, ownedArtifacts, cleanupPending
      }));
      return {
        finalPath: destination,
        outputBytes: copied.size,
        ownedPaths,
        ownedArtifacts,
        cleanupPending
      };
    } catch (error) {
      if (finalCreated && !finalVerified) {
        ownedArtifacts.destinationPartial.state = 'cleanup-pending';
        try {
          await removeExactOwned(destination, ownedArtifacts.destinationPartial, {
            allowMissing: false,
            allowIdentityAlias: true
          });
          finalCreated = false;
        } catch (_cleanupError) {
          if (error instanceof FileTransactionError) error.cleanupPending = ['destinationPartial'];
        }
      }
      if (!finalCreated && ownedArtifacts.destinationPartial.state !== 'intent') {
        try {
          await removeExactOwned(ownedPaths.destinationPartial, ownedArtifacts.destinationPartial);
          delete ownedPaths.destinationPartial;
          delete ownedArtifacts.destinationPartial;
        } catch (_cleanupError) {
          ownedArtifacts.destinationPartial.state = 'cleanup-pending';
          if (error instanceof FileTransactionError) error.cleanupPending = ['destinationPartial'];
        }
      }
      if (finalCreated && !finalVerified) {
        ownedArtifacts.destinationPartial.state = 'cleanup-pending';
        if (error instanceof FileTransactionError) error.cleanupPending = ['destinationPartial'];
      }
      if (finalCreated && finalVerified && error instanceof FileTransactionError) {
        ownedArtifacts.destinationPartial.state = 'cleanup-pending';
        error.cleanupPending = ['destinationPartial'];
        error.validFinal = {
          finalPath: destination,
          outputBytes: ownedArtifacts.destinationPartial.size,
          ownedPaths: { ...ownedPaths },
          ownedArtifacts: { ...ownedArtifacts },
          cleanupPending: ['destinationPartial']
        };
      }
      if (error instanceof FileTransactionError) throw error;
      throw transactionError('DESTINATION_WRITE_FAILED');
    }
  }

  async function publishSeparate(operation = {}) {
    const jobId = validateId(operation.jobId);
    const itemId = validateId(operation.itemId);
    const destination = validateAbsolutePath(operation.destination, pathApi);
    const artifact = normalizeArtifact(operation.publicationArtifact);
    const partialNonce = newNonce();
    const ownedPaths = { ...publicationPaths(destination, jobId, itemId, partialNonce), publicationSnapshot: artifact.path };
    const ownedArtifacts = {};
    const cleanupPending = [];
    let trusted = false;
    let finalCreated = false;
    let finalVerified = false;
    try {
      ownedArtifacts.publicationSnapshot = await capturePublication(operation, artifact, 'consume');
      trusted = true;
      await persist(operation, transactionSnapshot({ step: 'separate-snapshot-owned', ownedPaths, ownedArtifacts, publicationArtifact: artifact }));
      abortIfRequested(operation.signal);
      if (await lstatOrNull(destination)) throw transactionError('DESTINATION_COLLISION');
      const canonicalPartial = await canonicalForNew(ownedPaths.destinationPartial);
      const canonicalDestination = await canonicalForNew(destination);
      if (!samePath(pathApi.dirname(canonicalPartial), pathApi.dirname(canonicalDestination), pathApi, platform)) {
        throw transactionError('UNSAFE_OWNED_PATH');
      }
      ownedArtifacts.destinationPartial = artifactMetadata(ownedPaths.destinationPartial, partialNonce, 'intent');
      await persist(operation, transactionSnapshot({ step: 'separate-partial-intent', ownedPaths, ownedArtifacts, publicationArtifact: artifact }));
      const copied = await copyExclusive(artifact.path, ownedPaths.destinationPartial, {
        expected: artifact,
        signal: operation.signal,
        collisionCode: 'PARTIAL_COLLISION',
        failureCode: 'PUBLICATION_ARTIFACT_CHANGED',
        onCreated: async (progress) => {
          const journal = { committed: { size: 0, sha256: progress.sha256 }, pending: null };
          ownedArtifacts.destinationPartial = artifactMetadata(ownedPaths.destinationPartial,
            ownedArtifacts.destinationPartial.nonce, 'writing', progress.stat, progress.sha256, progress.size, journal);
          await persist(operation, transactionSnapshot({ step: 'separate-partial-writing', ownedPaths, ownedArtifacts,
            publicationArtifact: artifact }));
        },
        onChunkPending: async (progress) => {
          ownedArtifacts.destinationPartial.journal.pending = { size: progress.size, sha256: progress.sha256 };
          await persist(operation, transactionSnapshot({ step: 'separate-partial-chunk-pending', ownedPaths, ownedArtifacts,
            publicationArtifact: artifact }));
        },
        onChunkCommitted: async (progress) => {
          const proposed = { ...ownedArtifacts.destinationPartial, size: progress.size, sha256: progress.sha256,
            journal: { committed: { size: progress.size, sha256: progress.sha256 }, pending: null } };
          await persist(operation, transactionSnapshot({ step: 'separate-partial-chunk-committed', ownedPaths,
            ownedArtifacts: { ...ownedArtifacts, destinationPartial: proposed }, publicationArtifact: artifact }));
          ownedArtifacts.destinationPartial = proposed;
        }
      });
      ownedArtifacts.destinationPartial = artifactMetadata(ownedPaths.destinationPartial,
        ownedArtifacts.destinationPartial.nonce, 'owned', copied.stat, copied.sha256, copied.size,
        ownedArtifacts.destinationPartial.journal);
      await persist(operation, transactionSnapshot({ step: 'separate-partial-owned', ownedPaths, ownedArtifacts, publicationArtifact: artifact }));
      abortIfRequested(operation.signal);
      await validateReadable(ownedPaths.destinationPartial, artifact, operation.verifyReadable, 'DESTINATION_VALIDATION_FAILED');
      abortIfRequested(operation.signal);
      await persist(operation, transactionSnapshot({ step: 'separate-promotion-intent', ownedPaths, ownedArtifacts, publicationArtifact: artifact }));
      const promotion = await promoteNoReplace(ownedPaths.destinationPartial, destination, 'DESTINATION_COLLISION', {
        expectedSource: ownedArtifacts.destinationPartial
      });
      finalCreated = true;
      if (!promotion.sourceRemoved) {
        ownedArtifacts.destinationPartial.state = 'cleanup-pending';
        cleanupPending.push('destinationPartial');
      }
      await validateReadable(destination, artifact, operation.verifyReadable, 'DESTINATION_VALIDATION_FAILED');
      finalVerified = true;
      abortIfRequested(operation.signal);
      if (promotion.sourceRemoved) {
        delete ownedPaths.destinationPartial;
        delete ownedArtifacts.destinationPartial;
      }
      const snapshotCleanup = await cleanupPublicationArtifact(artifact, ownedArtifacts.publicationSnapshot);
      if (snapshotCleanup.cleaned) {
        delete ownedPaths.publicationSnapshot;
        delete ownedArtifacts.publicationSnapshot;
      } else {
        ownedArtifacts.publicationSnapshot.state = 'cleanup-pending';
        cleanupPending.push('publicationSnapshot');
      }
      const step = cleanupPending.length ? 'separate-complete-cleanup-pending' : 'separate-complete';
      await persist(operation, transactionSnapshot({ step, ownedPaths, ownedArtifacts,
        publicationArtifact: artifact, cleanupPending }));
      return { finalPath: destination, outputBytes: artifact.size, ownedPaths, ownedArtifacts, cleanupPending };
    } catch (error) {
      const failureCleanupPending = new Set();
      if (finalCreated && !finalVerified && ownedArtifacts.destinationPartial) {
        try {
          await removeExactOwned(destination, ownedArtifacts.destinationPartial, { allowIdentityAlias: true });
        } catch (_cleanupError) {
          ownedArtifacts.destinationPartial.state = 'cleanup-pending';
          failureCleanupPending.add('destinationPartial');
        }
      }
      if (ownedArtifacts.destinationPartial?.state !== 'intent' && !failureCleanupPending.has('destinationPartial')) {
        try {
          await removeExactOwned(ownedPaths.destinationPartial, ownedArtifacts.destinationPartial);
          delete ownedPaths.destinationPartial;
          delete ownedArtifacts.destinationPartial;
        } catch (_cleanupError) {
          ownedArtifacts.destinationPartial.state = 'cleanup-pending';
          failureCleanupPending.add('destinationPartial');
        }
      }
      if (trusted) {
        const cleaned = await cleanupPublicationArtifact(artifact, ownedArtifacts.publicationSnapshot);
        if (cleaned.cleaned) {
          delete ownedPaths.publicationSnapshot;
          delete ownedArtifacts.publicationSnapshot;
        } else {
          ownedArtifacts.publicationSnapshot.state = 'cleanup-pending';
          failureCleanupPending.add('publicationSnapshot');
        }
      }
      if (failureCleanupPending.size) {
        const pending = [...failureCleanupPending];
        try {
          await persist(operation, transactionSnapshot({ step: 'separate-failed-cleanup-pending', ownedPaths,
            ownedArtifacts, publicationArtifact: artifact, cleanupPending: pending }));
        } catch (_persistError) { /* primary error remains bounded */ }
        if (error instanceof FileTransactionError) {
          error.cleanupPending = pending;
        }
      }
      if (finalCreated && finalVerified && error instanceof FileTransactionError) {
        const pending = [...new Set([
          ...cleanupPending,
          ...failureCleanupPending,
          ...Object.entries(ownedArtifacts).filter(([, metadata]) => metadata.state === 'cleanup-pending')
            .map(([key]) => key)
        ])];
        error.validFinal = {
          finalPath: destination,
          outputBytes: artifact.size,
          ownedPaths: { ...ownedPaths },
          ownedArtifacts: { ...ownedArtifacts },
          cleanupPending: pending
        };
      }
      if (error instanceof FileTransactionError) throw error;
      throw transactionError('DESTINATION_WRITE_FAILED');
    }
  }

  async function rollbackReplacement(operation = {}) {
    const { source, sourceRoot } = await assertSourceOrMissingContained(operation.source, operation.sourceRoot);
    const artifact = normalizeArtifact(operation.publicationArtifact);
    const ownedPaths = { ...(operation.ownedPaths || {}) };
    const ownedArtifacts = { ...(operation.ownedArtifacts || {}) };
    const candidate = validateAbsolutePath(ownedPaths.replacementCandidate, pathApi);
    const backup = validateAbsolutePath(ownedPaths.replacementBackup, pathApi);
    const persistedArtifact = ownedPaths.publicationSnapshot
      && samePath(ownedPaths.publicationSnapshot, artifact.path, pathApi, platform) ? artifact : null;
    assertReplacementNames(source, candidate, backup, validateId(operation.jobId), validateId(operation.itemId), ownedArtifacts, operation.codec);
    try {
      if (persistedArtifact) {
        await validatePublicationCapability(artifact, 'reconcile', artifact);
      }
      await persist(operation, transactionSnapshot({ phase: 'rollback-started', ownedPaths, ownedArtifacts,
        publicationArtifact: persistedArtifact }));
      const sourceStat = await lstatOrNull(source);
      const backupStat = await lstatOrNull(backup);
      if (sourceStat && backupStat) {
        const candidateMetadata = ownedArtifacts.replacementCandidate;
        if (!candidateMetadata || !metadataMatchesStat(candidateMetadata, sourceStat)) throw transactionError('ROLLBACK_FAILED');
        try {
          await removeExactOwned(source, candidateMetadata, { allowMissing: false, allowIdentityAlias: true });
        } catch (cleanupError) {
          if (cleanupError instanceof FileTransactionError && cleanupError.code === 'OWNED_CLEANUP_FAILED') {
            ownedArtifacts.replacementCandidate.state = 'cleanup-pending';
          }
          throw cleanupError;
        }
      }
      if (await lstatOrNull(backup)) {
        if (await lstatOrNull(source)) throw transactionError('ROLLBACK_FAILED');
        const backupMetadata = ownedArtifacts.replacementBackup;
        if (!backupMetadata) throw transactionError('ROLLBACK_FAILED');
        await readExactFile(backup, backupMetadata, 'ROLLBACK_FAILED');
        const promotion = await promoteNoReplace(backup, source, 'ROLLBACK_FAILED', {
          expectedSource: backupMetadata,
          removeSource: true
        });
        if (!promotion.sourceRemoved) {
          ownedArtifacts.replacementBackup.state = 'cleanup-pending';
        } else {
          delete ownedPaths.replacementBackup;
          delete ownedArtifacts.replacementBackup;
        }
      } else {
        delete ownedPaths.replacementBackup;
        delete ownedArtifacts.replacementBackup;
      }
      if (await lstatOrNull(candidate)) {
        try {
          await removeExactOwned(candidate, ownedArtifacts.replacementCandidate, { allowMissing: false });
        } catch (cleanupError) {
          if (cleanupError instanceof FileTransactionError && cleanupError.code === 'OWNED_CLEANUP_FAILED') {
            ownedArtifacts.replacementCandidate.state = 'cleanup-pending';
          }
          throw cleanupError;
        }
      }
      delete ownedPaths.replacementCandidate;
      delete ownedArtifacts.replacementCandidate;
      if (!await lstatOrNull(source)) throw transactionError('ROLLBACK_FAILED');
      await assertSourceContained(source, sourceRoot);
      if (persistedArtifact) {
        const cleaned = await cleanupPublicationArtifact(persistedArtifact, ownedArtifacts.publicationSnapshot);
        if (cleaned.cleaned) {
          delete ownedPaths.publicationSnapshot;
          delete ownedArtifacts.publicationSnapshot;
        } else {
          ownedArtifacts.publicationSnapshot.state = 'cleanup-pending';
        }
      }
      const cleanupPending = Object.entries(ownedArtifacts)
        .filter(([, metadata]) => metadata.state === 'cleanup-pending').map(([key]) => key);
      await persist(operation, transactionSnapshot({ phase: 'backup-restored', ownedPaths, ownedArtifacts,
        publicationArtifact: persistedArtifact, cleanupPending }));
      return { phase: 'backup-restored', source, ownedPaths, ownedArtifacts, cleanupPending };
    } catch (_error) {
      const cleanupPending = Object.entries(ownedArtifacts)
        .filter(([, metadata]) => metadata.state === 'cleanup-pending').map(([key]) => key);
      try {
        await persist(operation, transactionSnapshot({ phase: 'rollback-failed', ownedPaths, ownedArtifacts,
          publicationArtifact: persistedArtifact, cleanupPending }));
      } catch (_persistError) { /* rollback failure remains bounded */ }
      const failure = transactionError('ROLLBACK_FAILED');
      failure.cleanupPending = cleanupPending;
      throw failure;
    }
  }

  async function assertSourceOrMissingContained(sourceValue, sourceRootValue) {
    const source = validateAbsolutePath(sourceValue, pathApi);
    const sourceRoot = validateAbsolutePath(sourceRootValue, pathApi);
    const realRoot = await canonicalExisting(sourceRoot).catch(() => { throw transactionError('SOURCE_OUTSIDE_ROOT'); });
    const canonicalTarget = await canonicalForNew(source).catch(() => { throw transactionError('SOURCE_OUTSIDE_ROOT'); });
    if (!isContained(sourceRoot, source, pathApi, platform) || !isContained(realRoot, canonicalTarget, pathApi, platform)) {
      throw transactionError('SOURCE_OUTSIDE_ROOT');
    }
    const stat = await lstatOrNull(source);
    if (stat) {
      if (!isRegularFile(stat)) throw transactionError('SOURCE_OUTSIDE_ROOT');
      const real = await canonicalExisting(source);
      if (!samePath(real, source, pathApi, platform) || !isContained(realRoot, real, pathApi, platform)) {
        throw transactionError('SOURCE_OUTSIDE_ROOT');
      }
    }
    return { source, sourceRoot, realRoot };
  }

  function assertReplacementNames(source, candidate, backup, jobId, itemId, artifacts = {}, codec) {
    if (jobId && itemId) {
      const expected = recordedReplacementPaths(source, jobId, itemId, artifacts, codec);
      if (!samePath(expected.replacementCandidate, candidate, pathApi, platform)
          || !samePath(expected.replacementBackup, backup, pathApi, platform)) throw transactionError('UNSAFE_OWNED_PATH');
      return;
    }
    const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const candidateMatch = new RegExp(`^${escaped}\\.sentry-six-([a-z0-9][a-z0-9_-]{0,127})-([a-z0-9][a-z0-9_-]{0,127})\\.candidate$`).exec(candidate);
    const backupMatch = new RegExp(`^${escaped}\\.sentry-six-([a-z0-9][a-z0-9_-]{0,127})-([a-z0-9][a-z0-9_-]{0,127})\\.backup$`).exec(backup);
    if (!candidateMatch || !backupMatch || candidateMatch[1] !== backupMatch[1] || candidateMatch[2] !== backupMatch[2]
        || WINDOWS_RESERVED_NAME.test(candidateMatch[1]) || WINDOWS_RESERVED_NAME.test(candidateMatch[2])) {
      throw transactionError('UNSAFE_OWNED_PATH');
    }
  }

  async function replaceOriginal(operation = {}) {
    const jobId = validateId(operation.jobId);
    const itemId = validateId(operation.itemId);
    const artifact = normalizeArtifact(operation.publicationArtifact);
    if (!replacementAvailable || !options.renameExclusive || options.renameExclusive.atomicNoReplace !== true
        || options.renameExclusive.atomicExpectedOwnership !== true
        || !ownershipCleanupAvailable
        || typeof options.renameExclusive.promote !== 'function') {
      throw transactionError('ATOMIC_PROMOTION_UNSUPPORTED');
    }
    const expectedSource = validateSourceAuthority(operation.expectedSource);
    await assertSourceContained(operation.source, operation.sourceRoot);
    await assertSourceAuthority(operation.source, expectedSource, operation.signal);
    let sourceInfo;
    let ownedPaths;
    let originalIdentity;
    const ownedArtifacts = {};
    let trusted = false;
    let replacementStarted = false;
    let rollbackCompleted = false;
    let backupDeleted = false;
    try {
      sourceInfo = await assertSourceContained(operation.source, operation.sourceRoot);
      originalIdentity = await exactLstat(sourceInfo.source);
      const candidateNonce = newNonce();
      const backupNonce = newNonce();
      const proposedPaths = replacementPaths(sourceInfo.source, jobId, itemId, candidateNonce, backupNonce, operation.codec);
      if (await lstatOrNull(proposedPaths.replacementCandidate) || await lstatOrNull(proposedPaths.replacementBackup)) {
        throw transactionError('REPLACEMENT_COLLISION');
      }
      await assertReplacementSpace(sourceInfo.source, artifact.size);
      ownedPaths = proposedPaths;
      ownedPaths.publicationSnapshot = artifact.path;
      ownedArtifacts.publicationSnapshot = await capturePublication(operation, artifact, 'consume');
      ownedArtifacts.replacementBackup = artifactMetadata(ownedPaths.replacementBackup, backupNonce, 'intent');
      trusted = true;
      await persist(operation, transactionSnapshot({ step: 'replacement-snapshot-owned', ownedPaths, ownedArtifacts,
        publicationArtifact: artifact }));
      const canonicalCandidate = await canonicalForNew(ownedPaths.replacementCandidate);
      const canonicalBackup = await canonicalForNew(ownedPaths.replacementBackup);
      if (!isContained(sourceInfo.realRoot, canonicalCandidate, pathApi, platform)
          || !isContained(sourceInfo.realRoot, canonicalBackup, pathApi, platform)) throw transactionError('SOURCE_OUTSIDE_ROOT');
      ownedArtifacts.replacementCandidate = artifactMetadata(ownedPaths.replacementCandidate, candidateNonce, 'intent');
      await persist(operation, transactionSnapshot({ step: 'replacement-candidate-intent', ownedPaths, ownedArtifacts,
        publicationArtifact: artifact }));
      const copied = await copyExclusive(artifact.path, ownedPaths.replacementCandidate, {
        expected: artifact,
        signal: operation.signal,
        collisionCode: 'REPLACEMENT_COLLISION',
        failureCode: 'PUBLICATION_ARTIFACT_CHANGED',
        onCreated: async (progress) => {
          const journal = { committed: { size: 0, sha256: progress.sha256 }, pending: null };
          ownedArtifacts.replacementCandidate = artifactMetadata(ownedPaths.replacementCandidate,
            ownedArtifacts.replacementCandidate.nonce, 'writing', progress.stat, progress.sha256, progress.size, journal);
          await persist(operation, transactionSnapshot({ step: 'replacement-candidate-writing', ownedPaths, ownedArtifacts,
            publicationArtifact: artifact }));
        },
        onChunkPending: async (progress) => {
          ownedArtifacts.replacementCandidate.journal.pending = { size: progress.size, sha256: progress.sha256 };
          await persist(operation, transactionSnapshot({ step: 'replacement-candidate-chunk-pending', ownedPaths,
            ownedArtifacts, publicationArtifact: artifact }));
        },
        onChunkCommitted: async (progress) => {
          const proposed = { ...ownedArtifacts.replacementCandidate, size: progress.size, sha256: progress.sha256,
            journal: { committed: { size: progress.size, sha256: progress.sha256 }, pending: null } };
          await persist(operation, transactionSnapshot({ step: 'replacement-candidate-chunk-committed', ownedPaths,
            ownedArtifacts: { ...ownedArtifacts, replacementCandidate: proposed }, publicationArtifact: artifact }));
          ownedArtifacts.replacementCandidate = proposed;
        }
      });
      ownedArtifacts.replacementCandidate = artifactMetadata(ownedPaths.replacementCandidate,
        ownedArtifacts.replacementCandidate.nonce, 'owned', copied.stat, copied.sha256, copied.size,
        ownedArtifacts.replacementCandidate.journal);
      await validateReadable(ownedPaths.replacementCandidate, artifact, operation.verifyReadable, 'FINAL_VALIDATION_FAILED');
      await persist(operation, transactionSnapshot({ phase: 'candidate-written', ownedPaths, ownedArtifacts,
        publicationArtifact: artifact }));
      abortIfRequested(operation.signal);

      const currentOriginal = await assertRegularUnaliased(sourceInfo.source, 'SOURCE_OUTSIDE_ROOT');
      if (!sameIdentity(originalIdentity, currentOriginal)) throw transactionError('SOURCE_OUTSIDE_ROOT');
      await readExactFile(ownedPaths.replacementCandidate, artifact, 'PUBLICATION_ARTIFACT_CHANGED');
      await persist(operation, transactionSnapshot({ step: 'replacement-backup-intent', ownedPaths, ownedArtifacts,
        publicationArtifact: artifact }));
      await assertSourceAuthority(sourceInfo.source, expectedSource, operation.signal);
      const backupPromotion = await promoteNoReplace(sourceInfo.source, ownedPaths.replacementBackup, 'REPLACEMENT_COLLISION', {
        expectedSource, removeSource: true
      });
      replacementStarted = true;
      const backupObserved = await inspectExactFile(ownedPaths.replacementBackup, operation.signal, 'REPLACEMENT_FAILED');
      ownedArtifacts.replacementBackup = artifactMetadata(ownedPaths.replacementBackup,
        ownedArtifacts.replacementBackup.nonce, backupPromotion.sourceRemoved ? 'owned' : 'cleanup-pending',
        backupObserved.stat, backupObserved.sha256, backupObserved.size);
      await persist(operation, transactionSnapshot({ phase: 'original-backed-up', ownedPaths, ownedArtifacts,
        publicationArtifact: artifact, cleanupPending: backupPromotion.sourceRemoved ? [] : ['replacementBackup'] }));
      if (!backupPromotion.sourceRemoved) throw transactionError('REPLACEMENT_FAILED');
      abortIfRequested(operation.signal);

      await readExactFile(ownedPaths.replacementCandidate, artifact, 'PUBLICATION_ARTIFACT_CHANGED');
      await persist(operation, transactionSnapshot({ step: 'replacement-promotion-intent', ownedPaths, ownedArtifacts,
        publicationArtifact: artifact }));
      const candidatePromotion = await promoteNoReplace(ownedPaths.replacementCandidate, sourceInfo.source, 'REPLACEMENT_COLLISION', {
        expectedSource: ownedArtifacts.replacementCandidate, removeSource: true
      });
      if (!candidatePromotion.sourceRemoved) ownedArtifacts.replacementCandidate.state = 'cleanup-pending';
      await persist(operation, transactionSnapshot({ phase: 'candidate-promoted', ownedPaths, ownedArtifacts,
        publicationArtifact: artifact, cleanupPending: candidatePromotion.sourceRemoved ? [] : ['replacementCandidate'] }));
      abortIfRequested(operation.signal);

      await validateReadable(sourceInfo.source, artifact, operation.verifyReadable, 'FINAL_VALIDATION_FAILED');
      await persist(operation, transactionSnapshot({ phase: 'final-validated', ownedPaths, ownedArtifacts,
        publicationArtifact: artifact }));
      abortIfRequested(operation.signal);
      await validateReadable(sourceInfo.source, artifact, null, 'FINAL_VALIDATION_FAILED');
      await removeReplacementBackup(ownedPaths.replacementBackup, ownedArtifacts.replacementBackup, sourceInfo.source, artifact);
      delete ownedPaths.replacementBackup;
      delete ownedArtifacts.replacementBackup;
      backupDeleted = true;
      const cleanupPending = [];
      if (ownedArtifacts.replacementCandidate?.state !== 'cleanup-pending') {
        delete ownedPaths.replacementCandidate;
        delete ownedArtifacts.replacementCandidate;
      }
      const snapshotCleanup = await cleanupPublicationArtifact(artifact, ownedArtifacts.publicationSnapshot);
      if (snapshotCleanup.cleaned) {
        delete ownedPaths.publicationSnapshot;
        delete ownedArtifacts.publicationSnapshot;
      } else {
        ownedArtifacts.publicationSnapshot.state = 'cleanup-pending';
        cleanupPending.push('publicationSnapshot');
      }
      if (ownedArtifacts.replacementCandidate) cleanupPending.push('replacementCandidate');
      await persist(operation, transactionSnapshot({ phase: 'backup-deleted', ownedPaths, ownedArtifacts,
        publicationArtifact: artifact, cleanupPending }));
      return { finalPath: sourceInfo.source, outputBytes: artifact.size, phase: 'backup-deleted',
        ownedPaths, ownedArtifacts, cleanupPending };
    } catch (error) {
      const failureCleanupPending = new Set();
      if (sourceInfo && ownedPaths && !backupDeleted) {
        try {
          const rollbackResult = await rollbackReplacement({
            codec: operation.codec,
            source: sourceInfo.source,
            sourceRoot: sourceInfo.sourceRoot,
            jobId,
            itemId,
            ownedPaths,
            ownedArtifacts,
            publicationArtifact: artifact,
            persistPhase: operation.persistPhase,
            persistTransaction: operation.persistTransaction,
            verifyReadable: operation.verifyReadable
          });
          if (error instanceof FileTransactionError) error.cleanupPending = rollbackResult.cleanupPending;
          rollbackCompleted = true;
        } catch (rollbackError) {
          if (rollbackError instanceof FileTransactionError && rollbackError.code === 'ROLLBACK_FAILED') {
            throw rollbackError;
          }
          const failure = transactionError('ROLLBACK_FAILED');
          failure.cleanupPending = [];
          throw failure;
        }
      } else if (ownedPaths && ownedArtifacts.replacementCandidate
          && ownedArtifacts.replacementCandidate.state !== 'intent') {
        try {
          await removeExactOwned(ownedPaths.replacementCandidate, ownedArtifacts.replacementCandidate);
          delete ownedPaths.replacementCandidate;
          delete ownedArtifacts.replacementCandidate;
        } catch (_cleanupError) {
          ownedArtifacts.replacementCandidate.state = 'cleanup-pending';
          failureCleanupPending.add('replacementCandidate');
        }
      }
      if (trusted && !replacementStarted && !rollbackCompleted && ownedArtifacts.publicationSnapshot) {
        const cleaned = await cleanupPublicationArtifact(artifact, ownedArtifacts.publicationSnapshot);
        if (cleaned.cleaned) {
          delete ownedPaths.publicationSnapshot;
          delete ownedArtifacts.publicationSnapshot;
        } else {
          ownedArtifacts.publicationSnapshot.state = 'cleanup-pending';
          failureCleanupPending.add('publicationSnapshot');
        }
      }
      if (failureCleanupPending.size) {
        const pending = [...failureCleanupPending];
        try {
          await persist(operation, transactionSnapshot({ step: 'replacement-failed-cleanup-pending', ownedPaths,
            ownedArtifacts, publicationArtifact: artifact, cleanupPending: pending }));
        } catch (_persistError) { /* primary error remains bounded */ }
        if (error instanceof FileTransactionError) {
          error.cleanupPending = pending;
        }
      }
      if (backupDeleted && sourceInfo && error instanceof FileTransactionError) {
        const pending = [...new Set([
          ...failureCleanupPending,
          ...Object.entries(ownedArtifacts).filter(([, metadata]) => metadata.state === 'cleanup-pending')
            .map(([key]) => key)
        ])];
        error.validFinal = {
          finalPath: sourceInfo.source,
          outputBytes: artifact.size,
          phase: 'backup-deleted',
          ownedPaths: { ...(ownedPaths || {}) },
          ownedArtifacts: { ...ownedArtifacts },
          cleanupPending: pending
        };
      }
      if (error instanceof FileTransactionError) throw error;
      throw transactionError('REPLACEMENT_FAILED');
    }
  }

  async function recoverReplacement(operation = {}) {
    const action = operation.action;
    const allowed = new Set([
      'backup-original', 'promote-candidate', 'validate-final', 'restart-replacement',
      'restore-backup', 'delete-backup', 'finish-replacement', 'rollback-complete',
      'manual-intervention'
    ]);
    if (!allowed.has(action)) throw transactionError('RECOVERY_ACTION_INVALID');
    if (action === 'manual-intervention') throw transactionError('MANUAL_INTERVENTION');
    if (!replacementAvailable) throw transactionError('ATOMIC_PROMOTION_UNSUPPORTED');
    const expectedSource = validateSourceAuthority(operation.expectedSource);
    const sourceInfo = await assertSourceOrMissingContained(operation.source, operation.sourceRoot);
    const artifact = normalizeArtifact(operation.publicationArtifact);
    const ownedPaths = { ...(operation.ownedPaths || {}) };
    const ownedArtifacts = { ...(operation.ownedArtifacts || {}) };
    const jobId = validateId(operation.jobId);
    const itemId = validateId(operation.itemId);
    const expectedRecoveryPaths = recordedReplacementPaths(sourceInfo.source, jobId, itemId, ownedArtifacts, operation.codec);
    const candidate = validateAbsolutePath(ownedPaths.replacementCandidate || expectedRecoveryPaths?.replacementCandidate, pathApi);
    const backup = validateAbsolutePath(ownedPaths.replacementBackup || expectedRecoveryPaths?.replacementBackup, pathApi);
    const persistedArtifact = ownedPaths.publicationSnapshot
      && samePath(ownedPaths.publicationSnapshot, artifact.path, pathApi, platform) ? artifact : null;
    assertReplacementNames(sourceInfo.source, candidate, backup, jobId, itemId, ownedArtifacts, operation.codec);
    if (persistedArtifact && !ownedArtifacts.publicationSnapshot) throw transactionError('INVALID_PUBLICATION_ARTIFACT');
    await validatePublicationCapability(artifact, 'reconcile', artifact);

    if (action === 'backup-original') {
      await assertSourceAuthority(sourceInfo.source, expectedSource, operation.signal);
      if (!await lstatOrNull(sourceInfo.source) || await lstatOrNull(backup)) throw transactionError('MANUAL_INTERVENTION');
      if (ownedArtifacts.replacementBackup?.state !== 'intent'
          || !samePath(ownedArtifacts.replacementBackup.path, backup, pathApi, platform)) {
        throw transactionError('UNSAFE_OWNED_PATH');
      }
      await persist(operation, transactionSnapshot({ step: 'recovery-backup-intent', ownedPaths, ownedArtifacts,
        publicationArtifact: persistedArtifact }));
      const promotion = await promoteNoReplace(sourceInfo.source, backup, 'REPLACEMENT_COLLISION', {
        expectedSource,
        removeSource: true
      });
      const observed = await inspectExactFile(backup, operation.signal, 'REPLACEMENT_FAILED');
      ownedArtifacts.replacementBackup = artifactMetadata(backup, ownedArtifacts.replacementBackup.nonce,
        promotion.sourceRemoved ? 'owned' : 'cleanup-pending', observed.stat, observed.sha256, observed.size);
      await persist(operation, transactionSnapshot({ phase: 'original-backed-up', ownedPaths, ownedArtifacts,
        publicationArtifact: persistedArtifact }));
      return { phase: 'original-backed-up', ownedPaths, ownedArtifacts };
    }
    if (action === 'promote-candidate') {
      if (!ownedArtifacts.replacementCandidate) throw transactionError('UNSAFE_OWNED_PATH');
      if (await lstatOrNull(sourceInfo.source)) throw transactionError('MANUAL_INTERVENTION');
      await completeRecoveredCopy({
        operation,
        artifact,
        target: candidate,
        field: 'replacementCandidate',
        stepPrefix: 'recovery-candidate',
        ownedPaths,
        ownedArtifacts,
        failureCode: 'PUBLICATION_ARTIFACT_CHANGED'
      });
      await persist(operation, transactionSnapshot({ step: 'recovery-promotion-intent', ownedPaths, ownedArtifacts,
        publicationArtifact: persistedArtifact }));
      const promotion = await promoteNoReplace(candidate, sourceInfo.source, 'REPLACEMENT_COLLISION', {
        expectedSource: ownedArtifacts.replacementCandidate,
        removeSource: true
      });
      if (!promotion.sourceRemoved) ownedArtifacts.replacementCandidate.state = 'cleanup-pending';
      await persist(operation, transactionSnapshot({ phase: 'candidate-promoted', ownedPaths, ownedArtifacts,
        publicationArtifact: persistedArtifact }));
      return { phase: 'candidate-promoted', ownedPaths, ownedArtifacts };
    }
    if (action === 'validate-final') {
      try {
        await validateReadable(sourceInfo.source, artifact, operation.verifyReadable, 'FINAL_VALIDATION_FAILED');
        await persist(operation, transactionSnapshot({ phase: 'final-validated', ownedPaths, ownedArtifacts,
          publicationArtifact: persistedArtifact }));
        return { phase: 'final-validated', ownedPaths, ownedArtifacts };
      } catch (error) {
        await rollbackReplacement({ ...operation, source: sourceInfo.source, sourceRoot: sourceInfo.sourceRoot,
          ownedPaths, ownedArtifacts, publicationArtifact: artifact });
        throw error;
      }
    }
    if (action === 'delete-backup') {
      await validateReadable(sourceInfo.source, artifact, operation.verifyReadable, 'FINAL_VALIDATION_FAILED');
      await readExactFile(sourceInfo.source, artifact, 'FINAL_VALIDATION_FAILED');
      await persist(operation, transactionSnapshot({ step: 'recovery-delete-backup-intent', ownedPaths, ownedArtifacts,
        publicationArtifact: persistedArtifact }));
      const cleanupPending = [];
      try {
        await removeReplacementBackup(backup, ownedArtifacts.replacementBackup, sourceInfo.source, artifact);
        delete ownedPaths.replacementBackup;
        delete ownedArtifacts.replacementBackup;
      } catch (cleanupError) {
        if (!(cleanupError instanceof FileTransactionError) || cleanupError.code !== 'OWNED_CLEANUP_FAILED') throw cleanupError;
        ownedArtifacts.replacementBackup.state = 'cleanup-pending';
        cleanupPending.push('replacementBackup');
      }
      if (persistedArtifact) {
        const cleaned = await cleanupPublicationArtifact(persistedArtifact, ownedArtifacts.publicationSnapshot);
        if (cleaned.cleaned) {
          delete ownedPaths.publicationSnapshot;
          delete ownedArtifacts.publicationSnapshot;
        } else {
          ownedArtifacts.publicationSnapshot.state = 'cleanup-pending';
          cleanupPending.push('publicationSnapshot');
        }
      }
      delete ownedPaths.replacementCandidate;
      delete ownedArtifacts.replacementCandidate;
      const phase = ownedArtifacts.replacementBackup ? 'final-validated' : 'backup-deleted';
      await persist(operation, transactionSnapshot({ phase, ownedPaths, ownedArtifacts,
        publicationArtifact: persistedArtifact, cleanupPending }));
      return { phase, ownedPaths, ownedArtifacts, cleanupPending };
    }
    if (action === 'restore-backup') {
      return rollbackReplacement({ ...operation, source: sourceInfo.source, sourceRoot: sourceInfo.sourceRoot,
        ownedPaths, ownedArtifacts, publicationArtifact: artifact });
    }
    if (action === 'restart-replacement') {
      await persist(operation, transactionSnapshot({ step: 'restart-replacement-cleanup-intent', ownedPaths, ownedArtifacts,
        publicationArtifact: persistedArtifact }));
      const cleanupPending = [];
      if (await lstatOrNull(candidate)) {
        try {
          await removeExactOwned(candidate, ownedArtifacts.replacementCandidate, { allowMissing: false });
          delete ownedPaths.replacementCandidate;
          delete ownedArtifacts.replacementCandidate;
        } catch (cleanupError) {
          if (!(cleanupError instanceof FileTransactionError) || cleanupError.code !== 'OWNED_CLEANUP_FAILED') throw cleanupError;
          ownedArtifacts.replacementCandidate.state = 'cleanup-pending';
          cleanupPending.push('replacementCandidate');
        }
      } else {
        delete ownedPaths.replacementCandidate;
        delete ownedArtifacts.replacementCandidate;
      }
      if (!await lstatOrNull(sourceInfo.source) || await lstatOrNull(backup)) throw transactionError('MANUAL_INTERVENTION');
      delete ownedPaths.replacementBackup;
      delete ownedArtifacts.replacementBackup;
      if (persistedArtifact) {
        const cleaned = await cleanupPublicationArtifact(persistedArtifact, ownedArtifacts.publicationSnapshot);
        if (cleaned.cleaned) {
          delete ownedPaths.publicationSnapshot;
          delete ownedArtifacts.publicationSnapshot;
        } else {
          ownedArtifacts.publicationSnapshot.state = 'cleanup-pending';
          cleanupPending.push('publicationSnapshot');
        }
      }
      const step = cleanupPending.length ? 'restart-replacement-cleanup-pending' : 'restart-replacement';
      await persist(operation, transactionSnapshot({ step, ownedPaths, ownedArtifacts,
        publicationArtifact: persistedArtifact, cleanupPending }));
      return { action: 'restart-replacement', ownedPaths, ownedArtifacts,
        publicationArtifact: ownedArtifacts.publicationSnapshot ? artifact : null, cleanupPending };
    }
    if (action === 'rollback-complete') {
      if (!await lstatOrNull(sourceInfo.source) || await lstatOrNull(backup)) throw transactionError('MANUAL_INTERVENTION');
      await persist(operation, transactionSnapshot({ step: 'rollback-complete-cleanup-intent', ownedPaths, ownedArtifacts,
        publicationArtifact: persistedArtifact }));
      delete ownedPaths.replacementBackup;
      delete ownedArtifacts.replacementBackup;
      const cleanupPending = [];
      if (await lstatOrNull(candidate)) {
        try {
          await removeExactOwned(candidate, ownedArtifacts.replacementCandidate, { allowMissing: false });
        } catch (cleanupError) {
          if (!(cleanupError instanceof FileTransactionError) || cleanupError.code !== 'OWNED_CLEANUP_FAILED') throw cleanupError;
          ownedArtifacts.replacementCandidate.state = 'cleanup-pending';
          cleanupPending.push('replacementCandidate');
        }
      }
      if (persistedArtifact) {
        const cleaned = await cleanupPublicationArtifact(persistedArtifact, ownedArtifacts.publicationSnapshot);
        if (cleaned.cleaned) {
          delete ownedPaths.publicationSnapshot;
          delete ownedArtifacts.publicationSnapshot;
        } else {
          ownedArtifacts.publicationSnapshot.state = 'cleanup-pending';
          cleanupPending.push('publicationSnapshot');
        }
      }
      if (!cleanupPending.includes('replacementCandidate')) {
        delete ownedPaths.replacementCandidate;
        delete ownedArtifacts.replacementCandidate;
      }
      await persist(operation, transactionSnapshot({ phase: 'backup-restored', ownedPaths, ownedArtifacts,
        publicationArtifact: persistedArtifact, cleanupPending }));
      return { phase: 'backup-restored', ownedPaths, ownedArtifacts, cleanupPending };
    }
    if (action === 'finish-replacement') {
      await validateReadable(sourceInfo.source, artifact, operation.verifyReadable, 'FINAL_VALIDATION_FAILED');
      await persist(operation, transactionSnapshot({ step: 'recovery-finish-cleanup-intent', ownedPaths, ownedArtifacts,
        publicationArtifact: persistedArtifact }));
      const cleanupPending = [];
      if (await lstatOrNull(backup)) {
        await readExactFile(backup, ownedArtifacts.replacementBackup, 'UNSAFE_OWNED_PATH');
        try {
          await removeReplacementBackup(backup, ownedArtifacts.replacementBackup, sourceInfo.source, artifact);
          delete ownedPaths.replacementBackup;
          delete ownedArtifacts.replacementBackup;
        } catch (cleanupError) {
          if (!(cleanupError instanceof FileTransactionError) || cleanupError.code !== 'OWNED_CLEANUP_FAILED') throw cleanupError;
          ownedArtifacts.replacementBackup.state = 'cleanup-pending';
          cleanupPending.push('replacementBackup');
        }
      } else {
        delete ownedPaths.replacementBackup;
        delete ownedArtifacts.replacementBackup;
      }
      if (await lstatOrNull(candidate)) {
        const finalStat = await exactLstat(sourceInfo.source);
        const candidateStat = await exactLstat(candidate);
        if (!sameIdentity(finalStat, candidateStat)) throw transactionError('MANUAL_INTERVENTION');
        await readExactFile(candidate, ownedArtifacts.replacementCandidate, 'UNSAFE_OWNED_PATH');
        try {
          await removeExactOwned(candidate, ownedArtifacts.replacementCandidate, { allowMissing: false });
          delete ownedPaths.replacementCandidate;
          delete ownedArtifacts.replacementCandidate;
        } catch (cleanupError) {
          if (!(cleanupError instanceof FileTransactionError) || cleanupError.code !== 'OWNED_CLEANUP_FAILED') throw cleanupError;
          ownedArtifacts.replacementCandidate.state = 'cleanup-pending';
          cleanupPending.push('replacementCandidate');
        }
      } else {
        delete ownedPaths.replacementCandidate;
        delete ownedArtifacts.replacementCandidate;
      }
      if (persistedArtifact) {
        const cleaned = await cleanupPublicationArtifact(persistedArtifact, ownedArtifacts.publicationSnapshot);
        if (cleaned.cleaned) {
          delete ownedPaths.publicationSnapshot;
          delete ownedArtifacts.publicationSnapshot;
        } else {
          ownedArtifacts.publicationSnapshot.state = 'cleanup-pending';
          cleanupPending.push('publicationSnapshot');
        }
      }
      await persist(operation, transactionSnapshot({ phase: 'backup-deleted', ownedPaths, ownedArtifacts,
        publicationArtifact: persistedArtifact, cleanupPending }));
      return { phase: 'backup-deleted', ownedPaths, ownedArtifacts, cleanupPending };
    }
    await validateReadable(sourceInfo.source, artifact, operation.verifyReadable, 'FINAL_VALIDATION_FAILED');
    if (await lstatOrNull(backup) || await lstatOrNull(candidate)) throw transactionError('MANUAL_INTERVENTION');
    if (persistedArtifact) {
      const cleaned = await cleanupPublicationArtifact(persistedArtifact, ownedArtifacts.publicationSnapshot);
      if (!cleaned.cleaned) throw transactionError('PUBLICATION_CLEANUP_FAILED');
      delete ownedPaths.publicationSnapshot;
      delete ownedArtifacts.publicationSnapshot;
    }
    await persist(operation, transactionSnapshot({ phase: 'backup-deleted', ownedPaths, ownedArtifacts }));
    return { phase: 'backup-deleted', ownedPaths, ownedArtifacts };
  }

  async function recoverCopy(operation = {}) {
    const allowed = new Set(['restart-copy', 'resume-copy', 'finalize-copy']);
    if (!allowed.has(operation.action)) throw transactionError('RECOVERY_ACTION_INVALID');
    const destination = validateAbsolutePath(operation.destination, pathApi);
    if (operation.action === 'restart-copy') {
      if (Object.keys(operation.ownedPaths || {}).length || Object.keys(operation.ownedArtifacts || {}).length) {
        throw transactionError('MANUAL_INTERVENTION');
      }
      return { action: 'restart-copy', destination };
    }
    const jobId = validateId(operation.jobId);
    const itemId = validateId(operation.itemId);
    const artifact = normalizeArtifact(operation.publicationArtifact);
    const ownedPaths = { ...(operation.ownedPaths || {}) };
    const ownedArtifacts = { ...(operation.ownedArtifacts || {}) };
    const expectedPartial = publicationPaths(destination, jobId, itemId,
      ownedArtifacts.destinationPartial?.nonce).destinationPartial;
    if (!samePath(ownedPaths.destinationPartial, expectedPartial, pathApi, platform)
        || !samePath(ownedPaths.publicationSnapshot, artifact.path, pathApi, platform)
        || !ownedArtifacts.destinationPartial || !ownedArtifacts.publicationSnapshot) {
      throw transactionError('UNSAFE_OWNED_PATH');
    }
    await validatePublicationCapability(artifact, 'reconcile', artifact);
    let promotionCleanupPending = false;
    let promoted = false;
    let finalVerified = false;
    if (operation.action === 'resume-copy') {
      if (await lstatOrNull(destination)) throw transactionError('DESTINATION_COLLISION');
      await completeRecoveredCopy({
        operation,
        artifact,
        target: expectedPartial,
        field: 'destinationPartial',
        stepPrefix: 'copy-recovery-partial',
        ownedPaths,
        ownedArtifacts,
        failureCode: 'PUBLICATION_ARTIFACT_CHANGED'
      });
      await persist(operation, transactionSnapshot({ step: 'copy-recovery-promotion-intent', ownedPaths, ownedArtifacts,
        publicationArtifact: artifact }));
      const promotion = await promoteNoReplace(expectedPartial, destination, 'DESTINATION_COLLISION', {
        expectedSource: ownedArtifacts.destinationPartial
      });
      promoted = true;
      if (!promotion.sourceRemoved) {
        ownedArtifacts.destinationPartial.state = 'cleanup-pending';
        promotionCleanupPending = true;
      }
    } else {
      await validateReadable(destination, artifact, operation.verifyReadable, 'DESTINATION_VALIDATION_FAILED');
      finalVerified = true;
      const partialStat = await exactLstat(expectedPartial).catch(() => null);
      if (partialStat) {
        const finalStat = await exactLstat(destination);
        if (!sameIdentity(partialStat, finalStat)) throw transactionError('MANUAL_INTERVENTION');
      }
    }
    try {
      await validateReadable(destination, artifact, operation.verifyReadable, 'DESTINATION_VALIDATION_FAILED');
      finalVerified = true;
      await persist(operation, transactionSnapshot({ step: 'copy-recovery-cleanup-intent', ownedPaths, ownedArtifacts,
        publicationArtifact: artifact }));
      if (!promotionCleanupPending && await lstatOrNull(expectedPartial)) {
        await readExactFile(expectedPartial, ownedArtifacts.destinationPartial, 'UNSAFE_OWNED_PATH');
        try {
          await removeExactOwned(expectedPartial, ownedArtifacts.destinationPartial, { allowMissing: false });
        } catch (cleanupError) {
          if (!(cleanupError instanceof FileTransactionError) || cleanupError.code !== 'OWNED_CLEANUP_FAILED') throw cleanupError;
          ownedArtifacts.destinationPartial.state = 'cleanup-pending';
          promotionCleanupPending = true;
        }
      }
      if (!promotionCleanupPending) {
        delete ownedPaths.destinationPartial;
        delete ownedArtifacts.destinationPartial;
      }
      const cleaned = await cleanupPublicationArtifact(artifact, ownedArtifacts.publicationSnapshot);
      if (cleaned.cleaned) {
        delete ownedPaths.publicationSnapshot;
        delete ownedArtifacts.publicationSnapshot;
      } else ownedArtifacts.publicationSnapshot.state = 'cleanup-pending';
      const cleanupPending = [];
      if (promotionCleanupPending) cleanupPending.push('destinationPartial');
      if (ownedArtifacts.publicationSnapshot) cleanupPending.push('publicationSnapshot');
      await persist(operation, transactionSnapshot({ step: cleanupPending.length ? 'copy-complete-cleanup-pending' : 'copy-complete',
        ownedPaths, ownedArtifacts, publicationArtifact: artifact, cleanupPending }));
      return { finalPath: destination, ownedPaths, ownedArtifacts, cleanupPending };
    } catch (error) {
      const failureCleanupPending = new Set();
      if (promoted && !finalVerified) {
        try {
          await removeExactOwned(destination, ownedArtifacts.destinationPartial, { allowIdentityAlias: true });
        } catch (_cleanupError) {
          ownedArtifacts.destinationPartial.state = 'cleanup-pending';
          failureCleanupPending.add('destinationPartial');
        }
        if (!failureCleanupPending.has('destinationPartial') && await lstatOrNull(expectedPartial)) {
          try {
            await removeExactOwned(expectedPartial, ownedArtifacts.destinationPartial);
            delete ownedPaths.destinationPartial;
            delete ownedArtifacts.destinationPartial;
          } catch (_cleanupError) {
            ownedArtifacts.destinationPartial.state = 'cleanup-pending';
            failureCleanupPending.add('destinationPartial');
          }
        }
      }
      const snapshotCleanup = await cleanupPublicationArtifact(artifact, ownedArtifacts.publicationSnapshot);
      if (!snapshotCleanup.cleaned) {
        ownedArtifacts.publicationSnapshot.state = 'cleanup-pending';
        failureCleanupPending.add('publicationSnapshot');
      } else {
        delete ownedPaths.publicationSnapshot;
        delete ownedArtifacts.publicationSnapshot;
      }
      if (failureCleanupPending.size) {
        const pending = [...failureCleanupPending];
        try {
          await persist(operation, transactionSnapshot({ step: 'copy-recovery-failed-cleanup-pending', ownedPaths,
            ownedArtifacts, publicationArtifact: artifact, cleanupPending: pending }));
        } catch (_persistError) { /* primary recovery error remains bounded */ }
        if (error instanceof FileTransactionError) {
          error.cleanupPending = pending;
        }
      }
      throw error;
    }
  }

  async function cleanupOwnedArtifacts(operation = {}) {
    const jobId = validateId(operation.jobId);
    const itemId = validateId(operation.itemId);
    const ownedPaths = operation.ownedPaths;
    const ownedArtifacts = operation.ownedArtifacts;
    if (!ownedPaths || typeof ownedPaths !== 'object' || Array.isArray(ownedPaths)
        || !ownedArtifacts || typeof ownedArtifacts !== 'object' || Array.isArray(ownedArtifacts)
        || Object.keys(ownedPaths).some((key) => !OWNED_PATH_FIELDS.has(key))
        || Object.keys(ownedArtifacts).some((key) => !OWNED_PATH_FIELDS.has(key))
        || Object.keys(ownedPaths).some((key) => !ownedArtifacts[key] || ownedArtifacts[key].path !== ownedPaths[key])) {
      throw transactionError('INVALID_TRANSACTION_INPUT');
    }
    const artifact = operation.publicationArtifact ? normalizeArtifact(operation.publicationArtifact) : null;
    const source = operation.source ? validateAbsolutePath(operation.source, pathApi) : null;
    const sourceRoot = operation.sourceRoot ? validateAbsolutePath(operation.sourceRoot, pathApi) : null;
    const realTempRoot = await canonicalExisting(tempRoot);

    // Cleanup is called after the transaction has stopped using these paths.
    // Release the in-process leases before the first persistence boundary so a
    // store failure cannot strand the manager in STAGING_BUSY for every later
    // queued item. This does not delete anything or bypass ownership checks.
    // Keep the staged-source lease until the cleanup intent/pending journal
    // boundary is durable. Some staging modes deliberately retain that lease
    // while recovery is still possible. The encoded candidate, however, is
    // never an input to a later operation once cleanup starts and must not be
    // stranded if the first journal write fails.
    for (const field of ['encodedCandidate']) {
      if (ownedPaths[field]) releaseOwnedLease(ownedPaths[field]);
    }

    await persist(operation, transactionSnapshot({ step: 'owned-cleanup-intent', ownedPaths, ownedArtifacts,
      publicationArtifact: artifact }));

    const cleanupPending = [];
    for (const [field, rawTarget] of Object.entries(ownedPaths)) {
      // The backup may be the last original. Only replacement-specific
      // recovery may remove it after proving a validated final or restoration.
      if (field === 'replacementBackup') {
        cleanupPending.push(field);
        continue;
      }
      const target = validateAbsolutePath(rawTarget, pathApi);
      if (field === 'publicationSnapshot') {
        if (!artifact || !samePath(target, artifact.path, pathApi, platform)) throw transactionError('UNSAFE_OWNED_PATH');
        await validatePublicationCapability(artifact, 'reconcile', artifact);
        const cleaned = await cleanupPublicationArtifact(artifact, ownedArtifacts[field]);
        if (!cleaned.cleaned) {
          ownedArtifacts[field].state = 'cleanup-pending';
          cleanupPending.push(field);
        }
        continue;
      }
      if (field === 'stagedSource' || field === 'encodedCandidate') {
        const canonical = await canonicalForNew(target);
        const expectedPrefix = `${jobId}-${itemId}-${ownedArtifacts[field].nonce}-`;
        if (!isContained(realTempRoot, canonical, pathApi, platform) || !pathApi.basename(target).startsWith(expectedPrefix)) {
          throw transactionError('UNSAFE_OWNED_PATH');
        }
      } else if (field === 'destinationPartial') {
        const suffix = `.sentry-six-${jobId}-${itemId}-${ownedArtifacts[field].nonce}.partial`;
        if (!target.endsWith(suffix)) throw transactionError('UNSAFE_OWNED_PATH');
        const expected = publicationPaths(target.slice(0, -suffix.length), jobId, itemId,
          ownedArtifacts[field].nonce).destinationPartial;
        if (!samePath(expected, target, pathApi, platform)) throw transactionError('UNSAFE_OWNED_PATH');
      } else {
        if (!source || !sourceRoot) throw transactionError('UNSAFE_OWNED_PATH');
        await assertSourceOrMissingContained(source, sourceRoot);
        const expected = recordedReplacementPaths(source, jobId, itemId, ownedArtifacts, operation.codec)[field];
        if (!expected || !samePath(expected, target, pathApi, platform)) throw transactionError('UNSAFE_OWNED_PATH');
      }
      try {
        await removeExactOwned(target, ownedArtifacts[field]);
      } catch (cleanupError) {
        if (!(cleanupError instanceof FileTransactionError) || cleanupError.code !== 'OWNED_CLEANUP_FAILED') throw cleanupError;
        ownedArtifacts[field].state = 'cleanup-pending';
        cleanupPending.push(field);
      }
    }
    if (cleanupPending.length) {
      await persist(operation, transactionSnapshot({ step: 'owned-cleanup-pending', ownedPaths, ownedArtifacts,
        publicationArtifact: artifact, cleanupPending }));
      for (const field of cleanupPending) {
        if (field === 'stagedSource' || field === 'encodedCandidate') releaseOwnedLease(ownedPaths[field]);
      }
      return { cleaned: false, cleanupPending, ownedPaths, ownedArtifacts };
    }
    await persist(operation, transactionSnapshot({
      step: 'owned-cleanup-complete', ownedPaths: {}, ownedArtifacts: {}, clearOwnedKeys: Object.keys(ownedPaths)
    }));
    return { cleaned: true };
  }

  return Object.freeze({
    capabilities,
    captureSource,
    reserveEncodeOutput,
    adoptEncodeOutput,
    copyAsset,
    stageSource,
    publishSeparate,
    replaceOriginal,
    rollbackReplacement,
    recoverReplacement,
    recoverCopy,
    cleanupOwnedArtifacts
  });
}

module.exports = {
  FileTransactionError,
  classifyPath,
  chooseStagingMode,
  checkStagingSpace,
  createFileTransaction
};
