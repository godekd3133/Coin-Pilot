import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import test from 'node:test';
import MultiCoinTrader from '../src/trader/multiCoinTrader.js';
import DashboardServer from '../src/api/dashboardServer.js';
import createTradingRoutes from '../src/api/routes/trading.js';
import createPortfolioRoutes from '../src/api/routes/portfolio.js';
import {
  ManualOrderIdempotencyStore,
  createDefaultManualOrderIdempotencyStore,
  canonicalManualRequestEndpoint
} from '../src/api/manualOrderIdempotencyStore.js';

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-manual-idempotency-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

class TemporaryDashboardServer extends DashboardServer {
  getOptimizationStateFile() {
    return path.join(this.logger.logDir, 'optimization_state.json');
  }
}

function makeTemporaryDashboard(trader, root, port = 0) {
  return new TemporaryDashboardServer(trader, port, {
    env: {
      ...process.env,
      DASHBOARD_TOKEN: '',
      DASHBOARD_READ_ONLY_TOKEN: '',
      DASHBOARD_HOST: '127.0.0.1',
      DASHBOARD_ALLOW_INSECURE: '',
      DASHBOARD_TLS_CERT_FILE: '',
      DASHBOARD_TLS_KEY_FILE: '',
      STAGING_OUTPUT_DIR: path.join(root, 'logs')
    }
  });
}

function makeFakeUpbit({ price = 100, getMinuteCandles = async () => [] } = {}) {
  const calls = { ticker: 0, candles: 0, order: 0 };
  return {
    calls,
    async getTicker(markets) {
      calls.ticker += 1;
      const requested = Array.isArray(markets) ? markets : [markets];
      return requested.map(market => ({
        market,
        trade_price: price,
        signed_change_rate: 0,
        signed_change_price: 0,
        high_price: price,
        low_price: price,
        acc_trade_volume_24h: 10,
        acc_trade_price_24h: price * 10
      }));
    },
    async getMinuteCandles(...args) {
      calls.candles += 1;
      return getMinuteCandles(...args);
    },
    async getMarkets() { return []; },
    async order() { calls.order += 1; return { success: false }; },
    async waitForOrderFill() { return { filled: false, error: 'fake' }; },
    async cancelOrder() { return { success: true }; }
  };
}

function makeDryTrader(root, { balance = 20000, price = 100, getMinuteCandles } = {}) {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: balance,
    virtualPortfolioFile: path.join(root, 'dry_portfolio.json'),
    paperValidationFile: path.join(root, 'paper_validation.json'),
    portfolioHistoryFile: path.join(root, 'portfolio_history.json'),
    liveExecutionEvidenceFile: path.join(root, 'live_evidence.jsonl'),
    positionRiskCheckIntervalMs: 0,
    useNews: false
  });
  trader.virtualPortfolio.krwBalance = balance;
  trader.initialSeedMoney = balance;
  trader.upbit = makeFakeUpbit({ price, getMinuteCandles });
  return trader;
}

function makeLiveTrader(root, { onSubmit = async () => { throw new Error('fake ambiguous submit'); } } = {}) {
  const upbit = makeFakeUpbit();
  const unresolvedMarkets = new Set();
  let submitCount = 0;
  const trader = {
    dryRun: false,
    virtualPortfolioFile: path.join(root, 'dry_portfolio.json'),
    upbit,
    liveExecutionEvidenceWriteError: null,
    liveExecutionEvidenceDataError: null,
    _orderInProgress: false,
    _liveAccountStateKnown: true,
    _liveExchangeStateKnown: true,
    _liveOrderStateUnknownMarkets: new Set(),
    _livePendingOrderMarkets: new Set(),
    _liveRecoveredManagedMarkets: new Set(),
    getRuntimeSafetyStatus: () => ({ runtimeState: 'RUNNING', exchangeStateKnown: true }),
    canExecuteLiveOrder: () => true,
    ensureLiveOrderMarketStateVerified: async () => true,
    createLiveExecutionEvidence: event => ({ recordedAt: new Date().toISOString(), ...event }),
    recordLiveExecutionEvidence: () => true,
    markLiveMarketOrderUnresolved(market) { unresolvedMarkets.add(market); },
    async submitLiveOrder(...args) {
      submitCount += 1;
      return onSubmit(...args);
    }
  };
  const counts = {
    get submits() { return submitCount; },
    get tickers() { return upbit.calls.ticker; },
    unresolvedMarkets
  };
  return { trader, counts };
}

