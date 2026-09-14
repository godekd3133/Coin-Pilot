import {
  DEFAULT_DAILY_MOMENTUM_CONFIG,
  prepareDailyMomentumCandles
} from './dailyMomentumStudy.js';

const DEFAULT_DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_DAILY_MARKET_NEUTRAL_CONFIG = Object.freeze({
  initialBalance: 100_000_000,
  trendLookbackDays: 7,
  longCount: 3,
  shortCount: 3,
  longExposure: 0.4,
  shortExposure: 0.4,
  rebalanceDays: 3,
  minLongTrendPercent: null,
  maxShortTrendPercent: null,
  minTrendSpreadPercent: 0,
  requireBothSides: true,
  costPercent: 0.2,
  shortBorrowCostPercentPerDay: 0,
  excludeCurrentUtcDay: true
});

export const DEFAULT_DAILY_MARKET_NEUTRAL_VARIANTS = Object.freeze([
  {
    name: 'neutral_top3_bottom3_rebalance3',
    config: { longCount: 3, shortCount: 3, rebalanceDays: 3, requireBothSides: true }
  },
  {
    name: 'neutral_top3_bottom3_rebalance7',
    config: { longCount: 3, shortCount: 3, rebalanceDays: 7, requireBothSides: true }
  },
  {
    name: 'neutral_top2_bottom2_rebalance3',
    config: { longCount: 2, shortCount: 2, rebalanceDays: 3, requireBothSides: true }
  },
  {
    name: 'bear_short_bottom3_rebalance3',
    config: {
      longCount: 3,
      shortCount: 3,
      minLongTrendPercent: 0,
      maxShortTrendPercent: 0,
      rebalanceDays: 3,
      requireBothSides: false
    }
  },
  {
    name: 'bear_short_bottom3_rebalance7',
    config: {
      longCount: 3,
      shortCount: 3,
      minLongTrendPercent: 0,
      maxShortTrendPercent: 0,
      rebalanceDays: 7,
      requireBothSides: false
    }
  },
  {
    name: 'neutral_top3_bottom3_rebalance7_spread5',
    config: {
      longCount: 3,
      shortCount: 3,
      rebalanceDays: 7,
      minTrendSpreadPercent: 5,
      requireBothSides: true
    }
  },
  {
    name: 'neutral_top3_bottom3_rebalance10',
    config: { longCount: 3, shortCount: 3, rebalanceDays: 10, requireBothSides: true }
  },
  {
    name: 'neutral_top3_bottom3_rebalance14',
    config: { longCount: 3, shortCount: 3, rebalanceDays: 14, requireBothSides: true }
  },
  {
    name: 'neutral_top2_bottom2_rebalance7',
    config: { longCount: 2, shortCount: 2, rebalanceDays: 7, requireBothSides: true }
  }
]);

const finite = (value, fallback = null) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

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
    exposurePercent: 0,
    longExposurePercent: 0,
    shortExposurePercent: 0,
    turnover: 0
  };
}

function buildMetrics({
  initialBalance,
  finalEquity,
  trades,
  equityCurve,
  exposureDays,
  longExposureDays,
  shortExposureDays,
  totalDays,
  turnover
}) {
  const wins = trades.filter(trade => trade.profitPercent > 0);
  const losses = trades.filter(trade => trade.profitPercent < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.profitAmount, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.profitAmount, 0));
  const realizedProfit = trades.reduce((sum, trade) => sum + trade.profitAmount, 0);
  let peak = initialBalance;
  let maxDrawdownPercent = 0;
  for (const equity of equityCurve) {
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdownPercent = Math.max(maxDrawdownPercent, ((peak - equity) / peak) * 100);
  }
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
    exposurePercent: totalDays > 0 ? (exposureDays / totalDays) * 100 : 0,
    longExposurePercent: totalDays > 0 ? (longExposureDays / totalDays) * 100 : 0,
    shortExposurePercent: totalDays > 0 ? (shortExposureDays / totalDays) * 100 : 0,
    turnover
  };
}

