import { calculateCostAdjustedBreakEvenPrice } from '../strategy/protectionPrices.js';
import { createLossCircuitBreakerState, isLossCircuitCoolingDown, registerLoss } from '../risk/lossCircuitBreaker.js';

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
  marketRegimeEnabled: false,
  marketRegimeLookback: 5,
  marketRegimeMinBreadth: 0.5,
  marketRegimeMinReturnPercent: -0.2,
  candleUnit: 1
};

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function candleTime(candle, fallback) {
  const raw = candle?.candle_date_time_utc || candle?.candle_date_time_kst || candle?.timestamp;
  const parsed = raw instanceof Date ? raw.getTime() : new Date(raw || 0).getTime();
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Historical API responses are normally newest-first. The simulator normalizes
 * them to chronological order so that an entry can only consume future OHLC.
 */
export function normalizeHistoricalCandles(candles) {
  if (!Array.isArray(candles)) return [];

  const normalized = candles
    .filter(candle => Number.isFinite(number(candle?.trade_price)));

  if (normalized.length < 2) return normalized;

  const firstTime = candleTime(normalized[0], 0);
  const lastTime = candleTime(normalized[normalized.length - 1], 0);
  if (firstTime && lastTime && firstTime > lastTime) {
    return normalized.slice().reverse();
  }
  return normalized.slice();
}

function getOpen(candle) {
  return number(candle?.opening_price, number(candle?.trade_price));
}

function getClose(candle) {
  return number(candle?.trade_price, getOpen(candle));
}

function getHigh(candle) {
  return number(candle?.high_price, Math.max(getOpen(candle), getClose(candle)));
}

function getLow(candle) {
  return number(candle?.low_price, Math.min(getOpen(candle), getClose(candle)));
}

/**
 * Wilder RSI values for every chronological close. The live helper calculates
 * a full history slice for each signal; a backtest must reuse this series or
 * long walk-forward runs become needlessly quadratic.
 */
function calculateRsiSeries(candles, period) {
  const prices = candles.map(getClose);
  const values = Array(prices.length).fill(null);
  if (prices.length < period + 1) return values;

  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const difference = prices[index] - prices[index - 1];
    if (difference >= 0) gains += difference;
    else losses -= difference;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  values[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));

  for (let index = period + 1; index < prices.length; index += 1) {
    const difference = prices[index] - prices[index - 1];
    const currentGain = difference >= 0 ? difference : 0;
    const currentLoss = difference < 0 ? -difference : 0;
    avgGain = (avgGain * (period - 1) + currentGain) / period;
    avgLoss = (avgLoss * (period - 1) + currentLoss) / period;
    values[index] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
  }

  return values;
}

