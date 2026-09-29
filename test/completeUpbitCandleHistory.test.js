import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchCompleteUpbitCandleHistory } from '../src/market-data/completeUpbitCandleHistory.js';

function candle(timestamp, marker = timestamp) {
  return { candle_date_time_utc: timestamp, marker };
}

test('complete Upbit candle history keeps exact newest-first pages and advances the cursor', async () => {
  const pages = [
    [candle('2026-09-30T10:00:00'), candle('2026-09-30T09:59:00')],
    [candle('2026-09-30T09:58:00')]
  ];
  const requests = [];
  const delays = [];
  const result = await fetchCompleteUpbitCandleHistory({
    marketDataClient: {
      async getMinuteCandles(...args) {
        requests.push(args);
        return pages.shift();
      }
    },
    market: 'KRW-BTC',
    intervalMinutes: 1,
    totalCount: 3,
    maxPerRequest: 2,
    requestSpacingMs: 25,
    sleepImpl: async value => delays.push(value)
  });

  assert.deepEqual(requests, [
    ['KRW-BTC', 1, 2],
    ['KRW-BTC', 1, 1, { to: '2026-09-30T09:59:00' }]
  ]);
  assert.deepEqual(result.map(row => row.candle_date_time_utc), [
    '2026-09-30T10:00:00', '2026-09-30T09:59:00', '2026-09-30T09:58:00'
  ]);
  assert.deepEqual(delays, [25]);
});

test('short candle pages fail closed instead of returning a partial training series', async () => {
  await assert.rejects(fetchCompleteUpbitCandleHistory({
    marketDataClient: { getMinuteCandles: async () => [candle('2026-09-30T10:00:00')] },
    market: 'KRW-BTC',
    intervalMinutes: 1,
    totalCount: 250
  }), error => error.code === 'CANDLE_HISTORY_INCOMPLETE' && /expected 200 candles/.test(error.message));
});

test('overlapping pages, duplicates, invalid timestamps, and wrong response order are rejected', async t => {
  const fixtures = [
    {
      name: 'overlap',
      pages: [
        [candle('2026-09-30T10:00:00'), candle('2026-09-30T09:59:00')],
        [candle('2026-09-30T09:59:00'), candle('2026-09-30T09:58:00')]
      ],
      pattern: /cursor did not advance/
    },
    {
      name: 'duplicate timestamp in a page',
      pages: [[candle('2026-09-30T10:00:00'), candle('2026-09-30T10:00:00')]],
      pattern: /not strictly newest-first/
    },
    {
      name: 'invalid timestamp',
      pages: [[candle('not-a-timestamp')]],
      pattern: /invalid candle timestamp/
    },
    {
      name: 'oldest-first page',
      pages: [[candle('2026-09-30T09:59:00'), candle('2026-09-30T10:00:00')]],
      pattern: /not strictly newest-first/
    }
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      const pages = [...fixture.pages];
      await assert.rejects(fetchCompleteUpbitCandleHistory({
        marketDataClient: { getMinuteCandles: async () => pages.shift() },
        market: 'KRW-BTC',
        intervalMinutes: 1,
        totalCount: fixture.pages.reduce((count, page) => count + page.length, 0),
        maxPerRequest: 2
      }), fixture.pattern);
    });
  }
});