function failureResult(initialBalance, dataQuality) {
  return {
    available: false,
    syntheticShort: true,
    researchOnly: true,
    promoted: false,
    dataQuality,
    metrics: emptyMetrics(initialBalance),
    trades: [],
    openPositions: [],
    unknownBoundaryPositions: [],
    unknownBoundaryPositionCount: 0,
    entryCount: 0,
    rebalanceCount: 0,
    promotion: 'synthetic_short_research_only_not_connected_to_upbit_spot'
  };
}

function threshold(value, fallback) {
  const parsed = finite(value);
  return parsed === null ? fallback : parsed;
}

function sideReturn(position, markPrice) {
  const gross = position.side === 'long'
    ? ((markPrice - position.entryPrice) / position.entryPrice) * 100
    : ((position.entryPrice - markPrice) / position.entryPrice) * 100;
  return gross;
}

function chooseSides(markets, normalized, index, options) {
  const trends = markets
    .map(market => {
      const candles = normalized[market];
      const reference = candles[index - options.trendLookbackDays].close;
      const current = candles[index].close;
      return {
        market,
        trendPercent: reference > 0 ? ((current - reference) / reference) * 100 : null
      };
    })
    .filter(row => row.trendPercent !== null)
    .sort((a, b) => b.trendPercent - a.trendPercent || a.market.localeCompare(b.market));
  const minLongTrendPercent = threshold(options.minLongTrendPercent, -Infinity);
  const maxShortTrendPercent = threshold(options.maxShortTrendPercent, Infinity);
  const longCandidates = trends.filter(row => row.trendPercent >= minLongTrendPercent);
  const shortCandidates = [...trends]
    .sort((a, b) => a.trendPercent - b.trendPercent || a.market.localeCompare(b.market))
    .filter(row => row.trendPercent <= maxShortTrendPercent);
  const long = longCandidates.slice(0, Math.max(0, Math.floor(finite(options.longCount, 3))));
  const short = shortCandidates.slice(0, Math.max(0, Math.floor(finite(options.shortCount, 3))));
  const spread = long.length && short.length
    ? long[0].trendPercent - short[0].trendPercent
    : null;
  const minTrendSpreadPercent = Math.max(0, finite(options.minTrendSpreadPercent, 0));
  if ((options.requireBothSides !== false && (!long.length || !short.length)) ||
    (spread !== null && spread < minTrendSpreadPercent)) {
    return { long: [], short: [], trends, spread, blocked: true };
  }
  return { long, short, trends, spread, blocked: false };
}

/**
 * Research-only cross-sectional long/short replay. The short leg is
 * synthetic: it models inverse price return and margin cash flows, but does
 * not imply that the current Upbit spot execution path can short.
 */
