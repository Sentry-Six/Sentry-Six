'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
let command;

function validPath(target) {
  return typeof target === 'string' && path.win32.isAbsolute(target) && !target.includes('\0')
    && !target.startsWith('\\\\?\\') && !target.startsWith('\\\\.\\')
    && !target.slice(/^[a-z]:/i.test(target) ? 2 : 0).includes(':')
    && ( /^[a-z]:[\\/]/i.test(target) || /^\\\\[^\\]+\\[^\\]+\\/.test(target));
}

function validExpected(expected) {
  return expected && /^\d+$/.test(expected.device) && /^\d+$/.test(expected.inode)
      && Number.isSafeInteger(expected.size) && expected.size >= 0
      && /^[a-f0-9]{64}$/.test(expected.sha256);
}

function runNative(request) {
  // Read through Electron's asar-aware fs; the child never needs an asar path.
  command ||= Buffer.from(fs.readFileSync(path.join(__dirname, 'windowsOwnedCleanup.ps1'), 'utf8'), 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn(path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', command],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const timeout = setTimeout(() => child.kill(), 60000);
    child.stdout.on('data', (bytes) => { output = (output + bytes).slice(-1024); });
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('close', (exitCode) => {
      clearTimeout(timeout);
      const status = output.trim();
      if (exitCode === 0 && ['removed', 'renamed', 'missing', 'mismatch', 'guard-missing', 'guard-mismatch'].includes(status)) return resolve(status);
      const win32Code = /^failed:(\d+)$/.test(status) ? Number(status.split(':')[1]) : null;
      const code = [80, 183].includes(win32Code) ? 'EEXIST'
        : [1, 50, 87, 120].includes(win32Code) ? 'ENOTSUP'
          : [2, 3].includes(win32Code) ? 'ENOENT'
            : [5, 32, 33].includes(win32Code) ? 'EACCES' : 'EIO';
      reject(Object.assign(new Error('Windows ownership operation failed; inspect transaction state before retrying.'), { code, win32Code }));
    });
    child.stdin.end(JSON.stringify(request), 'utf8');
  });
}

async function removeWindowsOwned({ target, expected, guard } = {}) {
  if (!validPath(target) || !validExpected(expected)
      || (guard !== undefined && (!guard || !validPath(guard.target) || !validExpected(guard.expected)))) {
    return { removed: false, ownershipMismatch: true };
  }
  const status = await runNative({ operation: 'remove', target, expected, guard });
  return status === 'removed' ? { removed: true }
    : status === 'missing' ? { removed: false, missing: true }
      : { removed: false, ownershipMismatch: true, ...(status.startsWith('guard-') ? { guardMismatch: true } : {}) };
}

async function renameWindowsOwned({ from, to, expectedSource } = {}) {
  if (!validPath(from) || !validPath(to)
      || path.win32.dirname(path.win32.resolve(from)).toLowerCase() !== path.win32.dirname(path.win32.resolve(to)).toLowerCase()
      || path.win32.resolve(from).toLowerCase() === path.win32.resolve(to).toLowerCase()) {
    throw Object.assign(new Error('Native promotion requires distinct absolute paths in the same directory without streams.'), { code: 'ENOTSUP' });
  }
  if (!validExpected(expectedSource)) return { atomicNoReplace: true, sourceRemoved: false, ownershipMismatch: true };
  const status = await runNative({ operation: 'rename', target: from, destination: to, expected: expectedSource });
  if (status === 'missing') throw Object.assign(new Error('Source is missing.'), { code: 'ENOENT' });
  return { atomicNoReplace: true, sourceRemoved: status === 'renamed', ...(status === 'mismatch' ? { ownershipMismatch: true } : {}) };
}

module.exports = { removeWindowsOwned, renameWindowsOwned };
