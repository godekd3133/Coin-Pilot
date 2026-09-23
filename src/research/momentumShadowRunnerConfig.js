import { isDeepStrictEqual } from 'node:util';
import { resolveMomentumShadowExecutionModel } from './momentumShadowExecutionModel.js';

export const DEFAULT_MOMENTUM_SHADOW_MARKETS = Object.freeze([
  'KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL'
]);

export function getMomentumShadowConfigDriftChanges(previous, current) {
  const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isRecord(previous) || !isRecord(current)) return [];

  const keys = [...new Set([...Object.keys(previous), ...Object.keys(current)])];
  return keys
    .filter(key => !isDeepStrictEqual(previous[key], current[key]))
    .map(key => ({
      key,
      previousRecorded: Object.hasOwn(previous, key),
      previousValue: Object.hasOwn(previous, key) ? previous[key] : null,
      currentRecorded: Object.hasOwn(current, key),
      currentValue: Object.hasOwn(current, key) ? current[key] : null
  }));
}

// Object key order is serialization detail; array order and every value remain
// part of the sealed runner contract.
export function recordMomentumShadowConfigDrift(ledger, activeConfig, changedAt = new Date().toISOString()) {
  if (isDeepStrictEqual(ledger?.config, activeConfig)) return false;
  ledger.configDrift = { previous: ledger.config, changedAt };
  ledger.config = activeConfig;
  return true;
}

function parseMarkets(value) {
  if (typeof value !== 'string') return null;
  const markets = [...new Set(value.split(',').map(market => market.trim()).filter(Boolean))];
  return markets.length ? markets : null;
}

function optionalNonNegative(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
}

function optionalPositive(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(100, parsed) : null;
}

/**
 * Resolve a shadow runner contract without silently replacing an existing
 * ledger's mode or market universe when optional environment variables are
 * omitted. Explicit env values remain allowed and are recorded as drift by
 * the runner; new ledgers use the four-market defaults.
 */
