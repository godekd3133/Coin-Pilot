# Production Readiness Roadmap

Coin Pilot을 상용 서비스 수준으로 끌어올리기 위한 단계별 개선 계획.

- 작성일: 2026-09-16
- 최신 상태 점검: 2026-09-30
- 태스크: `docs/tasks/H1-2026-09-16-mk-prod-readiness.md`
- 운영 맥락: 개인 자동매매 봇, 같은 LAN의 모바일에서 대시보드 접속 중

> **상태 기준:** 아래 Phase의 “현재 문제” 목록은 2026-09-16 초안 당시의 기록이다. 일부는 이후 구현되어 현재 상태와 다르다. 최신 구현·검증·미해결 사항은 [`commercial-readiness-audit-2026-09-29.md`](commercial-readiness-audit-2026-09-29.md)를 기준으로 본다.

## 2026-09-30 상태 요약

| 영역 | 상태 | 근거와 남은 범위 |
|---|---|---|
| 대시보드 API 인증 | 로컬 구현 확인 | 전체·모바일 운영·읽기 전용 토큰 범위를 분리한다. PWA는 로그인 범위를 보존하고 저장 토큰을 다시 확인하며, 읽기 전용은 서버의 기존 GET allowlist에 제한되고 소켓·변경 요청을 만들지 않는다. 모바일 운영 토큰은 iOS 전용으로 안내한다. 서버 인증이 권한의 기준이며, 토큰 발급·회전, 공개 환경 TLS·reverse proxy는 운영 배포에서 확인되지 않았다. |
| 헬스·준비 상태 | 로컬 구현 확인 | `/health`는 최소 liveness, `/service-ready`와 `/ready`는 process-local Upbit scheduler 큐·대기·in-flight·backoff 진단을 반환한다. 진단값만으로 HTTP readiness를 내리지 않으며, `/ready`의 기존 trader·analysis·risk와 LIVE account/order reconciliation gate는 유지한다. 여러 프로세스의 외부 관측·알림·SLO는 별도 과제다. |
| CI·테스트·lint | 로컬 검증 통과 | 최신 `npm test`: Node 1,157, mobile auto-connect 5, server-address policy 20, offline replay 12, dynamic Node/Swift parity 4, replay persistence 15, Swift Store 38 통과. ESLint, `git diff --check`, `verify:pwa`, server-profile iOS Simulator build 통과. 실제 GitHub Actions 실행은 포함하지 않았다. |
| Dependency security | 현재 production tree 감사 통과 | 미사용 `node-cron`을 제거하고 `uuid`를 `14.0.2`로 올린 뒤 `npm audit --json`은 0건이다. Node `20.20.2`에서 UUID ESM `v4()` 로딩이 통과했고 전체 테스트·lint도 통과했다. |
| 성능·용량 | 측정 중 | Source-aligned 14-route local synthetic benchmark, representative 95-session/11-book fixture: 12-warm-round 1/4/8-client aggregate p95/p99 `239/248`, `98/106`, `381/637ms`; separate 40-warm-round 8-client repeat p50/p95/p99 `40/143/225ms`, event-loop p95/p99 `66/135ms`. HOLD-only analysis now reuses one cycle-start account snapshot instead of one additional read per market; actionable orders retain a fresh account/position check, and SELL uses that fresh asset balance. This reduces request count, not measured latency. Runs vary materially and are diagnostics, not SLOs. 8,640-point JSON history microbenchmark: read p95 6.99ms, atomic fsync write p95 12.07ms. User targets, exact production data, deployed latency, and SLOs remain unverified. |
| 설정 검증 | 부분 완료 | `ENV_SCHEMA`와 런타임 검증은 존재한다. 모든 스크립트의 직접 `process.env` 접근과 설정 계약은 여전히 단계적으로 단일화해야 한다. |
| 실행·데이터 구조 | 로컬 단일 프로세스 경계, Hosted 격리 미구현 | 거래 엔진과 대시보드 API가 같은 Node 프로세스에서 실행되고 JSON ledger/history를 사용한다. 로컬 standalone과 Hosted SaaS는 모두 선택된 제품 방향이나, Hosted tenant identity·분산 트랜잭션·장애 복구 서비스는 구현되지 않았다. |
| 시장 데이터 소스 선택 | 앱 서비스 간 public reader와 profile last-good snapshot 구현, 독립 collector·분산 조정 미완료 | primary/legacy runtime은 동일 credential-free `PublicMarketDataSource`를 trader와 dashboard에 주입한다. Upstream quote 관측은 profile-derived 1,000-market/2 MiB store에 최대 5초 write interval로 저장되고 Dashboard cached reads는 1초 이내 capture를 재사용한다. Upstream outage 때 `/api/market/prices/snapshot`은 persisted last-good을 명시해 read-only 표시용으로 반환한다. Writer lock은 profile lifetime에 묶이며 atomic owner-only replace와 service-ready persistence telemetry를 제공한다. 독립 주기 수집 프로세스, cross-profile shared store, multi-process/multi-host quota coordinator는 미구현이다. |
| 시세·자산 상태 표시 | PWA와 iOS의 per-market freshness 보강, Toss 수용 미완료 | 최신 quote read 실패와 최근 exchange timestamp를 별도 표시하고, 종목별 상태·server capture time을 노출한다. 서버가 `quoteFresh=false`를 반환하면 timestamp가 최근이어도 주문을 막는다. 자산 추이는 timestamp가 다른 평가 기록 2개 이상일 때만 그리고, 단일 기록은 snapshot 상태로 표시한다. 현재 소스는 CUA로 약 640×853에서 deterministic dashboard-only mock과 함께 봤다. 해당 capture는 임시 파일로 저장되지 않았다. Last-good 상태, 390×844/1280×720, Toss layout comparison, iOS 설치본, VoiceOver는 미검증이다. |
| 주문·자동매매 시세 신선도 | 주문 전 fail-closed, 분석·risk quote 계약 통합 완료 | 수동/Smart 및 iOS/PWA 대상 주문과 자동 분석, 보유 포지션 risk, delayed entry confirmation이 같은 `trade_timestamp` 정책을 쓴다 (`maxCandleAgeSeconds`, 90초 fallback, 미래 오차 5초 허용). Stale risk ticker는 성공이나 exit 가격으로 쓰지 않고 실패로 기록한다. `last_good` fallback은 자동 분석·risk·fresh 주문에서 사용하지 않으며, UI는 저장된 최근 시세를 표시하면서 종목 주문을 막는다. 계좌/PnL/portfolio valuation 및 이력은 신선한 upstream quote만 사용한다. 회귀 검사는 120초 stale quotes와 fresh-timestamp last-good fallback을 사용했으며 실계정이나 주문을 호출하지 않았다. |
| 네이티브 앱 데이터 경계 | 로컬 검증 통과 | `server` 기본 빌드는 데이터 pack을 제외하고, `bundled-preview`만 fictional example을, `bundled-local`만 명시된 공개 KRW OHLCV 파일을 포함한다. Local 모드는 서버 요청·주문·계좌 데이터와 분리되고, 50 MiB strict schema/sidecar 검증 및 background load를 적용한다. 패키지 자료는 여전히 고정 스냅샷이며 외부 공급자 진위·최신성은 별도 미검증이다. |
| 로컬 데이터 운용 | 고정 설정 단일 시장 역사 replay v1 및 재개 가능한 playback session | 전체 선택 series를 pure Swift 커널에서 replay하고 현재 Node `simulateScalping` 기본값과 4개 결과 경로의 parity를 확인한다. 1.5× interval 초과 gap은 거부하고, stop gap-through는 불리한 open 가격으로 처리하며 60분 replay는 차단한다. 최근 5개 결과는 semantic validation이 적용된 atomic archive에 저장된다. `bundled-local`에는 4/10/20 candle-per-second historical playback, pause/resume/reset, fingerprint-bound 16 KiB checkpoint가 추가됐으며 durable cursor는 1초 간격과 상태 전환에서 저장한다. 이 replay는 현재 시세·실계좌·체결이 아니며 주문/API 없이 동작한다. 지속 DRY_RUN, configurable strategy, real-pack freshness/provenance, 전원 손실 내구성, 실제 기기 시각/접근성 검증은 별도 gate다. |
| Hosted tenant manager | shared-process SaaS는 tenant principal과 per-account execution ownership 전까지 비활성 | 현재 bearer role은 identity가 아니며 account cache, AI state, Socket.IO broadcasts, account/credential routes가 singleton trader를 공유한다. 첫 Hosted cell은 tenant/account마다 private runtime, volume, secret, and gateway-resolved routing을 둔다. Tenant-B isolation matrix가 배포 전 gate다. |
| 실계정·배포 | 미검증 | 실제 서버의 읽기 전용 토큰, 실기기/TestFlight/App Store, 실거래·체결·정산, 상시 운영은 이번 로컬 검증으로 입증되지 않았다. |

