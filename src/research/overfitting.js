// 백테스트 과적합 진단 — Deflated Sharpe Ratio(DSR)와 CSCV 기반 PBO.
//
// - Bailey & López de Prado (2014) "The Deflated Sharpe Ratio": 후보 N개 중 최상을
//   고르면 귀무가설(진짜 엣지 0)에서도 Sharpe 최댓값이 양수로 부풀려진다. 그 기대
//   최댓값을 벤치마크로 삼아 비정규성(왜도/첨도)을 반영한 PSR을 계산한다.
// - Bailey, Borwein, López de Prado & Zhu (2017) "The Probability of Backtest
//   Overfitting": 시간 축을 S개 구간으로 나누고 C(S, S/2) 조합마다 학습 절반에서
//   최상 후보를 골라 검증 절반에서의 상대 순위 logit을 본다. PBO = logit ≤ 0 비율.
//
// 순수 모듈이다(I/O·의존성 없음). 결과는 현재 report-only 진단이며 승격/실거래
// 게이트를 바꾸지 않는다. `wouldFailGate`는 장래 게이트 후보 표시일 뿐이다.

export const EULER_MASCHERONI = 0.5772156649015329;
export const DEFAULT_DSR_THRESHOLD = 0.95;
export const DEFAULT_PBO_THRESHOLD = 0.5;

const finite = value => typeof value === 'number' && Number.isFinite(value);

/** 표준정규 CDF Φ(x). erfc Chebyshev 근사(Numerical Recipes, 상대오차 < 1.2e-7). */
export function normalCdf(x) {
  if (x === Infinity) return 1;
  if (x === -Infinity) return 0;
  if (!finite(x)) return NaN;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * z);
  const erfcZ = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 +
    t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 +
    t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? 1 - 0.5 * erfcZ : 0.5 * erfcZ;
}

const ACKLAM_A = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
  1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
const ACKLAM_B = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
  6.680131188771972e+01, -1.328068155288572e+01];
const ACKLAM_C = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
  -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
const ACKLAM_D = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
  3.754408661907416e+00];

/** 표준정규 역CDF Φ⁻¹(p). Acklam 유리 근사(상대오차 < 1.15e-9). */
export function normalInverseCdf(p) {
  if (!finite(p) || p < 0 || p > 1) return NaN;
  if (p === 0) return -Infinity;
  if (p === 1) return Infinity;
  const pLow = 0.02425;
  const tail = q => (((((ACKLAM_C[0] * q + ACKLAM_C[1]) * q + ACKLAM_C[2]) * q + ACKLAM_C[3]) * q +
    ACKLAM_C[4]) * q + ACKLAM_C[5]) / ((((ACKLAM_D[0] * q + ACKLAM_D[1]) * q + ACKLAM_D[2]) * q +
    ACKLAM_D[3]) * q + 1);
  if (p < pLow) return tail(Math.sqrt(-2 * Math.log(p)));
  if (p > 1 - pLow) return -tail(Math.sqrt(-2 * Math.log(1 - p)));
  const q = p - 0.5;
  const r = q * q;
  return (((((ACKLAM_A[0] * r + ACKLAM_A[1]) * r + ACKLAM_A[2]) * r + ACKLAM_A[3]) * r +
    ACKLAM_A[4]) * r + ACKLAM_A[5]) * q / (((((ACKLAM_B[0] * r + ACKLAM_B[1]) * r +
    ACKLAM_B[2]) * r + ACKLAM_B[3]) * r + ACKLAM_B[4]) * r + 1);
}

function cleanReturns(returns) {
  return (Array.isArray(returns) || ArrayBuffer.isView(returns) ? Array.from(returns) : [])
    .map(Number)
    .filter(finite);
}

/**
 * 수익률 표본의 평균·표준편차·Sharpe·왜도·첨도.
 * - sharpe: 기간당(비연율화) mean / 표본표준편차(n-1). n<2 또는 분산 0이면 null.
 * - skewness: 모멘트 기반 m3 / m2^1.5. kurtosis: **원시(raw) 첨도** m4 / m2² (정규=3).
 */
