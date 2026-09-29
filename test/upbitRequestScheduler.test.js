import test from 'node:test';
import assert from 'node:assert/strict';
import { UpbitRequestScheduler } from '../src/api/upbitRequestScheduler.js';
import UpbitAPI from '../src/api/upbit.js';

class FakeClock {
  constructor() {
    this.nowMs = 0;
    this.nextTimerId = 1;
    this.timers = new Map();
    this.now = () => this.nowMs;
    this.setTimeout = (callback, delayMs) => {
      const id = this.nextTimerId++;
      this.timers.set(id, { id, at: this.nowMs + Math.max(0, delayMs), callback });
      return id;
    };
    this.clearTimeout = id => this.timers.delete(id);
  }

  async advanceBy(durationMs) {
    const target = this.nowMs + durationMs;
    while (true) {
      const timer = [...this.timers.values()]
        .filter(candidate => candidate.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!timer) break;
      this.nowMs = timer.at;
      this.timers.delete(timer.id);
      timer.callback();
      await flushMicrotasks();
    }
    this.nowMs = target;
    await flushMicrotasks();
  }
}

function createScheduler(clock, options = {}) {
  return new UpbitRequestScheduler({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    minRequestIntervalMs: 120,
    ...options
  });
}

async function flushMicrotasks() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function scheduleBlocked(scheduler, started, label, priority = 'normal', queueWaitTimeoutMs) {
  const gate = deferred();
  const options = { priority };
  if (queueWaitTimeoutMs !== undefined) options.queueWaitTimeoutMs = queueWaitTimeoutMs;
  const promise = scheduler.schedule(() => {
    started.push(label);
    return gate.promise;
  }, options);
  return { gate, promise };
}

test('scheduler keeps normal work dispatchable when configured with one in-flight slot', async () => {
  const clock = new FakeClock();
  const scheduler = createScheduler(clock, { maxInFlight: 1, riskReserveSlots: 1 });
  const started = [];

  await scheduler.schedule(() => started.push('normal'));

  assert.deepEqual(started, ['normal']);
  assert.equal(scheduler.getStatus().maxInFlightByPriority.normal, 1);
  assert.equal(scheduler.getStatus().maxInFlightByPriority.risk, 1);
});

test('scheduler reserves one of four in-flight permits for risk and orders risk before waiting normal work', async () => {
  const clock = new FakeClock();
  const scheduler = createScheduler(clock);
  const started = [];
  const normal = [0, 1, 2].map(index => scheduleBlocked(scheduler, started, `normal-${index}`));
  await flushMicrotasks();
  await clock.advanceBy(120);
  await clock.advanceBy(120);

  const waitingNormal = scheduleBlocked(scheduler, started, 'normal-3');
  const risk = scheduleBlocked(scheduler, started, 'risk', 'risk');
  await flushMicrotasks();
  assert.equal(scheduler.getStatus().inFlightTotal, 3);
  assert.equal(scheduler.getStatus().inFlight.normal, 3);

  await clock.advanceBy(120);
  assert.deepEqual(started, ['normal-0', 'normal-1', 'normal-2', 'risk']);
  assert.deepEqual(scheduler.getStatus().inFlight, { normal: 3, risk: 1 });
  assert.equal(scheduler.getStatus().queued.normal, 1);

  normal[0].gate.resolve('released');
  await flushMicrotasks();
  await clock.advanceBy(120);
  assert.deepEqual(started, ['normal-0', 'normal-1', 'normal-2', 'risk', 'normal-3']);
  assert.equal(scheduler.getStatus().inFlightTotal, 4);

  for (const item of [...normal.slice(1), waitingNormal, risk]) item.gate.resolve('done');
  await Promise.all([...normal.map(item => item.promise), waitingNormal.promise, risk.promise]);
  assert.equal(scheduler.getStatus().inFlightTotal, 0);
});

