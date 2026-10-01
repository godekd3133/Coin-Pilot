import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ParameterOptimizer from '../src/optimization/parameterOptimizer.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function candle(timestamp, close) {
  return {
    market: 'KRW-BTC',
    candle_date_time_utc: timestamp,
    opening_price: close - 1,
    high_price: close + 1,
    low_price: close - 2,
    trade_price: close,
    candle_acc_trade_volume: 1
  };
}

test('optimizer paginates through the shared Upbit minute-candle method with the same cursor and order', async () => {
  const pages = [
    [
      candle('2026-09-29T09:00:00', 102),
      candle('2026-09-29T08:45:00', 98),
      candle('2026-09-29T08:30:00', 95)
    ],
    [candle('2026-09-29T08:15:00', 92)]
  ];
  const requests = [];
  const upbit = {
    async getMinuteCandles(market, unit, count, options) {
      requests.push({ market, unit, count, options });
      return pages.shift();
    }
  };
  const optimizer = Object.create(ParameterOptimizer.prototype);
  optimizer.sleep = async () => {};

  const result = await optimizer.getMultipleMinuteCandles(upbit, 'KRW-BTC', 15, 4, 3);

  assert.deepEqual(requests, [
    { market: 'KRW-BTC', unit: 15, count: 3, options: undefined },
    { market: 'KRW-BTC', unit: 15, count: 1, options: { to: '2026-09-29T08:30:00' } }
  ]);
  assert.deepEqual(result.map(row => row.candle_date_time_utc), [
    '2026-09-29T09:00:00', '2026-09-29T08:45:00', '2026-09-29T08:30:00', '2026-09-29T08:15:00'
  ]);
});

test('primary runtime pagination no longer calls the Upbit HTTP endpoint directly', () => {
  // getMultipleMinuteCandles lives in researchLoops.js after the boot/config split;
  // the guard follows the code, not the filename.
  const source = fs.readFileSync(path.join(projectRoot, 'src/runtime/researchLoops.js'), 'utf8');
  const collector = source.split('async function getMultipleMinuteCandles(')[1]
    ?.split('\n}\n')[0] || '';

  assert.match(source, /fetchCompleteUpbitCandleHistory/);
  assert.match(collector, /marketDataClient: upbit/);
  assert.match(collector, /intervalMinutes: unit/);
  assert.doesNotMatch(collector, /axios|https:\/\/api\.upbit\.com/);
});