## 2026-09-16 Phase 초안 (기록용)

아래 Phase별 문제 목록과 완료 기준은 최초 계획의 근거를 보존하기 위한 기록이다. 현재 구현 상태 판정은 위 상태 요약 및 최신 감사 문서를 우선한다.

## 불변 조건 (모든 Phase 공통)

개선 작업이 전략/검증 계약을 훼손하면 안 된다.

1. `scalping_validation.json` 등 live-gate 산출물의 경로·스키마·계약을 바꾸지 않는다.
2. research-only lane(`promoted=false`, `researchOnly=true`)의 비승격 계약을 유지한다.
3. fail-closed 경계 — candle freshness, heartbeat watchdog, analysis/risk data gap, execution boundary — 를 약화시키지 않는다.
4. `DRY_RUN` 기본값과 실주문 게이트는 명시적 승인 없이 변경하지 않는다.
5. 실행 중인 러너가 쓰는 런타임 ledger 파일(`*.ledger.json`, `.paper-*/`)은 커밋 대상이 아니다.

---

## Phase 0 — 대시보드 보안 잠금 (최우선)

**목표**: 토큰 없는 클라이언트가 봇을 조회·제어할 수 없게 한다.

**현재 문제**

- `cors()` 기본값(`*`) + socket.io `origin: '*'` (`src/api/dashboardServer.js`)
- `httpServer.listen(port)` → 모든 인터페이스(0.0.0.0)에 바인딩
- `/api/config/update` 등 mutation 엔드포인트에 인증 없음
- `jsonwebtoken`은 Upbit API 서명에만 사용되고 대시보드 인증에는 미사용

**작업**

- `DASHBOARD_TOKEN` env 추가. 미설정 시 loopback 바인딩만 허용(또는 부팅 경고 후 read-only)
- Express 미들웨어: `/api/*` Bearer 토큰 검증
- socket.io handshake `auth.token` 검증
- 정적 파일 보호: 로그인 페이지는 공개, 나머지는 토큰 필요 (모바일은 localStorage에 토큰 저장)
- CORS를 same-origin 또는 명시 allowlist로 축소
- `DASHBOARD_HOST`로 바인드 주소 설정화

**완료 기준**

- 토큰 없이 `/api/*` 호출 → 401, socket 연결 거부
- 모바일에서 토큰 로그인 후 정상 동작
- 라우트/소켓 인증 테스트 추가

