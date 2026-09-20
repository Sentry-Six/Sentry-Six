'use strict';

const crypto = require('crypto');
const {
  lengthPrefixedSample,
  annexBSample,
  teslaSeiNal,
  unrelatedSeiNal,
  h264Mp4
} = require('./fixtureBuilders');
const {
  parseH264Nals,
  extractH264TelemetryTimeline,
  mapTimelineToOutput
} = require('../../../src/main/converter/telemetryTimeline');

const picture = (type = 1) => Buffer.from([type, 0xaa, 0xbb]);
const fingerprint = (payload) => crypto.createHash('sha256').update(payload).digest('hex');

describe('H.264 NAL parsing', () => {
  test.each([1, 2, 4])('uses the avcC %i-byte NAL length size', (lengthSize) => {
    const nals = [teslaSeiNal([0x10]), picture()];
    expect(parseH264Nals(lengthPrefixedSample(nals, lengthSize), { format: 'length-prefixed', lengthSize })).toEqual(nals);
  });

  test('splits three-byte and four-byte Annex-B start codes without retaining them', () => {
    const nals = [teslaSeiNal([0x20]), picture(5), unrelatedSeiNal()];
    const sample = Buffer.concat([annexBSample(nals.slice(0, 2)), annexBSample(nals.slice(2), true)]);
    expect(parseH264Nals(sample, { format: 'annex-b' })).toEqual(nals);
  });

  test('rejects a length-prefixed NAL whose declared length exceeds the sample', () => {
    expect(() => parseH264Nals(Buffer.from([0, 0, 0, 5, 0x06]), { format: 'length-prefixed', lengthSize: 4 }))
      .toThrow(/NAL length exceeds sample/i);
  });

  test('rejects zero-length NAL units instead of silently accepting malformed AVC', () => {
    expect(() => parseH264Nals(Buffer.alloc(4), { format: 'length-prefixed', lengthSize: 4 }))
      .toThrow(/zero-length NAL/i);
  });
});

describe('extractH264TelemetryTimeline', () => {
  test('associates Tesla SEI before or after the picture with the exact access-unit PTS', () => {
    const first = teslaSeiNal([0x01]);
    const second = teslaSeiNal([0x02]);
    const source = h264Mp4({
      samples: [
        lengthPrefixedSample([picture()]),
        lengthPrefixedSample([first, picture()]),
        lengthPrefixedSample([picture(), second]),
        lengthPrefixedSample([picture()])
      ]
    });

    const timeline = extractH264TelemetryTimeline(source);

    expect(timeline.samples.map(({ ptsUs, hasTelemetry }) => [ptsUs, hasTelemetry])).toEqual([
      [0, false], [33_333, true], [66_667, true], [100_000, false]
    ]);
    expect(timeline.events.map(({ sourcePtsUs, nal }) => [sourcePtsUs, nal])).toEqual([[33_333, first], [66_667, second]]);
  });

  test('preserves multiple ordered Tesla SEIs, ignores unrelated SEI, and fingerprints normalized payloads', () => {
    const one = teslaSeiNal([0x00, 0x00, 0x03, 0x01]);
    const two = teslaSeiNal([0x44]);
    const source = h264Mp4({ samples: [lengthPrefixedSample([picture(), one, unrelatedSeiNal([0x24, 0x69, 0x01]), two])] });

    const timeline = extractH264TelemetryTimeline(source);

    expect(timeline.samples[0].seiNals.map(({ nal }) => nal)).toEqual([one, two]);
    expect(timeline.samples[0].seiNals.map(({ fingerprint: value }) => value)).toEqual([
      fingerprint(Buffer.from([0x00, 0x00, 0x01])), fingerprint(Buffer.from([0x44]))
    ]);
    expect(timeline.events).toHaveLength(2);
  });

  test('represents a fully parked clip as explicit no-telemetry samples', () => {
    const source = h264Mp4({ samples: Array.from({ length: 3 }, () => lengthPrefixedSample([picture()])) });

    const timeline = extractH264TelemetryTimeline(source);

    expect(timeline.events).toEqual([]);
    expect(timeline.samples.map(({ hasTelemetry, seiNals }) => [hasTelemetry, seiNals])).toEqual([
      [false, []], [false, []], [false, []]
    ]);
  });

  test('keeps decode-order samples with their reordered presentation timestamps', () => {
    const source = h264Mp4({
      samples: [0x10, 0x20, 0x30].map((value) => lengthPrefixedSample([teslaSeiNal([value]), picture()])),
      compositionOffsets: [0, 1_000, -1_000]
    });

    const timeline = extractH264TelemetryTimeline(source);

    expect(timeline.samples.map(({ ptsUs }) => ptsUs)).toEqual([0, 66_667, 33_333]);
    expect(timeline.events.map(({ sourcePtsUs }) => sourcePtsUs)).toEqual([0, 66_667, 33_333]);
  });

  test('reads 1-byte, 2-byte, and 4-byte AVC lengths from avcC', () => {
    for (const lengthSize of [1, 2, 4]) {
      const source = h264Mp4({
        lengthSize,
        samples: [lengthPrefixedSample([teslaSeiNal([lengthSize]), picture()], lengthSize)]
      });
      expect(extractH264TelemetryTimeline(source).samples[0].hasTelemetry).toBe(true);
    }
  });

  test('rejects malformed sample NAL lengths through the MP4 extraction boundary', () => {
    const source = h264Mp4({ samples: [Buffer.from([0, 0, 0, 8, 0x06])] });
    expect(() => extractH264TelemetryTimeline(source)).toThrow(/NAL length exceeds sample/i);
  });
});

