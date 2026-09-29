import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../mobile/web/server-url.js', import.meta.url), 'utf8');
const policyContext = vm.createContext({ URL });
vm.runInContext(source, policyContext);
const { normalizeDashboardUrl } = policyContext.CoinPilotServerUrlPolicy;
const appSource = await readFile(new URL('../mobile/web/app.js', import.meta.url), 'utf8');
const mobileStyles = await readFile(new URL('../mobile/web/styles.css', import.meta.url), 'utf8');

function createSetupPageContext({ nativeBridge = true, fileStorageAvailable = false } = {}) {
  const elements = new Map();
  for (const selector of ['#server-form', '#server-url', '#form-error', '#saved-server', '#saved-host', '#forget-server']) {
    elements.set(selector, {
      hidden: selector === '#saved-server' || selector === '#forget-server',
      value: '',
      textContent: '',
      listeners: {},
      addEventListener(type, handler) { this.listeners[type] = handler; },
      focus() {}
    });
  }

  const windowListeners = {};
  const nativeMessages = [];
  const navigationTargets = [];
  const fileStorage = new Map();
  let localStorageWrites = 0;
  const localStorage = {
    getItem(key) {
      if (!fileStorageAvailable) throw new Error('file URL storage is unavailable');
      return fileStorage.get(key) || null;
    },
    setItem(key, value) {
      localStorageWrites += 1;
      if (!fileStorageAvailable) throw new Error('file URL storage is unavailable');
      fileStorage.set(key, value);
    },
    removeItem(key) {
      if (!fileStorageAvailable) throw new Error('file URL storage is unavailable');
      fileStorage.delete(key);
    }
  };
  const window = {
    CoinPilotServerUrlPolicy: policyContext.CoinPilotServerUrlPolicy,
    addEventListener(type, handler) { windowListeners[type] = handler; },
    location: { assign(value) { navigationTargets.push(value); } }
  };
  if (nativeBridge) {
    window.webkit = { messageHandlers: {
      coinpilotConnect: { postMessage(value) { nativeMessages.push({ handler: 'connect', value }); } },
      coinpilotForget: { postMessage(value) { nativeMessages.push({ handler: 'forget', value }); } }
    } };
  }
  const context = vm.createContext({
    URL,
    document: { querySelector: selector => elements.get(selector) },
    localStorage,
    window
  });
  vm.runInContext(appSource, context);
  return { elements, localStorageWrites: () => localStorageWrites, nativeMessages, navigationTargets, windowListeners };
}

test('mobile server setup accepts secure remote and same-network server addresses', () => {
  assert.equal(normalizeDashboardUrl('coinpilot.example.com'), 'https://coinpilot.example.com');
  assert.equal(normalizeDashboardUrl('http://192.168.1.12:3000'), 'http://192.168.1.12:3000');
  assert.equal(normalizeDashboardUrl('http://pilot.local:3000'), 'http://pilot.local:3000');
  assert.equal(normalizeDashboardUrl('http://[fd12:3456:789a::10]:3000'), 'http://[fd12:3456:789a::10]:3000');
  assert.equal(normalizeDashboardUrl('http://[fc12:3456:789a::10]:3000'), 'http://[fc12:3456:789a::10]:3000');
});

test('mobile server setup does not mistake public fc/fd domains for local IPv6', () => {
  assert.throws(() => normalizeDashboardUrl('http://fc-upbit.example.com:3000'), /HTTPS/);
  assert.throws(() => normalizeDashboardUrl('http://fd.example.org:3000'), /HTTPS/);
});

test('mobile server setup rejects loopback and scoped link-local routes', () => {
  assert.throws(() => normalizeDashboardUrl('http://127.0.0.2:3000'), /기기 자체 주소/);
  assert.throws(() => normalizeDashboardUrl('https://localhost:3000'), /기기 자체 주소/);
  assert.throws(() => normalizeDashboardUrl('http://[::1]:3000'), /기기 자체 주소/);
  assert.throws(() => normalizeDashboardUrl('http://[fe80::10]:3000'), /HTTPS/);
});

test('mobile server setup rejects credentials and dashboard subpaths', () => {
  assert.throws(() => normalizeDashboardUrl('http://user:pass@192.168.1.12:3000'), /서버 주소에 로그인 정보/);
  assert.throws(() => normalizeDashboardUrl('http://192.168.1.12:3000/dashboard'), /서버 주소만 입력해 주세요/);
  assert.throws(() => normalizeDashboardUrl('http://192.168.1.12:3000/?token=secret'), /서버 주소만 입력해 주세요/);
});

test('native saved-server settings return to the setup screen when file storage is unavailable', () => {
  const { elements, nativeMessages, windowListeners } = createSetupPageContext();
  const event = windowListeners['coinpilot-native-server-config'];
  const saved = elements.get('#saved-server');
  const savedHost = elements.get('#saved-host');
  const input = elements.get('#server-url');
  const forgetButton = elements.get('#forget-server');

  event({ detail: { hasSavedServer: true, url: 'http://[fd12:3456:789a::10]:3000' } });
  assert.equal(saved.hidden, false);
  assert.equal(forgetButton.hidden, false);
  assert.equal(input.value, 'http://[fd12:3456:789a::10]:3000');
  assert.equal(savedHost.textContent, '[fd12:3456:789a::10]:3000');

  forgetButton.listeners.click();
  assert.equal(nativeMessages.length, 1);
  assert.equal(saved.hidden, true);
  assert.equal(forgetButton.hidden, true);
  assert.equal(input.value, '');
});

test('native saved-server settings allow clearing a legacy address without exposing it', () => {
  const { elements, windowListeners } = createSetupPageContext();
  windowListeners['coinpilot-native-server-config']({ detail: { hasSavedServer: true } });

  assert.equal(elements.get('#saved-server').hidden, false);
  assert.equal(elements.get('#forget-server').hidden, false);
  assert.equal(elements.get('#saved-host').textContent, '저장된 서버 주소를 확인할 수 없습니다. 주소를 다시 입력해 주세요.');
  assert.equal(elements.get('#server-url').value, '');
});

test('native connections use UserDefaults bridge without writing a duplicate local copy', () => {
  const { elements, localStorageWrites, nativeMessages } = createSetupPageContext({ nativeBridge: true });
  elements.get('#server-url').value = 'http://[fd12:3456:789a::10]:3000';
  elements.get('#server-form').listeners.submit({ preventDefault() {} });

  assert.equal(localStorageWrites(), 0);
  assert.deepEqual(nativeMessages, [{ handler: 'connect', value: 'http://[fd12:3456:789a::10]:3000' }]);
});

test('web connections keep the server URL in browser storage before navigation', () => {
  const { elements, localStorageWrites, navigationTargets } = createSetupPageContext({
    nativeBridge: false,
    fileStorageAvailable: true
  });
  elements.get('#server-url').value = 'http://192.168.1.12:3000';
  elements.get('#server-form').listeners.submit({ preventDefault() {} });

  assert.equal(localStorageWrites(), 1);
  assert.deepEqual(navigationTargets, ['http://192.168.1.12:3000']);
});

test('saved-server reset keeps a phone-sized target and visible keyboard focus', () => {
  assert.match(mobileStyles, /\.text-button\s*\{[^}]*min-height:\s*44px/s);
  assert.match(mobileStyles, /\.text-button:focus-visible\s*\{/);
});
