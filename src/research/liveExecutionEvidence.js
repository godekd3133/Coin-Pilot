import fs from 'node:fs';
import path from 'node:path';

export const LIVE_EXECUTION_EVIDENCE_SCHEMA = 'coinpilot.live-execution-evidence.v1';

function finiteNumber(value) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function textOrNull(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  return String(value);
}

function compactSettlementReadback(readback) {
  if (!readback || typeof readback !== 'object') {
    return {
      status: 'not_observed',
      reason: 'wallet_readback_not_recorded',
      observedAt: null,
      krwBalance: null,
      assetBalance: null,
      lockedBalance: null
    };
  }
  return {
    status: textOrNull(readback.status) || 'observed',
    reason: textOrNull(readback.reason),
    observedAt: textOrNull(readback.observedAt),
    krwBalance: finiteNumber(readback.krwBalance),
    assetBalance: finiteNumber(readback.assetBalance),
    lockedBalance: finiteNumber(readback.lockedBalance)
  };
}

export function projectLiveAccountReadback(accounts, market, side, observedAt = new Date().toISOString()) {
  const rows = Array.isArray(accounts) ? accounts : [];
  const coinSymbol = textOrNull(market)?.split('-')[1] || null;
  const krwAccount = rows.find(account => account?.currency === 'KRW');
  const assetAccount = coinSymbol
    ? rows.find(account => account?.currency === coinSymbol)
    : null;
  const relevantAccount = side === 'bid' ? assetAccount : krwAccount;
  return compactSettlementReadback({
    status: relevantAccount ? 'observed' : 'not_observed',
    reason: relevantAccount ? 'account_readback_after_fill' : 'relevant_account_missing',
    observedAt,
    krwBalance: krwAccount?.balance,
    assetBalance: assetAccount?.balance,
    lockedBalance: assetAccount?.locked
  });
}

/**
 * Keep the exchange order response bounded and free of request headers/tokens.
 * The result is evidence of an observed order state, not a wallet settlement
 * assertion.
 */
export function compactLiveOrder(order) {
  if (!order || typeof order !== 'object') return null;
  return {
    uuid: textOrNull(order.uuid),
    identifier: textOrNull(order.identifier),
    market: textOrNull(order.market),
    side: textOrNull(order.side),
    ordType: textOrNull(order.ord_type),
    state: textOrNull(order.state),
    executedVolume: finiteNumber(order.executed_volume),
    remainingVolume: finiteNumber(order.remaining_volume),
    avgPrice: finiteNumber(order.avg_price),
    paidFee: finiteNumber(order.paid_fee),
    createdAt: textOrNull(order.created_at),
    doneAt: textOrNull(order.done_at),
    tradesCount: finiteNumber(order.trades_count)
  };
}

/**
 * Create one append-only live execution event. `fillResult` may be absent for
 * an order-submitted event. No field in this object claims wallet settlement
 * unless an explicit account readback is supplied by the caller.
 */
export function createLiveExecutionEvidenceEvent({
  eventType,
  clientIntentId = null,
  orderId = null,
  market = null,
  side = null,
  orderType = null,
  requested = null,
  referencePrice = null,
  signal = null,
  order = null,
  fillResult = null,
  settlementReadback = null,
  error = null,
  errorCode = null,
  recordedAt = new Date().toISOString()
} = {}) {
  const compactOrder = compactLiveOrder(order);
  const resolvedOrderId = textOrNull(orderId) || compactOrder?.uuid || null;
  const filled = fillResult?.filled === true;
  const partial = fillResult?.partial === true || (
    compactOrder !== null &&
    compactOrder.executedVolume !== null &&
    compactOrder.remainingVolume !== null &&
    compactOrder.executedVolume > 0 &&
    compactOrder.remainingVolume > 0
  );
  const resolvedEventType = textOrNull(eventType) || (filled ? 'FILL_OBSERVED' : 'ORDER_EVENT');
  return {
    schema: LIVE_EXECUTION_EVIDENCE_SCHEMA,
    eventType: resolvedEventType,
    recordedAt,
    clientIntentId: textOrNull(clientIntentId),
    identifier: textOrNull(clientIntentId),
    orderId: resolvedOrderId,
    market: textOrNull(market) || compactOrder?.market || null,
    side: textOrNull(side) || compactOrder?.side || null,
    orderType: textOrNull(orderType) || compactOrder?.ordType || null,
    request: requested && typeof requested === 'object'
      ? {
        amount: finiteNumber(requested.amount),
        volume: finiteNumber(requested.volume),
        price: finiteNumber(requested.price)
      }
      : null,
    referencePrice: finiteNumber(referencePrice),
    signal: signal && typeof signal === 'object'
      ? {
        signalKey: textOrNull(signal.signalKey),
        signalTime: textOrNull(signal.signalTime),
        referencePrice: finiteNumber(signal.referencePrice),
        entryDelayMs: finiteNumber(signal.entryDelayMs)
      }
      : null,
    order: compactOrder,
    fill: {
      status: filled ? partial ? 'partial' : 'filled' : 'not_observed',
      executedVolume: compactOrder?.executedVolume ?? null,
      remainingVolume: compactOrder?.remainingVolume ?? null,
      averagePrice: compactOrder?.avgPrice ?? null,
      paidFee: compactOrder?.paidFee ?? null,
      exchangeState: compactOrder?.state || null,
      error: textOrNull(error) || textOrNull(fillResult?.error)
    },
    settlement: compactSettlementReadback(settlementReadback),
    errorCode: textOrNull(errorCode),
    note: 'Local order/fill evidence only. It is not a wallet settlement, realized P&L, or live-profitability claim unless an explicit settlement readback is present.'
  };
}

