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

function dailyWithOpens(prices, opens, start = '2026-01-01T00:00:00.000Z') {
  const first = Date.parse(start);
  return prices.map((price, index) => ({
    candle_date_time_utc: new Date(first + index * 86_400_000).toISOString(),
    opening_price: opens[index],
    high_price: Math.max(price, opens[index]),
    low_price: Math.min(price, opens[index]),
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

test('daily momentum next-open entry execution uses the following candle open', () => {
  const candles = {
    'KRW-BTC': dailyWithOpens([100, 101, 102, 103], [100, 101, 102, 110]),
    'KRW-ETH': dailyWithOpens([100, 101, 102, 103], [100, 101, 102, 110])
  };
  const base = {
    ...DEFAULT_DAILY_MOMENTUM_CONFIG,
    initialBalance: 1_000,
    trendLookbackDays: 2,
    positionFraction: 0.5,
    breadthMin: 2,
    maxPositions: 1,
    mode: 'fixed',
    maxHoldDays: 3650
  };

  const closeFilled = simulateDailyMomentumPortfolio(candles, base);
  const nextOpenFilled = simulateDailyMomentumPortfolio(candles, {
    ...base,
    entryExecution: 'next_open'
  });

  assert.equal(closeFilled.config.entryExecution, 'close');
  assert.equal(closeFilled.openPositions[0].entryPrice, 102);
  assert.equal(nextOpenFilled.config.entryExecution, 'next_open');
  assert.equal(nextOpenFilled.openPositions[0].entryPrice, 110);
  assert.equal(nextOpenFilled.openPositions[0].entryTimestamp, '2026-01-04T00:00:00.000Z');
  assert.equal(nextOpenFilled.unknownBoundaryEntryCount, 0);
});

test('daily momentum next-open fixed hold counts from entry open to completed close', () => {
  const candles = {
    'KRW-BTC': dailyWithOpens([100, 101, 102, 103, 104], [100, 101, 102, 102, 104]),
    'KRW-ETH': dailyWithOpens([100, 101, 102, 103, 104], [100, 101, 102, 102, 104])
  };
  const result = simulateDailyMomentumPortfolio(candles, {
    ...DEFAULT_DAILY_MOMENTUM_CONFIG,
    initialBalance: 1_000,
    entryExecution: 'next_open',
    trendLookbackDays: 2,
    trendMinPercent: 0,
    breadthMin: 2,
    maxPositions: 1,
    mode: 'fixed',
    maxHoldDays: 1,
    costPercent: 0
  });

  assert.equal(result.trades[0].entryTimestamp, '2026-01-04T00:00:00.000Z');
  assert.equal(result.trades[0].entryPrice, 102);
  assert.equal(result.trades[0].exitTimestamp, '2026-01-04T00:00:00.000Z');
  assert.equal(result.trades[0].exitPrice, 103);
  assert.equal(result.trades[0].heldDays, 1);
});

test('daily momentum close entry with next-open exit counts held days semantically', () => {
  const result = simulateDailyMomentumPortfolio({
    'KRW-BTC': dailyWithOpens([100, 101, 102, 103, 104], [100, 101, 102, 103, 104]),
    'KRW-ETH': dailyWithOpens([100, 101, 102, 103, 104], [100, 101, 102, 103, 104])
  }, {
    ...DEFAULT_DAILY_MOMENTUM_CONFIG,
    initialBalance: 1_000,
    trendLookbackDays: 2,
    trendMinPercent: 0,
    maxHoldDays: 1,
    positionFraction: 0.5,
    breadthMin: 2,
    maxPositions: 1,
    mode: 'fixed',
    exitExecution: 'next_open',
    costPercent: 0
  });

  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].entryPrice, 102);
  assert.equal(result.trades[0].exitPrice, 104);
  // Entry at the index-2 close (Jan4 00:00) to the index-4 open (Jan5 00:00)
  // is one day; the candle-open timestamps are two days apart.
  assert.equal(result.trades[0].heldDays, 1);
});

test('daily momentum next-open gap ceiling blocks adverse chase entries', () => {
  const candles = {
    'KRW-BTC': dailyWithOpens([100, 101, 102, 99], [100, 101, 102, 110]),
    'KRW-ETH': dailyWithOpens([100, 101, 102, 99], [100, 101, 102, 110])
  };
  const result = simulateDailyMomentumPortfolio(candles, {
    ...DEFAULT_DAILY_MOMENTUM_CONFIG,
    entryExecution: 'next_open',
    maxEntryGapPercent: 5,
    trendLookbackDays: 2,
    trendMinPercent: 0,
    breadthMin: 2,
    maxPositions: 1,
    mode: 'fixed',
    maxHoldDays: 3650
  });

  assert.equal(result.config.maxEntryGapPercent, 5);
  assert.equal(result.entryGapBlockedCount, 1);
  assert.equal(result.trades.length, 0);
  assert.equal(result.openPositions.length, 0);
  assert.equal(result.unknownBoundaryEntryCount, 0);
});

test('daily momentum next-open execution fails closed when the following open is unavailable', () => {
  const btc = dailyWithOpens([100, 101, 102, 103], [100, 101, 102, 110]);
  const eth = dailyWithOpens([100, 101, 102, 103], [100, 101, 102, 110]);
  delete eth[2].opening_price;

  const result = simulateDailyMomentumPortfolio({
    'KRW-BTC': btc,
    'KRW-ETH': eth
  }, {
    ...DEFAULT_DAILY_MOMENTUM_CONFIG,
    entryExecution: 'next_open',
    trendLookbackDays: 2,
    breadthMin: 2
  });

  assert.equal(result.available, false);
  assert.equal(result.dataQuality.reason, 'daily_entry_open_price_missing');
  assert.deepEqual(result.dataQuality.missingOpeningPriceMarkets, ['KRW-ETH']);
  assert.equal(result.unknownBoundaryEntryCount, 0);
});

test('daily momentum next-open execution reports an unfilled final signal as boundary evidence', () => {
  const candles = {
    'KRW-BTC': dailyWithOpens([100, 101, 99, 104], [100, 101, 99, 104]),
    'KRW-ETH': dailyWithOpens([100, 101, 99, 104], [100, 101, 99, 104])
  };
  const result = simulateDailyMomentumPortfolio(candles, {
    ...DEFAULT_DAILY_MOMENTUM_CONFIG,
    entryExecution: 'next_open',
    trendLookbackDays: 2,
    breadthMin: 2,
    maxPositions: 1
  });

  assert.equal(result.available, true);
  assert.equal(result.trades.length, 0);
  assert.equal(result.openPositions.length, 0);
  assert.equal(result.unknownBoundaryEntryCount, 1);
  assert.equal(result.unknownBoundaryEntries[0].reason, 'entry_after_study_boundary');
});

test('daily momentum next-open exit execution fills at the following candle open', () => {
  const candles = {
    'KRW-BTC': dailyWithOpens([100, 101, 102, 103, 100, 99], [100, 101, 102, 103, 100, 90]),
    'KRW-ETH': dailyWithOpens([100, 101, 102, 103, 100, 99], [100, 101, 102, 103, 100, 90])
  };
  const result = simulateDailyMomentumPortfolio(candles, {
    ...DEFAULT_DAILY_MOMENTUM_CONFIG,
    entryExecution: 'close',
    exitExecution: 'next_open',
    trendLookbackDays: 2,
    trendMinPercent: 0,
    breadthMin: 2,
    maxPositions: 1,
    mode: 'regime',
    maxHoldDays: 3650
  });

  assert.equal(result.config.exitExecution, 'next_open');
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].exit, 'REGIME_OFF');
  assert.equal(result.trades[0].exitPrice, 90);
  assert.equal(result.trades[0].exitTimestamp, '2026-01-06T00:00:00.000Z');
  assert.equal(result.unknownBoundaryExitCount, 0);
});

