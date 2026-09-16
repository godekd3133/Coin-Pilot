# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Upbit cryptocurrency automated trading system with multi-coin support, backtesting, genetic algorithm optimization, real-time notifications, and web dashboard. Written in Node.js with ES modules. Supports analyzing all 230+ KRW market coins with `TARGET_COINS=ALL`.

## Default Strategy Contract

Market analysis and position-risk clients share a process-wide Upbit rate-limit queue. Risk ticker requests use the priority lane and must receive the next available slot ahead of queued analysis requests; the 120ms safety slot and stale risk fail-closed boundary remain in force.

The default runtime mode is `oversold_reaction_scalping`. It scans the most liquid KRW markets (up to `SCALP_MAX_MARKETS`), analyzes completed 1-minute candles, and only produces a BUY candidate when the immediately previous completed candle (default `SCALP_OVERSOLD_LOOKBACK=1`) was RSI-oversold and the latest completed candle is a bullish rebound with RSI recovery. A 3-candle reaction window remains an explicit holdout candidate, not an assumed improvement. `MultiCoinTrader.confirmScalpingEntry()` waits 1-5 seconds, fetches ticker/candles again, checks the newest candle timestamp against `maxCandleAgeSeconds`, and cancels the entry if the snapshot is missing/stale, the signal changes, retraces, or runs too far upward to chase. The default is DRY_RUN, averaging is disabled, and the legacy news/optimization/backtest loops are disabled in this mode because their score-based contract is not the scalping contract. The adaptive freshness default is 90 seconds for 1-minute candles; a positive `SCALP_MAX_CANDLE_AGE_SECONDS` is stored in the paper config snapshot. Freshness telemetry distinguishes initial `analysis` blocks from delayed `entry_confirmation` blocks, preserves observed age statistics, records insufficient candle data separately from stale snapshots, and retains per-market observed/stale counts for diagnostic review. Signal/rejection telemetry also keeps a `coin:signalKey`-deduplicated `uniqueSignalWindows` view so repeated 5-second cycles are not mistaken for independent 1-minute samples; old ledgers report this coverage as unavailable rather than fabricating history. Insufficient candle responses must not be mistaken for stale feeds when considering market exclusion.

Open positions have an independent ticker-based risk monitor (`SCALP_RISK_CHECK_INTERVAL_MS`, default 1 second) for stop-loss, take-profit, and max-hold exits. It covers both strict positions and diagnostic paper shadow books; it is a safety/latency path, not profitability evidence. If a complete ticker response is unavailable beyond `SCALP_MAX_RISK_DATA_GAP_SECONDS` (default 30 seconds), the loop stops fail-closed and marks forward continuity invalid instead of pretending that max-hold protection remained active. The monitor records an in-flight attempt before awaiting network I/O and also fails closed from the last successful observation when no failure callback has arrived yet; if a late success callback arrives first, it retroactively records the gap as `RISK_CHECK_STALE` and does not restore continuity. Normal successful risk timestamps are throttled to a persistence cadence no slower than five risk intervals so a read-only Observer does not mistake an old file for a healthy current observation. An idle session with no open positions is not treated as a risk outage. Paper promotion still requires the historical and forward gates. The optional `momentum_breakout` signal profile is a separate diagnostic contract; it does not relax the default RSI-rebound profile and cannot authorize live orders without a matching fixed-config holdout.

`src/research/higherTimeframeMomentum.js` and `npm run research:htf-momentum` are a separate research-only direction lane. They aggregate a contiguous base-candle cache into completed 1-hour/4-hour bars, require a higher-timeframe RSI/momentum bar and a positive own-market trailing trend, enter on a later base candle, simulate fees/slippage/OHLC exits/walk-forward folds, and also replay the selected markets through one shared KRW balance and max-position cap. This lane is not the scalping strategy, never writes the live-gate report, and always returns `promoted=false`; even an apparently positive full-window or portfolio result must not be promoted when any market/fold, confidence, data-quality, grid, or boundary condition fails.

Analysis completeness has its own fail-closed boundary (`SCALP_MAX_ANALYSIS_DATA_GAP_SECONDS`, default 60 seconds in scalping mode). A cycle is complete only when every configured market returns an analysis object; a batch ticker failure is acceptable if individual fallback requests recover all markets. Persistent partial cycles stop paper/live observation even with no open position and persist `analysisDataHealth` plus the missing-market telemetry, so network starvation cannot be counted as valid forward evidence.

The delayed scalping revalidation must persist `entryConfirmationAttempts`, `entryConfirmationSucceeded`, `entryConfirmationCancelled`, `entryConfirmationReasons`, and the last outcome. A confirmed candidate that never becomes an order must remain attributable to stop, request, payload, freshness, or strategy-validation cancellation; do not infer an order or a fill from `strictConfirmedCandidates` alone. The paper UI may summarize this telemetry, but it is execution-quality evidence rather than profitability evidence.

The relaxed `shadow` and `looseShadow` books must also apply the configured strict execution boundary before opening a diagnostic position: reject a signal when the observed price exceeds `maxEntryRetracePercent` or `maxEntryChasePercent` from its rebound reference, and persist `shadowEntryExecutionBlockedEntries` plus reason counts. This prevents impossible delayed-entry prices from distorting diagnostic P&L; it does not change strict execution or authorize live orders.

