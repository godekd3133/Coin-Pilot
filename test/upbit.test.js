import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import UpbitAPI from '../src/api/upbit.js';

class ImmediateScheduler {
  constructor() {
    this.calls = [];
    this.backoffs = [];
    this.backoffOptions = [];
    this.inFlight = new Set();
  }

  async schedule(run, options) {
    const request = { ...options };
    this.calls.push(request);
    this.inFlight.add(request);
    try {
      return await run(123);
    } finally {
      this.inFlight.delete(request);
    }
  }

  applyBackoff(delayMs, options) {
    this.backoffs.push(delayMs);
    this.backoffOptions.push(options);
  }

  getStatus() {
    const inFlight = { normal: 0, risk: 0 };
    for (const request of this.inFlight) inFlight[request.priority] += 1;
    return {
      queued: { normal: 0, risk: 0 },
      queuedTotal: 0,
      inFlight,
      inFlightTotal: this.inFlight.size,
      oldestWaitAgeMs: { normal: null, risk: null },
      nextStartInMs: 0,
      backoffRemainingMs: 0,
      maxInFlight: 4,
      maxInFlightByPriority: { normal: 3, risk: 4 },
      maxQueuedByPriority: { normal: 64, risk: 16 }
    };
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('Upbit 네트워크 스트림 오류는 재시도 후 성공할 수 있다', async () => {
  const api = new UpbitAPI('', '');
  let attempts = 0;

  const result = await api.requestWithRetry(async () => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error('simulated broken pipe');
      error.code = 'EPIPE';
      throw error;
    }
    return { ok: true };
  }, 2);

  assert.deepEqual(result, { ok: true });
  assert.equal(attempts, 2);
});

test('Upbit 시세 요청은 무한 대기를 막기 위한 timeout을 전달한다', async () => {
  const api = new UpbitAPI('', '');
  let requestConfig;
  const originalGet = axios.get;
  axios.get = async (_url, config) => {
    requestConfig = config;
    return { data: [] };
  };

  try {
    await api.getTicker('KRW-BTC');
  } finally {
    axios.get = originalGet;
  }

  assert.ok(Number.isFinite(requestConfig?.timeout));
  assert.ok(requestConfig.timeout > 0);
});

test('동시 read-only 실험은 요청 간격을 늘려 공개 API rate limit 여유를 확보할 수 있다', () => {
  const api = new UpbitAPI('', '', { minRequestIntervalMs: 250 });
  assert.equal(api.minRequestInterval, 250);
  assert.equal(api.queueInterval, 250);
});

test('분석 클라이언트와 리스크 클라이언트가 요청 슬롯을 공유한다', async () => {
  const marketApi = new UpbitAPI('', '');
  const riskApi = new UpbitAPI('', '');
  const requestTimes = [];

  await Promise.all([
    marketApi.requestWithRetry(async () => {
      requestTimes.push(Date.now());
      return { source: 'market' };
    }, 1),
    riskApi.requestWithRetry(async () => {
      requestTimes.push(Date.now());
      return { source: 'risk' };
    }, 1)
  ]);

  requestTimes.sort((a, b) => a - b);
  assert.equal(requestTimes.length, 2);
  assert.ok(requestTimes[1] - requestTimes[0] >= 100);
});

test('risk 요청은 이미 쌓인 분석 backlog보다 먼저 다음 rate-limit 슬롯을 얻는다', async () => {
  const marketApi = new UpbitAPI('', '', { minRequestIntervalMs: 250 });
  const riskApi = new UpbitAPI('', '', { minRequestIntervalMs: 250 });
  const events = [];
  const request = (api, label, options) => api.requestWithRetry(async () => {
    events.push(label);
    return { label };
  }, 1, options);

  const normalRequests = [
    request(marketApi, 'analysis-0'),
    request(marketApi, 'analysis-1'),
    request(marketApi, 'analysis-2'),
    request(marketApi, 'analysis-3')
  ];
  await new Promise(resolve => setImmediate(resolve));
  const riskRequest = request(riskApi, 'risk', { priority: 'risk' });

  await Promise.all([...normalRequests, riskRequest]);

  assert.ok(events.indexOf('risk') >= 0);
  assert.ok(events.indexOf('risk') < events.indexOf('analysis-3'));
});

