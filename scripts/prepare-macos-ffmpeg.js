'use strict';

// electron-builder beforePack hook. Keep downloads pinned and out of Git; the
// per-architecture resources are merged into universal executables by builder.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const manifest = require('../ffmpeg_bin/macos-manifest.json');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function prepare(arch) {
  const entries = manifest.architectures[arch];
  if (!entries) throw new Error(`Unsupported macOS FFmpeg architecture: ${arch}`);
  const destination = path.join(__dirname, '..', 'ffmpeg_bin', 'macos', arch);
  fs.mkdirSync(destination, { recursive: true });
  for (const [tool, entry] of Object.entries(entries)) {
    const target = path.join(destination, tool);
    if (!fs.existsSync(target) || sha256(target) !== entry.binarySha256) {
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ffmpeg-download-'));
      try {
        console.log(`[FFmpeg] Downloading ${manifest.version} ${arch} ${tool}`);
        const response = await fetch(entry.url, { signal: AbortSignal.timeout(180000) });
        if (!response.ok) throw new Error(`FFmpeg download failed: HTTP ${response.status}`);
        const archive = path.join(temporary, `${tool}.zip`);
        await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(archive));
        if (sha256(archive) !== entry.sha256) throw new Error(`FFmpeg archive checksum mismatch: ${arch}/${tool}`);
        const extracted = path.join(temporary, 'extracted');
        execFileSync('/usr/bin/ditto', ['-x', '-k', archive, extracted]);
        const binary = path.join(extracted, tool);
        if (sha256(binary) !== entry.binarySha256) throw new Error(`FFmpeg binary checksum mismatch: ${arch}/${tool}`);
        fs.copyFileSync(binary, target);
      } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
      }
    }
    fs.chmodSync(target, 0o755);
    const actual = execFileSync('/usr/bin/lipo', ['-archs', target], { encoding: 'utf8' }).trim();
    const expected = arch === 'x64' ? 'x86_64' : 'arm64';
    if (actual !== expected) throw new Error(`Wrong FFmpeg architecture: ${actual}; expected ${expected}`);
    const linked = execFileSync('/usr/bin/otool', ['-L', target], { encoding: 'utf8' });
    const dependencies = linked.split('\n').slice(1).map(line => line.trim().split(' ')[0]).filter(Boolean);
    if (dependencies.some(dependency => !dependency.startsWith('/usr/lib/') && !dependency.startsWith('/System/Library/'))) {
      throw new Error(`FFmpeg has non-system dynamic dependencies: ${target}`);
    }
  }
  return destination;
}

module.exports = async context => {
  if (context.electronPlatformName !== 'darwin') return;
  const { Arch } = require('builder-util');
  await prepare(Arch[context.arch]);
};
module.exports.prepare = prepare;

if (require.main === module) {
  prepare(process.argv[2] || process.arch).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
