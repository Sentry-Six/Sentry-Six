// Benchmark hook for the packaged Electron build, loaded into the main
// process with NODE_OPTIONS=--require <this file> before src/main.js runs.
// Studio's own code is not modified.
//
// - Network off: every http(s)/ws(s) request from the session is cancelled,
//   and the IPC handlers that would call production services (updates, clip
//   sharing, AI support, diagnostics upload, reverse geocoding) are replaced
//   with the same "nothing to do" answers the Tauri preview gives.
// - dialog:openFolder / dialog:saveFile answer from the bench config instead
//   of showing a dialog.
// - The probe (scripts/bench/probe.js) is injected on dom-ready; its reports
//   arrive as console messages and are appended to <out>/electron-probe.jsonl.
//
// Env: SENTRY_STUDIO_BENCH_OUT (dir), SENTRY_STUDIO_BENCH_CONFIG (JSON file).
'use strict';
if (process.type === 'browser' && process.env.SENTRY_STUDIO_BENCH_OUT) {
  const fs = require('fs');
  const path = require('path');
  const { app, ipcMain, session } = require('electron');
  const out = process.env.SENTRY_STUDIO_BENCH_OUT;
  const cfg = JSON.parse(fs.readFileSync(process.env.SENTRY_STUDIO_BENCH_CONFIG, 'utf8'));
  const probe = fs.readFileSync(path.join(__dirname, 'probe.js'), 'utf8');
  fs.mkdirSync(out, { recursive: true });
  const PREVIEW_ONLY = 'disabled for benchmark';

  const overrides = {
    'dialog:openFolder': async () => cfg.folder,
    'dialog:saveFile': async (_e, o) => path.join(out, path.basename(o?.defaultPath || 'export.mp4')),
    'update:check': async () => ({ updateAvailable: false }),
    'update:getChangelog': async () => ({ versions: [] }),
    'update:install': async () => ({ success: false, error: PREVIEW_ONLY }),
    'update:installAndRestart': async () => ({ success: false, error: PREVIEW_ONLY }),
    'dev:checkPrerelease': async () => ({ success: false, error: PREVIEW_ONLY }),
    'dev:installPrerelease': async () => ({ success: false, error: PREVIEW_ONLY }),
    'share:getConfig': async () => ({ enabled: false }),
    'share:reserve': async () => ({ success: false, error: PREVIEW_ONLY }),
    'share:upload': async () => ({ success: false, error: PREVIEW_ONLY }),
    'share:getClips': async () => [],
    'share:syncClips': async () => [],
    'share:deleteClip': async () => ({ success: false, error: PREVIEW_ONLY }),
    'geo:reverseGeocode': async () => ({ label: null }),
    'shell:openExternal': async () => {},
    'diagnostics:upload': async () => ({ success: false, error: PREVIEW_ONLY }),
    'aiSupport:createConversation': async () => ({ success: false, error: PREVIEW_ONLY }),
    'aiSupport:fetchMessages': async () => ({ success: false, error: PREVIEW_ONLY }),
    'aiSupport:sendMessage': async () => ({ success: false, error: PREVIEW_ONLY }),
    'aiSupport:deleteConversation': async () => ({ success: false, error: PREVIEW_ONLY }),
    'aiSupport:decideFileRequest': async () => ({ success: false, error: PREVIEW_ONLY }),
    'aiSupport:uploadDiagnostics': async () => ({ success: false, error: PREVIEW_ONLY })
  };
  const realHandle = ipcMain.handle.bind(ipcMain);
  const ipcLog = path.join(out, 'electron-ipc.log');
  ipcMain.handle = (channel, fn) => realHandle(channel, async (...a) => {
    const t = Date.now();
    fs.appendFileSync(ipcLog, `${t} > ${channel} ${JSON.stringify(a.slice(1)).slice(0, 160)}\n`);
    try { return await (overrides[channel] || fn)(...a); }
    finally { fs.appendFileSync(ipcLog, `${Date.now()} < ${channel} ${Date.now() - t}ms\n`); }
  });

  app.whenReady().then(() => {
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (_d, cb) => cb({ cancel: true })
    );
  });

  app.on('web-contents-created', (_e, wc) => {
    if (wc.getType() !== 'window') return;
    wc.on('console-message', (...args) => {
      const e = args[0];
      const message = typeof e?.message === 'string' ? e.message : args[2];
      if (typeof message === 'string' && message.startsWith('__SENTRY_BENCH__')) {
        fs.appendFileSync(path.join(out, 'electron-probe.jsonl'), message.slice('__SENTRY_BENCH__'.length) + '\n');
      }
    });
    wc.on('dom-ready', () => {
      wc.executeJavaScript(`window.__SENTRY_BENCH__ = ${JSON.stringify(cfg)};\n${probe}`).catch(() => {});
    });
  });
}
