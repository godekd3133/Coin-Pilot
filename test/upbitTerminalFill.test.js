import test from 'node:test';
import assert from 'node:assert/strict';
import UpbitAPI from '../src/api/upbit.js';
import { hasCompleteLiveFillResult } from '../src/trader/orderExecutionEngine.js';

function apiReturning(order) {
  const api = new UpbitAPI('mock-access', 'mock-secret');
  api.getOrder = async () => structuredClone(order);
  return api;
}

// Shape observed on 2026-11-04 for a 5,200 KRW market buy: Upbit ended the
// filled order as 'cancel' and left out remaining_volume.
const cancelledMarketBuy = {
  uuid: '95a213c4-44f6-4c61-a717-4fd09425d25a',
  side: 'bid',
  ord_type: 'price',
  state: 'cancel',
  market: 'KRW-BTC',
  executed_volume: '0.00004953',
  avg_price: '104978000',
  paid_fee: '2.59978017',
  trades_count: 1
};

test('a filled market buy that Upbit ends as cancel without remaining_volume is complete', async () => {
  const result = await apiReturning(cancelledMarketBuy).waitForOrderFill('x', 1000, 10);
  assert.equal(result.filled, true);
  assert.equal(result.order.remaining_volume, '0');
  assert.equal(hasCompleteLiveFillResult(result), true);
});

test('a done order without remaining_volume is complete and a reported value is kept', async () => {
  const done = await apiReturning({ ...cancelledMarketBuy, state: 'done' }).waitForOrderFill('x', 1000, 10);
  assert.equal(hasCompleteLiveFillResult(done), true);
  const reported = await apiReturning({ ...cancelledMarketBuy, state: 'done', remaining_volume: '0.0' }).waitForOrderFill('x', 1000, 10);
  assert.equal(reported.order.remaining_volume, '0.0');
});

test('a partially filled cancel is still not treated as a complete fill', async () => {
  const result = await apiReturning({ ...cancelledMarketBuy, remaining_volume: '0.0001' }).waitForOrderFill('x', 1000, 10);
  assert.equal(result.filled, false);
  assert.equal(result.partial, true);
  assert.equal(hasCompleteLiveFillResult(result), false);
});
