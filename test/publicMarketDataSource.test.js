import assert from 'node:assert/strict';
import test from 'node:test';
import DashboardServer from '../src/api/dashboardServer.js';
import { createPublicMarketDataSource } from '../src/api/publicMarketDataSource.js';
import { readCurrentMarketPrices } from '../src/api/marketValuation.js';
import { MARKET_DATA_FRESHNESS } from '../src/api/marketDataProvider.js';
import createMarketRoutes from '../src/api/routes/market.js';
import UpbitAPI from '../src/api/upbit.js';
import { sharedUpbitRequestScheduler } from '../src/api/upbitRequestScheduler.js';

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
  assert.deepEqual(
    Object.getOwnPropertyNames(Object.getPrototypeOf(source)).sort(),
    ['constructor', ...methodNames].sort()
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
      env: { ...process.env, DASHBOARD_TOKEN: '', DASHBOARD_READ_ONLY_TOKEN: '' },
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
        trade_timestamp: Date.parse(sourceAsOf)
      }];
    },
    async getMinuteCandles(market, unit, count) {
      sourceCalls.push(['candles', market, unit, count]);
      return [{ candle_date_time_kst: '2026-09-29T21:02:00' }];
    }
  };
  const dashboard = new DashboardServer(trader, 0, {
    env: { ...process.env, DASHBOARD_TOKEN: '', DASHBOARD_READ_ONLY_TOKEN: '' },
    publicMarketDataSource: source
  });

  try {
    assert.equal('upbit' in trader, false);
    const routeLayer = dashboard.app._router.stack.find(
      layer => layer.route?.path === '/api/coin-detail/:coin'
    );
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
      ['ticker', 'KRW-BTC'],
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
