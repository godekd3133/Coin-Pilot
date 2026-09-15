import {
  DEFAULT_DAILY_MOMENTUM_CONFIG,
  simulateDailyMomentumPortfolio
} from './dailyMomentumStudy.js';

const DEFAULT_WINDOWS = Object.freeze([
  120, 180, 240, 300, 365, 400, 500, 600, 800
]);

/**
 * A reproducible rolling-window contract for the daily momentum research
 * lane. The defaults mirror the currently isolated fixed two-day candidate,
 * but this module is research-only and never changes a runner or live gate.
 */
export const DEFAULT_DAILY_MOMENTUM_ROLLING_CONFIG = Object.freeze({
  ...DEFAULT_DAILY_MOMENTUM_CONFIG,
  mode: 'fixed',
  maxHoldDays: 2,
  trendLookbackDays: 7,
  trendMinPercent: 2,
  breadthMin: 3,
  minUpBars: 2,
  costPercent: 0.3,
  positionFraction: 0.125,
  maxPositions: 2,
  cooldownAfterLossDays: 3,
  benchmarkMarket: 'KRW-BTC',
  benchmarkTrendMinPercent: 1,
  benchmarkMinUpBars: 1,
  benchmarkExitConfirmationBars: 1,
  regimeExitConfirmationBars: 1,
  exitOnBenchmarkOff: false,
  volatilityLookbackDays: 14,
  volatilityTargetPercent: 1,
  entryExecution: 'next_open',
  exitExecution: 'close',
  maxEntryGapPercent: 0.2,
  maxPortfolioDrawdownPercent: 15
});

export const DEFAULT_DAILY_MOMENTUM_ROLLING_WINDOWS = DEFAULT_WINDOWS;

function finite(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeWindows(windows) {
  const source = Array.isArray(windows) ? windows : DEFAULT_WINDOWS;
  const normalized = [...new Set(source
    .map(value => Math.floor(finite(value, 0)))
    .filter(value => value > 0))];
  return normalized.length ? normalized : [...DEFAULT_WINDOWS];
}

function failureRow(windowDays, reason, markets, minimumTradeCount) {
  return {
    windowDays,
    available: false,
    status: reason === 'rolling_window_history_too_short'
      ? 'DATA_QUALITY_FAIL'
      : 'HOLD',
    dataQuality: {
      valid: false,
      reason,
      marketCount: markets.length,
      markets
    },
    metrics: null,
    tradeCount: 0,
    minimumTradeCount,
    unknownBoundaryPositionCount: 0,
    unknownBoundaryEntryCount: 0,
    unknownBoundaryExitCount: 0,
    entryGapBlockedCount: 0
  };
}

function projectRow(windowDays, result, minimumTradeCount) {
  const metrics = result.metrics || {};
  const unknownBoundaryPositionCount = Number(result.unknownBoundaryPositionCount) || 0;
  const unknownBoundaryEntryCount = Number(result.unknownBoundaryEntryCount) || 0;
  const unknownBoundaryExitCount = Number(result.unknownBoundaryExitCount) || 0;
  const tradeCount = Number(metrics.tradeCount) || 0;
  const boundaryUnknown = unknownBoundaryPositionCount > 0 ||
    unknownBoundaryEntryCount > 0 || unknownBoundaryExitCount > 0;
  const status = !result.available
    ? 'DATA_QUALITY_FAIL'
    : boundaryUnknown
      ? 'BOUNDARY_UNKNOWN'
      : tradeCount < minimumTradeCount
        ? 'INSUFFICIENT_SAMPLE'
        : Number(metrics.totalReturnPercent) > 0
          ? 'POSITIVE_OBSERVATION'
          : 'NEGATIVE_OBSERVATION';

  return {
    windowDays,
    available: result.available === true,
    status,
    dataQuality: result.dataQuality,
    metrics,
    tradeCount,
    minimumTradeCount,
    unknownBoundaryPositionCount,
    unknownBoundaryEntryCount,
    unknownBoundaryExitCount,
    entryGapBlockedCount: Number(result.entryGapBlockedCount) || 0,
    openPositionCount: Array.isArray(result.openPositions) ? result.openPositions.length : 0
  };
}

/**
 * Evaluate one contract over trailing windows of a common multi-market daily
 * cache. A window is never silently shortened: insufficient history is an
 * explicit data-quality failure. Every row remains diagnostic-only.
 */
export function evaluateDailyMomentumRollingWindows(rawCandlesByMarket, {
  windows = DEFAULT_WINDOWS,
  baseConfig = DEFAULT_DAILY_MOMENTUM_ROLLING_CONFIG,
  minimumTradeCount = 30
} = {}) {
  const markets = Object.keys(rawCandlesByMarket || {});
  const config = {
    ...DEFAULT_DAILY_MOMENTUM_ROLLING_CONFIG,
    ...baseConfig
  };
  const minTrades = Math.max(1, Math.floor(finite(minimumTradeCount, 30)));
  const rows = normalizeWindows(windows).map(windowDays => {
    const shortMarkets = markets.filter(market =>
      !Array.isArray(rawCandlesByMarket?.[market]) ||
      rawCandlesByMarket[market].length < windowDays
    );
    if (shortMarkets.length) {
      return failureRow(
        windowDays,
        'rolling_window_history_too_short',
        shortMarkets,
        minTrades
      );
    }
    const trailing = Object.fromEntries(markets.map(market => [
      market,
      rawCandlesByMarket[market].slice(-windowDays)
    ]));
    return projectRow(
      windowDays,
      simulateDailyMomentumPortfolio(trailing, config),
      minTrades
    );
  });

  return {
    generatedAt: new Date().toISOString(),
    study: 'daily_momentum_rolling_windows',
    researchOnly: true,
    promoted: false,
    markets,
    config,
    minimumTradeCount: minTrades,
    windows: rows,
    promotionReason: 'daily_momentum_rolling_windows_are_research_only_and_never_authorize_live_orders',
    note: 'Trailing window observations are diagnostic evidence only; they do not authorize a runner, promotion, or live order.'
  };
}

