#!/usr/bin/env bash
# Set (or change) the dashboard username/password on the Lightsail host.
#
#   sudo bash /opt/coinpilot/app/ops/lightsail/set-dashboard-login.sh [username]
#
# Asks for the password twice without echoing, stores only its scrypt hash in
# both the paper (/etc/coinpilot.env) and LIVE (/etc/coinpilot/coinpilot-live.env)
# env files, gives each server an operator token if it has none, validates
# each file, and restarts both services. Saved app and browser sessions keep
# working: the login hands out the existing tokens.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "sudo로 실행해 주세요." >&2
  exit 1
fi

APP_DIR="${COINPILOT_APP_DIR:-/opt/coinpilot/app}"
PAPER_ENV="${COINPILOT_PAPER_ENV:-/etc/coinpilot.env}"
LIVE_ENV="${COINPILOT_LIVE_ENV:-/etc/coinpilot/coinpilot-live.env}"
SERVICES=(coinpilot.service coinpilot-live.service)

USERNAME="${1:-}"
if [[ -z "$USERNAME" ]]; then
  read -r -p "아이디: " USERNAME
fi
if [[ ! "$USERNAME" =~ ^[A-Za-z0-9._@-]{1,64}$ ]]; then
  echo "아이디는 영문·숫자·._@- 로 1~64자여야 합니다." >&2
  exit 1
fi

HASH_LINE="$(cd "$APP_DIR" && node src/scripts/hashDashboardPassword.js)"
HASH="${HASH_LINE#DASHBOARD_LOGIN_PASSWORD_HASH=}"
if [[ ! "$HASH" =~ ^scrypt:[0-9]+:[0-9]+:[0-9]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$ ]]; then
  echo "비밀번호 해시를 만들지 못했습니다." >&2
  exit 1
fi

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
  cp -p "$file" "$file.bak-login-$(date +%Y%m%d%H%M%S)"
  # One sign-in controls both workspaces from the browser too, so each server
  # needs an operator token for the login to hand out. A mobile-only LIVE
  # profile gets its own random one (never Paper's).
  if ! grep -q '^DASHBOARD_TOKEN=.\+' "$file"; then
    set_key "$file" DASHBOARD_TOKEN "$(openssl rand -hex 32)"
  fi
  set_key "$file" DASHBOARD_LOGIN_USERNAME "$USERNAME"
  set_key "$file" DASHBOARD_LOGIN_PASSWORD_HASH "$HASH"
  # Fail before restarting anything if the file no longer validates.
  (cd "$APP_DIR" && ENV_FILE="$file" node --input-type=module -e "
    import fs from 'node:fs';
    import dotenv from 'dotenv';
    import { loadEnv } from './src/config/envLoader.js';
    import { resolveDashboardAuth } from './src/api/auth.js';
    const values = dotenv.parse(fs.readFileSync(process.env.ENV_FILE));
    const { errors } = loadEnv(values);
    if (errors.length) { console.error(errors.map(e => e.key + ': ' + e.message).join('\\n')); process.exit(1); }
    if (!resolveDashboardAuth(values).passwordLogin) { console.error('password login not active'); process.exit(1); }
  ") || { echo "검증 실패: $file (백업 파일로 되돌릴 수 있습니다)" >&2; exit 1; }
done

systemctl restart "${SERVICES[@]}"
sleep 3
systemctl is-active "${SERVICES[@]}"
echo "완료: 아이디 '$USERNAME'로 웹과 앱에서 로그인할 수 있습니다 (모의·실전 공통)."
