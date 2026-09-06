#!/usr/bin/env bash
# EAS custom build entry point. Uses Xcode directly; no Expo/RN/CocoaPods step.
set -euo pipefail

TASK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$TASK_ROOT"
OUTPUT="$TASK_ROOT/artifacts/eas-native"
DIAGNOSTICS="$OUTPUT/diagnostics"
RESULT="$DIAGNOSTICS/THSTests.xcresult"
APP_BUNDLE_ID="app.personal.ths"
STAGE="validate"
TEST_STATUS="not_run"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# EAS receives no artifacts directory. Refuse to mix in an earlier local build.
if [[ -e "$OUTPUT" ]]; then
  printf '%s\n' 'artifacts/eas-native already exists; use a clean checkout.' >&2
  exit 1
fi
mkdir -p "$DIAGNOSTICS"

finish() {
  local build_status=$?
  local attachments_status=0
  trap - EXIT
  set +e
  if [[ -d "$RESULT" ]]; then
    xcrun xcresulttool export attachments \
      --path "$RESULT" --output-path "$DIAGNOSTICS/ui-screenshots" \
      > "$DIAGNOSTICS/attachments.log" 2>&1
    attachments_status=$?
    if [[ "$attachments_status" -ne 0 ]]; then
      printf '%s\n' 'Native attachment export failed; consult attachments.log.' >&2
      if [[ "$build_status" -eq 0 ]]; then build_status=$attachments_status; fi
    fi
  fi
  python3 - "$DIAGNOSTICS/build-status.json" "$build_status" "$STAGE" \
    "$TEST_STATUS" "$attachments_status" "$STARTED_AT" <<'PY'
import datetime
import json
from pathlib import Path
import sys

output, status, stage, tests, attachments, started = sys.argv[1:]
Path(output).write_text(json.dumps({
    "exit_code": int(status),
    "last_stage": stage,
    "native_tests": tests,
    "attachment_export_exit_code": int(attachments),
    "started_at": started,
    "finished_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "signing_requested": "unsigned",
    "ipa_verification": "passed" if stage == "complete" else "not_completed",
    "personal_configuration": "excluded" if stage == "complete" else "not_verified",
}, indent=2) + "\n", encoding="utf-8")
PY
  local report_status=$?
  if [[ "$build_status" -eq 0 && "$report_status" -ne 0 ]]; then
    build_status=$report_status
  fi
  exit "$build_status"
}
trap finish EXIT

[[ "$(uname -s)" == Darwin ]] || { printf '%s\n' 'This build requires macOS and Xcode.' >&2; exit 1; }
node tools/ios/generate-project.mjs --check
xcodebuild -version | tee "$DIAGNOSTICS/xcode-version.log"
plutil -lint ios/THS/Info.plist ios/THS.xcodeproj/project.pbxproj

STAGE="select_simulator"
python3 tools/ios/select-simulator.py > "$DIAGNOSTICS/simulator.txt"
SIMULATOR_UDID="$(sed -n 's/^SIMULATOR_UDID=//p' "$DIAGNOSTICS/simulator.txt")"
[[ "$SIMULATOR_UDID" =~ ^[A-Fa-f0-9-]+$ ]] || { printf '%s\n' 'Invalid simulator identifier.' >&2; exit 1; }

STAGE="test"
TEST_STATUS="failed_or_interrupted"
xcodebuild test \
  -project ios/THS.xcodeproj -scheme THS -configuration Debug \
  -destination "platform=iOS Simulator,id=$SIMULATOR_UDID" \
  -parallel-testing-enabled NO \
  -test-timeouts-enabled YES \
  -default-test-execution-time-allowance 90 \
  -maximum-test-execution-time-allowance 600 \
  -resultBundlePath "$RESULT" \
  CODE_SIGNING_ALLOWED=NO 2>&1 | tee "$DIAGNOSTICS/tests.log"
TEST_STATUS="passed"

STAGE="archive"
xcodebuild archive \
  -project ios/THS.xcodeproj -scheme THS -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$OUTPUT/THS.xcarchive" \
  "PRODUCT_BUNDLE_IDENTIFIER=$APP_BUNDLE_ID" \
  CODE_SIGNING_ALLOWED=NO 2>&1 | tee "$DIAGNOSTICS/archive.log"

STAGE="package"
mkdir -p "$OUTPUT/package/Payload"
ditto "$OUTPUT/THS.xcarchive/Products/Applications/THS.app" "$OUTPUT/package/Payload/THS.app"
APP_INFO="$OUTPUT/package/Payload/THS.app/Info.plist"
APP_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_INFO")"
APP_BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP_INFO")"
(
  cd "$OUTPUT/package"
  zip -qry ../THS-unsigned.ipa Payload
)

STAGE="verify_ipa"
python3 tools/ios/verify-ipa.py "$OUTPUT/THS-unsigned.ipa" \
  --version "$APP_VERSION" --build "$APP_BUILD" --bundle-id "$APP_BUNDLE_ID" \
  --output "$DIAGNOSTICS/ipa-verification.json"
(
  cd "$OUTPUT"
  shasum -a 256 THS-unsigned.ipa > diagnostics/THS-unsigned.ipa.sha256
)
STAGE="complete"
printf '%s\n' 'Native tests and unsigned IPA verification passed. No signing or personal setup was applied.'