export function returnMoments(returns) {
  const values = cleanReturns(returns);
  const n = values.length;
  if (n === 0) return { count: 0, mean: null, stdDev: null, sharpe: null, skewness: null, kurtosis: null };
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const value of values) {
    const d = value - mean;
    const d2 = d * d;
    m2 += d2;
    m3 += d2 * d;
    m4 += d2 * d2;
  }
  const sampleVariance = n > 1 ? m2 / (n - 1) : null;
  const stdDev = sampleVariance === null ? null : Math.sqrt(sampleVariance);
  m2 /= n;
  m3 /= n;
  m4 /= n;
  const degenerate = !(m2 > 1e-24);
  return {
    count: n,
    mean,
    stdDev,
    sharpe: stdDev !== null && stdDev > 1e-12 ? mean / stdDev : null,
    skewness: degenerate ? null : m3 / m2 ** 1.5,
    kurtosis: degenerate ? null : m4 / (m2 * m2)
  };
}

export const sharpeRatio = returns => returnMoments(returns).sharpe;
export const skewness = returns => returnMoments(returns).skewness;
export const kurtosis = returns => returnMoments(returns).kurtosis;

/** 표본 분산(n-1). 유한값 2개 미만이면 null. */
export function sampleVariance(values) {
  const clean = cleanReturns(values);
  if (clean.length < 2) return null;
  const mean = clean.reduce((sum, value) => sum + value, 0) / clean.length;
  return clean.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (clean.length - 1);
}

/**
 * Probabilistic Sharpe Ratio: 관측 Sharpe가 benchmark보다 클 확률.
 * PSR = Φ((SR − SR*)·√(T−1) / √(1 − γ3·SR + (γ4 − 1)/4·SR²)), γ4는 원시 첨도.
 */
export function probabilisticSharpeRatio({ sharpe, benchmark = 0, sampleLength, skewness: skew = 0, kurtosis: kurt = 3 }) {
  if (!finite(sharpe)) return { psr: null, reason: 'sharpe_unavailable' };
  if (!finite(benchmark)) return { psr: null, reason: 'benchmark_unavailable' };
  if (!finite(sampleLength) || sampleLength < 2) return { psr: null, reason: 'insufficient_sample_length' };
  const g3 = finite(skew) ? skew : 0;
  const g4 = finite(kurt) ? kurt : 3;
  const denominatorSquared = 1 - g3 * sharpe + ((g4 - 1) / 4) * sharpe * sharpe;
  if (!(denominatorSquared > 0)) return { psr: null, reason: 'non_positive_sharpe_variance' };
  const z = ((sharpe - benchmark) * Math.sqrt(sampleLength - 1)) / Math.sqrt(denominatorSquared);
  return { psr: normalCdf(z), z };
}

/**
 * 귀무가설(모든 후보의 진짜 Sharpe=0)에서 N회 시행 최대 Sharpe의 기대값.
 * E[max] ≈ √V·((1−γ)Φ⁻¹(1−1/N) + γΦ⁻¹(1−1/(N·e))). N ≤ 1이면 0.
 */
export function expectedMaxSharpe({ trials, sharpeVariance }) {
  const n = Math.floor(Number(trials));
  if (!finite(n) || n <= 1) return 0;
  if (!finite(sharpeVariance) || sharpeVariance < 0) return null;
  return Math.sqrt(sharpeVariance) * (
    (1 - EULER_MASCHERONI) * normalInverseCdf(1 - 1 / n) +
    EULER_MASCHERONI * normalInverseCdf(1 - 1 / (n * Math.E))
  );
}

