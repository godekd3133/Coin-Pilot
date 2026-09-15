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
- 1분 과매도 전략과 분리된 higher-timeframe momentum 연구 lane
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

시장 분석 클라이언트와 독립 포지션 리스크 클라이언트는 같은 프로세스-wide 요청 슬롯을 공유합니다. backlog가 생기면 risk ticker가 분석 요청보다 다음 슬롯을 우선 배정받아 열린 포지션의 보호 확인이 분석 요청에 굶지 않도록 합니다. 기존 120ms safety slot과 `RISK_CHECK_STALE` fail-closed 경계는 유지됩니다.

시장 분석 클라이언트와 독립 포지션 리스크 클라이언트는 같은 프로세스-wide 요청 슬롯을 공유합니다. 따라서 리스크 확인을 빠르게 유지하면서도 두 클라이언트가 각자 Upbit 요청 한도를 초과하지 않도록 합니다. 열린 포지션이 있는 동안에는 risk ticker 요청 시작 자체를 ledger에 기록하고, 성공 timestamp가 허용 공백보다 오래되면 요청 실패 callback을 기다리지 않고 `RISK_CHECK_STALE`로 paper/live를 fail-closed 중지합니다. watchdog이 실행되기 전에 늦은 성공 callback이 도착해도 마지막 정상 관찰부터의 공백을 역산해 같은 오류로 기록하고 continuity를 되살리지 않습니다. 정상 성공 timestamp도 risk interval의 5배 이내 주기로 throttled persistence하여 읽기 전용 Observer가 낡은 파일 상태를 정상 관찰로 오인하지 않게 합니다. 포지션이 없는 idle 구간의 오래된 risk timestamp는 outage로 오인하지 않습니다.

열린 포지션이 없더라도 전체 대상 시장을 분석하지 못한 상태가 계속되면 유효한 forward 표본으로 보지 않습니다. `SCALP_MAX_ANALYSIS_DATA_GAP_SECONDS`(스캘핑 기본 60초)를 넘는 부분 분석 공백은 paper/live 루프를 fail-closed로 중지하고 `analysisDataHealth.continuityEligible=false`로 기록합니다. batch ticker가 실패했어도 개별 fallback으로 모든 시장 분석이 완료되면 완전한 cycle로 인정하며, 실제 시장 누락만 공백으로 판정합니다.

스캘핑 RSI는 레거시 전략의 전역 `RSI_*`와 분리할 수 있습니다. `SCALP_RSI_PERIOD`, `SCALP_RSI_OVERSOLD`, `SCALP_RSI_OVERBOUGHT`를 지정하면 스캘핑과 기존 전략이 서로 다른 RSI 튜닝값을 섞지 않습니다. 미지정 시 기존 `RSI_*` 값으로 fallback하며, 실제 사용값은 forward `configSnapshot`에 기록됩니다.

네트워크 timeout과 별도로 진입 직전 캔들의 시각도 확인합니다. `SCALP_MAX_CANDLE_AGE_SECONDS=0`이면 분봉 단위에 맞춰 자동으로 계산하며, 1분봉 기본값은 90초입니다. 최신 캔들 timestamp가 없거나 허용 나이를 넘으면 strict 진입과 shadow 후보를 모두 차단하고 telemetry에 사유를 기록합니다. telemetry는 초기 `analysis` 차단과 지연 후 `entry_confirmation` 차단을 따로 세고, age의 최소·평균·최대와 마지막 timestamp를 함께 보존합니다. 캔들 개수가 최소 분석량보다 적은 마켓은 stale과 별도의 데이터 품질 항목으로 마켓별 횟수·수신 개수·필요 개수를 기록합니다. freshness 관측은 마켓별 전체 표본·유효 표본·stale 비율·age 통계도 함께 보존해 특정 마켓 격리 후보를 검토할 수 있게 합니다. paper status/API와 대시보드는 최소 관측 100회·stale 차단률 5% 이하를 기본으로 다음 paper용 freshness cohort를 진단해 보여주며, `SCALP_MARKET_QUALITY_MIN_OBSERVATIONS`와 `SCALP_MARKET_QUALITY_MAX_STALE_RATE`는 이 표시 기준만 조정합니다. 현재 세션의 시장 목록·strict 손익·실거래 gate는 절대 자동 변경하지 않습니다. 동일 1분봉을 반복해서 관측하는 5초 cycle이 rejection/hold 수를 독립 표본처럼 부풀리지 않도록 새 세션은 `coin:signalKey` 기준 `uniqueSignalWindows`·`uniqueRejectionCounts`도 별도로 기록합니다. 구버전 원장은 과거 고유 window를 추정하지 않고 해당 값은 미측정으로 표시합니다. 캔들 부족 telemetry도 stale과 분리해 보존하므로, 마켓 제외 판단을 데이터 지연과 데이터 부족으로 혼동하지 않습니다. 이 값은 실행 계약에 포함되므로 forward `configSnapshot`과 fixed validation 설정이 일치해야 하며, 오래된 세션에 조용히 섞이지 않습니다.

지연 후 재검증은 `entryConfirmationAttempts`, `entryConfirmationSucceeded`, `entryConfirmationCancelled`, `entryConfirmationReasons`로 별도 집계합니다. 따라서 strict confirmed 후보가 실제 주문으로 이어지지 않은 경우에도 중지 요청·재조회 실패·stale candle·신호 무효화 등 producer→consumer 단절 원인을 확인할 수 있습니다. 검증 기록 UI의 신호 상태에도 이 성공/취소 요약이 표시되며, 이 telemetry는 수익성 표본으로 간주하지 않습니다.

relaxed `shadow`/`looseShadow`도 신호 기준가에서 실제 관찰 가격이 strict의 `SCALP_MAX_ENTRY_RETRACE_PERCENT` 또는 `SCALP_MAX_ENTRY_CHASE_PERCENT`를 넘으면 가상 진입하지 않습니다. `shadowEntryExecutionBlockedEntries`와 사유별 telemetry를 별도로 기록해, 지연 후에는 체결될 수 없는 추격 가격을 relaxed 손익에 섞지 않습니다. 이 경계는 진단 장부의 체결 현실성을 높이는 것이며 strict 주문 계약이나 live gate를 완화하지 않습니다.

특정 마켓이나 후보 로직만 연구할 때는 `SCALP_VALIDATION_MARKETS`와 `SCALP_VALIDATION_OUTPUT_FILE`을 함께 지정해 기본 승격 리포트를 덮어쓰지 않도록 합니다. 검증 grid는 lookback 1/3과 직전 고가 돌파 필터 true/false를 모두 비교하지만, 런타임 기본값은 여전히 엄격한 조건을 유지합니다.

동일한 raw candle window를 공식 validation CLI에서 재사용하려면 `SCALP_VALIDATION_CANDLES_FILE`에 `{ "KRW-BTC": [...] }` 형태의 cache를 지정합니다. 지정된 cache에서는 선택한 모든 시장이 반드시 발견되어야 하며, 누락 시장을 현재 네트워크 데이터로 섞지 않고 fail-closed합니다. 리포트 각 결과에는 `candleSource=cache`와 cache 경로가 남아 재현 가능한 비교가 가능합니다.

Upbit 분봉 API는 체결이 한 번도 없는 시간대의 candle을 응답에서 생략합니다. 따라서 raw cache의 2분 간격이 곧 수집 오류라는 뜻은 아닙니다. 기본 validation/live gate는 여전히 raw gap을 fail-closed하여 synthetic data를 승격 근거로 사용하지 않습니다. 무체결 구간을 이전 종가 고정·거래량 0으로 명시적으로 채워 elapsed time을 보존하는 연구 전용 비교가 필요하면 `npm run validate:scalping:no-trade-fill`을 사용합니다. 이 명령은 raw cache와 선택한 paper snapshot만 읽고 별도 report를 만들며, 결과의 `promoted`는 항상 `false`입니다.

```bash
SCALP_NO_TRADE_FILL_CANDLES_FILE=/tmp/coinpilot-30d-1m.json \
SCALP_NO_TRADE_FILL_MARKETS=KRW-BTC,KRW-ETH,KRW-XRP \
SCALP_VALIDATION_CONFIG_SNAPSHOT_FILE=.paper-forward-v73/paper_validation.json \
SCALP_NO_TRADE_FILL_OUTPUT_FILE=/tmp/coinpilot-no-trade-fill.json \
npm run validate:scalping:no-trade-fill
```

실행 중인 paper session과 validation 설정을 완전히 맞추려면 `SCALP_VALIDATION_CONFIG_SNAPSHOT_FILE`에 해당 `paper_validation.json`을 지정합니다. `configSnapshotComplete=true`인 snapshot의 전략·리스크 필드를 validation config의 source of truth로 사용하고, 리포트에는 snapshot 경로·session ID·완전성 상태를 기록합니다. snapshot이 불완전하거나 `SCALP_VALIDATION_CANDLE_UNIT`과 snapshot의 candle unit이 다르면 기본값으로 조용히 fallback하지 않고 fail-closed합니다.

기본 tuned holdout grid는 여러 signal profile·RSI·반등·거래량·추세·손익비 후보의 Cartesian 조합을 모두 평가합니다(현재 `20,736`개). 장시간 연구에서만 `SCALP_VALIDATION_MAX_CANDIDATES`를 양수로 지정하면 전체 grid에서 결정론적으로 균등 샘플링하고 실제 runtime 설정을 반드시 포함합니다. 리포트에는 전체 후보 수와 실제 평가 수가 따로 기록되며, capped 결과는 후보 누락 가능성이 있으므로 live 승격 근거로 사용하지 않습니다. 기본값 `0`은 전체 grid입니다.

현재 실행 중인 설정 자체의 성과를 확인하려면 `npm run validate:scalping:fixed`를 사용합니다. 이 모드에서는 학습 구간에서 grid 튜닝을 하지 않고 현재 `SCALP_*`/`RSI_*` 설정을 그대로 training/holdout에 적용합니다. 기본 `npm run validate:scalping`은 tuned holdout 탐색용이며, 두 결과는 서로 다른 질문에 답합니다. live gate에는 fixed 명령으로 생성한 `scalping_validation.json`만 사용할 수 있습니다.

`SCALP_REQUIRE_VALIDATION_PASS=true`가 기본값이므로, 스캘핑 모드에서 `DRY_RUN=false`로 시작하려면 선택된 모든 검증 마켓이 워크포워드 게이트를 통과한 `scalping_validation.json`이 필요합니다. 검증 결과가 0/3이면 실전 자동매매 시작 자체가 중단됩니다. 홀드아웃은 학습 구간의 마지막 지표 워밍업을 사용하지만 워밍업 구간에서는 거래하지 않습니다.

급격한 한 봉 변동으로 손절되는 후보를 분석하기 위해 `SCALP_MAX_SIGNAL_RANGE_PERCENT` 변동폭 상한도 제공합니다. 기본값 `0`은 비활성화이며, 양수로 바꿀 때는 반드시 별도 historical holdout과 forward shadow에서 먼저 검증합니다. 이 값을 즉시 완화하거나 조이는 것은 수익성 개선을 의미하지 않습니다.

반대로 너무 조용한 반등을 제외하는 `SCALP_MIN_SIGNAL_RANGE_PERCENT` 하한도 제공합니다. 기본값 `0`은 비활성화이며, 신호 캔들의 고가-저가 범위가 하한보다 작으면 `signal_range_too_narrow`로 거절합니다. 상한과 마찬가지로 별도 holdout/forward 검증 전에는 켜지지 않습니다.

이미 과도하게 올라온 반등을 뒤늦게 추격하지 않도록 `SCALP_MAX_REBOUND_PERCENT` 상한도 제공합니다. 기본값 `0`은 비활성화이며, 양수이면 과매도 기준 가격에서 현재 완료 캔들까지의 반등폭이 상한을 넘을 때 `price_rebound_above_threshold`로 거절합니다. 이는 1~5초 지연 중의 현재가 chase 제한과 다른 신호 캔들 자체의 exhaustion guard입니다. 연구용 `max_rebound_04/05/07` 후보는 동일 window·holdout·forward shadow를 모두 통과하기 전에는 runtime에 적용하지 않습니다.

여러 마켓이 동시에 약세인 구간의 반등 진입을 제한하는 portfolio regime gate도 별도 후보로 제공합니다. `SCALP_MARKET_REGIME_ENABLED=false`가 기본값이며, 활성화하면 최근 lookback 봉의 상승 마켓 비율(breadth)과 평균 수익률을 함께 확인합니다. 이는 현재 설정을 자동으로 완화하는 기능이 아니며, 다중 마켓 동일 윈도우 holdout에서 검증된 경우에만 후보로 취급합니다.

