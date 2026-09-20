'use strict';

const path = require('path');
const { randomUUID } = require('crypto');
const { createEmptyCounters } = require('./contracts');

const MANIFEST_VERSION = 1;
const MANIFEST_NAME = 'job.json';
const TEMPORARY_MANIFEST_NAME = 'job.json.tmp';
const SAFE_JOB_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
const MANIFEST_LIMITS = Object.freeze({
  bytes: 4 * 1024 * 1024,
  items: 10_000,
  path: 32_768,
  text: 256,
  token: 512,
  depth: 16,
  nodes: 150_000,
  stringCodeUnits: 2 * 1024 * 1024
});

const JOB_STATES = Object.freeze([
  'discovering', 'waiting', 'staging', 'encoding', 'writing-telemetry',
  'verifying', 'copying', 'replacing', 'completed', 'skipped', 'failed',
  'paused', 'paused_network', 'cancelled'
]);
const REPLACEMENT_PHASES = Object.freeze([
  'candidate-written', 'original-backed-up', 'candidate-promoted',
  'final-validated', 'backup-deleted', 'rollback-started',
  'backup-restored', 'rollback-failed'
]);

const GROUPS = Object.freeze(['RecentClips', 'SavedClips', 'SentryClips']);
const DEFAULT_GROUP_ORDER = Object.freeze(['SavedClips', 'SentryClips', 'RecentClips']);
const JOB_STATE_SET = new Set(JOB_STATES);
const REPLACEMENT_PHASE_SET = new Set(REPLACEMENT_PHASES);
const TERMINAL_JOB_STATES = new Set(['completed', 'skipped', 'failed', 'cancelled']);
const TRANSACTION_JOB_STATES = new Set(['staging', 'encoding', 'writing-telemetry', 'verifying', 'copying', 'replacing']);
const ITEM_STATES = new Set(['queued', 'processing', 'completed', 'skipped', 'failed', 'cancelled']);
const DIRECTORY_SYNC_UNSUPPORTED = new Set(['EISDIR', 'EINVAL', 'EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP']);

const TOP_FIELDS = new Set([
  'schemaVersion', 'id', 'state', 'revision', 'config', 'items', 'counters',
  'summary', 'summaryDismissed', 'discoveryComplete', 'createdAt', 'updatedAt', 'activeItemId', 'ownedPaths',
  'ownedArtifacts', 'publicationArtifact', 'replacementPhase', 'recovery', 'failure'
]);
const CONFIG_FIELDS = new Set([
  'sourceRoot', 'destinationRoot', 'codec', 'profileId', 'networkMode',
  'outputMode', 'includedGroups', 'groupOrder', 'replacementConfirmed'
]);
const ITEM_FIELDS = new Set([
  'id', 'state', 'kind', 'group', 'eventId', 'relativePath', 'sourcePath',
  'sourceBytes', 'mtimeMs', 'timestampKey', 'camera', 'assetType',
  'eligibleVideo', 'outputPath', 'outputBytes', 'attempts', 'encoder',
  'failure', 'resultCode', 'ownedPaths', 'ownedArtifacts', 'publicationArtifact',
  'replacementPhase', 'expectedSource'
]);
const COUNTER_FIELDS = new Set([
  'files', 'sourceVideoBytes', 'outputVideoBytes', 'savedBytes',
  'copiedAssetBytes', 'groups'
]);
const SUMMARY_FIELDS = new Set([...COUNTER_FIELDS, 'source', 'output', 'saved', 'copiedAssets']);
const GROUP_COUNTER_FIELDS = new Set(['files', 'sourceBytes', 'outputBytes', 'savedBytes']);
const OWNED_PATH_FIELDS = new Set([
  'stagedSource', 'encodedCandidate', 'publicationSnapshot',
  'destinationPartial', 'replacementCandidate', 'replacementBackup'
]);
const PUBLICATION_FIELDS = new Set(['path', 'token', 'sha256', 'size']);
const OWNED_ARTIFACT_FIELDS = new Set(['path', 'nonce', 'state', 'size', 'sha256', 'device', 'inode', 'journal']);
const JOURNAL_FIELDS = new Set(['committed', 'pending']);
const JOURNAL_BOUNDARY_FIELDS = new Set(['size', 'sha256']);
const FAILURE_FIELDS = new Set(['code', 'retryable']);
const RECOVERY_FIELDS = new Set(['fromState', 'phase', 'action', 'pathRole', 'resumeState']);

const COPY_ACTIONS = new Set(['restart-copy', 'finalize-copy', 'resume-copy', 'manual-intervention']);
const ENCODING_ACTIONS = new Set(['restart-encoding', 'cleanup-and-restart-encoding', 'manual-intervention']);
const PASSIVE_RECOVERY_ACTIONS = Object.freeze({
  discovering: 'resume-discovery',
  waiting: 'resume-queue'
});
const ENCODING_RECOVERY_STATES = new Set(['encoding', 'staging', 'writing-telemetry', 'verifying']);
const NETWORK_RESUME_STATES = new Set([
  'waiting', 'staging', 'encoding', 'writing-telemetry', 'verifying', 'copying', 'replacing'
]);
const COPY_TRUTH_TABLE = Object.freeze({
  '000': 'restart-copy',
  '011': 'finalize-copy',
  '100': 'resume-copy'
});
const REPLACEMENT_TRUTH_TABLES = Object.freeze({
  'candidate-written': Object.freeze({
    '1100': 'backup-original', '1010': 'promote-candidate',
    '0110': 'validate-final', '0100': 'restart-replacement',
    '0010': 'restore-backup', '0111': 'delete-backup',
    '0101': 'finish-replacement'
  }),
  'original-backed-up': Object.freeze({
    '1010': 'promote-candidate', '0110': 'validate-final',
    '0010': 'restore-backup', '0111': 'delete-backup',
    '0101': 'finish-replacement'
  }),
  'candidate-promoted': Object.freeze({
    '1010': 'promote-candidate', '0110': 'validate-final',
    '0010': 'restore-backup', '0111': 'delete-backup',
    '0101': 'finish-replacement'
  }),
  'final-validated': Object.freeze({
    '0111': 'delete-backup', '0101': 'finish-replacement',
    '0010': 'restore-backup'
  }),
  'backup-deleted': Object.freeze({
    '0111': 'delete-backup', '0101': 'finish-replacement',
    '0010': 'restore-backup'
  }),
  'rollback-started': Object.freeze({
    '0100': 'rollback-complete', '0010': 'restore-backup'
  }),
  'backup-restored': Object.freeze({
    '0100': 'rollback-complete', '0010': 'restore-backup'
  }),
  'rollback-failed': Object.freeze({
    '0100': 'rollback-complete', '0010': 'restore-backup'
  })
});
const REPLACEMENT_ACTIONS_BY_PHASE = Object.freeze(Object.fromEntries(
  Object.entries(REPLACEMENT_TRUTH_TABLES).map(([phase, table]) => [
    phase,
    new Set([...Object.values(table), 'manual-intervention'])
  ])
));

class JobStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobStoreError';
    this.code = code;
  }
}

function storeError(code) {
  const messages = {
    INVALID_JOB_ID: 'The job identifier is invalid.',
    UNSAFE_JOB_PATH: 'The job manifest path is unsafe.',
    INVALID_MANIFEST: 'The job manifest schema is invalid.',
    UNSUPPORTED_MANIFEST_VERSION: 'The job manifest version is not supported.',
    SENSITIVE_MANIFEST_DATA: 'The job manifest contains data that must not be persisted.',
    JOB_EXISTS: 'A job with this identifier already exists.',
    JOB_NOT_FOUND: 'The requested job does not exist.',
    STALE_MANIFEST_REVISION: 'The job manifest revision is stale.',
    MANIFEST_READ_FAILED: 'The job manifest could not be read.',
    MANIFEST_WRITE_FAILED: 'The job manifest could not be saved.',
    MANIFEST_QUARANTINE_FAILED: 'The corrupt job manifest could not be quarantined.',
    CORRUPT_MANIFEST: 'The job manifest is corrupt and was quarantined.',
    INSPECTION_FAILED: 'The interrupted job paths could not be inspected.'
  };
  return new JobStoreError(code, messages[code] || 'The job store operation failed.');
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function preflightManifest(value) {
  const stack = [{ value, depth: 0 }];
  const active = new WeakSet();
  let nodes = 0;
  let stringCodeUnits = 0;
  let estimatedBytes = 0;

  function encodedStringBytes(text) {
    let bytes = Buffer.byteLength(text, 'utf8') + 2;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09
          || code === 0x0a || code === 0x0c || code === 0x0d) bytes += 1;
      else if (code <= 0x1f) bytes += 5;
    }
    return bytes;
  }

  function countString(text) {
    stringCodeUnits += text.length;
    estimatedBytes += encodedStringBytes(text);
    if (stringCodeUnits > MANIFEST_LIMITS.stringCodeUnits || estimatedBytes > MANIFEST_LIMITS.bytes) {
      throw storeError('INVALID_MANIFEST');
    }
  }

  try {
    while (stack.length > 0) {
      const entry = stack.pop();
      if (entry.exit) {
        active.delete(entry.value);
        continue;
      }
      nodes += 1;
      if (nodes > MANIFEST_LIMITS.nodes || entry.depth > MANIFEST_LIMITS.depth) throw storeError('INVALID_MANIFEST');
      const current = entry.value;
      if (current === null || typeof current === 'boolean') {
        estimatedBytes += 5;
      } else if (typeof current === 'string') {
        countString(current);
      } else if (typeof current === 'number') {
        if (!Number.isFinite(current)) throw storeError('INVALID_MANIFEST');
        estimatedBytes += 32;
      } else if (Buffer.isBuffer(current)) {
        throw storeError('SENSITIVE_MANIFEST_DATA');
      } else if (Array.isArray(current)) {
        if (active.has(current) || current.length > MANIFEST_LIMITS.items) throw storeError('INVALID_MANIFEST');
        active.add(current);
        stack.push({ value: current, exit: true });
        estimatedBytes += current.length + 2;
        for (let index = current.length - 1; index >= 0; index -= 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor || descriptor.get || descriptor.set) throw storeError('INVALID_MANIFEST');
          stack.push({ value: descriptor.value, depth: entry.depth + 1 });
        }
      } else if (isPlainObject(current)) {
        if (active.has(current)) throw storeError('INVALID_MANIFEST');
        active.add(current);
        stack.push({ value: current, exit: true });
        const keys = Object.keys(current);
        estimatedBytes += keys.length + 2;
        for (let index = keys.length - 1; index >= 0; index -= 1) {
          const key = keys[index];
          countString(key);
          const descriptor = Object.getOwnPropertyDescriptor(current, key);
          if (!descriptor || descriptor.get || descriptor.set) throw storeError('INVALID_MANIFEST');
          stack.push({ value: descriptor.value, depth: entry.depth + 1 });
        }
      } else {
        throw storeError('INVALID_MANIFEST');
      }
      // Reserve bounded indentation/separator overhead for the normalized
      // pretty-printed DTO before any JSON string is constructed.
      if (estimatedBytes + (nodes * 12) > MANIFEST_LIMITS.bytes) throw storeError('INVALID_MANIFEST');
    }
  } catch (error) {
    if (error instanceof JobStoreError) throw error;
    throw storeError('INVALID_MANIFEST');
  }
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isSensitiveField(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized.includes('payload') || normalized.includes('telemetry')
    || normalized.includes('fingerprint') || normalized.includes('nal')
    || normalized.includes('password') || normalized.includes('secret')
    || normalized.includes('token') || normalized.includes('authorization')
    || normalized.includes('cookie') || normalized.includes('exception')
    || ['stack', 'cause', 'stderr', 'stdout', 'message', 'error', 'errors', 'diagnostic', 'diagnostics'].includes(normalized);
}

function rejectUnknownFields(value, allowed) {
  if (!isPlainObject(value)) throw storeError('INVALID_MANIFEST');
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw storeError(isSensitiveField(key) ? 'SENSITIVE_MANIFEST_DATA' : 'INVALID_MANIFEST');
  }
}

function assertSafeJobId(id) {
  if (typeof id !== 'string' || !SAFE_JOB_ID.test(id) || WINDOWS_RESERVED_NAME.test(id)) {
    throw storeError('INVALID_JOB_ID');
  }
}

