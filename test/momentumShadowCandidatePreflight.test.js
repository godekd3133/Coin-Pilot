import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  inspectMomentumShadowCandidate
} from '../src/research/momentumShadowCandidatePreflight.js';
import {
  MOMENTUM_SHADOW_BENCHMARK_OBSERVATION_SCHEMA_VERSION
} from '../src/research/momentumShadowBenchmark.js';

function baseExpected() {
  return {
    mode: 'regime',
    maxHoldHours: 8760,
    markets: ['KRW-BTC', 'KRW-ETH'],
    trendMinPercent: 2,
    breadthMin: 2,
    minUpBars: 2,
    positionFraction: 0.125,
    maxPositions: 2,
    benchmarkMarket: 'KRW-BTC',
    benchmarkTrendMinPercent: 2,
    exitOnBenchmarkOff: true,
    cooldownAfterLossDays: 3,
    maxPortfolioDrawdownPercent: 10,
    pollMs: 900_000
  };
}

test('candidate preflight blocks a closed benchmark without touching owners', () => {
  const result = inspectMomentumShadowCandidate({
    targetDir: '/tmp/coinpilot-preflight-target-missing',
    benchmarkDir: '/tmp/coinpilot-preflight-benchmark-missing',
    ownerDirs: [],
    expectedConfig: baseExpected(),
    now: Date.parse('2026-01-01T00:00:00.000Z')
  });

  assert.equal(result.readOnly, true);
  assert.equal(result.promotionAllowed, false);
  assert.equal(result.launchAllowed, false);
  assert.ok(result.blockers.includes('benchmark_ledger_missing'));
});

