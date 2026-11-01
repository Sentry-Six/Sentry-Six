'use strict';

const nodeFs = require('fs');
const nodePath = require('path');

const CHANNELS = Object.freeze([
  'converter:chooseFolder',
  'converter:start',
  'converter:getCurrent',
  'converter:pause',
  'converter:resume',
  'converter:cancel',
  'converter:retryFailed',
  'converter:dismissSummary',
  'converter:getCapabilities',
  'converter:subscribeProgress',
  'converter:unsubscribeProgress'
]);
const GROUPS = new Set(['RecentClips', 'SavedClips', 'SentryClips']);
const ACTIVE_STATES = new Set([
  'discovering', 'waiting', 'staging', 'encoding', 'writing-telemetry',
  'verifying', 'copying', 'replacing', 'paused', 'paused_network'
]);
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
const SAFE_ERROR_CODE = /^[A-Z0-9_]{1,64}$/;
const LIVE_PROGRESS_PHASES = new Set(['continue', 'end']);
const ITEM_STATE_KEYS = ['queued', 'completed', 'skipped', 'failed'];
const PRIVATE_SNAPSHOT_KEY = /(?:telemetry|sei|nal|payload|owned|publication|stdout|stderr|stack|exception|process|runner)/i;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_SNAPSHOT_BYTES = 512 * 1024;
const registrations = new WeakMap();

class ConverterIpcError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ConverterIpcError';
    this.code = code;
  }
}

function fail(code) {
  throw new ConverterIpcError(code);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedJsonValue(value, byteLimit, { stripPrivate = false } = {}) {
  const seen = new Set();
  let nodes = 0;
  let stringUnits = 0;
  const visit = (input, key = '') => {
    nodes += 1;
    if (nodes > 20_000) fail('PAYLOAD_TOO_LARGE');
    if (stripPrivate && PRIVATE_SNAPSHOT_KEY.test(key)) return undefined;
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number') {
      if (!Number.isFinite(input) || !Number.isSafeInteger(input)) fail('INVALID_REQUEST');
      return input;
    }
    if (typeof input === 'string') {
      stringUnits += input.length;
      if (input.length > 32_768 || stringUnits > byteLimit) fail('PAYLOAD_TOO_LARGE');
      return input;
    }
    if (Buffer.isBuffer(input) || ArrayBuffer.isView(input) || typeof input !== 'object' || seen.has(input)) {
      fail('INVALID_REQUEST');
    }
    seen.add(input);
    let output;
    if (Array.isArray(input)) {
      if (input.length > 10_000) fail('PAYLOAD_TOO_LARGE');
      output = input.map((item) => visit(item));
    } else {
      if (!isPlainObject(input)) fail('INVALID_REQUEST');
      if (Object.getOwnPropertySymbols(input).length > 0) fail('INVALID_REQUEST');
      const descriptors = Object.getOwnPropertyDescriptors(input);
      const entries = Object.entries(descriptors);
      if (entries.length > 128) fail('PAYLOAD_TOO_LARGE');
      output = {};
      for (const [childKey, descriptor] of entries) {
        if (childKey.length > 128) fail('INVALID_REQUEST');
        if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) fail('INVALID_REQUEST');
        const sanitized = visit(descriptor.value, childKey);
        if (sanitized !== undefined) output[childKey] = sanitized;
      }
    }
    seen.delete(input);
    return output;
  };
  const output = visit(value);
  if (Buffer.byteLength(JSON.stringify(output), 'utf8') > byteLimit) fail('PAYLOAD_TOO_LARGE');
  return output;
}

function validatePayload(payload) {
  if (payload === undefined) return undefined;
  return boundedJsonValue(payload, MAX_PAYLOAD_BYTES);
}

