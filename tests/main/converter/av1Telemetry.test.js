'use strict';

const crypto = require('crypto');
const {
  box,
  av1Mp4,
  teslaSeiNal
} = require('./fixtureBuilders');
const {
  parseMp4,
  findBoxes,
  selectVideoTrack,
  buildSampleIndex,
  readChunkOffsets,
  rewriteChunkOffsets
} = require('../../../src/main/converter/mp4');
const {
  injectAv1Telemetry,
  inspectAv1Telemetry
} = require('../../../src/main/converter/av1Telemetry');

const PICTURE_MARKER = Buffer.from([0x61, 0x01, 0x80]);

function mapped(seiNalsBySample) {
  return seiNalsBySample.map((nals, index) => ({
    ptsUs: index * 33_333,
    pictureMarker: true,
    seiNals: nals.map((nal) => ({ nal, fingerprint: 'input metadata is not trusted' }))
  }));
}

function record(nal) {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(nal.length);
  return Buffer.concat([prefix, nal]);
}

function sampleBytes(mp4Buffer) {
  const tree = parseMp4(mp4Buffer);
  return buildSampleIndex(selectVideoTrack(tree)).map((sample) => Buffer.from(
    mp4Buffer.subarray(Number(sample.offset), Number(sample.offset) + sample.size)
  ));
}

function allTrackSamples(tree) {
  return findBoxes(tree, 'trak').flatMap((track) => buildSampleIndex(track));
}

function fingerprint(payload) {
  return crypto.createHash('sha256').update(Buffer.from(payload)).digest('hex');
}

function splitAtSampleIntoMdats(source, splitSampleIndex) {
  const tree = parseMp4(source);
  const track = selectVideoTrack(tree);
  const samples = buildSampleIndex(track);
  const moov = findBoxes(tree, 'moov')[0];
  const mdat = findBoxes(tree, 'mdat')[0];
  const stco = findBoxes(track, 'stco')[0];
  const splitOffset = samples[splitSampleIndex].offset;
  const moovBytes = Buffer.from(source.subarray(Number(moov.start), Number(moov.end)));
  const entryCount = source.readUInt32BE(Number(stco.contentStart) + 4);
  for (let index = 0; index < entryCount; index += 1) {
    const sourcePosition = Number(stco.contentStart) + 8 + index * 4;
    const destinationPosition = sourcePosition - Number(moov.start);
    const offset = BigInt(source.readUInt32BE(sourcePosition));
    if (offset >= splitOffset) moovBytes.writeUInt32BE(Number(offset + 8n), destinationPosition);
  }
  return Buffer.concat([
    moovBytes,
    box('mdat', source.subarray(Number(mdat.contentStart), Number(splitOffset))),
    box('mdat', source.subarray(Number(splitOffset), Number(mdat.end)))
  ]);
}

function appendFirstMdatRecord(mp4Buffer, nal) {
  const extra = record(nal);
  const shifted = rewriteChunkOffsets(mp4Buffer, parseMp4(mp4Buffer), BigInt(extra.length));
  const tree = parseMp4(shifted);
  const first = tree.children.find((child) => child.type === 'mdat');
  if (!first || first.headerSize !== 8n) throw new Error('Test helper requires an ordinary first mdat');
  const payload = Buffer.concat([
    shifted.subarray(Number(first.contentStart), Number(first.end)),
    extra
  ]);
  return Buffer.concat([
    shifted.subarray(0, Number(first.start)),
    box('mdat', payload),
    shifted.subarray(Number(first.end))
  ]);
}

function prependTopLevelBox(mp4Buffer, prefixBox) {
  const shifted = rewriteChunkOffsets(mp4Buffer, parseMp4(mp4Buffer), BigInt(prefixBox.length));
  return Buffer.concat([prefixBox, shifted]);
}

function insertTopLevelBeforeFirstMdat(mp4Buffer, insertedBox) {
  const shifted = rewriteChunkOffsets(mp4Buffer, parseMp4(mp4Buffer), BigInt(insertedBox.length));
  const firstMdat = parseMp4(shifted).children.find((child) => child.type === 'mdat');
  return Buffer.concat([
    shifted.subarray(0, Number(firstMdat.start)),
    insertedBox,
    shifted.subarray(Number(firstMdat.start))
  ]);
}

