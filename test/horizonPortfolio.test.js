import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeChart, aggregateWeekly, minimumBars } from '../src/portfolio/chartAnalysis.js';
import { resolveHorizonProfiles, normalizeWeights, ASSET_COSTS } from '../src/portfolio/horizonProfiles.js';
import { positionBudget, evaluateExit, volatilityAllowed } from '../src/portfolio/horizonStrategy.js';
import { runSleeveBacktest, precomputeAnalyses } from '../src/portfolio/horizonBacktest.js';
import { studySleeve, studyToOverrides, barsPerYearFor, passesGoLiveGate, MIN_OOS_TRADES } from '../src/portfolio/horizonStudy.js';
import { TossCandleLoader } from '../src/portfolio/marketDataLoader.js';
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

test('호가 비용 필터: 1원 호가의 130원 코인과 1,500원 미만 주식은 진입 대상에서 빠진다', async () => {
  const { tickFraction, passesTickCost, regimeAllowsEntries } = await import('../src/portfolio/horizonStrategy.js');
  assert.ok(Math.abs(tickFraction(132, 'coin') - 1 / 132) < 1e-12);
  assert.equal(passesTickCost(132, 'coin'), false);
  assert.equal(passesTickCost(850, 'coin'), true);
  assert.equal(passesTickCost(108_000_000, 'coin'), true);
  assert.equal(passesTickCost(300, 'stock'), false);
  assert.equal(passesTickCost(60_000, 'stock'), true);
  assert.equal(regimeAllowsEntries(null), true, '청산 판단은 데이터 공백을 하락으로 보지 않는다');
  assert.equal(regimeAllowsEntries(null, { required: true }), false, '국면 필터가 켜진 신규 진입은 데이터가 없으면 막는다');
});

test('실시간 진입 금액은 백테스트와 같은 위험 기준을 쓰고, 한 코인은 한 슬리브만 보유한다', () => {
  const manager = new HorizonPortfolioManager({ assetClass: 'coin', mode: 'paper', loader: fakeLoader({}), broker: {}, profiles: resolveHorizonProfiles('coin'), universeProvider: async () => [], log: silent });
  manager.weights = { short: 0, swing: 0.5, mid: 0.5, long: 0 };
  const profile = { ...manager.profiles.mid, maxPositions: 3, riskPerTradePercent: 1 };
  // 손절 -42%: 슬리브 500,000원의 1% 위험이면 약 11,900원 (균등 슬롯 166,666원 아님)
  const amount = manager._entryAmount('mid', profile, { cash: 1_000_000, horizonCapital: 1_000_000 }, 132, 76.2);
  assert.ok(amount > 11_000 && amount < 13_000, `risk-sized amount, got ${amount}`);
});

// ---------- 백테스트 체결 경계 (가짜 분석 캐시로 신호를 고정) ----------

const BT_PROFILE = resolveHorizonProfiles('coin').swing;
const BT_WARMUP = minimumBars(BT_PROFILE.periods);

function flatSeries(count, { price = 10_000, volume = 1000, interval = 4 * HOUR, startTime = Date.UTC(2025, 0, 1) } = {}) {
  return Array.from({ length: count }, (_, i) => ({ time: startTime + i * interval, open: price, high: price * 1.001, low: price * 0.999, close: price, volume }));
}

/** scoreAt(index) → 점수(null이면 분석 없음). atr은 가격의 1%. */
function fakeCache(series, scoreBySymbol) {
  const cache = new Map();
  for (const [symbol, bars] of series) {
    cache.set(symbol, bars.map((bar, index) => {
      const score = scoreBySymbol[symbol](index);
      if (score === null) return null;
      return { available: true, score, regime: score < 0 ? 'downtrend' : 'uptrend', atr: bar.close * 0.01, atrPercent: 1, close: bar.close };
    }));
  }
  return cache;
}

function btProfile(overrides) {
  return { ...BT_PROFILE, regimeFilter: false, regimeExit: false, riskPerTradePercent: 0, entryScore: 20, exitScore: 0, rebalanceBars: 1, maxHoldBars: 100, atrStopMultiple: 3, ...overrides };
}

