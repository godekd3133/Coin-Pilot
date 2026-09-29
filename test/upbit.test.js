import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import UpbitAPI from '../src/api/upbit.js';

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

  assert.deepEqual(requestOptions, { priority: 'risk' });
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
  const tokenPayload = jwt.decode(authorization.replace(/^Bearer /, ''));
  const expectedHash = crypto.createHash('sha512')
    .update('market=KRW-BTC&states[]=wait&states[]=watch', 'utf8')
    .digest('hex');
  assert.equal(tokenPayload.query_hash, expectedHash);
});
