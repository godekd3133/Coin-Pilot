// 수동 주문 idempotency 미들웨어 — manualOrderIdempotencyStore.js에서 분리.
// 요청 정규화, in-flight dedup, DRY_RUN 트랜잭션 우산, LIVE 복구 디스패치.
// 저장소·writer lock·레코드 스키마는 manualOrderIdempotencyStore.js 소유.
import { randomUUID } from 'node:crypto';
import { isUuid } from './manualOrderIdempotencyStore.js';

export function canonicalManualRequestEndpoint(req) {
  const rawUrl = String(req?.originalUrl || req?.url || '/');
  const parsed = new URL(rawUrl, 'http://coinpilot.local');
  const query = [...parsed.searchParams.entries()].sort(([aKey, aValue], [bKey, bValue]) =>
    aKey.localeCompare(bKey) || aValue.localeCompare(bValue)
  );
  const search = new URLSearchParams(query).toString();
  return search ? `${parsed.pathname}?${search}` : parsed.pathname;
}

function pendingResponse(state = 'pending') {
  return {
    success: false,
    pending: true,
    idempotency: { status: state },
    error: {
      code: 'idempotency_pending',
      message: '요청 결과를 확인하고 있습니다. 같은 요청을 다시 보내 확인해 주세요.'
    }
  };
}

function missingKeyResponse() {
  return {
    success: false,
    pending: false,
    error: {
      code: 'idempotency_key_required',
      message: '요청 키가 없어 변경을 시작하지 않았습니다.'
    }
  };
}

function conflictResponse(pending, state) {
  return {
    success: false,
    pending,
    idempotency: { status: pending ? state : 'conflict' },
    error: {
      code: 'idempotency_key_conflict',
      message: '같은 요청 키가 다른 경로나 내용에 이미 연결되어 있습니다.'
    }
  };
}

function unknownResponse() {
  return {
    success: false,
    pending: true,
    idempotency: { status: 'unknown' },
    error: {
      code: 'idempotency_outcome_unknown',
      message: '요청 결과를 확인할 수 없습니다. 같은 요청 키와 내용을 유지해 주세요.'
    }
  };
}

function writerLockResponse(error) {
  const active = error?.code === 'MANUAL_ORDER_WRITER_LOCK_ACTIVE';
  const contended = error?.code === 'MANUAL_ORDER_WRITER_LOCK_CONTENDED';
  return {
    success: false,
    pending: false,
    error: {
      code: active || contended ? 'manual_order_writer_locked' : 'manual_order_writer_recovery_required',
      message: error?.message || '프로필 변경 권한을 확인할 수 없어 요청을 시작하지 않았습니다.',
      recoveryRequired: error?.recoveryRequired === true
    }
  };
}

const UNCERTAIN_LIVE_CODES = new Set([
  'order_submission_unknown',
  'fill_not_observed',
  'order_uuid_missing',
  'live_execution_evidence_write_failed'
]);
const IDEMPOTENCY_STATUS_HEADER = 'Idempotency-Status';
const IDEMPOTENCY_STATUSES = new Set(['completed', 'pending', 'unknown', 'conflict', 'rejected']);

function setIdempotencyStatus(res, status) {
  if (!IDEMPOTENCY_STATUSES.has(status)) return;
  if (typeof res?.setHeader === 'function') {
    res.setHeader(IDEMPOTENCY_STATUS_HEADER, status);
  } else if (typeof res?.set === 'function') {
    res.set(IDEMPOTENCY_STATUS_HEADER, status);
  }
}

function respondWithIdempotencyStatus(res, statusCode, body, idempotencyStatus) {
  setIdempotencyStatus(res, idempotencyStatus);
  return res.status(statusCode).json(body);
}

const DEFINITIVE_LIVE_NO_SUBMIT_CODES = new Set([
  'live_order_in_progress',
  'protective_only',
  'trading_paused',
  'exchange_state_unverified',
  'live_order_gate_unavailable',
  'live_execution_evidence_unavailable',
  'leg_intent_unavailable'
]);

function containsUncertainLiveOutcome(value) {
  if (Array.isArray(value)) return value.some(containsUncertainLiveOutcome);
  if (!value || typeof value !== 'object') return false;
  if (typeof value.reason === 'string' && UNCERTAIN_LIVE_CODES.has(value.reason)) return true;
  if (typeof value.code === 'string' && UNCERTAIN_LIVE_CODES.has(value.code)) return true;
  if (value.status === 'not_observed' && (value.orderId || value.exchangeState)) return true;
  return Object.values(value).some(containsUncertainLiveOutcome);
}