export function resolveMomentumShadowRunnerContract({
  mode,
  markets,
  benchmarkMarket,
  benchmarkTrendMinPercent,
  relativeTrendMinPercent,
  exitOnBenchmarkOff,
  minUpBars,
  cooldownAfterLossDays,
  maxPortfolioDrawdownPercent,
  maxEntryGapPercent,
  maxDailyCandleAgeHours,
  maxSpreadPercent,
  requestIntervalMs,
  volatilityLookbackDays,
  volatilityTargetPercent,
  executionModel,
  persistedConfig = null
} = {}) {
  const explicitMode = mode === 'regime' || mode === 'fixed' ? mode : null;
  const persistedMode = persistedConfig?.mode === 'regime' ? 'regime' :
    persistedConfig?.mode === 'fixed' ? 'fixed' : null;
  const resolvedMode = explicitMode || persistedMode || 'fixed';
  const explicitMarkets = parseMarkets(markets);
  const persistedMarkets = Array.isArray(persistedConfig?.markets)
    ? parseMarkets(persistedConfig.markets.join(','))
    : null;
  const resolvedMarkets = explicitMarkets || persistedMarkets || [...DEFAULT_MOMENTUM_SHADOW_MARKETS];
  const explicitBenchmarkMarket = typeof benchmarkMarket === 'string'
    ? benchmarkMarket.trim() || null
    : null;
  const persistedBenchmarkMarket = typeof persistedConfig?.benchmarkMarket === 'string'
    ? persistedConfig.benchmarkMarket.trim() || null
    : null;
  const resolvedBenchmarkMarket = explicitBenchmarkMarket ?? persistedBenchmarkMarket;
  const explicitBenchmarkTrend = Number.isFinite(Number(benchmarkTrendMinPercent))
    ? Number(benchmarkTrendMinPercent)
    : null;
  const persistedBenchmarkTrend = Number.isFinite(Number(persistedConfig?.benchmarkTrendMinPercent))
    ? Number(persistedConfig.benchmarkTrendMinPercent)
    : null;
  const resolvedBenchmarkTrend = resolvedBenchmarkMarket === null
    ? null
    : explicitBenchmarkTrend ?? persistedBenchmarkTrend ?? 0;
  const explicitRelativeTrend = optionalNonNegative(relativeTrendMinPercent);
  const persistedRelativeTrend = optionalNonNegative(persistedConfig?.relativeTrendMinPercent);
  const explicitBenchmarkExit = typeof exitOnBenchmarkOff === 'boolean'
    ? exitOnBenchmarkOff
    : null;
  const persistedBenchmarkExit = typeof persistedConfig?.exitOnBenchmarkOff === 'boolean'
    ? persistedConfig.exitOnBenchmarkOff
    : false;
  const explicitCooldown = optionalNonNegative(cooldownAfterLossDays);
  const persistedCooldown = optionalNonNegative(persistedConfig?.cooldownAfterLossDays);
  const explicitDrawdown = optionalNonNegative(maxPortfolioDrawdownPercent);
  const persistedDrawdown = optionalNonNegative(persistedConfig?.maxPortfolioDrawdownPercent);
  const explicitEntryGap = optionalNonNegative(maxEntryGapPercent);
  const persistedEntryGap = optionalNonNegative(persistedConfig?.maxEntryGapPercent);
  const explicitDailyCandleAge = optionalNonNegative(maxDailyCandleAgeHours);
  const persistedDailyCandleAge = optionalNonNegative(persistedConfig?.maxDailyCandleAgeHours);
  const explicitSpread = optionalNonNegative(maxSpreadPercent);
  const persistedSpread = optionalNonNegative(persistedConfig?.maxSpreadPercent);
  const explicitRequestInterval = optionalPositive(requestIntervalMs);
  const persistedRequestInterval = optionalPositive(persistedConfig?.requestIntervalMs);
  const explicitMinUpBars = optionalNonNegative(minUpBars);
  const persistedMinUpBars = optionalNonNegative(persistedConfig?.minUpBars);
  const explicitVolatilityLookback = optionalNonNegative(volatilityLookbackDays);
  const persistedVolatilityLookback = optionalNonNegative(persistedConfig?.volatilityLookbackDays);
  const explicitVolatilityTarget = optionalNonNegative(volatilityTargetPercent);
  const persistedVolatilityTarget = optionalNonNegative(persistedConfig?.volatilityTargetPercent);
  const explicitExecutionModel = executionModel === 'candle_close' || executionModel === 'quote_cross'
    ? executionModel
    : null;
  const persistedExecutionModel = persistedConfig?.executionModel === 'candle_close' ||
    persistedConfig?.executionModel === 'quote_cross'
    ? resolveMomentumShadowExecutionModel(persistedConfig.executionModel)
    : null;
  return {
    mode: resolvedMode,
    markets: resolvedMarkets,
    benchmarkMarket: resolvedBenchmarkMarket,
    benchmarkTrendMinPercent: resolvedBenchmarkTrend,
    relativeTrendMinPercent: explicitRelativeTrend ?? persistedRelativeTrend,
    exitOnBenchmarkOff: explicitBenchmarkExit ?? persistedBenchmarkExit,
    cooldownAfterLossDays: explicitCooldown ?? persistedCooldown,
    maxPortfolioDrawdownPercent: explicitDrawdown ?? persistedDrawdown,
    maxEntryGapPercent: explicitEntryGap ?? persistedEntryGap,
    maxDailyCandleAgeHours: explicitDailyCandleAge ?? persistedDailyCandleAge,
    maxSpreadPercent: explicitSpread ?? persistedSpread,
    requestIntervalMs: explicitRequestInterval ?? persistedRequestInterval,
    minUpBars: explicitMinUpBars ?? persistedMinUpBars,
    volatilityLookbackDays: explicitVolatilityLookback ?? persistedVolatilityLookback,
    volatilityTargetPercent: explicitVolatilityTarget ?? persistedVolatilityTarget,
    executionModel: explicitExecutionModel ?? persistedExecutionModel,
    inheritedMode: !explicitMode && Boolean(persistedMode),
    inheritedMarkets: !explicitMarkets && Boolean(persistedMarkets),
    inheritedBenchmark: !explicitBenchmarkMarket && Boolean(persistedBenchmarkMarket)
  };
}
