// 공유 잔고 포트폴리오 스캘핑 시뮬레이션 — scalpingBacktest.js에서 추출.
// 하나의 KRW 잔고와 maxPositions을 공유하는 다중 마켓 동기화 리플레이.
// 단일-마켓 시뮬 프리미티브는 scalpingBacktest에서 import한다(단방향 의존).
import { number } from './numeric.js';
import { createLossCircuitBreakerState, isLossCircuitCoolingDown, registerLoss } from '../risk/lossCircuitBreaker.js';
import { resolveScalpingVolatilitySizing } from '../research/scalpingVolatility.js';
import { getClose } from '../analysis/reboundSignal.js';
import {
  analyzeHistoricalCandleContinuity,
  candleTime,
  normalizeHistoricalCandles
} from './historicalCandleIntegrity.js';
import {
  DEFAULT_CONFIG,
  calculateReboundAtIndex,
  createMetrics,
  createPortfolioContinuityFailure,
  createScalpingFeatureCache,
  entryDecision,
  findExit,
  requiresHistoricalCandleContinuity,
  closePosition,
  updateProtectionState
} from './scalpingBacktest.js';


export function marketEntries(rawCandlesByMarket) {
  if (rawCandlesByMarket instanceof Map) return [...rawCandlesByMarket.entries()];
  if (!rawCandlesByMarket || typeof rawCandlesByMarket !== 'object') return [];
  return Object.entries(rawCandlesByMarket);
}


export function portfolioCandidateScore(rebound) {
  const reboundMove = number(rebound?.reboundPriceChangePercent ?? rebound?.priceChangePercent, 0);
  const rsiRecovery = number(rebound?.rsiRecovery, 0);
  const oversoldRsi = number(rebound?.oversoldRsi, 100);
  return reboundMove * 100 + rsiRecovery * 5 + Math.max(0, 50 - oversoldRsi);
}


export function calculatePortfolioMarketRegime(group, options) {
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
  const normalizedEntries = marketEntries(rawCandlesByMarket)
    .map(([market, rawCandles]) => [String(market), normalizeHistoricalCandles(rawCandles)])
    .filter(([, candles]) => candles.length > 0);
  const dataQualityByMarket = Object.fromEntries(normalizedEntries.map(([market, candles]) => [
    market,
    analyzeHistoricalCandleContinuity(candles, options.candleUnit, {
      maxGapSeconds: simulationOptions.maxHistoricalCandleGapSeconds ?? options.maxHistoricalCandleGapSeconds
    })
  ]));
  const invalidMarkets = Object.entries(dataQualityByMarket)
    .filter(([, quality]) => quality.valid !== true)
    .map(([market]) => market);
  const dataQuality = {
    valid: invalidMarkets.length === 0,
    reason: invalidMarkets.length === 0
      ? 'historical_candles_contiguous'
      : 'historical_candle_continuity_failed',
    marketCount: normalizedEntries.length,
    invalidMarkets,
    byMarket: dataQualityByMarket
  };
  if (requiresHistoricalCandleContinuity(options, simulationOptions)) {
    const invalidMarket = normalizedEntries.some(([market]) => dataQualityByMarket[market]?.valid !== true);
    if (invalidMarket) {
      return createPortfolioContinuityFailure(normalizedEntries, options, dataQualityByMarket);
    }
  }
  const suppliedFeatureCaches = simulationOptions.featureCacheByMarket || {};
  const contexts = normalizedEntries
    .map(([market, candles]) => {
      const featureCache = suppliedFeatureCaches[market]?.get
        ? suppliedFeatureCaches[market]
        : createScalpingFeatureCache(candles);
      const featureSet = featureCache.get(options);
      const rsiSeries = featureSet.rsiSeries;
      const minimumHistory = options.rsiPeriod + Math.max(2, Math.floor(number(options.oversoldLookback, 1)));
      const requestedStartIndex = Number(simulationOptions.startTradingIndex);
      const startTradingIndex = Number.isFinite(requestedStartIndex)
        ? Math.max(minimumHistory, Math.floor(requestedStartIndex))
        : minimumHistory;
      return {
        market: String(market),
        candles,
        rsiSeries,
        featureSet,
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
  let volatilityScaledEntries = 0;
  let volatilityBlockedEntries = 0;
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
        options,
        context.featureSet
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
      // Size from history before the completed signal candle. The signal move
      // itself must not influence the volatility used for this entry.
      const volatilitySizing = resolveScalpingVolatilitySizing({
        candles: context.candles,
        index: index - 1,
        lookbackCandles: options.volatilityLookbackCandles,
        targetPercent: options.volatilityTargetPercent
      });
      if (!volatilitySizing.available) {
        volatilityBlockedEntries += 1;
        continue;
      }
      candidates.push({
        context,
        candle: context.candles[index],
        rebound,
        entry,
        marketRegime,
        volatilitySizing
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
      const volatilitySizing = candidate.volatilitySizing;
      if (volatilitySizing.scale < 1) volatilityScaledEntries += 1;
      const investAmount = Math.min(
        balance * number(options.investmentRatio, 0.02) * volatilitySizing.scale,
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
          signalReferencePrice: candidate.rebound.referencePrice,
          highestPrice: candidate.entry.entryPrice,
          lowestPrice: candidate.entry.entryPrice,
          maxFavorableExcursionPercent: 0,
        maxAdverseExcursionPercent: 0,
        breakEvenArmed: false,
        trailingArmed: false,
        winnerExtended: false,
        volatilityPercent: volatilitySizing.volatilityPercent,
        volatilityScale: volatilitySizing.scale
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
        signalReferencePrice: candidate.rebound.referencePrice,
        signalTime: candidate.candle?.candle_date_time_utc || candidate.candle?.candle_date_time_kst || null,
        entryTime: position.entryTime,
        retracePercent: candidate.entry.retracePercent,
        chasePercent: candidate.entry.chasePercent,
        volatilityPercent: volatilitySizing.volatilityPercent,
        volatilityScale: volatilitySizing.scale,
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
      signalWindowBlockedEntries,
      volatilityScaledEntries,
      volatilityBlockedEntries,
      dataQuality
    }),
    skippedEntries,
    signalWindowBlockedEntries,
    volatilityScaledEntries,
    volatilityBlockedEntries,
    dataQuality
  };
}

export { DEFAULT_CONFIG };
