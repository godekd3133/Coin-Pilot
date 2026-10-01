import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import MultiCoinTrader from '../src/trader/multiCoinTrader.js';

test('the first durable LIVE intent syncs its ledger directory before dispatching the fake order', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-evidence-durability-'));
  const evidenceDirectory = path.join(directory, 'evidence');
  const evidenceFile = path.join(evidenceDirectory, 'live-execution-evidence.jsonl');
  const trader = new MultiCoinTrader({
    targetCoins: ['KRW-BTC'],
    dryRun: false,
    useNews: false,
    liveExecutionEvidenceFile: evidenceFile
  });
  const originalFsyncSync = fs.fsyncSync;
  const syncedDescriptorKinds = [];
  fs.fsyncSync = function (descriptor) {
    const stat = fs.fstatSync(descriptor);
    syncedDescriptorKinds.push(stat.isDirectory() ? 'directory' : 'file');
    return originalFsyncSync.call(fs, descriptor);
  };
  t.after(() => {
    fs.fsyncSync = originalFsyncSync;
    trader.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  trader._liveAccountStateKnown = true;
  trader._liveExchangeStateKnown = true;
  trader._liveEvidenceBlockedMarkets.clear();
  trader._liveOrderStateUnknownMarkets.clear();
  trader._livePendingOrderMarkets.clear();
  trader._liveVerifiedOrderMarkets.set('KRW-BTC', Date.now());
  trader.upbit = {
    async order(market, side, volume, price, orderType, clientIntentId) {
      assert.equal(market, 'KRW-BTC');
      assert.equal(side, 'bid');
      assert.equal(volume, 5_000);
      assert.equal(orderType, 'price');
      assert.match(clientIntentId, /^[0-9a-f-]{36}$/i);
      assert.deepEqual(syncedDescriptorKinds, ['directory', 'file', 'directory'],
        'new directory entries, first intent bytes, and ledger entry must be synced before the POST seam');
      const persistedEvents = fs.readFileSync(evidenceFile, 'utf8').trim().split('\n').map(JSON.parse);
      assert.deepEqual(persistedEvents.map(event => event.eventType), ['ORDER_INTENT']);
      return {
        success: true,
        data: {
          uuid: 'fake-order-accepted-after-durable-intent',
          market,
          side,
          ord_type: orderType,
          state: 'wait'
        }
      };
    }
  };

  const result = await trader.submitLiveOrder('KRW-BTC', 'bid', 5_000, undefined, 'price');
  assert.equal(result.success, true);
  assert.deepEqual(syncedDescriptorKinds, ['directory', 'file', 'directory', 'file'],
    'later evidence appends still sync file contents without redundantly syncing an unchanged directory entry');
  const persistedEvents = fs.readFileSync(evidenceFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(persistedEvents.map(event => event.eventType), ['ORDER_INTENT', 'ORDER_SUBMITTED']);
  assert.equal(persistedEvents[0].clientIntentId, persistedEvents[1].clientIntentId);
});

test('LIVE order dispatch fails closed when the evidence directory cannot be synced', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-evidence-sync-failure-'));
  const evidenceFile = path.join(directory, 'live-execution-evidence.jsonl');
  const trader = new MultiCoinTrader({
    targetCoins: ['KRW-BTC'],
    dryRun: false,
    useNews: false,
    liveExecutionEvidenceFile: evidenceFile
  });
  const originalFsyncSync = fs.fsyncSync;
  let orderCalls = 0;
  fs.fsyncSync = function (descriptor) {
    if (fs.fstatSync(descriptor).isDirectory()) throw new Error('directory fsync unavailable');
    return originalFsyncSync.call(fs, descriptor);
  };
  t.after(() => {
    fs.fsyncSync = originalFsyncSync;
    trader.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  trader._liveAccountStateKnown = true;
  trader._liveExchangeStateKnown = true;
  trader._liveEvidenceBlockedMarkets.clear();
  trader._liveOrderStateUnknownMarkets.clear();
  trader._livePendingOrderMarkets.clear();
  trader._liveVerifiedOrderMarkets.set('KRW-BTC', Date.now());
  trader.upbit = {
    async order() {
      orderCalls += 1;
      return { success: true, data: { uuid: 'must-not-dispatch' } };
    }
  };

  await assert.rejects(
    trader.submitLiveOrder('KRW-BTC', 'bid', 5_000, undefined, 'price'),
    /could not durably record live order intent/
  );
  assert.equal(orderCalls, 0);
  assert.ok(trader.liveExecutionEvidenceWriteError);
  const persistedEvents = fs.readFileSync(evidenceFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(persistedEvents.map(event => event.eventType), ['ORDER_INTENT']);
});
