'use strict';

const crypto = require('crypto');
const {
  lengthPrefixedSample,
  teslaSeiNal,
  hevcNal,
  h265Mp4,
  box
} = require('./fixtureBuilders');
const {
  parseMp4,
  findBoxes,
  selectVideoTrack,
  buildSampleIndex,
  readChunkOffsets
} = require('../../../src/main/converter/mp4');
const {
  injectH265Telemetry,
  inspectH265Telemetry,
  planChunkOffsetTables
} = require('../../../src/main/converter/h265Telemetry');

function sampleNals(mp4Buffer, lengthSize) {
  const tree = parseMp4(mp4Buffer);
  const samples = buildSampleIndex(selectVideoTrack(tree));
  return samples.map((sample) => {
    const bytes = mp4Buffer.subarray(Number(sample.offset), Number(sample.offset) + sample.size);
    const nals = [];
    let cursor = 0;
    while (cursor < bytes.length) {
      const size = bytes.readUIntBE(cursor, lengthSize);
      cursor += lengthSize;
      nals.push(Buffer.from(bytes.subarray(cursor, cursor + size)));
      cursor += size;
    }
    return nals;
  });
}

function fingerprint(bytes) {
  return crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

function mapped(seiNalsBySample) {
  return seiNalsBySample.map((nals, index) => ({
    ptsUs: index * 33_333,
    pictureMarker: true,
    seiNals: nals.map((nal) => ({ nal, fingerprint: 'input metadata is not trusted' }))
  }));
}

function teslaSeiMissingEmulationPrevention(follower) {
  return Buffer.from([
    0x06, 0x05, 0x05,
    0x42, 0x69, 0x00, 0x00, follower,
    0x80
  ]);
}

function uuidScopedHevcPrefix(teslaNal) {
  const payload = Buffer.concat([Buffer.from('Sentry-Six-Tesla', 'ascii'), teslaNal]);
  const rbsp = Buffer.concat([Buffer.from([0x05, payload.length]), payload, Buffer.from([0x80])]);
  const escaped = [];
  let zeros = 0;
  for (const byte of rbsp) {
    if (zeros >= 2 && byte <= 0x03) {
      escaped.push(0x03);
      zeros = 0;
    }
    escaped.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Buffer.concat([Buffer.from([0x4e, 0x01]), Buffer.from(escaped)]);
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

function stszEntries(tree) {
  const stsz = findBoxes(selectVideoTrack(tree), 'stsz')[0];
  const count = tree.buffer.readUInt32BE(Number(stsz.contentStart) + 8);
  return Array.from({ length: count }, (_, index) => tree.buffer.readUInt32BE(Number(stsz.contentStart) + 12 + index * 4));
}

describe('H.265 Tesla telemetry writer', () => {
  test('wraps the original Tesla record in standards-valid UUID user data and unwraps its fingerprint', () => {
    const original = lengthPrefixedSample([hevcNal(1, [0x21, 0xaa])], 2);
    const tesla = teslaSeiNal([0x11]);
    const source = h265Mp4({ samples: [original], lengthSize: 2 });

    const output = injectH265Telemetry(source, mapped([[tesla]]));
    const firstNal = sampleNals(output, 2)[0][0];
    const privateUuid = Buffer.from('Sentry-Six-Tesla', 'ascii');

    expect(privateUuid).toHaveLength(16);
    expect(firstNal).toEqual(Buffer.concat([
      Buffer.from([0x4e, 0x01, 0x05, privateUuid.length + tesla.length]),
      privateUuid,
      tesla,
      Buffer.from([0x80])
    ]));
    expect(inspectH265Telemetry(output).samples[0].telemetryFingerprints).toEqual([fingerprint([0x11])]);
  });

  test('writes exact prefix/shim records and a marker per sample without changing original HEVC NALs', () => {
    const originals = [0x10, 0x20, 0x30, 0x40].map((value) => lengthPrefixedSample([hevcNal(1, [value, 0xaa])], 2));
    originals[1] = lengthPrefixedSample([hevcNal(32, [0x99]), hevcNal(1, [0x20, 0xaa])], 2);
    const first = teslaSeiNal([0x11]);
    const second = teslaSeiNal([0x00, 0x00, 0x03, 0x01]);
    const third = teslaSeiNal([0x33]);
    const source = h265Mp4({ samples: originals, lengthSize: 2, chunks: [2, 2], chunkPadding: 3 });
    const timeline = mapped([[], [first, second], [], [third]]);

    const output = injectH265Telemetry(source, timeline);
    const inspected = inspectH265Telemetry(output);

    expect(inspected).toEqual(expect.objectContaining({ accepted: true, layoutValid: true, validationErrors: [] }));
    expect(inspected.sampleEntry).toBe('hvc1');
    expect(inspected.lengthSize).toBe(2);
    expect(inspected.samples.map(({ hasPictureMarker }) => hasPictureMarker)).toEqual([true, true, true, true]);
    expect(inspected.samples.map(({ pictureMarkerCount }) => pictureMarkerCount)).toEqual([1, 1, 1, 1]);
    expect(inspected.samples.map(({ seiCount }) => seiCount)).toEqual([0, 2, 0, 1]);
    expect(inspected.samples.map(({ compatibilityCount }) => compatibilityCount)).toEqual([0, 2, 0, 1]);
    expect(inspected.samples.map(({ telemetryFingerprints }) => telemetryFingerprints)).toEqual([
      [], [fingerprint([0x11]), fingerprint([0x00, 0x00, 0x01])], [], [fingerprint([0x33])]
    ]);
    expect(inspected.samples.map(({ compatibilityFingerprints }) => compatibilityFingerprints)).toEqual([
      [], [fingerprint([0x11]), fingerprint([0x00, 0x00, 0x01])], [], [fingerprint([0x33])]
    ]);
    expect(inspected.samples.map(({ layoutValid }) => layoutValid)).toEqual([true, true, true, true]);
    expect(inspected.telemetryFingerprints).toEqual([fingerprint([0x11]), fingerprint([0x00, 0x00, 0x01]), fingerprint([0x33])]);
    expect(inspected.samples.map(({ nalTypes }) => nalTypes)).toEqual([
      [48, 1],
      [39, 39, 51, 51, 48, 32, 1],
      [48, 1],
      [39, 51, 48, 1]
    ]);

    const outputNals = sampleNals(output, 2);
    const originalNals = sampleNals(source, 2);
    expect(outputNals[0][0]).toEqual(Buffer.from([0x61, 0x01, 0x80]));
    expect(outputNals[1].slice(2, 5)).toEqual([
      Buffer.concat([Buffer.from([0x66, 0x01]), first.subarray(2)]),
      Buffer.concat([Buffer.from([0x66, 0x01]), second.subarray(2)]),
      Buffer.from([0x61, 0x01, 0x80])
    ]);
    timeline.forEach(({ seiNals }, index) => {
      expect(outputNals[index].slice(seiNals.length * 2 + 1)).toEqual(originalNals[index]);
    });

    const outputTree = parseMp4(output);
    const outputTrack = selectVideoTrack(outputTree);
    const outputSamples = buildSampleIndex(outputTrack);
    expect(outputSamples.map(({ size }) => size)).toEqual(outputNals.map((nals) => (
      nals.reduce((sum, nal) => sum + 2 + nal.length, 0)
    )));
    expect(outputSamples[1].offset).toBe(outputSamples[0].offset + BigInt(outputSamples[0].size));
    expect(outputSamples[3].offset).toBe(outputSamples[2].offset + BigInt(outputSamples[2].size));
    expect(readChunkOffsets(outputTree, outputTrack.id)).toEqual([outputSamples[0].offset, outputSamples[2].offset]);
  });

  test('preserves extended boxes and co64 while rebuilding multi-sample chunks', () => {
    const originals = [0x51, 0x52, 0x53].map((value) => lengthPrefixedSample([hevcNal(19, [value])], 4));
    const telemetry = teslaSeiNal([0x44]);
    const source = h265Mp4({
      samples: originals,
      lengthSize: 4,
      chunks: [2, 1],
      co64: true,
      extendedMoov: true,
      extendedMdat: true,
      extendedHvcc: true,
      chunkPadding: 7
    });

    const output = injectH265Telemetry(source, mapped([[telemetry], [], [telemetry]]));
    const tree = parseMp4(output);
    const track = selectVideoTrack(tree);
    const samples = buildSampleIndex(track);
    const inspected = inspectH265Telemetry(output);

    expect(findBoxes(tree, 'moov')[0].headerSize).toBe(16n);
    expect(findBoxes(tree, 'mdat')[0].headerSize).toBe(16n);
    expect(findBoxes(tree, 'co64')).toHaveLength(1);
    expect(findBoxes(tree, 'stco')).toHaveLength(0);
    expect(findBoxes(tree, 'mdat')[0].size - findBoxes(parseMp4(source), 'mdat')[0].size).toBe(BigInt(output.length - source.length));
    expect(readChunkOffsets(tree, track.id)).toEqual([samples[0].offset, samples[2].offset]);
    expect(inspected.samples.map(({ seiCount, hasPictureMarker }) => [seiCount, hasPictureMarker])).toEqual([[1, true], [0, true], [1, true]]);

    const outputNals = sampleNals(output, 4);
    const originalNals = sampleNals(source, 4);
    [1, 0, 1].forEach((seiCount, index) => {
      expect(outputNals[index].slice(seiCount * 2 + 1)).toEqual(originalNals[index]);
    });
  });

  test.each([1, 3])('uses the %i-byte HEVC NAL length declared by hvcC', (lengthSize) => {
    const sample = lengthPrefixedSample([hevcNal(1, [0x77])], lengthSize);
    const source = h265Mp4({ samples: [sample], lengthSize });
    const output = injectH265Telemetry(source, mapped([[]]));
    expect(inspectH265Telemetry(output)).toEqual(expect.objectContaining({ sampleEntry: 'hvc1', lengthSize }));
    expect(sampleNals(output, lengthSize)[0].slice(1)).toEqual(sampleNals(source, lengthSize)[0]);
  });

  test('rewrites a later non-video track offset after growing video access units', () => {
    const videoSamples = [0x81, 0x82].map((value) => lengthPrefixedSample([hevcNal(1, [value])]));
    const audioSamples = [Buffer.from([0xa1, 0xa2]), Buffer.from([0xb1, 0xb2, 0xb3])];
    const source = h265Mp4({ samples: videoSamples, chunks: [2], audioSamples });
    const output = injectH265Telemetry(source, mapped([[teslaSeiNal([0x55])], []]));
    const sourceAudioOffset = readChunkOffsets(parseMp4(source), 8)[0];
    const outputTree = parseMp4(output);
    const outputAudioOffset = readChunkOffsets(outputTree, 8)[0];

    expect(outputAudioOffset).toBe(sourceAudioOffset + BigInt(output.length - source.length));
    expect(output.subarray(Number(outputAudioOffset), Number(outputAudioOffset) + 5)).toEqual(Buffer.concat(audioSamples));
    const audioIndex = findBoxes(outputTree, 'trak').map((track) => buildSampleIndex(track))
      .find((samples) => samples[0].offset === outputAudioOffset);
    expect(audioIndex).toHaveLength(2);
  });

  test('inspector rejects unreadable and globally overlapping non-video sample extents', () => {
    const videoSample = lengthPrefixedSample([hevcNal(1, [0x89])]);
    const source = h265Mp4({ samples: [videoSample], audioSamples: [Buffer.from([0xa1, 0xa2])] });
    const output = injectH265Telemetry(source, mapped([[]]));
    const tree = parseMp4(output);
    const audioStco = findBoxes(tree, 'stco')[1];
    const videoOffset = buildSampleIndex(selectVideoTrack(tree))[0].offset;
    expect(inspectH265Telemetry(output)).toEqual(expect.objectContaining({ accepted: true, layoutValid: true, validationErrors: [] }));

    for (const offset of [8n, videoOffset]) {
      const corrupt = Buffer.from(output);
      corrupt.writeUInt32BE(Number(offset), Number(audioStco.contentStart) + 8);
      const inspected = inspectH265Telemetry(corrupt);
      expect(inspected).toEqual(expect.objectContaining({ accepted: false, layoutValid: false }));
      expect(inspected.validationErrors[0]).toEqual(expect.objectContaining({ code: 'INVALID_MP4', path: expect.stringMatching(/^tracks\[1\]|^tracks$/) }));
    }
  });

  test('rejects cross-track sample extents that overlap before rewriting offsets', () => {
    const videoSample = lengthPrefixedSample([hevcNal(1, [0x91])]);
    const source = h265Mp4({ samples: [videoSample], audioSamples: [Buffer.from([0xa1, 0xa2])] });
    const sourceTree = parseMp4(source);
    const videoOffset = buildSampleIndex(selectVideoTrack(sourceTree))[0].offset;
    const overlapping = Buffer.from(source);
    const audioStco = findBoxes(sourceTree, 'stco')[1];
    overlapping.writeUInt32BE(Number(videoOffset), Number(audioStco.contentStart) + 8);

    expect(() => injectH265Telemetry(overlapping, mapped([[]]))).toThrow(expect.objectContaining({
      code: 'INVALID_MP4',
      path: 'tracks',
      message: expect.stringMatching(/sample extents overlap/i)
    }));
  });

  test('inspector derives markers and valid extents from written bytes', () => {
    const source = h265Mp4({ samples: [lengthPrefixedSample([hevcNal(1, [0x92])])] });
    const output = injectH265Telemetry(source, mapped([[]]));
    const outputTree = parseMp4(output);
    const sample = buildSampleIndex(selectVideoTrack(outputTree))[0];

    const withoutExactMarker = Buffer.from(output);
    withoutExactMarker[Number(sample.offset) + 4] = 0x60;
    const inspectedWithoutMarker = inspectH265Telemetry(withoutExactMarker);
    expect(inspectedWithoutMarker).toEqual(expect.objectContaining({ accepted: false, layoutValid: false }));
    expect(inspectedWithoutMarker.samples[0]).toEqual(expect.objectContaining({ hasPictureMarker: false, layoutValid: false }));

    const invalidExtent = Buffer.from(output);
    const stsz = findBoxes(outputTree, 'stsz')[0];
    invalidExtent.writeUInt32BE(output.length, Number(stsz.contentStart) + 12);
    expect(() => inspectH265Telemetry(invalidExtent)).toThrow(/sample extent is outside mdat/i);
  });

  test.each([
    ['picture marker', Buffer.from([0x61, 0x01, 0x80])],
    ['Tesla prefix SEI', (() => {
      const tesla = teslaSeiNal([0x31]);
      return Buffer.concat([
        Buffer.from([0x4e, 0x01, 0x05, 16 + tesla.length]),
        Buffer.from('Sentry-Six-Tesla', 'ascii'), tesla, Buffer.from([0x80])
      ]);
    })()],
    ['Tesla compatibility shim', Buffer.concat([Buffer.from([0x66, 0x01]), teslaSeiNal([0x32]).subarray(2)])]
  ])('rejects a pre-existing %s instead of duplicating injected records', (_name, record) => {
    const source = h265Mp4({ samples: [lengthPrefixedSample([record, hevcNal(1, [0x90])])] });
    expect(() => injectH265Telemetry(source, mapped([[]]))).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_H265' }));
  });

  test('rejects truncated, extra-byte, multi-message, and invalid-EBSP mapped Tesla SEI records', () => {
    const canonical = teslaSeiNal([0x41]);
    const malformed = [
      canonical.subarray(0, canonical.length - 1),
      Buffer.concat([canonical, Buffer.from([0x00])]),
      Buffer.concat([canonical.subarray(0, canonical.length - 1), canonical.subarray(1)]),
      Buffer.from([0x06, 0x05, 0x05, 0x42, 0x69, 0x00, 0x00, 0x03, 0x04, 0x80]),
      Buffer.from([0x06, 0x05, 0x10, 0x42, 0x69, 0x80])
    ];
    const source = h265Mp4({ samples: [lengthPrefixedSample([hevcNal(1, [0x94])])] });
    for (const nal of malformed) {
      expect(() => injectH265Telemetry(source, mapped([[nal]]))).toThrow(expect.objectContaining({ code: 'INVALID_H265' }));
    }
  });

  test.each([
    ['00', 0x00],
    ['01', 0x01],
    ['02', 0x02]
  ])('rejects a mapped Tesla SEI missing emulation prevention before 0x%s', (_hex, follower) => {
    const malformed = teslaSeiMissingEmulationPrevention(follower);
    const source = h265Mp4({ samples: [lengthPrefixedSample([hevcNal(1, [0x98])])] });

    expect(() => injectH265Telemetry(source, mapped([[malformed]]))).toThrow(expect.objectContaining({ code: 'INVALID_H265' }));
  });

  test.each([
    ['00', 0x00],
    ['01', 0x01],
    ['02', 0x02]
  ])('inspector rejects Tesla records missing emulation prevention before 0x%s', (_hex, follower) => {
    const malformed = teslaSeiMissingEmulationPrevention(follower);
    const prefix = uuidScopedHevcPrefix(malformed);
    const compatibility = Buffer.concat([Buffer.from([0x66, 0x01]), malformed.subarray(2)]);
    const source = h265Mp4({
      samples: [lengthPrefixedSample([prefix, compatibility, Buffer.from([0x61, 0x01, 0x80]), hevcNal(1, [0x99])])]
    });

    expect(inspectH265Telemetry(source)).toEqual(expect.objectContaining({ accepted: false, layoutValid: false }));
  });

  test.each([
    ['00', 0x00],
    ['01', 0x01],
    ['02', 0x02],
    ['03', 0x03]
  ])('accepts canonical emulation prevention before 0x%s', (_hex, follower) => {
    const canonical = teslaSeiNal([0x00, 0x00, 0x03, follower]);
    const source = h265Mp4({ samples: [lengthPrefixedSample([hevcNal(1, [0x99])])] });
    const output = injectH265Telemetry(source, mapped([[canonical]]));
    const nals = sampleNals(output, 4)[0];

    expect((nals[0][0] >> 1) & 0x3f).toBe(39);
    expect(nals[0].subarray(4, 20)).toEqual(Buffer.from('Sentry-Six-Tesla', 'ascii'));
    expect(nals[1]).toEqual(Buffer.concat([Buffer.from([0x66, 0x01]), canonical.subarray(2)]));
    expect(inspectH265Telemetry(output)).toEqual(expect.objectContaining({ accepted: true, layoutValid: true }));
  });

  test('requires every sample to reference the sole hvc1 sample description', () => {
    const samples = [0x95, 0x96].map((value) => lengthPrefixedSample([hevcNal(1, [value])]));
    const source = h265Mp4({ samples, chunks: [1, 1], sampleDescriptionIndexes: [1, 2] });
    expect(() => injectH265Telemetry(source, mapped([[], []]))).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CONTAINER' }));
    expect(() => inspectH265Telemetry(source)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CONTAINER' }));
  });

  test('plans stco promotion through the structural-growth fixed point with synthetic offsets', () => {
    const maximum = 0xffffffffn;
    const plan = planChunkOffsetTables([
      { type: 'stco', start: 10n, offsets: [maximum - 4n, maximum - 3n] },
      { type: 'stco', start: 20n, offsets: [maximum - 2n, maximum - 1n] }
    ], (offset, tableIndex) => offset + (tableIndex === 1 ? 2n : 0n));

    expect(plan.structuralGrowth).toBe(16n);
    expect(plan.tables.map(({ type, promoted }) => [type, promoted])).toEqual([['co64', true], ['co64', true]]);
    expect(plan.tables.map(({ offsets }) => offsets)).toEqual([
      [maximum + 12n, maximum + 13n],
      [maximum + 16n, maximum + 17n]
    ]);
  });

  test('rebuilds stsz and both mdats while preserving valid samples across media boxes', () => {
    const originals = [0xa1, 0xa2].map((value) => lengthPrefixedSample([hevcNal(1, [value])]));
    const telemetry = teslaSeiNal([0x51]);
    const singleMdat = h265Mp4({ samples: originals, chunks: [1, 1] });
    const source = splitAtSampleIntoMdats(singleMdat, 1);
    const sourceTree = parseMp4(source);
    const output = injectH265Telemetry(source, mapped([[telemetry], []]));
    const outputTree = parseMp4(output);
    const sourceMdats = findBoxes(sourceTree, 'mdat');
    const outputMdats = findBoxes(outputTree, 'mdat');
    const outputSamples = buildSampleIndex(selectVideoTrack(outputTree));

    expect(sourceMdats).toHaveLength(2);
    expect(outputMdats).toHaveLength(2);
    expect(outputSamples.map((sample) => outputMdats.findIndex((mdat) => sample.offset >= mdat.contentStart && sample.offset + BigInt(sample.size) <= mdat.end))).toEqual([0, 1]);
    expect(outputMdats.map((mdat, index) => mdat.size - sourceMdats[index].size)).toEqual([
      BigInt(outputSamples[0].size - originals[0].length),
      BigInt(outputSamples[1].size - originals[1].length)
    ]);
    expect(stszEntries(outputTree)).toEqual(outputSamples.map(({ size }) => size));
    for (const type of ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsz']) {
      expect(findBoxes(outputTree, type)[0].size).toBe(findBoxes(sourceTree, type)[0].size);
    }
    expect(sampleNals(output, 4).map((nals, index) => nals.slice(index === 0 ? 3 : 1))).toEqual(sampleNals(source, 4));
  });

  test('rejects a truncated hvcC NAL array', () => {
    const sample = lengthPrefixedSample([hevcNal(1, [0x97])]);
    const malformed = Buffer.from(h265Mp4({ samples: [sample] }));
    const typeOffset = malformed.indexOf(Buffer.from('hvcC'));
    malformed[typeOffset + 4 + 22] = 1;
    expect(() => injectH265Telemetry(malformed, mapped([[]]))).toThrow(expect.objectContaining({ code: 'INVALID_H265' }));
    expect(() => inspectH265Telemetry(malformed)).toThrow(expect.objectContaining({ code: 'INVALID_H265' }));
  });

  test('rejects non-hvc1, malformed HEVC samples, and mismatched mapped timelines', () => {
    const sample = lengthPrefixedSample([hevcNal(1, [0x88])]);
    const hev1 = h265Mp4({ samples: [sample], sampleEntry: 'hev1' });
    const malformed = h265Mp4({ samples: [Buffer.from([0, 0, 0, 9, 0x02, 0x01])] });
    const valid = h265Mp4({ samples: [sample] });

    expect(() => injectH265Telemetry(hev1, mapped([[]]))).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CONTAINER' }));
    expect(() => inspectH265Telemetry(hev1)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CONTAINER' }));
    expect(() => injectH265Telemetry(malformed, mapped([[]]))).toThrow(/NAL length exceeds sample/i);
    expect(() => injectH265Telemetry(valid, [])).toThrow(/mapped timeline.*sample count/i);
  });

  test('inherits fail-closed fragmented, edit-list, and multiple-video rejection', () => {
    const sample = lengthPrefixedSample([hevcNal(1, [0x93])]);
    const source = h265Mp4({ samples: [sample] });
    const tree = parseMp4(source);
    const track = findBoxes(tree, 'trak')[0];
    const tkhd = findBoxes(tree, 'tkhd')[0];
    const mdat = findBoxes(tree, 'mdat')[0];
    const trackBytes = Buffer.from(source.subarray(Number(track.start), Number(track.end)));
    const secondTrack = Buffer.from(trackBytes);
    secondTrack.writeUInt32BE(8, Number(tkhd.contentStart - track.start) + 12);
    const multiVideo = Buffer.concat([
      box('moov', Buffer.concat([trackBytes, secondTrack])),
      source.subarray(Number(mdat.start), Number(mdat.end))
    ]);
    const editList = Buffer.concat([
      box('moov', box('trak', Buffer.concat([
        source.subarray(Number(track.contentStart), Number(track.end)),
        box('edts')
      ]))),
      source.subarray(Number(mdat.start), Number(mdat.end))
    ]);

    for (const unsupported of [Buffer.concat([source, box('moof')]), editList, multiVideo]) {
      expect(() => injectH265Telemetry(unsupported, mapped([[]]))).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CONTAINER' }));
    }
  });
});
