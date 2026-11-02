'use strict';

// SignPath signs the NSIS installer after electron-builder has written its
// blockmap and latest.yml, and signing changes the file's bytes. Rebuild both
// from the signed installer so electron-updater's size and sha512 checks and
// differential downloads match what is published.
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap');

async function main() {
  const releaseDir = path.resolve(process.argv[2] || 'release');
  const latestPath = path.join(releaseDir, 'latest.yml');
  const latest = yaml.load(fs.readFileSync(latestPath, 'utf8'));
  const installer = path.join(releaseDir, latest.path);
  if (!fs.existsSync(installer)) throw new Error(`Installer named in latest.yml is missing: ${installer}`);

  const { size, sha512 } = await buildBlockMap(installer, 'gzip', `${installer}.blockmap`);
  if (size !== fs.statSync(installer).size) throw new Error('Blockmap size does not match the installer');

  const file = latest.files.find(entry => entry.url === latest.path);
  if (!file) throw new Error(`latest.yml has no files entry for ${latest.path}`);
  file.sha512 = sha512;
  file.size = size;
  latest.sha512 = sha512;
  fs.writeFileSync(latestPath, yaml.dump(latest, { lineWidth: -1 }));
  console.log(`Updated latest.yml and ${path.basename(installer)}.blockmap for the signed installer (${size} bytes)`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
