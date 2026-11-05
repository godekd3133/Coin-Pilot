// Order, wallet and data-integrity guarantees of the web shell. These were
// asserted against the legacy pilot-redesign.js bundle; they now run against
// the ES modules under public/app/ that replaced it, unchanged in intent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  createPendingMutationClient,
  PENDING_MUTATION_ENDPOINTS,
  protectedMutationError as protectedError
} from '../public/app/core/mutations.js';
import * as format from '../public/app/core/format.js';
import {
  isCoreTradingSnapshotReady,
  marketQuoteFreshnessIssue as freshnessIssue,
  normalizeMarketPriceSnapshot,
  buildLegacyMarketPriceSnapshot,
  fetchMarketSnapshot,
  marketSnapshotPresentation as snapshotPresentation,
  marketRowQuotePresentation as rowQuotePresentation,
  getDisplayedCandles,
  manualOrderCapacityPresentation,
  runtimeCanAcceptOrders,
  runtimeCanAcceptManualOrders,
  modeBannerPresentation
} from '../public/app/domain/trading.js';
import { portfolioAllocationPresentation } from '../public/app/domain/portfolio.js';
import { classifyReadiness } from '../public/app/domain/readiness.js';
import { toUserText } from '../public/app/domain/text.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = file => fs.readFileSync(path.join(projectRoot, file), 'utf8');
const listFiles = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => (entry.isDirectory() ? listFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));

function createMemoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    values
  };
}

const testMutationKey = '00000000-0000-4000-8000-000000000001';

// Adapters keep the legacy call shapes so the scenarios below stay verbatim.
const formatMarketTimestamp = format.marketTimestamp;
const formatOptionalPercent = format.percent;
const getModeBannerPresentation = modeBannerPresentation;
const marketQuoteFreshnessIssue = (market, now = Date.now()) => freshnessIssue(market, { now });
const lastGoodMarketQuoteFreshnessIssue = (market, now = Date.now()) => freshnessIssue(market, { now, snapshotSource: 'last_good' });
const marketSnapshotPresentation = (snapshot, loaded, prices, now) => snapshotPresentation(snapshot, loaded, prices, now === undefined ? {} : { now });
const marketRowQuotePresentation = (market, loaded, now) => rowQuotePresentation(market, loaded, now === undefined ? {} : { now });
const protectedMutationError = (outcome, fallback) => protectedError(outcome, fallback, { toUserText, symbolOf: format.symbolOf });
const loadLegacyMarketSnapshotOn404 = (error, targetCoins, requestJSON) => fetchMarketSnapshot({
  get: async route => {
    if (route === '/market/prices/snapshot') throw error;
    if (route === '/target-coins') return targetCoins;
    return requestJSON(route);
  }
});

test('pending mutation endpoints are exactly the manual order and virtual wallet routes', () => {
  assert.deepEqual([...PENDING_MUTATION_ENDPOINTS].sort(), [
    '/trade/buy', '/trade/execute', '/trade/execute-bundle', '/trade/sell', '/trade/smart-buy', '/trade/smart-sell',
    '/virtual/deposit', '/virtual/reset', '/virtual/withdraw'
  ]);
});

test('변경 요청은 전송 전에 정확한 경로·본문·UUID를 저장하고 같은 키 헤더를 보낸다', async () => {
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
  assert.deepEqual(sentRequest, { endpoint: '/virtual/deposit', idempotencyKey: testMutationKey, body: '{"amount":12000}' });
  assert.equal(storage.getItem('coinpilot.pending-mutation.v1'), null);
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
  assert.match(staleTrade, /체결 시각 오래됨/);
  assert.match(futureTrade, /현재보다 앞섬/);
  assert.equal(oldFetchFreshSource, null,
    'A cached fetch time alone must not contradict the server fresh-ticker admission policy.');
  assert.match(serverMarkedUnverified, /최신 여부 확인 불가/);
  assert.match(lastGoodMarketQuoteFreshnessIssue({
    price: 100,
    sourceAsOf: new Date(now - 1_000).toISOString(),
    fetchedAt: new Date(now - 2_000).toISOString(),
    quoteFresh: false
  }, now), /저장된 이전 시세/);
  assert.match(marketQuoteFreshnessIssue({
    price: 100,
    sourceAsOf: new Date(now - 1_000).toISOString(),
    quoteFresh: false,
    quoteFreshnessReason: 'market_snapshot_last_good'
  }, now), /저장된 이전 시세/);
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
  assert.match(message, /최신 시세 확인 후 재시도/);

});

