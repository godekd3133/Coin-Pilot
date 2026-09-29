import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ManualOrderIdempotencyStore } from '../src/api/manualOrderIdempotencyStore.js';
import { acquireHeadlessRuntimeWriterLock } from '../src/runtime/exitHandlers.js';
import {
  createProfileWriterStartup,
  resolveVirtualPortfolioFile
} from '../src/runtime/profileWriterStartup.js';

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-profile-writer-startup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeConfig(root) {
  return {
    dryRun: true,
    enableDashboard: false,
    virtualPortfolioFile: path.join(root, 'portfolio.json'),
    manualOrderIdempotencyFile: path.join(root, 'manual-order-idempotency.json')
  };
}

function makeFakeTrader(config) {
  return {
    config,
    dryRun: config.dryRun,
    virtualPortfolioFile: config.virtualPortfolioFile,
    persistManualOrderIdempotencyRecords() {}
  };
}

test('profile writer path resolution matches MultiCoinTrader precedence and test storage behavior', () => {
  assert.equal(
    resolveVirtualPortfolioFile({ virtualPortfolioFile: '/config/portfolio.json' }, {
      env: { DRY_PORTFOLIO_FILE: '/env/portfolio.json' }
    }),
    '/config/portfolio.json'
  );
  assert.equal(
    resolveVirtualPortfolioFile({}, { env: { DRY_PORTFOLIO_FILE: '/env/portfolio.json' } }),
    '/env/portfolio.json'
  );
  assert.equal(
    resolveVirtualPortfolioFile({}, { env: { NODE_ENV: 'production' } }),
    'dry_portfolio.json'
  );
  assert.equal(
    resolveVirtualPortfolioFile({}, {
      env: { NODE_ENV: 'test' },
      tempDir: '/fixture/tmp',
      pid: 123,
      now: () => 456,
      random: () => 1 - Number.EPSILON
    }),
    path.join('/fixture/tmp', 'coin-pilot-test-123-456-zzzzzz.dry_portfolio.json')
  );
  assert.equal(
    resolveVirtualPortfolioFile({}, {
      env: { NODE_TEST_CONTEXT: 'child-v8' },
      tempDir: '/fixture/tmp',
      pid: 123,
      now: () => 456,
      random: () => 1 - Number.EPSILON
    }),
    path.join('/fixture/tmp', 'coin-pilot-test-123-456-zzzzzz.dry_portfolio.json')
  );
});

test('writer lock exists before trader creation and the full store initializes with the same ownership', async t => {
  const root = makeRoot(t);
  const config = makeConfig(root);
  const startup = createProfileWriterStartup(config, { env: { NODE_ENV: 'production' } });
  const lockPath = `${path.resolve(config.virtualPortfolioFile)}.manual_order_writer.lock`;

  assert.equal(fs.existsSync(lockPath), true);
  const initialStat = fs.statSync(lockPath);
  const initialOwner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  let traderFactoryCalls = 0;
  const runtime = startup.createTraderAndStore(() => {
    traderFactoryCalls += 1;
    assert.equal(fs.existsSync(lockPath), true, 'the profile lock precedes constructor/hydration');
    return makeFakeTrader(config);
  });

  assert.equal(traderFactoryCalls, 1);
  assert.equal(runtime.trader.virtualPortfolioFile, config.virtualPortfolioFile);
  assert.equal(runtime.manualOrderIdempotencyStore.writerLock.lockId, initialOwner.lockId);
  assert.equal(runtime.manualOrderIdempotencyStore.writerLock.stat.dev, initialStat.dev);
  assert.equal(runtime.manualOrderIdempotencyStore.writerLock.stat.ino, initialStat.ino);

  const initializedStore = await acquireHeadlessRuntimeWriterLock({
    config,
    trader: runtime.trader,
    createStore: () => runtime.manualOrderIdempotencyStore
  });
  const initializedStat = fs.statSync(lockPath);
  const initializedOwner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(initializedStore, runtime.manualOrderIdempotencyStore);
  assert.equal(runtime.manualOrderIdempotencyStore.initialized, true);
  assert.equal(initializedOwner.lockId, initialOwner.lockId, 'initialization validates the adopted lock instead of replacing it');
  assert.equal(initializedStat.dev, initialStat.dev);
  assert.equal(initializedStat.ino, initialStat.ino);

  assert.equal(runtime.manualOrderIdempotencyStore.releaseWriterLock(), true);
  assert.equal(fs.existsSync(lockPath), false);
});

