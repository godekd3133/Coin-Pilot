import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_CONFIG } from '../src/backtest/scalpingBacktest.js';
import {
  LIVE_GATE_COMPARABLE_KEYS,
  loadPaperValidationConfigSnapshot,
  mergePaperValidationConfig
} from '../src/research/scalpingValidationConfig.js';
import {
  LiveValidationReportRefresher,
  createLiveValidationReportRefresher
} from '../src/runtime/liveValidationReportRefresher.js';

function writeReport(file, { generatedAt = new Date().toISOString(), promoted = true } = {}) {
  fs.writeFileSync(file, JSON.stringify({
    generatedAt,
    promoted,
    markets: ['KRW-BTC', 'KRW-ETH'],
    promotedMarkets: promoted ? ['KRW-BTC', 'KRW-ETH'] : []
  }), 'utf8');
}

function createHarness(traderOverrides = {}, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-refresh-'));
  const reportFile = path.join(root, 'scalping_validation.json');
  const trader = {
    dryRun: false,
    isScalpingMode: true,
    isRunning: true,
    config: { scalpingValidationOutputFile: reportFile },
    targetCoins: ['KRW-BTC', 'KRW-ETH'],
    getPaperValidationConfigSnapshot: () => ({
      ...DEFAULT_CONFIG,
      maxCandleAgeSeconds: 90,
      maxRiskDataGapSeconds: 30,
      maxAnalysisDataGapSeconds: 60,
      entryDelayMinMs: 1000,
      entryDelayMaxMs: 5000
    }),
    autoRecovery: null,
    ...traderOverrides
  };
  const children = [];
  let nowMs = 1_000_000;
  const timers = [];
  const refresher = new LiveValidationReportRefresher(trader, {
    intervalMs: 12 * 60 * 60 * 1000,
    minGapMs: 30 * 60 * 1000,
    timeoutMs: 15 * 60 * 1000,
    reportFile,
    snapshotTempRoot: root,
    now: () => nowMs,
    logger: { log() {}, error() {} },
    env: { PATH: '/usr/bin', SCALP_VALIDATION_CANDLES_FILE: 'stale-cache.json' },
    ...options,
    spawn: options.spawn || ((cmd, args, opts) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.killed = false;
      child.kill = signal => {
        child.killed = true;
        child.emit('close', 137, signal);
        return true;
      };
      children.push({ cmd, args, opts, child });
      return child;
    }),
    setTimeout: (fn, ms) => { const t = { fn, ms, id: timers.length }; timers.push(t); return t; },
    clearTimeout: () => {}
  });
  const closeLast = (code = 0) => {
    const entry = children[children.length - 1];
    assert.ok(entry, 'spawn되어야 한다');
    entry.child.emit('close', code);
  };
  return {
    refresher,
    trader,
    reportFile,
    children,
    closeLast,
    root,
    now: () => nowMs,
    advance: ms => { nowMs += ms; }
  };
}

test('dryRun이나 비스캘핑 프로세스에서는 완전히 비활성이다', async () => {
  for (const overrides of [{ dryRun: true }, { isScalpingMode: false }, { config: { requireValidationPassForLive: false } }]) {
    const h = createHarness(overrides);
    assert.equal(h.refresher.start(), false);
    assert.equal(h.refresher.requestRefresh('test'), false);
    await h.refresher.tick();
    assert.equal(h.children.length, 0);
  }
});

test('on-demand 요청은 자식 프로세스로 fixed validation을 실행한다', async () => {
  const h = createHarness();
  assert.equal(h.refresher.requestRefresh('control_start_gate'), true);
  const tickPromise = h.refresher.tick();
  assert.equal(h.children.length, 1);
  const { cmd, args, opts } = h.children[0];
  assert.ok(args[0].endsWith('validateScalping.js'));
  assert.equal(opts.env.SCALP_VALIDATION_FIXED, 'true');
  assert.equal(opts.env.SCALP_VALIDATION_OUTPUT_FILE, h.reportFile);
  assert.equal(opts.env.SCALP_VALIDATION_CANDLES_FILE, undefined);
  h.closeLast(0);
  await tickPromise;
  assert.equal(h.refresher.getStatus().runCount, 1);
  assert.equal(h.refresher.getStatus().lastExitCode, 0);
  assert.ok(cmd.length > 0);
});

