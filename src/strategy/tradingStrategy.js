/**
 * 매매 전략 결정 모듈
 * 차트 분석과 뉴스 분석을 종합하여 최종 매매 결정
 */

class TradingStrategy {
  constructor(config = {}) {
    this.config = {
      // 가중치 설정
      technicalWeight: config.technicalWeight || 0.6,
      newsWeight: config.newsWeight || 0.4,

      // 매매 임계값 (기본값 55로 낮춤 - 더 적극적 매수)
      buyThreshold: config.buyThreshold || 55,
      sellThreshold: config.sellThreshold || 55,

      // 매수 전용 모드 (SELL 신호 무시, 손절/익절만 동작)
      buyOnly: config.buyOnly || false,

      // 리스크 관리
      stopLossPercent: config.stopLossPercent || 5,
      takeProfitPercent: config.takeProfitPercent || 10,
      maxPositionSize: config.maxPositionSize || 0.3, // 전체 자산의 30%

      // 추세 확인
      trendConfirmationPeriod: config.trendConfirmationPeriod || 3,

      ...config
    };

    this.tradeHistory = [];
    this.currentPosition = null;
  }

  /**
   * 종합 분석 및 매매 결정
   * @param {Object} technicalAnalysis - 기술적 분석 결과
   * @param {Object} newsSentiment - 뉴스 감성 분석 결과
   * @param {Object} currentPrice - 현재 가격 정보
   * @returns {Object} 매매 결정
   */
  makeDecision(technicalAnalysis, newsSentiment, currentPrice) {
    if (!technicalAnalysis || !newsSentiment) {
      return {
        action: 'HOLD',
        reason: '분석 데이터 부족',
        confidence: 0
      };
    }

    // 기술적 분석 점수 계산 (0-100)
    const technicalScore = this.calculateTechnicalScore(technicalAnalysis);

    // 뉴스 감성 점수 계산 (0-100)
    const newsScore = this.calculateNewsScore(newsSentiment);

    // 가중 평균 점수
    const totalScore =
      (technicalScore * this.config.technicalWeight) +
      (newsScore * this.config.newsWeight);

    console.log('\n📊 매매 결정 분석:');
    console.log(`  기술적 분석 점수: ${technicalScore.toFixed(2)}/100`);
    console.log(`  뉴스 감성 점수: ${newsScore.toFixed(2)}/100`);
    console.log(`  종합 점수: ${totalScore.toFixed(2)}/100`);

    // 매매 결정
    let action = 'HOLD';
    let reason;
    let confidence;

    if (totalScore >= this.config.buyThreshold) {
      action = 'BUY';
      reason = this.generateBuyReason(technicalAnalysis, newsSentiment);
      confidence = (totalScore - this.config.buyThreshold) / (100 - this.config.buyThreshold);
    } else if (totalScore <= (100 - this.config.sellThreshold)) {
      // buyOnly 모드면 신호 기반 SELL 무시 (손절/익절만 허용)
      if (this.config.buyOnly) {
        reason = '매수전용 모드 - 매도 신호 무시';
        confidence = 0.5;
      } else {
        action = 'SELL';
        reason = this.generateSellReason(technicalAnalysis, newsSentiment);
        confidence = (this.config.sellThreshold - totalScore) / this.config.sellThreshold;
      }
    } else {
      reason = '명확한 신호 없음 - 관망';
      confidence = 0.5;
    }

    // 포지션이 있는 경우 손절/익절 확인 (buyOnly여도 손절/익절은 실행)
    if (this.currentPosition) {
      const positionCheck = this.checkPosition(currentPrice);
      if (positionCheck.shouldClose) {
        action = 'SELL';
        reason = positionCheck.reason;
        confidence = 1.0;
      }
    }

    // 신호 강도 계산
    const signalStrength = this.calculateSignalStrength(totalScore, action);

    return {
      action,
      reason,
      confidence: confidence.toFixed(2),
      signalStrength, // WEAK, MEDIUM, STRONG, VERY_STRONG
      scores: {
        technical: technicalScore.toFixed(2),
        news: newsScore.toFixed(2),
        total: totalScore.toFixed(2)
      },
      details: {
        technicalAnalysis,
        newsSentiment
      }
    };
  }

