import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDailyMomentumRobustnessVariants,
  evaluateDailyMomentumRobustness
} from '../src/research/dailyMomentumRobustnessStudy.js';

function daily(prices, start = '2026-01-01T00:00:00.000Z') {
  const first = Date.parse(start);
  return prices.map((price, index) => ({
    candle_date_time_utc: new Date(first + index * 86_400_000).toISOString(),
    opening_price: price,
    high_price: price,
    low_price: price,
    trade_price: price,
    candle_acc_trade_volume: 1
  }));
}

test('robustness grid expands risk controls without changing the live contract', () => {
  const variants = buildDailyMomentumRobustnessVariants({
    trendMinPercent: [2],
    breadthMin: [3],
    positionFraction: [0.125],
    maxPositions: [2],
    cooldownAfterLossDays: [3],
    maxPortfolioDrawdownPercent: [10]
  });

  assert.equal(variants.length, 1);
  assert.equal(variants[0].config.trendMinPercent, 2);
  assert.equal(variants[0].config.positionFraction, 0.125);
  assert.equal(variants[0].config.maxPositions, 2);
  assert.equal(variants[0].config.cooldownAfterLossDays, 3);
  assert.equal(variants[0].config.maxPortfolioDrawdownPercent, 10);
  assert.equal(variants[0].config.benchmarkMarket, 'KRW-BTC');
  assert.equal(variants[0].config.benchmarkTrendMinPercent, 2);
  assert.equal(variants[0].config.minUpBars, 1);
  assert.equal(variants[0].config.benchmarkExitConfirmationBars, 1);
  assert.equal(variants[0].config.regimeExitConfirmationBars, 1);
  assert.equal(variants[0].config.relativeTrendMinPercent, null);
  assert.equal(variants[0].config.stopLossPercent, 0);
});

test('robustness grid can explicitly compare fixed exit modes and hold windows', () => {
  const variants = buildDailyMomentumRobustnessVariants({
    mode: ['fixed'],
    maxHoldDays: [1],
    trendMinPercent: [2],
    breadthMin: [3],
    positionFraction: [0.125],
    maxPositions: [2],
    cooldownAfterLossDays: [3],
    maxPortfolioDrawdownPercent: [15]
  });

  assert.equal(variants.length, 1);
  assert.equal(variants[0].name, 'fixed_h1_g2_u1_t2_b3_f0p125_p2_c3_dd15');
  assert.equal(variants[0].config.mode, 'fixed');
  assert.equal(variants[0].config.maxHoldDays, 1);
});

test('robustness grid names non-default exit confirmation candidates without changing baseline names', () => {
  const variants = buildDailyMomentumRobustnessVariants({
    trendMinPercent: [2],
    breadthMin: [2],
    positionFraction: [0.125],
    maxPositions: [2],
    cooldownAfterLossDays: [3],
    maxPortfolioDrawdownPercent: [0],
    benchmarkTrendMinPercent: [2],
    minUpBars: [2],
    benchmarkExitConfirmationBars: [1, 2],
    regimeExitConfirmationBars: [1, 2],
    relativeTrendMinPercent: [null, 1]
  });

  assert.equal(variants.length, 8);
  assert.equal(variants[0].name, 'regime_g2_u2_t2_b2_f0p125_p2_c3_dd0');
  assert.equal(variants[0].config.benchmarkExitConfirmationBars, 1);
  assert.equal(variants[0].config.regimeExitConfirmationBars, 1);
  assert.equal(variants[1].name, 'regime_g2_u2_t2_b2_f0p125_p2_c3_dd0_rel1');
  assert.equal(variants[1].config.relativeTrendMinPercent, 1);
  assert.equal(variants[6].name, 'regime_g2_u2_t2_b2_f0p125_p2_c3_dd0_bx2_rx2');
  assert.equal(variants[6].config.benchmarkExitConfirmationBars, 2);
  assert.equal(variants[6].config.regimeExitConfirmationBars, 2);
  assert.equal(variants[7].name, 'regime_g2_u2_t2_b2_f0p125_p2_c3_dd0_bx2_rx2_rel1');
});

test('robustness grid names volatility-target candidates and preserves the disabled baseline', () => {
  const variants = buildDailyMomentumRobustnessVariants({
    trendMinPercent: [2],
    breadthMin: [2],
    positionFraction: [0.125],
    maxPositions: [2],
    cooldownAfterLossDays: [3],
    maxPortfolioDrawdownPercent: [0],
    benchmarkTrendMinPercent: [2],
    minUpBars: [2],
    benchmarkExitConfirmationBars: [1],
    regimeExitConfirmationBars: [1],
    relativeTrendMinPercent: [null],
    volatilityLookbackDays: [7],
    volatilityTargetPercent: [1]
  });

  assert.equal(variants.length, 1);
  assert.equal(variants[0].name, 'regime_g2_u2_t2_b2_f0p125_p2_c3_dd0_vol1_vlb7');
  assert.equal(variants[0].config.volatilityLookbackDays, 7);
  assert.equal(variants[0].config.volatilityTargetPercent, 1);
});

