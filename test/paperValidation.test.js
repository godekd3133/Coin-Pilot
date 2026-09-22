import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import MultiCoinTrader from '../src/trader/multiCoinTrader.js';
import { createLossCircuitBreakerState } from '../src/risk/lossCircuitBreaker.js';
import { VALIDATION_SNAPSHOT_KEYS, LIVE_GATE_COMPARABLE_KEYS } from '../src/research/scalpingValidationConfig.js';

test('데이터 공백 중지 원인과 미청산 shadow 상태는 다음 paper 세션에 섞이지 않는다', async () => {
  const suffix = `coinpilot-data-gap-boundary-${Date.now()}`;
  const ledger = path.join(os.tmpdir(), `${suffix}.json`);
  const portfolio = path.join(os.tmpdir(), `${suffix}-portfolio.json`);
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    virtualPortfolioFile: portfolio,
    paperValidationFile: ledger,
    useNews: false
  });
  const now = new Date().toISOString();
  const diagnosticPosition = {
    coin: 'KRW-BTC',
    entryPrice: 100_000_000,
    amount: 0.0002,
    investAmount: 20_000,
    entryTimestamp: now,
    signalKey: 'data-gap-signal'
  };
  const diagnosticBook = () => ({
    positions: { 'KRW-BTC': { ...diagnosticPosition } },
    closedTrades: [],
    entryCount: 1,
    realizedProfit: 0,
    totalInvested: 20_000,
    winningTrades: 0,
    losingTrades: 0,
    cooldownUntilByCoin: {},
    consecutiveLossesByCoin: {},
    lossCircuitBreaker: { lossTimestamps: [], cooldownUntil: 0 }
  });

  try {
    trader.strategies = new Map();
    trader.virtualPortfolio = { krwBalance: 1_000_000, holdings: new Map() };
    trader.calculateTotalAssets = async () => 1_000_000;
    trader.riskMonitorState = {
      lastSuccessAt: null,
      lastFailureAt: now,
      currentOutageStartedAt: now,
      lastCheckedAt: now,
      lastFailureCode: 'ENOTFOUND',
      lastFailureMessage: 'getaddrinfo ENOTFOUND api.upbit.com',
      consecutiveFailures: 9,
      totalFailures: 9,
      outageCount: 1,
      maxObservedGapSeconds: 31,
      continuityEligible: false
    };
    trader.paperValidation = {
      schemaVersion: 4,
      sessionId: 'paper-data-gap-fixture',
      active: true,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      endedAt: null,
      processId: process.pid,
      heartbeatAt: now,
      strategyMode: trader.strategyMode,
      strategyProfile: 'rsi_rebound',
      targetCoins: ['KRW-BTC'],
      configSnapshot: trader.getPaperValidationConfigSnapshot(),
      configSnapshotComplete: true,
      baselineAssets: 1_000_000,
      baselineIncludesHoldings: false,
      thresholds: { minDays: 7, minTrades: 20, minReturnPercent: 0.2, maxDrawdownPercent: 15, maxHeartbeatGapMinutes: 15 },
      interruptions: [],
      riskMonitor: { ...trader.riskMonitorState },
      strictTrades: [],
      strictRiskState: { cooldownUntilByCoin: {}, consecutiveLossesByCoin: {}, lossCircuitBreaker: { lossTimestamps: [], cooldownUntil: 0 } },
      strictOpenPositions: [],
      shadow: diagnosticBook(),
      looseShadow: diagnosticBook(),
      telemetry: { cycles: 1, heartbeatAt: now, reasonCounts: {}, rejectionCounts: {} },
      snapshots: [{ timestamp: now, totalAssets: 1_000_000, reason: 'session_start' }]
    };

    trader.stop('risk_data_gap');
    const stopped = await trader.stopPaperValidationSession();
    assert.equal(stopped.active, false);
    assert.equal(stopped.stopReason, 'risk_data_gap');
    assert.equal(stopped.endedWithDiagnosticOpenPositions, true);
    assert.equal(stopped.continuityEligible, false);

    const resumedTrader = new MultiCoinTrader({
      strategyMode: 'oversold_reaction_scalping',
      targetCoins: ['KRW-BTC'],
      dryRun: true,
      dryRunSeedMoney: 1_000_000,
      virtualPortfolioFile: portfolio,
      paperValidationFile: ledger,
      useNews: false
    });
    resumedTrader.strategies = new Map();
    resumedTrader.calculateTotalAssets = async () => 1_000_000;
    await assert.rejects(
      () => resumedTrader.startPaperValidationSession(),
      /미청산.*(?:shadow|진단)/i
    );
    resumedTrader.stopPositionRiskMonitor();
  } finally {
    trader.stopPositionRiskMonitor();
    for (const file of [ledger, portfolio]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
});

test('forward paper 세션은 기존 포트폴리오와 별도 ledger로 시작/중지된다', async () => {
  const ledger = path.join(os.tmpdir(), `coinpilot-paper-${Date.now()}.json`);
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false
  });

  try {
    trader.paperValidationFile = ledger;
    trader.virtualPortfolio = { krwBalance: 1_000_000, holdings: new Map() };
    trader.strategies = new Map();
    trader.calculateTotalAssets = async () => 1_000_000;

    const started = await trader.startPaperValidationSession();
    assert.equal(started.available, true);
    assert.equal(started.active, true);
    assert.equal(started.baselineIncludesHoldings, false);
    assert.equal(started.configSnapshotComplete, true);
    assert.equal(started.configConsistent, true);
    assert.equal(fs.existsSync(ledger), true);

    const activeStatus = await trader.getPaperValidationStatus();
    assert.equal(activeStatus.eligible, false);
    assert.equal(activeStatus.exitEvidence.researchOnly, true);
    assert.equal(activeStatus.exitEvidence.promoted, false);
    assert.equal(activeStatus.exitEvidence.strict.validTradeCount, 0);
    assert.equal(activeStatus.exitEvidence.shadow.validTradeCount, 0);
    assert.equal(activeStatus.exitEvidence.looseShadow.validTradeCount, 0);
    assert.ok(activeStatus.promotionBlockers.some(blocker => blocker.includes('관찰 세션')));
    assert.ok(activeStatus.promotionBlockers.some(blocker => blocker.includes('청산 표본')));

    const stopped = await trader.stopPaperValidationSession();
    assert.equal(stopped.active, false);
    assert.equal(stopped.state, 'STOPPED');
  } finally {
    if (fs.existsSync(ledger)) fs.unlinkSync(ledger);
  }
});

test('paper runner 오류 기록은 read-only status와 orphan 진단에 보존된다', async () => {
  const ledger = path.join(os.tmpdir(), `coinpilot-paper-terminal-error-${Date.now()}.json`);
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false,
    paperValidationFile: ledger
  });

  try {
    trader.virtualPortfolio = { krwBalance: 1_000_000, holdings: new Map() };
    trader.strategies = new Map();
    trader.calculateTotalAssets = async () => 1_000_000;
    await trader.startPaperValidationSession();
    const terminalError = {
      source: 'uncaught_exception',
      name: 'Error',
      code: 'TEST_FAILURE',
      message: 'fixture failure',
      recordedAt: new Date().toISOString()
    };
    trader.paperValidation.terminalError = terminalError;
    trader.paperValidation.lastError = terminalError;
    trader.savePaperValidation();

    const status = await trader.getPaperValidationStatus();
    assert.deepEqual(status.terminalError, terminalError);

    const reloaded = new MultiCoinTrader({
      strategyMode: 'oversold_reaction_scalping',
      targetCoins: ['KRW-BTC'],
      dryRun: true,
      dryRunSeedMoney: 1_000_000,
      useNews: false,
      paperValidationFile: ledger
    });
    assert.deepEqual((await reloaded.getPaperValidationStatus()).terminalError, terminalError);
  } finally {
    if (fs.existsSync(ledger)) fs.unlinkSync(ledger);
  }
});

test('동일 signal window 진입 상한은 ledger에 보존되고 재시작 후에도 적용된다', async () => {
  const suffix = `coinpilot-signal-window-${Date.now()}`;
  const ledger = path.join(os.tmpdir(), `${suffix}.json`);
  const portfolio = path.join(os.tmpdir(), `${suffix}-portfolio.json`);
  const createTrader = () => new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC', 'KRW-ETH'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false,
    virtualPortfolioFile: portfolio,
    paperValidationFile: ledger,
    maxEntriesPerSignalWindow: 1
  });

  try {
    const trader = createTrader();
    trader.virtualPortfolio = { krwBalance: 1_000_000, holdings: new Map() };
    trader.strategies = new Map();
    trader.calculateTotalAssets = async () => 1_000_000;
    await trader.startPaperValidationSession();

    assert.equal(trader.isStrictEntryBlockedBySignalWindow('same-candle'), false);
    trader.recordStrictSignalWindowEntry('same-candle');
    assert.equal(trader.isStrictEntryBlockedBySignalWindow('same-candle'), true);
    assert.equal(trader.getStrictSignalWindowStatus().lastEntryCount, 1);

    const reloaded = createTrader();
    reloaded.calculateTotalAssets = async () => 1_000_000;
    assert.equal(reloaded.isStrictEntryBlockedBySignalWindow('same-candle'), true);
    assert.equal(reloaded.getPaperValidationConfigSnapshot().maxEntriesPerSignalWindow, 1);
  } finally {
    for (const file of [ledger, portfolio]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
});

test('미청산 strict 포지션으로 끝난 session은 명시적 resume/reset 없이 재사용할 수 없다', async () => {
  const suffix = `coinpilot-unsettled-stop-${Date.now()}`;
  const ledger = path.join(os.tmpdir(), `${suffix}.json`);
  const portfolio = path.join(os.tmpdir(), `${suffix}-portfolio.json`);
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false,
    virtualPortfolioFile: portfolio,
    paperValidationFile: ledger
  });

  try {
    trader.virtualPortfolio = { krwBalance: 1_000_000, holdings: new Map() };
    trader.strategies = new Map();
    trader.calculateTotalAssets = async () => 1_000_000;
    await trader.startPaperValidationSession();
    trader.getStrategy('KRW-BTC').openPosition(100, 1, 'BUY');

    const stopped = await trader.stopPaperValidationSession();
    assert.equal(stopped.endedWithOpenPositions, true);
    assert.equal(stopped.stopReason, 'stopped_with_unsettled_strict_positions');
    assert.deepEqual(stopped.strictEvaluation.positions.map(position => position.coin), ['KRW-BTC']);
    await assert.rejects(
      () => trader.startPaperValidationSession(),
      /strict 미청산 포지션/
    );
  } finally {
    for (const file of [ledger, portfolio]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
});

test('soft 후보는 strict 포트폴리오와 분리된 shadow 장부로만 추적된다', async () => {
  const ledger = path.join(os.tmpdir(), `coinpilot-shadow-${Date.now()}.json`);
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false,
    investmentRatio: 0.02,
    stopLossPercent: 1.2,
    takeProfitPercent: 1.8,
    tradingFee: 0.0005,
    slippage: 0
  });

  try {
    trader.paperValidationFile = ledger;
    trader.virtualPortfolio = { krwBalance: 1_000_000, holdings: new Map() };
    trader.strategies = new Map();
    trader.calculateTotalAssets = async () => 1_000_000;

    await trader.startPaperValidationSession();
    const rebound = {
      available: true,
      previousWasOversold: true,
      bullishCandle: true,
      priceChangePercent: 0.2,
      reboundPriceChangePercent: 0.2,
      rsiRecovery: 2,
      signalKey: '2026-09-09T00:01:00',
      rejectionReasons: ['previous_high_break_failed']
    };
    trader.recordPaperSignalTelemetry([{
      coin: 'KRW-BTC',
      currentPrice: 100,
      decision: { action: 'HOLD', reason: 'soft 후보', details: { rebound } }
    }]);

    const started = await trader.getPaperValidationStatus();
    assert.equal(started.closedTradeCount, 0);
    assert.equal(started.shadowEvaluation.entryCount, 1);
    assert.equal(started.shadowEvaluation.activePositions, 1);
    assert.equal(started.shadowEvaluation.positions.length, 1);
    assert.equal(started.shadowEvaluation.positions[0].coin, 'KRW-BTC');
    assert.equal(started.shadowEvaluation.positions[0].maxFavorableExcursionPercent, 0);
    assert.equal(started.shadowEvaluation.positions[0].maxAdverseExcursionPercent, 0);
    assert.equal(trader.virtualPortfolio.krwBalance, 1_000_000);

    trader.recordPaperSignalTelemetry([{
      coin: 'KRW-BTC',
      currentPrice: 102,
      decision: { action: 'HOLD', reason: 'soft 후보 종료 확인', details: { rebound } }
    }]);

    const closed = await trader.getPaperValidationStatus();
    assert.equal(closed.closedTradeCount, 0);
    assert.equal(closed.shadowEvaluation.closedTradeCount, 1);
    assert.ok(closed.shadowEvaluation.realizedProfit > 0);
    assert.equal(closed.shadowEvaluation.activePositions, 0);
    assert.deepEqual(closed.shadowEvaluation.positions, []);
    assert.equal(closed.shadowEvaluation.recentTrades.length, 1);
    assert.equal(closed.shadowEvaluation.recentTrades[0].coin, 'KRW-BTC');
    assert.ok(closed.shadowEvaluation.recentTrades[0].netProfit > 0);
    assert.equal(closed.shadowEvaluation.recentTrades[0].maxFavorableExcursionPercent, 2);
    assert.equal(closed.shadowEvaluation.recentTrades[0].maxAdverseExcursionPercent, 0);
    assert.equal(closed.shadowEvaluation.rejectionOutcomes[0].reason, 'previous_high_break_failed');
    assert.equal(closed.shadowEvaluation.rejectionOutcomes[0].tradeCount, 1);
    assert.equal(trader.virtualPortfolio.krwBalance, 1_000_000);
  } finally {
    if (fs.existsSync(ledger)) fs.unlinkSync(ledger);
  }
});

