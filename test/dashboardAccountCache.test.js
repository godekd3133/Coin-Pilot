import assert from 'node:assert/strict';
import fs from 'node:fs';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import test from 'node:test';
import DashboardServer from '../src/api/dashboardServer.js';
import createAccountRoutes from '../src/api/routes/account.js';
import createPortfolioRoutes from '../src/api/routes/portfolio.js';
import createTradingRoutes from '../src/api/routes/trading.js';
import { ManualOrderIdempotencyStore } from '../src/api/manualOrderIdempotencyStore.js';

function makeDashboard(getAccountInfo) {
  const dashboard = Object.create(DashboardServer.prototype);
  dashboard.cache = new Map();
  dashboard.inFlightAccountRequests = new Map();
  dashboard.cacheTTL = { account: 1000 };
  dashboard.tradingSystem = { getAccountInfo };
  return dashboard;
}

async function startDashboard(tradingSystem, { routes = [], tickers = [] } = {}) {
  const app = express();
  const dashboard = Object.create(DashboardServer.prototype);
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-account-cache-idempotency-'));
  Object.assign(dashboard, {
    app,
    tradingSystem,
    cache: new Map(),
    inFlightAccountRequests: new Map(),
    inFlightTickerRequests: new Map(),
    cacheTTL: { account: 1000, ticker: 1000 },
    getCachedTicker: async () => tickers,
    getCachedTickerWithMetadata: async () => ({
      tickers,
      fetchedAt: new Date(1_790_000_001_234).toISOString()
    }),
    manualOrderIdempotencyStore: new ManualOrderIdempotencyStore({
      filePath: path.join(storageRoot, 'manual_order_idempotency.json')
    }),
    auth: { writeProfileId: 'operator' },
    getHoldingsAsMap: () => tradingSystem.virtualPortfolio?.holdings || new Map(),
    logApiError() {}
  });
  dashboard.observerAccountCacheReads = 0;
  const readAccount = dashboard.getObserverCachedAccountInfo.bind(dashboard);
  dashboard.getObserverCachedAccountInfo = async () => {
    dashboard.observerAccountCacheReads += 1;
    return readAccount();
  };

  if (routes.includes('account')) app.use('/api', createAccountRoutes(dashboard));
  if (routes.includes('portfolio')) app.use('/api', createPortfolioRoutes(dashboard));
  if (routes.includes('trading')) app.use('/api', createTradingRoutes(dashboard));

  const httpServer = app.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  return {
    dashboard,
    httpServer,
    storageRoot,
    baseUrl: `http://127.0.0.1:${httpServer.address().port}`
  };
}

async function stopDashboard({ httpServer, storageRoot }) {
  const closed = once(httpServer, 'close');
  httpServer.close();
  await closed;
  fs.rmSync(storageRoot, { recursive: true, force: true });
}

test('동시 account observer miss는 private account read 하나를 공유하고 caller row는 분리한다', async () => {
  let resolveRead;
  let accountReads = 0;
  const sourceRows = [{ currency: 'KRW', balance: '1000', locked: '0' }];
  const request = new Promise(resolve => { resolveRead = resolve; });
  const dashboard = makeDashboard(() => {
    accountReads += 1;
    return request;
  });

  const first = dashboard.getObserverCachedAccountInfo();
  const second = dashboard.getObserverCachedAccountInfo();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(accountReads, 1);

  resolveRead(sourceRows);
  const [firstRows, secondRows] = await Promise.all([first, second]);
  assert.deepEqual(firstRows, sourceRows);
  assert.deepEqual(secondRows, sourceRows);
  assert.notStrictEqual(firstRows, secondRows);
  assert.notStrictEqual(firstRows[0], secondRows[0]);

  firstRows[0].balance = 'changed-by-caller';
  sourceRows[0].balance = 'changed-at-source';
  const cachedRows = await dashboard.getObserverCachedAccountInfo();
  assert.equal(cachedRows[0].balance, '1000');
  assert.equal(accountReads, 1);
});

