import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import DashboardServer from '../src/api/dashboardServer.js';
import {
  createDashboardAuth,
  createLoginRateLimiter,
  createOriginGuard,
  resolveDashboardAuth,
  safeTokenEqual
} from '../src/api/auth.js';
import { createMockTrader } from '../src/scripts/runDashboard.js';

function authOffEnv() {
  return { ...process.env, DASHBOARD_TOKEN: '', DASHBOARD_READ_ONLY_TOKEN: '', DASHBOARD_MOBILE_TOKEN: '', DASHBOARD_HOST: '', DASHBOARD_ALLOW_INSECURE: '' };
}

async function startDashboard(env, options = {}) {
  const trader = createMockTrader();
  const dashboard = new DashboardServer(trader, 0, {
    env: { ...authOffEnv(), ...env },
    ...options
  });
  const httpServer = await dashboard.start();
  const address = httpServer.address();
  return { dashboard, trader, httpServer, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopDashboard({ dashboard, trader }) {
  const closed = dashboard.httpServer?.listening
    ? once(dashboard.httpServer, 'close')
    : Promise.resolve();
  await dashboard.stop();
  trader.stop();
  await closed;
}

// ----------------------------------------------------------- policy resolution
test('DASHBOARD_TOKEN이 있으면 인증 활성 + 기본 0.0.0.0 바인딩', () => {
  const resolved = resolveDashboardAuth({ DASHBOARD_TOKEN: 'secret' });
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.host, '0.0.0.0');
  assert.equal(resolved.warnings.length, 0);
});

test('읽기 전용 토큰만 설정해도 인증이 활성화되고 전체 토큰과 같으면 거부된다', () => {
  const resolved = resolveDashboardAuth({ DASHBOARD_READ_ONLY_TOKEN: 'monitor-secret' });
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.host, '0.0.0.0');
  assert.throws(
    () => resolveDashboardAuth({ DASHBOARD_TOKEN: 'same-secret', DASHBOARD_READ_ONLY_TOKEN: 'same-secret' }),
    error => error.message === 'DASHBOARD_READ_ONLY_TOKEN must differ from DASHBOARD_TOKEN.'
  );
});

test('토큰 없으면 루프백 바인딩으로 강제 + 경고', () => {
  const resolved = resolveDashboardAuth({});
  assert.equal(resolved.enabled, false);
  assert.equal(resolved.host, '127.0.0.1');
  assert.ok(resolved.warnings.some(w => w.includes('DASHBOARD_TOKEN')));
});

test('토큰 없이 비루프백 DASHBOARD_HOST 요청은 거부된다', () => {
  const resolved = resolveDashboardAuth({ DASHBOARD_HOST: '0.0.0.0' });
  assert.equal(resolved.host, '127.0.0.1');
  assert.ok(resolved.warnings.length >= 2);
});

test('DASHBOARD_ALLOW_INSECURE는 명시적 opt-out으로 비루프백을 허용한다', () => {
  const resolved = resolveDashboardAuth({ DASHBOARD_ALLOW_INSECURE: 'true' });
  assert.equal(resolved.host, '0.0.0.0');
  assert.equal(resolved.enabled, false);
});

test('토큰이 있으면 DASHBOARD_HOST를 그대로 존중한다', () => {
  const resolved = resolveDashboardAuth({ DASHBOARD_TOKEN: 't', DASHBOARD_HOST: '192.168.0.10' });
  assert.equal(resolved.host, '192.168.0.10');
});

test('DASHBOARD_CORS_ORIGINS는 쉼표 구분 allowlist로 파싱된다', () => {
  const resolved = resolveDashboardAuth({ DASHBOARD_TOKEN: 't', DASHBOARD_CORS_ORIGINS: 'https://a.com, https://b.com' });
  assert.deepEqual(resolved.corsOrigins, ['https://a.com', 'https://b.com']);
});

// ---------------------------------------------------------------- token check
test('safeTokenEqual은 timing-safe 비교를 사용한다', () => {
  assert.equal(safeTokenEqual('abc', 'abc'), true);
  assert.equal(safeTokenEqual('abc', 'abd'), false);
  assert.equal(safeTokenEqual('abc', 'abcd'), false);
  assert.equal(safeTokenEqual('', 'abc'), false);
  assert.equal(safeTokenEqual('abc', ''), false);
});

