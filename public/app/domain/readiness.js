// Live-order readiness classification for /api/strategy-readiness. Never shows
// green unless the server confirmed a current, fresh, passing gate.

import { durationSeconds } from '../core/format.js';

export function validationReportFreshness(value, apiFreshness = null, now = Date.now()) {
  if (apiFreshness && typeof apiFreshness.fresh === 'boolean') {
    if (apiFreshness.fresh) return '최근 생성';
    if (apiFreshness.reason === 'future_timestamp' || apiFreshness.reason === 'timestamp_missing_or_invalid') return '작성 시각을 확인할 수 없습니다.';
    const ageSeconds = Number(apiFreshness.ageSeconds);
    const ageDays = Number.isFinite(ageSeconds) && ageSeconds >= 0 ? Math.max(1, Math.floor(ageSeconds / 86400)) : null;
    return ageDays === null ? '최신 데이터로 다시 점검하세요.' : `${ageDays}일 전에 만든 결과입니다. 최신 데이터로 다시 점검하세요.`;
  }
  const generatedMs = Date.parse(value || '');
  if (!Number.isFinite(generatedMs) || generatedMs > now) return '작성 시각을 확인할 수 없습니다.';
  const ageMs = now - generatedMs;
  if (ageMs >= 86_400_000) return `${Math.max(1, Math.floor(ageMs / 86_400_000))}일 전에 만든 결과입니다. 최신 데이터로 다시 점검하세요.`;
  return '최근 생성';
}

export const formatReadinessAge = durationSeconds;

const REASON_LABELS = {
  report_missing: '전략 점검 결과가 없습니다.',
  report_not_current: '점검 결과가 오래됐습니다.',
  live_validation_bypass_not_supported: '실전 스캘핑은 점검을 건너뛸 수 없습니다. 설정을 확인하세요.',
  runtime_config_mismatch: '현재 설정과 점검 당시 설정이 다릅니다. 현재 설정으로 다시 점검하세요.',
  fixed_config_required: '현재 설정으로 점검을 다시 실행해야 합니다.',
  report_config_incomplete: '점검에 필요한 설정 정보가 빠져 있습니다.',
  confidence_gate_failed: '전략 점검 기준을 충족하지 못했습니다.',
  promotion_gate_failed: '전략 점검 기준을 충족하지 못했습니다.',
  report_not_promoted: '전략을 실제 거래에 적용할 수 있는 상태가 아닙니다.',
  markets_missing: '점검 결과에 확인한 시장이 없습니다.',
  promotion_validation_failed: '전략 점검 기준을 충족하지 못했습니다.'
};

