'use strict';

const {
  parseMp4,
  findBoxes,
  selectVideoTrack,
  sampleTable,
  buildSampleIndex,
  rewriteChunkOffsets,
  makeBox
} = require('./mp4');
const { teslaPayload, fingerprint } = require('./teslaSei');

const UINT32_MAX = 0xffffffffn;
const PICTURE_MARKER = Buffer.from([0x61, 0x01, 0x80]);
const RECORD_LENGTH_SIZE = 4;

function av1Error(message, code = 'INVALID_AV1') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireBuffer(buffer, label = 'AV1 MP4') {
  if (!Buffer.isBuffer(buffer)) throw new TypeError(`${label} must be a Buffer`);
}

function safeNumber(value, label) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw av1Error(`${label} cannot be represented safely`, 'UNSUPPORTED_CONTAINER');
  return Number(value);
}

function nodeBounds(node, label) {
  return {
    contentStart: safeNumber(node.contentStart, `${label} content start`),
    end: safeNumber(node.end, `${label} end`)
  };
}

function parseEmbeddedBoxes(buffer, start, end, context) {
  const boxes = [];
  let cursor = start;
  while (cursor < end) {
    if (end - cursor < 8) throw av1Error(`Truncated ${context} box header`);
    const declared = buffer.readUInt32BE(cursor);
    const type = buffer.toString('ascii', cursor + 4, cursor + 8);
    if (declared === 0) throw av1Error(`Size-zero ${context} box is not supported: ${type}`, 'UNSUPPORTED_CONTAINER');
    const headerSize = declared === 1 ? 16 : 8;
    if (end - cursor < headerSize) throw av1Error(`Truncated ${context} box header: ${type}`);
    const sizeValue = declared === 1 ? buffer.readBigUInt64BE(cursor + 8) : BigInt(declared);
    if (sizeValue < BigInt(headerSize) || sizeValue > BigInt(Number.MAX_SAFE_INTEGER)) throw av1Error(`Invalid ${context} box size: ${type}`);
    const size = Number(sizeValue);
    const boxEnd = cursor + size;
    if (boxEnd > end) throw av1Error(`${context} box exceeds its containing range: ${type}`);
    boxes.push({ type, start: cursor, contentStart: cursor + headerSize, end: boxEnd, headerSize });
    cursor = boxEnd;
  }
  if (cursor !== end) throw av1Error(`Overlapping ${context} boxes are not supported`);
  return boxes;
}

function readAv01Info(tree, track) {
  const activeSampleTable = sampleTable(track);
  const descriptions = (activeSampleTable.children || []).filter((child) => child.type === 'stsd');
  if (descriptions.length !== 1) throw av1Error('Active AV1 sample table must contain exactly one direct stsd box', 'UNSUPPORTED_CONTAINER');
  const bounds = nodeBounds(descriptions[0], 'stsd');
  if (bounds.end - bounds.contentStart < 8) throw av1Error('Truncated stsd box');
  if (tree.buffer.readUInt8(bounds.contentStart) !== 0) throw av1Error('Unsupported stsd version', 'UNSUPPORTED_CONTAINER');
  const entryCount = tree.buffer.readUInt32BE(bounds.contentStart + 4);
  const entries = parseEmbeddedBoxes(tree.buffer, bounds.contentStart + 8, bounds.end, 'sample entry');
  if (entryCount !== 1 || entries.length !== 1) throw av1Error('Video track must contain exactly one sample description', 'UNSUPPORTED_CONTAINER');
  const entry = entries[0];
  if (entry.type !== 'av01') throw av1Error(`Video sample entry must be av01, received ${entry.type}`, 'UNSUPPORTED_CONTAINER');
  if (entry.end - entry.contentStart < 78) throw av1Error('Truncated av01 visual sample entry');
  const children = parseEmbeddedBoxes(tree.buffer, entry.contentStart + 78, entry.end, 'av01 child');
  const configs = children.filter((child) => child.type === 'av1C');
  if (configs.length !== 1) throw av1Error('av01 sample entry must contain exactly one av1C box', 'UNSUPPORTED_CONTAINER');
  const config = configs[0];
  if (config.end - config.contentStart < 4 || tree.buffer.readUInt8(config.contentStart) !== 0x81) throw av1Error('Invalid av1C configuration record');
  return { sampleEntry: entry.type };
}