function hasUncertainLiveResult(mode, status, body) {
  if (mode !== 'LIVE') return false;
  if (containsUncertainLiveOutcome(body)) return true;
  if (status < 500) return false;
  return !(body?.mode === 'LIVE' && DEFINITIVE_LIVE_NO_SUBMIT_CODES.has(body.reason));
}

function requestResponsePromise(req, res, next, reservation, store, tradingSystem, transaction) {
  return new Promise(resolve => {
    let settled = false;
    const originalJson = res.json.bind(res);
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    res.once('finish', finish);
    res.json = function jsonWithIdempotency(body) {
      if (settled) return originalJson(body);
      const responseStatus = this.statusCode || 200;
      const shouldRollbackDryRun = reservation.record.mode === 'DRY_RUN' &&
        (responseStatus >= 400 || body?.success === false);
      if (shouldRollbackDryRun && transaction?.rollback) transaction.rollback();

      const finalize = async () => {
        if (hasUncertainLiveResult(reservation.record.mode, responseStatus, body)) {
          await store.markUnknown(reservation.record.recordId, 'live_order_outcome_unknown');
          return { status: 202, body: unknownResponse(), idempotencyStatus: 'unknown' };
        }
        await store.complete(reservation.record.recordId, { status: responseStatus, body });
        transaction?.commit?.();
        return { status: responseStatus, body, idempotencyStatus: 'completed' };
      };

      finalize()
        .then(result => {
          setIdempotencyStatus(this, result.idempotencyStatus);
          originalJson.call(this.status(result.status), result.body);
          if (res.destroyed) finish();
        })
        .catch(async () => {
          if (reservation.record.mode === 'DRY_RUN') transaction?.rollback?.();
          try {
            await store.markUnknown(reservation.record.recordId, 'durable_commit_failed');
          } catch {
            // Keep the reservation pending in memory/disk and fail closed.
          }
          setIdempotencyStatus(this, 'unknown');
          originalJson.call(this.status(202), unknownResponse());
          if (res.destroyed) finish();
        })
      return this;
    };
    next();
  });
}

