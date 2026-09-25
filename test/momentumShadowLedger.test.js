import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureMomentumShadowInitialBalance,
  getMomentumShadowEquity,
  isMomentumShadowPositionCoveredByBar,
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

test('observed MDD tracks sampled peak-to-trough separately from the risk-stop high watermark', () => {
  const ledger = {
    initialBalance: 1_000,
    balance: 1_000,
    positions: {},
    startedAt: '2026-09-24T00:00:00.000Z',
    cycles: 0,
    config: { pollMs: 300_000 },
    dataQuality: { valid: true },
    dataQualityInvalidCycles: 0,
    networkFetchCircuitBreaks: 0,
    interruptions: [],
    runnerEvents: [{ type: 'started', at: '2026-09-24T00:00:00.000Z' }],
    peakEquity: 1_000,
    drawdownPercent: 0,
    drawdownStopTriggered: false
  };

  updateMomentumShadowEquity(ledger, 1_000, '2026-09-24T00:00:00.000Z');
  ledger.cycles = 1;
  ledger.balance = 1_200;
  updateMomentumShadowEquity(ledger, 1_000, '2026-09-24T00:05:00.000Z');
  ledger.cycles = 2;
  ledger.balance = 900;
  updateMomentumShadowEquity(ledger, 1_000, '2026-09-24T00:10:00.000Z');
  ledger.cycles = 3;
  ledger.balance = 1_100;
  updateMomentumShadowEquity(ledger, 1_000, '2026-09-24T00:15:00.000Z');

  assert.equal(ledger.observedMddSampleCount, 4);
  assert.equal(ledger.observedMddFullSessionCoverage, true);
  assert.equal(ledger.observedMddPeakEquity, 1_200);
  assert.ok(Math.abs(ledger.observedMddCurrentDrawdownPercent - (100 / 12)) < 1e-12);
  assert.equal(ledger.observedMddMaxDrawdownPercent, 25);
  assert.equal(ledger.observedMddMaxDrawdownAt, '2026-09-24T00:10:00.000Z');
  assert.equal(ledger.observedMddMaxDrawdownPeakEquity, 1_200);
  assert.equal(ledger.observedMddMaxDrawdownTroughEquity, 900);
  assert.equal(ledger.observedMddSamplingIntervalMs, 300_000);
  assert.equal(ledger.peakEquity, 1_000);
  assert.equal(ledger.drawdownPercent, 0);
  assert.equal(ledger.drawdownStopTriggered, false);
});

test('legacy ledger starts partial MDD observation instead of reconstructing a false session maximum', () => {
  const ledger = {
    initialBalance: 1_000,
    balance: 900,
    positions: {},
    startedAt: '2026-09-20T00:00:00.000Z',
    cycles: 200,
    config: { pollMs: 300_000 },
    dataQuality: { valid: true },
    dataQualityInvalidCycles: 0,
    networkFetchCircuitBreaks: 0,
    interruptions: []
  };

  updateMomentumShadowEquity(ledger, 1_000, '2026-09-24T00:00:00.000Z');

  assert.equal(ledger.observedMddSampleCount, 1);
  assert.equal(ledger.observedMddFullSessionCoverage, false);
  assert.equal(ledger.observedMddCoverageReasons.includes('telemetry_started_after_session_start'), true);
  assert.equal(ledger.observedMddPeakEquity, 900);
  assert.equal(ledger.observedMddMaxDrawdownPercent, 0);
});

test('observed MDD coverage stays incomplete after interruption or invalid daily data', () => {
  const ledger = {
    initialBalance: 1_000,
    balance: 950,
    positions: {},
    startedAt: '2026-09-24T00:00:00.000Z',
    cycles: 0,
    dataQuality: { valid: false },
    dataQualityInvalidCycles: 1,
    networkFetchCircuitBreaks: 1,
    interruptions: [{ reason: 'heartbeat_gap' }]
  };

  updateMomentumShadowEquity(ledger, 1_000, '2026-09-24T00:00:00.000Z');

  assert.equal(ledger.observedMddFullSessionCoverage, false);
  assert.ok(ledger.observedMddCoverageReasons.includes('daily_data_quality_invalid'));
  assert.ok(ledger.observedMddCoverageReasons.includes('continuity_interruption'));
  assert.ok(ledger.observedMddCoverageReasons.includes('network_fetch_circuit_break'));
});

test('momentum shadow initial balance is backfilled without changing an existing value', () => {
  const ledger = {};
  assert.equal(ensureMomentumShadowInitialBalance(ledger, 1234), 1234);
  assert.equal(ledger.initialBalance, 1234);
  assert.equal(ensureMomentumShadowInitialBalance(ledger, 9999), 1234);
});

test('momentum shadow covered-by-bar check only trusts post-entry completed bars', () => {
  const position = { entryTs: '2026-01-03T00:00:00' };
  assert.equal(
    isMomentumShadowPositionCoveredByBar(position, { ts: '2026-01-03T00:00:00' }),
    true
  );
  assert.equal(
    isMomentumShadowPositionCoveredByBar(position, { ts: '2026-01-02T00:00:00' }),
    false
  );
  // Unparseable timestamps cannot prove pre-entry, so they keep evaluation
  // instead of silently freezing a position's exit checks.
  assert.equal(isMomentumShadowPositionCoveredByBar(position, { ts: 'n/a' }), true);
  assert.equal(
    isMomentumShadowPositionCoveredByBar({ entryTs: 'n/a' }, { ts: '2026-01-02T00:00:00' }),
    true
  );
});