// ------------------------------------------------------------- rate limiter
test('로그인 rate limiter는 연속 실패 후 임시 차단한다', () => {
  let at = 1_000;
  const limiter = createLoginRateLimiter({ maxFailures: 3, windowMs: 60_000, blockMs: 60_000, now: () => at });
  assert.equal(limiter.blockedUntil('ip'), 0);
  limiter.recordFailure('ip');
  limiter.recordFailure('ip');
  limiter.recordFailure('ip');
  assert.ok(limiter.blockedUntil('ip') > at);
  at += 61_000;
  assert.equal(limiter.blockedUntil('ip'), 0);
});

test('로그인 성공은 실패 카운터를 리셋한다', () => {
  const limiter = createLoginRateLimiter({ maxFailures: 2, now: () => 5_000 });
  limiter.recordFailure('ip');
  limiter.recordSuccess('ip');
  limiter.recordFailure('ip');
  assert.equal(limiter.blockedUntil('ip'), 0);
});

test('로그인 실패 상태는 IP 수에 상한을 두고 만료된 항목을 회수한다', () => {
  let at = 1_000;
  const limiter = createLoginRateLimiter({
    maxFailures: 10,
    windowMs: 100,
    blockMs: 100,
    maxTrackedIps: 2,
    now: () => at
  });

  assert.equal(limiter.blockedUntil('unseen'), 0, 'read-only status checks must not allocate an address entry');
  assert.equal(limiter.recordFailure('ip-a'), true);
  assert.equal(limiter.recordFailure('ip-b'), true);
  assert.equal(limiter.recordFailure('ip-c'), false, 'a full limiter must reject a new address instead of growing memory');

  at += 101;
  assert.equal(limiter.recordFailure('ip-c'), true, 'expired address entries must be reclaimed before admitting a new one');
  assert.equal(limiter.capacityRetryAfterSeconds(), 1);
});

