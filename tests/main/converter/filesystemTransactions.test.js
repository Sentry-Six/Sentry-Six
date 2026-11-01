'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  createFilesystemTransactionAdapters
} = require('../../../src/main/converter/filesystemTransactions');

describe('production filesystem transaction adapters', () => {
  let root;

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sentry-six-fs-tx-'));
  });

  afterEach(async () => {
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  async function expectedFor(target) {
    const stat = await fs.promises.lstat(target, { bigint: true });
    return { device: String(stat.dev), inode: String(stat.ino), size: Number(stat.size),
      sha256: crypto.createHash('sha256').update(await fs.promises.readFile(target)).digest('hex') };
  }

  const nativeTest = process.platform === 'win32' ? test : test.skip;

  nativeTest('renames the verified handle exclusively including Unicode names', async () => {
    const from = path.join(root, '候选-é.mp4');
    const to = path.join(root, '最终-é.mp4');
    await fs.promises.writeFile(from, 'candidate');
    const adapter = createFilesystemTransactionAdapters({ fs }).renameExclusive;
    expect(await adapter.promote({ from, to, expectedSource: await expectedFor(from), removeSource: true }))
      .toMatchObject({ atomicNoReplace: true, sourceRemoved: true });
    expect(fs.existsSync(from)).toBe(false);
    expect(await fs.promises.readFile(to, 'utf8')).toBe('candidate');
  }, 20000);

  nativeTest.each(['collision', 'identity', 'contents'])('native rename refuses %s', async (kind) => {
    const from = path.join(root, 'candidate.mp4');
    const to = path.join(root, 'final.mp4');
    await fs.promises.writeFile(from, 'candidate');
    const expectedSource = await expectedFor(from);
    if (kind === 'collision') await fs.promises.writeFile(to, 'original');
    if (kind === 'identity') {
      await fs.promises.rename(from, path.join(root, 'retained.mp4'));
      await fs.promises.writeFile(from, 'candidate');
    }
    if (kind === 'contents') await fs.promises.writeFile(from, 'different');
    const operation = createFilesystemTransactionAdapters({ fs }).renameExclusive.promote({ from, to, expectedSource, removeSource: true });
    if (kind === 'collision') await expect(operation).rejects.toMatchObject({ code: 'EEXIST' });
    else expect(await operation).toMatchObject({ sourceRemoved: false, ownershipMismatch: true });
    expect(fs.existsSync(from)).toBe(true);
    expect(fs.existsSync(to)).toBe(kind === 'collision');
  }, 20000);

  nativeTest.each(['valid', 'mismatch', 'missing'])('guards backup deletion with %s final', async (kind) => {
    const target = path.join(root, 'backup.mp4');
    const final = path.join(root, 'final.mp4');
    await fs.promises.writeFile(target, 'original');
    await fs.promises.writeFile(final, 'converted');
    const guard = { target: final, expected: await expectedFor(final) };
    if (kind === 'mismatch') await fs.promises.writeFile(final, 'different');
    if (kind === 'missing') await fs.promises.unlink(final);
    const result = await createFilesystemTransactionAdapters({ fs }).removeOwned.remove({ target, expected: await expectedFor(target), guard });
    expect(result.removed).toBe(kind === 'valid');
    expect(fs.existsSync(target)).toBe(kind !== 'valid');
  }, 20000);

  test('publishes without replacing an existing target and retains the expected source', async () => {
    const from = path.join(root, 'candidate.mp4');
    const to = path.join(root, 'original.mp4');
    await fs.promises.writeFile(from, 'converted');
    const adapters = createFilesystemTransactionAdapters({ fs });

    const result = await adapters.renameExclusive.promote({
      from,
      to,
      expectedSource: await expectedFor(from),
      removeSource: false
    });

    await expect(fs.promises.readFile(to, 'utf8')).resolves.toBe('converted');
    await expect(fs.promises.readFile(from, 'utf8')).resolves.toBe('converted');
    expect(result).toEqual({ atomicNoReplace: true, sourceRemoved: false });
  });

  nativeTest('native promotion rejects cross-directory and alternate-stream destinations before mutation', async () => {
    const from = path.join(root, 'candidate.mp4');
    await fs.promises.writeFile(from, 'candidate');
    const expectedSource = await expectedFor(from);
    for (const to of [path.join(root, 'other', 'final.mp4'), `${from}:stream`]) {
      await expect(createFilesystemTransactionAdapters({ fs }).renameExclusive.promote({ from, to, expectedSource, removeSource: true }))
        .rejects.toMatchObject({ code: 'ENOTSUP' });
    }
    expect(await fs.promises.readFile(from, 'utf8')).toBe('candidate');
  });

  nativeTest('refuses to rename a symlink to the expected source', async () => {
    const actual = path.join(root, 'actual.mp4');
    const from = path.join(root, 'link.mp4');
    const to = path.join(root, 'final.mp4');
    await fs.promises.writeFile(actual, 'candidate');
    try { await fs.promises.symlink(actual, from, 'file'); }
    catch (error) {
      if (error.code === 'EPERM') return; // Windows hosts without symlink privilege.
      throw error;
    }
    const result = await createFilesystemTransactionAdapters({ fs }).renameExclusive.promote({ from, to, expectedSource: await expectedFor(actual), removeSource: true });
    expect(result).toMatchObject({ ownershipMismatch: true, sourceRemoved: false });
    expect(fs.existsSync(to)).toBe(false);
    expect(await fs.promises.readFile(actual, 'utf8')).toBe('candidate');
  }, 20000);

  nativeTest('renaming one hardlink retains the other link and its data', async () => {
    const from = path.join(root, 'candidate.mp4');
    const sibling = path.join(root, 'sibling.mp4');
    const to = path.join(root, 'final.mp4');
    await fs.promises.writeFile(from, 'candidate');
    await fs.promises.link(from, sibling);
    await createFilesystemTransactionAdapters({ fs }).renameExclusive.promote({ from, to, expectedSource: await expectedFor(from), removeSource: true });
    expect(fs.existsSync(from)).toBe(false);
    expect(await fs.promises.readFile(sibling, 'utf8')).toBe('candidate');
    expect(await fs.promises.readFile(to, 'utf8')).toBe('candidate');
  }, 20000);

  nativeTest('refuses native rename while another writer owns the source', async () => {
    const from = path.join(root, 'candidate.mp4');
    const to = path.join(root, 'final.mp4');
    await fs.promises.writeFile(from, 'candidate');
    const expectedSource = await expectedFor(from);
    const writer = await fs.promises.open(from, 'r+');
    try {
      await expect(createFilesystemTransactionAdapters({ fs }).renameExclusive.promote({ from, to, expectedSource, removeSource: true }))
        .rejects.toMatchObject({ code: 'EACCES' });
      expect(fs.existsSync(to)).toBe(false);
      expect(await fs.promises.readFile(from, 'utf8')).toBe('candidate');
    } finally { await writer.close(); }
  }, 20000);

  nativeTest('retains the backup when the final has an active writer', async () => {
    const target = path.join(root, 'backup.mp4');
    const final = path.join(root, 'final.mp4');
    await fs.promises.writeFile(target, 'original');
    await fs.promises.writeFile(final, 'converted');
    const expected = await expectedFor(target);
    const guard = { target: final, expected: await expectedFor(final) };
    const writer = await fs.promises.open(final, 'r+');
    try {
      await expect(createFilesystemTransactionAdapters({ fs }).removeOwned.remove({ target, expected, guard }))
        .rejects.toMatchObject({ code: 'EACCES' });
      expect(await fs.promises.readFile(target, 'utf8')).toBe('original');
    } finally { await writer.close(); }
  }, 20000);

  test('reports an ownership mismatch without removing a changed source', async () => {
    const target = path.join(root, 'owned.partial');
    await fs.promises.writeFile(target, 'do not remove');
    const adapters = createFilesystemTransactionAdapters({ fs });

    const result = await adapters.removeOwned.remove({
      target,
      expected: { device: 'wrong', inode: 'wrong', size: 13 }
    });

    expect(result.removed).toBe(false);
    await expect(fs.promises.readFile(target, 'utf8')).resolves.toBe('do not remove');
  });

  (process.platform === 'win32' ? test : test.skip)('removes only the identified owned link and preserves the published file', async () => {
    const target = path.join(root, 'owned.partial');
    const published = path.join(root, 'published.mp4');
    await fs.promises.writeFile(target, 'verified video');
    await fs.promises.link(target, published);
    const adapters = createFilesystemTransactionAdapters({ fs });
    expect(await adapters.removeOwned.remove({ target, expected: await expectedFor(target) })).toMatchObject({ removed: true });
    expect(fs.existsSync(target)).toBe(false);
    expect(await fs.promises.readFile(published, 'utf8')).toBe('verified video');
  }, 20000);

  (process.platform === 'win32' ? test : test.skip)('refuses a swapped file even when its contents and size match', async () => {
    const target = path.join(root, 'owned.partial');
    await fs.promises.writeFile(target, 'same data');
    const expected = await expectedFor(target);
    await fs.promises.rename(target, path.join(root, 'old.partial'));
    await fs.promises.writeFile(target, 'same data');
    const result = await createFilesystemTransactionAdapters({ fs }).removeOwned.remove({ target, expected });
    expect(result.ownershipMismatch).toBe(true);
    expect(await fs.promises.readFile(target, 'utf8')).toBe('same data');
  }, 20000);

  (process.platform === 'win32' ? test : test.skip)('refuses changed contents with unchanged identity and size', async () => {
    const target = path.join(root, 'owned.partial');
    await fs.promises.writeFile(target, 'original');
    const expected = await expectedFor(target);
    await fs.promises.writeFile(target, 'modified');
    const result = await createFilesystemTransactionAdapters({ fs }).removeOwned.remove({ target, expected });
    expect(result.ownershipMismatch).toBe(true);
    expect(await fs.promises.readFile(target, 'utf8')).toBe('modified');
  }, 20000);

  (process.platform === 'win32' ? test : test.skip)('cleans a verified read-only snapshot through the same handle', async () => {
    const target = path.join(root, 'snapshot.mp4');
    await fs.promises.writeFile(target, 'snapshot');
    const expected = await expectedFor(target);
    await fs.promises.chmod(target, 0o400);
    expect(await createFilesystemTransactionAdapters({ fs }).removeOwned.remove({ target, expected })).toMatchObject({ removed: true });
    expect(fs.existsSync(target)).toBe(false);
  }, 20000);

  (process.platform === 'win32' ? test : test.skip)('cleans Unicode paths without reporting a false missing file', async () => {
    const target = path.join(root, 'café-测试.mp4');
    await fs.promises.writeFile(target, 'video');
    expect(await createFilesystemTransactionAdapters({ fs }).removeOwned.remove({ target, expected: await expectedFor(target) })).toMatchObject({ removed: true });
    expect(fs.existsSync(target)).toBe(false);
  }, 20000);

  test('preserves both files when exclusive promotion collides', async () => {
    const from = path.join(root, 'candidate.mp4');
    const to = path.join(root, 'original.mp4');
    await fs.promises.writeFile(from, 'candidate');
    await fs.promises.writeFile(to, 'original');
    const adapters = createFilesystemTransactionAdapters({ fs });

    await expect(adapters.renameExclusive.promote({
      from,
      to,
      expectedSource: await expectedFor(from),
      removeSource: false
    })).rejects.toMatchObject({ code: 'EEXIST' });

    await expect(fs.promises.readFile(from, 'utf8')).resolves.toBe('candidate');
    await expect(fs.promises.readFile(to, 'utf8')).resolves.toBe('original');
  });

  test.each(['darwin', 'linux'])('%s never invokes Windows cleanup or deletes without a supported adapter', async (platform) => {
    const target = path.join(root, 'owned.partial');
    await fs.promises.writeFile(target, 'keep safe');
    const adapters = createFilesystemTransactionAdapters({ fs, platform });
    expect(await adapters.removeOwned.remove({ target, expected: await expectedFor(target) })).toMatchObject({ removed: false, unsupported: true });
    expect(await fs.promises.readFile(target, 'utf8')).toBe('keep safe');
  });
});
