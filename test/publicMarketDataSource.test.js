import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import DashboardServer from '../src/api/dashboardServer.js';
import {
  createPublicMarketDataSource,
  isPublicMarketDataSource
} from '../src/api/publicMarketDataSource.js';
import { readCurrentMarketPrices } from '../src/api/marketValuation.js';
import { getMarketDataProvider, MARKET_DATA_FRESHNESS } from '../src/api/marketDataProvider.js';
import createMarketRoutes from '../src/api/routes/market.js';
import { UpbitMarketDataAdapter } from '../src/market-data/marketDataAdapters.js';
import UpbitAPI from '../src/api/upbit.js';
import { sharedUpbitRequestScheduler } from '../src/api/upbitRequestScheduler.js';
import { PublicMarketSnapshotStore } from '../src/api/publicMarketSnapshotStore.js';

const sourceAsOf = '2026-09-29T12:00:00.000Z';

function dispatchGet(router, url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url, 'http://localhost');
    const req = {
      method: 'GET',
      url,
      originalUrl: url,
      baseUrl: '',
      headers: {},
      params: {},
      query: Object.fromEntries(parsedUrl.searchParams.entries()),
      get(name) { return this.headers[name.toLowerCase()]; }
    };
    const res = {
      statusCode: 200,
      headers: {},
      status(statusCode) {
        this.statusCode = statusCode;
        return this;
      },
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
        return this;
      },
      json(body) {
        resolve({ statusCode: this.statusCode, body, headers: this.headers });
        return this;
      }
    };

    router.handle(req, res, error => error ? reject(error) : resolve(null));
  });
}

test('the public source creates a blank-credential Upbit client on the shared scheduler', async t => {
  const methodNames = ['getMarkets', 'getTicker', 'getMinuteCandles'];
  const descriptors = new Map(methodNames.map(name => [
    name,
    Object.getOwnPropertyDescriptor(UpbitAPI.prototype, name)
  ]));
  const observed = [];
  const results = {
    getMarkets: [{ market: 'KRW-BTC' }],
    getTicker: [{ market: 'KRW-BTC' }],
    getMinuteCandles: [{ market: 'KRW-BTC' }]
  };

  for (const name of methodNames) {
    UpbitAPI.prototype[name] = async function (...args) {
      observed.push({
        name,
        args,
        accessKey: this.accessKey,
        secretKey: this.secretKey,
        scheduler: this.scheduler
      });
      return results[name];
    };
  }
  t.after(() => {
    for (const [name, descriptor] of descriptors) {
      Object.defineProperty(UpbitAPI.prototype, name, descriptor);
    }
  });

  const source = createPublicMarketDataSource();
  assert.equal(isPublicMarketDataSource(source), true);
  assert.deepEqual(
    Object.getOwnPropertyNames(Object.getPrototypeOf(source)).sort(),
    ['constructor', ...methodNames, 'getLastGoodTickerSnapshot', 'getCachedTickerSnapshot', 'getSnapshotStoreStatus', 'flushSnapshot', 'close'].sort()
  );
  assert.equal('getAccounts' in source, false);
  assert.equal('placeOrder' in source, false);
  assert.equal('getOrders' in source, false);
  assert.equal('getOrderChance' in source, false);

  assert.deepEqual(await source.getMarkets(), results.getMarkets);
  assert.deepEqual(await source.getTicker(['KRW-BTC']), results.getTicker);
  assert.deepEqual(await source.getMinuteCandles('KRW-BTC', 1, 2), results.getMinuteCandles);

  assert.deepEqual(observed.map(({ name, args }) => ({ name, args })), [
    { name: 'getMarkets', args: [] },
    { name: 'getTicker', args: [['KRW-BTC']] },
    { name: 'getMinuteCandles', args: ['KRW-BTC', 1, 2] }
  ]);
  assert.equal(observed.every(({ accessKey, secretKey }) => accessKey === '' && secretKey === ''), true);
  assert.equal(observed.every(({ scheduler }) => scheduler === sharedUpbitRequestScheduler), true);
});

