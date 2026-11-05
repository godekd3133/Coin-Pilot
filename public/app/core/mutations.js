// Protected manual mutations (orders and virtual-wallet changes).
//
// Contract with the server's manualOrderIdempotencyMiddleware:
//  1. Before any network I/O, persist {endpoint, exact body string, UUIDv4 key}
//     in localStorage. If that write fails, nothing is sent.
//  2. Send POST /api<endpoint> with the same body and `Idempotency-Key`.
//  3. Only a definitive outcome (2xx, 4xx, or 5xx with Idempotency-Status:
//     completed) clears the record. Timeouts, 202/pending, conflicts, missing
//     key, unparsable or unknown 5xx responses keep it, and every new mutation
//     stays locked until the same request is re-sent (same key + same body)
//     and resolves. Conflict / key-missing require operator resolution.
//  4. A Web Lock serialises submit/retry across tabs when available.

import { apiUrl, scopedStorageKey } from './base.js';
// Scoped per deployment prefix so an unsent LIVE order is never replayed by the paper page.
export const PENDING_MUTATION_STORAGE_KEY = scopedStorageKey('coinpilot.pending-mutation.v1');
export const PENDING_MUTATION_LOCK_NAME = scopedStorageKey('coinpilot.pending-mutation.v1');
export const PENDING_MUTATION_ENDPOINTS = new Set([
  '/trade/execute-bundle',
  '/trade/execute',
  '/trade/buy',
  '/trade/sell',
  '/trade/smart-buy',
  '/trade/smart-sell',
  '/virtual/deposit',
  '/virtual/withdraw',
  '/virtual/reset'
]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createPendingMutationClient({ storage, createKey, sendRequest, onChange = () => {}, locks = null } = {}) {
  let isSending = false;
  let storageError = null;
  let volatileIntent = null;

  function readStoredIntent() {
    if (!storage || typeof storage.getItem !== 'function') {
      return { intent: volatileIntent, error: 'unavailable' };
    }
    try {
      const raw = storage.getItem(PENDING_MUTATION_STORAGE_KEY);
      if (raw === null || raw === undefined) {
        if (!storageError) volatileIntent = null;
        return { intent: null, error: storageError };
      }
      const intent = JSON.parse(raw);
      const valid = intent?.version === 1
        && typeof intent.idempotencyKey === 'string'
        && UUID_V4.test(intent.idempotencyKey)
        && PENDING_MUTATION_ENDPOINTS.has(intent.endpoint)
        && typeof intent.body === 'string';
      if (!valid) return { intent: volatileIntent, error: 'invalid' };
      volatileIntent = intent;
      return { intent, error: storageError };
    } catch {
      return { intent: volatileIntent, error: 'unavailable' };
    }
  }

  function snapshot() {
    const { intent, error } = readStoredIntent();
    return {
      intent: intent ? { ...intent } : null,
      sending: isSending,
      storageError: error,
      locked: isSending || Boolean(intent) || Boolean(error)
    };
  }

  function publish() {
    onChange(snapshot());
  }

  function writeIntent(intent) {
    if (!storage || typeof storage.setItem !== 'function') {
      storageError = 'unavailable';
      return false;
    }
    try {
      storage.setItem(PENDING_MUTATION_STORAGE_KEY, JSON.stringify(intent));
      volatileIntent = intent;
      storageError = null;
      return true;
    } catch {
      storageError = 'write_failed';
      return false;
    }
  }

  function clearIntent() {
    if (!storage || typeof storage.removeItem !== 'function') {
      storageError = 'clear_failed';
      return false;
    }
    try {
      storage.removeItem(PENDING_MUTATION_STORAGE_KEY);
      volatileIntent = null;
      storageError = null;
      return true;
    } catch {
      storageError = 'clear_failed';
      return false;
    }
  }

  async function withMutationLock(callback) {
    if (locks && typeof locks.request === 'function') {
      return locks.request(PENDING_MUTATION_LOCK_NAME, { mode: 'exclusive' }, callback);
    }
    return callback();
  }

  function blockedResult(intent, message = '저장된 요청 결과 확인 필요.') {
    return { kind: 'blocked', intent: intent || null, message };
  }

  function lockedTerminal(status, body, sendingIntent, message) {
    publish();
    return { kind: 'terminal-locked', status, body, intent: snapshot().intent || sendingIntent, message };
  }

  async function transmit(intent) {
    const sendingIntent = { ...intent, phase: 'sending', lastOutcome: 'sending' };
    writeIntent(sendingIntent);
    publish();

    let response;
    try {
      response = await sendRequest({ endpoint: intent.endpoint, idempotencyKey: intent.idempotencyKey, body: intent.body });
    } catch (error) {
      const pendingIntent = {
        ...intent,
        phase: 'pending',
        lastOutcome: 'unknown',
        lastStatus: null,
        lastMessage: error?.name === 'AbortError'
          ? '서버 응답이 늦어 요청 결과를 확인할 수 없습니다.'
          : '연결이 끊겨 요청 결과를 확인할 수 없습니다.'
      };
      writeIntent(pendingIntent);
      publish();
      return { kind: 'pending', intent: pendingIntent, message: pendingIntent.lastMessage };
    }

    const status = Number(response?.status);
    const body = response?.body;
    const parsed = response?.parsed === true && body !== null && typeof body === 'object';
    const idempotencyStatus = String(response?.idempotencyStatus || '').trim().toLowerCase();
    const errorCode = typeof body?.error?.code === 'string' ? body.error.code : '';
    let outcome;
    let message;

    if (!Number.isInteger(status) || !parsed) {
      outcome = 'unknown';
      message = '서버 응답을 확인할 수 없어 요청 결과를 보류했습니다.';
    } else if (idempotencyStatus === 'conflict' || errorCode === 'idempotency_key_conflict' || (status === 409 && idempotencyStatus !== 'completed')) {
      outcome = 'conflict';
      message = '서버 기록과 저장된 요청이 일치하지 않습니다. 새 변경을 잠갔습니다.';
    } else if (status === 428 || errorCode === 'idempotency_key_required') {
      outcome = 'key_missing';
      message = '서버가 요청 키를 확인하지 못했습니다. 새 변경을 잠갔습니다.';
    } else if (idempotencyStatus === 'unknown' || (status >= 500 && idempotencyStatus !== 'completed')) {
      outcome = 'unknown';
      message = '서버가 요청 결과를 확인하지 못해 변경을 잠갔습니다.';
    } else if (status === 202 || body.pending === true || idempotencyStatus === 'pending') {
      outcome = 'processing';
      message = '서버가 요청을 처리 중입니다. 같은 요청을 다시 보내 확인할 수 있습니다.';
    } else if (status >= 200 && status < 300) {
      if (!clearIntent()) return lockedTerminal(status, body, sendingIntent, '요청은 처리됐지만 안전 기록 정리 실패 · 같은 요청으로 결과 재확인 필요.');
      publish();
      return { kind: 'terminal', status, body, intent };
    } else if (status >= 400 && status < 500) {
      if (!clearIntent()) return lockedTerminal(status, body, sendingIntent, '서버가 요청을 거절했지만 안전 기록을 정리하지 못했습니다.');
      publish();
      return { kind: 'rejected', status, body, intent };
    } else if (status >= 500 && idempotencyStatus === 'completed') {
      if (!clearIntent()) return lockedTerminal(status, body, sendingIntent, '요청 결과는 기록됐지만 안전 기록을 정리하지 못했습니다.');
      publish();
      return { kind: 'rejected', status, body, intent };
    } else {
      outcome = 'unknown';
      message = '예상하지 못한 서버 응답이라 요청 결과를 보류했습니다.';
    }

    const pendingIntent = {
      ...intent,
      phase: 'pending',
      lastOutcome: outcome,
      lastStatus: Number.isInteger(status) ? status : null,
      lastMessage: message
    };
    writeIntent(pendingIntent);
    publish();
    return { kind: 'pending', status: Number.isInteger(status) ? status : null, body: parsed ? body : null, intent: pendingIntent, message };
  }

  async function submit(endpoint, bodyValue) {
    if (isSending) return blockedResult(snapshot().intent, '다른 요청을 처리 중입니다.');
    isSending = true;
    publish();
    try {
      return await withMutationLock(async () => {
        const current = snapshot();
        if (current.storageError) return { kind: 'storage-error', message: '요청을 안전하게 저장할 수 없어 전송하지 않았습니다.' };
        if (current.intent) return blockedResult(current.intent);
        if (!PENDING_MUTATION_ENDPOINTS.has(endpoint)) {
          return { kind: 'invalid', message: '보호되지 않은 변경 경로입니다.' };
        }

        let body;
        try {
          body = typeof bodyValue === 'string' ? bodyValue : JSON.stringify(bodyValue);
        } catch {
          return { kind: 'invalid', message: '요청 내용을 직렬화하지 못했습니다.' };
        }
        if (typeof body !== 'string') return { kind: 'invalid', message: '요청 내용이 비어 있습니다.' };

        let idempotencyKey;
        try {
          idempotencyKey = createKey();
        } catch {
          return { kind: 'storage-error', message: '안전한 요청 키를 만들 수 없어 전송하지 않았습니다.' };
        }
        if (typeof idempotencyKey !== 'string' || !UUID_V4.test(idempotencyKey)) {
          return { kind: 'storage-error', message: '유효한 요청 키를 만들지 못해 전송하지 않았습니다.' };
        }
        const intent = {
          version: 1,
          idempotencyKey,
          endpoint,
          body,
          phase: 'pending',
          lastOutcome: 'new',
          lastStatus: null,
          lastMessage: null,
          createdAt: Date.now()
        };
        if (!writeIntent(intent)) {
          publish();
          return { kind: 'storage-error', message: '요청 기록을 저장하지 못해 전송하지 않았습니다.' };
        }
        publish();
        return transmit(intent);
      });
    } catch {
      return { kind: 'storage-error', message: '요청 잠금을 확인하지 못해 변경 요청을 보내지 않았습니다.' };
    } finally {
      isSending = false;
      publish();
    }
  }

  async function retry() {
    if (isSending) return blockedResult(snapshot().intent, '같은 요청을 확인 중입니다.');
    isSending = true;
    publish();
    try {
      return await withMutationLock(async () => {
        const current = snapshot();
        if (current.storageError && !current.intent) {
          return { kind: 'storage-error', message: '저장된 요청 기록을 읽을 수 없어 재확인하지 못했습니다.' };
        }
        if (!current.intent) return { kind: 'empty', message: '확인할 요청이 없습니다.' };
        if (['conflict', 'key_missing'].includes(current.intent.lastOutcome)) {
          return { kind: 'resolution-required', intent: current.intent, message: current.intent.lastMessage };
        }
        return transmit(current.intent);
      });
    } catch {
      return { kind: 'pending', intent: snapshot().intent, message: '요청 잠금을 확인하지 못했습니다. 저장된 같은 요청은 보존했습니다.' };
    } finally {
      isSending = false;
      publish();
    }
  }

  function refresh() {
    publish();
    return snapshot();
  }

  return { submit, retry, snapshot, refresh, storageKey: PENDING_MUTATION_STORAGE_KEY };
}

export function createManualMutationKey(cryptoApi = globalThis.crypto) {
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues !== 'function') throw new Error('Secure random UUID unavailable');
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Builds the transport for protected mutations. `isAllowed(path)` is the
 * client scope policy; a refused request is answered locally with a 403
 * terminal outcome so nothing reaches the network.
 */
export function createManualMutationTransport({ fetchImpl, isAllowed = () => true, deniedMessage = () => '', timeoutMs = 12_000, setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout }) {
  return async function sendManualMutationRequest({ endpoint, idempotencyKey, body }) {
    const apiPath = endpoint.startsWith('/api/') ? endpoint.slice(4) : endpoint;
    if (!isAllowed(apiPath)) {
      return { status: 403, body: { success: false, error: deniedMessage() }, parsed: true, idempotencyStatus: null };
    }
    const controller = new AbortController();
    const timeoutId = setTimer(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(apiUrl(apiPath), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body,
        signal: controller.signal
      });
      const idempotencyStatus = response.headers?.get?.('Idempotency-Status') || null;
      try {
        return { status: response.status, body: await response.json(), parsed: true, idempotencyStatus };
      } catch {
        return { status: response.status, body: null, parsed: false, idempotencyStatus };
      }
    } finally {
      clearTimer(timeoutId);
    }
  };
}