  /**
   * 신호 강도 계산 (공격적 설정)
   * @returns {Object} { level: 'WEAK'|'MEDIUM'|'STRONG'|'VERY_STRONG', multiplier: number }
   */
  calculateSignalStrength(totalScore, action) {
    let strength = { level: 'NONE', multiplier: 0, score: 0 };

    if (action === 'BUY') {
      const buyScore = totalScore - this.config.buyThreshold;
      if (buyScore >= 15) {
        strength = { level: 'VERY_STRONG', multiplier: 3.0, score: buyScore };
      } else if (buyScore >= 8) {
        strength = { level: 'STRONG', multiplier: 2.2, score: buyScore };
      } else if (buyScore >= 3) {
        strength = { level: 'MEDIUM', multiplier: 1.5, score: buyScore };
      } else if (buyScore >= 0) {
        strength = { level: 'WEAK', multiplier: 1.0, score: buyScore };
      }
    } else if (action === 'SELL') {
      const sellScore = (100 - this.config.sellThreshold) - totalScore;
      if (sellScore >= 15) {
        strength = { level: 'VERY_STRONG', multiplier: 3.0, score: sellScore };
      } else if (sellScore >= 8) {
        strength = { level: 'STRONG', multiplier: 2.2, score: sellScore };
      } else if (sellScore >= 3) {
        strength = { level: 'MEDIUM', multiplier: 1.5, score: sellScore };
      } else if (sellScore >= 0) {
        strength = { level: 'WEAK', multiplier: 1.0, score: sellScore };
      }
    }

    return strength;
  }

  /**
   * 기술적 분석 점수 계산
   */
  calculateTechnicalScore(analysis) {
    let score = 50; // 중립 시작

    const { indicators, signals } = analysis;

    // RSI 기반 점수
    const rsi = parseFloat(indicators.rsi);
    if (rsi < 30) {
      score += 15; // 과매도
    } else if (rsi > 70) {
      score -= 15; // 과매수
    } else {
      score += (50 - rsi) / 4; // 중간 영역
    }

    // MACD 기반 점수
    const macdHistogram = parseFloat(indicators.macd.histogram);
    if (macdHistogram > 0) {
      score += Math.min(macdHistogram * 2, 10);
    } else {
      score += Math.max(macdHistogram * 2, -10);
    }

    // 볼린저 밴드 기반 점수
    const bbCurrent = parseFloat(indicators.bollingerBands.current);
    const bbLower = parseFloat(indicators.bollingerBands.lower);
    const bbUpper = parseFloat(indicators.bollingerBands.upper);

    if (bbCurrent < bbLower) {
      score += 10; // 하단 밴드 이탈 - 매수 신호
    } else if (bbCurrent > bbUpper) {
      score -= 10; // 상단 밴드 이탈 - 매도 신호
    }

    // 이동평균 교차 신호
    if (indicators.crossover === 'golden') {
      score += 15; // 골든크로스
    } else if (indicators.crossover === 'dead') {
      score -= 15; // 데드크로스
    }

    // 거래량 분석
    if (indicators.volume.isHighVolume) {
      // 고거래량일 경우 신호 강화
      if (score > 50) {
        score += 5;
      } else if (score < 50) {
        score -= 5;
      }
    }

    // 신호 강도 반영
    score += (signals.buy - signals.sell) * 2;

    return Math.max(0, Math.min(100, score));
  }

