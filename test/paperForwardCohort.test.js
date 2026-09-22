import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarizePaperForwardCohort } from '../src/research/paperForwardCohort.js';

test('paper forward cohort separates strict and diagnostic trades without promotion', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-paper-cohort-'));
  try {
    fs.mkdirSync(path.join(root, '.paper-forward-a'));
    fs.mkdirSync(path.join(root, '.paper-forward-b'));
    fs.mkdirSync(path.join(root, '.paper-forward-c'));
    fs.mkdirSync(path.join(root, '.paper-forward-d'));
    fs.writeFileSync(path.join(root, '.paper-forward-a', 'paper_validation.json'), JSON.stringify({
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T01:00:00.000Z',
      configSnapshotComplete: true,
      configSnapshot: { signalProfile: 'rsi_rebound', stopLossPercent: 1.2 },
      strictTrades: [{ profit: 100 }, { profit: -40 }],
      strictOpenPositions: {},
      shadow: { trades: [{ profit: 999 }], openPositions: {} },
      stopReason: 'stopped_cleanly',
      analysisDataHealth: { continuityEligible: true }
    }));
    fs.writeFileSync(path.join(root, '.paper-forward-b', 'paper_validation.json'), JSON.stringify({
      configSnapshotComplete: true,
      configSnapshot: { signalProfile: 'bb_reclaim', stopLossPercent: 0.8 },
      strictTrades: [{ profit: -20 }],
      looseShadow: { trades: [{ profit: 1 }] },
      strictOpenPositions: {},
      stopReason: 'risk_data_gap'
    }));
    fs.writeFileSync(path.join(root, '.paper-forward-c', 'paper_validation.json'), JSON.stringify({
      startedAt: '2026-01-02T00:00:00.000Z',
      endedAt: '2026-01-02T01:00:00.000Z',
      configSnapshotComplete: true,
      configSnapshot: { signalProfile: 'rsi_rebound', stopLossPercent: 1.2 },
      strictTrades: [{ profit: 50 }],
      strictOpenPositions: {},
      shadow: { trades: [], openPositions: {} },
      stopReason: 'stopped_cleanly',
      analysisDataHealth: { continuityEligible: true }
    }));
    fs.writeFileSync(path.join(root, '.paper-forward-d', 'paper_validation.json'), JSON.stringify({
      startedAt: '2026-01-03T00:00:00.000Z',
      endedAt: '2026-01-03T01:00:00.000Z',
      configSnapshotComplete: true,
      configSnapshot: { signalProfile: 'bb_reclaim', stopLossPercent: 0.8 },
      strictTrades: [{ profit: -10 }],
      strictOpenPositions: {},
      shadow: { trades: [], openPositions: {} },
      stopReason: 'risk_data_gap',
      analysisDataHealth: { continuityEligible: true }
    }));

    const report = summarizePaperForwardCohort({ rootDir: root });
    assert.equal(report.researchOnly, true);
    assert.equal(report.promoted, false);
    assert.equal(report.sessionCount, 4);
    assert.equal(report.strictTradeCount, 5);
    assert.equal(report.diagnosticTradeCount, 2);
    assert.equal(report.totalStrictProfit, 80);
    assert.equal(report.totalStrictProfitComparable, false);
    assert.equal(report.activeSessionCount, 0);
    assert.equal(report.endedSessionCount, 3);
    assert.equal(report.strictWinningTrades, 2);
    assert.equal(report.eligibleStrictSessionCount, 1);
    assert.equal(report.eligibleStrictTradeCount, 1);
    assert.equal(report.eligibleStrictProfit, null);
    assert.equal(report.eligibleStrictConfigCount, 1);
    assert.equal(report.eligibleStrictProfitAggregation, 'none');
    assert.equal(report.profitabilityEvidenceSessionCount, 0);
    assert.equal(report.profitabilityEvidenceTradeCount, 0);
    assert.equal(report.profitabilityEvidenceConfigCount, 0);
    assert.equal(report.profitabilityEvidenceProfitAggregation, 'none');
    assert.equal(report.profitabilityEvidenceProfit, null);
    assert.deepEqual(report.eligibleStrictConfigGroups.map(group => ({
      configFingerprint: group.configFingerprint,
      sessionCount: group.sessionCount,
      tradeCount: group.tradeCount,
      profit: group.profit
    })), [{
      configFingerprint: report.sessions.find(row => row.directoryName === '.paper-forward-c').configFingerprint,
      sessionCount: 1,
      tradeCount: 1,
      profit: 50
    }]);
    assert.equal(report.strictCohortExclusionCounts.diagnostic_trades_present, 1);
    assert.equal(report.strictCohortExclusionCounts.terminal_risk_data_gap, 1);
    assert.equal(report.stopReasonCounts.stopped_cleanly, 2);
    assert.equal(report.stopReasonCounts.risk_data_gap, 2);
    assert.equal(Object.keys(report.configFingerprintCounts).length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('paper forward cohort does not aggregate eligible profit across configs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-paper-cohort-mixed-'));
  try {
    for (const [name, configSnapshot, profit] of [
      ['.paper-forward-a', { signalProfile: 'rsi_rebound', stopLossPercent: 1 }, 120],
      ['.paper-forward-b', { signalProfile: 'bb_reclaim', stopLossPercent: 0.8 }, -80]
    ]) {
      fs.mkdirSync(path.join(root, name));
      fs.writeFileSync(path.join(root, name, 'paper_validation.json'), JSON.stringify({
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T01:00:00.000Z',
        configSnapshotComplete: true,
        configSnapshot,
        strictTrades: [{ profit }],
        strictOpenPositions: {},
        shadow: { trades: [], openPositions: {} },
        stopReason: 'stopped_cleanly',
        analysisDataHealth: { continuityEligible: true }
      }));
    }

    const report = summarizePaperForwardCohort({ rootDir: root });
    assert.equal(report.eligibleStrictSessionCount, 2);
    assert.equal(report.eligibleStrictTradeCount, 2);
    assert.equal(report.eligibleStrictConfigCount, 2);
    assert.equal(report.eligibleStrictProfit, null);
    assert.equal(report.eligibleStrictProfitAggregation, 'none');
    assert.equal(report.profitabilityEvidenceSessionCount, 0);
    assert.equal(report.profitabilityEvidenceTradeCount, 0);
    assert.equal(report.profitabilityEvidenceConfigCount, 0);
    assert.equal(report.profitabilityEvidenceProfitAggregation, 'none');
    assert.deepEqual(report.eligibleStrictConfigGroups.map(group => group.profit).sort((a, b) => a - b), [-80, 120]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('paper forward cohort requires each config to meet its own observation and trade minimums', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-paper-cohort-evidence-'));
  try {
    fs.mkdirSync(path.join(root, '.paper-forward-short'));
    fs.writeFileSync(path.join(root, '.paper-forward-short', 'paper_validation.json'), JSON.stringify({
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-08T00:00:00.000Z',
      configSnapshotComplete: true,
      configSnapshot: { signalProfile: 'rsi_rebound', stopLossPercent: 1.2 },
      thresholds: { minDays: 7, minTrades: 20 },
      strictTrades: Array.from({ length: 20 }, () => ({ profit: 2 })),
      strictOpenPositions: {},
      shadow: { trades: [], openPositions: {} },
      stopReason: 'stopped_cleanly',
      analysisDataHealth: { continuityEligible: true }
    }));

    const report = summarizePaperForwardCohort({ rootDir: root });
    assert.equal(report.eligibleStrictSessionCount, 1);
    assert.equal(report.eligibleStrictTradeCount, 20);
    assert.equal(report.profitabilityEvidenceSessionCount, 1);
    assert.equal(report.profitabilityEvidenceTradeCount, 20);
    assert.equal(report.profitabilityEvidenceConfigCount, 1);
    assert.equal(report.profitabilityEvidenceProfitAggregation, 'single_config');
    assert.equal(report.profitabilityEvidenceProfit, 40);
    assert.equal(report.eligibleStrictProfit, 40);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('paper forward cohort reads the runtime shadow ledger shape and excludes diagnostic outcomes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-paper-cohort-runtime-shape-'));
  try {
    fs.mkdirSync(path.join(root, '.paper-forward-runtime-shape'));
    fs.writeFileSync(path.join(root, '.paper-forward-runtime-shape', 'paper_validation.json'), JSON.stringify({
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-08T00:00:00.000Z',
      configSnapshotComplete: true,
      configSnapshot: { signalProfile: 'rsi_rebound', stopLossPercent: 1.2 },
      thresholds: { minDays: 7, minTrades: 20 },
      strictTrades: Array.from({ length: 20 }, () => ({ profit: 2 })),
      strictOpenPositions: [],
      shadow: {
        positions: { 'KRW-XRP': { coin: 'KRW-XRP' } },
        closedTrades: [{ netProfit: 100 }]
      },
      looseShadow: {
        positions: {},
        closedTrades: [{ netProfit: 50 }]
      },
      winnerShadow: {
        positions: {},
        closedTrades: [{ netProfit: 25 }]
      },
      stopReason: 'stopped_cleanly',
      analysisDataHealth: { continuityEligible: true }
    }));

    const report = summarizePaperForwardCohort({ rootDir: root });
    assert.equal(report.strictTradeCount, 20);
    assert.equal(report.diagnosticTradeCount, 3);
    assert.equal(report.eligibleStrictSessionCount, 0);
    assert.equal(report.profitabilityEvidenceSessionCount, 0);
    assert.equal(report.strictCohortExclusionCounts.diagnostic_trades_present, 1);
    assert.equal(report.sessions[0].shadowOpenPositionCount, 1);
    assert.equal(report.sessions[0].looseShadowOpenPositionCount, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('paper forward cohort fingerprints the same config independent of object key order', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-paper-cohort-stable-fingerprint-'));
  try {
    for (const [name, configSnapshot, profit] of [
      ['.paper-forward-order-a', { signalProfile: 'rsi_rebound', stopLossPercent: 1.2 }, 40],
      ['.paper-forward-order-b', { stopLossPercent: 1.2, signalProfile: 'rsi_rebound' }, -10]
    ]) {
      fs.mkdirSync(path.join(root, name));
      fs.writeFileSync(path.join(root, name, 'paper_validation.json'), JSON.stringify({
        active: false,
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-08T00:00:00.000Z',
        configSnapshotComplete: true,
        configSnapshot,
        thresholds: { minDays: 7, minTrades: 1 },
        strictTrades: [{ profit }],
        strictOpenPositions: [],
        shadow: { closedTrades: [], positions: {} },
        looseShadow: { closedTrades: [], positions: {} },
        stopReason: 'stopped_cleanly',
        analysisDataHealth: { continuityEligible: true }
      }));
    }

    const report = summarizePaperForwardCohort({ rootDir: root });
    assert.equal(report.eligibleStrictConfigCount, 1);
    assert.equal(report.profitabilityEvidenceConfigCount, 1);
    assert.equal(report.profitabilityEvidenceProfit, 30);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('paper forward cohort never treats an active ledger as an ended evidence session', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-paper-cohort-active-'));
  try {
    fs.mkdirSync(path.join(root, '.paper-forward-active'));
    fs.writeFileSync(path.join(root, '.paper-forward-active', 'paper_validation.json'), JSON.stringify({
      active: true,
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-08T00:00:00.000Z',
      configSnapshotComplete: true,
      configSnapshot: { signalProfile: 'rsi_rebound' },
      strictTrades: [{ profit: 100 }],
      strictOpenPositions: [],
      shadow: { closedTrades: [], positions: {} },
      looseShadow: { closedTrades: [], positions: {} },
      stopReason: 'stopped_cleanly',
      analysisDataHealth: { continuityEligible: true }
    }));

    const report = summarizePaperForwardCohort({ rootDir: root });
    assert.equal(report.eligibleStrictSessionCount, 0);
    assert.equal(report.strictCohortExclusionCounts.session_still_active, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
