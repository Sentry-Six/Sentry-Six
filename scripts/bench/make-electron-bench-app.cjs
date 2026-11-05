#!/usr/bin/env node
// Make a benchmark copy of a packaged Electron Studio .app: same binary and
// same app.asar contents, plus bench/main.cjs as the entry point, which loads
// scripts/bench/electron-bench.cjs (only active when SENTRY_STUDIO_BENCH_OUT is
// set) and then requires the unchanged src/main.js. Packaged Electron ignores
// NODE_OPTIONS=--require, so the hook has to live inside the asar.
//
//   node scripts/bench/make-electron-bench-app.cjs <Sentry Studio.app> <out dir> [checkout]
//
// With a checkout, its src/ replaces the asar's src/, to try renderer or
// main-process changes without a full electron-builder build. Only src/ is
// replaced: changes to dependencies, the helper or ffmpeg need a real build.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const asar = require('@electron/asar');

const [src, outDir, overlay] = process.argv.slice(2);
const dst = path.join(outDir, 'Sentry Studio Bench.app');
fs.rmSync(dst, { recursive: true, force: true });
execFileSync('cp', ['-Rc', src, dst]);
const res = path.join(dst, 'Contents', 'Resources');
const work = path.join(outDir, 'asar-work');
fs.rmSync(work, { recursive: true, force: true });
asar.extractAll(path.join(res, 'app.asar'), work);
if (overlay) {
  fs.rmSync(path.join(work, 'src'), { recursive: true, force: true });
  fs.cpSync(path.join(overlay, 'src'), path.join(work, 'src'), { recursive: true });
}
fs.mkdirSync(path.join(work, 'bench'), { recursive: true });
for (const f of ['electron-bench.cjs', 'probe.js']) fs.copyFileSync(path.join(__dirname, f), path.join(work, 'bench', f));
fs.writeFileSync(path.join(work, 'bench', 'main.cjs'),
  "'use strict';\nrequire('./electron-bench.cjs');\nrequire('../src/main.js');\n");
const pkg = JSON.parse(fs.readFileSync(path.join(work, 'package.json'), 'utf8'));
pkg.main = 'bench/main.cjs';
fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify(pkg, null, 2));
const unpacked = path.join(res, 'app.asar.unpacked');
(async () => {
  await asar.createPackageWithOptions(work, path.join(res, 'app.asar'), { unpack: '**/node_modules/node-machine-id/**' });
  fs.rmSync(work, { recursive: true, force: true });
  console.log('bench app:', dst, fs.existsSync(unpacked) ? '(unpacked dir kept)' : '');
})();
