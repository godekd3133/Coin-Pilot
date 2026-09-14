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
