'use strict';

const {
  SAFE_VIDEO_BITRATE_FLOORS,
  RETRY_REASONS,
  buildEncodeArgs,
  calculateInitialBitrate,
  calculateRetryBitrate,
  calculateSecantRetryBitrate,
  decideSizeRetry,
  probeCandidate,
  createEncoderPlanner
} = require('../../../src/main/converter/encoderPlanner');
const { targetOutputBytes, isWithinProfile } = require('../../../src/main/converter/contracts');

function encoderFromArgs(args) {
  const index = args.indexOf('-c:v');
  return index === -1 ? null : args[index + 1];
}

function fakeRunner({ advertised, outcomes = {} }) {
  const calls = [];
  const runProbe = jest.fn(async (command, args, options) => {
    calls.push({ command, args, options });
    if (args.includes('-encoders')) {
      return { status: 0, stdout: advertised.map((codec) => ` V..... ${codec}`).join('\n'), stderr: '' };
    }
    const codec = encoderFromArgs(args);
    const outcome = outcomes[codec];
    if (outcome instanceof Error) throw outcome;
    return outcome || { status: 0, stdout: '', stderr: '' };
  });
  return { runProbe, calls };
}

describe('encoder candidate discovery and proof', () => {
  test.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid planner timeout %s before invoking the runner',
    (timeoutMs) => {
      const runProbe = jest.fn();

      expect(() => createEncoderPlanner({ runProbe, platform: 'win32', timeoutMs })).toThrow(/timeoutMs.*positive.*safe integer/i);
      expect(runProbe).not.toHaveBeenCalled();
    }
  );

  test.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid direct-probe timeout %s before invoking the runner',
    async (timeoutMs) => {
      const runProbe = jest.fn();

      await expect(probeCandidate({
        runProbe,
        platform: 'win32',
        family: 'h265',
        candidate: { codec: 'libx265', hardware: false },
        timeoutMs
      })).rejects.toThrow(/timeoutMs.*positive.*safe integer/i);
      expect(runProbe).not.toHaveBeenCalled();
    }
  );

  test('uses Windows HEVC priority NVENC, QSV, then AMF and stops at the first proven encoder', async () => {
    const { runProbe, calls } = fakeRunner({
      advertised: ['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'libx265'],
      outcomes: { hevc_nvenc: { status: 1 }, hevc_qsv: { status: 0 } }
    });
    const planner = createEncoderPlanner({ runProbe, platform: 'win32', ffmpegPath: 'C:\\ffmpeg\\ffmpeg.exe' });

    const selected = await planner.select('h265');

    expect(selected.codec).toBe('hevc_qsv');
    expect(calls.slice(1).map(({ args }) => encoderFromArgs(args))).toEqual(['hevc_nvenc', 'hevc_qsv']);
  });

  test('selects AV1 NVENC first when it is advertised and completes the real encode probe', async () => {
    const { runProbe, calls } = fakeRunner({
      advertised: ['av1_nvenc', 'av1_qsv', 'av1_amf', 'libsvtav1']
    });
    const planner = createEncoderPlanner({ runProbe, platform: 'win32' });

    await expect(planner.select('av1')).resolves.toEqual(expect.objectContaining({ codec: 'av1_nvenc', family: 'av1', hardware: true }));
    const encodeCall = calls[1];
    expect(encodeCall.command).toBe('ffmpeg');
    expect(Array.isArray(encodeCall.args)).toBe(true);
    expect(encodeCall.options).toEqual(expect.objectContaining({ shell: false, timeoutMs: expect.any(Number) }));
  });

  test('uses only the platform-applicable VideoToolbox candidate before the tested AV1 CPU fallback on macOS', async () => {
    const { runProbe, calls } = fakeRunner({
      advertised: ['av1_nvenc', 'av1_qsv', 'av1_amf', 'av1_videotoolbox', 'av1_vaapi', 'libsvtav1'],
      outcomes: { av1_videotoolbox: { status: 1 }, libsvtav1: { status: 0 } }
    });
    const planner = createEncoderPlanner({ runProbe, platform: 'darwin' });

    await expect(planner.select('av1')).resolves.toEqual(expect.objectContaining({ codec: 'libsvtav1', hardware: false }));
    expect(calls.slice(1).map(({ args }) => encoderFromArgs(args))).toEqual(['av1_videotoolbox', 'libsvtav1']);
  });

  test('orders Linux candidates NVENC, QSV, AMF, VAAPI, then the mandatory tested CPU fallback', async () => {
    const { runProbe, calls } = fakeRunner({
      advertised: ['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_vaapi', 'libx265'],
      outcomes: {
        hevc_nvenc: { status: 1 },
        hevc_qsv: { timedOut: true, status: null },
        hevc_amf: new Error('driver initialization error'),
        hevc_vaapi: { status: 2, stderr: 'Device creation failed' },
        libx265: { status: 0 }
      }
    });
    const planner = createEncoderPlanner({ runProbe, platform: 'linux', vaapiDevice: '/dev/dri/renderD129' });

    await expect(planner.select('h265')).resolves.toEqual(expect.objectContaining({ codec: 'libx265', hardware: false }));
    expect(calls.slice(1).map(({ args }) => encoderFromArgs(args))).toEqual([
      'hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_vaapi', 'libx265'
    ]);
    const vaapiArgs = calls.find(({ args }) => encoderFromArgs(args) === 'hevc_vaapi').args;
    expect(vaapiArgs).toEqual(expect.arrayContaining(['-vaapi_device', '/dev/dri/renderD129', '-vf', 'format=nv12,hwupload']));
  });

  test('does not treat an encoder-list entry as proof and rejects when every advertised candidate is unusable', async () => {
    const { runProbe } = fakeRunner({
      advertised: ['av1_nvenc', 'libsvtav1'],
      outcomes: { av1_nvenc: { status: 1 }, libsvtav1: { status: 1 } }
    });
    const planner = createEncoderPlanner({ runProbe, platform: 'win32' });

    await expect(planner.select('av1')).rejects.toThrow(/no proven av1 encoder/i);
  });

  test('caches advertised encoders and real candidate proof across repeated selections', async () => {
    const { runProbe, calls } = fakeRunner({ advertised: ['hevc_nvenc', 'libx265'] });
    const planner = createEncoderPlanner({ runProbe, platform: 'win32' });

    const first = await planner.select('h265');
    const second = await planner.select('h265');

    expect(second).toBe(first);
    expect(calls).toHaveLength(2);
  });

  test('can prove and return the CPU fallback later after a selected hardware encoder fails at job time', async () => {
    const { runProbe, calls } = fakeRunner({ advertised: ['hevc_nvenc', 'libx265'] });
    const planner = createEncoderPlanner({ runProbe, platform: 'win32' });
    expect((await planner.select('h265')).codec).toBe('hevc_nvenc');

    const fallback = await planner.selectCpuFallback('h265');

    expect(fallback).toEqual(expect.objectContaining({ codec: 'libx265', hardware: false }));
    expect(calls.slice(1).map(({ args }) => encoderFromArgs(args))).toEqual(['hevc_nvenc', 'libx265']);
  });

  test('tries libsvtav1 first, then proves listed libaom-av1 when SVT is absent or unusable', async () => {
    const { runProbe, calls } = fakeRunner({
      advertised: ['av1_nvenc', 'libsvtav1', 'libaom-av1'],
      outcomes: {
        av1_nvenc: { status: 1 },
        libsvtav1: { status: 2, stderr: 'SVT initialization failed' },
        'libaom-av1': { status: 0 }
      }
    });
    const planner = createEncoderPlanner({ runProbe, platform: 'win32' });

    await expect(planner.select('av1')).resolves.toEqual(expect.objectContaining({ codec: 'libaom-av1', hardware: false }));
    expect(calls.slice(1).map(({ args }) => encoderFromArgs(args))).toEqual(['av1_nvenc', 'libsvtav1', 'libaom-av1']);
    const libaomArgs = calls.find(({ args }) => encoderFromArgs(args) === 'libaom-av1').args;
    expect(libaomArgs).toEqual(expect.arrayContaining([
      '-c:v', 'libaom-av1', '-b:v', '500000', '-pix_fmt', 'yuv420p',
      '-cpu-used', '6', '-row-mt', '1', '-tag:v', 'av01', '-use_editlist', '0'
    ]));
  });

  test.each([
    ['timeout', { timedOut: true, status: null }],
    ['runner error result', { status: null, error: new Error('spawn failed') }],
    ['non-zero status', { status: 17, stderr: 'encoder failed' }]
  ])('probeCandidate reports %s without selecting the encoder', async (expectedReason, result) => {
    const runProbe = jest.fn(async () => result);

    const proof = await probeCandidate({
      runProbe,
      ffmpegPath: 'ffmpeg',
      platform: 'win32',
      family: 'h265',
      candidate: { codec: 'hevc_nvenc', hardware: true }
    });

    expect(proof).toEqual(expect.objectContaining({ usable: false, reason: expectedReason }));
  });

  test('fails discovery on an unsuccessful encoder-list process instead of assuming a fallback exists', async () => {
    const runProbe = jest.fn(async () => ({ status: 3, stderr: 'bad executable' }));
    const planner = createEncoderPlanner({ runProbe, platform: 'win32' });

    await expect(planner.select('h265')).rejects.toThrow(/encoder discovery/i);
  });

  test('wraps a thrown encoder-list runner error as a discovery failure', async () => {
    const runProbe = jest.fn(() => { throw new Error('spawn failed'); });
    const planner = createEncoderPlanner({ runProbe, platform: 'win32' });

    await expect(planner.select('h265')).rejects.toThrow(/encoder discovery.*spawn failed/i);
  });
});

