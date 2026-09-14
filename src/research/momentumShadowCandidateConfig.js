const DEFAULT_MARKETS = Object.freeze([
  'KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL', 'KRW-DOGE', 'KRW-ADA',
  'KRW-DOT', 'KRW-LINK', 'KRW-ATOM', 'KRW-NEAR', 'KRW-ETC', 'KRW-SUI'
]);

const DEFAULT_CONFIG = Object.freeze({
  mode: 'regime',
  markets: DEFAULT_MARKETS,
  trendMinPercent: 2,
  // Selected by the 800-day continuous robustness sweep's ordinary candidate.
  breadthMin: 2,
  minUpBars: 2,
  positionFraction: 0.125,
  maxPositions: 2,
  benchmarkMarket: 'KRW-BTC',
  benchmarkTrendMinPercent: 2,
  exitOnBenchmarkOff: true,
  cooldownAfterLossDays: 3,
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

/**
 * Resolve the one candidate contract shared by preflight, launcher, and the
 * read-only API projection. Explicit environment values are allowed for
 * research experiments; omitted values stay aligned with the selected
 * continuous robustness candidate.
 */
export function resolveMomentumShadowCandidateConfig(env = process.env) {
  return {
    mode: env.MOMO_SHADOW_MODE || DEFAULT_CONFIG.mode,
    markets: csv(env.MOMO_SHADOW_MARKETS, DEFAULT_CONFIG.markets),
    trendMinPercent: number(env.MOMO_SHADOW_TREND_MIN_PERCENT, DEFAULT_CONFIG.trendMinPercent),
    breadthMin: number(env.MOMO_SHADOW_BREADTH_MIN, DEFAULT_CONFIG.breadthMin),
    minUpBars: number(env.MOMO_SHADOW_MIN_UP_BARS, DEFAULT_CONFIG.minUpBars),
    positionFraction: number(env.MOMO_SHADOW_POSITION_FRACTION, DEFAULT_CONFIG.positionFraction),
    maxPositions: number(env.MOMO_SHADOW_MAX_POSITIONS, DEFAULT_CONFIG.maxPositions),
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
    maxPortfolioDrawdownPercent: number(
      env.MOMO_SHADOW_MAX_PORTFOLIO_DRAWDOWN_PERCENT,
      DEFAULT_CONFIG.maxPortfolioDrawdownPercent
    ),
    pollMs: number(env.MOMO_SHADOW_POLL_MS, DEFAULT_CONFIG.pollMs)
  };
}

export { DEFAULT_CONFIG as DEFAULT_MOMENTUM_SHADOW_CANDIDATE_CONFIG };
