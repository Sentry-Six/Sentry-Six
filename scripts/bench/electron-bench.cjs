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
// - Optional slow share (SENTRY_STUDIO_BENCH_SLOW, see below): every file://
//   read under the footage folder goes through one throttled "link", and the
//   telemetry helper has to pull its clip through the same link before it
//   runs, so playback and telemetry compete the way they do on a slow SMB
//   share. Reads are logged to <out>/electron-slowio.log.
//
// Env: SENTRY_STUDIO_BENCH_OUT (dir), SENTRY_STUDIO_BENCH_CONFIG (JSON file),
// SENTRY_STUDIO_BENCH_SLOW (JSON, optional): { "bps": bytes per second,
// "latencyMs": per request, "helper": "fair" (round-robin with the video
// reads) | "hog" (the helper's read goes first, like one large SMB read that
// takes every credit) }.
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

  // SENTRY_STUDIO_BENCH_SWITCHES: extra Chromium switches, comma-separated,
  // for experiments (e.g. disable-background-media-suspend).
  for (const sw of (process.env.SENTRY_STUDIO_BENCH_SWITCHES || '').split(',').filter(Boolean)) app.commandLine.appendSwitch(sw);

  const slow = process.env.SENTRY_STUDIO_BENCH_SLOW ? JSON.parse(process.env.SENTRY_STUDIO_BENCH_SLOW) : null;
  if (slow) installSlowShare(slow, cfg.folder, path.join(out, 'electron-slowio.log'));

  app.whenReady().then(() => {
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (_d, cb) => cb({ cancel: true })
    );
  });

  app.on('web-contents-created', (_e, wc) => {
    if (wc.getType() !== 'window') return;
    // SENTRY_STUDIO_BENCH_NO_BG_THROTTLE=1: experiment, the same as
    // webPreferences.backgroundThrottling = false.
    if (process.env.SENTRY_STUDIO_BENCH_NO_BG_THROTTLE === '1') wc.setBackgroundThrottling(false);
    wc.on('console-message', (...args) => {
      const e = args[0];
      const message = typeof e?.message === 'string' ? e.message : args[2];
      if (typeof message === 'string' && message.startsWith('__SENTRY_BENCH__')) {
        const json = message.slice('__SENTRY_BENCH__'.length);
        fs.appendFileSync(path.join(out, 'electron-probe.jsonl'), json + '\n');
        // SENTRY_STUDIO_BENCH_HIDE_AT=<phase>: hide the window once the probe
        // reports that phase, the way a window covered by other apps is
        // hidden (document.visibilityState 'hidden').
        const hideAt = process.env.SENTRY_STUDIO_BENCH_HIDE_AT;
        if (hideAt) {
          let phase = null;
          try { phase = JSON.parse(json).phase; } catch { /* partial */ }
          if (phase === hideAt) {
            const { BrowserWindow } = require('electron');
            const win = BrowserWindow.fromWebContents(wc);
            if (win && win.isVisible()) {
              fs.appendFileSync(path.join(out, 'electron-ipc.log'), `${Date.now()} bench: window hidden at ${phase}\n`);
              win.hide();
            }
          }
        }
      }
    });
    wc.on('dom-ready', () => {
      wc.executeJavaScript(`window.__SENTRY_BENCH__ = ${JSON.stringify(cfg)};\n${probe}`).catch(() => {});
    });
  });
}

