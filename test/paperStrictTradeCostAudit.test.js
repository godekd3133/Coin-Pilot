import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizePaperStrictTradeCostAudit } from '../src/research/paperStrictTradeCostAudit.js';

test('strict paper 비용 민감도는 기록 손익과 설정 미끄러짐 추정을 분리한다', () => {
  const trade = {
    action: 'CLOSE',
    coin: 'KRW-SOL',
    entryPrice: 162_000,
    exitPrice: 162_400,
    amount: 1.2339506172839507,
    profit: 293.4334567901235,
    exitTime: '2026-09-28T04:37:05.901Z'
  };
  const result = summarizePaperStrictTradeCostAudit({
    configSnapshotComplete: true,
    configSnapshot: { slippage: 0.001 },
    strictTrades: [trade]
  });

  assert.equal(result.available, true);
  assert.equal(result.researchOnly, true);
  assert.equal(result.promoted, false);
  assert.equal(result.actualFillsObserved, false);
  assert.equal(result.slippageAppliedToStrictPaperLedger, false);
  assert.equal(result.quoteCrossingCostAvailable, false);
  assert.equal(result.closedTradeCount, 1);
  assert.equal(result.evaluatedTradeCount, 1);
  assert.equal(result.modeledExecutionTradeCount, 0);
  assert.equal(result.unmodeledExecutionTradeCount, 1);
  assert.ok(Math.abs(result.recordedNetPnlKrw - 293.4334567901235) < 1e-9);
  assert.ok(Math.abs(result.modeledSlippageDragKrw - 400.2935802469136) < 1e-8);
  assert.ok(Math.abs(result.costStressedNetPnlKrw - (-106.86012345679012)) < 1e-8);
});

test('버전이 있는 strict paper 비용 모델은 슬리피지를 다시 차감하지 않는다', () => {
  const trade = {
    action: 'CLOSE',
    coin: 'KRW-BTC',
    entryPrice: 100.5,
    exitPrice: 109.45,
    amount: 198.90547263681594,
    profit: 1_759.318717412943,
    paperExecutionCostModel: 'strict_paper_cost_model_v1',
    paperExecutionSlippageRate: 0.005,
    paperExecutionTradingFeeRate: 0.0005
  };
  const result = summarizePaperStrictTradeCostAudit({
    configSnapshotComplete: true,
    configSnapshot: { slippage: 0.005 },
    strictTrades: [trade]
  });

  assert.equal(result.slippageAppliedToStrictPaperLedger, true);
  assert.equal(result.modeledExecutionTradeCount, 1);
  assert.equal(result.unmodeledExecutionTradeCount, 0);
  assert.equal(result.modeledSlippageDragKrw, 0);
  assert.equal(result.costStressedNetPnlKrw, trade.profit);
});

test('비용 모델 버전이 기록되어도 비용 메타데이터가 빠지면 추정하지 않는다', () => {
  const result = summarizePaperStrictTradeCostAudit({
    configSnapshotComplete: true,
    configSnapshot: { slippage: 0.001 },
    strictTrades: [{
      action: 'CLOSE',
      coin: 'KRW-SOL',
      entryPrice: 162_162,
      exitPrice: 162_237.6,
      amount: 1.231,
      profit: -100,
      paperExecutionCostModel: 'strict_paper_cost_model_v1',
      paperExecutionSlippageRate: 0.001
    }]
  });

  assert.equal(result.available, true);
  assert.equal(result.slippageAppliedToStrictPaperLedger, null);
  assert.equal(result.modeledExecutionTradeCount, 0);
  assert.equal(result.unmodeledExecutionTradeCount, 0);
  assert.equal(result.evaluatedTradeCount, 0);
  assert.equal(result.unevaluableTradeCount, 1);
  assert.equal(result.costStressedNetPnlKrw, null);
});

test('strict paper 비용 민감도는 불완전 설정과 손익 필드 누락을 수익으로 취급하지 않는다', () => {
  const unavailable = summarizePaperStrictTradeCostAudit({
    configSnapshotComplete: false,
    configSnapshot: { slippage: 0.001 },
    strictTrades: [{ action: 'CLOSE', profit: 100 }]
  });
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.costStressedNetPnlKrw, null);

  const incomplete = summarizePaperStrictTradeCostAudit({
    configSnapshotComplete: true,
    configSnapshot: { slippage: 0.001 },
    strictTrades: [{ action: 'CLOSE', profit: 100 }]
  });
  assert.equal(incomplete.available, true);
  assert.equal(incomplete.closedTradeCount, 1);
  assert.equal(incomplete.evaluatedTradeCount, 0);
  assert.equal(incomplete.unevaluableTradeCount, 1);
  assert.equal(incomplete.reason, 'no_evaluable_trades');
  assert.equal(incomplete.recordedNetPnlKrw, null);
  assert.equal(incomplete.costStressedNetPnlKrw, null);
});

test('strict paper 비용 감사는 기록 손익을 소진하는 추가 양방향 미끄러짐 한도를 계산한다', () => {
  const result = summarizePaperStrictTradeCostAudit({
    configSnapshotComplete: true,
    configSnapshot: { slippage: 0.001 },
    strictTrades: [{
      action: 'CLOSE',
      coin: 'KRW-BTC',
      entryPrice: 10_000,
      exitPrice: 10_100,
      amount: 1,
      profit: 50
    }]
  });

  assert.equal(result.recordedNetPnlKrw, 50);
  assert.equal(result.twoSidedNotionalKrw, 20_100);
  assert.ok(Math.abs(result.breakEvenAdditionalSlippagePerSidePercent - (50 / 20_100 * 100)) < 1e-12);
  assert.equal(result.actualFillsObserved, false);
});

test('strict paper 비용 감사는 비양수 기록 손익에 손익분기 미끄러짐 여유를 부여하지 않는다', () => {
  const result = summarizePaperStrictTradeCostAudit({
    configSnapshotComplete: true,
    configSnapshot: { slippage: 0.001 },
    strictTrades: [{
      action: 'CLOSE',
      coin: 'KRW-BTC',
      entryPrice: 10_000,
      exitPrice: 10_100,
      amount: 1,
      profit: 0
    }]
  });

  assert.equal(result.twoSidedNotionalKrw, 20_100);
  assert.equal(result.breakEvenAdditionalSlippagePerSidePercent, null);
});
