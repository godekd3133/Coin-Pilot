import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MarketDataProvider,
  MARKET_DATA_FRESHNESS,
  UpbitCacheMarketDataProvider
} from '../src/api/marketDataProvider.js';
import { readCurrentMarketPrices } from '../src/api/marketValuation.js';
import DashboardServer from '../src/api/dashboardServer.js';
import { FixtureMarketDataAdapter } from '../src/market-data/marketDataAdapters.js';

const sourceAsOf = '2026-09-29T12:00:00.000Z';
const fetchedAt = '2026-09-29T12:00:01.000Z';

test('MarketDataProvider shares concurrent fake reads for the same market set', async () => {
  let resolveTickers;
  let readCount = 0;
  const tickers = [
    { market: 'KRW-BTC', trade_price: 100, trade_timestamp: Date.parse(sourceAsOf) },
    { market: 'KRW-ETH', trade_price: 200, trade_timestamp: Date.parse(sourceAsOf) + 1000 }
  ];
  const provider = new MarketDataProvider({
    readTickers: markets => {
      readCount += 1;
      assert.deepEqual(markets, ['KRW-BTC', 'KRW-ETH']);
      return new Promise(resolve => { resolveTickers = resolve; });
    }
  });

  const first = provider.getSnapshot(['KRW-BTC', 'KRW-ETH']);
  const second = provider.getSnapshot(['KRW-ETH', 'KRW-BTC']);
  assert.equal(readCount, 1);
  resolveTickers({ tickers, fetchedAt });

  const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
  assert.strictEqual(firstSnapshot, secondSnapshot);
  assert.deepEqual(firstSnapshot.tickers, tickers);
  assert.deepEqual([...firstSnapshot.priceMap], [['KRW-BTC', 100], ['KRW-ETH', 200]]);
  assert.deepEqual([...firstSnapshot.sourceAsOfByMarket], [
    ['KRW-BTC', sourceAsOf],
    ['KRW-ETH', '2026-09-29T12:00:01.000Z']
  ]);
  assert.equal(firstSnapshot.sourceAsOf, sourceAsOf);
  assert.equal(firstSnapshot.asOf, sourceAsOf);
  assert.equal(firstSnapshot.fetchedAt, fetchedAt);
  assert.equal(firstSnapshot.complete, true);
  assert.deepEqual(firstSnapshot.unavailableMarkets, []);
});

test('cached snapshots and fresh ticker reads select different readers without cloning raw payloads', async () => {
  const cachedTicker = { market: 'KRW-BTC', trade_price: 100, trade_timestamp: Date.parse(sourceAsOf) };
  const freshTicker = { market: 'KRW-BTC', trade_price: 101, trade_timestamp: Date.parse(sourceAsOf) + 1000 };
  const freshPayload = [freshTicker];
  const calls = [];
  const provider = new MarketDataProvider({
    async readTickers(markets, { freshness }) {
      calls.push({ markets, freshness });
      if (freshness === MARKET_DATA_FRESHNESS.FRESH) return freshPayload;
      return { tickers: [cachedTicker], fetchedAt };
    }
  });

  const cachedSnapshot = await provider.getSnapshot(['KRW-BTC'], {
    freshness: MARKET_DATA_FRESHNESS.CACHED
  });
  const rawFreshTickers = await provider.getTickers('KRW-BTC', {
    freshness: MARKET_DATA_FRESHNESS.FRESH
  });

  assert.deepEqual(calls, [
    { markets: ['KRW-BTC'], freshness: MARKET_DATA_FRESHNESS.CACHED },
    { markets: 'KRW-BTC', freshness: MARKET_DATA_FRESHNESS.FRESH }
  ]);
  assert.equal(cachedSnapshot.tickers[0], cachedTicker);
  assert.equal(cachedSnapshot.sourceAsOf, sourceAsOf);
  assert.equal(cachedSnapshot.fetchedAt, fetchedAt);
  assert.strictEqual(rawFreshTickers, freshPayload);
  assert.strictEqual(rawFreshTickers[0], freshTicker);
});

