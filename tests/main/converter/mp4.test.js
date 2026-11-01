'use strict';

const { u32, i32, u64, box, extendedBox, fullBox, stco, co64, track, videoMp4 } = require('./fixtureBuilders');
const { parseMp4, findBoxes, selectVideoTrack, buildSampleIndex, readChunkOffsets, rewriteChunkOffsets, serializedBoxHeaderSize, makeBox, makeFullBox } = require('../../../src/main/converter/mp4');

function basicSampleTables(offsets, options = {}) {
  const versions = options.versions || {};
  const offsetBox = options.co64
    ? fullBox('co64', versions.co64 || 0, 0, Buffer.concat([u32(offsets.length), ...offsets.map(u64)]))
    : fullBox('stco', versions.stco || 0, 0, Buffer.concat([u32(offsets.length), ...offsets.map((offset) => u32(Number(offset)))]));
  const stsz = fullBox('stsz', versions.stsz || 0, 0, Buffer.concat([u32(0), u32(2), u32(4), u32(4)]));
  const stsc = fullBox('stsc', versions.stsc || 0, 0, Buffer.concat([u32(1), u32(options.firstChunk || 1), u32(1), u32(options.descriptionIndex === undefined ? 1 : options.descriptionIndex)]));
  const stts = fullBox('stts', versions.stts || 0, 0, Buffer.concat([u32(1), u32(2), u32(1000)]));
  const ctts = fullBox('ctts', versions.ctts || 0, 0, Buffer.concat([u32(1), u32(2), i32(options.compositionOffset || 0)]));
  return [offsetBox, stsz, stsc, stts, ctts];
}

function indexedVideo(options = {}) {
  const media = options.media || Buffer.from('ABCDEFGH');
  const assemble = (tables) => options.extendedMoov
    ? Buffer.concat([extendedBox('moov', track(tables, options.trackId || 7, options.handler || 'vide')), box('mdat', media)])
    : videoMp4(tables, options.trackId || 7, media);
  const provisional = assemble(basicSampleTables([0, 0], options));
  const mediaStart = BigInt(provisional.length - media.length);
  const offsets = options.offsets || [mediaStart, mediaStart + 4n];
  return { source: assemble(basicSampleTables(offsets, options)), media, mediaStart, offsets };
}

function indexedVideoWithSimpleEditList(options = {}) {
  const media = options.media || Buffer.from('ABCDEFGH');
  const sampleTables = basicSampleTables([0, 0], options);
  const provisionalMdia = box('mdia', Buffer.concat([
    fullBox('hdlr', 0, 0, Buffer.concat([u32(0), Buffer.from('vide')])),
    box('minf', box('stbl', Buffer.concat(sampleTables)))
  ]));
  const edit = fullBox('elst', 0, 0, Buffer.concat([u32(1), u32(2000), i32(0), Buffer.from([0, 1, 0, 0])]));
  const assemble = (offsets) => Buffer.concat([
    box('moov', box('trak', Buffer.concat([
      fullBox('tkhd', 0, 0, Buffer.concat([u32(0), u32(0), u32(options.trackId || 7)])),
      box('edts', edit),
      box('mdia', Buffer.concat([
        fullBox('hdlr', 0, 0, Buffer.concat([u32(0), Buffer.from('vide')])),
        box('minf', box('stbl', Buffer.concat([
          ...basicSampleTables(offsets, options)
        ])))
      ]))
    ]))),
    box('mdat', media)
  ]);
  const provisional = assemble([0, 0]);
  const mediaStart = BigInt(provisional.length - media.length);
  return assemble([mediaStart, mediaStart + 4n]);
}

function multiTrackVideo(trackIds) {
  const media = Buffer.from('ABCDEFGH');
  const assemble = (offsets) => Buffer.concat([
    box('moov', Buffer.concat(trackIds.map((id) => track(basicSampleTables(offsets), id)))),
    box('mdat', media)
  ]);
  const provisional = assemble([0n, 4n]);
  const mediaStart = BigInt(provisional.length - media.length);
  return assemble([mediaStart, mediaStart + 4n]);
}

