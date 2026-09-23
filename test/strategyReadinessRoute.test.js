import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import DashboardServer from '../src/api/dashboardServer.js';
import { createMockTrader } from '../src/scripts/runDashboard.js';

test('strategy readiness reports current configured report, live gate result, and freshness separately', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-strategy-readiness-'));
  const reportFile = path.join(root, 'validation', 'scalping_validation.json');
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  const trader = createMockTrader();
  trader.config.scalpingValidationOutputFile = reportFile;
  trader.config.requireValidationPassForLive = true;
  let gateError = null;
  let gateCalls = 0;
  trader.validatePromotionReport = () => {
    gateCalls += 1;
    if (gateError) throw gateError;
  };
  const dashboard = new DashboardServer(trader, 0, { env: { ...process.env, DASHBOARD_TOKEN: '' } });
  const httpServer = dashboard.start();
  await new Promise(resolve => httpServer.once('listening', resolve));
  const url = `http://127.0.0.1:${httpServer.address().port}/api/strategy-readiness`;
  const writeReport = generatedAt => fs.writeFileSync(reportFile, JSON.stringify({
    generatedAt,
    validationMode: 'fixed_config',
    promoted: true
  }), 'utf8');

  try {
    writeReport(new Date().toISOString());
    const readyResponse = await fetch(url);
    const ready = await readyResponse.json();
    assert.equal(readyResponse.status, 200);
    assert.equal(ready.status, 'READY');
    assert.equal(ready.decisionMeaning, 'current_validation_evidence_only');
    assert.equal(ready.currentEvidence, true);
    assert.equal(ready.source, 'configured_scalping_validation_report');
    assert.equal(ready.report.filename, 'scalping_validation.json');
    assert.equal(ready.report.validationMode, 'fixed_config');
    assert.equal(ready.report.promoted, true);
    assert.equal(ready.report.freshness.fresh, true);
    assert.equal(ready.liveGate.checked, true);
    assert.equal(ready.liveGate.passed, true);
    assert.equal(ready.liveGate.enforcedFreshness, false);
    assert.equal(ready.runtime.dryRun, true);
    assert.equal(ready.runtime.readinessMeaning, 'virtual_validation_evidence');
    assert.equal(ready.runtime.applies, false);
    assert.equal(ready.currentEvidence, true);
    assert.equal(gateCalls, 1);

    gateError = new Error('실전 스캘핑 차단: validation report와 현재 runtime 설정이 다릅니다 (/private/path with sensitive value).');
    const driftResponse = await fetch(url);
    const drift = await driftResponse.json();
    assert.equal(drift.status, 'BLOCKED');
    assert.equal(drift.liveGate.passed, false);
    assert.equal(drift.liveGate.code, 'runtime_config_mismatch');
    assert.doesNotMatch(JSON.stringify(drift), /private|sensitive/);

    gateError = null;
    writeReport(new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString());
    const staleResponse = await fetch(url);
    const stale = await staleResponse.json();
    assert.equal(stale.status, 'BLOCKED');
    assert.equal(stale.currentEvidence, false);
    assert.equal(stale.report.freshness.reason, 'stale');
    assert.equal(stale.liveGate.passed, true);
    assert.equal(stale.liveGate.enforcedFreshness, false);

    writeReport(new Date(Date.now() + 60_000).toISOString());
    const futureResponse = await fetch(url);
    const future = await futureResponse.json();
    assert.equal(future.status, 'BLOCKED');
    assert.equal(future.currentEvidence, false);
    assert.equal(future.report.freshness.reason, 'future_timestamp');

    fs.writeFileSync(reportFile, '{broken json', 'utf8');
    const malformedResponse = await fetch(url);
    const malformed = await malformedResponse.json();
    assert.equal(malformed.status, 'BLOCKED');
    assert.equal(malformed.report.available, false);
    assert.equal(malformed.currentEvidence, false);
    assert.match(malformed.blockers.join(' '), /malformed, or unreadable/);

    fs.rmSync(reportFile);
    const missingResponse = await fetch(url);
    const missing = await missingResponse.json();
    assert.equal(missing.status, 'BLOCKED');
    assert.equal(missing.report.available, false);
    assert.equal(missing.currentEvidence, false);
    assert.match(missing.blockers.join(' '), /missing/);
  } finally {
    dashboard.stop();
    trader.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('strategy readiness uses the actual MultiCoinTrader validator and blocks incomplete report settings', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-strategy-readiness-real-gate-'));
  const reportFile = path.join(root, 'scalping_validation.json');
  fs.writeFileSync(reportFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    validationMode: 'fixed_config',
    strategyMode: 'oversold_reaction_scalping',
    markets: ['KRW-BTC'],
    config: {},
    promoted: true
  }), 'utf8');

  const trader = createMockTrader();
  trader.config.scalpingValidationOutputFile = reportFile;
  const dashboard = new DashboardServer(trader, 0, { env: { ...process.env, DASHBOARD_TOKEN: '' } });
  const httpServer = dashboard.start();
  await new Promise(resolve => httpServer.once('listening', resolve));

  try {
    const response = await fetch(`http://127.0.0.1:${httpServer.address().port}/api/strategy-readiness`);
    const body = await response.json();
    assert.equal(body.status, 'BLOCKED');
    assert.equal(body.currentEvidence, false);
    assert.equal(body.liveGate.checked, true);
    assert.equal(body.liveGate.passed, false);
    assert.equal(body.liveGate.code, 'report_config_incomplete');
    assert.equal(body.liveGate.reason, 'The fixed validation report settings are incomplete.');
  } finally {
    dashboard.stop();
    trader.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('strategy readiness stays blocked when the runtime promotion validator is unavailable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-strategy-readiness-no-gate-'));
  const reportFile = path.join(root, 'scalping_validation.json');
  fs.writeFileSync(reportFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    validationMode: 'fixed_config',
    promoted: true
  }), 'utf8');
  const trader = createMockTrader();
  trader.config.scalpingValidationOutputFile = reportFile;
  trader.validatePromotionReport = undefined;
  const dashboard = new DashboardServer(trader, 0, { env: { ...process.env, DASHBOARD_TOKEN: '' } });
  const httpServer = dashboard.start();
  await new Promise(resolve => httpServer.once('listening', resolve));

  try {
    const response = await fetch(`http://127.0.0.1:${httpServer.address().port}/api/strategy-readiness`);
    const body = await response.json();
    assert.equal(body.status, 'BLOCKED');
    assert.equal(body.liveGate.checked, false);
    assert.match(body.blockers.join(' '), /Runtime promotion validator is unavailable/);
  } finally {
    dashboard.stop();
    trader.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
