import UpbitAPI from '../api/upbit.js';
import { comprehensiveAnalysis } from '../analysis/technicalIndicators.js';
import NewsMonitor from '../analysis/newsMonitor.js';
import TradingStrategy from '../strategy/tradingStrategy.js';

class AutoTrader {
  constructor(config) {
    this.config = config;
    this.upbit = new UpbitAPI(config.accessKey, config.secretKey);
    this.newsMonitor = new NewsMonitor();
    this.strategy = new TradingStrategy({
      stopLossPercent: config.stopLossPercent,
      takeProfitPercent: config.takeProfitPercent,
      buyThreshold: config.buyThreshold || 55,  // 기본값 55로 적극적 매수
      sellThreshold: config.sellThreshold || 55,
      buyOnly: config.buyOnly || false  // 매수 전용 모드
    });

    this.isRunning = false;
    this.dryRun = config.dryRun !== false; // 기본값 true
    this.lastNewsCheck = null;
    this.newsData = null;
  }

  /**
   * 자동매매 시작
   */
  async start() {
    console.log('\n🚀 자동매매 시스템 시작');
    console.log(`모드: ${this.dryRun ? '모의투자' : '실전투자'}`);
    console.log(`타겟 코인: ${this.config.targetCoin}`);
    console.log('─'.repeat(80));

    this.isRunning = true;

    // 초기 뉴스 수집
    await this.updateNews();

    // 주기적 실행
    while (this.isRunning) {
      try {
        await this.executeTradingCycle();
        await this.sleep(this.config.checkInterval || 60000); // 기본 1분
      } catch (error) {
        console.error('\n❌ 매매 사이클 오류:', error.message);
        await this.sleep(10000); // 오류 시 10초 대기
      }
    }
  }

  /**
   * 자동매매 중지
   */
  stop() {
    console.log('\n⏹️  자동매매 시스템 중지');
    this.isRunning = false;
  }

  /**
   * 매매 사이클 실행
   */
  async executeTradingCycle() {
    const now = new Date();
    console.log(`\n⏰ [${now.toLocaleString('ko-KR')}] 매매 분석 시작`);

    // 1. 계좌 조회
    const accounts = await this.getAccountInfo();
    const krwBalance = this.getKRWBalance(accounts);
    const coinBalance = this.getCoinBalance(accounts, this.config.targetCoin);

    console.log(`\n💰 계좌 정보:`);
    console.log(`  KRW: ${Number(krwBalance).toLocaleString()} 원`);
    console.log(`  ${this.config.targetCoin}: ${coinBalance}`);

    // 2. 현재가 조회
    const ticker = await this.upbit.getTicker(this.config.targetCoin);
    const currentPrice = ticker[0].trade_price;
    console.log(`  현재가: ${currentPrice.toLocaleString()} 원`);

    // 3. 캔들 데이터 조회
    const candles = await this.upbit.getMinuteCandles(this.config.targetCoin, 5, 200);

    // 4. 기술적 분석
    const technicalAnalysis = comprehensiveAnalysis(candles, {
      rsiPeriod: this.config.rsiPeriod || 14,
      rsiOversold: this.config.rsiOversold || 30,
      rsiOverbought: this.config.rsiOverbought || 70
    });

    if (!technicalAnalysis) {
      console.log('⚠️  기술적 분석 실패');
      return;
    }

    console.log('\n📈 기술적 분석 결과:');
    console.log(`  RSI: ${technicalAnalysis.indicators.rsi}`);
    console.log(`  MACD: ${technicalAnalysis.indicators.macd.macd} / Signal: ${technicalAnalysis.indicators.macd.signal}`);
    console.log(`  볼린저밴드: 상단 ${technicalAnalysis.indicators.bollingerBands.upper} / 하단 ${technicalAnalysis.indicators.bollingerBands.lower}`);
    console.log(`  이동평균 교차: ${technicalAnalysis.indicators.crossover}`);
    console.log(`  기술적 추천: ${technicalAnalysis.signals.recommendation}`);

    // 5. 뉴스 분석 (5분마다 업데이트)
    await this.updateNews();

    if (!this.newsData) {
      console.log('⚠️  뉴스 데이터 없음');
      return;
    }

    const newsSentiment = this.newsMonitor.analyzeMarketSentiment(this.newsData);
    console.log('\n📰 뉴스 감성 분석:');
    console.log(`  전체 심리: ${newsSentiment.overall}`);
    console.log(`  감성 점수: ${newsSentiment.score}`);
    console.log(`  긍정 비율: ${newsSentiment.positiveRatio}`);
    console.log(`  뉴스 추천: ${newsSentiment.recommendation}`);

    // 6. 매매 결정
    const decision = this.strategy.makeDecision(
      technicalAnalysis,
      newsSentiment,
      currentPrice
    );

    console.log('\n🎯 최종 매매 결정:');
    console.log(`  행동: ${decision.action}`);
    console.log(`  신뢰도: ${decision.confidence}`);
    console.log(`  이유: ${decision.reason}`);

    // 7. 주문 실행
    await this.executeOrder(decision, currentPrice, krwBalance, coinBalance);

    // 8. 통계 출력
    this.printStatistics();
  }

