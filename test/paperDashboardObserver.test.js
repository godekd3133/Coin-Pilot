import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import DashboardServer from '../src/api/dashboardServer.js';
import {
  attachReadOnlyPaperLedger,
  createMockTrader
} from '../src/scripts/runDashboard.js';

test('읽기 전용 paper dashboard는 최신 ledger를 표시하고 원본을 쓰지 않는다', async () => {
  const suffix = `coinpilot-dashboard-observer-${Date.now()}`;
  const ledgerFile = path.join(os.tmpdir(), `${suffix}.json`);
  const trader = createMockTrader();
  const now = new Date().toISOString();
  const baseLedger = trader.paperValidation;
  const ledger = {
    ...baseLedger,
    sessionId: 'paper-observer-fixture',
    active: true,
    processId: process.pid,
    startedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    heartbeatAt: now,
    baselineAssets: 1_000_000,
    snapshots: [
      { timestamp: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), totalAssets: 1_000_000 },
      { timestamp: now, totalAssets: 999_000 }
    ],
    strictTrades: [{
      action: 'CLOSE',
      coin: 'KRW-BTC',
      exitTime: now,
      profit: -100,
      profitPercent: -0.1,
      ledgerKey: 'paper-observer-fixture:close-1'
    }],
    strictOpenPositions: []
  };

  try {
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2), 'utf8');
    attachReadOnlyPaperLedger(trader, ledgerFile);
    const before = fs.readFileSync(ledgerFile, 'utf8');

    const first = await trader.getPaperValidationStatus();
    assert.equal(first.sessionId, 'paper-observer-fixture');
    assert.equal(first.active, true);
    assert.equal(first.currentAssets, 999_000);
    assert.equal(first.closedTradeCount, 1);
    assert.equal(first.realizedProfit, -100);
    assert.equal(first.configConsistent, true);
    assert.equal(fs.readFileSync(ledgerFile, 'utf8'), before);

    const updated = {
      ...ledger,
      heartbeatAt: new Date(Date.now() + 1_000).toISOString(),
      snapshots: [...ledger.snapshots, { timestamp: now, totalAssets: 998_500 }]
    };
    fs.writeFileSync(ledgerFile, JSON.stringify(updated, null, 2), 'utf8');
    const refreshed = await trader.getPaperValidationStatus();
    assert.equal(refreshed.currentAssets, 998_500);
    assert.equal(refreshed.closedTradeCount, 1);

    await assert.rejects(
      () => trader.startPaperValidationSession(),
      /읽기 전용/
    );
    await assert.rejects(
      () => trader.stopPaperValidationSession(),
      /읽기 전용/
    );
    assert.equal(fs.readFileSync(ledgerFile, 'utf8'), JSON.stringify(updated, null, 2));

    const dashboard = new DashboardServer(trader, 0);
    const httpServer = dashboard.start();
    await new Promise(resolve => httpServer.once('listening', resolve));
    const port = httpServer.address().port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/trade/buy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ coin: 'KRW-BTC', amount: 5000 })
      });
      const responseBody = await response.json();
      assert.equal(response.status, 403);
      assert.equal(responseBody.readOnlyObserver, true);

      const statusResponse = await fetch(`http://127.0.0.1:${port}/api/status`);
      const statusBody = await statusResponse.json();
      assert.equal(statusResponse.status, 200);
      assert.equal(statusBody.readOnlyObserver, true);

      const snapshotResponse = await fetch(`http://127.0.0.1:${port}/api/portfolio/snapshot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      });
      const snapshotBody = await snapshotResponse.json();
      assert.equal(snapshotResponse.status, 200);
      assert.equal(snapshotBody.success, true);
      assert.equal(fs.existsSync(trader.portfolioHistoryFile), true);
      assert.notEqual(
        path.resolve(trader.portfolioHistoryFile),
        path.resolve('portfolio_history.json')
      );
    } finally {
      dashboard.stop();
    }
  } finally {
    trader.stop();
    for (const file of [ledgerFile, trader.portfolioHistoryFile]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
});

test('읽기 전용 observer는 orphan 미청산 ledger를 UI에서도 fail-closed로 표시한다', async () => {
  const suffix = `coinpilot-dashboard-orphan-${Date.now()}`;
  const ledgerFile = path.join(os.tmpdir(), `${suffix}.json`);
  const trader = createMockTrader();
  const now = new Date().toISOString();
  const ledger = {
    ...trader.paperValidation,
    sessionId: 'paper-orphan-observer-fixture',
    active: true,
    processId: 999_999_999,
    startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    heartbeatAt: now,
    telemetry: {
      ...(trader.paperValidation.telemetry || {}),
      heartbeatAt: now
    },
    strictOpenPositions: [{ coin: 'KRW-BTC', entryPrice: 100 }],
    shadow: {
      ...(trader.paperValidation.shadow || {}),
      positions: { 'KRW-BTC': { coin: 'KRW-BTC', entryPrice: 100 } }
    },
    looseShadow: {
      ...(trader.paperValidation.looseShadow || {}),
      positions: {}
    }
  };

  try {
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2), 'utf8');
    attachReadOnlyPaperLedger(trader, ledgerFile);
    const dashboard = new DashboardServer(trader, 0);
    const httpServer = dashboard.start();
    await new Promise(resolve => httpServer.once('listening', resolve));
    const port = httpServer.address().port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/paper-validation`);
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.readOnlyObserver, true);
      assert.equal(body.orphaned, true);
      assert.equal(body.orphanReason, 'owner_process_missing');
      assert.equal(body.active, false);
      assert.equal(body.state, 'STOPPED');
      assert.equal(body.continuityEligible, false);
      assert.equal(body.endedWithOpenPositions, true);
      assert.equal(body.endedWithDiagnosticOpenPositions, true);
      assert.deepEqual(body.strictEvaluation.positions.map(position => position.coin), ['KRW-BTC']);
      assert.deepEqual(body.diagnosticOpenPositions.map(position => position.coin), ['KRW-BTC']);
    } finally {
      dashboard.stop();
    }
  } finally {
    trader.stop();
    if (fs.existsSync(ledgerFile)) fs.unlinkSync(ledgerFile);
  }
});