test('성공한 실행은 리포트 요약을 상태에 남긴다', async () => {
  const h = createHarness();
  h.refresher.requestRefresh('test');
  const tickPromise = h.refresher.tick();
  writeReport(h.reportFile, { promoted: true });
  h.closeLast(0);
  await tickPromise;
  const status = h.refresher.getStatus();
  assert.equal(status.lastReport.promoted, true);
  assert.equal(status.lastReport.markets, 2);
  assert.equal(status.lastError, null);
});

test('minGap 이내의 연속 요청은 합쳐지고 다음 허용 시점에만 재실행된다', async () => {
  const h = createHarness();
  h.refresher.requestRefresh('first');
  let tickPromise = h.refresher.tick();
  h.closeLast(0);
  await tickPromise;
  assert.equal(h.children.length, 1);

  // 실행 직후 다시 요청 — minGap 동안 보류
  h.refresher.requestRefresh('second');
  h.advance(1000);
  await h.refresher.tick();
  assert.equal(h.children.length, 1);

  // minGap 경과 후 큐 드레인
  h.advance(30 * 60 * 1000);
  tickPromise = h.refresher.tick();
  assert.equal(h.children.length, 2);
  h.closeLast(0);
  await tickPromise;
});

test('진행 중 요청은 큐에 쌓여 다음 허용 시점에 드레인된다', async () => {
  const h = createHarness();
  h.refresher.requestRefresh('a');
  const tickPromise = h.refresher.tick();
  // 실행 중 추가 요청
  h.refresher.requestRefresh('b');
  h.closeLast(0);
  await tickPromise;
  assert.equal(h.refresher.getStatus().queued, true);
  h.advance(30 * 60 * 1000);
  const drain = h.refresher.tick();
  assert.equal(h.children.length, 2);
  h.closeLast(0);
  await drain;
  assert.equal(h.refresher.getStatus().queued, false);
});

test('자동매매가 실행 중이고 리포트가 stale하면 예약 리프레시가 돈다', async () => {
  const h = createHarness();
  writeReport(h.reportFile, {
    generatedAt: new Date(h.now() - 13 * 60 * 60 * 1000).toISOString()
  });
  const tickPromise = h.refresher.tick();
  assert.equal(h.children.length, 1);
  h.closeLast(0);
  await tickPromise;
  assert.equal(h.refresher.getStatus().lastRunReason, 'scheduled');
});

test('운영자 의도가 없고 리포트가 fresh하면 실행하지 않는다', async () => {
  const h = createHarness({ isRunning: false });
  h.trader.autoRecovery = { getStatus: () => ({ desiredRunning: false }) };
  writeReport(h.reportFile); // fresh
  await h.refresher.tick();
  assert.equal(h.children.length, 0);
});

test('자식 프로세스 실패는 오류로 기록되고 minGap 후 재시도할 수 있다', async () => {
  const h = createHarness();
  h.refresher.requestRefresh('x');
  let tickPromise = h.refresher.tick();
  h.children[0].child.stderr.emit('data', 'boom');
  h.closeLast(2);
  await tickPromise;
  assert.equal(h.refresher.getStatus().lastExitCode, 2);
  assert.ok(h.refresher.getStatus().lastError);
  h.advance(31 * 60 * 1000);
  h.refresher.requestRefresh('retry');
  tickPromise = h.refresher.tick();
  h.closeLast(0);
  await tickPromise;
  assert.equal(h.refresher.getStatus().lastExitCode, 0);
});