test('scheduler rejects full queues and reports queue wait age by priority', async () => {
  const clock = new FakeClock();
  const scheduler = createScheduler(clock, { maxQueuedNormal: 1, maxQueuedRisk: 1 });
  const started = [];
  const normal = [scheduleBlocked(scheduler, started, 'normal-0')];
  await flushMicrotasks();
  normal.push(scheduleBlocked(scheduler, started, 'normal-1'));
  await clock.advanceBy(120);
  normal.push(scheduleBlocked(scheduler, started, 'normal-2'));
  await clock.advanceBy(120);

  const queuedNormal = scheduler.schedule(() => started.push('queued-normal'), { priority: 'normal' });
  const queuedRisk = scheduler.schedule(() => started.push('queued-risk'), { priority: 'risk' });
  await flushMicrotasks();
  const status = scheduler.getStatus();
  assert.deepEqual(status.queued, { normal: 1, risk: 1 });
  assert.equal(status.oldestWaitAgeMs.normal, 0);
  assert.equal(status.oldestWaitAgeMs.risk, 0);
  await clock.advanceBy(40);
  assert.equal(scheduler.getStatus().oldestWaitAgeMs.normal, 40);

  await assert.rejects(
    scheduler.schedule(() => started.push('overflow-normal'), { priority: 'normal' }),
    error => error.code === 'UPBIT_QUEUE_FULL' && error.priority === 'normal'
  );
  await assert.rejects(
    scheduler.schedule(() => started.push('overflow-risk'), { priority: 'risk' }),
    error => error.code === 'UPBIT_QUEUE_FULL' && error.priority === 'risk'
  );

  for (const item of normal) item.gate.resolve('done');
  await clock.advanceBy(120);
  await flushMicrotasks();
  await clock.advanceBy(120);
  await flushMicrotasks();
  await clock.advanceBy(120);
  await Promise.all([...normal.map(item => item.promise), queuedNormal, queuedRisk]);
  assert.ok(!started.includes('overflow-normal'));
  assert.ok(!started.includes('overflow-risk'));
});

test('queued cancellation and queue deadline remove work before dispatch and prevent late sends', async () => {
  const clock = new FakeClock();
  const scheduler = createScheduler(clock);
  const started = [];
  const normal = [0, 1, 2].map(index => scheduleBlocked(scheduler, started, `normal-${index}`));
  await flushMicrotasks();
  await clock.advanceBy(120);
  await clock.advanceBy(120);

  const controller = new AbortController();
  const cancelled = scheduler.schedule(() => started.push('cancelled'), {
    priority: 'normal',
    signal: controller.signal
  });
  const timedOut = scheduler.schedule(() => started.push('timed-out'), {
    priority: 'normal',
    queueWaitTimeoutMs: 100
  });
  controller.abort();
  await assert.rejects(cancelled, error => error.code === 'UPBIT_REQUEST_ABORTED');
  assert.deepEqual(scheduler.getStatus().queued, { normal: 1, risk: 0 });

  await clock.advanceBy(60);
  assert.equal(scheduler.getStatus().oldestWaitAgeMs.normal, 60);
  await clock.advanceBy(40);
  await assert.rejects(timedOut, error => error.code === 'UPBIT_QUEUE_TIMEOUT');

  normal[0].gate.resolve('released');
  await flushMicrotasks();
  await clock.advanceBy(20);
  assert.deepEqual(started, ['normal-0', 'normal-1', 'normal-2']);
  for (const item of normal.slice(1)) item.gate.resolve('done');
  await Promise.all(normal.map(item => item.promise));
});

