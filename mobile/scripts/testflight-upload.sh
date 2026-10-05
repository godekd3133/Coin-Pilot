#!/usr/bin/env bash
# CoinPilot iOS → TestFlight one-shot release.
#
# Bump CURRENT_PROJECT_VERSION, archive a signed Release build, export the
# App Store Connect IPA, and upload it in one run.
#
# Requires ~/.config/kbo-fans/secrets/appstoreconnect/kbo-fans-testflight.env
# with ASC_ISSUER_ID / ASC_KEY_ID / ASC_KEY_PATH for an account-level
# App Store Connect API key (team A23ZPKGMW9).
#
# Optional env:
#   COINPILOT_DATA_MODE      build-time data mode (default: server)
#   COINPILOT_PAPER_SERVER   bundled Paper dashboard URL (default: https://52.78.156.161)
#   COINPILOT_LIVE_SERVER    bundled LIVE dashboard URL (default: https://52.78.156.161/live)
#   COINPILOT_BUILD_NUMBER   use an explicitly prepared build number instead
#                            of incrementing it (for a committed release)
#   Server-profile releases reuse Keychain authentication. Production tokens
#   and the developer's LocalSecrets.json are never packaged in TestFlight.
#   KEEP_IPA=1               keep the exported IPA in ./artifacts/testflight
set -euo pipefail

cd "$(dirname "$0")/.."
IOS_DIR="ios/App"
PBXPROJ="$IOS_DIR/App.xcodeproj/project.pbxproj"
SCHEME="App"
CONFIG="Release"
TEAM_ID="A23ZPKGMW9"

ASC_ENV="$HOME/.config/kbo-fans/secrets/appstoreconnect/kbo-fans-testflight.env"
if [[ ! -f "$ASC_ENV" ]]; then
  echo "Missing App Store Connect API env: $ASC_ENV" >&2
  echo "Expected keys: ASC_ISSUER_ID, ASC_KEY_ID, ASC_KEY_PATH" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$ASC_ENV"
: "${ASC_ISSUER_ID:?ASC_ISSUER_ID is required}"
: "${ASC_KEY_ID:?ASC_KEY_ID is required}"
: "${ASC_KEY_PATH:?ASC_KEY_PATH is required}"

COINPILOT_DATA_MODE="${COINPILOT_DATA_MODE:-server}"
COINPILOT_PAPER_SERVER="${COINPILOT_PAPER_SERVER:-https://52.78.156.161}"
COINPILOT_LIVE_SERVER="${COINPILOT_LIVE_SERVER:-https://52.78.156.161/live}"

# Validate the release endpoints before changing the build number. Local
# development credentials must not override the public release configuration.
if [[ "$COINPILOT_DATA_MODE" == "server" ]]; then
  python3 - "$COINPILOT_PAPER_SERVER" "$COINPILOT_LIVE_SERVER" <<'PY'
import ipaddress, sys, urllib.parse
identities = []
for address in sys.argv[1:]:
    url = urllib.parse.urlsplit(address)
    if (url.scheme != 'https' or not url.hostname or url.username or url.password
            or url.query or url.fragment or url.path not in ('', '/', '/live', '/live/')):
        raise SystemExit('Release server addresses must be public HTTPS dashboard URLs.')
    host = url.hostname.lower().rstrip('.')
    try:
        port = url.port if url.port is not None else 443
    except ValueError:
        raise SystemExit('Release server port must be an integer from 1 to 65535.')
    if port < 1 or host == 'localhost' or host.endswith(('.local', '.localhost')):
        raise SystemExit('A TestFlight release cannot use a local development server.')
    try:
        if not ipaddress.ip_address(host).is_global:
            raise SystemExit('A TestFlight release cannot use a private IP address.')
    except ValueError:
        pass
    identities.append((host, port, url.path.rstrip('/')))
if identities[0] == identities[1]:
    raise SystemExit('Paper and LIVE must use separate endpoints.')
PY
fi

# --- Bump CURRENT_PROJECT_VERSION for both configurations -------------------
CURRENT=$(grep -o 'CURRENT_PROJECT_VERSION = [0-9]*;' "$PBXPROJ" | head -1 | grep -o '[0-9]*')
NEXT="${COINPILOT_BUILD_NUMBER:-$((CURRENT + 1))}"
if [[ ! "$NEXT" =~ ^[1-9][0-9]*$ ]] || [[ "$NEXT" -lt "$CURRENT" ]]; then
  echo "Build number must be a positive integer at least $CURRENT." >&2
  exit 1