export function classifyReadiness(readiness) {
  const report = readiness?.report;
  const gate = readiness?.liveGate || {};
  const freshness = report?.freshness;
  if (readiness?.status === 'NOT_REQUIRED' && readiness?.decisionMeaning === 'performance_validation_optional' && gate.enforced === false) {
    return {
      report, gate, ready: false, blocked: false, stale: false, missing: false, unknown: false, optional: true,
      currentEvidence: false, stateLabel: '선택 사항', tone: 'info',
      headline: '성과 검증 없이 자동매매를 시작할 수 있습니다.',
      description: '시작할 때 계좌와 미체결 주문을 확인하고, 거래 중 위험 감시를 유지합니다.',
      reasons: []
    };
  }
  const blockerCodes = [
    ...(Array.isArray(readiness?.blockerDetails)
      ? readiness.blockerDetails.map(detail => (typeof detail === 'string' ? detail : detail?.code)).filter(Boolean)
      : []),
    gate.code
  ].filter(Boolean);
  const ready = readiness?.source === 'configured_scalping_validation_report' && readiness?.currentEvidence === true &&
    readiness?.status === 'READY' && gate.checked === true && gate.passed === true && freshness?.fresh === true;
  const blocked = gate.checked === true && gate.passed === false;
  const stale = freshness?.fresh === false && freshness?.reason === 'stale';
  const responseKnown = readiness?.source === 'configured_scalping_validation_report' &&
    ['READY', 'BLOCKED'].includes(readiness?.status) && typeof readiness?.currentEvidence === 'boolean';
  const unreadable = blockerCodes.includes('report_unreadable');
  const missing = blockerCodes.includes('report_missing') || (report?.available === false && !unreadable);
  const validatorUnavailable = blockerCodes.includes('validator_unavailable') || gate.code === 'validator_unavailable';
  const freshnessUnknown = report?.available === true && (
    typeof freshness?.fresh !== 'boolean' || ['future_timestamp', 'timestamp_missing_or_invalid'].includes(freshness?.reason)
  );
  const knownBlocker = missing || stale || blocked || blockerCodes.some(code => [
    'runtime_config_mismatch', 'fixed_config_required', 'confidence_gate_failed', 'promotion_gate_failed',
    'report_not_promoted', 'markets_missing', 'report_config_incomplete', 'promotion_validation_failed',
    'live_validation_bypass_not_supported'
  ].includes(code)) || (blockerCodes.includes('report_not_current') && !freshnessUnknown);
  const unknown = !responseKnown || (!knownBlocker && (unreadable || validatorUnavailable || freshnessUnknown || gate.checked !== true));
  const stateLabel = ready ? '통과' : unknown ? '확인 필요' : '보류';
  const reasons = [];
  if (stale || (blockerCodes.includes('report_not_current') && !freshnessUnknown)) reasons.push(REASON_LABELS.report_not_current);
  if (blockerCodes.includes('runtime_config_mismatch')) reasons.push(REASON_LABELS.runtime_config_mismatch);
  if (blockerCodes.includes('report_config_incomplete')) reasons.push(REASON_LABELS.report_config_incomplete);
  if (missing) reasons.push(REASON_LABELS.report_missing);
  ['fixed_config_required', 'confidence_gate_failed', 'promotion_gate_failed', 'markets_missing',
    'promotion_validation_failed', 'report_not_promoted', 'live_validation_bypass_not_supported'].forEach(code => {
    if (blockerCodes.includes(code) && REASON_LABELS[code]) reasons.push(REASON_LABELS[code]);
  });
  if (blocked && reasons.length === 0) reasons.push('전략 점검 기준을 충족하지 못했습니다.');
  if (unknown && reasons.length === 0) {
    reasons.push(unreadable ? '점검 결과를 읽을 수 없습니다.'
      : freshnessUnknown ? '작성 시각을 확인할 수 없습니다.'
        : validatorUnavailable ? '점검을 완료하지 못했습니다.' : '점검 결과를 불러오지 못했습니다.');
  }
  return {
    report, gate, ready, blocked: stateLabel === '보류', stale, missing, unknown, optional: false,
    currentEvidence: readiness?.currentEvidence === true,
    stateLabel,
    tone: ready ? 'ok' : stateLabel === '보류' ? 'danger' : 'warning',
    headline: ready ? '실제 주문 전 점검을 통과했습니다.' : unknown ? '실제 주문 가능 여부를 확인할 수 없습니다.' : '실제 주문 조건을 충족하지 못했습니다.',
    description: ready ? '실제 주문 가능 여부는 서버 모드와 모의투자 상태에 따라 달라집니다.' : '',
    reasons: [...new Set(reasons)].slice(0, 2)
  };
}

/** Audit rows for the readiness disclosure. */
export function readinessAuditRows(readiness) {
  const report = readiness?.report || {};
  const freshness = report.freshness || {};
  const gate = readiness?.liveGate || {};
  const runtime = readiness?.runtime || {};
  const freshnessReason = { fresh: '최근 생성 기준 충족', stale: '다시 점검해야 함', future_timestamp: '작성 시각을 확인할 수 없음', timestamp_missing_or_invalid: '작성 시각을 확인할 수 없음' }[freshness.reason] || '추가 정보 없음';
  return [
    ['점검 시각', report.generatedAt || null],
    ['작성 시점', `${freshness.fresh === true ? '최근 생성' : freshness.fresh === false ? '오래됨' : '확인 불가'} · ${formatReadinessAge(freshness.ageSeconds)} / ${formatReadinessAge(freshness.maxAgeSeconds)} 기준 · ${freshnessReason}`],
    ['점검 설정', `${report.validationMode === 'fixed_config' ? '고정 설정' : report.validationMode ? '확인 필요' : '확인 불가'} · ${report.promoted === true ? '적용 후보 표시 있음' : report.promoted === false ? '적용 후보 표시 없음' : '확인 불가'}`],
    ['실제 주문 조건 확인', `${readiness?.status === 'NOT_REQUIRED' ? '선택 사항' : gate.checked === true ? (gate.passed === true ? '통과' : '미통과') : '점검할 수 없음'} · ${gate.enforced === true ? '실제 주문에서 이 점검을 사용함' : gate.enforced === false ? '실제 주문에서는 이 점검을 사용하지 않음' : '적용 여부 확인 불가'}`],
    ['작성 시점 반영', gate.enforcedFreshness === true ? '점검 자료의 작성 시점을 주문 조건에 반영함' : gate.enforcedFreshness === false ? '반영하지 않음' : '확인 불가'],
    ['현재 거래 모드', runtime.dryRun === true ? '모의투자' : runtime.dryRun === false ? '실거래' : '확인 불가'],
    ['점검 종합 결과', readiness?.currentEvidence === true ? '주문 전 점검 통과' : readiness?.currentEvidence === false ? '주문 전 점검 미통과' : '확인 불가']
  ];
}