test('PWA reads explicit price snapshot metadata and presents complete, partial, and unavailable states', () => {
  assert.equal(typeof normalizeMarketPriceSnapshot, 'function');
  assert.equal(typeof marketSnapshotPresentation, 'function');
  // A freshly traded row: the per-row quote-age check is covered separately.
  const rows = [{ coin: 'KRW-BTC', price: 100, sourceAsOf: new Date().toISOString() }];
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
  assert.equal(completePresentation.label, '전체 시장 시세 확인됨');
  assert.match(completePresentation.detail, /시장 목록 확인됨/);

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
  assert.match(partialPresentation.detail, /시장 목록 갱신 필요/);
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
  assert.match(lastGoodPresentation.label, /저장된 이전 시세/);

  assert.equal(normalizeMarketPriceSnapshot({ complete: true }), null);
  const unavailablePresentation = marketSnapshotPresentation(null, false, []);
  assert.equal(unavailablePresentation.state, 'unavailable');
  assert.match(unavailablePresentation.label, /시세를 불러오지 못했습니다/);
  assert.match(unavailablePresentation.detail, /시장 목록 확인 불가/);

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
  assert.match(legacyPresentation.detail, /시장 목록 확인됨/);

  const unverifiedSnapshot = buildLegacyMarketPriceSnapshot(legacyPrices, null);
  const unverifiedPresentation = marketSnapshotPresentation(
    normalizeMarketPriceSnapshot(unverifiedSnapshot), true, unverifiedSnapshot.prices
  );
  assert.equal(unverifiedSnapshot.complete, null);
  assert.equal(unverifiedSnapshot.marketListStale, null);
  assert.equal(unverifiedSnapshot.marketListFetchedAt, null);
  assert.equal(unverifiedPresentation.state, 'unavailable');
  assert.match(unverifiedPresentation.detail, /시장 목록 확인 불가/);
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

test('runtime entry gate blocks stopped and protective-only modes but allows normal running mode', () => {
  assert.equal(typeof runtimeCanAcceptOrders, 'function');
  assert.equal(runtimeCanAcceptOrders({ isRunning: true, runtimeState: 'RUNNING', entriesPaused: false }), true);
  assert.equal(runtimeCanAcceptOrders({ isRunning: false, runtimeState: 'PROTECTIVE_ONLY', entriesPaused: true }), false);
  assert.equal(runtimeCanAcceptOrders({ isRunning: true, runtimeState: 'SYNC_REQUIRED', entriesPaused: true, exchangeStateKnown: false }), false);
  assert.equal(runtimeCanAcceptOrders({ isRunning: true, runtimeState: 'RUNNING', entriesPaused: false, exchangeStateKnown: false }), false);
  assert.equal(runtimeCanAcceptOrders({ isRunning: false, runtimeState: 'STOPPED', entriesPaused: true }), false);
  assert.equal(runtimeCanAcceptOrders({ isRunning: true, runtimeState: 'RUNNING', entriesPaused: true }), false);
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
  assert.match(operatorStoppedLive.copy, /수동 주문 가능/);
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
  assert.deepEqual(settingsMismatch.reasons, ['점검 당시 설정과 다름 · 현재 설정으로 재점검 필요.']);

  const optionalPerformance = classifyReadiness({
    source: 'configured_scalping_validation_report',
    status: 'NOT_REQUIRED',
    decisionMeaning: 'performance_validation_optional',
    currentEvidence: false,
    liveGate: { checked: false, passed: null, enforced: false, enforcedFreshness: false }
  });
  assert.equal(optionalPerformance.stateLabel, '선택 사항');
  assert.equal(optionalPerformance.ready, false, 'optional performance must not claim evidence passed');
  assert.equal(optionalPerformance.blocked, false);
  assert.equal(optionalPerformance.currentEvidence, false);
  assert.deepEqual(optionalPerformance.reasons, []);

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
  assert.deepEqual(validationBypass.reasons, ['실전 스캘핑은 점검 생략 불가 · 설정 확인 필요.']);
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
  // Zero is neutral in the new shell (no sign, no up/down colour), but it is still a value.
  assert.equal(formatOptionalPercent(0), '0.00%');
  assert.equal(formatOptionalPercent('0.3'), '+0.30%');
  assert.equal(formatOptionalPercent('abc'), '—');
});


// ------------------------------------------------------------------ transport, banner and scope

test('mutation transport sends the stored key as Idempotency-Key and reads Idempotency-Status', async () => {
  const { createManualMutationTransport, createManualMutationKey } = await import('../public/app/core/mutations.js');
  const calls = [];
  const send = createManualMutationTransport({
    fetchImpl: async (url, init) => {
      calls.push([url, init]);
      return { status: 409, headers: { get: name => (name === 'Idempotency-Status' ? 'completed' : null) }, json: async () => ({ success: false }) };
    },
    setTimer: () => 1,
    clearTimer() {}
  });
  const outcome = await send({ endpoint: '/trade/buy', idempotencyKey: testMutationKey, body: '{"coin":"KRW-BTC","amount":10000}' });
  assert.equal(calls[0][0], '/api/trade/buy');
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].headers['Idempotency-Key'], testMutationKey);
  assert.equal(calls[0][1].body, '{"coin":"KRW-BTC","amount":10000}');
  assert.deepEqual(outcome, { status: 409, body: { success: false }, parsed: true, idempotencyStatus: 'completed' });

  const unparsable = await createManualMutationTransport({
    fetchImpl: async () => ({ status: 200, headers: { get: () => null }, json: async () => { throw new SyntaxError('html'); } }),
    setTimer: () => 1,
    clearTimer() {}
  })({ endpoint: '/trade/sell', idempotencyKey: testMutationKey, body: '{}' });
  assert.equal(unparsable.parsed, false, 'a 200 proxy page is not a confirmed result');

  let fetched = 0;
  const denied = await createManualMutationTransport({
    fetchImpl: async () => { fetched += 1; },
    isAllowed: () => false,
    deniedMessage: () => '읽기 전용'
  })({ endpoint: '/virtual/deposit', idempotencyKey: testMutationKey, body: '{}' });
  assert.equal(fetched, 0, 'scope-denied mutations never reach the network');
  assert.equal(denied.status, 403);

  const key = createManualMutationKey({ getRandomValues: bytes => bytes.fill(0xab) });
  assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.throws(() => createManualMutationKey({}), /Secure random/);
});