test('spawn 실패도 상태에 기록되고 예외로 전파되지 않는다', async () => {
  const h = createHarness({}, {
    spawn: () => { throw new Error('spawn denied'); }
  });
  h.refresher.requestRefresh('x');
  await h.refresher.tick();
  assert.equal(h.refresher.getStatus().lastError, 'spawn denied');
  assert.equal(h.refresher.getStatus().running, false);
});

test('팩토리는 runtime config를 supervisor 옵션으로 매핑한다', () => {
  const trader = { dryRun: false, isScalpingMode: true, config: { scalpingValidationOutputFile: 'r.json' } };
  const refresher = createLiveValidationReportRefresher(trader, {
    liveValidationRefreshEnabled: true,
    liveValidationRefreshIntervalMs: 1000,
    liveValidationRefreshMinGapMs: 5000,
    liveValidationRefreshTimeoutMs: 10000
  });
  assert.equal(refresher.intervalMs, 60000);
  assert.equal(refresher.minGapMs, 60000);
  assert.equal(refresher.timeoutMs, 60000);
  assert.equal(refresher.reportFile, 'r.json');
});

test('refresh validates the current runtime snapshot and exact markets instead of inherited preset defaults', async t => {
  const snapshot = {
    ...DEFAULT_CONFIG,
    rsiPeriod: 7,
    rsiOversold: 35,
    investmentRatio: 0.15,
    candleUnit: 3,
    maxCandleAgeSeconds: 180,
    maxRiskDataGapSeconds: 20,
    maxAnalysisDataGapSeconds: 45,
    entryDelayMinMs: 1500,
    entryDelayMaxMs: 3500,
    accessKey: 'must-not-copy-access-key',
    secretKey: 'must-not-copy-secret-key',
    sessionId: 'not-a-paper-session'
  };
  const h = createHarness({
    targetCoins: ['KRW-XRP', 'KRW-BTC'],
    getPaperValidationConfigSnapshot: () => snapshot
  }, {
    env: {
      SCALP_RSI_PERIOD: '14',
      SCALP_INVESTMENT_RATIO: '0.02',
      SCALP_VALIDATION_MARKETS: 'KRW-ETH',
      SCALP_VALIDATION_CANDLE_UNIT: '1',
      SCALP_VALIDATION_CANDLES_FILE: 'stale-cache.json',
      SCALP_VALIDATION_CONFIG_SNAPSHOT_FILE: 'user-owned-paper-ledger.json'
    }
  });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  h.refresher.requestRefresh('current_preset');
  const pending = h.refresher.tick();
  assert.equal(h.children.length, 1);
  try {
    const env = h.children[0].opts.env;
    assert.equal(env.SCALP_VALIDATION_MARKETS, 'KRW-XRP,KRW-BTC');
    assert.equal(env.SCALP_VALIDATION_CANDLE_UNIT, '3');
    assert.equal(env.SCALP_ENTRY_DELAY_MIN_MS, '1500');
    assert.equal(env.SCALP_ENTRY_DELAY_MAX_MS, '3500');
    assert.equal(env.SCALP_MAX_CANDLE_AGE_SECONDS, '180');
    assert.equal(env.SCALP_MAX_RISK_DATA_GAP_SECONDS, '20');
    assert.equal(env.SCALP_MAX_ANALYSIS_DATA_GAP_SECONDS, '45');
    assert.equal(env.SCALP_VALIDATION_CANDLES_FILE, undefined);
    assert.notEqual(env.SCALP_VALIDATION_CONFIG_SNAPSHOT_FILE, 'user-owned-paper-ledger.json');
    const file = env.SCALP_VALIDATION_CONFIG_SNAPSHOT_FILE;
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.sourceType, 'runtime_config_snapshot');
    assert.deepEqual(raw.targetCoins, ['KRW-XRP', 'KRW-BTC']);
    assert.deepEqual(Object.keys(raw.configSnapshot).sort(), [...LIVE_GATE_COMPARABLE_KEYS].sort());
    assert.doesNotMatch(JSON.stringify(raw), /must-not-copy|not-a-paper-session/);
    const loaded = loadPaperValidationConfigSnapshot(file);
    assert.equal(loaded.sourceType, 'runtime_config_snapshot');
    assert.equal(loaded.sessionId, null);
    assert.equal(mergePaperValidationConfig({ rsiPeriod: 14, investmentRatio: 0.02 }, loaded, 3).rsiPeriod, 7);
    assert.equal(loaded.config.investmentRatio, 0.15);
    const cacheFile = path.join(h.root, 'synthetic-candles.json');
    const candles = [0, 3].map(minute => ({
      candle_date_time_utc: new Date(Date.UTC(2026, 9, 5, 10, minute)).toISOString(),
      trade_price: 100,
      opening_price: 100,
      high_price: 100,
      low_price: 100,
      candle_acc_trade_volume: 1
    }));
    fs.writeFileSync(cacheFile, JSON.stringify({ 'KRW-XRP': candles, 'KRW-BTC': candles }));
    const networkGuard = path.join(h.root, 'offline-fixture.cjs');
    fs.writeFileSync(networkGuard, [
      "const denyNetwork = () => { throw new Error('Network is disabled in the runtime snapshot fixture'); };",
      "for (const name of ['node:http', 'node:https']) {",
      '  const transport = require(name);',
      '  transport.request = denyNetwork;',
      '  transport.get = denyNetwork;',
      '}',
      'globalThis.fetch = denyNetwork;'
    ].join('\n'));
    const cli = spawnSync(process.execPath, ['--require', networkGuard, ...h.children[0].args], {
      cwd: h.root,
      env: { ...env, SCALP_VALIDATION_CANDLES_FILE: cacheFile, NODE_ENV: 'test' },
      encoding: 'utf8',
      // This checks configuration equivalence, not startup performance. Allow
      // module loading on the shared build host; network access is disabled.
      timeout: 60_000
    });
    assert.equal(cli.status, 0, JSON.stringify({
      errorCode: cli.error?.code,
      signal: cli.signal,
      stdout: cli.stdout,
      stderr: cli.stderr
    }));
    const report = JSON.parse(fs.readFileSync(h.reportFile, 'utf8'));
    assert.equal(report.configSource.type, 'runtime_config_snapshot');
    assert.equal(report.configSource.sessionId, null);
    assert.deepEqual(report.markets, ['KRW-XRP', 'KRW-BTC']);
    for (const key of LIVE_GATE_COMPARABLE_KEYS) assert.equal(report.config[key], snapshot[key], key);
    assert.doesNotMatch(cli.stdout, /paper snapshot|session unknown/);
    snapshot.rsiPeriod = 21;
    assert.equal(loaded.config.rsiPeriod, 7, 'the child input is immutable after capture');
    h.closeLast(0);
    await pending;
    assert.equal(fs.existsSync(file), false);
  } finally {
    if (h.refresher.getStatus().running) h.closeLast(0);
    await pending;
  }
});