function misplaceActiveStsdInNestedStbl(mp4Buffer) {
  const shifted = rewriteChunkOffsets(mp4Buffer, parseMp4(mp4Buffer), 8n);
  const tree = parseMp4(shifted);
  const stsd = findBoxes(selectVideoTrack(tree), 'stsd')[0];
  const serialize = (node) => {
    if (node.type === 'root') return Buffer.concat(node.children.map(serialize));
    const original = Buffer.from(shifted.subarray(Number(node.start), Number(node.end)));
    if (node === stsd) return box('stbl', original);
    if (!node.children.length) return original;
    return box(node.type, Buffer.concat(node.children.map(serialize)));
  };
  return serialize(tree);
}

describe('AV1 Tesla telemetry writer', () => {
  test('writes the proven telemetry-first mdat while preserving every AV1 media byte', () => {
    const originals = [
      Buffer.from([0x12, 0x00, 0x01, 0xaa]),
      Buffer.from([0x32, 0xbb, 0xcc]),
      Buffer.from([0x0a, 0x10, 0x20, 0x30, 0x40])
    ];
    const first = teslaSeiNal([0x11]);
    const second = teslaSeiNal([0x00, 0x00, 0x03, 0x01]);
    const third = teslaSeiNal([0x33]);
    const encoded = av1Mp4({ samples: originals, chunks: [2, 1], chunkPadding: 3 });
    const withFtyp = prependTopLevelBox(encoded, box('ftyp', Buffer.from('isomav01', 'ascii')));
    const source = insertTopLevelBeforeFirstMdat(withFtyp, box('free'));
    const sourceTree = parseMp4(source);
    const sourceMedia = findBoxes(sourceTree, 'mdat').map((mdat) => Buffer.from(source.subarray(Number(mdat.contentStart), Number(mdat.end))));

    const output = injectAv1Telemetry(source, mapped([[first, second], [], [third]]));
    const tree = parseMp4(output);
    const mdats = tree.children.filter((child) => child.type === 'mdat');
    const samples = allTrackSamples(tree);
    const inspected = inspectAv1Telemetry(output);

    expect(mdats).toHaveLength(2);
    expect(tree.children.map(({ type }) => type)).toEqual(['ftyp', 'moov', 'free', 'mdat', 'mdat']);
    expect(mdats[0].start).toBeLessThan(mdats[1].start);
    expect(samples.every((sample) => sample.offset >= mdats[1].contentStart && sample.offset + BigInt(sample.size) <= mdats[1].end)).toBe(true);
    expect(samples.some((sample) => sample.offset < mdats[0].end && sample.offset + BigInt(sample.size) > mdats[0].contentStart)).toBe(false);
    expect(output.subarray(Number(mdats[0].contentStart), Number(mdats[0].end))).toEqual(Buffer.concat([
      record(first), record(second), record(PICTURE_MARKER),
      record(PICTURE_MARKER),
      record(third), record(PICTURE_MARKER)
    ]));
    expect(findBoxes(tree, 'mdat').slice(1).map((mdat) => Buffer.from(output.subarray(Number(mdat.contentStart), Number(mdat.end))))).toEqual(sourceMedia);
    expect(sampleBytes(output)).toEqual(sampleBytes(source));
    for (const type of ['stsd', 'stsc', 'stsz', 'stts']) {
      const sourceBox = findBoxes(sourceTree, type)[0];
      const outputBox = findBoxes(tree, type)[0];
      expect(output.subarray(Number(outputBox.start), Number(outputBox.end))).toEqual(source.subarray(Number(sourceBox.start), Number(sourceBox.end)));
    }
    const sourceTrack = selectVideoTrack(sourceTree);
    const outputTrack = selectVideoTrack(tree);
    expect(readChunkOffsets(tree, outputTrack.id)).toEqual(readChunkOffsets(sourceTree, sourceTrack.id).map((offset) => offset + mdats[0].size));
    expect(inspected).toEqual(expect.objectContaining({ accepted: true, layoutValid: true, validationErrors: [], sampleEntry: 'av01', lengthSize: 4, sampleCount: 3 }));
    expect(inspected.samples.map(({ seiCount, pictureMarkerCount }) => [seiCount, pictureMarkerCount])).toEqual([[2, 1], [0, 1], [1, 1]]);
    expect(inspected.samples.map(({ recordTypes, isGap }) => [recordTypes, isGap])).toEqual([
      [['sei', 'sei', 'marker'], false],
      [['marker'], true],
      [['sei', 'marker'], false]
    ]);
    expect(inspected.samples.map(({ telemetryFingerprints }) => telemetryFingerprints)).toEqual([
      [fingerprint([0x11]), fingerprint([0x00, 0x00, 0x01])],
      [],
      [fingerprint([0x33])]
    ]);
  });

  test('preserves extended boxes and co64 while shifting video and audio only into real media', () => {
    const originals = [Buffer.from([0x12, 0x51]), Buffer.from([0x32, 0x52]), Buffer.from([0x0a, 0x53])];
    const audio = [Buffer.from([0xa1, 0xa2]), Buffer.from([0xb1, 0xb2, 0xb3])];
    const source = av1Mp4({
      samples: originals,
      chunks: [2, 1],
      co64: true,
      extendedMoov: true,
      extendedMdat: true,
      extendedAv1c: true,
      chunkPadding: 5,
      audioSamples: audio
    });
    const sourceTree = parseMp4(source);
    const sourcePayload = Buffer.from(source.subarray(Number(findBoxes(sourceTree, 'mdat')[0].contentStart), Number(findBoxes(sourceTree, 'mdat')[0].end)));

    const output = injectAv1Telemetry(source, mapped([[teslaSeiNal([0x41])], [], []]));
    const tree = parseMp4(output);
    const mdats = tree.children.filter((child) => child.type === 'mdat');
    const tracks = findBoxes(tree, 'trak');

    expect(findBoxes(tree, 'moov')[0].headerSize).toBe(16n);
    expect(mdats.map(({ headerSize }) => headerSize)).toEqual([8n, 16n]);
    expect(findBoxes(tree, 'co64')).toHaveLength(1);
    expect(findBoxes(tree, 'stco')).toHaveLength(1);
    expect(output.subarray(Number(mdats[1].contentStart), Number(mdats[1].end))).toEqual(sourcePayload);
    expect(sampleBytes(output)).toEqual(originals);
    expect(tracks.flatMap((track) => buildSampleIndex(track)).every((sample) => sample.offset >= mdats[1].contentStart && sample.offset + BigInt(sample.size) <= mdats[1].end)).toBe(true);
    expect(inspectAv1Telemetry(output)).toEqual(expect.objectContaining({ accepted: true, firstMdatUnreferenced: true, allTrackOffsetsInRealMdats: true }));
  });

  test('handles multiple real mdats without changing either media payload', () => {
    const originals = [Buffer.from([0x12, 0x61]), Buffer.from([0x32, 0x62])];
    const single = av1Mp4({ samples: originals, chunks: [1, 1] });
    const source = splitAtSampleIntoMdats(single, 1);
    const sourceTree = parseMp4(source);
    const sourcePayloads = findBoxes(sourceTree, 'mdat').map((mdat) => Buffer.from(source.subarray(Number(mdat.contentStart), Number(mdat.end))));

    const output = injectAv1Telemetry(source, mapped([[], [teslaSeiNal([0x62])]]));
    const tree = parseMp4(output);
    const mdats = tree.children.filter((child) => child.type === 'mdat');
    const videoSamples = buildSampleIndex(selectVideoTrack(tree));

    expect(mdats).toHaveLength(3);
    expect(mdats.slice(1).map((mdat) => Buffer.from(output.subarray(Number(mdat.contentStart), Number(mdat.end))))).toEqual(sourcePayloads);
    expect(videoSamples.map((sample) => mdats.findIndex((mdat) => sample.offset >= mdat.contentStart && sample.offset + BigInt(sample.size) <= mdat.end))).toEqual([1, 2]);
    expect(inspectAv1Telemetry(output).samples.map(({ seiCount }) => seiCount)).toEqual([0, 1]);
  });

  test('inserts telemetry before media when moov follows the real mdat', () => {
    const originals = [Buffer.from([0x12, 0x71]), Buffer.from([0x32, 0x72])];
    const source = av1Mp4({ samples: originals, chunks: [1, 1], moovAfterMdat: true });
    const output = injectAv1Telemetry(source, mapped([[teslaSeiNal([0x71])], []]));
    const tree = parseMp4(output);

    expect(tree.children.map(({ type }) => type)).toEqual(['mdat', 'mdat', 'moov']);
    expect(sampleBytes(output)).toEqual(originals);
    expect(inspectAv1Telemetry(output)).toEqual(expect.objectContaining({ accepted: true, firstMdatUnreferenced: true, allTrackOffsetsInRealMdats: true }));
  });

  test('reuses MP4 fixed-point stco promotion planning for a physically unreachable telemetry shift', () => {
    const source = av1Mp4({
      samples: [Buffer.from([0x12, 0x81]), Buffer.from([0x32, 0x82])],
      chunks: [1, 1],
      audioSamples: [Buffer.from([0xa1]), Buffer.from([0xa2])]
    });
    const tree = parseMp4(source);
    const tracks = findBoxes(tree, 'trak');
    const originalOffsets = tracks.map((track) => readChunkOffsets(tree, Number(source.readUInt32BE(Number(findBoxes(track, 'tkhd')[0].contentStart) + 12))));
    const largest = originalOffsets.flat().reduce((maximum, value) => value > maximum ? value : maximum, 0n);
    const delta = 0xffffffffn - largest + 1n;

    const planned = rewriteChunkOffsets(source, tree, delta);
    const plannedTree = parseMp4(planned);

    expect(findBoxes(plannedTree, 'co64')).toHaveLength(2);
    expect(findBoxes(plannedTree, 'stco')).toHaveLength(0);
    const structuralGrowth = 12n;
    expect(tracks.map((track, index) => readChunkOffsets(plannedTree, Number(source.readUInt32BE(Number(findBoxes(track, 'tkhd')[0].contentStart) + 12)))))
      .toEqual(originalOffsets.map((offsets) => offsets.map((offset) => offset + delta + structuralGrowth)));
    const plannedMdat = findBoxes(plannedTree, 'mdat')[0];
    const sourceMdat = findBoxes(tree, 'mdat')[0];
    expect(planned.subarray(Number(plannedMdat.contentStart), Number(plannedMdat.end))).toEqual(source.subarray(Number(sourceMdat.contentStart), Number(sourceMdat.end)));
  });

  test('inspector rejects malformed lengths, malformed SEIs, missing markers, and extra markers from bytes alone', () => {
    const source = av1Mp4({ samples: [Buffer.from([0x12, 0x91]), Buffer.from([0x32, 0x92])] });
    const output = injectAv1Telemetry(source, mapped([[teslaSeiNal([0x21])], []]));
    const tree = parseMp4(output);
    const telemetry = tree.children.find((child) => child.type === 'mdat');

    const malformedLength = Buffer.from(output);
    malformedLength.writeUInt32BE(Number(telemetry.size), Number(telemetry.contentStart));
    expect(inspectAv1Telemetry(malformedLength)).toEqual(expect.objectContaining({ accepted: false, layoutValid: false }));

    const malformedSei = Buffer.from(output);
    malformedSei[Number(telemetry.contentStart) + 4] = 0x07;
    const invalidRecord = inspectAv1Telemetry(malformedSei);
    expect(invalidRecord).toEqual(expect.objectContaining({ accepted: false, layoutValid: false }));
    expect(invalidRecord.samples[0]).toEqual(expect.objectContaining({ layoutValid: false, recordTypes: ['invalid', 'marker'] }));

    const markerOffset = output.indexOf(PICTURE_MARKER, Number(telemetry.contentStart));
    const missingMarker = Buffer.from(output);
    missingMarker[markerOffset] = 0x62;
    const missing = inspectAv1Telemetry(missingMarker);
    expect(missing).toEqual(expect.objectContaining({ accepted: false, layoutValid: false }));
    expect(missing.samples.map(({ pictureMarkerCount }) => pictureMarkerCount)).toEqual([1, 0]);

    const extra = inspectAv1Telemetry(appendFirstMdatRecord(output, PICTURE_MARKER));
    expect(extra).toEqual(expect.objectContaining({ accepted: false, layoutValid: false }));
    expect(extra.validationErrors).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'telemetry.samples', message: expect.stringMatching(/marker count 3.*sample count 2/i) })]));
  });

  test('inspector rejects a real track offset into telemetry and corrupt non-video extents', () => {
    const source = av1Mp4({ samples: [Buffer.from([0x12, 0xa1])], audioSamples: [Buffer.from([0xb1, 0xb2])] });
    const output = injectAv1Telemetry(source, mapped([[]]));
    const tree = parseMp4(output);
    const firstMdat = tree.children.find((child) => child.type === 'mdat');
    const audioStco = findBoxes(tree, 'stco')[1];

    const referencesTelemetry = Buffer.from(output);
    referencesTelemetry.writeUInt32BE(Number(firstMdat.contentStart), Number(audioStco.contentStart) + 8);
    expect(inspectAv1Telemetry(referencesTelemetry)).toEqual(expect.objectContaining({
      accepted: false,
      firstMdatUnreferenced: false,
      allTrackOffsetsInRealMdats: false
    }));

    const unreadable = Buffer.from(output);
    unreadable.writeUInt32BE(output.length, Number(audioStco.contentStart) + 8);
    const inspected = inspectAv1Telemetry(unreadable);
    expect(inspected).toEqual(expect.objectContaining({
      accepted: false,
      layoutValid: false,
      firstMdatUnreferenced: false,
      allTrackOffsetsInRealMdats: false
    }));
    expect(inspected.validationErrors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'INVALID_MP4', path: 'tracks[1]' })]));
  });

  test('rejects invalid mapped Tesla SEIs and mismatched timelines', () => {
    const source = av1Mp4({ samples: [Buffer.from([0x12, 0xb1])] });
    const malformed = Buffer.from([0x06, 0x05, 0x05, 0x42, 0x69, 0x00, 0x00, 0x01, 0x80]);

    expect(() => injectAv1Telemetry(source, [])).toThrow(/mapped timeline.*sample count/i);
    expect(() => injectAv1Telemetry(source, mapped([[malformed]]))).toThrow(expect.objectContaining({ code: 'INVALID_AV1' }));
  });

  test('requires the sole av01 description and rejects unsupported container layouts', () => {
    const sample = Buffer.from([0x12, 0xc1]);
    const nonAv1 = av1Mp4({ samples: [sample], sampleEntry: 'avc1' });
    const wrongDescription = av1Mp4({ samples: [sample, sample], chunks: [1, 1], sampleDescriptionIndexes: [1, 2] });
    const source = av1Mp4({ samples: [sample] });
    const invalidAv1c = Buffer.from(source);
    invalidAv1c[invalidAv1c.indexOf(Buffer.from('av1C')) + 4] = 0x80;
    const tree = parseMp4(source);
    const trackNode = findBoxes(tree, 'trak')[0];
    const tkhd = findBoxes(tree, 'tkhd')[0];
    const mdat = findBoxes(tree, 'mdat')[0];
    const trackBytes = Buffer.from(source.subarray(Number(trackNode.start), Number(trackNode.end)));
    const secondTrack = Buffer.from(trackBytes);
    secondTrack.writeUInt32BE(8, Number(tkhd.contentStart - trackNode.start) + 12);
    const multiVideo = Buffer.concat([
      box('moov', Buffer.concat([trackBytes, secondTrack])),
      source.subarray(Number(mdat.start), Number(mdat.end))
    ]);
    const editList = Buffer.concat([
      box('moov', box('trak', Buffer.concat([
        source.subarray(Number(trackNode.contentStart), Number(trackNode.end)),
        box('edts')
      ]))),
      source.subarray(Number(mdat.start), Number(mdat.end))
    ]);

    expect(() => injectAv1Telemetry(invalidAv1c, mapped([[]]))).toThrow(expect.objectContaining({ code: 'INVALID_AV1' }));
    for (const unsupported of [nonAv1, wrongDescription, Buffer.concat([source, box('moof')]), editList, multiVideo]) {
      expect(() => injectAv1Telemetry(unsupported, mapped(unsupported === wrongDescription ? [[], []] : [[]]))).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CONTAINER' }));
    }
  });

  test('rejects an av01 stsd misplaced beneath a nested stbl instead of the active sample table', () => {
    const source = av1Mp4({ samples: [Buffer.from([0x12, 0xd1])] });
    const misplacedSource = misplaceActiveStsdInNestedStbl(source);
    expect(() => injectAv1Telemetry(misplacedSource, mapped([[]]))).toThrow(expect.objectContaining({
      code: 'UNSUPPORTED_CONTAINER',
      message: expect.stringMatching(/missing.*stsd|exactly one direct stsd/i)
    }));

    const validOutput = injectAv1Telemetry(source, mapped([[]]));
    const misplacedOutput = misplaceActiveStsdInNestedStbl(validOutput);
    expect(() => inspectAv1Telemetry(misplacedOutput)).not.toThrow();
    expect(inspectAv1Telemetry(misplacedOutput)).toEqual(expect.objectContaining({
      accepted: false,
      layoutValid: false,
      firstMdatUnreferenced: false,
      allTrackOffsetsInRealMdats: false,
      validationErrors: expect.arrayContaining([expect.objectContaining({
        code: 'UNSUPPORTED_CONTAINER',
        path: 'video.sampleDescription',
        message: expect.stringMatching(/missing.*stsd|exactly one direct stsd/i)
      })])
    }));
  });

  test.each([
    ['stco', (corrupt, tree) => {
      const stco = findBoxes(selectVideoTrack(tree), 'stco')[0];
      corrupt.writeUInt32BE(corrupt.length, Number(stco.contentStart) + 8);
    }],
    ['stsz', (corrupt, tree) => {
      const stsz = findBoxes(selectVideoTrack(tree), 'stsz')[0];
      corrupt.writeUInt32BE(corrupt.length, Number(stsz.contentStart) + 12);
    }]
  ])('returns a structured rejection for corrupt video %s extents', (_table, mutate) => {
    const source = av1Mp4({ samples: [Buffer.from([0x12, 0xe1])] });
    const output = injectAv1Telemetry(source, mapped([[]]));
    const corrupt = Buffer.from(output);
    mutate(corrupt, parseMp4(output));

    expect(() => inspectAv1Telemetry(corrupt)).not.toThrow();
    expect(inspectAv1Telemetry(corrupt)).toEqual(expect.objectContaining({
      accepted: false,
      layoutValid: false,
      firstMdatUnreferenced: false,
      allTrackOffsetsInRealMdats: false,
      samples: [],
      validationErrors: expect.arrayContaining([expect.objectContaining({
        code: 'INVALID_MP4',
        path: 'tracks[0]',
        message: expect.stringMatching(/sample extent is outside mdat/i)
      })])
    }));
  });

  test('returns a structured rejection when top-level MP4 parsing fails', () => {
    const source = av1Mp4({ samples: [Buffer.from([0x12, 0xf1])] });
    const output = injectAv1Telemetry(source, mapped([[]]));
    const truncated = output.subarray(0, output.length - 1);

    expect(() => inspectAv1Telemetry(truncated)).not.toThrow();
    expect(inspectAv1Telemetry(truncated)).toEqual(expect.objectContaining({
      accepted: false,
      layoutValid: false,
      firstMdatUnreferenced: false,
      allTrackOffsetsInRealMdats: false,
      samples: [],
      validationErrors: [expect.objectContaining({
        code: 'INVALID_MP4',
        path: 'mp4',
        message: expect.stringMatching(/box exceeds/i)
      })]
    }));
  });
});
