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
  benchmarkExposureMinPercent: null,
  benchmarkExposureMaxPercent: null,
  exitOnBenchmarkOff: false,
  maxPortfolioDrawdownPercent: 0,
  mode: 'fixed',
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

function closeOf(candle) {
  return finite(candle?.trade_price ?? candle?.close ?? candle?.c);
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
      close
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
    entryCount: 0,
    blockedSignalCount: 0,
    signals: 0,
    promotion: 'research_only_never_authorizes_live_orders'
  };
}

/**
 * Shared-balance daily replay for the defensive momentum candidate.
 * Signals and exits use only the completed daily close at the current index;
 * no future candle is used to decide the same index's entry.
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
  const benchmarkExposureMinPercent = finite(options.benchmarkExposureMinPercent, null);
  const benchmarkExposureMaxPercent = finite(options.benchmarkExposureMaxPercent, null);
  const exitOnBenchmarkOff = options.exitOnBenchmarkOff === true;
  const maxPortfolioDrawdownPercent = Math.max(0, finite(options.maxPortfolioDrawdownPercent, 0));
  const mode = options.mode === 'regime' ? 'regime' : 'fixed';
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

  const markets = Object.keys(normalized);
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

  const trendAt = (market, index) => {
    const candles = normalized[market];
    if (index < trendLookbackDays) return null;
    const reference = candles[index - trendLookbackDays].close;
    return reference > 0 ? ((candles[index].close - reference) / reference) * 100 : null;
  };

  for (let index = trendLookbackDays; index < timestamps.length; index += 1) {
    const timestamp = timestamps[index];
    const benchmarkTrend = benchmarkMarket ? trendAt(benchmarkMarket, index) : null;
    const benchmarkGateOpen = benchmarkMarket === null || benchmarkTrend === null ||
      benchmarkTrend > (benchmarkTrendMinPercent ?? -Infinity);
  const benchmarkOff = benchmarkMarket !== null && benchmarkTrend !== null &&
      benchmarkTrend <= (benchmarkTrendMinPercent ?? -Infinity);
    const benchmarkExposureScale = benchmarkMarket && benchmarkTrend !== null &&
      benchmarkExposureMinPercent !== null && benchmarkExposureMaxPercent !== null &&
      benchmarkExposureMaxPercent > benchmarkExposureMinPercent
      ? Math.min(1, Math.max(0, (benchmarkTrend - benchmarkExposureMinPercent) /
        (benchmarkExposureMaxPercent - benchmarkExposureMinPercent)))
      : 1;

    // Exits happen before entries, matching the forward runner. Newly opened
    // positions cannot exit on their own entry candle.
    for (const [market, position] of [...positions.entries()]) {
      const candle = normalized[market][index];
      const rawProfitPercent = ((candle.close - position.entryPrice) / position.entryPrice) * 100;
      const trendPercent = trendAt(market, index);
      const heldDays = (timestamp - position.entryTimestamp) / DAY_MS;
      const fixedExit = mode === 'fixed' && heldDays >= maxHoldDays;
      const regimeExit = mode === 'regime' && trendPercent !== null && trendPercent <= trendMinPercent;
      const benchmarkExit = mode === 'regime' && exitOnBenchmarkOff && benchmarkOff;
      if (!fixedExit && !regimeExit && !benchmarkExit) continue;
      const profitPercent = rawProfitPercent - costPercent;
      const profitAmount = position.size * (profitPercent / 100);
      balance += position.size + profitAmount;
      trades.push({
        market,
        entryTimestamp: new Date(position.entryTimestamp).toISOString(),
        entryPrice: position.entryPrice,
        exitTimestamp: new Date(timestamp).toISOString(),
        exitPrice: candle.close,
        exit: fixedExit ? 'MAX_HOLD' : benchmarkExit ? 'BENCHMARK_OFF' : 'REGIME_OFF',
        profitPercent,
        profitAmount,
        heldDays
      });
      positions.delete(market);
      cooldownUntilByMarket.set(
        market,
        profitPercent < 0 ? timestamp + cooldownAfterLossDays * DAY_MS : 0
      );
    }

    const trends = Object.fromEntries(markets.map(market => [market, trendAt(market, index)]));
    const breadth = Object.values(trends).filter(value => value !== null && value > trendMinPercent).length;
    const candidates = [];
    for (const market of markets) {
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
      signals += 1;
      candidates.push({ market, candle, trendPercent, breadth });
    }
    candidates.sort((a, b) => b.trendPercent - a.trendPercent || a.market.localeCompare(b.market));
    for (const candidate of candidates) {
      if (drawdownStopTriggered) continue;
      if (positions.size >= maxPositions) {
        blockedSignalCount += 1;
        continue;
      }
      const size = balance * positionFraction * benchmarkExposureScale;
      if (size <= 0) continue;
      balance -= size;
      positions.set(candidate.market, {
        market: candidate.market,
        entryTimestamp: timestamp,
        entryPrice: candidate.candle.close,
        size,
        benchmarkExposureScale,
        trendPercent: candidate.trendPercent,
        breadth: candidate.breadth
      });
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
      for (const [market, position] of [...positions.entries()]) {
        const exitCandle = normalized[market][index];
        const rawProfitPercent = ((exitCandle.close - position.entryPrice) / position.entryPrice) * 100;
        const profitPercent = rawProfitPercent - costPercent;
        const profitAmount = position.size * (profitPercent / 100);
        balance += position.size + profitAmount;
        trades.push({
          market,
          entryTimestamp: new Date(position.entryTimestamp).toISOString(),
          entryPrice: position.entryPrice,
          exitTimestamp: new Date(timestamp).toISOString(),
          exitPrice: exitCandle.close,
          exit: 'PORTFOLIO_DRAWDOWN_STOP',
          profitPercent,
          profitAmount,
          heldDays: (timestamp - position.entryTimestamp) / DAY_MS
        });
        positions.delete(market);
      }
      drawdownStopTriggered = true;
      drawdownStopAt = new Date(timestamp).toISOString();
      equity = balance;
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
      benchmarkExposureMinPercent,
      benchmarkExposureMaxPercent,
      exitOnBenchmarkOff
      ,maxPortfolioDrawdownPercent
    },
    dataQuality,
    metrics,
    finalBalance: balance,
    finalEquity,
    trades,
    openPositions,
    unknownBoundaryPositions: openPositions,
    unknownBoundaryPositionCount: openPositions.length,
    entryCount: trades.length + openPositions.length,
    blockedSignalCount,
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
        dataQuality: result.dataQuality
      };
    });
    const allSegmentsAvailable = segments.every(segment => segment.available);
    const allSegmentsNonNegative = allSegmentsAvailable && segments.every(segment =>
      segment.metrics.totalReturnPercent >= 0 && segment.unknownBoundaryPositionCount === 0
    );
    return {
      name: variant.name,
      config,
      full: {
        available: full.available,
        metrics: full.metrics,
        unknownBoundaryPositionCount: full.unknownBoundaryPositionCount,
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
