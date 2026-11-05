# Electron speed-ups: decision log

Branch `claude/electron-speedups`, cut from `main` at 1b1704b. These are the
four improvements recommended in `docs/tauri-benchmark.md` (branch
`claude/tauri-port-3c5646`), made in the Electron app. Machine: Mac14,9
(M2 Pro, 16 GB), macOS 27.2, Electron 45.1.0. Footage: Scott's SentryUSB
share at `/Volumes/USB` (smbfs, read-only throughout).

## 1. Day switching: names-only listing would not help; listings now run concurrently

**Finding: the premise did not hold.** The recommendation assumed that
`fs.promises.readdir(dir, { withFileTypes: true })` was slow on the share
because Node asks for each file's type. That is not what happens:

- smbfs returns each entry's type with the listing (`d_type`). Node's raw
  binding reports `UV_DIRENT_FILE` for all 3,042 entries of a day folder,
  never `UNKNOWN`, so Node never calls `lstat` per entry.
- A plain Rust `std::fs::read_dir` and Node `readdir(withFileTypes)` take the
  same time on the same folder. On a cold folder: Rust 399 ms vs Node 10 ms
  right after (2,525 entries), then Node 557 ms vs Rust 7.5 ms right after
  (3,972 entries). Whichever runs first pays the cost.
- What decides the time is whether macOS still caches that folder's
  listing. One folder listed every 35 s gave 438 → 43 → 429 → 30 → 475 ms,
  alternating whatever the mode (names-only or with types). A cold listing
  costs ~0.1–0.16 ms per entry: a server round trip per page of results.
  A cached one costs tens of ms.

**The Tauri benchmark's day-switch rows were a measurement artifact.** In
`run-all.sh` the Tauri workflow run started ~40 s after the Electron run had
listed the same folders, so Tauri hit the cache and Electron (whose previous
listing was minutes old) did not. The Electron IPC log shows `fs:readDir`
itself taking 946 ms for 2026-10-28. That is the share, not JavaScript. The
same likely applies to "Open /Volumes/USB → newest day listed". The other
rows (drive data, idle CPU, memory, telemetry) are not affected. The
Tauri branch is left as it was, as asked; this note is the correction.

**What was changed instead** (`src/renderer/script.js`,
`gatherFilesForDateElectron`): the day's RecentClips folder and every
Sentry/Saved event folder are now listed concurrently, at most 4 at a time,
instead of one after another. Results are consumed in the original order,
so the file list is identical. On the share, four cold day folders took
2,771 ms one after another and 1,693 ms in parallel. Per entry that is
0.138 → 0.113 ms, about 20%: smbfs mostly serializes enumeration. Days with
many small Sentry event folders should gain more, since each listing is a
round trip. The share has only one event folder, so that could not be
measured on real footage. The before/after benchmark waits 90 s before
every workflow run, so both builds always list cold folders.

Not done: names-only listing (no gain, and it would need a stat per
ambiguous name to keep results identical). Caching day listings across
switches was also left out: a cache keyed on directory mtime could serve
stale lists on file systems that do not update directory mtimes reliably.

## 2. drive-data.json through Rust: a bundled helper program, not a native module

`native/studio-helper` is a small Rust program, `sentry-studio-helper`
(~0.5 MB). It is shipped through electron-builder `extraResources` as
`helper_bin/sentry-studio-helper[.exe]`, the way `ffmpeg_bin` ships.
`src/main/studioHelper.js` runs it, and `sentryUsb:loadAndGroup` tries it
first.

Why a helper program rather than an N-API module:

- **Build and ship.** A plain `cargo build --target …` per platform. No
  napi-rs toolchain and no Node/Electron ABI. Nothing has to be unpacked
  from the asar, and no `electron-rebuild` is needed. The macOS universal
  build works as it does for FFmpeg: the beforePack hook builds the arm64
  and x64 executables, and electron-builder merges them with `lipo` and
  signs the result with the app.
- **Failure isolation.** A crash, panic or out-of-memory in the helper
  ends the helper only. Studio sees a non-zero exit and falls back to the
  JavaScript workers. A native module that crashed would take the Electron
  main process down with it.
- **Memory.** The 1 GB parse runs in a short-lived process. Its peak is
  returned to the system when it exits. Only the grouped drives come back
  to Electron.
- Cost: one process launch per call (a few ms), and the drives are copied
  over a pipe. Per-drive GPS points travel as raw little-endian doubles that
  become `Float64Array`s without parsing, the same shape the worker
  transferred.

**Fallback.** The JavaScript loader runs when any of these happens:
- the helper is missing or `SENTRY_STUDIO_DISABLE_HELPER=1` is set;
- it exits non-zero or times out (15 min);
- its output is malformed.

`sentryUsb:clear` also kills a running helper.

**Exact parity.** The Tauri port matched only within 1e-9 on 828 distance
values. Three causes were found and fixed:
- Rust multiplied `cos·cos·s2·s2` left to right, while JavaScript computes
  `cos·cos·(s2**2)`.
- serde_json's default float parser can be off by one ulp. The
  `float_roundtrip` feature is now enabled.
