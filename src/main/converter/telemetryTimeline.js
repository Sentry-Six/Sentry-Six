'use strict';

const crypto = require('crypto');
const { parseMp4, findBoxes, selectVideoTrack, buildSampleIndex } = require('./mp4');

function telemetryError(message, code = 'INVALID_H264') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireBuffer(buffer, label = 'H.264 sample') {
  if (!Buffer.isBuffer(buffer)) throw new TypeError(`${label} must be a Buffer`);
}

function parseLengthPrefixedNals(buffer, lengthSize) {
  if (![1, 2, 4].includes(lengthSize)) throw telemetryError('AVC NAL length size must be 1, 2, or 4 bytes', 'UNSUPPORTED_AVC');
  const nals = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    if (buffer.length - cursor < lengthSize) throw telemetryError('Truncated NAL length prefix');
    const size = buffer.readUIntBE(cursor, lengthSize);
    cursor += lengthSize;
    if (size === 0) throw telemetryError('Zero-length NAL unit is not valid AVC');
    if (size > buffer.length - cursor) throw telemetryError('NAL length exceeds sample boundary');
    nals.push(Buffer.from(buffer.subarray(cursor, cursor + size)));
    cursor += size;
  }
  return nals;
}

function annexBStartCode(buffer, offset) {
  if (offset + 3 < buffer.length && buffer[offset] === 0 && buffer[offset + 1] === 0 && buffer[offset + 2] === 0 && buffer[offset + 3] === 1) return 4;
  if (offset + 2 < buffer.length && buffer[offset] === 0 && buffer[offset + 1] === 0 && buffer[offset + 2] === 1) return 3;
  return 0;
}

function parseAnnexBNals(buffer) {
  if (buffer.length === 0) return [];
  const starts = [];
  for (let cursor = 0; cursor < buffer.length;) {
    const width = annexBStartCode(buffer, cursor);
    if (width) {
      starts.push({ offset: cursor, nalStart: cursor + width });
      cursor += width;
    } else cursor += 1;
  }
  if (starts.length === 0 || buffer.subarray(0, starts[0].offset).some((byte) => byte !== 0)) throw telemetryError('Annex-B sample is missing an initial start code');
  return starts.map((start, index) => {
    let end = index + 1 < starts.length ? starts[index + 1].offset : buffer.length;
    if (index === starts.length - 1) while (end > start.nalStart && buffer[end - 1] === 0) end -= 1;
    if (end === start.nalStart) throw telemetryError('Zero-length Annex-B NAL unit is not valid AVC');
    return Buffer.from(buffer.subarray(start.nalStart, end));
  });
}

function parseH264Nals(buffer, options = {}) {
  requireBuffer(buffer);
  const format = options.format || (annexBStartCode(buffer, 0) ? 'annex-b' : 'length-prefixed');
  if (format === 'annex-b') return parseAnnexBNals(buffer);
  if (format === 'length-prefixed') return parseLengthPrefixedNals(buffer, options.lengthSize);
  throw new TypeError(`Unknown H.264 sample format: ${format}`);
}

function toSafeOffset(value, label) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw telemetryError(`${label} cannot be represented safely`, 'UNSUPPORTED_CONTAINER');
  return Number(value);
}

function nodeBounds(node, label) {
  return {
    start: toSafeOffset(node.contentStart, `${label} start`),
    end: toSafeOffset(node.end, `${label} end`)
  };
}

function readTrackTimescale(tree, track) {
  const boxes = findBoxes(track, 'mdhd');
  if (boxes.length !== 1) throw telemetryError('Video track must contain exactly one mdhd box', 'UNSUPPORTED_CONTAINER');
  const { start, end } = nodeBounds(boxes[0], 'mdhd');
  if (end - start < 4) throw telemetryError('Truncated mdhd box');
  const version = tree.buffer.readUInt8(start);
  const offset = version === 0 ? 12 : version === 1 ? 20 : null;
  if (offset === null) throw telemetryError('Unsupported mdhd version', 'UNSUPPORTED_CONTAINER');
  if (end - start < offset + 4) throw telemetryError('Truncated mdhd timescale');
  const timescale = tree.buffer.readUInt32BE(start + offset);
  if (timescale === 0) throw telemetryError('Video timescale must be non-zero');
  return timescale;
}

