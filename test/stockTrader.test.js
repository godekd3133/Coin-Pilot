import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import StockTrader, { toAnalyzerCandles } from '../src/stock/stockTrader.js';
import { StockMarketSession, parseCalendarDay } from '../src/stock/stockMarketSession.js';
import { TossInvestClient } from '../src/stock/tossInvestClient.js';
import { createStockConfig } from '../src/stock/stockTradingService.js';

const OPEN_SESSION = { open: true, canEnter: true, mustFlatten: false, reason: 'regular_session' };

function tempFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-trader-'));
  return path.join(dir, name);
}

function fakeSession(state = OPEN_SESSION) {
  return { getState: async () => state };
}

function silentLog() {
  return { log() {}, warn() {}, error() {} };
}

test('toss 1분봉을 분석기 입력으로 변환하고 완료된 최신 봉 앞에 자리표시 봉을 둔다', () => {
  const now = Date.parse('2026-03-25T09:33:10+09:00');
  const candles = toAnalyzerCandles([
    { timestamp: '2026-03-25T09:32:00+09:00', openPrice: '100', highPrice: '102', lowPrice: '99', closePrice: '101', volume: '10' },
    { timestamp: '2026-03-25T09:33:00+09:00', openPrice: '101', highPrice: '103', lowPrice: '100', closePrice: '102', volume: '12' }
  ], now);
  assert.equal(candles.length, 3);
  assert.equal(candles[0].placeholder, true);
  assert.equal(candles[1].trade_price, 102);
  assert.equal(candles[2].trade_price, 101);

  const inProgress = toAnalyzerCandles([
    { timestamp: '2026-03-25T09:34:00+09:00', openPrice: '1', highPrice: '1', lowPrice: '1', closePrice: '1', volume: '1' }
  ], now);
  assert.equal(inProgress.length, 1);
  assert.equal(inProgress[0].placeholder, undefined);
});

test('소액 시드(1만원)도 1주 가격 이하 종목은 최소 1주를 매수한다', () => {
  const trader = new StockTrader({
    mode: 'paper', client: {}, marketSession: fakeSession(), log: silentLog(),
    config: { seedMoney: 10000, investmentRatio: 0.3, maxPositions: 3 }
  });
  // 비율 예산 3,000원 < 1주 8,000원이지만 현금으로 1주를 감당할 수 있다.
  assert.equal(trader.sizeEntry({ price: 8000, cash: 10000, totalAssets: 10000 }), 1);
  assert.equal(trader.sizeEntry({ price: 12000, cash: 10000, totalAssets: 10000 }), 0);
  // 5만원 시드, 2,000원 종목: 남은 슬롯 균등 예산(약 16,666원) 기준
  assert.equal(trader.sizeEntry({ price: 2000, cash: 50000, totalAssets: 50000 }), 8);
});

test('모의 매수/매도는 수수료·거래세를 반영하고 장부를 저장한다', async () => {
  const stateFile = tempFile('paper.json');
  let now = Date.parse('2026-03-25T10:00:00+09:00');
  const trader = new StockTrader({
    mode: 'paper', client: {}, marketSession: fakeSession(), stateFile, log: silentLog(), now: () => now,
    config: { seedMoney: 50000, paperSlippageRate: 0, commissionRate: 0.00015, sellTaxRate: 0.002 }
  });
  await trader.start();
  await trader.buy('000001', 5000, 'test');
  const position = trader.state.positions['000001'];
  assert.ok(position.quantity >= 1);
  const spent = 50000 - trader.state.cash;
  assert.ok(Math.abs(spent - position.quantity * 5000 * 1.00015) < 1e-6);

  now += 60000;
  const result = await trader.sell('000001', 5100, 'take');
  const expectedProfit = (5100 - 5000) * position.quantity
    - 5100 * position.quantity * (0.00015 + 0.002)
    - 5000 * position.quantity * 0.00015;
  assert.ok(Math.abs(result.profit - expectedProfit) < 1e-6);
  assert.deepEqual(trader.state.positions, {});
  assert.equal(trader.getStatistics().totalTrades, 1);

  const reloaded = new StockTrader({ mode: 'paper', client: {}, marketSession: fakeSession(), stateFile, log: silentLog() });
  assert.equal(reloaded.state.trades.length, 2);
  assert.ok(Math.abs(reloaded.state.cash - trader.state.cash) < 1e-6);
});

test('장 마감 전 정리 구간이면 보유 포지션을 전량 매도한다', async () => {
  const stateFile = tempFile('paper.json');
  const prices = new Map([['000001', { price: 5000 }]]);
  const client = { getPrices: async () => prices };
  const trader = new StockTrader({
    mode: 'paper', client, stateFile, log: silentLog(),
    marketSession: fakeSession({ open: true, canEnter: false, mustFlatten: true, reason: 'flatten_before_close' }),
    config: { seedMoney: 50000, paperSlippageRate: 0 }
  });
  await trader.start();
  await trader.buy('000001', 5000, 'test');
  await trader.runCycle([]);
  assert.deepEqual(trader.state.positions, {});
  assert.match(trader.state.trades.at(-1).reason, /장 마감/);
});

