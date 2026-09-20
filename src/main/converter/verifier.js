'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PROFILES, targetOutputBytes, isWithinProfile } = require('./contracts');

// A Tesla camera file can be a very short terminal fragment (for example a
// 1–2 second clip when the vehicle changes state). MP4/SEI/container overhead
// then dominates the byte target, so enforcing the normal percentage window
// would reject a valid, smaller, telemetry-complete conversion.
const SHORT_CLIP_PROFILE_MAX_US = 2_000_000;
const { RETRY_REASONS } = require('./encoderPlanner');
const { parseMp4, findBoxes, selectVideoTrack, buildSampleIndex } = require('./mp4');
const { extractH264TelemetryTimeline, mapTimelineToOutput } = require('./telemetryTimeline');
const { inspectH265Telemetry } = require('./h265Telemetry');
const { inspectAv1Telemetry } = require('./av1Telemetry');
const { createVerificationSnapshot } = require('./verificationSnapshot');

const VERIFICATION_REASONS = Object.freeze({
  INVALID_INPUT: 'invalid-input',
  SOURCE_UNREADABLE: 'source-unreadable',
  SOURCE_CHANGED: 'source-changed',
  SOURCE_INVALID: 'source-invalid',
  SOURCE_TIMELINE_MISMATCH: 'source-timeline-mismatch',
  CANDIDATE_UNREADABLE: 'candidate-unreadable',
  EMPTY_OUTPUT: 'empty-output',
  CANDIDATE_CHANGED: 'candidate-changed',
  SNAPSHOT_FAILED: 'snapshot-failed',
  SNAPSHOT_CLEANUP_FAILED: 'snapshot-cleanup-failed',
  SNAPSHOT_TRANSFER_FAILED: 'snapshot-transfer-failed',
  PROBE_FAILED: 'probe-failed',
  CODEC_MISMATCH: 'codec-mismatch',
  DIMENSION_MISMATCH: 'dimension-mismatch',
  DECODE_FAILED: 'decode-failed',
  CONTAINER_INVALID: 'container-invalid',
  DURATION_MISMATCH: 'duration-mismatch',
  FRAME_COUNT_MISMATCH: 'frame-count-mismatch',
  TELEMETRY_INVALID: 'telemetry-invalid',
  TELEMETRY_MISMATCH: 'telemetry-mismatch',
  NOT_SMALLER: 'not-smaller',
  PROFILE_SIZE: RETRY_REASONS.PROFILE_SIZE
});

const PROFILE_ALIASES = Object.freeze({
  'high-quality': 'conservative',
  smaller: 'aggressive'
});

const EXPECTED_VIDEO = Object.freeze({
  h265: Object.freeze({ codec: 'hevc', tag: 'hvc1', inspect: inspectH265Telemetry }),
  av1: Object.freeze({ codec: 'av1', tag: 'av01', inspect: inspectAv1Telemetry })
});

const FFPROBE_ENTRIES = [
  'stream=index,codec_type,codec_name,codec_tag_string,width,height,duration,nb_frames,nb_read_frames,avg_frame_rate,r_frame_rate',
  'format=duration'
].join(':');

const INSPECTOR_CODES = new Set([
  'INVALID_MP4',
  'INVALID_H265',
  'INVALID_AV1',
  'INVALID_AV1_TELEMETRY',
  'UNSUPPORTED_CONTAINER',
  'UNSUPPORTED_H265'
]);

const MAX_INSPECTOR_DIAGNOSTICS = 8;
const MAX_RATE_MULTIPLE = 16;

function failure(reason, sourceBytes, outputBytes, details = {}) {
  return {
    ok: false,
    reason,
    retryable: reason === VERIFICATION_REASONS.PROFILE_SIZE,
    sourceBytes,
    outputBytes,
    details
  };
}

function canonicalProfileId(profileId) {
  const canonical = PROFILE_ALIASES[profileId] || profileId;
  if (!Object.prototype.hasOwnProperty.call(PROFILES, canonical)) throw new RangeError('Unknown profile');
  return canonical;
}

function validateOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Options are required');
  if (typeof options.source !== 'string' || options.source.length === 0) throw new TypeError('Source path is required');
  if (typeof options.candidate !== 'string' || options.candidate.length === 0) throw new TypeError('Candidate path is required');
  if (!Object.prototype.hasOwnProperty.call(EXPECTED_VIDEO, options.codec)) throw new RangeError('Unsupported codec');
  if (typeof options.runFfprobe !== 'function') throw new TypeError('FFprobe runner is required');
  if (typeof options.runFullDecode !== 'function') throw new TypeError('Full-decode runner is required');
  if (options.ffprobePath !== undefined && (typeof options.ffprobePath !== 'string' || options.ffprobePath.length === 0)) throw new TypeError('FFprobe path must be non-empty');
  if (options.ffmpegPath !== undefined && (typeof options.ffmpegPath !== 'string' || options.ffmpegPath.length === 0)) throw new TypeError('FFmpeg path must be non-empty');
  if (options.stat !== undefined && typeof options.stat !== 'function') throw new TypeError('stat must be a function');
  if (options.readFile !== undefined && typeof options.readFile !== 'function') throw new TypeError('readFile must be a function');
  if (options.createSnapshot !== undefined && typeof options.createSnapshot !== 'function') throw new TypeError('createSnapshot must be a function');
  return canonicalProfileId(options.profileId);
}

function normalizeSize(size) {
  if (typeof size === 'bigint') {
    if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Unsafe file size');
    return Number(size);
  }
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError('Unsafe file size');
  return size;
}

async function statSize(stat, target) {
  const value = await Promise.resolve(stat(target));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid stat result');
  if (typeof value.isFile === 'function' && !value.isFile()) throw new TypeError('Path is not a file');
  return normalizeSize(value.size);
}

