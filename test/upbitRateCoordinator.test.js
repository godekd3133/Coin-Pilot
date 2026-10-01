import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  UpbitRateCoordinatorClient,
  resolveUpbitRateCoordinatorPaths,
  startUpbitRateCoordinatorServer
} from '../src/api/upbitRateCoordinator.js';

function createStateRoot(t) {
  const tempRoot = fs.mkdtempSync(path.join('/tmp', 'cp-rate-'));
  const stateDir = path.join(tempRoot, 'state');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  return stateDir;
}

function lineReader(stream) {
  stream.setEncoding('utf8');
  let buffer = '';
  const queued = [];
  const waiters = [];
  let closedError = null;

  const flush = () => {
    while (queued.length > 0 && waiters.length > 0) waiters.shift().resolve(queued.shift());
    if (closedError) while (waiters.length > 0) waiters.shift().reject(closedError);
  };
  stream.on('data', chunk => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) queued.push(JSON.parse(line));
    }
    flush();
  });
  stream.on('error', error => {
    closedError = error;
    flush();
  });
  return {
    next(timeoutMs = 3000) {
      if (queued.length > 0) return Promise.resolve(queued.shift());
      if (closedError) return Promise.reject(closedError);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex(waiter => waiter.resolve === wrappedResolve);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('Timed out waiting for child process output.'));
        }, timeoutMs);
        const wrappedResolve = value => {
          clearTimeout(timer);
          resolve(value);
        };
        waiters.push({ resolve: wrappedResolve, reject: error => { clearTimeout(timer); reject(error); } });
      });
    },
    drain() { return queued.splice(0); }
  };
}

