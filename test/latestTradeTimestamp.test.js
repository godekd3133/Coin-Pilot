import test from 'node:test';
import assert from 'node:assert/strict';
import { latestTradeTimestamp } from '../src/api/latestTradeTimestamp.js';

test('system status includes direct and strategy trades rather than only smart orders', () => {
  const system = { smartTradeHistory: [{ timestamp: '2026-10-08T01:00:00Z' }], strategies: new Map([
    ['KRW-BTC', { getTradeHistory: limit => {
      assert.equal(limit, 100);
      return [{ action: 'OPEN', entryTime: new Date('2026-10-08T03:00:00Z') }];
    } }],
    ['KRW-ETH', { getTradeHistory: () => [{ action: 'CLOSE', type: 'BUY', entryTime: '2026-10-01T00:00:00Z', exitTime: '2026-10-08T04:00:00Z' }] }]
  ]) };
  assert.equal(latestTradeTimestamp(system), '2026-10-08T04:00:00.000Z');
});
test('partial closes use their exit event and explicit timestamps remain authoritative', () => {
  assert.equal(latestTradeTimestamp({ strategy: { getTradeHistory: () => [
    { action: 'PARTIAL_CLOSE', entryTime: '2026-10-01T00:00:00Z', exitTime: '2026-10-09T00:00:00Z' },
    { type: 'SELL', timestamp: '2026-10-09T01:00:00Z', exitTime: '2026-10-08T00:00:00Z' }
  ] } }), '2026-10-09T01:00:00.000Z');
});
test('smart and bundle trades can be newer than strategy records', () => {
  assert.equal(latestTradeTimestamp({ smartTradeHistory: [{ type: 'BUNDLE_TRADE', timestamp: '2026-10-09T04:00:00Z' }], strategies: new Map([
    ['KRW-BTC', { getTradeHistory: () => [{ action: 'OPEN', entryTime: '2026-10-08T02:00:00Z' }] }]
  ]) }), '2026-10-09T04:00:00.000Z');
});
test('empty and invalid histories do not invent a trading time', () => {
  assert.equal(latestTradeTimestamp(), null);
  assert.equal(latestTradeTimestamp({ smartTradeHistory: [null, {}, { timestamp: 'bad' }, { timestamp: true }] }), null);
});

test('system-status response exposes the newest strategy trade through the actual route', async t => {
  const [{ default: express }, { default: createStatusRoutes }, { mkdtemp, rm }, { tmpdir }, { join }, { once }] = await Promise.all([
    import('express'), import('../src/api/routes/status.js'), import('node:fs/promises'),
    import('node:os'), import('node:path'), import('node:events')
  ]);
  const logDir = await mkdtemp(join(tmpdir(), 'coinpilot-status-read-'));
  const app = express();
  app.use(createStatusRoutes({
    tradingSystem: { dryRun: true, isRunning: false, config: { checkInterval: 5000 }, targetCoins: ['KRW-BTC'],
      strategies: new Map([['KRW-BTC', { getTradeHistory: () => [{ action: 'CLOSE', entryTime: '2026-10-08T01:00:00Z', exitTime: '2026-10-09T02:00:00Z' }] }]]) },
    logger: { logDir }, getActiveHoldings: () => new Map()
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(logDir, { recursive: true, force: true }); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/system-status`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, 'DRY_RUN');
  assert.equal(body.lastTradeTime, '2026-10-09T02:00:00.000Z');
});
