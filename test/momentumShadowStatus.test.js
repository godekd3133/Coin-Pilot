import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  MOMENTUM_SHADOW_BENCHMARK_OBSERVATION_SCHEMA_VERSION
} from '../src/research/momentumShadowBenchmark.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const statusScript = path.join(projectRoot, 'src/scripts/momentumShadowStatus.js');

function writeLedger(root, ledger) {
  const dir = path.join(root, 'book');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify(ledger), 'utf8');
  return dir;
}

function runStatus(dir) {
  return spawnSync(process.execPath, [statusScript, dir], {
    cwd: projectRoot,
    encoding: 'utf8'
  });
}

test('momentum shadow status fails closed when the recorded owner PID is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-shadow-status-'));
  try {
    const dir = writeLedger(root, {
      runnerState: 'running',
      ownerPid: 999999,
      heartbeatAt: new Date().toISOString(),
      config: { mode: 'regime', pollMs: 900_000 },
      balance: 100_000_000,
      positions: {},
      trades: []
    });
    const result = runStatus(dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /\[STOPPED:owner_process_missing\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('momentum shadow status fails closed when runner state is absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-shadow-status-'));
  try {
    const dir = writeLedger(root, {
      ownerPid: process.pid,
      heartbeatAt: new Date().toISOString(),
      config: { mode: 'regime', pollMs: 900_000 },
      balance: 100_000_000,
      positions: {},
      trades: []
    });
    const result = runStatus(dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /\[STOPPED:runner_state_missing\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('momentum shadow status fails closed when the heartbeat is not verifiable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-shadow-status-'));
  try {
    const dir = writeLedger(root, {
      runnerState: 'running',
      ownerPid: process.pid,
      heartbeatAt: new Date(Date.now() + 60_000).toISOString(),
      config: { mode: 'regime', pollMs: 900_000 },
      balance: 100_000_000,
      positions: {},
      trades: []
    });
    const result = runStatus(dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /\[STOPPED:heartbeat_stale\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('momentum shadow status reports volatility target and scale readback', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-shadow-status-'));
  try {
    const dir = writeLedger(root, {
      runnerState: 'running',
      ownerPid: 999999,
      heartbeatAt: new Date().toISOString(),
      config: {
        mode: 'regime',
        pollMs: 900_000,
        volatilityLookbackDays: 14,
        volatilityTargetPercent: 1,
        entryExecution: 'next_open',
        executionModel: 'quote_cross',
        maxEntryGapPercent: 0.2,
        relativeTrendMinPercent: 0
      },
      balance: 100_000_000,
      positions: {},
      trades: [],
      volatilityScaleByMarket: { 'KRW-BTC': 1, 'KRW-ETH': 0.25 },
      volatilityBlocked: 2,
      duplicateSignalBlocked: 3,
      pendingEntries: [],
      pendingEntryGapBlocked: 2,
      relativeTrendBlocked: 4,
      fetchErrors: 4
    });
    const result = runStatus(dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /volatility target 1\.00%\/14d/);
    assert.match(result.stdout, /scale 0\.250~1\.000/);
    assert.match(result.stdout, /blocked 2/);
    assert.match(result.stdout, /duplicateSignalBlocked 3/);
    assert.match(result.stdout, /entry gap ceiling 0\.20%/);
    assert.match(result.stdout, /gapBlocked 2/);
    assert.match(result.stdout, /relative trend > benchmark \+0\.00% \| blocked 4/);
    assert.match(result.stdout, /execution model quote_cross \| best ask entry · best bid exit\/mark · modeled paper price \| blocked 0/);
    assert.match(result.stdout, /network fetch errors 4 \| streak/);
    assert.match(result.stdout, /realized 0 KRW \(\+0\.00%\) \| trade-return 95% lower unavailable \| valid returns 0\/0/);
    assert.match(result.stdout, /observation unknown \| minimum 14d \| final not-ready:owner_process_missing/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('momentum shadow status prints the same realized return and confidence readback as the API', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-shadow-status-'));
  try {
    const dir = writeLedger(root, {
      runnerState: 'stopped',
      ownerPid: 0,
      heartbeatAt: new Date().toISOString(),
      config: { mode: 'fixed', pollMs: 900_000 },
      initialBalance: 1_000,
      balance: 980,
      positions: {},
      trades: Array.from({ length: 20 }, () => ({ entry: { size: 100 }, profitPercent: -1 }))
    });
    const result = runStatus(dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /closed trades: 20 \| realized -20 KRW \(-2\.00%\) \| trade-return 95% lower -1\.00% \| valid returns 20\/20/);
    assert.match(result.stdout, /observation unknown \| minimum 14d \| final not-ready:recorded_stop/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('momentum shadow status marks a live owner with config drift as not ready evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-shadow-status-'));
  try {
    const dir = writeLedger(root, {
      runnerState: 'running',
      ownerPid: process.pid,
      heartbeatAt: new Date().toISOString(),
      config: { mode: 'fixed', pollMs: 300_000 },
      configDrift: {
        changedAt: '2026-09-15T07:12:53.225Z',
        previous: { mode: 'fixed', pollMs: 300_000 }
      },
      balance: 100_000_000,
      positions: {},
      trades: []
    });
    const result = runStatus(dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /evidence not eligible for A\/B or promotion/);
    assert.match(result.stdout, /observation unknown \| minimum 14d \| final not-ready:config_drift/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('momentum shadow status reports benchmark-relative checkpoint history', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-shadow-status-'));
  try {
    const dir = writeLedger(root, {
      runnerState: 'stopped',
      ownerPid: 0,
      heartbeatAt: new Date().toISOString(),
      config: { mode: 'regime', pollMs: 900_000, benchmarkMarket: 'KRW-BTC' },
      initialBalance: 1_000,
      balance: 1_000,
      positions: {},
      trades: [],
      benchmarkObservationSchemaVersion: MOMENTUM_SHADOW_BENCHMARK_OBSERVATION_SCHEMA_VERSION,
      benchmarkObservationAvailable: true,
      benchmarkObservationStartPrice: 100,
      benchmarkObservationMarkPrice: 110,
      benchmarkObservationStartTs: '2026-01-01T00:00:00',
      benchmarkObservationMarkTs: '2026-01-02T00:00:00',
      benchmarkObservationCheckpoints: [
        {
          benchmarkMarkTs: '2026-01-01T00:00:00',
          markedReturnPercent: 0,
          benchmarkReturnPercent: 0,
          relativeMarkedReturnPercent: 0,
          dataQualityValid: true
        },
        {
          benchmarkMarkTs: '2026-01-02T00:00:00',
          markedReturnPercent: -2,
          benchmarkReturnPercent: 10,
          relativeMarkedReturnPercent: -12,
          dataQualityValid: true
        }
      ]
    });
    const result = runStatus(dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /benchmark observation price return \+10\.00% \| relative marked -10\.00%/);
    assert.match(result.stdout, /benchmark observation telemetry schema 1/);
    assert.match(result.stdout, /benchmark observation checkpoints 2 \| relative range -12\.00%~\+0\.00%/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('momentum shadow status does not report a disabled relative-trend guard as enabled', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-shadow-status-'));
  try {
    const dir = writeLedger(root, {
      runnerState: 'running',
      ownerPid: 999999,
      heartbeatAt: new Date().toISOString(),
      config: {
        mode: 'regime',
        pollMs: 900_000,
        // Fresh ledgers persist the key with a null value; Number(null) is 0,
        // so a bare isFinite check would print a phantom +0.00% guard.
        relativeTrendMinPercent: null
      },
      balance: 100_000_000,
      positions: {},
      trades: [],
      relativeTrendBlocked: 4
    });
    const result = runStatus(dir);
    assert.equal(result.status, 0);
    assert.ok(!/relative trend/.test(result.stdout));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('momentum shadow status reports stale daily data as a separate safety block', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-shadow-status-'));
  try {
    const dir = writeLedger(root, {
      runnerState: 'running',
      ownerPid: 999999,
      heartbeatAt: new Date().toISOString(),
      config: { mode: 'regime', pollMs: 900_000 },
      balance: 100_000_000,
      positions: {},
      trades: [],
      dataQuality: {
        valid: false,
        reason: 'daily_market_stale',
        staleMarkets: ['KRW-BTC'],
        missingMarkets: [],
        unalignedMarkets: [],
        maxAgeHours: 36
      },
      dataQualityBlocked: 4
    });
    const result = runStatus(dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /data quality BLOCKED: daily_market_stale/);
    assert.match(result.stdout, /stale KRW-BTC/);
    assert.match(result.stdout, /maxAge 36h/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('momentum shadow status includes the relative-strength A/B book in its default inventory', () => {
  const source = fs.readFileSync(statusScript, 'utf8');
  assert.match(source, /\.paper-momentum-shadow-fixed-hold-2d-relative-v1/);
});