function calculateReboundAtIndex(candles, index, rsiSeries, config) {
  const currentCandle = candles[index];
  const previousCandle = candles[index - 1];
  const currentClose = getClose(currentCandle);
  const previousClose = getClose(previousCandle);
  const currentOpen = getOpen(currentCandle);
  const rsi = rsiSeries[index];
  const previousRsi = rsiSeries[index - 1];

  if (!Number.isFinite(rsi) || !Number.isFinite(previousRsi) || previousClose <= 0) {
    return null;
  }

  const priceChangePercent = ((currentClose - previousClose) / previousClose) * 100;
  const immediateRsiRecovery = rsi - previousRsi;
  const bullishCandle = currentClose > currentOpen && currentClose > previousClose;
  const currentHigh = getHigh(currentCandle);
  const currentLow = getLow(currentCandle);
  const candleRange = currentHigh - currentLow;
  const configuredMaxSignalRangePercent = Number(config.maxSignalRangePercent);
  const configuredMinSignalRangePercent = Number(config.minSignalRangePercent);
  const signalRangePercent = previousClose > 0 && Number.isFinite(candleRange)
    ? (candleRange / previousClose) * 100
    : null;
  const volatilityConfirmed = !Number.isFinite(configuredMaxSignalRangePercent) ||
    configuredMaxSignalRangePercent <= 0 ||
    signalRangePercent === null ||
    signalRangePercent <= configuredMaxSignalRangePercent;
  const signalRangeFloorConfirmed = !Number.isFinite(configuredMinSignalRangePercent) ||
    configuredMinSignalRangePercent <= 0 ||
    signalRangePercent === null ||
    signalRangePercent >= configuredMinSignalRangePercent;
  const closeStrength = candleRange > 0 ? (currentClose - currentLow) / candleRange : 1;
  const currentVolume = number(currentCandle?.candle_acc_trade_volume, NaN);
  const volumeHistory = candles
    .slice(Math.max(0, index - config.volumeLookback), index)
    .map(candle => number(candle?.candle_acc_trade_volume, NaN))
    .filter(Number.isFinite);
  const averageVolume = volumeHistory.length > 0
    ? volumeHistory.reduce((sum, volume) => sum + volume, 0) / volumeHistory.length
    : 0;
  const volumeRatio = Number.isFinite(currentVolume) && averageVolume > 0
    ? currentVolume / averageVolume
    : null;
  const volumeConfirmed = volumeRatio === null || volumeRatio >= config.minVolumeRatio;
  const closeStrengthConfirmed = closeStrength >= config.minCloseStrength;
  const previousHigh = getHigh(previousCandle);
  const previousHighBreak = currentClose > previousHigh;
  const previousHighBreakConfirmed = !config.requirePreviousHighBreak || previousHighBreak;
  const calculateBand = selectedCandles => {
    const prices = selectedCandles.map(getClose);
    if (prices.length < config.bbPeriod) return null;
    const middle = prices.reduce((sum, price) => sum + price, 0) / prices.length;
    const variance = prices.reduce((sum, price) => sum + Math.pow(price - middle, 2), 0) / prices.length;
    const deviation = Math.sqrt(variance);
    return { lower: middle - deviation * config.bbStdDev, upper: middle + deviation * config.bbStdDev };
  };
  const currentBand = calculateBand(candles.slice(Math.max(0, index - config.bbPeriod + 1), index + 1).reverse());
  const previousBand = calculateBand(candles.slice(Math.max(0, index - config.bbPeriod), index).reverse());
  const bollingerReclaim = Boolean(
    currentBand && previousBand &&
    previousClose < previousBand.lower &&
    currentClose >= currentBand.lower &&
    currentClose > previousClose
  );
  const calculateEma = selectedCandles => {
    const prices = selectedCandles.map(getClose);
    if (prices.length < config.emaPeriod) return null;
    const multiplier = 2 / (config.emaPeriod + 1);
    let value = prices[0];
    for (let cursor = 1; cursor < prices.length; cursor += 1) {
      value = (prices[cursor] - value) * multiplier + value;
    }
    return value;
  };
  const currentEma = calculateEma(candles.slice(Math.max(0, index - config.emaPeriod + 1), index + 1));
  const previousEma = calculateEma(candles.slice(Math.max(0, index - config.emaPeriod), index));
  const emaSlopePercent = currentEma && previousEma
    ? ((currentEma - previousEma) / previousEma) * 100
    : null;
  const emaTrendConfirmed = currentEma !== null && previousEma !== null &&
    currentClose >= currentEma && emaSlopePercent >= 0;
  const momentumRsiConfirmed = rsi < config.rsiOverbought;
  const profileConfirmed = config.signalProfile === 'bb_reclaim'
    ? bollingerReclaim
    : config.signalProfile === 'trend_rebound'
      ? emaTrendConfirmed
      : config.signalProfile === 'momentum_breakout'
        ? emaTrendConfirmed && previousHighBreak && momentumRsiConfirmed
        : true;
  let trendSlopePercent = null;
  let trendConfirmed = true;
  if (index >= config.trendPeriod + config.trendSlopeLookback) {
    const currentTrendPrices = candles
      .slice(index - config.trendPeriod + 1, index + 1)
      .map(getClose);
    const previousTrendPrices = candles
      .slice(index - config.trendSlopeLookback - config.trendPeriod + 1, index - config.trendSlopeLookback + 1)
      .map(getClose);
    const currentTrendAverage = currentTrendPrices.reduce((sum, price) => sum + price, 0) / currentTrendPrices.length;
    const previousTrendAverage = previousTrendPrices.reduce((sum, price) => sum + price, 0) / previousTrendPrices.length;
    if (previousTrendAverage > 0) {
      trendSlopePercent = ((currentTrendAverage - previousTrendAverage) / previousTrendAverage) * 100;
      trendConfirmed = trendSlopePercent >= config.minTrendSlopePercent;
    }
  }
  const lookback = Math.max(1, Math.floor(number(config.oversoldLookback, 1)));
  const oversoldCandidates = [];
  for (let offset = 1; offset <= lookback; offset += 1) {
    const candidateRsi = rsiSeries[index - offset];
    const candidateCandle = candles[index - offset];
    if (Number.isFinite(candidateRsi) && candidateRsi <= config.rsiOversold && candidateCandle) {
      oversoldCandidates.push({
        age: offset,
        rsi: candidateRsi,
        close: getClose(candidateCandle)
      });
    }
  }
  oversoldCandidates.sort((a, b) => a.rsi - b.rsi || a.age - b.age);
  const oversoldReference = oversoldCandidates[0] || null;
  const previousWasOversold = oversoldCandidates.length > 0;
  const currentWasOversold = rsi <= config.rsiOversold;
  const oversoldReferenceClose = number(oversoldReference?.close, previousClose);
  const reboundPriceChangePercent = oversoldReferenceClose > 0
    ? ((currentClose - oversoldReferenceClose) / oversoldReferenceClose) * 100
    : priceChangePercent;
  const rsiRecovery = oversoldReference ? rsi - oversoldReference.rsi : immediateRsiRecovery;
  const reboundOverboughtConfirmed = config.requireReboundBelowOverbought !== true || rsi < config.rsiOverbought;
  const candleTime = currentCandle?.candle_date_time_utc || currentCandle?.candle_date_time_kst || currentCandle?.timestamp || null;
  const oversoldReboundConfirmed = previousWasOversold && bullishCandle &&
    reboundPriceChangePercent >= config.minReboundPercent &&
    rsiRecovery >= config.minRsiRecovery &&
    volumeConfirmed && volatilityConfirmed && signalRangeFloorConfirmed && closeStrengthConfirmed && trendConfirmed && previousHighBreakConfirmed &&
    reboundOverboughtConfirmed && profileConfirmed;
  const momentumBreakoutConfirmed = config.signalProfile === 'momentum_breakout' &&
    bullishCandle &&
    priceChangePercent >= config.minReboundPercent &&
    momentumRsiConfirmed &&
    volumeConfirmed && volatilityConfirmed && signalRangeFloorConfirmed && closeStrengthConfirmed && trendConfirmed &&
    previousHighBreak && profileConfirmed;
  const reboundConfirmed = config.signalProfile === 'momentum_breakout'
    ? momentumBreakoutConfirmed
    : oversoldReboundConfirmed;

  const rejectionReasons = [];
  if (config.signalProfile !== 'momentum_breakout' && !previousWasOversold) rejectionReasons.push('previous_rsi_not_oversold');
  if (!bullishCandle) rejectionReasons.push('bullish_rebound_not_confirmed');
  if (config.signalProfile === 'momentum_breakout') {
    if (priceChangePercent < config.minReboundPercent) rejectionReasons.push('breakout_move_below_threshold');
    if (!momentumRsiConfirmed) rejectionReasons.push('rsi_overbought_blocked');
  } else {
    if (reboundPriceChangePercent < config.minReboundPercent) rejectionReasons.push('price_rebound_below_threshold');
    if (rsiRecovery < config.minRsiRecovery) rejectionReasons.push('rsi_recovery_below_threshold');
    if (!reboundOverboughtConfirmed) rejectionReasons.push('rsi_overbought_blocked');
  }
  if (!volumeConfirmed) rejectionReasons.push('volume_confirmation_failed');
  if (!volatilityConfirmed) rejectionReasons.push('signal_range_too_wide');
  if (!signalRangeFloorConfirmed) rejectionReasons.push('signal_range_too_narrow');
  if (!closeStrengthConfirmed) rejectionReasons.push('close_strength_failed');
  if (!trendConfirmed) rejectionReasons.push('trend_filter_failed');
  if (!previousHighBreakConfirmed) rejectionReasons.push('previous_high_break_failed');
  if (!profileConfirmed) rejectionReasons.push(`${config.signalProfile}_profile_failed`);

  return {
    available: true,
    oversold: previousWasOversold || currentWasOversold,
    previousWasOversold,
    currentWasOversold,
    reboundConfirmed,
    bullishCandle,
    priceChangePercent,
    reboundPriceChangePercent,
    rsi,
    previousRsi,
    rsiRecovery,
    immediateRsiRecovery,
    oversoldCandleAge: oversoldReference?.age ?? null,
    oversoldRsi: oversoldReference?.rsi ?? null,
    oversoldReferenceClose,
    currentClose,
    previousClose,
    volumeRatio,
    volumeConfirmed,
    signalRangePercent,
    volatilityConfirmed,
    signalRangeFloorConfirmed,
    closeStrength,
    closeStrengthConfirmed,
    trendSlopePercent,
    trendConfirmed,
    previousHighBreak,
    previousHighBreakConfirmed,
    signalProfile: config.signalProfile,
    profileConfirmed,
    momentumRsiConfirmed,
    reboundOverboughtConfirmed,
    momentumBreakoutConfirmed,
    bollingerReclaim,
    emaTrendConfirmed,
    emaSlopePercent,
    rejectionReasons,
    referencePrice: currentClose,
    signalKey: candleTime ? String(candleTime) : `${currentClose}:${previousClose}`,
    candleTime
  };
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
    source: 'fixed_historical_candle_replay'
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

function createMetrics({
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
  signalWindowBlockedEntries = 0
}) {
  const closedTrades = trades.filter(trade => trade.type === 'CLOSE');
  const winners = closedTrades.filter(trade => trade.netProfit > 0);
  const losers = closedTrades.filter(trade => trade.netProfit <= 0);
  const grossProfit = winners.reduce((sum, trade) => sum + trade.netProfit, 0);
  const grossLoss = Math.abs(losers.reduce((sum, trade) => sum + trade.netProfit, 0));
  const netProfit = finalBalance - initialBalance;
  const totalReturnPercent = initialBalance > 0 ? (netProfit / initialBalance) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

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
    signals,
    cancelledSignals,
    fees,
    rejectionCounts: rejectionCounts || {},
    circuitBlockedEntries,
    circuitBreaks,
    marketRegimeBlockedEntries,
    signalWindowBlockedEntries,
    qualityScore: calculateQualityScore({
      totalReturnPercent,
      maxDrawdownPercent: calculateDrawdown(equityCurve),
      profitFactor,
      tradeCount: closedTrades.length
    })
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

function entryDecision(rebound, nextCandle, config) {
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

function closePosition(position, candle, exitReason, exitPrice, config, timestamp) {
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
    candleTime: candle?.candle_date_time_utc || candle?.candle_date_time_kst || null
  };
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

function updateProtectionState(position, candle, config) {
  const candleHigh = getHigh(candle);
  position.highestPrice = Math.max(Number(position.highestPrice) || position.entryPrice, candleHigh);
  const highGainPercent = ((position.highestPrice - position.entryPrice) / position.entryPrice) * 100;

  if (config.breakEvenTriggerPercent > 0 && highGainPercent >= config.breakEvenTriggerPercent) {
    position.breakEvenArmed = true;
  }
  if (config.trailingActivationPercent > 0 && config.trailingStopPercent > 0 &&
    highGainPercent >= config.trailingActivationPercent) {
    position.trailingArmed = true;
  }
}

function findExit(position, candle, config, timestamp) {
  const takePrice = position.entryPrice * (1 + config.takeProfitPercent / 100);
  const low = getLow(candle);
  const high = getHigh(candle);
  const protectiveStop = getProtectiveStop(position, config);

  // If both levels are touched inside one candle, choose the stop first. This
  // avoids giving the backtest an optimistic intrabar ordering it cannot know.
  if (low <= protectiveStop.price) {
    return { reason: protectiveStop.type, price: protectiveStop.price * (1 - config.slippage) };
  }
  if (high >= takePrice) {
    return { reason: 'TAKE_PROFIT', price: takePrice * (1 - config.slippage) };
  }

  const holdMs = timestamp - position.entryTimestamp;
  if (config.maxLosingHoldMinutes > 0 && holdMs >= config.maxLosingHoldMinutes * 60 * 1000 &&
    getClose(candle) <= position.entryPrice) {
    return { reason: 'MAX_LOSING_HOLD_TIME', price: getClose(candle) * (1 - config.slippage) };
  }
  if (config.maxHoldMinutes > 0 && holdMs >= config.maxHoldMinutes * 60 * 1000) {
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
  let cooldownUntil = 0;
  let consecutiveLosses = 0;
  const lossCircuitBreaker = createLossCircuitBreakerState();
  const rsiSeries = calculateRsiSeries(candles, options.rsiPeriod);

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
        const rebound = calculateReboundAtIndex(candles, index, rsiSeries, options);

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
            const investAmount = Math.min(
              balance * options.investmentRatio,
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
                highestPrice: entry.entryPrice,
                breakEvenArmed: false,
                trailingArmed: false
              };
              trades.push({
                type: 'OPEN',
                reason: 'OVERSOLD_REBOUND_DELAYED_ENTRY',
                entryPrice: entry.entryPrice,
                amount,
                investAmount,
                buyFee,
                signalKey: rebound.signalKey,
                signalTime: candle?.candle_date_time_utc || candle?.candle_date_time_kst || null,
                entryTime: position.entryTime,
                retracePercent: entry.retracePercent,
                chasePercent: entry.chasePercent
              });
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
      circuitBreaks
    })
  };
}

function marketEntries(rawCandlesByMarket) {
  if (rawCandlesByMarket instanceof Map) return [...rawCandlesByMarket.entries()];
  if (!rawCandlesByMarket || typeof rawCandlesByMarket !== 'object') return [];
  return Object.entries(rawCandlesByMarket);
}

function portfolioCandidateScore(rebound) {
  const reboundMove = number(rebound?.reboundPriceChangePercent ?? rebound?.priceChangePercent, 0);
  const rsiRecovery = number(rebound?.rsiRecovery, 0);
  const oversoldRsi = number(rebound?.oversoldRsi, 100);
  return reboundMove * 100 + rsiRecovery * 5 + Math.max(0, 50 - oversoldRsi);
}

function calculatePortfolioMarketRegime(group, options) {
  if (options.marketRegimeEnabled !== true) {
    return {
      enabled: false,
      available: true,
      confirmed: true,
      breadth: 1,
      averageReturnPercent: 0,
      marketCount: group.length,
      positiveMarketCount: group.length
    };
  }

  const lookback = Math.max(1, Math.floor(number(options.marketRegimeLookback, 5)));
  const minReturnPercent = number(options.marketRegimeMinReturnPercent, -0.2);
  const returns = group
    .map(({ context, index }) => {
      const currentClose = getClose(context.candles[index]);
      const referenceClose = getClose(context.candles[index - lookback]);
      if (!Number.isFinite(currentClose) || !Number.isFinite(referenceClose) || referenceClose <= 0) return null;
      return ((currentClose - referenceClose) / referenceClose) * 100;
    })
    .filter(value => Number.isFinite(value));
  const positiveMarketCount = returns.filter(value => value >= minReturnPercent).length;
  const breadth = returns.length > 0 ? positiveMarketCount / returns.length : 0;
  const averageReturnPercent = returns.length > 0
    ? returns.reduce((sum, value) => sum + value, 0) / returns.length
    : 0;
  const minBreadth = Math.max(0, Math.min(1, number(options.marketRegimeMinBreadth, 0.5)));
  return {
    enabled: true,
    available: returns.length > 0,
    confirmed: returns.length > 0 && breadth >= minBreadth && averageReturnPercent >= minReturnPercent,
    lookback,
    minBreadth,
    minReturnPercent,
    breadth,
    averageReturnPercent,
    marketCount: returns.length,
    positiveMarketCount
  };
}

/**
 * Simulate the portfolio that the live trader actually owns: one shared KRW
 * balance, a maximum number of simultaneous positions, and cross-market signal
 * selection at the same candle timestamp. The per-market simulator above is
 * still useful for contract-level studies, but it can overstate opportunity by
 * allowing every market to spend an independent initial balance.
 *
 * This function is deliberately a separate evidence lane. It does not change
 * the live trader or the fixed-config promotion gate.
 */
export function simulateScalpingPortfolio(rawCandlesByMarket, config = {}, simulationOptions = {}) {
  const options = { ...DEFAULT_CONFIG, maxPositions: 3, portfolioAllocation: 0.1, ...config };
  const contexts = marketEntries(rawCandlesByMarket)
    .map(([market, rawCandles]) => {
      const candles = normalizeHistoricalCandles(rawCandles);
      const rsiSeries = calculateRsiSeries(candles, options.rsiPeriod);
      const minimumHistory = options.rsiPeriod + Math.max(2, Math.floor(number(options.oversoldLookback, 1)));
      const requestedStartIndex = Number(simulationOptions.startTradingIndex);
      const startTradingIndex = Number.isFinite(requestedStartIndex)
        ? Math.max(minimumHistory, Math.floor(requestedStartIndex))
        : minimumHistory;
      return {
        market: String(market),
        candles,
        rsiSeries,
        startTradingIndex,
        position: null,
        cooldownUntil: 0,
        consecutiveLosses: 0,
        lastPrice: null,
        lastSignalKey: null
      };
    })
    .filter(context => context.candles.length > context.startTradingIndex + 1);

  const events = [];
  for (const context of contexts) {
    for (let index = context.startTradingIndex; index < context.candles.length; index += 1) {
      events.push({
        context,
        index,
        timestamp: candleTime(
          context.candles[index],
          index * options.candleUnit * 60 * 1000
        )
      });
    }
  }
  events.sort((a, b) => a.timestamp - b.timestamp || a.context.market.localeCompare(b.context.market));

  const trades = [];
  const equityCurve = [];
  const rejectionCounts = {};
  let balance = number(options.initialBalance, 1_000_000);
  let signals = 0;
  let cancelledSignals = 0;
  let skippedEntries = 0;
  let circuitBlockedEntries = 0;
  let circuitBreaks = 0;
  let marketRegimeBlockedEntries = 0;
  let signalWindowBlockedEntries = 0;
  let fees = 0;
  const lossCircuitBreaker = createLossCircuitBreakerState();

  const recordLoss = (context, closeTrade, timestamp) => {
    if (closeTrade.netProfit < 0) {
      context.consecutiveLosses += 1;
      const cooldownMinutes = context.consecutiveLosses >= options.maxConsecutiveLosses
        ? Math.max(options.cooldownAfterLossMinutes, 60)
        : options.cooldownAfterLossMinutes;
      context.cooldownUntil = timestamp + cooldownMinutes * 60 * 1000;
      const circuitResult = registerLoss(lossCircuitBreaker, timestamp, {
        maxLosses: options.lossCircuitBreakerCount,
        windowMinutes: options.lossCircuitBreakerWindowMinutes,
        cooldownMinutes: options.lossCircuitBreakerCooldownMinutes
      });
      if (circuitResult.triggered) circuitBreaks += 1;
    } else {
      context.consecutiveLosses = 0;
      context.cooldownUntil = 0;
    }
  };

  const closeContextPosition = (context, candle, exit, timestamp) => {
    const closeTrade = closePosition(
      context.position,
      candle,
      exit.reason,
      exit.price,
      options,
      timestamp
    );
    balance += closeTrade.grossAmount - closeTrade.sellFee;
    fees += closeTrade.sellFee;
    closeTrade.market = context.market;
    trades.push(closeTrade);
    recordLoss(context, closeTrade, timestamp);
    context.position = null;
    return closeTrade;
  };

  const markEquity = timestamp => {
    let equity = balance;
    for (const context of contexts) {
      if (context.position && Number.isFinite(context.lastPrice)) {
        equity += context.position.amount * context.lastPrice;
      }
    }
    equityCurve.push({ timestamp, equity });
  };

  let eventIndex = 0;
  while (eventIndex < events.length) {
    const timestamp = events[eventIndex].timestamp;
    const group = [];
    while (eventIndex < events.length && events[eventIndex].timestamp === timestamp) {
      group.push(events[eventIndex]);
      eventIndex += 1;
    }
    const closedContexts = new Set();

    // Exit all positions first. If a market was entered at this exact candle's
    // open, it is not evaluated for an exit until the next candle, matching the
    // ordering used by simulateScalping().
    for (const event of group) {
      const { context, index } = event;
      const candle = context.candles[index];
      context.lastPrice = getClose(candle);
      if (!context.position || context.position.entryTimestamp >= timestamp) continue;
      const exit = findExit(context.position, candle, options, timestamp);
      if (exit) {
        closeContextPosition(context, candle, exit, timestamp);
        closedContexts.add(context);
      } else {
        updateProtectionState(context.position, candle, options);
      }
    }

    const candidates = [];
    const marketRegime = calculatePortfolioMarketRegime(group, options);
    for (const event of group) {
      const { context, index } = event;
      if (index <= context.startTradingIndex || index >= context.candles.length || context.position || closedContexts.has(context)) continue;
      if (timestamp < context.cooldownUntil) continue;
      if (context.consecutiveLosses >= options.maxConsecutiveLosses) {
        context.consecutiveLosses = 0;
        context.cooldownUntil = 0;
      }
      if (isLossCircuitCoolingDown(lossCircuitBreaker, timestamp, {
        maxLosses: options.lossCircuitBreakerCount,
        windowMinutes: options.lossCircuitBreakerWindowMinutes
      })) {
        circuitBlockedEntries += 1;
        continue;
      }

      const rebound = calculateReboundAtIndex(
        context.candles,
        index - 1,
        context.rsiSeries,
        options
      );
      for (const rejectionReason of rebound?.rejectionReasons || []) {
        rejectionCounts[rejectionReason] = (rejectionCounts[rejectionReason] || 0) + 1;
      }
      if (!rebound?.reboundConfirmed) continue;

      signals += 1;
      if (options.marketRegimeEnabled === true && marketRegime.confirmed !== true) {
        marketRegimeBlockedEntries += 1;
        continue;
      }
      const entry = entryDecision(rebound, context.candles[index], options);
      if (!entry.valid) {
        cancelledSignals += 1;
        continue;
      }
      candidates.push({
        context,
        candle: context.candles[index],
        rebound,
        entry,
        marketRegime
      });
    }

    candidates.sort((a, b) =>
      portfolioCandidateScore(b.rebound) - portfolioCandidateScore(a.rebound) ||
      a.context.market.localeCompare(b.context.market)
    );
    const maxPositions = Math.max(1, Math.floor(number(options.maxPositions, 3)));
    const portfolioAllocation = Math.max(0, number(options.portfolioAllocation, 0.1));
    const maxEntriesPerSignalWindow = Math.max(0, Math.floor(number(options.maxEntriesPerSignalWindow, 0)));
    const acceptedEntriesBySignalKey = new Map();
    for (const candidate of candidates) {
      const activePositions = contexts.filter(context => context.position).length;
      if (activePositions >= maxPositions) {
        skippedEntries += 1;
        continue;
      }
      const signalKey = String(candidate.rebound.signalKey || timestamp);
      const acceptedForSignal = acceptedEntriesBySignalKey.get(signalKey) || 0;
      if (maxEntriesPerSignalWindow > 0 && acceptedForSignal >= maxEntriesPerSignalWindow) {
        signalWindowBlockedEntries += 1;
        continue;
      }
      const investAmount = Math.min(
        balance * number(options.investmentRatio, 0.02),
        balance * portfolioAllocation,
        balance * 0.95
      );
      if (investAmount < options.minOrderAmount || candidate.entry.entryPrice <= 0) {
        skippedEntries += 1;
        continue;
      }

      const buyFee = investAmount * options.tradingFee;
      const amount = (investAmount - buyFee) / candidate.entry.entryPrice;
      balance -= investAmount;
      fees += buyFee;
      const position = {
        market: candidate.context.market,
        entryPrice: candidate.entry.entryPrice,
        amount,
        investAmount,
        entryTimestamp: timestamp,
        entryTime: candidate.candle?.candle_date_time_utc || candidate.candle?.candle_date_time_kst || null,
        signalKey: candidate.rebound.signalKey,
        highestPrice: candidate.entry.entryPrice,
        breakEvenArmed: false,
        trailingArmed: false
      };
      candidate.context.position = position;
      candidate.context.lastSignalKey = candidate.rebound.signalKey;
      acceptedEntriesBySignalKey.set(signalKey, acceptedForSignal + 1);
      trades.push({
        type: 'OPEN',
        market: candidate.context.market,
        reason: 'OVERSOLD_REBOUND_PORTFOLIO_ENTRY',
        entryPrice: candidate.entry.entryPrice,
        amount,
        investAmount,
        buyFee,
        signalKey: candidate.rebound.signalKey,
        signalTime: candidate.candle?.candle_date_time_utc || candidate.candle?.candle_date_time_kst || null,
        entryTime: position.entryTime,
        retracePercent: candidate.entry.retracePercent,
        chasePercent: candidate.entry.chasePercent,
        selectionScore: portfolioCandidateScore(candidate.rebound),
        reboundPriceChangePercent: candidate.rebound.reboundPriceChangePercent,
        rsiRecovery: candidate.rebound.rsiRecovery,
        oversoldRsi: candidate.rebound.oversoldRsi,
        volumeRatio: candidate.rebound.volumeRatio,
        closeStrength: candidate.rebound.closeStrength,
        trendSlopePercent: candidate.rebound.trendSlopePercent,
        signalRangePercent: candidate.rebound.signalRangePercent,
        previousHighBreak: candidate.rebound.previousHighBreak,
        marketRegime: candidate.marketRegime
      });
    }

    markEquity(timestamp);
  }

  // Close any remaining portfolio positions at their own final market candle.
  for (const context of contexts) {
    if (!context.position || context.candles.length === 0) continue;
    const candle = context.candles.at(-1);
    const timestamp = candleTime(candle, Date.now());
    const exitPrice = getClose(candle) * (1 - options.slippage);
    closeContextPosition(context, candle, { reason: 'BACKTEST_END', price: exitPrice }, timestamp);
  }
  if (contexts.length > 0) {
    const finalTimestamp = Math.max(...contexts.map(context => candleTime(context.candles.at(-1), Date.now())));
    markEquity(finalTimestamp);
  }

  return {
    portfolio: true,
    config: options,
    marketCount: contexts.length,
    candleCounts: Object.fromEntries(contexts.map(context => [context.market, context.candles.length])),
    trades,
    equityCurve,
    lossCircuitBreaker,
    marketRegime: calculatePortfolioMarketRegime(
      events.length > 0 ? [events.at(-1)] : [],
      options
    ),
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
      marketRegimeBlockedEntries,
      signalWindowBlockedEntries
    }),
    skippedEntries,
    signalWindowBlockedEntries
  };
}

