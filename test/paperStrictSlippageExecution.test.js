import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import MultiCoinTrader from '../src/trader/multiCoinTrader.js';
import { summarizePaperStrictTradeCostAudit } from '../src/research/paperStrictTradeCostAudit.js';

function createTrader(prefix, { explicitCostRates = true } = {}) {
  const config = {
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    investmentRatio: 0.02,
    portfolioAllocation: 1,
    useNews: false,
    paperValidationFile: path.join(os.tmpdir(), `${prefix}.paper.json`),
    virtualPortfolioFile: path.join(os.tmpdir(), `${prefix}.portfolio.json`),
    portfolioHistoryFile: path.join(os.tmpdir(), `${prefix}.history.json`),
    aiMonitoringFile: path.join(os.tmpdir(), `${prefix}.ai.json`)
  };
  if (explicitCostRates) {
    config.tradingFee = 0.001;
    config.slippage = 0.005;
  }
  const trader = new MultiCoinTrader(config);
  trader.virtualPortfolio = { krwBalance: 1_000_000, holdings: new Map() };
  trader.calculateTotalAssets = async () => 1_000_000;
  trader.calculateDynamicInvestmentAmount = async () => 20_000;
  trader.confirmScalpingEntry = async () => ({ currentPrice: 100, delayMs: 2500 });
  return trader;
}

function buyDecision() {
  return {
    action: 'BUY',
    reason: 'slippage 모델 테스트',
    signalStrength: { level: 'MEDIUM', multiplier: 1 },
    entrySignalKey: 'slippage-signal-1',
    entryReferencePrice: 100,
    details: {
      rebound: {
        signalKey: 'slippage-signal-1',
        referencePrice: 100,
        candleTime: '2026-09-28T05:00:00.000Z',
        reboundPriceChangePercent: 0.3,
        rsi: 38,
        oversoldRsi: 25,
        rsiRecovery: 13,
        volumeRatio: 1.2,
        closeStrength: 0.8,
        trendSlopePercent: 0.1,
        signalRangePercent: 0.3
      }
    }
  };
}

function removeTraderFiles(trader) {
  for (const file of [
    trader.paperValidationFile,
    trader.virtualPortfolioFile,
    trader.portfolioHistoryFile,
    trader.aiMonitoringFile
  ]) {
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
  }
}

test('sealed strict paper는 설정된 미끄러짐을 진입·청산 가격과 잔액에 반영한다', async () => {
  const trader = createTrader(`coinpilot-paper-slip-${Date.now()}`);
  try {
    await trader.startPaperValidationSession();
    await trader.executeOrder('KRW-BTC', buyDecision(), 100, 1_000_000, 0, 0, []);

    const strategy = trader.getStrategy('KRW-BTC');
    const position = strategy.currentPosition;
    assert.ok(position);
    assert.ok(Math.abs(position.entryPrice - 100.5) < 1e-9);
    assert.equal(position.paperExecutionCostModel, 'strict_paper_cost_model_v1');
    assert.equal(position.paperExecutionSlippageRate, 0.005);
    assert.equal(position.paperEntryFee, 20);
    assert.equal(position.paperExecutionTradingFeeRate, 0.001);
    assert.equal(position.paperObservedEntryPrice, 100);
    assert.equal(position.executionDriftPercent, 0);
    assert.ok(Math.abs(trader.virtualPortfolio.holdings.get('KRW-BTC').avgPrice - 100.5) < 1e-9);
    const openSnapshot = trader.getStrictOpenPositionSnapshot()[0];
    assert.equal(openSnapshot.paperExecutionCostModel, 'strict_paper_cost_model_v1');
    assert.equal(openSnapshot.paperExecutionTradingFeeRate, 0.001);

    const sellVolume = position.amount;
    await trader.executeOrder(
      'KRW-BTC',
      { action: 'SELL', reason: 'slippage 모델 청산 테스트' },
      110,
      trader.virtualPortfolio.krwBalance,
      sellVolume,
      1,
      []
    );

    const closedTrade = trader.paperValidation.strictTrades.at(-1);
    assert.equal(closedTrade.action, 'CLOSE');
    assert.ok(Math.abs(closedTrade.exitPrice - 109.45) < 1e-9);
    assert.equal(closedTrade.paperObservedEntryPrice, 100);
    assert.equal(closedTrade.paperObservedExitPrice, 110);
    assert.equal(closedTrade.paperExecutionCostModel, 'strict_paper_cost_model_v1');
    assert.equal(closedTrade.paperExecutionSlippageRate, 0.005);
    assert.equal(closedTrade.paperExecutionTradingFeeRate, 0.001);
    assert.equal(trader.paperValidation.strictOpenPositions.length, 0);
    assert.ok(Math.abs(closedTrade.totalFee - (20 + (sellVolume * 109.45 * 0.001))) < 1e-9);
    assert.ok(Math.abs(closedTrade.profit - (trader.virtualPortfolio.krwBalance - 1_000_000)) < 1e-7);

    const audit = summarizePaperStrictTradeCostAudit(trader.paperValidation);
    assert.equal(audit.slippageAppliedToStrictPaperLedger, true);
    assert.equal(audit.modeledExecutionTradeCount, 1);
    assert.equal(audit.unmodeledExecutionTradeCount, 0);
    assert.equal(audit.modeledSlippageDragKrw, 0);
    assert.equal(audit.costStressedNetPnlKrw, closedTrade.profit);
  } finally {
    trader.stop();
    removeTraderFiles(trader);
  }
});

