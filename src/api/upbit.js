import axios from 'axios';
import { sharedUpbitRequestScheduler } from './upbitRequestScheduler.js';
import { envRaw } from '../config/envConfig.js';
import { UpbitRequestPipeline } from './upbitRequestPipeline.js';
import {
  createFillDeadlineError,
  isSchedulerAdmissionError,
  resolveRateCoordinator
} from './upbitHttpTransport.js';

// Upbit documents progressively longer temporary 418 blocks but does not
// specify a fixed fallback duration. Keep every lane closed for five minutes
// when the response omits a trusted duration, and fail the current operation.
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
    this._pipeline = new UpbitRequestPipeline(this);
  }

  // 요청 파이프라인 위임 — 인스턴스 오버라이드를 위해 this.client.X를 거친다.
  getRequestConfig(...args) { return this._pipeline.getRequestConfig(...args); }
  getRequestConfigWithOptions(...args) { return this._pipeline.getRequestConfigWithOptions(...args); }
  getCurrentTime(...args) { return this._pipeline.getCurrentTime(...args); }
  sleep(...args) { return this._pipeline.sleep(...args); }
  getDeadlineRemainingMs(...args) { return this._pipeline.getDeadlineRemainingMs(...args); }
  waitBeforeRetry(...args) { return this._pipeline.waitBeforeRetry(...args); }
  getSchedulerOptions(...args) { return this._pipeline.getSchedulerOptions(...args); }
  scheduleRequest(...args) { return this._pipeline.scheduleRequest(...args); }
  applyRateLimitBackoff(...args) { return this._pipeline.applyRateLimitBackoff(...args); }
  applyTemporaryBlockBackoff(...args) { return this._pipeline.applyTemporaryBlockBackoff(...args); }
  observeRateLimitResponse(...args) { return this._pipeline.observeRateLimitResponse(...args); }
  waitForRateLimit(...args) { return this._pipeline.waitForRateLimit(...args); }
  queueRequest(...args) { return this._pipeline.queueRequest(...args); }
  processQueue(...args) { return this._pipeline.processQueue(...args); }
  getQueueStatus(...args) { return this._pipeline.getQueueStatus(...args); }
  getRateCoordinatorStatus(...args) { return this._pipeline.getRateCoordinatorStatus(...args); }
  assertRateCoordinatorReady(...args) { return this._pipeline.assertRateCoordinatorReady(...args); }
  requestWithRetry(...args) { return this._pipeline.requestWithRetry(...args); }
  parseApiError(...args) { return this._pipeline.parseApiError(...args); }
  generateToken(...args) { return this._pipeline.generateToken(...args); }

  /**
   * 모든 Upbit HTTP 요청에 유한한 timeout을 강제한다.
   * 응답이 오지 않는 소켓 때문에 forward paper cycle 전체가 멈추지 않도록
   * 네트워크 경계에서 실패를 반환하게 한다.
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
