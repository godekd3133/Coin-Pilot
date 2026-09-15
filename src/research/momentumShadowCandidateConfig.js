const DEFAULT_MARKETS = Object.freeze([
  'KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL', 'KRW-DOGE', 'KRW-ADA',
  'KRW-DOT', 'KRW-LINK', 'KRW-ATOM', 'KRW-NEAR', 'KRW-ETC', 'KRW-SUI'
]);

const DEFAULT_CONFIG = Object.freeze({
  mode: 'regime',
  maxHoldHours: 8760,
  markets: DEFAULT_MARKETS,
  trendMinPercent: 2,
  // Selected by the 800-day continuous robustness sweep's ordinary candidate.
  breadthMin: 2,
  minUpBars: 2,
  positionFraction: 0.125,
  maxPositions: 2,
  costPercent: 0.2,
  benchmarkMarket: 'KRW-BTC',
  benchmarkTrendMinPercent: 2,
  exitOnBenchmarkOff: true,
  cooldownAfterLossDays: 3,
  volatilityLookbackDays: 14,
  volatilityTargetPercent: null,
  entryExecution: 'close',
  // A research-only next-open chase guard; zero preserves the legacy contract.
  maxEntryGapPercent: 0,
  // Completed daily data older than this is not allowed to drive a new cycle.
  maxDailyCandleAgeHours: 36,
  // Optional best-bid/ask quality guard; zero keeps the legacy paper path.
  maxSpreadPercent: 0,
  // Shared-process API budget; keep multiple diagnostic owners below public rate limits.
  requestIntervalMs: 500,
  // Optional runner exit overrides; zero disables them. They are part of the
  // sealed candidate contract so ambient env cannot change a launched book.
  stopLossPercent: 0,
  takeProfitPercent: 0,
  // The historical dd15 replay matched the dd0 result and did not trigger;
  // keep the live shadow candidate protected without calling it alpha proof.
  maxPortfolioDrawdownPercent: 15,
  pollMs: 15 * 60 * 1000
});

function csv(value, fallback) {
  if (typeof value !== 'string') return [...fallback];
  const values = [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))];
  return values.length ? values : [...fallback];
}

function number(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function optionalNumber(value, fallback = null) {
  return value === undefined || value === null || value === ''
    ? fallback
    : number(value, fallback);
}

function optionalPositiveNumber(value, fallback = null) {
  const parsed = optionalNumber(value, fallback);
  return parsed !== null && parsed > 0 ? parsed : null;
}

/**
 * Resolve the one candidate contract shared by preflight, launcher, and the
 * read-only API projection. Explicit environment values are allowed for
 * research experiments; omitted values stay aligned with the selected
 * continuous robustness candidate.
 */
export function resolveMomentumShadowCandidateConfig(env = process.env) {
  const mode = env.MOMO_SHADOW_MODE || DEFAULT_CONFIG.mode;
  const defaultMaxHoldHours = mode === 'fixed' ? 72 : DEFAULT_CONFIG.maxHoldHours;
  return {
    mode,
    maxHoldHours: Math.max(1, number(env.MOMO_SHADOW_MAX_HOLD_HOURS, defaultMaxHoldHours)),
    markets: csv(env.MOMO_SHADOW_MARKETS, DEFAULT_CONFIG.markets),
    trendMinPercent: number(env.MOMO_SHADOW_TREND_MIN_PERCENT, DEFAULT_CONFIG.trendMinPercent),
    breadthMin: number(env.MOMO_SHADOW_BREADTH_MIN, DEFAULT_CONFIG.breadthMin),
    minUpBars: number(env.MOMO_SHADOW_MIN_UP_BARS, DEFAULT_CONFIG.minUpBars),
    positionFraction: number(env.MOMO_SHADOW_POSITION_FRACTION, DEFAULT_CONFIG.positionFraction),
    maxPositions: number(env.MOMO_SHADOW_MAX_POSITIONS, DEFAULT_CONFIG.maxPositions),
    costPercent: Math.max(0, number(env.MOMO_SHADOW_COST_PERCENT, DEFAULT_CONFIG.costPercent)),
    benchmarkMarket: env.MOMO_SHADOW_BENCHMARK_MARKET || DEFAULT_CONFIG.benchmarkMarket,
    benchmarkTrendMinPercent: number(
      env.MOMO_SHADOW_BENCHMARK_TREND_MIN_PERCENT,
      DEFAULT_CONFIG.benchmarkTrendMinPercent
    ),
    exitOnBenchmarkOff: env.MOMO_SHADOW_EXIT_ON_BENCHMARK_OFF !== 'false',
    cooldownAfterLossDays: number(
      env.MOMO_SHADOW_COOLDOWN_AFTER_LOSS_DAYS,
      DEFAULT_CONFIG.cooldownAfterLossDays
    ),
    volatilityLookbackDays: Math.max(2, Math.floor(number(
      env.MOMO_SHADOW_VOLATILITY_LOOKBACK_DAYS,
      DEFAULT_CONFIG.volatilityLookbackDays
    ))),
    volatilityTargetPercent: optionalPositiveNumber(
      env.MOMO_SHADOW_VOLATILITY_TARGET_PERCENT,
      DEFAULT_CONFIG.volatilityTargetPercent
    ),
    entryExecution: env.MOMO_SHADOW_ENTRY_EXECUTION === 'next_open' ? 'next_open' : 'close',
    maxEntryGapPercent: Math.max(0, number(
      env.MOMO_SHADOW_MAX_ENTRY_GAP_PERCENT,
      DEFAULT_CONFIG.maxEntryGapPercent
    )),
    maxDailyCandleAgeHours: Math.max(0, number(
      env.MOMO_SHADOW_MAX_DAILY_CANDLE_AGE_HOURS,
      DEFAULT_CONFIG.maxDailyCandleAgeHours
    )),
    maxSpreadPercent: Math.max(0, number(
      env.MOMO_SHADOW_MAX_SPREAD_PERCENT,
      DEFAULT_CONFIG.maxSpreadPercent
    )),
    requestIntervalMs: Math.max(100, number(
      env.MOMO_SHADOW_REQUEST_INTERVAL_MS,
      DEFAULT_CONFIG.requestIntervalMs
    )),
    stopLossPercent: Math.max(0, number(
      env.MOMO_SHADOW_STOP_LOSS_PERCENT,
      DEFAULT_CONFIG.stopLossPercent
    )),
    takeProfitPercent: Math.max(0, number(
      env.MOMO_SHADOW_TAKE_PROFIT_PERCENT,
      DEFAULT_CONFIG.takeProfitPercent
    )),
    maxPortfolioDrawdownPercent: number(
      env.MOMO_SHADOW_MAX_PORTFOLIO_DRAWDOWN_PERCENT,
      DEFAULT_CONFIG.maxPortfolioDrawdownPercent
    ),
    pollMs: number(env.MOMO_SHADOW_POLL_MS, DEFAULT_CONFIG.pollMs)
  };
}

export { DEFAULT_CONFIG as DEFAULT_MOMENTUM_SHADOW_CANDIDATE_CONFIG };
