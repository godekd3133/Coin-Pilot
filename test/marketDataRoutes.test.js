import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import createConfigRoutes from '../src/api/routes/config.js';
import createTradingRoutes from '../src/api/routes/trading.js';
import { MarketDataProvider, MARKET_DATA_FRESHNESS } from '../src/api/marketDataProvider.js';

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

test('config ticker status route uses an injected fresh reader without upbit.getTicker', async () => {
  const rawTicker = { market: 'KRW-BTC', trade_price: 123 };
  const calls = [];
  const server = {
    tradingSystem: {
      upbit: {},
      strategies: new Map(),
      targetCoins: ['KRW-BTC'],
      isRunning: false,
      dryRun: true
    },
    marketDataProvider: new MarketDataProvider({
      async readTickers(markets, { freshness }) {
        calls.push({ markets, freshness });
        return [rawTicker];
      }
    })
  };

  const result = await dispatchGet(createConfigRoutes(server), '/test');

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body.tickerTest, { success: true, btcPrice: 123 });
  assert.deepEqual(calls, [{ markets: 'KRW-BTC', freshness: MARKET_DATA_FRESHNESS.FRESH }]);
});

test('trading route uses injected fresh tickers and candle reads without direct Upbit market readers', async () => {
  const rawTicker = {
    market: 'KRW-BTC',
    trade_price: 123,
    trade_timestamp: Date.parse('2026-09-29T12:00:00.000Z')
  };
  const calls = [];
  const server = {
    tradingSystem: {
      upbit: {},
      isScalpingMode: true,
      targetCoins: ['KRW-BTC'],
      candleUnit: 1,
      candleCount: 5,
      dryRun: true,
      strategyMode: 'test-strategy',
      entryDelayMinMs: 1000,
      entryDelayMaxMs: 2000,
      virtualPortfolio: { holdings: new Map() },
      async getAccountInfo() { return []; },
      getKRWBalance() { return 0; },
      buildTechnicalAnalysis() {
        return { indicators: { rebound: { available: false } } };
      }
    },
    marketDataProvider: new MarketDataProvider({
      async readTickers(markets, { freshness }) {
        calls.push({ type: 'tickers', markets, freshness });
        return [rawTicker];
      },
      async readCandles(...args) {
        calls.push({ type: 'candles', args });
        return [];
      }
    })
  };

  const result = await dispatchGet(createTradingRoutes(server), '/coin-analysis');

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.analyzedCoins, 1);
  assert.deepEqual(result.body.recommendations, []);
  assert.deepEqual(calls, [
    { type: 'tickers', markets: ['KRW-BTC'], freshness: MARKET_DATA_FRESHNESS.FRESH },
    { type: 'candles', args: ['KRW-BTC', 1, 5] }
  ]);
});

test('route ticker and candle reads all go through the market-data provider seam', async () => {
  const routeUrls = [
    new URL('../src/api/routes/trading.js', import.meta.url),
    new URL('../src/api/routes/config.js', import.meta.url),
    new URL('../src/api/routes/market.js', import.meta.url)
  ];
  const routeSources = await Promise.all(routeUrls.map(url => readFile(url, 'utf8')));

  for (const [index, source] of routeSources.entries()) {
    assert.doesNotMatch(
      source,
      /upbit\.(?:getTicker|getMinuteCandles)\s*\(/,
      `route ${routeUrls[index]} has a direct ticker or candle read`
    );
  }
});

test('dashboard market-list and ticker reads stay behind the selected market-data provider', async () => {
  const routeUrls = [
    new URL('../src/api/routes/market.js', import.meta.url),
    new URL('../src/api/routes/trading.js', import.meta.url),
    new URL('../src/api/dashboardServer.js', import.meta.url)
  ];
  const routeSources = await Promise.all(routeUrls.map(url => readFile(url, 'utf8')));

  assert.match(routeSources[0], /getMarketDataProvider\(server\)\.getMarkets\(\)/);
  assert.match(routeSources[1], /getMarketDataProvider\(server\)\.getMarkets\(\)/);
  assert.match(routeSources[2], /marketDataProvider\.getMarkets\(\)/);
  for (const source of routeSources) {
    assert.doesNotMatch(source, /(?:server\.)?tradingSystem\.upbit\.getMarkets\s*\(/);
  }

  const dashboardSource = routeSources[2];
  const coinDetailStart = dashboardSource.indexOf("this.app.get('/api/coin-detail/:coin'");
  const coinDetailEnd = dashboardSource.indexOf('\n    });', coinDetailStart);
  const coinDetail = dashboardSource.slice(coinDetailStart, coinDetailEnd);
  const bundleStart = dashboardSource.indexOf('async generateBundleSuggestions()');
  const bundleEnd = dashboardSource.indexOf('\n  }', bundleStart);
  const bundleRecommendations = dashboardSource.slice(bundleStart, bundleEnd);
  const upstreamCache = dashboardSource
    .split('async getCachedTickerWithMetadata(coins) {')[1]
    ?.split('async getCachedTicker(coins)')[0];

  assert.match(coinDetail, /getMarketDataProvider\(this\)\.getTickers/);
  assert.match(coinDetail, /getMarketDataProvider\(this\)\.getMinuteCandles/);
  assert.doesNotMatch(coinDetail, /this\.tradingSystem\.upbit\.get(?:Ticker|MinuteCandles)\s*\(/);
  assert.match(bundleRecommendations, /marketDataProvider\.getTickers/);
  assert.match(bundleRecommendations, /marketDataProvider\.getMinuteCandles/);
  assert.doesNotMatch(bundleRecommendations, /this\.tradingSystem\.upbit\.get(?:Ticker|MinuteCandles)\s*\(/);
  assert.match(upstreamCache, /this\.tradingSystem\.upbit\.getTicker/);
});
