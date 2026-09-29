import assert from 'node:assert/strict';
import test from 'node:test';
import MultiCoinTrader from '../src/trader/multiCoinTrader.js';

function createTradingCycleHarness(decisions) {
  const trader = Object.create(MultiCoinTrader.prototype);
  const coins = Object.keys(decisions);
  let accountReads = 0;
  const executed = [];

  Object.assign(trader, {
    dryRun: true,
    useNews: false,
    targetCoins: coins,
    config: { marketRegimeEnabled: false },
    cycleRequestStats: null,
    beginAnalysisDataCycle() {},
    async getAccountInfo() {
      accountReads += 1;
      return [{ currency: 'KRW', balance: '1000', locked: '0' }];
    },
    getKRWBalance(accounts) {
      return Number(accounts[0].balance);
    },
    getTickerMapForCycle: async () => new Map(),
    async analyzeCoin(coin) {
      // Model the existing per-market analysis account read; this test is
      // specifically about the second, pre-execution read for each candidate.
      await this.getAccountInfo();
      return {
        coin,
        currentPrice: 100,
        coinBalance: 0,
        marketReturnPercent: 0,
        decision: {
          action: decisions[coin],
          reason: 'fixture',
          scores: { total: 1 },
          signalStrength: { level: 'NONE' }
        }
      };
    },
    recordAnalysisDataHealth: () => ({ complete: true, failClosed: false }),
    recordPaperSignalTelemetry() {},
    notifyAnalysisCycle() {},
    getCurrentPositionCount: () => 0,
    async executeOrder(...args) {
      executed.push(args);
    },
    printPortfolioSummary() {}
  });

  return {
    trader,
    get accountReads() { return accountReads; },
    executed
  };
}

test('HOLD candidates skip only their redundant pre-execution account refresh', async () => {
  const harness = createTradingCycleHarness({
    'KRW-BTC': 'HOLD',
    'KRW-ETH': 'HOLD',
    'KRW-XRP': 'HOLD'
  });

  await harness.trader.executeTradingCycle();

  // One cycle-level account read plus one unchanged analysis read per market.
  assert.equal(harness.accountReads, 4);
  assert.equal(harness.executed.length, 3);
  assert.deepEqual(harness.executed.map(([coin, decision]) => [coin, decision.action]), [
    ['KRW-BTC', 'HOLD'],
    ['KRW-ETH', 'HOLD'],
    ['KRW-XRP', 'HOLD']
  ]);
});

test('BUY and SELL candidates retain a fresh account read before order execution', async () => {
  const harness = createTradingCycleHarness({
    'KRW-BTC': 'BUY',
    'KRW-ETH': 'HOLD',
    'KRW-XRP': 'SELL'
  });

  await harness.trader.executeTradingCycle();

  // One cycle-level read, one per analyzed market, and one fresh read for
  // each actionable candidate. HOLD has no additional pre-execution read.
  assert.equal(harness.accountReads, 6);
  assert.deepEqual(harness.executed.map(([coin, decision]) => [coin, decision.action]), [
    ['KRW-BTC', 'BUY'],
    ['KRW-ETH', 'HOLD'],
    ['KRW-XRP', 'SELL']
  ]);
});