test('candidate preflight blocks while another momentum-shadow owner is alive', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-preflight-owner-'));
  const benchmarkDir = path.join(root, 'benchmark');
  const ownerDir = path.join(root, 'owner');
  fs.mkdirSync(benchmarkDir, { recursive: true });
  fs.mkdirSync(ownerDir, { recursive: true });
  const now = Date.parse('2026-01-01T00:05:00.000Z');
  fs.writeFileSync(path.join(benchmarkDir, 'ledger.json'), JSON.stringify({
    ownerPid: process.pid,
    runnerState: 'running',
    heartbeatAt: new Date(now).toISOString(),
    benchmarkGateOpen: true,
    benchmarkTrendPercent: 2.5,
    dataQuality: { valid: true, reason: 'daily_grid_aligned_and_contiguous', marketCount: 2 },
    config: { pollMs: 900_000 }
  }));
  fs.writeFileSync(path.join(ownerDir, 'ledger.json'), JSON.stringify({
    ownerPid: process.pid,
    runnerState: 'running',
    configDrift: {
      previous: { breadthMin: 1 },
      changedAt: '2025-12-31T00:00:00.000Z'
    }
  }));
  try {
    const result = inspectMomentumShadowCandidate({
      targetDir: path.join(root, 'target'),
      benchmarkDir,
      ownerDirs: [ownerDir],
      expectedConfig: baseExpected(),
      now
    });

    assert.equal(result.liveOwnerCount, 1);
    assert.equal(result.launchAllowed, false);
    assert.ok(result.blockers.includes('existing_live_owner_count:1'));
    assert.equal(result.warnings.includes('existing_live_owner_count:1'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('candidate preflight rejects an active target lock and config drift', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-preflight-'));
  const targetDir = path.join(root, 'target');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, '.momentum-shadow.lock'), JSON.stringify({ pid: process.pid }));
  fs.writeFileSync(path.join(targetDir, 'ledger.json'), JSON.stringify({
    ownerPid: process.pid,
    runnerState: 'running',
    config: { ...baseExpected(), maxHoldHours: 72, positionFraction: 0.25 }
  }));
  try {
    const result = inspectMomentumShadowCandidate({
      targetDir,
      benchmarkDir: path.join(root, 'benchmark-missing'),
      ownerDirs: [],
      expectedConfig: baseExpected(),
      now: Date.now()
    });

    assert.equal(result.targetLedgerExists, true);
    assert.equal(result.targetLockExists, true);
    assert.ok(result.blockers.includes('target_owner_already_running'));
    assert.ok(result.blockers.includes('target_ledger_owner_alive'));
    assert.ok(result.blockers.some(blocker => blocker.startsWith('target_config_drift:')));
    assert.ok(result.blockers.some(blocker => blocker.includes('maxHoldHours')));
    assert.equal(result.candidateConfig.maxPortfolioDrawdownPercent, 10);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('candidate preflight exposes the next benchmark polling window', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-preflight-poll-'));
  const benchmarkDir = path.join(root, 'benchmark');
  fs.mkdirSync(benchmarkDir, { recursive: true });
  const heartbeatAt = '2026-01-01T00:00:00.000Z';
  fs.writeFileSync(path.join(benchmarkDir, 'ledger.json'), JSON.stringify({
    ownerPid: process.pid,
    runnerState: 'running',
    heartbeatAt,
    benchmarkGateOpen: false,
    benchmarkTrendPercent: -4,
    dataQuality: { valid: true, reason: 'daily_grid_aligned_and_contiguous', marketCount: 2 },
    config: { pollMs: 900_000 }
  }));
  try {
    const result = inspectMomentumShadowCandidate({
      targetDir: path.join(root, 'target'),
      benchmarkDir,
      ownerDirs: [],
      expectedConfig: baseExpected(),
      now: Date.parse('2026-01-01T00:05:00.000Z')
    });
    assert.equal(result.benchmark.nextPollAt, '2026-01-01T00:15:00.000Z');
    assert.equal(result.benchmark.nextPollDueInSeconds, 600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('candidate preflight allows a fresh open benchmark with an empty target', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-preflight-open-'));
  const benchmarkDir = path.join(root, 'benchmark');
  fs.mkdirSync(benchmarkDir, { recursive: true });
  const now = Date.parse('2026-01-01T00:05:00.000Z');
  fs.writeFileSync(path.join(benchmarkDir, 'ledger.json'), JSON.stringify({
    ownerPid: process.pid,
    runnerState: 'running',
    heartbeatAt: new Date(now).toISOString(),
    benchmarkGateOpen: true,
    benchmarkTrendPercent: 2.5,
    benchmarkObservationSchemaVersion: MOMENTUM_SHADOW_BENCHMARK_OBSERVATION_SCHEMA_VERSION,
    dataQuality: { valid: true, reason: 'daily_grid_aligned_and_contiguous', marketCount: 2 },
    config: { pollMs: 900_000 }
  }));
  try {
    const result = inspectMomentumShadowCandidate({
      targetDir: path.join(root, 'target'),
      benchmarkDir,
      ownerDirs: [],
      expectedConfig: {
        ...baseExpected(),
        maxEntryGapPercent: 0.2,
        maxDailyCandleAgeHours: 36,
        maxSpreadPercent: 0.5
      },
      now
    });

    assert.equal(result.launchAllowed, true);
    assert.equal(result.targetLedgerExists, false);
    assert.equal(result.targetLockExists, false);
    assert.equal(result.benchmark.gateOpen, true);
    assert.equal(result.benchmark.heartbeatFresh, true);
    assert.equal(result.benchmark.observationTelemetryReady, true);
    assert.equal(result.benchmark.observationAvailable, false);
    assert.equal(result.benchmark.observationReason, 'benchmark_observation_not_recorded');
    assert.equal(result.benchmark.observationCheckpointCount, 0);
    assert.equal(result.benchmark.observationValidCheckpointCount, 0);
    assert.ok(result.warnings.includes('benchmark_observation_unavailable'));
    assert.equal(result.candidateConfig.maxEntryGapPercent, 0.2);
    assert.equal(result.candidateConfig.maxDailyCandleAgeHours, 36);
    assert.equal(result.candidateConfig.relativeTrendMinPercent, null);
    assert.equal(result.candidateConfig.maxSpreadPercent, 0.5);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('candidate preflight does not attach a missing-observation reason to an available observation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-preflight-observation-ready-'));
  const benchmarkDir = path.join(root, 'benchmark');
  fs.mkdirSync(benchmarkDir, { recursive: true });
  const now = Date.parse('2026-01-01T00:05:00.000Z');
  fs.writeFileSync(path.join(benchmarkDir, 'ledger.json'), JSON.stringify({
    ownerPid: process.pid,
    runnerState: 'running',
    heartbeatAt: new Date(now).toISOString(),
    benchmarkGateOpen: true,
    benchmarkTrendPercent: 2.5,
    benchmarkObservationSchemaVersion: MOMENTUM_SHADOW_BENCHMARK_OBSERVATION_SCHEMA_VERSION,
    benchmarkObservationAvailable: true,
    benchmarkObservationStartTs: '2025-12-31T00:00:00',
    benchmarkObservationMarkTs: '2026-01-01T00:00:00',
    benchmarkObservationStartPrice: 100,
    benchmarkObservationMarkPrice: 110,
    dataQuality: { valid: true, reason: 'daily_grid_aligned_and_contiguous', marketCount: 2 },
    config: { pollMs: 900_000 }
  }));
  try {
    const result = inspectMomentumShadowCandidate({
      targetDir: path.join(root, 'target'),
      benchmarkDir,
      ownerDirs: [],
      expectedConfig: baseExpected(),
      now
    });
    assert.equal(result.benchmark.observationAvailable, true);
    assert.equal(result.benchmark.observationReason, null);
    assert.equal(result.warnings.includes('benchmark_observation_unavailable'), false);
    assert.equal(result.warnings.includes('benchmark_observation_telemetry_legacy'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('candidate preflight identifies legacy benchmark observation telemetry separately', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-preflight-legacy-observation-'));
  const benchmarkDir = path.join(root, 'benchmark');
  fs.mkdirSync(benchmarkDir, { recursive: true });
  const now = Date.parse('2026-01-01T00:05:00.000Z');
  fs.writeFileSync(path.join(benchmarkDir, 'ledger.json'), JSON.stringify({
    ownerPid: process.pid,
    runnerState: 'running',
    heartbeatAt: new Date(now).toISOString(),
    benchmarkGateOpen: true,
    benchmarkTrendPercent: 2.5,
    dataQuality: { valid: true, reason: 'daily_grid_aligned_and_contiguous', marketCount: 2 },
    config: { pollMs: 900_000 }
  }));
  try {
    const result = inspectMomentumShadowCandidate({
      targetDir: path.join(root, 'target'),
      benchmarkDir,
      ownerDirs: [],
      expectedConfig: baseExpected(),
      now
    });
    assert.equal(result.launchAllowed, true);
    assert.equal(result.benchmark.observationSchemaVersion, null);
    assert.equal(result.benchmark.observationTelemetryReady, false);
    assert.equal(result.benchmark.observationReason, 'benchmark_observation_not_recorded');
    assert.equal(result.benchmark.observationRestart.required, true);
    assert.equal(result.benchmark.observationRestart.safe, true);
    assert.deepEqual(result.benchmark.observationRestart.blockers, []);
    assert.equal(result.benchmark.observationRestart.openPositionCount, 0);
    assert.equal(result.benchmark.observationRestart.tradeCount, 0);
    assert.ok(result.warnings.includes('benchmark_observation_telemetry_legacy'));
    assert.equal(result.warnings.includes('benchmark_observation_unavailable'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('candidate preflight does not label a benchmark with paper state safe to restart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-preflight-legacy-busy-'));
  const benchmarkDir = path.join(root, 'benchmark');
  fs.mkdirSync(benchmarkDir, { recursive: true });
  const now = Date.parse('2026-01-01T00:05:00.000Z');
  fs.writeFileSync(path.join(benchmarkDir, 'ledger.json'), JSON.stringify({
    ownerPid: process.pid,
    runnerState: 'running',
    heartbeatAt: new Date(now).toISOString(),
    benchmarkGateOpen: false,
    benchmarkTrendPercent: -4,
    positions: { 'KRW-BTC': { size: 100 } },
    trades: [{ market: 'KRW-BTC' }],
    pendingEntries: [{ market: 'KRW-ETH' }],
    dataQuality: { valid: true, reason: 'daily_grid_aligned_and_contiguous', marketCount: 2 },
    config: { pollMs: 900_000 }
  }));
  try {
    const result = inspectMomentumShadowCandidate({
      targetDir: path.join(root, 'target'),
      benchmarkDir,
      ownerDirs: [],
      expectedConfig: baseExpected(),
      now
    });
    assert.equal(result.benchmark.observationRestart.required, true);
    assert.equal(result.benchmark.observationRestart.safe, false);
    assert.deepEqual(result.benchmark.observationRestart.blockers, [
      'benchmark_positions_open',
      'benchmark_trades_exist',
      'benchmark_pending_entries'
    ]);
    assert.equal(result.benchmark.observationRestart.openPositionCount, 1);
    assert.equal(result.benchmark.observationRestart.tradeCount, 1);
    assert.equal(result.benchmark.observationRestart.pendingEntryCount, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('candidate preflight blocks a benchmark with a future heartbeat', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-preflight-future-hb-'));
  const benchmarkDir = path.join(root, 'benchmark');
  fs.mkdirSync(benchmarkDir, { recursive: true });
  const now = Date.parse('2026-01-01T00:05:00.000Z');
  fs.writeFileSync(path.join(benchmarkDir, 'ledger.json'), JSON.stringify({
    ownerPid: process.pid,
    runnerState: 'running',
    heartbeatAt: new Date(now + 60_000).toISOString(),
    benchmarkGateOpen: true,
    benchmarkTrendPercent: 2.5,
    dataQuality: { valid: true, reason: 'daily_grid_aligned_and_contiguous', marketCount: 2 },
    config: { pollMs: 900_000 }
  }));
  try {
    const result = inspectMomentumShadowCandidate({
      targetDir: path.join(root, 'target'),
      benchmarkDir,
      ownerDirs: [],
      expectedConfig: baseExpected(),
      now
    });

    assert.equal(result.launchAllowed, false);
    assert.equal(result.benchmark.heartbeatAgeSeconds, null);
    assert.equal(result.benchmark.heartbeatFresh, false);
    assert.ok(result.blockers.includes('benchmark_heartbeat_stale'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('candidate preflight blocks a second candidate while the global slot is occupied', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-preflight-slot-'));
  const benchmarkDir = path.join(root, 'benchmark');
  const slotFile = path.join(root, 'candidate.lock');
  fs.mkdirSync(benchmarkDir, { recursive: true });
  const now = Date.parse('2026-01-01T00:05:00.000Z');
  fs.writeFileSync(path.join(benchmarkDir, 'ledger.json'), JSON.stringify({
    ownerPid: process.pid,
    runnerState: 'running',
    heartbeatAt: new Date(now).toISOString(),
    benchmarkGateOpen: true,
    benchmarkTrendPercent: 2.5,
    dataQuality: { valid: true, reason: 'daily_grid_aligned_and_contiguous', marketCount: 2 },
    config: { pollMs: 900_000 }
  }));
  fs.writeFileSync(slotFile, JSON.stringify({ pid: process.pid, dir: '/already-running-candidate' }));
  try {
    const result = inspectMomentumShadowCandidate({
      targetDir: path.join(root, 'target'),
      benchmarkDir,
      ownerDirs: [],
      expectedConfig: baseExpected(),
      candidateSlotFile: slotFile,
      now
    });

    assert.equal(result.launchAllowed, false);
    assert.equal(result.candidateSlot.occupied, true);
    assert.equal(result.candidateSlot.ownerPid, process.pid);
    assert.ok(result.blockers.includes('candidate_slot_occupied'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('candidate preflight keeps recovered benchmark fetch history informational', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-preflight-fetch-errors-'));
  const benchmarkDir = path.join(root, 'benchmark');
  fs.mkdirSync(benchmarkDir, { recursive: true });
  const now = Date.parse('2026-01-01T00:05:00.000Z');
  fs.writeFileSync(path.join(benchmarkDir, 'ledger.json'), JSON.stringify({
    ownerPid: process.pid,
    runnerState: 'running',
    heartbeatAt: new Date(now).toISOString(),
    benchmarkGateOpen: true,
    benchmarkTrendPercent: 2.5,
    fetchErrors: 7,
    networkFetchFailureStreak: 0,
    networkFetchCircuitOpen: false,
    dataQuality: { valid: true, reason: 'daily_grid_aligned_and_contiguous', marketCount: 2 },
    config: { pollMs: 900_000 }
  }));
  try {
    const result = inspectMomentumShadowCandidate({
      targetDir: path.join(root, 'target'),
      benchmarkDir,
      ownerDirs: [],
      expectedConfig: baseExpected(),
      now
    });

    assert.equal(result.launchAllowed, true);
    assert.equal(result.benchmark.fetchErrors, 7);
    assert.equal(result.benchmark.fetchFailureStreak, 0);
    assert.equal(result.benchmark.fetchCircuitOpen, false);
    assert.ok(!result.warnings.some(warning => warning.startsWith('benchmark_fetch')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('candidate preflight warns while the benchmark owner is actively failing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-preflight-fetch-active-'));
  const benchmarkDir = path.join(root, 'benchmark');
  fs.mkdirSync(benchmarkDir, { recursive: true });
  const now = Date.parse('2026-01-01T00:05:00.000Z');
  fs.writeFileSync(path.join(benchmarkDir, 'ledger.json'), JSON.stringify({
    ownerPid: process.pid,
    runnerState: 'running',
    heartbeatAt: new Date(now).toISOString(),
    benchmarkGateOpen: true,
    benchmarkTrendPercent: 2.5,
    fetchErrors: 9,
    networkFetchFailureStreak: 2,
    networkFetchCircuitOpen: true,
    dataQuality: { valid: true, reason: 'daily_grid_aligned_and_contiguous', marketCount: 2 },
    config: { pollMs: 900_000 }
  }));
  try {
    const result = inspectMomentumShadowCandidate({
      targetDir: path.join(root, 'target'),
      benchmarkDir,
      ownerDirs: [],
      expectedConfig: baseExpected(),
      now
    });

    assert.equal(result.launchAllowed, true);
    assert.equal(result.benchmark.fetchErrors, 9);
    assert.equal(result.benchmark.fetchFailureStreak, 2);
    assert.equal(result.benchmark.fetchCircuitOpen, true);
    assert.ok(result.warnings.includes('benchmark_fetch_failures_active:2'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('candidate preflight evaluates the candidate threshold instead of copying the source owner gate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-preflight-threshold-'));
  const benchmarkDir = path.join(root, 'benchmark');
  fs.mkdirSync(benchmarkDir, { recursive: true });
  const now = Date.parse('2026-01-01T00:05:00.000Z');
  fs.writeFileSync(path.join(benchmarkDir, 'ledger.json'), JSON.stringify({
    ownerPid: process.pid,
    runnerState: 'running',
    heartbeatAt: new Date(now).toISOString(),
    benchmarkGateOpen: false,
    benchmarkTrendPercent: 1.5,
    dataQuality: { valid: true, reason: 'daily_grid_aligned_and_contiguous', marketCount: 2 },
    config: { pollMs: 900_000, benchmarkTrendMinPercent: 2 }
  }));
  try {
    const result = inspectMomentumShadowCandidate({
      targetDir: path.join(root, 'target'),
      benchmarkDir,
      ownerDirs: [],
      expectedConfig: {
        ...baseExpected(),
        benchmarkTrendMinPercent: 1,
        maxEntryGapPercent: 0.2,
        maxDailyCandleAgeHours: 36
      },
      now
    });

    assert.equal(result.launchAllowed, true);
    assert.equal(result.benchmark.gateOpen, true);
    assert.equal(result.benchmark.sourceGateOpen, false);
    assert.equal(result.benchmark.candidateThresholdPercent, 1);
    assert.equal(result.benchmark.sourceThresholdPercent, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('candidate preflight flags runner exit-override drift inside the sealed contract', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-preflight-exit-'));
  const targetDir = path.join(root, 'target');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, 'ledger.json'), JSON.stringify({
    config: { ...baseExpected(), stopLossPercent: 3 }
  }));
  try {
    const result = inspectMomentumShadowCandidate({
      targetDir,
      benchmarkDir: path.join(root, 'benchmark-missing'),
      ownerDirs: [],
      expectedConfig: baseExpected(),
      now: Date.now()
    });

    assert.equal(result.launchAllowed, false);
    assert.ok(result.blockers.includes('target_config_drift:stopLossPercent'));
    assert.equal(result.candidateConfig.stopLossPercent, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('candidate preflight detects relative-trend contract drift', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-preflight-relative-'));
  const targetDir = path.join(root, 'target');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, 'ledger.json'), JSON.stringify({
    config: { ...baseExpected(), relativeTrendMinPercent: 1 }
  }));
  try {
    const result = inspectMomentumShadowCandidate({
      targetDir,
      benchmarkDir: path.join(root, 'benchmark-missing'),
      ownerDirs: [],
      expectedConfig: { ...baseExpected(), relativeTrendMinPercent: 0 },
      now: Date.now()
    });

    assert.equal(result.launchAllowed, false);
    assert.ok(result.blockers.includes('target_config_drift:relativeTrendMinPercent'));
    assert.equal(result.candidateConfig.relativeTrendMinPercent, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('candidate preflight keeps an unknown benchmark trend unknown and closed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-preflight-unknown-trend-'));
  const benchmarkDir = path.join(root, 'benchmark');
  fs.mkdirSync(benchmarkDir, { recursive: true });
  const now = Date.parse('2026-01-01T00:05:00.000Z');
  fs.writeFileSync(path.join(benchmarkDir, 'ledger.json'), JSON.stringify({
    ownerPid: process.pid,
    runnerState: 'running',
    heartbeatAt: new Date(now).toISOString(),
    benchmarkGateOpen: false,
    benchmarkTrendPercent: null,
    dataQuality: { valid: true, reason: 'daily_grid_aligned_and_contiguous', marketCount: 2 },
    config: { pollMs: 900_000, benchmarkTrendMinPercent: 2 }
  }));
  try {
    const result = inspectMomentumShadowCandidate({
      targetDir: path.join(root, 'target'),
      benchmarkDir,
      ownerDirs: [],
      expectedConfig: {
        ...baseExpected(),
        benchmarkTrendMinPercent: 1
      },
      now
    });

    assert.equal(result.launchAllowed, false);
    assert.equal(result.benchmark.trendPercent, null);
    assert.equal(result.benchmark.gateOpen, false);
    assert.ok(result.blockers.includes('benchmark_gate_closed'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('candidate preflight blocks an open benchmark with invalid daily data quality', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-preflight-quality-'));
  const benchmarkDir = path.join(root, 'benchmark');
  fs.mkdirSync(benchmarkDir, { recursive: true });
  const now = Date.parse('2026-01-01T00:05:00.000Z');
  fs.writeFileSync(path.join(benchmarkDir, 'ledger.json'), JSON.stringify({
    ownerPid: process.pid,
    runnerState: 'running',
    heartbeatAt: new Date(now).toISOString(),
    benchmarkGateOpen: true,
    benchmarkTrendPercent: 4,
    dataQuality: {
      valid: false,
      reason: 'daily_market_missing',
      marketCount: 2,
      missingMarkets: ['KRW-ETH']
    },
    config: { pollMs: 900_000 }
  }));
  try {
    const result = inspectMomentumShadowCandidate({
      targetDir: path.join(root, 'target'),
      benchmarkDir,
      ownerDirs: [],
      expectedConfig: baseExpected(),
      now
    });

    assert.equal(result.launchAllowed, false);
    assert.ok(result.blockers.includes('benchmark_data_quality_invalid'));
    assert.equal(result.benchmark.dataQuality.valid, false);
    assert.equal(result.benchmark.dataQuality.reason, 'daily_market_missing');
    assert.deepEqual(result.benchmark.dataQuality.missingMarkets, ['KRW-ETH']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('candidate preflight requires a fresh complete quote report for quote execution', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-preflight-quote-ready-'));
  const benchmarkDir = path.join(root, 'benchmark');
  const quoteFile = path.join(root, 'quote-quality.json');
  fs.mkdirSync(benchmarkDir, { recursive: true });
  const now = Date.parse('2026-01-01T00:05:00.000Z');
  fs.writeFileSync(path.join(benchmarkDir, 'ledger.json'), JSON.stringify({
    ownerPid: process.pid,
    runnerState: 'running',
    heartbeatAt: new Date(now).toISOString(),
    benchmarkGateOpen: true,
    benchmarkTrendPercent: 4,
    dataQuality: { valid: true, reason: 'daily_grid_aligned_and_contiguous', marketCount: 2 },
    config: { pollMs: 900_000 }
  }));
  fs.writeFileSync(quoteFile, JSON.stringify({
    generatedAt: new Date(now - 60_000).toISOString(),
    complete: true,
    errors: [],
    requestedSampleCount: 5,
    samples: [{}, {}, {}, {}, {}],
    summary: {
      valid: true,
      sampleCount: 5,
      markets: { 'KRW-BTC': {}, 'KRW-ETH': { overCeiling: 5 } }
    }
  }));
  try {
    const result = inspectMomentumShadowCandidate({
      targetDir: path.join(root, 'target'),
      benchmarkDir,
      ownerDirs: [],
      expectedConfig: {
        ...baseExpected(),
        markets: ['KRW-BTC', 'KRW-ETH'],
        executionModel: 'quote_cross',
        maxSpreadPercent: 0.5
      },
      requireQuoteQuality: true,
      quoteReportFile: quoteFile,
      now
    });

    assert.equal(result.launchAllowed, true);
    assert.equal(result.quoteQuality.ready, true);
    assert.equal(result.quoteQuality.ageSeconds, 60);
    assert.equal(result.quoteQuality.errorCount, 0);
    assert.deepEqual(result.quoteQuality.overCeilingMarkets, ['KRW-ETH']);
    assert.ok(result.warnings.includes('quote_quality_over_ceiling_markets:KRW-ETH'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('candidate preflight blocks stale quote evidence before quote execution', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-preflight-quote-stale-'));
  const benchmarkDir = path.join(root, 'benchmark');
  const quoteFile = path.join(root, 'quote-quality.json');
  fs.mkdirSync(benchmarkDir, { recursive: true });
  const now = Date.parse('2026-01-01T00:05:00.000Z');
  fs.writeFileSync(path.join(benchmarkDir, 'ledger.json'), JSON.stringify({
    ownerPid: process.pid,
    runnerState: 'running',
    heartbeatAt: new Date(now).toISOString(),
    benchmarkGateOpen: true,
    benchmarkTrendPercent: 4,
    dataQuality: { valid: true, reason: 'daily_grid_aligned_and_contiguous', marketCount: 2 },
    config: { pollMs: 900_000 }
  }));
  fs.writeFileSync(quoteFile, JSON.stringify({
    generatedAt: new Date(now - 901_000).toISOString(),
    complete: true,
    errors: [],
    requestedSampleCount: 5,
    samples: [{}, {}, {}, {}, {}],
    summary: {
      valid: true,
      sampleCount: 5,
      markets: { 'KRW-BTC': {}, 'KRW-ETH': {} }
    }
  }));
  try {
    const result = inspectMomentumShadowCandidate({
      targetDir: path.join(root, 'target'),
      benchmarkDir,
      ownerDirs: [],
      expectedConfig: {
        ...baseExpected(),
        markets: ['KRW-BTC', 'KRW-ETH'],
        executionModel: 'quote_cross',
        maxSpreadPercent: 0.5
      },
      requireQuoteQuality: true,
      quoteReportFile: quoteFile,
      now
    });

    assert.equal(result.launchAllowed, false);
    assert.ok(result.blockers.includes('quote_quality_report_stale'));
    assert.equal(result.quoteQuality.ready, false);
    assert.equal(result.quoteQuality.ageSeconds, 901);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
