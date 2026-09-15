import {
  calculateCloseVolatilityPercent,
  calculateVolatilityPositionScale
} from './momentumShadowVolatility.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_DAILY_MOMENTUM_CONFIG = Object.freeze({
  initialBalance: 100_000_000,
  trendLookbackDays: 7,
  trendMinPercent: 0,
  breadthMin: 1,
  requireUpBar: true,
  minUpBars: 1,
  costPercent: 0.2,
  positionFraction: 0.25,
  maxPositions: 4,
  maxHoldDays: 3,
  cooldownAfterLossDays: 0,
  benchmarkMarket: null,
  benchmarkTrendMinPercent: null,
  benchmarkMinUpBars: 1,
  benchmarkExitConfirmationBars: 1,
  regimeExitConfirmationBars: 1,
  relativeTrendMinPercent: null,
  volatilityLookbackDays: 14,
  volatilityTargetPercent: null,
  excludeBenchmarkFromEntries: false,
  excludeBenchmarkFromBreadth: false,
  benchmarkExposureMinPercent: null,
  benchmarkExposureMaxPercent: null,
  exitOnBenchmarkOff: false,
  stopLossPercent: 0,
  maxPortfolioDrawdownPercent: 0,
  mode: 'fixed',
  // `close` preserves the original diagnostic contract. `next_open` is an
  // explicit execution-boundary stress lane: a signal observed at the
  // completed close is filled at the following candle's opening price.
  entryExecution: 'close',
  // `close` preserves the original exit contract. `next_open` defers a
  // close-based exit signal to the following candle's opening price.
  exitExecution: 'close',
  // Research-only ceiling for adverse overnight gaps on next-open entries.
  // Zero disables the guard and preserves the original execution contract.
  maxEntryGapPercent: 0,
  excludeCurrentUtcDay: true
});

export const DEFAULT_DAILY_MOMENTUM_VARIANTS = Object.freeze([
  { name: 'fixed_trend0_breadth1', config: { mode: 'fixed', trendMinPercent: 0, breadthMin: 1, maxHoldDays: 3 } },
  { name: 'fixed_trend1_breadth2', config: { mode: 'fixed', trendMinPercent: 1, breadthMin: 2, maxHoldDays: 3 } },
  { name: 'fixed_trend2_breadth3', config: { mode: 'fixed', trendMinPercent: 2, breadthMin: 3, maxHoldDays: 3 } },
  { name: 'fixed_trend3_breadth4', config: { mode: 'fixed', trendMinPercent: 3, breadthMin: 4, maxHoldDays: 3 } },
  { name: 'regime_trend0_breadth1', config: { mode: 'regime', trendMinPercent: 0, breadthMin: 1, maxHoldDays: 3650 } },
  { name: 'regime_trend1_breadth2', config: { mode: 'regime', trendMinPercent: 1, breadthMin: 2, maxHoldDays: 3650 } },
  { name: 'regime_trend2_breadth3', config: { mode: 'regime', trendMinPercent: 2, breadthMin: 3, maxHoldDays: 3650 } },
  { name: 'regime_trend3_breadth4', config: { mode: 'regime', trendMinPercent: 3, breadthMin: 4, maxHoldDays: 3650 } },
  { name: 'fixed_trend1_breadth2_up2_cooldown3', config: { mode: 'fixed', trendMinPercent: 1, breadthMin: 2, minUpBars: 2, cooldownAfterLossDays: 3, maxHoldDays: 3 } },
  { name: 'regime_trend1_breadth2_up2_cooldown3', config: { mode: 'regime', trendMinPercent: 1, breadthMin: 2, minUpBars: 2, cooldownAfterLossDays: 3, maxHoldDays: 3650 } },
  { name: 'fixed_trend2_breadth3_up2', config: { mode: 'fixed', trendMinPercent: 2, breadthMin: 3, minUpBars: 2, maxHoldDays: 3 } },
  { name: 'regime_trend2_breadth3_up2', config: { mode: 'regime', trendMinPercent: 2, breadthMin: 3, minUpBars: 2, maxHoldDays: 3650 } },
  { name: 'fixed_trend1_breadth2_btc_gate', config: { mode: 'fixed', trendMinPercent: 1, breadthMin: 2, benchmarkMarket: 'KRW-BTC', benchmarkTrendMinPercent: 0, maxHoldDays: 3 } },
  { name: 'regime_trend1_breadth2_btc_gate', config: { mode: 'regime', trendMinPercent: 1, breadthMin: 2, benchmarkMarket: 'KRW-BTC', benchmarkTrendMinPercent: 0, maxHoldDays: 3650 } },
  { name: 'regime_trend1_breadth2_btc_gate_exit', config: { mode: 'regime', trendMinPercent: 1, breadthMin: 2, benchmarkMarket: 'KRW-BTC', benchmarkTrendMinPercent: 0, exitOnBenchmarkOff: true, maxHoldDays: 3650 } },
  { name: 'fixed_trend0_breadth1_btc_gate1', config: { mode: 'fixed', trendMinPercent: 0, breadthMin: 1, benchmarkMarket: 'KRW-BTC', benchmarkTrendMinPercent: 1, maxHoldDays: 3 } },
  { name: 'regime_trend0_breadth1_btc_gate2_exit', config: { mode: 'regime', trendMinPercent: 0, breadthMin: 1, benchmarkMarket: 'KRW-BTC', benchmarkTrendMinPercent: 2, exitOnBenchmarkOff: true, maxHoldDays: 3650 } },
  { name: 'regime_trend1_breadth2_btc_gate2_exit', config: { mode: 'regime', trendMinPercent: 1, breadthMin: 2, benchmarkMarket: 'KRW-BTC', benchmarkTrendMinPercent: 2, exitOnBenchmarkOff: true, maxHoldDays: 3650 } },
  { name: 'regime_trend2_breadth3_btc_gate2_exit', config: { mode: 'regime', trendMinPercent: 2, breadthMin: 3, benchmarkMarket: 'KRW-BTC', benchmarkTrendMinPercent: 2, exitOnBenchmarkOff: true, maxHoldDays: 3650 } },
  { name: 'regime_trend2_breadth3_btc_gate2_exit_dd15', config: { mode: 'regime', trendMinPercent: 2, breadthMin: 3, benchmarkMarket: 'KRW-BTC', benchmarkTrendMinPercent: 2, exitOnBenchmarkOff: true, maxPortfolioDrawdownPercent: 15, maxHoldDays: 3650 } },
  { name: 'regime_trend1_breadth2_btc_linear_exposure', config: { mode: 'regime', trendMinPercent: 1, breadthMin: 2, benchmarkMarket: 'KRW-BTC', benchmarkTrendMinPercent: -100, benchmarkExposureMinPercent: -5, benchmarkExposureMaxPercent: 5, maxHoldDays: 3650 } },
  { name: 'regime_trend2_breadth3_btc_linear_exposure', config: { mode: 'regime', trendMinPercent: 2, breadthMin: 3, benchmarkMarket: 'KRW-BTC', benchmarkTrendMinPercent: -100, benchmarkExposureMinPercent: -5, benchmarkExposureMaxPercent: 5, maxHoldDays: 3650 } }
]);