test('ticker 호출은 risk priority 옵션을 requestWithRetry까지 전달한다', async () => {
  const api = new UpbitAPI('', '');
  let requestOptions;
  api.requestWithRetry = async (_requestFn, _maxRetries, options) => {
    requestOptions = options;
    return [];
  };

  await api.getTicker('KRW-BTC', { priority: 'risk' });

  assert.deepEqual(requestOptions, {
    priority: 'risk',
    rateLimitGroup: 'ticker',
    rateLimitScope: 'ip'
  });
});

test('getMarkets is admitted through the injected shared scheduler until Axios settles', async () => {
  const scheduler = new ImmediateScheduler();
  const response = deferred();
  const axiosDouble = {
    get: async () => response.promise
  };
  const api = new UpbitAPI('', '', { scheduler, axios: axiosDouble });
  const marketsPromise = api.getMarkets();

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(scheduler.calls.length, 1);
  assert.equal(scheduler.calls[0].priority, 'normal');
  assert.equal(scheduler.getStatus().inFlightTotal, 1);
  assert.equal(api.getQueueStatus().inFlightTotal, 1);

  response.resolve({ data: [{ market: 'KRW-BTC' }] });
  assert.deepEqual(await marketsPromise, [{ market: 'KRW-BTC' }]);
  assert.equal(scheduler.getStatus().inFlightTotal, 0);
});

test('minute candles pass an optional `to` cursor through the candle/IP scheduler lane and enforce request bounds', async () => {
  const scheduler = new ImmediateScheduler();
  const cursor = '2026-09-29T12:00:00';
  let requestUrl;
  let requestConfig;
  const api = new UpbitAPI('', '', {
    scheduler,
    requestTimeoutMs: 4321,
    axios: {
      get: async (url, config) => {
        requestUrl = url;
        requestConfig = config;
        return { data: [{ market: 'KRW-BTC', candle_date_time_utc: cursor }] };
      }
    }
  });

  const result = await api.getMinuteCandles('KRW-BTC', 15, 200, { to: cursor });

  assert.deepEqual(result, [{ market: 'KRW-BTC', candle_date_time_utc: cursor }]);
  assert.equal(requestUrl, 'https://api.upbit.com/v1/candles/minutes/15');
  assert.deepEqual(requestConfig.params, { market: 'KRW-BTC', count: 200, to: cursor });
  assert.equal(requestConfig.timeout, 4321);
  assert.equal(scheduler.calls.length, 1);
  assert.deepEqual({
    priority: scheduler.calls[0].priority,
    rateLimitGroup: scheduler.calls[0].rateLimitGroup,
    rateLimitScope: scheduler.calls[0].rateLimitScope
  }, { priority: 'normal', rateLimitGroup: 'candle', rateLimitScope: 'ip' });

  await assert.rejects(
    () => api.getMinuteCandles('KRW-BTC', 15, 0),
    /integer from 1 to 200/
  );
  await assert.rejects(
    () => api.getMinuteCandles('KRW-BTC', 15, 201),
    /integer from 1 to 200/
  );
  assert.equal(scheduler.calls.length, 1, 'invalid page sizes must not enter the scheduler');
});

