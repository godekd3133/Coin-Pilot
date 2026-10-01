import { number } from './numeric.js';
import {
  analyzeHistoricalCandleContinuity,
  normalizeHistoricalCandles,
  splitHistoricalCandleSegments,
  candleTime
} from './historicalCandleIntegrity.js';
import { calculateTradeReturnConfidence } from './tradeConfidence.js';
import { calculateCostAdjustedBreakEvenPrice } from '../strategy/protectionPrices.js';
import { createLossCircuitBreakerState, isLossCircuitCoolingDown, registerLoss } from '../risk/lossCircuitBreaker.js';
import { resolveScalpingVolatilitySizing } from '../research/scalpingVolatility.js';
import {
  calculateBandAtIndex,
  calculateRsiSeries,
  calculateWindowEma,
  computeReboundPoint,
  decideReboundSignal,
  getClose,
  getHigh,
  getLow,
  getOpen
} from '../analysis/reboundSignal.js';

const DEFAULT_CONFIG = {
  initialBalance: 1_000_000,
  tradingFee: 0.0005,
  slippage: 0.001,
  investmentRatio: 0.02,
  minOrderAmount: 5_000,
  rsiPeriod: 14,
  rsiOversold: 30,
  rsiOverbought: 70,
  oversoldLookback: 1,
  minReboundPercent: 0.15,
  minRsiRecovery: 2,
  minVolumeRatio: 1.0,
  volumeLookback: 20,
  minCloseStrength: 0.65,
  trendPeriod: 30,
  trendSlopeLookback: 3,
  minTrendSlopePercent: -0.2,
  requirePreviousHighBreak: true,
  maxSignalRangePercent: 0,
  minSignalRangePercent: 0,
  // Optional exhaustion guard. Zero preserves the current lower-bound-only
  // rebound contract; positive values reject already-extended rebounds.
  maxReboundPercent: 0,
  requireReboundBelowOverbought: false,
  signalProfile: 'rsi_rebound',
  bbPeriod: 20,
  bbStdDev: 2,
  emaPeriod: 20,
  maxEntryRetracePercent: 0.25,
  maxEntryChasePercent: 0.35,
  // Diagnostic-only alternative: wait for the next candle to close bullish
  // and enter at that close. The live 1-5s contract does not enable this flag.
  requireNextCandleBullish: false,
  stopLossPercent: 1.2,
  takeProfitPercent: 1.8,
  maxHoldMinutes: 30,
  // Optional loss-only time exit. Zero preserves the fixed max-hold contract.
  maxLosingHoldMinutes: 0,
  // Optional winner hold extension. Zero preserves the fixed max-hold
  // contract; a positive value lets a position that is still profitable at
  // the max-hold boundary keep holding until maxHoldMinutes +
  // winnerExtendMinutes with a cost-adjusted break-even floor.
  winnerExtendMinutes: 0,
  winnerExtendMinProfitPercent: 0,
  // Research-only invalidation exit. Zero preserves the fixed max-hold
  // contract; a positive value exits only after price breaks below the
  // completed signal's reference price by the configured percentage.
  referenceBreakExitPercent: 0,
  referenceBreakMinHoldMinutes: 0,
  // Optional portfolio safeguard. Zero preserves the existing multi-entry
  // contract; a positive value caps entries sharing one completed-candle key.
  maxEntriesPerSignalWindow: 0,
  // Disabled by default. These fields let a holdout study test whether a
  // profitable rebound should protect itself before a fixed stop is hit.
  breakEvenTriggerPercent: 0,
  breakEvenOffsetPercent: 0.05,
  trailingActivationPercent: 0,
  trailingStopPercent: 0,
  cooldownAfterLossMinutes: 15,
  maxConsecutiveLosses: 3,
  lossCircuitBreakerCount: 0,
  lossCircuitBreakerWindowMinutes: 30,
  lossCircuitBreakerCooldownMinutes: 60,
  maxPositions: 3,
  portfolioAllocation: 0.1,
  // Historical OHLC must be time-contiguous before it can be used for a
  // simulation. Treating a multi-minute/multi-period gap as one adjacent
  // candle distorts RSI, rolling features, and time-based exits.
  requireHistoricalCandleContinuity: true,
  marketRegimeEnabled: false,
  marketRegimeLookback: 5,
  marketRegimeMinBreadth: 0.5,
  marketRegimeMinReturnPercent: -0.2,
  // Research-only exposure overlay. Zero keeps the fixed-size contract.
  volatilityLookbackCandles: 20,
  volatilityTargetPercent: 0,
  candleUnit: 1
};
function buildReboundFeatureSet(candles, config) {
  const resolvedConfig = { ...DEFAULT_CONFIG, ...config };
  const closes = candles.map(getClose);
  const opens = candles.map(getOpen);
  const highs = candles.map(getHigh);
  const lows = candles.map(getLow);
  const volumes = candles.map(candle => number(candle?.candle_acc_trade_volume, NaN));
  const rsiSeries = calculateRsiSeries(candles, resolvedConfig.rsiPeriod);
  const volumeLookback = Math.max(1, Math.floor(number(resolvedConfig.volumeLookback, 20)));
  const bbPeriod = Math.max(1, Math.floor(number(resolvedConfig.bbPeriod, 20)));
  const bbStdDev = number(resolvedConfig.bbStdDev, 2);
  const emaPeriod = Math.max(1, Math.floor(number(resolvedConfig.emaPeriod, 20)));
  const trendPeriod = Math.max(1, Math.floor(number(resolvedConfig.trendPeriod, 30)));
  const trendSlopeLookback = Math.max(1, Math.floor(number(resolvedConfig.trendSlopeLookback, 3)));
  const closePrefix = [0];
  for (const close of closes) closePrefix.push(closePrefix.at(-1) + close);

  const points = candles.map((candle, index) => {
    const previousClose = index > 0 ? closes[index - 1] : null;
    const currentClose = closes[index];
    const currentOpen = opens[index];
    const currentHigh = highs[index];
    const currentLow = lows[index];
    const candleRange = currentHigh - currentLow;
    const priceChangePercent = previousClose > 0
      ? ((currentClose - previousClose) / previousClose) * 100
      : null;
    const signalRangePercent = previousClose > 0 && Number.isFinite(candleRange)
      ? (candleRange / previousClose) * 100
      : null;
    const closeStrength = candleRange > 0 ? (currentClose - currentLow) / candleRange : 1;
    const volumeStart = Math.max(0, index - volumeLookback);
    const volumeHistory = volumes.slice(volumeStart, index).filter(Number.isFinite);
    const averageVolume = volumeHistory.length > 0
      ? volumeHistory.reduce((sum, volume) => sum + volume, 0) / volumeHistory.length
      : 0;
    const currentVolume = volumes[index];
    const volumeRatio = Number.isFinite(currentVolume) && averageVolume > 0
      ? currentVolume / averageVolume
      : null;

    let trendSlopePercent = null;
    let trendConfirmed = true;
    if (index >= trendPeriod + trendSlopeLookback) {
      const currentStart = index - trendPeriod + 1;
      const previousEnd = index - trendSlopeLookback;
      const previousStart = previousEnd - trendPeriod + 1;
      const currentAverage = (closePrefix[index + 1] - closePrefix[currentStart]) / trendPeriod;
      const previousAverage = (closePrefix[previousEnd + 1] - closePrefix[previousStart]) / trendPeriod;
      if (previousAverage > 0) {
        trendSlopePercent = ((currentAverage - previousAverage) / previousAverage) * 100;
        trendConfirmed = trendSlopePercent >= resolvedConfig.minTrendSlopePercent;
      }
    }

    const currentBand = calculateBandAtIndex(closes, index, bbPeriod, bbStdDev);
    const previousBand = calculateBandAtIndex(closes, index - 1, bbPeriod, bbStdDev);
    const bollingerReclaim = Boolean(
      currentBand && previousBand && index > 0 &&
      closes[index - 1] < previousBand.lower &&
      currentClose >= currentBand.lower &&
      currentClose > closes[index - 1]
    );
    const currentEma = calculateWindowEma(closes, index, emaPeriod);
    const previousEma = calculateWindowEma(closes, index - 1, emaPeriod);
    const emaSlopePercent = currentEma && previousEma
      ? ((currentEma - previousEma) / previousEma) * 100
      : null;
    const emaTrendConfirmed = currentEma !== null && previousEma !== null &&
      currentClose >= currentEma && emaSlopePercent >= 0;

    return {
      currentClose,
      previousClose,
      currentOpen,
      currentHigh,
      currentLow,
      priceChangePercent,
      signalRangePercent,
      closeStrength,
      currentVolume,
      averageVolume,
      volumeRatio,
      previousHigh: index > 0 ? highs[index - 1] : null,
      bullishCandle: index > 0 && currentClose > currentOpen && currentClose > closes[index - 1],
      trendSlopePercent,
      trendConfirmed,
      currentBand,
      previousBand,
      bollingerReclaim,
      currentEma,
      previousEma,
      emaSlopePercent,
      emaTrendConfirmed,
      rsi: rsiSeries[index],
      previousRsi: index > 0 ? rsiSeries[index - 1] : null
    };
  });

  return { rsiSeries, points };
}