test('public source records normal ticker reads but does not delay or persist priority risk reads', async t => {
  const original = Object.getOwnPropertyDescriptor(UpbitAPI.prototype, 'getTicker');
  const observedOptions = [];
  UpbitAPI.prototype.getTicker = async function (markets, options = {}) {
    observedOptions.push(options);
    return [{
      market: Array.isArray(markets) ? markets[0] : markets,
      trade_price: 100,
      trade_timestamp: Date.now()
    }];
  };
  t.after(() => Object.defineProperty(UpbitAPI.prototype, 'getTicker', original));

  const recorded = [];
  const store = {
    recordTickers(rows, fetchedAt) { recorded.push({ rows, fetchedAt }); },
    getTickerSnapshot(markets) { return { markets }; },
    getCachedTickerSnapshot(markets) { return { markets }; },
    flush() { return Promise.resolve({ dirty: false }); },
    close() { return Promise.resolve({ dirty: false }); }
  };
  const source = createPublicMarketDataSource({ snapshotStore: store });

  await source.getTicker(['KRW-BTC']);
  await source.getTicker(['KRW-BTC'], { priority: 'risk' });

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].rows[0].market, 'KRW-BTC');
  assert.equal(typeof recorded[0].fetchedAt, 'string');
  assert.deepEqual(source.getLastGoodTickerSnapshot(['KRW-BTC']), { markets: ['KRW-BTC'] });
  await source.flushSnapshot();
  await source.close();
  assert.deepEqual(observedOptions, [{}, { priority: 'risk' }]);
});

test('dashboard cached reads reuse the source snapshot while fresh reads still hit Upbit', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-market-capture-reuse-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new PublicMarketSnapshotStore({
    filePath: path.join(directory, 'market_snapshot.json'),
    persistIntervalMs: 60_000
  });
  const originalGetTicker = Object.getOwnPropertyDescriptor(UpbitAPI.prototype, 'getTicker');
  let upstreamReads = 0;
  UpbitAPI.prototype.getTicker = async function (markets) {
    upstreamReads += 1;
    const requested = Array.isArray(markets) ? markets : [markets];
    return requested.map(market => ({
      market,
      trade_price: 100,
      trade_timestamp: Date.now(),
      signed_change_rate: 0
    }));
  };
  t.after(() => Object.defineProperty(UpbitAPI.prototype, 'getTicker', originalGetTicker));

  const source = createPublicMarketDataSource({ snapshotStore: store });
  const dashboard = Object.create(DashboardServer.prototype);
  Object.assign(dashboard, {
    publicMarketDataSource: source,
    tradingSystem: { maxCandleAgeSeconds: 90 },
    cache: new Map(),
    cacheTTL: { ticker: 1000 },
    inFlightTickerRequests: new Map()
  });

  const strategyTickers = await source.getTicker(['KRW-BTC']);
  const cachedSnapshot = await dashboard.getCachedTickerWithMetadata(['KRW-BTC']);
  assert.equal(strategyTickers[0].trade_price, 100);
  assert.equal(cachedSnapshot.snapshotSource, 'collector_cache');
  assert.equal(typeof cachedSnapshot.fetchedAtByMarket['KRW-BTC'], 'string');
  assert.equal(upstreamReads, 1, 'the Dashboard cache reader reuses the recent strategy observation');

  const freshTickers = await getMarketDataProvider(dashboard).getTickers(['KRW-BTC'], {
    freshness: MARKET_DATA_FRESHNESS.FRESH
  });
  assert.equal(freshTickers[0].trade_price, 100);
  assert.equal(upstreamReads, 2, 'the explicit fresh-read contract bypasses the collector cache');
  await source.close();
});