test('a request permit stays held until success or failure settles, then queued work can start', async () => {
  const clock = new FakeClock();
  const scheduler = createScheduler(clock);
  const started = [];
  const normal = [0, 1, 2].map(index => scheduleBlocked(scheduler, started, `normal-${index}`));
  await flushMicrotasks();
  await clock.advanceBy(120);
  await clock.advanceBy(120);
  const next = scheduleBlocked(scheduler, started, 'next-normal');
  await flushMicrotasks();

  assert.deepEqual(scheduler.getStatus().inFlight, { normal: 3, risk: 0 });
  assert.equal(scheduler.getStatus().queued.normal, 1);
  normal[0].gate.reject(new Error('simulated Axios failure'));
  await assert.rejects(normal[0].promise, /simulated Axios failure/);
  await flushMicrotasks();
  assert.deepEqual(scheduler.getStatus().inFlight, { normal: 2, risk: 0 });
  assert.equal(started.includes('next-normal'), false);

  await clock.advanceBy(120);
  assert.ok(started.includes('next-normal'));
  for (const item of [...normal.slice(1), next]) item.gate.resolve('done');
  await Promise.all([...normal.slice(1).map(item => item.promise), next.promise]);
});

test('an already-aborted signal is rejected without queueing or dispatching', async () => {
  const scheduler = createScheduler(new FakeClock());
  const controller = new AbortController();
  controller.abort();
  let dispatched = false;

  await assert.rejects(
    scheduler.schedule(() => { dispatched = true; }, { signal: controller.signal }),
    error => error.code === 'UPBIT_REQUEST_ABORTED'
  );
  assert.equal(dispatched, false);
  assert.equal(scheduler.getStatus().queuedTotal, 0);
});

test('fill polling deadline includes queue wait and Axios time, with no late final readback', async () => {
  const clock = new FakeClock();
  const scheduler = createScheduler(clock);
  const blocker = scheduleBlocked(scheduler, [], 'risk-blocker', 'risk');
  await flushMicrotasks();
  let axiosCalls = 0;
  let orderRequestConfig;
  const axiosResponse = deferred();
  const axiosDouble = {
    get: (_url, config) => {
      axiosCalls += 1;
      orderRequestConfig = config;
      clock.setTimeout(() => {
        const error = new Error('simulated Axios timeout at the fill deadline');
        error.code = 'ECONNABORTED';
        axiosResponse.reject(error);
      }, config.timeout);
      return axiosResponse.promise;
    }
  };
  const api = new UpbitAPI('mock-access', 'mock-secret', {
    scheduler,
    axios: axiosDouble,
    requestTimeoutMs: 10_000
  });
  const startedAt = clock.nowMs;
  const fillPromise = api.waitForOrderFill('mock-order', 200, 100);

  await flushMicrotasks();
  assert.equal(scheduler.getStatus().queued.risk, 1);
  await clock.advanceBy(120);
  assert.equal(axiosCalls, 1);
  assert.equal(orderRequestConfig.timeout, 80);
  assert.equal(scheduler.getStatus().inFlightTotal, 2);

  await clock.advanceBy(80);
  await assert.rejects(fillPromise, error =>
    error.code === 'UPBIT_FILL_DEADLINE' && error.unresolved === true && error.orderState === 'unknown'
  );
  assert.equal(clock.nowMs - startedAt, 200);
  assert.equal(axiosCalls, 1);

  blocker.gate.resolve('released');
  await flushMicrotasks();
  await clock.advanceBy(40);
  assert.equal(axiosCalls, 1);
  await blocker.promise;
});

test('a queued fill GET is removed at its deadline and never dispatches after capacity reopens', async () => {
  const clock = new FakeClock();
  const scheduler = createScheduler(clock);
  const started = [];
  const blockers = [0, 1, 2, 3].map(index =>
    scheduleBlocked(scheduler, started, `risk-${index}`, 'risk')
  );
  await flushMicrotasks();
  await clock.advanceBy(120);
  await clock.advanceBy(120);
  await clock.advanceBy(120);
  assert.equal(scheduler.getStatus().inFlightTotal, 4);

  let axiosCalls = 0;
  const axiosResponse = deferred();
  const api = new UpbitAPI('', '', {
    scheduler,
    axios: { get: () => { axiosCalls += 1; return axiosResponse.promise; } }
  });
  const fillPromise = api.waitForOrderFill('mock-order', 100, 20);
  await flushMicrotasks();
  assert.equal(scheduler.getStatus().queued.risk, 1);
  await clock.advanceBy(100);
  await assert.rejects(fillPromise, error => error.code === 'UPBIT_FILL_DEADLINE');
  assert.equal(axiosCalls, 0);

  blockers[0].gate.resolve('released');
  await flushMicrotasks();
  await clock.advanceBy(20);
  assert.equal(axiosCalls, 0);
  for (const blocker of blockers.slice(1)) blocker.gate.resolve('done');
  await Promise.all(blockers.map(blocker => blocker.promise));
});

