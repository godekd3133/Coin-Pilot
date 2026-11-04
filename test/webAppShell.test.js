// Web shell architecture: registry/router contract, store, resources,
// formatting, escaping templates, and that the server serves the shell at `/`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import DashboardServer from '../src/api/dashboardServer.js';
import { createMockTrader, createMockStockTradingService, createMockCoinHorizon } from '../src/scripts/runDashboard.js';
import { createRegistry, FEATURES, createDefaultRegistry } from '../public/app/core/registry.js';
import { parseHash, buildHash, validateFeatureModule, createRouter } from '../public/app/core/router.js';
import { createStore } from '../public/app/core/store.js';
import { createResourceManager, nextResourceState, resourceKey } from '../public/app/core/resources.js';
import { RESOURCE_CATALOG } from '../public/app/core/resourceCatalog.js';
import { html, raw, escapeHtml, join } from '../public/app/core/dom.js';
import * as format from '../public/app/core/format.js';
import { createApi } from '../public/app/core/api.js';
import { deriveSession } from '../public/app/core/session.js';
import { connectRealtime, REALTIME_EVENTS } from '../public/app/core/realtime.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.join(root, 'public/app');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const listFiles = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => (entry.isDirectory() ? listFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));

// ------------------------------------------------------------------ registry

test('registry validates entries and drives sidebar, tab bar and 더보기', () => {
  const loader = () => Promise.resolve({ default: {} });
  assert.throws(() => createRegistry([{ id: 'x', label: 'X', icon: 'home', nav: 'primary' }]), /loader/);
  assert.throws(() => createRegistry([{ id: 'Bad Id', label: 'X', icon: 'home', nav: 'primary', loader }]), /invalid feature id/);
  assert.throws(() => createRegistry([{ id: 'x', label: 'X', icon: 'home', nav: 'floating', loader }]), /invalid nav/);
  assert.throws(() => createRegistry([{ id: 'x', label: 'X', icon: 'home', nav: 'primary', loader }, { id: 'x', label: 'Y', icon: 'home', nav: 'tool', loader }]), /duplicate/);

  const registry = createDefaultRegistry();
  assert.deepEqual(registry.mobileTabs().map(feature => feature.id), ['home', 'coins', 'stocks', 'portfolios'], '4 tabs + 더보기 on mobile');
  assert.deepEqual(registry.sidebar().map(feature => feature.id), ['home', 'coins', 'stocks', 'portfolios', 'activity', 'settings'], '6 sidebar tabs ≥960px');
  const more = registry.moreItems().map(feature => feature.id);
  for (const id of ['activity', 'settings', 'trade', 'wallet', 'research', 'strategy', 'analysis', 'ai', 'news']) assert.ok(more.includes(id), `${id} reachable from 더보기`);
  assert.equal(more.includes('more'), false);
});