test('dashboard serves a persisted last-good quote on cached reads but never on fresh reads', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-last-good-dashboard-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'market_snapshot.json');
  const fetchedAt = Date.now() - 10_000;
  const saved = new PublicMarketSnapshotStore({ filePath, persistIntervalMs: 60_000 });
  saved.recordTickers([{
    market: 'KRW-BTC',
    trade_price: 100,
    trade_timestamp: Date.now() - 20_000
  }], fetchedAt);
  await saved.flush();
  await saved.close();

  const source = createPublicMarketDataSource({
    snapshotStore: new PublicMarketSnapshotStore({ filePath })
  });
  const originalGetTicker = Object.getOwnPropertyDescriptor(UpbitAPI.prototype, 'getTicker');
  UpbitAPI.prototype.getTicker = async () => {
    const error = new Error('synthetic public quote outage');
    error.code = 'ENETDOWN';
    throw error;
  };
  t.after(() => Object.defineProperty(UpbitAPI.prototype, 'getTicker', originalGetTicker));

  const dashboard = Object.create(DashboardServer.prototype);
  Object.assign(dashboard, {
    publicMarketDataSource: source,
    tradingSystem: {},
    cache: new Map(),
    cacheTTL: { ticker: 1000 },
    inFlightTickerRequests: new Map()
  });

  const cached = await dashboard.getCachedTickerWithMetadata(['KRW-BTC']);
  assert.equal(cached.snapshotSource, 'last_good');
  assert.equal(cached.fallbackReason, 'ENETDOWN');
  assert.equal(cached.tickers[0].trade_price, 100);
  assert.equal(cached.fetchedAt, new Date(fetchedAt).toISOString());

  await assert.rejects(
    () => getMarketDataProvider(dashboard).getTickers(['KRW-BTC'], {
      freshness: MARKET_DATA_FRESHNESS.FRESH
    }),
    /synthetic public quote outage/
  );
  await source.close();
});

