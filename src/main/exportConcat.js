'use strict';

const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');

// The concat demuxer requires every file to use the same time base. FFmpeg
// can choose different MP4 timescales for independently encoded VFR clips.
async function prepareConcatFiles(files, { ffmpegPath, ffprobePath, run, tempFiles, isCancelled = () => false }) {
  const checkCancelled = () => { if (isCancelled()) throw new Error('Export cancelled'); };
  const bases = [];
  for (const file of files) {
    checkCancelled();
    const result = await run(ffprobePath, ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=time_base', '-of', 'json', file]);
    const base = JSON.parse(result).streams?.[0]?.time_base;
    if (!/^1\/[1-9]\d*$/.test(base || '')) throw new Error('Cannot determine export input time base');
    bases.push(base);
  }
  if (new Set(bases).size <= 1) return files;
  const prepared = [];
  for (const file of files) {
    checkCancelled();
    const target = path.join(os.tmpdir(), `sentry-export-timing-${randomUUID()}.mp4`);
    tempFiles.push(target);
    // Stream copy changes container timing only; it does not re-encode video.
    await run(ffmpegPath, ['-v', 'error', '-n', '-i', file, '-map', '0:v:0',
      '-c:v', 'copy', '-an', '-video_track_timescale', '1000000', target]);
    checkCancelled();
    prepared.push(target);
  }
  return prepared;
}

function concatFileList(files) {
  return files.map(file => `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n');
}

module.exports = { prepareConcatFiles, concatFileList };
