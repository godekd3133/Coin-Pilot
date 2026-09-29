import assert from 'node:assert/strict';
import test from 'node:test';
import createMarketRoutes from '../src/api/routes/market.js';
import { MarketDataProvider } from '../src/api/marketDataProvider.js';

function dispatchGet(router, url) {
  return new Promise((resolve, reject) => {
    const req = {
      method: 'GET',
      url,
      originalUrl: url,
      baseUrl: '',
      headers: {},
      params: {},
      get(name) { return this.headers[name.toLowerCase()]; }
    };
    const res = {
      statusCode: 200,
      status(statusCode) {
        this.statusCode = statusCode;
        return this;
      },
      json(body) {
        resolve({ statusCode: this.statusCode, body });
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
      async readTickers(markets) {
        assert.deepEqual(markets, ['KRW-BTC', 'KRW-ETH']);
        return { tickers, fetchedAt };
      }
    })
  };
  const result = await dispatchGet(createMarketRoutes(server), '/market/prices');

  assert.equal(result.statusCode, 200);
  assert.equal(Array.isArray(result.body), true);
  assert.deepEqual(result.body, [
    {
      coin: 'KRW-BTC', price: 100, change: 1, changePrice: 1, high: 101, low: 98,
      volume: 12, volumeKrw: 1200, sourceAsOf, fetchedAt
    },
    {
      coin: 'KRW-ETH', price: 200, change: -2, changePrice: -4, high: 205, low: 198,
      volume: 8, volumeKrw: 1600, sourceAsOf: null, fetchedAt
    }
  ]);
});

test('/api/market/prices preserves its upstream failure status', async () => {
  const server = {
    tradingSystem: { upbit: { async getMarkets() { return [{ market: 'KRW-BTC' }]; } } },
    marketDataProvider: new MarketDataProvider({
      async readTickers() { throw new Error('ticker unavailable'); }
    })
  };
  const result = await dispatchGet(createMarketRoutes(server), '/market/prices');

  assert.equal(result.statusCode, 500);
  assert.deepEqual(result.body, { error: 'ticker unavailable' });
});
