import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { createMockTrader } from '../src/scripts/runDashboard.js';

test('dashboard mock은 생성자 단계부터 사용자 persistence 경로를 격리한다', () => {
  const trader = createMockTrader();
  try {
    assert.equal(path.dirname(trader.virtualPortfolioFile), os.tmpdir());
    assert.equal(path.dirname(trader.paperValidationFile), os.tmpdir());
    assert.equal(path.dirname(trader.config.aiMonitoringFile), os.tmpdir());
    assert.match(path.basename(trader.virtualPortfolioFile), /^coin-pilot-dashboard-\d+\.dry_portfolio\.json$/);
    assert.match(path.basename(trader.paperValidationFile), /^coin-pilot-dashboard-\d+\.paper_validation\.json$/);
    assert.notEqual(path.resolve(trader.virtualPortfolioFile), path.resolve('dry_portfolio.json'));
    assert.notEqual(path.resolve(trader.paperValidationFile), path.resolve('paper_validation.json'));
    assert.notEqual(path.resolve(trader.config.aiMonitoringFile), path.resolve('ai_monitoring_sessions.json'));
  } finally {
    trader.stop();
  }
});
