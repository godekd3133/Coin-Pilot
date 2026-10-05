// Native interaction QA only: synthetic data, temporary storage, no exchange or AI calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { ENV_SCHEMA } from '../../src/config/envSchema.js';

for (const name of Object.keys(ENV_SCHEMA)) delete process.env[name];
dotenv.config = () => ({ parsed: {} });
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-native-qa-'));
const env = {
  DASHBOARD_HOST: '0.0.0.0',
  DASHBOARD_MOBILE_TOKEN: 'coinpilot-synthetic-native-qa',
  STAGING_OUTPUT_DIR: stateDir
};
Object.assign(process.env, env);
const { createMockTrader } = await import('../../src/scripts/runDashboard.js');
const { default: DashboardServer } = await import('../../src/api/dashboardServer.js');
const trader = createMockTrader();
trader.config.aiAdvisorEnabled = false;
trader.config.aiMonitoringFile = path.join(stateDir, 'ai.json');
trader.config.scalpingValidationOutputFile = path.join(stateDir, 'validation.json');
trader.config.strategyResearchOutputFile = path.join(stateDir, 'research.json');
trader.newsMonitor = null;
trader.newsData = [{
  title: 'QA 예시 뉴스: 시장 화면과 새로고침 확인',
  url: 'https://example.com/coinpilot-qa',
  source: 'QA 예시',
  publishedAt: new Date().toISOString()
}];
const server = new DashboardServer(trader, 39471, {
  env,
  optimizationStateDir: stateDir,
  paperForwardCohortRootDir: stateDir
});
server.aiAdvisor.enabled = false;
await server.start();
console.log(`SYNTHETIC NATIVE QA: port=39471 storage=${stateDir}; no real orders or credentials`);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await server.stop();
    process.exit(0);
  });
}