function isValidEvent(event) {
  const hasEnvelope = event && typeof event === 'object' &&
    event.schema === LIVE_EXECUTION_EVIDENCE_SCHEMA &&
    typeof event.eventType === 'string' &&
    typeof event.recordedAt === 'string';
  if (!hasEnvelope) return false;
  if (event.eventType === 'ORDER_INTENT') {
    return typeof event.clientIntentId === 'string' && event.clientIntentId.length > 0 &&
      typeof event.market === 'string' && event.market.length > 0 &&
      ['bid', 'ask'].includes(event.side) &&
      event.request && typeof event.request === 'object' &&
      ['amount', 'volume', 'price'].some(field => event.request[field] !== null &&
        event.request[field] !== undefined && Number.isFinite(Number(event.request[field])) &&
        Number(event.request[field]) > 0);
  }
  return true;
}

function hasCompleteFillEvidence(event) {
  const fill = event?.fill;
  const hasObservedNumber = value => value !== null && value !== undefined && Number.isFinite(Number(value));
  return ['filled', 'partial'].includes(fill?.status) &&
    hasObservedNumber(fill.executedVolume) && Number(fill.executedVolume) > 0 &&
    hasObservedNumber(fill.averagePrice) && Number(fill.averagePrice) > 0 &&
    hasObservedNumber(fill.paidFee) && Number(fill.paidFee) >= 0 &&
    hasObservedNumber(fill.remainingVolume) && Number(fill.remainingVolume) >= 0;
}

export function isTerminalLiveOrderResolution(event) {
  if (!event || typeof event !== 'object') return false;
  const order = event.order;
  const state = order?.state || event.fill?.exchangeState;
  const executedVolume = finiteNumber(order?.executedVolume ?? event.fill?.executedVolume);
  const remainingVolume = finiteNumber(order?.remainingVolume ?? event.fill?.remainingVolume);
  if (!['cancel', 'done'].includes(state)) return false;
  if (event.eventType === 'FILL_NOT_OBSERVED') return executedVolume === 0;
  if (event.eventType === 'FILL_OBSERVED') {
    return state === 'done' && executedVolume > 0 && remainingVolume === 0 && hasCompleteFillEvidence(event);
  }
  if (event.eventType === 'FILL_PARTIAL') {
    return executedVolume > 0 && hasCompleteFillEvidence(event);
  }
  return false;
}

export function isDefinitiveLiveOrderRejection(event) {
  const definitiveCodes = new Set([
    'insufficient_funds_bid',
    'insufficient_funds_ask',
    'under_min_total_bid',
    'under_min_total_ask',
    'invalid_volume_bid',
    'invalid_volume_ask',
    'invalid_funds_bid',
    'market_does_not_exist'
  ]);
  return event?.eventType === 'ORDER_REJECTED' && definitiveCodes.has(event.errorCode);
}

