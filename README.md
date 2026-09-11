# Coin Pilot

업비트 거래소용 암호화폐 자동매매 시스템입니다. 기본 실행 모드는 과매도 반응 스캘핑으로, 완료된 1분봉에서 반등을 확인한 뒤 1~5초 지연 재검증을 통과한 경우에만 자동 진입합니다.

## 주요 기능

- 유동성 상위 KRW 마켓 중심의 과매도 반응 스캘핑
- 완료 캔들 RSI 과매도 → 양봉 반등 → RSI 회복 확인
- 반등 확인 후 1~5초 지연 및 ticker/캔들 재검증
- 진입 직전 최신 캔들 시각 freshness 확인 (오래된 응답은 fail-closed)
- 자동 손절, 익절, 최대 보유시간, 포지션 수 제한
- 기존 종합점수 전략의 선택적 호환
- 백테스팅 엔진 (수수료, 슬리피지 시뮬레이션 포함)
- 실시간 웹 대시보드
- 모의투자 / 실전투자 모드 지원

## 설치

```bash
git clone https://github.com/godekd3133/Coin-Pilot.git
cd Coin-Pilot
npm install
```

## 설정

```bash
cp .env.example .env
```

`.env` 파일을 열어서 업비트 API 키를 입력합니다:

```env
UPBIT_ACCESS_KEY=your_access_key
UPBIT_SECRET_KEY=your_secret_key
DRY_RUN=true
TARGET_COINS=ALL
```

`TARGET_COINS=ALL`인 스캘핑 모드에서는 모든 마켓을 매초 조회하지 않고, 시작 시 24시간 거래대금 상위 `SCALP_MAX_MARKETS`개만 선택합니다. 실전 주문은 기본값이 아니며, 충분한 모의투자 검증 후 별도로 활성화해야 합니다.

시장 분석 클라이언트와 독립 포지션 리스크 클라이언트는 같은 프로세스-wide 요청 슬롯을 공유합니다. 따라서 리스크 확인을 빠르게 유지하면서도 두 클라이언트가 각자 Upbit 요청 한도를 초과하지 않도록 합니다.

스캘핑 RSI는 레거시 전략의 전역 `RSI_*`와 분리할 수 있습니다. `SCALP_RSI_PERIOD`, `SCALP_RSI_OVERSOLD`, `SCALP_RSI_OVERBOUGHT`를 지정하면 스캘핑과 기존 전략이 서로 다른 RSI 튜닝값을 섞지 않습니다. 미지정 시 기존 `RSI_*` 값으로 fallback하며, 실제 사용값은 forward `configSnapshot`에 기록됩니다.

네트워크 timeout과 별도로 진입 직전 캔들의 시각도 확인합니다. `SCALP_MAX_CANDLE_AGE_SECONDS=0`이면 분봉 단위에 맞춰 자동으로 계산하며, 1분봉 기본값은 90초입니다. 최신 캔들 timestamp가 없거나 허용 나이를 넘으면 strict 진입과 shadow 후보를 모두 차단하고 telemetry에 사유를 기록합니다. telemetry는 초기 `analysis` 차단과 지연 후 `entry_confirmation` 차단을 따로 세고, age의 최소·평균·최대와 마지막 timestamp를 함께 보존합니다. 캔들 개수가 최소 분석량보다 적은 마켓은 stale과 별도의 데이터 품질 항목으로 마켓별 횟수·수신 개수·필요 개수를 기록합니다. freshness 관측은 마켓별 전체 표본·유효 표본·stale 비율·age 통계도 함께 보존해 특정 마켓 격리 후보를 검토할 수 있게 합니다. 캔들 부족 telemetry도 stale과 분리해 보존하므로, 마켓 제외 판단을 데이터 지연과 데이터 부족으로 혼동하지 않습니다. 이 값은 실행 계약에 포함되므로 forward `configSnapshot`과 fixed validation 설정이 일치해야 하며, 오래된 세션에 조용히 섞이지 않습니다.

특정 마켓이나 후보 로직만 연구할 때는 `SCALP_VALIDATION_MARKETS`와 `SCALP_VALIDATION_OUTPUT_FILE`을 함께 지정해 기본 승격 리포트를 덮어쓰지 않도록 합니다. 검증 grid는 lookback 1/3과 직전 고가 돌파 필터 true/false를 모두 비교하지만, 런타임 기본값은 여전히 엄격한 조건을 유지합니다.

