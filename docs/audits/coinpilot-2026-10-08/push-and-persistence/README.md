# 주문 푸시 및 자동매매 선택·진행 기록 보존 — 2026-10-08

## 결과

실거래와 모의거래 운영 서버에 반영했다. 새 앱 TestFlight 1.0 (22)는 VALID, CoinPilot Internal 그룹 IN_BETA_TESTING 상태다. 사용자는 업데이트 후 알림을 허용했다고 답했고, 두 서버에 각각 기기 1대가 등록된 것을 확인했다. 실거래/모의거래 연결 확인 푸시는 실제 주문을 발생시키지 않고 각 한 번 발송했으며 APNs는 둘 다 200으로 정상 접수했다. iPhone에서의 수신 여부는 별도 사용자 확인을 기다리고 있다.

## 자동매매 상태가 꺼졌던 원인과 변경

기존 운영 서버는 DASHBOARD_START_TRADER_ON_BOOT=false에 따라 매번 중지로 부팅했고, 로컬에 있던 AutoRecoverySupervisor는 운영에 연결되지 않았다. 이제 마지막 명시적 시작/중지 선택을 원자적 파일 교체와 파일·디렉터리 fsync로 저장한다. 저장된 ON/OFF가 부팅 기본값보다 우선한다. 시작 선택을 저장하지 못하면 신규 시작을 거부하며, 중지 선택 저장 실패는 신규 진입 중지와 함께 사용자에게 알린다. 종료 신호·배포 종료는 사용자의 ON 선택을 OFF로 바꾸지 않는다.

실거래는 실제로 켜진 상태였고 이를 ON으로 보존했다. 모의거래는 risk_data_gap으로 안전 중지되어 있었으므로 명시적 사용자 OFF와 구분해 ON 복구 의도를 보존했다. 여러 서비스 재시작 후 두 모드 모두 RUNNING, desiredRunning=true, intentWriteError=null을 확인했다. OFF 보존은 격리된 저장 파일과 실제 클래스 테스트로 검증했으며 운영 실거래를 테스트 목적으로 끄거나 새로운 주문을 요청하지 않았다.

## 보존하는 기록

- 계좌별 마지막 ON/OFF 선택, 선택 시각과 원인.
- 주문 시 즉시 기록하는 체결 내역, 주문 ID, 가격·수량. 같은 주문의 재요청은 푸시와 거래 추적 기록을 중복 생성하지 않는다.
- 기본 15초 간격의 실행·분석·위험 감시 상태와 마지막 완료 상태.
- 손실 횟수, 손실 회로 상태, 코인별 대기 시간, 동일 신호 창의 진입 횟수. 재시작이 진입 상한이나 손실 보호를 초기화하지 않는다.
- 전체 전략 거래 이력과 중지·재시작·복구 이력. 최근 조회용 체크포인트와 별도로 append-only events.jsonl에 시간순 이력을 보존한다.

LIVE: /var/lib/coinpilot-live/automation_intent.json 및 .tracking.json, .tracking.json.events.jsonl, orders-push.json.
Paper: /var/lib/coinpilot/paper/automation_intent.json 및 .tracking.json, .tracking.json.events.jsonl, orders-push.json.

이 파일들은 코드 배포 경로와 분리되어 있고 0600 권한이다. 기존 모의 포트폴리오·체결 증거·수동 주문 저널은 보존했다. LIVE 보유량과 미체결 주문은 거래소에서 재확인하며, 예전 시세 신선도나 실행 중 주문 커서를 그대로 복원하지 않는다. 손절·익절 및 시세·계좌 확인은 유지하고 성과 검증 선행 조건 해제도 유지했다.

강제 종료 직전 마지막 진행 표시는 주기적 체크포인트 간격만큼 뒤처질 수 있다. 주문 체결 및 주문 의도는 별도의 기존 영구 증거/주문 저널이 기준이며, 추적 기록은 이를 대신하는 주문 권한이 아니다. 이 작업은 모든 투자 설정의 부팅 재적용을 추가한 작업이 아니라, ON/OFF 선택과 실행·거래·위험 상태 보존을 다룬다.

## 푸시 알림

자동·수동 매수/매도 체결을 실거래/모의거래로 구분한다. LIVE는 실제 관찰된 filled/partial 체결만 알리고 실패·미확인 주문을 체결로 표시하지 않는다. 수동 모의 주문은 거래 저장이 완료된 응답 이후 알린다. 기기 등록과 알림 대기열은 재시작 후에도 복원한다. 임시 APNs 오류는 재시도하고 무효 토큰은 비활성화한다. 주문 ID 기반 중복 방지를 적용하지만 네트워크 응답 유실 이후 재발송의 실제 기기 표시가 완전한 exactly-once라는 의미는 아니다.

기기 토큰과 Apple 서명 키는 앱 외부의 서버 경계에 보관한다. iOS 앱은 알림 허용 후 현재 계좌와 같은 출처의 검증된 두 계좌 서버에 기기를 등록하며, 키와 운영 토큰은 배포 앱에 넣지 않았다. Apple Push capability를 활성화하고 production aps-environment가 있는 새 Store 프로파일로 배포했다. exported IPA의 entitlements도 production임을 확인했다. TestFlight 앱을 열고 알림을 허용해야 기기가 등록된다.

## 검증

- 관련 회귀 161개, 최종 회귀 72개, 신규 HTTP 주문/푸시 및 복구 9개 테스트 통과 (서로 일부 중복).
- iOS Store 62개 시나리오 통과, iOS Simulator 및 signed archive/export/upload 성공.
- 배포된 LIVE/Paper의 실제 DashboardServer 알림 함수 → 영구 대기열 → 테스트 전송 → 중복 제거 → 거래 추적까지 검사했다. Paper는 이전 모놀리식 구조라 별도 연결 지점을 반영했다.
- 양쪽 실제 서비스 재시작 후 ON 복원, 분석 readiness 및 저장 시각 갱신 확인. 주문 ID·가격·수량 기록, 손실/진입 횟수 보존, 저장 실패 경로도 테스트했다.
- 실제 HTTP 모의 주문 테스트는 격리된 가짜 시세/지갑에서만 수행했다. 운영 실거래에 검증용 주문을 전송하지 않았다.
- 실제 iPhone으로 연결 확인 알림 2개를 발송해 APNs 200 접수 확인. 사용자 수신 확인은 아직 미완료다.

## 배포 및 복구

각 운영 원본을 별도로 읽고 SHA256을 검증한 뒤 필요한 변경만 반영했다. 전체 로컬 WIP를 덮어쓰지 않았다. deployment-manifest.json은 실제 운영 파일 해시를 기록한다. existing-files.patch는 공백을 정규화한 검토용 차이이며 배포 입력으로 사용하지 않았다. 실제 복구 원본은 서버 백업이 기준이다. 백업: /root/coinpilot-backups/20261008-push-persistence. 환경/키 백업은 서버의 제한된 권한 경계에 두었으며 이 문서에는 비밀값을 넣지 않았다. 테스트 중 생성한 임시 서버 자료와 키 사본은 작업 종료 시 제거한다.

검증 자료: production-final.json, deployment-result.json, deployment-manifest.json, testflight-build22.json, iphone-push-check.json, regression-161.log, final-tests-72.log, native-store-62.log.
