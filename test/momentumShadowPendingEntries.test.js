import test from 'node:test';
import assert from 'node:assert/strict';
import { executeMomentumShadowPendingEntries } from '../src/research/momentumShadowPendingEntries.js';

function bar(ts, opening_price) {
  return { ts, opening_price, trade_price: opening_price };
}

function pendingLedger(overrides = {}) {
  return {
    balance: 100_000,
    positions: {},
    pendingEntries: [{
      market: 'KRW-BTC',
      signalKey: '2026-01-01T00:00:00',
      signalTimestamp: '2026-01-01T00:00:00',
      size: 12_500,
      volatilityPercent: 2,
      volatilityScale: 0.5,
      signalClosePrice: 100,
      selectionRank: 1,
      trendPercent: 4,
      breadth: 3,
      entryQuote: {
        market: 'KRW-BTC',
        available: true,
        bidPrice: 99,
        askPrice: 101,
        spreadPercent: 2,
        timestamp: 1_700_000_000_000
      }
    }],
    ...overrides
  };
}

test('under-floor cost voids pending next-open entries without touching cash or positions', () => {
  const first = pendingLedger().pendingEntries[0];
  const ledger = pendingLedger({
    pendingEntries: [first, { ...first, market: 'KRW-ETH', signalKey: '2026-01-01T00:01:00' }]
  });
  const result = executeMomentumShadowPendingEntries({
    ledger,
    dataQuality: { valid: true },
    entryExecution: 'next_open',
    costFloorReady: false,
    now: Date.parse('2026-01-02T00:05:00Z')
  });

  assert.deepEqual(result, { filled: 0, blocked: 2, pending: 0, costFloorBlocked: 2 });
  assert.equal(ledger.balance, 100_000);
  assert.deepEqual(ledger.positions, {});
  assert.deepEqual(ledger.pendingEntries, []);
  assert.equal(ledger.pendingEntryBlocked, 2);
  assert.equal(ledger.costFloorBlockedPendingEntries, 2);
  assert.deepEqual(ledger.voidedEntries.map(entry => entry.reason), [
    'pending_entry_cost_below_round_trip_cost_floor',
    'pending_entry_cost_below_round_trip_cost_floor'
  ]);
});

test('pending next-open fill debits cash and persists a restartable position', () => {
  const ledger = pendingLedger();
  const notifications = [];
  const result = executeMomentumShadowPendingEntries({
    ledger,
    series: {
      'KRW-BTC': [bar('2026-01-01T00:00:00', 100)]
    },
    currentOpenByMarket: {
      'KRW-BTC': { ts: '2026-01-02T00:00:00', opening_price: 110 }
    },
    dataQuality: { valid: true },
    maxPositions: 2,
    now: Date.parse('2026-01-02T00:05:00Z'),
    notify: { send: (...args) => notifications.push(args) },
    bookName: 'test-book'
  });

  assert.deepEqual(result, { filled: 1, blocked: 0, pending: 0 });
  assert.equal(ledger.balance, 87_500);
  assert.equal(ledger.pendingEntries.length, 0);
  assert.equal(ledger.entries, 1);
  assert.equal(ledger.positions['KRW-BTC'].entryPrice, 110);
  assert.equal(ledger.positions['KRW-BTC'].entryGapPercent, 10);
  assert.equal(ledger.positions['KRW-BTC'].entryTs, '2026-01-02T00:00:00');
  assert.equal(ledger.positions['KRW-BTC'].signalKey, '2026-01-01T00:00:00');
  assert.equal(ledger.positions['KRW-BTC'].entryQuote.askPrice, 101);
  assert.equal(notifications.length, 1);
});

test('pending next-open fill remains pending during data-quality outage', () => {
  const ledger = pendingLedger();
  const result = executeMomentumShadowPendingEntries({
    ledger,
    series: { 'KRW-BTC': [bar('2026-01-01T00:00:00', 100)] },
    currentOpenByMarket: {},
    dataQuality: { valid: false, reason: 'daily_market_missing' },
    maxPositions: 2
  });

  assert.deepEqual(result, { filled: 0, blocked: 0, pending: 1 });
  assert.equal(ledger.balance, 100_000);
  assert.equal(ledger.pendingEntryDataQualityBlocked, 1);
});

