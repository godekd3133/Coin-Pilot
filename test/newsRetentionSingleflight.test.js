import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import test from 'node:test';
import DashboardServer from '../src/api/dashboardServer.js';
import createNewsRoutes from '../src/api/routes/news.js';

function createAccumulatorServer({ newsRetentionLimit = 2000, newsMonitor = null } = {}) {
  const server = Object.create(DashboardServer.prototype);
  server.newsRetentionLimit = newsRetentionLimit;
  server.accumulatedNews = [];
  server.newsSeenKeys = new Set();
  server.newsAccumulatorStartTime = new Date('2026-01-01T00:00:00.000Z');
  server.tradingSystem = { newsMonitor, newsData: [] };
  return server;
}

async function startNewsRoutes(t, server) {
  const app = express();
  let routeRequestCount = 0;
  app.use('/api/news', (req, res, next) => {
    routeRequestCount++;
    next();
  });
  app.use('/api', createNewsRoutes(server));

  const httpServer = app.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    httpServer.close(error => error ? reject(error) : resolve());
  }));

  return {
    baseUrl: `http://127.0.0.1:${httpServer.address().port}`,
    get routeRequestCount() {
      return routeRequestCount;
    }
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(condition) {
  const deadline = Date.now() + 1000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for concurrent news requests');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

async function getJson(url) {
  const response = await fetch(url, { headers: { connection: 'close' } });
  return { status: response.status, body: await response.json() };
}

test('DashboardServer defaults to a bounded news retention limit and accepts a smaller injected limit', async () => {
  class InMemoryDashboardServer extends DashboardServer {
    loadOptimizationState() {}
  }

  const makeServer = options => new InMemoryDashboardServer({}, 0, {
    env: { DASHBOARD_TOKEN: '', DASHBOARD_READ_ONLY_TOKEN: '', DASHBOARD_MOBILE_TOKEN: '', DASHBOARD_HOST: '' },
    logger: { logDir: '/memory', info() {}, error() {} },
    manualOrderIdempotencyStore: {},
    ...options
  });
  const defaultServer = makeServer();
  const smallServer = makeServer({ newsRetentionLimit: 3 });

  try {
    assert.equal(defaultServer.newsRetentionLimit, 2000);
    assert.equal(smallServer.newsRetentionLimit, 3);
    assert.throws(() => makeServer({ newsRetentionLimit: 0 }), /integer from 1 to 2000/);
    assert.throws(() => makeServer({ newsRetentionLimit: 2001 }), /integer from 1 to 2000/);
  } finally {
    await Promise.all([defaultServer.stop(), smallServer.stop()]);
  }
});

test('news retention evicts oldest rows and releases their dedupe keys', () => {
  const server = createAccumulatorServer({ newsRetentionLimit: 2 });
  const oldest = {
    title: 'Headline C', link: 'https://example.invalid/c', timestamp: new Date('2026-01-01T00:00:00.000Z')
  };
  const middle = {
    title: 'Headline B', link: 'https://example.invalid/b', timestamp: new Date('2026-01-02T00:00:00.000Z')
  };
  const newest = {
    title: 'Headline A', link: 'https://example.invalid/a', timestamp: new Date('2026-01-03T00:00:00.000Z')
  };

  assert.equal(server.accumulateNews([oldest, middle, newest], 'general'), 3);
  assert.deepEqual(server.accumulatedNews.map(news => news.title), ['Headline A', 'Headline B']);
  assert.equal(server.accumulatedNews.length, 2);
  assert.equal(server.newsSeenKeys.size, 2);
  assert.equal(server.newsSeenKeys.has(server.generateNewsKey(oldest)), false);
  assert.deepEqual(server.accumulatedNews.map(news => news.sourceCategory), ['general', 'general']);
  assert.equal(server.getAccumulatedNews({ limit: 10 }).totalAccumulated, 2);

  assert.equal(server.accumulateNews([{
    ...oldest,
    timestamp: new Date('2026-01-04T00:00:00.000Z')
  }], 'system'), 1);
  assert.deepEqual(server.accumulatedNews.map(news => news.title), ['Headline C', 'Headline A']);
  assert.equal(server.accumulatedNews[0].sourceCategory, 'system');
  assert.equal(server.newsSeenKeys.size, 2);
});

test('large input batches retain the newest rows with one sort per bounded batch', () => {
  const server = createAccumulatorServer({ newsRetentionLimit: 3 });
  let sortCalls = 0;
  const originalSort = server.accumulatedNews.sort.bind(server.accumulatedNews);
  server.accumulatedNews.sort = (...args) => {
    sortCalls++;
    return originalSort(...args);
  };
  const news = Array.from({ length: 20 }, (_, index) => ({
    title: `Headline ${index}`,
    link: `https://example.invalid/${index}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index))
  }));

  assert.equal(server.accumulateNews(news, 'general'), 20);
  assert.deepEqual(server.accumulatedNews.map(item => item.title), [
    'Headline 19', 'Headline 18', 'Headline 17'
  ]);
  assert.equal(server.accumulatedNews.length, 3);
  assert.equal(server.newsSeenKeys.size, 3);
  assert.equal(sortCalls, 1);
});

test('concurrent /news GETs share one fetch and a later GET starts a new fetch', async t => {
  const gates = [];
  let fetchCalls = 0;
  const server = createAccumulatorServer({
    newsMonitor: {
      fetchAllNews() {
        fetchCalls++;
        const gate = createDeferred();
        gates.push(gate);
        return gate.promise;
      },
      analyzeMarketSentiment(news) {
        return { overall: 'neutral', score: 0, newsCount: news.length };
      }
    }
  });
  const routes = await startNewsRoutes(t, server);

  const first = getJson(`${routes.baseUrl}/api/news`);
  const second = getJson(`${routes.baseUrl}/api/news?limit=20`);
  await waitFor(() => routes.routeRequestCount === 2 && fetchCalls === 1);
  assert.equal(fetchCalls, 1);

  gates[0].resolve([{
    title: 'Shared all-news result', link: 'https://example.invalid/all', timestamp: new Date()
  }]);
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(result => result.status), [200, 200]);
  assert.deepEqual(results.map(result => result.body.news[0].title), [
    'Shared all-news result', 'Shared all-news result'
  ]);

  const later = getJson(`${routes.baseUrl}/api/news`);
  await waitFor(() => routes.routeRequestCount === 3 && fetchCalls === 2);
  gates[1].resolve([{
    title: 'Later all-news result', link: 'https://example.invalid/later', timestamp: new Date()
  }]);
  assert.equal((await later).status, 200);
  assert.equal(fetchCalls, 2);
});

test('same-market concurrent GETs share collection while sentiment remains per request', async t => {
  const gates = [];
  let fetchCalls = 0;
  let sentimentCalls = 0;
  const server = createAccumulatorServer({
    newsMonitor: {
      fetchCoinSpecificNews(market) {
        fetchCalls++;
        const gate = createDeferred();
        gates.push({ market, ...gate });
        return gate.promise;
      },
      async getCoinSentiment(market) {
        sentimentCalls++;
        return { coin: market, overall: 'neutral', score: 0 };
      }
    }
  });
  const routes = await startNewsRoutes(t, server);

  const first = getJson(`${routes.baseUrl}/api/news/BTC`);
  const second = getJson(`${routes.baseUrl}/api/news/KRW-BTC`);
  await waitFor(() => routes.routeRequestCount === 2 && fetchCalls === 1);
  assert.equal(fetchCalls, 1);
  assert.equal(gates[0].market, 'KRW-BTC');

  gates[0].resolve([{
    title: 'Bitcoin update', link: 'https://example.invalid/btc', coin: 'KRW-BTC', timestamp: new Date()
  }]);
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(result => result.status), [200, 200]);
  assert.equal(sentimentCalls, 2);
  assert.deepEqual(results.map(result => result.body.sentiment.coin), ['KRW-BTC', 'KRW-BTC']);

  const later = getJson(`${routes.baseUrl}/api/news/BTC`);
  await waitFor(() => routes.routeRequestCount === 3 && fetchCalls === 2);
  gates[1].resolve([]);
  assert.equal((await later).status, 200);
  assert.equal(fetchCalls, 2);
});

test('rejected all-news and coin-news fetches clear their in-flight entries for retry', async t => {
  let allFetchCalls = 0;
  let coinFetchCalls = 0;
  const server = createAccumulatorServer({
    newsMonitor: {
      async fetchAllNews() {
        allFetchCalls++;
        if (allFetchCalls === 1) throw new Error('synthetic all-news failure');
        return [];
      },
      async fetchCoinSpecificNews() {
        coinFetchCalls++;
        if (coinFetchCalls === 1) throw new Error('synthetic coin-news failure');
        return [];
      },
      async getCoinSentiment(market) {
        return { coin: market, overall: 'neutral', score: 0 };
      },
      analyzeMarketSentiment(news) {
        return { overall: 'neutral', score: 0, newsCount: news.length };
      }
    }
  });
  const routes = await startNewsRoutes(t, server);

  assert.equal((await getJson(`${routes.baseUrl}/api/news`)).status, 200);
  assert.equal(allFetchCalls, 1);
  assert.equal((await getJson(`${routes.baseUrl}/api/news`)).status, 200);
  assert.equal(allFetchCalls, 2);

  assert.equal((await getJson(`${routes.baseUrl}/api/news/ETH`)).status, 500);
  assert.equal(coinFetchCalls, 1);
  assert.equal((await getJson(`${routes.baseUrl}/api/news/ETH`)).status, 200);
  assert.equal(coinFetchCalls, 2);
});