/** Middleware factory shared by manual trade and virtual-wallet routes only. */
export function createManualOrderIdempotencyMiddleware(server, {
  paths,
  liveReconciliationPaths,
  liveMultiLegPaths,
  recoverLiveRequest
} = {}) {
  const supportedPaths = paths instanceof Set ? paths : new Set(paths || []);
  const recoverablePaths = liveReconciliationPaths instanceof Set
    ? liveReconciliationPaths
    : new Set(liveReconciliationPaths || []);
  const multiLegPaths = liveMultiLegPaths instanceof Set
    ? liveMultiLegPaths
    : new Set(liveMultiLegPaths || []);
  const inFlightRecordIds = new Set();
  return async function manualOrderIdempotencyMiddleware(req, res, next) {
    if (req.method !== 'POST' || !supportedPaths.has(req.path)) return next();

    const tradingSystem = server?.tradingSystem;
    if (tradingSystem?.readOnlyObserver === true) {
      return respondWithIdempotencyStatus(res, 403, {
        success: false,
        pending: false,
        readOnlyObserver: true,
        error: {
          code: 'read_only_observer',
          message: '읽기 전용 연결에서는 계정 파일을 변경할 수 없습니다.'
        }
      }, 'rejected');
    }

    const idempotencyKey = String(req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'] || '').trim();
    if (!idempotencyKey) return respondWithIdempotencyStatus(res, 428, missingKeyResponse(), 'rejected');
    if (idempotencyKey.length > 256) {
      return respondWithIdempotencyStatus(res, 400, {
        success: false,
        pending: false,
        error: { code: 'idempotency_key_invalid', message: '요청 키 형식이 올바르지 않습니다.' }
      }, 'rejected');
    }

    const store = server?.manualOrderIdempotencyStore;
    if (!store || typeof store.reserve !== 'function') {
      return respondWithIdempotencyStatus(res, 503, {
        ...pendingResponse('unavailable'),
        error: { code: 'idempotency_store_unavailable', message: '요청을 안전하게 기록할 수 없어 변경을 시작하지 않았습니다.' }
      }, 'unknown');
    }

    const mode = tradingSystem?.dryRun === true ? 'DRY_RUN' : 'LIVE';
    const needsLiveIntent = recoverablePaths.has(req.path) || multiLegPaths.has(req.path);
    const clientIntentId = mode === 'LIVE' && needsLiveIntent ? randomUUID() : null;
    let reservation;
    try {
      reservation = await store.reserve({
        profileId: server?.auth?.writeProfileId || server?.manualOrderProfileId || 'operator',
        idempotencyKey,
        method: req.method,
        endpoint: canonicalManualRequestEndpoint(req),
        body: req.body ?? null,
        mode,
        clientIntentId
      });
    } catch (error) {
      if (String(error?.code || '').startsWith('MANUAL_ORDER_WRITER_LOCK_')) {
        return respondWithIdempotencyStatus(res, 503, writerLockResponse(error), 'rejected');
      }
      return respondWithIdempotencyStatus(res, 503, unknownResponse(), 'unknown');
    }

    if (reservation.kind === 'conflict') {
      return respondWithIdempotencyStatus(res, 409, conflictResponse(reservation.pending, reservation.state), 'conflict');
    }
    if (reservation.kind === 'replay') {
      return respondWithIdempotencyStatus(res, reservation.responseStatus, reservation.responseBody, 'completed');
    }
    if (reservation.kind === 'pending') {
      if (inFlightRecordIds.has(reservation.record.recordId)) {
        return respondWithIdempotencyStatus(res, 202, pendingResponse('pending'), 'pending');
      }
      const canReconcile = reservation.record.mode === 'LIVE' && mode === 'LIVE' &&
        needsLiveIntent && isUuid(reservation.record.clientIntentId) &&
        typeof recoverLiveRequest === 'function' && typeof store.completeRecovered === 'function';
      if (canReconcile) {
        try {
          const recovered = await recoverLiveRequest({ req, record: reservation.record, tradingSystem });
          if (recovered && Number.isInteger(recovered.status) && recovered.body !== undefined) {
            await store.completeRecovered(reservation.record.recordId, recovered);
            return respondWithIdempotencyStatus(res, recovered.status, recovered.body, 'completed');
          }
        } catch {
          // Readback failures remain unresolved. The route must never be replayed.
        }
        try {
          await store.markUnknown(reservation.record.recordId, 'live_order_reconciliation_incomplete');
        } catch {
          // Preserve the pending reservation when the unknown-state write fails.
        }
        return respondWithIdempotencyStatus(res, 202, unknownResponse(), 'unknown');
      }
      if (reservation.record.mode === 'LIVE' && needsLiveIntent && mode === 'LIVE') {
        try {
          await store.markUnknown(reservation.record.recordId, 'live_order_intent_unavailable');
        } catch {
          // Keep the durable reservation unresolved when it cannot be updated.
        }
        return respondWithIdempotencyStatus(res, 202, unknownResponse(), 'unknown');
      }
      const status = reservation.state === 'unknown' ? 'unknown' : 'pending';
      return respondWithIdempotencyStatus(res, 202, pendingResponse(reservation.state), status);
    }
    if (reservation.kind !== 'reserved' || reservation.record.mode !== mode) {
      return respondWithIdempotencyStatus(res, 202, unknownResponse(), 'unknown');
    }
    if (mode === 'LIVE' && needsLiveIntent) {
      if (!isUuid(reservation.record.clientIntentId)) {
        try {
          await store.markUnknown(reservation.record.recordId, 'live_order_intent_unavailable');
        } catch {
          // Do not allow an unlinked manual request to reach an exchange POST.
        }
        return respondWithIdempotencyStatus(res, 202, unknownResponse(), 'unknown');
      }
      if (multiLegPaths.has(req.path)) {
        // A multi-leg plan binds a separate exchange identifier per leg before
        // dispatch. The request-level id only anchors the journal record; it
        // must never be reused as an order identifier.
        req.manualOrderReservation = {
          recordId: reservation.record.recordId,
          clientIntentId: reservation.record.clientIntentId
        };
      } else {
        req.manualOrderClientIntentId = reservation.record.clientIntentId;
      }
    }

    const execute = transaction => requestResponsePromise(req, res, next, reservation, store, tradingSystem, transaction);
    if (reservation.record.mode === 'DRY_RUN') {
      if (typeof tradingSystem?.withManualPortfolioTransaction !== 'function') {
        try {
          await store.markUnknown(reservation.record.recordId, 'portfolio_lock_unavailable');
        } catch {
          // The pending reservation remains durable.
        }
        return respondWithIdempotencyStatus(res, 202, unknownResponse(), 'unknown');
      }
      try {
        return await tradingSystem.withManualPortfolioTransaction(transaction => {
          inFlightRecordIds.add(reservation.record.recordId);
          return execute(transaction).finally(() => inFlightRecordIds.delete(reservation.record.recordId));
        });
      } catch {
        try {
          await store.markUnknown(reservation.record.recordId, 'portfolio_transaction_failed');
        } catch {
          // Keep the durable reservation unresolved when rollback persistence also fails.
        }
        if (!res.headersSent) return respondWithIdempotencyStatus(res, 202, unknownResponse(), 'unknown');
        return undefined;
      }
    }
    inFlightRecordIds.add(reservation.record.recordId);
    try {
      return await execute(null);
    } finally {
      inFlightRecordIds.delete(reservation.record.recordId);
    }
  };
}