export function mutationActionName(intent) {
  return intent?.endpoint?.startsWith('/virtual/') ? '가상 지갑 변경' : '주문';
}

/** Banner copy for the shared pending-mutation lock. */
export function pendingMutationPresentation(snapshot, { online = true } = {}) {
  const intent = snapshot?.intent;
  const visible = Boolean(snapshot?.locked || snapshot?.storageError);
  if (!visible) return { visible: false };
  let title = '요청 결과 확인 필요';
  let copy = '요청이 처리됐을 수 있어 새 주문과 가상 지갑 변경을 잠갔습니다.';
  const name = mutationActionName(intent);
  if (snapshot.storageError === 'invalid') {
    title = '저장된 요청 기록을 읽을 수 없습니다';
    copy = '요청 기록 확인 불가 · 새 주문과 가상 지갑 변경 차단. 앱 데이터를 지우지 말고 기존 요청 결과 확인 필요.';
  } else if (snapshot.storageError === 'unavailable' && !intent) {
    title = '요청 기록 저장소를 사용할 수 없습니다';
    copy = '안전 기록 읽기/저장 실패 · 변경 요청 미전송. 브라우저 저장 공간 확인 필요.';
  } else if (snapshot.storageError === 'write_failed' && !intent) {
    title = '요청을 저장하지 못했습니다';
    copy = '안전 기록 저장 실패 · 요청 미전송. 브라우저 저장 공간 확인 후 재시도.';
  } else if (snapshot.sending) {
    title = `${name} 전송 중`;
    copy = '서버 응답을 기다리는 동안 다른 주문과 가상 지갑 변경을 잠갔습니다.';
  } else if (intent?.lastOutcome === 'processing') {
    title = `${name} 처리 중`;
    copy = '서버가 요청을 처리 중입니다. 새 변경은 잠겨 있습니다. 아래 버튼은 저장된 같은 키와 내용으로 결과를 다시 확인합니다.';
  } else if (intent?.lastOutcome === 'conflict') {
    title = '서버 기록과 저장된 요청이 다릅니다';
    copy = '서버가 다른 요청 내용으로 이 키를 사용 중이라고 답했습니다. 새 주문과 지갑 변경은 잠겨 있습니다. 운영자 확인이 필요합니다.';
  } else if (intent?.lastOutcome === 'key_missing') {
    title = '서버에서 요청 키를 확인하지 못했습니다';
    copy = '키가 누락된 요청으로 거절되었습니다. 서버 설정을 확인할 때까지 새 주문과 지갑 변경을 잠갔습니다.';
  } else if (snapshot.storageError === 'clear_failed') {
    title = `${name} 결과는 받았지만 요청 잠금을 해제하지 못했습니다`;
    copy = '같은 요청을 다시 확인하면 서버의 저장된 결과를 재생하고 잠금을 정리할 수 있습니다.';
  } else if (intent?.lastOutcome === 'unknown') {
    title = `${name} 결과 확인 필요`;
    copy = '요청이 처리됐을 수 있습니다. 새 주문과 지갑 변경은 잠겨 있으며 아래 작업은 같은 키와 내용으로만 재전송합니다.';
  }
  const resolutionRequired = ['conflict', 'key_missing'].includes(intent?.lastOutcome);
  return {
    visible: true,
    title,
    copy,
    retryVisible: Boolean(intent) && !resolutionRequired,
    retryDisabled: !intent || snapshot.sending || online === false,
    retryLabel: snapshot.sending ? '요청 중…' : online === false ? '연결 후 다시 확인' : '같은 요청 결과 다시 확인',
    resolutionRequired
  };
}

