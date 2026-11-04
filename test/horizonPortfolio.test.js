import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeChart, aggregateWeekly, minimumBars } from '../src/portfolio/chartAnalysis.js';
import { resolveHorizonProfiles, normalizeWeights, ASSET_COSTS } from '../src/portfolio/horizonProfiles.js';
import { positionBudget, evaluateExit, volatilityAllowed } from '../src/portfolio/horizonStrategy.js';
import { runSleeveBacktest, precomputeAnalyses } from '../src/portfolio/horizonBacktest.js';
import { studySleeve, studyToOverrides } from '../src/portfolio/horizonStudy.js';
import HorizonPortfolioManager, { latestCompletedBarStart } from '../src/portfolio/horizonPortfolioManager.js';
import { PaperBroker } from '../src/portfolio/horizonBrokers.js';
import { HorizonRuntime } from '../src/portfolio/horizonService.js';
import { PortfolioValuation } from '../src/trader/portfolioValuation.js';

const HOUR = 3600 * 1000;

function trendBars(count, { start = 100, drift = 0.004, noise = 0.01, interval = 4 * HOUR, startTime = Date.UTC(2026, 0, 1), seed = 7 } = {}) {
  let price = start;
  let state = seed;
  const random = () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647 - 0.5;
  };
  const bars = [];
  for (let i = 0; i < count; i += 1) {
    const open = price;
    const close = open * (1 + drift + random() * noise);
    const high = Math.max(open, close) * (1 + Math.abs(random()) * noise * 0.5);
    const low = Math.min(open, close) * (1 - Math.abs(random()) * noise * 0.5);
    bars.push({ time: startTime + i * interval, open, high, low, close, volume: 1000 + i });
    price = close;
  }
  return bars;
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-'));
}

const silent = { log() {}, warn() {}, error() {} };

test('차트 분석: 상승 추세는 양의 점수·uptrend, 하락 추세는 음의 점수·downtrend', () => {
  const up = analyzeChart(trendBars(200, { drift: 0.006 }));
  const down = analyzeChart(trendBars(200, { drift: -0.006 }));
  assert.equal(up.available, true);
  assert.ok(up.score > 20, `up score ${up.score}`);
  assert.equal(up.regime, 'uptrend');
  assert.ok(down.score < -20, `down score ${down.score}`);
  assert.equal(down.regime, 'downtrend');
  assert.equal(analyzeChart(trendBars(20)).available, false);
});

test('minimumBars는 일부 기간만 지정해도 기본값으로 채워 계산한다', () => {
  assert.ok(Number.isFinite(minimumBars({ emaLong: 55 })));
  assert.equal(minimumBars({ emaLong: 55 }), 60);
});

test('주봉 집계는 월요일 시작 주로 OHLCV를 합친다', () => {
  const daily = trendBars(14, { interval: 24 * HOUR, startTime: Date.UTC(2026, 0, 5) }); // 2026-01-05 월요일
  const weeks = aggregateWeekly(daily);
  assert.equal(weeks.length, 2);
  assert.equal(weeks[0].open, daily[0].open);
  assert.equal(weeks[0].close, daily[6].close);
  assert.equal(weeks[0].high, Math.max(...daily.slice(0, 7).map(b => b.high)));
});

test('위험 기반 크기: 손절 시 손실이 자산의 r%가 되도록 하되 슬롯을 넘지 않는다', () => {
  assert.equal(positionBudget({ sleeveEquity: 1_000_000, maxPositions: 2, riskPerTradePercent: 0, entryPrice: 100, stopPrice: 90 }), 500_000);
  // 1% 위험 / 10% 손절거리 = 자산의 10%
  assert.equal(Math.round(positionBudget({ sleeveEquity: 1_000_000, maxPositions: 2, riskPerTradePercent: 1, entryPrice: 100, stopPrice: 90 })), 100_000);
});

