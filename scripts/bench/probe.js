// Benchmark probe evaluated inside the Sentry Studio page. The same source
// runs in both builds: Electron gets it from scripts/bench/electron-bench.cjs
// (executeJavaScript on dom-ready), the Tauri build injects it from its
// initialization script when SENTRY_STUDIO_BENCH_OUT is set.
//
// It drives the real UI where the UI is the thing being measured (folder
// button, date picker, clip list, play button) and calls the same
// window.electronAPI methods the UI calls for the rest. Every timestamp is
// epoch ms (Date.now()), the same clock the driver uses for launch time.
//
// window.__SENTRY_BENCH__ = { scenario: 'idle'|'workflow'|'drives', folder, file, ... }
(function () {
  if (window.__benchStarted) return;
  window.__benchStarted = true;
  const B = window.__SENTRY_BENCH__ || {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const safe = (fn) => { try { return fn(); } catch { return false; } };
  async function waitFor(cond, timeoutMs = 600000, label = 'condition') {
    const start = Date.now();
    while (!safe(cond)) {
      if (Date.now() - start > timeoutMs) {
        const st = safe(() => ({ overlayHidden: overlayHidden(), loadingText: document.getElementById('loadingText')?.textContent,
          items: document.querySelectorAll('#clipList .clip-item').length, day: document.getElementById('dayFilter')?.value,
          dates: document.getElementById('dayFilter')?.options.length, subtitle: document.getElementById('clipBrowserSubtitle')?.textContent,
          // Every video tile, so a stalled playback says which tile and why.
          tiles: ['videoTL', 'videoTC', 'videoTR', 'videoBL', 'videoBC', 'videoBR'].map((id) => {
            const v = document.getElementById(id);
            return v && v.currentSrc ? { id, src: v.currentSrc.split('/').pop(), paused: v.paused, t: Math.round(v.currentTime * 100) / 100,
              ready: v.readyState, net: v.networkState, err: v.error && v.error.code, ended: v.ended, rate: v.playbackRate } : { id };
          }) }));
        throw new Error('bench wait timed out: ' + label + ' ' + JSON.stringify(st));
      }
      await sleep(20);
    }
    return Date.now();
  }
  const R = window.__benchResults = { scenario: B.scenario, runtime: window.__TAURI__ ? 'tauri' : 'electron', marks: {}, logs: [] };
  // Keep page errors (bounded) so a stalled run says why.
  const keep = (kind, args) => {
    if (R.logs.length >= 60) R.logs.shift();
    R.logs.push(kind + ': ' + Array.from(args).map((a) => (a && a.stack) || (typeof a === 'object' ? safe(() => JSON.stringify(a)) || String(a) : String(a))).join(' ').slice(0, 400));
  };
  for (const k of ['error', 'warn', 'log']) {
    const orig = console[k].bind(console);
    console[k] = (...a) => { keep(k, a); orig(...a); };
  }
  window.addEventListener('error', (e) => keep('onerror', [e.message, e.filename + ':' + e.lineno]));
  window.addEventListener('unhandledrejection', (e) => keep('rejection', [e.reason]));
  function report(phase) {
    R.phase = phase;
    R.reportedAt = Date.now();
    try {
      if (window.__TAURI__) window.__TAURI__.core.invoke('bench_report', { results: R });
      else console.log('__SENTRY_BENCH__' + JSON.stringify(R));
    } catch (e) { /* ignore */ }
  }
  const $ = (id) => document.getElementById(id);
  const overlayHidden = () => {
    const o = $('loadingOverlay');
    return !o || o.classList.contains('hidden') || getComputedStyle(o).display === 'none';
  };
  const uiReady = () => typeof $('chooseFolderBtn')?.onclick === 'function' && !!$('clipBrowserSubtitle')?.textContent;
  const items = () => Array.from(document.querySelectorAll('#clipList .clip-item'));
  const firstPaint = () => {
    const e = performance.getEntriesByType('paint').find((p) => p.name === 'first-contentful-paint');
    return e ? performance.timeOrigin + e.startTime : null;
  };
  const api = () => window.electronAPI;

  async function selectDate(date) {
    const sel = $('dayFilter');
    await waitFor(() => Array.from(sel.options).some((o) => o.value === date), 120000, 'date option ' + date);
    const t0 = Date.now();
    sel.value = date;
    const p = sel.onchange ? sel.onchange() : sel.dispatchEvent(new Event('change'));
    await p;
    await waitFor(() => overlayHidden() && items().length > 0 && items().some((i) => (i.dataset.groupid || '').includes(date)), 600000, 'clips for ' + date);
    return { ms: Date.now() - t0, items: items().length, subtitle: $('clipBrowserSubtitle')?.textContent };
  }

  async function telemetry(path) {
    const t0 = Date.now();
    let n = 0;
    let via = 'js';
    // Electron with the native helper: the same calls seiExtractor.js makes
    // (extractSeiNative, then JSON.parse; { ok: false } falls through to JS).
    const native = api().extractSeiNative ? await api().extractSeiNative(path) : null;
    if (native?.ok) {
      n = JSON.parse(native.json).seiData.length;
      via = 'native';
    } else if (api().extractSei) {
      const r = await api().extractSei(path);
      n = r.seiData.length;
      via = 'tauri';
    } else {
      // Electron renderer path (seiExtractor.js extractSeiFromBuffer)
      const url = 'file://' + encodeURI(path).replace(/#/g, '%23').replace(/\?/g, '%3F');
      const buf = await (await fetch(url)).arrayBuffer();
      const { SeiMetadata } = await window.DashcamHelpers.initProtobuf();
      const frames = new window.DashcamMP4(buf).parseFrames(SeiMetadata);
      const seiData = [];
      for (const f of frames) if (f.sei) seiData.push({ timestampMs: f.timestamp, sei: f.sei });
      seiData.sort((a, b) => a.timestampMs - b.timestampMs);
      n = seiData.length;
    }
    return { ms: Date.now() - t0, frames: n, via };
  }

  function exportOnce(id, data) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const onProgress = (eid, p) => {
        if (eid !== id || p?.type !== 'complete') return;
        api().off('export:progress', onProgress);
        resolve({ ms: Date.now() - t0, success: !!p.success, message: p.message });
      };
      api().on('export:progress', onProgress);
      api().startExport(id, data).catch((e) => resolve({ ms: Date.now() - t0, success: false, message: String(e) }));
    });
  }

  async function run() {
    try {
      R.timeOrigin = performance.timeOrigin;
      R.marks.uiReady = await waitFor(uiReady, 120000, 'ui ready');
      R.marks.fcp = firstPaint();
      // Which tz rules does the page's engine use? (Alberta: permanent UTC-6 from 2026-11-01 in tzdata 2026f)
      R.tz = { zone: Intl.DateTimeFormat().resolvedOptions().timeZone, offsetNov2_2026: new Date(2026, 10, 2, 12).getTimezoneOffset() };
      // A fully covered window stops producing frames on macOS, which hides
      // per-frame costs (e.g. SMIL animations) from the idle measurement.
      // Record visibility so idle runs can be told apart.
      R.visibility = { atReady: document.visibilityState, changes: [] };
      document.addEventListener('visibilitychange', () => {
        R.visibility.changes.push([Date.now(), document.visibilityState]);
        report('visibility');
      });
      report('ready');
      if (B.scenario === 'idle') return;
      await sleep(B.settleMs ?? 5000);

      if (B.scenario === 'drives') {
        const t0 = Date.now();
        const res = await api().loadSentryUsbDrives(B.file);
        R.driveLoad = { ms: Date.now() - t0, success: !!res?.success, drives: res?.driveCount, routes: res?.routeCount };
        const biggest = (res?.drives || []).reduce((a, d) => (!a || d.pointCount > a.pointCount ? d : a), null);
        if (biggest) {
          const t1 = Date.now();
          const det = await api().getSentryUsbDriveDetail(biggest.id);
          R.driveDetail = { ms: Date.now() - t1, points: det?.points?.length, id: biggest.id };
        }
        report('drivesLoaded');
        return;
      }

      // ---- workflow ----
      const t0 = Date.now();
      $('chooseFolderBtn').click();
      await waitFor(() => overlayHidden() && items().length > 0 && $('dayFilter').value, 600000, 'folder open');
      R.folderOpen = { ms: Date.now() - t0, items: items().length, dates: $('dayFilter').options.length - 1, firstDate: $('dayFilter').value, subtitle: $('clipBrowserSubtitle')?.textContent };
      report('folderOpen');

      R.dateBig = await selectDate(B.bigDate);
      R.dateEvent = await selectDate(B.eventDate);
      report('dates');

      // Open the SavedClips event and start synced playback
      const tiles = () => ['videoTL', 'videoTC', 'videoTR', 'videoBL', 'videoBC', 'videoBR'].map($).filter((v) => v && v.currentSrc);
      const ev = items().find((i) => (i.dataset.groupid || '').includes(B.eventId));
      const t2 = Date.now();
      ev.click();
      await waitFor(() => tiles().length >= 6 && tiles().every((v) => v.readyState >= 2), 120000, 'event videos loaded');
      R.eventLoaded = { ms: Date.now() - t2, videos: tiles().length };
      const starts = tiles().map((v) => v.currentTime);
      const t3 = Date.now();
      if (tiles().every((v) => v.paused)) $('playBtn').click();
      await waitFor(() => tiles().every((v, i) => !v.paused && v.currentTime > starts[i] + 0.5), 60000, 'playback advancing');
      R.playback = { ms: Date.now() - t3, sinceClick: Date.now() - t2 };
      await sleep(2000);
      const vs = tiles();
      const times = vs.map((v) => v.currentTime);
      R.playback.syncSpreadMs = Math.round((Math.max(...times) - Math.min(...times)) * 1000);
      $('playBtn').click(); // pause
      report('playback');

      R.telemetry = [];
      for (const p of B.seiFiles || []) R.telemetry.push(await telemetry(p));
      report('telemetry');

      R.export = await exportOnce('bench-' + Date.now(), B.exportData);
      report('export');
    } catch (e) {
      R.error = String(e && e.message || e);
      report('error');
    }
  }
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', run);
  else run();
})();
