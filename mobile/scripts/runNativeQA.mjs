// Native interaction QA only: synthetic data, temporary storage, no exchange or AI calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { ENV_SCHEMA } from '../../src/config/envSchema.js';

for (const name of Object.keys(ENV_SCHEMA)) delete process.env[name];
dotenv.config = () => ({ parsed: {} });
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-native-qa-'));
const logDir = process.env.COINPILOT_NATIVE_QA_LOG_DIR || stateDir;
fs.mkdirSync(logDir, { recursive: true });
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
server.httpServer.on('request', (request, response) => {
  response.once('finish', () => {
    fs.appendFileSync(path.join(logDir, 'qa-http.jsonl'), `${JSON.stringify({
      at: new Date().toISOString(),
      method: request.method,
      path: request.url.split('?')[0],
      status: response.statusCode,
      client: request.headers['user-agent'] || ''
    })}\n`, { mode: 0o600 });
  });
});
await server.start();
fs.writeFileSync(path.join(logDir, 'qa-server.json'), JSON.stringify({
  pid: process.pid, port: 39471, stateDir, synthetic: true
}, null, 2), { mode: 0o600 });
console.log(`SYNTHETIC NATIVE QA: port=39471 storage=${stateDir}; no real orders or credentials`);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await server.stop();
    process.exit(0);
  });
}
