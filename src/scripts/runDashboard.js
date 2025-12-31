import dotenv from 'dotenv';
import MultiCoinTrader from '../trader/multiCoinTrader.js';
import DashboardServer from '../api/dashboardServer.js';

dotenv.config();

function createMockTrader() {
  return {
    isRunning: false,
    dryRun: true,
    config: {
      targetCoin: process.env.TARGET_COIN || 'KRW-BTC'
    },
    targetCoins: process.env.TARGET_COINS
      ? process.env.TARGET_COINS.split(',')
      : ['KRW-BTC', 'KRW-ETH'],
    strategies: new Map(),
    newsData: [],
    async getAccountInfo() {
      return [
        { currency: 'KRW', balance: '1000000', locked: '0' }
      ];
    },
    getKRWBalance(accounts) {
      const krw = accounts.find(a => a.currency === 'KRW');
      return krw ? parseFloat(krw.balance) : 0;
    },
    start() {
      this.isRunning = true;
      console.log('✅ 트레이딩 시스템 시작 (대시보드 전용 모드)');
    },
    stop() {
      this.isRunning = false;
      console.log('⏹️  트레이딩 시스템 중지');
    }
  };
}

async function main() {
  console.log('\n🌐 대시보드 서버 시작...\n');

  const port = parseInt(process.env.DASHBOARD_PORT) || 3000;

  // 대시보드 전용 모드 (실제 트레이딩은 하지 않음)
  const mockTrader = createMockTrader();

  const server = new DashboardServer(mockTrader, port);
  server.start();

  console.log('\n📊 대시보드에 접속하세요:');
  console.log(`   http://localhost:${port}`);
  console.log('\nCtrl+C를 눌러 종료할 수 있습니다.\n');

  // 종료 핸들러
  process.on('SIGINT', () => {
    console.log('\n\n⏹️  대시보드 서버 종료 중...');
    server.stop();
    process.exit(0);
  });
}

main().catch(error => {
  console.error('대시보드 시작 실패:', error);
  process.exit(1);
});