function expandGrid(baseConfig, grid) {
  const keys = Object.keys(grid);
  return keys.reduce((configs, key) => {
    const values = Array.isArray(grid[key]) ? grid[key] : [grid[key]];
    return configs.flatMap(config => values.map(value => ({ ...config, [key]: value })));
  }, [{ ...baseConfig }]);
}

export const DEFAULT_TUNING_GRID = {
  signalProfile: ['rsi_rebound', 'bb_reclaim', 'trend_rebound'],
  rsiOversold: [25, 30, 35],
  // Compare the original immediate-candle contract with a short reaction
  // window; do not assume a longer lookback is automatically better.
  oversoldLookback: [1, 3],
  minReboundPercent: [0.1, 0.25, 0.5],
  minRsiRecovery: [1, 2],
  // Forward shadow losses were concentrated in rejected low-volume
  // candidates. Explore a stricter 1.5x cohort, but keep live default at 1.0
  // until a complete holdout passes.
  minVolumeRatio: [0.8, 1, 1.5],
  minCloseStrength: [0.65, 0.8],
  minTrendSlopePercent: [-0.5, 0],
  // The live default remains strict=true, but validation must also test the
  // relaxed candidate instead of assuming that the high-break filter helps.
  requirePreviousHighBreak: [false, true],
  stopLossPercent: [0.8, 1.2],
  // Include sub-1.5% targets in research; trading costs make the target
  // distance itself a material hypothesis for short-lived rebounds.
  takeProfitPercent: [1, 1.2, 1.5, 2.5],
  // Protection candidates are intentionally absent from the default tuning
  // grid until a dedicated holdout study proves they generalize.
  breakEvenTriggerPercent: [0],
  trailingActivationPercent: [0],
  trailingStopPercent: [0]
};

