// The native helper (native/studio-helper) replaces the drive-data.json
// workers and the renderer's SEI parser when it is present. These tests pin:
//  - the binary `drives` output decoding (src/main/studioHelper.js),
//  - the fallback signal (rejection) when the helper is disabled or missing,
//  - when a helper binary has been built (cargo build --release in
//    native/studio-helper, or helper_bin/), exact parity with the JavaScript
//    workers on a synthetic drive-data.json (distances within 1e-12 when the
//    engine's trig is not correctly rounded). Without a binary those tests skip.

const { Worker } = require('worker_threads');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src/main');
const EXE = process.platform === 'win32' ? 'sentry-studio-helper.exe' : 'sentry-studio-helper';

// The helper's haversine uses correctly rounded sin/cos/atan2, as Electron 45's
// V8 does (native/studio-helper/src/crmath.rs). Node 22's V8 does not round
// these inputs correctly, so on such an engine the summed distances may differ
// in the last bit; scripts/parity/drives-helper.cjs checks exactness under
// Electron itself.
const ENGINE_TRIG_CORRECTLY_ROUNDED =
  Math.cos(0.7679856047586157) === 0.7193115036104022 &&
  Math.cos(-0.9504142824414831) === 0.5813460557951421 &&
  Math.atan2(0.0000022973403933738565, 0.9999999999973611) === 0.0000022973403933758775;
const DISTANCE_FIELDS = ['distanceKm', 'distanceMi', 'fsdDistanceKm', 'fsdDistanceMi'];

function freshHelperModule(env = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  let mod;
  jest.isolateModules(() => { mod = require(path.join(SRC, 'studioHelper.js')); });
  return { mod, restore: () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } };
}

function encodeDrives(header, doubles) {
  const json = Buffer.from(JSON.stringify(header));
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(json.length));
  const pts = Buffer.alloc(doubles.length * 8);
  doubles.forEach((d, i) => pts.writeDoubleLE(d, i * 8));
  return Buffer.concat([Buffer.from('SSH1'), len, json, pts]);
}

describe('decodeDrives', () => {
  const { mod } = freshHelperModule();
  const header = {
    driveCount: 2, routeCount: 3, routesLen: 4,
    drives: [{ id: 1, distanceKm: 1.5 }, { id: 2, distanceKm: 0 }],
    fsdEvents: [[{ lat: 1, lng: 2, type: 'disengagement' }], []],
    pointCounts: [2, 0]
  };
  const doubles = [53.5, -113.5, 0, 12.25, 1, 53.6, -113.4, 0, 13, 0];

  test('rebuilds the worker-shaped drives with Float64Array points', () => {
    const out = mod.decodeDrives(encodeDrives(header, doubles));
    expect(out.driveCount).toBe(2);
    expect(out.routeCount).toBe(3);
    expect(out.routesLen).toBe(4);
    expect(out.drives[0]).toEqual({ id: 1, distanceKm: 1.5, fsdEvents: header.fsdEvents[0], pointsBuf: new Float64Array(doubles) });
    expect(out.drives[0].pointsBuf).toBeInstanceOf(Float64Array);
    expect(out.drives[1].pointsBuf.length).toBe(0);
  });

  test('works when the buffer does not start at offset 0 of its ArrayBuffer', () => {
    const inner = encodeDrives(header, doubles);
    const outer = Buffer.concat([Buffer.from([7, 7, 7]), inner]);
    const out = mod.decodeDrives(outer.subarray(3));
    expect(Array.from(out.drives[0].pointsBuf)).toEqual(doubles);
  });

  test('rejects malformed output so the caller falls back', () => {
    const good = encodeDrives(header, doubles);
    expect(() => mod.decodeDrives(Buffer.from('nope'))).toThrow();
    expect(() => mod.decodeDrives(Buffer.concat([Buffer.from('XXXX'), good.subarray(4)]))).toThrow();
    expect(() => mod.decodeDrives(good.subarray(0, good.length - 8))).toThrow(/truncated/);
    expect(() => mod.decodeDrives(encodeDrives({ ...header, pointCounts: [2] }, doubles))).toThrow(/inconsistent/);
  });
});

test('a disabled helper rejects, which sends callers to the JavaScript path', async () => {
  const { mod, restore } = freshHelperModule({ SENTRY_STUDIO_DISABLE_HELPER: '1' });
  try {
    expect(mod.helperPath()).toBeNull();
    await expect(mod.loadDrives('/nonexistent/drive-data.json')).rejects.toThrow(/not available/);
    await expect(mod.extractSei('/nonexistent/clip.mp4')).rejects.toThrow(/not available/);
  } finally {
    restore();
  }
});

// ---- Parity against the JavaScript workers (needs a built helper) ----

const builtHelper = [
  path.join(ROOT, 'native/studio-helper/target/release', EXE),
  path.join(ROOT, 'helper_bin', process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'win' : 'linux', process.arch, EXE)
].find((p) => fs.existsSync(p));
const withHelper = builtHelper ? test : test.skip;

