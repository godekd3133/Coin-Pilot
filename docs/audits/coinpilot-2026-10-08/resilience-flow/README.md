# CoinPilot 자문 연결 실패와 복구 흐름

목표는 active다. 이번 루프는 사용자 입장에서 오류·선택·복구 흐름을 관찰하고 수정한 기록이다. 실제 AI 서비스나 거래소에 요청하지 않는 전용 합성 서버를 사용했다.

## 관찰과 작업 계획

1. OpenAI만 준비된 합성 상태에서 선택 가능한 서비스와 자동 의견 대상이 일치하는지 확인했다. Claude는 선택되지 않고 비활성화됐다.
2. 제공자 상태 조회를 실패시켰다. 동작은 차단됐는데 이전 OpenAI 사용 가능 표시가 초록색으로 남는 모순을 재현했다. 오류 설명도 두 번 반복됐다.
3. 자동 의견 요청을 켜 둔 상태에서 제공자 오류가 나면 토글 자체가 비활성화됐다. 사용자가 이를 끄고 신호만 기록하는 경로가 막혔다.

## 변경

- 화면의 사용 가능 여부를 실제 요청에 쓰는 readyAIProviderIDs와 동일한 기준으로 표시한다. 실패 시 이전 사용 가능 상태 대신 확인 불가를 보여준다. enabled만 있고 제공자 목록이 없으면 사용 가능이라고 주장하지 않는다.
- 오류 안내는 한 번만 표시한다.
- 자동 의견 요청을 켠 상태에서는 제공자 오류가 나도 끌 수 있다. 제공자가 없을 때 새로 켜는 동작은 계속 막는다.
- 합성 서버에 로컬 상태 파일 qa-scenarios.json을 추가해 준비된 제공자, 전체 사용 중지, 조회 오류를 재현한다. ask는 합성 실패 응답만 반환하여 실제 CLI·유료 AI 호출을 하지 않는다.

## 검증

최종 일반 Mac, QA Mac, iOS Simulator 빌드 성공. 수정 후 아래 흐름을 합성 서버와 Mac 화면에서 확인했다. 실제 iPhone 화면, 큰 글자, VoiceOver 검증은 여전히 남아 있다.

![일부 서비스만 준비된 상태](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/35-partial-provider-before.png)

![수정 전 상태 조회 오류](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/36-provider-error-before.png)

| 단계 | 결과 | 상태 |
| --- | --- | --- |
| 1. 일부 서비스 준비 | OpenAI만 선택 가능하고 Claude는 선택되지 않음 | 화면 확인 |
| 2. 상태 조회 오류 | 과거 사용 가능 표시 제거, 확인 불가 표시, 오류 설명 한 번만 노출 | 화면 확인 |
| 3. 오류 중 자동 요청 끄기 | 켜진 토글을 끌 수 있고 신호 기록 시작 버튼 복구 | 화면 확인 |
| 4. 신호 기록 시작 | 자동 의견 없는 세션 생성, 서버 응답 autoConsult=false | 화면·응답 확인 |
| 5. 전체 사용 중지 | 제공자의 ready 값이 true여도 전역 enabled=false면 사용 가능으로 표시하지 않음 | 화면 확인 |
| 6. 복구 후 재조회 | 오류가 사라지고 OpenAI 사용 가능 표시와 선택 복구, 신호 세션 유지 | 화면 확인 |

읽기 오류는 실제 외부 장애 대신 합성 HTTP 500으로 재현했다. 후속 루프에서 전체 모의 서버 중단과 응답 지연·재시도를 추가 검증했다. 실제 외부 네트워크 환경에서의 검증은 별도다. 실제 제공자 의견 실행과 주문은 not-run이다.

![오류 확인](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/37-provider-error-after.png)

![오류 중 신호 기록](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/38-signal-only-error-after.png)

![전체 사용 중지](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/39-provider-disabled-after.png)

![서비스 복구](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/40-provider-recovery-after.png)

## 후속 루프: 서버 중단과 응답 지연

| 단계 | 관찰·수정·검증 | 상태 |
| --- | --- | --- |
| 1. 서버 중단 | 실제 모의 서버 프로세스를 중단했다. 연결 실패인데 서버 모드 오류로 표시되던 안내를 실제 요청 실패 이유로 변경했다. | 수정 후 화면 확인 |
| 2. 서버 재시작 | 서버를 다시 켠 뒤 다시 연결로 홈과 계좌 자료가 복구됐다. | 화면 확인 |
| 3. 응답 지연 | 합성 /api/status 응답을 30초 지연해 앱의 20초 요청 제한을 넘겼다. 계좌·주문 화면이 잠겼다. | 화면 확인 |
| 4. 재시도 중 안내 유지 | 자동 재시도가 직전 오류 설명을 먼저 지우던 문제를 수정했다. 정상 응답을 받기 전에는 기존 실패를 유지한다. | 보류 응답 회귀·시간 초과 화면 확인 |
| 5. 지연 제거와 재연결 | 지연을 없앤 뒤 다시 연결로 정상 홈이 복구되고 오류 안내가 사라졌다. | 화면 확인 |

상태 조회 실패·HTTP 503·응답 보류 중 실패 유지·정상 응답 후 계좌 조회 복구를 기존 회귀 시나리오에 추가했다. 총 70개가 통과했다. 마지막 수정 후 일반 Mac, QA Mac, iOS Simulator 빌드가 모두 성공했다. 실제 주문과 운영 서버 변경은 not-run이다.

44-timeout-message-before.png는 재시도 도중 설명이 사라지던 수정 전 증거다. 최종 상태는 45·46·47 화면으로 확인한다.

![연결 실패 안내](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/42-network-offline-after.png)

![시간 초과 후 오류 유지](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/45-timeout-message-retained-after.png)

![자동 재시도 중 오류 유지](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/46-retry-message-retained-after.png)

![지연 제거 후 복구](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/47-timeout-recovery-after.png)
