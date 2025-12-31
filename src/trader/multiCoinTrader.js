import UpbitAPI from '../api/upbit.js';
import { comprehensiveAnalysis } from '../analysis/technicalIndicators.js';
import NewsMonitor from '../analysis/newsMonitor.js';
import TradingStrategy from '../strategy/tradingStrategy.js';
import fs from 'fs';

class MultiCoinTrader {
  constructor(config) {
    this.config = config;
    this.upbit = new UpbitAPI(config.accessKey, config.secretKey);
    this.newsMonitor = new NewsMonitor();

    // 각 코인별 전략 인스턴스
    this.strategies = new Map();
    this.targetCoins = config.targetCoins || ['KRW-BTC', 'KRW-ETH'];

    // 전략 설정 (공통) - 최적화 파라미터 포함
    this.strategyConfig = {
      stopLossPercent: config.stopLossPercent || 5,
      takeProfitPercent: config.takeProfitPercent || 10,
      buyThreshold: config.buyThreshold || 55,  // 기본값 55로 낮춤 (더 적극적 매수)
      sellThreshold: config.sellThreshold || 55,
      technicalWeight: config.technicalWeight || 0.6,
      newsWeight: config.newsWeight || 0.4,
      buyOnly: config.buyOnly || false,  // 매수 전용 모드
      allowAveraging: config.allowAveraging !== false  // 기존 포지션에 추가 매수 허용 (기본: true)
    };

    // 추가 매수 허용 옵션 저장
    this.allowAveraging = config.allowAveraging !== false;

    // 전략은 필요할 때 동적으로 생성 (메모리 효율화)
    // 많은 코인을 분석할 때는 모든 코인에 미리 생성하지 않음
    if (this.targetCoins.length <= 20) {
      this.targetCoins.forEach(coin => {
        this.strategies.set(coin, new TradingStrategy(this.strategyConfig));
      });
    }

    this.isRunning = false;
    this.dryRun = config.dryRun !== false;
    this.lastNewsCheck = null;
    this.newsData = null;

    // 리밸런싱 쿨다운 관리
    this.lastRebalanceTime = null;

    // 포트폴리오 관리
    this.maxPositions = config.maxPositions || 1000;
    this.portfolioAllocation = config.portfolioAllocation || 0.3; // 각 코인에 최대 30% 할당

    // 드라이 모드 가상 포트폴리오
    this.virtualPortfolio = {
      krwBalance: config.dryRunSeedMoney || 10000000,
      holdings: new Map() // coin -> { amount, avgPrice }
    };

    // 초기 시드머니 저장 (누적손익 계산용)
    if (this.dryRun) {
      this.initialSeedMoney = config.dryRunSeedMoney || 10000000;
    } else {
      // 실전 모드: 환경변수로 설정하거나 자동 계산
      this.initialSeedMoney = config.initialSeedMoney || 0;
    }

    // 드라이 모드일 경우 저장된 포트폴리오 로드
    if (this.dryRun) {
      this.loadVirtualPortfolio();
    } else {
      // 실전 모드: 초기 시드머니 파일에서 로드
      this.loadInitialSeedMoney();
    }

    // 동적 투자금액 설정 (비율 기반으로 단순화)
    this.investmentRatio = config.investmentRatio || 0.05; // 총 자산의 5%를 기본 투자 비율로
    this.MIN_ORDER_AMOUNT = 5000; // 업비트 최소 주문 금액 (고정)

    // 거래 알림 콜백 (대시보드에서 설정)
    this.onTradeCallback = null;
  }

  /**
   * 거래 알림 콜백 설정
   */
  setTradeCallback(callback) {
    this.onTradeCallback = callback;
  }

  /**
   * 거래 알림 전송
   */
  notifyTrade(tradeInfo) {
    if (this.onTradeCallback) {
      try {
        this.onTradeCallback(tradeInfo);
      } catch (e) {
        console.error('거래 알림 콜백 오류:', e.message);
      }
    }
  }

  /**
   * 코인별 전략 가져오기 (없으면 동적 생성)
   */
  getStrategy(coin) {
    if (!this.strategies.has(coin)) {
      this.strategies.set(coin, new TradingStrategy(this.strategyConfig));
    }
    return this.strategies.get(coin);
  }

  /**
   * 총 자산 계산 (KRW + 코인 평가액) - 드라이/실전 모드 모두 지원
   */
  async calculateTotalAssets() {
    if (this.dryRun) {
      // 드라이 모드: 가상 포트폴리오 사용
      let totalAssets = this.virtualPortfolio.krwBalance;

      const holdingCoins = Array.from(this.virtualPortfolio.holdings.keys());
      if (holdingCoins.length > 0) {
        try {
          const tickers = await this.upbit.getTicker(holdingCoins);
          // ticker 응답 유효성 검사
          if (tickers && Array.isArray(tickers) && tickers.length > 0) {
            for (const ticker of tickers) {
              if (ticker && ticker.market && typeof ticker.trade_price === 'number') {
                const holding = this.virtualPortfolio.holdings.get(ticker.market);
                if (holding) {
                  totalAssets += ticker.trade_price * holding.amount;
                }
              }
            }
          } else {
            // ticker 조회 실패 시 평균매입가로 계산
            for (const holding of this.virtualPortfolio.holdings.values()) {
              totalAssets += holding.avgPrice * holding.amount;
            }
          }
        } catch (error) {
          for (const holding of this.virtualPortfolio.holdings.values()) {
            totalAssets += holding.avgPrice * holding.amount;
          }
        }
      }
      return totalAssets;
    } else {
      // 실전 모드: 실제 업비트 계좌 잔액 사용
      const accounts = await this.upbit.getAccounts();
      if (!accounts || !Array.isArray(accounts)) {
        console.error('계좌 조회 실패');
        return 0;
      }

      let totalAssets = 0;

      // KRW 잔액
      const krwAccount = accounts.find(acc => acc.currency === 'KRW');
      if (krwAccount) {
        totalAssets += parseFloat(krwAccount.balance) + parseFloat(krwAccount.locked || 0);
      }

      // 보유 코인 평가액
      const coinAccounts = accounts.filter(acc => acc.currency !== 'KRW' && parseFloat(acc.balance) > 0);
      if (coinAccounts.length > 0) {
        const coinMarkets = coinAccounts.map(acc => `KRW-${acc.currency}`);
        try {
          const tickers = await this.upbit.getTicker(coinMarkets);
          // ticker 응답 유효성 검사
          if (tickers && Array.isArray(tickers) && tickers.length > 0) {
            for (const ticker of tickers) {
              if (ticker && ticker.market && typeof ticker.trade_price === 'number') {
                const coinSymbol = ticker.market.split('-')[1];
                const coinAccount = accounts.find(acc => acc.currency === coinSymbol);
                if (coinAccount) {
                  const balance = parseFloat(coinAccount.balance) + parseFloat(coinAccount.locked || 0);
                  totalAssets += ticker.trade_price * balance;
                }
              }
            }
          } else {
            // ticker 조회 실패 시 평균매입가로 계산
            for (const acc of coinAccounts) {
              const balance = parseFloat(acc.balance) + parseFloat(acc.locked || 0);
              totalAssets += parseFloat(acc.avg_buy_price || 0) * balance;
            }
          }
        } catch (error) {
          // 현재가 조회 실패 시 평균매입가로 계산
          for (const acc of coinAccounts) {
            const balance = parseFloat(acc.balance) + parseFloat(acc.locked || 0);
            totalAssets += parseFloat(acc.avg_buy_price || 0) * balance;
          }
        }
      }
      return totalAssets;
    }
  }

