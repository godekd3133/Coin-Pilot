import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizePaperExecutionComparison } from '../src/research/paperExecutionComparison.js';

test('execution comparison pairs exact signal keys and exposes sign flips', () => {
  const result = summarizePaperExecutionComparison({
    strictTrades: [
      {
        coin: 'KRW-XRP',
        signalKey: 'signal-1',
        profit: 100,
        profitPercent: 0.05,
        entryDelayMs: 2_000,
        executionDriftPercent: 0.1,
        entryTime: '2026-09-18T00:00:02.000Z',
        exitTime: '2026-09-18T00:30:00.000Z'
      },
      { coin: 'KRW-XRP', signalKey: 'signal-2', profit: -20, profitPercent: -0.01 }
    ],
    shadowTrades: [
      {
        coin: 'KRW-XRP',
        signalKey: 'signal-1',
        netProfit: -10,
        profitPercent: -0.005,
        entryDelayMs: 0,
        executionDriftPercent: 0.2,
        entryTimestamp: '2026-09-18T00:00:00.000Z',
        exitTimestamp: '2026-09-18T00:30:00.000Z'
      },
      { coin: 'KRW-XRP', signalKey: 'signal-2', netProfit: -25, profitPercent: -0.012 }
    ],
    looseShadowTrades: [{ coin: 'KRW-XRP', signalKey: 'signal-1', netProfit: 5, profitPercent: 0.0025 }]
  });

  assert.equal(result.available, true);
  assert.equal(result.researchOnly, true);
  assert.equal(result.promoted, false);
  assert.equal(result.strictVsShadow.pairedCount, 2);
  assert.equal(result.strictVsShadow.signFlipCount, 1);
  assert.equal(result.strictVsShadow.strictPositiveDiagnosticNegativeCount, 1);
  assert.equal(result.strictVsShadow.strictNonPositiveDiagnosticPositiveCount, 0);
  assert.equal(result.strictVsShadow.strictPairProfit, 80);
  assert.equal(result.strictVsShadow.diagnosticPairProfit, -35);
  assert.equal(result.strictVsShadow.diagnosticMinusStrictProfit, -115);
  assert.equal(result.strictVsShadow.rows[0].strictEntryDelayMs, 2_000);
  assert.equal(result.strictVsShadow.rows[0].diagnosticEntryDelayMs, 0);
  assert.match(result.note, /실제 체결/);
});

test('execution comparison excludes ambiguous duplicate keys instead of inventing a match', () => {
  const result = summarizePaperExecutionComparison({
    strictTrades: [
      { coin: 'KRW-BTC', signalKey: 'duplicate', profit: 10 },
      { coin: 'KRW-BTC', signalKey: 'duplicate', profit: 20 },
      { coin: 'KRW-ETH', signalKey: 'unmatched-strict', profit: 5 }
    ],
    shadowTrades: [
      { coin: 'KRW-BTC', signalKey: 'duplicate', netProfit: 1 },
      { coin: 'KRW-XRP', signalKey: 'unmatched-diagnostic', netProfit: 2 }
    ]
  });

  assert.equal(result.available, false);
  assert.equal(result.strictVsShadow.pairedCount, 0);
  assert.equal(result.strictVsShadow.ambiguousPairCount, 1);
  assert.equal(result.strictVsShadow.unmatchedStrictCount, 2);
  assert.equal(result.strictVsShadow.unmatchedDiagnosticCount, 2);
  assert.deepEqual(result.strictVsShadow.rows, []);
});

test('execution comparison ignores malformed or missing signal identity', () => {
  const result = summarizePaperExecutionComparison({
    strictTrades: [{ coin: 'KRW-BTC', profit: 10 }, { signalKey: 'missing-market', profit: 10 }],
    shadowTrades: [{ coin: 'KRW-BTC', signalKey: 'other', netProfit: 5 }]
  });

  assert.equal(result.available, false);
  assert.equal(result.strictVsShadow.strictCandidateCount, 0);
  assert.equal(result.strictVsShadow.diagnosticCandidateCount, 1);
  assert.equal(result.strictVsShadow.unmatchedStrictCount, 0);
  assert.equal(result.strictVsShadow.unmatchedDiagnosticCount, 1);
});
