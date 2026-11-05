import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StockTradingService, createStockConfig } from '../src/stock/stockTradingService.js';

const OPEN = { open: true, canEnter: true, mustFlatten: false, reason: 'regular_session' };
const silent = { log() {}, warn() {}, error() {}, info() {} };

function ranking(symbol, price = 5000) {
  return { symbol, currency: 'KRW', price: { lastPrice: String(price) } };
}

function makeService({ rankings, now, candleCalls, onCandles = null }) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-service-'));
  const client = {
    credentialsConfigured: true,
    getRankings: async ({ type }) => {
      if (rankings[type] instanceof Error) throw rankings[type];
      return rankings[type] || [];
    },
    getPrices: async symbols => new Map(symbols.map(symbol => [symbol, { price: 5000 }])),
    getMinuteCandles: async symbol => {
      candleCalls.push(symbol);
      onCandles?.(symbol);
      return [];
    }
  };
  const config = createStockConfig({ STOCK_TRADING_ENABLED: true, DRY_RUN: true, COINPILOT_STATE_DIR: stateDir });
  const service = new StockTradingService(config, {
    client,
    marketSession: { getState: async () => OPEN },
    now: () => now.value,
    log: silent
  });
  const cycles = [];
  service.traders.paper.isRunning = true;
  service.traders.paper.runCycle = async (universe, shared) => { cycles.push({ universe, shared }); };
  return { service, cycles };
}

test('주식 유니버스는 여러 순위를 합쳐 중복 없이 거래대금 순서를 우선한다', async () => {
  const now = { value: Date.parse('2026-11-05T01:00:05Z') };
  const { service } = makeService({
    now,
    candleCalls: [],
    rankings: {
      MARKET_TRADING_AMOUNT: [ranking('A'), ranking('B')],
      TOSS_SECURITIES_TRADING_AMOUNT: new Error('rate limited'),
      MARKET_TRADING_VOLUME: [ranking('B'), ranking('C'), ranking('CHEAP', 500)],
      TOP_LOSERS: [ranking('D')],
      TOP_GAINERS: [ranking('A'), ranking('E')]
    }
  });
  service.traders.paper.availableCash = async () => 100000;
  assert.deepEqual(await service.refreshUniverse({ force: true }), ['A', 'B', 'C', 'D', 'E']);
  assert.equal(createStockConfig({}).maxSymbols, 300);
});

test('1분봉은 분마다 한 번만 훑고, 스캔이 끝나기 전에는 신규 진입 후보를 넘기지 않는다', async () => {
  const now = { value: Date.parse('2026-11-05T01:00:05Z') };
  const candleCalls = [];
  const { service, cycles } = makeService({
    now,
    candleCalls,
    rankings: { MARKET_TRADING_AMOUNT: [ranking('A'), ranking('B')] }
  });
  service.traders.paper.availableCash = async () => 100000;

  await service.tick();
  // 첫 tick은 스캔을 시작만 하고, 이번 분 스냅샷이 없으므로 진입 후보가 비어 있다.
  assert.deepEqual(cycles[0].universe, []);
  await service._candleScanInFlight;
  await service._tickInFlight;
  // 스캔 완료 직후 tick이 이번 분 스냅샷으로 진입을 판단한다.
  assert.deepEqual(cycles.at(-1).universe, ['A', 'B']);
  assert.deepEqual(candleCalls, ['A', 'B']);

  now.value += 10000;
  await service.tick();
  assert.deepEqual(candleCalls, ['A', 'B'], '같은 분에는 다시 훑지 않는다');
  assert.deepEqual(cycles.at(-1).universe, ['A', 'B']);

  now.value = Date.parse('2026-11-05T01:01:02Z');
  const before = cycles.length;
  await service.tick();
  // 분이 바뀌면 이전 분 스냅샷은 진입에 쓰지 않는다.
  assert.deepEqual(cycles[before].universe, []);
  await service._candleScanInFlight;
  assert.deepEqual(candleCalls, ['A', 'B', 'A', 'B']);
});

test('다음 분으로 넘어간 1분봉 스캔 결과는 버린다', async () => {
  const now = { value: Date.parse('2026-11-05T01:00:50Z') };
  const candleCalls = [];
  const { service, cycles } = makeService({
    now,
    candleCalls,
    rankings: { MARKET_TRADING_AMOUNT: [ranking('A'), ranking('B'), ranking('C')] },
    onCandles: symbol => { if (symbol === 'A') now.value = Date.parse('2026-11-05T01:01:01Z'); }
  });
  service.traders.paper.availableCash = async () => 100000;

  await service.tick();
  await service._candleScanInFlight;
  assert.equal(service.candleSnapshot, null);
  assert.equal(service.lastCandleScan.completed, false);
  assert.deepEqual(candleCalls, ['A']);
  assert.ok(cycles.every(cycle => cycle.universe.length === 0));
});
