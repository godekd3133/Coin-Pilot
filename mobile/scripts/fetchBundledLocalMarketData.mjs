import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchCompleteUpbitCandleHistory } from '../../src/market-data/completeUpbitCandleHistory.js';

export const DEFAULT_BUNDLED_LOCAL_MARKETS = Object.freeze([
  'KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL'
]);
export const DEFAULT_BUNDLED_LOCAL_INTERVALS = Object.freeze([1, 5, 15, 60]);
export const MAX_BUNDLED_LOCAL_PACK_BYTES = 50 * 1024 * 1024;
export const MAX_BUNDLED_LOCAL_CANDLES_PER_MARKET = 20_000;
const SUPPORTED_INTERVALS = new Set(DEFAULT_BUNDLED_LOCAL_INTERVALS);
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CANONICAL_REPOSITORY_ROOT = fs.realpathSync(REPOSITORY_ROOT);

function resolveCanonicalPathWithMissingSuffix(inputPath) {
  try {
    return fs.realpathSync(inputPath);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;

    const parentPath = path.dirname(inputPath);
    if (parentPath === inputPath) throw error;

    const canonicalParentPath = resolveCanonicalPathWithMissingSuffix(parentPath);
    const childPath = path.join(canonicalParentPath, path.basename(inputPath));
    try {
      const childStats = fs.lstatSync(childPath);
      if (childStats.isSymbolicLink()) {
        const linkTarget = fs.readlinkSync(childPath);
        return resolveCanonicalPathWithMissingSuffix(path.resolve(path.dirname(childPath), linkTarget));
      }
    } catch (childError) {
      if (childError.code !== 'ENOENT' && childError.code !== 'ENOTDIR') throw childError;
    }
    return childPath;
  }
}

function assertOutputOutsideRepository(outputFile) {
  const canonicalOutputFile = resolveCanonicalPathWithMissingSuffix(outputFile);
  const relativeOutput = path.relative(CANONICAL_REPOSITORY_ROOT, canonicalOutputFile);
  if (relativeOutput === '' || (!path.isAbsolute(relativeOutput) && relativeOutput !== '..' &&
    !relativeOutput.startsWith(`..${path.sep}`))) {
    throw new Error('outputFile must resolve outside the repository so the current market snapshot is not checked in by accident');
  }
  return canonicalOutputFile;
}

function validMarket(value) {
  return typeof value === 'string' && /^KRW-[A-Z0-9]{2,15}$/.test(value);
}

function finitePositive(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeUtcTimestamp(value) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  const text = String(value ?? '').trim();
  if (!text) return null;
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function normalizeUpbitMinuteCandles(market, intervalMinutes, rows) {
  if (!validMarket(market) || !SUPPORTED_INTERVALS.has(intervalMinutes) ||
    !Array.isArray(rows) || rows.length === 0 || rows.length > MAX_BUNDLED_LOCAL_CANDLES_PER_MARKET) {
    throw new TypeError('market, interval, and a non-empty Upbit candle response are required');
  }

  const candles = rows.map(row => {
    if (row?.market !== market) throw new Error(`Upbit candle market mismatch for ${market}`);
    const timestamp = normalizeUtcTimestamp(row.candle_date_time_utc);
    const open = finitePositive(row.opening_price);
    const high = finitePositive(row.high_price);
    const low = finitePositive(row.low_price);
    const close = finitePositive(row.trade_price);
    const volume = Number(row.candle_acc_trade_volume);
    if (!timestamp || open === null || high === null || low === null || close === null ||
      !Number.isFinite(volume) || volume < 0 || high < Math.max(open, close) ||
      low > Math.min(open, close) || low > high) {
      throw new Error(`invalid Upbit OHLCV candle for ${market}/${intervalMinutes}`);
    }
    return { intervalMinutes, timestamp, open, high, low, close, volume };
  }).sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));

  for (let index = 1; index < candles.length; index += 1) {
    if (candles[index].timestamp === candles[index - 1].timestamp) {
      throw new Error(`duplicate Upbit candle for ${market}/${intervalMinutes}`);
    }
  }
  return candles;
}

export function validateBundledLocalMarketDataTimes(pack) {
  const generatedAt = normalizeUtcTimestamp(pack?.generatedAt);
  if (!generatedAt || !Array.isArray(pack?.markets)) {
    throw new TypeError('bundled local market data requires a valid generatedAt and markets list');
  }
  const generatedAtMs = Date.parse(generatedAt);
  for (const market of pack.markets) {
    if (!Array.isArray(market?.candles)) {
      throw new TypeError('bundled local market data candles must be an array');
    }
    for (const candle of market.candles) {
      const timestamp = normalizeUtcTimestamp(candle?.timestamp);
      if (!timestamp) throw new TypeError('bundled local candle timestamp must be valid');
      if (Date.parse(timestamp) > generatedAtMs) {
        throw new RangeError('candle timestamp must not be later than generatedAt');
      }
    }
  }
  return pack;
}

