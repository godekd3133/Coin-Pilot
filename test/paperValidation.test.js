import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import MultiCoinTrader from '../src/trader/multiCoinTrader.js';

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

    const stopped = await trader.stopPaperValidationSession();
    assert.equal(stopped.active, false);
    assert.equal(stopped.state, 'STOPPED');
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
    assert.equal(closed.shadowEvaluation.rejectionOutcomes[0].reason, 'previous_high_break_failed');
    assert.equal(closed.shadowEvaluation.rejectionOutcomes[0].tradeCount, 1);
    assert.equal(trader.virtualPortfolio.krwBalance, 1_000_000);
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
    assert.deepEqual(trader.paperValidation.strictOpenPositions, [], 'strict close must clear the persisted open snapshot');
    assert.deepEqual(JSON.parse(fs.readFileSync(ledger, 'utf8')).strictOpenPositions, []);
    const sameProcess = await trader.getPaperValidationStatus();
    assert.equal(sameProcess.closedTradeCount, 1);
    assert.equal(sameProcess.strictEvaluation.activePositions, 0);

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
  } finally {
    for (const file of [ledger, portfolio, `${portfolio}.reload`]) {
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

  const closed = strategy.closePosition(99, 'attribution 테스트');
  assert.equal(closed.signalKey, 'signal-1');
  assert.equal(closed.executionDriftPercent, 0);
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

    const status = await trader.getPaperValidationStatus();
    assert.equal(status.processAlive, false);
    assert.equal(status.orphaned, true);
    assert.equal(status.active, false);
    assert.equal(status.state, 'STOPPED');
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
    'requirePreviousHighBreak', 'maxSignalRangePercent', 'minSignalRangePercent', 'maxCandleAgeSeconds', 'stopLossPercent',
    'takeProfitPercent', 'maxHoldMinutes', 'maxLosingHoldMinutes', 'maxEntriesPerSignalWindow', 'breakEvenTriggerPercent', 'breakEvenOffsetPercent',
    'trailingActivationPercent', 'trailingStopPercent', 'cooldownAfterLossMinutes', 'maxConsecutiveLosses',
    'marketRegimeEnabled', 'marketRegimeLookback', 'marketRegimeMinBreadth', 'marketRegimeMinReturnPercent', 'requireReboundBelowOverbought',
    'lossCircuitBreakerCount', 'lossCircuitBreakerWindowMinutes', 'lossCircuitBreakerCooldownMinutes', 'investmentRatio', 'tradingFee', 'slippage',
    'entryDelayMinMs', 'entryDelayMaxMs', 'maxEntryRetracePercent', 'maxEntryChasePercent'
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

  assert.doesNotThrow(() => trader.validatePromotionReport({
    validationMode: 'fixed_config',
    strategyMode: 'oversold_reaction_scalping',
    promoted: true,
    markets: ['KRW-BTC'],
    promotedMarkets: ['KRW-BTC'],
    config: compatibleConfig
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
    assert.equal(trader.getRiskMonitorStatus().failClosed, true);
    assert.equal(trader.paperValidation.riskMonitor.continuityEligible, false);
    assert.equal(trader.paperValidation.telemetry.riskMonitor.lastFailureCode, 'ENOTFOUND');
  } finally {
    for (const file of [ledger, portfolio]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
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