test('conflict and missing-key banners require resolution and do not show ordinary retry', async () => {
  const { pendingMutationPresentation } = await import('../public/app/core/mutations.js');
  for (const lastOutcome of ['conflict', 'key_missing']) {
    const view = pendingMutationPresentation({ locked: true, intent: { endpoint: '/trade/buy', lastOutcome } });
    assert.equal(view.visible, true);
    assert.equal(view.resolutionRequired, true);
    assert.equal(view.retryVisible, false);
  }
  assert.match(pendingMutationPresentation({ locked: true, intent: { lastOutcome: 'conflict' } }).copy, /운영자 확인이 필요합니다/);
  assert.match(pendingMutationPresentation({ locked: true, intent: { lastOutcome: 'key_missing' } }).copy, /서버 설정을 확인할 때까지 새 주문과 지갑 변경을 잠갔습니다/);
  const unknown = pendingMutationPresentation({ locked: true, intent: { endpoint: '/virtual/reset', lastOutcome: 'unknown' } }, { online: false });
  assert.equal(unknown.retryVisible, true);
  assert.equal(unknown.retryDisabled, true, 'offline retry stays disabled');
  assert.match(unknown.title, /가상 지갑 변경/);
  assert.equal(pendingMutationPresentation({ locked: false, intent: null }).visible, false);
  assert.match(pendingMutationPresentation({ locked: true, storageError: 'invalid' }).title, /읽을 수 없습니다/);
});

