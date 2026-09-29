# Production Readiness Roadmap

Coin Pilot을 상용 서비스 수준으로 끌어올리기 위한 단계별 개선 계획.

- 작성일: 2026-09-16
- 최신 상태 점검: 2026-09-29
- 태스크: `docs/tasks/H1-2026-09-16-mk-prod-readiness.md`
- 운영 맥락: 개인 자동매매 봇, 같은 LAN의 모바일에서 대시보드 접속 중

> **상태 기준:** 아래 Phase의 “현재 문제” 목록은 2026-09-16 초안 당시의 기록이다. 일부는 이후 구현되어 현재 상태와 다르다. 최신 구현·검증·미해결 사항은 [`commercial-readiness-audit-2026-09-29.md`](commercial-readiness-audit-2026-09-29.md)를 기준으로 본다.

## 2026-09-29 상태 요약

| 영역 | 상태 | 근거와 남은 범위 |
|---|---|---|
| 대시보드 API 인증 | 로컬 구현 확인 | 전체 토큰과 네이티브 읽기 전용 토큰을 분리하고 경로별 method/query allowlist를 둔다. 토큰 발급·회전, 공개 환경 TLS·reverse proxy는 운영 배포에서 확인되지 않았다. |
| 헬스·준비 상태 | 로컬 구현 확인 | `/health`는 최소 liveness, `/ready`는 trader·analysis·risk와 LIVE exchange account/order reconciliation 상태를 반환한다. 여러 프로세스의 외부 관측·알림·SLO는 별도 과제다. |
| CI·테스트·lint | 로컬 검증 통과 | 최신 `npm test`: Node 802, mobile auto-connect 5, server-address policy 15, Swift store 15 통과. ESLint, `git diff --check`, `verify:pwa` 통과. 실제 GitHub Actions 실행은 포함하지 않았다. |
| 성능·용량 | 측정 중 | 8,640-point JSON history microbenchmark: read p95 6.99ms, atomic fsync write p95 12.07ms. Synthetic `/api/momentum-shadow` fixture (95 sessions ×1 close, 11 books ×5 closes): warm p95/p99 11.30/11.96ms, cold p95 34.08ms, 275KB response, path-fenced at 120 sync file reads/request. Concurrent-user/API event-loop targets, exact live data shape, deployed latency, and SLOs remain unverified. |
| 설정 검증 | 부분 완료 | `ENV_SCHEMA`와 런타임 검증은 존재한다. 모든 스크립트의 직접 `process.env` 접근과 설정 계약은 여전히 단계적으로 단일화해야 한다. |
| 실행·데이터 구조 | 개인 단일 운영자 수준 | 거래 엔진과 대시보드 API가 같은 Node 프로세스에서 실행되고 JSON ledger/history를 사용한다. 다중 사용자·수평 확장·트랜잭션 저장소·장애 복구 서비스는 구현됐다고 볼 수 없다. |
| 네이티브 앱 데이터 경계 | 로컬 검증 통과 | Server 프로필은 synthetic fixture를 포함하지 않는다. `bundled-preview`에만 예시 데이터가 포함되고 네이티브 주문 요청은 없다. 이는 읽기 전용 화면 미리보기이며 로컬 데이터 수집/운용 엔진은 아니다. 자료별 stale/pending 시각과 자산 기록 freshness를 유지한다. |
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
- Open boundaries remain: MarketDataProvider is not an independent collector; bundled-preview is fictional; PWA/iOS provenance has no staleness threshold; physical-device and release verification are absent; local mode and deployment topology still need a user decision.
- An earlier accidental full `strategyResearchRoute` file-suite run left default owner-path reads **outcome unknown**; it was not repeated. No owner/ledger write or order was reported, and its empty temp fixture directory was removed. The synthetic local dashboard is still managed on `127.0.0.1:39471` (PID/PGID `33288`) for session-end cleanup.

## 2026-09-29 follow-up — latest UI and safety evidence

- PWA order-banner, source/fetch timestamp, and allocation behavior passed `63/63`; PWA verification and targeted ESLint passed. Assets are JS `20260929-28` / service worker `v172`. Native Store passed 16 scenarios; fictional bundled-preview built successfully and was captured on iPhone 17 Simulator.
- Upbit `trade_timestamp` means latest trade time, displayed as `최근 체결`; `fetchedAt` remains server collection time ([official ticker API](https://docs.upbit.com/kr/reference/list-quote-tickers)). Allocation avoids pie charts for one item and hides ratios when cash or holding valuation is unknown.
- Fatal shutdown remains an open P0: standalone `uncaughtException` with LIVE exposure calls stop, disabling risk monitoring, then closes the dashboard and exits without drain/reconciliation. Its standalone test covers only a flat trader. No code change was made pending the user's fatal-shutdown decision. Local operating mode and deployment topology are also unresolved; the broader goal remains active.

## 2026-09-29 latest PWA visual correction

- Preserve the prior JS `20260929-28` / SW `v172` record as history. Latest assets are JS `20260929-29`, CSS `20260929-17`, SW `v173`; focused `pilotRedesignRefresh` is `64/64` and `verify:pwa` is valid. CUA confirms the compact `KRW 1,000,000 · 100%` cash-only row without a chart/stretch and a manual-order banner that distinguishes stopped automation from available DRY_RUN manual orders. `trade_timestamp` denotes last trade time (`최근 체결 시각`); `fetchedAt` is server collection time.

## 2026-09-29 market chart-range follow-up

- PWA range options are 30/60/100 candles, default 60; it renders a copied last-N valid-candle subset for candles/axis/time labels while the API still requests 100 and the original array stays unchanged. `pilotRedesignRefresh` passed `66/66`, `verify:pwa` is valid, assets are JS `20260929-30` / CSS `20260929-18` / SW `v174`. CUA checked synthetic data at 800×600 (not 1280×720); full x-axis labels were not visible. Prior incident/process records remain intact; fatal/local/deployment decisions remain open.

## 2026-09-29 manual mutation safety and UI follow-up

- Manual order and virtual-wallet requests now require a stable idempotency key; PWA and legacy callers persist and retry the same exact request across timeout/reload. DRY_RUN portfolio receipts recover journal state after a split-file crash window. LIVE unknown outcomes fail closed without resubmission.
- Mutable `DashboardServer` startup claims a same-host writer lock before listening and releases it on orderly stop/start failure. Read-only observers skip the lock. This protects same-profile dashboard instances; dashboard-disabled automatic-only processes and multi-host file storage remain outside the guarantee.
- Focused verification: server `46/46`, PWA `89/89`, PWA verifier, targeted lint, syntax check, diff check. `docs/commercial-readiness-audit-2026-09-29.md` records scope and evidence.
- Next: define LIVE unknown-operation reconciliation and journal retention; extend single-writer ownership to automatic-only processes; design shared transactional storage before multi-host/multi-user support. Resolve local install data mode, deployment topology, and fatal-shutdown ownership before broadening those contracts.
