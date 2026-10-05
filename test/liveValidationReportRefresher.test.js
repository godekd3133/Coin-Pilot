import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
  for (const overrides of [{ dryRun: true }, { isScalpingMode: false }]) {
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
