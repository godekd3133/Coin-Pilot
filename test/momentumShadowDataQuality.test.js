import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessMomentumShadowDailyGrid,
  isMomentumShadowDailyCandleComplete
} from '../src/research/momentumShadowDataQuality.js';

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
    now: Date.parse('2026-01-05T13:00:00.000Z'),
    maxAgeHours: 36
  });

  assert.equal(result.valid, false);
  assert.equal(result.reason, 'daily_market_stale');
  assert.deepEqual(result.staleMarkets, ['KRW-BTC', 'KRW-ETH']);
  assert.equal(result.latestAgeSecondsByMarket['KRW-BTC'], 133200);
  assert.equal(result.maxAgeHours, 36);
});

test('momentum shadow daily grid stays valid through the second half of a UTC day', () => {
  // The newest completed bar's open is always 24-48h old on a healthy feed;
  // freshness is measured from when it completed, so an afternoon poll must
  // not be reported as stale.
  const result = assessMomentumShadowDailyGrid({
    'KRW-BTC': daily([100, 101, 102]),
    'KRW-ETH': daily([100, 101, 102])
  }, ['KRW-BTC', 'KRW-ETH'], {
    now: Date.parse('2026-01-04T13:00:00.000Z'),
    maxAgeHours: 36
  });

  assert.equal(result.valid, true);
  assert.equal(result.reason, 'daily_grid_aligned_and_contiguous');
  assert.deepEqual(result.staleMarkets, []);
  assert.equal(result.latestAgeSecondsByMarket['KRW-BTC'], 46800);
});

test('daily candle completion follows the candle end time across the UTC boundary', () => {
  const completed = { candle_date_time_utc: '2026-01-02T00:00:00' };
  const justClosed = { candle_date_time_utc: '2026-01-03T00:00:00' };
  const forming = { candle_date_time_utc: '2026-01-04T00:00:00' };

  // A cycle snapshot taken just before midnight: the 01-03 candle has not
  // finished its UTC day at the snapshot and the 01-04 candle does not yet
  // exist, so neither may enter the completed series.
  const beforeMidnight = Date.parse('2026-01-03T23:59:59.900Z');
  assert.equal(isMomentumShadowDailyCandleComplete(completed, beforeMidnight), true);
  assert.equal(isMomentumShadowDailyCandleComplete(justClosed, beforeMidnight), false);
  assert.equal(isMomentumShadowDailyCandleComplete(forming, beforeMidnight), false);

  // A response that arrives just after midnight keeps the bar that actually
  // closed and still refuses the newly-forming candle.
  const afterMidnight = Date.parse('2026-01-04T00:00:00.400Z');
  assert.equal(isMomentumShadowDailyCandleComplete(justClosed, afterMidnight), true);
  assert.equal(isMomentumShadowDailyCandleComplete(forming, afterMidnight), false);

  // An unparseable or missing timestamp is never complete.
  assert.equal(isMomentumShadowDailyCandleComplete({ candle_date_time_utc: 'n/a' }, afterMidnight), false);
  assert.equal(isMomentumShadowDailyCandleComplete({}, afterMidnight), false);
  assert.equal(isMomentumShadowDailyCandleComplete(justClosed, Number.NaN), false);
});

test('momentum shadow daily grid lists an invalid market once even with stacked defects', () => {
  const gapped = daily([100, 101, 102]);
  gapped[2].ts = 'not-a-timestamp';
  const result = assessMomentumShadowDailyGrid({
    'KRW-BTC': daily([100, 101, 102]),
    'KRW-ETH': gapped
  }, ['KRW-BTC', 'KRW-ETH'], { now: Date.parse('2026-01-04T12:00:00.000Z') });

  assert.equal(result.valid, false);
  const ethEntries = result.invalidMarkets.filter(entry => entry.market === 'KRW-ETH');
  assert.equal(ethEntries.length, 1);
});
