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