function processResultError(result, requireSilence) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { kind: 'invalid-runner-result' };
  if (!Number.isInteger(result.status) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') {
    return { kind: 'invalid-runner-result' };
  }
  for (const flag of ['timedOut', 'timeout']) {
    if (Object.prototype.hasOwnProperty.call(result, flag) && typeof result[flag] !== 'boolean') {
      return { kind: 'invalid-runner-result' };
    }
  }
  if (result.timedOut === true || result.timeout === true) return { kind: 'timeout', status: result.status };
  if (result.error !== undefined && result.error !== null) return { kind: 'runner-error', status: result.status };
  if (result.status !== 0) return { kind: 'non-zero-status', status: result.status };
  if (result.stderr.trim().length > 0) return { kind: 'stderr-output', status: result.status };
  if (requireSilence && result.stdout.trim().length > 0) return { kind: 'stdout-output', status: result.status };
  return null;
}

function parsePositiveInteger(value, field) {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^[1-9]\d*$/.test(text)) throw new TypeError(`Invalid ${field}`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TypeError(`Invalid ${field}`);
  return parsed;
}

function parseDurationUs(value) {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim().length === 0) {
    throw new TypeError('Invalid duration');
  }
  const seconds = Number(value);
  const microseconds = Math.round(seconds * 1_000_000);
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isSafeInteger(microseconds) || microseconds <= 0) {
    throw new TypeError('Invalid duration');
  }
  return microseconds;
}

