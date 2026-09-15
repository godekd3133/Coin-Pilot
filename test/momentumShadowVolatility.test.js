import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateCloseVolatilityPercent,
  calculateVolatilityPositionScale
} from '../src/research/momentumShadowVolatility.js';

function candles(prices) {
  return prices.map(trade_price => ({ trade_price }));
}

test('volatility calculation excludes the current entry candle', () => {
  const values = candles([100, 102, 101, 105, 106, 200]);
  const beforeEntry = calculateCloseVolatilityPercent(values, 5, 2);
  const withDifferentCurrentCandle = calculateCloseVolatilityPercent(
    [...values.slice(0, 5), { trade_price: 1 }],
    5,
    2
  );

  assert.ok(beforeEntry > 0);
  assert.equal(withDifferentCurrentCandle, beforeEntry);
});

test('volatility calculation fails closed when the lookback is unavailable', () => {
  assert.equal(calculateCloseVolatilityPercent(candles([100, 101, 102]), 2, 2), null);
  assert.equal(calculateCloseVolatilityPercent(null, 5, 2), null);
});

test('volatility position scale is capped at one and disabled without a target', () => {
  assert.equal(calculateVolatilityPositionScale(2, null), 1);
  assert.equal(calculateVolatilityPositionScale(0.5, 1), 1);
  assert.equal(calculateVolatilityPositionScale(2, 1), 0.5);
});
