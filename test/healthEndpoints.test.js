import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import DashboardServer from '../src/api/dashboardServer.js';
import { createMockTrader } from '../src/scripts/runDashboard.js';

function authOffEnv() {
  return { ...process.env, DASHBOARD_TOKEN: '', DASHBOARD_HOST: '', DASHBOARD_ALLOW_INSECURE: '' };
}

async function startDashboard(env = {}) {
  const trader = createMockTrader();
  const dashboard = new DashboardServer(trader, 0, { env: { ...authOffEnv(), ...env } });
  const httpServer = await dashboard.start();
  const { port } = httpServer.address();
  return { dashboard, trader, httpServer, baseUrl: `http://127.0.0.1:${port}` };
}

async function stopDashboard({ dashboard, trader }) {
  const closed = dashboard.httpServer?.listening
    ? once(dashboard.httpServer, 'close')
    : Promise.resolve();
  dashboard.stop();
  trader.stop();
  await closed;
}

test('/health returns minimal liveness payload without auth', async () => {
  const ctx = await startDashboard();
  try {
    const res = await fetch(`${ctx.baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.uptimeSec, 'number');
    assert.equal(body.pid, process.pid);
    assert.ok(!Number.isNaN(Date.parse(body.timestamp)));
    // No sensitive surface: no config, positions, or account fields.
    assert.deepEqual(Object.keys(body).sort(), ['pid', 'status', 'timestamp', 'uptimeSec']);
  } finally {
    await stopDashboard(ctx);
  }
});

test('/health stays public even when DASHBOARD_TOKEN protects /api', async () => {
  const ctx = await startDashboard({ DASHBOARD_TOKEN: 'secret-token' });
  try {
    const health = await fetch(`${ctx.baseUrl}/health`);
    assert.equal(health.status, 200);

    const gated = await fetch(`${ctx.baseUrl}/api/system-status`);
    assert.equal(gated.status, 401);
  } finally {
    await stopDashboard(ctx);
  }
});

test('/ready reports 503 while the trader loop is not running', async () => {
  const ctx = await startDashboard();
  try {
    // Mock trader starts with isRunning=false until start() is invoked.
    ctx.trader.isRunning = false;
    const res = await fetch(`${ctx.baseUrl}/ready`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.ready, false);
    assert.equal(body.checks.traderRunning, false);
    assert.equal(body.checks.httpServerListening, true);
  } finally {
    await stopDashboard(ctx);
  }
});

test('/ready distinguishes protective-only trading from a fully running loop', async () => {
  const ctx = await startDashboard();
  try {
    ctx.trader.isRunning = false;
    ctx.trader.getRuntimeSafetyStatus = () => ({
      runtimeState: 'PROTECTIVE_ONLY',
      entriesPaused: true,
      protectiveMonitorActive: true,
      stopReason: 'risk_data_gap',
      exchangeStateKnown: true
    });

    const response = await fetch(`${ctx.baseUrl}/ready`);
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.ready, false);
    assert.equal(body.checks.runtimeState, 'PROTECTIVE_ONLY');
    assert.equal(body.checks.entriesPaused, true);
    assert.equal(body.checks.protectiveMonitorActive, true);
    assert.equal(body.checks.stopReason, 'risk_data_gap');
    assert.equal(body.checks.exchangeStateKnown, true);
  } finally {
    await stopDashboard(ctx);
  }
});

test('/ready blocks a running LIVE service while exchange state is unknown', async () => {
  const ctx = await startDashboard();
  try {
    ctx.trader.isRunning = true;
    ctx.trader.dryRun = false;
    ctx.trader.getRuntimeSafetyStatus = () => ({
      runtimeState: 'SYNC_REQUIRED',
      entriesPaused: true,
      protectiveMonitorActive: false,
      stopReason: 'exchange_state_unverified',
      exchangeStateKnown: false
    });

    const response = await fetch(`${ctx.baseUrl}/ready`);
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.ready, false);
    assert.equal(body.checks.traderRunning, true);
    assert.equal(body.checks.runtimeState, 'SYNC_REQUIRED');
    assert.equal(body.checks.exchangeStateKnown, false);
  } finally {
    await stopDashboard(ctx);
  }
});

test('/ready reports 200 with health checks once the trader is running', async () => {
  const ctx = await startDashboard();
  try {
    ctx.trader.start();
    const res = await fetch(`${ctx.baseUrl}/ready`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ready, true);
    assert.equal(body.checks.traderRunning, true);
    assert.equal(body.checks.analysisHealthy, true);
    assert.equal(body.checks.riskHealthy, true);
    assert.ok('lastCycleAt' in body.checks);
  } finally {
    await stopDashboard(ctx);
  }
});

test('/control/stop requests a graceful LIVE drain instead of stopping the position monitor', async () => {
  const ctx = await startDashboard();
  const originalStop = ctx.trader.stop.bind(ctx.trader);
  let directStopCalls = 0;
  let requestedReason = null;
  ctx.trader.dryRun = false;
  ctx.trader.isRunning = true;
  ctx.trader.stop = (...args) => {
    directStopCalls += 1;
    return originalStop(...args);
  };
  ctx.trader.getCurrentPositionCount = () => 1;
  ctx.trader.getRuntimeSafetyStatus = () => ({
    runtimeState: 'PROTECTIVE_ONLY',
    entriesPaused: true,
    protectiveMonitorActive: true,
    stopReason: 'operator_stop',
    exchangeStateKnown: true
  });
  ctx.trader.requestGracefulShutdown = reason => {
    requestedReason = reason;
    return Promise.resolve(true);
  };

  try {
    const response = await fetch(`${ctx.baseUrl}/api/control/stop`, { method: 'POST' });
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.equal(body.success, true);
    assert.equal(body.shutdownRequested, true);
    assert.equal(body.runtimeState, 'PROTECTIVE_ONLY');
    assert.equal(requestedReason, 'operator_stop');
    assert.equal(directStopCalls, 0);
  } finally {
    await stopDashboard(ctx);
  }
});

test('/control/stop reports an in-flight order drain even when no local position is open', async () => {
  const ctx = await startDashboard();
  let finishOrder;
  ctx.trader.dryRun = false;
  ctx.trader.isRunning = false;
  ctx.trader._orderInProgress = true;
  ctx.trader.getCurrentPositionCount = () => 0;
  ctx.trader.getRuntimeSafetyStatus = () => ({
    runtimeState: 'STOPPED',
    entriesPaused: true,
    protectiveMonitorActive: false,
    stopReason: 'operator_stop',
    exchangeStateKnown: true
  });
  ctx.trader.requestGracefulShutdown = () => new Promise(resolve => { finishOrder = resolve; });

  try {
    const response = await fetch(`${ctx.baseUrl}/api/control/stop`, { method: 'POST' });
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.equal(body.shutdownRequested, true);
    assert.match(body.message, /진행 중인 주문과 위험 확인/);
    assert.equal(typeof finishOrder, 'function');
  } finally {
    finishOrder?.(true);
    await stopDashboard(ctx);
  }
});

test('/control/start returns a LIVE validation failure instead of reporting a false start', async () => {
  const ctx = await startDashboard();
  let startCalls = 0;
  ctx.trader.dryRun = false;
  ctx.trader.isRunning = false;
  ctx.trader._startPromise = null;
  ctx.trader.assertLiveValidationGate = () => {
    throw new Error('실전 매매 차단: 포지션 위험 감시를 비활성화할 수 없습니다.');
  };
  ctx.trader.start = () => { startCalls += 1; return Promise.resolve(); };

  try {
    const response = await fetch(`${ctx.baseUrl}/api/control/start`, { method: 'POST' });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.success, false);
    assert.match(body.error, /포지션 위험 감시/);
    assert.equal(startCalls, 0);
  } finally {
    await stopDashboard(ctx);
  }
});

test('/control/start reports a sync-required startup as accepted and prevents a duplicate start', async () => {
  const ctx = await startDashboard();
  let startCalls = 0;
  ctx.trader.dryRun = false;
  ctx.trader.isRunning = false;
  ctx.trader._startPromise = null;
  ctx.trader.assertLiveValidationGate = () => {};
  ctx.trader.getRuntimeSafetyStatus = () => ({ runtimeState: 'SYNC_REQUIRED', exchangeStateKnown: false });
  ctx.trader.start = () => {
    startCalls += 1;
    ctx.trader._startPromise = Promise.resolve();
    return ctx.trader._startPromise;
  };

  try {
    const first = await fetch(`${ctx.baseUrl}/api/control/start`, { method: 'POST' });
    const firstBody = await first.json();
    const second = await fetch(`${ctx.baseUrl}/api/control/start`, { method: 'POST' });
    const secondBody = await second.json();

    assert.equal(first.status, 202);
    assert.equal(firstBody.success, true);
    assert.equal(firstBody.runtimeState, 'SYNC_REQUIRED');
    assert.equal(second.status, 200);
    assert.equal(secondBody.success, false);
    assert.equal(startCalls, 1);
  } finally {
    await stopDashboard(ctx);
  }
});

test('/ready surfaces a fail-closed analysis gap as not-ready', async () => {
  const ctx = await startDashboard();
  try {
    ctx.trader.start();
    // Simulate the runtime's own fail-closed verdict rather than faking internals:
    // a stale analysis observation older than the configured gap.
    ctx.trader.analysisDataHealthState = {
      analysisActive: true,
      lastSuccessAt: new Date(Date.now() - 120_000).toISOString(),
      lastAttemptAt: new Date(Date.now() - 120_000).toISOString(),
      monitoringStartedAt: new Date(Date.now() - 120_000).toISOString(),
      continuityEligible: true
    };
    ctx.trader.maxAnalysisDataGapSeconds = 30;

    const res = await fetch(`${ctx.baseUrl}/ready`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.ready, false);
    assert.equal(body.checks.analysisHealthy, false);
    assert.equal(body.checks.analysisStaleReason, 'analysis_cycle_stale');
    assert.equal(body.checks.traderRunning, true);
  } finally {
    await stopDashboard(ctx);
  }
});
