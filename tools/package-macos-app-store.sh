#!/bin/sh
# Builds Sentry Studio for the Mac App Store: a universal app built with
# the app-store feature (sandboxed, no updater of its own), signed for the
# App Store with its provisioning profile, in an installer package, and
# uploaded to App Store Connect when asked.
#
#   tools/package-macos-app-store.sh
#
#   PROVISIONING_PROFILE  the Mac App Store provisioning profile
#                         (.provisionprofile) for com.sentry-six.revamped
#   APP_IDENTITY          default "3rd Party Mac Developer Application: Scott
#                         Vandereems (6733Y82885)" (or an "Apple
#                         Distribution" identity)
#   INSTALLER_IDENTITY    default "3rd Party Mac Developer Installer: Scott
#                         Vandereems (6733Y82885)"
#   BUILD_NUMBER          CFBundleVersion (default: the version, at most three
#                         numbers); App Store Connect takes each only once
#   UPLOAD=1 with APPLE_API_KEY_ID and APPLE_API_ISSUER: validates and
#                         uploads the package (altool finds the key as
#                         private_keys/AuthKey_<id>.p8 in ~ or ~/.appstoreconnect)
#   LOCAL=1               signs ad hoc with the sandbox instead (no profile,
#                         no package): to try the sandboxed app on this Mac
#
# Output: target/macos-app-store/Sentry Studio.app and
#         target/macos-app-store/SentryStudio-<version>-AppStore.pkg
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd)
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
BUNDLE_ID=com.sentry-six.revamped
TEAM_ID=6733Y82885
OUT="$ROOT/target/macos-app-store"
APP="$OUT/Sentry Studio.app"
APP_IDENTITY=${APP_IDENTITY:-"3rd Party Mac Developer Application: Scott Vandereems ($TEAM_ID)"}
INSTALLER_IDENTITY=${INSTALLER_IDENTITY:-"3rd Party Mac Developer Installer: Scott Vandereems ($TEAM_ID)"}

if [ -z "${LOCAL:-}" ] && [ ! -f "${PROVISIONING_PROFILE:-}" ]; then
  echo "PROVISIONING_PROFILE must name the Mac App Store provisioning profile (or LOCAL=1 to try it here)" >&2
  exit 1
fi

cargo build --release --features app-store --target aarch64-apple-darwin
cargo build --release --features app-store --target x86_64-apple-darwin

rm -rf "$OUT"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
lipo -create \
  target/aarch64-apple-darwin/release/sentry-studio \
  target/x86_64-apple-darwin/release/sentry-studio \
  -output "$APP/Contents/MacOS/sentry-studio"
cp assets/icons/sentry-studio.icns "$APP/Contents/Resources/AppIcon.icns"
cp LICENSE.txt THIRD-PARTY-NOTICES.txt "$APP/Contents/Resources/"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Sentry Studio</string>
  <key>CFBundleDisplayName</key><string>Sentry Studio</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleExecutable</key><string>sentry-studio</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>${BUILD_NUMBER:-$VERSION}</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.video</string>
  <key>NSHighResolutionCapable</key><true/>
  <!-- HTTPS only: exempt from export compliance questions. -->
  <key>ITSAppUsesNonExemptEncryption</key><false/>
</dict>
</plist>
PLIST

ENTITLEMENTS="$OUT/app.entitlements"
if [ -n "${LOCAL:-}" ]; then
  # Ad hoc: the sandbox without the App ID (which needs the profile).
  sed -e '/application-identifier/d' -e '/team-identifier/d' assets/macos/app-store.entitlements > "$ENTITLEMENTS"
  codesign --force --sign - --entitlements "$ENTITLEMENTS" "$APP"
  codesign -d --entitlements - "$APP" 2>/dev/null | grep -c app-sandbox >/dev/null
  echo "Sandboxed test app: $APP"
  exit 0
fi

sed -e "s/TEAM_ID/$TEAM_ID/g" -e "s/BUNDLE_ID/$BUNDLE_ID/g" assets/macos/app-store.entitlements > "$ENTITLEMENTS"
cp "$PROVISIONING_PROFILE" "$APP/Contents/embedded.provisionprofile"
codesign --force --options runtime --sign "$APP_IDENTITY" --entitlements "$ENTITLEMENTS" "$APP"
codesign --verify --strict --verbose=2 "$APP"

PKG="$OUT/SentryStudio-$VERSION-AppStore.pkg"
productbuild --component "$APP" /Applications --sign "$INSTALLER_IDENTITY" "$PKG"
pkgutil --check-signature "$PKG" | head -3

if [ -n "${UPLOAD:-}" ]; then
  : "${APPLE_API_KEY_ID:?}" "${APPLE_API_ISSUER:?}"
  xcrun altool --validate-app -f "$PKG" -t macos --apiKey "$APPLE_API_KEY_ID" --apiIssuer "$APPLE_API_ISSUER"
  xcrun altool --upload-app -f "$PKG" -t macos --apiKey "$APPLE_API_KEY_ID" --apiIssuer "$APPLE_API_ISSUER"
fi
ls -la "$OUT"
