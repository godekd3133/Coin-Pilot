import { randomUUID } from 'node:crypto';
import {
  projectLiveAccountReadback,
  readLiveOrderIntentEvidence,
  resolveTerminalLiveOrderReadback
} from '../research/liveExecutionEvidence.js';

function projectLiveFillResult(fillResult, orderId = null) {
  const order = fillResult?.order;
  const executedVolume = Number(order?.executed_volume);
  const remainingVolume = Number(order?.remaining_volume);
  return {
    status: fillResult?.filled === true
      ? fillResult.partial === true ? 'partial' : 'filled'
      : 'not_observed',
    orderId: orderId || order?.uuid || null,
    exchangeState: order?.state || null,
    executedVolume: Number.isFinite(executedVolume) ? executedVolume : null,
    remainingVolume: Number.isFinite(remainingVolume) ? remainingVolume : null,
    averagePrice: Number.isFinite(Number(order?.avg_price)) ? Number(order.avg_price) : null,
    paidFee: Number.isFinite(Number(order?.paid_fee)) ? Number(order.paid_fee) : null,
    error: fillResult?.error || null
  };
}

export function hasCompleteObservedLiveFill(liveExecution) {
  const fill = liveExecution?.fill;
  const hasObservedNumber = value => value !== null && value !== undefined && Number.isFinite(Number(value));
  return liveExecution?.evidenceRecorded === true &&
    liveExecution?.fillResult?.filled === true &&
    hasObservedNumber(fill?.executedVolume) && Number(fill.executedVolume) > 0 &&
    hasObservedNumber(fill?.averagePrice) && Number(fill.averagePrice) > 0 &&
    hasObservedNumber(fill?.paidFee) && Number(fill.paidFee) >= 0 &&
    hasObservedNumber(fill?.remainingVolume) && Number(fill.remainingVolume) >= 0;
}

function markLiveMarketOrderUnresolved(tradingSystem, market) {
  if (typeof tradingSystem?.markLiveMarketOrderUnresolved === 'function') {
    tradingSystem.markLiveMarketOrderUnresolved(market);
    return;
  }
  tradingSystem._liveRecoveredManagedMarkets?.add?.(market);
  tradingSystem._liveOrderStateUnknownMarkets?.add?.(market);
  tradingSystem._livePendingOrderMarkets?.add?.(market);
  tradingSystem._liveExchangeStateKnown = false;
}

function liveOrderBlockedResult(reason) {
  const messages = {
    live_order_in_progress: '진행 중인 주문이 끝날 때까지 LIVE 주문을 잠갔습니다.',
    protective_only: '보유 포지션 보호 감시 중에는 화면에서 새 LIVE 주문을 보낼 수 없습니다.',
    trading_paused: '자동매매가 중지 또는 보호 상태라 LIVE 주문을 잠갔습니다.',
    exchange_state_unverified: '거래소 계좌와 미체결 주문 상태를 확인할 때까지 LIVE 주문을 잠갔습니다.',
    live_order_gate_unavailable: 'LIVE 주문 안전 상태를 확인할 수 없어 주문을 잠갔습니다.'
  };
  const message = messages[reason] || 'LIVE 주문을 안전하게 확인하지 못해 요청을 차단했습니다.';
  return {
    blocked: true,
    reason,
    blockedMessage: message,
    orderResult: { success: false, error: { code: reason, message } },
    fillResult: { filled: false, error: reason },
    fill: projectLiveFillResult(null)
  };
}

function liveOrderGateReason(tradingSystem, market, side) {
  const safety = tradingSystem?.getRuntimeSafetyStatus?.() || {};
  if (tradingSystem?._riskMonitorProtectiveOnly === true || safety.runtimeState === 'PROTECTIVE_ONLY') {
    return 'protective_only';
  }
  if (safety.runtimeState === 'SYNC_REQUIRED' || safety.exchangeStateKnown === false) {
    return 'exchange_state_unverified';
  }
  if (tradingSystem?._gracefulShutdownPromise) return 'trading_paused';
  const operatorStopped = ['operator_stop', 'operator_shutdown'].includes(tradingSystem?.stopReason);
  if (!operatorStopped && (tradingSystem?._entriesPaused === true || tradingSystem?._stopRequested === true)) {
    return 'trading_paused';
  }
  if (typeof tradingSystem?.canExecuteLiveOrder !== 'function') return 'live_order_gate_unavailable';
  const action = side === 'bid' ? 'BUY' : side === 'ask' ? 'SELL' : null;
  if (!action || !tradingSystem.canExecuteLiveOrder(market, { action })) {
    return 'exchange_state_unverified';
  }
  return null;
}

