#!/bin/sh
# Build signed, notarized DMGs and zips for Apple Silicon and Intel into release/.
# Needs a "Developer ID Application" certificate in the keychain and notarytool
# credentials saved as a keychain profile:
#   xcrun notarytool store-credentials motion-notary --apple-id <id> --team-id <team>
# Override either with CSC_NAME / APPLE_KEYCHAIN_PROFILE (and APPLE_KEYCHAIN for a
# profile kept outside the login keychain, as the Release workflow does).
# Attach release/*.dmg, *.zip, *.blockmap and latest-mac.yml to the GitHub release:
# the auto-updater reads latest-mac.yml and downloads the zips.
set -e
export CSC_NAME="${CSC_NAME:-Earl Lee (29RGKF5J9D)}"
export APPLE_KEYCHAIN_PROFILE="${APPLE_KEYCHAIN_PROFILE:-motion-notary}"

npx electron-vite build
npx electron-builder --mac dmg zip --arm64 --x64 -c.mac.identity="$CSC_NAME" --publish never

# electron-builder notarizes the apps inside but leaves the DMGs unsigned; sign,
# notarize and staple them too so a downloaded DMG opens without a warning
for dmg in release/*.dmg; do
  codesign --force --timestamp --sign "Developer ID Application: $CSC_NAME" "$dmg"
  xcrun notarytool submit "$dmg" --keychain-profile "$APPLE_KEYCHAIN_PROFILE" ${APPLE_KEYCHAIN:+--keychain "$APPLE_KEYCHAIN"} --wait
  xcrun stapler staple "$dmg"
done
node scripts/update-feed.mjs release
