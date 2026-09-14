import {
  DEFAULT_DAILY_MOMENTUM_CONFIG,
  evaluateDailyMomentumVariants,
  prepareDailyMomentumCandles,
  simulateDailyMomentumPortfolio
} from './dailyMomentumStudy.js';

const DEFAULT_GRID = Object.freeze({
  trendMinPercent: Object.freeze([1, 2]),
  breadthMin: Object.freeze([2, 3]),
  positionFraction: Object.freeze([0.125, 0.2, 0.25]),
  maxPositions: Object.freeze([2, 3, 4]),
  cooldownAfterLossDays: Object.freeze([0, 3]),
  maxPortfolioDrawdownPercent: Object.freeze([0, 10, 15]),
  benchmarkTrendMinPercent: Object.freeze([2]),
  minUpBars: Object.freeze([1])
});

export const DEFAULT_DAILY_MOMENTUM_ROBUSTNESS_CONFIG = Object.freeze({
  segmentCount: 8,
  minimumFullReturnPercent: 0,
  maximumDrawdownPercent: 15,
  minimumWorstSegmentReturnPercent: -2,
  minimumTradeCount: 30,
  shortlistLimit: 10,
  benchmarkMarket: 'KRW-BTC',
  benchmarkTrendMinPercent: 2,
  exitOnBenchmarkOff: true,
  mode: 'regime',
  maxHoldDays: 3650,
  minUpBars: 1,
  segmentMode: 'continuous'
});

export const DEFAULT_DAILY_MOMENTUM_ROBUSTNESS_GRID = DEFAULT_GRID;

function asFiniteArray(value, fallback) {
  const values = Array.isArray(value) ? value : fallback;
  return values
    .map(item => Number(item))
    .filter(item => Number.isFinite(item));
}

function safeName(value) {
  const parsed = Number(value);
  const text = Number.isInteger(parsed)
    ? String(parsed)
    : String(parsed).replace(/0+$/, '').replace(/\.$/, '');
  return text.replace('-', 'm').replace('.', 'p');
}

export function buildDailyMomentumRobustnessVariants(grid = DEFAULT_GRID, baseConfig = {}) {
  const axes = {
    trendMinPercent: asFiniteArray(grid.trendMinPercent, DEFAULT_GRID.trendMinPercent),
    breadthMin: asFiniteArray(grid.breadthMin, DEFAULT_GRID.breadthMin),
    positionFraction: asFiniteArray(grid.positionFraction, DEFAULT_GRID.positionFraction),
    maxPositions: asFiniteArray(grid.maxPositions, DEFAULT_GRID.maxPositions),
    cooldownAfterLossDays: asFiniteArray(grid.cooldownAfterLossDays, DEFAULT_GRID.cooldownAfterLossDays),
    maxPortfolioDrawdownPercent: asFiniteArray(
      grid.maxPortfolioDrawdownPercent,
      DEFAULT_GRID.maxPortfolioDrawdownPercent
    ),
    benchmarkTrendMinPercent: asFiniteArray(
      grid.benchmarkTrendMinPercent,
      DEFAULT_GRID.benchmarkTrendMinPercent
    ),
    minUpBars: asFiniteArray(grid.minUpBars, DEFAULT_GRID.minUpBars)
  };
  const variants = [];
  for (const trendMinPercent of axes.trendMinPercent) {
    for (const breadthMin of axes.breadthMin) {
      for (const positionFraction of axes.positionFraction) {
        for (const maxPositions of axes.maxPositions) {
          for (const cooldownAfterLossDays of axes.cooldownAfterLossDays) {
            for (const maxPortfolioDrawdownPercent of axes.maxPortfolioDrawdownPercent) {
              for (const benchmarkTrendMinPercent of axes.benchmarkTrendMinPercent) {
                for (const minUpBars of axes.minUpBars) {
                  const config = {
                    ...baseConfig,
                    mode: 'regime',
                    trendMinPercent,
                    breadthMin,
                    minUpBars,
                    maxHoldDays: 3650,
                    benchmarkMarket: 'KRW-BTC',
                    benchmarkTrendMinPercent,
                    exitOnBenchmarkOff: true,
                    positionFraction,
                    maxPositions,
                    cooldownAfterLossDays,
                    maxPortfolioDrawdownPercent
                  };
                  variants.push({
                    name: `regime_g${safeName(benchmarkTrendMinPercent)}_u${safeName(minUpBars)}_t${safeName(trendMinPercent)}_b${safeName(breadthMin)}_f${safeName(positionFraction)}_p${safeName(maxPositions)}_c${safeName(cooldownAfterLossDays)}_dd${safeName(maxPortfolioDrawdownPercent)}`,
                    config
                  });
                }
              }
            }
          }
        }
      }
    }
  }
  return variants;
}

