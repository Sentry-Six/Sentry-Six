'use strict';

const CONTAINER_TYPES = new Set(['moov', 'trak', 'edts', 'mdia', 'minf', 'stbl']);
const UINT32_MAX = 0xffffffffn;
const UINT64_MAX = 0xffffffffffffffffn;

function mp4Error(message, code = 'INVALID_MP4') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireType(type) {
  if (typeof type !== 'string' || type.length !== 4) throw new TypeError('MP4 box type must be exactly four ASCII characters');
}

function requireBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('MP4 input must be a Buffer');
}

function toNumber(value, context) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw mp4Error(`${context} cannot be represented safely`);
  return Number(value);
}

function readU64(buffer, offset) {
  return buffer.readBigUInt64BE(offset);
}

function parseRange(buffer, start, end, parent) {
  const children = [];
  let cursor = start;
  while (cursor < end) {
    if (end - cursor < 8n) throw mp4Error('Truncated MP4 box header');
    const offset = toNumber(cursor, 'MP4 box offset');
    const declaredSize = BigInt(buffer.readUInt32BE(offset));
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (declaredSize === 0n) throw mp4Error(`Size-zero MP4 box is not supported: ${type}`);
    const extended = declaredSize === 1n;
    const headerSize = extended ? 16n : 8n;
    if (end - cursor < headerSize) throw mp4Error(`Truncated MP4 box header: ${type}`);
    const size = extended ? readU64(buffer, offset + 8) : declaredSize;
    if (size < headerSize) throw mp4Error(`Invalid MP4 box size: ${type}`);
    const boxEnd = cursor + size;
    if (boxEnd > end) throw mp4Error(`MP4 box exceeds its containing range: ${type}`);
    if (type === 'moof' || type === 'mvex' || type === 'mfra') throw mp4Error(`Fragmented MP4 is not supported: ${type}`, 'UNSUPPORTED_CONTAINER');
    const node = {
      type,
      start: cursor,
      size,
      headerSize,
      contentStart: cursor + headerSize,
      end: boxEnd,
      parent,
      children: []
    };
    if (CONTAINER_TYPES.has(type)) node.children = parseRange(buffer, node.contentStart, node.end, node);
    children.push(node);
    cursor = boxEnd;
  }
  if (cursor !== end) throw mp4Error('Overlapping MP4 boxes are not supported');
  return children;
}

function parseMp4(buffer) {
  requireBuffer(buffer);
  const root = { type: 'root', start: 0n, size: BigInt(buffer.length), headerSize: 0n, contentStart: 0n, end: BigInt(buffer.length), parent: null, children: [] };
  root.buffer = buffer;
  root.children = parseRange(buffer, 0n, root.end, root);
  for (const track of findBoxes(root, 'trak')) validateSimpleEditList(root, track);
  return root;
}

function validateSimpleEditList(tree, track) {
  const edts = uniqueChild(track, 'edts', false);
  if (!edts) return;
  const elst = uniqueChild(edts, 'elst', false);
  if (!elst) throw mp4Error('Edit-list is missing its elst box', 'UNSUPPORTED_CONTAINER');
  const payload = fullBoxData(tree, elst, 4);
  const version = payload.readUInt8(0);
  if (version !== 0 && version !== 1) throw mp4Error('Unsupported elst version', 'UNSUPPORTED_CONTAINER');
  const count = payload.readUInt32BE(4);
  if (count !== 1) throw mp4Error('Only one edit-list entry is supported', 'UNSUPPORTED_CONTAINER');
  const entrySize = version === 1 ? 20 : 12;
  if (payload.length < 8 + entrySize) throw mp4Error('Truncated elst table');
  const entry = 8;
  const mediaTime = version === 1 ? payload.readBigInt64BE(entry + 8) : BigInt(payload.readInt32BE(entry + 4));
  const rateOffset = entry + (version === 1 ? 16 : 8);
  const rateInteger = payload.readInt16BE(rateOffset);
  const rateFraction = payload.readInt16BE(rateOffset + 2);
  if (mediaTime !== 0n || rateInteger !== 1 || rateFraction !== 0) {
    throw mp4Error('Only zero-based, rate-1 edit lists are supported', 'UNSUPPORTED_CONTAINER');
  }
}

