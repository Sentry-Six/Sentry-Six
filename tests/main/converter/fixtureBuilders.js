'use strict';

const {
  buildSampleIndex,
  findBoxes,
  parseMp4,
  readChunkOffsets,
  selectVideoTrack
} = require('../../../src/main/converter/mp4');

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
}

function i32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
}

function u64(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}

function fullBoxPayload(version, flags, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(4);
  header.writeUInt8(version, 0);
  header.writeUIntBE(flags, 1, 3);
  return Buffer.concat([header, payload]);
}

function box(type, payload = Buffer.alloc(0)) {
  return Buffer.concat([u32(payload.length + 8), Buffer.from(type, 'ascii'), payload]);
}

function extendedBox(type, payload = Buffer.alloc(0)) {
  return Buffer.concat([u32(1), Buffer.from(type, 'ascii'), u64(BigInt(payload.length + 16)), payload]);
}

function fullBox(type, version, flags, payload = Buffer.alloc(0)) {
  return box(type, fullBoxPayload(version, flags, payload));
}

function stco(offsets) {
  return fullBox('stco', 0, 0, Buffer.concat([u32(offsets.length), ...offsets.map(u32)]));
}

function co64(offsets) {
  return fullBox('co64', 0, 0, Buffer.concat([u32(offsets.length), ...offsets.map(u64)]));
}

function track(sampleTable, trackId = 7, handler = 'vide') {
  const tkhd = fullBox('tkhd', 0, 0, Buffer.concat([u32(0), u32(0), u32(trackId)]));
  const hdlr = fullBox('hdlr', 0, 0, Buffer.concat([u32(0), Buffer.from(handler)]));
  const stbl = box('stbl', Buffer.concat(sampleTable));
  return box('trak', Buffer.concat([tkhd, box('mdia', Buffer.concat([hdlr, box('minf', stbl)]))]));
}

function videoMp4(sampleTable, trackId = 7, mdatPayload = Buffer.alloc(200)) {
  return Buffer.concat([box('moov', track(sampleTable, trackId)), box('mdat', mdatPayload)]);
}

function unsignedInteger(value, width) {
  const buffer = Buffer.alloc(width);
  buffer.writeUIntBE(value, 0, width);
  return buffer;
}

function lengthPrefixedSample(nals, lengthSize = 4) {
  return Buffer.concat(nals.map((nal) => Buffer.concat([unsignedInteger(nal.length, lengthSize), nal])));
}

function annexBSample(nals, fourByteStartCode = false) {
  const startCode = Buffer.from(fourByteStartCode ? [0, 0, 0, 1] : [0, 0, 1]);
  return Buffer.concat(nals.map((nal) => Buffer.concat([startCode, nal])));
}