function featureCacheKey(config) {
  return [
    number(config.rsiPeriod, 14),
    number(config.volumeLookback, 20),
    number(config.bbPeriod, 20),
    number(config.bbStdDev, 2),
    number(config.emaPeriod, 20),
    number(config.trendPeriod, 30),
    number(config.trendSlopeLookback, 3)
  ].join('|');
}

/**
 * Reusable feature cache for tuning many candidates on one candle window.
 * The cache is intentionally scoped to the caller's immutable candle window.
 */
export function createScalpingFeatureCache(rawCandles) {
  const candles = normalizeHistoricalCandles(rawCandles);
  const featureSets = new Map();
  return {
    candles,
    get(config = {}) {
      const key = featureCacheKey(config);
      if (!featureSets.has(key)) {
        featureSets.set(key, buildReboundFeatureSet(candles, config));
      }
      return featureSets.get(key);
    },
    size() {
      return featureSets.size;
    }
  };
}

/**
 * Evaluate one completed candle under the shared rebound contract. Feature
 * rows may come from the tuning-grid cache (buildReboundFeatureSet) or the
 * canonical per-index producer; the decision itself always runs through
 * decideReboundSignal so live and backtest cannot drift apart.
 */
export function calculateReboundAtIndex(candles, index, rsiSeries, config, featureSet = null) {
  const point = featureSet?.points?.[index] ??
    computeReboundPoint(candles, index, rsiSeries, config);
  return decideReboundSignal({ candles, index, point, rsiSeries, config });
}

