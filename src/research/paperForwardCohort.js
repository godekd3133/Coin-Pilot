import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { summarizePaperStrictTradeCostAudit } from './paperStrictTradeCostAudit.js';
import { summarizePaperForwardHealth } from './paperForwardHealth.js';
import { observeProcessExistence } from './paperForwardOwnerProbe.js';

function fingerprint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const stableValue = input => {
    if (Array.isArray(input)) return input.map(stableValue);
    if (!input || typeof input !== 'object') return input;
    return Object.fromEntries(
      Object.keys(input)
        .sort()
        .map(key => [key, stableValue(input[key])])
    );
  };
  return crypto.createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex')
    .slice(0, 16);
}

function observationDays(startedAt, endedAt) {
  const startMs = Date.parse(startedAt || '');
  const endMs = Date.parse(endedAt || '');
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return (endMs - startMs) / 86_400_000;
}

function minimumEvidenceThresholds(ledger) {
  const thresholds = ledger?.thresholds && typeof ledger.thresholds === 'object'
    ? ledger.thresholds
    : {};
  const minimumDays = Number(thresholds.minDays);
  const minimumTrades = Number(thresholds.minTrades);
  return {
    minimumDays: Number.isFinite(minimumDays) && minimumDays > 0 ? minimumDays : 7,
    minimumTrades: Number.isFinite(minimumTrades) && minimumTrades > 0 ? minimumTrades : 20
  };
}

function interruptionContinuityEligibility(ledger) {
  const thresholds = ledger?.thresholds && typeof ledger.thresholds === 'object'
    ? ledger.thresholds
    : {};
  const hasRecordedLimit = Object.prototype.hasOwnProperty.call(thresholds, 'maxHeartbeatGapMinutes');
  const recordedLimit = thresholds.maxHeartbeatGapMinutes;
  const maximumGapMinutes = hasRecordedLimit
    ? recordedLimit
    : 15;
  if (typeof maximumGapMinutes !== 'number' || !Number.isFinite(maximumGapMinutes) || maximumGapMinutes <= 0) {
    return null;
  }
  const maximumGapMs = maximumGapMinutes * 60 * 1000;
  if (!Number.isFinite(maximumGapMs)) return null;

  if (!Object.prototype.hasOwnProperty.call(ledger || {}, 'interruptions')) return true;
  if (!Array.isArray(ledger.interruptions)) return null;

  let hasUnknownGap = false;
  let hasOverLimitGap = false;
  for (const interruption of ledger.interruptions) {
    const gapMs = interruption && typeof interruption === 'object' && !Array.isArray(interruption)
      ? interruption.gapMs
      : null;
    if (typeof gapMs !== 'number' || !Number.isFinite(gapMs) || gapMs < 0) {
      hasUnknownGap = true;
      continue;
    }
    if (gapMs > maximumGapMs) hasOverLimitGap = true;
  }

  if (hasOverLimitGap) return false;
  if (hasUnknownGap) return null;
  return true;
}

function evaluateProfitabilityEvidence({
  strictCohortEligible,
  continuityEligible,
  strictTradeCount,
  observedDays,
  minimumDays,
  minimumTrades
} = {}) {
  const reasons = [];
  if (strictCohortEligible !== true) reasons.push('strict_cohort_ineligible');
  if (continuityEligible === false) reasons.push('continuity_ineligible');
  else if (continuityEligible !== true) reasons.push('continuity_unverified');
  if (observedDays === null) reasons.push('observation_window_unverifiable');
  else if (observedDays < minimumDays) reasons.push('observation_days_below_minimum');
  if (strictTradeCount < minimumTrades) reasons.push('trade_count_below_minimum');
  return { eligible: reasons.length === 0, reasons };
}

function groupRowsByConfig(rows = []) {
  return Object.values(rows.reduce((groups, row) => {
    const key = row.configFingerprint || 'missing_or_invalid';
    const group = groups[key] || {
      configFingerprint: key,
      sessionCount: 0,
      tradeCount: 0,
      winningTrades: 0,
      losingTrades: 0,
      profit: 0,
      recordedProfit: 0,
      directories: []
    };
    group.sessionCount += 1;
    group.tradeCount += row.strictTradeCount;
    group.winningTrades += row.strictCostAdjustedWinningTrades;
    group.losingTrades += row.strictTradeCount - row.strictCostAdjustedWinningTrades;
    group.profit += row.strictCostAdjustedProfit;
    group.recordedProfit += row.strictProfit;
    group.directories.push(row.directoryName);
    groups[key] = group;
    return groups;
  }, {})).sort((left, right) => left.configFingerprint.localeCompare(right.configFingerprint));
}

