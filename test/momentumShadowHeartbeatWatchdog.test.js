import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getMomentumShadowHeartbeatAgeMs,
  isMomentumShadowHeartbeatStale
} from '../src/research/momentumShadowHeartbeatWatchdog.js';

test('momentum shadow heartbeat watchdog keeps a fresh completed cycle alive', () => {
  const now = Date.parse('2026-09-15T01:00:00.000Z');
  assert.equal(
    getMomentumShadowHeartbeatAgeMs({
      heartbeatAt: '2026-09-15T00:59:30.000Z',
      now
    }),
    30_000
  );
  assert.equal(isMomentumShadowHeartbeatStale({
    heartbeatAt: '2026-09-15T00:59:30.000Z',
    now,
    staleLimitMs: 60_000
  }), false);
});

test('momentum shadow heartbeat watchdog fails closed on stale or malformed state', () => {
  const now = Date.parse('2026-09-15T01:00:00.000Z');
  assert.equal(isMomentumShadowHeartbeatStale({
    heartbeatAt: '2026-09-15T00:58:59.000Z',
    now,
    staleLimitMs: 60_000
  }), true);
  assert.equal(isMomentumShadowHeartbeatStale({
    heartbeatAt: 'not-a-date',
    now,
    staleLimitMs: 60_000
  }), true);
});

test('momentum shadow heartbeat watchdog fails closed on a future heartbeat', () => {
  const now = Date.parse('2026-09-15T01:00:00.000Z');
  // A heartbeat written in the future is clock-skewed, not fresh: it must
  // not keep a dead or diverged owner looking alive.
  assert.equal(getMomentumShadowHeartbeatAgeMs({
    heartbeatAt: '2026-09-15T01:00:30.000Z',
    now
  }), null);
  assert.equal(isMomentumShadowHeartbeatStale({
    heartbeatAt: '2026-09-15T01:00:30.000Z',
    now,
    staleLimitMs: 60_000
  }), true);
});
