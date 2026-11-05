#!/usr/bin/env node
// Before/after benchmark driver for the Electron and Tauri builds of Sentry Studio.
//
//   node scripts/bench/bench.mjs --app electron|tauri --bundle <.app> --scenario idle|workflow|drives \
//        --config <bench-config.json> --work <dir> --runs 5 --out <results.json> [--label before|after]
//
// Every run launches the app binary directly with a fresh, pre-seeded
// profile (privacy accepted, welcome guide done, API requests off), and the
// app fully quits between runs. The in-page probe (probe.js) reports phases;
// this driver measures, on the same epoch clock:
//   fcp / uiReady   launch -> first contentful paint / UI wired up
//   memory          footprint of every attributed process (procstat.py)
//   idle CPU        CPU time of every attributed process over 60 s
//   workflow        folder open, date switches, event load + synced playback,
//                   telemetry extraction, a 6-camera export (probe timings)
//   drives          drive-data.json load + largest drive detail, memory after
// Load average is recorded before each run.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETTLE_MS = 15000;
const CPU_WINDOW_MS = 60000;

function args() {
  const a = process.argv.slice(2);
  const o = {};
  for (let i = 0; i < a.length; i += 2) o[a[i].replace(/^--/, '')] = a[i + 1];
  for (const k of ['app', 'bundle', 'scenario', 'config', 'work', 'out']) if (!o[k]) throw new Error(`--${k} required`);
  o.runs = Number(o.runs ?? 5);
  o.label = o.label || o.app;
  return o;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let SINCE = 0;
const procstat = (pid) => JSON.parse(execFileSync('python3', ['-I', path.join(HERE, 'procstat.py'), String(pid), '--since', String(SINCE)], { encoding: 'utf8' }));
function binaryOf(bundle) {
  const exe = execFileSync('plutil', ['-extract', 'CFBundleExecutable', 'raw', path.join(bundle, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
  return path.join(bundle, 'Contents', 'MacOS', exe);
}
function readPhases(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
async function waitPhase(file, phases, timeoutMs, child) {
  const start = Date.now();
  for (;;) {
    const hit = readPhases(file).find((r) => phases.includes(r.phase));
    if (hit) return hit;
    if (child.exitCode !== null) throw new Error('app exited early: ' + child.exitCode);
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for ' + phases.join('|'));
    await sleep(100);
  }
}

const SEED_SETTINGS = {
  acceptedPrivacyVersion: 3, firstRunComplete: true, welcomeGuideCompleted: true,
  devDisableApiRequests: true
};

async function oneRun(o, bin, cfgPath, cfg, runIdx) {
  const runDir = path.join(o.work, `${o.app}-${o.scenario}-${runIdx}`);
  fs.rmSync(runDir, { recursive: true, force: true });
  const userData = path.join(runDir, 'userData');
  fs.mkdirSync(path.join(runDir, 'tmp'), { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(SEED_SETTINGS, null, 2));
  const probeFile = path.join(runDir, o.app === 'tauri' ? 'tauri-probe.jsonl' : 'electron-probe.jsonl');

  const env = { SENTRY_STUDIO_BENCH_OUT: runDir, SENTRY_STUDIO_BENCH_CONFIG: cfgPath, TMPDIR: path.join(runDir, 'tmp') + '/' };
  const argv = [];
  if (o.app === 'electron') {
    // The hook is inside the bench app's asar (make-electron-bench-app.cjs).
    argv.push(`--user-data-dir=${userData}`);
  } else {
    env.SENTRY_STUDIO_USER_DATA = userData;
    env.SENTRY_STUDIO_TMP = path.join(runDir, 'tmp');
  }
  const load = os.loadavg();
  // Launched as a child of this driver, not through LaunchServices: a
  // LaunchServices launch makes the app its own "responsible process", and
  // its first read of the SMB share then waits on a macOS privacy prompt
  // that only Scott may answer. As a child it inherits the terminal's
  // existing permission; procstat.py --since picks up its WebKit services.
  const logFile = path.join(runDir, 'stdout.log');
  const logFd = fs.openSync(logFile, 'w');
  const launchAt = Date.now();
  const proc = spawn(bin, argv, { env: { ...process.env, ...env }, stdio: ['ignore', logFd, logFd] });
  const pid = proc.pid;
  SINCE = Math.floor(launchAt / 1000);
  const alive = () => proc.exitCode === null && proc.signalCode === null;
  const child = { pid, get exitCode() { return alive() ? null : (proc.exitCode ?? 0); }, signalCode: null };
  const stderr = () => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } };

  // Sample footprint every second for the peak.
  let peak = 0;
  const sampler = setInterval(() => {
    try { peak = Math.max(peak, procstat(child.pid).footprint); } catch { /* starting/exiting */ }
  }, 1000);

  const result = { run: runIdx, loadavg: load.map((x) => +x.toFixed(2)) };
  try {
    const ready = await waitPhase(probeFile, ['ready', 'error'], 120000, child);
    if (ready.phase === 'error') throw new Error(ready.error);
    result.fcpMs = ready.marks.fcp ? Math.round(ready.marks.fcp - launchAt) : null;
    result.uiReadyMs = ready.marks.uiReady - launchAt;
    if (o.scenario === 'idle') {
      await sleep(SETTLE_MS);
      const s0 = procstat(child.pid);
      result.memoryMB = +(s0.footprint / 1048576).toFixed(1);
      result.processes = s0.procs.map((p) => `${p.name}:${(p.footprint / 1048576).toFixed(0)}`);
      await sleep(CPU_WINDOW_MS);
      const s1 = procstat(child.pid);
      result.idleCpuPct = +(((s1.cpu_ns - s0.cpu_ns) / (CPU_WINDOW_MS * 1e6)) * 100).toFixed(2);
      // Was the window visible? A covered window draws no frames (probe.js).
      const reports = readPhases(probeFile).filter((r) => r.visibility);
      if (reports.length) result.visibility = reports[reports.length - 1].visibility;
    } else {
      // playbackOnly (stall reproduction): stop once playback advances.
      const want = o.scenario === 'drives' ? ['drivesLoaded', 'error'] : [cfg.playbackOnly ? 'playback' : 'export', 'error'];
      const done = await waitPhase(probeFile, want, 30 * 60000, child);
      if (done.phase === 'error') result.error = done.error;
      Object.assign(result, Object.fromEntries(Object.entries(done).filter(([k]) =>
        ['folderOpen', 'dateBig', 'dateEvent', 'eventLoaded', 'playback', 'telemetry', 'export', 'driveLoad', 'driveDetail',
          'playStarts', 'playSamples', 'mediaTrace', 'visibility'].includes(k))));
      // A hidden or fully covered window pauses video-only playback
      // (Chromium's background media suspend), so such runs are flagged.
      if (done.visibility?.atReady === 'hidden' || done.visibility?.changes?.some(([, v]) => v === 'hidden')) result.windowHidden = true;
      await sleep(5000);
      const s = procstat(child.pid);
      result.memoryAfterMB = +(s.footprint / 1048576).toFixed(1);
      result.processesAfter = s.procs.map((p) => `${p.name}:${(p.footprint / 1048576).toFixed(0)}`);
    }
  } catch (e) {
    result.error = String(e.message || e);
    result.stderrTail = stderr().slice(-800);
  } finally {
    clearInterval(sampler);
    result.peakMemoryMB = +(peak / 1048576).toFixed(1);
    try { proc.kill('SIGTERM'); } catch { /* gone */ }
    const t = Date.now();
    while (alive() && Date.now() - t < 10000) await sleep(100);
    if (alive()) { try { proc.kill('SIGKILL'); } catch { /* gone */ } }
    await sleep(3000); // let helper/XPC processes wind down
  }
  return result;
}

const o = args();
const bin = binaryOf(path.resolve(o.bundle));
const cfg = JSON.parse(fs.readFileSync(o.config, 'utf8'));
cfg.scenario = o.scenario;
fs.mkdirSync(o.work, { recursive: true });
const cfgPath = path.join(o.work, `config-${o.app}-${o.scenario}.json`);
fs.writeFileSync(cfgPath, JSON.stringify(cfg));
const runs = [];
for (let i = 1; i <= o.runs; i++) {
  if (cfg.exportData) cfg.exportData.outputPath = path.join(o.work, `${o.app}-${o.scenario}-${i}`, 'export.mp4');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const r = await oneRun(o, bin, cfgPath, cfg, i);
  console.error(`[${o.app} ${o.scenario} ${i}/${o.runs}]`, JSON.stringify(r));
  runs.push(r);
}
fs.writeFileSync(o.out, JSON.stringify({ app: o.app, label: o.label, scenario: o.scenario, bundle: o.bundle, host: os.hostname(), cpus: os.cpus()[0]?.model, runs }, null, 2));
