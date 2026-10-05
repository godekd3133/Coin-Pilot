import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import MultiCoinTrader from '../src/trader/multiCoinTrader.js';
import {
  AutoRecoverySupervisor,
  AUTO_RECOVERABLE_STOP_REASONS,
  deriveAutomationIntentFile,
  readAutomationIntent,
  writeAutomationIntent
} from '../src/runtime/autoRecoverySupervisor.js';

const MARKETS = ['KRW-BTC', 'KRW-ETH'];

function freshTicker(market) {
  return { market, trade_price: 100, trade_timestamp: Date.now() };
}

function createFakeTrader(overrides = {}) {
  const trader = {
    isRunning: false,
    stopReason: 'risk_data_gap',
    _startPromise: null,
    _gracefulShutdownPromise: null,
    _orderInProgress: false,
    _riskCheckInProgress: false,
    _riskMonitorProtectiveOnly: false,
    targetCoins: [...MARKETS],
    candleUnit: 1,
    maxCandleAgeSeconds: 90,
    config: { rsiPeriod: 14 },
    riskUpbit: {
      getTicker: async markets => markets.map(freshTicker)
    },
    marketDataAdapter: {
      getMinuteCandles: async (market, unit, count) => Array.from({ length: count }, () => ({}))
    },
    startCalls: 0,
    start() {
      this.startCalls += 1;
      this.isRunning = true;
      return Promise.resolve();
    },
    ...overrides
  };
  return trader;
}

function createSupervisor(trader, options = {}) {
  let currentTime = options.initialTime ?? 1_000_000;
  const supervisor = new AutoRecoverySupervisor(trader, {
    probeIntervalMs: 5000,
    minDownMs: 0,
    healthyProbes: 1,
    now: () => currentTime,
    logger: { log: () => {}, error: () => {} },
    ...options
  });
  return {
    supervisor,
    advance: ms => { currentTime += ms; }
  };
}

function intentFilePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-autorecovery-')), 'intent.json');
}

test('복구 가능한 안전 중지 + desired intent이면 건강 확인 후 자동 재시작한다', async () => {
  const trader = createFakeTrader();
  const intentFile = intentFilePath();
  writeAutomationIntent(intentFile, { desiredRunning: true, source: 'control_start' });
  const { supervisor } = createSupervisor(trader, { intentFile });

  await supervisor.tick();
  assert.equal(trader.startCalls, 1);
  assert.equal(supervisor.getStatus().armed, false);

  await supervisor.tick();
  assert.equal(supervisor.getStatus().resumeCount, 1);
});

test('sawRunning만으로도 복구 가능 사유 중지는 자동 재개된다', async () => {
  const trader = createFakeTrader({ isRunning: true });
  const { supervisor } = createSupervisor(trader);

  await supervisor.tick(); // 실행 중 관측 → sawRunning
  assert.equal(trader.startCalls, 0);

  trader.isRunning = false;
  trader.stopReason = 'analysis_data_gap';
  await supervisor.tick();
  assert.equal(trader.startCalls, 1);
});

test('운영자 중지(operator_stop, desired=false)는 자동 재개하지 않는다', async () => {
  const trader = createFakeTrader({ stopReason: 'operator_stop' });
  const { supervisor } = createSupervisor(trader);

  await supervisor.tick();
  await supervisor.tick();
  assert.equal(trader.startCalls, 0);
  assert.equal(supervisor.getStatus().armed, false);
});

test('운영자가 중지하면 대기 중이던 복구도 해제된다', async () => {
  const trader = createFakeTrader();
  const intentFile = intentFilePath();
  writeAutomationIntent(intentFile, { desiredRunning: true, source: 'control_start' });
  const { supervisor } = createSupervisor(trader, { intentFile, minDownMs: 30000 });

  await supervisor.tick(); // armed, minDown 대기 중
  assert.equal(trader.startCalls, 0);

  supervisor.noteDesiredRunning(false, 'control_stop');
  assert.equal(readAutomationIntent(intentFile).desiredRunning, false);
  assert.equal(supervisor.getStatus().armed, false);
});