Paper status comparison must distinguish `configValueDrift` from `configSchemaDrift`. A value drift means a recorded and current key both exist but have different values; a schema drift means a key is missing from the old snapshot or no longer exists in the current source. Both keep `configConsistent=false` and block automatic resume/promotion. The dashboard may explain schema-only differences without claiming that a runtime parameter changed; never turn this presentation distinction into a live-gate relaxation.

The forward-paper runner also has a research-only `PAPER_SMOKE_MARKETS=FRESH_FROM_LEDGER` mode. With `PAPER_SMOKE_FRESHNESS_LEDGER` it selects previously observed markets that meet the configured minimum observation count and freshness-block-rate ceiling, preserves source order, and fails closed when no market qualifies. The read-only paper status/API additionally reports the same diagnostic cohort recommendation from the current telemetry; `SCALP_MARKET_QUALITY_MIN_OBSERVATIONS` and `SCALP_MARKET_QUALITY_MAX_STALE_RATE` only tune that reporting threshold. This is a reproducible data-quality cohort comparison; it does not mutate the default universe, runtime filters, or live-order gate.

Optional break-even/trailing protection (`SCALP_BREAK_EVEN_*`, `SCALP_TRAILING_*`) is disabled when its activation trigger is zero. Its break-even floor is cost-adjusted for two fees and adverse exit slippage; a raw entry-price stop is not considered break-even. It must be evaluated as a separate fixed-config holdout and forward-shadow cohort before enabling; the live risk monitor, backtest, and shadow books share the same conservative protection contract.

`SCALP_MIN_SIGNAL_RANGE_PERCENT` is a separate opt-in lower volatility floor. It rejects a completed rebound candle whose high-low range is too small to support the target; keep it at zero until a fixed-config holdout and forward cohort justify enabling it.

The optional process-wide loss circuit breaker (`SCALP_LOSS_CIRCUIT_BREAKER_COUNT`, `SCALP_LOSS_CIRCUIT_BREAKER_WINDOW_MINUTES`, `SCALP_LOSS_CIRCUIT_BREAKER_COOLDOWN_MINUTES`) is disabled by default with count `0`. When enabled, strict paper/live entries and each diagnostic shadow book stop opening new positions after the configured number of losses in the sliding window. Strict paper state is persisted as `strictRiskState.lossCircuitBreaker`; shadow state is persisted inside its own book. It is a risk brake, not profitability evidence, and must remain a separately validated candidate.

The optional portfolio regime gate (`SCALP_MARKET_REGIME_ENABLED`) is disabled by default. When explicitly enabled, a candidate must also pass the cross-market breadth and average-return check calculated from completed candles. The synchronized portfolio backtest and live cycle must use the same fail-closed contract, and the gate remains a diagnostic candidate until a multi-market holdout supports it.

The optional rebound exhaustion guard (`SCALP_MAX_REBOUND_PERCENT`, default `0`) rejects an oversold rebound whose completed-candle move from the oversold reference already exceeds the configured ceiling. It is different from the delayed-entry chase limit because it applies before the 1-5 second revalidation. It is disabled by default, must be present in the analysis/backtest/live config snapshot when enabled, and must remain a research-only candidate until fixed holdout and forward shadow evidence support it. The `momentum_breakout` profile is not constrained by this oversold-reference ceiling.

The optional loss-only early exit (`SCALP_MAX_LOSING_HOLD_MINUTES`) is disabled with `0`. It exits a still-losing position after the candidate timeout while allowing profitable positions to use the normal max-hold. It is a risk hypothesis only and must be validated in the shared portfolio lane before changing runtime defaults.

The research-only `winnerShadow` sidecar (`SCALP_WINNER_SHADOW_EXTEND_MINUTES`, default `0`) mirrors confirmed strict BUY signals into a separate persisted book and applies only the winner-hold exit candidate. It must expose its `paperExperiments` snapshot and drift status, remain excluded from strict assets and promotion, and never be enabled in live mode as a substitute for an independent fixed/forward gate.

`SCALP_WINNER_SHADOW_MAX_REBOUND_PERCENT` is an optional entry-side A/B filter inside that same sidecar. When strict `maxReboundPercent=0`, it mirrors only confirmed strict BUY signals whose oversold-reference rebound is at or below the configured ceiling; it never changes strict assets or the live gate. Persist the entry contract and ceiling in `paperExperiments`, expose sidecar blocked-entry telemetry, and fail closed on experiment drift. Keep the filter disabled or research-only until its same-signal forward and independent holdout evidence generalizes.

Persist each unique ceiling-blocked signal in `winnerShadow.blockedEntries`. When the strict position with the same coin and signal key closes, settle the sidecar's cost/slippage-adjusted counterfactual and expose its sample count, profit, and comparison delta. If strict delayed revalidation cancels before any fill, resolve the blocked entry as `not_filled` with the cancellation reason and exclude it from counterfactual samples. A blocked-entry counterfactual is diagnostic only; it must never be treated as a real fill or folded into strict promotion metrics.

