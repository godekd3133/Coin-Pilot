import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import {
  resolveStagingCheckIntervalMs,
  withStagingOutputDir
} from './stagingDashboardConfig.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');
const runId = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
const outputRoot = path.resolve(process.env.STAGING_OUTPUT_DIR || path.join(projectRoot, '.staging-runtime', runId));
const port = String(process.env.STAGING_PORT || 3100);
const markets = process.env.STAGING_TARGET_COINS || 'KRW-BTC,KRW-ETH';
const checkIntervalMs = resolveStagingCheckIntervalMs(process.env.STAGING_CHECK_INTERVAL_MS);
const protocol = process.env.DASHBOARD_TLS_CERT_FILE && process.env.DASHBOARD_TLS_KEY_FILE
  ? 'https'
  : 'http';

fs.mkdirSync(outputRoot, { recursive: true });

const childEnv = {
  ...withStagingOutputDir(process.env, outputRoot),
  DRY_RUN: 'true',
  ENABLE_DASHBOARD: 'true',
  DASHBOARD_PORT: port,
  TARGET_COINS: markets,
  UPBIT_ACCESS_KEY: '',
  UPBIT_SECRET_KEY: '',
  CHECK_INTERVAL_DRY: String(checkIntervalMs),
  AI_ADVISOR_ENABLED: 'false',
  DRY_PORTFOLIO_FILE: path.join(outputRoot, 'dry_portfolio.json'),
  PAPER_VALIDATION_FILE: path.join(outputRoot, 'paper_validation.json'),
  PORTFOLIO_HISTORY_FILE: path.join(outputRoot, 'portfolio_history.json'),
  // Keep validation API/gate reads inside staging instead of leaking the
  // repository-root scalping_validation.json into the UI.
  SCALP_VALIDATION_OUTPUT_FILE: path.join(outputRoot, 'scalping_validation.json')
};

console.log(`🧪 격리 staging 대시보드 시작`);
console.log(`   모드: DRY_RUN=true`);
console.log(`   마켓: ${markets}`);
console.log(`   포트: ${port}`);
console.log(`   접속: ${protocol}://localhost:${port}`);
console.log(`   분석 주기: ${checkIntervalMs}ms (분석 공백 guard 60초와 겹치지 않도록 staging 기본 30초)`);
console.log(`   격리 저장소: ${outputRoot}`);

const child = spawn(process.execPath, [path.join(projectRoot, 'src/index.js')], {
  cwd: projectRoot,
  env: childEnv,
  stdio: 'inherit'
});

const shutdown = signal => {
  if (!child.killed) child.kill(signal);
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

child.once('exit', (code, signal) => {
  if (signal) {
    console.log(`staging 대시보드 종료: ${signal}`);
    process.exitCode = 0;
    return;
  }
  process.exitCode = code ?? 1;
});