function teslaSeiNal(payload, prefixLength = 2) {
  const encodedPayload = Buffer.from(payload);
  const normalizedPayload = [];
  let zeros = 0;
  for (const byte of encodedPayload) {
    if (zeros >= 2 && byte === 0x03) { zeros = 0; continue; }
    normalizedPayload.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  const teslaPayload = Buffer.concat([Buffer.alloc(prefixLength, 0x42), Buffer.from([0x69]), encodedPayload]);
  const payloadSize = prefixLength + 1 + normalizedPayload.length;
  if (payloadSize > 254) throw new RangeError('Test Tesla payload must fit in one-byte SEI size');
  return Buffer.concat([Buffer.from([0x06, 0x05, payloadSize]), teslaPayload, Buffer.from([0x80])]);
}

function injectTeslaTelemetryIntoH264Mp4(source, telemetryBySample) {
  if (!Buffer.isBuffer(source) || source.length === 0) throw new TypeError('source must be a non-empty MP4 Buffer');
  const tree = parseMp4(source);
  const track = selectVideoTrack(tree);
  const samples = buildSampleIndex(track);
  if (!Array.isArray(telemetryBySample) || telemetryBySample.length !== samples.length) {
    throw new RangeError('telemetryBySample must contain one entry per video sample');
  }
  const stsd = findBoxes(track, 'stsd');
  const stsz = findBoxes(track, 'stsz');
  const chunkTables = [...findBoxes(track, 'stco'), ...findBoxes(track, 'co64')];
  const mdats = findBoxes(tree, 'mdat');
  if (stsd.length !== 1 || stsz.length !== 1 || chunkTables.length !== 1 || mdats.length !== 1) {
    throw new RangeError('fixture source must have one stsd, stsz, chunk table, and mdat');
  }
  const stsdStart = Number(stsd[0].contentStart);
  if (source.readUInt32BE(stsdStart + 4) !== 1) throw new RangeError('fixture source must have one sample entry');
  const entryStart = stsdStart + 8;
  const entryEnd = entryStart + source.readUInt32BE(entryStart);
  if (source.toString('ascii', entryStart + 4, entryStart + 8) !== 'avc1') {
    throw new RangeError('fixture source must use an avc1 video sample entry');
  }
  let avcCStart = null;
  for (let cursor = entryStart + 86; cursor < entryEnd;) {
    const size = source.readUInt32BE(cursor);
    if (size < 8 || cursor + size > entryEnd) throw new RangeError('fixture source has an invalid avc1 child');
    if (source.toString('ascii', cursor + 4, cursor + 8) === 'avcC') avcCStart = cursor + 8;
    cursor += size;
  }
  if (avcCStart === null) throw new RangeError('fixture source must have one avcC');
  const lengthSize = (source.readUInt8(avcCStart + 4) & 0x03) + 1;
  const prefixFor = (entry) => {
    const payloads = entry == null ? [] : (Array.isArray(entry) ? entry : [entry]);
    return Buffer.concat(payloads.map((payload) => lengthPrefixedSample([teslaSeiNal(Buffer.from(payload))], lengthSize)));
  };
  const insertions = samples.map((sample, index) => ({
    offset: Number(sample.offset),
    bytes: prefixFor(telemetryBySample[index])
  })).filter((insertion) => insertion.bytes.length > 0);
  const insertedBefore = (offset) => insertions.reduce(
    (total, insertion) => total + (insertion.offset < Number(offset) ? insertion.bytes.length : 0),
    0
  );
  const parts = [];
  let cursor = 0;
  for (const insertion of insertions) {
    parts.push(source.subarray(cursor, insertion.offset), insertion.bytes);
    cursor = insertion.offset;
  }
  parts.push(source.subarray(cursor));
  const output = Buffer.concat(parts);

  const stszOffset = Number(stsz[0].contentStart);
  if (source.readUInt32BE(stszOffset + 4) !== 0 || source.readUInt32BE(stszOffset + 8) !== samples.length) {
    throw new RangeError('fixture source must use explicit stsz sample sizes');
  }
  for (let index = 0; index < samples.length; index += 1) {
    output.writeUInt32BE(samples[index].size + prefixFor(telemetryBySample[index]).length, stszOffset + 12 + index * 4);
  }

  const chunkTable = chunkTables[0];
  const chunkOffsets = readChunkOffsets(tree, track.id);
  const chunkOffsetStart = Number(chunkTable.contentStart) + 8;
  chunkOffsets.forEach((offset, index) => {
    const shifted = offset + BigInt(insertedBefore(offset));
    if (chunkTable.type === 'co64') output.writeBigUInt64BE(shifted, chunkOffsetStart + index * 8);
    else output.writeUInt32BE(Number(shifted), chunkOffsetStart + index * 4);
  });

  const mdat = mdats[0];
  const grownSize = mdat.size + BigInt(output.length - source.length);
  if (mdat.headerSize === 16n) output.writeBigUInt64BE(grownSize, Number(mdat.start) + 8);
  else output.writeUInt32BE(Number(grownSize), Number(mdat.start));
  parseMp4(output);
  return output;
}

function unrelatedSeiNal(payload = Buffer.from([0x01])) {
  const bytes = Buffer.from(payload);
  return Buffer.concat([Buffer.from([0x06, 0x05, bytes.length]), bytes, Buffer.from([0x80])]);
}

function runLength(values) {
  const entries = [];
  for (const value of values) {
    const previous = entries.at(-1);
    if (previous && previous.value === value) previous.count += 1;
    else entries.push({ count: 1, value });
  }
  return entries;
}

function h264Mp4({ samples, lengthSize = 4, timescale = 30_000, durations, compositionOffsets }) {
  const sampleDurations = durations || samples.map(() => 1_000);
  const offsets = compositionOffsets || samples.map(() => 0);
  if (![1, 2, 4].includes(lengthSize)) throw new RangeError('AVC NAL length size must be 1, 2, or 4 bytes');
  if (sampleDurations.length !== samples.length || offsets.length !== samples.length) throw new RangeError('Timing arrays must match samples');

  const lengthSizeMinusOne = lengthSize - 1;
  const avcC = box('avcC', Buffer.from([1, 100, 0, 31, 0xfc | lengthSizeMinusOne, 0xe0, 0]));
  const avc1Header = Buffer.alloc(78);
  avc1Header.writeUInt16BE(1, 6);
  avc1Header.writeUInt16BE(1920, 24);
  avc1Header.writeUInt16BE(1080, 26);
  const avc1 = box('avc1', Buffer.concat([avc1Header, avcC]));
  const stsd = fullBox('stsd', 0, 0, Buffer.concat([u32(1), avc1]));
  const stsz = fullBox('stsz', 0, 0, Buffer.concat([u32(0), u32(samples.length), ...samples.map((sample) => u32(sample.length))]));
  const stsc = fullBox('stsc', 0, 0, Buffer.concat([u32(1), u32(1), u32(samples.length), u32(1)]));
  const sttsEntries = runLength(sampleDurations);
  const stts = fullBox('stts', 0, 0, Buffer.concat([u32(sttsEntries.length), ...sttsEntries.flatMap(({ count, value }) => [u32(count), u32(value)])]));
  const cttsEntries = runLength(offsets);
  const ctts = offsets.some((offset) => offset !== 0)
    ? fullBox('ctts', 1, 0, Buffer.concat([u32(cttsEntries.length), ...cttsEntries.flatMap(({ count, value }) => [u32(count), i32(value)])]))
    : null;
  const mdhd = fullBox('mdhd', 0, 0, Buffer.concat([u32(0), u32(0), u32(timescale), u32(sampleDurations.reduce((sum, value) => sum + value, 0)), Buffer.alloc(4)]));
  const tkhd = fullBox('tkhd', 0, 0, Buffer.concat([u32(0), u32(0), u32(7)]));
  const hdlr = fullBox('hdlr', 0, 0, Buffer.concat([u32(0), Buffer.from('vide')]));
  const mediaPayload = Buffer.concat(samples);

  const makeMoov = (chunkOffset) => {
    const tables = [stsd, stsc, stsz, stts, ...(ctts ? [ctts] : []), stco([chunkOffset])];
    const stbl = box('stbl', Buffer.concat(tables));
    const mdia = box('mdia', Buffer.concat([mdhd, hdlr, box('minf', stbl)]));
    return box('moov', box('trak', Buffer.concat([tkhd, mdia])));
  };
  const placeholder = makeMoov(0);
  const moov = makeMoov(placeholder.length + 8);
  return Buffer.concat([moov, box('mdat', mediaPayload)]);
}

function hevcNal(type, payload = Buffer.alloc(0)) {
  if (!Number.isInteger(type) || type < 0 || type > 63) throw new RangeError('HEVC NAL type must be between 0 and 63');
  return Buffer.concat([Buffer.from([type << 1, 0x01]), Buffer.from(payload)]);
}

function hvcLengthSize(source, track) {
  const descriptions = findBoxes(track, 'stsd');
  if (descriptions.length !== 1) throw new RangeError('fixture must have one stsd');
  const start = Number(descriptions[0].contentStart);
  const entryStart = start + 8;
  const entryEnd = entryStart + source.readUInt32BE(entryStart);
  let configStart = null;
  for (let cursor = entryStart + 86; cursor < entryEnd;) {
    const size = source.readUInt32BE(cursor);
    if (size < 8 || cursor + size > entryEnd) throw new RangeError('fixture has an invalid hvc1 child');
    if (source.toString('ascii', cursor + 4, cursor + 8) === 'hvcC') configStart = cursor + 8;
    cursor += size;
  }
  if (configStart === null) throw new RangeError('fixture must have hvcC');
  return (source.readUInt8(configStart + 21) & 0x03) + 1;
}

function splitLengthPrefixedHevcSample(sample, lengthSize) {
  const records = [];
  for (let cursor = 0; cursor < sample.length;) {
    if (sample.length - cursor < lengthSize) throw new RangeError('truncated HEVC length prefix');
    const size = sample.readUIntBE(cursor, lengthSize);
    const start = cursor;
    cursor += lengthSize;
    if (size < 2 || cursor + size > sample.length) throw new RangeError('invalid HEVC NAL extent');
    const nal = sample.subarray(cursor, cursor + size);
    records.push({ bytes: sample.subarray(start, cursor + size), type: (nal[0] >> 1) & 0x3f });
    cursor += size;
  }
  return records;
}

function summarizeH265NalTypes(source) {
  const tree = parseMp4(source);
  const track = selectVideoTrack(tree);
  const lengthSize = hvcLengthSize(source, track);
  return buildSampleIndex(track).map((sample) => splitLengthPrefixedHevcSample(
    source.subarray(Number(sample.offset), Number(sample.offset) + sample.size),
    lengthSize
  ).map((record) => record.type));
}

function filterH265NalTypes(source, removedTypes) {
  const removed = new Set(removedTypes);
  const tree = parseMp4(source);
  const track = selectVideoTrack(tree);
  const samples = buildSampleIndex(track);
  const lengthSize = hvcLengthSize(source, track);
  const replacements = samples.map((sample) => {
    const oldBytes = source.subarray(Number(sample.offset), Number(sample.offset) + sample.size);
    const bytes = Buffer.concat(splitLengthPrefixedHevcSample(oldBytes, lengthSize)
      .filter((record) => !removed.has(record.type)).map((record) => record.bytes));
    if (bytes.length === 0) throw new RangeError('filter removed every NAL from a sample');
    return { offset: Number(sample.offset), oldSize: sample.size, bytes, delta: bytes.length - sample.size };
  });
  const mdats = findBoxes(tree, 'mdat');
  if (mdats.length !== 1 || replacements.some((entry) => BigInt(entry.offset) < mdats[0].contentStart
      || BigInt(entry.offset + entry.oldSize) > mdats[0].end)) throw new RangeError('filter requires one video-only mdat');
  const parts = [];
  let cursor = 0;
  for (const replacement of replacements) {
    parts.push(source.subarray(cursor, replacement.offset), replacement.bytes);
    cursor = replacement.offset + replacement.oldSize;
  }
  parts.push(source.subarray(cursor));
  const output = Buffer.concat(parts);
  const totalDelta = replacements.reduce((sum, entry) => sum + entry.delta, 0);
  const mdatStart = Number(mdats[0].start);
  const newMdatSize = mdats[0].size + BigInt(totalDelta);
  if (mdats[0].headerSize === 16n) output.writeBigUInt64BE(newMdatSize, mdatStart + 8);
  else output.writeUInt32BE(Number(newMdatSize), mdatStart);

  const interim = parseMp4(output);
  const interimTrack = selectVideoTrack(interim);
  const stsz = findBoxes(interimTrack, 'stsz');
  const tables = [...findBoxes(interimTrack, 'stco'), ...findBoxes(interimTrack, 'co64')];
  if (stsz.length !== 1 || tables.length !== 1) throw new RangeError('filter requires explicit sizes and one chunk table');
  const sizeStart = Number(stsz[0].contentStart);
  if (output.readUInt32BE(sizeStart + 4) !== 0 || output.readUInt32BE(sizeStart + 8) !== samples.length) {
    throw new RangeError('filter requires explicit stsz entries');
  }
  replacements.forEach((entry, index) => output.writeUInt32BE(entry.bytes.length, sizeStart + 12 + index * 4));
  const offsets = readChunkOffsets(tree, track.id);
  const tableStart = Number(tables[0].contentStart) + 8;
  offsets.forEach((offset, index) => {
    const delta = replacements.reduce((sum, entry) => sum + (BigInt(entry.offset) < offset ? entry.delta : 0), 0);
    const shifted = offset + BigInt(delta);
    if (tables[0].type === 'co64') output.writeBigUInt64BE(shifted, tableStart + index * 8);
    else output.writeUInt32BE(Number(shifted), tableStart + index * 4);
  });
  parseMp4(output);
  return output;
}

function h265Mp4({
  samples,
  lengthSize = 4,
  timescale = 30_000,
  durations,
  compositionOffsets,
  chunks = [samples.length],
  co64: useCo64 = false,
  extendedMoov = false,
  extendedMdat = false,
  extendedHvcc = false,
  sampleEntry = 'hvc1',
  chunkPadding = 0,
  audioSamples = [],
  sampleDescriptionIndexes = chunks.map(() => 1)
}) {
  const sampleDurations = durations || samples.map(() => 1_000);
  const timingOffsets = compositionOffsets || samples.map(() => 0);
  if (![1, 2, 3, 4].includes(lengthSize)) throw new RangeError('HEVC NAL length size must be between 1 and 4 bytes');
  if (sampleDurations.length !== samples.length || timingOffsets.length !== samples.length) throw new RangeError('Timing arrays must match samples');
  if (!Array.isArray(chunks) || chunks.length === 0 || chunks.some((count) => !Number.isInteger(count) || count < 1) || chunks.reduce((sum, count) => sum + count, 0) !== samples.length) {
    throw new RangeError('Chunk sample counts must cover every sample exactly once');
  }
  if (!Array.isArray(sampleDescriptionIndexes) || sampleDescriptionIndexes.length !== chunks.length || sampleDescriptionIndexes.some((index) => !Number.isInteger(index) || index < 1)) {
    throw new RangeError('Sample-description indexes must contain one positive integer per chunk');
  }
  if (!Number.isInteger(chunkPadding) || chunkPadding < 0) throw new RangeError('Chunk padding must be a non-negative integer');
  if (!Array.isArray(audioSamples) || audioSamples.some((sample) => !Buffer.isBuffer(sample) || sample.length === 0)) throw new TypeError('Audio samples must be non-empty Buffers');

  const hvccPayload = Buffer.alloc(23);
  hvccPayload.writeUInt8(1, 0);
  hvccPayload.writeUInt8(0xfc | (lengthSize - 1), 21);
  hvccPayload.writeUInt8(0, 22);
  const hvcC = (extendedHvcc ? extendedBox : box)('hvcC', hvccPayload);
  const hvc1Header = Buffer.alloc(78);
  hvc1Header.writeUInt16BE(1, 6);
  hvc1Header.writeUInt16BE(1920, 24);
  hvc1Header.writeUInt16BE(1080, 26);
  const entry = box(sampleEntry, Buffer.concat([hvc1Header, hvcC]));
  const stsd = fullBox('stsd', 0, 0, Buffer.concat([u32(1), entry]));
  const stsz = fullBox('stsz', 0, 0, Buffer.concat([u32(0), u32(samples.length), ...samples.map((sample) => u32(sample.length))]));
  const stscEntries = [];
  for (let index = 0; index < chunks.length; index += 1) {
    if (index === 0 || chunks[index] !== chunks[index - 1] || sampleDescriptionIndexes[index] !== sampleDescriptionIndexes[index - 1]) {
      stscEntries.push({ firstChunk: index + 1, samplesPerChunk: chunks[index], sampleDescriptionIndex: sampleDescriptionIndexes[index] });
    }
  }
  const stsc = fullBox('stsc', 0, 0, Buffer.concat([
    u32(stscEntries.length),
    ...stscEntries.flatMap(({ firstChunk, samplesPerChunk, sampleDescriptionIndex }) => [u32(firstChunk), u32(samplesPerChunk), u32(sampleDescriptionIndex)])
  ]));
  const sttsEntries = runLength(sampleDurations);
  const stts = fullBox('stts', 0, 0, Buffer.concat([u32(sttsEntries.length), ...sttsEntries.flatMap(({ count, value }) => [u32(count), u32(value)])]));
  const cttsEntries = runLength(timingOffsets);
  const ctts = timingOffsets.some((offset) => offset !== 0)
    ? fullBox('ctts', 1, 0, Buffer.concat([u32(cttsEntries.length), ...cttsEntries.flatMap(({ count, value }) => [u32(count), i32(value)])]))
    : null;
  const mdhd = fullBox('mdhd', 0, 0, Buffer.concat([u32(0), u32(0), u32(timescale), u32(sampleDurations.reduce((sum, value) => sum + value, 0)), Buffer.alloc(4)]));
  const tkhd = fullBox('tkhd', 0, 0, Buffer.concat([u32(0), u32(0), u32(7)]));
  const hdlr = fullBox('hdlr', 0, 0, Buffer.concat([u32(0), Buffer.from('vide')]));

  const mediaParts = [];
  const chunkStarts = [];
  let sampleIndex = 0;
  let mediaPosition = 0;
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    chunkStarts.push(mediaPosition);
    for (let inChunk = 0; inChunk < chunks[chunkIndex]; inChunk += 1) {
      mediaParts.push(samples[sampleIndex]);
      mediaPosition += samples[sampleIndex].length;
      sampleIndex += 1;
    }
    if (chunkIndex < chunks.length - 1 && chunkPadding > 0) {
      mediaParts.push(Buffer.alloc(chunkPadding, 0xee));
      mediaPosition += chunkPadding;
    }
  }
  const videoMediaLength = mediaPosition;
  mediaParts.push(...audioSamples);
  const mediaPayload = Buffer.concat(mediaParts);
  const makeMoov = (chunkOffsets, audioOffset = 0n) => {
    const offsetTable = useCo64 ? co64(chunkOffsets) : stco(chunkOffsets.map(Number));
    const tables = [stsd, stsc, stsz, stts, ...(ctts ? [ctts] : []), offsetTable];
    const stbl = box('stbl', Buffer.concat(tables));
    const mdia = box('mdia', Buffer.concat([mdhd, hdlr, box('minf', stbl)]));
    const tracks = [box('trak', Buffer.concat([tkhd, mdia]))];
    if (audioSamples.length > 0) {
      const audioStsz = fullBox('stsz', 0, 0, Buffer.concat([u32(0), u32(audioSamples.length), ...audioSamples.map((sample) => u32(sample.length))]));
      const audioStsc = fullBox('stsc', 0, 0, Buffer.concat([u32(1), u32(1), u32(audioSamples.length), u32(1)]));
      const audioStts = fullBox('stts', 0, 0, Buffer.concat([u32(1), u32(audioSamples.length), u32(1_000)]));
      tracks.push(track([audioStsz, audioStsc, audioStts, stco([Number(audioOffset)])], 8, 'soun'));
    }
    return (extendedMoov ? extendedBox : box)('moov', Buffer.concat(tracks));
  };
  const placeholder = makeMoov(chunks.map(() => 0n), 0n);
  const mediaStart = BigInt(placeholder.length + (extendedMdat ? 16 : 8));
  const moov = makeMoov(chunkStarts.map((offset) => mediaStart + BigInt(offset)), mediaStart + BigInt(videoMediaLength));
  const mdat = (extendedMdat ? extendedBox : box)('mdat', mediaPayload);
  return Buffer.concat([moov, mdat]);
}

