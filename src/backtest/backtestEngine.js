import { comprehensiveAnalysis } from '../analysis/technicalIndicators.js';
import TradingStrategy from '../strategy/tradingStrategy.js';

class BacktestEngine {
  constructor(config = {}) {
    this.config = {
      initialBalance: config.initialBalance || 1000000,
      tradingFee: config.tradingFee || 0.0005, // 0.05%
      slippage: config.slippage || 0.001, // 0.1%
      ...config
    };

    this.results = [];
    this.trades = [];
  }

  /**
   * 백테스팅 실행
   * @param {Array} historicalData - 과거 캔들 데이터
   * @param {Object} strategyConfig - 전략 설정
   * @returns {Object} 백테스팅 결과
   */
  async run(historicalData, strategyConfig) {
    console.log('\n🔄 백테스팅 시작...');
    console.log(`기간: ${historicalData.length}개 캔들`);
    console.log(`초기 자본: ${this.config.initialBalance.toLocaleString()} 원`);

    const strategy = new TradingStrategy(strategyConfig);
    let balance = this.config.initialBalance;
    let position = null;
    const trades = [];
    const balanceHistory = [];

    // 최소 200개의 캔들이 필요 (기술적 분석용)
    const minCandles = 200;

    for (let i = minCandles; i < historicalData.length; i++) {
      const currentCandles = historicalData.slice(i - minCandles, i).reverse();
      const currentCandle = historicalData[i];
      const currentPrice = currentCandle.trade_price;

      // 기술적 분석
      const technicalAnalysis = comprehensiveAnalysis(currentCandles, {
        rsiPeriod: strategyConfig.rsiPeriod || 14,
        rsiOversold: strategyConfig.rsiOversold || 30,
        rsiOverbought: strategyConfig.rsiOverbought || 70
      });

      if (!technicalAnalysis) continue;

      // 뉴스 분석은 백테스팅에서 제외 (과거 데이터 없음)
      const mockNewsSentiment = {
        overall: 'neutral',
        score: 0,
        positiveCount: 0,
        negativeCount: 0,
        neutralCount: 1,
        positiveRatio: '33.3%',
        negativeRatio: '33.3%',
        recommendation: 'HOLD',
        totalNews: 1
      };

      // 매매 결정
      const decision = strategy.makeDecision(
        technicalAnalysis,
        mockNewsSentiment,
        currentPrice
      );

      // 포지션 체크 (손절/익절)
      if (position) {
        const positionCheck = strategy.checkPosition(currentPrice);
        if (positionCheck.shouldClose) {
          // 포지션 청산
          const sellPrice = this.applySlippage(currentPrice, 'sell');
          const sellAmount = position.amount * sellPrice;
          const fee = sellAmount * this.config.tradingFee;
          balance += sellAmount - fee;

          const profit = (sellPrice - position.entryPrice) * position.amount;
          const profitPercent = ((sellPrice - position.entryPrice) / position.entryPrice) * 100;

          trades.push({
            type: 'CLOSE',
            reason: positionCheck.reason,
            entryPrice: position.entryPrice,
            exitPrice: sellPrice,
            amount: position.amount,
            profit,
            profitPercent,
            balance,
            timestamp: currentCandle.candle_date_time_kst
          });

          position = null;
          strategy.currentPosition = null;
        }
      }

      // 매수 신호
      if (decision.action === 'BUY' && !position && balance > 0) {
        const investAmount = Math.min(
          strategyConfig.investmentAmount || balance * 0.1,
          balance * 0.95
        );

        if (investAmount >= 5000) {
          const buyPrice = this.applySlippage(currentPrice, 'buy');
          const fee = investAmount * this.config.tradingFee;
          const amount = (investAmount - fee) / buyPrice;

          balance -= investAmount;
          position = {
            entryPrice: buyPrice,
            amount,
            entryTime: currentCandle.candle_date_time_kst
          };

          strategy.currentPosition = position;

          trades.push({
            type: 'OPEN',
            entryPrice: buyPrice,
            amount,
            investAmount,
            balance,
            reason: decision.reason,
            timestamp: currentCandle.candle_date_time_kst
          });
        }
      }

      // 매도 신호
      if (decision.action === 'SELL' && position) {
        const sellPrice = this.applySlippage(currentPrice, 'sell');
        const sellAmount = position.amount * sellPrice;
        const fee = sellAmount * this.config.tradingFee;
        balance += sellAmount - fee;

        const profit = (sellPrice - position.entryPrice) * position.amount;
        const profitPercent = ((sellPrice - position.entryPrice) / position.entryPrice) * 100;

        trades.push({
          type: 'CLOSE',
          reason: decision.reason,
          entryPrice: position.entryPrice,
          exitPrice: sellPrice,
          amount: position.amount,
          profit,
          profitPercent,
          balance,
          timestamp: currentCandle.candle_date_time_kst
        });

        position = null;
        strategy.currentPosition = null;
      }

      // 잔고 히스토리 기록
      const currentValue = balance + (position ? position.amount * currentPrice : 0);
      balanceHistory.push({
        timestamp: currentCandle.candle_date_time_kst,
        balance: currentValue,
        price: currentPrice
      });
    }

    // 마지막 포지션 정리
    if (position) {
      const lastPrice = historicalData[historicalData.length - 1].trade_price;
      const sellAmount = position.amount * lastPrice;
      const fee = sellAmount * this.config.tradingFee;
      balance += sellAmount - fee;

      const profit = (lastPrice - position.entryPrice) * position.amount;
      const profitPercent = ((lastPrice - position.entryPrice) / position.entryPrice) * 100;

      trades.push({
        type: 'CLOSE',
        reason: '백테스팅 종료',
        entryPrice: position.entryPrice,
        exitPrice: lastPrice,
        amount: position.amount,
        profit,
        profitPercent,
        balance,
        timestamp: historicalData[historicalData.length - 1].candle_date_time_kst
      });
    }

    // 결과 계산
    const result = this.calculateResults(trades, balance, balanceHistory, strategyConfig);
    this.results.push(result);
    this.trades = trades;

    return result;
  }

