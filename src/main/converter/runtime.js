'use strict';

const crypto = require('crypto');
const nodeFs = require('fs');
const nodePath = require('path');

const { createJobStore } = require('./jobStore');
const { createFilesystemTransactionAdapters } = require('./filesystemTransactions');
const { scanTeslaFootage } = require('./scanner');
const { createEncoderPlanner } = require('./encoderPlanner');
const { extractH264TelemetryTimeline } = require('./telemetryTimeline');
const { createConverterAdapters } = require('./converterAdapters');
const { createVerificationSnapshot } = require('./verificationSnapshot');
const {
  classifyPath,
  checkStagingSpace,
  chooseStagingMode,
  createFileTransaction
} = require('./staging');
const { createConverterJobService } = require('./jobService');

const ACTIVE_RECOVERY_STATES = new Set([
  'discovering', 'waiting', 'staging', 'encoding', 'writing-telemetry',
  'verifying', 'copying', 'replacing', 'paused', 'paused_network'
]);
const SNAPSHOT_DIRECTORY_PREFIX = 'sentry-six-verification-';
const MAX_MEDIA_PROCESS_MS = 12 * 60 * 60 * 1000;
const RETRYABLE_PATH_CODES = new Set([
  'ENOENT', 'ENOTCONN', 'ENETDOWN', 'EHOSTUNREACH', 'ECONNRESET', 'ETIMEDOUT', 'EIO'
]);

