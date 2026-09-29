import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath, URL } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const webDirectory = path.resolve(testDirectory, '../web');
const serverUrlSource = fs.readFileSync(path.join(webDirectory, 'server-url.js'), 'utf8');
const autoConnectSource = fs.readFileSync(path.join(webDirectory, 'auto-connect.js'), 'utf8');
const STORAGE_KEY = 'coinpilot.ios.dashboardUrl';

function loadMobileWebShell({
  savedUrl = null,
  nativeBridge = false,
  storageUnavailable = false
} = {}) {
  const state = { savedUrl, redirects: [], writes: [], nativeMessages: [] };
  const localStorage = {
    getItem(key) {
      assert.equal(key, STORAGE_KEY);
      if (storageUnavailable) throw new Error('storage unavailable');
      return state.savedUrl;
    },
    setItem(key, value) {
      assert.equal(key, STORAGE_KEY);
      if (storageUnavailable) throw new Error('storage unavailable');
      state.savedUrl = value;
      state.writes.push(value);
    }
  };
  const context = vm.createContext({
    URL,
    localStorage,
    location: { replace: value => state.redirects.push(value) }
  });
  context.window = context;
  if (nativeBridge) {
    context.webkit = {
      messageHandlers: {
        coinpilotConnect: { postMessage: value => state.nativeMessages.push(value) }
      }
    };
  }

  vm.runInContext(serverUrlSource, context, { filename: 'server-url.js' });
  vm.runInContext(autoConnectSource, context, { filename: 'auto-connect.js' });
  return state;
}

test('standalone browser stays on the connection form until the user selects a server', () => {
  const state = loadMobileWebShell();

  assert.deepEqual(state.redirects, []);
  assert.deepEqual(state.writes, []);
  assert.equal(state.savedUrl, null);
});

test('standalone browser keeps a saved server visible without opening it implicitly', () => {
  const state = loadMobileWebShell({ savedUrl: 'https://coinpilot.example.com/' });

  assert.deepEqual(state.redirects, []);
  assert.deepEqual(state.writes, []);
  assert.equal(state.savedUrl, 'https://coinpilot.example.com/');
  assert.deepEqual(state.nativeMessages, []);
});

test('an invalid saved public HTTP address is never opened implicitly', () => {
  const state = loadMobileWebShell({ savedUrl: 'http://coinpilot.example.com' });

  assert.deepEqual(state.redirects, []);
  assert.deepEqual(state.writes, []);
});

test('native WebView leaves navigation to the native server controller', () => {
  const state = loadMobileWebShell({ nativeBridge: true, savedUrl: 'https://coinpilot.example.com' });

  assert.deepEqual(state.redirects, []);
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.nativeMessages, []);
});

test('browser stays on the setup page when local storage is unavailable', () => {
  const state = loadMobileWebShell({ storageUnavailable: true });

  assert.deepEqual(state.redirects, []);
  assert.deepEqual(state.writes, []);
});
