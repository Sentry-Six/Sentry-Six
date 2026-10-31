# FFmpeg binaries

## macOS release builds

Mac builds bundle FFmpeg and FFprobe 9.0.2 for **both Apple Silicon and Intel**.
Apple Silicon runs the arm64 slice directly; Rosetta and Homebrew are not required.
The builds include `drawtext` (timestamps), `ass` (dashboards), and VideoToolbox
hardware encoders.

`macos-manifest.json` pins the exact download URLs, archive SHA-256 hashes, and
extracted executable hashes from https://ffmpeg.martin-riedl.de/.
`scripts/prepare-macos-ffmpeg.js` runs as electron-builder's `beforePack` hook,
verifies those hashes and the architecture, rejects non-system dynamic library
dependencies, and sets executable permissions. Downloads are cached in the
ignored `ffmpeg_bin/macos/{arm64,x64}/` directories.

Each architecture is copied to `Contents/Resources/ffmpeg_bin/` in its app.
electron-builder merges the different Mach-O files into universal executables,
then signs and notarizes the app. Do not reintroduce an `x64ArchFiles` exception
for FFmpeg: it allowed Intel-only binaries into the Apple Silicon app.

The release workflow runs `scripts/verify-macos-ffmpeg.js` against the packaged
app before uploading it. It checks both slices, executable signatures, required
filters, and a timestamp encode/decode with visible text pixels.

For development on a Mac, prepare the native binaries before starting Studio:

```sh
node scripts/prepare-macos-ffmpeg.js
npm start
```

Studio prefers these prepared native binaries over the legacy Intel files at
this directory's root. Packaged apps prefer their bundled universal executable.
The root Intel files are retained only for legacy development setups.

### Upstream sources and license

These FFmpeg builds enable GPL and version 3; FFmpeg is distributed under
GPL-3.0-or-later for this configuration. FFmpeg source for this pinned release:
https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz

The provider's build scripts and dependency source recipes:
https://git.martin-riedl.de/ffmpeg/build-script

Build configuration and dependency versions are recorded by the provider:
- Apple Silicon: https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/versions.txt
- Intel: https://ffmpeg.martin-riedl.de/download/macos/amd64/1789931006_9.0.2/versions.txt

## Windows

`ffmpeg.exe` and `ffprobe.exe` are bundled by the Windows installer.

## Linux

Install a system FFmpeg build with `drawtext` and `ass` filters, for example
through the distribution package manager. Verify its features with
`ffmpeg -hide_banner -filters`.
