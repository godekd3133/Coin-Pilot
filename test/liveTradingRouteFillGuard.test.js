import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import DashboardServer from '../src/api/dashboardServer.js';
import { executeLiveOrderWithEvidence } from '../src/api/routes/trading.js';
import MultiCoinTrader from '../src/trader/multiCoinTrader.js';

const tradingRouteSource = fs.readFileSync(
  path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src/api/routes/trading.js'),
  'utf8'
);

test('모든 UI 주문 route는 helper 외부에서 raw exchange order를 직접 호출하지 않는다', () => {
  assert.equal((tradingRouteSource.match(/server\.tradingSystem\.upbit\.order\(/g) || []).length, 0);
  assert.equal((tradingRouteSource.match(/tradingSystem\.upbit\.order\(/g) || []).length, 0);
  for (const route of ['/trade/quick', '/trade/execute', '/trade/execute-bundle', '/trade/buy', '/trade/sell', '/trade/smart-buy', '/trade/smart-sell']) {
    assert.match(tradingRouteSource, new RegExp(`router\\.post\\(['"]${route.replace('/', '\\/')}`));
  }
});

test('UI live-order helper fails closed if durable intent submission is unavailable', async () => {
  let rawOrderCalls = 0;
  const tradingSystem = {
    dryRun: false,
    upbit: {
      async order() {
        rawOrderCalls += 1;
        return { success: true, data: { uuid: 'should-not-submit' } };
      }
    },
    createLiveExecutionEvidence: event => event,
    recordLiveExecutionEvidence: () => true,
    getRuntimeSafetyStatus: () => ({ runtimeState: 'RUNNING', exchangeStateKnown: true }),
    canExecuteLiveOrder: () => true
  };

  const result = await executeLiveOrderWithEvidence(tradingSystem, {
    market: 'KRW-BTC',
    side: 'bid',
    volume: 50_000,
    orderType: 'price'
  });

  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'live_order_gate_unavailable');
  assert.equal(rawOrderCalls, 0);
});

test('UI live buy does not open a strategy position when the order is not filled', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-route-'));
  const evidenceFile = path.join(tempDir, 'evidence.jsonl');
  const cancellations = [];
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: false,
    useNews: false,
    liveExecutionEvidenceFile: evidenceFile
  });
  trader._liveAccountStateKnown = true;
  trader._liveExchangeStateKnown = true;
  trader._liveOrderStateUnknownMarkets = new Set();
  trader._livePendingOrderMarkets = new Set();
  trader._liveVerifiedOrderMarkets.set('KRW-BTC', Date.now());
  const strategy = trader.getStrategy('KRW-BTC');
  trader.upbit = {
    async getTicker() {
      return [{ market: 'KRW-BTC', trade_price: 100_000_000, trade_timestamp: Date.now() }];
    },
    async order() {
      return { success: true, data: { uuid: 'ui-route-order-1' } };
    },
    async waitForOrderFill() {
      return {
        filled: false,
        error: '체결 대기 시간 초과',
        order: {
          uuid: 'ui-route-order-1',
          market: 'KRW-BTC',
          side: 'bid',
          ord_type: 'price',
          state: 'wait',
          executed_volume: '0',
          remaining_volume: '0'
          }
        };
    },
    async cancelOrder(orderId) {
      cancellations.push(orderId);
      return { uuid: orderId, state: 'cancel' };
    }
  };
  const dashboard = new DashboardServer(trader, 0, { env: { ...process.env, DASHBOARD_TOKEN: '' } });
  const httpServer = await dashboard.start();
  const port = httpServer.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/trade/buy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'live-fill-guard-key' },
      body: JSON.stringify({ coin: 'KRW-BTC', amount: 200_000 })
    });
    const body = await response.json();
    assert.equal(response.status, 202);
    assert.equal(body.pending, true);
    assert.equal(body.idempotency.status, 'unknown');
    assert.equal(body.success, false);
    assert.equal(strategy.currentPosition, null);
    const events = fs.readFileSync(evidenceFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(events.map(event => event.eventType), ['ORDER_INTENT', 'ORDER_SUBMITTED', 'FILL_NOT_OBSERVED']);
    assert.deepEqual(cancellations, ['ui-route-order-1']);
  } finally {
    await dashboard.stop();
    trader.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