function requireSoleSampleDescription(samples) {
  const invalid = samples.find((sample) => sample.sampleDescriptionIndex !== 1);
  if (invalid) throw av1Error(`AV1 sample ${invalid.index} references unsupported sample description ${invalid.sampleDescriptionIndex}`, 'UNSUPPORTED_CONTAINER');
}

function validateMappedTimeline(mappedTimeline, sampleCount) {
  if (!Array.isArray(mappedTimeline) || mappedTimeline.length !== sampleCount) throw av1Error('Mapped timeline must match the AV1 video sample count');
  return mappedTimeline.map((mappedSample, sampleIndex) => {
    if (!mappedSample || mappedSample.pictureMarker !== true || !Array.isArray(mappedSample.seiNals)) throw av1Error(`Mapped timeline sample ${sampleIndex} is invalid`);
    return mappedSample.seiNals.map((record, recordIndex) => {
      if (!record || !Buffer.isBuffer(record.nal)) throw av1Error(`Mapped timeline sample ${sampleIndex} SEI ${recordIndex} has no NAL Buffer`);
      if (!teslaPayload(record.nal)) throw av1Error(`Mapped timeline sample ${sampleIndex} SEI ${recordIndex} is not one canonical Tesla H.264 type-5 message`);
      return Buffer.from(record.nal);
    });
  });
}

function lengthPrefixedRecord(nal) {
  if (BigInt(nal.length) > UINT32_MAX) throw av1Error('Telemetry record exceeds its four-byte length field', 'UNSUPPORTED_CONTAINER');
  const prefix = Buffer.alloc(RECORD_LENGTH_SIZE);
  prefix.writeUInt32BE(nal.length);
  return Buffer.concat([prefix, nal]);
}

function validateAllTrackSamples(tree) {
  const samplesByTrack = [];
  const tracks = findBoxes(tree, 'trak');
  for (let trackIndex = 0; trackIndex < tracks.length; trackIndex += 1) {
    try {
      const samples = buildSampleIndex(tracks[trackIndex]);
      for (const sample of samples) {
        const start = safeNumber(sample.offset, `Track ${trackIndex} sample offset`);
        const end = safeNumber(sample.offset + BigInt(sample.size), `Track ${trackIndex} sample end`);
        if (end - start !== sample.size || tree.buffer.subarray(start, end).length !== sample.size) throw av1Error('Sample bytes are not fully readable', 'INVALID_MP4');
      }
      samplesByTrack.push(samples);
    } catch (error) {
      if (!error.path) error.path = `tracks[${trackIndex}]`;
      throw error;
    }
  }
  const extents = samplesByTrack.flat().map((sample) => ({ start: sample.offset, end: sample.offset + BigInt(sample.size) }))
    .sort((left, right) => (left.start < right.start ? -1 : left.start > right.start ? 1 : 0));
  for (let index = 1; index < extents.length; index += 1) {
    if (extents[index].start < extents[index - 1].end) {
      const error = av1Error('Sample extents overlap across tracks', 'INVALID_MP4');
      error.path = 'tracks';
      throw error;
    }
  }
  return samplesByTrack;
}

function telemetryMdat(mappedSeis) {
  const records = [];
  for (const seis of mappedSeis) {
    for (const sei of seis) records.push(lengthPrefixedRecord(sei));
    records.push(lengthPrefixedRecord(PICTURE_MARKER));
  }
  return makeBox('mdat', Buffer.concat(records));
}

