import assert from 'node:assert/strict';
import test from 'node:test';
import DashboardServer from '../src/api/dashboardServer.js';
import UpbitAPI from '../src/api/upbit.js';
import { FixtureMarketDataAdapter, UpbitMarketDataAdapter } from '../src/market-data/marketDataAdapters.js';

function candle(timestamp, close) {
  return {
    market: 'KRW-BTC',
    candle_date_time_utc: timestamp,
    trade_price: close
  };
}

function createCollector({ publicMarketDataSource, tradingSystem }) {
  const server = Object.create(DashboardServer.prototype);
  server.publicMarketDataSource = publicMarketDataSource ?? null;
  server.tradingSystem = tradingSystem;
  return server;
}

test('optimizer pages use the injected public source cursor and keep newest-first page order', async () => {
  const firstPage = [
    candle('2026-09-29T12:02:00', 102),
    candle('2026-09-29T12:01:00', 101),
    candle('2026-09-29T12:00:00', 100)
  ];
  const secondPage = [candle('2026-09-29T11:59:00', 99)];
  const calls = [];
  const publicMarketDataSource = {
    async getMinuteCandles(market, unit, count, requestOptions) {
      calls.push({ market, unit, count, requestOptions });
      if (requestOptions.to === undefined) return firstPage;
      assert.equal(requestOptions.to, '2026-09-29T12:00:00');
      return secondPage;
    }
  };
  const tradingSystem = {
    marketDataAdapter: {
      async getMinuteCandles() { throw new Error('trader adapter must not be used'); }
    },
    upbit: {
      async getMinuteCandles() { throw new Error('trader Upbit client must not be used'); }
    }
  };
  const server = createCollector({ publicMarketDataSource, tradingSystem });

  const candles = await server.collectCandleData('KRW-BTC', 15, 4, 3);

  assert.deepEqual(candles, [...firstPage, ...secondPage]);
  assert.deepEqual(calls, [
    { market: 'KRW-BTC', unit: 15, count: 3, requestOptions: {} },
    {
      market: 'KRW-BTC', unit: 15, count: 1,
      requestOptions: { to: '2026-09-29T12:00:00' }
    }
  ]);
});

test('optimizer fallback pages use the trader adapter client and its finite-timeout scheduler', async () => {
  const cursor = '2026-09-29T12:00:00';
  const firstPage = [
    candle('2026-09-29T12:02:00', 102),
    candle('2026-09-29T12:01:00', 101),
    candle(cursor, 100)
  ];
  const secondPage = [candle('2026-09-29T11:59:00', 99)];
  const schedulerCalls = [];
  const scheduler = {
    async schedule(run, options) {
      schedulerCalls.push(options);
      return run(schedulerCalls.length * 1000);
    },
    applyBackoff() {}
  };
  const requestConfigs = [];
  const axiosDouble = {
    async get(url, config) {
      assert.equal(url, 'https://api.upbit.com/v1/candles/minutes/15');
      requestConfigs.push(config);
      return { data: config.params.to ? secondPage : firstPage };
    }
  };
  const upbit = new UpbitAPI('', '', {
    scheduler,
    axios: axiosDouble,
    requestTimeoutMs: 4321
  });
  const adapter = new UpbitMarketDataAdapter(upbit);
  const server = createCollector({
    tradingSystem: { marketDataAdapter: adapter, upbit }
  });

  const candles = await server.collectCandleData('KRW-BTC', 15, 4, 3);

  assert.strictEqual(upbit.scheduler, scheduler);
  assert.deepEqual(candles, [...firstPage, ...secondPage]);
  assert.deepEqual(requestConfigs.map(config => config.params), [
    { market: 'KRW-BTC', count: 3 },
    { market: 'KRW-BTC', count: 1, to: cursor }
  ]);
  assert.equal(requestConfigs.every(config => config.timeout === 4321), true);
  assert.equal(schedulerCalls.length, 2);
  assert.equal(schedulerCalls.every(call => call.priority === 'normal'), true);
  assert.equal(schedulerCalls.every(call => call.rateLimitGroup === 'candle'), true);
  assert.equal(schedulerCalls.every(call => call.rateLimitScope === 'ip'), true);
});

test('fixture market data paginates an exact newest-first history beyond one Upbit page', async () => {
  const start = Date.UTC(2026, 8, 30, 12, 0, 0);
  const fixtureCandles = Array.from({ length: 201 }, (_, index) => ({
    market: 'KRW-BTC',
    candle_date_time_utc: new Date(start - index * 15 * 60_000).toISOString().replace('.000Z', ''),
    marker: index,
    opening_price: 100 + index,
    high_price: 102 + index,
    low_price: 99 + index,
    trade_price: 101 + index,
    candle_acc_trade_volume: 1
  }));
  const adapter = new FixtureMarketDataAdapter({
    markets: ['KRW-BTC'],
    candleSets: [{ market: 'KRW-BTC', unit: 15, candles: fixtureCandles }]
  });
  const server = createCollector({ tradingSystem: { marketDataAdapter: adapter } });

  const candles = await server.collectCandleData('KRW-BTC', 15, 201);

  assert.equal(candles.length, 201);
  assert.deepEqual(candles.map(row => row.marker), Array.from({ length: 201 }, (_, index) => index));
});
