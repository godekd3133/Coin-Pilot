# CoinPilot 연결형 사용자 흐름 개선 — 두 번째 루프

2026-10-08. 전체 목표는 진행 중이다. 이번 루프에서는 화면 미리보기보다 더 강한 근거를 얻기 위해, 인증이 필요한 격리된 DRY_RUN 서버에 네이티브 앱을 연결했다. `mobile/scripts/runNativeQA.mjs`의 임시 저장소와 고정 시세, 가상 계좌를 사용했다. 거래소 어댑터와 자동매매 시작·중지 함수는 모의 구현이며 AI 기능은 비활성화했다. 실제 계좌, 주문, 체결, 수익 검증이 아니다.

## 관찰, 수정 목표, 구현

로그인 단계가 이미 확인한 서버 주소와 설명을 다시 펼쳐 보여주었다. 주소는 펼쳐 확인하도록 바꾸고, 토큰 입력을 우선했다. 보유 코인이 없는 정상 상태를 홈의 주의 카드로 강조하던 조건도 제거했다.

자동매매 시작·중지의 서버 응답이 상태 갱신 후에도 다른 화면에 경고처럼 계속 남았다. 새 상태 읽기에서 요청한 실행 상태를 확인한 경우에만 기본 화면의 접수 안내를 정리한다. 접수 당시 원문은 운용 상세에 유지한다. 실패·거절·통신 오류와 아직 상태가 확인되지 않은 요청은 계속 표시한다. 요청 접수 전에 시작된 상태 조회가 늦게 도착해 새 요청을 완료로 오인하지 않도록 조회와 요청의 순서도 확인한다.

거래 기록의 `amount`는 전략 기록에서는 코인 수량, 스마트 주문에서는 기준 통화 금액이다. 이전 모델은 이 단위를 구분하지 않았다. 수량과 금액을 분리했고, 단위를 확인할 수 없는 값은 임의로 금액으로 표시하지 않는다. 매수 기록은 수량이나 명시된 거래 금액을 단가보다 먼저 보여준다. 제공되지 않은 실현 손익은 0으로 만들지 않는다.

종목 상세의 정상 시각 확인 문구와 분석 화면의 장식 이미지를 줄였다. 손익이 0인 종목을 수익·손실 순위에 동시에 표시하지 않는다. 서버 상태의 제공되지 않은 건수와 오류 자료도 임의의 0이나 '없음'으로 바꾸지 않는다.

주문 전 점검에서는 모의 점검 세션을 먼저 보여주고, 검증·연구·후보·실거래 자료는 사용자가 펼쳐 확인한다. 모의 작업공간에는 LIVE 진입 잠금 요약을 반복하지 않는다. 실거래 화면의 계좌·주문 조건과 검증의 한계 설명은 유지했다.

## 검증한 흐름