function readOrdinaryBox(buffer, cursor, end, context) {
  if (end - cursor < 8) throw telemetryError(`Truncated ${context} box header`);
  const size = buffer.readUInt32BE(cursor);
  const type = buffer.toString('ascii', cursor + 4, cursor + 8);
  if (size < 8 || cursor + size > end) throw telemetryError(`Invalid ${context} box size: ${type}`);
  return { type, start: cursor, contentStart: cursor + 8, end: cursor + size };
}

function readAvcLengthSize(tree, track) {
  const boxes = findBoxes(track, 'stsd');
  if (boxes.length !== 1) throw telemetryError('Video track must contain exactly one stsd box', 'UNSUPPORTED_CONTAINER');
  const { start, end } = nodeBounds(boxes[0], 'stsd');
  if (end - start < 8) throw telemetryError('Truncated stsd box');
  if (tree.buffer.readUInt8(start) !== 0) throw telemetryError('Unsupported stsd version', 'UNSUPPORTED_CONTAINER');
  const entryCount = tree.buffer.readUInt32BE(start + 4);
  if (entryCount !== 1) throw telemetryError('Exactly one AVC sample description is required', 'UNSUPPORTED_CONTAINER');
  const entry = readOrdinaryBox(tree.buffer, start + 8, end, 'sample description');
  if (entry.type !== 'avc1' && entry.type !== 'avc3') throw telemetryError(`Unsupported video sample description: ${entry.type}`, 'UNSUPPORTED_CODEC');
  const childStart = entry.contentStart + 78;
  if (childStart > entry.end) throw telemetryError(`Truncated ${entry.type} sample entry`);
  const avcConfigs = [];
  for (let cursor = childStart; cursor < entry.end;) {
    const child = readOrdinaryBox(tree.buffer, cursor, entry.end, `${entry.type} child`);
    if (child.type === 'avcC') avcConfigs.push(child);
    cursor = child.end;
  }
  if (avcConfigs.length !== 1) throw telemetryError('AVC sample description must contain exactly one avcC box', 'UNSUPPORTED_CONTAINER');
  const avcC = avcConfigs[0];
  if (avcC.end - avcC.contentStart < 5 || tree.buffer.readUInt8(avcC.contentStart) !== 1) throw telemetryError('Invalid avcC configuration record');
  const lengthSizeMinusOne = tree.buffer.readUInt8(avcC.contentStart + 4) & 0x03;
  if (lengthSizeMinusOne === 2) throw telemetryError('avcC declares the reserved 3-byte NAL length size', 'UNSUPPORTED_AVC');
  return lengthSizeMinusOne + 1;
}

