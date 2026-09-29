export const PAPER_EVIDENCE_MUTATION_BLOCKED_CODE = 'paper_evidence_mutation_blocked';
export const READ_ONLY_OBSERVER_MUTATION_BLOCKED_CODE = 'read_only_observer_mutation_blocked';
export const TRADING_RUNTIME_MUTATION_BLOCKED_CODE = 'trading_runtime_mutation_blocked';

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
      reason: '모의투자가 실행 중입니다. 기록을 보존하려면 먼저 중지한 뒤 설정을 변경해 주세요.',
      sessionId: session.sessionId || null,
      startedAt: session.startedAt || null
    };
  }

  const safety = tradingSystem?.getRuntimeSafetyStatus?.() || {};
  const livePositionsOpen = tradingSystem?.dryRun !== true &&
    Number(tradingSystem?.getCurrentPositionCount?.()) > 0;
  const unresolvedOrders = Number(tradingSystem?._livePendingOrderMarkets?.size) > 0;
  const runtimeTransitioning = tradingSystem?._startPromise || tradingSystem?._gracefulShutdownPromise ||
    tradingSystem?._orderInProgress === true || tradingSystem?._riskCheckInProgress === true;
  const runtimeBlocked = tradingSystem?.isRunning === true || runtimeTransitioning ||
    tradingSystem?._riskMonitorProtectiveOnly === true || safety.runtimeState === 'PROTECTIVE_ONLY' ||
    unresolvedOrders || livePositionsOpen;
  if (runtimeBlocked) {
    return {
      locked: true,
      code: TRADING_RUNTIME_MUTATION_BLOCKED_CODE,
      operation,
      reason: tradingSystem?._gracefulShutdownPromise || tradingSystem?._orderInProgress === true
        ? '진행 중인 거래나 중지 처리가 끝날 때까지 설정을 변경할 수 없습니다.'
        : unresolvedOrders
          ? '확인되지 않은 주문 결과를 거래소와 대조할 때까지 설정을 변경할 수 없습니다.'
          : safety.runtimeState === 'PROTECTIVE_ONLY' || tradingSystem?._riskMonitorProtectiveOnly === true
          ? '위험 감시 중에는 설정을 변경할 수 없습니다.'
            : livePositionsOpen
              ? '보유 포지션을 정리한 뒤 설정을 변경할 수 있습니다.'
              : '자동매매를 중지한 뒤 설정을 변경할 수 있습니다.',
      sessionId: session?.sessionId || null
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
