import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { once } from 'node:events';
import DashboardServer from '../src/api/dashboardServer.js';
import createOptimizationRoutes from '../src/api/routes/optimization.js';
import ParameterOptimizer from '../src/optimization/parameterOptimizer.js';

const ONE_HOUR = 3_600_000;

function createHarness(root) {
  const server = Object.create(DashboardServer.prototype);
  server.optimizationState = {
    enabled: false,
    interval: ONE_HOUR,
    lastRun: null,
    nextRun: null,
    isRunning: false
  };
  server.optimizationTimer = null;
  server.optimizationStateFile = path.join(root, 'optimization_state.json');
  server.optimizationHistoryFile = path.join(root, 'optimization_history.json');
  server.optimalConfigFile = path.join(root, 'optimal_config.json');
  server.schedulerCalls = [];
  server.tradingSystem = {
    paperValidation: { active: false },
    config: { stopLossPercent: 2, takeProfitPercent: 4, investmentRatio: 0.2 },
    strategyConfig: { rsi: { period: 14 } },
    strategies: new Map([['fixture', { multiplier: 3 }]])
  };
  server.startOptimizationScheduler = function startOptimizationScheduler() {
    this.schedulerCalls.push('start');
    this.optimizationTimer = { interval: this.optimizationState.interval };
    this.optimizationState.nextRun = 'scheduled-next-run';
  };
  server.stopOptimizationScheduler = function stopOptimizationScheduler() {
    this.schedulerCalls.push('stop');
    this.optimizationTimer = null;
    this.optimizationState.nextRun = null;
  };

  const app = express();
  app.use(express.json());
  app.use(createOptimizationRoutes(server));
  return { app, server };
}

async function requestJson(app, url, method = 'POST', body) {
  const listener = app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise(resolve => listener.close(resolve));
  }
}

function makeTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-optimization-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('optimization state write errors throw and toggle preserves state and timer on failure', async t => {
  const root = makeTempRoot(t);
  const { app, server } = createHarness(root);
  fs.mkdirSync(server.optimizationStateFile);
  server.optimizationState.nextRun = 'previous-next-run';
  const previousState = { ...server.optimizationState };
  const previousTimer = { token: 'existing-scheduler' };
  server.optimizationTimer = previousTimer;

  const originalError = console.error;
  console.error = () => {};
  try {
    assert.throws(() => server.saveOptimizationState(), /EISDIR|directory/i);
    const response = await requestJson(app, '/optimization/toggle', 'POST', { enabled: true });
    const intervalResponse = await requestJson(app, '/optimization/interval', 'POST', { interval: 7_200_000 });

    assert.equal(response.status, 500);
    assert.notEqual(response.body.success, true);
    assert.equal(intervalResponse.status, 500);
    assert.notEqual(intervalResponse.body.success, true);
    assert.deepEqual(server.optimizationState, previousState);
    assert.strictEqual(server.optimizationTimer, previousTimer);
    assert.deepEqual(server.schedulerCalls, []);
    assert.deepEqual(fs.readdirSync(root).filter(name => name.endsWith('.tmp')), []);
  } finally {
    console.error = originalError;
  }
});

test('dashboard and restarted optimizer resolve persistence from one configured state root', async t => {
  const root = makeTempRoot(t);
  const stateDir = path.join(root, 'persistent-state');
  const firstWorkingDirectory = path.join(root, 'release', 'current');
  const secondWorkingDirectory = path.join(root, 'runtime');
  fs.mkdirSync(firstWorkingDirectory, { recursive: true });
  fs.mkdirSync(secondWorkingDirectory, { recursive: true });
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    COINPILOT_STATE_DIR: stateDir,
    DASHBOARD_TOKEN: '',
    DASHBOARD_HOST: '127.0.0.1',
    DASHBOARD_ALLOW_INSECURE: 'true'
  };
  const quietLogger = { info() {}, error() {}, warn() {} };
  const makeDashboard = cwd => new DashboardServer({
    dryRun: true,
    config: { virtualPortfolioFile: path.join(stateDir, 'dry_portfolio.json') },
    virtualPortfolioFile: path.join(stateDir, 'dry_portfolio.json')
  }, 0, { env, cwd, logger: quietLogger });

  const firstDashboard = makeDashboard(firstWorkingDirectory);
  t.after(async () => firstDashboard.stop());
  assert.equal(firstDashboard.getOptimizationStateFile(), path.join(stateDir, 'optimization_state.json'));
  assert.equal(firstDashboard.getOptimizationHistoryFile(), path.join(stateDir, 'optimization_history.json'));
  assert.equal(firstDashboard.getOptimalConfigFile(), path.join(stateDir, 'optimal_config.json'));
  firstDashboard.saveOptimizationState({ enabled: false, interval: ONE_HOUR, lastRun: '2026-09-30T00:00:00.000Z' });

  const optimizer = new ParameterOptimizer({ cwd: firstWorkingDirectory, stateDir });
  await optimizer.saveOptimalParameters({ rsiPeriod: 9, takeProfitPercent: 1.5 });
  await firstDashboard.stop();

  const restartedDashboard = makeDashboard(secondWorkingDirectory);
  t.after(async () => restartedDashboard.stop());
  assert.equal(restartedDashboard.optimizationState.enabled, false);
  assert.equal(restartedDashboard.optimizationState.lastRun, '2026-09-30T00:00:00.000Z');
  const restartedOptimizer = new ParameterOptimizer({ cwd: secondWorkingDirectory, stateDir });
  assert.deepEqual(restartedOptimizer.savedParams, { rsiPeriod: 9, takeProfitPercent: 1.5 });
});

