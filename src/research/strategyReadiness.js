import fs from 'node:fs';
import path from 'node:path';
import { assessScalpingValidationReportFreshness } from './scalpingValidationFreshness.js';

function resolveReportFile(tradingSystem, env = process.env) {
  const configured = tradingSystem?.config?.scalpingValidationOutputFile ||
    env.SCALP_VALIDATION_OUTPUT_FILE ||
    'scalping_validation.json';
  return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
}

const LIVE_GATE_FAILURE_MESSAGES = {
  live_validation_bypass_not_supported: '실거래 자동매매의 검증을 끌 수 없습니다. 서버에서 검증을 켜고 현재 투자 설정의 점검을 완료해 주세요.',
  report_missing: '실거래 자동매매를 시작하려면 현재 투자 설정의 점검 결과가 필요합니다. 서버에서 점검을 완료한 뒤 다시 시도해 주세요.',
  report_unreadable: '실거래 자동매매 점검 결과를 불러오지 못했습니다. 서버에서 다시 점검한 뒤 시도해 주세요.',
  report_not_current: '실거래 자동매매 점검 결과가 오래되었거나 작성 시각을 확인할 수 없습니다. 서버에서 다시 점검한 뒤 시도해 주세요.',
  runtime_config_mismatch: '현재 투자 설정과 점검 당시 설정이 다릅니다. 현재 설정으로 다시 점검한 뒤 시도해 주세요.',
  fixed_config_required: '현재 투자 설정으로 점검한 결과가 필요합니다. 서버에서 다시 점검한 뒤 시도해 주세요.',
  confidence_gate_failed: '거래 수익에 대한 검증이 충분하지 않아 실거래 자동매매를 시작할 수 없습니다. 모의투자로 검증을 계속해 주세요.',
  promotion_gate_failed: '투자 전략이 실거래 자동매매 검증을 통과하지 못했습니다. 모의투자로 검증을 계속해 주세요.',
  markets_missing: '점검 결과에 투자 대상 코인이 없습니다. 현재 투자 설정으로 다시 점검해 주세요.',
  validation_markets_invalid: '점검 결과의 투자 대상 코인 목록이 잘못되었거나 중복되어 있습니다. 현재 투자 설정으로 다시 점검해 주세요.',
  runtime_markets_invalid: '현재 투자 대상 코인 목록을 확인할 수 없습니다. 투자 대상을 설정한 뒤 다시 점검해 주세요.',
  validation_market_mismatch: '현재 투자 대상 코인과 점검 당시 대상이 다릅니다. 현재 투자 대상으로 다시 점검한 뒤 시도해 주세요.',
  validation_results_invalid: '점검 결과에 투자 대상별 검증 자료가 빠져 있거나 중복되어 있습니다. 현재 투자 설정으로 다시 점검해 주세요.',
  live_universe_update_requires_stop: '실거래 자동매매가 실행 중이거나 시작을 준비 중입니다. 자동매매를 중지한 뒤 투자 대상과 포지션 설정을 변경해 주세요.',
  report_config_incomplete: '점검 결과에 필요한 투자 설정이 빠져 있습니다. 현재 투자 설정으로 다시 점검해 주세요.',
  strategy_mode_mismatch: '현재 투자 전략과 점검 당시 전략이 다릅니다. 현재 전략으로 다시 점검해 주세요.',
  risk_monitor_disabled: '포지션 위험 감시가 꺼져 있어 실거래 자동매매를 시작할 수 없습니다. 서버에서 위험 감시를 켠 뒤 다시 시도해 주세요.',
  risk_data_gap_protection_disabled: '거래소 데이터가 끊겼을 때의 보호 설정이 꺼져 있습니다. 서버에서 보호 설정을 켠 뒤 다시 시도해 주세요.',
  promotion_validation_failed: '실거래 자동매매 점검을 통과하지 못했습니다. 서버의 점검 결과를 확인해 주세요.',
  trading_start_failed: '자동매매를 시작하지 못했습니다. 설정과 서버 상태를 확인해 주세요.'
};

/** Classify known failures without returning raw errors, paths, or report data. */
export function describeLiveTradingFailure(error, { fallbackCode = 'promotion_validation_failed' } = {}) {
  const message = typeof error?.message === 'string' ? error.message : '';
  let code = Object.hasOwn(LIVE_GATE_FAILURE_MESSAGES, error?.code) ? error.code : null;
  if (!code && /^실전 (?:매매|스캘핑) 차단:/.test(message)) {
    if (/포지션 위험 감시/.test(message)) code = 'risk_monitor_disabled';
    else if (/리스크 데이터 공백/.test(message)) code = 'risk_data_gap_protection_disabled';
    else if (/검증 게이트를 비활성화/.test(message)) code = 'live_validation_bypass_not_supported';
    else if (/검증 리포트가 없습니다/.test(message)) code = 'report_missing';
    else if (/검증 리포트를 읽을 수 없습니다/.test(message)) code = 'report_unreadable';
    else if (/오래되었거나 작성 시각/.test(message)) code = 'report_not_current';
    else if (/설정이 다릅니다/.test(message)) code = 'runtime_config_mismatch';
    else if (/설정이 불완전/.test(message)) code = 'report_config_incomplete';
    else if (/전략 모드가 다릅니다/.test(message)) code = 'strategy_mode_mismatch';
    else if (/fixed_config/.test(message)) code = 'fixed_config_required';
    else if (/신뢰도 게이트/.test(message)) code = 'confidence_gate_failed';
    else if (/워크포워드 게이트/.test(message)) code = 'promotion_gate_failed';
    else if (/market 목록/.test(message)) code = 'markets_missing';
  }
  code ||= fallbackCode === 'trading_start_failed' ? fallbackCode : 'promotion_validation_failed';
  return { code, message: LIVE_GATE_FAILURE_MESSAGES[code] };
}

/**
 * Read and evaluate the configured live-promotion report for dashboard display.
 * This calls the trader's pure validation gate, but never starts trading or
 * submits an order. Report freshness is checked by both readiness and the
 * runtime validator so stale evidence cannot authorize LIVE startup.
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
      tradingSystem?.isScalpingMode === true
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
    if (blockerDetails.some(blocker => blocker.code === code)) return;
    blockers.push(message);
    blockerDetails.push({ code, message });
  };
  const validationBypassRequested = runtime.applies && runtime.requireValidationPassForLive === false;
  if (validationBypassRequested) {
    return {
      status: 'NOT_REQUIRED',
      decisionMeaning: 'performance_validation_optional',
      currentEvidence: false,
      source: 'configured_scalping_validation_report',
      report: reportMeta,
      runtime,
      liveGate: { checked: false, passed: null, enforced: false, enforcedFreshness: false, reason: null },
      blockers: [],
      blockerDetails: []
    };
  }
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
        tradingSystem.validatePromotionReport(report, {
          now,
          ...(maxAgeSeconds === undefined ? {} : { maxAgeSeconds })
        });
        gate = { checked: true, passed: true, enforced: runtime.applies, enforcedFreshness: true, reason: null };
      } catch (error) {
        const safeFailure = describeLiveTradingFailure(error);
        gate = {
          checked: true,
          passed: false,
          enforced: runtime.applies,
          enforcedFreshness: true,
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
