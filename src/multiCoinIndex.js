import dotenv from 'dotenv';
import MultiCoinTrader from './trader/multiCoinTrader.js';
import DashboardServer from './api/dashboardServer.js';
import Logger from './utils/logger.js';
import { loadEnv, formatEnvErrors, formatEnvWarnings } from './config/envLoader.js';

dotenv.config();

function createConfig(env) {
  return {
    accessKey: env.UPBIT_ACCESS_KEY || '',
    secretKey: env.UPBIT_SECRET_KEY || '',

    // 다중 코인 설정
    targetCoins: env.TARGET_COINS
      ? env.TARGET_COINS.split(',')
      : ['KRW-BTC', 'KRW-ETH', 'KRW-XRP'],

    maxPositions: env.MAX_POSITIONS || 1000,
    portfolioAllocation: env.PORTFOLIO_ALLOCATION || 0.3,

    // 동적 투자금액 설정
    investmentAmount: env.INVESTMENT_AMOUNT || 50000,
    useProportionalInvestment: env.USE_PROPORTIONAL_INVESTMENT !== false, // 기본 true
    investmentRatio: env.INVESTMENT_RATIO || 0.05, // 총 자산의 5%
    minInvestmentAmount: env.MIN_INVESTMENT_AMOUNT || 5000,
    maxInvestmentAmount: env.MAX_INVESTMENT_AMOUNT || 500000,

    // 시드머니 설정 (드라이모드/실전모드 공통 - 누적손익 계산 기준)
    dryRunSeedMoney: env.DRY_RUN_SEED_MONEY || 10000000,
    initialSeedMoney: env.INITIAL_SEED_MONEY || 0, // 실전모드 초기투자금 (0이면 자동계산)

    stopLossPercent: env.STOP_LOSS_PERCENT || 5,
    takeProfitPercent: env.TAKE_PROFIT_PERCENT || 10,

    rsiPeriod: env.RSI_PERIOD || 14,
    rsiOversold: env.RSI_OVERSOLD || 30,
    rsiOverbought: env.RSI_OVERBOUGHT || 70,

    newsCheckInterval: env.NEWS_CHECK_INTERVAL || 300000,
    buyThreshold: env.BUY_THRESHOLD || 55,  // 기본값 55로 적극적 매수
    sellThreshold: env.SELL_THRESHOLD || 55,
    buyOnly: env.BUY_ONLY === true,  // 매수 전용 모드
    allowAveraging: env.ALLOW_AVERAGING !== false,  // 추가 매수 허용
    checkInterval: env.CHECK_INTERVAL || 60000,

    dryRun: env.DRY_RUN !== false,
    logLevel: env.LOG_LEVEL || 'info',
    enableDashboard: env.ENABLE_DASHBOARD !== false,
    dashboardPort: env.DASHBOARD_PORT || 3000
  };
}

async function main() {
  // 스키마 검증: 필수 env 누락/형식 오류는 부팅 시점에 실패시킨다.
  const { values: env, errors: envErrors, warnings: envWarnings } = loadEnv();
  if (envErrors.length > 0) {
    console.error(formatEnvErrors(envErrors));
    process.exit(1);
  }
  if (envWarnings.length > 0) {
    console.warn(formatEnvWarnings(envWarnings));
  }

  // 이 엔트리의 createConfig는 레거시 전략 형태이며 SCALP_* 계약을 매핑하지 않는다.
  // strategyMode 미설정 시 trader가 스캘핑으로 fallback하면서 레거시 risk 값이
  // 적용되므로, 스캘핑 해석이면 fail-closed로 종료하고 index.js로 유도한다.
  const strategyMode = env.TRADING_STRATEGY || 'oversold_reaction_scalping';
  if (strategyMode === 'oversold_reaction_scalping') {
    console.error('⛔ multiCoinIndex.js는 레거시 엔트리입니다. 스캘핑 모드는 `npm start`(src/index.js)로 실행하세요.');
    process.exit(1);
  }

  console.log('\n' + '='.repeat(80));
  console.log('🤖 다중 코인 자동매매 시스템');
  console.log('='.repeat(80));

  const config = createConfig(env);
  config.strategyMode = strategyMode;
  new Logger(config.logLevel);

  console.log('\n⚙️  설정:');
  console.log(`  모드: ${config.dryRun ? '🧪 모의투자' : '💰 실전투자'}`);
  console.log(`  분석 대상: ${config.targetCoins.length}개 코인`);
  console.log(`  최대 동시 포지션: ${config.maxPositions}`);
  console.log(`  포트폴리오 할당: ${(config.portfolioAllocation * 100).toFixed(0)}%`);

  const trader = new MultiCoinTrader(config);

  // 대시보드 시작
  let dashboardServer = null;
  if (config.enableDashboard) {
    dashboardServer = new DashboardServer(trader, config.dashboardPort);
    dashboardServer.start();
  }

  // 종료 핸들러
  const gracefulShutdown = () => {
    console.log('\n\n⏹️  시스템 종료 중...');
    trader.stop();

    if (dashboardServer) {
      dashboardServer.stop();
    }

    console.log('\n👋 프로그램을 종료합니다.\n');
    process.exit(0);
  };

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);

  console.log('\n⏱️  3초 후 시작합니다...');
  await new Promise(resolve => setTimeout(resolve, 3000));

  await trader.start();
}

main().catch(error => {
  console.error('❌ 시작 실패:', error);
  process.exit(1);
});