export function simulateDailyMarketNeutralPortfolio(rawCandlesByMarket, config = {}) {
  const options = {
    ...DEFAULT_DAILY_MARKET_NEUTRAL_CONFIG,
    ...DEFAULT_DAILY_MOMENTUM_CONFIG,
    ...config
  };
  const initialBalance = Math.max(0, finite(options.initialBalance, 100_000_000));
  const trendLookbackDays = Math.max(1, Math.floor(finite(options.trendLookbackDays, 7)));
  const rebalanceDays = Math.max(1, Math.floor(finite(options.rebalanceDays, 3)));
  const costPercent = Math.max(0, finite(options.costPercent, 0.2));
  const shortBorrowCostPercentPerDay = Math.max(0, finite(options.shortBorrowCostPercentPerDay, 0));
  const longExposure = Math.min(0.9, Math.max(0, finite(options.longExposure, 0.4)));
  const shortExposure = Math.min(0.9, Math.max(0, finite(options.shortExposure, 0.4)));
  const exposureScale = longExposure + shortExposure > 0.95
    ? 0.95 / (longExposure + shortExposure)
    : 1;
  const normalizedLongExposure = longExposure * exposureScale;
  const normalizedShortExposure = shortExposure * exposureScale;
  const prepared = prepareDailyMomentumCandles(rawCandlesByMarket, {
    ...options,
    trendLookbackDays,
    minUpBars: 1
  });
  const { normalized, dataQuality } = prepared;
  if (!dataQuality.valid) return failureResult(initialBalance, dataQuality);

  const markets = Object.keys(normalized);
  const timestamps = normalized[markets[0]].map(candle => candle.timestamp);
  const positions = new Map();
  const trades = [];
  const equityCurve = [];
  let cash = initialBalance;
  let lastRebalanceIndex = null;
  let entryCount = 0;
  let rebalanceCount = 0;
  let turnover = 0;
  let exposureDays = 0;
  let longExposureDays = 0;
  let shortExposureDays = 0;

  const closeAll = (index, timestamp) => {
    for (const [market, position] of [...positions.entries()]) {
      const markPrice = normalized[market][index].close;
      const grossProfitPercent = sideReturn(position, markPrice);
      const heldDays = (timestamp - position.entryTimestamp) / DEFAULT_DAY_MS;
      const borrowCostPercent = position.side === 'short'
        ? shortBorrowCostPercentPerDay * heldDays
        : 0;
      const profitPercent = grossProfitPercent - costPercent - borrowCostPercent;
      const profitAmount = position.notional * profitPercent / 100;
      cash += position.notional + profitAmount;
      turnover += position.notional;
      trades.push({
        market,
        side: position.side,
        entryTimestamp: new Date(position.entryTimestamp).toISOString(),
        entryPrice: position.entryPrice,
        exitTimestamp: new Date(timestamp).toISOString(),
        exitPrice: markPrice,
        grossProfitPercent,
        profitPercent,
        profitAmount,
        heldDays,
        borrowCostPercent
      });
      positions.delete(market);
    }
  };

  for (let index = trendLookbackDays; index < timestamps.length; index += 1) {
    const timestamp = timestamps[index];
    const shouldRebalance = lastRebalanceIndex === null || index - lastRebalanceIndex >= rebalanceDays;
    if (shouldRebalance) {
      closeAll(index, timestamp);
      const sides = chooseSides(markets, normalized, index, { ...options, trendLookbackDays });
      if (!sides.blocked) {
        const longNotional = sides.long.length ? cash * normalizedLongExposure / sides.long.length : 0;
        const shortNotional = sides.short.length ? cash * normalizedShortExposure / sides.short.length : 0;
        for (const candidate of sides.long) {
          if (longNotional <= 0) continue;
          cash -= longNotional;
          positions.set(candidate.market, {
            market: candidate.market,
            side: 'long',
            entryTimestamp: timestamp,
            entryPrice: normalized[candidate.market][index].close,
            notional: longNotional,
            trendPercent: candidate.trendPercent
          });
          entryCount += 1;
          turnover += longNotional;
        }
        for (const candidate of sides.short) {
          if (shortNotional <= 0 || positions.has(candidate.market)) continue;
          cash -= shortNotional;
          positions.set(candidate.market, {
            market: candidate.market,
            side: 'short',
            entryTimestamp: timestamp,
            entryPrice: normalized[candidate.market][index].close,
            notional: shortNotional,
            trendPercent: candidate.trendPercent
          });
          entryCount += 1;
          turnover += shortNotional;
        }
      }
      rebalanceCount += 1;
      lastRebalanceIndex = index;
    }

    if (positions.size > 0) exposureDays += 1;
    if ([...positions.values()].some(position => position.side === 'long')) longExposureDays += 1;
    if ([...positions.values()].some(position => position.side === 'short')) shortExposureDays += 1;
    let equity = cash;
    for (const [market, position] of positions.entries()) {
      const mark = normalized[market][index].close;
      const heldDays = (timestamp - position.entryTimestamp) / DEFAULT_DAY_MS;
      const borrowCostPercent = position.side === 'short'
        ? shortBorrowCostPercentPerDay * heldDays
        : 0;
      const markProfitPercent = sideReturn(position, mark) - costPercent - borrowCostPercent;
      equity += position.notional * (1 + markProfitPercent / 100);
    }
    equityCurve.push(equity);
  }

  const openPositions = [...positions.values()].map(position => {
    const markPrice = normalized[position.market].at(-1).close;
    const heldDays = (timestamps.at(-1) - position.entryTimestamp) / DEFAULT_DAY_MS;
    const borrowCostPercent = position.side === 'short'
      ? shortBorrowCostPercentPerDay * heldDays
      : 0;
    const markProfitPercent = sideReturn(position, markPrice) - costPercent - borrowCostPercent;
    return {
      ...position,
      entryTimestamp: new Date(position.entryTimestamp).toISOString(),
      markPrice,
      markProfitPercent,
      borrowCostPercent,
      markValue: position.notional * (1 + markProfitPercent / 100),
      reason: 'open_position_at_study_boundary'
    };
  });
  const finalEquity = equityCurve.at(-1) ?? cash;
  const totalDays = Math.max(0, timestamps.length - trendLookbackDays);
  const metrics = buildMetrics({
    initialBalance,
    finalEquity,
    trades,
    equityCurve,
    exposureDays,
    longExposureDays,
    shortExposureDays,
    totalDays,
    turnover
  });
  return {
    available: true,
    syntheticShort: true,
    researchOnly: true,
    promoted: false,
    config: {
      trendLookbackDays,
      longCount: Math.max(0, Math.floor(finite(options.longCount, 3))),
      shortCount: Math.max(0, Math.floor(finite(options.shortCount, 3))),
      longExposure: normalizedLongExposure,
      shortExposure: normalizedShortExposure,
      rebalanceDays,
      minLongTrendPercent: threshold(options.minLongTrendPercent, null),
      maxShortTrendPercent: threshold(options.maxShortTrendPercent, null),
      minTrendSpreadPercent: Math.max(0, finite(options.minTrendSpreadPercent, 0)),
      requireBothSides: options.requireBothSides !== false,
      costPercent,
      shortBorrowCostPercentPerDay
    },
    dataQuality,
    metrics,
    finalBalance: cash,
    finalEquity,
    trades,
    openPositions,
    unknownBoundaryPositions: openPositions,
    unknownBoundaryPositionCount: openPositions.length,
    entryCount,
    rebalanceCount,
    equityCurve: timestamps.slice(trendLookbackDays).map((timestamp, index) => ({
      timestamp: new Date(timestamp).toISOString(),
      equity: equityCurve[index]
    })),
    promotion: 'synthetic_short_research_only_not_connected_to_upbit_spot'
  };
}

