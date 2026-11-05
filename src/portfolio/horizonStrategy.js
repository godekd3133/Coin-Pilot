// 슬리브 의사결정(백테스트·실시간 공통). 상태 변경 없이 "무엇을 해야 하는지"만 반환한다.

import { analyzeChart } from './chartAnalysis.js';

/** 분석 창: EMA 수렴에 충분한 길이로 잘라 계산 비용을 제한한다. */
export function analysisWindow(bars, end, periods) {
  const span = Math.max(300, (periods?.emaLong || 100) * 3);
  return bars.slice(Math.max(0, end - span + 1), end + 1);
}

export function analyzeAt(bars, end, periods) {
  return analyzeChart(analysisWindow(bars, end, periods), periods);
}

/**
 * 벤치마크 국면: 하락 추세면 신규 진입 금지.
 * `required`(국면 필터가 켜진 슬리브의 신규 진입)이면 데이터가 없을 때도 막는다
 * (fail-closed). 청산 판단은 데이터 공백을 하락으로 오인해 팔지 않도록 required 없이 쓴다.
 */
export function regimeAllowsEntries(benchmarkAnalysis, { required = false } = {}) {
  if (!benchmarkAnalysis?.available) return !required;
  return benchmarkAnalysis.regime !== 'downtrend';
}

/**
 * 한 호가 단위가 가격에서 차지하는 비율(추정). 1원 호가의 130원 코인은 한 칸이 0.77%라
 * 0.15% 비용 가정으로는 연구와 모의가 저가 종목 쪽으로 치우친다.
 * coin: 업비트 KRW 1,000원 미만 구간은 가격 자릿수보다 두 자리 아래가 호가 단위.
 * stock: KRX 호가가격단위.
 */
export function tickFraction(price, assetClass = 'coin') {
  const p = Number(price);
  if (!(p > 0)) return Infinity;
  if (assetClass === 'stock') {
    const tick = p < 2000 ? 1 : p < 5000 ? 5 : p < 20000 ? 10 : p < 50000 ? 50 : p < 200000 ? 100 : p < 500000 ? 500 : 1000;
    return tick / p;
  }
  if (p >= 1000) return 0;
  const tick = 10 ** (Math.floor(Math.log10(p)) - 2);
  return tick / p;
}

/** 호가 한 칸 비용이 상한(기본 0.25%)을 넘는 종목은 신규 진입하지 않는다. */
export const MAX_ENTRY_TICK_FRACTION = 0.0025;
export function passesTickCost(price, assetClass = 'coin', max = MAX_ENTRY_TICK_FRACTION) {
  return tickFraction(price, assetClass) <= max;
}

/**
 * 보유 포지션 청산 판단.
 * @param {object} position { entryPrice, stopPrice, highestClose, barsHeld }
 * @param {object} bar 최신 완료 봉
 * @param {object} analysis 최신 분석
 * @param {object} profile 슬리브
 * @returns {{exit:boolean, reason?:string, price?:number, stopPrice:number, highestClose:number}}
 */
export function evaluateExit(position, bar, analysis, profile, { benchmarkOk = true } = {}) {
  const highestClose = Math.max(position.highestClose || position.entryPrice, bar.close);
  let stopPrice = position.stopPrice;
  if (analysis?.available && Number.isFinite(analysis.atr)) {
    stopPrice = Math.max(stopPrice, highestClose - profile.atrStopMultiple * analysis.atr);
  }
  if (bar.low <= position.stopPrice) {
    // 갭 하락이면 시가에 체결된 것으로 본다.
    return { exit: true, reason: 'ATR 손절/트레일링', price: Math.min(bar.open, position.stopPrice), stopPrice, highestClose, timing: 'intrabar' };
  }
  // 아래 청산은 봉 마감 후에야 알 수 있는 판단이다. 백테스트는 다음 봉 시가(+비용)로
  // 체결한다(timing: 'next_open'). price는 판단 시점 종가(참고용)이며 실시간 엔진은 현재가로 판다.
  if ((position.barsHeld || 0) + 1 >= profile.maxHoldBars) {
    return { exit: true, reason: '최대 보유기간', price: bar.close, stopPrice, highestClose, timing: 'next_open' };
  }
  if (profile.mode === 'signal' && analysis?.available && analysis.score <= profile.exitScore) {
    return { exit: true, reason: `차트 점수 악화 (${analysis.score})`, price: bar.close, stopPrice, highestClose, timing: 'next_open' };
  }
  if (profile.regimeExit && !benchmarkOk) {
    return { exit: true, reason: '시장 하락 국면 전환', price: bar.close, stopPrice, highestClose, timing: 'next_open' };
  }
  return { exit: false, stopPrice, highestClose };
}

