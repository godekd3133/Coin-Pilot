import assert from 'node:assert/strict';
import test from 'node:test';
import createMarketRoutes from '../src/api/routes/market.js';
import {
  MarketDataProvider,
  MARKET_DATA_FRESHNESS,
  UpbitCacheMarketDataProvider
} from '../src/api/marketDataProvider.js';
import { FixtureMarketDataAdapter } from '../src/market-data/marketDataAdapters.js';

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

    router.handle(req, res, error => {
      if (error) reject(error);
      else reject(new Error(`No route matched ${url}`));
    });
  });
}

test('/api/market/prices keeps its array body and adds nullable source/fetch metadata per row', async () => {
  const sourceAsOf = '2026-09-29T12:00:00.000Z';
  const fetchedAt = '2026-09-29T12:00:01.000Z';
  const tickers = [
    {
      market: 'KRW-BTC', trade_price: 100, signed_change_rate: 0.01,
      signed_change_price: 1, high_price: 101, low_price: 98,
      acc_trade_volume_24h: 12, acc_trade_price_24h: 1200,
      trade_timestamp: Date.parse(sourceAsOf)
    },
    {
      market: 'KRW-ETH', trade_price: 200, signed_change_rate: -0.02,
      signed_change_price: -4, high_price: 205, low_price: 198,
      acc_trade_volume_24h: 8, acc_trade_price_24h: 1600,
      trade_timestamp: 'malformed'
    }
  ];
  const server = {
    tradingSystem: {
      upbit: {
        async getMarkets() { return [{ market: 'KRW-BTC' }, { market: 'KRW-ETH' }]; }
      }
    },
    marketDataProvider: new MarketDataProvider({
      now: () => Date.parse(fetchedAt) + 1_000,
      async readMarkets() { return [{ market: 'KRW-BTC' }, { market: 'KRW-ETH' }]; },
      async readTickers(markets, { freshness }) {
        assert.deepEqual(markets, ['KRW-BTC', 'KRW-ETH']);
        assert.equal(freshness, 'cached');
        return { tickers, fetchedAt };
      }
    })
  };
  const result = await dispatchGet(createMarketRoutes(server), '/market/prices');

  assert.equal(result.statusCode, 200);
  assert.equal(Array.isArray(result.body), true);
  assert.equal(result.headers['x-market-list-stale'], 'false');
  assert.match(result.headers['x-market-list-fetched-at'], /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(result.body, [
    {
      coin: 'KRW-BTC', price: 100, change: 1, changePrice: 1, high: 101, low: 98,
      volume: 12, volumeKrw: 1200, sourceAsOf, fetchedAt,
      quoteFresh: true, quoteAgeMs: 2_000, quoteFreshnessReason: null
    },
    {
      coin: 'KRW-ETH', price: 200, change: -2, changePrice: -4, high: 205, low: 198,
      volume: 8, volumeKrw: 1600, sourceAsOf: null, fetchedAt,
      quoteFresh: false, quoteAgeMs: null, quoteFreshnessReason: 'market_quote_unavailable'
    }
  ]);
});

test('market routes use the selected fixture adapter for market list, prices, and candles', async () => {
  const newestFirstCandles = [
    {
      market: 'KRW-BTC', candle_date_time_kst: '2026-09-29T21:02:00', opening_price: 102,
      high_price: 104, low_price: 101, trade_price: 103, candle_acc_trade_volume: 12
    },
    {
      market: 'KRW-BTC', candle_date_time_kst: '2026-09-29T21:01:00', opening_price: 100,
      high_price: 103, low_price: 99, trade_price: 102, candle_acc_trade_volume: 10
    }
  ];
  const adapter = new FixtureMarketDataAdapter({
    markets: ['KRW-BTC'],
    tickers: [{
      market: 'KRW-BTC',
      trade_price: 103,
      signed_change_rate: 0,
      signed_change_price: 0,
      high_price: 104,
      low_price: 101,
      acc_trade_volume_24h: 12,
      acc_trade_price_24h: 1200,
      trade_timestamp: '2026-09-29T21:02:00.000Z'
    }],
    candleSets: [{ market: 'KRW-BTC', unit: 1, candles: newestFirstCandles }]
  });
  const server = {
    tradingSystem: {
      marketDataAdapter: adapter,
      upbit: {
        async getMarkets() { throw new Error('direct Upbit market-list read'); },
        async getTicker() { throw new Error('direct Upbit ticker read'); },
        async getMinuteCandles() { throw new Error('direct Upbit candle read'); }
      }
    }
  };
  server.marketDataProvider = new UpbitCacheMarketDataProvider(server);
  const router = createMarketRoutes(server);

  const marketList = await dispatchGet(router, '/target-coins');
  const prices = await dispatchGet(router, '/market/prices');
  const candles = await dispatchGet(router, '/market/candles/KRW-BTC?unit=1&count=2');

  assert.equal(marketList.statusCode, 200);
  assert.deepEqual(marketList.body.coins, ['KRW-BTC']);
  assert.equal(prices.statusCode, 200);
  assert.equal(prices.body[0].price, 103);
  assert.equal(prices.body[0].sourceAsOf, '2026-09-29T21:02:00.000Z');
  assert.equal(candles.statusCode, 200);
  assert.deepEqual(candles.body.map(candle => candle.close), [102, 103]);
});

test('/api/market/prices preserves its upstream failure status', async () => {
  const server = {
    tradingSystem: { upbit: { async getMarkets() { return [{ market: 'KRW-BTC' }]; } } },
    marketDataProvider: new MarketDataProvider({
      async readMarkets() { return [{ market: 'KRW-BTC' }]; },
      async readTickers() { throw new Error('ticker unavailable'); }
    })
  };
  const result = await dispatchGet(createMarketRoutes(server), '/market/prices');

  assert.equal(result.statusCode, 500);
  assert.deepEqual(result.body, { error: 'ticker unavailable' });
});

test('/api/market/candles keeps exchange rows in the existing reversed chart order and shape', async () => {
  const newestFirstCandles = [
    {
      candle_date_time_kst: '2026-09-29T21:02:00', opening_price: 102,
      high_price: 104, low_price: 101, trade_price: 103, candle_acc_trade_volume: 12
    },
    {
      candle_date_time_kst: '2026-09-29T21:01:00', opening_price: 100,
      high_price: 103, low_price: 99, trade_price: 102, candle_acc_trade_volume: 10
    }
  ];
  let candleArgs;
  const server = {
    tradingSystem: { upbit: {} },
    marketDataProvider: new MarketDataProvider({
      async readTickers() { return []; },
      async readCandles(...args) {
        candleArgs = args;
        return newestFirstCandles;
      }
    })
  };

  const result = await dispatchGet(createMarketRoutes(server), '/market/candles/KRW-BTC?unit=3&count=2');

  assert.equal(result.statusCode, 200);
  assert.deepEqual(candleArgs, ['KRW-BTC', 3, 2]);
  assert.deepEqual(result.body, [
    { time: '2026-09-29T21:01:00', timeUtc: '2026-09-29T12:01:00.000Z', open: 100, high: 103, low: 99, close: 102, volume: 10 },
    { time: '2026-09-29T21:02:00', timeUtc: '2026-09-29T12:02:00.000Z', open: 102, high: 104, low: 101, close: 103, volume: 12 }
  ]);
  assert.equal(newestFirstCandles[0].candle_date_time_kst, '2026-09-29T21:02:00');
  assert.equal(newestFirstCandles[1].candle_date_time_kst, '2026-09-29T21:01:00');
});

test('/api/market/candles supplies UTC opening times across providers without changing legacy time', async () => {
  const fixtures = [
    { candle_date_time_utc: '2026-09-29T12:00:00.000Z' },
    { candle_date_time_utc: '2026-09-29T12:00:00' },
    { candle_date_time_kst: '2026-09-29T21:00:00' },
    { candle_date_time_kst: '2026-09-29T21:00:00+09:00' },
    {
      candle_date_time_utc: '2026-09-29T12:00:00',
      candle_date_time_kst: '2026-09-29T22:00:00',
      timestamp: Date.parse('2026-09-29T12:04:59.999Z')
    },
    { candle_date_time_utc: 'invalid', candle_date_time_kst: '2026-09-29T21:00:00' }
  ];
  const router = createMarketRoutes({
    marketDataProvider: new MarketDataProvider({
      async readTickers() { return []; },
      async readCandles() {
        return fixtures.map(row => ({
          ...row, opening_price: 100, high_price: 102, low_price: 99,
          trade_price: 101, candle_acc_trade_volume: 1
        }));
      }
    })
  });
  const result = await dispatchGet(router, '/market/candles/KRW-BTC?unit=5&count=6');
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.length, fixtures.length);
  for (const [index, candle] of result.body.entries()) {
    assert.equal(candle.timeUtc, '2026-09-29T12:00:00.000Z', `fixture ${fixtures.length - 1 - index}`);
    assert.equal(candle.time, fixtures[fixtures.length - 1 - index].candle_date_time_kst);
  }
});

