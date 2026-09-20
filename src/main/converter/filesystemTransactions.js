'use strict';

const nodeFs = require('fs');
const { removeWindowsOwned, renameWindowsOwned } = require('./windowsOwnedCleanup');

function statPart(value) {
  if (typeof value === 'bigint') return value >= 0n ? value.toString() : null;
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
}

function matchesExpected(stat, expected) {
  if (!stat || !expected || typeof stat.isFile !== 'function' || !stat.isFile()
      || (typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink())) return false;
  return statPart(stat.dev) === expected.device
    && statPart(stat.ino) === expected.inode
    && Number(stat.size) === expected.size;
}

function createFilesystemTransactionAdapters(options = {}) {
  const fileSystem = options.fs || nodeFs;
  const pfs = fileSystem.promises || fileSystem;

  const platform = options.platform || process.platform;
  const nativeWindows = platform === 'win32' && process.platform === 'win32' && fileSystem === nodeFs;
  const removeOwned = nativeWindows ? Object.freeze({
    atomicOwnershipCheck: true,
    guardedRemoval: true,
    remove: removeWindowsOwned
  }) : Object.freeze({
    // Node has no unlink-if-file-identity-matches primitive. A prior lstat
    // cannot authorize deleting a subsequently resolved directory entry.
    atomicOwnershipCheck: false,
    async remove() {
      return { removed: false, failed: true, unsupported: true };
    }
  });

  const renameExclusive = Object.freeze({
    atomicNoReplace: true,
    atomicExpectedOwnership: nativeWindows,
    async promote({ from, to, expectedSource, removeSource = false }) {
      if (removeSource && nativeWindows) return renameWindowsOwned({ from, to, expectedSource });
      // Refuse BEFORE creating even a destination link. An ambiguous unlink
      // response must never lead to deletion of the remaining original copy.
      if (removeSource) throw Object.assign(new Error('Conditional source removal is unavailable.'), {
        code: 'ATOMIC_PROMOTION_UNSUPPORTED'
      });
      const sourceBefore = await pfs.lstat(from, { bigint: true });
      if (!matchesExpected(sourceBefore, expectedSource)) {
        return { atomicNoReplace: true, sourceRemoved: false, ownershipMismatch: true };
      }

      await pfs.link(from, to);
      return { atomicNoReplace: true, sourceRemoved: false };
    }
  });

  return Object.freeze({ removeOwned, renameExclusive });
}

module.exports = { createFilesystemTransactionAdapters };
