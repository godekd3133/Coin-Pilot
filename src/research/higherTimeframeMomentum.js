import {
  analyzeHistoricalCandleContinuity,
  calculateTradeReturnConfidence,
  historicalTimestampForCandle,
  normalizeHistoricalCandles
} from '../backtest/scalpingBacktest.js';

/**
 * Research-only higher-timeframe momentum contract.
 *
 * This is deliberately separate from the live oversold-reaction strategy.
 * The signal is evaluated only on completed aggregated candles and enters on
 * a later base candle. It is useful for testing the regime-conditioned idea
 * discovered in the research log, but its report can never authorize live
 * orders by itself.
 */
export const DEFAULT_HIGHER_TIMEFRAME_MOMENTUM_CONFIG = Object.freeze({
  initialBalance: 1_000_000,
  tradingFee: 0.0005,
  slippage: 0.001,
  investmentRatio: 0.02,
  minOrderAmount: 5_000,
  baseCandleUnit: 15,
  timeframeMinutes: 60,
  rsiPeriod: 14,
  minRsi: 65,
  requireRsiCrossUp: false,
  trendLookbackMinutes: 7 * 24 * 60,
  minTrendReturnPercent: 0,
  entryDelayBaseCandles: 1,
  stopLossPercent: 3,
  takeProfitPercent: 5,
  maxHoldMinutes: 24 * 60,
  cooldownAfterLossMinutes: 60,
  maxConsecutiveLosses: 3,
  maxPositions: 4,
  portfolioPositionFraction: 0.25,
  requireHistoricalCandleContinuity: true
});

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function candleOpen(candle) {
  return finiteNumber(candle?.opening_price, finiteNumber(candle?.trade_price));
}

function candleClose(candle) {
  return finiteNumber(candle?.trade_price, candleOpen(candle));
}

function candleHigh(candle) {
  return finiteNumber(candle?.high_price, Math.max(candleOpen(candle), candleClose(candle)));
}

function candleLow(candle) {
  return finiteNumber(candle?.low_price, Math.min(candleOpen(candle), candleClose(candle)));
}

function aggregateQualityFailure(candles, config, dataQuality, reason = dataQuality.reason) {
  return {
    baseCandleCount: candles.length,
    timeframeMinutes: config.timeframeMinutes,
    ratio: null,
    candles: [],
    discardedPartialCandleCount: 0,
    dataQuality: {
      ...dataQuality,
      valid: false,
      reason
    }
  };
}

/**
 * Aggregate a contiguous chronological base-candle series into completed
 * higher-timeframe candles. The first group is anchored to the first source
 * candle instead of being padded to a wall-clock boundary; this avoids
 * manufacturing data when a cache begins mid-hour.
 */
export function aggregateHigherTimeframeCandles(rawCandles, config = {}) {
  const options = { ...DEFAULT_HIGHER_TIMEFRAME_MOMENTUM_CONFIG, ...config };
  const candles = normalizeHistoricalCandles(rawCandles);
  const baseCandleUnit = finiteNumber(options.baseCandleUnit, 15);
  const timeframeMinutes = finiteNumber(options.timeframeMinutes, 60);
  const ratio = timeframeMinutes / baseCandleUnit;
  const dataQuality = analyzeHistoricalCandleContinuity(candles, baseCandleUnit, {
    maxGapSeconds: options.maxHistoricalCandleGapSeconds
  });

  if (!Number.isInteger(ratio) || ratio < 2) {
    return aggregateQualityFailure(
      candles,
      options,
      dataQuality,
      'higher_timeframe_ratio_must_be_an_integer_at_least_two'
    );
  }
  if (options.requireHistoricalCandleContinuity !== false && !dataQuality.valid) {
    return aggregateQualityFailure(candles, options, dataQuality);
  }

  const intervalMs = baseCandleUnit * 60 * 1000;
  const aggregated = [];
  let startIndex = 0;
  while (startIndex + ratio <= candles.length) {
    const group = candles.slice(startIndex, startIndex + ratio);
    const timestamps = group.map(historicalTimestampForCandle);
    const complete = timestamps.every((timestamp, index) => index === 0 ||
      timestamp - timestamps[index - 1] === intervalMs);
    if (!complete || timestamps[0] === null) {
      return aggregateQualityFailure(
        candles,
        options,
        dataQuality,
        'higher_timeframe_source_group_not_contiguous'
      );
    }

    const first = group[0];
    const last = group.at(-1);
    const open = candleOpen(first);
    const close = candleClose(last);
    const high = Math.max(...group.map(candleHigh));
    const low = Math.min(...group.map(candleLow));
    const volume = group
      .map(candle => Number(candle?.candle_acc_trade_volume))
      .filter(Number.isFinite)
      .reduce((sum, value) => sum + value, 0);
    const startTimestamp = timestamps[0];
    const endTimestamp = timestamps.at(-1) + intervalMs;
    aggregated.push({
      candle_date_time_utc: new Date(startTimestamp).toISOString(),
      candle_end_time_utc: new Date(endTimestamp).toISOString(),
      timestamp: startTimestamp,
      endTimestamp,
      opening_price: open,
      high_price: high,
      low_price: low,
      trade_price: close,
      candle_acc_trade_volume: volume,
      sourceStartIndex: startIndex,
      sourceEndIndex: startIndex + ratio - 1,
      sourceCandleCount: group.length
    });
    startIndex += ratio;
  }

  return {
    baseCandleCount: candles.length,
    timeframeMinutes,
    ratio,
    candles: aggregated,
    discardedPartialCandleCount: candles.length - startIndex,
    dataQuality: {
      ...dataQuality,
      valid: true,
      reason: 'higher_timeframe_candles_contiguous'
    }
  };
}

