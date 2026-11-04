import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const authClientSource = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/auth-client.js'),
  'utf8'
);
const tokenKey = 'coinpilot.dashboardToken';
const tokenScopeKey = 'coinpilot.dashboardTokenScope';

function makeElement() {
  const children = new Map();
  const listeners = new Map();
  return {
    hidden: false,
    textContent: '',
    value: '',
    disabled: false,
    addEventListener(name, handler) { listeners.set(name, handler); },
    querySelector(selector) {
      if (!children.has(selector)) children.set(selector, makeElement());
      return children.get(selector);
    },
    listener(name) { return listeners.get(name); }
  };
}

async function loadAuthClient({
  savedToken = '', savedTokenScope = '', apiStatus = 'auth-required', apiResponse = 401,
  loginResponse = { status: 200, body: { success: true, tokenScope: 'operator' } },
  statusFailure = false, loginFailure = false, withSocket = false, passwordLogin = false,
  siblingLoginResponse = { status: 404, body: null }
} = {}) {
  const sibling = new Map();
  const isSiblingKey = key => key.endsWith('@/live/');
  let token = savedToken;
  let tokenScope = savedTokenScope;
  const appended = [];
  const calls = [];
  const socketCalls = [];
  const socketListeners = new Map();
  const socket = {
    on(name, listener) { socketListeners.set(name, listener); }
  };
  const localStorage = {
    getItem(key) {
      if (isSiblingKey(key)) return sibling.get(key) ?? null;
      if (key === tokenKey) return token;
      if (key === tokenScopeKey) return tokenScope;
      assert.fail(`unexpected localStorage key: ${key}`);
    },
    setItem(key, value) {
      if (isSiblingKey(key)) sibling.set(key, value);
      else if (key === tokenKey) token = value;
      else if (key === tokenScopeKey) tokenScope = value;
      else assert.fail(`unexpected localStorage key: ${key}`);
    },
    removeItem(key) {
      if (isSiblingKey(key)) sibling.delete(key);
      else if (key === tokenKey) token = '';
      else if (key === tokenScopeKey) tokenScope = '';
      else assert.fail(`unexpected localStorage key: ${key}`);
    }
  };
  const document = {
    readyState: 'complete',
    head: { appendChild() {} },
    body: { appendChild(element) { appended.push(element); } },
    createElement() { return makeElement(); }
  };
  const window = {
    localStorage,
    location: { origin: 'https://coinpilot.test', reload() {} },
    setTimeout() {},
    fetch: async (input, init = {}) => {
      calls.push({ input, init });
      if (input === '/live/api/auth/login') {
        const { status: siblingStatus, body: siblingBody } = siblingLoginResponse;
        return { status: siblingStatus, ok: siblingStatus >= 200 && siblingStatus < 300, async json() { return siblingBody; } };
      }
      const isStatus = input === '/api/auth/status';
      const isLogin = input === '/api/auth/login';
      if (isStatus && statusFailure || isLogin && loginFailure) throw new TypeError('network unavailable');
      const status = isStatus ? 200 : isLogin ? loginResponse.status : apiResponse;
      const body = isStatus
        ? { success: true, authRequired: apiStatus === 'auth-required', passwordLogin }
        : isLogin ? loginResponse.body : { success: false, authRequired: true };
      return {
        status,
        ok: status >= 200 && status < 300,
        async json() { return body; }
      };
    }
  };
  if (withSocket) window.io = (...args) => { socketCalls.push(args); return socket; };

  const context = vm.createContext({ window, document, Headers, Request, URL });
  vm.runInContext(authClientSource, context, { filename: 'auth-client.js' });
  await window.coinPilotAuth.ready;
  await new Promise(resolve => setImmediate(resolve));

  return {
    window,
    calls,
    socketCalls,
    socketListeners,
    sibling,
    token: () => token,
    tokenScope: () => tokenScope,
    authState: () => window.coinPilotAuth.state,
    gate: () => appended.find(element => element.id === 'cp-auth-gate'),
    error: () => appended.find(element => element.id === 'cp-auth-gate')?.querySelector('.cp-auth-error').textContent
  };
}

test('first connection shows the token prompt without a rejected-token error', async () => {
  const client = await loadAuthClient();

  assert.equal(client.gate()?.hidden, false);
  assert.equal(client.error(), '');
  assert.equal(client.token(), '');

  await client.window.fetch('/api/portfolio');
  assert.equal(client.gate()?.hidden, false);
  assert.equal(client.error(), '');
});

test('a saved token rejected by the API is cleared and shown as an error', async () => {
  const client = await loadAuthClient({ savedToken: 'incorrect-token' });

  await client.window.fetch('/api/portfolio');

  assert.equal(client.token(), '');
  assert.equal(client.tokenScope(), '');
  assert.equal(client.authState().verification, 'invalid');
  assert.equal(client.gate()?.hidden, false);
  assert.equal(client.error(), '저장된 접속 토큰이 맞지 않습니다. 다시 입력해 주세요.');
});

