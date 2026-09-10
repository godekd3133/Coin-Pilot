import dotenv from 'dotenv';
import MultiCoinTrader from './trader/multiCoinTrader.js';
import DashboardServer from './api/dashboardServer.js';
import BacktestEngine from './backtest/backtestEngine.js';
import UpbitAPI from './api/upbit.js';
import Logger from './utils/logger.js';
import ParameterOptimizer from './optimization/parameterOptimizer.js';
import fs from 'fs';
import axios from 'axios';

dotenv.config();

/**
 * 여러 번의 API 호출로 충분한 분봉 데이터 수집
 * @param {UpbitAPI} upbit - Upbit API 인스턴스
 * @param {string} market - 마켓 코드
 * @param {number} unit - 분봉 단위 (1, 3, 5, 15, 30, 60, 240)
 * @param {number} totalCount - 총 수집할 캔들 수
 * @returns {Array} 캔들 데이터 배열 (최신순)
 */
async function getMultipleMinuteCandles(upbit, market, unit, totalCount) {
  const maxPerRequest = 200;
  const allCandles = [];
  let to = null;

  while (allCandles.length < totalCount) {
    const count = Math.min(maxPerRequest, totalCount - allCandles.length);

    try {
      let candles;
      if (to) {
        candles = await upbit.requestWithRetry(async () => {
          const response = await axios.get(
            `https://api.upbit.com/v1/candles/minutes/${unit}`,
            { params: { market, count, to } }
          );
          return response.data;
        });
      } else {
        candles = await upbit.getMinuteCandles(market, unit, count);
      }

      if (!candles || candles.length === 0) break;

      allCandles.push(...candles);
      const oldestCandle = candles[candles.length - 1];
      to = oldestCandle.candle_date_time_utc;

      // 최적화 API 호출은 2초 간격으로 여유있게 (대시보드 갱신과 병렬 진행)
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(`캔들 데이터 수집 오류 (${market}):`, error.message);
      break;
    }
  }

  return allCandles;
}

// 설정 검증
function validateConfig() {
  // API 키는 실전투자 모드일 때만 필수
  if (process.env.DRY_RUN !== 'true') {
    if (!process.env.UPBIT_ACCESS_KEY || !process.env.UPBIT_SECRET_KEY) {
      console.error('❌ 실전투자 모드에서는 업비트 API 키가 필요합니다.');
      console.error('모의투자 모드로 실행하려면 DRY_RUN=true로 설정하세요.');
      process.exit(1);
    }
  }
}

// 최적화된 파라미터 로드
function loadOptimalConfig() {
  const configFile = 'optimal_config.json';

  if (fs.existsSync(configFile)) {
    try {
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (config.parameters) {
        console.log('📂 최적화 파라미터 로드됨 (optimal_config.json)');
        console.log(`   마지막 최적화: ${config.updatedAt || '알 수 없음'}`);
        return config.parameters;
      }
    } catch (error) {
      console.log('⚠️  최적화 파라미터 로드 실패:', error.message);
    }
  }
  return null;
}