  /**
   * 현재 보유 중인 코인 목록 반환 (백테스팅용)
   */
  async getHeldCoins() {
    if (this.dryRun) {
      // 드라이 모드: 가상 포트폴리오에서 보유 코인 목록 반환
      return Array.from(this.virtualPortfolio.holdings.keys());
    } else {
      // 실전 모드: 실제 업비트 계좌에서 보유 코인 목록 반환
      try {
        const accounts = await this.upbit.getAccounts();
        if (!accounts || !Array.isArray(accounts)) {
          return [];
        }
        return accounts
          .filter(acc => acc.currency !== 'KRW' && parseFloat(acc.balance) > 0)
          .map(acc => `KRW-${acc.currency}`);
      } catch (error) {
        console.error('보유 코인 조회 실패:', error.message);
        return [];
      }
    }
  }

  /**
   * 동적 투자금액 계산 (비율 기반으로 단순화)
   * @param {number} totalAssets - 총 자산
   * @param {Object} signalStrength - 신호 강도 { level, multiplier, score }
   */
  async calculateDynamicInvestmentAmount(totalAssets = null, signalStrength = null) {
    // 총 자산이 전달되지 않으면 계산
    if (totalAssets === null) {
      totalAssets = await this.calculateTotalAssets();
    }

    // 투자금액: 총 자산의 investmentRatio
    let dynamicAmount = totalAssets * this.investmentRatio;

    // 신호 강도에 따른 배수 적용
    if (signalStrength && signalStrength.multiplier > 0) {
      dynamicAmount *= signalStrength.multiplier;
      console.log(`  📊 신호 강도: ${signalStrength.level} (x${signalStrength.multiplier})`);
    }

    // 최소 주문 금액 체크 (업비트 최소 5,000원)
    dynamicAmount = Math.max(this.MIN_ORDER_AMOUNT, dynamicAmount);

    return Math.floor(dynamicAmount);
  }

  /**
   * 누적손익 계산
   */
  async calculateCumulativePnL() {
    const totalAssets = await this.calculateTotalAssets();
    const profit = totalAssets - this.initialSeedMoney;
    const profitPercent = this.initialSeedMoney > 0
      ? ((totalAssets / this.initialSeedMoney) - 1) * 100
      : 0;

    return {
      initialSeedMoney: this.initialSeedMoney,
      totalAssets: Math.round(totalAssets),
      profit: Math.round(profit),
      profitPercent: profitPercent,
      mode: this.dryRun ? 'DRY_RUN' : 'LIVE'
    };
  }

  /**
   * 실전 모드용 초기 시드머니 로드/저장
   */
  loadInitialSeedMoney() {
    const seedFile = 'initial_seed_money.json';

    if (fs.existsSync(seedFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
        if (data.initialSeedMoney > 0) {
          this.initialSeedMoney = data.initialSeedMoney;
          console.log(`📂 초기 시드머니 로드됨: ${this.initialSeedMoney.toLocaleString()}원`);
          console.log(`   기록일: ${data.recordedAt || '알 수 없음'}`);
        }
      } catch (error) {
        console.log('⚠️  초기 시드머니 로드 실패:', error.message);
      }
    }
  }

  /**
   * 실전 모드용 초기 시드머니 저장 (최초 1회만)
   */
  async saveInitialSeedMoney() {
    if (this.dryRun) return;

    const seedFile = 'initial_seed_money.json';

    // 이미 저장된 파일이 있으면 스킵
    if (fs.existsSync(seedFile)) {
      return;
    }

    // 현재 총 자산을 초기 시드머니로 저장
    const totalAssets = await this.calculateTotalAssets();

    const data = {
      initialSeedMoney: Math.round(totalAssets),
      recordedAt: new Date().toISOString(),
      note: '실전 모드 초기 투자금 (자동 기록)'
    };

    fs.writeFileSync(seedFile, JSON.stringify(data, null, 2), 'utf8');
    this.initialSeedMoney = data.initialSeedMoney;
    console.log(`💾 초기 시드머니 저장됨: ${this.initialSeedMoney.toLocaleString()}원`);
  }

  /**
   * 가상 포트폴리오 저장 (드라이 모드)
   */
  saveVirtualPortfolio() {
    if (!this.dryRun) return;

    const portfolioFile = 'dry_portfolio.json';
    const data = {
      krwBalance: this.virtualPortfolio.krwBalance,
      holdings: {},
      positions: {},
      tradeHistory: {},
      initialSeedMoney: this.initialSeedMoney,
      updatedAt: new Date().toISOString()
    };

    // holdings 저장 (entryTime 포함하여 저장) + 해당 코인의 포지션/이력도 함께 저장
    for (const [coin, holding] of this.virtualPortfolio.holdings.entries()) {
      const strategy = this.strategies.get(coin);
      data.holdings[coin] = {
        amount: holding.amount,
        avgPrice: holding.avgPrice,
        // strategy에서 entryTime 가져오거나 기존 값 유지
        entryTime: strategy?.currentPosition?.entryTime || holding.entryTime || new Date().toISOString()
      };

      // 해당 코인의 포지션도 함께 저장 (holdings와 positions 동기화)
      if (strategy?.currentPosition) {
        data.positions[coin] = strategy.currentPosition;
      }

      // 해당 코인의 거래 이력도 함께 저장
      if (strategy?.tradeHistory?.length > 0) {
        data.tradeHistory[coin] = strategy.tradeHistory;
      }
    }

    // 추가로 holdings에 없지만 전략에 거래 이력이 있는 코인들도 저장 (매도 완료된 코인 이력 보존)
    for (const [coin, strategy] of this.strategies.entries()) {
      if (!data.tradeHistory[coin] && strategy.tradeHistory?.length > 0) {
        data.tradeHistory[coin] = strategy.tradeHistory;
      }
    }

    fs.writeFileSync(portfolioFile, JSON.stringify(data, null, 2), 'utf8');
    console.log('💾 가상 포트폴리오 저장됨');
  }