function injectAv1Telemetry(encodedMp4, mappedTimeline) {
  requireBuffer(encodedMp4, 'Encoded AV1 MP4');
  const tree = parseMp4(encodedMp4);
  const track = selectVideoTrack(tree);
  readAv01Info(tree, track);
  const samples = buildSampleIndex(track);
  requireSoleSampleDescription(samples);
  const mappedSeis = validateMappedTimeline(mappedTimeline, samples.length);
  const telemetry = telemetryMdat(mappedSeis);
  const shifted = rewriteChunkOffsets(encodedMp4, tree, BigInt(telemetry.length));
  const shiftedTree = parseMp4(shifted);
  const firstRealMdat = shiftedTree.children.find((child) => child.type === 'mdat');
  if (!firstRealMdat) throw av1Error('AV1 MP4 has no real media mdat', 'INVALID_MP4');
  const insertionOffset = safeNumber(firstRealMdat.start, 'First real mdat offset');
  return Buffer.concat([shifted.subarray(0, insertionOffset), telemetry, shifted.subarray(insertionOffset)]);
}

function parseTelemetryPayload(buffer) {
  const groups = [];
  const validationErrors = [];
  let pendingFingerprints = [];
  let pendingRecordTypes = [];
  let pendingValid = true;
  let cursor = 0;
  let recordIndex = 0;
  while (cursor < buffer.length) {
    if (buffer.length - cursor < RECORD_LENGTH_SIZE) {
      validationErrors.push({ code: 'INVALID_AV1_TELEMETRY', path: `telemetry.records[${recordIndex}]`, message: 'Truncated telemetry record length' });
      break;
    }
    const length = buffer.readUInt32BE(cursor);
    cursor += RECORD_LENGTH_SIZE;
    if (length === 0 || length > buffer.length - cursor) {
      validationErrors.push({ code: 'INVALID_AV1_TELEMETRY', path: `telemetry.records[${recordIndex}]`, message: 'Telemetry record length exceeds first mdat payload' });
      break;
    }
    const nal = buffer.subarray(cursor, cursor + length);
    cursor += length;
    if (nal.equals(PICTURE_MARKER)) {
      groups.push({ telemetryFingerprints: pendingFingerprints, pictureMarkerCount: 1, recordTypes: [...pendingRecordTypes, 'marker'], valid: pendingValid });
      pendingFingerprints = [];
      pendingRecordTypes = [];
      pendingValid = true;
    } else {
      const payload = teslaPayload(nal);
      if (!payload) {
        validationErrors.push({ code: 'INVALID_AV1_TELEMETRY', path: `telemetry.records[${recordIndex}]`, message: 'Telemetry record is neither the exact picture marker nor one canonical Tesla H.264 SEI' });
        pendingRecordTypes.push('invalid');
        pendingValid = false;
      } else {
        pendingFingerprints.push(fingerprint(payload));
        pendingRecordTypes.push('sei');
      }
    }
    recordIndex += 1;
  }
  if (pendingFingerprints.length > 0) validationErrors.push({ code: 'INVALID_AV1_TELEMETRY', path: 'telemetry', message: 'Tesla SEI records are missing their terminating picture marker' });
  return { groups, validationErrors, recordCount: recordIndex };
}

