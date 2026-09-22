import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import DashboardServer from '../src/api/dashboardServer.js';
import MultiCoinTrader from '../src/trader/multiCoinTrader.js';
import { createLiveExecutionEvidenceEvent } from '../src/research/liveExecutionEvidence.js';

function authOffEnv() {
  return { ...process.env, DASHBOARD_TOKEN: '', DASHBOARD_HOST: '', DASHBOARD_ALLOW_INSECURE: '' };
}

async function startDashboard(trader) {
  const dashboard = new DashboardServer(trader, 0, { env: authOffEnv() });
  const httpServer = dashboard.start();
  await once(httpServer, 'listening');
  return {
    dashboard,
    baseUrl: `http://127.0.0.1:${httpServer.address().port}`
  };
}

test('live execution evidence API stays read-only and separates empty history from gate blocks', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-evidence-route-'));
  const evidenceFile = path.join(tempDir, 'evidence.jsonl');
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: [],
    dryRun: false,
    useNews: false,
    liveExecutionEvidenceFile: evidenceFile
  });
  const ctx = await startDashboard(trader);

  try {
    const emptyResponse = await fetch(`${ctx.baseUrl}/api/live-execution-evidence`);
    const emptyBody = await emptyResponse.json();
    assert.equal(emptyResponse.status, 200);
    assert.equal(emptyBody.available, false);
    assert.equal(emptyBody.reason, 'evidence_file_not_found');
    assert.equal(emptyBody.status, 'not_observed');
    assert.equal(emptyBody.liveMode, true);
    assert.equal(emptyBody.runtimeOrderGateBlocked, false);
    assert.equal(emptyBody.historyNeedsReview, false);
    assert.equal(emptyBody.restartSafetyBlocked, false);
    assert.equal(emptyBody.evidenceFile, 'evidence.jsonl');
    assert.equal(emptyBody.researchOnly, true);
    assert.equal(emptyBody.promoted, false);

    const order = {
      uuid: 'route-order-1',
      market: 'KRW-BTC',
      side: 'bid',
      ord_type: 'price',
      state: 'done',
      executed_volume: '0.001',
      remaining_volume: '0',
      avg_price: '100000000',
      paid_fee: '50',
      trades_count: 1
    };
    const submitted = createLiveExecutionEvidenceEvent({
      eventType: 'ORDER_SUBMITTED',
      orderId: order.uuid,
      market: order.market,
      side: order.side,
      orderType: order.ord_type
    });
    const fill = createLiveExecutionEvidenceEvent({
      eventType: 'FILL_OBSERVED',
      orderId: order.uuid,
      market: order.market,
      side: order.side,
      orderType: order.ord_type,
      order,
      fillResult: { filled: true }
    });
    const settlement = createLiveExecutionEvidenceEvent({
      eventType: 'SETTLEMENT_READBACK',
      orderId: order.uuid,
      market: order.market,
      side: order.side,
      orderType: order.ord_type,
      order,
      fillResult: { filled: true },
      settlementReadback: {
        status: 'observed',
        observedAt: new Date().toISOString(),
        krwBalance: 899950,
        assetBalance: 0.001,
        lockedBalance: 0
      }
    });
    fs.writeFileSync(evidenceFile, `${[submitted, fill, settlement].map(event => JSON.stringify(event)).join('\n')}\n`, 'utf8');

    const observedResponse = await fetch(`${ctx.baseUrl}/api/live-execution-evidence`);
    const observedBody = await observedResponse.json();
    assert.equal(observedResponse.status, 200);
    assert.equal(observedBody.available, true);
    assert.equal(observedBody.status, 'settlement_ready');
    assert.equal(observedBody.readyForSettlementComparison, true);
    assert.equal(observedBody.historyNeedsReview, false);
    assert.equal(observedBody.restartSafetyBlocked, false);
    assert.equal(observedBody.reconciliation.submittedOrderCount, 1);
    assert.equal(observedBody.reconciliation.completeFillObservedCount, 1);
    assert.equal(observedBody.reconciliation.settlementObservedCount, 1);
    assert.equal(observedBody.reconciliation.readyForSettlementComparison, true);

    fs.writeFileSync(evidenceFile, `${JSON.stringify(submitted)}\n`, 'utf8');
    const unresolvedResponse = await fetch(`${ctx.baseUrl}/api/live-execution-evidence`);
    const unresolvedBody = await unresolvedResponse.json();
    assert.equal(unresolvedResponse.status, 200);
    assert.equal(unresolvedBody.status, 'review_required');
    assert.equal(unresolvedBody.historyNeedsReview, true);
    assert.equal(unresolvedBody.restartSafetyBlocked, true);
    assert.equal(unresolvedBody.runtimeOrderGateBlocked, false);
    assert.match(unresolvedBody.blockingReasons.join(' '), /unresolved submitted orders/);

    trader.liveExecutionEvidenceDataError = 'internal detail must stay private';
    const blockedResponse = await fetch(`${ctx.baseUrl}/api/live-execution-evidence`);
    const blockedBody = await blockedResponse.json();
    assert.equal(blockedResponse.status, 200);
    assert.equal(blockedBody.status, 'blocked');
    assert.equal(blockedBody.runtimeOrderGateBlocked, true);
    assert.equal(blockedBody.historyNeedsReview, true);
    assert.doesNotMatch(blockedBody.blockingReasons.join(' '), /internal detail/);
    assert.match(blockedBody.blockingReasons.join(' '), /현재 프로세스의 live evidence 안전 게이트/);
  } finally {
    ctx.dashboard.stop();
    trader.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
