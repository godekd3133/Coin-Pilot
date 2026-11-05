#!/usr/bin/env bash
# Register (or replace) the Toss Securities Open API keys on the Lightsail host.
#
#   sudo bash /opt/coinpilot/app/ops/lightsail/set-toss-keys.sh [--live]
#
# Reads two lines from stdin: client_id, then client_secret (asked without echo
# on a terminal). Writes them to both env files, enables stock trading, checks
# from this host that the keys issue a token and can read the account (this is
# also the IP-allowlist check), then restarts both services.
#
# Paper server -> stock paper (live quotes, local fills).
# LIVE server  -> stock LIVE orders only with --live; otherwise it stays off so
#                 registering keys never starts real-money stock orders by itself.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "sudo로 실행해 주세요." >&2
  exit 1
fi

ENABLE_LIVE=false
[[ "${1:-}" == "--live" ]] && ENABLE_LIVE=true

APP_DIR="${COINPILOT_APP_DIR:-/opt/coinpilot/app}"
PAPER_ENV="${COINPILOT_PAPER_ENV:-/etc/coinpilot.env}"
LIVE_ENV="${COINPILOT_LIVE_ENV:-/etc/coinpilot/coinpilot-live.env}"
SERVICES=(coinpilot.service coinpilot-live.service)

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

for file in "$PAPER_ENV" "$LIVE_ENV"; do
  [[ -f "$file" ]] || { echo "env 파일이 없습니다: $file" >&2; exit 1; }
  cp -p "$file" "$file.bak-toss-$(date +%Y%m%d%H%M%S)"
  set_key "$file" TOSS_CLIENT_ID "$CLIENT_ID"
  set_key "$file" TOSS_CLIENT_SECRET "$CLIENT_SECRET"
  set_key "$file" STOCK_TRADING_ENABLED true
done
set_key "$PAPER_ENV" STOCK_PAPER_ENABLED true
set_key "$PAPER_ENV" STOCK_LIVE_ENABLED false
set_key "$LIVE_ENV" STOCK_PAPER_ENABLED false
set_key "$LIVE_ENV" STOCK_LIVE_ENABLED "$ENABLE_LIVE"

for file in "$PAPER_ENV" "$LIVE_ENV"; do
  (cd "$APP_DIR" && ENV_FILE="$file" node --input-type=module -e "
    import fs from 'node:fs';
    import dotenv from 'dotenv';
    import { loadEnv } from './src/config/envLoader.js';
    const { errors } = loadEnv(dotenv.parse(fs.readFileSync(process.env.ENV_FILE)));
    if (errors.length) { console.error(errors.map(e => e.key + ': ' + e.message).join('\\n')); process.exit(1); }
  ") || { echo "검증 실패: $file (백업 파일로 되돌릴 수 있습니다)" >&2; exit 1; }
done

systemctl restart "${SERVICES[@]}"
sleep 3
systemctl is-active "${SERVICES[@]}"
echo "완료: 주식 모의투자 활성화, 주식 실전 주문 ${ENABLE_LIVE}."