function findBoxes(node, type) {
  requireType(type);
  const found = [];
  const visit = (current) => {
    if (current.type === type) found.push(current);
    for (const child of current.children || []) visit(child);
  };
  visit(node);
  return found;
}

function makeBox(type, payload = Buffer.alloc(0)) {
  requireType(type);
  requireBuffer(payload);
  return serializeBox(type, payload, false);
}

function serializedBoxHeaderSize(payloadSize, originalHeaderSize = 8n) {
  if (typeof payloadSize !== 'bigint' || payloadSize < 0n) throw new TypeError('MP4 payload size must be a non-negative BigInt');
  if (originalHeaderSize !== 8n && originalHeaderSize !== 16n) throw new TypeError('MP4 box header size must be 8n or 16n');
  if (originalHeaderSize === 16n) return 16n;
  if (payloadSize + 8n > UINT32_MAX) throw mp4Error('Rebuilding this ordinary MP4 box would require an unsupported extended header', 'UNSUPPORTED_CONTAINER');
  return 8n;
}

function serializeBox(type, payload, forceExtended) {
  const headerSize = serializedBoxHeaderSize(BigInt(payload.length), forceExtended ? 16n : 8n);
  if (headerSize === 16n) {
    const output = Buffer.alloc(16 + payload.length);
    output.writeUInt32BE(1, 0);
    output.write(type, 4, 4, 'ascii');
    output.writeBigUInt64BE(BigInt(payload.length) + 16n, 8);
    payload.copy(output, 16);
    return output;
  }
  const normalSize = BigInt(payload.length) + 8n;
  const output = Buffer.alloc(Number(normalSize));
  output.writeUInt32BE(Number(normalSize), 0);
  output.write(type, 4, 4, 'ascii');
  payload.copy(output, 8);
  return output;
}

function makeFullBox(type, version, flags, payload = Buffer.alloc(0)) {
  if (!Number.isInteger(version) || version < 0 || version > 0xff) throw new RangeError('MP4 full-box version must fit in one byte');
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xffffff) throw new RangeError('MP4 full-box flags must fit in three bytes');
  requireBuffer(payload);
  const fullPayload = Buffer.alloc(4 + payload.length);
  fullPayload.writeUInt8(version, 0);
  fullPayload.writeUIntBE(flags, 1, 3);
  payload.copy(fullPayload, 4);
  return makeBox(type, fullPayload);
}

function uniqueChild(node, type, required = true) {
  const children = (node.children || []).filter((child) => child.type === type);
  if (children.length > 1) throw mp4Error(`Duplicate ${type} boxes are not supported`);
  if (required && children.length === 0) throw mp4Error(`Missing ${type} box`);
  return children[0] || null;
}

function nodePayload(tree, node) {
  return tree.buffer.subarray(toNumber(node.contentStart, 'MP4 payload start'), toNumber(node.end, 'MP4 payload end'));
}

function fullBoxData(tree, node, minimumLength) {
  const payload = nodePayload(tree, node);
  if (payload.length < 4 + minimumLength) throw mp4Error(`Truncated ${node.type} full box`);
  return payload;
}

function trackId(tree, track) {
  const tkhd = uniqueChild(track, 'tkhd');
  const payload = fullBoxData(tree, tkhd, 12);
  const version = payload.readUInt8(0);
  if (version !== 0 && version !== 1) throw mp4Error('Unsupported tkhd version', 'UNSUPPORTED_CONTAINER');
  const idOffset = version === 1 ? 20 : 12;
  if (payload.length < idOffset + 4) throw mp4Error('Truncated tkhd track id');
  return payload.readUInt32BE(idOffset);
}

function isVideoTrack(tree, track) {
  const mdia = uniqueChild(track, 'mdia');
  const hdlr = uniqueChild(mdia, 'hdlr');
  const payload = fullBoxData(tree, hdlr, 8);
  return payload.toString('ascii', 8, 12) === 'vide';
}

function tracksWithUniqueIds(tree) {
  const ids = new Set();
  const tracks = findBoxes(tree, 'trak');
  for (const track of tracks) {
    const id = trackId(tree, track);
    if (ids.has(id)) throw mp4Error(`Duplicate track id ${id}`);
    ids.add(id);
  }
  return tracks;
}