test('observer account cache는 account TTL 1초가 지나면 다시 읽는다', async () => {
  let accountReads = 0;
  const dashboard = makeDashboard(async () => {
    accountReads += 1;
    return [{ currency: 'KRW', balance: String(accountReads), locked: '0' }];
  });

  assert.equal((await dashboard.getObserverCachedAccountInfo())[0].balance, '1');
  dashboard.cache.get('account').time = Date.now() - 1001;
  assert.equal((await dashboard.getObserverCachedAccountInfo())[0].balance, '2');
  assert.equal(accountReads, 2);
});

test('observer account read 실패는 same-flight를 정리하고 다음 요청이 재시도한다', async () => {
  const failure = new Error('private account read unavailable');
  let rejectRead;
  let accountReads = 0;
  const firstRequest = new Promise((resolve, reject) => { rejectRead = reject; });
  const dashboard = makeDashboard(() => {
    accountReads += 1;
    return accountReads === 1
      ? firstRequest
      : Promise.resolve([{ currency: 'KRW', balance: '1000', locked: '0' }]);
  });

  const first = dashboard.getObserverCachedAccountInfo();
  const second = dashboard.getObserverCachedAccountInfo();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(accountReads, 1);
  rejectRead(failure);

  const results = await Promise.allSettled([first, second]);
  assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected']);
  assert.strictEqual(results[0].reason, failure);
  assert.strictEqual(results[1].reason, failure);
  assert.equal(dashboard.inFlightAccountRequests.size, 0);
  assert.equal((await dashboard.getObserverCachedAccountInfo())[0].balance, '1000');
  assert.equal(accountReads, 2);
});

test('parallel GET /account, /positions, and /cumulative-pnl share one private account read', async () => {
  const sourceAsOf = new Date(1_790_000_000_000).toISOString();
  const fetchedAt = new Date(1_790_000_001_234).toISOString();
  const accounts = [
    { currency: 'KRW', balance: '1000', locked: '0' },
    { currency: 'BTC', balance: '2', locked: '0', avg_buy_price: '100' }
  ];
  let releaseAccounts;
  let signalFirstRead;
  let accountReads = 0;
  const accountReadStarted = new Promise(resolve => { signalFirstRead = resolve; });
  const accountRead = new Promise(resolve => { releaseAccounts = resolve; });
  const trader = {
    dryRun: false,
    initialSeedMoney: 1000,
    getAccountInfo() {
      accountReads += 1;
      signalFirstRead();
      return accountRead;
    },
    getKRWBalance(rows) {
      return Number(rows.find(row => row.currency === 'KRW')?.balance || 0);
    },
    async calculateTotalAssets(priceMap, { accountsOverride }) {
      assert.deepEqual(accountsOverride, accounts);
      return 1000 + (Number(accountsOverride[1].balance) * priceMap.get('KRW-BTC'));
    },
    async calculateCumulativePnL({ priceMapOverride, accountsOverride }) {
      assert.deepEqual(accountsOverride, accounts);
      const totalAssets = 1000 + (Number(accountsOverride[1].balance) * priceMapOverride.get('KRW-BTC'));
      return {
        initialSeedMoney: 1000,
        totalAssets,
        profit: totalAssets - 1000,
        profitPercent: ((totalAssets / 1000) - 1) * 100,
        valuationAvailable: true,
        valuationStatus: 'available',
        mode: 'LIVE'
      };
    }
  };
  const tickers = [{
    market: 'KRW-BTC',
    trade_price: 120,
    trade_timestamp: 1_790_000_000_000
  }];
  const ctx = await startDashboard(trader, { routes: ['account', 'portfolio'], tickers });

  try {
    const responsesPromise = Promise.all([
      fetch(`${ctx.baseUrl}/api/account`),
      fetch(`${ctx.baseUrl}/api/positions`),
      fetch(`${ctx.baseUrl}/api/cumulative-pnl`)
    ]);
    await accountReadStarted;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(accountReads, 1);
    releaseAccounts(accounts);

    const [accountResponse, positionsResponse, pnlResponse] = await responsesPromise;
    assert.deepEqual([accountResponse.status, positionsResponse.status, pnlResponse.status], [200, 200, 200]);
    const [account, positions, pnl] = await Promise.all([
      accountResponse.json(),
      positionsResponse.json(),
      pnlResponse.json()
    ]);
    assert.equal(account.totalAssets, 1240);
    assert.equal(account.sourceAsOf, sourceAsOf);
    assert.equal(account.fetchedAt, fetchedAt);
    assert.equal(positions.count, 1);
    assert.equal(pnl.totalAssets, 1240);
    assert.equal(pnl.sourceAsOf, sourceAsOf);
    assert.equal(pnl.fetchedAt, fetchedAt);
    assert.equal(accountReads, 1);
    assert.equal(ctx.dashboard.observerAccountCacheReads, 3);
  } finally {
    await stopDashboard(ctx);
  }
});

