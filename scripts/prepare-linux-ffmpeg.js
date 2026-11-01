'use strict';

// Fetches the pinned Linux FFmpeg build into the ignored ffmpeg_bin/linux/{arch}/
// and verifies the archive and both executables against linux-manifest.json.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const manifest = require('../ffmpeg_bin/linux-manifest.json');

function sha256(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(1 << 20);
  try {
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

async function prepare(arch) {
  const entry = manifest.architectures[arch];
  if (!entry) throw new Error(`Unsupported Linux FFmpeg architecture: ${arch}`);
  const destination = path.join(__dirname, '..', 'ffmpeg_bin', 'linux', arch);
  const ready = Object.entries(entry.binaries)
    .every(([tool, hash]) => fs.existsSync(path.join(destination, tool)) && sha256(path.join(destination, tool)) === hash);
  if (!ready) {
    fs.mkdirSync(destination, { recursive: true });
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ffmpeg-download-'));
    try {
      console.log(`[FFmpeg] Downloading ${manifest.version} linux ${arch}`);
      const response = await fetch(entry.url, { signal: AbortSignal.timeout(600000) });
      if (!response.ok) throw new Error(`FFmpeg download failed: HTTP ${response.status}`);
      const archive = path.join(temporary, 'ffmpeg.tar.xz');
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(archive));
      if (sha256(archive) !== entry.sha256) throw new Error(`FFmpeg archive checksum mismatch: linux/${arch}`);
      const members = Object.keys(entry.binaries).map(tool => `${entry.directory}/bin/${tool}`);
      execFileSync('tar', ['-xJf', archive, '-C', temporary, ...members]);
      for (const [tool, hash] of Object.entries(entry.binaries)) {
        const binary = path.join(temporary, entry.directory, 'bin', tool);
        if (sha256(binary) !== hash) throw new Error(`FFmpeg binary checksum mismatch: linux/${arch}/${tool}`);
        fs.copyFileSync(binary, path.join(destination, tool));
      }
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  for (const tool of Object.keys(entry.binaries)) fs.chmodSync(path.join(destination, tool), 0o755);
  return destination;
}

module.exports = async context => {
  if (context.electronPlatformName !== 'linux') return;
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