function finite(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalFinite(value, fallback = null) {
  return value === null || value === undefined || value === ''
    ? fallback
    : finite(value, fallback);
}

function closeOf(candle) {
  return finite(candle?.trade_price ?? candle?.close ?? candle?.c);
}

function openingPriceOf(candle) {
  return finite(candle?.opening_price ?? candle?.open ?? candle?.o);
}

function timestampOf(candle) {
  const raw = candle?.candle_date_time_utc ?? candle?.timestamp ?? candle?.ts;
  const text = String(raw ?? '');
  const utcText = raw instanceof Date || /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ||
    !/^\d{4}-\d{2}-\d{2}T/.test(text)
    ? text
    : `${text}Z`;
  const timestamp = raw instanceof Date ? raw.getTime() : Date.parse(utcText);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function normalizeDailyCandles(rawCandles, options) {
  if (!Array.isArray(rawCandles)) return [];
  const byTimestamp = new Map();
  const currentUtcDate = new Date(options.asOf ?? Date.now()).toISOString().slice(0, 10);
  for (const candle of rawCandles) {
    const timestamp = timestampOf(candle);
    const close = closeOf(candle);
    if (timestamp === null || close === null || close <= 0) continue;
    if (options.excludeCurrentUtcDay !== false &&
      new Date(timestamp).toISOString().slice(0, 10) === currentUtcDate) continue;
    byTimestamp.set(timestamp, {
      ...candle,
      timestamp,
      close,
      openingPrice: openingPriceOf(candle)
    });
  }
  return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function dataQualityFor(candlesByMarket, options) {
  const entries = Object.entries(candlesByMarket);
  const minimumBars = Math.max(1, Math.floor(finite(options.trendLookbackDays, 7))) +
    Math.max(1, Math.floor(finite(options.minUpBars, 1))) + 1;
  if (entries.length === 0) {
    return { valid: false, reason: 'daily_markets_missing', marketCount: 0, minimumBars };
  }
  const qualityByMarket = {};
  let invalidReason = null;
  for (const [market, candles] of entries) {
    const timestamps = candles.map(candle => candle.timestamp);
    const gaps = [];
    for (let index = 1; index < timestamps.length; index += 1) {
      const gapMs = timestamps[index] - timestamps[index - 1];
      if (gapMs !== DAY_MS) gaps.push(gapMs);
    }
    qualityByMarket[market] = {
      candleCount: candles.length,
      gapCount: gaps.length,
      largestGapDays: gaps.length ? Math.max(...gaps.map(gap => gap / DAY_MS)) : 0,
      firstTimestamp: timestamps[0] ? new Date(timestamps[0]).toISOString() : null,
      lastTimestamp: timestamps.at(-1) ? new Date(timestamps.at(-1)).toISOString() : null,
      valid: candles.length >= minimumBars && gaps.length === 0
    };
    if (!qualityByMarket[market].valid && !invalidReason) {
      invalidReason = candles.length < minimumBars
        ? 'daily_candle_history_too_short'
        : 'daily_candle_grid_not_contiguous';
    }
  }
  if (invalidReason) {
    return { valid: false, reason: invalidReason, marketCount: entries.length, minimumBars, byMarket: qualityByMarket };
  }

  const referenceTimestamps = entries[0][1].map(candle => candle.timestamp);
  const aligned = entries.every(([, candles]) =>
    candles.length === referenceTimestamps.length &&
    candles.every((candle, index) => candle.timestamp === referenceTimestamps[index])
  );
  if (!aligned) {
    return { valid: false, reason: 'daily_candle_grid_not_aligned', marketCount: entries.length, minimumBars, byMarket: qualityByMarket };
  }
  return {
    valid: true,
    reason: 'daily_candle_grid_contiguous',
    marketCount: entries.length,
    minimumBars,
    candleCount: referenceTimestamps.length,
    firstTimestamp: new Date(referenceTimestamps[0]).toISOString(),
    lastTimestamp: new Date(referenceTimestamps.at(-1)).toISOString(),
    byMarket: qualityByMarket
  };
}

/**
 * Normalize and validate a shared completed-daily grid for research lanes.
 * Keeping this seam shared prevents a new hedge/short study from silently
 * adopting different timestamp or incomplete-candle rules.
 */
export function prepareDailyMomentumCandles(rawCandlesByMarket, options = {}) {
  const normalizedOptions = { ...DEFAULT_DAILY_MOMENTUM_CONFIG, ...options };
  const normalized = Object.fromEntries(
    Object.entries(rawCandlesByMarket || {}).map(([market, candles]) => [
      market,
      normalizeDailyCandles(candles, normalizedOptions)
    ])
  );
  return {
    normalized,
    dataQuality: dataQualityFor(normalized, normalizedOptions)
  };
}

function emptyMetrics(initialBalance) {
  return {
    initialBalance,
    finalEquity: initialBalance,
    netProfit: 0,
    totalReturnPercent: 0,
    realizedProfit: 0,
    realizedReturnPercent: 0,
    tradeCount: 0,
    winningTrades: 0,
    losingTrades: 0,
    winRate: 0,
    profitFactor: 0,
    grossProfit: 0,
    grossLoss: 0,
    maxDrawdownPercent: 0,
    exposurePercent: 0
  };
}

function buildMetrics({ initialBalance, finalEquity, balance, trades, equityCurve, exposureDays, totalDays }) {
  const wins = trades.filter(trade => trade.profitPercent > 0);
  const losses = trades.filter(trade => trade.profitPercent < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.profitAmount, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.profitAmount, 0));
  let peak = initialBalance;
  let maxDrawdownPercent = 0;
  for (const value of equityCurve) {
    peak = Math.max(peak, value);
    if (peak > 0) maxDrawdownPercent = Math.max(maxDrawdownPercent, ((peak - value) / peak) * 100);
  }
  // Cash excludes capital still held in open positions. Realized P&L must be
  // derived from closed trades, otherwise every open position is misreported
  // as a loss at the study boundary.
  const realizedProfit = trades.reduce((sum, trade) => sum + trade.profitAmount, 0);
  return {
    initialBalance,
    finalEquity,
    netProfit: finalEquity - initialBalance,
    totalReturnPercent: initialBalance > 0 ? ((finalEquity / initialBalance) - 1) * 100 : 0,
    realizedProfit,
    realizedReturnPercent: initialBalance > 0 ? (realizedProfit / initialBalance) * 100 : 0,
    tradeCount: trades.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    grossProfit,
    grossLoss,
    maxDrawdownPercent,
    exposurePercent: totalDays > 0 ? (exposureDays / totalDays) * 100 : 0
  };
}

function failureResult(options, dataQuality) {
  return {
    available: false,
    promoted: false,
    researchOnly: true,
    dataQuality,
    metrics: emptyMetrics(options.initialBalance),
    trades: [],
    openPositions: [],
    unknownBoundaryPositions: [],
    unknownBoundaryPositionCount: 0,
    unknownBoundaryEntries: [],
    unknownBoundaryEntryCount: 0,
    unknownBoundaryExits: [],
    unknownBoundaryExitCount: 0,
    entryCount: 0,
    blockedSignalCount: 0,
    entryGapBlockedCount: 0,
    signals: 0,
    promotion: 'research_only_never_authorizes_live_orders'
  };
}

/**
 * Shared-balance daily replay for the defensive momentum candidate.
 * Signals and exits use only the completed daily close at the current index;
 * no future candle is used to decide the same index's entry. The default
 * `entryExecution=close` contract keeps the original close-fill diagnostic.
 * The explicit `next_open` lane delays only entry execution to the following
 * candle's opening price, making the boundary assumption measurable without
 * silently changing the existing candidate.
 */
export function simulateDailyMomentumPortfolio(rawCandlesByMarket, config = {}) {
  const options = { ...DEFAULT_DAILY_MOMENTUM_CONFIG, ...config };
  const trendLookbackDays = Math.max(1, Math.floor(finite(options.trendLookbackDays, 7)));
  const initialBalance = Math.max(0, finite(options.initialBalance, 100_000_000));
  const costPercent = Math.max(0, finite(options.costPercent, 0.2));
  const positionFraction = Math.min(0.95, Math.max(0, finite(options.positionFraction, 0.25)));
  const maxPositions = Math.max(1, Math.floor(finite(options.maxPositions, 4)));
  const trendMinPercent = finite(options.trendMinPercent, 0);
  const breadthMin = Math.max(0, Math.floor(finite(options.breadthMin, 1)));
  const minUpBars = Math.max(1, Math.floor(finite(options.minUpBars, 1)));
  const cooldownAfterLossDays = Math.max(0, finite(options.cooldownAfterLossDays, 0));
  const benchmarkMarket = options.benchmarkMarket || null;
  const benchmarkTrendMinPercent = finite(options.benchmarkTrendMinPercent, null);
  const benchmarkMinUpBars = Math.max(1, Math.floor(finite(options.benchmarkMinUpBars, 1)));
  const benchmarkExitConfirmationBars = Math.max(
    1,
    Math.floor(finite(options.benchmarkExitConfirmationBars, 1))
  );
  const regimeExitConfirmationBars = Math.max(
    1,
    Math.floor(finite(options.regimeExitConfirmationBars, 1))
  );
  const relativeTrendMinPercent = optionalFinite(options.relativeTrendMinPercent, null);
  const volatilityLookbackDays = Math.max(2, Math.floor(finite(options.volatilityLookbackDays, 14)));
  const volatilityTargetPercent = optionalFinite(options.volatilityTargetPercent, null);
  const benchmarkExposureMinPercent = finite(options.benchmarkExposureMinPercent, null);
  const benchmarkExposureMaxPercent = finite(options.benchmarkExposureMaxPercent, null);
  const exitOnBenchmarkOff = options.exitOnBenchmarkOff === true;
  const stopLossPercent = Math.max(0, finite(options.stopLossPercent, 0));
  const maxPortfolioDrawdownPercent = Math.max(0, finite(options.maxPortfolioDrawdownPercent, 0));
  const mode = options.mode === 'regime' ? 'regime' : 'fixed';
  const entryExecution = options.entryExecution === 'next_open' ? 'next_open' : 'close';
  const exitExecution = options.exitExecution === 'next_open' ? 'next_open' : 'close';
  const maxEntryGapPercent = Math.max(0, finite(options.maxEntryGapPercent, 0));
  // The forward runner enforces Upbit's 5,000 KRW minimum order. Zero keeps
  // the research simulator floor-free; forward-parity runs should set 5000.
  const minOrderAmount = Math.max(0, finite(options.minOrderAmount, 0));
  const maxHoldDays = Math.max(1, finite(options.maxHoldDays, mode === 'regime' ? 3650 : 3));
  const prepared = prepareDailyMomentumCandles(rawCandlesByMarket, {
    ...options,
    trendLookbackDays,
    minUpBars
  });
  const { normalized, dataQuality } = prepared;
  if (!dataQuality.valid) return failureResult({ ...options, initialBalance }, dataQuality);
  if (benchmarkMarket && !normalized[benchmarkMarket]) {
    return failureResult({ ...options, initialBalance }, {
      ...dataQuality,
      valid: false,
      reason: 'benchmark_market_missing',
      benchmarkMarket
    });
  }
  if (relativeTrendMinPercent !== null && benchmarkMarket === null) {
    return failureResult({ ...options, initialBalance }, {
      ...dataQuality,
      valid: false,
      reason: 'relative_benchmark_missing'
    });
  }

  const markets = Object.keys(normalized);
  if (entryExecution === 'next_open' || exitExecution === 'next_open') {
    const missingOpeningPriceMarkets = markets.filter(market =>
      normalized[market].some(candle => !Number.isFinite(candle.openingPrice) || candle.openingPrice <= 0)
    );
    if (missingOpeningPriceMarkets.length) {
      return failureResult({ ...options, initialBalance, entryExecution }, {
        ...dataQuality,
        valid: false,
        reason: entryExecution === 'next_open'
          ? 'daily_entry_open_price_missing'
          : 'daily_exit_open_price_missing',
        missingOpeningPriceMarkets
      });
    }
  }
  const entryMarkets = benchmarkMarket && options.excludeBenchmarkFromEntries === true
    ? markets.filter(market => market !== benchmarkMarket)
    : markets;
  const breadthMarkets = benchmarkMarket && options.excludeBenchmarkFromBreadth === true
    ? markets.filter(market => market !== benchmarkMarket)
    : markets;
  const timestamps = normalized[markets[0]].map(candle => candle.timestamp);
  let balance = initialBalance;
  const positions = new Map();
  const lastEntryTimestampByMarket = new Map();
  const cooldownUntilByMarket = new Map();
  const trades = [];
  const equityCurve = [];
  let signals = 0;
  let blockedSignalCount = 0;
  let exposureDays = 0;
  let peakEquity = initialBalance;
  let drawdownStopTriggered = false;
  let drawdownStopAt = null;
  let pendingEntries = [];
  let pendingExits = [];
  let entryGapBlockedCount = 0;

  const trendAt = (market, index) => {
    const candles = normalized[market];
    if (index < trendLookbackDays) return null;
    const reference = candles[index - trendLookbackDays].close;
    return reference > 0 ? ((candles[index].close - reference) / reference) * 100 : null;
  };

  const isTrendOffConfirmed = (market, index, threshold, confirmationBars) => {
    for (let offset = 0; offset < confirmationBars; offset += 1) {
      const trend = trendAt(market, index - offset);
      if (trend === null || trend > threshold) return false;
    }
    return true;
  };

  const volatilityScaleAt = (market, index) => {
    if (volatilityTargetPercent === null || volatilityTargetPercent <= 0) return 1;
    const candles = normalized[market];
    const volatilityPercent = calculateCloseVolatilityPercent(
      candles,
      index,
      volatilityLookbackDays
    );
    if (volatilityPercent === null) return null;
    return calculateVolatilityPositionScale(volatilityPercent, volatilityTargetPercent);
  };

  const realizeExit = (
    market,
    position,
    exitPrice,
    exitTimestamp,
    exit,
    effectiveExitTimestamp = exitTimestamp,
    exitIsNextOpen = false
  ) => {
    const rawProfitPercent = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
    const profitPercent = rawProfitPercent - costPercent;
    const profitAmount = position.size * (profitPercent / 100);
    balance += position.size + profitAmount;
    // Recorded timestamps are candle-open times while a close execution
    // semantically happens at that candle's close, so heldDays compares
    // semantic times; otherwise a close entry with a next-open exit is
    // counted one day too long.
    const heldEntryTimestamp = position.entryTimestamp +
      (entryExecution === 'next_open' ? 0 : DAY_MS);
    const heldExitTimestamp = exitTimestamp + (exitIsNextOpen ? 0 : DAY_MS);
    trades.push({
      market,
      entryTimestamp: new Date(position.entryTimestamp).toISOString(),
      entryPrice: position.entryPrice,
      exitTimestamp: new Date(exitTimestamp).toISOString(),
      exitPrice,
      exit,
      entryGapPercent: position.entryGapPercent ?? null,
      profitPercent,
      profitAmount,
      heldDays: (heldExitTimestamp - heldEntryTimestamp) / DAY_MS
    });
    positions.delete(market);
    cooldownUntilByMarket.set(
      market,
      profitPercent < 0 ? effectiveExitTimestamp + cooldownAfterLossDays * DAY_MS : 0
    );
  };

  for (let index = trendLookbackDays; index < timestamps.length; index += 1) {
    const timestamp = timestamps[index];
    const candleCloseTimestamp = timestamp +
      (entryExecution === 'next_open' ? DAY_MS : 0);

    if (exitExecution === 'next_open' && pendingExits.length > 0) {
      const openingExits = pendingExits;
      pendingExits = [];
      for (const pending of openingExits) {
        const exitCandle = normalized[pending.market][index];
        const exitPrice = exitCandle?.openingPrice;
        if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
          pendingExits.push(pending);
          continue;
        }
        const position = positions.get(pending.market);
        if (!position) continue;
        realizeExit(pending.market, position, exitPrice, timestamp, pending.exit, timestamp, true);
      }
    }

    // A next-open entry is planned from the preceding completed close and is
    // filled before observing this candle's close. Planned size is reserved
    // using the prior close's available cash, but cash is debited only at the
    // modeled fill so the interim equity curve does not invent an asset mark.
    if (entryExecution === 'next_open' && pendingEntries.length > 0) {
      const openingEntries = pendingEntries;
      pendingEntries = [];
      for (const pending of openingEntries) {
        if (positions.has(pending.market) || positions.size >= maxPositions) {
          blockedSignalCount += 1;
          continue;
        }
        const entryCandle = normalized[pending.market][index];
        const entryPrice = entryCandle?.openingPrice;
        if (!Number.isFinite(entryPrice) || entryPrice <= 0 || pending.size > balance ||
          pending.size < minOrderAmount) {
          blockedSignalCount += 1;
          continue;
        }
        const signalClosePrice = Number(pending.signalClosePrice);
        const entryGapPercent = Number.isFinite(signalClosePrice) && signalClosePrice > 0
          ? ((entryPrice - signalClosePrice) / signalClosePrice) * 100
          : null;
        if (maxEntryGapPercent > 0 && (
          entryGapPercent === null || entryGapPercent > maxEntryGapPercent
        )) {
          entryGapBlockedCount += 1;
          continue;
        }
        balance -= pending.size;
        positions.set(pending.market, {
          market: pending.market,
          entryTimestamp: timestamp,
          entryPrice,
          size: pending.size,
          benchmarkExposureScale: pending.benchmarkExposureScale,
          volatilityScale: pending.volatilityScale,
          trendPercent: pending.trendPercent,
          breadth: pending.breadth,
          entryGapPercent,
          signalTimestamp: pending.signalTimestamp,
          entryExecution
        });
      }
    }

    const benchmarkTrend = benchmarkMarket ? trendAt(benchmarkMarket, index) : null;
    const benchmarkThreshold = benchmarkTrendMinPercent ?? -Infinity;
    const benchmarkCurrentOpen = benchmarkMarket === null || benchmarkTrend === null ||
      benchmarkTrend > benchmarkThreshold;
    let benchmarkGateOpen = benchmarkCurrentOpen;
    if (benchmarkMarket !== null && benchmarkCurrentOpen && benchmarkMinUpBars > 1) {
      for (let offset = 1; offset < benchmarkMinUpBars; offset += 1) {
        const priorTrend = trendAt(benchmarkMarket, index - offset);
        if (priorTrend === null || priorTrend <= benchmarkThreshold) {
          benchmarkGateOpen = false;
          break;
        }
      }
    }
    const benchmarkOff = benchmarkMarket !== null && benchmarkTrend !== null &&
      benchmarkTrend <= benchmarkThreshold;
    const benchmarkOffConfirmed = benchmarkOff && isTrendOffConfirmed(
      benchmarkMarket,
      index,
      benchmarkThreshold,
      benchmarkExitConfirmationBars
    );
    const benchmarkExposureScale = benchmarkMarket && benchmarkTrend !== null &&
      benchmarkExposureMinPercent !== null && benchmarkExposureMaxPercent !== null &&
      benchmarkExposureMaxPercent > benchmarkExposureMinPercent
      ? Math.min(1, Math.max(0, (benchmarkTrend - benchmarkExposureMinPercent) /
        (benchmarkExposureMaxPercent - benchmarkExposureMinPercent)))
      : 1;

    // Exits happen before entries, matching the forward runner. A close-fill
    // position cannot exit on its entry candle; a next-open position can reach
    // its first completed close after one full daily candle.
    for (const [market, position] of [...positions.entries()]) {
      const candle = normalized[market][index];
      const rawProfitPercent = ((candle.close - position.entryPrice) / position.entryPrice) * 100;
      // A next-open position is entered at the current candle's opening
      // timestamp but its close is observed one day later. The forward
      // shadow runner uses entryTimeMs plus maxHoldHours and exits against
      // that completed candle close, so include the candle duration here to
      // keep a 24-hour fixed contract aligned across research and forward.
      const heldDays = (candleCloseTimestamp - position.entryTimestamp) / DAY_MS;
      const fixedExit = mode === 'fixed' && heldDays >= maxHoldDays;
      const stopLossExit = stopLossPercent > 0 && rawProfitPercent <= -stopLossPercent;
      const regimeExit = mode === 'regime' && isTrendOffConfirmed(
        market,
        index,
        trendMinPercent,
        regimeExitConfirmationBars
      );
      const benchmarkExit = mode === 'regime' && exitOnBenchmarkOff && benchmarkOffConfirmed;
      if (!stopLossExit && !fixedExit && !regimeExit && !benchmarkExit) continue;
      const exit = stopLossExit ? 'STOP_LOSS' : fixedExit ? 'MAX_HOLD' : benchmarkExit ? 'BENCHMARK_OFF' : 'REGIME_OFF';
      if (exitExecution === 'next_open') {
        if (!pendingExits.some(pending => pending.market === market)) {
          pendingExits.push({ market, exit, signalTimestamp: timestamp });
        }
        continue;
      }
      realizeExit(market, position, candle.close, timestamp, exit, candleCloseTimestamp);
    }

    // `trends` must cover every entry candidate, not just the breadth set:
    // a benchmark excluded from breadth but still tradable needs its own
    // trend gate evaluated rather than passing on an undefined lookup.
    const trends = Object.fromEntries(markets.map(market => [market, trendAt(market, index)]));
    const breadth = breadthMarkets.filter(market =>
      trends[market] !== null && trends[market] > trendMinPercent).length;
    const candidates = [];
    for (const market of entryMarkets) {
      const candle = normalized[market][index];
      const trendPercent = trends[market];
      if (positions.has(market) || lastEntryTimestampByMarket.get(market) === timestamp) continue;
      if (cooldownUntilByMarket.get(market) > timestamp) continue;
      if (!benchmarkGateOpen) continue;
      if (options.requireUpBar !== false) {
        const upBarsConfirmed = Array.from({ length: minUpBars }, (_, offset) => index - offset)
          .every(upIndex => upIndex > 0 && normalized[market][upIndex].close > normalized[market][upIndex - 1].close);
        if (!upBarsConfirmed) continue;
      }
      if (trendPercent === null || trendPercent <= trendMinPercent || breadth < breadthMin) continue;
      if (relativeTrendMinPercent !== null && (
        benchmarkTrend === null || trendPercent - benchmarkTrend <= relativeTrendMinPercent
      )) continue;
      const volatilityScale = volatilityScaleAt(market, index);
      if (volatilityScale === null) continue;
      signals += 1;
      candidates.push({ market, candle, trendPercent, breadth, volatilityScale });
    }
    candidates.sort((a, b) => b.trendPercent - a.trendPercent || a.market.localeCompare(b.market));
    let plannedBalance = balance;
    for (const candidate of candidates) {
      if (drawdownStopTriggered) continue;
      if (positions.size + pendingEntries.length >= maxPositions) {
        blockedSignalCount += 1;
        continue;
      }
      const size = plannedBalance * positionFraction * benchmarkExposureScale * candidate.volatilityScale;
      // A below-minimum entry is skipped, not executed, matching the forward
      // runner's `size < 5000` gate when minOrderAmount is enabled.
      if (size <= 0 || size < minOrderAmount) continue;
      plannedBalance -= size;
      if (entryExecution === 'next_open') {
        pendingEntries.push({
          market: candidate.market,
          size,
          benchmarkExposureScale,
          volatilityScale: candidate.volatilityScale,
          trendPercent: candidate.trendPercent,
          breadth: candidate.breadth,
          signalClosePrice: candidate.candle.close,
          signalTimestamp: timestamp
        });
      } else {
        balance -= size;
        positions.set(candidate.market, {
          market: candidate.market,
          entryTimestamp: timestamp,
          entryPrice: candidate.candle.close,
          size,
          benchmarkExposureScale,
          volatilityScale: candidate.volatilityScale,
          trendPercent: candidate.trendPercent,
          breadth: candidate.breadth,
          entryGapPercent: null,
          entryExecution
        });
      }
      lastEntryTimestampByMarket.set(candidate.market, timestamp);
    }

    if (positions.size > 0) exposureDays += 1;
    let equity = balance;
    for (const [market, position] of positions.entries()) {
      const markPrice = normalized[market][index].close;
      const markProfitPercent = ((markPrice - position.entryPrice) / position.entryPrice) * 100 - costPercent;
      equity += position.size * (1 + markProfitPercent / 100);
    }
    peakEquity = Math.max(peakEquity, equity);
    const drawdownPercent = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
    if (!drawdownStopTriggered && maxPortfolioDrawdownPercent > 0 &&
      drawdownPercent >= maxPortfolioDrawdownPercent && positions.size > 0) {
      if (exitExecution === 'next_open') {
        for (const market of positions.keys()) {
          if (!pendingExits.some(pending => pending.market === market)) {
            pendingExits.push({ market, exit: 'PORTFOLIO_DRAWDOWN_STOP', signalTimestamp: timestamp });
          }
        }
      } else {
        for (const [market, position] of [...positions.entries()]) {
          realizeExit(
            market,
            position,
            normalized[market][index].close,
            timestamp,
            'PORTFOLIO_DRAWDOWN_STOP',
            candleCloseTimestamp
          );
        }
      }
      drawdownStopTriggered = true;
      drawdownStopAt = new Date(timestamp).toISOString();
      if (exitExecution !== 'next_open') equity = balance;
    }
    equityCurve.push(equity);
  }

  const openPositions = [...positions.values()].map(position => {
    const markPrice = normalized[position.market].at(-1).close;
    const markProfitPercent = ((markPrice - position.entryPrice) / position.entryPrice) * 100 - costPercent;
    return {
      ...position,
      entryTimestamp: new Date(position.entryTimestamp).toISOString(),
      markPrice,
      markProfitPercent,
      markValue: position.size * (1 + markProfitPercent / 100),
      reason: 'open_position_at_study_boundary'
    };
  });
  const finalEquity = equityCurve.at(-1) ?? balance;
  const metrics = buildMetrics({
    initialBalance,
    finalEquity,
    balance,
    trades,
    equityCurve,
    exposureDays,
    totalDays: Math.max(0, timestamps.length - trendLookbackDays)
  });
  return {
    available: true,
    promoted: false,
    researchOnly: true,
    config: {
      mode,
      trendLookbackDays,
      trendMinPercent,
      breadthMin,
      requireUpBar: options.requireUpBar !== false,
      minUpBars,
      costPercent,
      positionFraction,
      maxPositions,
      maxHoldDays,
      cooldownAfterLossDays,
      benchmarkMarket,
      benchmarkTrendMinPercent,
      benchmarkMinUpBars,
      benchmarkExitConfirmationBars,
      regimeExitConfirmationBars,
      relativeTrendMinPercent,
      volatilityLookbackDays,
      volatilityTargetPercent,
      excludeBenchmarkFromEntries: options.excludeBenchmarkFromEntries === true,
      excludeBenchmarkFromBreadth: options.excludeBenchmarkFromBreadth === true,
      benchmarkExposureMinPercent,
      benchmarkExposureMaxPercent,
      exitOnBenchmarkOff,
      stopLossPercent,
      maxPortfolioDrawdownPercent,
      entryExecution,
      exitExecution,
      maxEntryGapPercent,
      minOrderAmount
    },
    dataQuality,
    metrics,
    finalBalance: balance,
    finalEquity,
    trades,
    openPositions,
    unknownBoundaryPositions: openPositions,
    unknownBoundaryPositionCount: openPositions.length,
    unknownBoundaryEntries: pendingEntries.map(entry => ({
      market: entry.market,
      signalTimestamp: new Date(entry.signalTimestamp).toISOString(),
      plannedSize: entry.size,
      reason: 'entry_after_study_boundary'
    })),
    unknownBoundaryEntryCount: pendingEntries.length,
    unknownBoundaryExits: pendingExits.map(exit => ({
      market: exit.market,
      signalTimestamp: new Date(exit.signalTimestamp).toISOString(),
      exit: exit.exit,
      reason: 'exit_after_study_boundary'
    })),
    unknownBoundaryExitCount: pendingExits.length,
    entryCount: trades.length + openPositions.length,
    blockedSignalCount,
    entryGapBlockedCount,
    signals,
    drawdownStopTriggered,
    drawdownStopAt,
    equityCurve: timestamps.slice(trendLookbackDays).map((timestamp, index) => ({
      timestamp: new Date(timestamp).toISOString(),
      equity: equityCurve[index]
    })),
    promotion: 'research_only_never_authorizes_live_orders'
  };
}

function segmentRanges(candleCount, segmentCount) {
  const count = Math.max(1, Math.floor(finite(segmentCount, 4)));
  return Array.from({ length: count }, (_, index) => ({
    start: Math.floor(candleCount * index / count),
    end: Math.floor(candleCount * (index + 1) / count)
  }));
}

/**
 * Evaluate variants independently over contiguous segments. This is a
 * shortlist diagnostic, not an optimizer and never sets promoted=true.
 */
export function evaluateDailyMomentumVariants(rawCandlesByMarket, {
  variants = DEFAULT_DAILY_MOMENTUM_VARIANTS,
  segmentCount = 4,
  baseConfig = {}
} = {}) {
  const firstMarket = Object.values(rawCandlesByMarket || {})[0] || [];
  const ranges = segmentRanges(firstMarket.length, segmentCount);
  const evaluated = variants.map(variant => {
    const config = { ...DEFAULT_DAILY_MOMENTUM_CONFIG, ...baseConfig, ...(variant.config || {}) };
    const full = simulateDailyMomentumPortfolio(rawCandlesByMarket, config);
    const segments = ranges.map((range, index) => {
      const segmented = Object.fromEntries(Object.entries(rawCandlesByMarket || {}).map(([market, candles]) => [
        market,
        Array.isArray(candles) ? candles.slice(range.start, range.end) : []
      ]));
      const result = simulateDailyMomentumPortfolio(segmented, config);
      return {
        segment: index,
        range,
        available: result.available,
        metrics: result.metrics,
        unknownBoundaryPositionCount: result.unknownBoundaryPositionCount,
        unknownBoundaryEntryCount: result.unknownBoundaryEntryCount,
        unknownBoundaryExitCount: result.unknownBoundaryExitCount,
        dataQuality: result.dataQuality
      };
    });
    const allSegmentsAvailable = segments.every(segment => segment.available);
    const allSegmentsNonNegative = allSegmentsAvailable && segments.every(segment =>
      segment.metrics.totalReturnPercent >= 0 &&
      segment.unknownBoundaryPositionCount === 0 &&
      segment.unknownBoundaryEntryCount === 0 &&
      segment.unknownBoundaryExitCount === 0
    );
    return {
      name: variant.name,
      config,
      full: {
        available: full.available,
        metrics: full.metrics,
        unknownBoundaryPositionCount: full.unknownBoundaryPositionCount,
        unknownBoundaryEntryCount: full.unknownBoundaryEntryCount,
        unknownBoundaryExitCount: full.unknownBoundaryExitCount,
        dataQuality: full.dataQuality,
        drawdownStopTriggered: full.drawdownStopTriggered === true,
        drawdownStopAt: full.drawdownStopAt || null
      },
      segments,
      allSegmentsAvailable,
      allSegmentsNonNegative,
      promoted: false,
      promotionReason: 'daily_momentum_variants_are_research_only_and_not_wired_to_live_gate'
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    study: 'daily_momentum_parameter_sweep',
    researchOnly: true,
    promoted: false,
    variants: evaluated,
    promotionReason: 'daily_momentum_research_never_authorizes_live_orders'
  };
}
