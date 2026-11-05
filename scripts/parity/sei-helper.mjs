#!/usr/bin/env node
// SEI telemetry parity: the native helper (`sentry-studio-helper sei`, parsed
// with JSON.parse exactly as seiExtractor.js does) against the renderer's own
// JavaScript extractor (seiExtractor.js + dashcam-mp4.js + the vendored
// protobuf.js). Clips are opened read-only.
//
//   node scripts/parity/sei-helper.mjs <helper-binary> <clip.mp4>...
//
// For every frame: timestampMs, and every SeiMetadata field read the way the
// renderer reads it (property access, so protobuf defaults count), compared
// with Object.is; the native objects must not carry keys outside the proto.
// The map path is compared key by key. Prints a JSON summary; exits non-zero
// on any mismatch.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

register('./renderer-esm-hooks.mjs', import.meta.url);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const [bin, ...files] = process.argv.slice(2);
if (!bin || files.length === 0) {
  console.error('usage: sei-helper.mjs <helper-binary> <clip.mp4>...');
  process.exit(2);
}

globalThis.window = globalThis;
globalThis.self = globalThis;
for (const rel of ['src/renderer/vendor/protobuf.min.js', 'src/renderer/scripts/data/dashcam-mp4.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(root, rel), 'utf8'), { filename: rel });
}
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).endsWith('dashcam.proto')) {
    const text = fs.readFileSync(path.join(root, 'src/renderer/proto/dashcam.proto'), 'utf8');
    return { ok: true, text: async () => text };
  }
  return realFetch(url);
};
const { extractSeiFromEntry } = await import(pathToFileURL(path.join(root, 'src/renderer/scripts/core/seiExtractor.js')).href);
const { SeiMetadata } = await globalThis.DashcamHelpers.initProtobuf();
const FIELDS = SeiMetadata.fieldsArray.map((f) => f.name);

const same = (a, b) => Object.is(a, b);
const summary = { helper: bin, files: files.length, frames: 0, fieldsCompared: 0, mapPoints: 0, valueTypes: {}, mismatches: [], jsMs: 0, helperMs: 0 };
for (const file of files) {
  const buf = fs.readFileSync(file);
  const t = performance.now();
  const js = await extractSeiFromEntry({ file: new File([buf], path.basename(file)) }, 'parity');
  summary.jsMs += performance.now() - t;
  const t1 = performance.now();
  const native = JSON.parse(execFileSync(bin, ['sei', file], { encoding: 'utf8', maxBuffer: 1 << 30 }));
  summary.helperMs += performance.now() - t1;

  if (js.seiData.length !== native.seiData.length || js.mapPath.length !== native.mapPath.length) {
    summary.mismatches.push({ file, js: [js.seiData.length, js.mapPath.length], native: [native.seiData.length, native.mapPath.length] });
    continue;
  }
  for (let i = 0; i < js.seiData.length; i++) {
    const a = js.seiData[i], b = native.seiData[i];
    summary.frames++;
    if (!same(a.timestampMs, b.timestampMs)) summary.mismatches.push({ file, i, field: 'timestampMs', js: a.timestampMs, native: b.timestampMs });
    for (const k of FIELDS) {
      summary.fieldsCompared++;
      const jv = a.sei[k], nv = b.sei[k];
      summary.valueTypes[k] ||= `${typeof jv}/${typeof nv}`;
      if (!same(jv, nv)) summary.mismatches.push({ file, i, field: k, js: String(jv), native: nv });
    }
    for (const k of Object.keys(b.sei)) if (!FIELDS.includes(k)) summary.mismatches.push({ file, i, extraKey: k });
    if (Object.keys(b).join() !== 'timestampMs,sei') summary.mismatches.push({ file, i, sampleKeys: Object.keys(b) });
  }
  for (let i = 0; i < js.mapPath.length; i++) {
    const a = js.mapPath[i], b = native.mapPath[i];
    summary.mapPoints++;
    if (Object.keys(a).join() !== Object.keys(b).join()) summary.mismatches.push({ file, i, mapKeys: [Object.keys(a), Object.keys(b)] });
    for (const k of Object.keys(a)) {
      if (!same(a[k], b[k])) summary.mismatches.push({ file, i, field: `mapPath.${k}`, js: a[k], native: b[k] });
    }
  }
}
summary.jsMs = Math.round(summary.jsMs);
summary.helperMs = Math.round(summary.helperMs);
summary.mismatchCount = summary.mismatches.length;
summary.mismatches = summary.mismatches.slice(0, 20);
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.mismatchCount ? 1 : 0);
