# Electron speed-ups: before/after

Branch `claude/electron-speedups` (from `main` at 1b1704b). The four changes
recommended by the Tauri benchmark, made in the Electron app instead. The
decision log, with every measurement behind each change, is in
`docs/electron-speedups-notes.md`.

| # | Change | Result |
|---|---|---|
| 1 | Day switching: a day's folders are listed concurrently, at most 4 at a time | Names-only listing would not help: smbfs already returns file types. The share's directory cache decides listing time (see notes). Concurrent listing gains ~20% on cold folders. The share has one event folder, so the benchmark shows no difference. |
| 2 | drive-data.json through a bundled Rust helper (`sentry-studio-helper`); JS workers as fallback | 1.08 GB file: **69.5 s → 9.2 s**, and **3.8 GB → 0.66 GB** held after loading. Output identical to the JS loader: 0 mismatches in 15.9 M point values and 26,884 fields. |
| 3 | Idle CPU: the G-force dot's SMIL `<animate>` replaced by the same CSS animation | Idle with the window visible: **~4.8% → ~0.3% of a core** |
| 4 | Telemetry (SEI) through the same helper; JS parser as fallback | 17,240 frames, 0 mismatches. Clip already in the file cache: ~72 → ~48 ms. Reading the clip from the share (~650 ms) is unchanged. |

## Benchmark

Unsigned arm64 builds from `electron-builder --mac dir`:
- **before:** `main` at 1b1704b;
- **after:** this branch.

Both run through the same bench hook, with the updater and network calls
off. Setup:
- Machine: Mac14,9 (M2 Pro, 16 GB), macOS 27.2, Electron 45.1.0.
- Footage: Scott's SentryUSB share at `/Volumes/USB` (smbfs, read only).
- Runs: 5 idle and 5 workflow runs per build, alternating which build goes
  first, plus 3 drive-data loads per build.
- Before each workflow run: a 90 s wait, so both builds list cold folders.
- Display kept awake with `caffeinate -d`.

1-minute load average per run: 1.1–4.7. Rounds 1–3 ran while Scott was using
the laptop; rounds 4–5 and the drive loads ran with the machine otherwise idle.
Absolute numbers carry that noise. The before/after ratios are what matter.

| Measure | before (median, min–max) | after (median, min–max) | after vs before |
|---|---|---|---|
| Cold start → first contentful paint (ms) | 557 (500–2,558, n=5) | 537 (480–2,435, n=5) | same |
| Cold start → UI ready (ms) | 634 (557–2,682, n=5) | 597 (546–2,511, n=5) | same |
| Memory, idle 15 s after ready (MB, all processes) | 279 (276–290, n=5) | 276 (274–289, n=5) | same |
| **Idle CPU, window visible all 60 s** (% of one core) | **4.95 (4.74–4.97, n=3)** | **0.30 (0.29–0.32, n=3)** | **16× lower** |
| Idle CPU, window covered (% of one core) | 0.33 (0.31–0.34, n=2) | 0.32 (0.31–0.33, n=2) | same |
| Peak memory during startup+idle (MB) | 412 (403–421, n=5) | 412 (404–420, n=5) | same |
| Open /Volumes/USB → newest day listed (ms) | 375 (265–398, n=5) | 374 (289–461, n=5) | same |
| Switch to a 5,682-file day → clips listed (ms) | 895 (830–1,036, n=5) | 943 (833–1,184, n=5) | same (noise) |
| Switch to a day with a SavedClips event (ms) | 914 (672–1,029, n=5) | 830 (693–2,370, n=5) | same (noise) |
| Open SavedClips event → 6 videos loaded (ms) | 268 (164–1,847, n=5) | 213 (127–1,565, n=5) | same (file cache) |
| Press play → all 6 advancing (ms) | 504 (42–29,543, n=5) | 513 (506–521, n=5) | same; see the playback caveat |
| Telemetry, clip in file cache (ms, median of 3 clips) | 72 (70–74, n=2) | 48 (37–48, n=3) | 1.5× faster |
| Telemetry, clip read from the share (ms, median of 3 clips) | 643 (627–683, n=3) | 672 (659–685, n=2) | same (the read dominates) |
| Export 30 s, 6 cameras, High, VideoToolbox (ms) | 12,451 (12,285–12,530, n=5) | 12,496 (12,332–12,770, n=5) | same |
| Memory after workflow (MB) | 919 (786–1,071, n=5) | 870 (820–965, n=5) | same |
| Peak memory during workflow (MB) | 1,774 (1,724–1,839, n=5) | 1,737 (1,582–1,837, n=5) | same |
| **Load drive-data.json (1.08 GB) → drive list (ms)** | **69,467 (69,368–74,378, n=3)** | **9,243 (9,149–9,258, n=3)** | **7.5× faster** |
| Open largest drive detail (ms) | 2 (2–3, n=3) | 2 (2–2, n=3) | same |
| **Memory after drive-data load (MB)** | **3,844 (3,791–3,916, n=3)** | **664 (663–665, n=3)** | **5.8× lower** |
| Peak memory during drive-data load (MB, all processes incl. helper) | 3,914 (3,809–3,932, n=3) | 2,399 (2,339–2,456, n=3) | 1.6× lower |

