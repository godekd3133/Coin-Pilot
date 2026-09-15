import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureMomentumShadowInitialBalance,
  getMomentumShadowEquity,
  markMomentumShadowPosition,
  markMomentumShadowPositions,
  updateMomentumShadowEquity
} from '../src/research/momentumShadowLedger.js';

test('momentum shadow position mark includes round-trip cost and tracks excursions', () => {
  const first = markMomentumShadowPosition(
    { entryPrice: 100, size: 10 },
    102,
    '2026-09-13T00:00:00.000Z',
    0.2
  );
  assert.equal(first.markProfitPercent, 1.8);
  assert.equal(first.markValue, 10.18);
  assert.ok(Math.abs(first.unrealizedProfit - 0.18) < 1e-12);
  assert.equal(first.maxFavorableExcursionPercent, 1.8);
  assert.equal(first.maxAdverseExcursionPercent, 1.8);

  const second = markMomentumShadowPosition(first, 98, '2026-09-14T00:00:00.000Z', 0.2);
  assert.equal(second.markProfitPercent, -2.2);
  assert.equal(second.maxFavorableExcursionPercent, 1.8);
  assert.equal(second.maxAdverseExcursionPercent, -2.2);
});

test('momentum shadow mark normalizes naive candle timestamps to UTC', () => {
  const marked = markMomentumShadowPosition(
    { entryPrice: 100, size: 10 },
    102,
    '2026-09-13T00:00:00',
    0.2
  );
  // Naive candle timestamps are UTC in this ledger, not host-local time, so
  // the mark must keep the Z-suffixed instant regardless of machine zone.
  assert.equal(marked.markTimestamp, '2026-09-13T00:00:00.000Z');

  const epoch = markMomentumShadowPosition({ entryPrice: 100, size: 10 }, 102, 1789000000000, 0.2);
  assert.equal(epoch.markTimestamp, new Date(1789000000000).toISOString());

  const invalid = markMomentumShadowPosition({ entryPrice: 100, size: 10 }, 102, 'not-a-date', 0.2);
  assert.equal(invalid.markTimestamp, null);

  const absent = markMomentumShadowPosition({ entryPrice: 100, size: 10 }, 102, null, 0.2);
  assert.equal(absent.markTimestamp, null);
});

test('momentum shadow marking leaves markets without a valid completed bar untouched', () => {
  const ledger = {
    positions: {
      'KRW-BTC': { entryPrice: 100, size: 10 },
      'KRW-ETH': { entryPrice: 200, size: 5, markPrice: 201 }
    }
  };
  const marked = markMomentumShadowPositions(ledger, {
    'KRW-BTC': [{ trade_price: 105, ts: '2026-09-13T00:00:00.000Z' }],
    'KRW-ETH': []
  }, 0.2);
  assert.equal(marked, 1);
  assert.equal(ledger.positions['KRW-BTC'].markPrice, 105);
  assert.equal(ledger.positions['KRW-ETH'].markPrice, 201);
});

test('momentum shadow marking does not mark a next-open position with a pre-entry close', () => {
  const ledger = {
    positions: {
      'KRW-BTC': { entryPrice: 110, entryTs: '2026-09-14T00:00:00', size: 100 }
    }
  };
  const marked = markMomentumShadowPositions(ledger, {
    'KRW-BTC': [{ trade_price: 100, ts: '2026-09-13T00:00:00' }]
  }, 0.2);

  assert.equal(marked, 0);
  assert.equal(ledger.positions['KRW-BTC'].markPrice, undefined);
});

test('momentum shadow equity separates cash, open marked value, and unrealized P&L', () => {
  const ledger = {
    initialBalance: 1000,
    balance: 750,
    positions: {
      BTC: { entryPrice: 100, size: 250, markValue: 270 }
    }
  };
  const equity = getMomentumShadowEquity(ledger);
  assert.equal(equity.markedEquity, 1020);
  assert.equal(equity.investedOpen, 250);
  assert.equal(equity.markedOpenValue, 270);
  assert.equal(equity.unrealizedProfit, 20);
  assert.ok(Math.abs(equity.markedReturnPercent - 2) < 1e-12);
  assert.equal(updateMomentumShadowEquity(ledger, 1000, '2026-09-13T00:00:00.000Z').markedEquity, 1020);
  assert.equal(ledger.markedAt, '2026-09-13T00:00:00.000Z');
});

test('momentum shadow initial balance is backfilled without changing an existing value', () => {
  const ledger = {};
  assert.equal(ensureMomentumShadowInitialBalance(ledger, 1234), 1234);
  assert.equal(ledger.initialBalance, 1234);
  assert.equal(ensureMomentumShadowInitialBalance(ledger, 9999), 1234);
});