  /**
   * 슬리피지 적용
   */
  applySlippage(price, side) {
    if (side === 'buy') {
      return price * (1 + this.config.slippage);
    } else {
      return price * (1 - this.config.slippage);
    }
  }

  /**
   * 백테스팅 결과 계산
   */
  calculateResults(trades, finalBalance, balanceHistory, config) {
    const closedTrades = trades.filter(t => t.type === 'CLOSE');

    if (closedTrades.length === 0) {
      return {
        config,
        initialBalance: this.config.initialBalance,
        finalBalance,
        totalReturn: 0,
        totalReturnPercent: 0,
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
        avgProfit: 0,
        avgWin: 0,
        avgLoss: 0,
        maxDrawdown: 0,
        sharpeRatio: 0,
        profitFactor: 0,
        balanceHistory
      };
    }

    const totalReturn = finalBalance - this.config.initialBalance;
    const totalReturnPercent = (totalReturn / this.config.initialBalance) * 100;

    const winningTrades = closedTrades.filter(t => t.profit > 0);
    const losingTrades = closedTrades.filter(t => t.profit <= 0);

    const totalProfit = closedTrades.reduce((sum, t) => sum + t.profit, 0);
    const avgProfit = totalProfit / closedTrades.length;

    const totalWin = winningTrades.reduce((sum, t) => sum + t.profit, 0);
    const totalLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.profit, 0));

    const avgWin = winningTrades.length > 0 ? totalWin / winningTrades.length : 0;
    const avgLoss = losingTrades.length > 0 ? totalLoss / losingTrades.length : 0;

    const winRate = (winningTrades.length / closedTrades.length) * 100;
    const profitFactor = totalLoss > 0 ? totalWin / totalLoss : totalWin > 0 ? Infinity : 0;

    // 최대 낙폭 (Maximum Drawdown) 계산
    const maxDrawdown = this.calculateMaxDrawdown(balanceHistory);

    // 샤프 비율 계산
    const sharpeRatio = this.calculateSharpeRatio(balanceHistory);

    return {
      config,
      initialBalance: this.config.initialBalance,
      finalBalance,
      totalReturn,
      totalReturnPercent,
      totalTrades: closedTrades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate,
      avgProfit,
      avgWin,
      avgLoss,
      maxDrawdown,
      sharpeRatio,
      profitFactor,
      bestTrade: this.findBestTrade(closedTrades),
      worstTrade: this.findWorstTrade(closedTrades),
      balanceHistory,
      trades: closedTrades
    };
  }

  /**
   * 최대 낙폭 계산
   */
  calculateMaxDrawdown(balanceHistory) {
    let maxDrawdown = 0;
    let peak = balanceHistory[0].balance;

    for (const point of balanceHistory) {
      if (point.balance > peak) {
        peak = point.balance;
      }

      const drawdown = ((peak - point.balance) / peak) * 100;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }

    return maxDrawdown;
  }

  /**
   * 샤프 비율 계산
   */
  calculateSharpeRatio(balanceHistory) {
    if (balanceHistory.length < 2) return 0;

    const returns = [];
    for (let i = 1; i < balanceHistory.length; i++) {
      const ret = (balanceHistory[i].balance - balanceHistory[i - 1].balance) / balanceHistory[i - 1].balance;
      returns.push(ret);
    }

    const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);

    // 무위험 수익률을 0으로 가정
    const sharpe = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(365) : 0;

    return sharpe;
  }

  /**
   * 최고 수익 거래 찾기
   */
  findBestTrade(trades) {
    if (trades.length === 0) return null;
    return trades.reduce((best, trade) =>
      trade.profit > (best?.profit || -Infinity) ? trade : best
    );
  }

  /**
   * 최악 손실 거래 찾기
   */
  findWorstTrade(trades) {
    if (trades.length === 0) return null;
    return trades.reduce((worst, trade) =>
      trade.profit < (worst?.profit || Infinity) ? trade : worst
    );
  }

  /**
   * 결과 출력
   */
  printResults(result) {
    console.log('\n' + '='.repeat(80));
    console.log('📊 백테스팅 결과');
    console.log('='.repeat(80));
    console.log(`\n💰 수익성:`);
    console.log(`  초기 자본: ${result.initialBalance.toLocaleString()} 원`);
    console.log(`  최종 자본: ${result.finalBalance.toLocaleString()} 원`);
    console.log(`  총 수익: ${result.totalReturn.toLocaleString()} 원 (${result.totalReturnPercent.toFixed(2)}%)`);

    console.log(`\n📈 거래 통계:`);
    console.log(`  총 거래 횟수: ${result.totalTrades}`);
    console.log(`  승리 거래: ${result.winningTrades} (${result.winRate.toFixed(2)}%)`);
    console.log(`  패배 거래: ${result.losingTrades}`);
    console.log(`  평균 수익: ${result.avgProfit.toLocaleString()} 원`);
    console.log(`  평균 승리: ${result.avgWin.toLocaleString()} 원`);
    console.log(`  평균 손실: ${result.avgLoss.toLocaleString()} 원`);

    console.log(`\n📉 리스크 지표:`);
    console.log(`  최대 낙폭: ${result.maxDrawdown.toFixed(2)}%`);
    console.log(`  샤프 비율: ${result.sharpeRatio.toFixed(2)}`);
    console.log(`  수익 팩터: ${result.profitFactor === Infinity ? '∞' : result.profitFactor.toFixed(2)}`);

    if (result.bestTrade) {
      console.log(`\n🏆 최고 수익 거래:`);
      console.log(`  수익: ${result.bestTrade.profit.toLocaleString()} 원 (${result.bestTrade.profitPercent.toFixed(2)}%)`);
      console.log(`  진입: ${result.bestTrade.entryPrice.toLocaleString()} → 청산: ${result.bestTrade.exitPrice.toLocaleString()}`);
    }

    if (result.worstTrade) {
      console.log(`\n📉 최대 손실 거래:`);
      console.log(`  손실: ${result.worstTrade.profit.toLocaleString()} 원 (${result.worstTrade.profitPercent.toFixed(2)}%)`);
      console.log(`  진입: ${result.worstTrade.entryPrice.toLocaleString()} → 청산: ${result.worstTrade.exitPrice.toLocaleString()}`);
    }

    console.log('\n' + '='.repeat(80));
  }

  /**
   * 여러 전략 비교 백테스팅
   */
  async compareStrategies(historicalData, strategies) {
    console.log(`\n🔬 ${strategies.length}개 전략 비교 분석 시작...`);

    const results = [];

    for (let i = 0; i < strategies.length; i++) {
      console.log(`\n[${i + 1}/${strategies.length}] 전략 테스트 중...`);
      const result = await this.run(historicalData, strategies[i]);
      results.push(result);
    }

    // 결과를 수익률 기준으로 정렬
    results.sort((a, b) => b.totalReturnPercent - a.totalReturnPercent);

    console.log('\n' + '='.repeat(80));
    console.log('🏆 전략 비교 결과 (수익률 순)');
    console.log('='.repeat(80));

    results.forEach((result, index) => {
      console.log(`\n${index + 1}. 전략 #${index + 1}`);
      console.log(`  수익률: ${result.totalReturnPercent.toFixed(2)}%`);
      console.log(`  승률: ${result.winRate.toFixed(2)}%`);
      console.log(`  거래 횟수: ${result.totalTrades}`);
      console.log(`  최대 낙폭: ${result.maxDrawdown.toFixed(2)}%`);
      console.log(`  샤프 비율: ${result.sharpeRatio.toFixed(2)}`);
      console.log(`  설정: RSI ${result.config.rsiPeriod}/${result.config.rsiOversold}/${result.config.rsiOverbought}, 손절 ${result.config.stopLossPercent}%, 익절 ${result.config.takeProfitPercent}%`);
    });

    console.log('\n' + '='.repeat(80));

    return results;
  }
}

export default BacktestEngine;
