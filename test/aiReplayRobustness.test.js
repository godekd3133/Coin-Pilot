import test from 'node:test';
import assert from 'node:assert/strict';
import assessReplayRobustness from '../src/ai/replayRobustness.js';

function report(rows, generatedAt) {
  return { generatedAt, selectedSamples: rows.length, responseCount: rows.length, failures: [], rows };
}

test('replay robustness는 서로 부호가 다른 window를 충분성으로 승격하지 않는다', () => {
  const result = assessReplayRobustness([
    report([
      { action: 'WAIT', eventType: 'BUY_SIGNAL', priceChangePercent: -0.6 },
      { action: 'WAIT', eventType: 'BUY_SIGNAL', priceChangePercent: 0.4 }
    ], 'window-a'),
    report([
      { action: 'WAIT', eventType: 'BUY_SIGNAL', priceChangePercent: 0.4 },
      { action: 'WAIT', eventType: 'BUY_SIGNAL', priceChangePercent: 0.4 }
    ], 'window-b')
  ], { minimumNonNeutralSamples: 3, neutralBandPercent: 0.3 });

  assert.equal(result.status, 'WINDOW_CONFLICT');
  assert.equal(result.windowSignConflict, true);
  assert.equal(result.evidenceReady, false);
  assert.equal(result.total.nonNeutral, 4);
  assert.equal(result.total.vetoGood, 1);
  assert.equal(result.total.vetoMissedOpportunity, 3);
});

test('replay robustness는 두 window의 안정적인 non-neutral veto를 별도로 표시한다', () => {
  const result = assessReplayRobustness([
    report(Array.from({ length: 10 }, () => ({ action: 'WAIT', eventType: 'BUY_SIGNAL', priceChangePercent: -0.6 })), 'window-a'),
    report(Array.from({ length: 10 }, () => ({ action: 'WAIT', eventType: 'BUY_SIGNAL', priceChangePercent: -0.7 })), 'window-b')
  ], { minimumNonNeutralSamples: 20, neutralBandPercent: 0.3 });

  assert.equal(result.status, 'STABLE_POSITIVE_VETO');
  assert.equal(result.evidenceReady, true);
  assert.equal(result.windowSignConflict, false);
  assert.equal(result.total.nonNeutral, 20);
  assert.equal(result.total.vetoGood, 20);
});
