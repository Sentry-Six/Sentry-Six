'use strict';

// Checks the native helper inside a packaged app: it is present, it runs,
// and on macOS it is a universal (arm64 + x86_64) executable.
//
//   node scripts/verify-helper.js <app resources dir> [--universal]
//   e.g. node scripts/verify-helper.js "release/mac-universal/Sentry Studio.app/Contents/Resources" --universal
//        node scripts/verify-helper.js release/win-unpacked/resources

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const [resources, flag] = process.argv.slice(2);
if (!resources) {
  console.error('usage: verify-helper.js <app resources dir> [--universal]');
  process.exit(2);
}
const exe = path.join(resources, 'helper_bin', process.platform === 'win32' ? 'sentry-studio-helper.exe' : 'sentry-studio-helper');
if (!fs.existsSync(exe)) throw new Error(`Native helper missing: ${exe}`);

const version = execFileSync(exe, ['version'], { encoding: 'utf8' }).trim();
const cargo = fs.readFileSync(path.join(__dirname, '..', 'native', 'studio-helper', 'Cargo.toml'), 'utf8');
const expected = /^version\s*=\s*"([^"]+)"/m.exec(cargo)[1];
if (version !== expected) throw new Error(`Native helper reports ${version}; expected ${expected}`);

if (flag === '--universal') {
  const archs = execFileSync('/usr/bin/lipo', ['-archs', exe], { encoding: 'utf8' }).trim().split(/\s+/).sort();
  if (archs.join(' ') !== 'arm64 x86_64') throw new Error(`Native helper is not universal: ${archs.join(' ')}`);
}

// A malformed input must make it exit non-zero (Studio's fallback signal).
let failed = false;
try {
  execFileSync(exe, ['drives', path.join(resources, 'does-not-exist.json')], { stdio: 'ignore' });
} catch {
  failed = true;
}
if (!failed) throw new Error('Native helper did not fail on a missing file');

console.log(`[Helper] OK: ${exe} (${version}${flag === '--universal' ? ', universal' : ''})`);