function sanitizeSnapshot(snapshot) {
  if (!isPlainObject(snapshot)) fail('INVALID_SNAPSHOT');
  if (!Array.isArray(snapshot.items) || snapshot.items.length <= 256) {
    return boundedJsonValue(snapshot, MAX_SNAPSHOT_BYTES, { stripPrivate: true });
  }
  const descriptors = Object.getOwnPropertyDescriptors(snapshot);
  if (Object.values(descriptors).some((descriptor) => !Object.prototype.hasOwnProperty.call(descriptor, 'value'))) {
    fail('INVALID_SNAPSHOT');
  }
  const itemCount = snapshot.items.length;
  const itemStateCounts = Object.fromEntries(ITEM_STATE_KEYS.map((state) => [
    state,
    snapshot.items.filter((item) => item?.state === state).length
  ]));
  const cleanupPendingCount = snapshot.items.filter((item) => String(item?.resultCode || '').includes('cleanup-pending')).length;
  const activeIndex = snapshot.items.findIndex((item) => item?.id === snapshot.activeItemId);
  const failedIndexes = snapshot.items
    .map((item, index) => item?.state === 'failed' ? index : -1)
    .filter((index) => index >= 0);
  let limit = 256;
  while (limit >= 1) {
    const selected = new Set();
    if (activeIndex >= 0) selected.add(activeIndex);
    for (let index = failedIndexes.length - 1; index >= 0 && selected.size < limit; index -= 1) {
      selected.add(failedIndexes[index]);
    }
    for (let index = itemCount - 1; index >= 0 && selected.size < limit; index -= 1) selected.add(index);
    const prepared = {};
    for (const [key, descriptor] of Object.entries(descriptors)) prepared[key] = descriptor.value;
    prepared.items = [...selected].sort((left, right) => left - right).map((index) => snapshot.items[index]);
    prepared.itemCount = itemCount;
    prepared.itemStateCounts = itemStateCounts;
    prepared.cleanupPendingCount = cleanupPendingCount;
    prepared.itemsTruncated = true;
    try {
      return boundedJsonValue(prepared, MAX_SNAPSHOT_BYTES, { stripPrivate: true });
    } catch (error) {
      if (error?.code !== 'PAYLOAD_TOO_LARGE' || limit === 1) throw error;
      limit = Math.max(1, Math.floor(limit / 2));
    }
  }
  fail('PAYLOAD_TOO_LARGE');
}

function sanitizeLiveProgress(progress) {
  if (!isPlainObject(progress)) fail('INVALID_PROGRESS');
  const descriptors = Object.getOwnPropertyDescriptors(progress);
  const phaseDescriptor = descriptors.phase;
  if (!phaseDescriptor || !Object.prototype.hasOwnProperty.call(phaseDescriptor, 'value')
      || !LIVE_PROGRESS_PHASES.has(phaseDescriptor.value)) fail('INVALID_PROGRESS');
  const sanitized = { phase: phaseDescriptor.value };
  const outTimeDescriptor = descriptors.outTimeUs;
  if (outTimeDescriptor && Object.prototype.hasOwnProperty.call(outTimeDescriptor, 'value')) {
    if (!Number.isSafeInteger(outTimeDescriptor.value) || outTimeDescriptor.value < 0) fail('INVALID_PROGRESS');
    sanitized.outTimeUs = outTimeDescriptor.value;
  }
  return sanitized;
}

function responseError(error) {
  const raw = typeof error?.code === 'string' ? error.code.toUpperCase().replace(/-/g, '_') : '';
  const code = SAFE_ERROR_CODE.test(raw) ? raw : 'OPERATION_FAILED';
  return { ok: false, error: { code, retryable: error?.retryable === true } };
}

function wrapped(handler) {
  return async (event, rawPayload) => {
    try {
      const payload = validatePayload(rawPayload);
      return { ok: true, value: await handler(event, payload) };
    } catch (error) {
      return responseError(error);
    }
  };
}

function validateJobId(payload) {
  if (!isPlainObject(payload) || Object.keys(payload).length !== 1) fail('INVALID_JOB_ID');
  return validateSafeJobId(payload.jobId);
}

function validateSafeJobId(id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id) || WINDOWS_RESERVED_NAME.test(id)) fail('INVALID_JOB_ID');
  return id;
}

