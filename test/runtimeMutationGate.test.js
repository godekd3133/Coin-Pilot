import assert from 'node:assert/strict';
import fs from 'node:fs';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import DashboardServer from '../src/api/dashboardServer.js';
import { createMockTrader } from '../src/scripts/runDashboard.js';
import MultiCoinTrader from '../src/trader/multiCoinTrader.js';

async function startDashboard(t) {
  const trader = createMockTrader();
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-runtime-mutation-'));
  trader.config.manualOrderIdempotencyFile = path.join(storageRoot, 'manual_order_idempotency.json');
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const dashboard = new DashboardServer(trader, 0, {
    env: { ...process.env, DASHBOARD_TOKEN: '', DASHBOARD_HOST: '', DASHBOARD_ALLOW_INSECURE: '' }
  });
  const server = await dashboard.start();
  t.after(async () => {
    const closed = once(server, 'close');
    dashboard.stop();
    trader.stop();
    await closed;
  });
  return { trader, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function post(baseUrl, path, body) {
  post.sequence = (post.sequence || 0) + 1;
  return fetch(`${baseUrl}/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': `runtime-mutation-${post.sequence}` },
    body: JSON.stringify(body)
  });
}

test('configuration changes are locked while trading runs and allowed after a normal stop', async t => {
  const { trader, baseUrl } = await startDashboard(t);
  const originalStop = trader.config.stopLossPercent;
  trader.start();

  const whileRunning = await post(baseUrl, '/config/update', { stopLossPercent: 2 });
  const runningBody = await whileRunning.json();
  assert.equal(whileRunning.status, 409);
  assert.equal(runningBody.code, 'trading_runtime_mutation_blocked');
  assert.equal(trader.config.stopLossPercent, originalStop);

  trader.stop();
  const whileStopped = await post(baseUrl, '/config/update', { stopLossPercent: 2 });
  const stoppedBody = await whileStopped.json();
  assert.equal(whileStopped.status, 200);
  assert.equal(stoppedBody.success, true);
  assert.equal(trader.config.stopLossPercent, 2);
});

test('stopped LIVE configuration remains editable before startup reconciliation', async t => {
  const { trader, baseUrl } = await startDashboard(t);
  trader.dryRun = false;
  trader._liveAccountStateKnown = false;
  trader._liveExchangeStateKnown = false;
  trader._livePendingOrderMarkets = new Set();
  const response = await post(baseUrl, '/config/update', { stopLossPercent: 2.5 });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(trader.config.stopLossPercent, 2.5);
});

test('virtual wallet mutations require a stopped, non-evidence paper session', async t => {
  const { trader, baseUrl } = await startDashboard(t);
  const originalBalance = trader.virtualPortfolio.krwBalance;
  trader.paperValidation.active = true;

  const duringPaperSession = await post(baseUrl, '/virtual/deposit', { amount: 10_000 });
  const paperBody = await duringPaperSession.json();
  assert.equal(duringPaperSession.status, 409);
  assert.equal(paperBody.code, 'paper_evidence_mutation_blocked');
  assert.equal(trader.virtualPortfolio.krwBalance, originalBalance);

  const blockedWithdraw = await post(baseUrl, '/virtual/withdraw', { amount: 10_000 });
  const blockedReset = await post(baseUrl, '/virtual/reset', { seedMoney: 500_000 });
  assert.equal(blockedWithdraw.status, 409);
  assert.equal(blockedReset.status, 409);
  assert.equal(trader.virtualPortfolio.krwBalance, originalBalance);

  trader.paperValidation.active = false;
  trader.start();
  const whileRunning = await post(baseUrl, '/virtual/deposit', { amount: 10_000 });
  assert.equal(whileRunning.status, 409);
  assert.equal(trader.virtualPortfolio.krwBalance, originalBalance);

  trader.stop();
  const whileStopped = await post(baseUrl, '/virtual/deposit', { amount: 10_000 });
  assert.equal(whileStopped.status, 200);
  assert.equal(trader.virtualPortfolio.krwBalance, originalBalance + 10_000);
});

test('virtual wallet persistence failure leaves balances, positions, and history unchanged', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-wallet-mutation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const virtualPortfolioFile = path.join(directory, 'dry_portfolio.json');
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false,
    virtualPortfolioFile
  });
  const dashboard = new DashboardServer(trader, 0, {
    env: { ...process.env, DASHBOARD_TOKEN: '', DASHBOARD_HOST: '', DASHBOARD_ALLOW_INSECURE: '' }
  });
  const server = await dashboard.start();
  t.after(async () => {
    const closed = once(server, 'close');
    dashboard.stop();
    trader.stop();
    await closed;
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const strategy = trader.getStrategy('KRW-BTC');

  const deposit = await post(baseUrl, '/virtual/deposit', { amount: 10_000 });
  assert.equal(deposit.status, 200);
  assert.equal(trader.virtualPortfolio.krwBalance, 1_010_000);
  assert.equal(trader.initialSeedMoney, 1_010_000);
  assert.equal(JSON.parse(fs.readFileSync(virtualPortfolioFile, 'utf8')).krwBalance, 1_010_000);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(virtualPortfolioFile).mode & 0o777, 0o600);
  }

  const withdraw = await post(baseUrl, '/virtual/withdraw', { amount: 5_000 });
  assert.equal(withdraw.status, 200);
  assert.equal(trader.virtualPortfolio.krwBalance, 1_005_000);
  assert.equal(trader.initialSeedMoney, 1_005_000);

  const reset = await post(baseUrl, '/virtual/reset', { seedMoney: 500_000 });
  assert.equal(reset.status, 200);
  assert.equal(trader.virtualPortfolio.krwBalance, 500_000);
  assert.equal(trader.initialSeedMoney, 500_000);
  assert.equal(trader.virtualPortfolio.holdings.size, 0);
  const persistedReset = JSON.parse(fs.readFileSync(virtualPortfolioFile, 'utf8'));
  assert.equal(persistedReset.krwBalance, 500_000);
  assert.equal(persistedReset.initialSeedMoney, 500_000);
  assert.deepEqual(persistedReset.holdings, {});

  const position = { coin: 'KRW-BTC', entryPrice: 100_000_000, amount: 0.25, entryTime: '2026-09-29T00:00:00.000Z' };
  const tradeHistory = [{ type: 'SELL', profit: 125 }];
  strategy.currentPosition = position;
  strategy.tradeHistory = tradeHistory;
  trader.virtualPortfolio.holdings.set('KRW-BTC', { amount: 0.25, avgPrice: 100_000_000 });
  trader.saveVirtualPortfolio();
  const persistedBeforeFailure = fs.readFileSync(virtualPortfolioFile, 'utf8');
  trader.writeJsonAtomically = () => { throw new Error('simulated disk write failure'); };

  for (const [route, body] of [
    ['/virtual/deposit', { amount: 10_000 }],
    ['/virtual/withdraw', { amount: 5_000 }],
    ['/virtual/reset', { seedMoney: 900_000 }]
  ]) {
    const response = await post(baseUrl, route, body);
    assert.equal(response.status, 503, `${route} should fail before mutation when the reservation cannot be persisted`);
    const result = await response.json();
    assert.equal(result.success, false);
    assert.equal(result.pending, true);
    assert.equal(trader.virtualPortfolio.krwBalance, 500_000);
    assert.equal(trader.initialSeedMoney, 500_000);
    assert.deepEqual(Array.from(trader.virtualPortfolio.holdings.entries()), [
      ['KRW-BTC', { amount: 0.25, avgPrice: 100_000_000 }]
    ]);
    assert.deepEqual(strategy.currentPosition, position);
    assert.deepEqual(strategy.tradeHistory, tradeHistory);
    assert.equal(fs.readFileSync(virtualPortfolioFile, 'utf8'), persistedBeforeFailure);
  }
});
