#!/usr/bin/env bash
# Apply memory priorities, journald cap, swappiness and nginx rate limits.
#   sudo bash /opt/coinpilot/app/ops/lightsail/apply-host-hardening.sh
# Services are not restarted here; OOMScoreAdjust takes effect on their next start.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "sudo로 실행해 주세요." >&2; exit 1; }
SRC="$(cd "$(dirname "$0")/.." && pwd)"

for unit in coinpilot coinpilot-live coinpilot-upbit-rate; do
  install -D -m 644 "$SRC/systemd/dropins/$unit.service.d/10-memory.conf" "/etc/systemd/system/$unit.service.d/10-memory.conf"
done
systemctl daemon-reload

install -D -m 644 "$SRC/host/journald-coinpilot.conf" /etc/systemd/journald.conf.d/coinpilot.conf
systemctl restart systemd-journald
journalctl --vacuum-size=300M >/dev/null

install -D -m 644 "$SRC/host/sysctl-coinpilot.conf" /etc/sysctl.d/90-coinpilot.conf
sysctl -q -p /etc/sysctl.d/90-coinpilot.conf

stamp="$(date +%Y%m%d%H%M%S)"
cp -p /etc/nginx/sites-available/coinpilot-http "/etc/nginx/sites-available/coinpilot-http.bak-$stamp"
cp -p /etc/nginx/snippets/coinpilot-live-location.conf "/etc/nginx/snippets/coinpilot-live-location.conf.bak-$stamp"
install -m 644 "$SRC/nginx/coinpilot-rate-limit.conf" /etc/nginx/conf.d/coinpilot-rate-limit.conf
install -m 644 "$SRC/nginx/coinpilot-http.conf" /etc/nginx/sites-available/coinpilot-http
install -m 644 "$SRC/nginx/coinpilot-live-location.conf" /etc/nginx/snippets/coinpilot-live-location.conf
if ! nginx -t; then
  cp -p "/etc/nginx/sites-available/coinpilot-http.bak-$stamp" /etc/nginx/sites-available/coinpilot-http
  cp -p "/etc/nginx/snippets/coinpilot-live-location.conf.bak-$stamp" /etc/nginx/snippets/coinpilot-live-location.conf
  rm -f /etc/nginx/conf.d/coinpilot-rate-limit.conf
  echo "nginx 설정 검증 실패 — 이전 설정으로 되돌렸습니다." >&2
  exit 1
fi
systemctl reload nginx
echo "완료: 메모리 우선순위(다음 시작부터), journald 300M, swappiness $(cat /proc/sys/vm/swappiness), nginx 요청 제한"
