#!/usr/bin/env bash
# coinpilot-live 배포 호스트 사전/사후 검증 스크립트.
# 대상: 52.78.156.161 (coinpilot-paper-seoul) — 같은 호스트에서 실행하거나
# SSH로 붙어 실행한다. 각 항목은 PASS/WARN/FAIL로 출력된다.
#
# 사용: bash ops/lightsail/verify-live-host.sh
set -u

pass() { printf 'PASS  %s\n' "$1"; }
warn() { printf 'WARN  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; }

echo "== CoinPilot LIVE host verification =="

# 1. Node.js — /usr/bin/node가 24.21.0+ 여야 한다 (LIVE unit의 ExecStart/ExecStartPre 경로)
if [ -x /usr/bin/node ]; then
  node_ver=$(/usr/bin/node -e 'console.log(process.versions.node.split(".").map(Number))' 2>/dev/null || echo "0")
  node_major=$(/usr/bin/node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo "0")
  node_minor=$(/usr/bin/node -e 'console.log(process.versions.node.split(".")[1])' 2>/dev/null || echo "0")
  if [ "$node_major" -ge 25 ] || { [ "$node_major" -eq 24 ] && [ "$node_minor" -ge 21 ]; }; then
    pass "Node.js /usr/bin/node $(/usr/bin/node --version) >= 24.21.0"
  else
    fail "Node.js /usr/bin/node $(/usr/bin/node --version) < 24.21.0 — verifyNodeRuntime이 기동을 거부한다"
  fi
else
  fail "/usr/bin/node 없음 — LIVE unit의 ExecStart 경로가 존재하지 않는다 (현재 /usr/local/bin/node $(/usr/local/bin/node --version 2>/dev/null || echo missing))"
fi

# 2. 메모리 헤드룸 — 0.5GB nano에 LIVE 프로세스를 얹을 여유
avail_mb=$(free -m | awk '/^Mem:/{print $7}')
node_rss_mb=$(ps aux | awk '/[n]ode .*src\/index\.js/{s+=$6} END{print int(s/1024)}')
if [ "${avail_mb:-0}" -ge 200 ]; then
  pass "available memory ${avail_mb}MB (live node rss 현재 ${node_rss_mb}MB)"
elif [ "${avail_mb:-0}" -ge 100 ]; then
  warn "available memory ${avail_mb}MB — 0.5GB nano에서 LIVE 추가 시 여유가 얇다 (Micro 리사이즈 권장)"
else
  fail "available memory ${avail_mb}MB — LIVE 프로세스를 얹을 여유가 없다"
fi
if sudo -n true 2>/dev/null; then
  oom_kills=$(sudo journalctl -k --since "7 days ago" --no-pager 2>/dev/null | grep -ci "oom" || true)
  proc_kills=$(sudo journalctl -u coinpilot.service --since "7 days ago" --no-pager 2>/dev/null | grep -c "status=9/KILL" || true)
  [ "${proc_kills:-0}" -gt 0 ] && warn "coinpilot.service가 최근 7일 내 status=9/KILL ${proc_kills}회 — OOM 또는 수동 kill 확인 필요" || pass "7일 내 coinpilot 강제 종료 없음"
else
  echo "INFO  sudo 없음 — OOM 이력(journalctl) 건너뜀"
fi

# 3. systemd 유닛 존재/계약
for unit in coinpilot-live coinpilot-upbit-rate; do
  if systemctl cat "${unit}.service" >/dev/null 2>&1; then
    unit_file=$(systemctl show "${unit}.service" -p FragmentPath --value)
    if grep -q "^TimeoutStopSec=infinity" "$unit_file" 2>/dev/null || [ "$unit" = "coinpilot-upbit-rate" ]; then
      pass "${unit}.service 설치됨 ($(systemctl is-active ${unit}.service 2>/dev/null))"
    else
      [ "$unit" = "coinpilot-live" ] && warn "${unit}.service 설치됐지만 TimeoutStopSec=infinity 없음 — 보호 drain이 강제 종료될 수 있다"
    fi
  else
    warn "${unit}.service 미설치"
  fi
done
if systemctl cat coinpilot-live.service >/dev/null 2>&1; then
  systemctl show coinpilot-live.service -p Requires --value | grep -q coinpilot-upbit-rate \
    && pass "coinpilot-live가 coinpilot-upbit-rate를 Requires로 선언" \
    || fail "coinpilot-live가 rate coordinator를 Requires로 선언하지 않음 — 같은 IP 쿼터 충돌 가능"
fi

# 4. env 파일 — 키가 env에 들어가면 안 됨
for f in /etc/coinpilot.env /etc/coinpilot/coinpilot-live.env; do
  if [ -f "$f" ]; then
    if sudo grep -qE "^UPBIT_(ACCESS|SECRET)_KEY=" "$f" 2>/dev/null; then
      fail "$f 에 Upbit 키가 평문으로 저장됨 — 암호화 credential store로 옮겨야 한다"
    else
      pass "$f 에 Upbit 키 없음"
    fi
  fi
done

# 5. rate coordinator 소켓
rate_dir=$(sudo grep -hE "^UPBIT_RATE_COORDINATOR_STATE_DIR=" /etc/coinpilot.env /etc/coinpilot/coinpilot-live.env 2>/dev/null | head -1 | cut -d= -f2)
if [ -n "${rate_dir:-}" ] && [ -d "$rate_dir" ]; then
  pass "rate coordinator state dir 존재: $rate_dir"
else
  warn "rate coordinator state dir 미설정/미존재 — Paper와 LIVE가 공유 쿼터 조율 없이 같은 IP를 사용"
fi

# 6. Paper 서비스가 coordinator에 붙었는지
if systemctl cat coinpilot.service >/dev/null 2>&1; then
  if sudo grep -qE "^UPBIT_RATE_COORDINATOR_REQUIRED=true" /etc/coinpilot.env 2>/dev/null; then
    pass "coinpilot.service(Paper)가 shared coordinator 계약을 사용"
  else
    warn "coinpilot.service(Paper)에 UPBIT_RATE_COORDINATOR_REQUIRED 미설정 — 호스트 공유 쿼터가 미조율"
  fi
fi

# 7. nginx /live/ 위치 블록
if sudo nginx -T 2>/dev/null | grep -q "location /live/"; then
  pass "nginx에 /live/ 위치 블록 존재"
else
  warn "nginx에 /live/ 위치 블록 없음 — LIVE 대시보드 외부 경로 미구성"
fi

echo "== done =="
