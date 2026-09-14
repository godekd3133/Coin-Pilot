import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DAILY_MARKET_NEUTRAL_CONFIG,
  evaluateDailyMarketNeutralCostSensitivity,
  evaluateDailyMarketNeutralVariants,
  simulateDailyMarketNeutralPortfolio
} from '../src/research/dailyMarketNeutralStudy.js';

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

test('synthetic market-neutral replay separates long and short legs and applies cost', () => {
  const result = simulateDailyMarketNeutralPortfolio({
    'KRW-BTC': daily([100, 101, 102, 103, 104, 105]),
    'KRW-ETH': daily([100, 99, 98, 97, 96, 95])
  }, {
    ...DEFAULT_DAILY_MARKET_NEUTRAL_CONFIG,
    initialBalance: 1_000,
    trendLookbackDays: 1,
    longCount: 1,
    shortCount: 1,
    longExposure: 0.4,
    shortExposure: 0.4,
    rebalanceDays: 2,
    minTrendSpreadPercent: 0,
    requireBothSides: true
  });

  assert.equal(result.available, true);
  assert.equal(result.syntheticShort, true);
  assert.equal(result.promoted, false);
  assert.ok(result.entryCount >= 2);
  assert.ok(result.trades.length >= 2);
  assert.ok(result.metrics.finalEquity > result.metrics.initialBalance);
  assert.ok(result.metrics.longExposurePercent > 0);
  assert.ok(result.metrics.shortExposurePercent > 0);
  assert.ok(result.trades.some(trade => trade.side === 'short' && trade.profitPercent > 0));
});

test('synthetic market-neutral replay reuses the daily grid quality fail-closed contract', () => {
  const btc = daily([100, 101, 102, 103, 104]);
  const eth = daily([100, 99, 98, 97, 96]);
  eth.splice(2, 1);
  const result = simulateDailyMarketNeutralPortfolio({ 'KRW-BTC': btc, 'KRW-ETH': eth }, {
    ...DEFAULT_DAILY_MARKET_NEUTRAL_CONFIG,
    trendLookbackDays: 1
  });

  assert.equal(result.available, false);
  assert.equal(result.dataQuality.valid, false);
  assert.equal(result.dataQuality.reason, 'daily_candle_grid_not_contiguous');
});

test('synthetic market-neutral variant report remains research-only', () => {
  const candles = {
    'KRW-BTC': daily([100, 101, 102, 103, 104, 105, 106, 107]),
    'KRW-ETH': daily([100, 99, 98, 97, 96, 95, 94, 93])
  };
  const report = evaluateDailyMarketNeutralVariants(candles, {
    variants: [{ name: 'fixture', config: { trendLookbackDays: 1, longCount: 1, shortCount: 1 } }],
    segmentCount: 2
  });

  assert.equal(report.syntheticShort, true);
  assert.equal(report.researchOnly, true);
  assert.equal(report.promoted, false);
  assert.equal(report.variants[0].promoted, false);
  assert.equal(report.variants[0].segments.length, 2);
});

test('synthetic short cost sensitivity exposes financing drag without promoting a candidate', () => {
  const candles = {
    'KRW-BTC': daily([100, 101, 102, 103, 104, 105]),
    'KRW-ETH': daily([100, 99, 98, 97, 96, 95])
  };
  const report = evaluateDailyMarketNeutralCostSensitivity(candles, {
    variant: { name: 'fixture', config: { trendLookbackDays: 1, longCount: 1, shortCount: 1, rebalanceDays: 4 } },
    transactionCosts: [0.2],
    shortBorrowCostsPerDay: [0, 0.1],
    segmentCount: 2
  });

  assert.equal(report.promoted, false);
  assert.equal(report.rows.length, 2);
  assert.ok(report.rows[1].metrics.finalEquity < report.rows[0].metrics.finalEquity);
  assert.equal(report.rows[1].shortBorrowCostPercentPerDay, 0.1);
  assert.equal(report.rows[0].segments.length, 2);
});