---

## Phase 1 — CI 실질화 + 정적 검사

**목표**: 회귀가 main에 들어오기 전에 빨간불이 켜지게 한다. 이후 모든 Phase의 안전망.

**현재 문제**

- CI가 `node --check src/index.js` 한 줄뿐 — 350개 테스트를 실행하지 않음
- eslint/prettier/editorconfig 없음
- CI matrix가 Node 18(EOL)/20

**작업**

- CI에서 `npm test` 실행
- eslint flat config 도입(최소 룰셋: no-undef, no-unused-vars, import 정리) + `npm run lint` + CI 연동
- Node 20/22 matrix로 갱신, `engines` 필드 정합
- (선택) prettier 또는 eslint stylistic으로 포맷 통일

**완료 기준**: 실패하는 테스트·lint 오류가 있는 변경이 CI에서 fail

---

## Phase 2 — Config 스키마 단일화

**목표**: 잘못된 환경설정이 부팅 즉시 명확한 에러로 실패하게 한다.

**현재 문제**

- ~40개 파일이 `process.env`를 직접 읽음 — 오타·파싱 불일치·기본값 산재
- `.env.example` 32KB, knob 수백 개, 스키마 검증 없음

**작업**

- `src/config/` 단일 모듈 + 스키마 검증(zod 또는 동등 수단), 부팅 시 fail-fast
- 직접 `process.env` 접근을 config 모듈 주입으로 점진 교체
- `test/envDocumentation.test.js`를 확장해 `.env.example` ↔ 스키마 동기화 강제

**완료 기준**: 필수 env 누락/형식 오류 → 부팅 시점에 어떤 키가 왜 잘못됐는지 출력 후 종료

---

## Phase 3 — 관측성 (로깅/헬스)

**목표**: 운영 중 상태를 외부에서 확인하고, 장애 시 로그만으로 원인 추적이 가능하게 한다.

**현재 문제**

- 자체 Logger가 매 라인 `appendFileSync` — 이벤트 루프 블로킹, 구조화 없음
- `/health`·readiness 엔드포인트 없음
- `cleanOldLogs` 호출 여부 불명확 → 로그 무제한 증가 가능

**작업**

- 구조화 로그(JSON line) 옵션 + 비동기 쓰기, 또는 pino 등 검증된 로거로 교체
- `/health`(liveness) + readiness(분석 데이터 건강, risk monitor 상태, 마지막 성공 사이클 시각) 노출
- 로그 보관 정책 일원화

**완료 기준**: `/health`가 프로세스/세션 상태를 반환, 로그 라인이 JSON으로 파싱 가능

---

## Phase 4 — 아키텍처 Deepening

**목표**: god file을 deep module로 분해해 변경 국소성과 테스트 가능성을 확보한다.

**대상 (우선순위)**

| 파일 | 행 수 | 분해 후보 seam |
|------|-------|----------------|
| `src/trader/multiCoinTrader.js` | 5,414 | 시장 스캔/분석 루프, 진입 재검증(entry confirmation), 리스크 모니터, 포지션 장부, 포트폴리오 상태 |
| `src/backtest/scalpingBacktest.js` | 2,700 | 캔들 소스, 신호 평가, 체결 시뮬레이션, 리포트 |
| `src/api/routes/trading.js` | 2,153 | 라우트 ↔ 세션/리스크 조작 서비스 분리 |

**진행 방식**: 각 대상은 별도 하위 태스크로 분해하고, 인터페이스(무엇이 seam 뒤로 가는가)를 먼저 합의한 뒤 구현한다. 전략 계약(fail-closed 경계, telemetry 키)은 인터페이스 일부로 명시해 리팩터링으로 약화되지 않게 한다.

**완료 기준**: 분해된 각 모듈이 좁은 인터페이스로 독립 테스트 가능, 기존 테스트 전부 green 유지

---

## Phase 5 — 데이터 경계 + 저장소 위생

**목표**: 런타임 산출물을 단일 `data/` 경계 안에 모으고 저장소 루트를 코드 전용으로 유지한다.

**현재 문제**

- 루트에 `.paper-forward-v*` 80+ 디렉토리, `backtest_results_*.json` ~200개, 검증 리포트 산재
- `portfolio_history.json` 1.1MB 무제한 성장
- `context.md` 366KB, `scorecard.md` 500KB, `README.md` 92KB — 생성 문서가 루트 혼잡 유발

**작업**

- `DATA_DIR`(기본 `./data`) 설정으로 ledger/history/results 경로 일원화
- 기존 파일 마이그레이션 경로(실행 중인 러너가 기존 경로를 참조하므로 하위호환 or 마이그레이션 스크립트)
- `portfolio_history.json` retention 정책
- 생성 문서(`context.md`, `scorecard.md`)는 `docs/` 아래로 이동하거나 생성 경로 변경

**완료 기준**: `git status` 기준 루트가 코드/설정 파일만 포함, 실행 중 산출물은 `data/`로 기록

---

## Phase 6 — 런타임 + 배포

**목표**: 재현 가능한 실행 환경과 안전한 의존성 관리.

**작업**

- `engines` Node 22 LTS, CI matrix 정합
- `npm audit`(또는 `npm audit signatures`)를 CI에 추가, `axios`/`cheerio(rc)`/`express 4` 등 갱신 검토
- `Dockerfile` + `.dockerignore`, 또는 pm2 `ecosystem.config.js` + 재시작 정책 문서화
- 배포 시 `.env`/데이터 볼륨 분리 지침 문서화

**완료 기준**: 클린 체크아웃에서 `npm ci && npm test` 통과, 컨테이너 또는 pm2로 재시작 가능