test('terminal pending fill failure is voided and never moved to a later candle', () => {
  const ledger = pendingLedger();
  const result = executeMomentumShadowPendingEntries({
    ledger,
    series: {
      'KRW-BTC': [
        bar('2026-01-01T00:00:00', 100),
        bar('2026-01-03T00:00:00', 130)
      ]
    },
    dataQuality: { valid: true },
    maxPositions: 2
  });

  assert.deepEqual(result, { filled: 0, blocked: 1, pending: 0 });
  assert.equal(ledger.voidedEntries[0].reason, 'next_open_candle_missing');
  assert.equal(ledger.positions['KRW-BTC'], undefined);
});

test('pending next-open fill is voided when the grid moved past the fill window', () => {
  const ledger = pendingLedger();
  const result = executeMomentumShadowPendingEntries({
    ledger,
    series: {
      'KRW-BTC': [
        bar('2026-01-01T00:00:00', 100),
        bar('2026-01-02T00:00:00', 108),
        bar('2026-01-03T00:00:00', 112)
      ]
    },
    currentOpenByMarket: {
      'KRW-BTC': { ts: '2026-01-04T00:00:00', opening_price: 115 }
    },
    dataQuality: { valid: true },
    maxPositions: 2
  });

  assert.deepEqual(result, { filled: 0, blocked: 1, pending: 0 });
  assert.equal(ledger.voidedEntries[0].reason, 'next_open_fill_window_missed');
  assert.equal(ledger.positions['KRW-BTC'], undefined);
});

test('pending next-open fills are voided once the portfolio drawdown stop fired', () => {
  const ledger = pendingLedger({ drawdownStopTriggered: true });
  const result = executeMomentumShadowPendingEntries({
    ledger,
    series: { 'KRW-BTC': [bar('2026-01-01T00:00:00', 100)] },
    currentOpenByMarket: {
      'KRW-BTC': { ts: '2026-01-02T00:00:00', opening_price: 110 }
    },
    dataQuality: { valid: true },
    maxPositions: 2
  });

  assert.deepEqual(result, { filled: 0, blocked: 1, pending: 0 });
  assert.equal(ledger.balance, 100_000);
  assert.equal(ledger.pendingEntries.length, 0);
  assert.equal(ledger.voidedEntries[0].reason, 'pending_entry_drawdown_stop');
  assert.equal(ledger.positions['KRW-BTC'], undefined);
});

test('pending next-open fill is voided when the adverse gap exceeds the ceiling', () => {
  const ledger = pendingLedger();
  const result = executeMomentumShadowPendingEntries({
    ledger,
    series: { 'KRW-BTC': [bar('2026-01-01T00:00:00', 100)] },
    currentOpenByMarket: {
      'KRW-BTC': { ts: '2026-01-02T00:00:00', opening_price: 110 }
    },
    dataQuality: { valid: true },
    maxPositions: 2,
    maxEntryGapPercent: 5
  });

  assert.deepEqual(result, { filled: 0, blocked: 1, pending: 0 });
  assert.equal(ledger.balance, 100_000);
  assert.equal(ledger.pendingEntryGapBlocked, 1);
  assert.equal(ledger.voidedEntries[0].reason, 'pending_entry_gap_above_limit');
  assert.equal(ledger.positions['KRW-BTC'], undefined);
});

test('spread-guarded pending fill stores the quote from the actual fill cycle', () => {
  const ledger = pendingLedger();
  const result = executeMomentumShadowPendingEntries({
    ledger,
    series: { 'KRW-BTC': [bar('2026-01-01T00:00:00', 100)] },
    currentOpenByMarket: {
      'KRW-BTC': { ts: '2026-01-02T00:00:00', opening_price: 100 }
    },
    dataQuality: { valid: true },
    entryQuotes: {
      'KRW-BTC': {
        market: 'KRW-BTC',
        available: true,
        bidPrice: 108,
        askPrice: 110,
        spreadPercent: 1.83,
        timestamp: 1_700_100_000_000
      }
    },
    quoteQuality: {
      error: null,
      missingMarkets: [],
      invalidMarkets: [],
      blockedMarkets: []
    },
    maxPositions: 2,
    maxSpreadPercent: 2,
    now: Date.parse('2026-01-02T00:05:00Z')
  });

  assert.deepEqual(result, { filled: 1, blocked: 0, pending: 0 });
  assert.equal(ledger.positions['KRW-BTC'].signalQuote.askPrice, 101);
  assert.equal(ledger.positions['KRW-BTC'].entryQuote.askPrice, 110);
  assert.equal(ledger.positions['KRW-BTC'].entryQuote.timestamp, 1_700_100_000_000);
});

