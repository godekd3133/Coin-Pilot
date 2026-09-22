import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import UpbitAPI from '../api/upbit.js';
import RegimeMomentumStrategy from '../strategy/regimeMomentumStrategy.js';
import { createNotifier } from '../utils/notify.js';
import {
  ensureMomentumShadowInitialBalance,
  getMomentumShadowEquity,
  isMomentumShadowPositionCoveredByBar,
  markMomentumShadowPosition,
  markMomentumShadowPositions,
  updateMomentumShadowEquity
} from '../research/momentumShadowLedger.js';
import {
  recordMomentumShadowRunnerStart,
  recordMomentumShadowRunnerStop
} from '../research/momentumShadowRunnerState.js';
import { resolveMomentumShadowRunnerContract } from '../research/momentumShadowRunnerConfig.js';
import {
  appendMomentumShadowBenchmarkObservationCheckpoint,
  calculateMomentumShadowRelativeMarkedReturnPercent,
  getMomentumShadowBenchmarkGate,
  MOMENTUM_SHADOW_BENCHMARK_OBSERVATION_SCHEMA_VERSION,
  projectMomentumShadowBenchmarkObservation
} from '../research/momentumShadowBenchmark.js';
import {
  isMomentumShadowCooldownActive,
  recordMomentumShadowExit,
  updateMomentumShadowDrawdown
} from '../research/momentumShadowRisk.js';
import { isMomentumShadowHeartbeatStale } from '../research/momentumShadowHeartbeatWatchdog.js';
import {
  calculateCloseVolatilityPercent,
  calculateVolatilityPositionScale
} from '../research/momentumShadowVolatility.js';
import { rankMomentumShadowEntryCandidates } from '../research/momentumShadowCandidateSelection.js';
import {
  assessMomentumShadowDailyGrid,
  isMomentumShadowDailyCandleComplete
} from '../research/momentumShadowDataQuality.js';
import {
  ensureMomentumShadowConsumedSignalState,
  isMomentumShadowSignalConsumed,
  recordMomentumShadowSignal
} from '../research/momentumShadowSignalGuard.js';
import {
  resolveMomentumShadowEntryExecution
} from '../research/momentumShadowEntryExecution.js';
import { executeMomentumShadowPendingEntries } from '../research/momentumShadowPendingEntries.js';
import {
  recordMomentumShadowFetchFailure,
  recordMomentumShadowFetchSuccess,
  resolveMomentumShadowFetchFailureLimit
} from '../research/momentumShadowNetworkGuard.js';
import {
  formatMomentumShadowCycleTimeoutMessage,
  isMomentumShadowCycleTimedOut,
  resolveMomentumShadowMaxCycleDurationMs
} from '../research/momentumShadowCycleWatchdog.js';
import {
  assessMomentumShadowQuoteQuality,
  compactMomentumShadowQuote,
  projectMomentumShadowQuoteExecutionEvidence,
  projectMomentumShadowQuote
} from '../research/momentumShadowQuoteQuality.js';
import {
  projectMomentumShadowExecutionPrice,
  resolveMomentumShadowExecutionModel
} from '../research/momentumShadowExecutionModel.js';
import { isMomentumShadowRelativeTrendAllowed } from '../research/momentumShadowRelativeTrend.js';
import {
  acquireMomentumShadowCandidateSlot,
  readMomentumShadowCandidateSlot,
  releaseMomentumShadowCandidateSlot
} from '../research/momentumShadowCandidateSlot.js';

/**
 * Research-only forward shadow runner for the regime-momentum defense
 * overlay candidate. The current ~400-day audit is negative in absolute
 * return, so this process can only accumulate diagnostic forward evidence.
 *
 * Fully self-contained: owns its own ledger directory and lockfile, fetches
 * daily candles on a slow cadence, and simulates the candidate contract
 * against real completed candles. It does NOT touch the shared runtime,
 * the strict paper ledger, or any live-order path — diagnostic evidence
 * accumulation only. promoted/live are impossible from this process.
 *
 *   node src/scripts/runRegimeMomentumShadow.js
 *
 * Ledger: .paper-momentum-shadow-v1/ledger.json (override MOMO_SHADOW_DIR).
 * No result from this runner can authorize live orders or promotion.
 */
dotenv.config();

const DIR = process.env.MOMO_SHADOW_DIR || '.paper-momentum-shadow-v1';
const LOCK = path.join(DIR, '.momentum-shadow.lock');
const LEDGER = path.join(DIR, 'ledger.json');
const POLL_MS = Number(process.env.MOMO_SHADOW_POLL_MS) || 5 * 60 * 1000;
const DEFAULT_REQUEST_INTERVAL_MS = 500;
const MAX_CONSECUTIVE_FETCH_FAILURES = resolveMomentumShadowFetchFailureLimit(
  process.env.MOMO_SHADOW_MAX_CONSECUTIVE_FETCH_FAILURES
);
const MAX_CYCLE_DURATION_MS = resolveMomentumShadowMaxCycleDurationMs(
  process.env.MOMO_SHADOW_MAX_CYCLE_DURATION_MS
);
const CANDIDATE_SLOT_FILE = process.env.MOMO_SHADOW_CANDIDATE_SLOT_FILE
  ? path.resolve(process.env.MOMO_SHADOW_CANDIDATE_SLOT_FILE)
  : null;
const HEARTBEAT_STALE_LIMIT_MS = Math.max(10 * 60 * 1000, POLL_MS * 5);
const DEFAULT_MAX_DAILY_CANDLE_AGE_HOURS = 36;
let MARKETS = (process.env.MOMO_SHADOW_MARKETS || 'KRW-BTC,KRW-ETH,KRW-XRP,KRW-SOL')
  .split(',').map((m) => m.trim()).filter(Boolean);
let BENCHMARK_MARKET = null;
let BENCHMARK_TREND_MIN_PERCENT = null;
let RELATIVE_TREND_MIN_PERCENT = null;
let EXIT_ON_BENCHMARK_OFF = false;
let COOLDOWN_AFTER_LOSS_DAYS = 0;
let MAX_PORTFOLIO_DRAWDOWN_PERCENT = 0;
let MAX_ENTRY_GAP_PERCENT = 0;
let MAX_DAILY_CANDLE_AGE_HOURS = DEFAULT_MAX_DAILY_CANDLE_AGE_HOURS;
let MAX_SPREAD_PERCENT = 0;
let REQUEST_INTERVAL_MS = DEFAULT_REQUEST_INTERVAL_MS;
let EXECUTION_MODEL = resolveMomentumShadowExecutionModel(process.env.MOMO_SHADOW_EXECUTION_MODEL);
const COST_PERCENT = Number(process.env.MOMO_SHADOW_COST_PERCENT) || 0.2;
const POSITION_FRACTION = Number(process.env.MOMO_SHADOW_POSITION_FRACTION) || 0.25;
const MAX_POSITIONS = Number(process.env.MOMO_SHADOW_MAX_POSITIONS) || 4;
const TREND_MIN_PERCENT = Number(process.env.MOMO_SHADOW_TREND_MIN_PERCENT) || 0;
const BREADTH_MIN = Number(process.env.MOMO_SHADOW_BREADTH_MIN) || 1;
let VOLATILITY_LOOKBACK_DAYS = Math.max(
  2,
  Math.floor(Number(process.env.MOMO_SHADOW_VOLATILITY_LOOKBACK_DAYS) || 14)
);
let VOLATILITY_TARGET_PERCENT = process.env.MOMO_SHADOW_VOLATILITY_TARGET_PERCENT === undefined ||
  process.env.MOMO_SHADOW_VOLATILITY_TARGET_PERCENT === ''
  ? null
  : Number.isFinite(Number(process.env.MOMO_SHADOW_VOLATILITY_TARGET_PERCENT))
    && Number(process.env.MOMO_SHADOW_VOLATILITY_TARGET_PERCENT) > 0
    ? Number(process.env.MOMO_SHADOW_VOLATILITY_TARGET_PERCENT)
    : null;