/**
 * Collect historical oversold/rebound candidate snapshots without simulating
 * orders. This is a research-only input lane for replaying an AI advisory
 * model against a fixed candle window; it must not replace the live strategy
 * or authorize orders.
 */
export function collectScalpingCandidates(rawCandles, config = {}, options = {}) {
  const resolvedConfig = { ...DEFAULT_CONFIG, ...config };
  const candles = normalizeHistoricalCandles(rawCandles);
  const dataQuality = analyzeHistoricalCandleContinuity(candles, resolvedConfig.candleUnit, {
    maxGapSeconds: options.maxHistoricalCandleGapSeconds ?? resolvedConfig.maxHistoricalCandleGapSeconds
  });
  if (requiresHistoricalCandleContinuity(resolvedConfig, options) && !dataQuality.valid) {
    return {
      candles,
      candidates: [],
      horizonCandles: Math.max(1, Math.floor(number(options.horizonCandles, 5))),
      minimumSpacingCandles: Math.max(1, Math.floor(number(options.minimumSpacingCandles, 5))),
      source: 'fixed_historical_candle_replay',
      dataQuality
    };
  }
  const featureCache = createScalpingFeatureCache(candles);
  const featureSet = featureCache.get(resolvedConfig);
  const rsiSeries = featureSet.rsiSeries;
  const minimumHistory = resolvedConfig.rsiPeriod + Math.max(2, Math.floor(number(resolvedConfig.oversoldLookback, 1)));
  const horizonCandles = Math.max(1, Math.floor(number(options.horizonCandles, 5)));
  const minimumSpacingCandles = Math.max(1, Math.floor(number(options.minimumSpacingCandles, 5)));
  const candidates = [];
  let lastCandidateIndex = -Infinity;

  for (let index = minimumHistory; index + horizonCandles < candles.length; index += 1) {
    if (index - lastCandidateIndex < minimumSpacingCandles) continue;
    const rebound = calculateReboundAtIndex(candles, index, rsiSeries, resolvedConfig, featureSet);
    if (!rebound?.available || (!rebound.previousWasOversold && !rebound.currentWasOversold)) continue;

    const currentPrice = getClose(candles[index]);
    const futurePrice = getClose(candles[index + horizonCandles]);
    if (!Number.isFinite(currentPrice) || currentPrice <= 0 || !Number.isFinite(futurePrice) || futurePrice <= 0) continue;

    const timestamp = rebound.candleTime || candles[index]?.candle_date_time_utc || candles[index]?.timestamp || null;
    candidates.push({
      index,
      timestamp,
      candle: candles[index],
      futureCandle: candles[index + horizonCandles],
      currentPrice,
      futurePrice,
      priceChangePercent: ((futurePrice - currentPrice) / currentPrice) * 100,
      rebound
    });
    lastCandidateIndex = index;
  }

  return {
    candles,
    candidates,
    horizonCandles,
    minimumSpacingCandles,
    source: 'fixed_historical_candle_replay',
    dataQuality
  };
}

function calculateDrawdown(equityCurve) {
  let peak = 0;
  let maxDrawdown = 0;

  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    if (peak > 0) {
      maxDrawdown = Math.max(maxDrawdown, ((peak - point.equity) / peak) * 100);
    }
  }

  return maxDrawdown;
}

export function createMetrics({
  initialBalance,
  finalBalance,
  trades,
  equityCurve,
  signals,
  cancelledSignals,
  fees,
  rejectionCounts,
  circuitBlockedEntries = 0,
  circuitBreaks = 0,
  marketRegimeBlockedEntries = 0,
  signalWindowBlockedEntries = 0,
  volatilityScaledEntries = 0,
  volatilityBlockedEntries = 0,
  dataQuality = null
}) {
  const closedTrades = trades.filter(trade => trade.type === 'CLOSE');
  const winners = closedTrades.filter(trade => trade.netProfit > 0);
  const losers = closedTrades.filter(trade => trade.netProfit <= 0);
  const grossProfit = winners.reduce((sum, trade) => sum + trade.netProfit, 0);
  const grossLoss = Math.abs(losers.reduce((sum, trade) => sum + trade.netProfit, 0));
  const netProfit = finalBalance - initialBalance;
  const totalReturnPercent = initialBalance > 0 ? (netProfit / initialBalance) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const tradeReturnConfidence = calculateTradeReturnConfidence(closedTrades);
  const referenceBreakExits = closedTrades.filter(
    trade => trade.reason === 'REFERENCE_BREAK_EXIT'
  ).length;

  return {
    initialBalance,
    finalBalance,
    netProfit,
    totalReturnPercent,
    tradeCount: closedTrades.length,
    winningTrades: winners.length,
    losingTrades: losers.length,
    winRate: closedTrades.length > 0 ? (winners.length / closedTrades.length) * 100 : 0,
    profitFactor,
    maxDrawdownPercent: calculateDrawdown(equityCurve),
    averageTrade: closedTrades.length > 0 ? netProfit / closedTrades.length : 0,
    tradeReturnConfidence,
    signals,
    cancelledSignals,
    fees,
    rejectionCounts: rejectionCounts || {},
    circuitBlockedEntries,
    circuitBreaks,
    marketRegimeBlockedEntries,
    signalWindowBlockedEntries,
    volatilityScaledEntries,
    volatilityBlockedEntries,
    referenceBreakExits,
    dataQuality,
    qualityScore: calculateQualityScore({
      totalReturnPercent,
      maxDrawdownPercent: calculateDrawdown(equityCurve),
      profitFactor,
      tradeCount: closedTrades.length
    })
  };
}