  /**
   * 가상 포트폴리오 리셋 (드라이 모드)
   * @param {number} seedMoney - 새로운 시드머니 (기본: 1000만원)
   */
  resetVirtualPortfolio(seedMoney = 10000000) {
    if (!this.dryRun) {
      console.log('⚠️  실전 모드에서는 포트폴리오 리셋이 불가능합니다');
      return false;
    }

    console.log('\n🔄 가상 포트폴리오 리셋 중...');

    // 가상 포트폴리오 초기화
    this.virtualPortfolio = {
      krwBalance: seedMoney,
      holdings: new Map()
    };

    // 초기 시드머니 업데이트
    this.initialSeedMoney = seedMoney;

    // 모든 전략 인스턴스 초기화
    for (const [, strategy] of this.strategies.entries()) {
      strategy.currentPosition = null;
      strategy.tradeHistory = [];
    }

    // 파일 저장
    const portfolioFile = 'dry_portfolio.json';
    const data = {
      krwBalance: seedMoney,
      holdings: {},
      positions: {},
      tradeHistory: {},
      initialSeedMoney: seedMoney,
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(portfolioFile, JSON.stringify(data, null, 2), 'utf8');

    console.log(`✅ 포트폴리오 리셋 완료!`);
    console.log(`   시드머니: ${seedMoney.toLocaleString()}원`);
    console.log(`   보유 코인: 0개`);

    return true;
  }

  /**
   * 가상 포트폴리오 로드 (드라이 모드)
   */
  loadVirtualPortfolio() {
    const portfolioFile = 'dry_portfolio.json';

    if (fs.existsSync(portfolioFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(portfolioFile, 'utf8'));
        this.virtualPortfolio.krwBalance = data.krwBalance;
        this.virtualPortfolio.holdings = new Map(Object.entries(data.holdings || {}));

        // 저장된 초기 시드머니 로드 (없으면 현재 설정값 유지)
        if (data.initialSeedMoney) {
          this.initialSeedMoney = data.initialSeedMoney;
        }

        // 전략의 포지션과 거래 이력 복원
        if (data.positions) {
          for (const [coin, position] of Object.entries(data.positions)) {
            const strategy = this.getStrategy(coin);
            if (strategy) {
              // JSON에서 로드된 날짜 문자열을 Date 객체로 변환
              if (position.entryTime && typeof position.entryTime === 'string') {
                position.entryTime = new Date(position.entryTime);
              }
              strategy.currentPosition = position;
            }
          }
        }

        // tradeHistory 하위 호환성 처리
        // 구버전: tradeHistory가 배열 [] 형태
        // 신버전: tradeHistory가 객체 { coin: [...] } 형태
        if (data.tradeHistory) {
          if (Array.isArray(data.tradeHistory)) {
            // 구버전 형태 (배열): 배열 내 각 거래에서 코인 정보를 추출하여 분류
            console.log('   🔄 구버전 tradeHistory 형식 감지 - 마이그레이션 중...');
            const migratedHistory = {};
            for (const trade of data.tradeHistory) {
              // 거래 기록에서 코인 정보 추출 시도
              const coin = trade.market || trade.coin || null;
              if (coin) {
                if (!migratedHistory[coin]) {
                  migratedHistory[coin] = [];
                }
                migratedHistory[coin].push({
                  ...trade,
                  entryTime: trade.entryTime ? new Date(trade.entryTime) : undefined,
                  exitTime: trade.exitTime ? new Date(trade.exitTime) : undefined
                });
              }
            }
            // 마이그레이션된 이력 적용
            for (const [coin, history] of Object.entries(migratedHistory)) {
              const strategy = this.getStrategy(coin);
              if (strategy) {
                strategy.tradeHistory = history;
              }
            }
          } else {
            // 신버전 형태 (객체)
            for (const [coin, history] of Object.entries(data.tradeHistory)) {
              const strategy = this.getStrategy(coin);
              if (strategy && Array.isArray(history)) {
                // 거래 이력의 날짜들도 Date 객체로 변환
                strategy.tradeHistory = history.map(trade => ({
                  ...trade,
                  entryTime: trade.entryTime ? new Date(trade.entryTime) : undefined,
                  exitTime: trade.exitTime ? new Date(trade.exitTime) : undefined
                }));
              }
            }
          }
        }

        // holdings와 positions 동기화 (holdings에 있는데 positions가 없는 경우)
        let syncedCount = 0;
        for (const [coin, holding] of this.virtualPortfolio.holdings.entries()) {
          if (holding.amount > 0) {
            const strategy = this.getStrategy(coin);
            if (strategy && !strategy.currentPosition) {
              // holdings에서 position 생성
              strategy.currentPosition = {
                type: 'BUY',
                entryPrice: holding.avgPrice,
                amount: holding.amount,
                entryTime: holding.entryTime ? new Date(holding.entryTime) : new Date(),
                id: Date.now() + syncedCount
              };
              syncedCount++;
            }
          }
        }

        // 구버전 파일 형식 감지 시 신버전으로 자동 마이그레이션
        const needsMigration = Array.isArray(data.tradeHistory) ||
                              data.lastSaved !== undefined ||
                              data.initialSeedMoney === undefined;

        console.log('📂 가상 포트폴리오 로드됨 (dry_portfolio.json)');
        console.log(`   KRW 잔액: ${this.virtualPortfolio.krwBalance.toLocaleString()} 원`);
        console.log(`   보유 코인: ${this.virtualPortfolio.holdings.size}개`);
        if (syncedCount > 0) {
          console.log(`   🔄 포지션 동기화: ${syncedCount}개 복원됨`);
        }
        console.log(`   마지막 저장: ${data.updatedAt || data.lastSaved || '알 수 없음'}`);

        // 마이그레이션 필요 시 신버전 형식으로 즉시 저장
        if (needsMigration || syncedCount > 0) {
          console.log('   📝 신버전 형식으로 포트폴리오 마이그레이션 저장...');
          this.saveVirtualPortfolio();
        }
      } catch (error) {
        console.log('⚠️  가상 포트폴리오 로드 실패:', error.message);
      }
    }
  }

  /**
   * 다중 코인 자동매매 시작
   */
  async start() {
    console.log('\n🚀 다중 코인 자동매매 시스템 시작');
    console.log(`모드: ${this.dryRun ? '모의투자' : '실전투자'}`);

    console.log(`분석 대상: ${this.targetCoins.length}개 코인`);

    console.log(`포지션 제한: 무제한 (공격적 모드)`);

    // 투자 비율 표시
    console.log(`투자 비율: 총자산의 ${(this.investmentRatio * 100).toFixed(1)}% (최소 ${this.MIN_ORDER_AMOUNT.toLocaleString()}원)`);

    // 실전 모드: 초기 시드머니 자동 기록 (최초 1회)
    if (!this.dryRun && this.initialSeedMoney === 0) {
      await this.saveInitialSeedMoney();
    }

    // 초기 시드머니 표시
    if (this.initialSeedMoney > 0) {
      console.log(`초기 시드머니: ${this.initialSeedMoney.toLocaleString()}원`);
    }

    console.log('─'.repeat(80));

    this.isRunning = true;

    // 초기 뉴스 수집
    await this.updateNews();

    // 주기적 실행
    while (this.isRunning) {
      try {
        await this.executeTradingCycle();
        await this.sleep(this.config.checkInterval || 60000);
      } catch (error) {
        console.error('\n❌ 매매 사이클 오류:', error.message);
        await this.sleep(10000);
      }
    }
  }

  /**
   * 중지
   */
  stop() {
    console.log('\n⏹️  다중 코인 자동매매 시스템 중지');
    this.isRunning = false;
  }

