import test from 'node:test';
import assert from 'node:assert/strict';
import { getMomentumShadowBenchmarkGate } from '../src/research/momentumShadowBenchmark.js';

const bars = prices => prices.map((trade_price, index) => ({
  trade_price,
  ts: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00`
}));

test('benchmark gate opens only when the completed benchmark trend clears the floor', () => {
  const open = getMomentumShadowBenchmarkGate({ BTC: bars([100, 101, 103]) }, 'BTC', 2, 2, 2);
  const closed = getMomentumShadowBenchmarkGate({ BTC: bars([100, 101, 102]) }, 'BTC', 2, 2, 2);

  assert.equal(open.available, true);
  assert.equal(open.gateOpen, true);
  assert.ok(Math.abs(open.trendPercent - 3) < 1e-12);
  assert.equal(closed.gateOpen, false);
});

test('missing benchmark data closes the gate instead of passing open', () => {
  const result = getMomentumShadowBenchmarkGate({}, 'BTC', 0, 0, 7);
  assert.equal(result.available, false);
  assert.equal(result.gateOpen, false);
  assert.equal(result.reason, 'benchmark_data_unavailable');
});