test('relaxed shadow는 strict 진입 추격 한도를 넘는 가상 진입을 기록하지 않는다', async () => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    maxEntryRetracePercent: 0.25,
    maxEntryChasePercent: 0.35,
    useNews: false
  });
  trader.calculateTotalAssets = async () => 1_000_000;
  trader.savePaperValidation = () => {};
  trader.paperValidation = {
    active: true,
    baselineAssets: 1_000_000,
    telemetry: {},
    shadow: { positions: {}, closedTrades: [] },
    looseShadow: { positions: {}, closedTrades: [] }
  };

  trader.recordPaperSignalTelemetry([{
    coin: 'KRW-BTC',
    currentPrice: 101,
    decision: {
      action: 'HOLD',
      reason: '추격 한도 테스트',
      details: {
        rebound: {
          available: true,
          previousWasOversold: true,
          bullishCandle: true,
          referencePrice: 100,
          reboundPriceChangePercent: 0.5,
          priceChangePercent: 0.5,
          rsiRecovery: 2,
          signalKey: 'shadow-chase-limit',
          rejectionReasons: ['previous_high_break_failed']
        }
      }
    }
  }]);

  assert.equal(trader.paperValidation.shadow.entryCount, 0);
  assert.equal(trader.paperValidation.looseShadow.entryCount, 0);
  assert.equal(trader.paperValidation.telemetry.shadowEntryExecutionBlockedEntries, 1);
  assert.equal(trader.paperValidation.telemetry.looseShadowEntryExecutionBlockedEntries, 1);
  assert.equal(trader.paperValidation.telemetry.shadowEntryExecutionBlockReasons.entry_chase_exceeded, 1);
  assert.equal(trader.paperValidation.telemetry.looseShadowEntryExecutionBlockReasons.entry_chase_exceeded, 1);

  trader.recordPaperSignalTelemetry([{
    coin: 'KRW-BTC',
    currentPrice: 99,
    decision: {
      action: 'HOLD',
      reason: '되밀림 한도 테스트',
      details: {
        rebound: {
          available: true,
          previousWasOversold: true,
          bullishCandle: true,
          referencePrice: 100,
          reboundPriceChangePercent: 0.5,
          priceChangePercent: 0.5,
          rsiRecovery: 2,
          signalKey: 'shadow-retrace-limit',
          rejectionReasons: ['previous_high_break_failed']
        }
      }
    }
  }]);

  assert.equal(trader.paperValidation.shadow.entryCount, 0);
  assert.equal(trader.paperValidation.looseShadow.entryCount, 0);
  assert.equal(trader.paperValidation.telemetry.shadowEntryExecutionBlockedEntries, 2);
  assert.equal(trader.paperValidation.telemetry.looseShadowEntryExecutionBlockedEntries, 2);
  assert.equal(trader.paperValidation.telemetry.shadowEntryExecutionBlockReasons.entry_retrace_exceeded, 1);
  assert.equal(trader.paperValidation.telemetry.looseShadowEntryExecutionBlockReasons.entry_retrace_exceeded, 1);

  trader.recordPaperSignalTelemetry([{
    coin: 'KRW-BTC',
    currentPrice: 100.2,
    decision: {
      action: 'HOLD',
      reason: '허용 범위 테스트',
      details: {
        rebound: {
          available: true,
          previousWasOversold: true,
          bullishCandle: true,
          referencePrice: 100,
          reboundPriceChangePercent: 0.5,
          priceChangePercent: 0.5,
          rsiRecovery: 2,
          signalKey: 'shadow-execution-within-limit',
          rejectionReasons: ['previous_high_break_failed']
        }
      }
    }
  }]);

  assert.equal(trader.paperValidation.shadow.entryCount, 1);
  assert.equal(trader.paperValidation.looseShadow.entryCount, 1);
});

test('execution-boundary 차단은 실제 shadow 체결과 분리된 counterfactual로만 정산된다', async () => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    investmentRatio: 0.02,
    maxEntryRetracePercent: 0.25,
    maxEntryChasePercent: 0.35,
    stopLossPercent: 1.2,
    takeProfitPercent: 1.8,
    tradingFee: 0.0005,
    slippage: 0.001,
    useNews: false
  });
  trader.calculateTotalAssets = async () => 1_000_000;
  trader.savePaperValidation = () => {};
  trader.paperValidation = {
    active: true,
    startedAt: '2026-09-13T14:00:00.000Z',
    processId: process.pid,
    baselineAssets: 1_000_000,
    strictTrades: [],
    strictOpenPositions: [],
    strictRiskState: { cooldownUntilByCoin: {}, consecutiveLossesByCoin: {}, lossCircuitBreaker: {} },
    thresholds: { minDays: 7, minTrades: 20, minReturnPercent: 0.2, maxDrawdownPercent: 15 },
    configSnapshot: trader.getPaperValidationConfigSnapshot(),
    configSnapshotComplete: true,
    snapshots: [{ timestamp: '2026-09-13T14:00:00.000Z', totalAssets: 1_000_000 }],
    telemetry: {},
    shadow: { positions: {}, closedTrades: [], entryCount: 0, realizedProfit: 0, totalInvested: 0, winningTrades: 0, losingTrades: {} },
    looseShadow: { positions: {}, closedTrades: [], entryCount: 0, realizedProfit: 0, totalInvested: 0, winningTrades: 0, losingTrades: {} }
  };
  const blockedAnalysis = {
    coin: 'KRW-BTC',
    currentPrice: 101,
    decision: {
      details: {
        rebound: {
          available: true,
          previousWasOversold: true,
          bullishCandle: true,
          referencePrice: 100,
          reboundPriceChangePercent: 0.5,
          rsi: 35,
          oversoldRsi: 30,
          rsiRecovery: 5,
          signalKey: 'execution-boundary-counterfactual',
          candleTime: '2026-09-13T14:00:00.000Z',
          rejectionReasons: ['previous_high_break_failed']
        }
      }
    }
  };
  const laterAnalysis = { ...blockedAnalysis, currentPrice: 103 };

  try {
    assert.equal(trader.recordExecutionBoundaryBlockedEntry(blockedAnalysis, 'shadow', 'entry_chase_exceeded', '2026-09-13T14:00:00.000Z'), true);
    assert.equal(trader.recordExecutionBoundaryBlockedEntry(blockedAnalysis, 'looseShadow', 'entry_chase_exceeded', '2026-09-13T14:00:00.000Z'), true);
    assert.equal(trader.paperValidation.shadow.entryCount, 0);
    assert.equal(trader.paperValidation.looseShadow.entryCount, 0);

    assert.equal(trader.updateExecutionBoundaryBlockedEntries(laterAnalysis, 'shadow', '2026-09-13T14:02:00.000Z'), 1);
    assert.equal(trader.updateExecutionBoundaryBlockedEntries(laterAnalysis, 'looseShadow', '2026-09-13T14:02:00.000Z'), 1);
    const shadowSummary = trader.getExecutionBoundaryBlockedEntrySummary(trader.paperValidation.shadow);
    const looseSummary = trader.getExecutionBoundaryBlockedEntrySummary(trader.paperValidation.looseShadow);
    assert.equal(shadowSummary.blockedEntryCount, 1);
    assert.equal(shadowSummary.settledCount, 1);
    assert.equal(shadowSummary.pendingCount, 0);
    assert.equal(shadowSummary.unresolvedCount, 0);
    assert.ok(shadowSummary.counterfactualRealizedProfit > 0);
    assert.equal(shadowSummary.counterfactualLossAvoidanceCount, 0);
    assert.equal(shadowSummary.counterfactualMissedProfitCount, 1);
    assert.ok(shadowSummary.counterfactualMissedProfitAmount > 0);
    assert.deepEqual(shadowSummary.reasonOutcomes, [{
      reason: 'entry_chase_exceeded',
      blockedCount: 1,
      pendingCount: 0,
      settledCount: 1,
      unresolvedCount: 0,
      counterfactualRealizedProfit: shadowSummary.counterfactualRealizedProfit
    }]);
    assert.equal(looseSummary.settledCount, 1);
    assert.equal(trader.paperValidation.shadow.closedTrades.length, 0);
    assert.equal(trader.paperValidation.looseShadow.closedTrades.length, 0);
  } finally {
    trader.stopPositionRiskMonitor();
  }
});

test('session stop은 미정산 execution-boundary counterfactual을 unknown으로 남긴다', () => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false
  });
  trader.paperValidation = {
    active: true,
    baselineAssets: 1_000_000,
    shadow: { executionBoundaryBlockedEntries: [] },
    looseShadow: { executionBoundaryBlockedEntries: [] }
  };
  const analysis = {
    coin: 'KRW-BTC',
    currentPrice: 101,
    decision: { details: { rebound: { signalKey: 'pending-boundary', referencePrice: 100 } } }
  };
  try {
    assert.equal(trader.recordExecutionBoundaryBlockedEntry(analysis, 'shadow', 'entry_retrace_exceeded', '2026-09-13T14:00:00.000Z'), true);
    assert.equal(trader.resolveExecutionBoundaryBlockedEntriesAtStop('2026-09-13T14:01:00.000Z'), 1);
    const summary = trader.getExecutionBoundaryBlockedEntrySummary(trader.paperValidation.shadow);
    assert.equal(summary.settledCount, 0);
    assert.equal(summary.pendingCount, 0);
    assert.equal(summary.unresolvedCount, 1);
    assert.equal(summary.counterfactualRealizedProfit, 0);
  } finally {
    trader.stopPositionRiskMonitor();
  }
});

test('session stop은 pending boundary가 남으면 clean stop으로 오인하지 않는다', async () => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false
  });
  trader.savePaperValidation = () => {};
  trader.paperValidation = {
    active: true,
    baselineAssets: 1_000_000,
    shadow: { executionBoundaryBlockedEntries: [] },
    looseShadow: { executionBoundaryBlockedEntries: [] }
  };
  const analysis = {
    coin: 'KRW-BTC',
    currentPrice: 101,
    decision: { details: { rebound: { signalKey: 'pending-stop-boundary', referencePrice: 100 } } }
  };
  try {
    assert.equal(trader.recordExecutionBoundaryBlockedEntry(analysis, 'shadow', 'entry_retrace_exceeded', '2026-09-13T14:00:00.000Z'), true);
    const status = await trader.stopPaperValidationSession();
    assert.equal(status.active, false);
    assert.equal(status.stopReason, 'stopped_with_unsettled_boundary_counterfactuals');
    assert.equal(status.pendingCounterfactualCountAtStop, 1);
    assert.equal(status.endedWithDiagnosticOpenPositions, false);
    assert.equal(trader.paperValidation.shadow.executionBoundaryBlockedEntries[0].status, 'unresolved');
  } finally {
    trader.stopPositionRiskMonitor();
  }
});

test('winner shadow는 strict confirmed signal만 복제하고 winner-hold exit를 별도 평가한다', async () => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false,
    winnerShadowExtendMinutes: 30,
    winnerShadowExtendMinProfitPercent: 0
  });
  trader.calculateTotalAssets = async () => 1_000_000;
  trader.savePaperValidation = () => {};
  trader.paperValidation = {
    active: true,
    startedAt: new Date().toISOString(),
    baselineAssets: 1_000_000,
    processId: process.pid,
    configSnapshot: trader.getPaperValidationConfigSnapshot(),
    configSnapshotComplete: true,
    paperExperiments: trader.getPaperExperimentSnapshot(),
    strictTrades: [],
    strictOpenPositions: [],
    telemetry: {},
    shadow: { positions: {}, closedTrades: [] },
    looseShadow: { positions: {}, closedTrades: [] },
    winnerShadow: {
      positions: {},
      lastSignalByCoin: {},
      closedTrades: [],
      entryCount: 0,
      realizedProfit: 0,
      totalInvested: 0,
      winningTrades: 0,
      losingTrades: 0,
      cooldownUntilByCoin: {},
      consecutiveLossesByCoin: {},
      lossCircuitBreaker: createLossCircuitBreakerState()
    },
    snapshots: [{ timestamp: new Date().toISOString(), totalAssets: 1_000_000 }]
  };

  const rebound = {
    available: true,
    reboundConfirmed: true,
    previousWasOversold: true,
    bullishCandle: true,
    signalKey: 'winner-shadow-signal',
    candleTime: '2026-09-13T00:00:00Z',
    referencePrice: 100,
    reboundPriceChangePercent: 0.6,
    priceChangePercent: 0.6,
    rsi: 40,
    previousRsi: 20,
    oversoldRsi: 20,
    rsiRecovery: 20,
    volumeRatio: 2,
    closeStrength: 1,
    trendSlopePercent: -0.1,
    signalRangePercent: 0.4,
    rejectionReasons: []
  };
  trader.recordPaperSignalTelemetry([{
    coin: 'KRW-BTC',
    currentPrice: 100,
    decision: { action: 'BUY', details: { rebound } }
  }]);

  const entered = trader.paperValidation.winnerShadow.positions['KRW-BTC'];
  assert.ok(entered);
  assert.equal(trader.paperValidation.winnerShadow.entryCount, 1);
  assert.equal(trader.paperValidation.shadow.entryCount, 0);
  assert.equal(trader.paperValidation.looseShadow.entryCount, 0);

  const entryTime = new Date(entered.entryTimestamp).getTime();
  trader.updatePaperShadowPosition(
    { coin: 'KRW-BTC', currentPrice: 101, decision: { details: { rebound: null } } },
    false,
    new Date(entryTime + 31 * 60 * 1000).toISOString(),
    'winnerShadow',
    { winnerExtendMinutes: 30, winnerExtendMinProfitPercent: 0 }
  );
  assert.equal(trader.paperValidation.winnerShadow.positions['KRW-BTC'].winnerExtended, true);

  trader.updatePaperShadowPosition(
    { coin: 'KRW-BTC', currentPrice: 101, decision: { details: { rebound: null } } },
    false,
    new Date(entryTime + 61 * 60 * 1000).toISOString(),
    'winnerShadow',
    { winnerExtendMinutes: 30, winnerExtendMinProfitPercent: 0 }
  );
  const status = await trader.getPaperValidationStatus();
  assert.equal(status.winnerShadowEvaluation.enabled, true);
  assert.equal(status.winnerShadowEvaluation.closedTradeCount, 1);
  assert.equal(status.winnerShadowEvaluation.recentTrades[0].reason, 'MAX_HOLD_TIME');
  assert.equal(status.winnerShadowEvaluation.recentTrades[0].winnerExtended, true);
  assert.equal(status.winnerShadowEvaluation.realizedProfit > 0, true);
  assert.equal(status.paperExperimentConsistent, true);

  trader.winnerShadowExtendMinutes = 60;
  const drifted = await trader.getPaperValidationStatus();
  assert.equal(drifted.paperExperimentConsistent, false);
  assert.ok(drifted.paperExperimentDrift.includes('winnerExtendMinutes'));
});