function finite(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function segmentRanges(candleCount, segmentCount) {
  const count = Math.max(1, Math.floor(Number(segmentCount) || 8));
  return Array.from({ length: count }, (_, index) => ({
    start: Math.floor(candleCount * index / count),
    end: Math.floor(candleCount * (index + 1) / count)
  }));
}

function tradeExitTimestamp(trade) {
  const timestamp = Date.parse(trade?.exitTimestamp || '');
  return Number.isFinite(timestamp) ? timestamp : null;
}

function metricsForContinuousSegment({ initialBalance, startEquity, endEquity, equities, trades }) {
  const wins = trades.filter(trade => Number(trade.profitPercent) > 0);
  const losses = trades.filter(trade => Number(trade.profitPercent) < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + (Number(trade.profitAmount) || 0), 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + (Number(trade.profitAmount) || 0), 0));
  let peak = startEquity;
  let maxDrawdownPercent = 0;
  for (const equity of equities) {
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdownPercent = Math.max(maxDrawdownPercent, ((peak - equity) / peak) * 100);
  }
  const realizedProfit = trades.reduce((sum, trade) => sum + (Number(trade.profitAmount) || 0), 0);
  return {
    initialBalance: startEquity,
    finalEquity: endEquity,
    netProfit: endEquity - startEquity,
    totalReturnPercent: startEquity > 0 ? ((endEquity / startEquity) - 1) * 100 : 0,
    realizedProfit,
    realizedReturnPercent: startEquity > 0 ? (realizedProfit / startEquity) * 100 : 0,
    tradeCount: trades.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    grossProfit,
    grossLoss,
    maxDrawdownPercent,
    exposurePercent: null,
    sourceInitialBalance: initialBalance
  };
}

function evaluateContinuousSegments(rawCandlesByMarket, config, segmentCount) {
  const full = simulateDailyMomentumPortfolio(rawCandlesByMarket, config);
  if (!full.available) {
    return {
      full,
      segments: [],
      allSegmentsAvailable: false,
      allSegmentsNonNegative: false
    };
  }

  const prepared = prepareDailyMomentumCandles(rawCandlesByMarket, config);
  const { normalized, dataQuality } = prepared;
  const firstMarket = Object.values(normalized)[0] || [];
  const timestamps = firstMarket.map(candle => candle.timestamp);
  const trendLookbackDays = Math.max(1, Math.floor(Number(config.trendLookbackDays) || 7));
  const ranges = segmentRanges(timestamps.length, segmentCount);
  const curve = Array.isArray(full.equityCurve) ? full.equityCurve : [];
  const initialBalance = Number(full.metrics?.initialBalance) || Number(config.initialBalance) || 0;
  const equityAt = index => {
    if (index < trendLookbackDays) return initialBalance;
    const point = curve[index - trendLookbackDays];
    return Number.isFinite(Number(point?.equity)) ? Number(point.equity) : null;
  };
  const segments = ranges.map((range, segment) => {
    const startIndex = Math.max(range.start, trendLookbackDays);
    const endIndex = Math.min(range.end - 1, timestamps.length - 1);
    if (startIndex > endIndex || equityAt(endIndex) === null) {
      return {
        segment,
        range,
        available: false,
        metrics: null,
        unknownBoundaryPositionCount: 0,
        dataQuality: { ...dataQuality, segmentRange: range }
      };
    }
    const startEquity = startIndex === trendLookbackDays
      ? initialBalance
      : equityAt(startIndex - 1);
    const endEquity = equityAt(endIndex);
    const equities = [startEquity, ...curve.slice(startIndex - trendLookbackDays, endIndex - trendLookbackDays + 1)
      .map(point => Number(point.equity))
      .filter(value => Number.isFinite(value))];
    const startTimestamp = timestamps[startIndex];
    const endTimestamp = timestamps[endIndex];
    const segmentTrades = (full.trades || []).filter(trade => {
      const exitTimestamp = tradeExitTimestamp(trade);
      return exitTimestamp !== null && exitTimestamp >= startTimestamp && exitTimestamp <= endTimestamp;
    });
    const unknownBoundaryPositionCount = endIndex === timestamps.length - 1
      ? Number(full.unknownBoundaryPositionCount) || 0
      : 0;
    return {
      segment,
      range,
      available: true,
      metrics: metricsForContinuousSegment({
        initialBalance,
        startEquity,
        endEquity,
        equities,
        trades: segmentTrades
      }),
      unknownBoundaryPositionCount,
      dataQuality: { ...dataQuality, segmentRange: range }
    };
  });
  const allSegmentsAvailable = segments.every(segment => segment.available);
  const allSegmentsNonNegative = allSegmentsAvailable && segments.every(segment =>
    segment.metrics.totalReturnPercent >= 0 && segment.unknownBoundaryPositionCount === 0
  );
  return { full, segments, allSegmentsAvailable, allSegmentsNonNegative };
}