`SCALP_MAX_ENTRIES_PER_SIGNAL_WINDOW` is another opt-in portfolio safeguard. A positive value limits strict entries sharing the same completed-candle signal key, reducing correlated multi-market exposure when a market-wide rebound fires at once. It is disabled with `0`, persisted in the forward strict risk state, and must be compared in the shared portfolio holdout before enabling.

`npm run validate:scalping` is the read-only validation path; the live-gate artifact is produced by `npm run validate:scalping:fixed`. It fetches minute candles, evaluates the untouched holdout with fees/slippage, and the fixed report additionally requires every market to carry and pass the 95% one-sided trade-return confidence gate. A single passing market never promotes the global strategy, and missing confidence metadata fails closed.

The default tuning grid is intentionally exhaustive (`20,736` candidates) but can be expensive on long windows. `SCALP_VALIDATION_MAX_CANDIDATES` is a research-only deterministic cap that samples the full pool evenly and includes the current base configuration; the report records both counts, and capped results must not be used for live promotion.

`SCALP_VALIDATION_CANDLES_FILE` is an optional reproducibility input for the validation CLI. When set, it must contain every selected market as `{ "KRW-BTC": [...] }`; a missing market fails closed instead of mixing a new network window into the cached study. The report records `candleSource=cache` and the cache path. This remains historical evidence only and never bypasses the forward/live gate.

Historical replay now also validates candle-time continuity against the configured `candleUnit` (default tolerance is 1.5 intervals). Missing or non-increasing timestamps, or gaps beyond that tolerance, are recorded in `dataQuality` and cause single-market and shared-portfolio simulations/validation to fail closed. Do not concatenate or tune on sparse exchange candles as if array-adjacent rows were adjacent time periods; collect a contiguous cache before using the result as evidence. This guard is historical-evidence integrity, not a profitability claim, and does not alter the live forward runner's current-candle freshness telemetry.

Upbit's minute-candle API omits a candle when no execution occurred in that interval. The default validation/live gate still rejects raw gaps; it must never silently convert synthetic data into promotion evidence. `npm run validate:scalping:no-trade-fill` is a separate research-only lane that fills an explicitly supplied raw cache's no-trade intervals with the previous close and zero volume, records the synthetic count and post-fill quality, and hard-sets `promoted=false`. Use it only to preserve elapsed time for diagnosis; it does not replace a raw contiguous validation cache or authorize live orders.
If a later diagnostic needs to reuse the filled window, `SCALP_NO_TRADE_FILL_CACHE_OUTPUT_FILE` may materialize it to a separate path. Keep that cache and every report outside the live-gate artifact; synthetic-candle metrics are never promotion evidence.

`npm run validate:scalping:segments` is an explicit research-only escape hatch for a sparse historical cache. It must consume a cache and never fetch a mixed network window; it splits at timestamp gaps, replays only contiguous segments, excludes `BACKTEST_END` positions at segment/gap boundaries as `unknownBoundaryPositions`, and always reports `promoted=false`. Its realized metrics may help diagnose/tune a candidate, but `raw.valid=false`/`diagnosticOnly=true` and any unknown/excluded segment make it ineligible for historical promotion or live orders. Shared portfolio validation remains fail-closed until every selected market is contiguous.

`npm run validate:scalping:portfolio` is a separate diagnostic lane that synchronizes multiple markets, shares one KRW balance, enforces `maxPositions`, and ranks simultaneous entries. It is useful for testing whether per-market results survive the actual portfolio allocator, but it must never write or replace `scalping_validation.json` and never authorizes live orders.

For stronger evidence, run the portfolio lane with `SCALP_PORTFOLIO_VALIDATION_FOLDS>=2`; the expanding multi-fold validator requires every future fold to pass and keeps the result diagnostic-only. Reuse a fixed `SCALP_PORTFOLIO_CANDLES_FILE` when comparing candidates so timestamp drift does not become a false improvement.

The same-window variant study may persist the exact raw window with `SCALP_VARIANT_CANDLES_OUTPUT_FILE` and reuse it through `SCALP_VARIANT_CANDLES_FILE`. This is for reproducible research only; a relative improvement in winner-hold or exit candidates remains non-promotional until independent training, holdout, confidence, and forward-shadow gates pass.

When stopping a paper session, persist `strictOpenPositions` and mark `endedWithOpenPositions`. Do not start a new session in the same ledger unless the user explicitly resets the isolated portfolio or passes `allowUnsettledResume=true`; this prevents unrealized positions from being silently reclassified as a new baseline.

The same boundary applies to diagnostic `shadow` and `looseShadow` books:
persist `endedWithDiagnosticOpenPositions` and their stop-time snapshots, and
refuse automatic same-ledger reuse when either book has an open position or
when risk/analysis continuity was invalidated. Automatic fail-closed stops must
retain `stopReason=risk_data_gap` or `stopReason=analysis_data_gap` and expose
overall `continuityEligible=false`; preserve those sessions as invalid
diagnostic evidence rather than relabeling them clean.

The portfolio-only `requireNextCandleBullish` candidate enters at the next candle close after verifying bullish follow-through. It is a different latency contract from the live 1–5 second revalidation and must stay diagnostic until a separate implementation and holdout decision are made.

