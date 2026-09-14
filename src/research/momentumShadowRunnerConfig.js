export const DEFAULT_MOMENTUM_SHADOW_MARKETS = Object.freeze([
  'KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL'
]);

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
  exitOnBenchmarkOff,
  minUpBars,
  cooldownAfterLossDays,
  maxPortfolioDrawdownPercent,
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
  const explicitMinUpBars = optionalNonNegative(minUpBars);
  const persistedMinUpBars = optionalNonNegative(persistedConfig?.minUpBars);
  return {
    mode: resolvedMode,
    markets: resolvedMarkets,
    benchmarkMarket: resolvedBenchmarkMarket,
    benchmarkTrendMinPercent: resolvedBenchmarkTrend,
    exitOnBenchmarkOff: explicitBenchmarkExit ?? persistedBenchmarkExit,
    cooldownAfterLossDays: explicitCooldown ?? persistedCooldown,
    maxPortfolioDrawdownPercent: explicitDrawdown ?? persistedDrawdown,
    minUpBars: explicitMinUpBars ?? persistedMinUpBars,
    inheritedMode: !explicitMode && Boolean(persistedMode),
    inheritedMarkets: !explicitMarkets && Boolean(persistedMarkets),
    inheritedBenchmark: !explicitBenchmarkMarket && Boolean(persistedBenchmarkMarket)
  };
}
