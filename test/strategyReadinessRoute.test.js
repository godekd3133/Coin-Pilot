import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import DashboardServer from '../src/api/dashboardServer.js';
import { assessScalpingValidationReportFreshness } from '../src/research/scalpingValidationFreshness.js';
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
  trader.validatePromotionReport = (report, options = {}) => {
    gateCalls += 1;
    if (gateError) throw gateError;
    const freshness = assessScalpingValidationReportFreshness(report.generatedAt, options);
    if (!freshness.fresh) {
      throw Object.assign(new Error('Validation report is not current.'), { code: 'report_not_current' });
    }
  };
  const dashboard = new DashboardServer(trader, 0, { env: { ...process.env, DASHBOARD_TOKEN: '', DASHBOARD_READ_ONLY_TOKEN: '', DASHBOARD_MOBILE_TOKEN: '' } });
  const httpServer = await dashboard.start();
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
    assert.equal(ready.liveGate.enforcedFreshness, true);
    assert.equal(ready.runtime.dryRun, true);
    assert.equal(ready.runtime.readinessMeaning, 'virtual_validation_evidence');
    assert.equal(ready.runtime.applies, false);
    assert.equal(ready.currentEvidence, true);
    assert.equal(gateCalls, 1);

    trader.dryRun = false;
    trader.isScalpingMode = true;
    trader.strategyMode = 'oversold_reaction_scalping';
    trader.config.requireValidationPassForLive = false;
    const bypassResponse = await fetch(url);
    const bypass = await bypassResponse.json();
    assert.equal(bypass.status, 'NOT_REQUIRED');
    assert.equal(bypass.currentEvidence, false);
    assert.equal(bypass.runtime.applies, true);
    assert.equal(bypass.liveGate.checked, false);
    assert.equal(bypass.liveGate.passed, null);
    assert.equal(bypass.liveGate.enforced, false);
    assert.equal(bypass.liveGate.enforcedFreshness, false);
    assert.equal(bypass.decisionMeaning, 'performance_validation_optional');
    assert.deepEqual(bypass.blockers, []);
    assert.equal(gateCalls, 1, 'optional evidence must not call the performance validator');

    trader.dryRun = true;
    const paperBypassResponse = await fetch(url);
    const paperBypass = await paperBypassResponse.json();
    assert.equal(paperBypass.status, 'READY');
    assert.equal(paperBypass.runtime.applies, false);
    assert.equal(paperBypass.liveGate.passed, true);

    trader.dryRun = false;
    trader.isScalpingMode = false;
    const nonScalpingBypassResponse = await fetch(url);
    const nonScalpingBypass = await nonScalpingBypassResponse.json();
    assert.equal(nonScalpingBypass.status, 'READY');
    assert.equal(nonScalpingBypass.runtime.applies, false);
    assert.equal(nonScalpingBypass.liveGate.passed, true);

    trader.isScalpingMode = true;
    trader.config.requireValidationPassForLive = true;
    trader.dryRun = false;

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
    assert.equal(stale.liveGate.passed, false);
    assert.equal(stale.liveGate.enforcedFreshness, true);
    assert.equal(stale.liveGate.code, 'report_not_current');

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
    await dashboard.stop();
    trader.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('strategy readiness uses the actual MultiCoinTrader validator and blocks incomplete report settings', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-strategy-readiness-real-gate-'));
  const reportFile = path.join(root, 'scalping_validation.json');
  const trader = createMockTrader();
  fs.writeFileSync(reportFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    validationMode: 'fixed_config',
    strategyMode: 'oversold_reaction_scalping',
    markets: [...trader.targetCoins],
    config: {},
    promoted: true
  }), 'utf8');

  trader.config.scalpingValidationOutputFile = reportFile;
  const dashboard = new DashboardServer(trader, 0, { env: { ...process.env, DASHBOARD_TOKEN: '', DASHBOARD_READ_ONLY_TOKEN: '', DASHBOARD_MOBILE_TOKEN: '' } });
  const httpServer = await dashboard.start();

  try {
    const response = await fetch(`http://127.0.0.1:${httpServer.address().port}/api/strategy-readiness`);
    const body = await response.json();
    assert.equal(body.status, 'BLOCKED');
    assert.equal(body.currentEvidence, false);
    assert.equal(body.liveGate.checked, true);
    assert.equal(body.liveGate.passed, false);
    assert.equal(body.liveGate.code, 'report_config_incomplete');
    assert.equal(body.liveGate.reason, '점검 결과에 필요한 투자 설정이 빠져 있습니다. 현재 투자 설정으로 다시 점검해 주세요.');
  } finally {
    await dashboard.stop();
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
  const dashboard = new DashboardServer(trader, 0, { env: { ...process.env, DASHBOARD_TOKEN: '', DASHBOARD_READ_ONLY_TOKEN: '', DASHBOARD_MOBILE_TOKEN: '' } });
  const httpServer = await dashboard.start();

  try {
    const response = await fetch(`http://127.0.0.1:${httpServer.address().port}/api/strategy-readiness`);
    const body = await response.json();
    assert.equal(body.status, 'BLOCKED');
    assert.equal(body.liveGate.checked, false);
    assert.match(body.blockers.join(' '), /Runtime promotion validator is unavailable/);
  } finally {
    await dashboard.stop();
    trader.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