test('each refresh captures changed runtime settings into a new transient file', async t => {
  const h = createHarness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  h.refresher.requestRefresh('first');
  let pending = h.refresher.tick();
  const first = h.children[0].opts.env.SCALP_VALIDATION_CONFIG_SNAPSHOT_FILE;
  h.closeLast(0);
  await pending;
  assert.equal(fs.existsSync(first), false);

  const initialSnapshot = h.trader.getPaperValidationConfigSnapshot();
  h.trader.getPaperValidationConfigSnapshot = () => ({ ...initialSnapshot, rsiPeriod: 21 });
  h.trader.targetCoins = ['KRW-XRP'];
  h.advance(31 * 60 * 1000);
  h.refresher.requestRefresh('changed');
  pending = h.refresher.tick();
  try {
    const second = h.children[1].opts.env.SCALP_VALIDATION_CONFIG_SNAPSHOT_FILE;
    assert.notEqual(second, first);
    assert.equal(loadPaperValidationConfigSnapshot(second).config.rsiPeriod, 21);
    assert.equal(h.children[1].opts.env.SCALP_VALIDATION_MARKETS, 'KRW-XRP');
  } finally {
    h.closeLast(0);
    await pending;
  }
});

test('unwritable snapshot storage prevents child spawn and backs off', async t => {
  const h = createHarness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  h.refresher._snapshotTempRoot = path.join(h.root, 'missing-parent');
  h.refresher.requestRefresh('write_failure');
  await h.refresher.tick();
  assert.equal(h.children.length, 0);
  assert.equal(h.refresher.getStatus().lastError, 'runtime_validation_snapshot_unavailable');
  h.refresher.requestRefresh('retry');
  h.advance(1000);
  await h.refresher.tick();
  assert.equal(h.refresher.getStatus().runCount, 1);
});