describe('mapTimelineToOutput', () => {
  const telemetry = (ptsUs, id) => ({
    sourcePtsUs: ptsUs,
    nal: Buffer.from([id]),
    fingerprint: String(id)
  });
  const timeline = (states) => ({
    samples: states.map(([ptsUs, ids]) => ({ ptsUs, hasTelemetry: ids.length > 0, seiNals: ids.map((id) => telemetry(ptsUs, id)) })),
    events: states.flatMap(([ptsUs, ids]) => ids.map((id) => telemetry(ptsUs, id)))
  });
  const outputs = (ptsValues, durationUs = 34_000) => ptsValues.map((ptsUs) => ({ ptsUs, durationUs }));
  const ids = (mapped) => mapped.map(({ seiNals }) => seiNals.map(({ nal }) => nal[0]));

  test.each([2, 12])('retains all terminal records when %i pictures omit a zero-duration tail', (count) => {
    const source = timeline(Array.from({ length: count + 1 }, (_, i) => [i * 40_000, i === count ? [90, 91] : [i + 1]]));
    source.samples.forEach((sample, i) => { sample.durationUs = i === count ? 0 : 40_000; });
    const mapped = mapTimelineToOutput(source, outputs(Array.from({ length: count }, (_, i) => i * 40_000), 40_000));
    expect(ids(mapped).at(-1)).toEqual([count, 90, 91]);
    expect(ids(mapped).flat()).toEqual([...Array.from({ length: count }, (_, i) => i + 1), 90, 91]);
    expect(mapped).toHaveLength(count);
  });

  test('emits picture markers and empty SEI arrays for a fully parked clip', () => {
    expect(mapTimelineToOutput(timeline([[0, []], [33_333, []]]), outputs([0, 33_500]))).toEqual([
      { ptsUs: 0, pictureMarker: true, seiNals: [] },
      { ptsUs: 33_500, pictureMarker: true, seiNals: [] }
    ]);
  });

  test.each([
    ['driving-to-parked', [[0, [1]], [33_333, [2]], [66_667, []], [100_000, []]], [[1], [2], [], []]],
    ['parked-to-driving', [[0, []], [33_333, []], [66_667, [3]], [100_000, [4]]], [[], [], [3], [4]]],
    ['multiple telemetry gaps', [[0, [1]], [33_333, []], [66_667, []], [100_000, [4]], [133_333, []]], [[1], [], [], [4], []]]
  ])('does not fill %s gaps', (_name, sourceStates, expectedIds) => {
    const mapped = mapTimelineToOutput(timeline(sourceStates), outputs(sourceStates.map(([ptsUs]) => ptsUs + 500)));
    expect(ids(mapped)).toEqual(expectedIds);
  });

  test('maps all ordered SEIs from one source sample to its nearest output PTS', () => {
    const mapped = mapTimelineToOutput(timeline([[50_000, [1, 2, 3]]]), outputs([0, 49_000, 100_000], 33_333));
    expect(ids(mapped)).toEqual([[], [1, 2, 3], []]);
  });

  test('uses the earlier presentation timestamp for an exact nearest-PTS tie while retaining output sample order', () => {
    const mapped = mapTimelineToOutput(timeline([[50, [9]]]), outputs([100, 0], 100));
    expect(mapped.map(({ ptsUs }) => ptsUs)).toEqual([100, 0]);
    expect(ids(mapped)).toEqual([[], [9]]);
  });

  test('drops a source event beyond one output-frame duration', () => {
    const mapped = mapTimelineToOutput(timeline([[0, [7]]]), outputs([50_000], 33_333));
    expect(ids(mapped)).toEqual([[]]);
  });

  test('does not slide a neighboring event onto an output frame at an explicit source gap', () => {
    const mapped = mapTimelineToOutput(timeline([[0, [7]], [33_333, []]]), outputs([33_333], 33_333));
    expect(ids(mapped)).toEqual([[]]);
  });

  test.each([
    ['equal-distance boundary', [[0, [7]], [100, []]], 50],
    ['same-PTS boundary', [[0, [7]], [0, []]], 0]
  ])('lets an explicit source gap win the %s', (_name, sourceStates, outputPtsUs) => {
    const mapped = mapTimelineToOutput(timeline(sourceStates), outputs([outputPtsUs], 100));
    expect(ids(mapped)).toEqual([[]]);
  });
});
