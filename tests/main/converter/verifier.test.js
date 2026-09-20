'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { verifyCandidate, sanitizeInspectorDiagnostics } = require('../../../src/main/converter/verifier');
const { parseMp4, findBoxes, selectVideoTrack, buildSampleIndex } = require('../../../src/main/converter/mp4');
const { injectH265Telemetry } = require('../../../src/main/converter/h265Telemetry');
const { injectAv1Telemetry } = require('../../../src/main/converter/av1Telemetry');
const { extractH264TelemetryTimeline } = require('../../../src/main/converter/telemetryTimeline');
const {
  lengthPrefixedSample,
  teslaSeiNal,
  hevcNal,
  h264Mp4,
  h265Mp4,
  av1Mp4
} = require('./fixtureBuilders');

const SOURCE = 'C:\\staging\\source.mp4';
const CANDIDATE = 'C:\\staging\\candidate.mp4';
const SNAPSHOT = 'C:\\app-owned\\verification\\snapshot.mp4';
const FFPROBE = 'C:\\tools\\ffprobe.exe';
const FFMPEG = 'C:\\tools\\ffmpeg.exe';
const PICTURE_MARKER = Buffer.from([0x61, 0x01, 0x80]);
const PAYLOAD_A = Buffer.from([0x10, 0x20, 0x30]);
const PAYLOAD_B = Buffer.from([0x40, 0x50, 0x60]);
const NAL_A = teslaSeiNal(PAYLOAD_A);
const NAL_B = teslaSeiNal(PAYLOAD_B);

function payloadFingerprint(payload) {
  return crypto.createHash('sha256').update(payload).digest('hex');
}

const RECORD_A = Object.freeze({ nal: NAL_A, fingerprint: payloadFingerprint(PAYLOAD_A) });
const RECORD_B = Object.freeze({ nal: NAL_B, fingerprint: payloadFingerprint(PAYLOAD_B) });

function equalDurations(count, totalTicks = 3_000) {
  const base = Math.floor(totalTicks / count);
  let remainder = totalTicks - base * count;
  return Array.from({ length: count }, () => {
    const duration = base + (remainder > 0 ? 1 : 0);
    remainder -= remainder > 0 ? 1 : 0;
    return duration;
  });
}

function mappedTimeline(eventsBySample, durations, timescale = 30_000) {
  let ticks = 0;
  return eventsBySample.map((records, index) => {
    const mapped = {
      ptsUs: Math.round((ticks * 1_000_000) / timescale),
      pictureMarker: true,
      seiNals: records.map((record) => ({ nal: Buffer.from(record.nal), fingerprint: record.fingerprint }))
    };
    ticks += durations[index];
    return mapped;
  });
}

function buildCandidate(codec, eventsBySample = [[RECORD_A], [], [RECORD_B]], durations) {
  const sampleDurations = durations || equalDurations(eventsBySample.length);
  if (codec === 'h265') {
    const encoded = h265Mp4({
      samples: eventsBySample.map((_, index) => lengthPrefixedSample([
        hevcNal(index === 0 ? 19 : 1, Buffer.from([0x80 + index]))
      ])),
      timescale: 30_000,
      durations: sampleDurations
    });
    return injectH265Telemetry(encoded, mappedTimeline(eventsBySample, sampleDurations));
  }
  if (codec === 'av1') {
    const encoded = av1Mp4({
      samples: eventsBySample.map((_, index) => Buffer.from([0x12, 0x20 + index, 0x00])),
      timescale: 30_000,
      durations: sampleDurations
    });
    return injectAv1Telemetry(encoded, mappedTimeline(eventsBySample, sampleDurations));
  }
  throw new RangeError(`Unsupported test codec: ${codec}`);
}

function buildSource(eventsBySample, desiredBytes, durations = equalDurations(eventsBySample.length), timescale = 30_000) {
  const make = (padding) => h264Mp4({
    samples: eventsBySample.map((records, index) => lengthPrefixedSample([
      Buffer.concat([
        Buffer.from([index === 0 ? 0x65 : 0x41, 0x88]),
        index === 0 ? Buffer.alloc(padding, 0x7a) : Buffer.alloc(0)
      ]),
      ...records.map((record) => Buffer.from(record.nal))
    ])),
    timescale,
    durations
  });
  const base = make(0);
  if (desiredBytes === undefined) return base;
  if (!Number.isSafeInteger(desiredBytes) || desiredBytes < base.length) {
    throw new RangeError(`Test source size ${desiredBytes} is smaller than its valid MP4 structure ${base.length}`);
  }
  const source = make(desiredBytes - base.length);
  if (source.length !== desiredBytes) throw new Error('Test source padding must be exact');
  return source;
}

function readLengthPrefixedNals(sample) {
  const nals = [];
  let cursor = 0;
  while (cursor < sample.length) {
    const size = sample.readUInt32BE(cursor);
    cursor += 4;
    nals.push(Buffer.from(sample.subarray(cursor, cursor + size)));
    cursor += size;
  }
  return nals;
}