test('robustness grid names next-open gap-ceiling candidates', () => {
  const variants = buildDailyMomentumRobustnessVariants({
    trendMinPercent: [2],
    breadthMin: [3],
    positionFraction: [0.125],
    maxPositions: [2],
    cooldownAfterLossDays: [3],
    maxPortfolioDrawdownPercent: [15],
    benchmarkTrendMinPercent: [1],
    minUpBars: [2],
    benchmarkExitConfirmationBars: [1],
    regimeExitConfirmationBars: [1],
    relativeTrendMinPercent: [null],
    volatilityLookbackDays: [14],
    volatilityTargetPercent: [1],
    stopLossPercent: [0],
    maxEntryGapPercent: [0.2]
  }, { costPercent: 0.3, entryExecution: 'next_open' });

  assert.equal(variants.length, 1);
  assert.equal(variants[0].name, 'regime_g1_u2_t2_b3_f0p125_p2_c3_dd15_vol1_vlb14_gap0p2');
  assert.equal(variants[0].config.maxEntryGapPercent, 0.2);
  assert.equal(variants[0].config.entryExecution, 'next_open');
});

test('robustness generated variants retain execution-boundary base config', () => {
  const candles = {
    'KRW-BTC': daily([100, 101, 102, 103, 104, 105]),
    'KRW-ETH': daily([100, 101, 102, 103, 104, 105])
  };
  const report = evaluateDailyMomentumRobustness(candles, {
    baseConfig: { entryExecution: 'next_open' },
    grid: {
      trendMinPercent: [2],
      breadthMin: [2],
      positionFraction: [0.125],
      maxPositions: [2],
      cooldownAfterLossDays: [3],
      maxPortfolioDrawdownPercent: [0],
      benchmarkTrendMinPercent: [2],
      minUpBars: [1],
      benchmarkExitConfirmationBars: [1],
      regimeExitConfirmationBars: [1],
      relativeTrendMinPercent: [null],
      volatilityLookbackDays: [14],
      volatilityTargetPercent: [null],
      stopLossPercent: [0]
    },
    minimumFullReturnPercent: -100,
    maximumDrawdownPercent: 100,
    minimumWorstSegmentReturnPercent: -100,
    minimumTradeCount: 1
  });

  assert.equal(report.variants.length, 1);
  assert.equal(report.variants[0].config.entryExecution, 'next_open');
});

test('robustness report keeps historical eligibility separate from promotion', () => {
  const candles = {
    'KRW-BTC': daily([100, 101, 102, 99, 100, 99, 100, 101, 102, 99, 100, 99]),
    'KRW-ETH': daily([100, 101, 102, 99, 100, 99, 100, 101, 102, 99, 100, 99])
  };
  const report = evaluateDailyMomentumRobustness(candles, {
    segmentCount: 2,
    variants: [{
      name: 'test-risk-envelope',
      config: {
        mode: 'fixed',
        trendLookbackDays: 2,
        trendMinPercent: 0,
        breadthMin: 2,
        maxHoldDays: 1,
        positionFraction: 0.25,
        maxPositions: 1,
        benchmarkMarket: null,
        exitOnBenchmarkOff: false
      }
    }],
    minimumFullReturnPercent: -100,
    maximumDrawdownPercent: 100,
    minimumWorstSegmentReturnPercent: -100,
    minimumTradeCount: 1
  });

  assert.equal(report.study, 'daily_momentum_robustness_grid');
  assert.equal(report.researchOnly, true);
  assert.equal(report.promoted, false);
  assert.equal(report.variants.length, 1);
  assert.equal(report.variants[0].name, 'test-risk-envelope');
  assert.equal(report.variants[0].status, 'SHADOW_CANDIDATE');
  assert.deepEqual(report.variants[0].eligibilityBlockers, []);
  assert.equal(report.variants[0].drawdownStopTriggered, false);
  assert.deepEqual(report.variants[0].riskFlags, []);
  assert.equal(report.shortlist.length, 1);
  assert.equal(report.nearMisses.length, 0);
  assert.equal(report.shadowCandidateCount, 1);
  assert.match(report.promotionReason, /research_only/);
});

test('continuous robustness segments carry internal positions and only flag the real final boundary', () => {
  const candles = {
    'KRW-BTC': daily([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111]),
    'KRW-ETH': daily([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111])
  };
  const variant = {
    name: 'continuous-boundary-test',
    config: {
      mode: 'regime',
      trendLookbackDays: 2,
      trendMinPercent: 0,
      breadthMin: 2,
      maxHoldDays: 3650,
      positionFraction: 0.25,
      maxPositions: 1,
      benchmarkMarket: null,
      exitOnBenchmarkOff: false
    }
  };
  const report = evaluateDailyMomentumRobustness(candles, {
    segmentCount: 3,
    variants: [variant],
    minimumFullReturnPercent: -100,
    maximumDrawdownPercent: 100,
    minimumWorstSegmentReturnPercent: -100,
    minimumTradeCount: 1
  });

  assert.equal(report.segmentMode, 'continuous');
  assert.equal(report.variants[0].segments.length, 3);
  assert.equal(report.variants[0].segments[0].unknownBoundaryPositionCount, 0);
  assert.equal(report.variants[0].segments[1].unknownBoundaryPositionCount, 0);
  assert.equal(report.variants[0].segments[2].unknownBoundaryPositionCount, 1);
  assert.ok(report.variants[0].eligibilityBlockers.includes('unknown_boundary_position'));
  assert.equal(report.promoted, false);
});
