import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
  addLiveOrderIntentEvidence,
  createLiveExecutionEvidenceEvent,
  inspectLiveExecutionEvidenceFile,
  readLiveOrderIntentEvidence
} from '../src/research/liveExecutionEvidence.js';
import {
  ManualOrderIdempotencyStore,
  createDefaultManualOrderIdempotencyStore,
  canonicalManualRequestEndpoint,
  createManualOrderIdempotencyMiddleware
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

function makeTemporaryDashboard(trader, root, port = 0, options = {}) {
  return new TemporaryDashboardServer(trader, port, {
    env: {
      ...process.env,
      DASHBOARD_TOKEN: '', DASHBOARD_READ_ONLY_TOKEN: '', DASHBOARD_MOBILE_TOKEN: '',
      DASHBOARD_HOST: '127.0.0.1',
      DASHBOARD_ALLOW_INSECURE: '',
      DASHBOARD_TLS_CERT_FILE: '',
      DASHBOARD_TLS_KEY_FILE: '',
      STAGING_OUTPUT_DIR: path.join(root, 'logs')
    },
    ...options
  });
}

function makeFakeUpbit({
  price = 100,
  tradeTimestamp = Date.now(),
  getMinuteCandles = async () => [],
  getOrder = async () => null
} = {}) {
  const calls = { ticker: 0, candles: 0, order: 0, orderReadback: 0, orderLookups: [] };
  return {
    calls,
    async getTicker(markets) {
      calls.ticker += 1;
      const requested = Array.isArray(markets) ? markets : [markets];
      return requested.map(market => ({
        market,
        trade_price: price,
        trade_timestamp: tradeTimestamp,
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
    async getOrder(identifier, options) {
      calls.orderReadback += 1;
      calls.orderLookups.push({ identifier, options });
      return getOrder(identifier, options);
    },
    async getMarkets() { return []; },
    async order() { calls.order += 1; return { success: false }; },
    async waitForOrderFill() { return { filled: false, error: 'fake' }; },
    async cancelOrder() { return { success: true }; }
  };
}

function makeDryTrader(root, { balance = 20000, price = 100, tradeTimestamp = Date.now(), getMinuteCandles } = {}) {
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
  trader.upbit = makeFakeUpbit({ price, tradeTimestamp, getMinuteCandles });
  return trader;
}

function makeLiveTrader(root, {
  onSubmit = async () => { throw new Error('fake ambiguous submit'); },
  getOrder = async () => null,
  tradeTimestamp = Date.now()
} = {}) {
  const liveExecutionEvidenceFile = path.join(root, 'live_execution_evidence.jsonl');
  const liveExecutionEvidenceStartup = inspectLiveExecutionEvidenceFile(liveExecutionEvidenceFile);
  const liveOrderIntentEvidenceIndex = liveExecutionEvidenceStartup.orderIntentEvidenceIndex;
  const upbit = makeFakeUpbit({ getOrder, tradeTimestamp });
  const unresolvedMarkets = new Set();
  let submitCount = 0;
  let strategyMutationCount = 0;
  let accountReadCount = 0;
  const recordLiveExecutionEvidence = event => {
    fs.mkdirSync(path.dirname(liveExecutionEvidenceFile), { recursive: true });
    fs.appendFileSync(liveExecutionEvidenceFile, `${JSON.stringify(event)}\n`, 'utf8');
    if ((event.eventType === 'ORDER_INTENT' || event.eventType === 'ORDER_REJECTED') &&
      !addLiveOrderIntentEvidence(liveOrderIntentEvidenceIndex, event)) {
      return false;
    }
    return true;
  };
  const createLiveExecutionEvidence = options => createLiveExecutionEvidenceEvent(options);
  const strategy = {
    currentPosition: null,
    openPosition() { strategyMutationCount += 1; },
    closePosition() { strategyMutationCount += 1; },
    recordPartialSell() { strategyMutationCount += 1; }
  };
  const trader = {
    dryRun: false,
    virtualPortfolioFile: path.join(root, 'dry_portfolio.json'),
    liveExecutionEvidenceFile,
    liveExecutionEvidenceStartup,
    liveOrderIntentEvidenceIndex,
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
    createLiveExecutionEvidence,
    recordLiveExecutionEvidence,
    strategies: new Map([['KRW-BTC', strategy]]),
    async getAccountInfo() {
      accountReadCount += 1;
      return [
        { currency: 'KRW', balance: '100000', locked: '0' },
        { currency: 'BTC', balance: '2', locked: '0' }
      ];
    },
    getKRWBalance(accounts) {
      return Number(accounts.find(account => account.currency === 'KRW')?.balance || 0);
    },
    saveVirtualPortfolio() {},
    markLiveMarketOrderUnresolved(market) { unresolvedMarkets.add(market); },
    async submitLiveOrder(market, side, volume, price, orderType, clientIntentId) {
      const requested = orderType === 'price'
        ? { amount: volume }
        : orderType === 'market'
          ? { volume }
          : { volume, price };
      recordLiveExecutionEvidence(createLiveExecutionEvidence({
        eventType: 'ORDER_INTENT',
        clientIntentId,
        market,
        side,
        orderType,
        requested
      }));
      submitCount += 1;
      return onSubmit(market, side, volume, price, orderType, clientIntentId);
    },
    async persistLiveOrderReadback({
      observedOrder,
      clientIntentId,
      market,
      side,
      orderType,
      request
    }) {
      const orderId = observedOrder.uuid;
      recordLiveExecutionEvidence(createLiveExecutionEvidence({
        eventType: 'ORDER_SUBMITTED',
        clientIntentId,
        orderId,
        market,
        side,
        orderType,
        requested: request,
        order: observedOrder
      }));
      recordLiveExecutionEvidence(createLiveExecutionEvidence({
        eventType: 'ORDER_STATE_OBSERVED',
        clientIntentId,
        orderId,
        market,
        side,
        orderType,
        order: observedOrder
      }));
      const fillResult = {
        filled: observedOrder.state === 'done',
        partial: false,
        order: observedOrder
      };
      recordLiveExecutionEvidence(createLiveExecutionEvidence({
        eventType: observedOrder.state === 'done' ? 'FILL_OBSERVED' : 'FILL_NOT_OBSERVED',
        clientIntentId,
        orderId,
        market,
        side,
        orderType,
        order: observedOrder,
        fillResult
      }));
      return orderId;
    }
  };
  const counts = {
    get submits() { return submitCount; },
    get tickers() { return upbit.calls.ticker; },
    get orderReadbacks() { return upbit.calls.orderReadback; },
    get orderLookups() { return [...upbit.calls.orderLookups]; },
    get strategyMutations() { return strategyMutationCount; },
    get accountReads() { return accountReadCount; },
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
  return {
    status: response.status,
    body: responseBody,
    idempotencyStatus: response.headers.get('Idempotency-Status')
  };
}

function makeExchangeOrder(identifier, market = 'KRW-BTC', side = 'bid', overrides = {}) {
  return {
    uuid: '6f1e2d3c-4b5a-4c6d-8e9f-0123456789ab',
    identifier,
    market,
    side,
    ord_type: side === 'bid' ? 'price' : 'market',
    state: 'done',
    executed_volume: '0.5',
    remaining_volume: '0',
    avg_price: '10000',
    paid_fee: '2.5',
    created_at: '2026-09-29T00:00:00Z',
    done_at: '2026-09-29T00:00:01Z',
    trades_count: 1,
    ...overrides
  };
}

async function startTerminalResponseRoute(t, server, status, body, { beforeRespond = () => {} } = {}) {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  router.use(createManualOrderIdempotencyMiddleware(server, { paths: new Set(['/result']) }));
  router.post('/result', (req, res) => {
    beforeRespond(req, res);
    return res.status(status).json(body);
  });
  app.use('/api', router);
  const httpServer = app.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  let closePromise = null;
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = new Promise((resolve, reject) => {
      httpServer.close(error => {
        if (error) return reject(error);
        try {
          server.manualOrderIdempotencyStore?.releaseWriterLock?.();
          resolve();
        } catch (caught) {
          reject(caught);
        }
      });
    });
    return closePromise;
  };
  t.after(close);
  const { port } = httpServer.address();
  return { baseUrl: `http://127.0.0.1:${port}`, httpServer, close };
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
    assert.equal(result.idempotencyStatus, 'rejected');
  }
  assert.equal(trader.upbit.calls.ticker, 0);
  assert.equal(trader.virtualPortfolio.krwBalance, initialBalance);
  assert.equal(trader.virtualPortfolio.holdings.size, 0);
});

test('DRY_RUN without a portfolio transaction does not leave a stale in-flight retry', async t => {
  const root = makeRoot(t);
  const trader = makeDryTrader(root);
  trader.withManualPortfolioTransaction = undefined;
  const server = makeServer(trader, root);
  const ctx = await startRoutes(t, server);
  const body = { coin: 'KRW-BTC', amount: 5000 };

  const first = await postJson(ctx, '/api/trade/buy', body, 'dry-run-transaction-unavailable');
  assert.equal(first.status, 202);
  assert.equal(first.idempotencyStatus, 'unknown');
  assert.equal(first.body.idempotency.status, 'unknown');
  assert.equal(trader.upbit.calls.ticker, 0, 'the route must not run without its portfolio transaction');

  const retry = await postJson(ctx, '/api/trade/buy', body, 'dry-run-transaction-unavailable');
  assert.equal(retry.status, 202);
  assert.equal(retry.idempotencyStatus, 'unknown');
  assert.equal(retry.body.idempotency.status, 'unknown', 'unsupported transaction capability is not stale pending work');
  assert.equal(trader.upbit.calls.ticker, 0, 'same-key retry must remain fail-closed');
});

test('durable terminal LIVE 409 and rolled-back DRY_RUN 503 replay with completed header and unchanged body', async t => {
  const cases = [
    {
      name: 'LIVE terminal 409',
      status: 409,
      makeTrader: makeLiveTrader,
      body: {
        success: false,
        mode: 'LIVE',
        reason: 'live_order_in_progress',
        error: { code: 'live_order_in_progress', message: 'fake terminal rejection' }
      }
    },
    {
      name: 'DRY_RUN rolled-back 503',
      status: 503,
      makeTrader: makeDryTrader,
      body: {
        success: false,
        pending: false,
        mode: 'DRY_RUN',
        error: { code: 'fake_paper_transaction_failure', message: 'fake terminal rejection' }
      }
    }
  ];

  for (const item of cases) {
    await t.test(item.name, async t => {
      const root = makeRoot(t);
      const trader = item.makeTrader === makeLiveTrader ? makeLiveTrader(root).trader : item.makeTrader(root);
      const server = makeServer(trader, root);
      const initialBalance = trader.dryRun ? trader.virtualPortfolio.krwBalance : null;
      const ctx = await startTerminalResponseRoute(t, server, item.status, item.body, {
        beforeRespond: () => {
          if (trader.dryRun) trader.virtualPortfolio.krwBalance -= 1234;
        }
      });
      const requestBody = { requestedAction: 'fake-only' };
      const first = await postJson(ctx, '/api/result', requestBody, `terminal-result-${item.status}`);
      const replay = await postJson(ctx, '/api/result', requestBody, `terminal-result-${item.status}`);

      assert.equal(first.status, item.status);
      assert.equal(first.idempotencyStatus, 'completed');
      assert.deepEqual(first.body, item.body);
      assert.equal(replay.status, item.status);
      assert.equal(replay.idempotencyStatus, 'completed');
      assert.deepEqual(replay.body, first.body);
      assert.equal(server.manualOrderIdempotencyStore.records.values().next().value.state, 'completed');
      if (trader.dryRun) {
        assert.equal(trader.virtualPortfolio.krwBalance, initialBalance, 'the failed DRY_RUN mutation is rolled back');
        assert.equal(trader.virtualPortfolio.holdings.size, 0);
      }
    });
  }
});

test('DRY_RUN legacy buy mutates once, replays canonical same-body response, and rejects key reuse', async t => {
  const root = makeRoot(t);
  const trader = makeDryTrader(root);
  const server = makeServer(trader, root);
  const ctx = await startRoutes(t, server);
  const key = 'dry-buy-key-01';
  const first = await postJson(ctx, '/api/trade/buy', { coin: 'KRW-BTC', amount: 5000 }, key);
  assert.equal(first.status, 200);
  assert.equal(first.idempotencyStatus, 'completed');
  assert.equal(first.body.success, true);
  assert.equal(first.body.mode, 'DRY_RUN');
  assert.equal(trader.virtualPortfolio.krwBalance, 15000);
  const expectedVolume = (5000 - 2.5) / 100;
  assert.ok(Math.abs(trader.virtualPortfolio.holdings.get('KRW-BTC').amount - expectedVolume) < 1e-10);
  assert.equal(trader.upbit.calls.ticker, 1);

  // JSON key order is not part of the body identity.
  const replay = await postJson(ctx, '/api/trade/buy', { amount: 5000, coin: 'KRW-BTC' }, key);
  assert.equal(replay.status, first.status);
  assert.equal(replay.idempotencyStatus, 'completed');
  assert.deepEqual(replay.body, first.body);
  assert.equal(trader.virtualPortfolio.krwBalance, 15000);
  assert.equal(trader.upbit.calls.ticker, 1);

  const bodyConflict = await postJson(ctx, '/api/trade/buy', { coin: 'KRW-BTC', amount: 6000 }, key);
  assert.equal(bodyConflict.status, 409);
  assert.equal(bodyConflict.idempotencyStatus, 'conflict');
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

test('manual buy rejects a stale Upbit trade timestamp before mutating the DRY_RUN portfolio', async t => {
  const root = makeRoot(t);
  const initialBalance = 20_000;
  const trader = makeDryTrader(root, {
    balance: initialBalance,
    tradeTimestamp: Date.now() - 10 * 60_000
  });
  const ctx = await startRoutes(t, makeServer(trader, root));

  const result = await postJson(
    ctx,
    '/api/trade/buy',
    { coin: 'KRW-BTC', amount: 5_000 },
    'dry-buy-stale-quote'
  );

  assert.equal(result.status, 409);
  assert.equal(result.body.success, false);
  assert.equal(result.body.code, 'MARKET_QUOTE_STALE');
  assert.equal(result.body.markets[0].reason, 'market_source_stale');
  assert.equal(trader.virtualPortfolio.krwBalance, initialBalance);
  assert.equal(trader.virtualPortfolio.holdings.size, 0);
  assert.equal(trader.upbit.calls.order, 0);
});

test('LIVE manual buy rejects a stale quote before creating an exchange-order intent', async t => {
  const root = makeRoot(t);
  const live = makeLiveTrader(root, { tradeTimestamp: Date.now() - 10 * 60_000 });
  const ctx = await startRoutes(t, makeServer(live.trader, root));

  const result = await postJson(ctx, '/api/trade/buy', {
    coin: 'KRW-BTC',
    amount: 5_000
  }, 'live-buy-stale-quote');

  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'MARKET_QUOTE_STALE');
  assert.equal(live.counts.submits, 0);
  assert.equal(live.counts.strategyMutations, 0);
  assert.equal(live.counts.unresolvedMarkets.size, 0);
});

test('bundle rejects a stale buy leg before the fresh sell leg can mutate the portfolio', async t => {
  const root = makeRoot(t);
  const trader = makeDryTrader(root, { balance: 20_000 });
  trader.virtualPortfolio.holdings.set('KRW-BTC', { amount: 10, avgPrice: 90, entryTime: null });
  const originalUpbit = trader.upbit;
  trader.upbit = {
    ...originalUpbit,
    async getTicker(markets) {
      originalUpbit.calls.ticker += 1;
      const requested = Array.isArray(markets) ? markets : [markets];
      return requested.map(market => ({
        market,
        trade_price: 100,
        trade_timestamp: market === 'KRW-ETH' ? Date.now() - 10 * 60_000 : Date.now()
      }));
    }
  };
  const ctx = await startRoutes(t, makeServer(trader, root));

  const result = await postJson(ctx, '/api/trade/execute-bundle', {
    sellCoin: 'KRW-BTC',
    buyCoin: 'KRW-ETH'
  }, 'bundle-stale-buy-leg');

  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'MARKET_QUOTE_STALE');
  assert.equal(result.body.markets.some(market => market.market === 'KRW-ETH'), true);
  assert.equal(trader.virtualPortfolio.krwBalance, 20_000);
  assert.equal(trader.virtualPortfolio.holdings.get('KRW-BTC').amount, 10);
  assert.equal(trader.virtualPortfolio.holdings.has('KRW-ETH'), false);
});

test('smart buy does not select a stale server-side market candidate', async t => {
  const root = makeRoot(t);
  const trader = makeDryTrader(root, {
    balance: 20_000,
    tradeTimestamp: Date.now() - 10 * 60_000
  });
  trader.upbit.getMarkets = async () => [{ market: 'KRW-BTC' }];
  const ctx = await startRoutes(t, makeServer(trader, root));

  const result = await postJson(ctx, '/api/trade/smart-buy', {
    totalAmount: 5_000,
    minScore: 0,
    maxCoins: 1
  }, 'smart-buy-stale-candidate');

  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'MARKET_QUOTE_STALE');
  assert.equal(trader.virtualPortfolio.krwBalance, 20_000);
  assert.equal(trader.virtualPortfolio.holdings.size, 0);
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
      return requested.map(market => ({ market, trade_price: 100, trade_timestamp: Date.now() }));
    }
  };
  const ctx = await startRoutes(t, makeServer(trader, root));
  const body = { coin: 'KRW-BTC', amount: 5000 };
  const firstPromise = postJson(ctx, '/api/trade/buy', body, 'same-key-concurrent');
  await tickerRead;

  const concurrent = await postJson(ctx, '/api/trade/buy', body, 'same-key-concurrent');
  assert.equal(concurrent.status, 202);
  assert.equal(concurrent.idempotencyStatus, 'pending');
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
      return requested.map(market => ({ market, trade_price: 100, trade_timestamp: Date.now() }));
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

test('DashboardServer stop preserves a caller-owned profile lock until the runtime owner releases it', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-dashboard-external-lock-'));
  const trader = makeDryTrader(root);
  const profilePath = path.join(root, 'dry_portfolio.json');
  const externalStore = new ManualOrderIdempotencyStore({
    filePath: `${profilePath}.manual_order_idempotency.json`,
    writerLockPath: `${profilePath}.manual_order_writer.lock`
  });
  let dashboard = null;
  let stopped = false;
  let snapshotFlushCount = 0;
  t.after(async () => {
    if (!stopped && dashboard && (dashboard.io || dashboard.server)) await dashboard.stop();
    if (externalStore.writerLock) externalStore.releaseWriterLock();
    if (dashboard) await dashboard.logger.flush();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await externalStore.initialize();
  dashboard = makeTemporaryDashboard(trader, root, 0, {
    manualOrderIdempotencyStore: externalStore,
    releaseManualOrderWriterLockOnStop: false,
    publicMarketDataSource: {
      async getMarkets() { return []; },
      async getTicker() { return []; },
      async getMinuteCandles() { return []; },
      async flushSnapshot() { snapshotFlushCount += 1; }
    }
  });
  await dashboard.start();
  assert.equal(fs.existsSync(externalStore.writerLockPath), true);

  await dashboard.stop();
  stopped = true;
  await dashboard.logger.flush();

  assert.equal(fs.existsSync(externalStore.writerLockPath), true,
    'DashboardServer does not release ownership that the runtime supplied');
  assert.equal(snapshotFlushCount, 1, 'DashboardServer drains its shared public snapshot writer before shutdown completes');
  assert.equal(externalStore.releaseWriterLock(), true);
  assert.equal(fs.existsSync(externalStore.writerLockPath), false);
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
  assert.equal(afterRestart.idempotencyStatus, 'unknown');
  assert.equal(afterRestart.body.idempotency.status, 'unknown');
  assert.equal(restartedLive.counts.tickers, 0);
  assert.equal(restartedLive.counts.submits, 0);
});

test('MultiCoinTrader sends the pre-persisted intent identifier to the Upbit order call', async t => {
  const root = makeRoot(t);
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: false,
    virtualPortfolioFile: path.join(root, 'dry_portfolio.json'),
    paperValidationFile: path.join(root, 'paper_validation.json'),
    portfolioHistoryFile: path.join(root, 'portfolio_history.json'),
    liveExecutionEvidenceFile: path.join(root, 'live_evidence.jsonl'),
    positionRiskCheckIntervalMs: 0,
    useNews: false
  });
  const clientIntentId = '123e4567-e89b-42d3-a456-426614174000';
  let postedArguments = null;
  trader._liveAccountStateKnown = true;
  trader._liveExchangeStateKnown = true;
  trader.canExecuteLiveOrder = () => true;
  trader.upbit = {
    async order(...args) {
      postedArguments = args;
      return {
        success: true,
        data: {
          uuid: '6f1e2d3c-4b5a-4c6d-8e9f-0123456789ab',
          identifier: clientIntentId,
          market: 'KRW-BTC',
          side: 'bid',
          ord_type: 'price',
          state: 'wait'
        }
      };
    }
  };

  await trader.submitLiveOrder('KRW-BTC', 'bid', 5000, null, 'price', clientIntentId);

  assert.deepEqual(postedArguments, [
    'KRW-BTC', 'bid', 5000, null, 'price', clientIntentId, { priority: 'risk' }
  ]);
  const events = fs.readFileSync(trader.liveExecutionEvidenceFile, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  assert.equal(events[0].eventType, 'ORDER_INTENT');
  assert.equal(events[0].clientIntentId, clientIntentId);
  assert.equal(events[0].identifier, clientIntentId);
  assert.equal(readLiveOrderIntentEvidence(trader.liveOrderIntentEvidenceIndex, clientIntentId).available, true);
});

test('same-process duplicate stays pending while the original LIVE request is active, then restart can recover', async t => {
  const root = makeRoot(t);
  let signalSubmitStarted;
  const submitStarted = new Promise(resolve => { signalSubmitStarted = resolve; });
  let releaseSubmit;
  const submitGate = new Promise(resolve => { releaseSubmit = resolve; });
  let acceptedIntentId = null;
  let acceptedOrder = null;
  const live = makeLiveTrader(root, {
    onSubmit: async (_market, _side, _volume, _price, _orderType, clientIntentId) => {
      acceptedIntentId = clientIntentId;
      acceptedOrder = makeExchangeOrder(clientIntentId);
      signalSubmitStarted();
      await submitGate;
      throw new Error('fake accepted POST with response lost after the concurrent retry');
    },
    getOrder: async identifier => identifier === acceptedIntentId ? { ...acceptedOrder } : null
  });
  const server = makeServer(live.trader, root);
  const ctx = await startRoutes(t, server);
  const body = { coin: 'KRW-BTC', amount: 5000 };
  const key = 'same-process-active-live-order';
  const firstPromise = postJson(ctx, '/api/trade/buy', body, key);
  await submitStarted;

  const concurrentRetry = await postJson(ctx, '/api/trade/buy', body, key);
  assert.equal(concurrentRetry.status, 202);
  assert.equal(concurrentRetry.idempotencyStatus, 'pending');
  assert.equal(concurrentRetry.body.idempotency.status, 'pending');
  assert.equal(live.counts.submits, 1);
  assert.equal(live.counts.orderReadbacks, 0, 'the active command is not raced by identifier lookup');

  releaseSubmit();
  const first = await firstPromise;
  assert.equal(first.status, 202);
  assert.equal(first.body.idempotency.status, 'unknown');
  await ctx.close();

  const restartedLive = makeLiveTrader(root, {
    onSubmit: async () => { throw new Error('restart recovery must not POST'); },
    getOrder: async (identifier, options) => {
      assert.equal(identifier, acceptedIntentId);
      assert.deepEqual(options, { identifier: true });
      return { ...acceptedOrder };
    }
  });
  const restartedServer = makeServer(restartedLive.trader, root, {
    storePath: server.manualOrderIdempotencyStore.filePath
  });
  const restartedCtx = await startRoutes(t, restartedServer);
  const recovered = await postJson(restartedCtx, '/api/trade/buy', body, key);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.idempotencyStatus, 'completed');
  assert.equal(restartedLive.counts.orderReadbacks, 1);
  assert.equal(restartedLive.counts.submits, 0);
  assert.equal(live.counts.submits + restartedLive.counts.submits, 1);
});

test('single-order LIVE retry recovers a terminal identifier readback and caches it without replaying route mutations', async t => {
  const cases = [
    {
      name: 'legacy buy',
      endpoint: '/api/trade/buy',
      body: { coin: 'KRW-BTC', amount: 5000 },
      side: 'bid'
    },
    {
      name: 'execute buy',
      endpoint: '/api/trade/execute',
      body: { coin: 'KRW-BTC', action: 'BUY', amount: 5000 },
      side: 'bid'
    },
    {
      name: 'execute sell',
      endpoint: '/api/trade/execute',
      body: { coin: 'KRW-BTC', action: 'SELL', amount: 5000 },
      side: 'ask'
    },
    {
      name: 'quick buy',
      endpoint: '/api/trade/quick',
      body: { coin: 'KRW-BTC', action: 'BUY', amount: 5000 },
      side: 'bid'
    },
    {
      name: 'quick sell',
      endpoint: '/api/trade/quick',
      body: { coin: 'KRW-BTC', action: 'SELL', amount: 5000 },
      side: 'ask'
    },
    {
      name: 'legacy sell',
      endpoint: '/api/trade/sell',
      body: { coin: 'KRW-BTC', quantity: 1 },
      side: 'ask'
    }
  ];

  for (const item of cases) {
    await t.test(item.name, async t => {
      const root = makeRoot(t);
      let exchangeOrder = null;
      let postedIntentId = null;
      const live = makeLiveTrader(root, {
        onSubmit: async (_market, _side, _volume, _price, _orderType, clientIntentId) => {
          postedIntentId = clientIntentId;
          assert.equal(
            [...server.manualOrderIdempotencyStore.records.values()][0]?.clientIntentId,
            clientIntentId,
            'the intent identifier is durable before the exchange POST begins'
          );
          exchangeOrder = makeExchangeOrder(clientIntentId, 'KRW-BTC', item.side);
          throw new Error('fake accepted POST with lost response');
        },
        getOrder: async (identifier, options) => {
          if (!exchangeOrder || identifier !== postedIntentId || options?.identifier !== true) return null;
          return { ...exchangeOrder };
        }
      });
      const server = makeServer(live.trader, root);
      const key = `live-recover-${item.name.replaceAll(' ', '-')}`;
      const firstCtx = await startRoutes(t, server);
      const first = await postJson(firstCtx, item.endpoint, item.body, key);
      const pendingRecord = [...server.manualOrderIdempotencyStore.records.values()][0];

      assert.equal(first.status, 202);
      assert.equal(first.body.idempotency.status, 'unknown');
      assert.match(pendingRecord.clientIntentId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      assert.notEqual(pendingRecord.keyHash, key, 'the raw idempotency key is not persisted');
      assert.equal(Object.hasOwn(pendingRecord, 'idempotencyKey'), false);
      assert.equal(postedIntentId, pendingRecord.clientIntentId, 'the persisted identifier is the identifier passed to the exchange POST path');
      assert.equal(live.counts.submits, 1);
      assert.equal(live.trader.upbit.calls.order, 0, 'the fake route never calls the exchange POST client directly');
      await firstCtx.close();

      const restartedLive = makeLiveTrader(root, {
        onSubmit: async () => { throw new Error('retry must never POST'); },
        getOrder: async (identifier, options) => {
          assert.equal(identifier, pendingRecord.clientIntentId);
          assert.deepEqual(options, { identifier: true });
          return { ...exchangeOrder };
        }
      });
      const restartedServer = makeServer(restartedLive.trader, root, {
        storePath: server.manualOrderIdempotencyStore.filePath
      });
      const restartedCtx = await startRoutes(t, restartedServer);
      const recovered = await postJson(restartedCtx, item.endpoint, item.body, key);

      assert.equal(recovered.status, 200);
      assert.equal(recovered.idempotencyStatus, 'completed');
      assert.equal(recovered.body.success, true);
      assert.equal(recovered.body.recovered, true);
      assert.equal(recovered.body.fill.status, 'filled');
      assert.equal(recovered.body.settlement.status, 'not_observed');
      assert.equal(recovered.body.strategyState.status, 'not_mutated');
      assert.equal(restartedLive.counts.orderReadbacks, 1);
      assert.equal(restartedLive.counts.submits, 0);
      assert.equal(restartedLive.trader.upbit.calls.order, 0);
      assert.equal(restartedLive.counts.tickers, 0);
      assert.equal(restartedLive.counts.strategyMutations, 0);
      assert.equal(restartedLive.counts.accountReads, 0, 'recovery reads exchange order state only');

      const completed = [...restartedServer.manualOrderIdempotencyStore.records.values()][0];
      assert.equal(completed.state, 'completed');
      assert.equal(completed.recovered, true);
      assert.deepEqual(completed.responseBody, recovered.body);
      const replay = await postJson(restartedCtx, item.endpoint, item.body, key);
      assert.equal(replay.status, recovered.status);
      assert.equal(replay.idempotencyStatus, 'completed');
      assert.deepEqual(replay.body, recovered.body);
      assert.equal(restartedLive.counts.orderReadbacks, 1, 'completed response is replayed without another exchange GET');
      assert.equal(live.counts.submits + restartedLive.counts.submits, 1);
    });
  }
});

test('LIVE bundle and smart-order retries remain unknown without leg intents or plan replay', async t => {
  const cases = [
    {
      endpoint: '/api/trade/execute-bundle',
      body: { sellCoin: 'KRW-BTC', buyCoin: 'KRW-ETH', amount: 5000 },
      requestIntent: null
    },
    {
      endpoint: '/api/trade/execute-bundle',
      body: { sellCoin: 'KRW-BTC', buyCoin: 'KRW-ETH', amount: 5000 },
      requestIntent: randomUUID()
    },
    {
      endpoint: '/api/trade/smart-buy',
      body: { totalAmount: 10000, minScore: 60, maxCoins: 1 },
      requestIntent: randomUUID()
    },
    {
      endpoint: '/api/trade/smart-sell',
      body: { targetAmount: 1000, strategy: 'worst' },
      requestIntent: randomUUID()
    }
  ];

  for (const item of cases) {
    await t.test(`${item.endpoint} (requestIntent=${item.requestIntent === null ? 'absent' : 'present'})`, async t => {
      const root = makeRoot(t);
      const live = makeLiveTrader(root);
      const server = makeServer(live.trader, root);
      const reservation = await server.manualOrderIdempotencyStore.reserve({
        profileId: 'operator',
        idempotencyKey: `live-compound-${item.endpoint}`,
        method: 'POST',
        endpoint: item.endpoint,
        body: item.body,
        mode: 'LIVE',
        clientIntentId: item.requestIntent
      });
      assert.equal(reservation.kind, 'reserved');
      if (item.requestIntent === null) {
        assert.equal(Object.hasOwn(reservation.record, 'clientIntentId'), false);
      } else {
        assert.equal(reservation.record.clientIntentId, item.requestIntent);
      }
      assert.equal(Object.hasOwn(reservation.record, 'legIntents'), false);
      await server.manualOrderIdempotencyStore.markUnknown(reservation.record.recordId, 'simulated_interrupted_plan');

      const ctx = await startRoutes(t, server);
      const key = `live-compound-${item.endpoint}`;
      const firstRetry = await postJson(ctx, item.endpoint, item.body, key);
      const secondRetry = await postJson(ctx, item.endpoint, item.body, key);

      assert.equal(firstRetry.status, 202);
      assert.equal(firstRetry.idempotencyStatus, 'unknown');
      assert.equal(secondRetry.status, 202);
      assert.equal(secondRetry.body.idempotency.status, 'unknown');
      assert.equal(live.counts.orderReadbacks, 0, 'compound plans do not auto-reconcile by one client identifier');
      assert.equal(live.counts.submits, 0, 'compound plan retries never replay dynamic legs');
      assert.equal(live.counts.tickers, 0, 'the route is not re-run');
    });
  }
});

test('terminal cancellation without a fill recovers as a cached no-fill result without wallet settlement', async t => {
  const root = makeRoot(t);
  let acceptedOrder = null;
  const live = makeLiveTrader(root, {
    onSubmit: async (_market, _side, _volume, _price, _orderType, clientIntentId) => {
      acceptedOrder = makeExchangeOrder(clientIntentId, 'KRW-BTC', 'ask', {
        state: 'cancel',
        executed_volume: '0',
        remaining_volume: '1',
        avg_price: null,
        paid_fee: '0'
      });
      throw new Error('fake accepted POST with lost response');
    },
    getOrder: async () => ({ ...acceptedOrder })
  });
  const server = makeServer(live.trader, root);
  const firstCtx = await startRoutes(t, server);
  const first = await postJson(firstCtx, '/api/trade/sell', { coin: 'KRW-BTC', quantity: 1 }, 'terminal-cancel-key');
  assert.equal(first.status, 202);
  await firstCtx.close();

  const restartedLive = makeLiveTrader(root, {
    getOrder: async (identifier, options) => {
      assert.equal(identifier, acceptedOrder.identifier);
      assert.deepEqual(options, { identifier: true });
      return { ...acceptedOrder };
    }
  });
  const restartedServer = makeServer(restartedLive.trader, root, { storePath: server.manualOrderIdempotencyStore.filePath });
  const restartedCtx = await startRoutes(t, restartedServer);
  const recovered = await postJson(restartedCtx, '/api/trade/sell', { coin: 'KRW-BTC', quantity: 1 }, 'terminal-cancel-key');

  assert.equal(recovered.status, 409);
  assert.equal(recovered.idempotencyStatus, 'completed');
  assert.equal(recovered.body.success, false);
  assert.equal(recovered.body.recovered, true);
  assert.equal(recovered.body.fill.status, 'not_observed');
  assert.equal(recovered.body.fill.exchangeState, 'cancel');
  assert.equal(recovered.body.settlement.status, 'not_observed');
  assert.equal(restartedLive.counts.submits, 0);
  assert.equal(restartedLive.counts.strategyMutations, 0);
});

test('nonterminal, mismatched, incomplete, missing, or unreadable LIVE evidence stays unknown without another POST', async t => {
  const cases = [
    {
      name: '404 identifier lookup',
      getOrder: async () => { throw Object.assign(new Error('not found'), { status: 404 }); }
    },
    {
      name: 'waiting order',
      makeOrder: identifier => makeExchangeOrder(identifier, 'KRW-BTC', 'bid', { state: 'wait' })
    },
    {
      name: 'identifier mismatch',
      makeOrder: identifier => makeExchangeOrder(identifier, 'KRW-BTC', 'bid', {
        identifier: '11111111-2222-4333-8444-555555555555'
      })
    },
    {
      name: 'incomplete fill accounting',
      makeOrder: identifier => makeExchangeOrder(identifier, 'KRW-BTC', 'bid', { paid_fee: null })
    },
    {
      name: 'partial terminal cancellation',
      makeOrder: identifier => makeExchangeOrder(identifier, 'KRW-BTC', 'bid', {
        state: 'cancel',
        executed_volume: '0.1',
        remaining_volume: '0.4'
      })
    },
    {
      name: 'missing intent link',
      removeIntent: true,
      makeOrder: identifier => makeExchangeOrder(identifier)
    },
    {
      name: 'unreadable evidence',
      corruptEvidence: true,
      makeOrder: identifier => makeExchangeOrder(identifier)
    }
  ];

  for (const item of cases) {
    await t.test(item.name, async t => {
      const root = makeRoot(t);
      let acceptedOrder = null;
      const firstLive = makeLiveTrader(root, {
        onSubmit: async (_market, _side, _volume, _price, _orderType, clientIntentId) => {
          acceptedOrder = item.makeOrder ? item.makeOrder(clientIntentId) : null;
          throw new Error('fake accepted POST with lost response');
        }
      });
      const server = makeServer(firstLive.trader, root);
      const key = `live-unresolved-${item.name.replaceAll(' ', '-')}`;
      const firstCtx = await startRoutes(t, server);
      const first = await postJson(firstCtx, '/api/trade/buy', { coin: 'KRW-BTC', amount: 5000 }, key);
      assert.equal(first.status, 202);
      assert.equal(firstLive.counts.submits, 1);
      await firstCtx.close();

      const intentEvidenceFile = firstLive.trader.liveExecutionEvidenceFile;
      if (item.removeIntent) fs.rmSync(intentEvidenceFile, { force: true });
      if (item.corruptEvidence) fs.appendFileSync(intentEvidenceFile, 'not-json\n', 'utf8');
      let readCount = 0;
      const restartedLive = makeLiveTrader(root, {
        onSubmit: async () => { throw new Error('retry must never POST'); },
        getOrder: async () => {
          readCount += 1;
          if (item.getOrder) return item.getOrder();
          return acceptedOrder ? { ...acceptedOrder } : null;
        }
      });
      const restartedServer = makeServer(restartedLive.trader, root, {
        storePath: server.manualOrderIdempotencyStore.filePath
      });
      const restartedCtx = await startRoutes(t, restartedServer);
      const retry = await postJson(restartedCtx, '/api/trade/buy', { coin: 'KRW-BTC', amount: 5000 }, key);

      assert.equal(retry.status, 202);
      assert.equal(retry.idempotencyStatus, 'unknown');
      assert.equal(retry.body.idempotency.status, 'unknown');
      assert.equal(restartedLive.counts.submits, 0);
      assert.equal(restartedLive.counts.tickers, 0);
      assert.equal(restartedLive.counts.strategyMutations, 0);
      assert.equal(restartedLive.counts.orderReadbacks, item.removeIntent || item.corruptEvidence ? 0 : 1);
      assert.equal(restartedLive.counts.orderReadbacks, readCount);
      assert.equal(firstLive.counts.submits + restartedLive.counts.submits, 1);
      const unresolved = [...restartedServer.manualOrderIdempotencyStore.records.values()][0];
      assert.equal(unresolved.state, 'unknown');
      assert.equal(Object.hasOwn(unresolved, 'responseBody'), false);

      const repeatedRetry = await postJson(restartedCtx, '/api/trade/buy', { coin: 'KRW-BTC', amount: 5000 }, key);
      assert.equal(repeatedRetry.status, 202);
      assert.equal(repeatedRetry.body.idempotency.status, 'unknown');
      assert.equal(restartedLive.counts.submits, 0);
      assert.equal(firstLive.counts.submits + restartedLive.counts.submits, 1);
    });
  }
});

test('a definitively rejected LIVE order completes terminally and replays instead of wedging the key', async t => {
  const root = makeRoot(t);
  const live = makeLiveTrader(root, {
    onSubmit: async () => ({
      success: false,
      error: { code: 'insufficient_funds_bid', message: '매수 자금 부족' }
    })
  });
  const server = makeServer(live.trader, root);
  const ctx = await startRoutes(t, server);
  const key = 'live-rejected-bid-key';
  const first = await postJson(ctx, '/api/trade/buy', { coin: 'KRW-BTC', amount: 5000 }, key);

  // The exchange refused dispatch: the rejection evidence plus the refusal
  // response carry no ambiguous fill marker, so the request completes as a
  // terminal rejection the same key can replay.
  assert.equal(first.status, 409);
  assert.equal(first.idempotencyStatus, 'completed');
  assert.equal(first.body.success, false);
  assert.equal(first.body.reason, '매수 자금 부족');
  assert.equal(live.counts.submits, 1);
  assert.equal(live.counts.strategyMutations, 0);

  const replay = await postJson(ctx, '/api/trade/buy', { coin: 'KRW-BTC', amount: 5000 }, key);
  assert.equal(replay.status, 409);
  assert.equal(replay.idempotencyStatus, 'completed');
  assert.equal(live.counts.submits, 1, 'same-key replay returns the rejection without another POST');
});

test('a wedged LIVE record resolves terminally from definitive rejection evidence plus a 404 readback', async t => {
  const root = makeRoot(t);
  const firstLive = makeLiveTrader(root, {
    onSubmit: async () => ({
      success: false,
      error: { code: 'insufficient_funds_bid', message: '매수 자금 부족' }
    })
  });
  const server = makeServer(firstLive.trader, root);
  const clientIntentId = '66666666-7777-4888-8999-000000000000';

  // Simulate a crash between the durable ORDER_INTENT + ORDER_REJECTED
  // appends and the response commit: the journal stays unknown while the
  // evidence ledger still proves the exchange refused dispatch.
  const reservation = await server.manualOrderIdempotencyStore.reserve({
    profileId: 'operator',
    idempotencyKey: 'live-wedged-rejection-key',
    method: 'POST',
    endpoint: '/api/trade/buy',
    body: { coin: 'KRW-BTC', amount: 5000 },
    mode: 'LIVE',
    clientIntentId
  });
  assert.equal(reservation.kind, 'reserved');
  firstLive.trader.recordLiveExecutionEvidence(firstLive.trader.createLiveExecutionEvidence({
    eventType: 'ORDER_INTENT',
    clientIntentId,
    market: 'KRW-BTC',
    side: 'bid',
    orderType: 'price',
    requested: { amount: 5000 }
  }));
  firstLive.trader.recordLiveExecutionEvidence(firstLive.trader.createLiveExecutionEvidence({
    eventType: 'ORDER_REJECTED',
    clientIntentId,
    market: 'KRW-BTC',
    side: 'bid',
    orderType: 'price',
    requested: { amount: 5000 },
    error: '매수 자금 부족',
    errorCode: 'insufficient_funds_bid'
  }));
  await server.manualOrderIdempotencyStore.markUnknown(
    reservation.record.recordId,
    'simulated_interrupted_rejection'
  );
  server.manualOrderIdempotencyStore.releaseWriterLock();

  let readCount = 0;
  const restartedLive = makeLiveTrader(root, {
    onSubmit: async () => { throw new Error('retry must never POST'); },
    getOrder: async () => {
      readCount += 1;
      throw Object.assign(new Error('order_not_found'), { response: { status: 404 } });
    }
  });
  const restartedServer = makeServer(restartedLive.trader, root, {
    storePath: server.manualOrderIdempotencyStore.filePath
  });
  const restartedCtx = await startRoutes(t, restartedServer);
  const recovered = await postJson(restartedCtx, '/api/trade/buy',
    { coin: 'KRW-BTC', amount: 5000 }, 'live-wedged-rejection-key');

  assert.equal(recovered.status, 400);
  assert.equal(recovered.idempotencyStatus, 'completed');
  assert.equal(recovered.body.success, false);
  assert.equal(recovered.body.recovered, true);
  assert.equal(recovered.body.error.code, 'insufficient_funds_bid');
  assert.equal(recovered.body.fill.status, 'not_observed');
  assert.equal(recovered.body.settlement.status, 'not_observed');
  assert.equal(readCount, 1);
  assert.equal(restartedLive.counts.submits, 0);
  assert.equal(restartedLive.counts.strategyMutations, 0);

  const replay = await postJson(restartedCtx, '/api/trade/buy',
    { coin: 'KRW-BTC', amount: 5000 }, 'live-wedged-rejection-key');
  assert.equal(replay.status, 400);
  assert.equal(replay.idempotencyStatus, 'completed');
  assert.equal(readCount, 1, 'completed replay does not re-query the exchange');
});

test('a bare 404 readback without rejection evidence still stays unknown (identifier-index lag)', async t => {
  const root = makeRoot(t);
  const firstLive = makeLiveTrader(root, {
    onSubmit: async () => { throw new Error('fake accepted POST with lost response'); }
  });
  const server = makeServer(firstLive.trader, root);
  const ctx = await startRoutes(t, server);
  const key = 'live-bare-404-key';
  const first = await postJson(ctx, '/api/trade/buy', { coin: 'KRW-BTC', amount: 5000 }, key);
  assert.equal(first.status, 202);
  await ctx.close();

  const restartedLive = makeLiveTrader(root, {
    onSubmit: async () => { throw new Error('retry must never POST'); },
    getOrder: async () => {
      throw Object.assign(new Error('order_not_found'), { response: { status: 404 } });
    }
  });
  const restartedServer = makeServer(restartedLive.trader, root, {
    storePath: server.manualOrderIdempotencyStore.filePath
  });
  const restartedCtx = await startRoutes(t, restartedServer);
  const retry = await postJson(restartedCtx, '/api/trade/buy',
    { coin: 'KRW-BTC', amount: 5000 }, key);
  assert.equal(retry.status, 202);
  assert.equal(retry.body.idempotency.status, 'unknown');
  assert.equal(restartedLive.counts.submits, 0);
  assert.equal(restartedLive.counts.orderReadbacks, 1);
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

test('multi-leg leg intents bind one exchange identifier per leg durably and reject conflicts', async t => {
  const root = makeRoot(t);
  const filePath = path.join(root, 'journal.json');
  const writerLockPath = path.join(root, 'writer.lock');
  const store = new ManualOrderIdempotencyStore({ filePath, writerLockPath });
  t.after(() => { try { store.releaseWriterLock(); } catch { /* cleanup */ } });

  const reservation = await store.reserve({
    profileId: 'operator',
    idempotencyKey: 'leg-intent-unit',
    method: 'POST',
    endpoint: '/api/trade/execute-bundle',
    body: { sellCoin: 'KRW-BTC', buyCoin: 'KRW-ETH' },
    mode: 'LIVE',
    clientIntentId: randomUUID()
  });
  assert.equal(reservation.kind, 'reserved');
  const recordId = reservation.record.recordId;
  const sellIntent = randomUUID();
  const buyIntent = randomUUID();

  const attachedSell = await store.attachLegIntent(recordId, 'sell', sellIntent);
  assert.equal(attachedSell.legIntents.sell, sellIntent);
  const idempotent = await store.attachLegIntent(recordId, 'sell', sellIntent);
  assert.equal(idempotent.legIntents.sell, sellIntent);
  await store.attachLegIntent(recordId, 'buy', buyIntent);

  await assert.rejects(() => store.attachLegIntent(recordId, 'sell', randomUUID()), /already recorded/);
  await assert.rejects(() => store.attachLegIntent(recordId, 'sell', 'not-a-uuid'));
  await assert.rejects(() => store.attachLegIntent(recordId, '', randomUUID()));

  store.releaseWriterLock();
  const reloaded = new ManualOrderIdempotencyStore({ filePath, writerLockPath });
  t.after(() => { try { reloaded.releaseWriterLock(); } catch { /* cleanup */ } });
  await reloaded.initialize();
  const reloadedRecord = reloaded.getRecord(recordId);
  assert.equal(reloadedRecord.legIntents.sell, sellIntent);
  assert.equal(reloadedRecord.legIntents.buy, buyIntent);
  assert.equal(reloadedRecord.state, 'unknown', 'a pending LIVE request reloads as unknown');

  await reloaded.completeRecovered(recordId, { status: 200, body: { success: true } });
  await assert.rejects(() => reloaded.attachLegIntent(recordId, 'buy2', randomUUID()), /cannot attach/);
});

test('LIVE bundle records a fresh exchange identifier per leg before dispatch', async t => {
  const root = makeRoot(t);
  let server = null;
  const observedAtPost = [];
  const live = makeLiveTrader(root, {
    onSubmit: async (market, side, _volume, _price, _orderType, clientIntentId) => {
      const record = [...server.manualOrderIdempotencyStore.records.values()][0];
      const leg = side === 'ask' ? 'sell' : 'buy';
      observedAtPost.push({ leg, recorded: record?.legIntents?.[leg] === clientIntentId });
      throw new Error('fake accepted POST with lost response');
    },
    getOrder: async () => null
  });
  server = makeServer(live.trader, root);
  const ctx = await startRoutes(t, server);
  const result = await postJson(ctx, '/api/trade/execute-bundle', {
    sellCoin: 'KRW-BTC',
    buyCoin: 'KRW-ETH',
    buyAmount: 6000
  }, 'bundle-leg-durable-before-post');

  assert.equal(result.status, 202);
  assert.equal(result.idempotencyStatus, 'unknown');
  assert.deepEqual(observedAtPost, [{ leg: 'sell', recorded: true }]);
  const record = [...server.manualOrderIdempotencyStore.records.values()][0];
  assert.deepEqual(Object.keys(record.legIntents || {}), ['sell']);
  assert.notEqual(record.legIntents.sell, record.clientIntentId);
  assert.equal(live.counts.submits, 1);
});

test('LIVE bundle retry resolves each journaled leg by identifier without another POST', async t => {
  const root = makeRoot(t);
  let sellIntentId = null;
  let buyIntentId = null;
  const sellOrder = () => makeExchangeOrder(sellIntentId, 'KRW-BTC', 'ask');
  const live = makeLiveTrader(root, {
    onSubmit: async (market, side, _volume, _price, _orderType, clientIntentId) => {
      if (side === 'ask') {
        sellIntentId = clientIntentId;
        return { success: true, data: { uuid: sellOrder().uuid } };
      }
      buyIntentId = clientIntentId;
      throw new Error('fake accepted buy POST with lost response');
    },
    getOrder: async () => null
  });
  live.trader.waitForLiveOrderFill = async () => ({ filled: true, order: sellOrder() });
  const server = makeServer(live.trader, root);
  const ctx = await startRoutes(t, server);
  const body = { sellCoin: 'KRW-BTC', buyCoin: 'KRW-ETH', buyAmount: 6000 };
  const key = 'bundle-two-leg-recovery';
  const first = await postJson(ctx, '/api/trade/execute-bundle', body, key);

  assert.equal(first.status, 202);
  assert.equal(first.idempotencyStatus, 'unknown');
  const record = [...server.manualOrderIdempotencyStore.records.values()][0];
  assert.equal(record.state, 'unknown');
  assert.deepEqual(Object.keys(record.legIntents || {}), ['sell', 'buy']);
  assert.equal(record.legIntents.sell, sellIntentId);
  assert.equal(record.legIntents.buy, buyIntentId);
  assert.notEqual(record.legIntents.sell, record.legIntents.buy);
  assert.notEqual(record.legIntents.sell, record.clientIntentId);
  assert.equal(live.counts.submits, 2);
  await ctx.close();

  const orderLookups = [];
  const restartedLive = makeLiveTrader(root, {
    onSubmit: async () => { throw new Error('retry must never POST'); },
    getOrder: async (identifier, options) => {
      orderLookups.push(identifier);
      assert.deepEqual(options, { identifier: true });
      if (identifier === sellIntentId) return { ...sellOrder() };
      if (identifier === buyIntentId) {
        throw Object.assign(new Error('order_not_found'), { response: { status: 404 } });
      }
      return null;
    }
  });
  const restartedServer = makeServer(restartedLive.trader, root, {
    storePath: server.manualOrderIdempotencyStore.filePath
  });
  const restartedCtx = await startRoutes(t, restartedServer);
  const recovered = await postJson(restartedCtx, '/api/trade/execute-bundle', body, key);

  assert.equal(recovered.status, 200);
  assert.equal(recovered.idempotencyStatus, 'completed');
  assert.equal(recovered.body.recovered, true);
  assert.equal(recovered.body.success, false);
  assert.equal(recovered.body.partial, true);
  assert.deepEqual(orderLookups, [sellIntentId, buyIntentId]);
  const sellLeg = recovered.body.legs.find(leg => leg.leg === 'sell');
  const buyLeg = recovered.body.legs.find(leg => leg.leg === 'buy');
  assert.equal(sellLeg.outcome, 'filled');
  assert.equal(sellLeg.order.state, 'done');
  assert.equal(buyLeg.outcome, 'not_dispatched');
  assert.equal(buyLeg.fill.status, 'not_observed');
  assert.equal(recovered.body.settlement.status, 'not_observed');
  assert.equal(recovered.body.strategyState.status, 'not_mutated');
  assert.equal(restartedLive.counts.submits, 0);
  assert.equal(restartedLive.counts.strategyMutations, 0);

  const replay = await postJson(restartedCtx, '/api/trade/execute-bundle', body, key);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, recovered.body);
  assert.equal(restartedLive.counts.orderReadbacks, 2, 'the completed response replays without another exchange GET');
});

test('LIVE bundle retry stays unknown while a journaled leg is still non-terminal', async t => {
  const root = makeRoot(t);
  let sellIntentId = null;
  let buyIntentId = null;
  const sellOrder = () => makeExchangeOrder(sellIntentId, 'KRW-BTC', 'ask');
  const live = makeLiveTrader(root, {
    onSubmit: async (market, side, _volume, _price, _orderType, clientIntentId) => {
      if (side === 'ask') {
        sellIntentId = clientIntentId;
        return { success: true, data: { uuid: sellOrder().uuid } };
      }
      buyIntentId = clientIntentId;
      throw new Error('fake accepted buy POST with lost response');
    },
    getOrder: async () => null
  });
  live.trader.waitForLiveOrderFill = async () => ({ filled: true, order: sellOrder() });
  const server = makeServer(live.trader, root);
  const ctx = await startRoutes(t, server);
  const body = { sellCoin: 'KRW-BTC', buyCoin: 'KRW-ETH', buyAmount: 6000 };
  const key = 'bundle-open-leg-recovery';
  const first = await postJson(ctx, '/api/trade/execute-bundle', body, key);
  assert.equal(first.status, 202);
  await ctx.close();

  const restartedLive = makeLiveTrader(root, {
    onSubmit: async () => { throw new Error('retry must never POST'); },
    getOrder: async (identifier) => {
      if (identifier === sellIntentId) return { ...sellOrder() };
      if (identifier === buyIntentId) {
        return makeExchangeOrder(buyIntentId, 'KRW-ETH', 'bid', {
          state: 'wait',
          executed_volume: '0',
          remaining_volume: '0.4'
        });
      }
      return null;
    }
  });
  const restartedServer = makeServer(restartedLive.trader, root, {
    storePath: server.manualOrderIdempotencyStore.filePath
  });
  const restartedCtx = await startRoutes(t, restartedServer);
  const retry = await postJson(restartedCtx, '/api/trade/execute-bundle', body, key);

  assert.equal(retry.status, 202);
  assert.equal(retry.idempotencyStatus, 'unknown');
  assert.equal(restartedLive.counts.submits, 0);
  const record = [...restartedServer.manualOrderIdempotencyStore.records.values()][0];
  assert.equal(record.state, 'unknown');
  assert.equal(record.legIntents.sell, sellIntentId);
  assert.equal(record.legIntents.buy, buyIntentId);
});