현재 실행 중인 설정 자체의 성과를 확인하려면 `npm run validate:scalping:fixed`를 사용합니다. 이 모드에서는 학습 구간에서 grid 튜닝을 하지 않고 현재 `SCALP_*`/`RSI_*` 설정을 그대로 training/holdout에 적용합니다. 기본 `npm run validate:scalping`은 tuned holdout 탐색용이며, 두 결과는 서로 다른 질문에 답합니다. live gate에는 fixed 명령으로 생성한 `scalping_validation.json`만 사용할 수 있습니다.

`SCALP_REQUIRE_VALIDATION_PASS=true`가 기본값이므로, 스캘핑 모드에서 `DRY_RUN=false`로 시작하려면 선택된 모든 검증 마켓이 워크포워드 게이트를 통과한 `scalping_validation.json`이 필요합니다. 검증 결과가 0/3이면 실전 자동매매 시작 자체가 중단됩니다. 홀드아웃은 학습 구간의 마지막 지표 워밍업을 사용하지만 워밍업 구간에서는 거래하지 않습니다.

급격한 한 봉 변동으로 손절되는 후보를 분석하기 위해 `SCALP_MAX_SIGNAL_RANGE_PERCENT` 변동폭 상한도 제공합니다. 기본값 `0`은 비활성화이며, 양수로 바꿀 때는 반드시 별도 historical holdout과 forward shadow에서 먼저 검증합니다. 이 값을 즉시 완화하거나 조이는 것은 수익성 개선을 의미하지 않습니다.

반대로 너무 조용한 반등을 제외하는 `SCALP_MIN_SIGNAL_RANGE_PERCENT` 하한도 제공합니다. 기본값 `0`은 비활성화이며, 신호 캔들의 고가-저가 범위가 하한보다 작으면 `signal_range_too_narrow`로 거절합니다. 상한과 마찬가지로 별도 holdout/forward 검증 전에는 켜지지 않습니다.

여러 마켓이 동시에 약세인 구간의 반등 진입을 제한하는 portfolio regime gate도 별도 후보로 제공합니다. `SCALP_MARKET_REGIME_ENABLED=false`가 기본값이며, 활성화하면 최근 lookback 봉의 상승 마켓 비율(breadth)과 평균 수익률을 함께 확인합니다. 이는 현재 설정을 자동으로 완화하는 기능이 아니며, 다중 마켓 동일 윈도우 holdout에서 검증된 경우에만 후보로 취급합니다.

수익이 난 뒤 되돌림을 줄이는 보호 출구 후보로 `SCALP_BREAK_EVEN_TRIGGER_PERCENT`/`SCALP_BREAK_EVEN_OFFSET_PERCENT`와 `SCALP_TRAILING_ACTIVATION_PERCENT`/`SCALP_TRAILING_STOP_PERCENT`를 제공합니다. 활성화 기준값은 기본 `0`이라 기존 고정 손절·익절 계약을 유지하며, 해당 값은 독립 holdout과 forward shadow에서 검증되기 전까지 자동으로 켜지지 않습니다.

여러 마켓에서 손실이 연속될 때 신규 진입을 전역으로 잠그는 선택형 회로차단기도 제공합니다. `SCALP_LOSS_CIRCUIT_BREAKER_COUNT=0`이 기본값이라 기존 동작을 바꾸지 않습니다. 양수로 설정하면 지정한 시간창 안에 N회 손실이 발생한 뒤 strict 자동진입과 shadow 진입을 각각 차단하고, 해당 상태를 forward ledger에 저장합니다. 이 보호장치는 수익성 증명이 아니므로 별도 holdout과 forward 결과를 확인하기 전에는 활성화하지 않습니다.

손실 중인 포지션만 일정 시간 뒤 먼저 닫는 `SCALP_MAX_LOSING_HOLD_MINUTES` 후보도 제공합니다. `0`이 기본값이며, 이익 중인 포지션은 기존 max-hold까지 유지합니다. 1분봉 노이즈와 회복 시간을 분리해 검증하기 위한 risk 후보이고, 양수 설정은 multi-fold holdout과 forward paper에서 모두 확인하기 전에는 적용하지 않습니다.

여러 마켓이 같은 완료 캔들에서 동시에 반등할 때 상관된 진입이 한꺼번에 쌓이는 것을 분석하기 위해 `SCALP_MAX_ENTRIES_PER_SIGNAL_WINDOW` 후보도 제공합니다. `0`이 기본값이며, 양수로 설정하면 같은 signal key를 공유하는 strict 진입 수를 전역으로 제한합니다. v30에서 동일 signal window에 3개 strict 진입이 발생한 관찰을 근거로 만든 보완장치지만, 현재는 비활성 상태이고 portfolio holdout과 forward paper에서 별도 검증해야 합니다.