// 설정 객체 생성
function createConfig() {
  const dryRun = process.env.DRY_RUN !== 'false';

  // 최적화된 파라미터 로드 (있으면 사용, 없으면 기본값)
  const optimalParams = loadOptimalConfig();

  return {
    // API 키
    accessKey: process.env.UPBIT_ACCESS_KEY || '',
    secretKey: process.env.UPBIT_SECRET_KEY || '',

    // 다중 코인 설정 (기본값)
    // TARGET_COINS=ALL 이면 모든 KRW 마켓 대상 (main에서 동적 로드)
    targetCoins: process.env.TARGET_COINS === 'ALL'
      ? [] // 나중에 동적으로 로드
      : process.env.TARGET_COINS
        ? process.env.TARGET_COINS.split(',')
        : ['KRW-BTC', 'KRW-ETH', 'KRW-XRP'],
    analyzeAllCoins: process.env.TARGET_COINS === 'ALL',

    maxPositions: 99999, // 무제한 포지션 (공격적 모드)
    portfolioAllocation: parseFloat(process.env.PORTFOLIO_ALLOCATION) || 0.5,

    investmentAmount: parseInt(process.env.INVESTMENT_AMOUNT) || 50000,
    stopLossPercent: optimalParams?.stopLossPercent || parseFloat(process.env.STOP_LOSS_PERCENT) || 5,
    takeProfitPercent: optimalParams?.takeProfitPercent || parseFloat(process.env.TAKE_PROFIT_PERCENT) || 10,

    // 기술적 분석 설정 (최적화 파라미터 우선)
    // RSI
    rsiPeriod: optimalParams?.rsiPeriod || parseInt(process.env.RSI_PERIOD) || 14,
    rsiOversold: optimalParams?.rsiOversold || parseInt(process.env.RSI_OVERSOLD) || 30,
    rsiOverbought: optimalParams?.rsiOverbought || parseInt(process.env.RSI_OVERBOUGHT) || 70,
    // MACD
    macdFast: optimalParams?.macdFast || parseInt(process.env.MACD_FAST) || 12,
    macdSlow: optimalParams?.macdSlow || parseInt(process.env.MACD_SLOW) || 26,
    macdSignal: optimalParams?.macdSignal || parseInt(process.env.MACD_SIGNAL) || 9,
    // 볼린저 밴드
    bbPeriod: optimalParams?.bbPeriod || parseInt(process.env.BB_PERIOD) || 20,
    bbStdDev: optimalParams?.bbStdDev || parseFloat(process.env.BB_STD_DEV) || 2.0,
    // EMA
    emaShort: optimalParams?.emaShort || parseInt(process.env.EMA_SHORT) || 10,
    emaMid: optimalParams?.emaMid || parseInt(process.env.EMA_MID) || 30,
    emaLong: optimalParams?.emaLong || parseInt(process.env.EMA_LONG) || 60,
    // 트레일링 스탑
    trailingStopPercent: optimalParams?.trailingStopPercent || parseFloat(process.env.TRAILING_STOP_PERCENT) || 3,
    // 거래량
    volumeMultiplier: optimalParams?.volumeMultiplier || parseFloat(process.env.VOLUME_MULTIPLIER) || 1.5,
    volumePeriod: optimalParams?.volumePeriod || parseInt(process.env.VOLUME_PERIOD) || 20,

    // 뉴스 모니터링 설정
    newsCheckInterval: parseInt(process.env.NEWS_CHECK_INTERVAL) || 300000,
    newsSentimentThreshold: parseFloat(process.env.NEWS_SENTIMENT_THRESHOLD) || 0.5,

    // 매매 임계값 (최적화 파라미터 우선, 기본값 55로 적극적 매수)
    buyThreshold: optimalParams?.buyThreshold || parseInt(process.env.BUY_THRESHOLD) || 55,
    sellThreshold: optimalParams?.sellThreshold || parseInt(process.env.SELL_THRESHOLD) || 55,

    // 매수 전용 모드 (환경변수 BUY_ONLY=true로 활성화)
    buyOnly: process.env.BUY_ONLY === 'true',

    // 기존 포지션에 추가 매수 허용 (기본: true, STRONG 이상 신호에서 추가 매수)
    allowAveraging: process.env.ALLOW_AVERAGING !== 'false',

    // 가중치 설정 (최적화 파라미터 우선)
    technicalWeight: optimalParams?.technicalWeight || parseFloat(process.env.TECHNICAL_WEIGHT) || 0.6,
    newsWeight: optimalParams?.technicalWeight ? (1 - optimalParams.technicalWeight) : (parseFloat(process.env.NEWS_WEIGHT) || 0.4),

    // 투자 비율 (최적화 파라미터 우선)
    investmentRatio: optimalParams?.investmentRatio || parseFloat(process.env.INVESTMENT_RATIO) || 0.05,

    // AI 자문은 ChatGPT/Claude API key가 아니라 로컬 구독 CLI 세션을
    // 사용한다. 자문 결과는 기록/표시만 하고 주문 실행에는 연결하지 않는다.
    aiAdvisorEnabled: process.env.AI_ADVISOR_ENABLED !== 'false',
    aiAdvisorTimeoutMs: parseInt(process.env.AI_ADVISOR_TIMEOUT_MS) || 15000,
    aiMonitoringFile: process.env.AI_MONITORING_FILE || '',
    aiCodexBin: process.env.AI_CODEX_BIN || 'codex',
    aiClaudeBin: process.env.AI_CLAUDE_BIN || 'claude',
    aiGptModel: process.env.AI_GPT_MODEL || '',
    aiClaudeModel: process.env.AI_CLAUDE_MODEL || '',
    // 체크 간격 (드라이 모드일 때 더 짧게)
    checkInterval: dryRun
      ? parseInt(process.env.CHECK_INTERVAL_DRY) || 30000  // 드라이: 30초
      : parseInt(process.env.CHECK_INTERVAL) || 60000,     // 실전: 1분

    // 백테스팅 간격 (드라이 모드에서만)
    backtestInterval: parseInt(process.env.BACKTEST_INTERVAL) || 3600000, // 1시간

    // 드라이 모드 시드 자금
    dryRunSeedMoney: parseInt(process.env.DRY_RUN_SEED_MONEY) || 10000000, // 1000만원

    // 운영 모드
    dryRun,
    logLevel: process.env.LOG_LEVEL || 'info',
    enableDashboard: process.env.ENABLE_DASHBOARD !== 'false',
    dashboardPort: parseInt(process.env.DASHBOARD_PORT) || 3000
  };
}

