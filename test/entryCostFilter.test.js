import test from 'node:test';
import assert from 'node:assert/strict';
import { measureEntryCost, judgeEntryCost } from '../src/trader/entryCostFilter.js';

const book = (pairs) => ({ market: 'KRW-X', orderbook_units: pairs.map(([ask, bid]) => ({ ask_price: ask, bid_price: bid })) });

test('a cheap coin with a 1 KRW tick costs spread plus a tick', () => {
  const m = measureEntryCost(book([[311, 310], [312, 309], [313, 308]]));
  assert.equal(m.tick, 1);
  assert.equal(m.spreadPercent, 0.3221);
  assert.equal(m.costPercent, 0.6441);
  const verdict = judgeEntryCost(m, { takeProfitPercent: 1.8, maxTakeProfitRatio: 0.15 });
  assert.equal(verdict.limitPercent, 0.27);
  assert.equal(verdict.tooHigh, true);
});

test('a liquid coin with a fine tick passes', () => {
  const m = measureEntryCost(book([[100001000, 100000000], [100002000, 99999000]]));
  assert.equal(m.tick, 1000);
  assert.ok(m.costPercent < 0.01);
  assert.equal(judgeEntryCost(m, { takeProfitPercent: 1.8, maxTakeProfitRatio: 0.15 }).tooHigh, false);
});

test('an empty or crossed orderbook is not measurable', () => {
  assert.equal(measureEntryCost(null), null);
  assert.equal(measureEntryCost(book([[100, 101]])), null);
});
