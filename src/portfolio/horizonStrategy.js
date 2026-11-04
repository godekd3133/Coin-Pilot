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

/** 벤치마크 국면: 하락 추세면 신규 진입 금지. 데이터가 없으면 허용(필터 비활성). */
export function regimeAllowsEntries(benchmarkAnalysis) {
  if (!benchmarkAnalysis?.available) return true;
  return benchmarkAnalysis.regime !== 'downtrend';
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
    return { exit: true, reason: 'ATR 손절/트레일링', price: Math.min(bar.open, position.stopPrice), stopPrice, highestClose };
  }
  if ((position.barsHeld || 0) + 1 >= profile.maxHoldBars) {
    return { exit: true, reason: '최대 보유기간', price: bar.close, stopPrice, highestClose };
  }
  if (profile.mode === 'signal' && analysis?.available && analysis.score <= profile.exitScore) {
    return { exit: true, reason: `차트 점수 악화 (${analysis.score})`, price: bar.close, stopPrice, highestClose };
  }
  if (profile.regimeExit && !benchmarkOk) {
    return { exit: true, reason: '시장 하락 국면 전환', price: bar.close, stopPrice, highestClose };
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
