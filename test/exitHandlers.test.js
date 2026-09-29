import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { setupExitHandlers } from '../src/runtime/exitHandlers.js';

function makeHarness({
  livePositions = 0,
  pendingOrder = false,
  exchangeStateKnown = true,
  syncFailure = false,
  writerLockStore = null,
  finalizeFailure = false,
  missingMethods = []
} = {}) {
  const processApi = new EventEmitter();
  processApi.exitCode = 0;
  const calls = [];
  const exitCodes = [];
  let positions = livePositions;
  let entriesLocked = false;
  let releaseDrain = null;
  let orderPending = pendingOrder;
  let releaseOrder = null;
  const trader = {
    dryRun: false,
    strategies: new Map(),
    async requestGracefulShutdown(reason) {
      calls.push(['requestGracefulShutdown', reason]);
      entriesLocked = true;
      if (syncFailure) throw new Error('exchange state unavailable');
      if (orderPending) {
        await new Promise(resolve => {
          releaseOrder = () => {
            orderPending = false;
            positions += 1;
            resolve();
          };
        });
      }
      if (positions === 0) this.stop(reason);
      return positions > 0;
    },
    getRuntimeSafetyStatus() {
      return { protectiveMonitorActive: positions > 0, exchangeStateKnown };
    },
    getCurrentPositionCount() { return positions; },
    waitForProtectiveDrain() {
      calls.push(['waitForProtectiveDrain']);
      return new Promise(resolve => {
        releaseDrain = () => {
          positions = 0;
          resolve(true);
        };
      });
    },
    pauseForSafetyIncident(reason) {
      calls.push(['pauseForSafetyIncident', reason]);
      entriesLocked = true;
      return positions > 0;
    },
    stop(reason) { calls.push(['stop', reason]); }
  };
  for (const method of missingMethods) delete trader[method];
  const dashboardServer = {
    stop() {
      calls.push(['dashboardStopStarted']);
      return new Promise(resolve => setImmediate(() => {
        calls.push(['dashboardStopped']);
        resolve();
      }));
    }
  };
  const logger = {
    error(...args) { calls.push(['loggerError', ...args]); },
    async flush() { calls.push(['loggerFlush']); }
  };
  const backtestTimer = { name: 'backtest' };
  const optimizationTimer = { name: 'optimization' };
  const consoleApi = {
    log(...args) { calls.push(['consoleLog', ...args]); },
    error(...args) { calls.push(['consoleError', ...args]); }
  };
  const handlers = setupExitHandlers(trader, dashboardServer, backtestTimer, optimizationTimer, logger, {
    processApi,
    consoleApi,
    runtimeWriterLockStore: writerLockStore,
    clearInterval(timer) { calls.push(['clearInterval', timer.name]); },
    exitProcess(code) { calls.push(['exit', code]); exitCodes.push(code); },
    async finalizeActivePaperValidation() {
      calls.push(['finalizePaper']);
      if (finalizeFailure) throw new Error('fake finalization failure');
      return null;
    }
  });
  return {
    processApi,
    trader,
    calls,
    exitCodes,
    handlers,
    areEntriesLocked: () => entriesLocked,
    releaseDrain: () => releaseDrain?.(),
    releaseOrder: () => releaseOrder?.()
  };
}

test('SIGTERM drains managed LIVE positions before closing the dashboard and exiting', async () => {
  const harness = makeHarness({ livePositions: 1 });
  harness.processApi.emit('SIGTERM');
  await new Promise(resolve => setImmediate(resolve));

  const shutdown = harness.handlers.gracefulShutdown();
  harness.processApi.emit('SIGINT');
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(harness.exitCodes, []);
  assert.equal(harness.calls.filter(([name]) => name === 'requestGracefulShutdown').length, 1);
  assert.equal(harness.calls.filter(([name]) => name === 'waitForProtectiveDrain').length, 1);

  harness.releaseDrain();
  await shutdown;

  assert.deepEqual(harness.exitCodes, [0]);
  assert.equal(harness.calls.some(([name, reason]) => name === 'stop' && reason === 'operator_shutdown'), true);
  assert.equal(harness.calls.findIndex(([name]) => name === 'dashboardStopStarted') > harness.calls.findIndex(([name]) => name === 'finalizePaper'), true);
  assert.equal(harness.calls.findIndex(([name]) => name === 'dashboardStopped') < harness.calls.findIndex(([name]) => name === 'loggerFlush'), true);
  assert.equal(harness.calls.at(-1)[0], 'exit');
  assert.equal(harness.calls.findIndex(([name]) => name === 'loggerFlush') < harness.calls.findIndex(([name]) => name === 'exit'), true);
});

