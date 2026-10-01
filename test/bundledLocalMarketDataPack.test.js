import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  DEFAULT_BUNDLED_LOCAL_INTERVALS,
  DEFAULT_BUNDLED_LOCAL_MARKETS,
  generateBundledLocalMarketData,
  normalizeUpbitMinuteCandles,
  validateBundledLocalMarketDataTimes,
  writeBundledLocalMarketData
} from '../mobile/scripts/fetchBundledLocalMarketData.mjs';

const PACK_SCRIPT_PATH = fileURLToPath(new URL('../mobile/scripts/fetchBundledLocalMarketData.mjs', import.meta.url));
const CANDLE_HISTORY_COLLECTOR_PATH = fileURLToPath(new URL('../src/market-data/completeUpbitCandleHistory.js', import.meta.url));
const XCODE_PROJECT_PATH = fileURLToPath(new URL('../mobile/ios/App/App.xcodeproj/project.pbxproj', import.meta.url));

function bundledLocalBuildPhaseScript() {
  const project = fs.readFileSync(XCODE_PROJECT_PATH, 'utf8');
  const phaseName = project.indexOf('name = "Bundle selected market data only";');
  const marker = 'shellScript = "';
  const start = project.indexOf(marker, phaseName) + marker.length;
  const end = project.indexOf('";\n\t\t};', start);
  assert.ok(phaseName >= 0 && start >= marker.length && end > start, 'the Xcode pack validation phase must exist');
  return JSON.parse(`"${project.slice(start, end)}"`);
}

