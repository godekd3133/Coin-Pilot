# Coin Pilot

업비트 거래소용 암호화폐 자동매매 시스템입니다. 기본 실행 모드는 과매도 반응 스캘핑으로, 완료된 1분봉에서 반등을 확인한 뒤 1~5초 지연 재검증을 통과한 경우에만 자동 진입합니다.

규칙 기반 자동매매로 비용을 뺀 순이익을 검증하고, 검증된 전략만 단계적으로 운용한다는 제품 목표와 기능·확장 계획은 [Coin Pilot 제품 기획서](docs/product-plan.md)를 참고하세요.

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

과매도 관측이 0인 조용한 시장도 RSI 임계값이 과도하게 좁은지 확인할 수 있도록, 새 세션은 고유 signal window별 `previousRsi` 최저값과 `SCALP_RSI_OVERSOLD` 기준 5포인트 이내 window 수를 `rsiProximity`로 보존합니다. 이 값은 관찰·튜닝 근거와 웹/모바일 상태 표시만 제공하며, RSI 기준 완화·주문·승격을 자동으로 수행하지 않습니다.

같은 window의 조건 결합 병목을 확인하기 위해 `signalFunnel`도 `available → oversold → bullish → rebound → RSI recovery → volume/range → close strength → trend → previous high → profile → confirmed` 순서의 누적 통과 수를 보존합니다. funnel은 어떤 gate를 자동 완화하지 않으며, 해당 gate 하나만 별도 holdout·forward shadow로 비교할 후보를 고르는 read-only evidence입니다.

시장별 최신 `lastSignalEvidenceByCoin`은 마지막 유효 signal의 RSI·반등률·회복폭·거래량비·종가강도·직전 고가 돌파 여부와 bounded rejection reason만 보존합니다. 원시 네트워크 오류나 주문 자격 증명을 저장하지 않으며, Signal Ledger의 최신 후보 note는 원인 확인을 돕는 관측 자료일 뿐 주문 승인이나 수익성 표본이 아닙니다.

지연 후 재검증은 `entryConfirmationAttempts`, `entryConfirmationSucceeded`, `entryConfirmationCancelled`, `entryConfirmationReasons`로 별도 집계합니다. 따라서 strict confirmed 후보가 실제 주문으로 이어지지 않은 경우에도 중지 요청·재조회 실패·stale candle·신호 무효화 등 producer→consumer 단절 원인을 확인할 수 있습니다. 검증 기록 UI의 신호 상태에도 이 성공/취소 요약이 표시되며, 이 telemetry는 수익성 표본으로 간주하지 않습니다.

relaxed `shadow`/`looseShadow`도 신호 기준가에서 실제 관찰 가격이 strict의 `SCALP_MAX_ENTRY_RETRACE_PERCENT` 또는 `SCALP_MAX_ENTRY_CHASE_PERCENT`를 넘으면 가상 진입하지 않습니다. `shadowEntryExecutionBlockedEntries`와 사유별 telemetry를 별도로 기록해, 지연 후에는 체결될 수 없는 추격 가격을 relaxed 손익에 섞지 않습니다. 이 경계는 진단 장부의 체결 현실성을 높이는 것이며 strict 주문 계약이나 live gate를 완화하지 않습니다.

특정 마켓이나 후보 로직만 연구할 때는 `SCALP_VALIDATION_MARKETS`와 `SCALP_VALIDATION_OUTPUT_FILE`을 함께 지정해 기본 승격 리포트를 덮어쓰지 않도록 합니다. 검증 grid는 lookback 1/3과 직전 고가 돌파 필터 true/false를 모두 비교하지만, 런타임 기본값은 여전히 엄격한 조건을 유지합니다.

동일한 raw candle window를 공식 validation CLI에서 재사용하려면 `SCALP_VALIDATION_CANDLES_FILE`에 `{ "KRW-BTC": [...] }` 형태의 cache를 지정합니다. 지정된 cache에서는 선택한 모든 시장이 반드시 발견되어야 하며, 누락 시장을 현재 네트워크 데이터로 섞지 않고 fail-closed합니다. 리포트 각 결과에는 `candleSource=cache`와 cache 경로가 남아 재현 가능한 비교가 가능합니다.
네트워크에서 수집한 validation window를 후속 continuity/no-trade 분석에 보존하려면 `SCALP_VALIDATION_CANDLES_OUTPUT_FILE=/tmp/...json`을 함께 지정할 수 있습니다. 이 export는 별도 research artifact이며 기본값은 비활성이고 `scalping_validation.json` live-gate 파일을 대체하거나 수정하지 않습니다.

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

2026-09-17 최신 raw cache에서 continuity 실패 시장 ETH를 제외한 BTC+XRP만 별도 fixed validation으로 재생해도 승격 가능 시장은 `0/2`였습니다. BTC holdout은 `+0.0015%`/6 trades/PF `1.06`/95% lower `-0.389%`, XRP는 `+0.0217%`/11 trades/PF `1.74`/95% lower `-0.166%`였고, 두 시장 모두 training confidence gate가 실패했습니다. 따라서 ETH를 검증 목록에서 제외하는 것만으로는 기본 oversold/scalping의 수익성·통계 문제를 해결하지 못하며, 현재 시장 목록·live gate를 축소하지 않습니다. 재현 report는 `/private/tmp/coinpilot-scalping-validation-btc-xrp-current-20260917.json`입니다.

표본 부족을 줄이기 위해 2026-09-17에 최신 30,000개(약 20일) raw candle window도 같은 fixed contract로 재검증했습니다. BTC는 gap `3개`·missing interval `3개`, ETH는 gap `26개`·missing interval `27개`·최대 gap `180초`로 continuity gate가 fail-closed되었습니다. 반면 XRP는 30,000개 candle이 연속했지만 학습 `-0.343%`/46 trades/PF `0.11`, holdout `-0.036%`/23 trades/PF `0.63`/95% lower `-0.238%`로 실제 전략 손실이 재현되었습니다. 긴 window에서도 시장별 문제는 데이터 품질(BTC/ETH)과 전략 음수 성과(XRP)로 분리되며, 시장 제외·confidence 완화·live gate 변경은 적용하지 않습니다. 재현 report와 raw cache는 `/private/tmp/coinpilot-scalping-validation-fixed-30k-20260917.json`, `/private/tmp/coinpilot-scalping-candles-30k-20260917.json`입니다.

같은 30,000개 연속 XRP window에서 tuned holdout도 확인했습니다. 학습 구간 최적 config는 RSI rebound·oversold `30`·lookback `3`·rebound `0.5%`·stop `0.8%`·take `1%`였지만, 학습은 `1` trade `+0.0014%`에 불과했고 holdout은 `-0.0837%`/5 trades/PF `0`/95% lower `-1.180%`로 전부 손실이었습니다. 이는 signal/손익 파라미터가 학습 구간에 과적합되고 미래 구간에서 악화된 직접 evidence이므로 tuned config를 runtime·forward owner·live gate에 연결하지 않습니다. 재현 report는 `/private/tmp/coinpilot-scalping-validation-tuned-xrp-30k-20260917.json`입니다.

같은 XRP 30,000개 연속 cache를 segment diagnostic으로도 재생했습니다. gap 없는 단일 segment에서 `40` trades·승률 `30%`·PF `0.28`·총수익 `-0.155%`·95% lower `-0.299%`가 나왔고 unknown boundary는 `0`건이었습니다. 이는 XRP 손실이 gap 경계나 미청산 boundary artifact가 아니라 연속 데이터 전체에서 반복되는 전략 성과 문제라는 추가 근거입니다. 이 결과도 diagnostic-only로 유지하며 runtime·market list·live gate를 변경하지 않습니다. 재현 report는 `/private/tmp/coinpilot-scalping-segments-xrp-30k-20260917.json`입니다.

