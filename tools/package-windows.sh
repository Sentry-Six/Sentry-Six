#!/usr/bin/env bash
# Builds Sentry Studio for 64-bit Windows by cross-compiling with
# mingw-w64 (Homebrew on macOS, apt on Linux), and packages it as:
#   target/windows/SentryStudioSetup<version>.exe          the installer (NSIS)
#   target/windows/latest.yml                              its update manifest
#   target/windows/SentryStudio-<version>-windows-x64.zip  portable copy
# The installer and latest.yml are what installed copies (Electron Studio's
# electron-updater, and this app) update from; they need NSIS's makensis
# 3.08 or newer (brew install makensis, apt install nsis), and are skipped
# without it unless REQUIRE_INSTALLER=1.
# CI signs sentry-studio.exe, the uninstaller and the installer with Azure
# Artifact Signing (tools/sign-windows.sh, .github/workflows/build-release.yml);
# a local build is unsigned unless you sign it the same way.
#   SIGNED_EXE=path/to/sentry-studio.exe   package this (signed) exe instead
#   CAPTURE_UNINSTALLER=path               also copy the installer's uninstaller
#                                          there, to be signed
#   SIGNED_UNINSTALLER=path                embed this signed uninstaller
set -euo pipefail
abs() { case "$1" in /*) echo "$1" ;; *) echo "$PWD/$1" ;; esac; }
[ -n "${SIGNED_EXE:-}" ] && SIGNED_EXE=$(abs "$SIGNED_EXE")
[ -n "${CAPTURE_UNINSTALLER:-}" ] && CAPTURE_UNINSTALLER=$(abs "$CAPTURE_UNINSTALLER")
[ -n "${SIGNED_UNINSTALLER:-}" ] && SIGNED_UNINSTALLER=$(abs "$SIGNED_UNINSTALLER")
cd "$(dirname "$0")/.."
ROOT=$(pwd)
OUT="$ROOT/target/windows"
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
DIR="$OUT/Sentry Studio"

if [ -z "${SIGNED_EXE:-}" ]; then
  cargo build --release --target x86_64-pc-windows-gnu
fi
EXE="${SIGNED_EXE:-$ROOT/target/x86_64-pc-windows-gnu/release/sentry-studio.exe}"

rm -rf "$OUT" && mkdir -p "$DIR"
cp "$EXE" "$DIR/sentry-studio.exe"
# The licences, next to the app (Settings › System › Open Source opens them).
cp "$ROOT/LICENSE.txt" "$ROOT/THIRD-PARTY-NOTICES.txt" "$DIR/"
cat > "$DIR/READ-ME.txt" <<'TXT'
Sentry Studio for Windows (64-bit)

1. Copy this folder anywhere and run sentry-studio.exe.
   If Windows SmartScreen warns about an unrecognized app: More info > Run anyway.
2. Settings from earlier versions of Sentry Studio carry over; their file is
   only read, never changed.

Privacy: maps load from our map server (tiles.sentryusb.com), which sees roughly
where you drive. Drive start/end place names are looked up with OpenStreetMap
(Nominatim) by default; turn this off in Settings > Playback & Overlays > Map.
Your footage never leaves the computer. https://sentry-six.com/privacy

Needs 64-bit Windows 10/11 and a DirectX 12 or Vulkan capable GPU.
Windows "N" editions need the free Media Feature Pack for video.
TXT
# Windows line endings for Notepad.
sed -i.bak 's/$/\r/' "$DIR/READ-ME.txt" && rm -f "$DIR/READ-ME.txt.bak"
(cd "$OUT" && zip -qr "SentryStudio-$VERSION-windows-x64.zip" "Sentry Studio")

# --- installer -----------------------------------------------------------------
if command -v makensis >/dev/null; then
  INSTALLER="$OUT/SentryStudioSetup$VERSION.exe"
  # x.y.z.0 for the version resource, as build.rs makes it.
  VI_VERSION=$(echo "$VERSION" | awk -F'[.+-]' '{ printf "%d.%d.%d.0", $1, $2, $3 }')
  DEFINES=(
    "-DVERSION=$VERSION" "-DVI_VERSION=$VI_VERSION"
    "-DAPP_EXE=$DIR/sentry-studio.exe" "-DAPP_DIR=$DIR" "-DOUT_FILE=$INSTALLER"
    "-DICON=$ROOT/assets/icons/sentry-studio.ico"
  )
  if [ -n "${CAPTURE_UNINSTALLER:-}" ]; then
    mkdir -p "$(dirname "$CAPTURE_UNINSTALLER")"
    DEFINES+=("-DUNINSTALLER_CAPTURE=$CAPTURE_UNINSTALLER")
  fi
  [ -n "${SIGNED_UNINSTALLER:-}" ] && DEFINES+=("-DUNINSTALLER_SIGNED=$SIGNED_UNINSTALLER")
  makensis -V2 -INPUTCHARSET UTF8 "${DEFINES[@]}" "$ROOT/tools/windows-installer.nsi"
  python3 -I "$ROOT/tools/update-manifest.py" "$OUT/latest.yml" "$VERSION" "$INSTALLER"
elif [ -n "${REQUIRE_INSTALLER:-}" ]; then
  echo "makensis (NSIS) is needed for the installer: brew install makensis, or apt install nsis" >&2
  exit 1
else
  echo "makensis (NSIS) not found: skipping the installer and latest.yml (brew install makensis, or apt install nsis)" >&2
fi
ls -la "$OUT"