How the rows were split:
- **Idle.** Rows are split by whether the window was visible. The probe
  records `visibilityState`. A covered window draws no frames, so the SMIL
  animation costs nothing there. With all 5 runs pooled, the medians are
  4.09% and 0.31%.
  - "Visible" counts runs visible for the whole 60 s window. That includes
    one warm-up launch per build, which used the same settings.
  - Two runs were visible for part of the window: before 4.09% (36 s
    visible), after 0.44% (32 s). They are left out of both rows.
- **Telemetry.** Rows are split by whether the 3 clips were still in the
  macOS file cache from the warm-up read. A drive-data load in between
  evicts them. The cache state differed run to run, so pooled medians would
  compare cache states, not parsers.

Round 1 of the workflow was rerun. In the first attempt both builds took
almost exactly 5.0 s for each day switch. That matches the renderer's 5 s
video-metadata timeouts (`script.js` duration probe and master-video wait),
so the share was momentarily slow. Those two runs are kept in the
benchmark's scratch folder as the record of the stall below.

## Caveats

- **Playback stall: found, and not caused by the helper.** Details in
  "Playback stall" below. In short: Chromium pauses video-only playback
  while the window is hidden or fully covered, Tesla clips have no audio,
  and both stalled runs happened while Scott was using the laptop. `main`
  does exactly the same.
- **Share and file caches.** The share's directory cache and the macOS file
  cache make day-switch, folder-open and event-load times depend on what
  was read in the last minute. The runs alternate which build goes first
  and wait 90 s before every workflow run, but these rows are noisier than
  the others.
- **Windows and Linux helpers are untested here.** The release workflow is
  configured to build them, but they were not built or run here: this is a
  Mac with no cross linkers. The workflow runs `scripts/verify-helper.js` on
  each packaged app. The macOS x86_64 build was checked under Rosetta: its
  output for the whole 1.08 GB file is byte-identical to arm64's.
- **Export still uses the JS parser.** The export paths (`exportVideo.js`,
  `exportBridge.js`) still parse SEI in JavaScript. Moving them is a
  follow-up.
- **The Tauri benchmark's day-switch rows (940 → 40 ms) were a cache-order
  artifact.** The notes explain it. `claude/tauri-port-3c5646` was left
  unchanged, as asked.
- **The bench config stays local.** `scripts/bench/config.usb.json` names
  real clips, so it is gitignored. `scripts/bench/config.example.json`
  shows its shape.

## Playback stall

Twice, the after-build's workflow never reached "all 6 tiles advancing"
within the probe's 60 s limit (one smoke run, and the first attempt at
round 1). Both runs logged `playNative` and "Master video now playing",
then nothing.

**It is not the helper.** In both stalled runs every `sei:extract` call
had returned within 1.7 s of opening the event, before the six videos had
even finished loading (IPC log). No helper process was running during the
60 s the probe waited.

**Slow share, reproduced with a throttle: no stall.** The bench hook can
now serve every file under the footage folder through one throttled link
(`SENTRY_STUDIO_BENCH_SLOW`). The helper has to pull its clip through the
same link before it runs, so playback and telemetry compete for it.
- 3.5 MB/s with 1.5 s per request, below the six cameras' ~4.7 MB/s, 3 runs
  per build: playback started 1.6–2.8 s after the videos loaded in every
  run, for both builds.
- Further single runs on the branch build: 6 MB/s round-robin, 6 MB/s with
  the helper's reads served first, 3 MB/s, and 2.5 s per request. Starting
  playback took at most 1 s once the videos had loaded. With the helper
  first, loading took 37.8 s.

