import test from 'node:test';
import assert from 'node:assert/strict';
import { OperatorAlertMonitor, startOfKstDay, kstDateKey } from '../src/api/operatorAlertMonitor.js';
import { OrderPushService, describePushEvent } from '../src/api/orderPushService.js';

function makeTrader({ running = true, protective = false, stopReason = null, positions = {}, history = [] } = {}) {
  const strategies = new Map(Object.entries(positions).map(([coin, position]) => [coin, { currentPosition: position, tradeHistory: [] }]));
  if (history.length) strategies.set('KRW-HIST', { currentPosition: null, tradeHistory: history });
  return {
    dryRun: true,
    isRunning: running,
    strategies,
    state: { running, protective, stopReason },
    getRuntimeSafetyStatus() {
      return { runtimeState: this.state.protective ? 'PROTECTIVE_ONLY' : this.state.running ? 'RUNNING' : 'STOPPED',
        stopReason: this.state.stopReason, autoRecovery: { armed: this.state.stopReason === 'risk_data_gap' } };
    },
    calculateTotalAssets: async () => 10_050_000
  };
}

function setup(trader, startMs) {
  const clock = { value: startMs };
  const push = new OrderPushService({ file: null, mode: 'DRY_RUN', now: () => clock.value });
  const monitor = new OperatorAlertMonitor({ tradingSystem: trader, push, now: () => clock.value, logger: { error() {} } });
  return { clock, push, monitor, alerts: () => push.state.events.map(event => event.alert) };
}

test('KST day boundary does not depend on the host timezone', () => {
  const ms = Date.parse('2026-11-05T14:59:00Z'); // 23:59 KST
  assert.equal(new Date(startOfKstDay(ms)).toISOString(), '2026-11-04T15:00:00.000Z');
  assert.equal(kstDateKey(ms), '2026-11-05');
  assert.equal(kstDateKey(Date.parse('2026-11-05T15:00:00Z')), '2026-11-06');
});

test('a safety stop, the held-while-stopped reminder, and the resume each push once', async () => {
  const trader = makeTrader({ positions: { 'KRW-SOL': { amount: 1, entryPrice: 200000 } } });
  const { clock, monitor, alerts } = setup(trader, Date.parse('2026-11-05T01:00:00Z'));
  await monitor.tick();
  assert.equal(alerts().length, 0);

  trader.isRunning = false;
  trader.state = { running: false, protective: false, stopReason: 'risk_data_gap' };
  clock.value += 30000;
  await monitor.tick();
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0].title, /자동매매 정지/);
  assert.match(alerts()[0].body, /시세를 30초 넘게/);
  assert.match(alerts()[0].body, /SOL/);
  assert.match(alerts()[0].body, /자동으로 다시 시작/);

  clock.value += 31 * 60 * 1000;
  await monitor.tick();
  assert.equal(alerts().length, 2);
  assert.match(alerts()[1].title, /멈춘 채 포지션 보유 중/);
  clock.value += 60 * 60 * 1000;
  await monitor.tick();
  assert.equal(alerts().length, 2, 'the reminder repeats only every 6 hours');
  clock.value += 6 * 60 * 60 * 1000;
  await monitor.tick();
  assert.equal(alerts().length, 3);

  trader.isRunning = true;
  trader.state = { running: true, protective: false, stopReason: null };
  clock.value += 30000;
  await monitor.tick();
  assert.match(alerts().at(-1).title, /자동매매 재개/);
});

test('the first start after boot is reported as a start, not a resume', async () => {
  const trader = makeTrader({ running: false });
  const { clock, monitor, alerts } = setup(trader, Date.parse('2026-11-05T01:00:00Z'));
  await monitor.tick();
  trader.isRunning = true;
  trader.state = { running: true, protective: false, stopReason: null };
  clock.value += 30000;
  await monitor.tick();
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0].title, /자동매매 시작/);
});

test('protective mode is announced instead of a plain stop and reminds only when exits stall', async () => {
  const trader = makeTrader({ positions: { 'KRW-BTC': { amount: 0.001, entryPrice: 100000000 } } });
  const { clock, monitor, alerts } = setup(trader, Date.parse('2026-11-05T01:00:00Z'));
  await monitor.tick();
  trader.isRunning = false;
  trader.state = { running: false, protective: true, stopReason: 'analysis_data_gap' };
  clock.value += 30000;
  await monitor.tick();
  clock.value += 40 * 60 * 1000;
  await monitor.tick();
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0].title, /보호 모드/);
  clock.value += 30 * 60 * 1000;
  await monitor.tick();
  assert.equal(alerts().length, 2);
  assert.match(alerts()[1].body, /보호 모드로 \d+분째 감시 중/);
});

test('the daily summary goes out once after 22:00 KST with KST-day realized P&L', async () => {
  const dayStart = Date.parse('2026-11-04T15:00:00Z');
  const trader = makeTrader({
    history: [
      { action: 'OPEN', entryTime: new Date(dayStart + 3600000).toISOString() },
      { action: 'CLOSE', exitTime: new Date(dayStart + 7200000).toISOString(), profit: 1200 },
      { action: 'CLOSE', exitTime: new Date(dayStart + 7300000).toISOString(), profit: -200 },
      { action: 'CLOSE', exitTime: new Date(dayStart - 1000).toISOString(), profit: 99999 }
    ]
  });
  const { clock, monitor, alerts } = setup(trader, dayStart + 21 * 3600000);
  await monitor.tick();
  assert.equal(alerts().length, 0);
  clock.value = dayStart + 22 * 3600000 + 1000;
  await monitor.tick();
  await monitor.tick();
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0].title, /오늘 요약 \(11\/05\)/);
  assert.match(alerts()[0].body, /\+1,000원/);
  assert.match(alerts()[0].body, /매수 1건 · 매도 2건\(이익 1건\)/);
  assert.match(alerts()[0].body, /총자산 10,050,000원/);
});

test('fill pushes carry price, P&L and the exit reason', () => {
  const text = describePushEvent({ trade: { type: 'SELL', coin: 'KRW-XRP', mode: 'LIVE', price: 812.5, profitPercent: -1.234, profitAmount: -64.2, reason: '스캘핑 손절' } });
  assert.equal(text.title, '실거래 · XRP 매도');
  assert.equal(text.body, '812.5원에 매도 · -1.23% (-64.2원) · 스캘핑 손절');
  const buy = describePushEvent({ trade: { type: 'BUY', coin: 'KRW-BTC', mode: 'DRY_RUN', price: 100000000, amount: 5200 } });
  assert.equal(buy.body, '100,000,000원에 매수 · 5,200원 투자');
});