  /**
   * 주문 실행
   */
  async executeOrder(decision, currentPrice, krwBalance, coinBalance) {
    if (decision.action === 'HOLD') {
      console.log('\n⏸️  거래 없음 - 관망');
      return;
    }

    if (decision.action === 'BUY') {
      // 매수 가능 금액 확인
      const investmentAmount = Math.min(
        this.config.investmentAmount || 10000,
        krwBalance * 0.95 // 수수료 고려
      );

      if (investmentAmount < 5000) {
        console.log('\n⚠️  매수 불가: 잔액 부족');
        return;
      }

      if (this.strategy.currentPosition) {
        console.log('\n⚠️  이미 포지션 보유중');
        return;
      }

      const volume = investmentAmount / currentPrice;

      if (this.dryRun) {
        console.log('\n🧪 [모의투자] 매수 주문');
        console.log(`  금액: ${investmentAmount.toLocaleString()} 원`);
        console.log(`  수량: ${volume.toFixed(8)}`);
        console.log(`  가격: ${currentPrice.toLocaleString()} 원`);

        this.strategy.openPosition(currentPrice, volume, 'BUY');
      } else {
        console.log('\n💵 실제 매수 주문 실행');
        try {
          const order = await this.upbit.order(
            this.config.targetCoin,
            'bid',
            investmentAmount,
            null,
            'price'
          );
          console.log(`  주문 완료: ${order.uuid}`);
          this.strategy.openPosition(currentPrice, volume, 'BUY');
        } catch (error) {
          console.error(`  주문 실패: ${error.message}`);
        }
      }
    }

    if (decision.action === 'SELL') {
      if (!this.strategy.currentPosition && coinBalance === 0) {
        console.log('\n⚠️  매도 불가: 보유 수량 없음');
        return;
      }

      const sellVolume = this.strategy.currentPosition
        ? this.strategy.currentPosition.amount
        : coinBalance;

      if (this.dryRun) {
        console.log('\n🧪 [모의투자] 매도 주문');
        console.log(`  수량: ${sellVolume.toFixed(8)}`);
        console.log(`  예상 금액: ${(sellVolume * currentPrice).toLocaleString()} 원`);

        this.strategy.closePosition(currentPrice, decision.reason);
      } else {
        console.log('\n💰 실제 매도 주문 실행');
        try {
          const order = await this.upbit.order(
            this.config.targetCoin,
            'ask',
            sellVolume,
            null,
            'market'
          );
          console.log(`  주문 완료: ${order.uuid}`);
          this.strategy.closePosition(currentPrice, decision.reason);
        } catch (error) {
          console.error(`  주문 실패: ${error.message}`);
        }
      }
    }
  }

  /**
   * 뉴스 업데이트 (5분마다)
   */
  async updateNews() {
    const now = Date.now();
    const newsInterval = this.config.newsCheckInterval || 300000; // 기본 5분

    if (!this.lastNewsCheck || (now - this.lastNewsCheck) > newsInterval) {
      console.log('\n📡 뉴스 업데이트 중...');
      this.newsData = await this.newsMonitor.collectAndAnalyzeNews();
      this.lastNewsCheck = now;

      // 긴급 뉴스 확인
      const urgentNews = this.newsMonitor.detectUrgentNews(this.newsData);
      if (urgentNews.length > 0) {
        console.log('\n🚨 긴급 뉴스 감지!');
        urgentNews.slice(0, 3).forEach((news, i) => {
          console.log(`  ${i + 1}. ${news.title}`);
        });
      }
    }
  }

  /**
   * 계좌 정보 조회
   */
  async getAccountInfo() {
    if (this.dryRun) {
      // 모의투자용 가상 계좌
      return [
        { currency: 'KRW', balance: '1000000', locked: '0', avg_buy_price: '0' }
      ];
    }

    return await this.upbit.getAccounts();
  }

  /**
   * KRW 잔액 조회
   */
  getKRWBalance(accounts) {
    const krwAccount = accounts.find(acc => acc.currency === 'KRW');
    return krwAccount ? parseFloat(krwAccount.balance) : 0;
  }

  /**
   * 코인 잔액 조회
   */
  getCoinBalance(accounts, market) {
    const coinSymbol = market.split('-')[1];
    const coinAccount = accounts.find(acc => acc.currency === coinSymbol);
    return coinAccount ? parseFloat(coinAccount.balance) : 0;
  }

  /**
   * 통계 출력
   */
  printStatistics() {
    const stats = this.strategy.getStatistics();

    if (stats.totalTrades > 0) {
      console.log('\n📊 거래 통계:');
      console.log(`  총 거래: ${stats.totalTrades}회`);
      console.log(`  승률: ${stats.winRate}`);
      console.log(`  총 손익: ${stats.totalProfit}`);
      console.log(`  평균 손익: ${stats.avgProfit}`);
    }

    if (this.strategy.currentPosition) {
      console.log('\n📍 현재 포지션:');
      console.log(`  진입가: ${this.strategy.currentPosition.entryPrice.toLocaleString()} 원`);
      console.log(`  수량: ${this.strategy.currentPosition.amount.toFixed(8)}`);
      console.log(`  진입시간: ${this.strategy.currentPosition.entryTime.toLocaleString('ko-KR')}`);
    }
  }

  /**
   * 대기
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default AutoTrader;