test('read_only and mobile tokens are refused locally before fetch; unresolved auth fails closed', async () => {
  const { requestAllowed, canMutate, mutationBlockReason } = await import('../public/app/core/authPolicy.js');
  const readOnly = { authRequired: true, tokenScope: 'read_only', authenticated: true, resolved: true, verification: 'verified' };
  assert.equal(requestAllowed(readOnly, 'POST', '/trade/buy'), false);
  assert.equal(requestAllowed(readOnly, 'POST', '/ai/sessions'), false);
  assert.equal(requestAllowed(readOnly, 'GET', '/all-coin-scores?limit=60'), false);
  assert.equal(requestAllowed(readOnly, 'GET', '/account'), true);
  assert.equal(requestAllowed(readOnly, 'GET', '/portfolio/history?period=7d'), true);
  assert.equal(requestAllowed(readOnly, 'GET', '/portfolio/history?period=all'), false);
  assert.equal(canMutate(readOnly), false);
  assert.match(mutationBlockReason(readOnly), /읽기 전용/);

  const mobile = { ...readOnly, tokenScope: 'mobile_operator' };
  assert.equal(requestAllowed(mobile, 'GET', '/status'), false, 'native-only tokens are not a web session');
  assert.equal(canMutate(mobile), false);

  const operator = { ...readOnly, tokenScope: 'operator' };
  assert.equal(requestAllowed(operator, 'POST', '/trade/buy'), true);
  assert.equal(canMutate(operator), true);
  assert.equal(canMutate(operator, { readOnlyObserver: true }), false);

  assert.equal(requestAllowed({ authRequired: true, resolved: false }, 'GET', '/status'), false);
  assert.equal(canMutate({ authRequired: true, resolved: true, verification: 'unavailable', tokenScope: 'operator' }), false);
  assert.equal(canMutate({ authRequired: false, resolved: true, verification: 'not-required' }), true);
});

// ------------------------------------------------------------------ portfolios, stocks

test('horizon sleeves come from the server response, including research verdicts and unknown sleeves', async () => {
  const { horizonSleeves, horizonRuntimeSummary } = await import('../public/app/domain/horizons.js');
  const sleeves = horizonSleeves({
    sleeves: {
      short: { label: '단기', enabled: true, weight: 0.4, positions: 1 },
      swing: { label: '스윙', enabled: false, weight: 0 }
    },
    research: { sleeves: [
      { horizon: 'short', passed: true, outOfSampleReturnPercent: 4.2, worstDrawdownPercent: -6 },
      { horizon: 'swing', passed: false, outOfSampleReturnPercent: -1.5 },
      { horizon: 'quarterly', passed: false }
    ] },
    positions: [{ sleeve: 'short', unrealizedProfit: 1200 }]
  });
  assert.deepEqual(sleeves.map(sleeve => sleeve.key), ['short', 'swing', 'quarterly'], 'a sleeve added by the server appears without a UI change');
  assert.equal(sleeves[0].verdict.passed, true);
  assert.equal(sleeves[0].unrealizedProfit, 1200);
  assert.equal(sleeves[1].verdict.passed, false);
  assert.equal(sleeves[1].weight, 0);
  assert.equal(sleeves[2].label, 'quarterly');
  assert.equal(sleeves[2].weight, null, 'a missing weight is unknown, not zero');
  assert.deepEqual(horizonSleeves(null), []);
  assert.equal(typeof horizonRuntimeSummary, 'function');
});