---

## Phase 7 — 지속 품질 장치

**목표**: 한 번의 정리가 아니라 품질이 유지되는 구조.

**작업**

- `node --test --experimental-test-coverage` 커버리지 수집 + 최소 임계값
- dependabot/renovate 주간 의존성 PR
- (선택) lint-staged + pre-commit hook
- (선택) 에러 리포팅 훅 — 현재 ntfy 알림 경로 재사용 가능

**완료 기준**: 커버리지 리포트가 CI 산출물로 생성되고 임계값 미만 시 fail

---

## 진행 원칙

1. **Phase별 독립 가치** — 각 Phase는 그 자체로 이득이 있고, 순서는 권장일 뿐 강제가 아니다.
2. **Phase 0+1을 먼저** — 보안 구멍 봉합 + CI 안전망이 있어야 이후 리팩터링이 안전하다.
3. **Phase별 브랜치** — `agent/<task-id>`로 분기, 검증 후 머지. 한 번에 여러 Phase를 섞지 않는다.
4. **테스트 계약 유지** — 각 Phase 완료 기준에 항상 "기존 테스트 전부 green"을 포함한다.

## 2026-09-29 continuation — latest local evidence

- The dashboard startup bind gate passed its focused `37/37` set. PWA order-banner and source/fetch timestamp coverage passed `57/57` plus `npm run verify:pwa`. Native provenance UI/store checks passed 16 scenarios; bundled-preview built successfully and was reviewed on iPhone 17 Simulator.
- Same-fixture synthetic `/api/momentum-shadow` warm measurements improved from 183 to 50 file reads/request, 2.70 to 1.19 MB/request, and 27.23 to 12.49ms p95. Response bytes were unchanged; event-loop-delay p95 moved from 25.87 to 13.95ms. This remains a single-process synthetic benchmark, not a service SLO.
- Open boundaries remain: the profile last-good snapshot is request-driven, not a separately scheduled collector; Upbit quota coordination is process-local; a shared cross-profile store and cross-process/multi-host lease are not implemented. Bundled-local data still lacks authenticated source provenance and a maximum-age policy; bundled-preview is fictional; physical-device and release verification are absent; Hosted tenant/storage topology remains unimplemented.
- An earlier accidental full `strategyResearchRoute` file-suite run left default owner-path reads **outcome unknown**; it was not repeated. No owner/ledger write or order was reported, and its empty temp fixture directory was removed. The synthetic local dashboard is still managed on `127.0.0.1:39471` (PID/PGID `33288`) for session-end cleanup.

## 2026-09-29 follow-up — latest UI and safety evidence