| 단계 | 확인 내용 | 결과와 근거 |
| --- | --- | --- |
| 1 | 서버 확인 → 테스트 토큰 로그인 | 성공. 로그인 전후 화면과 HTTP 200 확인. `01-login-before.png`, `22-login-after.png`, `23-login-server-details.png` |
| 2 | 모의 자동매매 시작·중지 확인 | 각 확인 대화상자 이후 HTTP 202 및 서버 상태 반영. `03-start-confirm.png`, `14-running-after.png`, `15-stopped-after.png` |
| 3 | 완료된 요청 안내 정리 | 중지 후 기본 화면에 처리 중 문구가 남지 않음. 원문은 운용 상세에 남음. `16-operation-details.png` |
| 4 | 가상 매수 → 잔액·보유 자산 | 100,000원 가상 매수 후 현금 900,000원, 수량 0.0009995 BTC, 평가액 99,950원. 모의 수수료가 반영됨. `06-order-confirm-before.png`, `07-paper-assets.png` |
| 5 | 자산 기록 저장 | 현재 평가가 1개 기록으로 표시됨. HTTP 200 확인. `13-home-after.png`와 `25-empty-home-after.png`의 기록 표시 |
| 6 | 보유 자산 → 종목 상세 | 가격·캔들·보유 정보를 확인. `08-market-detail.png` |
| 7 | 거래 내역 수치 단위 | 매수 수량과 단가가 분리돼 보임. 실현 손익 미제공 유지. `09-paper-history.png`, `19-trade-units-after.png` |
| 8 | 포트폴리오 분석 | 0% 종목의 중복 수익·손실 순위와 장식 제거. `10-analytics.png`, `20-analytics-after.png` |
| 9 | 주문 전 점검과 보고서 펼침 | 모의 세션 우선, 상세 보고서와 검증 한계 설명 유지. 로딩 중 캡처는 거절하고 완료 화면으로 교체. `11-readiness.png`, `17-readiness-after.png`, `18-validation-details.png` |
| 10 | 설정 → 로그아웃 → 로그인 | 주소 유지, 토큰 삭제, 접힌 주소 영역을 다시 펼칠 수 있음. `21-settings-after.png`, `22-login-after.png`, `23-login-server-details.png` |
| 11 | 가상 매도 → 빈 보유 상태와 손익 | 수량 0.0009995 BTC를 모의 전체 매도. 수수료를 반영한 현금 약 999,900원과 실현 손익 약 -100원 표시. 빈 보유 상태를 주의 카드로 강조하지 않음. `24-paper-sell-confirm.png`, `25-empty-home-after.png` |

## 검사 결과

- 네이티브 macOS 서버 프로필 빌드 성공.
- iOS 15 배포 대상을 유지한 arm64 iPhone Simulator 서버 프로필 빌드 성공.
- Store 검사 63개 시나리오 통과. 진행 중 요청, 완료 확인, 실패 안내 유지, 늦은 상태 응답, 서버 문맥 이탈을 포함한다.
- 유용성 검사 4개 시나리오 통과. 수량과 금액의 구분, 단위 미분류, 비정상 수치, 실현 손익 0과 미제공의 구분을 포함한다.
- 인증, 시작, 중지, 매수, 매도, 기록 저장의 HTTP 응답을 합성 서버 로그로 확인했다. 헤더나 인증 값은 저장하지 않았다.
- 이번 루프의 네이티브 구현 및 테스트 파일을 대상으로 변경 형식 검사를 통과했다. 작업공간의 다른 서버 변경은 이 루프의 검증 범위가 아니다.

최종 소스 해시와 HTTP 응답 요약은 `verification.json`에 있다. `requirements.json`은 전체 목표를 진행 중으로 유지하며 남은 검증 범위를 기록한다.

## 남은 전체 목표 범위

설정 편집과 토큰 교체, 전략 프리셋과 후보 비교, 조건 주문과 종목 교체의 채워진 결과, 뉴스와 시장 자문의 가용·실패 상태, iPhone의 다른 화면 및 큰 글자 크기, 조회 전용·서버 모드 불일치의 실제 화면, 전체 접근성 흐름을 추가로 검증해야 한다. 실제 LIVE 주문·체결·운영 배포·TestFlight는 수행하지 않았다. 이 결과로 전체 제품 개선 완료나 실거래 준비 완료를 주장하지 않는다.

## 확인한 최종 화면

### 로그인

![로그인](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/connected-flow/22-login-after.png)

### 자동매매 중지

![자동매매 중지](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/connected-flow/15-stopped-after.png)

### 운용 상세

![운용 상세](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/connected-flow/16-operation-details.png)

### 거래 수량 표시

![거래 수량 표시](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/connected-flow/19-trade-units-after.png)

### 분석

![분석](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/connected-flow/20-analytics-after.png)

### 주문 전 점검

![주문 전 점검](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/connected-flow/17-readiness-after.png)

### 가상 매도 확인

![가상 매도 확인](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/connected-flow/24-paper-sell-confirm.png)

### 빈 보유 상태의 홈

![빈 보유 상태의 홈](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/connected-flow/25-empty-home-after.png)