export function requiresHistoricalCandleContinuity(config, simulationOptions = {}) {
  return simulationOptions.requireHistoricalCandleContinuity !== false &&
    config.requireHistoricalCandleContinuity !== false;
}

function createHistoricalContinuityFailure(candles, options, dataQuality) {
  const initialBalance = number(options.initialBalance, 1_000_000);
  const metrics = createMetrics({
    initialBalance,
    finalBalance: initialBalance,
    trades: [],
    equityCurve: [],
    signals: 0,
    cancelledSignals: 0,
    fees: 0,
    rejectionCounts: {},
    dataQuality
  });
  return {
    config: options,
    candleCount: candles.length,
    trades: [],
    equityCurve: [],
    metrics,
    dataQuality
  };
}

export function createPortfolioContinuityFailure(entries, options, dataQualityByMarket) {
  const initialBalance = number(options.initialBalance, 1_000_000);
  const dataQuality = {
    valid: false,
    reason: 'historical_candle_continuity_failed',
    marketCount: entries.length,
    invalidMarkets: entries
      .filter(([market]) => dataQualityByMarket[market]?.valid !== true)
      .map(([market]) => market),
    byMarket: dataQualityByMarket
  };
  const metrics = createMetrics({
    initialBalance,
    finalBalance: initialBalance,
    trades: [],
    equityCurve: [],
    signals: 0,
    cancelledSignals: 0,
    fees: 0,
    rejectionCounts: {},
    dataQuality
  });
  return {
    portfolio: true,
    config: options,
    marketCount: entries.length,
    candleCounts: Object.fromEntries(entries.map(([market, candles]) => [market, candles.length])),
    trades: [],
    equityCurve: [],
    lossCircuitBreaker: createLossCircuitBreakerState(),
    marketRegime: null,
    metrics,
    skippedEntries: 0,
    signalWindowBlockedEntries: 0,
    dataQuality
  };
}

/**
 * A conservative ranking function for tuning. Return alone is insufficient:
 * drawdown, trade count, and fee-adjusted profit factor all affect promotion.
 */
export function calculateQualityScore({ totalReturnPercent, maxDrawdownPercent, profitFactor, tradeCount }) {
  const totalReturn = number(totalReturnPercent);
  const drawdown = Math.max(0, number(maxDrawdownPercent));
  const closedTrades = Math.max(0, number(tradeCount));
  const boundedProfitFactor = Number.isFinite(profitFactor) ? Math.min(profitFactor, 5) : 5;
  const tradeConfidence = Math.min(closedTrades, 30) / 30;
  const profitableCandidate = closedTrades > 0 && totalReturn > 0 && boundedProfitFactor >= 1;
  const tradeConfidenceScore = profitableCandidate
    ? tradeConfidence * 0.5
    : -tradeConfidence * 0.5;
  return (totalReturn * 0.6) - (drawdown * 0.8) +
    (Math.max(0, boundedProfitFactor - 1) * 2) + tradeConfidenceScore;
}

export function entryDecision(rebound, nextCandle, config) {
  if (!rebound?.reboundConfirmed || !nextCandle) {
    return { valid: false, reason: 'rebound_not_confirmed' };
  }

  const referencePrice = number(rebound.referencePrice);
  const nextOpen = getOpen(nextCandle);
  if (referencePrice <= 0 || nextOpen <= 0) {
    return { valid: false, reason: 'invalid_entry_price' };
  }

  const retracePercent = ((referencePrice - nextOpen) / referencePrice) * 100;
  const chasePercent = ((nextOpen - referencePrice) / referencePrice) * 100;
  if (retracePercent > config.maxEntryRetracePercent) {
    return { valid: false, reason: 'entry_retrace_limit', retracePercent, chasePercent };
  }
  if (chasePercent > config.maxEntryChasePercent) {
    return { valid: false, reason: 'entry_chase_limit', retracePercent, chasePercent };
  }

  const nextClose = getClose(nextCandle);
  if (config.requireNextCandleBullish === true &&
    !(nextClose > nextOpen && nextClose >= referencePrice)) {
    return {
      valid: false,
      reason: 'next_candle_follow_through',
      retracePercent,
      chasePercent
    };
  }

  return {
    valid: true,
    referencePrice,
    nextOpen,
    retracePercent,
    chasePercent,
    // Minute OHLC cannot observe the exact 1~5 second tick path. The normal
    // contract uses the next candle open as a delayed-entry proxy; the
    // follow-through candidate explicitly enters at the verified close.
    entryPrice: (config.requireNextCandleBullish === true ? nextClose : nextOpen) * (1 + config.slippage),
    followThroughConfirmed: config.requireNextCandleBullish !== true ||
      (nextClose > nextOpen && nextClose >= referencePrice)
  };
}

