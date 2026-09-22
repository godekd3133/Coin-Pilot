import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendMomentumShadowBenchmarkObservationCheckpoint,
  calculateMomentumShadowBenchmarkReturnPercent,
  calculateMomentumShadowRelativeMarkedReturnPercent,
  getMomentumShadowBenchmarkGate,
  projectMomentumShadowBenchmarkObservation,
  summarizeMomentumShadowBenchmarkObservationCheckpoints
} from '../src/research/momentumShadowBenchmark.js';

const bars = prices => prices.map((trade_price, index) => ({
  trade_price,
  ts: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00`
}));

test('benchmark gate opens only when the completed benchmark trend clears the floor', () => {
  const open = getMomentumShadowBenchmarkGate({ BTC: bars([100, 101, 103]) }, 'BTC', 2, 2, 2);
  const closed = getMomentumShadowBenchmarkGate({ BTC: bars([100, 101, 102]) }, 'BTC', 2, 2, 2);

  assert.equal(open.available, true);
  assert.equal(open.gateOpen, true);
  assert.ok(Math.abs(open.trendPercent - 3) < 1e-12);
  assert.equal(closed.gateOpen, false);
});

test('missing benchmark data closes the gate instead of passing open', () => {
  const result = getMomentumShadowBenchmarkGate({}, 'BTC', 0, 0, 7);
  assert.equal(result.available, false);
  assert.equal(result.gateOpen, false);
  assert.equal(result.reason, 'benchmark_data_unavailable');
});

test('benchmark price return and relative marked return reject unverifiable inputs', () => {
  assert.equal(calculateMomentumShadowBenchmarkReturnPercent(100, 110), 10);
  assert.equal(calculateMomentumShadowBenchmarkReturnPercent(null, 110), null);
  assert.equal(calculateMomentumShadowBenchmarkReturnPercent(0, 110), null);
  assert.equal(calculateMomentumShadowRelativeMarkedReturnPercent(-2, 10), -12);
  assert.equal(calculateMomentumShadowRelativeMarkedReturnPercent(-2, null), null);
});

test('benchmark observation anchors once and never moves its mark backwards', () => {
  const first = projectMomentumShadowBenchmarkObservation({
    existing: {},
    bars: bars([100]),
    benchmarkMarket: 'BTC'
  });
  assert.equal(first.available, true);
  assert.equal(first.initialized, true);
  assert.equal(first.benchmarkObservationStartPrice, 100);
  assert.equal(first.benchmarkObservationReturnPercent, 0);

  const advanced = projectMomentumShadowBenchmarkObservation({
    existing: first,
    bars: bars([100, 110]),
    benchmarkMarket: 'BTC'
  });
  assert.equal(advanced.updated, true);
  assert.equal(advanced.benchmarkObservationStartPrice, 100);
  assert.equal(advanced.benchmarkObservationMarkPrice, 110);
  assert.equal(advanced.benchmarkObservationReturnPercent, 10);

  const regressed = projectMomentumShadowBenchmarkObservation({
    existing: advanced,
    bars: [{ trade_price: 105, ts: '2025-12-31T00:00:00' }],
    benchmarkMarket: 'BTC'
  });
  assert.equal(regressed.available, true);
  assert.equal(regressed.updated, false);
  assert.equal(regressed.reason, 'benchmark_timestamp_regressed');
  assert.equal(regressed.benchmarkObservationMarkPrice, 110);
  assert.equal(regressed.benchmarkObservationReturnPercent, 10);
});

test('benchmark checkpoint history deduplicates a bar and keeps worst relative performance', () => {
  const checkpoint = (ts, relative) => ({
    benchmarkMarkTs: ts,
    capturedAt: ts,
    markedEquity: 1000,
    markedReturnPercent: relative,
    benchmarkReturnPercent: 0,
    relativeMarkedReturnPercent: relative,
    openPositionCount: 0,
    dataQualityValid: true,
    benchmarkGateOpen: false
  });
  let history = appendMomentumShadowBenchmarkObservationCheckpoint(
    [],
    checkpoint('2026-01-01T00:00:00', 0),
    2
  );
  history = appendMomentumShadowBenchmarkObservationCheckpoint(
    history,
    checkpoint('2026-01-01T00:00:00', -1),
    2
  );
  history = appendMomentumShadowBenchmarkObservationCheckpoint(
    history,
    checkpoint('2026-01-02T00:00:00', 2),
    2
  );
  history = appendMomentumShadowBenchmarkObservationCheckpoint(
    history,
    checkpoint('2026-01-03T00:00:00', -5),
    2
  );
  assert.equal(history.length, 2);
  assert.equal(history[0].benchmarkMarkTs, '2026-01-02T00:00:00');
  assert.equal(history[1].relativeMarkedReturnPercent, -5);

  const summary = summarizeMomentumShadowBenchmarkObservationCheckpoints(history, 2);
  assert.equal(summary.available, true);
  assert.equal(summary.checkpointCount, 2);
  assert.equal(summary.validCheckpointCount, 2);
  assert.equal(summary.invalidCheckpointCount, 0);
  assert.equal(summary.latestRelativeMarkedReturnPercent, -5);
  assert.equal(summary.bestRelativeMarkedReturnPercent, 2);
  assert.equal(summary.worstRelativeMarkedReturnPercent, -5);

  const invalidCheckpoint = {
    ...checkpoint('2026-01-04T00:00:00', 99),
    dataQualityValid: false
  };
  const qualityBlockedSummary = summarizeMomentumShadowBenchmarkObservationCheckpoints(
    [invalidCheckpoint],
    2
  );
  assert.equal(qualityBlockedSummary.available, false);
  assert.equal(qualityBlockedSummary.checkpointCount, 1);
  assert.equal(qualityBlockedSummary.invalidCheckpointCount, 1);
});