/**
 * Tune only on the supplied training segment. The caller must evaluate the
 * selected config on a later holdout segment before promoting it.
 */
export function tuneScalpingParameters(candles, baseConfig = {}, grid = DEFAULT_TUNING_GRID) {
  const candidates = expandGrid({ ...DEFAULT_CONFIG, ...baseConfig }, grid);
  let best = null;
  const ranked = [];

  for (const candidate of candidates) {
    const result = simulateScalping(candles, candidate);
    ranked.push({ config: candidate, metrics: result.metrics });
    if (!best || result.metrics.qualityScore > best.result.metrics.qualityScore) {
      best = { config: candidate, result };
    }
  }

  ranked.sort((a, b) => b.metrics.qualityScore - a.metrics.qualityScore);
  return {
    candidateCount: candidates.length,
    best,
    topCandidates: ranked.slice(0, 10)
  };
}

/**
 * Tune a shared portfolio on one common training window. This deliberately
 * reuses the same candidate grid as the per-market study only when the caller
 * asks for it; portfolio runs can pass a smaller research grid to keep the
 * cross-market study bounded.
 */
export function tuneScalpingPortfolioParameters(candlesByMarket, baseConfig = {}, grid = DEFAULT_TUNING_GRID) {
  const candidates = expandGrid({ ...DEFAULT_CONFIG, ...baseConfig }, grid);
  let best = null;
  const ranked = [];

  for (const candidate of candidates) {
    const result = simulateScalpingPortfolio(candlesByMarket, candidate);
    ranked.push({ config: candidate, metrics: result.metrics });
    if (!best || result.metrics.qualityScore > best.result.metrics.qualityScore) {
      best = { config: candidate, result };
    }
  }

  ranked.sort((a, b) => b.metrics.qualityScore - a.metrics.qualityScore);
  return {
    candidateCount: candidates.length,
    best,
    topCandidates: ranked.slice(0, 10)
  };
}