test('readCurrentMarketPrices accepts the legacy array-only fake reader contract', async () => {
  const tickers = [{ market: 'KRW-BTC', trade_price: 125, trade_timestamp: Date.parse(sourceAsOf) }];
  const snapshot = await readCurrentMarketPrices({
    getCachedTicker: async markets => {
      assert.deepEqual(markets, ['KRW-BTC']);
      return tickers;
    }
  }, ['KRW-BTC']);

  assert.deepEqual(snapshot.tickers, tickers);
  assert.equal(snapshot.priceMap.get('KRW-BTC'), 125);
  assert.equal(snapshot.sourceAsOfByMarket.get('KRW-BTC'), sourceAsOf);
  assert.equal(snapshot.sourceAsOf, sourceAsOf);
  assert.equal(snapshot.asOf, sourceAsOf);
  assert.equal(snapshot.fetchedAt, null);
  assert.equal(snapshot.complete, true);
  assert.deepEqual(snapshot.unavailableMarkets, []);
});

test('readCurrentMarketPrices delegates to the injected provider', async () => {
  let readCount = 0;
  const provider = new MarketDataProvider({
    readTickers: async markets => {
      readCount += 1;
      assert.deepEqual(markets, ['KRW-BTC']);
      return { tickers: [{ market: 'KRW-BTC', trade_price: 125, trade_timestamp: sourceAsOf }], fetchedAt };
    }
  });

  const snapshot = await readCurrentMarketPrices({ marketDataProvider: provider }, ['KRW-BTC']);
  assert.equal(readCount, 1);
  assert.equal(snapshot.priceMap.get('KRW-BTC'), 125);
  assert.equal(snapshot.fetchedAt, fetchedAt);
});

test('malformed or missing ticker timestamps stay unavailable in a partial snapshot', async () => {
  const provider = new MarketDataProvider({
    readTickers: async () => ({
      tickers: [
        { market: 'KRW-BTC', trade_price: 100, trade_timestamp: Date.parse(sourceAsOf) },
        { market: 'KRW-ETH', trade_price: 200, trade_timestamp: 'not-a-timestamp' },
        { market: 'KRW-XRP', trade_price: 300 },
        { market: 'KRW-SOL', trade_price: 0, trade_timestamp: Date.parse(sourceAsOf) },
        { market: 'KRW-ADA', trade_price: 400, trade_timestamp: 1e30 }
      ],
      fetchedAt: 'not-a-timestamp'
    })
  });

  const snapshot = await provider.getSnapshot(['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL', 'KRW-ADA']);
  assert.equal(snapshot.priceMap.size, 1);
  assert.equal(snapshot.priceMap.get('KRW-BTC'), 100);
  assert.deepEqual([...snapshot.sourceAsOfByMarket], [['KRW-BTC', sourceAsOf]]);
  assert.equal(snapshot.sourceAsOf, sourceAsOf);
  assert.equal(snapshot.asOf, sourceAsOf);
  assert.equal(snapshot.fetchedAt, null);
  assert.equal(snapshot.complete, false);
  assert.deepEqual(snapshot.unavailableMarkets, ['KRW-ETH', 'KRW-XRP', 'KRW-SOL', 'KRW-ADA']);
});

test('provider filters tickers outside the requested market set', async () => {
  const provider = new MarketDataProvider({
    readTickers: async () => [
      { market: 'KRW-BTC', trade_price: 100, trade_timestamp: Date.parse(sourceAsOf) },
      { market: 'KRW-ETH', trade_price: 200, trade_timestamp: Date.parse(sourceAsOf) }
    ]
  });

  const snapshot = await provider.getSnapshot(['KRW-BTC']);
  assert.deepEqual(snapshot.tickers, [
    { market: 'KRW-BTC', trade_price: 100, trade_timestamp: Date.parse(sourceAsOf) }
  ]);
  assert.deepEqual([...snapshot.priceMap], [['KRW-BTC', 100]]);
});

test('provider read failure rejects so route callers can retain their error contract', async () => {
  const provider = new MarketDataProvider({ readTickers: async () => { throw new Error('fake read failed'); } });
  await assert.rejects(() => provider.getSnapshot(['KRW-BTC']), /fake read failed/);
});

