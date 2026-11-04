# CoinPilot 고급 기능과 권한 흐름 개선

상태: 진행 중. 전체 제품 목표는 active이며 이 문서는 고급 기능 개선 루프의 검증 기록이다.

모든 연결·주문·설정 변경은 전용 합성 서버(port 39471)와 테스트 토큰으로 확인했다. 실제 거래소 주문, 운영 서버 배포, 실제 AI 요청은 수행하지 않았다.

## 관찰과 수정 목표

일상 화면은 판단과 다음 행동을 우선한다. 고급 설정과 증거 자료는 필요할 때 펼친다. 설명을 줄이면서도 금액 단위, 시세의 신선도, 서버 권한, 저장 결과와 실행 결과는 확인 가능한 상태로 남긴다. 점 기호로 항목을 연결하는 대신 독립적인 텍스트와 간격, 행과 접기 UI를 사용한다.

## 흐름별 기록

| 단계 | 관찰과 결과 | 증거 | 상태 |
| --- | --- | --- | --- |
| 1. 전체 기능 | 중첩된 회색 버튼 틀을 제거하고 메뉴 그룹과 짧은 제목을 우선함. 작업공간 표시는 상세 화면에서도 유지함. | 04-menu-after.png | Mac 화면 확인 |
| 2. 뉴스 | 분류 정보가 없는 기사에는 분류 없음 배지와 불필요한 필터를 숨김. 출처와 원문은 유지함. | 05-news-after.png | Mac 화면 확인 |
| 3. 시장 자문 | 사용 불가능한 제공자는 자동 의견 요청을 막음. 의견 서비스가 없어도 신호 기록 생성·일시정지·재개는 동작함. | 06-consultation-after.png, 07-signal-paused.png | 합성 서버 확인 |
| 4. 프리셋 | 검증되지 않은 위험 순위 이름을 실제 투자 비중과 지표 기간 이름으로 변경함. 수치 상세는 접음. 적용 시 프리셋에 없는 현재 값을 보존함. | 09-presets-after.png, 10-preset-values.png, 11-preset-applied.png, applied-config.json | 화면·응답·회귀 테스트 확인 |
| 5. 설정 편집 | 기본 투자·손절·익절·보유 시간부터 노출함. 나머지 범주는 접고 검색 결과만 펼침. RSI 검색에 무관한 camelCase 키가 포함되는 문제를 수정함. | 13-tuning-after.png, 16-tuning-search-after.png | Mac 화면 확인 |
| 6. 설정 검증·저장 | 허용 범위 초과를 차단함. 변경한 항목만 저장하며 시장 설정과 숫자 설정을 한 번에 저장함. 서버 재조회가 성공한 뒤 저장 확인 메시지를 표시함. | 14-tuning-validation.png, 17-tuning-saved-after.png, tuning-result.json | 단일 수치와 시장·숫자 복합 저장 화면·서버 응답 확인 |
| 7. 최근 거래 | 스마트 거래뿐 아니라 전략 거래의 최근 이벤트를 반영함. | 18-last-trade-after.png, last-trade-runtime.json | 합성 거래·응답·화면 확인 |
| 8. 후보 비교 | 데이터 부족·실패·서버 재시작 중단을 완료와 구분하여 저장함. 성공한 후보도 자동 적용하지 않음. | 20-optimization-insufficient-after.png, backend-tests.log | 부족 상태 화면, 네 결과 회귀 테스트 확인 |
| 9. 조회 전용 연결 | 테스트 운영 토큰에서 조회 전용 토큰으로 교체하여 주문 검토·자동매매 시작 차단을 확인함. 토큰 교체 후 이전 권한 오류를 제거하고 설정 화면을 유지함. 뉴스 권한 안내에서 연결 설정으로 이동할 수 있음. | 21-read-only-order.png, 26-news-permission-recovery-after.png, 27-token-replacement-stays-after.png | 차단과 복구 화면·회귀 테스트 확인 |
| 10. 뉴스 필터 | 긍정·부정·중립 합성 기사로 부정 필터가 정확히 한 건을 남기는지 확인함. 필터 결과 수와 전체 수가 어긋나던 표시를 추가 수정함. | 28-news-filter-count-after.png | 필터 기능과 최종 수 표시 화면 확인 |

15-tuning-feedback-before.png는 서버에 저장되었으나 완료 피드백이 빠졌던 수정 전 상태다. 22-news-filter-after.png는 필터 결과 수 표시를 수정하기 전의 기능 검증 화면이다.

## 접근성과 검증 한계

명시적인 서버·토큰·튜닝 버튼 접근성 이름과 최소 44pt 터치 영역을 적용했다. 설정 검색, 입력 검증, 저장 후 비활성화 상태는 Mac 접근성 트리와 화면에서 확인했다. VoiceOver 낭독 순서, 큰 글자, 실제 iPhone 설치 동작과 안전 영역은 이번 고급 기능 루프에서 확인하지 못했다.

iOS Simulator 빌드와 설치·실행은 가능했지만 컴퓨터 사용 도구가 Simulator 앱을 식별하지 못했다. 따라서 이번 수정의 iPhone 화면 검증은 blocked이며 Mac 화면 확인으로 대체하여 완료라고 주장하지 않는다.

