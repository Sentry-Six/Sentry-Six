#!/bin/sh
# Builds Sentry Studio for macOS: a universal (Apple Silicon + Intel)
# app with its icon, and a .dmg.
#
#   tools/package-macos.sh
#
# By default both are signed for this Mac only (ad hoc). For release, set:
#   SIGN_IDENTITY     a Developer ID Application identity in the keychain, e.g.
#                     "Developer ID Application: Name (TEAMID)": signs the app
#                     (hardened runtime, secure timestamp) and the .dmg
#   APPLE_API_KEY     path to an App Store Connect API key (.p8), with
#   APPLE_API_KEY_ID  its key ID and
#   APPLE_API_ISSUER  its issuer ID: notarizes the app and the .dmg and
#                     staples both (the names the release workflow uses)
#   BUNDLE_ID         the bundle identifier: com.sentry-six.revamped for
#                     releases (default: com.sentry-six.revamped.dev, so a
#                     test build sits next to an installed release)
# Signed builds can't load Homebrew's GStreamer, so --gst-check needs an
# unsigned (ad hoc) build.
#
# Output: target/macos/Sentry Studio.app,
#         target/macos/SentryStudio-<version>-macOS.dmg,
#         target/macos/SentryStudio-<version>-macOS.zip and latest-mac.yml:
#         what installed copies (Electron Studio's Squirrel.Mac updater, and
#         this app) update from. Squirrel.Mac only takes an app signed by
#         the installed one's Developer ID, with its bundle identifier.
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd)
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
OUT="$ROOT/target/macos"
APP="$OUT/Sentry Studio.app"

cargo build --release --target aarch64-apple-darwin
cargo build --release --target x86_64-apple-darwin

rm -rf "$OUT"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
lipo -create \
  target/aarch64-apple-darwin/release/sentry-studio \
  target/x86_64-apple-darwin/release/sentry-studio \
  -output "$APP/Contents/MacOS/sentry-studio"
cp assets/icons/sentry-studio.icns "$APP/Contents/Resources/AppIcon.icns"
# The licences, which Settings › System › Open Source opens.
cp LICENSE.txt THIRD-PARTY-NOTICES.txt "$APP/Contents/Resources/"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Sentry Studio</string>
  <key>CFBundleDisplayName</key><string>Sentry Studio</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID:-com.sentry-six.revamped.dev}</string>
  <key>CFBundleExecutable</key><string>sentry-studio</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.video</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
DMG="$OUT/SentryStudio-$VERSION-macOS.dmg"
NOTARIZE=
if [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ]; then
  NOTARIZE=1
fi
notarize() {
  xcrun notarytool submit "$1" --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait --timeout 30m
}

if [ -n "${SIGN_IDENTITY:-}" ]; then
  # Hardened runtime with no exceptions: the app needs no JIT, unsigned
  # memory or third-party libraries.
  codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$APP"
  codesign --verify --strict --verbose=2 "$APP"
  if [ -n "$NOTARIZE" ]; then
    # Notarize the app itself and staple it, so it opens offline after
    # being copied out of the .dmg.
    ditto -c -k --keepParent "$APP" "$OUT/notarize-app.zip"
    notarize "$OUT/notarize-app.zip"
    rm -f "$OUT/notarize-app.zip"
    xcrun stapler staple "$APP"
  fi
else
  if [ -n "$NOTARIZE" ]; then
    echo "Notarization needs SIGN_IDENTITY (a Developer ID); building ad hoc instead." >&2
    NOTARIZE=
  fi
  codesign --force --sign - "$APP"
fi

# The .dmg: the app and a link to Applications.
STAGE="$OUT/dmg"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Sentry Studio" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"
if [ -n "${SIGN_IDENTITY:-}" ]; then
  codesign --force --timestamp --sign "$SIGN_IDENTITY" "$DMG"
  if [ -n "$NOTARIZE" ]; then
    notarize "$DMG"
    xcrun stapler staple "$DMG"
    spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG"
  fi
fi
# The .zip, made from the final app (signed, notarized and stapled above),
# and its update manifest, which lists the zip first, as electron-builder
# does. minimumSystemVersion is the Darwin version of
# LSMinimumSystemVersion (22 is macOS 13), so Electron Studio on an older
# macOS isn't offered an app that won't open.
ZIP="$OUT/SentryStudio-$VERSION-macOS.zip"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
python3 -I tools/update-manifest.py "$OUT/latest-mac.yml" "$VERSION" "$ZIP" "$DMG" --minimum-system-version 22.0.0
lipo -info "$APP/Contents/MacOS/sentry-studio"
ls -la "$OUT"
