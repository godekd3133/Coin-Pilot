import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OptimizationScheduler } from '../src/api/optimizationScheduler.js';

async function scheduler(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'coinpilot-outcome-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const value = new OptimizationScheduler({ tradingSystem: { dryRun: true }, projectRoot: dir,
    collectCandleData: async () => Array.from({ length: 100 }, () => ({})), ...options });
  value.state.enabled = false;
  return value;
}
test('an insufficient-data attempt remains distinguishable from no comparison history', async t => {
  const value = await scheduler(t);
  const result = await value.runCycle();
  assert.equal(result.skipped, true);
  assert.equal(value.state.isRunning, false);
  assert.equal(value.state.lastRun, null);
  assert.deepEqual(value.state.lastOutcome, { status: 'INSUFFICIENT_DATA', candleCount: 100, minimumCandleCount: 250 });
  const stored = JSON.parse(await fs.readFile(value.stateFile, 'utf8'));
  assert.equal(stored.lastOutcome.status, 'INSUFFICIENT_DATA');
});
test('a failed collection cannot look like a completed comparison', async t => {
  const value = await scheduler(t, { collectCandleData: async () => { throw new Error('synthetic error'); } });
  await value.runCycle();
  assert.equal(value.state.lastOutcome.status, 'FAILED');
  assert.equal(value.state.lastRun, null);
  assert.equal(value.state.isRunning, false);
});
test('a server restart exposes an interrupted comparison rather than a running one', async t => {
  const value = await scheduler(t);
  value.state.lastAttemptAt = new Date().toISOString();
  value.state.lastOutcome = { status: 'RUNNING' };
  value.save();
  const restored = new OptimizationScheduler({ projectRoot: value.projectRoot });
  restored.loadState();
  assert.equal(restored.state.lastOutcome.status, 'INTERRUPTED');
  assert.equal(restored.state.isRunning, false);
  assert.equal(restored.state.lastRun, null);
  assert.equal(restored.state.lastAttemptAt, value.state.lastAttemptAt);
});
test('a successful comparison records completion without applying parameters', async t => {
  let applied = false;
  const value = await scheduler(t, { collectCandleData: async () => Array.from({ length: 250 }, () => ({})),
    createParameterOptimizer: async () => ({ optimize: async () => ({ fitness: 0.1, parameters: { investmentRatio: 0.04 } }) }),
    applyOptimalParameters: async () => { applied = true; } });
  await value.runCycle();
  assert.equal(value.state.lastOutcome.status, 'COMPLETED');
  assert.equal(value.state.isRunning, false);
  assert.ok(value.state.lastRun);
  assert.equal(applied, false);
});
