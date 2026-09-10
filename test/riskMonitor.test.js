import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRiskMonitorState,
  getRiskMonitorStatus,
  recordRiskMonitorFailure,
  recordRiskMonitorSuccess,
  resolveMaxRiskDataGapSeconds
} from '../src/risk/riskMonitor.js';

test('risk monitor는 연속 ticker 실패와 허용 공백 초과를 기록한다', () => {
  const start = Date.parse('2026-09-10T00:00:00.000Z');
  let state = createRiskMonitorState();
  state = recordRiskMonitorSuccess(state, start);
  const first = recordRiskMonitorFailure(state, Object.assign(new Error('DNS failure'), { code: 'ENOTFOUND' }), start + 10_000, 30);
  assert.equal(first.failClosed, false);
  assert.equal(first.state.consecutiveFailures, 1);
  assert.equal(first.state.outageCount, 1);
  assert.equal(first.state.lastFailureCode, 'ENOTFOUND');

  const second = recordRiskMonitorFailure(first.state, Object.assign(new Error('DNS failure'), { code: 'ENOTFOUND' }), start + 41_000, 30);
  assert.equal(second.failClosed, true);
  assert.equal(second.state.continuityEligible, false);
  assert.equal(second.outageDurationSeconds, 31);
  assert.equal(getRiskMonitorStatus(second.state, start + 60_000, 30).continuityEligible, false);
});

test('risk monitor 성공은 일시적 실패 카운터를 초기화하지만 이미 깨진 continuity는 되살리지 않는다', () => {
  const start = Date.parse('2026-09-10T00:00:00.000Z');
  let state = createRiskMonitorState();
  const failed = recordRiskMonitorFailure(state, new Error('timeout'), start + 1_000, 30);
  state = failed.state;
  const recovered = recordRiskMonitorSuccess(state, start + 2_000);
  assert.equal(recovered.consecutiveFailures, 0);
  assert.equal(recovered.currentOutageStartedAt, null);
  assert.equal(recovered.continuityEligible, true);

  const firstOutageFailure = recordRiskMonitorFailure(recovered, new Error('timeout'), start + 40_000, 30);
  const outage = recordRiskMonitorFailure(firstOutageFailure.state, new Error('timeout'), start + 71_000, 30);
  assert.equal(outage.state.continuityEligible, false);
  const recoveredAfterOutage = recordRiskMonitorSuccess(outage.state, start + 41_000);
  assert.equal(recoveredAfterOutage.consecutiveFailures, 0);
  assert.equal(recoveredAfterOutage.continuityEligible, false);
});

test('스캘핑 risk data gap은 최소 5초로 제한되고 명시적 0은 비활성화한다', () => {
  assert.equal(resolveMaxRiskDataGapSeconds(2), 5);
  assert.equal(resolveMaxRiskDataGapSeconds(0), 0);
  assert.equal(resolveMaxRiskDataGapSeconds(undefined, 30), 30);
});