test('보호 전용 드레이닝 중에는 재개하지 않고 해제 후 재개한다', async () => {
  const trader = createFakeTrader({
    _riskMonitorProtectiveOnly: true,
    stopReason: 'risk_data_gap'
  });
  const intentFile = intentFilePath();
  writeAutomationIntent(intentFile, { desiredRunning: true, source: 'control_start' });
  const { supervisor } = createSupervisor(trader, { intentFile });

  await supervisor.tick();
  assert.equal(trader.startCalls, 0);

  trader._riskMonitorProtectiveOnly = false;
  await supervisor.tick();
  assert.equal(trader.startCalls, 1);
});

test('probe가 unhealthy면 재시작하지 않고 건강해지면 재개한다', async () => {
  const trader = createFakeTrader();
  const intentFile = intentFilePath();
  writeAutomationIntent(intentFile, { desiredRunning: true, source: 'control_start' });
  let healthy = false;
  const { supervisor, advance } = createSupervisor(trader, {
    intentFile,
    probe: async () => ({ healthy })
  });

  await supervisor.tick();
  assert.equal(trader.startCalls, 0);
  assert.equal(supervisor.getStatus().lastProbeError !== null, true);

  healthy = true;
  advance(5000);
  await supervisor.tick();
  assert.equal(trader.startCalls, 1);
});

test('모든 마켓의 ticker 신선도와 캔들 수량을 실제 데이터 경로로 확인한다', async () => {
  const calls = { ticker: 0, candles: 0 };
  const trader = createFakeTrader({
    riskUpbit: {
      getTicker: async markets => {
        calls.ticker += 1;
        return markets.map(freshTicker);
      }
    },
    marketDataAdapter: {
      getMinuteCandles: async (market, unit, count) => {
        calls.candles += 1;
        if (market === 'KRW-ETH') return [{}, {}];
        return Array.from({ length: count }, () => ({}));
      }
    }
  });
  const intentFile = intentFilePath();
  writeAutomationIntent(intentFile, { desiredRunning: true, source: 'control_start' });
  const { supervisor } = createSupervisor(trader, { intentFile });

  await supervisor.tick();
  assert.equal(trader.startCalls, 0);
  assert.equal(calls.ticker, 1);
  assert.equal(calls.candles > 0, true);
  assert.match(supervisor.getStatus().lastProbeError, /^candles:KRW-ETH/);
});

test('시작 실패는 백오프 후 재시도하고 오류를 상태에 남긴다', async () => {
  const trader = createFakeTrader({
    start() {
      this.startCalls += 1;
      return Promise.reject(new Error('report_not_current'));
    }
  });
  const intentFile = intentFilePath();
  writeAutomationIntent(intentFile, { desiredRunning: true, source: 'control_start' });
  const { supervisor, advance } = createSupervisor(trader, { intentFile });

  await supervisor.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(trader.startCalls, 1);
  assert.equal(supervisor.getStatus().lastStartError, 'report_not_current');

  // 직후 재시도는 백오프로 차단된다.
  await supervisor.tick();
  assert.equal(trader.startCalls, 1);

  advance(60_000);
  await supervisor.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(trader.startCalls, 2);
});

test('start() 실패는 onStartFailure 훅을 호출해 게이트 갱신을 유도한다', async () => {
  const trader = createFakeTrader();
  let captured = null;
  const { supervisor } = createSupervisor(trader, {
    probe: async () => ({ healthy: true }),
    onStartFailure: error => { captured = error; }
  });
  supervisor.noteDesiredRunning(true, 'test');
  trader.stopReason = 'risk_data_gap';
  trader.start = () => Promise.reject(new Error('live gate blocked'));
  await supervisor.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(captured instanceof Error);
  assert.equal(captured.message, 'live gate blocked');
});

