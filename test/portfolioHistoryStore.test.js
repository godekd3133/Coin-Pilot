import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import PortfolioHistoryStore, {
  PortfolioHistoryFormatError,
  PORTFOLIO_HISTORY_RETENTION_LIMIT
} from '../src/api/portfolioHistoryStore.js';

function createHistoryStore(t, { retentionLimit } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-portfolio-history-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    filePath: path.join(directory, 'nested', 'portfolio-history.json'),
    createStore(filePath = path.join(directory, 'nested', 'portfolio-history.json'), options = {}) {
      return new PortfolioHistoryStore({ filePath, retentionLimit, ...options });
    }
  };
}

test('portfolio history store creates its local JSON file with an atomic replacement', t => {
  const { directory, filePath, createStore } = createHistoryStore(t);
  const store = createStore();
  const history = [{ timestamp: '2026-09-29T00:00:00.000Z', totalAssets: 1000 }];

  assert.deepEqual(store.readAll(), []);
  assert.equal(store.write(history), 1);
  assert.deepEqual(store.readAll(), history);
  assert.deepEqual(fs.readdirSync(path.dirname(filePath)), ['portfolio-history.json']);
  assert.equal(fs.existsSync(directory), true);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  }
});

test('portfolio history store keeps only the newest 8640 records', t => {
  const { filePath, createStore } = createHistoryStore(t);
  const store = createStore();
  const priorHistory = Array.from({ length: PORTFOLIO_HISTORY_RETENTION_LIMIT }, (_, index) => ({ index }));
  const latest = { index: PORTFOLIO_HISTORY_RETENTION_LIMIT };

  assert.equal(store.write([...priorHistory, latest]), PORTFOLIO_HISTORY_RETENTION_LIMIT);
  const persisted = store.readAll();
  assert.equal(persisted.length, PORTFOLIO_HISTORY_RETENTION_LIMIT);
  assert.deepEqual(persisted[0], { index: 1 });
  assert.deepEqual(persisted.at(-1), latest);
  assert.deepEqual(fs.readdirSync(path.dirname(filePath)), ['portfolio-history.json']);
});

test('portfolio history projection keeps recent records and labels missing legacy valuation status', t => {
  const { filePath, createStore } = createHistoryStore(t);
  const store = createStore();
  const now = Date.parse('2026-09-29T12:00:00.000Z');
  const history = [
    { timestamp: '2026-09-20T12:00:00.000Z', totalAssets: 800 },
    { timestamp: '2026-09-29T11:59:00.000Z', totalAssets: 900 },
    {
      timestamp: '2026-09-29T11:59:30.000Z',
      capturedAt: '2026-09-29T11:59:30.000Z',
      valuationAsOf: '2026-09-29T11:59:25.000Z',
      valuationStatus: 'available',
      totalAssets: 1000
    },
    { timestamp: 'not-a-timestamp', totalAssets: 1200 }
  ];
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(history), 'utf8');

  const result = store.readPeriod('7d', { now });
  assert.equal(result.period, '7d');
  assert.equal(result.count, 2);
  assert.deepEqual(result.data[0], {
    timestamp: '2026-09-29T11:59:00.000Z',
    totalAssets: 900,
    valuationStatus: 'unknown_legacy'
  });
  assert.deepEqual(result.data[1], history[2]);
});

test('portfolio history store applies the history endpoint 100-point sampling limit', t => {
  const { filePath, createStore } = createHistoryStore(t);
  const store = createStore();
  const now = Date.parse('2026-09-29T12:00:00.000Z');
  const history = Array.from({ length: 120 }, (_, index) => ({
    timestamp: new Date(now - ((120 - index) * 1000)).toISOString(),
    totalAssets: index
  }));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(history), 'utf8');

  const result = store.readPeriod('24h', { now });
  assert.equal(result.count, 60);
  assert.equal(result.data[0].totalAssets, 0);
  assert.equal(result.data.at(-1).totalAssets, 118);
});

test('portfolio history store distinguishes invalid JSON shape from a parse error', t => {
  const { filePath, createStore } = createHistoryStore(t);
  const store = createStore();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  fs.writeFileSync(filePath, JSON.stringify({ snapshots: [] }), 'utf8');
  assert.throws(() => store.readAll(), PortfolioHistoryFormatError);

  fs.writeFileSync(filePath, '{broken json', 'utf8');
  assert.throws(() => store.readAll(), SyntaxError);
});

test('portfolio history store preserves the old file and removes a temp file when atomic rename fails', t => {
  const { filePath, createStore } = createHistoryStore(t);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const initialHistory = [{ timestamp: '2026-09-29T00:00:00.000Z', totalAssets: 1000 }];
  fs.writeFileSync(filePath, JSON.stringify(initialHistory, null, 2), 'utf8');
  const fileSystem = {
    existsSync: (...args) => fs.existsSync(...args),
    readFileSync: (...args) => fs.readFileSync(...args),
    mkdirSync: (...args) => fs.mkdirSync(...args),
    openSync: (...args) => fs.openSync(...args),
    fchmodSync: (...args) => fs.fchmodSync(...args),
    writeFileSync: (...args) => fs.writeFileSync(...args),
    fsyncSync: (...args) => fs.fsyncSync(...args),
    closeSync: (...args) => fs.closeSync(...args),
    renameSync() {
      throw new Error('rename failed');
    },
    rmSync: (...args) => fs.rmSync(...args)
  };
  const store = createStore(filePath, { fileSystem });

  assert.throws(() => store.write([{ timestamp: '2026-09-29T00:01:00.000Z', totalAssets: 1200 }]), /rename failed/);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), initialHistory);
  assert.deepEqual(fs.readdirSync(path.dirname(filePath)), ['portfolio-history.json']);
});

test('portfolio history store preserves old history and cleans up when syncing the replacement fails', t => {
  const { filePath, createStore } = createHistoryStore(t);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const initialHistory = [{ timestamp: '2026-09-29T00:00:00.000Z', totalAssets: 1000 }];
  fs.writeFileSync(filePath, JSON.stringify(initialHistory, null, 2), 'utf8');
  const fileSystem = {
    existsSync: (...args) => fs.existsSync(...args),
    readFileSync: (...args) => fs.readFileSync(...args),
    mkdirSync: (...args) => fs.mkdirSync(...args),
    openSync: (...args) => fs.openSync(...args),
    fchmodSync: (...args) => fs.fchmodSync(...args),
    writeFileSync: (...args) => fs.writeFileSync(...args),
    fsyncSync() {
      throw new Error('fsync failed');
    },
    closeSync: (...args) => fs.closeSync(...args),
    renameSync: (...args) => fs.renameSync(...args),
    rmSync: (...args) => fs.rmSync(...args)
  };
  const store = createStore(filePath, { fileSystem });

  assert.throws(
    () => store.write([{ timestamp: '2026-09-29T00:01:00.000Z', totalAssets: 1200 }]),
    /fsync failed/
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), initialHistory);
  assert.deepEqual(fs.readdirSync(path.dirname(filePath)), ['portfolio-history.json']);
});
