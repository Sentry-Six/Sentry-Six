'use strict';

// electron-builder beforePack hook: each platform's script returns early for
// the others, so both can run for every build.
const macos = require('./prepare-macos-ffmpeg');
const linux = require('./prepare-linux-ffmpeg');

module.exports = async context => {
  await macos(context);
  await linux(context);
};