/** signal 슬리브 진입 후보: 점수 기준 이상, 하락 추세 제외, 점수순. */
/** 변동성 과대(ATR% 상한 초과) 종목은 진입 대상에서 제외한다. */
export function volatilityAllowed(analysis, profile) {
  return !(profile.maxAtrPercent > 0) || (Number.isFinite(analysis?.atrPercent) && analysis.atrPercent <= profile.maxAtrPercent);
}

export function signalCandidates(analyses, profile) {
  return analyses
    .filter(item => item.analysis?.available && item.analysis.score >= profile.entryScore && item.analysis.regime !== 'downtrend' && volatilityAllowed(item.analysis, profile))
    .sort((a, b) => b.analysis.score - a.analysis.score);
}

/**
 * rank 슬리브 목표 보유 종목: 점수 상위 maxPositions(기준 이상, 하락 추세 제외).
 * 기존 보유 종목은 점수가 exitScore 이상이고 상위 2N 안이면 유지(회전율 억제).
 */
export function rankTargets(analyses, profile, heldSymbols = []) {
  const ranked = analyses
    .filter(item => item.analysis?.available)
    .sort((a, b) => b.analysis.score - a.analysis.score);
  const keep = new Set();
  const held = new Set(heldSymbols);
  ranked.slice(0, profile.maxPositions * 2).forEach(item => {
    if (held.has(item.symbol) && item.analysis.score >= profile.exitScore && item.analysis.regime !== 'downtrend') keep.add(item.symbol);
  });
  const targets = [...keep];
  for (const item of ranked) {
    if (targets.length >= profile.maxPositions) break;
    if (keep.has(item.symbol)) continue;
    if (item.analysis.score >= profile.entryScore && item.analysis.regime !== 'downtrend' && volatilityAllowed(item.analysis, profile)) targets.push(item.symbol);
  }
  return { targets: targets.slice(0, profile.maxPositions), scores: new Map(ranked.map(item => [item.symbol, item.analysis.score])) };
}

export function initialStop(entryPrice, analysis, profile) {
  const atr = Number.isFinite(analysis?.atr) ? analysis.atr : entryPrice * 0.05;
  return entryPrice - profile.atrStopMultiple * atr;
}

/**
 * 위험 기반 포지션 크기: 손절 시 손실이 슬리브 자산의 riskPerTradePercent%가 되도록 한다.
 * riskPerTradePercent가 0이면 슬롯 균등(자산/maxPositions)만 사용.
 */
export function positionBudget({ sleeveEquity, maxPositions, riskPerTradePercent = 0, entryPrice, stopPrice }) {
  const slot = sleeveEquity / Math.max(1, maxPositions);
  if (!(riskPerTradePercent > 0)) return slot;
  const stopDistance = Math.max(0.005, (entryPrice - stopPrice) / entryPrice);
  return Math.min(slot, (sleeveEquity * riskPerTradePercent / 100) / stopDistance);
}

/** 업비트 KRW 최소 주문금액. */
export const COIN_MIN_ORDER_AMOUNT = 5000;

/**
 * 진입 금액(실시간·백테스트 공통). 0이면 진입 불가.
 * - coin: 손절 후에도 최소 주문금액을 넘도록 한 최소 진입액(minEntry) 미만이면, 슬리브 잔여 예산이
 *   minEntry의 70% 이상이고 현금이 충분할 때만 minEntry로 올리고 아니면 0.
 * - stock: 1주(가격×1.002) 미만이면 같은 규칙으로 1주로 올리거나 0. 실제 수량은 호출 측에서 정수 주로 내림.
 */
export function entryAmount({ assetClass = 'coin', slot, remaining, cash, price, stopPrice, minOrderAmount = COIN_MIN_ORDER_AMOUNT }) {
  let amount = Math.min(slot, remaining, cash * 0.98);
  if (assetClass === 'coin') {
    const stopDistance = Math.min(0.5, Math.max(0, (price - stopPrice) / price));
    const minEntry = Math.ceil((minOrderAmount / (1 - stopDistance - 0.01)) / 100) * 100;
    // 소액 시드: 슬리브 예산이 최소 진입액의 70% 이상 남아 있으면 최소 진입액으로 올린다.
    if (amount < minEntry && remaining >= minEntry * 0.7 && cash * 0.98 >= minEntry) amount = minEntry;
    return amount >= minEntry ? Math.floor(amount) : 0;
  }
  // 주식: 1주 단위. 예산이 1주보다 작아도 남은 슬리브 예산·현금으로 1주를 살 수 있으면 1주.
  const unit = price * 1.002;
  if (amount < unit && remaining >= unit * 0.7 && cash * 0.98 >= unit) amount = unit;
  return amount >= unit ? amount : 0;
}