// Deterministic synthetic drive-data.json: three drives separated by long
// gaps, one with a parked stretch, array and object point forms, autopilot
// and accelerator data, and drive tags.
function syntheticDriveData() {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pad = (n) => String(n).padStart(2, '0');
  const routes = [];
  const drives = [
    { day: 3, hour: 8, clips: 6, parkedAt: -1 },
    { day: 3, hour: 17, clips: 9, parkedAt: 4 },
    { day: 4, hour: 12, clips: 4, parkedAt: -1 }
  ];
  let lat = 53.5, lng = -113.5;
  for (const d of drives) {
    for (let c = 0; c < d.clips; c++) {
      const min = c;
      const file = `2026-01-${pad(d.day)}_${pad(d.hour)}-${pad(min)}-00-front.mp4`;
      const n = 30;
      const parked = c === d.parkedAt;
      const points = [], speeds = [], ap = [], gears = [], accel = [];
      for (let i = 0; i < n; i++) {
        if (!parked) { lat += (rnd() - 0.3) * 0.0004; lng += (rnd() - 0.4) * 0.0006; }
        points.push(c % 2 ? { Lat: lat, Lng: lng, Speed: parked ? 0 : 10 + rnd() * 20 } : [lat, lng]);
        speeds.push(parked ? 0 : 8 + rnd() * 25);
        ap.push(parked ? 0 : (i > 10 && i < 20 ? 1 : 0));
        gears.push(parked ? 0 : 1);
        accel.push(parked ? 0 : rnd() * 100);
      }
      routes.push({ File: file, Points: points, Speeds: speeds, AutopilotStates: ap, GearStates: gears, AccelPositions: accel, RawFrameCount: n * 36, RawParkCount: parked ? n * 36 : 0 });
    }
  }
  return { version: 3, Routes: routes, DriveTags: { '2026-01-03_08-00-00': ['Commute'], '2026-01-04_12-00-00': ['Errand'] } };
}

function runJsWorkers(filePath) {
  return new Promise((resolve, reject) => {
    const tags = new Promise((res) => {
      const w = new Worker(path.join(SRC, 'driveTagsWorker.js'), { workerData: { filePath } });
      w.once('message', (m) => { res(m?.ok ? m.driveTags : {}); w.terminate(); });
      w.once('error', () => res({}));
    });
    const worker = new Worker(path.join(SRC, 'driveLoadWorker.js'), { workerData: { filePath } });
    worker.on('message', (msg) => {
      if (msg?.type === 'done') { resolve(msg); worker.terminate(); }
      if (msg?.type === 'error') { reject(new Error(msg.error)); worker.terminate(); }
    });
    worker.once('error', reject);
    tags.then((t) => worker.postMessage({ type: 'driveTags', driveTags: t }));
  });
}

withHelper('native helper groups drives exactly like the JavaScript workers', async () => {
  const file = path.join(os.tmpdir(), `drive-data-helper-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(syntheticDriveData()));
  const { mod, restore } = freshHelperModule({ SENTRY_STUDIO_HELPER: builtHelper, SENTRY_STUDIO_DISABLE_HELPER: undefined });
  try {
    const [native, js] = await Promise.all([mod.loadDrives(file), runJsWorkers(file)]);
    expect(js.drives.length).toBeGreaterThan(1);
    expect([native.driveCount, native.routeCount, native.routesLen]).toEqual([js.driveCount, js.routeCount, js.routesLen]);
    expect(native.drives.length).toBe(js.drives.length);
    for (let i = 0; i < js.drives.length; i++) {
      const { pointsBuf: pa, ...a } = js.drives[i];
      const { pointsBuf: pb, ...b } = native.drives[i];
      if (!ENGINE_TRIG_CORRECTLY_ROUNDED) {
        // The helper matches Electron's V8, whose sin/cos/atan2 are correctly
        // rounded; older V8 (Node 22) is off by an ulp for some inputs.
        for (const k of DISTANCE_FIELDS) {
          expect(Math.abs(b[k] - a[k])).toBeLessThanOrEqual(1e-12 * Math.abs(a[k]));
          b[k] = a[k];
        }
      }
      expect(b).toEqual(a);
      expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
      expect(Array.from(pb)).toEqual(Array.from(pa));
    }
  } finally {
    restore();
    fs.unlinkSync(file);
  }
}, 30000);

withHelper('native helper exits non-zero on unreadable input', async () => {
  const file = path.join(os.tmpdir(), `drive-data-bad-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(file, '{"Routes": [ {"File": 1, ');
  const { mod, restore } = freshHelperModule({ SENTRY_STUDIO_HELPER: builtHelper, SENTRY_STUDIO_DISABLE_HELPER: undefined });
  try {
    await expect(mod.loadDrives(file)).rejects.toThrow();
    await expect(mod.extractSei(file)).rejects.toThrow();
  } finally {
    restore();
    fs.unlinkSync(file);
  }
}, 30000);