- **Electron 45's V8 (15.6) returns correctly rounded `Math.sin`, `Math.cos`
  and `Math.atan2`.** Checked against 300-bit mpmath: 0 differences in
  100,000 inputs. No common library does that:
  - the `libm` crate (fdlibm) differs from it in the last bit for 3.6% of
    `cos` and 25% of `atan2` inputs;
  - Apple's libm differs for 4.6% and 1%;
  - Node 22's V8 (12.4) also differs. Its `atan2` is fdlibm, which is why a
    first fdlibm-based attempt passed the synthetic test under Node but left
    741 last-bit differences in summed distances on the real file under
    Electron.

  The helper now has its own correctly rounded versions
  (`native/studio-helper/src/crmath.rs`):
  - double-double arithmetic with Dekker products, so no FMA and the same
    bits on every target;
  - reduction by π/2 in four parts;
  - a table of sin/cos(j/64) generated with mpmath
    (`tools/gen_crmath_tables.py`), then short Taylor series;
  - `atan2` is fdlibm plus one Newton step in double-double.

  Against Electron's V8: 0 differences in 12 million calls, covering
  haversine-shaped inputs, ±200 rad, tiny arguments and `atan2` in all
  quadrants.

  These calls cost ~90 ns each, against ~7 ns for libm. Each segment reuses
  the previous point's `cos(lat)`, so a full 1.08 GB load still takes ~9.5 s.
  The x86_64 build (run under Rosetta) and the arm64 build produce
  byte-identical output for the whole file.

`scripts/parity/drives-helper.cjs` checks exact equality on the real 1.08 GB
file under Electron's own Node (`Object.is`, no tolerance). Both sides then
use Electron's V8 and time-zone data. Result:
- 1,222 drives, 26,884 fields, 15,870,555 point values and 3,181 FSD events;
- **0 mismatches**;
- JS 68.4 s, helper 9.3 s.

`tests/main/studioHelper.test.js` does the same on a synthetic file. Under
an engine whose trig is not correctly rounded, such as Node 22 in CI, it
allows 1e-12 relative on the four distance fields. It detects this with
three probe inputs. Everything else stays exact.

Platforms: macOS universal (aarch64 + x86_64 Apple targets), Windows x64
(MSVC, static CRT so no VC++ redistributable is needed) and Linux x64/arm64.
Linux uses **musl** so the executable is static and runs on any
distribution. A glibc build from `ubuntu-latest` would need glibc ≥ 2.34
at run time. The Linux and Windows builds could not be run here (macOS
only, no cross linkers). The workflow builds them, then
`scripts/verify-helper.js` runs the packaged helper on each platform.

## 3. Idle CPU: an SVG `<animate>` in the hidden dashboard

Diagnosis: idle Studio was launched with remote debugging, then measured.
- No running Web Animations, no `requestAnimationFrame`, no timers; JS
  was 99.9% idle.
- Chromium's metrics showed **1,200 style recalculations per 10 s**, one per
  frame of the 120 Hz display, while 0 frames were painted.
- The DOM had exactly one SMIL element: the G-force dot's
  `<animate attributeName="opacity" … repeatCount="indefinite">` in
  `index.html`.
- SMIL animations tick the document's style system every frame even when
  the element is in a `display: none` subtree (`.dashboard-vis` is hidden
  until a clip plays).

Fix: the same pulse as a CSS keyframe animation on `#gforceDot`:
0.8 → 1 → 0.8 opacity, linear, 1 s. CSS animations don't run for elements
that aren't rendered. Same-conditions check, packaged app, 60 s idle
window:

| | before | after |
|---|---|---|
| Idle CPU, all processes | 2.39% | 0.15% |
| Renderer process | 1.59% | 0.08% |
| GPU process | 0.74% | ~0% |
| Style recalcs / 10 s | 1,200 | 0 |

The ~8% in the earlier benchmark was measured while the machine was busy
(load 3–7), which runs the same work at lower clock speeds. The before/after
benchmark (`docs/electron-speedups.md`) measures both builds under the same
conditions. With the window visible: ~4.8% → ~0.3%. A covered window draws
no frames, so both builds then idle at ~0.3%. The probe records window
visibility so idle runs can be told apart.

## 4. Telemetry (SEI) through the same helper

`sentry-studio-helper sei <clip>` prints `{ seiData, mapPath }` as JSON. A
new IPC call, `sei:extract` (preload `extractSeiNative`), returns that text.
The renderer's `extractSeiFromEntry` parses it with `JSON.parse`, which is
cheaper than structured-cloning thousands of objects. On `{ ok: false }` or
any error it falls through to the existing fetch +
`DashcamMP4.parseFrames` path. The cache, in-flight de-duplication and
abort handling are unchanged.

Parity (`scripts/parity/sei-helper.mjs`, the same 9 clips as the Tauri
check: five consecutive front clips from one drive, its back/left
pillar/right repeater clips, and a SavedClips event):
- 17,240 frames and 275,840 fields compared with `Object.is` through
  property access, the way the renderer reads them, plus every map point:
  **0 mismatches**;
- the helper's objects carry no keys outside the proto;
- `frame_seq_no` is a plain number on both sides.

Scope: the export paths (`exportVideo.js`, `exportBridge.js`) still parse
SEI in JavaScript for dashboard overlays. Moving them is a follow-up.

## Process notes

- `/Volumes/USB` was only read: directory listings, opening clips and
  drive-data.json read-only. All caches, exports and profiles went to the
  session scratchpad.
- Heavy steps (cargo builds, electron-builder, the 1 GB parity, the
  benchmark) were entered in the shared heavy-work schedule and waited for
  the Sentry Drive session's runs.
