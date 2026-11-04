# CoinPilot 프론트·백엔드 배포 — 2026-10-09

웹 Paper https://52.78.156.161/ 및 LIVE https://52.78.156.161/live/ 에 프론트 파일과 백엔드 변경을 반영했다. 각 운영 원본의 SHA256을 확인하고, LIVE와 기존 모놀리식 Paper 구조에 맞춰 21개 파일을 적용했다. 실제 파일 목록과 적용 전후 해시는 manifest.json에 있다. 저장된 실행 의도는 둘 다 ON이었고 배포 후에도 유지됐다. 확인을 위해 주문이나 시작·중지 API를 호출하지 않았다.

외부 HTTPS 인증 GET에서 두 서버의 /ready는 HTTP 200, ready=true였다. system-status는 RUNNING, 계좌·보유 평가 조회는 HTTP 200과 valuationAvailable=true였다. 후보 비교 설정 조회도 HTTP 200이었다. LIVE 성과 검증 정책은 NOT_REQUIRED, Paper 연구 준비 상태는 BLOCKED로 각각 유지된다. 이는 서버 건강 상태와 구분되는 전략 자료 상태다. production-final.json은 금액과 인증 정보를 제외한 실제 응답 요약이다.

최초 적용에서는 최신 상태 API와 운영 주문 모듈 사이의 export 불일치로 LIVE 기동이 실패했다. 상태 파일을 즉시 복구했고 첫 배포는 전체 롤백됐다. 기존 주문 상수·동작을 보존하며 상태 표시용 floorQuoteAmount/roundQuoteAmount export를 추가했다. LIVE와 Paper의 실제 배포 스냅샷 모듈 로딩을 검사한 뒤 다시 적용했다. 두 번째 적용은 전체 파일 해시, 실행 의도, 서비스 및 API 확인을 통과했다. 최종 복구 원본은 서버 /root/coinpilot-backups/20261009-release-v2 에 있다.

검증: Node 24.21.0에서 전체 Node 검사 1358/1358, 배포 관련 집중 검사 48/48, 후보 비교 저장 검사 5/5, Paper 구조 적합성 검사 4개, ESLint 및 PWA shell 검사 통과. 네이티브 Store 검사 69개, 사용자 흐름 검사 5개, 서버 주소 정책 검사 20개 및 자동 연결 검사 통과. 새 저장 필드를 검증하도록 optimizationPersistence.test.js의 기존 기대값을 갱신했다.

외부 HTTPS로 각 서버의 웹 파일 5개를 내려받아 배포 스냅샷 SHA256 일치를 확인했다. 브라우저에서 최신 로그인 화면을 확인했고 web-login.png에 저장했다. 인증 후 웹 전체 흐름·실제 iPhone 설치 및 주문 체결은 이번 배포 검증에 포함되지 않는다.

네이티브 iOS는 소스 스냅샷에서 서버 프로필 1.0 (23)을 서명·archive·export하고 2026-10-09 16:58 KST에 Apple 업로드 성공을 확인했다. archive의 실제 Paper/LIVE 주소와 개발용 인증 정보 미포함을 검사했다. 소스 해시는 native-source-hashes.json에 있다. 최종 TestFlight 상태는 testflight-result.txt에 기록한다.

TestFlight 최종 확인: 빌드 23 VALID, CoinPilot Internal 정확한 그룹 구성원, IN_BETA_TESTING. 실제 기기 설치는 not-run이다. 앱 소스는 16:51 KST 스냅샷 기준이며 빌드 중 16:54–16:55에 다른 작업에서 수정한 토큰 교체 후 데이터 정리와 뉴스 화면 권한·빈 상태 표시 변경은 이 빌드에 포함되지 않는다. 로컬 빌드 번호는 23으로 갱신했다.