test('distinct portfolios cannot acquire concurrent owners for one shared idempotency journal', t => {
  const root = makeRoot(t);
  const sharedJournal = path.join(root, 'shared', 'journal.json');
  const firstConfig = {
    ...makeConfig(root),
    virtualPortfolioFile: path.join(root, 'portfolio-a.json'),
    manualOrderIdempotencyFile: sharedJournal
  };
  const secondConfig = {
    ...makeConfig(root),
    virtualPortfolioFile: path.join(root, 'portfolio-b.json'),
    manualOrderIdempotencyFile: sharedJournal
  };
  const first = createProfileWriterStartup(firstConfig, { env: { NODE_ENV: 'production' } });
  const firstProfileLock = `${path.resolve(firstConfig.virtualPortfolioFile)}.manual_order_writer.lock`;

  assert.equal(fs.existsSync(firstProfileLock), true);
  assert.equal(fs.existsSync(first.journalLockPath), true);
  assert.throws(
    () => createProfileWriterStartup(secondConfig, { env: { NODE_ENV: 'production' } }),
    error => error.code === 'MANUAL_ORDER_WRITER_LOCK_ACTIVE' && error.writerLockPath === first.journalLockPath
  );
  assert.equal(fs.existsSync(`${path.resolve(secondConfig.virtualPortfolioFile)}.manual_order_writer.lock`), false,
    'failed journal ownership must release the newly acquired profile lock');
  assert.equal(fs.existsSync(firstProfileLock), true, 'the existing profile owner remains intact');

  assert.equal(first.releaseWriterLock(), true);
  const second = createProfileWriterStartup(secondConfig, { env: { NODE_ENV: 'production' } });
  assert.equal(fs.existsSync(second.journalLockPath), true);
  assert.equal(second.releaseWriterLock(), true);
});

test('a trader constructor failure releases the pre-hydration profile lock', t => {
  const root = makeRoot(t);
  const config = makeConfig(root);
  const startup = createProfileWriterStartup(config, { env: { NODE_ENV: 'production' } });
  const lockPath = `${path.resolve(config.virtualPortfolioFile)}.manual_order_writer.lock`;
  const constructorError = new Error('fake trader constructor failure');

  assert.equal(fs.existsSync(lockPath), true);
  assert.throws(() => startup.createTraderAndStore(() => {
    assert.equal(fs.existsSync(lockPath), true, 'the lock remains held throughout construction');
    throw constructorError;
  }), error => error === constructorError);
  assert.equal(fs.existsSync(lockPath), false);
});

test('lock adoption refuses to double-own when the destination already has a lock', t => {
  const root = makeRoot(t);
  const destination = new ManualOrderIdempotencyStore({
    filePath: path.join(root, 'destination-journal.json')
  });
  const source = new ManualOrderIdempotencyStore({
    filePath: path.join(root, 'source-journal.json')
  });
  destination.acquireWriterLock();
  source.acquireWriterLock();

  const destinationLockId = destination.writerLock.lockId;
  const sourceLockId = source.writerLock.lockId;
  assert.throws(() => destination.adoptWriterLockFrom(source));
  assert.equal(destination.writerLock.lockId, destinationLockId);
  assert.equal(source.writerLock.lockId, sourceLockId);
  assert.equal(destination.verifyWriterLock(), true);
  assert.equal(source.verifyWriterLock(), true);

  assert.equal(destination.releaseWriterLock(), true);
  assert.equal(source.releaseWriterLock(), true);
});
