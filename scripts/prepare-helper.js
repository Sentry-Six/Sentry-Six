'use strict';

// Builds the native helper (native/studio-helper) for one platform/arch into
// helper_bin/<macos|win|linux>/<arch>/, where electron-builder's
// extraResources pick it up (the same layout as ffmpeg_bin).
//
//   node scripts/prepare-helper.js [platform] [arch]   (defaults: this machine)
//
// Also called from the beforePack hook for every packaged platform/arch, so
// a macOS universal build compiles both the arm64 and the x64 binary and
// electron-builder merges them into one universal executable, as it does
// for FFmpeg.
//
// The helper is optional at runtime: Studio falls back to its JavaScript
// loaders without it. So when Rust is not installed the hook only warns,
// unless SENTRY_STUDIO_REQUIRE_HELPER=1 (set by the release workflow), which
// makes a missing toolchain or a failed build fail the package.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CRATE = path.join(ROOT, 'native', 'studio-helper');

// Linux uses musl so the helper is a static executable that runs on any
// distribution, whatever glibc the build machine had.
const TARGETS = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl'
};

function platformDir(platform) {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'win';
  return 'linux';
}

function exeName(platform) {
  return platform === 'win32' ? 'sentry-studio-helper.exe' : 'sentry-studio-helper';
}

function helperDestination(platform, arch) {
  return path.join(ROOT, 'helper_bin', platformDir(platform), arch, exeName(platform));
}

function hasCargo() {
  try {
    execFileSync('cargo', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function build(platform, arch) {
  const target = TARGETS[`${platform}-${arch}`];
  if (!target) throw new Error(`No native helper target for ${platform}-${arch}`);
  const required = process.env.SENTRY_STUDIO_REQUIRE_HELPER === '1';
  const destination = helperDestination(platform, arch);

  if (!hasCargo()) {
    const message = `[Helper] Rust (cargo) not found; packaging without the native helper for ${platform}-${arch}. ` +
      'Studio will use its JavaScript loaders. Install Rust from https://rustup.rs to include it.';
    if (required) throw new Error(message);
    console.warn(message);
    return null;
  }

  console.log(`[Helper] Building ${target}`);
  try {
    execFileSync('cargo', [
      'build', '--release', '--locked',
      '--manifest-path', path.join(CRATE, 'Cargo.toml'),
      '--target', target
    ], { cwd: CRATE, stdio: 'inherit' }); // cwd: so cargo reads native/studio-helper/.cargo/config.toml
  } catch (err) {
    if (required) throw err;
    console.warn(`[Helper] Build failed for ${target}; packaging without the native helper: ${err.message}`);
    return null;
  }

  const built = path.join(CRATE, 'target', target, 'release', exeName(platform));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(built, destination);
  if (platform !== 'win32') fs.chmodSync(destination, 0o755);
  console.log(`[Helper] ${destination}`);
  return destination;
}

// electron-builder beforePack hook.
async function beforePack(context) {
  const { Arch } = require('builder-util');
  const arch = Arch[context.arch];
  // A universal macOS app is packed as x64 + arm64 (each gets this hook)
  // and merged afterwards; there is no separate universal binary to build.
  if (arch === 'universal') return null;
  return build(context.electronPlatformName, arch);
}

module.exports = beforePack;
module.exports.build = build;
module.exports.helperDestination = helperDestination;

if (require.main === module) {
  const [platform = process.platform, arch = process.arch] = process.argv.slice(2);
  build(platform, arch);
}
