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
  const httpServer = dashboard.start();
  await once(httpServer, 'listening');
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
