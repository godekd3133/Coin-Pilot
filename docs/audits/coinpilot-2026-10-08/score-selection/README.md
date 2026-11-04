# CoinPilot 조건 매수 점수 기준 안내

목표 active. 실제 주문·운영 배포는 not-run. 전용 DRY_RUN 합성 서버와 Mac QA 앱을 사용했다.

## 관찰과 계획

기준 100점, 최대 1종목, 10,000원 요청에서 qualifiedCoins=0인데 1종목이 매수됐으며, 응답은 100점 이상 매수 완료라고 표시했다. 기존 정책은 기준 충족 종목이 없으면 상위 후보를 선택하므로 실제 결과를 잘못 설명했다. before.json에 실제 합성 응답을 저장했다.

선택 방식·배분·최대 종목 수·잔액 조정·보호 검사는 유지하고 기준 충족과 대체 후보 사용을 구분하여 표시한다.

## 변경과 단계별 검증

| 단계 | 결과 | 근거 |
| --- | --- | --- |
| 1. 기준 미달 재현 | qualifiedCoins=0인데 기존 메시지는 100점 이상이라고 표시 | before.json |
| 2. 결과 표시 수정 | usedFallback=true와 상위 후보 사용 메시지. 기준 충족 개수는 실제 필터 결과를 유지 | after.json |
| 3. 주문 전 확인 | 최소 점수 대신 신호 점수 기준으로 명명. 확인창에 기준 미달 상위 후보 사용 가능성을 표시 | 60-score-fallback-confirmation-after.png |
| 4. 모의 실행 결과 | Mac 앱에서 기준 100점 요청을 실행하여 실제 상위 후보 사용 결과 안내 확인 | 61-score-fallback-result-after.png |
| 5. 회귀 | 기준 미달/충족 및 금액 조정 사례를 포함해 기준통화 주문 회귀 16개 통과 | backend-tests.log |

Mac QA 및 iOS Simulator 빌드 성공, diff check 통과. 실제 iPhone은 현재 unavailable이고 미러링 연결/사용자 잠금 상태 응답을 기다리는 중이다. 실제 기기 화면·큰 글자·VoiceOver 및 전체 목표의 완료 감사는 남아 있다.

![주문 전 점수 기준 확인](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/60-score-fallback-confirmation-after.png)

![기준 미달 상위 후보 사용 결과](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/61-score-fallback-result-after.png)