test('실전 주문 체결 확인이 실패하면 미확인 주문으로 잠그고 다음 사이클에 장부에 반영한다', async () => {
  const stateFile = tempFile('live.json');
  let failFill = true;
  const client = {
    getHoldings: async () => [],
    getCashBuyingPower: async () => 20000,
    getPrices: async () => new Map(),
    createMarketOrder: async () => ({ orderId: 'order-1' }),
    waitForOrderFill: async () => {
      if (failFill) throw new Error('network down');
      return { status: 'FILLED', filledQuantity: 2, averageFilledPrice: 5010, commission: 1.5, tax: 0 };
    }
  };
  const trader = new StockTrader({ mode: 'live', client, marketSession: fakeSession(), stateFile, log: silentLog() });
  await trader.start();
  assert.equal(trader.entriesPaused, false);

  assert.equal(await trader.buy('000001', 5000, 'signal'), null);
  assert.equal(trader.entriesPaused, true);
  assert.equal(trader.pauseReason, 'pending_order_unresolved');
  assert.ok(trader.state.pendingOrders['order-1']);

  failFill = false;
  await trader.runCycle([]);
  assert.equal(trader.state.positions['000001'].quantity, 2);
  assert.equal(trader.state.positions['000001'].entryPrice, 5010);
  assert.deepEqual(trader.state.pendingOrders, {});
  assert.equal(trader.entriesPaused, false);
});

test('실전 시작 시 계좌에 없는 장부 포지션은 제거하고, 대사 실패 시 진입을 잠근다', async () => {
  const stateFile = tempFile('live.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 1, mode: 'live', cash: null, initialSeedMoney: null, pendingOrders: {}, trades: [], desiredRunning: true,
    positions: {
      '000001': { quantity: 3, entryPrice: 1000, entryTime: '2026-03-25T01:00:00.000Z' },
      '000002': { quantity: 5, entryPrice: 2000, entryTime: '2026-03-25T01:00:00.000Z' }
    }
  }));
  const trader = new StockTrader({
    mode: 'live', stateFile, marketSession: fakeSession(), log: silentLog(),
    client: { getHoldings: async () => [{ symbol: '000002', quantity: '4' }] }
  });
  await trader.start();
  assert.deepEqual(Object.keys(trader.state.positions), ['000002']);
  assert.equal(trader.state.positions['000002'].quantity, 4);

  const failing = new StockTrader({
    mode: 'live', stateFile: tempFile('live2.json'), marketSession: fakeSession(), log: silentLog(),
    client: { getHoldings: async () => { throw new Error('403'); } }
  });
  await failing.start();
  assert.equal(failing.entriesPaused, true);
  assert.equal(failing.pauseReason, 'exchange_state_unverified');
});

test('장 운영 캘린더: 휴장일·진입 마감·전량 정리 시점을 판단한다', async () => {
  assert.equal(parseCalendarDay({ date: '2026-01-01', integrated: null }), null);
  const calendar = {
    today: {
      date: '2026-03-25',
      integrated: {
        regularMarket: {
          startTime: '2026-03-25T09:00:00+09:00',
          singlePriceAuctionStartTime: '2026-03-25T15:20:00+09:00',
          endTime: '2026-03-25T15:30:00+09:00'
        }
      }
    }
  };
  let now = Date.parse('2026-03-25T10:00:00+09:00');
  const session = new StockMarketSession({ client: { getMarketCalendarKR: async () => calendar }, now: () => now });
  assert.deepEqual((({ open, canEnter, mustFlatten }) => ({ open, canEnter, mustFlatten }))(await session.getState()),
    { open: true, canEnter: true, mustFlatten: false });
  now = Date.parse('2026-03-25T15:10:00+09:00');
  const late = await session.getState();
  assert.equal(late.canEnter, false);
  assert.equal(late.mustFlatten, true);
  now = Date.parse('2026-03-25T08:59:00+09:00');
  assert.equal((await session.getState()).open, false);
});

test('토스 클라이언트는 토큰을 캐시하고 계좌 헤더를 붙여 요청한다', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const body = url.endsWith('/oauth2/token')
      ? { access_token: 'tok', token_type: 'Bearer', expires_in: 86400 }
      : url.includes('/api/v1/accounts')
        ? { result: [{ accountNo: '1', accountSeq: 7, accountType: 'BROKERAGE' }] }
        : { result: { currency: 'KRW', cashBuyingPower: '12345' } };
    return { ok: true, status: 200, json: async () => body, headers: { get: () => null } };
  };
  const client = new TossInvestClient({ clientId: 'id', clientSecret: 'secret', fetchImpl, sleepImpl: async () => {} });
  assert.equal(await client.getCashBuyingPower(), 12345);
  assert.equal(await client.getCashBuyingPower(), 12345);
  assert.equal(calls.filter(call => call.url.endsWith('/oauth2/token')).length, 1);
  const buyingPower = calls.filter(call => call.url.includes('/buying-power'));
  assert.equal(buyingPower[0].init.headers['X-Tossinvest-Account'], '7');
  assert.equal(buyingPower[0].init.headers.Authorization, 'Bearer tok');
});

test('주식 모드 기본값은 프로세스의 코인 프로필을 따른다', () => {
  assert.deepEqual(
    (({ paperEnabled, liveEnabled }) => ({ paperEnabled, liveEnabled }))(createStockConfig({ DRY_RUN: true })),
    { paperEnabled: true, liveEnabled: false }
  );
  assert.deepEqual(
    (({ paperEnabled, liveEnabled }) => ({ paperEnabled, liveEnabled }))(createStockConfig({ DRY_RUN: false })),
    { paperEnabled: false, liveEnabled: true }
  );
});