let ENTRY_EXECUTION = resolveMomentumShadowEntryExecution(
  process.env.MOMO_SHADOW_ENTRY_EXECUTION
);
const HISTORY_DAYS = 200;
// 'fixed': exit at maxHoldHours / SL / TP (trade-based).
// 'regime': hold while trailing 7d trend stays > trendMinPercent (regime switch).
let MODE = process.env.MOMO_SHADOW_MODE === 'regime' ? 'regime' : 'fixed';

const strategyConfig = {
  candleUnitMinutes: 1440,
  rsiEntryThreshold: 0,          // pure trend gate: RSI disabled
  trendLookbackHours: 168,       // 7d
  requireUpBar: true,
  // regime mode holds while the trend gate stays open; disable the fixed cap.
  maxHoldHours: Number(process.env.MOMO_SHADOW_MAX_HOLD_HOURS)
    || (MODE === 'regime' ? 24 * 365 : 72),
  minUpBars: Math.max(1, Math.floor(Number(process.env.MOMO_SHADOW_MIN_UP_BARS) || 1)),
  stopLossPercent: Number(process.env.MOMO_SHADOW_STOP_LOSS_PERCENT) || 0,
  takeProfitPercent: Number(process.env.MOMO_SHADOW_TAKE_PROFIT_PERCENT) || 0
};

