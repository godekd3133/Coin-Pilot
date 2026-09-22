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
  return { ...process.env, DASHBOARD_TOKEN: '', DASHBOARD_HOST: '', DASHBOARD_ALLOW_INSECURE: '' };
}

async function startDashboard(env, options = {}) {
  const trader = createMockTrader();
  const dashboard = new DashboardServer(trader, 0, {
    env: { ...authOffEnv(), ...env },
    ...options
  });
  const httpServer = dashboard.start();
  await once(httpServer, 'listening');
  const address = httpServer.address();
  return { dashboard, trader, httpServer, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopDashboard({ dashboard, trader }) {
  const closed = dashboard.httpServer?.listening
    ? once(dashboard.httpServer, 'close')
    : Promise.resolve();
  dashboard.stop();
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
test('socket middleware는 토큰 없이 거부하고 올바른 토큰은 통과한다', () => {
  const auth = createDashboardAuth({ DASHBOARD_TOKEN: 'tok' });
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
  return Promise.all([rejected, accepted, bearerHeader]).then(([rej, ok, bearer]) => {
    assert.ok(rej instanceof Error);
    assert.equal(ok, undefined);
    assert.equal(bearer, undefined);
  });
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