function validateNoPayload(payload) {
  if (payload !== undefined) fail('INVALID_REQUEST');
}

function validateAbsolutePath(value, pathApi) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32_768 || value.includes('\0')
      || (!pathApi.isAbsolute(value) && !nodePath.win32.isAbsolute(value) && !nodePath.posix.isAbsolute(value))) {
    fail('INVALID_PATH');
  }
  return pathApi.resolve(value);
}

function comparisonPath(value, pathApi, platform) {
  const normalized = pathApi.normalize(pathApi.resolve(value));
  return platform === 'win32' || pathApi === nodePath.win32 ? normalized.toLowerCase() : normalized;
}

function overlaps(left, right, pathApi, platform) {
  const a = comparisonPath(left, pathApi, platform);
  const b = comparisonPath(right, pathApi, platform);
  const relativeAB = pathApi.relative(a, b);
  const relativeBA = pathApi.relative(b, a);
  const contained = (relative) => relative === ''
    || (relative !== '..' && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative));
  return contained(relativeAB) || contained(relativeBA);
}

async function canonicalDirectory(target, dependencies) {
  const absolute = validateAbsolutePath(target, dependencies.pathApi);
  let stat;
  let real;
  try {
    stat = await dependencies.fs.lstat(absolute);
    real = dependencies.pathApi.resolve(await dependencies.fs.realpath(absolute));
  } catch (_error) {
    fail('PATH_UNAVAILABLE');
  }
  if (!stat || typeof stat.isDirectory !== 'function' || !stat.isDirectory()) fail('INVALID_PATH');
  return { absolute, real };
}

async function canonicalFutureDirectory(target, dependencies) {
  const absolute = validateAbsolutePath(target, dependencies.pathApi);
  let cursor = absolute;
  const suffix = [];
  while (true) {
    try {
      const stat = await dependencies.fs.lstat(cursor);
      if (!stat || typeof stat.isDirectory !== 'function' || !stat.isDirectory()) fail('INVALID_PATH');
      const realAncestor = dependencies.pathApi.resolve(await dependencies.fs.realpath(cursor));
      return { absolute, real: dependencies.pathApi.resolve(realAncestor, ...suffix) };
    } catch (error) {
      if (error instanceof ConverterIpcError) throw error;
      if (!error || error.code !== 'ENOENT') fail('PATH_UNAVAILABLE');
      const parent = dependencies.pathApi.dirname(cursor);
      if (parent === cursor) fail('PATH_UNAVAILABLE');
      suffix.unshift(dependencies.pathApi.basename(cursor));
      cursor = parent;
    }
  }
}

function exactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

async function validateStartConfig(payload, dependencies, capabilities) {
  const keys = [
    'sourceRoot', 'destinationRoot', 'codec', 'profileId', 'networkMode',
    'outputMode', 'includedGroups', 'replacementConfirmed'
  ];
  const hasGroupOrder = isPlainObject(payload) && Object.prototype.hasOwnProperty.call(payload, 'groupOrder');
  if (!exactKeys(payload, hasGroupOrder ? [...keys, 'groupOrder'] : keys)) fail('INVALID_REQUEST');
  if (!['h265', 'av1'].includes(payload.codec)) fail('INVALID_CODEC');
  if (!['conservative', 'balanced', 'aggressive'].includes(payload.profileId)) fail('INVALID_PROFILE');
  if (!['auto', 'staging', 'direct'].includes(payload.networkMode)) fail('INVALID_NETWORK_MODE');
  if (!['separate', 'replace'].includes(payload.outputMode)) fail('INVALID_OUTPUT_MODE');
  if (!Array.isArray(payload.includedGroups) || payload.includedGroups.length === 0
      || new Set(payload.includedGroups).size !== payload.includedGroups.length
      || payload.includedGroups.some((group) => !GROUPS.has(group))) fail('INVALID_GROUP_SELECTION');
  if (hasGroupOrder && (!Array.isArray(payload.groupOrder) || payload.groupOrder.length !== GROUPS.size
      || new Set(payload.groupOrder).size !== GROUPS.size
      || payload.groupOrder.some((group) => !GROUPS.has(group)))) fail('INVALID_GROUP_ORDER');

  const source = await canonicalDirectory(payload.sourceRoot, dependencies);
  if (payload.outputMode === 'replace') {
    if (payload.destinationRoot !== null) fail('INVALID_PATH');
    if (payload.replacementConfirmed !== true) fail('REPLACEMENT_CONFIRMATION_REQUIRED');
    if (capabilities.replacement !== 'available') fail('REPLACEMENT_UNAVAILABLE');
    return { ...payload, sourceRoot: source.real };
  }
  if (payload.replacementConfirmed !== false) fail('INVALID_REPLACEMENT_CONFIRMATION');
  const destination = await canonicalFutureDirectory(payload.destinationRoot, dependencies);
  for (const sourcePath of [source.absolute, source.real]) {
    for (const destinationPath of [destination.absolute, destination.real]) {
      if (overlaps(sourcePath, destinationPath, dependencies.pathApi, dependencies.platform)) fail('PATH_OVERLAP');
    }
  }
  return { ...payload, sourceRoot: source.real, destinationRoot: destination.real };
}