export function inspectLiveExecutionEvidenceFile(filePath, { fileSnapshot = null } = {}) {
  const existsSync = fileSnapshot?.existsSync || fs.existsSync;
  const readFileSync = fileSnapshot?.readText || fs.readFileSync;
  if (!filePath || !existsSync(filePath)) {
    return {
      available: false,
      malformedLineCount: 0,
      reconciliation: null,
      blockingReasons: []
    };
  }

  let lines;
  try {
    lines = readFileSync(filePath, 'utf8').split('\n');
  } catch (error) {
    return {
      available: false,
      malformedLineCount: 0,
      reconciliation: null,
      blockingReasons: [`live evidence file read failed: ${error.message}`],
      error: error.message
    };
  }

  const events = [];
  let malformedLineCount = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      malformedLineCount += 1;
    }
  }
  const reconciliation = reconcileLiveExecutionEvidence(events);
  const blockingReasons = [];
  if (malformedLineCount > 0 || reconciliation.invalidEventCount > 0) {
    blockingReasons.push('live evidence contains malformed records');
  }
  if (reconciliation.unresolvedSubmittedOrderCount > 0) {
    blockingReasons.push(`unresolved submitted orders: ${reconciliation.unresolvedSubmittedOrderCount}`);
  }
  if (reconciliation.unresolvedOrderIntentCount > 0) {
    blockingReasons.push(`unresolved order intents: ${reconciliation.unresolvedOrderIntentCount}`);
  }
  if (reconciliation.incompleteFillObservedCount > 0) {
    blockingReasons.push(`incomplete fill records: ${reconciliation.incompleteFillObservedCount}`);
  }
  return {
    available: true,
    malformedLineCount,
    reconciliation,
    blockingReasons
  };
}

/**
 * Project the local evidence file into a dashboard-safe, read-only status.
 *
 * The file inspection describes evidence history; the runtime errors describe
 * whether this process has already fail-closed its live order path. Keep these
 * concepts separate so an empty file is not presented as an order block, and a
 * newly appended malformed record is not mistaken for a current-process gate
 * decision. The absolute path and raw error text never leave the process.
 */
export function projectLiveExecutionEvidenceStatus({
  filePath = null,
  liveMode = false,
  runtimeWriteError = null,
  runtimeDataError = null,
  fileSnapshot = null
} = {}) {
  const inspection = inspectLiveExecutionEvidenceFile(filePath, { fileSnapshot });
  const runtimeOrderGateBlocked = Boolean(runtimeWriteError || runtimeDataError);
  const runtimeBlockingReasons = [
    runtimeDataError ? '현재 프로세스의 live evidence 안전 게이트가 차단되었습니다.' : null,
    runtimeWriteError ? '현재 프로세스의 live evidence 저장이 실패했습니다.' : null
  ].filter(Boolean);
  const blockingReasons = [
    ...inspection.blockingReasons,
    ...runtimeBlockingReasons
  ];
  const reconciliation = inspection.reconciliation;
  const historyNeedsReview = blockingReasons.length > 0;
  const status = runtimeOrderGateBlocked
    ? 'blocked'
    : historyNeedsReview
      ? 'review_required'
      : reconciliation?.readyForSettlementComparison === true
        ? 'settlement_ready'
        : inspection.available
          ? 'observed'
          : 'not_observed';

  return {
    schema: LIVE_EXECUTION_EVIDENCE_SCHEMA,
    researchOnly: true,
    promoted: false,
    liveMode: liveMode === true,
    evidenceFile: filePath ? path.basename(String(filePath)) : null,
    available: inspection.available,
    reason: !inspection.available && blockingReasons.length === 0
      ? 'evidence_file_not_found'
      : null,
    status,
    runtimeOrderGateBlocked,
    historyNeedsReview,
    restartSafetyBlocked: historyNeedsReview,
    malformedLineCount: inspection.malformedLineCount,
    blockingReasons,
    reconciliation,
    readyForSettlementComparison: reconciliation?.readyForSettlementComparison === true,
    note: 'Read-only evidence status. It never authorizes live orders or proves wallet settlement, realized P&L, or profitability.'
  };
}

/**
 * Summarize an evidence stream without inferring fills or settlement from a
 * submission alone. Invalid records and unmatched order IDs remain visible.
 */