function summarizeConfigProfit(groups = []) {
  const configCount = groups.length;
  const aggregation = configCount === 0
    ? 'none'
    : configCount === 1
      ? 'single_config'
      : 'mixed_configs_not_aggregated';
  return {
    configCount,
    aggregation,
    profit: configCount === 1 ? groups[0].profit : null
  };
}

function readLedger(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { __readError: error.message };
  }
}

function tradeRows(ledger) {
  const strict = Array.isArray(ledger?.strictTrades) ? ledger.strictTrades : [];
  const closedTrades = book => Array.isArray(book?.closedTrades)
    ? book.closedTrades
    : Array.isArray(book?.trades) ? book.trades : [];
  const shadow = closedTrades(ledger?.shadow);
  const loose = closedTrades(ledger?.looseShadow);
  const winner = closedTrades(ledger?.winnerShadow);
  return { strict, diagnostic: [...shadow, ...loose, ...winner] };
}

function openPositionCount(book) {
  if (!book || typeof book !== 'object') return 0;
  const positions = book.positions && typeof book.positions === 'object'
    ? book.positions
    : book.openPositions && typeof book.openPositions === 'object'
      ? book.openPositions
      : {};
  return Object.keys(positions).length;
}

function strictCohortEligibility({
  ledger,
  trades,
  strictOpenPositionCount,
  diagnosticOpenPositionCount,
  interruptionContinuityEligible,
  configFingerprint,
  strictCostAuditEligible
} = {}) {
  if (ledger?.configSnapshotComplete !== true) return { eligible: false, reason: 'config_snapshot_incomplete' };
  if (!configFingerprint) return { eligible: false, reason: 'config_snapshot_invalid' };
  if (ledger.active === true) return { eligible: false, reason: 'session_still_active' };
  if (!ledger.endedAt) return { eligible: false, reason: 'session_not_ended' };
  if (trades.strict.length === 0) return { eligible: false, reason: 'no_strict_trades' };
  if (trades.diagnostic.length > 0) return { eligible: false, reason: 'diagnostic_trades_present' };
  if (strictOpenPositionCount > 0) return { eligible: false, reason: 'strict_positions_open' };
  if (diagnosticOpenPositionCount > 0) return { eligible: false, reason: 'diagnostic_positions_open' };
  if (ledger.analysisDataHealth?.continuityEligible === false ||
    ledger.riskMonitor?.continuityEligible === false ||
    interruptionContinuityEligible === false) {
    return { eligible: false, reason: 'continuity_ineligible' };
  }
  if (['risk_data_gap', 'owner_process_missing', 'stopped_with_unsettled_diagnostic_positions']
    .includes(ledger.stopReason)) {
    return { eligible: false, reason: `terminal_${ledger.stopReason}` };
  }
  if (strictCostAuditEligible !== true) return { eligible: false, reason: 'strict_execution_cost_unverified' };
  return { eligible: true, reason: null };
}

/**
 * Summarize existing forward paper ledgers without treating heterogeneous
 * sessions as one profitability sample. This is a read-only cohort report;
 * it never starts, stops, repairs, or promotes a paper session.
 */
