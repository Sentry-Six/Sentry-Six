'use strict';

const {
  parseMp4,
  findBoxes,
  selectVideoTrack,
  buildSampleIndex,
  serializedBoxHeaderSize
} = require('./mp4');
const { teslaPayload, fingerprint } = require('./teslaSei');

const UINT32_MAX = 0xffffffffn;
const UINT64_MAX = 0xffffffffffffffffn;
const PICTURE_MARKER = Buffer.from([0x61, 0x01, 0x80]);
// App-private UUID namespace for standards-valid HEVC user_data_unregistered.
// It is not a Tesla-provided identifier; the original Tesla H.264 SEI remains
// byte-for-byte inside the UUID-scoped payload and in the separate parser shim.
const PREFIX_SEI_UUID = Buffer.from('Sentry-Six-Tesla', 'ascii');

function h265Error(message, code = 'INVALID_H265') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireBuffer(buffer, label = 'H.265 MP4') {
  if (!Buffer.isBuffer(buffer)) throw new TypeError(`${label} must be a Buffer`);
}

function safeNumber(value, label) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw h265Error(`${label} cannot be represented safely`, 'UNSUPPORTED_CONTAINER');
  return Number(value);
}

function nodeBounds(node, label) {
  return {
    start: safeNumber(node.start, `${label} start`),
    contentStart: safeNumber(node.contentStart, `${label} content start`),
    end: safeNumber(node.end, `${label} end`)
  };
}

function parseEmbeddedBoxes(buffer, start, end, context) {
  const boxes = [];
  let cursor = start;
  while (cursor < end) {
    if (end - cursor < 8) throw h265Error(`Truncated ${context} box header`);
    const declared = buffer.readUInt32BE(cursor);
    const type = buffer.toString('ascii', cursor + 4, cursor + 8);
    if (declared === 0) throw h265Error(`Size-zero ${context} box is not supported: ${type}`, 'UNSUPPORTED_CONTAINER');
    const headerSize = declared === 1 ? 16 : 8;
    if (end - cursor < headerSize) throw h265Error(`Truncated ${context} box header: ${type}`);
    const sizeValue = declared === 1 ? buffer.readBigUInt64BE(cursor + 8) : BigInt(declared);
    if (sizeValue < BigInt(headerSize) || sizeValue > BigInt(Number.MAX_SAFE_INTEGER)) throw h265Error(`Invalid ${context} box size: ${type}`);
    const size = Number(sizeValue);
    const boxEnd = cursor + size;
    if (boxEnd > end) throw h265Error(`${context} box exceeds its containing range: ${type}`);
    boxes.push({ type, start: cursor, contentStart: cursor + headerSize, end: boxEnd, headerSize });
    cursor = boxEnd;
  }
  if (cursor !== end) throw h265Error(`Overlapping ${context} boxes are not supported`);
  return boxes;
}

function validateHvcc(buffer, hvcc) {
  if (hvcc.end - hvcc.contentStart < 23) throw h265Error('Truncated hvcC configuration record');
  if (buffer.readUInt8(hvcc.contentStart) !== 1) throw h265Error('Unsupported hvcC configuration version', 'UNSUPPORTED_CONTAINER');
  const lengthSize = (buffer.readUInt8(hvcc.contentStart + 21) & 0x03) + 1;
  const arrayCount = buffer.readUInt8(hvcc.contentStart + 22);
  let cursor = hvcc.contentStart + 23;
  for (let arrayIndex = 0; arrayIndex < arrayCount; arrayIndex += 1) {
    if (hvcc.end - cursor < 3) throw h265Error('Truncated hvcC NAL array');
    const nalCount = buffer.readUInt16BE(cursor + 1);
    cursor += 3;
    for (let nalIndex = 0; nalIndex < nalCount; nalIndex += 1) {
      if (hvcc.end - cursor < 2) throw h265Error('Truncated hvcC NAL length');
      const nalSize = buffer.readUInt16BE(cursor);
      cursor += 2;
      if (nalSize === 0 || nalSize > hvcc.end - cursor) throw h265Error('Invalid hvcC NAL extent');
      cursor += nalSize;
    }
  }
  if (cursor !== hvcc.end) throw h265Error('Unexpected trailing bytes in hvcC configuration record');
  return lengthSize;
}