BTC·ETH 30,000개 window도 같은 segmented diagnostic으로 분리했습니다. BTC는 gap 경계로 나뉜 4개 segment를 모두 사용했지만 총 `24` trades·PF `0.39`·수익률 `-0.091%`·95% lower `-0.364%`였습니다. ETH는 gap-boundary segment `11개`를 제외하고도 사용 segment에서 총 `15` trades·PF `0.40`·수익률 `-0.052%`·95% lower `-0.369%`였으며 unknown boundary는 `0`건이었습니다. 따라서 BTC는 연속 segment에서도 전략 성과가 음수이고, ETH는 데이터 품질과 잔여 연속 구간의 약한 성과가 함께 존재합니다. 재현 report는 `/private/tmp/coinpilot-scalping-segments-btc-eth-30k-20260917.json`입니다.

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
npm run research:momentum-shadow:status # 실행 중인 daily shadow owner의 read-only 상태(실현수익률·95% 하한·관찰기간 포함)
npm run research:momentum-shadow:preflight # 새 risk-capped shadow owner 시작 전 read-only 점검
MOMO_SHADOW_CANDIDATE_PROFILE=loss_cap npm run research:momentum-shadow:preflight # loss-cap target/config를 같은 계약으로 read-only 점검
MOMO_SHADOW_CANDIDATE_PROFILE=loss_cap_no_doge npm run research:momentum-shadow:preflight # 400/800일 DOGE 제외 loss-cap 후보를 read-only 점검
MOMO_SHADOW_CANDIDATE_PROFILE=quote_cross npm run research:momentum-shadow:preflight # quote-cross target/config와 quote evidence를 read-only 점검
npm run research:momentum-shadow:verify-evidence # 기본 export artifact의 schema/provenance/path 무결성 검증
npm run research:momentum-shadow:verify-evidence -- /path/to/coinpilot-momentum-shadow-evidence.json # 별도 snapshot 검증
npm run research:momentum-shadow:export-evidence -- http://127.0.0.1:3000/api/momentum-shadow /private/tmp/coinpilot-momentum-shadow-evidence-current.json # read-only API projection을 sanitize·verify해 evidence artifact로 저장
npm run research:momentum-shadow:start-if-ready # gate 통과 시에만 별도 owner 시작; 실행에는 ALLOW_START 명시 필요
npm run research:momentum-shadow:start-quote-cross-if-ready # quote-cross fixed 2일 후보; gate/preflight 통과와 ALLOW_START 없이는 시작하지 않음
npm run verify:pwa # manifest/icon/service worker shell 설치 계약 검증
npm run paper:smoke       # 기존 포트폴리오와 분리된 짧은 DRY_RUN forward smoke
npm run paper:forward     # .paper-forward에 격리된 장기 DRY_RUN forward 세션
npm run paper:variants    # 공통 ticker/candle snapshot 기반 multi-variant DRY_RUN forward A/B
npm run research:paper:cohort -- . /private/tmp/coinpilot-paper-forward-cohort.json # 기존 forward ledger read-only cohort 요약
npm run research:paper:exit-evidence -- .paper-forward-sealed-rsi-20260917-r2 /private/tmp/coinpilot-paper-exit-evidence-r2.json # exit reason/MFE/MAE/보유시간 read-only 집계
```

`npm run paper:variants`는 하나의 owner가 시장별 ticker/candle을 한 번만 읽고, 같은 snapshot을 사전 지정한 여러 virtual book에 fan-out하는 연구 전용 runner입니다. 기본 variant는 `baseline,volume_15,rebound_25,max_rebound_04,loss_timeout_5m`이며, `SCALP_FORWARD_VARIANT_NAMES`·`SCALP_FORWARD_MARKETS`·`SCALP_FORWARD_VARIANT_SECONDS`로 별도 설정할 수 있습니다. 각 variant는 독립 `dry_portfolio.json`과 `paper_validation.json`을 가지며, report는 live promotion 파일에 쓰지 않습니다. `PAPER_ALLOW_CONCURRENT_SESSIONS=true`로 여러 paper owner를 억지로 병렬 실행하는 방식과 다릅니다.

장기 관찰은 `SCALP_FORWARD_VARIANT_MODE=true npm run paper:variants`로 실행할 수 있고, output directory를 명시하지 않으면 `.paper-forward-variants/run-<timestamp>/` 아래에 새로 만듭니다. 이 runner의 결과는 동일 데이터·비용·시각 조건에서의 비교 근거이지, 실거래 체결·wallet settlement 또는 수익 보장이 아닙니다.

candidate preflight와 detached launcher는 동일한 sealed profile resolver를 사용합니다. 따라서 `MOMO_SHADOW_CANDIDATE_PROFILE=loss_cap`을 지정하면 두 명령 모두 `.paper-momentum-shadow-fixed-hold-2d-loss-cap-v1`, fixed `48h`, next-open, cost `0.3%`, 완료 일봉 종가 손실 상한 `4%`를 검사합니다. `loss_cap_no_doge`는 같은 계약에서 DOGE만 제외한 별도 target `.paper-momentum-shadow-fixed-hold-2d-loss-cap-no-doge-v1`이며, 400/800일 historical study가 각각 `+4.6566%/+9.2981%`, PF `1.84/1.66`, MDD `1.32%/1.82%`, blockers 없음으로 `SHADOW_CANDIDATE`가 된 후보입니다. 두 profile 모두 실전 승격값이 아니라 다음 single-owner paper shadow를 위한 연구 가설입니다. 4%는 새로 받은 400/800일·cost `0.3%` sweep에서 두 window의 MDD를 낮춘 risk-first 연구 가설이며, 실전 승격값이 아닙니다. profile을 생략하면 baseline이므로, 후보를 시작하기 전에 실제 시작할 profile을 붙인 preflight 결과의 `candidateProfile`, `candidateConfig`, `targetDir`, `blockers`를 확인해야 합니다. 이 profile은 paper research owner만 대상으로 하며 실전 주문·승격을 의미하지 않습니다.

candidate preflight는 이제 살아 있는 momentum-shadow owner가 하나라도 있으면 `existing_live_owner_count:N` blocker를 반환합니다. 기존 owner가 config drift 상태이거나 benchmark gate가 아직 닫힌 경우에도 새 후보를 병렬 실행하지 않습니다. 이전에는 이 상태가 warning에만 남아 benchmark gate가 나중에 열릴 때 evidence와 public API budget을 오염시킬 수 있었으므로, single-owner research contract를 launch gate 자체에 연결했습니다. 이 변경은 기존 owner를 종료하거나 ledger를 수정하지 않으며 read-only preflight와 새 후보 시작에만 적용됩니다.

DOGE 제외 후보의 trailing-window 재현도 별도 report로 보존합니다. 120일은 `26 trades`로 표본 부족이고, 180~800일은 모두 `POSITIVE_OBSERVATION`(`42/53/66/77/88/118/141/213 trades`)이었으며 rolling boundary unknown은 `0`건입니다. 이 결과는 후보 일관성을 높이는 historical evidence지만 `promoted=false`이며 실제 fill·wallet settlement를 대체하지 않습니다. report는 `/private/tmp/coinpilot-daily-momentum-rolling-loss-cap-no-doge-20260918.json`입니다.

동일 후보의 비용 stress도 `0.4/0.5/1.2%`에서는 각각 `+9.05/+8.07/+1.35%`로 양수 관측을 유지했지만, `1.5%`부터 `HOLD`(`-1.59%`)로 전환되었습니다. 이는 후보의 비용 민감도 경계이지 실전 총비용을 보증하는 결과가 아니며, 실제 spread·fill·borrow·wallet settlement를 포함하지 않습니다. 재현 report는 `/private/tmp/coinpilot-daily-momentum-robustness-loss-cap-no-doge-cost0p4-20260918.json`부터 `cost2p0`까지입니다.

`/api/momentum-shadow`와 웹·모바일·PWA의 readiness variant에도 `fixed_2d_loss_cap_no_doge`를 별도 표시합니다. UI는 11개 시장·DOGE 제외·historical `SHADOW_CANDIDATE` 근거와 현재 `existing_live_owner_count`/benchmark blocker를 함께 보여주지만, readiness 표시는 실행 권한이나 수익성 승인을 의미하지 않습니다.

실전 준비 현황의 `증거 저장`은 현재 `/api/momentum-shadow` read-only projection을 `coinpilot.momentum-shadow.evidence.v1` JSON으로 브라우저 로컬에 저장합니다. snapshot에는 `researchOnly=true`, `promoted=false`, 실제 fill·wallet settlement·live profitability를 증명하지 않는다는 note를 함께 기록하며, raw ledger 경로·API key·주문 실행 권한은 포함하지 않습니다. 이 파일은 시점별 paper 판단을 보관하는 evidence artifact이지 실전 수익 보고서가 아닙니다.
저장한 snapshot은 기본 경로 `/private/tmp/coinpilot-momentum-shadow-evidence-current.json`에 두면 인자 없이 `research:momentum-shadow:verify-evidence`로 다시 검사할 수 있습니다. verifier는 미래 timestamp, schema/provenance 변조, `researchOnly/promoted` 경계 위반, 내부 경로·owner PID·민감 필드를 fail-closed로 판정하고 파일 SHA-256과 book/heartbeat 요약을 출력합니다. `valid`는 파일 구조·provenance 무결성이고 `fresh`는 기본 900초 이내이며 export 시점 heartbeat도 검증 가능한지의 별도 판정입니다. 구조적으로 valid여도 오래된 snapshot은 `fresh=false`로 표시되고 CLI는 별도 exit code `3`을 반환하므로, 오래된 paper 결과를 최신 상태로 사용하지 않습니다. 검증된 snapshot을 그대로 보관하되, 이 무결성·최신성 결과 역시 실제 체결·정산·수익성을 대신하지 않습니다.

기본 대시보드는 http://localhost:3000 에서 확인할 수 있습니다. `DASHBOARD_TLS_CERT_FILE`과 `DASHBOARD_TLS_KEY_FILE`을 함께 설정하면 시작 로그에 HTTPS 주소가 표시되고, LAN 모바일/PWA 접속은 그 HTTPS 주소를 사용해야 합니다.

### 대시보드 접근 보안

대시보드의 `/api/*`와 Socket.io 데이터 평면은 `DASHBOARD_TOKEN`으로 보호됩니다.

- `DASHBOARD_TOKEN`을 설정하면 모든 API 요청과 실시간 소켓 연결에 `Authorization: Bearer <token>`이 필요합니다. 브라우저는 첫 접속 시 표시되는 잠금 화면에 토큰을 한 번 입력하면 되고, 모바일을 포함해 이 기기의 localStorage에만 저장됩니다.
- 토큰이 없으면 대시보드는 `127.0.0.1`에만 바인딩되어 같은 LAN의 다른 기기에서 접속할 수 없습니다. 모바일에서 쓰려면 `.env`에 토큰을 설정한 뒤 재시작하세요.
- `DASHBOARD_HOST`로 바인드 주소를 명시할 수 있지만, 토큰 없이 비루프백 바인딩은 거부됩니다(의도적인 무보안 LAN 공개는 `DASHBOARD_ALLOW_INSECURE=true` opt-out이 필요합니다).
- LAN의 HTTP 주소는 token으로 보호된 모바일 웹 접속만 제공하며 PWA 설치·service worker에는 사용할 수 없습니다. 설치앱은 HTTPS 주소가 필요하고, 개발 환경에서는 `localhost`/`127.0.0.1`이 브라우저의 secure-context 예외로 허용됩니다. 조건이 맞지 않으면 화면에 `HTTPS 필요`가 표시됩니다.
- LAN에서 설치앱까지 사용하려면 `DASHBOARD_TLS_CERT_FILE`과 `DASHBOARD_TLS_KEY_FILE`을 모두 설정하세요. 두 파일이 모두 읽힐 때만 dashboard가 HTTPS listener로 시작하며, 한쪽만 설정되었거나 읽기 실패하면 HTTP로 몰래 전환하지 않고 시작을 중단합니다. 인증서가 모바일 기기에서 신뢰되지 않으면 HTTPS여도 PWA 설치가 되지 않으므로, 실제 기기에서 인증서 체인·secure context를 별도로 확인해야 합니다. private key는 Git에 넣지 않습니다.
- 브라우저 cross-origin 요청은 same-origin과 `DASHBOARD_CORS_ORIGINS` allowlist만 통과합니다.
- `/api/auth/login`은 IP당 연속 실패 시 일시 차단되는 rate limit이 적용됩니다.

프론트엔드/API smoke가 필요할 때는 `npm run dashboard:staging`을 사용하세요. 이 명령은 `DRY_RUN=true`를 강제하고 `.staging-runtime/<timestamp>/` 아래에 별도 `dry_portfolio.json`과 paper ledger를 생성하므로 사용자의 root `dry_portfolio.json`을 읽거나 수정하지 않습니다. 기본 staging 포트는 `3100`이며 `STAGING_PORT`와 `STAGING_TARGET_COINS`로 바꿀 수 있습니다. staging 분석 주기는 기본 `30초`(`STAGING_CHECK_INTERVAL_MS`로 변경 가능)이고, 스캘핑 분석 공백 guard 기본 `60초`와 정확히 겹치지 않도록 slack을 둡니다. 실제 주문·수익성·wallet settlement 증거가 아닙니다.

staging/대시보드 프로세스가 `SIGINT` 또는 `SIGTERM`으로 종료될 때도 활성 paper validation session을 먼저 terminalize합니다. 따라서 종료 후 격리 ledger는 `active=false`, `endedAt` 기록, `stopReason=stopped_cleanly`(미청산·연속성 실패 등 별도 사유가 있으면 해당 stop reason)가 되며, observer가 단순히 active orphan session으로 오인하지 않습니다. OS 강제 종료처럼 프로세스가 실행되지 않는 경우에는 기존 owner PID·heartbeat orphan guard가 계속 적용됩니다.

2026-09-17 실제 Chromium `390x844` viewport smoke에서 redesigned fixed mobile nav가 `데이터 상태` 카드와 `28.47px` 겹치는 문제를 재현했습니다. 모바일 nav를 제거하거나 flow를 바꾸지 않고 2줄·10개 메뉴 구조를 유지한 compact sizing으로 수정한 뒤 nav/card overlap `0px`, document horizontal overflow `false`, 최하단 footer와 nav overlap 없음까지 DOM rectangle으로 readback했습니다. 같은 staging smoke에서 기존 기본 분석 주기 `60초`와 analysis fail-closed budget `60초`가 scheduler jitter `60.2초`에서 `analysis_data_gap`을 일으키는 문제도 확인해 staging 기본 주기를 `30초`로 분리했습니다. 이 UI·staging 운영 evidence는 실제 체결·수익성·standalone 설치를 증명하지 않습니다.

PWA 설치 상태는 secure context만으로 `설치 가능`을 표시하지 않습니다. redesigned shell은 service worker 지원 여부·등록 실패·`beforeinstallprompt` 수신을 분리해, 등록 전에는 `설치 확인 중`, 브라우저가 service worker를 지원하지 않거나 등록에 실패하면 `설치 지원 확인 필요`, prompt와 등록이 모두 준비되었을 때만 `설치 가능`으로 표시합니다. 2026-09-17T10:20 staging Chromium readback에서 최신 asset `observer-readonly-63`과 `앱으로 설치` 버튼을 확인했지만 실제 설치 확인창은 누르지 않았으므로 standalone 설치 완료 evidence로 해석하지 않습니다.

활성 paper validation 세션의 증거를 중간 설정 변경으로 오염시키지 않도록 설정 mutation도 서버에서 fail-closed 합니다. 세션이 active인 동안 `/api/config/update`, `/api/investment-config/update`, 프리셋 적용, 자동 최적화 toggle/interval/run-now는 모두 `409 paper_evidence_mutation_blocked`와 session id를 반환하고 runtime config를 변경하지 않습니다. 이미 켜진 최적화 scheduler가 세션 시작 뒤 실행되는 경우도 cycle 시작과 최종 hot-reload 양쪽에서 다시 차단합니다. redesigned web/mobile/PWA 설정 화면은 같은 상태를 읽어 설정·프리셋·자동 최적화 컨트롤을 disabled로 표시하지만 세션 중지 동작은 남겨 둡니다. 읽기 전용 observer는 별도의 `read_only_observer_mutation_blocked` 경계를 사용합니다. 이 보호는 수익성을 보장하지 않으며, 세션을 중지한 뒤 새 설정으로 별도 evidence window를 시작하게 하는 provenance guard입니다.

paper validation status도 이제 서버가 `promotionBlockers`를 계산해 API·web·mobile·PWA가 같은 보류 사유를 표시합니다. 활성 관찰 중, 최소 7일·20건 표본 미달, 95% 거래수익 하한 계산 불가/음수, 설정 drift, heartbeat·시세·분석 연속성 실패, 미청산 포지션, MDD·순수익 기준 미달을 producer에서 보존합니다. 활성 session은 지표가 잠시 좋아 보여도 `eligible=false`이며, 관찰을 중지하고 완결된 ledger를 확인하기 전에는 PASS로 표시하지 않습니다. UI는 이 blocker 목록을 `전환 보류 사유`로 표시하며, 이는 실전 주문 승인이나 수익성 보장이 아니라 다음 검증 단계의 결격 원인입니다.

실제로 실행 중인 forward paper 장부를 웹/모바일/PWA 화면에서 관찰하려면 별도 읽기 전용 서버를 사용하세요. 이 서버는 지정한 ledger의 최신 snapshot과 strict/shadow 검증 결과만 읽고, paper 세션 start/stop과 주문 경로를 차단합니다. 원본 runner와 다른 포트에서 실행해야 합니다.

read-only adapter는 validation snapshot의 canonical `emaPeriod`와 runtime/mock config의 legacy `emaLong` alias를 동일 값으로 맞춘 뒤 drift를 비교합니다. 이 매핑이 없으면 실제 forward runner와 값이 같아도 observer mock의 기본값 때문에 `emaPeriod` 설정 변경으로 잘못 표시될 수 있습니다. 현재 r2 ledger API readback은 `configSnapshotComplete=true`, `configConsistent=true`, `configDrift=[]`, `configValueDrift=[]`, `configSchemaDrift=[]`로 확인했습니다.

forward shadow owner는 터미널 세션과 독립적으로 계속 관찰되어야 하므로 `ops/launchd/`에 fixed·regime·benchmark용 macOS `launchd` KeepAlive plist를 보존합니다. 2026-09-16T16:13:01Z에 세 owner가 같은 시각 `SIGTERM`으로 외부 종료된 사건을 확인한 뒤, 포지션·거래가 없는 benchmark PID `23792`에 controlled SIGTERM을 보내 `runs=1→2`, 새 PID `24205`, `last exit code=0`, 동일 ledger contract 재기동을 검증했습니다. launchd 서비스는 runner의 research-only 경계를 바꾸지 않고, 기존 ledger·execution model·시장 목록을 이어받으며, API key·주문 권한을 전달하지 않습니다. quote evidence도 `com.coinpilot.momentum-shadow.quotes`가 10분마다 read-only 5-sample을 실행해 `.coinpilot-runtime/momentum-shadow/`에 보존하며, 15분 freshness 한도보다 5분의 scheduler/sleep slack을 둡니다. 상세 설치·readback 명령은 [ops/launchd/README.md](ops/launchd/README.md)에 있습니다. 이 KeepAlive/quote schedule 검증은 관찰 연속성 보완이지 실제 체결·wallet settlement·수익성 증명이 아닙니다.
launchd 재개 후 fixed/regime owner도 `2026-09-16T16:31:49Z`에 기존 ledger를 그대로 이어받아 실행됐고, fixed는 기존 ETH/NEAR 포지션을 `MAX_HOLD`로 정산해 청산 2건을 추가했습니다. 재개 후 fixed는 포지션 1개·청산 2건·평가수익률 약 `-3.01%`, regime는 포지션 1개·청산 4건·평가수익률 약 `-4.50%`였습니다. 이는 외부 종료 뒤 장부·포지션 상태가 보존된 운영 evidence이지 수익성이나 live 체결 evidence가 아닙니다.

```bash
PAPER_DASHBOARD_LEDGER_FILE=$PWD/.paper-forward-v49/paper_validation.json \
DASHBOARD_PORT=3152 \
npm run dashboard:paper
```

`npm run dashboard`는 UI smoke를 위한 결정론적 mock 화면이고, `npm run dashboard:staging`은 실제 entrypoint 기반의 격리 DRY_RUN 화면입니다. 둘을 실제 forward 수익성 장부와 혼동하지 마세요. `dashboard:paper`도 관찰 UI 증거일 뿐이며, 실거래·wallet settlement 증거는 아닙니다.

실제 주문 경계는 자동 `MultiCoinTrader` core(일반 주문·리밸런싱), legacy 단일 코인 `AutoTrader`, UI의 `/trade/buy`, `/trade/sell`, `/trade/smart-buy`, `/trade/smart-sell`, `/trade/quick`, `/trade/execute`, `/trade/execute-bundle` 경로에서 `live-execution-evidence.v1` append-only JSONL에 주문 접수·fill 관측을 남기도록 유지합니다. 모든 UI 경로는 공통 helper 한 곳을 통해서만 exchange order를 호출하고, 독립 `AutoTrader`도 같은 helper를 재사용합니다. `ORDER_SUBMITTED`는 체결이 아니며, `FILL_NOT_OBSERVED`가 명시될 때만 미체결로 집계합니다. `executed_volume`, `avg_price`, `paid_fee`, `remaining_volume`이 없는 상태에서 전략 포지션이나 손익을 예상값으로 확정하지 않고, evidence 저장 실패 뒤에는 다음 live 주문을 fail-closed합니다. 프로세스가 재시작될 때도 기존 evidence를 read-only 검사해 unresolved submission·incomplete fill·malformed record가 있으면 새 live 주문을 차단하며, settlement readback 미관측만으로 fill을 허위 실패 처리하지 않습니다. `execute-bundle`은 매도와 매수를 순차 실행하므로 한쪽만 체결되면 결과를 `success=false`로 반환하고 성공 이력에 기록하지 않습니다. wallet settlement는 계좌 readback이 별도로 기록될 때만 `observed`입니다. 읽기 전용 `/api/live-execution-evidence`와 실전 준비 화면의 증거 표면은 `available`, `observed/settlement_ready`, `historyNeedsReview`, 현재 프로세스의 `runtimeOrderGateBlocked`를 분리해 표시하며, 어느 상태도 실전 승인을 의미하지 않습니다. 현재 dry-run r2에서는 live 파일이 없으므로 `npm run research:live-execution-evidence`가 `available=false / evidence_file_not_found`를 출력합니다. 이 명령과 상태 API는 private API를 조회하거나 주문하지 않습니다.

대시보드는 PWA로도 동작합니다. redesign shell의 모드 경계에 있는 `앱으로 설치` 버튼 또는 모바일 브라우저의 “홈 화면에 추가”·데스크톱 브라우저의 “앱 설치”를 사용하면 standalone 설치앱으로 열 수 있습니다. Android/Chrome은 설치 이벤트를 사용하고, iOS Safari처럼 설치 이벤트가 없는 환경은 화면의 `설치 안내`에서 `공유 → 홈 화면에 추가` 경로를 안내합니다. service worker가 새 shell을 감지하면 `새 버전이 준비되었습니다` banner를 표시하고, 사용자가 확인한 뒤 대기 worker에 `SKIP_WAITING`을 보낸 후 `controllerchange`를 확인해 reload하므로 구 shell을 다시 읽는 race와 입력 중 자동 화면 손실을 줄입니다. 설치앱에서도 계좌·시세·거래 데이터는 서버 API를 기준으로 읽으며, 오프라인 캐시는 화면 껍데기만 제공합니다. 연결이 끊기면 이미 메모리에 있던 동적 계좌·시세·거래·수익 상태를 비우고 `오프라인 모드`와 주문/설정 잠금을 표시하며, online 복귀 뒤 API를 다시 읽습니다. 오프라인 shell은 오래된 금융 상태를 표시하지 않습니다.
설치 식별자는 `/?source=pwa`로 고정하고, Chrome 설치 manifest에는 실제 브라우저에서 검증된 PNG 아이콘만 사용합니다. `/icon.svg`는 favicon과 shell asset으로는 계속 보존하지만 manifest 설치 아이콘으로는 사용하지 않아 브라우저별 SVG parser 차이로 설치 아이콘이 누락되지 않게 했습니다. Chrome DevTools의 `screenshots` 미설정 경고는 설치를 막는 오류가 아니라 풍부한 설치 미리보기 UI가 제한된다는 선택적 안내이며, 실제 설치 버튼·standalone display·stable App ID·service worker 등록은 staging runtime에서 확인합니다.

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

환경변수 drift 없이 고정된 4시장 `rsi_rebound` forward 관찰을 반복하려면 `ops/run-sealed-forward-rsi.sh [output-dir]`를 사용합니다. 이 script는 `PAPER_FORWARD_MODE=true`, `DRY_RUN` config, BTC/ETH/XRP/SOL universe, candle/freshness·risk·손익 파라미터를 모두 명시하고 매 실행을 별도 output directory에 기록합니다. 이전 session이 `analysis_data_gap` 또는 미청산 diagnostic position으로 종료되면 같은 directory를 재사용하지 말고 새 output directory를 지정해야 하며, 결과는 여전히 최소 7일·20 trades와 수익성 evidence gate를 통과하기 전까지 진단 전용입니다.

현재 r2 owner가 완결된 뒤 strict-only sealed session을 같은 계약으로 시작하려면, 반드시 새 output directory와 함께 다음처럼 실행합니다. 기본값은 `false`라 기존 sealed forward는 relaxed diagnostic sidecar를 계속 보존합니다.

```bash
COINPILOT_SEALED_FORWARD_STRICT_ONLY=true \
ops/run-sealed-forward-rsi.sh .paper-forward-sealed-rsi-strict-only-r1
```

이 명령도 기존 paper owner가 살아 있으면 동시 실행 guard에서 거부됩니다. strict-only ledger가 완결되기 전에는 `research:paper:cohort`의 수익성 evidence나 실전 전환 후보로 간주하지 않습니다.

실제 실행 전에 owner·output directory·기존 ledger를 변경하지 않고 시작 가능 여부만 확인하려면 다음 read-only preflight를 사용합니다. 현재 r2 owner가 살아 있으면 exit code `2`와 `paper_owner_active` blocker를 반환합니다.

```bash
npm run research:paper:strict-only-preflight -- .paper-forward-sealed-rsi-strict-only-r1
```

각 runtime·shadow 포지션은 관찰된 최고가/최저가를 기준으로 MFE(max favorable excursion)와 MAE(max adverse excursion)를 기록합니다. 이 값은 현재 stop/take 동작을 변경하지 않으며, 청산 전에 충분히 수익권에 도달했는지와 보호 출구가 필요한 손실 경로였는지를 구분하는 exit 튜닝용 진단 데이터입니다. 구버전 ledger에는 값이 없을 수 있고, 그 거래는 MFE/MAE를 `null`로 표시합니다.

read-only forward paper observer의 비교 A/B 카드도 이제 미청산 diagnostic position의 시장·진입가·MFE·MAE를 `미청산 · 실현손익 제외`로 표시합니다. 현재 mark가 없는 장부는 평가손익을 새로 계산하거나 realized P&L에 섞지 않고, 미청산 position이 있다는 사실과 excursion 경로만 보여 줍니다. 따라서 웹·모바일·PWA 화면에서 shadow 참고손익과 아직 확정되지 않은 평가 상태를 구분해 읽을 수 있습니다.

동일 카드의 `주요 거절 결과`는 청산된 diagnostic trade가 어떤 strict guard를 통과하지 못했는지와 그 rejection cohort의 거래 수·누적손익·PF를 함께 표시합니다. 이는 자동 완화 추천이나 runtime 변경이 아니라, 예를 들어 `volume_confirmation_failed` 후보가 비용 후 손실인지 확인하는 read-only tuning evidence입니다.

런너가 처리할 수 있는 오류(`uncaughtException`, `unhandledRejection`, top-level failure)는 ledger의 `terminalError`/`lastError`에 원인과 시각을 기록하고 가능한 경우 `STOPPED` 전환과 lock 해제를 수행합니다. OS 강제 종료처럼 잡을 수 없는 종료는 dashboard가 저장된 owner PID와 heartbeat를 기준으로 즉시 orphan/보류 처리하며, 다음 명시적인 forward 재실행은 기존 증거 창을 보존한 채 interruption을 추가합니다. `terminalError`가 남은 세션은 원인 확인 후에도 자동으로 live 승격되지 않습니다.

Forward 상태의 `lossCircuitBreaker`는 현재 손실 횟수, 차단 여부, 남은 차단 시간과 설정값을 보여줍니다. 회로차단기가 진입을 막은 횟수는 telemetry에 별도로 기록되며, strict 실현손익이나 live 승격 조건을 우회하지 않습니다.

새 forward 세션은 strategy mode, 시장 목록, RSI/반등/거래량/추세/변동폭 필터, 손절·익절·보유시간, 수수료·슬리피지, 투자비율과 포지션 제한을 `configSnapshot`으로 함께 저장합니다. 이후 재실행 시 설정이 달라지면 기존 세션에 조용히 섞지 않고 drift로 표시하며 승격을 보류합니다. snapshot이 없는 구버전 ledger는 복구할 수 있지만 전체 구간 재현성이 확인되지 않은 상태로 취급합니다.

읽기 전용 paper dashboard/API는 `configConsistent=false`인 이유를 `configValueDrift`(양쪽 snapshot에 모두 있지만 값이 다른 항목)와 `configSchemaDrift`(구버전 snapshot에 없거나 현재 source에서 사라진 항목)으로 나눠 표시합니다. schema 차이는 실제 runtime 값 변경을 의미하지 않을 수 있지만, 새 source로의 자동 재개·실전 승격은 여전히 보류합니다. 이 구분은 경고의 정확도를 높일 뿐 검증 gate를 완화하지 않습니다.

장기 실행 로그는 기본적으로 compact 모드이며 60초마다 cycle·strict BUY·shadow·거래 수·자산만 출력합니다. 상세 cycle 로그가 필요하면 `PAPER_FORWARD_VERBOSE=true npm run paper:forward`를 사용합니다.

기본 forward는 strict 결과와 relaxed `shadow`/`looseShadow` 결과를 한 세션에서 함께 수집해 필터 진단을 돕습니다. strict 손익만을 live-quality efficacy cohort로 평가할 별도 세션이 필요하면, 기존 owner가 종료되고 ledger가 완결된 뒤 동시 실행 없이 다음처럼 `SCALP_PAPER_DIAGNOSTIC_SHADOWS_ENABLED=false`를 명시하세요.

```bash
SCALP_PAPER_DIAGNOSTIC_SHADOWS_ENABLED=false \
PAPER_SMOKE_MARKETS=KRW-BTC,KRW-ETH,KRW-XRP,KRW-SOL \
PAPER_SMOKE_OUTPUT_DIR=.paper-forward-strict-only-r1 \
npm run paper:forward
```

이 설정은 strict 거래·자산·주문 계약을 바꾸지 않고 relaxed sidecar만 수집하지 않습니다. 설정은 `paperExperiments.diagnosticShadows`에 저장되며, 재시작 시 drift가 나면 같은 세션에 섞지 않고 fail-closed합니다. `research:paper:cohort`는 strict-only 세션에서만 diagnostic trade/open-position 제외 조건을 통과시킬 수 있고, 그래도 최소 관찰일·청산 표본·95% 거래수익 하한·연속성·drawdown gate를 모두 충족하기 전에는 승격하지 않습니다. 현재 실행 중인 r2 owner에는 이 값을 바꾸지 마세요.

이전 forward 원장에서 데이터 품질이 좋은 시장만 별도 코호트로 재현하려면 `PAPER_SMOKE_MARKETS=FRESH_FROM_LEDGER PAPER_SMOKE_FRESHNESS_LEDGER=.paper-forward-v44/paper_validation.json npm run paper:forward`처럼 실행할 수 있습니다. 기본 최소 관측 수는 100회, freshness 차단률 상한은 5%이며 `PAPER_SMOKE_MIN_FRESHNESS_OBSERVATIONS`, `PAPER_SMOKE_MAX_STALE_RATE`, `PAPER_SMOKE_MAX_MARKETS`로 실험 범위를 지정합니다. 표본 부족·차단률 초과 시장은 fail-closed로 제외하고, 선택된 시장의 원래 순서는 유지합니다. 이는 이전 ledger 기반의 진단 코호트 선택일 뿐 기본 전략·실거래 universe·live gate를 바꾸지 않습니다.

기존 `.paper-forward-*` 원장들의 전체 상태를 비교하려면 `research:paper:cohort`를 사용합니다. 이 report는 strict trade와 diagnostic trade, config fingerprint, stop reason, 표본 수와 손익을 분리해 보존하며 서로 다른 config·market universe·기간의 결과를 하나의 promotion 또는 실전 수익성 표본으로 합산하지 않습니다. `eligibleStrict*`는 config·종료·미청산·연속성만 통과한 무결성 cohort이고, 실제 수익성 표본은 각 ledger의 `thresholds.minDays`/`thresholds.minTrades`까지 충족한 `profitabilityEvidence*` cohort입니다. config가 둘 이상이면 구성별 `*ConfigGroups`만 제공하고 손익 합계는 `null`로 둡니다. 기본 출력은 `/private/tmp/coinpilot-paper-forward-cohort.json`이며 `PAPER_COHORT_ROOT`와 `PAPER_COHORT_OUTPUT_FILE`로 별도 root/output을 지정할 수 있습니다.
config fingerprint는 object key 순서를 정규화한 canonical serialization으로 계산하며, `active=true` ledger는 `session_still_active`로 fail-closed합니다. 따라서 단순히 `endedAt`이 기록되었거나 JSON key 순서가 다른 것만으로 종료·동일 config evidence로 인정하지 않습니다.

2026-09-18 최신 archive cohort readback은 runtime ledger shape 보정 전 전체 `88` session·strict trade `39`건·diagnostic trade `0`건으로 잘못 집계됐던 결과를 교정해, 현재 `90` session·strict trade `43`건·diagnostic trade `778`건으로 집계합니다. 실제 `shadow.closedTrades`/`shadow.positions`와 `looseShadow.closedTrades`/`looseShadow.positions`를 읽으며, config·종료·미청산·continuity·diagnostic 조건을 모두 통과한 무결성 cohort는 `0` session입니다. 현재 active r2는 strict `4`건·diagnostic `35`건이지만 `session_still_active`로 제외됩니다. 따라서 실제 수익성 evidence cohort도 `0` session·`0` trades·`0` config이고, 이전에 표시되던 `-307.82 KRW`는 잘못된 diagnostic 필드 매핑과 heterogeneous config를 함께 포함한 진단 합계로 폐기합니다. API/CLI/UI는 계속 `수익성 표본 미충족 · 최소 관찰/거래 조건`과 diagnostic-only 경계를 표시합니다. 재현 report는 `/private/tmp/coinpilot-paper-forward-cohort-current-20260918-r2.json`입니다.

같은 최신 readback의 strict 제외 사유는 `config_snapshot_incomplete 7`, `no_strict_trades 62`, `session_still_active 1`, `diagnostic_trades_present 17`, `session_not_ended 3`입니다. 수익성 evidence gate는 현재 90개 session에서 무결성 strict cohort `0`개이며, active session·미종료 session·config 불완전·strict 표본 없음·diagnostic trade 존재가 모두 남아 있습니다. 이 숫자는 전략 손익을 합산한 결과가 아니라 “현재 archive에 live-quality strict profitability sample이 없다”는 데이터 품질 판정입니다.

2026-09-17T10:09:27Z부터 별도 sealed forward owner `.paper-forward-sealed-rsi-20260917`를 시작했습니다. 시장은 `KRW-BTC,KRW-ETH,KRW-XRP,KRW-SOL`로 고정하고, `rsi_rebound`·1분봉 120개·자동 freshness 90초·손절 `1.2%`·익절 `1.8%`·최소 관찰 `7일`·최소 거래 `20건`을 환경변수로 명시해 config snapshot을 저장합니다. 첫 5 cycle readback은 `configSnapshotComplete=true`, expected/analyzed market `4/4`, incomplete analysis `0`, missing market `0`, continuity eligible이며 strict/shadow 거래 `0건`입니다. 이는 수익성 양성·음성 증거가 아니라 표본 수집이 정상 시작됐다는 운영 evidence이며, 종료 전에는 cohort 손익에 포함하지 않습니다.

이 sealed r1은 `2026-09-17T10:25:30Z`에 Upbit DNS `ENOTFOUND`로 `analysis_data_gap` fail-closed 종료됐습니다. strict 거래 `0`, shadow 청산 `0`, XRP diagnostic position 미청산 상태였으므로 손익을 정산하지 않고 `endedWithDiagnosticOpenPositions=true`로 보류했습니다. 네트워크 회복 후 같은 config를 별도 `.paper-forward-sealed-rsi-20260917-r2` output으로 다시 시작했으며, r2 초기 3 cycle은 `4/4` market 분석·incomplete `0`·risk continuity 정상·거래 `0`입니다. r1/r2는 서로 다른 session으로 유지하고 결과를 합산하지 않습니다.

r2는 2026-09-17T13:21:29Z~13:22:30Z에 첫 세 shadow positions를 `MAX_HOLD_TIME`으로 청산했습니다. XRP `-1,042.26 KRW`/`-0.5211%`, BTC `-815.99 KRW`/`-0.4080%`, SOL `-886.68 KRW`/`-0.4433%`로 합계 `-2,744.94 KRW`, 승률 `0/3`이었습니다. 세 거래 모두 `volume_confirmation_failed`를 포함했고, XRP/SOL 두 거래는 `price_rebound_below_threshold`도 포함했습니다. 모두 비용·슬리피지를 반영한 shadow realized outcome이지만 strict trade가 아니며, 표본 3건만으로 전체 전략을 판정하지 않습니다. 다만 이 forward evidence에서는 volume/rebound 완화가 수익 개선이라는 근거가 없으므로 해당 guard를 유지하고 runtime 기본값을 변경하지 않습니다. r2는 BTC/SOL 이후 구간과 다른 후속 cycle을 계속 관찰합니다.

2026-09-17T14:01:10Z r2에서 네 번째 shadow/loose-shadow 청산으로 ETH가 `MAX_HOLD_TIME`에 도달했습니다. 비용·슬리피지 후 net `-9.73 KRW`/`-0.0049%`, MFE `+0.3431%`, MAE `-0.8972%`였고 rejection은 `price_rebound_below_threshold`였습니다. 큰 손실 cohort는 아니지만 strict가 거절한 후보가 손익분기보다 약간 낮게 끝난 사례이므로 `minReboundPercent=0.15`를 완화할 근거로 사용하지 않습니다. shadow 합계는 `4 trades`/`-2,754.67 KRW`, loose 합계는 `4 trades`/`-2,610.90 KRW`가 되었고, strict trades는 여전히 `0`입니다. 이 결과 역시 diagnostic-only로 보존합니다.

2026-09-17T14:11:24Z r2에서 첫 strict 청산이 발생했습니다. XRP가 현재 고정 계약(`minReboundPercent=0.15`, `minVolumeRatio=1`, previous-high-break 유지)으로 30분 최대 보유시간 청산되었고, 비용 후 strict realized profit은 `+1,366.28 KRW`/`+0.6835%`, MFE `+0.7839%`, MAE `-0.0560%`였습니다. 이 거래는 strict 양성 evidence이지만 표본이 `1/20`건이고 세션이 아직 active라 수익성 cohort·live promotion 근거로 승격하지 않습니다. 현재 strict aggregate는 `1 trade`/`+1,366.28 KRW`인 반면 integrity eligible strict cohort는 계속 `0 session`이고, 기존 shadow/loose 손실 evidence와 섞어 전략 전체를 판정하지 않습니다.

2026-09-17T14:12:28Z r2에서 두 번째 strict 청산으로 SOL이 같은 고정 계약에서 `MAX_HOLD_TIME` 청산됐습니다. 비용 후 strict realized profit은 `+2,266.74 KRW`/`+1.1340%`, MFE `+1.2346%`, MAE `-0.0726%`였습니다. 현재 strict aggregate는 `2 trades`/`+3,633.03 KRW`/수익률 합 `+1.8174%`로 양수지만, 최소 `20 trades` 중 2건이고 세션이 active이므로 통계·수익성 evidence cohort에는 아직 포함되지 않습니다. 같은 시간대의 shadow/loose 결과는 동일 signal을 공유할 수 있는 diagnostic 장부이므로 strict 양성 결과와 독립 표본으로 합산하지 않습니다.

2026-09-17T15:34:10Z r2에서 세 번째 strict 청산으로 XRP가 같은 고정 계약에서 `MAX_HOLD_TIME` 청산됐습니다. 비용 후 strict realized profit은 `+134.45 KRW`/`+0.0672%`, MFE `+0.2231%`, MAE `-0.2789%`였고 signal rebound `0.1676%`, volume ratio `3.0904`, close strength `0.80`, entry delay `2,988ms`였습니다. strict aggregate는 `3 trades`/`3승 0패`/`+3,767.47 KRW`로 양수지만 최소 `20 trades` 중 3건이고 비용 후 여유가 얇아 수익성 evidence cohort·live promotion으로 승격하지 않습니다. 이 거래는 strict guard를 통과한 positive evidence로 보존하되, 현재 runtime 값이나 max-hold 계약을 변경할 근거로 사용하지 않습니다.

같은 XRP signal `2026-09-17T15:03:00Z`에서 strict와 shadow의 realized outcome이 갈렸다. strict는 `2,988ms` 확인 지연 뒤 `1,793`에 진입해 `1,796`에 청산하며 `+134.45 KRW`/`+0.0672%`였지만, shadow는 지연 없이 `1,792.791`에 모델 진입하고 `executionDrift=-0.1115%`를 기록한 뒤 `1,794.204`에 청산해 `-42.48 KRW`/`-0.0212%`가 되었다. signal 지표와 MFE/MAE는 같은 window에서 유사했지만 entry timing·실행 drift·exit 가격·비용이 결과의 부호를 바꾼 사례다. 따라서 signal 양성만으로 실수익을 주장하지 않고 execution-boundary evidence를 별도 유지한다. shadow aggregate는 이 청산 후 `8 trades`/`2승 6패`/`-1,812.20 KRW`, 미청산 2건이며 runtime·strict 계약은 변경하지 않는다.

2026-09-17T15:47:30Z에 r2의 당시 미청산 diagnostic 포지션이 모두 청산되어 shadow/loose 장부의 10거래 구간이 완결되었습니다. shadow SOL은 rebound `0.2888%`였지만 volume ratio `0.5661`로 거래량 guard에 막힌 후보였고 비용 후 `+119.15 KRW`/`+0.0596%`, MFE `+0.5479%`, MAE `-0.4598%`였습니다. loose XRP는 rebound `0.1119%`, volume ratio `0.4626`, previous-high-break 미통과였지만 비용 후 `+626.22 KRW`/`+0.3131%`, MFE `+0.7931%`, MAE `-0.0999%`였습니다. relaxed 후보에는 이처럼 양수 사례도 있지만 최종 aggregate는 shadow `10 trades`/`4승 6패`/`-1,053.69 KRW`, loose `10 trades`/`3승 7패`/`-2,367.38 KRW`로 여전히 음수입니다. 따라서 이 구간은 execution·guard 완화의 혼합 diagnostic evidence로만 보존하고, active session의 `endedAt`·독립 config·최소 표본 gate가 충족되기 전에는 promotion이나 runtime 완화를 하지 않습니다.

2026-09-17T15:16:17Z r2에서 일곱 번째 shadow/loose-shadow 청산으로 BTC가 `MAX_HOLD_TIME`에 도달했습니다. 이 후보는 signal rebound `0.1081%`와 volume ratio `0.6956`으로 strict의 `minReboundPercent=0.15` 및 `minVolumeRatio=1.0`을 모두 통과하지 못했고, 비용 후 `-1,167.47 KRW`/`-0.5837%`, MFE `-0.0479%`, MAE `-0.4906%`로 종료됐습니다. rejection은 `price_rebound_below_threshold`와 `volume_confirmation_failed`였습니다. shadow aggregate는 `7 trades`/`2승 5패`/`-1,769.72 KRW`, loose aggregate는 `7 trades`/`-1,625.96 KRW`가 되었지만 현재 세션은 active이고 두 장부 모두 미청산 포지션이 남아 있으므로 promotion evidence가 아닙니다. 이번 결과는 반등·거래량 guard를 완화하면 안 된다는 forward evidence를 강화하며, runtime 기본값과 strict 계약은 변경하지 않습니다.

2026-09-17T15:33:06Z loose shadow에서 ETH와 SOL이 같은 `15:02` signal window의 `MAX_HOLD_TIME` 청산에 도달했습니다. ETH는 비용 후 `-481.37 KRW`/`-0.2407%`, SOL은 `-886.27 KRW`/`-0.4431%`였고, 두 거래 모두 `price_rebound_below_threshold`와 `previous_high_break_failed`를 포함했습니다. 두 거래의 volume ratio는 각각 `1.0935`와 `3.7224`로 거래량 기준은 통과했으므로, 이 결과는 volume guard보다 rebound 하한과 previous-high-break guard를 완화할 때의 손실 위험을 별도로 보여 줍니다. loose aggregate는 `9 trades`/`2승 7패`/`-2,993.60 KRW`, 미청산 1건이 되었으며, 이 장부는 계속 diagnostic-only로 유지합니다. `minReboundPercent=0.15`와 previous-high-break 요구는 변경하지 않습니다.

같은 후속 구간에서 shadow ETH는 `15:06` signal의 relaxed 후보로 `MAX_HOLD_TIME` 청산됐지만 비용 후 `+639.36 KRW`/`+0.3197%`로 끝났습니다. 이 거래도 rebound `0.1184%`와 previous-high-break 미통과가 있었지만 volume ratio `1.5519`, MFE `+0.5206%`, MAE `-0.1885%`, execution drift `-0.0591%`였습니다. 따라서 완화 후보가 항상 손실인 것은 아니며, 현재 forward evidence는 `rebound/high-break relaxed cohort`가 양·음 결과가 섞인 상태임을 보여 줍니다. 그러나 shadow aggregate는 이 거래 후에도 `9 trades`/`3승 6패`/`-1,172.84 KRW`, 미청산 1건으로 음수이므로 strict guard를 완화하거나 promotion하는 근거로 사용하지 않습니다. 이 결과는 후보를 완전히 폐기하지 않고 diagnostic-only로 더 관찰해야 한다는 의미이며, runtime 기본값은 유지합니다.

2026-09-17T13:21:29Z r2에서 첫 relaxed shadow 청산이 발생했습니다. XRP는 `MAX_HOLD_TIME`으로 비용 후 `-1,042.26 KRW`/`-0.5211%`, loose shadow는 XRP와 SOL을 합쳐 `-1,785.18 KRW`/2 trades를 기록했습니다. 세 closed diagnostic trade 모두 `volume_confirmation_failed`를 포함했고, XRP/SOL은 `price_rebound_below_threshold`, SOL loose는 `previous_high_break_failed`도 포함했습니다. strict trades는 `0`이며 BTC와 SOL의 shadow position은 아직 미청산입니다. 이는 volume·rebound·high-break 완화가 실제 비용 후 개선을 보장하지 않고 오히려 손실 후보를 만들 수 있다는 첫 forward evidence이므로 해당 필터를 완화하지 않고, r2 종료 후 diagnostic-only cohort로 보존합니다.

2026-09-17T18:21:03Z r2에서 loose-shadow의 ETH 포지션이 `MAX_HOLD_TIME`으로 청산됐습니다. signal rebound `0.0884%`, volume ratio `0.0081`로 strict의 반등·거래량 조건을 크게 밑돌았고, rejection은 `price_rebound_below_threshold`와 `volume_confirmation_failed`였습니다. 비용 후 loose net `-540.47 KRW`/`-0.2702%`, MFE `-0.0705%`, MAE `-0.2763%`였으며, loose aggregate는 `12 trades`/`-2,685.21 KRW`가 되었습니다. 이 사례는 relaxed 후보를 받아들이면 즉시 손실로 이어질 수 있음을 보여 주므로 두 guard를 유지하는 근거로 기록합니다. strict는 여전히 `4 trades`/`+4,715.38 KRW`에 불과하고 세션이 active이므로 두 장부를 합산하지 않으며 runtime·promotion gate도 변경하지 않습니다. loose에는 XRP 미청산 포지션 1개가 남아 있어 해당 손익은 실현손익에 포함하지 않습니다.

2026-09-17T18:24:06Z r2에서 loose-shadow의 XRP 포지션도 `MAX_HOLD_TIME`으로 청산되어 diagnostic 장부의 당시 미청산 상태가 모두 해소되었습니다. signal rebound `0.0557%`, previous-high-break 미통과였고 volume ratio `1.9680`은 거래량 기준만 통과했지만, 비용 후 loose net `-821.20 KRW`/`-0.4106%`, MFE `-0.0443%`, MAE `-0.2668%`로 종료됐습니다. loose aggregate는 `13 trades`/`-3,506.41 KRW`가 되었고 rejection별로 `price_rebound_below_threshold`는 `10회`/`-4,842.83 KRW`, `previous_high_break_failed`는 `6회`/`-2,082.90 KRW`로 누적되었습니다. 이는 rebound 하한과 previous-high-break guard를 relaxed 후보에 개방하면 손실 cohort가 커질 수 있다는 추가 forward evidence이며, runtime·strict 계약·promotion gate를 변경하지 않습니다.

2026-09-17T19:11:27Z r2에서 `18:40` signal window의 diagnostic 포지션이 모두 `MAX_HOLD_TIME`으로 청산되었습니다. shadow SOL은 비용 후 `-1,028.28 KRW`/`-0.5141%`, loose BTC는 `-517.99 KRW`/`-0.2590%`, loose ETH는 `-834.57 KRW`/`-0.4173%`, loose XRP는 `-1,044.74 KRW`/`-0.5224%`였습니다. 이 네 거래로 shadow aggregate는 `12 trades`/`-1,859.33 KRW`, loose aggregate는 `16 trades`/`-5,903.71 KRW`까지 악화되었고, 당시 diagnostic 미청산 포지션은 모두 해소되었습니다. signal rebound는 `0.0557~0.1438%`, volume ratio는 `0.0060~0.8117` 또는 XRP `0.6795`, ETH에는 previous-high-break 실패가 포함되었습니다. strict aggregate는 여전히 `4 trades`/`+4,715.38 KRW`뿐이므로 diagnostic 손실과 합산하지 않으며, relaxed guard 완화·runtime 변경·promotion을 허용하지 않습니다.

2026-09-17T23:29:27Z r2의 새 loose BTC diagnostic이 `MAX_HOLD_TIME`으로 청산되었습니다. signal rebound `0.0975%`와 volume ratio `0.3817`이 strict 하한에 미달했고, 비용 후 net `-296.25 KRW`/`-0.1481%`, MFE `+0.1353%`, MAE `-0.0999%`, execution drift `-0.0028%`였습니다. 이 청산으로 loose는 `21 trades`/`5승 16패`/`-8,499.80 KRW`가 되었고 미청산 diagnostic은 `0`건입니다. rejection cohort는 `price_rebound_below_threshold` `18건`/`3승 15패`/`-9,836.22 KRW`, `volume_confirmation_failed` `13건`/`3승 10패`/`-5,900.45 KRW`로 누적되었으며, strict는 `4 trades`/`+4,715.38 KRW`로 변하지 않았습니다. 이는 반등·거래량 guard 완화가 비용 후 손실 cohort를 늘린다는 추가 forward evidence이므로 runtime·forward 계약·promotion gate를 변경하지 않고, UI의 `완화 금지` 안내와 diagnostic 분리를 유지합니다.

r2의 exit path를 별도 read-only analyzer로 집계하면 strict는 `MAX_HOLD_TIME` `4건`/`+4,715.38 KRW`, shadow는 `MAX_HOLD_TIME` `14건`/`-2,992.04 KRW`, loose는 `MAX_HOLD_TIME` `21건`/`-8,499.80 KRW`로 모두 동일한 종료 경로였습니다. 이 결과는 현재 r2에서 stop/take가 발동하지 않았다는 사실과 relaxed 손실의 종료 경로를 보여 주지만, 더 이른 청산 가격이나 새로운 stop/take 결과를 추정하지 않습니다. 따라서 max-hold 대체값을 즉시 적용하지 않고, `npm run research:paper:exit-evidence .paper-forward-sealed-rsi-20260917-r2 /private/tmp/coinpilot-paper-exit-evidence-r2.json`으로 같은 원장을 재분석할 수 있게 보존합니다. 이 report도 research-only이며 runtime·promotion·실제 fill·wallet settlement와 무관합니다.

후보 비교 study는 `SCALP_VARIANT_MARKETS`, `SCALP_VARIANT_NAMES`, `SCALP_VARIANT_CANDLE_COUNT`, `SCALP_VARIANT_CANDLES_FILE`, `SCALP_VARIANT_CANDLES_OUTPUT_FILE`, `SCALP_VARIANT_OUTPUT_FILE`을 선택적으로 지정할 수 있습니다. `SCALP_VARIANT_CANDLES_FILE`에 `{ "KRW-BTC": [...] }` 형태의 candle cache를 주면 네트워크 재수집 없이 동일한 윈도우를 재사용할 수 있고, `SCALP_VARIANT_CANDLES_OUTPUT_FILE`로 이번 study가 실제 사용한 raw window를 저장할 수 있어 threshold·exit 후보를 같은 데이터에서 반복 비교할 수 있습니다. `SCALP_VARIANT_REPORT_FILE`을 지정하면 동일한 read-only study가 `/api/strategy-research`와 웹·모바일·PWA의 `실전 준비 현황 → 다른 전략 비교` 카드에 표시됩니다. 시장별 캔들을 한 번만 수집해 같은 윈도우에서 비교하지만, 결과는 승격 리포트가 아니며 실전 설정을 바꾸지 않습니다.

variant study는 이제 요청한 시장 수와 실제 continuity 검증을 통과한 시장 수를 분리합니다. cache의 특정 시장이 gap·timestamp·simulation 오류로 무효가 되면 `invalidMarketCount`와 `invalidMarkets`에 사유를 보존하고, 유효 시장만 양수여도 `promotionBlockedByInvalidMarkets=true`, `promoted=false`로 남깁니다. 2026-09-18 동일 30,000개 raw window에서 BTC/ETH/XRP를 비교했을 때 baseline은 `유효 1/3`으로 표시되었고 invalid 2개가 노출되었습니다. 따라서 유효 row만 모아 `1/1 양수`처럼 보이는 축약 결과를 승격 근거로 사용할 수 없습니다.

2026-09-18 30,000개 filled BTC/ETH window의 same-window 비교에서도 baseline은 합산 `-0.0145%`, 손실 조기 종료 `-0.0614~-0.0663%`, break-even `-0.0891%`, trailing `-0.0424%`였습니다. `rebound_25` `+0.0278%`, `volume_15` `+0.0076%`는 holdout 합산만 양수였지만 두 시장 training gate를 실패했습니다. segmented diagnostic에서도 baseline은 BTC `-0.1043%`·ETH `-0.0999%`, rebound_25는 BTC `+0.0422%`·ETH `-0.0170%`, volume_15는 BTC `-0.0592%`·ETH `-0.0530%`, runner trail은 BTC `-0.0780%`·ETH `-0.0738%`였습니다. 이는 시장·구간 일관성이 없는 연구 결과이므로 어떤 후보도 runtime·forward owner에 연결하지 않습니다. 연구 report는 `/private/tmp/coinpilot-scalping-variant-study-btc-eth-30k-filled-20260918.json`, `/private/tmp/coinpilot-scalping-segments-baseline-20260918.json`, `/private/tmp/coinpilot-scalping-segments-rebound25-20260918.json`, `/private/tmp/coinpilot-scalping-segments-volume15-20260918.json`, `/private/tmp/coinpilot-scalping-segments-runnertrail-20260918.json`입니다.

2026-09-17 동일한 최신 raw window(`/private/tmp/coinpilot-scalping-candles-current-20260917.json`)에서 research-only variant를 재비교했습니다. continuity를 통과한 BTC/XRP 두 시장만 결과에 포함됐고, baseline holdout은 `+0.0232%`/17 trades, `bb_reclaim`은 `+0.0297%`/8 trades였지만 두 후보 모두 training gate를 실패했습니다. `trend_rebound`은 holdout 1 trade로 표본 부족, `fast_exit`은 `+0.0064%`로 약한 양수지만 training gate 실패였습니다. 반면 `momentum_breakout` `-0.1966%`, volume 완화 `-0.0291%`, high-break 완화 `-0.0861%`, micro exit `-0.0180%`, break-even/trailing `-0.0016%`로 보완장치가 일관된 개선을 보이지 않았습니다. 따라서 baseline·BB reclaim의 작은 양수 aggregate도 runtime·forward owner·live gate에 연결하지 않고, 결과를 `/private/tmp/coinpilot-scalping-variant-study-current-20260917.json`에 보존합니다.

Historical validation은 이제 cache의 timestamp 간격도 검증합니다. `candleUnit`의 1.5배를 넘는 gap, 누락/잘못된 timestamp, 비증가 timestamp가 있으면 `dataQuality`에 상세 gap 통계를 남기고 해당 single-market·shared-portfolio replay를 fail-closed 합니다. 거래소가 유동성 부족 또는 수집 경계 때문에 빈 봉을 반환할 수 있으므로, array index만 보고 gap을 인접 봉으로 이어 붙이면 RSI·rolling feature·max-hold 시간이 왜곡됩니다. gap이 있는 cache는 수익률/튜닝 근거로 사용하지 말고 연속 cache를 새로 수집하세요. 이 historical guard는 forward paper의 live freshness gate와 별개입니다.

Upbit의 무체결 gap이라는 원인이 확인된 raw cache를 시간축 보존 관점에서 비교해야 할 때만 `npm run validate:scalping:no-trade-fill`을 사용합니다. 이 lane은 누락 구간을 직전 실제 종가의 flat OHLC와 거래량 0으로 채우고 `syntheticNoTradeCount`·gap 상세·`validForReplay`를 기록합니다. 가격 경로를 새로 발명하지는 않지만 synthetic candle을 포함하므로 기본 validation report를 대체하지 않으며, 어떤 screening gate가 통과해도 historical/live promotion은 허용하지 않습니다.

2026-09-17T09:01:39Z 최신 public raw cache의 ETH continuity 실패를 별도 no-trade-fill diagnostic으로 재생했습니다. raw `10080`개에 synthetic no-trade candle `3`개를 명시적으로 채워 `10083`개로 만들었지만 holdout은 `-0.0083%`/PF `0.69`/5 trades/MDD `0.0361%`로 여전히 보류였습니다. 따라서 ETH의 원본 continuity 실패는 데이터 품질 blocker인 동시에, gap을 synthetic으로 채워도 현재 oversold/scalping 전략이 수익성 기준을 회복하지 못한다는 별도 evidence입니다. 기본 validation·live gate·runtime은 변경하지 않으며, 재현 report는 `/private/tmp/coinpilot-scalping-validation-current-export-20260917.json`, `/private/tmp/coinpilot-scalping-candles-current-20260917.json`, `/private/tmp/coinpilot-scalping-no-trade-fill-eth-20260917.json`입니다.

같은 30,000개 window에서 BTC·ETH도 no-trade-fill diagnostic으로 분리 재생했습니다. BTC는 raw gap `3개`를 채운 뒤 holdout `+0.0087%`/PF `1.23`/9 trades/MDD `0.0477%`로 약한 양수를 보였지만 최소 수익·표본 gate에 미달했고, ETH는 gap `27개`를 채운 뒤에도 `-0.0125%`/PF `0.60`/6 trades/MDD `0.0438%`로 음수였습니다. 따라서 BTC는 데이터 gap으로 기본 validation이 차단된 약한 연구 후보일 뿐 승격 근거가 아니며, ETH는 synthetic 보정 이후에도 전략·표본 기준을 모두 충족하지 못합니다. 두 결과 모두 research-only로 유지합니다. 재현 report는 `/private/tmp/coinpilot-scalping-no-trade-fill-btc-eth-30k-20260917.json`과 `/private/tmp/coinpilot-scalping-candles-btc-eth-30k-filled-20260917.json`입니다.

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

`npm run validate:scalping:portfolio`는 여러 마켓을 하나의 시간축으로 맞춰 공유 KRW 잔액, `SCALP_MAX_POSITIONS`, 동시 신호 우선순위를 반영합니다. 마켓별 독립 백테스트와 실제 포트폴리오 실행의 차이를 확인하기 위한 진단 레인이며, 이 결과는 `scalping_validation.json` live gate를 대체하지 않습니다. 기본은 현재 설정 고정이고, `SCALP_PORTFOLIO_VALIDATION_TUNED=true`일 때만 소형 후보 grid를 학습 구간에 적용합니다. `SCALP_PORTFOLIO_VALIDATION_FOLDS=3`을 지정하면 expanding multi-fold로 각 미래 구간을 따로 확인하며, 모든 fold가 통과해야 진단상 통과로 표시됩니다. `SCALP_PORTFOLIO_CANDLES_FILE=/tmp/...json`을 지정하면 동일 원시 캔들창을 read-only로 재사용할 수 있습니다. 새로 수집한 cache를 저장해야 할 때는 입력 파일을 덮어쓰지 않고 `SCALP_PORTFOLIO_CANDLES_OUTPUT_FILE=/tmp/...json`을 별도로 지정합니다. 이 분리는 여러 후보를 병렬 검증할 때 cache JSON이 부분 저장되는 race를 막습니다.

공유 portfolio replay에는 `SCALP_PORTFOLIO_VOLATILITY_LOOKBACK_CANDLES`와 `SCALP_PORTFOLIO_VOLATILITY_TARGET_PERCENT`로 research-only volatility-target sizing을 적용할 수 있습니다. 활성 target은 신호 직전 완료봉의 close-to-close 표준편차가 target을 넘을 때만 해당 진입 비중을 선형 축소하며, target `0`은 기존 고정 비중을 그대로 유지합니다. 변동성 history가 부족하면 full-size로 fallback하지 않고 진입을 fail-closed하며, 각 거래와 metrics에 volatility와 scale·차단 횟수를 기록합니다. 이 overlay는 signal/exit를 개선하거나 실제 fill을 재현하지 않으므로, 양수 결과가 나와도 runtime·live gate·실전 승격 근거로 사용하지 않습니다.

2026-09-18 volatility-target screening은 20개 완료 1분봉 lookback과 target `0.04/0.05/0.075/0.1%`를 3-fold portfolio로 비교했습니다. 최신 BTC/XRP에서는 각각 holdout `-0.0180/-0.0237/-0.0253/-0.0252%`였고, 30,000개 filled BTC/ETH에서는 `-0.0771/-0.0806/-0.0810/-0.0768%`였습니다. current window의 target `0.04%`는 baseline `-0.0319%`보다 덜 손실이었지만 fold별 수익성·confidence gate는 `0/3`이었고, filled BTC/ETH에서는 baseline `-0.0707%`보다 악화됐습니다. 따라서 변동성 축소는 노출을 줄이는 risk overlay일 뿐 alpha를 만들지 못했으며, target을 runtime/live/forward owner에 연결하지 않습니다. 각 fold에서 실제 축소 진입 수와 history blocker도 report에 보존합니다. 재현 report는 `/private/tmp/coinpilot-scalping-portfolio-volatility-current-btc-xrp-t0p04-20260918-r2.json`, `/private/tmp/coinpilot-scalping-portfolio-volatility-current-btc-xrp-t0p05-20260918-r2.json`, `/private/tmp/coinpilot-scalping-portfolio-volatility-current-btc-xrp-t0p075-20260918-r2.json`, `/private/tmp/coinpilot-scalping-portfolio-volatility-current-btc-xrp-t0p1-20260918-r2.json`, `/private/tmp/coinpilot-scalping-portfolio-volatility-filled-btc-eth-t0p04-20260918-r2.json`, `/private/tmp/coinpilot-scalping-portfolio-volatility-filled-btc-eth-t0p05-20260918-r2.json`, `/private/tmp/coinpilot-scalping-portfolio-volatility-filled-btc-eth-t0p075-20260918-r2.json`, `/private/tmp/coinpilot-scalping-portfolio-volatility-filled-btc-eth-t0p1-20260918-r2.json`입니다.

2026-09-18 reference-break exit screening은 signal reference보다 `0.05/0.1/0.2%` 낮아진 close를 최소 `5/10/15분` 이후 청산하는 research-only 축으로 비교했습니다. 400일 최신 BTC/XRP에서 가장 나은 조합도 `0.1%·10분` holdout `-0.0570%`/24 trades였고, 30,000개 filled BTC/ETH에서는 같은 조합이 `-0.0888%`/27 trades였습니다. 비교한 모든 조합은 `0/3 folds`였으며, reference-break 청산은 기존 `MAX_HOLD_TIME` 손실을 앞당겨 닫았지만 손실 방향을 개선하지 못했습니다. 따라서 `referenceBreakExitPercent`와 `referenceBreakMinHoldMinutes`는 기본 `0`을 유지하고 runtime·forward owner·live gate에 연결하지 않습니다. 재현 report는 `/private/tmp/coinpilot-scalping-portfolio-reference-break-current-btc-xrp-p1_m10-20260918.json`, `/private/tmp/coinpilot-scalping-portfolio-reference-break-filled-btc-eth-p1_m10-20260918.json` 및 동일 prefix의 threshold/min-hold 비교 파일입니다.

portfolio 진단에서만 `requireNextCandleBullish` 후보도 비교할 수 있습니다. 이는 신호 다음 봉이 실제로 양봉으로 마감된 뒤 그 종가에 진입하는 계약이어서 기존 1~5초 지연 진입과 다릅니다. `SCALP_PORTFOLIO_REQUIRE_NEXT_CANDLE_BULLISH=true`는 별도 연구용이며, 현재 runtime이나 live gate에 자동 반영되지 않습니다.

2026-09-17 최신 연속 BTC/XRP 1분봉 10,080개 window에서 포트폴리오 보호장치를 고정 설정으로 비교했습니다. baseline은 학습 `-0.0762%`/19 trades/PF `0.32`, holdout `+0.0229%`/17 trades/PF `1.43`였지만 학습 gate를 실패했습니다. `maxEntriesPerSignalWindow=1`은 같은 window 2건을 차단했으나 holdout이 `+0.0032%`/15 trades/PF `1.06`으로 악화됐고, `=2`는 baseline과 동일했습니다. `maxLosingHoldMinutes=5/10`은 holdout 각각 `-0.0402%`/PF `0.60`, `-0.0381%`/PF `0.61`로 악화됐습니다. loss circuit `3`과 `maxPositions=2`는 이 window에서 결과 변화가 없었습니다. 모든 후보는 training/수익성 gate 보류이며 runtime·forward owner에는 연결하지 않습니다. 재현 report는 `/private/tmp/coinpilot-scalping-portfolio-baseline-20260917.json`, `/private/tmp/coinpilot-scalping-portfolio-cap1-20260917.json`, `/private/tmp/coinpilot-scalping-portfolio-loss-timeout-5m-20260917.json`, `/private/tmp/coinpilot-scalping-portfolio-loss-timeout-10m-20260917.json`입니다.

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

2026-09-17에 동일한 12시장 완료 일봉 cache로 이 lane을 다시 실행한 결과도 새 후보로 승격하지 않았습니다. 400일 cache의 `neutral_top3_bottom3_rebalance7`은 full `+6.713%`·MDD `11.77%`였지만 첫 연속 구간이 `-0.424%`였고, 800일 cache는 full `+46.760%`여도 두 번째 구간이 `-25.050%`·MDD `33.58%`였습니다. `rebalance10/14`처럼 full 수익률이 더 큰 변형도 각기 음수 구간이 남아 모두 `HOLD`입니다. 400일·800일 결과는 각각 `/private/tmp/coinpilot-daily-market-neutral-400-20260917.json`, `/private/tmp/coinpilot-daily-market-neutral-800-20260917.json`에 보존합니다. 이 결과는 synthetic short의 비용·regime 의존성을 보여주는 연구 근거일 뿐이며, 현재 Upbit 현물 경로에는 short 실행·wallet settlement가 없으므로 forward owner나 live gate를 만들지 않습니다.

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

loss-cap의 현재 계약을 2026-09-17에 다시 검증한 결과, runtime과 같은 `entry=next_open`·`exit=close`·cost `0.3%`·fixed 2일 조건의 rolling window에서 4% stop은 400/800일 `+5.131%/+11.760%`, MDD `1.34%/1.76%`였고, 6% stop은 `+5.162%/+11.695%`, MDD `1.41%/1.78%`였습니다. 6%는 400일 aggregate에서만 근소하게 앞섰고, 4%는 800일 수익률과 모든 비교 구간의 MDD가 더 낮아 현재 risk-first `4%` profile을 유지합니다. 별도 all-next-open stress에서는 6%가 400/800일 수익률에서 앞섰지만, independent segment 재생은 양쪽 stop 모두 `unknown_boundary_position`으로 `HOLD`가 되었으므로 이 결과로 profile을 바꾸지 않습니다. 재현 report는 `/private/tmp/coinpilot-daily-momentum-rolling-loss-cap-4-800-20260917.json`, `/private/tmp/coinpilot-daily-momentum-rolling-loss-cap-6-800-20260917.json`, `/private/tmp/coinpilot-daily-momentum-robustness-loss-cap-400-20260917.json`, `/private/tmp/coinpilot-daily-momentum-robustness-loss-cap-800-20260917.json`, `/private/tmp/coinpilot-daily-momentum-robustness-loss-cap-independent-400-20260917.json`, `/private/tmp/coinpilot-daily-momentum-robustness-loss-cap-independent-800-20260917.json`입니다. 이 study는 historical paper 후보 근거일 뿐 forward 수익·체결·wallet settlement·live promotion을 증명하지 않습니다.
현재 live ledger의 완료 거래·미청산 mark를 stop cap `2/4/6/8%`로 읽기 전용 counterfactual 비교한 결과, fixed는 cap4에서 완료 ETH `-5.15%` 1건과 미청산 XRP `-7.17%`가 cap을 넘었고, regime는 XRP `-9.20%`와 ETH `-4.06%`가 cap을 넘었습니다. cap2는 현재 소표본에서 더 큰 가상 개선을 보였지만, 같은 runtime 계약의 800일 rolling historical 결과는 cap2 `+8.242%`/MDD `2.15%`로 cap4 `+11.760%`/MDD `1.76%`보다 약했습니다. 따라서 현재 관측 손실만 보고 cap2를 새 owner로 만들지 않고, risk와 historical 재현이 함께 나은 cap4를 유지합니다. 이 비교는 완료 종가를 단순 절단한 모델이며 실제 intraday stop fill·부분 체결·wallet settlement가 아닙니다. 재현 report는 `/private/tmp/coinpilot-daily-momentum-rolling-loss-cap-2-800-20260917.json`이고, live ledger readback은 현재 `.paper-momentum-shadow-v1/ledger.json`과 `.paper-momentum-shadow-regime/ledger.json`에서 재생할 수 있습니다.

next-open 실행에서 신호 종가보다 다음 opening price가 급등하는 추격 진입도 `DAILY_MOMENTUM_ROBUSTNESS_MAX_ENTRY_GAP_PERCENT`로 별도 검증할 수 있습니다. 이 값은 양의 overnight gap만 차단하며 `0`은 비활성입니다. 후보의 400/800일 진입 표본 54/109건에서 gap 최대값은 `+0.395%`, 95백분위는 약 `+0.105%`였으므로 `0.1/0.2/0.3%`를 research-only 축으로 추가했습니다. 비용 `0.3%`에서 gap `0.2/0.3%`는 양쪽 window의 risk-envelope와 거래 표본을 유지하면서 결과를 개선했고, 비용 `0.4%`에서도 gap `0.2/0.3%`가 후보로 남았습니다. 따라서 별도 `.paper-momentum-shadow-next-open-v1` forward 후보에는 `0.2%` ceiling을 연결하되, 기존 close owner와 장부를 섞지 않고 승격과 무관한 A/B로 관찰합니다. 재현 report는 `/private/tmp/coinpilot-daily-momentum-robustness-report-400d-gap-ceiling.json`, `/private/tmp/coinpilot-daily-momentum-robustness-report-800d-gap-ceiling.json`, `/private/tmp/coinpilot-daily-momentum-robustness-report-400d-gap-ceiling-cost04.json`, `/private/tmp/coinpilot-daily-momentum-robustness-report-800d-gap-ceiling-cost04.json`입니다.

forward daily shadow는 응답이 시장별로 정렬·연속이어도 최신 완료 일봉의 완료 시각이 기본 `36시간`보다 오래되면 `daily_market_stale`로 전체 신규 진입을 차단합니다. 신선도는 캔들 시작 시각이 아니라 완료 경계(`open + 1일`)에서 재므로, 정상 그리드의 최신 완료 봉은 항상 24시간 이내에 끝나고 이 검사는 실제로 경계가 누락됐을 때만 발동합니다. 이는 stale 응답을 과거의 정상 breadth로 오인하는 것을 막는 데이터 안전장치이며, `MOMO_SHADOW_MAX_DAILY_CANDLE_AGE_HOURS`와 ledger의 시장별 최신 시각·나이를 함께 보존합니다. stale 차단은 수익성 개선으로 계산하지 않고 데이터 품질 실패로만 표시합니다.

benchmark owner가 저장한 gate boolean의 threshold와 새 후보의 threshold가 다를 수 있으므로, candidate preflight는 source owner의 boolean을 그대로 복사하지 않고 fresh `benchmarkTrendPercent`에 candidate contract의 `benchmarkTrendMinPercent`를 다시 적용합니다. 결과에는 candidate gate와 source gate, 두 threshold를 모두 남겨 `1%` 후보가 `2%` source gate 때문에 잘못 차단되거나 반대로 열리는 일을 방지합니다.

cost `0.3%`를 유지하면서 benchmark gate `0/1/2/3%`와 `minUpBars 1/2`를 함께 sweep한 `1,728`개 조합에서는 400/800일 교집합이 8개였습니다. 그중 별도 forward diagnostic으로 고정한 `next-open` 계약은 benchmark gate `1%`, trend `2%`, breadth `3`, `minUpBars=2`, position fraction `0.125`, max positions `2`, cooldown `3일`, volatility target `1%/14일`, cost `0.3%`입니다. 이 계약은 400일 `+3.601%`/PF `1.96`/MDD `1.37%`/worst `-0.755%`, 800일 `+12.679%`/PF `2.30`/MDD `2.61%`/worst `-0.700%`였지만, 이는 historical risk-envelope 통과일 뿐 실제 수익 증명이 아닙니다. target은 `.paper-momentum-shadow-next-open-v1`로 분리하고, close-fill 장부와 섞지 않으며, exit-next-open은 연결하지 않습니다. 재현 report는 `/private/tmp/coinpilot-daily-momentum-robustness-report-400d-cost03-g1-next-open-vol.json`과 `/private/tmp/coinpilot-daily-momentum-robustness-report-800d-cost03-g1-next-open-vol.json`입니다.

같은 g2 계약에서 `exitOnBenchmarkOff=false`도 별도 비교했습니다. benchmark-off 즉시 청산을 끄면 400일 결과가 `+4.501%`/PF `1.476`/MDD `3.655%`에서 `+0.024%`/PF `1.002`/MDD `8.334%`로, 800일 결과가 `+26.495%`/PF `1.657`/MDD `14.918%`에서 `+17.835%`/PF `1.450`/MDD `17.578%`로 악화되었습니다. 따라서 benchmark-off 청산은 단순 표시용 보호장치가 아니라 현재 candidate 결과에 기여하는 실행 계약으로 유지하며, 이를 완화하는 튜닝은 forward evidence 없이 적용하지 않습니다.

상관된 동시 진입을 줄이는 `maxPositions=1`도 같은 g2 contract에서 별도 확인했습니다. 비중 `0.125`의 max-1 후보는 400일 `+2.941%`/PF `1.476`/MDD `3.247%`로 max-2보다 낙폭은 낮았지만 거래가 26건으로 최소 30건 표본 gate를 통과하지 못했고, 800일은 `+16.290%`/PF `1.683`/MDD `9.968%`였습니다. 이는 risk A/B forward 후보로는 보존하지만, 현재 max-2 contract보다 표본이 부족하므로 runtime이나 기본 forward candidate를 교체하지 않습니다.

benchmark가 threshold를 넘은 뒤에도 `benchmarkMinUpBars`일 동안 연속 확인해야 진입을 허용하는 보완장치도 research simulator에 추가해 검증했습니다. 기본값 `1`은 기존 contract와 동일하며, `2/3` 확인은 400일 continuous에서 `+4.501% → -3.984% → -7.740%`, 800일 continuous에서 `+26.495% → +16.533% → +8.052%`로 악화되었습니다. 800일 worst segment도 `+0.214% → -2.961% → -4.679%`로 내려갔고, 3일 확인은 MDD `15.158%`로 risk limit도 넘었습니다. 따라서 이 보완장치는 false-entry 감소라는 직관과 달리 참여 지연 비용이 더 컸으며, 기본값 `1`을 유지하고 forward/runtime contract에는 연결하지 않습니다. 전용 CLI는 `npm run research:daily-momentum:benchmark-confirmation -- /tmp/candles.json /tmp/report.json 1,2,3 continuous`이며, 이번 재현 report는 `/private/tmp/coinpilot-daily-momentum-benchmark-confirmation-400d-continuous.json`과 `/private/tmp/coinpilot-daily-momentum-benchmark-confirmation-800d-continuous.json`입니다.

2026-09-18에는 같은 확인봉 축을 더 엄격한 실행 경계(`entry=next_open`, `exit=next_open`, cost `0.3%`)로 다시 재생했습니다. regime·trend `2%`·breadth `2`·minUpBars `2`·비중 `0.125`·max positions `2`·benchmark gate `2%`·cooldown `3일` 계약에서 400일 continuous는 `1/2/3`봉 각각 `+3.525%/-4.338%/-8.273%`였지만 worst segment가 `-3.200%/-2.876%/-3.371%`로 모두 floor를 넘었습니다. 800일은 `1`봉만 `+9.922%`/PF `1.26`/MDD `14.84%`/103 trades/worst `-1.519%`로 형식상 `SHADOW_CANDIDATE`였고, `2`봉은 full `+15.955%`여도 worst `-3.195%`, `3`봉은 MDD `15.90%`와 worst `-4.891%`로 `HOLD`였습니다. independent segment에서는 `1/2/3`봉 모두 unknown boundary 또는 worst/full-return blocker가 남았습니다. 따라서 더 많은 확인봉은 참여 지연으로 기각하고, 1봉도 단일 800일 aggregate만으로 forward owner·runtime·promotion에 연결하지 않습니다. 재현 report는 `/private/tmp/coinpilot-daily-momentum-benchmark-confirmation-400-nextopen-20260918.json`, `/private/tmp/coinpilot-daily-momentum-benchmark-confirmation-800-nextopen-20260918.json`, `/private/tmp/coinpilot-daily-momentum-benchmark-confirmation-400-nextopen-independent-20260918.json`, `/private/tmp/coinpilot-daily-momentum-benchmark-confirmation-800-nextopen-independent-20260918.json`입니다.

하루짜리 benchmark/regime false-off를 줄이는 exit confirmation도 simulator에 research-only로 추가했습니다. `benchmarkExitConfirmationBars`와 `regimeExitConfirmationBars`의 기본값은 각각 `1`이며, `DAILY_MOMENTUM_ROBUSTNESS_BENCHMARK_EXIT_CONFIRMATION_BARS`와 `DAILY_MOMENTUM_ROBUSTNESS_REGIME_EXIT_CONFIRMATION_BARS`로 `1,2,3` 축을 재현할 수 있습니다. 현재 g2/u2/t2/b2/f0.125/max2/cooldown3 계약에서 `b2/r1`은 400일 수익률이 `+6.060%`(baseline `+4.501%`)로 좋아졌지만 800일 MDD가 `16.572%`로 risk limit `15%`를 넘었습니다. 반대로 `b1/r2`는 800일 MDD `12.771%`이지만 400일 worst segment가 `-2.153%`로 floor `-2%`를 깼습니다. `b1/r1` 기본 조합만 두 window 모두 `SHADOW_CANDIDATE`였으므로 새 confirmation 값을 forward/runtime에 연결하지 않고 기본 `1/1`을 유지합니다. 입력 cache와 출력 report는 각각 첫 번째·두 번째 positional 인자로 지정할 수 있으며, 재현 report는 `/private/tmp/coinpilot-daily-momentum-robustness-report-400d-exit-confirmation.json`과 `/private/tmp/coinpilot-daily-momentum-robustness-report-800d-exit-confirmation.json`입니다.

benchmark 대비 약한 종목을 제외하는 `relativeTrendMinPercent` 필터도 연구 전용으로 추가했습니다. benchmark 추세보다 종목 추세가 지정값만큼 높아야 진입을 허용하는 계약이며, benchmark가 없는 경우 fail-closed합니다. 과거 cache에서 `0/0.5/1/2/3/5%`를 비교했을 때는 400일 worst segment가 `-2.137%` 아래로 내려가 모두 floor `-2%`를 충족하지 못했으므로 당시에는 forward/runtime에 연결하지 않았습니다. 이 판단은 해당 cache에 한정된 것이며, 최신 cache 재검증은 아래 별도 A/B 등록 근거와 구분합니다.

최신 2026-09-16 완료 일봉 cache를 다시 사용한 상대추세 `0%` A/B는 이전 cache 결론과 분리해 재검증했습니다. fixed 2일·next-open·cost `0.3%`·gate `1%`·trend `2%`·breadth `3`·minUpBars `2`·volatility target `1%/14일`·gap `0.2%` 계약에서 400일은 `+6.238%`/PF `2.38`/MDD `0.90%`/79 trades/worst continuous segment `-0.155%`, 800일은 `+11.779%`/PF `1.95`/MDD `1.82%`/197 trades/worst continuous segment `+0.189%`였습니다. 비용 `0.4%/0.5%` stress에서도 400일 `+5.861%/+5.485%`, 800일 `+10.960%/+10.148%`로 양수였고, trailing window는 180~800일에서 모두 양수였지만 120일은 24 trades로 표본 부족이었습니다. 독립 segment 800일은 마지막 미청산 boundary position 때문에 `unknown_boundary_position`으로 fail-closed되어 승격 근거가 아닙니다. 따라서 `relativeTrendMinPercent=0`은 실제 주문과 무관한 별도 `.paper-momentum-shadow-fixed-hold-2d-relative-v1` forward A/B 후보로만 등록하며, 기존 장부·runtime 기본값·live gate를 교체하지 않습니다. 이 후보는 `MOMO_SHADOW_RELATIVE_TREND_MIN_PERCENT=0`을 명시하고 상대추세 차단 횟수와 benchmark trend를 별도 ledger에 보존해야 합니다. 재현 report는 `/private/tmp/coinpilot-daily-momentum-current-400d-relative-refresh.json`, `/private/tmp/coinpilot-daily-momentum-current-800d-relative-refresh.json`, `/private/tmp/coinpilot-daily-momentum-current-400d-relative0-cost04.json`, `/private/tmp/coinpilot-daily-momentum-current-800d-relative0-cost04.json`, `/private/tmp/coinpilot-daily-momentum-current-400d-relative0-cost05.json`, `/private/tmp/coinpilot-daily-momentum-current-800d-relative0-cost05.json`, `/private/tmp/coinpilot-daily-momentum-current-800d-relative0-rolling.json`입니다.

상대추세 임계값 `0/0.1/0.2/0.5/1%`를 최신 동일 cache와 동일한 fixed 2일·next-open 계약으로 다시 sweep했습니다. 400일에서는 `0%`가 총수익률 `+6.238%`/MDD `0.90%`로 가장 높았고, `1%`는 PF `2.41`로 조금 높지만 수익률 `+6.160%`, MDD `0.98%`, 거래 `75`회로 표본과 낙폭이 불리했습니다. 800일에서도 `0%`가 `+11.779%`/MDD `1.82%`/197 trades로 가장 높았고 `1%`는 PF `1.99`로 조금 높지만 `+11.614%`/MDD `1.87%`/190 trades였습니다. `0.1/0.2/0.5%`는 양쪽 window에서 `0%`보다 수익률이 낮았습니다. trailing window에서도 두 값 모두 180~800일 양수 관측을 유지했지만, `0%`가 400/800일 기준선과 긴 window 총수익률에서 우위였으므로 현재 순차 forward 후보는 `relativeTrendMinPercent=0`으로 유지합니다. 이는 파라미터 선택 근거이지 실전 수익 증명이 아니며, 독립 구간·실제 체결·지갑 정산 검증 전에는 다른 값으로 runtime을 교체하지 않습니다. 재현 report는 `/private/tmp/coinpilot-daily-momentum-current-400d-relative-axis-01.json`, `/private/tmp/coinpilot-daily-momentum-current-800d-relative-axis-01.json`, `/private/tmp/coinpilot-daily-momentum-current-800d-relative0-rolling-refresh.json`, `/private/tmp/coinpilot-daily-momentum-current-800d-relative1-rolling-refresh.json`입니다.
현재 paper attribution에서 손실이 관측된 XRP/NEAR를 즉시 제외해도 되는지 확인하기 위해 2026-09-16 최신 gap-free 400/800일 cache에서 동일한 fixed 2일·next-open·cost `0.3%`·gate `1%`·trend `2%`·breadth `3`·minUpBars `2`·volatility `1%/14일`·gap `0.2%`·relative `0%` contract를 전체 시장, XRP 제외, NEAR 제외, XRP+NEAR 제외로 각각 재생했습니다. 전체는 `+6.238%/+11.779%`, XRP 제외는 `+5.437%/+10.798%`, NEAR 제외는 `+5.623%/+11.382%`, 둘 다 제외는 `+4.827%/+10.758%`(각각 400/800일)였습니다. 네 조합 모두 형식상 `SHADOW_CANDIDATE`였지만 제외 조합이 전체보다 수익률이 낮았으므로 현재 market attribution 4건만으로 시장 제외·market-list 축소를 적용하지 않습니다. 이 결과는 과거 cache의 시장별 우열을 증명하는 것이 아니라 forward A/B를 추가할지 판단하는 negative selection evidence이며, 재현 report는 `/private/tmp/coinpilot-daily-momentum-market-filter-400d-all.json`, `/private/tmp/coinpilot-daily-momentum-market-filter-400d-noXrp.json`, `/private/tmp/coinpilot-daily-momentum-market-filter-400d-noNear.json`, `/private/tmp/coinpilot-daily-momentum-market-filter-400d-noXrpNear.json`, `/private/tmp/coinpilot-daily-momentum-market-filter-800d-all.json`, `/private/tmp/coinpilot-daily-momentum-market-filter-800d-noXrp.json`, `/private/tmp/coinpilot-daily-momentum-market-filter-800d-noNear.json`, `/private/tmp/coinpilot-daily-momentum-market-filter-800d-noXrpNear.json`입니다.

2026-09-17T08:34:55Z 반복 spread evidence가 있는 DOGE도 같은 loss-cap 계약으로 별도 market-filter 재생을 했습니다. 400일 전체 시장은 `+5.131%`/PF `1.88`/MDD `1.34%`/92 trades/worst segment `-0.532%`였고, DOGE 제외는 `+4.657%`/PF `1.84`/MDD `1.32%`/88 trades/worst `-0.532%`였습니다. 800일 전체 시장은 `+11.760%`/PF `1.80`/MDD `1.76%`/228 trades/worst `+0.066%`였고, DOGE 제외는 `+9.298%`/PF `1.66`/MDD `1.82%`/218 trades/worst `+0.321%`였습니다. 즉 DOGE spread는 실행비용 guard가 필요한 근거지만, DOGE를 global market list에서 제거하면 두 window의 수익·PF가 모두 낮아졌습니다. 따라서 DOGE는 global 제외가 아니라 quote-cross 후보의 `maxSpreadPercent=0.5%` 신규 진입 차단으로만 유지하며, 이 historical 비교도 실제 fill·slippage·wallet settlement·promotion 증거로 해석하지 않습니다. 재현 report는 `/private/tmp/coinpilot-daily-momentum-market-filter-doge-loss-cap-400-all-20260917.json`, `/private/tmp/coinpilot-daily-momentum-market-filter-doge-loss-cap-400-noDoge-20260917.json`, `/private/tmp/coinpilot-daily-momentum-market-filter-doge-loss-cap-800-all-20260917.json`, `/private/tmp/coinpilot-daily-momentum-market-filter-doge-loss-cap-800-noDoge-20260917.json`입니다.
반복 손실 뒤 진입을 더 오래 막는 cooldown도 같은 contract에서 `3/7/14일`을 별도 sweep했습니다. 400일에서는 각각 `+6.238%/+6.256%/+5.988%`였지만, 800일에서는 `+11.779%/+11.365%/+11.668%`였고 worst continuous segment는 `+0.189%/-0.278%/-0.669%`였습니다(순서대로 cooldown 3/7/14일). 7일은 짧은 window에서만 미세한 aggregate 개선이 있었고 긴 window의 수익·worst segment가 악화되었으며, 14일은 MDD `1.34%`로 낮아지는 대신 worst segment가 나빠졌습니다. 따라서 현재 cooldown `3일`을 유지하고 7/14일을 forward/runtime에 연결하지 않습니다. 재현 report는 `/private/tmp/coinpilot-daily-momentum-cooldown-axis-400d.json`과 `/private/tmp/coinpilot-daily-momentum-cooldown-axis-800d.json`입니다.
최신 canonical cost `0.3%`에서 stop-loss `0/1/2/3/5/7%`도 연속 segment와 independent segment로 분리 검증했습니다. continuous 400일에서는 기준 `+6.238%`/MDD `0.90%`/worst `-0.155%`였고 7%는 기준과 동일했으며, 800일에서는 7%가 `+12.040%`/MDD `1.70%`/worst `+0.269%`로 aggregate만 개선됐습니다. 그러나 independent 400일의 기준·5%·7% worst segment가 모두 `-0.807%`였고, independent 800일은 세 조합 모두 마지막 미청산 경계(`unknown_boundary_position`)로 `HOLD`가 됐습니다. 따라서 7%를 aggregate 수익만으로 forward/runtime에 연결하지 않고 stop-loss 축은 계속 research-only로 둡니다. 재현 report는 `/private/tmp/coinpilot-daily-momentum-stoploss-axis-400d-cost03.json`, `/private/tmp/coinpilot-daily-momentum-stoploss-axis-800d-cost03.json`, `/private/tmp/coinpilot-daily-momentum-stoploss-axis-400d-cost03-independent.json`, `/private/tmp/coinpilot-daily-momentum-stoploss-axis-800d-cost03-independent.json`입니다.

상대추세 후보의 비용 내성 경계도 동일 cache에서 추가 측정했습니다. 비용 `0.8/1.0/1.2/1.5%`까지는 400/800일 모두 양수였지만, 800일 PF가 `1.55/1.42/1.30/1.14`로 낮아졌습니다. 비용 `1.8%`에서는 400일이 `+0.341%`/PF `1.05`로 사실상 비용 중립에 가까웠고, 800일은 `-0.185%`로 `HOLD`가 됐습니다. 비용 `2.0%`부터는 400/800일 모두 음수(`-0.368%/-1.348%`)로 전환됐습니다. 따라서 실수수료와 spread를 합친 round-trip 총비용이 `1.8%`에 접근하면 후보를 자동 보류해야 하며, 비용 `0.3%`의 forward A/B 계약을 이 결과만으로 완화하거나 runtime 기본값으로 승격하지 않습니다. 재현 report는 `/private/tmp/coinpilot-daily-momentum-current-400d-relative0-cost0p8.json`, `/private/tmp/coinpilot-daily-momentum-current-800d-relative0-cost0p8.json`, `/private/tmp/coinpilot-daily-momentum-current-400d-relative0-cost1p0.json`, `/private/tmp/coinpilot-daily-momentum-current-800d-relative0-cost1p0.json`, `/private/tmp/coinpilot-daily-momentum-current-400d-relative0-cost1p2.json`, `/private/tmp/coinpilot-daily-momentum-current-800d-relative0-cost1p2.json`, `/private/tmp/coinpilot-daily-momentum-current-400d-relative0-cost1p5.json`, `/private/tmp/coinpilot-daily-momentum-current-800d-relative0-cost1p5.json`, `/private/tmp/coinpilot-daily-momentum-current-400d-relative0-cost1p8.json`, `/private/tmp/coinpilot-daily-momentum-current-800d-relative0-cost1p8.json`, `/private/tmp/coinpilot-daily-momentum-current-400d-relative0-cost2p0.json`, `/private/tmp/coinpilot-daily-momentum-current-800d-relative0-cost2p0.json`, `/private/tmp/coinpilot-daily-momentum-current-400d-relative0-cost2p5.json`, `/private/tmp/coinpilot-daily-momentum-current-800d-relative0-cost2p5.json`, `/private/tmp/coinpilot-daily-momentum-current-400d-relative0-cost3p0.json`, `/private/tmp/coinpilot-daily-momentum-current-800d-relative0-cost3p0.json`입니다.

2026-09-16T10:26:32Z read-only orderbook snapshot도 12개 시장·5회 샘플·오류 0으로 완료했습니다. 전체 p95 spread는 `0.922%`였고, DOGE만 `0.922%`로 5/5회 `0.5%` ceiling을 초과했습니다. BTC p95는 `0.003%`, ETH `0.061%`, XRP `0.114%`, SOL `0.075%`, NEAR `0.091%`였으며 나머지도 ceiling 이하였습니다. DOGE 고spread는 세 시점의 반복 snapshot에서 재현된 execution-cost 위험이지만 best bid/ask 관측은 실제 fill이나 realized P&L이 아닙니다. 따라서 DOGE를 global market list에서 제거하지 않고, `.paper-momentum-shadow-fixed-hold-2d-spread-v1`의 `maxSpreadPercent=0.5` A/B에서만 신규 진입 차단 효과를 관찰하며 상대추세 pure A/B와 결과를 섞지 않습니다. fixed-hold/relative/spread readiness projection은 historical candidate와 launcher에 맞춰 `exitOnBenchmarkOff=true`를 명시적으로 기대하며, UI에도 기준 시장 off 청산을 표시합니다. 최신 report는 `/private/tmp/coinpilot-momentum-shadow-quote-quality.json`, history는 `/private/tmp/coinpilot-momentum-shadow-quote-history.jsonl`입니다.

quote history는 append-only JSONL의 최근 최대 24개 유효 report를 별도로 읽어, malformed/future record를 제외한 뒤 시장별 `ceiling 초과 report 수/전체 report 수`를 계산합니다. 대시보드에는 최신 snapshot과 이 반복 관측을 함께 표시하므로 `DOGE 8/8회`처럼 실행비용 위험의 지속성을 확인할 수 있지만, 이 값 역시 호가 관측일 뿐 실제 fill·slippage·wallet settlement·수익 증거가 아닙니다. history가 없거나 최신 report가 오래되면 각각 확인 불가/오래됨으로 표시하고, 어떠한 경우에도 신규 주문이나 promotion을 허용하지 않습니다.

2026-09-16T14:58:01Z에 같은 12개 시장·5회 sample을 다시 수집한 결과도 오류 `0`과 complete `5/5`를 유지했고, DOGE spread `0.922%`가 5/5회 `0.5%` ceiling을 초과했습니다. 같은 시점 BTC `0.072%`, ETH `0.116%`, NEAR `0.150%`, ADA `0.382%`는 ceiling 이하였습니다. 이 최신 report를 포함한 append-only history는 `15/15` report가 정상이며 DOGE가 `15/15` report에서 반복 초과합니다. 반복 호가가 실행비용 위험을 뒷받침하지만 실제 fill·slippage·wallet settlement·실현손익은 아니므로 global market list를 변경하지 않고 quote-quality A/B의 신규 진입 차단 근거로만 사용합니다. 최신 report는 `/private/tmp/coinpilot-momentum-shadow-quote-quality.json`, history는 `/private/tmp/coinpilot-momentum-shadow-quote-history.jsonl`입니다.

2026-09-16T15:22:42Z 최신 quote sample도 12개 시장·5/5·오류 `0`을 유지했고, DOGE spread `0.922%`가 다시 5/5회 ceiling을 초과했습니다. BTC p95 `0.021%`, ETH `0.086%`, XRP `0.115%`, NEAR `0.149%`는 이번 sample에서 `0.5%` ceiling 이하였습니다. 이 report를 포함한 append-only history는 정상 `16/16`이며 DOGE가 `16/16 report`에서 반복 초과합니다. 이는 실행비용 위험을 반복 관찰한 증거이지 실제 fill·slippage·wallet settlement·실현손익이 아니므로 market list와 runtime 기본값은 변경하지 않습니다.
이후 2026-09-16T15:29:32Z sample도 12개 시장·5/5·오류 `0`이었고 DOGE `0.922%`가 5/5회 초과했습니다. 같은 sample의 BTC `0.050%`, ETH `0.031%`, NEAR `0.090%`는 ceiling 이하였으며, history는 정상 `17/17 report`, DOGE 반복 초과는 `17/17 report`로 증가했습니다. 최신 반복 관측도 실제 fill이나 settlement가 아니므로 global 제외·runtime 변경 없이 quote-quality A/B 증거로만 사용합니다.
2026-09-16T15:45:26Z sample도 12개 시장·5/5·오류 `0`이었고 DOGE `0.922%`가 5/5회 ceiling을 초과했습니다. BTC `0.001%`, ETH p95 `0.055%`, NEAR `0.119%`는 ceiling 이하였으며, append-only history는 정상 `18/18 report`, DOGE 반복 초과는 `18/18 report`가 되었습니다. 최신 표본도 실제 fill이나 settlement가 아니므로 quote-quality A/B evidence로만 유지합니다.
2026-09-16T15:53:27Z sample도 12개 시장·5/5·오류 `0`을 유지했고 DOGE `0.922%`가 다시 5/5회 ceiling을 초과했습니다. 이번 sample의 BTC p95 `0.035%`, ETH `0.091%`, XRP `0.173%`, ADA `0.381%`는 ceiling 이하였으며, append-only history는 정상 `19/19 report`, DOGE 반복 초과는 `19/19 report`가 되었습니다. 반복 호가 evidence는 `.paper-momentum-shadow-fixed-hold-2d-spread-v1`의 신규 진입 guard 판단에만 사용하고, 실제 fill·slippage·wallet settlement·실현손익으로 해석하지 않습니다.
2026-09-16T16:07:27Z sample도 12개 시장·5/5·오류 `0`으로 완료됐고 DOGE `0.922%`가 다시 5/5회 ceiling을 초과했습니다. 이번 sample의 BTC p95 `0.057%`, ETH `0.092%`, XRP `0.058%`, ADA `0.382%`는 ceiling 이하였으며, append-only history는 정상 `20/20 report`, DOGE 반복 초과는 `20/20 report`가 되었습니다. 이 반복 관측은 quote-quality A/B의 실행비용 경계 evidence로만 유지하고, 실제 fill·slippage·wallet settlement·실현손익 또는 global market list 변경의 근거로 사용하지 않습니다.
위 `20/20`은 세션 정리 전 `/private/tmp`에 있던 ephemeral raw history의 마지막 관측이며, 이후 `/private/tmp` 정리로 raw JSONL을 다시 읽을 수 없게 되었습니다. 따라서 이를 persistent history로 복원하거나 현재 파일에 합산하지 않습니다. 기본 저장소는 `.coinpilot-runtime/momentum-shadow/`로 migration했고, migration 이후 첫 검증 가능한 history는 아래 `1/1`부터 다시 시작합니다.
2026-09-16T16:37:11Z migration 이후 첫 persistent quote sample은 12개 시장·5/5·오류 `0`으로 완료됐고 DOGE `0.922%`가 다시 5/5회 ceiling을 초과했습니다. 이번 sample의 BTC p95 `0.052%`, ETH `0.061%`, XRP `0.104%`, ADA `0.381%`는 ceiling 이하였고, `.coinpilot-runtime/momentum-shadow/quote-history.jsonl`의 현재 정상 history는 `1/1 report`입니다. persistent report/history는 세션 정리와 별개로 유지되지만, 이 관측도 실제 fill·slippage·wallet settlement·실현손익은 아닙니다.
2026-09-16T16:42:37Z scheduled quote sampler의 첫 launchd 실행도 12개 시장·5/5·오류 `0`으로 완료됐고 DOGE `0.922%`가 5/5회 ceiling을 초과했습니다. persistent history는 `2/2 report`로 증가했고 sampler service는 one-shot 종료 후 `900초` 주기를 예약한 상태입니다. 이 자동 갱신은 quote freshness를 유지하는 운영 보완이며 실제 fill·slippage·wallet settlement·실현손익을 만들거나 promotion을 허용하지 않습니다.
2026-09-16T16:57:06Z freshness 전환 직전의 read-only quote refresh도 12개 시장·5/5·오류 `0`으로 완료됐고 DOGE `0.922%`가 다시 5/5회 ceiling을 초과했습니다. persistent history는 `3/3 report`가 되었고 ETC p95 `0.345%`는 ceiling 이하였습니다. 이 sample도 quote freshness 보완용 evidence이며 실제 fill·slippage·wallet settlement·실현손익으로 해석하지 않습니다.
2026-09-17T05:49:56Z persistent runtime의 최신 read-only quote snapshot은 12개 시장·5/5·오류 `0`으로 완료됐습니다. 전체 p95는 `0.8969%`였고 DOGE가 `0.8969%`로 5/5회 `0.5%` ceiling을 초과했으며, BTC `0.0124%`, ETH `0.0298%`, XRP `0.0560%`, ADA `0.3697%` 등 나머지 시장은 ceiling 이하였습니다. persistent history는 정상 `60/60 report`이며, 이 반복 관측은 `.paper-momentum-shadow-fixed-hold-2d-spread-v1`의 시장별 신규 진입 차단을 검토하는 quote-quality evidence로만 사용합니다. global market list·runtime 기본값·promotion은 변경하지 않고, `/private/tmp`가 아닌 `.coinpilot-runtime/momentum-shadow/quote-quality.json`과 `quote-history.jsonl`을 현재 source of truth로 유지합니다. 호가 관측은 실제 fill·slippage·wallet settlement·실현손익이 아닙니다.

2026-09-17T07:16:04Z persistent quote sampler를 다시 실행한 결과도 12개 시장·5/5 sample·오류 `0`을 유지했고, DOGE p95 `0.897%`가 `0.5%` ceiling을 5/5회 초과했습니다. BTC `0.004%`, ETH `0.059%`, XRP `0.056%`, SOL `0.073%`, NEAR `0.133%` 등은 ceiling 이하였습니다. append-only history는 정상 `69/69 report`가 되었고 quote-cross preflight의 호가 품질 조건도 `ready=true`였지만 benchmark gate가 닫혀 `launchAllowed=false`로 유지되었습니다. 이는 신규 진입 전 spread guard의 반복 evidence이지 실제 fill·slippage·wallet settlement·실현손익이 아니므로 DOGE global 제외, market list 축소, runtime 기본값 변경 또는 promotion을 하지 않습니다.

2026-09-17T07:33:35Z quote sampler도 12개 시장·5/5·오류 `0`을 유지했고, BTC p95 `0.002%`, ETH `0.089%`, XRP `0.056%`, SOL `0.072%`, NEAR `0.101%`은 ceiling 이하였습니다. DOGE p95 `0.897%`는 다시 5/5회 ceiling을 초과했고 persistent history는 정상 `72/72 report`가 되었습니다. quote-cross의 quote freshness/complete 조건은 `ready=true`였지만 benchmark gate가 닫혀 후보는 시작하지 않았습니다. 이 반복 관측은 시장별 신규 진입 guard evidence이지 실제 체결·slippage·wallet settlement·실현손익이 아니므로 global market list·runtime 기본값·promotion은 변경하지 않습니다.

2026-09-17T08:26:23Z persistent quote sampler도 12개 시장·5/5·오류 `0`을 유지했고, 전체 p95는 `0.889%`였습니다. DOGE p95 `0.889%`가 `0.5%` ceiling을 5/5회 초과했으며, migration 이후 persistent JSONL 전체는 78개 report, 현재 route가 읽는 bounded window는 정상 `24/24` report이고 DOGE 반복 초과는 `24/24 report`입니다. BTC `0.002%`, ETH `0.030%`, XRP `0.056%`, SOL `0.072%`, NEAR `0.154%` 등 나머지는 이번 sample에서 ceiling 이하였습니다. quote-cross preflight의 quote freshness/complete 조건은 `ready=true`였지만 benchmark gate가 닫혀 `launchAllowed=false`로 유지되었습니다. 이 반복 호가 evidence는 DOGE 신규 진입 spread guard 판단에만 사용하며, global market list·runtime 기본값·실제 fill·wallet settlement·실현손익·promotion은 변경하지 않습니다.

같은 시점의 read-only momentum projection도 `2026-09-17T08:29:15Z`에 다시 export했습니다. snapshot은 `valid=true`, `fresh=true`, `researchOnly=true`, `promoted=false`, book `10`개 중 available `3`개였고, export 직후 verifier에서 age `16초`와 SHA-256 `990047806cccf64f14f64fafd657fafb828efec3644d28083d936b580ce465ee`를 확인했습니다. 이는 최신 paper projection의 구조·시점 무결성만 보강하며 실제 체결·정산·수익성을 증명하지 않습니다.

2026-09-17T10:14:20Z staging read-only projection도 다시 export했습니다. snapshot은 `valid=true`, `fresh=true`, `researchOnly=true`, `promoted=false`, book `10`개 중 available `3`개였고, export 직후 verifier에서 stale heartbeat `0`, SHA-256 `83d7c51a9ecc6dbc06ceef2505f83cf653ee47a4496805fb3c92b4778826a282`를 확인했습니다. 이 artifact는 현재 owner heartbeat와 projection 구조의 freshness만 확인하며 실제 체결·wallet settlement·live profitability를 증명하지 않습니다.

2026-09-16T15:30:26Z benchmark poll은 새 cycle과 daily quality history `2/2`를 기록했지만 최신 완료 봉 timestamp가 anchor와 동일해 checkpoint를 중복 추가하지 않았습니다. observation checkpoint가 `1개`로 유지된 것은 polling 자체가 실패한 것이 아니라 same-bar dedupe가 작동한 결과이며, 같은 완료 봉을 여러 번 관찰해 상대성과 표본을 부풀리지 않는 계약을 실제 ledger에서 확인한 것입니다. BTC trend `-3.18%` gate closed와 포지션·거래 `0개`도 유지되었습니다.

shadow readback의 `promotionBlockers`는 평가자산만으로 전환을 암시하지 않도록 미청산 포지션, 실현수익률과 별개인 평가수익, 거래수익 95% 하한 미달 또는 유효 청산 수익률 부족, 표본 충족 후에도 실현 순수익률이 0% 이하인 상태, 관찰 세션 진행 중 상태, 최소 관찰 기간 미달 또는 시작/종료 시각 누락, stale heartbeat, 현재 활성화된 network circuit/연속 수집 실패, 활성 spread guard의 유효하지 않은 quote 품질, 기록되지 않았거나 불완전한 일봉 품질을 별도 보류 사유로 보존합니다. API/UI/CLI는 동일한 공용 profitability helper를 사용해 실현손익 금액, 초기자산 대비 `realizedReturnPercent`, 시장별 유효 청산 수·승패·실현금액·평균 수익률, one-sided 95% 하한을 함께 표시합니다. web/mobile/PWA momentum shadow card는 `minimumResearchTrades`와 유효 표본, 실현 순수익률, 95% 하한을 별도 `수익성 기준` 행으로 표시하지만 이는 전환 승인 표시가 아니라 보류 이유를 빠르게 읽기 위한 참고 UI입니다. 시장별 row는 튜닝을 자동 실행하거나 시장을 제외하지 않는 attribution readback이며, 소수 표본의 손실만으로 contract를 바꾸지 않습니다. 모든 momentum shadow projection은 계속 `promoted=false`이며, 이 blocker는 실제 주문 승인이나 수익성 보장을 대신하지 않고 다음 검증 표본의 결격 원인을 명확히 하는 진단 경계입니다.

benchmark gate 장부에는 2026-09-16부터 관찰 owner가 처음 확인한 완료 BTC 종가를 anchor로 삼는 별도 benchmark observation도 기록합니다. 새 observation telemetry schema는 `1`로 식별하며, `observationReturnPercent`는 anchor 이후 BTC의 가격 변동률(수수료·실제 보유·체결 제외)이고, `relativeMarkedReturnPercent`는 같은 구간의 전략 `markedReturnPercent`에서 이 benchmark 가격 변동률을 뺀 값입니다. 완료 일봉마다 최대 400개의 checkpoint를 보존해 반복 polling으로 같은 봉을 중복 기록하지 않으며, 일봉 grid가 유효한 checkpoint만 best/worst 상대성과 범위에 포함합니다. API/UI/CLI에는 checkpoint 총수와 유효수, 해당 구간의 best/worst 상대성과를 표시합니다. 이는 시장 상승에 따른 착시를 줄이는 상대성과 계측이지 alpha·실제 fill·wallet settlement·live 수익의 증명이 아니며, 기존 gate threshold·entry/exit·promotion 판정에는 연결하지 않습니다. 구버전 owner가 아직 schema `1`을 로드하지 않았거나 anchor를 기록하지 않았으면 API/UI/CLI는 값을 추측하지 않고 legacy owner/`benchmark_observation_not_recorded`/기준가 대기로 구분해 표시하며, 다음 안전한 owner 재시작 이후부터의 구간만 비교합니다. candidate preflight도 이 상태를 `benchmark_observation_telemetry_legacy` 또는 `benchmark_observation_unavailable` warning으로 별도 노출하지만, gate 자체와 섞어 launch 여부를 왜곡하지 않습니다. API의 benchmark object, `momentumShadowStatus` CLI, web/mobile/PWA 카드가 같은 read-only 값을 사용합니다.

2026-09-16T15:14:08Z에 기존 benchmark owner가 포지션 `0개`·거래 `0건`·pending entry `0개`인 상태에서 graceful stop되었고, 동일한 mode/12시장/BTC gate/poll 계약으로 새 owner `PID 33709`를 안전하게 시작했습니다. 첫 cycle `193`에서 observation schema `1`, anchor/mark `2026-09-15T00:00:00`, observation return `0%`, 유효 checkpoint `1개`, daily quality history `1/1`이 실제 ledger에 기록되었습니다. 이 anchor는 상대성과 비교의 시작점이며 첫 mark가 anchor와 같은 것은 정상입니다. 새 owner도 BTC 추세 `-3.18%`로 gate가 닫힌 상태에서 진입하지 않았고, fixed/regime owner나 candidate는 재시작하지 않았습니다. 이 상태 전환은 상대성과 데이터 연속성 계측을 가능하게 하지만 실제 fill·wallet settlement·수익성 증명은 아니며, 다음 완료 일봉부터 checkpoint 변화와 전략 평가/실현손익을 별도로 관찰합니다.

새 runner의 network guard는 누적 오류·현재 연속 실패·circuit 상태와 함께 마지막 실패 시장을 `lastNetworkFetchError.market`으로 보존하고, API/UI/CLI는 이를 `KRW-BTC:ENOTFOUND` 같은 bounded label로만 표시합니다. 기존 owner는 guard 도입 전 PID라 과거 오류의 시장별 원인이 비어 있을 수 있으며, 다음 자연 재시작 이후부터 이 telemetry를 사용합니다. 현재 cycle의 누락 시장은 여전히 전체 일봉 grid를 fail-closed하고, 실패한 시장을 임의로 제외해 부분 데이터로 수익을 계산하지 않습니다.

2026-09-16T16:00:39Z benchmark poll은 cycle `196`에서 같은 완료 봉 `2026-09-15T00:00:00`을 다시 관찰했지만 observation checkpoint를 `1개`로 유지했습니다. daily grid `12/12` 정상·BTC trend `-3.18%`·gate closed·포지션/거래 `0개`도 그대로였고, 상대성과는 `0%`에서 변하지 않았습니다. cycle은 증가하되 동일 봉은 상대성과 표본에 중복 반영하지 않는 dedupe가 두 번째 자연 poll에서도 유지된 운영 evidence입니다.
2026-09-16T16:47:31Z benchmark poll은 launchd로 재기동된 owner의 cycle `199`에서 같은 완료 봉을 다시 관찰했지만 checkpoint를 계속 `1개`로 유지했습니다. heartbeat는 fresh하고 daily grid `12/12`가 정상이며 BTC trend `-3.18%`·gate closed·포지션/거래 `0개`·상대성과 `0%`도 변하지 않았습니다. 이는 외부 SIGTERM 자동복구 뒤에도 same-bar dedupe가 유지되고, 새 일봉이 없을 때 표본을 부풀리지 않는다는 세 번째 readback evidence입니다.
2026-09-16T17:02:38Z benchmark poll은 cycle `200`에서도 같은 완료 봉을 관찰해 checkpoint `1개`와 상대성과 `0%`를 유지했습니다. heartbeat fresh·daily grid `12/12`·BTC gate closed·포지션/거래 `0개`가 그대로였고, launchd owner PID `24205`도 계속 running입니다. 새 일봉이 생기기 전까지 상대성과 표본을 추가하지 않는 운영 invariant가 계속 유지되고 있습니다.

spread guard가 켜진 후보는 entry/exit decision boundary에서 보이는 best bid/ask를 compact quote로 장부에 남기고, midpoint 기준의 양방향 crossing drag를 거래별 `quoteExecutionEvidence`로 계산합니다. 이는 수수료·slippage·partial fill을 포함한 체결값이 아니므로 API/UI/CLI에 `모델 crossing drag`와 `실제 fill 아님`으로만 표시하며, entry 또는 exit quote가 없으면 evidence를 유효 표본으로 세지 않습니다. 이 장치는 실제 체결 증거를 대체하지 않고, 향후 fill/지갑 정산 자료와 paper P&L의 차이를 비교할 수 있게 하는 실행경계 진단입니다.
spread guard가 켜진 후보는 entry/exit decision boundary에서 보이는 best bid/ask를 compact quote로 장부에 남기고, midpoint 기준의 양방향 crossing drag를 거래별 `quoteExecutionEvidence`로 계산합니다. 이는 수수료·slippage·partial fill을 포함한 체결값이 아니므로 API/UI/CLI에 `모델 crossing drag`와 `실제 fill 아님`으로만 표시하며, entry 또는 exit quote가 없거나 timestamp가 없으면 evidence를 유효 표본으로 세지 않습니다. 이 장치는 실제 체결 증거를 대체하지 않고, 향후 fill/지갑 정산 자료와 paper P&L의 차이를 비교할 수 있게 하는 실행경계 진단입니다.
next-open pending fill은 signal 시점의 `signalQuote`와 실제 fill-cycle의 `entryQuote`를 분리합니다. spread guard가 켜진 상태에서 fill-cycle quote가 누락·invalid·timestamp 불명·ceiling 초과이면 해당 candle의 fill을 뒤늦게 소급하지 않고 `pendingEntryQuoteBlocked`와 void reason을 기록합니다. 이 차단은 모델 실행경계의 보수적 처리이며 실제 주문 거절·체결 결과가 아닙니다.

스캘핑 validation 비용 가정과 read-only orderbook 관측을 혼동하지 않도록 `npm run research:quote-cost-compatibility`를 추가했습니다. 이 명령은 기본 r2 대상 BTC/ETH/XRP/SOL의 quote report를 읽어 시장별 p95/max spread, 최소 표본, freshness, per-side adverse-slippage budget, 모델 왕복 비용을 별도 필드로 출력합니다. `0.0005` fee와 `0.001` slippage에서는 왕복 모델 비용이 `0.3%`, spread 비교 예산이 `0.2%`이며, 2026-09-17T20:54:45Z 실행에서 네 시장 모두 `5/5`·fresh·p95 예산 이내였습니다(BTC `0.0040%`, ETH `0.0296%`, XRP `0.0559%`, SOL `0.0717%`). 이 결과는 호가 품질과 비용 가정의 compatibility 진단일 뿐 실제 fill·partial fill·wallet settlement·실현손익이 아니며, `ready=true`여도 주문이나 promotion을 허용하지 않습니다. 재현 report는 `/private/tmp/coinpilot-quote-cost-compatibility-r2-20260918.json`입니다.

paper 손익이 완료 일봉 종가와 고정 비용만으로 계산되는 실행 현실성 공백을 별도 `MOMO_SHADOW_EXECUTION_MODEL`로 분리했습니다. 기본 `candle_close`는 기존 계약을 그대로 유지하고, 명시적인 research-only `quote_cross`만 best ask를 long entry 가격으로, best bid를 exit와 보수적 mark 가격으로 사용합니다. quote가 없거나 가격·timestamp를 검증할 수 없으면 candle 가격으로 fallback하지 않고 해당 entry/exit/mark를 fail-closed하며 차단 횟수와 마지막 사유를 ledger/API/UI/CLI에 남깁니다. 거래에는 `decisionEntryPrice`/`decisionExitPrice`와 모델 가격을 함께 보존하고, 호가 crossing evidence도 계속 `실제 fill 아님`으로 표시합니다. 이 모델은 historical candle replay나 live 주문에 연결하지 않으며, 실제 체결·부분 체결·지갑 정산을 대체하지 않습니다. 기존 owner는 재시작하지 않고, 새로 명시적으로 시작하는 별도 연구 owner에서만 사용할 수 있습니다.
이 실행모델을 forward에서 별도로 확인할 수 있도록 `fixed_2d_quote_cross` readiness/A/B를 추가했습니다. 계약은 fixed 2일·next-open·cost `0.3%`·benchmark-off 청산·drawdown `15%`를 유지하고, `MOMO_SHADOW_EXECUTION_MODEL=quote_cross`와 spread `0.5%` ceiling만 추가합니다. 현재는 benchmark gate가 닫혀 있어 장부를 만들지 않으며, gate가 열린 뒤에도 quote 경계가 기록된 거래만 별도 평가합니다. 이 후보는 orderbook historical cache가 없으므로 과거 수익률을 생성하거나 기존 runtime을 교체하지 않습니다.
현재 fixed/regime owner에서 `-5.15%`, `-9.20%` 실현 손실과 `-7.17%` 미청산 tail이 관찰되어 `fixed_2d_loss_cap` readiness/A/B도 별도로 추가했습니다. 이 후보는 기존 fixed 2일 계약의 cost `0.3%`·next-open·benchmark-off·drawdown `15%`를 유지하고, 완료 일봉 종가 기준 `stopLossPercent=4%`만 추가합니다. 새 400/800일 sweep에서 4%는 6%보다 두 window의 MDD가 낮았고, 800일 aggregate return도 높았지만 400일에서는 6%가 근소하게 높았으므로 risk-first 연구 가설로만 선택했습니다. 일중 고가/저가 체결이나 실제 fill을 재현하지 않으며, benchmark gate가 열리기 전에는 ledger를 만들지 않습니다. 4%는 현재 tail 손실을 줄일지 확인하기 위한 연구 가설일 뿐 자동 승격값이 아닙니다. 재현 report는 `/private/tmp/coinpilot-stop-loss-sweep-daily-400-20260917.json`과 `/private/tmp/coinpilot-stop-loss-sweep-daily-800-20260917.json`입니다.
각 paper book의 API/UI에는 `lossCapCounterfactual`도 표시됩니다. 이는 관측된 완료 거래 수익률을 4% 하한으로 단순 절단한 가상 비교와 현재 미청산 mark의 cap 초과 여부만 보여주며, realized P&L·intraday stop fill·wallet settlement에 합산하지 않습니다. malformed return은 표본에서 제외하고, 금액 delta도 모든 entry size가 확인될 때만 `estimated`로 표시합니다.

data-quality도 현재 cycle 값만 덮어쓰지 않고 `dataQualityObservationCycles`, `dataQualityValidCycles`, `dataQualityInvalidCycles`, `dataQualityInvalidReasonCounts`를 누적합니다. 과거 한 번이라도 일봉 grid가 깨졌거나 시장 검토가 차단된 장부는 최신 cycle이 회복되어도 promotion blocker를 유지하고, UI/CLI에서 정상/실패 cycle과 누적 `market checks blocked`를 분리해 표시합니다. `dataQualityBlocked`가 남아 있지만 새 telemetry 기간의 invalid cycle이 없고 현재 grid가 valid인 legacy owner는 `blockedChecksAttribution=legacy_unclassified`와 `과거 owner 원인 미분류`로 표시합니다. 이는 blocker를 제거하는 완화가 아니라, legacy counter를 현재 data-quality 실패로 잘못 해석하지 않게 하는 provenance 표시입니다. promotion blocker 문구도 `일봉 품질 실패 N/M cycle`과 `시장 검토 차단 K회`를 별도 label로 보존해 정상 cycle `0`건을 품질 실패처럼 오인하지 않게 합니다. runner의 legacy `dataQualityBlocked`는 시장별 검토 건수이지 실제 주문·체결 횟수가 아니므로, API는 정확한 `blockedChecks`와 attribution도 제공하고 이 counter를 수익성이나 체결 성공률로 환산하지 않습니다.

구버전 shadow owner의 누적 fetch 오류도 별도 표시합니다. 2026-09-16 현재 fixed/regime/benchmark ledger에는 각각 `fetchErrors=129/122/110`이 남아 있지만, 이 프로세스들은 network circuit guard가 추가되기 전에 시작되어 `failureStreak`·`circuitBreaks` telemetry를 기록하지 않았습니다. 현재 cycle의 12시장 daily grid가 `valid`라는 사실은 해당 누적 네트워크 오류를 지우거나 성공률로 환산하지 않습니다. status/API는 누적값을 `network fetch errors`와 `benchmark.fetchErrors`로 계속 노출하고, preflight warning은 누적값이 아니라 `networkFetchFailureStreak`/`networkFetchCircuitOpen`이 현재 활성일 때만 `benchmark_fetch_failures_active:N`으로 표시합니다. 다음 자연 재시작부터 새 consecutive-failure/circuit telemetry와 분리해 확인합니다. 누적 오류 자체는 수익성 증거나 즉시 재시작 승인 사유가 아니며, 신규 candidate 실행은 benchmark gate와 owner/lock 조건을 별도로 계속 적용합니다.

status CLI에서 `[RUNNING]`은 owner process와 heartbeat가 살아 있다는 운영 상태일 뿐 evidence 유효성을 뜻하지 않습니다. `configDrift`가 남은 장부는 관찰을 계속하더라도 CLI에서 `final not-ready:config_drift`와 `evidence not eligible for A/B or promotion`, read-only API/web/mobile/PWA에서는 `status=증거 보류`로 표시하며, API의 설정 변경 blocker와 같은 의미로 해석합니다. 따라서 drift가 있는 legacy owner의 실현손익·미청산 mark를 새 config의 수익성 표본과 합치지 않습니다.

보존된 `/private/tmp/coinpilot-momentum-shadow-fixed.log`, `...-regime.log`, `...-benchmark.log`의 실패 burst는 대부분 `ENOTFOUND`였고 benchmark에는 `ECONNABORTED`도 관측됐습니다. 각 요청은 `requestWithRetry`에서 1초·2초 backoff를 거친 뒤 다음 요청으로 진행했고, 이후 cycle log 자체는 완료됐습니다. 그러므로 "cycle이 완료됨"은 모든 시장 fetch가 성공했다는 뜻이 아니며, 이 오류는 전략 손익이나 시장 gate 신호가 아니라 Upbit HTTP/이름해석/timeout 경계의 operational evidence로 분리합니다. 새 guard가 적용된 다음 owner는 같은 코드가 시장별 연속 실패 streak와 circuit open으로 기록되는지 확인하고, legacy log의 누적 숫자와 직접 합산하지 않습니다.

동일 금액 진입의 고변동 종목 risk를 줄이기 위해 entry 직전 완료 close 수익률의 표준편차를 목표값과 비교하는 `volatilityTargetPercent`도 추가했습니다. target `0.75/1.0%`, lookback `7/14/21/28일`은 비용 `0.3%`와 400/800일 continuous 32-segment에서 모두 candidate였고, canonical lookback 14일·target 1%는 MDD가 400일 `1.550%`, 800일 `2.408%`까지 감소했습니다. target `1.25%` 이상은 일부 800일 segment에서 worst floor를 깨기 시작하므로 기본값을 바꾸지 않습니다. 이 scaling은 연구와 별도 paper A/B owner에서만 사용할 수 있으며, target unset은 legacy 고정 비중을 유지합니다. 기존 baseline은 800일 32-segment에서 worst `-6.511%`로 tail risk가 드러났습니다.

volatility target `1.0%/14일`에 close-based stop-loss `1/2/3/5/7%`를 붙인 stress도 비교했습니다. 400/800일 continuous 16/32-segment와 비용 `0.3%`에서 모든 값이 형식상 candidate였지만, `1%`는 400/800일 수익을 낮추고 `3%`는 800일 MDD를 낮추는 대신 수익이 감소했습니다. `5/7%`는 800일 aggregate가 baseline보다 소폭 높아도 400일에서 일관된 우위가 없었습니다. stop-loss는 현재 기본 A/B runner contract에 연결하지 않고, `DAILY_MOMENTUM_ROBUSTNESS_STOP_LOSS_PERCENT`를 통한 research-only 축으로 유지합니다.

benchmark를 gate 전용으로 두고 tradable entry에서 제외하는 `excludeBenchmarkFromEntries` 보완장치도 확인했습니다. 400일 continuous는 `+4.501%`/PF `1.476`에서 `+5.529%`/PF `1.595`로, 800일은 `+26.495%`/PF `1.657`에서 `+26.849%`/PF `1.650`으로 개선되었지만, 400일 worst segment가 `-2.176%`로 floor `-2%`를 넘었습니다. breadth에서 benchmark를 세는지 여부도 분리해 비교했으나 이 cache에서는 동일 결과였습니다. aggregate 개선만으로는 충분하지 않으므로 이 옵션은 risk A/B research 후보로만 보존하고, 현재 forward/runtime contract에는 연결하지 않습니다.

2026-09-16 최신 완료 일봉 cache에서 현재 fixed owner의 손실 원인을 분리하기 위해 `fixed` 3일 종료에 benchmark gate `2%`를 먼저 붙였고, 400/800일 27개 조합이 모두 `HOLD`가 되었습니다. gate만으로는 400일 MDD가 최대 `19.40%`, 800일은 최대 `33.24%`, 최악 continuous segment는 `-5.620%~-7.173%`까지 내려가므로 손실을 해결하는 보완장치로 채택하지 않습니다. 같은 fixed 3일 종료에 현재 risk-capped 노출(`positionFraction=0.125`, `maxPositions=2`, `cooldown=3일`, `minUpBars=2`, `maxPortfolioDrawdownPercent=15`)을 적용하면 continuous 기준 400일 9/9, 800일 6/9가 `SHADOW_CANDIDATE`로 회복되지만, 최고 조합도 `+4.026%/+25.702%`로 현재 regime 계약의 `+4.501%/+25.849%`보다 두 window 모두 낮습니다. independent segment에서는 두 window의 9개 조합이 모두 마지막 미청산 `unknown_boundary_position` 때문에 `HOLD`였으므로 fixed-risk-capped를 별도 forward owner로 자동 시작하지 않고 research-only 진단으로 보존합니다. 이 실험은 fixed baseline의 노출 과다가 tail risk의 원인일 가능성은 보여 주지만 fixed exit가 더 높은 alpha를 가진다는 증거는 아니며, 기존 owner·runtime 기본값·promotion gate는 변경하지 않습니다. 재현 report는 `/private/tmp/coinpilot-daily-momentum-current-400d-fixed-gate-refresh.json`, `/private/tmp/coinpilot-daily-momentum-current-800d-fixed-gate-refresh.json`, `/private/tmp/coinpilot-daily-momentum-current-400d-fixed-risk-capped-refresh.json`, `/private/tmp/coinpilot-daily-momentum-current-800d-fixed-risk-capped-refresh.json`, `/private/tmp/coinpilot-daily-momentum-current-400d-fixed-risk-capped-independent-refresh.json`, `/private/tmp/coinpilot-daily-momentum-current-800d-fixed-risk-capped-independent-refresh.json`입니다.

## 환경 변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `DASHBOARD_PORT` | 3000 | 웹 대시보드 포트 |
| `DASHBOARD_TOKEN` | unset | LAN/mobile/API 접근 토큰; 비어 있으면 loopback 전용 |
| `DASHBOARD_HOST` | token 있으면 `0.0.0.0`, 아니면 `127.0.0.1` | 대시보드 bind host |
| `DASHBOARD_TLS_CERT_FILE` | unset | HTTPS 인증서 또는 fullchain PEM 경로; key와 함께 설정해야 함 |
| `DASHBOARD_TLS_KEY_FILE` | unset | HTTPS private key PEM 경로; Git에 저장하지 않음 |
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
| `SCALP_PORTFOLIO_VOLATILITY_LOOKBACK_CANDLES` | 20 | shared portfolio research에서 entry 직전 완료봉 변동성을 계산할 lookback |
| `SCALP_PORTFOLIO_VOLATILITY_TARGET_PERCENT` | 0 (disabled) | 변동성이 target을 넘을 때만 진입 비중을 축소하는 research-only overlay; runtime/live 기본값에는 연결하지 않음 |
| `SCALP_PORTFOLIO_REFERENCE_BREAK_EXIT_PERCENT` | 0 (disabled) | signal reference보다 지정 폭 아래로 내려가면 청산하는 research-only price invalidation exit |
| `SCALP_PORTFOLIO_REFERENCE_BREAK_MIN_HOLD_MINUTES` | 0 | reference-break exit를 적용하기 전 최소 보유 시간(분); 기본 0은 기능 비활성 상태 |
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
| `SCALP_PAPER_DIAGNOSTIC_SHADOWS_ENABLED` | true | relaxed `shadow`/`looseShadow` 진단 장부 사용 여부; false는 별도 strict-only forward cohort용 |
| `SCALP_VARIANT_REPORT_FILE` | unset | same-window scalping variant 연구 report 경로; API/web/mobile/PWA read-only 참고 화면으로만 노출 |
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
| `MOMO_SHADOW_RELATIVE_TREND_MIN_PERCENT` | unset | benchmark 대비 종목의 추가 7일 추세 요구치; 설정 시 benchmark/상대추세 미확인 데이터를 fail-closed |
| `MOMO_SHADOW_CANDIDATE_PROFILE` | `baseline` | candidate preflight/launcher가 공유하는 sealed profile: `baseline`, `quote_cross`, `loss_cap`, `loss_cap_no_doge`; 지정 profile과 다른 target/config로 시작하지 않음 |
| `MOMO_SHADOW_CANDIDATE_SLOT_FILE` | `.paper-momentum-shadow-candidate.lock` | candidate launcher 공유 단일 실행 slot; 살아 있는 후보가 있으면 다른 후보는 fail-closed |
| `MOMO_SHADOW_BREADTH_MIN` | 후보 launcher 기본 2 | 800일 continuous robustness에서 선택한 ordinary candidate의 최소 동시 상승 시장 수 |
| `MOMO_SHADOW_MIN_UP_BARS` | 후보 launcher 기본 2 | 진입에 필요한 연속 완료 상승 일봉 수 |
| `MOMO_SHADOW_EXIT_ON_BENCHMARK_OFF` | false | regime shadow에서 benchmark gate가 닫히면 열린 포지션도 연구용 청산 |
| `MOMO_SHADOW_COOLDOWN_AFTER_LOSS_DAYS` | unset | 손실 청산 뒤 해당 시장의 신규 진입을 막는 일수; 별도 candidate ledger에서만 사용 |
| `MOMO_SHADOW_MAX_PORTFOLIO_DRAWDOWN_PERCENT` | unset | peak marked equity 기준 portfolio drawdown stop; 발동 후 해당 owner의 신규 진입을 중지 |
| `MOMO_SHADOW_VOLATILITY_LOOKBACK_DAYS` | 14 | paper candidate의 entry 직전 close-to-close volatility를 계산할 lookback |
| `MOMO_SHADOW_VOLATILITY_TARGET_PERCENT` | unset | volatility가 목표를 넘을 때 position size를 선형 축소; unset은 legacy 고정 비중 |
| `MOMO_SHADOW_ENTRY_EXECUTION` | `close` | shadow runner의 entry 체결 경계; `next_open`은 signal 다음 일봉 opening price에 pending fill |
| `MOMO_SHADOW_EXECUTION_MODEL` | `candle_close` | paper 가격 모델; `quote_cross`는 명시된 research owner에서 best ask entry·best bid exit/mark를 사용하고 quote 불명 시 fail-closed |
| `MOMO_SHADOW_MAX_HOLD_HOURS` | fixed `72` / regime `8760` | raw shadow runner의 fixed 최대 보유시간; 2일 A/B 후보는 `48`로 별도 고정 |
| `MOMO_SHADOW_MAX_ENTRY_GAP_PERCENT` | 0 | next-open에서 signal close 대비 양의 opening gap ceiling; 0은 비활성, 별도 후보는 0.2 |
| `MOMO_SHADOW_MAX_DAILY_CANDLE_AGE_HOURS` | 36 | 완료 일봉이 끝난 지 허용 시간; 초과하거나 시장별 최신 시각이 다르면 신규 진입을 차단 |
| `MOMO_SHADOW_MAX_SPREAD_PERCENT` | 0 | optional best bid/ask spread ceiling; 0은 비활성, 초과 시장만 신규 진입 차단 |
| `MOMO_SHADOW_REQUEST_INTERVAL_MS` | 500 | 한 shadow owner가 시장별 public API 요청 사이에 두는 간격; 여러 owner 합산 rate limit 완화 |
| `MOMO_SHADOW_MAX_CONSECUTIVE_FETCH_FAILURES` | 3 | 한 cycle에서 연속 daily fetch가 이 횟수만큼 실패하면 남은 요청을 중단하고 network circuit을 기록; 다음 poll에서 재시도하며 전략/포지션 계약은 바꾸지 않음 |
| `MOMO_SHADOW_MAX_CYCLE_DURATION_MS` | 600000 | daily fetch/decision cycle의 wall-clock 상한; 초과하면 마지막 stage/market을 stop evidence에 남기고 owner를 `cycle_timeout`으로 fail-closed한 뒤 다음 supervised 재시작에서 재시도하며 전략/포지션 계약은 바꾸지 않음 |
| `MOMO_SHADOW_QUOTE_SAMPLES` | 5 | read-only orderbook snapshot 반복 횟수; `npm run research:momentum-shadow:quotes`에서만 사용 |
| `MOMO_SHADOW_QUOTE_INTERVAL_MS` | 2000 | 반복 quote snapshot 사이 간격(ms) |
| `MOMO_SHADOW_QUOTE_MAX_SPREAD_PERCENT` | 0.5 | quote snapshot report에서 초과 횟수를 집계할 ceiling (%) |
| `MOMO_SHADOW_QUOTE_MAX_AGE_SECONDS` | 900 | read-only quote report를 최신으로 표시할 최대 나이(초); UI/readback 전용이며 runner 주문 gate와 별개 |
| `MOMO_SHADOW_RUNTIME_DIR` | `.coinpilot-runtime/momentum-shadow` | 세션 정리와 분리해 quote report/history를 보존하는 ignored runtime 디렉터리 |
| `MOMO_SHADOW_QUOTE_REPORT_FILE` | `.coinpilot-runtime/momentum-shadow/quote-quality.json` | quote snapshot report 경로; 명시 override가 없으면 persistent runtime 사용 |
| `MOMO_SHADOW_QUOTE_HISTORY_FILE` | `.coinpilot-runtime/momentum-shadow/quote-history.jsonl` | 반복 quote summary를 append-only로 보존하는 persistent history 경로 |
| `SCALP_QUOTE_COMPATIBILITY_MARKETS` | `KRW-BTC,KRW-ETH,KRW-XRP,KRW-SOL` | 스캘핑 비용 compatibility를 읽기 전용으로 비교할 시장 목록 |
| `SCALP_QUOTE_COMPATIBILITY_MIN_SAMPLES` | `5` | 시장별 p95 compatibility 판정에 필요한 최소 quote 표본 수 |
| `SCALP_QUOTE_COMPATIBILITY_MAX_AGE_SECONDS` | `900` | compatibility report가 fresh로 인정되는 quote report 최대 나이 |
| `SCALP_QUOTE_COMPATIBILITY_OUTPUT_FILE` | unset | 지정 시 compatibility JSON을 추가 저장; 미지정 시 stdout만 사용 |
| `LIVE_EXECUTION_EVIDENCE_FILE` | `.coinpilot-runtime/live-execution/evidence.jsonl` | automatic/redesigned UI live order의 접수·fill evidence append 경로; settlement는 별도 readback 필요 |
| `MOMO_SHADOW_EVIDENCE_SNAPSHOT_FILE` | unset | `research:momentum-shadow:verify-evidence`가 검사할 브라우저 export snapshot 경로 |
| `MOMO_SHADOW_EVIDENCE_MAX_AGE_SECONDS` | 900 | evidence verifier가 `fresh=true`로 허용할 snapshot 최대 나이(초) |
| `MOMO_SHADOW_MIN_RESEARCH_DAYS` | 14 | read-only shadow 전환 진단에서 요구하는 최소 관찰 기간(일); 주문 gate와 별개 |
| `MOMO_SHADOW_NEXT_OPEN_DIR` | `.paper-momentum-shadow-next-open-v1` | cost-robust next-open diagnostic 후보의 격리 ledger 경로 |
| `MOMO_SHADOW_VOLATILITY_DIR` | `.paper-momentum-shadow-vol-target-v1` | volatility target A/B paper ledger 경로; 웹/모바일 read-only 비교에도 사용 |
| `MOMO_SHADOW_FIXED_HOLD_DIR` | `.paper-momentum-shadow-fixed-hold-2d-v1` | cost 0.3%·next-open·48시간 종료 A/B paper ledger 경로 |
| `MOMO_SHADOW_FIXED_HOLD_LOSS_CAP_DIR` | `.paper-momentum-shadow-fixed-hold-2d-loss-cap-v1` | fixed 2일 후보의 완료 일봉 종가 손실 상한 4% A/B paper ledger 경로; intraday fill·승격 근거 아님 |
| `MOMO_SHADOW_FIXED_HOLD_LOSS_CAP_NO_DOGE_DIR` | `.paper-momentum-shadow-fixed-hold-2d-loss-cap-no-doge-v1` | 400/800일 DOGE 제외 loss-cap 후보의 격리 paper ledger 경로; historical 후보일 뿐 intraday fill·승격 근거 아님 |
| `MOMO_SHADOW_FIXED_HOLD_SPREAD_DIR` | `.paper-momentum-shadow-fixed-hold-2d-spread-v1` | fixed 2일 후보의 실제 호가 spread `0.5%` guard A/B paper ledger 경로 |
| `MOMO_SHADOW_FIXED_HOLD_RELATIVE_DIR` | `.paper-momentum-shadow-fixed-hold-2d-relative-v1` | fixed 2일 후보의 benchmark 상대추세 `0%` guard A/B paper ledger 경로 |
| `MOMO_SHADOW_FIXED_HOLD_QUOTE_CROSS_DIR` | `.paper-momentum-shadow-fixed-hold-2d-quote-cross-v1` | fixed 2일 후보의 best ask 매수·best bid 매도/평가 quote-cross A/B paper ledger 경로 |
| `PAPER_SMOKE_MARKETS` | 미설정 | `FRESH_FROM_LEDGER`를 지정하면 이전 paper 원장 freshness 코호트 선택; 그 외에는 명시 시장 목록 또는 `ALL` |
| `PAPER_SMOKE_FRESHNESS_LEDGER` | 미설정 | freshness 코호트 기준으로 읽을 이전 격리 paper ledger 경로 |
| `PAPER_SMOKE_MIN_FRESHNESS_OBSERVATIONS` | 100 | 코호트 선택에 필요한 시장별 최소 freshness 관측 수 |
| `PAPER_SMOKE_MAX_STALE_RATE` | 0.05 | 새 forward 코호트 선택에서 허용하는 freshness 차단률 상한(0~1) |
| `PAPER_EXIT_EVIDENCE_OUTPUT_FILE` | `/private/tmp/coinpilot-paper-exit-evidence.json` | paper ledger의 실제 exit reason·P&L·MFE/MAE·보유시간을 집계하는 research-only report 경로 |
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

2026-09-18 추가 연구: 진입 품질 rejection reason에 대응하는 `minRsiRecovery`·`minCloseStrength` 단일축을 같은 30,000개 filled BTC/ETH window에서 비교했습니다. `minRsiRecovery=0/1/3`은 baseline과 동일하게 합산 `-0.0145%`/18 trades였고, recovery filter가 실제 진입 집합을 바꾸지 않았습니다. `minCloseStrength=0.55`는 BTC holdout `+0.0173%`/10 trades와 ETH `-0.0232%`/9 trades로 합산 `-0.0059%`, `0.75`는 BTC `+0.0163%`/8 trades와 ETH `-0.0232%`/9 trades로 합산 `-0.0069%`였습니다. `recovery=1·closeStrength=0.55` 조합도 완화 단독과 동일했습니다. 모든 variant가 두 시장 training gate를 실패했고, segmented full window도 baseline BTC/ETH `-0.0906%/-0.0518%`, close `0.55` `-0.0820%/-0.0518%`, close `0.75` `-0.0709%/-0.0542%`로 전부 음수였습니다. 따라서 runtime 기본값 `minRsiRecovery=2`, `minCloseStrength=0.65`를 유지하며, 결과는 research-only로 보존합니다. 재현 report는 `/private/tmp/coinpilot-scalping-variant-study-recovery-strength-btc-eth-20260918.json` 및 `/private/tmp/coinpilot-scalping-segments-recovery-strength-{baseline,rsi0,rsi1,rsi3,close055,close075,rsi1close055}-20260918.json`입니다.

2026-09-18 추가 signal-quality screening: RSI threshold·oversold lookback·rebound 하한·signal range·trend/follow-through를 동일 candle window에서 교차 비교했습니다. 30,000개 filled BTC/ETH에서 `rsi_40`/`rsi_45`는 각각 `-0.0882%/-0.1183%`, `oversold_lookback_3`은 `-0.0513%`, `rebound_10`은 `-0.1187%`로 baseline보다 악화됐습니다. `rebound_30/35/40`은 합산 `+0.0161%/+0.0416%/+0.0092%`였지만 각각 6/3/1 trades뿐이었고 두 시장 training gate를 통과하지 못했습니다. 10,080개 최신 BTC/XRP window에서도 `rebound_30/35`는 합산 `+0.0447%`였지만 3 trades, `range_floor_20`은 `+0.0232%`로 baseline과 동일한 수준이었습니다. `trend_nonnegative`·`trend_positive_01/02`는 진입을 1건 또는 0건으로 줄였고, `next_candle_followthrough`는 두 window에서 각각 `-0.0330%/-0.0038%`였습니다. segmented full replay에서도 `rebound_35`의 BTC/ETH는 `+0.0324%/+0.0164%`지만 각각 2/3 trades, BTC/XRP는 `+0.0324%/+0.0119%`지만 각각 2/1 trades로 소표본이었고, baseline·range floor·follow-through에는 시장별 음수 결과가 남았습니다. 따라서 반등 하한 상향은 표본을 줄여 양수처럼 보이게 한 것이며, 시장·거래수·구간 일관성을 증명하지 못합니다. runtime 기본값과 forward contract는 유지하고, 모든 결과를 research-only로 보존합니다. 재현 report는 `/private/tmp/coinpilot-scalping-variant-study-signal-quality-btc-eth-20260918.json`, `/private/tmp/coinpilot-scalping-variant-study-signal-quality-btc-xrp-20260918.json`, `/private/tmp/coinpilot-scalping-segments-signal-quality-btc-eth-rebound35-20260918.json`, `/private/tmp/coinpilot-scalping-segments-signal-quality-btc-xrp-rebound35-20260918.json`입니다.

같은 비용 모델(`fee 0.05%/side + adverse slippage 0.10%/side`, 왕복 `0.30%`)에서 최소 반등률 `0.15/0.20/0.25/0.30/0.35/0.40/0.50%`를 tuned selection 없이 고정하고 3-fold·confidence gate로 다시 비교했습니다. 최신 10,080개 BTC/XRP cache는 각각 `-0.0319%/24`, `-0.0115%/17`, `-0.0027%/12`, `+0.0287%/5`, `+0.0447%/3`, `+0.0200%/1`, `+0.0200%/1 trades`였고, 30,000개 filled BTC/ETH cache는 `-0.0707%/27`, `+0.0003%/14`, `+0.0277%/8`, `+0.0161%/6`, `+0.0416%/3`, `+0.0092%/1`, `0%/0 trades`였습니다. 모든 threshold가 `0/3 fold`이고 첫 fold부터 training confidence gate를 실패했으며, 높은 threshold의 양수 aggregate는 표본 감소로 얻은 소표본 결과입니다. 따라서 `minReboundPercent`를 비용보다 높게 올리는 cost-aware 후보를 runtime·forward owner에 연결하지 않고, 현재 `0.15%` 계약도 유지한 채 새로운 signal/exit 가설을 별도 검증합니다. 재현 report는 `/private/tmp/coinpilot-scalping-rebound-threshold-cost-aware-20260918.json`입니다.

2026-09-18 portfolio regime-gate screening: 동일한 shared-KRW portfolio·3-fold walk-forward에서 기본 signal contract의 시장 regime gate를 고정 비교했습니다. 최신 BTC/XRP 10,080개 window는 gate off `-0.0319%`/24 trades, `minReturn=0` `-0.0052%`/16 trades·regime block 8회, `minReturn=0.2%` `+0.0051%`/2 trades·block 23회, breadth `0.75` `+0.0070%`/20 trades·block 4회였지만 모두 `0/3 folds`와 confidence/sample blocker로 보류됐습니다. 30,000개 filled BTC/ETH에서도 gate off `-0.0707%`/27 trades, `minReturn=0` `-0.0495%`/20 trades, `minReturn=0.2%` `+0.0053%`/5 trades, breadth `0.75` `-0.0692%`/23 trades로 어느 조합도 양쪽 window에서 수익성·통계 gate를 통과하지 못했습니다. tuned 864-candidate multi-fold도 current holdout `-0.0288%`/10 trades, filled holdout `+0.0022%`/4 trades로 `0/3 folds`였고, regime-enabled config가 모든 fold에서 일관되게 선택되지 않았습니다. 따라서 regime gate는 손실 회복이나 수익 증명 장치가 아니라 필요 시 별도 방어 진단으로만 유지하며, runtime 기본값·forward owner·live gate를 변경하지 않습니다. 재현 report는 `/private/tmp/coinpilot-scalping-portfolio-regime-axis-current-btc-xrp-{off,regime0,regime02,regimebreadth75}-20260918.json`, `/private/tmp/coinpilot-scalping-portfolio-regime-axis-filled-btc-eth-{off,regime0,regime02,regimebreadth75}-20260918.json`, tuned `/private/tmp/coinpilot-scalping-portfolio-regime-current-tuned-20260918.json`, `/private/tmp/coinpilot-scalping-portfolio-regime-filled-tuned-20260918.json`입니다.

2026-09-18 forward cohort 재집계는 전체 `90 sessions`·strict `43 trades`·diagnostic `771 trades`를 읽었고, 서로 다른 config·시장·기간의 손익을 합산한 참고값은 `+5,754.40 KRW`였습니다. 그러나 active/ended 상태, config snapshot, 미청산, continuity를 동시에 통과한 integrity eligible strict cohort는 `0 sessions`·`0 trades`·`0 configs`였고 profitability evidence cohort도 `0`이었습니다. 따라서 strict 양수 aggregate는 실제 수익성 증거가 아니며, 현재 r2의 4건 양수도 최소 표본·관찰기간을 충족하기 전에는 승격하지 않습니다. 재현 report는 `/private/tmp/coinpilot-paper-forward-cohort-current-20260918-refresh.json`입니다.

2026-09-18 tuned portfolio의 소표본 과적합을 줄이기 위해 통계 confidence를 요구하는 multi-fold tuning에 `minimumTradeCount=10` 선택 guard를 적용했습니다. 이전 tuned report가 fold별 training `1~6 trades` 후보를 선택한 뒤 confidence gate에서 실패하던 경로를, eligible 후보만 먼저 ranking하고 eligible 후보가 없을 때만 `minimumTradeFallback=true`로 명시하도록 바꿨습니다. 실제 864-candidate 재실행에서 current BTC/XRP는 eligible 후보 `24/72/144`개를 사용했지만 holdout `-0.0805%`/16 trades/`0/3 folds`, filled BTC/ETH는 eligible 후보 `112/136/232`개를 사용했지만 holdout `-0.0040%`/12 trades/`0/3 folds`였습니다. 두 window 모두 fallback 없이도 training confidence·수익성 gate를 통과하지 못했으므로, 이 guard는 과적합 선택을 줄이는 검증 품질 장치이지 수익성 개선 로직이 아닙니다. runtime·forward owner·live gate는 변경하지 않고, report에는 `minimumTradeCount`, `eligibleCandidateCount`, `minimumTradeFallback`을 보존합니다. 재현 report는 `/private/tmp/coinpilot-scalping-portfolio-tuning-sampleguard-current-20260918.json`과 `/private/tmp/coinpilot-scalping-portfolio-tuning-sampleguard-filled-20260918.json`입니다.

2026-09-18 scalping portfolio cost sensitivity: 동일한 fixed signal contract와 3-fold walk-forward에서 수수료·adverse slippage만 바꿔 실행 경계를 확인했습니다. 최신 BTC/XRP 10,080개는 fee `0.05%`·slippage `0.10%` baseline holdout `-0.0319%`에서 slippage `0.15%` `-0.0797%`, fee `0.10%`·slippage `0.15%` `-0.1275%`, fee `0.10%`·slippage `0.20%` `-0.1752%`로 악화되었습니다. filled BTC/ETH 30,000개도 baseline `-0.0707%`에서 각각 `-0.1396%/-0.1932%/-0.2457%`로 악화되었고, 모든 조합이 `0/3 folds`였습니다. 현재 quote sampler의 전체 p95 spread `0.8889%`와 DOGE 반복 초과 관측은 이 historical slippage 축보다 큰 실행비용 위험을 시사하지만, 호가 관측은 실제 fill·부분 체결·wallet settlement가 아닙니다. 따라서 현재 `SCALP_VALIDATION_FEE=0.05%`·`SCALP_VALIDATION_SLIPPAGE=0.10%` 가정도 실전 비용을 보장하지 않으며, 비용을 낮게 가정한 양수 결과를 runtime·live gate·promotion 근거로 사용하지 않습니다. 재현 report는 `/private/tmp/coinpilot-scalping-portfolio-cost-current-btc-xrp-base-20260918.json`, `/private/tmp/coinpilot-scalping-portfolio-cost-current-btc-xrp-fee10_slip20-20260918.json`, `/private/tmp/coinpilot-scalping-portfolio-cost-filled-btc-eth-base-20260918.json`, `/private/tmp/coinpilot-scalping-portfolio-cost-filled-btc-eth-fee10_slip20-20260918.json`입니다.

2026-09-18 r2 paper ledger의 동일 `시장+signalKey` pairing으로 strict 지연 재확인 결과와 diagnostic 즉시 모델 결과를 비교했습니다. 현재 read-only ledger에서는 strict↔shadow `2쌍` 중 `1건`이 strict 양수에서 shadow 음수로 부호가 바뀌었고, paired 손익 차이(shadow - strict)는 `-355.01 KRW`였습니다. strict↔loose는 `1쌍`만 있어 일반화하지 않습니다. pairing되지 않은 signal과 중복 key는 optimistic match를 만들지 않고 별도로 세며, 이 지표는 실제 fill·partial fill·wallet settlement가 아니라 동일 신호의 modeled outcome 차이를 보여 주는 실행경계 진단입니다. API/UI에는 부호 변경과 paired 손익 차이를 표시하고 `researchOnly=true`, `promoted=false` 경계를 유지합니다.

동일 signal 실행경계 비교를 연구 승격 보강 조건에도 연결했습니다. diagnostic shadow가 활성인 session은 최소 `10쌍`의 비중복 pairing, strict 양수→shadow 음수 부호 변경 `0건`, paired shadow 손익 양수를 모두 충족해야 `executionRobustnessGate`를 통과합니다. strict-only session은 relaxed shadow를 의도적으로 수집하지 않으므로 이 추가 gate를 요구하지 않습니다. 현재 r2는 `2/10쌍`, 양수→음수 `1건`이라 gate가 보류되고 promotion blocker에 표시됩니다. 이 gate는 실제 fill·wallet settlement를 대신하지 않는 보수적 modeled-outcome 조건이며, live 주문 권한은 부여하지 않습니다.

smart 주문에서 여러 시장 중 일부만 체결되면 HTTP `207`과 `success=false`를 반환하고, redesigned UI는 이를 성공 toast가 아닌 warning으로 표시합니다. 전부 미체결이면 `409`이며, 체결된 시장만 실제 fill 정보와 함께 history/전략 상태에 반영합니다. 이는 시장별 부분체결을 전체 주문 성공으로 오인해 수익률을 부풀리는 것을 막는 UI 실행 경계입니다.

2026-09-18 r2 terminal readback: session `paper-1789647748803`은 `00:33:58Z`에 `risk_data_gap`/`RISK_CHECK_STALE`로 fail-closed 종료되었습니다. 최대 risk gap은 `426.771초`였고, analysis continuity는 정상(`totalIncompleteCycles=0`)이었지만 risk continuity가 거짓이므로 이 세션은 promotion cohort에 사용할 수 없습니다. 종료 시 strict는 `4`건 `+4,715.38 KRW`·open `0`, shadow는 `14`건 `-2,992.04 KRW`·open `0`, loose는 `22`건 `-9,867.47 KRW`·diagnostic open `1`이었습니다. strict 양수는 최소 관찰기간·거래수·risk continuity를 충족하지 않은 작은 표본이며 실제 수익성 증거가 아닙니다.

기존 r2 ledger를 재사용하지 않고 `COINPILOT_SEALED_FORWARD_STRICT_ONLY=true ops/run-sealed-forward-rsi.sh .paper-forward-sealed-rsi-strict-only-r1`로 새 strict-only evidence window를 시작했습니다. session `paper-1789697362244`는 현재 cycle `3`, `configSnapshotComplete=true`, `diagnosticShadows.enabled=false`, analysis/risk continuity `true`, interruptions `0`, strict 청산 `0`건으로 진행 중입니다. 이 창은 relaxed sidecar를 수집하지 않는 독립 efficacy 관찰이며, 최소 `7일`·`20건` 청산·95% 통계 하한·연속성·drawdown gate 전에는 전환 후보로 해석하지 않습니다.

실제 Chromium `Page.getAppManifest`와 `Page.getInstallabilityErrors` read-only 진단도 추가했습니다. manifest parse errors와 installability errors가 모두 `[]`, `secureContext=true`, service worker controller가 존재했고 `display-mode=standalone`만 `false`였습니다. 따라서 설치 가능한 PWA까지는 실제 브라우저에서 확인했지만, 로컬 앱 설치 자체는 사용자 승인 없이 실행하지 않았으므로 standalone 설치 완료 증거로 부르지 않습니다.

2026-09-18 최신 archive cohort r3 readback은 전체 `91 sessions`·strict trade `43`건·diagnostic trade `779`건을 읽었습니다. r2는 `risk_data_gap`으로 종료된 보류 세션이고, 새 strict-only r1은 active 상태라 integrity eligible strict cohort는 `0 sessions`·`0 trades`·`0 configs`, profitability evidence cohort도 `0`입니다. strict-only r1의 현재 exit evidence도 strict/shadow/loose 모두 `0 trades`이며, 관찰 표본이 생기기 전에는 튜닝값이나 runtime 로직을 바꾸지 않습니다. 재현 report는 `/private/tmp/coinpilot-paper-forward-cohort-current-20260918-r3.json` 및 `/private/tmp/coinpilot-paper-exit-evidence-strict-only-r1-current.json`입니다.

2026-09-18 strict-only quiet-market readback: active r1의 `/api/paper-validation` read-only observer가 `RUNNING`, `readOnlyObserver=true`, `processAlive=true`, `strict-only=true`를 반환했습니다. cycle `25`까지 `4/4` 시장 분석이 완료되고 `analysisDataHealth.continuityEligible=true`, `riskMonitor.continuityEligible=true`, incomplete/missing market `0/0`이었습니다. signal telemetry는 `oversoldObservations=0`, `strictReboundCandidates=0`, `strictConfirmedCandidates=0`, 고유 signal window `52`이며, unique reason은 전부 `과매도 조건 없음 - 관망`이었습니다. 이는 필터가 유효 신호를 막았다는 evidence가 아니라 현재 window에 전략의 과매도 전제가 발생하지 않은 quiet-market 관측입니다. UI/API는 이 상태를 수익성 표본과 분리해 표시하며, runtime 튜닝이나 live promotion에는 연결하지 않습니다.

2026-09-18 strict-only r1 terminal readback: session `paper-1789697362244`는 `analysis_data_gap`으로 종료되었고 strict 청산은 `0건`이었습니다. 마지막 원인은 `api.upbit.com` DNS `ENOTFOUND`로, batch ticker 실패 `1건`, 4개 시장 missing, 최대 analysis gap `79.305초`였습니다. risk monitor는 실패하지 않았고 이 결과는 strategy profitability가 아니라 network/data continuity 실패로 분류합니다. 기존 r1 ledger는 이 metadata schema 도입 전 세션이므로 소급 수정하지 않습니다.

다음 forward session부터 analysis health는 raw error message를 보존하지 않고 `network_fetch_failed`/`market_analysis_failed` 같은 안전한 failure code, 실패 시장, code별 count를 ledger/API에 기록합니다. 이를 통해 UI에서 `analysis_data_gap`의 원인이 DNS/timeout인지 시장별 분석 실패인지 구분할 수 있지만, 이 정보는 수익성·실제 fill·live promotion evidence로 사용하지 않습니다. 네트워크 read-only probe가 회복되기 전에는 새 `.paper-forward-sealed-rsi-strict-only-r2` owner를 시작하지 않습니다.

2026-09-18 network recovery and strict-only r2 start: read-only Upbit probe가 HTTP `200`을 회복한 뒤 기존 r1 ledger를 재사용하지 않고 `.paper-forward-sealed-rsi-strict-only-r2`에서 session `paper-1789699020487`을 새로 시작했습니다. 첫 cycle에서 `4/4` 시장 분석이 완료되었고 `configSnapshotComplete=true`, `diagnosticShadows.enabled=false`, analysis/risk continuity `true/true`, `failureCode` 없음, interruptions `0`입니다. 이 r2는 r1의 `analysis_data_gap` evidence와 섞지 않으며, 최소 관찰·거래·통계·연속성 gate 전에는 promotion 후보로 해석하지 않습니다.

2026-09-18T04:09:36Z strict-only r2 live readback: cycle `183`, 고유 signal window `376`, 과매도 관측 `4`, strict rebound candidate `2`, confirmed `0`, BUY `0`, strict trade `0`이었습니다. 분석/risk continuity는 계속 `true`이고 failure code도 없습니다. 상태는 초기 `market quiet`에서 `rebound/confirmation gate 대기` 단계로 이동했지만, 새 RSI proximity·signal funnel 필드는 이 세션이 해당 코드 배포 전에 시작되어 ledger에 소급 기록하지 않습니다. 현재 rejection cohort의 고유 window 기준은 `price_rebound_below_threshold 361`, `previous_high_break_failed 293`, `bullish_rebound_not_confirmed 264`, `rsi_recovery_below_threshold 263`이며, 이 숫자는 자동 완화가 아니라 다음 독립 holdout 후보를 고르는 진단 자료입니다.

2026-09-18T04:12:39Z r2 follow-up readback: cycle `189`, 고유 signal window `388`, 과매도 관측 `10`, strict rebound candidate `4`, confirmed `0`, BUY `0`, strict trade `0`으로 진행 중입니다. 새 reason cohort에는 `최소 반등률 미달 + 거래량 확인 실패`가 추가되었고, unique reason은 `양봉/고가 돌파 대기 + 최소 반등률 미달` 3건, `최소 반등률 미달 + RSI 회복폭 미달` 1건, `최소 반등률 미달 + 거래량 확인 실패` 1건입니다. 분석/risk continuity는 계속 `true`이므로 데이터 공백이 아니라 confirmation gate 미충족으로 분류합니다. strict-only owner는 유지하고, historical 30,000개 filled window에서 이미 확인된 `rebound_25`/`volume_15`의 소표본·시장 불일치 결과를 근거로 runtime 완화는 적용하지 않습니다.

## 면책 조항

이 소프트웨어는 교육 및 연구 목적으로 제공됩니다. 암호화폐 거래는 높은 위험을 수반하며, 투자 손실이 발생할 수 있습니다. 투자 결정은 전적으로 사용자의 책임이며, 개발자는 어떠한 손실에 대해서도 책임지지 않습니다.

## 라이선스

비상업적 용도로만 사용 가능합니다. 자세한 내용은 LICENSE 파일을 확인하세요.
