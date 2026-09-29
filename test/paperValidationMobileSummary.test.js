import test from 'node:test';
import assert from 'node:assert/strict';
import { projectPaperValidationMobileSummary } from '../src/api/paperValidationMobileSummary.js';

test('모바일 요약은 strict·진단 장부와 비용 민감도를 분리하고 실제 체결을 주장하지 않는다', () => {
  const summary = projectPaperValidationMobileSummary({
    available: true,
    active: true,
    eligible: false,
    configSnapshotComplete: true,
    heartbeatAt: '2026-09-29T01:00:00.000Z',
    continuityEligible: true,
    interruptionCount: 0,
    strictEvaluation: {
      closedTradeCount: 2,
      realizedProfit: -125,
      activePositions: 1
    },
    shadowEvaluation: {
      closedTradeCount: 3,
      realizedProfit: -330,
      activePositions: 2
    },
    looseShadowEvaluation: {
      closedTradeCount: 4,
      realizedProfit: -410,
      activePositions: 0
    },
    analysisDataHealth: {
      continuityEligible: false,
      totalMissingMarkets: 2
    },
    riskMonitor: { continuityEligible: true },
    strictExecutionCostAudit: {
      available: true,
      actualFillsObserved: true,
      evaluatedTradeCount: 2,
      modeledExecutionTradeCount: 1,
      unmodeledExecutionTradeCount: 1,
      configuredSlippagePercent: 0.1,
      recordedNetPnlKrw: -125,
      modeledSlippageDragKrw: 20,
      costStressedNetPnlKrw: -145,
      note: 'reference sensitivity'
    }
  });

  assert.equal(summary.schema, 'coinpilot.paper-validation-mobile-summary.v1');
  assert.equal(summary.researchOnly, true);
  assert.equal(summary.promoted, false);
  assert.equal(summary.actualFillsObserved, false);
  assert.equal(summary.available, true);
  assert.equal(summary.active, true);
  assert.equal(summary.configSnapshotComplete, true);
  assert.equal(summary.continuityEligible, true);
  assert.equal(summary.analysisContinuityEligible, false);
  assert.equal(summary.analysisMissingMarketCount, 2);
  assert.deepEqual(summary.strict, {
    closedTradeCount: 2,
    realizedProfitKrw: -125,
    openPositionCount: 1
  });
  assert.deepEqual(summary.diagnostic, {
    shadowClosedTradeCount: 3,
    shadowRealizedProfitKrw: -330,
    shadowOpenPositionCount: 2,
    looseClosedTradeCount: 4,
    looseRealizedProfitKrw: -410,
    looseOpenPositionCount: 0
  });
  assert.equal(summary.costAudit.costStressedNetPnlKrw, -145);
  assert.equal(summary.costAudit.actualFillsObserved, false);
  assert.equal('strictRecentTrades' in summary, false);
  assert.equal('configSnapshot' in summary, false);
});

test('모바일 요약은 사용할 수 없는 표본을 0 손익·0 거래로 바꾸지 않는다', () => {
  const summary = projectPaperValidationMobileSummary({
    available: false,
    active: false,
    reason: 'paper_validation_session_not_started'
  });

  assert.equal(summary.available, false);
  assert.equal(summary.active, null);
  assert.equal(summary.strict.closedTradeCount, null);
  assert.equal(summary.strict.realizedProfitKrw, null);
  assert.equal(summary.diagnostic.shadowClosedTradeCount, null);
  assert.equal(summary.costAudit.available, false);
  assert.equal(summary.costAudit.evaluatedTradeCount, null);
  assert.equal(summary.actualFillsObserved, false);
});

test('비용 감사가 없는 경우 별도 비용 추정치를 꾸며내지 않는다', () => {
  const summary = projectPaperValidationMobileSummary({
    available: true,
    active: false,
    configSnapshotComplete: false,
    strictEvaluation: {
      closedTradeCount: 1,
      realizedProfit: 50,
      activePositions: 0
    }
  });

  assert.equal(summary.strict.realizedProfitKrw, 50);
  assert.equal(summary.configSnapshotComplete, false);
  assert.equal(summary.costAudit.available, false);
  assert.equal(summary.costAudit.recordedNetPnlKrw, null);
  assert.equal(summary.costAudit.costStressedNetPnlKrw, null);
});