test('day candles pass an optional `to` cursor through the candle/IP scheduler lane and observe Remaining-Req', async () => {
  const scheduler = new ImmediateScheduler();
  scheduler.now = () => 12_345;
  const cursor = '2026-09-28T00:00:00';
  const candleData = [{ market: 'KRW-BTC', candle_date_time_utc: cursor }];
  let requestUrl;
  let requestConfig;
  const api = new UpbitAPI('', '', {
    scheduler,
    requestTimeoutMs: 4321,
    axios: {
      get: async (url, config) => {
        requestUrl = url;
        requestConfig = config;
        return {
          data: candleData,
          headers: { 'remaining-req': 'group=candle; min=1; sec=0' }
        };
      }
    }
  });

  assert.deepEqual(await api.getDayCandles('KRW-BTC', 200, { to: cursor }), candleData);
  assert.equal(requestUrl, 'https://api.upbit.com/v1/candles/days');
  assert.deepEqual(requestConfig.params, { market: 'KRW-BTC', count: 200, to: cursor });
  assert.equal(requestConfig.timeout, 4321);
  assert.deepEqual({
    priority: scheduler.calls[0].priority,
    rateLimitGroup: scheduler.calls[0].rateLimitGroup,
    rateLimitScope: scheduler.calls[0].rateLimitScope
  }, { priority: 'normal', rateLimitGroup: 'candle', rateLimitScope: 'ip' });
  assert.deepEqual(scheduler.backoffs, [655]);
  assert.deepEqual(scheduler.backoffOptions, [{ rateLimitGroup: 'candle', rateLimitScope: 'ip' }]);

  await assert.rejects(
    () => api.getDayCandles('KRW-BTC', 200, { to: '  ' }),
    /day candle cursor must be a non-empty string/
  );
  await assert.rejects(
    () => api.getDayCandles('KRW-BTC', 200, { to: 123 }),
    /day candle cursor must be a non-empty string/
  );
  assert.equal(scheduler.calls.length, 1, 'invalid cursors must not enter the scheduler');
});

test('getOrderbook accepts market arrays or strings and uses the orderbook/IP scheduler lane', async () => {
  const scheduler = new ImmediateScheduler();
  const responses = [
    [{ market: 'KRW-BTC', orderbook_units: [{ ask_price: 100, bid_price: 99 }] }],
    [{ market: 'KRW-ETH', orderbook_units: [{ ask_price: 200, bid_price: 199 }] }]
  ];
  const requests = [];
  const api = new UpbitAPI('', '', {
    scheduler,
    requestTimeoutMs: 4321,
    axios: {
      get: async (url, config) => {
        requests.push({ url, config });
        return { data: responses[requests.length - 1] };
      }
    }
  });

  const multiMarketData = await api.getOrderbook(['KRW-BTC', 'KRW-ETH']);
  const singleMarketData = await api.getOrderbook('KRW-ETH');

  assert.deepEqual(multiMarketData, responses[0]);
  assert.deepEqual(singleMarketData, responses[1]);
  assert.equal(requests[0].url, 'https://api.upbit.com/v1/orderbook');
  assert.deepEqual(requests[0].config.params, { markets: 'KRW-BTC,KRW-ETH' });
  assert.equal(axios.getUri({ url: requests[0].url, params: requests[0].config.params }),
    'https://api.upbit.com/v1/orderbook?markets=KRW-BTC,KRW-ETH');
  assert.deepEqual(requests[1].config.params, { markets: 'KRW-ETH' });
  assert.equal(requests[0].config.timeout, 4321);
  assert.equal(requests[1].config.timeout, 4321);
  assert.deepEqual(scheduler.calls.map(({ priority, rateLimitGroup, rateLimitScope }) => ({
    priority,
    rateLimitGroup,
    rateLimitScope
  })), [
    { priority: 'normal', rateLimitGroup: 'orderbook', rateLimitScope: 'ip' },
    { priority: 'normal', rateLimitGroup: 'orderbook', rateLimitScope: 'ip' }
  ]);
});

test('getOrderbook observes Remaining-Req and applies the orderbook/IP second-boundary cooldown', async () => {
  const scheduler = new ImmediateScheduler();
  scheduler.now = () => 12_345;
  const orderbookData = [{ market: 'KRW-BTC', orderbook_units: [] }];
  const api = new UpbitAPI('', '', {
    scheduler,
    axios: {
      get: async () => ({
        data: orderbookData,
        headers: { 'remaining-req': 'group=orderbook; min=1; sec=0' }
      })
    }
  });

  assert.deepEqual(await api.getOrderbook('KRW-BTC'), orderbookData);
  assert.deepEqual(scheduler.backoffs, [655]);
  assert.deepEqual(scheduler.backoffOptions, [{ rateLimitGroup: 'orderbook', rateLimitScope: 'ip' }]);
});

