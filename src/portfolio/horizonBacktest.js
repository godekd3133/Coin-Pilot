// 슬리브 단위 포트폴리오 백테스트.
// - 신호는 봉 t의 종가로 계산하고 체결은 다음 봉 시가(+비용)로 한다(미래 참조 없음).
//   최대 보유기간·점수 악화·국면 청산·리밸런싱 제외도 모두 다음 봉 시가 체결이다.
// - 손절/트레일링만 봉 내 체결: 저가가 손절가 이탈 시 min(시가, 손절가).
// - 체결 순서: 같은 봉의 대기 주문은 매도 전부 → 매수 전부(각각 결정 순서) — 실시간 엔진이
//   한 사이클에서 청산 후 진입하는 것과 같다. 매수 크기는 체결 봉 시가로 평가한 자산 기준.
// - 진입 금액은 실시간과 같은 entryAmount()(코인 최소 주문금액, 주식 정수 주).
// - universeSize를 주면 각 결정 봉에서 그 시점까지의 봉만으로 계산한 거래대금 상위 N만 신규 진입
//   대상이 된다(현재 거래대금 순위로 과거를 고르는 미래 참조 방지). 보유 종목은 계속 청산 판단.
// - 벤치마크 국면 필터·국면 청산은 실시간 엔진과 같은 함수를 쓴다.

import { analyzeAt, evaluateExit, signalCandidates, rankTargets, initialStop, regimeAllowsEntries, positionBudget, passesTickCost, entryAmount } from './horizonStrategy.js';
import { minimumBars } from './chartAnalysis.js';
import { INTERVAL_MS } from './horizonProfiles.js';

/** 유동성 순위용 거래대금 누적 창(약 30일). */
export const UNIVERSE_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

function buildTimeline(seriesBySymbol) {
  const times = new Set();
  for (const bars of seriesBySymbol.values()) for (const bar of bars) times.add(bar.time);
  return [...times].sort((a, b) => a - b);
}

/** 종목별 거래대금(bar.volume) 누적합 — prefix[i] = volume[0..i-1]. */
export function turnoverPrefixSums(seriesBySymbol) {
  const prefix = new Map();
  for (const [symbol, bars] of seriesBySymbol) {
    const sums = new Float64Array(bars.length + 1);
    for (let i = 0; i < bars.length; i += 1) sums[i + 1] = sums[i] + (Number(bars[i].volume) || 0);
    prefix.set(symbol, sums);
  }
  return prefix;
}

/**
 * 결정 봉 시점의 거래대금 상위 N 종목(그 봉까지의 lookbackBars개 봉 합). 미래 봉은 쓰지 않는다.
 * @returns {Set<string>|null} universeSize가 없으면 null(제한 없음)
 */
export function pointInTimeUniverse(barsNow, prefix, universeSize, lookbackBars) {
  if (!(universeSize > 0)) return null;
  const ranked = [];
  for (const [symbol, now] of barsNow) {
    const sums = prefix.get(symbol);
    const endExclusive = now.index + 1;
    const startIndex = Math.max(0, endExclusive - lookbackBars);
    ranked.push({ symbol, turnover: sums[endExclusive] - sums[startIndex] });
  }
  ranked.sort((a, b) => b.turnover - a.turnover || (a.symbol < b.symbol ? -1 : 1));
  return new Set(ranked.slice(0, universeSize).map(item => item.symbol));
}

/**
 * @param {Map<string, Array>} seriesBySymbol 시간순 봉
 * @param {object} profile 슬리브(resolveHorizonProfiles 결과)
 * @param {object} options { costs:{buyCostRate,sellCostRate}, benchmark?:string, startTime?, endTime?, initialEquity?, barsPerYear,
 *   assetClass?, universeSize?, universeLookbackBars? }
 */
