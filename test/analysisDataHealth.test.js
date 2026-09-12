import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAnalysisDataHealthState,
  getAnalysisDataHealthStatus,
  recordAnalysisDataFailure,
  recordAnalysisDataSuccess,
  resolveMaxAnalysisDataGapSeconds
} from '../src/risk/analysisDataHealth.js';

test('짧은 부분 분석은 복구 시 연속성을 유지하고 공백 길이를 기록한다', () => {
  const start = Date.UTC(2026, 8, 11, 0, 0, 0);
  const failed = recordAnalysisDataFailure(
    createAnalysisDataHealthState(),
    { expectedMarketCount: 3, analyzedMarketCount: 2, missingMarkets: ['KRW-ETH'] },
    start,
    60
  );
  assert.equal(failed.failClosed, false);
  assert.equal(failed.state.consecutiveIncompleteCycles, 1);

  const recovered = recordAnalysisDataSuccess(
    failed.state,
    { expectedMarketCount: 3, analyzedMarketCount: 3 },
    start + 30_000
  );
  assert.equal(recovered.currentGapStartedAt, null);
  assert.equal(recovered.continuityEligible, true);
  assert.equal(recovered.maxObservedGapSeconds, 30);
  assert.deepEqual(recovered.lastMissingMarkets, []);
});

test('부분 분석 공백이 한도를 넘으면 fail-closed하고 연속성을 영구 보류한다', () => {
  const start = Date.UTC(2026, 8, 11, 0, 0, 0);
  const first = recordAnalysisDataFailure(
    {},
    { expectedMarketCount: 2, analyzedMarketCount: 0, missingMarkets: ['KRW-BTC', 'KRW-ETH'] },
    start,
    10
  );
  const exceeded = recordAnalysisDataFailure(
    first.state,
    { expectedMarketCount: 2, analyzedMarketCount: 1, missingMarkets: ['KRW-ETH'] },
    start + 10_000,
    10
  );
  assert.equal(exceeded.failClosed, true);
  assert.equal(exceeded.state.continuityEligible, false);
  assert.equal(exceeded.state.totalIncompleteCycles, 2);
  assert.equal(exceeded.state.totalMissingMarkets, 3);

  const status = getAnalysisDataHealthStatus(exceeded.state, start + 20_000, 10);
  assert.equal(status.failClosed, true);
  assert.equal(status.continuityEligible, false);
  assert.equal(status.currentGapDurationSeconds, 20);
  assert.deepEqual(status.lastMissingMarkets, ['KRW-ETH']);
});

test('분석 데이터 공백 설정은 양수 최소값과 명시적 0을 보존한다', () => {
  assert.equal(resolveMaxAnalysisDataGapSeconds(0, 60), 0);
  assert.equal(resolveMaxAnalysisDataGapSeconds(2, 60), 5);
  assert.equal(resolveMaxAnalysisDataGapSeconds(undefined, 60), 60);
});