async function loadPackWriterInTemporaryRepository(tempRoot) {
  const repositoryRoot = path.join(tempRoot, 'repository');
  const scriptPath = path.join(repositoryRoot, 'mobile', 'scripts', 'fetchBundledLocalMarketData.mjs');
  const collectorPath = path.join(repositoryRoot, 'src', 'market-data', 'completeUpbitCandleHistory.js');
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.mkdirSync(path.dirname(collectorPath), { recursive: true });
  fs.writeFileSync(path.join(repositoryRoot, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  fs.copyFileSync(PACK_SCRIPT_PATH, scriptPath);
  fs.copyFileSync(CANDLE_HISTORY_COLLECTOR_PATH, collectorPath);
  const packScript = await import(pathToFileURL(scriptPath).href);
  return { repositoryRoot, writeBundledLocalMarketData: packScript.writeBundledLocalMarketData };
}

function upbitCandle(market, candleDateTimeUtc, overrides = {}) {
  return {
    market,
    candle_date_time_utc: candleDateTimeUtc,
    opening_price: 100,
    high_price: 103,
    low_price: 99,
    trade_price: 102,
    candle_acc_trade_volume: 12,
    ...overrides
  };
}

test('local market pack generator uses the shared public client with pacing and sorts source rows', async () => {
  const requests = [];
  const delays = [];
  const pack = await generateBundledLocalMarketData({
    markets: ['KRW-BTC'],
    intervals: [1, 5],
    count: 2,
    generatedAt: new Date('2026-09-29T10:00:00.000Z'),
    sleepImpl: async milliseconds => delays.push(milliseconds),
    marketDataClient: {
      getMinuteCandles: async (market, interval, count) => {
        requests.push({ market, interval, count });
        const start = interval === 1 ? '09:59:00' : '09:55:00';
        const previous = interval === 1 ? '09:58:00' : '09:50:00';
        return [
          upbitCandle(market, `2026-09-29T${start}`),
          upbitCandle(market, `2026-09-29T${previous}`)
        ];
      }
    }
  });

  assert.equal(pack.schemaVersion, 1);
  assert.equal(pack.source, 'upbit-public-market-api');
  assert.equal(pack.generatedAt, '2026-09-29T10:00:00.000Z');
  assert.deepEqual(requests, [
    { market: 'KRW-BTC', interval: 1, count: 2 },
    { market: 'KRW-BTC', interval: 5, count: 2 }
  ]);
  assert.deepEqual(delays, [1_200]);
  assert.deepEqual(pack.markets[0].candles.map(row => row.timestamp), [
    '2026-09-29T09:58:00.000Z', '2026-09-29T09:59:00.000Z',
    '2026-09-29T09:50:00.000Z', '2026-09-29T09:55:00.000Z'
  ]);
});

test('local market pack generator pages 201 candles with an exclusive cursor, pacing, and chronological output', async () => {
  const newestEpoch = Date.parse('2026-09-29T10:00:00.000Z');
  const newestFirstCandles = Array.from({ length: 201 }, (_, index) => {
    const timestamp = new Date(newestEpoch - index * 60_000).toISOString().replace('.000Z', '');
    return upbitCandle('KRW-BTC', timestamp);
  });
  const requests = [];
  const timeline = [];
  let generationClockCalled = false;
  const pack = await generateBundledLocalMarketData({
    markets: ['KRW-BTC'],
    intervals: [1],
    count: 201,
    requestSpacingMs: 1_200,
    sleepImpl: async milliseconds => timeline.push({ type: 'sleep', milliseconds }),
    nowImpl: () => {
      generationClockCalled = true;
      assert.equal(requests.length, 2, 'generatedAt must be captured after every page is collected');
      return new Date('2026-09-29T12:00:00.000Z');
    },
    marketDataClient: {
      getMinuteCandles: async (market, interval, count, options) => {
        requests.push({ market, interval, count, options });
        timeline.push({ type: 'request', page: requests.length });
        const rows = options?.to
          ? newestFirstCandles.filter(row => Date.parse(row.candle_date_time_utc) < Date.parse(options.to))
          : newestFirstCandles;
        return rows.slice(0, count);
      }
    }
  });

  assert.equal(generationClockCalled, true);
  assert.deepEqual(requests, [
    { market: 'KRW-BTC', interval: 1, count: 200, options: undefined },
    {
      market: 'KRW-BTC',
      interval: 1,
      count: 1,
      options: { to: newestFirstCandles[199].candle_date_time_utc }
    }
  ]);
  assert.ok(Date.parse(newestFirstCandles[200].candle_date_time_utc) <
    Date.parse(requests[1].options.to), 'the cursor timestamp itself must be excluded from the next page');
  assert.deepEqual(timeline, [
    { type: 'request', page: 1 },
    { type: 'sleep', milliseconds: 1_200 },
    { type: 'request', page: 2 }
  ], 'every upstream request after the first must be paced');

  const timestamps = pack.markets[0].candles.map(row => row.timestamp);
  const expectedChronologicalTimestamps = newestFirstCandles
    .slice()
    .reverse()
    .map(row => new Date(`${row.candle_date_time_utc}Z`).toISOString());
  assert.equal(timestamps.length, 201);
  assert.deepEqual(timestamps, expectedChronologicalTimestamps);
});

test('local market pack generator rejects a short second page and a cursor that does not advance', async () => {
  const newestEpoch = Date.parse('2026-09-29T10:00:00.000Z');
  const firstPage = Array.from({ length: 200 }, (_, index) => {
    const timestamp = new Date(newestEpoch - index * 60_000).toISOString().replace('.000Z', '');
    return upbitCandle('KRW-BTC', timestamp);
  });

  await assert.rejects(generateBundledLocalMarketData({
    markets: ['KRW-BTC'],
    intervals: [1],
    count: 201,
    requestSpacingMs: 0,
    marketDataClient: {
      getMinuteCandles: async (_market, _interval, count, options) => options
        ? []
        : firstPage.slice(0, count)
    }
  }), error => error.code === 'CANDLE_HISTORY_INCOMPLETE' && /expected 1 candles/.test(error.message));

  const cursor = firstPage[firstPage.length - 1].candle_date_time_utc;
  await assert.rejects(generateBundledLocalMarketData({
    markets: ['KRW-BTC'],
    intervals: [1],
    count: 201,
    requestSpacingMs: 0,
    marketDataClient: {
      getMinuteCandles: async (_market, _interval, count, options) => options
        ? [upbitCandle('KRW-BTC', cursor)].slice(0, count)
        : firstPage.slice(0, count)
    }
  }), error => error.code === 'CANDLE_HISTORY_INCOMPLETE' && /cursor did not advance/.test(error.message));
});

test('local market pack generator enforces a 20,000-candle combined per-market ceiling', async () => {
  let rejectedRequestCount = 0;
  await assert.rejects(generateBundledLocalMarketData({
    markets: ['KRW-BTC'],
    count: 5_001,
    marketDataClient: {
      getMinuteCandles: async () => {
        rejectedRequestCount += 1;
        return [];
      }
    }
  }), /20000 combined candles per market maximum/);
  assert.equal(rejectedRequestCount, 0, 'an over-limit pack must fail before any network request');

  const newestEpoch = Date.parse('2026-09-29T10:00:00.000Z');
  let requestCount = 0;
  const pack = await generateBundledLocalMarketData({
    markets: ['KRW-BTC'],
    intervals: [1],
    count: 20_000,
    generatedAt: new Date('2026-09-30T12:00:00.000Z'),
    requestSpacingMs: 0,
    marketDataClient: {
      getMinuteCandles: async (market, _interval, count, options) => {
        requestCount += 1;
        const pageNewestEpoch = options?.to
          ? Date.parse(`${options.to}Z`) - 60_000
          : newestEpoch;
        return Array.from({ length: count }, (_, index) => upbitCandle(
          market,
          new Date(pageNewestEpoch - index * 60_000).toISOString().replace('.000Z', '')
        ));
      }
    }
  });

  assert.equal(pack.markets[0].candles.length, 20_000);
  assert.equal(requestCount, 100);
});

test('pack generation timestamps completion and rejects candles later than generatedAt', async () => {
  let requestCount = 0;
  let generationClockCalled = false;
  const pack = await generateBundledLocalMarketData({
    markets: ['KRW-BTC'],
    intervals: [1],
    count: 1,
    requestSpacingMs: 0,
    nowImpl: () => {
      generationClockCalled = true;
      assert.equal(requestCount, 1, 'generatedAt must be captured after successful collection');
      return new Date('2026-09-29T10:00:00.000Z');
    },
    marketDataClient: {
      getMinuteCandles: async market => {
        requestCount += 1;
        return [upbitCandle(market, '2026-09-29T09:59:00')];
      }
    }
  });

  assert.equal(generationClockCalled, true);
  assert.equal(pack.generatedAt, '2026-09-29T10:00:00.000Z');
  const earlierGeneratedAt = {
    ...pack,
    generatedAt: '2026-09-29T09:58:59.999Z'
  };
  assert.throws(() => validateBundledLocalMarketDataTimes(earlierGeneratedAt), /later than generatedAt/);
  await assert.rejects(generateBundledLocalMarketData({
    markets: ['KRW-BTC'],
    intervals: [1],
    count: 1,
    generatedAt: new Date('2026-09-29T09:58:59.999Z'),
    requestSpacingMs: 0,
    marketDataClient: {
      getMinuteCandles: async market => [upbitCandle(market, '2026-09-29T09:59:00')]
    }
  }), /later than generatedAt/);
});

test('Xcode bundled-local build phase rejects a future candle before copying the pack', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-local-market-build-phase-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceFile = path.join(root, 'input', 'market-data.json');
  const resourceDir = path.join(root, 'build', 'CoinPilot.app', 'Resources');
  const derivedDir = path.join(root, 'derived');
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.mkdirSync(derivedDir, { recursive: true });
  const basePack = {
    schemaVersion: 1,
    source: 'upbit-public-market-api',
    generatedAt: '2026-09-29T09:00:00.000Z',
    markets: [{
      market: 'KRW-BTC',
      candles: [{
        intervalMinutes: 1,
        timestamp: '2026-09-29T09:00:00.000Z',
        open: 100,
        high: 103,
        low: 99,
        close: 102,
        volume: 12
      }]
    }]
  };
  const env = {
    ...process.env,
    COINPILOT_DATA_MODE: 'bundled-local',
    COINPILOT_LOCAL_MARKET_DATA_FILE: sourceFile,
    SRCROOT: path.resolve('mobile/ios/App'),
    TARGET_BUILD_DIR: path.join(root, 'build'),
    UNLOCALIZED_RESOURCES_FOLDER_PATH: 'CoinPilot.app/Resources',
    DERIVED_FILE_DIR: derivedDir
  };
  const runBuildPhase = () => spawnSync('/bin/sh', ['-c', bundledLocalBuildPhaseScript()], {
    env,
    encoding: 'utf8'
  });

  fs.writeFileSync(sourceFile, JSON.stringify(basePack), 'utf8');
  const validResult = runBuildPhase();
  assert.equal(validResult.status, 0, validResult.stderr || validResult.stdout);
  assert.equal(fs.existsSync(path.join(resourceDir, 'CoinPilotBundledLocalMarketData.json')), true);

  fs.writeFileSync(sourceFile, JSON.stringify({
    ...basePack,
    markets: [{
      ...basePack.markets[0],
      candles: [{ ...basePack.markets[0].candles[0], timestamp: '2026-09-29T09:00:00.001Z' }]
    }]
  }), 'utf8');
  const futureResult = runBuildPhase();
  assert.notEqual(futureResult.status, 0);
  assert.match(futureResult.stderr, /candle timestamp must not be later than generatedAt/);
  assert.equal(fs.existsSync(path.join(resourceDir, 'CoinPilotBundledLocalMarketData.json')), false,
    'a failed validation must leave no app resource pack behind');
});

test('default local package is exactly the existing four-market scalp universe', () => {
  assert.deepEqual(DEFAULT_BUNDLED_LOCAL_MARKETS, [
    'KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL'
  ]);
  assert.deepEqual(DEFAULT_BUNDLED_LOCAL_INTERVALS, [1, 5, 15, 60]);
});

test('local market pack generation fails closed on empty or mismatched upstream data', async () => {
  await assert.rejects(generateBundledLocalMarketData({
    markets: ['KRW-BTC'],
    intervals: [1],
    count: 1,
    sleepImpl: async () => {},
    marketDataClient: { getMinuteCandles: async () => [] }
  }), /expected 1 candles/);

  await assert.rejects(generateBundledLocalMarketData({
    markets: ['KRW-BTC'],
    intervals: [1],
    count: 1,
    sleepImpl: async () => {},
    marketDataClient: {
      getMinuteCandles: async () => [upbitCandle('KRW-ETH', '2026-09-29T09:00:00')]
    }
  }), /market mismatch/);
});

test('normalizer rejects duplicate timestamps and inconsistent OHLC', () => {
  const duplicate = [
    upbitCandle('KRW-BTC', '2026-09-29T09:00:00'),
    upbitCandle('KRW-BTC', '2026-09-29T09:00:00')
  ];
  assert.throws(() => normalizeUpbitMinuteCandles('KRW-BTC', 1, duplicate), /duplicate Upbit candle/);
  assert.throws(() => normalizeUpbitMinuteCandles('KRW-BTC', 1, [
    upbitCandle('KRW-BTC', '2026-09-29T09:00:00', { high_price: 98 })
  ]), /invalid Upbit OHLCV candle/);
});

test('pack writer requires an absolute path outside the repository and never overwrites', () => {
  const pack = {
    schemaVersion: 1,
    source: 'upbit-public-market-api',
    generatedAt: '2026-09-29T09:00:00.000Z',
    markets: [{ market: 'KRW-BTC', candles: [] }]
  };
  assert.throws(() => writeBundledLocalMarketData(pack, 'relative-market-data.json'), /absolute path/);
  assert.throws(() => writeBundledLocalMarketData(
    pack,
    path.resolve('docs/audits/coinpilot-2026-09-29/forbidden-pack.json')
  ), /outside the repository/);

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-local-market-pack-'));
  const canonicalOutputDir = path.join(outputDir, 'canonical');
  const outputAlias = path.join(outputDir, 'outside-link');
  const outputFileName = 'market-pack.json';
  const outputFile = path.join(outputAlias, outputFileName);
  try {
    fs.mkdirSync(canonicalOutputDir);
    fs.symlinkSync(canonicalOutputDir, outputAlias, 'dir');
    const canonicalOutputFile = path.join(fs.realpathSync(canonicalOutputDir), outputFileName);
    const result = writeBundledLocalMarketData(pack, outputFile);
    assert.equal(result.outputFile, canonicalOutputFile);
    assert.equal(result.byteCount, Buffer.byteLength(JSON.stringify(pack, null, 2), 'utf8'));
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.equal(fs.statSync(canonicalOutputFile).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(canonicalOutputFile, 'utf8')).source, pack.source);
    assert.throws(() => writeBundledLocalMarketData(pack, outputFile), { code: 'EEXIST' });
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('pack writer refuses a future candle before creating the destination', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-local-market-future-'));
  const outputFile = path.join(outputDir, 'market-data.json');
  const pack = {
    schemaVersion: 1,
    source: 'upbit-public-market-api',
    generatedAt: '2026-09-29T09:00:00.000Z',
    markets: [{
      market: 'KRW-BTC',
      candles: [{
        intervalMinutes: 1,
        timestamp: '2026-09-29T09:00:00.001Z',
        open: 100,
        high: 103,
        low: 99,
        close: 102,
        volume: 12
      }]
    }]
  };
  try {
    assert.throws(() => writeBundledLocalMarketData(pack, outputFile), /later than generatedAt/);
    assert.equal(fs.existsSync(outputFile), false);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('pack writer rejects an existing parent symlink into the repository before writing', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-local-market-symlink-'));
  const pack = {
    schemaVersion: 1,
    source: 'upbit-public-market-api',
    generatedAt: '2026-09-29T09:00:00.000Z',
    markets: []
  };
  try {
    const { repositoryRoot, writeBundledLocalMarketData: writePack } =
      await loadPackWriterInTemporaryRepository(tempRoot);
    const repositoryLink = path.join(tempRoot, 'repository-link');
    const targetFile = path.join(repositoryRoot, 'forbidden-pack.json');
    fs.symlinkSync(repositoryRoot, repositoryLink, 'dir');

    assert.throws(() => writePack(pack, path.join(repositoryLink, 'forbidden-pack.json')), /resolve outside the repository/);
    assert.equal(fs.existsSync(targetFile), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('pack writer rejects a missing nested suffix under a repository symlink before creating directories', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-local-market-symlink-nested-'));
  const pack = {
    schemaVersion: 1,
    source: 'upbit-public-market-api',
    generatedAt: '2026-09-29T09:00:00.000Z',
    markets: []
  };
  const missingDirectory = `forbidden-pack-output-${process.pid}-${Date.now()}`;
  try {
    const { repositoryRoot, writeBundledLocalMarketData: writePack } =
      await loadPackWriterInTemporaryRepository(tempRoot);
    const repositoryLink = path.join(tempRoot, 'repository-link');
    const outputFile = path.join(repositoryLink, missingDirectory, 'nested', 'market-pack.json');
    fs.symlinkSync(repositoryRoot, repositoryLink, 'dir');

    assert.throws(() => writePack(pack, outputFile), /resolve outside the repository/);
    assert.equal(fs.existsSync(path.join(repositoryRoot, missingDirectory)), false);
    assert.equal(fs.existsSync(path.join(repositoryRoot, missingDirectory, 'nested', 'market-pack.json')), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
