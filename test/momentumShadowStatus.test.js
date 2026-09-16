import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
        maxEntryGapPercent: 0.2
      },
      balance: 100_000_000,
      positions: {},
      trades: [],
      volatilityScaleByMarket: { 'KRW-BTC': 1, 'KRW-ETH': 0.25 },
      volatilityBlocked: 2,
      duplicateSignalBlocked: 3,
      pendingEntries: [],
      pendingEntryGapBlocked: 2
    });
    const result = runStatus(dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /volatility target 1\.00%\/14d/);
    assert.match(result.stdout, /scale 0\.250~1\.000/);
    assert.match(result.stdout, /blocked 2/);
    assert.match(result.stdout, /duplicateSignalBlocked 3/);
    assert.match(result.stdout, /entry gap ceiling 0\.20%/);
    assert.match(result.stdout, /gapBlocked 2/);
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