test('loopback reverse proxy login failures are isolated by client address and ignore older forwarded hops', async () => {
  const context = await startDashboard({ DASHBOARD_TOKEN: 'operator-secret' }, {
    loginRateLimiter: { maxFailures: 1, windowMs: 60_000, blockMs: 60_000 }
  });
  try {
    assert.equal(context.dashboard.app.get('trust proxy'), 'loopback');
    const login = xForwardedFor => fetch(`${context.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Mirrors Nginx appending $remote_addr to an untrusted incoming XFF.
        'x-forwarded-for': xForwardedFor
      },
      body: JSON.stringify({ token: 'invalid-token' })
    });

    assert.equal((await login('198.51.100.99, 203.0.113.10')).status, 401);
    assert.equal((await login('198.51.100.99, 203.0.113.11')).status, 401,
      'another proxied client does not inherit the first client’s lockout');
    assert.equal((await login('198.51.100.88, 203.0.113.10')).status, 429,
      'only the same appended client address hits its lockout');
  } finally {
    await stopDashboard(context);
  }
});

// -------------------------------------------------------------- origin guard
test('origin guard는 same-origin과 allowlist만 허용한다', () => {
  const guard = createOriginGuard(['https://allowed.example']);
  assert.equal(guard.isOriginAllowed(undefined, 'h:1'), true);
  assert.equal(guard.isOriginAllowed('http://192.168.0.5:3000', '192.168.0.5:3000'), true);
  assert.equal(guard.isOriginAllowed('https://allowed.example', 'other:1'), true);
  assert.equal(guard.isOriginAllowed('http://evil.example', 'h:1'), false);
  assert.equal(guard.isOriginAllowed('not a url', 'h:1'), false);
});

// ------------------------------------------------------------ socket guard
test('socket middleware는 토큰 없이 거부하고 운영·모바일 토큰은 통과한다', () => {
  const auth = createDashboardAuth({
    DASHBOARD_TOKEN: 'tok',
    DASHBOARD_READ_ONLY_TOKEN: 'monitor-tok',
    DASHBOARD_MOBILE_TOKEN: 'native-mobile-tok'
  });
  const rejected = new Promise(resolve => {
    auth.socketMiddleware({ handshake: { auth: {}, headers: {} } }, resolve);
  });
  const accepted = new Promise(resolve => {
    auth.socketMiddleware({ handshake: { auth: { token: 'tok' }, headers: {} } }, resolve);
  });
  const bearerHeader = new Promise(resolve => {
    auth.socketMiddleware(
      { handshake: { auth: {}, headers: { authorization: 'Bearer tok' } } },
      resolve
    );
  });
  const mobileAccepted = new Promise(resolve => {
    auth.socketMiddleware({ handshake: { auth: { token: 'native-mobile-tok' }, headers: {} } }, resolve);
  });
  const readOnlyRejected = new Promise(resolve => {
    auth.socketMiddleware({ handshake: { auth: { token: 'monitor-tok' }, headers: {} } }, resolve);
  });
  return Promise.all([rejected, accepted, bearerHeader, mobileAccepted, readOnlyRejected])
    .then(([rej, ok, bearer, mobile, readOnly]) => {
      assert.ok(rej instanceof Error);
      assert.equal(ok, undefined);
      assert.equal(bearer, undefined);
      assert.equal(mobile, undefined);
      assert.ok(readOnly instanceof Error);
    });
});

test('읽기 전용 토큰은 정확한 경로, 메서드, 쿼리만 허용한다', () => {
  const auth = createDashboardAuth({ DASHBOARD_TOKEN: 'full-token', DASHBOARD_READ_ONLY_TOKEN: 'read-token' });
  const invoke = (method, url, token = 'read-token') => {
    let status;
    let body;
    let nextCalled = false;
    const response = {
      status(value) { status = value; return this; },
      json(value) { body = value; return this; }
    };
    auth.middleware({ method, originalUrl: url, headers: { authorization: `Bearer ${token}` } }, response, () => {
      nextCalled = true;
    });
    return { status, body, nextCalled };
  };

  for (const url of [
    '/api/status',
    '/api/account',
    '/api/cumulative-pnl',
    '/api/today-summary',
    '/api/market/prices',
    '/api/market/prices/snapshot',
    '/api/paper-validation/summary',
    '/api/portfolio/history?period=24h',
    '/api/portfolio/history?period=7d',
    '/api/portfolio/history?period=30d',
    '/api/trades?limit=1',
    '/api/trades?limit=50'
  ]) {
    assert.equal(invoke('GET', url).nextCalled, true, `${url} should be allowed`);
  }

  for (const [method, url] of [
    ['GET', '/api/positions'],
    ['GET', '/api/paper-validation'],
    ['GET', '/api/paper-validation/summary?extra=1'],
    ['GET', '/api/market/prices/snapshot?extra=1'],
    ['GET', '/api/status?extra=1'],
    ['GET', '/api/portfolio/history?period=1h'],
    ['GET', '/api/portfolio/history?period=24h&period=7d'],
    ['GET', '/api/trades'],
    ['GET', '/api/trades?limit=0'],
    ['GET', '/api/trades?limit=51'],
    ['GET', '/api/trades?limit=5&extra=1'],
    ['POST', '/api/status'],
    ['POST', '/api/paper-validation/start'],
    ['POST', '/api/paper-validation/stop'],
    ['HEAD', '/api/status']
  ]) {
    const result = invoke(method, url);
    assert.equal(result.status, 403, `${method} ${url} should be forbidden`);
    assert.equal(result.body.success, false);
  }

  assert.equal(invoke('POST', '/api/control/start', 'full-token').nextCalled, true);
});

test('모바일 운영 토큰은 공개 시세 snapshot 읽기를 허용한다', () => {
  const auth = createDashboardAuth({ DASHBOARD_TOKEN: 'full-token', DASHBOARD_MOBILE_TOKEN: 'mobile-token' });
  const invoke = url => {
    let status;
    let nextCalled = false;
    const response = {
      status(value) { status = value; return this; },
      json() { return this; }
    };
    auth.middleware({ method: 'GET', originalUrl: url, headers: { authorization: 'Bearer mobile-token' } }, response, () => {
      nextCalled = true;
    });
    return { status, nextCalled };
  };

  assert.equal(invoke('/api/market/prices/snapshot').nextCalled, true);
  assert.equal(invoke('/api/stream').nextCalled, true,
    'The mobile scope should open the server-sent event stream');
  assert.equal(invoke('/api/system-status').nextCalled, true);
  assert.equal(invoke('/api/coin-detail/KRW-BTC').nextCalled, true);
  assert.deepEqual(invoke('/api/coin-detail/BTC'), { status: 403, nextCalled: false });
  assert.deepEqual(invoke('/api/market/prices/snapshot?extra=1'), { status: 403, nextCalled: false });
});

test('모바일 운영 토큰은 대상 마켓·포지션 상한 설정 변경을 허용한다', () => {
  const auth = createDashboardAuth({ DASHBOARD_TOKEN: 'full-token', DASHBOARD_MOBILE_TOKEN: 'mobile-token' });
  const invoke = body => {
    let status;
    let nextCalled = false;
    const response = {
      status(value) { status = value; return this; },
      json() { return this; }
    };
    auth.middleware({
      method: 'POST',
      originalUrl: '/api/config/update',
      headers: { authorization: 'Bearer mobile-token' },
      body
    }, response, () => {
      nextCalled = true;
    });
    return { status, nextCalled };
  };

  for (const body of [
    { targetCoins: ['KRW-BTC', 'KRW-ETH'] },
    { targetCoins: 'ALL' },
    { scalpMaxMarkets: 20 },
    { maxPositions: 3 },
    { targetCoins: ['KRW-BTC'], scalpMaxMarkets: 10, maxPositions: 2 }
  ]) {
    assert.equal(invoke(body).nextCalled, true, `body ${JSON.stringify(body)} should be allowed`);
  }

  for (const body of [
    { targetCoins: ['BTC'] },
    { targetCoins: [] },
    { targetCoins: 'ALL', secretKey: 'x' },
    { scalpMaxMarkets: 'ALL' },
    { apiKey: 'x' }
  ]) {
    assert.equal(invoke(body).status, 403, `body ${JSON.stringify(body)} should be forbidden`);
  }
});

test('모바일 토큰은 /api/stream SSE를 열고 유니버스 설정을 런타임에 적용한다', async () => {
  const ctx = await startDashboard({
    DASHBOARD_TOKEN: 'full-secret',
    DASHBOARD_MOBILE_TOKEN: 'mobile-secret'
  });
  try {
    const unauthenticated = await fetch(`${ctx.baseUrl}/api/stream`);
    assert.equal(unauthenticated.status, 401);

    const controller = new AbortController();
    const stream = await fetch(`${ctx.baseUrl}/api/stream`, {
      headers: { Authorization: 'Bearer mobile-secret' },
      signal: controller.signal
    });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type'), /text\/event-stream/);

    const update = await fetch(`${ctx.baseUrl}/api/config/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer mobile-secret' },
      body: JSON.stringify({ targetCoins: ['KRW-ETH'], scalpMaxMarkets: 7, maxPositions: 2 })
    });
    const updated = await update.json();
    assert.equal(update.status, 200);
    assert.equal(updated.success, true);
    assert.deepEqual(updated.universe, { targetCoins: ['KRW-ETH'], scalpMaxMarkets: 7, maxPositions: 2 });
    assert.deepEqual(ctx.trader.targetCoins, ['KRW-ETH']);
    assert.equal(ctx.trader.maxPositions, 2);
    assert.equal(ctx.trader.config.maxScalpMarkets, 7);

    const allUpdate = await fetch(`${ctx.baseUrl}/api/config/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer mobile-secret' },
      body: JSON.stringify({ targetCoins: 'ALL' })
    });
    const allBody = await allUpdate.json();
    assert.equal(allUpdate.status, 200);
    assert.deepEqual(allBody.universe.targetCoins.sort(), ['KRW-BTC', 'KRW-ETH']);

    const invalid = await fetch(`${ctx.baseUrl}/api/config/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer mobile-secret' },
      body: JSON.stringify({ scalpMaxMarkets: 0 })
    });
    assert.equal(invalid.status, 400);

    const reader = stream.body.getReader();
    let received = '';
    while (!received.includes('event: connected')) {
      const { done, value } = await reader.read();
      if (done) break;
      received += new TextDecoder().decode(value);
    }
    assert.ok(received.includes('event: connected'));
    controller.abort();
  } finally {
    await stopDashboard(ctx);
  }
});