/**
 * Walk-forward validation for the shared portfolio lane. It is intentionally
 * separate from walkForwardValidate(): a passing portfolio result is useful
 * evidence about allocation and selection, but never authorizes live orders.
 */
export function walkForwardValidatePortfolio(rawCandlesByMarket, baseConfig = {}, options = {}) {
  const entries = marketEntries(rawCandlesByMarket)
    .map(([market, candles]) => [String(market), normalizeHistoricalCandles(candles)])
    .filter(([, candles]) => candles.length > 0);
  const resolvedConfig = { ...DEFAULT_CONFIG, ...baseConfig };
  const marketCount = entries.length;
  if (marketCount === 0) {
    return {
      promoted: false,
      reason: 'insufficient_markets:0',
      marketCount: 0,
      candleCount: 0
    };
  }

  const shortestCandleCount = Math.min(...entries.map(([, candles]) => candles.length));
  const minimumCandles = options.minimumCandles ?? 120;
  if (shortestCandleCount < minimumCandles) {
    return {
      promoted: false,
      reason: `insufficient_candles:${shortestCandleCount}<${minimumCandles}`,
      marketCount,
      candleCount: shortestCandleCount
    };
  }

  const trainRatio = options.trainRatio ?? 0.7;
  const splitIndex = Math.max(
    Math.floor(shortestCandleCount * trainRatio),
    resolvedConfig.rsiPeriod + resolvedConfig.volumeLookback + resolvedConfig.trendPeriod + 5
  );
  if (splitIndex >= shortestCandleCount - 5) {
    return {
      promoted: false,
      reason: 'holdout_segment_too_small',
      marketCount,
      candleCount: shortestCandleCount
    };
  }

  const training = Object.fromEntries(entries.map(([market, candles]) => [market, candles.slice(0, splitIndex)]));
  const holdout = Object.fromEntries(entries.map(([market, candles]) => [market, candles.slice(splitIndex)]));
  const tuning = tuneScalpingPortfolioParameters(
    training,
    resolvedConfig,
    options.grid || DEFAULT_TUNING_GRID
  );
  const warmupLength = Math.min(
    splitIndex,
    Math.max(
      200,
      resolvedConfig.rsiPeriod + resolvedConfig.oversoldLookback + 2,
      resolvedConfig.volumeLookback + 2,
      resolvedConfig.trendPeriod + resolvedConfig.trendSlopeLookback + 2,
      resolvedConfig.bbPeriod + 2,
      resolvedConfig.emaPeriod + 2
    )
  );
  const validationCandles = Object.fromEntries(entries.map(([market, candles]) => [
    market,
    [...candles.slice(splitIndex - warmupLength, splitIndex), ...candles.slice(splitIndex)]
  ]));
  const validation = simulateScalpingPortfolio(
    validationCandles,
    tuning.best.config,
    { startTradingIndex: warmupLength }
  );
  const trainingMetrics = tuning.best.result.metrics;
  const minimumTrainingTrades = options.minimumTrainingTrades ?? 3;
  const minimumTrainingProfitFactor = options.minimumTrainingProfitFactor ?? 1;
  const minimumTrainingReturnPercent = options.minimumTrainingReturnPercent ?? 0;
  const trainingGatePassed = trainingMetrics.tradeCount >= minimumTrainingTrades &&
    trainingMetrics.totalReturnPercent >= minimumTrainingReturnPercent &&
    trainingMetrics.profitFactor >= minimumTrainingProfitFactor;
  const minimumValidationTrades = options.minimumValidationTrades ?? 10;
  const minimumProfitFactor = options.minimumProfitFactor ?? 1.05;
  const minimumReturnPercent = options.minimumReturnPercent ?? 0.1;
  const maximumDrawdownPercent = options.maximumDrawdownPercent ?? 15;
  const validationMetrics = validation.metrics;
  const validationGatePassed = validationMetrics.tradeCount >= minimumValidationTrades &&
    validationMetrics.totalReturnPercent >= minimumReturnPercent &&
    validationMetrics.profitFactor >= minimumProfitFactor &&
    validationMetrics.maxDrawdownPercent <= maximumDrawdownPercent;

  return {
    promoted: trainingGatePassed && validationGatePassed,
    reason: trainingGatePassed && validationGatePassed
      ? 'portfolio_walk_forward_gate_passed_diagnostic_only'
      : !trainingGatePassed ? 'training_gate_failed' : 'portfolio_walk_forward_gate_failed',
    marketCount,
    candleCount: shortestCandleCount,
    trainCandleCount: splitIndex,
    holdoutCandleCount: shortestCandleCount - splitIndex,
    validationWarmupCandleCount: warmupLength,
    tuning: {
      candidateCount: tuning.candidateCount,
      bestConfig: tuning.best.config,
      metrics: trainingMetrics
    },
    validation: validationMetrics,
    gate: {
      minimumTrainingTrades,
      minimumTrainingProfitFactor,
      minimumTrainingReturnPercent,
      trainingGatePassed,
      minimumValidationTrades,
      minimumProfitFactor,
      minimumReturnPercent,
      maximumDrawdownPercent
    },
    selection: {
      skippedEntries: validation.skippedEntries,
      circuitBlockedEntries: validationMetrics.circuitBlockedEntries,
      circuitBreaks: validationMetrics.circuitBreaks,
      marketRegimeBlockedEntries: validationMetrics.marketRegimeBlockedEntries,
      signalWindowBlockedEntries: validationMetrics.signalWindowBlockedEntries
    },
    promotion: 'diagnostic_only_never_authorizes_live_orders'
  };
}

