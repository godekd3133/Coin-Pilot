import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runLegacyMultiCoinRuntime } from '../src/multiCoinIndex.js';

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-multi-index-startup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeConfig(root, overrides = {}) {
  return {
    dryRun: true,
    enableDashboard: false,
    dashboardPort: 0,
    virtualPortfolioFile: path.join(root, 'portfolio.json'),
    manualOrderIdempotencyFile: path.join(root, 'manual-order-idempotency.json'),
    ...overrides
  };
}

function writerLockPath(config) {
  return `${path.resolve(config.virtualPortfolioFile)}.manual_order_writer.lock`;
}

function journalWriterLockPath(config) {
  return `${path.resolve(config.manualOrderIdempotencyFile)}.manual_order_journal_writer.lock`;
}

function makeProcessApi(events) {
  const processApi = new EventEmitter();
  processApi.exitCode = 0;
  let resolveExit;
  const exited = new Promise(resolve => {
    resolveExit = resolve;
  });
  return {
    processApi,
    exited,
    exitProcess: code => {
      events.push(`exit:${code}`);
      resolveExit(code);
    }
  };
}

function exitHandlerOptions(events) {
  const process = makeProcessApi(events);
  return {
    processApi: process.processApi,
    exitProcess: process.exitProcess,
    exited: process.exited,
    consoleApi: { log() {}, error() {} },
    finalizeActivePaperValidation: async () => null
  };
}

function makeFakeTrader(config, events, { start = async () => {} } = {}) {
  return {
    config,
    dryRun: config.dryRun,
    virtualPortfolioFile: config.virtualPortfolioFile,
    strategies: new Map(),
    persistManualOrderIdempotencyRecords() {},
    start: async () => {
      events.push('trader-start');
      await start();
    },
    stop: () => events.push('trader-stop')
  };
}

test('legacy dashboard startup adopts the lock acquired before trader construction', async t => {
  const root = makeRoot(t);
  const config = makeConfig(root, { enableDashboard: true });
  const lockPath = writerLockPath(config);
  const journalLockPath = journalWriterLockPath(config);
  const events = [];
  const exit = exitHandlerOptions(events);
  let constructorLockOwner;
  let dashboardStore;
  let traderMarketDataSource;
  let dashboardMarketDataSource;
  const sharedMarketDataSource = { id: 'shared-public-market-source' };

  const runtime = await runLegacyMultiCoinRuntime(config, {
    createPublicMarketDataSource: () => sharedMarketDataSource,
    createTrader: marketDataSource => {
      assert.equal(fs.existsSync(lockPath), true, 'profile lock must precede portfolio hydration');
      traderMarketDataSource = marketDataSource;
      constructorLockOwner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      return makeFakeTrader(config, events);
    },
    createDashboard: (trader, port, options) => {
      assert.equal(port, config.dashboardPort);
      dashboardMarketDataSource = options.publicMarketDataSource;
      dashboardStore = options.manualOrderIdempotencyStore;
      return {
        start: async () => {
          assert.equal(fs.existsSync(lockPath), true);
          await dashboardStore.initialize();
          assert.equal(dashboardStore.writerLock.lockId, constructorLockOwner.lockId);
          assert.equal(dashboardStore.writerLock.stat.ino, fs.statSync(lockPath).ino);
          events.push('dashboard-start');
        },
        stop: async () => {
          events.push('dashboard-stop');
          dashboardStore.releaseWriterLock();
        }
      };
    },
    waitBeforeTraderStart: async () => {},
    exitHandlerOptions: exit
  });

  assert.equal(runtime.manualOrderIdempotencyStore, dashboardStore);
  assert.strictEqual(traderMarketDataSource, sharedMarketDataSource);
  assert.strictEqual(dashboardMarketDataSource, sharedMarketDataSource);
  assert.deepEqual(events, ['dashboard-start', 'trader-start']);
  assert.equal(fs.existsSync(lockPath), true, 'the lock remains owned for the dashboard runtime lifetime');
  assert.equal(fs.existsSync(journalLockPath), true, 'the journal lock remains owned for the dashboard runtime lifetime');
  assert.equal(await runtime.exitHandlers.gracefulShutdown(), undefined);
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.existsSync(journalLockPath), false);
  assert.deepEqual(events, ['dashboard-start', 'trader-start', 'trader-stop', 'dashboard-stop', 'exit:0']);
});

