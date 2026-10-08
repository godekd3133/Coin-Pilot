# 실거래 시작·중지 점검 — 2026-10-07

## 요청과 범위

모의투자/과거 성과 검증 통과를 실거래 자동매매 시작의 필수 조건에서 제외한다. 계좌·미체결 주문 동기화, 시세 신선도, 위험 감시, 손절·익절, 주문 중복 방지는 유지한다. 실제 주문이나 실거래 자동매매 시작은 수행하지 않았다.

## 운영 확인 (12:42 KST)

GET 요청만 사용했다. `production-readback.json`에 민감한 토큰·잔액·주문 내역을 제외한 결과를 보존했다.

- `/health` 200, `/service-ready` 200, 데이터 coordinator 정상.
- LIVE `STOPPED`, `operator_stop`, 신규 진입 잠김, `exchangeStateKnown=true`, `liveManualPrepared=true`.
- 조회된 포지션 0개. 분석 루프는 중지 상태이므로 정상 운용/실제 체결을 검증한 것은 아니다.
- `/strategy-readiness`: `BLOCKED`, `confidence_gate_failed`; 성과 검증 설정은 `requireValidationPassForLive=true`. 리포트 오래됨·미승격 상태도 확인됨.

## 로컬 수정

- `SCALP_REQUIRE_VALIDATION_PASS=false`이면 성과 보고서 유무·통과 여부로 시작을 차단하지 않는다. 기존 기본값과 명시적 true 동작은 유지한다.
- 위험 감시/데이터 공백 보호 검사는 false에서도 필수다. 거래소 동기화 전에는 신규 진입을 잠근다.
- 선택 사항인 성과 검증을 `NOT_REQUIRED`로 반환한다. `currentEvidence=false`, `passed=null`로 미검증 상태를 통과로 표시하지 않는다.
- 성과 검증을 끄면 자동 보고서 갱신 자식 프로세스도 실행하지 않는다.
- Native/Web 화면은 성과 검증 선택 상태를 표시한다.
- 기존 작업 중인 파일의 무관한 변경은 보존했다. 커밋·푸시·TestFlight 업로드 없음.

## 검증

- Node 24.21 관련 테스트 203개 통과.
- 최종 LIVE 보호/시작 API 및 Web 상태 표시 테스트 147개 통과 (앞의 203개와 일부 중복).
- iOS Store 62개 시나리오 통과. 시작 요청 수락과 실제 실행 상태를 구분하고, 시작 거부 사유/재시도/중지 피드백 확인.
- 성과 보고서가 없는 LIVE 설정으로 실제 로컬 HTTP 시작 API → 분석 루프 진행 → 중복 시작 거부 → 중지 API → 루프 종료를 확인. 거래소 어댑터는 테스트 대역이며 실제 주문 0회.
- iOS Simulator Debug 빌드 성공. lint와 diff check 통과.
- 실제 iPhone 설치 앱 화면, 운영 시작·중지, 실거래 주문·체결·운용 지속성은 미검증.

## 운영 적용 차단과 다음 단계

SSH 허용 IP는 211.193.60.229/32, 218.153.88.17/32이다. 현재 네트워크 IP 210.108.18.219는 미허용으로 SSH timeout이 발생했다. Lightsail IP 추가 API는 IAM `AccessDeniedException`으로 거부됐고 `aws-login` 세션은 만료됐다. 방화벽·서버 파일·서비스는 변경하지 않았다.

접속 복구 후 현재 서버 원본/해시와 미해결 주문·포지션·자동 시작 및 복구 의도를 먼저 확인한다. `server-performance-option.patch`는 이 작업의 서버 세 파일 변경만 담은 검토용 패치다. 현재 서버 소스에 dry-run 적용 검사를 하고 백업을 만든 뒤 반영해야 한다. 전체 dirty checkout을 덮어쓰면 안 된다.

운영 LIVE 환경에 `SCALP_REQUIRE_VALIDATION_PASS=false`를 설정해야 요청한 시작 조건 해제가 실제로 활성화된다. 기존 `DASHBOARD_AUTO_START`와 자동 복구 실행 의도는 시작되지 않도록 점검하고 중지 상태를 보존한다. 반영 후 인증된 GET과 readiness를 다시 확인한다. 실제 돈이 움직일 수 있는 자동매매 시작은 사용자가 앱에서 직접 수행한다. Native/Web 문구 변경은 별도 클라이언트 배포가 필요하며 아직 배포하지 않았다.

## 후속 반영 요청

사용자의 운영 반영 요청 후 SSH와 만료된 AWS 프로필을 다시 확인했다. 같은 접속 문제가 지속됐다. Chrome에서 Lightsail 콘솔 접속을 시도했으나 활성 로그인 세션이 없어 AWS IAM 로그인 화면이 표시됐다. 사용자에게 로그인 화면을 열어 인계했다. AWS CLI 인증 갱신도 활성 콘솔 로그인이 없어 완료하지 못했다. 서버 패치는 별도 임시 디렉터리에서 reverse/forward round-trip 검사를 통과했다 (`deployment-patch-check.json`). 현재 운영 적용은 미완료다. 인증이 복구되면 현 운영 소스와 stopped/포지션·미해결 주문 상태를 다시 읽은 후 제한된 변경을 적용한다.

## 2026-10-08 해결

SSH 접속이 복구돼 운영 코드 세 파일과 SCALP_REQUIRE_VALIDATION_PASS=false 설정을 반영하고 LIVE 서비스를 재시작했다. 인증된 운영 API에서 NOT_REQUIRED, 성과 검증 요구 false, 차단 사유 없음, 자동매매 중지·포지션 0개를 확인했다. 상세 기록은 ../.. 경로의 2026-10-08/live-controls-deployment/README.md에 있다. 위 접속 차단 기록은 2026-10-07 당시 상태이며 현재 운영 반영은 완료됐다.