test('백테스트: 최대 보유기간 청산은 판단 봉 종가가 아니라 다음 봉 시가(+비용)로 체결된다', () => {
  const bars = flatSeries(BT_WARMUP + 12).map((bar, i) => ({ ...bar, open: 10_000 + i * 10, close: 10_000 + i * 10 + 5, high: 10_000 + i * 10 + 6, low: 10_000 + i * 10 - 1 }));
  const series = new Map([['KRW-AAA', bars]]);
  const profile = btProfile({ mode: 'signal', maxPositions: 1, maxHoldBars: 2 });
  const result = runSleeveBacktest(series, profile, { costs: ASSET_COSTS.coin, analysisCache: fakeCache(series, { 'KRW-AAA': () => 50 }) });
  const trade = result.tradeList.find(t => t.reason === '최대 보유기간');
  assert.ok(trade, 'max-hold exit happened');
  const exitIndex = bars.findIndex(bar => bar.time === trade.exitTime);
  const entryIndex = bars.findIndex(bar => bar.time === trade.entryTime);
  assert.equal(trade.exitPrice, bars[exitIndex].open, 'fills at the next bar open');
  assert.equal(exitIndex, entryIndex + 2, 'decided at the close of the 2nd held bar, filled at the following open');
  assert.ok(Math.abs(trade.returnPercent - ((trade.quantity * trade.exitPrice * (1 - ASSET_COSTS.coin.sellCostRate)) / trade.cost - 1) * 100) < 1e-9);
});

test('백테스트: 손절은 봉 내 min(시가, 손절가) 체결을 유지한다', () => {
  const bars = flatSeries(BT_WARMUP + 8);
  const crash = BT_WARMUP + 3;
  bars[crash] = { ...bars[crash], open: 9_000, low: 8_500, close: 8_800, high: 9_100 };
  const series = new Map([['KRW-AAA', bars]]);
  const result = runSleeveBacktest(series, btProfile({ mode: 'signal', maxPositions: 1 }), { costs: ASSET_COSTS.coin, analysisCache: fakeCache(series, { 'KRW-AAA': () => 50 }) });
  const trade = result.tradeList.find(t => t.reason === 'ATR 손절/트레일링');
  assert.equal(trade.exitTime, bars[crash].time);
  assert.equal(trade.exitPrice, 9_000, 'gap below the stop fills at the open');
});

test('백테스트: rank 리밸런싱은 같은 봉에서 매도를 먼저 체결해 매수 슬롯을 비운다', () => {
  const n = BT_WARMUP + 12;
  const series = new Map([['KRW-AAA', flatSeries(n)], ['KRW-BBB', flatSeries(n)]]);
  const switchAt = BT_WARMUP + 3;
  const cache = fakeCache(series, {
    'KRW-AAA': i => (i < switchAt ? 50 : -10),
    'KRW-BBB': i => (i < switchAt ? 5 : 60)
  });
  const result = runSleeveBacktest(series, btProfile({ mode: 'rank', maxPositions: 1, maxHoldBars: 4 }), { costs: ASSET_COSTS.coin, analysisCache: cache });
  const bars = series.get('KRW-BBB');
  const aaaExit = result.tradeList.find(t => t.symbol === 'KRW-AAA');
  const bbb = result.tradeList.find(t => t.symbol === 'KRW-BBB');
  assert.equal(aaaExit.exitTime, bars[switchAt + 1].time);
  assert.ok(bbb, 'replacement entry is not dropped');
  assert.equal(bbb.entryTime, bars[switchAt + 1].time, 'sell and buy fill at the same open');
});

