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

Without them Studio falls back to a Homebrew or system FFmpeg, and if there is
none it reports that FFmpeg is missing and names this script. Packaged apps use
their bundled universal executable.

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

`ffmpeg.exe` and `ffprobe.exe` are bundled by the Windows installer. They are
the FFmpeg 7.1.1 "essentials" build from https://www.gyan.dev/ffmpeg/builds/,
configured with `--enable-gpl --enable-version3`, so they are also distributed
under GPL-3.0-or-later. FFmpeg source for this release:
https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz. The full build configuration is
printed by `ffmpeg.exe -version`.

## License and source offer

All installers include the GPL version 3 text as
`ffmpeg_bin/COPYING.GPLv3.txt` beside the executables. Sentry Studio runs FFmpeg
as a separate program; Studio's own code stays under its MIT license.

For at least three years after we last distribute a release containing these
binaries, we will provide the complete corresponding source code for the FFmpeg
build in that release, including its dependencies and build scripts, to anyone
who asks at info@sentry-six.com, at no more than the cost of providing it.

## Linux release builds

The `.deb` bundles FFmpeg and FFprobe 9.0.2 from
https://github.com/BtbN/FFmpeg-Builds (the `linux64-gpl` and `linuxarm64-gpl`
static builds of release `autobuild-2026-09-30-13-08`). They include
`drawtext`, `ass`, and the VAAPI, Quick Sync, NVENC and AMF hardware encoders.

`linux-manifest.json` pins the download URLs, archive SHA-256 hashes, and
extracted executable hashes. `scripts/prepare-linux-ffmpeg.js` runs from the
same `beforePack` hook as the macOS script, verifies the hashes, and caches the
executables in the ignored `ffmpeg_bin/linux/{x64,arm64}/` directories. The
package installs them to `/opt/Sentry Studio/resources/ffmpeg_bin/`.

For development on Linux, prepare the binaries before starting Studio:

```sh
node scripts/prepare-linux-ffmpeg.js
npm start
```

Without them Studio falls back to a system FFmpeg in `/usr/bin` or
`/usr/local/bin`; it needs the `drawtext` and `ass` filters.

### Upstream sources and license

These builds are configured with `--enable-gpl --enable-version3` and no
non-free components, so FFmpeg is distributed under GPL-3.0-or-later. The
FFmpeg source is the `n9.0.2-17-g2a571b6068` revision of
https://github.com/FFmpeg/FFmpeg (release branch 9.0). The build scripts and
dependency versions are at https://github.com/BtbN/FFmpeg-Builds, and the full
configuration is printed by `ffmpeg -version`. The license and source offer
above apply to these binaries too.
