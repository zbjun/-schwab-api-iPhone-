#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -s)" == Darwin ]] || { echo 'Requires macOS and Xcode.' >&2; exit 1; }
export EXPO_NO_DOTENV=1
export CI=1
OUTPUT="$PWD/build-output"
[[ ! -e "$OUTPUT" ]] || { echo 'Build output already exists.' >&2; exit 1; }
mkdir -p "$OUTPUT/diagnostics"
npm run typecheck 2>&1 | tee "$OUTPUT/diagnostics/typecheck.log"
npm test 2>&1 | tee "$OUTPUT/diagnostics/tests.log"
npx expo prebuild --platform ios --no-install 2>&1 | tee "$OUTPUT/diagnostics/prebuild.log"
(cd ios && pod install) 2>&1 | tee "$OUTPUT/diagnostics/pods.log"
# Release embeds the Hermes bundle; no Metro server or Expo Go is needed.
xcodebuild archive \
  -workspace ios/THS.xcworkspace -scheme THS -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$OUTPUT/THS.xcarchive" \
  -derivedDataPath "$OUTPUT/DerivedData" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  2>&1 | tee "$OUTPUT/diagnostics/archive.log"
APP="$OUTPUT/THS.xcarchive/Products/Applications/THS.app"
test -d "$APP"
test -s "$APP/main.jsbundle"
mkdir -p "$OUTPUT/package/Payload"
ditto "$APP" "$OUTPUT/package/Payload/THS.app"
(cd "$OUTPUT/package" && /usr/bin/zip -qry "$OUTPUT/THS-0.6.0-unsigned.ipa" Payload)
python3 scripts/verify-ipa.py "$OUTPUT/THS-0.6.0-unsigned.ipa" \
  --bundle-id app.personal.ths.expo --version 0.6.0 \
  | tee "$OUTPUT/diagnostics/ipa-verification.json"
shasum -a 256 "$OUTPUT/THS-0.6.0-unsigned.ipa"
