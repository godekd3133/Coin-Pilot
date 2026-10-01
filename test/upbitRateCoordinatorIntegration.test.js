import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import UpbitAPI from '../src/api/upbit.js';
import {
  UpbitRateCoordinatorClient,
  startUpbitRateCoordinatorServer
} from '../src/api/upbitRateCoordinator.js';
import { startConfiguredUpbitRateCoordinator } from '../src/scripts/runUpbitRateCoordinator.js';
import { UpbitRequestScheduler } from '../src/api/upbitRequestScheduler.js';

function createScheduler() {
  return new UpbitRequestScheduler({
    maxInFlight: 1,
    riskReserveSlots: 0,
    minRequestIntervalMs: 120
  });
}

test('public Upbit HTTP dispatch holds a shared lease and publishes Remaining-Req backoff', async t => {
  const stateDir = fs.mkdtempSync(path.join('/tmp', 'urc-int-'));
  const server = await startUpbitRateCoordinatorServer({
    stateDir,
    allowTemporaryStateDir: true
  });
  const coordinator = new UpbitRateCoordinatorClient({ socketPath: server.socketPath });
  t.after(async () => {
    await coordinator.close();
    await server.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  let inFlightAtDispatch = null;
  let dispatchCount = 0;
  const api = new UpbitAPI('', '', {
    scheduler: createScheduler(),
    rateCoordinator: coordinator,
    rateCoordinatorRequired: true,
    axios: {
      async get() {
        dispatchCount += 1;
        inFlightAtDispatch = (await coordinator.getStatus()).inFlightTotal;
        return {
          data: [{ market: 'KRW-BTC', trade_price: 100 }],
          headers: { 'Remaining-Req': 'group=ticker; sec=0' }
        };
      }
    }
  });

  const rows = await api.getTicker('KRW-BTC');
  const status = await coordinator.getStatus();

  assert.equal(dispatchCount, 1);
  assert.equal(inFlightAtDispatch, 1, 'the shared lease must be held when axios starts the request');
  assert.equal(status.inFlightTotal, 0, 'the request lease must be released after the response is observed');
  assert.ok(status.backoffRemainingMsByScopeAndGroup['ip:ticker'] > 0,
    'Remaining-Req sec=0 must update shared ticker-group backoff before release');
  assert.deepEqual(rows, [{ market: 'KRW-BTC', trade_price: 100 }]);
});

test('HTTP 429 records shared group backoff before releasing its dispatch lease', async t => {
  const stateDir = fs.mkdtempSync(path.join('/tmp', 'urc-429-'));
  const server = await startUpbitRateCoordinatorServer({
    stateDir,
    allowTemporaryStateDir: true
  });
  const coordinator = new UpbitRateCoordinatorClient({ socketPath: server.socketPath });
  t.after(async () => {
    await coordinator.close();
    await server.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const sequence = [];
  const originalAcquireTurn = coordinator.acquireTurn.bind(coordinator);
  coordinator.acquireTurn = async options => {
    sequence.push('acquire');
    const lease = await originalAcquireTurn(options);
    const originalRelease = lease.release.bind(lease);
    lease.release = async () => {
      sequence.push('release');
      return originalRelease();
    };
    return lease;
  };
  const originalApplyBackoff = coordinator.applyBackoff.bind(coordinator);
  coordinator.applyBackoff = async (delayMs, options) => {
    sequence.push('backoff');
    return originalApplyBackoff(delayMs, options);
  };
  const api = new UpbitAPI('', '', {
    scheduler: createScheduler(),
    rateCoordinator: coordinator,
    rateCoordinatorRequired: true,
    random: () => 0,
    axios: {
      async get() {
        sequence.push('dispatch');
        const error = new Error('rate limited');
        error.response = {
          status: 429,
          headers: { 'Remaining-Req': 'group=ticker; sec=0', 'Retry-After': '0' }
        };
        throw error;
      }
    }
  });

  await assert.rejects(api.getTicker('KRW-BTC', { deadlineAt: Date.now() + 1_000 }), error =>
    ['UPBIT_QUEUE_TIMEOUT', 'UPBIT_REQUEST_DEADLINE'].includes(error.code));

  const backoffIndex = sequence.indexOf('backoff');
  const releaseIndex = sequence.indexOf('release');
  assert.ok(sequence.indexOf('dispatch') >= 0);
  assert.ok(backoffIndex >= 0 && releaseIndex > backoffIndex,
    `expected group backoff before lease release, got ${sequence.join(' → ')}`);
  const coordinatorStatus = await coordinator.getStatus();
  assert.ok(coordinatorStatus.backoffRemainingMsByScopeAndGroup['ip:ticker'] > 0);
  assert.equal(coordinatorStatus.inFlightTotal, 0);
});

test('HTTP 418 publishes IP-wide cooldown before releasing its dispatch lease', async t => {
  const stateDir = fs.mkdtempSync(path.join('/tmp', 'urc-418-'));
  const server = await startUpbitRateCoordinatorServer({
    stateDir,
    allowTemporaryStateDir: true
  });
  const coordinator = new UpbitRateCoordinatorClient({ socketPath: server.socketPath });
  t.after(async () => {
    await coordinator.close();
    await server.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const sequence = [];
  const originalAcquireTurn = coordinator.acquireTurn.bind(coordinator);
  coordinator.acquireTurn = async options => {
    const lease = await originalAcquireTurn(options);
    const originalRelease = lease.release.bind(lease);
    lease.release = async () => {
      sequence.push('release');
      return originalRelease();
    };
    return lease;
  };
  const originalApplyBackoff = coordinator.applyBackoff.bind(coordinator);
  coordinator.applyBackoff = async (delayMs, options) => {
    sequence.push('backoff');
    return originalApplyBackoff(delayMs, options);
  };
  const api = new UpbitAPI('', '', {
    scheduler: createScheduler(),
    rateCoordinator: coordinator,
    rateCoordinatorRequired: true,
    axios: {
      async get() {
        sequence.push('dispatch');
        const error = new Error('temporarily blocked');
        error.response = {
          status: 418,
          headers: { 'Retry-After': '30' }
        };
        throw error;
      }
    }
  });

  await assert.rejects(api.getTicker('KRW-BTC'), error => error.response?.status === 418);

  const backoffIndex = sequence.indexOf('backoff');
  const releaseIndex = sequence.indexOf('release');
  assert.ok(sequence.indexOf('dispatch') >= 0);
  assert.ok(backoffIndex >= 0 && releaseIndex > backoffIndex,
    `expected IP-wide cooldown before lease release, got ${sequence.join(' → ')}`);
  const status = await coordinator.getStatus();
  assert.ok(status.backoffRemainingMsByScopeAndGroup['ip:*'] > 25_000);
  assert.equal(status.inFlightTotal, 0);
});

test('required coordinator failure blocks public HTTP before dispatch', async t => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'urc-down-'));
  const coordinator = new UpbitRateCoordinatorClient({
    socketPath: path.join(stateDir, 'coordinator.sock'),
    connectionTimeoutMs: 100
  });
  t.after(async () => {
    await coordinator.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  let dispatched = false;
  const api = new UpbitAPI('', '', {
    scheduler: createScheduler(),
    rateCoordinator: coordinator,
    rateCoordinatorRequired: true,
    axios: {
      async get() {
        dispatched = true;
        return { data: [], headers: {} };
      }
    }
  });

  await assert.rejects(api.getTicker('KRW-BTC'), {
    code: 'UPBIT_RATE_COORDINATOR_UNAVAILABLE'
  });
  assert.equal(dispatched, false);
  const status = await api.getRateCoordinatorStatus();
  assert.equal(status.required, true);
  assert.equal(status.available, false);
});

test('required host-wide coordination rejects profile-only state paths', () => {
  const previous = {
    required: process.env.UPBIT_RATE_COORDINATOR_REQUIRED,
    stateDir: process.env.UPBIT_RATE_COORDINATOR_STATE_DIR,
    profileDir: process.env.COINPILOT_STATE_DIR
  };
  try {
    process.env.UPBIT_RATE_COORDINATOR_REQUIRED = 'true';
    delete process.env.UPBIT_RATE_COORDINATOR_STATE_DIR;
    process.env.COINPILOT_STATE_DIR = '/var/lib/coinpilot-live';

    assert.throws(() => new UpbitAPI('', ''), {
      code: 'UPBIT_RATE_COORDINATOR_STATE_ROOT_REQUIRED'
    });
  } finally {
    if (previous.required === undefined) delete process.env.UPBIT_RATE_COORDINATOR_REQUIRED;
    else process.env.UPBIT_RATE_COORDINATOR_REQUIRED = previous.required;
    if (previous.stateDir === undefined) delete process.env.UPBIT_RATE_COORDINATOR_STATE_DIR;
    else process.env.UPBIT_RATE_COORDINATOR_STATE_DIR = previous.stateDir;
    if (previous.profileDir === undefined) delete process.env.COINPILOT_STATE_DIR;
    else process.env.COINPILOT_STATE_DIR = previous.profileDir;
  }
});

test('required coordinator daemon rejects a profile-only state path', async () => {
  await assert.rejects(startConfiguredUpbitRateCoordinator({
    env: {
      UPBIT_RATE_COORDINATOR_REQUIRED: 'true',
      COINPILOT_STATE_DIR: '/var/lib/coinpilot-live'
    }
  }), {
    code: 'UPBIT_RATE_COORDINATOR_STATE_ROOT_REQUIRED'
  });
});