// 시작 배너 출력
function printBanner() {
  console.log('\n' + '='.repeat(80));
  console.log('🤖 다중 코인 자동매매 시스템');
  console.log('='.repeat(80));
  console.log('');
  console.log('주요 기능:');
  console.log('  1. 다중 코인 동시 거래');
  console.log('  2. 기술적 분석 (RSI, MACD, 볼린저밴드, 이동평균)');
  console.log('  3. 뉴스 감성 분석');
  console.log('  4. 자동 손절/익절');
  console.log('  5. 백테스팅 기반 전략 검증 (드라이 모드)');
  console.log('  6. 🆕 지속적 파라미터 최적화 (유전 알고리즘)');
  console.log('  7. 웹 대시보드 모니터링');
  console.log('');
  console.log('='.repeat(80));
  console.log('');
}

// 설정 정보 출력
function printConfig(config) {
  console.log('⚙️  설정 정보:');
  console.log(`  모드: ${config.dryRun ? '🧪 모의투자' : '💰 실전투자'}`);

  console.log(`  분석 대상: ${config.targetCoins.length}개 코인`);

  console.log(`  포지션 제한: 무제한 (공격적 모드)`);
  console.log(`  포트폴리오 할당: ${(config.portfolioAllocation * 100).toFixed(0)}%`);
  console.log(`  투자 금액: ${config.investmentAmount.toLocaleString()} 원`);
  console.log(`  손절률: ${config.stopLossPercent}%`);
  console.log(`  익절률: ${config.takeProfitPercent}%`);
  console.log(`  체크 간격: ${config.checkInterval / 1000}초`);
  console.log(`  뉴스 체크 간격: ${config.newsCheckInterval / 1000}초`);

  if (config.dryRun) {
    console.log(`  시드 머니: ${config.dryRunSeedMoney.toLocaleString()} 원`);
    console.log(`  백테스팅 간격: ${config.backtestInterval / 60000}분`);
  }

  console.log('');

  if (config.dryRun) {
    console.log('⚠️  모의투자 모드입니다. 실제 거래는 발생하지 않습니다.');
    console.log('   - 시드 머니로 가상 거래를 시뮬레이션합니다.');
    console.log('   - 주기적으로 백테스팅을 실행하여 전략을 검증합니다.');
    console.log('   - 더 짧은 간격으로 체크 및 최적화가 진행됩니다.');
    console.log('   실전투자를 원하시면 .env 파일에서 DRY_RUN=false로 설정하세요.');
    console.log('');
  } else {
    console.log('🚨 실전투자 모드입니다! 실제 거래가 발생합니다.');
    console.log('   충분한 테스트 후 사용하세요.');
    console.log('');
  }
}

