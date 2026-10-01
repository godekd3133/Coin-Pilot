// LiveOrderGateway — LIVE 모드 주문 실행 증거와 거래소 정합성 복구.
//
// MultiCoinTrader에서 추출. 소유 범위:
// - liveExecutionEvidence 파일 IO + intent ledger(record/persist/readback)
// - 주문 제출·체결 대기·client-intent 추적
// - 재시작 후 미결 주문 복구와 거래소 상태 재조정(sync/resolve)
// - 증거 기반 마켓 차단(verified/pending/unknown/blocked markets)
//
// 포트폴리오·전략·수명주기 상태는 owner(MultiCoinTrader)를 통해 조회한다.
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import {
  addLiveOrderIntentEvidence,
  canAddLiveOrderIntentEvidence,
  createLiveExecutionEvidenceEvent,
  isDefinitiveLiveOrderRejection,
  isTerminalLiveOrderResolution,
  inspectLiveExecutionEvidenceFile,
  projectLiveAccountReadback
} from '../research/liveExecutionEvidence.js';

function syncDirectoryForLiveEvidence(directory) {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function createLiveEvidenceDirectoryDurably(directory) {
  const absoluteDirectory = path.resolve(directory);
  const missingDirectories = [];
  let current = absoluteDirectory;
  while (!fs.existsSync(current)) {
    missingDirectories.push(current);
    const parent = path.dirname(current);
    if (parent === current) throw new Error('could not resolve live evidence directory parent');
    current = parent;
  }

  if (missingDirectories.length === 0) return;
  fs.mkdirSync(absoluteDirectory, { recursive: true, mode: 0o700 });
  for (const createdDirectory of missingDirectories.reverse()) {
    syncDirectoryForLiveEvidence(path.dirname(createdDirectory));
  }
}

export class LiveOrderGateway {
  constructor(owner) {
    this.owner = owner;
    this._liveOrderStateUnknownMarkets = null;
    this._livePendingOrderMarkets = null;
    this._liveUnresolvedOrderIntents = null;
    this.liveExecutionEvidenceDataError = null;
    this._liveEvidenceBlockedMarkets = null;
    this._liveAccountStateKnown = false;
    this._exchangeSyncPromise = null;
    this._liveRecoveredManagedMarkets = null;
    this._liveUnresolvedOrderIds = null;
    this._liveExchangeStateKnown = false;
    this.liveExecutionEvidenceFile = null;
    this._liveVerifiedOrderMarkets = null;
    this._liveUsedOrderIntentIds = null;
    this.liveExecutionEvidenceWriteError = null;
    this.liveOrderIntentEvidenceIndex = null;
    this._liveEngineOrderIds = null;
    this._liveEngineOrderMarkets = null;
    this._liveOrderClientIntentById = null;
    this._manualOrderReconciliationMarkets = null;
    this._lastSyncTime = undefined;
    this._liveRecordedSubmissionIds = null;
    this._liveRecordedIntentOutcomeKeys = null;
    this._liveEvidenceDirectorySynced = false;
    this._liveLatestOrderIntentByMarket = null;
    this._startupReconciliationPending = false;
  }

  /**
   * Persist bounded live order/fill events without exposing API credentials.
   * A write failure blocks subsequent live orders so the execution path cannot
   * continue producing untracked trades. Dry-run/paper paths never write this
   * file.
   */
  recordLiveExecutionEvidence(event) {
    if (this.owner.dryRun || !event) return true;
    if (this.liveExecutionEvidenceWriteError || this.liveExecutionEvidenceDataError) return false;
    if (event.eventType === 'ORDER_INTENT' &&
      !canAddLiveOrderIntentEvidence(this.liveOrderIntentEvidenceIndex, event)) {
      this.liveExecutionEvidenceDataError = 'live order intent index is unavailable or ambiguous';
      return false;
    }
    const outcomeKey = event.clientIntentId && ['ORDER_SUBMITTED', 'ORDER_REJECTED'].includes(event.eventType)
      ? `${event.eventType}:${event.clientIntentId}`
      : null;
    if ((event.eventType === 'ORDER_SUBMITTED' && event.orderId && this._liveRecordedSubmissionIds.has(event.orderId)) ||
      (outcomeKey && this._liveRecordedIntentOutcomeKeys.has(outcomeKey))) {
      return true;
    }
    try {
      const directory = path.dirname(this.liveExecutionEvidenceFile);
      if (directory) createLiveEvidenceDirectoryDurably(directory);
      let descriptor;
      let evidenceFileCreated = false;
      try {
        descriptor = fs.openSync(this.liveExecutionEvidenceFile, 'wx', 0o600);
        evidenceFileCreated = true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        descriptor = fs.openSync(this.liveExecutionEvidenceFile, 'a', 0o600);
      }
      try {
        // openSync's mode is ignored for an existing file, so protect the
        // descriptor before appending account and execution evidence.
        fs.fchmodSync(descriptor, 0o600);
        const payload = Buffer.from(`${JSON.stringify(event)}\n`, 'utf8');
        let offset = 0;
        while (offset < payload.length) {
          const written = fs.writeSync(descriptor, payload, offset, payload.length - offset);
          if (written <= 0) throw new Error('live evidence append made no progress');
          offset += written;
        }
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      // fsync on the evidence file protects its appended bytes. On this
      // process's first append, also sync the parent directory so an existing
      // or newly-created ledger entry survives a host crash before POST.
      if (directory && (evidenceFileCreated || this._liveEvidenceDirectorySynced !== true)) {
        syncDirectoryForLiveEvidence(directory);
        this._liveEvidenceDirectorySynced = true;
      }
      if ((event.eventType === 'ORDER_INTENT' || event.eventType === 'ORDER_REJECTED') &&
        !addLiveOrderIntentEvidence(this.liveOrderIntentEvidenceIndex, event)) {
        this.liveExecutionEvidenceDataError = 'live order intent index update failed after append';
        return false;
      }
      this.applyLiveExecutionEvidenceRuntimeState(event);
      if (outcomeKey) this._liveRecordedIntentOutcomeKeys.add(outcomeKey);
      if (event.eventType === 'ORDER_SUBMITTED' && event.orderId) this._liveRecordedSubmissionIds.add(event.orderId);
      return true;
    } catch (error) {
      this.liveExecutionEvidenceWriteError = error.message;
      console.error(`❌ live execution evidence 저장 실패: ${error.message}`);
      return false;
    }
  }

  applyLiveExecutionEvidenceRuntimeState(event) {
    const clientIntentId = event.clientIntentId || null;
    const market = event.market || null;
    if (event.eventType === 'ORDER_INTENT' && clientIntentId) {
      this._liveUsedOrderIntentIds.add(clientIntentId);
      const intent = {
        clientIntentId,
        market,
        side: event.side || null,
        request: event.request || null,
        createdAt: event.recordedAt,
        reason: 'intent_outcome_unknown'
      };
      this._liveUnresolvedOrderIntents.set(clientIntentId, intent);
      if (market) {
        this._liveRecoveredManagedMarkets.add(market);
        this._liveEvidenceBlockedMarkets.add(market);
      }
      return;
    }
    if (event.eventType === 'ORDER_SUBMITTED' && typeof event.orderId === 'string' && event.orderId) {
      this._liveEngineOrderIds.add(event.orderId);
      this._liveEngineOrderMarkets.set(event.orderId, market);
      if (clientIntentId) {
        this._liveOrderClientIntentById.set(event.orderId, clientIntentId);
        this._liveUnresolvedOrderIntents.delete(clientIntentId);
      }
      this._liveUnresolvedOrderIds.set(event.orderId, {
        orderId: event.orderId,
        market,
        side: event.side || null,
        clientIntentId,
        submittedAt: event.recordedAt
      });
      if (market) this._liveRecoveredManagedMarkets.add(market);
    }
    if (event.eventType === 'ORDER_SUBMITTED' && !event.orderId && clientIntentId) {
      this._liveUnresolvedOrderIntents.set(clientIntentId, {
        clientIntentId,
        market,
        side: event.side || null,
        request: event.request || null,
        createdAt: event.recordedAt,
        reason: 'submitted_order_uuid_missing'
      });
    }
    if (event.eventType === 'ORDER_POST_AMBIGUOUS' && clientIntentId) {
      const intent = this._liveUnresolvedOrderIntents.get(clientIntentId);
      if (intent) intent.reason = 'post_response_unknown';
    }
    if (isDefinitiveLiveOrderRejection(event) && clientIntentId) {
      this._liveUnresolvedOrderIntents.delete(clientIntentId);
      this.clearLiveEvidenceMarketBlockIfResolved(market);
    }
    if (event.orderId && isTerminalLiveOrderResolution(event)) {
      this._liveUnresolvedOrderIds.delete(event.orderId);
      const resolvedIntentId = clientIntentId || this._liveOrderClientIntentById.get(event.orderId);
      if (resolvedIntentId) this._liveUnresolvedOrderIntents.delete(resolvedIntentId);
      this.clearLiveEvidenceMarketBlockIfResolved(market);
    }
    if (event.eventType === 'FILL_NOT_OBSERVED' && !isTerminalLiveOrderResolution(event) && market) {
      this.markLiveMarketOrderUnresolved(market);
    }
    if (event.eventType === 'FILL_PARTIAL' && !isTerminalLiveOrderResolution(event) && market) {
      this.markLiveMarketOrderUnresolved(market);
    }
    if (event.eventType === 'SETTLEMENT_READBACK' && event.settlement?.status !== 'observed' && market) {
      this.markLiveMarketOrderUnresolved(market);
    }
  }

  clearLiveEvidenceMarketBlockIfResolved(market) {
    if (typeof market !== 'string' || !market) return;
    const unresolvedOrder = [...this._liveUnresolvedOrderIds.values()].some(order => order.market === market);
    const unresolvedIntent = [...this._liveUnresolvedOrderIntents.values()].some(intent => intent.market === market);
    if (!unresolvedOrder && !unresolvedIntent) {
      this._liveEvidenceBlockedMarkets.delete(market);
      this._liveVerifiedOrderMarkets.delete(market);
    }
  }

  createLiveExecutionEvidence(options = {}) {
    const orderId = options.orderId || options.order?.uuid;
    const clientIntentId = options.clientIntentId ||
      (orderId ? this._liveOrderClientIntentById.get(orderId) : null) ||
      (options.market ? this._liveLatestOrderIntentByMarket.get(options.market) : null);
    return createLiveExecutionEvidenceEvent({ ...options, clientIntentId });
  }

  async cancelLiveOrderIfOpen(orderId, order = null) {
    if (!orderId || ['cancel', 'done'].includes(order?.state)) return true;
    try {
      await this.owner.upbit.cancelOrder(orderId, { priority: 'risk' });
      return true;
    } catch (error) {
      console.error(`❌ live 주문 취소 실패 (${orderId}): ${error.message}`);
      return false;
    }
  }

  async recordLiveSettlementReadback({
    orderId,
    market,
    side,
    orderType,
    requested,
    referencePrice,
    order,
    fillResult
  } = {}) {
    let settlementReadback;
    try {
      const accounts = await this.owner.getAccountInfo();
      settlementReadback = projectLiveAccountReadback(accounts, market, side);
    } catch (error) {
      settlementReadback = {
        status: 'not_observed',
        reason: `account_readback_failed: ${error.message}`,
        observedAt: null,
        krwBalance: null,
        assetBalance: null,
        lockedBalance: null
      };
    }
    const recorded = this.recordLiveExecutionEvidence(this.createLiveExecutionEvidence({
      eventType: 'SETTLEMENT_READBACK',
      orderId,
      market,
      side,
      orderType,
      requested,
      referencePrice,
      order,
      fillResult,
      settlementReadback
    }));
    return {
      recorded,
      observed: settlementReadback.status === 'observed',
      settlement: settlementReadback
    };
  }

  async ensureLiveOrderMarketStateVerified(market) {
    if (this.owner.dryRun || typeof market !== 'string' || !market.trim()) return false;
    const maxVerifiedAgeMs = 10 * 60 * 1000;
    const isVerified = () => {
      const verifiedAt = Number(this._liveVerifiedOrderMarkets.get(market));
      return this._liveAccountStateKnown === true && this._liveExchangeStateKnown === true &&
        Number.isFinite(verifiedAt) && Date.now() - verifiedAt < maxVerifiedAgeMs &&
        !this._liveEvidenceBlockedMarkets.has(market) &&
        !this._liveOrderStateUnknownMarkets.has(market) &&
        !this._livePendingOrderMarkets.has(market);
    };
    if (isVerified()) return true;

    if (this._exchangeSyncPromise) await this._exchangeSyncPromise;
    this._manualOrderReconciliationMarkets.add(market);
    try {
      const synchronized = await this.syncWithExchange();
      if (synchronized) this._lastSyncTime = Date.now();
      return synchronized === true && isVerified();
    } finally {
      this._manualOrderReconciliationMarkets.delete(market);
    }
  }

  markLiveMarketOrderUnresolved(market) {
    if (this.owner.dryRun || typeof market !== 'string' || !market.trim()) return;
    this._liveRecoveredManagedMarkets.add(market);
    this._liveEvidenceBlockedMarkets.add(market);
    this._liveOrderStateUnknownMarkets.add(market);
    this._livePendingOrderMarkets.add(market);
  }

  async submitLiveOrder(market, side, volume, price, orderType, requestedClientIntentId = null) {
    if (this.owner.dryRun) throw new Error('submitLiveOrder is only available in LIVE mode');
    if (!market || !['bid', 'ask'].includes(side)) throw new Error('invalid live order market or side');
    const validPositive = value => Number.isFinite(Number(value)) && Number(value) > 0;
    if ((orderType === 'price' && !validPositive(volume)) ||
      (orderType === 'market' && !validPositive(volume)) ||
      (orderType === 'limit' && (!validPositive(volume) || !validPositive(price))) ||
      !['price', 'market', 'limit'].includes(orderType)) {
      throw new Error('invalid live order request');
    }
    if (!this._liveAccountStateKnown || !this._liveExchangeStateKnown ||
      !this.owner.canExecuteLiveOrder(market, { action: side === 'bid' ? 'BUY' : 'SELL' })) {
      throw new Error(`live order state is not verified for ${market}`);
    }
    if (this.liveExecutionEvidenceWriteError || this.liveExecutionEvidenceDataError) {
      throw new Error('live execution evidence is unavailable');
    }
    let clientIntentId = requestedClientIntentId;
    if (clientIntentId !== null && clientIntentId !== undefined) {
      if (typeof clientIntentId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientIntentId) ||
        this._liveUsedOrderIntentIds.has(clientIntentId)) {
        throw new Error('invalid or already-used live order identifier');
      }
    } else {
      clientIntentId = null;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const candidate = randomUUID();
        if (!this._liveUsedOrderIntentIds.has(candidate)) {
          clientIntentId = candidate;
          break;
        }
      }
    }
    if (!clientIntentId) throw new Error('could not allocate an unused live order identifier');
    this._liveUsedOrderIntentIds.add(clientIntentId);
    const requested = orderType === 'price'
      ? { amount: volume }
      : orderType === 'market'
        ? { volume }
        : { volume, price };
    const intent = this.createLiveExecutionEvidence({
      eventType: 'ORDER_INTENT',
      clientIntentId,
      market,
      side,
      orderType,
      requested
    });
    if (!this.recordLiveExecutionEvidence(intent)) {
      throw new Error('could not durably record live order intent');
    }
    this._liveLatestOrderIntentByMarket.set(market, clientIntentId);
    try {
      const orderResult = await this.owner.upbit.order(
        market,
        side,
        volume,
        price,
        orderType,
        clientIntentId,
        { priority: 'risk' }
      );
      const orderId = orderResult?.data?.uuid || null;
      if (orderResult?.success === true) {
        const recorded = this.recordLiveExecutionEvidence(this.createLiveExecutionEvidence({
          eventType: 'ORDER_SUBMITTED',
          clientIntentId,
          orderId,
          market,
          side,
          orderType,
          requested,
          order: orderResult.data
        }));
        if (!recorded) {
          this.markLiveMarketOrderUnresolved(market);
          throw new Error('order was accepted but its UUID could not be durably recorded');
        }
        if (!orderId) this.markLiveMarketOrderUnresolved(market);
      } else {
        const errorCode = orderResult?.error?.code || null;
        const recorded = this.recordLiveExecutionEvidence(this.createLiveExecutionEvidence({
          eventType: 'ORDER_REJECTED',
          clientIntentId,
          market,
          side,
          orderType,
          requested,
          error: orderResult?.error?.message || 'order response did not confirm acceptance',
          errorCode
        }));
        if (!recorded || !isDefinitiveLiveOrderRejection({ eventType: 'ORDER_REJECTED', errorCode })) {
          this.markLiveMarketOrderUnresolved(market);
        }
      }
      return orderResult;
    } catch (error) {
      this.recordLiveExecutionEvidence(this.createLiveExecutionEvidence({
        eventType: 'ORDER_POST_AMBIGUOUS',
        clientIntentId,
        market,
        side,
        orderType,
        requested,
        error: error.message
      }));
      this.markLiveMarketOrderUnresolved(market);
      throw error;
    }
  }

  async waitForLiveOrderFill(market, orderId, timeoutMs, intervalMs) {
    try {
      return await this.owner.upbit.waitForOrderFill(orderId, timeoutMs, intervalMs, { priority: 'risk' });
    } catch (error) {
      this.markLiveMarketOrderUnresolved(market);
      throw error;
    }
  }

  /**
   * 실전 모드: 거래소 실제 잔고와 내부 상태 동기화
   * 주문 후 실제 체결 결과와 내부 포지션 상태 불일치 방지
   * 상태를 확인하지 못하면 false를 반환하며 caller는 분석·신규 판단을 건너뛴다.
   */
  async syncWithExchange(options = {}) {
    if (this.owner.dryRun) return true; // 모의투자는 동기화 불필요

    if (this._exchangeSyncPromise) return this._exchangeSyncPromise;
    const syncPromise = this.performExchangeSync(options);
    this._exchangeSyncPromise = syncPromise;
    try {
      return await syncPromise;
    } finally {
      if (this._exchangeSyncPromise === syncPromise) this._exchangeSyncPromise = null;
    }
  }

  hasUnresolvedLiveOrderState() {
    return [
      this._liveOrderStateUnknownMarkets,
      this._livePendingOrderMarkets,
      this._liveEvidenceBlockedMarkets
    ].some(markets => (markets?.size || 0) > 0) ||
      (this._liveUnresolvedOrderIds?.size || 0) > 0 ||
      (this._liveUnresolvedOrderIntents?.size || 0) > 0;
  }

  async persistLiveOrderReadback({
    lookupValue,
    lookupByIdentifier = false,
    observedOrder = null,
    orderId = null,
    clientIntentId = null,
    market = null,
    side = null,
    orderType = null,
    request = null
  } = {}) {
    const order = observedOrder || (typeof this.owner.upbit.getOrder === 'function'
      ? await this.owner.upbit.getOrder(lookupValue, { identifier: lookupByIdentifier, priority: 'risk' })
      : null);
    if (!order) throw new Error('exchange order readback is unavailable');
    if (!order || typeof order.uuid !== 'string' || !order.uuid ||
      (orderId && order.uuid !== orderId) ||
      (market && order.market && order.market !== market) ||
      (side && order.side && order.side !== side) ||
      (lookupByIdentifier && order.identifier && order.identifier !== clientIntentId)) {
      throw new Error('exchange order readback does not match the durable order identity');
    }

    const resolvedOrderId = order.uuid;
    const resolvedMarket = market || order.market;
    const resolvedSide = side || order.side;
    const resolvedOrderType = orderType || order.ord_type;
    if (lookupByIdentifier) {
      const submission = this.createLiveExecutionEvidence({
        eventType: 'ORDER_SUBMITTED',
        clientIntentId,
        orderId: resolvedOrderId,
        market: resolvedMarket,
        side: resolvedSide,
        orderType: resolvedOrderType,
        requested: request,
        order
      });
      if (!this.recordLiveExecutionEvidence(submission)) {
        throw new Error('could not persist identifier-based order resolution');
      }
    }

    const stateEvent = this.createLiveExecutionEvidence({
      eventType: 'ORDER_STATE_OBSERVED',
      clientIntentId,
      orderId: resolvedOrderId,
      market: resolvedMarket,
      side: resolvedSide,
      orderType: resolvedOrderType,
      order
    });
    if (!this.recordLiveExecutionEvidence(stateEvent)) {
      throw new Error('could not persist exchange order readback');
    }

    const hasObservedNumber = value => value !== null && value !== undefined &&
      !(typeof value === 'string' && value.trim() === '') && Number.isFinite(Number(value));
    const executedVolume = hasObservedNumber(order.executed_volume) ? Number(order.executed_volume) : null;
    const remainingVolume = hasObservedNumber(order.remaining_volume) ? Number(order.remaining_volume) : null;
    const averagePrice = hasObservedNumber(order.avg_price) ? Number(order.avg_price) : null;
    const paidFee = hasObservedNumber(order.paid_fee) ? Number(order.paid_fee) : null;
    const completeFillAccounting = executedVolume !== null && executedVolume > 0 &&
      remainingVolume !== null && remainingVolume >= 0 &&
      averagePrice !== null && averagePrice > 0 &&
      paidFee !== null && paidFee >= 0;
    if (completeFillAccounting) {
      const terminalFill = order.state === 'done' && remainingVolume === 0;
      const fillEvent = this.createLiveExecutionEvidence({
        eventType: terminalFill ? 'FILL_OBSERVED' : 'FILL_PARTIAL',
        clientIntentId,
        orderId: resolvedOrderId,
        market: resolvedMarket,
        side: resolvedSide,
        orderType: resolvedOrderType,
        order,
        fillResult: {
          filled: terminalFill || executedVolume > 0,
          partial: !terminalFill,
          error: terminalFill ? null : `exchange order state: ${order.state || 'unknown'}`
        }
      });
      if (!this.recordLiveExecutionEvidence(fillEvent)) {
        throw new Error('could not persist observed exchange fill');
      }
    } else if (['cancel', 'done'].includes(order.state) && executedVolume === 0) {
      const notFilledEvent = this.createLiveExecutionEvidence({
        eventType: 'FILL_NOT_OBSERVED',
        clientIntentId,
        orderId: resolvedOrderId,
        market: resolvedMarket,
        side: resolvedSide,
        orderType: resolvedOrderType,
        order,
        fillResult: { filled: false, error: 'terminal exchange order has zero executed volume' }
      });
      if (!this.recordLiveExecutionEvidence(notFilledEvent)) {
        throw new Error('could not persist terminal zero-fill exchange state');
      }
    }
    return resolvedOrderId;
  }

  async resolveUnresolvedLiveOrders() {
    const inspection = inspectLiveExecutionEvidenceFile(this.liveExecutionEvidenceFile);
    const reconciliation = inspection.reconciliation;
    if (!inspection.available || !reconciliation) {
      if (inspection.blockingReasons.length > 0) {
        this.liveExecutionEvidenceDataError = `live execution evidence cannot be read: ${inspection.blockingReasons.join('; ')}`;
      }
      return { complete: inspection.blockingReasons.length === 0 };
    }

    let complete = true;
    for (const unresolved of reconciliation.unresolvedSubmittedOrders || []) {
      try {
        await this.persistLiveOrderReadback({
          lookupValue: unresolved.orderId,
          orderId: unresolved.orderId,
          clientIntentId: unresolved.clientIntentId,
          market: unresolved.market,
          side: unresolved.side,
          orderType: unresolved.orderType,
          request: unresolved.request
        });
      } catch (error) {
        if (unresolved.market) this._liveOrderStateUnknownMarkets.add(unresolved.market);
        else complete = false;
        console.error(`  ❌ [${unresolved.market || unresolved.orderId}] 주문 ${unresolved.orderId} 복구 확인 실패: ${error.message}`);
      }
    }

    for (const intent of reconciliation.unresolvedOrderIntents || []) {
      if (!intent.clientIntentId) {
        complete = false;
        continue;
      }
      try {
        await this.persistLiveOrderReadback({
          lookupValue: intent.clientIntentId,
          lookupByIdentifier: true,
          clientIntentId: intent.clientIntentId,
          market: intent.market,
          side: intent.side,
          orderType: intent.orderType,
          request: intent.request
        });
      } catch (error) {
        this._liveOrderStateUnknownMarkets.add(intent.market);
        if (!intent.market) complete = false;
        console.error(`  ❌ [${intent.market}] 주문 intent ${intent.clientIntentId} 복구 확인 실패: ${error.message}`);
      }
    }
    return { complete };
  }

  refreshLiveEvidenceRecoveryState({ checkedMarkets = new Set(), orderReadUnknownMarkets = new Set(), orderPendingMarkets = new Set() } = {}) {
    const inspection = inspectLiveExecutionEvidenceFile(this.liveExecutionEvidenceFile);
    this.owner.liveExecutionEvidenceStartup = inspection;
    this.liveOrderIntentEvidenceIndex = inspection.orderIntentEvidenceIndex || null;
    const reconciliation = inspection.reconciliation;
    if (!reconciliation) return;

    this._liveUnresolvedOrderIds = new Map((reconciliation.unresolvedSubmittedOrders || [])
      .map(order => [order.orderId, order]));
    this._liveUnresolvedOrderIntents = new Map((reconciliation.unresolvedOrderIntents || [])
      .map((intent, index) => [intent.clientIntentId || `legacy:${intent.market || 'unknown'}:${intent.createdAt || index}`, intent]));
    const unresolvedMarkets = new Set([
      ...[...this._liveUnresolvedOrderIds.values()].map(order => order.market),
      ...[...this._liveUnresolvedOrderIntents.values()].map(intent => intent.market)
    ].filter(Boolean));
    const previousBlockedMarkets = [...this._liveEvidenceBlockedMarkets];
    this._liveEvidenceBlockedMarkets = unresolvedMarkets;
    for (const market of previousBlockedMarkets) {
      if (!unresolvedMarkets.has(market) && checkedMarkets.has(market) &&
        !orderReadUnknownMarkets.has(market) && !orderPendingMarkets.has(market)) {
        this._liveOrderStateUnknownMarkets.delete(market);
        this._livePendingOrderMarkets.delete(market);
      }
    }
    for (const market of unresolvedMarkets) {
      this._liveRecoveredManagedMarkets.add(market);
      this._liveOrderStateUnknownMarkets.add(market);
      this._livePendingOrderMarkets.add(market);
    }
    const fatalBlocks = inspection.blockingReasons.filter(reason =>
      !reason.startsWith('unresolved submitted orders:') && !reason.startsWith('unresolved order intents:'));
    if (fatalBlocks.length > 0) {
      this.liveExecutionEvidenceDataError = `startup safety block: ${fatalBlocks.join('; ')}`;
    } else if (typeof this.liveExecutionEvidenceDataError === 'string' &&
      this.liveExecutionEvidenceDataError.startsWith('startup safety block:')) {
      this.liveExecutionEvidenceDataError = null;
    }
  }

  async performExchangeSync({ cancelStaleEngineOrders = !this.owner.liveManualPrepareOnBoot } = {}) {
    const fullManagedMarketSet = this.owner.getLiveManagedMarkets();
    const scopedMarkets = new Set([
      ...this._liveEvidenceBlockedMarkets,
      ...this._livePendingOrderMarkets,
      ...this._liveOrderStateUnknownMarkets
    ]);
    const partialMarketRefresh = this._liveExchangeStateKnown === true && scopedMarkets.size > 0 &&
      Date.now() - (this._lastSyncTime || 0) < 10 * 60 * 1000;
    const orderMarketsToRefresh = partialMarketRefresh
      ? [...new Set([...scopedMarkets, ...this._manualOrderReconciliationMarkets])]
      : fullManagedMarketSet;
    this._liveExchangeStateKnown = false;
    this._liveAccountStateKnown = false;
    if (!partialMarketRefresh) {
      this._liveVerifiedOrderMarkets.clear();
      this._liveOrderStateUnknownMarkets = new Set(fullManagedMarketSet);
      this._livePendingOrderMarkets = new Set();
    }

    try {
      console.log(`\n🔄 거래소 잔고 동기화 중...`);

      // Resolve UUIDs persisted by earlier process instances before reading
      // the open-order list. UUID-less intents remain ambiguous and are scoped
      // to their market until a human can resolve the exchange-side identity.
      const evidenceRecovery = await this.resolveUnresolvedLiveOrders();

      // Read open orders first, then read balances so a fill that occurs while
      // the order list is being checked is reflected in the recovered account.
      const pendingOrderStatus = await this.cleanupPendingOrders({
        managedMarkets: orderMarketsToRefresh,
        preserveUntouchedMarkets: partialMarketRefresh,
        cancelStaleEngineOrders
      });
      const accounts = await this.owner.upbit.getAccounts({ priority: 'risk' });
      if (!Array.isArray(accounts)) throw new Error('거래소 계좌 응답이 올바르지 않습니다.');
      const exchangeHoldings = new Map();
      const isFiniteNonnegativeField = value =>
        (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) &&
        Number.isFinite(Number(value)) && Number(value) >= 0;

      // 거래소 실제 보유량 수집
      for (const acc of accounts) {
        if (!acc || typeof acc.currency !== 'string' || !acc.currency.trim() ||
          !isFiniteNonnegativeField(acc.balance) || !isFiniteNonnegativeField(acc.locked)) {
          this._liveAccountStateKnown = false;
          console.error('  ❌ 거래소 계좌 응답에 통화 또는 잔고 값이 잘못된 행이 있습니다.');
          return false;
        }
        if (acc.currency === 'KRW') continue;

        const balance = Number(acc.balance);
        const locked = Number(acc.locked);
        const totalBalance = balance + locked;

        if (totalBalance > 0) {
          const market = `KRW-${acc.currency}`;
          exchangeHoldings.set(market, {
            balance: totalBalance,
            avgPrice: Number(acc.avg_buy_price || 0)
          });
        }
      }
      this._liveAccountStateKnown = true;

      // 내부 상태와 비교
      let syncIssues = 0;
      let positionsComplete = true;
      const targetMarketSet = new Set(this.owner.getLiveManagedMarkets());
      const reconciliationCoins = new Set(this.owner.strategies.keys());
      for (const coin of exchangeHoldings.keys()) {
        if (targetMarketSet.has(coin)) reconciliationCoins.add(coin);
      }

      for (const coin of reconciliationCoins) {
        const strategy = this.owner.getStrategy(coin);
        const exchangeData = exchangeHoldings.get(coin);
        const internalPosition = strategy.currentPosition;

        if (internalPosition && !exchangeData) {
          // 내부에는 포지션 있지만 거래소에 없음 - 이미 팔린 것
          console.log(`  ⚠️  [${coin}] 동기화: 내부 포지션 있지만 거래소에 없음 → 포지션 제거`);
          strategy.closePosition(internalPosition.entryPrice, '거래소 동기화: 보유량 없음');
          syncIssues++;
        } else if (!internalPosition && exchangeData && exchangeData.balance > 0) {
          // 거래소에는 있지만 내부에 없음 - 수동 매수 또는 동기화 누락
          const minValue = exchangeData.balance * exchangeData.avgPrice;
          if (!Number.isFinite(exchangeData.avgPrice) || exchangeData.avgPrice <= 0 || !Number.isFinite(minValue)) {
            console.error(`  ❌ [${coin}] 거래소 보유량의 평균 매입가를 확인할 수 없어 포지션을 복구하지 못했습니다.`);
            positionsComplete = false;
            continue;
          }
          console.log(`  ⚠️  [${coin}] 동기화: 거래소에 보유 중이지만 내부 포지션 없음`);
          console.log(`      보유량: ${exchangeData.balance.toFixed(8)}, 평균가: ${exchangeData.avgPrice.toLocaleString()}원`);
          // 전략 universe의 보유량은 주문 최소 금액 미만이어도 flat으로 오인하지 않도록 복구한다.
          strategy.openPosition(exchangeData.avgPrice, exchangeData.balance, 'BUY');
          const recoveredPosition = this.owner._liveRecoveredPositionStates.get(coin);
          if (strategy.currentPosition) {
            if (typeof recoveredPosition?.entryTime === 'string' && Number.isFinite(Date.parse(recoveredPosition.entryTime))) {
              strategy.currentPosition.entryTime = recoveredPosition.entryTime;
            }
          }
          console.log(`      → 포지션 복구됨${minValue < 5000 ? ' (최소 주문 금액 미만 보유)' : ''}`);
          syncIssues++;
        } else if (internalPosition && exchangeData) {
          // 둘 다 있는 경우 수량 비교
          const diff = Math.abs(internalPosition.amount - exchangeData.balance);
          const diffPercent = (diff / exchangeData.balance) * 100;

          if (diffPercent > 1) { // 1% 이상 차이나면 경고
            console.log(`  ⚠️  [${coin}] 수량 불일치: 내부 ${internalPosition.amount.toFixed(8)} vs 거래소 ${exchangeData.balance.toFixed(8)} (${diffPercent.toFixed(2)}% 차이)`);
            // 거래소 기준으로 업데이트
            strategy.currentPosition.amount = exchangeData.balance;
            syncIssues++;
          }
        }
      }

      if (!positionsComplete) {
        this._liveAccountStateKnown = false;
        return false;
      }
      this._liveAccountStateKnown = true;

      // Account reads and every managed market's open-order listing must be
      // complete before the engine can trade. UUID-level uncertainty remains
      // isolated to its market and is enforced by canExecuteLiveOrder().
      if ((!pendingOrderStatus.discoveryComplete && !partialMarketRefresh) || !evidenceRecovery.complete) return false;
      if (syncIssues === 0) {
        console.log('  ✅ 동기화 완료 - 불일치 없음');
      } else {
        console.log(`  ⚠️  동기화 완료 - ${syncIssues}건 수정됨`);
      }
      for (const market of this._liveRecoveredManagedMarkets) {
        if (!exchangeHoldings.has(market) && !this.owner.strategies.get(market)?.currentPosition) {
          this._liveRecoveredManagedMarkets.delete(market);
        }
      }
      this.refreshLiveEvidenceRecoveryState({
        checkedMarkets: pendingOrderStatus.successfullyQueriedMarkets,
        orderReadUnknownMarkets: pendingOrderStatus.unknownMarkets,
        orderPendingMarkets: pendingOrderStatus.pendingMarkets
      });
      for (const market of pendingOrderStatus.successfullyQueriedMarkets) {
        this._liveVerifiedOrderMarkets.set(market, Date.now());
      }
      for (const market of pendingOrderStatus.unknownMarkets) this._liveVerifiedOrderMarkets.delete(market);
      for (const market of pendingOrderStatus.unknownMarkets) this._liveOrderStateUnknownMarkets.add(market);
      for (const market of pendingOrderStatus.pendingMarkets) this._livePendingOrderMarkets.add(market);
      this._liveExchangeStateKnown = true;
      this._lastSyncTime = Date.now();
      if (this._startupReconciliationPending && this.owner.isRunning &&
        !this.owner._stopRequested && !this.owner._riskMonitorProtectiveOnly) {
        this._startupReconciliationPending = false;
        this.owner._entriesPaused = false;
        this.owner.stopReason = null;
      }
      return true;

    } catch (error) {
      this._liveExchangeStateKnown = false;
      console.error(`  ❌ 동기화 실패: ${error.message}`);
      return false;
    }
  }

  /**
   * 미체결 주문 정리
   */
  async cleanupPendingOrders({
    managedMarkets: requestedMarkets = null,
    preserveUntouchedMarkets = false,
    cancelStaleEngineOrders = !this.owner.liveManualPrepareOnBoot
  } = {}) {
    let complete = true;
    let discoveryComplete = true;
    const unknownMarkets = new Set();
    const pendingMarkets = new Set();
    const successfullyQueriedMarkets = new Set();
    const openOrderIds = new Set();
    const managedMarkets = Array.isArray(requestedMarkets) ? requestedMarkets : this.owner.getLiveManagedMarkets();
    if (preserveUntouchedMarkets) {
      for (const market of managedMarkets) {
        this._liveOrderStateUnknownMarkets.add(market);
        this._livePendingOrderMarkets.delete(market);
      }
    } else {
      this._liveOrderStateUnknownMarkets = new Set(this.owner.getLiveManagedMarkets());
      this._livePendingOrderMarkets = new Set();
    }
    for (const coin of managedMarkets) {
      let pendingOrders;
      try {
        pendingOrders = await this.owner.upbit.getOrders(coin, ['wait', 'watch'], { priority: 'risk' });
      } catch (error) {
        console.error(`  ❌ [${coin}] 미체결 주문 조회 실패: ${error.message}`);
        complete = false;
        discoveryComplete = false;
        unknownMarkets.add(coin);
        continue;
      }

      if (!Array.isArray(pendingOrders)) {
        console.error(`  ❌ [${coin}] 미체결 주문 응답이 올바르지 않습니다.`);
        complete = false;
        discoveryComplete = false;
        unknownMarkets.add(coin);
        continue;
      }
      this._liveOrderStateUnknownMarkets.delete(coin);
      successfullyQueriedMarkets.add(coin);
      if (pendingOrders.length === 0) continue;

      console.log(`  📋 [${coin}] 미체결 주문 ${pendingOrders.length}건 발견`);
      pendingMarkets.add(coin);
      this._livePendingOrderMarkets.add(coin);
      for (const order of pendingOrders) {
        const createdAt = Date.parse(order?.created_at);
        const uuid = typeof order?.uuid === 'string' ? order.uuid.trim() : '';
        if (!uuid || !Number.isFinite(createdAt)) {
          console.error(`    ❌ [${coin}] 미체결 주문 정보가 불완전합니다.`);
          complete = false;
          unknownMarkets.add(coin);
          continue;
        }
        openOrderIds.add(uuid);

        const orderAgeMinutes = Math.max(0, Math.floor((Date.now() - createdAt) / 60000));
        // 5분 이상 된 주문은 취소
        if (orderAgeMinutes >= 5) {
          if (!this._liveEngineOrderIds.has(uuid)) {
            console.log(`    ⚠️  ${uuid} - 오래된 미체결 주문이지만 소유권을 확인할 수 없어 취소하지 않습니다.`);
            complete = false;
            continue;
          }
          if (!cancelStaleEngineOrders) {
            console.log(`    ⏸️  ${uuid} - 수동 LIVE 프로필에서는 기존 미체결 주문을 취소하지 않습니다.`);
            complete = false;
            continue;
          }
          console.log(`    🔄 ${orderAgeMinutes}분 경과 주문 취소: ${uuid}`);
          try {
            await this.owner.upbit.cancelOrder(uuid, { priority: 'risk' });
            console.log('    ✅ 취소 요청 완료 - 취소/체결 상태를 다시 확인합니다.');
          } catch (error) {
            console.log(`    ⚠️  취소 실패: ${error.message}`);
          }
          complete = false;
        } else {
          console.log(`    ⏳ ${uuid} - ${orderAgeMinutes}분 경과 (5분 후에도 대기 중이면 소유권을 확인합니다)`);
          complete = false;
        }
      }
    }
    for (const [orderId, market] of this._liveEngineOrderMarkets) {
      if (successfullyQueriedMarkets.has(market) && !openOrderIds.has(orderId)) {
        this._liveEngineOrderMarkets.delete(orderId);
        this._liveEngineOrderIds.delete(orderId);
      }
    }
    return { complete, discoveryComplete, unknownMarkets, pendingMarkets, successfullyQueriedMarkets };
  }
}