test('백테스트: 체결 시 매수 크기는 보유 종목을 체결 봉 시가(종가 아님)로 평가한 자산 기준', () => {
  const n = BT_WARMUP + 12;
  const aaa = flatSeries(n);
  const signalAt = BT_WARMUP + 2;
  // 체결 봉에서 AAA는 10,000에 열려 30,000에 닫힌다 — 종가로 평가하면 매수 크기가 부풀려진다.
  for (let i = signalAt + 1; i < n; i += 1) aaa[i] = { ...aaa[i], open: i === signalAt + 1 ? 10_000 : 30_000, high: 30_010, low: i === signalAt + 1 ? 10_000 : 29_990, close: 30_000 };
  const series = new Map([['KRW-AAA', aaa], ['KRW-BBB', flatSeries(n)]]);
  const cache = fakeCache(series, { 'KRW-AAA': () => 50, 'KRW-BBB': i => (i < signalAt ? 0 : 50) });
  const result = runSleeveBacktest(series, btProfile({ mode: 'signal', maxPositions: 4, maxHoldBars: 4 }), { costs: ASSET_COSTS.coin, analysisCache: cache });
  const bbb = result.tradeList.find(t => t.symbol === 'KRW-BBB');
  assert.equal(bbb.entryTime, aaa[signalAt + 1].time);
  const equityAtOpen = 750_000 + 250_000 * (1 - ASSET_COSTS.coin.buyCostRate);
  assert.equal(bbb.cost, Math.floor(equityAtOpen / 4));
});

test('백테스트: 신규 진입은 결정 봉까지의 거래대금으로 고른 시점 유니버스 상위 N만 대상이다', () => {
  const n = BT_WARMUP + 20;
  const surgeAt = BT_WARMUP + 10;
  const series = new Map([
    ['KRW-AAA', flatSeries(n, { volume: 10 })],
    ['KRW-BBB', flatSeries(n, { volume: 1000 })],
    ['KRW-CCC', flatSeries(n, { volume: 10 }).map((bar, i) => (i >= surgeAt ? { ...bar, volume: 1_000_000 } : bar))]
  ]);
  const cache = fakeCache(series, { 'KRW-AAA': () => 90, 'KRW-BBB': () => 50, 'KRW-CCC': () => 70 });
  const result = runSleeveBacktest(series, btProfile({ mode: 'signal', maxPositions: 3, maxHoldBars: 2 }), {
    costs: ASSET_COSTS.coin, analysisCache: cache, universeSize: 1, universeLookbackBars: 3
  });
  const times = series.get('KRW-AAA').map(bar => bar.time);
  assert.equal(result.tradeList.filter(t => t.symbol === 'KRW-AAA').length, 0, 'never in the top-1 by trailing turnover');
  assert.ok(result.tradeList.some(t => t.symbol === 'KRW-BBB'));
  const ccc = result.tradeList.filter(t => t.symbol === 'KRW-CCC');
  assert.ok(ccc.length > 0);
  assert.ok(ccc.every(t => t.entryTime > times[surgeAt]), 'future turnover is not used before it happens');
});

test('백테스트 진입 크기는 실시간과 같다: 주식 정수 주, 1주 미만·코인 최소 주문 미만은 건너뛴다', () => {
  const n = BT_WARMUP + 8;
  const run = (assetClass, price, initialEquity) => {
    const series = new Map([['SYM', flatSeries(n, { price })]]);
    return runSleeveBacktest(series, btProfile({ mode: 'signal', maxPositions: 4, maxHoldBars: 2 }), {
      costs: ASSET_COSTS[assetClass], assetClass, initialEquity, analysisCache: fakeCache(series, { SYM: () => 50 })
    });
  };
  const stock = run('stock', 30_000, 1_000_000);
  assert.ok(stock.tradeList.length > 0);
  assert.equal(stock.tradeList[0].quantity, 8, 'floor(250,000 / (30,000 × (1 + cost))) shares');
  assert.equal(stock.tradeList[0].cost, 8 * 30_000 * (1 + ASSET_COSTS.stock.buyCostRate));
  assert.equal(run('stock', 1_000_000, 1_000_000).tradeList.length, 0, 'cannot afford one share');
  // 코인: 손절거리 3% → 최소 진입액 5,300원. 현금 4,900원(5,000×0.98)으로는 진입하지 않는다.
  assert.equal(run('coin', 2_000, 5_000).tradeList.length, 0);
  const small = run('coin', 2_000, 6_000);
  assert.equal(small.tradeList[0].cost, 5_300, 'raised to the minimum entry like the live engine');
});

