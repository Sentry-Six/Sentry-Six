'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const protobuf = require('protobufjs');
const { box, fullBox, u32, stco, lengthPrefixedSample, teslaSeiNal, h264Mp4, h265Mp4, av1Mp4, hevcNal } = require('./fixtureBuilders');
const { injectH265Telemetry } = require('../../../src/main/converter/h265Telemetry');
const { injectAv1Telemetry } = require('../../../src/main/converter/av1Telemetry');
const { extractH264TelemetryTimeline, mapTimelineToOutput } = require('../../../src/main/converter/telemetryTimeline');

const renderer = path.resolve(__dirname, '../../../src/renderer');
const schema = fs.readFileSync(path.join(renderer, 'proto/dashcam.proto'), 'utf8');
const SeiMetadata = protobuf.parse(schema).root.lookupType('SeiMetadata');
const parserSource = fs.readFileSync(path.join(renderer, 'scripts/data/dashcam-mp4.js'), 'utf8');
const context = vm.createContext({ window: {}, Uint8Array, ArrayBuffer, DataView });
vm.runInContext(parserSource, context);

function reader(bytes) {
  return new context.window.DashcamMP4(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

// A valid AVC configuration with literal SPS/PPS keeps legacy output under test.
function avcFixture(samples, durations, compositionOffsets = []) {
  const header = Buffer.alloc(78);
  header.writeUInt16BE(1920, 24);
  header.writeUInt16BE(1080, 26);
  const config = box('avcC', Buffer.from([1, 100, 0, 31, 255, 225, 0, 2, 0x67, 0x64, 1, 0, 2, 0x68, 0xee]));
  const stsd = fullBox('stsd', 0, 0, Buffer.concat([u32(1), box('avc1', Buffer.concat([header, config]))]));
  const sizes = fullBox('stsz', 0, 0, Buffer.concat([u32(0), u32(samples.length), ...samples.map(s => u32(s.length))]));
  const chunks = fullBox('stsc', 0, 0, Buffer.concat([u32(1), u32(1), u32(samples.length), u32(1)]));
  const timing = fullBox('stts', 0, 0, Buffer.concat([u32(samples.length), ...durations.flatMap(d => [u32(1), u32(d)])]));
  const mdhd = fullBox('mdhd', 0, 0, Buffer.concat([u32(0), u32(0), u32(1000), u32(1000), Buffer.alloc(4)]));
  const hdlr = fullBox('hdlr', 0, 0, Buffer.concat([u32(0), Buffer.from('vide')]));
  const ctts = compositionOffsets.length ? fullBox('ctts', 0, 0, Buffer.concat([u32(samples.length), ...compositionOffsets.flatMap(d => [u32(1), u32(d)])])) : Buffer.alloc(0);
  const moov = offset => box('moov', box('trak', box('mdia', Buffer.concat([mdhd, hdlr,
    box('minf', box('stbl', Buffer.concat([stsd, sizes, chunks, timing, ctts, stco([offset])])))]))));
  return Buffer.concat([moov(moov(0).length + 8), box('mdat', Buffer.concat(samples))]);
}

function telemetry(gearState, index) {
  if (gearState === null) return [];
  const bytes = SeiMetadata.encode(SeiMetadata.create({ version: 1, gearState, frameSeqNo: index + 100,
    vehicleSpeedMps: 12.5, latitudeDeg: 40.5, longitudeDeg: -73.25, autopilotState: 2 })).finish();
  const escaped = [];
  let zeros = 0;
  for (const byte of bytes) {
    if (zeros >= 2 && byte <= 3) { escaped.push(3); zeros = 0; }
    escaped.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return [teslaSeiNal(Buffer.from(escaped))];
}

function fixture(codec, gears, options = {}) {
  const nals = gears.map(telemetry);
  const durations = options.durations || gears.map(() => 40);
  if (codec === 'avc1') return avcFixture(nals.map((sei, i) => lengthPrefixedSample([...sei, Buffer.from([i ? 0x61 : 0x65, 0x80])])), durations, options.compositionOffsets);
  const mapped = nals.map(sei => ({ pictureMarker: true, seiNals: sei.map(nal => ({ nal })) }));
  if (codec === 'hvc1') {
    const samples = gears.map(() => lengthPrefixedSample([hevcNal(1, Buffer.from([0x80])), hevcNal(33, Buffer.from([0x80])), Buffer.from([0x41, 0x01, 0x80])], options.lengthSize || 4));
    return injectH265Telemetry(h265Mp4({ samples, timescale: 1000, durations, ...options }), mapped);
  }
  return injectAv1Telemetry(av1Mp4({ samples: gears.map(() => Buffer.from([0x12, 0, 0x32, 1, 0x80])), timescale: 1000, durations, ...options }), mapped);
}

function splitMediaMdat(bytes) {
  const table = bytes.indexOf(Buffer.from('stco')) + 12;
  const split = bytes.readUInt32BE(table + 4);
  const mdatType = bytes.lastIndexOf(Buffer.from('mdat'));
  const mdatStart = mdatType - 4;
  const end = mdatStart + bytes.readUInt32BE(mdatStart);
  const header = Buffer.from(bytes.subarray(0, mdatStart));
  header.writeUInt32BE(split + 8, table + 4);
  return Buffer.concat([header, box('mdat', bytes.subarray(mdatType + 4, split)), box('mdat', bytes.subarray(split, end)), bytes.subarray(end)]);
}

test.each(['h265', 'av1'])('%s retains a distinct terminal measurement through the actual Studio reader', codec => {
  const source = h264Mp4({ samples: [1, null, 1, 2].map((gear, i) => lengthPrefixedSample([
    ...telemetry(gear, i), Buffer.from([i ? 0x61 : 0x65, 0x80])
  ])), timescale: 1000, durations: [40, 40, 40, 0] });
  const timeline = extractH264TelemetryTimeline(source);
  const mapped = mapTimelineToOutput(timeline, [0, 40_000, 80_000].map(ptsUs => ({ ptsUs, durationUs: 40_000 })));
  const bytes = codec === 'h265'
    ? injectH265Telemetry(h265Mp4({ samples: [0, 1, 2].map(() => lengthPrefixedSample([hevcNal(1, Buffer.from([0x80]))])), timescale: 1000, durations: [40, 40, 40] }), mapped)
    : injectAv1Telemetry(av1Mp4({ samples: [0, 1, 2].map(() => Buffer.from([0x12, 0, 0x32, 1, 0x80])), timescale: 1000, durations: [40, 40, 40] }), mapped);
  expect(reader(bytes).extractSeiMessages(SeiMetadata).map(sei => Number(sei.frameSeqNo))).toEqual([100, 102, 103]);
  const frames = reader(bytes).parseFrames(SeiMetadata);
  expect(frames).toHaveLength(3);
  expect(frames.map(frame => frame.sei?.gearState ?? null)).toEqual([1, null, 2]);
});

describe.each(['avc1', 'hvc1', 'av01'])('actual Studio reader: %s', codec => {
  test.each([
    ['parked', [null, null, null, null]],
    ['driving', [1, 1, 1, 1]],
    ['parked to driving to parked', [null, 1, 1, null]],
    ['driving to parked to driving', [1, null, null, 1]],
    ['multiple gaps', [null, 1, null, 2, null, null, 1, null]]
  ])('%s preserves literal telemetry values and gaps', (_name, gears) => {
    const frames = reader(fixture(codec, gears)).parseFrames(SeiMetadata);
    expect(frames.map(f => f.sei?.gearState ?? null)).toEqual(gears);
    for (const frame of frames.filter(f => f.sei)) {
      expect(Number(frame.sei.frameSeqNo)).toBe(frame.index + 100);
      expect(frame.sei.vehicleSpeedMps).toBe(12.5);
      expect(frame.sei.latitudeDeg).toBe(40.5);
      expect(frame.sei.longitudeDeg).toBe(-73.25);
      expect(frame.sei.autopilotState).toBe(2);
    }
  });

  test('uses sample start times and variable durations', () => {
    const frames = reader(fixture(codec, [null, 1, 1, null], { durations: [20, 40, 60, 80] })).parseFrames(SeiMetadata);
    expect(frames.map(f => f.timestamp)).toEqual([0, 20, 60, 120]);
    expect(frames.map(f => f.duration)).toEqual([20, 40, 60, 80]);
  });

  test('uses composition offsets for presentation timestamps', () => {
    const frames = reader(fixture(codec, [null, 1, 1, null], { compositionOffsets: [40, 80, 0, 40] })).parseFrames(SeiMetadata);
    expect(frames.map(f => f.timestamp)).toEqual([40, 120, 80, 160]);
  });

  test('reads literal negative version-1 ctts offsets as signed presentation times', () => {
    const bytes = fixture(codec, [null, 1, 1, null], { compositionOffsets: [1, 2, 3, 4] });
    const ctts = bytes.indexOf(Buffer.from('ctts'));
    bytes[ctts + 4] = 1;
    // Decode starts are 0, 40, 80, 120 ms; these offsets yield -20, 0, 20, 40 ms.
    [-20, -40, -60, -80].forEach((offset, index) => bytes.writeInt32BE(offset, ctts + 16 + index * 8));
    const frames = reader(bytes).parseFrames(SeiMetadata);
    expect(frames.map(frame => frame.timestamp)).toEqual([-20, 0, 20, 40]);
    expect(frames.map(frame => frame.sei?.gearState ?? null)).toEqual([null, 1, 1, null]);
  });

  test('CSV extraction follows the same carrier and keeps gaps empty', () => {
    expect(reader(fixture(codec, [null, 1, 2, null])).extractSeiMessages(SeiMetadata).map(sei => sei.gearState)).toEqual([1, 2]);
  });

  test('reports the actual codec and AVC retains its parameter sets', () => {
    const config = reader(fixture(codec, [1])).getConfig();
    expect(config.codec.split('.')[0]).toBe(codec);
    expect([config.width, config.height]).toEqual([1920, 1080]);
    if (codec === 'avc1') {
      expect(config.codec).toBe('avc1.64001f');
      expect(Array.from(config.sps)).toEqual([0x67, 0x64]);
      expect(Array.from(config.pps)).toEqual([0x68, 0xee]);
    } else {
      expect(config.sps).toBeNull();
      expect(config.pps).toBeNull();
    }
  });
});

test.each([1, 2, 3, 4])('HEVC respects %i-byte NAL lengths, padding, co64 and extended boxes', lengthSize => {
  const frames = reader(fixture('hvc1', [null, 1, 2, null], { lengthSize, chunks: [2, 2], chunkPadding: 11, co64: true, extendedMdat: true, extendedHvcc: true })).parseFrames(SeiMetadata);
  expect(frames.map(f => f.sei?.gearState ?? null)).toEqual([null, 1, 2, null]);
});

test('AV1 supports moov after both mdats and co64 sample offsets', () => {
  const frames = reader(fixture('av01', [null, 1, 2, null], { moovAfterMdat: true, co64: true, extendedMdat: true })).parseFrames(SeiMetadata);
  expect(frames.map(f => f.sei?.gearState ?? null)).toEqual([null, 1, 2, null]);
});

test.each(['hvc1', 'av01'])('%s follows referenced samples across multiple real mdats', codec => {
  const frames = reader(splitMediaMdat(fixture(codec, [null, 1, 2, null], { chunks: [2, 2] }))).parseFrames(SeiMetadata);
  expect(frames.map(f => f.sei?.gearState ?? null)).toEqual([null, 1, 2, null]);
  expect(frames.map(f => f.timestamp)).toEqual([0, 40, 80, 120]);
});

test('CSV preserves multiple distinct Tesla messages in one H264 sample', () => {
  const bytes = avcFixture([lengthPrefixedSample([...telemetry(1, 0), ...telemetry(2, 0), Buffer.from([0x65, 0x80])])], [40]);
  expect(reader(bytes).extractSeiMessages(SeiMetadata).map(sei => sei.gearState)).toEqual([1, 2]);
  expect(reader(bytes).parseFrames(SeiMetadata).map(f => f.sei?.gearState)).toEqual([2]);
});

test.each(['hvc1', 'av01'])('%s CSV emits each original protobuf once when a sample has multiple SEIs', codec => {
  const mapped = [{ pictureMarker: true, seiNals: [...telemetry(1, 0), ...telemetry(2, 0)].map(nal => ({ nal })) }];
  const bytes = codec === 'hvc1'
    ? injectH265Telemetry(h265Mp4({ samples: [lengthPrefixedSample([hevcNal(1, Buffer.from([0x80]))])] }), mapped)
    : injectAv1Telemetry(av1Mp4({ samples: [Buffer.from([0x12, 0])] }), mapped);
  expect(reader(bytes).extractSeiMessages(SeiMetadata).map(sei => sei.gearState)).toEqual([1, 2]);
});

test.each(['hvc1', 'av01'])('%s rejects expanded timing counts beyond actual samples', codec => {
  const bytes = fixture(codec, [1]);
  bytes.writeUInt32BE(0xffffffff, bytes.indexOf(Buffer.from('stts')) + 12);
  expect(() => reader(bytes).parseFrames(SeiMetadata)).toThrow(/timing|sample/i);
});

test.each([['short box', Buffer.concat([u32(7), Buffer.from('moov')])],
  ['truncated extended box', Buffer.concat([u32(1), Buffer.from('moov')])],
  ['oversized box', Buffer.concat([u32(100), Buffer.from('moov')])]])('rejects %s clearly', (_name, bytes) => {
  expect(() => reader(bytes).parseFrames(SeiMetadata)).toThrow(/invalid|truncated|exceeds/i);
});

test('rejects truncated AV1 telemetry NAL lengths', () => {
  const bytes = fixture('av01', [null, 1, 1, null]);
  bytes.writeUInt32BE(0xffffff, bytes.indexOf(Buffer.from('mdat')) + 4);
  expect(() => reader(bytes).parseFrames(SeiMetadata)).toThrow(/record|NAL|carrier/i);
});

test('rejects AV1 fake markers instead of shifting telemetry onto another frame', () => {
  const bytes = fixture('av01', [null, 1, 1, null]);
  bytes[bytes.indexOf(Buffer.from('mdat')) + 10] = 0x81;
  expect(() => reader(bytes).parseFrames(SeiMetadata)).toThrow(/marker|carrier|record/i);
});

test('rejects AV1 samples pointing into the unreferenced telemetry carrier', () => {
  const bytes = fixture('av01', [null, 1, 1, null]);
  bytes.writeUInt32BE(bytes.indexOf(Buffer.from('mdat')) + 4, bytes.indexOf(Buffer.from('stco')) + 12);
  expect(() => reader(bytes).parseFrames(SeiMetadata)).toThrow(/carrier|sample|mdat/i);
});

test('rejects an AV1 carrier referenced by an audio track', () => {
  const bytes = fixture('av01', [1], { audioSamples: [Buffer.from([1, 2, 3])] });
  bytes.writeUInt32BE(bytes.indexOf(Buffer.from('mdat')) + 4, bytes.lastIndexOf(Buffer.from('stco')) + 12);
  expect(() => reader(bytes).parseFrames(SeiMetadata)).toThrow(/carrier|sample|mdat/i);
});

test('rejects dangling AV1 telemetry even without a supplied protobuf decoder', () => {
  const bytes = fixture('av01', [1, null]);
  const firstMdat = bytes.indexOf(Buffer.from('mdat')) + 4;
  const secondMdat = bytes.lastIndexOf(Buffer.from('mdat')) - 4;
  const nalRecord = Buffer.from(bytes.subarray(firstMdat, secondMdat - 14));
  const mutated = Buffer.concat([bytes.subarray(0, secondMdat), nalRecord, bytes.subarray(secondMdat)]);
  mutated.writeUInt32BE(bytes.readUInt32BE(firstMdat - 8) + nalRecord.length, firstMdat - 8);
  const tableOffset = mutated.indexOf(Buffer.from('stco')) + 12;
  mutated.writeUInt32BE(mutated.readUInt32BE(tableOffset) + nalRecord.length, tableOffset);
  expect(() => reader(mutated).parseFrames()).toThrow(/marker|carrier|record/i);
});

test.each(['hvc1', 'av01'])('%s rejects malformed protobuf inside a recognized carrier record', codec => {
  const bad = teslaSeiNal(Buffer.from([0xff]));
  const mapped = [{ pictureMarker: true, seiNals: [{ nal: bad }] }];
  const bytes = codec === 'hvc1'
    ? injectH265Telemetry(h265Mp4({ samples: [lengthPrefixedSample([hevcNal(1, Buffer.from([0x80]))])] }), mapped)
    : injectAv1Telemetry(av1Mp4({ samples: [Buffer.from([0x12, 0])] }), mapped);
  expect(() => reader(bytes).parseFrames(SeiMetadata)).toThrow(/protobuf|telemetry|carrier/i);
});

test('rejects truncated HEVC sample records', () => {
  const bytes = fixture('hvc1', [1]);
  bytes.writeUInt32BE(0xffffff, bytes.indexOf(Buffer.from('mdat')) + 4);
  expect(() => reader(bytes).parseFrames(SeiMetadata)).toThrow(/NAL|record/i);
});

test('rejects a malformed HEVC marker even in a completely parked carrier', () => {
  const bytes = fixture('hvc1', [null]);
  const marker = bytes.indexOf(Buffer.from([0x61, 0x01, 0x80]));
  bytes[marker + 2] = 0x81;
  expect(() => reader(bytes).parseFrames(SeiMetadata)).toThrow(/marker|carrier/i);
});

test('rejects unsupported sample entries clearly', () => {
  const bytes = fixture('hvc1', [1]);
  bytes.write('vp09', bytes.indexOf(Buffer.from('hvc1')));
  expect(() => reader(bytes).parseFrames(SeiMetadata)).toThrow(/unsupported.*vp09/i);
});

test('H264 does not count a second slice as a new frame or leak SEI to the next sample', () => {
  const bytes = avcFixture([
    lengthPrefixedSample([...telemetry(1, 0), Buffer.from([0x65, 0x80]), Buffer.from([0x65, 0x40])]),
    lengthPrefixedSample([Buffer.from([0x61, 0x80])])
  ], [40, 40]);
  expect(reader(bytes).parseFrames(SeiMetadata).map(f => f.sei?.gearState ?? null)).toEqual([1, null]);
});

test.each([
  ['variable durations', { durations: [20, 40, 60, 80] }, [20, 60], [101, 102]],
  ['reordered presentation times', { compositionOffsets: [40, 80, 0, 40] }, [80, 120], [102, 101]]
])('actual seiExtractor uses sorted sample start timestamps: %s', async (_name, options, timestamps, sequences) => {
  const bytes = fixture('av01', [null, 1, 1, null], options);
  class File { constructor() { this.name = 'synthetic.mp4'; this.size = bytes.length; this.lastModified = 1; } async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } }
  const sandbox = vm.createContext({ window: { protobuf }, protobuf, File, Uint8Array, ArrayBuffer, DataView, console,
    fetch: async () => ({ ok: true, text: async () => schema }) });
  vm.runInContext(parserSource, sandbox);
  const modules = new Map();
  function load(filename) {
    if (!modules.has(filename)) modules.set(filename, new vm.SourceTextModule(fs.readFileSync(filename, 'utf8'), { context: sandbox, identifier: filename }));
    return modules.get(filename);
  }
  const module = load(path.join(renderer, 'scripts/core/seiExtractor.js'));
  await module.link((specifier, referring) => load(path.resolve(path.dirname(referring.identifier), specifier)));
  await module.evaluate();
  const result = await module.namespace.extractSeiFromEntry({ file: new File() }, 'front');
  expect(result.seiData.map(s => s.timestampMs)).toEqual(timestamps);
  expect(result.mapPath.map(s => s.timestampMs)).toEqual(timestamps);
  expect(result.seiData.map(s => Number(s.sei.frame_seq_no))).toEqual(sequences);
  expect(result.seiData.map(s => s.sei.gear_state)).toEqual([1, 1]);
});
