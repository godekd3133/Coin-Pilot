import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MOMENTUM_SHADOW_MAX_CYCLE_DURATION_MS,
  isMomentumShadowCycleTimedOut,
  resolveMomentumShadowMaxCycleDurationMs
} from '../src/research/momentumShadowCycleWatchdog.js';

test('cycle watchdog resolves a bounded operational timeout', () => {
  assert.equal(DEFAULT_MOMENTUM_SHADOW_MAX_CYCLE_DURATION_MS, 600_000);
  assert.equal(resolveMomentumShadowMaxCycleDurationMs('600001.9'), 600001);
  assert.equal(resolveMomentumShadowMaxCycleDurationMs('1000'), 60_000);
  assert.equal(resolveMomentumShadowMaxCycleDurationMs('bad', 900_000), 900_000);
});

test('cycle watchdog distinguishes an in-budget fetch from a timed-out cycle', () => {
  assert.equal(isMomentumShadowCycleTimedOut({
    startedAt: 1_000,
    now: 600_000,
    timeoutMs: 600_000
  }), false);
  // Elapsed exactly at the limit has consumed the whole budget: a one-shot
  // timer that fires on schedule must still count as timed out.
  assert.equal(isMomentumShadowCycleTimedOut({
    startedAt: 1_000,
    now: 601_000,
    timeoutMs: 600_000
  }), true);
  assert.equal(isMomentumShadowCycleTimedOut({
    startedAt: 1_000,
    now: 601_001,
    timeoutMs: 600_000
  }), true);
  assert.equal(isMomentumShadowCycleTimedOut({
    startedAt: 'invalid',
    now: 601_001,
    timeoutMs: 600_000
  }), false);
});
