import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OrderPushService, manualTradeNotifications } from '../src/api/orderPushService.js';
import { AutoRecoverySupervisor, readAutomationIntent } from '../src/runtime/autoRecoverySupervisor.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-push-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const device = { deviceId: '12345678-1234-1234-1234-123456789abc', token: 'a'.repeat(64), environment: 'production' };
const trade = { type: 'BUY', coin: 'KRW-BTC', mode: 'LIVE', orderId: 'exchange-order-1', volume: 0.01, price: 100 };

test('registered device and pending order survive restart; accepted order is not sent twice', async t => {
  const file = path.join(fixture(t), 'push.json');
  const first = new OrderPushService({ file, mode: 'LIVE' });
  first.register(device);
  const id = first.enqueue(trade);
  assert.equal(first.enqueue(trade), id);
  let sent = 0;
  const restarted = new OrderPushService({ file, mode: 'LIVE', sender: async () => { sent++; return { status: 200 }; } });
  await restarted.flush();
  await restarted.flush();
  assert.equal(sent, 1);
  assert.equal(restarted.summary().accepted, 1);
  assert.equal(new OrderPushService({ file, mode: 'LIVE' }).summary().queued, 0);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('temporary APNs failure is queued and retried after restart, while invalid tokens are disabled', async t => {
  const file = path.join(fixture(t), 'push.json');
  let now = Date.now();
  const first = new OrderPushService({ file, mode: 'LIVE', now: () => now, sender: async () => ({ status: 503 }) });
  first.register(device); first.enqueue(trade); await first.flush();
  assert.equal(first.summary().queued, 1);
  now += 60000;
  const retry = new OrderPushService({ file, mode: 'LIVE', now: () => now, sender: async () => ({ status: 410, reason: 'Unregistered' }) });
  await retry.flush();
  assert.equal(retry.summary().queued, 0);
  assert.equal(retry.summary().registeredDevices, 0);
});

test('APNs awaiting a response does not overwrite newly queued orders or refreshed device tokens', async t => {
  const file = path.join(fixture(t), 'push.json');
  let release;
  const push = new OrderPushService({ file, mode: 'LIVE', sender: () => new Promise(resolve => { release = resolve; }) });
  push.register(device); push.enqueue(trade);
  const sending = push.flush();
  push.register({ ...device, token: 'b'.repeat(64) });
  push.enqueue({ ...trade, orderId: 'exchange-order-2' });
  release({ status: 200 });
  await sending;
  assert.equal(push.state.devices[device.deviceId].token, 'b'.repeat(64));
  assert.equal(push.state.events.length, 2);
  assert.equal(push.summary().queued, 1);
});

test('only observed manual live fills notify; an idempotency retry has the same event ID', () => {
  const request = { path: '/trade/buy', body: {}, get: () => 'same-key' };
  assert.deepEqual(manualTradeNotifications({ success: true, coin: 'KRW-BTC', fill: { status: 'not_observed' } }, request, 'LIVE'), []);
  const body = { success: true, coin: 'KRW-BTC', fill: { status: 'filled', orderId: 'live-fill-1', executedVolume: 1, averagePrice: 10 } };
  assert.equal(manualTradeNotifications(body, request, 'LIVE')[0].orderId, 'live-fill-1');
  assert.equal(manualTradeNotifications(body, request, 'LIVE')[0].eventId, manualTradeNotifications(body, request, 'LIVE')[0].eventId);
  assert.deepEqual(manualTradeNotifications({ success: false, coin: 'KRW-BTC', volume: 1 }, request, 'DRY_RUN'), []);
  assert.equal(manualTradeNotifications({ success: true, coin: 'KRW-BTC', volume: 1 }, request, 'DRY_RUN').length, 1);
});

test('Paper and LIVE notifications cannot cross profile stores', t => {
  const file = path.join(fixture(t), 'push.json');
  const paper = new OrderPushService({ file, mode: 'DRY_RUN' });
  paper.register(device);
  assert.equal(paper.enqueue(trade), null);
  paper.enqueue({ ...trade, mode: 'DRY_RUN' });
  assert.throws(() => new OrderPushService({ file, mode: 'LIVE' }), /알림 기록/);
});

test('last explicit ON overrides boot-OFF; last explicit OFF overrides boot-ON after restart', t => {
  const file = path.join(fixture(t), 'intent.json');
  const trader = { dryRun: true, strategies: new Map(), targetCoins: [], isRunning: false };
  const first = new AutoRecoverySupervisor(trader, { intentFile: file });
  first.noteDesiredRunning(true, 'control_start', { requirePersistence: true });
  const on = new AutoRecoverySupervisor(trader, { intentFile: file });
  assert.equal(on.resolveBootIntent(false), true);
  on.stop();
  assert.equal(readAutomationIntent(file).desiredRunning, true, 'process shutdown must not change the user preference');
  on.noteDesiredRunning(false, 'control_stop', { requirePersistence: true });
  const off = new AutoRecoverySupervisor(trader, { intentFile: file });
  assert.equal(off.resolveBootIntent(true), false);
  assert.equal(off.tracking.state.events.at(-1).type, 'restart');
});

test('failed durable ON write never arms a future automatic start', t => {
  const root = fixture(t);
  const file = path.join(root, 'intent.json');
  fs.mkdirSync(file);
  const supervisor = new AutoRecoverySupervisor({ strategies: new Map(), isRunning: false }, { intentFile: file });
  assert.throws(() => supervisor.noteDesiredRunning(true, 'control_start', { requirePersistence: true }));
  assert.equal(supervisor.getStatus().desiredRunning, false);
  assert.throws(() => supervisor.resolveBootIntent(true), /읽을 수 없어/);
});

test('restart restores historical LIVE risk counters without restoring quote freshness or pending executable positions', t => {
  const file = path.join(fixture(t), 'intent.json');
  const strategy = { cooldownUntil: Date.now() + 60000, consecutiveLosses: 2, tradeHistory: [{ action: 'CLOSE', profit: -10 }] };
  const first = new AutoRecoverySupervisor({ dryRun: false, strategies: new Map([['KRW-BTC', strategy]]), isRunning: false,
    lossCircuitBreaker: { losses: [] } }, { intentFile: file });
  first.noteDesiredRunning(false);
  const restored = {};
  const trader = { dryRun: false, strategies: new Map(), isRunning: false, getStrategy: () => restored };
  new AutoRecoverySupervisor(trader, { intentFile: file });
  assert.equal(restored.consecutiveLosses, 2);
  assert.equal(restored.cooldownUntil, strategy.cooldownUntil);
  assert.equal(restored.currentPosition, undefined);
  assert.equal(trader.analysisDataHealthState, undefined);
});