test('청산 판단: 저가가 손절가 이탈 시 시가/손절가 중 낮은 값에 청산하고 트레일링은 올라가기만 한다', () => {
  const profile = { ...resolveHorizonProfiles('coin').swing };
  const position = { entryPrice: 100, stopPrice: 95, highestClose: 100, barsHeld: 0 };
  const hit = evaluateExit(position, { open: 94, high: 96, low: 93, close: 95 }, null, profile);
  assert.equal(hit.exit, true);
  assert.equal(hit.price, 94);
  const trail = evaluateExit(position, { open: 101, high: 111, low: 100, close: 110 }, { available: true, atr: 2, score: 50 }, profile);
  assert.equal(trail.exit, false);
  assert.ok(trail.stopPrice > 95);
  assert.equal(volatilityAllowed({ atrPercent: 50 }, profile), false);
});

test('백테스트: 상승장에서 수익, 신호 다음 봉 시가 체결, 비용 반영', () => {
  const series = new Map([
    ['KRW-AAA', trendBars(400, { drift: 0.004, seed: 3 })],
    ['KRW-BBB', trendBars(400, { drift: 0.003, seed: 11 })]
  ]);
  const profile = { ...resolveHorizonProfiles('coin').swing, entryScore: 20, regimeFilter: false };
  const result = runSleeveBacktest(series, profile, { costs: ASSET_COSTS.coin, barsPerYear: 2190 });
  assert.ok(result.totalReturnPercent > 0, `return ${result.totalReturnPercent}`);
  const cached = runSleeveBacktest(series, profile, { costs: ASSET_COSTS.coin, barsPerYear: 2190, analysisCache: precomputeAnalyses(series, profile.periods) });
  assert.equal(cached.totalReturnPercent.toFixed(8), result.totalReturnPercent.toFixed(8), '캐시 사용 여부와 무관하게 같은 결과');
  for (const trade of result.tradeList) {
    const bars = series.get(trade.symbol);
    const entryBar = bars.find(bar => bar.time === trade.entryTime);
    assert.equal(trade.entryPrice, entryBar.open, '진입은 신호 다음 봉 시가');
  }
});

test('연구: 하락장만 있으면 슬리브는 불합격이고 실거래 비중은 0', () => {
  const series = new Map([
    ['KRW-AAA', trendBars(500, { drift: -0.003, seed: 5 })],
    ['KRW-BBB', trendBars(500, { drift: -0.002, seed: 9 })]
  ]);
  const profiles = resolveHorizonProfiles('coin');
  const result = studySleeve(series, profiles.swing, { grid: { entryScore: [30], atrStopMultiple: [3], maxPositions: [2], regimeFilter: [false], riskPerTradePercent: [1] } });
  assert.equal(result.passed, false);
  const overrides = studyToOverrides([result], profiles);
  assert.equal(overrides.swing.weight, 0);
});

test('완료 봉 시각: 국내 일봉은 15:30 KST 마감 이후에만 당일 봉이 완료된다', () => {
  const before = Date.parse('2026-03-25T15:00:00+09:00');
  const after = Date.parse('2026-03-25T15:40:00+09:00');
  assert.equal(new Date(latestCompletedBarStart('1d', before, 'stock')).toISOString(), '2026-03-23T15:00:00.000Z');
  assert.equal(new Date(latestCompletedBarStart('1d', after, 'stock')).toISOString(), '2026-03-24T15:00:00.000Z');
  assert.equal(latestCompletedBarStart('240m', Date.UTC(2026, 0, 1, 9, 30), 'coin'), Date.UTC(2026, 0, 1, 4));
});

function fakeLoader(barsBySymbol) {
  return { getBars: async (symbol) => barsBySymbol[symbol] || [] };
}

function swingOnlyProfiles(overrides = {}) {
  return resolveHorizonProfiles('coin', { short: { weight: 0 }, mid: { weight: 0 }, long: { weight: 0 }, swing: { entryScore: 10, regimeFilter: false, riskPerTradePercent: 0, ...overrides } });
}