정상 키체인 경로는 대화상자를 강제로 열지 않도록 수정했다. 접근 불가 시 기존 보호와 주문 잠금을 유지하며, 기존 항목을 삭제한 후 새 항목을 만드는 방식 대신 갱신을 우선한다. 합성 키체인 CRUD 및 상호작용 정책 복원 테스트와 일반 Mac 빌드는 별도 증거다. 일반 키체인 빌드가 대화상자나 정지 없이 로그인 화면에 진입하는 것은 25-keychain-startup-after.png에서 확인했다. 실제 저장된 사용자 토큰의 재연결은 아직 확인하지 않았다.

검증: 앱 상태 회귀 70개, 서버 관련 회귀 21개 통과. iOS Simulator와 Mac QA 빌드 성공. 일반 Mac 빌드도 마지막 수정 후 성공했다. 사용자 유용성 회귀 5개도 통과했다. 키체인 레거시 API deprecation 경고는 남아 있다.

다음 루프: 제공자 일부 준비/오류, 네트워크 실패와 재시도, 모바일 큰 글자·VoiceOver 및 실제 설치 화면. 뉴스의 5분 정기 재조회도 직접 요청 기록으로 추가 확인한다.

## 확인한 화면

### 1. 전체 기능

![1. 전체 기능](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/04-menu-after.png)

### 2. 분류 없는 뉴스

![2. 분류 없는 뉴스](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/05-news-after.png)

### 3. 신호 기록과 제공자 상태

![3. 신호 기록과 제공자 상태](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/06-consultation-after.png)

### 4. 프리셋

![4. 프리셋](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/09-presets-after.png)

### 5. 기본 설정

![5. 기본 설정](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/13-tuning-after.png)

### 6. 검색과 저장 확인

![6. 검색과 저장 확인](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/17-tuning-saved-after.png)

### 7. 최근 거래

![7. 최근 거래](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/18-last-trade-after.png)

### 8. 비교 데이터 부족

![8. 비교 데이터 부족](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/20-optimization-insufficient-after.png)

### 9. 권한 복구 안내

![9. 권한 복구 안내](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/26-news-permission-recovery-after.png)

### 9. 토큰 교체 후 설정 유지

![9. 토큰 교체 후 설정 유지](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/27-token-replacement-stays-after.png)

### 10. 뉴스 필터 결과 수

![10. 뉴스 필터 결과 수](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/28-news-filter-count-after.png)

### 일반 키체인 빌드 시작

![일반 키체인 빌드 시작](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/25-keychain-startup-after.png)

## 후속 루프: 화면 복귀와 복합 저장

1. 뉴스 권한 복구 뒤 돌아왔을 때 수동 새로고침이 필요한 상태를 확인했다. 화면별 Task를 별도로 관리하던 수명주기를 SwiftUI task로 연결했다. 조회 가능 여부와 앱 활성 상태에 맞춰 시작하며 화면에서 사라질 때 취소된다. 수정 후 조회 전용 연결 → 뉴스 → 연결 설정 → 테스트 운영 토큰 → 뉴스 복귀 순서에서 자동으로 기사 3건이 로드됐다. 5분 freshness 기준은 유지한다. 단순히 그 5분 이내에 확인 시각이 유지되는 것은 결함으로 해석하지 않는다.
2. 투자 비율 4%, 대상 KRW-BTC, 최대 동시 포지션 2를 한 번에 저장했다. 서버에서 다시 읽은 세 값이 모두 일치했다. combined-tuning-result.json에 제한된 설정만 기록했다.
3. 실거래 작업공간에 합성 DRY_RUN 서버를 입력하여 연결·주문이 차단되는지 확인했다. 기존 안내가 내부 코드와 포트 설명을 반복하므로 선택 계좌와 연결 서버 차이, 고쳐야 할 주소만 설명하도록 변경했다. 최종 화면에서 차단 안내를 확인했고 모의투자로 돌아오면 정상 연결과 뉴스 자동 조회가 복구됐다.

이번 루프의 앱 상태 회귀 70개와 최적화 영속성·결과 회귀 9개가 통과했다.

![권한 복구 후 자동 뉴스 조회](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/30-news-auto-reload-after.png)

![복합 설정 저장 뒤 변경값](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/29-combined-tuning-saved.png)

4. 최초 서버 설정 화면의 홍보성 제목과 설명을 제거했다. 계좌 선택, 서버 주소, 연결 버튼을 우선 배치하고 실제 자금 사용 및 키 보관 설명을 짧게 유지했다.

![최초 연결 화면](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/32-connection-setup-after.png)

![서버 모드 차이 안내](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/33-mode-mismatch-after.png)

![올바른 계좌 선택 후 정상 복구](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/advanced-flow/34-mode-recovery-news-after.png)

마지막 수정 후 일반 Mac, QA Mac, iOS Simulator 빌드 모두 성공했다. 실제 iPhone 화면과 VoiceOver는 아직 확인하지 않았다.