## AI Desk and long-running monitoring

`src/ai/aiAdvisorService.js` is a read-only provider adapter. GPT/Codex and Claude are invoked through the locally authenticated CLI sessions (`codex` and `claude`); provider API keys must not be stored in the repository or passed from CoinPilot. The adapter strips common API-key environment variables from its child process, applies a finite timeout, and accepts only a normalized JSON opinion (`BUY`, `SELL`, `HOLD`, or `WAIT` plus confidence, rationale, risks, and invalidation). Codex calls use an isolated `--ignore-user-config` execution path by default, so a broken user config is surfaced as a warning without blocking a verifiably working subscription session; the warning is not authentication proof until an actual provider response completes.

`src/ai/monitoringSessionService.js` owns persistent AI monitoring sessions, event filters, cooldowns, compact event snapshots, consultation history, and outcome evaluation in `ai_monitoring_sessions.json` (or `AI_MONITORING_FILE`). Each actual provider opinion can be scored later against the first observed same-market price at the configured evaluation horizon; local fallback, failed calls, stale/invalid snapshots, and insufficient-price events are excluded from provider efficacy. `DashboardServer` feeds it the same completed analysis cycle that the trader already uses and emits `ai-monitoring-event`, `ai-consultation`, and `ai-session-update` over Socket.io. This callback is fire-and-forget and must never mutate `decision`, strategy state, configuration, balances, or orders.

If only one provider responds, the aggregate is marked `singleProvider` with `quorum=false`; it must not be presented or evaluated as a two-provider consensus. Only matching completed responses from at least two providers create `quorum=true` consensus evidence.

`src/ai/paperAiMonitoring.js` provides an opt-in bridge for `runPaperSmoke.js`: only `PAPER_AI_MONITORING=true` attaches an isolated monitoring session to the trader's read-only analysis callback. It defaults to GPT-only to avoid silently multiplying provider calls, writes under the smoke output directory unless overridden, drains in-flight consultations on shutdown, and never changes `executeOrder()` or the paper strategy decision.

The AI route is advisory-only. It must not call `executeOrder()` or interpret an AI `BUY`/`SELL` as authorization to trade. The existing settings-based `MultiCoinTrader.executeTradingCycle()` → `executeOrder()` path remains the only automated order path. Add or change AI functionality through the callback/service boundary and cover session persistence, event deduplication, provider parsing, outcome evaluation, and fail-closed behavior with tests.

## Commands

```bash
npm install          # Install dependencies
npm start            # Run integrated system (trading + optimization + dashboard)
npm run dev          # Development mode with auto-restart
npm run backtest     # Run backtesting only
npm run optimize     # Run parameter optimization only
npm run dashboard    # Run web dashboard only (http://localhost:3000)
npm run dashboard:paper # Observe an explicitly selected forward paper ledger (read-only)
npm test             # Run the node:test suite (required green for CI)
npm run lint         # ESLint flat-config check (required clean for CI)
```

`runDashboard.js` is a deterministic mock for UI smoke. To show the actual
persisted forward-paper result without starting a second trading loop, use
`PAPER_DASHBOARD_LEDGER_FILE=/absolute/path/to/paper_validation.json npm run dashboard:paper`.
The observer reads the latest ledger snapshot, rejects paper-session start/stop
mutations, and uses an isolated portfolio-history path. It must run on a
different port from the forward runner and is observation evidence only, not a
live-order, wallet, or settlement proof. `PORTFOLIO_HISTORY_FILE` is also
honored by `MultiCoinTrader` and the portfolio routes so staging processes do
not write the repository's default `portfolio_history.json`.

When multiple read-only paper studies share one public Upbit IP, set
`UPBIT_MIN_REQUEST_INTERVAL_MS` to a value above the default 120ms for the
additional process. The client applies it to both market and risk requests;
this is a request-budget control, not a trading signal or profitability
change.

## Architecture

```
src/
├── index.js                    # Main entry - integrates trading, optimization, backtesting loops
├── api/
│   ├── upbit.js               # Upbit API client (JWT auth, rate limiting, exponential backoff retry)
│   └── dashboardServer.js     # Express + Socket.io server for web dashboard API & real-time notifications
├── analysis/
│   ├── technicalIndicators.js # RSI, MACD, Bollinger Bands, MA crossover, volume analysis
│   └── newsMonitor.js         # Multi-source news + Twitter/X + coin-specific sentiment + urgent news detection
├── strategy/
│   └── tradingStrategy.js     # Trading decision + signal strength calculation
├── trader/
│   ├── autoTrader.js          # Single coin trader
│   └── multiCoinTrader.js     # Multi-coin portfolio trader with dynamic investment & rebalancing
├── backtest/
│   └── backtestEngine.js      # Backtesting with fee/slippage simulation, MDD, Sharpe ratio
├── optimization/
│   └── parameterOptimizer.js  # Genetic algorithm for parameter optimization
├── ml/
│   └── pricePredictor.js      # Linear regression price prediction
├── scripts/
│   ├── runBacktest.js
│   ├── runOptimization.js
│   └── runDashboard.js
└── utils/
    └── logger.js              # File-based logging with rotation
```