const upbit = new UpbitAPI('', '', { requestTimeoutMs: 10_000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const notify = createNotifier({ topic: process.env.MOMO_SHADOW_NTFY_TOPIC || '' });
let bookName = `${DIR.replace(/[^a-z0-9]+/gi, '-')}·${MODE}`;
let activeLedger = null;
let lockOwned = false;
let candidateSlotOwned = false;
let shutdownStarted = false;
let heartbeatWatchdogTimer = null;

function loadLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch { return null; }
}
function saveLedger(l) {
  // The process can outlive an external cleanup of its research directory.
  // Recreate the exact scoped directory before the atomic temp-file write so
  // a live diagnostic owner does not spin forever on ENOENT.
  fs.mkdirSync(DIR, { recursive: true });
  const heartbeatAt = new Date().toISOString();
  l.heartbeatAt = heartbeatAt;
  l.ownerPid = process.pid;
  if (l.runnerState === 'running') l.runnerLastHeartbeatAt = heartbeatAt;
  const tmp = `${LEDGER}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(l, null, 2));
  fs.renameSync(tmp, LEDGER);
}

function readLock() {
  try { return JSON.parse(fs.readFileSync(LOCK, 'utf8')); }
  catch { return null; }
}

function acquireLock() {
  fs.mkdirSync(DIR, { recursive: true });
  const claim = () => {
    fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx' });
    // A concurrent stale-owner recovery can unlink this file and claim the
    // directory between our write and now. Re-read the lock and confirm it
    // still names this process before treating the claim as owned.
    const verified = readLock();
    if (verified?.pid !== process.pid) throw new Error('shadow lock claim superseded');
    lockOwned = true;
  };
  let stale = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      claim();
      return stale;
    } catch (claimError) {
      // EEXIST means another owner holds the file; a failed self-verify means
      // a concurrent recovery superseded us. Both paths re-evaluate below.
      // Other filesystem errors are not contention, so fail fast.
      if (claimError?.code !== 'EEXIST' &&
        claimError?.message !== 'shadow lock claim superseded') throw claimError;
    }
    const current = readLock();
    if (Number.isInteger(current?.pid)) {
      try {
        process.kill(current.pid, 0);
        console.error(`FAIL_CLOSED: shadow lock held by live pid ${current.pid}`);
        process.exit(2);
      } catch (error) {
        // ESRCH means the owner is gone and the lock is stale. EPERM and
        // other errors are not proof of absence, so fail closed.
        if (error?.code !== 'ESRCH') throw error;
      }
    }
    // Stale or unreadable lock: unlink only while a second consecutive read
    // still shows the identical content. A fresh claimant that won the file
    // between the liveness check and this unlink must not be evicted, so any
    // observed change loops back to a full re-evaluation instead.
    const latest = readLock();
    if (JSON.stringify(latest) !== JSON.stringify(current)) continue;
    try { fs.unlinkSync(LOCK); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    stale = current || { pid: null, startedAt: null };
  }
  throw new Error('FAIL_CLOSED: shadow lock contention did not resolve');
}

function verifyLockOwnership() {
  if (!lockOwned || readLock()?.pid === process.pid) return;
  // A stale-owner recovery evicted this process's lock between cycles, or the
  // file was removed externally. Continuing would leave two processes both
  // believing they own the ledger, so stop fail-closed instead.
  console.error('FAIL_CLOSED: shadow lock ownership lost');
  stopRunner('lock_lost', new Error('shadow lock ownership lost'));
  process.exit(2);
}

function verifyCandidateSlotOwnership() {
  if (!CANDIDATE_SLOT_FILE || !candidateSlotOwned) return;
  const slot = readMomentumShadowCandidateSlot(CANDIDATE_SLOT_FILE);
  if (slot?.valid === true && Number(slot.pid) === process.pid) return;
  const error = new Error('candidate execution slot ownership was lost');
  console.error('FAIL_CLOSED: candidate slot ownership lost');
  stopRunner('candidate_slot_lost', error);
  process.exitCode = 2;
  process.exit(2);
}

function releaseLock() {
  if (!lockOwned) return;
  try {
    const cur = readLock();
    if (!cur || cur.pid === process.pid) fs.unlinkSync(LOCK);
  } catch (error) {
    if (error?.code !== 'ENOENT') console.error(`shadow lock release failed: ${error.message}`);
  } finally {
    lockOwned = false;
  }
}

function stopRunner(reason, error = null) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  if (heartbeatWatchdogTimer) {
    clearInterval(heartbeatWatchdogTimer);
    heartbeatWatchdogTimer = null;
  }
  if (activeLedger) {
    recordMomentumShadowRunnerStop(activeLedger, {
      pid: process.pid,
      at: new Date().toISOString(),
      reason,
      error,
    });
    try { saveLedger(activeLedger); }
    catch (persistError) { console.error(`runner stop state persist failed: ${persistError.message}`); }
  }
  if (CANDIDATE_SLOT_FILE && candidateSlotOwned) {
    try {
      releaseMomentumShadowCandidateSlot({ file: CANDIDATE_SLOT_FILE, pid: process.pid });
    } catch (slotError) {
      console.error(`candidate slot release failed: ${slotError.message}`);
    } finally {
      candidateSlotOwned = false;
    }
  }
  releaseLock();
}

function startHeartbeatWatchdog(ledger) {
  if (heartbeatWatchdogTimer) clearInterval(heartbeatWatchdogTimer);
  const intervalMs = Math.min(60_000, Math.max(5_000, Math.floor(POLL_MS / 5)));
  heartbeatWatchdogTimer = setInterval(() => {
    if (shutdownStarted || !ledger || ledger.runnerState !== 'running') return;
    if (!isMomentumShadowHeartbeatStale({
      heartbeatAt: ledger.heartbeatAt,
      staleLimitMs: HEARTBEAT_STALE_LIMIT_MS
    })) return;

    const error = new Error(
      `runner heartbeat stale for more than ${Math.round(HEARTBEAT_STALE_LIMIT_MS / 1000)}s`
    );
    console.error(`FAIL_CLOSED: ${error.message}`);
    stopRunner('heartbeat_timeout', error);
    process.exitCode = 2;
    process.exit(2);
  }, intervalMs);
  heartbeatWatchdogTimer.unref?.();
}

process.on('SIGTERM', () => {
  stopRunner('signal:SIGTERM');
  process.exit(0);
});
process.on('SIGINT', () => {
  stopRunner('signal:SIGINT');
  process.exit(0);
});
process.on('uncaughtException', (error) => {
  console.error('uncaught runner exception:', error);
  stopRunner('uncaught_exception', error);
  process.exitCode = 1;
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandled runner rejection:', reason);
  stopRunner('unhandled_rejection', reason);
  process.exitCode = 1;
});
process.on('beforeExit', () => {
  if (activeLedger && !shutdownStarted) stopRunner('before_exit');
});
process.on('exit', () => {
  if (CANDIDATE_SLOT_FILE && candidateSlotOwned) {
    try { releaseMomentumShadowCandidateSlot({ file: CANDIDATE_SLOT_FILE, pid: process.pid }); }
    catch { /* best-effort during process teardown */ }
  }
  releaseLock();
});

async function fetchDailyCandles(market) {
  return upbit.requestWithRetry(async () => {
    const res = await axios.get('https://api.upbit.com/v1/candles/days',
      upbit.getRequestConfig({ params: { market, count: HISTORY_DAYS } }));
    return res.data;
  });
}

async function fetchOrderbookQuotes() {
  return upbit.requestWithRetry(async () => {
    const res = await axios.get('https://api.upbit.com/v1/orderbook',
      upbit.getRequestConfig({ params: { markets: MARKETS.join(',') } }));
    return Object.fromEntries((res.data || [])
      .filter(book => book?.market)
      .map(book => [book.market, projectMomentumShadowQuote(book.market, book)]));
  });
}

function toBars(candles, now = new Date()) {
  // Upbit's /candles/days includes today's still-forming candle; only
  // completed daily bars are eligible for signals and exits. Completion is
  // decided by each candle's own end timestamp against the shared cycle
  // snapshot: a response that arrives just after the UTC boundary can
  // neither promote the newly-forming candle nor drop the bar that closed.
  const cutoffMs = now instanceof Date ? now.getTime() : timestampMs(now);
  return candles
    .filter((c) => isMomentumShadowDailyCandleComplete(c, cutoffMs))
    .map((c) => ({
      ts: c.candle_date_time_utc,
      trade_price: c.trade_price,
      high_price: c.high_price,
      low_price: c.low_price,
      opening_price: c.opening_price,
      candle_acc_trade_volume: c.candle_acc_trade_volume
    }))
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

function timestampMs(value) {
  const text = String(value ?? '');
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function recordMomentumShadowBenchmarkObservation(ledger, series, benchmarkMarket) {
  const observation = projectMomentumShadowBenchmarkObservation({
    existing: ledger,
    bars: series?.[benchmarkMarket],
    benchmarkMarket
  });
  ledger.benchmarkObservationAvailable = observation.available === true;
  ledger.benchmarkObservationReason = observation.reason || null;
  if (observation.available !== true) return observation;

  ledger.benchmarkObservationMarket = observation.benchmarkObservationMarket;
  ledger.benchmarkObservationStartPrice = observation.benchmarkObservationStartPrice;
  ledger.benchmarkObservationStartTs = observation.benchmarkObservationStartTs;
  ledger.benchmarkObservationMarkPrice = observation.benchmarkObservationMarkPrice;
  ledger.benchmarkObservationMarkTs = observation.benchmarkObservationMarkTs;
  ledger.benchmarkObservationReturnPercent = observation.benchmarkObservationReturnPercent;
  return observation;
}

function recordMomentumShadowBenchmarkCheckpoint(ledger, equity, capturedAt) {
  if (ledger.benchmarkObservationAvailable !== true ||
    !ledger.benchmarkObservationMarkTs) return;
  const relativeMarkedReturnPercent = calculateMomentumShadowRelativeMarkedReturnPercent(
    equity?.markedReturnPercent,
    ledger.benchmarkObservationReturnPercent
  );
  if (relativeMarkedReturnPercent === null) return;
  ledger.benchmarkObservationCheckpoints = appendMomentumShadowBenchmarkObservationCheckpoint(
    ledger.benchmarkObservationCheckpoints,
    {
      benchmarkMarkTs: ledger.benchmarkObservationMarkTs,
      capturedAt,
      markedEquity: equity.markedEquity,
      markedReturnPercent: equity.markedReturnPercent,
      benchmarkReturnPercent: ledger.benchmarkObservationReturnPercent,
      relativeMarkedReturnPercent,
      openPositionCount: equity.openPositionCount,
      dataQualityValid: ledger.dataQuality?.valid === true,
      benchmarkGateOpen: ledger.benchmarkGateOpen === true
    }
  );
}

function markMomentumShadowPositionsForCycle(ledger, series, quoteQuality) {
  if (EXECUTION_MODEL !== 'quote_cross') {
    return markMomentumShadowPositions(ledger, series, COST_PERCENT);
  }

  let markedCount = 0;
  for (const [market, position] of Object.entries(ledger.positions || {})) {
    const bars = series?.[market];
    const latest = Array.isArray(bars) && bars.length > 0 ? bars.at(-1) : null;
    if (!isMomentumShadowPositionCoveredByBar(position, latest)) continue;
    const projection = projectMomentumShadowExecutionPrice({
      model: EXECUTION_MODEL,
      side: 'mark',
      candlePrice: latest?.trade_price,
      quote: compactMomentumShadowQuote(quoteQuality?.byMarket?.[market])
    });
    if (!projection.available) {
      ledger.executionModelMarkBlocked = (ledger.executionModelMarkBlocked || 0) + 1;
      ledger.lastExecutionModelBlock = {
        stage: 'mark',
        market,
        reason: projection.reason,
        at: new Date().toISOString()
      };
      continue;
    }
    const marked = markMomentumShadowPosition(
      position,
      projection.price,
      latest?.ts,
      COST_PERCENT
    );
    if (!marked) continue;
    ledger.positions[market] = {
      ...marked,
      executionModel: projection.model,
      markPriceSource: projection.source,
      markQuoteTimestamp: projection.quoteTimestamp
    };
    markedCount += 1;
  }
  return markedCount;
}

function currentDailyOpen(candles, nowMs) {
  const todayUtc = new Date(nowMs).toISOString().slice(0, 10);
  const current = candles.find(candle =>
    String(candle?.candle_date_time_utc).slice(0, 10) === todayUtc
  );
  if (!current) return null;
  return {
    ts: current.candle_date_time_utc,
    opening_price: current.opening_price
  };
}

function positionNeedsCompletedEntryBar(position) {
  // The guard follows the position's own recorded execution mode. A runner
  // restarted with a different entryExecution cannot downgrade the
  // protection for a next-open fill that is still inside its entry candle.
  return (position?.entryExecution || ENTRY_EXECUTION) === 'next_open';
}

function trailingTrend(bars, i, days = 7) {
  if (i < days) return null;
  return ((bars[i].trade_price - bars[i - days].trade_price) / bars[i - days].trade_price) * 100;
}

async function cycle(ledger, strategies) {
  verifyLockOwnership();
  verifyCandidateSlotOwnership();
  const series = {};
  const currentOpenByMarket = {};
  const cycleNow = Date.now();
  let cycleStage = 'initializing';
  let cycleMarket = null;
  const markCycleStage = (stage, market = null) => {
    cycleStage = stage;
    cycleMarket = market;
    ledger.currentCycleStage = stage;
    ledger.currentCycleMarket = market;
  };
  markCycleStage('daily_fetch');
  let cycleTimeout = null;
  const onCycleTimeout = () => {
    if (shutdownStarted) return;
    const elapsedMs = Date.now() - cycleNow;
    if (!isMomentumShadowCycleTimedOut({
      startedAt: cycleNow,
      now: Date.now(),
      timeoutMs: MAX_CYCLE_DURATION_MS
    })) {
      // A timer may fire ahead of its wall-clock deadline (cached loop time,
      // ms rounding). A one-shot callback that simply returns would retire
      // the watchdog for the rest of the cycle, so re-arm for the remaining
      // budget instead.
      cycleTimeout = setTimeout(
        onCycleTimeout,
        Math.max(1, MAX_CYCLE_DURATION_MS - elapsedMs)
      );
      cycleTimeout.unref?.();
      return;
    }
    const error = new Error(formatMomentumShadowCycleTimeoutMessage({
      elapsedMs,
      timeoutMs: MAX_CYCLE_DURATION_MS,
      stage: cycleStage,
      market: cycleMarket
    }));
    console.error(`FAIL_CLOSED: ${error.message}`);
    stopRunner('cycle_timeout', error);
    process.exitCode = 2;
    process.exit(2);
  };
  cycleTimeout = setTimeout(onCycleTimeout, MAX_CYCLE_DURATION_MS);
  cycleTimeout.unref?.();

  try {
    let consecutiveFetchFailures = 0;
    ledger.networkFetchMaxConsecutiveFailures = MAX_CONSECUTIVE_FETCH_FAILURES;
    ledger.networkFetchMaxCycleDurationMs = MAX_CYCLE_DURATION_MS;
    for (const m of MARKETS) {
      markCycleStage('daily_fetch', m);
      try {
        const candles = await fetchDailyCandles(m);
        series[m] = toBars(candles, new Date(cycleNow));
        currentOpenByMarket[m] = currentDailyOpen(candles, cycleNow);
        recordMomentumShadowFetchSuccess(ledger);
        consecutiveFetchFailures = 0;
      }
      catch (e) {
        ledger.fetchErrors = (ledger.fetchErrors || 0) + 1;
        consecutiveFetchFailures += 1;
        const networkState = recordMomentumShadowFetchFailure(ledger, e, {
          consecutiveFailures: consecutiveFetchFailures,
          maxConsecutiveFailures: MAX_CONSECUTIVE_FETCH_FAILURES,
          market: m,
          now: Date.now()
        });
        if (networkState.circuitOpen) {
          console.error(
            `FAIL_CLOSED: shadow daily fetch circuit opened after ${networkState.consecutiveFailures} consecutive failures (${networkState.error.code})`
          );
          break;
        }
        continue;
      }
      await sleep(REQUEST_INTERVAL_MS);
    }
    markCycleStage('daily_quality');
    const now = cycleNow;
    const nowIso = new Date().toISOString();
    const dataQuality = assessMomentumShadowDailyGrid(series, MARKETS, {
      now,
      maxAgeHours: MAX_DAILY_CANDLE_AGE_HOURS
    });
    ledger.dataQualityObservationCycles = (Number(ledger.dataQualityObservationCycles) || 0) + 1;
    if (dataQuality.valid) {
      ledger.dataQualityValidCycles = (Number(ledger.dataQualityValidCycles) || 0) + 1;
    } else {
      ledger.dataQualityInvalidCycles = (Number(ledger.dataQualityInvalidCycles) || 0) + 1;
      if (!ledger.dataQualityInvalidReasonCounts ||
        typeof ledger.dataQualityInvalidReasonCounts !== 'object') {
        ledger.dataQualityInvalidReasonCounts = {};
      }
      ledger.dataQualityInvalidReasonCounts[dataQuality.reason] =
        (Number(ledger.dataQualityInvalidReasonCounts[dataQuality.reason]) || 0) + 1;
    }
    ledger.dataQuality = {
      valid: dataQuality.valid,
      reason: dataQuality.reason,
      marketCount: dataQuality.marketCount,
      missingMarkets: dataQuality.missingMarkets,
      invalidMarkets: dataQuality.invalidMarkets,
      unalignedMarkets: dataQuality.unalignedMarkets,
      staleMarkets: dataQuality.staleMarkets,
      latestTimestamp: dataQuality.latestTimestamp,
      latestByMarket: dataQuality.latestByMarket,
      latestAgeSecondsByMarket: dataQuality.latestAgeSecondsByMarket,
      maxAgeHours: dataQuality.maxAgeHours
    };

    let quoteQuality = null;
    const quoteRequiredForExecution = EXECUTION_MODEL === 'quote_cross';
    if (MAX_SPREAD_PERCENT > 0 || quoteRequiredForExecution) {
      markCycleStage('orderbook_fetch');
      try {
        quoteQuality = assessMomentumShadowQuoteQuality({
          markets: MARKETS,
          quotes: await fetchOrderbookQuotes(),
          maxSpreadPercent: MAX_SPREAD_PERCENT
        });
      } catch (error) {
        ledger.fetchErrors = (ledger.fetchErrors || 0) + 1;
        quoteQuality = assessMomentumShadowQuoteQuality({
          markets: MARKETS,
          quotes: {},
          maxSpreadPercent: MAX_SPREAD_PERCENT,
          error: error.message
        });
      }
      quoteQuality.executionModel = EXECUTION_MODEL;
      quoteQuality.executionRequired = quoteRequiredForExecution;
      quoteQuality.executionReady = !quoteQuality.error &&
        quoteQuality.missingMarkets.length === 0 &&
        quoteQuality.invalidMarkets.length === 0;
      ledger.quoteQuality = quoteQuality;
    }

    markCycleStage('benchmark');
    const benchmark = getMomentumShadowBenchmarkGate(
      series,
      BENCHMARK_MARKET,
      series[BENCHMARK_MARKET]?.length - 1,
      BENCHMARK_TREND_MIN_PERCENT ?? 0,
      strategyConfig.trendLookbackHours / 24
    );
    ledger.benchmarkMarket = BENCHMARK_MARKET;
    ledger.benchmarkTrendPercent = benchmark.trendPercent;
    ledger.benchmarkGateOpen = benchmark.gateOpen;
    ledger.benchmarkAvailable = benchmark.available;
    recordMomentumShadowBenchmarkObservation(ledger, series, BENCHMARK_MARKET);

    // Mark-to-market is descriptive only. The optional quote_cross model uses
    // best bid for a conservative liquidation mark; the default keeps the
    // completed-candle price contract unchanged.
    markCycleStage('position_mark');
    markMomentumShadowPositionsForCycle(ledger, series, quoteQuality);
    if (!ledger.cooldownUntilByMarket || typeof ledger.cooldownUntilByMarket !== 'object') {
      ledger.cooldownUntilByMarket = {};
    }

    // exits first (mark to latest completed daily close)
    markCycleStage('exits');
    for (const [m, pos] of Object.entries(ledger.positions)) {
      const bars = series[m];
      if (!bars || !bars.length) continue;
      const last = bars[bars.length - 1];
      // When a next-open fill used the currently forming candle, there is no
      // completed close at or after the entry yet. Never evaluate a pre-entry
      // close as an immediate exit or drawdown stop.
      if (positionNeedsCompletedEntryBar(pos) &&
        !isMomentumShadowPositionCoveredByBar(pos, last)) continue;
      let ex = strategies[m].checkPosition(
        { entryPrice: pos.entryPrice, entryTimeMs: pos.entryTimeMs }, last.trade_price, now);
      if (!ex.exit && MODE === 'regime') {
        const t = trailingTrend(bars, bars.length - 1);
        if (t != null && t <= TREND_MIN_PERCENT) {
          ex = { exit: 'REGIME_OFF', profitPercent: ((last.trade_price - pos.entryPrice) / pos.entryPrice) * 100 };
        }
      }
      if (!ex.exit && MODE === 'regime' && EXIT_ON_BENCHMARK_OFF &&
        benchmark.available && !benchmark.gateOpen) {
        ex = { exit: 'BENCHMARK_OFF', profitPercent: ((last.trade_price - pos.entryPrice) / pos.entryPrice) * 100 };
      }
      if (ex.exit) {
        const exitQuote = compactMomentumShadowQuote(quoteQuality?.byMarket?.[m]);
        const execution = projectMomentumShadowExecutionPrice({
          model: EXECUTION_MODEL,
          side: 'exit',
          candlePrice: last.trade_price,
          quote: exitQuote
        });
        if (!execution.available) {
          ledger.executionModelExitBlocked = (ledger.executionModelExitBlocked || 0) + 1;
          ledger.lastExecutionModelBlock = {
            stage: 'exit',
            market: m,
            reason: execution.reason,
            at: nowIso
          };
          continue;
        }
        const grossProfitPercent = ((execution.price - pos.entryPrice) / pos.entryPrice) * 100;
        const profit = grossProfitPercent - COST_PERCENT;
        ledger.balance += pos.size * (1 + profit / 100);
        const trade = {
          market: m,
          entry: pos,
          exitTs: last.ts,
          exitPrice: execution.price,
          decisionExitPrice: last.trade_price,
          executionModel: execution.model,
          executionPriceSource: execution.source,
          executionQuoteTimestamp: execution.quoteTimestamp,
          exit: ex.exit,
          profitPercent: profit
        };
        if (MAX_SPREAD_PERCENT > 0 || EXECUTION_MODEL === 'quote_cross') {
          trade.quoteExecutionEvidence = {
            market: m,
            ...projectMomentumShadowQuoteExecutionEvidence({
              entryQuote: pos.entryQuote,
              exitQuote: compactMomentumShadowQuote(quoteQuality?.byMarket?.[m])
            })
          };
        }
        ledger.trades.push(trade);
        delete ledger.positions[m];
        recordMomentumShadowExit(ledger, m, profit, now, COOLDOWN_AFTER_LOSS_DAYS);
        notify.send(`momentum close ${m.replace('KRW-', '')}`,
          `${ex.exit} ${profit >= 0 ? '+' : ''}${profit.toFixed(2)}% · ${bookName} · bal ${Math.round(ledger.balance).toLocaleString()}`,
          [profit >= 0 ? 'white_check_mark' : 'x']);
      }
    }

    markCycleStage('drawdown_guard');
    const markedBeforeEntries = getMomentumShadowEquity(
      ledger,
      Number(process.env.MOMO_SHADOW_INITIAL_BALANCE) || 100_000_000
    );
    const drawdownState = updateMomentumShadowDrawdown(
      ledger,
      markedBeforeEntries.markedEquity,
      nowIso,
      MAX_PORTFOLIO_DRAWDOWN_PERCENT,
      Number(process.env.MOMO_SHADOW_INITIAL_BALANCE) || 100_000_000
    );
    if (drawdownState.triggered) {
      for (const [m, pos] of Object.entries(ledger.positions)) {
        const bars = series[m];
        const last = bars?.at(-1);
        if (!last) continue;
        if (positionNeedsCompletedEntryBar(pos) &&
          !isMomentumShadowPositionCoveredByBar(pos, last)) continue;
        const exitQuote = compactMomentumShadowQuote(quoteQuality?.byMarket?.[m]);
        const execution = projectMomentumShadowExecutionPrice({
          model: EXECUTION_MODEL,
          side: 'exit',
          candlePrice: last.trade_price,
          quote: exitQuote
        });
        if (!execution.available) {
          ledger.executionModelExitBlocked = (ledger.executionModelExitBlocked || 0) + 1;
          ledger.lastExecutionModelBlock = {
            stage: 'drawdown_exit',
            market: m,
            reason: execution.reason,
            at: nowIso
          };
          continue;
        }
        const rawProfitPercent = ((execution.price - pos.entryPrice) / pos.entryPrice) * 100;
        const profit = rawProfitPercent - COST_PERCENT;
        ledger.balance += pos.size * (1 + profit / 100);
        const trade = {
          market: m,
          entry: pos,
          exitTs: last.ts,
          exitPrice: execution.price,
          decisionExitPrice: last.trade_price,
          executionModel: execution.model,
          executionPriceSource: execution.source,
          executionQuoteTimestamp: execution.quoteTimestamp,
          exit: 'PORTFOLIO_DRAWDOWN_STOP',
          profitPercent: profit
        };
        if (MAX_SPREAD_PERCENT > 0 || EXECUTION_MODEL === 'quote_cross') {
          trade.quoteExecutionEvidence = {
            market: m,
            ...projectMomentumShadowQuoteExecutionEvidence({
              entryQuote: pos.entryQuote,
              exitQuote: compactMomentumShadowQuote(quoteQuality?.byMarket?.[m])
            })
          };
        }
        ledger.trades.push(trade);
        delete ledger.positions[m];
        recordMomentumShadowExit(ledger, m, profit, now, COOLDOWN_AFTER_LOSS_DAYS);
        notify.send(`momentum drawdown stop ${m.replace('KRW-', '')}`,
          `PORTFOLIO_DRAWDOWN_STOP ${profit >= 0 ? '+' : ''}${profit.toFixed(2)}% · ${bookName}`,
          ['warning']);
      }
    }

    // Pending next-open fills settle after this cycle's exits and drawdown
    // liquidation: an exit decided at the last completed close frees its slot
    // and cash before an open-time fill is evaluated, matching the simulator's
    // boundary ordering.
    markCycleStage('pending_entries');
    executeMomentumShadowPendingEntries({
      ledger,
      series,
      currentOpenByMarket,
      dataQuality,
      quoteQuality,
      entryQuotes: quoteQuality?.byMarket || {},
      executionModel: EXECUTION_MODEL,
      maxPositions: MAX_POSITIONS,
      now,
      entryExecution: ENTRY_EXECUTION,
      maxEntryGapPercent: MAX_ENTRY_GAP_PERCENT,
      maxSpreadPercent: MAX_SPREAD_PERCENT,
      notify,
      bookName
    });

    // breadth: count markets with trailing trend above threshold
    markCycleStage('entry_selection');
    const trends = {};
    for (const m of MARKETS) {
      const bars = series[m];
      if (!bars || bars.length < 9) continue;
      trends[m] = trailingTrend(bars, bars.length - 1);
    }
    const breadth = Object.values(trends).filter((t) => t != null && t > TREND_MIN_PERCENT).length;

    const volatilityByMarket = {};
    const volatilityScaleByMarket = {};
    for (const m of MARKETS) {
      const bars = series[m];
      const volatilityPercent = VOLATILITY_TARGET_PERCENT === null
        ? null
        : calculateCloseVolatilityPercent(bars, bars?.length - 1, VOLATILITY_LOOKBACK_DAYS);
      const volatilityScale = VOLATILITY_TARGET_PERCENT === null
        ? 1
        : volatilityPercent === null
          ? null
          : calculateVolatilityPositionScale(volatilityPercent, VOLATILITY_TARGET_PERCENT);
      volatilityByMarket[m] = volatilityPercent;
      volatilityScaleByMarket[m] = volatilityScale;
    }
    ledger.volatilityByMarket = volatilityByMarket;
    ledger.volatilityScaleByMarket = volatilityScaleByMarket;

    // Collect every eligible signal before applying the position limit. This
    // matches the daily research simulator, which ranks the strongest trend
    // first instead of depending on the configured market array order.
    const entryCandidates = [];
    for (const m of MARKETS) {
      if (!dataQuality.valid) {
        ledger.dataQualityBlocked = (ledger.dataQualityBlocked || 0) + 1;
        continue;
      }
      if (ledger.drawdownStopTriggered) {
        ledger.drawdownBlocked = (ledger.drawdownBlocked || 0) + 1;
        continue;
      }
      const pendingMarket = ENTRY_EXECUTION === 'next_open' &&
        (ledger.pendingEntries || []).some(entry => entry.market === m);
      if (ledger.positions[m] || pendingMarket) continue;
      if (isMomentumShadowCooldownActive(ledger, m, now)) {
        ledger.cooldownBlocked = (ledger.cooldownBlocked || 0) + 1;
        continue;
      }
      const bars = series[m];
      if (!bars || bars.length < strategies[m].getMinCandleCount()) continue;
      const r = strategies[m].analyze(bars, now);
      if (r.signal !== 'BUY') continue;
      if (isMomentumShadowSignalConsumed(ledger, m, r.signalKey)) {
        ledger.duplicateSignalBlocked = (ledger.duplicateSignalBlocked || 0) + 1;
        continue;
      }
      if (r.trendPercent <= TREND_MIN_PERCENT) { ledger.gateBlocked = (ledger.gateBlocked || 0) + 1; continue; }
      if (breadth < BREADTH_MIN) { ledger.breadthBlocked = (ledger.breadthBlocked || 0) + 1; continue; }
      if (BENCHMARK_MARKET && !benchmark.gateOpen) {
        ledger.benchmarkBlocked = (ledger.benchmarkBlocked || 0) + 1;
        continue;
      }
      if (RELATIVE_TREND_MIN_PERCENT !== null && !isMomentumShadowRelativeTrendAllowed({
        trendPercent: r.trendPercent,
        benchmarkTrendPercent: benchmark.trendPercent,
        minimumGapPercent: RELATIVE_TREND_MIN_PERCENT
      })) {
        ledger.relativeTrendBlocked = (ledger.relativeTrendBlocked || 0) + 1;
        continue;
      }
      if (MAX_SPREAD_PERCENT > 0 && (
        quoteQuality?.error ||
        quoteQuality?.missingMarkets?.length ||
        quoteQuality?.invalidMarkets?.length ||
        quoteQuality?.blockedMarkets?.includes(m)
      )) {
        ledger.spreadBlocked = (ledger.spreadBlocked || 0) + 1;
        if (!ledger.spreadBlockedByMarket || typeof ledger.spreadBlockedByMarket !== 'object') {
          ledger.spreadBlockedByMarket = {};
        }
        ledger.spreadBlockedByMarket[m] = (ledger.spreadBlockedByMarket[m] || 0) + 1;
        continue;
      }
      const volatilityScale = volatilityScaleByMarket[m];
      if (volatilityScale === null) {
        ledger.volatilityBlocked = (ledger.volatilityBlocked || 0) + 1;
        continue;
      }
      entryCandidates.push({
        market: m,
        bars,
        signal: r,
        volatilityScale,
        trendPercent: r.trendPercent
      });
    }

    // entries
    let plannedBalance = ledger.balance;
    for (const [selectionRank, candidate] of rankMomentumShadowEntryCandidates(
      entryCandidates
    ).entries()) {
      const { market: m, bars, signal: r, volatilityScale } = candidate;
      const pendingCount = ENTRY_EXECUTION === 'next_open' ? (ledger.pendingEntries || []).length : 0;
      if (Object.keys(ledger.positions).length + pendingCount >= MAX_POSITIONS) {
        ledger.blockedSignalCount = (ledger.blockedSignalCount || 0) + 1;
        continue;
      }
      const size = plannedBalance * POSITION_FRACTION * volatilityScale;
      // A below-minimum entry must not consume the signal key: the order is
      // skipped, not executed, and the same candle may retry once cash allows.
      if (size < 5000) continue;
      const entryQuote = (MAX_SPREAD_PERCENT > 0 || EXECUTION_MODEL === 'quote_cross')
        ? compactMomentumShadowQuote(quoteQuality?.byMarket?.[m])
        : null;
      const entryExecution = projectMomentumShadowExecutionPrice({
        model: EXECUTION_MODEL,
        side: 'entry',
        candlePrice: r.referencePrice,
        quote: entryQuote
      });
      if (!entryExecution.available) {
        ledger.executionModelEntryBlocked = (ledger.executionModelEntryBlocked || 0) + 1;
        ledger.lastExecutionModelBlock = {
          stage: 'entry',
          market: m,
          reason: entryExecution.reason,
          at: nowIso
        };
        // Do not consume an otherwise valid signal when the execution model
        // cannot observe its required quote boundary.
        continue;
      }
      if (!strategies[m].consumeSignal(r.signalKey)) {
        ledger.duplicateSignalBlocked = (ledger.duplicateSignalBlocked || 0) + 1;
        continue;
      }
      recordMomentumShadowSignal(ledger, m, r.signalKey);
      plannedBalance -= size;
      if (ENTRY_EXECUTION === 'next_open') {
        ledger.pendingEntries.push({
          market: m,
          signalKey: r.signalKey,
          signalTimestamp: bars[bars.length - 1].ts,
          signalClosePrice: r.referencePrice,
          size,
          volatilityPercent: volatilityByMarket[m],
          volatilityScale,
          selectionRank: selectionRank + 1,
          trendPercent: r.trendPercent,
          breadth,
          signalQuote: entryQuote,
          entryExecution: ENTRY_EXECUTION
        });
      } else {
        ledger.balance -= size;
        ledger.positions[m] = {
          entryPrice: entryExecution.price,
          decisionEntryPrice: r.referencePrice,
          executionModel: entryExecution.model,
          executionPriceSource: entryExecution.source,
          executionQuoteTimestamp: entryExecution.quoteTimestamp,
          entryTs: bars[bars.length - 1].ts,
          entryTimeMs: now,
          signalKey: r.signalKey,
          size,
          volatilityPercent: volatilityByMarket[m],
          volatilityScale,
          selectionRank: selectionRank + 1,
          trendPercent: r.trendPercent,
          breadth,
          signalQuote: entryQuote,
          entryQuote,
          entryExecution: ENTRY_EXECUTION
        };
        ledger.entries = (ledger.entries || 0) + 1;
        notify.send(`momentum open ${m.replace('KRW-', '')}`,
          `7d trend +${r.trendPercent.toFixed(1)}% · breadth ${breadth} · size ${Math.round(size).toLocaleString()} · ${bookName}`,
          ['chart_with_upwards_trend']);
      }
    }

    markCycleStage('cycle_finalize');
    ledger.lastCycleAt = nowIso;
    ledger.cycles = (ledger.cycles || 0) + 1;
    ledger.breadth = breadth;
    ledger.trends = trends;
    const equity = updateMomentumShadowEquity(
      ledger,
      Number(process.env.MOMO_SHADOW_INITIAL_BALANCE) || 100_000_000,
      nowIso
    );
    recordMomentumShadowBenchmarkCheckpoint(ledger, equity, nowIso);
    delete ledger.currentCycleStage;
    delete ledger.currentCycleMarket;
    saveLedger(ledger);
    console.log(`[${nowIso}] cycle ${ledger.cycles} bal=${Math.round(ledger.balance)} equity=${Math.round(ledger.markedEquity || ledger.balance)} unrealized=${Math.round(ledger.unrealizedProfit || 0)} open=${Object.keys(ledger.positions).join(',') || 'none'} breadth=${breadth} trades=${ledger.trades.length}`);
  } finally {
    clearTimeout(cycleTimeout);
  }
}

async function main() {
  if (CANDIDATE_SLOT_FILE) {
    acquireMomentumShadowCandidateSlot({
      file: CANDIDATE_SLOT_FILE,
      pid: process.pid,
      dir: path.resolve(DIR)
    });
    candidateSlotOwned = true;
  }
  const staleRecovery = acquireLock();
  let ledger = loadLedger();
  const explicitExecutionModel = process.env.MOMO_SHADOW_EXECUTION_MODEL !== undefined;
  const persistedExecutionModel = ledger?.config?.executionModel;
  if (explicitExecutionModel && ledger && persistedExecutionModel !== undefined &&
    resolveMomentumShadowExecutionModel(persistedExecutionModel) !==
      resolveMomentumShadowExecutionModel(process.env.MOMO_SHADOW_EXECUTION_MODEL) &&
    ((ledger.pendingEntries || []).length > 0 || Object.keys(ledger.positions || {}).length > 0)) {
    throw new Error(
      `FAIL_CLOSED: open paper state requires persisted execution model=${resolveMomentumShadowExecutionModel(persistedExecutionModel)}`
    );
  }
  if (explicitExecutionModel && ledger && persistedExecutionModel === undefined &&
    ((ledger.pendingEntries || []).length > 0 || Object.keys(ledger.positions || {}).length > 0 ||
      (ledger.trades || []).length > 0)) {
    throw new Error(
      'FAIL_CLOSED: legacy paper state cannot adopt quote execution without a fresh isolated ledger'
    );
  }
  const explicitEntryExecution = process.env.MOMO_SHADOW_ENTRY_EXECUTION !== undefined;
  const persistedEntryExecution = ledger?.config?.entryExecution;
  if (!explicitEntryExecution && persistedEntryExecution !== undefined) {
    ENTRY_EXECUTION = resolveMomentumShadowEntryExecution(persistedEntryExecution);
  }
  if (explicitEntryExecution && persistedEntryExecution !== undefined &&
    resolveMomentumShadowEntryExecution(persistedEntryExecution) !== ENTRY_EXECUTION &&
    Array.isArray(ledger?.pendingEntries) && ledger.pendingEntries.length > 0) {
    throw new Error(
      `FAIL_CLOSED: pending next-open entries require persisted execution=${resolveMomentumShadowEntryExecution(persistedEntryExecution)}`
    );
  }
  const contract = resolveMomentumShadowRunnerContract({
    mode: process.env.MOMO_SHADOW_MODE,
    markets: process.env.MOMO_SHADOW_MARKETS,
    benchmarkMarket: process.env.MOMO_SHADOW_BENCHMARK_MARKET,
    benchmarkTrendMinPercent: process.env.MOMO_SHADOW_BENCHMARK_TREND_MIN_PERCENT,
    relativeTrendMinPercent: process.env.MOMO_SHADOW_RELATIVE_TREND_MIN_PERCENT,
    exitOnBenchmarkOff: process.env.MOMO_SHADOW_EXIT_ON_BENCHMARK_OFF === undefined
      ? undefined
      : process.env.MOMO_SHADOW_EXIT_ON_BENCHMARK_OFF === 'true',
    cooldownAfterLossDays: process.env.MOMO_SHADOW_COOLDOWN_AFTER_LOSS_DAYS,
    maxPortfolioDrawdownPercent: process.env.MOMO_SHADOW_MAX_PORTFOLIO_DRAWDOWN_PERCENT,
    maxEntryGapPercent: process.env.MOMO_SHADOW_MAX_ENTRY_GAP_PERCENT,
    maxDailyCandleAgeHours: process.env.MOMO_SHADOW_MAX_DAILY_CANDLE_AGE_HOURS,
    maxSpreadPercent: process.env.MOMO_SHADOW_MAX_SPREAD_PERCENT,
    requestIntervalMs: process.env.MOMO_SHADOW_REQUEST_INTERVAL_MS,
    minUpBars: process.env.MOMO_SHADOW_MIN_UP_BARS,
    volatilityLookbackDays: process.env.MOMO_SHADOW_VOLATILITY_LOOKBACK_DAYS,
    volatilityTargetPercent: process.env.MOMO_SHADOW_VOLATILITY_TARGET_PERCENT,
    executionModel: process.env.MOMO_SHADOW_EXECUTION_MODEL,
    persistedConfig: ledger?.config
  });
  MODE = contract.mode;
  MARKETS = contract.markets;
  BENCHMARK_MARKET = contract.benchmarkMarket;
  BENCHMARK_TREND_MIN_PERCENT = contract.benchmarkTrendMinPercent;
  RELATIVE_TREND_MIN_PERCENT = contract.relativeTrendMinPercent;
  EXIT_ON_BENCHMARK_OFF = contract.exitOnBenchmarkOff;
  COOLDOWN_AFTER_LOSS_DAYS = contract.cooldownAfterLossDays ?? 0;
  MAX_PORTFOLIO_DRAWDOWN_PERCENT = contract.maxPortfolioDrawdownPercent ?? 0;
  MAX_ENTRY_GAP_PERCENT = contract.maxEntryGapPercent ?? 0;
  MAX_DAILY_CANDLE_AGE_HOURS = contract.maxDailyCandleAgeHours ?? DEFAULT_MAX_DAILY_CANDLE_AGE_HOURS;
  MAX_SPREAD_PERCENT = contract.maxSpreadPercent ?? 0;
  REQUEST_INTERVAL_MS = contract.requestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS;
  EXECUTION_MODEL = contract.executionModel || resolveMomentumShadowExecutionModel(
    process.env.MOMO_SHADOW_EXECUTION_MODEL || ledger?.config?.executionModel
  );
  strategyConfig.minUpBars = contract.minUpBars ?? 1;
  strategyConfig.maxHoldHours = Number(process.env.MOMO_SHADOW_MAX_HOLD_HOURS) ||
    (MODE === 'regime' ? 24 * 365 : 72);
  // Volatility sizing is part of the sealed contract too: a relaunched book
  // inherits its persisted target/lookback when the env is omitted rather
  // than silently resizing positions on restart.
  VOLATILITY_LOOKBACK_DAYS = Math.max(2, Math.floor(Number(contract.volatilityLookbackDays) || 14));
  VOLATILITY_TARGET_PERCENT = Number.isFinite(Number(contract.volatilityTargetPercent)) &&
    Number(contract.volatilityTargetPercent) > 0
    ? Number(contract.volatilityTargetPercent)
    : null;
  bookName = `${DIR.replace(/[^a-z0-9]+/gi, '-')}·${MODE}`;
  const strategies = {};
  for (const m of MARKETS) strategies[m] = new RegimeMomentumStrategy(strategyConfig);
  const persistedStrategyConfig = { ...strategyConfig };
  delete persistedStrategyConfig.minUpBars;
  const optionalRiskConfig = {};
  if (contract.cooldownAfterLossDays !== null) {
    optionalRiskConfig.cooldownAfterLossDays = COOLDOWN_AFTER_LOSS_DAYS;
  }
  if (contract.maxPortfolioDrawdownPercent !== null) {
    optionalRiskConfig.maxPortfolioDrawdownPercent = MAX_PORTFOLIO_DRAWDOWN_PERCENT;
  }
  // Fresh ledgers always persist the effective safety contract so the
  // recorded config matches what the runner enforces; existing ledgers keep
  // their schema unless the knob was already present, so they do not acquire
  // artificial config drift from newly added keys.
  if (contract.maxEntryGapPercent !== null || !ledger ||
    Object.prototype.hasOwnProperty.call(ledger?.config || {}, 'maxEntryGapPercent')) {
    optionalRiskConfig.maxEntryGapPercent = MAX_ENTRY_GAP_PERCENT;
  }
  if (contract.maxDailyCandleAgeHours !== null || !ledger ||
    Object.prototype.hasOwnProperty.call(ledger?.config || {}, 'maxDailyCandleAgeHours')) {
    optionalRiskConfig.maxDailyCandleAgeHours = MAX_DAILY_CANDLE_AGE_HOURS;
  }
  if (contract.maxSpreadPercent !== null || !ledger ||
    Object.prototype.hasOwnProperty.call(ledger?.config || {}, 'maxSpreadPercent')) {
    optionalRiskConfig.maxSpreadPercent = MAX_SPREAD_PERCENT;
  }
  if (contract.executionModel !== null || !ledger ||
    Object.prototype.hasOwnProperty.call(ledger?.config || {}, 'executionModel')) {
    optionalRiskConfig.executionModel = EXECUTION_MODEL;
  }
  if (contract.requestIntervalMs !== null || !ledger ||
    Object.prototype.hasOwnProperty.call(ledger?.config || {}, 'requestIntervalMs')) {
    optionalRiskConfig.requestIntervalMs = REQUEST_INTERVAL_MS;
  }
  if (contract.minUpBars !== null) optionalRiskConfig.minUpBars = strategyConfig.minUpBars;
  // Relative-strength is optional for legacy ledgers. Persist it for a fresh
  // or explicitly opted-in book, but do not inject a new null key into an
  // older owner because that would manufacture config drift on restart.
  if (contract.relativeTrendMinPercent !== null || !ledger ||
    Object.prototype.hasOwnProperty.call(ledger?.config || {}, 'relativeTrendMinPercent')) {
    optionalRiskConfig.relativeTrendMinPercent = RELATIVE_TREND_MIN_PERCENT;
  }
  // Volatility keys follow the same schema rule as the other optional knobs:
  // recorded when explicitly enabled, part of a fresh ledger's contract, or
  // already present — never injected into an older schema as ambient values.
  if (contract.volatilityLookbackDays !== null || contract.volatilityTargetPercent !== null || !ledger ||
    Object.prototype.hasOwnProperty.call(ledger?.config || {}, 'volatilityLookbackDays')) {
    optionalRiskConfig.volatilityLookbackDays = VOLATILITY_LOOKBACK_DAYS;
  }
  if (contract.volatilityTargetPercent !== null || !ledger ||
    Object.prototype.hasOwnProperty.call(ledger?.config || {}, 'volatilityTargetPercent')) {
    optionalRiskConfig.volatilityTargetPercent = VOLATILITY_TARGET_PERCENT;
  }
  if (ENTRY_EXECUTION === 'next_open' || !ledger ||
    Object.prototype.hasOwnProperty.call(ledger?.config || {}, 'entryExecution')) {
    optionalRiskConfig.entryExecution = ENTRY_EXECUTION;
  }
  if (!ledger) {
    ledger = {
      diagnosticOnly: true, promoted: false,
      startedAt: new Date().toISOString(),
      config: { mode: MODE, ...persistedStrategyConfig, trendMinPercent: TREND_MIN_PERCENT, breadthMin: BREADTH_MIN, costPercent: COST_PERCENT, positionFraction: POSITION_FRACTION, maxPositions: MAX_POSITIONS, markets: MARKETS, pollMs: POLL_MS, benchmarkMarket: BENCHMARK_MARKET, benchmarkTrendMinPercent: BENCHMARK_TREND_MIN_PERCENT, exitOnBenchmarkOff: EXIT_ON_BENCHMARK_OFF, ...optionalRiskConfig },
      balance: Number(process.env.MOMO_SHADOW_INITIAL_BALANCE) || 100_000_000,
      initialBalance: Number(process.env.MOMO_SHADOW_INITIAL_BALANCE) || 100_000_000,
      positions: {}, trades: [], cycles: 0, cooldownUntilByMarket: {}, pendingEntries: []
    };
  } else {
    ensureMomentumShadowInitialBalance(ledger, Number(process.env.MOMO_SHADOW_INITIAL_BALANCE) || 100_000_000);
    const active = { mode: MODE, ...persistedStrategyConfig, trendMinPercent: TREND_MIN_PERCENT, breadthMin: BREADTH_MIN, costPercent: COST_PERCENT, positionFraction: POSITION_FRACTION, maxPositions: MAX_POSITIONS, markets: MARKETS, pollMs: POLL_MS, benchmarkMarket: BENCHMARK_MARKET, benchmarkTrendMinPercent: BENCHMARK_TREND_MIN_PERCENT, exitOnBenchmarkOff: EXIT_ON_BENCHMARK_OFF, ...optionalRiskConfig };
    if (JSON.stringify(ledger.config) !== JSON.stringify(active)) {
      ledger.configDrift = { previous: ledger.config, changedAt: new Date().toISOString() };
      ledger.config = active;
    }
  }
  if (!Array.isArray(ledger.pendingEntries)) ledger.pendingEntries = [];
  ledger.benchmarkObservationSchemaVersion =
    MOMENTUM_SHADOW_BENCHMARK_OBSERVATION_SCHEMA_VERSION;
  ensureMomentumShadowConsumedSignalState(ledger);
  activeLedger = ledger;
  recordMomentumShadowRunnerStart(ledger, {
    pid: process.pid,
    at: new Date().toISOString(),
    staleRecovery,
  });
  saveLedger(ledger);
  startHeartbeatWatchdog(ledger);
  console.log(`momentum shadow started: ${MARKETS.join(',')} hold=${strategyConfig.maxHoldHours}h trend>${TREND_MIN_PERCENT}% breadth>=${BREADTH_MIN} cooldown=${COOLDOWN_AFTER_LOSS_DAYS}d drawdownStop=${MAX_PORTFOLIO_DRAWDOWN_PERCENT}% volatilityTarget=${VOLATILITY_TARGET_PERCENT ?? 'off'}%/${VOLATILITY_LOOKBACK_DAYS}d relativeTrend=${RELATIVE_TREND_MIN_PERCENT === null ? 'off' : `>${RELATIVE_TREND_MIN_PERCENT}% over benchmark`} entryExecution=${ENTRY_EXECUTION} executionModel=${EXECUTION_MODEL} entryGapCeiling=${MAX_ENTRY_GAP_PERCENT}% dailyCandleMaxAge=${MAX_DAILY_CANDLE_AGE_HOURS}h spreadCeiling=${MAX_SPREAD_PERCENT > 0 ? `${MAX_SPREAD_PERCENT}%` : 'off'} requestInterval=${REQUEST_INTERVAL_MS}ms candidateSlot=${CANDIDATE_SLOT_FILE ? 'global' : 'off'}`);
  while (true) {
    try { await cycle(ledger, strategies); }
    catch (e) { console.error('cycle error:', e.message); }
    await sleep(POLL_MS);
  }
}

main().catch((error) => {
  console.error('runner startup failure:', error);
  stopRunner('startup_failure', error);
  process.exitCode = 1;
});