test('전체 paper cohort는 비교 불가능한 혼합손익을 숨기고 적격 표본만 노출한다', () => {
  const summary = projectPaperValidationMobileSummary(
    { available: false },
    null,
    {
      capturedAt: '2026-09-29T03:00:00.000Z',
      fresh: true,
      summary: {
        sessionCount: 95,
        activeSessionCount: 1,
        endedSessionCount: 91,
        strictTradeCount: 55,
        strictTradeSessionCount: 25,
        eligibleStrictSessionCount: 0,
        eligibleStrictTradeCount: 0,
        profitabilityEvidenceSessionCount: 0,
        profitabilityEvidenceTradeCount: 0,
        profitabilityEvidenceProfit: null,
        strictCostUnverifiedTradeCount: 2,
        profitabilityEvidenceExclusionCounts: {
          observation_days_below_minimum: 91,
          trade_count_below_minimum: 95
        },
        totalStrictProfit: 1314.23,
        totalStrictProfitComparable: false,
        actualFillsObserved: false,
        promoted: false,
        readErrors: []
      }
    }
  );

  assert.equal(summary.cohort.available, true);
  assert.equal(summary.cohort.complete, true);
  assert.equal(summary.cohort.fresh, true);
  assert.equal(summary.cohort.sessionCount, 95);
  assert.equal(summary.cohort.strictTradeCount, 55);
  assert.equal(summary.cohort.eligibleStrictTradeCount, 0);
  assert.equal(summary.cohort.profitabilityEvidenceTradeCount, 0);
  assert.equal(summary.cohort.profitabilityEvidenceProfitKrw, null);
  assert.equal(summary.cohort.sessionsBelowMinimumObservationDays, 91);
  assert.equal(summary.cohort.sessionsBelowMinimumTradeCount, 95);
  assert.equal(summary.cohort.totalStrictProfitComparable, false);
  assert.equal(summary.cohort.actualFillsObserved, false);
  assert.equal('totalStrictProfit' in summary.cohort, false);
});

test('cohort 일부를 읽지 못하면 부분 통계를 완전한 수익성 근거처럼 노출하지 않는다', () => {
  const summary = projectPaperValidationMobileSummary(
    { available: false },
    null,
    {
      capturedAt: '2026-09-29T03:00:00.000Z',
      fresh: false,
      summary: {
        sessionCount: 3,
        strictTradeCount: 8,
        eligibleStrictTradeCount: 8,
        profitabilityEvidenceTradeCount: 8,
        profitabilityEvidenceProfit: 500,
        totalStrictProfitComparable: false,
        readErrors: ['private path and error text']
      }
    }
  );

  assert.equal(summary.cohort.available, true);
  assert.equal(summary.cohort.complete, false);
  assert.equal(summary.cohort.fresh, false);
  assert.equal(summary.cohort.readErrorCount, 1);
  assert.equal(summary.cohort.sessionCount, null);
  assert.equal(summary.cohort.strictTradeCount, null);
  assert.equal(summary.cohort.eligibleStrictTradeCount, null);
  assert.equal(summary.cohort.profitabilityEvidenceProfitKrw, null);
  assert.equal(JSON.stringify(summary).includes('private path'), false);
});

test('완전한 cohort에서 비교 불가 raw 손익을 빼고 적격 거래·체결 증거만 전달한다', () => {
  const summary = projectPaperValidationMobileSummary(
    { available: false },
    null,
    {
      capturedAt: '2026-09-29T04:00:00.000Z',
      fresh: true,
      summary: {
        sessionCount: 95,
        activeSessionCount: 1,
        endedSessionCount: 91,
        strictTradeCount: 55,
        strictTradeSessionCount: 25,
        eligibleStrictSessionCount: 0,
        eligibleStrictTradeCount: 0,
        profitabilityEvidenceSessionCount: 0,
        profitabilityEvidenceTradeCount: 0,
        profitabilityEvidenceProfit: null,
        strictCostUnverifiedTradeCount: 2,
        profitabilityEvidenceExclusionCounts: {
          observation_days_below_minimum: 91,
          trade_count_below_minimum: 95
        },
        totalStrictProfit: 1314.23,
        totalStrictProfitComparable: false,
        actualFillsObserved: false,
        promoted: false,
        readErrors: []
      }
    }
  );

  assert.deepEqual(summary.cohort, {
    available: true,
    complete: true,
    fresh: true,
    capturedAt: '2026-09-29T04:00:00.000Z',
    readErrorCount: 0,
    sessionCount: 95,
    activeSessionCount: 1,
    endedSessionCount: 91,
    strictTradeCount: 55,
    strictTradeSessionCount: 25,
    eligibleStrictSessionCount: 0,
    eligibleStrictTradeCount: 0,
    profitabilityEvidenceSessionCount: 0,
    profitabilityEvidenceTradeCount: 0,
    profitabilityEvidenceProfitKrw: null,
    strictCostUnverifiedTradeCount: 2,
    sessionsBelowMinimumObservationDays: 91,
    sessionsBelowMinimumTradeCount: 95,
    totalStrictProfitComparable: false,
    actualFillsObserved: false,
    promoted: false
  });
  assert.equal('totalStrictProfit' in summary.cohort, false);
});