test('uncaught exception during protective LIVE drain preserves the drain and promotes the exit code', async () => {
  const harness = makeHarness({ livePositions: 1 });
  harness.processApi.emit('SIGTERM');
  await new Promise(resolve => setImmediate(resolve));

  const fatalShutdown = harness.handlers.handleUncaughtException(new Error('fatal during graceful drain'));

  assert.equal(harness.processApi.exitCode, 1);
  assert.deepEqual(harness.exitCodes, []);
  assert.equal(harness.calls.filter(([name]) => name === 'requestGracefulShutdown').length, 1);
  assert.equal(harness.calls.filter(([name]) => name === 'waitForProtectiveDrain').length, 1);

  harness.releaseDrain();
  await fatalShutdown;

  assert.deepEqual(harness.exitCodes, [1]);
  assert.equal(harness.calls.some(([name, reason]) => name === 'stop' && reason === 'operator_shutdown'), true);
  assert.equal(harness.calls.some(([name, reason]) => name === 'stop' && reason === 'uncaught_exception'), false);
});

test('registered uncaughtException waits for an in-flight LIVE order before draining and exiting', async () => {
  let harness;
  const writerLockStore = {
    releaseWriterLock() { harness.calls.push(['writerLockRelease']); }
  };
  harness = makeHarness({ livePositions: 0, pendingOrder: true, writerLockStore });

  assert.equal(
    harness.processApi.emit('uncaughtException', new Error('fatal during submitted LIVE order')),
    true
  );
  const fatalShutdown = harness.handlers.gracefulShutdown(1, { reason: 'uncaught_exception' });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(harness.areEntriesLocked(), true);
  assert.equal(harness.calls.filter(([name]) => name === 'requestGracefulShutdown').length, 1);
  assert.deepEqual(harness.exitCodes, []);
  assert.equal(harness.calls.some(([name]) => name === 'dashboardStopStarted'), false);
  assert.equal(harness.calls.some(([name]) => name === 'writerLockRelease'), false);

  harness.releaseOrder();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(harness.calls.filter(([name]) => name === 'waitForProtectiveDrain').length, 1);
  assert.deepEqual(harness.exitCodes, []);
  assert.equal(harness.calls.some(([name]) => name === 'dashboardStopStarted'), false);
  assert.equal(harness.calls.some(([name]) => name === 'writerLockRelease'), false);

  harness.releaseDrain();
  await fatalShutdown;

  assert.deepEqual(harness.exitCodes, [1]);
  assert.equal(harness.calls.some(([name, reason]) => name === 'stop' && reason === 'uncaught_exception'), true);
  const drainIndex = harness.calls.findIndex(([name]) => name === 'waitForProtectiveDrain');
  const stopIndex = harness.calls.findIndex(([name, reason]) => name === 'stop' && reason === 'uncaught_exception');
  const dashboardStopIndex = harness.calls.findIndex(([name]) => name === 'dashboardStopStarted');
  const writerLockReleaseIndex = harness.calls.findIndex(([name]) => name === 'writerLockRelease');
  const exitIndex = harness.calls.findIndex(([name]) => name === 'exit');
  assert.equal(stopIndex > drainIndex, true);
  assert.equal(dashboardStopIndex > stopIndex, true);
  assert.equal(writerLockReleaseIndex > dashboardStopIndex, true);
  assert.equal(exitIndex > writerLockReleaseIndex, true);
});