test('portfolio snapshot POST bypasses the observer account cache', async t => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-account-cache-snapshot-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const accounts = [
    { currency: 'KRW', balance: '1000', locked: '0' },
    { currency: 'BTC', balance: '2', locked: '0', avg_buy_price: '100' }
  ];
  let accountReads = 0;
  const trader = {
    dryRun: false,
    upbit: {},
    portfolioHistoryFile: path.join(storageRoot, 'portfolio-history.json'),
    initialSeedMoney: 1000,
    getAccountInfo: async () => {
      accountReads += 1;
      return accounts;
    },
    getKRWBalance: rows => Number(rows.find(row => row.currency === 'KRW')?.balance || 0),
    async calculateTotalAssets(priceMap) {
      return 1000 + (2 * priceMap.get('KRW-BTC'));
    }
  };
  const ctx = await startDashboard(trader, {
    routes: ['portfolio'],
    tickers: [{ market: 'KRW-BTC', trade_price: 120, trade_timestamp: Date.now() }]
  });

  try {
    await ctx.dashboard.getObserverCachedAccountInfo();
    assert.equal(accountReads, 1);
    const response = await fetch(`${ctx.baseUrl}/api/portfolio/snapshot`, { method: 'POST' });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.recorded, true);
    assert.equal(accountReads, 2);
    assert.equal(ctx.dashboard.observerAccountCacheReads, 1);
  } finally {
    await stopDashboard(ctx);
  }
});

test('LIVE order preflight account read bypasses the observer account cache', async () => {
  const accounts = [{ currency: 'KRW', balance: '10000', locked: '0' }];
  let accountReads = 0;
  let preflightReads = 0;
  let orderSubmissions = 0;
  const trader = {
    dryRun: false,
    upbit: {
      async getTicker(markets) {
        const requested = Array.isArray(markets) ? markets : [markets];
        return requested.map(market => ({ market, trade_price: 100, trade_timestamp: Date.now() }));
      }
    },
    async getAccountInfo() {
      accountReads += 1;
      return accounts;
    },
    async ensureLiveOrderMarketStateVerified() {
      preflightReads += 1;
      await this.getAccountInfo();
      return true;
    },
    getRuntimeSafetyStatus: () => ({ runtimeState: 'RUNNING', exchangeStateKnown: true }),
    canExecuteLiveOrder: () => false,
    createLiveExecutionEvidence: event => event,
    recordLiveExecutionEvidence: () => true,
    async submitLiveOrder() {
      orderSubmissions += 1;
      return { success: true, data: { uuid: 'mock-order' } };
    }
  };
  const ctx = await startDashboard(trader, { routes: ['trading'] });

  try {
    await ctx.dashboard.getObserverCachedAccountInfo();
    assert.equal(accountReads, 1);
    const response = await fetch(`${ctx.baseUrl}/api/trade/buy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'live-preflight-cache-key' },
      body: JSON.stringify({ coin: 'KRW-BTC', amount: 10_000 })
    });
    const result = await response.json();
    assert.equal(response.status, 503, JSON.stringify(result));
    assert.equal(result.success, false);
    assert.equal(preflightReads, 1);
    assert.equal(accountReads, 2);
    assert.equal(orderSubmissions, 0);
    assert.equal(ctx.dashboard.observerAccountCacheReads, 1);
  } finally {
    await stopDashboard(ctx);
  }
});
