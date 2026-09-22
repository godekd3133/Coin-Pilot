export const PAPER_EVIDENCE_MUTATION_BLOCKED_CODE = 'paper_evidence_mutation_blocked';
export const READ_ONLY_OBSERVER_MUTATION_BLOCKED_CODE = 'read_only_observer_mutation_blocked';

/**
 * Return the mutation boundary that protects an evidence-bearing paper
 * session. The boundary is intentionally derived from runtime state rather
 * than UI state so direct API calls and background schedulers cannot bypass
 * it.
 */
export function getPaperEvidenceMutationLock(tradingSystem, operation = 'configuration') {
  if (tradingSystem?.readOnlyObserver === true) {
    return {
      locked: true,
      code: READ_ONLY_OBSERVER_MUTATION_BLOCKED_CODE,
      operation,
      reason: '읽기 전용 관찰 서버에서는 설정·최적화 변경을 실행할 수 없습니다.',
      sessionId: tradingSystem.paperValidation?.sessionId || null
    };
  }

  const session = tradingSystem?.paperValidation;
  if (session?.active === true) {
    return {
      locked: true,
      code: PAPER_EVIDENCE_MUTATION_BLOCKED_CODE,
      operation,
      reason: '활성 모의투자 검증 세션의 설정 기록을 보호하기 위해 세션을 중지한 뒤 변경하세요.',
      sessionId: session.sessionId || null,
      startedAt: session.startedAt || null
    };
  }

  return {
    locked: false,
    code: null,
    operation,
    reason: null,
    sessionId: session?.sessionId || null,
    startedAt: session?.startedAt || null
  };
}

/**
 * Send a stable 409 response for a blocked mutation. Return true when the
 * caller must stop handling the request, false when mutation is allowed.
 */
export function respondIfPaperEvidenceMutationBlocked(tradingSystem, response, operation) {
  const lock = getPaperEvidenceMutationLock(tradingSystem, operation);
  if (!lock.locked) return false;

  response.status(409).json({
    success: false,
    code: lock.code,
    error: lock.reason,
    evidenceMutationLock: lock
  });
  return true;
}
