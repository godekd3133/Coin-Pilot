# Project Context

## Domain

Upbit cryptocurrency automation and paper-trading research.

## Role

Safety-first implementation and evidence-driven strategy validation.

## Codebase

- `src/index.js` wires environment configuration, the trader, and the dashboard.
- `src/trader/multiCoinTrader.js` owns the trading cycle, virtual portfolio, paper ledger, and live-order gate.
- `src/analysis/technicalIndicators.js` owns the shared live indicator/rebound contract.
- `src/strategy/oversoldReactionStrategy.js` owns delayed-entry decisions and position risk exits.
- `src/backtest/scalpingBacktest.js` owns fee/slippage-aware simulation, tuning, and walk-forward validation.
- `simulateScalpingPortfolio()` in `src/backtest/scalpingBacktest.js` is the separate synchronized multi-market validation lane; it is diagnostic-only and does not replace the live gate.
- `src/risk/lossCircuitBreaker.js` owns the opt-in sliding-window loss circuit used by runtime, paper shadow books, and backtests.
- `public/index.html` is the responsive dashboard and PWA shell.

The default strategy is `oversold_reaction_scalping`: completed 1-minute candles, recent RSI-oversold reaction, 1–5 second revalidation delay, no averaging, bounded positions, and DRY_RUN by default. `scalping_validation.json` is a promotion gate; a failed holdout never authorizes live orders.

The process-wide loss circuit breaker is disabled by default (`count=0`). When explicitly enabled, strict runtime entries and each shadow book stop opening new positions after N losses in the configured time window; strict and shadow state is persisted separately.

The portfolio regime gate is also disabled by default; it is evaluated only in the synchronized multi-market diagnostic lane until a holdout supports enabling it.

`maxLosingHoldMinutes` is an opt-in loss-only exit candidate; zero is preserved as the runtime default.

The latest v30 forward session is preserved and stopped cleanly after all three strict positions settled. It produced 3 strict closes for `+23.59 KRW`, 5 shadow and 5 loose closes for `-692.16 KRW` each, 0 interruptions, and no open strict positions. This is small-sample evidence only. v31 was later stopped cleanly with no strict positions but three open diagnostic shadow positions preserved in its ledger. v32 in `.paper-forward-v32` then settled 3 strict closes for `-44.9573 KRW` with no strict positions or interruptions at shutdown; its shadow/loose books retain diagnostic state separately. v32 is still small-sample evidence and not profitability evidence. v33 and v34 were short latest-code observations with no strict closes; v34 demonstrated 10 stale-candle blocks in 31 cycles. v35 was preserved after 67 cycles with no strict closes, 6 stale blocks, and shadow loss evidence. v36 was preserved after 25 cycles with 11 stale blocks and age up to 164.745 seconds. v37 in `.paper-forward-v37` then settled one strict WLD trade for `-19.99 KRW` with no strict positions or interruptions at shutdown; its shadow/loose books retain diagnostic state separately. v38 and v39 were short latest-code observations with no strict closes; v38 ended with per-market stale attribution and v39 with its first complete per-market observation denominator. The current latest-code observation is isolated v40 in `.paper-forward-v40`, which includes per-market freshness and insufficient-candle telemetry, a complete snapshot, cap disabled, and zero interruptions at startup; its stale rates and data-quality outcomes are being measured without automatic market exclusion.

`maxEntriesPerSignalWindow` is an opt-in correlated-entry safeguard derived from v30's three same-signal-window entries. It defaults to `0`, is persisted in strict risk state, and is covered by portfolio backtest/API/UI tests; it has not been enabled or promoted.

## Tools

- Node.js ES modules and `node --test`.
- Public Upbit market/candle endpoints for read-only research.
- Dashboard API and PWA service worker.
- Isolated `npm run paper:forward` sessions under `.paper-forward*` so user `dry_portfolio.json` is not modified.

## Evidence boundary

Strict milestone update (`2026-09-10T07:32:07Z`): KAT closed by `STOP_LOSS`, entry `7.09` → exit `6.98`, net `-330.0915 KRW` / `-1.6507%`. The completed strict set is now 3 trades: VVV `+368.7017`, TRUMP `+2.1773`, KAT `-330.0915`, combined `+40.7875 KRW`. This remains a tiny/unrealized-history sample and does not authorize promotion or live orders; the ledger snapshot is expected to be empty after the close and must remain separate from diagnostic books.

Latest KAT diagnostic update (`2026-09-10T07:30:31Z`): shadow KAT closed by `STOP_LOSS`, entry `7.09709` → exit `7.00299`, net `-284.9090 KRW`, with no rejection reasons recorded. Shadow reached 14 closed trades, 5 wins/9 losses, and `-819.1325 KRW`; strict KAT and loose KAT remain separate open observations.

