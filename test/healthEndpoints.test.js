import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import DashboardServer from '../src/api/dashboardServer.js';
import { createMockTrader } from '../src/scripts/runDashboard.js';

function authOffEnv() {
  return { ...process.env, DASHBOARD_TOKEN: '', DASHBOARD_READ_ONLY_TOKEN: '', DASHBOARD_MOBILE_TOKEN: '', DASHBOARD_HOST: '', DASHBOARD_ALLOW_INSECURE: '' };
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
  await dashboard.stop();
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

test('/service-ready stays available while /trading-ready waits for a complete fresh analysis cycle', async () => {
  const ctx = await startDashboard();
  try {
    ctx.trader.isRunning = true;

    const serviceReady = await fetch(`${ctx.baseUrl}/service-ready`);
    assert.equal(serviceReady.status, 200);
    assert.equal((await serviceReady.json()).ready, true);

    const beforeFirstCycle = await fetch(`${ctx.baseUrl}/trading-ready`);
    assert.equal(beforeFirstCycle.status, 503);
    const beforeFirstCycleBody = await beforeFirstCycle.json();
    assert.equal(beforeFirstCycleBody.ready, false);
    assert.equal(beforeFirstCycleBody.checks.traderRunning, true);
    assert.equal(beforeFirstCycleBody.checks.analysisFirstCycleComplete, false);
    assert.equal(beforeFirstCycleBody.checks.analysisCycleFresh, false);

    const firstCycleAt = new Date().toISOString();
    ctx.trader.getAnalysisDataHealthStatus = () => ({
      failClosed: false,
      lastCompleteAt: firstCycleAt,
      maxAnalysisDataGapSeconds: 180
    });
    ctx.trader.getRiskMonitorStatus = () => ({ failClosed: false });

    const afterFirstCycle = await fetch(`${ctx.baseUrl}/trading-ready`);
    assert.equal(afterFirstCycle.status, 200);
    const afterFirstCycleBody = await afterFirstCycle.json();
    assert.equal(afterFirstCycleBody.ready, true);
    assert.equal(afterFirstCycleBody.checks.analysisFirstCycleComplete, true);
    assert.equal(afterFirstCycleBody.checks.analysisCycleFresh, true);

    // Preserve the legacy readiness contract during migration.
    const legacyReady = await fetch(`${ctx.baseUrl}/ready`);
    assert.equal(legacyReady.status, 200);
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

test('/control/start explains the actual scalping gate failure without starting or changing manual protection', async () => {
  const ctx = await startDashboard();
  let startCalls = 0;
  let intentCalls = 0;
  let refreshCalls = 0;
  const protectionTimer = {};
  ctx.trader.dryRun = false;
  ctx.trader.isRunning = false;
  ctx.trader._startPromise = null;
  ctx.trader._entriesPaused = true;
  ctx.trader._manualRiskProtection = true;
  ctx.trader.positionRiskTimer = protectionTimer;
  ctx.trader.autoRecovery = { noteDesiredRunning: () => { intentCalls += 1; } };
  ctx.trader.liveValidationRefresher = { requestRefresh: () => { refreshCalls += 1; } };
  ctx.trader.assertLiveValidationGate = () => {
    throw Object.assign(new Error('실전 스캘핑 차단: 검증 리포트가 오래되었습니다 (/private/secret-report.json).'), {
      code: 'report_not_current'
    });
  };
  ctx.trader.start = () => { startCalls += 1; return Promise.resolve(); };

  try {
    const response = await fetch(`${ctx.baseUrl}/api/control/start`, { method: 'POST' });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.success, false);
    assert.equal(body.code, 'report_not_current');
    assert.match(body.error, /점검 결과가 오래되었거나/);
    assert.doesNotMatch(JSON.stringify(body), /private|secret-report|실전 스캘핑 차단/);
    assert.equal(startCalls, 0);
    assert.equal(intentCalls, 0);
    assert.equal(refreshCalls, 1);
    assert.equal(ctx.trader._entriesPaused, true);
    assert.equal(ctx.trader._manualRiskProtection, true);
    assert.equal(ctx.trader.positionRiskTimer, protectionTimer);
  } finally {
    ctx.trader.positionRiskTimer = null;
    await stopDashboard(ctx);
  }
});

test('/control/start classifies known LIVE blockers and sanitizes unknown failures', async () => {
  const ctx = await startDashboard();
  let startCalls = 0;
  let intentCalls = 0;
  let gateError;
  ctx.trader.dryRun = false;
  ctx.trader.isRunning = false;
  ctx.trader._startPromise = null;
  ctx.trader.autoRecovery = { noteDesiredRunning: () => { intentCalls += 1; } };
  ctx.trader.assertLiveValidationGate = () => { throw gateError; };
  ctx.trader.start = () => { startCalls += 1; return Promise.resolve(); };
  const cases = [
    ['실전 스캘핑 차단: /private/secret-report.json 검증 리포트가 없습니다. 먼저 npm run validate:scalping을 실행하세요.', 'report_missing', /점검 결과가 필요/],
    ['실전 스캘핑 차단: 검증 리포트를 읽을 수 없습니다 (Unexpected token secret-report)', 'report_unreadable', /점검 결과를 불러오지 못/],
    ['실전 스캘핑 차단: 검증 리포트가 오래되었거나 작성 시각을 확인할 수 없습니다 (stale).', 'report_not_current', /점검 결과가 오래되었거나/],
    ['실전 스캘핑 차단: 현재 runtime 설정을 고정 검증한 fixed_config 리포트가 필요합니다.', 'fixed_config_required', /현재 투자 설정으로 점검/],
    ['실전 스캘핑 차단: validation report와 현재 runtime 설정이 다릅니다 (secret-report).', 'runtime_config_mismatch', /현재 투자 설정과 점검 당시 설정이 다릅니다/],
    ['실전 스캘핑 차단: fixed validation report 설정이 불완전합니다 (secret-report).', 'report_config_incomplete', /필요한 투자 설정이 빠져/],
    ['실전 스캘핑 차단: 95% 거래수익 신뢰도 게이트가 없거나 통과하지 않았습니다.', 'confidence_gate_failed', /거래 수익에 대한 검증이 충분하지/],
    ['실전 스캘핑 차단: 전체 워크포워드 게이트 미통과 (0/20). DRY_RUN=true로 계속 검증하세요.', 'promotion_gate_failed', /투자 전략이 실거래 자동매매 검증을 통과하지/],
    ['실전 스캘핑 차단: 검증 대상 market 목록이 비어 있습니다.', 'markets_missing', /투자 대상 코인이 없습니다/],
    ['실전 스캘핑 차단: validation report 전략 모드가 다릅니다 (secret-report).', 'strategy_mode_mismatch', /현재 투자 전략과 점검 당시 전략이 다릅니다/],
    ['실전 스캘핑 차단: 실전 검증 게이트를 비활성화할 수 없습니다.', 'live_validation_bypass_not_supported', /검증을 끌 수 없습니다/],
    ['실전 매매 차단: 포지션 위험 감시를 비활성화할 수 없습니다. SCALP_RISK_CHECK_INTERVAL_MS를 0보다 크게 설정하세요.', 'risk_monitor_disabled', /포지션 위험 감시/],
    ['실전 매매 차단: 리스크 데이터 공백 감지를 비활성화할 수 없습니다.', 'risk_data_gap_protection_disabled', /거래소 데이터가 끊겼을 때의 보호 설정/],
    ['Failed to read fixed_config at /private/secret-report.json: {"token":"secret-value"}', 'trading_start_failed', /^자동매매를 시작하지 못했습니다\. 설정과 서버 상태를 확인해 주세요\.$/]
  ];

  try {
    for (const [message, code, expectedMessage] of cases) {
      gateError = Object.assign(new Error(message), { code: 'UNKNOWN_PRIVATE_CODE' });
      const response = await fetch(`${ctx.baseUrl}/api/control/start`, { method: 'POST' });
      const body = await response.json();

      assert.equal(response.status, 400, code);
      assert.equal(body.success, false, code);
      assert.equal(body.code, code);
      assert.match(body.error, expectedMessage);
      assert.doesNotMatch(JSON.stringify(body), /private|secret-report|secret-value|UNKNOWN_PRIVATE_CODE/);
      assert.doesNotMatch(body.error, /fixed_config|SCALP_|실전 스캘핑 차단/);
      assert.equal(startCalls, 0, code);
      assert.equal(intentCalls, 0, code);
    }
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
