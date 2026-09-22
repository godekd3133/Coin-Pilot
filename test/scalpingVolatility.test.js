import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateScalpingCloseVolatilityPercent,
  calculateScalpingVolatilityPositionScale,
  resolveScalpingVolatilitySizing
} from '../src/research/scalpingVolatility.js';
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

function syntheticRebound() {
  const candles = [];
  for (let index = 0; index < 26; index += 1) {
    const close = 120 - index;
    candles.push(candle(index, close, close + 0.5, close + 0.5, close - 0.5));
  }
  candles.push(candle(26, 96, 95.2, 96.4, 95));
  candles.push(candle(27, 97.8, 96, 98.2, 95.8));
  candles.push(candle(28, 97.5, 97.8, 98, 97.2));
  return candles;
}

test('scalping volatility excludes the signal/index candle from sizing history', () => {
  const first = [candle(0, 100), candle(1, 101), candle(2, 99), candle(3, 200)];
  const second = [candle(0, 100), candle(1, 101), candle(2, 99), candle(3, 300)];

  assert.equal(
    calculateScalpingCloseVolatilityPercent(first, 3, 2),
    calculateScalpingCloseVolatilityPercent(second, 3, 2)
  );
  assert.equal(calculateScalpingCloseVolatilityPercent(first, 2, 2), null);
});

test('scalping volatility sizing only reduces exposure above an active target', () => {
  assert.equal(calculateScalpingVolatilityPositionScale(0.04, 0.05), 1);
  assert.equal(calculateScalpingVolatilityPositionScale(0.1, 0.05), 0.5);
  assert.equal(calculateScalpingVolatilityPositionScale(0.1, 0), 1);

  const disabled = resolveScalpingVolatilitySizing({ targetPercent: 0 });
  assert.deepEqual(disabled, {
    enabled: false,
    available: true,
    volatilityPercent: null,
    scale: 1,
    reason: 'volatility_target_disabled'
  });
});

test('active scalping volatility sizing fails closed when history is unavailable', () => {
  const result = resolveScalpingVolatilitySizing({
    candles: [candle(0, 100), candle(1, 101), candle(2, 102)],
    index: 2,
    lookbackCandles: 20,
    targetPercent: 0.1
  });

  assert.equal(result.enabled, true);
  assert.equal(result.available, false);
  assert.equal(result.scale, null);
  assert.equal(result.reason, 'volatility_history_unavailable');
});

test('disabled scalping volatility overlay preserves the legacy simulation result', () => {
  const candles = syntheticRebound();
  const baseline = simulateScalping(candles, { slippage: 0 });
  const disabled = simulateScalping(candles, {
    slippage: 0,
    volatilityLookbackCandles: 2,
    volatilityTargetPercent: 0
  });

  assert.deepEqual(disabled.trades, baseline.trades);
  assert.deepEqual(disabled.metrics, baseline.metrics);
});

test('active scalping volatility overlay scales high-volatility entries and records the decision', () => {
  const result = simulateScalping(syntheticRebound(), {
    slippage: 0,
    volatilityLookbackCandles: 2,
    volatilityTargetPercent: 0.005
  });
  const open = result.trades.find(trade => trade.type === 'OPEN');

  assert.ok(open);
  assert.equal(result.metrics.volatilityBlockedEntries, 0);
  assert.ok(result.metrics.volatilityScaledEntries > 0);
  assert.ok(open.volatilityPercent > 0.005);
  assert.ok(open.volatilityScale < 1);
  assert.ok(open.investAmount < 20_000);
});

test('active scalping volatility overlay blocks an entry without enough completed history', () => {
  const result = simulateScalping(syntheticRebound(), {
    slippage: 0,
    volatilityLookbackCandles: 50,
    volatilityTargetPercent: 0.1
  });

  assert.equal(result.metrics.tradeCount, 0);
  assert.ok(result.metrics.volatilityBlockedEntries > 0);
  assert.equal(result.metrics.volatilityScaledEntries, 0);
});