fi
sed -i '' "s/CURRENT_PROJECT_VERSION = [0-9]*;/CURRENT_PROJECT_VERSION = $NEXT;/g" "$PBXPROJ"
echo "==> Build number $CURRENT -> $NEXT"

MARKETING=$(grep -o 'MARKETING_VERSION = [0-9.]*;' "$PBXPROJ" | head -1 | grep -o '[0-9.]*')
STAMP="$(date +%Y%m%d-%H%M%S)"
WORK=/tmp/coinpilot-testflight-$NEXT
ARCHIVE="$WORK/App.xcarchive"
EXPORT_DIR="$WORK/export"
mkdir -p "$WORK"

cat > "$WORK/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>app-store-connect</string>
	<key>teamID</key>
	<string>$TEAM_ID</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>destination</key>
	<string>upload</string>
	<key>uploadSymbols</key>
	<false/>
	<key>stripSwiftSymbols</key>
	<true/>
</dict>
</plist>
EOF

# --- Archive ----------------------------------------------------------------
BUILD_SETTINGS=(
  "COINPILOT_DATA_MODE=$COINPILOT_DATA_MODE"
  "COINPILOT_PAPER_SERVER=$COINPILOT_PAPER_SERVER"
  "COINPILOT_LIVE_SERVER=$COINPILOT_LIVE_SERVER"
  "COINPILOT_SECRETS_FILE="
  "COINPILOT_DEFAULT_TOKEN="
)

echo "==> Archiving CoinPilot $MARKETING ($NEXT) — mode=$COINPILOT_DATA_MODE"
xcodebuild -project "$IOS_DIR/App.xcodeproj" -scheme "$SCHEME" \
  -configuration "$CONFIG" \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$ASC_KEY_PATH" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID" \
  "${BUILD_SETTINGS[@]}" \
  archive 2>&1 | tee "$WORK/archive.log" | tail -5

test -d "$ARCHIVE/Products/Applications/App.app" || { echo "Archive output missing" >&2; exit 1; }

# Check the actual artifact, since a successful archive alone cannot prove
# that the server profile points at the intended public endpoints.
python3 - "$ARCHIVE/Products/Applications/App.app" "$COINPILOT_DATA_MODE" "$COINPILOT_PAPER_SERVER" "$COINPILOT_LIVE_SERVER" "$NEXT" "$MARKETING" <<'PY'
import pathlib, plistlib, sys
app = pathlib.Path(sys.argv[1])
info = plistlib.loads((app / 'Info.plist').read_bytes())
if info.get('CFBundleVersion') != sys.argv[5] or info.get('CFBundleShortVersionString') != sys.argv[6]:
    raise SystemExit('Release archive version does not match the prepared release.')
if (app / 'CoinPilotLocalSecrets.json').exists() or info.get('CoinPilotDefaultToken'):
    raise SystemExit('Release archive unexpectedly contains developer credentials.')
if info.get('CoinPilotDataMode') != sys.argv[2]:
    raise SystemExit('Release archive data mode does not match the requested mode.')
if sys.argv[2] == 'server':
    expected = {'CoinPilotPaperServerAddress': sys.argv[3], 'CoinPilotLiveServerAddress': sys.argv[4]}
    for key, value in expected.items():
        if info.get(key) != value:
            raise SystemExit('Release archive server configuration does not match: ' + key)
    print('Verified release endpoints: Paper ' + sys.argv[3] + ', LIVE ' + sys.argv[4])
print('Verified release archive excludes developer credentials.')
PY

# --- Export + upload to App Store Connect -----------------------------------
echo "==> Uploading to App Store Connect (TestFlight)"
xcodebuild -exportArchive -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$WORK/ExportOptions.plist" \
  -authenticationKeyPath "$ASC_KEY_PATH" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID" \
  2>&1 | tee "$WORK/upload.log" | tail -10

if [[ "${KEEP_IPA:-0}" == "1" && -f "$EXPORT_DIR/App.ipa" ]]; then
  mkdir -p artifacts/testflight
  cp "$EXPORT_DIR/App.ipa" "artifacts/testflight/CoinPilot-$MARKETING-b$NEXT-$STAMP.ipa"
  echo "==> IPA kept at artifacts/testflight/CoinPilot-$MARKETING-b$NEXT-$STAMP.ipa"
fi

echo "==> Done. CoinPilot $MARKETING ($NEXT) submitted to TestFlight."
echo "    Processing takes a few minutes; internal testers can install without review once VALID."

# 업로드만으로는 테스터에게 안 보인다 — internal 베타 그룹에 배정해야 한다.
# 방금 올린 빌드가 ASC에 등록될 때까지 스크립트가 폴링한다.
node scripts/asc-assign-internal-group.mjs "$NEXT"