/** Human message for a non-terminal or rejected mutation outcome. */
export function protectedMutationError(outcome, fallback, { toUserText = value => value, symbolOf = value => value } = {}) {
  const body = outcome?.body;
  if (body?.code === 'MARKET_QUOTE_STALE' && Array.isArray(body.markets) && body.markets.length > 0) {
    const details = body.markets.map(item => {
      const market = symbolOf(item.market);
      const ageSeconds = Number(item.ageMs) / 1000;
      const maximumSeconds = Number(item.maximumAgeMs) / 1000;
      if (!Number.isFinite(ageSeconds) || !Number.isFinite(maximumSeconds)) return market;
      const ageLabel = ageSeconds >= 60
        ? `${Math.floor(ageSeconds / 60)}분 ${Math.floor(ageSeconds % 60)}초 전`
        : `${Math.floor(ageSeconds)}초 전`;
      return `${market} 최근 체결 ${ageLabel} · 허용 ${Math.floor(maximumSeconds)}초`;
    });
    return `${details.join(' / ')}. 최신 시세 확인 후 재시도.`;
  }
  const error = body?.error;
  if (error?.code === 'idempotency_key_required') return '서버가 요청 키를 확인하지 못했습니다. 결과를 확인할 때까지 새 변경은 잠겨 있습니다.';
  if (error?.code === 'idempotency_key_conflict') return '서버 기록과 저장된 요청이 일치하지 않습니다. 새 변경은 잠겨 있습니다.';
  if (typeof body?.message === 'string') return toUserText(body.message);
  if (typeof error?.message === 'string') return toUserText(error.message);
  if (typeof error === 'string') return toUserText(error);
  return outcome?.message || fallback;
}

/** true when the outcome carries the server's final answer (2xx). */
export function isTerminalOutcome(outcome) {
  return outcome?.kind === 'terminal' || outcome?.kind === 'terminal-locked';
}

export function outcomeToastTone(outcome) {
  return ['rejected', 'storage-error', 'invalid'].includes(outcome?.kind) ? 'error' : 'warning';
}
