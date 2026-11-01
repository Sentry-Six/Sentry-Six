'use strict';

const deepFreeze = (value) => {
  Object.freeze(value);
  Object.values(value).forEach((item) => {
    if (item && typeof item === 'object' && !Object.isFrozen(item)) deepFreeze(item);
  });
  return value;
};

const PROFILES = deepFreeze({
  conservative: { savings: 0.05, tolerance: 0.02 },
  balanced: { savings: 0.20, tolerance: 0.02 },
  aggressive: { savings: 0.50, tolerance: 0.02 }
});

const CODECS = deepFreeze({ H264: 'h264', H265: 'h265' });
const NETWORK_MODES = deepFreeze({ LOCAL: 'local', NETWORK: 'network' });
const OUTPUT_MODES = deepFreeze({ COPY: 'copy', CONVERT: 'convert' });
const ITEM_STATES = deepFreeze({ queued: 'queued', processing: 'processing', completed: 'completed', failed: 'failed', cancelled: 'cancelled' });
const TERMINAL_STATES = new Set([ITEM_STATES.completed, ITEM_STATES.failed, ITEM_STATES.cancelled]);
const GROUPS = ['RecentClips', 'SavedClips', 'SentryClips'];

function profile(name) {
  if (!PROFILES[name]) throw new RangeError(`Unknown conversion profile: ${name}`);
  return PROFILES[name];
}

function targetOutputBytes(sourceBytes, profileName) {
  return Math.round(sourceBytes * (1 - profile(profileName).savings));
}

function isWithinProfile(sourceBytes, outputBytes, profileName) {
  const selected = profile(profileName);
  const target = targetOutputBytes(sourceBytes, profileName);
  const tolerance = sourceBytes * selected.tolerance;
  return outputBytes >= target - tolerance && outputBytes <= target + tolerance;
}

function emptyGroup() {
  return { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 };
}

function createEmptyCounters() {
  return {
    files: 0,
    sourceVideoBytes: 0,
    outputVideoBytes: 0,
    savedBytes: 0,
    copiedAssetBytes: 0,
    groups: Object.fromEntries(GROUPS.map((group) => [group, emptyGroup()]))
  };
}

function addCompletedFile(counters, file) {
  if (!file || file.state !== ITEM_STATES.completed) return counters;
  const sourceBytes = Number(file.sourceBytes) || 0;
  const outputBytes = Number(file.outputBytes) || 0;
  const isAsset = file.kind === 'asset' || file.eligibleVideo === false;
  if (!isAsset && file.kind !== 'video') return counters;
  const next = { ...counters, groups: { ...counters.groups } };
  if (isAsset) {
    next.copiedAssetBytes += outputBytes;
    return next;
  }
  const savedBytes = sourceBytes - outputBytes;
  next.files += 1;
  next.sourceVideoBytes += sourceBytes;
  next.outputVideoBytes += outputBytes;
  next.savedBytes += savedBytes;
  if (GROUPS.includes(file.group)) {
    const current = counters.groups[file.group] || emptyGroup();
    next.groups[file.group] = {
      files: current.files + 1,
      sourceBytes: current.sourceBytes + sourceBytes,
      outputBytes: current.outputBytes + outputBytes,
      savedBytes: current.savedBytes + savedBytes
    };
  }
  return next;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) throw new RangeError('bytes must be a non-negative finite number');
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  const rendered = unit === 0 ? String(Math.round(value)) : value.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  return `${rendered} ${units[unit]}`;
}

function isTerminalState(state) { return TERMINAL_STATES.has(state); }

function serializeSummary(counters) {
  return {
    files: counters.files,
    sourceVideoBytes: counters.sourceVideoBytes,
    outputVideoBytes: counters.outputVideoBytes,
    savedBytes: counters.savedBytes,
    copiedAssetBytes: counters.copiedAssetBytes,
    source: formatBytes(counters.sourceVideoBytes),
    output: formatBytes(counters.outputVideoBytes),
    saved: formatBytes(counters.savedBytes),
    copiedAssets: formatBytes(counters.copiedAssetBytes),
    groups: JSON.parse(JSON.stringify(counters.groups))
  };
}

module.exports = { PROFILES, CODECS, NETWORK_MODES, OUTPUT_MODES, ITEM_STATES, createEmptyCounters, targetOutputBytes, isWithinProfile, addCompletedFile, formatBytes, isTerminalState, serializeSummary };