test('/api/market/candles does not invent an opening time from invalid dates or a final-trade timestamp', async () => {
  const router = createMarketRoutes({
    marketDataProvider: new MarketDataProvider({
      async readTickers() { return []; },
      async readCandles() {
        return [
          { candle_date_time_utc: 'invalid', candle_date_time_kst: 'invalid' },
          { timestamp: Date.parse('2026-09-29T12:04:59.999Z') }
        ];
      }
    })
  });
  const result = await dispatchGet(router, '/market/candles/KRW-BTC?count=2');
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body.map(candle => candle.timeUtc), [null, null]);
});

test('/api/market/candles coalesces identical in-flight reads and caches each market query briefly', async () => {
  let releaseCandles;
  let candleReads = 0;
  const candleRows = [{
    candle_date_time_kst: '2026-09-29T21:02:00', opening_price: 102,
    high_price: 104, low_price: 101, trade_price: 103, candle_acc_trade_volume: 12
  }];
  const router = createMarketRoutes({
    tradingSystem: { upbit: {} },
    marketDataProvider: new MarketDataProvider({
      async readTickers() { return []; },
      readCandles() {
        candleReads += 1;
        return new Promise(resolve => { releaseCandles = resolve; });
      }
    })
  });

  const first = dispatchGet(router, '/market/candles/KRW-BTC?unit=1&count=5');
  const second = dispatchGet(router, '/market/candles/KRW-BTC?unit=1&count=5');
  await Promise.resolve();
  assert.equal(candleReads, 1);
  releaseCandles(candleRows);
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.statusCode, 200);
  assert.deepEqual(secondResult.body, firstResult.body);
  firstResult.body[0].close = -1;

  const cachedResult = await dispatchGet(router, '/market/candles/KRW-BTC?unit=1&count=5');
  assert.equal(cachedResult.statusCode, 200);
  assert.equal(cachedResult.body[0].close, 103, 'cached rows are copied for each response');
  assert.equal(candleReads, 1);

  const differentQuery = dispatchGet(router, '/market/candles/KRW-BTC?unit=5&count=5');
  await Promise.resolve();
  assert.equal(candleReads, 2, 'different candle intervals keep separate cache entries');
  releaseCandles(candleRows);
  assert.equal((await differentQuery).statusCode, 200);
});