export function closePosition(position, candle, exitReason, exitPrice, config, timestamp) {
  updatePositionExcursion(position, candle);
  const grossAmount = position.amount * exitPrice;
  const sellFee = grossAmount * config.tradingFee;
  const netReceived = grossAmount - sellFee;
  const netProfit = netReceived - position.investAmount;

  return {
    type: 'CLOSE',
    reason: exitReason,
    entryPrice: position.entryPrice,
    exitPrice,
    amount: position.amount,
    investAmount: position.investAmount,
    grossAmount,
    sellFee,
    netProfit,
    profitPercent: position.investAmount > 0 ? (netProfit / position.investAmount) * 100 : 0,
    entryTime: position.entryTime,
    exitTime: timestamp,
    maxFavorableExcursionPercent: position.maxFavorableExcursionPercent,
    maxAdverseExcursionPercent: position.maxAdverseExcursionPercent,
    winnerExtended: position.winnerExtended === true,
    candleTime: candle?.candle_date_time_utc || candle?.candle_date_time_kst || null
  };
}

function updatePositionExcursion(position, candle) {
  if (!position || typeof position !== 'object') return;
  const entryPrice = Number(position.entryPrice);
  const candleHigh = getHigh(candle);
  const candleLow = getLow(candle);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return;

  const previousHigh = Number(position.highestPrice);
  const previousLow = Number(position.lowestPrice);
  if (Number.isFinite(candleHigh) && candleHigh > 0) {
    position.highestPrice = Math.max(
      Number.isFinite(previousHigh) && previousHigh > 0 ? previousHigh : entryPrice,
      candleHigh
    );
  } else {
    position.highestPrice = Number.isFinite(previousHigh) && previousHigh > 0
      ? previousHigh
      : entryPrice;
  }
  if (Number.isFinite(candleLow) && candleLow > 0) {
    position.lowestPrice = Math.min(
      Number.isFinite(previousLow) && previousLow > 0 ? previousLow : entryPrice,
      candleLow
    );
  } else {
    position.lowestPrice = Number.isFinite(previousLow) && previousLow > 0
      ? previousLow
      : entryPrice;
  }
  position.maxFavorableExcursionPercent = ((position.highestPrice - entryPrice) / entryPrice) * 100;
  position.maxAdverseExcursionPercent = ((position.lowestPrice - entryPrice) / entryPrice) * 100;
}

function getProtectiveStop(position, config) {
  const fixedStopPrice = position.entryPrice * (1 - config.stopLossPercent / 100);
  let protectiveStopPrice = fixedStopPrice;
  let protectiveType = 'STOP_LOSS';

  if (position.breakEvenArmed || position.trailingArmed) {
    const breakEvenStopPrice = calculateCostAdjustedBreakEvenPrice(position.entryPrice, {
      tradingFee: config.tradingFee,
      slippage: config.slippage,
      offsetPercent: config.breakEvenOffsetPercent
    });
    if (breakEvenStopPrice > protectiveStopPrice) {
      protectiveStopPrice = breakEvenStopPrice;
      protectiveType = 'BREAK_EVEN_STOP';
    }
  }

  if (position.trailingArmed) {
    const trailingStopPrice = position.highestPrice * (1 - config.trailingStopPercent / 100);
    if (trailingStopPrice > protectiveStopPrice) {
      protectiveStopPrice = trailingStopPrice;
      protectiveType = 'TRAILING_STOP';
    }
  }

  return { price: protectiveStopPrice, type: protectiveType };
}

export function updateProtectionState(position, candle, config) {
  updatePositionExcursion(position, candle);
  const highGainPercent = ((position.highestPrice - position.entryPrice) / position.entryPrice) * 100;

  if (config.breakEvenTriggerPercent > 0 && highGainPercent >= config.breakEvenTriggerPercent) {
    position.breakEvenArmed = true;
  }
  if (config.trailingActivationPercent > 0 && config.trailingStopPercent > 0 &&
    highGainPercent >= config.trailingActivationPercent) {
    position.trailingArmed = true;
  }
}

export function findExit(position, candle, config, timestamp) {
  const takePrice = position.entryPrice * (1 + config.takeProfitPercent / 100);
  const low = getLow(candle);
  const high = getHigh(candle);
  const protectiveStop = getProtectiveStop(position, config);

  // If both levels are touched inside one candle, choose the stop first. This
  // avoids giving the backtest an optimistic intrabar ordering it cannot know.
  if (low <= protectiveStop.price) {
    // A stop-market order cannot fill at its trigger after the bar has already
    // opened below that level. Use the worse opening price for a gap-through,
    // then apply adverse slippage to either stop fill.
    const stopFillPrice = Math.min(getOpen(candle), protectiveStop.price);
    return { reason: protectiveStop.type, price: stopFillPrice * (1 - config.slippage) };
  }
  if (high >= takePrice) {
    return { reason: 'TAKE_PROFIT', price: takePrice * (1 - config.slippage) };
  }

  const holdMs = timestamp - position.entryTimestamp;
  const referenceBreakExitPercent = Math.max(
    0,
    number(config.referenceBreakExitPercent, 0)
  );
  const referenceBreakMinHoldMinutes = Math.max(
    0,
    number(config.referenceBreakMinHoldMinutes, 0)
  );
  const signalReferencePrice = number(position.signalReferencePrice, 0);
  if (referenceBreakExitPercent > 0 && signalReferencePrice > 0 &&
    holdMs >= referenceBreakMinHoldMinutes * 60 * 1000 &&
    getClose(candle) <= signalReferencePrice * (1 - referenceBreakExitPercent / 100)) {
    return {
      reason: 'REFERENCE_BREAK_EXIT',
      price: getClose(candle) * (1 - config.slippage)
    };
  }
  if (config.maxLosingHoldMinutes > 0 && holdMs >= config.maxLosingHoldMinutes * 60 * 1000 &&
    getClose(candle) <= position.entryPrice) {
    return { reason: 'MAX_LOSING_HOLD_TIME', price: getClose(candle) * (1 - config.slippage) };
  }
  if (config.maxHoldMinutes > 0 && holdMs >= config.maxHoldMinutes * 60 * 1000) {
    const extensionMs = Math.max(0, Number(config.winnerExtendMinutes) || 0) * 60 * 1000;
    if (extensionMs > 0 && holdMs < config.maxHoldMinutes * 60 * 1000 + extensionMs) {
      if (position.winnerExtended === true) return null;
      const gainPercent = ((getClose(candle) - position.entryPrice) / position.entryPrice) * 100;
      if (gainPercent >= (Number(config.winnerExtendMinProfitPercent) || 0)) {
        position.winnerExtended = true;
        position.breakEvenArmed = true;
        return null;
      }
    }
    return { reason: 'MAX_HOLD_TIME', price: getOpen(candle) * (1 - config.slippage) };
  }

  return null;
}