  /**
   * 실전 모드: 거래소 실제 잔고와 내부 상태 동기화
   * 주문 후 실제 체결 결과와 내부 포지션 상태 불일치 방지
   */
  async syncWithExchange() {
    if (this.dryRun) return; // 모의투자는 동기화 불필요

    try {
      console.log(`\n🔄 거래소 잔고 동기화 중...`);

      const accounts = await this.upbit.getAccounts();
      const exchangeHoldings = new Map();

      // 거래소 실제 보유량 수집
      for (const acc of accounts) {
        if (acc.currency === 'KRW') continue;

        const balance = parseFloat(acc.balance || 0);
        const locked = parseFloat(acc.locked || 0);
        const totalBalance = balance + locked;

        if (totalBalance > 0) {
          const market = `KRW-${acc.currency}`;
          exchangeHoldings.set(market, {
            balance: totalBalance,
            avgPrice: parseFloat(acc.avg_buy_price || 0)
          });
        }
      }

      // 내부 상태와 비교
      let syncIssues = 0;

      for (const [coin, strategy] of this.strategies.entries()) {
        const exchangeData = exchangeHoldings.get(coin);
        const internalPosition = strategy.currentPosition;

        if (internalPosition && !exchangeData) {
          // 내부에는 포지션 있지만 거래소에 없음 - 이미 팔린 것
          console.log(`  ⚠️  [${coin}] 동기화: 내부 포지션 있지만 거래소에 없음 → 포지션 제거`);
          strategy.closePosition(internalPosition.entryPrice, '거래소 동기화: 보유량 없음');
          syncIssues++;
        } else if (!internalPosition && exchangeData && exchangeData.balance > 0) {
          // 거래소에는 있지만 내부에 없음 - 수동 매수 또는 동기화 누락
          const minValue = exchangeData.balance * exchangeData.avgPrice;
          if (minValue >= 5000) { // 최소 금액 이상인 경우만
            console.log(`  ⚠️  [${coin}] 동기화: 거래소에 보유 중이지만 내부 포지션 없음`);
            console.log(`      보유량: ${exchangeData.balance.toFixed(8)}, 평균가: ${exchangeData.avgPrice.toLocaleString()}원`);
            // 포지션 복구
            strategy.openPosition(exchangeData.avgPrice, exchangeData.balance, 'BUY');
            console.log(`      → 포지션 복구됨`);
            syncIssues++;
          }
        } else if (internalPosition && exchangeData) {
          // 둘 다 있는 경우 수량 비교
          const diff = Math.abs(internalPosition.amount - exchangeData.balance);
          const diffPercent = (diff / exchangeData.balance) * 100;

          if (diffPercent > 1) { // 1% 이상 차이나면 경고
            console.log(`  ⚠️  [${coin}] 수량 불일치: 내부 ${internalPosition.amount.toFixed(8)} vs 거래소 ${exchangeData.balance.toFixed(8)} (${diffPercent.toFixed(2)}% 차이)`);
            // 거래소 기준으로 업데이트
            strategy.currentPosition.amount = exchangeData.balance;
            syncIssues++;
          }
        }
      }

      if (syncIssues === 0) {
        console.log(`  ✅ 동기화 완료 - 불일치 없음`);
      } else {
        console.log(`  ⚠️  동기화 완료 - ${syncIssues}건 수정됨`);
      }

      // 미체결 주문 확인 및 정리
      await this.cleanupPendingOrders();

    } catch (error) {
      console.error(`  ❌ 동기화 실패: ${error.message}`);
    }
  }

  /**
   * 미체결 주문 정리
   */
  async cleanupPendingOrders() {
    try {
      // 대기 중인 주문 조회
      for (const coin of this.targetCoins) {
        const pendingOrders = await this.upbit.getOrders(coin, 'wait');

        if (pendingOrders && pendingOrders.length > 0) {
          console.log(`  📋 [${coin}] 미체결 주문 ${pendingOrders.length}건 발견`);

          for (const order of pendingOrders) {
            const orderAge = Date.now() - new Date(order.created_at).getTime();
            const orderAgeMinutes = Math.floor(orderAge / 60000);

            // 5분 이상 된 주문은 취소
            if (orderAgeMinutes >= 5) {
              console.log(`    🔄 ${orderAgeMinutes}분 경과 주문 취소: ${order.uuid}`);
              try {
                await this.upbit.cancelOrder(order.uuid);
                console.log(`    ✅ 취소됨`);
              } catch (e) {
                console.log(`    ⚠️  취소 실패: ${e.message}`);
              }
            } else {
              console.log(`    ⏳ ${order.uuid} - ${orderAgeMinutes}분 경과 (5분 후 자동 취소)`);
            }
          }
        }
      }
    } catch (error) {
      // 개별 코인 오류는 무시하고 계속
    }
  }

  /**
   * 다중 코인 매매 사이클
   */
  async executeTradingCycle() {
    const now = new Date();
    console.log(`\n⏰ [${now.toLocaleString('ko-KR')}] 다중 코인 매매 분석 시작`);
    console.log('='.repeat(80));

    // 0. 실전 모드: 거래소 동기화 (10분마다)
    if (!this.dryRun) {
      const lastSync = this._lastSyncTime || 0;
      if (Date.now() - lastSync > 10 * 60 * 1000) { // 10분
        await this.syncWithExchange();
        this._lastSyncTime = Date.now();
      }
    }

    // 1. 계좌 조회
    const accounts = await this.getAccountInfo();
    const krwBalance = this.getKRWBalance(accounts);

    console.log(`\n💰 계좌 정보:`);
    console.log(`  KRW: ${Number(krwBalance).toLocaleString()} 원`);

    // 2. 뉴스 업데이트 (실패해도 거래 진행)
    await this.updateNews();

    // 뉴스 데이터 없어도 기술적 분석으로 거래 진행
    let newsSentiment = null;
    if (this.newsData) {
      newsSentiment = this.newsMonitor.analyzeMarketSentiment(this.newsData);
    } else {
      console.log('⚠️  뉴스 데이터 없음 - 기술적 분석만으로 진행');
      // 중립 뉴스 감성으로 대체
      newsSentiment = { overall: 'neutral', score: 0.5, confidence: 0.5 };
    }

    // 3. 각 코인 분석 및 점수 계산
    const coinAnalyses = [];

    for (const coin of this.targetCoins) {
      try {
        const analysis = await this.analyzeCoin(coin, newsSentiment);
        coinAnalyses.push(analysis);
      } catch (error) {
        console.error(`\n❌ ${coin} 분석 오류:`, error.message);
      }
    }

    // 4. 점수 기준으로 정렬 (매수 우선순위)
    coinAnalyses.sort((a, b) => b.decision.scores.total - a.decision.scores.total);

    // 5. 상위 코인부터 매매 실행
    console.log('\n📊 코인별 분석 결과 (점수 순):');
    coinAnalyses.forEach((analysis, index) => {
      const strength = analysis.decision.signalStrength;
      const strengthEmoji = {
        'VERY_STRONG': '🔥🔥',
        'STRONG': '🔥',
        'MEDIUM': '💡',
        'WEAK': '💤',
        'NONE': '⏸️'
      }[strength?.level] || '⏸️';

      console.log(`\n${index + 1}. ${analysis.coin}`);
      console.log(`  현재가: ${analysis.currentPrice.toLocaleString()} 원`);
      console.log(`  점수: ${analysis.decision.scores.total}`);
      console.log(`  추천: ${analysis.decision.action} ${strengthEmoji} ${strength?.level || 'NONE'}`);
      console.log(`  이유: ${analysis.decision.reason}`);
    });

    // 6. 현재 포지션 수 확인
    const currentPositions = this.getCurrentPositionCount();
    console.log(`\n📍 현재 포지션 수: ${currentPositions}개 (무제한)`);

    // 7. 매매 실행 (강한 신호 우선)
    for (const analysis of coinAnalyses) {
      // 현재 KRW 잔액 갱신 (리밸런싱으로 변동 가능)
      const accounts = await this.getAccountInfo();
      const updatedKrwBalance = this.getKRWBalance(accounts);
      const updatedPositions = this.getCurrentPositionCount();

      await this.executeOrder(
        analysis.coin,
        analysis.decision,
        analysis.currentPrice,
        updatedKrwBalance,
        analysis.coinBalance,
        updatedPositions,
        coinAnalyses  // 리밸런싱용 전체 분석 결과 전달
      );
    }

    // 8. 포트폴리오 요약
    this.printPortfolioSummary();
  }

