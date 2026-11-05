import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalCdf,
  normalInverseCdf,
  returnMoments,
  probabilisticSharpeRatio,
  expectedMaxSharpe,
  deflatedSharpeRatio,
  probabilityOfBacktestOverfitting,
  assessSelectionOverfitting,
  summarizeOverfittingReport
} from '../src/research/overfitting.js';
import { walkForwardValidate } from '../src/backtest/scalpingTuning.js';
import { studySleeve } from '../src/portfolio/horizonStudy.js';
import { resolveHorizonProfiles } from '../src/portfolio/horizonProfiles.js';

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    // mulberry32
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(random) {
  const u = Math.max(random(), 1e-12);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function noiseMatrix({ rows, cols, seed, drifts = [] }) {
  const random = seededRandom(seed);
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, (_, col) => (drifts[col] || 0) + gaussian(random)));
}

test('normal CDF / inverse CDF match known values and invert each other', () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normalCdf(1.959964) - 0.975) < 1e-6);
  assert.ok(Math.abs(normalCdf(-1.644854) - 0.05) < 1e-6);
  assert.ok(Math.abs(normalInverseCdf(0.975) - 1.959964) < 1e-5);
  assert.ok(Math.abs(normalInverseCdf(0.5)) < 1e-9);
  for (const p of [1e-6, 0.01, 0.2, 0.7, 0.99, 1 - 1e-6]) {
    assert.ok(Math.abs(normalCdf(normalInverseCdf(p)) - p) < 1e-6 * Math.max(1, p * 10), `p=${p}`);
  }
  assert.equal(normalInverseCdf(0), -Infinity);
  assert.equal(normalInverseCdf(1), Infinity);
});

test('return moments: Sharpe, skewness and raw kurtosis', () => {
  const symmetric = returnMoments([-2, -1, 0, 1, 2]);
  assert.equal(symmetric.mean, 0);
  assert.equal(symmetric.sharpe, 0);
  assert.ok(Math.abs(symmetric.skewness) < 1e-12);
  assert.ok(Math.abs(symmetric.kurtosis - 1.7) < 1e-12);
  const skewed = returnMoments([0, 0, 0, 0, 10]);
  assert.ok(skewed.skewness > 1);
  assert.equal(returnMoments([1]).sharpe, null);
  assert.equal(returnMoments([0.01, 0.01, 0.01]).sharpe, null, 'zero variance has no Sharpe');
  const big = returnMoments(Array.from({ length: 20000 }, (_, i) => gaussian(seededRandom(i + 1))));
  assert.ok(Math.abs(big.kurtosis - 3) < 0.2, 'raw kurtosis of a normal sample is about 3');
});

test('PSR is about 0.5 when the Sharpe equals the benchmark', () => {
  const { psr } = probabilisticSharpeRatio({ sharpe: 0.2, benchmark: 0.2, sampleLength: 250, skewness: -0.5, kurtosis: 5 });
  assert.ok(Math.abs(psr - 0.5) < 1e-7);
  const higher = probabilisticSharpeRatio({ sharpe: 0.3, benchmark: 0.1, sampleLength: 250 }).psr;
  assert.ok(higher > 0.99);
  // Negative skew / fat tails widen the Sharpe estimator and lower PSR.
  const fat = probabilisticSharpeRatio({ sharpe: 0.15, benchmark: 0, sampleLength: 100, skewness: -1, kurtosis: 8 }).psr;
  const normal = probabilisticSharpeRatio({ sharpe: 0.15, benchmark: 0, sampleLength: 100 }).psr;
  assert.ok(fat < normal);
});

