import axios from 'axios';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

class UpbitAPI {
  constructor(accessKey, secretKey) {
    this.accessKey = accessKey;
    this.secretKey = secretKey;
    this.baseURL = 'https://api.upbit.com/v1';
    this.lastRequestTime = 0;
    this.minRequestInterval = 100; // 최소 100ms 간격 (초당 10회 - Upbit 제한)

    // 요청 큐 시스템
    this.requestQueue = [];
    this.isProcessingQueue = false;
    this.queueInterval = 120; // 큐 처리 간격 (120ms = 초당 약 8회, 여유분 포함)
  }

  /**
   * Rate limiting을 위한 대기
   */
  async waitForRateLimit() {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.minRequestInterval) {
      await new Promise(resolve => setTimeout(resolve, this.minRequestInterval - elapsed));
    }
    this.lastRequestTime = Date.now();
  }

  /**
   * 요청 큐에 추가하고 순차 처리
   * @param {Function} requestFn - 실행할 요청 함수
   * @param {number} priority - 우선순위 (낮을수록 먼저 처리, 기본 5)
   * @returns {Promise} 요청 결과
   */
  queueRequest(requestFn, priority = 5) {
    return new Promise((resolve, reject) => {
      this.requestQueue.push({
        fn: requestFn,
        priority,
        resolve,
        reject,
        addedAt: Date.now()
      });

      // 우선순위 정렬 (낮은 값이 먼저)
      this.requestQueue.sort((a, b) => a.priority - b.priority);

      // 큐 처리 시작
      this.processQueue();
    });
  }

  /**
   * 요청 큐 순차 처리
   */
  async processQueue() {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    while (this.requestQueue.length > 0) {
      const request = this.requestQueue.shift();

      try {
        await this.waitForRateLimit();
        const result = await request.fn();
        request.resolve(result);
      } catch (error) {
        request.reject(error);
      }

      // 큐 처리 간격 대기
      if (this.requestQueue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, this.queueInterval));
      }
    }

    this.isProcessingQueue = false;
  }

  /**
   * 큐 상태 조회
   */
  getQueueStatus() {
    return {
      queueLength: this.requestQueue.length,
      isProcessing: this.isProcessingQueue,
      lastRequestTime: this.lastRequestTime
    };
  }

  /**
   * 재시도 로직이 포함된 API 요청
   */
  async requestWithRetry(requestFn, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await this.waitForRateLimit();
        return await requestFn();
      } catch (error) {
        const status = error.response?.status;

        // Rate limit - 재시도
        if (status === 429) {
          const waitTime = Math.pow(2, attempt) * 1000;
          console.log(`Rate limited. Waiting ${waitTime}ms before retry (${attempt + 1}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        }

        // 서버 에러 (5xx) - 재시도
        if (status >= 500 && attempt < maxRetries - 1) {
          const waitTime = Math.pow(2, attempt) * 500;
          console.log(`Server error (${status}). Waiting ${waitTime}ms before retry (${attempt + 1}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        }

        // 네트워크 에러 - 재시도
        if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
          if (attempt < maxRetries - 1) {
            const waitTime = Math.pow(2, attempt) * 1000;
            console.log(`Network error (${error.code}). Waiting ${waitTime}ms before retry (${attempt + 1}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            continue;
          }
        }

        // 최종 실패
        throw error;
      }
    }
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
      const queryString = new URLSearchParams(query).toString();
      const hash = crypto.createHash('sha512');
      const queryHash = hash.update(queryString, 'utf-8').digest('hex');
      payload.query_hash = queryHash;
      payload.query_hash_alg = 'SHA512';
    }

    return jwt.sign(payload, this.secretKey);
  }

  /**
   * 마켓 코드 조회
   */
  async getMarkets() {
    try {
      const response = await axios.get(`${this.baseURL}/market/all`);
      return response.data;
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
   */
  async getMinuteCandles(market, unit = 5, count = 200) {
    return this.requestWithRetry(async () => {
      const response = await axios.get(
        `${this.baseURL}/candles/minutes/${unit}`,
        {
          params: { market, count }
        }
      );
      return response.data;
    });
  }

  /**
   * 일봉 캔들 조회
   */
  async getDayCandles(market, count = 200) {
    return this.requestWithRetry(async () => {
      const response = await axios.get(`${this.baseURL}/candles/days`, {
        params: { market, count }
      });
      return response.data;
    });
  }

  /**
   * 현재가 정보 조회
   */
  async getTicker(markets) {
    const marketString = Array.isArray(markets) ? markets.join(',') : markets;
    return this.requestWithRetry(async () => {
      const response = await axios.get(`${this.baseURL}/ticker`, {
        params: { markets: marketString }
      });
      return response.data;
    });
  }

  /**
   * 계좌 조회
   */
  async getAccounts() {
    return this.requestWithRetry(async () => {
      const token = this.generateToken();
      const response = await axios.get(`${this.baseURL}/accounts`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      return response.data;
    });
  }

  /**
   * 주문 가능 정보 조회
   */
  async getOrderChance(market) {
    return this.requestWithRetry(async () => {
      const query = { market };
      const token = this.generateToken(query);
      const response = await axios.get(`${this.baseURL}/orders/chance`, {
        params: query,
        headers: { Authorization: `Bearer ${token}` }
      });
      return response.data;
    });
  }

  /**
   * 주문하기
   * @param {string} market - 마켓 코드
   * @param {string} side - 주문 종류 (bid: 매수, ask: 매도)
   * @param {number} volume - 주문량
   * @param {number} price - 주문 가격
   * @param {string} ord_type - 주문 타입 (limit: 지정가, price: 시장가 매수, market: 시장가 매도)
   * @returns {Object} 주문 결과 { success: boolean, data?: OrderData, error?: ErrorInfo }
   */
  async order(market, side, volume, price = null, ord_type = 'limit') {
    const query = {
      market,
      side,
      ord_type
    };

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

    try {
      await this.waitForRateLimit();
      const token = this.generateToken(query);
      const response = await axios.post(`${this.baseURL}/orders`, query, {
        headers: { Authorization: `Bearer ${token}` }
      });
      return { success: true, data: response.data };
    } catch (error) {
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

      // 서버 에러나 네트워크 에러는 재시도
      if (error.response?.status >= 500 ||
          error.code === 'ECONNRESET' ||
          error.code === 'ETIMEDOUT') {
        console.log('Retrying order due to server/network error...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        try {
          await this.waitForRateLimit();
          const retryToken = this.generateToken(query);
          const retryResponse = await axios.post(`${this.baseURL}/orders`, query, {
            headers: { Authorization: `Bearer ${retryToken}` }
          });
          return { success: true, data: retryResponse.data };
        } catch (retryError) {
          const retryParsedError = this.parseApiError(retryError);
          return { success: false, error: retryParsedError };
        }
      }

      return { success: false, error: parsedError };
    }
  }

  /**
   * 주문 취소
   */
  async cancelOrder(uuid) {
    return this.requestWithRetry(async () => {
      const query = { uuid };
      const token = this.generateToken(query);
      const response = await axios.delete(`${this.baseURL}/order`, {
        params: query,
        headers: { Authorization: `Bearer ${token}` }
      });
      return response.data;
    });
  }

  /**
   * 주문 리스트 조회
   */
  async getOrders(market, state = 'wait') {
    return this.requestWithRetry(async () => {
      const query = { market, state };
      const token = this.generateToken(query);
      const response = await axios.get(`${this.baseURL}/orders`, {
        params: query,
        headers: { Authorization: `Bearer ${token}` }
      });
      return response.data;
    });
  }

  /**
   * 개별 주문 조회
   */
  async getOrder(uuid) {
    return this.requestWithRetry(async () => {
      const query = { uuid };
      const token = this.generateToken(query);
      const response = await axios.get(`${this.baseURL}/order`, {
        params: query,
        headers: { Authorization: `Bearer ${token}` }
      });
      return response.data;
    });
  }

  /**
   * 주문 상태 확인 및 대기
   * @param {string} uuid - 주문 UUID
   * @param {number} maxWaitMs - 최대 대기 시간 (기본 30초)
   * @param {number} checkIntervalMs - 확인 간격 (기본 1초)
   * @returns {Object} { filled: boolean, order: OrderData, error?: string }
   */
  async waitForOrderFill(uuid, maxWaitMs = 30000, checkIntervalMs = 1000) {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const order = await this.getOrder(uuid);

        if (!order) {
          return { filled: false, order: null, error: '주문 조회 실패' };
        }

        // 주문 상태 확인
        // done: 완료, cancel: 취소, wait: 체결 대기
        if (order.state === 'done') {
          return { filled: true, order };
        }

        if (order.state === 'cancel') {
          return { filled: false, order, error: '주문이 취소됨' };
        }

        // 부분 체결 확인
        const executedVolume = parseFloat(order.executed_volume || 0);
        const remainingVolume = parseFloat(order.remaining_volume || 0);

        if (executedVolume > 0 && remainingVolume === 0) {
          return { filled: true, order };
        }

        // 아직 체결 대기 중 - 대기
        await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
      } catch (error) {
        console.error(`주문 상태 확인 오류: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
      }
    }

    // 시간 초과
    try {
      const finalOrder = await this.getOrder(uuid);
      const executedVolume = parseFloat(finalOrder?.executed_volume || 0);

      if (executedVolume > 0) {
        return {
          filled: true,
          partial: parseFloat(finalOrder.remaining_volume || 0) > 0,
          order: finalOrder
        };
      }

      return { filled: false, order: finalOrder, error: '체결 대기 시간 초과' };
    } catch (error) {
      return { filled: false, order: null, error: `최종 확인 실패: ${error.message}` };
    }
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
