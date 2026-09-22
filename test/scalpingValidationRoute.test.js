import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import DashboardServer from '../src/api/dashboardServer.js';
import { createMockTrader } from '../src/scripts/runDashboard.js';

test('scalping validation API uses the configured staging path without falling back to root', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-validation-route-'));
  const reportFile = path.join(root, 'staging', 'scalping_validation.json');
  const missingFile = path.join(root, 'missing', 'scalping_validation.json');
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    validationMode: 'fixed_config',
    strategyMode: 'oversold_reaction_scalping',
    markets: ['KRW-BTC', 'KRW-XRP'],
    results: [],
    promotedMarkets: [],
    promoted: false
  }), 'utf8');

  const trader = createMockTrader();
  trader.config.scalpingValidationOutputFile = reportFile;
  const dashboard = new DashboardServer(trader, 0, {
    env: { ...process.env, DASHBOARD_TOKEN: '' }
  });
  const httpServer = dashboard.start();
  await new Promise(resolve => httpServer.once('listening', resolve));
  const port = httpServer.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/scalping-validation`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.available, true);
    assert.deepEqual(body.markets, ['KRW-BTC', 'KRW-XRP']);

    trader.config.scalpingValidationOutputFile = missingFile;
    const missingResponse = await fetch(`http://127.0.0.1:${port}/api/scalping-validation`);
    const missingBody = await missingResponse.json();
    assert.equal(missingResponse.status, 200);
    assert.equal(missingBody.available, false);
    assert.deepEqual(missingBody.results, []);
  } finally {
    dashboard.stop();
    trader.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