test('DSR falls as the number of trials grows for the same Sharpe', () => {
  const base = { sharpe: 0.25, sampleLength: 200, skewness: 0, kurtosis: 3, sharpeVariance: 0.01 };
  const values = [1, 10, 100, 1000, 20736].map(trials => deflatedSharpeRatio({ ...base, trials }));
  for (let i = 1; i < values.length; i += 1) {
    assert.ok(values[i].dsr < values[i - 1].dsr, `dsr must fall: ${values.map(v => v.dsr)}`);
    assert.ok(values[i].expectedMaxSharpe > values[i - 1].expectedMaxSharpe);
  }
  assert.equal(values[0].expectedMaxSharpe, 0, 'a single trial has no selection inflation');
  assert.ok(Math.abs(values[0].dsr - values[0].psr) < 1e-12);
  // Sharpe exactly at the null expected maximum → DSR about 0.5.
  const benchmark = expectedMaxSharpe({ trials: 500, sharpeVariance: 0.01 });
  const atBenchmark = deflatedSharpeRatio({ ...base, sharpe: benchmark, trials: 500 });
  assert.ok(Math.abs(atBenchmark.dsr - 0.5) < 1e-7);
  assert.equal(deflatedSharpeRatio({ ...base, trials: 50, sharpeVariance: null }).dsr, null);
});

test('PBO is near 0 for a dominant candidate', () => {
  const drifts = [0.6];
  const result = probabilityOfBacktestOverfitting(noiseMatrix({ rows: 320, cols: 40, seed: 11, drifts }), { partitions: 8 });
  assert.equal(result.combinations, 70);
  assert.ok(result.pbo <= 0.05, `pbo=${result.pbo}`);
  assert.ok(result.logits.median > 0);
});

test('PBO is about 0.5 for pure noise with a fixed seed', () => {
  const result = probabilityOfBacktestOverfitting(noiseMatrix({ rows: 320, cols: 40, seed: 2026 }), { partitions: 8 });
  assert.equal(result.combinations, 70);
  assert.ok(result.pbo >= 0.3 && result.pbo <= 0.7, `pbo=${result.pbo}`);
  // Averaged over several seeds the noise PBO concentrates near 0.5.
  const mean = [1, 2, 3, 4, 5, 6, 7, 8]
    .map(seed => probabilityOfBacktestOverfitting(noiseMatrix({ rows: 160, cols: 30, seed }), { partitions: 8 }).pbo)
    .reduce((sum, value) => sum + value, 0) / 8;
  assert.ok(Math.abs(mean - 0.5) < 0.15, `mean pbo=${mean}`);
});

test('PBO returns null with a reason for few candidates, short series or no variation', () => {
  assert.equal(probabilityOfBacktestOverfitting([[1], [2], [3]]).reason, 'insufficient_candidates');
  assert.equal(probabilityOfBacktestOverfitting(noiseMatrix({ rows: 10, cols: 5, seed: 1 })).reason, 'insufficient_time_buckets');
  assert.equal(probabilityOfBacktestOverfitting(Array.from({ length: 40 }, () => [0, 0, 0])).reason, 'no_cross_candidate_variation');
  assert.equal(probabilityOfBacktestOverfitting(noiseMatrix({ rows: 40, cols: 5, seed: 1 }), { partitions: 7 }).pbo, null);
});

test('assessment marks wouldFailGate but stays report-only', () => {
  const weak = assessSelectionOverfitting({
    selectedReturns: [0.01, -0.005, 0.004, 0.002, -0.001, 0.003],
    candidateSharpes: [0.1, 0.4, -0.2, 0.3, 0.05],
    trials: 20736
  });
  assert.equal(weak.reportOnly, true);
  assert.equal(weak.gateApplied, false);
  assert.equal(weak.pbo, null);
  assert.equal(weak.pboReason, 'candidate_return_matrix_unavailable');
  assert.equal(weak.wouldFailGate, true);
  assert.ok(weak.wouldFailReasons.includes('dsr_below_threshold'));

  const missing = assessSelectionOverfitting({ selectedReturns: [0.01], trials: 5 });
  assert.equal(missing.dsr, null);
  assert.ok(missing.wouldFailReasons.includes('dsr_unavailable'), 'missing DSR fails closed for a future gate');
});

