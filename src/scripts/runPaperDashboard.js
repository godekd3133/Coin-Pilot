import dotenv from 'dotenv';
import DashboardServer from '../api/dashboardServer.js';
import { attachReadOnlyPaperLedger, createMockTrader } from './runDashboard.js';

dotenv.config();

export async function main() {
  const ledgerFile = process.env.PAPER_DASHBOARD_LEDGER_FILE || process.argv[2];
  if (!ledgerFile) {
    throw new Error('PAPER_DASHBOARD_LEDGER_FILE 또는 첫 번째 인자로 paper ledger 경로를 지정하세요.');
  }

  const port = parseInt(process.env.DASHBOARD_PORT) || 3000;
  const trader = attachReadOnlyPaperLedger(createMockTrader(), ledgerFile);
  const server = new DashboardServer(trader, port);
  server.start();

  console.log('\n📊 읽기 전용 forward paper 대시보드');
  console.log(`   ledger: ${trader.paperValidationFile}`);
  console.log(`   port: ${server.protocol}://localhost:${port}`);
  console.log('   세션 start/stop과 주문 API는 차단됩니다.');

  const shutdown = signal => {
    console.log(`\n⏹️  paper 대시보드 종료: ${signal}`);
    server.stop();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('paper 대시보드 시작 실패:', error.message);
    process.exit(1);
  });
}