  /**
   * 개별 코인 분석
   */
  async analyzeCoin(coin, newsSentiment) {
    const accounts = await this.getAccountInfo();
    const coinBalance = this.getCoinBalance(accounts, coin);

    // 현재가 조회 - null/빈배열 체크
    const ticker = await this.upbit.getTicker(coin);
    if (!ticker || !Array.isArray(ticker) || ticker.length === 0) {
      throw new Error(`${coin} 현재가 조회 실패 - 응답 없음`);
    }
    if (!ticker[0] || typeof ticker[0].trade_price !== 'number') {
      throw new Error(`${coin} 현재가 조회 실패 - 유효하지 않은 데이터`);
    }
    const currentPrice = ticker[0].trade_price;

    // 캔들 데이터 조회
    const candles = await this.upbit.getMinuteCandles(coin, 5, 200);
    if (!candles || !Array.isArray(candles) || candles.length < 50) {
      throw new Error(`${coin} 캔들 데이터 부족 (${candles?.length || 0}개)`);
    }

    // 기술적 분석
    const technicalAnalysis = comprehensiveAnalysis(candles, {
      rsiPeriod: this.config.rsiPeriod || 14,
      rsiOversold: this.config.rsiOversold || 30,
      rsiOverbought: this.config.rsiOverbought || 70
    });

    if (!technicalAnalysis) {
      throw new Error(`${coin} 기술적 분석 실패`);
    }

    // 코인별 감성 분석 (캐시 활용, 10분 유효)
    let combinedSentiment = { ...newsSentiment };
    try {
      const coinSentiment = await this.newsMonitor.getCoinSentiment(coin, 600000);
      if (coinSentiment && coinSentiment.newsCount > 0) {
        // 코인별 감성과 시장 감성을 결합 (코인별 60%, 시장 40%)
        const coinScore = parseFloat(coinSentiment.score) || 0;
        const marketScore = parseFloat(newsSentiment.score) || 0;
        const weightedScore = (coinScore * 0.6) + (marketScore * 0.4);

        combinedSentiment = {
          ...newsSentiment,
          score: weightedScore.toFixed(2),
          coinSpecific: coinSentiment,
          hasCoinNews: true,
          // 코인별 뉴스가 강한 신호면 추천 업데이트
          recommendation: coinSentiment.newsCount >= 3 && Math.abs(coinScore) > 1
            ? coinSentiment.recommendation
            : newsSentiment.recommendation
        };
      }
    } catch (error) {
      // 코인별 뉴스 실패시 시장 감성만 사용
    }

    // 전략 가져오기
    const strategy = this.getStrategy(coin);

    // 매매 결정
    const decision = strategy.makeDecision(
      technicalAnalysis,
      combinedSentiment,
      currentPrice
    );

    return {
      coin,
      currentPrice,
      coinBalance,
      technicalAnalysis,
      decision,
      sentiment: combinedSentiment
    };
  }

