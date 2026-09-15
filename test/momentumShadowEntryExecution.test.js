import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveMomentumShadowEntryExecution,
  resolveMomentumShadowNextOpenFill
} from '../src/research/momentumShadowEntryExecution.js';

function bar(ts, opening_price) {
  return { ts, opening_price, trade_price: opening_price };
}

test('next-open execution resolves a current forming candle opening price', () => {
  const result = resolveMomentumShadowNextOpenFill({
    bars: [bar('2026-01-01T00:00:00', 100)],
    signalKey: '2026-01-01T00:00:00',
    currentOpen: { ts: '2026-01-02T00:00:00', opening_price: 110 }
  });

  assert.deepEqual(result, {
    available: true,
    terminal: false,
    reason: 'next_open_current_candle',
    entryTimestamp: '2026-01-02T00:00:00',
    entryPrice: 110
  });
});

test('next-open execution can use a completed next candle after a restart', () => {
  const result = resolveMomentumShadowNextOpenFill({
    bars: [
      bar('2026-01-01T00:00:00', 100),
      bar('2026-01-02T00:00:00', 108)
    ],
    signalKey: '2026-01-01T00:00:00'
  });

  assert.equal(result.available, true);
  assert.equal(result.reason, 'next_open_completed_candle');
  assert.equal(result.entryTimestamp, '2026-01-02T00:00:00');
  assert.equal(result.entryPrice, 108);
});

test('next-open execution fails closed instead of filling a later candle', () => {
  const missing = resolveMomentumShadowNextOpenFill({
    bars: [
      bar('2026-01-01T00:00:00', 100),
      bar('2026-01-02T00:00:00', null)
    ],
    signalKey: '2026-01-01T00:00:00'
  });
  const gap = resolveMomentumShadowNextOpenFill({
    bars: [
      bar('2026-01-01T00:00:00', 100),
      bar('2026-01-03T00:00:00', 120)
    ],
    signalKey: '2026-01-01T00:00:00'
  });

  assert.equal(missing.available, false);
  assert.equal(missing.terminal, true);
  assert.equal(missing.reason, 'next_open_price_missing');
  assert.equal(gap.available, false);
  assert.equal(gap.terminal, true);
  assert.equal(gap.reason, 'next_open_candle_missing');
});

test('next-open execution voids an entry whose fill window already passed', () => {
  const stale = resolveMomentumShadowNextOpenFill({
    bars: [
      bar('2026-01-01T00:00:00', 100),
      bar('2026-01-02T00:00:00', 108),
      bar('2026-01-03T00:00:00', 112)
    ],
    signalKey: '2026-01-01T00:00:00',
    currentOpen: { ts: '2026-01-04T00:00:00', opening_price: 115 }
  });

  assert.equal(stale.available, false);
  assert.equal(stale.terminal, true);
  assert.equal(stale.reason, 'next_open_fill_window_missed');
});

test('entry execution keeps the legacy close contract by default', () => {
  assert.equal(resolveMomentumShadowEntryExecution(), 'close');
  assert.equal(resolveMomentumShadowEntryExecution('close'), 'close');
  assert.equal(resolveMomentumShadowEntryExecution('next_open'), 'next_open');
});