// 백테스팅 루프 (드라이 모드전용) - 보유 코인만 대상
function startBacktestingLoop(config, logger, trader) {
  const upbit = new UpbitAPI(config.accessKey, config.secretKey);

  const runBacktest = async () => {
    try {
      // 현재 보유 중인 코인만 백테스팅
      const heldCoins = trader.getHeldCoins ? await trader.getHeldCoins() : [];

      if (heldCoins.length === 0) {
        console.log(`\n⏰ [${new Date().toLocaleString('ko-KR')}] 백테스팅 스킵 - 보유 코인 없음`);
        return;
      }

      console.log('\n' + '='.repeat(80));
      console.log(`⏰ [${new Date().toLocaleString('ko-KR')}] 정기 백테스팅 시작 (보유 코인 ${heldCoins.length}개)`);
      console.log('='.repeat(80));

      for (const coin of heldCoins) {
        try {
          console.log(`\n📊 ${coin} 백테스팅...`);

          // 분봉 데이터 수집 (15분봉, 500개)
          const candleUnit = parseInt(process.env.BACKTEST_CANDLE_UNIT) || 15;
          const candleCount = parseInt(process.env.BACKTEST_CANDLE_COUNT) || 500;
          const candles = await getMultipleMinuteCandles(upbit, coin, candleUnit, candleCount);

          if (candles.length < 250) {
            console.log(`  ⚠️ ${coin}: 캔들 데이터 부족 (${candles.length}개)`);
            continue;
          }

          const backtest = new BacktestEngine({
            initialBalance: config.dryRunSeedMoney / config.targetCoins.length,
            tradingFee: 0.0005,
            slippage: 0.001
          });

          // 백테스팅용 파라미터 (뉴스 없이 기술적 분석 위주)
          const currentParams = {
            rsiPeriod: parseInt(process.env.RSI_PERIOD) || config.rsiPeriod,
            rsiOversold: parseInt(process.env.RSI_OVERSOLD) || config.rsiOversold,
            rsiOverbought: parseInt(process.env.RSI_OVERBOUGHT) || config.rsiOverbought,
            stopLossPercent: parseFloat(process.env.STOP_LOSS_PERCENT) || config.stopLossPercent,
            takeProfitPercent: parseFloat(process.env.TAKE_PROFIT_PERCENT) || config.takeProfitPercent,
            investmentAmount: config.investmentAmount,
            // 백테스팅 전용: 뉴스 없이 기술적 분석 중심
            technicalWeight: 0.9,
            newsWeight: 0.1,
            buyThreshold: 55,
            sellThreshold: 55
          };

          const result = await backtest.run(candles, currentParams);

          console.log(`\n[${coin}] 백테스팅 결과:`);
          console.log(`  수익률: ${result.totalReturnPercent.toFixed(2)}%`);
          console.log(`  승률: ${result.winRate.toFixed(2)}%`);
          console.log(`  총 거래: ${result.totalTrades}회`);
          console.log(`  최대 낙폭: ${result.maxDrawdown.toFixed(2)}%`);
          console.log(`  샤프 비율: ${result.sharpeRatio.toFixed(2)}`);

          // 결과 저장
          const resultsFile = `backtest_results_${coin.replace('-', '_')}.json`;
          fs.writeFileSync(resultsFile, JSON.stringify(result, null, 2), 'utf8');

          // 경고 메시지
          if (result.totalReturnPercent < 0) {
            console.log(`  ⚠️  ${coin}: 현재 전략으로 손실이 예상됩니다!`);
          }

          if (result.maxDrawdown > 30) {
            console.log(`  ⚠️  ${coin}: 최대 낙폭이 30%를 초과합니다!`);
          }

        } catch (error) {
          console.error(`  ❌ ${coin} 백테스팅 오류:`, error.message);
        }
      }

      console.log('\n' + '='.repeat(80));
      console.log('✅ 정기 백테스팅 완료');
      console.log(`⏳ 다음 백테스팅: ${new Date(Date.now() + config.backtestInterval).toLocaleString('ko-KR')}`);
      console.log('='.repeat(80));

    } catch (error) {
      console.error('백테스팅 루프 오류:', error.message);
      logger.error('Backtest Loop Error', { error: error.message });
    }
  };

  // 즉시 한 번 실행
  setTimeout(runBacktest, 60000); // 1분 후 첫 실행

  // 주기적 실행
  return setInterval(runBacktest, config.backtestInterval);
}