  /**
   * 주문 실행
   * @param {string} coin - 코인
   * @param {Object} decision - 매매 결정
   * @param {number} currentPrice - 현재가
   * @param {number} krwBalance - KRW 잔액
   * @param {number} coinBalance - 코인 잔액
   * @param {number} currentPositions - 현재 포지션 수
   * @param {Array} coinAnalyses - 전체 코인 분석 결과 (리밸런싱용)
   */
  async executeOrder(coin, decision, currentPrice, krwBalance, coinBalance, currentPositions, coinAnalyses = []) {
    const strategy = this.getStrategy(coin);

    if (decision.action === 'HOLD') {
      return;
    }

    if (decision.action === 'BUY') {
      const signalStrength = decision.signalStrength || { level: 'WEAK', multiplier: 1 };
      const isStrongSignal = ['STRONG', 'VERY_STRONG'].includes(signalStrength.level);

      // 이미 포지션이 있는 경우
      if (strategy.currentPosition) {
        if (!this.allowAveraging) {
          console.log(`\n⚠️  [${coin}] 이미 포지션 보유중 (추가 매수 비활성화)`);
          return;
        }
        // 추가 매수는 STRONG 이상 신호에서만 허용
        if (!isStrongSignal) {
          console.log(`\n⚠️  [${coin}] 포지션 보유중 - 추가 매수는 STRONG 이상 신호 필요 (현재: ${signalStrength.level})`);
          return;
        }
        console.log(`\n📈 [${coin}] 포지션 보유중 - 강한 신호로 추가 매수 진행`);
      }

      // 무제한 포지션 - 제한 없음 (공격적 모드)

      // 동적 투자금액 계산 (시드머니 + 신호 강도 기반)
      const totalAssets = await this.calculateTotalAssets();
      const dynamicInvestment = await this.calculateDynamicInvestmentAmount(totalAssets, signalStrength);

      // 잔액 부족 시 강한 신호면 추가 리밸런싱
      if (krwBalance < dynamicInvestment && isStrongSignal && currentPositions > 0) {
        console.log(`\n💡 [${coin}] 잔액 부족하지만 강한 신호 - 추가 리밸런싱 검토`);

        const weakestPosition = this.findWeakestPosition(coin, coinAnalyses);
        if (weakestPosition) {
          const soldAmount = await this.sellForRebalancing(weakestPosition, coin);
          if (soldAmount > 0) {
            krwBalance = this.dryRun ? this.virtualPortfolio.krwBalance : soldAmount;
          }
        }
      }

      const maxInvestment = krwBalance * this.portfolioAllocation;
      const investmentAmount = Math.min(
        dynamicInvestment,
        maxInvestment,
        krwBalance * 0.95
      );

      const baseInvestment = totalAssets * this.investmentRatio;
      console.log(`  💰 투자금액: ${investmentAmount.toLocaleString()}원`);
      console.log(`     (기본 ${baseInvestment.toLocaleString()}원 × ${signalStrength.multiplier} = ${dynamicInvestment.toLocaleString()}원)`);

      if (investmentAmount < 5000) {
        console.log(`\n⚠️  [${coin}] 매수 불가: 잔액 부족 (${krwBalance.toLocaleString()}원)`);
        return;
      }

      // 수수료 계산 (0.05%)
      const FEE_RATE = 0.0005;
      const fee = investmentAmount * FEE_RATE;
      const actualInvestment = investmentAmount - fee;
      const volume = actualInvestment / currentPrice;

      if (this.dryRun) {
        console.log(`\n🧪 [모의투자] ${coin} 매수 주문`);
        console.log(`  금액: ${investmentAmount.toLocaleString()} 원`);
        console.log(`  수수료: ${fee.toLocaleString()} 원 (0.05%)`);
        console.log(`  실투자: ${actualInvestment.toLocaleString()} 원`);
        console.log(`  수량: ${volume.toFixed(8)}`);
        console.log(`  가격: ${currentPrice.toLocaleString()} 원`);

        // 가상 포트폴리오 업데이트 - 마이너스 방지 체크
        const currentBalance = this.virtualPortfolio.krwBalance || 0;
        if (currentBalance < investmentAmount) {
          console.log(`\n⚠️  [${coin}] 매수 취소: 실시간 잔액 부족 (${currentBalance.toLocaleString()}원 < ${investmentAmount.toLocaleString()}원)`);
          return;
        }
        this.virtualPortfolio.krwBalance = Math.max(0, currentBalance - investmentAmount);
        const existing = this.virtualPortfolio.holdings.get(coin) || { amount: 0, avgPrice: 0, entryTime: null };
        const newAmount = existing.amount + volume;
        const newAvgPrice = ((existing.amount * existing.avgPrice) + (volume * currentPrice)) / newAmount;
        this.virtualPortfolio.holdings.set(coin, {
          amount: newAmount,
          avgPrice: newAvgPrice,
          entryTime: existing.entryTime || new Date().toISOString() // 최초 매수 시간 유지
        });

        strategy.openPosition(currentPrice, volume, 'BUY');
        this.saveVirtualPortfolio();
        console.log(`  잔여 KRW: ${this.virtualPortfolio.krwBalance.toLocaleString()} 원`);

        // 매수 알림
        this.notifyTrade({
          type: 'BUY',
          coin,
          price: currentPrice,
          amount: investmentAmount,
          volume,
          reason: decision.reason,
          signalStrength: signalStrength.level,
          mode: 'DRY_RUN'
        });
      } else {
        console.log(`\n💵 [${coin}] 실제 매수 주문 실행`);
        console.log(`  예상 가격: ${currentPrice.toLocaleString()} 원`);
        console.log(`  투자 금액: ${investmentAmount.toLocaleString()} 원`);

        const orderResult = await this.upbit.order(coin, 'bid', investmentAmount, null, 'price');

        if (orderResult.success) {
          const orderId = orderResult.data.uuid;
          console.log(`  📝 주문 접수: ${orderId}`);

          // 주문 체결 대기 (최대 30초)
          console.log(`  ⏳ 체결 대기 중...`);
          const fillResult = await this.upbit.waitForOrderFill(orderId, 30000, 1000);

          if (fillResult.filled) {
            const filledOrder = fillResult.order;
            const actualVolume = parseFloat(filledOrder.executed_volume || 0);

            // Upbit API는 avg_price 필드로 평균 체결가를 제공
            const actualPrice = parseFloat(filledOrder.avg_price || 0) || currentPrice;
            const actualAmount = actualVolume * actualPrice;
            const paidFee = parseFloat(filledOrder.paid_fee || 0);

            // 슬리피지 계산
            const slippage = ((actualPrice - currentPrice) / currentPrice * 100).toFixed(2);

            console.log(`  ✅ 체결 완료!`);
            console.log(`    실제 체결가: ${actualPrice.toLocaleString()} 원`);
            console.log(`    체결 수량: ${actualVolume.toFixed(8)}`);
            console.log(`    체결 금액: ${actualAmount.toLocaleString()} 원`);
            console.log(`    수수료: ${paidFee.toLocaleString()} 원`);
            console.log(`    슬리피지: ${slippage}%`);

            if (fillResult.partial) {
              console.log(`  ⚠️  부분 체결됨 - 잔여: ${filledOrder.remaining_volume}`);
            }

            // 실제 체결 데이터로 포지션 오픈
            strategy.openPosition(actualPrice, actualVolume, 'BUY');

            // 매수 알림 (실제 체결 데이터)
            this.notifyTrade({
              type: 'BUY',
              coin,
              price: actualPrice,
              amount: actualVolume * actualPrice,
              volume: actualVolume,
              reason: decision.reason,
              signalStrength: signalStrength.level,
              mode: 'LIVE',
              orderId,
              slippage: parseFloat(slippage)
            });
          } else {
            // 미체결 - 주문 취소 시도
            console.log(`  ⚠️  체결 실패: ${fillResult.error}`);
            console.log(`  🔄 주문 취소 시도...`);

            try {
              await this.upbit.cancelOrder(orderId);
              console.log(`  ✅ 주문 취소됨`);
            } catch (cancelError) {
              console.error(`  ❌ 주문 취소 실패: ${cancelError.message}`);
              console.log(`  ⚠️  수동 확인 필요 - 주문 ID: ${orderId}`);
            }
          }
        } else {
          console.error(`  ❌ 주문 실패: ${orderResult.error.message} (${orderResult.error.code})`);
          // 주문 실패 시 포지션 열지 않음 - 상태 일관성 유지
        }
      }
    }

    if (decision.action === 'SELL') {
      if (!strategy.currentPosition && coinBalance === 0) {
        console.log(`\n⚠️  [${coin}] 매도 불가: 보유 수량 없음`);
        return;
      }

      const sellVolume = strategy.currentPosition
        ? strategy.currentPosition.amount
        : coinBalance;

      // 최소 매도 금액 체크 (5000원)
      const estimatedSellAmount = sellVolume * currentPrice;
      if (estimatedSellAmount < 5000) {
        console.log(`\n⚠️  [${coin}] 매도 불가: 최소 매도금액(5,000원) 미만 (${estimatedSellAmount.toLocaleString()}원)`);
        return;
      }

      if (this.dryRun) {
        // 수수료 계산 (0.05%)
        const FEE_RATE = 0.0005;
        const fee = estimatedSellAmount * FEE_RATE;
        const actualReceived = estimatedSellAmount - fee;

        console.log(`\n🧪 [모의투자] ${coin} 매도 주문`);
        console.log(`  수량: ${sellVolume.toFixed(8)}`);
        console.log(`  예상 금액: ${estimatedSellAmount.toLocaleString()} 원`);
        console.log(`  수수료: ${fee.toLocaleString()} 원 (0.05%)`);
        console.log(`  실수령: ${actualReceived.toLocaleString()} 원`);

        // 가상 포트폴리오 업데이트 (수수료 차감)
        this.virtualPortfolio.krwBalance += actualReceived;

        const holding = this.virtualPortfolio.holdings.get(coin);
        if (holding) {
          holding.amount -= sellVolume;
          if (holding.amount <= 0.00000001) {
            this.virtualPortfolio.holdings.delete(coin);
          } else {
            this.virtualPortfolio.holdings.set(coin, holding);
          }
        }

        // 수익률 계산
        const entryPrice = strategy.currentPosition?.entryPrice || holding?.avgPrice || currentPrice;
        const profitPercent = ((currentPrice - entryPrice) / entryPrice * 100).toFixed(2);

        strategy.closePosition(currentPrice, decision.reason);
        this.saveVirtualPortfolio();
        console.log(`  잔여 KRW: ${this.virtualPortfolio.krwBalance.toLocaleString()} 원`);

        // 매도 알림
        this.notifyTrade({
          type: 'SELL',
          coin,
          price: currentPrice,
          amount: estimatedSellAmount,
          volume: sellVolume,
          reason: decision.reason,
          profitPercent,
          mode: 'DRY_RUN'
        });
      } else {
        console.log(`\n💰 [${coin}] 실제 매도 주문 실행`);
        console.log(`  예상 가격: ${currentPrice.toLocaleString()} 원`);
        console.log(`  매도 수량: ${sellVolume.toFixed(8)}`);

        const orderResult = await this.upbit.order(coin, 'ask', sellVolume, null, 'market');

        if (orderResult.success) {
          const orderId = orderResult.data.uuid;
          console.log(`  📝 주문 접수: ${orderId}`);

          // 주문 체결 대기 (최대 30초)
          console.log(`  ⏳ 체결 대기 중...`);
          const fillResult = await this.upbit.waitForOrderFill(orderId, 30000, 1000);

          if (fillResult.filled) {
            const filledOrder = fillResult.order;
            const actualVolume = parseFloat(filledOrder.executed_volume || 0);

            // Upbit API는 avg_price 필드로 평균 체결가를 제공
            const actualPrice = parseFloat(filledOrder.avg_price || 0) || currentPrice;
            const actualAmount = actualVolume * actualPrice;
            const paidFee = parseFloat(filledOrder.paid_fee || 0);

            // 슬리피지 계산
            const slippage = ((actualPrice - currentPrice) / currentPrice * 100).toFixed(2);

            // 수익률 계산 (실제 체결가 기준)
            const entryPrice = strategy.currentPosition?.entryPrice || currentPrice;
            const grossProfit = (actualPrice - entryPrice) * actualVolume;
            const netProfit = grossProfit - paidFee; // 매도 수수료 차감
            const profitPercent = ((actualPrice - entryPrice) / entryPrice * 100).toFixed(2);

            console.log(`  ✅ 체결 완료!`);
            console.log(`    실제 체결가: ${actualPrice.toLocaleString()} 원`);
            console.log(`    체결 수량: ${actualVolume.toFixed(8)}`);
            console.log(`    체결 금액: ${actualAmount.toLocaleString()} 원`);
            console.log(`    수수료: ${paidFee.toLocaleString()} 원`);
            console.log(`    슬리피지: ${slippage}%`);
            console.log(`    순수익: ${profitPercent}% (${netProfit >= 0 ? '+' : ''}${netProfit.toLocaleString()}원)`);

            if (fillResult.partial) {
              const remainingVolume = parseFloat(filledOrder.remaining_volume || 0);
              console.log(`  ⚠️  부분 체결됨 - 미체결 수량: ${remainingVolume.toFixed(8)}`);
              // 부분 체결 시 남은 수량 처리 필요 알림
              console.log(`  ⚠️  미체결 수량은 수동 확인 필요`);
            }

            // 실제 체결 데이터로 포지션 종료
            strategy.closePosition(actualPrice, decision.reason);

            // 매도 알림 (실제 체결 데이터)
            this.notifyTrade({
              type: 'SELL',
              coin,
              price: actualPrice,
              amount: actualAmount,
              volume: actualVolume,
              reason: decision.reason,
              profitPercent: parseFloat(profitPercent),
              profitAmount: netProfit,
              fee: paidFee,
              mode: 'LIVE',
              orderId,
              slippage: parseFloat(slippage)
            });
          } else {
            // 미체결 - 마켓 주문이므로 이 경우는 드묾
            console.log(`  ⚠️  체결 실패: ${fillResult.error}`);
            console.log(`  ⚠️  포지션 상태 유지됨 - 수동 확인 필요`);
            console.log(`  ⚠️  주문 ID: ${orderId}`);
          }
        } else {
          console.error(`  ❌ 주문 실패: ${orderResult.error.message} (${orderResult.error.code})`);
          // 주문 실패 시 포지션 유지 - 수동 확인 필요
          console.log(`  ⚠️  포지션 상태 유지됨 - 수동 확인 필요`);
        }
      }
    }
  }