function inspectAv1Telemetry(mp4Buffer) {
  requireBuffer(mp4Buffer);
  const validationErrors = [];
  let contextPath = 'mp4';
  let info = null;
  let videoSamples = [];
  try {
    const tree = parseMp4(mp4Buffer);
    contextPath = 'tracks';
    const track = selectVideoTrack(tree);
    const videoTrackIndex = findBoxes(tree, 'trak').indexOf(track);
    contextPath = 'video.sampleDescription';
    info = readAv01Info(tree, track);
    contextPath = `tracks[${videoTrackIndex}]`;
    videoSamples = buildSampleIndex(track);
    requireSoleSampleDescription(videoSamples);

    let samplesByTrack = [];
    let tracksValid = false;
    try {
      samplesByTrack = validateAllTrackSamples(tree);
      tracksValid = true;
    } catch (error) {
      validationErrors.push({ code: error.code || 'INVALID_MP4', path: error.path || 'tracks', message: error.message });
    }
    const mdats = tree.children.filter((child) => child.type === 'mdat');
    if (mdats.length < 2) validationErrors.push({ code: 'INVALID_AV1_TELEMETRY', path: 'mdat', message: 'Telemetry layout requires a first telemetry mdat and at least one later real media mdat' });
    const firstMdat = mdats[0] || null;
    const realMdats = mdats.slice(1);
    const allSamples = samplesByTrack.flat();
    const firstMdatUnreferenced = tracksValid && Boolean(firstMdat) && allSamples.every((sample) => sample.offset >= firstMdat.end || sample.offset + BigInt(sample.size) <= firstMdat.contentStart);
    const allTrackOffsetsInRealMdats = tracksValid && realMdats.length > 0 && allSamples.length > 0 && allSamples.every((sample) => realMdats.some(
      (mdat) => sample.offset >= mdat.contentStart && sample.offset + BigInt(sample.size) <= mdat.end
    ));
    if (tracksValid && !firstMdatUnreferenced) validationErrors.push({ code: 'INVALID_AV1_TELEMETRY', path: 'mdat[0]', message: 'First mdat is referenced by a real track' });
    if (tracksValid && !allTrackOffsetsInRealMdats) validationErrors.push({ code: 'INVALID_AV1_TELEMETRY', path: 'tracks', message: 'Every real track sample must point only into later real media mdats' });

    contextPath = 'telemetry';
    const parsed = firstMdat
      ? parseTelemetryPayload(mp4Buffer.subarray(safeNumber(firstMdat.contentStart, 'Telemetry mdat content start'), safeNumber(firstMdat.end, 'Telemetry mdat end')))
      : { groups: [], validationErrors: [], recordCount: 0 };
    validationErrors.push(...parsed.validationErrors);
    if (parsed.groups.length !== videoSamples.length) validationErrors.push({
      code: 'INVALID_AV1_TELEMETRY',
      path: 'telemetry.samples',
      message: `Telemetry marker count ${parsed.groups.length} does not match AV1 sample count ${videoSamples.length}`
    });
    const samples = videoSamples.map((sample, index) => {
      const group = parsed.groups[index];
      const telemetryFingerprints = group ? group.telemetryFingerprints : [];
      const pictureMarkerCount = group ? group.pictureMarkerCount : 0;
      const recordTypes = group ? group.recordTypes : [];
      return {
        index,
        offset: sample.offset,
        size: sample.size,
        hasPictureMarker: pictureMarkerCount === 1,
        pictureMarkerCount,
        seiCount: telemetryFingerprints.length,
        telemetryFingerprints,
        recordTypes,
        isGap: Boolean(group && group.valid && pictureMarkerCount === 1 && telemetryFingerprints.length === 0),
        layoutValid: pictureMarkerCount === 1 && Boolean(group && group.valid)
      };
    });
    const layoutValid = validationErrors.length === 0 && samples.every((sample) => sample.layoutValid);
    return {
      accepted: layoutValid,
      layoutValid,
      validationErrors,
      sampleEntry: info.sampleEntry,
      lengthSize: RECORD_LENGTH_SIZE,
      sampleCount: samples.length,
      telemetryRecordCount: parsed.recordCount,
      firstMdatUnreferenced,
      allTrackOffsetsInRealMdats,
      samples,
      telemetryFingerprints: samples.flatMap((sample) => sample.telemetryFingerprints)
    };
  } catch (error) {
    validationErrors.push({ code: error.code || 'INVALID_MP4', path: error.path || contextPath, message: error.message });
    return {
      accepted: false,
      layoutValid: false,
      validationErrors,
      sampleEntry: info ? info.sampleEntry : null,
      lengthSize: RECORD_LENGTH_SIZE,
      sampleCount: videoSamples.length,
      telemetryRecordCount: 0,
      firstMdatUnreferenced: false,
      allTrackOffsetsInRealMdats: false,
      samples: [],
      telemetryFingerprints: []
    };
  }
}

module.exports = { injectAv1Telemetry, inspectAv1Telemetry };