// --------------------------------------------------- integration: auth enabled
test('인증 활성 서버는 /api/*를 토큰 없이 401로 거부한다', async () => {
  const ctx = await startDashboard({ DASHBOARD_TOKEN: 'test-secret' });
  try {
    const statusRes = await fetch(`${ctx.baseUrl}/api/auth/status`);
    assert.equal(statusRes.status, 200);
    assert.deepEqual(await statusRes.json(), { success: true, authRequired: true });

    const noAuth = await fetch(`${ctx.baseUrl}/api/status`);
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.headers.get('www-authenticate'), 'Bearer realm="coinpilot-dashboard"');
    const noAuthBody = await noAuth.json();
    assert.equal(noAuthBody.authRequired, true);

    const wrongAuth = await fetch(`${ctx.baseUrl}/api/status`, {
      headers: { Authorization: 'Bearer wrong' }
    });
    assert.equal(wrongAuth.status, 401);

    const goodAuth = await fetch(`${ctx.baseUrl}/api/status`, {
      headers: { Authorization: 'Bearer test-secret' }
    });
    assert.equal(goodAuth.status, 200);
  } finally {
    await stopDashboard(ctx);
  }
});

test('읽기 전용 토큰은 네이티브 모니터 경로만 조회하고 전체 토큰은 기존 경로를 유지한다', async () => {
  const ctx = await startDashboard({
    DASHBOARD_TOKEN: 'full-secret',
    DASHBOARD_READ_ONLY_TOKEN: 'monitor-secret'
  });
  const readHeaders = { Authorization: 'Bearer monitor-secret' };
  const adminHeaders = { Authorization: 'Bearer full-secret' };
  try {
    ctx.trader.paperValidation = {
      active: false,
      processId: 1234,
      configSnapshotComplete: true,
      configSnapshot: { strategyMode: 'internal-only', slippage: 0.001 },
      strictTrades: [{
        action: 'CLOSE', type: 'CLOSE', entryPrice: 100, exitPrice: 110,
        amount: 1, profit: 9, exitTime: '2026-09-29T00:00:00.000Z'
      }]
    };
    let summaryStatusOptions;
    ctx.trader.getPaperValidationStatus = async options => {
      summaryStatusOptions = options;
      return {
      available: true,
      active: false,
      state: 'STOPPED',
      heartbeatAt: '2026-09-29T00:00:00.000Z',
      stopReason: null,
      configSnapshotComplete: true,
      configConsistent: true,
      continuityEligible: true,
      heartbeatContinuityEligible: true,
      interruptionCount: 0,
      strictEvaluation: { closedTradeCount: 1, realizedProfit: 9, activePositions: 0 },
      shadowEvaluation: { closedTradeCount: 2, realizedProfit: -20, activePositions: 1 },
      looseShadowEvaluation: { closedTradeCount: 3, realizedProfit: -30, activePositions: 0 },
      analysisDataHealth: { continuityEligible: true, totalMissingMarkets: 0 },
        riskMonitor: { continuityEligible: true }
      };
    };

    const allowed = [
      '/api/status',
      '/api/account',
      '/api/cumulative-pnl',
      '/api/today-summary',
      '/api/market/prices',
      '/api/market/prices/snapshot',
      '/api/paper-validation/summary',
      '/api/portfolio/history?period=24h',
      '/api/portfolio/history?period=7d',
      '/api/portfolio/history?period=30d',
      '/api/trades?limit=1',
      '/api/trades?limit=50'
    ];
    for (const route of allowed) {
      const response = await fetch(`${ctx.baseUrl}${route}`, { headers: readHeaders });
      assert.equal(response.status, 200, `${route} should be available to the monitor token`);
    }

    const paperSummaryResponse = await fetch(`${ctx.baseUrl}/api/paper-validation/summary`, { headers: readHeaders });
    const paperSummary = await paperSummaryResponse.json();
    assert.equal(paperSummary.schema, 'coinpilot.paper-validation-mobile-summary.v1');
    assert.equal(paperSummary.researchOnly, true);
    assert.equal(paperSummary.actualFillsObserved, false);
    assert.equal(typeof paperSummary.cohort.available, 'boolean');
    assert.equal(typeof paperSummary.cohort.readErrorCount, 'number');
    assert.equal(paperSummary.cohort.actualFillsObserved, false);
    assert.equal('totalStrictProfit' in paperSummary.cohort, false);
    assert.equal('sessions' in paperSummary.cohort, false);
    assert.deepEqual(summaryStatusOptions, { includeCurrentAssets: false });
    assert.deepEqual(paperSummary.strict, {
      closedTradeCount: 1,
      realizedProfitKrw: 9,
      openPositionCount: 0
    });
    assert.equal(paperSummary.costAudit.costStressedNetPnlKrw, 8.79);
    assert.equal('configSnapshot' in paperSummary, false);
    assert.equal('strictRecentTrades' in paperSummary, false);

    for (const [method, route] of [
      ['GET', '/api/positions'],
      ['GET', '/api/paper-validation'],
      ['GET', '/api/auth/status'],
      ['GET', '/api/portfolio/history?period=1h'],
      ['GET', '/api/trades?limit=51'],
      ['POST', '/api/control/start'],
      ['POST', '/api/paper-validation/start'],
      ['POST', '/api/paper-validation/stop'],
      ['HEAD', '/api/status'],
      ['OPTIONS', '/api/status']
    ]) {
      const response = await fetch(`${ctx.baseUrl}${route}`, {
        method,
        headers: { ...readHeaders, Origin: ctx.baseUrl }
      });
      assert.equal(response.status, 403, `${method} ${route} should be forbidden to the monitor token`);
    }

    const adminOnlyRoute = await fetch(`${ctx.baseUrl}/api/positions`, { headers: adminHeaders });
    assert.equal(adminOnlyRoute.status, 200);
    const adminPreflight = await fetch(`${ctx.baseUrl}/api/status`, {
      method: 'OPTIONS',
      headers: { ...adminHeaders, Origin: ctx.baseUrl }
    });
    assert.equal(adminPreflight.status, 204);

    for (const { token, tokenScope } of [
      { token: 'full-secret', tokenScope: 'operator' },
      { token: 'monitor-secret', tokenScope: 'read_only' }
    ]) {
      const login = await fetch(`${ctx.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      assert.equal(login.status, 200);
      assert.deepEqual(await login.json(), { success: true, tokenScope });
    }
  } finally {
    await stopDashboard(ctx);
  }
});

test('인증 활성 서버에서 mutation 엔드포인트도 토큰 없이 401이다', async () => {
  const ctx = await startDashboard({ DASHBOARD_TOKEN: 'test-secret' });
  try {
    const res = await fetch(`${ctx.baseUrl}/api/trade/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coin: 'KRW-BTC', amount: 10000 })
    });
    assert.equal(res.status, 401);
  } finally {
    await stopDashboard(ctx);
  }
});