// 지속적 최적화 루프 (드라이 모드에서 더 짧은 간격)
function startOptimizationLoop(config, logger) {
  const upbit = new UpbitAPI(config.accessKey, config.secretKey);

  // 드라이 모드일 때 더 짧은 간격 (6시간), 실전은 24시간
  const interval = config.dryRun
    ? parseInt(process.env.OPTIMIZATION_INTERVAL_DRY) || 21600000  // 6시간
    : parseInt(process.env.OPTIMIZATION_INTERVAL) || 86400000;      // 24시간

  const optimizer = new ParameterOptimizer({
    populationSize: parseInt(process.env.POPULATION_SIZE) || 20,
    generations: parseInt(process.env.GENERATIONS) || 10,
    mutationRate: parseFloat(process.env.MUTATION_RATE) || 0.2,
    crossoverRate: parseFloat(process.env.CROSSOVER_RATE) || 0.7,
    eliteSize: parseInt(process.env.ELITE_SIZE) || 2
  });

  let cycleCount = 0;

  const runOptimization = async () => {
    try {
      cycleCount++;
      const now = new Date();
      console.log(`\n\n⏰ [${now.toLocaleString('ko-KR')}] 최적화 사이클 #${cycleCount} 시작`);
      console.log('='.repeat(80));

      // 대표 코인으로 최적화 (첫 번째 코인 사용)
      const targetCoin = config.targetCoins[0];
      const candleUnit = parseInt(process.env.BACKTEST_CANDLE_UNIT) || 15;
      const candleCount = parseInt(process.env.BACKTEST_CANDLE_COUNT) || 500;

      console.log('\n📊 분봉 데이터 수집 중...');
      const candles = await getMultipleMinuteCandles(upbit, targetCoin, candleUnit, candleCount);
      console.log(`✅ 데이터 수집 완료: ${candles.length}개 ${candleUnit}분봉`);

      if (candles.length < 250) {
        console.log('⚠️  데이터 부족, 다음 사이클 대기...');
        return;
      }

      // 최적화 실행
      const optimResult = await optimizer.optimize(candles);
      // optimizer.optimize()는 { parameters, fitness, generation } 반환
      const optimalParams = optimResult.parameters;
      const optimalFitness = optimResult.fitness;

      // 결과 출력
      console.log('\n' + '='.repeat(80));
      console.log('✨ 최적화 완료!');
      console.log('='.repeat(80));
      console.log('\n📋 최적 파라미터:');
      console.log('─'.repeat(80));
      console.log(`RSI_PERIOD=${optimalParams.rsiPeriod}`);
      console.log(`RSI_OVERSOLD=${optimalParams.rsiOversold}`);
      console.log(`RSI_OVERBOUGHT=${optimalParams.rsiOverbought}`);
      console.log(`MACD_FAST=${optimalParams.macdFast}`);
      console.log(`MACD_SLOW=${optimalParams.macdSlow}`);
      console.log(`MACD_SIGNAL=${optimalParams.macdSignal}`);
      console.log(`STOP_LOSS_PERCENT=${optimalParams.stopLossPercent}`);
      console.log(`TAKE_PROFIT_PERCENT=${optimalParams.takeProfitPercent}`);
      console.log(`BUY_THRESHOLD=${optimalParams.buyThreshold}`);
      console.log(`SELL_THRESHOLD=${optimalParams.sellThreshold}`);
      console.log(`예상 수익률: ${optimalFitness?.toFixed(2)}%`);
      console.log('─'.repeat(80));

      // 결과 저장
      // 학습 일수 계산 (분봉 개수 * 분봉 단위 / 분당 일수)
      const trainingDays = Math.round((candleCount * candleUnit) / (60 * 24));
      const optimConfig = {
        updatedAt: new Date().toISOString(),
        cycle: cycleCount,
        targetCoin,
        trainingDays: trainingDays,
        fitness: optimalFitness,
        parameters: optimalParams,
        note: '지속적 최적화를 통해 생성된 파라미터입니다.'
      };

      fs.writeFileSync(
        'optimal_config.json',
        JSON.stringify(optimConfig, null, 2),
        'utf8'
      );

      console.log('\n💾 최적 파라미터 저장: optimal_config.json');

      // 런타임 환경변수 업데이트
      console.log('\n🔄 런타임 환경변수 자동 업데이트 중...');
      process.env.RSI_PERIOD = String(optimalParams.rsiPeriod);
      process.env.RSI_OVERSOLD = String(optimalParams.rsiOversold);
      process.env.RSI_OVERBOUGHT = String(optimalParams.rsiOverbought);
      process.env.MACD_FAST = String(optimalParams.macdFast);
      process.env.MACD_SLOW = String(optimalParams.macdSlow);
      process.env.MACD_SIGNAL = String(optimalParams.macdSignal);
      process.env.STOP_LOSS_PERCENT = String(optimalParams.stopLossPercent);
      process.env.TAKE_PROFIT_PERCENT = String(optimalParams.takeProfitPercent);
      process.env.BUY_THRESHOLD = String(optimalParams.buyThreshold);
      process.env.SELL_THRESHOLD = String(optimalParams.sellThreshold);
      console.log('✅ 런타임 환경변수 업데이트 완료');

      // 최적화 이력 로그
      const historyFile = 'optimization_history.json';
      let history = [];

      if (fs.existsSync(historyFile)) {
        history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
      }

      history.push({
        timestamp: new Date().toISOString(),
        cycle: cycleCount,
        fitness: optimalFitness,
        parameters: optimalParams
      });

      // 최근 100개만 유지
      if (history.length > 100) {
        history = history.slice(-100);
      }

      fs.writeFileSync(
        historyFile,
        JSON.stringify(history, null, 2),
        'utf8'
      );

      console.log('📝 최적화 이력 저장: optimization_history.json');

      // 다음 사이클까지 대기
      const nextRun = new Date(Date.now() + interval);
      console.log(`\n⏳ 다음 최적화: ${nextRun.toLocaleString('ko-KR')} (${interval / 3600000}시간 후)`);
      console.log('─'.repeat(80));

    } catch (error) {
      console.error('\n❌ 최적화 오류:', error.message);
      logger.error('Optimization Loop Error', { error: error.message });
    }
  };

  // 2분 후 첫 실행
  setTimeout(runOptimization, 120000);

  // 주기적 실행
  return setInterval(runOptimization, interval);
}