## Key Data Flow

1. **MultiCoinTrader** orchestrates the trading loop
2. **UpbitAPI** fetches candle data and handles orders (with rate limiting: 100ms min interval, exponential backoff on 429)
3. **comprehensiveAnalysis()** computes technical indicators
4. **NewsMonitor** provides sentiment scores and detects urgent news
5. **TradingStrategy.makeDecision()** combines scores (60% technical, 40% news) and calculates signal strength
6. **Signal Strength** (WEAK/MEDIUM/STRONG/VERY_STRONG) determines investment multiplier (0.8x to 2.5x)
7. **Dynamic Investment** calculates amount based on total assets × ratio × signal multiplier
8. **ParameterOptimizer** uses BacktestEngine to evaluate fitness and evolve parameters via genetic algorithm
9. **DashboardServer** emits real-time notifications via Socket.io for bundle suggestions and breaking news

## Signal Strength System

`TradingStrategy.calculateSignalStrength()` returns:

- `WEAK` (multiplier: 0.8x) - score 0-7 above threshold
- `MEDIUM` (multiplier: 1.2x) - score 8-14 above threshold
- `STRONG` (multiplier: 1.8x) - score 15-24 above threshold
- `VERY_STRONG` (multiplier: 2.5x) - score 25+ above threshold

## Real-time Notification System

`DashboardServer` uses Socket.io for real-time push notifications:

**Events emitted:**

- `new-signal` - Bundle rebalancing suggestions (sell A → buy B)
- `breaking-news` - Urgent news detection (급등, 급락, 규제, 금지, crash, surge, ban, etc.)

**Bundle Suggestions (`generateBundleSuggestions()`):**

1. Analyzes held positions for sell candidates (RSI overbought, profit taking, MACD bearish)
2. Scans top 20 volume coins for buy candidates (RSI oversold, price drop, MACD bullish)
3. Creates sell+buy pairs with combined score ≥ 80 points
4. Returns top 3 bundles sorted by total score

**Notification Flow:**

- Monitoring interval: 30 seconds
- Duplicate prevention: 5-minute cooldown per bundle key
- Frontend receives via Socket.io client and displays popup with sound

**API Endpoints:**

- `GET /api/bundle-suggestions` - Fetch current bundle suggestions
- `POST /api/trade/execute-bundle` - Execute sell+buy bundle trade

## Dynamic Investment

`MultiCoinTrader.calculateDynamicInvestmentAmount()`:

- Calculation: `totalAssets × investmentRatio × signalMultiplier`
- Default investmentRatio: 5%
- Minimum order: 5,000 KRW (Upbit minimum)
- Signal multiplier applied directly (0.8x to 2.5x based on strength)

## Rebalancing System

When max positions reached but a STRONG/VERY_STRONG buy signal detected:

1. `findWeakestPosition()` identifies the worst-performing position (lowest score - profit%)
2. `sellForRebalancing()` sells the weak position to free up funds
3. New position opened with the stronger signal coin

Rebalancing also triggers when balance insufficient but strong signal exists.

## UpbitAPI Error Handling

- Every Upbit HTTP request has a finite timeout (`UPBIT_REQUEST_TIMEOUT_MS`, default 10 seconds). Read-only forward-paper cycles must fail an individual network request and continue collecting telemetry rather than waiting indefinitely on a socket. Market-analysis and position-risk clients also share a process-wide request slot so separate clients cannot self-collide with the exchange rate limit.

`UpbitAPI.order()` returns structured response:

- Success: `{ success: true, data: OrderData }`
- Failure: `{ success: false, error: { code, message, raw } }`

Error codes parsed via `parseApiError()`:

- `insufficient_funds_bid/ask` - Balance insufficient
- `under_min_total_bid` - Below 5,000 KRW minimum
- `market_does_not_exist` - Invalid market code

Helper methods:

- `waitForOrderFill(uuid, maxWaitMs)` - Poll order status until filled/timeout
- `isValidOrderAmount(amount)` - Check minimum order (5,000 KRW)
- `calculateMaxOrderVolume(krwBalance, price)` - Calculate max volume with fee consideration

## Coin-Specific Sentiment Analysis

`NewsMonitor` provides coin-specific sentiment analysis with multi-source support:

**News Sources:**

- CoinDesk, CoinTelegraph (English crypto news)
- Google News (English & Korean RSS feeds)
- Naver News (Korean)
- Twitter/X (via Nitter mirrors: nitter.net, nitter.privacydev.net, nitter.poast.org)
- CryptoPanic API (fallback for Twitter)

**Key Methods:**

- `getCoinSentiment(coin, maxAgeMs)` - Get cached sentiment for a coin (default 10min cache)
- `getMultiCoinSentiment(coins)` - Batch sentiment analysis with rate limiting (5 coins/batch)
- `fetchCoinSpecificNews(coin)` - Collect news from all sources for specific coin
- `fetchTwitterNews(query)` - Twitter/X search via Nitter mirrors
- `detectUrgentNews(news)` - Detect breaking news with urgent keywords (급등, 급락, 규제, crash, etc.)

**Coin Name Mapping:**