describe('MP4 box primitives', () => {
  test('parses ordinary and extended-size boxes without losing byte offsets', () => {
    const source = Buffer.concat([box('free', Buffer.from([1, 2])), extendedBox('skip', Buffer.from([3, 4, 5]))]);
    const tree = parseMp4(source);

    expect(tree.children.map((child) => ({ type: child.type, start: child.start, size: child.size, headerSize: child.headerSize }))).toEqual([
      { type: 'free', start: 0n, size: 10n, headerSize: 8n },
      { type: 'skip', start: 10n, size: 19n, headerSize: 16n }
    ]);
    expect(findBoxes(tree, 'skip')).toHaveLength(1);
    expect(makeBox('free', Buffer.from([1, 2]))).toEqual(box('free', Buffer.from([1, 2])));
    expect(makeFullBox('test', 1, 0x010203, Buffer.from([4]))).toEqual(Buffer.from([0, 0, 0, 13, 0x74, 0x65, 0x73, 0x74, 1, 1, 2, 3, 4]));
  });

  test('selects the video trak from nested moov media boxes', () => {
    const tkhd = fullBox('tkhd', 0, 0, Buffer.concat([u32(0), u32(0), u32(7)]));
    const hdlr = fullBox('hdlr', 0, 0, Buffer.concat([u32(0), Buffer.from('vide')]));
    const stbl = box('stbl');
    const source = box('moov', box('trak', Buffer.concat([tkhd, box('mdia', Buffer.concat([hdlr, box('minf', stbl)]))])));

    const track = selectVideoTrack(parseMp4(source));

    expect(track.type).toBe('trak');
    expect(track.id).toBe(7);
    expect(track.children[1].type).toBe('mdia');
  });

  test('builds timestamp-aware samples from stco, stsz, stsc, stts, and signed ctts tables', () => {
    const stsz = fullBox('stsz', 0, 0, Buffer.concat([u32(0), u32(3), u32(10), u32(12), u32(14)]));
    const stsc = fullBox('stsc', 0, 0, Buffer.concat([u32(2), u32(1), u32(1), u32(1), u32(2), u32(2), u32(2)]));
    const stts = fullBox('stts', 0, 0, Buffer.concat([u32(1), u32(3), u32(1000)]));
    const ctts = fullBox('ctts', 1, 0, Buffer.concat([u32(3), u32(1), i32(-10), u32(1), i32(0), u32(1), i32(20)]));
    const media = Buffer.alloc(36, 0xa5);
    const provisional = videoMp4([stco([0, 0]), stsz, stsc, stts, ctts], 7, media);
    const mediaStart = BigInt(provisional.length - media.length);
    const tree = parseMp4(videoMp4([stco([Number(mediaStart), Number(mediaStart + 10n)]), stsz, stsc, stts, ctts], 7, media));
    const track = selectVideoTrack(tree);

    expect(readChunkOffsets(tree, track.id)).toEqual([mediaStart, mediaStart + 10n]);
    expect(buildSampleIndex(track)).toEqual([
      { index: 0, sampleNumber: 1, sampleDescriptionIndex: 1, offset: mediaStart, size: 10, dts: 0n, pts: -10n, duration: 1000n },
      { index: 1, sampleNumber: 2, sampleDescriptionIndex: 2, offset: mediaStart + 10n, size: 12, dts: 1000n, pts: 1000n, duration: 1000n },
      { index: 2, sampleNumber: 3, sampleDescriptionIndex: 2, offset: mediaStart + 22n, size: 14, dts: 2000n, pts: 2020n, duration: 1000n }
    ]);
    expect(readChunkOffsets(parseMp4(videoMp4([co64([0x1_0000_0000n])])), 7)).toEqual([0x1_0000_0000n]);
  });

  test('rewrites validated chunk offsets and preserves actual mdat sample bytes', () => {
    const { source, media, offsets } = indexedVideo();
    const original = buildSampleIndex(selectVideoTrack(parseMp4(source)));
    const preserved = rewriteChunkOffsets(source, parseMp4(source), 0n);
    expect(preserved.subarray(preserved.length - media.length)).toEqual(media);
    expect(buildSampleIndex(selectVideoTrack(parseMp4(preserved)))).toEqual(original);

    const ordinary = source;
    const ordinaryTree = parseMp4(ordinary);
    const patched = rewriteChunkOffsets(ordinary, ordinaryTree, 48n);
    expect(readChunkOffsets(parseMp4(patched), 7)).toEqual(offsets.map((offset) => offset + 48n));
  });

  test('accepts a simple single-entry edit list with media time zero and preserves samples', () => {
    const source = indexedVideoWithSimpleEditList();
    const tree = parseMp4(source);
    expect(findBoxes(tree, 'elst')).toHaveLength(1);
    expect(buildSampleIndex(selectVideoTrack(tree))).toHaveLength(2);
  });

  test('fails closed on truncated, overlapping, size-zero, fragmented, and malformed edit-list layouts', () => {
    expect(() => parseMp4(Buffer.from([0, 0, 0, 8]))).toThrow(expect.objectContaining({ code: 'INVALID_MP4' }));
    expect(() => parseMp4(Buffer.concat([u32(0), Buffer.from('free')]))).toThrow(expect.objectContaining({ code: 'INVALID_MP4' }));
    expect(() => parseMp4(box('moov', Buffer.concat([u32(16), Buffer.from('free')])))).toThrow(expect.objectContaining({ code: 'INVALID_MP4' }));
    expect(() => parseMp4(box('moof'))).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CONTAINER' }));
    expect(() => parseMp4(box('moov', box('trak', box('edts'))))).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CONTAINER' }));
  });

  test('rejects a rewritten offset outside the unsigned 64-bit range', () => {
    const { source, offsets } = indexedVideo({ co64: true });
    const delta = 0xffffffffffffffffn - offsets[0] + 1n;
    let thrown;
    try {
      rewriteChunkOffsets(source, parseMp4(source), delta);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'INVALID_MP4', message: 'Rewritten chunk offset is outside the unsigned 64-bit range' });
  });

  test('requires every indexed sample extent to be disjoint and entirely inside mdat', () => {
    const valid = indexedVideo();
    expect(buildSampleIndex(selectVideoTrack(parseMp4(valid.source)))).toHaveLength(2);

    const metadata = indexedVideo({ offsets: [8n, valid.mediaStart + 4n] });
    const outside = indexedVideo({ offsets: [valid.mediaStart, BigInt(valid.source.length - 2)] });
    const overlap = indexedVideo({ offsets: [valid.mediaStart, valid.mediaStart + 2n] });
    for (const invalid of [metadata.source, outside.source, overlap.source]) {
      expect(() => buildSampleIndex(selectVideoTrack(parseMp4(invalid)))).toThrow(expect.objectContaining({ code: 'INVALID_MP4' }));
      expect(() => rewriteChunkOffsets(invalid, parseMp4(invalid), 0n)).toThrow(expect.objectContaining({ code: 'INVALID_MP4' }));
    }
  });

  test('indexes valid co64 samples and rejects multiple video tracks', () => {
    const co64Source = indexedVideo({ co64: true });
    const samples = buildSampleIndex(selectVideoTrack(parseMp4(co64Source.source)));
    expect(samples.map((sample) => sample.offset)).toEqual(co64Source.offsets);

    const first = indexedVideo();
    const second = indexedVideo({ trackId: 8 });
    const multiVideo = Buffer.concat([box('moov', Buffer.concat([
      track(basicSampleTables([first.mediaStart, first.mediaStart + 4n]), 7),
      track(basicSampleTables([first.mediaStart, first.mediaStart + 4n]), 8)
    ])), box('mdat', first.media)]);
    expect(() => selectVideoTrack(parseMp4(multiVideo))).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CONTAINER' }));
    expect(second.source).toBeInstanceOf(Buffer);
  });

  test('rejects duplicate required structures, unsupported full-box versions, and invalid stsc entries', () => {
    const valid = indexedVideo();
    const duplicateStco = videoMp4([...basicSampleTables(valid.offsets), stco(valid.offsets.map(Number))], 7, valid.media);
    const duplicateStsz = videoMp4([basicSampleTables(valid.offsets)[0], basicSampleTables(valid.offsets)[1], basicSampleTables(valid.offsets)[1], ...basicSampleTables(valid.offsets).slice(2)], 7, valid.media);
    expect(() => readChunkOffsets(parseMp4(duplicateStco), 7)).toThrow(expect.objectContaining({ code: 'INVALID_MP4' }));
    expect(() => rewriteChunkOffsets(duplicateStco, parseMp4(duplicateStco), 0n)).toThrow(expect.objectContaining({ code: 'INVALID_MP4' }));
    expect(() => buildSampleIndex(selectVideoTrack(parseMp4(duplicateStsz)))).toThrow(expect.objectContaining({ code: 'INVALID_MP4' }));

    const duplicateTrackIds = multiTrackVideo([7, 7]);
    expect(() => readChunkOffsets(parseMp4(duplicateTrackIds), 7)).toThrow(expect.objectContaining({ code: 'INVALID_MP4' }));
    expect(() => rewriteChunkOffsets(duplicateTrackIds, parseMp4(duplicateTrackIds), 0n)).toThrow(expect.objectContaining({ code: 'INVALID_MP4' }));

    for (const versions of [{ stco: 1 }, { stsz: 1 }, { stsc: 1 }, { stts: 1 }, { ctts: 2 }]) {
      const source = indexedVideo({ versions }).source;
      expect(() => buildSampleIndex(selectVideoTrack(parseMp4(source)))).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CONTAINER' }));
    }
    const badStsc = indexedVideo({ descriptionIndex: 0 }).source;
    const beyondChunks = indexedVideo({ firstChunk: 3 }).source;
    expect(() => buildSampleIndex(selectVideoTrack(parseMp4(badStsc)))).toThrow(expect.objectContaining({ code: 'INVALID_MP4' }));
    expect(() => buildSampleIndex(selectVideoTrack(parseMp4(beyondChunks)))).toThrow(expect.objectContaining({ code: 'INVALID_MP4' }));

    const tkhdV2 = box('moov', track(basicSampleTables(valid.offsets), 7));
    tkhdV2[24] = 2;
    expect(() => selectVideoTrack(parseMp4(tkhdV2))).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CONTAINER' }));
  });

  test('fails closed when an ordinary box would need an extended header and preserves existing extended headers', () => {
    expect(serializedBoxHeaderSize(0xfffffff7n, 8n)).toBe(8n);
    expect(() => serializedBoxHeaderSize(0xfffffff8n, 8n)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CONTAINER' }));
    expect(serializedBoxHeaderSize(0n, 16n)).toBe(16n);

    const extended = indexedVideo({ extendedMoov: true });
    const rebuilt = parseMp4(rewriteChunkOffsets(extended.source, parseMp4(extended.source), 0n));
    expect(findBoxes(rebuilt, 'moov')[0].headerSize).toBe(16n);
    expect(buildSampleIndex(selectVideoTrack(rebuilt)).map((sample) => sample.offset)).toEqual(extended.offsets);
  });

  test('promotes stco tables to co64 through the structural-shift fixed point', () => {
    const media = Buffer.from('abcdefghijklmnop');
    const assemble = (videoOffsets, audioOffsets) => Buffer.concat([
      box('moov', Buffer.concat([
        track(basicSampleTables(videoOffsets), 7, 'vide'),
        track(basicSampleTables(audioOffsets), 8, 'soun')
      ])),
      box('mdat', media)
    ]);
    const provisional = assemble([0n, 4n], [8n, 12n]);
    const mediaStart = BigInt(provisional.length - media.length);
    const videoOffsets = [mediaStart, mediaStart + 4n];
    const audioOffsets = [mediaStart + 8n, mediaStart + 12n];
    const source = assemble(videoOffsets, audioOffsets);
    // Audio promotes first; its 2-entry growth (+8) then pushes video over 32 bits.
    const delta = 0xffffffffn - videoOffsets[1] - 7n;

    const patched = rewriteChunkOffsets(source, parseMp4(source), delta);
    const tree = parseMp4(patched);

    expect(patched.length).toBe(source.length + 16);
    expect(findBoxes(tree, 'co64')).toHaveLength(2);
    expect(findBoxes(tree, 'stco')).toHaveLength(0);
    expect(readChunkOffsets(tree, 7)).toEqual(videoOffsets.map((offset) => offset + delta + 16n));
    expect(readChunkOffsets(tree, 8)).toEqual(audioOffsets.map((offset) => offset + delta + 16n));
    expect(patched.subarray(patched.length - media.length)).toEqual(media);
  });
});
