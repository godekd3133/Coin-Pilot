import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DAILY_MOMENTUM_CONFIG,
  simulateDailyMomentumPortfolio,
  evaluateDailyMomentumVariants
} from '../src/research/dailyMomentumStudy.js';

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

test('daily momentum portfolio applies breadth, cost, and fixed-hold exits without lookahead', () => {
  const result = simulateDailyMomentumPortfolio({
    'KRW-BTC': daily([100, 101, 102, 103, 102]),
    'KRW-ETH': daily([100, 101, 102, 103, 102])
  }, {
    ...DEFAULT_DAILY_MOMENTUM_CONFIG,
    initialBalance: 1_000,
    trendLookbackDays: 2,
    maxHoldDays: 2,
    positionFraction: 0.5,
    breadthMin: 2,
    maxPositions: 1,
    mode: 'fixed'
  });

  assert.equal(result.available, true);
  assert.equal(result.entryCount, 1);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].entryPrice, 102);
  assert.equal(result.trades[0].exitPrice, 102);
  assert.ok(Math.abs(result.trades[0].profitPercent + 0.2) < 1e-12);
  assert.ok(Math.abs(result.finalEquity - 999) < 1e-12);
  assert.equal(result.unknownBoundaryPositionCount, 0);
  assert.equal(result.dataQuality.valid, true);
});

test('daily momentum regime mode exits when the trailing trend turns off', () => {
  const result = simulateDailyMomentumPortfolio({
    'KRW-BTC': daily([100, 101, 102, 103, 100]),
    'KRW-ETH': daily([100, 101, 102, 103, 100])
  }, {
    ...DEFAULT_DAILY_MOMENTUM_CONFIG,
    initialBalance: 1_000,
    trendLookbackDays: 2,
    positionFraction: 0.5,
    breadthMin: 2,
    maxPositions: 1,
    mode: 'regime',
    trendMinPercent: 0
  });

  assert.equal(result.available, true);
  assert.equal(result.entryCount, 1);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].exit, 'REGIME_OFF');
  assert.ok(result.trades[0].profitPercent < 0);
  assert.equal(result.unknownBoundaryPositionCount, 0);
});

test('daily momentum realized P&L excludes capital in an open boundary position', () => {
  const result = simulateDailyMomentumPortfolio({
    'KRW-BTC': daily([100, 101, 102, 104, 106]),
    'KRW-ETH': daily([100, 101, 102, 104, 106])
  }, {
    ...DEFAULT_DAILY_MOMENTUM_CONFIG,
    initialBalance: 1_000,
    trendLookbackDays: 2,
    maxHoldDays: 3650,
    positionFraction: 0.5,
    breadthMin: 2,
    maxPositions: 1,
    mode: 'fixed'
  });

  assert.equal(result.trades.length, 0);
  assert.equal(result.unknownBoundaryPositionCount, 1);
  assert.equal(result.metrics.realizedProfit, 0);
  assert.ok(result.metrics.finalEquity > result.metrics.initialBalance);
});

test('daily momentum optional two-bar confirmation and loss cooldown reduce repeat entries', () => {
  const candles = {
    'KRW-BTC': daily([100, 101, 102, 99, 103, 104]),
    'KRW-ETH': daily([100, 101, 102, 99, 103, 104])
  };
  const base = {
    ...DEFAULT_DAILY_MOMENTUM_CONFIG,
    initialBalance: 1_000,
    trendLookbackDays: 2,
    maxHoldDays: 1,
    positionFraction: 0.5,
    breadthMin: 2,
    maxPositions: 1,
    mode: 'fixed'
  };
  const noCooldown = simulateDailyMomentumPortfolio(candles, base);
  const protectedResult = simulateDailyMomentumPortfolio(candles, {
    ...base,
    minUpBars: 2,
    cooldownAfterLossDays: 3
  });

  assert.equal(noCooldown.entryCount, 3);
  assert.equal(protectedResult.entryCount, 2);
  assert.equal(protectedResult.trades.length, 1);
  assert.equal(protectedResult.config.minUpBars, 2);
  assert.equal(protectedResult.config.cooldownAfterLossDays, 3);
});

test('daily momentum benchmark gate blocks alt entries when BTC trend is off', () => {
  const candles = {
    'KRW-BTC': daily([100, 99, 98, 97, 96]),
    'KRW-ETH': daily([100, 101, 102, 103, 104])
  };
  const base = {
    ...DEFAULT_DAILY_MOMENTUM_CONFIG,
    initialBalance: 1_000,
    trendLookbackDays: 2,
    positionFraction: 0.5,
    breadthMin: 1,
    maxPositions: 1,
    mode: 'fixed'
  };
  const unguarded = simulateDailyMomentumPortfolio(candles, base);
  const guarded = simulateDailyMomentumPortfolio(candles, {
    ...base,
    benchmarkMarket: 'KRW-BTC',
    benchmarkTrendMinPercent: 0
  });

  assert.equal(unguarded.entryCount, 1);
  assert.equal(guarded.entryCount, 0);
  assert.equal(guarded.config.benchmarkMarket, 'KRW-BTC');
});