test('getOrderbook retries 429 responses and applies backoff in the orderbook/IP lane', async () => {
  const scheduler = new ImmediateScheduler();
  let attempts = 0;
  const orderbookData = [{ market: 'KRW-BTC', orderbook_units: [] }];
  const api = new UpbitAPI('', '', {
    scheduler,
    random: () => 0,
    axios: {
      get: async () => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error('rate limited');
          error.response = {
            status: 429,
            headers: { 'retry-after': '0', 'remaining-req': 'group=orderbook; min=1; sec=0' },
            data: { error: { name: 'too_many_requests' } }
          };
          throw error;
        }
        return { data: orderbookData };
      }
    }
  });
  const originalLog = console.log;
  console.log = () => {};
  try {
    assert.deepEqual(await api.getOrderbook('KRW-BTC'), orderbookData);
  } finally {
    console.log = originalLog;
  }

  assert.equal(attempts, 2);
  assert.equal(scheduler.calls.length, 2);
  assert.deepEqual(scheduler.backoffs, [2000]);
  assert.deepEqual(scheduler.backoffOptions, [{ rateLimitGroup: 'orderbook', rateLimitScope: 'ip' }]);
});

test('getMarkets rejects its final 429 response and retains shared Retry-After backoff', async () => {
  const scheduler = new ImmediateScheduler();
  let attempts = 0;
  const axiosDouble = {
    get: async () => {
      attempts += 1;
      const error = new Error('rate limited');
      error.response = {
        status: 429,
        headers: { 'retry-after': '0' },
        data: { error: { name: 'too_many_requests' } }
      };
      throw error;
    }
  };
  const api = new UpbitAPI('', '', { scheduler, axios: axiosDouble, random: () => 0 });
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};

  try {
    await assert.rejects(api.getMarkets(), error => error.response?.status === 429);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.equal(attempts, 3);
  assert.equal(scheduler.calls.length, 3);
  assert.deepEqual(scheduler.backoffs, [2000, 4000, 8000]);
  assert.deepEqual(scheduler.backoffOptions, [
    { rateLimitGroup: 'market', rateLimitScope: 'ip' },
    { rateLimitGroup: 'market', rateLimitScope: 'ip' },
    { rateLimitGroup: 'market', rateLimitScope: 'ip' }
  ]);
});

