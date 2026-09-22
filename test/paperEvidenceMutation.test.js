import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import createConfigRoutes from '../src/api/routes/config.js';
import createOptimizationRoutes from '../src/api/routes/optimization.js';

function createHarness() {
  const tradingSystem = {
    config: {
      maxHoldMinutes: 30,
      maxAnalysisDataGapSeconds: 60,
      maxCandleAgeSeconds: 90
    },
    strategyConfig: {},
    strategies: new Map(),
    isScalpingMode: true,
    candleUnit: 1,
    maxCandleAgeSeconds: 90,
    maxAnalysisDataGapSeconds: 60,
    maxRiskDataGapSeconds: 30,
    investmentRatio: 0.02,
    initialSeedMoney: 10_000_000,
    strategyMode: 'oversold_reaction_scalping',
    maxPositions: 3,
    paperValidation: {
      active: true,
      sessionId: 'paper-evidence-fixture',
      startedAt: new Date(Date.now() - 60_000).toISOString()
    },
    getLossCircuitBreakerStatus: () => ({ coolingDown: false })
  };
  const server = {
    tradingSystem,
    optimizationState: {
      enabled: false,
      interval: 3_600_000,
      nextRun: null,
      isRunning: false
    },
    startOptimizationScheduler() {
      this.schedulerStarted = true;
    },
    stopOptimizationScheduler() {
      this.schedulerStopped = true;
    },
    saveOptimizationState() {
      this.stateSaved = true;
    },
    runOptimizationCycle() {
      this.optimizationStarted = true;
    }
  };
  const app = express();
  app.use(express.json());
  app.use(createConfigRoutes(server));
  app.use(createOptimizationRoutes(server));
  return { app, server };
}

async function requestJson(app, path, body) {
  const listener = app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise(resolve => listener.close(resolve));
  }
}

test('활성 paper evidence 세션 중 config mutation은 거절되고 runtime 설정을 보존한다', async () => {
  const { app, server } = createHarness();

  const result = await requestJson(app, '/config/update', { maxHoldMinutes: 20 });

  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'paper_evidence_mutation_blocked');
  assert.equal(server.tradingSystem.config.maxHoldMinutes, 30);
});

test('활성 paper evidence 세션 중 자동 최적화 스케줄 변경도 거절한다', async () => {
  const { app, server } = createHarness();

  const result = await requestJson(app, '/optimization/toggle', { enabled: true });

  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'paper_evidence_mutation_blocked');
  assert.equal(server.optimizationState.enabled, false);
  assert.equal(server.schedulerStarted, undefined);
});

test('활성 paper 세션이 없으면 설정 변경 계약을 기존처럼 허용한다', async () => {
  const { app, server } = createHarness();
  server.tradingSystem.paperValidation.active = false;

  const result = await requestJson(app, '/config/update', { maxHoldMinutes: 20 });

  assert.equal(result.status, 200);
  assert.equal(server.tradingSystem.config.maxHoldMinutes, 20);
});

test('read-only observer mutation은 paper evidence lock과 별도 오류로 거절한다', async () => {
  const { app, server } = createHarness();
  server.tradingSystem.paperValidation.active = false;
  server.tradingSystem.readOnlyObserver = true;

  const result = await requestJson(app, '/config/update', { maxHoldMinutes: 20 });

  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'read_only_observer_mutation_blocked');
  assert.equal(server.tradingSystem.config.maxHoldMinutes, 30);
});