test('adding a feature needs only a folder and one registry entry', async () => {
  for (const feature of FEATURES) {
    assert.ok(fs.existsSync(path.join(appDir, 'features', feature.id, 'index.js')), `features/${feature.id}/index.js`);
    const mod = await feature.loader();
    validateFeatureModule(mod.default, feature.id);
    for (const name of mod.default.resources || []) assert.ok(RESOURCE_CATALOG[name], `${feature.id} uses unknown resource ${name}`);
  }
  // The shell never names a feature folder: navigation comes from the registry.
  const main = read('public/app/main.js');
  assert.equal(/features\//.test(main), false, 'main.js must not import features directly');
  const registrySource = read('public/app/core/registry.js');
  for (const feature of FEATURES) assert.match(registrySource, new RegExp(`import\\('\\.\\./features/${feature.id}/index\\.js'\\)`));

  const registry = createRegistry([...FEATURES, { id: 'overseas', label: '해외주식', icon: 'chart', nav: 'tool', group: '자산', loader: async () => ({ default: { id: 'overseas', mount() {} } }) }]);
  assert.ok(registry.tools().some(feature => feature.id === 'overseas'));
  assert.ok(registry.moreItems().some(feature => feature.id === 'overseas'));
});

// ------------------------------------------------------------------ router

test('hash parsing and building round-trip ids, params and query', () => {
  assert.deepEqual(parseHash(''), { id: 'home', params: [], query: {} });
  assert.deepEqual(parseHash('#/coins/KRW-BTC'), { id: 'coins', params: ['KRW-BTC'], query: {} });
  assert.deepEqual(parseHash('#/trade?coin=KRW-SOL&side=sell'), { id: 'trade', params: [], query: { coin: 'KRW-SOL', side: 'sell' } });
  assert.equal(buildHash('trade', [], { coin: 'KRW-BTC' }), '#/trade?coin=KRW-BTC');
  assert.deepEqual(parseHash(buildHash('coins', ['KRW-ETH'])), { id: 'coins', params: ['KRW-ETH'], query: {} });
});

test('feature module contract rejects malformed modules', () => {
  assert.throws(() => validateFeatureModule(null, 'home'), /default export/);
  assert.throws(() => validateFeatureModule({ id: 'coins', mount() {} }, 'home'), /mismatch/);
  assert.throws(() => validateFeatureModule({ id: 'home' }, 'home'), /mount/);
  assert.throws(() => validateFeatureModule({ id: 'home', mount() {}, resources: 'status' }, 'home'), /array/);
});

function fakeWindow(hash = '') {
  const listeners = {};
  return { location: { hash }, addEventListener(type, fn) { listeners[type] = fn; }, fire(type) { listeners[type]?.(); } };
}

test('router lazy-loads, activates resources, unmounts on leave and drops stale loads', async () => {
  const events = [];
  let resolveSlow;
  const registry = createRegistry([
    { id: 'home', label: '홈', icon: 'home', nav: 'primary', loader: async () => ({ default: { id: 'home', resources: ['status'], mount: () => { events.push('mount:home'); return () => events.push('unmount:home'); } } }) },
    { id: 'slow', label: '느림', icon: 'home', nav: 'tool', loader: () => new Promise(resolve => { resolveSlow = () => resolve({ default: { id: 'slow', mount: () => events.push('mount:slow') } }); }) },
    { id: 'fast', label: '빠름', icon: 'home', nav: 'tool', loader: async () => ({ default: { id: 'fast', mount: () => events.push('mount:fast') } }) }
  ]);
  const used = [];
  const resources = { use: names => { used.push(...names); return () => events.push(`release:${names.join(',')}`); } };
  const win = fakeWindow('#/home');
  const router = createRouter({ registry, getRoot: () => ({}), resources, createContext: ({ route }) => ({ route }), win });
  await router.start();
  assert.deepEqual(used, ['status']);
  assert.deepEqual(events, ['mount:home']);

  const slow = router.resolve('#/slow');
  const fast = router.resolve('#/fast');
  await fast;
  resolveSlow();
  await slow;
  assert.ok(events.includes('unmount:home') && events.includes('release:status'));
  assert.ok(events.includes('mount:fast'));
  assert.equal(events.includes('mount:slow'), false, 'a superseded navigation must not mount');
  assert.equal(router.current().id, 'fast');

  await router.resolve('#/does-not-exist');
  assert.equal(router.current().id, 'home', 'unknown routes fall back to home');
});

test('router reports loader failures without leaving a half-mounted screen', async () => {
  const registry = createRegistry([
    { id: 'home', label: '홈', icon: 'home', nav: 'primary', loader: async () => ({ default: { id: 'home', mount() {} } }) },
    { id: 'broken', label: '깨짐', icon: 'home', nav: 'tool', loader: async () => { throw new Error('offline'); } }
  ]);
  const errors = [];
  const router = createRouter({ registry, getRoot: () => ({}), createContext: () => ({}), onError: (error, entry) => errors.push([error.message, entry.id]), win: fakeWindow() });
  await router.resolve('#/broken');
  assert.deepEqual(errors, [['offline', 'broken']]);
  assert.equal(router.current(), null);
});

// ------------------------------------------------------------------ store & resources

test('store notifies only subscribers of changed keys and supports select/update', () => {
  const store = createStore({ a: 1, b: 2 });
  const calls = [];
  const off = store.subscribe(['a'], state => calls.push(['a', state.a]));
  store.subscribe(state => calls.push(['all', state.b]));
  store.set({ b: 3 });
  store.set({ a: 1 });
  store.update('a', value => value + 1);
  assert.deepEqual(calls, [['all', 3], ['a', 2], ['all', 3]]);
  off();
  store.set({ a: 5 });
  assert.equal(calls.filter(([key]) => key === 'a').length, 1);
  assert.equal(store.select(state => state.a + state.b), 8);
});

test('failed refresh keeps the last good data; a denied read clears it', () => {
  const ok = nextResourceState(null, { ok: true, data: { v: 1 }, now: 10 });
  const failed = nextResourceState(ok, { ok: false, error: { status: 500 }, now: 20 });
  assert.deepEqual(failed.data, { v: 1 });
  assert.equal(failed.lastSuccessAt, 10);
  assert.equal(failed.status, 'error');
  const denied = nextResourceState(ok, { ok: false, error: { status: 403 }, now: 30 });
  assert.equal(denied.data, null);
  assert.equal(denied.lastSuccessAt, null);
});

test('resources are reference-counted, poll only while visible and refresh on visibility', async () => {
  const store = createStore();
  const doc = { hidden: false, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, removeEventListener() {} };
  const timers = new Map();
  let nextId = 0;
  let fetches = 0;
  const manager = createResourceManager({
    store,
    api: {},
    doc,
    definitions: { status: { interval: 1000, fetch: async () => ({ n: ++fetches }) }, analysis: { manual: true, fetch: async () => 'x' } },
    setIntervalImpl: fn => { const id = ++nextId; timers.set(id, fn); return id; },
    clearIntervalImpl: id => timers.delete(id)
  });
  const releaseA = manager.use(['status', 'analysis']);
  const releaseB = manager.use(['status']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetches, 1, 'second use of an active resource does not refetch');
  assert.equal(store.get(resourceKey('analysis')), undefined, 'manual resources are never auto-fetched');
  assert.equal(timers.size, 1);
  doc.hidden = true;
  [...timers.values()][0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetches, 1, 'hidden documents do not poll');
  doc.hidden = false;
  doc.listeners.visibilitychange();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetches, 2, 'becoming visible refreshes active resources');
  releaseA();
  assert.equal(timers.size, 1);
  releaseB();
  assert.equal(timers.size, 0, 'last release stops polling');
  assert.deepEqual(store.get(resourceKey('status')).data, { n: 2 });
});