/**
 * Run expanding-window portfolio validation over several future folds. A
 * candidate must pass every fold to be considered robust in this diagnostic
 * lane; a single favorable holdout is never enough.
 */
export function walkForwardValidatePortfolioFolds(rawCandlesByMarket, baseConfig = {}, options = {}) {
  const entries = marketEntries(rawCandlesByMarket)
    .map(([market, candles]) => [String(market), normalizeHistoricalCandles(candles)])
    .filter(([, candles]) => candles.length > 0);
  const foldCount = Math.max(2, Math.floor(number(options.foldCount, 3)));
  const initialTrainRatio = Math.max(0.3, Math.min(0.8, number(options.initialTrainRatio, 0.5)));
  const shortestCandleCount = entries.length > 0
    ? Math.min(...entries.map(([, candles]) => candles.length))
    : 0;
  const initialTrainEnd = Math.floor(shortestCandleCount * initialTrainRatio);
  const foldSize = Math.floor((shortestCandleCount - initialTrainEnd) / foldCount);
  if (entries.length === 0 || foldSize < 6) {
    return {
      promoted: false,
      reason: 'insufficient_data_for_multi_fold',
      marketCount: entries.length,
      candleCount: shortestCandleCount,
      foldCount,
      folds: []
    };
  }

  const folds = [];
  for (let foldIndex = 0; foldIndex < foldCount; foldIndex += 1) {
    const trainEnd = initialTrainEnd + foldIndex * foldSize;
    const evaluationEnd = Math.min(shortestCandleCount, trainEnd + foldSize);
    if (evaluationEnd - trainEnd < 6) continue;
    const foldCandles = Object.fromEntries(entries.map(([market, candles]) => [
      market,
      candles.slice(0, evaluationEnd)
    ]));
    const foldValidation = walkForwardValidatePortfolio(foldCandles, baseConfig, {
      ...options,
      foldCount: undefined,
      initialTrainRatio: undefined,
      trainRatio: trainEnd / evaluationEnd
    });
    folds.push({
      foldIndex: foldIndex + 1,
      trainCandleCount: trainEnd,
      holdoutCandleCount: evaluationEnd - trainEnd,
      validation: foldValidation
    });
  }

  const passed = folds.length === foldCount && folds.every(fold => fold.validation.promoted === true);
  const failedFold = folds.find(fold => fold.validation.promoted !== true);
  const sum = selector => folds.reduce((total, fold) => total + (Number(selector(fold.validation)) || 0), 0);
  return {
    promoted: passed,
    reason: passed
      ? 'all_portfolio_walk_forward_folds_passed_diagnostic_only'
      : failedFold
        ? `portfolio_fold_${failedFold.foldIndex}_failed:${failedFold.validation.reason}`
        : 'insufficient_completed_folds',
    marketCount: entries.length,
    candleCount: shortestCandleCount,
    foldCount,
    initialTrainRatio,
    foldSize,
    folds,
    aggregate: {
      promotedFoldCount: folds.filter(fold => fold.validation.promoted === true).length,
      holdoutTradeCount: sum(validation => validation.validation?.tradeCount),
      holdoutNetProfit: sum(validation => validation.validation?.netProfit),
      holdoutReturnPercent: sum(validation => validation.validation?.totalReturnPercent),
      marketRegimeBlockedEntries: sum(validation => validation.selection?.marketRegimeBlockedEntries),
      circuitBlockedEntries: sum(validation => validation.selection?.circuitBlockedEntries),
      signalWindowBlockedEntries: sum(validation => validation.selection?.signalWindowBlockedEntries)
    },
    promotion: 'diagnostic_only_never_authorizes_live_orders'
  };
}

