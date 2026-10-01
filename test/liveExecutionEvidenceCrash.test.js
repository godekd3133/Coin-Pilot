import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import MultiCoinTrader from '../src/trader/multiCoinTrader.js';

function createTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-order-crash-'));
}

function makeTrader(root) {
  return new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: false,
    accessKey: 'fake-access-key',
    secretKey: 'fake-secret-key',
    initialSeedMoney: 1,
    virtualPortfolioFile: path.join(root, 'dry_portfolio.json'),
    paperValidationFile: path.join(root, 'paper_validation.json'),
    portfolioHistoryFile: path.join(root, 'portfolio_history.json'),
    liveExecutionEvidenceFile: path.join(root, 'live_evidence.jsonl'),
    positionRiskCheckIntervalMs: 0,
    useNews: false
  });
}

function waitForAcceptedMessage(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const finish = (error, message) => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve(message);
    };
    const onMessage = message => {
      if (message?.type === 'accepted') finish(null, message);
      else if (message?.type === 'failed') {
        finish(new Error(`child submitLiveOrder failed: ${message.error}`));
      }
    };
    const onError = error => finish(error);
    const onExit = (code, signal) => finish(
      new Error(`child exited before fake acceptance (code=${code}, signal=${signal})`)
    );
    const timer = setTimeout(
      () => finish(new Error(`timed out waiting for fake order acceptance; stderr: ${child.stderrText || ''}`)),
      timeoutMs
    );
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve([child.exitCode, child.signalCode]);
  }
  return new Promise((resolve, reject) => {
    const finish = (error, result) => {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error);
      else resolve(result);
    };
    const onExit = (code, signal) => finish(null, [code, signal]);
    const onError = error => finish(error);
    const timer = setTimeout(
      () => finish(new Error('owned test child did not exit after SIGKILL')),
      timeoutMs
    );
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

test('SIGKILL after fake Upbit acceptance recovers the durable intent without reposting', {
  timeout: 15_000
}, async t => {
  const root = createTempRoot();
  const evidenceFile = path.join(root, 'live_evidence.jsonl');
  const acceptedOrderFile = path.join(root, 'fake_exchange_order.json');
  const traderModuleUrl = new URL('../src/trader/multiCoinTrader.js', import.meta.url).href;
  const childScript = String.raw`
import fs from 'node:fs';
const { default: MultiCoinTrader } = await import(process.env.COINPILOT_TEST_TRADER_MODULE);
const root = process.env.COINPILOT_TEST_ROOT;
const acceptedOrderFile = process.env.COINPILOT_TEST_ACCEPTED_ORDER_FILE;
const trader = new MultiCoinTrader({
  strategyMode: 'oversold_reaction_scalping',
  targetCoins: ['KRW-BTC'],
  dryRun: false,
  accessKey: 'fake-access-key',
  secretKey: 'fake-secret-key',
  initialSeedMoney: 1,
  virtualPortfolioFile: root + '/dry_portfolio.json',
  paperValidationFile: root + '/paper_validation.json',
  portfolioHistoryFile: root + '/portfolio_history.json',
  liveExecutionEvidenceFile: process.env.COINPILOT_TEST_EVIDENCE_FILE,
  positionRiskCheckIntervalMs: 0,
  useNews: false
});
trader._liveAccountStateKnown = true;
trader._liveExchangeStateKnown = true;
trader._liveEvidenceBlockedMarkets.clear();
trader._liveOrderStateUnknownMarkets.clear();
trader._livePendingOrderMarkets.clear();
trader._liveVerifiedOrderMarkets.set('KRW-BTC', Date.now());
trader.upbit = {
  async order(market, side, amount, price, orderType, identifier) {
    const acceptedOrder = {
      uuid: '6f1e2d3c-4b5a-4c6d-8e9f-0123456789ab',
      identifier,
      market,
      side,
      ord_type: orderType,
      state: 'wait',
      price: String(amount),
      volume: '0.05',
      remaining_volume: '0.05',
      executed_volume: '0',
      executed_funds: '0',
      paid_fee: '0',
      created_at: new Date().toISOString()
    };
    fs.writeFileSync(acceptedOrderFile, JSON.stringify(acceptedOrder), { mode: 0o600 });
    await new Promise((resolve, reject) => {
      process.send({
        type: 'accepted',
        pid: process.pid,
        identifier,
        uuid: acceptedOrder.uuid
      }, error => error ? reject(error) : resolve());
    });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    return { success: true, data: acceptedOrder };
  }
};
trader.submitLiveOrder('KRW-BTC', 'bid', 5000, null, 'price')
  .catch(error => process.send({ type: 'failed', error: error.stack || error.message }));
`;

  let child;
  let restartedTrader;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForChildExit(child, 2_000).catch(() => undefined);
    }
    restartedTrader?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
    cwd: process.cwd(),
    env: {
      NODE_ENV: 'test',
      NODE_TEST_CONTEXT: '1',
      COINPILOT_TEST_ROOT: root,
      COINPILOT_TEST_EVIDENCE_FILE: evidenceFile,
      COINPILOT_TEST_ACCEPTED_ORDER_FILE: acceptedOrderFile,
      COINPILOT_TEST_TRADER_MODULE: traderModuleUrl
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  });
  let stderrText = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderrText += chunk; });
  Object.defineProperty(child, 'stderrText', { get: () => stderrText });

  const accepted = await waitForAcceptedMessage(child, 8_000);
  assert.equal(accepted.pid, child.pid);
  assert.match(accepted.identifier, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.equal(accepted.uuid, '6f1e2d3c-4b5a-4c6d-8e9f-0123456789ab');

  assert.equal(child.kill('SIGKILL'), true, 'send SIGKILL only to the owned test child PID');
  const [exitCode, exitSignal] = await waitForChildExit(child, 2_000);
  assert.equal(exitCode, null);
  assert.equal(exitSignal, 'SIGKILL');

  const eventsBeforeRestart = fs.readFileSync(evidenceFile, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  assert.deepEqual(eventsBeforeRestart.map(event => event.eventType), ['ORDER_INTENT']);
  assert.equal(eventsBeforeRestart[0].clientIntentId, accepted.identifier);
  assert.equal(eventsBeforeRestart[0].identifier, accepted.identifier);

  const acceptedOrder = JSON.parse(fs.readFileSync(acceptedOrderFile, 'utf8'));
  assert.equal(acceptedOrder.identifier, accepted.identifier);
  assert.equal(acceptedOrder.uuid, accepted.uuid);
  assert.equal(acceptedOrder.state, 'wait');

  restartedTrader = makeTrader(root);
  let orderLookups = 0;
  let orderPosts = 0;
  restartedTrader.upbit = {
    async getOrder(identifier, options) {
      orderLookups += 1;
      assert.equal(identifier, accepted.identifier);
      assert.equal(options.identifier, true);
      assert.equal(options.priority, 'risk');
      return JSON.parse(fs.readFileSync(acceptedOrderFile, 'utf8'));
    },
    async order() {
      orderPosts += 1;
      throw new Error('recovery must not submit another order');
    }
  };

  assert.equal(restartedTrader.liveExecutionEvidenceStartup.reconciliation.unresolvedOrderIntentCount, 1);
  const recovery = await restartedTrader.resolveUnresolvedLiveOrders();
  assert.deepEqual(recovery, { complete: true });
  assert.equal(orderLookups, 1);
  assert.equal(orderPosts, 0);
  assert.equal(restartedTrader._liveUnresolvedOrderIntents.size, 0);
  assert.equal(restartedTrader._liveUnresolvedOrderIds.get(accepted.uuid)?.clientIntentId, accepted.identifier);

  const recoveredEvents = fs.readFileSync(evidenceFile, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  assert.deepEqual(recoveredEvents.map(event => event.eventType), [
    'ORDER_INTENT',
    'ORDER_SUBMITTED',
    'ORDER_STATE_OBSERVED'
  ]);
  assert.equal(recoveredEvents[1].orderId, accepted.uuid);
  assert.equal(recoveredEvents[2].orderId, accepted.uuid);
  assert.equal(restartedTrader._liveUnresolvedOrderIds.has(accepted.uuid), true);
});
