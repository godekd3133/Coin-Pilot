import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureMomentumShadowConsumedSignalState,
  isMomentumShadowSignalConsumed,
  recordMomentumShadowSignal
} from '../src/research/momentumShadowSignalGuard.js';

test('momentum shadow signal guard persists and compares per-market keys', () => {
  const ledger = { positions: {}, trades: [] };

  assert.equal(isMomentumShadowSignalConsumed(ledger, 'KRW-BTC', 'candle-1'), false);
  assert.equal(recordMomentumShadowSignal(ledger, 'KRW-BTC', 'candle-1'), true);
  assert.equal(isMomentumShadowSignalConsumed(ledger, 'KRW-BTC', 'candle-1'), true);
  assert.equal(isMomentumShadowSignalConsumed(ledger, 'KRW-ETH', 'candle-1'), false);
  assert.equal(recordMomentumShadowSignal(ledger, 'KRW-BTC', 'candle-2'), true);
  assert.equal(isMomentumShadowSignalConsumed(ledger, 'KRW-BTC', 'candle-1'), false);
  assert.equal(ledger.consumedSignalKeyByMarket['KRW-BTC'], 'candle-2');
});

test('legacy trades and positions migrate to the newest completed signal key', () => {
  const ledger = {
    positions: {
      'KRW-ETH': { entryTs: '2026-09-12T00:00:00' }
    },
    trades: [
      { market: 'KRW-BTC', entry: { entryTs: '2026-09-10T00:00:00' } },
      { market: 'KRW-BTC', entry: { entryTs: '2026-09-11T00:00:00' } }
    ]
  };

  const state = ensureMomentumShadowConsumedSignalState(ledger);

  assert.deepEqual(state, {
    'KRW-BTC': '2026-09-11T00:00:00',
    'KRW-ETH': '2026-09-12T00:00:00'
  });
  assert.equal(isMomentumShadowSignalConsumed(ledger, 'KRW-BTC', '2026-09-10T00:00:00'), false);
  assert.equal(isMomentumShadowSignalConsumed(ledger, 'KRW-BTC', '2026-09-11T00:00:00'), true);
});

test('migration does not replace an opaque persisted key with legacy history', () => {
  const ledger = {
    consumedSignalKeyByMarket: { 'KRW-BTC': 'opaque-signal-id' },
    trades: [{ market: 'KRW-BTC', entry: { entryTs: '2026-09-11T00:00:00' } }]
  };

  ensureMomentumShadowConsumedSignalState(ledger);

  assert.equal(ledger.consumedSignalKeyByMarket['KRW-BTC'], 'opaque-signal-id');
});
