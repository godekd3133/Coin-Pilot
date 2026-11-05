import test from 'node:test';
import assert from 'node:assert/strict';
import { ListingAgeFilter, inferListing } from '../src/trader/listingAgeFilter.js';
import { OrderExecutionEngine } from '../src/trader/orderExecutionEngine.js';

const NOW = Date.parse('2026-11-06T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const dayCandles = (days) => Array.from({ length: days }, (_, index) => ({
  candle_date_time_utc: new Date(NOW - index * DAY).toISOString().slice(0, 19)
}));

test('a market with fewer daily candles than requested is dated by its oldest candle', () => {
  const listing = inferListing(dayCandles(10), 45);
  assert.equal(listing.mature, false);
  assert.equal(listing.listedAtMs, NOW - 9 * DAY);
  assert.deepEqual(inferListing(dayCandles(46), 45), { known: true, mature: true });
  assert.deepEqual(inferListing([], 45), { known: false });
});

test('a recent listing is blocked, an old one passes, and results are cached', async () => {
  const calls = [];
  const filter = new ListingAgeFilter({
    minDays: 45,
    now: () => NOW,
    fetchDayCandles: async (market, count) => {
      calls.push([market, count]);
      return market === 'KRW-NEW' ? dayCandles(10) : dayCandles(count);
    }
  });
  assert.deepEqual(await filter.check('KRW-NEW'), { block: true, reason: 'listing_too_recent', ageDays: 9 });
  assert.equal((await filter.check('KRW-BTC')).block, false);
  await filter.check('KRW-NEW');
  await filter.check('KRW-BTC');
  assert.deepEqual(calls, [['KRW-NEW', 46], ['KRW-BTC', 46]]);
  assert.equal(filter.snapshot().blocked, 2);
});

test('a failed lookup blocks the entry and is retried next time', async () => {
  let fail = true;
  const filter = new ListingAgeFilter({
    minDays: 30,
    now: () => NOW,
    fetchDayCandles: async (_market, count) => {
      if (fail) throw new Error('network');
      return dayCandles(count);
    }
  });
  assert.deepEqual(await filter.check('KRW-X'), { block: true, reason: 'listing_age_unknown' });
  fail = false;
  assert.equal((await filter.check('KRW-X')).block, false);
  assert.equal(filter.snapshot().unknown, 1);
});

test('minDays 0 disables the filter without any request', async () => {
  const filter = new ListingAgeFilter({ minDays: 0, fetchDayCandles: async () => { throw new Error('should not fetch'); } });
  assert.equal(await filter.check('KRW-X'), null);
});

test('the delayed revalidation cancels a new-listing entry before reading prices', async () => {
  const confirmations = [];
  const owner = {
    exchange: 'upbit',
    config: { minListingAgeDays: 45 },
    upbit: { getDayCandles: async () => dayCandles(5) },
    marketDataAdapter: { getTickers: async () => { throw new Error('should not read prices'); } },
    recordPaperEntryConfirmation: (...args) => confirmations.push(args),
    resolveWinnerShadowBlockedEntryAsNotFilled: () => {},
    sleep: async () => {}
  };
  const engine = new OrderExecutionEngine(owner);
  const result = await engine.confirmScalpingEntry('KRW-NEW', { entryDelayMs: 0 }, {}, { skipConfirmationDelay: true });
  assert.equal(result, null);
  assert.deepEqual(confirmations.at(-1), ['KRW-NEW', 'cancelled', 'listing_too_recent']);
  assert.equal(owner.listingAgeFilter.snapshot().blocked, 1);
});