test('주식 주봉은 KST 달력 주(월~금)로 묶고 금요일 15:30 KST 이후에만 완료된다 (코인은 UTC 그대로)', async () => {
  // 토스 일봉 timestamp = 거래일 00:00 KST(전날 15:00 UTC). 2026-03-02(월)~03-13(금) 2주.
  const days = ['02', '03', '04', '05', '06', '09', '10', '11', '12', '13'];
  const raw = days.map((day, i) => ({ timestamp: `2026-03-${day}T00:00:00+09:00`, openPrice: 100 + i, highPrice: 101 + i, lowPrice: 99 + i, closePrice: 100.5 + i, volume: 10 }));
  const daily = raw.map(candle => ({ time: Date.parse(candle.timestamp), open: candle.openPrice, high: candle.highPrice, low: candle.lowPrice, close: candle.closePrice, volume: 1 }));
  const weeks = aggregateWeekly(daily, { assetClass: 'stock' });
  assert.equal(weeks.length, 2);
  assert.equal(new Date(weeks[0].time).toISOString(), '2026-03-01T15:00:00.000Z', 'Monday 00:00 KST');
  assert.equal(weeks[0].open, 100);
  assert.equal(weeks[0].close, 104.5, 'Friday close');

  const friBefore = Date.parse('2026-03-13T15:00:00+09:00');
  const friAfter = Date.parse('2026-03-13T15:40:00+09:00');
  assert.equal(new Date(latestCompletedBarStart('1w', friBefore, 'stock')).toISOString(), '2026-03-01T15:00:00.000Z');
  assert.equal(new Date(latestCompletedBarStart('1w', friAfter, 'stock')).toISOString(), '2026-03-08T15:00:00.000Z');
  assert.equal(latestCompletedBarStart('1w', Date.UTC(2026, 2, 13, 12), 'coin'), Date.UTC(2026, 2, 2), 'coin weeks stay UTC Monday');

  const client = { getDailyCandles: async () => [...raw].reverse() };
  const before = await new TossCandleLoader({ client, now: () => friBefore }).getBars('005930', '1w', 10);
  const after = await new TossCandleLoader({ client, now: () => friAfter }).getBars('005930', '1w', 10);
  assert.equal(before.length, 1);
  assert.equal(after.length, 2);
  assert.equal(after.at(-1).time, latestCompletedBarStart('1w', friAfter, 'stock'), 'loader and live clock agree');
});

test('연율화: 주식 일봉 252, 주봉 52, 코인 일봉 365', () => {
  assert.equal(barsPerYearFor('1d', 'stock'), 252);
  assert.equal(barsPerYearFor('1w', 'stock'), 52);
  assert.equal(barsPerYearFor('1w', 'coin'), 52);
  assert.equal(barsPerYearFor('1d', 'coin'), 365);
  assert.equal(barsPerYearFor('240m', 'coin'), 2190);
});

test('편입 게이트: 바이앤홀드를 이기지 못하거나 OOS 거래가 부족하면 불합격', () => {
  const base = { folds: 3, testedFolds: 3, compounded: 1.2, buyAndHoldCompounded: 1.1, nonNegativeFolds: 2, trades: 20, worstFoldDrawdown: 10, maxDrawdownPercent: 35 };
  assert.equal(passesGoLiveGate(base), true);
  assert.equal(passesGoLiveGate({ ...base, buyAndHoldCompounded: 1.3 }), false, 'positive but below buy-and-hold');
  assert.equal(passesGoLiveGate({ ...base, trades: MIN_OOS_TRADES - 1 }), false);
  assert.ok(MIN_OOS_TRADES >= 12);
  assert.equal(passesGoLiveGate({ ...base, nonNegativeFolds: 1 }), false);
});
