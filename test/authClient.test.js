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

async function loadAuthClient({ savedToken = '', apiStatus = 'auth-required', apiResponse = 401, withSocket = false } = {}) {
  let token = savedToken;
  const appended = [];
  const calls = [];
  const socketListeners = new Map();
  const socket = {
    on(name, listener) { socketListeners.set(name, listener); }
  };
  const localStorage = {
    getItem(key) { assert.equal(key, tokenKey); return token; },
    setItem(key, value) { assert.equal(key, tokenKey); token = value; },
    removeItem(key) { assert.equal(key, tokenKey); token = ''; }
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
      const isStatus = input === '/api/auth/status';
      const status = isStatus ? 200 : apiResponse;
      return {
        status,
        ok: status >= 200 && status < 300,
        async json() {
          return isStatus
            ? { success: true, authRequired: apiStatus === 'auth-required' }
            : { success: false, authRequired: true };
        }
      };
    }
  };
  if (withSocket) window.io = () => socket;

  const context = vm.createContext({ window, document, Headers, Request, URL });
  vm.runInContext(authClientSource, context, { filename: 'auth-client.js' });
  await new Promise(resolve => setImmediate(resolve));

  return {
    window,
    calls,
    socketListeners,
    token: () => token,
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
  assert.equal(client.gate()?.hidden, false);
  assert.equal(client.error(), '저장된 접속 토큰이 맞지 않습니다. 다시 입력해 주세요.');
});

test('an unauthenticated first socket connection does not show a false rejection error', async () => {
  const client = await loadAuthClient({ withSocket: true });

  client.window.io();
  client.socketListeners.get('connect_error')({ message: 'unauthorized' });

  assert.equal(client.gate()?.hidden, false);
  assert.equal(client.error(), '');
});

test('an unauthorized socket clears and reports a saved token', async () => {
  const client = await loadAuthClient({ savedToken: 'incorrect-token', withSocket: true });

  client.window.io();
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