function portableItemId(value) {
  const id = boundedString(value, 128, SAFE_JOB_ID);
  if (WINDOWS_RESERVED_NAME.test(id)) throw storeError('INVALID_MANIFEST');
  return id;
}

function boundedString(value, maximum = MANIFEST_LIMITS.text, pattern) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || (pattern && !pattern.test(value))) {
    throw storeError('INVALID_MANIFEST');
  }
  return value;
}

function boundedPath(value, { nullable = false, relative = false } = {}) {
  if (nullable && value === null) return null;
  boundedString(value, MANIFEST_LIMITS.path);
  if (relative) {
    if (path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value)) throw storeError('INVALID_MANIFEST');
    const components = value.replace(/\\/g, '/').split('/');
    if (components.some((component) => component === '' || component === '.' || component === '..')) throw storeError('INVALID_MANIFEST');
  } else if (!path.isAbsolute(value) && !path.win32.isAbsolute(value) && !path.posix.isAbsolute(value)) {
    throw storeError('INVALID_MANIFEST');
  }
  return value;
}

function safeInteger(value, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) throw storeError('INVALID_MANIFEST');
  return value;
}

function nonNegativeFinite(value) {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw storeError('INVALID_MANIFEST');
  return value;
}

function optional(target, source, key, normalize) {
  if (hasOwn(source, key) && source[key] !== undefined && source[key] !== null) {
    target[key] = normalize(source[key]);
  }
}

function normalizeFailure(value) {
  rejectUnknownFields(value, FAILURE_FIELDS);
  const result = { code: boundedString(value.code, 64, /^[a-z0-9][a-z0-9_-]{0,63}$/) };
  if (hasOwn(value, 'retryable')) {
    if (typeof value.retryable !== 'boolean') throw storeError('INVALID_MANIFEST');
    result.retryable = value.retryable;
  }
  return result;
}

function normalizeOwnedPaths(value) {
  rejectUnknownFields(value, OWNED_PATH_FIELDS);
  const result = {};
  for (const key of OWNED_PATH_FIELDS) optional(result, value, key, (entry) => boundedPath(entry));
  return result;
}

function normalizeOwnedArtifacts(value, ownedPaths) {
  rejectUnknownFields(value, OWNED_PATH_FIELDS);
  const result = {};
  for (const [key, metadata] of Object.entries(value)) {
    rejectUnknownFields(metadata, OWNED_ARTIFACT_FIELDS);
    const entry = {
      path: boundedPath(metadata.path),
      nonce: boundedString(metadata.nonce, 128, /^[a-z0-9][a-z0-9_-]{0,127}$/),
      state: boundedString(metadata.state)
    };
    if (!new Set(['intent', 'writing', 'owned', 'cleanup-pending']).has(entry.state)
        || !ownedPaths || ownedPaths[key] !== entry.path) throw storeError('INVALID_MANIFEST');
    const identityFields = ['size', 'sha256', 'device', 'inode'];
    const present = identityFields.filter((field) => hasOwn(metadata, field));
    if (entry.state === 'intent') {
      if (present.length !== 0 || hasOwn(metadata, 'journal')) throw storeError('INVALID_MANIFEST');
    } else {
      if (present.length !== identityFields.length) throw storeError('INVALID_MANIFEST');
      const zeroSizedEncodedCleanup = key === 'encodedCandidate'
        && (entry.state === 'owned' || entry.state === 'cleanup-pending');
      entry.size = safeInteger(metadata.size, { positive: entry.state !== 'writing' && !zeroSizedEncodedCleanup });
      entry.sha256 = boundedString(metadata.sha256, 64, /^[a-f0-9]{64}$/);
      const normalizeIdentityPart = (part) => {
        if (Number.isSafeInteger(part) && part >= 0) return String(part);
        if (typeof part === 'string' && /^\d{1,32}$/.test(part)) return part;
        throw storeError('INVALID_MANIFEST');
      };
      entry.device = normalizeIdentityPart(metadata.device);
      entry.inode = normalizeIdentityPart(metadata.inode);
      if (hasOwn(metadata, 'journal')) {
        rejectUnknownFields(metadata.journal, JOURNAL_FIELDS);
        const boundary = (part) => {
          rejectUnknownFields(part, JOURNAL_BOUNDARY_FIELDS);
          return {
            size: safeInteger(part.size),
            sha256: boundedString(part.sha256, 64, /^[a-f0-9]{64}$/)
          };
        };
        entry.journal = { committed: boundary(metadata.journal.committed), pending: null };
        if (metadata.journal.pending !== null) entry.journal.pending = boundary(metadata.journal.pending);
        if (entry.journal.committed.size > entry.size
            || (entry.journal.pending && entry.journal.pending.size < entry.journal.committed.size)) {
          throw storeError('INVALID_MANIFEST');
        }
      } else if (entry.state === 'writing') throw storeError('INVALID_MANIFEST');
    }
    result[key] = entry;
  }
  return result;
}

function normalizePublication(value) {
  rejectUnknownFields(value, PUBLICATION_FIELDS);
  return {
    path: boundedPath(value.path),
    token: boundedString(value.token, MANIFEST_LIMITS.token),
    sha256: boundedString(value.sha256, 64, /^[a-f0-9]{64}$/),
    size: safeInteger(value.size, { positive: true })
  };
}

function normalizeGroupCounters(value) {
  rejectUnknownFields(value, GROUP_COUNTER_FIELDS);
  const result = {};
  for (const key of GROUP_COUNTER_FIELDS) result[key] = safeInteger(value[key]);
  if (result.savedBytes !== result.sourceBytes - result.outputBytes) throw storeError('INVALID_MANIFEST');
  return result;
}

