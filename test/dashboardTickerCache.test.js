import test from 'node:test';
import assert from 'node:assert/strict';
import DashboardServer from '../src/api/dashboardServer.js';

function makeDashboard(getTicker) {
  const dashboard = Object.create(DashboardServer.prototype);
  dashboard.cache = new Map();
  dashboard.inFlightTickerRequests = new Map();
  dashboard.cacheTTL = { ticker: 1000 };
  dashboard.tradingSystem = { upbit: { getTicker } };
  return dashboard;
}

test('동일 ticker cache key의 동시 miss는 하나의 Upbit 요청과 cache 값을 공유한다', async () => {
  let resolveRequest;
  let requestCount = 0;
  const response = [{ market: 'KRW-BTC', trade_price: 100 }];
  const request = new Promise(resolve => { resolveRequest = resolve; });
  const dashboard = makeDashboard(() => {
    requestCount += 1;
    return request;
  });

  const first = dashboard.getCachedTicker(['KRW-BTC', 'KRW-ETH']);
  const reversedMarkets = ['KRW-ETH', 'KRW-BTC'];
  const second = dashboard.getCachedTicker(reversedMarkets);

  await Promise.resolve();
  try {
    assert.equal(requestCount, 1);
    assert.deepEqual(reversedMarkets, ['KRW-ETH', 'KRW-BTC']);
  } finally {
    resolveRequest(response);
  }

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.strictEqual(firstResult, response);
  assert.strictEqual(secondResult, response);
  assert.strictEqual(await dashboard.getCachedTicker(['KRW-BTC', 'KRW-ETH']), response);
  assert.equal(requestCount, 1);
});

test('ticker metadata shares the response cache time across single-flight callers and cache hits', async () => {
  let resolveRequest;
  let requestCount = 0;
  const tickers = [{
    market: 'KRW-BTC',
    trade_price: 100,
    trade_timestamp: 1_790_000_000_000
  }];
  const request = new Promise(resolve => { resolveRequest = resolve; });
  const dashboard = makeDashboard(() => {
    requestCount += 1;
    return request;
  });
  const firstMarkets = ['KRW-BTC', 'KRW-ETH'];
  const secondMarkets = ['KRW-ETH', 'KRW-BTC'];

  const first = dashboard.getCachedTickerWithMetadata(firstMarkets);
  const second = dashboard.getCachedTickerWithMetadata(secondMarkets);
  await Promise.resolve();
  assert.equal(requestCount, 1);
  assert.deepEqual(firstMarkets, ['KRW-BTC', 'KRW-ETH']);
  assert.deepEqual(secondMarkets, ['KRW-ETH', 'KRW-BTC']);
  resolveRequest(tickers);

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.strictEqual(firstResult.tickers, tickers);
  assert.strictEqual(secondResult.tickers, tickers);
  assert.equal(typeof firstResult.fetchedAt, 'string');
  assert.equal(firstResult.fetchedAt, secondResult.fetchedAt);

  const cachedResult = await dashboard.getCachedTickerWithMetadata(firstMarkets);
  assert.strictEqual(cachedResult.tickers, tickers);
  assert.equal(cachedResult.fetchedAt, firstResult.fetchedAt);
  assert.equal(requestCount, 1);
});

test('ticker 요청 실패 후 in-flight 상태를 정리해 다음 호출이 재시도한다', async () => {
  const failure = new Error('upbit unavailable');
  const response = [{ market: 'KRW-BTC', trade_price: 100 }];
  let requestCount = 0;
  let rejectFirstRequest;
  const firstRequest = new Promise((resolve, reject) => { rejectFirstRequest = reject; });
  const dashboard = makeDashboard(() => {
    requestCount += 1;
    if (requestCount === 1) return firstRequest;
    return response;
  });

  const first = dashboard.getCachedTicker(['KRW-BTC']);
  const second = dashboard.getCachedTicker(['KRW-BTC']);
  await Promise.resolve();
  const observedRequestCount = requestCount;
  rejectFirstRequest(failure);
  const [firstResult, secondResult] = await Promise.allSettled([first, second]);
  assert.equal(observedRequestCount, 1);
  assert.equal(firstResult.status, 'rejected');
  assert.strictEqual(firstResult.reason, failure);
  assert.equal(secondResult.status, 'rejected');
  assert.strictEqual(secondResult.reason, failure);
  assert.strictEqual(await dashboard.getCachedTicker(['KRW-BTC']), response);
  assert.equal(requestCount, 2);
});

test('서로 다른 ticker cache key는 별도 Upbit 요청을 유지한다', async () => {
  let requestCount = 0;
  const pending = [];
  const dashboard = makeDashboard(coins => {
    requestCount += 1;
    return new Promise(resolve => pending.push({ coins, resolve }));
  });

  const bitcoin = dashboard.getCachedTicker(['KRW-BTC']);
  const ethereum = dashboard.getCachedTicker(['KRW-ETH']);

  await Promise.resolve();
  assert.equal(requestCount, 2);
  pending[0].resolve([{ market: 'KRW-BTC', trade_price: 100 }]);
  pending[1].resolve([{ market: 'KRW-ETH', trade_price: 200 }]);
  const [bitcoinResult, ethereumResult] = await Promise.all([bitcoin, ethereum]);
  assert.equal(bitcoinResult[0].market, 'KRW-BTC');
  assert.equal(ethereumResult[0].market, 'KRW-ETH');
});

test('만료된 ticker cache는 기존 TTL에 따라 다시 조회한다', async () => {
  const expired = [{ market: 'KRW-BTC', trade_price: 90 }];
  const refreshed = [{ market: 'KRW-BTC', trade_price: 100 }];
  let requestCount = 0;
  const dashboard = makeDashboard(async () => {
    requestCount += 1;
    return refreshed;
  });
  dashboard.cache.set('ticker:KRW-BTC', { data: expired, time: Date.now() - 1001 });

  assert.strictEqual(await dashboard.getCachedTicker(['KRW-BTC']), refreshed);
  assert.equal(requestCount, 1);
});