test('모의 매니저: 새 봉 완료 시 차트 점수로 매수하고, 실시간 손절가 이탈 시 매도한다', async () => {
  const bars = trendBars(400, { drift: 0.005, startTime: Date.UTC(2025, 6, 1) });
  let price = bars.at(-1).close;
  const now = bars.at(-1).time + 4 * HOUR + 60_000;
  const reservations = [];
  const manager = new HorizonPortfolioManager({
    assetClass: 'coin',
    mode: 'paper',
    loader: fakeLoader({ 'KRW-AAA': bars, 'KRW-BTC': bars }),
    broker: new PaperBroker({ assetClass: 'coin', priceSource: async symbols => new Map(symbols.map(s => [s, price])) }),
    profiles: swingOnlyProfiles(),
    universeProvider: async () => ['KRW-AAA'],
    onReservationsChanged: value => reservations.push(value),
    config: { paperSeedMoney: 100_000, enabledSleeves: ['swing'] },
    stateFile: path.join(tempDir(), 'h.json'),
    now: () => now,
    log: silent
  });
  await manager.start();
  await manager.runCycle();
  const position = manager.state.positions['swing:KRW-AAA'];
  assert.ok(position, '매수됨');
  assert.ok(manager.state.cash < 100_000);
  assert.ok(reservations.at(-1)['KRW-AAA'] > 0, '보유 수량 예약 통지');

  price = position.stopPrice * 0.99;
  await manager.runCycle();
  assert.equal(manager.state.positions['swing:KRW-AAA'], undefined, '실시간 손절');
  assert.equal(manager.state.trades.at(-1).action, 'SELL');
});

test('모의 매니저: 소액 시드(3만원)도 코인 최소 진입금액(손절 거리 반영)으로 매수한다', async () => {
  const bars = trendBars(400, { drift: 0.005, startTime: Date.UTC(2025, 6, 1) });
  const price = bars.at(-1).close;
  const manager = new HorizonPortfolioManager({
    assetClass: 'coin',
    mode: 'paper',
    loader: fakeLoader({ 'KRW-AAA': bars, 'KRW-BTC': bars }),
    broker: new PaperBroker({ assetClass: 'coin', priceSource: async symbols => new Map(symbols.map(s => [s, price])) }),
    profiles: resolveHorizonProfiles('coin', { short: { weight: 0 }, long: { weight: 0 }, mid: { weight: 0.75 }, swing: { weight: 0.25, entryScore: 10, regimeFilter: false, riskPerTradePercent: 0, maxPositions: 4 } }),
    universeProvider: async () => ['KRW-AAA'],
    config: { paperSeedMoney: 30_000, enabledSleeves: ['swing', 'mid'] },
    now: () => bars.at(-1).time + 4 * HOUR + 60_000,
    log: silent
  });
  await manager.start();
  await manager.runCycle();
  const position = manager.state.positions['swing:KRW-AAA'];
  assert.ok(position, '슬리브 슬롯(약 1,875원)이 최소 주문보다 작아도 진입');
  assert.ok(position.cost >= 5000);
  const stopDistance = (position.entryPrice - position.stopPrice) / position.entryPrice;
  assert.ok(position.cost * (1 - stopDistance) * (1 - 0.0015) >= 5000 * 0.99, '손절 후에도 최소 매도금액 근처 유지');
});

test('실전 매니저: 주문 전 미확인 주문을 먼저 기록하고, 체결 확인 실패 시 진입을 잠근 뒤 다음 대사에서 반영한다', async () => {
  const bars = trendBars(400, { drift: 0.005, startTime: Date.UTC(2025, 6, 1) });
  const price = bars.at(-1).close;
  const stateFile = path.join(tempDir(), 'live.json');
  let held = 0;
  let pendingSeenBeforeDispatch = false;
  let manager;
  const broker = {
    getPrices: async symbols => new Map(symbols.map(s => [s, price])),
    getAvailableCash: async () => 1_000_000,
    getAccountEquity: async () => 1_000_000,
    getHeldQuantities: async () => ({ 'KRW-AAA': held }),
    getOtherEngineQuantities: async () => ({}),
    buy: async (symbol, amount, p, order) => {
      pendingSeenBeforeDispatch = Boolean(JSON.parse(fs.readFileSync(stateFile, 'utf8')).pendingOrders[order.clientOrderId]);
      held = amount / p;
      return { pendingOrderId: order.clientOrderId };
    },
    sell: async () => ({ quantity: 0 }),
    resolveOrder: async () => ({ quantity: held, price, cost: held * price })
  };
  manager = new HorizonPortfolioManager({
    assetClass: 'coin',
    mode: 'live',
    loader: fakeLoader({ 'KRW-AAA': bars, 'KRW-BTC': bars }),
    broker,
    profiles: swingOnlyProfiles(),
    universeProvider: async () => ['KRW-AAA'],
    config: { capitalRatio: 0.5, enabledSleeves: ['swing'] },
    stateFile,
    now: () => bars.at(-1).time + 4 * HOUR + 60_000,
    log: silent
  });
  await manager.start();
  assert.equal(manager.entriesPaused, false, '대사 성공 후 진입 허용');
  await manager.runCycle();
  assert.equal(pendingSeenBeforeDispatch, true, '전송 전에 장부에 기록');
  assert.equal(manager.entriesPaused, true);
  assert.equal(manager.pauseReason, 'pending_order_unresolved');
  assert.equal(Object.keys(manager.state.positions).length, 0);

  await manager.reconcile(true);
  assert.ok(manager.state.positions['swing:KRW-AAA']?.quantity > 0, '미확인 주문 체결 반영');
  assert.deepEqual(manager.state.pendingOrders, {});
  assert.equal(manager.entriesPaused, false);
});