test('LIVE workspace totals never count coin-horizon holdings twice', async () => {
  const { workspaceAssetParts, combinedAssets } = await import('../public/app/domain/portfolio.js');
  const account = { totalAssets: 1_000_000 };
  const horizons = { coin: { totalAssets: 300_000 }, stock: { paper: { totalAssets: 50_000 } } };
  const live = workspaceAssetParts({ mode: 'LIVE', account, stocks: null, horizons });
  assert.deepEqual(live.map(part => part.id), ['coin'], 'exchange totalAssets already holds the horizon coins in LIVE');
  assert.equal(combinedAssets(live).total, 1_000_000);
  const paper = workspaceAssetParts({ mode: 'DRY_RUN', account, stocks: { enabled: true, paper: { totalAssets: 200_000 } }, horizons });
  assert.deepEqual(paper.map(part => part.id), ['coin', 'stock', 'horizon-coin', 'horizon-stock'], 'paper engines keep separate ledgers');
  assert.equal(combinedAssets(paper).total, 1_550_000);
  const unknown = combinedAssets(workspaceAssetParts({ mode: 'DRY_RUN', account: { totalAssets: null }, stocks: null, horizons: null }));
  assert.equal(unknown.total, null, 'an unknown part never produces a fabricated total');
  assert.equal(unknown.partial, true);
});

test('stock session labels and paper reset follow the server state', async () => {
  const { marketSessionPresentation, stockPaperResetAllowed, stockTraderSummary } = await import('../public/app/domain/stocks.js');
  assert.equal(marketSessionPresentation(null).label, '장 상태 확인 전');
  assert.equal(marketSessionPresentation({ open: true, canEnter: true, reason: 'regular_session' }).tone, 'ok');
  assert.equal(marketSessionPresentation({ open: true, mustFlatten: true, reason: 'flatten_before_close' }).label, '마감 전 보유 종목 정리 중');
  const summary = stockTraderSummary({ mode: 'paper', running: false, positions: [{ symbol: '005930' }] });
  assert.equal(stockPaperResetAllowed(summary), false, 'reset is refused while positions are open');
  assert.equal(stockPaperResetAllowed(stockTraderSummary({ mode: 'paper', running: false, positions: [] })), true);
  assert.equal(stockPaperResetAllowed(stockTraderSummary({ mode: 'live', running: false, positions: [] })), false);
});

// ------------------------------------------------------------------ service worker & manifest

const serviceWorkerSource = readSource('public/sw.js');

test('service worker does not replace failed third-party requests with the local HTML shell', () => {
  const handlers = {};
  vm.runInNewContext(serviceWorkerSource, {
    URL,
    self: { location: { origin: 'https://coinpilot.example' }, registration: { scope: 'https://coinpilot.example/' }, addEventListener(name, handler) { handlers[name] = handler; } }
  });
  for (const url of ['https://cdn.example.net/style.css', 'https://coinpilot.example/api/account']) {
    let intercepted = false;
    handlers.fetch({ request: { method: 'GET', url }, respondWith() { intercepted = true; } });
    assert.equal(intercepted, false, `${url} must pass through`);
  }
  let intercepted = false;
  handlers.fetch({ request: { method: 'POST', url: 'https://coinpilot.example/app/main.js' }, respondWith() { intercepted = true; } });
  assert.equal(intercepted, false, 'non-GET requests are never served from cache');
});

