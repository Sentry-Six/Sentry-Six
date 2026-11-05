#!/usr/bin/env node
// drive-data.json parity: the native helper (through src/main/studioHelper.js,
// exactly the objects main.js caches) against Studio's JavaScript loader
// (driveTagsWorker.js + driveLoadWorker.js -> driveGrouper.js, wired the way
// main.js wires them). The JSON file is only read.
//
// Run it with Electron's own Node so both sides use Electron's time-zone data,
// as they do inside Studio:
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
//     scripts/parity/drives-helper.cjs <helper-binary> <drive-data.json>
//
// Every drive is compared exactly (Object.is, no tolerance): the same keys,
// every light value (arrays element by element), every pointsBuf double and
// every FSD event, plus driveCount / routeCount / routesLen.
'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

const root = path.resolve(__dirname, '..', '..');
const [bin, filePath] = process.argv.slice(2);
if (!bin || !filePath) {
  console.error('usage: drives-helper.cjs <helper-binary> <drive-data.json>');
  process.exit(2);
}
process.env.SENTRY_STUDIO_HELPER = path.resolve(bin);
const studioHelper = require(path.join(root, 'src/main/studioHelper.js'));

function runJs() {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tags = new Promise((res) => {
      const w = new Worker(path.join(root, 'src/main/driveTagsWorker.js'), { workerData: { filePath } });
      w.once('message', (m) => res(m?.ok ? m.driveTags : {}));
      w.once('error', () => res({}));
    });
    const worker = new Worker(path.join(root, 'src/main/driveLoadWorker.js'), { workerData: { filePath } });
    worker.on('message', (msg) => {
      if (msg?.type === 'done') { resolve({ ...msg, ms: Date.now() - t0 }); worker.terminate(); }
      if (msg?.type === 'error') reject(new Error(msg.error));
    });
    worker.on('error', reject);
    tags.then((t) => worker.postMessage({ type: 'driveTags', driveTags: t }));
  });
}

function deepSame(a, b) {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepSame(x, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(b)) {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepSame(a[k], b[k]));
  }
  return false;
}

(async () => {
  const t0 = Date.now();
  const native = await studioHelper.loadDrives(filePath);
  const nativeMs = Date.now() - t0;
  const js = await runJs();

  const summary = {
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    tzdata: process.versions.tz,
    runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`,
    jsMs: js.ms, nativeMs,
    counts: {
      js: [js.driveCount, js.routeCount, js.routesLen],
      native: [native.driveCount, native.routeCount, native.routesLen]
    },
    drives: js.drives.length, fieldsCompared: 0, pointValues: 0, fsdEvents: 0, mismatches: []
  };
  if (!deepSame(summary.counts.js, summary.counts.native)) summary.mismatches.push({ counts: summary.counts });
  if (js.drives.length !== native.drives.length) summary.mismatches.push({ driveArray: [js.drives.length, native.drives.length] });

  for (let i = 0; i < Math.min(js.drives.length, native.drives.length); i++) {
    const a = js.drives[i], b = native.drives[i];
    const keysA = Object.keys(a).sort(), keysB = Object.keys(b).sort();
    if (keysA.join() !== keysB.join()) summary.mismatches.push({ drive: a.id, keys: { js: keysA, native: keysB } });
    for (const k of keysA) {
      if (k === 'pointsBuf' || k === 'fsdEvents') continue;
      summary.fieldsCompared++;
      if (!deepSame(a[k], b[k])) summary.mismatches.push({ drive: a.id, field: k, js: a[k], native: b[k] });
    }
    const pa = a.pointsBuf, pb = b.pointsBuf;
    if (!(pb instanceof Float64Array) || pa.length !== pb.length) {
      summary.mismatches.push({ drive: a.id, field: 'pointsBuf.length', js: pa.length, native: pb?.length });
    } else {
      for (let j = 0; j < pa.length; j++) {
        summary.pointValues++;
        if (!Object.is(pa[j], pb[j])) summary.mismatches.push({ drive: a.id, point: j, js: pa[j], native: pb[j] });
      }
    }
    summary.fsdEvents += (a.fsdEvents || []).length;
    if (!deepSame(a.fsdEvents, b.fsdEvents)) summary.mismatches.push({ drive: a.id, field: 'fsdEvents', js: a.fsdEvents?.length, native: b.fsdEvents?.length });
  }
  summary.mismatchCount = summary.mismatches.length;
  summary.mismatchesByField = {};
  for (const m of summary.mismatches) {
    const f = m.field || (m.point !== undefined ? 'pointsBuf' : Object.keys(m).find((k) => k !== 'drive'));
    summary.mismatchesByField[f] = (summary.mismatchesByField[f] || 0) + 1;
  }
  summary.mismatches = summary.mismatches.slice(0, 25);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.mismatchCount ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
