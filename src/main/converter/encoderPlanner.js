'use strict';

// These conservative 8-bit 4:2:0 floors avoid known encoder initialization
// failures at impractically low bitrates. They are the only bitrate clamps;
// the planner deliberately has no maximum clamp that could defeat a byte target.
const SAFE_VIDEO_BITRATE_FLOORS = Object.freeze({ h265: 250_000, av1: 200_000 });
const RETRY_REASONS = Object.freeze({ PROFILE_SIZE: 'profile-size' });
const DEFAULT_PROBE_BITRATE = 500_000;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

const CANDIDATES = Object.freeze({
  h265: Object.freeze({
    win32: Object.freeze(['hevc_nvenc', 'hevc_qsv', 'hevc_amf']),
    darwin: Object.freeze(['hevc_videotoolbox']),
    linux: Object.freeze(['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_vaapi']),
    cpu: Object.freeze(['libx265'])
  }),
  av1: Object.freeze({
    win32: Object.freeze(['av1_nvenc', 'av1_qsv', 'av1_amf']),
    darwin: Object.freeze(['av1_videotoolbox']),
    linux: Object.freeze(['av1_nvenc', 'av1_qsv', 'av1_amf', 'av1_vaapi']),
    cpu: Object.freeze(['libsvtav1', 'libaom-av1'])
  })
});

function requireFamily(codec) {
  if (!Object.prototype.hasOwnProperty.call(CANDIDATES, codec)) {
    throw new RangeError(`Unsupported encoder family: ${codec}`);
  }
  return codec;
}

function requirePositive(name, value) {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive finite number`);
  return value;
}

function requireNonNegative(name, value) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a non-negative finite number`);
  return value;
}

