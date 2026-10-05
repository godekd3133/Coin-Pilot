import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../public/pilot-redesign.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = source.match(new RegExp(`    (?:async )?function ${name}\\([^]*?\\n    }`));
  assert.ok(match, `missing function: ${name}`);
  return match[0];
}
function load(name, dependencies = {}, companions = []) {
  return new Function(...Object.keys(dependencies), `${[...companions, name].map(functionSource).join('\n')}\nreturn ${name};`)(...Object.values(dependencies));
}
const nextStep = load('nextStepPresentation');
const record = load('tradeRecordPresentation');
const searchHelpers = ['symbolOf', 'marketDisplayName', 'marketSearchText'];
const filterRecords = load('filteredTradeRecords', {}, ['tradeRecordPresentation', ...searchHelpers]);
const escapeHtml = load('escapeHtml');
const baseHome = {
  online: true, coreReady: true, status: { mode: 'DRY_RUN', isRunning: false },
  paper: { available: true, state: 'STOPPED' }, positionCount: 0, readOnly: false,
  marketIssue: false, pending: false
};

test('home prioritizes connection, reconciliation and stale prices above starting paper or inspecting gains', () => {
  assert.equal(nextStep({ ...baseHome, online: false, positionCount: 3 }).action, 'refresh-core');
  assert.equal(nextStep({ ...baseHome, coreReady: false, paper: { active: true } }).action, 'refresh-core');
  assert.equal(nextStep({ ...baseHome, status: { ...baseHome.status, runtimeState: 'SYNC_REQUIRED' }, positionCount: 2 }).view, 'history');
  assert.equal(nextStep({ ...baseHome, marketIssue: true, positionCount: 2 }).action, 'refresh-market');
  assert.equal(nextStep({ ...baseHome, pending: true }).view, 'records');
});

test('home distinguishes first use, confirmed stop, running, holdings and unavailable paper state', () => {
  assert.match(nextStep({ ...baseHome, paper: { available: false, reason: 'paper_validation_session_not_started' } }).title, /먼저 경험/);
  assert.equal(nextStep({ ...baseHome, positionCount: 2 }).view, 'portfolio');
  assert.equal(nextStep({ ...baseHome, paper: { active: true, state: 'RUNNING' } }).view, 'records');
  assert.match(nextStep(baseHome).copy, /멈춰/);
  for (const paper of [null, { available: false, reason: 'read_failed' }]) {
    const next = nextStep({ ...baseHome, paper });
    assert.doesNotMatch(next.copy, /멈춰|이전 기록/);
    assert.equal(next.action, 'refresh-core');
  }
});

test('read-only first use and reconciliation never suggest starting a paper session', () => {
  const readOnly = { ...baseHome, readOnly: true, paper: { available: false, reason: 'paper_validation_session_not_started' } };
  assert.equal(nextStep(readOnly).view, 'market');
  assert.equal(nextStep({ ...readOnly, status: { ...readOnly.status, runtimeState: 'PROTECTIVE_ONLY' } }).view, 'portfolio');
});

test('strategy CLOSE and PARTIAL_CLOSE override BUY position type, use coin quantity and close time', () => {
  const close = record({ coin: 'KRW-BTC', action: 'CLOSE', type: 'BUY', source: 'strategy', amount: 0.02, entryPrice: 100000000, exitPrice: 110000000, entryTime: '2026-10-01T00:00:00Z', exitTime: '2026-10-02T00:00:00Z', profit: null });
  assert.equal(close.side, 'sell');
  assert.equal(close.quantity, 0.02);
  assert.equal(close.amount, 2200000);
  assert.equal(close.time, '2026-10-02T00:00:00Z');
  assert.equal(close.profit, null);
  const partial = record({ action: 'PARTIAL_CLOSE', type: 'BUY', source: 'strategy', amount: 0.01, exitPrice: 100, profit: 0 });
  assert.equal(partial.label, '부분 매도');
  assert.equal(partial.amount, 1);
  assert.equal(partial.profit, 0);
});