test('/api/market/prices/snapshot reports requested, returned, missing, and unusable markets', async () => {
  const sourceAsOf = '2026-09-29T12:00:00.000Z';
  const fetchedAt = '2026-09-29T12:00:01.000Z';
  const server = {
    tradingSystem: {
      upbit: {
        async getMarkets() {
          return ['KRW-BTC', 'KRW-ETH', 'KRW-XRP'].map(market => ({ market }));
        }
      }
    },
    marketDataProvider: new MarketDataProvider({
      now: () => Date.parse('2026-09-29T12:00:02.000Z'),
      async readMarkets() {
        return ['KRW-BTC', 'KRW-ETH', 'KRW-XRP'].map(market => ({ market }));
      },
      async readTickers(markets, { freshness }) {
        assert.deepEqual(markets, ['KRW-BTC', 'KRW-ETH', 'KRW-XRP']);
        assert.equal(freshness, MARKET_DATA_FRESHNESS.CACHED);
        return {
          fetchedAt,
          tickers: [
            {
              market: 'KRW-BTC', trade_price: 100, signed_change_rate: 0.01,
              signed_change_price: 1, high_price: 101, low_price: 98,
              acc_trade_volume_24h: 12, acc_trade_price_24h: 1200,
              trade_timestamp: sourceAsOf
            },
            {
              market: 'KRW-ETH', trade_price: 200, signed_change_rate: 0,
              signed_change_price: 0, high_price: 205, low_price: 198,
              acc_trade_volume_24h: 8, acc_trade_price_24h: 1600,
              trade_timestamp: 'not-a-timestamp'
            }
          ]
        };
      }
    })
  };

  const result = await dispatchGet(createMarketRoutes(server), '/market/prices/snapshot');

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body.requestedMarkets, ['KRW-BTC', 'KRW-ETH', 'KRW-XRP']);
  assert.deepEqual(result.body.returnedMarkets, ['KRW-BTC', 'KRW-ETH']);
  assert.deepEqual(result.body.missingMarkets, ['KRW-XRP']);
  assert.deepEqual(result.body.unavailableMarkets, ['KRW-ETH', 'KRW-XRP']);
  assert.equal(result.body.complete, false);
  assert.equal(result.body.allQuotesFresh, false);
  assert.deepEqual(result.body.freshMarkets, ['KRW-BTC']);
  assert.deepEqual(result.body.staleMarkets, []);
  assert.equal(result.body.maximumQuoteAgeMs, 90_000);
  assert.equal(result.body.sourceSkewMs, 0);
  assert.equal(result.body.sourceAsOf, sourceAsOf);
  assert.equal(result.body.fetchedAt, fetchedAt);
  assert.equal(result.body.marketListStale, false);
  assert.equal(result.body.marketListFetchedAt, result.headers['x-market-list-fetched-at']);
  assert.equal(result.body.prices.length, 2);
  assert.equal(result.body.prices[0].quoteFresh, true);
  assert.equal(result.body.prices[0].quoteAgeMs, 2_000);
});