test('HTTP 418 cooldown applies to every group in its quota scope, including risk', async () => {
  const clock = new FakeClock();
  const scheduler = createScheduler(clock);
  let attempts = 0;
  const axiosDouble = {
    get: async url => {
      if (url.endsWith('/market/all')) {
        attempts += 1;
        const error = new Error('temporarily blocked');
        error.response = {
          status: 418,
          headers: { 'retry-after': '3' },
          data: { error: { name: 'temporarily_blocked' } }
        };
        throw error;
      }
      return { data: [], headers: {} };
    }
  };
  const api = new UpbitAPI('', '', { scheduler, axios: axiosDouble, random: () => 0 });
  const originalError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(api.getMarkets(), error => error.response?.status === 418);
  } finally {
    console.error = originalError;
  }

  assert.equal(attempts, 1);
  assert.equal(scheduler.getStatus().backoffRemainingMsByScopeAndGroup['ip:*'], 3000);
  const starts = [];
  const blockedRisk = scheduler.schedule(() => starts.push('ip-risk'), {
    priority: 'risk', rateLimitGroup: 'ticker', rateLimitScope: 'ip'
  });
  const blockedNormal = scheduler.schedule(() => starts.push('ip-normal'), {
    priority: 'normal', rateLimitGroup: 'candle', rateLimitScope: 'ip'
  });
  const independentPocket = scheduler.schedule(() => starts.push('pocket-normal'), {
    priority: 'normal', rateLimitGroup: 'default', rateLimitScope: 'pocket'
  });

  await clock.advanceBy(120);
  assert.deepEqual(starts, ['pocket-normal']);
  await clock.advanceBy(2880);
  assert.deepEqual(starts, ['pocket-normal', 'ip-risk']);
  await clock.advanceBy(120);
  assert.deepEqual(starts, ['pocket-normal', 'ip-risk', 'ip-normal']);
  await Promise.all([blockedRisk, blockedNormal, independentPocket]);
});

test('Remaining-Req sec=0 delays only the named group until the next second boundary', async () => {
  const clock = new FakeClock();
  const scheduler = createScheduler(clock);
  const starts = [];
  const axiosDouble = {
    get: async url => {
      starts.push({ url, at: clock.nowMs });
      return {
        data: [],
        headers: url.includes('/candles/')
          ? { 'remaining-req': 'group=candle; min=0; sec=0' }
          : { 'remaining-req': 'group=ticker; min=0; sec=9' }
      };
    }
  };
  const api = new UpbitAPI('', '', { scheduler, axios: axiosDouble });

  await api.getMinuteCandles('KRW-BTC', 1, 1);
  assert.equal(scheduler.getStatus().backoffRemainingMsByScopeAndGroup['ip:candle'], 1000);
  const candlePromise = api.getMinuteCandles('KRW-ETH', 1, 1);
  const tickerPromise = api.getTicker('KRW-BTC');
  await clock.advanceBy(120);
  assert.equal(starts.length, 2);
  assert.ok(starts[1].url.endsWith('/ticker'));
  assert.equal(starts[1].at, 120);

  await clock.advanceBy(880);
  assert.equal(starts.length, 3);
  assert.ok(starts[2].url.includes('/candles/'));
  assert.equal(starts[2].at, 1000);
  await Promise.all([candlePromise, tickerPromise]);
});