test('strict-only forward는 relaxed diagnostic shadow를 생성하지 않고 설정 drift를 감시한다', () => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false,
    paperDiagnosticShadowsEnabled: false
  });
  trader.savePaperValidation = () => {};
  trader.paperValidation = {
    active: true,
    baselineAssets: 1_000_000,
    telemetry: {},
    shadow: { positions: {}, closedTrades: [] },
    looseShadow: { positions: {}, closedTrades: [] }
  };

  trader.recordPaperSignalTelemetry([{
    coin: 'KRW-BTC',
    currentPrice: 100.2,
    decision: {
      action: 'HOLD',
      reason: 'strict-only 진단 비활성화 확인',
      details: {
        rebound: {
          available: true,
          previousWasOversold: true,
          bullishCandle: true,
          referencePrice: 100,
          reboundPriceChangePercent: 0.5,
          priceChangePercent: 0.5,
          rsiRecovery: 2,
          signalKey: 'strict-only-shadow-disabled',
          rejectionReasons: ['previous_high_break_failed']
        }
      }
    }
  }]);

  assert.equal(trader.getPaperExperimentSnapshot().diagnosticShadows.enabled, false);
  assert.equal(trader.paperValidation.shadow.entryCount || 0, 0);
  assert.equal(trader.paperValidation.looseShadow.entryCount || 0, 0);
  assert.equal(trader.paperValidation.telemetry.shadowCandidates || 0, 0);
  assert.equal(trader.paperValidation.telemetry.looseShadowCandidates || 0, 0);
  const recordedStrictOnly = trader.getPaperExperimentSnapshot();
  assert.equal(trader.comparePaperExperimentConfig(recordedStrictOnly).consistent, true);

  trader.paperDiagnosticShadowsEnabled = true;
  const drift = trader.comparePaperExperimentConfig(recordedStrictOnly);
  assert.equal(drift.consistent, false);
  assert.ok(drift.drift.includes('diagnosticShadows.enabled'));
});

test('strict-only paper session은 ledger snapshot에 진단 장부 비활성 상태를 보존한다', async () => {
  const suffix = `coinpilot-strict-only-session-${Date.now()}`;
  const ledger = path.join(os.tmpdir(), `${suffix}.json`);
  const portfolio = path.join(os.tmpdir(), `${suffix}-portfolio.json`);
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    virtualPortfolioFile: portfolio,
    paperValidationFile: ledger,
    useNews: false,
    paperDiagnosticShadowsEnabled: false
  });
  trader.strategies = new Map();
  trader.calculateTotalAssets = async () => 1_000_000;

  try {
    const started = await trader.startPaperValidationSession({ reset: true });
    assert.equal(started.paperExperiments.diagnosticShadows.enabled, false);
    assert.equal(started.shadowEvaluation.closedTradeCount, 0);
    assert.equal(started.looseShadowEvaluation.closedTradeCount, 0);

    const stopped = await trader.stopPaperValidationSession();
    assert.equal(stopped.active, false);
    assert.equal(stopped.paperExperiments.diagnosticShadows.enabled, false);
    assert.equal(stopped.endedWithDiagnosticOpenPositions, false);
    const persisted = JSON.parse(fs.readFileSync(ledger, 'utf8'));
    assert.equal(persisted.paperExperiments.diagnosticShadows.enabled, false);
  } finally {
    trader.stopPositionRiskMonitor();
    for (const file of [ledger, portfolio]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
});

test('runtime config snapshot은 선언된 validation contract 키를 모두 방출한다', () => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false
  });
  const snapshot = trader.getPaperValidationConfigSnapshot();
  const missing = VALIDATION_SNAPSHOT_KEYS.filter(key => !(key in snapshot));
  assert.deepEqual(missing, []);
});

test('live gate 비교 키는 runtime snapshot과 authoritative validation lane에서 모두 기록 가능해야 한다', () => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false
  });
  const snapshot = trader.getPaperValidationConfigSnapshot();
  const unemitted = LIVE_GATE_COMPARABLE_KEYS.filter(key => !(key in snapshot));
  assert.deepEqual(unemitted, []);

  // A gate-compared key that no validation lane can record dead-locks every
  // fixed report on missingKeys (the entryDelay regression). The authoritative
  // lane is a main script, so scan its source for a `key:` binding.
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src/scripts/validateScalping.js'),
    'utf8'
  );
  const unrecordable = LIVE_GATE_COMPARABLE_KEYS.filter(key => !source.includes(`${key}:`));
  assert.deepEqual(unrecordable, []);
});

test('resolveShadowExitConfig는 winnerShadow 기본 exit 계약을 파생하고 명시적 override를 우선한다', () => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false,
    maxHoldMinutes: 30,
    winnerExtendMinutes: 15,
    winnerExtendMinProfitPercent: 0.4,
    winnerShadowExtendMinutes: 45,
    winnerShadowExtendMinProfitPercent: 0.1
  });

  const derived = trader.resolveShadowExitConfig('winnerShadow');
  assert.equal(derived.winnerExtendMinutes, 45);
  assert.equal(derived.winnerExtendMinProfitPercent, 0.1);
  assert.equal(derived.maxHoldMinutes, 30);

  const overridden = trader.resolveShadowExitConfig('winnerShadow', {
    winnerExtendMinutes: 7,
    winnerExtendMinProfitPercent: 0.2
  });
  assert.equal(overridden.winnerExtendMinutes, 7);
  assert.equal(overridden.winnerExtendMinProfitPercent, 0.2);

  for (const stateKey of ['shadow', 'looseShadow']) {
    const strict = trader.resolveShadowExitConfig(stateKey);
    assert.equal(strict.winnerExtendMinutes, 15);
    assert.equal(strict.winnerExtendMinProfitPercent, 0.4);
    assert.equal(strict.maxHoldMinutes, 30);
  }
});

test('winner shadow의 rebound ceiling은 strict baseline을 바꾸지 않고 같은 BUY만 필터링한다', async () => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false,
    winnerShadowMaxReboundPercent: 0.4
  });
  trader.calculateTotalAssets = async () => 1_000_000;
  trader.savePaperValidation = () => {};
  trader.paperValidation = {
    active: true,
    startedAt: new Date().toISOString(),
    baselineAssets: 1_000_000,
    processId: process.pid,
    configSnapshot: trader.getPaperValidationConfigSnapshot(),
    configSnapshotComplete: true,
    paperExperiments: trader.getPaperExperimentSnapshot(),
    strictTrades: [],
    strictOpenPositions: [],
    telemetry: {},
    shadow: { positions: {}, closedTrades: [] },
    looseShadow: { positions: {}, closedTrades: [] },
    winnerShadow: { positions: {}, closedTrades: [] },
    snapshots: [{ timestamp: new Date().toISOString(), totalAssets: 1_000_000 }]
  };

  const rebound = {
    available: true,
    reboundConfirmed: true,
    previousWasOversold: true,
    bullishCandle: true,
    candleTime: '2026-09-13T00:00:00Z',
    referencePrice: 100,
    reboundPriceChangePercent: 0.6,
    priceChangePercent: 0.6,
    rsi: 40,
    previousRsi: 20,
    oversoldRsi: 20,
    rsiRecovery: 20,
    volumeRatio: 2,
    closeStrength: 1,
    trendSlopePercent: 0,
    signalRangePercent: 0.4,
    rejectionReasons: []
  };

  trader.recordPaperSignalTelemetry([{
    coin: 'KRW-BTC',
    currentPrice: 100,
    decision: { action: 'BUY', details: { rebound: { ...rebound, signalKey: 'too-extended' } } }
  }]);
  assert.equal(trader.paperValidation.winnerShadow.entryCount, 0);
  assert.equal(trader.paperValidation.winnerShadow.positions['KRW-BTC'], undefined);
  assert.equal(trader.paperValidation.winnerShadow.blockedEntries.length, 1);
  assert.equal(trader.paperValidation.winnerShadow.blockedEntries[0].status, 'pending');

  trader.recordPaperSignalTelemetry([{
    coin: 'KRW-BTC',
    currentPrice: 100,
    decision: {
      action: 'BUY',
      details: { rebound: { ...rebound, signalKey: 'within-ceiling', reboundPriceChangePercent: 0.3 } }
    }
  }]);
  const status = await trader.getPaperValidationStatus();
  assert.equal(trader.paperValidation.winnerShadow.entryCount, 1);
  assert.equal(status.winnerShadowEvaluation.enabled, true);
  assert.equal(status.winnerShadowEvaluation.entryMaxReboundPercent, 0.4);
  assert.equal(status.winnerShadowEvaluation.reboundBlockedEntries, 1);
  assert.equal(status.paperExperimentConsistent, true);
  assert.equal(status.closedTradeCount, 0);
  assert.equal(trader.virtualPortfolio.krwBalance, 1_000_000);

  trader.recordPaperStrictTrade('KRW-BTC', {
    id: 'same-signal-close',
    signalKey: 'too-extended',
    entryPrice: 100.1,
    exitPrice: 102,
    amount: 1,
    profit: 1,
    profitPercent: 1,
    reason: 'TAKE_PROFIT',
    exitTime: '2026-09-13T00:10:00Z'
  });
  const settled = await trader.getPaperValidationStatus();
  assert.equal(settled.winnerShadowEvaluation.settledBlockedEntryCount, 1);
  assert.ok(settled.winnerShadowEvaluation.counterfactualRealizedProfit > 0);
  assert.equal(settled.winnerShadowEvaluation.recentBlockedEntries[0].status, 'settled');
});

test('winner shadow blocked signal은 strict 지연 재검증 취소 시 미체결로 종결된다', async () => {
  const ledger = path.join(os.tmpdir(), `coinpilot-winner-not-filled-${Date.now()}.json`);
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false,
    maxCandleAgeSeconds: 90,
    paperValidationFile: ledger,
    winnerShadowMaxReboundPercent: 0.4
  });
  try {
    trader.calculateTotalAssets = async () => 1_000_000;
    trader.sleep = async () => {};
    const now = Date.now();
    const candles = Array.from({ length: 50 }, (_, index) => ({
    candle_date_time_utc: new Date(now - index * 60_000).toISOString(),
    trade_price: 100,
    opening_price: 99,
    high_price: 101,
    low_price: 98,
    candle_acc_trade_volume: 100
    }));
    trader.upbit = {
    async getTicker() {
      return [{ market: 'KRW-BTC', trade_price: 100 }];
    },
    async getMinuteCandles() {
      return candles;
    }
    };
    trader.buildTechnicalAnalysis = () => ({ indicators: {} });
    trader.paperValidation = {
    active: true,
    startedAt: new Date(now).toISOString(),
    baselineAssets: 1_000_000,
    processId: process.pid,
    configSnapshot: trader.getPaperValidationConfigSnapshot(),
    configSnapshotComplete: true,
    paperExperiments: trader.getPaperExperimentSnapshot(),
    strictTrades: [],
    strictOpenPositions: [],
    telemetry: {},
    shadow: { positions: {}, closedTrades: [] },
    looseShadow: { positions: {}, closedTrades: [] },
    winnerShadow: { positions: {}, closedTrades: [], blockedEntries: [] },
    snapshots: [{ timestamp: new Date(now).toISOString(), totalAssets: 1_000_000 }]
    };

    const rebound = {
    available: true,
    reboundConfirmed: true,
    previousWasOversold: true,
    bullishCandle: true,
    signalKey: 'cancelled-winner-signal',
    candleTime: new Date(now - 60_000).toISOString(),
    referencePrice: 100,
    reboundPriceChangePercent: 0.6,
    priceChangePercent: 0.6,
    rsi: 40,
    previousRsi: 20,
    oversoldRsi: 20,
    rsiRecovery: 20,
    volumeRatio: 2,
    closeStrength: 1,
    trendSlopePercent: -0.1,
    signalRangePercent: 0.6,
    rejectionReasons: []
    };
    const decision = {
    action: 'BUY',
    entryDelayMs: 1_000,
    entrySignalKey: rebound.signalKey,
    details: { rebound }
    };
    trader.recordPaperSignalTelemetry([{
    coin: 'KRW-BTC',
    currentPrice: 100,
    decision
    }]);
    assert.equal(trader.paperValidation.winnerShadow.blockedEntries[0].status, 'pending');

    const confirmation = await trader.confirmScalpingEntry(
    'KRW-BTC',
    decision,
    {
      getEntryDelayMs: () => 1_000,
      validateEntry: () => ({ valid: false, reason: 'rebound_retrace' })
    }
    );

    assert.equal(confirmation, null);
    assert.equal(trader.paperValidation.winnerShadow.blockedEntries[0].status, 'not_filled');
    assert.equal(trader.paperValidation.winnerShadow.blockedEntries[0].resolutionReason, 'rebound_retrace');
    assert.equal(trader.paperValidation.winnerShadow.blockedEntries[0].counterfactual, null);
    const persisted = JSON.parse(fs.readFileSync(ledger, 'utf8'));
    assert.equal(persisted.winnerShadow.blockedEntries[0].status, 'not_filled');
    const status = await trader.getPaperValidationStatus();
    assert.equal(status.winnerShadowEvaluation.pendingBlockedEntryCount, 0);
    assert.equal(status.winnerShadowEvaluation.notFilledBlockedEntryCount, 1);
    assert.equal(status.winnerShadowEvaluation.settledBlockedEntryCount, 0);
  } finally {
    if (fs.existsSync(ledger)) fs.unlinkSync(ledger);
  }
});

test('strict paper 청산 거래는 프로세스 재시작 후에도 ledger에서 복원된다', async () => {
  const suffix = `coinpilot-strict-${Date.now()}`;
  const ledger = path.join(os.tmpdir(), `${suffix}.json`);
  const portfolio = path.join(os.tmpdir(), `${suffix}-portfolio.json`);
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false,
    virtualPortfolioFile: portfolio,
    paperValidationFile: ledger
  });

  try {
    trader.paperValidationFile = ledger;
    trader.virtualPortfolio = { krwBalance: 1_000_000, holdings: new Map() };
    trader.strategies = new Map();
    trader.calculateTotalAssets = async () => 1_000_000;
    await trader.startPaperValidationSession();

    const strategy = trader.getStrategy('KRW-BTC');
    strategy.openPosition(100, 1, 'BUY');
    trader.recordPaperSignalTelemetry([]);
    assert.equal(trader.paperValidation.strictOpenPositions.length, 1);
    const withOpenPosition = await trader.getPaperValidationStatus();
    assert.equal(withOpenPosition.strictEvaluation.activePositions, 1);
    const closedTrade = strategy.closePosition(102, '재시작 복원 테스트');
    trader.recordPaperStrictTrade('KRW-BTC', closedTrade, 'CLOSE');
    assert.equal(trader.paperValidation.strictTrades.at(-1).type, 'CLOSE');
    assert.deepEqual(trader.paperValidation.strictOpenPositions, [], 'strict close must clear the persisted open snapshot');
    assert.deepEqual(JSON.parse(fs.readFileSync(ledger, 'utf8')).strictOpenPositions, []);
    const sameProcess = await trader.getPaperValidationStatus();
    assert.equal(sameProcess.closedTradeCount, 1);
    assert.equal(sameProcess.strictEvaluation.activePositions, 0);
    assert.equal(sameProcess.strictRecentTrades.length, 1);
    assert.equal(sameProcess.strictRecentTrades[0].coin, 'KRW-BTC');
    assert.equal(sameProcess.strictRecentTrades[0].reason, '재시작 복원 테스트');
    assert.ok(sameProcess.strictRecentTrades[0].profit > 0);

    const reloaded = new MultiCoinTrader({
      strategyMode: 'oversold_reaction_scalping',
      targetCoins: ['KRW-BTC'],
      dryRun: true,
      dryRunSeedMoney: 1_000_000,
      useNews: false,
      virtualPortfolioFile: `${portfolio}.reload`,
      paperValidationFile: ledger
    });
    reloaded.calculateTotalAssets = async () => 1_000_000;
    const restored = await reloaded.getPaperValidationStatus();

    assert.equal(restored.strictLedgerTradeCount, 1);
    assert.equal(restored.closedTradeCount, 1);
    assert.ok(restored.realizedProfit > 0);
    assert.equal(restored.strictRecentTrades[0].reason, '재시작 복원 테스트');
  } finally {
    for (const file of [ledger, portfolio, `${portfolio}.reload`]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
});