test('uncaught exception with open LIVE position keeps the writer lock until protective drain then exits with code 1', async () => {
  let harness;
  const writerLockStore = {
    releaseWriterLock() { harness.calls.push(['writerLockRelease']); }
  };
  harness = makeHarness({ livePositions: 1, writerLockStore });

  const fatalShutdown = harness.handlers.handleUncaughtException(new Error('fatal with open LIVE position'));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(harness.areEntriesLocked(), true);
  assert.equal(harness.calls.some(([name, reason]) => name === 'requestGracefulShutdown' && reason === 'uncaught_exception'), true);
  assert.equal(harness.calls.filter(([name]) => name === 'waitForProtectiveDrain').length, 1);
  assert.equal(harness.calls.some(([name]) => name === 'stop'), false);
  assert.equal(harness.calls.some(([name]) => name === 'writerLockRelease'), false);
  assert.deepEqual(harness.exitCodes, []);

  harness.releaseDrain();
  await fatalShutdown;

  assert.deepEqual(harness.exitCodes, [1]);
  assert.equal(harness.calls.some(([name, reason]) => name === 'stop' && reason === 'uncaught_exception'), true);
  const safeStopIndex = harness.calls.findIndex(([name, reason]) => name === 'stop' && reason === 'uncaught_exception');
  const writerLockReleaseIndex = harness.calls.findIndex(([name]) => name === 'writerLockRelease');
  const processExitIndex = harness.calls.findIndex(([name]) => name === 'exit');
  const paperFinalizeIndex = harness.calls.findIndex(([name]) => name === 'finalizePaper');
  const dashboardStopIndex = harness.calls.findIndex(([name]) => name === 'dashboardStopped');
  const loggerFlushIndex = harness.calls.findIndex(([name]) => name === 'loggerFlush');
  const timerCleanupIndexes = harness.calls
    .map(([name], index) => name === 'clearInterval' ? index : -1)
    .filter(index => index >= 0);
  assert.equal(safeStopIndex >= 0, true);
  assert.equal(writerLockReleaseIndex > safeStopIndex, true);
  assert.equal(writerLockReleaseIndex > paperFinalizeIndex, true);
  assert.equal(writerLockReleaseIndex > dashboardStopIndex, true);
  assert.equal(timerCleanupIndexes.every(index => writerLockReleaseIndex > index), true);
  assert.equal(writerLockReleaseIndex > loggerFlushIndex, true);
  assert.equal(processExitIndex > writerLockReleaseIndex, true);
});

test('writer lock stays owned when shutdown persistence cleanup fails', async () => {
  let harness;
  const writerLockStore = {
    releaseWriterLock() { harness.calls.push(['writerLockRelease']); }
  };
  harness = makeHarness({ writerLockStore, finalizeFailure: true });

  await harness.handlers.gracefulShutdown();

  assert.deepEqual(harness.exitCodes, [1]);
  assert.equal(harness.calls.some(([name]) => name === 'finalizePaper'), true);
  assert.equal(harness.calls.some(([name]) => name === 'loggerFlush'), true);
  assert.equal(harness.calls.some(([name]) => name === 'writerLockRelease'), false);
  assert.equal(harness.calls.at(-1)[0], 'exit');
});

test('LIVE shutdown keeps the process and writer lock when protective interfaces are missing', async t => {
  for (const missingMethod of [
    'requestGracefulShutdown',
    'getCurrentPositionCount',
    'getRuntimeSafetyStatus',
    'waitForProtectiveDrain'
  ]) {
    await t.test(missingMethod, async () => {
      let harness;
      const writerLockStore = {
        releaseWriterLock() { harness.calls.push(['writerLockRelease']); }
      };
      harness = makeHarness({
        livePositions: 1,
        writerLockStore,
        missingMethods: [missingMethod]
      });

      const result = await harness.handlers.gracefulShutdown();

      assert.equal(result, false);
      assert.equal(harness.processApi.exitCode, 1);
      assert.equal(harness.areEntriesLocked(), true);
      assert.deepEqual(harness.exitCodes, []);
      assert.equal(harness.calls.some(([name]) => name === 'stop'), false);
      assert.equal(harness.calls.some(([name]) => name === 'finalizePaper'), false);
      assert.equal(harness.calls.some(([name]) => name === 'dashboardStopStarted'), false);
      assert.equal(harness.calls.some(([name]) => name === 'writerLockRelease'), false);
    });
  }
});

test('LIVE shutdown keeps the process and writer lock when shutdown reconciliation fails while locally flat', async () => {
  let harness;
  const writerLockStore = {
    releaseWriterLock() { harness.calls.push(['writerLockRelease']); }
  };
  harness = makeHarness({
    livePositions: 0,
    exchangeStateKnown: true,
    syncFailure: true,
    writerLockStore
  });

  const result = await harness.handlers.gracefulShutdown(1, { reason: 'startup_failure' });

  assert.equal(result, false);
  assert.equal(harness.processApi.exitCode, 1);
  assert.deepEqual(harness.exitCodes, []);
  assert.equal(harness.calls.some(([name]) => name === 'stop'), false);
  assert.equal(harness.calls.some(([name]) => name === 'finalizePaper'), false);
  assert.equal(harness.calls.some(([name]) => name === 'writerLockRelease'), false);
});