// 종료 처리
function setupExitHandlers(trader, dashboardServer, backtestTimer, optimizationTimer, logger) {
  const gracefulShutdown = async () => {
    console.log('\n\n⏹️  시스템 종료 중...');

    trader.stop();

    if (dashboardServer) {
      dashboardServer.stop();
    }

    if (backtestTimer) {
      clearInterval(backtestTimer);
    }

    if (optimizationTimer) {
      clearInterval(optimizationTimer);
    }

    // 현재 포지션 정보 출력
    let hasPositions = false;
    for (const [coin, strategy] of trader.strategies.entries()) {
      if (strategy.currentPosition) {
        if (!hasPositions) {
          console.log('\n⚠️  주의: 아직 닫히지 않은 포지션이 있습니다!');
          hasPositions = true;
        }
        console.log(`\n[${coin}]`);
        console.log(strategy.currentPosition);
      }
    }

    // 최종 통계 출력
    console.log('\n📊 최종 거래 통계:');
    for (const [coin, strategy] of trader.strategies.entries()) {
      const stats = strategy.getStatistics();
      if (stats.totalTrades > 0) {
        console.log(`\n[${coin}]`);
        console.log(stats);
      }
    }

    console.log('\n👋 프로그램을 종료합니다.\n');
    process.exit(0);
  };

  // Ctrl+C
  process.on('SIGINT', gracefulShutdown);

  // kill 명령
  process.on('SIGTERM', gracefulShutdown);

  // 예외 처리
  process.on('uncaughtException', (error) => {
    console.error('\n💥 예상치 못한 오류 발생:', error);
    if (logger) {
      logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
    }
    gracefulShutdown();
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('\n💥 처리되지 않은 Promise 거부:', reason);
    if (logger) {
      logger.error('Unhandled Rejection', { reason });
    }
  });
}