function summarizeVariant(variant, criteria) {
  const fullMetrics = variant.full?.metrics || {};
  const segmentReturns = (variant.segments || [])
    .filter(segment => segment.available && segment.metrics)
    .map(segment => finite(segment.metrics.totalReturnPercent, null))
    .filter(value => value !== null);
  const worstSegmentReturnPercent = segmentReturns.length ? Math.min(...segmentReturns) : null;
  const positiveSegmentCount = segmentReturns.filter(value => value >= 0).length;
  const allSegmentsAvailable = variant.allSegmentsAvailable === true;
  const noUnknownBoundary = Number(variant.full?.unknownBoundaryPositionCount) === 0 &&
    (variant.segments || []).every(segment => Number(segment.unknownBoundaryPositionCount) === 0);
  const eligibilityBlockers = [];
  if (!allSegmentsAvailable) eligibilityBlockers.push('segment_data_unavailable');
  if (!noUnknownBoundary) eligibilityBlockers.push('unknown_boundary_position');
  if (finite(fullMetrics.totalReturnPercent, -Infinity) < criteria.minimumFullReturnPercent) {
    eligibilityBlockers.push('full_return_below_floor');
  }
  if (finite(fullMetrics.maxDrawdownPercent, Infinity) > criteria.maximumDrawdownPercent) {
    eligibilityBlockers.push('drawdown_above_limit');
  }
  if (finite(worstSegmentReturnPercent, -Infinity) < criteria.minimumWorstSegmentReturnPercent) {
    eligibilityBlockers.push('worst_segment_below_floor');
  }
  if (finite(fullMetrics.tradeCount, 0) < criteria.minimumTradeCount) {
    eligibilityBlockers.push('trade_sample_below_minimum');
  }
  const drawdownStopTriggered = variant.full?.drawdownStopTriggered === true;
  const riskFlags = drawdownStopTriggered ? ['drawdown_stop_triggered'] : [];
  const shadowEligible = eligibilityBlockers.length === 0;

  return {
    name: variant.name,
    config: variant.config,
    full: variant.full,
    segments: variant.segments,
    allSegmentsAvailable,
    allSegmentsNonNegative: variant.allSegmentsNonNegative === true,
    noUnknownBoundary,
    worstSegmentReturnPercent,
    positiveSegmentCount,
    segmentCount: segmentReturns.length,
    eligibilityBlockers,
    drawdownStopTriggered,
    drawdownStopAt: variant.full?.drawdownStopAt || null,
    riskFlags,
    shadowEligible,
    status: shadowEligible
      ? drawdownStopTriggered ? 'SHADOW_CANDIDATE_WITH_STOP' : 'SHADOW_CANDIDATE'
      : 'HOLD'
  };
}

/**
 * Compare risk envelopes around the defensive daily momentum contract.
 * Positive historical return is not enough: the report requires a bounded
 * drawdown, a minimum trade sample, and an explicit worst-segment floor before
 * it can suggest a new isolated forward shadow. It never authorizes orders.
 */