export function runSleeveBacktest(seriesBySymbol, profile, options = {}) {
  const { costs, benchmark = null, startTime = -Infinity, endTime = Infinity, initialEquity = 1_000_000, barsPerYear = 365 } = options;
  const assetClass = options.assetClass || 'coin';
  const timeline = buildTimeline(seriesBySymbol).filter(time => time <= endTime);
  const indexBySymbol = new Map([...seriesBySymbol.keys()].map(symbol => [symbol, -1]));
  const warmup = minimumBars({ ...profile.periods });
  // 분석은 지표 기간에만 의존하므로 그리드 탐색 시 precomputeAnalyses() 결과를 재사용한다.
  const cache = options.analysisCache || null;
  const analysisFor = (symbol, index) => {
    if (index < warmup) return null;
    const cached = cache?.get(symbol)?.[index];
    if (cached !== undefined) return cached;
    return analyzeAt(seriesBySymbol.get(symbol), index, profile.periods);
  };
  const universeSize = Number(options.universeSize) > 0 ? Math.floor(Number(options.universeSize)) : 0;
  const intervalMs = INTERVAL_MS[profile.interval];
  const universeLookbackBars = Math.max(1, Math.floor(options.universeLookbackBars ||
    (intervalMs ? Math.round(UNIVERSE_LOOKBACK_MS / intervalMs) : 30)));
  const turnoverPrefix = universeSize > 0 ? (options.turnoverPrefix || turnoverPrefixSums(seriesBySymbol)) : null;

  let cash = initialEquity;
  const positions = new Map();
  let pending = []; // { symbol, side, reason, analysis } — 결정 순서 유지
  const trades = [];
  const equityCurve = [];
  let step = 0;
  let exposureBars = 0;

  // valuation: 'close'(봉 마감) 또는 'open'(체결 시점 — 이번 봉의 종가는 아직 모른다)
  const priceOf = (symbol, barsNow, valuation) => {
    const bars = seriesBySymbol.get(symbol);
    const index = indexBySymbol.get(symbol);
    if (index < 0) return null;
    const now = valuation === 'open' ? barsNow?.get(symbol) : null;
    // 이번 봉이 있는 종목은 시가, 없으면 이미 완료된 직전 봉 종가.
    return now ? now.bar.open : bars[index].close;
  };
  const equity = (barsNow = null, valuation = 'close') => {
    let total = cash;
    for (const [symbol, position] of positions) total += position.quantity * (priceOf(symbol, barsNow, valuation) ?? position.entryPrice);
    return total;
  };
  const deployedCost = () => [...positions.values()].reduce((sum, position) => sum + position.cost, 0);
  const closeTrade = (symbol, position, time, exitPrice, reason) => {
    const proceeds = position.quantity * exitPrice * (1 - costs.sellCostRate);
    cash += proceeds;
    trades.push({ symbol, entryTime: position.entryTime, exitTime: time, entryPrice: position.entryPrice, exitPrice, quantity: position.quantity, cost: position.cost, returnPercent: (proceeds / position.cost - 1) * 100, reason, bars: position.barsHeld });
    positions.delete(symbol);
  };

  for (const time of timeline) {
    // 해당 시각의 봉으로 인덱스 전진
    const barsNow = new Map();
    for (const [symbol, bars] of seriesBySymbol) {
      let index = indexBySymbol.get(symbol);
      while (index + 1 < bars.length && bars[index + 1].time <= time) index += 1;
      indexBySymbol.set(symbol, index);
      if (index >= 0 && bars[index].time === time) barsNow.set(symbol, { bar: bars[index], index });
    }
    if (time < startTime) continue;

    // 1) 직전 봉에서 결정된 주문을 이번 봉 시가로 체결: 매도 전부 → 매수 전부(결정 순서).
    const ready = pending.filter(order => barsNow.has(order.symbol));
    pending = pending.filter(order => !barsNow.has(order.symbol));
    for (const order of ready) {
      if (order.side !== 'SELL') continue;
      const position = positions.get(order.symbol);
      if (position) closeTrade(order.symbol, position, time, barsNow.get(order.symbol).bar.open, order.reason);
    }
    for (const order of ready) {
      if (order.side !== 'BUY') continue;
      const open = barsNow.get(order.symbol).bar.open;
      if (positions.has(order.symbol) || positions.size >= profile.maxPositions || !passesTickCost(open, assetClass)) continue;
      const stopPrice = initialStop(open, order.analysis, profile);
      const sleeveEquity = equity(barsNow, 'open');
      const amount = entryAmount({
        assetClass,
        slot: positionBudget({
          sleeveEquity,
          maxPositions: profile.maxPositions,
          riskPerTradePercent: profile.riskPerTradePercent,
          entryPrice: open,
          stopPrice
        }),
        remaining: sleeveEquity - deployedCost(),
        cash,
        price: open,
        stopPrice
      });
      if (amount <= 0) continue;
      let quantity;
      let cost;
      if (assetClass === 'stock') {
        // 실시간 브로커와 같이 정수 주로 내림, 1주 미만이면 건너뜀.
        quantity = Math.floor(Math.min(amount, cash) / (open * (1 + costs.buyCostRate)));
        if (quantity <= 0) continue;
        cost = quantity * open * (1 + costs.buyCostRate);
      } else {
        cost = Math.min(amount, cash);
        quantity = (cost * (1 - costs.buyCostRate)) / open;
      }
      cash -= cost;
      positions.set(order.symbol, {
        quantity,
        entryPrice: open,
        cost,
        entryTime: time,
        stopPrice,
        highestClose: open,
        barsHeld: 0
      });
    }

    // 2) 이번 봉 마감 기준 분석
    const benchmarkSeries = benchmark ? seriesBySymbol.get(benchmark) : null;
    const benchmarkIndex = benchmark ? indexBySymbol.get(benchmark) : -1;
    const benchmarkAnalysis = profile.regimeFilter && benchmarkSeries && benchmarkIndex >= warmup
      ? analysisFor(benchmark, benchmarkIndex)
      : null;
    const benchmarkOk = regimeAllowsEntries(benchmarkAnalysis);
    const entryRegimeOk = regimeAllowsEntries(benchmarkAnalysis, { required: Boolean(profile.regimeFilter && benchmark) });

    // 3) 보유 포지션 청산: 손절은 봉 내 즉시, 나머지는 다음 봉 시가 체결 대기.
    for (const [symbol, position] of [...positions]) {
      const now = barsNow.get(symbol);
      if (!now) continue;
      const analysis = analysisFor(symbol, now.index);
      const decision = evaluateExit(position, now.bar, analysis, profile, { benchmarkOk });
      position.stopPrice = decision.stopPrice;
      position.highestClose = decision.highestClose;
      position.barsHeld += 1;
      if (!decision.exit) continue;
      if (decision.timing === 'intrabar') closeTrade(symbol, position, time, decision.price, decision.reason);
      else pending.push({ symbol, side: 'SELL', reason: decision.reason });
    }

    // 4) 신규 진입/리밸런싱 결정 → 다음 봉 시가 체결
    // 청산 대기 포지션은 실시간처럼 "이미 판 것"으로 보고 결정한다(슬롯·재진입).
    const exiting = new Set(pending.filter(order => order.side === 'SELL').map(order => order.symbol));
    const held = [...positions.keys()].filter(symbol => !exiting.has(symbol));
    const shouldRebalance = profile.mode === 'signal' || step % profile.rebalanceBars === 0;
    if (shouldRebalance && (entryRegimeOk || !profile.regimeFilter)) {
      const eligible = pointInTimeUniverse(barsNow, turnoverPrefix, universeSize, universeLookbackBars);
      const analyses = [];
      for (const [symbol, now] of barsNow) {
        if (symbol === benchmark && options.excludeBenchmark) continue;
        if (now.index < warmup) continue;
        // 시점 유니버스 밖 종목은 보유 중일 때만 분석(실시간: universe ∪ 보유 종목).
        if (eligible && !eligible.has(symbol) && !held.includes(symbol)) continue;
        analyses.push({ symbol, analysis: analysisFor(symbol, now.index) });
      }
      const pendingBuy = symbol => pending.some(order => order.side === 'BUY' && order.symbol === symbol);
      if (profile.mode === 'signal') {
        for (const item of signalCandidates(analyses, profile)) {
          if (held.length + pending.filter(o => o.side === 'BUY').length >= profile.maxPositions) break;
          if (held.includes(item.symbol) || pendingBuy(item.symbol)) continue;
          pending.push({ symbol: item.symbol, side: 'BUY', analysis: item.analysis });
        }
      } else {
        const { targets } = rankTargets(analyses, profile, held);
        const targetSet = new Set(targets);
        for (const symbol of held) {
          if (!targetSet.has(symbol) && barsNow.has(symbol)) pending.push({ symbol, side: 'SELL', reason: '리밸런싱 제외' });
        }
        for (const symbol of targets) {
          if (held.includes(symbol) || pendingBuy(symbol)) continue;
          const item = analyses.find(a => a.symbol === symbol);
          pending.push({ symbol, side: 'BUY', analysis: item.analysis });
        }
      }
    }

    if (positions.size > 0) exposureBars += 1;
    equityCurve.push({ time, equity: equity() });
    step += 1;
  }

  return summarize({ equityCurve, trades, initialEquity, barsPerYear, exposureBars });
}