test('구버전 strict ledger의 BUY type CLOSE 항목은 메모리에서 close schema로 읽힌다', () => {
  const suffix = `coinpilot-strict-schema-${Date.now()}`;
  const ledger = path.join(os.tmpdir(), `${suffix}.json`);
  const portfolio = path.join(os.tmpdir(), `${suffix}-portfolio.json`);
  fs.writeFileSync(ledger, JSON.stringify({
    strictTrades: [{
      type: 'BUY',
      action: 'CLOSE',
      coin: 'KRW-BTC',
      id: 1,
      exitTime: new Date().toISOString(),
      profit: 4,
      profitPercent: 0.02
    }]
  }), 'utf8');

  try {
    const trader = new MultiCoinTrader({
      strategyMode: 'oversold_reaction_scalping',
      targetCoins: ['KRW-BTC'],
      dryRun: true,
      dryRunSeedMoney: 1_000_000,
      useNews: false,
      virtualPortfolioFile: portfolio,
      paperValidationFile: ledger
    });
    assert.equal(trader.paperValidation.strictTrades[0].type, 'CLOSE');
    assert.ok(trader.paperValidation.strictTradeSchemaMigratedAt);
  } finally {
    for (const file of [ledger, portfolio]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
});

test('strict 손실 cooldown과 연속손실 상태는 프로세스 재시작 후에도 유지된다', async () => {
  const suffix = `coinpilot-strict-risk-${Date.now()}`;
  const ledger = path.join(os.tmpdir(), `${suffix}.json`);
  const portfolio = path.join(os.tmpdir(), `${suffix}-portfolio.json`);
  const createTrader = portfolioFile => new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false,
    virtualPortfolioFile: portfolioFile,
    paperValidationFile: ledger,
    cooldownAfterLossMinutes: 15,
    maxConsecutiveLosses: 3
  });

  try {
    const trader = createTrader(portfolio);
    trader.virtualPortfolio = { krwBalance: 1_000_000, holdings: new Map() };
    trader.strategies = new Map();
    trader.calculateTotalAssets = async () => 1_000_000;
    await trader.startPaperValidationSession();

    const strategy = trader.getStrategy('KRW-BTC');
    strategy.openPosition(100, 1, 'BUY');
    const closedTrade = strategy.closePosition(98, '재시작 cooldown 테스트');
    trader.recordPaperStrictTrade('KRW-BTC', closedTrade, 'CLOSE');

    assert.equal(trader.paperValidation.strictRiskState.consecutiveLossesByCoin['KRW-BTC'], 1);
    assert.ok(trader.paperValidation.strictRiskState.cooldownUntilByCoin['KRW-BTC'] > Date.now());

    const reloaded = createTrader(`${portfolio}.reload`);
    reloaded.calculateTotalAssets = async () => 1_000_000;
    const restoredStrategy = reloaded.getStrategy('KRW-BTC');
    assert.equal(restoredStrategy.consecutiveLosses, 1);
    assert.ok(restoredStrategy.cooldownUntil > Date.now());

    const decision = restoredStrategy.makeDecision({
      indicators: { rebound: { available: true, oversold: true, reboundConfirmed: true } }
    }, { score: 0 }, 98);
    assert.equal(decision.action, 'HOLD');
    assert.match(decision.reason, /쿨다운/);
  } finally {
    for (const file of [ledger, portfolio, `${portfolio}.reload`]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
});

test('구버전 strict ledger도 마지막 손실에서 cooldown 상태를 마이그레이션한다', () => {
  const suffix = `coinpilot-strict-risk-legacy-${Date.now()}`;
  const ledger = path.join(os.tmpdir(), `${suffix}.json`);
  const exitTime = new Date(Date.now() - 30_000).toISOString();
  fs.writeFileSync(ledger, JSON.stringify({
    active: true,
    startedAt: exitTime,
    processId: process.pid,
    strictTrades: [{ action: 'CLOSE', coin: 'KRW-BTC', profit: -10, exitTime }]
  }));

  try {
    const trader = new MultiCoinTrader({
      strategyMode: 'oversold_reaction_scalping',
      targetCoins: ['KRW-BTC'],
      dryRun: true,
      virtualPortfolioFile: path.join(os.tmpdir(), `${suffix}-portfolio.json`),
      paperValidationFile: ledger,
      useNews: false
    });
    assert.equal(trader.paperValidation.strictRiskState.consecutiveLossesByCoin['KRW-BTC'], 1);
    assert.ok(trader.paperValidation.strictRiskState.cooldownUntilByCoin['KRW-BTC'] > Date.now());
  } finally {
    if (fs.existsSync(ledger)) fs.unlinkSync(ledger);
  }
});

test('구버전 strict ledger의 여러 손실도 전역 회로 상태로 마이그레이션한다', () => {
  const suffix = `coinpilot-strict-circuit-legacy-${Date.now()}`;
  const ledger = path.join(os.tmpdir(), `${suffix}.json`);
  const firstExit = new Date(Date.now() - 5 * 60_000).toISOString();
  const secondExit = new Date(Date.now() - 2 * 60_000).toISOString();
  fs.writeFileSync(ledger, JSON.stringify({
    active: true,
    startedAt: firstExit,
    processId: process.pid,
    strictTrades: [
      { action: 'CLOSE', coin: 'KRW-BTC', profit: -10, exitTime: firstExit },
      { action: 'CLOSE', coin: 'KRW-ETH', profit: -20, exitTime: secondExit }
    ]
  }));

  try {
    const trader = new MultiCoinTrader({
      strategyMode: 'oversold_reaction_scalping',
      targetCoins: ['KRW-BTC', 'KRW-ETH'],
      dryRun: true,
      lossCircuitBreakerCount: 2,
      lossCircuitBreakerWindowMinutes: 30,
      lossCircuitBreakerCooldownMinutes: 60,
      virtualPortfolioFile: path.join(os.tmpdir(), `${suffix}-portfolio.json`),
      paperValidationFile: ledger,
      useNews: false
    });
    const circuit = trader.getLossCircuitBreakerStatus('strict');
    assert.equal(circuit.lossCount, 2);
    assert.equal(circuit.coolingDown, true);
  } finally {
    if (fs.existsSync(ledger)) fs.unlinkSync(ledger);
  }
});

test('strict paper의 전역 손실 회로차단기는 마켓을 가로질러 신규 진입을 막는다', async () => {
  const suffix = `coinpilot-strict-circuit-${Date.now()}`;
  const ledger = path.join(os.tmpdir(), `${suffix}.json`);
  const portfolio = path.join(os.tmpdir(), `${suffix}-portfolio.json`);
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC', 'KRW-ETH', 'KRW-XRP'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false,
    virtualPortfolioFile: portfolio,
    paperValidationFile: ledger,
    lossCircuitBreakerCount: 2,
    lossCircuitBreakerWindowMinutes: 30,
    lossCircuitBreakerCooldownMinutes: 60
  });

  try {
    trader.virtualPortfolio = { krwBalance: 1_000_000, holdings: new Map() };
    trader.strategies = new Map();
    trader.calculateTotalAssets = async () => 1_000_000;
    await trader.startPaperValidationSession();

    for (const coin of ['KRW-BTC', 'KRW-ETH']) {
      const strategy = trader.getStrategy(coin);
      strategy.openPosition(100, 1, 'BUY');
      const closedTrade = strategy.closePosition(98, `${coin} circuit 테스트`);
      trader.recordPaperStrictTrade(coin, closedTrade, 'CLOSE');
    }

    const circuit = trader.getLossCircuitBreakerStatus('strict');
    assert.equal(circuit.lossCount, 2);
    assert.equal(circuit.coolingDown, true);

    await trader.executeOrder(
      'KRW-XRP',
      {
        action: 'BUY',
        reason: '회로 차단 테스트',
        signalStrength: { level: 'MEDIUM', multiplier: 1 }
      },
      100,
      1_000_000,
      0,
      0,
      []
    );

    assert.equal(trader.getStrategy('KRW-XRP').currentPosition, null);
    assert.equal(trader.paperValidation.telemetry.circuitBlockedEntries, 1);
  } finally {
    for (const file of [ledger, portfolio]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
});

test('활성화된 portfolio regime gate는 live 주문 실행 직전에도 fail-closed로 동작한다', async () => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false,
    marketRegimeEnabled: true
  });
  trader.virtualPortfolio = { krwBalance: 1_000_000, holdings: new Map() };
  trader.paperValidation = { active: true, telemetry: {} };
  trader.savePaperValidation = () => {};
  trader.calculateTotalAssets = async () => 1_000_000;

  await trader.executeOrder(
    'KRW-BTC',
    {
      action: 'BUY',
      reason: 'regime gate 테스트',
      signalStrength: { level: 'MEDIUM', multiplier: 1 },
      details: {
        marketRegime: {
          enabled: true,
          available: true,
          confirmed: false,
          breadth: 0,
          averageReturnPercent: -1
        }
      }
    },
    100,
    1_000_000,
    0,
    0,
    []
  );

  assert.equal(trader.getStrategy('KRW-BTC').currentPosition, null);
  assert.equal(trader.paperValidation.telemetry.marketRegimeBlockedEntries, 1);
});

test('strict 포지션은 신호와 실제 진입 drift를 함께 보존한다', () => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false
  });
  const strategy = trader.getStrategy('KRW-BTC');
  strategy.openPosition(101, 1, 'BUY');
  strategy.checkPosition(103);
  strategy.checkPosition(99);
  trader.decorateEntryPosition(strategy, {
    entrySignalKey: 'signal-1',
    entryReferencePrice: 101,
    details: {
      rebound: {
        candleTime: '2026-09-10T00:01:00.000Z',
        reboundPriceChangePercent: 0.5,
        rsi: 35,
        oversoldRsi: 28,
        rsiRecovery: 7,
        volumeRatio: 1.4,
        closeStrength: 0.8,
        trendSlopePercent: -0.1,
        signalRangePercent: 0.6
      }
    }
  }, { executionPrice: 101, delayMs: 1500 });

  const snapshot = trader.getStrictOpenPositionSnapshot().find(position => position.coin === 'KRW-BTC');
  assert.equal(snapshot.signalKey, 'signal-1');
  assert.equal(snapshot.signalReboundPercent, 0.5);
  assert.equal(snapshot.entryDelayMs, 1500);
  assert.equal(snapshot.executionDriftPercent, 0);
  assert.equal(snapshot.maxFavorableExcursionPercent, ((103 - 101) / 101) * 100);
  assert.equal(snapshot.maxAdverseExcursionPercent, ((99 - 101) / 101) * 100);

  const closed = strategy.closePosition(99, 'attribution 테스트');
  assert.equal(closed.signalKey, 'signal-1');
  assert.equal(closed.executionDriftPercent, 0);
  assert.equal(closed.maxFavorableExcursionPercent, ((103 - 101) / 101) * 100);
  assert.equal(closed.maxAdverseExcursionPercent, ((99 - 101) / 101) * 100);
});

test('각 shadow 장부는 자체 전역 손실 회로차단기로 다음 마켓 진입을 막는다', async () => {
  const ledger = path.join(os.tmpdir(), `coinpilot-shadow-circuit-${Date.now()}.json`);
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC', 'KRW-ETH'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false,
    paperValidationFile: ledger,
    lossCircuitBreakerCount: 1,
    lossCircuitBreakerWindowMinutes: 30,
    lossCircuitBreakerCooldownMinutes: 60,
    tradingFee: 0,
    slippage: 0
  });

  try {
    trader.virtualPortfolio = { krwBalance: 1_000_000, holdings: new Map() };
    trader.strategies = new Map();
    trader.calculateTotalAssets = async () => 1_000_000;
    await trader.startPaperValidationSession();
    const rebound = {
      available: true,
      previousWasOversold: true,
      bullishCandle: true,
      reboundPriceChangePercent: 0.2,
      rsiRecovery: 2,
      signalKey: 'circuit-signal-1',
      rejectionReasons: []
    };
    const analysis = (coin, price, signalKey) => ({
      coin,
      currentPrice: price,
      decision: { action: 'HOLD', reason: 'shadow circuit 테스트', details: { rebound: { ...rebound, signalKey } } }
    });

    trader.recordPaperSignalTelemetry([analysis('KRW-BTC', 100, 'circuit-signal-1')]);
    trader.recordPaperSignalTelemetry([analysis('KRW-BTC', 98, 'circuit-signal-1')]);
    const afterLoss = await trader.getPaperValidationStatus();
    assert.equal(afterLoss.shadowEvaluation.closedTradeCount, 1);
    assert.ok(afterLoss.shadowEvaluation.lossCircuitBreaker.coolingDown);

    trader.recordPaperSignalTelemetry([analysis('KRW-ETH', 100, 'circuit-signal-2')]);
    const blocked = await trader.getPaperValidationStatus();
    assert.equal(blocked.shadowEvaluation.activePositions, 0);
    assert.equal(blocked.telemetry.shadowCircuitBlockedEntries, 1);
  } finally {
    if (fs.existsSync(ledger)) fs.unlinkSync(ledger);
  }
});

test('분석 cycle은 prefetched ticker/candle을 사용해 중복 조회를 피한다', async () => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false
  });
  let tickerCalls = 0;
  let candleCalls = 0;
  trader.upbit = {
    async getTicker() {
      tickerCalls += 1;
      return [{ market: 'KRW-BTC', trade_price: 99 }];
    },
    async getMinuteCandles() {
      candleCalls += 1;
      return [];
    }
  };
  trader.buildTechnicalAnalysis = () => ({
    indicators: {
      rebound: { available: true, oversold: false, reboundConfirmed: false }
    }
  });

  const result = await trader.analyzeCoin(
    'KRW-BTC',
    { overall: 'neutral', score: 0 },
    {
      ticker: { market: 'KRW-BTC', trade_price: 100 },
      candles: Array.from({ length: 50 }, () => ({}))
    }
  );

  assert.equal(result.currentPrice, 100);
  assert.equal(tickerCalls, 0);
  assert.equal(candleCalls, 0);
});