test('daily momentum optional benchmark exit closes a regime position on benchmark failure', () => {
  const result = simulateDailyMomentumPortfolio({
    'KRW-BTC': daily([100, 101, 102, 101, 100]),
    'KRW-ETH': daily([100, 101, 102, 103, 104])
  }, {
    ...DEFAULT_DAILY_MOMENTUM_CONFIG,
    initialBalance: 1_000,
    trendLookbackDays: 2,
    breadthMin: 1,
    maxPositions: 1,
    mode: 'regime',
    benchmarkMarket: 'KRW-BTC',
    benchmarkTrendMinPercent: 0,
    exitOnBenchmarkOff: true
  });

  assert.equal(result.entryCount, 1);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].exit, 'BENCHMARK_OFF');
});

test('daily momentum benchmark exposure scaling reduces position size without changing the default contract', () => {
  const candles = {
    'KRW-BTC': daily([100, 99, 98, 97, 96]),
    'KRW-ETH': daily([100, 101, 102, 103, 104])
  };
  const base = {
    ...DEFAULT_DAILY_MOMENTUM_CONFIG,
    initialBalance: 1_000,
    trendLookbackDays: 2,
    positionFraction: 0.5,
    breadthMin: 1,
    maxPositions: 1,
    mode: 'fixed',
    maxHoldDays: 3650
  };
  const normal = simulateDailyMomentumPortfolio(candles, base);
  const scaled = simulateDailyMomentumPortfolio(candles, {
    ...base,
    benchmarkMarket: 'KRW-BTC',
    benchmarkTrendMinPercent: -100,
    benchmarkExposureMinPercent: -5,
    benchmarkExposureMaxPercent: 5
  });

  assert.equal(normal.entryCount, 1);
  assert.equal(scaled.entryCount, 1);
  assert.ok(scaled.openPositions[0].size < normal.openPositions[0].size);
  assert.equal(scaled.config.benchmarkExposureMinPercent, -5);
});

test('daily momentum portfolio drawdown stop closes positions and disables later entries', () => {
  const result = simulateDailyMomentumPortfolio({
    'KRW-BTC': daily([100, 101, 102, 80, 81, 82]),
    'KRW-ETH': daily([100, 101, 102, 80, 81, 82])
  }, {
    ...DEFAULT_DAILY_MOMENTUM_CONFIG,
    initialBalance: 1_000,
    trendLookbackDays: 2,
    maxHoldDays: 3650,
    positionFraction: 0.9,
    breadthMin: 2,
    maxPositions: 1,
    mode: 'fixed',
    maxPortfolioDrawdownPercent: 10
  });

  assert.equal(result.drawdownStopTriggered, true);
  assert.equal(result.trades[0].exit, 'PORTFOLIO_DRAWDOWN_STOP');
  assert.equal(result.openPositions.length, 0);
  assert.equal(result.entryCount, 1);
});

test('daily momentum study fails closed on a missing daily candle', () => {
  const btc = daily([100, 101, 102, 103, 104]);
  const eth = daily([100, 101, 102, 103, 104]);
  eth.splice(2, 1);
  eth[2].candle_date_time_utc = '2026-01-04T00:00:00.000Z';
  const result = simulateDailyMomentumPortfolio({ 'KRW-BTC': btc, 'KRW-ETH': eth }, {
    ...DEFAULT_DAILY_MOMENTUM_CONFIG,
    trendLookbackDays: 2
  });

  assert.equal(result.available, false);
  assert.equal(result.dataQuality.valid, false);
  assert.equal(result.dataQuality.reason, 'daily_candle_grid_not_contiguous');
  assert.equal(result.entryCount, 0);
});

test('daily momentum excludes an unfinished UTC candle even without a timezone suffix', () => {
  const raw = daily([100, 101, 102, 103, 104]).map(candle => ({
    ...candle,
    candle_date_time_utc: candle.candle_date_time_utc.slice(0, 19)
  }));
  const result = simulateDailyMomentumPortfolio({
    'KRW-BTC': raw,
    'KRW-ETH': raw
  }, {
    ...DEFAULT_DAILY_MOMENTUM_CONFIG,
    asOf: '2026-01-05T12:00:00.000Z',
    trendLookbackDays: 2
  });

  assert.equal(result.available, true);
  assert.equal(result.dataQuality.candleCount, 4);
  assert.equal(result.dataQuality.lastTimestamp, '2026-01-04T00:00:00.000Z');
});

test('daily momentum variant evaluation keeps every candidate research-only', () => {
  const candles = {
    'KRW-BTC': daily([100, 101, 102, 103, 104, 105, 106, 107]),
    'KRW-ETH': daily([100, 101, 102, 103, 104, 105, 106, 107])
  };
  const report = evaluateDailyMomentumVariants(candles, {
    variants: [{ name: 'fixture', config: { trendLookbackDays: 2, breadthMin: 2 } }],
    segmentCount: 2
  });

  assert.equal(report.researchOnly, true);
  assert.equal(report.promoted, false);
  assert.equal(report.variants.length, 1);
  assert.equal(report.variants[0].promoted, false);
  assert.equal(report.variants[0].segments.length, 2);
});