describe('codec-specific encode arguments', () => {
  test('builds decoder-compatible edit-list-free H.265 MP4 arguments with exact hvc1 tagging', () => {
    const args = buildEncodeArgs({ codec: 'h265', encoder: 'libx265', bitrate: 2_000_000 });

    expect(args).toEqual(expect.arrayContaining([
      '-c:v', 'libx265', '-b:v', '2000000', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1',
      '-bf', '0', '-start_at_zero', '-avoid_negative_ts', 'make_zero', '-use_editlist', '0'
    ]));
    expect(args.every((arg) => typeof arg === 'string')).toBe(true);
  });

  test('builds decoder-compatible edit-list-free AV1 MP4 arguments with exact av01 tagging', () => {
    const args = buildEncodeArgs({ codec: 'av1', encoder: 'libsvtav1', bitrate: 1_500_000 });

    expect(args).toEqual(expect.arrayContaining([
      '-c:v', 'libsvtav1', '-b:v', '1500000', '-pix_fmt', 'yuv420p', '-tag:v', 'av01',
      '-start_at_zero', '-avoid_negative_ts', 'make_zero', '-use_editlist', '0'
    ]));
  });

  test('uses AMF vbr_peak rate control and never the known-failing QVBR path', () => {
    const h265 = buildEncodeArgs({ codec: 'h265', encoder: 'hevc_amf', bitrate: 2_000_000 });
    const av1 = buildEncodeArgs({ codec: 'av1', encoder: 'av1_amf', bitrate: 1_500_000 });

    for (const args of [h265, av1]) {
      expect(args).toEqual(expect.arrayContaining(['-rc', 'vbr_peak']));
      expect(args.join(' ')).not.toMatch(/qvbr/i);
    }
  });

  test('real probe performs a short MP4 encode with frame timing and safe muxer arguments', async () => {
    const runProbe = jest.fn(async () => ({ status: 0, stdout: '', stderr: '' }));

    const proof = await probeCandidate({
      runProbe,
      ffmpegPath: 'C:\\ffmpeg\\ffmpeg.exe',
      platform: 'win32',
      family: 'av1',
      candidate: { codec: 'libsvtav1', hardware: false },
      bitrate: 500_000
    });

    expect(proof.usable).toBe(true);
    const [command, args, options] = runProbe.mock.calls[0];
    expect(command).toBe('C:\\ffmpeg\\ffmpeg.exe');
    expect(args).toEqual(expect.arrayContaining([
      '-f', 'lavfi', '-i', 'testsrc2=duration=0.5:size=640x360:rate=8',
      '-frames:v', '4', '-fps_mode', 'passthrough',
      '-use_editlist', '0', '-avoid_negative_ts', 'make_zero', '-f', 'mp4'
    ]));
    expect(args).not.toContain('-r');
    expect(args[args.length - 1]).toBe('NUL');
    expect(options).toEqual(expect.objectContaining({ shell: false, windowsHide: true }));
  });
});

