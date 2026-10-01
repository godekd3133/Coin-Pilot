// Upbit HTTP 전송 프리미티브 — 쿼리 직렬화, 헤더/재시도-후 파싱,
// 임시 블록/데드라인 에러, 스케줄러 입장 판정, 레이트 코디네이터 해석.
import { envRaw } from '../config/envConfig.js';
import {
  UpbitRateCoordinatorClient,
  resolveUpbitRateCoordinatorPaths
} from './upbitRateCoordinator.js';

export const UPBIT_418_FALLBACK_BACKOFF_MS = 5 * 60 * 1000;

export const RATE_COORDINATOR_LEASE = Symbol('upbitRateCoordinatorLease');


export function serializeQueryString(query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value === null || value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item === null || item === undefined) continue;
      params.append(key, String(item));
    }
  }
  // Upbit hashes the unescaped query string and requires repeated keys for
  // array parameters such as states[]=wait&states[]=watch.
  return decodeURIComponent(params.toString());
}


export function getRetryAfterMs(header, now = Date.now()) {
  const value = String(header ?? '').trim();
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : 0;
}


export function getHeader(headers, name) {
  return headers?.[name] ?? headers?.[name.toLowerCase()] ??
    (typeof headers?.get === 'function' ? headers.get(name) : undefined);
}


export function parseRemainingReq(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let group = null;
  let remaining = null;
  for (const part of value.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim().toLowerCase();
    const content = part.slice(separator + 1).trim();
    if (key === 'group' && /^[a-z0-9-]+$/i.test(content)) group = content.toLowerCase();
    if (key === 'sec' && /^\d+$/.test(content)) remaining = Number(content);
  }
  return group && Number.isSafeInteger(remaining) ? { group, remaining } : null;
}


export function getNextSecondBoundaryDelayMs(now) {
  return 1000 - (now % 1000);
}


export function getTemporaryBlockDurationMs(error, now = Date.now()) {
  const headers = error.response?.headers;
  const retryAfterMs = getRetryAfterMs(getHeader(headers, 'Retry-After'), now);
  if (retryAfterMs > 0) return { durationMs: retryAfterMs, source: 'retry-after' };
  return { durationMs: UPBIT_418_FALLBACK_BACKOFF_MS, source: 'fallback' };
}


export function createRequestDeadlineError(deadlineAt) {
  const error = new Error('Upbit request exceeded its absolute deadline');
  error.name = 'UpbitRequestDeadlineError';
  error.code = 'UPBIT_REQUEST_DEADLINE';
  error.deadlineAt = deadlineAt;
  return error;
}


export function createFillDeadlineError(deadlineAt) {
  const error = new Error('Order fill state remains unknown after its deadline');
  error.name = 'UpbitFillDeadlineError';
  error.code = 'UPBIT_FILL_DEADLINE';
  error.deadlineAt = deadlineAt;
  error.orderState = 'unknown';
  error.unresolved = true;
  return error;
}


export function isSchedulerAdmissionError(error) {
  return [
    'UPBIT_QUEUE_FULL',
    'UPBIT_QUEUE_TIMEOUT',
    'UPBIT_REQUEST_ABORTED',
    'UPBIT_REQUEST_DEADLINE',
    'UPBIT_FILL_DEADLINE'
  ]
    .includes(error?.code) ||
    error?.code?.startsWith?.('UPBIT_RATE_COORDINATOR_') ||
    error?.name === 'AbortError';
}


export function isEnvironmentFlagEnabled(value) {
  return ['true', '1', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}


export function resolveRateCoordinator(options = {}) {
  const required = isEnvironmentFlagEnabled(envRaw('UPBIT_RATE_COORDINATOR_REQUIRED')) ||
    options.rateCoordinatorRequired === true;
  if (options.rateCoordinator && typeof options.rateCoordinator.acquireTurn === 'function') {
    return { client: options.rateCoordinator, required };
  }
  if (!required) return { client: null, required: false };

  // The portfolio root is profile-scoped; requiring an explicit coordinator
  // root prevents Paper and LIVE from silently creating separate host queues.
  const stateDir = typeof envRaw('UPBIT_RATE_COORDINATOR_STATE_DIR') === 'string'
    ? envRaw('UPBIT_RATE_COORDINATOR_STATE_DIR').trim()
    : '';
  if (typeof stateDir !== 'string' || !stateDir.trim()) {
    const error = new Error(
      'UPBIT_RATE_COORDINATOR_STATE_DIR must be set explicitly when shared Upbit coordination is required.'
    );
    error.code = 'UPBIT_RATE_COORDINATOR_STATE_ROOT_REQUIRED';
    throw error;
  }
  const { socketPath } = resolveUpbitRateCoordinatorPaths(stateDir);
  return {
    client: new UpbitRateCoordinatorClient({ socketPath }),
    required: true
  };
}
