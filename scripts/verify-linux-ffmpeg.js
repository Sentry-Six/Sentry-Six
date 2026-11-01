'use strict';

// Run against the unpacked Linux app before uploading release assets.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const appPath = process.argv[2];
if (!appPath) throw new Error('Usage: node scripts/verify-linux-ffmpeg.js release/linux-unpacked');
const directory = path.join(appPath, 'resources', 'ffmpeg_bin');
const ffmpeg = path.join(directory, 'ffmpeg');
const ffprobe = path.join(directory, 'ffprobe');
const run = (tool, args, options = {}) => execFileSync(tool, args, {
  encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024, ...options
});
if (!fs.existsSync(path.join(directory, 'COPYING.GPLv3.txt'))) throw new Error('Missing COPYING.GPLv3.txt');
for (const tool of [ffmpeg, ffprobe]) console.log(run(tool, ['-version']).split('\n')[0]);
const filters = run(ffmpeg, ['-hide_banner', '-filters']);
for (const filter of ['drawtext', 'ass', 'xstack', 'overlay', 'gblur', 'alphamerge']) {
  if (!new RegExp(`\\s${filter}\\s`).test(filters)) throw new Error(`Missing required FFmpeg filter: ${filter}`);
}
const encoders = run(ffmpeg, ['-hide_banner', '-encoders']);
for (const encoder of ['libx264', 'libx265', 'hevc_vaapi', 'hevc_qsv', 'hevc_nvenc']) {
  if (!new RegExp(`\\s${encoder}\\s`).test(encoders)) throw new Error(`Missing FFmpeg encoder: ${encoder}`);
}
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-timestamp-smoke-'));
try {
  const output = path.join(temporary, 'timestamp.mp4');
  const timestamp = "drawtext=font='Arial':expansion=strftime:basetime=1792813020410000:text='%m/%d/%Y %H\\:%M\\:%S':fontcolor=white:fontsize=36:box=1:boxcolor=black@0.4:boxborderw=5:x=w-text_w-20:y=20";
  run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=960x540:r=36:d=1',
    '-vf', timestamp, '-c:v', 'libx264', '-preset', 'ultrafast', '-fps_mode', 'cfr', '-r', '36', output]);
  const metadata = JSON.parse(run(ffprobe, ['-v', 'error', '-show_entries', 'stream=width,height,nb_frames', '-of', 'json', output]));
  if (metadata.streams[0]?.nb_frames !== '36') throw new Error('Timestamp export did not contain 36 frames');
  const pixels = run(ffmpeg, ['-v', 'error', '-i', output, '-frames:v', '1', '-vf', 'crop=960:100:0:0,format=gray',
    '-f', 'rawvideo', '-'], { encoding: 'buffer' });
  if (pixels.filter(value => value > 180).length < 100) throw new Error('Timestamp text was not rendered');
  console.log('PASS: bundled FFmpeg/FFprobe, GPL text, required filters and encoders, and visible timestamp export');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