function readHvc1Info(tree, track) {
  const descriptions = findBoxes(track, 'stsd');
  if (descriptions.length !== 1) throw h265Error('Video track must contain exactly one stsd box', 'UNSUPPORTED_CONTAINER');
  const bounds = nodeBounds(descriptions[0], 'stsd');
  if (bounds.end - bounds.contentStart < 8) throw h265Error('Truncated stsd box');
  if (tree.buffer.readUInt8(bounds.contentStart) !== 0) throw h265Error('Unsupported stsd version', 'UNSUPPORTED_CONTAINER');
  const entryCount = tree.buffer.readUInt32BE(bounds.contentStart + 4);
  const entries = parseEmbeddedBoxes(tree.buffer, bounds.contentStart + 8, bounds.end, 'sample entry');
  if (entryCount !== 1 || entries.length !== 1) throw h265Error('Video track must contain exactly one sample description', 'UNSUPPORTED_CONTAINER');
  const entry = entries[0];
  if (entry.type !== 'hvc1') throw h265Error(`Video sample entry must be hvc1, received ${entry.type}`, 'UNSUPPORTED_CONTAINER');
  if (entry.end - entry.contentStart < 78) throw h265Error('Truncated hvc1 visual sample entry');
  const children = parseEmbeddedBoxes(tree.buffer, entry.contentStart + 78, entry.end, 'hvc1 child');
  const configs = children.filter((child) => child.type === 'hvcC');
  if (configs.length !== 1) throw h265Error('hvc1 sample entry must contain exactly one hvcC box', 'UNSUPPORTED_CONTAINER');
  return { sampleEntry: entry.type, lengthSize: validateHvcc(tree.buffer, configs[0]) };
}

function hevcNalType(nal) {
  return (nal[0] >> 1) & 0x3f;
}

function parseHevcNals(sample, lengthSize, sampleIndex) {
  requireBuffer(sample, 'H.265 sample');
  if (!Number.isInteger(lengthSize) || lengthSize < 1 || lengthSize > 4) throw h265Error('HEVC NAL length size must be between 1 and 4 bytes', 'UNSUPPORTED_H265');
  const nals = [];
  let cursor = 0;
  while (cursor < sample.length) {
    if (sample.length - cursor < lengthSize) throw h265Error(`Truncated NAL length prefix in sample ${sampleIndex}`);
    const nalSize = sample.readUIntBE(cursor, lengthSize);
    cursor += lengthSize;
    if (nalSize < 2) throw h265Error(`HEVC NAL in sample ${sampleIndex} is shorter than its two-byte header`);
    if (nalSize > sample.length - cursor) throw h265Error(`NAL length exceeds sample boundary in sample ${sampleIndex}`);
    const nal = Buffer.from(sample.subarray(cursor, cursor + nalSize));
    if ((nal[0] & 0x80) !== 0 || (nal[1] & 0x07) === 0) throw h265Error(`Invalid HEVC NAL header in sample ${sampleIndex}`);
    nals.push(nal);
    cursor += nalSize;
  }
  if (nals.length === 0) throw h265Error(`H.265 sample ${sampleIndex} contains no NAL units`);
  return nals;
}

function lengthPrefix(nal, lengthSize) {
  const maximum = (1n << BigInt(lengthSize * 8)) - 1n;
  if (BigInt(nal.length) > maximum) throw h265Error(`Injected NAL does not fit the ${lengthSize}-byte hvcC length field`, 'UNSUPPORTED_H265');
  const prefix = Buffer.alloc(lengthSize);
  prefix.writeUIntBE(nal.length, 0, lengthSize);
  return Buffer.concat([prefix, nal]);
}

function encodeSeiField(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw h265Error('SEI field value is invalid');
  const bytes = [];
  while (value >= 0xff) {
    bytes.push(0xff);
    value -= 0xff;
  }
  bytes.push(value);
  return Buffer.from(bytes);
}