// One serial link at `bps`: each reader asks for a chunk, waits its turn and
// its transfer time, and only then asks for the next, so concurrent readers
// share the link round-robin. Priority requests ("hog") go first.
function installSlowShare(slow, root, logFile) {
  const fs = require('fs');
  const path = require('path');
  const { app, protocol, net } = require('electron');
  const childProcess = require('child_process');
  const CHUNK = 256 * 1024;
  const bps = slow.bps || 4e6;
  const latencyMs = slow.latencyMs || 0;
  const log = (line) => fs.appendFileSync(logFile, `${Date.now()} ${line}\n`);
  const queue = [];
  let busy = false;
  const pump = () => {
    if (busy || !queue.length) return;
    const i = queue.findIndex((q) => q.prio);
    const job = queue.splice(i >= 0 ? i : 0, 1)[0];
    busy = true;
    setTimeout(() => { busy = false; job.resolve(); pump(); }, (job.n / bps) * 1000);
  };
  const take = (n, prio = false) => new Promise((resolve) => { queue.push({ n, prio, resolve }); pump(); });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const prefix = root.replace(/\/+$/, '') + '/';
  const MIME = { '.mp4': 'video/mp4', '.json': 'application/json', '.png': 'image/png' };
  let nextId = 0;

  // The helper is spawned by src/main/studioHelper.js, which takes `spawn`
  // from child_process when it loads (after this hook). `sei` runs start
  // with stdin held by a shell; the shell execs the real helper once the
  // clip has gone through the link.
  const realSpawn = childProcess.spawn;
  childProcess.spawn = function (cmd, args, opts) {
    if (!/sentry-studio-helper/.test(String(cmd)) || !Array.isArray(args) || args[0] !== 'sei') return realSpawn.apply(this, arguments);
    const file = args[1];
    const id = ++nextId;
    const child = realSpawn('/bin/sh', ['-c', 'read _ ; exec "$0" "$@"', cmd, ...args], { ...opts, stdio: ['pipe', 'pipe', 'pipe'] });
    log(`helper#${id} start ${path.basename(file)} pid=${child.pid} mode=${slow.helper || 'fair'}`);
    (async () => {
      const size = fs.statSync(file).size;
      await sleep(latencyMs);
      for (let pos = 0; pos < size && child.exitCode === null && !child.killed; pos += CHUNK) {
        await take(Math.min(CHUNK, size - pos), slow.helper === 'hog');
      }
      log(`helper#${id} read-done ${size}B`);
      try { child.stdin.end('go\n'); } catch { /* killed */ }
    })().catch((e) => log(`helper#${id} shim error ${e.message}`));
    child.once('close', (code, sig) => log(`helper#${id} exit ${sig || code}`));
    return child;
  };

  app.whenReady().then(() => {
    protocol.handle('file', async (req) => {
      const p = decodeURIComponent(new URL(req.url).pathname);
      if (!p.startsWith(prefix)) return net.fetch(req, { bypassCustomProtocolHandlers: true });
      let st;
      try { st = await fs.promises.stat(p); } catch { return new Response(null, { status: 404 }); }
      if (!st.isFile()) return net.fetch(req, { bypassCustomProtocolHandlers: true });
      const id = ++nextId;
      let start = 0;
      let end = st.size - 1;
      let status = 200;
      const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
      if (m && (m[1] || m[2])) {
        if (m[1]) { start = +m[1]; if (m[2]) end = Math.min(+m[2], end); } else { start = Math.max(0, st.size - +m[2]); }
        if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${st.size}` } });
        status = 206;
      }
      log(`req#${id} ${path.basename(p)} ${start}-${end}`);
      await sleep(latencyMs);
      let pos = start;
      let fh = null;
      let sent = 0;
      const body = new ReadableStream({
        async pull(ctrl) {
          if (!fh) fh = await fs.promises.open(p, 'r');
          if (pos > end) { log(`req#${id} done ${sent}B`); ctrl.close(); await fh.close(); return; }
          const n = Math.min(CHUNK, end - pos + 1);
          await take(n);
          const buf = Buffer.alloc(n);
          const { bytesRead } = await fh.read(buf, 0, n, pos);
          if (!bytesRead) { ctrl.close(); await fh.close(); return; }
          pos += bytesRead;
          sent += bytesRead;
          ctrl.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, bytesRead));
        },
        async cancel() { log(`req#${id} cancel ${sent}B`); if (fh) await fh.close().catch(() => {}); }
      }, { highWaterMark: 0 });
      const headers = { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream',
        'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' };
      if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
      return new Response(body, { status, headers });
    });
  });
}
