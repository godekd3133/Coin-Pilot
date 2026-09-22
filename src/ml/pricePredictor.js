/**
 * 머신러닝 기반 가격 예측 모델
 * Linear Regression, Moving Average Convergence 등을 사용한 간단한 예측
 */

class PricePredictor {
  constructor(config = {}) {
    this.config = {
      windowSize: config.windowSize || 20,
      predictionHorizon: config.predictionHorizon || 5, // 5개 캔들 미래 예측
      ...config
    };

    this.model = null;
    this.trainingData = [];
  }

  /**
   * 특징 추출 (Feature Engineering)
   */
  extractFeatures(candles, index) {
    if (index < this.config.windowSize) {
      return null;
    }

    const window = candles.slice(index - this.config.windowSize, index);
    const features = [];

    // 1. 이동평균들
    const ma5 = this.calculateMA(window, 5);
    const ma10 = this.calculateMA(window, 10);
    const ma20 = this.calculateMA(window, 20);

    features.push(ma5, ma10, ma20);

    // 2. 가격 변화율
    const priceChange = (window[window.length - 1].trade_price - window[0].trade_price) / window[0].trade_price;
    features.push(priceChange);

    // 3. 거래량 변화율
    const volumeChange = (window[window.length - 1].candle_acc_trade_volume - window[0].candle_acc_trade_volume) / window[0].candle_acc_trade_volume;
    features.push(volumeChange);

    // 4. 변동성 (표준편차)
    const prices = window.map(c => c.trade_price);
    const volatility = this.calculateStdDev(prices);
    features.push(volatility);

    // 5. 최근 추세
    const recentTrend = (window[window.length - 1].trade_price - window[window.length - 5].trade_price) / window[window.length - 5].trade_price;
    features.push(recentTrend);

    // 6. 고가/저가 범위
    const highLowRange = (window[window.length - 1].high_price - window[window.length - 1].low_price) / window[window.length - 1].low_price;
    features.push(highLowRange);

    // 7. 현재가
    const currentPrice = window[window.length - 1].trade_price;
    features.push(currentPrice);

    return features;
  }

  /**
   * 데이터 준비
   */
  prepareTrainingData(candles) {
    const X = [];
    const y = [];

    for (let i = this.config.windowSize; i < candles.length - this.config.predictionHorizon; i++) {
      const features = this.extractFeatures(candles, i);

      if (features) {
        const futurePrice = candles[i + this.config.predictionHorizon].trade_price;
        const currentPrice = candles[i].trade_price;
        const priceChange = (futurePrice - currentPrice) / currentPrice;

        X.push(features);
        y.push(priceChange);
      }
    }

    return { X, y };
  }

  /**
   * 선형 회귀 학습 (간단한 구현)
   */
  trainLinearRegression(X, y) {
    // 정규방정식을 사용한 선형 회귀
    // β = (X^T X)^-1 X^T y

    // X에 bias 항 추가
    const X_with_bias = X.map(row => [1, ...row]);

    // X^T 계산
    const X_T = this.transpose(X_with_bias);

    // X^T X 계산
    const XTX = this.matrixMultiply(X_T, X_with_bias);

    // X^T y 계산
    const XTy = this.matrixVectorMultiply(X_T, y);

    // (X^T X)^-1 계산 (간단한 역행렬)
    const XTX_inv = this.inverseMatrix(XTX);

    // β = (X^T X)^-1 X^T y
    const weights = this.matrixVectorMultiply(XTX_inv, XTy);

    return weights;
  }

  /**
   * 모델 학습
   */
  train(candles) {
    console.log('\n🤖 머신러닝 모델 학습 시작...');
    console.log(`캔들 데이터: ${candles.length}개`);

    const { X, y } = this.prepareTrainingData(candles);

    console.log(`학습 데이터: ${X.length}개`);

    if (X.length < 50) {
      console.log('⚠️  학습 데이터 부족 (최소 50개 필요)');
      return null;
    }

    try {
      this.model = this.trainLinearRegression(X, y);
      console.log('✅ 모델 학습 완료');

      // 모델 평가
      const predictions = X.map(features => this.predict([1, ...features]));
      const mse = this.calculateMSE(y, predictions);
      const r2 = this.calculateR2(y, predictions);

      console.log(`MSE: ${mse.toFixed(6)}`);
      console.log(`R²: ${r2.toFixed(4)}`);

      this.trainingData = { X, y };

      return {
        mse,
        r2,
        trainingSize: X.length
      };
    } catch (error) {
      console.error('❌ 모델 학습 실패:', error.message);
      return null;
    }
  }