function selectVideoTrack(tree) {
  if (!tree || !Buffer.isBuffer(tree.buffer)) throw new TypeError('selectVideoTrack requires a parsed MP4 tree');
  const candidates = tracksWithUniqueIds(tree);
  const tracks = candidates.filter((track) => isVideoTrack(tree, track));
  if (tracks.length !== 1) throw mp4Error(tracks.length === 0 ? 'No video track found' : 'Multiple video tracks are not supported', 'UNSUPPORTED_CONTAINER');
  const track = tracks[0];
  track.id = trackId(tree, track);
  return track;
}

function rootFor(node) {
  let current = node;
  while (current.parent) current = current.parent;
  if (!Buffer.isBuffer(current.buffer)) throw new TypeError('MP4 node is detached from its parsed tree');
  return current;
}

function sampleTable(track) {
  const mdia = uniqueChild(track, 'mdia');
  uniqueChild(mdia, 'hdlr');
  const minf = uniqueChild(mdia, 'minf');
  return uniqueChild(minf, 'stbl');
}

function tablePayload(tree, node, entrySize, allowedVersions = [0]) {
  const payload = fullBoxData(tree, node, 4);
  if (!allowedVersions.includes(payload.readUInt8(0))) throw mp4Error(`Unsupported ${node.type} version`, 'UNSUPPORTED_CONTAINER');
  const count = payload.readUInt32BE(4);
  const required = 8n + BigInt(count) * BigInt(entrySize);
  if (BigInt(payload.length) < required) throw mp4Error(`Truncated ${node.type} table`);
  return { payload, count };
}

function chunkOffsets(tree, stbl) {
  const stco = (stbl.children || []).filter((child) => child.type === 'stco');
  const co64 = (stbl.children || []).filter((child) => child.type === 'co64');
  if (stco.length > 1 || co64.length > 1 || (stco.length && co64.length)) throw mp4Error('Track has duplicate chunk offset tables');
  const node = stco[0] || co64[0];
  if (!node) throw mp4Error('Track is missing chunk offsets');
  const width = node.type === 'stco' ? 4 : 8;
  const { payload, count } = tablePayload(tree, node, width);
  const offsets = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 8 + index * width;
    offsets.push(width === 4 ? BigInt(payload.readUInt32BE(offset)) : payload.readBigUInt64BE(offset));
  }
  return { node, offsets };
}

function readChunkOffsets(tree, trackId) {
  if (!tree || !Buffer.isBuffer(tree.buffer)) throw new TypeError('readChunkOffsets requires a parsed MP4 tree');
  if (!Number.isInteger(trackId) || trackId < 0) throw new TypeError('track id must be a non-negative integer');
  const track = tracksWithUniqueIds(tree).find((candidate) => trackIdForCandidate(tree, candidate) === trackId);
  if (!track) throw mp4Error(`Track ${trackId} was not found`);
  return chunkOffsets(tree, sampleTable(track)).offsets;
}

function trackIdForCandidate(tree, track) {
  try { return trackId(tree, track); } catch { return null; }
}

function sampleSizes(tree, stbl) {
  const node = uniqueChild(stbl, 'stsz');
  const payload = fullBoxData(tree, node, 12);
  if (payload.readUInt8(0) !== 0) throw mp4Error('Unsupported stsz version', 'UNSUPPORTED_CONTAINER');
  const defaultSize = payload.readUInt32BE(4);
  const count = payload.readUInt32BE(8);
  if (defaultSize !== 0) return Array.from({ length: count }, () => defaultSize);
  if (BigInt(payload.length) < 12n + BigInt(count) * 4n) throw mp4Error('Truncated stsz table');
  const sizes = [];
  for (let index = 0; index < count; index += 1) sizes.push(payload.readUInt32BE(12 + index * 4));
  return sizes;
}