function normalizeCounters(value, allowed = COUNTER_FIELDS) {
  rejectUnknownFields(value, allowed);
  const result = {};
  for (const key of ['files', 'sourceVideoBytes', 'outputVideoBytes', 'savedBytes', 'copiedAssetBytes']) {
    result[key] = safeInteger(value[key]);
  }
  if (result.savedBytes !== result.sourceVideoBytes - result.outputVideoBytes) throw storeError('INVALID_MANIFEST');
  rejectUnknownFields(value.groups, new Set(GROUPS));
  result.groups = {};
  for (const group of GROUPS) result.groups[group] = normalizeGroupCounters(value.groups[group]);
  const grouped = GROUPS.reduce((totals, group) => {
    const counters = result.groups[group];
    totals.files += counters.files;
    totals.sourceBytes += counters.sourceBytes;
    totals.outputBytes += counters.outputBytes;
    totals.savedBytes += counters.savedBytes;
    return totals;
  }, { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 });
  if (grouped.files > result.files || grouped.sourceBytes > result.sourceVideoBytes
      || grouped.outputBytes > result.outputVideoBytes || grouped.savedBytes > result.savedBytes) {
    throw storeError('INVALID_MANIFEST');
  }
  return result;
}

function normalizeSummary(value) {
  const result = normalizeCounters(value, SUMMARY_FIELDS);
  for (const key of ['source', 'output', 'saved', 'copiedAssets']) {
    result[key] = boundedString(value[key], MANIFEST_LIMITS.text);
  }
  return result;
}

function sameCounters(left, right) {
  for (const key of ['files', 'sourceVideoBytes', 'outputVideoBytes', 'savedBytes', 'copiedAssetBytes']) {
    if (left[key] !== right[key]) return false;
  }
  return GROUPS.every((group) => [...GROUP_COUNTER_FIELDS].every((key) => left.groups[group][key] === right.groups[group][key]));
}

function normalizeConfig(value) {
  rejectUnknownFields(value, CONFIG_FIELDS);
  const result = {
    sourceRoot: boundedPath(value.sourceRoot),
    destinationRoot: boundedPath(value.destinationRoot, { nullable: true }),
    codec: boundedString(value.codec),
    profileId: boundedString(value.profileId),
    networkMode: boundedString(value.networkMode),
    outputMode: boundedString(value.outputMode),
    replacementConfirmed: value.replacementConfirmed
  };
  if (!new Set(['h265', 'av1']).has(result.codec)
      || !new Set(['conservative', 'balanced', 'aggressive']).has(result.profileId)
      || !new Set(['auto', 'staging', 'direct']).has(result.networkMode)
      || !new Set(['separate', 'replace']).has(result.outputMode)
      || typeof result.replacementConfirmed !== 'boolean') throw storeError('INVALID_MANIFEST');
  if (!Array.isArray(value.includedGroups) || value.includedGroups.length < 1 || value.includedGroups.length > GROUPS.length) {
    throw storeError('INVALID_MANIFEST');
  }
  result.includedGroups = value.includedGroups.map((group) => boundedString(group));
  if (new Set(result.includedGroups).size !== result.includedGroups.length
      || result.includedGroups.some((group) => !GROUPS.includes(group))) throw storeError('INVALID_MANIFEST');
  const groupOrder = value.groupOrder === undefined ? DEFAULT_GROUP_ORDER : value.groupOrder;
  if (!Array.isArray(groupOrder) || groupOrder.length !== GROUPS.length) throw storeError('INVALID_MANIFEST');
  result.groupOrder = groupOrder.map((group) => boundedString(group));
  if (new Set(result.groupOrder).size !== GROUPS.length
      || result.groupOrder.some((group) => !GROUPS.includes(group))) throw storeError('INVALID_MANIFEST');
  if (result.outputMode === 'separate') {
    if (result.destinationRoot === null || result.replacementConfirmed) throw storeError('INVALID_MANIFEST');
  } else if (result.destinationRoot !== null || !result.replacementConfirmed) throw storeError('INVALID_MANIFEST');
  return result;
}

function normalizeItem(value) {
  rejectUnknownFields(value, ITEM_FIELDS);
  // Inspect the only permitted error-shaped object before required-field
  // validation so arbitrary exception output is always classified and
  // rejected at the persistence boundary.
  const normalizedFailure = hasOwn(value, 'failure') && value.failure !== undefined && value.failure !== null
    ? normalizeFailure(value.failure)
    : undefined;
  const result = {
    id: portableItemId(value.id),
    state: boundedString(value.state),
    kind: boundedString(value.kind),
    group: value.group === null ? null : boundedString(value.group),
    eventId: value.eventId === null ? null : boundedString(value.eventId),
    relativePath: boundedPath(value.relativePath, { relative: true }),
    sourcePath: boundedPath(value.sourcePath),
    sourceBytes: safeInteger(value.sourceBytes),
    mtimeMs: nonNegativeFinite(value.mtimeMs)
  };
  if (!ITEM_STATES.has(result.state) || !new Set(['video', 'asset']).has(result.kind)
      || (result.group !== null && !GROUPS.includes(result.group))) throw storeError('INVALID_MANIFEST');
  optional(result, value, 'timestampKey', (entry) => boundedString(entry));
  optional(result, value, 'camera', (entry) => boundedString(entry));
  optional(result, value, 'assetType', (entry) => boundedString(entry));
  if (hasOwn(value, 'eligibleVideo') && value.eligibleVideo !== undefined && value.eligibleVideo !== null) {
    if (typeof value.eligibleVideo !== 'boolean') throw storeError('INVALID_MANIFEST');
    result.eligibleVideo = value.eligibleVideo;
  }
  optional(result, value, 'outputPath', (entry) => boundedPath(entry));
  optional(result, value, 'outputBytes', (entry) => safeInteger(entry));
  optional(result, value, 'attempts', (entry) => {
    const attempts = safeInteger(entry);
    if (attempts > 3) throw storeError('INVALID_MANIFEST');
    return attempts;
  });
  optional(result, value, 'encoder', (entry) => boundedString(entry));
  optional(result, value, 'resultCode', (entry) => boundedString(entry, 64, /^[a-z0-9][a-z0-9_-]{0,63}$/));
  if (normalizedFailure) result.failure = normalizedFailure;
  optional(result, value, 'ownedPaths', normalizeOwnedPaths);
  optional(result, value, 'ownedArtifacts', (entry) => normalizeOwnedArtifacts(entry, result.ownedPaths));
  optional(result, value, 'publicationArtifact', normalizePublication);
  optional(result, value, 'expectedSource', (entry) => {
    rejectUnknownFields(entry, new Set(['size', 'sha256', 'device', 'inode']));
    return { size: safeInteger(entry.size), sha256: boundedString(entry.sha256, 64, /^[a-f0-9]{64}$/),
      device: boundedString(entry.device, 32, /^\d{1,32}$/), inode: boundedString(entry.inode, 32, /^\d{1,32}$/) };
  });
  optional(result, value, 'replacementPhase', (entry) => {
    if (!REPLACEMENT_PHASE_SET.has(entry)) throw storeError('INVALID_MANIFEST');
    return entry;
  });
  if (result.kind === 'video' && (!result.timestampKey || !result.camera)) throw storeError('INVALID_MANIFEST');
  if (result.kind === 'asset' && !result.assetType) throw storeError('INVALID_MANIFEST');
  if (result.state === 'failed' && !result.failure) throw storeError('INVALID_MANIFEST');
  if (result.state !== 'failed' && result.failure) throw storeError('INVALID_MANIFEST');
  if (result.state === 'completed' && (result.outputBytes === undefined || !result.outputPath)) throw storeError('INVALID_MANIFEST');
  if (result.publicationArtifact && result.ownedPaths?.publicationSnapshot !== result.publicationArtifact.path) {
    throw storeError('INVALID_MANIFEST');
  }
  if (result.publicationArtifact) {
    const snapshot = result.ownedArtifacts?.publicationSnapshot;
    if (!snapshot) throw storeError('INVALID_MANIFEST');
    if (snapshot.state === 'intent' || snapshot.size !== result.publicationArtifact.size
        || snapshot.sha256 !== result.publicationArtifact.sha256) throw storeError('INVALID_MANIFEST');
  }
  return result;
}