function rebuildH265Samples(candidate, mutate) {
  const tree = parseMp4(candidate);
  const samples = buildSampleIndex(selectVideoTrack(tree)).map((sample) => {
    const start = Number(sample.offset);
    return readLengthPrefixedNals(candidate.subarray(start, start + sample.size));
  });
  mutate(samples);
  return h265Mp4({
    samples: samples.map((nals) => lengthPrefixedSample(nals)),
    timescale: 30_000,
    durations: samples.map(() => 1_000)
  });
}

function probeDocument({
  codecName,
  tag,
  duration = '0.100000',
  frameCount = 3,
  width = 1920,
  height = 1080,
  averageRate = '30/1',
  realRate = averageRate
}) {
  return {
    streams: [{
      index: 0,
      codec_type: 'video',
      codec_name: codecName,
      codec_tag_string: tag,
      width,
      height,
      duration,
      nb_frames: String(frameCount),
      nb_read_frames: String(frameCount),
      avg_frame_rate: averageRate,
      r_frame_rate: realRate
    }],
    format: { duration }
  };
}

function profileSourceBytes(outputBytes, profileId) {
  const retained = profileId === 'conservative' || profileId === 'high-quality'
    ? 0.95
    : profileId === 'aggressive' || profileId === 'smaller'
      ? 0.50
      : 0.80;
  return Math.max(outputBytes + 1, Math.round(outputBytes / retained));
}

function durationText(durations, timescale = 30_000) {
  return (durations.reduce((sum, value) => sum + value, 0) / timescale).toFixed(6);
}

function harness({
  codec = 'h265',
  profileId = 'balanced',
  candidateEvents = [[RECORD_A], [], [RECORD_B]],
  sourceEvents = candidateEvents,
  candidateBytes: providedCandidateBytes,
  candidateDurations = equalDurations(candidateEvents.length),
  sourceDurations = equalDurations(sourceEvents.length),
  sourceTimescale = 30_000,
  sourceBytes: requestedSourceBytes,
  sourceFileBytes: providedSourceFileBytes,
  sourceTimelineCache,
  omitSourceTimeline = false,
  sourceProbe = {},
  candidateProbe = {},
  ffprobeResult,
  decodeResult = { status: 0, stdout: '', stderr: '' },
  stat,
  readFile,
  createSnapshot,
  onSnapshotCreate
} = {}) {
  const candidateBytes = providedCandidateBytes || buildCandidate(codec, candidateEvents, candidateDurations);
  const requestedBytes = requestedSourceBytes === undefined
    ? profileSourceBytes(candidateBytes.length, profileId)
    : requestedSourceBytes;
  const sourceFileBytes = providedSourceFileBytes || buildSource(
    sourceEvents,
    requestedBytes,
    sourceDurations,
    sourceTimescale
  );
  const sourceBytes = sourceFileBytes.length;
  const authoritativeTimeline = extractH264TelemetryTimeline(sourceFileBytes);
  const expectedCodec = codec === 'h265'
    ? { codecName: 'hevc', tag: 'hvc1' }
    : { codecName: 'av1', tag: 'av01' };
  const sourceMetadata = probeDocument({
    codecName: 'h264',
    tag: 'avc1',
    duration: durationText(sourceDurations, sourceTimescale),
    frameCount: sourceEvents.length,
    ...sourceProbe
  });
  const candidateMetadata = probeDocument({
    ...expectedCodec,
    duration: durationText(candidateDurations),
    frameCount: candidateEvents.length,
    ...candidateProbe
  });
  const runFfprobe = jest.fn(async (command, args, options) => {
    const input = args.at(-1);
    const target = input === SOURCE ? 'source' : input === SNAPSHOT ? 'snapshot' : 'candidate';
    if (ffprobeResult) return ffprobeResult(target, { command, args, options });
    return {
      status: 0,
      stdout: JSON.stringify(target === 'source' ? sourceMetadata : candidateMetadata),
      stderr: ''
    };
  });
  const runFullDecode = jest.fn(async (...args) => (
    typeof decodeResult === 'function' ? decodeResult(...args) : decodeResult
  ));
  const statAdapter = stat || jest.fn(async (target) => ({
    size: target === SOURCE ? sourceBytes : candidateBytes.length,
    isFile: () => true
  }));
  const candidatePathState = { bytes: Buffer.from(candidateBytes) };
  const readAdapter = readFile || jest.fn(async (target) => {
    if (target === SOURCE) return Buffer.from(sourceFileBytes);
    if (target === CANDIDATE) return Buffer.from(candidatePathState.bytes);
    throw new Error('test adapter received an unknown path');
  });
  const snapshotState = { bytes: null };
  const snapshot = {
    path: SNAPSHOT,
    token: 'snapshot-token',
    read: jest.fn(async () => Buffer.from(snapshotState.bytes)),
    cleanup: jest.fn(async () => {}),
    transfer: jest.fn(async () => ({ path: SNAPSHOT, token: 'snapshot-token' }))
  };
  const snapshotFactory = createSnapshot || jest.fn(async ({ bytes }) => {
    snapshotState.bytes = Buffer.from(bytes);
    if (onSnapshotCreate) await onSnapshotCreate(bytes, snapshotState, candidatePathState);
    return snapshot;
  });
  const cachedTimeline = sourceTimelineCache === undefined ? authoritativeTimeline : sourceTimelineCache;
  const options = {
    source: SOURCE,
    candidate: CANDIDATE,
    codec,
    profileId,
    ffprobePath: FFPROBE,
    ffmpegPath: FFMPEG,
    runFfprobe,
    runFullDecode,
    stat: statAdapter,
    readFile: readAdapter,
    createSnapshot: snapshotFactory
  };
  if (!omitSourceTimeline) options.sourceTimeline = cachedTimeline;
  return {
    candidateBytes,
    sourceBytes,
    sourceFileBytes,
    authoritativeTimeline,
    candidatePathState,
    snapshot,
    createSnapshot: snapshotFactory,
    runFfprobe,
    runFullDecode,
    stat: statAdapter,
    readFile: readAdapter,
    options
  };
}

