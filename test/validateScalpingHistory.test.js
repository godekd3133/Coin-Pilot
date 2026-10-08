import assert from 'node:assert/strict';
import test from 'node:test';
import { getHistoricalCandles } from '../src/scripts/validateScalping.js';
import { analyzeHistoricalCandleContinuity } from '../src/backtest/historicalCandleIntegrity.js';

const candle = minute => ({
  market: 'KRW-ETH',
  candle_date_time_utc: new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString().slice(0, 19),
  opening_price: 100,
  high_price: 101,
  low_price: 99,
  trade_price: 100,
  candle_acc_trade_volume: 1
});

function pagedClient(pages) {
  const calls = [];
  return {
    calls,
    async getMinuteCandles(...args) {
      calls.push(args);
      assert.ok(pages.length > 0, 'the collector must not make an extra request');
      return pages.shift();
    }
  };
}

test('scalping validation fetches exactly the requested raw candles using the exclusive UTC cursor', async () => {
  const firstPage = Array.from({ length: 200 }, (_, index) => candle(200 - index));
  const finalPage = [candle(0)];
  const client = pagedClient([firstPage, finalPage]);
  const rows = await getHistoricalCandles(client, 'KRW-ETH', 1, 201);

  assert.deepEqual(rows, [...firstPage, ...finalPage]);
  assert.deepEqual(client.calls, [
    ['KRW-ETH', 1, 200],
    ['KRW-ETH', 1, 1, { to: firstPage.at(-1).candle_date_time_utc }]
  ]);
});

test('scalping validation rejects short and empty pages instead of treating partial history as complete', async t => {
  for (const [name, page] of [['short', [candle(2), candle(1)]], ['empty', []]]) {
    await t.test(name, async () => {
      const client = pagedClient([page]);
      await assert.rejects(
        getHistoricalCandles(client, 'KRW-ETH', 1, 201),
        error => error.code === 'CANDLE_HISTORY_INCOMPLETE' && /expected 200 candles/.test(error.message)
      );
      assert.equal(client.calls.length, 1);
    });
  }
});

test('scalping validation rejects an overlapping page rather than silently deduplicating an undersized window', async () => {
  const firstPage = Array.from({ length: 200 }, (_, index) => candle(200 - index));
  const client = pagedClient([firstPage, [firstPage.at(-1)]]);

  await assert.rejects(
    getHistoricalCandles(client, 'KRW-ETH', 1, 201),
    error => error.code === 'CANDLE_HISTORY_INCOMPLETE' && /cursor did not advance/.test(error.message)
  );
});

test('scalping validation rejects invalid candle timestamps before validating a historical window', async () => {
  const client = pagedClient([
    [candle(2), { ...candle(1), candle_date_time_utc: 'not-a-timestamp' }]
  ]);
  await assert.rejects(
    getHistoricalCandles(client, 'KRW-ETH', 1, 2),
    error => error.code === 'CANDLE_HISTORY_INCOMPLETE' && /invalid candle timestamp/.test(error.message)
  );
});

test('scalping validation preserves upstream no-trade gaps as raw failed continuity evidence', async () => {
  const page = [candle(5), candle(3), candle(2)];
  const client = pagedClient([page]);
  const rows = await getHistoricalCandles(client, 'KRW-ETH', 1, 3);
  const quality = analyzeHistoricalCandleContinuity(rows, 1);

  assert.deepEqual(rows, page);
  assert.equal(rows.some(row => row.isSyntheticNoTrade), false);
  assert.equal(quality.valid, false);
  assert.equal(quality.gapCount, 1);
  assert.equal(quality.missingIntervalCount, 1);
  assert.equal(quality.largestGapSeconds, 120);
});
