import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLossCircuitBreakerState,
  getLossCircuitBreakerStatus,
  isLossCircuitCoolingDown,
  registerLoss
} from '../src/risk/lossCircuitBreaker.js';

test('전역 손실 회로차단기는 sliding window의 임계 횟수에서 발동하고 만료된다', () => {
  const state = createLossCircuitBreakerState();
  const start = Date.UTC(2026, 0, 1, 0, 0, 0);
  const config = {
    maxLosses: 2,
    windowMinutes: 30,
    cooldownMinutes: 60
  };

  assert.equal(registerLoss(state, start, config).triggered, false);
  const triggered = registerLoss(state, start + 5 * 60 * 1000, config);
  assert.equal(triggered.triggered, true);
  assert.equal(isLossCircuitCoolingDown(state, start + 10 * 60 * 1000, config), true);

  const active = getLossCircuitBreakerStatus(state, start + 10 * 60 * 1000, config);
  assert.equal(active.enabled, true);
  assert.equal(active.lossCount, 2);
  assert.equal(active.coolingDown, true);
  assert.equal(active.cooldownRemainingMs, 55 * 60 * 1000);

  const expired = getLossCircuitBreakerStatus(state, start + 66 * 60 * 1000, config);
  assert.equal(expired.coolingDown, false);
  assert.equal(expired.lossCount, 0);
});

test('손실 회로차단기 count=0은 상태를 막지 않는다', () => {
  const state = createLossCircuitBreakerState();
  const result = registerLoss(state, Date.now(), {
    maxLosses: 0,
    windowMinutes: 30,
    cooldownMinutes: 60
  });

  assert.equal(result.triggered, false);
  assert.equal(state.lossTimestamps.length, 0);
  assert.equal(getLossCircuitBreakerStatus(state).enabled, false);
  assert.equal(isLossCircuitCoolingDown(state), false);
});