test('runner가 비용률을 생략해도 정규화된 기본 미끄러짐·수수료를 strict 체결에 반영한다', async () => {
  const trader = createTrader(`coinpilot-paper-slip-default-${Date.now()}`, {
    explicitCostRates: false
  });
  try {
    await trader.startPaperValidationSession();
    assert.equal(trader.config.slippage, undefined);
    assert.equal(trader.config.tradingFee, undefined);
    assert.deepEqual(trader.getStrictPaperExecutionCostModel(), {
      version: 'strict_paper_cost_model_v1',
      slippageRate: 0.001,
      tradingFeeRate: 0.0005
    });

    await trader.executeOrder('KRW-BTC', buyDecision(), 100, 1_000_000, 0, 0, []);
    const strategy = trader.getStrategy('KRW-BTC');
    const position = strategy.currentPosition;
    assert.ok(Math.abs(position.entryPrice - 100.1) < 1e-9);
    assert.equal(position.paperExecutionCostModel, 'strict_paper_cost_model_v1');
    assert.equal(position.paperExecutionSlippageRate, 0.001);
    assert.equal(position.paperExecutionTradingFeeRate, 0.0005);

    await trader.executeOrder(
      'KRW-BTC',
      { action: 'SELL', reason: '기본 비용 설정 모델 청산 테스트' },
      110,
      trader.virtualPortfolio.krwBalance,
      position.amount,
      1,
      []
    );

    const closedTrade = trader.paperValidation.strictTrades.at(-1);
    assert.ok(Math.abs(closedTrade.exitPrice - 109.89) < 1e-9);
    assert.equal(closedTrade.paperExecutionCostModel, 'strict_paper_cost_model_v1');
    assert.equal(closedTrade.paperExecutionSlippageRate, 0.001);
    assert.equal(closedTrade.paperExecutionTradingFeeRate, 0.0005);
    const audit = summarizePaperStrictTradeCostAudit(trader.paperValidation);
    assert.equal(audit.modeledExecutionTradeCount, 1);
    assert.equal(audit.unmodeledExecutionTradeCount, 0);
    assert.equal(audit.modeledSlippageDragKrw, 0);
  } finally {
    trader.stop();
    removeTraderFiles(trader);
  }
});

test('일반 DRY_RUN은 sealed paper 세션이 없으면 strict slippage 모델을 강제로 적용하지 않는다', async () => {
  const trader = createTrader(`coinpilot-paper-slip-off-${Date.now()}`);
  try {
    await trader.executeOrder('KRW-BTC', buyDecision(), 100, 1_000_000, 0, 0, []);
    const position = trader.getStrategy('KRW-BTC').currentPosition;
    assert.ok(position);
    assert.equal(position.entryPrice, 100);
    assert.equal(position.paperExecutionCostModel, undefined);
    assert.equal(trader.virtualPortfolio.holdings.get('KRW-BTC').avgPrice, 100);
  } finally {
    trader.stop();
    removeTraderFiles(trader);
  }
});