function normalizeRecovery(value, manifest) {
  rejectUnknownFields(value, RECOVERY_FIELDS);
  const result = {
    fromState: boundedString(value.fromState),
    action: boundedString(value.action)
  };
  if (hasOwn(value, 'phase') && value.phase !== undefined && value.phase !== null) {
    if (!REPLACEMENT_PHASE_SET.has(value.phase)) throw storeError('INVALID_MANIFEST');
    result.phase = value.phase;
  }
  if (hasOwn(value, 'pathRole') && value.pathRole !== undefined && value.pathRole !== null) {
    result.pathRole = boundedString(value.pathRole);
  }
  if (hasOwn(value, 'resumeState') && value.resumeState !== undefined && value.resumeState !== null) {
    result.resumeState = boundedString(value.resumeState);
  }
  if (manifest.state !== 'paused' && manifest.state !== 'paused_network') throw storeError('INVALID_MANIFEST');
  if (result.fromState === 'encoding') {
    if (result.phase || !ENCODING_ACTIONS.has(result.action)) throw storeError('INVALID_MANIFEST');
  } else if (result.fromState === 'copying') {
    if (result.phase || !COPY_ACTIONS.has(result.action)) throw storeError('INVALID_MANIFEST');
  } else if (result.fromState === 'replacing') {
    if (!result.phase || result.phase !== manifest.replacementPhase
        || !REPLACEMENT_ACTIONS_BY_PHASE[result.phase]?.has(result.action)) {
      throw storeError('INVALID_MANIFEST');
    }
  } else if (result.fromState === 'waiting') {
    const expected = manifest.discoveryComplete === false ? 'resume-discovery' : 'resume-queue';
    if (result.action !== expected || result.phase || result.pathRole) throw storeError('INVALID_MANIFEST');
  } else if (result.fromState === 'discovering') {
    if (result.action !== 'resume-discovery' || result.phase || result.pathRole) throw storeError('INVALID_MANIFEST');
  } else if (result.fromState === 'paused_network') {
    result.resumeState ||= 'waiting';
    const replacementOwned = ['replacementCandidate', 'replacementBackup']
      .some((key) => manifest.ownedPaths?.[key] || manifest.ownedArtifacts?.[key]);
    if (result.action !== 'resume-network'
        || !new Set(['source', 'destination', 'discovery']).has(result.pathRole)
        || !NETWORK_RESUME_STATES.has(result.resumeState)) throw storeError('INVALID_MANIFEST');
    if (result.resumeState === 'replacing') {
      if (!result.phase || result.phase !== manifest.replacementPhase
          || manifest.config.outputMode !== 'replace') throw storeError('INVALID_MANIFEST');
    } else if (result.phase || manifest.replacementPhase || replacementOwned) {
      throw storeError('INVALID_MANIFEST');
    }
  } else {
    throw storeError('INVALID_MANIFEST');
  }
  return result;
}

