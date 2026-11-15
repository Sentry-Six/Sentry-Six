# Building and developing Sentry Studio

You need [Rust](https://rustup.rs) 1.88 or newer.

```bash
cargo build --release
```

`target/release/sentry-studio` opens your default folder, or a folder given
on the command line. On Linux, video decoding also needs GStreamer (see
Install in the [README](../README.md)).

## Packaging

| System | Command | Output in `target/` | Needs |
| --- | --- | --- | --- |
| macOS | `tools/package-macos.sh` | `macos/`: universal .app, .dmg, .zip and `latest-mac.yml` | Rust targets `aarch64-apple-darwin` and `x86_64-apple-darwin` |
| Windows | `tools/package-windows.sh` | `windows/`: installer (`SentryStudioSetup<version>.exe`), `latest.yml` and portable .zip | mingw-w64 (`brew install mingw-w64` or `apt install mingw-w64`); for the installer, NSIS 3.08 or newer (`brew install makensis` or `apt install nsis`) |
| Linux | `tools/package-linux.sh` (`ARCH=arm64` for ARM) | `linux/`: .deb, .tar.gz and `latest-linux.yml` / `latest-linux-arm64.yml` | [zig](https://ziglang.org) and `cargo install cargo-zigbuild` |

The `latest*.yml` files are update manifests in electron-builder's format,
written by `tools/update-manifest.py`. Installed copies update from them:
this app, and Electron Studio, whose updater installs the Windows installer,
the macOS .zip and the .deb from them. The macOS .zip only installs over a
copy signed with the same Developer ID.

Windows and Linux builds cross-compile, so all three can be made on a Mac.
Linux builds link only glibc 2.28 or newer; everything else is loaded at run
time.

Local builds are unsigned: macOS signs them ad hoc for the Mac they're built
on. Release builds come from the **Build Release** workflow:
- macOS is signed with a Developer ID and notarized by Apple.
- Windows (the app, its installer and uninstaller) is signed with [Azure Artifact Signing](https://learn.microsoft.com/azure/artifact-signing/); the publisher is Scott Vandereems. `tools/sign-windows.sh` signs the same way.

`tools/package-macos.sh` lists the environment variables for signing a
macOS build locally.

## Translations

The app's text lives in `assets/i18n/translations.json`, in 13 languages:
`ui.*` and `welcomeScreen.*` strings worded as in earlier versions, and
`app.*` strings added since. A test checks that every language has every
string; English is the fallback at run time.

## Development checks

These run without a window (see `src/main.rs`):

| Check | What it does |
| --- | --- |
| `--decode-check <clip>` | decodes every frame |
| `--export-check <folder> [mobile\|medium\|high\|max] [speed] [out.mp4]` | exports a Sentry/Saved event or a day of clips with every camera, lists the video formats this computer can encode and prints how fast it went; `SENTRY_EXPORT_FORMAT=h264\|hevc\|av1` picks the format |
| `--seek-check`, `--skip-check`, `--hold-check` | exercise the player |
| `--drives-check` | loads drive data |
| `--place-check` | tests place-name lookups |
| `--diagnostics` | prints the diagnostics report support would receive (from the earlier sessions' logs) |
| `--update-check [stable\|prerelease] [as-version] [download]` | checks GitHub for an update (without the api.sentry-six.com request), optionally as an older version and with the download |
| `--gst-check <clip>` | runs the Linux (GStreamer) decoder; on macOS with Homebrew's `gstreamer` it compares every picture against VideoToolbox's |

`cargo test` runs the unit tests.

`THIRD-PARTY-NOTICES.txt` holds the app's licence and those of the fonts and crates it's built with; it ships with every package and opens from Settings › System › Licences. After changing dependencies, run `python3 -I tools/third-party-notices.py` (CI checks it's current).

Environment variables for diagnosing problems:

| Variable | What it does |
| --- | --- |
| `SENTRY_STUDIO_TRACE=1` | prints slow reads and decodes, clock holds, display gaps and seek times to stderr |
| `SENTRY_STUDIO_UPDATE_AS=<version>` | checks for updates as that version, to show the update dialog (it only opens the release page, and doesn't ask api.sentry-six.com) |
| `SENTRY_STUDIO_SOFTWARE_DECODE=1` (Windows) | decodes on the CPU instead of the GPU |
| `SENTRY_STUDIO_GST_DECODER=<element>` (Linux) | uses one GStreamer decoder (e.g. `avdec_h264`) instead of the best available |
| `SENTRY_STUDIO_COPY_FRAMES=1` (macOS) | copies decoded pictures instead of showing the decoder's own textures |
| `SENTRY_STUDIO_TILES`, `SENTRY_STUDIO_TILES_INDEX` | uses a local map tile server or index |
| `SENTRY_STUDIO_GST_ENCODER=<element>` (Linux) | exports with one GStreamer encoder (e.g. `x264enc`) instead of the best available |
| `SENTRY_EXPORT_GST=1` (macOS, with Homebrew's GStreamer) | exports through GStreamer, as on Linux |
| `SENTRY_EXPORT_PORTABLE=1` (macOS) | exports through memory, as Windows and Linux do, instead of straight into the encoder's frames |

On Windows, release builds open no console window. Started from a terminal,
they print there.
