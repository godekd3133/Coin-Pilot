const MOBILE_PAPER_SUMMARY_SCHEMA = 'coinpilot.paper-validation-mobile-summary.v1';

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function count(value) {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed >= 0 ? Math.floor(parsed) : null;
}

function nullableBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

function projectBook(evaluation = null) {
  return {
    closedTradeCount: count(evaluation?.closedTradeCount),
    realizedProfitKrw: finiteNumber(evaluation?.realizedProfit),
    openPositionCount: count(evaluation?.activePositions)
  };
}

function projectCostAudit(audit, available) {
  const auditAvailable = available && audit?.available === true;
  return {
    available: auditAvailable,
    actualFillsObserved: false,
    evaluatedTradeCount: available ? count(audit?.evaluatedTradeCount) : null,
    unevaluableTradeCount: available ? count(audit?.unevaluableTradeCount) : null,
    modeledExecutionTradeCount: available ? count(audit?.modeledExecutionTradeCount) : null,
    unmodeledExecutionTradeCount: available ? count(audit?.unmodeledExecutionTradeCount) : null,
    configuredSlippagePercent: auditAvailable ? finiteNumber(audit.configuredSlippagePercent) : null,
    recordedNetPnlKrw: auditAvailable ? finiteNumber(audit.recordedNetPnlKrw) : null,
    modeledSlippageDragKrw: auditAvailable ? finiteNumber(audit.modeledSlippageDragKrw) : null,
    costStressedNetPnlKrw: auditAvailable ? finiteNumber(audit.costStressedNetPnlKrw) : null,
    slippageAppliedToStrictPaperLedger: auditAvailable
      ? nullableBoolean(audit.slippageAppliedToStrictPaperLedger)
      : null,
    note: typeof audit?.note === 'string'
      ? audit.note
      : available
        ? '현재 설정과 청산 표본으로 별도 비용 민감도를 계산할 수 없습니다.'
        : '모의투자 기록을 사용할 수 없습니다.'
  };
}

function projectPaperForwardCohort(snapshot = null) {
  const cohort = snapshot?.summary;
  const available = Boolean(cohort && typeof cohort === 'object' && !Array.isArray(cohort));
  const readErrorCount = available ? count(cohort.readErrors?.length) ?? 0 : null;
  const complete = available && readErrorCount === 0;
  const evidenceTradeCount = complete ? count(cohort.profitabilityEvidenceTradeCount) : null;

  return {
    available,
    complete,
    fresh: available ? snapshot.fresh === true : false,
    capturedAt: available && typeof snapshot.capturedAt === 'string' ? snapshot.capturedAt : null,
    readErrorCount,
    sessionCount: complete ? count(cohort.sessionCount) : null,
    activeSessionCount: complete ? count(cohort.activeSessionCount) : null,
    endedSessionCount: complete ? count(cohort.endedSessionCount) : null,
    strictTradeCount: complete ? count(cohort.strictTradeCount) : null,
    strictTradeSessionCount: complete ? count(cohort.strictTradeSessionCount) : null,
    eligibleStrictSessionCount: complete ? count(cohort.eligibleStrictSessionCount) : null,
    eligibleStrictTradeCount: complete ? count(cohort.eligibleStrictTradeCount) : null,
    profitabilityEvidenceSessionCount: complete ? count(cohort.profitabilityEvidenceSessionCount) : null,
    profitabilityEvidenceTradeCount: evidenceTradeCount,
    profitabilityEvidenceProfitKrw: complete && evidenceTradeCount > 0
      ? finiteNumber(cohort.profitabilityEvidenceProfit)
      : null,
    strictCostUnverifiedTradeCount: complete ? count(cohort.strictCostUnverifiedTradeCount) : null,
    sessionsBelowMinimumObservationDays: complete
      ? count(cohort.profitabilityEvidenceExclusionCounts?.observation_days_below_minimum)
      : null,
    sessionsBelowMinimumTradeCount: complete
      ? count(cohort.profitabilityEvidenceExclusionCounts?.trade_count_below_minimum)
      : null,
    totalStrictProfitComparable: complete ? nullableBoolean(cohort.totalStrictProfitComparable) : null,
    actualFillsObserved: false,
    promoted: false
  };
}

/**
 * Expose only the fields needed by a read-only native summary. Full ledgers,
 * strategy configuration, positions, and per-trade details remain server-side.
 */
export function projectPaperValidationMobileSummary(
  status,
  strictExecutionCostAudit = null,
  paperForwardCohort = null
) {
  const available = status?.available === true;
  const analysis = status?.analysisDataHealth;
  const risk = status?.riskMonitor;
  const audit = strictExecutionCostAudit || status?.strictExecutionCostAudit || null;

  return {
    schema: MOBILE_PAPER_SUMMARY_SCHEMA,
    researchOnly: true,
    promoted: false,
    actualFillsObserved: false,
    available,
    active: available ? nullableBoolean(status.active) : null,
    state: available && typeof status.state === 'string' ? status.state : null,
    heartbeatAt: available && typeof status.heartbeatAt === 'string' ? status.heartbeatAt : null,
    stopReason: available && typeof status.stopReason === 'string' ? status.stopReason : null,
    configSnapshotComplete: available ? status.configSnapshotComplete === true : null,
    configurationConsistent: available ? nullableBoolean(status.configConsistent) : null,
    continuityEligible: available ? nullableBoolean(status.continuityEligible) : null,
    heartbeatContinuityEligible: available ? nullableBoolean(status.heartbeatContinuityEligible) : null,
    analysisContinuityEligible: available ? nullableBoolean(analysis?.continuityEligible) : null,
    analysisMissingMarketCount: available ? count(analysis?.totalMissingMarkets) : null,
    riskContinuityEligible: available ? nullableBoolean(risk?.continuityEligible) : null,
    interruptionCount: available ? count(status.interruptionCount) : null,
    strict: projectBook(available ? status.strictEvaluation : null),
    diagnostic: {
      shadowClosedTradeCount: available ? count(status.shadowEvaluation?.closedTradeCount) : null,
      shadowRealizedProfitKrw: available ? finiteNumber(status.shadowEvaluation?.realizedProfit) : null,
      shadowOpenPositionCount: available ? count(status.shadowEvaluation?.activePositions) : null,
      looseClosedTradeCount: available ? count(status.looseShadowEvaluation?.closedTradeCount) : null,
      looseRealizedProfitKrw: available ? finiteNumber(status.looseShadowEvaluation?.realizedProfit) : null,
      looseOpenPositionCount: available ? count(status.looseShadowEvaluation?.activePositions) : null
    },
    costAudit: projectCostAudit(audit, available),
    cohort: projectPaperForwardCohort(paperForwardCohort)
  };
}
