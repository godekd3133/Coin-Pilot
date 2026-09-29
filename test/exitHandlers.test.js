import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { setupExitHandlers } from '../src/runtime/exitHandlers.js';

function makeHarness({ livePositions = 0, pendingOrder = false, exchangeStateKnown = true, syncFailure = false } = {}) {
  const processApi = new EventEmitter();
  processApi.exitCode = 0;
  const calls = [];
  const exitCodes = [];
  let positions = livePositions;
  let releaseDrain = null;
  let orderPending = pendingOrder;
  let releaseOrder = null;
  const trader = {
    dryRun: false,
    strategies: new Map(),
    async requestGracefulShutdown(reason) {
      calls.push(['requestGracefulShutdown', reason]);
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
      return positions > 0;
    },
    stop(reason) { calls.push(['stop', reason]); }
  };
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
  const consoleApi = {
    log(...args) { calls.push(['consoleLog', ...args]); },
    error(...args) { calls.push(['consoleError', ...args]); }
  };
  const handlers = setupExitHandlers(trader, dashboardServer, null, null, logger, {
    processApi,
    consoleApi,
    exitProcess(code) { calls.push(['exit', code]); exitCodes.push(code); },
    async finalizeActivePaperValidation() { calls.push(['finalizePaper']); return null; }
  });
  return {
    processApi,
    trader,
    calls,
    exitCodes,
    handlers,
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
  assert.equal(harness.calls.some(([name, message]) => name === 'consoleError' && String(message).includes('프로세스를 종료하지 않고')), true);
});