function noisyMinuteCandles(count, seed) {
  const random = seededRandom(seed);
  const candles = [];
  let price = 1000;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    // Periodic washouts create oversold rebounds for the strategy to trade.
    const shock = i % 60 > 45 && i % 60 < 52 ? -0.006 : 0.0006;
    const close = open * (1 + shock + gaussian(random) * 0.003);
    const high = Math.max(open, close) * (1 + random() * 0.002);
    const low = Math.min(open, close) * (1 - random() * 0.002);
    candles.push({
      candle_date_time_utc: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString().slice(0, 19),
      opening_price: open,
      high_price: high,
      low_price: low,
      trade_price: close,
      candle_acc_trade_volume: 100 + random() * 200
    });
    price = close;
  }
  return candles;
}

test('scalping walk-forward validation records a report-only overfitting field', () => {
  const candles = noisyMinuteCandles(1500, 42);
  const options = {
    grid: { takeProfitPercent: [0.6, 1, 1.5], stopLossPercent: [0.5, 1], minVolumeRatio: [0, 1] },
    minimumCandles: 500,
    minimumTrainingTrades: 0
  };
  const validation = walkForwardValidate(candles, { requirePreviousHighBreak: false }, options);
  assert.ok(validation.overfitting, 'validation output carries overfitting');
  assert.equal(validation.overfitting.reportOnly, true);
  assert.equal(validation.overfitting.trials, 12);
  assert.equal(validation.overfitting.sampleKind, 'trade_returns');
  assert.equal(typeof validation.overfitting.wouldFailGate, 'boolean');
  assert.equal(validation.overfitting.pboCombinations, 70, 'CSCV runs over C(8,4) splits of the training window');
  assert.ok(validation.overfitting.pbo >= 0 && validation.overfitting.pbo <= 1);
  // Removing the diagnostic must not change the promotion decision fields.
  assert.equal(typeof validation.promoted, 'boolean');

  const fixed = walkForwardValidate(candles, { requirePreviousHighBreak: false }, { ...options, grid: {} });
  assert.equal(fixed.overfitting.trials, 1);
  assert.equal(fixed.overfitting.pbo, null);
  assert.equal(fixed.overfitting.pboReason, 'single_candidate_no_selection');

  const summary = summarizeOverfittingReport([
    { market: 'KRW-AAA', validation },
    { market: 'KRW-BBB', error: 'network' }
  ]);
  assert.equal(summary.reportOnly, true);
  assert.equal(summary.gateApplied, false);
  assert.equal(summary.markets.length, 2);
  assert.equal(summary.markets[1].available, false);
  assert.equal(summary.wouldFailGate, true, 'a missing market diagnostic fails closed');
});

test('horizon study records a report-only overfitting field with CSCV PBO', () => {
  const bars = (count, seed, drift) => {
    const random = seededRandom(seed);
    let price = 100;
    return Array.from({ length: count }, (_, i) => {
      const open = price;
      const close = open * (1 + drift + gaussian(random) * 0.01);
      price = close;
      return {
        time: Date.UTC(2026, 0, 1) + i * 4 * 3600 * 1000,
        open,
        high: Math.max(open, close) * 1.003,
        low: Math.min(open, close) * 0.997,
        close,
        volume: 1000 + i
      };
    });
  };
  const series = new Map([
    ['KRW-AAA', bars(500, 5, 0.002)],
    ['KRW-BBB', bars(500, 9, 0.001)],
    ['KRW-CCC', bars(500, 13, -0.001)]
  ]);
  const profiles = resolveHorizonProfiles('coin');
  const grid = { entryScore: [10, 30], atrStopMultiple: [2, 4], maxPositions: [2], regimeFilter: [false], riskPerTradePercent: [0, 1] };
  const result = studySleeve(series, profiles.swing, { grid, minTrades: 1 });
  for (const fold of result.foldResults.filter(f => f.test)) {
    assert.equal(fold.overfitting.reportOnly, true);
    assert.equal(fold.overfitting.trials, 8);
    assert.equal(fold.overfitting.sampleKind, 'bar_returns');
  }
  if (result.chosenParams) {
    assert.equal(result.overfitting.trials, 8);
    assert.ok(result.overfitting.pbo !== null || result.overfitting.pboReason);
    assert.equal(typeof result.overfitting.wouldFailGate, 'boolean');
  } else {
    assert.equal(result.overfitting, null);
  }
});