Latest v40 soft-cohort update (`2026-09-10T07:28:30Z`): BIRB closed by `TAKE_PROFIT`, entry `85.2852` → exit `86.913`, net `+361.3543 KRW`, carrying only `previous_high_break_failed`. Shadow/loose now have 13 closed trades, 5 wins/8 losses, and realized `-534.2235/-530.3500 KRW`; the cohort remains negative and diagnostic-only.

Strict milestone: by `2026-09-10T07:10:57Z`, v40 had two completed strict trades with `strictOpenPositions=[]`: VVV `TAKE_PROFIT` net `+368.7017 KRW` and TRUMP `MAX_HOLD_TIME` after 30 minutes, entry `2704` → exit `2707`, net `+2.1773 KRW` after `20.0021 KRW` fee. Combined strict realized profit is `+370.8789 KRW` across only 2 trades, so this is not profitability or promotion evidence. The strict snapshot fix is confirmed on disk after both closes. Shadow had 11 closed trades at `-1244.4069 KRW`; loose had 11 closed at `-1240.5334 KRW`, with diagnostic positions still open separately.

Latest v40 follow-up (`2026-09-10T07:01:45Z`): IOST closed in shadow/loose by `STOP_LOSS` at net `-294.5043 KRW` with `trend_filter_failed`; diagnostic books reached 10 closed/0 open and realized `-959.1801/-955.3066 KRW`. Strict TRUMP remains the only open strict position; VVV close and snapshot fix remain consistent.

At `2026-09-10T07:11:55Z`, strict TRUMP closed by `MAX_HOLD_TIME` after 30 minutes, entry `2704` → exit `2707`, net `+2.1773 KRW`; strict ledger now contains both VVV and TRUMP closes. A new strict KAT position entered at `7.09 KRW` at `2026-09-10T07:11:15Z` with `4,719ms` confirmation delay, rebound `0.9957%`, RSI recovery `20.7090`, volume ratio `1.2176`, and close strength `1`. Preserve KAT as the next unrealized strict observation.

At `2026-09-10T07:08:14Z`, VTHO closed in both diagnostic books by `STOP_LOSS`, entry `0.885885` → exit `0.874125`, net `-285.2268 KRW`, with `trend_filter_failed` and `previous_high_break_failed`. Shadow reached 11 closed/0 open at `-1244.4059 KRW`; loose reached 11 closed/1 open at `-1240.5324 KRW` with a new BTC diagnostic position. Strict TRUMP remains open/unrealized.

Backtests and paper runs are separate evidence lanes from real fills, wallet settlement, and profitability. Forward ledger records strict closes durably and marks long heartbeat gaps as continuity interruptions that invalidate promotion. Current historical and forward evidence has not passed the promotion gate; do not enable live orders based on static tests or training results.

At the latest v40 readback (`2026-09-10T06:07:58Z`), the owner process was alive at 186 cycles with a current heartbeat, 0 strict closes/open positions, 0 interruptions, 134 analysis-only stale blocks, 0 delayed-entry blocks, and 0 insufficient-candle events. All 20 markets were observed 186 times; batch ticker requests were 186 with 0 failures and candle requests were 3,720. Shadow and loose each had two stop-loss closes (`-633.4542` and `-629.5806` KRW) and no open diagnostic positions. This remains operational/small-sample evidence, not profitability evidence; do not loosen filters or enable live orders.

The variant research tool also accepts `SCALP_VARIANT_CANDLES_FILE` for fixed-window reuse. The first cache-backed BTC/ETH study kept all candidates diagnostic: every variant failed the training gate, with baseline holdout `-0.0121%`, loss-only 5-minute timeout `-0.0088%`, and no candidate promoted. Runtime defaults remain unchanged.

The v40 owner was still alive at `2026-09-10T06:18:13Z` with heartbeat `06:17:35Z`, 256 cycles, 0 strict closes/open positions, 3 shadow and 3 loose diagnostic positions open (`WLD`, `TRUMP`, `KAT`), 3 closed diagnostic trades in each book, and no interruptions. Shadow/loose realized profit was `-983.0018/-979.1282 KRW`; stale analysis blocks were 173 with no delayed-entry blocks, and request totals were 256 batch ticker / 5,120 candle requests with 0 batch failures. Keep this session isolated until those diagnostic positions settle or an explicit preserved-open boundary is chosen.

The relaxed-shadow validator now accepts `SHADOW_VALIDATION_CANDLES_FILE`. On the same 2,016-candle BTC/ETH cache, the relaxed cohort failed training and holdout gates in both markets (BTC holdout `-0.0172%`, ETH `-0.0174%`, PF `0`). This confirms that widening the shadow cohort is not a justified tuning direction from the current evidence.

The same cache also rejected alternative profiles: `bb_reclaim` had no holdout trades, `trend_rebound` matched the baseline loss, and `momentum_breakout` was worse; stricter RSI/volume/rebound combinations had no holdout trades. These remain diagnostic comparisons, not runtime changes.