test('/target-coins has router-scoped cache state and coalesces concurrent market-list reads', async () => {
  const btcServer = {
    tradingSystem: {
      upbit: { async getMarkets() { return [{ market: 'KRW-BTC' }]; } }
    }
  };
  let ethReads = 0;
  const ethServer = {
    tradingSystem: {
      upbit: {
        async getMarkets() {
          ethReads += 1;
          return [{ market: 'KRW-ETH' }];
        }
      }
    }
  };

  const btcResult = await dispatchGet(createMarketRoutes(btcServer), '/target-coins');
  const ethResult = await dispatchGet(createMarketRoutes(ethServer), '/target-coins');

  assert.deepEqual(btcResult.body.coins, ['KRW-BTC']);
  assert.deepEqual(ethResult.body.coins, ['KRW-ETH']);
  assert.equal(ethReads, 1);

  let resolveMarkets;
  let coalescedReads = 0;
  const sharedServer = {
    tradingSystem: {
      upbit: {
        getMarkets() {
          coalescedReads += 1;
          return new Promise(resolve => { resolveMarkets = resolve; });
        }
      }
    }
  };
  const sharedRouter = createMarketRoutes(sharedServer);
  const firstRequest = dispatchGet(sharedRouter, '/target-coins');
  const secondRequest = dispatchGet(sharedRouter, '/target-coins');

  assert.equal(coalescedReads, 1);
  resolveMarkets([{ market: 'KRW-BTC' }, { market: 'KRW-ETH' }]);
  const [firstResult, secondResult] = await Promise.all([firstRequest, secondRequest]);
  assert.deepEqual(firstResult.body.coins, ['KRW-BTC', 'KRW-ETH']);
  assert.deepEqual(secondResult.body.coins, ['KRW-BTC', 'KRW-ETH']);
});