function decodeStsc(tree, stbl, chunkCount) {
  const node = uniqueChild(stbl, 'stsc');
  const { payload, count } = tablePayload(tree, node, 12);
  if (count === 0) throw mp4Error('stsc has no entries');
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 8 + index * 12;
    const firstChunk = payload.readUInt32BE(offset);
    const samplesPerChunk = payload.readUInt32BE(offset + 4);
    const sampleDescriptionIndex = payload.readUInt32BE(offset + 8);
    if (firstChunk === 0 || firstChunk > chunkCount || samplesPerChunk === 0 || sampleDescriptionIndex === 0 || (entries.length && firstChunk <= entries.at(-1).firstChunk)) throw mp4Error('Invalid stsc entries');
    entries.push({ firstChunk, samplesPerChunk, sampleDescriptionIndex });
  }
  if (entries[0].firstChunk !== 1) throw mp4Error('stsc must begin with chunk 1');
  const mapping = [];
  for (let chunk = 1; chunk <= chunkCount; chunk += 1) {
    let entry = entries[0];
    for (const candidate of entries) {
      if (candidate.firstChunk > chunk) break;
      entry = candidate;
    }
    mapping.push({ samplesPerChunk: entry.samplesPerChunk, sampleDescriptionIndex: entry.sampleDescriptionIndex });
  }
  return mapping;
}

function decodeTimeTable(tree, stbl, type, signedOffsets = false) {
  const node = uniqueChild(stbl, type, type === 'stts');
  if (!node) return null;
  const { payload, count } = tablePayload(tree, node, 8, type === 'ctts' ? [0, 1] : [0]);
  const values = [];
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    const offset = 8 + index * 8;
    const sampleCount = payload.readUInt32BE(offset);
    if (sampleCount === 0) throw mp4Error(`Invalid ${type} sample count`);
    const value = signedOffsets && payload.readUInt8(0) === 1 ? BigInt(payload.readInt32BE(offset + 4)) : BigInt(payload.readUInt32BE(offset + 4));
    values.push({ sampleCount, value });
    total += sampleCount;
    if (!Number.isSafeInteger(total)) throw mp4Error(`${type} sample count is unsafe`);
  }
  return { values, total };
}

function validateSampleExtents(tree, samples) {
  const mdats = findBoxes(tree, 'mdat');
  if (mdats.length === 0) throw mp4Error('Track samples require an mdat box');
  const extents = samples.map((sample) => {
    const end = sample.offset + BigInt(sample.size);
    if (end < sample.offset || end > UINT64_MAX) throw mp4Error('Sample extent is outside the unsigned 64-bit range');
    if (!mdats.some((mdat) => sample.offset >= mdat.contentStart && end <= mdat.end)) throw mp4Error('Sample extent is outside mdat media data');
    return { start: sample.offset, end };
  }).sort((left, right) => (left.start < right.start ? -1 : left.start > right.start ? 1 : 0));
  for (let index = 1; index < extents.length; index += 1) {
    if (extents[index].start < extents[index - 1].end) throw mp4Error('Sample extents overlap');
  }
}

function expandTimeEntries(entries, expectedCount, label) {
  if (entries.total !== expectedCount) throw mp4Error(`${label} sample count does not match stsz`);
  const output = [];
  for (const entry of entries.values) for (let count = 0; count < entry.sampleCount; count += 1) output.push(entry.value);
  return output;
}

function buildSampleIndex(track) {
  const tree = rootFor(track);
  trackId(tree, track);
  const stbl = sampleTable(track);
  const { offsets } = chunkOffsets(tree, stbl);
  const sizes = sampleSizes(tree, stbl);
  const chunks = decodeStsc(tree, stbl, offsets.length);
  const stts = decodeTimeTable(tree, stbl, 'stts');
  if (!stts) throw mp4Error('Track is missing stts');
  const durations = expandTimeEntries(stts, sizes.length, 'stts');
  const ctts = decodeTimeTable(tree, stbl, 'ctts', true);
  const compositionOffsets = ctts ? expandTimeEntries(ctts, sizes.length, 'ctts') : Array.from({ length: sizes.length }, () => 0n);
  if (chunks.reduce((total, chunk) => total + chunk.samplesPerChunk, 0) !== sizes.length) throw mp4Error('stsc sample count does not match stsz');
  const output = [];
  let sampleIndex = 0;
  let dts = 0n;
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    let offset = offsets[chunkIndex];
    for (let inChunk = 0; inChunk < chunks[chunkIndex].samplesPerChunk; inChunk += 1) {
      const size = sizes[sampleIndex];
      output.push({ index: sampleIndex, sampleNumber: sampleIndex + 1, sampleDescriptionIndex: chunks[chunkIndex].sampleDescriptionIndex, offset, size, dts, pts: dts + compositionOffsets[sampleIndex], duration: durations[sampleIndex] });
      offset += BigInt(size);
      dts += durations[sampleIndex];
      sampleIndex += 1;
    }
  }
  validateSampleExtents(tree, output);
  return output;
}

