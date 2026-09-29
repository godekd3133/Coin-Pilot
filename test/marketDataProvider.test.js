import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MarketDataProvider,
  UpbitCacheMarketDataProvider
} from '../src/api/marketDataProvider.js';
import { readCurrentMarketPrices } from '../src/api/marketValuation.js';

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