test('uncaught exception exits with a failing code after cleanup and logger flush', async () => {
  const harness = makeHarness();
  await harness.handlers.handleUncaughtException(new Error('fatal test error'));

  assert.deepEqual(harness.exitCodes, [1]);
  assert.equal(harness.calls.some(([name, reason]) => name === 'stop' && reason === 'uncaught_exception'), true);
  assert.equal(harness.calls.at(-1)[0], 'exit');
  assert.equal(harness.calls.findIndex(([name]) => name === 'loggerFlush') < harness.calls.findIndex(([name]) => name === 'exit'), true);
});

test('unhandled rejection preserves position monitoring then exits as a failure when flat', async () => {
  const harness = makeHarness({ livePositions: 1 });
  const cleanup = harness.handlers.handleUnhandledRejection(new Error('rejected test promise'));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(harness.calls.some(([name, reason]) => name === 'requestGracefulShutdown' && reason === 'unhandled_rejection'), true);
  assert.equal(harness.processApi.exitCode, 1);
  assert.deepEqual(harness.exitCodes, []);

  harness.releaseDrain();
  await cleanup;

  assert.deepEqual(harness.exitCodes, [1]);
  assert.equal(harness.calls.some(([name, reason]) => name === 'stop' && reason === 'unhandled_rejection'), true);
});

test('unhandled rejection waits for an in-flight BUY before deciding whether to drain LIVE positions', async () => {
  const harness = makeHarness({ pendingOrder: true });
  const cleanup = harness.handlers.handleUnhandledRejection(new Error('rejected during BUY'));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(harness.calls.some(([name, reason]) => name === 'requestGracefulShutdown' && reason === 'unhandled_rejection'), true);
  assert.deepEqual(harness.exitCodes, []);
  assert.equal(harness.calls.some(([name]) => name === 'stop'), false);

  harness.releaseOrder();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.calls.filter(([name]) => name === 'waitForProtectiveDrain').length, 1);
  assert.deepEqual(harness.exitCodes, []);

  harness.releaseDrain();
  await cleanup;

  assert.deepEqual(harness.exitCodes, [1]);
  assert.equal(harness.calls.some(([name, reason]) => name === 'stop' && reason === 'unhandled_rejection'), true);
});

test('shutdown does not exit LIVE while exchange state remains unknown', async () => {
  const harness = makeHarness({ exchangeStateKnown: false, syncFailure: true });

  const result = await harness.handlers.gracefulShutdown(1, { reason: 'startup_failure' });

  assert.equal(result, false);
  assert.deepEqual(harness.exitCodes, []);
  assert.equal(harness.calls.some(([name]) => name === 'dashboardStopStarted'), false);
  assert.equal(harness.calls.some(([name]) => name === 'loggerFlush'), false);
  assert.equal(harness.calls.some(([name, message]) => name === 'consoleError' && String(message).includes('writer lock을 유지합니다')), true);
});

test('uncaught exception with unknown LIVE exchange state keeps entries locked and retains the writer lock', async () => {
  let harness;
  const writerLockStore = {
    releaseWriterLock() { harness.calls.push(['writerLockRelease']); }
  };
  harness = makeHarness({ exchangeStateKnown: false, syncFailure: true, writerLockStore });

  const result = await harness.handlers.handleUncaughtException(new Error('exchange state unavailable'));

  assert.equal(result, false);
  assert.equal(harness.processApi.exitCode, 1);
  assert.equal(harness.areEntriesLocked(), true);
  assert.deepEqual(harness.exitCodes, []);
  assert.equal(harness.calls.some(([name]) => name === 'dashboardStopStarted'), false);
  assert.equal(harness.calls.some(([name]) => name === 'loggerFlush'), false);
  assert.equal(harness.calls.some(([name]) => name === 'writerLockRelease'), false);
  assert.equal(harness.calls.some(([name, message]) => name === 'consoleError' && String(message).includes('writer lock을 유지합니다')), true);
});
