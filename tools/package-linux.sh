#!/usr/bin/env bash
# Builds Sentry Studio for Linux with zig + cargo-zigbuild (on macOS or
# Linux; glibc 2.28 and newer) and packages it. ARCH=x64 (the default) or
# ARCH=arm64:
#   target/linux/SentryStudio-<version>-linux-amd64.deb    x64 .deb (Debian, Ubuntu, Mint)
#   target/linux/SentryStudio-<version>-linux-x64.tar.gz   x64 tarball (any distro: run ./sentry-studio)
#   target/linux/latest-linux.yml                          the x64 .deb's update manifest
#   target/linux/SentryStudio-<version>-linux-arm64.deb    arm64 .deb
#   target/linux/SentryStudio-<version>-linux-arm64.tar.gz arm64 tarball
#   target/linux/latest-linux-arm64.yml                    the arm64 .deb's update manifest
# The .deb keeps the package name earlier versions used (sentry-six-revamped),
# so installing it upgrades them in place, and Electron Studio's own .deb
# updater installs it from the manifest for its architecture (the names
# above are the ones it looks for).
# Video decoding uses the system's GStreamer, loaded at run time.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
ARCH=${ARCH:-x64}
case "$ARCH" in
  x64) TARGET=x86_64-unknown-linux-gnu; DEB_ARCH=amd64; MANIFEST=latest-linux.yml; LABEL=x86_64 ;;
  arm64) TARGET=aarch64-unknown-linux-gnu; DEB_ARCH=arm64; MANIFEST=latest-linux-arm64.yml; LABEL=arm64 ;;
  *) echo "ARCH must be x64 or arm64" >&2; exit 2 ;;
esac
OUT="$ROOT/target/linux"

cargo zigbuild --release --target "$TARGET.2.28"
BIN="$ROOT/target/$TARGET/release/sentry-studio"

# This architecture's earlier packages go; the other's stay.
mkdir -p "$OUT"
rm -f "$OUT/SentryStudio-"*"-linux-$DEB_ARCH.deb" "$OUT/SentryStudio-"*"-linux-$ARCH.tar.gz" "$OUT/$MANIFEST"
WORK="$OUT/work-$ARCH"
rm -rf "$WORK" && mkdir -p "$WORK"
export COPYFILE_DISABLE=1
if tar --version 2>/dev/null | grep -q "GNU tar"; then
  TAR=(tar --owner=0 --group=0 --numeric-owner --format=gnu --sort=name)
else
  TAR=(tar --no-xattrs --no-mac-metadata --uid 0 --gid 0 --uname root --gname root --format gnutar)
fi
md5_of() { if command -v md5sum >/dev/null; then md5sum "$1" | cut -d' ' -f1; else md5 -q "$1"; fi; }

# --- tarball -----------------------------------------------------------------
T="$WORK/sentry-studio"
mkdir -p "$T"
cp "$BIN" "$T/sentry-studio"
cp LICENSE.txt THIRD-PARTY-NOTICES.txt "$T/"
cp assets/linux/sentry-studio.desktop "$T/"
cp assets/icons/256x256.png "$T/sentry-studio.png"
cat > "$T/READ-ME.txt" <<TXT
Sentry Studio for Linux, $LABEL

Run ./sentry-studio from this folder (or pass a TeslaCam folder: ./sentry-studio /path/to/TeslaCam).

Video decoding uses GStreamer from your distribution. Install it with:
  Arch, CachyOS, Manjaro:  sudo pacman -S --needed gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad gst-plugin-va gst-libav
  Debian, Ubuntu, Mint:    sudo apt install gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly gstreamer1.0-libav
  Fedora:                  sudo dnf install gstreamer1-plugins-base gstreamer1-plugins-good gstreamer1-plugins-bad-free gstreamer1-plugin-libav
The GPU is used when GStreamer has a hardware decoder for it (VA-API on Intel and AMD,
NVDEC on NVIDIA); otherwise video is decoded on the CPU. Running from a terminal shows which.
TXT
(cd "$WORK" && "${TAR[@]}" -czf "$OUT/SentryStudio-$VERSION-linux-$ARCH.tar.gz" sentry-studio)

