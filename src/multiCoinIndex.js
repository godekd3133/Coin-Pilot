import dotenv from 'dotenv';
import MultiCoinTrader from './trader/multiCoinTrader.js';
import DashboardServer from './api/dashboardServer.js';
import Logger from './utils/logger.js';

dotenv.config();

function createConfig() {
  return {
    accessKey: process.env.UPBIT_ACCESS_KEY || '',
    secretKey: process.env.UPBIT_SECRET_KEY || '',

    // 다중 코인 설정
    targetCoins: process.env.TARGET_COINS
      ? process.env.TARGET_COINS.split(',')
      : ['KRW-BTC', 'KRW-ETH', 'KRW-XRP'],

    maxPositions: parseInt(process.env.MAX_POSITIONS) || 1000,
    portfolioAllocation: parseFloat(process.env.PORTFOLIO_ALLOCATION) || 0.3,

    // 동적 투자금액 설정
    investmentAmount: parseInt(process.env.INVESTMENT_AMOUNT) || 50000,
    useProportionalInvestment: process.env.USE_PROPORTIONAL_INVESTMENT !== 'false', // 기본 true
    investmentRatio: parseFloat(process.env.INVESTMENT_RATIO) || 0.05, // 총 자산의 5%
    minInvestmentAmount: parseInt(process.env.MIN_INVESTMENT_AMOUNT) || 5000,
    maxInvestmentAmount: parseInt(process.env.MAX_INVESTMENT_AMOUNT) || 500000,

    // 시드머니 설정 (드라이모드/실전모드 공통 - 누적손익 계산 기준)
    dryRunSeedMoney: parseInt(process.env.DRY_RUN_SEED_MONEY) || 10000000,
    initialSeedMoney: parseInt(process.env.INITIAL_SEED_MONEY) || 0, // 실전모드 초기투자금 (0이면 자동계산)

    stopLossPercent: parseFloat(process.env.STOP_LOSS_PERCENT) || 5,
    takeProfitPercent: parseFloat(process.env.TAKE_PROFIT_PERCENT) || 10,

    rsiPeriod: parseInt(process.env.RSI_PERIOD) || 14,
    rsiOversold: parseInt(process.env.RSI_OVERSOLD) || 30,
    rsiOverbought: parseInt(process.env.RSI_OVERBOUGHT) || 70,

    newsCheckInterval: parseInt(process.env.NEWS_CHECK_INTERVAL) || 300000,
    buyThreshold: parseInt(process.env.BUY_THRESHOLD) || 55,  // 기본값 55로 적극적 매수
    sellThreshold: parseInt(process.env.SELL_THRESHOLD) || 55,
    buyOnly: process.env.BUY_ONLY === 'true',  // 매수 전용 모드
    allowAveraging: process.env.ALLOW_AVERAGING !== 'false',  // 추가 매수 허용
    checkInterval: parseInt(process.env.CHECK_INTERVAL) || 60000,

    dryRun: process.env.DRY_RUN !== 'false',
    logLevel: process.env.LOG_LEVEL || 'info',
    enableDashboard: process.env.ENABLE_DASHBOARD !== 'false',
    dashboardPort: parseInt(process.env.DASHBOARD_PORT) || 3000
  };
}

async function main() {
  console.log('\n' + '='.repeat(80));
  console.log('🤖 다중 코인 자동매매 시스템');
  console.log('='.repeat(80));

  const config = createConfig();
  const logger = new Logger(config.logLevel);

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