Pre-configured mappings for major coins (BTC, ETH, XRP, SOL, etc.) with:

- English name (e.g., "Bitcoin")
- Korean name (e.g., "비트코인")
- Symbol (e.g., "BTC")
- Twitter cashtag (e.g., "$BTC")

## Web Dashboard API Endpoints

**Access control contract (fail-closed):** when `DASHBOARD_TOKEN` is set, every `/api/*` route except `GET /api/auth/status` and `POST /api/auth/login` requires `Authorization: Bearer <token>`, and every Socket.io handshake must carry `auth.token`. Browser cross-origin calls are limited to same-origin plus `DASHBOARD_CORS_ORIGINS`. Without a token the server binds to `127.0.0.1` only; exposing it on a non-loopback interface without auth requires the explicit `DASHBOARD_ALLOW_INSECURE=true` opt-out. The static shell stays public — never let a new endpoint leak trading state outside the authenticated `/api` plane.

**Core APIs:**

- `GET /api/status` - System status (running, mode, positions)
- `GET /api/account` - Account info (balance, positions, totalAssets)
- `GET /api/positions` - Current holding positions
- `GET /api/statistics` - Trading statistics per coin
- `GET /api/cumulative-pnl` - Cumulative profit/loss vs seed money

**Trading APIs:**

- `POST /api/trade/execute` - Execute single buy/sell order
- `POST /api/trade/execute-bundle` - Execute bundle trade (sell A + buy B)
- `POST /api/trade/smart-buy` - Smart buy with multi-coin allocation
- `POST /api/trade/smart-sell` - Smart sell with profit optimization
- `POST /api/trade/quick` - Quick market order
- `GET /api/bundle-suggestions` - Get rebalancing suggestions

**Analysis APIs:**

- `GET /api/coin-analysis` - Technical analysis for all target coins
- `GET /api/coin-detail/:coin` - Detailed coin info with indicators
- `GET /api/portfolio-analysis` - Portfolio composition and performance
- `GET /api/news/:coin` - Coin-specific news and sentiment

**Virtual Wallet (DRY_RUN mode):**

- `POST /api/virtual/deposit` - Add virtual funds
- `POST /api/virtual/withdraw` - Remove virtual funds
- `POST /api/virtual/reset` - Reset to initial seed money

**Control APIs:**

- `POST /api/control/start` - Start auto trading
- `POST /api/control/stop` - Stop auto trading
- `POST /api/config/update` - Update trading parameters

## Trading Fee System (CRITICAL)

모든 거래에 0.05% 수수료가 적용됨 - 새 거래 로직 추가 시 반드시 적용 필요

```javascript
const FEE_RATE = 0.0005; // 0.05%

// 매수 시
const fee = investmentAmount * FEE_RATE;
const actualInvestment = investmentAmount - fee;
const volume = actualInvestment / currentPrice;
// KRW 잔액에서 investmentAmount (수수료 포함) 차감

// 매도 시
const grossSellAmount = sellVolume * currentPrice;
const fee = grossSellAmount * FEE_RATE;
const netSellAmount = grossSellAmount - fee;
// KRW 잔액에 netSellAmount (수수료 차감) 입금
```

수수료가 적용되는 모든 위치:

| 파일                   | 기능                    | 비고                       |
| ---------------------- | ----------------------- | -------------------------- |
| `multiCoinTrader.js`   | 자동매매 (BUY/SELL)     | 라인 840-844, 977-980      |
| `multiCoinTrader.js`   | 리밸런싱 매도           | 라인 1178-1182             |
| `tradingStrategy.js`   | closePosition()         | 라인 366-369 (통계 계산용) |
| `trading.js`           | /trade/execute          | 라인 722, 799              |
| `trading.js`           | /trade/execute-bundle   | 라인 577                   |
| `trading.js`           | /trade/smart-buy        | 라인 998                   |
| `trading.js`           | /trade/smart-sell       | 라인 1221                  |
| `trading.js`           | /trade/quick            | 라인 1360, 1449            |
| `trading.js`           | /trade/buy, /trade/sell | 라인 1506, 1586            |

## Virtual Portfolio Data Structure (dry_portfolio.json)

```json
{
  "krwBalance": 10000000,          // KRW 잔액
  "holdings": {                     // 보유 코인
    "KRW-BTC": {
      "amount": 0.001,              // 보유 수량
      "avgPrice": 100000000,        // 평균 매수가 (시장가 기준)
      "entryTime": "2025-..."       // 최초 매수 시간 (ISO string)
    }
  },
  "positions": {                    // 전략 포지션 (통계 추적용)
    "KRW-BTC": {
      "type": "BUY",
      "entryPrice": 100000000,
      "amount": 0.001,
      "entryTime": "2025-...",      // Date로 변환 필요
      "id": 1234567890
    }
  },
  "tradeHistory": {                 // 거래 이력 (코인별 객체)
    "KRW-BTC": [
      { "action": "OPEN", ... },
      { "action": "CLOSE", "profit": 1000, ... }
    ]
  },
  "initialSeedMoney": 10000000,     // 초기 시드머니 (누적손익 계산)
  "updatedAt": "2025-..."           // 마지막 저장 시간
}
```