수익이 난 뒤 되돌림을 줄이는 보호 출구 후보로 `SCALP_BREAK_EVEN_TRIGGER_PERCENT`/`SCALP_BREAK_EVEN_OFFSET_PERCENT`와 `SCALP_TRAILING_ACTIVATION_PERCENT`/`SCALP_TRAILING_STOP_PERCENT`를 제공합니다. 활성화 기준값은 기본 `0`이라 기존 고정 손절·익절 계약을 유지하며, 해당 값은 독립 holdout과 forward shadow에서 검증되기 전까지 자동으로 켜지지 않습니다.

여러 마켓에서 손실이 연속될 때 신규 진입을 전역으로 잠그는 선택형 회로차단기도 제공합니다. `SCALP_LOSS_CIRCUIT_BREAKER_COUNT=0`이 기본값이라 기존 동작을 바꾸지 않습니다. 양수로 설정하면 지정한 시간창 안에 N회 손실이 발생한 뒤 strict 자동진입과 shadow 진입을 각각 차단하고, 해당 상태를 forward ledger에 저장합니다. 이 보호장치는 수익성 증명이 아니므로 별도 holdout과 forward 결과를 확인하기 전에는 활성화하지 않습니다.

손실 중인 포지션만 일정 시간 뒤 먼저 닫는 `SCALP_MAX_LOSING_HOLD_MINUTES` 후보도 제공합니다. `0`이 기본값이며, 이익 중인 포지션은 기존 max-hold까지 유지합니다. 1분봉 노이즈와 회복 시간을 분리해 검증하기 위한 risk 후보이고, 양수 설정은 multi-fold holdout과 forward paper에서 모두 확인하기 전에는 적용하지 않습니다.

winner-hold를 strict 결과와 같은 신호에서 직접 비교하려면 `SCALP_WINNER_SHADOW_EXTEND_MINUTES=30`을 별도 forward paper 실행에 지정할 수 있습니다. 이 옵션은 confirmed strict BUY만 별도 `winnerShadow` 장부에 복제하고 exit만 winner-hold 후보로 바꾸며, strict 자산·shadow/loose 손익·live gate에는 합산하지 않습니다. `paperExperiments` snapshot과 drift 검사가 함께 저장되므로 재시작 시 실험 설정이 바뀌면 fail-closed 됩니다. 기본값 `0`은 완전 비활성입니다.

strict baseline과 과대 반등 상한을 같은 실시간 BUY에서 직접 비교하려면 `SCALP_WINNER_SHADOW_MAX_REBOUND_PERCENT=0.4`를 사용할 수 있습니다. strict 쪽은 `SCALP_MAX_REBOUND_PERCENT=0`으로 유지하고, winner shadow만 confirmed BUY 중 반등폭 `0.4%` 이하를 복제합니다. winner shadow의 `entryContract`와 `entryMaxReboundPercent`는 별도 snapshot에 기록되며 strict 자산·승격 판정에는 포함되지 않습니다. 단독 historical holdout과 forward 표본이 없는 한 이 sidecar 결과를 runtime 승격 근거로 사용하지 않습니다.

ceiling이 차단한 signal은 `winnerShadow.blockedEntries`로 저장합니다. strict가 같은 signal을 실제로 청산하면 sidecar의 가상 진입가·왕복 수수료·adverse slippage를 사용해 `counterfactualRealizedProfit`을 정산하므로, 차단이 손실 회피인지 수익 기회 손실인지 확인할 수 있습니다. strict 지연 재검증이 취소되어 실제 체결 자체가 없으면 해당 entry는 `not_filled`로 종결하고 counterfactual 표본에서는 제외합니다. 이 counterfactual은 strict 자산·승격 gate에 절대 합산하지 않습니다.

여러 마켓이 같은 완료 캔들에서 동시에 반등할 때 상관된 진입이 한꺼번에 쌓이는 것을 분석하기 위해 `SCALP_MAX_ENTRIES_PER_SIGNAL_WINDOW` 후보도 제공합니다. `0`이 기본값이며, 양수로 설정하면 같은 signal key를 공유하는 strict 진입 수를 전역으로 제한합니다. v30에서 동일 signal window에 3개 strict 진입이 발생한 관찰을 근거로 만든 보완장치지만, 현재는 비활성 상태이고 portfolio holdout과 forward paper에서 별도 검증해야 합니다.

워크포워드 튜닝은 holdout만 보지 않습니다. 학습 구간에서도 기본적으로 최소 3회 거래, PF 1 이상, 수익률 0% 이상을 요구합니다. 학습부터 무너진 후보는 `training_gate_failed`로 기록되며, 거래 수가 많다는 이유로 우선순위를 얻지 않습니다. 이 기준은 탐색 후보를 줄이는 안전장치이며 실제 수익을 보장하지 않습니다.

`npm run validate:scalping:fixed`는 여기에 거래별 수익률의 95% 단측 t 하한을 추가로 확인합니다. 기본값은 학습 10건·holdout 20건 이상이며, 평균 거래수익 하한이 `0%` 이상이어야 합니다. 단일 양수 거래나 표본이 작은 양수 holdout은 신뢰도 게이트를 통과하지 못합니다. 이 계산은 거래 표본의 screening guard일 뿐 실제 체결·독립성·미래 수익을 증명하지 않으며, confidence metadata가 없는 구형 report도 live gate에서 fail-closed 됩니다.