function parseRate(value, field) {
  if (typeof value !== 'string' || value.length > 39) throw new TypeError(`Invalid ${field}`);
  const match = /^(\d{1,19})\/(\d{1,19})$/.exec(value);
  if (!match) throw new TypeError(`Invalid ${field}`);
  const numerator = BigInt(match[1]);
  const denominator = BigInt(match[2]);
  if (numerator <= 0n || denominator <= 0n || numerator > BigInt(Number.MAX_SAFE_INTEGER)
      || denominator > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError(`Invalid ${field}`);
  const rate = Number(numerator) / Number(denominator);
  if (!Number.isFinite(rate) || rate <= 0) throw new TypeError(`Invalid ${field}`);
  return { numerator, denominator, text: `${numerator}/${denominator}`, value: rate };
}

function parseProbeMetadata(stdout) {
  if (stdout.length > 1_000_000) return { error: { kind: 'invalid-metadata' } };
  let document;
  try {
    document = JSON.parse(stdout);
  } catch (_error) {
    return { error: { kind: 'malformed-json' } };
  }
  try {
    if (!document || typeof document !== 'object' || Array.isArray(document)) throw new TypeError('Invalid document');
    if (!Array.isArray(document.streams) || document.streams.length !== 1) throw new TypeError('Invalid streams');
    const stream = document.streams[0];
    if (!stream || typeof stream !== 'object' || Array.isArray(stream)) throw new TypeError('Invalid stream');
    if (!Number.isInteger(stream.index) || stream.index < 0 || stream.codec_type !== 'video') throw new TypeError('Invalid stream identity');
    if (typeof stream.codec_name !== 'string' || !/^[a-zA-Z0-9_.-]{1,64}$/.test(stream.codec_name)) throw new TypeError('Invalid codec');
    if (typeof stream.codec_tag_string !== 'string' || !/^[a-zA-Z0-9_.-]{1,64}$/.test(stream.codec_tag_string)) throw new TypeError('Invalid tag');
    const durationValue = stream.duration === undefined ? document.format?.duration : stream.duration;
    const durationUs = parseDurationUs(durationValue);
    const frameCount = parsePositiveInteger(stream.nb_read_frames, 'frame count');
    if (stream.nb_frames !== undefined && stream.nb_frames !== 'N/A') {
      const declaredFrameCount = parsePositiveInteger(stream.nb_frames, 'declared frame count');
      if (declaredFrameCount !== frameCount) throw new TypeError('Conflicting frame counts');
    }
    const averageRate = parseRate(stream.avg_frame_rate, 'average frame rate');
    const realRate = parseRate(stream.r_frame_rate, 'real frame rate');
    return {
      metadata: {
        codec: stream.codec_name.toLowerCase(),
        tag: stream.codec_tag_string.toLowerCase(),
        width: parsePositiveInteger(stream.width, 'width'),
        height: parsePositiveInteger(stream.height, 'height'),
        durationUs,
        frameCount,
        averageRate,
        realRate
      }
    };
  } catch (_error) {
    return { error: { kind: 'invalid-metadata' } };
  }
}

function ffprobeArgs(target) {
  return [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-count_frames',
    '-show_entries', FFPROBE_ENTRIES,
    '-of', 'json',
    target
  ];
}

async function probeTarget(options, target, label) {
  let result;
  try {
    result = await Promise.resolve(options.runFfprobe(options.ffprobePath ?? 'ffprobe', ffprobeArgs(target), {
      windowsHide: true,
      shell: false
    }));
  } catch (_error) {
    return { error: { target: label, kind: 'runner-threw' } };
  }
  try {
    const runnerError = processResultError(result, false);
    if (runnerError) return { error: { target: label, ...runnerError } };
    const parsed = parseProbeMetadata(result.stdout);
    if (parsed.error) return { error: { target: label, ...parsed.error } };
    return { metadata: parsed.metadata };
  } catch (_error) {
    return { error: { target: label, kind: 'invalid-runner-result' } };
  }
}

function decodeArgs(candidate) {
  return [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-err_detect', 'explode',
    '-i', candidate,
    '-map', '0:v:0', '-an', '-sn', '-dn',
    '-f', 'null', '-'
  ];
}

async function runCompleteDecode(options, candidate) {
  let result;
  try {
    result = await Promise.resolve(options.runFullDecode(options.ffmpegPath ?? 'ffmpeg', decodeArgs(candidate), {
      windowsHide: true,
      shell: false
    }));
  } catch (_error) {
    return { kind: 'runner-threw' };
  }
  try {
    // The null muxer reports harmless duplicate-PTS warnings for Tesla VFR
    // clips even when decoding exits successfully. Keep strict handling for
    // all other stderr, including real decoder errors.
    const tolerated = /^\[null[^\r\n]*\] Application provided invalid, non monotonically increasing dts to muxer in stream 0: \d+ >= \d+\r?\n?/gm;
    const normalized = result.status === 0 ? { ...result, stderr: result.stderr.replace(tolerated, '') } : result;
    return processResultError(normalized, true);
  } catch (_error) {
    return { kind: 'invalid-runner-result' };
  }
}

function safeOffset(value) {
  if (typeof value !== 'bigint' || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Unsafe MP4 offset');
  return Number(value);
}

function readTrackTimescale(tree, track) {
  const boxes = findBoxes(track, 'mdhd');
  if (boxes.length !== 1) throw new Error('Video track must contain one mdhd');
  const node = boxes[0];
  const start = safeOffset(node.contentStart);
  const end = safeOffset(node.end);
  if (end - start < 4) throw new Error('Truncated mdhd');
  const version = tree.buffer.readUInt8(start);
  const timescaleOffset = version === 0 ? 12 : version === 1 ? 20 : null;
  if (timescaleOffset === null || end - start < timescaleOffset + 4) throw new Error('Invalid mdhd');
  const timescale = tree.buffer.readUInt32BE(start + timescaleOffset);
  if (timescale === 0) throw new Error('Invalid timescale');
  return timescale;
}

function ticksToMicroseconds(ticks, timescale) {
  if (typeof ticks !== 'bigint') throw new TypeError('Invalid timestamp');
  const divisor = BigInt(timescale);
  const scaled = ticks * 1_000_000n;
  const rounded = scaled >= 0n
    ? (scaled + divisor / 2n) / divisor
    : -((-scaled + divisor / 2n) / divisor);
  if (rounded < BigInt(Number.MIN_SAFE_INTEGER) || rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Unsafe timestamp');
  }
  return Number(rounded);
}

function readVisualDimensions(tree, track) {
  const descriptions = findBoxes(track, 'stsd');
  if (descriptions.length !== 1) throw new Error('Video requires one sample description table');
  const payload = tree.buffer.subarray(Number(descriptions[0].contentStart), Number(descriptions[0].end));
  if (payload.length < 16 || payload.readUInt32BE(0) !== 0 || payload.readUInt32BE(4) !== 1) {
    throw new Error('Video requires one visual sample entry');
  }
  const entry = payload.subarray(8);
  const extended = entry.readUInt32BE(0) === 1;
  const headerSize = extended ? 16 : 8;
  if (entry.length < headerSize + 78) throw new Error('Truncated visual sample entry');
  const entrySize = extended ? entry.readBigUInt64BE(8) : BigInt(entry.readUInt32BE(0));
  if (entrySize !== BigInt(entry.length) || !['avc1', 'avc3', 'hvc1', 'hev1', 'av01'].includes(entry.toString('ascii', 4, 8))) {
    throw new Error('Invalid visual sample entry');
  }
  const width = entry.readUInt16BE(headerSize + 24);
  const height = entry.readUInt16BE(headerSize + 26);
  if (width === 0 || height === 0) throw new Error('Video dimensions must be nonzero');
  return { width, height };
}

function readOutputTiming(candidateBytes) {
  const tree = parseMp4(candidateBytes);
  const track = selectVideoTrack(tree);
  const dimensions = readVisualDimensions(tree, track);
  const indexed = buildSampleIndex(track);
  if (indexed.length === 0) throw new Error('Video track has no samples');
  const timescale = readTrackTimescale(tree, track);
  let totalTicks = 0n;
  const durationTicks = [];
  const samples = indexed.map((sample, index) => {
    if (sample.duration <= 0n && !(index === indexed.length - 1 && sample.duration === 0n)) {
      throw new Error('Sample duration must be positive');
    }
    totalTicks += sample.duration;
    durationTicks.push(sample.duration);
    const ptsUs = ticksToMicroseconds(sample.pts, timescale);
    const durationUs = ticksToMicroseconds(sample.duration, timescale);
    if (!Number.isSafeInteger(ptsUs) || !Number.isSafeInteger(durationUs) || durationUs < 0) {
      throw new Error('Invalid sample timing');
    }
    return { ptsUs, durationUs };
  });
  const durationUs = ticksToMicroseconds(totalTicks, timescale);
  const positiveSamples = samples.filter((sample) => sample.durationUs > 0);
  const minDurationUs = positiveSamples.reduce((minimum, sample) => Math.min(minimum, sample.durationUs), Number.MAX_SAFE_INTEGER);
  const maxDurationUs = positiveSamples.reduce((maximum, sample) => Math.max(maximum, sample.durationUs), 0);
  const durationToleranceUs = positiveSamples.reduce((maximum, sample) => Math.max(maximum, sample.durationUs), 0);
  if (!Number.isSafeInteger(durationUs) || durationUs <= 0 || !Number.isSafeInteger(minDurationUs) || minDurationUs <= 0
      || !Number.isSafeInteger(maxDurationUs) || maxDurationUs <= 0 || !Number.isSafeInteger(durationToleranceUs) || durationToleranceUs <= 0) {
    throw new Error('Invalid video timing');
  }
  return {
    ...dimensions,
    samples,
    durationUs,
    durationToleranceUs,
    sampleTimingProof: {
      nonuniform: durationTicks.some((duration) => duration !== durationTicks[0]),
      minDurationUs,
      maxDurationUs
    }
  };
}

function proveVfr(metadata, timing) {
  const { averageRate, realRate } = metadata;
  const rateDiffers = averageRate.numerator * realRate.denominator
    !== realRate.numerator * averageRate.denominator;
  const sampleTiming = timing.sampleTimingProof;
  if (!rateDiffers || !sampleTiming.nonuniform || realRate.value <= averageRate.value) return null;
  if (sampleTiming.maxDurationUs / sampleTiming.minDurationUs > MAX_RATE_MULTIPLE) return null;

  const framesAtAverageRate = (timing.durationUs * averageRate.value) / 1_000_000;
  if (!Number.isFinite(framesAtAverageRate) || Math.abs(framesAtAverageRate - timing.samples.length) > 0.001) return null;
  const durationMultiples = timing.samples.map((sample) => (sample.durationUs * realRate.value) / 1_000_000);
  const durationsUseRealRateGrid = durationMultiples.every((multiple) => {
    const rounded = Math.round(multiple);
    return rounded >= 1 && rounded <= MAX_RATE_MULTIPLE && Math.abs(multiple - rounded) <= 0.001;
  });
  if (!durationsUseRealRateGrid) return null;

  return {
    frameRateProof: {
      output: { average: averageRate.text, real: realRate.text }
    },
    sampleTimingProof: { ...sampleTiming }
  };
}

function normalizeSourceTimeline(timeline) {
  if (!timeline || typeof timeline !== 'object' || !Array.isArray(timeline.samples) || !Array.isArray(timeline.events)) {
    throw new TypeError('Invalid source timeline');
  }
  const normalizedRecords = [];
  const samples = timeline.samples.map((sample, index) => {
    if (!sample || !Number.isFinite(sample.ptsUs) || !Number.isFinite(sample.durationUs)
        || (sample.durationUs <= 0 && !(index === timeline.samples.length - 1 && sample.durationUs === 0))
        || typeof sample.hasTelemetry !== 'boolean') {
      throw new TypeError('Invalid source sample');
    }
    if (sample.sampleIndex !== undefined && sample.sampleIndex !== index) throw new TypeError('Invalid source sample index');
    if (!Array.isArray(sample.seiNals)) throw new TypeError('Invalid source sample telemetry');
    const seiNals = sample.seiNals.map((record) => {
      if (!record || !Buffer.isBuffer(record.nal) || record.nal.length === 0 || typeof record.fingerprint !== 'string'
          || !/^[a-f0-9]{64}$/.test(record.fingerprint)) throw new TypeError('Invalid source sample telemetry');
      const normalized = { nal: Buffer.from(record.nal), fingerprint: record.fingerprint };
      normalizedRecords.push({
        sourceSampleIndex: index,
        sourcePtsUs: sample.ptsUs,
        ...normalized
      });
      return normalized;
    });
    if (sample.hasTelemetry !== (seiNals.length > 0)) throw new TypeError('Inconsistent source telemetry gap');
    return {
      sampleIndex: index,
      ptsUs: sample.ptsUs,
      durationUs: sample.durationUs,
      hasTelemetry: sample.hasTelemetry,
      seiNals
    };
  });
  const events = timeline.events.map((event, index) => {
    if (!event || !Number.isInteger(event.sourceSampleIndex) || event.sourceSampleIndex < 0 || event.sourceSampleIndex >= samples.length) {
      throw new TypeError('Invalid source event index');
    }
    if (!Number.isFinite(event.sourcePtsUs) || event.sourcePtsUs !== samples[event.sourceSampleIndex].ptsUs || !Buffer.isBuffer(event.nal)) {
      throw new TypeError('Invalid source event');
    }
    if (event.nal.length === 0 || typeof event.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(event.fingerprint)) {
      throw new TypeError('Invalid source event fingerprint');
    }
    const normalized = {
      sourceSampleIndex: event.sourceSampleIndex,
      sourcePtsUs: event.sourcePtsUs,
      nal: Buffer.from(event.nal),
      fingerprint: event.fingerprint
    };
    const expected = normalizedRecords[index];
    if (!expected || expected.sourceSampleIndex !== normalized.sourceSampleIndex || expected.sourcePtsUs !== normalized.sourcePtsUs
        || expected.fingerprint !== normalized.fingerprint || !expected.nal.equals(normalized.nal)) {
      throw new TypeError('Source events do not match ordered sample telemetry');
    }
    return normalized;
  });
  if (events.length !== normalizedRecords.length) throw new TypeError('Source event count does not match sample telemetry');
  return { samples, events };
}

function sameTimeline(left, right) {
  if (left.samples.length !== right.samples.length || left.events.length !== right.events.length) return false;
  for (let index = 0; index < left.samples.length; index += 1) {
    const leftSample = left.samples[index];
    const rightSample = right.samples[index];
    if (leftSample.sampleIndex !== rightSample.sampleIndex || leftSample.ptsUs !== rightSample.ptsUs
        || leftSample.durationUs !== rightSample.durationUs || leftSample.hasTelemetry !== rightSample.hasTelemetry
        || leftSample.seiNals.length !== rightSample.seiNals.length) return false;
    for (let recordIndex = 0; recordIndex < leftSample.seiNals.length; recordIndex += 1) {
      const leftRecord = leftSample.seiNals[recordIndex];
      const rightRecord = rightSample.seiNals[recordIndex];
      if (leftRecord.fingerprint !== rightRecord.fingerprint || !leftRecord.nal.equals(rightRecord.nal)) return false;
    }
  }
  return left.events.every((event, index) => {
    const other = right.events[index];
    return event.sourceSampleIndex === other.sourceSampleIndex && event.sourcePtsUs === other.sourcePtsUs
      && event.fingerprint === other.fingerprint && event.nal.equals(other.nal);
  });
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameRanges(left, right) {
  return left.length === right.length && left.every((range, index) => (
    range[0] === right[index][0] && range[1] === right[index][1]
  ));
}

function gapRanges(samples, getRecords) {
  const ranges = [];
  let start = null;
  samples.forEach((sample, index) => {
    const gap = getRecords(sample).length === 0;
    if (gap && start === null) start = index;
    if (!gap && start !== null) {
      ranges.push([start, index - 1]);
      start = null;
    }
  });
  if (start !== null) ranges.push([start, samples.length - 1]);
  return ranges;
}

function transitionIndexes(samples, getRecords) {
  const transitions = [];
  for (let index = 1; index < samples.length; index += 1) {
    if ((getRecords(samples[index - 1]).length > 0) !== (getRecords(samples[index]).length > 0)) transitions.push(index);
  }
  return transitions;
}

function compareTelemetry(expected, inspected) {
  if (!Array.isArray(inspected.samples) || inspected.samples.length !== expected.length) {
    return { kind: 'sample-count', expectedSamples: expected.length, actualSamples: Array.isArray(inspected.samples) ? inspected.samples.length : null };
  }
  for (let index = 0; index < inspected.samples.length; index += 1) {
    const sample = inspected.samples[index];
    if (!sample || sample.pictureMarkerCount !== 1 || sample.hasPictureMarker !== true) {
      return { kind: 'picture-markers', sampleIndex: index, markerCount: sample?.pictureMarkerCount ?? null };
    }
    if (!Array.isArray(sample.telemetryFingerprints) || sample.telemetryFingerprints.some((value) => typeof value !== 'string')) {
      return { kind: 'invalid-inspector-data', sampleIndex: index };
    }
  }
  const expectedGaps = gapRanges(expected, (sample) => sample.seiNals);
  const actualGaps = gapRanges(inspected.samples, (sample) => sample.telemetryFingerprints);
  if (!sameRanges(expectedGaps, actualGaps)) {
    return { kind: 'gap-ranges', expectedGapRanges: expectedGaps, actualGapRanges: actualGaps };
  }
  const expectedTransitions = transitionIndexes(expected, (sample) => sample.seiNals);
  const actualTransitions = transitionIndexes(inspected.samples, (sample) => sample.telemetryFingerprints);
  if (!sameArray(expectedTransitions, actualTransitions)) {
    return { kind: 'transitions', expectedTransitions, actualTransitions };
  }
  for (let index = 0; index < expected.length; index += 1) {
    const expectedFingerprints = expected[index].seiNals.map((record) => record.fingerprint);
    const actualFingerprints = inspected.samples[index].telemetryFingerprints;
    if (!sameArray(expectedFingerprints, actualFingerprints)) {
      return {
        kind: 'fingerprint-order',
        sampleIndex: index,
        expectedCount: expectedFingerprints.length,
        actualCount: actualFingerprints.length
      };
    }
  }
  return null;
}

function inspectorArea(path) {
  if (typeof path !== 'string') return 'unknown';
  const prefix = path.slice(0, 32);
  if (/^tracks?(?:\[|\.|$)/.test(prefix)) return 'tracks';
  if (/^samples?(?:\[|\.|$)/.test(prefix)) return 'samples';
  if (/^telemetry(?:\[|\.|$)/.test(prefix)) return 'telemetry';
  if (/^mdat(?:\[|\.|$)/.test(prefix)) return 'media';
  return 'unknown';
}

function sanitizeInspectorDiagnostics(validationErrors) {
  if (!Array.isArray(validationErrors)) return [];
  try {
    return validationErrors.slice(0, MAX_INSPECTOR_DIAGNOSTICS).map((error) => {
      let code;
      let path;
      try {
        code = error?.code;
        path = error?.path;
      } catch (_error) {
        return { code: 'INVALID_OUTPUT', area: 'unknown' };
      }
      return {
        code: INSPECTOR_CODES.has(code) ? code : 'INVALID_OUTPUT',
        area: inspectorArea(path)
      };
    });
  } catch (_error) {
    return [];
  }
}

function bytesSha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sameFilesystemPath(left, right) {
  try {
    const windowsPath = /^[a-zA-Z]:[\\/]/.test(left) || /^[a-zA-Z]:[\\/]/.test(right);
    if (windowsPath) return path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase();
    return path.resolve(left) === path.resolve(right);
  } catch (_error) {
    return true;
  }
}

function normalizeSnapshotContract(snapshot, options, outputBytes, outputSha256) {
  try {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
    const snapshotPath = snapshot.path;
    const token = snapshot.token;
    const read = snapshot.read;
    const cleanup = snapshot.cleanup;
    const transfer = snapshot.transfer;
    const declaredSize = snapshot.size;
    const declaredSha256 = snapshot.sha256;
    if (typeof snapshotPath !== 'string' || snapshotPath.length === 0 || snapshotPath.length > 32_767
        || snapshotPath.includes('\0') || sameFilesystemPath(snapshotPath, options.candidate) || sameFilesystemPath(snapshotPath, options.source)
        || typeof token !== 'string' || token.length === 0 || token.length > 256
        || typeof read !== 'function' || typeof cleanup !== 'function' || typeof transfer !== 'function'
        || (declaredSize !== undefined && declaredSize !== outputBytes)
        || (declaredSha256 !== undefined && declaredSha256 !== outputSha256)) return null;
    return Object.freeze({
      path: snapshotPath,
      token,
      read: (...args) => Reflect.apply(read, snapshot, args),
      cleanup: (...args) => Reflect.apply(cleanup, snapshot, args),
      transfer: (...args) => Reflect.apply(transfer, snapshot, args)
    });
  } catch (_error) {
    return null;
  }
}

async function readExactSnapshot(snapshot, outputBytes, outputSha256) {
  const bytes = await Promise.resolve(snapshot.read());
  if (!Buffer.isBuffer(bytes) || bytes.length !== outputBytes || bytesSha256(bytes) !== outputSha256) {
    throw new Error('Snapshot integrity failed');
  }
  return Buffer.from(bytes);
}

async function cleanupFailure(snapshot, result) {
  try {
    await Promise.resolve(snapshot.cleanup());
    return result;
  } catch (_error) {
    return failure(VERIFICATION_REASONS.SNAPSHOT_CLEANUP_FAILED, result.sourceBytes, result.outputBytes, {
      kind: 'cleanup-failed',
      priorReason: result.reason
    });
  }
}

function timelineMatchesTiming(timeline, timing) {
  return timeline.samples.length === timing.samples.length && timeline.samples.every((sample, index) => (
    sample.ptsUs === timing.samples[index].ptsUs && sample.durationUs === timing.samples[index].durationUs
  ));
}

// Some Tesla H.264 clips carry a terminal zero-duration sample in stts. It is
// a container bookkeeping sample (there is no display interval to verify), and
// encoders legitimately omit it from the output track. Keep it in the source
// timeline used for telemetry writing, but exclude it from source timing
// equivalence checks so verification can compare the real media intervals.
function trimTerminalZeroDurationSample(timeline) {
  if (!timeline || !Array.isArray(timeline.samples) || timeline.samples.length === 0) return timeline;
  const last = timeline.samples[timeline.samples.length - 1];
  if (last?.durationUs !== 0) return timeline;
  const samples = timeline.samples.slice(0, -1);
  const events = timeline.events.filter((event) => event?.sourceSampleIndex < samples.length);
  return { ...timeline, samples, events };
}

async function readSourceAuthority(options, readFile, sourceBytes, outputBytes) {
  let sourceFileBytes;
  try {
    sourceFileBytes = await Promise.resolve(readFile(options.source));
  } catch (_error) {
    return { error: failure(VERIFICATION_REASONS.SOURCE_UNREADABLE, sourceBytes, outputBytes, { kind: 'read-failed' }) };
  }
  if (!Buffer.isBuffer(sourceFileBytes) || sourceFileBytes.length === 0) {
    return { error: failure(VERIFICATION_REASONS.SOURCE_UNREADABLE, sourceBytes, outputBytes, { kind: 'invalid-bytes' }) };
  }
  if (sourceFileBytes.length !== sourceBytes) {
    return { error: failure(VERIFICATION_REASONS.SOURCE_CHANGED, sourceBytes, outputBytes, {
      statBytes: sourceBytes,
      readBytes: sourceFileBytes.length
    }) };
  }

  let sourceTimeline;
  let sourceTiming;
  try {
    sourceTimeline = normalizeSourceTimeline(extractH264TelemetryTimeline(sourceFileBytes));
    sourceTiming = readOutputTiming(sourceFileBytes);
    if (sourceTiming.samples.at(-1)?.durationUs === 0) sourceTiming = {
      ...sourceTiming,
      samples: sourceTiming.samples.slice(0, -1),
      durationUs: sourceTiming.samples.at(-1)?.ptsUs || sourceTiming.durationUs
    };
    if (!timelineMatchesTiming(trimTerminalZeroDurationSample(sourceTimeline), sourceTiming)) throw new Error('Source timing mismatch');
  } catch (_error) {
    return { error: failure(VERIFICATION_REASONS.SOURCE_INVALID, sourceBytes, outputBytes, { kind: 'h264-container' }) };
  }

  if (options.sourceTimeline !== undefined) {
    let cachedTimeline;
    try {
      cachedTimeline = normalizeSourceTimeline(options.sourceTimeline);
    } catch (_error) {
      return { error: failure(VERIFICATION_REASONS.SOURCE_TIMELINE_MISMATCH, sourceBytes, outputBytes, { kind: 'cache-invalid' }) };
    }
    if (!sameTimeline(cachedTimeline, sourceTimeline)) {
      return { error: failure(VERIFICATION_REASONS.SOURCE_TIMELINE_MISMATCH, sourceBytes, outputBytes, { kind: 'cache-mismatch' }) };
    }
  }
  return { sourceTimeline, sourceTiming };
}

async function verifyOwnedSnapshot({ options, profileId, sourceBytes, outputBytes, outputSha256, snapshot, readFile }) {
  const source = await readSourceAuthority(options, readFile, sourceBytes, outputBytes);
  if (source.error) return source.error;

  const expectedVideo = EXPECTED_VIDEO[options.codec];
  const candidateProbe = await probeTarget(options, snapshot.path, 'candidate');
  if (candidateProbe.error) return failure(VERIFICATION_REASONS.PROBE_FAILED, sourceBytes, outputBytes, candidateProbe.error);
  if (candidateProbe.metadata.codec !== expectedVideo.codec || candidateProbe.metadata.tag !== expectedVideo.tag) {
    return failure(VERIFICATION_REASONS.CODEC_MISMATCH, sourceBytes, outputBytes, {
      kind: 'unexpected-codec-tag',
      expectedCodec: expectedVideo.codec,
      expectedTag: expectedVideo.tag
    });
  }

  const decodeError = await runCompleteDecode(options, snapshot.path);
  if (decodeError) return failure(VERIFICATION_REASONS.DECODE_FAILED, sourceBytes, outputBytes, decodeError);

  let candidateSnapshotBytes;
  try {
    candidateSnapshotBytes = await readExactSnapshot(snapshot, outputBytes, outputSha256);
  } catch (_error) {
    return failure(VERIFICATION_REASONS.SNAPSHOT_FAILED, sourceBytes, outputBytes, { kind: 'integrity-failed' });
  }

  let outputTiming;
  try {
    outputTiming = readOutputTiming(candidateSnapshotBytes);
  } catch (_error) {
    return failure(VERIFICATION_REASONS.CONTAINER_INVALID, sourceBytes, outputBytes, { kind: 'sample-timing' });
  }

  if (candidateProbe.metadata.frameCount !== outputTiming.samples.length) {
    return failure(VERIFICATION_REASONS.FRAME_COUNT_MISMATCH, sourceBytes, outputBytes, {
      kind: 'probe-container',
      probeFrames: candidateProbe.metadata.frameCount,
      containerSamples: outputTiming.samples.length
    });
  }
  if (['width', 'height'].some((dimension) => source.sourceTiming[dimension] !== outputTiming[dimension]
      || candidateProbe.metadata[dimension] !== outputTiming[dimension])) {
    return failure(VERIFICATION_REASONS.DIMENSION_MISMATCH, sourceBytes, outputBytes, {
      source: { width: source.sourceTiming.width, height: source.sourceTiming.height },
      output: { width: outputTiming.width, height: outputTiming.height },
      probe: { width: candidateProbe.metadata.width, height: candidateProbe.metadata.height }
    });
  }
  if (Math.abs(candidateProbe.metadata.durationUs - outputTiming.durationUs) > outputTiming.durationToleranceUs) {
    return failure(VERIFICATION_REASONS.DURATION_MISMATCH, sourceBytes, outputBytes, {
      kind: 'probe-container',
      probeDurationUs: candidateProbe.metadata.durationUs,
      containerDurationUs: outputTiming.durationUs,
      toleranceUs: outputTiming.durationToleranceUs
    });
  }

  const durationDeltaUs = Math.abs(source.sourceTiming.durationUs - outputTiming.durationUs);
  if (durationDeltaUs > outputTiming.durationToleranceUs) {
    return failure(VERIFICATION_REASONS.DURATION_MISMATCH, sourceBytes, outputBytes, {
      kind: 'source-output',
      sourceDurationUs: source.sourceTiming.durationUs,
      outputDurationUs: outputTiming.durationUs,
      deltaUs: durationDeltaUs,
      toleranceUs: outputTiming.durationToleranceUs
    });
  }

  const vfrProof = proveVfr(candidateProbe.metadata, outputTiming);
  const vfr = vfrProof !== null;
  const frameCountTolerance = vfr ? 1 : 0;
  const frameDelta = Math.abs(source.sourceTiming.samples.length - outputTiming.samples.length);
  const safeFrameRateProof = vfrProof?.frameRateProof || {
    output: {
      average: candidateProbe.metadata.averageRate.text,
      real: candidateProbe.metadata.realRate.text
    }
  };
  if (frameDelta > frameCountTolerance) {
    return failure(VERIFICATION_REASONS.FRAME_COUNT_MISMATCH, sourceBytes, outputBytes, {
      kind: 'source-output',
      mode: vfr ? 'vfr' : 'cfr',
      sourceFrames: source.sourceTiming.samples.length,
      outputFrames: outputTiming.samples.length,
      frameDelta,
      toleranceFrames: frameCountTolerance,
      frameRateProof: safeFrameRateProof,
      ...(vfr ? { sampleTimingProof: vfrProof.sampleTimingProof } : {})
    });
  }

  let inspected;
  try {
    inspected = expectedVideo.inspect(candidateSnapshotBytes);
  } catch (_error) {
    return failure(VERIFICATION_REASONS.TELEMETRY_INVALID, sourceBytes, outputBytes, { kind: 'inspector-threw' });
  }
  if (!inspected || typeof inspected !== 'object' || inspected.accepted !== true || inspected.layoutValid !== true
      || inspected.sampleEntry !== expectedVideo.tag || inspected.sampleCount !== outputTiming.samples.length) {
    return failure(VERIFICATION_REASONS.TELEMETRY_INVALID, sourceBytes, outputBytes, {
      kind: 'inspector-rejected',
      validationErrors: sanitizeInspectorDiagnostics(inspected?.validationErrors),
      inspectedSamples: Number.isSafeInteger(inspected?.sampleCount) ? inspected.sampleCount : null,
      expectedSamples: outputTiming.samples.length
    });
  }

  let expectedTimeline;
  try {
    expectedTimeline = mapTimelineToOutput(source.sourceTimeline, outputTiming.samples);
  } catch (_error) {
    return failure(VERIFICATION_REASONS.TELEMETRY_INVALID, sourceBytes, outputBytes, { kind: 'timeline-mapping' });
  }
  const mappedEventCount = expectedTimeline.reduce((sum, sample) => sum + sample.seiNals.length, 0);
  if (mappedEventCount !== source.sourceTimeline.events.length) {
    return failure(VERIFICATION_REASONS.TELEMETRY_MISMATCH, sourceBytes, outputBytes, {
      kind: 'unmapped-source-events',
      sourceEvents: source.sourceTimeline.events.length,
      mappedEvents: mappedEventCount
    });
  }
  const telemetryMismatch = compareTelemetry(expectedTimeline, inspected);
  if (telemetryMismatch) return failure(VERIFICATION_REASONS.TELEMETRY_MISMATCH, sourceBytes, outputBytes, telemetryMismatch);

  if (outputBytes >= sourceBytes) {
    return failure(VERIFICATION_REASONS.NOT_SMALLER, sourceBytes, outputBytes, { savedBytes: sourceBytes - outputBytes });
  }
  const targetBytes = targetOutputBytes(sourceBytes, profileId);
  const shortClipWithSavings = sourceBytes >= 500_000
    && source.sourceTiming.durationUs <= SHORT_CLIP_PROFILE_MAX_US
    && outputBytes < sourceBytes;
  if (!shortClipWithSavings && !isWithinProfile(sourceBytes, outputBytes, profileId)) {
    return failure(VERIFICATION_REASONS.PROFILE_SIZE, sourceBytes, outputBytes, {
      profileId,
      targetBytes,
      toleranceBytes: sourceBytes * PROFILES[profileId].tolerance
    });
  }

  const actualGaps = gapRanges(inspected.samples, (sample) => sample.telemetryFingerprints);
  const actualTransitions = transitionIndexes(inspected.samples, (sample) => sample.telemetryFingerprints);
  return {
    ok: true,
    reason: null,
    retryable: false,
    sourceBytes,
    outputBytes,
    details: {
      codec: expectedVideo.codec,
      tag: expectedVideo.tag,
      profileId,
      targetBytes,
      sourceDurationUs: source.sourceTiming.durationUs,
      outputDurationUs: outputTiming.durationUs,
      durationToleranceUs: outputTiming.durationToleranceUs,
      sourceFrames: source.sourceTiming.samples.length,
      outputFrames: outputTiming.samples.length,
      frameCountMode: vfr ? 'vfr' : 'cfr',
      frameCountTolerance,
      frameRateProof: safeFrameRateProof,
      ...(vfr ? { sampleTimingProof: vfrProof.sampleTimingProof } : {}),
      telemetryEvents: mappedEventCount,
      telemetryTransitions: actualTransitions,
      telemetryGapRanges: actualGaps
    }
  };
}

async function verifyCandidate(options) {
  let sourceBytes = null;
  let outputBytes = null;
  let profileId;
  try {
    profileId = validateOptions(options);
  } catch (_error) {
    return failure(VERIFICATION_REASONS.INVALID_INPUT, sourceBytes, outputBytes, { kind: 'invalid-options' });
  }

  const stat = options.stat || fs.promises.stat.bind(fs.promises);
  const readFile = options.readFile || fs.promises.readFile.bind(fs.promises);
  try {
    sourceBytes = await statSize(stat, options.source);
  } catch (_error) {
    return failure(VERIFICATION_REASONS.SOURCE_UNREADABLE, sourceBytes, outputBytes, { kind: 'stat-failed' });
  }
  if (sourceBytes === 0) return failure(VERIFICATION_REASONS.SOURCE_UNREADABLE, sourceBytes, outputBytes, { kind: 'empty-source' });

  try {
    outputBytes = await statSize(stat, options.candidate);
  } catch (_error) {
    return failure(VERIFICATION_REASONS.CANDIDATE_UNREADABLE, sourceBytes, outputBytes, { kind: 'stat-failed' });
  }
  if (outputBytes === 0) return failure(VERIFICATION_REASONS.EMPTY_OUTPUT, sourceBytes, outputBytes, { kind: 'empty-file' });

  let candidateBytes;
  try {
    candidateBytes = await Promise.resolve(readFile(options.candidate));
  } catch (_error) {
    return failure(VERIFICATION_REASONS.CANDIDATE_UNREADABLE, sourceBytes, outputBytes, { kind: 'read-failed' });
  }
  if (!Buffer.isBuffer(candidateBytes) || candidateBytes.length === 0) {
    return failure(VERIFICATION_REASONS.CANDIDATE_UNREADABLE, sourceBytes, outputBytes, { kind: 'invalid-bytes' });
  }
  if (candidateBytes.length !== outputBytes) {
    return failure(VERIFICATION_REASONS.CANDIDATE_CHANGED, sourceBytes, outputBytes, {
      statBytes: outputBytes,
      readBytes: candidateBytes.length
    });
  }

  const outputSha256 = bytesSha256(candidateBytes);
  const snapshotFactory = options.createSnapshot || createVerificationSnapshot;
  let snapshot;
  try {
    snapshot = await Promise.resolve(snapshotFactory({ bytes: candidateBytes, size: outputBytes, sha256: outputSha256 }));
  } catch (_error) {
    return failure(VERIFICATION_REASONS.SNAPSHOT_FAILED, sourceBytes, outputBytes, { kind: 'create-failed' });
  }
  candidateBytes = null;
  const ownedSnapshot = normalizeSnapshotContract(snapshot, options, outputBytes, outputSha256);
  if (!ownedSnapshot) {
    const invalid = failure(VERIFICATION_REASONS.SNAPSHOT_FAILED, sourceBytes, outputBytes, { kind: 'invalid-contract' });
    try {
      if (snapshot && typeof snapshot.cleanup === 'function') return cleanupFailure(snapshot, invalid);
    } catch (_error) {
      return failure(VERIFICATION_REASONS.SNAPSHOT_CLEANUP_FAILED, sourceBytes, outputBytes, {
        kind: 'cleanup-failed',
        priorReason: invalid.reason
      });
    }
    return invalid;
  }

  let verified;
  try {
    verified = await verifyOwnedSnapshot({ options, profileId, sourceBytes, outputBytes, outputSha256, snapshot: ownedSnapshot, readFile });
  } catch (_error) {
    verified = failure(VERIFICATION_REASONS.SNAPSHOT_FAILED, sourceBytes, outputBytes, { kind: 'verification-threw' });
  }
  if (!verified.ok) return cleanupFailure(ownedSnapshot, verified);

  try {
    await readExactSnapshot(ownedSnapshot, outputBytes, outputSha256);
  } catch (_error) {
    return cleanupFailure(ownedSnapshot, failure(VERIFICATION_REASONS.SNAPSHOT_FAILED, sourceBytes, outputBytes, { kind: 'integrity-failed' }));
  }

  let transferred;
  try {
    transferred = await Promise.resolve(ownedSnapshot.transfer());
  } catch (_error) {
    return cleanupFailure(ownedSnapshot, failure(VERIFICATION_REASONS.SNAPSHOT_TRANSFER_FAILED, sourceBytes, outputBytes, { kind: 'transfer-failed' }));
  }
  let publicationPath;
  let publicationToken;
  try {
    publicationPath = transferred?.path;
    publicationToken = transferred?.token;
  } catch (_error) {
    publicationPath = null;
    publicationToken = null;
  }
  if (!transferred || typeof transferred !== 'object' || Array.isArray(transferred)
      || publicationPath !== ownedSnapshot.path || publicationToken !== ownedSnapshot.token) {
    return cleanupFailure(ownedSnapshot, failure(VERIFICATION_REASONS.SNAPSHOT_TRANSFER_FAILED, sourceBytes, outputBytes, { kind: 'invalid-transfer' }));
  }

  return {
    ...verified,
    publicationArtifact: {
      path: publicationPath,
      token: publicationToken,
      sha256: outputSha256,
      size: outputBytes
    }
  };
}

module.exports = { VERIFICATION_REASONS, sanitizeInspectorDiagnostics, verifyCandidate };
