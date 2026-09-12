import assert from 'node:assert/strict';
import test from 'node:test';
import MultiCoinTrader from '../src/trader/multiCoinTrader.js';

function createTrader(maxAnalysisDataGapSeconds = 60) {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC', 'KRW-ETH'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false,
    maxAnalysisDataGapSeconds
  });
  trader.paperValidation = { active: true, telemetry: {} };
  trader.savePaperValidation = () => {};
  trader.cycleRequestStats = {
    batchTickerRequests: 1,
    individualTickerRequests: 0,
    candleRequests: 2,
    batchTickerFailures: 0
  };
  return trader;
}

test('부분 분석이 회복되면 health 공백을 닫고 연속성을 유지한다', () => {
  const trader = createTrader(60);
  const start = Date.UTC(2026, 8, 11, 0, 0, 0);

  const partial = trader.recordAnalysisDataHealth([{ coin: 'KRW-BTC' }], start);
  trader.recordPaperIncompleteAnalysisTelemetry(partial);
  assert.equal(partial.complete, false);
  assert.equal(partial.failClosed, false);
  assert.equal(trader.paperValidation.telemetry.analysisIncompleteCycles, 1);

  const complete = trader.recordAnalysisDataHealth([
    { coin: 'KRW-BTC' },
    { coin: 'KRW-ETH' }
  ], start + 30_000);
  assert.equal(complete.complete, true);
  assert.equal(complete.status.continuityEligible, true);
  assert.equal(complete.status.currentGapDurationSeconds, 0);
  assert.equal(complete.status.maxObservedGapSeconds, 30);
  assert.equal(trader.paperValidation.analysisDataHealth.currentGapStartedAt, null);
});

test('분석 공백 한도를 넘으면 관찰을 중지하고 health를 저장한다', () => {
  const trader = createTrader(5);
  trader.isRunning = true;
  const start = Date.UTC(2026, 8, 11, 0, 0, 0);

  const first = trader.recordAnalysisDataHealth([], start);
  trader.recordPaperIncompleteAnalysisTelemetry(first);
  assert.equal(first.failClosed, false);
  assert.equal(trader.isRunning, true);

  const exceeded = trader.recordAnalysisDataHealth([], start + 5_000);
  trader.recordPaperIncompleteAnalysisTelemetry(exceeded);
  if (exceeded.failClosed && trader.isRunning) trader.stop('analysis_data_gap');

  assert.equal(exceeded.failClosed, true);
  assert.equal(exceeded.status.continuityEligible, false);
  assert.equal(trader.isRunning, false);
  assert.equal(trader._stopRequested, true);
  assert.equal(trader.stopReason, 'analysis_data_gap');
  assert.equal(trader.paperValidation.telemetry.analysisIncompleteCycles, 2);
  assert.equal(trader.paperValidation.telemetry.lastIncompleteAnalysis.failClosed, true);
});

test('실제 trading cycle의 부분 응답은 shadow 진입 없이 fail-closed 된다', async () => {
  const trader = createTrader(5);
  trader.isRunning = true;
  trader.getAccountInfo = async () => [{ currency: 'KRW', balance: '1000000' }];
  trader.getTickerMapForCycle = async () => new Map([
    ['KRW-BTC', { market: 'KRW-BTC', trade_price: 100 }],
    ['KRW-ETH', { market: 'KRW-ETH', trade_price: 100 }]
  ]);
  trader.analyzeCoin = async coin => {
    if (coin === 'KRW-ETH') throw new Error('synthetic market timeout');
    return {
      coin,
      currentPrice: 100,
      coinBalance: 0,
      candleFreshness: { valid: true },
      decision: {
        action: 'HOLD',
        reason: '완전 분석 테스트',
        scores: { total: '0' },
        details: { rebound: null }
      }
    };
  };
  trader.printPortfolioSummary = () => {};
  trader.notifyAnalysisCycle = () => {};

  await trader.executeTradingCycle();
  assert.equal(trader.isRunning, true);
  assert.equal(trader.paperValidation.telemetry.analysisIncompleteCycles, 1);
  assert.equal(trader.paperValidation.telemetry.analysisMissingMarkets, 1);
  assert.equal(trader.paperValidation.shadow?.entryCount || 0, 0);
  assert.equal(trader.paperValidation.looseShadow?.entryCount || 0, 0);

  trader.analysisDataHealthState.currentGapStartedAt = new Date(Date.now() - 6_000).toISOString();
  trader.isRunning = true;
  await trader.executeTradingCycle();
  assert.equal(trader.isRunning, false);
  assert.equal(trader.stopReason, 'analysis_data_gap');
  assert.equal(trader.analysisDataHealthState.continuityEligible, false);
  assert.equal(trader.paperValidation.telemetry.analysisIncompleteCycles, 2);
  assert.equal(trader.paperValidation.telemetry.lastIncompleteAnalysis.failClosed, true);
  assert.equal(trader.paperValidation.shadow?.entryCount || 0, 0);
});
