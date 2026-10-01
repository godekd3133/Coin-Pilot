import axios from 'axios';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { sharedUpbitRequestScheduler } from './upbitRequestScheduler.js';
import {
  UpbitRateCoordinatorClient,
  resolveUpbitRateCoordinatorPaths
} from './upbitRateCoordinator.js';
import { envRaw } from '../config/envConfig.js';

// Upbit documents progressively longer temporary 418 blocks but does not
// specify a fixed fallback duration. Keep every lane closed for five minutes
// when the response omits a trusted duration, and fail the current operation.
const UPBIT_418_FALLBACK_BACKOFF_MS = 5 * 60 * 1000;
const RATE_COORDINATOR_LEASE = Symbol('upbitRateCoordinatorLease');

function serializeQueryString(query) {
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

function getRetryAfterMs(header, now = Date.now()) {
  const value = String(header ?? '').trim();
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : 0;
}

function getHeader(headers, name) {
  return headers?.[name] ?? headers?.[name.toLowerCase()] ??
    (typeof headers?.get === 'function' ? headers.get(name) : undefined);
}

function parseRemainingReq(value) {
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

function getNextSecondBoundaryDelayMs(now) {
  return 1000 - (now % 1000);
}

function getTemporaryBlockDurationMs(error, now = Date.now()) {
  const headers = error.response?.headers;
  const retryAfterMs = getRetryAfterMs(getHeader(headers, 'Retry-After'), now);
  if (retryAfterMs > 0) return { durationMs: retryAfterMs, source: 'retry-after' };
  return { durationMs: UPBIT_418_FALLBACK_BACKOFF_MS, source: 'fallback' };
}

function createRequestDeadlineError(deadlineAt) {
  const error = new Error('Upbit request exceeded its absolute deadline');
  error.name = 'UpbitRequestDeadlineError';
  error.code = 'UPBIT_REQUEST_DEADLINE';
  error.deadlineAt = deadlineAt;
  return error;
}

function createFillDeadlineError(deadlineAt) {
  const error = new Error('Order fill state remains unknown after its deadline');
  error.name = 'UpbitFillDeadlineError';
  error.code = 'UPBIT_FILL_DEADLINE';
  error.deadlineAt = deadlineAt;
  error.orderState = 'unknown';
  error.unresolved = true;
  return error;
}

function isSchedulerAdmissionError(error) {
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

function isEnvironmentFlagEnabled(value) {
  return ['true', '1', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function resolveRateCoordinator(options = {}) {
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

class UpbitAPI {
  constructor(accessKey, secretKey, options = {}) {
    this.accessKey = accessKey;
    this.secretKey = secretKey;
    this.baseURL = 'https://api.upbit.com/v1';
    this.axios = options.axios || axios;
    this.scheduler = options.scheduler || sharedUpbitRequestScheduler;
    const rateCoordinator = resolveRateCoordinator(options);
    this.rateCoordinator = rateCoordinator.client;
    this.rateCoordinatorRequired = rateCoordinator.required;
    this.rateCoordinatorAvailable = null;
    this.rateCoordinatorFailureCode = null;
    this.random = typeof options.random === 'function' ? options.random : Math.random;
    const configuredTimeout = options.requestTimeoutMs ?? envRaw('UPBIT_REQUEST_TIMEOUT_MS');
    const parsedTimeout = Number(configuredTimeout);
    this.requestTimeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0
      ? parsedTimeout
      : 10_000;
    this.normalQueueTimeoutMs = Number.isFinite(Number(options.normalQueueTimeoutMs)) &&
      Number(options.normalQueueTimeoutMs) >= 0
      ? Number(options.normalQueueTimeoutMs)
      : 10_000;
    this.riskQueueTimeoutMs = Number.isFinite(Number(options.riskQueueTimeoutMs)) &&
      Number(options.riskQueueTimeoutMs) >= 0
      ? Number(options.riskQueueTimeoutMs)
      : 30_000;
    this.lastRequestTime = 0;
    const configuredRequestInterval = options.minRequestIntervalMs ?? envRaw('UPBIT_MIN_REQUEST_INTERVAL_MS');
    const parsedRequestInterval = Number(configuredRequestInterval);
    this.minRequestInterval = Number.isFinite(parsedRequestInterval) && parsedRequestInterval > 0
      ? Math.max(100, parsedRequestInterval)
      : 100; // 최소 100ms 간격 (초당 10회 - Upbit 제한)

    // 요청 큐 시스템
    this.requestQueue = [];
    this.isProcessingQueue = false;
    this.queueInterval = Math.max(120, this.minRequestInterval); // 초당 약 8회 이하, 여유분 포함
  }

  /**
   * 모든 Upbit HTTP 요청에 유한한 timeout을 강제한다.
   * 응답이 오지 않는 소켓 때문에 forward paper cycle 전체가 멈추지 않도록
   * 네트워크 경계에서 실패를 반환하게 한다.
   */
  getRequestConfig(config = {}) {
    return {
      ...config,
      timeout: this.requestTimeoutMs
    };
  }

  getRequestConfigWithOptions(config = {}, requestOptions = {}) {
    const requestConfig = { ...config };
    if (requestOptions.signal) requestConfig.signal = requestOptions.signal;
    const deadlineAt = Number(requestOptions.deadlineAt);
    if (requestOptions.deadlineAt !== undefined && requestOptions.deadlineAt !== null &&
      Number.isFinite(deadlineAt)) {
      const remainingMs = Math.floor(deadlineAt - this.getCurrentTime());
      if (remainingMs <= 0) throw createRequestDeadlineError(deadlineAt);
      return {
        ...requestConfig,
        timeout: Math.min(this.requestTimeoutMs, remainingMs)
      };
    }
    return this.getRequestConfig(requestConfig);
  }

  getCurrentTime() {
    return typeof this.scheduler?.now === 'function' ? this.scheduler.now() : Date.now();
  }

  sleep(delayMs) {
    const setTimer = this.scheduler?.setTimer || ((callback, timeout) => setTimeout(callback, timeout));
    return new Promise(resolve => setTimer(resolve, Math.max(0, delayMs)));
  }

  getDeadlineRemainingMs(requestOptions = {}) {
    const deadlineAt = Number(requestOptions.deadlineAt);
    if (requestOptions.deadlineAt === undefined || requestOptions.deadlineAt === null ||
      !Number.isFinite(deadlineAt)) return null;
    return Math.max(0, deadlineAt - this.getCurrentTime());
  }

  async waitBeforeRetry(delayMs, requestOptions = {}) {
    const remainingMs = this.getDeadlineRemainingMs(requestOptions);
    if (remainingMs !== null && remainingMs <= 0) {
      throw createRequestDeadlineError(requestOptions.deadlineAt);
    }
    await this.sleep(remainingMs === null ? delayMs : Math.min(delayMs, remainingMs));
    if (this.getDeadlineRemainingMs(requestOptions) === 0) {
      throw createRequestDeadlineError(requestOptions.deadlineAt);
    }
  }

  getSchedulerOptions(requestOptions = {}) {
    const priority = requestOptions.priority === 'risk' ? 'risk' : 'normal';
    const queueWaitTimeoutMs = requestOptions.queueWaitTimeoutMs ??
      (priority === 'risk' ? this.riskQueueTimeoutMs : this.normalQueueTimeoutMs);
    const schedulerOptions = {
      priority,
      signal: requestOptions.signal,
      priorityOrder: requestOptions.priorityOrder,
      rateLimitGroup: requestOptions.rateLimitGroup || 'all',
      rateLimitScope: requestOptions.rateLimitScope || 'process',
      queueWaitTimeoutMs,
      minRequestIntervalMs: this.minRequestInterval
    };
    const deadlineAt = Number(requestOptions.deadlineAt);
    if (requestOptions.deadlineAt !== undefined && requestOptions.deadlineAt !== null &&
      Number.isFinite(deadlineAt)) {
      schedulerOptions.deadlineAt = deadlineAt;
      schedulerOptions.queueWaitTimeoutMs = Math.min(
        queueWaitTimeoutMs,
        Math.max(0, deadlineAt - this.getCurrentTime())
      );
    }
    return schedulerOptions;
  }

  async scheduleRequest(requestFn, requestOptions = {}) {
    const schedulerOptions = this.getSchedulerOptions(requestOptions);
    const coordinatorBudgetMs = schedulerOptions.queueWaitTimeoutMs;
    const coordinatorBudgetStartedAt = process.hrtime.bigint();
    return this.scheduler.schedule(async startedAt => {
      if (this.rateCoordinator && schedulerOptions.rateLimitScope === 'ip') {
        let lease;
        const elapsedCoordinatorBudgetMs = Number(
          process.hrtime.bigint() - coordinatorBudgetStartedAt
        ) / 1_000_000;
        const remainingCoordinatorBudgetMs = Math.max(
          0,
          coordinatorBudgetMs - elapsedCoordinatorBudgetMs
        );
        try {
          lease = await this.rateCoordinator.acquireTurn({
            scope: 'ip',
            group: schedulerOptions.rateLimitGroup,
            priority: schedulerOptions.priority,
            priorityOrder: schedulerOptions.priorityOrder,
            deadlineAt: this.getCurrentTime() + remainingCoordinatorBudgetMs,
            queueWaitTimeoutMs: remainingCoordinatorBudgetMs,
            minRequestIntervalMs: schedulerOptions.minRequestIntervalMs,
            signal: schedulerOptions.signal
          });
          this.rateCoordinatorAvailable = true;
          this.rateCoordinatorFailureCode = null;
          this.lastRequestTime = this.getCurrentTime();
        } catch (error) {
          this.rateCoordinatorAvailable = false;
          this.rateCoordinatorFailureCode = error?.code?.startsWith?.('UPBIT_RATE_COORDINATOR_')
            ? error.code
            : 'UPBIT_RATE_COORDINATOR_UNAVAILABLE';
          throw error;
        }

        let holdLeaseForBackoff = false;
        try {
          return await requestFn();
        } catch (error) {
          if (error?.response?.status === 418 || error?.response?.status === 429) {
            Object.defineProperty(error, RATE_COORDINATOR_LEASE, {
              configurable: true,
              value: lease
            });
            holdLeaseForBackoff = true;
          }
          throw error;
        } finally {
          if (!holdLeaseForBackoff) await lease.release();
        }
      }

      this.lastRequestTime = startedAt;
      return requestFn();
    }, schedulerOptions);
  }

  async applyRateLimitBackoff(error, attempt = 0, requestOptions = {}) {
    const headers = error.response?.headers;
    const retryAfterHeader = getHeader(headers, 'Retry-After');
    const remaining = parseRemainingReq(getHeader(headers, 'Remaining-Req'));
    const retryAfterMs = getRetryAfterMs(retryAfterHeader, this.getCurrentTime());
    const waitTime = Math.max(
      retryAfterMs,
      Math.pow(2, attempt) * 2000 + Math.floor(this.random() * 250)
    );
    this.scheduler.applyBackoff(waitTime, {
      rateLimitGroup: remaining?.group || requestOptions.rateLimitGroup,
      rateLimitScope: requestOptions.rateLimitScope
    });
    if (this.rateCoordinator && requestOptions.rateLimitScope === 'ip') {
      try {
        await this.rateCoordinator.applyBackoff(waitTime, {
          scope: 'ip',
          group: remaining?.group || requestOptions.rateLimitGroup
        });
        this.rateCoordinatorAvailable = true;
        this.rateCoordinatorFailureCode = null;
      } catch (coordinatorError) {
        this.rateCoordinatorAvailable = false;
        this.rateCoordinatorFailureCode = coordinatorError?.code?.startsWith?.('UPBIT_RATE_COORDINATOR_')
          ? coordinatorError.code
          : 'UPBIT_RATE_COORDINATOR_UNAVAILABLE';
        throw coordinatorError;
      }
    }
    return waitTime;
  }

  async applyTemporaryBlockBackoff(error, requestOptions = {}) {
    const { durationMs, source } = getTemporaryBlockDurationMs(error, this.getCurrentTime());
    this.scheduler.applyBackoff(durationMs, {
      rateLimitScope: requestOptions.rateLimitScope,
      rateLimitScopeWide: true
    });
    if (this.rateCoordinator && requestOptions.rateLimitScope === 'ip') {
      try {
        await this.rateCoordinator.applyBackoff(durationMs, {
          scope: 'ip',
          scopeWide: true
        });
        this.rateCoordinatorAvailable = true;
        this.rateCoordinatorFailureCode = null;
      } catch (coordinatorError) {
        this.rateCoordinatorAvailable = false;
        this.rateCoordinatorFailureCode = coordinatorError?.code?.startsWith?.('UPBIT_RATE_COORDINATOR_')
          ? coordinatorError.code
          : 'UPBIT_RATE_COORDINATOR_UNAVAILABLE';
        throw coordinatorError;
      }
    }
    return { durationMs, source };
  }

  async observeRateLimitResponse(response, requestOptions = {}) {
    const parsed = parseRemainingReq(getHeader(response?.headers, 'Remaining-Req'));
    if (!parsed || parsed.remaining !== 0) return;
    const now = this.getCurrentTime();
    this.scheduler.applyBackoff(getNextSecondBoundaryDelayMs(now), {
      rateLimitGroup: parsed.group,
      rateLimitScope: requestOptions.rateLimitScope
    });
    if (this.rateCoordinator && requestOptions.rateLimitScope === 'ip') {
      try {
        await this.rateCoordinator.observeRemaining(parsed.group, parsed.remaining);
        this.rateCoordinatorAvailable = true;
        this.rateCoordinatorFailureCode = null;
      } catch (error) {
        this.rateCoordinatorAvailable = false;
        this.rateCoordinatorFailureCode = error?.code?.startsWith?.('UPBIT_RATE_COORDINATOR_')
          ? error.code
          : 'UPBIT_RATE_COORDINATOR_UNAVAILABLE';
        throw error;
      }
    }
  }

  /**
   * Rate limiting을 위한 대기
   */
  async waitForRateLimit(options = {}) {
    await this.scheduleRequest(() => undefined, options);
  }

  /**
   * 요청 큐에 추가하고 순차 처리
   * @param {Function} requestFn - 실행할 요청 함수
   * @param {number} priority - 우선순위 (낮을수록 먼저 처리, 기본 5)
   * @returns {Promise} 요청 결과
   */
  queueRequest(requestFn, priority = 5) {
    const numericPriority = Number(priority);
    const priorityName = priority === 'risk' || numericPriority <= 0 ? 'risk' : 'normal';
    return this.scheduleRequest(requestFn, {
      priority: priorityName,
      priorityOrder: Number.isFinite(numericPriority) ? numericPriority : 0
    });
  }

  /**
   * 요청 큐 순차 처리
   */
  async processQueue() {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;
    try {
      while (this.requestQueue.length > 0) {
        const request = this.requestQueue.shift();
        const numericPriority = Number(request.priority);
        const priority = request.priority === 'risk' || numericPriority <= 0 ? 'risk' : 'normal';
        try {
          const result = await this.scheduleRequest(request.fn, {
            priority,
            priorityOrder: Number.isFinite(numericPriority) ? numericPriority : 0
          });
          request.resolve(result);
        } catch (error) {
          request.reject(error);
        }
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  /**
   * 큐 상태 조회
   */
  getQueueStatus() {
    const shared = this.scheduler.getStatus();
    return {
      queueLength: shared.queuedTotal + this.requestQueue.length,
      isProcessing: this.isProcessingQueue || shared.queuedTotal > 0 || shared.inFlightTotal > 0,
      lastRequestTime: this.lastRequestTime,
      sharedQueueLength: shared.queuedTotal,
      queuedByPriority: shared.queued,
      oldestWaitAgeMsByPriority: shared.oldestWaitAgeMs,
      inFlightByPriority: shared.inFlight,
      inFlightTotal: shared.inFlightTotal,
      maxInFlight: shared.maxInFlight,
      maxInFlightByPriority: shared.maxInFlightByPriority,
      maxQueuedByPriority: shared.maxQueuedByPriority,
      nextStartInMs: shared.nextStartInMs,
      backoffRemainingMs: shared.backoffRemainingMs,
      backoffRemainingMsByScopeAndGroup: shared.backoffRemainingMsByScopeAndGroup,
      rateCoordinatorRequired: this.rateCoordinatorRequired,
      rateCoordinatorEnabled: Boolean(this.rateCoordinator),
      rateCoordinatorAvailable: this.rateCoordinatorAvailable,
      rateCoordinatorFailureCode: this.rateCoordinatorFailureCode
    };
  }

  async getRateCoordinatorStatus() {
    if (!this.rateCoordinator) {
      return {
        required: this.rateCoordinatorRequired,
        enabled: false,
        available: null,
        failureCode: null
      };
    }

    try {
      const status = await this.rateCoordinator.getStatus();
      if (!status || status.available !== true) {
        const unavailable = new Error('Shared Upbit rate coordinator is unavailable.');
        unavailable.code = status?.failureCode || 'UPBIT_RATE_COORDINATOR_UNAVAILABLE';
        throw unavailable;
      }
      this.rateCoordinatorAvailable = true;
      this.rateCoordinatorFailureCode = null;
      const asNonNegativeInteger = value => {
        if (value === null || value === undefined || value === '') return null;
        const number = Number(value);
        return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
      };
      return {
        required: this.rateCoordinatorRequired,
        enabled: true,
        available: true,
        failureCode: null,
        queuedTotal: asNonNegativeInteger(status.queuedTotal),
        inFlightTotal: asNonNegativeInteger(status.inFlightTotal),
        maxInFlight: asNonNegativeInteger(status.maxInFlight),
        nextStartInMs: asNonNegativeInteger(status.nextStartInMs)
      };
    } catch (error) {
      this.rateCoordinatorAvailable = false;
      this.rateCoordinatorFailureCode = error?.code?.startsWith?.('UPBIT_RATE_COORDINATOR_')
        ? error.code
        : 'UPBIT_RATE_COORDINATOR_UNAVAILABLE';
      return {
        required: this.rateCoordinatorRequired,
        enabled: true,
        available: false,
        failureCode: this.rateCoordinatorFailureCode
      };
    }
  }

  async assertRateCoordinatorReady() {
    const status = await this.getRateCoordinatorStatus();
    if (status.required && status.available !== true) {
      const error = new Error('Required shared Upbit rate coordinator is unavailable.');
      error.code = status.failureCode || 'UPBIT_RATE_COORDINATOR_UNAVAILABLE';
      throw error;
    }
    return status;
  }

  /**
   * 재시도 로직이 포함된 API 요청
   */
  async requestWithRetry(requestFn, maxRetries = 3, requestOptions = {}) {
    const attempts = Number.isSafeInteger(Number(maxRetries)) && Number(maxRetries) > 0
      ? Number(maxRetries)
      : 1;
    let finalError;

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const remainingMs = this.getDeadlineRemainingMs(requestOptions);
        if (remainingMs !== null && remainingMs <= 0) {
          throw createRequestDeadlineError(requestOptions.deadlineAt);
        }
        const result = await this.scheduleRequest(requestFn, requestOptions);
        if (this.getDeadlineRemainingMs(requestOptions) === 0) {
          throw createRequestDeadlineError(requestOptions.deadlineAt);
        }
        return result;
      } catch (error) {
        finalError = error;
        if (isSchedulerAdmissionError(error)) throw error;
        const status = error.response?.status;

        // Upbit's 418 means the IP/pocket is temporarily blocked. Apply the
        // response duration (or the conservative shared fallback) and fail
        // this request instead of retrying into the block.
        if (status === 418) {
          try {
            const { durationMs, source } = await this.applyTemporaryBlockBackoff(error, requestOptions);
            console.error(`Rate limited with HTTP 418. Shared cooldown: ${durationMs}ms (${source})`);
          } finally {
            const lease = error?.[RATE_COORDINATOR_LEASE];
            if (lease) {
              delete error[RATE_COORDINATOR_LEASE];
              await lease.release();
            }
          }
          throw error;
        }

        // Rate limit - 재시도
        if (status === 429) {
          let waitTime;
          try {
            waitTime = await this.applyRateLimitBackoff(error, attempt, requestOptions);
            console.log(`Rate limited. Waiting ${waitTime}ms before retry (${attempt + 1}/${attempts})`);
          } finally {
            const lease = error?.[RATE_COORDINATOR_LEASE];
            if (lease) {
              delete error[RATE_COORDINATOR_LEASE];
              await lease.release();
            }
          }
          if (this.getDeadlineRemainingMs(requestOptions) === 0) {
            throw createRequestDeadlineError(requestOptions.deadlineAt);
          }
          if (attempt < attempts - 1) continue;
          throw error;
        }

        if (this.getDeadlineRemainingMs(requestOptions) === 0) {
          throw createRequestDeadlineError(requestOptions.deadlineAt);
        }

        // 서버 에러 (5xx) - 재시도
        if (status >= 500 && attempt < attempts - 1) {
          const waitTime = Math.pow(2, attempt) * 500;
          console.log(`Server error (${status}). Waiting ${waitTime}ms before retry (${attempt + 1}/${attempts})`);
          await this.waitBeforeRetry(waitTime, requestOptions);
          continue;
        }

        // 네트워크 에러 - 재시도
        if (['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE', 'ECONNABORTED', 'EAI_AGAIN', 'ENETRESET'].includes(error.code)) {
          if (attempt < attempts - 1) {
            const waitTime = Math.pow(2, attempt) * 1000;
            console.log(`Network error (${error.code}). Waiting ${waitTime}ms before retry (${attempt + 1}/${attempts})`);
            await this.waitBeforeRetry(waitTime, requestOptions);
            continue;
          }
        }

        // 최종 실패
        throw error;
      }
    }

    throw finalError || new Error('Upbit request failed without a response');
  }

  /**
   * Upbit API 에러 파싱
   */
  parseApiError(error) {
    const response = error.response;
    if (!response) {
      return { code: 'NETWORK_ERROR', message: error.message || '네트워크 오류' };
    }

    const data = response.data;
    const errorInfo = data?.error || {};

    // 알려진 에러 코드 매핑
    const errorMessages = {
      'insufficient_funds_bid': '매수 자금 부족',
      'insufficient_funds_ask': '매도 수량 부족',
      'under_min_total_bid': '최소 주문금액(5,000원) 미만',
      'under_min_total_ask': '최소 매도금액 미만',
      'invalid_volume_bid': '유효하지 않은 매수 수량',
      'invalid_volume_ask': '유효하지 않은 매도 수량',
      'invalid_funds_bid': '유효하지 않은 매수 금액',
      'market_does_not_exist': '존재하지 않는 마켓',
      'no_authorization_i_p': 'IP 인증 실패',
      'jwt_verification': 'JWT 인증 실패',
      'expired_access_key': '만료된 API 키',
      'nonce_used': '중복된 nonce',
      'no_authorization_api_key': 'API 키 인증 실패',
      'server_error': '서버 오류',
      'too_many_requests': '요청 횟수 초과'
    };

    const code = errorInfo.name || `HTTP_${response.status}`;
    const message = errorMessages[errorInfo.name] || errorInfo.message || `알 수 없는 오류 (${response.status})`;

    return { code, message, raw: errorInfo };
  }

  /**
   * JWT 토큰 생성
   */
  generateToken(query = null) {
    const payload = {
      access_key: this.accessKey,
      nonce: uuidv4(),
    };

    if (query) {
      const queryString = serializeQueryString(query);
      const hash = crypto.createHash('sha512');
      const queryHash = hash.update(queryString, 'utf-8').digest('hex');
      payload.query_hash = queryHash;
      payload.query_hash_alg = 'SHA512';
    }

    return jwt.sign(payload, this.secretKey, { algorithm: 'HS512' });
  }

  /**
   * 마켓 코드 조회
   */
  async getMarkets(requestOptions = {}) {
    const priorityOptions = {
      ...requestOptions,
      rateLimitGroup: 'market',
      rateLimitScope: 'ip'
    };
    try {
      return await this.requestWithRetry(async () => {
        const response = await this.axios.get(
          `${this.baseURL}/market/all`,
          this.getRequestConfigWithOptions({}, priorityOptions)
        );
        await this.observeRateLimitResponse(response, priorityOptions);
        return response.data;
      }, 3, priorityOptions);
    } catch (error) {
      console.error('Error fetching markets:', error.message);
      throw error;
    }
  }

  /**
   * 분봉 캔들 조회
   * @param {string} market - 마켓 코드 (예: KRW-BTC)
   * @param {number} unit - 분 단위 (1, 3, 5, 15, 10, 30, 60, 240)
   * @param {number} count - 캔들 개수 (최대 200)
   * @param {{ to?: string }} requestOptions - Optional Upbit pagination cursor and scheduler controls
   */
  async getMinuteCandles(market, unit = 5, count = 200, requestOptions = {}) {
    if (!Number.isSafeInteger(count) || count < 1 || count > 200) {
      throw new RangeError('Upbit minute candle count must be an integer from 1 to 200.');
    }
    const cursor = requestOptions?.to;
    if (cursor !== undefined && cursor !== null &&
      (typeof cursor !== 'string' || !cursor.trim())) {
      throw new TypeError('Upbit minute candle cursor must be a non-empty string when provided.');
    }
    const priorityOptions = {
      ...requestOptions,
      rateLimitGroup: 'candle',
      rateLimitScope: 'ip'
    };
    return this.requestWithRetry(async () => {
      const params = { market, count };
      if (cursor !== undefined && cursor !== null) params.to = cursor;
      const response = await this.axios.get(
        `${this.baseURL}/candles/minutes/${unit}`,
        this.getRequestConfigWithOptions({
          params
        }, priorityOptions)
      );
      await this.observeRateLimitResponse(response, priorityOptions);
      return response.data;
    }, 3, priorityOptions);
  }

  /**
   * 일봉 캔들 조회
   */
  async getDayCandles(market, count = 200, requestOptions = {}) {
    const cursor = requestOptions?.to;
    if (cursor !== undefined && cursor !== null &&
      (typeof cursor !== 'string' || !cursor.trim())) {
      throw new TypeError('Upbit day candle cursor must be a non-empty string when provided.');
    }
    const priorityOptions = {
      ...requestOptions,
      rateLimitGroup: 'candle',
      rateLimitScope: 'ip'
    };
    return this.requestWithRetry(async () => {
      const params = { market, count };
      if (cursor !== undefined && cursor !== null) params.to = cursor;
      const response = await this.axios.get(`${this.baseURL}/candles/days`, this.getRequestConfigWithOptions({
        params
      }, priorityOptions));
      await this.observeRateLimitResponse(response, priorityOptions);
      return response.data;
    }, 3, priorityOptions);
  }

  /**
   * 현재가 정보 조회
   */
  async getTicker(markets, requestOptions = {}) {
    const marketString = Array.isArray(markets) ? markets.join(',') : markets;
    const priorityOptions = {
      ...requestOptions,
      rateLimitGroup: 'ticker',
      rateLimitScope: 'ip'
    };
    return this.requestWithRetry(async () => {
      const response = await this.axios.get(`${this.baseURL}/ticker`, this.getRequestConfigWithOptions({
        params: { markets: marketString }
      }, priorityOptions));
      await this.observeRateLimitResponse(response, priorityOptions);
      return response.data;
    }, 3, priorityOptions);
  }

  /**
   * Orderbook depth 조회
   * @param {string|string[]} markets - 마켓 코드 또는 마켓 코드 배열
   * @param {object} requestOptions - Scheduler controls such as signal or deadlineAt
   * @returns {Promise<Array>} Upbit orderbook response data
   */
  async getOrderbook(markets, requestOptions = {}) {
    const marketString = Array.isArray(markets) ? markets.join(',') : markets;
    const priorityOptions = {
      ...requestOptions,
      rateLimitGroup: 'orderbook',
      rateLimitScope: 'ip'
    };
    return this.requestWithRetry(async () => {
      const response = await this.axios.get(`${this.baseURL}/orderbook`, this.getRequestConfigWithOptions({
        params: { markets: marketString }
      }, priorityOptions));
      await this.observeRateLimitResponse(response, priorityOptions);
      return response.data;
    }, 3, priorityOptions);
  }

  /**
   * 계좌 조회
   */
  async getAccounts(requestOptions = {}) {
    const priorityOptions = {
      ...requestOptions,
      priority: 'risk',
      rateLimitGroup: 'default',
      rateLimitScope: 'pocket'
    };
    return this.requestWithRetry(async () => {
      const token = this.generateToken();
      const response = await this.axios.get(`${this.baseURL}/accounts`, this.getRequestConfigWithOptions({
        headers: { Authorization: `Bearer ${token}` }
      }, priorityOptions));
      await this.observeRateLimitResponse(response, priorityOptions);
      return response.data;
    }, 3, priorityOptions);
  }

  /**
   * 주문 가능 정보 조회
   */
  async getOrderChance(market, requestOptions = {}) {
    const priorityOptions = {
      ...requestOptions,
      priority: 'risk',
      rateLimitGroup: 'default',
      rateLimitScope: 'pocket'
    };
    return this.requestWithRetry(async () => {
      const query = { market };
      const token = this.generateToken(query);
      const response = await this.axios.get(`${this.baseURL}/orders/chance`, this.getRequestConfigWithOptions({
        params: query,
        headers: { Authorization: `Bearer ${token}` }
      }, priorityOptions));
      await this.observeRateLimitResponse(response, priorityOptions);
      return response.data;
    }, 3, priorityOptions);
  }

  /**
   * 주문하기
   * @param {string} market - 마켓 코드
   * @param {string} side - 주문 종류 (bid: 매수, ask: 매도)
   * @param {number} volume - 주문량
   * @param {number} price - 주문 가격
   * @param {string} ord_type - 주문 타입 (limit: 지정가, price: 시장가 매수, market: 시장가 매도)
   * @param {string|null} identifier - 재기동 조회를 위한 계정 내 고유 주문 식별자
   * @returns {Object} 주문 결과 { success: boolean, data?: OrderData, error?: ErrorInfo }
   */
  async order(market, side, volume, price = null, ord_type = 'limit', identifier = null, requestOptions = {}) {
    const priorityOptions = {
      ...requestOptions,
      priority: 'risk',
      rateLimitGroup: 'order',
      rateLimitScope: 'pocket'
    };
    const query = {
      market,
      side,
      ord_type
    };
    if (typeof identifier === 'string' && identifier.trim()) query.identifier = identifier.trim();

    if (ord_type === 'limit') {
      query.volume = volume.toString();
      query.price = price.toString();
    } else if (ord_type === 'price') {
      // 시장가 매수 (금액 지정)
      query.price = volume.toString();
    } else if (ord_type === 'market') {
      // 시장가 매도 (수량 지정)
      query.volume = volume.toString();
    }

    let requestDispatched = false;
    try {
      const response = await this.scheduleRequest(async () => {
        const token = this.generateToken(query);
        const requestConfig = this.getRequestConfigWithOptions({
          headers: { Authorization: `Bearer ${token}` }
        }, priorityOptions);
        requestDispatched = true;
        const result = await this.axios.post(`${this.baseURL}/orders`, query, requestConfig);
        await this.observeRateLimitResponse(result, priorityOptions);
        return result;
      }, priorityOptions);
      return { success: true, data: response.data };
    } catch (error) {
      if (!requestDispatched) {
        const message = `주문 요청이 거래소로 전송되지 않았습니다: ${error.message || '요청 대기열을 사용할 수 없습니다.'}`;
        return {
          success: false,
          error: {
            code: 'upbit_request_not_dispatched',
            message,
            dispatched: false,
            schedulerCode: error.code || null
          }
        };
      }
      if (error.response?.status === 429) {
        await this.applyRateLimitBackoff(error, 0, priorityOptions);
      } else if (error.response?.status === 418) {
        const { durationMs, source } = await this.applyTemporaryBlockBackoff(error, priorityOptions);
        console.error(`Rate limited with HTTP 418. Shared cooldown: ${durationMs}ms (${source})`);
      }
      const parsedError = this.parseApiError(error);
      console.error(`Order failed [${market} ${side}]: ${parsedError.message} (${parsedError.code})`);

      // 재시도 불가능한 에러 (자금 부족, 최소 금액 미달 등)는 바로 반환
      const nonRetryableErrors = [
        'insufficient_funds_bid',
        'insufficient_funds_ask',
        'under_min_total_bid',
        'under_min_total_ask',
        'invalid_volume_bid',
        'invalid_volume_ask',
        'invalid_funds_bid',
        'market_does_not_exist'
      ];

      if (nonRetryableErrors.includes(parsedError.code)) {
        return { success: false, error: parsedError };
      }

      // An order POST may have been accepted even when its response is lost.
      // Never automatically repeat that request: callers persist its unique
      // identifier before dispatch and reconcile through GET /order.
      throw error;
    }
  }

  /**
   * 주문 취소
   */
  async cancelOrder(uuid, requestOptions = {}) {
    const priorityOptions = {
      ...requestOptions,
      priority: 'risk',
      rateLimitGroup: 'default',
      rateLimitScope: 'pocket'
    };
    return this.requestWithRetry(async () => {
      const query = { uuid };
      const token = this.generateToken(query);
      const response = await this.axios.delete(`${this.baseURL}/order`, this.getRequestConfigWithOptions({
        params: query,
        headers: { Authorization: `Bearer ${token}` }
      }, priorityOptions));
      await this.observeRateLimitResponse(response, priorityOptions);
      return response.data;
    }, 3, priorityOptions);
  }

  /**
   * 주문 리스트 조회
   */
  async getOrders(market, state = 'wait', requestOptions = {}) {
    const priorityOptions = {
      ...requestOptions,
      priority: 'risk',
      rateLimitGroup: 'default',
      rateLimitScope: 'pocket'
    };
    return this.requestWithRetry(async () => {
      const query = Array.isArray(state)
        ? { market, 'states[]': state }
        : { market, state };
      const token = this.generateToken(query);
      const response = await this.axios.get(`${this.baseURL}/orders`, this.getRequestConfigWithOptions({
        params: query,
        headers: { Authorization: `Bearer ${token}` }
      }, priorityOptions));
      await this.observeRateLimitResponse(response, priorityOptions);
      return response.data;
    }, 3, priorityOptions);
  }

  /**
   * UUID 또는 client identifier로 개별 주문 조회
   * @param {string} uuidOrIdentifier - UUID 또는 사전 기록한 client identifier
   * @param {{ identifier?: boolean }} options - identifier 조회인지 여부
   */
  async getOrder(uuidOrIdentifier, requestOptions = {}) {
    const priorityOptions = {
      ...requestOptions,
      priority: 'risk',
      rateLimitGroup: 'default',
      rateLimitScope: 'pocket'
    };
    const { identifier = false } = priorityOptions;
    return this.requestWithRetry(async () => {
      const query = identifier
        ? { identifier: uuidOrIdentifier }
        : { uuid: uuidOrIdentifier };
      const token = this.generateToken(query);
      const response = await this.axios.get(`${this.baseURL}/order`, this.getRequestConfigWithOptions({
        params: query,
        headers: { Authorization: `Bearer ${token}` }
      }, priorityOptions));
      await this.observeRateLimitResponse(response, priorityOptions);
      return response.data;
    }, 3, priorityOptions);
  }

  /**
   * 주문 상태 확인 및 대기
   * @param {string} uuid - 주문 UUID
   * @param {number} maxWaitMs - 최대 대기 시간 (기본 30초)
   * @param {number} checkIntervalMs - 확인 간격 (기본 1초)
   * @returns {Object} { filled: boolean, order: OrderData, error?: string }
   */
  async waitForOrderFill(uuid, maxWaitMs = 30000, checkIntervalMs = 1000, requestOptions = {}) {
    const parsedMaxWaitMs = Number(maxWaitMs);
    const fillDeadlineAt = this.getCurrentTime() + (
      Number.isFinite(parsedMaxWaitMs) && parsedMaxWaitMs > 0 ? parsedMaxWaitMs : 0
    );
    const priorityOptions = {
      ...requestOptions,
      priority: 'risk',
      rateLimitGroup: 'default',
      rateLimitScope: 'pocket',
      deadlineAt: fillDeadlineAt
    };

    while (this.getCurrentTime() < fillDeadlineAt) {
      try {
        const order = await this.getOrder(uuid, priorityOptions);
        if (this.getCurrentTime() >= fillDeadlineAt) {
          throw createFillDeadlineError(fillDeadlineAt);
        }

        if (!order) {
          return { filled: false, order: null, error: '주문 조회 실패' };
        }

        // 주문 상태 확인
        // done: 완료, cancel: 취소, wait: 체결 대기
        const fillAveragePriceFromTrades = target => {
          if (target && (target.avg_price === null || target.avg_price === undefined ||
            !Number.isFinite(Number(target.avg_price)))) {
            const trades = Array.isArray(target.trades) ? target.trades : [];
            const funds = trades.reduce((sum, trade) => sum + (Number(trade?.funds) || 0), 0);
            const volume = trades.reduce((sum, trade) => sum + (Number(trade?.volume) || 0), 0);
            // 업비트는 'cancel' 종결된 주문은 물론 market 매도가 'done'으로
            // 끝날 때도 avg_price를 비워 둔다 — 체결 내역 합산으로 복원한다.
            if (volume > 0 && funds > 0) target.avg_price = String(funds / volume);
          }
          return target;
        };

        if (order.state === 'done') {
          return { filled: true, order: fillAveragePriceFromTrades(order) };
        }

        if (order.state === 'cancel') {
          // 시장가(price/market) 주문은 잔여분이 최소 단위 미만이면 'cancel'로
          // 끝나는 것이 정상 종결이다. 체결된 수량이 있고 채워지지 않은 잔량이
          // 없으면 실질 전량 체결이다.
          const cancelledExecuted = parseFloat(order.executed_volume || 0);
          const cancelledRemaining = parseFloat(order.remaining_volume || 0);
          if (cancelledExecuted > 0 && cancelledRemaining === 0) {
            return { filled: true, order: fillAveragePriceFromTrades(order) };
          }
          if (cancelledExecuted > 0) {
            return { filled: false, partial: true, order, error: '부분 체결 후 취소됨' };
          }
          return { filled: false, order, error: '주문이 취소됨' };
        }

        // 부분 체결 확인
        const executedVolume = parseFloat(order.executed_volume || 0);
        const remainingVolume = parseFloat(order.remaining_volume || 0);

        if (executedVolume > 0 && remainingVolume === 0) {
          return { filled: true, order: fillAveragePriceFromTrades(order) };
        }

        // 아직 체결 대기 중 - 대기
        const remainingMs = this.getDeadlineRemainingMs(priorityOptions) || 0;
        await this.sleep(Math.min(Math.max(0, checkIntervalMs), remainingMs));
      } catch (error) {
        console.error(`주문 상태 확인 오류: ${error.message}`);
        if (error.response?.status === 418 || priorityOptions.signal?.aborted ||
          isSchedulerAdmissionError(error)) {
          if (['UPBIT_QUEUE_TIMEOUT', 'UPBIT_REQUEST_DEADLINE'].includes(error.code)) {
            throw createFillDeadlineError(fillDeadlineAt);
          }
          throw error;
        }
        const remainingMs = this.getDeadlineRemainingMs(priorityOptions) || 0;
        if (remainingMs <= 0) throw createFillDeadlineError(fillDeadlineAt);
        await this.sleep(Math.min(Math.max(0, checkIntervalMs), remainingMs));
      }
    }

    throw createFillDeadlineError(fillDeadlineAt);
  }

  /**
   * 최소 주문 금액 확인
   * @param {number} amount - 주문 금액
   * @returns {boolean} 최소 금액 충족 여부
   */
  isValidOrderAmount(amount) {
    const MIN_ORDER_AMOUNT = 5000; // 업비트 최소 주문금액
    return amount >= MIN_ORDER_AMOUNT;
  }

  /**
   * 주문 가능 수량 계산 (수수료 포함)
   * @param {number} krwBalance - KRW 잔액
   * @param {number} price - 현재가
   * @param {number} feeRate - 수수료율 (기본 0.05%)
   * @returns {Object} { maxVolume, maxAmount, fee }
   */
  calculateMaxOrderVolume(krwBalance, price, feeRate = 0.0005) {
    // 수수료를 고려한 최대 주문 금액
    const maxAmount = krwBalance / (1 + feeRate);
    const maxVolume = maxAmount / price;
    const fee = krwBalance - maxAmount;

    return {
      maxVolume,
      maxAmount: Math.floor(maxAmount),
      fee: Math.ceil(fee)
    };
  }
}

export default UpbitAPI;