async function recordLiveSettlementReadback(tradingSystem, evidenceOptions, fillResult) {
  if (typeof tradingSystem?.getAccountInfo !== 'function') {
    return {
      recorded: true,
      observed: false,
      settlement: {
        status: 'not_observed',
        reason: 'account_readback_unavailable',
        observedAt: null,
        krwBalance: null,
        assetBalance: null,
        lockedBalance: null
      }
    };
  }
  try {
    const accounts = await tradingSystem.getAccountInfo();
    const settlement = projectLiveAccountReadback(
      accounts,
      evidenceOptions.market,
      evidenceOptions.side
    );
    const recorded = tradingSystem.recordLiveExecutionEvidence(tradingSystem.createLiveExecutionEvidence({
      ...evidenceOptions,
      eventType: 'SETTLEMENT_READBACK',
      order: fillResult?.order,
      fillResult,
      settlementReadback: settlement
    }));
    return {
      recorded,
      observed: settlement.status === 'observed',
      settlement
    };
  } catch (error) {
    return {
      recorded: true,
      observed: false,
      error: error.message,
      settlement: {
        status: 'not_observed',
        reason: `account_readback_failed: ${error.message}`,
        observedAt: null,
        krwBalance: null,
        assetBalance: null,
        lockedBalance: null
      }
    };
  }
}

/**
 * Execute one UI-originated live order only after wiring it to the same
 * bounded local evidence stream as the automatic trader. The helper waits for
 * the exchange result; callers must not update strategy state unless the
 * returned fillResult is filled. It never runs for dry-run requests.
 */
