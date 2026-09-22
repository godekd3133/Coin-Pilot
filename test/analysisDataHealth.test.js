import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAnalysisDataHealthState,
  getAnalysisDataHealthStatus,
  recordAnalysisDataAttempt,
  recordAnalysisDataFailure,
  recordAnalysisDataIdle,
  recordAnalysisDataStale,
  recordAnalysisDataSuccess
} from '../src/risk/analysisDataHealth.js';

test('활성 analysis cycle의 완료 timestamp가 오래되면 fail-closed 된다', () => {
  const start = Date.parse('2026-09-13T00:00:00.000Z');
  let state = recordAnalysisDataSuccess(
    createAnalysisDataHealthState(),
    { expectedMarketCount: 1, analyzedMarketCount: 1 },
    start
  );
  state = recordAnalysisDataAttempt(state, start + 1_000);

  const stale = getAnalysisDataHealthStatus(state, start + 61_000, 60);

  assert.equal(stale.currentGapDurationSeconds, 61);
  assert.equal(stale.analysisDataFresh, false);
  assert.equal(stale.failClosed, true);
  assert.equal(stale.continuityEligible, false);
  assert.equal(stale.staleReason, 'analysis_cycle_stale');
});

test('stale analysis cycle은 마지막 정상 완료 시각부터 공백으로 보존된다', () => {
  const start = Date.parse('2026-09-13T00:00:00.000Z');
  let state = recordAnalysisDataSuccess(
    createAnalysisDataHealthState(),
    { expectedMarketCount: 1, analyzedMarketCount: 1 },
    start
  );
  state = recordAnalysisDataAttempt(state, start + 1_000);

  const stale = recordAnalysisDataStale(
    state,
    { expectedMarketCount: 1, analyzedMarketCount: 0, missingMarkets: ['KRW-BTC'] },
    start + 61_000,
    60
  );

  assert.equal(stale.failClosed, true);
  assert.equal(stale.state.continuityEligible, false);
  assert.equal(stale.state.currentGapStartedAt, new Date(start).toISOString());
  assert.equal(stale.state.lastMissingMarkets[0], 'KRW-BTC');
  assert.equal(stale.gapDurationSeconds, 61);
});

test('analysis failure는 raw error 대신 안전한 원인 분류와 시장을 보존한다', () => {
  const start = Date.parse('2026-09-18T02:00:00.000Z');
  const failure = recordAnalysisDataFailure(
    createAnalysisDataHealthState(),
    {
      expectedMarketCount: 4,
      analyzedMarketCount: 0,
      missingMarkets: ['KRW-BTC', 'KRW-ETH'],
      failureCode: 'network_fetch_failed',
      failureMarkets: ['KRW-BTC', 'KRW-ETH'],
      failureCounts: { network_fetch_failed: 2 }
    },
    start + 61_000,
    60
  );

  assert.equal(failure.failureCode, 'network_fetch_failed');
  assert.deepEqual(failure.failureMarkets, ['KRW-BTC', 'KRW-ETH']);
  assert.equal(failure.state.lastFailureCode, 'network_fetch_failed');
  assert.deepEqual(failure.state.failureCounts, { network_fetch_failed: 2 });
  assert.equal(failure.state.lastFailureMessage, undefined);
});

test('analysis idle 구간은 오래되어도 데이터 공백으로 오인하지 않는다', () => {
  const start = Date.parse('2026-09-13T00:00:00.000Z');
  let state = recordAnalysisDataAttempt(createAnalysisDataHealthState(), start);
  state = recordAnalysisDataSuccess(
    state,
    { expectedMarketCount: 1, analyzedMarketCount: 1 },
    start + 1_000
  );
  state = recordAnalysisDataIdle(state);

  const idle = getAnalysisDataHealthStatus(state, start + 3_600_000, 60);

  assert.equal(idle.analysisActive, false);
  assert.equal(idle.analysisDataFresh, true);
  assert.equal(idle.failClosed, false);
  assert.equal(idle.continuityEligible, true);
});
