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
- **Export**
  - Export a clip with any cameras, the dashboard, map and timestamp, in H.264 or HEVC (AV1 where the computer supports it).
  - Lay it out in the full-window editor: drag and resize everything, blur out plates and faces, and preview it playing.
  - Share it as a link that expires; your shared clips are in Settings.
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

Your dashcam footage stays on your computer. The [Privacy Policy](https://sentry-six.com/privacy) explains what the app sends (map tiles, place names, update checks, and clip sharing, AI support and diagnostics only when you use them), and the app shows a summary when you first open it.

📄 **[Privacy Policy](https://sentry-six.com/privacy)** · **[Terms of Service](https://sentry-six.com/terms)** · **[Code signing policy](https://sentry-six.com/code-signing)**

## Building from source

You need [Rust](https://rustup.rs) 1.88 or newer; `cargo build --release` builds the app. Packaging, signing, translations and the development checks are in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Community & Support

Have questions, feedback, or want to connect with other users? Join our [Discord Server](https://discord.com/invite/9QZEzVwdnt)!

## Project Origin & Credits

Originally conceived by [**ChadR23**](https://github.com/ChadR23), this project is now co-developed alongside [**Scottmg1**](https://github.com/Scottmg1). Both serve as main developers.

Special thanks to [**JeffFromTheIRS**](https://github.com/JeffFromTheIRS) for his contributions via Pull Requests and beta testing, and to [**Parallax**](https://github.com/DennisGarvey) and **38tu** for their hands-on testing and invaluable feedback.

## License

MIT License - see [LICENSE.txt](LICENSE.txt) for details.