function normalizeManifest(value) {
  preflightManifest(value);
  rejectUnknownFields(value, TOP_FIELDS);
  if (value.schemaVersion !== MANIFEST_VERSION) throw storeError('UNSUPPORTED_MANIFEST_VERSION');
  assertSafeJobId(value.id);
  if (!JOB_STATE_SET.has(value.state)) throw storeError('INVALID_MANIFEST');
  const result = {
    schemaVersion: MANIFEST_VERSION,
    id: value.id,
    state: value.state,
    revision: safeInteger(value.revision),
    config: normalizeConfig(value.config)
  };
  if (!Array.isArray(value.items) || value.items.length > MANIFEST_LIMITS.items) throw storeError('INVALID_MANIFEST');
  result.items = value.items.map(normalizeItem);
  if (new Set(result.items.map((item) => item.id)).size !== result.items.length) throw storeError('INVALID_MANIFEST');
  result.counters = normalizeCounters(value.counters);
  result.summary = value.summary === null ? null : normalizeSummary(value.summary);
  if (value.summaryDismissed !== undefined && typeof value.summaryDismissed !== 'boolean') {
    throw storeError('INVALID_MANIFEST');
  }
  if (value.summaryDismissed === true) result.summaryDismissed = true;
  if (value.discoveryComplete !== undefined) {
    if (typeof value.discoveryComplete !== 'boolean') throw storeError('INVALID_MANIFEST');
    result.discoveryComplete = value.discoveryComplete;
  }
  optional(result, value, 'createdAt', (entry) => safeInteger(entry));
  optional(result, value, 'updatedAt', (entry) => safeInteger(entry));
  optional(result, value, 'activeItemId', portableItemId);
  optional(result, value, 'ownedPaths', normalizeOwnedPaths);
  optional(result, value, 'ownedArtifacts', (entry) => normalizeOwnedArtifacts(entry, result.ownedPaths));
  optional(result, value, 'publicationArtifact', normalizePublication);
  optional(result, value, 'replacementPhase', (entry) => {
    if (!REPLACEMENT_PHASE_SET.has(entry)) throw storeError('INVALID_MANIFEST');
    return entry;
  });
  optional(result, value, 'failure', normalizeFailure);
  if (value.recovery !== undefined && value.recovery !== null) result.recovery = normalizeRecovery(value.recovery, result);

  if (result.activeItemId && !result.items.some((item) => item.id === result.activeItemId)) throw storeError('INVALID_MANIFEST');
  if (TRANSACTION_JOB_STATES.has(result.state) && !result.activeItemId) throw storeError('INVALID_MANIFEST');
  if (result.state === 'paused_network' && result.recovery?.resumeState !== 'waiting' && !result.activeItemId) {
    throw storeError('INVALID_MANIFEST');
  }
  if (result.state === 'replacing') {
    if (!result.replacementPhase || result.config.outputMode !== 'replace') throw storeError('INVALID_MANIFEST');
  }
  if (result.replacementPhase && result.state !== 'replacing' && result.state !== 'paused'
      && !(result.state === 'paused_network' && result.recovery?.resumeState === 'replacing'
        && result.recovery.phase === result.replacementPhase)) throw storeError('INVALID_MANIFEST');
  if (result.state === 'completed') {
    if (result.summaryDismissed === true) {
      if (result.summary !== null) throw storeError('INVALID_MANIFEST');
    } else if (!result.summary || !sameCounters(result.summary, result.counters)) {
      throw storeError('INVALID_MANIFEST');
    }
  } else if (result.summary !== null || result.summaryDismissed === true) throw storeError('INVALID_MANIFEST');
  if (result.state === 'failed' && !result.failure) throw storeError('INVALID_MANIFEST');
  if (result.state !== 'failed' && result.failure) throw storeError('INVALID_MANIFEST');
  if (result.state === 'paused' && result.recovery && result.recovery.fromState === 'replacing'
      && result.config.outputMode !== 'replace') throw storeError('INVALID_MANIFEST');
  if (result.publicationArtifact && result.ownedPaths?.publicationSnapshot !== result.publicationArtifact.path) {
    throw storeError('INVALID_MANIFEST');
  }
  if (result.publicationArtifact) {
    const snapshot = result.ownedArtifacts?.publicationSnapshot;
    if (!snapshot) throw storeError('INVALID_MANIFEST');
    if (snapshot.state === 'intent' || snapshot.size !== result.publicationArtifact.size
        || snapshot.sha256 !== result.publicationArtifact.sha256) throw storeError('INVALID_MANIFEST');
  }
  return result;
}

function cloneManifest(manifest) {
  return JSON.parse(JSON.stringify(manifest));
}