export async function generateBundledLocalMarketData({
  marketDataClient = null,
  markets = DEFAULT_BUNDLED_LOCAL_MARKETS,
  intervals = DEFAULT_BUNDLED_LOCAL_INTERVALS,
  count = 200,
  generatedAt = null,
  nowImpl = () => new Date(),
  requestSpacingMs = 1_200,
  sleepImpl = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
} = {}) {
  let client = marketDataClient;
  if (client === null) {
    const { default: UpbitAPI } = await import('../../src/api/upbit.js');
    client = new UpbitAPI('', '');
  }
  if (typeof client?.getMinuteCandles !== 'function') {
    throw new TypeError('marketDataClient must provide getMinuteCandles');
  }
  if (!Array.isArray(markets) || markets.length === 0 || markets.some(market => !validMarket(market)) ||
    new Set(markets).size !== markets.length) {
    throw new TypeError('markets must be unique KRW market codes');
  }
  if (!Array.isArray(intervals) || intervals.length === 0 ||
    intervals.some(interval => !SUPPORTED_INTERVALS.has(interval)) || new Set(intervals).size !== intervals.length) {
    throw new TypeError('intervals must be unique values from 1, 5, 15, or 60');
  }
  const maximumCountPerInterval = Math.floor(MAX_BUNDLED_LOCAL_CANDLES_PER_MARKET / intervals.length);
  if (!Number.isSafeInteger(count) || count < 1 || count > maximumCountPerInterval) {
    throw new RangeError(
      `Upbit minute candle count must be between 1 and ${maximumCountPerInterval} for ${intervals.length} intervals ` +
      `(${MAX_BUNDLED_LOCAL_CANDLES_PER_MARKET} combined candles per market maximum)`
    );
  }
  if (!Number.isFinite(requestSpacingMs) || requestSpacingMs < 0) {
    throw new RangeError('requestSpacingMs must be a non-negative finite number');
  }
  const requestedGeneratedAtIso = generatedAt === null ? null : normalizeUtcTimestamp(generatedAt);
  if (generatedAt !== null && !requestedGeneratedAtIso) throw new TypeError('generatedAt must be a valid timestamp');

  let requestCount = 0;
  const pacedClient = {
    getMinuteCandles: async (...args) => {
      if (requestCount > 0 && requestSpacingMs > 0) await sleepImpl(requestSpacingMs);
      requestCount += 1;
      return client.getMinuteCandles(...args);
    }
  };
  const packagedMarkets = [];
  for (const market of markets) {
    const candles = [];
    for (const intervalMinutes of intervals) {
      const rows = await fetchCompleteUpbitCandleHistory({
        marketDataClient: pacedClient,
        market,
        intervalMinutes,
        totalCount: count
      });
      candles.push(...normalizeUpbitMinuteCandles(market, intervalMinutes, rows));
    }
    packagedMarkets.push({ market, candles });
  }

  const pack = {
    schemaVersion: 1,
    source: 'upbit-public-market-api',
    generatedAt: normalizeUtcTimestamp(requestedGeneratedAtIso ?? nowImpl()),
    markets: packagedMarkets
  };
  return validateBundledLocalMarketDataTimes(pack);
}

export function writeBundledLocalMarketData(pack, outputFile) {
  if (typeof outputFile !== 'string' || !path.isAbsolute(outputFile)) {
    throw new TypeError('outputFile must be an explicit absolute path');
  }
  validateBundledLocalMarketDataTimes(pack);
  const preflightCanonicalOutputFile = assertOutputOutsideRepository(outputFile);
  const bytes = Buffer.from(JSON.stringify(pack, null, 2), 'utf8');
  if (bytes.length > MAX_BUNDLED_LOCAL_PACK_BYTES) {
    throw new RangeError('bundled local market data exceeds the 50 MiB limit');
  }
  fs.mkdirSync(path.dirname(preflightCanonicalOutputFile), { recursive: true });
  const canonicalOutputFile = assertOutputOutsideRepository(outputFile);
  fs.writeFileSync(canonicalOutputFile, bytes, { flag: 'wx', mode: 0o600 });
  return {
    outputFile: canonicalOutputFile,
    byteCount: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex')
  };
}

async function main() {
  const outputFile = process.argv[2];
  const count = process.argv[3] === undefined ? 200 : Number(process.argv[3]);
  if (!outputFile || !path.isAbsolute(outputFile)) {
    console.error('usage: npm --prefix mobile run market-data:pack -- /absolute/output/market-data.json [candles-per-market-interval]');
    process.exitCode = 2;
    return;
  }

  try {
    const pack = await generateBundledLocalMarketData({ count });
    const output = writeBundledLocalMarketData(pack, outputFile);
    console.log(`bundled local public market data: ${pack.markets.length} markets · ${DEFAULT_BUNDLED_LOCAL_INTERVALS.length} intervals · ${count} candles per interval`);
    console.log(`generatedAt: ${pack.generatedAt}`);
    console.log(`saved: ${output.outputFile} · ${output.byteCount} bytes · sha256 ${output.sha256}`);
    console.log('Public OHLCV only; no account data, credentials, orders, or automation state are included.');
  } catch (error) {
    console.error(`bundled local market data generation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