test('a captured snapshot that cannot be read prevents child spawn and is removed', async t => {
  const h = createHarness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const readFile = fs.readFileSync;
  let capturedFile;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (String(file).endsWith('/runtime-config.json')) {
      capturedFile = file;
      throw new Error('snapshot read failed');
    }
    return readFile(file, ...args);
  });
  h.refresher.requestRefresh('read_failure');
  await h.refresher.tick();
  assert.equal(h.children.length, 0);
  assert.equal(h.refresher.getStatus().lastError, 'runtime_validation_snapshot_unavailable');
  assert.equal(fs.existsSync(capturedFile), false);
});

test('incomplete or unavailable current config and unresolved markets prevent refresh spawn with backoff', async t => {
  const fixtures = [
    { getPaperValidationConfigSnapshot: undefined },
    { getPaperValidationConfigSnapshot: () => ({ rsiPeriod: 14 }) },
    { getPaperValidationConfigSnapshot: () => { throw new Error('cannot read runtime state'); } },
    { targetCoins: 'ALL' },
    { targetCoins: [] }
  ];
  for (const overrides of fixtures) {
    const h = createHarness(overrides);
    t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
    h.refresher.requestRefresh('invalid_current_config');
    const pending = h.refresher.tick();
    try {
      assert.equal(h.children.length, 0);
    } finally {
      if (h.children.length) h.closeLast(0);
      await pending;
    }
    assert.equal(h.refresher.getStatus().running, false);
    assert.equal(h.refresher.getStatus().lastError, 'runtime_validation_snapshot_unavailable');
    h.refresher.requestRefresh('retry');
    h.advance(1000);
    await h.refresher.tick();
    assert.equal(h.refresher.getStatus().runCount, 1);
  }
});

test('refresh removes only its snapshot on child error or spawn failure', async t => {
  for (const failure of ['child_error', 'spawn_failure']) {
    let capturedFile;
    const h = createHarness({}, failure === 'spawn_failure' ? {
      spawn: (cmd, args, opts) => {
        capturedFile = opts.env.SCALP_VALIDATION_CONFIG_SNAPSHOT_FILE;
        throw new Error('spawn denied');
      }
    } : {});
    t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
    const userFile = path.join(h.root, 'user-input.json');
    fs.writeFileSync(userFile, 'user data');
    h.refresher._env.SCALP_VALIDATION_CONFIG_SNAPSHOT_FILE = userFile;
    h.refresher.requestRefresh('error_cleanup');
    const pending = h.refresher.tick();
    if (failure === 'child_error') {
      capturedFile = h.children[0].opts.env.SCALP_VALIDATION_CONFIG_SNAPSHOT_FILE;
      h.children[0].child.emit('error', new Error('child launch failed'));
    }
    await pending;
    assert.equal(typeof capturedFile, 'string');
    assert.equal(fs.existsSync(capturedFile), false);
    assert.equal(fs.readFileSync(userFile, 'utf8'), 'user data');
  }
});
