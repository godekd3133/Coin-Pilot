import UpbitAPI from './upbit.js';

const publicMarketDataSources = new WeakSet();

function cloneSingleFlightArgument(value, ancestors = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return { supported: true, value };
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? { supported: true, value }
      : { supported: false };
  }
  if (!value || typeof value !== 'object' || ancestors.has(value)) return { supported: false };

  ancestors.add(value);
  try {
    const isArray = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (isArray ? prototype !== Array.prototype : (prototype !== Object.prototype && prototype !== null)) {
      return { supported: false };
    }
    if (Object.getOwnPropertySymbols(value).length > 0) return { supported: false };

    const propertyNames = Object.getOwnPropertyNames(value);
    const entries = [];
    if (isArray) {
      if (propertyNames.length !== value.length + 1 || !propertyNames.includes('length')) {
        return { supported: false };
      }
      for (let index = 0; index < value.length; index += 1) {
        const key = String(index);
        if (!propertyNames.includes(key)) return { supported: false };
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return { supported: false };
        entries.push([key, descriptor.value]);
      }
    } else {
      for (const key of propertyNames) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return { supported: false };
        entries.push([key, descriptor.value]);
      }
    }

    const copiedEntries = [];
    for (const [key, item] of entries) {
      const copied = cloneSingleFlightArgument(item, ancestors);
      if (!copied.supported) return { supported: false };
      copiedEntries.push([key, copied.value]);
    }
    return {
      supported: true,
      value: isArray ? copiedEntries.map(([, item]) => item) : Object.fromEntries(copiedEntries)
    };
  } catch {
    return { supported: false };
  } finally {
    ancestors.delete(value);
  }
}

function snapshotSingleFlightArguments(args) {
  try {
    const snapshot = cloneSingleFlightArgument(args);
    return snapshot.supported ? snapshot.value : null;
  } catch {
    return null;
  }
}

function normalizeReadArguments(method, args) {
  const optionsIndex = {
    getMarkets: 0,
    getTicker: 1,
    getMinuteCandles: 3
  }[method];
  if (optionsIndex === undefined || args.length !== optionsIndex + 1) return args;

  const options = args[optionsIndex];
  if (options === null) return args.slice(0, optionsIndex);
  try {
    const prototype = options && typeof options === 'object' ? Object.getPrototypeOf(options) : null;
    const isPlainObject = prototype === Object.prototype || prototype === null;
    const isEmptyOptions = isPlainObject &&
      Object.getOwnPropertyNames(options).length === 0 && Object.getOwnPropertySymbols(options).length === 0;
    return isEmptyOptions ? args.slice(0, optionsIndex) : args;
  } catch {
    return args;
  }
}

function cloneReadPayload(value) {
  if (Array.isArray(value)) return value.map(cloneReadPayload);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneReadPayload(item)]));
  }
  return value;
}

function singleFlightKey(method, args) {
  const options = args[args.length - 1];
  if (options && typeof options === 'object' && !Array.isArray(options) &&
    (options.signal || options.deadlineAt !== undefined || options.queueWaitTimeoutMs !== undefined)) {
    return null;
  }
  try {
    return JSON.stringify([method, args]);
  } catch {
    return null;
  }
}

/**
 * A public-only Upbit reader shared by production strategy and dashboard
 * consumers. It deliberately owns a credential-free client, separate from
 * the trader's account/order client. Identical in-flight reads share one
 * upstream request; freshness remains the responsibility of each consumer.
 */
export class PublicMarketDataSource {
  #client;
  #inFlightReads = new Map();
  #snapshotStore;

  constructor({ requestTimeoutMs, snapshotStore = null } = {}) {
    if (snapshotStore !== null && (
      typeof snapshotStore.recordTickers !== 'function' ||
      typeof snapshotStore.getTickerSnapshot !== 'function' ||
      typeof snapshotStore.getCachedTickerSnapshot !== 'function' ||
      typeof snapshotStore.flush !== 'function'
    )) {
      throw new TypeError('snapshotStore must provide recordTickers, getTickerSnapshot, getCachedTickerSnapshot, and flush.');
    }
    this.#client = new UpbitAPI('', '', { requestTimeoutMs });
    this.#snapshotStore = snapshotStore;
    publicMarketDataSources.add(this);
    Object.freeze(this);
  }

  #captureTickerSnapshot(method, args, payload) {
    if (method !== 'getTicker' || !this.#snapshotStore || !Array.isArray(payload)) return;
    const options = args[1];
    if (options?.priority === 'risk') return;
    try {
      this.#snapshotStore.recordTickers(payload, new Date().toISOString());
    } catch {
      // The persistent snapshot is a read-only recovery cache. A cache write
      // failure must never fail strategy, risk, or order-adjacent source reads.
    }
  }

  async #read(method, args) {
    const snapshot = snapshotSingleFlightArguments(args);
    const readArgs = normalizeReadArguments(method, snapshot ?? args);
    const key = snapshot === null ? null : singleFlightKey(method, readArgs);
    if (key === null) {
      const payload = await this.#client[method](...readArgs);
      this.#captureTickerSnapshot(method, readArgs, payload);
      return cloneReadPayload(payload);
    }

    let request = this.#inFlightReads.get(key);
    if (!request) {
      request = Promise.resolve()
        .then(() => this.#client[method](...readArgs))
        .then(payload => {
          this.#captureTickerSnapshot(method, readArgs, payload);
          return payload;
        })
        .finally(() => {
          if (this.#inFlightReads.get(key) === request) this.#inFlightReads.delete(key);
        });
      this.#inFlightReads.set(key, request);
    }
    return cloneReadPayload(await request);
  }

  getMarkets(...args) {
    return this.#read('getMarkets', args);
  }

  getTicker(...args) {
    return this.#read('getTicker', args);
  }

  getMinuteCandles(...args) {
    return this.#read('getMinuteCandles', args);
  }

  getLastGoodTickerSnapshot(markets) {
    return this.#snapshotStore?.getTickerSnapshot(markets) ?? null;
  }

  getCachedTickerSnapshot(markets, options = {}) {
    return this.#snapshotStore?.getCachedTickerSnapshot(markets, options) ?? null;
  }

  getSnapshotStoreStatus() {
    return this.#snapshotStore?.getStatus() ?? { available: false };
  }

  flushSnapshot() {
    return this.#snapshotStore?.flush() ?? Promise.resolve(false);
  }

  async close() {
    if (!this.#snapshotStore) return false;
    if (typeof this.#snapshotStore.close === 'function') {
      await this.#snapshotStore.close();
      return true;
    }
    await this.#snapshotStore.flush();
    return true;
  }
}

export function createPublicMarketDataSource(options = {}) {
  return new PublicMarketDataSource(options);
}

export function isPublicMarketDataSource(value) {
  return Boolean(value && typeof value === 'object' && publicMarketDataSources.has(value));
}