test('비활성화되면 어떤 상태에서도 개입하지 않는다', async () => {
  const trader = createFakeTrader();
  const intentFile = intentFilePath();
  writeAutomationIntent(intentFile, { desiredRunning: true, source: 'control_start' });
  const { supervisor } = createSupervisor(trader, { intentFile, enabled: false });

  await supervisor.tick();
  assert.equal(trader.startCalls, 0);
});

test('최소 중지 시간(minDownMs) 전에는 probe하지 않는다', async () => {
  const trader = createFakeTrader();
  const intentFile = intentFilePath();
  writeAutomationIntent(intentFile, { desiredRunning: true, source: 'control_start' });
  let probeCalls = 0;
  const { supervisor, advance } = createSupervisor(trader, {
    intentFile,
    minDownMs: 30000,
    probe: async () => {
      probeCalls += 1;
      return { healthy: true };
    }
  });

  await supervisor.tick();
  assert.equal(probeCalls, 0);
  assert.equal(supervisor.getStatus().armed, true);

  advance(30000);
  await supervisor.tick();
  assert.equal(probeCalls, 1);
  assert.equal(trader.startCalls, 1);
});

test('연속 건강 확인 횟수를 채워야 재시작한다', async () => {
  const trader = createFakeTrader();
  const intentFile = intentFilePath();
  writeAutomationIntent(intentFile, { desiredRunning: true, source: 'control_start' });
  let probeCalls = 0;
  const { supervisor, advance } = createSupervisor(trader, {
    intentFile,
    healthyProbes: 2,
    probe: async () => {
      probeCalls += 1;
      return { healthy: true };
    }
  });

  await supervisor.tick();
  assert.equal(trader.startCalls, 0);

  advance(5000);
  await supervisor.tick();
  assert.equal(probeCalls, 2);
  assert.equal(trader.startCalls, 1);
});

test('intent 파일은 프로필 경로에서 파생되고 왕복 기록된다', () => {
  const derived = deriveAutomationIntentFile('/tmp/example/dry_portfolio.json');
  assert.equal(derived, '/tmp/example/dry_portfolio.json.automation_intent.json');

  const file = intentFilePath();
  assert.equal(readAutomationIntent(file), null);
  writeAutomationIntent(file, { desiredRunning: true, source: 'control_start' });
  const intent = readAutomationIntent(file);
  assert.equal(intent.desiredRunning, true);
  assert.equal(intent.source, 'control_start');

  fs.writeFileSync(file, 'not-json');
  assert.equal(readAutomationIntent(file), null);
});

test('실제 MultiCoinTrader가 risk_data_gap 중지 후 start() 경로로 복구된다', async t => {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false,
    checkInterval: 1,
    positionRiskCheckIntervalMs: 0,
    maxAnalysisDataGapSeconds: 0
  });
  t.after(() => { trader.isRunning = false; });

  trader.sleep = async () => {};
  trader.recordPaperValidationSnapshot = async () => {};
  let cycles = 0;
  trader.executeTradingCycle = async () => {
    cycles += 1;
    trader.isRunning = false;
  };

  trader.isRunning = true;
  trader.stop('risk_data_gap');
  assert.equal(trader.isRunning, false);
  assert.equal(trader.stopReason, 'risk_data_gap');
  assert.equal(trader._stopRequested, true);

  const { supervisor } = createSupervisor(trader, {
    probe: async () => ({ healthy: true })
  });
  supervisor.noteDesiredRunning(true, 'test');
  trader.autoRecovery = supervisor;

  await supervisor.tick();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(supervisor.getStatus().resumeAttempts, 1);
  assert.equal(cycles, 1);
  assert.equal(trader._startPromise, null);
  assert.equal(trader.stopReason, null);
  assert.equal(trader.getRuntimeSafetyStatus().autoRecovery.enabled, true);
});

test('복구 대상 사유 목록은 데이터 공백/미검증만 포함한다', () => {
  assert.deepEqual([...AUTO_RECOVERABLE_STOP_REASONS].sort(), [
    'analysis_data_gap',
    'exchange_state_unverified',
    'risk_data_gap'
  ]);
});
