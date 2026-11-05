'use strict';

// Runs the bundled native helper (native/studio-helper, shipped like
// ffmpeg_bin as an extra resource) for the two CPU-heavy parsing jobs:
//
//   loadDrives(file)  drive-data.json -> grouped drives, the same objects
//                     driveLoadWorker.js produces (light fields + fsdEvents +
//                     pointsBuf Float64Array)
//   extractSei(file)  clip.mp4 -> JSON text of { seiData, mapPath }, the same
//                     result as extractSeiFromBuffer in the renderer
//
// Every caller keeps its JavaScript implementation as the fallback: when the
// helper is missing, disabled (SENTRY_STUDIO_DISABLE_HELPER=1), exits non-zero,
// times out or prints something unexpected, these functions reject and the
// caller runs the old code path instead.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const EXE = process.platform === 'win32' ? 'sentry-studio-helper.exe' : 'sentry-studio-helper';
const DRIVES_MAGIC = 'SSH1';
const POINT_STRIDE = 5;

let cachedPath; // undefined = not looked up yet, null = not found
const running = new Set();

function platformDir() {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'win';
  return 'linux';
}

function candidatePaths() {
  const paths = [];
  if (process.env.SENTRY_STUDIO_HELPER) paths.push(process.env.SENTRY_STUDIO_HELPER);
  let isPackaged = false;
  try { isPackaged = require('electron').app?.isPackaged === true; } catch { /* plain Node (tests) */ }
  if (isPackaged && process.resourcesPath) {
    paths.push(path.join(process.resourcesPath, 'helper_bin', EXE));
  }
  const root = path.join(__dirname, '..', '..');
  paths.push(path.join(root, 'helper_bin', platformDir(), process.arch, EXE));
  paths.push(path.join(root, 'native', 'studio-helper', 'target', 'release', EXE));
  return paths;
}

function findHelper() {
  if (process.env.SENTRY_STUDIO_DISABLE_HELPER === '1') return null;
  if (cachedPath !== undefined) return cachedPath;
  cachedPath = null;
  for (const p of candidatePaths()) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      cachedPath = p;
      break;
    } catch { /* try the next one */ }
  }
  return cachedPath;
}

function run(args, { timeoutMs }) {
  const exe = findHelper();
  if (!exe) return Promise.reject(new Error('native helper not available'));
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    running.add(child);
    const out = [];
    let err = '';
    let killedReason = null;
    const timer = setTimeout(() => {
      killedReason = `timed out after ${timeoutMs} ms`;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => { if (err.length < 4096) err += chunk; });
    child.once('error', (e) => {
      clearTimeout(timer);
      running.delete(child);
      reject(e);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      running.delete(child);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(killedReason || err.trim() || `helper exited with ${signal || code}`));
    });
  });
}

// Decode the `drives` output: "SSH1", u64 LE JSON length, JSON header, then
// every drive's points as little-endian doubles, back to back.
function decodeDrives(buf) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== DRIVES_MAGIC) {
    throw new Error('unexpected helper output');
  }
  const jsonLen = Number(buf.readBigUInt64LE(4));
  const start = 12 + jsonLen;
  if (start > buf.length) throw new Error('truncated helper output');
  const header = JSON.parse(buf.toString('utf8', 12, start));
  const { drives, fsdEvents, pointCounts } = header;
  if (!Array.isArray(drives) || drives.length !== pointCounts?.length || drives.length !== fsdEvents?.length) {
    throw new Error('inconsistent helper output');
  }
  const totalDoubles = pointCounts.reduce((a, n) => a + n * POINT_STRIDE, 0);
  if (buf.length !== start + totalDoubles * 8) throw new Error('truncated helper points');
  let off = buf.byteOffset + start;
  const out = drives.map((light, i) => {
    const bytes = pointCounts[i] * POINT_STRIDE * 8;
    // slice() copies into a fresh, 8-byte aligned ArrayBuffer per drive, the
    // same shape driveLoadWorker.js transfers.
    const pointsBuf = new Float64Array(buf.buffer.slice(off, off + bytes));
    off += bytes;
    return { ...light, fsdEvents: fsdEvents[i], pointsBuf };
  });
  return {
    drives: out,
    driveCount: header.driveCount,
    routeCount: header.routeCount,
    routesLen: header.routesLen
  };
}

async function loadDrives(filePath, { timeoutMs = 15 * 60 * 1000 } = {}) {
  return decodeDrives(await run(['drives', filePath], { timeoutMs }));
}

// Returns the JSON text; the renderer parses it (cheaper than structured-
// cloning thousands of telemetry objects across IPC).
async function extractSei(filePath, { timeoutMs = 60 * 1000 } = {}) {
  const buf = await run(['sei', filePath], { timeoutMs });
  const text = buf.toString('utf8');
  if (!text.startsWith('{')) throw new Error('unexpected helper output');
  return text;
}

function cancelAll() {
  for (const child of running) {
    try { child.kill(); } catch { /* already gone */ }
  }
  running.clear();
}

function helperPath() {
  return findHelper();
}

module.exports = { loadDrives, extractSei, cancelAll, helperPath, decodeDrives };
