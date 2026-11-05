// 기간별 슬리브 워크포워드 연구.
// 1) 확장 창 워크포워드 3 fold: [처음~50%]→[50~67%], [~67%]→[67~84%], [~84%]→[84~100%]
// 2) 각 fold 학습 구간에서 파라미터 그리드를 평가해 고르고(거래 부족·과도 낙폭 제외),
//    손대지 않은 다음 구간에 그대로 적용한다.
// 3) 검증 구간들을 이어 붙인 수익이 양수이고 2/3 이상 fold가 손실이 아니며
//    최악 낙폭이 한도 이내일 때만 실거래에 편입한다. 아니면 비중 0(비활성).
// 4) 실거래 파라미터는 전체 기간 학습으로 고른다(성과 추정에는 쓰지 않음).
// 결과는 HORIZON_PARAMS_FILE(JSON)로 저장되어 실시간 엔진이 그대로 읽는다.

import { runSleeveBacktest, precomputeAnalyses, buyAndHoldReturn } from './horizonBacktest.js';
import { ASSET_COSTS, INTERVAL_MS } from './horizonProfiles.js';
import { assessSelectionOverfitting, sharpeRatio } from '../research/overfitting.js';

export const DEFAULT_GRID = Object.freeze({
  entryScore: [20, 30, 40, 50],
  atrStopMultiple: [2, 3, 4],
  maxPositions: [2, 4],
  regimeFilter: [true, false],
  riskPerTradePercent: [0, 1, 2]
});

function* gridCombos(grid) {
  const keys = Object.keys(grid);
  const walk = function* (index, current) {
    if (index === keys.length) { yield { ...current }; return; }
    for (const value of grid[keys[index]]) yield* walk(index + 1, { ...current, [keys[index]]: value });
  };
  yield* walk(0, {});
}

function compact(result) {
  if (!result) return null;
  const round = v => Math.round(v * 100) / 100;
  return {
    totalReturnPercent: round(result.totalReturnPercent),
    cagrPercent: round(result.cagrPercent),
    maxDrawdownPercent: round(result.maxDrawdownPercent),
    sharpe: round(result.sharpe),
    trades: result.trades,
    winRatePercent: round(result.winRatePercent),
    avgTradeReturnPercent: round(result.avgTradeReturnPercent || 0),
    exposurePercent: round(result.exposurePercent)
  };
}

export const DEFAULT_FOLDS = Object.freeze([
  [0.5, 0.67],
  [0.67, 0.84],
  [0.84, 1.0]
]);

/**
 * 학습 구간에서 후보를 고른다. 거래가 충분하고 낙폭이 한도 이내인 후보 중 Sharpe 최상.
 * 낙폭 한도를 만족하는 후보가 없으면 거래가 충분한 후보 중 수익/낙폭(Calmar) 최상.
 * 거래가 충분한 후보가 전혀 없으면 null(슬리브 불합격).
 */
function selectCandidate(candidates, { minTrades, maxDrawdownPercent }) {
  const traded = candidates.filter(c => c.train.trades >= minTrades);
  if (traded.length === 0) return null;
  const withinDrawdown = traded.filter(c => c.train.maxDrawdownPercent <= maxDrawdownPercent);
  if (withinDrawdown.length > 0) {
    return withinDrawdown.sort((a, b) => b.train.sharpe - a.train.sharpe)[0];
  }
  const calmar = c => c.train.totalReturnPercent / Math.max(1, c.train.maxDrawdownPercent);
  return traded.sort((a, b) => calmar(b) - calmar(a))[0];
}

/**
 * 선택 편향 진단(report-only). 학습 구간 모든 후보의 봉별 수익률로 CSCV PBO를,
 * 선택 후보의 봉별 수익률 + 후보 간 봉당 Sharpe 분산으로 DSR을 계산한다.
 * 승격(passed)/비중 판정에는 쓰지 않는다.
 */
export function evaluateGridOverfitting(candidates, chosen) {
  const series = candidates.map(c => c.train?.barReturns || []);
  const length = series[0]?.length ?? 0;
  const aligned = candidates.length >= 2 && length > 0 && series.every(s => s.length === length);
  const matrix = aligned
    ? Array.from({ length }, (_, row) => series.map(s => s[row]))
    : null;
  return assessSelectionOverfitting({
    selectedReturns: chosen?.train?.barReturns || [],
    candidateSharpes: series.map(s => sharpeRatio(s)),
    trials: candidates.length,
    matrix,
    partitions: 8,
    pboUnavailableReason: candidates.length < 2 ? 'single_candidate_no_selection' : 'candidate_bar_returns_misaligned',
    sampleKind: 'bar_returns'
  });
}

function evaluateGrid(series, profile, grid, common, window) {
  const candidates = [];
  for (const combo of gridCombos(grid)) {
    const train = runSleeveBacktest(series, { ...profile, ...combo }, { ...common, ...window });
    candidates.push({ params: combo, train });
  }
  return candidates;
}