test('portfolio valuation converts a provider read failure into explicit unavailable markets', async () => {
  const snapshot = await readCurrentMarketPrices({
    getCachedTicker: async () => { throw new Error('fake read failed'); }
  }, ['KRW-BTC']);

  assert.deepEqual(snapshot.tickers, []);
  assert.equal(snapshot.priceMap.size, 0);
  assert.equal(snapshot.sourceAsOf, null);
  assert.equal(snapshot.asOf, null);
  assert.equal(snapshot.fetchedAt, null);
  assert.equal(snapshot.complete, false);
  assert.deepEqual(snapshot.unavailableMarkets, ['KRW-BTC']);
});

test('production adapter prefers DashboardServer ticker cache metadata', async () => {
  let cachedMetadataCalls = 0;
  let legacyCalls = 0;
  const provider = new UpbitCacheMarketDataProvider({
    async getCachedTickerWithMetadata(markets) {
      cachedMetadataCalls += 1;
      assert.deepEqual(markets, ['KRW-BTC']);
      return { tickers: [{ market: 'KRW-BTC', trade_price: 10, trade_timestamp: Date.parse(sourceAsOf) }], fetchedAt };
    },
    async getCachedTicker() {
      legacyCalls += 1;
      return [];
    }
  });

  const snapshot = await provider.getSnapshot(['KRW-BTC']);
  assert.equal(cachedMetadataCalls, 1);
  assert.equal(legacyCalls, 0);
  assert.equal(snapshot.fetchedAt, fetchedAt);
});

test('production adapter bypasses the ticker cache for fresh reads and injects candle reads unchanged', async () => {
  let cachedCalls = 0;
  let freshCalls = 0;
  let candleArgs;
  const rawTickers = [{ market: 'KRW-BTC', trade_price: 50, trade_timestamp: Date.parse(sourceAsOf) }];
  const rawCandles = [{ candle_date_time_kst: '2026-09-29T21:00:00' }];
  const provider = new UpbitCacheMarketDataProvider({
    async getCachedTickerWithMetadata() {
      cachedCalls += 1;
      return { tickers: [], fetchedAt };
    },
    tradingSystem: {
      upbit: {
        async getTicker(markets) {
          freshCalls += 1;
          assert.equal(markets, 'KRW-BTC');
          return rawTickers;
        },
        async getMinuteCandles(...args) {
          candleArgs = args;
          return rawCandles;
        }
      }
    }
  });

  const freshResult = await provider.getTickers('KRW-BTC', {
    freshness: MARKET_DATA_FRESHNESS.FRESH
  });
  const candleResult = await provider.getMinuteCandles('KRW-BTC', 3, 2);

  assert.equal(cachedCalls, 0);
  assert.equal(freshCalls, 1);
  assert.strictEqual(freshResult, rawTickers);
  assert.strictEqual(candleResult, rawCandles);
  assert.deepEqual(candleArgs, ['KRW-BTC', 3, 2]);
});

test('production adapter does not fall back to cached or missing readers for fresh market data', async () => {
  let cachedCalls = 0;
  const provider = new UpbitCacheMarketDataProvider({
    async getCachedTickerWithMetadata() {
      cachedCalls += 1;
      return { tickers: [{ market: 'KRW-BTC', trade_price: 1, trade_timestamp: Date.parse(sourceAsOf) }], fetchedAt };
    },
    tradingSystem: { upbit: {} }
  });

  await assert.rejects(
    () => provider.getTickers('KRW-BTC', { freshness: MARKET_DATA_FRESHNESS.FRESH }),
    /no fresh ticker reader/
  );
  await assert.rejects(() => provider.getMinuteCandles('KRW-BTC', 1, 1), /no candle reader/);
  assert.equal(cachedCalls, 0);
});