At `2026-09-10T06:23:25Z`, v40 had one strict open position: `KRW-VVV`, entered at `2026-09-10T06:20:17Z` at `31,870 KRW`, with a 4,319ms confirmation delay and `+0.1886%` execution drift. The signal had rebound `0.4738%`, RSI recovery `8.4898`, volume ratio `1.6861`, close strength `1`, and trend slope `-0.1633%`; it passed the current strict contract. The saved risk boundary is stop `-1.2%`, take `+1.8%`, max hold `30m`, loss-only timeout disabled. Do not stop or replace v40 until this strict position reaches a recorded risk exit.

At `2026-09-10T06:25:05Z`, the same strict VVV position remained open. In the diagnostic books, WLD then closed by `STOP_LOSS` at `554.445 KRW` from `562.562 KRW`, net `-308.2791 KRW`, with `volume_confirmation_failed` and `previous_high_break_failed`; shadow/loose each had 4 closed trades and 3 open positions. This is additional soft-cohort loss evidence, not a strict or profitability result.

At `2026-09-10T06:26:40Z`, RAY added the first positive soft close in v40: `TAKE_PROFIT`, `+377.6073 KRW`, while carrying `volume_confirmation_failed` and `trend_filter_failed` but not previous-high-break failure. Across five closed shadow trades, the four losses (BFC/WAVES/UP2/WLD) all carried `previous_high_break_failed`, while volume was present on two losses and the RAY win, and trend was present on one loss and the RAY win. Keep previous-high-break enabled; treat volume/trend as unresolved cohorts requiring more data, not as immediate tuning targets.

At `2026-09-10T06:35:23Z`, KAT also closed `TAKE_PROFIT` for `+338.3177 KRW` while carrying `price_rebound_below_threshold`, `volume_confirmation_failed`, and `previous_high_break_failed`. The six closed shadow trades now total 4 losses/2 wins and `-575.3559 KRW`; previous-high-break appears in 4 losses/1 win, volume in 2 losses/2 wins, and trend in 1 loss/1 win. The cohorts remain too small for filter tuning; retain the historical A/B decision to keep high-break and leave volume/trend defaults unchanged.

At `2026-09-10T06:40:34Z`, TRUMP closed in shadow/loose by `MAX_HOLD_TIME` after 30 minutes: entry `2716.714`, exit `2701.296`, net `-133.3863 KRW`, with `price_rebound_below_threshold` and `volume_confirmation_failed`. The diagnostic books now have 7 closed/1 open each and realized `-708.7421/-704.8686 KRW`; strict VVV remains open and is tracked separately.

At `2026-09-10T06:41:23Z`, strict VVV was still open and a second strict position, `KRW-TRUMP`, entered at `2026-09-10T06:40:30Z` at `2,704 KRW`. The TRUMP strict entry had a `4,772ms` confirmation delay, `+0.0740%` execution drift, rebound `0.2226%`, RSI recovery `11.6104`, volume ratio `1.3671`, close strength `0.7143`, and trend slope `-0.0566%`. Strict trades remain unclosed; preserve both positions through their risk exits.

At `2026-09-10T06:49:34Z`, strict VVV exited by take-profit at `32,490 KRW`, net `+368.7017 KRW` / `+1.8444%`, after `4,319ms` entry confirmation delay and `+0.1886%` execution drift. A ledger integrity bug was found in the same path: the risk-monitor close wrote `strictTrades` before refreshing `strictOpenPositions`, leaving a short crash/restart window with a stale open snapshot. `recordPaperStrictTrade()` now refreshes and persists `strictOpenPositions` immediately after a strict close; the regression test asserts both in-memory and on-disk snapshots are empty after close. The old v40 process was not restarted; its next cycle removed VVV from the snapshot, leaving strict TRUMP as the only open position.

By `2026-09-10T06:53:37Z`, the corrected running ledger had strict TRUMP as the only open position, with VVV absent from `strictOpenPositions` and its `CLOSE` retained. Shadow/loose had no open positions and 9 closed trades each: shadow realized `-664.6758 KRW`, 3 wins/6 losses. The latest shadow pair included VVV `TAKE_PROFIT` `+347.1532 KRW` and VTHO `STOP_LOSS` `-303.0869 KRW`; strict TRUMP remains an open/unrealized observation.

The committed AI monitoring desk was verified in the deterministic dashboard: advisory-only/no-order-routing copy, paper/live boundary, provider cards, persistent-session form, event/consultation empty states, `/api/ai/monitoring` `200`, and `/api/status` `200` in DRY_RUN. Provider status latency came from the local `codex login status` / `claude auth status` subprocesses (about 1.96s/5.56s in this environment); each is bounded by the service's 8s status timeout, and the UI eventually rendered GPT unavailable guidance plus Claude ready. No AI session or consultation was created.

At `2026-09-10T06:33:01Z`, strict VVV was still open about 13 minutes after entry; v40 remained active with 365 cycles, 0 strict closes, 5 shadow/loose closes and 3 open positions in each diagnostic book, 0 interruptions, 223 analysis freshness blocks, and 7,300 candle requests with 0 batch failures. Preserve the session until the VVV risk exit is recorded.
