// Upbit 요청 파이프라인 — upbit.js에서 추출.
// 스케줄러 입장, 속도 한도 백오프/관측, 재시도, JWT 생성을 소유한다.
// 상태는 없다 — 모든 필드·공개 메서드는 client(UpbitAPI) 표면을 통해 읽고,
// 인스턴스 오버라이드(테스트 stub)가 계속 적용되도록 this.client.X()로 호출한다.
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import {
  serializeQueryString,
  getRetryAfterMs,
  getHeader,
  parseRemainingReq,
  getNextSecondBoundaryDelayMs,
  getTemporaryBlockDurationMs,
  createRequestDeadlineError,
  isSchedulerAdmissionError,
  RATE_COORDINATOR_LEASE
} from './upbitHttpTransport.js';

export class UpbitRequestPipeline {
  constructor(client) {
    this.client = client;
  }

  getRequestConfig(config = {}) {
    return {
      ...config,
      timeout: this.client.requestTimeoutMs
    };
  }


  getRequestConfigWithOptions(config = {}, requestOptions = {}) {
    const requestConfig = { ...config };
    if (requestOptions.signal) requestConfig.signal = requestOptions.signal;
    const deadlineAt = Number(requestOptions.deadlineAt);
    if (requestOptions.deadlineAt !== undefined && requestOptions.deadlineAt !== null &&
      Number.isFinite(deadlineAt)) {
      const remainingMs = Math.floor(deadlineAt - this.client.getCurrentTime());
      if (remainingMs <= 0) throw createRequestDeadlineError(deadlineAt);
      return {
        ...requestConfig,
        timeout: Math.min(this.client.requestTimeoutMs, remainingMs)
      };
    }
    return this.client.getRequestConfig(requestConfig);
  }


  getCurrentTime() {
    return typeof this.client.scheduler?.now === 'function' ? this.client.scheduler.now() : Date.now();
  }


  sleep(delayMs) {
    const setTimer = this.client.scheduler?.setTimer || ((callback, timeout) => setTimeout(callback, timeout));
    return new Promise(resolve => setTimer(resolve, Math.max(0, delayMs)));
  }


  getDeadlineRemainingMs(requestOptions = {}) {
    const deadlineAt = Number(requestOptions.deadlineAt);
    if (requestOptions.deadlineAt === undefined || requestOptions.deadlineAt === null ||
      !Number.isFinite(deadlineAt)) return null;
    return Math.max(0, deadlineAt - this.client.getCurrentTime());
  }


  async waitBeforeRetry(delayMs, requestOptions = {}) {
    const remainingMs = this.client.getDeadlineRemainingMs(requestOptions);
    if (remainingMs !== null && remainingMs <= 0) {
      throw createRequestDeadlineError(requestOptions.deadlineAt);
    }
    await this.client.sleep(remainingMs === null ? delayMs : Math.min(delayMs, remainingMs));
    if (this.client.getDeadlineRemainingMs(requestOptions) === 0) {
      throw createRequestDeadlineError(requestOptions.deadlineAt);
    }
  }


  getSchedulerOptions(requestOptions = {}) {
    const priority = requestOptions.priority === 'risk' ? 'risk' : 'normal';
    const queueWaitTimeoutMs = requestOptions.queueWaitTimeoutMs ??
      (priority === 'risk' ? this.client.riskQueueTimeoutMs : this.client.normalQueueTimeoutMs);
    const schedulerOptions = {
      priority,
      signal: requestOptions.signal,
      priorityOrder: requestOptions.priorityOrder,
      rateLimitGroup: requestOptions.rateLimitGroup || 'all',
      rateLimitScope: requestOptions.rateLimitScope || 'process',
      queueWaitTimeoutMs,
      minRequestIntervalMs: this.client.minRequestInterval
    };
    const deadlineAt = Number(requestOptions.deadlineAt);
    if (requestOptions.deadlineAt !== undefined && requestOptions.deadlineAt !== null &&
      Number.isFinite(deadlineAt)) {
      schedulerOptions.deadlineAt = deadlineAt;
      schedulerOptions.queueWaitTimeoutMs = Math.min(
        queueWaitTimeoutMs,
        Math.max(0, deadlineAt - this.client.getCurrentTime())
      );
    }
    return schedulerOptions;
  }