test('/target-coins returns the last verified list as explicitly stale after refresh failure', async () => {
  const originalDateNow = Date.now;
  let now = originalDateNow();
  Date.now = () => now;
  try {
    let marketReads = 0;
    const server = {
      tradingSystem: { upbit: {} },
      marketDataProvider: new MarketDataProvider({
        async readMarkets() {
          marketReads += 1;
          if (marketReads === 1) return [{ market: 'KRW-BTC' }];
          throw new Error('market reader unavailable');
        },
        async readTickers() { return []; }
      })
    };
    const router = createMarketRoutes(server);
    const first = await dispatchGet(router, '/target-coins');
    now += 60_001;
    const stale = await dispatchGet(router, '/target-coins');
    const prices = await dispatchGet(router, '/market/prices');

    assert.equal(first.statusCode, 200);
    assert.equal(first.body.stale, false);
    assert.match(first.body.fetchedAt, /^\d{4}-\d\d-\d\dT/);
    assert.equal(stale.statusCode, 200);
    assert.deepEqual(stale.body.coins, ['KRW-BTC']);
    assert.equal(stale.body.stale, true);
    assert.equal(stale.body.fetchedAt, first.body.fetchedAt);
    assert.equal(prices.statusCode, 200);
    assert.deepEqual(prices.body, []);
    assert.equal(prices.headers['x-market-list-stale'], 'true');
    assert.equal(prices.headers['x-market-list-fetched-at'], first.body.fetchedAt);
  } finally {
    Date.now = originalDateNow;
  }
});

test('/target-coins reports unavailable instead of inventing a market list when none was verified', async () => {
  const failingServer = {
    tradingSystem: { upbit: { async getMarkets() { throw new Error('offline'); } } }
  };
  const invalidServer = {
    tradingSystem: { upbit: { async getMarkets() { return [{ market: 'not-a-market' }]; } } }
  };

  for (const server of [failingServer, invalidServer]) {
    const result = await dispatchGet(createMarketRoutes(server), '/target-coins');
    assert.equal(result.statusCode, 503);
    assert.deepEqual(result.body, {
      error: 'Market list unavailable.',
      code: 'MARKET_LIST_UNAVAILABLE',
      stale: false,
      fetchedAt: null
    });
  }
});

test('/market/candles rejects unsupported units and non-finite or out-of-range counts before reading', async () => {
  let candleReads = 0;
  const router = createMarketRoutes({
    tradingSystem: { upbit: {} },
    marketDataProvider: new MarketDataProvider({
      async readTickers() { return []; },
      async readCandles() {
        candleReads += 1;
        return [];
      }
    })
  });

  for (const query of [
    'unit=0', 'unit=2', 'unit=1.5', 'unit=241', 'unit=Infinity',
    'count=0', 'count=201', 'count=2.5', 'count=Infinity', 'count=-1', 'count=1x'
  ]) {
    const result = await dispatchGet(router, `/market/candles/KRW-BTC?${query}`);
    assert.equal(result.statusCode, 400, query);
    assert.equal(typeof result.body.error, 'string', query);
  }

  assert.equal(candleReads, 0);
});

test('/market/candles accepts the supported maximum unit and count bounds', async () => {
  let candleArgs;
  const router = createMarketRoutes({
    tradingSystem: { upbit: {} },
    marketDataProvider: new MarketDataProvider({
      async readTickers() { return []; },
      async readCandles(...args) {
        candleArgs = args;
        return [];
      }
    })
  });

  const result = await dispatchGet(router, '/market/candles/KRW-BTC?unit=240&count=200');

  assert.equal(result.statusCode, 200);
  assert.deepEqual(candleArgs, ['KRW-BTC', 240, 200]);
});