function makeServer(tradingSystem, root, { storePath = path.join(root, 'manual_order_idempotency.json') } = {}) {
  return {
    tradingSystem,
    auth: { writeProfileId: 'operator' },
    manualOrderIdempotencyStore: createDefaultManualOrderIdempotencyStore(tradingSystem, storePath),
    getHoldingsAsMap() { return tradingSystem.virtualPortfolio?.holdings || new Map(); },
    logApiError() {}
  };
}

async function startRoutes(t, server, { includePortfolio = false } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api', createTradingRoutes(server));
  if (includePortfolio) app.use('/api', createPortfolioRoutes(server));
  const httpServer = app.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  let closePromise = null;
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = new Promise((resolve, reject) => {
      const release = () => {
        try {
          server.manualOrderIdempotencyStore?.releaseWriterLock?.();
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      if (!httpServer.listening) {
        release();
      } else {
        httpServer.close(error => {
          if (error) return reject(error);
          release();
        });
      }
    });
    return closePromise;
  };
  t.after(close);
  const { port } = httpServer.address();
  return { baseUrl: `http://127.0.0.1:${port}`, httpServer, close };
}

async function postJson(ctx, endpoint, body, key = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (key !== null) headers['Idempotency-Key'] = key;
  const response = await fetch(`${ctx.baseUrl}${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  const responseBody = await response.json();
  return { status: response.status, body: responseBody };
}

test('manual trade and wallet endpoints reject a missing key before reading prices or mutating state', async t => {
  const root = makeRoot(t);
  const trader = makeDryTrader(root);
  const initialBalance = trader.virtualPortfolio.krwBalance;
  const ctx = await startRoutes(t, makeServer(trader, root), { includePortfolio: true });
  const requests = [
    ['/api/trade/execute-bundle', { sellCoin: 'KRW-BTC', buyCoin: 'KRW-ETH' }],
    ['/api/trade/execute', { coin: 'KRW-BTC', action: 'BUY', amount: 5000 }],
    ['/api/trade/smart-buy', { totalAmount: 10000, minScore: 60, maxCoins: 1 }],
    ['/api/trade/smart-sell', { targetAmount: 1000, strategy: 'worst' }],
    ['/api/trade/quick', { coin: 'KRW-BTC', action: 'BUY', amount: 5000 }],
    ['/api/trade/buy', { coin: 'KRW-BTC', amount: 5000 }],
    ['/api/trade/sell', { coin: 'KRW-BTC', quantity: 1 }],
    ['/api/virtual/deposit', { amount: 1000 }],
    ['/api/virtual/withdraw', { amount: 1000 }],
    ['/api/virtual/reset', { seedMoney: 10000 }]
  ];

  for (const [endpoint, body] of requests) {
    const result = await postJson(ctx, endpoint, body);
    assert.equal(result.status, 428, `${endpoint} must require Idempotency-Key`);
    assert.equal(result.body.pending, false);
    assert.equal(result.body.error.code, 'idempotency_key_required');
  }
  assert.equal(trader.upbit.calls.ticker, 0);
  assert.equal(trader.virtualPortfolio.krwBalance, initialBalance);
  assert.equal(trader.virtualPortfolio.holdings.size, 0);
});

test('DRY_RUN legacy buy mutates once, replays canonical same-body response, and rejects key reuse', async t => {
  const root = makeRoot(t);
  const trader = makeDryTrader(root);
  const server = makeServer(trader, root);
  const ctx = await startRoutes(t, server);
  const key = 'dry-buy-key-01';
  const first = await postJson(ctx, '/api/trade/buy', { coin: 'KRW-BTC', amount: 5000 }, key);
  assert.equal(first.status, 200);
  assert.equal(first.body.success, true);
  assert.equal(first.body.mode, 'DRY_RUN');
  assert.equal(trader.virtualPortfolio.krwBalance, 15000);
  const expectedVolume = (5000 - 2.5) / 100;
  assert.ok(Math.abs(trader.virtualPortfolio.holdings.get('KRW-BTC').amount - expectedVolume) < 1e-10);
  assert.equal(trader.upbit.calls.ticker, 1);

  // JSON key order is not part of the body identity.
  const replay = await postJson(ctx, '/api/trade/buy', { amount: 5000, coin: 'KRW-BTC' }, key);
  assert.equal(replay.status, first.status);
  assert.deepEqual(replay.body, first.body);
  assert.equal(trader.virtualPortfolio.krwBalance, 15000);
  assert.equal(trader.upbit.calls.ticker, 1);

  const bodyConflict = await postJson(ctx, '/api/trade/buy', { coin: 'KRW-BTC', amount: 6000 }, key);
  assert.equal(bodyConflict.status, 409);
  assert.equal(bodyConflict.body.pending, false);
  assert.equal(bodyConflict.body.idempotency.status, 'conflict');
  const endpointConflict = await postJson(ctx, '/api/trade/execute', {
    coin: 'KRW-BTC', action: 'BUY', amount: 5000
  }, key);
  assert.equal(endpointConflict.status, 409);
  assert.equal(trader.virtualPortfolio.krwBalance, 15000);
  assert.equal(trader.upbit.calls.ticker, 1);

  const portfolio = JSON.parse(fs.readFileSync(trader.virtualPortfolioFile, 'utf8'));
  const receipt = portfolio.manualOrderIdempotencyRecords[0];
  assert.equal(receipt.mode, 'DRY_RUN');
  assert.equal(receipt.state, 'completed');
  assert.equal(receipt.responseStatus, first.status);
  assert.deepEqual(receipt.responseBody, first.body);
  const journal = fs.readFileSync(server.manualOrderIdempotencyStore.filePath, 'utf8');
  assert.equal(journal.includes(key), false, 'raw idempotency keys are not persisted');
  assert.equal(journal.includes('fake-bearer-token'), false, 'bearer credentials are not persisted');
});

test('legacy bundle and execute request bodies are idempotent without changing their route payloads', async t => {
  const root = makeRoot(t);
  const trader = makeDryTrader(root);
  trader.virtualPortfolio.holdings.set('KRW-BTC', { amount: 100, avgPrice: 90, entryTime: null });
  const ctx = await startRoutes(t, makeServer(trader, root));

  // public/index.html sends only sellCoin/buyCoin for the bundle route.
  const bundleBody = { sellCoin: 'KRW-BTC', buyCoin: 'KRW-ETH' };
  const bundle = await postJson(ctx, '/api/trade/execute-bundle', bundleBody, 'legacy-bundle-key');
  assert.equal(bundle.status, 200);
  assert.equal(bundle.body.success, true);
  assert.equal(bundle.body.mode, 'DRY_RUN');
  assert.ok(bundle.body.results.sell.value > 5000);
  assert.ok(bundle.body.results.buy.amount > 0);
  const bundleReads = trader.upbit.calls.ticker;
  const bundleReplay = await postJson(ctx, '/api/trade/execute-bundle', bundleBody, 'legacy-bundle-key');
  assert.equal(bundleReplay.status, bundle.status);
  assert.deepEqual(bundleReplay.body, bundle.body);
  assert.equal(trader.upbit.calls.ticker, bundleReads);

  // The legacy confirmation dialog posts this exact shape to /trade/execute.
  const executeBody = { coin: 'KRW-BTC', action: 'BUY', amount: 5000 };
  const execute = await postJson(ctx, '/api/trade/execute', executeBody, 'legacy-execute-key');
  assert.equal(execute.status, 200);
  assert.equal(execute.body.success, true);
  const executeReads = trader.upbit.calls.ticker;
  const executeReplay = await postJson(ctx, '/api/trade/execute', executeBody, 'legacy-execute-key');
  assert.equal(executeReplay.status, execute.status);
  assert.deepEqual(executeReplay.body, execute.body);
  assert.equal(trader.upbit.calls.ticker, executeReads);
});

test('same-key concurrent request gets 202 while the original DRY_RUN command executes once', async t => {
  const root = makeRoot(t);
  let releaseTicker;
  let signalTickerRead;
  const tickerRead = new Promise(resolve => { signalTickerRead = resolve; });
  const tickerGate = new Promise(resolve => { releaseTicker = resolve; });
  const trader = makeDryTrader(root);
  const upbit = trader.upbit;
  trader.upbit = {
    ...upbit,
    async getTicker(markets) {
      upbit.calls.ticker += 1;
      signalTickerRead();
      await tickerGate;
      const requested = Array.isArray(markets) ? markets : [markets];
      return requested.map(market => ({ market, trade_price: 100 }));
    }
  };
  const ctx = await startRoutes(t, makeServer(trader, root));
  const body = { coin: 'KRW-BTC', amount: 5000 };
  const firstPromise = postJson(ctx, '/api/trade/buy', body, 'same-key-concurrent');
  await tickerRead;

  const concurrent = await postJson(ctx, '/api/trade/buy', body, 'same-key-concurrent');
  assert.equal(concurrent.status, 202);
  assert.equal(concurrent.body.pending, true);
  assert.equal(concurrent.body.idempotency.status, 'pending');
  releaseTicker();

  const first = await firstPromise;
  assert.equal(first.status, 200);
  assert.equal(trader.virtualPortfolio.krwBalance, 15000);
  assert.equal(trader.upbit.calls.ticker, 1);
});

test('two server instances sharing one profile allow only one protected request writer', async t => {
  const root = makeRoot(t);
  let releaseTicker;
  let signalTickerRead;
  const tickerRead = new Promise(resolve => { signalTickerRead = resolve; });
  const tickerGate = new Promise(resolve => { releaseTicker = resolve; });
  const firstTrader = makeDryTrader(root);
  const originalUpbit = firstTrader.upbit;
  firstTrader.upbit = {
    ...originalUpbit,
    async getTicker(markets) {
      originalUpbit.calls.ticker += 1;
      signalTickerRead();
      await tickerGate;
      const requested = Array.isArray(markets) ? markets : [markets];
      return requested.map(market => ({ market, trade_price: 100 }));
    }
  };
  const secondTrader = makeDryTrader(root);
  const firstServer = makeServer(firstTrader, root);
  // Use a different journal path to prove the writer lock follows the shared
  // profile/portfolio file rather than an independently chosen journal name.
  const secondServer = makeServer(secondTrader, root, {
    storePath: path.join(root, 'alternate-idempotency-journal.json')
  });
  assert.equal(
    firstServer.manualOrderIdempotencyStore.writerLockPath,
    secondServer.manualOrderIdempotencyStore.writerLockPath
  );
  const firstContext = await startRoutes(t, firstServer);
  const secondContext = await startRoutes(t, secondServer);
  const body = { coin: 'KRW-BTC', amount: 5000 };
  const firstRequest = postJson(firstContext, '/api/trade/buy', body, 'cross-server-profile-key');
  await tickerRead;

  const childScript = `
    const { ManualOrderIdempotencyStore } = await import(process.env.COINPILOT_TEST_MODULE);
    const store = new ManualOrderIdempotencyStore({
      filePath: process.env.COINPILOT_TEST_JOURNAL,
      writerLockPath: process.env.COINPILOT_TEST_WRITER_LOCK
    });
    try {
      await store.reserve({
        profileId: 'operator',
        idempotencyKey: 'cross-server-profile-key',
        method: 'POST',
        endpoint: '/api/trade/buy',
        body: { coin: 'KRW-BTC', amount: 5000 },
        mode: 'DRY_RUN'
      });
      process.stdout.write(JSON.stringify({ accepted: true }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ code: error.code, recoveryRequired: error.recoveryRequired }));
    }
  `;
  const childResult = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      COINPILOT_TEST_MODULE: new URL('../src/api/manualOrderIdempotencyStore.js', import.meta.url).href,
      COINPILOT_TEST_JOURNAL: path.join(root, 'child-journal.json'),
      COINPILOT_TEST_WRITER_LOCK: firstServer.manualOrderIdempotencyStore.writerLockPath
    }
  });
  assert.equal(childResult.error, undefined, childResult.error?.message);
  assert.equal(childResult.status, 0, childResult.stderr);
  const childReservation = JSON.parse(childResult.stdout);
  assert.equal(childReservation.accepted, undefined);
  assert.equal(childReservation.code, 'MANUAL_ORDER_WRITER_LOCK_ACTIVE');

  const rejectedSecondRequest = await postJson(
    secondContext,
    '/api/trade/buy',
    body,
    'cross-server-profile-key'
  );
  assert.equal(rejectedSecondRequest.status, 503);
  assert.equal(rejectedSecondRequest.body.pending, false);
  assert.equal(rejectedSecondRequest.body.error.code, 'manual_order_writer_locked');
  assert.equal(rejectedSecondRequest.body.error.recoveryRequired, false);
  assert.equal(secondTrader.upbit.calls.ticker, 0, 'the second server never reaches route execution');
  assert.equal(secondTrader.virtualPortfolio.krwBalance, 20000);

  releaseTicker();
  const firstResult = await firstRequest;
  assert.equal(firstResult.status, 200);
  assert.equal(firstTrader.upbit.calls.ticker, 1);
  assert.equal(firstTrader.virtualPortfolio.krwBalance, 15000);
});

test('read-only observer mutation requests do not claim the profile writer lock', async t => {
  const root = makeRoot(t);
  const trader = makeDryTrader(root);
  trader.readOnlyObserver = true;
  const server = makeServer(trader, root);
  const ctx = await startRoutes(t, server);
  const result = await postJson(ctx, '/api/trade/buy', { coin: 'KRW-BTC', amount: 5000 }, 'observer-key');
  assert.equal(result.status, 403);
  assert.equal(result.body.error.code, 'read_only_observer');
  assert.equal(fs.existsSync(server.manualOrderIdempotencyStore.writerLockPath), false);
  assert.equal(trader.upbit.calls.ticker, 0);
});

test('a dead same-host lock owner is reclaimed only after serialized token recheck', async t => {
  const root = makeRoot(t);
  const filePath = path.join(root, 'journal.json');
  const writerLockPath = path.join(root, 'profile.writer.lock');
  const staleOwner = {
    schema: 'coinpilot.manual-order-writer-lock.v1',
    pid: 987654321,
    hostname: os.hostname(),
    lockId: 'stale-owner-token',
    startedAt: new Date(0).toISOString()
  };
  fs.writeFileSync(writerLockPath, JSON.stringify(staleOwner), { mode: 0o600 });
  let statusReads = 0;
  const store = new ManualOrderIdempotencyStore({
    filePath,
    writerLockPath,
    probePid: pid => {
      assert.equal(pid, staleOwner.pid);
      statusReads += 1;
      return 'dead';
    }
  });
  const reservation = await store.reserve({
    profileId: 'operator',
    idempotencyKey: 'recover-dead-owner',
    method: 'POST',
    endpoint: '/api/trade/buy',
    body: { coin: 'KRW-BTC', amount: 5000 },
    mode: 'LIVE'
  });
  assert.equal(reservation.kind, 'reserved');
  assert.ok(statusReads >= 2, 'the stale owner is rechecked immediately before removal');
  const replacement = JSON.parse(fs.readFileSync(writerLockPath, 'utf8'));
  assert.notEqual(replacement.lockId, staleOwner.lockId);
  assert.equal(replacement.pid, process.pid);
  assert.equal(fs.existsSync(`${writerLockPath}.recovery`), false);
  store.releaseWriterLock();
});

test('ambiguous writer lock contents fail closed and explain manual recovery', async t => {
  const root = makeRoot(t);
  const filePath = path.join(root, 'journal.json');
  const writerLockPath = path.join(root, 'profile.writer.lock');
  fs.writeFileSync(writerLockPath, '{partial');
  const store = new ManualOrderIdempotencyStore({ filePath, writerLockPath });
  await assert.rejects(
    store.reserve({
      profileId: 'operator',
      idempotencyKey: 'ambiguous-owner-key',
      method: 'POST',
      endpoint: '/api/trade/buy',
      body: {},
      mode: 'LIVE'
    }),
    error => error.code === 'MANUAL_ORDER_WRITER_LOCK_UNVERIFIABLE' && error.recoveryRequired === true
  );
  assert.equal(fs.readFileSync(writerLockPath, 'utf8'), '{partial');
  assert.equal(fs.existsSync(filePath), false, 'the journal is not initialized without writer ownership');
});

test('DashboardServer orderly stop releases its profile writer lock', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-manual-idempotency-dashboard-'));
  const trader = makeDryTrader(root);
  let dashboard = null;
  let stopped = false;
  t.after(async () => {
    if (!stopped && dashboard && (dashboard.io || dashboard.server)) await dashboard.stop();
    if (dashboard) await dashboard.logger.flush();
    fs.rmSync(root, { recursive: true, force: true });
  });
  dashboard = makeTemporaryDashboard(trader, root);
  await dashboard.start();
  const store = dashboard.manualOrderIdempotencyStore;

  await store.reserve({
    profileId: 'operator',
    idempotencyKey: 'stop-releases-writer-lock',
    method: 'POST',
    endpoint: '/api/trade/buy',
    body: { coin: 'KRW-BTC', amount: 5000 },
    mode: 'DRY_RUN'
  });
  assert.equal(fs.existsSync(store.writerLockPath), true);
  await dashboard.stop();
  stopped = true;
  await dashboard.logger.flush();
  assert.equal(fs.existsSync(store.writerLockPath), false);

  const nextStore = createDefaultManualOrderIdempotencyStore(
    trader,
    path.join(root, 'alternate-journal.json')
  );
  const nextReservation = await nextStore.reserve({
    profileId: 'operator',
    idempotencyKey: 'next-writer-after-orderly-stop',
    method: 'POST',
    endpoint: '/api/trade/buy',
    body: { coin: 'KRW-BTC', amount: 5000 },
    mode: 'DRY_RUN'
  });
  assert.equal(nextReservation.kind, 'reserved');
  nextStore.releaseWriterLock();
});

test('mutable DashboardServer claims the profile before listening while observers skip the lock', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-dashboard-profile-lock-'));
  const dashboards = [];
  let occupiedServer = null;
  t.after(async () => {
    for (const dashboard of dashboards) {
      if (dashboard.io || dashboard.server) await dashboard.stop();
    }
    for (const dashboard of dashboards) await dashboard.logger.flush();
    if (occupiedServer?.listening) {
      await new Promise(resolve => occupiedServer.close(resolve));
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const first = makeTemporaryDashboard(makeDryTrader(root), root);
  const second = makeTemporaryDashboard(makeDryTrader(root), root);
  dashboards.push(first, second);
  await first.start();
  assert.equal(first.server.listening, true);
  assert.equal(fs.existsSync(first.manualOrderIdempotencyStore.writerLockPath), true);

  await assert.rejects(
    second.start(),
    error => error.code === 'MANUAL_ORDER_WRITER_LOCK_ACTIVE'
  );
  assert.equal(second.httpServer.listening, false);
  assert.equal(second.server, null, 'startup cleanup closes the server that never acquired the lock');

  await first.stop();
  assert.equal(fs.existsSync(first.manualOrderIdempotencyStore.writerLockPath), false);

  const observerTrader = makeDryTrader(root);
  observerTrader.readOnlyObserver = true;
  const observer = makeTemporaryDashboard(observerTrader, root);
  dashboards.push(observer);
  await observer.start();
  assert.equal(observer.server.listening, true);
  assert.equal(observer.manualOrderIdempotencyStore.writerLock, null);
  assert.equal(fs.existsSync(observer.manualOrderIdempotencyStore.writerLockPath), false);

  const mutableAfterObserver = makeTemporaryDashboard(makeDryTrader(root), root);
  dashboards.push(mutableAfterObserver);
  await mutableAfterObserver.start();
  assert.equal(mutableAfterObserver.server.listening, true);
  assert.equal(fs.existsSync(mutableAfterObserver.manualOrderIdempotencyStore.writerLockPath), true);

  await mutableAfterObserver.stop();
  occupiedServer = net.createServer();
  occupiedServer.listen(0, '127.0.0.1');
  await once(occupiedServer, 'listening');
  const bindFailure = makeTemporaryDashboard(
    makeDryTrader(root),
    root,
    occupiedServer.address().port
  );
  dashboards.push(bindFailure);
  await assert.rejects(bindFailure.start(), error => error.code === 'EADDRINUSE');
  assert.equal(bindFailure.httpServer.listening, false);
  assert.equal(
    fs.existsSync(bindFailure.manualOrderIdempotencyStore.writerLockPath),
    false,
    'startup cleanup releases the profile lock after listen fails'
  );
  await new Promise(resolve => occupiedServer.close(resolve));
});

test('virtual wallet deposit is one-time and the exact response is durable with dry_portfolio.json', async t => {
  const root = makeRoot(t);
  const trader = makeDryTrader(root, { balance: 10000 });
  const ctx = await startRoutes(t, makeServer(trader, root), { includePortfolio: true });
  const first = await postJson(ctx, '/api/virtual/deposit', { amount: 1000 }, 'wallet-deposit-once');
  assert.equal(first.status, 200);
  assert.equal(first.body.success, true);
  assert.equal(first.body.newBalance, 11000);
  assert.equal(trader.virtualPortfolio.krwBalance, 11000);

  const replay = await postJson(ctx, '/api/virtual/deposit', { amount: 1000 }, 'wallet-deposit-once');
  assert.equal(replay.status, first.status);
  assert.deepEqual(replay.body, first.body);
  assert.equal(trader.virtualPortfolio.krwBalance, 11000);

  const saved = JSON.parse(fs.readFileSync(trader.virtualPortfolioFile, 'utf8'));
  assert.equal(saved.krwBalance, 11000);
  assert.equal(saved.manualOrderIdempotencyRecords[0].state, 'completed');
  assert.deepEqual(saved.manualOrderIdempotencyRecords[0].responseBody, first.body);
});

test('pending and completed commands keep their original mode across restart and DRY_RUN/LIVE changes', async t => {
  const root = makeRoot(t);
  const dryTrader = makeDryTrader(root);
  const dryServer = makeServer(dryTrader, root);
  const dryCtx = await startRoutes(t, dryServer);
  const body = { coin: 'KRW-BTC', amount: 5000 };
  const key = 'mode-stable-completed';
  const dryResult = await postJson(dryCtx, '/api/trade/buy', body, key);
  assert.equal(dryResult.status, 200);
  assert.equal(dryResult.body.mode, 'DRY_RUN');
  await dryCtx.close();

  const live = makeLiveTrader(root);
  const liveServer = makeServer(live.trader, root, { storePath: dryServer.manualOrderIdempotencyStore.filePath });
  const liveCtx = await startRoutes(t, liveServer);
  const replay = await postJson(liveCtx, '/api/trade/buy', body, key);
  assert.equal(replay.status, dryResult.status);
  assert.deepEqual(replay.body, dryResult.body);
  assert.equal(live.counts.tickers, 0, 'a completed DRY_RUN command is replayed before LIVE route execution');
  assert.equal(live.counts.submits, 0);

  const pendingRoot = makeRoot(t);
  const pendingDryTrader = makeDryTrader(pendingRoot);
  const pendingServer = makeServer(pendingDryTrader, pendingRoot);
  const pendingKey = 'mode-stable-pending';
  const pendingBody = { coin: 'KRW-BTC', amount: 5000 };
  await pendingServer.manualOrderIdempotencyStore.reserve({
    profileId: 'operator',
    idempotencyKey: pendingKey,
    method: 'POST',
    endpoint: '/api/trade/buy',
    body: pendingBody,
    mode: 'DRY_RUN'
  });
  pendingServer.manualOrderIdempotencyStore.releaseWriterLock();

  const restartedLive = makeLiveTrader(pendingRoot);
  const restartedServer = makeServer(restartedLive.trader, pendingRoot, {
    storePath: pendingServer.manualOrderIdempotencyStore.filePath
  });
  const restartedCtx = await startRoutes(t, restartedServer);
  const unresolved = await postJson(restartedCtx, '/api/trade/buy', pendingBody, pendingKey);
  assert.equal(unresolved.status, 202);
  assert.equal(unresolved.body.pending, true);
  assert.equal(unresolved.body.idempotency.status, 'unknown');
  assert.equal(restartedLive.counts.tickers, 0);
  assert.equal(restartedLive.counts.submits, 0);
});

test('a DRY_RUN portfolio receipt repairs the journal after a crash between the two commits', async t => {
  const root = makeRoot(t);
  const trader = makeDryTrader(root);
  const server = makeServer(trader, root);
  const body = { coin: 'KRW-BTC', amount: 5000 };
  const reservation = await server.manualOrderIdempotencyStore.reserve({
    profileId: 'operator',
    idempotencyKey: 'receipt-before-journal-key',
    method: 'POST',
    endpoint: '/api/trade/buy',
    body,
    mode: 'DRY_RUN'
  });
  assert.equal(reservation.kind, 'reserved');

  // Simulate process loss after the atomic portfolio+receipt commit but before
  // the separate command journal can replace its PENDING file.
  server.manualOrderIdempotencyStore.persistJournal = async () => {
    throw new Error('simulated journal commit interruption');
  };
  const completedBody = { success: true, mode: 'DRY_RUN', coin: 'KRW-BTC', amount: 5000 };
  await server.manualOrderIdempotencyStore.complete(reservation.record.recordId, {
    status: 200,
    body: completedBody
  });
  server.manualOrderIdempotencyStore.releaseWriterLock();
  const staleJournal = JSON.parse(fs.readFileSync(server.manualOrderIdempotencyStore.filePath, 'utf8'));
  assert.equal(staleJournal.records[0].state, 'pending');
  const committedPortfolio = JSON.parse(fs.readFileSync(trader.virtualPortfolioFile, 'utf8'));
  assert.equal(committedPortfolio.manualOrderIdempotencyRecords[0].state, 'completed');
  assert.deepEqual(committedPortfolio.manualOrderIdempotencyRecords[0].responseBody, completedBody);

  const live = makeLiveTrader(root);
  live.trader.virtualPortfolioFile = trader.virtualPortfolioFile;
  const liveServer = makeServer(live.trader, root, { storePath: server.manualOrderIdempotencyStore.filePath });
  const liveCtx = await startRoutes(t, liveServer);
  const replay = await postJson(liveCtx, '/api/trade/buy', body, 'receipt-before-journal-key');
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, completedBody);
  assert.equal(live.counts.tickers, 0);
  assert.equal(live.counts.submits, 0);
});

test('ambiguous LIVE submission is submitted once and stays unknown after retry and restart', async t => {
  const root = makeRoot(t);
  const live = makeLiveTrader(root, { onSubmit: async () => { throw new Error('fake response timeout'); } });
  const server = makeServer(live.trader, root);
  const ctx = await startRoutes(t, server);
  const body = { coin: 'KRW-BTC', amount: 5000 };
  const first = await postJson(ctx, '/api/trade/buy', body, 'live-ambiguous-once');
  assert.equal(first.status, 202);
  assert.equal(first.body.pending, true);
  assert.equal(first.body.idempotency.status, 'unknown');
  assert.equal(live.counts.submits, 1);
  assert.equal(live.counts.unresolvedMarkets.has('KRW-BTC'), true);

  const retry = await postJson(ctx, '/api/trade/buy', body, 'live-ambiguous-once');
  assert.equal(retry.status, 202);
  assert.equal(retry.body.pending, true);
  assert.equal(live.counts.submits, 1);
  assert.equal(live.counts.tickers, 1);

  await ctx.close();

  const restartedLive = makeLiveTrader(root);
  const restartedServer = makeServer(restartedLive.trader, root, { storePath: server.manualOrderIdempotencyStore.filePath });
  const restartedCtx = await startRoutes(t, restartedServer);
  const afterRestart = await postJson(restartedCtx, '/api/trade/buy', body, 'live-ambiguous-once');
  assert.equal(afterRestart.status, 202);
  assert.equal(afterRestart.body.idempotency.status, 'unknown');
  assert.equal(restartedLive.counts.tickers, 0);
  assert.equal(restartedLive.counts.submits, 0);
});

test('smart sell rechecks the shared holding after awaited analysis and serializes automatic DRY_RUN order work', async t => {
  const root = makeRoot(t);
  let signalAnalysis;
  let releaseAnalysis;
  const analysisStarted = new Promise(resolve => { signalAnalysis = resolve; });
  const analysisGate = new Promise(resolve => { releaseAnalysis = resolve; });
  const trader = makeDryTrader(root, {
    balance: 10000,
    price: 200,
    getMinuteCandles: async () => {
      signalAnalysis();
      await analysisGate;
      return [];
    }
  });
  trader.virtualPortfolio.holdings.set('KRW-BTC', { amount: 10, avgPrice: 100, entryTime: null });
  const ctx = await startRoutes(t, makeServer(trader, root));

  const smartSellPromise = postJson(ctx, '/api/trade/smart-sell', {
    targetAmount: 1000,
    strategy: 'worst'
  }, 'smart-sell-race-key');
  await analysisStarted;

  // Simulate an old writer that still mutates the shared Map during analysis.
  // The route must use the current amount immediately before crediting proceeds.
  trader.virtualPortfolio.holdings.get('KRW-BTC').amount = 6;

  let automaticMutationStarted = false;
  const automaticMutation = trader.withPortfolioMutationLock(async () => {
    automaticMutationStarted = true;
    return true;
  });
  await Promise.resolve();
  assert.equal(automaticMutationStarted, false, 'automatic DRY_RUN work waits for the full manual command');
  releaseAnalysis();

  const result = await smartSellPromise;
  assert.equal(result.status, 200);
  assert.equal(result.body.trades.length, 1);
  assert.equal(result.body.trades[0].volume, 5);
  assert.equal(result.body.trades[0].grossAmount, 1000);
  assert.equal(result.body.totalReceived, 1000);
  assert.equal(trader.virtualPortfolio.krwBalance, 10000 + (1000 * 0.9995));
  assert.equal(trader.virtualPortfolio.holdings.get('KRW-BTC').amount, 1);
  await automaticMutation;
  assert.equal(automaticMutationStarted, true);
});

test('internal automatic executeOrder uses the DRY_RUN mutation lock without an HTTP idempotency key', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-auto-order-lock-'));
  try {
    const trader = makeDryTrader(root);
    trader._executeOrder = async () => 'automatic-order-executed';
    assert.equal(await trader.executeOrder('KRW-BTC', { action: 'BUY' }, 100, 20000, 0, 0), 'automatic-order-executed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('endpoint canonicalization sorts query keys and retains path identity', () => {
  const left = canonicalManualRequestEndpoint({ originalUrl: '/api/trade/buy?b=2&a=1' });
  const right = canonicalManualRequestEndpoint({ originalUrl: '/api/trade/buy?a=1&b=2' });
  const differentPath = canonicalManualRequestEndpoint({ originalUrl: '/api/trade/sell?a=1&b=2' });
  assert.equal(left, right);
  assert.notEqual(left, differentPath);
});