test('the shared public reader singleflights identical ticker and candle reads without caching them', async t => {
  const originals = new Map(['getTicker', 'getMinuteCandles'].map(name => [
    name,
    Object.getOwnPropertyDescriptor(UpbitAPI.prototype, name)
  ]));
  const tickerCalls = [];
  const tickerResolvers = [];
  const candleCalls = [];
  const candleResolvers = [];
  UpbitAPI.prototype.getTicker = function (markets, options = {}) {
    tickerCalls.push({ markets, options, accessKey: this.accessKey, secretKey: this.secretKey });
    return new Promise(resolve => tickerResolvers.push(resolve));
  };
  UpbitAPI.prototype.getMinuteCandles = function (...args) {
    candleCalls.push({ args, accessKey: this.accessKey, secretKey: this.secretKey });
    return new Promise(resolve => candleResolvers.push(resolve));
  };
  t.after(() => {
    for (const [name, descriptor] of originals) {
      Object.defineProperty(UpbitAPI.prototype, name, descriptor);
    }
  });

  const source = createPublicMarketDataSource();
  const requestedMarkets = ['KRW-BTC'];
  const firstTickerRead = source.getTicker(requestedMarkets);
  requestedMarkets[0] = 'KRW-ETH';
  const overlappingTickerRead = source.getTicker(['KRW-BTC']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(tickerCalls.length, 1, 'matching ticker reads should share the same in-flight upstream request');
  assert.deepEqual(tickerCalls[0].markets, ['KRW-BTC'], 'the upstream call must use the same immutable args as the single-flight key');
  tickerResolvers.shift()([{ market: 'KRW-BTC', trade_price: 123, market_event: { warning: 'stable' } }]);
  const [firstTickers, secondTickers] = await Promise.all([firstTickerRead, overlappingTickerRead]);
  assert.notStrictEqual(firstTickers, secondTickers);
  assert.notStrictEqual(firstTickers[0], secondTickers[0]);
  firstTickers[0].trade_price = 0;
  firstTickers[0].market_event.warning = 'changed by one caller';
  assert.equal(secondTickers[0].trade_price, 123, 'callers must not mutate another consumer’s rows');
  assert.equal(secondTickers[0].market_event.warning, 'stable', 'nested JSON rows are isolated too');

  const normalTicker = source.getTicker(['KRW-BTC'], { priority: 'normal' });
  const riskTicker = source.getTicker(['KRW-BTC'], { priority: 'risk' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(tickerCalls.length, 3, 'different priority lanes must not be merged');
  tickerResolvers.shift()([{ market: 'KRW-BTC', trade_price: 124 }]);
  tickerResolvers.shift()([{ market: 'KRW-BTC', trade_price: 125 }]);
  await Promise.all([normalTicker, riskTicker]);

  const cursor = '2026-09-30T12:00:00.000Z';
  const firstCandleRead = source.getMinuteCandles('KRW-BTC', 1, 60, { to: cursor });
  const overlappingCandleRead = source.getMinuteCandles('KRW-BTC', 1, 60, { to: cursor });
  const nextPage = source.getMinuteCandles('KRW-BTC', 1, 60, { to: '2026-09-30T11:00:00.000Z' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(candleCalls.length, 2, 'matching pages share one read while a different cursor remains independent');
  assert.equal(candleCalls.every(call => call.accessKey === '' && call.secretKey === ''), true,
    'all shared-source calls must use the credential-free reader');
  candleResolvers.shift()([{ market: 'KRW-BTC', trade_price: 1 }]);
  candleResolvers.shift()([{ market: 'KRW-BTC', trade_price: 2 }]);
  await Promise.all([firstCandleRead, overlappingCandleRead, nextPage]);

  const mutableCursor = { to: cursor };
  const originalCursorRead = source.getMinuteCandles('KRW-BTC', 1, 60, mutableCursor);
  mutableCursor.to = '2026-09-30T10:00:00.000Z';
  const matchingCursorRead = source.getMinuteCandles('KRW-BTC', 1, 60, { to: cursor });
  const changedCursorRead = source.getMinuteCandles('KRW-BTC', 1, 60, { to: mutableCursor.to });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(candleCalls.length, 4, 'cursor mutation cannot change a keyed request or merge a different page');
  assert.deepEqual(candleCalls.slice(-2).map(call => call.args[3].to), [cursor, mutableCursor.to]);
  candleResolvers.shift()([{ market: 'KRW-BTC', trade_price: 3 }]);
  candleResolvers.shift()([{ market: 'KRW-BTC', trade_price: 4 }]);
  await Promise.all([originalCursorRead, matchingCursorRead, changedCursorRead]);

  const strategyAdapter = new UpbitMarketDataAdapter(source);
  const dashboardProvider = getMarketDataProvider({ publicMarketDataSource: source });
  const strategyCandleRead = strategyAdapter.getMinuteCandles('KRW-BTC', 1, 30);
  const dashboardCandleRead = dashboardProvider.getMinuteCandles('KRW-BTC', 1, 30);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(candleCalls.length, 5, 'strategy and dashboard defaults should share the same in-flight candle request');
  assert.equal(candleCalls[4].args.length, 3, 'an empty default-options object is normalized away');
  candleResolvers.shift()([{ market: 'KRW-BTC', trade_price: 5 }]);
  await Promise.all([strategyCandleRead, dashboardCandleRead]);
});

test('a failed public read clears its single-flight entry so a later call retries', async t => {
  const original = Object.getOwnPropertyDescriptor(UpbitAPI.prototype, 'getMarkets');
  let calls = 0;
  UpbitAPI.prototype.getMarkets = function () {
    calls += 1;
    return calls === 1
      ? Promise.reject(new Error('temporary public read failure'))
      : Promise.resolve([{ market: 'KRW-BTC' }]);
  };
  t.after(() => Object.defineProperty(UpbitAPI.prototype, 'getMarkets', original));

  const source = createPublicMarketDataSource();
  await assert.rejects(source.getMarkets(), /temporary public read failure/);
  assert.deepEqual(await source.getMarkets(), [{ market: 'KRW-BTC' }]);
  assert.equal(calls, 2);
});

test('only factory-created credential-free readers pass the public-source brand check', () => {
  assert.equal(isPublicMarketDataSource({
    getMarkets() {},
    getTicker() {},
    getMinuteCandles() {}
  }), false);
  assert.equal(isPublicMarketDataSource(null), false);
  assert.equal(isPublicMarketDataSource(createPublicMarketDataSource({ requestTimeoutMs: 2500 })), true);
});

test('dashboard routes and account valuation use the injected source and preserve ticker cache metadata', async () => {
  const originalDateNow = Date.now;
  let now = originalDateNow();
  Date.now = () => now;
  let dashboard = null;

  const traderCalls = [];
  const forbiddenTraderRead = name => (...args) => {
    traderCalls.push({ name, args });
    throw new Error(`trader-owned ${name} must not be used for dashboard market data`);
  };
  const adapter = {
    getMarkets: forbiddenTraderRead('adapter.getMarkets'),
    getTickers: forbiddenTraderRead('adapter.getTickers'),
    getMinuteCandles: forbiddenTraderRead('adapter.getMinuteCandles')
  };
  const trader = {
    config: {},
    marketDataAdapter: adapter,
    upbit: {
      getMarkets: forbiddenTraderRead('upbit.getMarkets'),
      getTicker: forbiddenTraderRead('upbit.getTicker'),
      getMinuteCandles: forbiddenTraderRead('upbit.getMinuteCandles'),
      getAccounts: forbiddenTraderRead('upbit.getAccounts'),
      getOrders: forbiddenTraderRead('upbit.getOrders'),
      getOrder: forbiddenTraderRead('upbit.getOrder'),
      getOrderChance: forbiddenTraderRead('upbit.getOrderChance'),
      placeOrder: forbiddenTraderRead('upbit.placeOrder'),
      cancelOrder: forbiddenTraderRead('upbit.cancelOrder')
    }
  };

  let marketReads = 0;
  let tickerReads = 0;
  let candleReads = 0;
  let releaseFirstTicker;
  const source = {
    async getMarkets() {
      marketReads += 1;
      return [{ market: 'KRW-BTC' }];
    },
    getTicker(markets) {
      const sequence = ++tickerReads;
      assert.deepEqual(Array.isArray(markets) ? markets : [markets], ['KRW-BTC']);
      const payload = [{
        market: 'KRW-BTC',
        trade_price: 100 + sequence,
        signed_change_rate: 0.01,
        signed_change_price: 1,
        high_price: 102,
        low_price: 99,
        acc_trade_volume_24h: 12,
        acc_trade_price_24h: 1200,
        trade_timestamp: Date.parse(sourceAsOf)
      }];
      if (sequence === 1) {
        return new Promise(resolve => { releaseFirstTicker = () => resolve(payload); });
      }
      return Promise.resolve(payload);
    },
    async getMinuteCandles(market, unit, count) {
      candleReads += 1;
      assert.deepEqual([market, unit, count], ['KRW-BTC', 1, 2]);
      return [
        {
          candle_date_time_kst: '2026-09-29T21:02:00', opening_price: 102,
          high_price: 104, low_price: 101, trade_price: 103, candle_acc_trade_volume: 12
        },
        {
          candle_date_time_kst: '2026-09-29T21:01:00', opening_price: 100,
          high_price: 103, low_price: 99, trade_price: 102, candle_acc_trade_volume: 10
        }
      ];
    }
  };

  try {
    dashboard = new DashboardServer(trader, 0, {
      env: { ...process.env, DASHBOARD_TOKEN: '', DASHBOARD_READ_ONLY_TOKEN: '', DASHBOARD_MOBILE_TOKEN: '' },
      publicMarketDataSource: source
    });
    assert.strictEqual(dashboard.publicMarketDataSource, source);
    assert.equal(dashboard.cacheTTL.ticker, 1000);

    const router = createMarketRoutes(dashboard);
    const marketList = await dispatchGet(router, '/target-coins');
    assert.equal(marketList.statusCode, 200);
    assert.deepEqual(marketList.body.coins, ['KRW-BTC']);
    assert.equal(marketReads, 1);

    const first = dashboard.getCachedTickerWithMetadata(['KRW-BTC']);
    const second = dashboard.getCachedTickerWithMetadata(['KRW-BTC']);
    await Promise.resolve();
    assert.equal(tickerReads, 1, 'concurrent cache misses should share one source read');
    releaseFirstTicker();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.strictEqual(firstResult, secondResult);
    assert.equal(firstResult.tickers[0].trade_price, 101);
    assert.match(firstResult.fetchedAt, /^\d{4}-\d\d-\d\dT/);

    const cachedRoutePrices = await dispatchGet(router, '/market/prices');
    assert.equal(cachedRoutePrices.statusCode, 200);
    assert.equal(cachedRoutePrices.body[0].price, 101);
    assert.equal(cachedRoutePrices.body[0].fetchedAt, firstResult.fetchedAt);
    assert.equal(tickerReads, 1, 'cached route should reuse the one-second dashboard cache');

    const accountQuote = await readCurrentMarketPrices(dashboard, ['KRW-BTC']);
    assert.equal(accountQuote.priceMap.get('KRW-BTC'), 101);
    assert.equal(accountQuote.sourceAsOfByMarket.get('KRW-BTC'), sourceAsOf);
    assert.equal(accountQuote.fetchedAt, firstResult.fetchedAt);

    const freshTickers = await dashboard.marketDataProvider.getTickers('KRW-BTC', {
      freshness: MARKET_DATA_FRESHNESS.FRESH
    });
    assert.equal(freshTickers[0].trade_price, 102);
    assert.equal(tickerReads, 2, 'fresh reads should use the same source and bypass the ticker cache');

    now += 1001;
    const expiredTickerCache = await dashboard.getCachedTickerWithMetadata(['KRW-BTC']);
    assert.equal(expiredTickerCache.tickers[0].trade_price, 103);
    assert.equal(tickerReads, 3, 'the one-second ticker cache should expire');

    const candleRoute = await dispatchGet(router, '/market/candles/KRW-BTC?unit=1&count=2');
    assert.equal(candleRoute.statusCode, 200);
    assert.deepEqual(candleRoute.body.map(candle => candle.close), [102, 103]);
    assert.equal(candleReads, 1);
    assert.deepEqual(traderCalls, []);
  } finally {
    Date.now = originalDateNow;
    if (dashboard) await dashboard.stop();
  }
});

test('coin detail and bundle suggestions read from the injected source without a trader Upbit client', async () => {
  const privateCalls = [];
  const forbiddenPrivateOperation = name => () => {
    privateCalls.push(name);
    throw new Error(`private trader operation ${name} must not be called`);
  };
  const trader = {
    config: {},
    dryRun: true,
    virtualPortfolio: {
      holdings: new Map([['KRW-BTC', { amount: 1, avgPrice: 90 }]]),
      krwBalance: 1_000
    },
    getAccountInfo: forbiddenPrivateOperation('getAccountInfo'),
    getOrders: forbiddenPrivateOperation('getOrders'),
    placeOrder: forbiddenPrivateOperation('placeOrder'),
    executeOrder: forbiddenPrivateOperation('executeOrder')
  };
  const sourceCalls = [];
  const source = {
    async getMarkets() {
      sourceCalls.push('markets');
      return [{ market: 'KRW-ETH' }];
    },
    async getTicker(markets) {
      sourceCalls.push(['ticker', markets]);
      return [{
        market: 'KRW-BTC', trade_price: 101, signed_change_rate: 0.01,
        high_price: 102, low_price: 99, acc_trade_price_24h: 100_000,
        trade_timestamp: Date.now()
      }];
    },
    async getMinuteCandles(market, unit, count) {
      sourceCalls.push(['candles', market, unit, count]);
      return [{ candle_date_time_kst: '2026-09-29T21:02:00' }];
    }
  };
  const dashboard = new DashboardServer(trader, 0, {
    env: { ...process.env, DASHBOARD_TOKEN: '', DASHBOARD_READ_ONLY_TOKEN: '', DASHBOARD_MOBILE_TOKEN: '' },
    publicMarketDataSource: source
  });

  try {
    assert.equal('upbit' in trader, false);
    // coin-detail now lives inside the mounted status router — search router
    // sub-stacks for a layer whose route path matches under the /api mount.
    const findRouteLayer = (stack, wantPath) => {
      for (const layer of stack) {
        if (layer.route?.path === wantPath) return layer;
        const inner = layer.handle?.stack;
        if (Array.isArray(inner)) {
          const hit = inner.find(innerLayer =>
            innerLayer.route?.path === wantPath || innerLayer.route?.path === wantPath.replace('/api', ''));
          if (hit) return hit;
        }
      }
      return null;
    };
    const routeLayer = findRouteLayer(dashboard.app._router.stack, '/coin-detail/:coin');
    assert.ok(routeLayer, 'coin-detail route should be registered');
    const routeHandler = routeLayer.route.stack.find(layer => layer.method === 'get')?.handle;
    assert.equal(typeof routeHandler, 'function');

    let response;
    const res = {
      statusCode: 200,
      status(statusCode) {
        this.statusCode = statusCode;
        return this;
      },
      json(body) {
        response = { statusCode: this.statusCode, body };
        return this;
      }
    };
    await routeHandler({ params: { coin: 'KRW-BTC' } }, res);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.currentPrice, 101);
    assert.deepEqual(sourceCalls, [
      ['ticker', ['KRW-BTC']],
      ['candles', 'KRW-BTC', 5, 50]
    ]);

    const bundles = await dashboard.generateBundleSuggestions();
    assert.deepEqual(bundles, []);
    assert.deepEqual(sourceCalls.slice(2), [
      ['ticker', ['KRW-BTC']],
      ['candles', 'KRW-BTC', 5, 50]
    ]);
    assert.deepEqual(privateCalls, []);
  } finally {
    await dashboard.stop();
  }
});