function loadServiceWorker(scope) {
  const handlers = {};
  vm.runInNewContext(serviceWorkerSource, {
    URL,
    Response: { error: () => null },
    fetch: () => new Promise(() => {}),
    caches: { match: () => new Promise(() => {}), open: () => new Promise(() => {}) },
    self: { location: { origin: 'https://coinpilot.example' }, registration: { scope }, addEventListener(name, handler) { handlers[name] = handler; } }
  });
  return url => {
    let intercepted = false;
    handlers.fetch({ request: { method: 'GET', url, mode: 'no-cors' }, respondWith() { intercepted = true; } });
    return intercepted;
  };
}

test('paper and LIVE service workers on one origin only answer their own shell files', () => {
  const root = loadServiceWorker('https://coinpilot.example/');
  const live = loadServiceWorker('https://coinpilot.example/live/');
  // The root (paper) worker's scope also covers /live/, so it must pass LIVE traffic through.
  for (const url of ['/live/', '/live/api/account', '/live/app/main.js', '/live/socket.io/?EIO=4', '/api/account', '/socket.io/?EIO=4']) {
    assert.equal(root(`https://coinpilot.example${url}`), false, `root worker must not answer ${url}`);
  }
  for (const url of ['/', '/app/main.js', '/auth-client.js']) assert.equal(root(`https://coinpilot.example${url}`), true, `root worker serves ${url}`);
  for (const url of ['/live/api/account', '/live/socket.io/?EIO=4', '/app/main.js', '/']) {
    assert.equal(live(`https://coinpilot.example${url}`), false, `LIVE worker must not answer ${url}`);
  }
  for (const url of ['/live/', '/live/app/main.js', '/live/auth-client.js']) assert.equal(live(`https://coinpilot.example${url}`), true, `LIVE worker serves ${url}`);
  assert.match(serviceWorkerSource, /const CACHE_NAME = `\$\{CACHE_VERSION\}@\$\{SCOPE\}`/, 'cache names are scoped per deployment prefix');
});

test('service worker waits for the user update action before activating a replacement worker', async () => {
  const handlers = {};
  let skipWaitingCalls = 0;
  vm.runInNewContext(serviceWorkerSource, {
    URL,
    caches: { open: async () => ({ addAll: async () => {} }) },
    self: {
      location: { origin: 'https://coinpilot.example' },
      registration: { scope: 'https://coinpilot.example/' },
      addEventListener(name, handler) { handlers[name] = handler; },
      skipWaiting() { skipWaitingCalls += 1; return Promise.resolve(); }
    }
  });
  let installWork;
  handlers.install({ waitUntil(promise) { installWork = promise; } });
  await installWork;
  assert.equal(skipWaitingCalls, 0, 'a new worker remains waiting after its shell is cached');
  handlers.message({ data: { type: 'SKIP_WAITING' } });
  assert.equal(skipWaitingCalls, 1, 'the explicit update action activates the waiting worker');
});

