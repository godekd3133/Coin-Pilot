// 슬리브 단위 포트폴리오 백테스트.
// - 신호는 봉 t의 종가로 계산하고 체결은 다음 봉 시가(+비용)로 한다(미래 참조 없음).
// - 손절/트레일링은 봉 저가로 판정, 갭 하락은 시가 체결.
// - 슬롯 균등 배분: 진입 시 (현재 평가자산 / maxPositions) 만큼 매수.
// - 벤치마크 국면 필터·국면 청산은 실시간 엔진과 같은 함수를 쓴다.

import { analyzeAt, evaluateExit, signalCandidates, rankTargets, initialStop, regimeAllowsEntries, positionBudget } from './horizonStrategy.js';
import { minimumBars } from './chartAnalysis.js';

function buildTimeline(seriesBySymbol) {
  const times = new Set();
  for (const bars of seriesBySymbol.values()) for (const bar of bars) times.add(bar.time);
  return [...times].sort((a, b) => a - b);
}

/**
 * @param {Map<string, Array>} seriesBySymbol 시간순 봉
 * @param {object} profile 슬리브(resolveHorizonProfiles 결과)
 * @param {object} options { costs:{buyCostRate,sellCostRate}, benchmark?:string, startTime?, endTime?, initialEquity?, barsPerYear }
 */
export function runSleeveBacktest(seriesBySymbol, profile, options = {}) {
  const { costs, benchmark = null, startTime = -Infinity, endTime = Infinity, initialEquity = 1_000_000, barsPerYear = 365 } = options;
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

  let cash = initialEquity;
  const positions = new Map();
  const pending = []; // { symbol, side, reason, analysis }
  const trades = [];
  const equityCurve = [];
  let step = 0;
  let exposureBars = 0;

  const priceOf = (symbol) => {
    const bars = seriesBySymbol.get(symbol);
    const index = indexBySymbol.get(symbol);
    return index >= 0 ? bars[index].close : null;
  };
  const equity = () => {
    let total = cash;
    for (const [symbol, position] of positions) total += position.quantity * (priceOf(symbol) ?? position.entryPrice);
    return total;
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

    // 1) 직전 봉에서 결정된 주문을 이번 봉 시가로 체결
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const order = pending[i];
      const now = barsNow.get(order.symbol);
      if (!now) continue;
      pending.splice(i, 1);
      const open = now.bar.open;
      if (order.side === 'SELL') {
        const position = positions.get(order.symbol);
        if (!position) continue;
        const proceeds = position.quantity * open * (1 - costs.sellCostRate);
        cash += proceeds;
        trades.push({ symbol: order.symbol, entryTime: position.entryTime, exitTime: time, entryPrice: position.entryPrice, exitPrice: open, returnPercent: (proceeds / position.cost - 1) * 100, reason: order.reason, bars: position.barsHeld });
        positions.delete(order.symbol);
      } else if (!positions.has(order.symbol) && positions.size < profile.maxPositions) {
        const stopPrice = initialStop(open, order.analysis, profile);
        const budget = Math.min(cash, positionBudget({
          sleeveEquity: equity(),
          maxPositions: profile.maxPositions,
          riskPerTradePercent: profile.riskPerTradePercent,
          entryPrice: open,
          stopPrice
        }));
        if (budget <= 0) continue;
        const quantity = (budget * (1 - costs.buyCostRate)) / open;
        cash -= budget;
        positions.set(order.symbol, {
          quantity,
          entryPrice: open,
          cost: budget,
          entryTime: time,
          stopPrice,
          highestClose: open,
          barsHeld: 0
        });
      }
    }

    // 2) 이번 봉 마감 기준 분석
    const benchmarkSeries = benchmark ? seriesBySymbol.get(benchmark) : null;
    const benchmarkIndex = benchmark ? indexBySymbol.get(benchmark) : -1;
    const benchmarkAnalysis = profile.regimeFilter && benchmarkSeries && benchmarkIndex >= warmup
      ? analysisFor(benchmark, benchmarkIndex)
      : null;
    const benchmarkOk = regimeAllowsEntries(benchmarkAnalysis);

    // 3) 보유 포지션 청산(손절은 봉 내 즉시, 나머지는 종가 체결)
    for (const [symbol, position] of [...positions]) {
      const now = barsNow.get(symbol);
      if (!now) continue;
      const analysis = analysisFor(symbol, now.index);
      const decision = evaluateExit(position, now.bar, analysis, profile, { benchmarkOk });
      position.stopPrice = decision.stopPrice;
      position.highestClose = decision.highestClose;
      position.barsHeld += 1;
      if (decision.exit) {
        const proceeds = position.quantity * decision.price * (1 - costs.sellCostRate);
        cash += proceeds;
        trades.push({ symbol, entryTime: position.entryTime, exitTime: time, entryPrice: position.entryPrice, exitPrice: decision.price, returnPercent: (proceeds / position.cost - 1) * 100, reason: decision.reason, bars: position.barsHeld });
        positions.delete(symbol);
      }
    }

    // 4) 신규 진입/리밸런싱 결정 → 다음 봉 시가 체결
    const shouldRebalance = profile.mode === 'signal' || step % profile.rebalanceBars === 0;
    if (shouldRebalance && (benchmarkOk || !profile.regimeFilter)) {
      const analyses = [];
      for (const [symbol, now] of barsNow) {
        if (symbol === benchmark && options.excludeBenchmark) continue;
        if (now.index < warmup) continue;
        analyses.push({ symbol, analysis: analysisFor(symbol, now.index) });
      }
      if (profile.mode === 'signal') {
        for (const item of signalCandidates(analyses, profile)) {
          if (positions.size + pending.filter(o => o.side === 'BUY').length >= profile.maxPositions) break;
          if (positions.has(item.symbol) || pending.some(o => o.symbol === item.symbol)) continue;
          pending.push({ symbol: item.symbol, side: 'BUY', analysis: item.analysis });
        }
      } else {
        const { targets } = rankTargets(analyses, profile, [...positions.keys()]);
        const targetSet = new Set(targets);
        for (const symbol of positions.keys()) {
          if (!targetSet.has(symbol) && barsNow.has(symbol)) pending.push({ symbol, side: 'SELL', reason: '리밸런싱 제외' });
        }
        for (const symbol of targets) {
          if (positions.has(symbol)) continue;
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
    return { bars: equityCurve.length, totalReturnPercent: 0, cagrPercent: 0, maxDrawdownPercent: 0, sharpe: 0, trades: trades.length, winRatePercent: 0, exposurePercent: 0, tradeList: trades };
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
    tradeList: trades
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
