'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createConverterAdapters } = require('../../../src/main/converter/converterAdapters');
const { inspectH265Telemetry } = require('../../../src/main/converter/h265Telemetry');
const { inspectAv1Telemetry } = require('../../../src/main/converter/av1Telemetry');
const { extractH264TelemetryTimeline } = require('../../../src/main/converter/telemetryTimeline');
const {
  lengthPrefixedSample, hevcNal, h264Mp4, h265Mp4, av1Mp4
} = require('./fixtureBuilders');

const roots = [];
afterAll(async () => Promise.all(roots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true }))));

describe('real converter writer and verifier adapters', () => {
  test.each([
    ['h265', () => h265Mp4({ samples: [lengthPrefixedSample([hevcNal(19, [0x80])])] }), inspectH265Telemetry],
    ['av1', () => av1Mp4({ samples: [Buffer.from([0x12, 0x20, 0x00])] }), inspectAv1Telemetry]
  ])('maps output timing and invokes the actual %s writer while preserving the inode', async (codec, fixture, inspect) => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sentry-six-adapter-'));
    roots.push(root);
    const candidatePath = path.join(root, `${codec}.mp4`);
    await fs.promises.writeFile(candidatePath, fixture());
    const before = await fs.promises.stat(candidatePath, { bigint: true });
    const adapters = createConverterAdapters({ fs: fs.promises });
    const timeline = Object.freeze({ samples: Object.freeze([]), events: Object.freeze([]) });

    await adapters.writers[codec]({ candidatePath, timeline, signal: new AbortController().signal });

    const after = await fs.promises.stat(candidatePath, { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(after.dev).toBe(before.dev);
    expect(inspect(await fs.promises.readFile(candidatePath))).toMatchObject({ accepted: true });
  });

  test('binds the actual verifier to injected process runners', async () => {
    const runFfprobe = jest.fn();
    const runFullDecode = jest.fn();
    const adapters = createConverterAdapters({ runFfprobe, runFullDecode });

    await expect(adapters.verifier({})).resolves.toMatchObject({ ok: false, reason: 'invalid-input' });
    expect(adapters.verifier.name).toBe('boundVerifier');
  });

  test('runs the actual verifier pipeline and forwards cancellation to both owned process runners', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sentry-six-adapter-verify-'));
    roots.push(root);
    const candidate = path.join(root, 'candidate.mp4');
    const source = path.join(root, 'source.mp4');
    const snapshotPath = path.join(root, 'snapshot.mp4');
    await fs.promises.writeFile(candidate, h265Mp4({
      samples: [lengthPrefixedSample([hevcNal(19, [0x80])])], durations: [1000]
    }));
    const adaptersForWrite = createConverterAdapters({ fs: fs.promises });
    await adaptersForWrite.writers.h265({
      candidatePath: candidate,
      timeline: Object.freeze({ samples: Object.freeze([]), events: Object.freeze([]) })
    });
    const outputBytes = (await fs.promises.stat(candidate)).size;
    const makeSource = (padding) => h264Mp4({
      samples: [lengthPrefixedSample([Buffer.concat([Buffer.from([0x65, 0x88]), Buffer.alloc(padding, 0x7a)])])],
      durations: [1000]
    });
    const baseSource = makeSource(0);
    const desiredSourceBytes = Math.round(outputBytes / 0.8);
    await fs.promises.writeFile(source, makeSource(desiredSourceBytes - baseSource.length));
    const signal = new AbortController().signal;
    const probe = jest.fn(async (_command, args, options) => ({
      status: 0,
      stdout: JSON.stringify({
        streams: [{
          index: 0, codec_type: 'video', codec_name: 'hevc', codec_tag_string: 'hvc1',
          width: 1920, height: 1080,
          duration: '0.033333', nb_frames: '1', nb_read_frames: '1',
          avg_frame_rate: '30/1', r_frame_rate: '30/1'
        }],
        format: { duration: '0.033333' }
      }),
      stderr: '',
      observedSignal: options.signal,
      target: args.at(-1)
    }));
    const decode = jest.fn(async (_command, _args, options) => {
      expect(options.signal).toBe(signal);
      return { status: 0, stdout: '', stderr: '' };
    });
    const adapters = createConverterAdapters({
      fs: fs.promises,
      runFfprobe: probe,
      runFullDecode: decode,
      verifierOptions: {
        createSnapshot: async ({ bytes }) => {
          await fs.promises.writeFile(snapshotPath, bytes);
          return {
            path: snapshotPath,
            token: 'snapshot-token',
            read: () => fs.promises.readFile(snapshotPath),
            cleanup: () => fs.promises.rm(snapshotPath, { force: true }),
            transfer: () => ({ path: snapshotPath, token: 'snapshot-token' })
          };
        }
      }
    });

    const result = await adapters.verifier({
      source,
      candidate,
      codec: 'h265',
      profileId: 'balanced',
      sourceTimeline: extractH264TelemetryTimeline(await fs.promises.readFile(source)),
      signal
    });

    expect(result.reason).toBe(null);
    expect(result).toMatchObject({ ok: true, publicationArtifact: { path: snapshotPath } });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0][2].signal).toBe(signal);
    expect(decode).toHaveBeenCalledTimes(1);
  });
});