/**
 * Walk-forward gate: tune on the earlier segment, then evaluate unchanged
 * parameters on the later segment. A positive training result alone is never
 * enough to promote a configuration.
 */
export function walkForwardValidate(candles, baseConfig = {}, options = {}) {
  const resolvedConfig = { ...DEFAULT_CONFIG, ...baseConfig };
  const normalized = normalizeHistoricalCandles(candles);
  const trainRatio = options.trainRatio ?? 0.7;
  const minimumCandles = options.minimumCandles ?? 120;
  if (normalized.length < minimumCandles) {
    return {
      promoted: false,
      reason: `insufficient_candles:${normalized.length}<${minimumCandles}`,
      candleCount: normalized.length
    };
  }

  const splitIndex = Math.max(Math.floor(normalized.length * trainRatio), resolvedConfig.rsiPeriod + 20);
  if (splitIndex >= normalized.length - 5) {
    return { promoted: false, reason: 'holdout_segment_too_small', candleCount: normalized.length };
  }

  const trainingCandles = normalized.slice(0, splitIndex);
  const holdoutCandles = normalized.slice(splitIndex);
  const tuning = tuneScalpingParameters(trainingCandles, resolvedConfig, options.grid || DEFAULT_TUNING_GRID);
  // Preserve indicator state across the train/holdout boundary. Recomputing
  // RSI from the first holdout candle would create a different signal stream
  // from live trading. The warmup candles are data-only; no trade is allowed
  // before the first actual holdout candle.
  const warmupLength = Math.min(
    trainingCandles.length,
    Math.max(
      200,
      resolvedConfig.rsiPeriod + resolvedConfig.oversoldLookback + 2,
      resolvedConfig.volumeLookback + 2,
      resolvedConfig.trendPeriod + resolvedConfig.trendSlopeLookback + 2,
      resolvedConfig.bbPeriod + 2,
      resolvedConfig.emaPeriod + 2
    )
  );
  const validationCandles = [
    ...trainingCandles.slice(-warmupLength),
    ...holdoutCandles
  ];
  const validation = simulateScalping(validationCandles, tuning.best.config, {
    startTradingIndex: warmupLength
  });
  const trainingMetrics = tuning.best.result.metrics;
  const minimumTrainingTrades = options.minimumTrainingTrades ?? 3;
  const minimumTrainingProfitFactor = options.minimumTrainingProfitFactor ?? 1;
  const minimumTrainingReturnPercent = options.minimumTrainingReturnPercent ?? 0;
  const trainingGatePassed = trainingMetrics.tradeCount >= minimumTrainingTrades &&
    trainingMetrics.totalReturnPercent >= minimumTrainingReturnPercent &&
    trainingMetrics.profitFactor >= minimumTrainingProfitFactor;
  const minimumValidationTrades = options.minimumValidationTrades ?? 3;
  const minimumProfitFactor = options.minimumProfitFactor ?? 1;
  const minimumReturnPercent = options.minimumReturnPercent ?? 0;
  const maximumDrawdownPercent = options.maximumDrawdownPercent ?? 15;
  const validationMetrics = validation.metrics;

  const validationGatePassed = validationMetrics.tradeCount >= minimumValidationTrades &&
    validationMetrics.totalReturnPercent >= minimumReturnPercent &&
    validationMetrics.profitFactor >= minimumProfitFactor &&
    validationMetrics.maxDrawdownPercent <= maximumDrawdownPercent;
  const promoted = trainingGatePassed && validationGatePassed;

  return {
    promoted,
    reason: promoted
      ? 'walk_forward_gate_passed'
      : !trainingGatePassed
        ? 'training_gate_failed'
        : 'walk_forward_gate_failed',
    candleCount: normalized.length,
    trainCandleCount: trainingCandles.length,
    holdoutCandleCount: holdoutCandles.length,
    validationWarmupCandleCount: warmupLength,
    tuning: {
      candidateCount: tuning.candidateCount,
      bestConfig: tuning.best.config,
      metrics: tuning.best.result.metrics
    },
    validation: validationMetrics,
    gate: {
      minimumTrainingTrades,
      minimumTrainingProfitFactor,
      minimumTrainingReturnPercent,
      trainingGatePassed,
      minimumValidationTrades,
      minimumProfitFactor,
      minimumReturnPercent,
      maximumDrawdownPercent
    }
  };
}

export { DEFAULT_CONFIG };