  /**
   * 뉴스 감성 점수 계산
   */
  calculateNewsScore(sentiment) {
    let score = 50; // 중립 시작

    const avgScore = parseFloat(sentiment.score) || 0;

    // 감성 점수를 0-100 스케일로 변환
    // avgScore 범위: -5 ~ +5 정도로 가정
    score += avgScore * 5;

    // 긍정/부정 비율 반영 (없으면 0으로 처리)
    const positiveRatio = (parseFloat(sentiment.positiveRatio) || 0) / 100;
    const negativeRatio = (parseFloat(sentiment.negativeRatio) || 0) / 100;

    score += (positiveRatio - negativeRatio) * 20;

    // 전체 감성 평가 반영
    switch (sentiment.overall) {
      case 'very positive':
        score += 15;
        break;
      case 'positive':
        score += 8;
        break;
      case 'very negative':
        score -= 15;
        break;
      case 'negative':
        score -= 8;
        break;
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * 매수 이유 생성
   */
  generateBuyReason(technical, news) {
    const reasons = [];

    // 기술적 분석 이유
    if (technical.signals.buy > technical.signals.sell) {
      if (parseFloat(technical.indicators.rsi) < 30) {
        reasons.push('RSI 과매도');
      }
      if (technical.indicators.crossover === 'golden') {
        reasons.push('골든크로스');
      }
      if (parseFloat(technical.indicators.bollingerBands.current) < parseFloat(technical.indicators.bollingerBands.lower)) {
        reasons.push('볼린저밴드 하단 이탈');
      }
      if (parseFloat(technical.indicators.macd.histogram) > 0) {
        reasons.push('MACD 상승');
      }
    }

    // 뉴스 분석 이유
    if (news.overall === 'positive' || news.overall === 'very positive') {
      reasons.push(`긍정적 뉴스 심리 (${news.positiveRatio})`);
    }

    return reasons.join(', ') || '종합 매수 신호';
  }

  /**
   * 매도 이유 생성
   */
  generateSellReason(technical, news) {
    const reasons = [];

    // 기술적 분석 이유
    if (technical.signals.sell > technical.signals.buy) {
      if (parseFloat(technical.indicators.rsi) > 70) {
        reasons.push('RSI 과매수');
      }
      if (technical.indicators.crossover === 'dead') {
        reasons.push('데드크로스');
      }
      if (parseFloat(technical.indicators.bollingerBands.current) > parseFloat(technical.indicators.bollingerBands.upper)) {
        reasons.push('볼린저밴드 상단 이탈');
      }
      if (parseFloat(technical.indicators.macd.histogram) < 0) {
        reasons.push('MACD 하락');
      }
    }

    // 뉴스 분석 이유
    if (news.overall === 'negative' || news.overall === 'very negative') {
      reasons.push(`부정적 뉴스 심리 (${news.negativeRatio})`);
    }

    return reasons.join(', ') || '종합 매도 신호';
  }

  /**
   * 포지션 체크 (손절/익절)
   */
  checkPosition(currentPrice) {
    if (!this.currentPosition) {
      return { shouldClose: false };
    }

    const entryPrice = this.currentPosition.entryPrice;
    const priceChange = ((currentPrice - entryPrice) / entryPrice) * 100;

    // 손절
    if (priceChange <= -this.config.stopLossPercent) {
      return {
        shouldClose: true,
        reason: `손절 실행 (${priceChange.toFixed(2)}% 하락)`,
        type: 'STOP_LOSS'
      };
    }

    // 익절
    if (priceChange >= this.config.takeProfitPercent) {
      return {
        shouldClose: true,
        reason: `익절 실행 (${priceChange.toFixed(2)}% 상승)`,
        type: 'TAKE_PROFIT'
      };
    }

    return { shouldClose: false };
  }

  /**
   * 포지션 오픈
   */
  openPosition(price, amount, type = 'BUY') {
    this.currentPosition = {
      type,
      entryPrice: price,
      amount,
      entryTime: new Date(),
      id: Date.now()
    };

    this.tradeHistory.push({
      action: 'OPEN',
      ...this.currentPosition
    });

    console.log(`\n✅ 포지션 오픈: ${type} @ ${price} (수량: ${amount})`);
  }

  /**
   * 부분 매도 기록 (포지션 유지하면서 일부 수량 매도)
   * @param {number} price - 매도 가격
   * @param {number} soldAmount - 매도 수량
   * @param {string} reason - 매도 사유
   * @returns {Object|null} 부분 매도 기록
   */
  recordPartialSell(price, soldAmount, reason = '부분 매도') {
    if (!this.currentPosition) {
      console.log('부분 매도할 포지션이 없습니다.');
      return null;
    }

    if (soldAmount <= 0) {
      console.log('매도 수량이 0 이하입니다.');
      return null;
    }

    // 매도 수량이 보유 수량보다 크면 전체 매도로 처리
    if (soldAmount >= this.currentPosition.amount) {
      return this.closePosition(price, reason);
    }

    // 수수료 계산 (매수 시 수수료의 비율 + 매도 수수료)
    const FEE_RATE = 0.0005;
    const soldRatio = soldAmount / this.currentPosition.amount;
    const buyFeeForSold = this.currentPosition.entryPrice * soldAmount * FEE_RATE;
    const sellFee = price * soldAmount * FEE_RATE;
    const totalFee = buyFeeForSold + sellFee;

    // 부분 매도 수익 계산
    const grossProfit = (price - this.currentPosition.entryPrice) * soldAmount;
    const netProfit = grossProfit - totalFee;
    const netProfitPercent = (netProfit / (this.currentPosition.entryPrice * soldAmount)) * 100;

    const partialClose = {
      type: this.currentPosition.type,
      entryPrice: this.currentPosition.entryPrice,
      exitPrice: price,
      amount: soldAmount,
      originalAmount: this.currentPosition.amount,
      remainingAmount: this.currentPosition.amount - soldAmount,
      entryTime: this.currentPosition.entryTime,
      exitTime: new Date(),
      grossProfit,
      profit: netProfit,
      profitPercent: netProfitPercent,
      totalFee,
      reason,
      id: this.currentPosition.id
    };

    // 거래 이력에 부분 매도 기록
    this.tradeHistory.push({
      action: 'PARTIAL_CLOSE',
      ...partialClose
    });

    // 포지션 수량 감소
    this.currentPosition.amount -= soldAmount;

    console.log(`\n📉 부분 매도: ${soldAmount.toFixed(8)} (${(soldRatio * 100).toFixed(1)}%)`);
    console.log(`   ${netProfit > 0 ? '수익' : '손실'}: ${netProfitPercent.toFixed(2)}% (${netProfit.toFixed(0)} KRW)`);
    console.log(`   수수료: ${totalFee.toFixed(0)} KRW`);
    console.log(`   남은 수량: ${this.currentPosition.amount.toFixed(8)}`);

    return partialClose;
  }

  /**
   * 포지션 클로즈
   */
  closePosition(price, reason, options = {}) {
    if (!this.currentPosition) {
      console.log('닫을 포지션이 없습니다.');
      return null;
    }

    // 수수료 계산 (매수/매도 각 0.05%)
    const FEE_RATE = 0.0005;
    const buyFee = this.currentPosition.entryPrice * this.currentPosition.amount * FEE_RATE;
    const sellFee = price * this.currentPosition.amount * FEE_RATE;
    const totalFee = buyFee + sellFee;

    // 실제 수익 = (매도가 - 매수가) * 수량 - 총수수료
    const grossProfit = (price - this.currentPosition.entryPrice) * this.currentPosition.amount;
    const netProfit = options.netProfit !== undefined ? options.netProfit : (grossProfit - totalFee);
    const netProfitPercent = (netProfit / (this.currentPosition.entryPrice * this.currentPosition.amount)) * 100;

    const closedPosition = {
      ...this.currentPosition,
      exitPrice: price,
      exitTime: new Date(),
      grossProfit,
      profit: netProfit,
      profitPercent: netProfitPercent,
      totalFee,
      reason
    };

    this.tradeHistory.push({
      action: 'CLOSE',
      ...closedPosition
    });

    console.log(`\n💰 포지션 클로즈: ${netProfit > 0 ? '수익' : '손실'} ${netProfitPercent.toFixed(2)}% (${netProfit.toFixed(0)} KRW)`);
    console.log(`   수수료: ${totalFee.toFixed(0)} KRW (매수 ${buyFee.toFixed(0)} + 매도 ${sellFee.toFixed(0)})`);
    console.log(`   이유: ${reason}`);

    this.currentPosition = null;
    return closedPosition;
  }

  /**
   * 매매 이력 조회
   */
  getTradeHistory(limit = 10) {
    return this.tradeHistory.slice(-limit);
  }

  /**
   * 통계 정보 (CLOSE + PARTIAL_CLOSE 모두 포함)
   */
  getStatistics() {
    // 전체 매도 + 부분 매도 모두 포함
    const allSellTrades = this.tradeHistory.filter(t =>
      t.action === 'CLOSE' || t.action === 'PARTIAL_CLOSE'
    );

    if (allSellTrades.length === 0) {
      return { totalTrades: 0, winRate: 0, totalProfit: 0 };
    }

    const fullCloses = this.tradeHistory.filter(t => t.action === 'CLOSE');
    const partialCloses = this.tradeHistory.filter(t => t.action === 'PARTIAL_CLOSE');

    const winningTrades = allSellTrades.filter(t => t.profit > 0);
    const totalProfit = allSellTrades.reduce((sum, t) => sum + t.profit, 0);

    return {
      totalTrades: allSellTrades.length,
      fullCloses: fullCloses.length,
      partialCloses: partialCloses.length,
      winningTrades: winningTrades.length,
      losingTrades: allSellTrades.length - winningTrades.length,
      winRate: ((winningTrades.length / allSellTrades.length) * 100).toFixed(2) + '%',
      totalProfit: totalProfit.toFixed(0) + ' KRW',
      avgProfit: (totalProfit / allSellTrades.length).toFixed(0) + ' KRW'
    };
  }
}

export default TradingStrategy;