/**
 * 확장 창 워크포워드: 각 fold마다 [시작, a] 학습 → [a, b] 검증.
 * 실거래 파라미터는 전체 기간 학습으로 고르고, 성과 추정은 fold 검증 결과만 사용한다.
 *
 * @param {Map<string, Array>} series 해당 슬리브 주기의 시간순 봉
 * @param {object} profile 기본 슬리브
 * @param {object} options { assetClass, benchmark, grid, folds, minTrades, maxDrawdownPercent }
 */
export function studySleeve(series, profile, options = {}) {
  const {
    assetClass = 'coin',
    benchmark = null,
    grid = DEFAULT_GRID,
    folds = DEFAULT_FOLDS,
    minTrades = 6,
    maxDrawdownPercent = 35
  } = options;
  const costs = ASSET_COSTS[assetClass];
  const barsPerYear = Math.round((365 * 24 * 60 * 60 * 1000) / INTERVAL_MS[profile.interval]);
  const times = [...new Set([...series.values()].flatMap(bars => bars.map(bar => bar.time)))].sort((a, b) => a - b);
  if (times.length < 80) return { horizon: profile.key, error: 'insufficient_history', bars: times.length, passed: false };
  const cache = precomputeAnalyses(series, profile.periods);
  const common = { costs, benchmark, barsPerYear, analysisCache: cache, assetClass };
  const at = ratio => times[Math.min(times.length - 1, Math.floor((times.length - 1) * ratio))];

  const foldResults = [];
  for (const [trainEnd, testEnd] of folds) {
    const split = at(trainEnd);
    const end = at(testEnd);
    const candidates = evaluateGrid(series, profile, grid, common, { endTime: split });
    const chosen = selectCandidate(candidates, { minTrades: Math.max(3, Math.round(minTrades * trainEnd)), maxDrawdownPercent });
    if (!chosen) {
      foldResults.push({ trainEnd: new Date(split).toISOString(), testEnd: new Date(end).toISOString(), chosenParams: null, test: null, reason: 'too_few_trades' });
      continue;
    }
    const test = runSleeveBacktest(series, { ...profile, ...chosen.params }, { ...common, startTime: split, endTime: end });
    foldResults.push({
      trainEnd: new Date(split).toISOString(),
      testEnd: new Date(end).toISOString(),
      chosenParams: chosen.params,
      train: compact(chosen.train),
      test: compact(test),
      overfitting: evaluateGridOverfitting(candidates, chosen),
      buyAndHoldPercent: Math.round(buyAndHoldReturn(series, split, end) * 100) / 100,
      benchmarkPercent: benchmark ? Math.round(buyAndHoldReturn(series, split, end, [benchmark]) * 100) / 100 : null
    });
  }

  // 검증 fold들을 이어 붙인 out-of-sample 성과
  const tested = foldResults.filter(f => f.test);
  const compounded = tested.reduce((acc, f) => acc * (1 + f.test.totalReturnPercent / 100), 1);
  const oosTrades = tested.reduce((sum, f) => sum + f.test.trades, 0);
  const nonNegativeFolds = tested.filter(f => f.test.totalReturnPercent >= 0).length;
  const worstFoldDrawdown = tested.reduce((max, f) => Math.max(max, f.test.maxDrawdownPercent), 0);
  const outOfSample = {
    folds: folds.length,
    testedFolds: tested.length,
    compoundedReturnPercent: Math.round((compounded - 1) * 10000) / 100,
    trades: oosTrades,
    nonNegativeFolds,
    worstFoldDrawdownPercent: Math.round(worstFoldDrawdown * 100) / 100,
    averageSharpe: tested.length ? Math.round((tested.reduce((s, f) => s + f.test.sharpe, 0) / tested.length) * 100) / 100 : 0
  };
  const passed = tested.length === folds.length &&
    compounded > 1 &&
    nonNegativeFolds >= Math.ceil(folds.length * 2 / 3) &&
    oosTrades >= minTrades &&
    worstFoldDrawdown <= maxDrawdownPercent;

  // 실거래 파라미터: 전체 기간 학습
  const finalCandidates = evaluateGrid(series, profile, grid, common, {});
  const finalChoice = selectCandidate(finalCandidates, { minTrades, maxDrawdownPercent });

  return {
    horizon: profile.key,
    interval: profile.interval,
    symbols: series.size,
    bars: times.length,
    period: { start: new Date(times[0]).toISOString(), end: new Date(times.at(-1)).toISOString() },
    candidatesPerFold: [...gridCombos(grid)].length,
    foldResults,
    outOfSample,
    chosenParams: finalChoice?.params ?? null,
    full: compact(finalChoice?.train),
    // report-only: passed/recommendedWeightMultiplier 판정에 쓰지 않는다.
    overfitting: finalChoice ? evaluateGridOverfitting(finalCandidates, finalChoice) : null,
    passed: passed && Boolean(finalChoice),
    recommendedWeightMultiplier: passed && finalChoice ? 1 : 0
  };
}

/** 연구 결과 → resolveHorizonProfiles(overrides) 입력. 검증 실패 슬리브는 weight 0. */
export function studyToOverrides(studyResults, baseProfiles) {
  const overrides = {};
  for (const result of studyResults) {
    if (!result) continue;
    const base = baseProfiles[result.horizon];
    overrides[result.horizon] = {
      ...(result.chosenParams || {}),
      weight: result.passed ? base.weight : 0
    };
  }
  return overrides;
}
