import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { acquireHeadlessRuntimeWriterLock, setupExitHandlers } from '../src/runtime/exitHandlers.js';

function createFakeStore(events, { initializeError = null } = {}) {
  return {
    initialize: async () => {
      events.push('initialize');
      if (initializeError) throw initializeError;
    },
    releaseWriterLock: () => {
      events.push('release');
      return true;
    }
  };
}

function createExitHandlerHarness(trader, runtimeWriterLockStore) {
  const events = [];
  const processApi = new EventEmitter();
  processApi.exitCode = 0;
  const consoleApi = { log() {}, error() {} };
  const exitHandlers = setupExitHandlers(trader, null, null, null, null, {
    processApi,
    consoleApi,
    exitProcess: code => events.push(`exit:${code}`),
    finalizeActivePaperValidation: async () => null,
    runtimeWriterLockStore
  });
  return { events, exitHandlers, processApi };
}

test('mutable headless runtimes acquire the profile lock while dashboard and observer runtimes skip it', async () => {
  const events = [];
  const store = createFakeStore(events);
  const trader = { readOnlyObserver: false };
  let factoryCalls = 0;
  const createStore = () => {
    factoryCalls += 1;
    return store;
  };

  const acquired = await acquireHeadlessRuntimeWriterLock({
    config: { enableDashboard: false },
    trader,
    createStore
  });
  assert.equal(acquired, store);
  assert.deepEqual(events, ['initialize']);
  assert.equal(factoryCalls, 1);

  assert.equal(await acquireHeadlessRuntimeWriterLock({
    config: { enableDashboard: true },
    trader,
    createStore
  }), null);
  assert.equal(await acquireHeadlessRuntimeWriterLock({
    config: { enableDashboard: false },
    trader: { readOnlyObserver: true },
    createStore
  }), null);
  assert.equal(factoryCalls, 1);
});

test('writer-lock contention fails startup closed and releases a partially initialized store', async () => {
  const events = [];
  const contention = Object.assign(new Error('profile is already owned'), {
    code: 'MANUAL_ORDER_WRITER_LOCK_ACTIVE'
  });
  const trader = { start: async () => { events.push('start'); } };

  await assert.rejects(async () => {
    const lockStore = await acquireHeadlessRuntimeWriterLock({
      config: { enableDashboard: false },
      trader,
      createStore: () => createFakeStore(events, { initializeError: contention })
    });
    await trader.start();
    return lockStore;
  }, error => error === contention);

  assert.deepEqual(events, ['initialize', 'release']);
  assert.equal(events.includes('start'), false);
});

test('writer lock remains held through protective drain and releases once after trader stop', async () => {
  const events = [];
  let openPositions = 1;
  const lockStore = createFakeStore(events);
  const trader = {
    dryRun: false,
    strategies: new Map(),
    requestGracefulShutdown: async () => {
      events.push('request-stop');
      return true;
    },
    getCurrentPositionCount: () => openPositions,
    getRuntimeSafetyStatus: () => ({ protectiveMonitorActive: true, exchangeStateKnown: true }),
    waitForProtectiveDrain: async () => {
      assert.equal(events.includes('release'), false);
      events.push('protective-drain');
      openPositions = 0;
      return true;
    },
    stop: () => events.push('trader-stop')
  };
  const { exitHandlers } = createExitHandlerHarness(trader, lockStore);

  const firstShutdown = exitHandlers.gracefulShutdown();
  const concurrentShutdown = exitHandlers.gracefulShutdown();
  assert.equal(concurrentShutdown, firstShutdown);
  await firstShutdown;
  await exitHandlers.gracefulShutdown();

  assert.deepEqual(events, ['request-stop', 'protective-drain', 'trader-stop', 'release']);
});

test('writer lock stays held when a LIVE shutdown cannot prove safe stop', async () => {
  const events = [];
  const lockStore = createFakeStore(events);
  const trader = {
    dryRun: false,
    strategies: new Map(),
    requestGracefulShutdown: async () => { throw new Error('exchange state unavailable'); },
    getCurrentPositionCount: () => 1,
    getRuntimeSafetyStatus: () => ({ exchangeStateKnown: false }),
    pauseForSafetyIncident: () => events.push('safety-pause'),
    stop: () => events.push('trader-stop')
  };
  const { exitHandlers } = createExitHandlerHarness(trader, lockStore);

  const stopped = await exitHandlers.gracefulShutdown();

  assert.equal(stopped, false);
  assert.deepEqual(events, ['safety-pause']);
});