test('오래된 캔들은 초기 분석과 지연 후 재검증에서 strict/shadow 진입을 fail-closed 한다', async () => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false,
    maxCandleAgeSeconds: 60
  });
  const staleBase = Date.now() - 5 * 60 * 1000;
  const staleCandles = Array.from({ length: 50 }, (_, index) => ({
    candle_date_time_utc: new Date(staleBase - index * 60_000).toISOString(),
    trade_price: 100,
    opening_price: 99,
    high_price: 101,
    low_price: 98,
    candle_acc_trade_volume: 100
  }));
  trader.paperValidation = { active: true, telemetry: {} };
  trader.savePaperValidation = () => {};
  trader.getAccountInfo = async () => [];
  trader.upbit = {
    async getTicker() {
      return [{ market: 'KRW-BTC', trade_price: 100 }];
    },
    async getMinuteCandles() {
      return staleCandles;
    }
  };
  trader.buildTechnicalAnalysis = () => ({
    indicators: {
      rebound: {
        available: true,
        previousWasOversold: true,
        bullishCandle: true,
        reboundConfirmed: true,
        reboundPriceChangePercent: 0.2,
        rsiRecovery: 2,
        signalKey: 'stale-signal'
      }
    }
  });

  const analysis = await trader.analyzeCoin(
    'KRW-BTC',
    { overall: 'neutral', score: 0 }
  );
  assert.equal(analysis.candleFreshness.valid, false);
  assert.equal(analysis.candleFreshness.reason, 'stale_candle_snapshot');
  assert.equal(analysis.decision.action, 'HOLD');
  assert.equal(trader.paperValidation.telemetry.candleFreshnessBlockedSnapshots, 1);
  assert.equal(trader.paperValidation.telemetry.candleFreshnessBlockedAnalyses, 1);
  assert.equal(trader.paperValidation.telemetry.candleFreshnessBlockedEntries, 0);
  assert.equal(trader.paperValidation.telemetry.lastCandleFreshnessBlock.reason, 'stale_candle_snapshot');
  assert.equal(trader.paperValidation.telemetry.lastCandleFreshnessBlock.context, 'analysis');
  assert.equal(trader.paperValidation.telemetry.lastCandleFreshnessBlock.coin, 'KRW-BTC');
  assert.equal(trader.paperValidation.telemetry.candleFreshnessBlockedByCoin['KRW-BTC'], 1);
  assert.equal(trader.paperValidation.telemetry.candleFreshnessObservedByCoin['KRW-BTC'], 1);
  assert.ok(trader.paperValidation.telemetry.lastCandleFreshnessBlock.ageSeconds > 60);
  assert.equal(trader.paperValidation.telemetry.candleFreshnessAgeStats.sampleCount, 1);

  let validateCalls = 0;
  trader.sleep = async () => {};
  const confirmation = await trader.confirmScalpingEntry(
    'KRW-BTC',
    { entryDelayMs: 1_000 },
    {
      getEntryDelayMs: () => 1_000,
      validateEntry: () => {
        validateCalls += 1;
        return { valid: true };
      }
    }
  );
  assert.equal(confirmation, null);
  assert.equal(validateCalls, 0);
  assert.equal(trader.paperValidation.telemetry.candleFreshnessBlockedSnapshots, 2);
  assert.equal(trader.paperValidation.telemetry.candleFreshnessBlockedAnalyses, 1);
  assert.equal(trader.paperValidation.telemetry.candleFreshnessBlockedEntries, 1);
  assert.equal(trader.paperValidation.telemetry.lastCandleFreshnessBlock.reason, 'stale_candle_snapshot');
  assert.equal(trader.paperValidation.telemetry.lastCandleFreshnessBlock.context, 'entry_confirmation');
  assert.equal(trader.paperValidation.telemetry.candleFreshnessBlockedByCoin['KRW-BTC'], 2);
  assert.equal(trader.paperValidation.telemetry.candleFreshnessObservedByCoin['KRW-BTC'], 2);
  assert.equal(trader.paperValidation.telemetry.candleFreshnessAgeStatsByCoin['KRW-BTC'].blockedCount, 2);
  assert.equal(trader.paperValidation.telemetry.candleFreshnessAgeStats.sampleCount, 2);
  assert.ok(
    trader.paperValidation.telemetry.candleFreshnessAgeStats.totalAgeSeconds /
      trader.paperValidation.telemetry.candleFreshnessAgeStats.sampleCount > 60
  );
  assert.equal(trader.paperValidation.telemetry.entryConfirmationAttempts, 1);
  assert.equal(trader.paperValidation.telemetry.entryConfirmationSucceeded, 0);
  assert.equal(trader.paperValidation.telemetry.entryConfirmationCancelled, 1);
  assert.equal(trader.paperValidation.telemetry.entryConfirmationReasons.stale_candle_snapshot, 1);
  assert.equal(trader.paperValidation.telemetry.lastEntryConfirmation.outcome, 'cancelled');
  const status = await trader.getPaperValidationStatus();
  assert.equal(status.candleFreshness.blockedSnapshots, 2);
  assert.equal(status.candleFreshness.blockedAnalyses, 1);
  assert.equal(status.candleFreshness.blockedEntries, 1);
  assert.equal(status.candleFreshness.blockContexts.analysis, 1);
  assert.equal(status.candleFreshness.blockContexts.entry_confirmation, 1);
  assert.equal(status.candleFreshness.observedByCoin['KRW-BTC'], 2);
  assert.equal(status.candleFreshness.ageStatsByCoin['KRW-BTC'].blockedCount, 2);
  assert.ok(status.candleFreshness.ageStats.averageAgeSeconds > 60);
});

test('지연 후 진입 재검증 성공도 시도/성공 telemetry에 기록한다', async () => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false,
    maxCandleAgeSeconds: 90
  });
  trader.paperValidation = { active: true, telemetry: {} };
  trader.savePaperValidation = () => {};
  trader.sleep = async () => {};
  const now = Date.now();
  const freshCandles = Array.from({ length: 50 }, (_, index) => ({
    candle_date_time_utc: new Date(now - index * 60_000).toISOString(),
    trade_price: 100,
    opening_price: 99,
    high_price: 101,
    low_price: 98,
    candle_acc_trade_volume: 100
  }));
  trader.upbit = {
    async getTicker() {
      return [{ market: 'KRW-BTC', trade_price: 100 }];
    },
    async getMinuteCandles() {
      return freshCandles;
    }
  };
  trader.buildTechnicalAnalysis = () => ({
    indicators: {
      rebound: {
        available: true,
        reboundConfirmed: true,
        signalKey: 'fresh-signal'
      }
    }
  });

  const confirmation = await trader.confirmScalpingEntry(
    'KRW-BTC',
    { entryDelayMs: 1_000, entrySignalKey: 'fresh-signal', entryReferencePrice: 100 },
    {
      getEntryDelayMs: () => 1_000,
      validateEntry: () => ({ valid: true })
    }
  );

  assert.ok(confirmation);
  assert.equal(trader.paperValidation.telemetry.entryConfirmationAttempts, 1);
  assert.equal(trader.paperValidation.telemetry.entryConfirmationSucceeded, 1);
  assert.equal(trader.paperValidation.telemetry.entryConfirmationCancelled, 0);
  assert.equal(trader.paperValidation.telemetry.entryConfirmationReasons.entry_revalidation_passed, 1);
  assert.equal(trader.paperValidation.telemetry.lastEntryConfirmation.outcome, 'confirmed');
});

test('stale 반등은 신호 가용성 카운터나 filter starvation 후보로 집계하지 않는다', () => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false
  });
  trader.paperValidation = { active: true, telemetry: {} };
  trader.savePaperValidation = () => {};

  trader.recordPaperSignalTelemetry([{
    coin: 'KRW-BTC',
    candleFreshness: { valid: false },
    decision: {
      action: 'HOLD',
      reason: 'stale candle',
      details: {
        candleFreshness: { valid: false },
        rebound: {
          available: true,
          previousWasOversold: true,
          bullishCandle: true,
          reboundConfirmed: true,
          reboundPriceChangePercent: 0.3,
          rsiRecovery: 3,
          rejectionReasons: []
        }
      }
    }
  }]);

  assert.equal(trader.paperValidation.telemetry.oversoldObservations, 0);
  assert.equal(trader.paperValidation.telemetry.strictReboundCandidates, 0);
  assert.equal(trader.paperValidation.telemetry.strictConfirmedCandidates, 0);
});

test('반복 cycle은 고유 signal window telemetry에서 한 번만 집계된다', async () => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false
  });
  trader.paperValidation = {
    active: true,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    telemetry: {}
  };
  trader.savePaperValidation = () => {};

  const analysisFor = (signalKey, rejectionReason) => ({
    coin: 'KRW-BTC',
    currentPrice: 100,
    candleFreshness: { valid: true },
    decision: {
      action: 'HOLD',
      reason: '관망',
      details: {
        candleFreshness: { valid: true },
        rebound: {
          available: true,
          signalKey,
          previousWasOversold: false,
          bullishCandle: false,
          reboundConfirmed: false,
          rejectionReasons: [rejectionReason]
        }
      }
    }
  });

  trader.recordPaperSignalTelemetry([analysisFor('candle-a', 'previous_rsi_not_oversold')]);
  trader.recordPaperSignalTelemetry([analysisFor('candle-a', 'previous_rsi_not_oversold')]);
  trader.recordPaperSignalTelemetry([analysisFor('candle-b', 'price_rebound_below_threshold')]);

  const telemetry = trader.paperValidation.telemetry;
  assert.equal(telemetry.signalTelemetryVersion, 1);
  assert.equal(telemetry.uniqueSignalWindows, 2);
  assert.deepEqual(telemetry.uniqueSignalWindowsByCoin, { 'KRW-BTC': 2 });
  assert.deepEqual(telemetry.uniqueRejectionCounts, {
    previous_rsi_not_oversold: 1,
    price_rebound_below_threshold: 1
  });
  assert.equal(telemetry.rejectionCounts.previous_rsi_not_oversold, 2);
  assert.equal(telemetry.rejectionCounts.price_rebound_below_threshold, 1);

  trader.calculateTotalAssets = async () => 1_000_000;
  const status = await trader.getPaperValidationStatus();
  assert.equal(status.signalTelemetry.available, true);
  assert.equal(status.signalTelemetry.uniqueSignalWindows, 2);
  assert.equal(status.signalAvailability.uniqueSignalWindows, 2);
});

test('고유 signal window별 직전 RSI와 과매도 임계값 근접도를 별도로 기록한다', async () => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    rsiOversold: 30,
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false
  });
  trader.paperValidation = {
    active: true,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    telemetry: {}
  };
  trader.paperDiagnosticShadowsEnabled = false;
  trader.savePaperValidation = () => {};

  const analysisFor = (signalKey, previousRsi) => ({
    coin: 'KRW-BTC',
    candleFreshness: { valid: true },
    decision: {
      action: 'HOLD',
      reason: '과매도 조건 없음 - 관망',
      details: {
        candleFreshness: { valid: true },
        rebound: {
          available: true,
          signalKey,
          previousRsi,
          rsi: previousRsi + 1,
          previousWasOversold: false,
          bullishCandle: false,
          reboundConfirmed: false,
          rejectionReasons: ['previous_rsi_not_oversold']
        }
      }
    }
  });

  trader.recordPaperSignalTelemetry([analysisFor('rsi-window-a', 34)]);
  trader.recordPaperSignalTelemetry([analysisFor('rsi-window-a', 34)]);
  trader.recordPaperSignalTelemetry([analysisFor('rsi-window-b', 38)]);

  const telemetry = trader.paperValidation.telemetry;
  assert.equal(telemetry.rsiProximity.uniqueAvailableWindows, 2);
  assert.deepEqual(telemetry.rsiProximity.uniqueAvailableWindowsByCoin, { 'KRW-BTC': 2 });
  assert.equal(telemetry.rsiProximity.minimumPreviousRsi, 34);
  assert.deepEqual(telemetry.rsiProximity.minimumPreviousRsiByCoin, { 'KRW-BTC': 34 });
  assert.equal(telemetry.rsiProximity.nearThresholdWindows, 1);
  assert.deepEqual(telemetry.rsiProximity.nearThresholdWindowsByCoin, { 'KRW-BTC': 1 });
  assert.deepEqual(telemetry.signalFunnel, {
    version: 1,
    availableWindows: 2,
    oversoldWindows: 0,
    bullishWindows: 0,
    priceReboundWindows: 0,
    rsiRecoveryWindows: 0,
    volumeWindows: 0,
    candleRangeWindows: 0,
    closeStrengthWindows: 0,
    trendWindows: 0,
    previousHighBreakWindows: 0,
    profileWindows: 0,
    confirmedWindows: 0
  });

  trader.calculateTotalAssets = async () => 1_000_000;
  const status = await trader.getPaperValidationStatus();
  assert.equal(status.signalAvailability.rsiProximity.threshold, 30);
  assert.equal(status.signalAvailability.rsiProximity.minimumPreviousRsi, 34);
  assert.equal(status.signalAvailability.rsiProximity.nearThresholdWindows, 1);
  assert.equal(status.signalAvailability.signalFunnel.availableWindows, 2);
  assert.equal(status.signalAvailability.signalFunnel.confirmedWindows, 0);
  assert.equal(status.signalAvailability.lastSignalEvidenceByCoin['KRW-BTC'].signalKey, 'rsi-window-b');
  assert.equal(status.signalAvailability.lastSignalEvidenceByCoin['KRW-BTC'].previousRsi, 38);
  assert.deepEqual(status.signalAvailability.lastSignalEvidenceByCoin['KRW-BTC'].rejectionReasons, ['previous_rsi_not_oversold']);
});

test('캔들 수가 부족한 마켓은 stale과 별도의 데이터 품질 telemetry로 기록한다', async () => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BFC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false
  });
  trader.paperValidation = { active: true, telemetry: {} };
  trader.getAccountInfo = async () => [];
  trader.upbit = {
    async getTicker() {
      return [{ market: 'KRW-BFC', trade_price: 100 }];
    },
    async getMinuteCandles() {
      return Array.from({ length: 40 }, () => ({}));
    }
  };

  await assert.rejects(
    () => trader.analyzeCoin('KRW-BFC', { overall: 'neutral', score: 0 }),
    /캔들 데이터 부족/
  );
  assert.deepEqual(trader.paperValidation.telemetry.insufficientCandleDataByCoin['KRW-BFC'], {
    count: 1,
    minReceivedCount: 40,
    lastReceivedCount: 40,
    requiredCount: 50,
    lastAt: trader.paperValidation.telemetry.insufficientCandleDataByCoin['KRW-BFC'].lastAt
  });
  assert.equal(trader.paperValidation.telemetry.candleFreshnessBlockedSnapshots, undefined);
});

