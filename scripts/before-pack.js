'use strict';

// electron-builder beforePack hook: bundled FFmpeg (each platform's script
// returns early for the others) and the native helper for this platform/arch.
const prepareFfmpeg = require('./prepare-ffmpeg');
const prepareHelper = require('./prepare-helper');

module.exports = async context => {
  await prepareFfmpeg(context);
  await prepareHelper(context);
};
