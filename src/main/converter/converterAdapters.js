'use strict';

const nodeFs = require('fs');
const { parseMp4, findBoxes, selectVideoTrack, buildSampleIndex } = require('./mp4');
const { mapTimelineToOutput } = require('./telemetryTimeline');
const { injectH265Telemetry } = require('./h265Telemetry');
const { injectAv1Telemetry } = require('./av1Telemetry');
const { verifyCandidate } = require('./verifier');

function safeTime(value, timescale) {
  const micros = (value * 1_000_000n) / timescale;
  const number = Number(micros);
  if (!Number.isSafeInteger(number)) throw Object.assign(new Error('unsafe sample time'), { code: 'INVALID_MP4' });
  return number;
}

function outputTiming(bytes) {
  const tree = parseMp4(bytes);
  const track = selectVideoTrack(tree);
  const mdhd = findBoxes(track, 'mdhd');
  if (mdhd.length !== 1) throw Object.assign(new Error('missing media timescale'), { code: 'INVALID_MP4' });
  const offset = Number(mdhd[0].contentStart);
  const version = bytes.readUInt8(offset);
  if (version !== 0 && version !== 1) throw Object.assign(new Error('unsupported media header'), { code: 'INVALID_MP4' });
  const timescaleOffset = offset + (version === 1 ? 20 : 12);
  if (timescaleOffset + 4 > Number(mdhd[0].end)) throw Object.assign(new Error('truncated media header'), { code: 'INVALID_MP4' });
  const timescale = BigInt(bytes.readUInt32BE(timescaleOffset));
  if (timescale === 0n) throw Object.assign(new Error('invalid media timescale'), { code: 'INVALID_MP4' });
  return buildSampleIndex(track).map((sample) => ({
    ptsUs: safeTime(sample.pts, timescale),
    durationUs: safeTime(sample.duration, timescale)
  }));
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function createConverterAdapters(options = {}) {
  const fileSystem = options.fs || nodeFs.promises;

  function writer(inject) {
    return async function writeTelemetry({ candidatePath, timeline, signal }) {
      if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
      const handle = await fileSystem.open(candidatePath, 'r+');
      try {
        const before = await handle.stat({ bigint: true });
        const bytes = await handle.readFile();
        const mapped = mapTimelineToOutput(timeline, outputTiming(bytes));
        const output = inject(bytes, mapped);
        if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
        const unchanged = await handle.stat({ bigint: true });
        if (!sameIdentity(before, unchanged)) throw Object.assign(new Error('candidate changed'), { code: 'CANDIDATE_CHANGED' });
        await handle.truncate(0);
        await handle.write(output, 0, output.length, 0);
        await handle.sync();
        const after = await handle.stat({ bigint: true });
        if (!sameIdentity(before, after) || after.size !== BigInt(output.length)) {
          throw Object.assign(new Error('candidate changed'), { code: 'CANDIDATE_CHANGED' });
        }
        return candidatePath;
      } finally {
        await handle.close();
      }
    };
  }

  async function boundVerifier(operation) {
    const withSignal = (runner) => typeof runner !== 'function' ? runner : (command, args, runnerOptions) => runner(
      command,
      args,
      { ...runnerOptions, signal: operation.signal }
    );
    return verifyCandidate({
      ...options.verifierOptions,
      ...operation,
      runFfprobe: withSignal(options.runFfprobe),
      runFullDecode: withSignal(options.runFullDecode)
    });
  }

  return Object.freeze({
    writers: Object.freeze({ h265: writer(injectH265Telemetry), av1: writer(injectAv1Telemetry) }),
    verifier: boundVerifier
  });
}

module.exports = { createConverterAdapters, outputTiming };