test('전체 분석 cycle은 20개 시장 ticker를 한 번만 batch 조회한다', async () => {
  const markets = ['KRW-BTC', 'KRW-ETH'];
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: markets,
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false,
    checkInterval: 5_000
  });
  let batchTickerCalls = 0;
  let individualTickerCalls = 0;
  let candleCalls = 0;
  trader.upbit = {
    async getTicker(requestedMarkets) {
      if (Array.isArray(requestedMarkets)) {
        batchTickerCalls += 1;
        return requestedMarkets.map(market => ({ market, trade_price: 100 }));
      }
      individualTickerCalls += 1;
      return [{ market: requestedMarkets, trade_price: 100 }];
    },
    async getMinuteCandles() {
      candleCalls += 1;
      return Array.from({ length: 50 }, () => ({}));
    }
  };
  trader.buildTechnicalAnalysis = () => ({
    indicators: {
      rebound: { available: true, oversold: false, reboundConfirmed: false }
    }
  });
  trader.printPortfolioSummary = () => {};
  trader.paperValidation = { active: true, telemetry: {} };
  trader.savePaperValidation = () => {};

  await trader.executeTradingCycle();

  assert.equal(batchTickerCalls, 1);
  assert.equal(individualTickerCalls, 0);
  assert.equal(candleCalls, markets.length);
  assert.equal(trader.paperValidation.telemetry.requestStats.batchTickerRequests, 1);
  assert.equal(trader.paperValidation.telemetry.requestStats.individualTickerRequests, 0);
  assert.equal(trader.paperValidation.telemetry.requestStats.candleRequests, markets.length);
  assert.equal(trader.paperValidation.telemetry.requestStats.batchTickerFailures, 0);
});

test('긴 heartbeat 공백은 forward paper 연속 관찰 게이트를 보류한다', async () => {
  const ledger = path.join(os.tmpdir(), `coinpilot-continuity-${Date.now()}.json`);
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false,
    paperValidationMaxHeartbeatGapMinutes: 15
  });

  try {
    trader.paperValidationFile = ledger;
    trader.virtualPortfolio = { krwBalance: 1_000_000, holdings: new Map() };
    trader.strategies = new Map();
    trader.calculateTotalAssets = async () => 1_000_000;
    await trader.startPaperValidationSession();
    trader.paperValidation.interruptions = [{ gapMs: 16 * 60 * 1000 }];

    const status = await trader.getPaperValidationStatus();
    assert.equal(status.continuityEligible, false);
    assert.equal(status.interruptionCount, 1);
    assert.equal(status.eligible, false);
  } finally {
    if (fs.existsSync(ledger)) fs.unlinkSync(ledger);
  }
});

test('저장된 owner 프로세스가 없으면 heartbeat 유예 전에도 orphan으로 표시한다', async () => {
  const ledger = path.join(os.tmpdir(), `coinpilot-orphan-${Date.now()}.json`);
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false,
    checkInterval: 60_000
  });

  try {
    trader.paperValidationFile = ledger;
    trader.virtualPortfolio = { krwBalance: 1_000_000, holdings: new Map() };
    trader.strategies = new Map();
    trader.calculateTotalAssets = async () => 1_000_000;
    await trader.startPaperValidationSession();
    trader.paperValidation.processId = 999_999_999;
    trader.paperValidation.heartbeatAt = new Date().toISOString();
    trader.paperValidation.telemetry.heartbeatAt = trader.paperValidation.heartbeatAt;
    trader.paperValidation.strictOpenPositions = [{ coin: 'KRW-BTC', entryPrice: 100 }];
    trader.paperValidation.shadow.positions = {
      'KRW-BTC': { coin: 'KRW-BTC', entryPrice: 100 }
    };

    const status = await trader.getPaperValidationStatus();
    assert.equal(status.processAlive, false);
    assert.equal(status.orphaned, true);
    assert.equal(status.orphanReason, 'owner_process_missing');
    assert.equal(status.active, false);
    assert.equal(status.state, 'STOPPED');
    assert.equal(status.continuityEligible, false);
    assert.equal(status.endedWithOpenPositions, true);
    assert.equal(status.endedWithDiagnosticOpenPositions, true);
    assert.deepEqual(status.diagnosticOpenPositions.map(position => position.coin), ['KRW-BTC']);
  } finally {
    if (fs.existsSync(ledger)) fs.unlinkSync(ledger);
  }
});

test('미래 시각의 heartbeat는 검증 불가로 간주해 orphan fail-closed로 표시한다', async () => {
  const ledger = path.join(os.tmpdir(), `coinpilot-orphan-future-hb-${Date.now()}.json`);
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false,
    checkInterval: 60_000
  });

  try {
    trader.paperValidationFile = ledger;
    trader.virtualPortfolio = { krwBalance: 1_000_000, holdings: new Map() };
    trader.strategies = new Map();
    trader.calculateTotalAssets = async () => 1_000_000;
    await trader.startPaperValidationSession();
    // owner는 살아 있지만 heartbeat가 미래 시각이면 신선도를 검증할 수 없다.
    const futureHeartbeat = new Date(Date.now() + 60_000).toISOString();
    trader.paperValidation.heartbeatAt = futureHeartbeat;
    trader.paperValidation.telemetry.heartbeatAt = futureHeartbeat;

    const status = await trader.getPaperValidationStatus();
    assert.equal(status.processAlive, true);
    assert.equal(status.heartbeatAgeMs, null);
    assert.equal(status.orphaned, true);
    assert.equal(status.orphanReason, 'heartbeat_stale');
    assert.equal(status.active, false);
    assert.equal(status.state, 'STOPPED');
    assert.equal(status.continuityEligible, false);
  } finally {
    if (fs.existsSync(ledger)) fs.unlinkSync(ledger);
  }
});

test('전략 설정이 바뀐 paper 세션은 재현성 drift로 승격하지 않는다', async () => {
  const ledger = path.join(os.tmpdir(), `coinpilot-config-drift-${Date.now()}.json`);
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false,
    rsiOversold: 30
  });

  try {
    trader.paperValidationFile = ledger;
    trader.virtualPortfolio = { krwBalance: 1_000_000, holdings: new Map() };
    trader.strategies = new Map();
    trader.calculateTotalAssets = async () => 1_000_000;
    await trader.startPaperValidationSession();
    trader.config.rsiOversold = 35;

    const status = await trader.getPaperValidationStatus();
    assert.equal(status.configSnapshotComplete, true);
    assert.equal(status.configConsistent, false);
    assert.ok(status.configDrift.includes('rsiOversold'));
    assert.ok(status.configValueDrift.includes('rsiOversold'));
    assert.deepEqual(status.configSchemaDrift, []);
    assert.equal(status.eligible, false);
  } finally {
    if (fs.existsSync(ledger)) fs.unlinkSync(ledger);
  }
});

test('구버전 paper snapshot의 새 필드는 schema drift로 분리하되 재개와 승격은 보류한다', async () => {
  const ledger = path.join(os.tmpdir(), `coinpilot-config-schema-drift-${Date.now()}.json`);
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false
  });

  try {
    trader.paperValidationFile = ledger;
    trader.virtualPortfolio = { krwBalance: 1_000_000, holdings: new Map() };
    trader.strategies = new Map();
    trader.calculateTotalAssets = async () => 1_000_000;
    await trader.startPaperValidationSession();
    delete trader.paperValidation.configSnapshot.winnerExtendMinutes;
    delete trader.paperValidation.configSnapshot.winnerExtendMinProfitPercent;

    const status = await trader.getPaperValidationStatus();
    assert.equal(status.configSnapshotComplete, true);
    assert.equal(status.configConsistent, false);
    assert.deepEqual(status.configValueDrift, []);
    assert.deepEqual(status.configSchemaDrift, [
      'winnerExtendMinProfitPercent',
      'winnerExtendMinutes'
    ]);
    assert.equal(status.eligible, false);
  } finally {
    if (fs.existsSync(ledger)) fs.unlinkSync(ledger);
  }
});

test('시장 freshness cohort는 충분한 관측 뒤 진단용 후보만 제시하고 현재 대상은 바꾸지 않는다', async () => {
  const ledger = path.join(os.tmpdir(), `coinpilot-market-quality-${Date.now()}.json`);
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC', 'KRW-ETH', 'KRW-RAY'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false
  });

  try {
    trader.paperValidationFile = ledger;
    trader.virtualPortfolio = { krwBalance: 1_000_000, holdings: new Map() };
    trader.strategies = new Map();
    trader.calculateTotalAssets = async () => 1_000_000;
    await trader.startPaperValidationSession();
    trader.paperValidation.telemetry.candleFreshnessObservedByCoin = {
      'KRW-BTC': 100,
      'KRW-ETH': 100,
      'KRW-RAY': 100
    };
    trader.paperValidation.telemetry.candleFreshnessBlockedByCoin = {
      'KRW-BTC': 0,
      'KRW-ETH': 4,
      'KRW-RAY': 30
    };
    trader.paperValidation.telemetry.candleFreshnessAgeStatsByCoin = {
      'KRW-BTC': { sampleCount: 100, validCount: 100, blockedCount: 0, totalAgeSeconds: 3_200, maxObservedAgeSeconds: 70 },
      'KRW-ETH': { sampleCount: 100, validCount: 96, blockedCount: 4, totalAgeSeconds: 4_800, maxObservedAgeSeconds: 101 },
      'KRW-RAY': { sampleCount: 100, validCount: 70, blockedCount: 30, totalAgeSeconds: 12_000, maxObservedAgeSeconds: 400 }
    };

    const status = await trader.getPaperValidationStatus();
    assert.deepEqual(status.marketFreshnessCohort.selectedMarkets, ['KRW-BTC', 'KRW-ETH']);
    assert.equal(status.marketFreshnessCohort.ready, true);
    assert.equal(status.marketFreshnessCohort.diagnosticOnly, true);
    assert.equal(status.marketFreshnessCohort.observedMarketCount, 3);
    assert.deepEqual(trader.targetCoins, ['KRW-BTC', 'KRW-ETH', 'KRW-RAY']);
    assert.equal(status.eligible, false);
  } finally {
    if (fs.existsSync(ledger)) fs.unlinkSync(ledger);
  }
});

test('promoted tuned report는 현재 runtime과 달라도 live 승격에 사용할 수 없다', () => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: false,
    useNews: false,
    rsiOversold: 30
  });

  const snapshot = trader.getPaperValidationConfigSnapshot();
  const compatibleConfig = Object.fromEntries([
    'signalProfile', 'candleUnit', 'rsiPeriod', 'rsiOversold', 'rsiOverbought', 'oversoldLookback',
    'minReboundPercent', 'minRsiRecovery', 'minVolumeRatio', 'volumeLookback',
    'minCloseStrength', 'trendPeriod', 'trendSlopeLookback', 'minTrendSlopePercent',
    'requirePreviousHighBreak', 'maxSignalRangePercent', 'minSignalRangePercent', 'maxReboundPercent', 'maxCandleAgeSeconds', 'stopLossPercent',
    'takeProfitPercent', 'maxHoldMinutes', 'maxLosingHoldMinutes', 'winnerExtendMinutes', 'winnerExtendMinProfitPercent', 'maxEntriesPerSignalWindow', 'breakEvenTriggerPercent', 'breakEvenOffsetPercent',
    'trailingActivationPercent', 'trailingStopPercent', 'cooldownAfterLossMinutes', 'maxConsecutiveLosses',
    'marketRegimeEnabled', 'marketRegimeLookback', 'marketRegimeMinBreadth', 'marketRegimeMinReturnPercent', 'requireReboundBelowOverbought',
    'lossCircuitBreakerCount', 'lossCircuitBreakerWindowMinutes', 'lossCircuitBreakerCooldownMinutes', 'investmentRatio', 'tradingFee', 'slippage',
    'entryDelayMinMs', 'entryDelayMaxMs', 'maxEntryRetracePercent', 'maxEntryChasePercent',
    'winnerExtendMinutes', 'winnerExtendMinProfitPercent',
    'bbPeriod', 'bbStdDev', 'emaPeriod', 'maxPositions', 'portfolioAllocation', 'requireNextCandleBullish'
  ].map(key => [key, snapshot[key]]));

  assert.throws(
    () => trader.validatePromotionReport({
      validationMode: 'tuned_holdout',
      promoted: true,
      markets: ['KRW-BTC'],
      promotedMarkets: ['KRW-BTC'],
      config: { rsiOversold: 30 }
    }),
    /fixed_config/
  );
  assert.throws(
    () => trader.validatePromotionReport({
      validationMode: 'fixed_config',
      strategyMode: 'oversold_reaction_scalping',
      promoted: true,
      markets: ['KRW-BTC'],
      promotedMarkets: ['KRW-BTC'],
      config: { ...compatibleConfig, rsiOversold: 35 }
    }),
    /rsiOversold/
  );
  assert.throws(
    () => trader.validatePromotionReport({
      validationMode: 'fixed_config',
      strategyMode: 'oversold_reaction_scalping',
      promoted: true,
      markets: ['KRW-BTC'],
      promotedMarkets: ['KRW-BTC'],
      config: { rsiOversold: 30 }
    }),
    /불완전합니다/
  );

  assert.throws(
    () => trader.validatePromotionReport({
      validationMode: 'fixed_config',
      strategyMode: 'oversold_reaction_scalping',
      promoted: true,
      markets: ['KRW-BTC'],
      promotedMarkets: ['KRW-BTC'],
      config: { ...compatibleConfig, portfolioAllocation: compatibleConfig.portfolioAllocation + 0.05 }
    }),
    /portfolioAllocation/
  );

  assert.doesNotThrow(() => trader.validatePromotionReport({
    validationMode: 'fixed_config',
    strategyMode: 'oversold_reaction_scalping',
    promoted: true,
    markets: ['KRW-BTC'],
    promotedMarkets: ['KRW-BTC'],
    config: compatibleConfig,
    statisticalConfidence: {
      required: true,
      method: 'one_sided_t_mean',
      confidenceLevel: 0.95,
      passed: true
    },
    results: [{
      market: 'KRW-BTC',
      validation: {
        gate: {
          statisticalConfidence: {
            required: true,
            training: { passed: true },
            validation: { passed: true }
          }
        }
      }
    }]
  }));
});

test('구버전 paper telemetry는 새 rejectionCounts 필드를 지연 마이그레이션한다', () => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false
  });
  trader.paperValidation = {
    active: true,
    telemetry: {
      cycles: 0,
      buyCandidates: 0,
      shadowCandidates: 0,
      sellSignals: 0,
      holdDecisions: 0,
      reasonCounts: {},
      shadowCandidatesByCoin: {}
    }
  };
  trader.savePaperValidation = () => {};

  trader.recordPaperSignalTelemetry([{
    coin: 'KRW-BTC',
    currentPrice: 100,
    decision: {
      action: 'HOLD',
      reason: '필터 확인',
      details: {
        rebound: {
          available: true,
          rejectionReasons: ['volume_confirmation_failed', 'previous_high_break_failed']
        }
      }
    }
  }]);

  assert.equal(trader.paperValidation.telemetry.rejectionCounts.volume_confirmation_failed, 1);
  assert.equal(trader.paperValidation.telemetry.rejectionCounts.previous_high_break_failed, 1);
});