function expectFailure(result, reason, retryable = false) {
  expect(result).toEqual(expect.objectContaining({ ok: false, reason, retryable }));
}

function containsBuffer(value) {
  if (Buffer.isBuffer(value)) return true;
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(containsBuffer);
}

describe('verifyCandidate artifact and process boundaries', () => {
  test.each(['h265', 'av1'])('%s rejects loss of a distinct zero-duration terminal record', async (codec) => {
    const testHarness = harness({ codec, sourceEvents: [[RECORD_A], [], [RECORD_A], [RECORD_B]],
      sourceDurations: [1000, 1000, 1000, 0], candidateEvents: [[RECORD_A], [], [RECORD_A]] });
    const result = await verifyCandidate(testHarness.options);
    expect(result).toMatchObject({ ok: false, reason: 'telemetry-mismatch' });
  });

  test.each(['h265', 'av1'])('%s accepts all terminal records carried after the final picture telemetry', async (codec) => {
    const testHarness = harness({ codec, sourceEvents: [[RECORD_A], [], [RECORD_A], [RECORD_B]],
      sourceDurations: [1000, 1000, 1000, 0], candidateEvents: [[RECORD_A], [], [RECORD_A, RECORD_B]] });
    const result = await verifyCandidate(testHarness.options);
    expect(result).toMatchObject({ ok: true });
  });
  test('does not trust a cached timeline that omits the terminal record', async () => {
    const testHarness = harness({ sourceEvents: [[RECORD_A], [], [RECORD_A], [RECORD_B]],
      sourceDurations: [1000, 1000, 1000, 0], candidateEvents: [[RECORD_A], [], [RECORD_A, RECORD_B]] });
    const cached = testHarness.options.sourceTimeline;
    testHarness.options.sourceTimeline = { ...cached, samples: cached.samples.slice(0, -1),
      events: cached.events.filter(event => event.sourceSampleIndex < 3) };
    expect(await verifyCandidate(testHarness.options)).toMatchObject({ ok: false, reason: 'source-timeline-mismatch' });
  });
  test.each(['h265', 'av1'])('%s rejects changed dimensions despite valid decode, timing and telemetry', async (codec) => {
    const candidateBytes = buildCandidate(codec);
    const stsd = findBoxes(selectVideoTrack(parseMp4(candidateBytes)), 'stsd')[0];
    candidateBytes.writeUInt16BE(1280, Number(stsd.contentStart) + 16 + 24);
    const testHarness = harness({ codec, candidateBytes, candidateProbe: { width: 1280 } });
    expectFailure(await verifyCandidate(testHarness.options), 'dimension-mismatch');
  });

  test('rejects decoder dimensions that disagree with the output sample header', async () => {
    const testHarness = harness({ candidateProbe: { height: 720 } });
    expectFailure(await verifyCandidate(testHarness.options), 'dimension-mismatch');
  });

  test.each(['source', 'candidate'])('rejects a zero-width %s visual header', async (target) => {
    const baseline = harness();
    const bytes = Buffer.from(await baseline.options.readFile(target === 'source' ? SOURCE : CANDIDATE));
    const stsd = findBoxes(selectVideoTrack(parseMp4(bytes)), 'stsd')[0];
    bytes.writeUInt16BE(0, Number(stsd.contentStart) + 16 + 24);
    const testHarness = harness(target === 'source' ? { sourceFileBytes: bytes } : { candidateBytes: bytes });
    expectFailure(await verifyCandidate(testHarness.options), target === 'source' ? 'source-invalid' : 'container-invalid');
  });

  test('rejects a zero-byte candidate before launching either tool', async () => {
    const testHarness = harness({ candidateBytes: Buffer.alloc(0), sourceBytes: 1_000 });

    const result = await verifyCandidate(testHarness.options);

    expectFailure(result, 'empty-output');
    expect(result).toEqual(expect.objectContaining({ sourceBytes: 1_000, outputBytes: 0 }));
    expect(testHarness.runFfprobe).not.toHaveBeenCalled();
    expect(testHarness.runFullDecode).not.toHaveBeenCalled();
  });

  test('converts a candidate read failure into a structured non-retryable result', async () => {
    const readFile = jest.fn(async () => { throw new Error('private staged path failed'); });
    const testHarness = harness({ readFile });

    const result = await verifyCandidate(testHarness.options);

    expectFailure(result, 'candidate-unreadable');
    expect(JSON.stringify(result)).not.toContain('private staged path failed');
  });

  test('rejects a candidate that changes between stat and read', async () => {
    const candidateBytes = buildCandidate('h265');
    const testHarness = harness({
      candidateBytes,
      stat: jest.fn(async (target) => ({ size: target === SOURCE ? 1_000 : candidateBytes.length + 1 }))
    });

    const result = await verifyCandidate(testHarness.options);

    expectFailure(result, 'candidate-changed');
  });

  test.each([
    ['codec', { codecName: 'av1', tag: 'av01' }],
    ['tag', { codecName: 'hevc', tag: 'hev1' }]
  ])('rejects an unexpected H.265 %s before full decode', async (_label, candidateProbe) => {
    const testHarness = harness({ candidateProbe });

    const result = await verifyCandidate(testHarness.options);

    expectFailure(result, 'codec-mismatch');
    expect(testHarness.runFullDecode).not.toHaveBeenCalled();
  });

  test('does not echo hostile runner-derived codec or tag strings', async () => {
    const privateMarker = 'PRIVATE-runner-secret';
    const testHarness = harness({
      candidateProbe: { codecName: privateMarker, tag: privateMarker }
    });

    const result = await verifyCandidate(testHarness.options);

    expectFailure(result, 'codec-mismatch');
    expect(result.details).toEqual({
      kind: 'unexpected-codec-tag',
      expectedCodec: 'hevc',
      expectedTag: 'hvc1'
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE-');
  });

  test('rejects malformed FFprobe JSON without throwing', async () => {
    const testHarness = harness({
      ffprobeResult: () => ({ status: 0, stdout: '{not-json', stderr: '' })
    });

    const result = await verifyCandidate(testHarness.options);

    expectFailure(result, 'probe-failed');
    expect(result.details).toEqual(expect.objectContaining({ kind: 'malformed-json' }));
  });

  test('rejects a non-zero FFprobe result without returning its stderr', async () => {
    const testHarness = harness({
      ffprobeResult: () => ({ status: 2, stdout: '', stderr: 'sensitive probe diagnostics' })
    });

    const result = await verifyCandidate(testHarness.options);

    expectFailure(result, 'probe-failed');
    expect(JSON.stringify(result)).not.toContain('sensitive probe diagnostics');
  });

  test.each([
    ['status', { stdout: '{}', stderr: '' }],
    ['stdout', { status: 0, stdout: Buffer.from('{}'), stderr: '' }],
    ['stderr', { status: 0, stdout: '{}', stderr: null }]
  ])('strictly rejects an FFprobe result with invalid %s', async (_field, malformedResult) => {
    const testHarness = harness({ ffprobeResult: () => malformedResult });

    const result = await verifyCandidate(testHarness.options);

    expectFailure(result, 'probe-failed');
    expect(result.details).toEqual(expect.objectContaining({ kind: 'invalid-runner-result' }));
  });

  test('rejects a non-zero full decode and does not expose stderr', async () => {
    const candidateBytes = buildCandidate('h265');
    const testHarness = harness({
      candidateBytes,
      sourceBytes: candidateBytes.length * 2,
      decodeResult: { status: 1, stdout: '', stderr: 'corrupt private frame data' }
    });

    const result = await verifyCandidate(testHarness.options);

    expectFailure(result, 'decode-failed');
    expect(JSON.stringify(result)).not.toContain('corrupt private frame data');
  });

  test('treats error-level decode stderr as failure even with status zero', async () => {
    const testHarness = harness({
      decodeResult: { status: 0, stdout: '', stderr: 'error while decoding frame' }
    });

    const result = await verifyCandidate(testHarness.options);

    expectFailure(result, 'decode-failed');
  });

  test.each([
    ['status', { stdout: '', stderr: '' }],
    ['stdout', { status: 0, stdout: null, stderr: '' }],
    ['stderr', { status: 0, stdout: '', stderr: Buffer.alloc(0) }]
  ])('strictly rejects a full-decode result with invalid %s', async (_field, decodeResult) => {
    const testHarness = harness({ decodeResult });

    const result = await verifyCandidate(testHarness.options);

    expectFailure(result, 'decode-failed');
    expect(result.details).toEqual(expect.objectContaining({ kind: 'invalid-runner-result' }));
  });

  test('uses executable paths, argument arrays, no shell, and a complete selected-stream decode', async () => {
    const testHarness = harness();

    const result = await verifyCandidate(testHarness.options);

    expect(result.ok).toBe(true);
    expect(testHarness.runFfprobe).toHaveBeenCalledTimes(1);
    for (const [command, args, options] of testHarness.runFfprobe.mock.calls) {
      expect(command).toBe(FFPROBE);
      expect(Array.isArray(args)).toBe(true);
      expect(options).toEqual(expect.objectContaining({ shell: false, windowsHide: true }));
      expect(args).toEqual(expect.arrayContaining([
        '-select_streams', 'v:0', '-count_frames', '-of', 'json'
      ]));
      expect(args.at(-1)).toBe(SNAPSHOT);
    }
    expect(testHarness.runFullDecode).toHaveBeenCalledTimes(1);
    expect(testHarness.runFullDecode).toHaveBeenCalledWith(FFMPEG, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-err_detect', 'explode',
      '-i', SNAPSHOT,
      '-map', '0:v:0', '-an', '-sn', '-dn',
      '-f', 'null', '-'
    ], expect.objectContaining({ shell: false, windowsHide: true }));
    const decodeArgs = testHarness.runFullDecode.mock.calls[0][1];
    expect(decodeArgs).not.toEqual(expect.arrayContaining(['-t', '-frames:v', '-read_intervals']));
  });

  test('uses safe executable defaults when the plan-facing API omits explicit tool paths', async () => {
    const testHarness = harness();
    delete testHarness.options.ffprobePath;
    delete testHarness.options.ffmpegPath;

    const result = await verifyCandidate(testHarness.options);

    expect(result.ok).toBe(true);
    expect(testHarness.runFfprobe.mock.calls.every(([command]) => command === 'ffprobe')).toBe(true);
    expect(testHarness.runFullDecode.mock.calls[0][0]).toBe('ffmpeg');
  });

  test('verifies one immutable snapshot even if the original candidate path mutates between stages', async () => {
    const testHarness = harness({
      onSnapshotCreate: async (originalReadBuffer, _snapshotState, originalPathState) => {
        originalReadBuffer.fill(0);
        originalPathState.bytes.fill(0);
      },
      ffprobeResult: (target) => {
        if (target !== 'snapshot') return { status: 9, stdout: '', stderr: 'mutable original was used' };
        return {
          status: 0,
          stdout: JSON.stringify(probeDocument({ codecName: 'hevc', tag: 'hvc1' })),
          stderr: ''
        };
      },
      decodeResult: (_command, args) => (
        args.includes(SNAPSHOT)
          ? { status: 0, stdout: '', stderr: '' }
          : { status: 9, stdout: '', stderr: 'mutable original was decoded' }
      )
    });
    const expectedSha256 = payloadFingerprint(testHarness.candidateBytes);

    const result = await verifyCandidate(testHarness.options);

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      publicationArtifact: {
        path: SNAPSHOT,
        token: 'snapshot-token',
        sha256: expectedSha256,
        size: testHarness.candidateBytes.length
      }
    }));
    expect(testHarness.runFfprobe.mock.calls[0][1].at(-1)).toBe(SNAPSHOT);
    expect(testHarness.runFullDecode.mock.calls[0][1]).toContain(SNAPSHOT);
    expect(testHarness.readFile.mock.calls.filter(([target]) => target === CANDIDATE)).toHaveLength(1);
    expect(testHarness.candidatePathState.bytes.every((byte) => byte === 0)).toBe(true);
    expect(testHarness.snapshot.read).toHaveBeenCalled();
    expect(testHarness.snapshot.transfer).toHaveBeenCalledTimes(1);
    expect(testHarness.snapshot.cleanup).not.toHaveBeenCalled();
    expect(JSON.stringify(result.details)).not.toContain(SNAPSHOT);
  });

  test('cleans the owned snapshot on every post-snapshot failure', async () => {
    const testHarness = harness({ decodeResult: { status: 1, stdout: '', stderr: 'decode failed' } });

    const result = await verifyCandidate(testHarness.options);

    expectFailure(result, 'decode-failed');
    expect(testHarness.snapshot.cleanup).toHaveBeenCalledTimes(1);
    expect(testHarness.snapshot.transfer).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('publicationArtifact');
  });

  test('rejects and cleans a snapshot whose bytes no longer match the exact candidate read', async () => {
    const testHarness = harness();
    const changed = Buffer.from(testHarness.candidateBytes);
    changed[changed.length - 1] ^= 0xff;
    testHarness.snapshot.read.mockResolvedValue(changed);

    const result = await verifyCandidate(testHarness.options);

    expectFailure(result, 'snapshot-failed');
    expect(result.details).toEqual({ kind: 'integrity-failed' });
    expect(testHarness.snapshot.cleanup).toHaveBeenCalledTimes(1);
    expect(testHarness.snapshot.transfer).not.toHaveBeenCalled();
  });

  test('default snapshots persist exact private bytes until ownership transfer and explicit cleanup', async () => {
    const { createVerificationSnapshot } = require('../../../src/main/converter/verificationSnapshot');
    const bytes = Buffer.from('immutable verification bytes');
    let snapshot;
    let snapshotPath;
    try {
      snapshot = await createVerificationSnapshot({ bytes });
      snapshotPath = snapshot.path;
      expect(snapshot).toEqual(expect.objectContaining({
        token: expect.any(String),
        size: bytes.length,
        sha256: payloadFingerprint(bytes)
      }));
      expect(snapshot.path).not.toBe(CANDIDATE);
      expect(await snapshot.read()).toEqual(bytes);
      await expect(snapshot.transfer()).resolves.toEqual({ path: snapshot.path, token: snapshot.token });
      await expect(fs.promises.access(snapshot.path)).resolves.toBeUndefined();
    } finally {
      if (snapshot) await snapshot.cleanup();
    }
    await expect(fs.promises.access(snapshotPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('verifyCandidate timing and frame consistency', () => {
  test('accepts a duration delta exactly equal to one proven output frame', async () => {
    const testHarness = harness({
      candidateEvents: [[], [], []],
      sourceEvents: [[], [], []],
      sourceDurations: [44_445, 44_444, 44_444],
      sourceTimescale: 1_000_000
    });

    const result = await verifyCandidate(testHarness.options);

    expect(result.ok).toBe(true);
    expect(result.details.durationToleranceUs).toBe(33_333);
  });

  test('rejects a duration delta one microsecond beyond one output frame', async () => {
    const testHarness = harness({
      candidateEvents: [[], [], []],
      sourceEvents: [[], [], []],
      sourceDurations: [44_446, 44_444, 44_444],
      sourceTimescale: 1_000_000
    });

    const result = await verifyCandidate(testHarness.options);

    expectFailure(result, 'duration-mismatch');
  });

  test.each([
    ['duration', { duration: 'N/A' }],
    ['frame count', { frameCount: 'N/A' }],
    ['average frame rate', { averageRate: '0/0' }],
    ['real frame rate', { realRate: 'not-a-rate' }]
  ])('rejects non-finite %s metadata', async (_field, candidateProbe) => {
    const testHarness = harness({ candidateProbe });

    const result = await verifyCandidate(testHarness.options);

    expectFailure(result, 'probe-failed');
    expect(result.details).toEqual(expect.objectContaining({ kind: 'invalid-metadata' }));
  });

  test('requires an exact frame count for proven CFR source and output', async () => {
    const sourceEvents = [[], [], [], []];
    const testHarness = harness({
      candidateEvents: [[], [], []],
      sourceEvents,
      sourceProbe: { frameCount: 4, averageRate: '40/1', realRate: '40/1' }
    });

    const result = await verifyCandidate(testHarness.options);

    expectFailure(result, 'frame-count-mismatch');
    expect(result.details).toEqual(expect.objectContaining({ mode: 'cfr', toleranceFrames: 0 }));
  });

  test('does not treat conflicting probe rates as VFR when parsed output durations are constant', async () => {
    const sourceEvents = [[], [], [], []];
    const testHarness = harness({
      candidateEvents: [[], [], []],
      sourceEvents,
      sourceProbe: { frameCount: 4, averageRate: '40/1', realRate: '40/1' },
      candidateProbe: { averageRate: '30/1', realRate: '60/1' }
    });

    const result = await verifyCandidate(testHarness.options);

    expectFailure(result, 'frame-count-mismatch');
    expect(result.details).toEqual(expect.objectContaining({ mode: 'cfr', toleranceFrames: 0 }));
  });

  test('allows one frame only when safe parsed durations and probe rates both prove VFR', async () => {
    const sourceEvents = [[], [], [], []];
    const testHarness = harness({
      candidateEvents: [[], [], []],
      candidateDurations: [500, 1_000, 1_500],
      sourceEvents,
      sourceProbe: { frameCount: 4, averageRate: '40/1', realRate: '40/1' },
      candidateProbe: { averageRate: '30/1', realRate: '60/1' }
    });

    const result = await verifyCandidate(testHarness.options);

    expect(result.ok).toBe(true);
    expect(result.details).toEqual(expect.objectContaining({ frameCountMode: 'vfr', frameCountTolerance: 1 }));
    expect(result.details.frameRateProof).toEqual({ output: { average: '30/1', real: '60/1' } });
    expect(result.details.sampleTimingProof).toEqual({
      nonuniform: true,
      minDurationUs: 16_667,
      maxDurationUs: 50_000
    });
  });

  test('keeps nonuniform output timing in CFR mode when probe rates do not corroborate it', async () => {
    const sourceEvents = [[], [], [], []];
    const testHarness = harness({
      candidateEvents: [[], [], []],
      candidateDurations: [500, 1_000, 1_500],
      sourceEvents,
      candidateProbe: { averageRate: '25/1', realRate: '60/1' }
    });

    const result = await verifyCandidate(testHarness.options);

    expectFailure(result, 'frame-count-mismatch');
    expect(result.details).toEqual(expect.objectContaining({ mode: 'cfr', toleranceFrames: 0 }));
  });

  test('rejects a two-frame difference even when parsed timing and rates prove VFR', async () => {
    const sourceEvents = [[], [], [], [], []];
    const testHarness = harness({
      candidateEvents: [[], [], []],
      candidateDurations: [500, 1_000, 1_500],
      sourceEvents,
      sourceProbe: { frameCount: 5, averageRate: '50/1', realRate: '50/1' },
      candidateProbe: { averageRate: '30/1', realRate: '60/1' }
    });

    const result = await verifyCandidate(testHarness.options);

    expectFailure(result, 'frame-count-mismatch');
    expect(result.details).toEqual(expect.objectContaining({ mode: 'vfr', toleranceFrames: 1 }));
    expect(result.details.frameRateProof).toEqual({ output: { average: '30/1', real: '60/1' } });
  });

  test('rejects a candidate whose FFprobe frame count disagrees with its safe MP4 sample table', async () => {
    const testHarness = harness({ candidateProbe: { frameCount: 4 } });

    const result = await verifyCandidate(testHarness.options);

    expectFailure(result, 'frame-count-mismatch');
    expect(result.details).toEqual(expect.objectContaining({ kind: 'probe-container' }));
  });
});

describe('verifyCandidate independent telemetry verification', () => {
  test('derives source timing, gaps, and fingerprints from the named H.264 source when no cache is supplied', async () => {
    const testHarness = harness({ omitSourceTimeline: true });

    const result = await verifyCandidate(testHarness.options);

    expect(result.ok).toBe(true);
    expect(testHarness.readFile).toHaveBeenCalledWith(SOURCE);
    expect(testHarness.readFile.mock.calls.filter(([target]) => target === SOURCE)).toHaveLength(1);
    expect(testHarness.authoritativeTimeline.events).toHaveLength(2);
  });

  test('rejects an internally consistent stale source-timeline cache instead of using it as authority', async () => {
    const sourceEvents = [[RECORD_A], [], [RECORD_B]];
    const staleTimeline = extractH264TelemetryTimeline(buildSource(
      [[RECORD_B], [], [RECORD_A]],
      undefined,
      equalDurations(sourceEvents.length)
    ));
    const testHarness = harness({ sourceEvents, sourceTimelineCache: staleTimeline });

    const result = await verifyCandidate(testHarness.options);

    expectFailure(result, 'source-timeline-mismatch');
    expect(result.details).toEqual({ kind: 'cache-mismatch' });
    expect(testHarness.snapshot.cleanup).toHaveBeenCalledTimes(1);
    expect(testHarness.snapshot.transfer).not.toHaveBeenCalled();
  });

  test('whitelists and bounds hostile inspector diagnostics without exposing paths or messages', () => {
    const privateMarker = `PRIVATE-${'y'.repeat(4_096)}`;

    const sanitized = sanitizeInspectorDiagnostics([
      { code: 'INVALID_MP4', path: 'tracks[1]', message: privateMarker },
      { code: privateMarker, path: privateMarker, message: privateMarker },
      ...Array.from({ length: 20 }, () => ({ code: privateMarker, path: privateMarker }))
    ]);

    expect(sanitized).toHaveLength(8);
    expect(sanitized[0]).toEqual({ code: 'INVALID_MP4', area: 'tracks' });
    expect(sanitized[1]).toEqual({ code: 'INVALID_OUTPUT', area: 'unknown' });
    expect(JSON.stringify(sanitized)).not.toContain('PRIVATE-');
    expect(JSON.stringify(sanitized)).not.toContain('tracks[1]');
  });

  test('converts a truncated MP4 parser/inspector failure into a structured result', async () => {
    const truncated = Buffer.from([0x00, 0x00, 0x00, 0x20, 0x6d, 0x6f, 0x6f, 0x76]);
    const testHarness = harness({ candidateBytes: truncated, sourceBytes: 1_000 });

    const result = await verifyCandidate(testHarness.options);

    expectFailure(result, 'container-invalid');
  });

  test('converts a throwing codec inspector into a structured result', async () => {
    const invalidSample = Buffer.from([0x00, 0x00, 0x00, 0x05, 0x26]);
    const candidateBytes = h265Mp4({ samples: [invalidSample], durations: [1_000] });
    const testHarness = harness({
      candidateBytes,
      candidateEvents: [[]],
      candidateDurations: [1_000],
      sourceEvents: [[]],
      sourceDurations: [1_000],
      sourceProbe: { duration: '0.033333', frameCount: 1 },
      candidateProbe: { duration: '0.033333', frameCount: 1 }
    });

    const result = await verifyCandidate(testHarness.options);

    expectFailure(result, 'telemetry-invalid');
    expect(result.details).toEqual({ kind: 'inspector-threw' });
  });

  test('rejects a missing independent picture marker', async () => {
    const valid = buildCandidate('h265');
    const candidateBytes = rebuildH265Samples(valid, (samples) => {
      const markerIndex = samples[1].findIndex((nal) => nal.equals(PICTURE_MARKER));
      samples[1].splice(markerIndex, 1);
    });
    const testHarness = harness({ candidateBytes });

    const result = await verifyCandidate(testHarness.options);

    expectFailure(result, 'telemetry-invalid');
  });

  test('rejects duplicate picture markers', async () => {
    const valid = buildCandidate('h265');
    const candidateBytes = rebuildH265Samples(valid, (samples) => {
      const markerIndex = samples[0].findIndex((nal) => nal.equals(PICTURE_MARKER));
      samples[0].splice(markerIndex + 1, 0, Buffer.from(PICTURE_MARKER));
    });
    const testHarness = harness({ candidateBytes });

    const result = await verifyCandidate(testHarness.options);

    expectFailure(result, 'telemetry-invalid');
  });

  test('rejects telemetry shifted to a neighboring output sample', async () => {
    const testHarness = harness({
      sourceEvents: [[RECORD_A], [], [RECORD_B]],
      candidateEvents: [[], [RECORD_A], [RECORD_B]]
    });

    const result = await verifyCandidate(testHarness.options);

    expectFailure(result, 'telemetry-mismatch');
  });

  test('rejects reordered telemetry records within one sample', async () => {
    const testHarness = harness({
      sourceEvents: [[RECORD_A, RECORD_B], [], []],
      candidateEvents: [[RECORD_B, RECORD_A], [], []]
    });

    const result = await verifyCandidate(testHarness.options);

    expectFailure(result, 'telemetry-mismatch');
    expect(result.details).toEqual(expect.objectContaining({ kind: 'fingerprint-order' }));
  });

  test('rejects count-only false positives when fingerprints swap samples', async () => {
    const testHarness = harness({
      sourceEvents: [[RECORD_A], [], [RECORD_B]],
      candidateEvents: [[RECORD_B], [], [RECORD_A]]
    });

    const result = await verifyCandidate(testHarness.options);

    expectFailure(result, 'telemetry-mismatch');
    expect(result.details).toEqual(expect.objectContaining({ kind: 'fingerprint-order' }));
  });

  test('rejects telemetry filled into an explicit parked gap', async () => {
    const testHarness = harness({
      sourceEvents: [[RECORD_A], [], [RECORD_B]],
      candidateEvents: [[RECORD_A], [RECORD_A], [RECORD_B]]
    });

    const result = await verifyCandidate(testHarness.options);

    expectFailure(result, 'telemetry-mismatch');
    expect(result.details).toEqual(expect.objectContaining({ kind: 'gap-ranges' }));
  });

  test('does not let a profile miss hide corrupt telemetry', async () => {
    const candidateEvents = [[RECORD_B], [], [RECORD_A]];
    const candidateBytes = buildCandidate('h265', candidateEvents);
    const testHarness = harness({
      candidateBytes,
      candidateEvents,
      sourceEvents: [[RECORD_A], [], [RECORD_B]],
      sourceBytes: candidateBytes.length * 3,
      profileId: 'balanced'
    });

    const result = await verifyCandidate(testHarness.options);

    expectFailure(result, 'telemetry-mismatch');
  });
});

describe('verifyCandidate size and valid results', () => {
  test('returns the sole retryable profile-size reason for an otherwise valid target miss', async () => {
    const candidateBytes = buildCandidate('h265');
    const testHarness = harness({
      candidateBytes,
      sourceBytes: candidateBytes.length * 3,
      profileId: 'balanced'
    });

    const result = await verifyCandidate(testHarness.options);

    expectFailure(result, 'profile-size', true);
    expect(result).toEqual(expect.objectContaining({
      sourceBytes: candidateBytes.length * 3,
      outputBytes: candidateBytes.length
    }));
    expect(testHarness.snapshot.cleanup).toHaveBeenCalledTimes(1);
  });

  test('returns non-retryable not-smaller when output is larger than source', async () => {
    const candidateBytes = buildCandidate('h265');
    const testHarness = harness({ candidateBytes, sourceBytes: candidateBytes.length - 1 });

    const result = await verifyCandidate(testHarness.options);

    expectFailure(result, 'not-smaller');
  });

  test('does not let not-smaller hide a full-decode failure', async () => {
    const candidateBytes = buildCandidate('h265');
    const testHarness = harness({
      candidateBytes,
      sourceBytes: candidateBytes.length - 1,
      decodeResult: { status: 1, stdout: '', stderr: 'decode failed' }
    });

    const result = await verifyCandidate(testHarness.options);

    expectFailure(result, 'decode-failed');
  });

  test.each([
    ['h265', 'hevc', 'hvc1'],
    ['av1', 'av1', 'av01']
  ])('accepts a valid %s candidate with safe diagnostics', async (codec, codecName, tag) => {
    const testHarness = harness({ codec, profileId: 'balanced' });

    const result = await verifyCandidate(testHarness.options);

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      reason: null,
      retryable: false,
      sourceBytes: testHarness.sourceBytes,
      outputBytes: testHarness.candidateBytes.length,
      publicationArtifact: {
        path: SNAPSHOT,
        token: 'snapshot-token',
        sha256: payloadFingerprint(testHarness.candidateBytes),
        size: testHarness.candidateBytes.length
      }
    }));
    expect(result.details).toEqual(expect.objectContaining({ codec: codecName, tag, telemetryEvents: 2 }));
    expect(result.details).not.toHaveProperty('path');
    expect(containsBuffer(result)).toBe(false);
    expect(Object.keys(result.details)).not.toEqual(expect.arrayContaining(['payloads', 'fingerprints', 'stdout', 'stderr']));
  });

  test('supports the plan-facing smaller profile name through canonical aggressive math', async () => {
    const candidateBytes = buildCandidate('av1');
    const sourceBytes = profileSourceBytes(candidateBytes.length, 'smaller');
    const testHarness = harness({ codec: 'av1', profileId: 'smaller', candidateBytes, sourceBytes });

    const result = await verifyCandidate(testHarness.options);

    expect(result).toEqual(expect.objectContaining({ ok: true, sourceBytes, outputBytes: candidateBytes.length }));
    expect(result.details.profileId).toBe('aggressive');
  });
});
