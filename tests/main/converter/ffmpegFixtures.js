'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { injectTeslaTelemetryIntoH264Mp4 } = require('./fixtureBuilders');

function executableName(name) {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

async function locateBundledTools(rootDir = path.resolve(__dirname, '..', '..', '..')) {
  const ffmpegPath = path.join(rootDir, 'ffmpeg_bin', executableName('ffmpeg'));
  const ffprobePath = path.join(rootDir, 'ffmpeg_bin', executableName('ffprobe'));
  const [ffmpeg, ffprobe] = await Promise.all([
    fs.promises.stat(ffmpegPath),
    fs.promises.stat(ffprobePath)
  ]);
  if (!ffmpeg.isFile() || !ffprobe.isFile()) throw new Error('Bundled FFmpeg/FFprobe files are unavailable');
  return Object.freeze({ ffmpegPath, ffprobePath });
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs || 120_000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, timedOut: signal === 'SIGTERM' });
    });
  });
}

function probeRequiredEncodersSync(rootDir = path.resolve(__dirname, '..', '..', '..')) {
  const ffmpegPath = path.join(rootDir, 'ffmpeg_bin', executableName('ffmpeg'));
  const candidates = { h265: ['libx265'], av1: ['libsvtav1', 'libaom-av1'] };
  const selected = {};
  const failures = [];
  for (const [codec, encoders] of Object.entries(candidates)) {
    for (const encoder of encoders) {
      const output = process.platform === 'win32' ? 'NUL' : '/dev/null';
      const result = spawnSync(ffmpegPath, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=duration=0.25:size=64x64:rate=4',
        '-frames:v', '1', '-an', '-c:v', encoder,
        ...(encoder === 'libx265' ? ['-preset', 'ultrafast'] : []),
        ...(encoder === 'libsvtav1' ? ['-preset', '12'] : []),
        ...(encoder === 'libaom-av1' ? ['-cpu-used', '8'] : []),
        '-f', 'mp4', output
      ], { windowsHide: true, encoding: 'utf8', timeout: 30_000 });
      if (result.status === 0) { selected[codec] = encoder; break; }
      failures.push(`${encoder}: ${(result.stderr || result.error?.message || `status ${result.status}`).trim().split(/\r?\n/).at(-1)}`);
    }
  }
  const missing = Object.keys(candidates).filter((codec) => !selected[codec]);
  return Object.freeze({
    available: missing.length === 0,
    selected: Object.freeze(selected),
    reason: missing.length ? `required encoder probe failed for ${missing.join(', ')} (${failures.join('; ')})` : null
  });
}

async function createTeslaH264Fixture({
  ffmpegPath,
  outputPath,
  telemetryPattern,
  durationSeconds = 4,
  frameRate = 12,
  size = '320x180',
  spatialNoise = 0
}) {
  const frameCount = durationSeconds * frameRate;
  if (!Array.isArray(telemetryPattern) || telemetryPattern.length !== frameCount) {
    throw new RangeError(`telemetryPattern must contain ${frameCount} frame entries`);
  }
  const basePath = `${outputPath}.base.mp4`;
  const result = await runProcess(ffmpegPath, [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    // Static spatial noise adds camera-like detail without artificial frame-to-frame entropy.
    '-f', 'lavfi', '-i', `testsrc2=duration=${durationSeconds}:size=${size}:rate=${frameRate}`
      + (spatialNoise ? `,noise=alls=${spatialNoise}:allf=u:all_seed=41` : ''),
    '-frames:v', String(frameCount), '-an',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '1200k', '-minrate', '1200k', '-maxrate', '1200k', '-bufsize', '2400k',
    '-g', String(frameRate), '-bf', '0', '-pix_fmt', 'yuv420p', '-tag:v', 'avc1',
    '-movflags', '+faststart', '-use_editlist', '0', basePath
  ]);
  if (result.status !== 0) throw new Error(`H.264 fixture encode failed: ${result.stderr}`);
  const encoded = await fs.promises.readFile(basePath);
  const patched = injectTeslaTelemetryIntoH264Mp4(encoded, telemetryPattern);
  await fs.promises.writeFile(outputPath, patched);
  await fs.promises.unlink(basePath);
  return Object.freeze({ outputPath, frameCount, durationSeconds, sourceBytes: patched.length });
}

async function probeVideo(ffprobePath, inputPath) {
  const result = await runProcess(ffprobePath, [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=codec_name,codec_tag_string,width,height,duration,nb_read_frames,nb_frames,avg_frame_rate,r_frame_rate:format=duration,size',
    '-of', 'json', inputPath
  ]);
  if (result.status !== 0) throw new Error(`FFprobe failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

async function probeFramePts(ffprobePath, inputPath) {
  const result = await runProcess(ffprobePath, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', inputPath
  ]);
  if (result.status !== 0 || result.timedOut) throw new Error(`Frame PTS probe failed: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  const pts = (parsed.frames || []).map((frame) => Number(frame.best_effort_timestamp_time));
  if (!pts.length || pts.some((value) => !Number.isFinite(value))) throw new Error('Frame PTS probe returned invalid timestamps');
  return pts;
}

async function measureQuality(ffmpegPath, sourcePath, outputPath) {
  const result = await runProcess(ffmpegPath, [
    '-nostdin', '-hide_banner', '-i', sourcePath, '-i', outputPath,
    '-lavfi', '[0:v][1:v]ssim;[0:v][1:v]psnr', '-f', 'null',
    process.platform === 'win32' ? 'NUL' : '/dev/null'
  ]);
  if (result.status !== 0 || result.timedOut) throw new Error(`Quality measurement failed: ${result.stderr}`);
  const ssim = /SSIM[^\r\n]* All:([0-9.]+)/.exec(result.stderr);
  const psnr = /PSNR[^\r\n]* average:([0-9.]+)/.exec(result.stderr);
  const metrics = { ssim: Number(ssim?.[1]), psnr: Number(psnr?.[1]) };
  if (!Number.isFinite(metrics.ssim) || !Number.isFinite(metrics.psnr)) {
    throw new Error(`Quality measurement output was incomplete: ${result.stderr}`);
  }
  return Object.freeze(metrics);
}

async function assertFullDecode(ffmpegPath, inputPath) {
  const result = await runProcess(ffmpegPath, [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', inputPath,
    '-map', '0:v:0', '-f', 'null', process.platform === 'win32' ? 'NUL' : '/dev/null'
  ]);
  if (result.status !== 0) throw new Error(`Full decode failed: ${result.stderr}`);
  return result;
}

module.exports = {
  assertFullDecode,
  createTeslaH264Fixture,
  locateBundledTools,
  measureQuality,
  probeFramePts,
  probeRequiredEncodersSync,
  probeVideo,
  runProcess
};
