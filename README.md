<h1 align="center">Sentry Studio</h1>

<p align="center">
  <strong>All in one beautiful app.</strong><br>
  View all six cameras simultaneously. Visualize SEI telemetry data. Export clips with hardware acceleration.
</p>

<p align="center">
  <a href="https://github.com/Sentry-Six/Sentry-Six/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/Sentry-Six/Sentry-Six"></a>
  <a href="https://discord.gg/9QZEzVwdnt"><img alt="Discord" src="https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white"></a>
  <a href="LICENSE.txt"><img alt="License" src="https://img.shields.io/badge/License-MIT-yellow.svg"></a>
</p>

---

Sentry Studio by Sentry Six is a modern, feature‑rich viewer and exporter for your TeslaCam. View sentry and dashcam events with an easy-to-use UI! Trim and export your clips with ease with a variety of options - from camera layouts to a telemetry overlay. Use it on your preferred OS - Windows, macOS, or Linux.

## Part of Sentry Six

Sentry Studio is one of the free tools from the [Sentry Six](https://sentry-six.com) project:

| Tool | What it does |
| --- | --- |
| **Sentry Studio** (this repo) | Desktop TeslaCam viewer and clip exporter for Windows, macOS, and Linux |
| [Sentry USB](https://github.com/Sentry-Six/Sentry-USB-Rusty) | Raspberry Pi smart USB drive: drive and charge tracking, auto-archiving, BLE telemetry |
| [Sentry Drive](https://github.com/Sentry-Six/Sentry-Drive) | Desktop drive history and FSD analytics, processed locally |
| [Dash USB](https://github.com/Sentry-Six/Dash-USB) | Raspberry Pi USB drive for GM vehicles |
| [Sentry Connect](https://sentry-six.com/sentry-connect/) | iPhone companion app for Sentry USB (App Store, iOS 18+) |

Not affiliated with Tesla, Inc. Unrelated to the Sentry (sentry.io) error-monitoring service and the "Sentry Studio" product at sentrystudio.app.

## Features
- **Simple UI**
  - Select your TeslaCam folder using the folder explorer
  - Select a default folder in the settings
  - Load clips from any folder - no Tesla USB structure needed
  - Easily browse files by date
  - Supports Recent, Sentry, and Saved Clips
  - Also plays GM Surround Vision footage
  - Event Triggers (e.g. "Manual Save", "Sentry", "Honk", "Object Detected", etc.)
  - Delete folders/events with the trash icon in the Clip Browser

    <img width="176.5" height="275.5" alt="image" src="https://github.com/user-attachments/assets/1b2f3970-965b-431a-b1c9-073a7fd30800" />

- **Multi-Camera Playback**
  - View all cameras at once
    - Front, Back, B-Pillars (HW4/AI4+), Repeaters
  - Synced playback across all cameras
  - Focus on the details with speed controls, from half speed (0.5x) to 4x.
 
- **SEI Telemetry**
  - Visualize the car's actions
    - See data such as speed, gear, autopilot status, accelerator pedal position, and more
  - GPS Map with route visualization
    - See the path your car took during the clip
    - Route line changes color based on driving state (Blue for Self Driving, Gray for Manual)
    - Zoom in/out and pan around the map (right-click drag to pan)
  - Choose between default and compact dashboard layouts
  - *Requirements for SEI Telemetry*
    - *2025.44.25 or newer*
    - *Hardware 3 (HW3/AI3) or newer*

  ![Dashboard](https://github.com/user-attachments/assets/6bc6ff11-0066-427f-b2ab-c95530eaa2e3)

- **Sentry USB Drives**
  - Load the `drive-data.json` from [Sentry USB](https://github.com/Sentry-Six/Sentry-USB-Rusty) to browse your drive history in the Drives tab
  - See the route map for the whole drive, filter by tag, and play its footage when the clips are in your loaded folder

- **Clip Exporting**
  - Trim clips with ease using in/out points
  - Hardware-accelerated encoding (NVIDIA, AMD, Intel QuickSync, Apple Silicon)
  - Pick different export qualities
    - Mobile, Medium, High, Maximum
  - Add the SEI overlay to your export
    - Dashboard styles: Compact, Detailed, Tesla Mobile, and Tesla Screen Dash
    - Configurable dashboard size (Small to X-Large)
    - Overlay is pre-rendered for optimal performance
  - Add a GPS minimap to your export (Beta)
  - Add a timestamp overlay with multiple date formats
  - Use blur zones to ensure privacy
  - Export a time-lapse with an adjustable speed multiplier
  - Minimize the export modal and track progress via floating notification
  - Advanced Editor (Beta): place and resize each camera and overlay freely on the canvas

- **Clip Sharing**
  - Generate a shareable link after exporting a clip
  - Clips are hosted on Sentry Studio servers at clip.sentry-six.com for a duration you choose (30 minutes to 7 days, 72 hours by default)
  - Manage your shared clips from the "My Shared Clips" modal
    - Preview, copy link, open in browser, or delete shared clips
  - Available for exports up to 10 minutes long

- **Footage Converter**
  - Re-encode original Tesla camera files to H.265 or AV1 to save space, keeping their telemetry and folder structure
  - Save to a separate folder and keep the originals, or replace the originals after each file is verified
  - Choose a compression profile: High Quality, Balanced, or Smaller

- **Customizable Settings**
  - Adjustable glass blur intensity
  - Toggle between metric or imperial measurements (Km/H or MPH)
  - Choose between 12-hour and 24-hour time formats
  - Customizable keyboard shortcuts with adjustable fast forward/backward duration
  - Light or dark map style
  - Event Highlights
    - See which camera was triggered, visualized with a yellow or red highlight
  - Hardware Video Acceleration, which you can turn off if cameras freeze or stutter on older or integrated graphics

- **Multi-Language Support**
  - 13 languages supported: English, Spanish, French, German, Chinese (Simplified), Japanese, Korean, Portuguese, Russian, Italian, Dutch, Polish, and Turkish
  - Export overlays respect your language setting

- **Built-in AI Support**
  - Ask Sentry Assistant for help directly within the app
  - Join the Sentry Six Discord any time for help from a person

- **Auto Update**
  - Checks for new updates on start up with a one-click install.
    - You can also check for updates via the settings
  - Turn on Pre-release Updates in Settings to get early beta builds

## Privacy & Updates

Your dashcam footage stays on your computer unless you choose to share a clip. Here's what Sentry Studio sends, and when:

- **Update checks**: On startup and when you click Check Now, the app sends a pseudonymous install ID (a SHA-256 hash of your machine ID with a salt that is public in the source code), your platform, CPU architecture and app version. Records are stored in Canada; a private maintainers' Discord channel gets the platform and version.
- **Map tiles**: Maps load from our map server at tiles.sentryusb.com (OpenStreetMap data plus ESA WorldCover, GEBCO and Mapzen terrain, built with [VersaTiles](https://versatiles.org)). Exported static minimaps, and computers that can't draw the vector map, use OpenStreetMap's tile server. The server used sees roughly where you drive.
- **Place Names (opt-in)**: When turned on in Settings → Playback & Overlays, drive start and end coordinates are sent to OpenStreetMap Nominatim to look up place names.
- **Clip sharing (when you share)**: The exported MP4 (up to 3 GB) is uploaded to clip.sentry-six.com for the time you choose (30 minutes to 7 days, 72 hours by default). The original filename is shown on the public clip page and used as the download name. Your IP address, the filename and a delete token are kept until the clip is deleted or expires. Moderators may keep a reported clip up to 30 days past expiry to investigate abuse. Anyone can report a clip from its page.
- **Diagnostics (when you send them)**: Logs and selected settings. The app replaces your home-folder user name in file paths and removes logged event locations; other details in the logs are sent as they are, so review what you send. Your IP address is stored with the upload, and diagnostics are deleted after 7 days.
- **AI Support (when used)**: Your messages, app version, platform and CPU architecture go to Sentry Six, and Anthropic processes them to write each answer. Redacted chats are stored in Canada for up to 90 days after your last message and may be reviewed by authorized maintainers; **New chat** deletes the current chat. Diagnostics are shared only when you approve a request in the chat, and are deleted within 7 days.
- **Privacy Notice**: You'll see a notice about these features when you first launch the app, and again if they change.

📄 **[Privacy Policy](https://sentry-six.com/privacy)** · **[Terms of Service](https://sentry-six.com/terms)**

## Community & Support

Have questions, feedback, or want to connect with other users?

Join our [Discord Server](https://discord.com/invite/9QZEzVwdnt)!

## Requirements
- Windows 10+ / macOS 13+ / Debian, Ubuntu and other Linux distributions that install `.deb` packages (x64 or arm64)

## Automatic Installation (Recommended, easiest)
1. Go to the Sentry Studio [Releases](https://github.com/Sentry-Six/Sentry-Six/releases/) page
2. Download `SentryStudioSetup<version>.exe` (`SentryStudio-<version>-macOS.dmg` for macOS, a universal build for Apple Silicon and Intel)
3. Run the installer
4. Run Sentry Studio

The macOS app is signed and notarized by Apple, so it opens normally.

On Linux, download `SentryStudio-<version>-linux-amd64.deb` (most PCs) or `SentryStudio-<version>-linux-arm64.deb` (ARM computers) and install it with `sudo apt install ./SentryStudio-<version>-linux-amd64.deb`. FFmpeg is included. Sentry Studio then updates itself, asking for your password to install each update.


## Manual Installation

To run from source instead:

1. Install [Node.js](https://nodejs.org/en/download) 22 or newer
2. Clone this repository, or download it with **Code → Download ZIP** and extract it
3. Open a terminal (Command Prompt or PowerShell on Windows) in the Sentry Studio folder, for example `cd C:\Users\yourname\Downloads\Sentry-Six`
4. Install the dependencies: `npm install`
5. On macOS, download the pinned FFmpeg: `node scripts/prepare-macos-ffmpeg.js`. On Linux, run `node scripts/prepare-linux-ffmpeg.js`, or use a system FFmpeg with the `drawtext` and `ass` filters. Windows uses the FFmpeg in `ffmpeg_bin`.
6. Start Sentry Studio: `npm start`

See [ffmpeg_bin/README.md](ffmpeg_bin/README.md) for details about the bundled FFmpeg.

## Usage

1. Launch the app
2. Select your **TeslaCam folder**
3. Pick a clip from the sidebar
4. Use the playback controls and in/out markers to select the part of the clip you'd like to export.

## Notes
- SEI telemetry is typically not recorded while parked
- SEI telemetry while using Smart Summon will be notated as manual
- Brake/accelerator pedal data is not logged during Self Driving. Pedal activity while Autopilot/Self Driving is engaged indicates driver input.

## Project Origin & Credits

Originally conceived by [**ChadR23**](https://github.com/ChadR23), this project is now co-developed alongside [**Scottmg1**](https://github.com/Scottmg1). Both serve as main developers.

Special thanks to [**JeffFromTheIRS**](https://github.com/JeffFromTheIRS) for his contributions via Pull Requests and beta testing, and to  [**Parallax**](https://github.com/DennisGarvey) and **38tu** for their hands-on testing and invaluable feedback.

## License

MIT License - see [LICENSE.txt](LICENSE.txt) for details.