test('login 엔드포인트는 올바른 토큰을 검증하고 실패를 제한한다', async () => {
  const ctx = await startDashboard(
    { DASHBOARD_TOKEN: 'test-secret' },
    { loginRateLimiter: { maxFailures: 3, windowMs: 60_000, blockMs: 60_000 } }
  );
  try {
    const bad = () => fetch(`${ctx.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'nope' })
    });
    assert.equal((await bad()).status, 401);
    assert.equal((await bad()).status, 401);
    assert.equal((await bad()).status, 401);
    assert.equal((await bad()).status, 429);

    const good = await fetch(`${ctx.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'test-secret' })
    });
    assert.equal(good.status, 429); // 차단 중에는 올바른 토큰도 429
  } finally {
    await stopDashboard(ctx);
  }
});

test('인증 활성 서버는 허용되지 않은 Origin을 403으로 거부한다', async () => {
  const ctx = await startDashboard({ DASHBOARD_TOKEN: 'test-secret' });
  try {
    const evil = await fetch(`${ctx.baseUrl}/api/status`, {
      headers: { Origin: 'http://evil.example', Authorization: 'Bearer test-secret' }
    });
    assert.equal(evil.status, 403);

    const sameOrigin = await fetch(`${ctx.baseUrl}/api/status`, {
      headers: {
        Origin: `http://127.0.0.1:${ctx.httpServer.address().port}`,
        Authorization: 'Bearer test-secret'
      }
    });
    assert.equal(sameOrigin.status, 200);
    assert.equal(sameOrigin.headers.get('access-control-allow-origin'), `http://127.0.0.1:${ctx.httpServer.address().port}`);
  } finally {
    await stopDashboard(ctx);
  }
});

