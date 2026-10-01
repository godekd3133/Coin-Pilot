import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const PUBLIC_MARKET_SNAPSHOT_SCHEMA = 'coinpilot.public-market-snapshot.v1';
export const PUBLIC_MARKET_SNAPSHOT_MAX_MARKETS = 1_000;
export const PUBLIC_MARKET_SNAPSHOT_PERSIST_INTERVAL_MS = 5_000;
const MAX_PUBLIC_MARKET_SNAPSHOT_FILE_BYTES = 2 * 1024 * 1024;

const MARKET_PATTERN = /^[A-Z0-9]+-[A-Z0-9]+$/;
const SNAPSHOT_FIELDS = [
  'market',
  'trade_price',
  'signed_change_rate',
  'signed_change_price',
  'high_price',
  'low_price',
  'acc_trade_volume_24h',
  'acc_trade_price_24h',
  'trade_timestamp',
  'fetchedAt'
];

function normalizeTimestamp(value) {
  if (typeof value === 'string' && !/^\d+(\.\d+)?$/.test(value.trim())) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const milliseconds = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function normalizeFetchedAt(value) {
  const milliseconds = normalizeTimestamp(value);
  return milliseconds === null ? null : new Date(milliseconds).toISOString();
}

function normalizeTicker(ticker, fetchedAt) {
  if (!ticker || typeof ticker !== 'object' ||
    typeof ticker.market !== 'string' || !MARKET_PATTERN.test(ticker.market)) return null;
  const tradePrice = Number(ticker.trade_price);
  const sourceTimestamp = normalizeTimestamp(ticker.trade_timestamp ?? ticker.timestamp);
  if (!Number.isFinite(tradePrice) || tradePrice <= 0 || sourceTimestamp === null) return null;

  const normalized = {
    market: ticker.market,
    trade_price: tradePrice,
    trade_timestamp: sourceTimestamp,
    fetchedAt
  };
  for (const field of SNAPSHOT_FIELDS.slice(2, 8)) {
    const value = Number(ticker[field]);
    if (Number.isFinite(value)) normalized[field] = value;
  }
  return normalized;
}

function validateStoredTicker(value) {
  const fetchedAt = normalizeFetchedAt(value?.fetchedAt);
  const ticker = normalizeTicker(value, fetchedAt);
  if (!ticker || fetchedAt === null) throw new Error('public market snapshot row is invalid');
  return ticker;
}

function cloneTicker(ticker) {
  return Object.fromEntries(Object.entries(ticker).map(([key, value]) => [key, value]));
}

function normalizeRequestedMarkets(markets) {
  const requested = Array.isArray(markets)
    ? markets
    : typeof markets === 'string'
      ? markets.split(',')
      : null;
  if (!requested || requested.some(market => typeof market !== 'string' || !MARKET_PATTERN.test(market))) {
    throw new TypeError('Public market snapshot reads require valid market codes.');
  }
  return [...new Set(requested)];
}

async function writeJsonAtomically(filePath, value, fileSystem = fs.promises) {
  const directory = path.dirname(filePath);
  await fileSystem.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let handle = null;
  let created = false;
  try {
    handle = await fileSystem.open(temporaryPath, 'wx', 0o600);
    created = true;
    await handle.chmod(0o600);
    await handle.writeFile(JSON.stringify(value), 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fileSystem.rename(temporaryPath, filePath);
    created = false;
    if (process.platform !== 'win32') {
      const directoryHandle = await fileSystem.open(directory, 'r');
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch { /* Preserve the original error. */ }
    }
    if (created) {
      try { await fileSystem.rm(temporaryPath, { force: true }); } catch { /* Preserve the original error. */ }
    }
    throw error;
  }
}

/**
 * Bounded, per-profile last-good public quote storage for read-only recovery.
 * The owner must keep its profile writer lock through flush/close. Stored data
 * must never replace the direct upstream read used by strategy, risk, or orders.
 */
export class PublicMarketSnapshotStore {
  constructor({
    filePath,
    maxMarkets = PUBLIC_MARKET_SNAPSHOT_MAX_MARKETS,
    persistIntervalMs = PUBLIC_MARKET_SNAPSHOT_PERSIST_INTERVAL_MS,
    now = Date.now,
    fileSystem = fs.promises,
    readOnly = false
  } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new TypeError('Public market snapshot filePath is required.');
    }
    if (!Number.isSafeInteger(maxMarkets) || maxMarkets < 1) {
      throw new RangeError('Public market snapshot maxMarkets must be a positive integer.');
    }
    if (!Number.isFinite(persistIntervalMs) || persistIntervalMs < 0) {
      throw new RangeError('Public market snapshot persistIntervalMs must be non-negative.');
    }
    this.filePath = path.resolve(filePath);
    this.maxMarkets = maxMarkets;
    this.persistIntervalMs = persistIntervalMs;
    this.now = typeof now === 'function' ? now : Date.now;
    this.fileSystem = fileSystem;
    this.readOnly = readOnly === true;
    this.rowsByMarket = new Map();
    this.version = 0;
    this.persistedVersion = 0;
    this.persistedAt = null;
    this.writePromise = null;
    this.writeTimer = null;
    this.lastPersistenceError = null;
    this.closed = false;
    this.loadError = null;
    this.loadFromDisk();
  }

  loadFromDisk() {
    try {
      const stat = fs.statSync(this.filePath);
      if (stat.size > MAX_PUBLIC_MARKET_SNAPSHOT_FILE_BYTES) {
        throw new Error('public market snapshot exceeds its size limit');
      }
      const contents = fs.readFileSync(this.filePath, 'utf8');
      const document = JSON.parse(contents);
      if (document?.schema !== PUBLIC_MARKET_SNAPSHOT_SCHEMA ||
        !Array.isArray(document.tickers) || document.tickers.length > this.maxMarkets ||
        !Number.isFinite(Date.parse(document.persistedAt))) {
        throw new Error('public market snapshot header is invalid');
      }
      const rows = document.tickers.map(validateStoredTicker);
      const uniqueMarkets = new Set(rows.map(row => row.market));
      if (uniqueMarkets.size !== rows.length) throw new Error('public market snapshot contains duplicate markets');
      this.rowsByMarket = new Map(rows.map(row => [row.market, row]));
      this.persistedAt = new Date(document.persistedAt).toISOString();
      this.version = 1;
      this.persistedVersion = 1;
    } catch (error) {
      if (error?.code !== 'ENOENT') this.loadError = String(error?.message || error).slice(0, 240);
    }
  }

  recordTickers(tickers, fetchedAt = this.now()) {
    if (this.closed || this.readOnly || !Array.isArray(tickers)) return false;
    const normalizedFetchedAt = normalizeFetchedAt(fetchedAt);
    if (normalizedFetchedAt === null) return false;
    let changed = false;
    for (const rawTicker of tickers) {
      const ticker = normalizeTicker(rawTicker, normalizedFetchedAt);
      if (!ticker) continue;
      const existing = this.rowsByMarket.get(ticker.market);
      const sourceIsNewer = !existing ||
        ticker.trade_timestamp > existing.trade_timestamp ||
        (ticker.trade_timestamp === existing.trade_timestamp &&
          Date.parse(ticker.fetchedAt) >= Date.parse(existing.fetchedAt));
      if (!sourceIsNewer) continue;
      this.rowsByMarket.set(ticker.market, ticker);
      changed = true;
    }
    if (!changed) return false;
    this.lastPersistenceError = null;

    if (this.rowsByMarket.size > this.maxMarkets) {
      const oldestMarkets = [...this.rowsByMarket.values()]
        .sort((left, right) => Date.parse(left.fetchedAt) - Date.parse(right.fetchedAt))
        .slice(0, this.rowsByMarket.size - this.maxMarkets);
      for (const row of oldestMarkets) this.rowsByMarket.delete(row.market);
    }
    this.version += 1;
    this.schedulePersist();
    return true;
  }

  getTickerSnapshot(markets, { snapshotSource = 'last_good' } = {}) {
    const requestedMarkets = normalizeRequestedMarkets(markets);
    const tickers = requestedMarkets.flatMap(market => {
      const row = this.rowsByMarket.get(market);
      return row ? [cloneTicker(row)] : [];
    });
    if (tickers.length === 0) return null;
    const fetchedAtByMarket = Object.fromEntries(tickers.map(row => [row.market, row.fetchedAt]));
    const fetchedAt = tickers.reduce((oldest, row) => (
      Date.parse(row.fetchedAt) < Date.parse(oldest) ? row.fetchedAt : oldest
    ), tickers[0].fetchedAt);
    return {
      tickers,
      fetchedAt,
      fetchedAtByMarket,
      snapshotSource
    };
  }

  getCachedTickerSnapshot(markets, { maxAgeMs = 1_000, now = this.now() } = {}) {
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
      throw new RangeError('Public market snapshot maxAgeMs must be non-negative.');
    }
    const snapshot = this.getTickerSnapshot(markets, { snapshotSource: 'collector_cache' });
    if (!snapshot) return null;
    const nowValue = now instanceof Date ? now.getTime() : Number(now);
    const nowMs = Number.isFinite(nowValue) ? nowValue : Date.now();
    const requestedMarkets = normalizeRequestedMarkets(markets);
    if (snapshot.tickers.length !== requestedMarkets.length) return null;
    const everyRowRecent = snapshot.tickers.every(row => {
      const fetchedAt = Date.parse(row.fetchedAt);
      const ageMs = nowMs - fetchedAt;
      return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= maxAgeMs;
    });
    return everyRowRecent ? snapshot : null;
  }

  getStatus() {
    return {
      available: this.rowsByMarket.size > 0,
      marketCount: this.rowsByMarket.size,
      persistedAt: this.persistedAt,
      dirty: this.version !== this.persistedVersion,
      readOnly: this.readOnly,
      persistenceHealthy: this.lastPersistenceError === null,
      loadHealthy: this.loadError === null
    };
  }

  schedulePersist() {
    if (this.readOnly || this.closed || this.writeTimer || this.writePromise) return;
    const lastPersistedMs = Date.parse(this.persistedAt || '') || 0;
    const nowValue = Number(this.now());
    const now = Number.isFinite(nowValue) ? nowValue : Date.now();
    const delayMs = lastPersistedMs === 0
      ? 0
      : Math.max(0, lastPersistedMs + this.persistIntervalMs - now);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.persist().catch(error => {
        this.lastPersistenceError = String(error?.code || error?.message || error).slice(0, 160);
      });
    }, delayMs);
    this.writeTimer.unref?.();
  }

  async persist() {
    if (this.readOnly || this.closed || this.version === this.persistedVersion) return false;
    if (this.writePromise) return this.writePromise;
    const version = this.version;
    const persistedAt = new Date(Number(this.now()) || Date.now()).toISOString();
    const document = {
      schema: PUBLIC_MARKET_SNAPSHOT_SCHEMA,
      persistedAt,
      tickers: [...this.rowsByMarket.values()].map(cloneTicker)
    };
    let writeSucceeded = false;
    this.writePromise = writeJsonAtomically(this.filePath, document, this.fileSystem)
      .then(() => {
        this.persistedAt = persistedAt;
        this.persistedVersion = version;
        this.lastPersistenceError = null;
        writeSucceeded = true;
      })
      .catch(error => {
        this.lastPersistenceError = String(error?.code || error?.message || error).slice(0, 160);
        throw error;
      })
      .finally(() => {
        this.writePromise = null;
        if (writeSucceeded && this.version !== this.persistedVersion) this.schedulePersist();
      });
    return this.writePromise;
  }

  async flush() {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (this.writePromise) await this.writePromise;
    if (this.version !== this.persistedVersion && !this.readOnly) await this.persist();
    return this.getStatus();
  }

  async close() {
    if (this.closed) return this.getStatus();
    const status = await this.flush();
    this.closed = true;
    return status;
  }
}

export function createPublicMarketSnapshotStore(options = {}) {
  return new PublicMarketSnapshotStore(options);
}