워크포워드 튜닝은 holdout만 보지 않습니다. 학습 구간에서도 기본적으로 최소 3회 거래, PF 1 이상, 수익률 0% 이상을 요구합니다. 학습부터 무너진 후보는 `training_gate_failed`로 기록되며, 거래 수가 많다는 이유로 우선순위를 얻지 않습니다. 이 기준은 탐색 후보를 줄이는 안전장치이며 실제 수익을 보장하지 않습니다.

API 키는 [업비트 Open API 관리](https://upbit.com/mypage/open_api_management)에서 발급받을 수 있습니다.

## 실행

```bash
# 전체 시스템 실행 (스캘핑 자동매매 + 대시보드)
npm start

# 개별 실행
npm run dashboard    # 대시보드만
npm run dashboard:staging # 실제 entrypoint 기반 격리 DRY_RUN staging 대시보드
npm run backtest     # 백테스팅만
npm run optimize     # 기존 종합점수 전략 최적화 (스캘핑 기본 모드에서는 사용하지 않음)
npm run validate:scalping # 읽기 전용 7일 워크포워드 수익성 검증
npm run validate:scalping:fixed # 현재 runtime 설정을 고정한 live-gate용 검증
npm run validate:scalping:portfolio # 공유 KRW/포지션 제한을 반영한 별도 진단 검증 (live 승격 불가)
npm run validate:shadow    # relaxed shadow 후보의 진단용 holdout 검증 (실전 승격 불가)
npm run compare:scalping   # 동일 캔들 윈도우에서 여러 스캘핑 후보를 공정 비교 (진단 전용)
npm run paper:smoke       # 기존 포트폴리오와 분리된 짧은 DRY_RUN forward smoke
npm run paper:forward     # .paper-forward에 격리된 장기 DRY_RUN forward 세션
```

대시보드는 http://localhost:3000 에서 확인할 수 있습니다.

프론트엔드/API smoke가 필요할 때는 `npm run dashboard:staging`을 사용하세요. 이 명령은 `DRY_RUN=true`를 강제하고 `.staging-runtime/<timestamp>/` 아래에 별도 `dry_portfolio.json`과 paper ledger를 생성하므로 사용자의 root `dry_portfolio.json`을 읽거나 수정하지 않습니다. 기본 staging 포트는 `3100`이며 `STAGING_PORT`와 `STAGING_TARGET_COINS`로 바꿀 수 있습니다. 실제 주문·수익성·wallet settlement 증거가 아닙니다.

대시보드는 PWA로도 동작합니다. 모바일 브라우저의 “홈 화면에 추가” 또는 데스크톱 브라우저의 “앱 설치”를 사용하면 standalone 설치앱으로 열 수 있습니다. 설치앱에서도 계좌·시세·거래 데이터는 서버 API를 기준으로 읽으며, 오프라인 캐시는 화면 껍데기만 제공하고 오래된 거래 상태를 표시하지 않습니다.

### AI Desk: 구독 기반 읽기 전용 자문

대시보드의 `AI Desk` 탭에서 GPT/Codex와 Claude 로컬 CLI의 로그인 세션을 연결 상태로 확인하고, 매수 신호·매도 신호·반등 후보·속보·리밸런싱 제안·체결 이벤트를 장기 모니터링할 수 있습니다. 모니터링 session은 `ai_monitoring_sessions.json`에 저장되므로 프로세스가 재시작되어도 session, 이벤트, 자문 이력이 남습니다.

AI 자문은 다음 경계를 지킵니다.

- GPT는 `codex` CLI, Claude는 `claude` CLI를 사용하며 앱에 provider API key를 저장하지 않습니다.
- AI 응답은 `BUY`/`SELL`/`HOLD`/`WAIT` 의견과 근거·위험·무효화 조건으로만 기록됩니다.
- AI 의견은 주문으로 자동 변환되지 않습니다. 설정값 기반 기존 `executeOrder()` 자동 매수·매도 경로는 그대로 독립 실행됩니다.
- session 생성 시 이벤트 종류, 코인 필터, 동일 이벤트 재자문 간격, 자동 자문 여부, 결과 평가 시점(기본 5분)을 정할 수 있습니다. 비용과 호출량을 관리하기 위해 기본 cooldown은 300초입니다.
- 실제 provider 응답은 기준 이벤트 가격과 평가 시점 이후 처음 관측된 같은 코인 가격에 자동 대조됩니다. `BUY`/`SELL`은 중립 구간(기본 ±0.1%)을 제외하고 `HIT`/`MISS`/`FLAT`으로, `HOLD`/`WAIT`는 `CALM`/`ABSTAINED`로 별도 집계합니다. local brief·실패 응답·신선하지 않은 snapshot·가격이 없는 이벤트는 provider 적중률에 섞지 않습니다.
- 실제 응답이 한 provider뿐이면 `singleProvider`로 제한 표시하고 consensus 표본으로 세지 않습니다. 두 provider 이상이 같은 방향으로 응답한 경우에만 `quorum=true`인 consensus를 별도로 평가합니다.
- 대시보드와 `GET /api/ai/effectiveness`에서 실제 응답률, provider별 지연·평가 표본·적중률, 평가 대기 건수를 확인할 수 있습니다. 최소 20개 평가 표본 전에는 `sufficientEvidence=false`로 표시되며, 이 지표도 주문 승인이나 수익성 보장을 의미하지 않습니다.

로컬 CLI가 먼저 로그인되어 있어야 합니다. ChatGPT 구독과 OpenAI API 사용은 별도 결제 체계이므로, ChatGPT 구독을 API key로 오인해 앱에 넣지 않습니다. [OpenAI 공식 billing 안내](https://help.openai.com/en/articles/9039756)를 확인하고, 현재 provider 로그인 상태는 AI Desk의 연결 상태 카드에서 다시 확인하세요.

주요 API는 다음과 같습니다.

```text
GET  /api/ai/providers
GET  /api/ai/monitoring?limit=40
GET  /api/ai/effectiveness
GET  /api/ai/sessions
POST /api/ai/sessions
POST /api/ai/sessions/:id/pause
POST /api/ai/sessions/:id/resume
POST /api/ai/sessions/:id/stop
POST /api/ai/consult
```

Forward paper 세션은 기존 `dry_portfolio.json`과 별도인 `paper_validation.json`에 기록됩니다.

```text
GET  /api/paper-validation
POST /api/paper-validation/start   # 현재 상태를 기준으로 시작
POST /api/paper-validation/stop
```

깨끗한 시작 자금으로 새 세션을 만들려면 `POST /api/paper-validation/start`에 `{"reset":true,"seedMoney":10000000}`를 명시적으로 보내야 합니다. 자동으로 기존 모의 포트폴리오를 초기화하지 않습니다.

세션을 중지할 때 strict 포지션이 남아 있으면 ledger에 `endedWithOpenPositions`와 `stopReason`을 기록합니다. 이후 같은 ledger에서 새 세션을 시작하려면 새 시드 reset 또는 명시적인 `allowUnsettledResume=true`가 필요합니다. 미청산 상태를 조용히 새 기준선에 섞지 않기 위한 연속성 보호입니다.

격리 smoke가 필요하면 `npm run paper:smoke`를 사용합니다. 기본 60초 동안 `PAPER_SMOKE_MARKETS`를 읽기 전용으로 분석하고 `.paper-smoke/` 아래에 가상 포트폴리오와 paper ledger를 저장합니다. 기존 `dry_portfolio.json`은 읽거나 수정하지 않습니다. 이 smoke는 연결·상태 저장 검증용이며, 7일 수익성 승격 증거로 사용하지 않습니다.

실제 DRY_RUN 분석 이벤트를 AI 자문과 함께 관찰하려면 다음처럼 선택형 paper AI monitoring을 켤 수 있습니다. 이 모드는 별도 `ai_monitoring_sessions.json`에 provider 응답과 미래 가격 평가를 저장하며, AI 의견을 주문에 연결하지 않습니다. provider 호출 비용과 지연을 의도적으로 발생시키므로 기본값은 꺼져 있습니다.

```bash
PAPER_AI_MONITORING=true \
PAPER_AI_PROVIDERS=gpt \
PAPER_AI_EVENTS=BUY_SIGNAL,SELL_SIGNAL \
PAPER_SMOKE_SECONDS=600 \
PAPER_SMOKE_OUTPUT_DIR=/tmp/coinpilot-ai-paper-smoke \
npm run paper:smoke
```

종료 시 출력되는 `aiMonitoring.effectiveness`와 별도 원장의 `GET /api/ai/effectiveness`가 실제 응답률·지연·평가 표본을 보여줍니다. 실제 매매 효용을 주장하려면 stale/가격 없는 이벤트를 제외한 평가 표본이 최소 20개 쌓여야 하며, 짧은 smoke나 synthetic fixture는 연결성 증거일 뿐입니다.

장기 forward paper는 `npm run paper:forward`로 실행합니다. 첫 실행은 `.paper-forward/`에 새 시드로 시작하고, 이후 같은 폴더로 재실행하면 기존 활성 세션을 이어갑니다. 프로세스가 비정상 종료되어 heartbeat가 오래된 경우에도 forward 모드는 기존 ledger를 새로 만들지 않고 같은 세션을 복구하지만, 기록된 공백이 `SCALP_PAPER_MAX_HEARTBEAT_GAP_MINUTES`를 넘으면 승격 자격은 자동 보류됩니다. 의도적인 `Ctrl+C` 종료 후에는 새 세션으로 다시 시작하며, 실전 주문은 호출하지 않습니다. 이 세션이 최소 7일·20회 청산·수익률·MDD·연속 관찰 게이트를 모두 통과해야 forward paper 승격 후보가 됩니다. strict 진입과 별도로 soft 후보는 shadow 장부에만 기록되어 완화 후보의 참고 손익/PF를 관찰합니다.

Forward 상태의 `lossCircuitBreaker`는 현재 손실 횟수, 차단 여부, 남은 차단 시간과 설정값을 보여줍니다. 회로차단기가 진입을 막은 횟수는 telemetry에 별도로 기록되며, strict 실현손익이나 live 승격 조건을 우회하지 않습니다.

새 forward 세션은 strategy mode, 시장 목록, RSI/반등/거래량/추세/변동폭 필터, 손절·익절·보유시간, 수수료·슬리피지, 투자비율과 포지션 제한을 `configSnapshot`으로 함께 저장합니다. 이후 재실행 시 설정이 달라지면 기존 세션에 조용히 섞지 않고 drift로 표시하며 승격을 보류합니다. snapshot이 없는 구버전 ledger는 복구할 수 있지만 전체 구간 재현성이 확인되지 않은 상태로 취급합니다.

장기 실행 로그는 기본적으로 compact 모드이며 60초마다 cycle·strict BUY·shadow·거래 수·자산만 출력합니다. 상세 cycle 로그가 필요하면 `PAPER_FORWARD_VERBOSE=true npm run paper:forward`를 사용합니다.

이전 forward 원장에서 데이터 품질이 좋은 시장만 별도 코호트로 재현하려면 `PAPER_SMOKE_MARKETS=FRESH_FROM_LEDGER PAPER_SMOKE_FRESHNESS_LEDGER=.paper-forward-v44/paper_validation.json npm run paper:forward`처럼 실행할 수 있습니다. 기본 최소 관측 수는 100회, freshness 차단률 상한은 5%이며 `PAPER_SMOKE_MIN_FRESHNESS_OBSERVATIONS`, `PAPER_SMOKE_MAX_STALE_RATE`, `PAPER_SMOKE_MAX_MARKETS`로 실험 범위를 지정합니다. 표본 부족·차단률 초과 시장은 fail-closed로 제외하고, 선택된 시장의 원래 순서는 유지합니다. 이는 이전 ledger 기반의 진단 코호트 선택일 뿐 기본 전략·실거래 universe·live gate를 바꾸지 않습니다.

후보 비교 study는 `SCALP_VARIANT_MARKETS`, `SCALP_VARIANT_NAMES`, `SCALP_VARIANT_CANDLE_COUNT`, `SCALP_VARIANT_CANDLES_FILE`, `SCALP_VARIANT_OUTPUT_FILE`을 선택적으로 지정할 수 있습니다. `SCALP_VARIANT_CANDLES_FILE`에 `{ "KRW-BTC": [...] }` 형태의 candle cache를 주면 네트워크 재수집 없이 동일한 윈도우를 재사용할 수 있어 후보 간 시간창 drift를 막습니다. 시장별 캔들을 한 번만 수집해 같은 윈도우에서 비교하지만, 결과는 승격 리포트가 아니며 실전 설정을 바꾸지 않습니다.

relaxed shadow 후보 검증도 `SHADOW_VALIDATION_CANDLES_FILE`을 지정하면 동일한 `{ "KRW-BTC": [...] }` candle cache를 재사용합니다. `SHADOW_VALIDATION_MARKET`으로 cache 안의 시장을 선택하고, 리포트에는 `candleSource=cache`를 기록합니다. 이 검증은 strict 계약을 완화한 진단 코호트일 뿐이며 실전 승격을 허용하지 않습니다.

`npm run validate:scalping:portfolio`는 여러 마켓을 하나의 시간축으로 맞춰 공유 KRW 잔액, `SCALP_MAX_POSITIONS`, 동시 신호 우선순위를 반영합니다. 마켓별 독립 백테스트와 실제 포트폴리오 실행의 차이를 확인하기 위한 진단 레인이며, 이 결과는 `scalping_validation.json` live gate를 대체하지 않습니다. 기본은 현재 설정 고정이고, `SCALP_PORTFOLIO_VALIDATION_TUNED=true`일 때만 소형 후보 grid를 학습 구간에 적용합니다. `SCALP_PORTFOLIO_VALIDATION_FOLDS=3`을 지정하면 expanding multi-fold로 각 미래 구간을 따로 확인하며, 모든 fold가 통과해야 진단상 통과로 표시됩니다. `SCALP_PORTFOLIO_CANDLES_FILE=/tmp/...json`을 지정하면 동일 원시 캔들창을 재사용할 수 있습니다.

portfolio 진단에서만 `requireNextCandleBullish` 후보도 비교할 수 있습니다. 이는 신호 다음 봉이 실제로 양봉으로 마감된 뒤 그 종가에 진입하는 계약이어서 기존 1~5초 지연 진입과 다릅니다. `SCALP_PORTFOLIO_REQUIRE_NEXT_CANDLE_BULLISH=true`는 별도 연구용이며, 현재 runtime이나 live gate에 자동 반영되지 않습니다.

## 환경 변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `DRY_RUN` | true | 모의투자 모드 |
| `DRY_RUN_SEED_MONEY` | 10000000 | 시드머니 (원) |
| `UPBIT_REQUEST_TIMEOUT_MS` | 10000 | Upbit HTTP 요청 최대 대기 시간(ms). 응답이 없으면 해당 요청만 실패 처리 |
| `SCALP_RSI_PERIOD` | `RSI_PERIOD` 또는 14 | 스캘핑 전용 RSI 기간 |
| `SCALP_RSI_OVERSOLD` | `RSI_OVERSOLD` 또는 30 | 스캘핑 전용 RSI 과매도 기준 |
| `SCALP_RSI_OVERBOUGHT` | `RSI_OVERBOUGHT` 또는 70 | 스캘핑 전용 RSI 과매수 기준 |
| `SCALP_MAX_CANDLE_AGE_SECONDS` | 0 (1분봉 90초 adaptive) | 진입 시 허용하는 최신 캔들 timestamp 최대 나이; 0은 분봉 단위 기반 자동 계산 |
| `TARGET_COINS` | ALL | 타겟 코인 (쉼표 구분 또는 ALL) |
| `SCALP_MAX_POSITIONS` | 3 | 스캘핑 최대 동시 포지션 수 |
| `SCALP_INVESTMENT_RATIO` | 0.02 | 1회 진입 총자산 비율 |
| `SCALP_STOP_LOSS_PERCENT` | 1.2 | 스캘핑 손절률 (%) |
| `SCALP_TAKE_PROFIT_PERCENT` | 1.8 | 스캘핑 익절률 (%) |
| `SCALP_MIN_VOLUME_RATIO` | 0.8 | 반등 캔들 최소 거래량 배수 |
| `SCALP_MIN_CLOSE_STRENGTH` | 0.55 | 캔들 고가권 종가 강도 |
| `SCALP_MIN_TREND_SLOPE_PERCENT` | -0.2 | 강한 하락 추세 진입 하한 |
| `SCALP_MAX_SIGNAL_RANGE_PERCENT` | 0 (disabled) | 신호 캔들 고가-저가 범위 상한 (%) |
| `SCALP_MIN_SIGNAL_RANGE_PERCENT` | 0 (disabled) | 조용한 반등 신호를 제외하는 고가-저가 범위 하한 (%) |
| `SCALP_MARKET_REGIME_ENABLED` | false | 전체 마켓 breadth/평균 방향성 gate 사용 여부 (검증 전 비활성) |
| `SCALP_MARKET_REGIME_LOOKBACK` | 5 | 시장 방향성을 비교할 완료 캔들 간격 |
| `SCALP_MARKET_REGIME_MIN_BREADTH` | 0.5 | lookback 수익률 기준을 충족해야 하는 마켓 비율 |
| `SCALP_MARKET_REGIME_MIN_RETURN_PERCENT` | -0.2 | breadth에 포함할 마켓의 lookback 수익률 하한 (%) |
| `SCALP_SIGNAL_PROFILE` | `rsi_rebound` | `rsi_rebound`, `bb_reclaim`, `trend_rebound`, `momentum_breakout` 후보 로직 |
| `SCALP_OVERSOLD_LOOKBACK` | 1 | 최근 완료 봉 중 RSI 과매도 상태를 찾는 최대 범위; 3은 별도 홀드아웃 검증 후보 |
| `SCALP_ENTRY_DELAY_MIN_MS` | 1000 | 최소 지연 시간 (ms) |
| `SCALP_ENTRY_DELAY_MAX_MS` | 5000 | 최대 지연 시간 (ms) |
| `SCALP_MAX_ENTRY_RETRACE_PERCENT` | 0.25 | 지연 중 허용되는 반등 되밀림 (%) |
| `SCALP_MAX_ENTRY_CHASE_PERCENT` | 0.35 | 지연 중 허용되는 반등 추격 상승폭 (%) |
| `SCALP_BREAK_EVEN_TRIGGER_PERCENT` | 0 (disabled) | 이익이 이 값에 도달하면 진입가 보호 출구를 활성화 (%) |
| `SCALP_BREAK_EVEN_OFFSET_PERCENT` | 0.05 | 수수료·슬리피지 보정 손익분기점 위 보호 출구 여유폭 (%) |
| `SCALP_TRAILING_ACTIVATION_PERCENT` | 0 (disabled) | trailing 보호 출구를 활성화하는 수익률 (%) |
| `SCALP_TRAILING_STOP_PERCENT` | 0 (disabled) | 최고가 대비 trailing 출구 간격 (%) |
| `SCALP_MAX_HOLD_MINUTES` | 30 | 최대 보유 시간 |
| `SCALP_MAX_LOSING_HOLD_MINUTES` | 0 (disabled) | 손실 중인 포지션만 먼저 청산하는 시간 제한(분) |
| `SCALP_MAX_ENTRIES_PER_SIGNAL_WINDOW` | 0 (disabled) | 같은 완료 캔들 signal window에서 허용할 strict 동시 진입 수 |
| `SCALP_RISK_CHECK_INTERVAL_MS` | 1000 | 열린 포지션의 손절·익절·최대보유시간 독립 확인 주기(ms) |
| `SCALP_MAX_RISK_DATA_GAP_SECONDS` | 30 | 열린 포지션 ticker 확인이 끊겼을 때 fail-closed로 중지할 최대 공백(초) |
| `SCALP_COOLDOWN_AFTER_LOSS_MINUTES` | 15 | 손실 후 재진입 대기 시간 |
| `SCALP_MAX_CONSECUTIVE_LOSSES` | 3 | 연속 손실 후 장시간 진입 잠금 |
| `SCALP_LOSS_CIRCUIT_BREAKER_COUNT` | 0 (disabled) | 전역 차단을 발동할 최근 손실 횟수 |
| `SCALP_LOSS_CIRCUIT_BREAKER_WINDOW_MINUTES` | 30 | 전역 손실 횟수를 계산할 시간창(분) |
| `SCALP_LOSS_CIRCUIT_BREAKER_COOLDOWN_MINUTES` | 60 | 전역 차단 발동 뒤 신규 진입 차단 시간(분) |
| `SCALP_PAPER_MIN_DAYS` | 7 | forward 모의투자 최소 기간 |
| `SCALP_PAPER_MIN_TRADES` | 20 | forward 모의투자 최소 청산 거래 수 |
| `SCALP_PAPER_MIN_RETURN_PERCENT` | 0.2 | forward 모의투자 최소 수익률 |
| `SCALP_PAPER_MAX_DRAWDOWN_PERCENT` | 15 | forward 모의투자 최대 낙폭 |
| `SCALP_PAPER_MAX_HEARTBEAT_GAP_MINUTES` | 15 | 연속 관찰로 인정할 수 있는 최대 heartbeat 공백; 초과 시 승격 보류 |
| `SCALP_PAPER_MIN_STORAGE_MIB` | 1024 | forward ledger 시작/재개에 필요한 최소 여유 저장공간(MiB) |
| `PAPER_SMOKE_MARKETS` | 미설정 | `FRESH_FROM_LEDGER`를 지정하면 이전 paper 원장 freshness 코호트 선택; 그 외에는 명시 시장 목록 또는 `ALL` |
| `PAPER_SMOKE_FRESHNESS_LEDGER` | 미설정 | freshness 코호트 기준으로 읽을 이전 격리 paper ledger 경로 |
| `PAPER_SMOKE_MIN_FRESHNESS_OBSERVATIONS` | 100 | 코호트 선택에 필요한 시장별 최소 freshness 관측 수 |
| `PAPER_SMOKE_MAX_STALE_RATE` | 0.05 | 코호트 선택에서 허용하는 freshness 차단률 상한(0~1) |
| `SCALP_VALIDATION_MIN_TRAINING_TRADES` | 3 | 학습 구간 최소 거래 수 |
| `SCALP_VALIDATION_MIN_TRAINING_PROFIT_FACTOR` | 1 | 학습 구간 최소 profit factor |
| `SCALP_VALIDATION_MIN_TRAINING_RETURN_PERCENT` | 0 | 학습 구간 최소 수익률 (%) |
| `AI_ADVISOR_ENABLED` | true | 구독 CLI 기반 읽기 전용 AI 자문 활성화 여부 |
| `AI_ADVISOR_TIMEOUT_MS` | 30000 | provider 한 곳의 자문 응답 최대 대기 시간(ms); 구독 CLI의 초기화 지연 변동을 포함 |
| `AI_CODEX_IGNORE_USER_CONFIG` | true | 사용자 Codex 설정 파싱 오류가 있어도 앱의 격리 실행 경로를 시도할지 여부 |
| `AI_MONITORING_FILE` | `ai_monitoring_sessions.json` | 장기 모니터링 session/이벤트/자문 이력 파일 |
| `AI_CODEX_BIN` | `codex` | GPT/Codex CLI 실행 파일 경로 |
| `AI_CLAUDE_BIN` | `claude` | Claude CLI 실행 파일 경로 |
| `AI_GPT_MODEL` | CLI 기본값 | GPT 자문에 사용할 선택적 모델 override |
| `AI_CLAUDE_MODEL` | CLI 기본값 | Claude 자문에 사용할 선택적 모델 override |
| `AI_EVALUATION_MINUTES` | 5 | 실제 provider 자문과 미래 가격을 대조할 기준 시간(분) |
| `AI_EVALUATION_NEUTRAL_BAND_PERCENT` | 0.1 | 방향 적중/실패에서 제외할 중립 가격 변동 폭(%) |
| `AI_EVALUATION_MIN_SAMPLES` | 20 | AI 실효성을 충분한 표본으로 표시하기 위한 최소 평가 수 |
| `PAPER_AI_MONITORING` | false | paper smoke에 AI monitoring session을 명시적으로 연결 |
| `PAPER_AI_PROVIDERS` | gpt | paper AI monitoring에 사용할 provider 목록 |
| `PAPER_AI_EVENTS` | `BUY_SIGNAL,SELL_SIGNAL` | paper AI monitoring 대상 event 목록 |
| `PAPER_AI_EVALUATION_MINUTES` | 5 | paper AI monitoring의 미래 가격 평가 시점(분) |
| `PAPER_AI_STOP_WAIT_MS` | 35000 | smoke 종료 시 진행 중 provider 호출을 기다리는 최대 시간(ms) |
| `PAPER_AI_MONITORING_FILE` | output dir 아래 | paper AI monitoring 원장 경로 override |
| `RSI_PERIOD` | 14 | RSI 기간 |
| `RSI_OVERSOLD` | 30 | RSI 과매도 기준 |
| `RSI_OVERBOUGHT` | 70 | RSI 과매수 기준 |
| `BUY_THRESHOLD` | 55 | 매수 신호 임계값 |
| `SELL_THRESHOLD` | 55 | 매도 신호 임계값 |

## 프로젝트 구조

```
src/
├── index.js                 # 메인 엔트리
├── api/
│   ├── upbit.js             # 업비트 API 클라이언트
│   ├── dashboardServer.js   # Express + Socket.io 서버
│   └── routes/              # API 라우트
├── analysis/
│   ├── technicalIndicators.js  # 기술적 분석
│   └── newsMonitor.js          # 뉴스 감성 분석
├── strategy/
│   ├── tradingStrategy.js   # 기존 종합점수 전략
│   └── oversoldReactionStrategy.js # 과매도 반응 스캘핑 전략
├── trader/
│   ├── autoTrader.js        # 단일 코인 트레이더
│   └── multiCoinTrader.js   # 멀티코인 트레이더
├── ai/
│   ├── aiAdvisorService.js   # 구독 CLI 읽기 전용 자문 어댑터
│   └── monitoringSessionService.js # 장기 session/이벤트/자문 이력
├── backtest/
│   └── backtestEngine.js    # 백테스팅 엔진
└── optimization/
    └── parameterOptimizer.js # 유전자 알고리즘 최적화
```

## 거래 수수료

모든 거래에 0.05% 수수료가 적용됩니다. 리밸런싱의 경우 매도 + 매수로 왕복 0.1%가 발생합니다.

## 주의사항

- 실전 투자 전 최소 1주일 이상 모의투자로 테스트하세요
- 스캘핑 모드에서는 기존 종합점수 전략용 유전 최적화/정기 백테스트 루프를 실행하지 않습니다. 스캘핑 전략은 동일한 1분봉·수수료·슬리피지를 반영한 별도 검증이 필요합니다
- API 키 발급 시 출금 권한은 제외하세요
- 투자 가능한 금액만 사용하세요

## 면책 조항

이 소프트웨어는 교육 및 연구 목적으로 제공됩니다. 암호화폐 거래는 높은 위험을 수반하며, 투자 손실이 발생할 수 있습니다. 투자 결정은 전적으로 사용자의 책임이며, 개발자는 어떠한 손실에 대해서도 책임지지 않습니다.

## 라이선스

비상업적 용도로만 사용 가능합니다. 자세한 내용은 LICENSE 파일을 확인하세요.
