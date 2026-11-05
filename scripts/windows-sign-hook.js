'use strict';

// electron-builder custom Windows sign hook, used only by the SignPath release
// workflow (passed with -c.win.signtoolOptions.sign). electron-builder calls it
// for every file it would sign; it signs nothing itself. SignPath signs through
// GitHub artifacts, which can't happen in the middle of an electron-builder run,
// so the NSIS uninstaller is handled in two installer builds:
//
//   capture  copy the freshly built uninstaller to STUDIO_UNINSTALLER_PATH, so it
//            can go to SignPath in the same request as the app files.
//   replace  overwrite the freshly built uninstaller with the signed copy at
//            STUDIO_UNINSTALLER_PATH before NSIS embeds it in the installer.
//
// Both builds use the same NSIS script and inputs, so the uninstaller from the
// first build is equivalent to the one the second build would embed.
// Every other file (the app exe, the installer) is signed by separate workflow
// steps and is left untouched here.
const fs = require('fs');
const path = require('path');

function isUninstaller(file) {
  return /__uninstaller\.exe$/i.test(path.basename(file));
}

module.exports = async function sign(configuration) {
  const file = configuration && configuration.path;
  const mode = process.env.STUDIO_UNINSTALLER_SIGN_MODE;
  if (!file || !mode || !isUninstaller(file)) return;

  const target = path.resolve(process.env.STUDIO_UNINSTALLER_PATH || '');
  if (!process.env.STUDIO_UNINSTALLER_PATH) throw new Error('STUDIO_UNINSTALLER_PATH is not set');

  if (mode === 'capture') {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
    console.log(`[sign-hook] captured uninstaller for signing: ${target}`);
  } else if (mode === 'replace') {
    if (!fs.existsSync(target)) throw new Error(`Signed uninstaller not found: ${target}`);
    fs.copyFileSync(target, file);
    console.log(`[sign-hook] embedded signed uninstaller from ${target}`);
  } else {
    throw new Error(`Unknown STUDIO_UNINSTALLER_SIGN_MODE: ${mode}`);
  }
};

module.exports.isUninstaller = isUninstaller;