function calculateRsiSeries(candles, period) {
  const prices = candles.map(candleClose);
  const values = Array(prices.length).fill(null);
  const normalizedPeriod = Math.max(1, Math.floor(finiteNumber(period, 14)));
  if (prices.length < normalizedPeriod + 1) return values;

  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= normalizedPeriod; index += 1) {
    const difference = prices[index] - prices[index - 1];
    if (difference >= 0) gains += difference;
    else losses -= difference;
  }

  let averageGain = gains / normalizedPeriod;
  let averageLoss = losses / normalizedPeriod;
  values[normalizedPeriod] = averageLoss === 0
    ? 100
    : 100 - (100 / (1 + (averageGain / averageLoss)));

  for (let index = normalizedPeriod + 1; index < prices.length; index += 1) {
    const difference = prices[index] - prices[index - 1];
    const gain = difference >= 0 ? difference : 0;
    const loss = difference < 0 ? -difference : 0;
    averageGain = (averageGain * (normalizedPeriod - 1) + gain) / normalizedPeriod;
    averageLoss = (averageLoss * (normalizedPeriod - 1) + loss) / normalizedPeriod;
    values[index] = averageLoss === 0
      ? 100
      : 100 - (100 / (1 + (averageGain / averageLoss)));
  }
  return values;
}

/**
 * Build signals without consuming any candle after the completed higher-time
 * frame bar. `entryIndex` always points to a later base candle.
 */
export function calculateHigherTimeframeMomentumSignals(rawCandles, config = {}) {
  const options = { ...DEFAULT_HIGHER_TIMEFRAME_MOMENTUM_CONFIG, ...config };
  const candles = normalizeHistoricalCandles(rawCandles);
  const aggregation = aggregateHigherTimeframeCandles(candles, options);
  if (aggregation.candles.length === 0) {
    return {
      available: false,
      candles,
      aggregation,
      signals: [],
      rejectionCounts: {}
    };
  }

  const higherCandles = aggregation.candles;
  const rsiSeries = calculateRsiSeries(higherCandles, options.rsiPeriod);
  const trendBars = Math.max(
    1,
    Math.ceil(finiteNumber(options.trendLookbackMinutes, 7 * 24 * 60) /
      finiteNumber(options.timeframeMinutes, 60))
  );
  const delayBars = Math.max(1, Math.floor(finiteNumber(options.entryDelayBaseCandles, 1)));
  const signals = [];
  const rejectionCounts = {};

  const reject = reason => {
    rejectionCounts[reason] = (rejectionCounts[reason] || 0) + 1;
  };

  for (let higherIndex = Math.max(options.rsiPeriod, trendBars); higherIndex < higherCandles.length; higherIndex += 1) {
    const current = higherCandles[higherIndex];
    const previous = higherCandles[higherIndex - 1];
    const rsi = rsiSeries[higherIndex];
    const previousRsi = rsiSeries[higherIndex - 1];
    const trendReference = higherCandles[higherIndex - trendBars];
    const currentClose = candleClose(current);
    const trendReferenceClose = candleClose(trendReference);
    const trendReturnPercent = trendReferenceClose > 0
      ? ((currentClose - trendReferenceClose) / trendReferenceClose) * 100
      : null;
    const bullishCandle = candleClose(current) > candleOpen(current);
    const rsiConfirmed = Number.isFinite(rsi) && rsi >= options.minRsi &&
      (options.requireRsiCrossUp !== true || (Number.isFinite(previousRsi) && previousRsi < options.minRsi));
    const trendConfirmed = Number.isFinite(trendReturnPercent) &&
      trendReturnPercent >= options.minTrendReturnPercent;
    const rejectionReasons = [];
    if (!bullishCandle) rejectionReasons.push('higher_candle_not_bullish');
    if (!Number.isFinite(rsi) || rsi < options.minRsi) rejectionReasons.push('higher_rsi_below_threshold');
    if (options.requireRsiCrossUp === true && (!Number.isFinite(previousRsi) || previousRsi >= options.minRsi)) {
      rejectionReasons.push('higher_rsi_cross_not_confirmed');
    }
    if (!trendConfirmed) rejectionReasons.push('higher_trend_return_below_threshold');
    for (const reason of rejectionReasons) reject(reason);

    if (!bullishCandle || !rsiConfirmed || !trendConfirmed) continue;

    const entryIndex = current.sourceEndIndex + delayBars;
    if (entryIndex >= candles.length) {
      reject('entry_after_window_end');
      continue;
    }
    signals.push({
      signalKey: current.candle_end_time_utc,
      higherIndex,
      entryIndex,
      signalTimestamp: current.candle_end_time_utc,
      entryTimestamp: historicalTimestampForCandle(candles[entryIndex])
        ? new Date(historicalTimestampForCandle(candles[entryIndex])).toISOString()
        : null,
      rsi,
      previousRsi,
      bullishCandle,
      trendBars,
      trendReturnPercent,
      trendReferenceTimestamp: trendReference.candle_date_time_utc,
      higherTimeframeMinutes: options.timeframeMinutes,
      entryDelayBaseCandles: delayBars,
      rejectionReasons: []
    });
  }

  return {
    available: true,
    candles,
    aggregation,
    higherCandles,
    rsiSeries,
    signals,
    rejectionCounts,
    trendBars,
    entryDelayBaseCandles: delayBars
  };
}