test('an unauthenticated first socket connection does not show a false rejection error', async () => {
  const client = await loadAuthClient({ withSocket: true });

  client.window.io();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(client.socketCalls.length, 0);
  assert.equal(client.gate()?.hidden, false);
  assert.equal(client.error(), '');
});

test('an unauthorized socket clears and reports a saved token', async () => {
  const client = await loadAuthClient({ savedToken: 'incorrect-token', withSocket: true });

  client.window.io();
  assert.equal(client.socketCalls.length, 1);
  assert.equal(client.socketCalls[0][0].auth.token, 'incorrect-token');
  client.socketListeners.get('connect_error')({ message: 'unauthorized' });

  assert.equal(client.token(), '');
  assert.equal(client.gate()?.hidden, false);
  assert.equal(client.error(), '저장된 접속 토큰이 맞지 않습니다. 다시 입력해 주세요.');
});

test('valid saved tokens continue to be sent on same-origin API calls', async () => {
  const client = await loadAuthClient({ savedToken: 'valid-token', apiResponse: 200 });

  await client.window.fetch('/api/portfolio');

  const apiCall = client.calls.find(call => call.input === '/api/portfolio');
  assert.equal(apiCall.init.headers.get('Authorization'), 'Bearer valid-token');
  assert.equal(client.token(), 'valid-token');
  assert.equal(client.gate(), undefined);
});

test('a saved token from before scope storage is resolved before Socket.IO and stays authenticated when read-only', async () => {
  const client = await loadAuthClient({
    savedToken: 'legacy-read-only-token',
    loginResponse: { status: 200, body: { success: true, tokenScope: 'read_only' } },
    withSocket: true
  });

  assert.equal(client.token(), 'legacy-read-only-token');
  assert.equal(client.tokenScope(), 'read_only');
  assert.equal(client.authState().authenticated, true);
  assert.equal(client.authState().verification, 'verified');
  assert.equal(client.authState().tokenScope, 'read_only');
  assert.equal(client.gate(), undefined);

  client.window.io();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.socketCalls.length, 0);
});

test('mobile operator tokens stay valid in the browser and may open the realtime socket', async () => {
  const client = await loadAuthClient({
    savedToken: 'native-mobile-token',
    loginResponse: { status: 200, body: { success: true, tokenScope: 'mobile_operator' } },
    withSocket: true
  });

  client.window.io();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(client.token(), 'native-mobile-token');
  assert.equal(client.tokenScope(), 'mobile_operator');
  assert.equal(client.authState().authenticated, true);
  assert.equal(client.authState().verification, 'verified');
  assert.equal(client.gate(), undefined);
  assert.equal(client.error(), undefined);
  assert.equal(client.socketCalls.length, 1);
  assert.equal(client.window.coinPilotAuth.canMutate, false);
});

test('saved-token lookup network failure preserves token but keeps mutations and sockets restricted', async () => {
  const client = await loadAuthClient({
    savedToken: 'valid-but-offline-token',
    savedTokenScope: 'operator',
    loginFailure: true,
    withSocket: true
  });

  client.window.io();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(client.token(), 'valid-but-offline-token');
  assert.equal(client.authState().verification, 'unavailable');
  assert.equal(client.authState().tokenScope, null);
  assert.equal(client.window.coinPilotAuth.canMutate, false);
  assert.equal(client.window.coinPilotAuth.canOpenSocket, false);
  assert.equal(client.socketCalls.length, 0);
  assert.match(client.error(), /확인하지 못했습니다/);
});

test('a token rejected by the scope lookup is invalid and removed', async () => {
  const client = await loadAuthClient({
    savedToken: 'revoked-token',
    savedTokenScope: 'operator',
    loginResponse: { status: 401, body: { success: false, authRequired: true } }
  });

  assert.equal(client.token(), '');
  assert.equal(client.tokenScope(), '');
  assert.equal(client.authState().verification, 'invalid');
  assert.equal(client.authState().authenticated, false);
  assert.equal(client.error(), '저장된 접속 토큰이 맞지 않습니다. 다시 입력해 주세요.');
});

test('new login preserves the tokenScope returned by the login endpoint', async () => {
  const client = await loadAuthClient({
    loginResponse: { status: 200, body: { success: true, tokenScope: 'read_only' } }
  });
  const gate = client.gate();
  gate.querySelector('#cp-auth-token').value = 'new-read-only-token';

  await gate.querySelector('form').listener('submit')({ preventDefault() {} });

  assert.equal(client.token(), 'new-read-only-token');
  assert.equal(client.tokenScope(), 'read_only');
  assert.equal(client.authState().authenticated, true);
});