export async function executeLiveOrderWithEvidence(tradingSystem, {
  market,
  side,
  volume,
  price = null,
  orderType = 'limit',
  requested = null,
  referencePrice = null,
  signal = null,
  clientIntentId = null
} = {}) {
  if (!tradingSystem || tradingSystem.dryRun) {
    return {
      blocked: false,
      orderResult: null,
      fillResult: { filled: false, error: 'live_order_helper_requires_live_mode' },
      fill: projectLiveFillResult(null)
    };
  }
  if (tradingSystem._orderInProgress === true) return liveOrderBlockedResult('live_order_in_progress');

  tradingSystem._orderInProgress = true;
  try {
    if (tradingSystem.liveExecutionEvidenceWriteError || tradingSystem.liveExecutionEvidenceDataError) {
      const evidenceError = tradingSystem.liveExecutionEvidenceWriteError || tradingSystem.liveExecutionEvidenceDataError;
      return {
        blocked: true,
        reason: 'live_execution_evidence_unavailable',
        blockedMessage: 'LIVE 주문 기록을 안전하게 저장할 수 없어 주문을 잠갔습니다.',
        orderResult: { success: false, error: { message: evidenceError } },
        fillResult: { filled: false, error: evidenceError },
        fill: projectLiveFillResult(null)
      };
    }
    if (typeof tradingSystem.createLiveExecutionEvidence !== 'function' ||
      typeof tradingSystem.recordLiveExecutionEvidence !== 'function' ||
      typeof tradingSystem.submitLiveOrder !== 'function' ||
      typeof tradingSystem.ensureLiveOrderMarketStateVerified !== 'function') {
      return liveOrderBlockedResult('live_order_gate_unavailable');
    }

    let orderMarketVerified = false;
    try {
      orderMarketVerified = await tradingSystem.ensureLiveOrderMarketStateVerified(market);
    } catch {
      orderMarketVerified = false;
    }
    if (!orderMarketVerified) return liveOrderBlockedResult('exchange_state_unverified');

    const gateReason = liveOrderGateReason(tradingSystem, market, side);
    if (gateReason) return liveOrderBlockedResult(gateReason);

    let orderResult;
    try {
      orderResult = await tradingSystem.submitLiveOrder(
        market,
        side,
        volume,
        price,
        orderType,
        clientIntentId
      );
    } catch (error) {
      markLiveMarketOrderUnresolved(tradingSystem, market);
      const message = '주문 응답을 확인하지 못했습니다. 거래소 상태를 다시 확인할 때까지 이 시장의 주문을 잠갔습니다.';
      return {
        blocked: true,
        reason: 'order_submission_unknown',
        blockedMessage: message,
        orderResult: { success: false, error: { code: 'order_submission_unknown', message } },
        fillResult: { filled: false, error: error?.message || 'order_submission_unknown' },
        fill: projectLiveFillResult(null)
      };
    }

    const orderId = orderResult?.data?.uuid || null;
    const evidenceOptions = { orderId, market, side, orderType, requested, referencePrice, signal };
    const submissionEvidenceRecorded = tradingSystem.recordLiveExecutionEvidence(tradingSystem.createLiveExecutionEvidence({
      ...evidenceOptions,
      eventType: orderResult?.success === true ? 'ORDER_SUBMITTED' : 'ORDER_REJECTED',
      error: orderResult?.success === true ? null : orderResult?.error?.message
    }));
    if (!submissionEvidenceRecorded && orderResult?.success === true) {
      markLiveMarketOrderUnresolved(tradingSystem, market);
    }

    if (orderResult?.success !== true || !orderId) {
      if (orderResult?.success === true || orderId) markLiveMarketOrderUnresolved(tradingSystem, market);
      return {
        blocked: submissionEvidenceRecorded !== true,
        evidenceRecorded: submissionEvidenceRecorded,
        reason: submissionEvidenceRecorded ? null : 'live_execution_evidence_write_failed',
        blockedMessage: submissionEvidenceRecorded ? null : 'LIVE 주문 기록을 저장하지 못해 거래소 상태를 다시 확인해야 합니다.',
        orderResult,
        fillResult: { filled: false, error: orderResult?.error?.message || 'order_uuid_missing' },
        fill: projectLiveFillResult(null, orderId)
      };
    }

    let fillResult;
    try {
      fillResult = typeof tradingSystem.waitForLiveOrderFill === 'function'
        ? await tradingSystem.waitForLiveOrderFill(market, orderId, 30_000, 1_000)
        : await tradingSystem.upbit.waitForOrderFill(orderId, 30_000, 1_000);
    } catch (error) {
      fillResult = { filled: false, error: error?.message || 'fill_state_unresolved' };
      markLiveMarketOrderUnresolved(tradingSystem, market);
    }
    const fillEvidenceRecorded = tradingSystem.recordLiveExecutionEvidence(tradingSystem.createLiveExecutionEvidence({
      ...evidenceOptions,
      eventType: fillResult?.filled === true
        ? fillResult.partial === true ? 'FILL_PARTIAL' : 'FILL_OBSERVED'
        : 'FILL_NOT_OBSERVED',
      order: fillResult?.order,
      fillResult,
      error: fillResult?.error
    }));
    if (!submissionEvidenceRecorded || !fillEvidenceRecorded) {
      markLiveMarketOrderUnresolved(tradingSystem, market);
    }
    if (fillResult?.filled !== true || fillResult?.partial === true) {
      markLiveMarketOrderUnresolved(tradingSystem, market);
    }
    let settlementEvidence = {
      recorded: true,
      observed: false,
      settlement: null
    };
    if (fillResult?.filled === true && fillEvidenceRecorded) {
      settlementEvidence = await recordLiveSettlementReadback(tradingSystem, evidenceOptions, fillResult);
      if (settlementEvidence.observed !== true || settlementEvidence.recorded !== true) {
        markLiveMarketOrderUnresolved(tradingSystem, market);
      }
    }
    const orderState = fillResult?.order?.state;
    if (fillResult?.filled !== true && !['cancel', 'done'].includes(orderState)) {
      try {
        await tradingSystem.upbit.cancelOrder(orderId);
      } catch (error) {
        fillResult.cancelError = `주문 취소 실패: ${error.message}`;
      }
    } else if (fillResult?.partial === true) {
      try {
        await tradingSystem.upbit.cancelOrder(orderId);
      } catch (error) {
        fillResult.cancelError = `주문 취소 실패: ${error.message}`;
      }
    }
    const evidenceRecorded = submissionEvidenceRecorded && fillEvidenceRecorded && settlementEvidence.recorded;
    return {
      blocked: evidenceRecorded !== true,
      evidenceRecorded,
      reason: evidenceRecorded
        ? fillResult?.cancelError || settlementEvidence.error || null
        : 'live_execution_evidence_write_failed',
      blockedMessage: evidenceRecorded ? null : 'LIVE 주문 기록을 저장하지 못해 거래소 상태를 다시 확인해야 합니다.',
      orderResult,
      fillResult,
      fill: projectLiveFillResult(fillResult, orderId),
      settlement: settlementEvidence.settlement
    };
  } finally {
    tradingSystem._orderInProgress = false;
  }
}