test('legacy trader-constructor failure releases the pre-hydration lock', async t => {
  const root = makeRoot(t);
  const config = makeConfig(root);
  const lockPath = writerLockPath(config);
  const constructorError = new Error('fake trader constructor failure');

  await assert.rejects(runLegacyMultiCoinRuntime(config, {
    createTrader: () => {
      assert.equal(fs.existsSync(lockPath), true);
      throw constructorError;
    }
  }), error => error === constructorError);

  assert.equal(fs.existsSync(lockPath), false);
});

test('dashboard startup failure closes the dashboard and releases the adopted lock', async t => {
  const root = makeRoot(t);
  const config = makeConfig(root, { enableDashboard: true });
  const lockPath = writerLockPath(config);
  const journalLockPath = journalWriterLockPath(config);
  const events = [];
  const startupError = new Error('fake dashboard start failure');
  let dashboardStore;

  await assert.rejects(runLegacyMultiCoinRuntime(config, {
    createTrader: () => {
      assert.equal(fs.existsSync(lockPath), true);
      return makeFakeTrader(config, events);
    },
    createDashboard: (trader, port, options) => {
      dashboardStore = options.manualOrderIdempotencyStore;
      return {
        start: async () => {
          await dashboardStore.initialize();
          assert.equal(fs.existsSync(lockPath), true);
          throw startupError;
        },
        stop: async () => {
          events.push('dashboard-stop');
          dashboardStore.releaseWriterLock();
        }
      };
    },
    waitBeforeTraderStart: async () => {}
  }), error => error === startupError);

  assert.deepEqual(events, ['dashboard-stop']);
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.existsSync(journalLockPath), false);
});

test('legacy trader-start failure stops safely and releases the headless lock', async t => {
  const root = makeRoot(t);
  const config = makeConfig(root);
  const lockPath = writerLockPath(config);
  const journalLockPath = journalWriterLockPath(config);
  const events = [];
  const exit = exitHandlerOptions(events);
  const startError = new Error('fake trader start failure');

  await runLegacyMultiCoinRuntime(config, {
    createTrader: () => makeFakeTrader(config, events, {
      start: async () => {
        assert.equal(fs.existsSync(lockPath), true);
        throw startError;
      }
    }),
    waitBeforeTraderStart: async () => {},
    exitHandlerOptions: exit
  });

  assert.deepEqual(events, ['trader-start', 'trader-stop', 'exit:1']);
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.existsSync(journalLockPath), false);
});

test('headless SIGTERM shutdown keeps the lock through trader stop and then releases it', async t => {
  const root = makeRoot(t);
  const config = makeConfig(root);
  const lockPath = writerLockPath(config);
  const journalLockPath = journalWriterLockPath(config);
  const events = [];
  const exit = exitHandlerOptions(events);
  const sharedMarketDataSource = { id: 'headless-public-market-source' };
  let traderMarketDataSource;

  await runLegacyMultiCoinRuntime(config, {
    createPublicMarketDataSource: () => sharedMarketDataSource,
    createTrader: marketDataSource => {
      traderMarketDataSource = marketDataSource;
      return makeFakeTrader(config, events, {
        start: async () => {
          assert.equal(fs.existsSync(lockPath), true);
        }
      });
    },
    waitBeforeTraderStart: async () => {},
    exitHandlerOptions: exit
  });

  assert.equal(fs.existsSync(lockPath), true);
  assert.strictEqual(traderMarketDataSource, sharedMarketDataSource,
    'headless trading uses the public source even without a DashboardServer');
  assert.equal(fs.existsSync(journalLockPath), true);
  exit.processApi.emit('SIGTERM');
  assert.equal(await exit.exited, 0);
  assert.deepEqual(events, ['trader-start', 'trader-stop', 'exit:0']);
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.existsSync(journalLockPath), false);
});
