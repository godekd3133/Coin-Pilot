import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_CONSECUTIVE_FETCH_FAILURES,
  recordMomentumShadowFetchFailure,
  recordMomentumShadowFetchSuccess,
  resolveMomentumShadowFetchFailureLimit
} from '../src/research/momentumShadowNetworkGuard.js';

test('network fetch failure budget clamps invalid values and keeps a bounded default', () => {
  assert.equal(DEFAULT_MAX_CONSECUTIVE_FETCH_FAILURES, 3);
  assert.equal(resolveMomentumShadowFetchFailureLimit('2.9'), 2);
  assert.equal(resolveMomentumShadowFetchFailureLimit('0'), 3);
  assert.equal(resolveMomentumShadowFetchFailureLimit('bad', 5), 5);
});

test('network fetch circuit opens only after the configured consecutive failures', () => {
  const ledger = {};
  const error = Object.assign(new Error('temporary DNS failure'), { code: 'ENOTFOUND' });
  const first = recordMomentumShadowFetchFailure(ledger, error, {
    consecutiveFailures: 1,
    maxConsecutiveFailures: 3,
    now: Date.parse('2026-01-01T00:00:00.000Z')
  });
  const second = recordMomentumShadowFetchFailure(ledger, error, {
    consecutiveFailures: 2,
    maxConsecutiveFailures: 3,
    now: Date.parse('2026-01-01T00:00:01.000Z')
  });
  const third = recordMomentumShadowFetchFailure(ledger, error, {
    consecutiveFailures: 3,
    maxConsecutiveFailures: 3,
    now: Date.parse('2026-01-01T00:00:02.000Z')
  });

  assert.equal(first.circuitOpen, false);
  assert.equal(second.circuitOpen, false);
  assert.equal(third.circuitOpen, true);
  assert.equal(ledger.networkFetchCircuitOpen, true);
  assert.equal(ledger.networkFetchCircuitBreaks, 1);
  assert.equal(ledger.networkFetchFailureCountsByCode.ENOTFOUND, 3);
  assert.equal(ledger.lastNetworkFetchError.code, 'ENOTFOUND');
  assert.equal(ledger.lastNetworkFetchError.at, '2026-01-01T00:00:02.000Z');
});

test('successful fetch closes the current circuit state without deleting failure evidence', () => {
  const ledger = {
    networkFetchFailureStreak: 3,
    networkFetchCircuitOpen: true,
    networkFetchCircuitBreaks: 2,
    lastNetworkFetchError: { code: 'ECONNABORTED' }
  };

  const result = recordMomentumShadowFetchSuccess(ledger);

  assert.deepEqual(result, { consecutiveFailures: 0, circuitOpen: false });
  assert.equal(ledger.networkFetchFailureStreak, 0);
  assert.equal(ledger.networkFetchCircuitOpen, false);
  assert.equal(ledger.networkFetchCircuitBreaks, 2);
  assert.equal(ledger.lastNetworkFetchError.code, 'ECONNABORTED');
});