test('인증 활성 서버도 정적 셸은 공개로 서빙한다', async () => {
  const ctx = await startDashboard({ DASHBOARD_TOKEN: 'test-secret' });
  try {
    const res = await fetch(`${ctx.baseUrl}/auth-client.js`);
    assert.equal(res.status, 200);
  } finally {
    await stopDashboard(ctx);
  }
});

test('socket.io 핸드셰이크는 허용되지 않은 Origin에서 거부된다', async () => {
  const ctx = await startDashboard({ DASHBOARD_TOKEN: 'test-secret' });
  try {
    const res = await fetch(`${ctx.baseUrl}/socket.io/?EIO=4&transport=polling`, {
      headers: { Origin: 'http://evil.example' }
    });
    assert.equal(res.status, 403);
  } finally {
    await stopDashboard(ctx);
  }
});

test('socket.io polling 핸드셰이크는 인증 없이 unauthorized 패킷을 받는다', async () => {
  const ctx = await startDashboard({ DASHBOARD_TOKEN: 'test-secret' });
  try {
    const open = await fetch(`${ctx.baseUrl}/socket.io/?EIO=4&transport=polling`);
    const openBody = await open.text();
    const sid = openBody.match(/"sid":"([^"]+)"/)?.[1];
    assert.ok(sid, 'engine.io sid 발급 실패');

    // namespace CONNECT(4) without auth → 서버는 ERROR(4) 패킷을 큐잉한다
    await fetch(`${ctx.baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sid}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: '40{}'
    });
    const poll = await fetch(`${ctx.baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sid}`);
    const pollBody = await poll.text();
    assert.match(pollBody, /unauthor/i);
  } finally {
    await stopDashboard(ctx);
  }
});

test('socket.io polling 핸드셰이크는 올바른 토큰으로 연결된다', async () => {
  const ctx = await startDashboard({ DASHBOARD_TOKEN: 'test-secret' });
  try {
    const open = await fetch(`${ctx.baseUrl}/socket.io/?EIO=4&transport=polling`);
    const sid = (await open.text()).match(/"sid":"([^"]+)"/)?.[1];
    assert.ok(sid);

    await fetch(`${ctx.baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sid}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: `40{"token":"test-secret"}`
    });
    const poll = await fetch(`${ctx.baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sid}`);
    const body = await poll.text();
    assert.match(body, /40\{"sid"/);
  } finally {
    await stopDashboard(ctx);
  }
});

// -------------------------------------------------- integration: auth disabled
test('인증 비활성 서버는 /api를 토큰 없이 서빙하고 루프백에 바인딩된다', async () => {
  const ctx = await startDashboard({});
  try {
    assert.equal(ctx.httpServer.address().address, '127.0.0.1');
    const res = await fetch(`${ctx.baseUrl}/api/status`);
    assert.equal(res.status, 200);
    const status = await fetch(`${ctx.baseUrl}/api/auth/status`);
    assert.deepEqual(await status.json(), { success: true, authRequired: false });
  } finally {
    await stopDashboard(ctx);
  }
});