function runtimeError(code) {
  return Object.assign(new Error(code), { code });
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function containedPath(root, candidate, pathApi, platform) {
  const relative = pathApi.relative(pathApi.resolve(root), pathApi.resolve(candidate));
  if (platform === 'win32') {
    const normalized = relative.toLowerCase();
    return normalized === '' || (normalized !== '..' && !normalized.startsWith(`..${pathApi.sep}`)
      && !pathApi.isAbsolute(relative));
  }
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${pathApi.sep}`)
    && !pathApi.isAbsolute(relative));
}

async function ensureContainedDestinationParent({ destinationRoot, destination, fs, pathApi = nodePath,
  platform = process.platform }) {
  if (typeof destinationRoot !== 'string' || typeof destination !== 'string'
      || !pathApi.isAbsolute(destinationRoot) || !pathApi.isAbsolute(destination)) {
    throw runtimeError('UNSAFE_DESTINATION_PATH');
  }
  const root = pathApi.resolve(destinationRoot);
  const parent = pathApi.dirname(pathApi.resolve(destination));
  if (!containedPath(root, parent, pathApi, platform)) throw runtimeError('UNSAFE_DESTINATION_PATH');

  async function lstatDirectory(target) {
    const stat = await fs.lstat(target, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()
        || !['bigint', 'number'].includes(typeof stat.dev)
        || !['bigint', 'number'].includes(typeof stat.ino)) {
      throw runtimeError('UNSAFE_DESTINATION_PATH');
    }
    return stat;
  }

  let existing = root;
  while (true) {
    try {
      await fs.lstat(existing, { bigint: true });
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const next = pathApi.dirname(existing);
      if (next === existing) throw error;
      existing = next;
    }
  }
  if (!containedPath(existing, parent, pathApi, platform)) throw runtimeError('UNSAFE_DESTINATION_PATH');

  const existingStat = await lstatDirectory(existing);
  const realExisting = await fs.realpath(existing);
  const relative = pathApi.relative(existing, parent);
  const components = relative === '' ? [] : relative.split(pathApi.sep).filter(Boolean);
  const captured = [{ path: existing, real: realExisting, dev: String(existingStat.dev), ino: String(existingStat.ino) }];
  let current = existing;
  let expectedReal = realExisting;
  for (const component of components) {
    current = pathApi.join(current, component);
    expectedReal = pathApi.join(expectedReal, component);
    let stat;
    try {
      stat = await lstatDirectory(current);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      try { await fs.mkdir(current); } catch (mkdirError) {
        if (mkdirError?.code !== 'EEXIST') throw mkdirError;
      }
      stat = await lstatDirectory(current);
    }
    const real = await fs.realpath(current);
    if (!sameResolvedPath(real, expectedReal, pathApi, platform)
        || !containedPath(realExisting, real, pathApi, platform)) throw runtimeError('UNSAFE_DESTINATION_PATH');
    captured.push({ path: current, real, dev: String(stat.dev), ino: String(stat.ino) });
  }

  async function revalidate() {
    for (const proof of captured) {
      let stat;
      let real;
      try {
        stat = await lstatDirectory(proof.path);
        real = await fs.realpath(proof.path);
      } catch (error) {
        if (RETRYABLE_PATH_CODES.has(error?.code)) throw error;
        throw runtimeError('UNSAFE_DESTINATION_PATH');
      }
      if (String(stat.dev) !== proof.dev || String(stat.ino) !== proof.ino
          || !sameResolvedPath(real, proof.real, pathApi, platform)) {
        throw runtimeError('UNSAFE_DESTINATION_PATH');
      }
    }
  }
  return Object.freeze({ atomicContainment: false, revalidate });
}

function sameResolvedPath(left, right, pathApi, platform) {
  const resolvedLeft = pathApi.resolve(left);
  const resolvedRight = pathApi.resolve(right);
  return platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function validateProcessRequest(command, args, options) {
  if (typeof command !== 'string' || command.length === 0 || command.length > 32_768 || command.includes('\0')
      || !Array.isArray(args) || args.length > 1_024
      || args.some((arg) => typeof arg !== 'string' || arg.length > 32_768 || arg.includes('\0'))
      || options?.shell === true) throw runtimeError('INVALID_PROCESS_REQUEST');
}

function createBoundedProcessRunner(options = {}) {
  if (typeof options.spawn !== 'function') throw new TypeError('spawn is required');
  const defaultTimeoutMs = positiveInteger(options.timeoutMs, 30_000);
  const maxOutputBytes = positiveInteger(options.maxOutputBytes, 1024 * 1024);

  return function run(command, args, requestOptions = {}) {
    try {
      validateProcessRequest(command, args, requestOptions);
    } catch (error) {
      return Promise.reject(error);
    }
    const timeoutMs = positiveInteger(requestOptions.timeoutMs, defaultTimeoutMs);
    const signal = requestOptions.signal;
    if (signal?.aborted) {
      return Promise.resolve({ status: null, signal: 'SIGTERM', stdout: '', stderr: '', timedOut: false, aborted: true });
    }
    return new Promise((resolve) => {
      let child;
      let settled = false;
      let timedOut = false;
      let aborted = false;
      let outputLimitExceeded = false;
      let stdout = '';
      let stderr = '';
      let outputBytes = 0;
      let timer;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', abortListener);
        resolve({
          status: result.status,
          signal: result.signal || null,
          stdout: outputLimitExceeded ? '' : stdout,
          stderr: outputLimitExceeded ? '' : stderr,
          timedOut,
          ...(aborted ? { aborted: true } : {}),
          ...(outputLimitExceeded ? { outputLimitExceeded: true } : {}),
          ...(result.error ? { error: result.error } : {})
        });
      };
      const terminate = () => {
        if (!child || child.killed) return;
        try { child.kill('SIGTERM'); } catch (_error) { /* close/error remains authoritative */ }
      };
      const abortListener = () => { aborted = true; terminate(); };
      const capture = (kind, chunk) => {
        if (outputLimitExceeded) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        outputBytes += bytes.length;
        if (outputBytes > maxOutputBytes) {
          outputLimitExceeded = true;
          stdout = '';
          stderr = '';
          terminate();
          return;
        }
        if (kind === 'stdout') stdout += bytes.toString('utf8');
        else stderr += bytes.toString('utf8');
      };

      try {
        child = options.spawn(command, args, {
          cwd: requestOptions.cwd,
          windowsHide: true,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (_error) {
        finish({ status: null, signal: null, error: { code: 'PROCESS_START_FAILED' } });
        return;
      }
      child.stdout?.on('data', (chunk) => capture('stdout', chunk));
      child.stderr?.on('data', (chunk) => capture('stderr', chunk));
      child.once('error', () => finish({ status: null, signal: null, error: { code: 'PROCESS_START_FAILED' } }));
      child.once('close', (status, closeSignal) => finish({
        status: Number.isInteger(status) ? status : null,
        signal: closeSignal
      }));
      signal?.addEventListener?.('abort', abortListener, { once: true });
      timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    });
  };
}

function sameArtifact(left, right) {
  return left && right
    && left.path === right.path
    && left.token === right.token
    && left.sha256 === right.sha256
    && left.size === right.size;
}

function structurallyOwnedSnapshot(artifact, pathApi, tempRoot) {
  if (!artifact || typeof artifact.path !== 'string' || typeof artifact.token !== 'string'
      || !/^[a-z0-9_-]{1,128}$/i.test(artifact.token)
      || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)
      || !Number.isSafeInteger(artifact.size) || artifact.size <= 0) return false;
  const absolute = pathApi.resolve(artifact.path);
  const relative = pathApi.relative(pathApi.resolve(tempRoot), absolute);
  if (relative === '..' || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)) return false;
  return pathApi.basename(absolute) === `${artifact.token}.mp4`
    && pathApi.basename(pathApi.dirname(absolute)).startsWith(SNAPSHOT_DIRECTORY_PREFIX);
}

function createVerificationSnapshotRegistry(options = {}) {
  if (typeof options.createSnapshot !== 'function') throw new TypeError('createSnapshot is required');
  const pathApi = options.pathApi || nodePath;
  const tempRoot = pathApi.resolve(options.tempRoot || require('os').tmpdir());
  const live = new Map();
  const consumed = new Set();

  async function createSnapshot(input) {
    const snapshot = await options.createSnapshot({ ...input, tempRoot });
    let artifact;
    try {
      artifact = { path: snapshot.path, token: snapshot.token, sha256: snapshot.sha256, size: snapshot.size };
      if (!structurallyOwnedSnapshot(artifact, pathApi, tempRoot)) throw runtimeError('INVALID_PUBLICATION_ARTIFACT');
    } catch (_error) {
      const rejected = runtimeError('INVALID_PUBLICATION_ARTIFACT');
      try {
        // Only the factory's bounded capability owns this newly created file.
        // Never delete a rejected artifact by its untrusted path or after transfer.
        if (snapshot?.transferred !== true && typeof snapshot?.cleanup === 'function') await snapshot.cleanup();
      } catch (cleanupError) { rejected.cause = cleanupError; }
      throw rejected;
    }
    live.set(artifact.token, artifact);
    return snapshot;
  }

  async function validate(artifact, context = {}) {
    if (!structurallyOwnedSnapshot(artifact, pathApi, tempRoot)) return false;
    if (context.mode === 'consume') {
      const expected = live.get(artifact.token);
      if (!sameArtifact(expected, artifact) || consumed.has(artifact.token)) return false;
      consumed.add(artifact.token);
      return true;
    }
    if (context.mode === 'reconcile') {
      return sameArtifact(artifact, context.persistedArtifact);
    }
    return false;
  }

  return Object.freeze({ createSnapshot, validate });
}

function parseVideoProbe(result) {
  if (!result || result.status !== 0 || result.error || result.timedOut || result.outputLimitExceeded
      || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') throw runtimeError('VIDEO_INSPECTION_FAILED');
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch (_error) { throw runtimeError('VIDEO_INSPECTION_FAILED'); }
  const stream = Array.isArray(parsed?.streams) && parsed.streams.length === 1 ? parsed.streams[0] : null;
  const codecNames = { h264: 'h264', hevc: 'h265', av1: 'av1' };
  const codec = codecNames[stream?.codec_name];
  const duration = Number(stream?.duration || parsed?.format?.duration);
  if (!codec || !Number.isFinite(duration) || duration <= 0) throw runtimeError('VIDEO_INSPECTION_FAILED');
  return { codec, durationSeconds: duration, containerReserveBytes: 0, telemetryReserveBytes: 0 };
}

function createRecoveryInspector({ fs, pathApi }) {
  const exists = async (target, signal) => {
    if (!target) return false;
    if (signal?.aborted) throw runtimeError('CANCELLED');
    try { await fs.lstat(target); return true; } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  };
  const matchesDigest = async (target, expected, signal) => {
    if (!target || !expected || !Number.isSafeInteger(expected.size) || !/^[a-f0-9]{64}$/.test(expected.sha256 || '')) return false;
    let handle;
    try {
      handle = await fs.open(target, 'r');
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== expected.size) return false;
      const hash = crypto.createHash('sha256');
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let offset = 0;
      while (offset < stat.size) {
        if (signal?.aborted) throw runtimeError('CANCELLED');
        const request = Math.min(buffer.length, stat.size - offset);
        const { bytesRead } = await handle.read(buffer, 0, request, offset);
        if (bytesRead !== request) return false;
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      return hash.digest('hex') === expected.sha256;
    } finally {
      if (handle) await handle.close();
    }
  };
  return async (manifest, options = {}) => {
    const item = (manifest.items || []).find((entry) => entry.id === manifest.activeItemId) || {};
    const owned = item.ownedPaths || manifest.ownedPaths || {};
    const artifact = item.publicationArtifact || manifest.publicationArtifact;
    const finalPath = manifest.config?.outputMode === 'replace'
      ? item.sourcePath
      : manifest.config?.destinationRoot && item.relativePath
        ? pathApi.resolve(manifest.config.destinationRoot, ...item.relativePath.split('/'))
        : null;
    const signal = options.signal;
    const replacing = manifest.state === 'replacing' || manifest.recovery?.fromState === 'replacing';
    const copying = manifest.state === 'copying' || manifest.recovery?.fromState === 'copying';
    const [candidateExists, partialExists, finalExists, sourceExists, backupExists] = await Promise.all([
      exists(replacing ? owned.replacementCandidate : copying ? null : owned.encodedCandidate, signal),
      exists(owned.destinationPartial, signal),
      exists(replacing ? null : finalPath, signal),
      exists(replacing ? item.sourcePath : null, signal),
      exists(owned.replacementBackup, signal)
    ]);
    const finalValid = (replacing ? sourceExists : finalExists) ? await matchesDigest(finalPath, artifact, signal) : false;
    let partialFinalSameIdentity = false;
    if (partialExists && finalExists) {
      const [partial, final] = await Promise.all([
        fs.lstat(owned.destinationPartial, { bigint: true }), fs.lstat(finalPath, { bigint: true })
      ]);
      partialFinalSameIdentity = partial.isFile() && final.isFile()
        && partial.dev === final.dev && partial.ino === final.ino;
    }
    return { candidateExists, partialExists, finalExists, sourceExists, backupExists, finalValid, partialFinalSameIdentity };
  };
}

function createVolumeInfo(options = {}) {
  if (!options.fs || typeof options.fs.statfs !== 'function') throw new TypeError('statfs is required');
  const pathApi = options.pathApi || nodePath;
  const platform = options.platform || process.platform;
  const runCommand = options.runCommand;
  const powershellPath = options.powershellPath
    || (process.env.SystemRoot
      ? nodePath.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe');
  const cache = new Map();
  const networkTypes = new Set([
    0x6969n, // NFS
    0xff534d42n, // CIFS
    0xfe534d42n, // SMB2
    0x73757245n, // CODA
    0x5346414fn // AFS
  ]);

  async function freeSpace(target) {
    const stat = await options.fs.statfs(target, { bigint: true });
    const available = BigInt(stat.bavail) * BigInt(stat.bsize);
    if (available < 0n) throw runtimeError('FREE_SPACE_UNAVAILABLE');
    return available > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(available);
  }

  async function classifyPath(target) {
    if (platform === 'win32') {
      if (typeof runCommand !== 'function') return null;
      const root = pathApi.parse(pathApi.resolve(target)).root;
      const key = root.toLowerCase();
      if (!cache.has(key)) {
        cache.set(key, (async () => {
          const script = '([System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($args[0]))).DriveType.ToString()';
          const result = await runCommand(powershellPath, [
            '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script, root
          ], { shell: false });
          if (!result || result.status !== 0 || result.error || result.timedOut || result.outputLimitExceeded) return null;
          const kind = String(result.stdout || '').trim();
          if (kind === 'Network') return { remote: true, certain: true };
          if (['Fixed', 'Removable', 'Ram', 'CDRom'].includes(kind)) return { remote: false, certain: true };
          return null;
        })().catch(() => null));
      }
      return cache.get(key);
    }
    try {
      const stat = await options.fs.statfs(target, { bigint: true });
      const type = BigInt(stat.type);
      if (networkTypes.has(type)) return { remote: true, certain: true };
    } catch (_error) { /* Ambiguous filesystems use direct mode. */ }
    return null;
  }

  return Object.freeze({ classifyPath, freeSpace });
}

function defaultFactories() {
  return {
    createJobStore,
    createFileTransaction,
    createEncoderPlanner,
    createConverterAdapters,
    createConverterJobService
  };
}

async function createConverterRuntime(options = {}) {
  const fileSystem = options.fs || nodeFs;
  const pfs = fileSystem.promises || fileSystem;
  const pathApi = options.pathApi || nodePath;
  const platform = options.platform || process.platform;
  if (typeof options.userDataPath !== 'string' || typeof options.tempPath !== 'string'
      || !pathApi.isAbsolute(options.userDataPath) || !pathApi.isAbsolute(options.tempPath)) {
    throw runtimeError('INVALID_RUNTIME_PATH');
  }
  if (typeof options.ffmpegPath !== 'string' || options.ffmpegPath.length === 0
      || typeof options.ffprobePath !== 'string' || options.ffprobePath.length === 0) {
    throw runtimeError('CONVERTER_TOOLS_UNAVAILABLE');
  }
  if (typeof options.spawn !== 'function') throw new TypeError('spawn is required');

  const jobsRoot = pathApi.join(options.userDataPath, 'converter-jobs');
  const tempRoot = pathApi.join(options.tempPath, 'sentry-six-converter');
  await pfs.mkdir(jobsRoot, { recursive: true });
  await pfs.mkdir(tempRoot, { recursive: true });

  const factories = { ...defaultFactories(), ...(options.factories || {}) };
  const processRunner = createBoundedProcessRunner({
    spawn: options.spawn,
    timeoutMs: positiveInteger(options.processTimeoutMs, MAX_MEDIA_PROCESS_MS),
    maxOutputBytes: options.maxProcessOutputBytes
  });
  const snapshotRegistry = createVerificationSnapshotRegistry({
    createSnapshot: options.createVerificationSnapshot || createVerificationSnapshot,
    pathApi,
    tempRoot: options.tempPath
  });
  const store = factories.createJobStore({ rootDir: jobsRoot, fs: pfs });
  const filesystemTransactions = createFilesystemTransactionAdapters({ fs: fileSystem, platform });
  const removeOwned = options.removeOwned || filesystemTransactions.removeOwned;
  const renameExclusive = options.renameExclusive || filesystemTransactions.renameExclusive;
  const stagingManager = factories.createFileTransaction({
    fs: fileSystem,
    pathApi,
    platform,
    tempRoot,
    validatePublicationArtifact: snapshotRegistry.validate,
    removeOwned,
    renameExclusive
  });
  const planner = factories.createEncoderPlanner({
    runProbe: processRunner,
    platform,
    ffmpegPath: options.ffmpegPath
  });
  const adapters = factories.createConverterAdapters({
    fs: pfs,
    runFfprobe: processRunner,
    runFullDecode: processRunner,
    verifierOptions: {
      ffmpegPath: options.ffmpegPath,
      ffprobePath: options.ffprobePath,
      createSnapshot: snapshotRegistry.createSnapshot
    }
  });

  const volumeInfo = options.volumeInfo || createVolumeInfo({
    fs: pfs,
    pathApi,
    platform,
    runCommand: processRunner
  });
  const inspectVideo = async (_item, source, signal) => parseVideoProbe(await processRunner(options.ffprobePath, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,duration:format=duration',
    '-of', 'json', source
  ], { signal, shell: false, timeoutMs: 30_000 }));
  const readTimeline = async ({ source, signal }) => {
    if (signal?.aborted) throw runtimeError('CANCELLED');
    const bytes = await pfs.readFile(source);
    if (signal?.aborted) throw runtimeError('CANCELLED');
    return extractH264TelemetryTimeline(bytes);
  };
  const scanner = (config, scanOptions = {}) => scanTeslaFootage(config, {
    signal: scanOptions.signal,
    retryOperation: scanOptions.retryOperation,
    path: pathApi,
    platform
  });
  const inspectRecovery = createRecoveryInspector({ fs: pfs, pathApi });
  const network = options.network || {
    isRetryable: (error) => RETRYABLE_PATH_CODES.has(error?.code),
    checkPath: async (target, checkOptions = {}) => {
      let probe = pathApi.resolve(target);
      while (true) {
        try { await pfs.access(probe); return true; } catch (error) {
          if (error?.code !== 'ENOENT' || checkOptions.allowAncestor !== true) return false;
          const parent = pathApi.dirname(probe);
          if (parent === probe) return false;
          probe = parent;
        }
      }
    }
  };
  const spawnProcess = (command, args, spawnOptions = {}) => {
    validateProcessRequest(command, args, spawnOptions);
    return options.spawn(command, args, { ...spawnOptions, shell: false, windowsHide: true });
  };
  const service = factories.createConverterJobService({
    store,
    scanner,
    planner,
    stagingManager,
    inspectVideo,
    readTimeline,
    writers: adapters.writers,
    verifier: adapters.verifier,
    spawnProcess,
    ffmpegPath: options.ffmpegPath,
    pathApi,
    network,
    classifyPath: (target) => classifyPath(target, { pathApi, platform, volumeInfo }),
    chooseStagingMode: (request) => chooseStagingMode(request).mode,
    checkStagingSpace: (request) => checkStagingSpace({ ...request, tempRoot, volumeInfo }),
    inspectRecovery,
    ensureDestinationParent: ({ destinationRoot, destination }) => ensureContainedDestinationParent({
      destinationRoot, destination, fs: pfs, pathApi, platform
    })
  });

  const canRemoveOwned = removeOwned?.atomicOwnershipCheck === true && typeof removeOwned.remove === 'function';
  const canPromote = renameExclusive?.atomicNoReplace === true && typeof renameExclusive.promote === 'function';
  const stagingCapabilities = stagingManager.capabilities || {
    separatePublication: canPromote && canRemoveOwned ? 'native-atomic'
      : canPromote || !renameExclusive ? 'hardlink-cleanup-pending' : 'unavailable',
    ownershipCleanup: canRemoveOwned ? 'atomic-expected-ownership' : 'unavailable',
    replacement: canRemoveOwned && removeOwned.guardedRemoval === true && canPromote && renameExclusive.atomicExpectedOwnership === true ? 'available' : 'unavailable'
  };
  // Node exposes no descriptor-relative create/open primitive that can bind the
  // later transaction to this directory identity. The fallback therefore
  // advertises revalidation, not atomic containment, and fails closed on every
  // observed component/path/identity change.
  const capabilities = Object.freeze({
    ...stagingCapabilities,
    destinationContainment: 'pathname-revalidated-non-atomic'
  });
  let startPromise;
  let shutdownPromise;
  let recoveryPromise;
  const runtime = {
    service,
    store,
    stagingManager,
    capabilities,
    start() {
      if (shutdownPromise) return Promise.reject(runtimeError('SERVICE_SHUTDOWN'));
      if (!startPromise) {
        const attempt = (async () => {
          const manifests = await store.list();
          const recovered = [];
          for (const manifest of manifests) {
            if (shutdownPromise) throw runtimeError('SERVICE_SHUTDOWN');
            if (!ACTIVE_RECOVERY_STATES.has(manifest.state)) continue;
            recovered.push(await service.recover(manifest.id, inspectRecovery, { deferExecution: true }));
          }
          if (shutdownPromise) throw runtimeError('SERVICE_SHUTDOWN');
          // No queue or reconnect starts until every manifest safely reconciles.
          // Serial execution preserves the singleton worker across saved jobs.
          recoveryPromise = (async () => {
            for (const manifest of recovered) {
              if (shutdownPromise) break;
              await service.continueRecovery(manifest.id);
            }
          })();
          recoveryPromise.catch(error => {
            try { options.onError?.(error); } catch (_) { /* reporting is best effort */ }
          });
          return recovered;
        })();
        const tracked = attempt.catch((error) => {
          if (startPromise === tracked) startPromise = null;
          throw shutdownPromise ? runtimeError('SERVICE_SHUTDOWN') : error;
        });
        startPromise = tracked;
      }
      return startPromise;
    },
    shutdown() {
      if (!shutdownPromise) shutdownPromise = (async () => {
        const results = await Promise.allSettled([Promise.resolve().then(() => service.shutdown()), recoveryPromise]);
        const rejected = results.find(result => result.status === 'rejected');
        if (rejected) throw rejected.reason;
      })();
      return shutdownPromise;
    }
  };
  return Object.freeze(runtime);
}

function createConverterLifecycle({ initialize, app, onError = () => {} } = {}) {
  if (typeof initialize !== 'function' || !app || typeof app.quit !== 'function') {
    throw new TypeError('initialize and app are required');
  }
  let startPromise;
  let runtimeInstance;
  let runtimeAvailable;
  let shutdownPromise;
  let quitReady = false;
  let quitRequested = false;
  const start = () => {
    if (quitRequested) return Promise.reject(runtimeError('SERVICE_SHUTDOWN'));
    if (!startPromise) {
      let available;
      runtimeAvailable = new Promise(resolve => { available = resolve; });
      const retainRuntime = runtime => {
        if (runtimeInstance && runtimeInstance !== runtime) throw runtimeError('RUNTIME_ALREADY_OWNED');
        runtimeInstance = runtime;
        available(runtime);
      };
      const attempt = Promise.resolve().then(() => initialize({
        retainRuntime, runtime: runtimeInstance, isQuitting: () => quitRequested
      })).then((runtime) => {
        retainRuntime(runtime);
        if (quitRequested) throw runtimeError('SERVICE_SHUTDOWN');
        return runtime;
      });
      const tracked = attempt.catch((error) => {
        if (startPromise === tracked) {
          startPromise = null;
        }
        available(runtimeInstance);
        throw error;
      });
      startPromise = tracked;
    }
    return startPromise;
  };
  const beforeQuit = (event) => {
    if (quitReady) return Promise.resolve();
    if (!startPromise && !runtimeInstance) {
      quitReady = true;
      quitRequested = true;
      return Promise.resolve();
    }
    event?.preventDefault?.();
    if (!shutdownPromise) {
      quitRequested = true;
      const shutdown = runtimeInstance
        ? Promise.resolve(runtimeInstance.shutdown?.())
        : runtimeAvailable.then((runtime) => runtime?.shutdown?.());
      shutdownPromise = shutdown
        .catch((error) => { onError(error); })
        .finally(() => {
          quitReady = true;
          app.quit();
        });
    }
    return shutdownPromise;
  };
  return Object.freeze({ start, beforeQuit, get runtimePromise() { return startPromise; }, get isQuitting() { return quitRequested; } });
}

async function startConverterBeforeWindow({ lifecycle, createWindow } = {}) {
  if (!lifecycle || typeof lifecycle.start !== 'function' || typeof createWindow !== 'function') {
    throw new TypeError('lifecycle and createWindow are required');
  }
  const runtime = await lifecycle.start();
  createWindow();
  return runtime;
}

async function startConverterWithRecoveryPrompt({
  lifecycle,
  createWindow,
  dialog,
  app,
  scheduleRetry = () => new Promise((resolve) => setTimeout(resolve, 250)),
  onError = () => {}
} = {}) {
  if (!dialog || typeof dialog.showMessageBox !== 'function' || !app || typeof app.quit !== 'function'
      || typeof scheduleRetry !== 'function' || typeof onError !== 'function') {
    throw new TypeError('dialog, app, scheduleRetry, and onError are required');
  }
  let recoverySucceeded = false;
  while (true) {
    try {
      return await startConverterBeforeWindow({
        lifecycle,
        createWindow: () => {
          recoverySucceeded = true;
          return createWindow();
        }
      });
    } catch (error) {
      if (lifecycle.isQuitting) return null;
      if (recoverySucceeded) throw error;
      try { onError(error); } catch (_error) { /* reporting must not bypass the recovery gate */ }
      let response;
      try {
        response = await dialog.showMessageBox({
          type: 'error',
          title: 'Converter recovery failed',
          message: 'Studio could not safely recover unfinished converter jobs.',
          detail: 'Retry recovery or quit Studio. No converter window or IPC will open until recovery succeeds.',
          buttons: ['Retry', 'Quit'],
          defaultId: 0,
          cancelId: 1,
          noLink: true
        });
      } catch (dialogError) {
        try { onError(dialogError); } catch (_error) { /* best-effort reporting */ }
        app.quit();
        return null;
      }
      if (response?.response !== 0) {
        app.quit();
        return null;
      }
      try {
        await scheduleRetry();
      } catch (scheduleError) {
        try { onError(scheduleError); } catch (_error) { /* best-effort reporting */ }
        app.quit();
        return null;
      }
    }
  }
}

module.exports = {
  createBoundedProcessRunner,
  createConverterLifecycle,
  createConverterRuntime,
  ensureContainedDestinationParent,
  createRecoveryInspector,
  createVolumeInfo,
  createVerificationSnapshotRegistry,
  parseVideoProbe,
  startConverterBeforeWindow,
  startConverterWithRecoveryPrompt
};