# --- .deb ----------------------------------------------------------------------
D="$WORK/deb"
mkdir -p "$D/data/usr/lib/sentry-studio" "$D/data/usr/bin" "$D/data/usr/share/applications" "$D/control"
install -m 755 "$BIN" "$D/data/usr/lib/sentry-studio/sentry-studio"
# The licences, next to the app (Settings › System › Open Source opens them).
install -m 644 LICENSE.txt THIRD-PARTY-NOTICES.txt "$D/data/usr/lib/sentry-studio/"
ln -s ../lib/sentry-studio/sentry-studio "$D/data/usr/bin/sentry-studio"
install -m 644 assets/linux/sentry-studio.desktop "$D/data/usr/share/applications/"
# Electron Studio ran "/opt/Sentry Studio/sentry-six-revamped", and restarts
# from that path after its updater installs this package.
mkdir -p "$D/data/opt/Sentry Studio"
ln -s /usr/lib/sentry-studio/sentry-studio "$D/data/opt/Sentry Studio/sentry-six-revamped"
for size in 16 32 48 64 128 256 512; do
  dir="$D/data/usr/share/icons/hicolor/${size}x${size}/apps"
  mkdir -p "$dir"
  install -m 644 "assets/icons/${size}x${size}.png" "$dir/sentry-studio.png"
done
SIZE_KB=$(du -sk "$D/data" | cut -f1)
cat > "$D/control/control" <<CTL
Package: sentry-six-revamped
Version: $VERSION
Architecture: $DEB_ARCH
Maintainer: Sentry-Six <noreply@sentry-six.com>
Installed-Size: $SIZE_KB
Depends: libc6 (>= 2.28), libgstreamer1.0-0, libgstreamer-plugins-base1.0-0, gstreamer1.0-plugins-base, gstreamer1.0-plugins-good, gstreamer1.0-plugins-bad, gstreamer1.0-libav, libxkbcommon0, libxkbcommon-x11-0, libvulkan1 | libegl1
Recommends: mesa-va-drivers | intel-media-va-driver | va-driver-all, mesa-vulkan-drivers, gstreamer1.0-plugins-ugly
Section: video
Priority: optional
Homepage: https://github.com/Sentry-Six/Sentry-Six
Description: Sentry Studio, the TeslaCam viewer
 Synced six-camera Tesla dashcam playback with telemetry, map and drive
 history. Video is decoded by GStreamer (VA-API or NVDEC when available).
CTL
(cd "$D/data" && find . -type f -o -type l | sed 's|^\./||' | sort | while read -r f; do [ -f "$f" ] && [ ! -L "$f" ] && echo "$(md5_of "$f")  $f"; done) > "$D/control/md5sums"
(cd "$D/control" && "${TAR[@]}" -czf ../control.tar.gz ./control ./md5sums)
(cd "$D/data" && "${TAR[@]}" -czf ../data.tar.gz ./opt ./usr)
echo "2.0" > "$D/debian-binary"
DEB="$OUT/SentryStudio-$VERSION-linux-$DEB_ARCH.deb"
# A .deb is an ar archive: debian-binary, control.tar.gz, data.tar.gz.
python3 -I - "$DEB" "$D/debian-binary" "$D/control.tar.gz" "$D/data.tar.gz" <<'PY'
import os, sys
out, *members = sys.argv[1:]
with open(out, "wb") as f:
    f.write(b"!<arch>\n")
    for path in members:
        data = open(path, "rb").read()
        name = os.path.basename(path).encode()
        f.write(name.ljust(16) + b"0".ljust(12) + b"0".ljust(6) + b"0".ljust(6) + b"100644".ljust(8) + str(len(data)).encode().ljust(10) + b"`\n")
        f.write(data)
        if len(data) % 2:
            f.write(b"\n")
PY
rm -rf "$WORK"
python3 -I tools/update-manifest.py "$OUT/$MANIFEST" "$VERSION" "$DEB"
ls -la "$OUT"