  /**
   * 현재 포지션 수 조회
   */
  getCurrentPositionCount() {
    let count = 0;
    for (const strategy of this.strategies.values()) {
      if (strategy.currentPosition) {
        count++;
      }
    }
    return count;
  }

  /**
   * 가장 약한 포지션 찾기 (리밸런싱용)
   * @param {string} excludeCoin - 제외할 코인
   * @param {Array} coinAnalyses - 코인별 분석 결과
   * @returns {Object|null} 가장 약한 포지션 정보
   */
  findWeakestPosition(excludeCoin, coinAnalyses) {
    let weakest = null;
    let lowestScore = Infinity;

    // 최소 보유 시간: 10분 (리밸런싱 루프 방지 - 수수료 손실 최소화)
    const MIN_HOLD_TIME_MS = 10 * 60 * 1000;

    // 리밸런싱 쿨다운: 마지막 리밸런싱 후 5분 대기
    const REBALANCE_COOLDOWN_MS = 5 * 60 * 1000;
    if (this.lastRebalanceTime && (Date.now() - this.lastRebalanceTime) < REBALANCE_COOLDOWN_MS) {
      const remainingCooldown = Math.ceil((REBALANCE_COOLDOWN_MS - (Date.now() - this.lastRebalanceTime)) / 1000);
      console.log(`  ⏳ 리밸런싱 쿨다운 중 (${remainingCooldown}초 남음)`);
      return null;
    }

    for (const [coin, strategy] of this.strategies.entries()) {
      if (coin === excludeCoin || !strategy.currentPosition) continue;

      // 최소 보유 시간 체크 - 방금 산 포지션은 리밸런싱 대상에서 제외
      const holdTime = Date.now() - new Date(strategy.currentPosition.entryTime).getTime();
      if (holdTime < MIN_HOLD_TIME_MS) {
        console.log(`  ⏳ [${coin}] 최소 보유 시간 미달 (${Math.floor(holdTime / 1000)}초/${MIN_HOLD_TIME_MS / 1000}초)`);
        continue;
      }

      // 해당 코인의 분석 결과 찾기
      const analysis = coinAnalyses.find(a => a.coin === coin);
      const score = analysis ? parseFloat(analysis.decision.scores.total) : 50;

      // 현재 수익률 계산
      const currentPrice = analysis?.currentPrice || strategy.currentPosition.entryPrice;
      const profitPercent = ((currentPrice - strategy.currentPosition.entryPrice) / strategy.currentPosition.entryPrice) * 100;

      // 점수가 낮고 수익률도 좋지 않은 포지션 우선
      const weaknessScore = score - (profitPercent * 0.5); // 점수 - (수익률 가중치)

      if (weaknessScore < lowestScore) {
        lowestScore = weaknessScore;
        weakest = {
          coin,
          strategy,
          score,
          profitPercent,
          currentPrice,
          position: strategy.currentPosition
        };
      }
    }

    return weakest;
  }

