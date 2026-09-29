import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import test from 'node:test';
import createNewsRoutes from '../src/api/routes/news.js';
import createPortfolioRoutes from '../src/api/routes/portfolio.js';
import createTradingRoutes from '../src/api/routes/trading.js';

async function startReadRoutes(t, server) {
  const app = express();
  app.use('/api', createTradingRoutes(server));
  app.use('/api', createPortfolioRoutes(server));
  app.use('/api', createNewsRoutes(server));

  const httpServer = app.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    httpServer.close(error => error ? reject(error) : resolve());
  }));

  return `http://127.0.0.1:${httpServer.address().port}`;
}

test('read routes pass clamped limits to their synthetic downstream consumers', async t => {
  const markets = Array.from({ length: 125 }, (_, index) => (
    `KRW-SYNTH-${String(index).padStart(3, '0')}`
  ));
  const tickers = markets.map((market, index) => ({
    market,
    trade_price: 100 + index,
    signed_change_rate: 0,
    acc_trade_price_24h: markets.length - index
  }));
  const candleReads = [];
  const strategyLimits = [];
  const newsRequests = [];
  const server = {
    tradingSystem: {
      upbit: {
        async getMarkets() {
          return markets.map(market => ({ market }));
        }
      },
      config: {},
      strategies: new Map([['KRW-SYNTH-000', {
        getTradeHistory(limit) {
          strategyLimits.push(limit);
          return Array.from({ length: limit }, (_, index) => ({
            timestamp: `2026-01-01T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
            index
          }));
        }
      }]]),
      newsMonitor: null,
      newsData: []
    },
    marketDataProvider: {
      async getMarkets() {
        return markets.map(market => ({ market }));
      },
      async getSnapshot() {
        return {};
      },
      async getTickers(requestedMarkets, options) {
        assert.equal(options.freshness, 'fresh');
        assert.deepEqual(requestedMarkets, markets);
        return tickers;
      },
      async getMinuteCandles(market, unit, count) {
        candleReads.push({ market, unit, count });
        return [];
      }
    },
    accumulateNews() {},
    getAccumulatedNews(options) {
      newsRequests.push(options);
      const news = Array.from({ length: options.limit }, (_, index) => ({
        title: `Synthetic headline ${index}`,
        source: 'synthetic'
      }));
      return {
        news,
        total: news.length,
        totalAccumulated: 250,
        accumulatorStartTime: '2026-01-01T00:00:00.000Z'
      };
    },
    logApiError() {}
  };

  const baseUrl = await startReadRoutes(t, server);

  const scoreResponse = await fetch(`${baseUrl}/api/all-coin-scores?limit=101`, {
    headers: { connection: 'close' }
  });
  const scoreBody = await scoreResponse.json();
  assert.equal(scoreResponse.status, 200);
  assert.equal(scoreBody.totalMarkets, 125);
  assert.equal(candleReads.length, 100);
  assert.deepEqual(candleReads[0], { market: markets[0], unit: 5, count: 100 });
  assert.equal(candleReads.at(-1).market, markets[99]);

  const tradesResponse = await fetch(`${baseUrl}/api/trades?limit=101`, {
    headers: { connection: 'close' }
  });
  const tradesBody = await tradesResponse.json();
  assert.equal(tradesResponse.status, 200);
  assert.deepEqual(strategyLimits, [100]);
  assert.equal(tradesBody.length, 100);

  const newsResponse = await fetch(`${baseUrl}/api/news?limit=101`, {
    headers: { connection: 'close' }
  });
  const newsBody = await newsResponse.json();
  assert.equal(newsResponse.status, 200);
  assert.deepEqual(newsRequests.at(-1), { limit: 100, source: null });
  assert.equal(newsBody.news.length, 100);

  const coinNewsResponse = await fetch(`${baseUrl}/api/news/BTC?limit=101`, {
    headers: { connection: 'close' }
  });
  const coinNewsBody = await coinNewsResponse.json();
  assert.equal(coinNewsResponse.status, 200);
  assert.deepEqual(newsRequests.at(-1), { limit: 100, coin: 'KRW-BTC' });
  assert.equal(coinNewsBody.coin, 'KRW-BTC');
  assert.equal(coinNewsBody.news.length, 100);
});