function tradeCloseReturns(trades) {
  return trades.filter(trade => trade.type === 'CLOSE');
}

function createMetrics({ initialBalance, balance, equityCurve, trades, fees, signals, skippedSignals }) {
  const closes = tradeCloseReturns(trades);
  const winningTrades = closes.filter(trade => trade.netProfit > 0);
  const losingTrades = closes.filter(trade => trade.netProfit < 0);
  const grossProfit = winningTrades.reduce((sum, trade) => sum + trade.netProfit, 0);
  const grossLoss = Math.abs(losingTrades.reduce((sum, trade) => sum + trade.netProfit, 0));
  let peak = initialBalance;
  let maxDrawdownPercent = 0;
  for (const point of equityCurve) {
    const equity = finiteNumber(point.equity, initialBalance);
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdownPercent = Math.max(maxDrawdownPercent, ((peak - equity) / peak) * 100);
  }
  const netProfit = closes.reduce((sum, trade) => sum + trade.netProfit, 0);
  return {
    initialBalance,
    finalBalance: balance,
    finalEquity: equityCurve.at(-1)?.equity ?? balance,
    netProfit,
    totalReturnPercent: initialBalance > 0 ? (netProfit / initialBalance) * 100 : 0,
    tradeCount: closes.length,
    winningTrades: winningTrades.length,
    losingTrades: losingTrades.length,
    winRate: closes.length > 0 ? (winningTrades.length / closes.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    grossProfit,
    grossLoss,
    maxDrawdownPercent,
    fees,
    signals,
    skippedSignals,
    tradeReturnConfidence: calculateTradeReturnConfidence(closes)
  };
}

function closePosition(position, candle, reason, exitPrice, config, timestamp) {
  const grossAmount = position.amount * exitPrice;
  const sellFee = grossAmount * config.tradingFee;
  const netReceived = grossAmount - sellFee;
  const netProfit = netReceived - position.investAmount;
  return {
    type: 'CLOSE',
    reason,
    coin: config.market || null,
    entryPrice: position.entryPrice,
    exitPrice,
    amount: position.amount,
    investAmount: position.investAmount,
    grossAmount,
    sellFee,
    netProfit,
    profitPercent: position.investAmount > 0 ? (netProfit / position.investAmount) * 100 : 0,
    entryTime: position.entryTime,
    exitTime: new Date(timestamp).toISOString(),
    signalTime: position.signalTime,
    signalKey: position.signalKey,
    maxFavorableExcursionPercent: position.maxFavorableExcursionPercent,
    maxAdverseExcursionPercent: position.maxAdverseExcursionPercent
  };
}

function updateExcursion(position, candle) {
  const high = candleHigh(candle);
  const low = candleLow(candle);
  position.highestPrice = Math.max(position.highestPrice, high);
  position.lowestPrice = Math.min(position.lowestPrice, low);
  position.maxFavorableExcursionPercent = ((position.highestPrice - position.entryPrice) / position.entryPrice) * 100;
  position.maxAdverseExcursionPercent = ((position.lowestPrice - position.entryPrice) / position.entryPrice) * 100;
}

function findExit(position, candle, timestamp, config) {
  updateExcursion(position, candle);
  const stopPrice = position.entryPrice * (1 - config.stopLossPercent / 100);
  const takePrice = position.entryPrice * (1 + config.takeProfitPercent / 100);
  // Intrabar ordering is unknown; stop first is the conservative convention.
  if (config.stopLossPercent > 0 && candleLow(candle) <= stopPrice) {
    return { reason: 'STOP_LOSS', price: stopPrice * (1 - config.slippage) };
  }
  if (config.takeProfitPercent > 0 && candleHigh(candle) >= takePrice) {
    return { reason: 'TAKE_PROFIT', price: takePrice * (1 - config.slippage) };
  }
  if (config.maxHoldMinutes > 0 && timestamp - position.entryTimestamp >= config.maxHoldMinutes * 60 * 1000) {
    return { reason: 'MAX_HOLD_TIME', price: candleOpen(candle) * (1 - config.slippage) };
  }
  return null;
}

function failureResult(candles, config, aggregation, reason) {
  const metrics = createMetrics({
    initialBalance: config.initialBalance,
    balance: config.initialBalance,
    equityCurve: [],
    trades: [],
    fees: 0,
    signals: 0,
    skippedSignals: 0
  });
  return {
    market: config.market || null,
    available: false,
    candles,
    aggregation,
    signals: [],
    trades: [],
    equityCurve: [],
    openPosition: null,
    unknownBoundaryPositions: [],
    metrics,
    dataQuality: {
      ...(aggregation?.dataQuality || {}),
      valid: false,
      reason
    },
    promotion: 'diagnostic_only_never_authorizes_live_orders'
  };
}

/**
 * Fee/slippage-aware single-market simulation for the research lane.
 * `startTradingIndex` and `endTradingIndex` let walk-forward folds reuse the
 * same historical context while resetting position state at each boundary.
 */
export function simulateHigherTimeframeMomentum(rawCandles, config = {}, simulationOptions = {}) {
  const options = { ...DEFAULT_HIGHER_TIMEFRAME_MOMENTUM_CONFIG, ...config };
  const candles = normalizeHistoricalCandles(rawCandles);
  const signalsResult = calculateHigherTimeframeMomentumSignals(candles, options);
  if (!signalsResult.available) {
    return failureResult(candles, options, signalsResult.aggregation, 'higher_timeframe_data_unavailable');
  }
  if (options.requireHistoricalCandleContinuity !== false && !signalsResult.aggregation.dataQuality.valid) {
    return failureResult(candles, options, signalsResult.aggregation, signalsResult.aggregation.dataQuality.reason);
  }

  const requestedStart = Number(simulationOptions.startTradingIndex);
  const requestedEnd = Number(simulationOptions.endTradingIndex);
  const startTradingIndex = Number.isFinite(requestedStart)
    ? Math.max(0, Math.floor(requestedStart))
    : 0;
  const endTradingIndex = Number.isFinite(requestedEnd)
    ? Math.min(candles.length - 1, Math.floor(requestedEnd))
    : candles.length - 1;
  if (endTradingIndex < startTradingIndex) {
    return failureResult(candles, options, signalsResult.aggregation, 'simulation_window_empty');
  }

  const signalByEntryIndex = new Map(
    signalsResult.signals.map(signal => [signal.entryIndex, signal])
  );
  const trades = [];
  const equityCurve = [];
  let balance = options.initialBalance;
  let fees = 0;
  let position = null;
  let signals = 0;
  let skippedSignals = 0;
  let cooldownUntil = 0;
  let consecutiveLosses = 0;

  for (let index = startTradingIndex; index <= endTradingIndex; index += 1) {
    const candle = candles[index];
    const timestamp = historicalTimestampForCandle(candle) ?? index * options.baseCandleUnit * 60 * 1000;
    let closedThisCandle = false;

    if (position) {
      const exit = findExit(position, candle, timestamp, options);
      if (exit) {
        const closeTrade = closePosition(position, candle, exit.reason, exit.price, options, timestamp);
        balance += closeTrade.grossAmount - closeTrade.sellFee;
        fees += closeTrade.sellFee;
        trades.push(closeTrade);
        position = null;
        closedThisCandle = true;
        if (closeTrade.netProfit < 0) {
          consecutiveLosses += 1;
          cooldownUntil = timestamp + Math.max(
            options.cooldownAfterLossMinutes,
            consecutiveLosses >= options.maxConsecutiveLosses ? 60 : 0
          ) * 60 * 1000;
        } else {
          consecutiveLosses = 0;
          cooldownUntil = 0;
        }
      }
    }

    const signal = signalByEntryIndex.get(index);
    if (!position && !closedThisCandle && signal) {
      signals += 1;
      if (timestamp < cooldownUntil) {
        skippedSignals += 1;
      } else {
        const entryPrice = candleOpen(candle) * (1 + options.slippage);
        const investAmount = Math.min(
          balance * options.investmentRatio,
          balance * 0.95
        );
        if (entryPrice <= 0 || investAmount < options.minOrderAmount) {
          skippedSignals += 1;
        } else {
          const buyFee = investAmount * options.tradingFee;
          const amount = (investAmount - buyFee) / entryPrice;
          balance -= investAmount;
          fees += buyFee;
          position = {
            entryPrice,
            amount,
            investAmount,
            entryTimestamp: timestamp,
            entryTime: new Date(timestamp).toISOString(),
            signalTime: signal.signalTimestamp,
            signalKey: signal.signalKey,
            highestPrice: entryPrice,
            lowestPrice: entryPrice,
            maxFavorableExcursionPercent: 0,
            maxAdverseExcursionPercent: 0
          };
          trades.push({
            type: 'OPEN',
            reason: 'HIGHER_TIMEFRAME_MOMENTUM_ENTRY',
            coin: options.market || null,
            entryPrice,
            amount,
            investAmount,
            buyFee,
            signalTime: signal.signalTimestamp,
            entryTime: position.entryTime,
            signalKey: signal.signalKey,
            rsi: signal.rsi,
            trendReturnPercent: signal.trendReturnPercent,
            higherTimeframeMinutes: signal.higherTimeframeMinutes
          });
        }
      }
    }

    const markPrice = candleClose(candle);
    equityCurve.push({
      timestamp,
      equity: balance + (position ? position.amount * markPrice : 0),
      price: markPrice
    });
  }

  const unknownBoundaryPositions = position
    ? [{
        reason: 'open_position_at_simulation_boundary',
        signalKey: position.signalKey,
        entryTime: position.entryTime,
        entryPrice: position.entryPrice,
        maxFavorableExcursionPercent: position.maxFavorableExcursionPercent,
        maxAdverseExcursionPercent: position.maxAdverseExcursionPercent
      }]
    : [];
  const metrics = createMetrics({
    initialBalance: options.initialBalance,
    balance,
    equityCurve,
    trades,
    fees,
    signals,
    skippedSignals
  });
  return {
    market: options.market || null,
    available: true,
    candles,
    aggregation: signalsResult.aggregation,
    signals: signalsResult.signals,
    rejectionCounts: signalsResult.rejectionCounts,
    trades,
    equityCurve,
    openPosition: position,
    unknownBoundaryPositions,
    metrics,
    dataQuality: signalsResult.aggregation.dataQuality,
    window: { startTradingIndex, endTradingIndex },
    promotion: 'diagnostic_only_never_authorizes_live_orders'
  };
}

function portfolioFailureResult(markets, options, dataQuality, reason) {
  const metrics = createMetrics({
    initialBalance: options.initialBalance,
    balance: options.initialBalance,
    equityCurve: [],
    trades: [],
    fees: 0,
    signals: 0,
    skippedSignals: 0
  });
  return {
    portfolio: true,
    available: false,
    markets,
    trades: [],
    equityCurve: [],
    openPositions: [],
    unknownBoundaryPositions: [],
    metrics,
    entryCount: 0,
    blockedEntryCount: 0,
    rejectionCountsByMarket: {},
    dataQuality: {
      ...(dataQuality || {}),
      valid: false,
      reason
    },
    promotion: 'diagnostic_only_never_authorizes_live_orders'
  };
}

function portfolioTimestampGrid(preparedMarkets, options) {
  const [firstMarket] = preparedMarkets;
  const expectedIntervalMs = finiteNumber(options.baseCandleUnit, 15) * 60 * 1000;
  const referenceTimestamps = firstMarket.candles.map(historicalTimestampForCandle);
  if (referenceTimestamps.some(timestamp => timestamp === null)) {
    return { valid: false, reason: 'portfolio_candle_timestamp_missing_or_invalid' };
  }
  for (const prepared of preparedMarkets) {
    const timestamps = prepared.candles.map(historicalTimestampForCandle);
    if (timestamps.length !== referenceTimestamps.length) {
      return { valid: false, reason: 'portfolio_candle_count_mismatch' };
    }
    for (let index = 0; index < timestamps.length; index += 1) {
      if (timestamps[index] !== referenceTimestamps[index]) {
        return { valid: false, reason: 'portfolio_candle_timestamp_grid_mismatch' };
      }
      if (index > 0 && timestamps[index] - timestamps[index - 1] !== expectedIntervalMs) {
        return { valid: false, reason: 'portfolio_candle_grid_not_contiguous' };
      }
    }
  }
  return {
    valid: true,
    timestamps: referenceTimestamps,
    expectedIntervalSeconds: expectedIntervalMs / 1000
  };
}

/**
 * Shared-balance multi-market replay for the higher-timeframe research lane.
 *
 * Each market must provide the same contiguous base-candle grid. Events that
 * share a timestamp are processed in three deterministic phases: exits,
 * candidate ranking, then entries. A position-limit rejection is counted as a
 * skipped diagnostic signal, never as a fill or counterfactual profit.
 */
export function simulateHigherTimeframeMomentumPortfolio(rawCandlesByMarket, config = {}, simulationOptions = {}) {
  const options = { ...DEFAULT_HIGHER_TIMEFRAME_MOMENTUM_CONFIG, ...config };
  const entries = Object.entries(rawCandlesByMarket || {});
  const markets = entries.map(([market]) => market);
  if (entries.length === 0) {
    return portfolioFailureResult([], options, { marketCount: 0 }, 'portfolio_markets_missing');
  }

  const preparedMarkets = entries.map(([market, rawCandles]) => {
    const candles = normalizeHistoricalCandles(rawCandles);
    const signals = calculateHigherTimeframeMomentumSignals(candles, { ...options, market });
    return { market, candles, signals };
  });
  const invalidMarkets = preparedMarkets
    .filter(prepared => !prepared.signals.available || !prepared.signals.aggregation.dataQuality.valid)
    .map(prepared => ({
      market: prepared.market,
      reason: prepared.signals.aggregation?.dataQuality?.reason || 'higher_timeframe_data_unavailable'
    }));
  if (invalidMarkets.length > 0) {
    return portfolioFailureResult(
      markets,
      options,
      { marketCount: markets.length, invalidMarkets },
      'portfolio_market_data_quality_failed'
    );
  }

  const grid = portfolioTimestampGrid(preparedMarkets, options);
  if (!grid.valid) {
    return portfolioFailureResult(
      markets,
      options,
      { marketCount: markets.length, invalidMarkets: [], grid },
      grid.reason
    );
  }

  const requestedStart = Number(simulationOptions.startTradingIndex);
  const requestedEnd = Number(simulationOptions.endTradingIndex);
  const startTradingIndex = Number.isFinite(requestedStart)
    ? Math.max(0, Math.floor(requestedStart))
    : 0;
  const endTradingIndex = Number.isFinite(requestedEnd)
    ? Math.min(grid.timestamps.length - 1, Math.floor(requestedEnd))
    : grid.timestamps.length - 1;
  if (endTradingIndex < startTradingIndex) {
    return portfolioFailureResult(
      markets,
      options,
      { marketCount: markets.length, grid },
      'portfolio_simulation_window_empty'
    );
  }

  const eventsByTimestamp = new Map();
  const preparedByMarket = new Map(preparedMarkets.map(prepared => [prepared.market, prepared]));
  for (const prepared of preparedMarkets) {
    const signalByEntryIndex = new Map(
      prepared.signals.signals.map(signal => [signal.entryIndex, signal])
    );
    for (let index = startTradingIndex; index <= endTradingIndex; index += 1) {
      const timestamp = grid.timestamps[index];
      const event = {
        market: prepared.market,
        index,
        timestamp,
        candle: prepared.candles[index],
        signal: signalByEntryIndex.get(index) || null
      };
      const group = eventsByTimestamp.get(timestamp) || [];
      group.push(event);
      eventsByTimestamp.set(timestamp, group);
    }
  }

  const sortedGroups = [...eventsByTimestamp.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, group]) => group.sort((a, b) => a.market.localeCompare(b.market)));
  const trades = [];
  const equityCurve = [];
  const positions = new Map();
  const cooldownUntilByMarket = new Map();
  const consecutiveLossesByMarket = new Map();
  let balance = options.initialBalance;
  let fees = 0;
  let signals = 0;
  let skippedSignals = 0;
  let entryCount = 0;
  let blockedEntryCount = 0;
  const rejectionCountsByMarket = Object.fromEntries(
    markets.map(market => [market, preparedByMarket.get(market).signals.rejectionCounts])
  );
  const maxPositions = Math.max(1, Math.floor(finiteNumber(options.maxPositions, 4)));
  const portfolioPositionFraction = Math.min(
    0.95,
    Math.max(0, finiteNumber(options.portfolioPositionFraction, 1 / maxPositions))
  );

  for (const group of sortedGroups) {
    const timestamp = group[0].timestamp;
    const closedMarkets = new Set();

    // Phase 1: all exits at this timestamp release capital before entries.
    for (const event of group) {
      const position = positions.get(event.market);
      if (!position) continue;
      const exit = findExit(position, event.candle, timestamp, options);
      if (!exit) continue;
      const closeTrade = closePosition(
        position,
        event.candle,
        exit.reason,
        exit.price,
        { ...options, market: event.market },
        timestamp
      );
      balance += closeTrade.grossAmount - closeTrade.sellFee;
      fees += closeTrade.sellFee;
      trades.push(closeTrade);
      positions.delete(event.market);
      closedMarkets.add(event.market);
      if (closeTrade.netProfit < 0) {
        const losses = (consecutiveLossesByMarket.get(event.market) || 0) + 1;
        consecutiveLossesByMarket.set(event.market, losses);
        const cooldownMinutes = losses >= Math.max(1, Math.floor(finiteNumber(options.maxConsecutiveLosses, 3)))
          ? Math.max(finiteNumber(options.cooldownAfterLossMinutes, 60), 60)
          : finiteNumber(options.cooldownAfterLossMinutes, 60);
        cooldownUntilByMarket.set(event.market, timestamp + cooldownMinutes * 60 * 1000);
      } else {
        consecutiveLossesByMarket.set(event.market, 0);
        cooldownUntilByMarket.set(event.market, 0);
      }
    }

    // Phase 2: count and rank all confirmed signals in this timestamp group.
    const candidates = group
      .filter(event => event.signal)
      .map(event => {
        signals += 1;
        return event;
      })
      .sort((a, b) =>
        (Number(b.signal.trendReturnPercent) || 0) - (Number(a.signal.trendReturnPercent) || 0) ||
        (Number(b.signal.rsi) || 0) - (Number(a.signal.rsi) || 0) ||
        a.market.localeCompare(b.market)
      );

    // Phase 3: use shared balance and position capacity for entries.
    for (const event of candidates) {
      if (positions.has(event.market) || closedMarkets.has(event.market)) {
        skippedSignals += 1;
        continue;
      }
      const cooldownUntil = cooldownUntilByMarket.get(event.market) || 0;
      if (timestamp < cooldownUntil) {
        skippedSignals += 1;
        continue;
      }
      if (positions.size >= maxPositions) {
        skippedSignals += 1;
        blockedEntryCount += 1;
        continue;
      }
      const entryPrice = candleOpen(event.candle) * (1 + options.slippage);
      const investAmount = Math.min(balance * portfolioPositionFraction, balance * 0.95);
      if (entryPrice <= 0 || investAmount < options.minOrderAmount) {
        skippedSignals += 1;
        continue;
      }
      const buyFee = investAmount * options.tradingFee;
      const amount = (investAmount - buyFee) / entryPrice;
      balance -= investAmount;
      fees += buyFee;
      const position = {
        market: event.market,
        entryPrice,
        amount,
        investAmount,
        entryTimestamp: timestamp,
        entryTime: new Date(timestamp).toISOString(),
        signalTime: event.signal.signalTimestamp,
        signalKey: event.signal.signalKey,
        highestPrice: entryPrice,
        lowestPrice: entryPrice,
        maxFavorableExcursionPercent: 0,
        maxAdverseExcursionPercent: 0
      };
      positions.set(event.market, position);
      entryCount += 1;
      trades.push({
        type: 'OPEN',
        reason: 'HIGHER_TIMEFRAME_MOMENTUM_PORTFOLIO_ENTRY',
        coin: event.market,
        entryPrice,
        amount,
        investAmount,
        buyFee,
        signalTime: event.signal.signalTimestamp,
        entryTime: position.entryTime,
        signalKey: event.signal.signalKey,
        rsi: event.signal.rsi,
        trendReturnPercent: event.signal.trendReturnPercent,
        higherTimeframeMinutes: event.signal.higherTimeframeMinutes
      });
    }

    const candleByMarket = new Map(group.map(event => [event.market, event.candle]));
    let equity = balance;
    for (const [market, position] of positions.entries()) {
      const markCandle = candleByMarket.get(market) || preparedByMarket.get(market).candles[group[0].index];
      const markPrice = candleClose(markCandle);
      updateExcursion(position, markCandle);
      equity += position.amount * markPrice;
    }
    equityCurve.push({ timestamp, equity });
  }

  const unknownBoundaryPositions = [...positions.values()].map(position => ({
    ...position,
    reason: 'open_position_at_portfolio_window_boundary'
  }));
  const metrics = createMetrics({
    initialBalance: options.initialBalance,
    balance,
    equityCurve,
    trades,
    fees,
    signals,
    skippedSignals
  });
  return {
    portfolio: true,
    available: true,
    markets,
    trades,
    equityCurve,
    openPositions: unknownBoundaryPositions,
    unknownBoundaryPositions,
    metrics,
    entryCount,
    blockedEntryCount,
    rejectionCountsByMarket,
    dataQuality: {
      valid: true,
      marketCount: markets.length,
      baseCandleCount: preparedMarkets[0].candles.length,
      expectedIntervalSeconds: grid.expectedIntervalSeconds,
      gridAligned: true,
      marketDataQuality: Object.fromEntries(preparedMarkets.map(prepared => [
        prepared.market,
        prepared.signals.aggregation.dataQuality
      ]))
    },
    window: { startTradingIndex, endTradingIndex },
    promotion: 'diagnostic_only_never_authorizes_live_orders'
  };
}

