# Commercial Readiness Audit — 2026-09-29

## 범위

CoinPilot의 현재 대시보드/PWA, 네이티브 iOS observer, Node 거래 프로세스, API·저장 구조를 코드·테스트·로컬 실행 기준으로 점검했다. 이 문서는 배포 승인이나 수익성 평가가 아니다.

## 2026-09-29 follow-up — LIVE order recovery and request reduction

- Same-key dashboard ticker cache misses now share one in-flight Upbit request. The TTL and returned data contract are unchanged; failure clears the in-flight slot so later reads can retry. The cache key no longer sorts/mutates the caller's market array.
- HOLD candidates skip the redundant account read immediately before `executeOrder`; BUY/SELL still read a fresh account before proceeding. For 20 markets with all HOLD decisions, the source-estimated cycle falls from 41 account + 20 candle + 1 batch-ticker reads (62 total) to 21 + 20 + 1 (42 total). This is a static request-count estimate; latency and exchange rate-limit impact were not benchmarked.
- Every LIVE order persists a unique `ORDER_INTENT` line with `fsync` before POST and passes its identifier to Upbit. Ambiguous POST outcomes are not retried. Restart reconciliation reads by UUID or identifier; an unmapped legacy UUID that cannot be resolved leaves the whole LIVE state unknown. Existing evidence files are chmod 0600 before append.
- LIVE UI orders now require a durable submission method and a per-market order/account preflight no older than 10 minutes. Markets outside the automatic target list are probed on demand. Open orders, failed reads, stale verification, or missing submission support block POST. Automatic position management remains bounded to configured or evidence-recovered markets.
- LIVE reconciliation queries both `wait` and `watch` open-order states. This includes exchange-side reserved orders in the per-market lock; the repeated `states[]` query values are included in the JWT query hash and tested with an Axios mock.
- Observer `/account`, `/positions`, and `/cumulative-pnl` GETs now share the existing 1-second account cache and in-flight read, returning cloned rows. Portfolio snapshot POST, order submission, exchange sync, and risk paths still perform direct reads. The same observer valuation response includes exchange `sourceAsOf` and cache/server `fetchedAt`; persisted portfolio points keep those alongside `capturedAt`.
- The PWA asset chart's no-history state now uses a compact TDS-aligned message/action, and the portfolio holdings table header follows the light neutral palette. A user can add the current portfolio valuation from the empty state; successful manual/smart orders also attempt one snapshot, with history-save errors reported separately. CUA review covered the local mock dashboard and portfolio empty state at desktop width; no transaction or snapshot action was activated.
- Portfolio history replacement now creates an exclusive owner-only `0600` temporary file, fsyncs its contents before atomic rename, and keeps the prior history if syncing or rename fails. The local file is more private and replacement data is flushed before the switch, but separate processes can still overwrite one another's read/modify/write updates, and directory-entry durability after power loss is not established.
- PWA feature-flow follow-up: manual orders are no longer gated by the automatic loop's generic STOPPED state; LIVE manual orders are enabled only after a completed operator stop with known exchange state, and protective-only, sync-required, unknown, observer, offline, mode-mismatch, and paper-evidence locks still block them. Snapshot controls recover after failure, Analysis entry loads its own strategy-research report with a retry state, and restoring the last AI view reloads its data. These are source-regression checks; no transaction or snapshot UI action was run.
- DRY_RUN virtual wallet deposit, withdrawal, and reset now share one `MultiCoinTrader` mutation-and-persist path. A failed write restores the old in-memory balance, seed, holdings, positions, and trade history; an HTTP regression verifies success persistence and failed-write rollback with the prior JSON file unchanged. This remains a single-process JSON contract, not a multi-process transaction.
- Performance baseline: added `npm run benchmark:portfolio-history`, which creates 8,640 synthetic points (3,274,562 bytes) in an OS temp directory and measures 100 serial reads and fsync writes. On Node v26.8.1/macOS ARM64, read p50/p95/p99 was 5.708/6.993/11.099ms, and write+fsync was 9.817/12.069/15.659ms (max 28.286ms). It does not represent route/API or concurrent-user latency. Static code review identified synchronous repeated JSON reads and projections in `/momentum-shadow`; runtime measurement remains outstanding.
- Synthetic `/api/momentum-shadow` route benchmark now exercises 95 cohort session files and 11 book ledgers on an ephemeral loopback server with an OS-temp path fence: warm p50/p95/p99 10.44/11.30/11.96ms, cold p95 34.08ms, response 275,038B, 120 synchronous reads/153,495 bytes read per warm request; a high-density 33,300-row fixture had warm p95 20.90ms. `externalPathAttempts=0`; the fixtures were removed. This narrows the runtime-measurement gap but remains synthetic, single-process evidence, not exact live-ledger, concurrent-client, event-loop SLO, or deployed capacity proof.
- `MarketDataProvider` now normalizes Upbit cache reads for account valuation and market-price projection. Market-price API response rows remain arrays and gain nullable per-market source time and fetch time. Provider errors still return HTTP 500 on the general market route; valuation consumers turn them into unavailable prices. Swift account/position/PnL/history/market models retain optional provenance timestamps. This adapter seam does not itself create an independent collector or local/offline data source, and it applies no market-age threshold.
- Latest validation after the provider seam and cache-provenance path: Node 798/798, mobile auto-connect 5/5, server address policy 15 cases, Swift store 15 scenarios; ESLint, PWA verifier, and `git diff --check` passed. Focused market/provider, route, ticker-cache, and account-valuation tests: 28/28. Fake adapters only; no external market endpoint was called.
- Final validation after storage, PWA feature, and wallet consistency fixes: Node 786/786, mobile auto-connect 5/5, server address policy 15 cases, Swift store 14 scenarios; ESLint, PWA verifier, and `git diff --check` passed. Focused PWA regression set: 50/50; focused history store: 7/7; focused wallet/runtime mutation regressions: 66/66.
- Focused fake-exchange regressions cover request coalescing, HOLD request budgets, fsync-before-POST, restart lookup, partial fills, unscoped UUID failure, manual out-of-target market preflight, `watch` reservation gating, observer account single-flight, history snapshots, and pre-existing evidence-file permissions. Final validation: Node 780/780, mobile auto-connect 5/5, server address policy 15 cases, Swift store 14 scenarios; ESLint, PWA verifier, and `git diff --check` passed. The UI review used synthetic local data; no snapshot or trade action was activated. These tests did not call Upbit or place an order.
- Quote sampler candidate gate follow-up: baseline, A/B, and candidate preflights now require a fresh (≤900s), complete, error-free quote report covering the candidate's configured markets, including candle-close execution; quote-spread execution checks remain model-specific. API preflight now resolves the same report path/max-age as the quote quality panel. The PWA continues to show the block when the report is unavailable. Regressions cover missing, stale, incomplete, errored, and fresh reports across all nine readiness variants. Latest full validation: Node 798/798, mobile auto-connect 5/5, server-address policy 15/15, Swift store 15/15; ESLint, PWA verifier, and diff check pass. Desktop and 390px DRY_RUN staging showed the blocker; staging stopped, no baseline/A-B/candidate was started, and no order was submitted.

