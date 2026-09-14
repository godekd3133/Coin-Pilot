import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recordMomentumShadowRunnerStart,
  recordMomentumShadowRunnerStop
} from '../src/research/momentumShadowRunnerState.js';

test('momentum shadow runner lifecycle records start, stop reason, and error', () => {
  const ledger = { startedAt: '2026-09-13T00:00:00.000Z' };
  recordMomentumShadowRunnerStart(ledger, {
    pid: 123,
    at: '2026-09-14T00:00:00.000Z',
    staleRecovery: {
      pid: 99,
      startedAt: '2026-09-13T12:00:00.000Z'
    },
  });
  recordMomentumShadowRunnerStop(ledger, {
    pid: 123,
    at: '2026-09-14T00:05:00.000Z',
    reason: 'uncaught_exception',
    error: new Error('fixture failure'),
  });

  assert.equal(ledger.startedAt, '2026-09-13T00:00:00.000Z');
  assert.equal(ledger.runnerState, 'stopped');
  assert.equal(ledger.runnerPid, 123);
  assert.equal(ledger.runnerStartedAt, '2026-09-14T00:00:00.000Z');
  assert.equal(ledger.runnerStoppedAt, '2026-09-14T00:05:00.000Z');
  assert.equal(ledger.runnerStopReason, 'uncaught_exception');
  assert.deepEqual(ledger.runnerLastError, {
    name: 'Error',
    message: 'fixture failure',
  });
  assert.equal(ledger.runnerEvents[0].type, 'stale_lock_recovered');
  assert.equal(ledger.runnerEvents[1].type, 'started');
  assert.equal(ledger.runnerEvents[2].type, 'stopped');
});

test('momentum shadow runner stale-lock recovery records unknown external termination', () => {
  const ledger = {
    heartbeatAt: '2026-09-14T01:00:00.000Z',
    runnerState: 'running',
    runnerPid: 456,
  };
  recordMomentumShadowRunnerStart(ledger, {
    pid: 789,
    at: '2026-09-14T02:00:00.000Z',
    staleRecovery: {
      pid: 456,
      startedAt: '2026-09-14T00:00:00.000Z',
    },
  });

  assert.equal(ledger.runnerState, 'running');
  assert.equal(ledger.runnerEvents[0].type, 'stale_lock_recovered');
  assert.equal(ledger.runnerEvents[0].reason, 'abrupt_or_external_termination');
  assert.equal(ledger.runnerEvents[0].previousPid, 456);
  assert.equal(ledger.runnerEvents[0].previousHeartbeatAt, '2026-09-14T01:00:00.000Z');
});