  /**
   * 예측
   */
  predict(features) {
    if (!this.model) {
      throw new Error('모델이 학습되지 않았습니다.');
    }

    let prediction = 0;
    for (let i = 0; i < this.model.length; i++) {
      prediction += this.model[i] * features[i];
    }

    return prediction;
  }

  /**
   * 가격 예측 (실제 사용)
   */
  predictPrice(candles) {
    if (!this.model) {
      return null;
    }

    const features = this.extractFeatures(candles, candles.length);

    if (!features) {
      return null;
    }

    const priceChange = this.predict([1, ...features]);
    const currentPrice = candles[candles.length - 1].trade_price;
    const predictedPrice = currentPrice * (1 + priceChange);

    return {
      currentPrice,
      predictedPrice,
      predictedChange: priceChange,
      predictedChangePercent: priceChange * 100,
      direction: priceChange > 0 ? 'UP' : 'DOWN',
      confidence: Math.min(Math.abs(priceChange) * 100, 100)
    };
  }

  /**
   * 추세 강도 분석
   */
  analyzeTrend(candles) {
    if (candles.length < this.config.windowSize) {
      return null;
    }

    const recentCandles = candles.slice(0, this.config.windowSize);
    const prices = recentCandles.map(c => c.trade_price);

    // 선형 회귀로 추세선 계산
    const x = Array.from({ length: prices.length }, (_, i) => i);
    const y = prices.reverse(); // 오래된 것부터

    const n = x.length;
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;

    // R² 계산
    const yMean = sumY / n;
    const ssTot = y.reduce((sum, yi) => sum + Math.pow(yi - yMean, 2), 0);
    const ssRes = y.reduce((sum, yi, i) => sum + Math.pow(yi - (slope * x[i] + intercept), 2), 0);
    const r2 = 1 - (ssRes / ssTot);

    return {
      slope,
      strength: Math.abs(r2),
      direction: slope > 0 ? 'UPTREND' : 'DOWNTREND',
      confidence: r2 * 100
    };
  }

  // === 수학 유틸리티 함수들 ===

  calculateMA(candles, period) {
    const prices = candles.slice(-period).map(c => c.trade_price);
    return prices.reduce((sum, p) => sum + p, 0) / prices.length;
  }

  calculateStdDev(values) {
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
    return Math.sqrt(variance);
  }

  transpose(matrix) {
    return matrix[0].map((_, i) => matrix.map(row => row[i]));
  }

  matrixMultiply(a, b) {
    const result = [];
    for (let i = 0; i < a.length; i++) {
      result[i] = [];
      for (let j = 0; j < b[0].length; j++) {
        let sum = 0;
        for (let k = 0; k < a[0].length; k++) {
          sum += a[i][k] * b[k][j];
        }
        result[i][j] = sum;
      }
    }
    return result;
  }

  matrixVectorMultiply(matrix, vector) {
    return matrix.map(row =>
      row.reduce((sum, val, i) => sum + val * vector[i], 0)
    );
  }

  inverseMatrix(matrix) {
    const n = matrix.length;
    const identity = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => i === j ? 1 : 0)
    );

    // 가우스-조던 소거법
    const augmented = matrix.map((row, i) => [...row, ...identity[i]]);

    for (let i = 0; i < n; i++) {
      // 피벗 찾기
      let maxRow = i;
      for (let j = i + 1; j < n; j++) {
        if (Math.abs(augmented[j][i]) > Math.abs(augmented[maxRow][i])) {
          maxRow = j;
        }
      }

      [augmented[i], augmented[maxRow]] = [augmented[maxRow], augmented[i]];

      // 정규화
      const pivot = augmented[i][i];
      if (Math.abs(pivot) < 1e-10) {
        throw new Error('행렬이 특이행렬입니다.');
      }

      for (let j = 0; j < 2 * n; j++) {
        augmented[i][j] /= pivot;
      }

      // 소거
      for (let j = 0; j < n; j++) {
        if (j !== i) {
          const factor = augmented[j][i];
          for (let k = 0; k < 2 * n; k++) {
            augmented[j][k] -= factor * augmented[i][k];
          }
        }
      }
    }

    return augmented.map(row => row.slice(n));
  }

  calculateMSE(actual, predicted) {
    const n = actual.length;
    const sumSquaredError = actual.reduce((sum, yi, i) =>
      sum + Math.pow(yi - predicted[i], 2), 0
    );
    return sumSquaredError / n;
  }

  calculateR2(actual, predicted) {
    const yMean = actual.reduce((sum, y) => sum + y, 0) / actual.length;
    const ssTot = actual.reduce((sum, y) => sum + Math.pow(y - yMean, 2), 0);
    const ssRes = actual.reduce((sum, y, i) => sum + Math.pow(y - predicted[i], 2), 0);
    return 1 - (ssRes / ssTot);
  }
}

export default PricePredictor;