function spawnClient(stateDir, options = {}) {
  const script = `
    import { UpbitRateCoordinatorClient, resolveUpbitRateCoordinatorPaths } from './src/api/upbitRateCoordinator.js';
    const paths = resolveUpbitRateCoordinatorPaths(process.env.TEST_STATE_DIR, { allowTemporaryStateDir: true });
    const client = new UpbitRateCoordinatorClient({ socketPath: paths.socketPath });
    const controller = new AbortController();
    let lease = null;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', async chunk => {
      const command = chunk.trim();
      if (command === 'abort') controller.abort();
      if (command === 'release' && lease) {
        await lease.release();
        process.stdout.write(JSON.stringify({ event: 'released' }) + '\\n');
        await client.close();
        process.exit(0);
      }
    });
    process.stdin.resume();
    const priority = process.env.TEST_PRIORITY || 'normal';
    const request = {
      scope: process.env.TEST_SCOPE || 'ip',
      group: process.env.TEST_GROUP || 'ticker',
      priority,
      priorityOrder: Number(process.env.TEST_PRIORITY_ORDER || 0),
      queueWaitTimeoutMs: Number(process.env.TEST_QUEUE_WAIT_MS || 3000),
      minRequestIntervalMs: Number(process.env.TEST_INTERVAL_MS || 120),
      signal: process.env.TEST_ABORTABLE === '1' ? controller.signal : undefined
    };
    if (process.env.TEST_DEADLINE_AT) request.deadlineAt = Number(process.env.TEST_DEADLINE_AT);
    try {
      lease = await client.acquireTurn(request);
      process.stdout.write(JSON.stringify({ event: 'acquired', leaseId: lease.leaseId, startedAt: lease.startedAt }) + '\\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ event: 'error', code: error.code || null }) + '\\n');
      await client.close();
      process.exitCode = 2;
    }
    if (!lease) process.stdin.pause();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TEST_STATE_DIR: stateDir,
      TEST_PRIORITY: options.priority || 'normal',
      TEST_PRIORITY_ORDER: String(options.priorityOrder ?? 0),
      TEST_GROUP: options.group || 'ticker',
      TEST_SCOPE: options.scope || 'ip',
      TEST_QUEUE_WAIT_MS: String(options.queueWaitTimeoutMs ?? 3000),
      TEST_INTERVAL_MS: String(options.minRequestIntervalMs ?? 120),
      TEST_ABORTABLE: options.abortable ? '1' : '0',
      ...(options.deadlineAt ? { TEST_DEADLINE_AT: String(options.deadlineAt) } : {})
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const output = lineReader(child.stdout);
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  return { child, output, getStderr: () => stderr };
}

async function waitForStatus(server, predicate, timeoutMs = 3000, children = []) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = server.getStatus();
    if (predicate(status)) return status;
    const exited = children.find(({ child }) => child.exitCode !== null || child.signalCode !== null);
    if (exited) {
      throw new Error(
        `Child exited before coordinator state changed (exit=${exited.child.exitCode}, signal=${exited.child.signalCode}, ` +
        `stdout=${JSON.stringify(exited.output.drain())}, stderr=${exited.getStderr()}).`
      );
    }
    await delay(10);
  }
  const childDetails = children.map(({ child, output, getStderr }) => ({
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    stdout: output.drain(),
    stderr: getStderr()
  }));
  throw new Error(`Coordinator status condition timed out: ${JSON.stringify(server.getStatus())}; children=${JSON.stringify(childDetails)}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise(resolve => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 1000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function startDaemonChild(stateDir) {
  const script = `
    import { resolveUpbitRateCoordinatorPaths, startUpbitRateCoordinatorServer } from './src/api/upbitRateCoordinator.js';
    const paths = resolveUpbitRateCoordinatorPaths(process.env.TEST_STATE_DIR, { allowTemporaryStateDir: true });
    await startUpbitRateCoordinatorServer({ stateDir: process.env.TEST_STATE_DIR, allowTemporaryStateDir: true });
    process.stdout.write(JSON.stringify({ event: 'ready', socketPath: paths.socketPath }) + '\\n');
    process.stdin.resume();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, TEST_STATE_DIR: stateDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const output = lineReader(child.stdout);
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  return { child, output, getStderr: () => stderr };
}

function writeOwnerFixture(filePath, { pid = 2_147_483_647, processIdentity = 'fixture:dead-process' } = {}) {
  fs.writeFileSync(filePath, JSON.stringify({
    schema: 'coinpilot.upbit-rate-coordinator-owner.v1',
    pid,
    hostname: os.hostname(),
    processIdentity,
    lockId: `fixture-${path.basename(filePath)}`,
    startedAt: Date.now()
  }), { mode: 0o600 });
}

function startRecoveryStaller(stateDir) {
  const script = `
    import { startUpbitRateCoordinatorServer } from './src/api/upbitRateCoordinator.js';
    await startUpbitRateCoordinatorServer({
      stateDir: process.env.TEST_STATE_DIR,
      allowTemporaryStateDir: true,
      onRecoveryMarkerCreated(markerPath) {
        process.stdout.write(JSON.stringify({ event: 'recovery-marker-created', markerPath }) + '\\n');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test', TEST_STATE_DIR: stateDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const output = lineReader(child.stdout);
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  return { child, output, getStderr: () => stderr };
}

test('separate processes share dispatch spacing and risk priority over an earlier queued normal ticket', async t => {
  const stateDir = createStateRoot(t);
  const server = await startUpbitRateCoordinatorServer({
    stateDir,
    allowTemporaryStateDir: true,
    maxInFlight: 1,
    riskReserveSlots: 0
  });
  const holderClient = new UpbitRateCoordinatorClient({ socketPath: server.socketPath });
  const holder = await holderClient.acquireTurn({ group: 'market', priority: 'normal' });
  t.after(async () => {
    await holder.release();
    await holderClient.close();
    await server.close();
  });
  const normal = spawnClient(stateDir, { priority: 'normal' });
  t.after(() => stopChild(normal.child));
  await waitForStatus(server, status => status.queued.normal === 1, 3000, [normal]);
  const risk = spawnClient(stateDir, { priority: 'risk' });
  t.after(() => stopChild(risk.child));
  await waitForStatus(server, status => status.queued.normal === 1 && status.queued.risk === 1, 3000, [normal, risk]);

  await holder.release();
  const riskGrant = await risk.output.next();
  assert.equal(riskGrant.event, 'acquired');
  assert.ok(riskGrant.startedAt - holder.startedAt >= 120);
  assert.equal(server.getStatus().queued.normal, 1);

  risk.child.stdin.write('release\n');
  assert.equal((await risk.output.next()).event, 'released');
  const normalGrant = await normal.output.next();
  assert.equal(normalGrant.event, 'acquired', JSON.stringify(normalGrant));
  assert.ok(normalGrant.startedAt - riskGrant.startedAt >= 120);

  normal.child.stdin.write('release\n');
  assert.equal((await normal.output.next()).event, 'released');
  await holderClient.close();
});

test('cross-process normal waiters retain FIFO order', async t => {
  const stateDir = createStateRoot(t);
  const server = await startUpbitRateCoordinatorServer({
    stateDir,
    allowTemporaryStateDir: true,
    maxInFlight: 1,
    riskReserveSlots: 0
  });
  const holderClient = new UpbitRateCoordinatorClient({ socketPath: server.socketPath });
  const holder = await holderClient.acquireTurn({ group: 'ticker' });
  t.after(async () => {
    await holder.release();
    await holderClient.close();
    await server.close();
  });
  const first = spawnClient(stateDir, { group: 'ticker' });
  t.after(() => stopChild(first.child));
  await waitForStatus(server, status => status.queued.normal === 1, 3000, [first]);
  const second = spawnClient(stateDir, { group: 'candle' });
  t.after(() => stopChild(second.child));
  await waitForStatus(server, status => status.queued.normal === 2, 3000, [first, second]);

  await holder.release();
  assert.equal((await first.output.next()).event, 'acquired');
  assert.equal(server.getStatus().queued.normal, 1);
  first.child.stdin.write('release\n');
  assert.equal((await first.output.next()).event, 'released');
  assert.equal((await second.output.next()).event, 'acquired');
  second.child.stdin.write('release\n');
  assert.equal((await second.output.next()).event, 'released');
  await holderClient.close();
});

test('host-wide queue caps reject overflow before dispatch', async t => {
  const stateDir = createStateRoot(t);
  const server = await startUpbitRateCoordinatorServer({
    stateDir,
    allowTemporaryStateDir: true,
    maxInFlight: 1,
    riskReserveSlots: 0,
    maxQueuedNormal: 1
  });
  const holderClient = new UpbitRateCoordinatorClient({ socketPath: server.socketPath });
  const holder = await holderClient.acquireTurn({ group: 'market' });
  t.after(async () => {
    await holder.release();
    await holderClient.close();
    await server.close();
  });
  const queued = spawnClient(stateDir, { group: 'ticker' });
  t.after(() => stopChild(queued.child));
  await waitForStatus(server, status => status.queued.normal === 1, 3000, [queued]);
  const overflow = spawnClient(stateDir, { group: 'candle' });
  t.after(() => stopChild(overflow.child));
  assert.deepEqual(await overflow.output.next(), { event: 'error', code: 'UPBIT_QUEUE_FULL' });
  assert.equal(server.getStatus().queued.normal, 1);

  await holder.release();
  assert.equal((await queued.output.next()).event, 'acquired');
  queued.child.stdin.write('release\n');
  assert.equal((await queued.output.next()).event, 'released');
});

test('abort, absolute deadline, and client disconnect remove waiting tickets without late grants', async t => {
  const stateDir = createStateRoot(t);
  const server = await startUpbitRateCoordinatorServer({
    stateDir,
    allowTemporaryStateDir: true,
    maxInFlight: 1,
    riskReserveSlots: 0
  });
  const holderClient = new UpbitRateCoordinatorClient({ socketPath: server.socketPath });
  const holder = await holderClient.acquireTurn({ group: 'market' });
  t.after(async () => {
    await holder.release();
    await holderClient.close();
    await server.close();
  });

  const aborted = spawnClient(stateDir, { abortable: true });
  t.after(() => stopChild(aborted.child));
  await waitForStatus(server, status => status.queued.normal === 1, 3000, [aborted]);
  aborted.child.stdin.write('abort\n');
  const abortResult = await aborted.output.next();
  assert.deepEqual(abortResult, { event: 'error', code: 'UPBIT_REQUEST_ABORTED' });
  await waitForStatus(server, status => status.queued.normal === 0);

  const expired = spawnClient(stateDir, { deadlineAt: Date.now() + 400, queueWaitTimeoutMs: 2000 });
  t.after(() => stopChild(expired.child));
  await waitForStatus(server, status => status.queued.normal === 1, 3000, [expired]);
  const deadlineResult = await expired.output.next();
  assert.deepEqual(deadlineResult, { event: 'error', code: 'UPBIT_REQUEST_DEADLINE' });
  assert.equal(server.getStatus().queued.normal, 0);

  const disconnected = spawnClient(stateDir, {});
  await waitForStatus(server, status => status.queued.normal === 1, 3000, [disconnected]);
  disconnected.child.kill('SIGKILL');
  await waitForStatus(server, status => status.queued.normal === 0);
  await holder.release();
  await holderClient.close();
});

test('group and IP-wide backoffs survive daemon restart; Remaining-Req stays group-scoped', async t => {
  const stateDir = createStateRoot(t);
  let server = await startUpbitRateCoordinatorServer({ stateDir, allowTemporaryStateDir: true });
  const client = new UpbitRateCoordinatorClient({ socketPath: server.socketPath });
  const dispatchLease = await client.acquireTurn({ group: 'market', minRequestIntervalMs: 10_000 });
  await dispatchLease.release();
  await client.applyBackoff(20_000, { scope: 'ip', group: 'candle' });
  const scopeWideUntil = await client.applyBackoff(30_000, { scope: 'ip', scopeWide: true });
  await client.observeRemaining('ticker', 0);
  assert.ok(scopeWideUntil >= Date.now() + 29_000);
  const paths = server.paths;
  await client.close();
  await server.close();

  server = await startUpbitRateCoordinatorServer({ stateDir, allowTemporaryStateDir: true });
  t.after(() => server.close());
  const restarted = new UpbitRateCoordinatorClient({ socketPath: paths.socketPath });
  const status = await restarted.getStatus();
  assert.ok(status.nextStartInMs > 9_000);
  assert.ok(status.backoffRemainingMsByScopeAndGroup['ip:candle'] > 0);
  assert.ok(status.backoffRemainingMsByScopeAndGroup['ip:*'] > 0);
  assert.ok(status.backoffRemainingMsByScopeAndGroup['ip:ticker'] > 0);
  await restarted.close();
});

test('dispatch and Remaining-Req cooldowns use monotonic time across wall-clock jumps', async t => {
  const stateDir = createStateRoot(t);
  let wallNow = Date.now();
  const server = await startUpbitRateCoordinatorServer({
    stateDir,
    allowTemporaryStateDir: true,
    now: () => wallNow
  });
  const client = new UpbitRateCoordinatorClient({ socketPath: server.socketPath });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  await client.observeRemaining('ticker', 0);
  const beforeJump = server.getStatus().backoffRemainingMsByScopeAndGroup['ip:ticker'];
  assert.ok(beforeJump > 900 && beforeJump <= 1000);
  wallNow += 120_000;
  await delay(30);
  const afterJump = server.getStatus().backoffRemainingMsByScopeAndGroup['ip:ticker'];
  assert.ok(afterJump > 850 && afterJump <= beforeJump);

  const queued = spawnClient(stateDir, { group: 'ticker', queueWaitTimeoutMs: 2500 });
  t.after(() => stopChild(queued.child));
  await waitForStatus(server, status => status.queued.normal === 1, 1000, [queued]);
  await delay(100);
  const blocked = server.getStatus();
  assert.equal(blocked.queued.normal, 1);
  assert.equal(blocked.inFlightTotal, 0);
  assert.ok(blocked.backoffRemainingMsByScopeAndGroup['ip:ticker'] > 0);
});

test('an OS boot identity change restarts the full bounded cooldown and exposes it in status', async t => {
  const stateDir = createStateRoot(t);
  let server = await startUpbitRateCoordinatorServer({
    stateDir,
    allowTemporaryStateDir: true,
    bootIdentity: 'test-boot-before'
  });
  const client = new UpbitRateCoordinatorClient({ socketPath: server.socketPath });
  await client.applyBackoff(5000, { scope: 'ip', group: 'candle' });
  await client.close();
  await server.close();

  server = await startUpbitRateCoordinatorServer({
    stateDir,
    allowTemporaryStateDir: true,
    bootIdentity: 'test-boot-after',
    now: () => Date.now() + 365 * 24 * 60 * 60 * 1000
  });
  const restarted = new UpbitRateCoordinatorClient({ socketPath: server.socketPath });
  t.after(async () => {
    await restarted.close();
    await server.close();
  });
  const status = await restarted.getStatus();
  assert.equal(status.clockRecovery.mode, 'os-boot-conservative-full-cooldown');
  assert.equal(status.clockRecovery.conservativeCooldownMs, 24 * 60 * 60 * 1000);
  assert.ok(status.nextStartInMs > 24 * 60 * 60 * 1000 - 1000);
  assert.ok(status.backoffRemainingMsByScopeAndGroup['ip:*'] > 24 * 60 * 60 * 1000 - 1000);
});

test('an OS boot identity change with no persisted backoff uses only the minimum dispatch interval', async t => {
  const stateDir = createStateRoot(t);
  let server = await startUpbitRateCoordinatorServer({
    stateDir,
    allowTemporaryStateDir: true,
    bootIdentity: 'test-boot-before-no-backoff'
  });
  const client = new UpbitRateCoordinatorClient({ socketPath: server.socketPath });
  const lease = await client.acquireTurn({ group: 'ticker' });
  await lease.release();
  assert.deepEqual(JSON.parse(fs.readFileSync(server.stateFilePath, 'utf8')).backoffUntilByGroup, {});
  await client.close();
  await server.close();

  server = await startUpbitRateCoordinatorServer({
    stateDir,
    allowTemporaryStateDir: true,
    bootIdentity: 'test-boot-after-no-backoff',
    now: () => Date.now() + 365 * 24 * 60 * 60 * 1000
  });
  const restarted = new UpbitRateCoordinatorClient({ socketPath: server.socketPath });
  t.after(async () => {
    await restarted.close();
    await server.close();
  });
  const status = await restarted.getStatus();
  assert.equal(status.clockRecovery.mode, 'os-boot-minimum-dispatch-interval');
  assert.equal(status.clockRecovery.conservativeCooldownMs, 120);
  assert.ok(status.nextStartInMs > 0 && status.nextStartInMs <= 120);
  assert.deepEqual(status.backoffRemainingMsByScopeAndGroup, {});
});

test('quota groups and persisted cooldown state are bounded; excessive backoff persistently blocks dispatch', async t => {
  const stateDir = createStateRoot(t);
  let server = await startUpbitRateCoordinatorServer({ stateDir, allowTemporaryStateDir: true });
  let client = new UpbitRateCoordinatorClient({ socketPath: server.socketPath });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  for (const group of ['market', 'candle', 'ticker', 'orderbook']) {
    await client.applyBackoff(1500, { scope: 'ip', group });
  }
  await client.applyBackoff(1500, { scope: 'ip', scopeWide: true });
  for (const invalidGroup of ['all', 'default', 'order', 'too-many-characters-for-upbit']) {
    await assert.rejects(
      client.observeRemaining(invalidGroup, 0),
      error => error.code === 'UPBIT_RATE_COORDINATOR_INVALID_GROUP'
    );
  }
  for (const queueWaitTimeoutMs of [24 * 60 * 60 * 1000 + 1, 1e308]) {
    await assert.rejects(
      client.acquireTurn({ group: 'ticker', queueWaitTimeoutMs }),
      error => error.code === 'UPBIT_RATE_COORDINATOR_INVALID_REQUEST'
    );
  }
  await assert.rejects(
    client.applyBackoff(Number.POSITIVE_INFINITY, { scope: 'ip', scopeWide: true }),
    error => error.code === 'UPBIT_RATE_COORDINATOR_INVALID_BACKOFF'
  );
  await assert.rejects(
    client.applyBackoff(-1, { scope: 'ip', group: 'ticker' }),
    error => error.code === 'UPBIT_RATE_COORDINATOR_INVALID_BACKOFF'
  );
  const paths = server.paths;
  const persisted = JSON.parse(fs.readFileSync(paths.stateFilePath, 'utf8'));
  assert.equal(Object.keys(persisted.backoffUntilByGroup).length, 5);
  assert.ok(fs.statSync(paths.stateFilePath).size <= 4096);

  await assert.rejects(
    client.applyBackoff(24 * 60 * 60 * 1000 + 1, { scope: 'ip', scopeWide: true }),
    error => error.code === 'UPBIT_RATE_COORDINATOR_BACKOFF_DELAY_EXCEEDS_MAX'
  );
  const blocked = await client.getStatus();
  assert.equal(blocked.available, false);
  assert.equal(blocked.requiresManualRecovery, true);
  assert.equal(blocked.failureCode, 'UPBIT_RATE_COORDINATOR_BACKOFF_DELAY_EXCEEDS_MAX');
  assert.equal(JSON.parse(fs.readFileSync(paths.stateFilePath, 'utf8')).manualRecoveryRequired,
    'UPBIT_RATE_COORDINATOR_BACKOFF_DELAY_EXCEEDS_MAX');
  await client.close();
  await server.close();

  server = await startUpbitRateCoordinatorServer({ stateDir, allowTemporaryStateDir: true });
  client = new UpbitRateCoordinatorClient({ socketPath: server.socketPath });
  const recoveredStatus = await client.getStatus();
  assert.equal(recoveredStatus.available, false);
  assert.equal(recoveredStatus.requiresManualRecovery, true);
  assert.equal(recoveredStatus.failureCode, 'UPBIT_RATE_COORDINATOR_BACKOFF_DELAY_EXCEEDS_MAX');
});

test('pump prunes and persists expired backoffs even when no request is queued', async t => {
  const stateDir = createStateRoot(t);
  const server = await startUpbitRateCoordinatorServer({ stateDir, allowTemporaryStateDir: true });
  const client = new UpbitRateCoordinatorClient({ socketPath: server.socketPath });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  await client.applyBackoff(400, { scope: 'ip', group: 'ticker' });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(server.stateFilePath, 'utf8')).backoffUntilByGroup), ['ticker']);
  await delay(600);
  const persisted = JSON.parse(fs.readFileSync(server.stateFilePath, 'utf8'));
  assert.deepEqual(persisted.backoffUntilByGroup, {});
  assert.deepEqual(persisted.backoffMonoNsByGroup, {});
  assert.equal(server.getStatus().backoffRemainingMsByScopeAndGroup['ip:ticker'], undefined);
});

test('same-boot restart prunes elapsed backoffs before the next boot boundary is classified', async t => {
  const stateDir = createStateRoot(t);
  let server = await startUpbitRateCoordinatorServer({
    stateDir,
    allowTemporaryStateDir: true,
    bootIdentity: 'test-boot-before-expired-backoff'
  });
  let client = new UpbitRateCoordinatorClient({ socketPath: server.socketPath });
  await client.applyBackoff(180, { scope: 'ip', group: 'ticker' });
  await client.close();
  await server.close();
  await delay(240);

  server = await startUpbitRateCoordinatorServer({
    stateDir,
    allowTemporaryStateDir: true,
    bootIdentity: 'test-boot-before-expired-backoff'
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(server.stateFilePath, 'utf8')).backoffUntilByGroup, {});
  await server.close();

  server = await startUpbitRateCoordinatorServer({
    stateDir,
    allowTemporaryStateDir: true,
    bootIdentity: 'test-boot-after-expired-backoff'
  });
  client = new UpbitRateCoordinatorClient({ socketPath: server.socketPath });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const status = await client.getStatus();
  assert.equal(status.clockRecovery.mode, 'os-boot-minimum-dispatch-interval');
  assert.equal(status.clockRecovery.conservativeCooldownMs, 120);
  assert.deepEqual(status.backoffRemainingMsByScopeAndGroup, {});
});

test('state and socket are owner-only; corrupt state and ambiguous socket paths fail closed without unlink', async t => {
  const stateDir = createStateRoot(t);
  const paths = resolveUpbitRateCoordinatorPaths(stateDir, { allowTemporaryStateDir: true });
  const server = await startUpbitRateCoordinatorServer({ stateDir, allowTemporaryStateDir: true });
  const client = new UpbitRateCoordinatorClient({ socketPath: server.socketPath });
  const lease = await client.acquireTurn({ group: 'ticker' });
  await lease.release();
  const stateStat = fs.statSync(paths.stateFilePath);
  const directoryStat = fs.statSync(paths.directory);
  const socketStat = fs.statSync(paths.socketPath);
  assert.equal(directoryStat.mode & 0o777, 0o700);
  assert.equal(stateStat.mode & 0o777, 0o600);
  assert.equal(socketStat.mode & 0o777, 0o600);
  await client.close();
  await server.close();

  fs.writeFileSync(paths.stateFilePath, '{broken json', { mode: 0o600 });
  await assert.rejects(
    startUpbitRateCoordinatorServer({ stateDir, allowTemporaryStateDir: true }),
    error => error.code === 'UPBIT_RATE_COORDINATOR_STATE_CORRUPT'
  );
  fs.rmSync(paths.stateFilePath);

  const invalidGroupState = {
    schema: 'coinpilot.upbit-rate-coordinator-state.v2',
    version: 2,
    bootIdentity: 'fixture-boot',
    nextDispatchAt: 0,
    nextDispatchMonoNs: '0',
    backoffUntilByGroup: { order: 1 },
    backoffMonoNsByGroup: { order: '1' },
    manualRecoveryRequired: null
  };
  fs.writeFileSync(paths.stateFilePath, JSON.stringify(invalidGroupState), { mode: 0o600 });
  await assert.rejects(
    startUpbitRateCoordinatorServer({ stateDir, allowTemporaryStateDir: true }),
    error => error.code === 'UPBIT_RATE_COORDINATOR_STATE_CORRUPT'
  );
  fs.writeFileSync(paths.stateFilePath, 'x'.repeat(4097), { mode: 0o600 });
  await assert.rejects(
    startUpbitRateCoordinatorServer({ stateDir, allowTemporaryStateDir: true }),
    error => error.code === 'UPBIT_RATE_COORDINATOR_STATE_TOO_LARGE'
  );
  fs.rmSync(paths.stateFilePath);

  const legacyState = {
    schema: 'coinpilot.upbit-rate-coordinator-state.v1',
    version: 1,
    nextDispatchAt: Date.now() + 60_000,
    backoffUntilByGroup: { ticker: Date.now() + 60_000 }
  };
  const legacyStateJson = JSON.stringify(legacyState);
  fs.writeFileSync(paths.stateFilePath, legacyStateJson, { mode: 0o600 });
  const legacyServer = await startUpbitRateCoordinatorServer({ stateDir, allowTemporaryStateDir: true });
  const legacyClient = new UpbitRateCoordinatorClient({ socketPath: legacyServer.socketPath });
  const legacyStatus = await legacyClient.getStatus();
  assert.equal(legacyStatus.available, false);
  assert.equal(legacyStatus.requiresManualRecovery, true);
  assert.equal(legacyStatus.failureCode, 'UPBIT_RATE_COORDINATOR_LEGACY_STATE_REQUIRES_REVIEW');
  assert.match(fs.readFileSync(paths.stateFilePath, 'utf8'), /upbit-rate-coordinator-state\.v1/);
  await legacyClient.close();
  await legacyServer.close();
  fs.rmSync(paths.stateFilePath);

  fs.writeFileSync(paths.ownerLockPath, '{ambiguous owner', { mode: 0o600 });
  await assert.rejects(
    startUpbitRateCoordinatorServer({ stateDir, allowTemporaryStateDir: true }),
    error => error.code === 'UPBIT_RATE_COORDINATOR_LOCK_AMBIGUOUS'
  );
  assert.equal(fs.readFileSync(paths.ownerLockPath, 'utf8'), '{ambiguous owner');
  fs.rmSync(paths.ownerLockPath);

  fs.writeFileSync(paths.socketPath, 'leave this path alone', { mode: 0o600 });
  await assert.rejects(
    startUpbitRateCoordinatorServer({ stateDir, allowTemporaryStateDir: true }),
    error => error.code === 'UPBIT_RATE_COORDINATOR_SOCKET_AMBIGUOUS'
  );
  assert.equal(fs.readFileSync(paths.socketPath, 'utf8'), 'leave this path alone');
});

test('dead daemon lock and owned stale Unix socket are identity-checked before recovery', async t => {
  const stateDir = createStateRoot(t);
  const daemon = startDaemonChild(stateDir);
  t.after(() => stopChild(daemon.child));
  const ready = await daemon.output.next();
  assert.equal(ready.event, 'ready');
  const paths = resolveUpbitRateCoordinatorPaths(stateDir, { allowTemporaryStateDir: true });
  assert.equal(fs.lstatSync(paths.socketPath).isSocket(), true);

  const client = new UpbitRateCoordinatorClient({ socketPath: paths.socketPath });
  await client.applyBackoff(15_000, { scope: 'ip', group: 'ticker' });
  await client.close();
  daemon.child.kill('SIGKILL');
  await new Promise(resolve => daemon.child.once('exit', resolve));
  assert.equal(fs.existsSync(paths.socketPath), true);

  const recovered = await startUpbitRateCoordinatorServer({ stateDir, allowTemporaryStateDir: true });
  t.after(() => recovered.close());
  assert.equal(recovered.getStatus().backoffRemainingMsByScopeAndGroup['ip:ticker'] > 0, true);
  assert.equal(fs.lstatSync(paths.socketPath).isSocket(), true);
});

test('a live reused PID is stale only when its recorded process-start identity differs', async t => {
  const stateDir = createStateRoot(t);
  const paths = resolveUpbitRateCoordinatorPaths(stateDir, { allowTemporaryStateDir: true });
  fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  writeOwnerFixture(paths.ownerLockPath, {
    pid: process.pid,
    processIdentity: 'fixture:previous-process-with-reused-pid'
  });

  const server = await startUpbitRateCoordinatorServer({ stateDir, allowTemporaryStateDir: true });
  t.after(() => server.close());
  assert.equal(server.getStatus().available, true);
  const newOwner = JSON.parse(fs.readFileSync(paths.ownerLockPath, 'utf8'));
  assert.equal(newOwner.pid, process.pid);
  assert.notEqual(newOwner.processIdentity, 'fixture:previous-process-with-reused-pid');
});

test('SIGKILL during stale-lock recovery leaves a marker that the next owner can safely reclaim', async t => {
  const stateDir = createStateRoot(t);
  const paths = resolveUpbitRateCoordinatorPaths(stateDir, { allowTemporaryStateDir: true });
  fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  writeOwnerFixture(paths.ownerLockPath);

  const staller = startRecoveryStaller(stateDir);
  const markerCreated = await staller.output.next();
  assert.equal(markerCreated.event, 'recovery-marker-created');
  const recoveryPath = `${paths.ownerLockPath}.recovery`;
  assert.equal(markerCreated.markerPath, recoveryPath);
  assert.equal(fs.existsSync(recoveryPath), true);
  staller.child.kill('SIGKILL');
  await new Promise(resolve => staller.child.once('exit', resolve));
  const deadMarker = fs.readFileSync(recoveryPath, 'utf8');
  assert.equal(JSON.parse(deadMarker).pid, staller.child.pid);

  const recovered = await startUpbitRateCoordinatorServer({ stateDir, allowTemporaryStateDir: true });
  t.after(() => recovered.close());
  assert.equal(recovered.getStatus().available, true);
  assert.equal(fs.existsSync(recoveryPath), false);
  assert.equal(fs.lstatSync(paths.socketPath).isSocket(), true);
});

test('a recovery marker owned by a verified live process fails closed with an explicit recovery status', async t => {
  const stateDir = createStateRoot(t);
  const paths = resolveUpbitRateCoordinatorPaths(stateDir, { allowTemporaryStateDir: true });
  const seed = await startUpbitRateCoordinatorServer({ stateDir, allowTemporaryStateDir: true });
  const liveOwner = JSON.parse(fs.readFileSync(paths.ownerLockPath, 'utf8'));
  await seed.close();

  writeOwnerFixture(paths.ownerLockPath);
  fs.writeFileSync(`${paths.ownerLockPath}.recovery`, JSON.stringify(liveOwner), { mode: 0o600 });
  await assert.rejects(
    startUpbitRateCoordinatorServer({ stateDir, allowTemporaryStateDir: true }),
    error => error.code === 'UPBIT_RATE_COORDINATOR_LOCK_RECOVERY_REQUIRED' &&
      error.recoveryMarkerState === 'active' &&
      error.recoveryPath === `${paths.ownerLockPath}.recovery` &&
      error.message.includes('Stop the coordinator service')
  );
  assert.equal(JSON.parse(fs.readFileSync(`${paths.ownerLockPath}.recovery`, 'utf8')).lockId, liveOwner.lockId);
});

test('pocket scope is rejected and temporary production state roots are not accepted', async t => {
  const stateDir = createStateRoot(t);
  const server = await startUpbitRateCoordinatorServer({ stateDir, allowTemporaryStateDir: true });
  t.after(() => server.close());
  const client = new UpbitRateCoordinatorClient({ socketPath: server.socketPath });
  await assert.rejects(
    client.acquireTurn({ scope: 'pocket', group: 'default' }),
    error => error.code === 'UPBIT_RATE_COORDINATOR_SCOPE_UNSUPPORTED'
  );
  await assert.rejects(
    client.applyBackoff(1000, { scope: 'pocket', group: 'default' }),
    error => error.code === 'UPBIT_RATE_COORDINATOR_SCOPE_UNSUPPORTED'
  );
  assert.throws(
    () => resolveUpbitRateCoordinatorPaths(stateDir),
    error => error.code === 'UPBIT_RATE_COORDINATOR_TEMP_STATE_FORBIDDEN'
  );
  await client.close();
});
