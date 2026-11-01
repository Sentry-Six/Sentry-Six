'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SNAPSHOT_PREFIX = 'sentry-six-verification-';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function validDigest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

async function removeSnapshotFile(directory, snapshotPath) {
  let firstError = null;
  try {
    await fs.promises.chmod(snapshotPath, 0o600);
  } catch (error) {
    if (error?.code !== 'ENOENT') firstError = error;
  }
  try {
    await fs.promises.unlink(snapshotPath);
  } catch (error) {
    if (error?.code !== 'ENOENT' && !firstError) firstError = error;
  }
  try {
    await fs.promises.rmdir(directory);
  } catch (error) {
    if (error?.code !== 'ENOENT' && !firstError) firstError = error;
  }
  if (firstError) throw firstError;
}

async function createVerificationSnapshot({ bytes, size = bytes?.length, sha256: expectedSha256 = bytes && sha256(bytes), tempRoot = os.tmpdir() } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new TypeError('Snapshot bytes must be a non-empty Buffer');
  if (!Number.isSafeInteger(size) || size !== bytes.length) throw new TypeError('Snapshot size must match its bytes');
  if (!validDigest(expectedSha256) || expectedSha256 !== sha256(bytes)) throw new TypeError('Snapshot digest must match its bytes');
  if (typeof tempRoot !== 'string' || !path.isAbsolute(tempRoot)) throw new TypeError('Snapshot temporary root must be absolute');

  const token = crypto.randomUUID();
  let directory;
  let snapshotPath;
  let handle;
  try {
    directory = await fs.promises.mkdtemp(path.join(tempRoot, SNAPSHOT_PREFIX));
    await fs.promises.chmod(directory, 0o700);
    snapshotPath = path.join(directory, `${token}.mp4`);
    handle = await fs.promises.open(snapshotPath, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.chmod(snapshotPath, 0o400);
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch (_closeError) { /* Continue the bounded cleanup attempt. */ }
    }
    try {
      if (directory && snapshotPath) await removeSnapshotFile(directory, snapshotPath);
      else if (directory) await fs.promises.rmdir(directory);
    } catch (_cleanupError) { /* The creation error remains authoritative; no private path is exposed. */ }
    throw error;
  }

  let cleaned = false;
  let transferred = false;
  const read = async () => {
    if (cleaned) throw new Error('Snapshot is no longer available');
    const persisted = await fs.promises.readFile(snapshotPath);
    if (persisted.length !== size || sha256(persisted) !== expectedSha256) throw new Error('Snapshot integrity check failed');
    return persisted;
  };
  const cleanup = async () => {
    if (cleaned) return;
    await removeSnapshotFile(directory, snapshotPath);
    cleaned = true;
  };
  const transfer = async () => {
    if (cleaned) throw new Error('Snapshot is no longer available');
    await read();
    transferred = true;
    return Object.freeze({ path: snapshotPath, token });
  };

  return Object.freeze({
    path: snapshotPath,
    token,
    size,
    sha256: expectedSha256,
    read,
    cleanup,
    transfer,
    get transferred() { return transferred; }
  });
}

module.exports = { createVerificationSnapshot };