test('every catalog resource reads only the authenticated /api plane', async () => {
  const paths = [];
  const api = { get: async route => { paths.push(route); return route.startsWith('/market/prices/snapshot') ? { prices: [] } : {}; } };
  for (const [name, definition] of Object.entries(RESOURCE_CATALOG)) {
    await definition.fetch(api, definition.defaultParams ?? (name === 'coinDetail' ? 'KRW-BTC' : undefined));
  }
  assert.ok(paths.length >= Object.keys(RESOURCE_CATALOG).length);
  for (const route of paths) assert.match(route, /^\/[a-z]/, route);
});

// ------------------------------------------------------------------ api & session

test('api refuses requests outside the token scope before calling fetch and normalises errors', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, init.method, init.headers]);
    if (url.endsWith('/fail')) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  let auth = { authRequired: true, resolved: true, verification: 'verified', tokenScope: 'read_only' };
  const api = createApi({ fetchImpl, getAuth: () => auth });
  assert.deepEqual(await api.get('/status'), { ok: true });
  await assert.rejects(api.post('/control/start'), error => error.status === 403 && error.code === 'client_scope_blocked');
  await assert.rejects(api.get('/stocks/status'), error => error.status === 403);
  assert.equal(calls.length, 1);
  auth = { authRequired: false, resolved: true, verification: 'not-required' };
  await assert.rejects(api.get('/fail'), error => error.status === 500 && error.message === 'boom');
  await api.post('/control/stop');
  assert.equal(calls.at(-1)[0], '/api/control/stop');
  assert.equal(calls.at(-1)[2]['Content-Type'], 'application/json');
});

test('session derives the workspace and locks from the latest reads only', () => {
  const base = { auth: { authRequired: false, resolved: true, verification: 'not-required' }, online: true, mutation: { locked: false } };
  const live = deriveSession({ ...base, [resourceKey('status')]: { data: { mode: 'LIVE' } } });
  assert.equal(live.isLive, true);
  assert.equal(live.canMutate, true);
  const unknown = deriveSession({ ...base, [resourceKey('status')]: { data: null } });
  assert.equal(unknown.modeKnown, false);
  const observer = deriveSession({ ...base, [resourceKey('status')]: { data: { mode: 'DRY_RUN', readOnlyObserver: true } } });
  assert.equal(observer.canMutate, false);
  assert.match(observer.mutationBlockedReason, /관찰/);
  const offline = deriveSession({ ...base, online: false });
  assert.equal(offline.canMutate, false);
  const paperLock = deriveSession({ ...base, [resourceKey('paper')]: { data: { active: true } } });
  assert.equal(paperLock.evidenceLock.locked, true);
});

