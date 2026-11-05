#!/usr/bin/env bash
# Register (or replace) the Toss Securities Open API keys on the Lightsail host.
#
#   sudo bash /opt/coinpilot/app/ops/lightsail/set-toss-keys.sh [--live]
#
# Reads two lines from stdin: client_id, then client_secret (asked without echo
# on a terminal). Checks from this host that the keys issue a token and can read
# the account (this is also the IP-allowlist check), then writes them to ONE
# env file and restarts only that service.
#
# Toss keeps one valid access token per client: two services sharing a
# client_id revoke each other's token on every refresh (a mutual 401 loop). So
# a client_id lives on exactly one server; register a second app's keys for the
# other one.
#
#   (default) -> paper server, stock paper (live quotes, local fills)
#   --live    -> LIVE server, real-money stock orders
# If the other server already holds this same client_id, its keys are removed
# and its stock trading is turned off.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "sudo로 실행해 주세요." >&2
  exit 1
fi

ENABLE_LIVE=false
[[ "${1:-}" == "--live" ]] && ENABLE_LIVE=true

TARGET=paper
[[ "$ENABLE_LIVE" == true ]] && TARGET=live

APP_DIR="${COINPILOT_APP_DIR:-/opt/coinpilot/app}"
PAPER_ENV="${COINPILOT_PAPER_ENV:-/etc/coinpilot.env}"
LIVE_ENV="${COINPILOT_LIVE_ENV:-/etc/coinpilot/coinpilot-live.env}"
if [[ "$TARGET" == live ]]; then
  TARGET_ENV="$LIVE_ENV"; OTHER_ENV="$PAPER_ENV"
  TARGET_SERVICE=coinpilot-live.service; OTHER_SERVICE=coinpilot.service
else
  TARGET_ENV="$PAPER_ENV"; OTHER_ENV="$LIVE_ENV"
  TARGET_SERVICE=coinpilot.service; OTHER_SERVICE=coinpilot-live.service
fi
SERVICES=("$TARGET_SERVICE")

if [[ -t 0 ]]; then
  read -r -s -p "토스 client_id: " CLIENT_ID; echo
  read -r -s -p "토스 client_secret: " CLIENT_SECRET; echo
else
  IFS= read -r CLIENT_ID || true
  IFS= read -r CLIENT_SECRET || true
fi
CLIENT_ID="${CLIENT_ID//[[:space:]]/}"
CLIENT_SECRET="${CLIENT_SECRET//[[:space:]]/}"
if [[ ! "$CLIENT_ID" =~ ^[A-Za-z0-9._-]{8,256}$ || ! "$CLIENT_SECRET" =~ ^[A-Za-z0-9._~+/=-]{8,512}$ ]]; then
  echo "client_id/client_secret 형식이 올바르지 않습니다." >&2
  exit 1
fi

# Verify from this host before touching any env file.
(cd "$APP_DIR" && TOSS_CLIENT_ID="$CLIENT_ID" TOSS_CLIENT_SECRET="$CLIENT_SECRET" node --input-type=module -e "
  import { TossInvestClient } from './src/stock/tossInvestClient.js';
  const client = new TossInvestClient({ clientId: process.env.TOSS_CLIENT_ID, clientSecret: process.env.TOSS_CLIENT_SECRET });
  try {
    await client.getAccessToken();
  } catch (error) {
    console.error('토큰 발급 실패 (키 확인 필요): ' + error.message);
    process.exit(1);
  }
  try {
    const accounts = await client.getAccounts();
    console.log('토스 계좌 확인: ' + (Array.isArray(accounts) ? accounts.length : 0) + '개');
  } catch (error) {
    console.error('계좌 조회 실패 (서버 IP 52.78.156.161 허용 목록 등록 필요할 수 있음): ' + error.message);
    process.exit(1);
  }
") || exit 1

set_key() {
  local file="$1" key="$2" value="$3"
  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

for file in "$TARGET_ENV" "$OTHER_ENV"; do
  [[ -f "$file" ]] || { echo "env 파일이 없습니다: $file" >&2; exit 1; }
done
STAMP="$(date +%Y%m%d%H%M%S)"
cp -p "$TARGET_ENV" "$TARGET_ENV.bak-toss-$STAMP"
set_key "$TARGET_ENV" TOSS_CLIENT_ID "$CLIENT_ID"
set_key "$TARGET_ENV" TOSS_CLIENT_SECRET "$CLIENT_SECRET"
set_key "$TARGET_ENV" STOCK_TRADING_ENABLED true
if [[ "$TARGET" == live ]]; then
  set_key "$TARGET_ENV" STOCK_PAPER_ENABLED false
  set_key "$TARGET_ENV" STOCK_LIVE_ENABLED true
else
  set_key "$TARGET_ENV" STOCK_PAPER_ENABLED true
  set_key "$TARGET_ENV" STOCK_LIVE_ENABLED false
fi

# Same client_id on the other server -> remove it there (one token per client).
if grep -qx "TOSS_CLIENT_ID=${CLIENT_ID}" "$OTHER_ENV"; then
  cp -p "$OTHER_ENV" "$OTHER_ENV.bak-toss-$STAMP"
  sed -i '/^TOSS_CLIENT_ID=/d; /^TOSS_CLIENT_SECRET=/d' "$OTHER_ENV"
  set_key "$OTHER_ENV" STOCK_TRADING_ENABLED false
  set_key "$OTHER_ENV" STOCK_PAPER_ENABLED false
  set_key "$OTHER_ENV" STOCK_LIVE_ENABLED false
  SERVICES+=("$OTHER_SERVICE")
  echo "같은 client_id가 다른 서버($OTHER_SERVICE)에 있어 그쪽 키를 지우고 주식 거래를 껐습니다."
fi

for file in "$TARGET_ENV" "$OTHER_ENV"; do
  (cd "$APP_DIR" && ENV_FILE="$file" node --input-type=module -e "
    import fs from 'node:fs';
    import dotenv from 'dotenv';
    import { loadEnv } from './src/config/envLoader.js';
    const { errors } = loadEnv(dotenv.parse(fs.readFileSync(process.env.ENV_FILE)));
    if (errors.length) { console.error(errors.map(e => e.key + ': ' + e.message).join('\\n')); process.exit(1); }
  ") || { echo "검증 실패: $file (백업 파일로 되돌릴 수 있습니다)" >&2; exit 1; }
done

# --no-block: LIVE drains open coin positions before it stops (TimeoutStopSec=infinity).
systemctl restart --no-block "${SERVICES[@]}"
sleep 3
systemctl is-active "${SERVICES[@]}" || true
echo "완료: 토스 키를 ${TARGET_SERVICE}에만 등록했습니다 (주식 실전 주문 ${ENABLE_LIVE})."