export function summarizePaperForwardCohort({
  rootDir = '.',
  prefix = '.paper-forward-',
  now = Date.now(),
  processExistsProbe = observeProcessExistence
} = {}) {
  const root = path.resolve(rootDir);
  const rows = [];
  const readErrors = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    return {
      researchOnly: true,
      promoted: false,
      rootName: path.basename(root),
      sessionCount: 0,
      readErrors: [error.message],
      sessions: [],
      stopReasonCounts: {},
      configFingerprintCounts: {},
      strictTradeCount: 0,
      diagnosticTradeCount: 0,
      totalStrictProfit: 0,
      totalStrictProfitComparable: false,
      totalStrictProfitNote: '서로 다른 config·market universe·기간의 mixed aggregate이며 수익성 evidence가 아닙니다.',
      activeSessionCount: 0,
      endedSessionCount: 0,
      eligibleStrictSessionCount: 0,
      eligibleStrictTradeCount: 0,
      eligibleStrictConfigCount: 0,
      eligibleStrictProfitAggregation: 'none',
      eligibleStrictProfit: null,
      eligibleStrictConfigGroups: [],
      profitabilityEvidenceSessionCount: 0,
      profitabilityEvidenceTradeCount: 0,
      profitabilityEvidenceConfigCount: 0,
      profitabilityEvidenceProfitAggregation: 'none',
      profitabilityEvidenceProfit: null,
      profitabilityEvidenceProfitBasis: 'per_trade_cost_audit_adjusted_net_pnl',
      actualFillsObserved: false,
      profitabilityEvidenceConfigGroups: [],
      profitabilityEvidenceExclusionCounts: {},
      observedActiveOwnerMissingSessionCount: 0,
      observedActiveHeartbeatStaleSessionCount: 0,
      observedStrictHardDeadlineReachedPositionCount: 0,
      note: '서로 다른 forward session을 자동 승격하거나 하나의 수익성 표본으로 합산하지 않습니다.'
    };
  }

  for (const entry of entries.filter(item => item.isDirectory() && item.name.startsWith(prefix)).sort((a, b) => a.name.localeCompare(b.name))) {
    const ledgerFile = path.join(root, entry.name, 'paper_validation.json');
    if (!fs.existsSync(ledgerFile)) continue;
    const ledger = readLedger(ledgerFile);
    if (ledger?.__readError) {
      readErrors.push(`${entry.name}:${ledger.__readError}`);
      continue;
    }
    const trades = tradeRows(ledger);
    const strictProfit = trades.strict.reduce((sum, trade) => sum + (Number(trade?.profit) || 0), 0);
    const strictCostAudit = summarizePaperStrictTradeCostAudit(ledger);
    const strictCostAuditEligible = strictCostAudit.available === true &&
      strictCostAudit.evaluatedTradeCount === trades.strict.length;
    const costAdjustedTrades = strictCostAuditEligible ? strictCostAudit.trades : [];
    const strictCostAdjustedProfit = strictCostAuditEligible && costAdjustedTrades.length > 0
      ? strictCostAudit.costStressedNetPnlKrw
      : null;
    const strictCostAdjustedWinningTrades = strictCostAuditEligible
      ? costAdjustedTrades.filter(trade => trade.costStressedNetPnlKrw > 0).length
      : null;
    const strictOpenPositionCount = Object.keys(ledger.strictOpenPositions || {}).length;
    const diagnosticOpenPositionCount = openPositionCount(ledger.shadow) +
      openPositionCount(ledger.looseShadow) +
      openPositionCount(ledger.winnerShadow);
    const configFingerprint = fingerprint(ledger.configSnapshot);
    const observedDays = observationDays(ledger.startedAt, ledger.endedAt);
    const evidenceThresholds = minimumEvidenceThresholds(ledger);
    const analysisContinuityEligible = ledger.analysisDataHealth?.continuityEligible ?? null;
    const riskContinuityEligible = ledger.riskMonitor?.continuityEligible ?? null;
    const interruptionContinuity = interruptionContinuityEligibility(ledger);
    const continuityEligible = analysisContinuityEligible === false ||
      riskContinuityEligible === false ||
      interruptionContinuity === false
      ? false
      : analysisContinuityEligible === true && riskContinuityEligible === true && interruptionContinuity === true
        ? true
        : null;
    const strictCohort = strictCohortEligibility({
      ledger,
      trades,
      strictOpenPositionCount,
      diagnosticOpenPositionCount,
      interruptionContinuityEligible: interruptionContinuity,
      configFingerprint,
      strictCostAuditEligible
    });
    let observationHealth = null;
    if (ledger.active === true) {
      let processExistsObservation;
      try {
        processExistsObservation = processExistsProbe(ledger.processId);
      } catch {
        processExistsObservation = { pid: null, exists: null };
      }
      const health = summarizePaperForwardHealth({ ledger, now, processExistsObservation });
      observationHealth = {
        observedAt: health.observedAt,
        ownerProcessStatus: health.ownerProcess.status,
        heartbeatStatus: health.heartbeat.status,
        heartbeatReason: health.heartbeat.reason,
        attentionRequired: health.attentionRequired,
        findings: health.findings,
        strictPositions: health.positions.map(position => ({
          market: position.market,
          baseDeadlineAt: position.baseDeadlineAt,
          hardDeadlineAt: position.hardDeadlineAt,
          deadlineStatus: position.deadlineStatus,
          hardDeadlineReached: position.hardDeadlineReached
        })),
        scope: 'active persisted ledger: PID existence, heartbeat timestamps, and strict-position configured hold deadlines only; no owner identity verification.'
      };
    }
    const profitabilityEvidence = evaluateProfitabilityEvidence({
      strictCohortEligible: strictCohort.eligible,
      continuityEligible,
      strictTradeCount: trades.strict.length,
      observedDays,
      minimumDays: evidenceThresholds.minimumDays,
      minimumTrades: evidenceThresholds.minimumTrades
    });
    rows.push({
      directoryName: entry.name,
      startedAt: ledger.startedAt || null,
      endedAt: ledger.endedAt || null,
      active: ledger.active === true,
      state: ledger.state || null,
      stopReason: ledger.stopReason || null,
      configSnapshotComplete: ledger.configSnapshotComplete === true,
      configFingerprint,
      strictTradeCount: trades.strict.length,
      diagnosticTradeCount: trades.diagnostic.length,
      strictProfit,
      strictWinningTrades: trades.strict.filter(trade => Number(trade?.profit) > 0).length,
      strictCostAuditAvailable: strictCostAuditEligible,
      strictCostAuditReason: strictCostAudit.reason,
      strictCostAdjustedProfit,
      strictCostAdjustedWinningTrades,
      strictCostAdjustedProfitEligible: strictCostAuditEligible && strictCostAdjustedProfit !== null,
      strictCostUnverifiedTradeCount: trades.strict.length - strictCostAudit.evaluatedTradeCount,
      strictOpenPositionCount,
      diagnosticOpenPositionCount,
      shadowOpenPositionCount: openPositionCount(ledger.shadow),
      looseShadowOpenPositionCount: openPositionCount(ledger.looseShadow),
      winnerShadowOpenPositionCount: openPositionCount(ledger.winnerShadow),
      strictCohortEligible: strictCohort.eligible,
      strictCohortExclusionReason: strictCohort.reason,
      observationDays: observedDays,
      minimumEvidenceDays: evidenceThresholds.minimumDays,
      minimumEvidenceTrades: evidenceThresholds.minimumTrades,
      profitabilityEvidenceEligible: profitabilityEvidence.eligible,
      profitabilityEvidenceExclusionReasons: profitabilityEvidence.reasons,
      analysisContinuityEligible,
      riskContinuityEligible,
      interruptionContinuityEligible: interruptionContinuity,
      continuityEligible,
      observationHealth
    });
  }

  const stopReasonCounts = {};
  const configFingerprintCounts = {};
  for (const row of rows) {
    const stopReason = row.stopReason || 'none';
    stopReasonCounts[stopReason] = (stopReasonCounts[stopReason] || 0) + 1;
    const configKey = row.configFingerprint || 'missing_or_incomplete';
    configFingerprintCounts[configKey] = (configFingerprintCounts[configKey] || 0) + 1;
  }

  const strictTradeCount = rows.reduce((sum, row) => sum + row.strictTradeCount, 0);
  const diagnosticTradeCount = rows.reduce((sum, row) => sum + row.diagnosticTradeCount, 0);
  const totalStrictProfit = rows.reduce((sum, row) => sum + row.strictProfit, 0);
  const strictCostUnverifiedTradeCount = rows.reduce((sum, row) => sum + row.strictCostUnverifiedTradeCount, 0);
  const strictWinningTrades = rows.reduce((sum, row) => sum + row.strictWinningTrades, 0);
  const eligibleStrictRows = rows.filter(row => row.strictCohortEligible === true);
  const observedActiveRows = rows.filter(row => row.active === true && row.observationHealth);
  const observedStrictPositions = observedActiveRows.flatMap(row => row.observationHealth.strictPositions);
  const strictCohortExclusionCounts = {};
  for (const row of rows.filter(item => item.strictCohortEligible !== true)) {
    const reason = row.strictCohortExclusionReason || 'unknown';
    strictCohortExclusionCounts[reason] = (strictCohortExclusionCounts[reason] || 0) + 1;
  }
  const profitabilityEvidenceExclusionCounts = {};
  for (const row of rows.filter(item => item.profitabilityEvidenceEligible !== true)) {
    for (const reason of row.profitabilityEvidenceExclusionReasons || ['unknown']) {
      profitabilityEvidenceExclusionCounts[reason] = (profitabilityEvidenceExclusionCounts[reason] || 0) + 1;
    }
  }
  const eligibleStrictConfigGroups = groupRowsByConfig(eligibleStrictRows);
  const eligibleStrictSummary = summarizeConfigProfit(eligibleStrictConfigGroups);
  const profitabilityEvidenceRows = rows.filter(row => row.profitabilityEvidenceEligible === true);
  const profitabilityEvidenceConfigGroups = groupRowsByConfig(profitabilityEvidenceRows);
  const profitabilityEvidenceSummary = summarizeConfigProfit(profitabilityEvidenceConfigGroups);

  return {
    researchOnly: true,
    promoted: false,
    promotionReason: 'heterogeneous_forward_cohort_never_authorizes_live_orders',
    rootName: path.basename(root),
    sessionCount: rows.length,
    strictTradeSessionCount: rows.filter(row => row.strictTradeCount > 0).length,
    diagnosticTradeSessionCount: rows.filter(row => row.diagnosticTradeCount > 0).length,
    configSnapshotCompleteSessionCount: rows.filter(row => row.configSnapshotComplete).length,
    strictTradeCount,
    diagnosticTradeCount,
    strictWinningTrades,
    strictLosingTrades: strictTradeCount - strictWinningTrades,
    strictCostUnverifiedTradeCount,
    strictWinRate: strictTradeCount > 0 ? strictWinningTrades / strictTradeCount : null,
    totalStrictProfit,
    totalStrictProfitComparable: false,
    totalStrictProfitNote: '서로 다른 config·market universe·기간의 mixed aggregate이며 수익성 evidence가 아닙니다.',
    activeSessionCount: rows.filter(row => row.active === true).length,
    observedActiveOwnerMissingSessionCount: observedActiveRows.filter(row =>
      row.observationHealth.ownerProcessStatus === 'missing').length,
    observedActiveHeartbeatStaleSessionCount: observedActiveRows.filter(row =>
      row.observationHealth.heartbeatStatus === 'stale').length,
    observedStrictHardDeadlineReachedPositionCount: observedStrictPositions.filter(position =>
      position.hardDeadlineReached === true).length,
    endedSessionCount: rows.filter(row => Boolean(row.endedAt)).length,
    averageStrictProfit: strictTradeCount > 0 ? totalStrictProfit / strictTradeCount : null,
    eligibleStrictSessionCount: eligibleStrictRows.length,
    eligibleStrictTradeCount: eligibleStrictRows.reduce((sum, row) => sum + row.strictTradeCount, 0),
    eligibleStrictWinningTrades: eligibleStrictRows.reduce((sum, row) => sum + row.strictWinningTrades, 0),
    eligibleStrictLosingTrades: eligibleStrictRows.reduce((sum, row) => sum + row.strictTradeCount - row.strictWinningTrades, 0),
    eligibleStrictConfigCount: eligibleStrictSummary.configCount,
    eligibleStrictProfitAggregation: profitabilityEvidenceSummary.aggregation,
    eligibleStrictProfit: profitabilityEvidenceSummary.profit,
    eligibleStrictConfigGroups,
    profitabilityEvidenceSessionCount: profitabilityEvidenceRows.length,
    profitabilityEvidenceTradeCount: profitabilityEvidenceRows.reduce((sum, row) => sum + row.strictTradeCount, 0),
    profitabilityEvidenceConfigCount: profitabilityEvidenceSummary.configCount,
    profitabilityEvidenceProfitAggregation: profitabilityEvidenceSummary.aggregation,
    profitabilityEvidenceProfit: profitabilityEvidenceSummary.profit,
    profitabilityEvidenceProfitBasis: 'per_trade_cost_audit_adjusted_net_pnl',
    actualFillsObserved: false,
    profitabilityEvidenceConfigGroups,
    profitabilityEvidenceExclusionCounts,
    strictCohortExclusionCounts,
    stopReasonCounts,
    configFingerprintCounts,
    readErrors,
    sessions: rows,
    note: '서로 다른 config·market universe·window·종료 상태의 forward session을 하나의 promotion 또는 실전 수익성 증거로 합산하지 않습니다. eligible session도 config가 둘 이상이면 손익 합계를 계산하지 않고 구성별로 분리합니다.'
  };
}
