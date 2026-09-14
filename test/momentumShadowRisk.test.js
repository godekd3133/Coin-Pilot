import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isMomentumShadowCooldownActive,
  recordMomentumShadowExit,
  updateMomentumShadowDrawdown
} from '../src/research/momentumShadowRisk.js';

test('momentum shadow loss cooldown is persisted per market and expires by time', () => {
  const ledger = { positions: {}, cooldownUntilByMarket: {} };
  const at = Date.parse('2026-01-01T00:00:00.000Z');
  const until = recordMomentumShadowExit(ledger, 'KRW-ETH', -1.2, at, 3);

  assert.equal(until, '2026-01-04T00:00:00.000Z');
  assert.equal(isMomentumShadowCooldownActive(ledger, 'KRW-ETH', at + 2 * 86_400_000), true);
  assert.equal(isMomentumShadowCooldownActive(ledger, 'KRW-ETH', at + 3 * 86_400_000), false);
  assert.equal(isMomentumShadowCooldownActive(ledger, 'KRW-BTC', at), false);
});

test('momentum shadow drawdown stop tracks peak and triggers once only with an open position', () => {
  const ledger = { initialBalance: 100_000_000, positions: { 'KRW-ETH': { size: 25_000_000 } } };
  const at = '2026-01-02T00:00:00.000Z';

  assert.equal(updateMomentumShadowDrawdown(ledger, 100_000_000, at, 10).triggered, false);
  const stopped = updateMomentumShadowDrawdown(ledger, 89_000_000, at, 10);
  assert.equal(stopped.triggered, true);
  assert.equal(ledger.drawdownStopTriggered, true);
  assert.equal(ledger.drawdownStopAt, at);
  assert.equal(updateMomentumShadowDrawdown(ledger, 80_000_000, at, 10).triggered, false);
  assert.equal(ledger.peakEquity, 100_000_000);
});