export function evaluateDailyMomentumRobustness(rawCandlesByMarket, options = {}) {
  const config = {
    ...DEFAULT_DAILY_MOMENTUM_ROBUSTNESS_CONFIG,
    ...options
  };
  const baseConfig = {
    ...DEFAULT_DAILY_MOMENTUM_CONFIG,
    ...(options.baseConfig || {})
  };
  const variants = options.variants || buildDailyMomentumRobustnessVariants(
    options.grid || DEFAULT_GRID,
    {
      initialBalance: baseConfig.initialBalance,
      costPercent: baseConfig.costPercent
    }
  );
  const segmentCount = Math.max(2, Math.floor(Number(config.segmentCount) || 8));
  const evaluated = variants.map(variant => {
    const resolvedConfig = { ...DEFAULT_DAILY_MOMENTUM_CONFIG, ...baseConfig, ...(variant.config || {}) };
    const result = config.segmentMode === 'independent'
      ? evaluateDailyMomentumVariants(rawCandlesByMarket, {
        variants: [variant],
        segmentCount,
        baseConfig
      }).variants[0]
      : (() => {
        const continuous = evaluateContinuousSegments(rawCandlesByMarket, resolvedConfig, segmentCount);
        return {
          name: variant.name,
          config: resolvedConfig,
          full: {
            available: continuous.full.available,
          metrics: continuous.full.metrics,
          unknownBoundaryPositionCount: continuous.full.unknownBoundaryPositionCount,
          dataQuality: continuous.full.dataQuality,
          drawdownStopTriggered: continuous.full.drawdownStopTriggered === true,
          drawdownStopAt: continuous.full.drawdownStopAt || null
          },
          segments: continuous.segments,
          allSegmentsAvailable: continuous.allSegmentsAvailable,
          allSegmentsNonNegative: continuous.allSegmentsNonNegative,
          promoted: false,
          promotionReason: 'daily_momentum_variants_are_research_only_and_not_wired_to_live_gate'
        };
      })();
    return summarizeVariant(result, config);
  });

  const shortlist = evaluated
    .filter(variant => variant.shadowEligible)
    .sort((a, b) => b.worstSegmentReturnPercent - a.worstSegmentReturnPercent ||
      a.full.metrics.maxDrawdownPercent - b.full.metrics.maxDrawdownPercent ||
      b.full.metrics.totalReturnPercent - a.full.metrics.totalReturnPercent)
    .slice(0, Math.max(1, Math.floor(Number(config.shortlistLimit) || 10)))
    .map(variant => ({
      name: variant.name,
      config: variant.config,
      status: variant.status,
      fullMetrics: variant.full.metrics,
      worstSegmentReturnPercent: variant.worstSegmentReturnPercent,
      positiveSegmentCount: variant.positiveSegmentCount,
      segmentCount: variant.segmentCount,
      noUnknownBoundary: variant.noUnknownBoundary,
      drawdownStopTriggered: variant.drawdownStopTriggered,
      drawdownStopAt: variant.drawdownStopAt,
      riskFlags: variant.riskFlags
    }));
  const nearMisses = evaluated
    .filter(variant => !variant.shadowEligible)
    .sort((a, b) => b.worstSegmentReturnPercent - a.worstSegmentReturnPercent ||
      a.full.metrics.maxDrawdownPercent - b.full.metrics.maxDrawdownPercent ||
      b.full.metrics.totalReturnPercent - a.full.metrics.totalReturnPercent)
    .slice(0, Math.max(1, Math.floor(Number(config.shortlistLimit) || 10)))
    .map(variant => ({
      name: variant.name,
      config: variant.config,
      status: variant.status,
      fullMetrics: variant.full.metrics,
      worstSegmentReturnPercent: variant.worstSegmentReturnPercent,
      positiveSegmentCount: variant.positiveSegmentCount,
      segmentCount: variant.segmentCount,
      noUnknownBoundary: variant.noUnknownBoundary,
      eligibilityBlockers: variant.eligibilityBlockers,
      drawdownStopTriggered: variant.drawdownStopTriggered,
      drawdownStopAt: variant.drawdownStopAt,
      riskFlags: variant.riskFlags
    }));
  const statusCounts = evaluated.reduce((counts, variant) => {
    counts[variant.status] = (counts[variant.status] || 0) + 1;
    return counts;
  }, {});
  const benchmarkThresholdSummary = evaluated.reduce((summary, variant) => {
    const threshold = String(variant.config?.benchmarkTrendMinPercent ?? 'unset');
    if (!summary[threshold]) summary[threshold] = {};
    summary[threshold][variant.status] = (summary[threshold][variant.status] || 0) + 1;
    return summary;
  }, {});

  return {
    generatedAt: new Date().toISOString(),
    study: 'daily_momentum_robustness_grid',
    researchOnly: true,
    promoted: false,
    criteria: {
      minimumFullReturnPercent: finite(config.minimumFullReturnPercent, 0),
      maximumDrawdownPercent: finite(config.maximumDrawdownPercent, 15),
      minimumWorstSegmentReturnPercent: finite(config.minimumWorstSegmentReturnPercent, -2),
      minimumTradeCount: Math.max(1, Math.floor(finite(config.minimumTradeCount, 30)))
    },
    segmentMode: config.segmentMode === 'independent' ? 'independent' : 'continuous',
    grid: options.grid || DEFAULT_GRID,
    variants: evaluated,
    shortlist,
    nearMisses,
    statusCounts,
    benchmarkThresholdSummary,
    shadowCandidateCount: shortlist.length,
    promotionReason: 'daily_momentum_robustness_is_research_only_and_requires_a_separate_forward_owner',
    note: 'SHADOW_CANDIDATE는 historical risk-envelope 통과 표시일 뿐 runtime 설정이나 live 주문을 변경하지 않습니다.'
  };
}
