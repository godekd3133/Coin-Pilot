import test from 'node:test';
import assert from 'node:assert/strict';
import { assessMomentumShadowDailyGrid } from '../src/research/momentumShadowDataQuality.js';

function daily(prices, start = '2026-01-01T00:00:00.000Z') {
  const first = Date.parse(start);
  return prices.map((trade_price, index) => ({
    ts: new Date(first + index * 86_400_000).toISOString(),
    trade_price
  }));
}

test('momentum shadow daily grid accepts aligned contiguous markets', () => {
  const result = assessMomentumShadowDailyGrid({
    'KRW-BTC': daily([100, 101, 102]),
    'KRW-ETH': daily([100, 101, 102])
  }, ['KRW-BTC', 'KRW-ETH'], { now: Date.parse('2026-01-04T00:00:00.000Z') });

  assert.equal(result.valid, true);
  assert.equal(result.reason, 'daily_grid_aligned_and_contiguous');
  assert.equal(result.latestTimestamp, '2026-01-03T00:00:00.000Z');
  assert.deepEqual(result.unalignedMarkets, []);
});

test('momentum shadow daily grid rejects missing or unaligned market responses', () => {
  const missing = assessMomentumShadowDailyGrid({
    'KRW-BTC': daily([100, 101, 102])
  }, ['KRW-BTC', 'KRW-ETH'], { now: Date.parse('2026-01-04T00:00:00.000Z') });
  const unaligned = assessMomentumShadowDailyGrid({
    'KRW-BTC': daily([100, 101, 102]),
    'KRW-ETH': daily([100, 101, 102, 103])
  }, ['KRW-BTC', 'KRW-ETH'], { now: Date.parse('2026-01-04T12:00:00.000Z') });

  assert.equal(missing.valid, false);
  assert.equal(missing.reason, 'daily_market_missing');
  assert.deepEqual(missing.missingMarkets, ['KRW-ETH']);
  assert.equal(unaligned.valid, false);
  assert.equal(unaligned.reason, 'daily_market_latest_timestamp_mismatch');
  assert.deepEqual(unaligned.unalignedMarkets, ['KRW-ETH']);
});

test('momentum shadow daily grid rejects an internal daily gap', () => {
  const btc = daily([100, 101, 102]);
  const eth = daily([100, 101, 102]);
  eth[2].ts = '2026-01-04T00:00:00.000Z';
  const result = assessMomentumShadowDailyGrid({
    'KRW-BTC': btc,
    'KRW-ETH': eth
  }, ['KRW-BTC', 'KRW-ETH'], { now: Date.parse('2026-01-04T12:00:00.000Z') });

  assert.equal(result.valid, false);
  assert.equal(result.reason, 'daily_market_grid_not_contiguous');
  assert.deepEqual(result.invalidMarkets, [{ market: 'KRW-ETH', reason: 'historical_candle_gap' }]);
});

test('momentum shadow daily grid rejects an aligned but stale completed candle', () => {
  const result = assessMomentumShadowDailyGrid({
    'KRW-BTC': daily([100, 101, 102]),
    'KRW-ETH': daily([100, 101, 102])
  }, ['KRW-BTC', 'KRW-ETH'], {
    now: Date.parse('2026-01-05T12:00:00.000Z'),
    maxAgeHours: 36
  });

  assert.equal(result.valid, false);
  assert.equal(result.reason, 'daily_market_stale');
  assert.deepEqual(result.staleMarkets, ['KRW-BTC', 'KRW-ETH']);
  assert.equal(result.latestAgeSecondsByMarket['KRW-BTC'], 216000);
  assert.equal(result.maxAgeHours, 36);
});
