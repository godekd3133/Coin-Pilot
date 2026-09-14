import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRiskMonitorState,
  getRiskMonitorStatus,
  recordRiskMonitorFailure,
  recordRiskMonitorIdle,
  recordRiskMonitorAttempt,
  recordRiskMonitorStale,
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

test('활성 risk check의 성공 timestamp가 오래되면 실패 callback 없이도 fail-closed 된다', () => {
  const start = Date.parse('2026-09-13T00:00:00.000Z');
  let state = createRiskMonitorState({
    monitoringActive: true,
    monitoringStartedAt: new Date(start).toISOString()
  });
  state = recordRiskMonitorSuccess(state, start);

  const stale = getRiskMonitorStatus(state, start + 31_000, 30);

  assert.equal(stale.currentOutageDurationSeconds, 31);
  assert.equal(stale.riskDataFresh, false);
  assert.equal(stale.failClosed, true);
  assert.equal(stale.continuityEligible, false);
  assert.equal(stale.staleReason, 'risk_check_stale');
});

test('stale risk 관찰은 원래 성공 시각부터 outage로 보존된다', () => {
  const start = Date.parse('2026-09-13T00:00:00.000Z');
  let state = createRiskMonitorState({
    monitoringActive: true,
    monitoringStartedAt: new Date(start).toISOString()
  });
  state = recordRiskMonitorSuccess(state, start);

  const stale = recordRiskMonitorStale(state, start + 31_000, 30);

  assert.equal(stale.failClosed, true);
  assert.equal(stale.state.continuityEligible, false);
  assert.equal(stale.state.lastFailureCode, 'RISK_CHECK_STALE');
  assert.equal(stale.state.outageCount, 1);
  assert.equal(stale.state.currentOutageStartedAt, new Date(start).toISOString());
  assert.equal(stale.outageDurationSeconds, 31);
});

test('포지션이 없는 idle 구간은 오래되어도 risk outage로 오인하지 않는다', () => {
  const start = Date.parse('2026-09-13T00:00:00.000Z');
  let state = createRiskMonitorState({ monitoringActive: true });
  state = recordRiskMonitorSuccess(state, start);
  state = recordRiskMonitorIdle(state);

  const idle = getRiskMonitorStatus(state, start + 3_600_000, 30);

  assert.equal(idle.monitoringActive, false);
  assert.equal(idle.riskDataFresh, true);
  assert.equal(idle.failClosed, false);
  assert.equal(idle.continuityEligible, true);
});

test('idle 이후 risk monitor 재개는 idle 구간을 stale outage로 계산하지 않는다', () => {
  const start = Date.parse('2026-09-13T00:00:00.000Z');
  let state = createRiskMonitorState();
  state = recordRiskMonitorSuccess(state, start, 30);
  state = recordRiskMonitorIdle(state);
  state = recordRiskMonitorAttempt(state, start + 3_600_000);

  const resumed = recordRiskMonitorSuccess(state, start + 3_600_001, 30);

  assert.equal(resumed.lastFailureCode, null);
  assert.equal(resumed.currentOutageStartedAt, null);
  assert.equal(resumed.maxObservedGapSeconds, 0);
  assert.equal(resumed.continuityEligible, true);
});

test('허용 공백 뒤 도착한 성공 callback도 risk continuity를 되살리지 않는다', () => {
  const start = Date.parse('2026-09-13T00:00:00.000Z');
  let state = createRiskMonitorState({
    monitoringActive: true,
    monitoringStartedAt: new Date(start).toISOString()
  });
  state = recordRiskMonitorSuccess(state, start, 30);

  const delayed = recordRiskMonitorSuccess(state, start + 31_000, 30);

  assert.equal(delayed.lastFailureCode, 'RISK_CHECK_STALE');
  assert.equal(delayed.continuityEligible, false);
  assert.equal(delayed.maxObservedGapSeconds, 31);
  assert.equal(delayed.currentOutageStartedAt, new Date(start).toISOString());
});