저장/로드 시 주의사항:

- `holdings`와 `positions`는 항상 동기화 필요
- `entryTime`은 저장 시 ISO string, 로드 시 Date 객체로 변환
- `tradeHistory`는 구버전(배열)과 신버전(객체) 모두 지원 (자동 마이그레이션)

## Holdings & Position Sync Rules

매수 시 필수 작업:

```javascript
// 1. holdings 업데이트
virtualPortfolio.holdings.set(coin, {
  amount: newAmount,
  avgPrice: newAvgPrice,
  entryTime: existing.entryTime || new Date().toISOString()  // 최초 매수 시간 유지!
});

// 2. 전략 포지션 업데이트
strategy.openPosition(currentPrice, volume, 'BUY');

// 3. 저장
saveVirtualPortfolio();
```

매도 시 필수 작업:

```javascript
// 1. holdings 업데이트
holding.amount -= sellVolume;
if (holding.amount <= 0.00000001) {
  virtualPortfolio.holdings.delete(coin);
}

// 2. 전략 포지션 종료 (통계 기록)
strategy.closePosition(currentPrice, reason);

// 3. 저장
saveVirtualPortfolio();
```

## Live Trading Specifics

실전 모드에서 체결 데이터 사용:

```javascript
// 주문 후 체결 대기
const fillResult = await this.upbit.waitForOrderFill(orderId, 30000);

if (fillResult.filled) {
  const filledOrder = fillResult.order;

  // 실제 체결 데이터 사용 (예상가 아님!)
  const actualPrice = parseFloat(filledOrder.avg_price);  // 평균 체결가
  const actualVolume = parseFloat(filledOrder.executed_volume);
  const paidFee = parseFloat(filledOrder.paid_fee);  // 실제 수수료

  // 슬리피지 계산
  const slippage = ((actualPrice - expectedPrice) / expectedPrice * 100);
}
```

거래소 동기화 (10분마다):

- `syncWithExchange()`: 내부 상태와 거래소 실잔고 비교
- 불일치 시 자동 수정 (포지션 복구 또는 제거)
- `cleanupPendingOrders()`: 5분 이상 미체결 주문 취소

## Statistics Calculation

`TradingStrategy.getStatistics()`는 `tradeHistory`의 CLOSE와 PARTIAL_CLOSE 기록 모두 사용:

```javascript
// 전체 매도 + 부분 매도 모두 포함
const allSellTrades = this.tradeHistory.filter(t =>
  t.action === 'CLOSE' || t.action === 'PARTIAL_CLOSE'
);
const winningTrades = allSellTrades.filter(t => t.profit > 0);
const totalProfit = allSellTrades.reduce((sum, t) => sum + t.profit, 0);
```

profit 계산 (closePosition 내부):

- grossProfit = (매도가 - 매수가) × 수량
- buyFee = 매수가 × 수량 × 0.0005
- sellFee = 매도가 × 수량 × 0.0005
- netProfit = grossProfit - buyFee - sellFee

## API Route Development Checklist (CRITICAL)

새 거래 API 엔드포인트 작성 시 반드시 확인:

### ⚠️ DRY_RUN과 LIVE 모드 모두 Strategy 업데이트 필수

**가장 흔한 버그**: DRY_RUN에서만 strategy 업데이트하고 LIVE에서 누락

```javascript
// ❌ 잘못된 패턴 - LIVE 모드에서 통계 누락
if (isDryRun) {
  virtualPortfolio.holdings.set(coin, ...);
  strategy.openPosition(price, volume, 'BUY');  // DRY_RUN만 업데이트
} else {
  await upbit.order(coin, 'bid', amount, null, 'price');
  // strategy 업데이트 누락!
}

// ✅ 올바른 패턴 - 두 모드 모두 업데이트
if (isDryRun) {
  virtualPortfolio.holdings.set(coin, ...);
  strategy.openPosition(price, volume, 'BUY');
  saveVirtualPortfolio();
} else {
  await upbit.order(coin, 'bid', amount, null, 'price');
  // LIVE도 strategy 업데이트!
  strategy.openPosition(price, volume, 'BUY');
}
```

### 1. Strategy 동적 생성 패턴

```javascript
// ❌ 잘못된 패턴 - strategy 없으면 통계 누락
const strategy = server.tradingSystem.strategies?.get(coin);

// ✅ 올바른 패턴 - 없으면 동적 생성
const strategy = server.tradingSystem.strategies?.get(coin) ||
                 server.tradingSystem.getStrategy?.(coin);
```

### 2. 부분 매도 vs 전체 매도 처리

```javascript
const isFullSell = holding.amount - sellVolume <= 0.00000001;

if (isFullSell) {
  // 전체 매도 - holdings 삭제 + closePosition
  virtualPortfolio.holdings.delete(coin);
  strategy.closePosition(currentPrice, reason);
} else {
  // 부분 매도 - recordPartialSell 사용 (수익 기록 포함)
  holding.amount -= sellVolume;
  strategy.recordPartialSell(currentPrice, sellVolume, reason);
  // recordPartialSell()이 내부에서:
  // - 부분 매도 수익 계산 (수수료 포함)
  // - tradeHistory에 PARTIAL_CLOSE 기록
  // - currentPosition.amount 감소
  // - 잔량 0이면 자동으로 closePosition 호출
}
```