describe('bitrate and retry planning', () => {
  test('derives video bitrate only from target bytes left after explicit container and telemetry reserves', () => {
    expect(calculateInitialBitrate({
      codec: 'h265',
      targetBytes: 10_000_000,
      durationSeconds: 40,
      containerReserveBytes: 200_000,
      telemetryReserveBytes: 300_000
    })).toBe(1_900_000);
  });

  test.each([
    [{ codec: 'h265', targetBytes: 0, durationSeconds: 10, containerReserveBytes: 1, telemetryReserveBytes: 1 }, /targetBytes/],
    [{ codec: 'h265', targetBytes: 1_000, durationSeconds: Number.NaN, containerReserveBytes: 1, telemetryReserveBytes: 1 }, /durationSeconds/],
    [{ codec: 'h265', targetBytes: 1_000, durationSeconds: 10, containerReserveBytes: -1, telemetryReserveBytes: 1 }, /containerReserveBytes/],
    [{ codec: 'av1', targetBytes: 1_000, durationSeconds: 10, containerReserveBytes: 600, telemetryReserveBytes: 400 }, /reserve/]
  ])('rejects invalid bitrate inputs %#', (input, message) => {
    expect(() => calculateInitialBitrate(input)).toThrow(message);
  });

  test('clamps only to the documented codec safe floor when the byte target implies less', () => {
    expect(calculateInitialBitrate({
      codec: 'av1',
      targetBytes: 1_000_000,
      durationSeconds: 100,
      containerReserveBytes: 100_000,
      telemetryReserveBytes: 100_000
    })).toBe(SAFE_VIDEO_BITRATE_FLOORS.av1);
  });

  test.each([
    [Number.MAX_VALUE, 'overflow'],
    [Number.MAX_SAFE_INTEGER, 'an unsafe integer']
  ])('rejects an initial bitrate %s-byte target whose calculation is %s', (targetBytes) => {
    expect(() => calculateInitialBitrate({
      codec: 'h265',
      targetBytes,
      durationSeconds: 1,
      containerReserveBytes: 1,
      telemetryReserveBytes: 1
    })).toThrow(/calculated bitrate.*positive finite safe integer/i);
  });

  test('computes the one correction bitrate from the actual-to-target size ratio', () => {
    expect(calculateRetryBitrate(2_000_000, 900_000, 800_000)).toBeCloseTo(1_777_778, -1);
  });

  test.each([
    { currentBitrate: Number.MAX_VALUE, actualBytes: 1, targetBytes: 2, resultKind: 'overflow' },
    { currentBitrate: Number.MAX_SAFE_INTEGER, actualBytes: 1, targetBytes: 2, resultKind: 'an unsafe integer' }
  ])('rejects a retry calculation from $currentBitrate whose result is $resultKind', ({ currentBitrate, actualBytes, targetBytes }) => {
    expect(() => calculateRetryBitrate(currentBitrate, actualBytes, targetBytes)).toThrow(/calculated bitrate.*positive finite safe integer/i);
  });

  test('allows exactly one correction for a profile-size miss and never retries other failures', () => {
    const first = decideSizeRetry({
      retryCount: 0,
      failureReason: RETRY_REASONS.PROFILE_SIZE,
      codec: 'h265',
      currentBitrate: 2_000_000,
      actualBytes: 900_000,
      targetBytes: 800_000
    });
    const second = decideSizeRetry({
      retryCount: 1,
      failureReason: RETRY_REASONS.PROFILE_SIZE,
      codec: 'h265',
      currentBitrate: first.bitrate,
      actualBytes: 850_000,
      targetBytes: 800_000
    });
    const decodeFailure = decideSizeRetry({
      retryCount: 0,
      failureReason: 'decode-failed',
      codec: 'h265',
      currentBitrate: 2_000_000,
      actualBytes: 900_000,
      targetBytes: 800_000
    });

    expect(first).toEqual({ retry: true, bitrate: 1_777_778 });
    expect(second).toEqual({ retry: false, bitrate: null });
    expect(decodeFailure).toEqual({ retry: false, bitrate: null });
  });

  test('allows libaom-av1 two corrections while every other encoder keeps one', () => {
    const request = {
      failureReason: RETRY_REASONS.PROFILE_SIZE,
      codec: 'av1',
      currentBitrate: 1_200_000,
      actualBytes: 900_000,
      targetBytes: 800_000
    };
    expect(decideSizeRetry({ ...request, encoder: 'libaom-av1', retryCount: 1 }).retry).toBe(true);
    expect(decideSizeRetry({ ...request, encoder: 'libaom-av1', retryCount: 2 })).toEqual({ retry: false, bitrate: null });
    for (const encoder of ['libsvtav1', 'av1_nvenc', 'libx265']) {
      expect(decideSizeRetry({ ...request, encoder, retryCount: 1 })).toEqual({ retry: false, bitrate: null });
    }
    expect(decideSizeRetry({ ...request, encoder: 'libaom-av1', retryCount: 0,
      failureReason: 'telemetry-mismatch' })).toEqual({ retry: false, bitrate: null });
  });
});

