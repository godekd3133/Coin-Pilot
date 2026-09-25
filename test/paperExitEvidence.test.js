import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  PAPER_EXIT_EVIDENCE_SCHEMA,
  summarizePaperSignalWindowCoverage,
  summarizePaperExitEvidence
} from '../src/research/paperExitEvidence.js';

test('signal-window coverage counts same-window trades as a cluster, not independent samples', () => {
  const coverage = summarizePaperSignalWindowCoverage([
    { signalKey: '2026-09-24T09:35:00', coin: 'KRW-BTC' },
    { signalKey: '2026-09-24T09:35:00', coin: 'KRW-ETH' },
    { signalKey: '2026-09-24T09:50:00', coin: 'KRW-XRP' },
    { signalTime: '2026-09-24T10:05:00', coin: 'KRW-SOL' },
    { coin: 'KRW-DOGE' }
  ]);

  assert.equal(coverage.tradeCount, 5);
  assert.equal(coverage.uniqueSignalWindowCount, 3);
  assert.equal(coverage.linkedTradeCount, 4);
  assert.equal(coverage.signalKeyTradeCount, 3);
  assert.equal(coverage.signalTimeFallbackTradeCount, 1);
  assert.equal(coverage.unlinkedTradeCount, 1);
  assert.equal(coverage.clusteredTradeCount, 1);
  assert.equal(coverage.coverageComplete, false);
});

test('signal-window coverage handles an empty closed-trade cohort without fabricating samples', () => {
  assert.deepEqual(summarizePaperSignalWindowCoverage([]), {
    tradeCount: 0,
    uniqueSignalWindowCount: 0,
    linkedTradeCount: 0,
    signalKeyTradeCount: 0,
    signalTimeFallbackTradeCount: 0,
    unlinkedTradeCount: 0,
    clusteredTradeCount: 0,
    coverageComplete: true
  });
});

test('paper exit evidence groups realized outcomes without inventing earlier exits', () => {
  const result = summarizePaperExitEvidence([
    {
      reason: 'MAX_HOLD_TIME',
      profit: 100,
      profitPercent: 1,
      entryTime: '2026-09-18T00:00:00Z',
      exitTime: '2026-09-18T00:30:00Z',
      maxFavorableExcursionPercent: 1.4,
      maxAdverseExcursionPercent: -0.2
    },
    {
      reason: 'MAX_HOLD_TIME',
      profit: -50,
      profitPercent: -0.5,
      entryTime: '2026-09-18T01:00:00Z',
      exitTime: '2026-09-18T01:15:00Z',
      maxFavorableExcursionPercent: 0.2,
      maxAdverseExcursionPercent: -0.7
    },
    {
      reason: 'STOP_LOSS',
      profit: -80,
      profitPercent: -0.8,
      entryTime: '2026-09-18T02:00:00Z',
      exitTime: '2026-09-18T02:05:00Z'
    },
    { reason: 'MALFORMED' }
  ]);

  assert.equal(result.schema, PAPER_EXIT_EVIDENCE_SCHEMA);
  assert.equal(result.tradeCount, 4);
  assert.equal(result.validTradeCount, 3);
  assert.equal(result.invalidTradeCount, 1);
  assert.equal(result.overall.netProfit, -30);
  assert.equal(result.overall.averageHoldMinutes, (30 + 15 + 5) / 3);
  assert.equal(result.byReason[0].reason, 'MAX_HOLD_TIME');
  assert.equal(result.byReason[0].tradeCount, 2);
  assert.equal(result.byReason[0].netProfit, 50);
  assert.ok(Math.abs(result.byReason[0].averageMaxFavorableExcursionPercent - 0.8) < 1e-12);
  assert.equal(result.byReason[1].reason, 'STOP_LOSS');
  assert.deepEqual(result.signalWindowCoverage, {
    tradeCount: 4,
    uniqueSignalWindowCount: 0,
    linkedTradeCount: 0,
    signalKeyTradeCount: 0,
    signalTimeFallbackTradeCount: 0,
    unlinkedTradeCount: 4,
    clusteredTradeCount: 0,
    coverageComplete: false
  });
  assert.equal(result.promoted, false);
});

test('completed paper trade coverage groups identical signal windows without claiming independence', () => {
  assert.deepEqual(summarizePaperSignalWindowCoverage([
    { signalKey: '2026-09-24T09:35:00', coin: 'KRW-BTC' },
    { signalKey: '2026-09-24T09:35:00', coin: 'KRW-ETH' },
    { signalKey: '2026-09-24T09:50:00', coin: 'KRW-XRP' },
    { signalTime: '2026-09-24T10:05:00', coin: 'KRW-SOL' },
    { coin: 'KRW-DOGE' }
  ]), {
    tradeCount: 5,
    uniqueSignalWindowCount: 3,
    linkedTradeCount: 4,
    signalKeyTradeCount: 3,
    signalTimeFallbackTradeCount: 1,
    unlinkedTradeCount: 1,
    clusteredTradeCount: 1,
    coverageComplete: false
  });
});

test('paper exit evidence accepts diagnostic netProfit as the selected profit field', () => {
  const result = summarizePaperExitEvidence([
    { reason: 'MAX_HOLD_TIME', netProfit: -12 },
    { reason: 'TAKE_PROFIT', netProfit: 20 }
  ], { profitField: 'netProfit' });

  assert.equal(result.profitField, 'netProfit');
  assert.equal(result.overall.netProfit, 8);
  assert.deepEqual(result.byReason.map(row => row.reason), ['TAKE_PROFIT', 'MAX_HOLD_TIME']);
});

test('paper exit evidence CLI accepts an output directory and writes a read-only report', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-paper-exit-cli-'));
  const ledgerDir = path.join(root, 'ledger');
  const outputFile = path.join(root, 'exit-evidence.json');
  fs.mkdirSync(ledgerDir);
  fs.writeFileSync(path.join(ledgerDir, 'paper_validation.json'), JSON.stringify({
    sessionId: 'exit-cli-fixture',
    active: true,
    strictTrades: [{ reason: 'MAX_HOLD_TIME', profit: 12, profitPercent: 0.12 }],
    shadow: { closedTrades: [{ reason: 'MAX_HOLD_TIME', netProfit: -5, profitPercent: -0.05 }] },
    looseShadow: { closedTrades: [] }
  }), 'utf8');

  try {
    const result = spawnSync(process.execPath, [
      'src/scripts/analyzePaperExitEvidence.js',
      ledgerDir,
      outputFile
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /strict 1 trades/);
    const report = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
    assert.equal(report.sessionId, 'exit-cli-fixture');
    assert.equal(report.strict.overall.netProfit, 12);
    assert.equal(report.shadow.overall.netProfit, -5);
    assert.equal(report.promoted, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
