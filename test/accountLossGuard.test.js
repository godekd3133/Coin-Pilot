import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAccountLossGuard } from '../src/risk/accountLossGuard.js';

const now = Date.parse('2026-11-05T03:00:00Z'); // 12:00 KST
function strategies({ closes = [], position = null } = {}) {
  return new Map([['KRW-A', { currentPosition: position, tradeHistory: closes }]]);
}

test('the account loss guard is off by default', () => {
  const status = evaluateAccountLossGuard({ krwBalance: 1, strategies: strategies(), now });
  assert.equal(status.enabled, false);
  assert.equal(status.blocked, false);
});

test('the daily loss limit counts only the current KST day', () => {
  const closes = [
    { action: 'CLOSE', exitTime: '2026-11-04T14:59:00Z', profit: -500 }, // previous KST day
    { action: 'CLOSE', exitTime: '2026-11-04T15:01:00Z', profit: -200 },
    { action: 'PARTIAL_CLOSE', exitTime: '2026-11-05T02:00:00Z', profit: -100 }
  ];
  const status = evaluateAccountLossGuard({ dailyLossLimitKrw: 300, krwBalance: 10000, strategies: strategies({ closes }), now });
  assert.equal(status.realizedToday, -300);
  assert.equal(status.blocked, true);
  assert.equal(status.blockedReason, 'daily_loss_limit');
  assert.equal(evaluateAccountLossGuard({ dailyLossLimitKrw: 301, krwBalance: 10000, strategies: strategies({ closes }), now }).blocked, false);
});

test('the equity floor values positions at market when a price is known', () => {
  const position = { amount: 2, entryPrice: 2500 };
  const prices = new Map([['KRW-A', 2000]]);
  const status = evaluateAccountLossGuard({ equityFloorKrw: 9000, krwBalance: 4100, strategies: strategies({ position }), prices, now });
  assert.equal(status.equity, 8100);
  assert.equal(status.blocked, true);
});

test('the equity floor falls back to open-position cost without a price', () => {
  const position = { amount: 2, entryPrice: 2500 };
  assert.equal(evaluateAccountLossGuard({ equityFloorKrw: 9000, krwBalance: 4100, strategies: strategies({ position }), now }).blocked, false);
  const low = evaluateAccountLossGuard({ equityFloorKrw: 9000, krwBalance: 3900, strategies: strategies({ position }), now });
  assert.equal(low.blocked, true);
  assert.equal(low.blockedReason, 'equity_floor');
  assert.equal(low.equity, 8900);
});