test('daily momentum next-open exit execution reports a final unresolved exit boundary', () => {
  const candles = {
    'KRW-BTC': dailyWithOpens([100, 101, 102, 103, 100], [100, 101, 102, 103, 100]),
    'KRW-ETH': dailyWithOpens([100, 101, 102, 103, 100], [100, 101, 102, 103, 100])
  };
  const result = simulateDailyMomentumPortfolio(candles, {
    ...DEFAULT_DAILY_MOMENTUM_CONFIG,
    exitExecution: 'next_open',
    trendLookbackDays: 2,
    trendMinPercent: 0,
    breadthMin: 2,
    maxPositions: 1,
    mode: 'regime',
    maxHoldDays: 3650
  });

  assert.equal(result.trades.length, 0);
  assert.equal(result.unknownBoundaryExitCount, 1);
  assert.equal(result.unknownBoundaryExits[0].reason, 'exit_after_study_boundary');
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

test('daily momentum benchmark confirmation bars delay the first gate entry without changing the default', () => {
  const candles = {
    'KRW-BTC': daily([100, 101, 102, 103, 104, 105]),
    'KRW-ETH': daily([100, 102, 104, 106, 108, 110])
  };
  const base = {
    ...DEFAULT_DAILY_MOMENTUM_CONFIG,
    initialBalance: 1_000,
    trendLookbackDays: 2,
    positionFraction: 0.5,
    breadthMin: 1,
    maxPositions: 1,
    mode: 'fixed',
    maxHoldDays: 3650,
    benchmarkMarket: 'KRW-BTC',
    benchmarkTrendMinPercent: 0
  };
  const defaultResult = simulateDailyMomentumPortfolio(candles, base);
  const confirmedResult = simulateDailyMomentumPortfolio(candles, {
    ...base,
    benchmarkMinUpBars: 2
  });

  assert.equal(defaultResult.config.benchmarkMinUpBars, 1);
  assert.equal(defaultResult.openPositions[0].entryTimestamp, '2026-01-03T00:00:00.000Z');
  assert.equal(confirmedResult.config.benchmarkMinUpBars, 2);
  assert.equal(confirmedResult.openPositions[0].entryTimestamp, '2026-01-04T00:00:00.000Z');
});

test('daily momentum can keep the benchmark as a gate-only market for research', () => {
  const candles = {
    'KRW-BTC': daily([100, 101, 102, 103, 104]),
    'KRW-ETH': daily([100, 100, 100, 100, 100])
  };
  const base = {
    ...DEFAULT_DAILY_MOMENTUM_CONFIG,
    initialBalance: 1_000,
    trendLookbackDays: 2,
    positionFraction: 0.5,
    breadthMin: 1,
    maxPositions: 1,
    mode: 'fixed',
    maxHoldDays: 3650,
    benchmarkMarket: 'KRW-BTC',
    benchmarkTrendMinPercent: 0
  };
  const baseline = simulateDailyMomentumPortfolio(candles, base);
  const gateOnly = simulateDailyMomentumPortfolio(candles, {
    ...base,
    excludeBenchmarkFromEntries: true
  });

  assert.equal(baseline.openPositions[0].market, 'KRW-BTC');
  assert.equal(gateOnly.entryCount, 0);
  assert.equal(gateOnly.config.excludeBenchmarkFromEntries, true);
  assert.equal(gateOnly.config.excludeBenchmarkFromBreadth, false);
});

test('daily momentum breadth exclusion works without excluding the benchmark from entries', () => {
  const candles = {
    'KRW-BTC': daily([100, 110, 120, 130]),
    'KRW-ETH': daily([100, 105, 110, 115]),
    'KRW-XRP': daily([100, 100, 100, 100])
  };
  const base = {
    ...DEFAULT_DAILY_MOMENTUM_CONFIG,
    initialBalance: 1_000,
    trendLookbackDays: 2,
    trendMinPercent: 0,
    breadthMin: 2,
    maxPositions: 3,
    positionFraction: 0.3,
    mode: 'fixed',
    maxHoldDays: 3650,
    benchmarkMarket: 'KRW-BTC',
    benchmarkTrendMinPercent: 0
  };
  const counted = simulateDailyMomentumPortfolio(candles, base);
  const excluded = simulateDailyMomentumPortfolio(candles, {
    ...base,
    excludeBenchmarkFromBreadth: true
  });

  assert.equal(counted.config.excludeBenchmarkFromBreadth, false);
  assert.equal(counted.entryCount, 2);
  assert.equal(excluded.config.excludeBenchmarkFromBreadth, true);
  assert.equal(excluded.config.excludeBenchmarkFromEntries, false);
  assert.equal(excluded.entryCount, 0);
});

test('daily momentum keeps the benchmark trend gate when it is excluded only from breadth', () => {
  const candles = {
    'KRW-BTC': daily([100, 99, 98, 97]),
    'KRW-ETH': daily([100, 105, 110, 115]),
    'KRW-XRP': daily([100, 105, 110, 115])
  };
  const result = simulateDailyMomentumPortfolio(candles, {
    ...DEFAULT_DAILY_MOMENTUM_CONFIG,
    initialBalance: 1_000,
    trendLookbackDays: 2,
    trendMinPercent: 0,
    requireUpBar: false,
    breadthMin: 2,
    maxPositions: 3,
    positionFraction: 0.3,
    mode: 'fixed',
    maxHoldDays: 3650,
    benchmarkMarket: 'KRW-BTC',
    benchmarkTrendMinPercent: -50,
    excludeBenchmarkFromBreadth: true
  });

  assert.equal(result.entryCount, 2);
  assert.deepEqual(
    result.openPositions.map(position => position.market).sort(),
    ['KRW-ETH', 'KRW-XRP']
  );
});

test('daily momentum optional relative strength filter blocks entries that do not beat the benchmark', () => {
  const candles = {
    'KRW-BTC': daily([100, 101, 102, 103]),
    'KRW-ETH': daily([100, 101, 102, 102])
  };
  const base = {
    ...DEFAULT_DAILY_MOMENTUM_CONFIG,
    initialBalance: 1_000,
    trendLookbackDays: 2,
    trendMinPercent: 0,
    breadthMin: 1,
    maxPositions: 1,
    mode: 'fixed',
    maxHoldDays: 3650,
    benchmarkMarket: 'KRW-BTC',
    benchmarkTrendMinPercent: 0,
    excludeBenchmarkFromEntries: true
  };
  const baseline = simulateDailyMomentumPortfolio(candles, base);
  const relative = simulateDailyMomentumPortfolio(candles, {
    ...base,
    relativeTrendMinPercent: 0
  });

  assert.equal(baseline.entryCount, 1);
  assert.equal(baseline.config.relativeTrendMinPercent, null);
  assert.equal(relative.entryCount, 0);
  assert.equal(relative.config.relativeTrendMinPercent, 0);
});

test('daily momentum fails closed when relative strength has no benchmark', () => {
  const result = simulateDailyMomentumPortfolio({
    'KRW-ETH': daily([100, 101, 102, 103])
  }, {
    ...DEFAULT_DAILY_MOMENTUM_CONFIG,
    trendLookbackDays: 2,
    relativeTrendMinPercent: 0
  });

  assert.equal(result.available, false);
  assert.equal(result.dataQuality.reason, 'relative_benchmark_missing');
  assert.equal(result.entryCount, 0);
});

test('daily momentum volatility targeting reduces a high-volatility entry size without changing the default', () => {
  const candles = {
    'KRW-BTC': daily([100, 102, 101, 105, 106, 107]),
    'KRW-ETH': daily([100, 102, 101, 105, 106, 107])
  };
  const base = {
    ...DEFAULT_DAILY_MOMENTUM_CONFIG,
    initialBalance: 1_000,
    trendLookbackDays: 2,
    breadthMin: 2,
    maxPositions: 1,
    positionFraction: 0.5,
    mode: 'fixed',
    maxHoldDays: 3650
  };
  const baseline = simulateDailyMomentumPortfolio(candles, base);
  const targeted = simulateDailyMomentumPortfolio(candles, {
    ...base,
    volatilityLookbackDays: 2,
    volatilityTargetPercent: 1
  });

  assert.equal(baseline.config.volatilityTargetPercent, null);
  assert.equal(baseline.entryCount, 1);
  assert.equal(targeted.config.volatilityLookbackDays, 2);
  assert.equal(targeted.config.volatilityTargetPercent, 1);
  assert.equal(targeted.entryCount, 1);
  assert.ok(targeted.openPositions[0].volatilityScale < 1);
  assert.ok(targeted.openPositions[0].size < baseline.openPositions[0].size);
});

test('daily momentum optional stop loss exits on the completed close before later entries', () => {
  const result = simulateDailyMomentumPortfolio({
    'KRW-BTC': daily([100, 101, 102, 98, 99]),
    'KRW-ETH': daily([100, 101, 102, 98, 99])
  }, {
    ...DEFAULT_DAILY_MOMENTUM_CONFIG,
    initialBalance: 1_000,
    trendLookbackDays: 2,
    breadthMin: 2,
    maxPositions: 1,
    positionFraction: 0.5,
    mode: 'fixed',
    maxHoldDays: 3650,
    stopLossPercent: 2
  });

  assert.equal(result.config.stopLossPercent, 2);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].exit, 'STOP_LOSS');
  assert.equal(result.trades[0].exitTimestamp, '2026-01-04T00:00:00.000Z');
  assert.equal(result.openPositions.length, 0);
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

test('daily momentum benchmark exit confirmation ignores a one-bar benchmark failure', () => {
  const candles = {
    'KRW-BTC': daily([100, 101, 102, 101, 100]),
    'KRW-ETH': daily([100, 101, 102, 103, 104])
  };
  const base = {
    ...DEFAULT_DAILY_MOMENTUM_CONFIG,
    initialBalance: 1_000,
    trendLookbackDays: 2,
    breadthMin: 1,
    maxPositions: 1,
    mode: 'regime',
    benchmarkMarket: 'KRW-BTC',
    benchmarkTrendMinPercent: 0,
    exitOnBenchmarkOff: true,
    excludeBenchmarkFromEntries: true
  };
  const immediate = simulateDailyMomentumPortfolio(candles, base);
  const confirmed = simulateDailyMomentumPortfolio(candles, {
    ...base,
    benchmarkExitConfirmationBars: 2
  });

  assert.equal(immediate.trades[0].exit, 'BENCHMARK_OFF');
  assert.equal(immediate.trades[0].exitTimestamp, '2026-01-04T00:00:00.000Z');
  assert.equal(confirmed.config.benchmarkExitConfirmationBars, 2);
  assert.equal(confirmed.trades[0].exit, 'BENCHMARK_OFF');
  assert.equal(confirmed.trades[0].exitTimestamp, '2026-01-05T00:00:00.000Z');
});

test('daily momentum regime exit confirmation ignores a one-bar trend failure', () => {
  const candles = {
    'KRW-BTC': daily([100, 101, 102, 101, 100]),
    'KRW-ETH': daily([100, 101, 102, 101, 100])
  };
  const base = {
    ...DEFAULT_DAILY_MOMENTUM_CONFIG,
    initialBalance: 1_000,
    trendLookbackDays: 2,
    breadthMin: 2,
    maxPositions: 1,
    mode: 'regime',
    trendMinPercent: 0
  };
  const immediate = simulateDailyMomentumPortfolio(candles, base);
  const confirmed = simulateDailyMomentumPortfolio(candles, {
    ...base,
    regimeExitConfirmationBars: 2
  });

  assert.equal(immediate.trades[0].exit, 'REGIME_OFF');
  assert.equal(immediate.trades[0].exitTimestamp, '2026-01-04T00:00:00.000Z');
  assert.equal(confirmed.config.regimeExitConfirmationBars, 2);
  assert.equal(confirmed.trades[0].exit, 'REGIME_OFF');
  assert.equal(confirmed.trades[0].exitTimestamp, '2026-01-05T00:00:00.000Z');
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