  /**
   * 리밸런싱을 위한 포지션 매도
   * @param {Object} weakestPosition - 매도할 포지션 정보
   * @param {string} targetCoin - 매수할 코인 (로그용)
   */
  async sellForRebalancing(weakestPosition, targetCoin) {
    const { coin, strategy, currentPrice, profitPercent } = weakestPosition;

    // 리밸런싱 수익성 체크: 손실 중인 포지션만 교체 (수수료 0.1% 고려)
    // 수수료로 인한 최소 손실: 매도 0.05% + 매수 0.05% = 0.1%
    const MIN_LOSS_FOR_REBALANCE = -0.5; // 최소 -0.5% 손실 중이어야 리밸런싱
    if (profitPercent > MIN_LOSS_FOR_REBALANCE) {
      console.log(`\n⛔ [리밸런싱 취소] ${coin} 수익률 ${profitPercent.toFixed(2)}%로 양호함`);
      console.log(`  리밸런싱은 ${MIN_LOSS_FOR_REBALANCE}% 이하 손실 포지션만 대상`);
      return 0;
    }

    console.log(`\n🔄 [리밸런싱] ${coin} 매도 → ${targetCoin} 매수 준비`);
    console.log(`  ${coin} 현재 수익률: ${profitPercent.toFixed(2)}%`);

    const sellVolume = strategy.currentPosition.amount;

    if (this.dryRun) {
      // 수수료 계산 (0.05%)
      const FEE_RATE = 0.0005;
      const sellAmount = sellVolume * currentPrice;
      const fee = sellAmount * FEE_RATE;
      const actualReceived = sellAmount - fee;

      console.log(`  🧪 [모의투자] ${coin} 리밸런싱 매도`);
      console.log(`    수량: ${sellVolume.toFixed(8)}`);
      console.log(`    예상 금액: ${sellAmount.toLocaleString()} 원`);
      console.log(`    수수료: ${fee.toLocaleString()} 원 (0.05%)`);
      console.log(`    실수령: ${actualReceived.toLocaleString()} 원`);

      // 가상 포트폴리오 업데이트 (수수료 차감)
      this.virtualPortfolio.krwBalance += actualReceived;

      const holding = this.virtualPortfolio.holdings.get(coin);
      if (holding) {
        holding.amount -= sellVolume;
        if (holding.amount <= 0.00000001) {
          this.virtualPortfolio.holdings.delete(coin);
        }
      }

      strategy.closePosition(currentPrice, `리밸런싱: ${targetCoin} 강한 매수 신호`);
      this.saveVirtualPortfolio();

      // 리밸런싱 쿨다운 시간 기록
      this.lastRebalanceTime = Date.now();

      return actualReceived;
    } else {
      console.log(`  💰 [실전] ${coin} 리밸런싱 매도 실행`);
      console.log(`    예상 가격: ${currentPrice.toLocaleString()} 원`);
      console.log(`    매도 수량: ${sellVolume.toFixed(8)}`);

      const orderResult = await this.upbit.order(coin, 'ask', sellVolume, null, 'market');

      if (orderResult.success) {
        const orderId = orderResult.data.uuid;
        console.log(`    📝 주문 접수: ${orderId}`);

        // 주문 체결 대기 (최대 30초)
        console.log(`    ⏳ 체결 대기 중...`);
        const fillResult = await this.upbit.waitForOrderFill(orderId, 30000, 1000);

        if (fillResult.filled) {
          const filledOrder = fillResult.order;
          const actualVolume = parseFloat(filledOrder.executed_volume || 0);

          // Upbit API는 avg_price 필드로 평균 체결가를 제공
          const actualPrice = parseFloat(filledOrder.avg_price || 0) || currentPrice;
          const actualAmount = actualVolume * actualPrice;
          const paidFee = parseFloat(filledOrder.paid_fee || 0);

          const slippage = ((actualPrice - currentPrice) / currentPrice * 100).toFixed(2);

          console.log(`    ✅ 체결 완료!`);
          console.log(`      실제 체결가: ${actualPrice.toLocaleString()} 원`);
          console.log(`      체결 금액: ${actualAmount.toLocaleString()} 원`);
          console.log(`      수수료: ${paidFee.toLocaleString()} 원`);
          console.log(`      슬리피지: ${slippage}%`);

          if (fillResult.partial) {
            console.log(`    ⚠️  부분 체결됨 - 미체결 수량: ${filledOrder.remaining_volume}`);
          }

          strategy.closePosition(actualPrice, `리밸런싱: ${targetCoin} 강한 매수 신호`);

          // 리밸런싱 쿨다운 시간 기록
          this.lastRebalanceTime = Date.now();

          // 잔액 확인
          const accounts = await this.upbit.getAccounts();
          const krwAccount = accounts.find(acc => acc.currency === 'KRW');
          return krwAccount ? parseFloat(krwAccount.balance) : actualAmount;
        } else {
          console.log(`    ⚠️  체결 실패: ${fillResult.error}`);
          console.log(`    ⚠️  리밸런싱 취소 - 포지션 유지`);
          return 0;
        }
      } else {
        console.error(`    ❌ 리밸런싱 매도 실패: ${orderResult.error.message} (${orderResult.error.code})`);
        return 0;
      }
    }
  }

  /**
   * 포트폴리오 요약
   */
  printPortfolioSummary() {
    console.log('\n' + '='.repeat(80));
    console.log('📊 포트폴리오 요약');
    console.log('='.repeat(80));

    for (const coin of this.targetCoins) {
      const strategy = this.getStrategy(coin);
      const stats = strategy.getStatistics();

      console.log(`\n[${coin}]`);

      if (strategy.currentPosition) {
        console.log(`  📍 포지션: 보유중`);
        console.log(`    진입가: ${strategy.currentPosition.entryPrice.toLocaleString()} 원`);
        console.log(`    수량: ${strategy.currentPosition.amount.toFixed(8)}`);
      } else {
        console.log(`  📍 포지션: 없음`);
      }

      if (stats.totalTrades > 0) {
        console.log(`  거래 통계:`);
        console.log(`    총 거래: ${stats.totalTrades}회`);
        console.log(`    승률: ${stats.winRate}`);
        console.log(`    총 손익: ${stats.totalProfit}`);
      }
    }

    console.log('\n' + '='.repeat(80));
  }

  /**
   * 뉴스 업데이트
   */
  async updateNews() {
    const now = Date.now();
    const newsInterval = this.config.newsCheckInterval || 300000;

    if (!this.lastNewsCheck || (now - this.lastNewsCheck) > newsInterval) {
      console.log('\n📡 뉴스 업데이트 중...');
      this.newsData = await this.newsMonitor.collectAndAnalyzeNews();
      this.lastNewsCheck = now;

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
      // 가상 포트폴리오에서 잔액 반환
      const accounts = [
        { currency: 'KRW', balance: String(this.virtualPortfolio.krwBalance), locked: '0', avg_buy_price: '0' }
      ];

      // 보유 코인 추가
      for (const [coin, holding] of this.virtualPortfolio.holdings.entries()) {
        const coinSymbol = coin.split('-')[1];
        accounts.push({
          currency: coinSymbol,
          balance: String(holding.amount),
          locked: '0',
          avg_buy_price: String(holding.avgPrice)
        });
      }

      return accounts;
    }
    return await this.upbit.getAccounts();
  }

  /**
   * KRW 잔액 조회 (사용 가능 금액만)
   */
  getKRWBalance(accounts) {
    const krwAccount = accounts.find(acc => acc.currency === 'KRW');
    if (!krwAccount) return 0;
    // balance는 사용 가능한 금액, locked는 주문 중인 금액 (별도 관리됨)
    return parseFloat(krwAccount.balance) || 0;
  }

  /**
   * KRW 총 잔액 조회 (locked 포함)
   */
  getKRWTotalBalance(accounts) {
    const krwAccount = accounts.find(acc => acc.currency === 'KRW');
    if (!krwAccount) return 0;

    const balance = parseFloat(krwAccount.balance) || 0;
    const locked = parseFloat(krwAccount.locked) || 0;
    return balance + locked;
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
   * 대기
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default MultiCoinTrader;
