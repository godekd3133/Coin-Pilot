# 실거래 성과 검증 선행 조건 해제 — 2026-10-08

사용자가 요청한 운영 반영을 완료했다. 실제 자동매매 시작이나 주문은 수행하지 않았다.

## 반영 범위

현재 운영 서버에서 읽은 원본에 한정해 세 파일의 패치를 적용했다. 다른 local WIP와 자동 복구 기능은 배포하지 않았다. manifest.json에 운영 원본/수정 SHA256을 보존했다.

- src/trader/tradingLifecycle.js: 성과 검증 설정이 false일 때 보고서를 요구하지 않는다. 위험 감시 및 데이터 공백 보호는 필수다.
- src/research/strategyReadiness.js: 선택 사항을 NOT_REQUIRED, currentEvidence=false, passed=null, enforced=false로 반환한다. 미검증 성과를 통과로 표시하지 않는다.
- src/runtime/liveValidationReportRefresher.js: 성과 검증이 선택 사항이면 자동 검증 자식 프로세스를 실행하지 않는다.
- /etc/coinpilot/coinpilot-live.env: SCALP_REQUIRE_VALIDATION_PASS=false를 반영했다. DASHBOARD_START_TRADER_ON_BOOT=false를 보존했다.

## 검증 및 결과

배포 직전 LIVE STOPPED, 사용자 중지, 포지션 0개, exchangeStateKnown=true를 인증된 API로 확인했다. 운영 원본 파일 해시를 검사하고 백업 후 각 파일을 원자적으로 교체했다. 수정 후 node --check를 통과했다.

- 로컬 관련 회귀 테스트 65/65 통과. 기존 실제 HTTP 시작 → 분석 루프 → 중복 시작 거부 → 중지 테스트 포함. 실제 거래소 요청 없이 수행했다.
- 배포된 모듈 검사 5개 통과: 보고서 없는 선택 성과 검증 통과, NOT_REQUIRED 응답, 자동 검증 비활성, 위험 감시/데이터 공백 보호 유지, 명시적 필수 설정의 보고서 요구 유지. 주문/시작 호출 0회.
- coinpilot-live 재시작 성공: active/running, PID 75381, ExecMainStatus=0.
- /health 및 /service-ready 200. 인증된 /api/strategy-readiness는 NOT_REQUIRED, requireValidationPassForLive=false, blockers=[]를 반환했다.
- /api/system-status: LIVE STOPPED, isRunning=false, currentPositions=0, exchangeStateKnown=true, manualProtectionActive=true.
- /api/positions: 0개. /ready의 503은 자동매매 분석 루프가 중지돼 있어 예상되는 값이다.

현재 설치 앱의 시작 요청은 이 서버를 사용하므로 성과 검증 미통과 사유로 차단되지 않는다. 계좌·미체결 주문·시세·위험 보호 조건은 별도로 적용된다. 사용자가 실거래를 켠 후의 분석 지속성, 실제 체결, 실제 iPhone 화면은 아직 관찰하지 않았다. Native/Web 문구 수정은 로컬 소스에만 있으며 이 작업에서 클라이언트 재배포나 TestFlight 업로드는 하지 않았다.

## 복구 자료

운영 백업: /root/coinpilot-backups/20261008-performance-option. 원본 세 파일과 기존 환경 파일을 보존했다. apply-result.json, manifest.json, deployed.patch, production-after.json, tests.log를 함께 확인한다. 환경 백업에 토큰이 포함될 수 있어 운영 서버의 root 전용 경계에 보관하며 다운로드하거나 공개하지 않았다.