/**
 * Deflated Sharpe Ratio (Bailey & López de Prado 2014).
 * sharpe·sharpeVariance는 같은 단위(기간당 또는 거래당, 비연율화)여야 한다.
 * @returns {{ dsr: number|null, expectedMaxSharpe: number|null, psr: number|null, reason?: string }}
 *   psr은 benchmark 0 대비(편향 보정 전), dsr은 기대 최대 Sharpe 대비 PSR이다.
 */
export function deflatedSharpeRatio({ sharpe, trials = 1, sampleLength, skewness: skew = 0, kurtosis: kurt = 3, sharpeVariance = null }) {
  const raw = probabilisticSharpeRatio({ sharpe, benchmark: 0, sampleLength, skewness: skew, kurtosis: kurt });
  const benchmark = expectedMaxSharpe({ trials, sharpeVariance });
  if (benchmark === null) {
    return { dsr: null, expectedMaxSharpe: null, psr: raw.psr, reason: 'sharpe_variance_unavailable' };
  }
  const deflated = probabilisticSharpeRatio({ sharpe, benchmark, sampleLength, skewness: skew, kurtosis: kurt });
  return {
    dsr: deflated.psr,
    expectedMaxSharpe: benchmark,
    psr: raw.psr,
    ...(deflated.reason ? { reason: deflated.reason } : {})
  };
}

function* combinations(n, k, start = 0, prefix = []) {
  if (prefix.length === k) { yield prefix; return; }
  for (let i = start; i <= n - (k - prefix.length); i += 1) {
    yield* combinations(n, k, i + 1, [...prefix, i]);
  }
}

function performance(sum, sumSq, count, metric) {
  if (count <= 0) return 0;
  const mean = sum / count;
  if (metric === 'mean') return mean;
  const variance = count > 1 ? (sumSq - count * mean * mean) / (count - 1) : 0;
  if (!(variance > 1e-24)) return mean > 0 ? Infinity : mean < 0 ? -Infinity : 0;
  return mean / Math.sqrt(variance);
}

function summarizeLogits(logits) {
  if (logits.length === 0) return { count: 0, mean: null, median: null, min: null, max: null };
  const sorted = [...logits].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    min: sorted[0],
    max: sorted.at(-1)
  };
}

/**
 * CSCV Probability of Backtest Overfitting (Bailey et al. 2017).
 * @param {Array<ArrayLike<number>>} matrix 행=시간 버킷(시간순), 열=후보. 비유한값은 0으로 본다.
 * @param {{ partitions?: number, metric?: 'sharpe'|'mean' }} options
 * @returns {{ pbo: number|null, reason?: string, combinations?: number, partitions?: number,
 *   candidates?: number, timeBuckets?: number, logits?: object }}
 */