function expectedSingleManualLiveOrder(req) {
  const market = req?.body?.coin;
  if (typeof market !== 'string' || !market) return null;
  if (req.path === '/trade/buy') return { market, side: 'bid' };
  if (req.path === '/trade/sell') return { market, side: 'ask' };
  if (req.path === '/trade/execute') {
    const action = typeof req.body?.action === 'string' ? req.body.action.toUpperCase() : '';
    if (action === 'BUY') return { market, side: 'bid' };
    if (action === 'SELL') return { market, side: 'ask' };
    return null;
  }
  if (req.path === '/trade/quick') {
    if (req.body?.action === 'BUY') return { market, side: 'bid' };
    if (req.body?.action === 'SELL') return { market, side: 'ask' };
  }
  return null;
}

export async function recoverSingleManualLiveOrder({ req, record, tradingSystem } = {}) {
  const expected = expectedSingleManualLiveOrder(req);
  const clientIntentId = record?.clientIntentId;
  if (!expected || typeof clientIntentId !== 'string') return null;

  const intentRead = readLiveOrderIntentEvidence(
    tradingSystem?.liveOrderIntentEvidenceIndex,
    clientIntentId
  );
  const intent = intentRead.intent;
  if (!intentRead.available || !intent ||
    intent.clientIntentId !== clientIntentId ||
    intent.identifier !== clientIntentId ||
    intent.market !== expected.market ||
    intent.side !== expected.side ||
    typeof tradingSystem?.upbit?.getOrder !== 'function') {
    return null;
  }

  // A same-key retry may only query the persisted identifier. It never calls
  // the route again or submits another order.
  const order = await tradingSystem.upbit.getOrder(clientIntentId, { identifier: true });
  const resolution = resolveTerminalLiveOrderReadback(order, {
    clientIntentId,
    market: expected.market,
    side: expected.side,
    orderType: intent.orderType
  });
  if (!resolution.terminal || typeof tradingSystem.persistLiveOrderReadback !== 'function') return null;

  await tradingSystem.persistLiveOrderReadback({
    lookupValue: clientIntentId,
    lookupByIdentifier: true,
    observedOrder: order,
    clientIntentId,
    market: intent.market,
    side: intent.side,
    orderType: intent.orderType,
    request: intent.request
  });

  const filled = resolution.outcome === 'filled';
  return {
    status: filled ? 200 : 409,
    body: {
      success: filled,
      mode: 'LIVE',
      recovered: true,
      market: expected.market,
      side: expected.side,
      message: filled
        ? '거래소 주문 조회에서 최종 체결을 확인했습니다. 지갑 잔액 정산은 별도로 확인되지 않았습니다.'
        : '거래소 주문 조회에서 미체결 취소를 확인했습니다. 원래 요청은 다시 실행하지 않았습니다.',
      order: resolution.order,
      fill: resolution.fill,
      settlement: {
        status: 'not_observed',
        reason: 'wallet_readback_not_performed',
        observedAt: null
      },
      strategyState: {
        status: 'not_mutated',
        reason: 'request_recovery_does_not_replay_route'
      }
    }
  };
}

/**
 * Manual multi-leg plans dispatch several exchange orders under one request
 * key. Each leg gets its own journal-bound clientIntentId before dispatch so
 * a same-key retry can resolve every leg independently.
 */
export const LIVE_MULTI_LEG_PATHS = new Set([
  '/trade/execute-bundle',
  '/trade/smart-buy',
  '/trade/smart-sell'
]);

/**
 * Attach a fresh exchange identifier to one leg of a pending multi-leg LIVE
 * request. Returns null when the durable journal cannot record the leg; the
 * caller must not dispatch the order in that case.
 */
export async function attachLiveLegIntent(manualOrderIdempotencyStore, req, leg) {
  const recordId = req?.manualOrderReservation?.recordId;
  if (typeof recordId !== 'string' || !recordId ||
    typeof manualOrderIdempotencyStore?.attachLegIntent !== 'function') {
    return null;
  }
  const clientIntentId = randomUUID();
  try {
    await manualOrderIdempotencyStore.attachLegIntent(recordId, leg, clientIntentId);
    return clientIntentId;
  } catch {
    return null;
  }
}

