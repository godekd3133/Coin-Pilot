import test from 'node:test';
import assert from 'node:assert/strict';
import { EngineActivityTracker } from '../src/api/engineActivity.js';

test('engine activity counts one BUY signal per market per minute over the last hour', () => {
  const clock = { value: Date.parse('2026-11-05T02:00:10Z') };
  const tracker = new EngineActivityTracker({ now: () => clock.value });
  const cycle = (iso, analyses) => tracker.ingestCycle({ timestamp: iso, analyses });
  cycle('2026-11-05T01:00:05Z', [{ coin: 'KRW-OLD', decision: { action: 'BUY' } }]);
  cycle('2026-11-05T02:00:01Z', [{ coin: 'KRW-A', decision: { action: 'BUY' } }, { coin: 'KRW-B', decision: { action: 'HOLD' }, inactiveMarket: 'market_quote_quiet' }]);
  cycle('2026-11-05T02:00:06Z', [{ coin: 'KRW-A', decision: { action: 'BUY' } }, { coin: 'KRW-B', decision: { action: 'HOLD' } }]);
  const trader = {
    dryRun: false,
    _lastSyncTime: Date.parse('2026-11-05T01:56:00Z'),
    strategies: new Map([['KRW-A', { tradeHistory: [
      { action: 'OPEN', entryTime: '2026-11-05T01:30:00Z' },
      { action: 'OPEN', entryTime: '2026-11-05T00:30:00Z' }
    ] }]])
  };
  const status = tracker.getStatus(trader);
  assert.equal(status.lastCycleAt, '2026-11-05T02:00:06.000Z');
  assert.equal(status.lastCycleMarkets, 2);
  assert.equal(status.signalsLastHour, 1, 'the 01:00 signal aged out and the repeated A counts once');
  assert.equal(status.entriesLastHour, 1);
  assert.equal(status.lastExchangeSyncAt, '2026-11-05T01:56:00.000Z');
  assert.equal(tracker.getStatus({ ...trader, dryRun: true }).lastExchangeSyncAt, null);
});