function av1Mp4({
  samples,
  timescale = 30_000,
  durations,
  compositionOffsets,
  chunks = [samples.length],
  co64: useCo64 = false,
  extendedMoov = false,
  extendedMdat = false,
  extendedAv1c = false,
  sampleEntry = 'av01',
  chunkPadding = 0,
  audioSamples = [],
  sampleDescriptionIndexes = chunks.map(() => 1),
  moovAfterMdat = false
}) {
  const sampleDurations = durations || samples.map(() => 1_000);
  const timingOffsets = compositionOffsets || samples.map(() => 0);
  if (sampleDurations.length !== samples.length || timingOffsets.length !== samples.length) throw new RangeError('Timing arrays must match samples');
  if (!Array.isArray(chunks) || chunks.length === 0 || chunks.some((count) => !Number.isInteger(count) || count < 1) || chunks.reduce((sum, count) => sum + count, 0) !== samples.length) {
    throw new RangeError('Chunk sample counts must cover every sample exactly once');
  }
  if (!Array.isArray(sampleDescriptionIndexes) || sampleDescriptionIndexes.length !== chunks.length || sampleDescriptionIndexes.some((index) => !Number.isInteger(index) || index < 1)) {
    throw new RangeError('Sample-description indexes must contain one positive integer per chunk');
  }
  if (!Number.isInteger(chunkPadding) || chunkPadding < 0) throw new RangeError('Chunk padding must be a non-negative integer');
  if (!Array.isArray(audioSamples) || audioSamples.some((sample) => !Buffer.isBuffer(sample) || sample.length === 0)) throw new TypeError('Audio samples must be non-empty Buffers');

  const av1C = (extendedAv1c ? extendedBox : box)('av1C', Buffer.from([0x81, 0x00, 0x00, 0x00]));
  const visualHeader = Buffer.alloc(78);
  visualHeader.writeUInt16BE(1, 6);
  visualHeader.writeUInt16BE(1920, 24);
  visualHeader.writeUInt16BE(1080, 26);
  const entry = box(sampleEntry, Buffer.concat([visualHeader, av1C]));
  const stsd = fullBox('stsd', 0, 0, Buffer.concat([u32(1), entry]));
  const stsz = fullBox('stsz', 0, 0, Buffer.concat([u32(0), u32(samples.length), ...samples.map((sample) => u32(sample.length))]));
  const stscEntries = [];
  for (let index = 0; index < chunks.length; index += 1) {
    if (index === 0 || chunks[index] !== chunks[index - 1] || sampleDescriptionIndexes[index] !== sampleDescriptionIndexes[index - 1]) {
      stscEntries.push({ firstChunk: index + 1, samplesPerChunk: chunks[index], sampleDescriptionIndex: sampleDescriptionIndexes[index] });
    }
  }
  const stsc = fullBox('stsc', 0, 0, Buffer.concat([
    u32(stscEntries.length),
    ...stscEntries.flatMap(({ firstChunk, samplesPerChunk, sampleDescriptionIndex }) => [u32(firstChunk), u32(samplesPerChunk), u32(sampleDescriptionIndex)])
  ]));
  const sttsEntries = runLength(sampleDurations);
  const stts = fullBox('stts', 0, 0, Buffer.concat([u32(sttsEntries.length), ...sttsEntries.flatMap(({ count, value }) => [u32(count), u32(value)])]));
  const cttsEntries = runLength(timingOffsets);
  const ctts = timingOffsets.some((offset) => offset !== 0)
    ? fullBox('ctts', 1, 0, Buffer.concat([u32(cttsEntries.length), ...cttsEntries.flatMap(({ count, value }) => [u32(count), i32(value)])]))
    : null;
  const mdhd = fullBox('mdhd', 0, 0, Buffer.concat([u32(0), u32(0), u32(timescale), u32(sampleDurations.reduce((sum, value) => sum + value, 0)), Buffer.alloc(4)]));
  const tkhd = fullBox('tkhd', 0, 0, Buffer.concat([u32(0), u32(0), u32(7)]));
  const hdlr = fullBox('hdlr', 0, 0, Buffer.concat([u32(0), Buffer.from('vide')]));

  const mediaParts = [];
  const chunkStarts = [];
  let sampleIndex = 0;
  let mediaPosition = 0;
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    chunkStarts.push(mediaPosition);
    for (let inChunk = 0; inChunk < chunks[chunkIndex]; inChunk += 1) {
      mediaParts.push(samples[sampleIndex]);
      mediaPosition += samples[sampleIndex].length;
      sampleIndex += 1;
    }
    if (chunkIndex < chunks.length - 1 && chunkPadding > 0) {
      mediaParts.push(Buffer.alloc(chunkPadding, 0xee));
      mediaPosition += chunkPadding;
    }
  }
  const videoMediaLength = mediaPosition;
  mediaParts.push(...audioSamples);
  const mediaPayload = Buffer.concat(mediaParts);
  const makeMoov = (chunkOffsets, audioOffset = 0n) => {
    const offsetTable = useCo64 ? co64(chunkOffsets) : stco(chunkOffsets.map(Number));
    const tables = [stsd, stsc, stsz, stts, ...(ctts ? [ctts] : []), offsetTable];
    const stbl = box('stbl', Buffer.concat(tables));
    const mdia = box('mdia', Buffer.concat([mdhd, hdlr, box('minf', stbl)]));
    const tracks = [box('trak', Buffer.concat([tkhd, mdia]))];
    if (audioSamples.length > 0) {
      const audioStsz = fullBox('stsz', 0, 0, Buffer.concat([u32(0), u32(audioSamples.length), ...audioSamples.map((sample) => u32(sample.length))]));
      const audioStsc = fullBox('stsc', 0, 0, Buffer.concat([u32(1), u32(1), u32(audioSamples.length), u32(1)]));
      const audioStts = fullBox('stts', 0, 0, Buffer.concat([u32(1), u32(audioSamples.length), u32(1_000)]));
      tracks.push(track([audioStsz, audioStsc, audioStts, stco([Number(audioOffset)])], 8, 'soun'));
    }
    return (extendedMoov ? extendedBox : box)('moov', Buffer.concat(tracks));
  };
  const mdatHeaderSize = extendedMdat ? 16n : 8n;
  let moov;
  let mediaStart;
  if (moovAfterMdat) {
    mediaStart = mdatHeaderSize;
    moov = makeMoov(chunkStarts.map((offset) => mediaStart + BigInt(offset)), mediaStart + BigInt(videoMediaLength));
  } else {
    const placeholder = makeMoov(chunks.map(() => 0n), 0n);
    mediaStart = BigInt(placeholder.length) + mdatHeaderSize;
    moov = makeMoov(chunkStarts.map((offset) => mediaStart + BigInt(offset)), mediaStart + BigInt(videoMediaLength));
  }
  const mdat = (extendedMdat ? extendedBox : box)('mdat', mediaPayload);
  return moovAfterMdat ? Buffer.concat([mdat, moov]) : Buffer.concat([moov, mdat]);
}

module.exports = {
  u32, i32, u64, box, extendedBox, fullBox, fullBoxPayload, stco, co64, track, videoMp4,
  lengthPrefixedSample, annexBSample, teslaSeiNal, unrelatedSeiNal, injectTeslaTelemetryIntoH264Mp4,
  h264Mp4, hevcNal, h265Mp4, av1Mp4, filterH265NalTypes, summarizeH265NalTypes
};