test('smart records use volume and gross amount, preserving missing values and invalid dates', () => {
  const smart = record({ type: 'SELL', source: 'smart-sell', coin: 'KRW-ETH', amount: 9995, volume: 0.5, price: 20000, grossAmount: 10000, profit: -50, timestamp: 'not-a-date' });
  assert.equal(smart.quantity, 0.5);
  assert.equal(smart.amount, 10000);
  assert.equal(smart.time, null);
  assert.equal(smart.profit, -50);
  const missing = record({ type: 'BUY', source: 'smart-buy', amount: 1000, volume: null, price: null });
  assert.equal(missing.quantity, null);
  assert.equal(missing.amount, null);
  assert.equal(missing.profit, null);
});

test('bundle records retain both markets and leg amounts without inventing combined profit', () => {
  const bundle = { type: 'BUNDLE_TRADE', sell: { coin: 'KRW-BTC', amount: 0.1, price: 100000, grossValue: 10000 }, buy: { coin: 'KRW-ETH', amount: 2, price: 5000, grossValue: 10000 }, timestamp: '2026-10-02T00:00:00Z' };
  const presentation = record(bundle);
  assert.equal(presentation.marketLabel, 'BTC → ETH');
  assert.equal(presentation.legs[0].quantity, 0.1);
  assert.equal(presentation.legs[1].amount, 10000);
  assert.equal(presentation.profit, null);
  assert.equal(filterRecords([bundle], 'buy', '이더리움').length, 1);
  assert.equal(filterRecords([bundle], 'sell', 'BTC').length, 1);
});

test('record filters search Korean names and symbols and sort close dates without changing input', () => {
  const rows = [
    { coin: 'KRW-BTC', type: 'BUY', action: 'OPEN', entryTime: '2026-10-01T00:00:00Z' },
    { coin: 'KRW-ETH', type: 'BUY', action: 'CLOSE', entryTime: '2026-09-01T00:00:00Z', exitTime: '2026-10-04T00:00:00Z' },
    { coin: 'KRW-XRP', type: 'BUY' }
  ];
  assert.equal(filterRecords(rows, 'sell', '이더리움')[0].coin, 'KRW-ETH');
  assert.equal(filterRecords(rows, 'all', '')[0].coin, 'KRW-ETH');
  assert.equal(filterRecords(rows, 'buy', 'BTC').length, 1);
  assert.equal(filterRecords(rows, 'buy', '리플').length, 1);
  assert.equal(rows[0].coin, 'KRW-BTC');
  assert.equal(filterRecords(rows, 'sell', '없는종목').length, 0);
});

test('market paging renders more than the previous 80-row cutoff and reports the displayed subset', () => {
  const state = { marketPrices: Array.from({ length: 105 }, (_, index) => ({ coin: `KRW-C${index}`, price: 1, change: 0, volumeKrw: 105 - index })), marketVisibleCount: 40, marketPricesLoaded: true };
  const target = { innerHTML: '' }; const more = { hidden: true, textContent: '' }; const labels = {};
  const render = load('renderMarketList', {
    state, byId: id => id === 'pilot-market-list' ? target : id === 'pilot-market-more' ? more : null,
    setText: (id, value) => { labels[id] = value; }, escapeHtml,
    marketRowQuotePresentation: () => ({ state: 'fresh', label: '현재 시세' }),
    formatPrice: String, formatPercent: String, formatWon: String, classForValue: () => '', number: Number
  }, [...searchHelpers, 'sortedMarketPrices']);
  render();
  assert.equal((target.innerHTML.match(/data-pilot-market-row=/g) || []).length, 40);
  assert.equal(more.hidden, false);
  assert.match(labels['pilot-market-count'], /105개.*40개 표시/);
  state.marketVisibleCount = 120; render();
  assert.equal((target.innerHTML.match(/data-pilot-market-row=/g) || []).length, 105);
  assert.equal(more.hidden, true);
  state.marketSearch = 'no-match'; render();
  assert.match(target.innerHTML, /reset-market-search/);
});

