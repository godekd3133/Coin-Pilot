import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import DashboardServer from '../src/api/dashboardServer.js';
import { resolveDashboardAuth } from '../src/api/auth.js';
import { hashPassword, parsePasswordHash, verifyPassword } from '../src/api/passwordHash.js';
import { loadEnv } from '../src/config/envLoader.js';
import { createMockTrader } from '../src/scripts/runDashboard.js';

// Low work factor keeps the suite fast; production hashes use N=16384.
const FAST = { N: 1024, r: 8, p: 1 };
const PASSWORD = 'correct horse battery';
const HASH = hashPassword(PASSWORD, { params: FAST });

function baseEnv(extra = {}) {
  return {
    ...process.env,
    DASHBOARD_TOKEN: 'operator-secret',
    DASHBOARD_READ_ONLY_TOKEN: '',
    DASHBOARD_MOBILE_TOKEN: 'mobile-secret',
    DASHBOARD_LOGIN_USERNAME: 'owner',
    DASHBOARD_LOGIN_PASSWORD_HASH: HASH,
    DASHBOARD_HOST: '',
    DASHBOARD_ALLOW_INSECURE: '',
    ...extra
  };
}

async function withDashboard(env, run) {
  const trader = createMockTrader();
  const dashboard = new DashboardServer(trader, 0, { env });
  const httpServer = await dashboard.start();
  const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  try {
    await run(baseUrl);
  } finally {
    const closed = dashboard.httpServer?.listening ? once(dashboard.httpServer, 'close') : Promise.resolve();
    await dashboard.stop();
    trader.stop();
    await closed;
  }
}

const login = (baseUrl, body) => fetch(`${baseUrl}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

test('password hashes round-trip and reject a wrong or empty password', () => {
  const parsed = parsePasswordHash(HASH);
  assert.ok(parsed);
  assert.equal(verifyPassword(PASSWORD, parsed), true);
  assert.equal(verifyPassword('wrong password', parsed), false);
  assert.equal(verifyPassword('', parsed), false);
  assert.equal(verifyPassword(undefined, parsed), false);
  assert.match(HASH, /^scrypt:1024:8:1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
  assert.equal(HASH.includes('$'), false, 'hash must survive shell and systemd env files');
  assert.throws(() => hashPassword('short'), /8자 이상/);
});

test('malformed or oversized hash parameters are rejected', () => {
  for (const value of ['', 'plain-password', 'scrypt:1000:8:1:abc:def', `scrypt:${1 << 20}:8:1:AAAAAAAAAAA:AAAA`, 'bcrypt:1:2:3:4:5']) {
    assert.equal(parsePasswordHash(value), null, value);
  }
});

test('password login requires both values and a full dashboard token', () => {
  assert.throws(() => resolveDashboardAuth({ DASHBOARD_TOKEN: 'x', DASHBOARD_LOGIN_USERNAME: 'owner' }), /함께 설정/);
  assert.throws(() => resolveDashboardAuth({ DASHBOARD_TOKEN: 'x', DASHBOARD_LOGIN_USERNAME: 'owner', DASHBOARD_LOGIN_PASSWORD_HASH: 'nope' }), /형식/);
  assert.throws(() => resolveDashboardAuth({ DASHBOARD_MOBILE_TOKEN: 'm', DASHBOARD_LOGIN_USERNAME: 'owner', DASHBOARD_LOGIN_PASSWORD_HASH: HASH }), /DASHBOARD_TOKEN/);
  assert.equal(resolveDashboardAuth({ DASHBOARD_TOKEN: 'x' }).passwordLogin, null);

  const missing = loadEnv({ DASHBOARD_LOGIN_USERNAME: 'owner' });
  const keys = missing.errors.map(error => error.key);
  assert.ok(keys.includes('DASHBOARD_LOGIN_PASSWORD_HASH'));
  assert.ok(keys.includes('DASHBOARD_TOKEN'));
});

test('a correct password returns the operator token for the web and the mobile token for the app', async () => {
  await withDashboard(baseEnv(), async baseUrl => {
    const status = await (await fetch(`${baseUrl}/api/auth/status`)).json();
    assert.equal(status.passwordLogin, true);

    const web = await login(baseUrl, { username: 'owner', password: PASSWORD });
    assert.equal(web.status, 200);
    assert.equal(web.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await web.json(), { success: true, tokenScope: 'operator', token: 'operator-secret' });

    const native = await login(baseUrl, { username: ' owner ', password: PASSWORD, client: 'native' });
    assert.deepEqual(await native.json(), { success: true, tokenScope: 'mobile_operator', token: 'mobile-secret' });

    const issued = await fetch(`${baseUrl}/api/status`, { headers: { Authorization: 'Bearer operator-secret' } });
    assert.equal(issued.status, 200);
  });
});

test('the app falls back to the operator token when no mobile token exists', async () => {
  await withDashboard(baseEnv({ DASHBOARD_MOBILE_TOKEN: '' }), async baseUrl => {
    const body = await (await login(baseUrl, { username: 'owner', password: PASSWORD, client: 'native' })).json();
    assert.deepEqual(body, { success: true, tokenScope: 'operator', token: 'operator-secret' });
  });
});

test('wrong credentials never return a token and are rate limited', async () => {
  await withDashboard(baseEnv(), async baseUrl => {
    for (const body of [
      { username: 'owner', password: 'wrong password' },
      { username: 'someone', password: PASSWORD },
      { username: 'owner' },
      { password: PASSWORD }
    ]) {
      const response = await login(baseUrl, body);
      assert.equal(response.status, 401);
      assert.equal((await response.json()).token, undefined);
    }
    let last;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      last = await login(baseUrl, { username: 'owner', password: 'wrong password' });
    }
    assert.equal(last.status, 429);
    const blocked = await login(baseUrl, { username: 'owner', password: PASSWORD });
    assert.equal(blocked.status, 429, 'a blocked client cannot sign in even with the right password');
  });
});

test('a server without password login refuses the password form', async () => {
  await withDashboard(baseEnv({ DASHBOARD_LOGIN_USERNAME: '', DASHBOARD_LOGIN_PASSWORD_HASH: '' }), async baseUrl => {
    const status = await (await fetch(`${baseUrl}/api/auth/status`)).json();
    assert.equal(status.passwordLogin, false);
    const response = await login(baseUrl, { username: 'owner', password: PASSWORD });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).token, undefined);
  });
});