test('spread-guarded pending fill is voided when the fill-cycle quote is unavailable', () => {
  const ledger = pendingLedger();
  const result = executeMomentumShadowPendingEntries({
    ledger,
    series: { 'KRW-BTC': [bar('2026-01-01T00:00:00', 100)] },
    currentOpenByMarket: {
      'KRW-BTC': { ts: '2026-01-02T00:00:00', opening_price: 100 }
    },
    dataQuality: { valid: true },
    quoteQuality: {
      error: null,
      missingMarkets: ['KRW-BTC'],
      invalidMarkets: [],
      blockedMarkets: []
    },
    maxPositions: 2,
    maxSpreadPercent: 0.5,
    now: Date.parse('2026-01-02T00:05:00Z')
  });

  assert.deepEqual(result, { filled: 0, blocked: 1, pending: 0 });
  assert.equal(ledger.pendingEntryQuoteBlocked, 1);
  assert.equal(ledger.voidedEntries[0].reason, 'pending_entry_quote_market_missing');
  assert.equal(ledger.positions['KRW-BTC'], undefined);
});

test('quote-cross pending fill uses the actual fill-cycle best ask as the modeled entry', () => {
  const ledger = pendingLedger();
  const result = executeMomentumShadowPendingEntries({
    ledger,
    series: { 'KRW-BTC': [bar('2026-01-01T00:00:00', 100)] },
    currentOpenByMarket: {
      'KRW-BTC': { ts: '2026-01-02T00:00:00', opening_price: 100 }
    },
    dataQuality: { valid: true },
    quoteQuality: {
      error: null,
      missingMarkets: [],
      invalidMarkets: [],
      blockedMarkets: []
    },
    entryQuotes: {
      'KRW-BTC': {
        market: 'KRW-BTC',
        available: true,
        bidPrice: 99,
        askPrice: 101,
        spreadPercent: 2,
        timestamp: 1_700_100_000_000
      }
    },
    maxPositions: 2,
    executionModel: 'quote_cross',
    now: Date.parse('2026-01-02T00:05:00Z')
  });

  assert.deepEqual(result, { filled: 1, blocked: 0, pending: 0 });
  assert.equal(ledger.positions['KRW-BTC'].entryPrice, 101);
  assert.equal(ledger.positions['KRW-BTC'].decisionEntryPrice, 100);
  assert.equal(ledger.positions['KRW-BTC'].executionModel, 'quote_cross');
  assert.equal(ledger.positions['KRW-BTC'].executionPriceSource, 'best_ask');
  assert.equal(ledger.positions['KRW-BTC'].executionQuoteTimestamp, 1_700_100_000_000);
});

test('quote-cross pending fill voids rather than falling back to the candle open when quote data is missing', () => {
  const ledger = pendingLedger();
  const result = executeMomentumShadowPendingEntries({
    ledger,
    series: { 'KRW-BTC': [bar('2026-01-01T00:00:00', 100)] },
    currentOpenByMarket: {
      'KRW-BTC': { ts: '2026-01-02T00:00:00', opening_price: 100 }
    },
    dataQuality: { valid: true },
    quoteQuality: {
      error: null,
      missingMarkets: ['KRW-BTC'],
      invalidMarkets: [],
      blockedMarkets: []
    },
    maxPositions: 2,
    executionModel: 'quote_cross',
    now: Date.parse('2026-01-02T00:05:00Z')
  });

  assert.deepEqual(result, { filled: 0, blocked: 1, pending: 0 });
  assert.equal(ledger.pendingEntryQuoteBlocked, 1);
  assert.equal(ledger.positions['KRW-BTC'], undefined);
});