// 메인 함수
async function main() {
  printBanner();

  // 설정 검증
  validateConfig();

  // 설정 로드
  const config = createConfig();

  // TARGET_COINS=ALL 인 경우 모든 KRW 마켓 자동 로드
  if (config.analyzeAllCoins || config.targetCoins.length === 0) {
    console.log('\n🔍 모든 KRW 마켓 코인 로드 중...');
    try {
      const upbit = new UpbitAPI(config.accessKey, config.secretKey);
      const markets = await upbit.getMarkets();
      const krwMarkets = markets
        .filter(m => m.market.startsWith('KRW-'))
        .map(m => m.market);

      config.targetCoins = krwMarkets;
      console.log(`✅ ${krwMarkets.length}개 KRW 마켓 로드 완료`);
    } catch (error) {
      console.error('❌ 마켓 목록 로드 실패:', error.message);
      // 실패 시 기본 코인으로 폴백
      config.targetCoins = ['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL', 'KRW-DOGE'];
      console.log('⚠️ 기본 코인으로 대체:', config.targetCoins.join(', '));
    }
  }

  printConfig(config);

  // 로거 초기화
  const logger = new Logger(config.logLevel);
  logger.info('다중 코인 자동매매 시스템 시작', { config });

  // 오래된 로그 정리
  logger.cleanOldLogs(7);

  // 자동매매 시스템 초기화
  const trader = new MultiCoinTrader(config);

  // 대시보드 시작
  let dashboardServer = null;
  if (config.enableDashboard) {
    dashboardServer = new DashboardServer(trader, config.dashboardPort);
    dashboardServer.start();
  }

  // 드라이 모드일 때 백테스팅 및 검증 시스템
  let backtestTimer = null;
  let optimizationTimer = null;

  if (config.dryRun) {
    backtestTimer = startBacktestingLoop(config, logger, trader);
  }

  // 지속적 최적화 시스템 (항상 실행)
  optimizationTimer = startOptimizationLoop(config, logger);

  // 종료 핸들러 설정
  setupExitHandlers(trader, dashboardServer, backtestTimer, optimizationTimer, logger);

  // 안내 메시지
  console.log('💡 팁:');
  console.log('  - Ctrl+C를 눌러 언제든지 종료할 수 있습니다.');
  console.log('  - 로그는 logs/ 디렉토리에 저장됩니다.');
  console.log('  - 웹 대시보드: http://localhost:' + config.dashboardPort);
  if (config.dryRun) {
    console.log('  - 백테스팅 결과: backtest_results_*.json 파일 확인');
    console.log('  - 백테스팅 간격: ' + (config.backtestInterval / 60000) + '분마다');
  }
  console.log('  - 최적화 결과: optimal_config.json 파일 확인');
  console.log('  - 최적화 간격: ' + (config.dryRun ?
    ((parseInt(process.env.OPTIMIZATION_INTERVAL_DRY) || 21600000) / 3600000) :
    ((parseInt(process.env.OPTIMIZATION_INTERVAL) || 86400000) / 3600000)) + '시간마다');
  console.log('');
  console.log('─'.repeat(80));

  // 카운트다운
  console.log('\n⏱️  3초 후 자동매매를 시작합니다...');
  await new Promise(resolve => setTimeout(resolve, 1000));
  console.log('⏱️  2...');
  await new Promise(resolve => setTimeout(resolve, 1000));
  console.log('⏱️  1...');
  await new Promise(resolve => setTimeout(resolve, 1000));

  // 자동매매 시작
  try {
    await trader.start();
  } catch (error) {
    console.error('\n❌ 치명적 오류:', error);
    logger.error('Fatal Error', { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

// 프로그램 실행
main().catch(error => {
  console.error('❌ 시작 실패:', error);
  process.exit(1);
});