test('HTTP 418 without a trusted duration fails immediately and applies the shared fallback cooldown', async () => {
  const scheduler = new ImmediateScheduler();
  let attempts = 0;
  const api = new UpbitAPI('', '', {
    scheduler,
    random: () => 0,
    axios: {
      get: async () => {
        attempts += 1;
        const error = new Error('temporarily blocked');
        error.response = { status: 418, headers: {}, data: { error: { name: 'blocked' } } };
        throw error;
      }
    }
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(api.getMarkets(), error => error.response?.status === 418);
  } finally {
    console.error = originalError;
  }

  assert.equal(attempts, 1);
  assert.deepEqual(scheduler.backoffs, [5 * 60 * 1000]);
  assert.deepEqual(scheduler.backoffOptions, [{
    rateLimitScope: 'ip',
    rateLimitScopeWide: true
  }]);
});

test('account and order-state methods default to the shared risk lane', async () => {
  const scheduler = new ImmediateScheduler();
  const axiosDouble = {
    get: async () => ({ data: [] }),
    delete: async () => ({ data: {} }),
    post: async () => ({ data: { uuid: 'mock-order' } })
  };
  const api = new UpbitAPI('mock-access', 'mock-secret', { scheduler, axios: axiosDouble });

  await api.getAccounts();
  await api.getOrders('KRW-BTC', ['wait', 'watch']);
  await api.getOrder('mock-order');
  await api.cancelOrder('mock-order');
  await api.order('KRW-BTC', 'bid', 5000, null, 'price', '11111111-2222-4333-8444-555555555555');

  assert.deepEqual(scheduler.calls.map(call => call.priority), [
    'risk', 'risk', 'risk', 'risk', 'risk'
  ]);
});

test('Upbit order admission failures before callback dispatch are explicit no-send results', async () => {
  for (const code of [
    'UPBIT_QUEUE_FULL',
    'UPBIT_QUEUE_TIMEOUT',
    'UPBIT_REQUEST_ABORTED',
    'UPBIT_REQUEST_DEADLINE'
  ]) {
    const scheduler = {
      schedule: async () => {
        throw Object.assign(new Error(`pre-dispatch ${code}`), { code });
      }
    };
    let axiosPostCalls = 0;
    const api = new UpbitAPI('mock-access', 'mock-secret', {
      scheduler,
      axios: {
        post: async () => {
          axiosPostCalls += 1;
          return { data: { uuid: 'must-not-exist' } };
        }
      }
    });

    const result = await api.order(
      'KRW-BTC', 'bid', 5_000, null, 'price', 'pre-dispatch-intent'
    );

    assert.equal(result.success, false);
    assert.equal(result.error.code, 'upbit_request_not_dispatched');
    assert.equal(result.error.dispatched, false);
    assert.equal(result.error.schedulerCode, code);
    assert.match(result.error.message, /전송되지 않았습니다/);
    assert.equal(axiosPostCalls, 0);
  }
});

test('open-order query includes wait and watch states with a matching JWT query hash', async () => {
  const api = new UpbitAPI('mock-access', 'mock-secret');
  api.requestWithRetry = async request => request();
  api.waitForRateLimit = async () => {};
  let requestConfig;
  const originalGet = axios.get;
  axios.get = async (_url, config) => {
    requestConfig = config;
    return { data: [] };
  };

  try {
    await api.getOrders('KRW-BTC', ['wait', 'watch']);
  } finally {
    axios.get = originalGet;
  }

  assert.deepEqual(requestConfig.params, {
    market: 'KRW-BTC',
    'states[]': ['wait', 'watch']
  });
  assert.equal(
    axios.getUri({ url: '/orders', params: requestConfig.params }),
    '/orders?market=KRW-BTC&states%5B%5D=wait&states%5B%5D=watch'
  );
  const authorization = requestConfig.headers.Authorization;
  const token = authorization.replace(/^Bearer /, '');
  const decoded = jwt.decode(token, { complete: true });
  const tokenPayload = jwt.verify(token, 'mock-secret', { algorithms: ['HS512'] });
  const expectedHash = crypto.createHash('sha512')
    .update('market=KRW-BTC&states[]=wait&states[]=watch', 'utf8')
    .digest('hex');
  assert.equal(decoded.header.alg, 'HS512');
  assert.equal(tokenPayload.query_hash, expectedHash);
});

test('LIVE order identifier and POST body are included in an HS512-signed query hash', async () => {
  const api = new UpbitAPI('mock-access', 'mock-secret');
  api.waitForRateLimit = async () => {};
  let requestBody;
  let requestConfig;
  const originalPost = axios.post;
  axios.post = async (_url, body, config) => {
    requestBody = body;
    requestConfig = config;
    return { data: { uuid: 'mock-order-uuid', identifier: body.identifier } };
  };

  try {
    const result = await api.order(
      'KRW-BTC',
      'bid',
      5000,
      null,
      'price',
      '11111111-2222-4333-8444-555555555555'
    );
    assert.equal(result.success, true);
  } finally {
    axios.post = originalPost;
  }

  assert.deepEqual(requestBody, {
    market: 'KRW-BTC',
    side: 'bid',
    ord_type: 'price',
    identifier: '11111111-2222-4333-8444-555555555555',
    price: '5000'
  });
  const token = requestConfig.headers.Authorization.replace(/^Bearer /, '');
  const decoded = jwt.decode(token, { complete: true });
  const tokenPayload = jwt.verify(token, 'mock-secret', { algorithms: ['HS512'] });
  const expectedHash = crypto.createHash('sha512')
    .update('market=KRW-BTC&side=bid&ord_type=price&identifier=11111111-2222-4333-8444-555555555555&price=5000', 'utf8')
    .digest('hex');

  assert.equal(decoded.header.alg, 'HS512');
  assert.equal(tokenPayload.query_hash, expectedHash);
  assert.equal(tokenPayload.query_hash_alg, 'SHA512');
});