test('successful toggle and interval changes persist before updating scheduler state', async t => {
  const root = makeTempRoot(t);
  const { app, server } = createHarness(root);

  const toggle = await requestJson(app, '/optimization/toggle', 'POST', { enabled: true });
  assert.equal(toggle.status, 200);
  assert.equal(toggle.body.success, true);
  assert.equal(server.optimizationState.enabled, true);
  assert.deepEqual(server.optimizationTimer, { interval: ONE_HOUR });
  assert.deepEqual(JSON.parse(fs.readFileSync(server.optimizationStateFile, 'utf8')), {
    enabled: true,
    interval: ONE_HOUR,
    lastRun: null
  });

  const interval = await requestJson(app, '/optimization/interval', 'POST', { interval: 43_200_000 });
  assert.equal(interval.status, 200);
  assert.equal(interval.body.interval, 43_200_000);
  assert.equal(server.optimizationState.interval, 43_200_000);
  assert.deepEqual(server.optimizationTimer, { interval: 43_200_000 });
  assert.deepEqual(server.schedulerCalls, ['start', 'stop', 'start']);
  assert.deepEqual(JSON.parse(fs.readFileSync(server.optimizationStateFile, 'utf8')), {
    enabled: true,
    interval: 43_200_000,
    lastRun: null
  });
});

test('toggle and interval validate values accepted by the existing PWA', async t => {
  const root = makeTempRoot(t);
  const { app, server } = createHarness(root);

  const invalidToggle = await requestJson(app, '/optimization/toggle', 'POST', { enabled: 'true' });
  const invalidInterval = await requestJson(app, '/optimization/interval', 'POST', { interval: '3600000junk' });
  const stringInterval = await requestJson(app, '/optimization/interval', 'POST', { interval: '7200000' });

  assert.equal(invalidToggle.status, 400);
  assert.equal(invalidInterval.status, 400);
  assert.equal(stringInterval.status, 200);
  assert.equal(server.optimizationState.enabled, false);
  assert.equal(server.optimizationState.interval, 7_200_000);
  assert.deepEqual(server.schedulerCalls, []);
});

test('candidate comparison writes history without changing active config or trader settings', async t => {
  const root = makeTempRoot(t);
  const { app, server } = createHarness(root);
  const activeConfig = { source: 'boot-config', parameters: { maxHoldMinutes: 30 } };
  fs.writeFileSync(server.optimalConfigFile, JSON.stringify(activeConfig, null, 2), 'utf8');
  fs.writeFileSync(server.optimizationHistoryFile, '[]', 'utf8');

  const settingsBefore = structuredClone({
    config: server.tradingSystem.config,
    strategyConfig: server.tradingSystem.strategyConfig,
    strategies: server.tradingSystem.strategies
  });
  const candidateParameters = { maxHoldMinutes: 18, stopLossPercent: 1.5 };
  const originalEnv = {
    TARGET_COIN: process.env.TARGET_COIN,
    BACKTEST_CANDLE_UNIT: process.env.BACKTEST_CANDLE_UNIT,
    BACKTEST_CANDLE_COUNT: process.env.BACKTEST_CANDLE_COUNT
  };
  process.env.TARGET_COIN = 'KRW-ETH';
  process.env.BACKTEST_CANDLE_UNIT = '5';
  process.env.BACKTEST_CANDLE_COUNT = '250';
  server.collectCandleData = async (coin, unit, count) => {
    assert.deepEqual([coin, unit, count], ['KRW-ETH', 5, 250]);
    return Array.from({ length: 250 }, (_, index) => ({ candle: index }));
  };
  server.createParameterOptimizer = async options => {
    assert.equal(options.populationSize, Number.parseInt(process.env.POPULATION_SIZE, 10) || 20);
    return {
      optimize: async candles => {
        assert.equal(candles.length, 250);
        return { fitness: 8.75, parameters: candidateParameters };
      }
    };
  };
  let applyCalls = 0;
  server.applyOptimalParameters = () => { applyCalls += 1; };

  try {
    await server.runOptimizationCycle();
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const history = JSON.parse(fs.readFileSync(server.optimizationHistoryFile, 'utf8'));
  assert.equal(history.length, 1);
  assert.match(history[0].timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(history[0].cycle, 1);
  assert.equal(history[0].targetCoin, 'KRW-ETH');
  assert.equal(history[0].candleUnit, 5);
  assert.equal(history[0].candleCount, 250);
  assert.equal(history[0].fitness, 8.75);
  assert.deepEqual(history[0].parameters, candidateParameters);
  assert.deepEqual(JSON.parse(fs.readFileSync(server.optimalConfigFile, 'utf8')), activeConfig);
  assert.equal(applyCalls, 0);
  assert.deepEqual({
    config: server.tradingSystem.config,
    strategyConfig: server.tradingSystem.strategyConfig,
    strategies: server.tradingSystem.strategies
  }, settingsBefore);
  assert.deepEqual(JSON.parse(fs.readFileSync(server.optimizationStateFile, 'utf8')), {
    enabled: false,
    interval: ONE_HOUR,
    lastRun: server.optimizationState.lastRun
  });

  const activeConfigResponse = await requestJson(app, '/optimal-config', 'GET');
  assert.equal(activeConfigResponse.status, 200);
  assert.deepEqual(activeConfigResponse.body, activeConfig);

  const historyResponse = await requestJson(app, '/optimization-history', 'GET');
  assert.equal(historyResponse.status, 200);
  assert.deepEqual(historyResponse.body, [history[0]]);
});
