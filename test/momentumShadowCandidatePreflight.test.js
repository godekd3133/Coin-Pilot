import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  inspectMomentumShadowCandidate
} from '../src/research/momentumShadowCandidatePreflight.js';

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
    assert.equal(result.candidateConfig.maxEntryGapPercent, 0.2);
    assert.equal(result.candidateConfig.maxDailyCandleAgeHours, 36);
    assert.equal(result.candidateConfig.maxSpreadPercent, 0.5);
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