test('forward paper 저장공간 기준은 상태 API와 preflight가 공유할 수 있다', () => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false,
    paperMinimumStorageMiB: 256
  });

  const storage = trader.getStorageStatus();
  assert.equal(storage.minimumMiB, 256);
  assert.equal(storage.minimumBytes, 256 * 1024 * 1024);
});

test('원자 ledger 저장 실패 시 임시 파일을 남기지 않는다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-atomic-'));
  const target = path.join(directory, 'target-directory');
  fs.mkdirSync(target);
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false
  });

  try {
    assert.throws(() => trader.writeJsonAtomically(target, { ok: true }));
    assert.deepEqual(fs.readdirSync(directory), ['target-directory']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('독립 포지션 리스크 모니터가 빠른 손절을 실행한다', async () => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 100_000,
    stopLossPercent: 1.2,
    takeProfitPercent: 1.8,
    positionRiskCheckIntervalMs: 1_000,
    useNews: false
  });
  const strategy = trader.getStrategy('KRW-BTC');
  strategy.openPosition(100_000, 1, 'BUY');
  trader.virtualPortfolio = {
    krwBalance: 0,
    holdings: new Map([['KRW-BTC', { amount: 1, avgPrice: 100_000 }]])
  };
  trader.paperValidation = null;
  trader.calculateTotalAssets = async () => 100_000;
  trader.saveVirtualPortfolio = () => {};
  trader.riskUpbit = {
    async getTicker() {
      return [{ market: 'KRW-BTC', trade_price: 98_000 }];
    }
  };
  trader.getAccountInfo = async () => [
    { currency: 'KRW', balance: '0', locked: '0' },
    { currency: 'BTC', balance: '1', locked: '0', avg_buy_price: '100000' }
  ];
  trader.isRunning = true;

  await trader.monitorOpenPositions();

  assert.equal(strategy.currentPosition, null);
  assert.equal(trader.virtualPortfolio.holdings.has('KRW-BTC'), false);
  assert.ok(trader.virtualPortfolio.krwBalance > 0);
  trader.isRunning = false;
  trader.stopPositionRiskMonitor();
});

test('독립 포지션 리스크 모니터가 shadow 손익도 실시간 가격으로 청산한다', async () => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 100_000,
    stopLossPercent: 1.2,
    takeProfitPercent: 1.8,
    maxHoldMinutes: 30,
    useNews: false
  });
  let saveCount = 0;
  const position = {
    coin: 'KRW-BTC',
    entryPrice: 100_000,
    amount: 0.2,
    investAmount: 20_000,
    entryTimestamp: new Date(Date.now() - 60_000).toISOString(),
    signalKey: 'shadow-risk-test',
    rejectionReasons: ['previous_high_break_failed']
  };
  trader.paperValidation = {
    active: true,
    shadow: {
      positions: { 'KRW-BTC': position },
      closedTrades: [],
      entryCount: 1,
      realizedProfit: 0,
      totalInvested: 20_000,
      winningTrades: 0,
      losingTrades: 0
    },
    looseShadow: { positions: {} }
  };
  trader.savePaperValidation = () => { saveCount += 1; };
  trader.riskUpbit = {
    async getTicker() {
      return [{ market: 'KRW-BTC', trade_price: 98_000 }];
    }
  };
  trader.isRunning = true;

  await trader.monitorOpenPositions();

  assert.equal(trader.paperValidation.shadow.positions['KRW-BTC'], undefined);
  assert.equal(trader.paperValidation.shadow.closedTrades.length, 1);
  assert.equal(trader.paperValidation.shadow.closedTrades[0].reason, 'STOP_LOSS');
  assert.deepEqual(
    trader.paperValidation.shadow.closedTrades[0].rejectionReasons,
    ['previous_high_break_failed']
  );
  assert.equal(saveCount, 1);
  trader.isRunning = false;
  trader.stopPositionRiskMonitor();
});

test('idle 이후 새 diagnostic position 보호는 이전 risk 성공 시각을 재사용하지 않는다', async () => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 100_000,
    maxRiskDataGapSeconds: 5,
    useNews: false
  });
  const now = Date.now();
  trader.paperValidation = {
    active: true,
    sessionId: 'paper-risk-idle-resume',
    telemetry: {},
    shadow: { positions: {}, closedTrades: [] },
    looseShadow: { positions: {} }
  };
  trader.savePaperValidation = () => {};
  trader.riskMonitorState = {
    monitoringActive: true,
    monitoringStartedAt: new Date(now).toISOString(),
    lastAttemptAt: new Date(now).toISOString(),
    lastSuccessAt: new Date(now).toISOString(),
    continuityEligible: true
  };
  trader.riskUpbit = {
    async getTicker() {
      return [{ market: 'KRW-BTC', trade_price: 100_000 }];
    }
  };
  trader.isRunning = true;

  try {
    // No protected position: this transitions the monitor into idle.
    await trader.monitorOpenPositions();
    assert.equal(trader.riskMonitorState.monitoringActive, false);

    trader.paperValidation.shadow.positions['KRW-BTC'] = {
      coin: 'KRW-BTC',
      entryPrice: 100_000,
      amount: 0.2,
      investAmount: 20_000,
      entryTimestamp: new Date(now).toISOString(),
      signalKey: 'risk-idle-resume'
    };

    await trader.monitorOpenPositions();

    assert.equal(trader.isRunning, true);
    assert.equal(trader.riskMonitorState.continuityEligible, true);
    assert.equal(trader.riskMonitorState.lastFailureCode, null);
    assert.equal(trader.riskMonitorState.currentOutageStartedAt, null);
    assert.equal(trader.riskMonitorState.maxObservedGapSeconds, 0);
  } finally {
    trader.isRunning = false;
    trader.stopPositionRiskMonitor();
  }
});

test('리스크 ticker 공백이 한도를 넘으면 paper 루프를 fail-closed로 중지하고 상태를 남긴다', async () => {
  const suffix = `coinpilot-risk-outage-${Date.now()}`;
  const ledger = path.join(os.tmpdir(), `${suffix}.json`);
  const portfolio = path.join(os.tmpdir(), `${suffix}-portfolio.json`);
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 100_000,
    virtualPortfolioFile: portfolio,
    paperValidationFile: ledger,
    maxRiskDataGapSeconds: 5,
    useNews: false
  });

  try {
    trader.paperValidation = {
      active: true,
      telemetry: {},
      shadow: {
        positions: {
          'KRW-BTC': {
            coin: 'KRW-BTC',
            entryPrice: 100,
            amount: 200,
            investAmount: 20_000,
            entryTimestamp: new Date().toISOString()
          }
        },
        closedTrades: []
      },
      looseShadow: { positions: {} }
    };
    trader.riskMonitorState = {
      currentOutageStartedAt: new Date(Date.now() - 6_000).toISOString()
    };
    trader.savePaperValidation = () => {};
    trader.riskUpbit = {
      async getTicker() {
        const error = new Error('DNS failure');
        error.code = 'ENOTFOUND';
        throw error;
      }
    };
    trader.isRunning = true;

    await trader.monitorOpenPositions();

    assert.equal(trader.isRunning, false);
    assert.equal(trader._stopRequested, true);
    assert.equal(trader.stopReason, 'risk_data_gap');
    assert.equal(trader.getRiskMonitorStatus().failClosed, true);
    assert.equal(trader.paperValidation.riskMonitor.continuityEligible, false);
    assert.equal(trader.paperValidation.telemetry.riskMonitor.lastFailureCode, 'ENOTFOUND');
  } finally {
    for (const file of [ledger, portfolio]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
});

test('실패 callback 없이 in-flight risk check가 오래되면 paper 루프를 fail-closed 한다', () => {
  const start = Date.parse('2026-09-13T00:00:00.000Z');
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 100_000,
    maxRiskDataGapSeconds: 5,
    useNews: false
  });

  trader.paperValidation = { active: true, telemetry: {} };
  trader.riskMonitorState = {
    monitoringActive: true,
    monitoringStartedAt: new Date(start).toISOString(),
    lastAttemptAt: new Date(start).toISOString(),
    lastSuccessAt: new Date(start).toISOString(),
    continuityEligible: true
  };
  trader.savePaperValidation = () => {};
  trader.isRunning = true;

  try {
    const status = trader.enforceRiskMonitorFreshness(start + 6_000);

    assert.equal(status.failClosed, true);
    assert.equal(trader.isRunning, false);
    assert.equal(trader._stopRequested, true);
    assert.equal(trader.stopReason, 'risk_data_gap');
    assert.equal(trader.riskMonitorState.lastFailureCode, 'RISK_CHECK_STALE');
    assert.equal(trader.riskMonitorState.continuityEligible, false);
    assert.equal(trader.riskMonitorState.currentOutageStartedAt, new Date(start).toISOString());
    assert.equal(trader.paperValidation.riskMonitor.continuityEligible, false);
  } finally {
    trader.stopPositionRiskMonitor();
  }
});

test('risk monitor는 네트워크 대기 전에 활성 보호 상태를 paper ledger에 남긴다', async () => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 100_000,
    useNews: false
  });
  let resolveTicker;
  let riskRequestOptions;
  let saveCount = 0;
  const position = {
    coin: 'KRW-BTC',
    entryPrice: 100_000,
    amount: 0.2,
    investAmount: 20_000,
    entryTimestamp: new Date().toISOString(),
    signalKey: 'risk-attempt-persistence'
  };
  trader.paperValidation = {
    active: true,
    sessionId: 'paper-risk-attempt-persistence',
    telemetry: {},
    riskMonitor: { monitoringActive: false },
    shadow: { positions: { 'KRW-BTC': position }, closedTrades: [] },
    looseShadow: { positions: {} }
  };
  trader.savePaperValidation = () => { saveCount += 1; };
  trader.riskUpbit = {
    getTicker(_markets, options) {
      riskRequestOptions = options;
      return new Promise(resolve => { resolveTicker = resolve; });
    }
  };
  trader.isRunning = true;

  const pending = trader.monitorOpenPositions();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(trader.riskMonitorState.monitoringActive, true);
  assert.equal(trader.paperValidation.riskMonitor.monitoringActive, true);
  assert.equal(saveCount, 1);
  assert.deepEqual(riskRequestOptions, { priority: 'risk' });

  resolveTicker([{ market: 'KRW-BTC', trade_price: 100_000 }]);
  await pending;

  assert.equal(trader.riskMonitorState.lastSuccessAt !== null, true);
  assert.equal(trader.riskMonitorState.monitoringActive, true);
  trader.isRunning = false;
  trader.stopPositionRiskMonitor();
});

test('risk monitor timer는 stale callback 없이도 보호 공백을 감지해 중지한다', async () => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 100_000,
    maxRiskDataGapSeconds: 5,
    positionRiskCheckIntervalMs: 250,
    useNews: false
  });
  const staleAt = Date.now() - 6_000;
  trader.paperValidation = {
    active: true,
    sessionId: 'paper-risk-watchdog',
    telemetry: {},
    riskMonitor: { monitoringActive: true }
  };
  trader.riskMonitorState = {
    monitoringActive: true,
    monitoringStartedAt: new Date(staleAt).toISOString(),
    lastAttemptAt: new Date(staleAt).toISOString(),
    lastSuccessAt: new Date(staleAt).toISOString(),
    continuityEligible: true
  };
  trader.savePaperValidation = () => {};
  trader.isRunning = true;

  try {
    trader.startPositionRiskMonitor();
    await new Promise(resolve => setTimeout(resolve, 350));

    assert.equal(trader.isRunning, false);
    assert.equal(trader._stopRequested, true);
    assert.equal(trader.stopReason, 'risk_data_gap');
    assert.equal(trader.riskMonitorState.lastFailureCode, 'RISK_CHECK_STALE');
    assert.equal(trader.paperValidation.riskMonitor.continuityEligible, false);
  } finally {
    trader.stopPositionRiskMonitor();
  }
});

test('진행 중인 risk ticker 요청도 마지막 성공 시각 초과 시 fail-closed 된다', async () => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 100_000,
    maxRiskDataGapSeconds: 5,
    useNews: false
  });
  let resolveTicker;
  const position = {
    coin: 'KRW-BTC',
    entryPrice: 100_000,
    amount: 0.2,
    investAmount: 20_000,
    entryTimestamp: new Date().toISOString(),
    signalKey: 'risk-in-flight-stale'
  };
  trader.paperValidation = {
    active: true,
    sessionId: 'paper-risk-in-flight-stale',
    telemetry: {},
    riskMonitor: { monitoringActive: false },
    shadow: { positions: { 'KRW-BTC': position }, closedTrades: [] },
    looseShadow: { positions: {} }
  };
  trader.savePaperValidation = () => {};
  trader.riskUpbit = {
    getTicker() {
      return new Promise(resolve => { resolveTicker = resolve; });
    }
  };
  trader.isRunning = true;

  const pending = trader.monitorOpenPositions();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(trader.riskMonitorState.monitoringActive, true);

  const stale = trader.enforceRiskMonitorFreshness(Date.now() + 6_000);

  assert.equal(stale.failClosed, true);
  assert.equal(trader.isRunning, false);
  assert.equal(trader.stopReason, 'risk_data_gap');
  assert.equal(trader.riskMonitorState.lastFailureCode, 'RISK_CHECK_STALE');
  assert.equal(trader.riskMonitorState.continuityEligible, false);

  resolveTicker([{ market: 'KRW-BTC', trade_price: 100_000 }]);
  await pending;
  assert.equal(trader.riskMonitorState.continuityEligible, false);
});

test('늦게 도착한 risk 성공 callback도 paper 세션을 복구시키지 않는다', () => {
  const start = Date.parse('2026-09-13T00:00:00.000Z');
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 100_000,
    maxRiskDataGapSeconds: 5,
    useNews: false
  });

  trader.paperValidation = {
    active: true,
    sessionId: 'paper-risk-late-success',
    telemetry: {},
    riskMonitor: {}
  };
  trader.riskMonitorState = {
    monitoringActive: true,
    monitoringStartedAt: new Date(start).toISOString(),
    lastAttemptAt: new Date(start).toISOString(),
    lastSuccessAt: new Date(start).toISOString(),
    continuityEligible: true
  };
  trader.savePaperValidation = () => {};
  trader.isRunning = true;

  try {
    const status = trader.recordRiskMonitorSuccess(start + 6_000);

    assert.equal(status.failClosed, true);
    assert.equal(trader.isRunning, false);
    assert.equal(trader.stopReason, 'risk_data_gap');
    assert.equal(trader.riskMonitorState.lastFailureCode, 'RISK_CHECK_STALE');
    assert.equal(trader.riskMonitorState.continuityEligible, false);
    assert.equal(trader.paperValidation.riskMonitor.continuityEligible, false);
  } finally {
    trader.stopPositionRiskMonitor();
  }
});