API 키는 [업비트 Open API 관리](https://upbit.com/mypage/open_api_management)에서 발급받을 수 있습니다.

## 실행

```bash
# 전체 시스템 실행 (스캘핑 자동매매 + 대시보드)
npm start

# 개별 실행
npm run dashboard    # 대시보드만
npm run dashboard:paper # 기존 forward paper ledger를 읽기 전용으로 표시
npm run dashboard:staging # 실제 entrypoint 기반 격리 DRY_RUN staging 대시보드
npm run backtest     # 백테스팅만
npm run optimize     # 기존 종합점수 전략 최적화 (스캘핑 기본 모드에서는 사용하지 않음)
npm run validate:scalping # 읽기 전용 7일 워크포워드 수익성 검증
npm run validate:scalping:fixed # 현재 runtime 설정을 고정한 live-gate용 검증
npm run validate:scalping:no-trade-fill # 무체결 구간 flat-fill 연구 (promotion 불가)
npm run validate:scalping:portfolio # 공유 KRW/포지션 제한을 반영한 별도 진단 검증 (live 승격 불가)
npm run validate:shadow    # relaxed shadow 후보의 진단용 holdout 검증 (실전 승격 불가)
npm run compare:scalping   # 동일 캔들 윈도우에서 여러 스캘핑 후보를 공정 비교 (진단 전용)
npm run research:htf-momentum # 1h/4h 추세 모멘텀 대체 로직 연구 (promotion 불가)
npm run research:htf-momentum:fetch -- /tmp/coinpilot-htf-momentum-candles.json # 완료된 raw 15분봉 cache 수집 (research 전용)
npm run research:daily-momentum:fetch # 동일 12시장 완료 일봉 cache 수집 (research 전용)
npm run research:daily-momentum # daily trend/breadth/exit 후보 sweep (promotion 불가)
npm run research:daily-momentum:robustness # position/risk envelope와 최악 segment 비교 (promotion 불가)
npm run research:daily-momentum:robustness -- /tmp/candles.json /tmp/report.json # 입력·출력 cache/report를 positional 인자로 지정
npm run research:daily-momentum:benchmark-confirmation -- /tmp/candles.json /tmp/report.json 1,2,3 continuous # benchmark 확인일 비교 (research 전용)
npm run research:daily-market-neutral # synthetic long/short 상대강도 연구 (현물 short 미연결)
npm run research:momentum-shadow:status # 실행 중인 daily shadow owner의 read-only 상태
npm run research:momentum-shadow:preflight # 새 risk-capped shadow owner 시작 전 read-only 점검
npm run research:momentum-shadow:start-if-ready # gate 통과 시에만 별도 owner 시작; 실행에는 ALLOW_START 명시 필요
npm run verify:pwa # manifest/icon/service worker shell 설치 계약 검증
npm run paper:smoke       # 기존 포트폴리오와 분리된 짧은 DRY_RUN forward smoke
npm run paper:forward     # .paper-forward에 격리된 장기 DRY_RUN forward 세션
```

대시보드는 http://localhost:3000 에서 확인할 수 있습니다.

프론트엔드/API smoke가 필요할 때는 `npm run dashboard:staging`을 사용하세요. 이 명령은 `DRY_RUN=true`를 강제하고 `.staging-runtime/<timestamp>/` 아래에 별도 `dry_portfolio.json`과 paper ledger를 생성하므로 사용자의 root `dry_portfolio.json`을 읽거나 수정하지 않습니다. 기본 staging 포트는 `3100`이며 `STAGING_PORT`와 `STAGING_TARGET_COINS`로 바꿀 수 있습니다. 실제 주문·수익성·wallet settlement 증거가 아닙니다.

실제로 실행 중인 forward paper 장부를 웹/모바일/PWA 화면에서 관찰하려면 별도 읽기 전용 서버를 사용하세요. 이 서버는 지정한 ledger의 최신 snapshot과 strict/shadow 검증 결과만 읽고, paper 세션 start/stop과 주문 경로를 차단합니다. 원본 runner와 다른 포트에서 실행해야 합니다.

```bash
PAPER_DASHBOARD_LEDGER_FILE=$PWD/.paper-forward-v49/paper_validation.json \
DASHBOARD_PORT=3152 \
npm run dashboard:paper
```

`npm run dashboard`는 UI smoke를 위한 결정론적 mock 화면이고, `npm run dashboard:staging`은 실제 entrypoint 기반의 격리 DRY_RUN 화면입니다. 둘을 실제 forward 수익성 장부와 혼동하지 마세요. `dashboard:paper`도 관찰 UI 증거일 뿐이며, 실거래·wallet settlement 증거는 아닙니다.

대시보드는 PWA로도 동작합니다. redesign shell의 모드 경계에 있는 `앱으로 설치` 버튼 또는 모바일 브라우저의 “홈 화면에 추가”·데스크톱 브라우저의 “앱 설치”를 사용하면 standalone 설치앱으로 열 수 있습니다. Android/Chrome은 설치 이벤트를 사용하고, iOS Safari처럼 설치 이벤트가 없는 환경은 화면의 `설치 안내`에서 `공유 → 홈 화면에 추가` 경로를 안내합니다. 설치앱에서도 계좌·시세·거래 데이터는 서버 API를 기준으로 읽으며, 오프라인 캐시는 화면 껍데기만 제공하고 오래된 거래 상태를 표시하지 않습니다.

### AI Desk: 구독 기반 읽기 전용 자문

대시보드의 `AI Desk` 탭에서 GPT/Codex와 Claude 로컬 CLI의 로그인 세션을 연결 상태로 확인하고, 매수 신호·매도 신호·반등 후보·속보·리밸런싱 제안·체결 이벤트를 장기 모니터링할 수 있습니다. 모니터링 session은 `ai_monitoring_sessions.json`에 저장되므로 프로세스가 재시작되어도 session, 이벤트, 자문 이력이 남습니다.

AI 자문은 다음 경계를 지킵니다.

- GPT는 `codex` CLI, Claude는 `claude` CLI를 사용하며 앱에 provider API key를 저장하지 않습니다.
- AI 응답은 `BUY`/`SELL`/`HOLD`/`WAIT` 의견과 근거·위험·무효화 조건으로만 기록됩니다.
- AI 의견은 주문으로 자동 변환되지 않습니다. 설정값 기반 기존 `executeOrder()` 자동 매수·매도 경로는 그대로 독립 실행됩니다.
- session 생성 시 이벤트 종류, 코인 필터, 동일 이벤트 재자문 간격, 자동 자문 여부, 결과 평가 시점(기본 5분)을 정할 수 있습니다. 비용과 호출량을 관리하기 위해 기본 cooldown은 300초입니다.
- paper AI bridge는 후보 event를 계속 기록하지만 `PAPER_AI_AUTO_CONSULT_EVENTS`(기본 `BUY_SIGNAL,SELL_SIGNAL`)에 포함된 확정 event만 자동 상담합니다. 후보를 자동 상담하려면 이 환경변수에 `REBOUND_CANDIDATE`를 명시적으로 추가해야 합니다.
- 실제 provider 응답은 기준 이벤트 가격과 평가 시점 이후 처음 관측된 같은 코인 가격에 자동 대조됩니다. `BUY`/`SELL`은 비용중립 구간(기본 ±0.3%)을 제외하고 `HIT`/`MISS`/`FLAT`으로, `HOLD`/`WAIT`는 `CALM`/`ABSTAINED`로 별도 집계합니다. provider prompt에도 동일한 horizon·neutral band가 전달되므로 자문 기준과 evaluator 기준이 어긋나지 않습니다. local brief·실패 응답·신선하지 않은 snapshot·가격이 없는 이벤트는 provider 적중률에 섞지 않습니다.
- 실제 응답이 한 provider뿐이면 `singleProvider`로 제한 표시하고 consensus 표본으로 세지 않습니다. 두 provider 이상이 같은 방향으로 응답한 경우에만 `quorum=true`인 consensus를 별도로 평가합니다.
- 기존 전략 event가 `BUY`/`SELL`인데 AI가 `WAIT`/`HOLD`를 반환하면 directional hit-rate와 별도로 `VETO_GOOD`(손실 회피), `VETO_MISSED_OPPORTUNITY`(상승 기회 회피), `VETO_FLAT`을 집계합니다. AI를 방향 예측기뿐 아니라 위험 veto로 평가하기 위한 지표입니다.
- veto에는 비용중립 band를 넘은 counterfactual 영향도 합산합니다. `veto net impact`가 양수면 band 초과 손실 회피가 기회손실보다 컸다는 뜻이고, 이는 실제 주문 수익이 아니라 research-only 위험 회피 지표입니다.
- 대시보드와 `GET /api/ai/effectiveness`에서 실제 응답률, provider별 지연·평가 표본·적중률, 평가 대기 건수를 확인할 수 있습니다. 최소 20개 비중립 방향성 또는 veto 표본 전에는 `sufficientEvidence=false`로 표시됩니다. 단순 `REBOUND_CANDIDATE + WAIT/CALM` 관찰과 `VETO_FLAT`은 표본 수에 포함되지 않으며, 이 지표도 주문 승인이나 수익성 보장을 의미하지 않습니다.

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

shadow/loose 진단 장부에만 미청산 포지션이 남은 경우에도 `endedWithDiagnosticOpenPositions`와 종료 시점 snapshot을 보존하고, 같은 ledger의 자동 재사용을 막습니다. 리스크 ticker 또는 분석 데이터 공백으로 자동 중지되면 `stopReason`은 각각 `risk_data_gap` 또는 `analysis_data_gap`으로 기록되며 `continuityEligible=false`가 됩니다. 이런 ledger는 수익성 표본으로 승격하지 않고 새 출력 디렉터리에서 관찰을 이어가야 합니다.

격리 smoke가 필요하면 `npm run paper:smoke`를 사용합니다. 기본 60초 동안 `PAPER_SMOKE_MARKETS`를 읽기 전용으로 분석하고 `.paper-smoke/` 아래에 가상 포트폴리오와 paper ledger를 저장합니다. 기존 `dry_portfolio.json`은 읽거나 수정하지 않습니다. 이 smoke는 연결·상태 저장 검증용이며, 7일 수익성 승격 증거로 사용하지 않습니다.

동일 호스트에서 여러 `paper:forward` 또는 AI paper smoke를 동시에 실행하지 마세요. 각 Node 프로세스의 내부 요청 슬롯은 프로세스 사이에서 공유되지 않으므로 Upbit 공용 rate budget이 겹쳐 `stale_candle_snapshot`이 늘고 해당 원장이 효능·수익성 표본으로 부적합해질 수 있습니다. 실행기는 다른 살아 있는 paper owner를 발견하면 `PAPER_CONCURRENT_SESSION`으로 market resolution 전에 fail-closed하며, 새 process 사이의 startup race도 `.paper-session.lock`으로 막습니다. 장기 forward를 종료한 뒤 새 세션을 별도 출력 디렉터리에서 시작하고, 동시 실험이 불가피하면 `PAPER_ALLOW_CONCURRENT_SESSIONS=true`를 명시한 진단 실행으로만 사용한 뒤 freshness와 `analysisDataHealth`를 먼저 확인합니다.

실제 DRY_RUN 분석 이벤트를 AI 자문과 함께 관찰하려면 다음처럼 선택형 paper AI monitoring을 켤 수 있습니다. 이 모드는 별도 `ai_monitoring_sessions.json`에 provider 응답과 미래 가격 평가를 저장하며, AI 의견을 주문에 연결하지 않습니다. provider 호출 비용과 지연을 의도적으로 발생시키므로 기본값은 꺼져 있습니다.

```bash
PAPER_AI_MONITORING=true \
PAPER_AI_PROVIDERS=gpt \
PAPER_AI_EVENTS=REBOUND_CANDIDATE,BUY_SIGNAL,SELL_SIGNAL \
PAPER_SMOKE_SECONDS=600 \
PAPER_SMOKE_OUTPUT_DIR=/tmp/coinpilot-ai-paper-smoke \
npm run paper:smoke
```

종료 시 출력되는 `aiMonitoring.effectiveness`와 별도 원장의 `GET /api/ai/effectiveness`가 실제 응답률·지연·평가 표본을 보여줍니다. 실제 매매 효용을 주장하려면 stale/가격 없는 이벤트를 제외한 평가 표본이 최소 20개 쌓여야 하며, 짧은 smoke나 synthetic fixture는 연결성 증거일 뿐입니다.

고정 candle cache에서 실제 provider를 historical replay하려면 다음을 사용합니다. 이 결과는 주문·wallet·live gate에 연결되지 않는 research-only report입니다.

```bash
AI_REPLAY_CANDLES_FILE=.cap-study-candles.json \
AI_REPLAY_MAX_SAMPLES=20 \
AI_REPLAY_HORIZON_CANDLES=5 \
AI_REPLAY_PROVIDER=gpt \
AI_REPLAY_OUTPUT_FILE=/tmp/coinpilot-ai-historical-replay.json \
npm run ai:replay -- --require-provider
```

확정된 `BUY_SIGNAL`/`SELL_SIGNAL` 후보만 provider에 보내는 진단 replay가 필요하면 `AI_REPLAY_CONFIRMED_ONLY=true`를 추가합니다. 이는 완화된 진단 설정을 비교할 때 유용하지만 runtime 설정·live gate·promotion 증거를 바꾸지 않습니다.

Replay는 방향성 `HIT/MISS`와 함께 기존 BUY/SELL signal을 AI가 WAIT/HOLD로 막았을 때의 `VETO_GOOD`/`VETO_MISSED_OPPORTUNITY`를 별도로 집계합니다. historical replay의 결과도 live 효용이나 promotion 근거로 자동 승격하지 않습니다.

여러 historical replay window의 안정성을 함께 확인하려면 다음 research-only gate를 사용합니다. window별 veto net impact의 부호가 충돌하거나 비중립 표본이 최소값보다 적으면 `evidenceReady=false`로 유지합니다.

```bash
npm run ai:robustness -- \
  /tmp/coinpilot-ai-7d-confirmed-loose-20.json \
  /tmp/coinpilot-ai-14d-confirmed-loose-20.json
```

양쪽 provider replay report의 합의만 점검하려면 `AI_ROBUSTNESS_SCOPE=consensus`를 추가합니다. `providers`는 개별 provider만, `all`은 provider와 consensus rows를 함께 집계합니다. 이 gate는 현재 두 window를 `INSUFFICIENT_NON_NEUTRAL` 및 `windowSignConflict=true`로 판정하며, AI 자문을 주문으로 연결하거나 live promotion을 허용하지 않습니다.

장기 forward paper는 `npm run paper:forward`로 실행합니다. 첫 실행은 `.paper-forward/`에 새 시드로 시작하고, 이후 같은 폴더로 재실행하면 기존 활성 세션을 이어갑니다. 프로세스가 비정상 종료되어 heartbeat가 오래된 경우에도 forward 모드는 기존 ledger를 새로 만들지 않고 같은 세션을 복구하지만, 기록된 공백이 `SCALP_PAPER_MAX_HEARTBEAT_GAP_MINUTES`를 넘으면 승격 자격은 자동 보류됩니다. 의도적인 `Ctrl+C` 종료 후에는 새 세션으로 다시 시작하며, 실전 주문은 호출하지 않습니다. 이 세션이 최소 7일·20회 청산·수익률·MDD·연속 관찰 게이트를 모두 통과해야 forward paper 승격 후보가 됩니다. strict 진입과 별도로 soft 후보는 shadow 장부에만 기록되어 완화 후보의 참고 손익/PF를 관찰합니다.

각 runtime·shadow 포지션은 관찰된 최고가/최저가를 기준으로 MFE(max favorable excursion)와 MAE(max adverse excursion)를 기록합니다. 이 값은 현재 stop/take 동작을 변경하지 않으며, 청산 전에 충분히 수익권에 도달했는지와 보호 출구가 필요한 손실 경로였는지를 구분하는 exit 튜닝용 진단 데이터입니다. 구버전 ledger에는 값이 없을 수 있고, 그 거래는 MFE/MAE를 `null`로 표시합니다.

런너가 처리할 수 있는 오류(`uncaughtException`, `unhandledRejection`, top-level failure)는 ledger의 `terminalError`/`lastError`에 원인과 시각을 기록하고 가능한 경우 `STOPPED` 전환과 lock 해제를 수행합니다. OS 강제 종료처럼 잡을 수 없는 종료는 dashboard가 저장된 owner PID와 heartbeat를 기준으로 즉시 orphan/보류 처리하며, 다음 명시적인 forward 재실행은 기존 증거 창을 보존한 채 interruption을 추가합니다. `terminalError`가 남은 세션은 원인 확인 후에도 자동으로 live 승격되지 않습니다.

Forward 상태의 `lossCircuitBreaker`는 현재 손실 횟수, 차단 여부, 남은 차단 시간과 설정값을 보여줍니다. 회로차단기가 진입을 막은 횟수는 telemetry에 별도로 기록되며, strict 실현손익이나 live 승격 조건을 우회하지 않습니다.

새 forward 세션은 strategy mode, 시장 목록, RSI/반등/거래량/추세/변동폭 필터, 손절·익절·보유시간, 수수료·슬리피지, 투자비율과 포지션 제한을 `configSnapshot`으로 함께 저장합니다. 이후 재실행 시 설정이 달라지면 기존 세션에 조용히 섞지 않고 drift로 표시하며 승격을 보류합니다. snapshot이 없는 구버전 ledger는 복구할 수 있지만 전체 구간 재현성이 확인되지 않은 상태로 취급합니다.

읽기 전용 paper dashboard/API는 `configConsistent=false`인 이유를 `configValueDrift`(양쪽 snapshot에 모두 있지만 값이 다른 항목)와 `configSchemaDrift`(구버전 snapshot에 없거나 현재 source에서 사라진 항목)으로 나눠 표시합니다. schema 차이는 실제 runtime 값 변경을 의미하지 않을 수 있지만, 새 source로의 자동 재개·실전 승격은 여전히 보류합니다. 이 구분은 경고의 정확도를 높일 뿐 검증 gate를 완화하지 않습니다.

장기 실행 로그는 기본적으로 compact 모드이며 60초마다 cycle·strict BUY·shadow·거래 수·자산만 출력합니다. 상세 cycle 로그가 필요하면 `PAPER_FORWARD_VERBOSE=true npm run paper:forward`를 사용합니다.

이전 forward 원장에서 데이터 품질이 좋은 시장만 별도 코호트로 재현하려면 `PAPER_SMOKE_MARKETS=FRESH_FROM_LEDGER PAPER_SMOKE_FRESHNESS_LEDGER=.paper-forward-v44/paper_validation.json npm run paper:forward`처럼 실행할 수 있습니다. 기본 최소 관측 수는 100회, freshness 차단률 상한은 5%이며 `PAPER_SMOKE_MIN_FRESHNESS_OBSERVATIONS`, `PAPER_SMOKE_MAX_STALE_RATE`, `PAPER_SMOKE_MAX_MARKETS`로 실험 범위를 지정합니다. 표본 부족·차단률 초과 시장은 fail-closed로 제외하고, 선택된 시장의 원래 순서는 유지합니다. 이는 이전 ledger 기반의 진단 코호트 선택일 뿐 기본 전략·실거래 universe·live gate를 바꾸지 않습니다.

후보 비교 study는 `SCALP_VARIANT_MARKETS`, `SCALP_VARIANT_NAMES`, `SCALP_VARIANT_CANDLE_COUNT`, `SCALP_VARIANT_CANDLES_FILE`, `SCALP_VARIANT_CANDLES_OUTPUT_FILE`, `SCALP_VARIANT_OUTPUT_FILE`을 선택적으로 지정할 수 있습니다. `SCALP_VARIANT_CANDLES_FILE`에 `{ "KRW-BTC": [...] }` 형태의 candle cache를 주면 네트워크 재수집 없이 동일한 윈도우를 재사용할 수 있고, `SCALP_VARIANT_CANDLES_OUTPUT_FILE`로 이번 study가 실제 사용한 raw window를 저장할 수 있어 threshold·exit 후보를 같은 데이터에서 반복 비교할 수 있습니다. 시장별 캔들을 한 번만 수집해 같은 윈도우에서 비교하지만, 결과는 승격 리포트가 아니며 실전 설정을 바꾸지 않습니다.

Historical validation은 이제 cache의 timestamp 간격도 검증합니다. `candleUnit`의 1.5배를 넘는 gap, 누락/잘못된 timestamp, 비증가 timestamp가 있으면 `dataQuality`에 상세 gap 통계를 남기고 해당 single-market·shared-portfolio replay를 fail-closed 합니다. 거래소가 유동성 부족 또는 수집 경계 때문에 빈 봉을 반환할 수 있으므로, array index만 보고 gap을 인접 봉으로 이어 붙이면 RSI·rolling feature·max-hold 시간이 왜곡됩니다. gap이 있는 cache는 수익률/튜닝 근거로 사용하지 말고 연속 cache를 새로 수집하세요. 이 historical guard는 forward paper의 live freshness gate와 별개입니다.

Upbit의 무체결 gap이라는 원인이 확인된 raw cache를 시간축 보존 관점에서 비교해야 할 때만 `npm run validate:scalping:no-trade-fill`을 사용합니다. 이 lane은 누락 구간을 직전 실제 종가의 flat OHLC와 거래량 0으로 채우고 `syntheticNoTradeCount`·gap 상세·`validForReplay`를 기록합니다. 가격 경로를 새로 발명하지는 않지만 synthetic candle을 포함하므로 기본 validation report를 대체하지 않으며, 어떤 screening gate가 통과해도 historical/live promotion은 허용하지 않습니다.

후속 research CLI에서 같은 filled window를 재사용하려면 `SCALP_NO_TRADE_FILL_CACHE_OUTPUT_FILE`을 추가합니다. 생성된 cache는 synthetic candle을 포함하므로 반드시 `/tmp` 등 별도 경로와 별도 output report를 사용하고, `scalping_validation.json` live-gate 파일로 복사하지 않습니다.

연속 cache가 부족해 gap 경계를 제외한 연구가 필요하면 다음 segmented diagnostic을 사용할 수 있습니다. cache를 반드시 명시해야 하며, gap을 flat candle로 채우지 않고 각 연속 segment만 replay합니다. segment 끝에서 `BACKTEST_END`가 발생한 미청산 포지션은 `unknownBoundaryPositions`로 분리해 실현손익·confidence에서 제외합니다. 결과는 `promoted=false`인 진단 전용 report이며, 이 결과로 runtime 설정이나 실전 주문을 승인할 수 없습니다.

```bash
SCALP_SEGMENT_CANDLES_FILE=/tmp/coinpilot-30d-1m.json \
SCALP_VALIDATION_CONFIG_SNAPSHOT_FILE=.paper-forward-v73-baseline-mfe/paper_validation.json \
SCALP_SEGMENT_OUTPUT_FILE=/tmp/coinpilot-segmented.json \
npm run validate:scalping:segments
```

snapshot을 사용하지 않을 때는 `SCALP_SEGMENT_CANDLE_UNIT`, `SCALP_RSI_OVERSOLD`, `SCALP_RSI_OVERBOUGHT`와 나머지 `SCALP_*` strategy/risk 환경변수를 명시해야 합니다. `SCALP_SEGMENT_MIN_CANDLES` 기본값은 `200`이며, 이보다 짧은 segment는 제외하고 report에 남깁니다. segmented report의 `raw.valid=false`, `diagnosticOnly=true`, `unknownBoundaryPositionCount`, `excludedSegmentCount`를 확인한 뒤에만 연구 결과를 해석하세요. promotion 증거에는 gap 없는 원본 cache의 일반 validation만 사용합니다.

variant 목록에는 `micro_exit_04_06`, `micro_exit_05_08`, `micro_exit_06_09`처럼 비용 이후에도 작은 반등을 회수할 수 있는지 보는 stop/take 후보와 `next_candle_followthrough` 후보가 포함됩니다. 전자는 수수료·슬리피지에 민감하고 후자는 기존 1~5초 지연 진입과 다른 다음 봉 종가 계약이므로, 양수 결과가 나와도 각각 별도 holdout·forward cohort 없이 runtime에 적용하지 않습니다.

`max_rebound_04`, `max_rebound_05`, `max_rebound_07`은 반등 하한을 낮추는 후보가 아니라, 이미 크게 튄 신호를 제외하는 상한 후보입니다. `max_rebound_04_follow_through`는 다음 봉 종가 확인까지 결합한 별도 계약입니다. 상한은 과도한 추격을 줄일 수 있지만 표본을 굶길 수 있으므로, 수익률이 개선된 한 window만으로 승격하지 않습니다.

`range_cap_02`, `range_cap_05`, `range_cap_08`, `range_cap_10`과 rebound 조합은 신호 캔들의 과도한 고저폭을 상한으로 제한하는 연구용 후보입니다. 이 cap은 현재 runtime 기본값이 아니며, 동일창 study에서 실제 신호를 바꿨는지와 training/holdout 통과 여부를 함께 확인해야 합니다.

`oversold_lookback_3` 계열은 최근 완료 봉 하나가 아니라 최대 3개 완료 봉 안의 과매도 반응을 참조하는 진단 후보입니다. 과거 신호를 더 많이 포착할 수 있지만 stale signal과 비용 누적 위험도 있으므로, 양수 표본 하나만으로 runtime `oversoldLookback=1`을 바꾸지 않습니다.

`rebound_10`, `rebound_30`, `rebound_35`, `rebound_40`은 기본 `0.15%` 및 `0.25/0.50%` 주변의 반등 threshold를 비교하는 연구 후보입니다. `rsi_40`과 `rsi_45`는 현재 runtime RSI 과매도 기준 `35`보다 느슨한 연구 후보입니다. 동일 7일·1분봉 window에서 RSI 40은 합산 `-0.0905%`/17 trades, RSI 45는 `-0.0759%`/30 trades로 baseline RSI 35의 `-0.0411%`/10 trades보다 악화됐고 모두 training gate를 실패했습니다. 비용·표본·training/holdout gate를 함께 통과하지 않는 한 runtime threshold를 조정하지 않습니다.

`cooldown_30m`, `cooldown_60m`, `cooldown_120m`은 손실 청산 뒤 같은 시장의 재진입을 더 오래 차단하는 risk 후보입니다. 현재 runtime 기본 cooldown은 15분이며, longer cooldown은 거래 기회를 줄일 수 있으므로 별도 holdout과 forward cohort 없이는 적용하지 않습니다.

relaxed shadow 후보 검증도 `SHADOW_VALIDATION_CANDLES_FILE`을 지정하면 동일한 `{ "KRW-BTC": [...] }` candle cache를 재사용합니다. `SHADOW_VALIDATION_MARKET`으로 cache 안의 시장을 선택하고, 리포트에는 `candleSource=cache`를 기록합니다. 이 검증은 strict 계약을 완화한 진단 코호트일 뿐이며 실전 승격을 허용하지 않습니다.

`npm run validate:scalping:portfolio`는 여러 마켓을 하나의 시간축으로 맞춰 공유 KRW 잔액, `SCALP_MAX_POSITIONS`, 동시 신호 우선순위를 반영합니다. 마켓별 독립 백테스트와 실제 포트폴리오 실행의 차이를 확인하기 위한 진단 레인이며, 이 결과는 `scalping_validation.json` live gate를 대체하지 않습니다. 기본은 현재 설정 고정이고, `SCALP_PORTFOLIO_VALIDATION_TUNED=true`일 때만 소형 후보 grid를 학습 구간에 적용합니다. `SCALP_PORTFOLIO_VALIDATION_FOLDS=3`을 지정하면 expanding multi-fold로 각 미래 구간을 따로 확인하며, 모든 fold가 통과해야 진단상 통과로 표시됩니다. `SCALP_PORTFOLIO_CANDLES_FILE=/tmp/...json`을 지정하면 동일 원시 캔들창을 재사용할 수 있습니다.

portfolio 진단에서만 `requireNextCandleBullish` 후보도 비교할 수 있습니다. 이는 신호 다음 봉이 실제로 양봉으로 마감된 뒤 그 종가에 진입하는 계약이어서 기존 1~5초 지연 진입과 다릅니다. `SCALP_PORTFOLIO_REQUIRE_NEXT_CANDLE_BULLISH=true`는 별도 연구용이며, 현재 runtime이나 live gate에 자동 반영되지 않습니다.

과매도 반등의 완화값을 기본 전략에 섞는 대신, 다른 시간축에서 방향성이 있는지 확인하려면 `npm run research:htf-momentum`을 사용합니다. 이 연구 lane은 15분 원천봉을 완료된 1시간/4시간 봉으로 집계하고, higher-timeframe RSI·자체 7일/14일 추세·다음 원천봉 진입·수수료·슬리피지·보수적인 OHLC 손절/익절을 적용합니다. 시장별 expanding walk-forward와 별도 shared-KRW/maxPositions portfolio replay를 함께 기록하며, 시장별 validation fold와 portfolio boundary가 모두 안전해야 `eligibleForFurtherShadow=true`가 됩니다. report의 `promoted`는 항상 `false`이며 runtime 전략·`scalping_validation.json`·live gate를 변경하지 않습니다. 원천봉 gap 또는 시장별 base-candle grid mismatch가 있는 경우 fail-closed합니다.

Upbit이 거래가 없었던 15분 구간의 candle을 생략할 수 있으므로 `research:htf-momentum:fetch`는 기본적으로 raw continuity가 깨지면 저장하지 않습니다. 분석 목적의 짧은 no-trade gap만 시험하려면 `SCALP_HTF_MOMENTUM_FILL_NO_TRADE=true`와 최대 interval 제한을 명시할 수 있으며, 이 경우 이전 종가·거래량 0의 synthetic candle이 생성되고 cache/report는 계속 promotion 불가입니다. raw cache와 synthetic cache 결과를 같은 조건에서 분리 비교해야 하며, synthetic 결과만으로 forward 후보를 만들지 않습니다.

최신 4,000개 raw 15분봉 cache(약 41.7일)는 네 시장 모두 continuity를 통과했지만, HTF 5개 variant의 모든 시장별 expanding walk-forward가 FAIL이었습니다. portfolio full 결과는 variant별 `+6.168%~+10.108%`로 보였지만 validation fold의 음수/무거래·표본 부족이 남아 `allMarketFoldsPassed=false`, `eligibleForFurtherShadow=false`입니다. 2,000개 cache에서도 portfolio 결과가 `-0.798%~-3.614%`였고 모든 fold가 FAIL이었습니다. 따라서 HTF 대체 logic은 현재 shadow/runtime에 연결하지 않습니다. 재현 cache/report는 `/private/tmp/coinpilot-htf-momentum-candles-4000.json`, `/private/tmp/coinpilot-htf-momentum-diagnostic-4000.json`, `/private/tmp/coinpilot-htf-momentum-diagnostic-2000.json`입니다.

```bash
SCALP_HTF_MOMENTUM_CANDLES_FILE=/tmp/coinpilot-60d-15m-20mk-20260913.json \
SCALP_HTF_MOMENTUM_MARKETS=KRW-BTC,KRW-ETH,KRW-XRP,KRW-SOL \
SCALP_HTF_MOMENTUM_OUTPUT_FILE=/tmp/coinpilot-htf-momentum.json \
npm run research:htf-momentum
```

이 lane의 full-window 양수 결과는 한 regime에 집중된 관측일 수 있으므로 수익 증명으로 해석하지 않습니다. 시장별 fold 실패, 표본 부족, confidence 하한 실패, 미청산 boundary position이 하나라도 있으면 별도 forward shadow로 바로 승격하지 말고 새로운 독립 window에서 재검증합니다.

롱온리 일봉 momentum이 장기 구간에서 손실을 보일 때는 임계값을 계속 미세 조정하는 대신 `npm run research:daily-momentum`으로 추세 floor·시장 breadth·2연속 상승·손실 cooldown 후보를 같은 12시장 cache에서 비교합니다. `fetch` 명령은 400일 완료 일봉을 수집하고, suffix 없는 UTC timestamp와 현재 진행 중인 일봉은 validation lane에서 안전하게 처리합니다. 결과는 전체 평가자산과 실현손익, MDD, 구간별 손익, 미청산 boundary를 분리해 표시하며 항상 research-only입니다.

현물 롱온리에서 수익 원천 자체가 부족한지 확인할 때는 `npm run research:daily-market-neutral`을 사용합니다. 이 lane은 7일 상대 추세 상위 종목을 long, 하위 종목을 synthetic short로 모델링하고 rebalance 주기·long/short 노출·spread 조건을 비교합니다. short leg는 inverse price return과 비용을 계산하는 분석용 가정일 뿐 현재 Upbit 현물 주문 경로·지갑·live gate에는 연결되지 않으며, 양수 결과도 실제 실행 가능성이나 수익 보장을 뜻하지 않습니다.

market-neutral report에는 거래비용 `0.1/0.2/0.3%`와 synthetic short borrow 비용 `0/0.01/0.03%/일` sensitivity가 포함됩니다. full-window 결과뿐 아니라 동일한 연속 구간의 수익률도 함께 확인하며, 한 구간이라도 음수이거나 boundary가 남으면 `HOLD`로 분류합니다. borrow 비용은 실제 상품의 확정 수치가 아니라 비용 현실성을 점검하기 위한 stress 가정입니다.

현물 momentum 후보의 낙폭만 제한하는 별도 연구 안전장치로 `maxPortfolioDrawdownPercent`도 비교합니다. peak 평가자산 대비 지정 낙폭에 도달하면 열린 포지션을 비용 포함 청산하고 이후 신규 진입을 잠그는 계약입니다. 기본값 `0`은 비활성이고, 양수 결과가 나와도 수익성 개선이 아니라 노출·손실 제한 효과로만 해석합니다. 현재 runtime/live에는 연결하지 않습니다.

800일 continuous robustness에서 ordinary 후보로 남은 계약을 별도 forward ledger로 관찰하려면 `MOMO_SHADOW_MODE=regime`, 추세 `>2%`, breadth `>=2`, `MOMO_SHADOW_MIN_UP_BARS=2`, `MOMO_SHADOW_BENCHMARK_MARKET=KRW-BTC`, `MOMO_SHADOW_BENCHMARK_TREND_MIN_PERCENT=2`, `MOMO_SHADOW_EXIT_ON_BENCHMARK_OFF=true`, 비중 `0.125`, 최대 2포지션, 손실 cooldown 3일을 사용합니다. launcher 기본은 여기에 historical 결과와 동일한 손익을 보인 `MOMO_SHADOW_MAX_PORTFOLIO_DRAWDOWN_PERCENT=15` 보호중단을 더하지만, 이는 alpha나 실전 수익성 증명이 아니라 노출 제한 장치입니다. 이 후보는 기존 fixed/regime 장부와 섞지 않고, benchmark 데이터가 없으면 신규 진입을 fail-closed합니다. 설정 drift·heartbeat·실현/평가손익·연속 상승봉 조건·cooldown·drawdown stop은 별도 ledger에 보존되며 live 승격과 무관합니다.

`minUpBars=3`은 800일 연속 구간에서 일부 보호중단 후보가 높은 수익률과 낮은 MDD를 보였지만, 독립 400일 cache에서는 최악 구간이 `-4.869%`까지 내려가 `HOLD`가 되었습니다. 따라서 3봉 확인은 현재 launcher/runtime 기본값으로 승격하지 않으며, 800일 단일 결과만으로 forward 후보를 만들지 않습니다. 보고서 `/private/tmp/coinpilot-daily-momentum-robustness-report-800d-upbars-1-3.json`과 `/private/tmp/coinpilot-daily-momentum-robustness-report-400d-upbars-1-3.json`은 이 screening 근거를 별도로 보존합니다.

benchmark gate 자체의 민감도를 확인하기 위해 2026-09-15에 동일한 400일·800일 완료 일봉 cache에서 gate `0/1/2/3/4%` × `minUpBars 1/2`를 independent segment로 재검증했습니다. 각 window의 `2,160`개 조합이 전부 `HOLD`였습니다. 400일 window에서 gate별 최고 full return은 각각 `+12.201/+10.964/+13.268/+4.288/-2.530%`였지만 worst independent segment가 `-5.004%~-6.893%`였고, 800일 window의 gate 2% 최고 조합도 `+57.971%`에 MDD `30.351%`와 `drawdown_above_limit`/boundary blocker가 남았습니다. 따라서 gate 2%는 현재 forward diagnostic contract로만 유지하고, threshold 미세 조정이나 단일 aggregate return을 근거로 runtime·live·promotion을 변경하지 않습니다. 재현 report는 `/private/tmp/coinpilot-daily-momentum-robustness-report-400d-gates-0-4-upbars-1-2-independent.json`과 `/private/tmp/coinpilot-daily-momentum-robustness-report-800d-gates-0-4-upbars-1-2-independent.json`입니다.

현재 forward contract와 같은 continuous segment 기준에서도 결론은 동일합니다. 400일과 800일 양쪽에서 보호중단 없는 `SHADOW_CANDIDATE` 교집합은 gate `1%` 20개, gate `2%` 8개뿐이고 gate `0/3/4%`는 0개였습니다. 현재 계약 `g2_u2_t2_b2_f0p125_p2_c3`은 400일 `+4.501%`/PF `1.48`/MDD `3.65%`/worst segment `-1.993%`, 800일 `+26.495%`/PF `1.66`/MDD `14.92%`/worst segment `+0.214%`였습니다. 이는 2% gate를 방어형 forward diagnostic으로 유지할 근거이지, 독립 미래 구간의 수익 보장은 아닙니다. continuous 재현 report는 `/private/tmp/coinpilot-daily-momentum-robustness-report-400d-gates-0-4-upbars-1-2-continuous.json`과 `/private/tmp/coinpilot-daily-momentum-robustness-report-800d-gates-0-4-upbars-1-2-continuous.json`입니다.

historical daily simulator와 forward shadow runner의 signal 선택 순서도 맞춥니다. eligible signal을 모두 수집한 뒤 trailing trend 내림차순, market code 오름차순으로 정렬하고 `maxPositions`를 적용하므로, 시장 배열 순서가 우연히 어떤 종목을 먼저 채우는지에 따라 결과가 달라지지 않습니다. 선택 순위는 각 forward position에 `selectionRank`로 남기고, position limit으로 탈락한 신호는 `blockedSignalCount`로 기록합니다. 기존에 실행 중인 owner는 재시작하지 않으며, 새로 시작하는 별도 candidate부터 이 계약을 사용합니다.

forward runner의 signal 중복 방지도 프로세스 메모리에만 두지 않습니다. 시장별 `consumedSignalKeyByMarket`를 ledger에 기록하고, 재시작 시 기존 position과 trade entry에서 최신 완료 candle key를 복원하므로 같은 완료 일봉을 재진입 표본으로 중복 기록하지 않습니다. 차단 횟수는 `duplicateSignalBlocked`로 status CLI와 read-only API에 표시됩니다. 이 장치는 paper evidence의 중복 오염을 막는 idempotency 보호이며, 수익성이나 promotion을 증명하지 않습니다.

완료 close를 곧바로 체결가로 사용하는 가정도 별도 검증합니다. `entryExecution=close`가 기존 계약이고, `entryExecution=next_open`은 완료 close에서 signal을 관측한 뒤 다음 일봉 opening price에 진입하는 execution-boundary stress입니다. 다음 open이 없거나 opening price가 누락된 cache는 `daily_entry_open_price_missing`으로 fail-closed하며, 마지막 signal을 실행하지 못한 경우 `unknownBoundaryEntryCount`로 남겨 robustness 후보에서 제외합니다. 400/800일 next-open 결과가 양쪽 window에서 확인되기 전에는 forward runner나 runtime 기본 계약을 바꾸지 않습니다.

entry와 exit를 모두 `next_open`으로 지연하는 더 엄격한 stress도 별도로 비교합니다. 이번 canonical 계약은 400일에서 `+4.121%`/PF `1.43`/MDD `4.33%`였지만 worst segment `-2.246%`로 floor `-2%`를 깨 `HOLD`가 되었고, 800일은 `+13.372%`/PF `1.37`/MDD `14.69%`/worst `-0.550%`였습니다. 따라서 entry-only next-open은 별도 forward diagnostic 후보로 유지하되 exit-next-open은 현재 forward runner에 연결하지 않습니다. 실행 경계가 양쪽 독립 window에서 재현되지 않은 값을 수익 개선 장치로 승격하지 않습니다. 재현 report는 `/private/tmp/coinpilot-daily-momentum-robustness-report-400d-full-next-open.json`과 `/private/tmp/coinpilot-daily-momentum-robustness-report-800d-full-next-open.json`입니다.

entry-only next-open의 비용 민감도도 별도 확인했습니다. 왕복 비용 `0.2%`에서는 두 window가 후보였지만 `0.3%`에서 400일 worst segment가 `-2.071%`, 800일 MDD가 `15.07%`로 각각 gate를 넘었고, `0.4/0.5%`에서도 계속 `HOLD`였습니다. 따라서 next-open은 비용 `0.2%`라는 연구 가정 아래의 forward diagnostic일 뿐 실제 수익 전략으로 승격하지 않으며, 비용·슬리피지 측정값이 확보되기 전까지 live 기본값을 바꾸지 않습니다. 재현 report는 `/private/tmp/coinpilot-daily-momentum-benchmark-confirmation-400d-next-open-cost-0p3.json`, `/private/tmp/coinpilot-daily-momentum-benchmark-confirmation-800d-next-open-cost-0p3.json`, `/private/tmp/coinpilot-daily-momentum-benchmark-confirmation-400d-next-open-cost-0p4.json`, `/private/tmp/coinpilot-daily-momentum-benchmark-confirmation-800d-next-open-cost-0p4.json`, `/private/tmp/coinpilot-daily-momentum-benchmark-confirmation-400d-next-open-cost-0p5.json`, `/private/tmp/coinpilot-daily-momentum-benchmark-confirmation-800d-next-open-cost-0p5.json`입니다.

비중과 동시 보유 한도의 tail-risk 민감도는 `DAILY_MOMENTUM_ROBUSTNESS_TREND_MIN_PERCENT`, `...BREADTH_MIN`, `...POSITION_FRACTION`, `...MAX_POSITIONS`, `...COOLDOWN_AFTER_LOSS_DAYS`, `...MAX_PORTFOLIO_DRAWDOWN_PERCENT` 축으로 CLI에서 재현할 수 있습니다. 비용 `0.3%`·next-open·gate `1%`·trend `2%`·breadth `3`·cooldown `3일`에서 비중 `0.0625/0.1/0.125/0.15/0.2`, 최대 포지션 `1/2/3`, volatility target `0.75/1/1.25%`를 45개 조합으로 공식 재실행했습니다. 연속 400/800일 기준 각각 28/45개가 risk-envelope 후보였지만, 저노출 `0.0625·max2·vol0.75`의 수익은 `+1.361%/+4.695%`로 낮아졌습니다. 독립 segment 모드에서는 마지막 미청산 경계를 알 수 없어 별도 승격 근거가 되지 않으므로, 새 low-risk owner를 추가하지 않고 현재 `0.125·max2·vol1` next-open 후보만 유지합니다. 재현 report는 `/private/tmp/coinpilot-daily-momentum-robustness-report-400d-risk-axis-formal.json`과 `/private/tmp/coinpilot-daily-momentum-robustness-report-800d-risk-axis-formal.json`입니다.

동일한 next-open·cost `0.3%`·gate `1%`·trend `2%`·breadth `3`·minUpBars `2`·volatility target `1%/14일`·gap ceiling `0.2%` contract에서 최대 보유일 축도 별도 검증했습니다. next-open 진입 후 fixed hold 시간은 entry open부터 해당 완료 close까지 세도록 simulator와 forward runner의 의미를 먼저 맞췄습니다. 보정된 `fixed_h2`는 최근 400일에서 `+5.092%`/PF `1.88`/MDD `1.48%`/92 trades/worst segment `-0.377%`, 800일에서 `+11.351%`/PF `1.78`/MDD `1.91%`/223 trades/worst segment `-0.058%`였습니다. 왕복 비용을 `0.4%`로 올려도 400/800일 `+4.628%/+10.343%`, `0.5%`에서도 `+4.166%/+9.343%`로 risk-envelope를 유지했습니다. 추가 global cost `1.2%` stress에서는 400/800일 `+0.913%/+2.552%`로 양수를 유지했지만 PF가 `1.12/1.14`까지 낮아졌고, cost `1.5%`에서는 400/800일 모두 음수로 전환됐습니다. 따라서 spread와 fee를 합친 실제 총비용이 `1.5%`에 접근하면 후보를 자동 보류해야 하며, 이를 비용 강건성 증명으로 표현하지 않습니다. 이는 regime보다 항상 우수하다는 결론이 아니라 회전율과 보유시간이 다른 별도 exit 가설이므로 기존 regime/next-open 후보를 교체하지 않고 `.paper-momentum-shadow-fixed-hold-2d-v1`에 독립 A/B로 등록합니다. 추가로 현재 호가 spread가 `0.5%`를 넘는 시장만 동적으로 신규 진입에서 제외하는 `.paper-momentum-shadow-fixed-hold-2d-spread-v1` quote-quality A/B를 별도 등록합니다. 이 guard는 과거 orderbook 시계열이 없어 historical 수익을 주장하지 않으며, 완전한 quote 응답이 없으면 해당 cycle의 신규 진입을 fail-closed하고, 정상 응답에서는 초과 시장만 차단합니다. 2026-09-15 read-only orderbook snapshot `5/5`에서는 DOGE가 `0.881%`로 5회 모두 ceiling을 넘었고 ADA는 `0.355%`로 관측됐습니다. 이는 단기 실행비용 관측이며 실제 체결 증거가 아니므로 `/private/tmp/coinpilot-momentum-shadow-quote-quality.json`에서 별도 확인합니다. 연속 segment historical 근거일 뿐 실제 수익·승격 근거가 아니며, 재현 report는 `/private/tmp/coinpilot-daily-momentum-robustness-report-400d-fixed-hold-axis.json`, `/private/tmp/coinpilot-daily-momentum-robustness-report-800d-fixed-hold-axis.json`, cost stress `/private/tmp/coinpilot-daily-momentum-robustness-report-400d-fixed-hold-2d-axis-cost04.json`, `/private/tmp/coinpilot-daily-momentum-robustness-report-800d-fixed-hold-2d-axis-cost04.json`, `/private/tmp/coinpilot-daily-momentum-robustness-report-400d-fixed-hold-2d-axis-cost05.json`, `/private/tmp/coinpilot-daily-momentum-robustness-report-800d-fixed-hold-2d-axis-cost05.json`, `/private/tmp/coinpilot-daily-momentum-robustness-report-400d-fixed-hold-2d-axis-cost12.json`, `/private/tmp/coinpilot-daily-momentum-robustness-report-800d-fixed-hold-2d-axis-cost12.json`입니다. 전체 trailing-window 재현은 `/private/tmp/coinpilot-daily-momentum-rolling-fixed2d-800d.json`에서 확인하며, 120일은 26 trades로 `INSUFFICIENT_SAMPLE`, 180~800일은 `POSITIVE_OBSERVATION`으로 기록됩니다.

next-open 실행에서 신호 종가보다 다음 opening price가 급등하는 추격 진입도 `DAILY_MOMENTUM_ROBUSTNESS_MAX_ENTRY_GAP_PERCENT`로 별도 검증할 수 있습니다. 이 값은 양의 overnight gap만 차단하며 `0`은 비활성입니다. 후보의 400/800일 진입 표본 54/109건에서 gap 최대값은 `+0.395%`, 95백분위는 약 `+0.105%`였으므로 `0.1/0.2/0.3%`를 research-only 축으로 추가했습니다. 비용 `0.3%`에서 gap `0.2/0.3%`는 양쪽 window의 risk-envelope와 거래 표본을 유지하면서 결과를 개선했고, 비용 `0.4%`에서도 gap `0.2/0.3%`가 후보로 남았습니다. 따라서 별도 `.paper-momentum-shadow-next-open-v1` forward 후보에는 `0.2%` ceiling을 연결하되, 기존 close owner와 장부를 섞지 않고 승격과 무관한 A/B로 관찰합니다. 재현 report는 `/private/tmp/coinpilot-daily-momentum-robustness-report-400d-gap-ceiling.json`, `/private/tmp/coinpilot-daily-momentum-robustness-report-800d-gap-ceiling.json`, `/private/tmp/coinpilot-daily-momentum-robustness-report-400d-gap-ceiling-cost04.json`, `/private/tmp/coinpilot-daily-momentum-robustness-report-800d-gap-ceiling-cost04.json`입니다.

forward daily shadow는 응답이 시장별로 정렬·연속이어도 최신 완료 일봉이 기본 `36시간`보다 오래되면 `daily_market_stale`로 전체 신규 진입을 차단합니다. 이는 stale 응답을 과거의 정상 breadth로 오인하는 것을 막는 데이터 안전장치이며, `MOMO_SHADOW_MAX_DAILY_CANDLE_AGE_HOURS`와 ledger의 시장별 최신 시각·나이를 함께 보존합니다. stale 차단은 수익성 개선으로 계산하지 않고 데이터 품질 실패로만 표시합니다.

benchmark owner가 저장한 gate boolean의 threshold와 새 후보의 threshold가 다를 수 있으므로, candidate preflight는 source owner의 boolean을 그대로 복사하지 않고 fresh `benchmarkTrendPercent`에 candidate contract의 `benchmarkTrendMinPercent`를 다시 적용합니다. 결과에는 candidate gate와 source gate, 두 threshold를 모두 남겨 `1%` 후보가 `2%` source gate 때문에 잘못 차단되거나 반대로 열리는 일을 방지합니다.

cost `0.3%`를 유지하면서 benchmark gate `0/1/2/3%`와 `minUpBars 1/2`를 함께 sweep한 `1,728`개 조합에서는 400/800일 교집합이 8개였습니다. 그중 별도 forward diagnostic으로 고정한 `next-open` 계약은 benchmark gate `1%`, trend `2%`, breadth `3`, `minUpBars=2`, position fraction `0.125`, max positions `2`, cooldown `3일`, volatility target `1%/14일`, cost `0.3%`입니다. 이 계약은 400일 `+3.601%`/PF `1.96`/MDD `1.37%`/worst `-0.755%`, 800일 `+12.679%`/PF `2.30`/MDD `2.61%`/worst `-0.700%`였지만, 이는 historical risk-envelope 통과일 뿐 실제 수익 증명이 아닙니다. target은 `.paper-momentum-shadow-next-open-v1`로 분리하고, close-fill 장부와 섞지 않으며, exit-next-open은 연결하지 않습니다. 재현 report는 `/private/tmp/coinpilot-daily-momentum-robustness-report-400d-cost03-g1-next-open-vol.json`과 `/private/tmp/coinpilot-daily-momentum-robustness-report-800d-cost03-g1-next-open-vol.json`입니다.

같은 g2 계약에서 `exitOnBenchmarkOff=false`도 별도 비교했습니다. benchmark-off 즉시 청산을 끄면 400일 결과가 `+4.501%`/PF `1.476`/MDD `3.655%`에서 `+0.024%`/PF `1.002`/MDD `8.334%`로, 800일 결과가 `+26.495%`/PF `1.657`/MDD `14.918%`에서 `+17.835%`/PF `1.450`/MDD `17.578%`로 악화되었습니다. 따라서 benchmark-off 청산은 단순 표시용 보호장치가 아니라 현재 candidate 결과에 기여하는 실행 계약으로 유지하며, 이를 완화하는 튜닝은 forward evidence 없이 적용하지 않습니다.

상관된 동시 진입을 줄이는 `maxPositions=1`도 같은 g2 contract에서 별도 확인했습니다. 비중 `0.125`의 max-1 후보는 400일 `+2.941%`/PF `1.476`/MDD `3.247%`로 max-2보다 낙폭은 낮았지만 거래가 26건으로 최소 30건 표본 gate를 통과하지 못했고, 800일은 `+16.290%`/PF `1.683`/MDD `9.968%`였습니다. 이는 risk A/B forward 후보로는 보존하지만, 현재 max-2 contract보다 표본이 부족하므로 runtime이나 기본 forward candidate를 교체하지 않습니다.

benchmark가 threshold를 넘은 뒤에도 `benchmarkMinUpBars`일 동안 연속 확인해야 진입을 허용하는 보완장치도 research simulator에 추가해 검증했습니다. 기본값 `1`은 기존 contract와 동일하며, `2/3` 확인은 400일 continuous에서 `+4.501% → -3.984% → -7.740%`, 800일 continuous에서 `+26.495% → +16.533% → +8.052%`로 악화되었습니다. 800일 worst segment도 `+0.214% → -2.961% → -4.679%`로 내려갔고, 3일 확인은 MDD `15.158%`로 risk limit도 넘었습니다. 따라서 이 보완장치는 false-entry 감소라는 직관과 달리 참여 지연 비용이 더 컸으며, 기본값 `1`을 유지하고 forward/runtime contract에는 연결하지 않습니다. 전용 CLI는 `npm run research:daily-momentum:benchmark-confirmation -- /tmp/candles.json /tmp/report.json 1,2,3 continuous`이며, 이번 재현 report는 `/private/tmp/coinpilot-daily-momentum-benchmark-confirmation-400d-continuous.json`과 `/private/tmp/coinpilot-daily-momentum-benchmark-confirmation-800d-continuous.json`입니다.

하루짜리 benchmark/regime false-off를 줄이는 exit confirmation도 simulator에 research-only로 추가했습니다. `benchmarkExitConfirmationBars`와 `regimeExitConfirmationBars`의 기본값은 각각 `1`이며, `DAILY_MOMENTUM_ROBUSTNESS_BENCHMARK_EXIT_CONFIRMATION_BARS`와 `DAILY_MOMENTUM_ROBUSTNESS_REGIME_EXIT_CONFIRMATION_BARS`로 `1,2,3` 축을 재현할 수 있습니다. 현재 g2/u2/t2/b2/f0.125/max2/cooldown3 계약에서 `b2/r1`은 400일 수익률이 `+6.060%`(baseline `+4.501%`)로 좋아졌지만 800일 MDD가 `16.572%`로 risk limit `15%`를 넘었습니다. 반대로 `b1/r2`는 800일 MDD `12.771%`이지만 400일 worst segment가 `-2.153%`로 floor `-2%`를 깼습니다. `b1/r1` 기본 조합만 두 window 모두 `SHADOW_CANDIDATE`였으므로 새 confirmation 값을 forward/runtime에 연결하지 않고 기본 `1/1`을 유지합니다. 입력 cache와 출력 report는 각각 첫 번째·두 번째 positional 인자로 지정할 수 있으며, 재현 report는 `/private/tmp/coinpilot-daily-momentum-robustness-report-400d-exit-confirmation.json`과 `/private/tmp/coinpilot-daily-momentum-robustness-report-800d-exit-confirmation.json`입니다.

benchmark 대비 약한 종목을 제외하는 `relativeTrendMinPercent` 필터도 연구 전용으로 추가했습니다. benchmark 추세보다 종목 추세가 지정값만큼 높아야 진입을 허용하는 계약이며, benchmark가 없는 경우 fail-closed합니다. `0/0.5/1/2/3/5%`를 비교한 결과 800일 aggregate는 일부 개선됐지만 400일 worst segment가 `-2.137%` 아래로 내려가 모두 floor `-2%`를 충족하지 못했습니다. `5%`에서는 full return도 음수가 됐습니다. 따라서 이 필터는 현재 forward/runtime에 연결하지 않고, robustness CLI의 `DAILY_MOMENTUM_ROBUSTNESS_RELATIVE_TREND_MIN_PERCENT` 축으로만 보존합니다.

동일 금액 진입의 고변동 종목 risk를 줄이기 위해 entry 직전 완료 close 수익률의 표준편차를 목표값과 비교하는 `volatilityTargetPercent`도 추가했습니다. target `0.75/1.0%`, lookback `7/14/21/28일`은 비용 `0.3%`와 400/800일 continuous 32-segment에서 모두 candidate였고, canonical lookback 14일·target 1%는 MDD가 400일 `1.550%`, 800일 `2.408%`까지 감소했습니다. target `1.25%` 이상은 일부 800일 segment에서 worst floor를 깨기 시작하므로 기본값을 바꾸지 않습니다. 이 scaling은 연구와 별도 paper A/B owner에서만 사용할 수 있으며, target unset은 legacy 고정 비중을 유지합니다. 기존 baseline은 800일 32-segment에서 worst `-6.511%`로 tail risk가 드러났습니다.

volatility target `1.0%/14일`에 close-based stop-loss `1/2/3/5/7%`를 붙인 stress도 비교했습니다. 400/800일 continuous 16/32-segment와 비용 `0.3%`에서 모든 값이 형식상 candidate였지만, `1%`는 400/800일 수익을 낮추고 `3%`는 800일 MDD를 낮추는 대신 수익이 감소했습니다. `5/7%`는 800일 aggregate가 baseline보다 소폭 높아도 400일에서 일관된 우위가 없었습니다. stop-loss는 현재 기본 A/B runner contract에 연결하지 않고, `DAILY_MOMENTUM_ROBUSTNESS_STOP_LOSS_PERCENT`를 통한 research-only 축으로 유지합니다.

benchmark를 gate 전용으로 두고 tradable entry에서 제외하는 `excludeBenchmarkFromEntries` 보완장치도 확인했습니다. 400일 continuous는 `+4.501%`/PF `1.476`에서 `+5.529%`/PF `1.595`로, 800일은 `+26.495%`/PF `1.657`에서 `+26.849%`/PF `1.650`으로 개선되었지만, 400일 worst segment가 `-2.176%`로 floor `-2%`를 넘었습니다. breadth에서 benchmark를 세는지 여부도 분리해 비교했으나 이 cache에서는 동일 결과였습니다. aggregate 개선만으로는 충분하지 않으므로 이 옵션은 risk A/B research 후보로만 보존하고, 현재 forward/runtime contract에는 연결하지 않습니다.

## 환경 변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `DRY_RUN` | true | 모의투자 모드 |
| `DRY_RUN_SEED_MONEY` | 10000000 | 시드머니 (원) |
| `UPBIT_REQUEST_TIMEOUT_MS` | 10000 | Upbit HTTP 요청 최대 대기 시간(ms). 응답이 없으면 해당 요청만 실패 처리 |
| `SCALP_RSI_PERIOD` | `RSI_PERIOD` 또는 14 | 스캘핑 전용 RSI 기간 |
| `SCALP_RSI_OVERSOLD` | `RSI_OVERSOLD` 또는 30 | 스캘핑 전용 RSI 과매도 기준 |
| `SCALP_RSI_OVERBOUGHT` | `RSI_OVERBOUGHT` 또는 70 | 스캘핑 전용 RSI 과매수 기준 |
| `SCALP_VALIDATION_CONFIG_SNAPSHOT_FILE` | unset | `configSnapshotComplete=true`인 paper ledger를 공식 validation의 authoritative strategy/risk config로 사용; candle unit 불일치·불완전 snapshot은 fail-closed |
| `SCALP_SEGMENT_CANDLES_FILE` | unset | `validate:scalping:segments` 전용 cache 경로; mixed network window를 만들지 않음 |
| `SCALP_SEGMENT_CANDLE_UNIT` | `SCALP_CANDLE_UNIT` 또는 1 | segmented diagnostic의 candle 단위; paper snapshot을 사용하면 snapshot 단위와 일치해야 함 |
| `SCALP_SEGMENT_MIN_CANDLES` | 200 | segmented diagnostic에서 replay할 최소 연속 segment 길이 |
| `SCALP_SEGMENT_MAX_GAP_SECONDS` | 자동(단위의 1.5배) | segmented diagnostic의 gap 경계 기준; 완화해도 결과는 promotion 불가 |
| `SCALP_MAX_CANDLE_AGE_SECONDS` | 0 (1분봉 90초 adaptive) | 진입 시 허용하는 최신 캔들 timestamp 최대 나이; 0은 분봉 단위 기반 자동 계산 |
| `TARGET_COINS` | ALL | 타겟 코인 (쉼표 구분 또는 ALL) |
| `SCALP_MAX_POSITIONS` | 3 | 스캘핑 최대 동시 포지션 수 |
| `SCALP_INVESTMENT_RATIO` | 0.02 | 1회 진입 총자산 비율 |
| `SCALP_STOP_LOSS_PERCENT` | 1.2 | 스캘핑 손절률 (%) |
| `SCALP_TAKE_PROFIT_PERCENT` | 1.8 | 스캘핑 익절률 (%) |
| `SCALP_MIN_VOLUME_RATIO` | 1.0 | 반등 캔들 최소 거래량 배수 |
| `SCALP_MIN_CLOSE_STRENGTH` | 0.65 | 캔들 고가권 종가 강도 |
| `SCALP_MIN_TREND_SLOPE_PERCENT` | -0.2 | 강한 하락 추세 진입 하한 |
| `SCALP_MAX_SIGNAL_RANGE_PERCENT` | 0 (disabled) | 신호 캔들 고가-저가 범위 상한 (%) |
| `SCALP_MIN_SIGNAL_RANGE_PERCENT` | 0 (disabled) | 조용한 반등 신호를 제외하는 고가-저가 범위 하한 (%) |
| `SCALP_MAX_REBOUND_PERCENT` | 0 (disabled) | 과매도 기준가 대비 이미 과대 반등한 신호를 차단하는 상한 (%) |
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
| `SCALP_WINNER_SHADOW_EXTEND_MINUTES` | 0 (disabled) | strict confirmed BUY를 별도 winner-hold exit 장부에서 관찰할 추가 보유시간(분); promotion 제외 |
| `SCALP_WINNER_SHADOW_EXTEND_MIN_PROFIT_PERCENT` | 0 | winner shadow가 max-hold 연장을 허용할 최소 수익률(%) |
| `SCALP_WINNER_SHADOW_MAX_REBOUND_PERCENT` | 0 (disabled) | strict confirmed BUY 중 winner shadow에만 적용하는 rebound ceiling A/B 필터 (%) |
| `SCALP_MAX_ENTRIES_PER_SIGNAL_WINDOW` | 0 (disabled) | 같은 완료 캔들 signal window에서 허용할 strict 동시 진입 수 |
| `SCALP_RISK_CHECK_INTERVAL_MS` | 1000 | 열린 포지션의 손절·익절·최대보유시간 독립 확인 주기(ms) |
| `SCALP_MAX_RISK_DATA_GAP_SECONDS` | 30 | 열린 포지션 ticker 확인이 끊겼을 때 fail-closed로 중지할 최대 공백(초) |
| `SCALP_MAX_ANALYSIS_DATA_GAP_SECONDS` | 60 | 전체 대상 시장 분석이 불완전한 상태로 이어질 수 있는 최대 공백(초) |
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
| `SCALP_VALIDATION_MAX_CANDIDATES` | 0 (full grid) | tuned holdout에서 평가할 후보 상한; 양수는 research-only 균등 샘플링이며 full pool/선택 수를 함께 기록 |
| `SCALP_HTF_MOMENTUM_CANDLES_FILE` | unset (fetch 기본 `/private/tmp/coinpilot-htf-momentum-candles.json`) | higher-timeframe momentum 연구에 사용할 raw/synthetic research cache; 기본 runtime/live validation과 분리 |
| `SCALP_HTF_MOMENTUM_MARKETS` | `KRW-BTC,KRW-ETH,KRW-XRP,KRW-SOL` | higher-timeframe 연구 대상 시장; cache에 없는 시장은 fail-closed |
| `SCALP_HTF_MOMENTUM_OUTPUT_FILE` | `higher_timeframe_momentum_diagnostic.json` | higher-timeframe 연구 report 경로; promotion report를 덮어쓰지 않음 |
| `SCALP_HTF_MOMENTUM_FILL_NO_TRADE` | false | raw 15분봉 no-trade gap을 짧게 flat-fill할지 여부; true여도 synthetic research-only |
| `SCALP_HTF_MOMENTUM_MAX_FILL_INTERVALS` | 4 | 한 gap에서 허용할 최대 synthetic no-trade interval 수 |
| `SCALP_HTF_MOMENTUM_CANDLE_COUNT` | 8000 | market별 수집할 완료 raw candle 수; fetcher는 부족한 history를 fail-closed |
| `SCALP_HTF_BASE_CANDLE_UNIT` | 15 | higher-timeframe 연구 원천봉 단위(분) |
| `SCALP_HTF_FOLDS` | 3 | higher-timeframe 연구 expanding walk-forward fold 수 |
| `SCALP_HTF_MAX_POSITIONS` | 4 | higher-timeframe shared-balance 진단 portfolio의 최대 동시 포지션 수 |
| `SCALP_HTF_PORTFOLIO_POSITION_FRACTION` | 0.25 | higher-timeframe shared-balance 진단에서 새 포지션당 사용 현금 비율 |
| `DAILY_MOMENTUM_MARKETS` | 12개 liquid KRW 시장 | daily momentum cache 수집 대상 시장 |
| `DAILY_MOMENTUM_DAYS` | 400 | daily momentum cache 요청 일수 |
| `DAILY_MOMENTUM_CANDLES_FILE` | `/private/tmp/coinpilot-daily-momentum-candles.json` | daily momentum 연구 입력 cache |
| `DAILY_MOMENTUM_REPORT_FILE` | `/private/tmp/coinpilot-daily-momentum-report.json` | daily momentum sweep report 경로 |
| `DAILY_MOMENTUM_BENCHMARK_EXPOSURE_MIN_PERCENT` | unset | benchmark 추세 기반 선형 exposure scaling 하한 (%) |
| `DAILY_MOMENTUM_BENCHMARK_EXPOSURE_MAX_PERCENT` | unset | benchmark 추세 기반 선형 exposure scaling 상한 (%) |
| `DAILY_MARKET_NEUTRAL_CANDLES_FILE` | `DAILY_MOMENTUM_CANDLES_FILE` 또는 첫 인자 | synthetic market-neutral 연구 입력 cache |
| `DAILY_MARKET_NEUTRAL_MARKETS` | cache 전체 시장 | synthetic market-neutral 연구 대상 시장 |
| `DAILY_MARKET_NEUTRAL_REPORT_FILE` | `/private/tmp/coinpilot-daily-market-neutral-report.json` | synthetic market-neutral report 경로 |
| `DAILY_MARKET_NEUTRAL_LONG_EXPOSURE` | 0.4 | synthetic long leg 노출 비율 |
| `DAILY_MARKET_NEUTRAL_SHORT_EXPOSURE` | 0.4 | synthetic short leg 노출 비율 |
| `DAILY_MARKET_NEUTRAL_COST_PERCENT` | 0.2 | synthetic long/short 왕복 거래비용 가정 (%) |
| `DAILY_MARKET_NEUTRAL_SHORT_BORROW_COST_PER_DAY` | 0 | synthetic short borrow/financing stress 가정 (%/일) |
| `DAILY_MOMENTUM_MAX_PORTFOLIO_DRAWDOWN_PERCENT` | 0 | daily research circuit breaker의 peak 평가자산 낙폭 기준; 0은 비활성 |
| `DAILY_MOMENTUM_ROBUSTNESS_MODES` | `regime` | robustness 연구의 exit mode 축; `fixed`는 `maxHoldDays` 도달 시 종료 |
| `DAILY_MOMENTUM_ROBUSTNESS_MAX_HOLD_DAYS` | `3650` | robustness 연구의 fixed-mode 최대 보유일 축; regime mode에서는 직접 사용되지 않음 |
| `DAILY_MOMENTUM_ROLLING_CANDLES_FILE` | 첫 번째 인자 | trailing-window daily momentum 연구 입력 cache |
| `DAILY_MOMENTUM_ROLLING_REPORT_FILE` | `/private/tmp/coinpilot-daily-momentum-rolling-report.json` | trailing-window 연구 report 경로 |
| `DAILY_MOMENTUM_ROLLING_WINDOWS` | `120,180,240,300,365,400,500,600,800` | trailing-window를 요청할 일수 목록; history 부족은 fail-closed |
| `DAILY_MOMENTUM_ROLLING_MIN_TRADES` | `30` | trailing-window에서 충분한 표본으로 표시할 최소 청산 수 |
| `DAILY_MOMENTUM_ROLLING_CONFIG_JSON` | fixed 2일 next-open 후보 contract | trailing-window에 적용할 JSON research config override |
| `DAILY_MOMENTUM_ROBUSTNESS_TREND_MIN_PERCENT` | 1,2 | robustness 연구의 종목 추세 threshold 축 (%) |
| `DAILY_MOMENTUM_ROBUSTNESS_BREADTH_MIN` | 2,3 | robustness 연구의 동시 상승 시장 수 축 |
| `DAILY_MOMENTUM_ROBUSTNESS_POSITION_FRACTION` | 0.125,0.2,0.25 | robustness 연구의 종목별 초기자산 비중 축 |
| `DAILY_MOMENTUM_ROBUSTNESS_MAX_POSITIONS` | 2,3,4 | robustness 연구의 동시 보유 한도 축 |
| `DAILY_MOMENTUM_ROBUSTNESS_COOLDOWN_AFTER_LOSS_DAYS` | 0,3 | robustness 연구의 손실 후 재진입 대기일 축 |
| `DAILY_MOMENTUM_ROBUSTNESS_MAX_PORTFOLIO_DRAWDOWN_PERCENT` | 0,10,15 | robustness 연구의 peak 평가자산 보호중단 축 (%) |
| `DAILY_MOMENTUM_ROBUSTNESS_BENCHMARK_EXIT_CONFIRMATION_BARS` | 1 | robustness 연구에서 benchmark-off 출구를 확인할 연속 완료 일봉 수 |
| `DAILY_MOMENTUM_ROBUSTNESS_REGIME_EXIT_CONFIRMATION_BARS` | 1 | robustness 연구에서 regime-off 출구를 확인할 연속 완료 일봉 수 |
| `DAILY_MOMENTUM_ROBUSTNESS_RELATIVE_TREND_MIN_PERCENT` | unset | robustness 연구에서 benchmark 대비 필요한 상대 추세 차이 (%) |
| `DAILY_MOMENTUM_ROBUSTNESS_VOLATILITY_LOOKBACK_DAYS` | 14 | robustness 연구에서 entry 직전 close 변동성을 계산할 lookback 축 |
| `DAILY_MOMENTUM_ROBUSTNESS_VOLATILITY_TARGET_PERCENT` | unset | robustness 연구에서 목표 일변동성; 초과 시 포지션 크기를 축소 |
| `DAILY_MOMENTUM_ROBUSTNESS_STOP_LOSS_PERCENT` | 0 | robustness 연구에서 완료 일봉 close 기준 stop-loss 축; 0은 비활성 |
| `DAILY_MOMENTUM_ROBUSTNESS_MAX_ENTRY_GAP_PERCENT` | 0 | next-open research에서 신호 종가 대비 양의 opening gap ceiling; 0은 비활성 |
| `DAILY_MOMENTUM_ROBUSTNESS_ENTRY_EXECUTION` | `close` | robustness 연구의 entry 체결 경계; `next_open`은 다음 일봉 opening price를 사용 |
| `DAILY_MOMENTUM_ROBUSTNESS_EXIT_EXECUTION` | `close` | robustness 연구의 exit 체결 경계; `next_open`은 exit signal 다음 일봉 opening price를 사용 |
| `DAILY_MOMENTUM_ROBUSTNESS_COST_PERCENT` | `0.2` | robustness 연구에서 사용할 왕복 거래비용 stress 값 (%) |
| `MOMO_SHADOW_BENCHMARK_MARKET` | unset | daily shadow 신규 진입을 허용할 benchmark 시장; 미설정이면 기존 계약 유지 |
| `MOMO_SHADOW_BENCHMARK_TREND_MIN_PERCENT` | 0 | benchmark 7일 추세가 이 값보다 커야 gate open |
| `MOMO_SHADOW_BREADTH_MIN` | 후보 launcher 기본 2 | 800일 continuous robustness에서 선택한 ordinary candidate의 최소 동시 상승 시장 수 |
| `MOMO_SHADOW_MIN_UP_BARS` | 후보 launcher 기본 2 | 진입에 필요한 연속 완료 상승 일봉 수 |
| `MOMO_SHADOW_EXIT_ON_BENCHMARK_OFF` | false | regime shadow에서 benchmark gate가 닫히면 열린 포지션도 연구용 청산 |
| `MOMO_SHADOW_COOLDOWN_AFTER_LOSS_DAYS` | unset | 손실 청산 뒤 해당 시장의 신규 진입을 막는 일수; 별도 candidate ledger에서만 사용 |
| `MOMO_SHADOW_MAX_PORTFOLIO_DRAWDOWN_PERCENT` | unset | peak marked equity 기준 portfolio drawdown stop; 발동 후 해당 owner의 신규 진입을 중지 |
| `MOMO_SHADOW_VOLATILITY_LOOKBACK_DAYS` | 14 | paper candidate의 entry 직전 close-to-close volatility를 계산할 lookback |
| `MOMO_SHADOW_VOLATILITY_TARGET_PERCENT` | unset | volatility가 목표를 넘을 때 position size를 선형 축소; unset은 legacy 고정 비중 |
| `MOMO_SHADOW_ENTRY_EXECUTION` | `close` | shadow runner의 entry 체결 경계; `next_open`은 signal 다음 일봉 opening price에 pending fill |
| `MOMO_SHADOW_MAX_HOLD_HOURS` | fixed `72` / regime `8760` | raw shadow runner의 fixed 최대 보유시간; 2일 A/B 후보는 `48`로 별도 고정 |
| `MOMO_SHADOW_MAX_ENTRY_GAP_PERCENT` | 0 | next-open에서 signal close 대비 양의 opening gap ceiling; 0은 비활성, 별도 후보는 0.2 |
| `MOMO_SHADOW_MAX_DAILY_CANDLE_AGE_HOURS` | 36 | 완료 일봉 최신 timestamp 허용 나이; 초과하거나 시장별 최신 시각이 다르면 신규 진입을 차단 |
| `MOMO_SHADOW_MAX_SPREAD_PERCENT` | 0 | optional best bid/ask spread ceiling; 0은 비활성, 초과 시장만 신규 진입 차단 |
| `MOMO_SHADOW_REQUEST_INTERVAL_MS` | 500 | 한 shadow owner가 시장별 public API 요청 사이에 두는 간격; 여러 owner 합산 rate limit 완화 |
| `MOMO_SHADOW_QUOTE_SAMPLES` | 5 | read-only orderbook snapshot 반복 횟수; `npm run research:momentum-shadow:quotes`에서만 사용 |
| `MOMO_SHADOW_QUOTE_INTERVAL_MS` | 2000 | 반복 quote snapshot 사이 간격(ms) |
| `MOMO_SHADOW_QUOTE_MAX_SPREAD_PERCENT` | 0.5 | quote snapshot report에서 초과 횟수를 집계할 ceiling (%) |
| `MOMO_SHADOW_QUOTE_REPORT_FILE` | `/private/tmp/coinpilot-momentum-shadow-quote-quality.json` | quote snapshot report 경로 |
| `MOMO_SHADOW_QUOTE_HISTORY_FILE` | `/private/tmp/coinpilot-momentum-shadow-quote-history.jsonl` | 반복 quote summary를 append-only로 보존하는 history 경로 |
| `MOMO_SHADOW_NEXT_OPEN_DIR` | `.paper-momentum-shadow-next-open-v1` | cost-robust next-open diagnostic 후보의 격리 ledger 경로 |
| `MOMO_SHADOW_VOLATILITY_DIR` | `.paper-momentum-shadow-vol-target-v1` | volatility target A/B paper ledger 경로; 웹/모바일 read-only 비교에도 사용 |
| `MOMO_SHADOW_FIXED_HOLD_DIR` | `.paper-momentum-shadow-fixed-hold-2d-v1` | cost 0.3%·next-open·48시간 종료 A/B paper ledger 경로 |
| `MOMO_SHADOW_FIXED_HOLD_SPREAD_DIR` | `.paper-momentum-shadow-fixed-hold-2d-spread-v1` | fixed 2일 후보의 실제 호가 spread `0.5%` guard A/B paper ledger 경로 |
| `PAPER_SMOKE_MARKETS` | 미설정 | `FRESH_FROM_LEDGER`를 지정하면 이전 paper 원장 freshness 코호트 선택; 그 외에는 명시 시장 목록 또는 `ALL` |
| `PAPER_SMOKE_FRESHNESS_LEDGER` | 미설정 | freshness 코호트 기준으로 읽을 이전 격리 paper ledger 경로 |
| `PAPER_SMOKE_MIN_FRESHNESS_OBSERVATIONS` | 100 | 코호트 선택에 필요한 시장별 최소 freshness 관측 수 |
| `PAPER_SMOKE_MAX_STALE_RATE` | 0.05 | 새 forward 코호트 선택에서 허용하는 freshness 차단률 상한(0~1) |
| `SCALP_MARKET_QUALITY_MIN_OBSERVATIONS` | 100 | paper status/API의 진단 cohort 추천에 필요한 시장별 최소 freshness 관측 수 |
| `SCALP_MARKET_QUALITY_MAX_STALE_RATE` | 0.05 | paper status/API의 진단 cohort 추천에서 허용하는 freshness 차단률 상한(0~1) |
| `PAPER_ALLOW_CONCURRENT_SESSIONS` | false | 다른 살아 있는 paper session이 있어도 실행하는 명시적 진단 예외; efficacy/승격 표본에는 사용하지 않음 |
| `SCALP_VALIDATION_MIN_TRAINING_TRADES` | 3 | 학습 구간 최소 거래 수 |
| `SCALP_VALIDATION_MIN_TRAINING_PROFIT_FACTOR` | 1 | 학습 구간 최소 profit factor |
| `SCALP_VALIDATION_MIN_TRAINING_RETURN_PERCENT` | 0 | 학습 구간 최소 수익률 (%) |
| `SCALP_VALIDATION_REQUIRE_STATISTICAL_CONFIDENCE` | fixed validation에서 true | 거래수익 95% 단측 신뢰도 하한 게이트 사용 여부; false여도 live report는 통계 metadata 없이는 승인되지 않음 |
| `SCALP_VALIDATION_MIN_TRAINING_CONFIDENCE_TRADES` | 10 | 통계 하한을 계산할 학습 구간 최소 청산 거래 수 |
| `SCALP_VALIDATION_MIN_CONFIDENCE_TRADES` | 20 | 통계 하한을 계산할 holdout 최소 청산 거래 수 |
| `SCALP_VALIDATION_MIN_CONFIDENCE_LOWER_PERCENT` | 0 | holdout 평균 거래수익의 95% 단측 하한 최소값 (%) |
| `AI_ADVISOR_ENABLED` | true | 구독 CLI 기반 읽기 전용 AI 자문 활성화 여부 |
| `AI_ADVISOR_TIMEOUT_MS` | 60000 | provider 한 곳의 자문 응답 최대 대기 시간(ms); 로컬 CLI 초기화 지연 변동을 포함 |
| `AI_PROVIDER_FAILURE_COOLDOWN_MS` | 30000 | timeout/일시적 provider failure 뒤 반복 child 실행을 막는 재시도 대기(ms) |
| `AI_CODEX_IGNORE_USER_CONFIG` | true | 사용자 Codex 설정 파싱 오류가 있어도 앱의 격리 실행 경로를 시도할지 여부 |
| `AI_MONITORING_FILE` | `ai_monitoring_sessions.json` | 장기 모니터링 session/이벤트/자문 이력 파일 |
| `AI_CODEX_BIN` | `codex` | GPT/Codex CLI 실행 파일 경로 |
| `AI_CLAUDE_BIN` | `claude` | Claude CLI 실행 파일 경로 |
| `AI_GPT_MODEL` | CLI 기본값 | GPT 자문에 사용할 선택적 모델 override |
| `AI_CLAUDE_MODEL` | CLI 기본값 | Claude 자문에 사용할 선택적 모델 override |
| `AI_EVALUATION_MINUTES` | 5 | 실제 provider 자문과 미래 가격을 대조할 기준 시간(분) |
| `AI_EVALUATION_NEUTRAL_BAND_PERCENT` | 0.3 | 왕복 fee·adverse slippage를 고려해 방향 적중/실패에서 제외할 중립 가격 변동 폭(%) |
| `AI_EVALUATION_MIN_SAMPLES` | 20 | AI 실효성을 충분한 표본으로 표시하기 위한 최소 평가 수 |
| `PAPER_AI_MONITORING` | false | paper smoke에 AI monitoring session을 명시적으로 연결 |
| `PAPER_AI_PROVIDERS` | gpt | paper AI monitoring에 사용할 provider 목록 |
| `PAPER_AI_EVENTS` | `REBOUND_CANDIDATE,BUY_SIGNAL,SELL_SIGNAL` | paper AI monitoring 대상 event 목록 |
| `PAPER_AI_AUTO_CONSULT_EVENTS` | `BUY_SIGNAL,SELL_SIGNAL` | paper AI monitoring에서 자동 provider 상담할 event 목록; 후보 기록과 자동 상담을 분리 |
| `PAPER_AI_EVALUATION_MINUTES` | 5 | paper AI monitoring의 미래 가격 평가 시점(분) |
| `PAPER_AI_STOP_WAIT_MS` | 35000 | smoke 종료 시 진행 중 provider 호출을 기다리는 최대 시간(ms) |
| `PAPER_AI_MONITORING_FILE` | output dir 아래 | paper AI monitoring 원장 경로 override |
| `AI_REPLAY_CANDLES_FILE` | `.cap-study-candles.json` | historical replay 고정 candle cache |
| `AI_REPLAY_MAX_SAMPLES` | 20 | replay provider 호출 최대 후보 수 |
| `AI_REPLAY_HORIZON_CANDLES` | 5 | 후보 이후 미래 가격을 확인할 candle 수 |
| `AI_REPLAY_MIN_SPACING_CANDLES` | 5 | 인접 후보 중복을 줄이는 최소 간격 |
| `AI_REPLAY_CONFIRMED_ONLY` | false | 확정된 BUY/SELL 후보만 선택하는 research-only replay 필터 |
| `AI_REPLAY_PROVIDER` | gpt | historical replay provider |
| `AI_REPLAY_OUTPUT_FILE` | `/tmp/coinpilot-ai-historical-replay.json` | replay 결과 report 경로 |
| `AI_ROBUSTNESS_MIN_NON_NEUTRAL` | 20 | 여러 replay window를 충분한 표본으로 인정하기 위한 비중립 결과 수 |
| `AI_ROBUSTNESS_SCOPE` | all | robustness 집계 범위: `providers`, `consensus`, `all` |
| `AI_ROBUSTNESS_REPORT_FILES` | 미설정 | robustness CLI에 전달할 replay report 경로 목록 |
| `AI_ROBUSTNESS_OUTPUT_FILE` | 미설정 | robustness aggregate report 저장 경로 |
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