export function probabilityOfBacktestOverfitting(matrix, { partitions = 8, metric = 'sharpe' } = {}) {
  const rows = Array.isArray(matrix) ? matrix : [];
  const S = Math.floor(Number(partitions));
  if (!(S >= 2) || S % 2 !== 0) return { pbo: null, reason: 'partitions_must_be_even_and_at_least_2' };
  const T = rows.length;
  const N = T > 0 ? rows[0]?.length ?? 0 : 0;
  if (N < 2) return { pbo: null, reason: 'insufficient_candidates', candidates: N, timeBuckets: T };
  if (T < 2 * S) return { pbo: null, reason: 'insufficient_time_buckets', candidates: N, timeBuckets: T };
  if (rows.some(row => !row || row.length !== N)) return { pbo: null, reason: 'ragged_matrix' };

  const value = (row, n) => (finite(row[n]) ? row[n] : 0);
  let varies = false;
  for (let t = 0; t < T && !varies; t += 1) {
    const first = value(rows[t], 0);
    for (let n = 1; n < N; n += 1) {
      if (value(rows[t], n) !== first) { varies = true; break; }
    }
  }
  if (!varies) return { pbo: null, reason: 'no_cross_candidate_variation', candidates: N, timeBuckets: T };

  const sums = [];
  const sumSqs = [];
  const counts = [];
  for (let p = 0; p < S; p += 1) {
    const from = Math.round((p * T) / S);
    const to = Math.round(((p + 1) * T) / S);
    const sum = new Float64Array(N);
    const sumSq = new Float64Array(N);
    for (let t = from; t < to; t += 1) {
      const row = rows[t];
      for (let n = 0; n < N; n += 1) {
        const v = value(row, n);
        sum[n] += v;
        sumSq[n] += v * v;
      }
    }
    sums.push(sum);
    sumSqs.push(sumSq);
    counts.push(to - from);
  }

  const logits = [];
  const trainSum = new Float64Array(N);
  const trainSq = new Float64Array(N);
  const testSum = new Float64Array(N);
  const testSq = new Float64Array(N);
  for (const trainSet of combinations(S, S / 2)) {
    const isTrain = new Array(S).fill(false);
    for (const p of trainSet) isTrain[p] = true;
    trainSum.fill(0); trainSq.fill(0); testSum.fill(0); testSq.fill(0);
    let trainCount = 0;
    let testCount = 0;
    for (let p = 0; p < S; p += 1) {
      const [targetSum, targetSq] = isTrain[p] ? [trainSum, trainSq] : [testSum, testSq];
      if (isTrain[p]) trainCount += counts[p]; else testCount += counts[p];
      const sum = sums[p];
      const sumSq = sumSqs[p];
      for (let n = 0; n < N; n += 1) {
        targetSum[n] += sum[n];
        targetSq[n] += sumSq[n];
      }
    }
    let best = 0;
    let bestPerf = -Infinity;
    for (let n = 0; n < N; n += 1) {
      const perf = performance(trainSum[n], trainSq[n], trainCount, metric);
      if (perf > bestPerf) { bestPerf = perf; best = n; }
    }
    const bestTest = performance(testSum[best], testSq[best], testCount, metric);
    let below = 0;
    let equal = 0;
    for (let n = 0; n < N; n += 1) {
      const perf = performance(testSum[n], testSq[n], testCount, metric);
      if (perf < bestTest) below += 1;
      else if (perf === bestTest) equal += 1;
    }
    // 1(최하)..N(최상) 평균 순위 → ω ∈ (0, 1)
    const omega = (below + (equal + 1) / 2) / (N + 1);
    logits.push(Math.log(omega / (1 - omega)));
  }

  return {
    pbo: logits.filter(logit => logit <= 0).length / logits.length,
    combinations: logits.length,
    partitions: S,
    candidates: N,
    timeBuckets: T,
    metric,
    logits: summarizeLogits(logits)
  };
}

const round = (value, digits = 6) => (finite(value) ? Number(value.toFixed(digits)) : value ?? null);

/**
 * 선택된 후보의 과적합 진단 리포트(report-only).
 * @param {object} input
 * @param {number[]} input.selectedReturns 선택 후보의 수익률 표본(거래당 또는 기간당)
 * @param {number[]} input.candidateSharpes 같은 단위의 후보별 Sharpe(유한값만 분산에 사용)
 * @param {number} input.trials 평가한 후보 수(그리드 상관을 무시하므로 보수적)
 * @param {Array<ArrayLike<number>>|null} [input.matrix] CSCV 행렬. 없으면 pbo=null
 * @param {string} [input.pboUnavailableReason] matrix가 없을 때의 사유
 * @param {string} input.sampleKind 'trade_returns' | 'bar_returns'
 */