test('realtime events update the store and refresh dependent resources', () => {
  const handlers = {};
  const socket = { on(name, fn) { handlers[name] = fn; }, disconnect() {} };
  const store = createStore();
  const refreshed = [];
  const toasts = [];
  connectRealtime({ store, resources: { has: () => true, refresh: name => refreshed.push(name) }, toast: (...args) => toasts.push(args), io: () => socket });
  handlers.connect();
  assert.equal(store.get('realtime').connected, true);
  handlers['auto-trade']({ trade: { coin: 'KRW-BTC', type: 'SELL' } });
  assert.deepEqual(refreshed, REALTIME_EVENTS['auto-trade'].refresh);
  assert.match(toasts[0][0], /BTC 매도/);
  handlers['ai-consultation']({ consultation: { id: 'c1' } });
  assert.equal(store.get('aiConsultation').value.id, 'c1');
  handlers['ai-session-update']({});
  assert.equal(store.get('aiSession'), undefined, 'empty payloads are ignored');
});

// ------------------------------------------------------------------ dom & format

test('html templates escape every interpolation unless explicitly trusted', () => {
  const evil = '<img src=x onerror="alert(1)">';
  const out = String(html`<p title="${evil}">${evil}</p>`);
  assert.equal(out.includes('<img'), false);
  assert.equal(out, '<p title="&lt;img src=x onerror=&quot;alert(1)&quot;&gt;">&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>');
  assert.equal(String(html`<b>${html`<i>${'&'}</i>`}</b>`), '<b><i>&amp;</i></b>', 'nested templates stay safe');
  assert.equal(String(html`${['<a>', raw('<br>')]}`), '&lt;a&gt;<br>');
  assert.equal(String(html`${null}${undefined}${false}${0}`), '0');
  assert.equal(String(join(['<x>', '<y>'], raw(', '))), '&lt;x&gt;, &lt;y&gt;');
  assert.equal(escapeHtml(`'"`), '&#039;&quot;');
});

