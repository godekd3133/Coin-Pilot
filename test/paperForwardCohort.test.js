import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarizePaperForwardCohort } from '../src/research/paperForwardCohort.js';

function modeledStrictTrade(profit, ledgerKey) {
  return {
    action: 'CLOSE',
    type: 'CLOSE',
    coin: 'KRW-BTC',
    entryPrice: 100,
    exitPrice: 100,
    amount: 1,
    profit,
    ledgerKey,
    paperExecutionCostModel: 'strict_paper_cost_model_v1',
    paperExecutionSlippageRate: 0.001,
    paperExecutionTradingFeeRate: 0.0005
  };
}

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
      configSnapshot: { signalProfile: 'rsi_rebound', stopLossPercent: 1.2, slippage: 0.001, tradingFee: 0.0005 },
      strictTrades: [modeledStrictTrade(100, 'a-close-1'), modeledStrictTrade(-40, 'a-close-2')],
      strictOpenPositions: {},
      shadow: { trades: [{ profit: 999 }], openPositions: {} },
      stopReason: 'stopped_cleanly',
      analysisDataHealth: { continuityEligible: true }
    }));
    fs.writeFileSync(path.join(root, '.paper-forward-b', 'paper_validation.json'), JSON.stringify({
      configSnapshotComplete: true,
      configSnapshot: { signalProfile: 'bb_reclaim', stopLossPercent: 0.8 },
      strictTrades: [modeledStrictTrade(-20, 'b-close-1')],
      looseShadow: { trades: [{ profit: 1 }] },
      strictOpenPositions: {},
      stopReason: 'risk_data_gap'
    }));
    fs.writeFileSync(path.join(root, '.paper-forward-c', 'paper_validation.json'), JSON.stringify({
      startedAt: '2026-01-02T00:00:00.000Z',
      endedAt: '2026-01-02T01:00:00.000Z',
      configSnapshotComplete: true,
      configSnapshot: { signalProfile: 'rsi_rebound', stopLossPercent: 1.2, slippage: 0.001, tradingFee: 0.0005 },
      strictTrades: [modeledStrictTrade(50, 'c-close-1')],
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
      strictTrades: [modeledStrictTrade(-10, 'd-close-1')],
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
    assert.equal(report.profitabilityEvidenceProfitBasis, 'per_trade_cost_audit_adjusted_net_pnl');
    assert.equal(report.actualFillsObserved, false);
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
        configSnapshot: { ...configSnapshot, slippage: 0.001, tradingFee: 0.0005 },
        strictTrades: [modeledStrictTrade(profit, `${name}-close-1`)],
        strictOpenPositions: {},
        shadow: { trades: [], openPositions: {} },
        stopReason: 'stopped_cleanly',
        analysisDataHealth: { continuityEligible: true },
        riskMonitor: { continuityEligible: true }
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
      configSnapshot: { signalProfile: 'rsi_rebound', stopLossPercent: 1.2, slippage: 0.001, tradingFee: 0.0005 },
      thresholds: { minDays: 7, minTrades: 20 },
      strictTrades: Array.from({ length: 20 }, (_, index) => modeledStrictTrade(2, `short-${index}`)),
      strictOpenPositions: {},
      shadow: { trades: [], openPositions: {} },
      stopReason: 'stopped_cleanly',
      analysisDataHealth: { continuityEligible: true },
      riskMonitor: { continuityEligible: true }
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

test('paper forward continuity keeps legacy cohort comparison but requires verified analysis and risk continuity for profitability', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-paper-cohort-continuity-'));
  try {
    const cases = [
      ['risk-false', true, false, false, false, 'continuity_ineligible'],
      ['both-true', true, true, true, true, null],
      ['analysis-false', false, true, false, false, 'continuity_ineligible'],
      ['both-false', false, false, false, false, 'continuity_ineligible'],
      ['analysis-missing', undefined, true, null, true, 'continuity_unverified'],
      ['risk-missing', true, undefined, null, true, 'continuity_unverified'],
      ['both-missing', undefined, undefined, null, true, 'continuity_unverified'],
      ['analysis-false-risk-missing', false, undefined, false, false, 'continuity_ineligible'],
      ['analysis-missing-risk-false', undefined, false, false, false, 'continuity_ineligible']
    ];

    for (const [name, analysisContinuity, riskContinuity] of cases) {
      const directory = path.join(root, `.paper-forward-${name}`);
      fs.mkdirSync(directory);
      const ledger = {
        active: false,
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-08T00:00:00.000Z',
        configSnapshotComplete: true,
        configSnapshot: { signalProfile: 'rsi_rebound', slippage: 0.001, tradingFee: 0.0005 },
        thresholds: { minDays: 7, minTrades: 20 },
        strictTrades: Array.from({ length: 20 }, (_, index) => modeledStrictTrade(2, `${name}-${index}`)),
        strictOpenPositions: {},
        shadow: { trades: [], openPositions: {} },
        stopReason: 'stopped_cleanly'
      };
      if (analysisContinuity !== undefined) ledger.analysisDataHealth = { continuityEligible: analysisContinuity };
      if (riskContinuity !== undefined) ledger.riskMonitor = { continuityEligible: riskContinuity };
      fs.writeFileSync(path.join(directory, 'paper_validation.json'), JSON.stringify(ledger));
    }

    const report = summarizePaperForwardCohort({ rootDir: root });
    const byName = Object.fromEntries(report.sessions.map(session => [session.directoryName, session]));
    for (const [name, analysis, risk, combined, strictEligible, profitabilityReason] of cases) {
      const session = byName[`.paper-forward-${name}`];
      assert.equal(session.strictCohortEligible, strictEligible, `${name}: strict cohort eligibility`);
      assert.equal(session.profitabilityEvidenceEligible, name === 'both-true', `${name}: profitability eligibility`);
      assert.equal(session.analysisContinuityEligible, analysis ?? null, `${name}: analysis continuity`);
      assert.equal(session.riskContinuityEligible, risk ?? null, `${name}: risk continuity`);
      assert.equal(session.continuityEligible, combined, `${name}: combined continuity`);
      if (profitabilityReason) {
        assert.ok(session.profitabilityEvidenceExclusionReasons.includes(profitabilityReason), `${name}: ${profitabilityReason}`);
      }
    }
    assert.equal(report.eligibleStrictSessionCount, 4);
    assert.equal(report.eligibleStrictTradeCount, 80);
    assert.equal(report.profitabilityEvidenceSessionCount, 1);
    assert.equal(report.profitabilityEvidenceTradeCount, 20);
    assert.equal(report.profitabilityEvidenceProfit, 40);
    assert.equal(report.strictCohortExclusionCounts.continuity_ineligible, 5);
    assert.equal(report.profitabilityEvidenceExclusionCounts.continuity_ineligible, 5);
    assert.equal(report.profitabilityEvidenceExclusionCounts.continuity_unverified, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('paper forward heartbeat continuity enforces recorded interruption limits and leaves malformed history unverified', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-paper-cohort-heartbeat-'));
  try {
    const cases = [
      ['over-default', [{ gapMs: 900001 }], undefined, false, false, 'continuity_ineligible'],
      ['boundary-default', [{ gapMs: 900000 }], undefined, true, true, null],
      ['over-custom', [{ gapMs: 600001 }], 10, false, false, 'continuity_ineligible'],
      ['boundary-custom', [{ gapMs: 600000 }], 10, true, true, null],
      ['null-gap', [{ gapMs: null }], undefined, null, false, 'continuity_unverified'],
      ['missing-gap', [{ reason: 'heartbeat_gap' }], undefined, null, false, 'continuity_unverified'],
      ['nan-like-gap', [{ gapMs: 'NaN' }], undefined, null, false, 'continuity_unverified'],
      ['negative-gap', [{ gapMs: -1 }], undefined, null, false, 'continuity_unverified'],
      ['malformed-container', null, undefined, null, false, 'continuity_unverified'],
      ['legacy-absent', undefined, undefined, true, true, null],
      ['empty-array', [], undefined, true, true, null],
      ['invalid-threshold', [{ gapMs: 1000 }], 0, null, false, 'continuity_unverified'],
      ['null-threshold', [{ gapMs: 1000 }], null, null, false, 'continuity_unverified'],
      ['text-threshold', [{ gapMs: 1000 }], '15', null, false, 'continuity_unverified']
    ];

    for (const [name, interruptions, maxHeartbeatGapMinutes] of cases) {
      const directory = path.join(root, `.paper-forward-${name}`);
      fs.mkdirSync(directory);
      const thresholds = { minDays: 7, minTrades: 20 };
      if (maxHeartbeatGapMinutes !== undefined) thresholds.maxHeartbeatGapMinutes = maxHeartbeatGapMinutes;
      const ledger = {
        active: false,
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-08T00:00:00.000Z',
        configSnapshotComplete: true,
        configSnapshot: { signalProfile: 'rsi_rebound', slippage: 0.001, tradingFee: 0.0005 },
        thresholds,
        strictTrades: Array.from({ length: 20 }, (_, index) => modeledStrictTrade(2, `${name}-${index}`)),
        strictOpenPositions: {},
        shadow: { trades: [], openPositions: {} },
        stopReason: 'stopped_cleanly',
        analysisDataHealth: { continuityEligible: true },
        riskMonitor: { continuityEligible: true }
      };
      if (interruptions !== undefined) ledger.interruptions = interruptions;
      fs.writeFileSync(path.join(directory, 'paper_validation.json'), JSON.stringify(ledger));
    }

    const report = summarizePaperForwardCohort({ rootDir: root });
    const byName = Object.fromEntries(report.sessions.map(session => [session.directoryName, session]));
    for (const [name, , , interruptionEligible, profitabilityEligible, exclusionReason] of cases) {
      const session = byName[`.paper-forward-${name}`];
      assert.equal(session.profitabilityEvidenceEligible, profitabilityEligible, `${name}: profitability eligibility`);
      assert.equal(session.strictCohortEligible, interruptionEligible !== false, `${name}: strict cohort eligibility`);
      assert.equal(session.interruptionContinuityEligible, interruptionEligible, `${name}: interruption continuity`);
      assert.equal(session.continuityEligible, interruptionEligible, `${name}: combined continuity`);
      if (exclusionReason) {
        assert.ok(session.profitabilityEvidenceExclusionReasons.includes(exclusionReason), `${name}: ${exclusionReason}`);
      }
    }
    assert.equal(report.eligibleStrictSessionCount, 12);
    assert.equal(report.profitabilityEvidenceSessionCount, 4);
    assert.equal(report.profitabilityEvidenceTradeCount, 80);
    assert.equal(report.strictCohortExclusionCounts.continuity_ineligible, 2);
    assert.equal(report.profitabilityEvidenceExclusionCounts.continuity_ineligible, 2);
    assert.equal(report.profitabilityEvidenceExclusionCounts.continuity_unverified, 8);
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
      configSnapshot: { signalProfile: 'rsi_rebound', stopLossPercent: 1.2, slippage: 0.001, tradingFee: 0.0005 },
      thresholds: { minDays: 7, minTrades: 20 },
      strictTrades: Array.from({ length: 20 }, (_, index) => modeledStrictTrade(2, `runtime-${index}`)),
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
        configSnapshot: { ...configSnapshot, slippage: 0.001, tradingFee: 0.0005 },
        thresholds: { minDays: 7, minTrades: 1 },
        strictTrades: [modeledStrictTrade(profit, `${name}-close-1`)],
        strictOpenPositions: [],
        shadow: { closedTrades: [], positions: {} },
        looseShadow: { closedTrades: [], positions: {} },
        stopReason: 'stopped_cleanly',
        analysisDataHealth: { continuityEligible: true },
        riskMonitor: { continuityEligible: true }
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

test('paper forward profitability uses slippage-adjusted legacy strict trades, not the raw fee-only ledger P&L', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-paper-cohort-cost-stress-'));
  try {
    fs.mkdirSync(path.join(root, '.paper-forward-legacy-cost'));
    fs.writeFileSync(path.join(root, '.paper-forward-legacy-cost', 'paper_validation.json'), JSON.stringify({
      active: false,
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-08T00:00:00.000Z',
      configSnapshotComplete: true,
      configSnapshot: { signalProfile: 'rsi_rebound', slippage: 0.005, tradingFee: 0.0005 },
      thresholds: { minDays: 7, minTrades: 1 },
      strictTrades: [{
        action: 'CLOSE',
        coin: 'KRW-BTC',
        entryPrice: 100,
        exitPrice: 101,
        amount: 1,
        profit: 0.8
      }],
      strictOpenPositions: [],
      shadow: { closedTrades: [], positions: {} },
      looseShadow: { closedTrades: [], positions: {} },
      stopReason: 'stopped_cleanly',
      analysisDataHealth: { continuityEligible: true },
      riskMonitor: { continuityEligible: true }
    }));

    const report = summarizePaperForwardCohort({ rootDir: root });
    const session = report.sessions[0];
    assert.equal(session.strictCohortEligible, true);
    assert.equal(session.strictProfit, 0.8);
    assert.ok(Math.abs(session.strictCostAdjustedProfit - (-0.205)) < 1e-12);
    assert.equal(session.profitabilityEvidenceEligible, true);
    assert.ok(Math.abs(report.eligibleStrictProfit - (-0.205)) < 1e-12);
    assert.ok(Math.abs(report.profitabilityEvidenceProfit - (-0.205)) < 1e-12);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('paper forward cohort blocks profitability when a strict close cannot be cost-audited', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-paper-cohort-cost-missing-'));
  try {
    fs.mkdirSync(path.join(root, '.paper-forward-missing-cost'));
    fs.writeFileSync(path.join(root, '.paper-forward-missing-cost', 'paper_validation.json'), JSON.stringify({
      active: false,
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-08T00:00:00.000Z',
      configSnapshotComplete: true,
      configSnapshot: { signalProfile: 'rsi_rebound' },
      thresholds: { minDays: 7, minTrades: 1 },
      strictTrades: [{ action: 'CLOSE', profit: 500 }],
      strictOpenPositions: [],
      shadow: { closedTrades: [], positions: {} },
      looseShadow: { closedTrades: [], positions: {} },
      stopReason: 'stopped_cleanly',
      analysisDataHealth: { continuityEligible: true }
    }));

    const report = summarizePaperForwardCohort({ rootDir: root });
    const session = report.sessions[0];
    assert.equal(session.strictCohortEligible, false);
    assert.equal(session.strictCohortExclusionReason, 'strict_execution_cost_unverified');
    assert.equal(session.strictCostAdjustedProfit, null);
    assert.equal(report.eligibleStrictSessionCount, 0);
    assert.equal(report.profitabilityEvidenceSessionCount, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