describe('size correction convergence with a simulated encoder', () => {
  const sourceBytes = 2_500_000;
  const initialBitrate = 1_200_000;

  // Output bytes = fixed container/telemetry bytes + a video part that scales
  // with bitrate^exponent. An exponent below 1 responds less than
  // proportionally, like libaom's one-pass rate control on a short clip; above
  // 1 it over-responds. `firstSavings` sets where the first attempt lands.
  function simulatedEncoder({ firstSavings, exponent, fixedBytes = 20_000 }) {
    const scale = (sourceBytes * (1 - firstSavings) - fixedBytes) / initialBitrate ** exponent;
    return (bitrate) => Math.round(fixedBytes + scale * bitrate ** exponent);
  }

  // Mirrors jobService's loop: verify, ask decideSizeRetry, re-encode. With
  // withHistory false every correction is the previous proportional step.
  function runSizeLoop({ outputBytesFor, encoder = 'libaom-av1', codec = 'av1', profileId = 'conservative', withHistory = true }) {
    const targetBytes = targetOutputBytes(sourceBytes, profileId);
    const attempts = [];
    let bitrate = initialBitrate;
    let history = [];
    for (let retryCount = 0; ; retryCount += 1) {
      const actualBytes = outputBytesFor(bitrate);
      attempts.push({ bitrate, actualBytes, savings: 1 - actualBytes / sourceBytes });
      if (isWithinProfile(sourceBytes, actualBytes, profileId)) return { ok: true, attempts };
      const decision = decideSizeRetry({ retryCount, failureReason: RETRY_REASONS.PROFILE_SIZE, codec, encoder,
        currentBitrate: bitrate, actualBytes, targetBytes, history: withHistory ? history : [] });
      if (!decision.retry) return { ok: false, attempts };
      history = [...history, { bitrate, actualBytes }];
      bitrate = decision.bitrate;
    }
  }

  test.each([
    { firstSavings: 0.12, exponent: 0.35 },
    { firstSavings: 0.14, exponent: 0.5 },
    { firstSavings: 0.10, exponent: 0.3 },
    { firstSavings: 0.20, exponent: 0.6 },
    { firstSavings: 0.30, exponent: 0.5 }
  ])('an undershooting libaom-like encoder ($firstSavings first savings, exponent $exponent) converges where proportional steps failed', (model) => {
    const outputBytesFor = simulatedEncoder(model);
    const proportional = runSizeLoop({ outputBytesFor, withHistory: false });
    const secant = runSizeLoop({ outputBytesFor });

    // The old logic: three attempts, all still saving more than the 3-7% band.
    expect(proportional.ok).toBe(false);
    expect(proportional.attempts).toHaveLength(3);
    expect(proportional.attempts.at(-1).savings).toBeGreaterThan(0.07);
    // The same first two attempts, then a secant step that lands near the
    // band's 5% centre rather than creeping toward its edge.
    expect(secant.ok).toBe(true);
    expect(secant.attempts).toHaveLength(3);
    expect(secant.attempts.slice(0, 2)).toEqual(proportional.attempts.slice(0, 2));
    expect(Math.abs(secant.attempts[2].savings - 0.05)).toBeLessThan(0.02);
  });

  test('an over-responding encoder that oscillates under proportional steps converges', () => {
    const outputBytesFor = simulatedEncoder({ firstSavings: 0.01, exponent: 2 });
    const proportional = runSizeLoop({ outputBytesFor, withHistory: false });
    const secant = runSizeLoop({ outputBytesFor });

    expect(proportional.ok).toBe(false);
    expect(proportional.attempts.map(({ savings }) => savings > 0.07)).toEqual([false, true, false]);
    expect(secant.ok).toBe(true);
    expect(secant.attempts.at(-1).savings).toBeCloseTo(0.05, 1);
  });

  test('a proportional encoder still converges on the first correction', () => {
    const result = runSizeLoop({ outputBytesFor: simulatedEncoder({ firstSavings: 0.11, exponent: 1, fixedBytes: 0 }) });
    expect(result.ok).toBe(true);
    expect(result.attempts).toHaveLength(2);
  });

  test('success bands are unchanged: a miss just outside the band still fails after the correction budget', () => {
    // Every attempt lands at 7.1% savings whatever the bitrate.
    const result = runSizeLoop({ outputBytesFor: () => Math.round(sourceBytes * 0.929) });
    expect(result.ok).toBe(false);
    expect(result.attempts).toHaveLength(3);
  });

  test.each(['libx265', 'hevc_nvenc', 'libsvtav1', 'av1_nvenc'])('%s keeps one proportional correction', (encoder) => {
    const codec = /hevc|x265/.test(encoder) ? 'h265' : 'av1';
    const outputBytesFor = simulatedEncoder({ firstSavings: 0.12, exponent: 0.35 });
    const result = runSizeLoop({ outputBytesFor, encoder, codec });
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[1].bitrate).toBe(calculateRetryBitrate(
      initialBitrate, result.attempts[0].actualBytes, targetOutputBytes(sourceBytes, 'conservative'), { codec }));
  });

  test('the first correction is proportional even when history is passed', () => {
    const request = { retryCount: 0, failureReason: RETRY_REASONS.PROFILE_SIZE, codec: 'av1', encoder: 'libaom-av1',
      currentBitrate: 1_200_000, actualBytes: 2_200_000, targetBytes: 2_375_000 };
    expect(decideSizeRetry({ ...request, history: [] }).bitrate).toBe(calculateRetryBitrate(1_200_000, 2_200_000, 2_375_000, { codec: 'av1' }));
  });

  describe('calculateSecantRetryBitrate', () => {
    const target = 2_375_000;

    test('aims the line through two attempts at the target', () => {
      // bytes = bitrate + 100_000 exactly, so the secant lands on the target.
      const bytes = (bitrate) => bitrate + 100_000;
      const next = calculateSecantRetryBitrate({ bitrate: 2_000_000, actualBytes: bytes(2_000_000) },
        { bitrate: 2_100_000, actualBytes: bytes(2_100_000) }, target, { codec: 'av1' });
      expect(next).toBe(2_275_000);
    });

    test.each([
      ['a non-positive slope', { bitrate: 1_000_000, actualBytes: 2_300_000 }, { bitrate: 1_100_000, actualBytes: 2_200_000 }],
      ['equal bitrates', { bitrate: 1_100_000, actualBytes: 2_100_000 }, { bitrate: 1_100_000, actualBytes: 2_200_000 }],
      ['bitrates under 1% apart', { bitrate: 1_100_000, actualBytes: 2_100_000 }, { bitrate: 1_105_000, actualBytes: 2_200_000 }],
      ['a missing previous attempt', null, { bitrate: 1_100_000, actualBytes: 2_200_000 }],
      ['non-finite bytes', { bitrate: 1_000_000, actualBytes: Number.NaN }, { bitrate: 1_100_000, actualBytes: 2_200_000 }]
    ])('declines %s, leaving the proportional step', (_label, previous, current) => {
      expect(calculateSecantRetryBitrate(previous, current, target, { codec: 'av1' })).toBeNull();
      if (previous) {
        expect(decideSizeRetry({ retryCount: 1, failureReason: RETRY_REASONS.PROFILE_SIZE, codec: 'av1', encoder: 'libaom-av1',
          currentBitrate: current.bitrate, actualBytes: current.actualBytes, targetBytes: target, history: [previous] }).bitrate)
          .toBe(calculateRetryBitrate(current.bitrate, current.actualBytes, target, { codec: 'av1' }));
      }
    });

    test('bounds a nearly flat response to four proportional steps and at most 2x', () => {
      const previous = { bitrate: 1_000_000, actualBytes: 2_300_000 };
      const current = { bitrate: 1_100_000, actualBytes: 2_300_100 };
      const proportionalRatio = target / current.actualBytes;
      const next = calculateSecantRetryBitrate(previous, current, target, { codec: 'av1' });
      expect(next / current.bitrate).toBeCloseTo(proportionalRatio ** 4, 6);
      const far = calculateSecantRetryBitrate({ bitrate: 1_000_000, actualBytes: 1_000_000 },
        { bitrate: 1_100_000, actualBytes: 1_000_100 }, target, { codec: 'av1' });
      expect(far).toBe(2_200_000);
    });

    test('never goes below the codec floor', () => {
      const next = calculateSecantRetryBitrate({ bitrate: 260_000, actualBytes: 3_000_000 },
        { bitrate: 250_000, actualBytes: 2_900_000 }, 1_000_000, { codec: 'av1' });
      expect(next).toBe(SAFE_VIDEO_BITRATE_FLOORS.av1);
    });
  });
});