export function assessSelectionOverfitting({
  selectedReturns = [],
  candidateSharpes = [],
  trials = 1,
  matrix = null,
  partitions = 8,
  pboUnavailableReason = 'candidate_return_matrix_unavailable',
  sampleKind = 'trade_returns',
  dsrThreshold = DEFAULT_DSR_THRESHOLD,
  pboThreshold = DEFAULT_PBO_THRESHOLD
} = {}) {
  const moments = returnMoments(selectedReturns);
  const finiteSharpes = cleanReturns(candidateSharpes);
  const trialCount = Math.max(1, Math.floor(Number(trials) || 1));
  const sharpeVariance = sampleVariance(finiteSharpes);
  const dsr = deflatedSharpeRatio({
    sharpe: moments.sharpe,
    trials: trialCount,
    sampleLength: moments.count,
    skewness: moments.skewness ?? 0,
    kurtosis: moments.kurtosis ?? 3,
    sharpeVariance
  });
  const dsrReason = dsr.reason || (moments.sharpe === null
    ? (moments.count < 2 ? 'insufficient_selected_samples' : 'selected_sharpe_unavailable')
    : null);
  const pboResult = matrix
    ? probabilityOfBacktestOverfitting(matrix, { partitions })
    : { pbo: null, reason: pboUnavailableReason };

  const wouldFailReasons = [];
  if (dsr.dsr === null) wouldFailReasons.push('dsr_unavailable');
  else if (dsr.dsr < dsrThreshold) wouldFailReasons.push('dsr_below_threshold');
  if (pboResult.pbo !== null && pboResult.pbo > pboThreshold) wouldFailReasons.push('pbo_above_threshold');

  return {
    reportOnly: true,
    gateApplied: false,
    method: 'deflated_sharpe_ratio+cscv_pbo',
    sampleKind,
    trials: trialCount,
    sharpeTrials: finiteSharpes.length,
    sampleLength: moments.count,
    sharpe: round(moments.sharpe),
    skewness: round(moments.skewness),
    kurtosis: round(moments.kurtosis),
    sharpeVariance: round(sharpeVariance, 8),
    dsr: round(dsr.dsr),
    expectedMaxSharpe: round(dsr.expectedMaxSharpe),
    psr: round(dsr.psr),
    dsrReason,
    pbo: round(pboResult.pbo),
    pboReason: pboResult.reason || null,
    pboCombinations: pboResult.combinations ?? null,
    pboPartitions: pboResult.partitions ?? null,
    pboTimeBuckets: pboResult.timeBuckets ?? null,
    pboLogits: pboResult.logits
      ? Object.fromEntries(Object.entries(pboResult.logits).map(([key, v]) => [key, round(v)]))
      : null,
    dsrThreshold,
    pboThreshold,
    wouldFailGate: wouldFailReasons.length > 0,
    wouldFailReasons
  };
}

/**
 * 시장별 결과에서 리포트 최상위 요약을 만든다. 하나라도 진단이 없거나 wouldFailGate면
 * 전체 wouldFailGate=true(장래 게이트도 fail-closed가 되도록). 현재 승격 판정에는 쓰지 않는다.
 * @param {Array<{ market: string, validation?: { overfitting?: object } }>} results
 */
export function summarizeOverfittingReport(results = []) {
  const markets = (Array.isArray(results) ? results : []).map(result => {
    const o = result?.validation?.overfitting;
    if (!o) return { market: result?.market ?? null, available: false, wouldFailGate: true, wouldFailReasons: ['overfitting_unavailable'] };
    return {
      market: result.market,
      available: true,
      trials: o.trials,
      sampleLength: o.sampleLength,
      sharpe: o.sharpe,
      dsr: o.dsr,
      expectedMaxSharpe: o.expectedMaxSharpe,
      psr: o.psr,
      pbo: o.pbo,
      pboReason: o.pboReason,
      wouldFailGate: o.wouldFailGate,
      wouldFailReasons: o.wouldFailReasons
    };
  });
  return {
    reportOnly: true,
    gateApplied: false,
    method: 'deflated_sharpe_ratio+cscv_pbo',
    dsrThreshold: DEFAULT_DSR_THRESHOLD,
    pboThreshold: DEFAULT_PBO_THRESHOLD,
    markets,
    wouldFailGate: markets.length === 0 || markets.some(market => market.wouldFailGate !== false),
    note: '선택 편향 진단(report-only)입니다. promoted/live gate 판정을 바꾸지 않습니다.'
  };
}