test('login server errors preserve input and do not blame or store the token', async () => {
  const client = await loadAuthClient({ loginResponse: { status: 503, body: { success: false } } });
  const gate = client.gate();
  gate.querySelector('#cp-auth-token').value = 'retryable-token';
  await gate.querySelector('form').listener('submit')({ preventDefault() {} });

  assert.match(client.error(), /서버가 접속 요청을 처리하지 못했습니다/);
  assert.equal(gate.querySelector('#cp-auth-token').value, 'retryable-token');
  assert.equal(gate.querySelector('.cp-auth-submit').disabled, false);
  assert.equal(client.token(), '');
  assert.equal(client.window.coinPilotAuth.canMutate, false);
});

test('rejected and rate-limited login attempts explain different recovery actions', async () => {
  for (const [status, expected] of [[401, /토큰이 맞지 않거나 권한이 없습니다/], [429, /잠시 후 다시 시도/]]) {
    const client = await loadAuthClient({ loginResponse: { status, body: { success: false } } });
    const gate = client.gate();
    gate.querySelector('#cp-auth-token').value = 'not-accepted';
    await gate.querySelector('form').listener('submit')({ preventDefault() {} });
    assert.match(client.error(), expected);
    assert.equal(client.token(), '');
    assert.equal(client.window.coinPilotAuth.canMutate, false);
  }
});

test('password sign-in stores the token the server returns and never the password', async () => {
  const client = await loadAuthClient({
    passwordLogin: true,
    loginResponse: { status: 200, body: { success: true, tokenScope: 'operator', token: 'issued-operator-token' } }
  });
  const gate = client.gate();
  assert.equal(gate.querySelector('.cp-auth-password-fields').hidden, false);
  assert.equal(gate.querySelector('.cp-auth-token-fields').hidden, true);
  assert.equal(gate.querySelector('.cp-auth-switch').hidden, false);
  gate.querySelector('#cp-auth-username').value = ' owner ';
  gate.querySelector('#cp-auth-password').value = 'correct horse';
  await gate.querySelector('form').listener('submit')({ preventDefault() {} });
  const login = client.calls.find(call => call.input === '/api/auth/login');
  assert.deepEqual(JSON.parse(login.init.body), { username: 'owner', password: 'correct horse' });
  assert.equal(client.token(), 'issued-operator-token');
  assert.equal(client.tokenScope(), 'operator');
  assert.equal(gate.querySelector('#cp-auth-password').value, '');
});

test('a rejected password keeps the prompt and stores nothing', async () => {
  const client = await loadAuthClient({
    passwordLogin: true,
    loginResponse: { status: 401, body: { success: false } }
  });
  const gate = client.gate();
  gate.querySelector('#cp-auth-username').value = 'owner';
  gate.querySelector('#cp-auth-password').value = 'wrong';
  await gate.querySelector('form').listener('submit')({ preventDefault() {} });
  assert.equal(client.token(), '');
  assert.equal(client.error(), '아이디 또는 비밀번호가 맞지 않습니다.');
});

test('the token form stays the only option when the server has no password login', async () => {
  const client = await loadAuthClient();
  const gate = client.gate();
  assert.equal(gate.querySelector('.cp-auth-token-fields').hidden, false);
  assert.equal(gate.querySelector('.cp-auth-switch').hidden, true);
});

test('one username sign-in also stores the LIVE workspace token it was issued', async () => {
  const client = await loadAuthClient({
    passwordLogin: true,
    loginResponse: { status: 200, body: { success: true, tokenScope: 'operator', token: 'paper-operator-token' } },
    siblingLoginResponse: { status: 200, body: { success: true, tokenScope: 'operator', token: 'live-operator-token' } }
  });
  const gate = client.gate();
  gate.querySelector('#cp-auth-username').value = 'owner';
  gate.querySelector('#cp-auth-password').value = 'correct horse';
  await gate.querySelector('form').listener('submit')({ preventDefault() {} });
  const siblingLogin = client.calls.find(call => call.input === '/live/api/auth/login');
  assert.deepEqual(JSON.parse(siblingLogin.init.body), { username: 'owner', password: 'correct horse' });
  assert.equal(client.token(), 'paper-operator-token');
  assert.equal(client.sibling.get('coinpilot.dashboardToken@/live/'), 'live-operator-token');
  assert.equal(client.sibling.get('coinpilot.dashboardTokenScope@/live/'), 'operator');

  client.window.coinPilotAuth.signOutEverywhere();
  assert.equal(client.token(), '');
  assert.equal(client.sibling.size, 0);
});

test('a LIVE workspace that refuses the login leaves only this workspace signed in', async () => {
  const client = await loadAuthClient({
    passwordLogin: true,
    loginResponse: { status: 200, body: { success: true, tokenScope: 'operator', token: 'paper-operator-token' } },
    siblingLoginResponse: { status: 401, body: { success: false } }
  });
  const gate = client.gate();
  gate.querySelector('#cp-auth-username').value = 'owner';
  gate.querySelector('#cp-auth-password').value = 'correct horse';
  await gate.querySelector('form').listener('submit')({ preventDefault() {} });
  assert.equal(client.token(), 'paper-operator-token');
  assert.equal(client.sibling.size, 0);
});