function requirePositiveSafeInteger(name, value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive finite safe integer`);
  return value;
}

function bitrateFloor(codec) {
  return SAFE_VIDEO_BITRATE_FLOORS[requireFamily(codec)];
}

function encoderBelongsToFamily(codec, encoder) {
  const family = CANDIDATES[codec];
  return family.cpu.includes(encoder) || Object.entries(family)
    .filter(([key]) => key !== 'cpu')
    .map(([, value]) => value)
    .filter(Array.isArray)
    .some((encoders) => encoders.includes(encoder));
}

/**
 * Build output arguments shared by real probes and converter jobs.
 * The MP4 muxer is forced to avoid edit lists and shift negative timestamps to
 * zero while passthrough frame mode prevents implicit duplication or dropping.
 */
function buildEncodeArgs({ codec, encoder, bitrate, vaapiDevice = '/dev/dri/renderD128' }) {
  requireFamily(codec);
  requirePositive('bitrate', bitrate);
  if (typeof encoder !== 'string' || !encoderBelongsToFamily(codec, encoder)) {
    throw new RangeError(`Encoder ${encoder} is not a ${codec} candidate`);
  }

  const args = [];
  if (encoder.endsWith('_vaapi')) {
    if (typeof vaapiDevice !== 'string' || vaapiDevice.length === 0) throw new RangeError('vaapiDevice must be a non-empty path');
    args.push('-vaapi_device', vaapiDevice, '-vf', 'format=nv12,hwupload');
  }

  args.push('-c:v', encoder, '-b:v', String(Math.round(bitrate)));

  if (encoder.endsWith('_qsv')) args.push('-pix_fmt', 'nv12');
  else if (!encoder.endsWith('_vaapi')) args.push('-pix_fmt', 'yuv420p');

  if (encoder.endsWith('_amf')) args.push('-rc', 'vbr_peak');
  if (encoder === 'libx265') args.push('-preset', 'medium');
  if (encoder === 'libsvtav1') args.push('-preset', '8');
  if (encoder === 'libaom-av1') args.push('-cpu-used', '6', '-row-mt', '1');
  if (codec === 'h265') args.push('-bf', '0');

  args.push(
    '-tag:v', codec === 'h265' ? 'hvc1' : 'av01',
    '-fps_mode', 'passthrough',
    '-start_at_zero',
    '-avoid_negative_ts', 'make_zero',
    '-use_editlist', '0'
  );
  return args;
}

function failedProof(candidate, reason, details) {
  return { ...candidate, usable: false, reason, details: details || null };
}

function processFailure(result) {
  if (!result || result.timedOut || result.timeout) return 'timeout';
  if (result.error) return 'runner error result';
  if (result.status !== 0) return 'non-zero status';
  return null;
}

/**
 * Prove one advertised candidate with a short, real MP4 encode. The runner
 * contract is (command, argumentArray, options) and shell use is forbidden.
 */
async function probeCandidate({
  runProbe,
  ffmpegPath = 'ffmpeg',
  platform = process.platform,
  family,
  candidate,
  bitrate = DEFAULT_PROBE_BITRATE,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  vaapiDevice = '/dev/dri/renderD128'
}) {
  if (typeof runProbe !== 'function') throw new TypeError('runProbe must be a function');
  requireFamily(family);
  requirePositiveSafeInteger('timeoutMs', timeoutMs);
  const normalized = typeof candidate === 'string'
    ? { codec: candidate, hardware: !CANDIDATES[family].cpu.includes(candidate) }
    : { ...candidate };
  const encodeArgs = buildEncodeArgs({ codec: family, encoder: normalized.codec, bitrate, vaapiDevice });
  const outputPath = platform === 'win32' ? 'NUL' : '/dev/null';
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=duration=0.5:size=640x360:rate=8',
    '-an', '-frames:v', '4',
    ...encodeArgs,
    '-f', 'mp4', outputPath
  ];

  try {
    const result = await Promise.resolve(runProbe(ffmpegPath, args, {
      timeoutMs,
      windowsHide: true,
      shell: false
    }));
    const reason = processFailure(result);
    if (reason) return failedProof(normalized, reason, result.stderr || result.error?.message);
    return { ...normalized, usable: true, reason: null, probeArgs: args };
  } catch (error) {
    return failedProof(normalized, 'runner error', error.message);
  }
}

function encoderIsAdvertised(output, codec) {
  const escaped = codec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, 'm').test(output);
}

function platformCandidates(family, platform) {
  const hardware = CANDIDATES[family][platform] || [];
  return [
    ...hardware.map((codec) => Object.freeze({ codec, hardware: true })),
    ...CANDIDATES[family].cpu.map((codec) => Object.freeze({ codec, hardware: false }))
  ];
}

function createEncoderPlanner({
  runProbe,
  platform = process.platform,
  ffmpegPath = 'ffmpeg',
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  vaapiDevice = '/dev/dri/renderD128'
} = {}) {
  if (typeof runProbe !== 'function') throw new TypeError('runProbe must be a function');
  requirePositiveSafeInteger('timeoutMs', timeoutMs);
  let advertisedPromise;
  const proofCache = new Map();
  const selectionCache = new Map();

  async function advertisedEncoders() {
    if (!advertisedPromise) {
      advertisedPromise = Promise.resolve().then(() => runProbe(ffmpegPath, ['-hide_banner', '-encoders'], {
        timeoutMs,
        windowsHide: true,
        shell: false
      })).then((result) => {
        const reason = processFailure(result);
        if (reason) throw new Error(`Encoder discovery failed: ${reason}`);
        return `${result.stdout || ''}\n${result.stderr || ''}`;
      }).catch((error) => {
        advertisedPromise = undefined;
        throw error instanceof Error && /Encoder discovery failed/.test(error.message)
          ? error
          : new Error(`Encoder discovery failed: ${error.message || error}`);
      });
    }
    return advertisedPromise;
  }

  async function prove(family, candidate) {
    const key = `${family}:${candidate.codec}`;
    if (!proofCache.has(key)) {
      proofCache.set(key, probeCandidate({
        runProbe,
        ffmpegPath,
        platform,
        family,
        candidate,
        timeoutMs,
        vaapiDevice
      }));
    }
    return proofCache.get(key);
  }

  async function selectFrom(family, candidates, cacheKey) {
    requireFamily(family);
    if (selectionCache.has(cacheKey)) return selectionCache.get(cacheKey);
    const output = await advertisedEncoders();
    for (const candidate of candidates) {
      if (!encoderIsAdvertised(output, candidate.codec)) continue;
      const proof = await prove(family, candidate);
      if (proof.usable) {
        const selected = Object.freeze({ family, codec: candidate.codec, hardware: candidate.hardware });
        selectionCache.set(cacheKey, selected);
        return selected;
      }
    }
    throw new Error(`No proven ${family} encoder is available`);
  }

  return Object.freeze({
    select(family) {
      requireFamily(family);
      return selectFrom(family, platformCandidates(family, platform), `${family}:preferred`);
    },
    selectCpuFallback(family) {
      requireFamily(family);
      return selectFrom(
        family,
        CANDIDATES[family].cpu.map((codec) => ({ codec, hardware: false })),
        `${family}:cpu`
      );
    }
  });
}

function calculateInitialBitrate({
  codec,
  targetBytes,
  durationSeconds,
  containerReserveBytes,
  telemetryReserveBytes
}) {
  requireFamily(codec);
  requirePositive('targetBytes', targetBytes);
  requirePositive('durationSeconds', durationSeconds);
  requireNonNegative('containerReserveBytes', containerReserveBytes);
  requireNonNegative('telemetryReserveBytes', telemetryReserveBytes);
  const reservedBytes = containerReserveBytes + telemetryReserveBytes;
  if (reservedBytes >= targetBytes) throw new RangeError('Container and telemetry reserve must be smaller than targetBytes');
  const calculated = Math.floor(((targetBytes - reservedBytes) * 8) / durationSeconds);
  return requirePositiveSafeInteger('calculated bitrate', Math.max(bitrateFloor(codec), calculated));
}

function calculateRetryBitrate(currentBitrate, actualBytes, targetBytes, options = {}) {
  requirePositive('currentBitrate', currentBitrate);
  requirePositive('actualBytes', actualBytes);
  requirePositive('targetBytes', targetBytes);
  const codec = typeof options === 'string' ? options : (options.codec || 'h265');
  const calculated = Math.round(currentBitrate * (targetBytes / actualBytes));
  return requirePositiveSafeInteger('calculated bitrate', Math.max(bitrateFloor(codec), calculated));
}

function decideSizeRetry({
  retryCount,
  failureReason,
  codec,
  encoder,
  currentBitrate,
  actualBytes,
  targetBytes
}) {
  if (!Number.isInteger(retryCount) || retryCount < 0) throw new RangeError('retryCount must be a non-negative integer');
  const correctionLimit = encoder === 'libaom-av1' ? 2 : 1;
  if (failureReason !== RETRY_REASONS.PROFILE_SIZE || retryCount >= correctionLimit) {
    return { retry: false, bitrate: null };
  }
  return {
    retry: true,
    bitrate: calculateRetryBitrate(currentBitrate, actualBytes, targetBytes, { codec })
  };
}

module.exports = {
  SAFE_VIDEO_BITRATE_FLOORS,
  RETRY_REASONS,
  buildEncodeArgs,
  probeCandidate,
  createEncoderPlanner,
  calculateInitialBitrate,
  calculateRetryBitrate,
  decideSizeRetry,
  nextBitrate: calculateRetryBitrate
};
