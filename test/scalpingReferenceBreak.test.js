import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateScalping } from '../src/backtest/scalpingBacktest.js';

function candle(index, close, open = close, high = close, low = close) {
  return {
    candle_date_time_utc: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    opening_price: open,
    high_price: high,
    low_price: low,
    trade_price: close,
    candle_acc_trade_volume: 100
  };
}

function syntheticReferenceBreak() {
  const candles = [];
  for (let index = 0; index < 26; index += 1) {
    const close = 120 - index;
    candles.push(candle(index, close, close + 0.5, close + 0.5, close - 0.5));
  }
  // Signal reference is 96; the following candle is the delayed entry proxy.
  candles.push(candle(26, 96, 95.2, 96.4, 95));
  candles.push(candle(27, 96, 96, 96.1, 95.9));
  // The close breaks the signal reference by more than 0.1%, but remains far
  // above the configured fixed stop so the reason is unambiguous.
  candles.push(candle(28, 95.7, 95.8, 96, 95.5));
  candles.push(candle(29, 95.5, 95.7, 95.8, 95.3));
  return candles;
}

test('reference-break exit invalidates a failed rebound after the minimum hold', () => {
  const result = simulateScalping(syntheticReferenceBreak(), {
    slippage: 0,
    stopLossPercent: 20,
    takeProfitPercent: 50,
    maxHoldMinutes: 30,
    referenceBreakExitPercent: 0.1,
    referenceBreakMinHoldMinutes: 1
  });
  const open = result.trades.find(trade => trade.type === 'OPEN');
  const close = result.trades.find(trade => trade.type === 'CLOSE');

  assert.ok(open);
  assert.ok(close);
  assert.equal(open.signalReferencePrice, 96);
  assert.equal(close.reason, 'REFERENCE_BREAK_EXIT');
  assert.equal(result.metrics.referenceBreakExits, 1);
  assert.equal(result.metrics.tradeCount, 1);
  assert.ok(close.exitPrice < 96);
});

test('disabled reference-break exit leaves the legacy exit reason unchanged', () => {
  const result = simulateScalping(syntheticReferenceBreak(), {
    slippage: 0,
    stopLossPercent: 20,
    takeProfitPercent: 50,
    maxHoldMinutes: 30,
    referenceBreakExitPercent: 0
  });

  assert.equal(result.metrics.referenceBreakExits, 0);
  assert.equal(result.trades.at(-1).reason, 'BACKTEST_END');
});
