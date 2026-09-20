// Tests for GPU encoder detection caching in src/main/ffmpeg.js
//
// The expensive part of detection is the spawnSync probe battery
// (ffmpeg -encoders + per-codec test encodes). The result must be
// cached whether a GPU encoder was found or NOT found — machines
// without GPUs must not re-run the probes on every export/check.

jest.mock('child_process');

const fs = require('fs');

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

describe('findFFprobePath', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('prefers a working ffprobe executable beside a resolved bundled FFmpeg path', () => {
    const bundledFfmpeg = process.platform === 'win32'
      ? 'C:\\Program Files\\Sentry Studio\\ffmpeg_bin\\ffmpeg.exe'
      : '/opt/Sentry Studio/ffmpeg_bin/ffmpeg';
    const bundledFfprobe = process.platform === 'win32'
      ? 'C:\\Program Files\\Sentry Studio\\ffmpeg_bin\\ffprobe.exe'
      : '/opt/Sentry Studio/ffmpeg_bin/ffprobe';
    jest.spyOn(fs, 'existsSync').mockImplementation((candidate) => candidate === bundledFfprobe);
    const { ffmpeg, spawnSync } = loadFfmpegModule({ status: 0, stdout: 'ffprobe version test' });

    expect(ffmpeg.findFFprobePath(bundledFfmpeg)).toBe(bundledFfprobe);
    expect(spawnSync).toHaveBeenCalledWith(
      bundledFfprobe,
      ['-version'],
      expect.objectContaining({ shell: false, windowsHide: true })
    );
  });

  test('falls back to ffprobe on PATH when the sibling executable is absent', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    const { ffmpeg, spawnSync } = loadFfmpegModule({ status: 0, stdout: 'ffprobe version test' });

    expect(ffmpeg.findFFprobePath('C:\\bundled\\ffmpeg.exe')).toBe('ffprobe');
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync).toHaveBeenCalledWith(
      'ffprobe',
      ['-version'],
      expect.objectContaining({ shell: false, windowsHide: true })
    );
  });

  test('returns null when neither sibling nor PATH ffprobe completes its version probe', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    const { ffmpeg } = loadFfmpegModule({ status: 1, stderr: 'not found' });

    expect(ffmpeg.findFFprobePath('/bundle/ffmpeg')).toBeNull();
  });
});