function removeEmulationPreventionBytes(buffer) {
  const output = [];
  let zeros = 0;
  for (const byte of buffer) {
    if (zeros >= 2 && byte === 0x03) {
      zeros = 0;
      continue;
    }
    output.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Buffer.from(output);
}

function readSeiField(rbsp, state) {
  let value = 0;
  while (state.cursor < rbsp.length && rbsp[state.cursor] === 0xff) {
    value += 0xff;
    state.cursor += 1;
  }
  if (state.cursor >= rbsp.length) return null;
  value += rbsp[state.cursor];
  state.cursor += 1;
  return value;
}

function teslaPayload(nal) {
  if (nal.length < 5 || (nal[0] & 0x1f) !== 6) return null;
  const rbsp = removeEmulationPreventionBytes(nal.subarray(1));
  const state = { cursor: 0 };
  while (state.cursor < rbsp.length && rbsp[state.cursor] !== 0x80) {
    const payloadType = readSeiField(rbsp, state);
    const payloadSize = readSeiField(rbsp, state);
    if (payloadType === null || payloadSize === null || payloadSize > rbsp.length - state.cursor) return null;
    const payload = rbsp.subarray(state.cursor, state.cursor + payloadSize);
    state.cursor += payloadSize;
    if (payloadType !== 5) continue;
    let marker = 0;
    while (marker < payload.length && payload[marker] === 0x42) marker += 1;
    if (marker === 0 || marker >= payload.length || payload[marker] !== 0x69) continue;
    return payload.subarray(marker + 1);
  }
  return null;
}

function payloadFingerprint(payload) {
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function ticksToMicroseconds(ticks, timescale) {
  const scaled = ticks * 1_000_000n;
  const divisor = BigInt(timescale);
  const rounded = scaled >= 0n ? (scaled + divisor / 2n) / divisor : -((-scaled + divisor / 2n) / divisor);
  if (rounded < BigInt(Number.MIN_SAFE_INTEGER) || rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw telemetryError('Sample timestamp cannot be represented safely', 'UNSUPPORTED_CONTAINER');
  return Number(rounded);
}

function extractH264TelemetryTimeline(mp4Buffer) {
  requireBuffer(mp4Buffer, 'MP4 input');
  const tree = parseMp4(mp4Buffer);
  const track = selectVideoTrack(tree);
  const samples = buildSampleIndex(track);
  const timescale = readTrackTimescale(tree, track);
  const lengthSize = readAvcLengthSize(tree, track);
  const timelineSamples = [];
  const events = [];

  for (const sample of samples) {
    const start = toSafeOffset(sample.offset, 'Sample offset');
    const accessUnit = mp4Buffer.subarray(start, start + sample.size);
    const seiNals = [];
    for (const nal of parseH264Nals(accessUnit, { format: 'length-prefixed', lengthSize })) {
      const payload = teslaPayload(nal);
      if (!payload) continue;
      const record = { nal, fingerprint: payloadFingerprint(payload) };
      seiNals.push(record);
    }
    const ptsUs = ticksToMicroseconds(sample.pts, timescale);
    const durationUs = ticksToMicroseconds(sample.duration, timescale);
    const timelineSample = { sampleIndex: sample.index, ptsUs, durationUs, hasTelemetry: seiNals.length > 0, seiNals };
    timelineSamples.push(timelineSample);
    for (const record of seiNals) events.push({ sourceSampleIndex: sample.index, sourcePtsUs: ptsUs, ...record });
  }

  return { timescale, lengthSize, samples: timelineSamples, events };
}

function outputTimingIndex(outputSamples) {
  const sorted = outputSamples
    .map((sample, index) => ({ ptsUs: sample.ptsUs, index }))
    .sort((left, right) => left.ptsUs - right.ptsUs || left.index - right.index);
  const unique = sorted.filter((sample, index) => index === 0 || sample.ptsUs !== sorted[index - 1].ptsUs);
  let inferredDuration = 0;
  for (let index = 1; index < unique.length; index += 1) {
    const difference = unique[index].ptsUs - unique[index - 1].ptsUs;
    if (difference > 0 && (inferredDuration === 0 || difference < inferredDuration)) inferredDuration = difference;
  }
  return {
    unique,
    durations: outputSamples.map((sample) => Number.isFinite(sample.durationUs) && sample.durationUs > 0 ? sample.durationUs : inferredDuration)
  };
}

function nearestOutput(timing, targetPtsUs) {
  let low = 0;
  let high = timing.unique.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (timing.unique[middle].ptsUs < targetPtsUs) low = middle + 1;
    else high = middle;
  }
  const candidates = [];
  if (low < timing.unique.length) candidates.push(timing.unique[low]);
  if (low > 0) candidates.push(timing.unique[low - 1]);
  candidates.sort((left, right) => {
    const distance = Math.abs(left.ptsUs - targetPtsUs) - Math.abs(right.ptsUs - targetPtsUs);
    return distance || left.ptsUs - right.ptsUs || left.index - right.index;
  });
  return candidates[0] || null;
}

function nearestTimestampDistance(sortedTimestamps, targetPtsUs) {
  let low = 0;
  let high = sortedTimestamps.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (sortedTimestamps[middle] < targetPtsUs) low = middle + 1;
    else high = middle;
  }
  let distance = Infinity;
  if (low < sortedTimestamps.length) distance = Math.abs(sortedTimestamps[low] - targetPtsUs);
  if (low > 0) distance = Math.min(distance, Math.abs(sortedTimestamps[low - 1] - targetPtsUs));
  return distance;
}

function mapTimelineToOutput(sourceTimeline, outputSamples) {
  if (!sourceTimeline || !Array.isArray(sourceTimeline.events)) throw new TypeError('Source timeline must contain an events array');
  if (!Array.isArray(outputSamples)) throw new TypeError('Output samples must be an array');
  for (const sample of outputSamples) if (!sample || !Number.isFinite(sample.ptsUs)) throw new TypeError('Every output sample must have a finite ptsUs');
  const mapped = outputSamples.map(({ ptsUs }) => ({ ptsUs, pictureMarker: true, seiNals: [] }));
  // Tesla clips can contain one terminal zero-duration bookkeeping sample.
  // When the encoder preserves the real frame count, ordinal mapping is more
  // reliable than timestamp matching because VFR/duplicate PTS values can
  // otherwise leave valid SEI records unmapped.
  const sourceSamples = Array.isArray(sourceTimeline.samples) ? sourceTimeline.samples : [];
  const ordinalCount = sourceSamples.length === outputSamples.length && sourceSamples.length > 10
    ? outputSamples.length
    : (sourceSamples.length === outputSamples.length + 1
      && sourceSamples.at(-1)?.durationUs === 0 ? outputSamples.length : 0);
  if (ordinalCount > 0) {
    for (let index = 0; index < ordinalCount; index += 1) {
      for (const record of sourceSamples[index]?.seiNals || []) {
        mapped[index].seiNals.push({ nal: Buffer.from(record.nal), fingerprint: record.fingerprint });
      }
    }
    // No picture is emitted for a zero-duration tail, but its SEI can contain
    // a distinct final measurement. Carry every record after the last picture's
    // normal telemetry, in source order, without adding a synthetic frame.
    if (sourceSamples.length === ordinalCount + 1 && sourceSamples.at(-1)?.durationUs === 0) {
      for (const record of sourceSamples.at(-1).seiNals || []) {
        mapped.at(-1).seiNals.push({ nal: Buffer.from(record.nal), fingerprint: record.fingerprint });
      }
    }
    return mapped;
  }
  const timing = outputTimingIndex(outputSamples);
  const gapTimestamps = Array.isArray(sourceTimeline.samples)
    ? sourceTimeline.samples.filter((sample) => sample && sample.hasTelemetry === false && Number.isFinite(sample.ptsUs)).map((sample) => sample.ptsUs).sort((left, right) => left - right)
    : [];

  for (const event of sourceTimeline.events) {
    if (!event || !Number.isFinite(event.sourcePtsUs) || !Buffer.isBuffer(event.nal) || typeof event.fingerprint !== 'string') throw new TypeError('Invalid source telemetry event');
    const best = nearestOutput(timing, event.sourcePtsUs);
    const eventDistance = best ? Math.abs(best.ptsUs - event.sourcePtsUs) : Infinity;
    const gapDistance = best ? nearestTimestampDistance(gapTimestamps, best.ptsUs) : Infinity;
    if (best && eventDistance <= timing.durations[best.index] && gapDistance > eventDistance) {
      mapped[best.index].seiNals.push({ nal: Buffer.from(event.nal), fingerprint: event.fingerprint });
    }
  }
  return mapped;
}

module.exports = { parseH264Nals, extractH264TelemetryTimeline, mapTimelineToOutput };