test('dashboard provider reuses the trader fixture adapter for market list, tickers, and candles', async () => {
  const adapter = new FixtureMarketDataAdapter({
    markets: ['KRW-BTC'],
    tickers: [{ market: 'KRW-BTC', trade_price: 10, trade_timestamp: sourceAsOf }],
    candleSets: [{
      market: 'KRW-BTC',
      unit: 1,
      candles: [{ market: 'KRW-BTC', trade_price: 10 }]
    }]
  });
  const server = {
    tradingSystem: {
      marketDataAdapter: adapter,
      upbit: {
        async getMarkets() { throw new Error('market-list source diverged'); },
        async getTicker() { throw new Error('ticker source diverged'); },
        async getMinuteCandles() { throw new Error('candle source diverged'); }
      }
    },
    async getCachedTickerWithMetadata() { throw new Error('fixture bypassed into Upbit cache'); }
  };
  const provider = new UpbitCacheMarketDataProvider(server);

  assert.deepEqual(await provider.getMarkets(), [{ market: 'KRW-BTC' }]);
  const snapshot = await provider.getSnapshot(['KRW-BTC']);
  const freshTickers = await provider.getTickers('KRW-BTC', {
    freshness: MARKET_DATA_FRESHNESS.FRESH
  });
  const candles = await provider.getMinuteCandles('KRW-BTC', 1, 1);

  assert.equal(snapshot.priceMap.get('KRW-BTC'), 10);
  assert.strictEqual(freshTickers[0].market, 'KRW-BTC');
  assert.deepEqual(candles, [{ market: 'KRW-BTC', trade_price: 10 }]);
});

test('DashboardServer cached account valuations use the selected fixture adapter without an Upbit fetch time', async () => {
  const adapter = new FixtureMarketDataAdapter({
    markets: ['KRW-BTC'],
    tickers: [{ market: 'KRW-BTC', trade_price: 10, trade_timestamp: sourceAsOf }]
  });
  const server = Object.create(DashboardServer.prototype);
  server.tradingSystem = { marketDataAdapter: adapter };

  const snapshot = await server.getCachedTickerWithMetadata(['KRW-BTC']);

  assert.deepEqual(snapshot.tickers, [{ market: 'KRW-BTC', trade_price: 10, trade_timestamp: sourceAsOf }]);
  assert.equal(snapshot.fetchedAt, null);
});

test('injected public market source owns provider reads ahead of trader market clients', async () => {
  const calls = [];
  const fetchedTickers = [{
    market: 'KRW-BTC', trade_price: 20, trade_timestamp: Date.parse(sourceAsOf)
  }];
  const freshTickers = [{
    market: 'KRW-BTC', trade_price: 21, trade_timestamp: Date.parse(sourceAsOf) + 1000
  }];
  const candles = [{ market: 'KRW-BTC', trade_price: 21 }];
  const source = {
    async getMarkets() {
      calls.push('source.markets');
      return [{ market: 'KRW-BTC' }];
    },
    async getTicker(markets) {
      calls.push(['source.ticker', markets]);
      return freshTickers;
    },
    async getMinuteCandles(...args) {
      calls.push(['source.candles', ...args]);
      return candles;
    }
  };
  const server = {
    publicMarketDataSource: source,
    tradingSystem: {
      marketDataAdapter: {
        async getMarkets() { throw new Error('trader adapter market read'); },
        async getTickers() { throw new Error('trader adapter ticker read'); },
        async getMinuteCandles() { throw new Error('trader adapter candle read'); }
      },
      upbit: {
        async getMarkets() { throw new Error('trader Upbit market read'); },
        async getTicker() { throw new Error('trader Upbit ticker read'); },
        async getMinuteCandles() { throw new Error('trader Upbit candle read'); }
      }
    },
    async getCachedTickerWithMetadata(markets) {
      calls.push(['dashboard.cached-ticker', markets]);
      return { tickers: fetchedTickers, fetchedAt };
    }
  };
  const provider = new UpbitCacheMarketDataProvider(server);

  assert.deepEqual(await provider.getMarkets(), [{ market: 'KRW-BTC' }]);
  const cachedSnapshot = await provider.getSnapshot(['KRW-BTC']);
  const rawFreshTickers = await provider.getTickers('KRW-BTC', {
    freshness: MARKET_DATA_FRESHNESS.FRESH
  });
  assert.deepEqual(await provider.getMinuteCandles('KRW-BTC', 1, 2), candles);

  assert.equal(cachedSnapshot.priceMap.get('KRW-BTC'), 20);
  assert.equal(cachedSnapshot.fetchedAt, fetchedAt);
  assert.strictEqual(rawFreshTickers, freshTickers);
  assert.deepEqual(calls, [
    'source.markets',
    ['dashboard.cached-ticker', ['KRW-BTC']],
    ['source.ticker', 'KRW-BTC'],
    ['source.candles', 'KRW-BTC', 1, 2]
  ]);
});