function segmentRanges(candleCount, segmentCount) {
  const count = Math.max(1, Math.floor(finite(segmentCount, 4)));
  return Array.from({ length: count }, (_, index) => ({
    start: Math.floor(candleCount * index / count),
    end: Math.floor(candleCount * (index + 1) / count)
  }));
}

export function evaluateDailyMarketNeutralVariants(rawCandlesByMarket, {
  variants = DEFAULT_DAILY_MARKET_NEUTRAL_VARIANTS,
  segmentCount = 4,
  baseConfig = {}
  } = {}) {
  const firstMarket = Object.values(rawCandlesByMarket || {})[0] || [];
  const ranges = segmentRanges(firstMarket.length, segmentCount);
  const evaluated = variants.map(variant => {
    const config = { ...DEFAULT_DAILY_MARKET_NEUTRAL_CONFIG, ...baseConfig, ...(variant.config || {}) };
    const full = simulateDailyMarketNeutralPortfolio(rawCandlesByMarket, config);
    const segments = ranges.map((range, index) => {
      const segmented = Object.fromEntries(Object.entries(rawCandlesByMarket || {}).map(([market, candles]) => [
        market,
        Array.isArray(candles) ? candles.slice(range.start, range.end) : []
      ]));
      const result = simulateDailyMarketNeutralPortfolio(segmented, config);
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
      syntheticShort: true,
      full: {
        available: full.available,
        metrics: full.metrics,
        unknownBoundaryPositionCount: full.unknownBoundaryPositionCount,
        dataQuality: full.dataQuality
      },
      segments,
      allSegmentsAvailable,
      allSegmentsNonNegative,
      promoted: false,
      promotionReason: 'synthetic_short_research_only_not_connected_to_upbit_spot'
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    study: 'daily_market_neutral_synthetic_short_parameter_sweep',
    syntheticShort: true,
    researchOnly: true,
    promoted: false,
    variants: evaluated,
    promotionReason: 'synthetic_short_research_never_authorizes_live_orders'
  };
}

/**
 * Stress the most relevant synthetic-short contract across transaction and
 * financing costs. This is diagnostic sensitivity analysis, not parameter
 * optimization and never selects a live configuration.
 */
export function evaluateDailyMarketNeutralCostSensitivity(rawCandlesByMarket, {
  variant = DEFAULT_DAILY_MARKET_NEUTRAL_VARIANTS.find(item =>
    item.name === 'neutral_top3_bottom3_rebalance7'
  ) || DEFAULT_DAILY_MARKET_NEUTRAL_VARIANTS[0],
  transactionCosts = [0.1, 0.2, 0.3],
  shortBorrowCostsPerDay = [0, 0.01, 0.03],
  segmentCount = 4,
  baseConfig = {}
} = {}) {
  const firstMarket = Object.values(rawCandlesByMarket || {})[0] || [];
  const ranges = segmentRanges(firstMarket.length, segmentCount);
  const rows = [];
  for (const costPercent of transactionCosts) {
    for (const shortBorrowCostPercentPerDay of shortBorrowCostsPerDay) {
      const config = {
        ...DEFAULT_DAILY_MARKET_NEUTRAL_CONFIG,
        ...baseConfig,
        ...(variant.config || {}),
        costPercent,
        shortBorrowCostPercentPerDay
      };
      const result = simulateDailyMarketNeutralPortfolio(rawCandlesByMarket, config);
      const segments = ranges.map((range, index) => {
        const segmented = Object.fromEntries(Object.entries(rawCandlesByMarket || {}).map(([market, candles]) => [
          market,
          Array.isArray(candles) ? candles.slice(range.start, range.end) : []
        ]));
        const segmentResult = simulateDailyMarketNeutralPortfolio(segmented, config);
        return {
          segment: index,
          range,
          available: segmentResult.available,
          totalReturnPercent: segmentResult.metrics.totalReturnPercent,
          realizedReturnPercent: segmentResult.metrics.realizedReturnPercent,
          tradeCount: segmentResult.metrics.tradeCount,
          unknownBoundaryPositionCount: segmentResult.unknownBoundaryPositionCount,
          dataQuality: segmentResult.dataQuality
        };
      });
      rows.push({
        costPercent,
        shortBorrowCostPercentPerDay,
        available: result.available,
        metrics: result.metrics,
        unknownBoundaryPositionCount: result.unknownBoundaryPositionCount,
        segments,
        allSegmentsNonNegative: segments.every(segment =>
          segment.available && segment.totalReturnPercent >= 0 &&
          segment.unknownBoundaryPositionCount === 0
        )
      });
    }
  }
  return {
    variant: variant.name,
    syntheticShort: true,
    researchOnly: true,
    promoted: false,
    rows,
    promotionReason: 'synthetic_short_cost_sensitivity_never_authorizes_live_orders'
  };
}
