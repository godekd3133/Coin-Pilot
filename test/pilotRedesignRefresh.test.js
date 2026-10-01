import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const redesignSource = fs.readFileSync(
  path.join(projectRoot, 'public/pilot-redesign.js'),
  'utf8'
);
const redesignStyleSource = fs.readFileSync(
  path.join(projectRoot, 'public/pilot-redesign.css'),
  'utf8'
);
const indexSource = fs.readFileSync(path.join(projectRoot, 'public/index.html'), 'utf8');
const serviceWorkerSource = fs.readFileSync(path.join(projectRoot, 'public/sw.js'), 'utf8');
const designQaSource = fs.readFileSync(path.join(projectRoot, 'design-qa.md'), 'utf8');
const serviceWorkerAppShell = serviceWorkerSource.match(/const APP_SHELL = \[([\s\S]*?)\n\];/)?.[1] || '';
const manifestSource = fs.readFileSync(path.join(projectRoot, 'public/manifest.webmanifest'), 'utf8');
const redesignScriptAsset = indexSource.match(/<script\s+src=["'](\/pilot-redesign\.js\?v=[^"']+)["']/)?.[1];
const redesignStylesheetAsset = indexSource.match(/<link\s+rel=["']stylesheet["']\s+href=["'](\/pilot-redesign\.css\?v=[^"']+)["']/)?.[1];
const serviceWorkerCacheName = serviceWorkerSource.match(/const CACHE_NAME = ["']([^"']+)["']/)?.[1];
const manualOrderServiceSource = fs.readFileSync(path.join(projectRoot, 'src/api/manualOrderService.js'), 'utf8');
const coreReadinessFunctionSource = redesignSource.match(
  /function isCoreTradingSnapshotReady\(\{[\s\S]*?\n {4}\}/
)?.[0];
const isCoreTradingSnapshotReady = coreReadinessFunctionSource
  ? new Function(`${coreReadinessFunctionSource}; return isCoreTradingSnapshotReady;`)()
  : null;
const marketTimestampFunctionSource = redesignSource.match(
  /function formatMarketTimestamp\(value\) \{[\s\S]*?\n {4}\}/
)?.[0];
const formatMarketTimestamp = marketTimestampFunctionSource
  ? new Function(`${marketTimestampFunctionSource}; return formatMarketTimestamp;`)()
  : null;
const marketQuoteFreshnessFunctionSource = redesignSource.match(
  /function marketQuoteFreshnessIssue\(market, now = Date\.now\(\)\) \{[\s\S]*?\n {4}\}/
)?.[0];
const marketQuoteFreshnessIssue = marketQuoteFreshnessFunctionSource
  ? new Function('state', `${marketQuoteFreshnessFunctionSource}; return marketQuoteFreshnessIssue;`)({
    status: { maxCandleAgeSeconds: 90 }
  })
  : null;
const lastGoodMarketQuoteFreshnessIssue = marketQuoteFreshnessFunctionSource
  ? new Function('state', `${marketQuoteFreshnessFunctionSource}; return marketQuoteFreshnessIssue;`)({
    status: { maxCandleAgeSeconds: 90 },
    marketSnapshot: { snapshotSource: 'last_good' }
  })
  : null;
const protectedMutationErrorFunctionSource = redesignSource.match(
  /function protectedMutationError\(outcome, fallback\) \{[\s\S]*?\n {4}\}/
)?.[0];
const protectedMutationError = protectedMutationErrorFunctionSource
  ? new Function('symbolOf', `${protectedMutationErrorFunctionSource}; return protectedMutationError;`)(
    market => typeof market === 'string' ? market.replace(/^KRW-/, '') : '종목'
  )
  : null;
const marketSnapshotNormalizerFunctionSource = redesignSource.match(
  /function normalizeMarketPriceSnapshot\(snapshot\) \{[\s\S]*?\n {4}\}/
)?.[0];
const normalizeMarketPriceSnapshot = marketSnapshotNormalizerFunctionSource
  ? new Function(`${marketSnapshotNormalizerFunctionSource}; return normalizeMarketPriceSnapshot;`)()
  : null;
const legacyMarketSnapshotHelpersStart = redesignSource.indexOf('    function oldestLegacyRowTimestamp(');
const legacyMarketSnapshotHelpersEnd = redesignSource.indexOf('    function marketSnapshotPresentation(', legacyMarketSnapshotHelpersStart);
const legacyMarketSnapshotHelpersSource = legacyMarketSnapshotHelpersStart >= 0 && legacyMarketSnapshotHelpersEnd > legacyMarketSnapshotHelpersStart
  ? redesignSource.slice(legacyMarketSnapshotHelpersStart, legacyMarketSnapshotHelpersEnd)
  : null;
const buildLegacyMarketPriceSnapshot = legacyMarketSnapshotHelpersSource
  ? new Function(`${legacyMarketSnapshotHelpersSource}; return buildLegacyMarketPriceSnapshot;`)()
  : null;
const loadLegacyMarketSnapshotFunctionSource = redesignSource.match(
  /async function loadLegacyMarketSnapshotOn404\(error, targetCoins, readJSON\) \{[\s\S]*?\n {4}\}/
)?.[0];
const loadLegacyMarketSnapshotOn404 = loadLegacyMarketSnapshotFunctionSource
  ? new Function(
    'buildLegacyMarketPriceSnapshot',
    `${loadLegacyMarketSnapshotFunctionSource}; return loadLegacyMarketSnapshotOn404;`
  )(buildLegacyMarketPriceSnapshot)
  : null;
const marketSnapshotPresentationFunctionSource = redesignSource.match(
  /function marketSnapshotPresentation\(snapshot, loaded, prices\) \{[\s\S]*?\n {4}\}/
)?.[0];
const marketSnapshotPresentation = marketSnapshotPresentationFunctionSource
  ? new Function(
    'formatMarketTimestamp', 'marketQuoteFreshnessIssue',
    `${marketSnapshotPresentationFunctionSource}; return marketSnapshotPresentation;`
  )(formatMarketTimestamp, () => null)
  : null;
const selectedMarketQuotePresentationFunctionSource = redesignSource.match(
  /function selectedMarketQuotePresentation\(\s*marketData,\s*snapshotPresentation,\s*latestReadSucceeded = true,\s*now = Date\.now\(\)\s*\) \{[\s\S]*?\n {4}\}/
)?.[0];
const selectedMarketQuotePresentation = selectedMarketQuotePresentationFunctionSource
  ? new Function(
    'formatMarketTimestamp', 'marketQuoteFreshnessIssue',
    `${selectedMarketQuotePresentationFunctionSource}; return selectedMarketQuotePresentation;`
  )(formatMarketTimestamp, marketQuoteFreshnessIssue)
  : null;
const marketRowQuotePresentationFunctionSource = redesignSource.match(
  /function marketRowQuotePresentation\(marketData, latestReadSucceeded, now = Date\.now\(\)\) \{[\s\S]*?\n {4}\}/
 )?.[0];
const marketRowQuotePresentation = marketRowQuotePresentationFunctionSource
  ? new Function(
    'formatMarketTimestamp', 'marketQuoteFreshnessIssue',
    `${marketRowQuotePresentationFunctionSource}; return marketRowQuotePresentation;`
  )(formatMarketTimestamp, marketQuoteFreshnessIssue)
  : null;
const displayedCandlesFunctionSource = redesignSource.match(
  /function getDisplayedCandles\(candles, displayRange\) \{[\s\S]*?\n {4}\}/
)?.[0];
const getDisplayedCandles = displayedCandlesFunctionSource
  ? new Function(`${displayedCandlesFunctionSource}; return getDisplayedCandles;`)()
  : null;
const positionRowsStart = redesignSource.indexOf('    function renderPositionRows(targetId) {');
const positionRowsEnd = redesignSource.indexOf('\n    function renderPositionHeaders()', positionRowsStart);
const positionRowsFunctionSource = positionRowsStart >= 0 && positionRowsEnd > positionRowsStart
  ? redesignSource.slice(positionRowsStart, positionRowsEnd).trim()
  : null;
const marketChartStart = redesignSource.indexOf('    function drawMarketChart() {');
const marketChartEnd = redesignSource.indexOf('\n    function renderCandleControls()', marketChartStart);
const marketChartFunctionSource = marketChartStart >= 0 && marketChartEnd > marketChartStart
  ? redesignSource.slice(marketChartStart, marketChartEnd).trim()
  : null;
const candleLoaderFunctionSource = redesignSource.match(
  /async function loadCandles\(force = false\) \{[\s\S]*?\n {4}\}/
)?.[0];
const pendingMutationClientFunctionSource = redesignSource.match(
  /function createPendingMutationClient\(\{[\s\S]*?\n {4}\}/
)?.[0];
const pendingMutationEndpoints = [
  '/trade/execute-bundle', '/trade/execute', '/trade/buy', '/trade/sell',
  '/trade/smart-buy', '/trade/smart-sell',
  '/virtual/deposit', '/virtual/withdraw', '/virtual/reset'
];
const createPendingMutationClient = pendingMutationClientFunctionSource
  ? new Function(
    `const PENDING_MUTATION_STORAGE_KEY = 'coinpilot.pending-mutation.v1';
     const PENDING_MUTATION_LOCK_NAME = 'coinpilot.pending-mutation.v1';
     const PENDING_MUTATION_ENDPOINTS = new Set(${JSON.stringify(pendingMutationEndpoints)});
     ${pendingMutationClientFunctionSource}; return createPendingMutationClient;`
  )()
  : null;
const smartOrderCapacityStart = redesignSource.indexOf('    function completeHoldingsValuation(');
const smartOrderCapacityEnd = redesignSource.indexOf('\n    function positionDataKnown(', smartOrderCapacityStart);
const smartOrderCapacitySource = smartOrderCapacityStart >= 0 && smartOrderCapacityEnd > smartOrderCapacityStart
  ? redesignSource.slice(smartOrderCapacityStart, smartOrderCapacityEnd).trim()
  : null;
const manualOrderCapacityPresentation = smartOrderCapacitySource
  ? new Function(
    'hasFiniteValue', 'formatWon',
    `${smartOrderCapacitySource}; return manualOrderCapacityPresentation;`
  )(
    value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)),
    value => `${Math.round(Number(value)).toLocaleString('ko-KR')}원`
  )
  : null;
const portfolioAllocationFunctionSource = redesignSource.match(
  /function portfolioAllocationPresentation\(holdings, cashBalance\) \{[\s\S]*?\n {4}\}/
)?.[0];
const portfolioAllocationPresentation = portfolioAllocationFunctionSource
  ? new Function(`${portfolioAllocationFunctionSource}; return portfolioAllocationPresentation;`)()
  : null;
const runtimeGateFunctionSource = redesignSource.match(
  /function runtimeCanAcceptOrders\(status\) \{[\s\S]*?\n {4}\}/
)?.[0];
const runtimeCanAcceptOrders = runtimeGateFunctionSource
  ? new Function(`${runtimeGateFunctionSource}; return runtimeCanAcceptOrders;`)()
  : null;
const manualRuntimeGateFunctionSource = redesignSource.match(
  /function runtimeCanAcceptManualOrders\(status, mode\) \{[\s\S]*?\n {4}\}/
)?.[0];
const runtimeCanAcceptManualOrders = manualRuntimeGateFunctionSource
  ? new Function(`${manualRuntimeGateFunctionSource}; return runtimeCanAcceptManualOrders;`)()
  : null;
const canTradeFunctionSource = redesignSource.match(
  /function canTrade\(market = null\) \{[\s\S]*?\n {4}\}/
)?.[0];
const modeBannerPresentationFunctionSource = redesignSource.match(
  /function getModeBannerPresentation\(\{[\s\S]*?\n {4}\}\) \{[\s\S]*?\n {4}\}/
)?.[0];
const getModeBannerPresentation = modeBannerPresentationFunctionSource
  ? new Function(`${modeBannerPresentationFunctionSource}; return getModeBannerPresentation;`)()
  : null;
const showViewFunctionSource = redesignSource.match(
  /function showView\(view\) \{[\s\S]*?\n {4}\}/
)?.[0];
const snapshotFunctionSource = redesignSource.match(
  /async function recordCurrentPortfolioSnapshot\([\s\S]*?\n {4}\}/
)?.[0];
const strategyResearchLoaderStart = redesignSource.indexOf('    function loadStrategyResearch(');
const strategyResearchLoaderEnd = redesignSource.indexOf('\n    function renderMomentumShadow(', strategyResearchLoaderStart);
const strategyResearchLoaderFunctionSource = strategyResearchLoaderStart >= 0 && strategyResearchLoaderEnd > strategyResearchLoaderStart
  ? redesignSource.slice(strategyResearchLoaderStart, strategyResearchLoaderEnd).trim()
  : null;
const historyLoaderFunctionSource = redesignSource.match(
  /async function loadHistory\(\) \{[\s\S]*?\n {4}\}/
)?.[0];
const readinessStart = redesignSource.indexOf('    function classifyReadiness(readiness) {');
const readinessEnd = redesignSource.indexOf('\n    function symbolOf(', readinessStart);
const readinessClassificationFunctionSource = readinessStart >= 0 && readinessEnd > readinessStart
  ? redesignSource.slice(readinessStart, readinessEnd).trim()
  : null;
const classifyReadiness = readinessClassificationFunctionSource
  ? new Function(`${readinessClassificationFunctionSource}; return classifyReadiness;`)()
  : null;
const optionalPercentFunctionSource = redesignSource.match(
  /function formatOptionalPercent\(value, decimals = 2\) \{[\s\S]*?\n {4}\}/
)?.[0];
const formatOptionalPercent = optionalPercentFunctionSource
  ? new Function('formatPercent', `${optionalPercentFunctionSource}; return formatOptionalPercent;`)(
    (value, decimals = 2) => `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(decimals)}%`
  )
  : null;
const paperStatusClassificationSource = redesignSource.match(
  /const notStarted = status\?\.available === false && status\?\.reason === ['"]paper_validation_session_not_started['"];\s*const knownStatus = status\?\.available === true \|\| notStarted;/
)?.[0];
const classifyPaperStatus = paperStatusClassificationSource
  ? new Function('status', `${paperStatusClassificationSource}; return { notStarted, knownStatus };`)
  : null;
const modalFocusableFunctionSource = redesignSource.match(
  /function getModalFocusableElements\(dialog\) \{[\s\S]*?\n {4}\}/
)?.[0];
const modalFocusElementFunctionSource = redesignSource.match(
  /function focusModalElement\(element\) \{[\s\S]*?\n {4}\}/
)?.[0];
const modalKeydownFunctionSource = redesignSource.match(
  /function handleModalKeydown\(event, dialog, documentRef = document\) \{[\s\S]*?\n {4}\}/
)?.[0];
const newsFocusKeyFunctionSource = redesignSource.match(
  /function newsFocusKey\(item, index\) \{[\s\S]*?\n {4}\}/
)?.[0];
const newsFocusKey = newsFocusKeyFunctionSource
  ? new Function(`${newsFocusKeyFunctionSource}; return newsFocusKey;`)()
  : null;
const newsFocusTargetFunctionSource = redesignSource.match(
  /function findNewsFocusTarget\(newsRows, returnFocusKey, returnFocusIndex\) \{[\s\S]*?\n {4}\}/
)?.[0];
const findNewsFocusTarget = newsFocusTargetFunctionSource
  ? new Function(`${newsFocusTargetFunctionSource}; return findNewsFocusTarget;`)()
  : null;
const createModalKeydownHandler = closeModal => new Function(
  'closeModal',
  `${modalFocusableFunctionSource}; ${modalFocusElementFunctionSource}; ${modalKeydownFunctionSource}; return handleModalKeydown;`
)(closeModal);
const pwaAuthPolicyFunctionSource = redesignSource.match(
  /function pwaAuthRequestPolicy\(auth, method, path\) \{[\s\S]*?\n {4}\}/
)?.[0];
const pwaAuthRequestPolicy = pwaAuthPolicyFunctionSource
  ? new Function(
    'READ_ONLY_PWA_GET_PATHS', 'READ_ONLY_PWA_PORTFOLIO_PERIODS',
    `${pwaAuthPolicyFunctionSource}; return pwaAuthRequestPolicy;`
  )(new Set(['/status', '/account', '/cumulative-pnl', '/today-summary', '/market/prices/snapshot']), new Set(['24h', '7d', '30d']))
  : null;
const pwaMutationControlSelectorSource = redesignSource.match(
  /const PWA_MUTATION_CONTROL_SELECTOR = \[[\s\S]*?\]\.join\(','\);/
)?.[0];
const pwaMutationControlSelector = pwaMutationControlSelectorSource
  ? new Function(`${pwaMutationControlSelectorSource}; return PWA_MUTATION_CONTROL_SELECTOR;`)()
  : '';
const pwaScopeOnlyControlSelectorSource = redesignSource.match(
  /const PWA_SCOPE_ONLY_CONTROL_SELECTOR = \[[\s\S]*?\]\.join\(','\);/
)?.[0];
const pwaScopeOnlyControlSelector = pwaScopeOnlyControlSelectorSource
  ? new Function(`${pwaScopeOnlyControlSelectorSource}; return PWA_SCOPE_ONLY_CONTROL_SELECTOR;`)()
  : '';
const scopedMutationControlsFunctionSource = redesignSource.match(
  /function syncScopedMutationControls\(\) \{[\s\S]*?\n {4}\}/
)?.[0];
const createSyncScopedMutationControls = scopedMutationControlsFunctionSource
  ? (findControls, isBlocked, reason) => new Function(
    'PWA_MUTATION_CONTROL_SELECTOR', 'PWA_SCOPE_ONLY_CONTROL_SELECTOR', '$$', 'isPwaMutationBlocked', 'readOnlyObserverReason',
    `${scopedMutationControlsFunctionSource}; return syncScopedMutationControls;`
  )(
    pwaMutationControlSelector,
    pwaScopeOnlyControlSelector,
    findControls,
    isBlocked,
    reason
  )
  : null;
const requestJsonFunctionSource = redesignSource.match(
  /async function requestJSON\(path, options = \{\}\) \{[\s\S]*?\n {4}\}/
)?.[0];
const createRequestJSON = requestJsonFunctionSource
  ? new Function(
    'state', 'waitForPwaAuth', 'pwaAuthRequestPolicy', 'readOnlyObserverReason', 'window', 'fetch', 'toUserText',
    `${requestJsonFunctionSource}; return requestJSON;`
  )
  : null;

test('redesign 외부 번들도 브라우저가 실행할 수 있는 문법이다', () => {
  assert.doesNotThrow(() => new Function(redesignSource));
});

test('read_only PWA locks mutation controls and rejects denied reads or writes before fetch', async () => {
  const reason = '읽기 전용 토큰으로 접속했습니다. 주문, 설정 변경, 저장 기능은 사용할 수 없습니다.';
  const controls = Array.from({ length: 6 }, () => {
    const attributes = new Map();
    return {
      disabled: false,
      title: '',
      attributes,
      setAttribute(name, value) { attributes.set(name, value); },
      removeAttribute(name) { attributes.delete(name); }
    };
  });
  assert.ok(createSyncScopedMutationControls);
  assert.match(pwaMutationControlSelector, /data-pilot-ai-session-action/);
  assert.match(pwaMutationControlSelector, /data-pilot-ai-consult-event/);
  assert.match(pwaMutationControlSelector, /#pilot-ai-session-form input/);
  createSyncScopedMutationControls(() => controls, () => true, () => reason)();
  for (const control of controls) {
    assert.equal(control.disabled, true);
    assert.equal(control.attributes.get('aria-disabled'), 'true');
    assert.equal(control.title, reason);
  }

  const calls = [];
  const auth = { authRequired: true, tokenScope: 'read_only', authenticated: true, resolved: true, verification: 'verified' };
  const state = { online: true, auth };
  const requestJSON = createRequestJSON(
    state,
    async () => {},
    pwaAuthRequestPolicy,
    () => reason,
    { setTimeout: () => 1, clearTimeout() {} },
    async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, async json() { return { success: true }; } };
    },
    String
  );

  await assert.rejects(requestJSON('/trade/buy', { method: 'POST', body: '{}' }), error => error.code === 'pwa_auth_scope_blocked');
  await assert.rejects(requestJSON('/ai/sessions', { method: 'POST', body: '{}' }), error => error.code === 'pwa_auth_scope_blocked');
  await assert.rejects(requestJSON('/all-coin-scores?limit=60'), error => error.code === 'pwa_auth_scope_blocked');
  assert.equal(calls.length, 0, 'denied writes and read endpoints must not reach fetch');

  await requestJSON('/account');
  assert.deepEqual(calls.map(call => call.url), ['/api/account']);
});

test('read-only and native-only PWA sessions can open the supported token replacement flow', () => {
  const notice = redesignSource.split('function syncAuthScopeNotice() {')[1]?.split('\n    }')[0] || '';
  assert.match(notice, /changeTokenButton\.hidden = !\(isReadOnlyPwaScope\(\) \|\| isMobileOperatorPwaScope\(\)\)/);
  assert.match(redesignSource, /byId\('pilot-auth-change-token'\)\?\.addEventListener\('click',[\s\S]*authClient\?\.requestLogin/);
});

function createMemoryStorage(initial = null) {
  const values = new Map();
  if (initial !== null) values.set('coinpilot.pending-mutation.v1', initial);
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    values
  };
}

const testMutationKey = '00000000-0000-4000-8000-000000000001';

test('변경 요청은 전송 전에 정확한 경로·본문·UUID를 저장하고 같은 키 헤더를 보낸다', async () => {
  assert.equal(typeof createPendingMutationClient, 'function');
  const storage = createMemoryStorage();
  let sentRequest = null;
  let storedBeforeSend = null;
  const client = createPendingMutationClient({
    storage,
    createKey: () => testMutationKey,
    sendRequest: async request => {
      sentRequest = request;
      storedBeforeSend = JSON.parse(storage.getItem('coinpilot.pending-mutation.v1'));
      return { status: 200, body: { success: true, message: 'saved' }, parsed: true };
    }
  });

  const result = await client.submit('/virtual/deposit', { amount: 12000 });

  assert.equal(result.kind, 'terminal');
  assert.equal(storedBeforeSend.idempotencyKey, testMutationKey);
  assert.equal(storedBeforeSend.endpoint, '/virtual/deposit');
  assert.equal(storedBeforeSend.body, '{"amount":12000}');
  assert.deepEqual(sentRequest, {
    endpoint: '/virtual/deposit',
    idempotencyKey: testMutationKey,
    body: '{"amount":12000}'
  });
  assert.equal(storage.getItem('coinpilot.pending-mutation.v1'), null);
  const senderSource = redesignSource.match(/async function sendManualMutationRequest\([\s\S]*?\n {4}\}/)?.[0] || '';
  assert.match(senderSource, /'Idempotency-Key': idempotencyKey/);
  assert.match(senderSource, /headers\?\.get\?\.\('Idempotency-Status'\)/);
  assert.match(senderSource, /fetch\(`\/api\$\{endpoint\}`/);
});

test('타임아웃 뒤 reload와 재확인은 동일한 경로·본문·키를 재사용하고 새 변경을 막는다', async () => {
  const storage = createMemoryStorage();
  const sent = [];
  const firstClient = createPendingMutationClient({
    storage,
    createKey: () => testMutationKey,
    sendRequest: async request => {
      sent.push(request);
      throw new TypeError('network timeout');
    }
  });

  const first = await firstClient.submit('/trade/buy', { coin: 'KRW-BTC', amount: 50000 });
  assert.equal(first.kind, 'pending');
  assert.equal(firstClient.snapshot().intent.lastOutcome, 'unknown');
  const blocked = await firstClient.submit('/trade/sell', { coin: 'KRW-ETH', quantity: 0.5 });
  assert.equal(blocked.kind, 'blocked');
  assert.equal(sent.length, 1);

  const reloadedClient = createPendingMutationClient({
    storage,
    createKey: () => assert.fail('retry must not create a new key'),
    sendRequest: async request => {
      sent.push(request);
      return { status: 202, body: { success: false, pending: true }, parsed: true };
    }
  });
  const persisted = reloadedClient.snapshot().intent;
  assert.equal(persisted.endpoint, '/trade/buy');
  assert.equal(persisted.body, '{"coin":"KRW-BTC","amount":50000}');
  const retry = await reloadedClient.retry();

  assert.equal(retry.kind, 'pending');
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(reloadedClient.snapshot().intent.idempotencyKey, testMutationKey);
});

test('202, conflict, missing-key, parse failure, and server errors retain the shared mutation lock', async t => {
  const responses = [
    { status: 202, body: { success: false, pending: true }, parsed: true },
    { status: 409, body: { success: false, pending: false, error: { code: 'idempotency_key_conflict' } }, parsed: true },
    { status: 428, body: { success: false, pending: false, error: { code: 'idempotency_key_required' } }, parsed: true },
    { status: 200, body: null, parsed: false },
    { status: 503, body: { success: false, pending: true }, parsed: true }
  ];

  for (const response of responses) {
    await t.test(`HTTP ${response.status}`, async () => {
      const storage = createMemoryStorage();
      let calls = 0;
      const client = createPendingMutationClient({
        storage,
        createKey: () => testMutationKey,
        sendRequest: async () => { calls += 1; return response; }
      });
      const result = await client.submit('/virtual/reset', { seedMoney: 1000000 });
      assert.equal(result.kind, 'pending');
      assert.equal(client.snapshot().locked, true);
      assert.equal(client.snapshot().intent.idempotencyKey, testMutationKey);
      assert.equal(client.snapshot().intent.endpoint, '/virtual/reset');
      assert.equal(client.snapshot().intent.body, '{"seedMoney":1000000}');
      if (response.status === 409 || response.status === 428) {
        const retry = await client.retry();
        assert.equal(retry.kind, 'resolution-required');
        assert.equal(calls, 1);
      }
    });
  }
});

test('durable terminal errors unlock while idempotency conflicts and unresolved outcomes stay locked', async t => {
  const cases = [
    {
      name: 'completed LIVE rejection 409',
      response: {
        status: 409,
        idempotencyStatus: 'completed',
        body: { success: false, pending: false, error: { code: 'live_order_in_progress' } },
        parsed: true
      },
      resultKind: 'rejected',
      locked: false
    },
    {
      name: 'completed DRY_RUN rejection 503',
      response: {
        status: 503,
        idempotencyStatus: 'completed',
        body: { success: false, pending: false, error: { code: 'paper_transaction_rejected' } },
        parsed: true
      },
      resultKind: 'rejected',
      locked: false
    },
    {
      name: '409 idempotency key conflict',
      response: {
        status: 409,
        idempotencyStatus: 'conflict',
        body: { success: false, pending: false, error: { code: 'idempotency_key_conflict' } },
        parsed: true
      },
      resultKind: 'pending',
      lastOutcome: 'conflict',
      locked: true
    },
    {
      name: '409 idempotency key conflict while the original key is pending',
      response: {
        status: 409,
        idempotencyStatus: 'conflict',
        body: { success: false, pending: true, idempotency: { status: 'pending' }, error: { code: 'idempotency_key_conflict' } },
        parsed: true
      },
      resultKind: 'pending',
      lastOutcome: 'conflict',
      locked: true
    },
    {
      name: '428 missing key',
      response: {
        status: 428,
        idempotencyStatus: 'rejected',
        body: { success: false, pending: false, error: { code: 'idempotency_key_required' } },
        parsed: true
      },
      resultKind: 'pending',
      lastOutcome: 'key_missing',
      locked: true
    },
    {
      name: '503 outcome unknown',
      response: {
        status: 503,
        idempotencyStatus: 'unknown',
        body: { success: false, pending: true, error: { code: 'idempotency_outcome_unknown' } },
        parsed: true
      },
      resultKind: 'pending',
      lastOutcome: 'unknown',
      locked: true
    },
    {
      name: '503 without idempotency status from a proxy',
      response: {
        status: 503,
        body: { success: false, error: { code: 'upstream_unavailable' } },
        parsed: true
      },
      resultKind: 'pending',
      lastOutcome: 'unknown',
      locked: true
    }
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const storage = createMemoryStorage();
      let calls = 0;
      const client = createPendingMutationClient({
        storage,
        createKey: () => testMutationKey,
        sendRequest: async () => { calls += 1; return item.response; }
      });

      const result = await client.submit('/trade/buy', { coin: 'KRW-BTC', amount: 10000 });
      const snapshot = client.snapshot();
      assert.equal(result.kind, item.resultKind);
      assert.equal(snapshot.locked, item.locked);
      if (item.locked) {
        assert.equal(snapshot.intent.lastOutcome, item.lastOutcome);
        assert.equal(snapshot.intent.idempotencyKey, testMutationKey);
        if (['conflict', 'key_missing'].includes(item.lastOutcome)) {
          const retry = await client.retry();
          assert.equal(retry.kind, 'resolution-required');
          assert.equal(calls, 1);
        }
      } else {
        assert.equal(snapshot.intent, null);
        assert.equal(storage.getItem('coinpilot.pending-mutation.v1'), null);
      }
    });
  }
});

test('conflict and missing-key banners require resolution and do not show ordinary retry', () => {
  const render = redesignSource.match(/function renderPendingMutationBanner\([\s\S]*?\n {4}\}/)?.[0] || '';
  assert.match(render, /operatorResolutionRequired = \['conflict', 'key_missing'\]/);
  assert.match(render, /retryButton\.hidden = !intent \|\| operatorResolutionRequired/);
  assert.match(render, /운영자 확인이 필요합니다/);
  assert.match(render, /서버 설정을 확인할 때까지 새 주문과 지갑 변경을 잠갔습니다/);
});

test('완료된 2xx와 결정적인 4xx 결과는 pending이 아니면 잠금을 해제한다', async t => {
  for (const status of [200, 201, 400, 422]) {
    await t.test(`HTTP ${status}`, async () => {
      const storage = createMemoryStorage();
      const client = createPendingMutationClient({
        storage,
        createKey: () => testMutationKey,
        sendRequest: async () => ({ status, body: { success: status < 400, pending: false }, parsed: true })
      });
      const result = await client.submit('/trade/smart-sell', { targetAmount: 25000, strategy: 'worst' });
      assert.equal(result.kind, status < 400 ? 'terminal' : 'rejected');
      assert.equal(client.snapshot().locked, false);
      assert.equal(storage.getItem('coinpilot.pending-mutation.v1'), null);
    });
  }
});

test('저장소 쓰기 실패 시에는 같은 오퍼레이션도 네트워크로 보내지 않는다', async () => {
  const storage = createMemoryStorage();
  storage.setItem = () => { throw new Error('quota'); };
  let sent = 0;
  const client = createPendingMutationClient({
    storage,
    createKey: () => testMutationKey,
    sendRequest: async () => { sent += 1; return { status: 200, body: { success: true }, parsed: true }; }
  });

  const result = await client.submit('/trade/execute', { coin: 'KRW-BTC', action: 'BUY', amount: 50000 });

  assert.equal(result.kind, 'storage-error');
  assert.equal(sent, 0);
  assert.equal(client.snapshot().locked, true);
});

test('레거시 주문·지갑 호출과 PWA 주문·지갑 호출은 공통 pending mutation client를 사용한다', () => {
  for (const endpoint of pendingMutationEndpoints) {
    assert.ok(indexSource.includes(`submitProtectedMutation('${endpoint}'`), `legacy caller missing ${endpoint}`);
  }
  assert.match(indexSource, /submitProtectedMutation\('\/virtual\/deposit'/);
  assert.match(indexSource, /submitProtectedMutation\('\/virtual\/withdraw'/);
  assert.match(indexSource, /submitProtectedMutation\('\/virtual\/reset'/);
  assert.match(redesignSource, /manualMutationClient\.submit\(path, body\)/);
  assert.match(redesignSource, /manualMutationClient\.submit\(buy \? '\/trade\/smart-buy' : '\/trade\/smart-sell', body\)/);
  assert.match(redesignSource, /manualMutationClient\.submit\(`\/virtual\/\$\{kind\}`, \{ amount: Math\.floor\(amount\) \}\)/);
  assert.match(redesignSource, /manualMutationClient\.submit\('\/virtual\/reset'/);
  assert.doesNotMatch(indexSource, /fetch\(['"]\/api\/trade\/(?:execute-bundle|execute|buy|sell|smart-buy|smart-sell)/);
});

test('스마트 주문 힌트는 완전한 현재 계좌 자료로 현금 잔액과 전체 보유 평가액을 표시한다', () => {
  assert.equal(typeof manualOrderCapacityPresentation, 'function');
  const presentation = manualOrderCapacityPresentation({
    account: { krwBalance: 1_000_000 },
    holdings: [
      { coin: 'KRW-BTC', currentValue: 250_000 },
      { coin: 'KRW-ETH', currentValue: '500000' }
    ],
    holdingsKnown: true,
    coreReady: true
  });

  assert.equal(presentation.balanceLabel, '사용 가능 잔액 1,000,000원');
  assert.equal(presentation.holdingLabel, '보유 평가액 750,000원');
  assert.equal(presentation.holdingValue, 750_000);
  assert.doesNotMatch(presentation.balanceLabel + presentation.holdingLabel, /%/);
  const renderer = redesignSource.match(/function renderManualOrderCapacity\(\) \{[\s\S]*?\n {4}\}/)?.[0] || '';
  const renderAll = redesignSource.match(/function renderAll\(\) \{[\s\S]*?\n {4}\}/)?.[0] || '';
  assert.match(renderer, /state\.account/);
  assert.match(renderer, /positions\(\)/);
  assert.match(renderer, /pilot-smart-buy-balance/);
  assert.match(renderer, /pilot-smart-sell-holding/);
  assert.match(renderAll, /renderManualOrderCapacity\(\)/);
});

test('빈 목록만 완전히 확인된 경우 보유 평가액 0원을 표시하고 미확인 자료로 0을 만들지 않는다', () => {
  const knownEmpty = manualOrderCapacityPresentation({
    account: { krwBalance: 0 },
    holdings: [],
    holdingsKnown: true,
    coreReady: true
  });
  assert.equal(knownEmpty.balanceLabel, '사용 가능 잔액 0원');
  assert.equal(knownEmpty.holdingLabel, '보유 평가액 0원');

  const unknownAccount = manualOrderCapacityPresentation({
    account: { krwBalance: null },
    holdings: [],
    holdingsKnown: false,
    coreReady: false
  });
  assert.equal(unknownAccount.balanceLabel, '사용 가능 잔액 확인 불가');
  assert.equal(unknownAccount.holdingLabel, '보유 평가액 확인 불가');
  assert.equal(unknownAccount.holdingValue, null);
});

test('스마트 매도 보유 평가액은 한 종목이라도 값이 빠지거나 현재 snapshot이 불완전하면 미확인으로 표시한다', () => {
  const partialHolding = manualOrderCapacityPresentation({
    account: { krwBalance: 10_000 },
    holdings: [
      { coin: 'KRW-BTC', currentValue: 250_000 },
      { coin: 'KRW-ETH', currentValue: null }
    ],
    holdingsKnown: true,
    coreReady: true
  });
  assert.equal(partialHolding.balanceLabel, '사용 가능 잔액 10,000원');
  assert.equal(partialHolding.holdingLabel, '보유 평가액 확인 불가');
  assert.equal(partialHolding.holdingValue, null);

  const staleSnapshot = manualOrderCapacityPresentation({
    account: { krwBalance: 10_000 },
    holdings: [{ coin: 'KRW-BTC', currentValue: 250_000 }],
    holdingsKnown: true,
    coreReady: false
  });
  assert.equal(staleSnapshot.balanceLabel, '사용 가능 잔액 확인 불가');
  assert.equal(staleSnapshot.holdingLabel, '보유 평가액 확인 불가');
});

test('후보 비교 버튼은 줄바꿈 없이 유지되며 좁은 설정 카드 안에서 텍스트 영역이 줄어든다', () => {
  const settingsRenderer = redesignSource.split('function renderSettings() {')[1]?.split('function renderHistoryTables()')[0] || '';
  assert.match(settingsRenderer, /pilot-control-row pilot-optimization-run-row/);
  assert.match(redesignStyleSource, /\.pilot-optimization-run-row > \.pilot-button\s*\{[^}]*min-width:\s*80px;[^}]*white-space:\s*nowrap;/);
  assert.match(redesignStyleSource, /\.pilot-optimization-run-row \.pilot-control-copy\s*\{[^}]*min-width:\s*0;[^}]*flex:\s*1 1 auto;/);
  assert.match(redesignStyleSource, /@media \(max-width: 480px\)\s*\{[\s\S]*?\.pilot-optimization-run-row > \.pilot-button\s*\{[^}]*min-height:\s*36px;/);
});

test('시장 차트 표시 구간은 마지막 유효 캔들만 새 배열로 돌려주고 입력을 바꾸지 않는다', () => {
  assert.equal(typeof getDisplayedCandles, 'function');
  const makeCandle = index => ({
    time: `2026-09-29T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
    open: index + 100,
    high: index + 102,
    low: index + 99,
    close: index + 101
  });
  const candles = Array.from({ length: 100 }, (_, index) => makeCandle(index));
  const original = structuredClone(candles);

  for (const range of [30, 60, 100]) {
    const displayed = getDisplayedCandles(candles, range);
    assert.equal(displayed.length, range);
    assert.notEqual(displayed, candles);
    assert.deepEqual(displayed, candles.slice(-range));
  }
  assert.deepEqual(candles, original);

  const shortCandles = candles.slice(0, 8);
  const shortDisplay = getDisplayedCandles(shortCandles, 30);
  assert.equal(shortDisplay.length, 8);
  assert.notEqual(shortDisplay, shortCandles);
  assert.deepEqual(shortDisplay, shortCandles);
  assert.deepEqual(getDisplayedCandles(null, 30), []);

  const validCandles = Array.from({ length: 40 }, (_, index) => makeCandle(index));
  const withInvalidRows = [
    ...validCandles,
    null,
    { ...makeCandle(41), close: Number.NaN },
    { ...makeCandle(42), high: 1 },
    { ...makeCandle(43), low: 0 }
  ];
  const invalidRowsOriginal = structuredClone(withInvalidRows);
  assert.deepEqual(getDisplayedCandles(withInvalidRows, 30), validCandles.slice(-30));
  assert.deepEqual(withInvalidRows, invalidRowsOriginal);
});

test('시장 차트 표시 구간 버튼은 접근 가능하고 캔들 데이터를 다시 요청하지 않는다', () => {
  const marketPage = redesignSource.split('data-pilot-page="market"')[1]?.split('data-pilot-page="analysis"')[0] || '';
  assert.match(marketPage, /role="group" aria-label="캔들 간격"/);
  assert.match(marketPage, /role="group" aria-label="표시 캔들 수"/);
  for (const range of [30, 60, 100]) {
    assert.match(marketPage, new RegExp(`data-pilot-candle-range="${range}"`));
  }
  assert.match(marketPage, /data-pilot-candle-range="60" aria-pressed="true"/);

  const chartRenderer = redesignSource.split('function drawMarketChart() {')[1]?.split('function renderMarketHeader()')[0] || '';
  assert.match(chartRenderer, /getDisplayedCandles\(state\.candles, state\.candleDisplayRange\)/);
  assert.match(chartRenderer, /candles\.map\(item => number\(item\.high\)\)/);
  assert.match(chartRenderer, /candles\[0\]\?\.time/);
  assert.match(chartRenderer, /candles\[candles\.length - 1\]\?\.time/);

  const rangeHandler = redesignSource.split("const rangeButton = event.target.closest('[data-pilot-candle-range]');")[1]?.split('const marketRow')[0] || '';
  assert.match(rangeHandler, /state\.candleDisplayRange = range/);
  assert.match(rangeHandler, /renderCandleControls\(\)/);
  assert.match(rangeHandler, /drawMarketChart\(\)/);
  assert.doesNotMatch(rangeHandler, /renderMarketHeader\(/);
  assert.doesNotMatch(rangeHandler, /loadCandles\(|requestJSON\(/);
  assert.match(candleLoaderFunctionSource, /market\/candles\/\$\{encodeURIComponent\(coin\)\}\?unit=\$\{interval\}&count=100/);
  assert.match(redesignStyleSource, /\.pilot-market-range:focus-visible/);
});

test('포지션이 없을 때만 표의 최소 너비를 해제하고 빈 상태 행을 컨테이너에 맞춘다', () => {
  assert.ok(positionRowsFunctionSource);
  const renderPositionTable = (rows, known, initiallyEmpty = false) => {
    const classes = new Set(['pilot-table']);
    if (initiallyEmpty) classes.add('is-position-empty');
    const table = {
      classList: {
        toggle(name, force) {
          if (force) classes.add(name);
          else classes.delete(name);
          return classes.has(name);
        }
      }
    };
    const target = {
      html: '',
      closest(selector) {
        assert.equal(selector, 'table');
        return table;
      },
      set innerHTML(value) { this.html = value; },
      get innerHTML() { return this.html; }
    };
    const render = new Function(
      'byId', 'positions', 'positionDataKnown', 'isReadOnlyObserver', 'escapeHtml', 'symbolOf',
      'formatQuantity', 'hasFiniteValue', 'formatPrice', 'formatOptionalPercent', 'formatWon',
      'formatSignedWon', 'classForValue',
      `${positionRowsFunctionSource}; return renderPositionRows;`
    )(
      () => target,
      () => rows,
      () => known,
      () => false,
      value => String(value),
      value => String(value).split('-').at(-1),
      value => String(value),
      value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)),
      value => String(value),
      value => `${value}%`,
      value => `${value}원`,
      value => `${value}원`,
      value => Number(value) > 0 ? 'is-positive' : 'is-negative'
    );
    render('pilot-portfolio-positions');
    return { classes, html: target.innerHTML };
  };

  const empty = renderPositionTable([], true);
  assert.ok(empty.classes.has('is-position-empty'));
  assert.match(empty.html, /<td colspan="7">/);
  assert.match(empty.html, /현재 보유 포지션이 없습니다\./);

  const populated = renderPositionTable([{
    coin: 'KRW-BTC',
    amount: 1,
    avgPrice: 100,
    currentPrice: 110,
    currentValue: 110,
    profit: 10,
    profitPercent: 10
  }], true, true);
  assert.ok(!populated.classes.has('is-position-empty'));
  assert.match(populated.html, /BTC/);
  assert.match(redesignStyleSource, /\.pilot-table-wrap\s*\{\s*overflow-x:\s*auto;/);
  assert.match(redesignStyleSource, /\.pilot-table\s*\{[^}]*min-width:\s*660px;/s);
  assert.match(redesignStyleSource, /\.pilot-table\.is-position-empty\s*\{\s*min-width:\s*0;/);
});

test('시장 차트는 가장 긴 가격 축 라벨 폭을 확보하고 마지막 시간 라벨과 높이를 유지한다', () => {
  assert.ok(marketChartFunctionSource);
  const width = 602;
  const textWidth = text => String(text).length * 9;
  const textCalls = [];
  const gridLineEnds = [];
  const candleRects = [];
  let currentMove = null;
  const context = {
    measureText: text => ({ width: textWidth(text) }),
    beginPath() {},
    moveTo(x, y) { currentMove = { x, y }; },
    lineTo(x, _y) {
      if (currentMove?.x === 16 && x !== 16) gridLineEnds.push(x);
    },
    stroke() {},
    fillText(text, x, y) { textCalls.push({ text, x, y }); },
    fillRect(x, y, rectWidth, height) { candleRects.push({ x, y, width: rectWidth, height }); }
  };
  const candles = [
    { open: 1_200_000, close: 1_210_000, high: 1_234_567, low: 1_190_000, volume: 1.25, time: '09:30' },
    { open: 1_210_000, close: 1_220_000, high: 1_230_000, low: 1_200_000, volume: 2.5, time: '09:35' }
  ];
  const canvas = { clientWidth: width, parentElement: { clientHeight: 398 } };
  const empty = { hidden: false, textContent: '' };
  const candleDataDetails = { hidden: true };
  const candleDataNote = { textContent: '' };
  let candleTableWrites = 0;
  const candleDataTable = {
    value: '',
    get innerHTML() { return this.value; },
    set innerHTML(value) { candleTableWrites += 1; this.value = value; }
  };
  const candleDataStatus = {
    hidden: true,
    textContent: '',
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, value); },
    removeAttribute(name) { this.attributes.delete(name); }
  };
  const state = { candles, candleDisplayRange: 60, candlesError: false, candlesLoading: false };
  const drawCalls = [];
  const drawMarketChart = new Function(
    'byId', 'getDisplayedCandles', 'state', 'window', 'drawCanvas', 'formatPrice', 'formatTime', 'number',
    'formatDateTime', 'formatQuantity', 'escapeHtml',
    `${marketChartFunctionSource}; return drawMarketChart;`
  )(
    id => ({
      'pilot-market-chart': canvas,
      'pilot-market-empty': empty,
      'pilot-market-candle-data': candleDataDetails,
      'pilot-market-candle-data-note': candleDataNote,
      'pilot-market-data-table': candleDataTable,
      'pilot-market-candle-status': candleDataStatus
    })[id] || null,
    values => values,
    state,
    { getComputedStyle: () => ({ getPropertyValue: () => '300px' }) },
    (_canvas, height, draw) => {
      drawCalls.push(height);
      draw(context, width, height);
    },
    value => `₩${Math.round(value).toLocaleString('en-US')}`,
    value => value,
    value => Number(value) || 0,
    value => `time:${value}`,
    value => `volume:${value}`,
    value => String(value)
  );
  drawMarketChart();

  const priceLabels = textCalls.filter(call => call.text.startsWith('₩'));
  const lastTimeLabel = textCalls.find(call => call.text === '09:35');
  assert.equal(priceLabels.length, 5);
  assert.equal(gridLineEnds.length, 5);
  assert.equal(drawCalls[0], 300);
  assert.equal(empty.hidden, true);
  const plotRight = gridLineEnds[0];
  const widestTickWidth = Math.max(...priceLabels.map(call => textWidth(call.text)));
  const expectedRightGutter = Math.max(54, Math.ceil(widestTickWidth + 7 + 4));
  assert.equal(width - plotRight, expectedRightGutter);
  for (const call of priceLabels) {
    assert.equal(call.x, plotRight + 7);
    assert.ok(call.x + textWidth(call.text) <= width);
  }
  assert.ok(lastTimeLabel);
  assert.ok(lastTimeLabel.x >= 16);
  assert.ok(lastTimeLabel.x + textWidth(lastTimeLabel.text) <= plotRight);
  assert.ok(candleRects.length > 0);
  assert.equal(candleDataDetails.hidden, false);
  assert.match(candleDataNote.textContent, /화면에 표시한 2개 중 최신 2개/);
  assert.match(candleDataTable.innerHTML, /<caption class="pilot-visually-hidden">선택 종목 최신 캔들 OHLCV 기록<\/caption>/);
  assert.match(candleDataTable.innerHTML, /시가/);
  assert.match(candleDataTable.innerHTML, /time:09:35/);
  assert.match(candleDataTable.innerHTML, /volume:1\.25/);
  assert.equal(candleTableWrites, 1);
  for (const candle of candleRects) {
    assert.ok(candle.x >= 16);
    assert.ok(candle.x + candle.width <= plotRight);
  }

  const lastKnownTableMarkup = candleDataTable.innerHTML;
  state.candlesLoading = true;
  drawMarketChart();
  assert.equal(candleDataStatus.hidden, false);
  assert.match(candleDataStatus.textContent, /마지막 정상 자료를 표시합니다/);
  assert.equal(candleDataStatus.attributes.has('aria-live'), false);
  assert.equal(candleDataTable.innerHTML, lastKnownTableMarkup);
  assert.equal(candleTableWrites, 1);

  state.candlesLoading = false;
  state.candlesError = true;
  drawMarketChart();
  assert.equal(candleDataStatus.hidden, false);
  assert.match(candleDataStatus.textContent, /최신 캔들을 불러오지 못했습니다/);
  assert.equal(candleDataStatus.attributes.get('role'), 'status');
  assert.equal(candleDataStatus.attributes.get('aria-live'), 'polite');
  assert.match(candleDataNote.textContent, /마지막 정상 조회 자료/);
  assert.equal(candleDataTable.innerHTML, lastKnownTableMarkup);
  assert.equal(candleTableWrites, 1);
});

test('market selection rows expose the pressed state to assistive technology', () => {
  const marketList = redesignSource.split('function renderMarketList() {')[1]?.split('function renderPortfolio() {')[0];
  assert.ok(marketList);
  assert.match(marketList, /role="button" tabindex="0" aria-pressed="\$\{item\.coin === state\.selectedCoin \? 'true' : 'false'\}"/);
  assert.match(marketList, /class="pilot-market-row \$\{item\.coin === state\.selectedCoin \? 'is-selected' : ''\}"/);
});

test('오래된 캔들 응답은 최신 시장 요청의 데이터와 로딩 상태를 바꾸지 않는다', async () => {
  assert.ok(candleLoaderFunctionSource);
  const state = {
    selectedCoin: 'KRW-BTC',
    candleInterval: 5,
    candles: [],
    candlesError: false,
    candlesLoading: false,
    candlesRequestSequence: 0
  };
  const requests = new Map();
  const toasts = [];
  const loader = new Function(
    'state', 'requestJSON', 'renderMarketHeader', 'drawMarketChart', 'showToast',
    `${candleLoaderFunctionSource}; return loadCandles;`
  )(
    state,
    url => new Promise((resolve, reject) => requests.set(url, { resolve, reject })),
    () => {},
    () => {},
    message => toasts.push(message)
  );

  const oldRequest = loader(false);
  state.selectedCoin = 'KRW-ETH';
  state.candleInterval = 15;
  const latestRequest = loader(false);
  const oldUrl = '/market/candles/KRW-BTC?unit=5&count=100';
  const latestUrl = '/market/candles/KRW-ETH?unit=15&count=100';
  assert.ok(requests.has(oldUrl));
  assert.ok(requests.has(latestUrl));
  assert.equal(state.candlesLoading, true);

  const oldCandles = [{ market: 'KRW-BTC', close: 60_000_000 }];
  requests.get(oldUrl).resolve(oldCandles);
  await oldRequest;
  assert.deepEqual(state.candles, []);
  assert.equal(state.candlesCoin, 'KRW-ETH');
  assert.equal(state.candlesInterval, 15);
  assert.equal(state.candlesLoading, true);
  assert.equal(state.candlesError, false);
  assert.deepEqual(toasts, []);

  const latestCandles = [{ market: 'KRW-ETH', close: 4_000_000 }];
  requests.get(latestUrl).resolve(latestCandles);
  await latestRequest;
  assert.deepEqual(state.candles, latestCandles);
  assert.equal(state.candlesCoin, 'KRW-ETH');
  assert.equal(state.candlesInterval, 15);
  assert.equal(state.candlesLoading, false);
  assert.equal(state.candlesError, false);
  assert.deepEqual(toasts, []);
});

test('오래된 캔들 요청 실패는 최신 요청의 오류 상태나 알림에 영향을 주지 않는다', async () => {
  const state = {
    selectedCoin: 'KRW-BTC',
    candleInterval: 5,
    candles: [],
    candlesError: false,
    candlesLoading: false,
    candlesRequestSequence: 0
  };
  const requests = new Map();
  const toasts = [];
  const loader = new Function(
    'state', 'requestJSON', 'renderMarketHeader', 'drawMarketChart', 'showToast',
    `${candleLoaderFunctionSource}; return loadCandles;`
  )(
    state,
    url => new Promise((resolve, reject) => requests.set(url, { resolve, reject })),
    () => {},
    () => {},
    message => toasts.push(message)
  );

  const oldRequest = loader(false);
  state.selectedCoin = 'KRW-ETH';
  const latestRequest = loader(false);
  requests.get('/market/candles/KRW-BTC?unit=5&count=100').reject(new Error('stale failure'));
  await oldRequest;
  assert.equal(state.candlesLoading, true);
  assert.equal(state.candlesError, false);
  assert.deepEqual(toasts, []);

  const latestCandles = [{ market: 'KRW-ETH', close: 4_000_000 }];
  requests.get('/market/candles/KRW-ETH?unit=5&count=100').resolve(latestCandles);
  await latestRequest;
  assert.deepEqual(state.candles, latestCandles);
  assert.equal(state.candlesLoading, false);
  assert.equal(state.candlesError, false);
  assert.deepEqual(toasts, []);
});

test('같은 시장의 강제 갱신 실패는 마지막 정상 캔들을 유지하고 오류를 표시한다', async () => {
  const lastKnownCandles = [{ market: 'KRW-BTC', close: 60_000_000, time: '09:30' }];
  const state = {
    selectedCoin: 'KRW-BTC',
    candleInterval: 5,
    candles: lastKnownCandles,
    candlesCoin: 'KRW-BTC',
    candlesInterval: 5,
    candlesError: false,
    candlesLoading: false,
    candlesRequestSequence: 0
  };
  let request;
  const toasts = [];
  const loader = new Function(
    'state', 'requestJSON', 'renderMarketHeader', 'drawMarketChart', 'showToast',
    `${candleLoaderFunctionSource}; return loadCandles;`
  )(
    state,
    url => {
      request = { url };
      return new Promise((_resolve, reject) => { request.reject = reject; });
    },
    () => {},
    () => {},
    message => toasts.push(message)
  );

  const refresh = loader(true);
  assert.deepEqual(state.candles, lastKnownCandles);
  assert.equal(state.candlesLoading, true);
  assert.equal(request.url, '/market/candles/KRW-BTC?unit=5&count=100');
  request.reject(new Error('temporary network failure'));
  await refresh;

  assert.deepEqual(state.candles, lastKnownCandles);
  assert.equal(state.candlesError, true);
  assert.equal(state.candlesLoading, false);
  assert.deepEqual(toasts, []);
});

test('redesign은 백그라운드 탭이 다시 보일 때 paper 상태를 즉시 갱신한다', () => {
  assert.match(redesignSource, /document\.addEventListener\(['"]visibilitychange['"]/);
  assert.match(redesignSource, /if \(!document\.hidden\)\s*loadCore\(\{ quiet: true \}\)/);
  assert.match(redesignSource, /const CORE_REFRESH_INTERVAL_MS = 30_000/);
  assert.match(redesignSource, /window\.setInterval\(\(\) => \{ if \(!document\.hidden\) loadCore\(\{ quiet: true \}\); \}, CORE_REFRESH_INTERVAL_MS\)/);
});

test('PWA shell은 redesign asset version과 service worker cache version을 함께 갱신한다', () => {
  assert.match(redesignScriptAsset || '', /^\/pilot-redesign\.js\?v=\d{8}-\d+$/);
  assert.match(redesignStylesheetAsset || '', /^\/pilot-redesign\.css\?v=\d{8}-\d+$/);
  assert.match(serviceWorkerCacheName || '', /^coinpilot-shell-v\d+$/);
  assert.equal(serviceWorkerCacheName, 'coinpilot-shell-v205');
  assert.ok(serviceWorkerAppShell);
  assert.match(serviceWorkerAppShell, new RegExp(`['"]${redesignScriptAsset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`));
  assert.match(serviceWorkerAppShell, new RegExp(`['"]${redesignStylesheetAsset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`));
  assert.match(serviceWorkerSource, new RegExp(`['"]${redesignScriptAsset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`));
  assert.match(serviceWorkerSource, new RegExp(`['"]${redesignStylesheetAsset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`));
  assert.match(serviceWorkerSource, /NETWORK_FIRST_SHELL_PATHS/);
  assert.match(serviceWorkerSource, /fetch\(request\)[\s\S]*ignoreSearch: true/);
});

test('빈 자산 그래프는 간결한 시작 안내와 읽기 전용을 막는 기록 동작을 제공한다', () => {
  const chart = redesignSource.split('function drawEquityChart(')[1]?.split('function drawAllocationChart(')[0] || '';
  const trendHelperSource = redesignSource.split('function hasUsableHistoryTrend(')[1]?.split('function formatMarketTimestamp(')[0] || '';
  const hasUsableHistoryTrend = trendHelperSource
    ? new Function(`return function hasUsableHistoryTrend(${trendHelperSource};`)()
    : null;
  const recordSnapshot = redesignSource.split('async function recordCurrentPortfolioSnapshot(')[1]?.split('async function executeTrade(')[0] || '';
  assert.equal(typeof hasUsableHistoryTrend, 'function');
  assert.equal(hasUsableHistoryTrend([]), false);
  assert.equal(hasUsableHistoryTrend([{ totalAssets: 1_000_000, timestamp: '2026-09-30T00:00:00.000Z' }]), false);
  assert.equal(hasUsableHistoryTrend([
    { totalAssets: 1_000_000, timestamp: '2026-09-30T00:00:00.000Z' },
    { totalAssets: 1_001_000, timestamp: '2026-09-30T00:01:00.000Z' }
  ]), true);
  assert.match(chart, /const hasTrend = hasUsableHistoryTrend\(points\)/);
  assert.match(chart, /저장된 평가 기록 1건/);
  assert.match(chart, /state\.coreReady === true/);
  assert.match(chart, /자산 흐름을 기록해 보세요/);
  assert.match(chart, /data-pilot-action="record-snapshot"/);
  assert.match(chart, /!isReadOnlyObserver\(\)/);
  assert.match(redesignStyleSource, /\.pilot-chart-wrap\.is-empty/);
  assert.match(recordSnapshot, /requestJSON\('\/portfolio\/snapshot', \{ method: 'POST' \}\)/);
  assert.match(recordSnapshot, /result\?\.recorded !== true/);
  assert.match(recordSnapshot, /isPwaMutationBlocked\(\) \|\| state\.online === false/);
});

test('successful manual and conditional orders record one portfolio snapshot before refreshing history', () => {
  const executeTrade = redesignSource.split('async function executeTrade(prefix) {')[1]?.split('async function executeSmart(kind)')[0] || '';
  const executeSmart = redesignSource.split('async function executeSmart(kind) {')[1]?.split('async function walletAction(kind)')[0] || '';
  assert.match(executeTrade, /recordCurrentPortfolioSnapshot\(\{ quiet: true, refresh: false \}\)/);
  assert.match(executeSmart, /recordCurrentPortfolioSnapshot\(\{ quiet: true, refresh: false \}\)/);
  assert.match(executeTrade, /거래는 완료됐지만 자산 추이를 기록하지 못했습니다/);
  assert.match(executeSmart, /조건 주문은 완료됐지만 자산 추이를 기록하지 못했습니다/);
});

test('service worker does not replace failed third-party requests with the local HTML shell', () => {
  const handlers = {};
  vm.runInNewContext(serviceWorkerSource, {
    URL,
    self: {
      location: { origin: 'https://coinpilot.example' },
      addEventListener(name, handler) { handlers[name] = handler; }
    }
  });

  let intercepted = false;
  handlers.fetch({
    request: {
      method: 'GET',
      url: 'https://cdn.jsdelivr.net/npm/@phosphor-icons/web@2.1.1/src/regular/style.css'
    },
    respondWith() { intercepted = true; }
  });

  assert.equal(intercepted, false);
});

test('service worker waits for the user update action before activating a replacement worker', async () => {
  const handlers = {};
  let skipWaitingCalls = 0;
  vm.runInNewContext(serviceWorkerSource, {
    caches: {
      open: async () => ({ addAll: async () => {} })
    },
    self: {
      location: { origin: 'https://coinpilot.example' },
      addEventListener(name, handler) { handlers[name] = handler; },
      skipWaiting() {
        skipWaitingCalls += 1;
        return Promise.resolve();
      }
    }
  });

  let installWork;
  handlers.install({ waitUntil(promise) { installWork = promise; } });
  await installWork;
  assert.equal(skipWaitingCalls, 0, 'a new worker remains waiting after its shell is cached');

  handlers.message({ data: { type: 'SKIP_WAITING' } });
  assert.equal(skipWaitingCalls, 1, 'the explicit update action activates the waiting worker');
});

test('PWA manifest icon과 service worker app shell의 모든 정적 자산이 실제로 존재한다', () => {
  const manifest = JSON.parse(manifestSource);
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.start_url, '/?source=pwa');
  assert.equal(manifest.id, '/?source=pwa');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 3);
  assert.ok(manifest.icons.every(icon => icon.type === 'image/png'));

  const svgIconSource = fs.readFileSync(path.join(projectRoot, 'public/icon.svg'), 'utf8');
  assert.match(svgIconSource, /<svg[^>]*width="512"[^>]*height="512"[^>]*viewBox="0 0 512 512"/);

  for (const icon of manifest.icons) {
    assert.match(icon.src, /^\//);
    const file = path.join(projectRoot, 'public', icon.src.slice(1));
    assert.equal(fs.existsSync(file), true, `manifest icon missing: ${icon.src}`);
    assert.ok(fs.statSync(file).size > 0, `manifest icon empty: ${icon.src}`);
  }

  const shellAssets = [
    '/',
    '/index.html',
    '/manifest.webmanifest',
    '/icon.svg',
    '/icon-192.png',
    '/icon-512.png',
    '/apple-touch-icon.png',
    '/auth-client.js',
    redesignStylesheetAsset,
    redesignScriptAsset
  ];
  for (const asset of shellAssets) {
    assert.match(
      serviceWorkerSource,
      new RegExp(`['"]${asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`),
      `service worker app shell missing: ${asset}`
    );
  }
});

test('redesign uses Toss foundation color values and local system fonts', () => {
  assert.match(redesignStyleSource, /--tds-color-grey-900:\s*#191f28/i);
  assert.match(redesignStyleSource, /--tds-color-grey-600:\s*#6b7684/i);
  assert.match(redesignStyleSource, /--tds-color-blue-700:\s*#1b64da/i);
  assert.match(redesignStyleSource, /--tds-color-grey-50:\s*#f9fafb/i);
  assert.match(redesignStyleSource, /--sl-ink:\s*var\(--tds-color-grey-900\)/i);
  assert.match(redesignStyleSource, /--sl-type-page-title:\s*28px/i);
  assert.match(redesignStyleSource, /\.pilot-page-title[\s\S]*font-size:\s*clamp\(22px, 2\.1vw, var\(--sl-type-page-title\)\)/);
  assert.match(redesignStyleSource, /--sl-font-body:\s*-apple-system/);
  const topbarStyle = redesignStyleSource.split('.pilot-topbar {')[1]?.split('}')[0] || '';
  assert.match(topbarStyle, /background:\s*var\(--sl-paper\)/);
  assert.doesNotMatch(topbarStyle, /backdrop-filter/);
  const modeSwitchStyle = redesignStyleSource.split('.pilot-mode-switch {')[1]?.split('}')[0] || '';
  assert.match(modeSwitchStyle, /background:\s*var\(--sl-surface-2\)/);
  assert.match(designQaSource, /Active reference: Toss Design System/);
  assert.match(designQaSource, /Historical comparison target — Signal Ledger/);
  assert.match(designQaSource, /does not load the React TDS component package/);
  assert.doesNotMatch(indexSource, /fonts\.(?:googleapis|gstatic)\.com/i);
  assert.doesNotMatch(redesignSource, /Manrope|IBM Plex Sans KR/i);
  assert.match(indexSource, /<script\s+src=["']\/socket\.io\/socket\.io\.js["']/i);
  assert.doesNotMatch(indexSource, /cdn\.socket\.io/i);
});

test('core trading readiness requires a matching live mode, finite account balance, and selected-market price', () => {
  assert.equal(typeof isCoreTradingSnapshotReady, 'function');
  const readySnapshot = {
    status: { mode: 'DRY_RUN' },
    account: { mode: 'DRY_RUN', krwBalance: 10_000 },
    marketPrices: [{ coin: 'KRW-BTC', price: 100 }],
    selectedCoin: 'KRW-BTC'
  };

  assert.equal(isCoreTradingSnapshotReady(readySnapshot), true);
  assert.equal(isCoreTradingSnapshotReady({ ...readySnapshot, status: null }), false);
  assert.equal(isCoreTradingSnapshotReady({ ...readySnapshot, account: null }), false);
  assert.equal(isCoreTradingSnapshotReady({ ...readySnapshot, marketPrices: null }), false);
  assert.equal(isCoreTradingSnapshotReady({
    ...readySnapshot,
    account: { ...readySnapshot.account, mode: 'LIVE' }
  }), false);
  assert.equal(isCoreTradingSnapshotReady({
    ...readySnapshot,
    account: { ...readySnapshot.account, krwBalance: Number.NaN }
  }), false);
  assert.equal(isCoreTradingSnapshotReady({ ...readySnapshot, selectedCoin: 'KRW-ETH' }), false);
  assert.equal(isCoreTradingSnapshotReady({
    ...readySnapshot,
    marketPrices: [{ coin: 'KRW-BTC', price: 0 }]
  }), false);
});

test('market timestamp formatting distinguishes valid, absent, and invalid values', () => {
  assert.equal(typeof formatMarketTimestamp, 'function');
  const exchangeTime = formatMarketTimestamp('2026-09-29T01:02:03.000Z');
  const fetchTime = formatMarketTimestamp('2026-09-29T01:02:08.000Z');

  assert.notEqual(exchangeTime, '시각 정보 미제공');
  assert.notEqual(exchangeTime, '시각 형식 오류');
  assert.notEqual(fetchTime, exchangeTime);
  assert.equal(formatMarketTimestamp(null), '시각 정보 미제공');
  assert.equal(formatMarketTimestamp(undefined), '시각 정보 미제공');
  assert.equal(formatMarketTimestamp(''), '시각 정보 미제공');
  assert.equal(formatMarketTimestamp('   '), '시각 정보 미제공');
  assert.equal(formatMarketTimestamp('not-a-timestamp'), '시각 형식 오류');
  assert.equal(formatMarketTimestamp({ timestamp: '2026-09-29T01:02:03.000Z' }), '시각 형식 오류');
});

test('selected-market UI binds exchange source time and server fetch time separately', () => {
  const renderMarketHeader = redesignSource.split('function renderMarketHeader() {')[1]?.split('function sortedMarketPrices()')[0] || '';
  const marketPageStart = redesignSource.indexOf('data-pilot-page="market">');
  const marketPageEnd = redesignSource.indexOf('data-pilot-page="analysis">', marketPageStart);
  const marketPage = marketPageStart >= 0 && marketPageEnd > marketPageStart
    ? redesignSource.slice(marketPageStart, marketPageEnd)
    : '';

  assert.match(renderMarketHeader, /formatMarketTimestamp\(marketData\?\.sourceAsOf\)/);
  assert.doesNotMatch(renderMarketHeader, /marketData\?\.sourceAsOf \?\? state\.marketSnapshot\?\.sourceAsOf/);
  assert.match(renderMarketHeader, /formatMarketTimestamp\(marketData\?\.fetchedAt \?\? state\.marketSnapshot\?\.fetchedAt\)/);
  assert.doesNotMatch(renderMarketHeader, /Date\.now\(/);
  assert.match(marketPage, /최근 체결 시각/);
  assert.match(marketPage, /서버 시세 수집 시각/);
  assert.match(marketPage, /pilot-market-source-asof/);
  assert.match(marketPage, /pilot-market-fetched-at/);
  assert.match(marketPage, /id="pilot-market-status-announcement" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(marketPage, /id="pilot-market-refresh-announcement" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(renderMarketHeader, /updateMarketAnnouncement\('pilot-market-status-announcement'/);
  assert.match(redesignSource, /if \(action === 'refresh-market'\) \{ await loadCore\(\); announceManualMarketRefresh\(\); return; \}/);
  assert.doesNotMatch(renderMarketHeader, /setText\('pilot-market-name', marketPresentation\.pageDetail\)/);
  assert.match(renderMarketHeader, /marketName\.textContent !== '업비트 원화 시장'/);
  assert.match(renderMarketHeader, /marketStatus\.textContent !== marketStatusLabel/);
  const selectedMarketHeader = redesignSource.split('function renderMarketHeader() {')[1]?.split('function sortedMarketPrices()')[0] || '';
  assert.match(selectedMarketHeader, /selectedMarketQuotePresentation\(\s*marketData,\s*marketPresentation,\s*state\.marketPricesLoaded\s*\)/);
  assert.match(redesignStyleSource, /\.pilot-market-time-meta/);
});

test('selected market status is scoped to its own quote while market summary retains aggregate state', () => {
  assert.equal(typeof selectedMarketQuotePresentation, 'function');
  const now = Date.now();
  const aggregateStale = {
    label: '1개 시장의 시세가 오래됐어요',
    state: 'stale'
  };
  const selectedFresh = selectedMarketQuotePresentation({
    price: 100,
    sourceAsOf: new Date(now - 1_000).toISOString()
  }, aggregateStale, true, now);
  assert.deepEqual(selectedFresh, { label: '현재 시세', state: 'complete' });

  const selectedStale = selectedMarketQuotePresentation({
    price: 100,
    sourceAsOf: new Date(now - 10 * 60_000).toISOString()
  }, { label: '전체 시세 상태를 확인하세요', state: 'partial' }, true, now);
  assert.equal(selectedStale.state, 'stale');
  assert.match(selectedStale.label, /최근 체결 시각이 오래됐어요/);

  const missingSelected = selectedMarketQuotePresentation(null, {
    label: '일부 시장 시세를 확인할 수 없습니다',
    state: 'partial'
  }, true, now);
  assert.deepEqual(missingSelected, {
    label: '일부 시장 시세를 확인할 수 없습니다',
    state: 'partial'
  });

  const failedRefresh = selectedMarketQuotePresentation({
    price: 100,
    sourceAsOf: new Date(now - 1_000).toISOString(),
    fetchedAt: new Date(now - 5_000).toISOString()
  }, aggregateStale, false, now);
  assert.equal(failedRefresh.state, 'stale');
  assert.match(failedRefresh.label, /새로고침 실패 · 마지막 수집/);
});

test('selected-market order freshness matches server source-age admission and ignores fetch age alone', () => {
  assert.equal(typeof marketQuoteFreshnessIssue, 'function');
  const now = Date.now();
  const fresh = marketQuoteFreshnessIssue({
    price: 100,
    sourceAsOf: new Date(now - 1_000).toISOString(),
    fetchedAt: new Date(now).toISOString()
  }, now);
  const staleTrade = marketQuoteFreshnessIssue({
    price: 100,
    sourceAsOf: new Date(now - 10 * 60_000).toISOString(),
    fetchedAt: new Date(now).toISOString()
  }, now);
  const futureTrade = marketQuoteFreshnessIssue({
    price: 100,
    sourceAsOf: new Date(now + 6_000).toISOString(),
    fetchedAt: new Date(now).toISOString()
  }, now);
  const oldFetchFreshSource = marketQuoteFreshnessIssue({
    price: 100,
    sourceAsOf: new Date(now - 1_000).toISOString(),
    fetchedAt: new Date(now - 10 * 60_000).toISOString()
  }, now);
  const serverMarkedUnverified = marketQuoteFreshnessIssue({
    price: 100,
    sourceAsOf: new Date(now - 1_000).toISOString(),
    fetchedAt: new Date(now).toISOString(),
    quoteFresh: false
  }, now);

  assert.equal(fresh, null);
  assert.match(staleTrade, /최근 체결 시각이 오래됐어요/);
  assert.match(futureTrade, /현재보다 앞서 있어요/);
  assert.equal(oldFetchFreshSource, null,
    'A cached fetch time alone must not contradict the server fresh-ticker admission policy.');
  assert.match(serverMarkedUnverified, /최신 여부를 확인할 수 없어요/);
  assert.match(lastGoodMarketQuoteFreshnessIssue({
    price: 100,
    sourceAsOf: new Date(now - 1_000).toISOString(),
    fetchedAt: new Date(now - 2_000).toISOString(),
    quoteFresh: false
  }, now), /저장된 최근 시세/);
  assert.match(marketQuoteFreshnessIssue({
    price: 100,
    sourceAsOf: new Date(now - 1_000).toISOString(),
    quoteFresh: false,
    quoteFreshnessReason: 'market_snapshot_last_good'
  }, now), /저장된 최근 시세/);
  const selectedMarketHeader = redesignSource.split('function renderMarketHeader() {')[1]?.split('function sortedMarketPrices()')[0] || '';
  assert.match(selectedMarketHeader, /selectedMarketQuotePresentation\(\s*marketData,\s*marketPresentation,\s*state\.marketPricesLoaded\s*\)/);
  assert.match(selectedMarketQuotePresentationFunctionSource, /marketQuoteFreshnessIssue\(marketData, now\)/);
  assert.match(redesignSource, /marketQuoteFreshnessIssue\(currentMarket\(marketSelect\?\.value\)\)/);
  const tradePanel = redesignSource.split('function renderTradePanel(prefix) {')[1]?.split('function renderTradePanels()')[0] || '';
  assert.match(tradePanel, /canTrade\(selectedCoin\)/);
  assert.match(tradePanel, /marketQuoteFreshnessIssue\(market\)/);
});

test('stale-quote 409 explains the measured age and direct failures do not record a portfolio snapshot', () => {
  assert.equal(typeof protectedMutationError, 'function');
  const message = protectedMutationError({
    body: {
      code: 'MARKET_QUOTE_STALE',
      markets: [{ market: 'KRW-BTC', ageMs: 61000, maximumAgeMs: 90000 }]
    }
  }, '주문을 처리하지 못했습니다.');
  assert.match(message, /BTC 최근 체결 1분 1초 전/);
  assert.match(message, /허용 90초/);
  assert.match(message, /최신 시세를 확인한 뒤 다시 시도/);

  const directOrderHandler = redesignSource.split('async function executeTrade(prefix) {')[1]?.split('async function executeSmart(kind)')[0] || '';
  assert.match(directOrderHandler, /if \(result\.success === false\)/);
  assert.match(directOrderHandler, /await loadCore\(\{ quiet: true \}\)/);
  assert.ok(
    directOrderHandler.indexOf('if (result.success === false)') <
      directOrderHandler.indexOf('recordCurrentPortfolioSnapshot'),
    'A deterministic no-order response must return before the success-only snapshot write.'
  );
});

test('PWA reads explicit price snapshot metadata and presents complete, partial, and unavailable states', () => {
  assert.equal(typeof normalizeMarketPriceSnapshot, 'function');
  assert.equal(typeof marketSnapshotPresentation, 'function');
  const rows = [{ coin: 'KRW-BTC', price: 100 }];
  const completeSnapshot = normalizeMarketPriceSnapshot({
    requestedMarkets: ['KRW-BTC'],
    returnedMarkets: ['KRW-BTC'],
    missingMarkets: [],
    unavailableMarkets: [],
    complete: true,
    sourceAsOf: '2026-09-29T01:02:03.000Z',
    fetchedAt: '2026-09-29T01:02:08.000Z',
    snapshotSource: 'upstream',
    marketListStale: false,
    marketListFetchedAt: '2026-09-29T01:01:00.000Z',
    prices: rows
  });

  assert.deepEqual(completeSnapshot.prices, rows);
  assert.equal(completeSnapshot.complete, true);
  assert.equal(completeSnapshot.marketListStale, false);
  assert.equal(completeSnapshot.sourceAsOf, '2026-09-29T01:02:03.000Z');
  assert.equal(completeSnapshot.fetchedAt, '2026-09-29T01:02:08.000Z');
  assert.equal(completeSnapshot.snapshotSource, 'upstream');
  assert.equal(completeSnapshot.marketListFetchedAt, '2026-09-29T01:01:00.000Z');
  const completePresentation = marketSnapshotPresentation(completeSnapshot, true, completeSnapshot.prices);
  assert.equal(completePresentation.state, 'complete');
  assert.equal(completePresentation.label, '모든 시장의 시세를 확인했어요');
  assert.match(completePresentation.detail, /시장 목록을 확인했어요/);

  const partialSnapshot = normalizeMarketPriceSnapshot({
    complete: false,
    missingMarkets: ['KRW-ETH', 'KRW-SOL'],
    unavailableMarkets: ['KRW-ETH'],
    sourceAsOf: null,
    fetchedAt: null,
    marketListStale: true,
    marketListFetchedAt: '2026-09-28T23:00:00.000Z',
    prices: rows
  });
  const partialPresentation = marketSnapshotPresentation(partialSnapshot, true, partialSnapshot.prices);
  assert.equal(partialPresentation.state, 'partial');
  assert.equal(partialPresentation.label, '2개 시장 시세를 확인할 수 없습니다');
  assert.match(partialPresentation.detail, /시장 목록을 새로 확인해야 해요/);
  assert.match(partialPresentation.pageDetail, /목록 확인/);
  assert.ok(partialPresentation.pageDetail.includes(formatMarketTimestamp(partialSnapshot.marketListFetchedAt)));

  const staleCompletePresentation = marketSnapshotPresentation({
    ...completeSnapshot,
    marketListStale: true
  }, true, completeSnapshot.prices);
  assert.equal(staleCompletePresentation.state, 'stale');
  assert.equal(staleCompletePresentation.tone, 'warning');

  const lastGoodSnapshot = normalizeMarketPriceSnapshot({
    ...completeSnapshot,
    snapshotSource: 'last_good',
    fallbackReason: 'ENETDOWN',
    prices: [{ ...rows[0], quoteFresh: false, quoteFreshnessReason: 'market_snapshot_last_good' }]
  });
  const lastGoodPresentation = marketSnapshotPresentation(lastGoodSnapshot, true, lastGoodSnapshot.prices);
  assert.equal(lastGoodPresentation.state, 'stale');
  assert.equal(lastGoodPresentation.tone, 'warning');
  assert.match(lastGoodPresentation.label, /저장된 최근 시세/);

  assert.equal(normalizeMarketPriceSnapshot({ complete: true }), null);
  const unavailablePresentation = marketSnapshotPresentation(null, false, []);
  assert.equal(unavailablePresentation.state, 'unavailable');
  assert.match(unavailablePresentation.label, /시세를 불러오지 못했습니다/);
  assert.match(unavailablePresentation.detail, /시장 목록을 확인할 수 없어요/);

  assert.equal(typeof marketRowQuotePresentation, 'function');
  const rowFetchedAt = '2026-09-29T01:02:08.000Z';
  const currentRow = marketRowQuotePresentation({
    price: 100,
    sourceAsOf: '2026-09-29T01:02:03.000Z',
    fetchedAt: rowFetchedAt
  }, true, Date.parse('2026-09-29T01:02:09.000Z'));
  assert.equal(currentRow.state, 'current');
  assert.match(currentRow.label, /최근 시세 · 수집/);
  const failedRefreshRow = marketRowQuotePresentation({
    price: 100,
    sourceAsOf: '2026-09-29T01:02:03.000Z',
    fetchedAt: rowFetchedAt
  }, false, Date.parse('2026-09-29T01:02:09.000Z'));
  assert.equal(failedRefreshRow.state, 'stale');
  assert.match(failedRefreshRow.label, /갱신 실패 · 마지막 수집/);
  const lastGoodRow = marketRowQuotePresentation({
    price: 100,
    sourceAsOf: '2026-09-29T01:02:03.000Z',
    fetchedAt: rowFetchedAt,
    quoteFresh: false,
    quoteFreshnessReason: 'market_snapshot_last_good'
  }, true, Date.parse('2026-09-29T01:02:09.000Z'));
  assert.equal(lastGoodRow.state, 'stale');
  assert.match(lastGoodRow.label, /저장 시세 · 수집/);

  const coreLoader = redesignSource.split('async function loadCore(')[1]?.split('function clearDynamicStateForOffline()')[0] || '';
  assert.match(coreLoader, /marketPrices: '\/market\/prices\/snapshot'/);
  assert.match(coreLoader, /marketPrices: marketSnapshotLoaded \? marketSnapshot\.prices : null/);
  const marketRows = redesignSource.split('function renderMarketList() {')[1]?.split('function renderPortfolio()')[0] || '';
  assert.match(marketRows, /marketRowQuotePresentation\(item, state\.marketPricesLoaded\)/);
  assert.match(marketRows, /pilot-market-row-freshness/);
  assert.doesNotMatch(coreReadinessFunctionSource || '', /marketSnapshot|complete|missingMarkets/);
});

test('snapshot 404 alone falls back to legacy prices and keeps unknown freshness visible', async () => {
  assert.equal(typeof buildLegacyMarketPriceSnapshot, 'function');
  assert.equal(typeof loadLegacyMarketSnapshotOn404, 'function');
  const legacyPrices = [
    {
      coin: 'KRW-BTC',
      price: 100,
      sourceAsOf: '2026-09-29T02:05:00.000Z',
      fetchedAt: '2026-09-29T02:06:00.000Z'
    },
    {
      coin: 'KRW-ETH',
      price: 200,
      sourceAsOf: '2026-09-29T02:03:00.000Z',
      fetchedAt: '2026-09-29T02:04:00.000Z'
    }
  ];
  const verifiedTargetList = {
    coins: ['KRW-BTC', 'KRW-ETH'],
    count: 2,
    stale: false,
    fetchedAt: '2026-09-29T02:01:00.000Z'
  };
  const requestedPaths = [];
  const snapshot = await loadLegacyMarketSnapshotOn404(
    Object.assign(new Error('snapshot route unavailable'), { status: 404 }),
    verifiedTargetList,
    async route => { requestedPaths.push(route); return legacyPrices; }
  );

  assert.deepEqual(requestedPaths, ['/market/prices']);
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.marketListStale, false);
  assert.equal(snapshot.legacyFallback, true);
  assert.equal(snapshot.sourceAsOf, '2026-09-29T02:03:00.000Z');
  assert.equal(snapshot.fetchedAt, '2026-09-29T02:04:00.000Z');
  const legacyPresentation = marketSnapshotPresentation(
    normalizeMarketPriceSnapshot(snapshot), true, snapshot.prices
  );
  assert.equal(legacyPresentation.state, 'stale');
  assert.equal(legacyPresentation.tone, 'warning');
  assert.match(legacyPresentation.detail, /시세의 최신 여부는 확인할 수 없습니다/);
  assert.match(legacyPresentation.detail, /시장 목록을 확인했어요/);

  const unverifiedSnapshot = buildLegacyMarketPriceSnapshot(legacyPrices, null);
  const unverifiedPresentation = marketSnapshotPresentation(
    normalizeMarketPriceSnapshot(unverifiedSnapshot), true, unverifiedSnapshot.prices
  );
  assert.equal(unverifiedSnapshot.complete, null);
  assert.equal(unverifiedSnapshot.marketListStale, null);
  assert.equal(unverifiedSnapshot.marketListFetchedAt, null);
  assert.equal(unverifiedPresentation.state, 'unavailable');
  assert.match(unverifiedPresentation.detail, /시장 목록을 확인할 수 없어요/);
  assert.equal(unverifiedPresentation.tone, 'warning');

  for (const error of [
    Object.assign(new Error('server error'), { status: 503 }),
    new Error('network timeout')
  ]) {
    const paths = [];
    await assert.rejects(loadLegacyMarketSnapshotOn404(
      error,
      verifiedTargetList,
      async route => { paths.push(route); return legacyPrices; }
    ), currentError => currentError === error);
    assert.deepEqual(paths, []);
  }

  const coreLoader = redesignSource.split('async function loadCore(')[1]?.split('function clearDynamicStateForOffline()')[0] || '';
  assert.match(coreLoader, /marketPricesError\?\.status === 404/);
  assert.match(coreLoader, /loadLegacyMarketSnapshotOn404\(marketPricesError, targetCoins, requestJSON\)/);
});

test('overview data status warns for partial, stale, and unknown market snapshots', () => {
  const gateRendererStart = redesignSource.indexOf('    function renderGateIcon(');
  const gateRendererEnd = redesignSource.indexOf('\n    function renderChartPeriodButtons()', gateRendererStart);
  const gateRendererSource = gateRendererStart >= 0 && gateRendererEnd > gateRendererStart
    ? redesignSource.slice(gateRendererStart, gateRendererEnd)
    : null;
  assert.ok(gateRendererSource);

  function renderFreshnessGate(marketSnapshot, marketPricesLoaded, marketPrices) {
    const texts = new Map();
    const elements = new Map();
    const byId = id => {
      if (!elements.has(id)) elements.set(id, { className: '', innerHTML: '' });
      return elements.get(id);
    };
    const renderGateCards = new Function(
      'state', 'classifyReadiness', 'marketSnapshotPresentation', 'byId', 'setText', 'number',
      `${gateRendererSource}; return renderGateCards;`
    )(
      {
        strategyReadiness: null,
        status: { runtimeState: 'RUNNING' },
        paper: { available: true, state: 'RUNNING', closedTradeCount: 0 },
        marketSnapshot,
        marketPricesLoaded,
        marketPrices
      },
      classifyReadiness,
      marketSnapshotPresentation,
      byId,
      (id, value) => texts.set(id, value),
      value => Number.isFinite(Number(value)) ? Number(value) : 0
    );
    renderGateCards();
    return {
      detail: texts.get('pilot-gate-freshness-detail'),
      iconClass: byId('pilot-gate-freshness-icon').className
    };
  }

  const rows = [{ coin: 'KRW-BTC', price: 100 }];
  const complete = normalizeMarketPriceSnapshot({
    prices: rows,
    complete: true,
    marketListStale: false,
    missingMarkets: [],
    unavailableMarkets: []
  });
  const partial = normalizeMarketPriceSnapshot({
    prices: rows,
    complete: false,
    marketListStale: false,
    missingMarkets: ['KRW-ETH'],
    unavailableMarkets: ['KRW-ETH']
  });
  const stale = normalizeMarketPriceSnapshot({
    ...complete,
    marketListStale: true
  });
  const unknown = normalizeMarketPriceSnapshot({
    ...complete,
    complete: null,
    marketListStale: null,
    legacyFallback: true
  });

  const completeView = renderFreshnessGate(complete, true, rows);
  assert.equal(completeView.detail, '데이터 정상');
  assert.doesNotMatch(completeView.iconClass, /is-blocked/);

  for (const [snapshot, expected] of [
    [partial, '일부 시세 확인 필요'],
    [stale, '시세 최신 여부 확인 필요'],
    [unknown, '시세 상태 확인 필요']
  ]) {
    const view = renderFreshnessGate(snapshot, true, rows);
    assert.equal(view.detail, expected);
    assert.match(view.iconClass, /is-blocked/);
  }
});

test('overview labels stopped paper runs neutrally and keeps unknown state blocked', () => {
  const gateRendererStart = redesignSource.indexOf('    function renderGateIcon(');
  const gateRendererEnd = redesignSource.indexOf('\n    function renderChartPeriodButtons()', gateRendererStart);
  const gateRendererSource = gateRendererStart >= 0 && gateRendererEnd > gateRendererStart
    ? redesignSource.slice(gateRendererStart, gateRendererEnd)
    : null;
  assert.ok(gateRendererSource);

  function renderPaperGate(paper) {
    const texts = new Map();
    const elements = new Map();
    const byId = id => {
      if (!elements.has(id)) elements.set(id, { className: '', innerHTML: '' });
      return elements.get(id);
    };
    const renderGateCards = new Function(
      'state', 'classifyReadiness', 'marketSnapshotPresentation', 'byId', 'setText', 'number',
      `${gateRendererSource}; return renderGateCards;`
    )(
      { paper, status: { runtimeState: 'RUNNING' } },
      () => ({ stateLabel: '통과' }),
      marketSnapshotPresentation,
      byId,
      (id, value) => texts.set(id, value),
      value => Number.isFinite(Number(value)) ? Number(value) : 0
    );
    renderGateCards();
    return {
      detail: texts.get('pilot-gate-paper-detail'),
      iconClass: byId('pilot-gate-paper-icon').className,
      iconMarkup: byId('pilot-gate-paper-icon').innerHTML
    };
  }

  const stopped = renderPaperGate({ available: true, state: 'STOPPED', closedTradeCount: 0 });
  assert.equal(stopped.detail, '중지됨 · 청산 0회');
  assert.equal(stopped.iconClass, 'pilot-gate-icon is-neutral');
  assert.match(stopped.iconMarkup, /ph-pause/);

  const completed = renderPaperGate({ available: true, state: 'PASS', closedTradeCount: 3 });
  assert.equal(completed.detail, '완료 · 청산 3회');
  assert.equal(completed.iconClass, 'pilot-gate-icon');
  assert.match(completed.iconMarkup, /ph-check/);

  const unknown = renderPaperGate({ available: true, state: 'FUTURE_STATE', closedTradeCount: 3 });
  assert.equal(unknown.detail, '상태 확인 필요');
  assert.equal(unknown.iconClass, 'pilot-gate-icon is-blocked');
  assert.match(unknown.iconMarkup, /ph-warning/);
});

test('complete cash-only portfolios use one 100 percent row without a chart', () => {
  assert.equal(typeof portfolioAllocationPresentation, 'function');
  const presentation = portfolioAllocationPresentation([], 1_000_000);

  assert.equal(presentation.kind, 'single');
  assert.equal(presentation.total, 1_000_000);
  assert.deepEqual(presentation.items, [{ name: 'KRW', value: 1_000_000, percentage: 100 }]);
});

test('complete multi-asset portfolios calculate composition percentages', () => {
  const presentation = portfolioAllocationPresentation([
    { name: 'BTC', value: 600_000 },
    { name: 'ETH', value: 200_000 }
  ], 200_000);

  assert.equal(presentation.kind, 'multi');
  assert.equal(presentation.total, 1_000_000);
  assert.deepEqual(presentation.items.map(item => item.percentage), [60, 20, 20]);
});

test('a holding with missing valuation shows known amounts without chart percentages', () => {
  const presentation = portfolioAllocationPresentation([
    { name: 'BTC', value: 600_000 },
    { name: 'ETH', value: null }
  ], 400_000);

  assert.equal(presentation.kind, 'partial');
  assert.deepEqual(presentation.items.map(item => [item.name, item.value]), [
    ['BTC', 600_000],
    ['ETH', null],
    ['KRW', 400_000]
  ]);
  assert.ok(presentation.items.every(item => item.percentage === undefined));
  assert.match(presentation.message, /일부 종목 평가액을 확인할 수 없어 자산 비율을 표시하지 않습니다/);
});

test('missing cash valuation shows known holdings amounts without chart percentages', () => {
  const presentation = portfolioAllocationPresentation([
    { name: 'BTC', value: 600_000 },
    { name: 'ETH', value: 400_000 }
  ], null);

  assert.equal(presentation.kind, 'partial');
  assert.deepEqual(presentation.items.map(item => [item.name, item.value]), [
    ['BTC', 600_000],
    ['ETH', 400_000],
    ['KRW', null]
  ]);
  assert.ok(presentation.items.every(item => item.percentage === undefined));
  assert.match(presentation.message, /현금 잔액을 확인할 수 없어 자산 비율을 표시하지 않습니다/);
});

test('zero-value complete portfolios never draw a meaningless zero-percent chart', () => {
  const presentation = portfolioAllocationPresentation([], 0);

  assert.equal(presentation.kind, 'zero');
  assert.equal(presentation.total, 0);
  assert.deepEqual(presentation.items, [{ name: 'KRW', value: 0 }]);
  assert.ok(presentation.items.every(item => item.percentage === undefined));
  assert.match(presentation.message, /0원이라 구성 비율을 표시하지 않습니다/);
});

test('allocation pie renderer is reserved for complete multi-item compositions', () => {
  const drawAllocationChart = redesignSource.split('function drawAllocationChart() {')[1]?.split('function drawMarketChart()')[0] || '';
  assert.match(drawAllocationChart, /const chartVisible = allocation\.kind === 'multi'/);
  assert.match(drawAllocationChart, /if \(!chartVisible\) return/);
  assert.match(drawAllocationChart, /pilot-allocation-list/);
});

test('single and zero allocation cards compact only the portfolio allocation grid', () => {
  const drawAllocationChart = redesignSource.split('function drawAllocationChart() {')[1]?.split('function drawMarketChart()')[0] || '';
  const portfolioPage = redesignSource.split('data-pilot-page="portfolio">')[1]?.split('data-pilot-page="market">')[0] || '';

  assert.match(portfolioPage, /class="pilot-split-grid" id="pilot-portfolio-allocation-grid"/);
  assert.match(drawAllocationChart, /allocationGrid\?\.classList\.toggle\('is-allocation-single', allocation\.kind === 'single'\)/);
  assert.match(drawAllocationChart, /allocationGrid\?\.classList\.toggle\('is-allocation-zero', allocation\.kind === 'zero'\)/);
  assert.match(redesignStyleSource, /#pilot-portfolio-allocation-grid\.is-allocation-single > \.pilot-panel:first-child,[\s\S]*#pilot-portfolio-allocation-grid\.is-allocation-zero > \.pilot-panel:first-child\s*\{\s*align-self:\s*start;/);
  assert.doesNotMatch(redesignStyleSource, /\.pilot-split-grid\.is-allocation/);
});

test('runtime entry gate blocks stopped and protective-only modes but allows normal running mode', () => {
  assert.equal(typeof runtimeCanAcceptOrders, 'function');
  assert.equal(runtimeCanAcceptOrders({ isRunning: true, runtimeState: 'RUNNING', entriesPaused: false }), true);
  assert.equal(runtimeCanAcceptOrders({ isRunning: false, runtimeState: 'PROTECTIVE_ONLY', entriesPaused: true }), false);
  assert.equal(runtimeCanAcceptOrders({ isRunning: true, runtimeState: 'SYNC_REQUIRED', entriesPaused: true, exchangeStateKnown: false }), false);
  assert.equal(runtimeCanAcceptOrders({ isRunning: true, runtimeState: 'RUNNING', entriesPaused: false, exchangeStateKnown: false }), false);
  assert.match(redesignSource, /설정한 시장의 거래소 잔고와 미체결 주문을 확인하는 중입니다/);
  assert.equal(runtimeCanAcceptOrders({ isRunning: false, runtimeState: 'STOPPED', entriesPaused: true }), false);
  assert.equal(runtimeCanAcceptOrders({ isRunning: true, runtimeState: 'RUNNING', entriesPaused: true }), false);
  assert.match(redesignSource, /LIVE · 위험 감시 전용 · 신규 주문 잠금/);
  assert.match(redesignSource, /허용 시세 공백 발생 · 연속성 확인 필요/);
  assert.match(redesignSource, /보호 감시 전용 · 신규 진입 잠금/);
});

test('manual orders have a separate gate from the automatic trading loop', () => {
  assert.equal(typeof runtimeCanAcceptManualOrders, 'function');
  assert.equal(runtimeCanAcceptManualOrders({ runtimeState: 'RUNNING', isRunning: true, entriesPaused: false }, 'DRY_RUN'), true);
  assert.equal(runtimeCanAcceptManualOrders({ runtimeState: 'STOPPED', isRunning: false, entriesPaused: true }, 'DRY_RUN'), true);
  assert.equal(runtimeCanAcceptManualOrders({ runtimeState: 'RUNNING', isRunning: true, entriesPaused: false }, 'LIVE'), true);
  assert.equal(runtimeCanAcceptManualOrders({ runtimeState: 'STOPPED', isRunning: false, entriesPaused: true, stopReason: 'operator_stop' }, 'LIVE'), true);
  assert.equal(runtimeCanAcceptManualOrders({ runtimeState: 'STOPPED', isRunning: false, entriesPaused: true }, 'LIVE'), false);
  assert.equal(runtimeCanAcceptManualOrders({ runtimeState: 'PROTECTIVE_ONLY', isRunning: true, entriesPaused: true, stopReason: 'operator_stop' }, 'LIVE'), false);
  assert.equal(runtimeCanAcceptManualOrders({ runtimeState: 'SYNC_REQUIRED', isRunning: true, entriesPaused: true, exchangeStateKnown: false, stopReason: 'operator_stop' }, 'LIVE'), false);
  assert.match(canTradeFunctionSource, /runtimeCanAcceptManualOrders/);
  assert.doesNotMatch(canTradeFunctionSource, /state\.liveEligible/);
});

test('mode banner distinguishes a stopped automatic loop from available manual orders', () => {
  assert.equal(typeof getModeBannerPresentation, 'function');
  const base = {
    paper: true,
    modeKnown: true,
    liveReady: false,
    offline: false,
    readOnly: false,
    protectiveOnly: false,
    exchangeStateUnknown: false,
    evidenceLocked: false,
    corePending: false,
    runtimeBlocked: true,
    manualOrdersAllowed: true,
    runtimeReason: '자동매매가 중지되어 신규 주문을 보낼 수 없습니다.',
    readOnlyReason: '읽기 전용 모드에서는 내용을 변경할 수 없습니다.',
    coreReadinessReason: '서버 모드와 계좌, 선택한 시장의 시세를 확인할 때까지 주문할 수 없습니다.',
    tradeReason: '현재는 주문할 수 없습니다.'
  };

  const stoppedPaper = getModeBannerPresentation(base);
  assert.equal(stoppedPaper.title, '자동매매 중지 · 모의 주문 가능');
  assert.match(stoppedPaper.copy, /모의투자로 기록되며 실제 자금은 사용되지 않습니다/);
  assert.equal(stoppedPaper.isLive, false);

  const operatorStoppedLive = getModeBannerPresentation({ ...base, paper: false });
  assert.equal(operatorStoppedLive.title, '자동매매 중지 · 실거래 가능');
  assert.match(operatorStoppedLive.copy, /운영자가 자동매매를 중지했습니다/);
  assert.match(operatorStoppedLive.copy, /수동 주문을 보낼 수 있습니다/);
  assert.equal(operatorStoppedLive.isLive, false);
});

test('mode banner keeps every fail-closed state visibly locked', () => {
  assert.equal(typeof getModeBannerPresentation, 'function');
  const base = {
    paper: true,
    modeKnown: true,
    liveReady: false,
    offline: false,
    readOnly: false,
    protectiveOnly: false,
    exchangeStateUnknown: false,
    evidenceLocked: false,
    corePending: false,
    runtimeBlocked: true,
    // Conflicting input must never let a safety state display manual access.
    manualOrdersAllowed: true,
    runtimeReason: '위험 감시가 신규 주문을 차단했습니다.',
    readOnlyReason: '읽기 전용 모드에서는 내용을 변경할 수 없습니다.',
    coreReadinessReason: '계좌와 시세를 확인할 때까지 주문할 수 없습니다.',
    tradeReason: '모의투자 기록을 보호하고 있습니다.'
  };
  const blockedCases = [
    [{ offline: true }, '오프라인 · 주문 잠금'],
    [{ readOnly: true }, '읽기 전용 · 주문 잠금'],
    [{ protectiveOnly: true }, '위험 감시 전용 · 신규 주문 잠금'],
    [{ exchangeStateUnknown: true }, '거래소 상태 확인 중 · 주문 잠금'],
    [{ evidenceLocked: true }, '모의투자 기록 보호 · 신규 주문 잠금'],
    [{ corePending: true }, '연결 확인 중 · 주문 잠금'],
    [{ runtimeBlocked: true, manualOrdersAllowed: false }, '매매 중지 · 신규 주문 잠금']
  ];

  for (const [overrides, expectedTitle] of blockedCases) {
    const presentation = getModeBannerPresentation({ ...base, ...overrides });
    assert.equal(presentation.title, expectedTitle);
    assert.match(presentation.title, /잠금/);
    assert.equal(presentation.isLive, false);
  }
});

test('manual LIVE access is not mislabeled as locked when automatic readiness is separate', () => {
  const presentation = getModeBannerPresentation({
    paper: false,
    modeKnown: true,
    liveReady: false,
    offline: false,
    readOnly: false,
    protectiveOnly: false,
    exchangeStateUnknown: false,
    evidenceLocked: false,
    corePending: false,
    runtimeBlocked: false,
    manualOrdersAllowed: true
  });

  assert.equal(presentation.title, '실거래 · 수동 주문 가능');
  assert.equal(presentation.isLive, false);
});

test('portfolio snapshot controls re-enable after a failed request and retry after recovery', () => {
  assert.match(redesignSource, /function syncSnapshotControls\(\)[\s\S]*\[data-pilot-action="record-snapshot"\][\s\S]*state\.snapshotSaving/);
  assert.match(snapshotFunctionSource, /state\.snapshotSaving = true/);
  assert.match(snapshotFunctionSource, /finally \{\s*state\.snapshotSaving = false;\s*syncObserverControls\(\);/);
  assert.match(snapshotFunctionSource, /state\.snapshotSaving\) return false/);
});

test('portfolio snapshot request restores its control after a failed response', async () => {
  const state = { online: true, snapshotSaving: false };
  const button = { disabled: false };
  const syncObserverControls = () => { button.disabled = state.snapshotSaving; };
  const recordSnapshot = new Function(
    'state', 'isPwaMutationBlocked', 'syncObserverControls', 'requestJSON', 'toUserText', 'showToast', 'loadCore',
    `${snapshotFunctionSource}; return recordCurrentPortfolioSnapshot;`
  )(state, () => false, syncObserverControls, async () => ({ recorded: false, error: 'not saved' }), String, () => {}, async () => {});

  assert.equal(await recordSnapshot({ refresh: false }), false);
  assert.equal(state.snapshotSaving, false);
  assert.equal(button.disabled, false);
});

test('strategy research loader shares pending requests and retries after a failure', async () => {
  const report = { available: true, study: 'same_window_scalping_variant_comparison', variants: {} };
  const state = {
    online: true,
    strategyResearch: null,
    strategyResearchLoaded: false,
    strategyResearchLoading: false,
    strategyResearchError: null,
    strategyResearchRequest: null
  };
  let calls = 0;
  let shouldFail = true;
  let resolveRequest;
  const pending = new Promise(resolve => { resolveRequest = resolve; });
  const loader = new Function(
    'state', 'networkGeneration', 'requestJSON', 'renderStrategyResearch',
    `${strategyResearchLoaderFunctionSource}; return loadStrategyResearch;`
  )(
    state,
    1,
    async () => {
      calls += 1;
      if (shouldFail) throw new Error('temporary read failure');
      return pending;
    },
    () => {}
  );

  assert.equal(await loader(), null);
  assert.equal(state.strategyResearchLoaded, false);
  assert.equal(state.strategyResearchError.message, 'temporary read failure');
  shouldFail = false;
  const first = loader({ force: true });
  const second = loader();
  assert.equal(first, second);
  resolveRequest(report);
  assert.equal(await first, report);
  assert.equal(state.strategyResearchLoaded, true);
  assert.equal(state.strategyResearch, report);
  assert.equal(calls, 2);
});

test('direct Analysis entry loads its research report and restored AI view loads its data', () => {
  assert.match(showViewFunctionSource, /view === 'analysis'[\s\S]*loadStrategyResearch\(\)/);
  assert.match(showViewFunctionSource, /view === 'ai'\) loadAiDesk\(false\)/);
  assert.match(redesignSource, /function loadStrategyResearch\([\s\S]*requestJSON\('\/strategy-research'\)/);
  assert.match(redesignSource, /reload-strategy-research/);
  assert.doesNotMatch(historyLoaderFunctionSource, /strategy-research/);
});

test('readiness classifies passed, blocked, stale, and unknown states without false green', () => {
  assert.equal(typeof classifyReadiness, 'function');
  const report = {
    available: true,
    filename: 'scalping_validation.json',
    generatedAt: '2026-09-21T00:00:00.000Z',
    validationMode: 'fixed_config',
    promoted: true,
    freshness: { fresh: false, reason: 'stale', ageSeconds: 172_800, maxAgeSeconds: 86_400 }
  };
  const staleButGatePassed = classifyReadiness({
    source: 'configured_scalping_validation_report',
    status: 'BLOCKED',
    currentEvidence: false,
    report,
    runtime: { dryRun: true, applies: false },
    liveGate: { checked: true, passed: true, enforced: false, enforcedFreshness: false }
  });

  assert.equal(staleButGatePassed.ready, false);
  assert.equal(staleButGatePassed.stale, true);
  assert.equal(staleButGatePassed.stateLabel, '보류');
  assert.equal(staleButGatePassed.gate.passed, true);
  assert.equal(staleButGatePassed.gate.enforcedFreshness, false);
  assert.equal(staleButGatePassed.currentEvidence, false);
  assert.deepEqual(staleButGatePassed.reasons, ['점검 결과가 오래됐습니다.']);

  const ready = classifyReadiness({
    source: 'configured_scalping_validation_report',
    status: 'READY',
    currentEvidence: true,
    report: { ...report, freshness: { fresh: true, reason: 'fresh', ageSeconds: 60, maxAgeSeconds: 86_400 } },
    runtime: { dryRun: false, applies: true },
    liveGate: { checked: true, passed: true, enforced: true, enforcedFreshness: false }
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.stateLabel, '통과');

  const paperReady = classifyReadiness({
    source: 'configured_scalping_validation_report',
    status: 'READY',
    currentEvidence: true,
    report: { ...report, freshness: { fresh: true, reason: 'fresh', ageSeconds: 60, maxAgeSeconds: 86_400 } },
    runtime: { dryRun: true, applies: false },
    liveGate: { checked: true, passed: true, enforced: false, enforcedFreshness: false }
  });
  assert.equal(paperReady.stateLabel, '통과');

  const settingsMismatch = classifyReadiness({
    source: 'configured_scalping_validation_report',
    status: 'BLOCKED',
    currentEvidence: false,
    report: { ...report, freshness: { fresh: true, reason: 'fresh' } },
    liveGate: { checked: true, passed: false, code: 'runtime_config_mismatch' }
  });
  assert.equal(settingsMismatch.stateLabel, '보류');
  assert.equal(settingsMismatch.headline, '실제 주문 조건을 충족하지 못했습니다.');
  assert.deepEqual(settingsMismatch.reasons, ['현재 설정과 점검 당시 설정이 다릅니다. 현재 설정으로 다시 점검하세요.']);

  const validationBypass = classifyReadiness({
    source: 'configured_scalping_validation_report',
    status: 'BLOCKED',
    currentEvidence: false,
    report: { ...report, freshness: { fresh: true, reason: 'fresh' } },
    runtime: { dryRun: false, applies: true, requireValidationPassForLive: false },
    liveGate: {
      checked: true,
      passed: false,
      enforced: true,
      enforcedFreshness: true,
      code: 'live_validation_bypass_not_supported'
    },
    blockers: ['LIVE scalping validation cannot be disabled.'],
    blockerDetails: [{ code: 'live_validation_bypass_not_supported' }]
  });
  assert.equal(validationBypass.stateLabel, '보류');
  assert.deepEqual(validationBypass.reasons, ['실전 스캘핑은 점검을 건너뛸 수 없습니다. 설정을 확인하세요.']);
  assert.equal(validationBypass.gate.enforced, true);
  assert.equal(validationBypass.gate.enforcedFreshness, true);

  const incompleteSettings = classifyReadiness({
    source: 'configured_scalping_validation_report',
    status: 'BLOCKED',
    currentEvidence: false,
    report: { ...report, freshness: { fresh: true, reason: 'fresh' } },
    liveGate: { checked: true, passed: false, code: 'report_config_incomplete' },
    blockerDetails: [
      { code: 'report_not_promoted' },
      { code: 'report_config_incomplete' },
      { code: 'confidence_gate_failed' }
    ]
  });
  assert.deepEqual(incompleteSettings.reasons, [
    '점검에 필요한 설정 정보가 빠져 있습니다.',
    '전략 점검 기준을 충족하지 못했습니다.'
  ]);

  const unknown = classifyReadiness(null);
  assert.equal(unknown.ready, false);
  assert.equal(unknown.stateLabel, '확인 필요');
  assert.deepEqual(unknown.reasons, ['점검 결과를 불러오지 못했습니다.']);

  const invalidTimestamp = classifyReadiness({
    source: 'configured_scalping_validation_report',
    status: 'BLOCKED',
    currentEvidence: false,
    report: { available: true, freshness: { fresh: false, reason: 'future_timestamp' } },
    liveGate: { checked: true, passed: true }
  });
  assert.equal(invalidTimestamp.stateLabel, '확인 필요');
  assert.deepEqual(invalidTimestamp.reasons, ['작성 시각을 확인할 수 없습니다.']);
});

test('optional percent formatting preserves unavailable values instead of coercing null to zero', () => {
  assert.equal(typeof formatOptionalPercent, 'function');
  assert.equal(formatOptionalPercent(null), '—');
  assert.equal(formatOptionalPercent(undefined), '—');
  assert.equal(formatOptionalPercent(''), '—');
  assert.equal(formatOptionalPercent(0), '+0.00%');
  assert.equal(formatOptionalPercent('0.3'), '+0.30%');
});

test('equity charts disclose when legacy history lacks valuation provenance', () => {
  assert.match(redesignSource, /valuationStatus === 'unknown_legacy'/);
  assert.match(redesignSource, /과거 평가 근거 미확인/);
  assert.match(redesignSource, /pilot-portfolio-history-source-label/);
});

test('offline recovery queues exactly a fresh read without locking ordinary successful polls', () => {
  const loadCore = redesignSource
    .split('async function loadCore(')[1]
    ?.split('function clearDynamicStateForOffline()')[0];
  assert.ok(loadCore);
  assert.match(loadCore, /quiet\s*=\s*false,\s*afterNetworkRestore\s*=\s*false/);
  assert.match(loadCore, /if \(afterNetworkRestore\)\s*refreshAfterCurrent\s*=\s*true/);
  assert.doesNotMatch(loadCore.split('const requestGeneration')[1]?.split('const period')[0] || '', /state\.coreReady\s*=\s*false/);
  assert.match(loadCore, /const currentSnapshot = Object\.fromEntries\(settled\.map/);
  assert.match(loadCore, /status: loaded\.status \? currentSnapshot\.status : null/);
  assert.match(loadCore, /account: loaded\.account \? currentSnapshot\.account : null/);
  assert.match(loadCore, /marketPrices: marketSnapshotLoaded \? marketSnapshot\.prices : null/);
  assert.match(loadCore, /state\.connected\s*=\s*state\.coreReady/);
  assert.match(loadCore, /if \(state\.coreReady\)\s*state\.lastSync\s*=/);
  assert.match(redesignSource, /function recoverOnline\(\)[\s\S]*?loadCore\(\{\s*afterNetworkRestore:\s*true\s*\}\)/);
  assert.match(redesignSource, /function enterOfflineMode\(\)[\s\S]*?refreshAfterCurrent\s*=\s*false/);
  assert.match(redesignSource, /state\.coreReady\s*=\s*isCoreTradingSnapshotReady\(/);
  assert.match(redesignSource, /state\.coreReady !== true/);
  assert.match(redesignSource, /state\.actualMode === ['"]DRY_RUN['"]/);
});

test('iOS와 Android 설치 메타가 visible shell에 함께 선언된다', () => {
  assert.match(indexSource, /<meta\s+name="mobile-web-app-capable"\s+content="yes"/);
  assert.match(indexSource, /<meta\s+name="apple-mobile-web-app-capable"\s+content="yes"/);
  assert.match(indexSource, /<meta\s+name="apple-mobile-web-app-title"\s+content="CoinPilot"/);
  assert.match(indexSource, /<meta\s+name="apple-mobile-web-app-status-bar-style"/);
  assert.match(indexSource, /<link\s+rel="apple-touch-icon"\s+href="\/apple-touch-icon\.png"/);
});

test('visible redesign shell owns PWA registration and installation controls', () => {
  assert.match(redesignSource, /function initProgressiveInstall\(\)/);
  assert.match(redesignSource, /navigator\.serviceWorker\.register\(['"]\/sw\.js['"]\)/);
  assert.match(redesignSource, /beforeinstallprompt/);
  assert.match(redesignSource, /updatefound/);
  assert.match(redesignSource, /controllerchange/);
  assert.match(redesignSource, /pilot-pwa-update/);
  assert.match(redesignSource, /reload-pwa/);
  assert.match(redesignSource, /waiting\.postMessage\(\{ type: ['"]SKIP_WAITING['"] \}\)/);
  assert.match(redesignSource, /setTimeout\(reloadOnce, 2000\)/);
  assert.match(redesignSource, /if \(isIos \|\| isStandalone\(\) \|\| !isSecureContext \|\| !serviceWorkerSupported \|\| serviceWorkerFailed\) return;/);
  assert.match(redesignSource, /window\.isSecureContext === true/);
  assert.match(redesignSource, /HTTPS 필요/);
  assert.match(redesignSource, /이 주소에서는 설치할 수 없습니다\. 보안 연결\(HTTPS\) 주소로 다시 여세요/);
  assert.match(redesignSource, /appinstalled/);
  assert.match(redesignSource, /function openInstallGuide\(\)/);
  assert.match(redesignSource, /pilot-install-guide-steps/);
  assert.match(redesignSource, /document\.addEventListener\(['"]visibilitychange['"], refreshInstallState\)/);
  assert.match(redesignSource, /window\.addEventListener\(['"]pageshow['"], refreshInstallState\)/);
  assert.match(redesignSource, /serviceWorkerSupported/);
  assert.match(redesignSource, /serviceWorkerFailed/);
  assert.match(redesignSource, /설치 상태를 확인할 수 없습니다\. 브라우저 메뉴에서 설치 항목을 확인하세요/);
  assert.match(redesignSource, /설치 상태 확인 불가/);
  assert.match(redesignSource, /설치 확인 중/);
  assert.match(redesignSource, /!serviceWorkerSupported/);
  assert.match(redesignSource, /id="pilot-pwa-install"/);
  assert.match(redesignSource, /id="pilot-pwa-state"/);
  assert.match(redesignSource, /initProgressiveInstall\(\);/);
  assert.match(indexSource, /beforeinstallprompt[\s\S]*if \(isIos \|\| isStandalone \|\| !isSecureContext\) return;/);
  assert.match(indexSource, /window\.isSecureContext === true/);
  assert.match(indexSource, /HTTPS 필요/);
  assert.match(serviceWorkerSource, /SKIP_WAITING/);
});

test('설치·오프라인 안내는 사용자 조건과 다음 행동만 표시한다', () => {
  const guide = redesignSource.split('function openInstallGuide() {')[1]?.split('const renderInstallState')[0];
  const update = redesignSource.match(/<div class="pilot-pwa-update"[\s\S]*?<\/div>/)?.[0];
  const topMeta = redesignSource.match(/<div class="pilot-top-meta">[\s\S]*?<\/div>/)?.[0];
  const offline = redesignSource.match(/<section class="pilot-offline-banner"[\s\S]*?<\/section>/)?.[0];
  assert.ok(guide && update && topMeta && offline);
  assert.match(guide, /보안 연결\(HTTPS\) 주소로 다시 여세요/);
  assert.match(guide, /브라우저 메뉴에서 설치 항목을 확인하세요/);
  assert.match(guide, /Safari에서 CoinPilot을 엽니다/);
  assert.match(guide, /홈 화면에 추가/);
  assert.match(guide, /설치 방법/);
  assert.doesNotMatch(guide, /service worker|설치 이벤트|HTTPS로 노출|localhost|127\.0\.0\.1/i);
  assert.match(update, /새 버전이 나왔습니다/);
  assert.match(update, /업데이트를 눌러 적용하세요/);
  assert.match(update, /aria-label="새 버전 적용"/);
  assert.match(update, /data-pilot-action="reload-pwa"/);
  assert.match(update, />업데이트<\/span>/);
  assert.match(topMeta, /pilot-pwa-update/);
  assert.doesNotMatch(update, /paper\/live|최신 설치앱 화면/);
  assert.match(offline, /계좌와 시세를 불러올 수 없습니다/);
  assert.match(offline, /연결이 복구될 때까지 주문과 설정을 사용할 수 없습니다/);
  assert.doesNotMatch(offline, /화면 껍데기|서버 API|service worker/i);
  assert.match(redesignSource, /setText\('pilot-mode-banner-copy',/);
  assert.doesNotMatch(redesignSource, /pilot-mode-subtitle/);
});

test('PWA update control stays inside a height-reserved topbar row', () => {
  const topbar = redesignSource.match(/<header class="pilot-topbar">[\s\S]*?<\/header>/)?.[0];
  assert.ok(topbar);
  assert.match(topbar, /class="pilot-top-meta"[\s\S]*class="pilot-pwa-update"/);
  assert.match(redesignStyleSource, /\.pilot-top-meta\s*\{[\s\S]*min-height:\s*44px/);
  assert.match(redesignStyleSource, /\.pilot-pwa-update\s*\{[\s\S]*flex:\s*0 0 auto/);
  assert.match(redesignStyleSource, /\.pilot-pwa-update \.pilot-button\s*\{[\s\S]*min-height:\s*44px/);
  assert.match(redesignStyleSource, /@media\s*\(max-width:\s*360px\)[\s\S]*\.pilot-pwa-update \.pilot-button\s*\{[\s\S]*min-height:\s*44px/);
  assert.doesNotMatch(topbar, /class="pilot-pwa-update"[\s\S]*?<section class="pilot-pwa-update"/);
});

test('PWA update notice only appears for a waiting worker and stays hidden after controller activation', () => {
  assert.match(redesignSource, /if \(!updateBanner \|\| !serviceWorkerRegistration\?\.waiting \|\| !navigator\.serviceWorker\?\.controller\) return;/);
  assert.match(redesignSource, /if \(registration\.waiting && navigator\.serviceWorker\.controller\) showPwaUpdate\(\)/);
  assert.match(redesignSource, /updatedRegistration\.waiting && navigator\.serviceWorker\.controller\) showPwaUpdate\(\)/);
  assert.doesNotMatch(redesignSource, /if \(hadServiceWorkerController\) showPwaUpdate\(\)/);
});

test('SPA navigation exposes its landmark and current view to assistive technology', () => {
  assert.match(redesignSource, /<nav class="pilot-sidebar-nav" aria-label="주 메뉴">/);
  assert.doesNotMatch(redesignSource, /<aside class="pilot-sidebar" aria-label="주 메뉴">/);
  assert.match(redesignSource, /data-pilot-view="overview" aria-current="page"/);
  assert.match(redesignSource, /function syncViewNavigation\(view\)/);
  assert.match(redesignSource, /button\.setAttribute\(['"]aria-current['"], ['"]page['"]\)/);
  assert.match(redesignSource, /button\.removeAttribute\(['"]aria-current['"]\)/);
  assert.match(redesignSource, /syncViewNavigation\(nextView\)/);
  assert.match(redesignSource, /syncViewNavigation\(view\)/);
});

test('redesigned shell hides the legacy UI without requiring the CSS :has selector', () => {
  assert.match(indexSource, /<body class="pilot-redesign-shell">/);
  assert.match(redesignStyleSource, /body\.pilot-redesign-shell > \.container/);
  assert.doesNotMatch(redesignStyleSource, /body:has\(#pilot-redesign-root\)/);
  assert.match(redesignSource, /document\.body\?\.classList\.remove\('pilot-redesign-shell'\)/);
});

test('overview leads with account value and one preflight action while order entry stays in Trade', () => {
  const overview = redesignSource.split('<section class="pilot-page is-active" data-pilot-page="overview">')[1]
    ?.split('<section class="pilot-page" data-pilot-page="trade">')[0] || '';
  const tradePage = redesignSource.split('<section class="pilot-page" data-pilot-page="trade">')[1]
    ?.split('<section class="pilot-page" data-pilot-page="portfolio">')[0] || '';
  assert.ok(overview);
  assert.ok(tradePage);
  assert.match(overview, /class="pilot-overview-balance"[\s\S]*id="pilot-total-assets"/);
  assert.equal((overview.match(/id="pilot-total-assets"/g) || []).length, 1);
  const balanceRule = redesignStyleSource.match(/\.pilot-overview-balance\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(balanceRule, /border-left:\s*3px solid var\(--sl-blue\)/);
  assert.doesNotMatch(balanceRule, /gradient|box-shadow/i);
  assert.doesNotMatch(redesignStyleSource, /\.pilot-overview-balance::after/);
  assert.match(overview, /<button[^>]*class="pilot-button is-primary pilot-overview-next-action"[^>]*data-pilot-go="history"/);
  assert.equal((overview.match(/data-pilot-go="history"/g) || []).length, 1);
  for (const statusId of [
    'pilot-gate-validation-detail', 'pilot-gate-paper-detail', 'pilot-gate-freshness-detail'
  ]) {
    assert.match(overview, new RegExp(`id="${statusId}"`), `overview must retain ${statusId}`);
  }
  for (const warningId of ['pilot-auth-scope-banner', 'pilot-offline-banner', 'pilot-pending-mutation']) {
    assert.match(redesignSource, new RegExp(`id="${warningId}"`), `shell must retain ${warningId}`);
  }
  const gateDetailRule = redesignStyleSource.match(/\.pilot-gate-detail\s*\{[^}]*\}/)?.[0] || '';
  assert.doesNotMatch(gateDetailRule, /overflow:\s*hidden|text-overflow:\s*ellipsis|white-space:\s*nowrap/);
  assert.doesNotMatch(overview, /tradePanelMarkup\('overview'\)/);
  assert.match(tradePage, /tradePanelMarkup\('trade'\)/);
  assert.match(tradePage, /data-pilot-action="smart-buy"/);
  assert.match(tradePage, /data-pilot-action="smart-sell"/);
  assert.match(redesignSource, /\['market', 'trade'\]\.forEach\(renderTradePanel\)/);
  assert.match(redesignSource, /data-pilot-view="trade"/);
});

test('mobile navigation keeps four core destinations visible and builds the rest into the menu', () => {
  const coreViews = ['overview', 'trade', 'portfolio', 'market'];
  const hiddenViews = ['analysis', 'ai', 'news', 'settings', 'history'];
  assert.match(
    redesignSource,
    /const MOBILE_CORE_VIEWS = new Set\(\['overview', 'trade', 'portfolio', 'market'\]\)/
  );
  assert.match(redesignSource, /id="pilot-mobile-more"[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"/);
  assert.match(redesignSource, /<dialog class="pilot-mobile-menu" id="pilot-mobile-menu"[^>]*aria-labelledby="pilot-mobile-menu-title" aria-modal="true">/);
  assert.match(redesignSource, /<nav class="pilot-mobile-menu-nav" aria-label="추가 메뉴"><\/nav>/);

  for (const view of coreViews) {
    assert.match(redesignSource, new RegExp(`class="pilot-nav-button[^"]*" data-pilot-view="${view}"`));
  }
  for (const view of hiddenViews) {
    assert.match(redesignSource, new RegExp(`data-pilot-view="${view}"`), `missing hidden destination: ${view}`);
    assert.match(redesignSource, new RegExp(`data-pilot-page="${view}"`), `missing destination page: ${view}`);
  }

  const mountMenu = redesignSource.split('function mountMobileNavigation() {')[1]?.split('function syncViewNavigation(')[0];
  assert.ok(mountMenu);
  assert.match(mountMenu, /querySelectorAll\('\.pilot-sidebar-nav \[data-pilot-view\]'\)/);
  assert.match(mountMenu, /filter\(button => !MOBILE_CORE_VIEWS\.has\(button\.dataset\.pilotView\)\)/);
  assert.match(mountMenu, /button\.cloneNode\(true\)/);
  assert.match(mountMenu, /menuNav\.append\(menuItem\)/);

  const pageClickHandler = redesignSource
    .split("root.addEventListener('click', async event => {")[1]
    ?.split('const goButton = event.target.closest(\'[data-pilot-go]\')')[0];
  assert.match(pageClickHandler || '', /if \(viewButton\) \{ showView\(viewButton\.dataset\.pilotView\); return; \}/);
});

test('mobile menu opens modally, closes on Escape or outside tap, and restores focus', () => {
  const mountMenu = redesignSource.split('function mountMobileNavigation() {')[1]?.split('function syncViewNavigation(')[0];
  assert.ok(mountMenu);
  assert.match(mountMenu, /moreButton\.addEventListener\(['"]click['"],\s*\(\) => \{[\s\S]*menu\.showModal\(\)/);
  assert.match(mountMenu, /moreButton\.setAttribute\(['"]aria-expanded['"], ['"]true['"]\)/);
  assert.match(mountMenu, /\(firstDestination \|\| menu\.querySelector\('\[data-pilot-mobile-close\]'\)\)\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(mountMenu, /menu\.addEventListener\(['"]cancel['"], event => \{\s*event\.preventDefault\(\);\s*closeMobileNavigationMenu\(\);/);
  assert.match(mountMenu, /if \(event\.target === menu\) closeMobileNavigationMenu\(\)/);
  assert.match(mountMenu, /menu\.addEventListener\(['"]close['"],[\s\S]*moreButton\.setAttribute\(['"]aria-expanded['"], ['"]false['"]\)[\s\S]*moreButton\.focus\(\{ preventScroll: true \}\)/);
  assert.match(redesignSource, /function showView\(view\) \{\s*if \(!view\) return; closeMobileNavigationMenu\(\);/);
  assert.match(redesignSource, /syncViewNavigation\(view\)[\s\S]*aria-current/);
});

test('뉴스 모달은 키보드 초점을 가두고 닫은 뒤 연 뉴스 항목으로 돌려보낸다', () => {
  assert.ok(modalFocusableFunctionSource && modalFocusElementFunctionSource && modalKeydownFunctionSource);

  const showModal = redesignSource.split('function showModal(')[1]?.split('function closeModal()')[0];
  const closeModal = redesignSource.split('function closeModal() {')[1]?.split('function tradePanelMarkup(')[0];
  const openNews = redesignSource.split('function openNews(index, returnFocusTo = document.activeElement) {')[1]?.split('function setMode(')[0];
  const renderNews = redesignSource.split('function renderNews() {')[1]?.split('function formatReadinessAge(')[0];
  const delegatedClick = redesignSource.split("root.addEventListener('click', async event => {")[1]?.split("root.addEventListener('keydown'")[0];
  const modalKeyboardListener = redesignSource.match(
    /root\.addEventListener\('keydown', event => \{\s*const dialog = byId\('pilot-modal-root'\)\?\.querySelector\('\.pilot-modal'\);\s*if \(dialog\) handleModalKeydown\(event, dialog\);\s*\}\);/
  )?.[0];

  assert.ok(showModal && closeModal && openNews && renderNews && delegatedClick && modalKeyboardListener && newsFocusKey && findNewsFocusTarget);
  assert.match(showModal, /role="dialog" aria-modal="true" aria-labelledby="pilot-modal-title" tabindex="-1"/);
  assert.match(showModal, /id="pilot-modal-title" tabindex="-1"/);
  assert.match(showModal, /focusModalElement\(modalRoot\.querySelector\('\.pilot-modal-title'\)\)/);
  assert.match(closeModal, /const returnFocusTo = modalReturnFocus/);
  assert.match(closeModal, /if \(returnFocusTo\?\.isConnected\) \{\s*focusModalElement\(returnFocusTo\);/);
  assert.match(closeModal, /modalReturnFocusKey = null/);
  assert.match(closeModal, /\.pilot-news-row\[data-pilot-news-key\]/);
  assert.match(closeModal, /findNewsFocusTarget\(newsRows, returnFocusKey, returnFocusIndex\)/);
  assert.match(newsFocusTargetFunctionSource, /row\.dataset\.pilotNewsKey === returnFocusKey/);
  assert.match(newsFocusTargetFunctionSource, /newsRows\[nearestRowIndex\]/);
  assert.match(openNews, /returnFocusTo,/);
  assert.match(openNews, /returnFocusKey: newsFocusKey\(item, index\)/);
  assert.match(openNews, /returnFocusIndex: index/);
  assert.match(renderNews, /data-pilot-news-key="\$\{escapeHtml\(newsFocusKey\(item, index\)\)\}"/);
  assert.match(delegatedClick, /openNews\(number\(newsRow\.dataset\.pilotNewsIndex\), newsRow\)/);
  assert.match(modalKeyboardListener, /handleModalKeydown\(event, dialog\)/);
  assert.match(redesignStyleSource, /\.pilot-modal-title:focus\s*\{[\s\S]*outline:/);

  const closeClickHandler = delegatedClick.split("const close = event.target.closest('[data-pilot-modal-close]');")[1]?.split("const viewButton")[0];
  assert.match(closeClickHandler || '', /close\.matches\('\.pilot-modal-backdrop'\)/);
  assert.match(closeClickHandler || '', /event\.target\.closest\('\.pilot-modal'\)/);
  assert.equal(newsFocusKey({ id: 'article-id', link: '/article' }, 4), 'article:article-id');
  assert.equal(newsFocusKey({ guid: 'article-guid', url: '/article' }, 4), 'article:article-guid');
  assert.equal(newsFocusKey({ link: '/article?id=2' }, 4), 'article:/article?id=2');
  assert.equal(newsFocusKey({ title: 'Same article title' }, 4), 'article:Same article title');
  assert.equal(newsFocusKey({}, 4), 'position:4');
  const newsRows = [
    { dataset: { pilotNewsKey: 'article:first' } },
    { dataset: { pilotNewsKey: 'article:opened' } },
    { dataset: { pilotNewsKey: 'article:third' } }
  ];
  assert.equal(findNewsFocusTarget(newsRows, 'article:opened', 0), newsRows[1], 'a rerendered matching story wins over the old index');
  assert.equal(findNewsFocusTarget(newsRows, 'article:removed', 2), newsRows[2], 'a removed story returns to the nearest available row');
  assert.equal(findNewsFocusTarget(newsRows, 'article:removed', 100), newsRows[2], 'the nearest-row index is clamped to the live list');
  assert.equal(findNewsFocusTarget([], 'article:removed', 0), null, 'an empty news list has no focus target');

  let activeElement = null;
  let dismissed = 0;
  const documentRef = {
    get activeElement() { return activeElement; },
    set activeElement(element) { activeElement = element; }
  };
  const createFocusTarget = ({ name, tabIndex = 0, visible = true, disabled = false, hiddenAncestor = false }) => {
    const target = {
      name,
      tabIndex,
      disabled,
      hidden: false,
      closest: () => hiddenAncestor ? {} : null,
      getClientRects: () => visible ? [{}] : [],
      focus() { documentRef.activeElement = target; }
    };
    return target;
  };
  const first = createFocusTarget({ name: 'close' });
  const last = createFocusTarget({ name: 'article' });
  const hidden = createFocusTarget({ name: 'hidden', visible: false });
  const inertChild = createFocusTarget({ name: 'inert', hiddenAncestor: true });
  const negativeTabIndex = createFocusTarget({ name: 'negative', tabIndex: -1 });
  const dialog = {
    querySelectorAll() { return [first, last, hidden, inertChild, negativeTabIndex]; },
    focus() { documentRef.activeElement = dialog; }
  };
  const handleModalKeydown = createModalKeydownHandler(() => { dismissed += 1; });
  const sendKey = (key, shiftKey = false) => {
    let defaultPrevented = false;
    handleModalKeydown({
      key,
      shiftKey,
      preventDefault() { defaultPrevented = true; }
    }, dialog, documentRef);
    return defaultPrevented;
  };

  documentRef.activeElement = last;
  assert.equal(sendKey('Tab'), true);
  assert.equal(documentRef.activeElement, first, 'Tab from the last control wraps to the first');
  documentRef.activeElement = first;
  assert.equal(sendKey('Tab', true), true);
  assert.equal(documentRef.activeElement, last, 'Shift+Tab from the first control wraps to the last');
  documentRef.activeElement = { name: 'modal-title' };
  assert.equal(sendKey('Tab'), true);
  assert.equal(documentRef.activeElement, first, 'Tab from the initially focused title enters the controls');
  assert.equal(sendKey('Escape'), true);
  assert.equal(dismissed, 1);

  const emptyDialog = { querySelectorAll: () => [], focus() { documentRef.activeElement = emptyDialog; } };
  documentRef.activeElement = null;
  assert.equal(handleModalKeydown({ key: 'Tab', preventDefault() {} }, emptyDialog, documentRef), true);
  assert.equal(documentRef.activeElement, emptyDialog, 'an empty dialog remains the keyboard focus target');
});

test('활성 paper evidence 세션 중 UI도 설정·최적화 mutation을 잠근다', () => {
  assert.match(redesignSource, /function paperEvidenceMutationLock\(\)/);
  assert.match(redesignSource, /isPaperEvidenceMutationLocked/);
  assert.match(redesignSource, /paperEvidenceMutationReason/);
  assert.match(redesignSource, /data-pilot-action="save-settings"/);
  assert.match(redesignSource, /data-pilot-action="run-optimization"/);
  assert.match(redesignSource, /#pilot-auto-optimization/);
  assert.match(redesignSource, /#pilot-optimization-interval/);
  assert.match(redesignSource, /escapeHtml(lock.reason || paperEvidenceMutationReason())/);
});

test('중지된 서버에서는 설정과 모의 지갑을 편집하고 실행 중에는 안전하게 잠근다', () => {
  const controls = redesignSource.split('function syncObserverControls() {')[1]?.split('\n    }')[0] || '';
  const settingsGate = controls.match(/const settingsDisabled = [^;]+;/)?.[0] || '';
  assert.match(settingsGate, /blocked \|\| offline \|\| !state\.settingsLoaded \|\| evidenceLocked/);
  assert.match(settingsGate, /tradingLoopRunning/);
  assert.doesNotMatch(settingsGate, /runtimeBlocked|exchangeStateUnsafe/);
  assert.match(controls, /const walletSelectors = \[/);
  assert.match(controls, /!paperMode \|\| exchangeStateUnsafe \|\|\s*tradingLoopRunning \|\| evidenceLocked/);
  assert.match(controls, /'\[data-pilot-action="start-paper"\]'/);
  assert.match(redesignSource, /자동매매를 중지한 뒤 설정을 변경할 수 있습니다/);
});

test('strategy settings are grouped into concise, accessible disclosure sections', () => {
  const renderSettings = redesignSource.split('function renderSettings() {')[1]?.split('function renderHistoryTables()')[0] || '';
  assert.match(renderSettings, /const groupedRanges = new Map()/);
  assert.match(renderSettings, /range\?\.category \|\| 'Other'/);
  assert.match(renderSettings, /투자 규모/);
  assert.match(renderSettings, /진입과 청산/);
  assert.match(renderSettings, /위험 관리/);
  assert.match(renderSettings, /data-pilot-settings-category/);
  assert.match(renderSettings, /data-pilot-setting-key=/);
  assert.match(redesignStyleSource, /\.pilot-settings-category > summary:focus-visible/);
});

test('paper/live 주문 확인 취소는 서버 호출 없이 사용자에게 명시적으로 표시된다', () => {
  assert.match(
    redesignSource,
    /if \(!window\.confirm\([\s\S]*?\)\) \{\s*showToast\(`\$\{symbolOf\(coin\)\} \$\{actionText\}를 취소했습니다`, ['"]info['"]\);\s*return;\s*\}/
  );
});

test('모의투자 설정 경고는 내부 변경 필드 대신 사용자용 안내를 표시한다', () => {
  assert.match(redesignSource, /설정이 바뀌어 이 모의투자 기록은 현재 설정과 일치하지 않습니다/);
  assert.doesNotMatch(redesignSource, /pilot-momentum-shadow-config-drift/);
  assert.doesNotMatch(redesignSource, /최근 owner 재시작/);
});

test('same-window scalping variant evidence is visible without hiding invalid markets', () => {
  assert.match(redesignSource, /same_window_scalping_variant_comparison/);
  assert.match(redesignSource, /report.reportFreshness/);
  assert.match(redesignSource, /최신 데이터를 다시 모으기 전까지 수익성을 판단하는 데 쓰지 마세요/);
  assert.match(redesignSource, /requestedMarketCount/);
  assert.match(redesignSource, /invalidMarketCount/);
  assert.match(redesignSource, /유효 시장/);
  assert.match(redesignSource, /실제 주문 조건에는 반영되지 않음/);
  assert.match(redesignSource, /같은 기간의 시장 자료로 설정별 결과를 비교합니다\. 유효하지 않은 시장이 있거나 학습 구간 기준을 통과하지 못한 결과는 실제 거래 적용 여부를 판단하는 데 쓸 수 없습니다/);
});

test('paper UI는 in-flight analysis cycle을 정상 수신과 구분해 표시한다', () => {
  assert.match(redesignSource, /analysisHealth\.analysisActive === true/);
  assert.match(redesignSource, /(?:분석 cycle 진행 중|분석 진행 중)/);
  assert.match(indexSource, /analysisDataHealth\.analysisActive/);
});

test('대시보드 세션 카드에는 현재 상태와 청산 횟수만 표시한다', () => {
  const cards = redesignSource.split('function renderGateCards() {')[1]?.split('function renderChartPeriodButtons() {')[0];
  assert.ok(cards);
  assert.match(cards, /paper\.closedTradeCount/);
  assert.doesNotMatch(cards, /paperMinimumTrades|paperMinimumDays|freshnessCohort/);
});

test('mobile redesigned shell은 한 줄 네비게이션과 safe-area 여백을 확보한다', () => {
  assert.match(redesignStyleSource, /body\.pilot-redesign-shell\s*\{[\s\S]*height:\s*100dvh[\s\S]*overflow:\s*hidden/);
  assert.match(redesignStyleSource, /\.pilot-topbar\s*\{[\s\S]*padding:\s*calc\(16px \+ env\(safe-area-inset-top,\s*0px\)\) 32px 16px/);
  assert.match(
    redesignStyleSource,
    /@media\s*\(max-width:\s*760px\)[\s\S]*\.pilot-topbar\s*\{[\s\S]*padding:\s*calc\(13px \+ env\(safe-area-inset-top,\s*0px\)\) 14px 13px/
  );
  assert.match(
    redesignStyleSource,
    /@media\s*\(max-height:\s*640px\)[\s\S]*body\.pilot-redesign-shell\s*\{[\s\S]*overflow-y:\s*auto[\s\S]*\.pilot-content\s*\{[\s\S]*overflow:\s*visible/
  );
  assert.match(
    redesignStyleSource,
    /\.pilot-market-candle-data summary:focus-visible\s*\{\s*outline:\s*3px solid var\(--sl-blue\)/
  );
  assert.match(redesignStyleSource, /\.pilot-top-meta\s*\{[\s\S]*min-height:\s*44px/);
  assert.match(redesignStyleSource, /\.pilot-main\s*\{[\s\S]*display:\s*flex[\s\S]*height:\s*100%[\s\S]*overflow:\s*hidden/);
  assert.match(redesignStyleSource, /\.pilot-content\s*\{[\s\S]*flex:\s*1 1 auto[\s\S]*overflow-y:\s*auto[\s\S]*overscroll-behavior-y:\s*contain/);
  assert.match(
    redesignStyleSource,
    /@media\s*\(max-width:\s*760px\)[\s\S]*\.pilot-app\s*\{[\s\S]*padding-bottom:\s*0/
  );
  assert.match(
    redesignStyleSource,
    /@media\s*\(max-width:\s*760px\)[\s\S]*\.pilot-content\s*\{[\s\S]*padding:\s*22px 14px calc\(126px \+ env\(safe-area-inset-bottom,\s*0px\)\)/
  );
  assert.match(
    redesignStyleSource,
    /@media\s*\(max-width:\s*760px\)[\s\S]*\.pilot-sidebar-nav\s*\{[\s\S]*grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/
  );
  assert.match(redesignStyleSource, /pilot-sidebar-nav > \.pilot-nav-button\[data-pilot-view\]\s*\{\s*display:\s*none/);
  assert.match(redesignStyleSource, /pilot-sidebar-nav > \.pilot-nav-button\[data-pilot-view="overview"\][\s\S]*pilot-mobile-more\s*\{\s*display:\s*flex/);
  assert.match(
    redesignStyleSource,
    /\.pilot-overview-lead\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1\.15fr\)\s+minmax\(300px,\s*0\.85fr\)/
  );
  assert.match(
    redesignStyleSource,
    /@media\s*\(max-width:\s*980px\)[\s\S]*\.pilot-overview-lead\s*,\s*\.pilot-market-layout\s*\{[\s\S]*grid-template-columns:\s*1fr/
  );
  assert.match(redesignStyleSource, /\.pilot-overview-readiness-row\s*\{[\s\S]*grid-template-columns:\s*28px\s+minmax\(0,\s*1fr\)/);
  assert.doesNotMatch(redesignStyleSource, /\.pilot-gate-card/);
  assert.match(
    redesignStyleSource,
    /@media\s*\(max-width:\s*360px\)[\s\S]*\.pilot-mode-banner\s*\{[\s\S]*display:\s*grid/
  );
});

test('mobile navigation keeps readable labels and touch targets at least 44px high', () => {
  assert.match(
    redesignStyleSource,
    /@media\s*\(max-width:\s*760px\)[\s\S]*\.pilot-nav-button\s*\{[\s\S]*min-height:\s*56px[\s\S]*font-size:\s*11px/
  );
  assert.match(
    redesignStyleSource,
    /\.pilot-mobile-menu-close\s*\{[\s\S]*width:\s*44px[\s\S]*height:\s*44px/
  );
  assert.match(redesignStyleSource, /\.pilot-mobile-menu-nav \.pilot-nav-button\s*\{[\s\S]*min-height:\s*54px/);
  assert.match(redesignStyleSource, /\.pilot-overview-next-action\s*\{[\s\S]*min-height:\s*48px/);
  assert.match(redesignStyleSource, /\.pilot-button:focus-visible,[\s\S]*outline:\s*3px solid/);
  assert.match(
    redesignStyleSource,
    /@media\s*\(max-width:\s*520px\)[\s\S]*\.pilot-chart-empty \.pilot-button\s*\{[\s\S]*min-height:\s*44px/
  );
  assert.match(redesignStyleSource, /\.pilot-mobile-menu-sheet\s*\{[\s\S]*env\(safe-area-inset-bottom/);
  assert.match(redesignStyleSource, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
});

test('모의투자 시작은 paper 경로를 사용하고 server blocker를 숨기거나 완화하지 않는다', () => {
  const startPaper = redesignSource.split('async function startPaper(')[1]?.split('async function stopPaper()')[0];
  assert.ok(startPaper);
  assert.match(startPaper, /if \(isPwaMutationBlocked\(\)\)/);
  assert.match(startPaper, /requestJSON\('\/paper-validation\/start'/);
  assert.match(startPaper, /모의투자 시작 실패: \$\{error\.message\}/);
  assert.doesNotMatch(startPaper, /minReboundPercent|minVolumeRatio|자동 완화/);
});

test('smart order UI는 mixed fill 결과를 성공으로 오인하지 않는다', () => {
  assert.match(redesignSource, /result\.success === false \? 'warning' : 'success'/);
  assert.match(redesignSource, /result\.failures/);
  assert.match(manualOrderServiceSource, /orders\.length === 0 \? 409 : 207/);
});

test('validation UI는 오래된 report를 최신 raw window 근거와 구분한다', () => {
  assert.match(redesignSource, /validationReportFreshness/);
  assert.match(redesignSource, /report\.reportFreshness/);
  assert.match(redesignSource, /최신 데이터를 다시 모으기 전까지/);
  assert.match(indexSource, /최신 raw window 재점검 필요/);
  assert.match(indexSource, /report\.reportFreshness/);
});

test('전략 준비 UI는 간결한 결과와 선택형 판정 상세를 분리하고 주기 갱신 뒤에도 열림을 유지한다', () => {
  const validation = redesignSource.split('function renderValidationDetail() {')[1]?.split('function renderPaperDetail() {')[0];
  const audit = redesignSource.split('function renderGateAuditDetails(readiness) {')[1]?.split('function renderValidationDetail() {')[0];
  const classification = redesignSource.split('function classifyReadiness(readiness) {')[1]?.split('function symbolOf(')[0];
  const gateCards = redesignSource.split('function renderGateCards() {')[1]?.split('function renderChartPeriodButtons()')[0];
  assert.ok(validation && audit && classification);
  assert.ok(gateCards);
  assert.match(validation, /classifyReadiness\(readiness\)/);
  assert.match(validation, /renderGateAuditDetails\(readiness\)/);
  assert.match(validation, /stateLabel/);
  assert.match(validation, /reasons\.map/);
  assert.match(validation, /report\?\.generatedAt/);
  assert.match(validation, /const auditWasOpen = target\.querySelector\('\.pilot-validation-audit'\)\?\.open === true/);
  assert.match(validation, /if \(auditWasOpen\)[\s\S]*?audit\.open = true/);
  assert.doesNotMatch(validation, /filename|\.json|LIVE gate|enforcedFreshness|pilot-validation-evidence|승격|정산|evidence/i);
  assert.match(audit, /report\.filename/);
  assert.match(audit, /report\.generatedAt/);
  assert.match(audit, /freshness\.ageSeconds/);
  assert.match(audit, /gate\.passed/);
  assert.match(audit, /gate\.enforced/);
  assert.match(audit, /gate\.enforcedFreshness/);
  assert.match(audit, /runtime\.dryRun/);
  assert.match(audit, /<details class="pilot-validation-audit">/);
  assert.match(audit, /실제 체결 여부나 지속적인 수익은 확인할 수 없습니다/);
  assert.match(gateCards, /classifyReadiness\(state\.strategyReadiness\)/);
  assert.match(gateCards, /'점검 통과'/);
  assert.match(gateCards, /'주문 조건 미충족'/);
  assert.match(gateCards, /'확인 필요'/);
  assert.match(classification, /readiness\?\.currentEvidence === true/);
  assert.match(classification, /gate\.checked === true/);
  assert.match(classification, /gate\.passed === true/);
  assert.match(classification, /freshness\?\.fresh === true/);
  assert.match(classification, /report_not_current: '점검 결과가 오래됐습니다\.'/);
  assert.match(classification, /runtime_config_mismatch: '현재 설정과 점검 당시 설정이 다릅니다\. 현재 설정으로 다시 점검하세요\.'/);
  assert.match(classification, /slice\(0,\s*2\)/);
  assert.match(redesignSource, /실제 주문 전 점검을 마칠 때까지 주문할 수 없습니다/);
});

test('research UI는 higher-timeframe 결과를 strict/live gate와 분리해 표시한다', () => {
  assert.match(redesignSource, /strategyResearch/);
  assert.match(redesignSource, /\/strategy-research/);
  assert.match(redesignSource, /과거 데이터로 설정별 결과를 비교한 자료입니다\. 실제 주문을 내거나 실거래 조건을 바꾸지는 않습니다/);
  assert.match(redesignSource, /과거 데이터로 설정별 결과를 비교한 자료입니다/);
  assert.match(redesignSource, /실제 주문을 내거나 실거래 조건을 바꾸지는 않습니다/);
  assert.match(indexSource, /pilot-redesign-root/);
});

test('모의투자 현황은 연구 원자료를 사용자 화면에 렌더하지 않는다', () => {
  const render = redesignSource.split('function renderMomentumShadow() {')[1]?.split('function renderAll() {')[0];
  assert.ok(render);
  assert.match(render, /pilot-momentum-shadow-card/);
  assert.match(render, /markedEquity/);
  assert.match(render, /markedReturnPercent/);
  assert.match(render, /realizedTradeConfidence/);
  assert.match(render, /promotionBlockers/);
  assert.match(render, /observationDays/);
  assert.match(render, /비교 거래에서 보유 중인 포지션/);
  assert.match(redesignStyleSource, /\.pilot-momentum-shadow-profitability-gate span\s*\{[\s\S]*font-size:\s*11px/);
  assert.match(redesignStyleSource, /\.pilot-momentum-shadow-execution-note\s*\{/);
  assert.doesNotMatch(render, /SIGTERM|config drift|quoteQuality|paperForwardCohort|profitabilityEvidence|실거래 증거|증거 저장/);
});

test('strategy analysis mounts the existing historical-research and read-only shadow P&L renderers', () => {
  const mount = redesignSource.split('function mountPageEnhancements() {')[1]?.split('renderShell();')[0];
  assert.ok(mount);
  assert.match(mount, /pilot-strategy-research-panel/);
  assert.match(mount, /id="pilot-strategy-research"/);
  assert.match(mount, /id="pilot-strategy-research-meta"/);
  assert.match(mount, /pilot-momentum-shadow-panel/);
  assert.match(mount, /id="pilot-momentum-shadow"/);
  assert.match(mount, /id="pilot-momentum-shadow-meta"/);
  assert.match(mount, /actual fill|실제 fill|실제 체결/);
});

test('shadow P&L UI separates full-cohort quote cost from matched-only cost scenarios', () => {
  const renderer = redesignSource.split('function renderMomentumShadow() {')[1]?.split('function renderAll() {')[0];
  assert.ok(renderer);
  assert.match(renderer, /book\.tradeCostAudit/);
  assert.match(renderer, /book\.entryCostFloor/);
  assert.match(renderer, /entryCostFloor\.runtimeGuardActive/);
  assert.match(renderer, /entryCostFloor\.blockedPendingEntries/);
  assert.match(renderer, /대기 주문 .*건을 막았습니다/);
  assert.match(renderer, /이전 실행 기록 · 비용 하한 미달 · 차단 조건 적용 여부 확인 불가/);
  assert.match(renderer, /보유 중인 자산 감시는 계속합니다/);
  assert.match(renderer, /book\.profitConcentration/);
  assert.match(renderer, /수익 상위 거래 비중/);
  assert.match(renderer, /최대 승리 1건 제외: 95% 신뢰 구간 하한/);
  assert.match(renderer, /결과 확인용이며 실거래 적용 기준은 아님/);
  assert.match(renderer, /book\.observedDrawdown/);
  assert.match(renderer, /observedMddSampleCount/);
  assert.match(renderer, /riskControls\.drawdownPercent/);
  assert.match(renderer, /riskControls\.maxPortfolioDrawdownPercent/);
  assert.match(renderer, /현재 최대 낙폭/);
  assert.match(renderer, /전체 관측 최대 낙폭/);
  assert.match(renderer, /장중 최고점은 포함하지 않음/);
  assert.match(renderer, /book\.executionModel === ['"]candle_close['"]/);
  assert.match(renderer, /expandedCostAuditBooks/);
  assert.match(renderer, /dataset\.shadowAuditBook/);
  assert.match(renderer, /data-shadow-audit-book=/);
  assert.match(renderer, /costAuditOpen/);
  assert.match(renderer, /quoteMatchedTradeCount/);
  assert.match(renderer, /unmatchedSpreadCostTradeCount/);
  assert.match(renderer, /full\.quoteSpreadAdjustedMedianScenarioNetPnlKrw/);
  assert.match(renderer, /full\.costFloorStressNetPnlKrw/);
  assert.match(renderer, /호가 자료가 없는 거래의 비용은 0으로 계산하지 않았습니다/);
  assert.doesNotMatch(renderer, /executeTrade\(|data-pilot-action=/);
  assert.match(redesignStyleSource, /\.pilot-momentum-shadow-cost-audit\s*\{/);
  assert.match(redesignStyleSource, /\.pilot-momentum-shadow-cost-grid\s*\{/);
  assert.match(redesignStyleSource, /@media\s*\(max-width:\s*480px\)[\s\S]*\.pilot-momentum-shadow-cost-grid/);
});

test('AI 자문 화면은 저장 파일명과 CLI 구현 방식을 설명하지 않는다', () => {
  const shell = redesignSource.split('function aiDeskMarkup() {')[1]?.split('function mountAiDesk() {')[0];
  assert.ok(shell);
  assert.doesNotMatch(shell, /ai_monitoring_sessions\.json|Codex CLI|Claude CLI|API key 미사용|snapshot을 보냅니다|provider 상태/);
  assert.match(shell, /이 의견은 자동매매 주문에 반영되지 않습니다/);
  assert.doesNotMatch(shell, /pilot-ai-policy-badge|주문 실행 없음/);
});

test('가상 계좌 초기화 확인은 금액과 삭제 범위를 자연스럽게 설명한다', () => {
  const resetWallet = redesignSource.split('async function resetWallet() {')[1]?.split('async function startPaper(')[0];
  const startPaper = redesignSource.split('async function startPaper(')[1]?.split('async function stopPaper()')[0];
  assert.ok(resetWallet && startPaper);
  assert.match(resetWallet, /모의 계좌를 얼마로 다시 시작할까요/);
  assert.match(resetWallet, /모의 계좌를 \$\{formatWon\(seed\)\}으로 다시 시작할까요\?\\n/);
  assert.match(startPaper, /저장된 초기 금액/);
  assert.match(startPaper, /\$\{startingAmount\}으로 새 모의투자를 시작할까요\?\\n/);
  assert.match(resetWallet + startPaper, /보유 코인과 전략별 포지션·매매 기록은 사라집니다/);
});

test('준비 현황은 실전 상태와 별도로 read-only quote-cost evidence를 표시한다', () => {
  const history = redesignSource.split('data-pilot-page="history"')[1]?.split('function mountPageEnhancements()')[0];
  const paper = redesignSource.split('function renderPaperDetail() {')[1]?.split('function renderSettings() {')[0];
  assert.ok(history && paper);
  assert.match(history, /pilot-validation-detail/);
  assert.match(history, /pilot-paper-detail/);
  assert.match(history, /pilot-quote-cost-detail/);
  assert.doesNotMatch(history, /pilot-strategy-research-panel|pilot-momentum-shadow-panel|pilot-optimization-history|pilot-backtest-results/);
  assert.match(paper, /riskMonitor\?\.failClosed/);
  assert.match(paper, /평가 수익률/);
  assert.match(paper, /평가 자산·수익률에는 미청산 포지션 평가손익이 포함됩니다/);
  assert.match(paper, /openPositionMarkNote/);
  assert.match(paper, /openCount > 0/);
  assert.match(paper, /strictEvaluation\?\.signalWindowCoverage/);
  assert.match(paper, /고유 신호 시점/);
  assert.match(paper, /같은 시점 추가/);
  assert.ok(redesignStyleSource.includes('.pilot-paper-mark-note {'));
  assert.match(paper, /riskMonitor\.watchdogTelemetryVersion/);
  assert.match(paper, /위험 점검 사이 최대 간격/);
  assert.match(paper, /signalAvailability\?\.signalFunnel/);
  assert.match(paper, /signalTelemetry\?\.available === true/);
  assert.match(paper, /완료된 캔들 기준 집계 · 참고용/);
  assert.match(paper, /\['확정', signalFunnel\.confirmedWindows\]/);
  assert.match(paper, /이 수치에 따라 조건을 자동으로 낮추지 않습니다/);
  assert.ok(redesignStyleSource.includes('.pilot-paper-signal-funnel-steps {'));
  assert.ok(redesignStyleSource.includes('grid-template-columns: repeat(5, minmax(0, 1fr));'));
  assert.match(redesignStyleSource, /@media \(max-width: 480px\) \{[\s\S]*?\.pilot-paper-signal-funnel-steps \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.ok(redesignStyleSource.includes('.pilot-paper-signal-step {'));
  assert.ok(redesignStyleSource.includes('min-width: 0;'));
  assert.match(paper, /analysisDataHealth\?\.failClosed/);
  assert.match(paper, /strictExecutionCostAudit/);
  assert.match(paper, /실제 체결 결과와 호가 차이는 확인되지 않았습니다/);
  assert.match(paper, /breakEvenAdditionalSlippagePerSidePercent/);
  assert.match(paper, /기록 손익이 0이 되는 추가 가격 차이/);
  assert.match(paper, /paperForwardCohort/);
  assert.match(paper, /profitabilityEvidenceProfit/);
  assert.match(paper, /수익성 검증에 포함된 실행/);
  assert.match(paper, /아직 비교 기준을 모두 통과한 실행이 없습니다/);
  assert.doesNotMatch(paper, /필요한 거래 비용 조건을 충족한 실행이 없습니다/);
  assert.doesNotMatch(paper, /거래 비용 조건 충족 실행/);
  assert.equal(paper.includes('cohortSessionCount}회}`'), false);
  assert.equal(paper.includes('cohortEligibleSessions}회}`'), false);
  assert.match(paper, /초기화하면 가상 잔액과 보유 코인, 전략별 포지션·매매 기록이 삭제됩니다/);
  assert.doesNotMatch(paper, /MFE|MAE|counterfactual|signal evidence|wallet settlement/);
});

test('paper 세션 미지원·오류 상태는 빈 세션으로 취급하지 않고 초기화 버튼도 숨긴다', () => {
  assert.equal(typeof classifyPaperStatus, 'function');
  assert.deepEqual(classifyPaperStatus({ available: false, reason: 'paper_validation_session_not_started' }), {
    notStarted: true,
    knownStatus: true
  });
  for (const status of [
    null,
    { available: false, reason: 'unsupported' },
    { available: false, error: 'paper status unavailable' },
    { available: false }
  ]) {
    assert.deepEqual(classifyPaperStatus(status), { notStarted: false, knownStatus: false });
  }
  assert.deepEqual(classifyPaperStatus({ available: true, active: false }), {
    notStarted: false,
    knownStatus: true
  });

  const paperRenderer = redesignSource.split('function renderPaperDetail() {')[1]?.split('function renderSettings() {')[0];
  assert.ok(paperRenderer);
  const unknownBranch = paperRenderer.split('if (!knownStatus) {')[1]?.split('const stateLabel')[0];
  assert.ok(unknownBranch);
  assert.doesNotMatch(unknownBranch, /data-pilot-action="start-paper-reset"/);
});

test('전략 점검 상세는 신선도와 gate 적용 여부를 별도로 표시한다', () => {
  const validation = redesignSource.split('function renderValidationDetail() {')[1]?.split('function renderPaperDetail() {')[0];
  const audit = redesignSource.split('function renderGateAuditDetails(readiness) {')[1]?.split('function renderValidationDetail() {')[0];
  assert.ok(validation && audit);
  assert.match(validation, /classifyReadiness\(readiness\)/);
  assert.match(validation, /마지막 점검/);
  assert.match(validation, /renderGateAuditDetails\(readiness\)/);
  assert.match(audit, /<dt>작성 시점<\/dt>/);
  assert.match(audit, /실제 주문 조건 확인/);
  assert.match(audit, /작성 시점 반영 여부/);
  assert.match(audit, /현재 거래 모드/);
  assert.match(redesignStyleSource, /\.pilot-validation-audit-grid\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test('quote cost research UI separates fresh quote samples, modeled cost, and insufficient depth history', () => {
  const renderer = redesignSource.split('function renderQuoteExecutionEvidence() {')[1]?.split('function renderStrategyResearch() {')[0];
  assert.ok(renderer);
  assert.match(renderer, /state\.momentumShadow\?\.quoteQualitySnapshot/);
  assert.match(renderer, /snapshot\.complete === true/);
  assert.match(renderer, /snapshot\.fresh === true/);
  assert.match(renderer, /costCompatibility/);
  assert.match(renderer, /allObservedMarketCostCompatibility/);
  assert.match(renderer, /cadence\.expectedIntervalSeconds/);
  assert.match(renderer, /cadence\.freshnessLimitSeconds/);
  assert.match(renderer, /cadence\.gapsOverFreshnessLimit/);
  assert.match(renderer, /assumedRoundTripCostPercent/);
  assert.match(renderer, /row\?\.topOfBookDepth/);
  assert.match(renderer, /minimumBidNotionalKrw/);
  assert.match(renderer, /매수 잔량 하위 5% 기준/);
  assert.match(renderer, /양쪽 호가 잔량/);
  assert.match(renderer, /확인 필요/);
  assert.match(renderer, /호가 차이와 1단계 잔량만으로 실제 체결이나 실현 손익을 알 수 없습니다/);
  assert.match(renderer, /expandedBeforeRefresh/);
  assert.match(renderer, /disclosure\.open = true/);
  assert.doesNotMatch(renderer, /data-pilot-action=|executeTrade\(/);
  assert.match(redesignSource, /id="pilot-quote-cost-detail"/);
  assert.match(redesignSource, /호가와 거래 비용/);
  assert.match(redesignStyleSource, /\.pilot-quote-cost-overview/);
  assert.match(redesignStyleSource, /\.pilot-quote-cost-market-grid/);
  assert.match(redesignStyleSource, /@media\s*\(max-width:\s*480px\)[\s\S]*\.pilot-quote-cost-market-grid/);
});

test('quote-cost panel shows the separate paper candidate preflight and its modeled round-trip cost', () => {
  const renderer = redesignSource.split('function renderQuoteExecutionEvidence() {')[1]?.split('function renderStrategyResearch() {')[0];
  assert.ok(renderer);
  const unavailableReportBranch = renderer.split('if (!snapshot || snapshot.available !== true)')[1]?.split('const compatibility =')[0];
  assert.ok(unavailableReportBranch);
  assert.match(unavailableReportBranch, /candidatePreflightHtml/);
  assert.match(unavailableReportBranch, /cadenceHistorySummary/);
  assert.match(renderer, /state\.momentumShadow\?\.candidateReadiness/);
  assert.match(renderer, /candidateReadiness\?\.executionCost/);
  assert.match(renderer, /candidate_cost_below_round_trip_cost_floor/);
  assert.match(renderer, /executionCost\.candidateRoundTripCostPercent/);
  assert.match(renderer, /executionCost\.requiredRoundTripCostPercent/);
  assert.match(renderer, /비교 실행 조건/);
  assert.match(renderer, /왕복 비용 가정/);
  assert.match(renderer, /왕복 거래 비용 가정이 최소 기준에 못 미칩니다/);
  assert.match(renderer, /quote_quality_report_missing/);
  assert.match(renderer, /quote_quality_samples_incomplete/);
  assert.match(renderer, /최근 호가 자료가 없어 비교를 시작하지 않습니다/);
  assert.match(renderer, /호가 수집이 완료되지 않아 비교를 시작하지 않습니다/);
  assert.match(renderer, /history\.oldestGeneratedAt/);
  assert.match(renderer, /history\.latestGeneratedAt/);
  assert.match(renderer, /cadence\.maxGapSeconds/);
  assert.match(renderer, /최장 간격/);
  assert.match(redesignStyleSource, /\.pilot-quote-cost-preflight\.is-blocked/);
  assert.match(redesignStyleSource, /@media\s*\(max-width:\s*480px\)[\s\S]*\.pilot-quote-cost-preflight/);
});

test('quote-cost panel exposes all candidate preflight variants in a mobile-safe disclosure', () => {
  const renderer = redesignSource.split('function renderQuoteExecutionEvidence() {')[1]?.split('function renderStrategyResearch() {')[0];
  assert.ok(renderer);
  assert.match(renderer, /expandedCandidatesBeforeRefresh/);
  assert.match(renderer, /candidateReadinessVariants/);
  assert.match(renderer, /readinessVariants\.map/);
  assert.match(renderer, /모의투자 조건별 사전 확인/);
  assert.match(renderer, /costValue/);
  assert.match(renderer, /launchAllowed/);
  assert.match(renderer, /실제 주문·체결이나 수익을 보장하지 않습니다/);
  assert.match(renderer, /pilot-quote-cost-candidates/);
  assert.match(redesignStyleSource, /\.pilot-quote-cost-candidate-grid/);
  assert.match(redesignStyleSource, /@media\s*\(max-width:\s*480px\)[\s\S]*\.pilot-quote-cost-candidate-grid/);
});
