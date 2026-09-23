import fs from 'node:fs';
import path from 'node:path';
import { assessScalpingValidationReportFreshness } from './scalpingValidationFreshness.js';

function resolveReportFile(tradingSystem, env = process.env) {
  const configured = tradingSystem?.config?.scalpingValidationOutputFile ||
    env.SCALP_VALIDATION_OUTPUT_FILE ||
    'scalping_validation.json';
  return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
}

function describeGateFailure(error) {
  const message = String(error?.message || '');
  if (/설정이 다릅니다/.test(message)) {
    return { code: 'runtime_config_mismatch', message: 'Validation report settings do not match current runtime settings.' };
  }
  if (/fixed_config/.test(message)) {
    return { code: 'fixed_config_required', message: 'A fixed_config validation report is required.' };
  }
  if (/신뢰도 게이트/.test(message)) {
    return { code: 'confidence_gate_failed', message: 'The required validation confidence gate is missing or failed.' };
  }
  if (/워크포워드 게이트/.test(message)) {
    return { code: 'promotion_gate_failed', message: 'The report did not pass the complete walk-forward promotion gate.' };
  }
  if (/market 목록/.test(message)) {
    return { code: 'markets_missing', message: 'The validation report has no market list.' };
  }
  if (/설정이 불완전/.test(message)) {
    return { code: 'report_config_incomplete', message: 'The fixed validation report settings are incomplete.' };
  }
  return { code: 'promotion_validation_failed', message: 'The runtime promotion validation did not pass.' };
}

/**
 * Read and evaluate the configured live-promotion report for dashboard display.
 * This calls the trader's pure validation gate, but never starts trading or
 * submits an order. Freshness is an API evidence rule: the live gate currently
 * does not enforce report age.
 */
export function getStrategyReadiness(tradingSystem, {
  env = process.env,
  now = Date.now(),
  maxAgeSeconds
} = {}) {
  const reportFile = resolveReportFile(tradingSystem, env);
  const runtime = {
    strategyMode: tradingSystem?.strategyMode || null,
    dryRun: tradingSystem?.dryRun ?? null,
    isScalpingMode: tradingSystem?.isScalpingMode ?? null,
    requireValidationPassForLive: tradingSystem?.config?.requireValidationPassForLive ?? null,
    readinessMeaning: tradingSystem?.dryRun === true
      ? 'virtual_validation_evidence'
      : tradingSystem?.dryRun === false
        ? 'live_validation_evidence'
        : 'runtime_mode_unknown',
    applies: tradingSystem?.dryRun === false &&
      tradingSystem?.isScalpingMode === true &&
      tradingSystem?.config?.requireValidationPassForLive !== false
  };
  const reportMeta = {
    available: false,
    filename: path.basename(reportFile),
    generatedAt: null,
    validationMode: null,
    promoted: null,
    freshness: assessScalpingValidationReportFreshness(null, {
      now,
      ...(maxAgeSeconds === undefined ? {} : { maxAgeSeconds })
    })
  };
  const blockers = [];
  const blockerDetails = [];
  const addBlocker = (code, message) => {
    blockers.push(message);
    blockerDetails.push({ code, message });
  };
  let report = null;
  let gate = { checked: false, passed: false, enforced: runtime.applies, enforcedFreshness: false, reason: null };

  if (!fs.existsSync(reportFile)) {
    addBlocker('report_missing', `${reportMeta.filename} validation report is missing.`);
  } else {
    try {
      report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
      if (!report || typeof report !== 'object' || Array.isArray(report)) {
        throw new Error('report root must be a JSON object');
      }
      reportMeta.available = true;
      reportMeta.generatedAt = report.generatedAt || null;
      reportMeta.validationMode = report.validationMode || null;
      reportMeta.promoted = report.promoted === true;
      reportMeta.freshness = assessScalpingValidationReportFreshness(report.generatedAt, {
        now,
        ...(maxAgeSeconds === undefined ? {} : { maxAgeSeconds })
      });
      if (!reportMeta.freshness.fresh) {
        addBlocker('report_not_current', `Validation report is not current (${reportMeta.freshness.reason}).`);
      }
      if (report.validationMode !== 'fixed_config') {
        addBlocker('fixed_config_required', 'A fixed_config validation report is required for live promotion.');
      }
      if (report.promoted !== true) {
        addBlocker('report_not_promoted', 'The validation report has not promoted the strategy.');
      }
    } catch {
      reportMeta.available = false;
      report = null;
      addBlocker('report_unreadable', 'Validation report is missing, malformed, or unreadable.');
    }
  }

  if (report) {
    if (typeof tradingSystem?.validatePromotionReport !== 'function') {
      gate = {
        checked: false,
        passed: false,
        enforced: runtime.applies,
        enforcedFreshness: false,
        reason: 'tradingSystem.validatePromotionReport is unavailable.'
      };
      gate.code = 'validator_unavailable';
      gate.reason = 'Runtime promotion validator is unavailable.';
      addBlocker(gate.code, gate.reason);
    } else {
      try {
        tradingSystem.validatePromotionReport(report);
        gate = { checked: true, passed: true, enforced: runtime.applies, enforcedFreshness: false, reason: null };
      } catch (error) {
        const safeFailure = describeGateFailure(error);
        gate = {
          checked: true,
          passed: false,
          enforced: runtime.applies,
          enforcedFreshness: false,
          code: safeFailure.code,
          reason: safeFailure.message
        };
        addBlocker(gate.code, gate.reason);
      }
    }
  } else if (typeof tradingSystem?.validatePromotionReport !== 'function') {
    gate.code = 'validator_unavailable';
    gate.reason = 'Runtime promotion validator is unavailable.';
  }

  const currentEvidence = reportMeta.available && reportMeta.freshness.fresh &&
    reportMeta.validationMode === 'fixed_config' && reportMeta.promoted === true && gate.passed;
  return {
    status: currentEvidence ? 'READY' : 'BLOCKED',
    decisionMeaning: 'current_validation_evidence_only',
    currentEvidence,
    source: 'configured_scalping_validation_report',
    report: reportMeta,
    runtime,
    liveGate: gate,
    blockers,
    blockerDetails
  };
}