function chooseCurrent(snapshots) {
  if (!Array.isArray(snapshots)) fail('INVALID_SNAPSHOT');
  const candidates = snapshots.filter((snapshot) => isPlainObject(snapshot));
  const active = candidates.filter((snapshot) => ACTIVE_STATES.has(snapshot.state));
  const visible = active.length ? active : candidates.filter((snapshot) => snapshot.summaryDismissed !== true);
  visible.sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0) || (right.revision || 0) - (left.revision || 0));
  return visible.length ? sanitizeSnapshot(visible[0]) : null;
}

function validateCapabilities(value = {}) {
  const allowed = {
    separatePublication: new Set(['hardlink-cleanup-pending', 'native-atomic', 'unavailable']),
    ownershipCleanup: new Set(['atomic-expected-ownership', 'unavailable']),
    replacement: new Set(['available', 'unavailable']),
    destinationContainment: new Set([
      'pathname-revalidated-non-atomic', 'native-directory-relative-atomic', 'unavailable'
    ])
  };
  const result = {};
  for (const [key, choices] of Object.entries(allowed)) {
    const selected = value[key] || 'unavailable';
    if (!choices.has(selected)) fail('INVALID_CAPABILITY_STATUS');
    result[key] = selected;
  }
  return Object.freeze(result);
}

