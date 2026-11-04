# CoinPilot 기기 검증 준비와 정기 갱신 확인

목표는 active다. 앱 전체 개선의 완료를 주장하지 않는다.

1. 연결된 실제 iPhone 15 Pro Max를 확인했다. iPhone Mirroring은 연결 중 기기 사용으로 시간 초과 상태였다. 사용자에게 잠금 상태로 둘 수 있는지 비동기 질문을 남겼으며 답변을 기다린다.
2. 운영 앱과 다른 식별자 com.godekd3133.coinpilot.uxdevice, 표시명 CoinPilot QA로 빌드했다. 운영 서버 주소·토큰과 LocalSecrets.json을 넣지 않았다. 토큰은 QA 프로세스 메모리만 사용한다.
3. 이 환경의 Xcode 계정·푸시 프로파일 제약 때문에 화면 검증용 빌드는 push entitlement 없이 기존 개발 서명을 사용했다. 서명을 직접 검사하여 aps-environment가 없는 것을 확인했다. 푸시 알림 검증은 이 빌드의 범위에 포함하지 않는다.
4. device-build.log의 BUILD SUCCEEDED와 device-install.log의 App installed 및 별도 bundleID를 확인했다. 설치 성공은 화면·접근성·실행 성공의 증거가 아니다. 기기 UI가 연결될 때까지 실제 앱 실행은 진행하지 않았다.
5. Mac QA 뉴스 화면을 유지하며 수동 새로고침을 하지 않았다. 08:39:49.815 UTC 요청 뒤 08:44:51.504 UTC에 GET /news가 다시 성공했다. 약 301.689초 간격이며 화면 확인 시각도 17:39에서 17:44로 바뀌었다. 기존 300초 freshness 정책에 맞는 실제 정기 조회를 확인했다.

아직 실제 iPhone 화면, 큰 글자와 VoiceOver, 데이터가 있는 조건 주문·종목 교체 흐름 및 전체 완료 감사가 남아 있다. 실제 주문과 운영 배포는 수행하지 않았다.

![정기 조회 시작](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/48-news-periodic-start.png)

![5분 뒤 자동 갱신](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/49-news-periodic-after.png)