function passesMetricGate(metrics, options) {
  const confidence = metrics.tradeReturnConfidence;
  return metrics.tradeCount >= options.minimumValidationTrades &&
    metrics.profitFactor >= options.minimumProfitFactor &&
    metrics.totalReturnPercent >= options.minimumReturnPercent &&
    metrics.maxDrawdownPercent <= options.maximumDrawdownPercent &&
    (confidence?.lowerBoundPercent ?? -Infinity) >= options.minimumConfidenceLowerBoundPercent;
}

/**
 * Expanding walk-forward diagnostic. Every fold resets position state and
 * requires the validation interval to pass; the result is still marked
 * research-only because this contract is not wired to runtime/live gates.
 */
export function walkForwardValidateHigherTimeframeMomentum(rawCandles, config = {}, validationOptions = {}) {
  const options = { ...DEFAULT_HIGHER_TIMEFRAME_MOMENTUM_CONFIG, ...config };
  const candles = normalizeHistoricalCandles(rawCandles);
  const folds = Math.max(1, Math.floor(finiteNumber(validationOptions.folds, 3)));
  const minimumTrainingFraction = finiteNumber(validationOptions.minimumTrainingFraction, 0.5);
  const validationFraction = finiteNumber(
    validationOptions.validationFraction,
    Math.min(0.15, (1 - minimumTrainingFraction) / folds)
  );
  const metricOptions = {
    minimumTrainingTrades: Math.max(0, Math.floor(finiteNumber(validationOptions.minimumTrainingTrades, 5))),
    minimumValidationTrades: Math.max(1, Math.floor(finiteNumber(validationOptions.minimumValidationTrades, 5))),
    minimumTrainingProfitFactor: finiteNumber(validationOptions.minimumTrainingProfitFactor, 1),
    minimumProfitFactor: finiteNumber(validationOptions.minimumProfitFactor, 1.05),
    minimumTrainingReturnPercent: finiteNumber(validationOptions.minimumTrainingReturnPercent, 0),
    minimumReturnPercent: finiteNumber(validationOptions.minimumReturnPercent, 0.1),
    maximumDrawdownPercent: finiteNumber(validationOptions.maximumDrawdownPercent, 15),
    minimumConfidenceLowerBoundPercent: finiteNumber(validationOptions.minimumConfidenceLowerBoundPercent, 0)
  };
  const foldsResult = [];
  let allFoldsPassed = true;

  for (let fold = 0; fold < folds; fold += 1) {
    const trainEndFraction = minimumTrainingFraction + fold * validationFraction;
    const validationEndFraction = Math.min(1, trainEndFraction + validationFraction);
    const trainEndIndex = Math.floor(candles.length * trainEndFraction) - 1;
    const validationEndIndex = Math.floor(candles.length * validationEndFraction) - 1;
    if (trainEndIndex < 0 || validationEndIndex <= trainEndIndex) continue;

    const training = simulateHigherTimeframeMomentum(candles, options, {
      startTradingIndex: 0,
      endTradingIndex: trainEndIndex
    });
    const validation = simulateHigherTimeframeMomentum(candles, options, {
      startTradingIndex: trainEndIndex + 1,
      endTradingIndex: validationEndIndex
    });
    const trainingPasses = training.metrics.tradeCount >= metricOptions.minimumTrainingTrades &&
      training.metrics.profitFactor >= metricOptions.minimumTrainingProfitFactor &&
      training.metrics.totalReturnPercent >= metricOptions.minimumTrainingReturnPercent;
    const validationPasses = passesMetricGate(validation.metrics, metricOptions);
    const passed = trainingPasses && validationPasses &&
      validation.unknownBoundaryPositions.length === 0;
    allFoldsPassed = allFoldsPassed && passed;
    foldsResult.push({
      fold,
      trainRange: { startIndex: 0, endIndex: trainEndIndex },
      validationRange: { startIndex: trainEndIndex + 1, endIndex: validationEndIndex },
      training: training.metrics,
      validation: validation.metrics,
      unknownBoundaryPositionCount: validation.unknownBoundaryPositions.length,
      trainingPasses,
      validationPasses,
      passed
    });
  }

  const available = foldsResult.length === folds;
  return {
    available,
    folds: foldsResult,
    foldCount: foldsResult.length,
    allFoldsPassed: available && allFoldsPassed,
    promoted: false,
    promotionReason: 'higher_timeframe_momentum_is_research_only_and_not_wired_to_live_gate',
    dataQuality: foldsResult.length > 0
      ? foldsResult[0].validation
        ? simulateHigherTimeframeMomentum(candles, options).dataQuality
        : null
      : null
  };
}