test('feature and ui code never assigns innerHTML from unescaped strings', () => {
  for (const file of listFiles(appDir).filter(name => name.endsWith('.js'))) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)) {
      const rhs = match[1];
      assert.ok(/serialize\(|String\(html`|String\(content|String\(footer|iconSvg|icon\(|escapeHtml\(/.test(rhs), `${path.relative(root, file)}: innerHTML = ${rhs}`);
    }
  }
});

test('format renders Korean money/percent/time and keeps missing values distinct from zero', () => {
  assert.equal(format.won(1234567.4), '1,234,567원');
  assert.equal(format.won(null), '—');
  assert.equal(format.signedWon(-1500), '-1,500원');
  assert.equal(format.signedWon(0), '0원');
  assert.equal(format.percent(1.234), '+1.23%');
  assert.equal(format.percent(undefined), '—');
  assert.equal(format.compactWon(123_400_000), '1.2억');
  assert.equal(format.compactWon(34_000_000), '3,400만');
  assert.equal(format.price(0.00012345), '0.00012345');
  assert.equal(format.tone(3), 'up');
  assert.equal(format.tone(-3), 'down');
  assert.equal(format.tone(null), '');
  assert.equal(format.marketTimestamp(''), '시각 정보 미제공');
  assert.equal(format.marketTimestamp('nope'), '시각 형식 오류');
  assert.equal(format.marketTimestamp({}), '시각 형식 오류');
  assert.equal(format.relativeTime(new Date(Date.now() - 90_000).toISOString()), '1분 전');
  assert.equal(format.durationSeconds(3725), '1시간 2분');
  assert.equal(format.symbolOf('KRW-BTC'), 'BTC');
});

// ------------------------------------------------------------------ server & static contract

async function withDashboard(options, run) {
  const trader = createMockTrader();
  const dashboard = new DashboardServer(trader, 0, {
    env: { ...process.env, DASHBOARD_TOKEN: '', DASHBOARD_READ_ONLY_TOKEN: '', DASHBOARD_MOBILE_TOKEN: '', DASHBOARD_HOST: '127.0.0.1' },
    ...options
  });
  const httpServer = await dashboard.start();
  try {
    await run(`http://127.0.0.1:${httpServer.address().port}`);
  } finally {
    const closed = dashboard.httpServer?.listening ? once(dashboard.httpServer, 'close') : Promise.resolve();
    await dashboard.stop();
    trader.stop();
    await closed;
  }
}

test('server serves the new shell at / with module assets and no legacy dashboard', async () => {
  await withDashboard({}, async base => {
    const shell = await fetch(`${base}/`);
    assert.equal(shell.status, 200);
    const page = await shell.text();
    assert.match(page, /<div id="cp-app"/);
    assert.match(page, /<script type="module" src="\/app\/main\.js"><\/script>/);
    assert.match(page, /<script src="\/auth-client\.js"><\/script>/);
    assert.ok(page.indexOf('/auth-client.js') < page.indexOf('/app/main.js'), 'auth gate patches fetch before the app boots');
    for (const asset of ['/app/main.js', '/app/core/router.js', '/app/ui/tokens.css', '/app/features/stocks/index.js']) {
      const response = await fetch(`${base}${asset}`);
      assert.equal(response.status, 200, asset);
      await response.text();
    }
    for (const legacy of ['/pilot-redesign.js', '/pilot-redesign.css', '/ai-desk.js', '/icons.css']) {
      const response = await fetch(`${base}${legacy}`);
      assert.notEqual(response.status, 200, `${legacy} must be gone`);
      await response.text();
    }
  });
});

test('mock dashboard exposes stock and horizon status shaped like the real services', async () => {
  await withDashboard({ stockTradingService: createMockStockTradingService(), coinHorizon: createMockCoinHorizon() }, async base => {
    const stocks = await (await fetch(`${base}/api/stocks/status`)).json();
    assert.equal(stocks.enabled, true);
    assert.equal(stocks.paper.mode, 'paper');
    assert.ok(Array.isArray(stocks.paper.positions));
    const horizons = await (await fetch(`${base}/api/horizons/status`)).json();
    assert.ok(horizons.coin.sleeves.short);
    assert.ok(horizons.coin.research.sleeves.every(item => typeof item.passed === 'boolean'));
    assert.ok(horizons.stock.paper);
    const reset = await fetch(`${base}/api/stocks/paper/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(reset.status, 409, 'paper reset with open positions is refused');
    await reset.text();
  });
});

test('shell assets are self-hosted: no CDN, no third-party brand assets', () => {
  const files = [path.join(root, 'public/index.html'), ...listFiles(appDir)];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    assert.equal(/https?:\/\/(?!www\.w3\.org|coinpilot\.invalid)/.test(source), false, `${path.relative(root, file)} references a remote URL`);
  }
});

test('design tokens define the shared light/dark palette as six-digit hex', () => {
  const tokens = read('public/app/ui/tokens.css');
  const firstRoot = tokens.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] || '';
  const expectedLight = { paper: '#f2f4f6', surface: '#ffffff', surface2: '#f7f8fa', ink: '#191f28', muted: '#66707f', line: '#e5e8eb', blue: '#1b64da', green: '#027648', red: '#a51926', amber: '#96590a', up: '#d2283c', down: '#1b64da' };
  for (const [name, value] of Object.entries(expectedLight)) assert.match(firstRoot, new RegExp(`--cp-${name}:\\s*${value};`), `--cp-${name}`);
  const dark = tokens.match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/)?.[1] || '';
  const expectedDark = { paper: '#101114', surface: '#1b1c21', surface2: '#24252b', ink: '#f2f4f6', muted: '#9aa1ac', line: '#2e2f36', blue: '#5a9dff', green: '#34c98a', red: '#ff7b7b', amber: '#f1b552', up: '#ff6b7a', down: '#5a9dff' };
  for (const [name, value] of Object.entries(expectedDark)) assert.match(dark, new RegExp(`--cp-${name}:\\s*${value};`), `dark --cp-${name}`);
  assert.match(tokens, /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)/);
  assert.match(tokens, /@media \(prefers-reduced-motion: reduce\)/);
});

test('responsive shell: 5-slot tab bar under 960px, sidebar at ≥960px, touch targets ≥44px', () => {
  const base = read('public/app/ui/base.css');
  assert.match(base, /\.cp-tabbar \{[^}]*grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/);
  assert.match(base, /@media \(min-width: 960px\) \{[\s\S]*?\.cp-sidebar \{ display: flex; \}[\s\S]*?\.cp-tabbar \{ display: none; \}/);
  assert.match(base, /\.cp-tab \{[^}]*min-height: 48px/);
  assert.match(base, /\.cp-nav-link \{[^}]*min-height: 44px/);
  assert.match(base, /body \{[^}]*overflow-x: hidden/);
  assert.match(base, /env\(safe-area-inset-bottom/);
  const components = read('public/app/ui/components.css');
  assert.match(components, /\.cp-btn \{[^}]*min-height: 44px/);
});