test('실전 대사: 계좌 보유량(스캘퍼 몫 제외)보다 장부가 크면 장부를 줄이고, 조회 실패 시 진입을 잠근다', async () => {
  const stateFile = path.join(tempDir(), 'live.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 1, assetClass: 'coin', mode: 'live', cash: null, initialSeedMoney: null, sleeves: {}, pendingOrders: {}, trades: [], desiredRunning: true,
    positions: {
      'swing:KRW-AAA': { sleeve: 'swing', symbol: 'KRW-AAA', quantity: 2, cost: 200, entryPrice: 100, stopPrice: 90 },
      'mid:KRW-AAA': { sleeve: 'mid', symbol: 'KRW-AAA', quantity: 1, cost: 100, entryPrice: 100, stopPrice: 90 }
    }
  }));
  let fail = false;
  const broker = {
    getHeldQuantities: async () => { if (fail) throw new Error('down'); return { 'KRW-AAA': 2.5 }; },
    getOtherEngineQuantities: async () => ({ 'KRW-AAA': 0.5 }),
    resolveOrder: async () => ({ notFound: true })
  };
  const manager = new HorizonPortfolioManager({ assetClass: 'coin', mode: 'live', loader: fakeLoader({}), broker, profiles: resolveHorizonProfiles('coin'), universeProvider: async () => [], stateFile, log: silent });
  await manager.reconcile(true);
  const total = Object.values(manager.state.positions).reduce((s, p) => s + p.quantity, 0);
  assert.ok(Math.abs(total - 2) < 1e-9, `장부 합계 ${total}`);
  fail = true;
  await manager.reconcile(true);
  assert.equal(manager.entriesPaused, true);
  assert.equal(manager.pauseReason, 'exchange_state_unverified');
});

test('런타임: 실전은 검증된 연구 결과가 없으면 모든 슬리브 비중이 0(신규 진입 없음)', () => {
  const manager = new HorizonPortfolioManager({ assetClass: 'coin', mode: 'live', loader: fakeLoader({}), broker: {}, profiles: resolveHorizonProfiles('coin'), universeProvider: async () => [], log: silent });
  const runtime = new HorizonRuntime({ manager, scheduler: null, assetClass: 'coin', cycleIntervalMs: 60000, log: silent });
  runtime.applyReport(null);
  assert.ok(Object.values(manager.weights).every(weight => weight === 0));
  runtime.applyReport({ version: 1, generatedAt: 'x', overrides: { short: { weight: 0 }, swing: { weight: 0.25 }, mid: { weight: 0.3 }, long: { weight: 0 } }, results: [] });
  const weights = normalizeWeights(manager.profiles);
  assert.ok(Math.abs(manager.weights.swing - weights.swing) < 1e-9);
  assert.equal(manager.weights.short, 0);
  assert.ok(manager.weights.swing > 0 && manager.weights.mid > 0);
});

test('스캘퍼는 기간별 포트폴리오가 예약한 코인 수량을 자기 잔고로 보지 않는다', () => {
  const owner = {
    dryRun: false,
    getExternallyReservedVolume: market => (market === 'KRW-BTC' ? 0.3 : 0)
  };
  const valuation = new PortfolioValuation(owner);
  const accounts = [{ currency: 'BTC', balance: '0.5', locked: '0' }];
  assert.ok(Math.abs(valuation.getCoinBalance(accounts, 'KRW-BTC') - 0.2) < 1e-12);
});
