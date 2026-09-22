# Production Readiness Roadmap

Coin Pilot을 상용 서비스 수준으로 끌어올리기 위한 단계별 개선 계획.

- 작성일: 2026-09-16
- 태스크: `docs/tasks/H1-2026-09-16-mk-prod-readiness.md`
- 운영 맥락: 개인 자동매매 봇, 같은 LAN의 모바일에서 대시보드 접속 중

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