**Hidden window, reproduced: stalls in both builds.** With the window
hidden just before the event is opened (`SENTRY_STUDIO_BENCH_HIDE_AT=dates`):
- `main` 3 of 3 and the branch 3 of 3 never advanced;
- all six tiles play for about 1 s, then each gets a `pause` event that
  Studio did not send;
- they stay paused with the whole clip buffered (0–60.1 s), `readyState` 4
  and `networkState` 1 (idle): no data is missing.

The page is hidden (`document.visibilityState` 'hidden'), and Chromium
pauses video-only players on hidden pages. A window counts as hidden when
other windows cover it completely. Both stalled runs were in the period
when Scott was using the laptop (rounds 1–3), and the probe did not record
window visibility for workflow runs then.

Which setting controls it (branch build, window hidden the same way):
- Chromium's `disable-background-media-suspend` switch: still paused at
  0.77 s and 1.02 s, so that is not the mechanism.
- Electron's background throttling off (`webContents.setBackgroundThrottling(false)`,
  the same as `webPreferences.backgroundThrottling: false`): played normally,
  advancing 0.5 s after the click. The page then stays 'visible' when hidden.

What a user sees: cover Studio's window during playback and it pauses.
The six tiles pause at slightly different moments (0.78 s and 1.01 s in
the trace), so they can be out of sync by a few hundred ms afterwards.
Whether Studio should keep playing while covered is a product decision,
so it is left as a follow-up. Turning background throttling off would do
it, but it also keeps timers and animations running at full rate in a
hidden window, which costs idle CPU.

**Now recorded:**
- In the app, `[PLAYBACK] Paused by the browser while the window is hidden`
  when that happens.
- In the app, `[PLAYBACK] <tile> has waited 10 s for data`, with every
  tile's position, readyState, networkState and buffered range, if a tile
  stays in `waiting`/`stalled` for 10 s while playing. A slow share keeps
  resuming and logs nothing.
- In the app, `[HELPER] sei <clip>: started <time>, finished after <n> ms`
  for every helper run.
- In the bench: a per-tile media-event trace and a per-second snapshot of
  every tile while waiting for playback. Workflow runs record window
  visibility and are flagged `windowHidden`.

All three in-app lines were checked in a packaged build with this branch's
`src/` overlaid (`make-electron-bench-app.cjs … <checkout>`). It played
normally on the slow link (1.5 s after loading). With the window hidden it
logged `[PLAYBACK] Paused by the browser while the window is hidden, at
0.77 s` and the run was flagged `windowHidden`.

**Separate: the start-position reset.** Opening an event at 15 s before
the event (29 s here) is often undone in both builds. Picking the event's
day starts loading that day's first RecentClips segment, and its wait for
the front tile is still pending when the event is opened. Both loads use
the same video elements, so both waits finish together, and the stale
load resets every tile to 0. The traces show it in most runs. It explains
the before-build's 29.5 s run (the probe had recorded 29 s as the start),
not the stalls. It is on its own card.

## Reproducing

```bash
node scripts/prepare-helper.js darwin arm64
```

```bash
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/parity/drives-helper.cjs native/studio-helper/target/release/sentry-studio-helper /Volumes/USB/drive-data.json
```

```bash
scripts/bench/run-electron-ab.sh "<before>/Sentry Studio Bench.app" "<after>/Sentry Studio Bench.app" scripts/bench/config.usb.json <work dir> 5 3 90
```

Playback-stall checks: set `"playbackOnly": true` in a copy of the bench
config (stops after playback, skips the big day), then run one workflow
run with any of these set:
- `SENTRY_STUDIO_BENCH_SLOW='{"bps":3500000,"latencyMs":1500,"helper":"fair"}'`
  for a slow share (`"helper":"hog"` serves the helper's reads first);
- `SENTRY_STUDIO_BENCH_HIDE_AT=dates` to hide the window before the event
  opens;
- `SENTRY_STUDIO_BENCH_NO_BG_THROTTLE=1` or
  `SENTRY_STUDIO_BENCH_SWITCHES=<switch,…>` for experiments.

```bash
SENTRY_STUDIO_BENCH_HIDE_AT=dates node scripts/bench/bench.mjs --app electron --bundle "<app>" --scenario workflow --config <playbackOnly config> --work <dir> --runs 1 --out <result.json>
```

Bench copies of packaged apps come from
`scripts/bench/make-electron-bench-app.cjs`. The before/after table comes
from `node scripts/bench/summarize.mjs <work dir>/results before,after`;
leave out the warm-up files first.