test('analysis details require an explicit direction and do not offer selling an unowned coin', () => {
  const state = { analysis: { timestamp: '2026-10-01T00:00:00Z', coins: [{ coin: 'KRW-ETH', recommendation: 'SELL', signals: ['RSI 과매수'] }] }, trade: { trade: { side: 'buy' } } };
  let modal; let position = { amount: 2 };
  const open = load('openAnalysisDetail', { state, currentPosition: () => position, showModal: (...args) => { modal = args; }, escapeHtml, toUserText: String, analysisRecommendationLabel: String, formatDateTime: String }, ['symbolOf', 'marketDisplayName']);
  open('KRW-ETH');
  assert.match(modal[1], /RSI 과매수/);
  assert.match(modal[2], /data-pilot-analysis-review="sell"/);
  assert.doesNotMatch(modal[2], /data-pilot-analysis-review="buy"/);
  assert.equal(state.trade.trade.side, 'buy');
  position = null; open('KRW-ETH');
  assert.doesNotMatch(modal[2], /data-pilot-analysis-review/);
  assert.match(modal[1], /보유 수량이 없어/);
  state.analysis.coins[0].recommendation = 'HOLD'; open('KRW-ETH');
  assert.doesNotMatch(modal[2], /data-pilot-analysis-review/);
  state.analysis.coins[0].recommendation = 'BUY'; open('KRW-ETH');
  assert.match(modal[2], /data-pilot-analysis-review="buy"/);
});

test('partial core failures preserve prior values and their success time; denied reads clear both', async () => {
  const state = { auth: { authRequired: false, verification: 'not-required' }, online: true, coreReadStatus: {}, marketPrices: [], selectedCoin: 'KRW-BTC', chartPeriod: '24h', view: 'overview', pnl: null };
  let failure = null;
  const requestJSON = async path => {
    if (path === '/cumulative-pnl' && failure) throw failure;
    if (path === '/status') return { mode: 'DRY_RUN' };
    if (path === '/account') return { mode: 'DRY_RUN', krwBalance: 1000, totalAssets: 1000 };
    if (path === '/cumulative-pnl') return { profit: 25 };
    if (path === '/market/prices/snapshot') return { prices: [{ coin: 'KRW-BTC', price: 100 }], complete: true, marketListStale: false };
    if (path.startsWith('/trades?')) return [];
    return {};
  };
  const helpers = ['coreReadPresentation', 'normalizeMarketPriceSnapshot', 'isCoreTradingSnapshotReady'];
  const args = { state, requestJSON, waitForPwaAuth: async () => {}, isMobileOperatorPwaScope: () => false, isReadOnlyPwaScope: () => false, syncObserverControls: () => {}, setConnection: () => {}, renderAll: () => {}, runtimeCanAcceptOrders: () => false };
  const loadCore = new Function(...Object.keys(args), `let networkGeneration = 0; let refreshAfterCurrent = false; ${helpers.map(functionSource).join('\n')} ${functionSource('loadCore')} return loadCore;`)(...Object.values(args));
  await loadCore();
  const firstSuccess = state.coreReadStatus.pnl.lastSuccess;
  assert.equal(state.pnl.profit, 25);
  failure = new Error('temporary network failure');
  await loadCore();
  assert.equal(state.pnl.profit, 25);
  assert.equal(state.coreReadStatus.pnl.lastSuccess, firstSuccess);
  assert.equal(state.coreReadStatus.pnl.ok, false);
  assert.equal(state.coreReadStatus.account.ok, true);
  const note = load('coreReadNote', { state, formatTime: String });
  assert.match(note('pnl'), /이전 자료.*갱신 실패/);
  failure.status = 403; await loadCore();
  assert.equal(state.pnl, null);
  assert.equal(state.coreReadStatus.pnl.lastSuccess, null);
  assert.match(note('pnl'), /불러오지 못/);
});

test('known exit reasons use plain Korean without changing unrecognized server explanations', () => {
  assert.equal(record({ action: 'CLOSE', reason: 'TAKE_PROFIT' }).reason, '목표 수익 도달');
  assert.equal(record({ action: 'CLOSE', reason: 'STOP_LOSS' }).reason, '손절 기준 도달');
  assert.equal(record({ action: 'CLOSE', reason: '사용자가 직접 중지' }).reason, '사용자가 직접 중지');
});