function registerConverterIpc(options = {}) {
  if (!options.ipcMain || typeof options.ipcMain.handle !== 'function'
      || typeof options.ipcMain.removeHandler !== 'function') throw new TypeError('ipcMain is required');
  const existing = registrations.get(options.ipcMain);
  if (existing) return existing;
  if (!options.dialog || typeof options.dialog.showOpenDialog !== 'function') throw new TypeError('dialog is required');
  if (!options.service || typeof options.service.subscribe !== 'function') throw new TypeError('service is required');

  const dependencies = {
    fs: options.fs || nodeFs.promises,
    pathApi: options.pathApi || nodePath,
    platform: options.platform || process.platform
  };
  const capabilities = validateCapabilities(options.capabilities);
  const senders = new Map();
  let unregistered = false;

  function removeSender(sender, options = {}) {
    const registration = senders.get(sender);
    if (!registration) return;
    if (options.force !== true && registration.count > 1) {
      registration.count -= 1;
      return;
    }
    senders.delete(sender);
    if (typeof sender.removeListener === 'function') sender.removeListener('destroyed', registration.destroyListener);
  }

  function addSender(sender) {
    if (!sender || typeof sender.send !== 'function' || typeof sender.once !== 'function') fail('INVALID_SENDER');
    if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) fail('INVALID_SENDER');
    const existingSender = senders.get(sender);
    if (existingSender) {
      existingSender.count += 1;
      return;
    }
    const destroyListener = () => removeSender(sender, { force: true });
    senders.set(sender, { count: 1, destroyListener });
    sender.once('destroyed', destroyListener);
  }

  const unsubscribeService = options.service.subscribe((event) => {
    if (!event || !['snapshot', 'progress'].includes(event.type)) return;
    let payload;
    try {
      if (typeof event.jobId !== 'string' || !SAFE_ID.test(event.jobId) || WINDOWS_RESERVED_NAME.test(event.jobId)
          || !Number.isSafeInteger(event.revision) || event.revision < 0) return;
      const snapshot = event.type === 'snapshot'
        ? sanitizeSnapshot(event.snapshot)
        : { id: event.jobId, revision: event.revision, progress: sanitizeLiveProgress(event.progress) };
      payload = { jobId: event.jobId, revision: event.revision, snapshot };
    } catch (_error) {
      return;
    }
    for (const sender of [...senders.keys()]) {
      if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) {
        removeSender(sender, { force: true });
        continue;
      }
      try { sender.send('converter:progress', payload); } catch (_error) { /* retry on the next event */ }
    }
  });

  const handlers = {
    'converter:chooseFolder': wrapped(async (_event, payload) => {
      if (!isPlainObject(payload) || !['source', 'destination'].includes(payload.purpose)
          || Object.keys(payload).some((key) => !['purpose', 'defaultPath'].includes(key))) fail('INVALID_REQUEST');
      const dialogOptions = { properties: ['openDirectory'] };
      if (payload.defaultPath !== undefined) dialogOptions.defaultPath = validateAbsolutePath(payload.defaultPath, dependencies.pathApi);
      const result = await options.dialog.showOpenDialog(dialogOptions);
      if (result?.canceled || !Array.isArray(result?.filePaths) || result.filePaths.length === 0) return null;
      return (await canonicalDirectory(result.filePaths[0], dependencies)).real;
    }),
    'converter:start': wrapped(async (_event, payload) => ({
      jobId: validateSafeJobId(await options.service.start(await validateStartConfig(payload, dependencies, capabilities)))
    })),
    'converter:getCurrent': wrapped(async (_event, payload) => {
      validateNoPayload(payload);
      return chooseCurrent(await options.service.list());
    }),
    'converter:pause': wrapped(async (_event, payload) => sanitizeSnapshot(await options.service.pause(validateJobId(payload)))),
    'converter:resume': wrapped(async (_event, payload) => sanitizeSnapshot(await options.service.resume(validateJobId(payload)))),
    'converter:cancel': wrapped(async (_event, payload) => sanitizeSnapshot(await options.service.cancel(validateJobId(payload)))),
    'converter:retryFailed': wrapped(async (_event, payload) => sanitizeSnapshot(await options.service.retryFailed(validateJobId(payload)))),
    'converter:dismissSummary': wrapped(async (_event, payload) => sanitizeSnapshot(await options.service.dismissSummary(validateJobId(payload)))),
    'converter:getCapabilities': wrapped(async (_event, payload) => {
      validateNoPayload(payload);
      return capabilities;
    }),
    'converter:subscribeProgress': wrapped(async (event, payload) => {
      validateNoPayload(payload);
      addSender(event?.sender);
      return null;
    }),
    'converter:unsubscribeProgress': wrapped(async (event, payload) => {
      validateNoPayload(payload);
      removeSender(event?.sender);
      return null;
    })
  };

  for (const channel of CHANNELS) options.ipcMain.handle(channel, handlers[channel]);

  const registration = Object.freeze({
    channels: CHANNELS,
    capabilities,
    unregister() {
      if (unregistered) return;
      unregistered = true;
      for (const channel of CHANNELS) options.ipcMain.removeHandler(channel);
      for (const sender of [...senders.keys()]) removeSender(sender, { force: true });
      if (typeof unsubscribeService === 'function') unsubscribeService();
      registrations.delete(options.ipcMain);
    }
  });
  registrations.set(options.ipcMain, registration);
  return registration;
}

module.exports = {
  CHANNELS,
  ConverterIpcError,
  registerConverterIpc,
  sanitizeSnapshot
};