**recordPartialSell() 메서드**: 부분 매도 시에도 수익이 통계에 반영되도록 함

- `action: 'PARTIAL_CLOSE'`로 tradeHistory에 기록
- 매수 시 수수료의 비율 + 매도 수수료를 계산하여 정확한 순수익 산출
- `getStatistics()`에서 CLOSE + PARTIAL_CLOSE 모두 집계

### 3. 추가 매수 시 평균단가 업데이트

```javascript
// holdings 평균단가
const existing = virtualPortfolio.holdings.get(coin) || { amount: 0, avgPrice: 0 };
const newAmount = existing.amount + buyVolume;
const newAvgPrice = ((existing.amount * existing.avgPrice) + (buyVolume * currentPrice)) / newAmount;

// strategy position 평균단가도 동일하게
if (strategy.currentPosition) {
  const totalAmount = strategy.currentPosition.amount + buyVolume;
  strategy.currentPosition.amount = totalAmount;
  strategy.currentPosition.entryPrice = newAvgPrice;  // 평균단가 업데이트
} else {
  strategy.openPosition(currentPrice, buyVolume, 'BUY');
}
```

### 4. 잔액 체크 (마이너스 방지)

```javascript
// 매수 전 잔액 확인
const currentBalance = virtualPortfolio.krwBalance || 0;
if (currentBalance < investmentAmount) {
  return res.status(400).json({
    error: `잔액 부족 (보유: ${currentBalance.toLocaleString()}원)`,
    success: false,
    availableBalance: currentBalance
  });
}

// 차감 시 Math.max로 마이너스 방지
virtualPortfolio.krwBalance = Math.max(0, currentBalance - investmentAmount);
```

### 5. 최소 금액 체크

```javascript
const MIN_ORDER_AMOUNT = 5000;  // Upbit 최소 주문금액

// 매수 전
if (investmentAmount < MIN_ORDER_AMOUNT) {
  return res.status(400).json({ error: '최소 투자금액은 5,000원입니다' });
}

// 매도 전
const estimatedSellAmount = sellVolume * currentPrice;
if (estimatedSellAmount < MIN_ORDER_AMOUNT) {
  return res.status(400).json({ error: '최소 매도금액은 5,000원입니다' });
}
```

### 6. 필수 저장 호출

```javascript
// 거래 완료 후 반드시 호출
server.tradingSystem.saveVirtualPortfolio();
```

## Important Files

- `.env` - API keys, trading mode (DRY_RUN), target coins, strategy parameters
- `optimal_config.json` - Persisted optimal parameters from genetic algorithm
- `dry_portfolio.json` - Virtual portfolio state (dry run mode, see structure above)
- `initial_seed_money.json` - Initial investment tracking (live mode, auto-created once)
- `backtest_results_*.json` - Per-coin backtesting results
- `optimization_history.json` - Parameter evolution history
- `portfolio_history.json` - Asset value snapshots for chart display

## Configuration

Key environment variables:
- `DRY_RUN=true/false` - Simulated vs real trading
- `TARGET_COINS` - Comma-separated coin list (e.g., KRW-BTC,KRW-ETH) or `ALL` to analyze all KRW markets
- `MAX_POSITIONS` - Maximum simultaneous positions
- `STOP_LOSS_PERCENT`, `TAKE_PROFIT_PERCENT` - Risk management
- `RSI_PERIOD`, `RSI_OVERSOLD`, `RSI_OVERBOUGHT` - Technical indicator params
- `SCALP_LOSS_CIRCUIT_BREAKER_COUNT` - Optional global loss count before new entries are blocked; `0` disables it
- `SCALP_LOSS_CIRCUIT_BREAKER_WINDOW_MINUTES`, `SCALP_LOSS_CIRCUIT_BREAKER_COOLDOWN_MINUTES` - Sliding window and lock duration

## totalAssets 계산 규칙 (CRITICAL)

**모든 API에서 `calculateTotalAssets()` 사용 필수**

```javascript
// ✅ 올바른 패턴 - 통일된 계산
const totalAssets = await server.tradingSystem.calculateTotalAssets();

// ❌ 잘못된 패턴 - 직접 계산 (불일치 발생)
let totalAssets = krwBalance;
positions.forEach(pos => totalAssets += pos.amount * pos.currentPrice);
```

`calculateTotalAssets()`가 정확한 이유:

- `virtualPortfolio.holdings` 기반 (추가 매수 반영)
- ticker 조회 실패 시 평균단가로 fallback
- 모든 보유 코인 포함 (누락 없음)

## Known Architectural Limitations

### Race Condition (이론적)

동시 다발적인 API 요청 시 잔액 불일치 가능성 존재하나, Node.js 단일 스레드 특성상 실질적 위험 낮음:

- `await getTicker()` 이후 잔액 체크/업데이트는 동기 블록으로 실행
- 실제 문제 발생 시 mutex 패턴 적용 고려

## Codacy Integration

When editing files, run `codacy_cli_analyze` after modifications and after installing dependencies (with trivy for security scanning).