function createJobStore(options) {
  if (!options || typeof options.rootDir !== 'string' || !path.isAbsolute(options.rootDir)) {
    throw new TypeError('rootDir must be an absolute path');
  }
  if (!options.fs || typeof options.fs.open !== 'function') throw new TypeError('fs must be a promise-based filesystem adapter');

  const rootDir = path.resolve(options.rootDir);
  const fileSystem = options.fs;
  const queues = new Map();
  let quarantineSequence = 0;

  function jobPaths(id) {
    assertSafeJobId(id);
    const directory = path.resolve(rootDir, id);
    const relative = path.relative(rootDir, directory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw storeError('UNSAFE_JOB_PATH');
    return { directory, manifest: path.join(directory, MANIFEST_NAME), temporary: path.join(directory, TEMPORARY_MANIFEST_NAME) };
  }

  async function ensureRoot() {
    await fileSystem.mkdir(rootDir, { recursive: true });
    const stat = await fileSystem.lstat(rootDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw storeError('UNSAFE_JOB_PATH');
    return fileSystem.realpath(rootDir);
  }

  async function assertContainedDirectory(directory, canonicalRoot) {
    const stat = await fileSystem.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw storeError('UNSAFE_JOB_PATH');
    const canonicalDirectory = await fileSystem.realpath(directory);
    const relative = path.relative(canonicalRoot, canonicalDirectory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw storeError('UNSAFE_JOB_PATH');
  }

  async function ensureJobDirectory(id) {
    const paths = jobPaths(id);
    const canonicalRoot = await ensureRoot();
    try { await fileSystem.mkdir(paths.directory); } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }
    await assertContainedDirectory(paths.directory, canonicalRoot);
    return paths;
  }

  async function openExistingJobDirectory(id) {
    const paths = jobPaths(id);
    const canonicalRoot = await ensureRoot();
    try { await assertContainedDirectory(paths.directory, canonicalRoot); } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
    return paths;
  }

  async function syncDirectory(directory) {
    let handle;
    try {
      handle = await fileSystem.open(directory, 'r');
      await handle.sync();
      await handle.close();
      handle = null;
    } catch (error) {
      if (handle) try { await handle.close(); } catch (_) { /* bounded below */ }
      if (!error || !DIRECTORY_SYNC_UNSUPPORTED.has(error.code)) throw error;
    }
  }

  async function removeTemporary(temporary) {
    try { await fileSystem.unlink(temporary); } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }

  async function renameManifestWithRetry(temporary, manifest) {
    const retryable = new Set(['EACCES', 'EBUSY', 'EPERM', 'ENOTEMPTY']);
    let lastError;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await fileSystem.rename(temporary, manifest);
        return;
      } catch (error) {
        lastError = error;
        if (!retryable.has(error?.code) || attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  async function openTemporary(temporary) {
    try { return await fileSystem.open(temporary, 'wx', 0o600); } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }
    const stat = await fileSystem.lstat(temporary);
    if (!stat.isFile() || stat.isSymbolicLink()) throw storeError('UNSAFE_JOB_PATH');
    await fileSystem.unlink(temporary);
    return fileSystem.open(temporary, 'wx', 0o600);
  }

  async function atomicWrite(paths, manifest) {
    let serialized;
    try { serialized = `${JSON.stringify(manifest, null, 2)}\n`; } catch (_) { throw storeError('MANIFEST_WRITE_FAILED'); }
    if (Buffer.byteLength(serialized, 'utf8') > MANIFEST_LIMITS.bytes) throw storeError('INVALID_MANIFEST');
    let handle;
    try {
      handle = await openTemporary(paths.temporary);
      await handle.writeFile(serialized, { encoding: 'utf8' });
      await handle.sync();
      await handle.close();
      handle = null;
      await renameManifestWithRetry(paths.temporary, paths.manifest);
      await syncDirectory(paths.directory);
    } catch (error) {
      if (handle) try { await handle.close(); } catch (_) { /* bounded below */ }
      try { await removeTemporary(paths.temporary); } catch (_) { /* bounded below */ }
      if (error instanceof JobStoreError && error.code === 'INVALID_MANIFEST') throw error;
      throw storeError('MANIFEST_WRITE_FAILED');
    }
  }

  function statIdentity(stat) {
    return {
      dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size),
      mtimeMs: Number(stat.mtimeMs), ctimeMs: Number(stat.ctimeMs)
    };
  }

  function sameIdentity(left, right) {
    return left.dev === right.dev && left.ino === right.ino && left.size === right.size
      && left.mtimeMs === right.mtimeMs;
  }

  async function boundedRead(manifestPath) {
    let first;
    try { first = await fileSystem.lstat(manifestPath); } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw storeError('MANIFEST_READ_FAILED');
    }
    if (!first.isFile() || first.isSymbolicLink()) throw storeError('MANIFEST_READ_FAILED');
    const firstIdentity = statIdentity(first);
    if (!Number.isSafeInteger(firstIdentity.size) || firstIdentity.size < 0) throw storeError('MANIFEST_READ_FAILED');
    if (firstIdentity.size > MANIFEST_LIMITS.bytes) return { identity: firstIdentity, oversized: true };
    let handle;
    try {
      handle = await fileSystem.open(manifestPath, 'r');
      const opened = statIdentity(await handle.stat());
      if (!sameIdentity(firstIdentity, opened) || opened.size > MANIFEST_LIMITS.bytes) {
        await handle.close();
        return { identity: opened, changed: true };
      }
      const buffer = Buffer.alloc(opened.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const read = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!read || read.bytesRead === 0) break;
        offset += read.bytesRead;
      }
      const closedIdentity = statIdentity(await handle.stat());
      await handle.close();
      handle = null;
      if (!sameIdentity(opened, closedIdentity) || offset !== opened.size || offset > MANIFEST_LIMITS.bytes) {
        return { identity: closedIdentity, changed: true };
      }
      return { identity: opened, bytes: buffer.subarray(0, offset) };
    } catch (_) {
      if (handle) try { await handle.close(); } catch (_) { /* bounded below */ }
      throw storeError('MANIFEST_READ_FAILED');
    }
  }

  async function quarantine(paths, bytes) {
    let handle;
    let quarantinePath;
    let created = false;
    try {
      for (let attempt = 0; attempt < 1000; attempt += 1) {
        quarantineSequence += 1;
        quarantinePath = path.join(paths.directory, `${MANIFEST_NAME}.corrupt-${Date.now().toString(36)}-${process.pid}-${quarantineSequence}`);
        try {
          handle = await fileSystem.open(quarantinePath, 'wx', 0o600);
          created = true;
          break;
        } catch (error) {
          if (!error || error.code !== 'EEXIST') throw error;
        }
      }
      if (!handle) throw storeError('MANIFEST_QUARANTINE_FAILED');
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await syncDirectory(paths.directory);
      return true;
    } catch (_) {
      if (handle) {
        try { await handle.close(); } catch (_) { /* retain bounded failure */ }
      }
      if (created && quarantinePath) {
        try { await fileSystem.unlink(quarantinePath); } catch (_) { /* remove only our exclusive snapshot */ }
      }
      throw storeError('MANIFEST_QUARANTINE_FAILED');
    }
  }

  async function readManifest(id) {
    const paths = await openExistingJobDirectory(id);
    if (!paths) return null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const read = await boundedRead(paths.manifest);
      if (!read) return null;
      if (read.changed) continue;
      if (read.oversized) throw storeError('MANIFEST_READ_FAILED');
      try {
        const manifest = normalizeManifest(JSON.parse(read.bytes.toString('utf8')));
        if (manifest.id !== id) throw storeError('INVALID_MANIFEST');
        return manifest;
      } catch (_) { /* quarantine the exact raw bytes read below */ }
      const quarantined = await quarantine(paths, read.bytes);
      if (quarantined) throw storeError('CORRUPT_MANIFEST');
    }
    throw storeError('MANIFEST_READ_FAILED');
  }

  function runExclusive(id, operation) {
    assertSafeJobId(id);
    const previous = queues.get(id) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    queues.set(id, current);
    current.finally(() => {
      if (queues.get(id) === current) queues.delete(id);
    }).catch(() => undefined);
    return current;
  }

  async function create(initial = {}) {
    rejectUnknownFields(initial, TOP_FIELDS);
    const id = initial.id === undefined ? randomUUID() : initial.id;
    assertSafeJobId(id);
    if (initial.schemaVersion !== undefined && initial.schemaVersion !== MANIFEST_VERSION) throw storeError('UNSUPPORTED_MANIFEST_VERSION');
    const draft = {
      schemaVersion: MANIFEST_VERSION,
      id,
      state: initial.state === undefined ? 'discovering' : initial.state,
      revision: initial.revision === undefined ? 0 : initial.revision,
      config: initial.config,
      items: initial.items === undefined ? [] : initial.items,
      counters: initial.counters === undefined ? createEmptyCounters() : initial.counters,
      summary: initial.summary === undefined ? null : initial.summary,
      summaryDismissed: initial.summaryDismissed === true
    };
    for (const key of TOP_FIELDS) {
      if (!hasOwn(draft, key) && hasOwn(initial, key)) draft[key] = initial[key];
    }
    const safeManifest = normalizeManifest(draft);
    return runExclusive(id, async () => {
      const paths = jobPaths(id);
      await ensureRoot();
      try { await fileSystem.mkdir(paths.directory); } catch (error) {
        if (error && error.code === 'EEXIST') throw storeError('JOB_EXISTS');
        throw error;
      }
      const canonicalRoot = await fileSystem.realpath(rootDir);
      await assertContainedDirectory(paths.directory, canonicalRoot);
      await atomicWrite(paths, safeManifest);
      return cloneManifest(safeManifest);
    });
  }

  async function save(manifest) {
    const safeManifest = normalizeManifest(manifest);
    return runExclusive(safeManifest.id, async () => {
      const existing = await readManifest(safeManifest.id);
      if (existing) {
        if (JSON.stringify(existing) === JSON.stringify(safeManifest)) return cloneManifest(existing);
        if (safeManifest.revision <= existing.revision) throw storeError('STALE_MANIFEST_REVISION');
      }
      const paths = await ensureJobDirectory(safeManifest.id);
      await atomicWrite(paths, safeManifest);
      return cloneManifest(safeManifest);
    });
  }

  async function load(id) {
    assertSafeJobId(id);
    return runExclusive(id, () => readManifest(id));
  }

  async function list() {
    await ensureRoot();
    let entries;
    try { entries = await fileSystem.readdir(rootDir, { withFileTypes: true }); } catch (_) {
      throw storeError('MANIFEST_READ_FAILED');
    }
    const manifests = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !SAFE_JOB_ID.test(entry.name) || WINDOWS_RESERVED_NAME.test(entry.name)) continue;
      try {
        const manifest = await runExclusive(entry.name, () => readManifest(entry.name));
        if (manifest) manifests.push(manifest);
      } catch (error) {
        if (!error || error.code !== 'CORRUPT_MANIFEST') throw error;
      }
    }
    return manifests;
  }

  async function transition(id, patch) {
    assertSafeJobId(id);
    if (!isPlainObject(patch) || ['id', 'schemaVersion', 'revision'].some((key) => hasOwn(patch, key))) {
      throw storeError('INVALID_MANIFEST');
    }
    for (const key of Object.keys(patch)) {
      if (!TOP_FIELDS.has(key)) throw storeError(isSensitiveField(key) ? 'SENSITIVE_MANIFEST_DATA' : 'INVALID_MANIFEST');
    }
    return runExclusive(id, async () => {
      const current = await readManifest(id);
      if (!current) throw storeError('JOB_NOT_FOUND');
      const next = normalizeManifest({ ...current, ...patch, revision: current.revision + 1 });
      const paths = await ensureJobDirectory(id);
      await atomicWrite(paths, next);
      return cloneManifest(next);
    });
  }

  function normalizeFacts(value) {
    const known = new Set([
      'candidateExists', 'partialExists', 'finalExists',
      'sourceExists', 'backupExists', 'finalValid', 'partialFinalSameIdentity'
    ]);
    if (!isPlainObject(value)) return { valid: false };
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string' || !known.has(key))) return { valid: false };
    const result = { valid: true };
    for (const key of known) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) {
        result[key] = false;
        continue;
      }
      const localValue = descriptor.get ? descriptor.get.call(value) : descriptor.value;
      if (typeof localValue !== 'boolean' || descriptor.get || descriptor.set) return { valid: false };
      result[key] = localValue;
    }
    return result;
  }

  function recoveryAction(current, facts) {
    if (ENCODING_RECOVERY_STATES.has(current.state)) {
      if (facts.partialExists || facts.finalExists || facts.sourceExists || facts.backupExists || facts.finalValid) {
        return 'manual-intervention';
      }
      return facts.candidateExists || Object.keys(current.ownedPaths || {}).length > 0
        ? 'cleanup-and-restart-encoding' : 'restart-encoding';
    }
    if (current.state === 'waiting') return current.discoveryComplete === false ? 'resume-discovery' : 'resume-queue';
    if (PASSIVE_RECOVERY_ACTIONS[current.state]) return PASSIVE_RECOVERY_ACTIONS[current.state];
    if (current.state === 'copying') {
      if (facts.candidateExists || facts.sourceExists || facts.backupExists) return 'manual-intervention';
      if (facts.partialExists && facts.finalExists && facts.finalValid && facts.partialFinalSameIdentity) {
        return 'finalize-copy';
      }
      const key = `${Number(facts.partialExists)}${Number(facts.finalExists)}${Number(facts.finalValid)}`;
      return COPY_TRUTH_TABLE[key] || 'manual-intervention';
    }
    if (current.state === 'replacing') {
      const item = current.items.find((entry) => entry.id === current.activeItemId);
      if (!item?.expectedSource) return 'manual-intervention';
      if (facts.partialExists || facts.finalExists) return 'manual-intervention';
      const key = `${Number(facts.candidateExists)}${Number(facts.sourceExists)}${Number(facts.backupExists)}${Number(facts.finalValid)}`;
      return REPLACEMENT_TRUTH_TABLES[current.replacementPhase][key] || 'manual-intervention';
    }
    return 'manual-intervention';
  }

  async function recover(id, inspectPaths) {
    assertSafeJobId(id);
    if (typeof inspectPaths !== 'function') throw new TypeError('inspectPaths must be a function');
    return runExclusive(id, async () => {
      const current = await readManifest(id);
      if (!current) throw storeError('JOB_NOT_FOUND');
      if (TERMINAL_JOB_STATES.has(current.state)
          || ((current.state === 'paused' || current.state === 'paused_network') && current.recovery)) {
        return cloneManifest(current);
      }
      let facts;
      try {
        const inspected = await inspectPaths(cloneManifest(current));
        facts = normalizeFacts(inspected);
      } catch (_) {
        throw storeError('INSPECTION_FAILED');
      }
      const recovery = {
        fromState: ENCODING_RECOVERY_STATES.has(current.state) ? 'encoding' : current.state
      };
      if (current.state === 'replacing') recovery.phase = current.replacementPhase;
      recovery.action = facts.valid ? recoveryAction(current, facts) : 'manual-intervention';
      const recovered = normalizeManifest({ ...current, state: 'paused', revision: current.revision + 1, recovery });
      const paths = await ensureJobDirectory(id);
      await atomicWrite(paths, recovered);
      return cloneManifest(recovered);
    });
  }

  return Object.freeze({ create, save, load, list, transition, recover });
}

module.exports = {
  MANIFEST_VERSION,
  MANIFEST_LIMITS,
  JOB_STATES,
  REPLACEMENT_PHASES,
  JobStoreError,
  createJobStore
};
