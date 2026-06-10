// Tests for GPU encoder detection caching in src/main/ffmpeg.js
//
// The expensive part of detection is the spawnSync probe battery
// (ffmpeg -encoders + per-codec test encodes). The result must be
// cached whether a GPU encoder was found or NOT found — machines
// without GPUs must not re-run the probes on every export/check.

jest.mock('child_process');

/**
 * Fresh require of the module so its internal cache state is reset.
 * Returns the module plus the spawnSync mock instance it captured.
 */
function loadFfmpegModule(spawnSyncResult) {
  jest.resetModules();
  const cp = require('child_process');
  cp.spawnSync.mockReset();
  cp.spawnSync.mockReturnValue(spawnSyncResult);
  const ffmpeg = require('../../src/main/ffmpeg');
  return { ffmpeg, spawnSync: cp.spawnSync };
}

describe('detectGpuEncoder caching', () => {
  test('caches a negative result (no usable GPU) and does not re-probe', () => {
    // `ffmpeg -encoders` output contains none of the known GPU codecs,
    // so detection concludes "no GPU encoder" without per-codec tests.
    const { ffmpeg, spawnSync } = loadFfmpegModule(
      { status: 0, stdout: 'V..... libx264  H.264 (codec h264)' }
    );

    const first = ffmpeg.detectGpuEncoder('ffmpeg');
    expect(first).toBeNull();
    const callsAfterFirst = spawnSync.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = ffmpeg.detectGpuEncoder('ffmpeg');
    expect(second).toBeNull();
    expect(spawnSync.mock.calls.length).toBe(callsAfterFirst);
  });

  test('caches a positive result and does not re-probe', () => {
    const codec = process.platform === 'darwin' ? 'h264_videotoolbox' : 'h264_nvenc';
    // -encoders lists the codec; the help probe and the test encode succeed.
    const { ffmpeg, spawnSync } = loadFfmpegModule(
      { status: 0, stdout: `V..... ${codec}` }
    );

    const first = ffmpeg.detectGpuEncoder('ffmpeg');
    expect(first).not.toBeNull();
    expect(first.codec).toBe(codec);
    const callsAfterFirst = spawnSync.mock.calls.length;

    const second = ffmpeg.detectGpuEncoder('ffmpeg');
    expect(second).toBe(first);
    expect(spawnSync.mock.calls.length).toBe(callsAfterFirst);
  });
});

describe('detectHEVCEncoder caching', () => {
  test('caches a negative result (no usable HEVC encoder) and does not re-probe', () => {
    const { ffmpeg, spawnSync } = loadFfmpegModule(
      { status: 0, stdout: 'V..... libx264  H.264 (codec h264)' }
    );

    const first = ffmpeg.detectHEVCEncoder('ffmpeg');
    expect(first).toBeNull();
    const callsAfterFirst = spawnSync.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = ffmpeg.detectHEVCEncoder('ffmpeg');
    expect(second).toBeNull();
    expect(spawnSync.mock.calls.length).toBe(callsAfterFirst);
  });
});