function undispatchedLegResult(leg, clientIntentId, intent = null) {
  return {
    leg,
    clientIntentId,
    market: intent?.market || null,
    side: intent?.side || null,
    outcome: 'not_dispatched',
    order: null,
    fill: {
      status: 'not_observed',
      orderId: null,
      exchangeState: null,
      executedVolume: null,
      remainingVolume: null,
      averagePrice: null,
      paidFee: null,
      error: 'order intent never reached the exchange'
    }
  };
}

/**
 * Resolve a pending multi-leg LIVE request by GET-only identifier readback of
 * every journal-recorded leg. A leg whose durable intent never produced an
 * ORDER_INTENT evidence record, or whose identifier is absent on the exchange,
 * provably never dispatched. Returns null while any recorded leg cannot be
 * resolved so the request stays unknown instead of guessing.
 */
export async function recoverMultiLegLiveOrder({ record, tradingSystem } = {}) {
  const legIntents = record?.legIntents;
  if (!legIntents || typeof legIntents !== 'object' || Array.isArray(legIntents) ||
    Object.keys(legIntents).length === 0 ||
    typeof tradingSystem?.upbit?.getOrder !== 'function' ||
    typeof tradingSystem?.persistLiveOrderReadback !== 'function') {
    return null;
  }

  const legs = [];
  for (const [leg, clientIntentId] of Object.entries(legIntents)) {
    const intentRead = readLiveOrderIntentEvidence(
      tradingSystem?.liveOrderIntentEvidenceIndex,
      clientIntentId
    );
    if (!intentRead.available) {
      if (intentRead.reason === 'live_order_intent_missing') {
        legs.push(undispatchedLegResult(leg, clientIntentId));
        continue;
      }
      return null;
    }
    const intent = intentRead.intent;
    if (!intent || intent.clientIntentId !== clientIntentId ||
      intent.identifier !== clientIntentId) {
      return null;
    }

    // The retry may only query the persisted identifier. It never submits a
    // second order for this leg.
    let order;
    try {
      order = await tradingSystem.upbit.getOrder(clientIntentId, { identifier: true });
    } catch (error) {
      if (Number(error?.response?.status) === 404 || Number(error?.status) === 404) {
        legs.push(undispatchedLegResult(leg, clientIntentId, intent));
        continue;
      }
      throw error;
    }
    if (!order || typeof order !== 'object') return null;

    const resolution = resolveTerminalLiveOrderReadback(order, {
      clientIntentId,
      market: intent.market,
      side: intent.side,
      orderType: intent.orderType
    });
    if (!resolution.terminal) return null;

    await tradingSystem.persistLiveOrderReadback({
      lookupValue: clientIntentId,
      lookupByIdentifier: true,
      observedOrder: order,
      clientIntentId,
      market: intent.market,
      side: intent.side,
      orderType: intent.orderType,
      request: intent.request
    });
    legs.push({
      leg,
      clientIntentId,
      market: intent.market,
      side: intent.side,
      outcome: resolution.outcome,
      order: resolution.order,
      fill: resolution.fill
    });
  }

  const filled = legs.every(leg => leg.outcome === 'filled');
  const partiallyResolved = legs.some(leg => leg.outcome === 'filled') &&
    legs.some(leg => leg.outcome !== 'filled');
  return {
    status: 200,
    body: {
      success: filled,
      mode: 'LIVE',
      recovered: true,
      partial: partiallyResolved || legs.some(leg => leg.outcome !== 'filled'),
      legs,
      message: filled
        ? '기록된 모든 주문의 거래소 최종 체결을 확인했습니다. 지갑 잔액 정산은 별도로 확인되지 않았습니다.'
        : '기록된 주문의 거래소 최종 상태를 확인했습니다. 체결되지 않은 레그는 원래 요청을 다시 실행하지 않았으며, 지갑 잔액 정산은 별도로 확인되지 않았습니다.',
      settlement: {
        status: 'not_observed',
        reason: 'wallet_readback_not_performed',
        observedAt: null
      },
      strategyState: {
        status: 'not_mutated',
        reason: 'request_recovery_does_not_replay_route'
      }
    }
  };
}

/** Dispatch request-level LIVE recovery by route shape. */
export async function recoverManualLiveOrderRequest(context = {}) {
  if (LIVE_MULTI_LEG_PATHS.has(context?.req?.path)) {
    return recoverMultiLegLiveOrder(context);
  }
  return recoverSingleManualLiveOrder(context);
}