/** 종목별·봉별 분석을 한 번만 계산(지표 기간이 같은 그리드 후보끼리 공유). */
export function precomputeAnalyses(seriesBySymbol, periods) {
  const warmup = minimumBars(periods);
  const cache = new Map();
  for (const [symbol, bars] of seriesBySymbol) {
    const list = new Array(bars.length).fill(null);
    for (let i = warmup; i < bars.length; i += 1) list[i] = analyzeAt(bars, i, periods);
    cache.set(symbol, list);
  }
  return cache;
}

export function summarize({ equityCurve, trades, initialEquity, barsPerYear, exposureBars }) {
  if (equityCurve.length < 2) {
    return { bars: equityCurve.length, totalReturnPercent: 0, cagrPercent: 0, maxDrawdownPercent: 0, sharpe: 0, trades: trades.length, winRatePercent: 0, exposurePercent: 0, tradeList: trades, barReturns: [] };
  }
  const finalEquity = equityCurve.at(-1).equity;
  let peak = initialEquity;
  let maxDrawdown = 0;
  const returns = [];
  let previous = initialEquity;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - point.equity) / peak);
    returns.push(point.equity / previous - 1);
    previous = point.equity;
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  const sd = Math.sqrt(variance);
  const years = equityCurve.length / barsPerYear;
  const wins = trades.filter(trade => trade.returnPercent > 0).length;
  return {
    bars: equityCurve.length,
    startTime: equityCurve[0].time,
    endTime: equityCurve.at(-1).time,
    totalReturnPercent: (finalEquity / initialEquity - 1) * 100,
    cagrPercent: years > 0 && finalEquity > 0 ? ((finalEquity / initialEquity) ** (1 / years) - 1) * 100 : 0,
    maxDrawdownPercent: maxDrawdown * 100,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(barsPerYear) : 0,
    trades: trades.length,
    winRatePercent: trades.length > 0 ? (wins / trades.length) * 100 : 0,
    avgTradeReturnPercent: trades.length > 0 ? trades.reduce((s, t) => s + t.returnPercent, 0) / trades.length : 0,
    exposurePercent: (exposureBars / equityCurve.length) * 100,
    tradeList: trades,
    // 봉별 자산 수익률(같은 창의 후보끼리 시간축이 같다) — 과적합 진단(CSCV/DSR)용.
    barReturns: returns
  };
}

/** 같은 기간 동일가중 바이앤홀드(비교 기준). */
export function buyAndHoldReturn(seriesBySymbol, startTime, endTime, symbols = [...seriesBySymbol.keys()]) {
  const returns = [];
  for (const symbol of symbols) {
    const bars = (seriesBySymbol.get(symbol) || []).filter(bar => bar.time >= startTime && bar.time <= endTime);
    if (bars.length >= 2) returns.push(bars.at(-1).close / bars[0].open - 1);
  }
  return returns.length > 0 ? (returns.reduce((a, b) => a + b, 0) / returns.length) * 100 : 0;
}