/**
 * Simulate the same oversold-rebound entry contract used by the live trader.
 * This is intentionally single-position per market and includes both-side
 * fees, adverse slippage, delayed-entry proxy, and conservative OHLC exits.
 */
export function simulateScalping(rawCandles, config = {}, simulationOptions = {}) {
  const options = { ...DEFAULT_CONFIG, ...config };
  const candles = normalizeHistoricalCandles(rawCandles);
  const dataQuality = analyzeHistoricalCandleContinuity(candles, options.candleUnit, {
    maxGapSeconds: simulationOptions.maxHistoricalCandleGapSeconds ?? options.maxHistoricalCandleGapSeconds
  });
  if (requiresHistoricalCandleContinuity(options, simulationOptions) && !dataQuality.valid) {
    return createHistoricalContinuityFailure(candles, options, dataQuality);
  }
  const featureCache = simulationOptions.useFeatureCache === false
    ? null
    : simulationOptions.featureCache?.get
      ? simulationOptions.featureCache
      : createScalpingFeatureCache(candles);
  const featureSet = featureCache?.get(options) || null;
  const trades = [];
  const equityCurve = [];
  let balance = options.initialBalance;
  let position = null;
  let signals = 0;
  let cancelledSignals = 0;
  let fees = 0;
  const rejectionCounts = {};
  let circuitBlockedEntries = 0;
  let circuitBreaks = 0;
  let volatilityScaledEntries = 0;
  let volatilityBlockedEntries = 0;
  let cooldownUntil = 0;
  let consecutiveLosses = 0;
  const lossCircuitBreaker = createLossCircuitBreakerState();
  const rsiSeries = featureSet?.rsiSeries || calculateRsiSeries(candles, options.rsiPeriod);

  const minimumHistory = options.rsiPeriod + Math.max(2, Math.floor(number(options.oversoldLookback, 1)));
  const requestedStartIndex = Number(simulationOptions.startTradingIndex);
  const startTradingIndex = Number.isFinite(requestedStartIndex)
    ? Math.max(minimumHistory, Math.floor(requestedStartIndex))
    : minimumHistory;
  for (let index = startTradingIndex; index < candles.length; index += 1) {
    const candle = candles[index];
    const timestamp = candleTime(candle, index * options.candleUnit * 60 * 1000);
    let closedThisCandle = false;

    if (position) {
      const exit = findExit(position, candle, options, timestamp);
      if (exit) {
        const closeTrade = closePosition(position, candle, exit.reason, exit.price, options, timestamp);
        balance += closeTrade.grossAmount - closeTrade.sellFee;
        fees += closeTrade.sellFee;
        trades.push(closeTrade);
        position = null;
        closedThisCandle = true;
        if (closeTrade.netProfit < 0) {
          consecutiveLosses += 1;
          cooldownUntil = timestamp + options.cooldownAfterLossMinutes * 60 * 1000;
          if (consecutiveLosses >= options.maxConsecutiveLosses) {
            cooldownUntil = timestamp + Math.max(options.cooldownAfterLossMinutes, 60) * 60 * 1000;
          }
          const circuitResult = registerLoss(lossCircuitBreaker, timestamp, {
            maxLosses: options.lossCircuitBreakerCount,
            windowMinutes: options.lossCircuitBreakerWindowMinutes,
            cooldownMinutes: options.lossCircuitBreakerCooldownMinutes
          });
          if (circuitResult.triggered) circuitBreaks += 1;
        } else {
          consecutiveLosses = 0;
          cooldownUntil = 0;
        }
      } else {
        // The candle high can arm protection, but the newly armed stop is only
        // eligible from the next candle. This avoids assuming an intrabar
        // high happened before an intrabar low when OHLC order is unknown.
        updateProtectionState(position, candle, options);
      }
    }

    const circuitCoolingDown = isLossCircuitCoolingDown(lossCircuitBreaker, timestamp, {
        maxLosses: options.lossCircuitBreakerCount,
        windowMinutes: options.lossCircuitBreakerWindowMinutes
      });
    if (!position && !closedThisCandle && timestamp >= cooldownUntil && index + 1 < candles.length) {
      if (circuitCoolingDown) {
        circuitBlockedEntries += 1;
      } else {
        if (consecutiveLosses >= options.maxConsecutiveLosses) {
          consecutiveLosses = 0;
          cooldownUntil = 0;
        }
        const rebound = calculateReboundAtIndex(candles, index, rsiSeries, options, featureSet);

        for (const rejectionReason of rebound?.rejectionReasons || []) {
          rejectionCounts[rejectionReason] = (rejectionCounts[rejectionReason] || 0) + 1;
        }

        if (rebound?.reboundConfirmed) {
          signals += 1;
          const nextCandle = candles[index + 1];
          const entry = entryDecision(rebound, nextCandle, options);

          if (!entry.valid) {
            cancelledSignals += 1;
          } else {
            // Use only candles before the completed signal candle. If the
            // research overlay is enabled but its history is unavailable,
            // block the entry instead of silently restoring full exposure.
            const volatilitySizing = resolveScalpingVolatilitySizing({
              candles,
              index,
              lookbackCandles: options.volatilityLookbackCandles,
              targetPercent: options.volatilityTargetPercent
            });
            if (!volatilitySizing.available) {
              volatilityBlockedEntries += 1;
            } else {
              if (volatilitySizing.scale < 1) volatilityScaledEntries += 1;
              const investAmount = Math.min(
                balance * options.investmentRatio * volatilitySizing.scale,
                balance * 0.95
              );

              if (investAmount >= options.minOrderAmount && entry.entryPrice > 0) {
                const buyFee = investAmount * options.tradingFee;
                const amount = (investAmount - buyFee) / entry.entryPrice;
                balance -= investAmount;
                fees += buyFee;
                position = {
                  entryPrice: entry.entryPrice,
                  amount,
                  investAmount,
                  entryTimestamp: candleTime(nextCandle, timestamp),
                  entryTime: nextCandle?.candle_date_time_utc || nextCandle?.candle_date_time_kst || null,
                  signalKey: rebound.signalKey,
                  signalReferencePrice: rebound.referencePrice,
                  highestPrice: entry.entryPrice,
                  lowestPrice: entry.entryPrice,
                  maxFavorableExcursionPercent: 0,
                  maxAdverseExcursionPercent: 0,
                  breakEvenArmed: false,
                  trailingArmed: false,
                  winnerExtended: false,
                  volatilityPercent: volatilitySizing.volatilityPercent,
                  volatilityScale: volatilitySizing.scale
                };
                trades.push({
                  type: 'OPEN',
                  reason: 'OVERSOLD_REBOUND_DELAYED_ENTRY',
                  entryPrice: entry.entryPrice,
                  amount,
                  investAmount,
                  buyFee,
                  signalKey: rebound.signalKey,
                  signalReferencePrice: rebound.referencePrice,
                  signalTime: candle?.candle_date_time_utc || candle?.candle_date_time_kst || null,
                  entryTime: position.entryTime,
                  retracePercent: entry.retracePercent,
                  chasePercent: entry.chasePercent,
                  volatilityPercent: volatilitySizing.volatilityPercent,
                  volatilityScale: volatilitySizing.scale
                });
              }
            }
          }
        }
      }
    }

    const markPrice = getClose(candle);
    equityCurve.push({
      timestamp,
      price: markPrice,
      equity: balance + (position ? position.amount * markPrice : 0)
    });
  }

  if (position && candles.length > 0) {
    const lastCandle = candles[candles.length - 1];
    const timestamp = candleTime(lastCandle, Date.now());
    const exitPrice = getClose(lastCandle) * (1 - options.slippage);
    const closeTrade = closePosition(position, lastCandle, 'BACKTEST_END', exitPrice, options, timestamp);
    balance += closeTrade.grossAmount - closeTrade.sellFee;
    fees += closeTrade.sellFee;
    trades.push(closeTrade);
  }

  return {
    config: options,
    candleCount: candles.length,
    trades,
    equityCurve,
    metrics: createMetrics({
      initialBalance: options.initialBalance,
      finalBalance: balance,
      trades,
      equityCurve,
      signals,
      cancelledSignals,
      fees,
      rejectionCounts,
      circuitBlockedEntries,
      circuitBreaks,
      volatilityScaledEntries,
      volatilityBlockedEntries,
      dataQuality
    }),
    dataQuality
  };
}