Remaining P0/P1 work includes fatal-process/supervisor protection ownership, account-wide management policy, cross-process evidence/persistence coordination, deployed server credentials/TLS, local-data operation scope, real device/settlement evidence, and runtime load/SLO measurement. The single-operator versus multi-user service decision and offline backtest/read-only/local automation choice are still unresolved.

## 이번 작업에서 구현하고 확인한 항목

- Dashboard API는 `DASHBOARD_TOKEN`과 별도의 `DASHBOARD_READ_ONLY_TOKEN`을 구분한다. 읽기 전용 토큰은 GET 경로 및 허용된 query만 서버에서 통과시키고, 전체 토큰과 동일한 값을 거부한다. iOS는 별도의 read-only token을 per-server Keychain에 저장하고 GET allowlist만 호출한다.
- Unsigned development Simulator builds lack the physical app's Keychain entitlement, so the simulator-only server token is now process-local memory and is cleared when the app restarts. The Simulator UI discloses this; physical-device builds continue to use per-server Keychain. This is not physical-device Keychain evidence.
- 네이티브 앱은 서버 응답이 실패하거나 오래된 경우 숫자를 0처럼 꾸미지 않고 resource별 stale/unavailable 상태를 유지한다. 서버 변경·로그아웃 후 도착한 이전 비동기 응답은 현재 계좌를 덮어쓰지 않는다.
- 네이티브 앱은 갱신 중에도 이전 성공 시각을 유지하고, 자산 기록 그래프 제목에 freshness를 표시한다. 그래프 자료의 일부 실패·요청 대기·이전 자료 유지는 Store 회귀 테스트로 확인했다.
- 계좌와 누적 손익의 현재 평가는 동일한 시세 snapshot을 사용한다. 가격이 없으면 평균 매수가로 현재가를 대신하거나 손익 0을 만들지 않는다. 선택 기간에 기록이 없으면 더 오래된 기간 데이터를 가져오지 않는다.
- `POST /portfolio/snapshot`도 계좌와 가상 지갑에서 전체 평가 마켓을 구성하고 동일한 strict valuation 계약을 사용한다. 계좌 실패, 부분 시세, 완전한 평가 실패면 이력 파일을 변경하지 않는다. 성공 기록은 source time·capture time·mode·valuation 상태를 보존하고, in-process 동시 writer는 409로 거부하며 JSON은 임시 파일에서 원자적으로 교체한다. provenance가 없는 이전 기록은 `unknown_legacy`로 내려보내 PWA/네이티브 차트에 알린다.
- Strict valuation은 이제 `trade_timestamp` 또는 유효한 `timestamp`가 없는 quote를 누락 시세로 처리한다. 오래된 source timestamp의 max-age 기준과 가격 source time 대 서버 fetch time의 정규화 계약은 아직 정하지 않았다.
- `SCALP_MAX_POSITIONS`, `SCALP_PORTFOLIO_ALLOCATION`, `SCALP_INVESTMENT_RATIO`의 명시적 `0`은 기본값으로 바뀌지 않는다. 0개 포지션 한도는 새 진입을 막고, 0 투자 비율은 0원 투자를 만든다.
- Read-only 모바일 paper-summary projection에 중복 선언된 cohort projector를 제거해 모듈 로딩 오류를 고쳤다. 반환 계약은 유지하고 전체 suite에서 로드/응답 경로를 다시 확인했다.
- iOS Server build는 synthetic preview JSON을 앱에 포함하지 않고, `bundled-preview` build만 fictional sample data를 포함한다. 번들 모드는 API 요청 없이 읽기 전용 화면을 제공한다. Home·Assets·Activity·Settings에서 예시 자료와 실제 계좌의 구분을 확인했고, Assets 화면의 “조회 전용 계좌” 오표시를 예시 배너/기준 시각 표시로 수정했다.
- 웹과 네이티브 화면의 중립·blue/green/red·차트 orange 값을 [Toss Design System 색상 토큰](https://tossmini-docs.toss.im/tds-react-native/foundation/colors/)에 맞췄다. 경고 문구는 작은 글자 대비를 위해 더 짙은 자체 amber를 쓴다. 웹에서는 Google Fonts 대신 기기 글꼴을 사용하고 Socket.IO client를 server-local resource로 바꿔 두 CDN 요청을 제거했다. Phosphor icon stylesheet는 CDN 의존으로 남으며 오프라인 표시 대체는 검증하지 않았다. 네이티브 주요 금액은 Dynamic Type를 따르며 Home·Settings를 iPhone 17 Simulator에서 확인했다. 이는 토큰 기준 정렬이지 TDS 컴포넌트 라이브러리 전체 도입은 아니다. [Toss Design System Typography](https://tossmini-docs.toss.im/tds-react-native/foundation/typography/)는 시스템 접근성 글자 크기 대응과 계층형 스타일 사용을 안내한다.
- 앱 타깃은 앱 아이콘만 담은 최소 자산 카탈로그를 컴파일한다. 기존 탐색용 이미지 카탈로그와 CoinPilotMark·Splash 이미지는 소스에 보존하지만 앱 번들에서는 제외한다. 화면·런치뷰는 네이티브 텍스트와 데이터 중심 구성으로 표시한다. `CoinPilotAppIconFlat` 대안은 보존하지만 선택된 앱 아이콘은 아니다.
- LIVE startup은 포지션 위험 감시 interval 또는 리스크 데이터 공백 한도가 0이면 차단한다. 시작 시 계좌 잔고와 target market의 미체결 주문을 확인하기 전에는 진입을 잠근다. 20개를 넘는 시장 목록에서도 계좌에 실제 보유한 target market을 전략 장부에 복구하며, 미체결 주문이 남아 있으면 새 판단을 시작하지 않는다.
- 기존 주문/체결 evidence에 남은 열린 시장도 재시작 관리 범위에 포함한다. evidence에 열린 매수 체결이 있으면 복구 포지션의 원래 진입 시각을 다시 써서 scalping 최대 보유시간 계산을 유지한다. 거래소에만 존재하고 evidence에 진입 시각이 없는 보유분은 복구 시각부터 계산하며 별도 표시하지 않는다.
- 계좌 row의 통화·잔고·잠금 잔고가 malformed면 sync는 실패하고 내부 포지션을 flat으로 닫지 않는다. 열린 주문이 있을 때는 해당 market을 주문 불가 상태로 두며, 다른 target market의 verified clear 상태에서는 보호 SELL만 허용할 수 있다. 동기화 중에도 마지막으로 알고 있는 포지션의 risk ticker 관찰을 계속한다.
- 5분 이상된 미체결 주문은 live execution evidence에서 이 엔진이 만든 UUID라고 확인할 때만 자동 취소한다. 소유권이 없는 주문은 취소하지 않고 sync를 미완료로 유지한다. 설정의 target market과 evidence로 복구된 시장만 자동으로 관리한다.
- LIVE 계좌 또는 미체결 주문 조회/취소 동기화가 실패하면 해당 trading cycle의 분석과 새 주문 판단을 건너뛰고 sync 시각을 전진시키지 않아 다음 cycle에서 재시도한다. 수량·주문 상태가 확인되지 않으면 런타임은 `SYNC_REQUIRED`, `/ready`는 not-ready를 반환하고 PWA/native 화면에서 신규 주문 잠금을 설명한다.
- Graceful shutdown은 진행 중 주문을 기다린 뒤 계좌와 target market 주문을 다시 읽는다. 포지션이 남으면 `PROTECTIVE_ONLY`로 drain하고, 계좌/주문 상태를 확인할 수 없으면 종료를 보류하고 재시도한다. 실패 상태를 읽은 exit handler는 대시보드를 닫거나 프로세스를 끝내지 않는다.
- LIVE 포지션이 있는 상태에서 `risk_data_gap`·`analysis_data_gap`이 발생하면 `PROTECTIVE_ONLY`로 전환한다. 분석·신규 진입을 잠그고 risk ticker 재시도를 유지한다. 새롭고 완전한 ticker에서 기존 손절/익절 조건만 평가하며, 내부 리스크 모니터에서 발생한 SELL만 통과하고 기존 live fill/evidence gate도 그대로 유지한다. 자료가 회복돼도 자동으로 새 거래를 재개하지 않는다. dry-run은 기존 fail-closed 세션 동작을 유지한다.
- fresh risk ticker가 청산 조건을 확인하면 의도를 계좌 조회 전에 메모리에 보존한다. 열린 주문 상태, 계좌 조회 실패·오류 데이터, 또는 계좌 재조회와 주문 실행 사이의 상태 변화로 주문이 막히면 다음 fresh ticker에서 다시 판단한다. Fake Upbit 테스트는 실제 `syncWithExchange()`의 열린 주문 조회 대기, 계좌 조회 오류·malformed 응답, 가격 회복, 주문·체결·정산 readback 이후 포지션 종료까지 확인한다. 의도는 여전히 프로세스 메모리에만 있어 재시작·강제 종료에는 보존되지 않는다.
- LIVE 주문에서 체결 미확정·부분 체결·계좌 정산 readback 누락이 발생하면 해당 시장을 order-state unknown/pending으로 잠근다. 같은 시장의 보호 매도와 전체 신규 진입은 재조정 전 차단되고, `executeTradingCycle()`은 동기화가 필요한 상태를 감지해 5초 이상 간격으로 재확인한다. UI LIVE 주문 helper도 같은 `canExecuteLiveOrder()`와 `_orderInProgress` 직렬화를 사용하며, 보호 전용·동기화 필요·주문 진행 중에는 주문을 보내지 않는다. 정상 operator stop 후 계좌·마켓 상태가 알려진 경우에는 수동 주문 기능을 유지한다. 번들 주문은 다음 leg마다 다시 gate를 확인한다. 가짜 거래소 테스트는 미확정 보호 SELL의 중복 제출을 재조정까지 막고, 실제 fill/readback 완료 뒤에만 재시도하는 흐름을 확인한다.
- `PROTECTIVE_ONLY` 상태를 `/api/status`, `/api/system-status`, PWA 주문 잠금·위험 요약, 네이티브 읽기 전용 상태에 전달한다. 상태가 해소돼 감시 대상 포지션이 평평해져도 자동 재개하지 않는다.
- Shutdown handler를 `src/runtime/exitHandlers.js`로 분리했다. SIGINT/SIGTERM은 관리 포지션이 있을 때 in-flight order 정산 뒤 protective-only로 drain하고, flat 뒤 paper session을 finalise하고 dashboard close와 logger flush를 기다린 후 종료한다. Unhandled rejection은 진행 중 주문을 drain하고 LIVE 상태를 재확인한 뒤 포지션 감시를 유지하고 flat 후 exit code 1로 종료한다. 로그에는 rejection 원문 대신 유형만 남긴다. `trader.start()` 오류도 graceful shutdown 경로를 사용한다. `uncaughtException`은 프로세스 메모리 상태를 신뢰할 수 없어 full stop 후 exit code 1로 종료한다.
- 대시보드 `/api/control/stop`도 direct `stop()` 대신 같은 graceful LIVE drain을 요청하며, 보유 감시·거래소 확인·진행 중 주문/리스크 확인 대기 중에는 로컬 포지션 수가 0이어도 `202`를 반환한다.
- PWA 핵심 상태 polling은 10초에서 30초로 낮췄고 화면 복귀·수동 새로고침은 즉시 조회를 유지한다. 현재 core refresh는 14개 경로를 읽으므로 주기 polling은 사용자당 약 28 GET/분이며 이벤트성 조회가 추가될 수 있다. 실제 API p95/p99·다중 사용자 부하는 계측하지 않았다.
- 웹 모바일 내비게이션은 네 개 주요 화면과 “더보기” 메뉴로 재구성됐다. 작은 화면의 터치 영역, 키보드 Escape·포커스 복귀, 화면 폭 초과를 확인했다.

## 검증 결과

| 확인 | 결과 |
|---|---|
| `npm test` | Node 730/730, mobile auto-connect 5/5, server address policy 15 cases, Swift store 14 scenarios 통과 |
| `npm run lint` | 통과 |
| `git diff --check` | 통과 |
| `npm run verify:pwa` | 통과, manifest·아이콘·PWA 캐시 자산·API/cross-origin 우회 정책 확인 |
| iOS `COINPILOT_DATA_MODE=server` clean Simulator build | 성공, preview JSON 미포함, Info.plist 값 `server`, Assets.car에는 앱 아이콘만 포함 |
| iOS `COINPILOT_DATA_MODE=bundled-preview` clean Simulator build | 성공, sample JSON 포함, Info.plist 값 `bundled-preview`, Assets.car에는 앱 아이콘만 포함 |
| 실제 UI | iPhone 17 / iOS 27 Simulator에서 bundled-preview Home·자산 freshness와 public PWA desktop 1280×720 (`PROTECTIVE_ONLY`, `SYNC_REQUIRED`, 주문 잠금)을 검토했다. 추가로 disposable iPhone 17 Simulator를 loopback staging DRY_RUN 서버에 private IP와 test-only read-only token으로 연결해 Home/paper-summary 화면을 확인했다. 앱 재기동 후 token이 다시 필요해 Simulator memory-only 경로도 검증했다. Staging/device 종료·삭제; 실제 호스트·거래소·주문은 접촉하지 않음. Physical-device Keychain은 미검증. |
| CI 설정 | workflow YAML과 Xcode project/Info.plist 구문 확인. 원격 GitHub Actions 실행은 하지 않음 |

한 번의 감사 도중 검토자가 Simulator의 “실제 서버 연결” 버튼을 잘못 눌러 저장된 주소로 `GET /api/auth/status` 한 건이 나갔다. 응답은 인증을 요구했고 토큰·자격 증명 입력은 없었다. 계좌·시세·거래·주문·정산 경로는 요청하지 않았고, 이후 같은 서버로 추가 요청하지 않았다. 이는 원격 연동 확인 근거로 계산하지 않는다.

## 출시 전 차단 항목

### P0 — 치명 예외·강제 종료 시 포지션 인계 계약

시장 데이터 공백이 발생했을 때는 LIVE 포지션을 대상으로 `PROTECTIVE_ONLY`를 구현했다. 분석·진입은 멈추고, risk monitor가 회복된 신선한 ticker에서 기존 보호 조건을 평가한다. 모니터 전용 SELL은 기존 체결 확인/evidence 경로를 통과해야 하며, 자동 재진입은 없다. fake exchange 테스트는 요청이 실패한 뒤 timer 유지·ticker 재시도·중복 없는 보호 SELL·BUY 거부를 확인한다.

SIGINT/SIGTERM은 in-flight risk check/order가 끝난 뒤 먼저 알려진 포지션의 감시를 protective-only로 유지하고, 계좌와 target market 미체결 주문을 다시 읽는다. 조회 실패나 미체결 주문이 남으면 종료와 신규 진입을 보류하고, market별 주문 상태가 확인될 때만 보호 SELL을 보낸다. 보호 ticker가 stop을 넘으면 계좌 조회 전에 청산 의도를 메모리에 보존하고, fresh ticker 재검증 뒤 fake 주문·체결·정산 readback까지 검증한다. 미확정/부분 fill은 같은 마켓을 잠그고 정기 sync보다 빠르게 재확인하며, 화면 주문은 보호 전용·미확정 상태에서 제출하지 않고 번들 leg도 각각 재검사한다. Injected-process unit test는 drain 전 종료를 막고, 종료 뒤 logger flush를 확인한다. 대시보드 중지 버튼과 startup도 같은 graceful/reconciliation contract를 사용한다. `unhandledRejection`은 현재 주문을 기다리고 이 종료 경로를 따른다. `uncaughtException`은 프로세스 메모리 상태를 신뢰할 수 없어 full stop 후 exit code 1로 종료한다. 이미 SIGINT/SIGTERM LIVE drain이 진행 중일 때 fatal exception이 추가로 오면, 기존 보호 drain을 그대로 유지하고 `process.exitCode=1`을 즉시 올린 뒤 drain 종료 후 1로 끝나도록 했다. 이 injected-process 회귀는 조기 종료·중복 drain이 없고 최종 exit code가 1임을 확인한다. LIVE intent는 주문 POST 전에 `fsync`되며, 재시작 시 UUID 또는 identifier 조회와 ambiguous POST 미재시도 경로를 fake exchange로 검증했다. 다만 실제 프로세스 강제 종료 뒤 복구, multi-process append/lock, filesystem/power-loss durability는 검증하지 않았다. fatal exception 이전에 보호 drain이 없던 경우, SIGKILL/OS 강제 종료, supervisor 종료 제한시간 초과, evidence에 없는 target 외 자산, 메모리에만 있는 보호 청산 의도는 여전히 노출될 수 있다. 시장 식별자가 없는 과거 UUID 주문은 조회에 실패하면 안전하게 전체 LIVE 진입을 멈추지만, 자동 해제 정책이 없어 수동 조사까지 잠길 수 있다. 복구된 evidence 없는 거래소 보유분에는 새로운 reconciliation time을 entry time으로 적용하므로 최대 보유시간 이력이 정확하지 않을 수 있다. 표준 Upbit [주문 생성 API](https://docs.upbit.com/kr/reference/new-order)는 지정가·시장가·최유리 주문 유형을 문서화하며, 이 구현에서 거래소 측 조건부 손절/익절 인계는 확인·구현되지 않았다. 실제 child-process signal/supervisor 종료 제한도 검증하지 않았다.

**통과 기준:** 종료 시 신규 진입 정지, 열린 포지션의 감시/거래소 보호 인계, 종료 제한시간 초과, 부분 실패, 재기동 복구가 서로 구분된 상태로 기록되고, SIGTERM·uncaught exception·rejection·supervisor 강제 종료 각 시나리오에서 보호 경계가 검증된다. 정상 SIGTERM·rejection·reconciliation·미확정 market lock·메모리 내 청산 재시도 및 WAL 재기동 projection은 fake exchange/unit tests 범위다. Fatal exception, OS 강제 종료, 독립 supervisor, 실제 프로세스 crash/restart, 분산 WAL은 미검증이다.

- 기존 SIGINT/SIGTERM drain 중 fatal exception이 같은 promise를 재사용해도 exit code가 1로 승격되고 drain이 유지되는 collision은 이제 regression으로 고정됐다. 독립 supervisor와 fatal-before-drain behavior는 계속 P0 미검증이다.

### P1 — 계정·배포 경계

- 실제 원격 호스트는 HTTPS로 제공하고, TLS 종료·forwarded headers·CORS·rate limit을 배포 구성까지 검증한다.
- read-only/static bearer token의 발급·회전·폐기 및 유출 대응 절차가 없다. production secret manager 연결과 로그 redaction을 검증한다.
- 현재 인증 단위는 서버 토큰이다. 여러 고객 계정이 같은 프로세스에 공존하거나 별도 권한·격리가 필요한 제품인지 먼저 결정한다.

### P1 — 거래 원장과 복구

- 서비스 상태는 로컬 JSON 파일 기반이다. 원자적 write, 동시 작성자, crash consistency, schema migration, 백업/복원 drill을 상용 운영 보장으로 간주할 근거가 부족하다.
- 대시보드 계좌 이력 writer는 단일 프로세스 안에서만 겹치는 요청을 거부하고 원자적으로 저장한다. 다른 프로세스 writer, 재기동 복구, 보존 정책, 백업/복원은 여전히 검증되지 않았다.
- 향후 저장소 교체는 ledger format compatibility와 기존 forward evidence를 보존하며 단계별 마이그레이션해야 한다.

### P1 — 데이터 수집과 서비스 분리

- 네이티브 read-only API는 거래 엔진과 분리된 별도 ingest/aggregation backend가 아니다. 시장 데이터 수집, ledger 저장, dashboard projection이 같은 Node 서비스 경계에 남아 있다.
- 독립 수집기·정규화 이벤트·저장소·조회 API로 분해하기 전에 데이터 ownership, freshness, replay/idempotency, correction semantics를 ADR로 결정한다.
- Timestamp 없는 가격은 current valuation이 될 수 없게 막았지만, 시장별 `sourceAsOf`와 서버 `capturedAt/fetchedAt`은 아직 하나의 normalized snapshot contract로 통합되지 않았다. 오래된 last-trade timestamp의 허용 정책은 운영·리스크별로 아직 분리되지 않았다.

### P2 — 모듈 경계·성능

- `MultiCoinTrader`와 API route가 전략, 상태, persistence, presentation을 함께 다루는 큰 모듈로 남아 있다. 큰 분리는 current test contract를 고정한 seam별 변경으로 진행해야 한다.
- 가격 API의 p95/p99, event-loop lag, 메모리, 요청 제한, JSON history 크기, 느린 디스크의 실제 부하 기준은 아직 정하지 않았다. PWA 주기 조회는 84에서 28 GET/분/사용자로 낮췄지만, 이벤트성 조회가 추가되고 실제 부하는 미측정이므로 “대규모 성능”으로 완료 표시하지 않는다.

### P2 — 제품 검증

- 현재 iOS 검증은 Simulator build/화면/가짜 fixture다. physical device, voice-over/동적 글자 크기, 접근성 대비, TestFlight, 네트워크 전환/저전력/앱 종료 시나리오는 미검증이다.
- 실제 server + read-only token 통합, 배포 환경, 모니터링·알림·백업 복구는 별도의 운영환경 증거가 필요하다.
- 백테스트·모의 기록은 실제 주문·체결·정산 또는 전략 수익성 증거가 아니다.

## 다음 작업 순서

1. **운영 중단 계약 문서화** — 열린 포지션 감시를 누가 소유하는지, 종료와 재기동 사이의 동작을 정한다. 그 계약을 fault-injection 테스트로 고정한다.
2. **원격 접근 배포 baseline** — HTTPS reverse proxy, secrets, allowlist, token rotation, health/readiness와 알림을 staging에서 검증한다.
3. **데이터·저장 경계** — ingestion, ledger ownership, read model, durable store interface와 migration/recovery 계약을 설계한다.
4. **서비스 규모의 요구조건 결정** — 단일 운영자 제품인지 다중 고객 서비스인지 확정하고, 격리·용량·SLO 기준을 정의한다.
5. **검증 가능한 모듈 분리** — route/service, trader lifecycle, persistence를 계약이 명확한 경계부터 좁게 분리한다.
6. **실기기·운영 승인** — 접근성·성능·보안 테스트와 staging/production 운영 증거를 확보한 뒤에 출시 여부를 판단한다.

## 변경 보호 원칙

- `DRY_RUN` 기본값, live gate, 주문·체결 모델, 거래 전략 파라미터를 디자인/기반 작업과 묶어서 변경하지 않는다.
- 실거래에 닿는 변경은 별도 요구사항, 회귀 테스트, 운영자 검토 후 진행한다.
- 무한 범위 목표의 완료를 주장하지 않는다. 각 단계의 코드·테스트·실기기·배포 증거를 따로 기록한다.

## 2026-09-29 continuation — startup, provenance, and request-local projection

- The dashboard startup bind gate and its focused regression set passed `37/37`. PWA order-banner and source/fetch timestamp changes passed `57/57` focused cases plus `npm run verify:pwa`. Native provenance UI/store checks passed 16 scenarios; the `bundled-preview` Simulator build reported `BUILD SUCCEEDED` and was reviewed on iPhone 17 Simulator.
- A same-fixture synthetic `/api/momentum-shadow` comparison added a request-local parsed-file snapshot. Warm reads fell from `183` to `50` per request and bytes from `2.70 MB` to `1.19 MB`; warm p95 fell from `27.23ms` to `12.49ms`. Warm event-loop-delay p95 fell from `25.87ms` to `13.95ms`. Cold/warm response sizes stayed at `194,141`/`193,901` bytes. The route snapshot is scoped to one request; the benchmark is synthetic, single-process evidence, not an SLO or deployed-capacity result.
- `MarketDataProvider` remains an adapter seam over the existing Upbit cache, not an independent collector. `bundled-preview` still contains fictional read-only data. PWA and iOS provenance timestamps have no configured staleness threshold. Physical-device testing and distribution/release acceptance remain unverified. The choice of local operating mode and single-operator versus multi-user deployment is still pending.
- Incident record: `NODE_ENV=test node --test test/strategyResearchRoute.test.js` was accidentally run as a full file suite in an earlier turn. It reported 10 passing and one failure before the new test reached HTTP; default owner/candidate path access was not instrumented, so actual reads are **outcome unknown**. No owner/ledger write or order was reported. The empty temporary test directory from that failed setup was removed; the suite was not repeated.
- The synthetic local dashboard remains on `127.0.0.1:39471`, PID/PGID `33288`, started through `managed-process`; the session-end hook will clean it up.

## 2026-09-29 follow-up — timestamp semantics, allocation, and fatal shutdown

- Latest PWA order-banner, source/fetch timestamp, and allocation-view regressions passed `63/63`; `npm run verify:pwa` and targeted ESLint passed. PWA assets are JS `20260929-28` / service worker `v172`. Native Store passed 16 scenarios; the fictional bundled-preview Simulator build reported `BUILD SUCCEEDED` and has an iPhone 17 Simulator screenshot.
- Upbit defines ticker `trade_timestamp` as the latest trade timestamp, so the interface now labels this field `최근 체결`; `fetchedAt` remains the server's collection time. See the [official Upbit ticker API reference](https://docs.upbit.com/kr/reference/list-quote-tickers).
- Allocation shows a full single-item row without a pie. It draws a chart only for a complete multi-item composition; unknown cash or unvalued holdings suppress ratios rather than fabricating a percentage. The PWA behavior is covered by the 63-case focused set.
- Open P0: the standalone `uncaughtException` handler with LIVE positions/orders still bypasses drain and reconciliation, calls `stop()` (which disables the risk monitor), closes the dashboard, and exits. Its standalone test covers only a flat trader. This path is unmodified and remains pending a user decision about fatal-shutdown ownership. The local-mode/deployment choice is also unanswered, so the overall goal remains active.

## 2026-09-29 latest PWA visual correction

- Following the historical JS `20260929-28` / SW `v172` entry, current assets are JS `20260929-29`, CSS `20260929-17`, SW `v173`; focused `pilotRedesignRefresh` passed `64/64` and `verify:pwa` is valid. CUA confirms the cash-only portfolio panel is compact (`KRW 1,000,000 · 100%`) without a pie or blank stretch, and the manual-order banner clearly distinguishes stopped auto trading from available DRY_RUN manual orders. Ticker `trade_timestamp` remains last-trade time (`최근 체결 시각`); `fetchedAt` remains server collection time.

## 2026-09-29 market chart-range follow-up

- PWA now offers 30/60/100-candle ranges (default 60). Rendering uses a copied last-N valid-candle subset for candles, axis, and time labels; the API still requests 100 candles and the original array remains unchanged. Focused `pilotRedesignRefresh` passed `66/66`, `verify:pwa` is valid, and assets are JS `20260929-30` / CSS `20260929-18` / SW `v174`. CUA checked a synthetic market view at the available 800×600 viewport, not 1280×720; full x-axis labels were not visible. Prior incident/process notes remain intact; fatal-shutdown, local-mode, and deployment decisions remain open.

## 2026-09-29 manual mutation, single-writer, and UI follow-up

### Verified changes

- Seven public manual-trade POST routes and three virtual-wallet POST routes require `Idempotency-Key`. The server hashes profile/key/request identity without storing bearer tokens or raw keys, returns 428 for a missing key, 409 for key/body mismatch, 202 for pending/unknown, and replays a completed HTTP status/body exactly.
- PWA and legacy clients persist the key, exact endpoint, and serialized request body before the first POST. They reuse that record after reload, timeout, network/parse failure, 202, or unknown response. They keep distinct orders and wallet changes locked while unresolved; 409 and 428 remain fail-closed.
- DRY_RUN manual operations share a process-local portfolio transaction queue with automatic `executeOrder`. Portfolio persistence is deferred during the operation; the completed receipt and portfolio state are atomically saved together. Startup merges journal and portfolio receipts to recover the journal if its follow-up write failed.
- LIVE ambiguous results remain `unknown` and do not resubmit. Smart sell re-reads shared holdings immediately before execution and clamps volume/proceeds against the current amount. The order-to-exchange-intent reconciliation link and automatic resumption of incomplete multi-leg orders are not implemented.
- A same-host writer lock is acquired by mutable `DashboardServer` startup before listening. Same-profile dashboard instances and child processes fail closed; dead same-host PIDs are reclaimed only after serialized inode/token/PID rechecks. Read-only observers do not claim the lock. Default runtime data/journal/lock/temp files are ignored by Git.
- UI fixes: smart-buy displays verified KRW balance; smart-sell displays a total only when all holdings are valued; a complete known-empty list alone displays 0 KRW. The Settings comparison action no longer wraps its label. The News modal traps keyboard focus, closes on Escape/backdrop, and restores focus to the matching article row. CUA at 1280×720 and 390×844 inspected the local fake dashboard; no order or wallet action was executed.
- Design basis: the web CSS uses TDS-mapped neutral and blue foundation values and native platform fonts; it is still a custom HTML/CSS component system, not full TDS component or typography-token integration. TDS documents named [color tokens](https://tossmini-docs.toss.im/tds-react-native/foundation/colors/) and recommends [typography tokens](https://tossmini-docs.toss.im/tds-react-native/foundation/typography/) over hard-coded sizes.

### Verification

| Check | Result |
|---|---|
| `node --test test/manualOrderIdempotency.test.js test/dashboardStartup.test.js test/dashboardAuth.test.js test/liveTradingRouteFillGuard.test.js` | 46/46 passed |
| `node --test test/pilotRedesignRefresh.test.js` | 89/89 passed |
| `npm run verify:pwa` | valid; JS `20260929-37`, CSS `20260929-21`, SW `v181` |
| `npx eslint public/pilot-redesign.js test/pilotRedesignRefresh.test.js` | passed |
| `node --check public/pilot-redesign.js` | passed |
| `git diff --check` | passed |

No real account, exchange API, or order was used. The full suite and release/staging were not run. The writer lock is limited to same-host local filesystems and mutable dashboard startup; automatic-only processes with the dashboard disabled, shared/network filesystems, and multi-host/multi-user profiles remain unsupported. VoiceOver/direct DOM focus inspection, completed-result recovery for LIVE unknown commands, and bounded idempotency journal retention remain open. The broader goal stays active.