export function reconcileLiveExecutionEvidence(events = []) {
  const rows = Array.isArray(events) ? events : [];
  const invalidCount = rows.filter(event => !isValidEvent(event)).length;
  const valid = rows.filter(isValidEvent);
  const intents = valid.filter(event => event.eventType === 'ORDER_INTENT' && event.clientIntentId);
  const submitted = valid.filter(event => event.eventType === 'ORDER_SUBMITTED');
  const fillObserved = valid.filter(event => event.eventType !== 'SETTLEMENT_READBACK' &&
    (['FILL_OBSERVED', 'FILL_PARTIAL'].includes(event.eventType) ||
    ['filled', 'partial'].includes(event.fill?.status)));
  const completeFillObserved = fillObserved.filter(hasCompleteFillEvidence);
  const incompleteFillObserved = fillObserved.filter(event => !hasCompleteFillEvidence(event));
  const notFilled = valid.filter(event => event.eventType === 'FILL_NOT_OBSERVED');
  const settlementObserved = valid.filter(event => event.settlement?.status === 'observed');
  const orderIds = eventsForOrder => new Set(eventsForOrder
    .map(event => event.orderId)
    .filter(Boolean));
  const submittedIds = orderIds(submitted);
  const submittedEventById = new Map();
  for (const event of submitted) {
    if (!event.orderId) continue;
    const previous = submittedEventById.get(event.orderId);
    if (!previous ||
      (event.clientIntentId && !previous.clientIntentId) ||
      (Boolean(event.clientIntentId) === Boolean(previous.clientIntentId) &&
        Date.parse(event.recordedAt) >= Date.parse(previous.recordedAt))) {
      submittedEventById.set(event.orderId, event);
    }
  }
  const knownSubmittedOrders = [...submittedIds].map(orderId => {
    const event = submittedEventById.get(orderId);
    return {
      orderId,
      market: event?.market || null,
      side: event?.side || null,
      clientIntentId: event?.clientIntentId || null,
      request: event?.request || null,
      orderType: event?.orderType || null,
      submittedAt: event?.recordedAt || null
    };
  });
  const terminalOrderIds = new Set();
  const orderStateEvents = valid.filter(event => event.orderId && [
    'ORDER_STATE_OBSERVED', 'FILL_OBSERVED', 'FILL_PARTIAL', 'FILL_NOT_OBSERVED'
  ].includes(event.eventType));
  const latestObservedOrderById = new Map();
  for (const event of orderStateEvents) {
    if (event.market) {
      const previous = latestObservedOrderById.get(event.orderId);
      if (!previous || Date.parse(event.recordedAt) >= Date.parse(previous.recordedAt)) {
        latestObservedOrderById.set(event.orderId, event);
      }
    }
    if (event.eventType === 'ORDER_STATE_OBSERVED') {
      const state = event.order?.state || event.fill?.exchangeState;
      if (!['cancel', 'done'].includes(state)) terminalOrderIds.delete(event.orderId);
      continue;
    }
    if (isTerminalLiveOrderResolution(event)) terminalOrderIds.add(event.orderId);
    else terminalOrderIds.delete(event.orderId);
  }
  for (const [orderId, event] of submittedEventById) {
    const observed = latestObservedOrderById.get(orderId);
    if (!observed) continue;
    submittedEventById.set(orderId, {
      ...event,
      market: event.market || observed.market,
      side: event.side || observed.side,
      request: event.request || observed.request,
      orderType: event.orderType || observed.orderType
    });
  }
  const unresolvedSubmittedOrderIds = [...submittedIds].filter(orderId => !terminalOrderIds.has(orderId));
  const unresolvedSubmittedOrders = unresolvedSubmittedOrderIds
    .map(orderId => {
      const event = submittedEventById.get(orderId);
      return {
        orderId,
        market: event.market || null,
        side: event.side || null,
        clientIntentId: event.clientIntentId || null,
        request: event.request || null,
        orderType: event.orderType || null,
        submittedAt: event.recordedAt
      };
    });
  const intentIdsWithSubmittedOrder = new Set(submitted
    .filter(event => typeof event.orderId === 'string' && event.orderId.trim())
    .map(event => event.clientIntentId)
    .filter(Boolean));
  const resolvedIntentIds = new Set(valid
    .filter(isDefinitiveLiveOrderRejection)
    .map(event => event.clientIntentId)
    .filter(Boolean));
  const intentById = new Map();
  for (const event of intents) {
    if (!intentById.has(event.clientIntentId)) intentById.set(event.clientIntentId, event);
  }
  const unresolvedOrderIntents = [...intentById.entries()]
    .filter(([clientIntentId]) => !intentIdsWithSubmittedOrder.has(clientIntentId) &&
      !resolvedIntentIds.has(clientIntentId))
    .map(([clientIntentId, event]) => ({
      clientIntentId,
      market: event.market || null,
      side: event.side || null,
      request: event.request || null,
      orderType: event.orderType || null,
      createdAt: event.recordedAt,
      reason: valid.some(row => row.clientIntentId === clientIntentId && row.eventType === 'ORDER_POST_AMBIGUOUS')
        ? 'post_response_unknown'
        : 'intent_outcome_unknown'
    }));
  unresolvedOrderIntents.push(...submitted
    .filter(event => !(typeof event.orderId === 'string' && event.orderId.trim()) && !event.clientIntentId)
    .map(event => ({
      clientIntentId: null,
      market: event.market || null,
      side: event.side || null,
      request: event.request || null,
      createdAt: event.recordedAt,
      reason: 'submitted_order_uuid_missing'
    })));
  const positionStateByMarket = new Map();
  const latestFillByOrder = new Map();
  const firstFillTimeByOrder = new Map();
  const uncorrelatedFills = [];
  for (const event of fillObserved) {
    if (typeof event.orderId === 'string' && event.orderId) {
      const previous = latestFillByOrder.get(event.orderId);
      if (!previous || Date.parse(event.recordedAt) >= Date.parse(previous.recordedAt)) {
        latestFillByOrder.set(event.orderId, event);
      }
      if (Number(event.fill?.executedVolume) > 0) {
        const firstFillAt = firstFillTimeByOrder.get(event.orderId);
        if (!firstFillAt || Date.parse(event.recordedAt) < Date.parse(firstFillAt)) {
          firstFillTimeByOrder.set(event.orderId, event.recordedAt);
        }
      }
    } else {
      uncorrelatedFills.push(event);
    }
  }
  const deduplicatedOrderFills = [...latestFillByOrder.entries()].map(([orderId, event]) => ({
    ...event,
    recordedAt: firstFillTimeByOrder.get(orderId) || event.recordedAt
  }));
  const chronologicalFills = [...deduplicatedOrderFills, ...uncorrelatedFills].sort((left, right) =>
    Date.parse(left.recordedAt) - Date.parse(right.recordedAt)
  );
  for (const event of chronologicalFills) {
    const market = event.market;
    const side = event.side;
    const volume = Number(event.fill?.executedVolume);
    if (typeof market !== 'string' || !['bid', 'ask'].includes(side) ||
      !Number.isFinite(volume) || volume <= 0) continue;
    const state = positionStateByMarket.get(market) || { netVolume: 0, entryTime: null };
    const direction = side === 'bid' ? 1 : -1;
    if (direction > 0 && state.netVolume <= 1e-8) state.entryTime = event.recordedAt;
    state.netVolume += direction * volume;
    if (state.netVolume <= 1e-8) {
      state.netVolume = 0;
      state.entryTime = null;
    }
    positionStateByMarket.set(market, state);
  }
  const managedMarketSet = new Set(unresolvedSubmittedOrders.map(order => order.market).filter(Boolean));
  for (const intent of unresolvedOrderIntents) {
    if (intent.market) managedMarketSet.add(intent.market);
  }
  const managedOpenPositions = [];
  for (const [market, state] of positionStateByMarket) {
    if (state.netVolume > 1e-8) {
      managedMarketSet.add(market);
      managedOpenPositions.push({ market, amount: state.netVolume, entryTime: state.entryTime });
    }
  }
  const sideCounts = Object.fromEntries(['bid', 'ask'].map(side => [side, {
    submitted: submitted.filter(event => event.side === side).length,
    fillObserved: fillObserved.filter(event => event.side === side).length,
    settlementObserved: settlementObserved.filter(event => event.side === side).length
  }]));
  return {
    schema: LIVE_EXECUTION_EVIDENCE_SCHEMA,
    researchOnly: true,
    promoted: false,
    eventCount: rows.length,
    validEventCount: valid.length,
    invalidEventCount: invalidCount,
    orderIntentCount: intents.length,
    knownClientIntentIds: [...new Set(valid.map(event => event.clientIntentId).filter(Boolean))],
    submittedOrderCount: submitted.length,
    fillObservedCount: fillObserved.length,
    completeFillObservedCount: completeFillObserved.length,
    incompleteFillObservedCount: incompleteFillObserved.length,
    notFilledCount: notFilled.length,
    settlementObservedCount: settlementObserved.length,
    knownSubmittedOrderIds: [...submittedIds],
    knownSubmittedOrders,
    managedMarkets: [...managedMarketSet].sort(),
    managedOpenPositions,
    unresolvedSubmittedOrderCount: unresolvedSubmittedOrderIds.length,
    unresolvedSubmittedOrderIds,
    unresolvedSubmittedOrders,
    unresolvedOrderIntentCount: unresolvedOrderIntents.length,
    unresolvedOrderIntents,
    sideCounts,
    readyForSettlementComparison: completeFillObserved.length > 0 && settlementObserved.length > 0,
    note: 'Reconciliation is evidence bookkeeping only. A submitted order is not a fill, and a fill is not wallet settlement without an explicit account readback.'
  };
}
