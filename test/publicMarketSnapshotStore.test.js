import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  PUBLIC_MARKET_SNAPSHOT_SCHEMA,
  PublicMarketSnapshotStore
} from '../src/api/publicMarketSnapshotStore.js';

function createRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-public-market-snapshot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('public quote snapshots persist whitelisted rows and restore last-good metadata after recreation', async t => {
  const root = createRoot(t);
  const filePath = path.join(root, 'market_snapshot.json');
  const now = Date.now();
  const store = new PublicMarketSnapshotStore({ filePath, now: () => now, persistIntervalMs: 60_000 });
  assert.equal(store.recordTickers([
    {
      market: 'KRW-BTC',
      trade_price: 100,
      trade_timestamp: now - 1_000,
      signed_change_rate: 0.01,
      acc_trade_price_24h: 1000,
      access_key: 'must-not-be-saved'
    },
    { market: 'KRW-ETH', trade_price: 200, trade_timestamp: now - 2_000 }
  ], now), true);
  await store.flush();

  const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(persisted.schema, PUBLIC_MARKET_SNAPSHOT_SCHEMA);
  assert.equal(persisted.tickers.length, 2);
  assert.equal(JSON.stringify(persisted).includes('must-not-be-saved'), false);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);

  const restarted = new PublicMarketSnapshotStore({ filePath, now: () => now + 5_000 });
  const snapshot = restarted.getTickerSnapshot(['KRW-ETH', 'KRW-BTC']);
  assert.deepEqual(snapshot.tickers.map(row => row.market), ['KRW-ETH', 'KRW-BTC']);
  assert.equal(snapshot.snapshotSource, 'last_good');
  assert.equal(snapshot.tickers[1].trade_price, 100);
  assert.equal(snapshot.tickers[1].fetchedAt, new Date(now).toISOString());
  assert.equal(snapshot.fetchedAtByMarket['KRW-BTC'], new Date(now).toISOString());
  assert.equal(snapshot.fetchedAt, new Date(now).toISOString());
  await restarted.close();
  await store.close();
});

test('public snapshots merge markets and never replace a newer source quote with an older row', async t => {
  const root = createRoot(t);
  const filePath = path.join(root, 'market_snapshot.json');
  const now = Date.now();
  const store = new PublicMarketSnapshotStore({ filePath, now: () => now, persistIntervalMs: 60_000 });
  store.recordTickers([
    { market: 'KRW-BTC', trade_price: 100, trade_timestamp: now - 1_000 },
    { market: 'KRW-ETH', trade_price: 200, trade_timestamp: now - 3_000 }
  ], now);
  await store.flush();

  store.recordTickers([
    { market: 'KRW-BTC', trade_price: 90, trade_timestamp: now - 2_000 },
    { market: 'KRW-ETH', trade_price: 210, trade_timestamp: now - 500 }
  ], now + 1_000);
  await store.flush();

  const snapshot = store.getTickerSnapshot(['KRW-BTC', 'KRW-ETH']);
  assert.deepEqual(snapshot.tickers.map(row => row.trade_price), [100, 210]);
  assert.equal(snapshot.tickers[0].fetchedAt, new Date(now).toISOString());
  assert.equal(snapshot.tickers[1].fetchedAt, new Date(now + 1_000).toISOString());
  assert.equal(snapshot.fetchedAt, new Date(now).toISOString());
  await store.close();
});

test('malformed snapshot files fail closed and read-only observers never replace them', async t => {
  const root = createRoot(t);
  const filePath = path.join(root, 'market_snapshot.json');
  const original = '{broken snapshot';
  fs.writeFileSync(filePath, original, { mode: 0o600 });
  const store = new PublicMarketSnapshotStore({ filePath, readOnly: true });

  assert.equal(store.getTickerSnapshot(['KRW-BTC']), null);
  assert.equal(store.getStatus().loadHealthy, false);
  assert.equal('loadError' in store.getStatus(), false, 'readiness data must not expose filesystem diagnostics');
  assert.equal(store.recordTickers([
    { market: 'KRW-BTC', trade_price: 100, trade_timestamp: Date.now() }
  ]), false);
  await store.flush();
  assert.equal(fs.readFileSync(filePath, 'utf8'), original);
  await store.close();
});

test('public snapshot size and market-count bounds reject invalid writer options', t => {
  const root = createRoot(t);
  assert.throws(() => new PublicMarketSnapshotStore({
    filePath: path.join(root, 'invalid.json'),
    maxMarkets: 0
  }), /maxMarkets/);
  assert.throws(() => new PublicMarketSnapshotStore({
    filePath: path.join(root, 'invalid.json'),
    persistIntervalMs: -1
  }), /persistIntervalMs/);
});