test('navigation resets the actual content scroll only on view changes, not data refreshes', () => {
  const state = { view: 'overview' }; let contentScrolls = 0; let windowScrolls = 0;
  const showView = load('showView', {
    state, closeMobileNavigationMenu: () => {}, clearToasts: () => {}, localStorage: { setItem() {} },
    root: { querySelector: () => ({ scrollTo() { contentScrolls += 1; } }) },
    window: { scrollTo() { windowScrolls += 1; } }, $$: () => [], syncViewNavigation: () => {},
    loadCore: async () => {}, renderAll: () => {}
  });
  showView('records');
  assert.equal(contentScrolls, 1); assert.equal(windowScrolls, 1);
  showView('records');
  assert.equal(contentScrolls, 1); assert.equal(windowScrolls, 1);
});

test('mobile market discovery moves the same list before details and restores desktop order', () => {
  const list = {}; const detail = {}; let listener; const orders = [];
  const media = { matches: true, addEventListener: (event, callback) => { assert.equal(event, 'change'); listener = callback; } };
  const page = { querySelector: selector => selector === '.pilot-market-discovery' ? list : detail, insertBefore: (node, before) => orders.push([node, before]), append: node => orders.push([node]) };
  const mount = load('mountMarketDiscoveryLayout', { root: { querySelector: () => page }, window: { matchMedia: () => media } });
  mount(); assert.deepEqual(orders[0], [list, detail]);
  media.matches = false; listener(); assert.deepEqual(orders[1], [list]);
  media.matches = true; listener(); assert.deepEqual(orders[2], [list, detail]);
});

test('delegated modal actions run inside the backdrop while explicit close and direct backdrop clicks dismiss', async () => {
  const callbackBody = source.match(/root\.addEventListener\('click', async event => \{([\s\S]*?)\n {4}\}\);/)?.[1];
  assert.ok(callbackBody, 'actual delegated click handler must be available');
  const state = { selectedCoin: 'KRW-BTC', trade: { trade: { side: 'buy' } } };
  let closes = 0; const views = []; let renders = 0;
  const handler = new Function('state', 'closeModal', 'showView', 'renderTradePanels', `return async event => { ${callbackBody} };`)(
    state, () => { closes += 1; }, view => { views.push(view); }, () => { renders += 1; }
  );
  const backdrop = { matches: selector => selector === '.pilot-modal-backdrop' };
  const marketButton = { dataset: { pilotAnalysisMarket: 'KRW-ETH' } };
  const reviewButton = { dataset: { pilotAnalysisReview: 'sell', pilotCoin: 'KRW-ETH' } };
  const insideTarget = activeSelector => ({ closest: selector => selector === '[data-pilot-modal-close]' ? backdrop : selector === activeSelector ? activeSelector === '[data-pilot-analysis-market]' ? marketButton : reviewButton : null });
  await handler({ target: insideTarget('[data-pilot-analysis-market]') });
  assert.equal(state.selectedCoin, 'KRW-ETH');
  assert.deepEqual(views, ['market']);
  assert.equal(closes, 1);
  await handler({ target: insideTarget('[data-pilot-analysis-review]') });
  assert.equal(state.trade.trade.side, 'sell');
  assert.deepEqual(views, ['market', 'trade']);
  assert.equal(renders, 1);
  assert.equal(closes, 2);
  await handler({ target: insideTarget('no-action') });
  assert.equal(closes, 2, 'ordinary dialog content must not dismiss the modal');
  const closeButton = { matches: () => false };
  await handler({ target: { closest: selector => selector === '[data-pilot-modal-close]' ? closeButton : null } });
  assert.equal(closes, 3, 'explicit close also works through a nested icon target');
  backdrop.closest = selector => selector === '[data-pilot-modal-close]' ? backdrop : null;
  await handler({ target: backdrop });
  assert.equal(closes, 4, 'a direct click on the backdrop dismisses');
  assert.deepEqual(views, ['market', 'trade']);
});