/**
 * Replay each contiguous historical segment independently for research.
 *
 * A position that reaches a segment boundary is an unknown outcome because
 * the missing candle path cannot prove whether its stop, target, or risk
 * monitor would have fired. Such positions are excluded from realized
 * metrics and returned separately. This function is intentionally diagnostic
 * only and must never replace the contiguous-window promotion gate.
 */
export function simulateScalpingSegmented(rawCandles, config = {}, simulationOptions = {}) {
  const options = { ...DEFAULT_CONFIG, ...config };
  const segmentation = splitHistoricalCandleSegments(
    rawCandles,
    options.candleUnit,
    {
      maxGapSeconds: simulationOptions.maxHistoricalCandleGapSeconds ?? options.maxHistoricalCandleGapSeconds,
      minimumSegmentCandles: simulationOptions.minimumSegmentCandles
    }
  );
  const initialBalance = number(options.initialBalance, 1_000_000);
  let balance = initialBalance;
  let fees = 0;
  let signals = 0;
  let cancelledSignals = 0;
  const trades = [];
  const equityCurve = [];
  const segmentReports = [];
  const unknownBoundaryPositions = [];

  for (const segment of segmentation.segments) {
    const segmentResult = simulateScalping(
      segment.candles,
      { ...options, initialBalance: balance },
      {
        ...simulationOptions,
        // A returned segment is expected to be contiguous; preserve the
        // invariant even if a caller supplied a permissive option upstream.
        requireHistoricalCandleContinuity: true,
        minimumSegmentCandles: undefined
      }
    );
    if (segmentResult.dataQuality?.valid !== true) {
      segmentReports.push({
        segmentIndex: segment.segmentIndex,
        startIndex: segment.startIndex,
        endIndex: segment.endIndex,
        candleCount: segment.candleCount,
        firstTimestamp: segment.firstTimestamp,
        lastTimestamp: segment.lastTimestamp,
        status: 'excluded_invalid_segment',
        dataQuality: segmentResult.dataQuality
      });
      continue;
    }

    const boundaryCloseIndex = segmentResult.trades.findIndex(trade =>
      trade?.type === 'CLOSE' && trade.reason === 'BACKTEST_END'
    );
    const boundaryClose = boundaryCloseIndex >= 0
      ? segmentResult.trades[boundaryCloseIndex]
      : null;
    const boundaryOpen = boundaryClose
      ? [...segmentResult.trades.slice(0, boundaryCloseIndex)]
        .reverse()
        .find(trade => trade?.type === 'OPEN' && (
          !boundaryClose.signalKey || trade.signalKey === boundaryClose.signalKey
        )) || null
      : null;
    const unknownFees = Number(boundaryOpen?.buyFee || 0) + Number(boundaryClose?.sellFee || 0);
    const segmentFees = Math.max(0, Number(segmentResult.metrics.fees || 0) - unknownFees);
    const usableTrades = segmentResult.trades.filter(trade =>
      trade !== boundaryClose && trade !== boundaryOpen
    );
    const usableClosedTrades = usableTrades.filter(trade => trade?.type === 'CLOSE');
    trades.push(...usableTrades.map(trade => ({
      ...trade,
      segmentIndex: segment.segmentIndex
    })));
    fees += segmentFees;
    signals += Number(segmentResult.metrics.signals || 0);
    cancelledSignals += Number(segmentResult.metrics.cancelledSignals || 0);
    balance = boundaryClose
      ? Number(segmentResult.metrics.finalBalance) - Number(boundaryClose.netProfit || 0)
      : Number(segmentResult.metrics.finalBalance);
    if (!Number.isFinite(balance)) balance = initialBalance;
    equityCurve.push(...(
      boundaryClose
        ? segmentResult.equityCurve.slice(0, -1)
        : segmentResult.equityCurve
    ).map(point => ({
      ...point,
      segmentIndex: segment.segmentIndex
    })));

    if (boundaryClose) {
      unknownBoundaryPositions.push({
        segmentIndex: segment.segmentIndex,
        startIndex: segment.startIndex,
        endIndex: segment.endIndex,
        reason: segment.endIndex < segmentation.candleCount
          ? 'open_position_at_gap_boundary'
          : 'open_position_at_segment_end',
        originalReason: boundaryClose.reason,
        openTrade: boundaryOpen,
        closeObservation: boundaryClose
      });
    }
    segmentReports.push({
      segmentIndex: segment.segmentIndex,
      startIndex: segment.startIndex,
      endIndex: segment.endIndex,
      candleCount: segment.candleCount,
      firstTimestamp: segment.firstTimestamp,
      lastTimestamp: segment.lastTimestamp,
      status: boundaryClose ? 'used_with_unknown_boundary_position' : 'used',
      closedTradeCount: usableClosedTrades.length,
      metrics: {
        initialBalance: segmentResult.metrics.initialBalance,
        finalBalance: balance,
        netProfit: usableClosedTrades.reduce((sum, trade) => sum + Number(trade.netProfit || 0), 0),
        tradeCount: usableClosedTrades.length,
        signals: segmentResult.metrics.signals,
        cancelledSignals: segmentResult.metrics.cancelledSignals,
        fees: segmentFees
      },
      dataQuality: segmentResult.dataQuality
    });
  }

  const dataQuality = {
    valid: segmentation.dataQuality.valid === true,
    reason: 'segmented_diagnostic_only',
    diagnosticOnly: true,
    policy: 'split_on_gap_exclude_boundary_positions',
    raw: segmentation.dataQuality,
    candleCount: segmentation.candleCount,
    boundaryCount: segmentation.boundaryCount,
    segmentCount: segmentation.segments.length,
    usedSegmentCount: segmentReports.filter(report => report.status.startsWith('used')).length,
    excludedSegmentCount: segmentation.excludedSegmentCount,
    unknownBoundaryPositionCount: unknownBoundaryPositions.length
  };
  const metrics = createMetrics({
    initialBalance,
    finalBalance: balance,
    trades,
    equityCurve,
    signals,
    cancelledSignals,
    fees,
    rejectionCounts: {},
    dataQuality
  });
  return {
    segmented: true,
    diagnosticOnly: true,
    config: options,
    candleCount: segmentation.candleCount,
    segments: segmentReports,
    excludedSegments: segmentation.excludedSegments,
    boundaries: segmentation.boundaries,
    trades,
    equityCurve,
    unknownBoundaryPositions,
    dataQuality,
    metrics,
    promoted: false,
    promotion: 'diagnostic_only_never_authorizes_live_orders'
  };
}

export { DEFAULT_CONFIG };