test('risk 성공 timestamp는 observer용 ledger에 주기적으로만 저장된다', () => {
  const start = Date.parse('2026-09-13T00:00:00.000Z');
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 100_000,
    maxRiskDataGapSeconds: 30,
    useNews: false
  });
  let saveCount = 0;
  trader.paperValidation = {
    active: true,
    sessionId: 'paper-risk-success-persistence',
    telemetry: {},
    riskMonitor: {}
  };
  trader.riskMonitorState = {
    monitoringActive: true,
    monitoringStartedAt: new Date(start).toISOString(),
    lastAttemptAt: new Date(start).toISOString(),
    lastSuccessAt: new Date(start).toISOString(),
    continuityEligible: true
  };
  trader.lastRiskStatePersistedAt = start;
  trader.savePaperValidation = () => { saveCount += 1; };

  const first = trader.recordRiskMonitorSuccess(start + 6_000);
  const second = trader.recordRiskMonitorSuccess(start + 7_000);

  assert.equal(first.riskDataFresh, true);
  assert.equal(second.riskDataFresh, true);
  assert.equal(saveCount, 1);
  assert.equal(trader.lastRiskStatePersistedAt, start + 6_000);
});

test('in-flight analysis cycle가 오래되면 paper loop를 fail-closed 한다', () => {
  const start = Date.parse('2026-09-13T00:00:00.000Z');
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 100_000,
    maxAnalysisDataGapSeconds: 5,
    useNews: false
  });

  trader.paperValidation = {
    active: true,
    sessionId: 'paper-analysis-stale',
    telemetry: {},
    analysisDataHealth: {}
  };
  trader.analysisDataHealthState = {
    analysisActive: true,
    analysisStartedAt: new Date(start).toISOString(),
    lastAttemptAt: new Date(start).toISOString(),
    lastCompleteAt: new Date(start - 60_000).toISOString(),
    continuityEligible: true
  };
  trader.analysisCycleProgress = new Set();
  trader.savePaperValidation = () => {};
  trader.isRunning = true;

  try {
    const status = trader.enforceAnalysisDataFreshness(start + 6_000);

    assert.equal(status.failClosed, true);
    assert.equal(trader.isRunning, false);
    assert.equal(trader._stopRequested, true);
    assert.equal(trader.stopReason, 'analysis_data_gap');
    assert.equal(trader.analysisDataHealthState.continuityEligible, false);
    assert.equal(trader.analysisDataHealthState.lastMissingMarkets[0], 'KRW-BTC');
    assert.equal(trader.paperValidation.analysisDataHealth.continuityEligible, false);
  } finally {
    trader.stopAnalysisDataWatchdog();
  }
});

test('analysis watchdog timer는 in-flight cycle 공백을 감지해 중지한다', async () => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 100_000,
    maxAnalysisDataGapSeconds: 5,
    useNews: false
  });
  const staleAt = Date.now() - 6_000;
  trader.paperValidation = {
    active: true,
    sessionId: 'paper-analysis-watchdog',
    telemetry: {},
    analysisDataHealth: { analysisActive: true }
  };
  trader.analysisDataHealthState = {
    analysisActive: true,
    analysisStartedAt: new Date(staleAt).toISOString(),
    lastAttemptAt: new Date(staleAt).toISOString(),
    lastCompleteAt: new Date(staleAt - 60_000).toISOString(),
    continuityEligible: true
  };
  trader.analysisCycleProgress = new Set();
  trader.savePaperValidation = () => {};
  trader.isRunning = true;

  try {
    trader.startAnalysisDataWatchdog();
    await new Promise(resolve => setTimeout(resolve, 1_200));

    assert.equal(trader.isRunning, false);
    assert.equal(trader._stopRequested, true);
    assert.equal(trader.stopReason, 'analysis_data_gap');
    assert.equal(trader.analysisDataHealthState.continuityEligible, false);
    assert.equal(trader.paperValidation.analysisDataHealth.continuityEligible, false);
  } finally {
    trader.stopAnalysisDataWatchdog();
  }
});

test('shadow 리스크 모니터도 break-even/trailing 보호 출구 상태를 유지한다', async () => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 100_000,
    stopLossPercent: 1.2,
    takeProfitPercent: 5,
    breakEvenTriggerPercent: 0.5,
    breakEvenOffsetPercent: 0.05,
    trailingActivationPercent: 0.8,
    trailingStopPercent: 0.4,
    useNews: false
  });
  const position = {
    coin: 'KRW-BTC',
    entryPrice: 100,
    amount: 200,
    investAmount: 20_000,
    entryTimestamp: new Date().toISOString(),
    signalKey: 'shadow-protection-test',
    rejectionReasons: ['volume_confirmation_failed']
  };
  let price = 101;
  trader.paperValidation = {
    active: true,
    shadow: {
      positions: { 'KRW-BTC': position },
      closedTrades: [],
      entryCount: 1,
      realizedProfit: 0,
      totalInvested: 20_000,
      winningTrades: 0,
      losingTrades: 0
    },
    looseShadow: { positions: {} }
  };
  trader.savePaperValidation = () => {};
  trader.riskUpbit = {
    async getTicker() {
      return [{ market: 'KRW-BTC', trade_price: price }];
    }
  };
  trader.isRunning = true;

  await trader.monitorOpenPositions();
  assert.equal(trader.paperValidation.shadow.positions['KRW-BTC'].trailingArmed, true);

  price = 100.5;
  await trader.monitorOpenPositions();
  assert.equal(trader.paperValidation.shadow.positions['KRW-BTC'], undefined);
  assert.equal(trader.paperValidation.shadow.closedTrades[0].reason, 'TRAILING_STOP');
  trader.isRunning = false;
  trader.stopPositionRiskMonitor();
});

test('손실이 확인된 rejection 코호트는 자동 완화 추천 대신 필터 유지를 안내한다', async () => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false
  });
  trader.paperValidation = {
    active: true,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    baselineAssets: 1_000_000,
    processId: process.pid,
    configSnapshot: trader.getPaperValidationConfigSnapshot(),
    configSnapshotComplete: true,
    telemetry: {
      cycles: 20,
      buyCandidates: 0,
      shadowCandidates: 4,
      sellSignals: 0,
      holdDecisions: 4,
      reasonCounts: {},
      rejectionCounts: {
        previous_high_break_failed: 4,
        volume_confirmation_failed: 4
      }
    },
    strictTrades: [],
    shadow: {
      positions: {},
      closedTrades: [
        { netProfit: -100, rejectionReasons: ['previous_high_break_failed', 'volume_confirmation_failed'] },
        { netProfit: -80, rejectionReasons: ['previous_high_break_failed', 'volume_confirmation_failed'] },
        { netProfit: -50, rejectionReasons: ['previous_high_break_failed', 'volume_confirmation_failed'] },
        { netProfit: -30, rejectionReasons: ['volume_confirmation_failed'] }
      ],
      entryCount: 4,
      realizedProfit: -260,
      totalInvested: 80_000,
      winningTrades: 0,
      losingTrades: 4
    },
    looseShadow: { positions: {}, closedTrades: [] }
  };
  trader.calculateTotalAssets = async () => 1_000_000;

  const status = await trader.getPaperValidationStatus();

  assert.equal(status.filterStarvation, true);
  assert.match(status.suggestedAdjustments.join(' '), /직전 고가 돌파 필터 유지/);
  assert.match(status.suggestedAdjustments.join(' '), /minVolumeRatio=1\.0 필터 유지/);
  assert.match(status.suggestedAdjustments.join(' '), /완화 금지/);
});

test('과매도 반등 후보가 없는 조용한 시장은 filter starvation으로 오탐하지 않는다', async () => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false
  });
  trader.paperValidation = {
    active: true,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    baselineAssets: 1_000_000,
    processId: process.pid,
    configSnapshot: trader.getPaperValidationConfigSnapshot(),
    configSnapshotComplete: true,
    telemetry: {
      cycles: 20,
      buyCandidates: 0,
      shadowCandidates: 0,
      oversoldObservations: 0,
      strictReboundCandidates: 0,
      strictConfirmedCandidates: 0,
      sellSignals: 0,
      holdDecisions: 20,
      reasonCounts: { '과매도 조건 없음 - 관망': 20 },
      rejectionCounts: { previous_rsi_not_oversold: 20 }
    },
    strictTrades: [],
    strictOpenPositions: [],
    shadow: {
      positions: {},
      closedTrades: [],
      entryCount: 0,
      realizedProfit: 0,
      totalInvested: 0,
      winningTrades: 0,
      losingTrades: 0
    },
    looseShadow: {
      positions: {},
      closedTrades: [],
      entryCount: 0,
      realizedProfit: 0,
      totalInvested: 0,
      winningTrades: 0,
      losingTrades: 0
    }
  };
  trader.calculateTotalAssets = async () => 1_000_000;

  const status = await trader.getPaperValidationStatus();

  assert.equal(status.filterStarvation, false);
  assert.equal(status.marketQuiet, true);
  assert.equal(status.oversoldObservedNoRebound, false);
  assert.deepEqual(status.signalAvailability, {
    oversoldObservations: 0,
    strictReboundCandidates: 0,
    strictConfirmedCandidates: 0,
    uniqueSignalWindows: null,
    rsiProximity: {
      version: 1,
      threshold: 30,
      nearThresholdBand: 5,
      uniqueAvailableWindows: 0,
      uniqueAvailableWindowsByCoin: {},
      minimumPreviousRsi: null,
      minimumPreviousRsiByCoin: {},
      nearThresholdWindows: 0,
      nearThresholdWindowsByCoin: {}
    },
    signalFunnel: {
      version: 1,
      availableWindows: 0,
      oversoldWindows: 0,
      bullishWindows: 0,
      priceReboundWindows: 0,
      rsiRecoveryWindows: 0,
      volumeWindows: 0,
      candleRangeWindows: 0,
      closeStrengthWindows: 0,
      trendWindows: 0,
      previousHighBreakWindows: 0,
      profileWindows: 0,
      confirmedWindows: 0
    },
    lastSignalEvidenceByCoin: {}
  });
  assert.deepEqual(status.suggestedAdjustments, []);
});

test('과매도 관측은 있지만 반등 후보가 없는 상태를 조용한 시장과 구분한다', async () => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false
  });
  trader.calculateTotalAssets = async () => 1_000_000;
  trader.paperValidation = {
    active: true,
    startedAt: new Date(Date.now() - 20 * 86_400_000).toISOString(),
    processId: process.pid,
    baselineAssets: 1_000_000,
    configSnapshot: trader.getPaperValidationConfigSnapshot(),
    configSnapshotComplete: true,
    strictTrades: [],
    strictOpenPositions: [],
    telemetry: {
      cycles: 20,
      buyCandidates: 0,
      oversoldObservations: 2,
      strictReboundCandidates: 0,
      strictConfirmedCandidates: 0,
      signalTelemetryVersion: 1,
      signalTelemetryCoverageStartedAt: new Date().toISOString()
    },
    shadow: { positions: {}, closedTrades: [] },
    looseShadow: { positions: {}, closedTrades: [] },
    snapshots: [{ timestamp: new Date().toISOString(), totalAssets: 1_000_000 }]
  };

  const status = await trader.getPaperValidationStatus();
  assert.equal(status.filterStarvation, false);
  assert.equal(status.marketQuiet, false);
  assert.equal(status.oversoldObservedNoRebound, true);
  assert.deepEqual(status.suggestedAdjustments, []);
});

test('risk monitor는 winnerShadow book에 strict가 아닌 shadow winner-hold 설정을 적용한다', async () => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false,
    maxHoldMinutes: 30,
    winnerShadowExtendMinutes: 30,
    winnerShadowExtendMinProfitPercent: 0
  });
  trader.calculateTotalAssets = async () => 1_000_000;
  trader.savePaperValidation = () => {};
  trader.isRunning = true;
  // Past strict max-hold but still inside the winner-shadow extension window.
  const entryTime = Date.now() - 31 * 60 * 1000;
  const diagnosticPosition = () => ({
    entryPrice: 100,
    amount: 10,
    investAmount: 1_000,
    entryTimestamp: new Date(entryTime).toISOString(),
    signalKey: 'winner-shadow-risk-signal'
  });
  trader.paperValidation = {
    active: true,
    startedAt: new Date(entryTime - 60_000).toISOString(),
    baselineAssets: 1_000_000,
    processId: process.pid,
    configSnapshot: trader.getPaperValidationConfigSnapshot(),
    configSnapshotComplete: true,
    paperExperiments: trader.getPaperExperimentSnapshot(),
    strictTrades: [],
    strictOpenPositions: [],
    telemetry: {},
    shadow: {
      positions: { 'KRW-BTC': diagnosticPosition() },
      lastSignalByCoin: {},
      closedTrades: [],
      entryCount: 1,
      realizedProfit: 0,
      totalInvested: 1_000,
      winningTrades: 0,
      losingTrades: 0,
      cooldownUntilByCoin: {},
      consecutiveLossesByCoin: {},
      lossCircuitBreaker: createLossCircuitBreakerState()
    },
    looseShadow: { positions: {}, closedTrades: [] },
    winnerShadow: {
      positions: { 'KRW-BTC': diagnosticPosition() },
      lastSignalByCoin: {},
      closedTrades: [],
      entryCount: 1,
      realizedProfit: 0,
      totalInvested: 1_000,
      winningTrades: 0,
      losingTrades: 0,
      cooldownUntilByCoin: {},
      consecutiveLossesByCoin: {},
      lossCircuitBreaker: createLossCircuitBreakerState()
    },
    snapshots: []
  };
  trader.riskUpbit.getTicker = async () => [{ market: 'KRW-BTC', trade_price: 101 }];

  try {
    await trader.monitorOpenPositions();

    // The winner-shadow book must survive strict max-hold inside its own
    // extension window; the ordinary shadow book closes at strict max-hold.
    const winnerPosition = trader.paperValidation.winnerShadow.positions['KRW-BTC'];
    assert.ok(winnerPosition, 'winnerShadow position must not close at strict maxHoldMinutes');
    assert.equal(winnerPosition.winnerExtended, true);
    assert.equal(trader.paperValidation.winnerShadow.closedTrades.length, 0);
    assert.equal(trader.paperValidation.shadow.closedTrades.length, 1);
    assert.equal(trader.paperValidation.shadow.closedTrades[0].reason, 'MAX_HOLD_TIME');
    assert.equal(trader.paperValidation.shadow.closedTrades[0].winnerExtended, false);
  } finally {
    trader.stopPositionRiskMonitor();
    trader.isRunning = false;
  }
});