test('manifest icons and every service worker app-shell asset exist; the shell is network-first', () => {
  const manifest = JSON.parse(readSource('public/manifest.webmanifest'));
  assert.equal(manifest.display, 'standalone');
  // Relative to the manifest URL so `/live/manifest.webmanifest` scopes the LIVE install to `/live/`.
  assert.equal(manifest.scope, './');
  assert.equal(manifest.start_url, './?source=pwa');
  assert.equal(manifest.id, './?source=pwa');
  for (const icon of manifest.icons) {
    assert.ok(!icon.src.startsWith('/'), `manifest icon must be relative: ${icon.src}`);
    const file = path.join(projectRoot, 'public', icon.src);
    assert.ok(fs.existsSync(file) && fs.statSync(file).size > 0, `manifest icon missing: ${icon.src}`);
  }
  const appShell = JSON.parse(`[${serviceWorkerSource.match(/const APP_SHELL = \[([\s\S]*?)\n\]\.map\(at\);/)[1].replace(/'/g, '"')}]`);
  for (const asset of appShell) {
    assert.ok(!asset.startsWith('/'), `service worker shell entries are scope-relative: ${asset}`);
    const file = path.join(projectRoot, 'public', asset === '' ? 'index.html' : asset);
    assert.ok(fs.existsSync(file), `service worker app shell missing: ${asset}`);
  }
  for (const required of ['', 'auth-client.js', 'app/main.js', 'app/ui/tokens.css', 'app/core/mutations.js', 'app/core/base.js']) assert.ok(appShell.includes(required), required || '(scope root)');
  assert.match(serviceWorkerSource, /NETWORK_FIRST_PREFIXES = \[at\('app\/'\)\]/);
  for (const legacy of ['pilot-redesign', 'ai-desk', 'icons.css']) assert.equal(serviceWorkerSource.includes(legacy), false, `${legacy} left in the service worker`);
  const indexSource = readSource('public/index.html');
  assert.match(indexSource, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(indexSource, /apple-mobile-web-app-capable/);
  assert.match(readSource('public/app/main.js'), /navigator\.serviceWorker\.register\(`\$\{APP_BASE\}sw\.js`, \{ scope: APP_BASE \}\)/);
});

// ------------------------------------------------------------------ static order boundaries

const featureFiles = listFiles(path.join(projectRoot, 'public/app/features')).filter(file => file.endsWith('.js'));
const featureSources = Object.fromEntries(featureFiles.map(file => [path.relative(projectRoot, file), fs.readFileSync(file, 'utf8')]));

test('features never call fetch directly; protected routes only go through ctx.mutate', () => {
  for (const [file, source] of Object.entries(featureSources)) {
    assert.equal(/\bfetch\(/.test(source), false, `${file} calls fetch directly`);
    assert.equal(/ctx\.api\.post\(\s*[`'"]\/(trade|virtual)\//.test(source), false, `${file} bypasses the idempotent client`);
    assert.equal(/window\.confirm\(/.test(source), false, `${file} uses window.confirm instead of the confirmation sheet`);
  }
  const trade = featureSources['public/app/features/trade/index.js'];
  assert.match(trade, /\{ coin: selectedCoin, amount: Math\.floor\(amount\) \}/, 'buy body {coin, amount}');
  assert.match(trade, /\{ coin: selectedCoin, quantity: sellQuantity \}/, 'sell body {coin, quantity}');
  assert.match(trade, /\{ totalAmount: Math\.floor\(value\), minScore: number\(values\.minScore, 60\), maxCoins: number\(values\.maxCoins, 10\) \}/);
  assert.match(trade, /\{ targetAmount: Math\.floor\(value\), strategy: values\.strategy \|\| 'worst' \}/);
  assert.match(trade, /ctx\.mutate\('\/trade\/execute-bundle', \{ sellCoin: bundle\.sell\?\.coin, buyCoin: bundle\.buy\?\.coin \}/);
  const wallet = featureSources['public/app/features/wallet/index.js'];
  assert.match(wallet, /ctx\.mutate\(`\/virtual\/\$\{kind\}`, \{ amount: Math\.floor\(amount\) \}/);
  assert.match(wallet, /ctx\.mutate\('\/virtual\/reset', \{ seedMoney: seed \}/);
});

test('every order and wallet mutation is preceded by a confirmation; cancelling sends nothing', () => {
  for (const [file, source] of Object.entries(featureSources)) {
    const calls = [...source.matchAll(/ctx\.mutate\(/g)];
    for (const call of calls) {
      const before = source.slice(Math.max(0, call.index - 2500), call.index);
      const confirmAt = Math.max(before.lastIndexOf('ctx.confirm('), before.lastIndexOf('ctx.ui.formSheet('));
      assert.ok(confirmAt >= 0, `${file}: ctx.mutate without a preceding confirmation`);
      assert.match(before.slice(confirmAt), /if \(!(confirmed|ok|values|result)\)\s*(\{[\s\S]{0,200}?)?return;/, `${file}: cancelled confirmation must return before mutate`);
    }
  }
  const trade = featureSources['public/app/features/trade/index.js'];
  assert.match(trade, /if \(!confirmed\) \{ ctx\.ui\.toast\(`\$\{symbolOf\(selectedCoin\)\} \$\{actionText\}를 취소했습니다`, 'info'\); return; \}/);
  assert.match(trade, /live: s\.isLive/, 'LIVE confirmations are marked as real-money');
});

test('mutate refuses locked sessions and records a snapshot only after a confirmed success', () => {
  const main = readSource('public/app/main.js');
  const body = main.slice(main.indexOf('async function mutate('), main.indexOf('async function retryPendingMutation('));
  assert.match(body, /if \(!current\.canMutate\) \{ toast\(current\.mutationBlockedReason, 'warning'\); return \{ ok: false \}; \}/);
  assert.ok(body.indexOf('if (!isTerminalOutcome(outcome))') < body.indexOf('recordSnapshot()'));
  assert.ok(body.indexOf("if (result.success === false && !partial)") < body.indexOf('recordSnapshot()'),
    'a deterministic no-order response must return before the success-only snapshot write');
  assert.ok(body.indexOf("outcome.kind === 'terminal-locked'") < body.indexOf('recordSnapshot()'));
  assert.match(main, /createPendingMutationClient\(\{[\s\S]*?createManualMutationTransport\(/);
});

test('stock and engine controls run behind a confirmation sheet; LIVE shows the red 실전 marker', () => {
  const stocks = featureSources['public/app/features/stocks/index.js'];
  for (const action of ['startStock', 'stopStock', 'resetStockPaper']) {
    const at = stocks.indexOf(`api.control.${action}(`);
    assert.ok(at > 0, `${action} is wired`);
    assert.match(stocks.slice(Math.max(0, at - 1800), at), /ctx\.(confirm|ui\.formSheet)\(/, `${action} needs confirmation`);
  }
  const components = readSource('public/app/ui/components.js');
  assert.match(components, /export function liveBadge\(/);
  assert.match(components, /실전/);
  assert.match(readSource('public/app/ui/components.css'), /\.cp-badge\.is-live \{[^}]*var\(--cp-red\)/);
  const tokens = readSource('public/app/ui/tokens.css');
  assert.match(tokens, /--cp-up: #d2283c;/, 'Korean convention: up is red');
  assert.match(tokens, /--cp-down: #1b64da;/, 'Korean convention: down is blue');
});

test('web shell keeps exchange credentials out of the browser', () => {
  for (const [file, source] of Object.entries(featureSources)) {
    assert.equal(/access[_-]?key|secret[_-]?key|\/live-credentials/i.test(source), false, `${file} handles exchange credentials`);
  }
});

// ------------------------------------------------------------------ trade records (from the legacy usefulness suite)

const { tradeRecordPresentation: record, filteredTradeRecords: filterRecords } = await import('../public/app/domain/records.js');

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


test('known exit reasons use plain Korean without changing unrecognized server explanations', () => {
  assert.equal(record({ action: 'CLOSE', reason: 'TAKE_PROFIT' }).reason, '목표 수익 도달');
  assert.equal(record({ action: 'CLOSE', reason: 'STOP_LOSS' }).reason, '손절 기준 도달');
  assert.equal(record({ action: 'CLOSE', reason: '사용자가 직접 중지' }).reason, '사용자가 직접 중지');
});


test('analysis details only offer selling a coin that is actually held', () => {
  const analysis = featureSources['public/app/features/analysis/index.js'];
  assert.match(analysis, /const reviewSide = item\.recommendation === 'BUY' \? 'buy' : item\.recommendation === 'SELL' && owned \? 'sell' : null;/);
  assert.match(analysis, /side=\$\{reviewSide\}/);
});
