import assert from 'node:assert/strict';
import test from 'node:test';
import MultiCoinTrader from '../src/trader/multiCoinTrader.js';

function createTradingCycleHarness(decisions) {
  const trader = Object.create(MultiCoinTrader.prototype);
  const coins = Object.keys(decisions);
  const coinBalances = Object.fromEntries(coins.map(coin => [coin.replace('KRW-', ''), 0.11]));
  const makeAccounts = (krwBalance, balances) => [
    { currency: 'KRW', balance: String(krwBalance), locked: '0' },
    ...Object.entries(balances).map(([currency, balance]) => ({
      currency,
      balance: String(balance),
      locked: '0'
    }))
  ];
  const accountSnapshots = [
    makeAccounts(1000, coinBalances),
    makeAccounts(900, { ...coinBalances, BTC: 0.22 }),
    makeAccounts(800, { ...coinBalances, XRP: 0.88 })
  ];
  let accountReads = 0;
  let positionReads = 0;
  const executed = [];
  const positionReadsAtExecution = [];
  const analysisAccountSnapshots = [];

  Object.assign(trader, {
    dryRun: true,
    useNews: false,
    targetCoins: coins,
    config: { marketRegimeEnabled: false },
    cycleRequestStats: null,
    beginAnalysisDataCycle() {},
    async getAccountInfo() {
      const snapshot = accountSnapshots[Math.min(accountReads, accountSnapshots.length - 1)];
      accountReads += 1;
      return snapshot;
    },
    getKRWBalance(accounts) {
      return Number(accounts.find(account => account.currency === 'KRW')?.balance || 0);
    },
    getCoinBalance(accounts, market) {
      const currency = market.replace('KRW-', '');
      return Number(accounts.find(account => account.currency === currency)?.balance || 0);
    },
    getTickerMapForCycle: async () => new Map(),
    async analyzeCoin(coin, newsSentiment, marketData, accountSnapshot) {
      const accounts = accountSnapshot === undefined
        ? await this.getAccountInfo()
        : accountSnapshot;
      analysisAccountSnapshots.push(accounts);
      return {
        coin,
        currentPrice: 100,
        coinBalance: this.getCoinBalance(accounts, coin),
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
    getCurrentPositionCount() {
      positionReads += 1;
      return 0;
    },
    async executeOrder(...args) {
      executed.push(args);
      positionReadsAtExecution.push(positionReads);
    },
    printPortfolioSummary() {}
  });

  return {
    trader,
    get accountReads() { return accountReads; },
    get positionReads() { return positionReads; },
    analysisAccountSnapshots,
    positionReadsAtExecution,
    executed
  };
}

test('N HOLD markets share the single cycle-start account snapshot', async () => {
  const harness = createTradingCycleHarness({
    'KRW-BTC': 'HOLD',
    'KRW-ETH': 'HOLD',
    'KRW-XRP': 'HOLD'
  });

  await harness.trader.executeTradingCycle();

  assert.equal(harness.accountReads, 1);
  assert.equal(harness.analysisAccountSnapshots.length, 3);
  assert.ok(harness.analysisAccountSnapshots.every(
    snapshot => snapshot === harness.analysisAccountSnapshots[0]
  ));
  assert.equal(harness.executed.length, 3);
  assert.deepEqual(harness.executed.map(([coin, decision]) => [coin, decision.action]), [
    ['KRW-BTC', 'HOLD'],
    ['KRW-ETH', 'HOLD'],
    ['KRW-XRP', 'HOLD']
  ]);
});

test('actionable candidates keep fresh reads and SELL uses the fresh coin balance', async () => {
  const harness = createTradingCycleHarness({
    'KRW-BTC': 'BUY',
    'KRW-ETH': 'HOLD',
    'KRW-XRP': 'SELL'
  });

  await harness.trader.executeTradingCycle();

  // One cycle-level read plus one fresh account read for BUY and SELL.
  assert.equal(harness.accountReads, 3);
  // Two cycle-level observations plus one current check before each actionable order.
  assert.equal(harness.positionReads, 4);
  assert.deepEqual(harness.positionReadsAtExecution, [3, 3, 4]);
  assert.deepEqual(harness.executed.map(([coin, decision]) => [coin, decision.action]), [
    ['KRW-BTC', 'BUY'],
    ['KRW-ETH', 'HOLD'],
    ['KRW-XRP', 'SELL']
  ]);
  assert.equal(harness.executed[0][4], 0.22);
  assert.equal(harness.executed[1][4], 0.11);
  assert.equal(harness.executed[2][4], 0.88);
});

test('analyzeCoin reuses an explicitly supplied snapshot but direct callers still fetch accounts', async () => {
  const trader = Object.create(MultiCoinTrader.prototype);
  const directSnapshot = [{ currency: 'KRW', balance: '1000', locked: '0' }];
  const suppliedSnapshot = [{ currency: 'KRW', balance: '2000', locked: '0' }];
  const snapshotsUsed = [];
  let accountReads = 0;

  Object.assign(trader, {
    async getAccountInfo() {
      accountReads += 1;
      return directSnapshot;
    },
    getCoinBalance(accounts) {
      snapshotsUsed.push(accounts);
      return 0;
    },
    marketDataAdapter: { async getTickers() { return []; } },
    cycleRequestStats: null,
    candleUnit: 1,
    candleCount: 50,
    config: { rsiPeriod: 14 },
    recordInsufficientCandleData() {}
  });

  await assert.rejects(
    trader.analyzeCoin(
      'KRW-BTC',
      { overall: 'neutral', score: 0 },
      {
        ticker: { market: 'KRW-BTC', trade_price: 100, trade_timestamp: Date.now() },
        sharedSnapshot: true
      },
      suppliedSnapshot
    ),
    /캔들 데이터 부족/
  );
  assert.equal(accountReads, 0);
  assert.equal(snapshotsUsed[0], suppliedSnapshot);

  await assert.rejects(
    trader.analyzeCoin('KRW-BTC', { overall: 'neutral', score: 0 }),
    /현재가 조회 실패/
  );
  assert.equal(accountReads, 1);
  assert.equal(snapshotsUsed[1], directSnapshot);
});
