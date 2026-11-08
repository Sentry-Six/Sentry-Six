<h1 align="center">Sentry Studio</h1>

<p align="center">
  <strong>All six cameras, perfectly in sync.</strong><br>
  A fast, native TeslaCam viewer with SEI telemetry, maps and drive history.
</p>

<p align="center">
  <a href="https://github.com/Sentry-Six/Sentry-Six/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/Sentry-Six/Sentry-Six"></a>
  <a href="https://discord.gg/9QZEzVwdnt"><img alt="Discord" src="https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white"></a>
  <a href="LICENSE.txt"><img alt="License" src="https://img.shields.io/badge/License-MIT-yellow.svg"></a>
</p>

---

Sentry Studio by Sentry Six is a viewer for your TeslaCam footage on Windows,
macOS and Linux. It plays all six cameras together, frame for frame, shows
what the car was doing from the telemetry Tesla records in the video, and
maps where you drove.

It's a native app written in Rust. Video is decoded by your computer's own
hardware decoder, so it starts quickly, uses little memory and is a small
download.

## Part of Sentry Six

Sentry Studio is one of the free tools from the [Sentry Six](https://sentry-six.com) project:

| Tool | What it does |
| --- | --- |
| **Sentry Studio** (this repo) | Desktop TeslaCam viewer for Windows, macOS, and Linux |
| [Sentry USB](https://github.com/Sentry-Six/Sentry-USB-Rusty) | Raspberry Pi smart USB drive: drive and charge tracking, auto-archiving, BLE telemetry |
| [Sentry Drive](https://github.com/Sentry-Six/Sentry-Drive) | Desktop drive history and FSD analytics, processed locally |
| [Dash USB](https://github.com/Sentry-Six/Dash-USB) | Raspberry Pi USB drive for GM vehicles |
| [Sentry Connect](https://sentry-six.com/sentry-connect/) | iPhone companion app for Sentry USB (App Store, iOS 18+) |

Not affiliated with Tesla, Inc. Unrelated to the Sentry (sentry.io) error-monitoring service and the "Sentry Studio" product at sentrystudio.app.

## Features

- **Clip browser**
  - Open your TeslaCam folder, or drop any folder of clips on the window. No Tesla USB structure is needed.
  - Browse by date: Recent, Sentry and Saved clips, with their event triggers ("Manual Save", "Sentry", "Honk", "Object Detected" and so on).
  - Plays GM Surround Vision footage too.
  - Delete folders and events from the clip browser. They go to the Trash or Recycle Bin first.
- **Synced six-camera playback**
  - Front, back, B-pillars (HW4/AI4 and newer) and repeaters, in perfect sync.
  - Speeds from 0.5x to 4x, frame-accurate seeking, and skip and fast-forward keys.
  - Focus on one camera, zoom into it, and rearrange or mirror cameras.
  - Hardware video decoding for H.264 and H.265:
    - VideoToolbox on macOS;
    - Media Foundation on Windows;
    - VA-API or NVDEC on Linux, through GStreamer.
- **SEI telemetry**
  - Speed, gear, Autopilot and Self-Driving state, pedals, steering, blinkers and G-force.
  - Full and compact dashboards, floating or fixed to the front camera.
  - *Requires Tesla software 2025.44.25 or newer, on Hardware 3 (HW3/AI3) or newer.*
- **Map**
  - The route of each clip on a map, coloured by driving state.
  - FSD disengagements and accelerator presses are marked on the route.
  - North-up or heading-up, with light and dark map styles.
- **Sentry USB drives**
  - Load `drive-data.json` from [Sentry USB](https://github.com/Sentry-Six/Sentry-USB-Rusty) to browse your drive history in the Drives tab.
  - Drives are labelled with place names, and you can play their footage when the clips are in your loaded folder.
- **Settings**
  - Metric or imperial units, 12- or 24-hour time, and your choice of date format.
  - Glass blur, event highlights and editable keyboard shortcuts.
  - Your settings from earlier versions of Sentry Studio are picked up automatically.
- **Updates**
  - Checks for updates at startup, shows what's new, and installs them with one click. You can also check in Settings.
  - Turn on Pre-release Updates in Settings to get early beta builds.
- **Support**
  - Chat with Sentry Assistant, Sentry Six's AI support, from the chat button in the controls or Settings, and share a diagnostics report when it asks and you approve.
  - The Sentry Six Discord community is a click away for help from a person.
- **13 languages**: English, Spanish, French, German, Chinese (Simplified), Japanese, Korean, Portuguese, Russian, Italian, Dutch, Polish and Turkish.

## Install

Download the build for your system from [Releases](https://github.com/Sentry-Six/Sentry-Six/releases/latest):

- **macOS 13 or newer:** the .dmg. It's a universal app for Apple Silicon and Intel, signed and notarized by Apple.
- **Windows 10 or 11, 64-bit:** `SentryStudioSetup<version>.exe`, the installer. It installs for your user only, so it doesn't need administrator rights. For a portable copy, unzip the .zip and run `sentry-studio.exe`.
- **Linux, x86_64 (`amd64` / `x64`) or ARM (`arm64`):**
  - **Debian, Ubuntu, Mint, Raspberry Pi OS:** the .deb for your architecture. Install it with `sudo apt install ./<file>.deb`, which also installs GStreamer for video.
  - **Other distributions:** the .tar.gz for your architecture. Unzip it and run `./sentry-studio`. Its READ-ME lists the GStreamer packages to install.

## Usage

1. Launch Sentry Studio and accept the privacy notice.
2. Choose your **TeslaCam folder**, or drop a folder on the window.
3. Pick a day and a clip in the clip browser, and press play.

Notes:
- SEI telemetry is usually not recorded while parked.
- Smart Summon is shown as manual driving.
- Pedal data isn't logged during Self Driving, so pedal activity then means the driver pressed a pedal.

## Privacy

Your dashcam footage stays on your computer. Here's what Sentry Studio sends, and when:

- **Map tiles:** maps load from our map server at tiles.sentryusb.com (OpenStreetMap data plus ESA WorldCover, GEBCO and Mapzen terrain, built with [VersaTiles](https://versatiles.org)). The server sees roughly where you drive.
- **Place Names (on by default):** to label your drives, their start and end coordinates and your system language are sent to OpenStreetMap Nominatim. Each spot is looked up once and cached on your computer. Turn this off in Settings → Playback & Overlays → Map.
- **Update checks:** at startup and when you click Check Now, Sentry Studio sends a pseudonymous install ID (a SHA-256 hash of your machine ID with a salt that is public in the source code), your OS, CPU architecture and app version to api.sentry-six.com. Records are stored in Canada; a private maintainers' Discord channel gets the platform and version. The new version and its files come from GitHub.
- **Clip sharing (only when you use it):** Share Clip uploads the exported video to clip.sentry-six.com, where anyone with the link can watch and download it until it expires (you choose 30 minutes to 7 days) or you delete it from Settings → My Shared Clips. The clip page shows the video's file name; the server logs your IP address for rate limiting.
- **AI support chat (only when you use it):** after you accept its notice, your messages, the app version, OS and CPU type go to Sentry Six, and Anthropic processes them to write each answer. Chats are redacted and kept up to 90 days after your last message; New chat deletes the current one.
- **Diagnostics:** Sentry Studio keeps a log of its last few sessions on your computer (app events, errors and playback health, never footage or locations). It's only sent when Sentry Assistant asks for it and you approve, and it's deleted within 7 days.
- **Privacy Notice:** you'll see a notice about these features when you first launch the app, and again if they change.

📄 **[Privacy Policy](https://sentry-six.com/privacy)** · **[Terms of Service](https://sentry-six.com/terms)** · **[Code signing policy](https://sentry-six.com/code-signing)**

## Building from source

You need [Rust](https://rustup.rs) 1.88 or newer.

```bash
cargo build --release
```

`target/release/sentry-studio` opens your default folder, or a folder given
on the command line. On Linux, video decoding also needs GStreamer (see
Install).

### Packaging

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

### Translations

The app's text lives in `assets/i18n/translations.json`, in 13 languages:
`ui.*` and `welcomeScreen.*` strings worded as in earlier versions, and
`app.*` strings added since. A test checks that every language has every
string; English is the fallback at run time.

### Development checks

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

On Windows, release builds open no console window. Started from a terminal,
they print there.

## Community & Support

Have questions, feedback, or want to connect with other users? Join our [Discord Server](https://discord.com/invite/9QZEzVwdnt)!

## Project Origin & Credits

Originally conceived by [**ChadR23**](https://github.com/ChadR23), this project is now co-developed alongside [**Scottmg1**](https://github.com/Scottmg1). Both serve as main developers.

Special thanks to [**JeffFromTheIRS**](https://github.com/JeffFromTheIRS) for his contributions via Pull Requests and beta testing, and to [**Parallax**](https://github.com/DennisGarvey) and **38tu** for their hands-on testing and invaluable feedback.

## License

MIT License - see [LICENSE.txt](LICENSE.txt) for details.