function rewrittenOffset(offset, delta, promoted) {
  const structuralShift = promoted.reduce((total, table) => total + (table.node.start < offset ? BigInt(table.count) * 4n : 0n), 0n);
  const result = offset + delta + structuralShift;
  if (result < 0n || result > UINT64_MAX) throw mp4Error('Rewritten chunk offset is outside the unsigned 64-bit range');
  return result;
}

function rewriteChunkOffsets(buffer, tree, delta) {
  requireBuffer(buffer);
  if (!tree || tree.buffer !== buffer) throw new TypeError('rewriteChunkOffsets requires the parsed tree for the supplied buffer');
  if (typeof delta !== 'bigint') throw new TypeError('MP4 chunk offset delta must be a BigInt');
  const tracks = tracksWithUniqueIds(tree);
  const indexedTracks = tracks.map((track) => buildSampleIndex(track));
  validateSampleExtents(tree, indexedTracks.flat());
  const tables = findBoxes(tree, 'stco').concat(findBoxes(tree, 'co64')).map((node) => {
    const { offsets } = chunkOffsets(tree, node.parent);
    return { node, offsets, count: offsets.length, outputCo64: node.type === 'co64', grew: false };
  });
  let changed = true;
  while (changed) {
    changed = false;
    const promoted = tables.filter((table) => table.grew);
    for (const table of tables) {
      if (table.outputCo64) continue;
      if (table.offsets.some((offset) => rewrittenOffset(offset, delta, promoted) > 0xffffffffn)) {
        table.outputCo64 = true;
        table.grew = true;
        changed = true;
      }
    }
  }
  const promoted = tables.filter((table) => table.grew);
  const tableByNode = new Map(tables.map((table) => [table.node, table]));
  const plannedSize = (node) => {
    if (node.type === 'root') return node.children.reduce((total, child) => total + plannedSize(child), 0n);
    const table = tableByNode.get(node);
    const payloadSize = table ? 8n + BigInt(table.count) * (table.outputCo64 ? 8n : 4n) : node.children.length
      ? node.children.reduce((total, child) => total + plannedSize(child), 0n)
      : node.size - node.headerSize;
    return payloadSize + serializedBoxHeaderSize(payloadSize, node.headerSize);
  };
  plannedSize(tree);
  const serialize = (node) => {
    if (node.type === 'root') return Buffer.concat(node.children.map(serialize));
    const table = tableByNode.get(node);
    if (table) {
      const original = nodePayload(tree, node);
      const entryWidth = table.outputCo64 ? 8 : 4;
      const payload = Buffer.alloc(8 + table.count * entryWidth);
      original.copy(payload, 0, 0, 8);
      for (let index = 0; index < table.count; index += 1) {
        const value = rewrittenOffset(table.offsets[index], delta, promoted);
        if (table.outputCo64) payload.writeBigUInt64BE(value, 8 + index * 8);
        else payload.writeUInt32BE(Number(value), 8 + index * 4);
      }
      return serializeBox(table.outputCo64 ? 'co64' : 'stco', payload, node.headerSize === 16n);
    }
    const payload = node.children.length ? Buffer.concat(node.children.map(serialize)) : nodePayload(tree, node);
    return serializeBox(node.type, payload, node.headerSize === 16n);
  };
  return serialize(tree);
}

module.exports = { parseMp4, findBoxes, selectVideoTrack, sampleTable, buildSampleIndex, readChunkOffsets, rewriteChunkOffsets, serializedBoxHeaderSize, makeBox, makeFullBox };