  async scheduleRequest(requestFn, requestOptions = {}) {
    const schedulerOptions = this.client.getSchedulerOptions(requestOptions);
    const coordinatorBudgetMs = schedulerOptions.queueWaitTimeoutMs;
    const coordinatorBudgetStartedAt = process.hrtime.bigint();
    return this.client.scheduler.schedule(async startedAt => {
      if (this.client.rateCoordinator && schedulerOptions.rateLimitScope === 'ip') {
        let lease;
        const elapsedCoordinatorBudgetMs = Number(
          process.hrtime.bigint() - coordinatorBudgetStartedAt
        ) / 1_000_000;
        const remainingCoordinatorBudgetMs = Math.max(
          0,
          coordinatorBudgetMs - elapsedCoordinatorBudgetMs
        );
        try {
          lease = await this.client.rateCoordinator.acquireTurn({
            scope: 'ip',
            group: schedulerOptions.rateLimitGroup,
            priority: schedulerOptions.priority,
            priorityOrder: schedulerOptions.priorityOrder,
            deadlineAt: this.client.getCurrentTime() + remainingCoordinatorBudgetMs,
            queueWaitTimeoutMs: remainingCoordinatorBudgetMs,
            minRequestIntervalMs: schedulerOptions.minRequestIntervalMs,
            signal: schedulerOptions.signal
          });
          this.client.rateCoordinatorAvailable = true;
          this.client.rateCoordinatorFailureCode = null;
          this.client.lastRequestTime = this.client.getCurrentTime();
        } catch (error) {
          this.client.rateCoordinatorAvailable = false;
          this.client.rateCoordinatorFailureCode = error?.code?.startsWith?.('UPBIT_RATE_COORDINATOR_')
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

      this.client.lastRequestTime = startedAt;
      return requestFn();
    }, schedulerOptions);
  }


  async applyRateLimitBackoff(error, attempt = 0, requestOptions = {}) {
    const headers = error.response?.headers;
    const retryAfterHeader = getHeader(headers, 'Retry-After');
    const remaining = parseRemainingReq(getHeader(headers, 'Remaining-Req'));
    const retryAfterMs = getRetryAfterMs(retryAfterHeader, this.client.getCurrentTime());
    const waitTime = Math.max(
      retryAfterMs,
      Math.pow(2, attempt) * 2000 + Math.floor(this.client.random() * 250)
    );
    this.client.scheduler.applyBackoff(waitTime, {
      rateLimitGroup: remaining?.group || requestOptions.rateLimitGroup,
      rateLimitScope: requestOptions.rateLimitScope
    });
    if (this.client.rateCoordinator && requestOptions.rateLimitScope === 'ip') {
      try {
        await this.client.rateCoordinator.applyBackoff(waitTime, {
          scope: 'ip',
          group: remaining?.group || requestOptions.rateLimitGroup
        });
        this.client.rateCoordinatorAvailable = true;
        this.client.rateCoordinatorFailureCode = null;
      } catch (coordinatorError) {
        this.client.rateCoordinatorAvailable = false;
        this.client.rateCoordinatorFailureCode = coordinatorError?.code?.startsWith?.('UPBIT_RATE_COORDINATOR_')
          ? coordinatorError.code
          : 'UPBIT_RATE_COORDINATOR_UNAVAILABLE';
        throw coordinatorError;
      }
    }
    return waitTime;
  }


  async applyTemporaryBlockBackoff(error, requestOptions = {}) {
    const { durationMs, source } = getTemporaryBlockDurationMs(error, this.client.getCurrentTime());
    this.client.scheduler.applyBackoff(durationMs, {
      rateLimitScope: requestOptions.rateLimitScope,
      rateLimitScopeWide: true
    });
    if (this.client.rateCoordinator && requestOptions.rateLimitScope === 'ip') {
      try {
        await this.client.rateCoordinator.applyBackoff(durationMs, {
          scope: 'ip',
          scopeWide: true
        });
        this.client.rateCoordinatorAvailable = true;
        this.client.rateCoordinatorFailureCode = null;
      } catch (coordinatorError) {
        this.client.rateCoordinatorAvailable = false;
        this.client.rateCoordinatorFailureCode = coordinatorError?.code?.startsWith?.('UPBIT_RATE_COORDINATOR_')
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
    const now = this.client.getCurrentTime();
    this.client.scheduler.applyBackoff(getNextSecondBoundaryDelayMs(now), {
      rateLimitGroup: parsed.group,
      rateLimitScope: requestOptions.rateLimitScope
    });
    if (this.client.rateCoordinator && requestOptions.rateLimitScope === 'ip') {
      try {
        await this.client.rateCoordinator.observeRemaining(parsed.group, parsed.remaining);
        this.client.rateCoordinatorAvailable = true;
        this.client.rateCoordinatorFailureCode = null;
      } catch (error) {
        this.client.rateCoordinatorAvailable = false;
        this.client.rateCoordinatorFailureCode = error?.code?.startsWith?.('UPBIT_RATE_COORDINATOR_')
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
    await this.client.scheduleRequest(() => undefined, options);
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
    return this.client.scheduleRequest(requestFn, {
      priority: priorityName,
      priorityOrder: Number.isFinite(numericPriority) ? numericPriority : 0
    });
  }

  /**
   * 요청 큐 순차 처리
   */

  async processQueue() {
    if (this.client.isProcessingQueue) return;
    this.client.isProcessingQueue = true;
    try {
      while (this.client.requestQueue.length > 0) {
        const request = this.client.requestQueue.shift();
        const numericPriority = Number(request.priority);
        const priority = request.priority === 'risk' || numericPriority <= 0 ? 'risk' : 'normal';
        try {
          const result = await this.client.scheduleRequest(request.fn, {
            priority,
            priorityOrder: Number.isFinite(numericPriority) ? numericPriority : 0
          });
          request.resolve(result);
        } catch (error) {
          request.reject(error);
        }
      }
    } finally {
      this.client.isProcessingQueue = false;
    }
  }

  /**
   * 큐 상태 조회
   */

  getQueueStatus() {
    const shared = this.client.scheduler.getStatus();
    return {
      queueLength: shared.queuedTotal + this.client.requestQueue.length,
      isProcessing: this.client.isProcessingQueue || shared.queuedTotal > 0 || shared.inFlightTotal > 0,
      lastRequestTime: this.client.lastRequestTime,
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
      rateCoordinatorRequired: this.client.rateCoordinatorRequired,
      rateCoordinatorEnabled: Boolean(this.client.rateCoordinator),
      rateCoordinatorAvailable: this.client.rateCoordinatorAvailable,
      rateCoordinatorFailureCode: this.client.rateCoordinatorFailureCode
    };
  }


  async getRateCoordinatorStatus() {
    if (!this.client.rateCoordinator) {
      return {
        required: this.client.rateCoordinatorRequired,
        enabled: false,
        available: null,
        failureCode: null
      };
    }

    try {
      const status = await this.client.rateCoordinator.getStatus();
      if (!status || status.available !== true) {
        const unavailable = new Error('Shared Upbit rate coordinator is unavailable.');
        unavailable.code = status?.failureCode || 'UPBIT_RATE_COORDINATOR_UNAVAILABLE';
        throw unavailable;
      }
      this.client.rateCoordinatorAvailable = true;
      this.client.rateCoordinatorFailureCode = null;
      const asNonNegativeInteger = value => {
        if (value === null || value === undefined || value === '') return null;
        const number = Number(value);
        return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
      };
      return {
        required: this.client.rateCoordinatorRequired,
        enabled: true,
        available: true,
        failureCode: null,
        queuedTotal: asNonNegativeInteger(status.queuedTotal),
        inFlightTotal: asNonNegativeInteger(status.inFlightTotal),
        maxInFlight: asNonNegativeInteger(status.maxInFlight),
        nextStartInMs: asNonNegativeInteger(status.nextStartInMs)
      };
    } catch (error) {
      this.client.rateCoordinatorAvailable = false;
      this.client.rateCoordinatorFailureCode = error?.code?.startsWith?.('UPBIT_RATE_COORDINATOR_')
        ? error.code
        : 'UPBIT_RATE_COORDINATOR_UNAVAILABLE';
      return {
        required: this.client.rateCoordinatorRequired,
        enabled: true,
        available: false,
        failureCode: this.client.rateCoordinatorFailureCode
      };
    }
  }


  async assertRateCoordinatorReady() {
    const status = await this.client.getRateCoordinatorStatus();
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
        const remainingMs = this.client.getDeadlineRemainingMs(requestOptions);
        if (remainingMs !== null && remainingMs <= 0) {
          throw createRequestDeadlineError(requestOptions.deadlineAt);
        }
        const result = await this.client.scheduleRequest(requestFn, requestOptions);
        if (this.client.getDeadlineRemainingMs(requestOptions) === 0) {
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
            const { durationMs, source } = await this.client.applyTemporaryBlockBackoff(error, requestOptions);
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
            waitTime = await this.client.applyRateLimitBackoff(error, attempt, requestOptions);
            console.log(`Rate limited. Waiting ${waitTime}ms before retry (${attempt + 1}/${attempts})`);
          } finally {
            const lease = error?.[RATE_COORDINATOR_LEASE];
            if (lease) {
              delete error[RATE_COORDINATOR_LEASE];
              await lease.release();
            }
          }
          if (this.client.getDeadlineRemainingMs(requestOptions) === 0) {
            throw createRequestDeadlineError(requestOptions.deadlineAt);
          }
          if (attempt < attempts - 1) continue;
          throw error;
        }

        if (this.client.getDeadlineRemainingMs(requestOptions) === 0) {
          throw createRequestDeadlineError(requestOptions.deadlineAt);
        }

        // 서버 에러 (5xx) - 재시도
        if (status >= 500 && attempt < attempts - 1) {
          const waitTime = Math.pow(2, attempt) * 500;
          console.log(`Server error (${status}). Waiting ${waitTime}ms before retry (${attempt + 1}/${attempts})`);
          await this.client.waitBeforeRetry(waitTime, requestOptions);
          continue;
        }

        // 네트워크 에러 - 재시도
        if (['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE', 'ECONNABORTED', 'EAI_AGAIN', 'ENETRESET'].includes(error.code)) {
          if (attempt < attempts - 1) {
            const waitTime = Math.pow(2, attempt) * 1000;
            console.log(`Network error (${error.code}). Waiting ${waitTime}ms before retry (${attempt + 1}/${attempts})`);
            await this.client.waitBeforeRetry(waitTime, requestOptions);
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
      access_key: this.client.accessKey,
      nonce: uuidv4(),
    };

    if (query) {
      const queryString = serializeQueryString(query);
      const hash = crypto.createHash('sha512');
      const queryHash = hash.update(queryString, 'utf-8').digest('hex');
      payload.query_hash = queryHash;
      payload.query_hash_alg = 'SHA512';
    }

    return jwt.sign(payload, this.client.secretKey, { algorithm: 'HS512' });
  }

  /**
   * 마켓 코드 조회
   */
}