function addEmulationPreventionBytes(rbsp) {
  const output = [];
  let zeros = 0;
  for (const byte of rbsp) {
    if (zeros >= 2 && byte <= 0x03) {
      output.push(0x03);
      zeros = 0;
    }
    output.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Buffer.from(output);
}

function removeEmulationPreventionBytes(ebsp) {
  const output = [];
  let zeros = 0;
  for (let index = 0; index < ebsp.length; index += 1) {
    const byte = ebsp[index];
    if (zeros >= 2 && byte === 0x03) {
      if (index + 1 >= ebsp.length || ebsp[index + 1] > 0x03) return null;
      zeros = 0;
      continue;
    }
    if (zeros >= 2 && byte <= 0x02) return null;
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

function prefixSeiRecord(h264Sei, lengthSize) {
  const userData = Buffer.concat([PREFIX_SEI_UUID, h264Sei]);
  const rbsp = Buffer.concat([
    encodeSeiField(5),
    encodeSeiField(userData.length),
    userData,
    Buffer.from([0x80])
  ]);
  const nal = Buffer.concat([Buffer.from([0x4e, 0x01]), addEmulationPreventionBytes(rbsp)]);
  return lengthPrefix(nal, lengthSize);
}

function compatibilityRecord(h264Sei, lengthSize) {
  const nal = Buffer.concat([Buffer.from([0x66, 0x01]), h264Sei.subarray(2)]);
  return lengthPrefix(nal, lengthSize);
}

function markerRecord(lengthSize) {
  return lengthPrefix(PICTURE_MARKER, lengthSize);
}

function validateMappedTimeline(mappedTimeline, sampleCount) {
  if (!Array.isArray(mappedTimeline) || mappedTimeline.length !== sampleCount) throw h265Error('Mapped timeline must match the H.265 video sample count');
  return mappedTimeline.map((mappedSample, sampleIndex) => {
    if (!mappedSample || mappedSample.pictureMarker !== true || !Array.isArray(mappedSample.seiNals)) throw h265Error(`Mapped timeline sample ${sampleIndex} is invalid`);
    return mappedSample.seiNals.map((record, recordIndex) => {
      if (!record || !Buffer.isBuffer(record.nal)) throw h265Error(`Mapped timeline sample ${sampleIndex} SEI ${recordIndex} has no NAL Buffer`);
      if (!teslaPayload(record.nal)) throw h265Error(`Mapped timeline sample ${sampleIndex} SEI ${recordIndex} is not one canonical Tesla H.264 type-5 message`);
      return record.nal;
    });
  });
}

function requireSoleSampleDescription(samples) {
  const invalid = samples.find((sample) => sample.sampleDescriptionIndex !== 1);
  if (invalid) throw h265Error(`H.265 sample ${invalid.index} references unsupported sample description ${invalid.sampleDescriptionIndex}`, 'UNSUPPORTED_CONTAINER');
}

function isRecognizedInjectedRecord(nal) {
  if (nal.equals(PICTURE_MARKER)) return true;
  if (standardPrefixPayload(nal)) return true;
  if (nal.length >= 3 && nal[0] === 0x66 && nal[1] === 0x01) {
    return teslaPayload(Buffer.concat([Buffer.from([0x06, 0x05]), nal.subarray(2)])) !== null;
  }
  return false;
}

function standardPrefixPayload(nal) {
  if (nal.length < 2 || nal[0] !== 0x4e || nal[1] !== 0x01) return null;
  const rbsp = removeEmulationPreventionBytes(nal.subarray(2));
  if (!rbsp) return null;
  const state = { cursor: 0 };
  const payloadType = readSeiField(rbsp, state);
  const payloadSize = readSeiField(rbsp, state);
  if (payloadType !== 5 || payloadSize === null || payloadSize > rbsp.length - state.cursor) return null;
  const payloadEnd = state.cursor + payloadSize;
  if (payloadEnd !== rbsp.length - 1 || rbsp[payloadEnd] !== 0x80) return null;
  const payload = rbsp.subarray(state.cursor, payloadEnd);
  if (payload.length <= PREFIX_SEI_UUID.length || !payload.subarray(0, PREFIX_SEI_UUID.length).equals(PREFIX_SEI_UUID)) return null;
  return teslaPayload(payload.subarray(PREFIX_SEI_UUID.length));
}

function directPayload(tree, node) {
  const { contentStart, end } = nodeBounds(node, node.type);
  return tree.buffer.subarray(contentStart, end);
}

function readChunkTable(tree, node) {
  const payload = directPayload(tree, node);
  const width = node.type === 'co64' ? 8 : 4;
  if (payload.length < 8 || payload.readUInt8(0) !== 0) throw h265Error(`Unsupported ${node.type} table`, 'UNSUPPORTED_CONTAINER');
  const count = payload.readUInt32BE(4);
  if (payload.length !== 8 + count * width) throw h265Error(`Invalid ${node.type} table length`);
  const offsets = [];
  for (let index = 0; index < count; index += 1) {
    offsets.push(width === 8 ? payload.readBigUInt64BE(8 + index * width) : BigInt(payload.readUInt32BE(8 + index * width)));
  }
  return { node, offsets, outputCo64: node.type === 'co64' };
}

function planChunkOffsetTables(tables, projectBaseOffset = (offset) => offset) {
  if (!Array.isArray(tables) || typeof projectBaseOffset !== 'function') throw new TypeError('Chunk offset planning requires tables and a projection function');
  const plans = tables.map((table, tableIndex) => {
    const type = table.type || (table.node && table.node.type);
    const start = table.start === undefined && table.node ? table.node.start : table.start;
    if (!['stco', 'co64'].includes(type) || typeof start !== 'bigint' || !Array.isArray(table.offsets) || table.offsets.some((offset) => typeof offset !== 'bigint')) {
      throw new TypeError(`Invalid chunk offset table ${tableIndex}`);
    }
    if (type === 'stco' && table.offsets.some((offset) => offset < 0n || offset > UINT32_MAX)) throw h265Error('Input stco offset exceeds 32 bits', 'INVALID_MP4');
    return { type, start, offsets: table.offsets, promoted: false };
  });
  const projectedOffset = (table, tableIndex, entryIndex) => {
    const originalOffset = table.offsets[entryIndex];
    const base = projectBaseOffset(originalOffset, tableIndex, entryIndex);
    if (typeof base !== 'bigint') throw new TypeError('Projected chunk offsets must be BigInts');
    const promotionGrowth = plans.reduce((total, candidate) => total + (candidate.promoted && candidate.start < originalOffset ? BigInt(candidate.offsets.length) * 4n : 0n), 0n);
    const value = base + promotionGrowth;
    if (value < 0n || value > UINT64_MAX) throw h265Error('Rewritten chunk offset is outside the unsigned 64-bit range');
    return value;
  };
  let changed;
  do {
    changed = false;
    plans.forEach((table, tableIndex) => {
      if (table.type === 'stco' && !table.promoted && table.offsets.some((_offset, entryIndex) => projectedOffset(table, tableIndex, entryIndex) > UINT32_MAX)) {
        table.promoted = true;
        changed = true;
      }
    });
  } while (changed);
  return {
    structuralGrowth: plans.reduce((total, table) => total + (table.promoted ? BigInt(table.offsets.length) * 4n : 0n), 0n),
    tables: plans.map((table, tableIndex) => ({
      type: table.type === 'co64' || table.promoted ? 'co64' : 'stco',
      promoted: table.promoted,
      offsets: table.offsets.map((_offset, entryIndex) => projectedOffset(table, tableIndex, entryIndex))
    }))
  };
}

function serializeBox(type, payload, originalHeaderSize) {
  const headerSize = serializedBoxHeaderSize(BigInt(payload.length), originalHeaderSize);
  const totalSize = BigInt(payload.length) + headerSize;
  if (totalSize > BigInt(Number.MAX_SAFE_INTEGER)) throw h265Error(`Rebuilt ${type} box cannot be represented safely`, 'UNSUPPORTED_CONTAINER');
  const output = Buffer.alloc(Number(totalSize));
  if (headerSize === 16n) {
    output.writeUInt32BE(1, 0);
    output.write(type, 4, 4, 'ascii');
    output.writeBigUInt64BE(totalSize, 8);
    payload.copy(output, 16);
  } else {
    output.writeUInt32BE(Number(totalSize), 0);
    output.write(type, 4, 4, 'ascii');
    payload.copy(output, 8);
  }
  return output;
}

function makeStszPayload(tree, node, sampleSizes) {
  const original = directPayload(tree, node);
  if (original.length < 12 || original.readUInt8(0) !== 0) throw h265Error('Unsupported stsz table', 'UNSUPPORTED_CONTAINER');
  if (original.readUInt32BE(8) !== sampleSizes.length) throw h265Error('stsz sample count changed unexpectedly');
  const payload = Buffer.alloc(12 + sampleSizes.length * 4);
  original.copy(payload, 0, 0, 4);
  payload.writeUInt32BE(0, 4);
  payload.writeUInt32BE(sampleSizes.length, 8);
  sampleSizes.forEach((size, index) => {
    if (!Number.isInteger(size) || size < 1 || size > Number(UINT32_MAX)) throw h265Error('Injected sample size exceeds stsz limits', 'UNSUPPORTED_CONTAINER');
    payload.writeUInt32BE(size, 12 + index * 4);
  });
  return payload;
}

function validateAllTrackSamples(tree) {
  const tracks = findBoxes(tree, 'trak');
  const samplesByTrack = new Map();
  for (let trackIndex = 0; trackIndex < tracks.length; trackIndex += 1) {
    try {
      const samples = buildSampleIndex(tracks[trackIndex]);
      for (const sample of samples) {
        const start = safeNumber(sample.offset, `Track ${trackIndex} sample offset`);
        const end = safeNumber(sample.offset + BigInt(sample.size), `Track ${trackIndex} sample end`);
        if (end - start !== sample.size || tree.buffer.subarray(start, end).length !== sample.size) throw h265Error('Sample bytes are not fully readable', 'INVALID_MP4');
      }
      samplesByTrack.set(tracks[trackIndex], samples);
    } catch (error) {
      if (!error.path) error.path = `tracks[${trackIndex}]`;
      throw error;
    }
  }
  const allExtents = [...samplesByTrack.values()].flat().map((sample) => ({ start: sample.offset, end: sample.offset + BigInt(sample.size) }))
    .sort((left, right) => (left.start < right.start ? -1 : left.start > right.start ? 1 : 0));
  for (let index = 1; index < allExtents.length; index += 1) {
    if (allExtents[index].start < allExtents[index - 1].end) {
      const error = h265Error('Sample extents overlap across tracks', 'INVALID_MP4');
      error.path = 'tracks';
      throw error;
    }
  }
  return samplesByTrack;
}

function rebuildMp4(tree, videoTrack, sampleInsertions) {
  const samplesByTrack = validateAllTrackSamples(tree);
  const videoSamples = samplesByTrack.get(videoTrack);
  const stszNodes = findBoxes(videoTrack, 'stsz');
  if (stszNodes.length !== 1) throw h265Error('Video track must contain exactly one stsz box', 'UNSUPPORTED_CONTAINER');
  const newSampleSizes = videoSamples.map((sample) => {
    const size = sample.size + sampleInsertions[sample.index].length;
    if (!Number.isSafeInteger(size)) throw h265Error('Injected sample size cannot be represented safely', 'UNSUPPORTED_CONTAINER');
    return size;
  });
  const replacementPayloads = new Map([[stszNodes[0], makeStszPayload(tree, stszNodes[0], newSampleSizes)]]);

  const insertions = videoSamples.map((sample) => ({ offset: sample.offset, data: sampleInsertions[sample.index] }))
    .sort((left, right) => (left.offset < right.offset ? -1 : left.offset > right.offset ? 1 : 0));
  for (let index = 1; index < insertions.length; index += 1) {
    if (insertions[index].offset === insertions[index - 1].offset) throw h265Error('Video samples share an insertion offset');
  }

  const mdats = findBoxes(tree, 'mdat');
  const insertionsByMdat = new Map(mdats.map((mdat) => [mdat, []]));
  for (const insertion of insertions) {
    const mdat = mdats.find((candidate) => insertion.offset >= candidate.contentStart && insertion.offset < candidate.end);
    if (!mdat) throw h265Error('Telemetry insertion is outside mdat media data');
    insertionsByMdat.get(mdat).push(insertion);
  }

  const chunkTables = findBoxes(tree, 'stco').concat(findBoxes(tree, 'co64')).map((node) => readChunkTable(tree, node));
  const tableByNode = new Map(chunkTables.map((table) => [table.node, table]));

  const plannedSize = (node, cache) => {
    if (cache.has(node)) return cache.get(node);
    let payloadSize;
    const replacement = replacementPayloads.get(node);
    const table = tableByNode.get(node);
    if (replacement) payloadSize = BigInt(replacement.length);
    else if (table) payloadSize = 8n + BigInt(table.offsets.length) * (table.outputCo64 ? 8n : 4n);
    else if (node.type === 'mdat') {
      const growth = insertionsByMdat.get(node).reduce((sum, insertion) => sum + BigInt(insertion.data.length), 0n);
      payloadSize = node.size - node.headerSize + growth;
    } else if (node.children.length) payloadSize = node.children.reduce((sum, child) => sum + plannedSize(child, cache), 0n);
    else payloadSize = node.size - node.headerSize;
    const size = payloadSize + serializedBoxHeaderSize(payloadSize, node.headerSize);
    cache.set(node, size);
    return size;
  };

  const mapMediaOffset = (oldOffset, cache) => {
    if (oldOffset < 0n || oldOffset > UINT64_MAX) throw h265Error('Chunk offset is outside the unsigned 64-bit range');
    let precedingShift = 0n;
    let containingMdat = null;
    for (const topLevel of tree.children) {
      if (oldOffset >= topLevel.end) precedingShift += plannedSize(topLevel, cache) - topLevel.size;
      else if (oldOffset >= topLevel.contentStart && oldOffset < topLevel.end) {
        if (topLevel.type !== 'mdat') throw h265Error('Chunk offset does not point into top-level mdat media data');
        containingMdat = topLevel;
        break;
      } else if (oldOffset < topLevel.start) break;
    }
    if (!containingMdat) throw h265Error('Chunk offset does not point into mdat media data');
    const headerSize = serializedBoxHeaderSize(plannedSize(containingMdat, cache) - containingMdat.headerSize, containingMdat.headerSize);
    const inMdatGrowth = insertionsByMdat.get(containingMdat)
      .filter((insertion) => insertion.offset < oldOffset)
      .reduce((sum, insertion) => sum + BigInt(insertion.data.length), 0n);
    const mapped = containingMdat.start + precedingShift + headerSize + (oldOffset - containingMdat.contentStart) + inMdatGrowth;
    if (mapped < 0n || mapped > UINT64_MAX) throw h265Error('Rewritten chunk offset is outside the unsigned 64-bit range');
    return mapped;
  };

  const baseCache = new Map();
  tree.children.forEach((node) => plannedSize(node, baseCache));
  const offsetPlan = planChunkOffsetTables(chunkTables.map((table) => ({
    type: table.node.type,
    start: table.node.start,
    offsets: table.offsets
  })), (offset) => mapMediaOffset(offset, baseCache));
  chunkTables.forEach((table, index) => {
    table.outputCo64 = offsetPlan.tables[index].type === 'co64';
    table.outputOffsets = offsetPlan.tables[index].offsets;
  });

  const finalCache = new Map();
  tree.children.forEach((node) => plannedSize(node, finalCache));
  for (const table of chunkTables) {
    const payload = Buffer.alloc(8 + table.offsets.length * (table.outputCo64 ? 8 : 4));
    const original = directPayload(tree, table.node);
    original.copy(payload, 0, 0, 4);
    payload.writeUInt32BE(table.offsets.length, 4);
    table.outputOffsets.forEach((mapped, index) => {
      if (table.outputCo64) payload.writeBigUInt64BE(mapped, 8 + index * 8);
      else payload.writeUInt32BE(Number(mapped), 8 + index * 4);
    });
    replacementPayloads.set(table.node, payload);
  }

  const serialize = (node) => {
    const replacement = replacementPayloads.get(node);
    if (replacement) {
      const table = tableByNode.get(node);
      return serializeBox(table && table.outputCo64 ? 'co64' : node.type, replacement, node.headerSize);
    }
    if (node.type === 'mdat') {
      const { contentStart, end } = nodeBounds(node, 'mdat');
      const parts = [];
      let cursor = contentStart;
      for (const insertion of insertionsByMdat.get(node)) {
        const offset = safeNumber(insertion.offset, 'Telemetry insertion offset');
        parts.push(tree.buffer.subarray(cursor, offset), insertion.data);
        cursor = offset;
      }
      parts.push(tree.buffer.subarray(cursor, end));
      return serializeBox(node.type, Buffer.concat(parts), node.headerSize);
    }
    const payload = node.children.length ? Buffer.concat(node.children.map(serialize)) : directPayload(tree, node);
    return serializeBox(node.type, payload, node.headerSize);
  };
  return Buffer.concat(tree.children.map(serialize));
}

function inspectSample(nals, sample) {
  const telemetryFingerprints = [];
  const compatibilityFingerprints = [];
  let pictureMarkerCount = 0;
  for (const nal of nals) {
    if (nal.equals(PICTURE_MARKER)) pictureMarkerCount += 1;
    if (nal.length >= 3 && nal[0] === 0x4e && nal[1] === 0x01) {
      const payload = standardPrefixPayload(nal);
      if (payload) telemetryFingerprints.push(fingerprint(payload));
    }
    if (nal.length >= 3 && nal[0] === 0x66 && nal[1] === 0x01) {
      const payload = teslaPayload(Buffer.concat([Buffer.from([0x06, 0x05]), nal.subarray(2)]));
      if (payload) compatibilityFingerprints.push(fingerprint(payload));
    }
  }
  const canonicalTypes = [
    ...telemetryFingerprints.map(() => 39),
    ...compatibilityFingerprints.map(() => 51),
    48
  ];
  const leadingTypes = nals.slice(0, canonicalTypes.length).map(hevcNalType);
  return {
    index: sample.index,
    offset: sample.offset,
    size: sample.size,
    hasPictureMarker: pictureMarkerCount > 0,
    pictureMarkerCount,
    seiCount: telemetryFingerprints.length,
    compatibilityCount: compatibilityFingerprints.length,
    telemetryFingerprints,
    compatibilityFingerprints,
    nalTypes: nals.map(hevcNalType),
    layoutValid: pictureMarkerCount === 1
      && telemetryFingerprints.length === compatibilityFingerprints.length
      && telemetryFingerprints.every((value, index) => value === compatibilityFingerprints[index])
      && leadingTypes.length === canonicalTypes.length
      && leadingTypes.every((value, index) => value === canonicalTypes[index])
  };
}

function inspectH265Telemetry(mp4Buffer) {
  requireBuffer(mp4Buffer);
  const tree = parseMp4(mp4Buffer);
  const track = selectVideoTrack(tree);
  const info = readHvc1Info(tree, track);
  const videoIndex = buildSampleIndex(track);
  requireSoleSampleDescription(videoIndex);
  const validationErrors = [];
  try {
    validateAllTrackSamples(tree);
  } catch (error) {
    validationErrors.push({ code: error.code || 'INVALID_MP4', path: error.path || 'tracks', message: error.message });
  }
  const samples = videoIndex.map((sample) => {
    const start = safeNumber(sample.offset, 'H.265 sample offset');
    const bytes = mp4Buffer.subarray(start, start + sample.size);
    return inspectSample(parseHevcNals(bytes, info.lengthSize, sample.index), sample);
  });
  const layoutValid = validationErrors.length === 0 && samples.every((sample) => sample.layoutValid);
  return {
    accepted: layoutValid,
    layoutValid,
    validationErrors,
    sampleEntry: info.sampleEntry,
    lengthSize: info.lengthSize,
    sampleCount: samples.length,
    samples,
    telemetryFingerprints: samples.flatMap((sample) => sample.telemetryFingerprints),
    compatibilityFingerprints: samples.flatMap((sample) => sample.compatibilityFingerprints)
  };
}

function injectH265Telemetry(encodedMp4, mappedTimeline) {
  requireBuffer(encodedMp4, 'Encoded H.265 MP4');
  const tree = parseMp4(encodedMp4);
  const track = selectVideoTrack(tree);
  const info = readHvc1Info(tree, track);
  const samples = buildSampleIndex(track);
  requireSoleSampleDescription(samples);
  const mappedSeis = validateMappedTimeline(mappedTimeline, samples.length);
  const insertions = samples.map((sample) => {
    const start = safeNumber(sample.offset, 'H.265 sample offset');
    const originalNals = parseHevcNals(encodedMp4.subarray(start, start + sample.size), info.lengthSize, sample.index);
    if (originalNals.some(isRecognizedInjectedRecord)) throw h265Error(`H.265 sample ${sample.index} already contains a Tesla compatibility record`, 'UNSUPPORTED_H265');
    const standards = mappedSeis[sample.index].map((nal) => prefixSeiRecord(nal, info.lengthSize));
    const compatibility = mappedSeis[sample.index].map((nal) => compatibilityRecord(nal, info.lengthSize));
    return Buffer.concat([...standards, ...compatibility, markerRecord(info.lengthSize)]);
  });
  return rebuildMp4(tree, track, insertions);
}

module.exports = { injectH265Telemetry, inspectH265Telemetry, planChunkOffsetTables };
