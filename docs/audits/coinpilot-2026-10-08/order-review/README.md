# CoinPilot 종목 교체와 조건 주문 검증

전체 목표 active. 전용 DRY_RUN 합성 서버와 테스트 토큰만 사용했으며 실제 주문은 not-run이다.

## 관찰과 수정

종목 교체 확인창은 일반적인 실행 설명만 표시하고 선택한 두 종목, 매도 수량, 매수 금액을 표시하지 않았다. 부분 매도 진행 기록도 전체 보유 평가액을 표시했다.

확인창에 작업공간·매도 종목과 수량·매수 종목과 금액을 독립된 줄로 표시한다. 매수 금액이 지정되지 않으면 서버의 실제 기본 정책인 수수료 차감 매도 대금 95%를 표시한다. LIVE에서는 두 주문의 일부만 체결될 수 있다는 설명을 유지한다. 진행 기록의 표시 금액은 선택한 매도 수량과 신선한 시세로 계산한다.

## 단계별 검증

| 단계 | 결과 | 근거 |
| --- | --- | --- |
| 1. 종목 교체 확인 | BTC 0.0001개 매도, ETH 9,000원 매수 표시 | 51-bundle-confirmation-after.png |
| 2. 모의 종목 교체 실행 | BTC 잔여 0.00039975개, ETH 0.0017991개, 현금 950,995원 | bundle-result.json |
| 3. 조건 매수 확인과 실행 | 총액 10,000원, 최소 점수 60, 최대 1종목 표시. 한 종목 매수 완료 | 52-conditional-confirmation.png, 53-conditional-result.png |
| 4. 우선순위 매도 확인과 실행 | 목표 15,000원, 손실이 큰 순서 표시. 수수료 후 14,992.5원 반영 | 54-priority-sell-confirmation.png, 55-priority-sell-result.png, conditional-result.json |
| 5. 부분 매도 진행 기록 | 원화 및 USDT·USDC·FDUSD·TUSD에서 0.001 BTC 선택 시 전체 보유량이 아닌 선택 수량의 평가액 표시 | Store 회귀 70개 통과 |

화면과 서버 응답을 함께 확인했으며, 중복 주문을 막는 미확정 상태가 처리 중 나타난 뒤 완료 시 해제되는 것도 확인했다. 실제 체결·운영 서버 반영을 증명하지 않는다. 일반 Mac, QA Mac, iOS Simulator 빌드 성공.

큰 글자와 VoiceOver, 실제 iPhone 화면 검증은 아직 대기 중이다. 설치된 기기 QA 빌드는 이번 종목 교체 수정 이전 버전이므로 기기 검증 전에 다시 빌드·설치해야 한다. 검토 결과가 비어 있을 때 분석을 실행하라고 표시하는 문구, 새 요청 전 확인 중 이전 성공 메시지가 보이는 상태, 종목 교체/묶음 용어 일관성은 추가 점검 항목이다.

![수정 전 확인창](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/50-bundle-confirmation-before.png)

![수정 후 확인창](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/51-bundle-confirmation-after.png)

![조건 매수 확인](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/52-conditional-confirmation.png)

![조건 매수 결과](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/53-conditional-result.png)

![우선순위 매도 확인](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/54-priority-sell-confirmation.png)

![우선순위 매도 결과](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/55-priority-sell-result.png)

## 후속 루프: 진행 상태와 용어 정리

| 단계 | 변경과 확인 | 상태 |
| --- | --- | --- |
| 1. 빈 분석 결과 | 분석 완료 후 다시 실행하라고 안내하던 문구를 현재 검토할 종목이 없다는 상태로 변경. 분석 중에는 동일 분석 버튼 비활성화 | 화면 확인 |
| 2. 용어 | 제안·확인창·실행 버튼·진행 기록을 종목 교체로 통일. 화면에서 추론 가능한 반복 설명 제거 | 화면 확인 |
| 3. 새 주문 전 확인 | 직전 성공 메시지를 계좌·시세 확인 중 상태로 대체. 이미 갱신 중일 때 다시 갱신하라고 요구하는 중복 안내 제거 | 5초 지연 합성 서버 화면 확인, 보류 응답 회귀 통과 |
| 4. 로그아웃 중 응답 | 로그아웃 뒤 보류된 이전 확인 작업이 주문 메시지를 다시 남기는 실패를 먼저 재현. 로그아웃 시 메시지 초기화 및 이전 연결 작업의 결과 무시로 수정 | preflight-regression-before.log 실패 재현, store-tests.log 전체 통과 |

회귀 실행 로그의 고정 숫자 대신 전체 시나리오 통과를 표시하도록 정리했다. 현재 runScenarios에는 70개의 명명된 검사 호출이 있고 일부는 여러 기준 통화나 경우를 반복한다. 이 숫자는 전체 제품 흐름의 완성 증거를 대신하지 않는다.

Mac QA 및 iOS Simulator 최종 빌드 성공. 최신 기기 QA 빌드는 성공했지만 iPhone이 unavailable로 바뀌어 설치 갱신은 blocked다. 기존 기기 설치 성공은 이전 코드의 결과이며 최신 화면 증거로 사용하지 않는다.

추가 감사 항목: 조건 매수에서 점수 기준 미달일 때 상위 후보를 사용하는 정책과, 결과 메시지가 항상 기준 점수 이상이라고 표현하는 부분을 실제 응답으로 검증해야 한다. 이는 최소 점수 입력의 의미 및 결과 안내 정확성에 관계된다.

![빈 결과](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/56-review-empty-after.png)

![종목 교체 용어](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/57-review-terminology-after.png)

![이전 성공 대신 확인 중](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/58-new-order-preflight-after.png)

![현재 확인 중만 안내](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/59-order-checking-only-after.png)

확인 중 상태가 표시될 때 새로고침을 요구하는 안내를 숨긴 최종 화면은 59-order-checking-only-after.png다. 주문 차단 조건은 그대로 유지한다.