- PWA order-banner, source/fetch timestamp, and allocation behavior passed `63/63`; PWA verification and targeted ESLint passed. Assets are JS `20260929-28` / service worker `v172`. Native Store passed 16 scenarios; fictional bundled-preview built successfully and was captured on iPhone 17 Simulator.
- Upbit `trade_timestamp` means latest trade time, displayed as `최근 체결`; `fetchedAt` remains server collection time ([official ticker API](https://docs.upbit.com/kr/reference/list-quote-tickers)). Allocation avoids pie charts for one item and hides ratios when cash or holding valuation is unknown.
- Historical status before the latest fatal-shutdown verification below: the standalone `uncaughtException` path was reported as bypassing LIVE drain. That status is superseded by the later registered-handler regression; actual process/supervisor crash recovery remains open. Local operating mode and deployment topology are also unresolved.

## 2026-09-29 latest PWA visual correction

- Preserve the prior JS `20260929-28` / SW `v172` record as history. Latest assets are JS `20260929-29`, CSS `20260929-17`, SW `v173`; focused `pilotRedesignRefresh` is `64/64` and `verify:pwa` is valid. CUA confirms the compact `KRW 1,000,000 · 100%` cash-only row without a chart/stretch and a manual-order banner that distinguishes stopped automation from available DRY_RUN manual orders. `trade_timestamp` denotes last trade time (`최근 체결 시각`); `fetchedAt` is server collection time.

## 2026-09-29 market chart-range follow-up

- PWA range options are 30/60/100 candles, default 60; it renders a copied last-N valid-candle subset for candles/axis/time labels while the API still requests 100 and the original array stays unchanged. `pilotRedesignRefresh` passed `66/66`, `verify:pwa` is valid, assets are JS `20260929-30` / CSS `20260929-18` / SW `v174`. CUA checked synthetic data at 800×600 (not 1280×720); full x-axis labels were not visible. Prior incident/process records remain intact; fatal/local/deployment decisions remain open.

## 2026-09-29 synthetic dashboard read capacity

- Run `npm run benchmark:dashboard-read-capacity` for the default 1/4/8 logical-client profiles, or `npm run benchmark:dashboard-read-capacity -- --self-check` for the one-client runner self-check. The report includes aggregate and per-route p50/p95/p99 latency and response bytes, event-loop delay, errors, throughput, and Node/runtime details for one cold refresh and repeated warm refreshes.
- Historical small synthetic 13-route run (`--profiles=1,4 --warmup-samples=2 --warm-samples=5`, Node v26.8.1 arm64): 1-client cold p50/p95/p99 was 33.303/40.740/40.740 ms and warm was 13.112/40.964/41.473 ms; 4-client cold was 57.386/74.834/75.064 ms and warm was 42.081/170.647/174.848 ms. There were no request errors or out-of-temp filesystem attempts. This is five warm rounds, with no target threshold.
- Historical full 13-route synthetic profile rerun (Node v26.8.1 arm64; 1/4/8 logical clients, 3 warmup and 12 measured waves per profile): warm p50/p95/p99 was 4.760/20.677/28.778 ms at 1 client, 10.476/30.385/37.839 ms at 4 clients, and 16.964/41.414/58.040 ms at 8 clients. Cold p95 was 41.998/105.095/99.003 ms respectively. All cold, warmup, and warm requests succeeded; each profile recorded zero out-of-temp filesystem attempts and removed its OS temp directory. Twelve warm waves per profile remain a small sample, and no target threshold has been defined.
- The historical runner verified the current PWA `loadCore()` request map but measured only these 13 GETs against a fake trader and market-data provider: `/api/status`, `/api/account`, `/api/cumulative-pnl`, `/api/today-summary`, `/api/statistics`, `/api/scalping-validation`, `/api/strategy-readiness`, `/api/paper-validation`, `/api/portfolio-analysis`, `/api/portfolio/history?period=24h`, `/api/trades?limit=12`, `/api/market/prices`, and `/api/target-coins`.
- The prior exclusion of `/api/momentum-shadow` was removed using the existing `createResearchRoutes(server, { paperForwardCohortRootDir })` seam, now passed through `DashboardServer` options. The route scans a synthetic cohort root in OS temp; candidate, shadow-ledger, quote, and live-execution-evidence paths also point to temp fixtures. `/api/strategy-research` remains outside the PWA `loadCore()` set. The existing filesystem guard remains in place and rejects runtime data access outside OS temp while allowing read-only source/dependency reads and `public/` static-file metadata checks.
- Historical 14-route empty-fixture smoke self-check (Node v26.8.1 arm64) confirmed 14 current requests, 14 measured requests, no omitted routes, and successful cold, warmup, and warm waves. `/api/momentum-shadow` had an empty synthetic cohort and empty book ledgers. The separate focused `DashboardServer` route-option test passed and confirmed the response cohort root came from the supplied temp directory.
- Historical small empty-fixture smoke run (`--profiles=1,4 --warmup-samples=2 --warm-samples=5`, Node v26.8.1 arm64, generated `2026-09-29T04:48:05Z`): 1-client cold p50/p95/p99 was 18.115/31.465/31.465 ms and warm was 4.491/8.619/9.086 ms; 4-client cold was 42.430/72.637/73.313 ms and warm was 17.025/29.995/32.100 ms. Every request succeeded, including `/api/momentum-shadow`; both profiles recorded zero outside-temp attempts, external market calls, and orders, then removed their temporary directory. These five warm rounds remain a small synthetic sample with no target threshold, SLO, or deployed-capacity claim.
- Current measured set: `/api/status`, `/api/account`, `/api/cumulative-pnl`, `/api/today-summary`, `/api/statistics`, `/api/scalping-validation`, `/api/strategy-readiness`, `/api/paper-validation`, `/api/momentum-shadow`, `/api/portfolio-analysis`, `/api/portfolio/history?period=24h`, `/api/trades?limit=12`, `/api/market/prices`, and `/api/target-coins`.
- `--fixture=representative` adds a deterministic OS-temp data profile matching the earlier projection fixture scale: 95 `.paper-forward-synthetic-*` `paper_validation.json` files with one strict close each, plus 11 `ledger.json` files with five shadow close rows each. The 11th ledger is the fixed-hold/no-DOGE readiness input; `/api/momentum-shadow` returns 10 primary books but the fenced read counts confirm it reads all 11 fixture ledgers. The self-check requires the route to report 95 sessions and verifies all 95 cohort files and all 11 book ledgers were read.
- Representative-fixture self-check (`--fixture=representative --self-check`, Node v26.8.1 arm64, generated `2026-09-29T05:04:28Z`): all 14 endpoints succeeded. The route reported 95 sessions / 10 primary books, and successful file reads covered all 95 cohort ledgers and 11 shadow ledgers (95 and 11 file reads per `/api/momentum-shadow` request). Its response was 267,162 bytes. Across three cold/warmup/warm refreshes there were 318 successful temp file reads and 351 read attempts (106 successful reads / 117 attempts per full refresh); aggregate cold/warm p95 was 34.489/12.916 ms, with event-loop-delay p95 25.231/11.084 ms. External market calls, orders, and outside-temp attempts were zero; the temp directory was removed.
- Representative-fixture small run (`--fixture=representative --profiles=1,4 --warmup-samples=2 --warm-samples=5`, Node v26.8.1 arm64, repeated run generated `2026-09-29T05:04:53Z`): at 1 client, aggregate cold p50/p95/p99 was 36.493/38.976/38.976 ms and warm was 10.932/13.463/14.047 ms; event-loop-delay p95 was 26.313/13.738 ms. At 4 clients, aggregate cold was 55.457/78.710/79.039 ms and warm was 33.693/39.921/40.632 ms; event-loop-delay p95 was 29.377/40.927 ms. `/api/momentum-shadow` response size was 267,162 bytes; route p95 was 37.328/13.199 ms cold/warm at 1 client and 78.568/38.756 ms at 4 clients. Each request successfully read all 95 cohort and 11 book ledgers; temp read successes/attempts were 848/936 at 1 client and 3,392/3,744 at 4 clients, equal to 106 successful reads / 117 attempts per full refresh. Both profiles had zero request errors, external market calls, orders, and outside-temp attempts, and both temp directories were removed. A preceding same-command run at `05:04:33Z` recorded 1-client cold p95/event-loop p95 of 159.751/134.873 ms and 4-client warm p95/event-loop p95 of 78.359/51.216 ms; the repeat varied materially. Five warm rounds remain a small, run-sensitive synthetic sample with no target threshold, SLO, or deployed-capacity claim.

## 2026-09-29 bounded research projection cache

- The read-only `/api/momentum-shadow` projection now caches its calculated snapshot for at most 1,000 ms per route instance. Responses include `projectionFetchedAt` and `projectionAgeMs`, so callers can see when the projection was calculated. This route never authorizes orders; the cache may make diagnostics up to one second old.
- Before the cache, the representative 95-session / 11-ledger fixture measured 8-client warm aggregate p95 at 89.728 ms and event-loop-delay p95 at 80.282 ms. After the cache, the same Node v26.8.1 arm64 profile measured warm p50/p95/p99 at 26.542/46.937/66.249 ms and event-loop-delay p95 at 23.921 ms. At 1/4/8 clients, successful temp-file reads totaled 106 per worker profile, rather than repeating the 95+11 ledger reads for every request; all 14 PWA core GETs succeeded, with zero out-of-temp reads, external market calls, or orders. This is one 12-wave run per profile, not an SLO or deployed-capacity proof.
- The cache freshness window has a deterministic isolated route test. The representative benchmark self-check and 1/4/8 profiles use only generated OS-temp ledgers.

## 2026-09-29 Toss-referenced mobile layout corrections

- The market chart's canvas height now follows one CSS variable: 398px on wide layouts and 300px at mobile widths. The dashboard and portfolio empty-history action stays indented under its copy while its width accounts for that offset.
- CUA captured the synthetic DRY_RUN app at CSS viewport 390×844 and 1280×720. On mobile, the market canvas and wrapper both measured 300px; the trade panel starts 17px below with no overlap. The snapshot action fit within its parent (`x=89…347`, parent `x=15…365`) with no horizontal document overflow. Desktop chart and trade panels were separated by 17px. Captures were inspected but not saved as workspace image files.
- PWA assets are JS `20260929-39`, CSS `20260929-23`, Service Worker source `v184`; `pilotRedesignRefresh` passed `97/97`, PWA verification is valid, and targeted ESLint passed. CUA at 390×844 measured the snapshot action at `44px` high, inside its parent and well above the fixed navigation; the canvas remains exactly 300px with no overlap. The page still showed a new-version banner, so activation of the new Service Worker was not verified. Physical-device, VoiceOver, and release verification remain separate.

## 2026-09-29 manual mutation safety and UI follow-up

- Manual order and virtual-wallet requests require a stable idempotency key; PWA and legacy callers persist and retry the same exact request across timeout/reload. DRY_RUN portfolio receipts recover journal state after a split-file crash window. The four single-order LIVE routes now link that record to an exchange identifier and use GET-only terminal recovery; ambiguous outcomes still fail closed without resubmission. Multi-leg LIVE plans (`execute-bundle`, `smart-buy`, `smart-sell`) journal a fresh per-leg exchange identifier before each leg's POST, and a same-key retry resolves every journaled leg by GET-only readback without recomputing the dynamic plan; a leg that never reached the exchange reports `not_dispatched`, and any unresolvable leg keeps the whole request `unknown`.
- Same-host mutable profile ownership is claimed before `DashboardServer` listens or the primary headless entry calls `trader.start()`. Read-only observers skip it, and safe shutdown releases it after protection drains. Shared/network filesystems, other legacy entrypoints, and multi-host ownership remain outside this guarantee.
- Latest focused verification: 194/194 server/UI tests, `pilotRedesignRefresh` 97/97, PWA verifier, targeted ESLint and syntax checks, diff check, plus representative 1/4/8-client synthetic capacity and visual CUA review. `docs/commercial-readiness-audit-2026-09-29.md` records evidence and gaps.
- Next: add bounded idempotency/evidence retention, and design the Hosted tenant/profile manager plus transactional store. Multi-leg LIVE plan legs are now journaled per leg and recovered by GET-only identifier readback; remaining gaps are real-exchange verification of that path, supervisor restart handoff (launchd/systemd/pm2) before calling crash recovery complete, and offline bundled data which remain fictional. The user selected both local standalone and Hosted SaaS, but Hosted LIVE scope/profile identity and local continuous automation placement remain pending.

## 2026-09-29 continuation — startup lock ordering, API caps, and Hosted isolation

- Primary runtime startup now resolves the same portfolio path as `MultiCoinTrader`, claims its profile writer lock before constructing the trader, and transfers the verified lock handle to the actual idempotency store. This makes portfolio hydration and any legacy JSON migration run while ownership is held. Constructor failure releases the lock; after lifecycle handlers install, existing unresolved-LIVE shutdown still retains it. Focused startup + writer-lock verification passed `8/8`. The proof uses temporary paths/fake traders, not an actual account profile or running primary process.
- Read-only query bounds now use one parser: `/all-coin-scores` defaults to 100 and caps at 100; `/trades` defaults to 50 and caps at 100; general and per-coin news default to 100/50 and cap at 100. Invalid, repeated, fractional, zero, and negative values use endpoint defaults. Synthetic helper and Express-route checks passed `5/5`. This does not cap accumulated-news memory or change the 100-market sequential analysis default.
- A source-only Hosted SaaS audit confirmed the current implementation still shares one `DashboardServer`, `tradingSystem`, Upbit key pair, account-derived store paths, AI/log state, and realtime broadcasts. Static role tokens do not supply tenant/account ownership. Treat multi-customer Hosted service and Hosted LIVE as P0-blocked until identity, secret custody, and per-tenant data ownership/isolation decisions and verification exist.
- Current inline CUA inspection saw the synthetic mobile Dashboard at 602×844 and desktop Market at 1280×720. The mobile empty-history action and bottom navigation fit; the desktop market chart clips right-axis price labels. The screenshots are not yet saved as audit artifacts, the wider screen/state sweep remains open, and no order was executed.
- Data modes remain incomplete: the app contains fictional `bundled-preview` samples only; public market-data bundles, manifest/hash validation, offline replay, and local dataset selection are not implemented. Dataset contents, local continuous-operation placement, and Hosted LIVE scope remain pending.
- This continuation ran only synthetic targeted tests, targeted ESLint/syntax checks, a local fake-provider benchmark, and `git diff --check`. Full suite, user account/order/ledger data, external exchange calls, device/release/deployment, physical-device accessibility, Hosted multi-tenant isolation, and supervisor restart handoff were not verified.

## 2026-09-29 continuation — profile fail-closed and UI scroll ownership

- The native app now keeps `bundled-preview` offline when its JSON resource is absent, normalizes the sample workspace to Paper, and checks server mode before private Dashboard reads. Market-detail async requests are keyed so late/cancelled reads cannot leave the wrong candle series or a stale connection error. It exposes loading/retry feedback and a readable OHLCV disclosure, but the detail screen still needs a native runtime capture and VoiceOver review.
- The earlier update-banner-in-flow fix was incomplete: a second visual review found the notice still changed the flex layout. The current update action sits inside the reserved 40px top metadata row and appears only for an actually waiting Service Worker. Inline CUA comparison showed the dashboard heading at the same height with the action hidden and visible; the saved [360×800 shell capture](audits/coinpilot-2026-09-29/pwa-update-control-360-20260929T1052Z.png) shows the status row and fixed navigation. Full bottom-scroll clearance and desktop 1280px chart axes remain unverified.
- iOS focused Store regressions passed `29/29`; PWA UI passed `103/103`; `npm run verify:pwa` is valid; targeted ESLint and `bundled-local` Xcode build passed. Synthetic fixture screenshots and local builds do not prove real dataset freshness or device distribution.
- Continue with server side tenant/profile isolation before Hosted customer access; then durable multi-process writes, LIVE multi-leg/restart recovery, data freshness/replay policy, measured capacity targets, and physical-device/accessibility/release proof.

## 2026-09-29 continuation — PWA accessibility and legacy entrypoint ownership

- Market selection rows now expose `aria-pressed`; the selected market chart exposes the latest 20 visible OHLCV values in a semantic disclosure table with a local-time note. These updates do not replace the canvas chart or fetch additional market data.
- A visual CUA click intended for the PWA update action landed on the nearby LIVE control. The source gate rejected LIVE while the synthetic server was `DRY_RUN` before changing active mode or issuing a request; the page remained in Paper. No further UI clicks were made, and this is not treated as successful update-button interaction evidence.
- `multiCoinIndex.js` now takes the same profile writer lock before constructing `MultiCoinTrader`, transfers that ownership to the dashboard/headless runtime, and releases it on constructor/dashboard/trader-start failure or clean shutdown. Temporary-path/fake-trader tests passed `5/5`; including the profile-startup suite: `9/9`. No real portfolio or account path was read.
- PWA regression tests passed `106/106`; combined startup/profile/PWA tests passed `115/115`; dashboard-startup and shutdown tests passed `19/19`. `npm run verify:pwa`, targeted ESLint, `node --check` on the changed entrypoints, and `git diff --check` passed. Updated shell assets: JS `20260929-44`, CSS `20260929-29`, Service Worker `v192`.
- Dashboard optimizer follow-up: state persistence now uses a same-directory exclusive temp file, fsync, and atomic rename; save errors propagate, and toggle/interval routes keep the previous state/scheduler and return 500 when persistence fails. The Dashboard candidate cycle records a comparison in history without overwriting active `optimal_config.json` or mutating trader parameters. Focused persistence tests passed `4/4`; combined with paper-evidence mutation guards: `8/8`. The optimizer state/history paths are still shared project-root JSON across profiles, history replacement is not atomic, and the separate `src/index.js`/CLI optimizer producers still use their existing working-directory paths and apply behavior. Resolve storage ownership and legacy producer/consumer alignment before treating optimizer persistence as production-ready.

## 2026-09-29 continuation — independent public market source and local pack path guard

- The primary and legacy mutable runtime compositions now inject an independent keyless public market source into the Dashboard. All Dashboard public market reads, including cached account valuation tickers, resolve through that source while sharing the process-local Upbit request scheduler. It remains request-driven; there is no periodic collector or cross-process rate budget.
- Focused fake source/provider/route tests: `27/27`; focused bundled-local pack tests: `7/7`. Coverage now includes Dashboard market/account-valuation reads with no `tradingSystem.upbit` client. Syntax checks, targeted ESLint, and diff checks passed. No external market calls, live account reads, trades, or whole-suite run.
- Bundled-market pack output rejects canonical paths under the repository even when reached via symlink or a missing child path. It validates before and after creating the outside parent, then writes to the re-resolved canonical destination with exclusive creation and `0600` mode. A residual concurrent ancestor-replacement race remains.
- Local installed mode still means offline snapshot viewing; freshness cutoff, authenticated source provenance, replay/backtest, and automatic execution are unresolved. Current PWA screenshot capture remains unverified this run because the in-app viewport reports zero width; Playwright screenshot permission is pending. No screenshot audit is claimed.


## 2026-09-29 latest validation — fatal LIVE order shutdown

- The current shared source routes a registered `uncaughtException` through graceful shutdown rather than immediately stopping the trader. A focused event-handler regression emits the fatal event while a LIVE order is pending, checks order reconciliation into an open position, then checks protective drain before dashboard close, writer-lock release, and exit code 1.
- `node --test test/exitHandlers.test.js` passed `16/16`. This uses an injected `EventEmitter`, fake trader/exchange state, and a stubbed exit function; it is not a real process crash, account/order, or supervisor test.
- Remaining P0: SIGKILL/OS failure, supervisor timeout/restart ownership, recovery of in-memory protective SELL intent, and exchange-side protective orders remain unverified. No live owner was restarted and no order or trading configuration was changed.

## 2026-09-29 continuation — LIVE stop policy and manual-prepare gap

- The local LIVE systemd template now sets `TimeoutStopSec=infinity`. Planned stop/restart waits until the existing graceful-shutdown path verifies flat positions and known exchange state before releasing the profile lock. `node --test test/liveSystemdUnit.test.js test/exitHandlers.test.js` passed `17/17`; full ESLint and `git diff --check` passed. `systemd-analyze` is unavailable on this macOS host; the unit has not been installed or exercised on Linux.
- `Restart=on-failure` after an unexpected process exit follows a different path from a controlled stop. The supplied LIVE environment uses manual preparation and disables trader startup; `prepareManualLiveSession()` reconciles holdings/orders and, when `DASHBOARD_LIVE_MANUAL_RISK_PROTECTION=true` (the supplied env example), arms the position-risk monitor without enabling entries: strict/recovered positions keep stop-loss, take-profit, and max-hold protection, and protective SELLs are permitted only while the monitor holds the exit flag (`manualProtectionActive` in the safety status). With the flag off, manual fills still update strategy positions without a risk timer — protection is a process-owned monitor, not an exchange-side stop order.
- The manual-protection contract keeps manual order entry open while protective exits stay automated; a protective drain on an empty book hands monitoring back to the manual session instead of stopping it. Host-level restart behavior (launchd/systemd/pm2) still needs deployment verification before calling crash recovery complete.

## 2026-09-29 continuation — zero-finding runtime dependency tree

- The read-only dependency review confirmed `node-cron` has no source or test import and root UUID usage is only the ESM named `v4()` import used for Upbit nonce generation. The unused `node-cron` dependency was removed; root `uuid` was upgraded to `14.0.2`, compatible with the declared Node `>=20` and ESM project contract.
- `npm audit --json` reports zero vulnerabilities across 226 installed dependencies. Node `20.20.2` loaded the module and generated a UUID successfully. The full suite passed Node `1,042/1,042`, mobile auto-connect `5/5`, server-address policy `20` cases, and Swift Store `32` scenarios; full ESLint and `verify:pwa` passed. The full suite ran under Node 26; the Node 20 check covered UUID module compatibility only.

## 2026-09-29 continuation — dependency and local-pack integrity

- Non-forced `npm audit fix` updated the lockfile within declared semver ranges. `npm audit --omit=dev --audit-level=high` reports no high-severity production findings; the default audit still reports two moderate findings for the same UUID bounds-check advisory through the root `uuid@9.0.1` and `node-cron@3.0.3`'s pinned `uuid@8.3.2`. No major upgrade or override was applied pending compatibility review.
- The bundled-local build now creates a SHA-256 sidecar from the exact copied JSON bytes, and the native bundle loader verifies it before JSON decoding. Missing, malformed, and mismatched digests fail closed. This detects package mismatch/corruption; it does not authenticate Upbit provenance or establish a freshness policy.
- Verification after these changes: full `npm test` passed Node `1,042/1,042`, mobile auto-connect `5/5`, server-address policy `20` cases, and Swift Store `32` scenarios; full ESLint and `verify:pwa` passed. Xcode Simulator builds passed for `server`, `bundled-local`, and `bundled-preview`; the build worker verified resource separation using synthetic local data. Physical device, real pack freshness, and release distribution remain unverified.

## 2026-09-30 continuation — bundled-local historical replay

- Added a deterministic single-market Swift replay kernel for the pinned Node scalping defaults. It uses the entire selected interval, requires 18 candles, rejects non-increasing timestamps and gaps above 1.5× interval, never fills gaps, uses next-candle-open entry proxy, applies 0.05% per-side fee and 0.10% adverse slippage, chooses stop before take-profit on an ambiguous candle, and applies the worse candle-open price when price gaps through a stop. It refuses 60-minute replay because the 30-minute max-hold rule is below that candle resolution. A runtime harness now invokes the current Node `simulateScalping` defaults and compares four scenarios with the Swift kernel, alongside literal golden regressions. This is historical OHLC simulation evidence, not live-order or exchange-fill parity.
- `bundled-local` Market detail now has an offline replay action and a result sheet with market/range provenance, equity trace, fees, and trade outcomes. Results use a versioned Application Support archive with actor-serialized atomic replacement, a five-result cap, fingerprinted dedupe, and fail-closed corruption/version/size checks. The action does not call authentication, account, order, wallet, or automation APIs; integration tests assert zero API and mutation calls.
- Focused offline replay passed `11/11`, dynamic Node/Swift parity `4/4`, persistence `8` scenarios, Store `33` scenarios, Node scalping backtest `38/38`, and native/PWA color-token parity with WCAG AA status-text contrast. Latest whole `npm test` passed Node `1,122/1,122`, mobile auto-connect `5/5`, address policy `20`, offline replay `11`, dynamic parity `4`, persistence `8`, and Store `33`. ESLint, `verify:pwa`, and `git diff --check` passed. iOS 15-target bundled-local Simulator build included the 72-candle synthetic 1/5/15/60m pack, matching SHA-256 sidecar, and no Preview file. The 60m data is viewable and blocked from replay because it cannot represent the fixed 30m max-hold.
- The replay UI has not been captured or reviewed in Simulator; screenshot permission is pending. No physical device, real Upbit data freshness/provenance, release build, live trading, or deployed capacity evidence is added. Continuous DRY_RUN and Hosted tenant isolation remain separate gates.
