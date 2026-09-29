import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import DashboardServer from '../api/dashboardServer.js';
import { MarketDataProvider } from '../api/marketDataProvider.js';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..', '..');
const CORE_REFRESH_SOURCE = path.join(PROJECT_ROOT, 'public', 'pilot-redesign.js');
const RESULT_PREFIX = 'DASHBOARD_READ_CAPACITY_RESULT=';
const SYNTHETIC_DASHBOARD_TOKEN = 'synthetic-dashboard-read-capacity-token';
const MAX_CLIENTS_PER_PROFILE = 32;
const MAX_PROFILES = 8;
const MAX_TOTAL_REQUESTS = 50_000;
const CORE_REQUESTS_PER_CLIENT = 6;
const REPRESENTATIVE_COHORT_SESSION_COUNT = 95;
const REPRESENTATIVE_COHORT_TRADES_PER_SESSION = 1;
const REPRESENTATIVE_SHADOW_BOOK_TRADE_COUNT = 5;
const MOMENTUM_SHADOW_BOOK_CONFIG_KEYS = Object.freeze([
  'momentumShadowFixedDir',
  'momentumShadowRegimeDir',
  'momentumShadowBenchmarkDir',
  'momentumShadowVolatilityDir',
  'momentumShadowNextOpenDir',
  'momentumShadowFixedHoldDir',
  'momentumShadowFixedHoldLossCapDir',
  'momentumShadowFixedHoldLossCapNoDogeDir',
  'momentumShadowFixedHoldSpreadDir',
  'momentumShadowFixedHoldRelativeDir',
  'momentumShadowFixedHoldQuoteCrossDir'
]);
const MOMENTUM_SHADOW_ROUTE_BOOK_COUNT = 10;
const FIXTURE_MARKETS = Object.freeze([
  'KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL', 'KRW-DOGE'
]);
const FIXTURE_SOURCE_AS_OF = '2026-09-29T00:00:00.000Z';
const FIXTURE_FETCHED_AT = '2026-09-29T00:00:01.000Z';

const EXPECTED_CORE_REFRESH_REQUESTS = Object.freeze({
  status: '/status',
  account: '/account',
  pnl: '/cumulative-pnl',
  today: '/today-summary',
  statistics: '/statistics',
  validation: '/scalping-validation',
  strategyReadiness: '/strategy-readiness',
  paper: '/paper-validation',
  momentumShadow: '/momentum-shadow',
  portfolioAnalysis: '/portfolio-analysis',
  history: '/portfolio/history?period=${period}',
  trades: '/trades?limit=12',
  marketPrices: '/market/prices/snapshot',
  targetCoins: '/target-coins'
});

const CORE_REFRESH_ROUTES = Object.freeze(
  Object.entries(EXPECTED_CORE_REFRESH_REQUESTS)
    .map(([name, sourcePath]) => ({
      name,
      sourcePath,
      path: `/api${sourcePath.replace('${period}', '24h')}`
    }))
);

const MARKET_PRICE_BY_MARKET = Object.freeze({
  'KRW-BTC': 100_000_000,
  'KRW-ETH': 5_000_000,
  'KRW-XRP': 900,
  'KRW-SOL': 250_000,
  'KRW-DOGE': 200
});

class BenchmarkDashboardServer extends DashboardServer {
  getOptimizationStateFile() {
    return this.tradingSystem.config.benchmarkOptimizationStateFile;
  }
}

function printUsage() {
  process.stdout.write([
    'Local synthetic HTTP benchmark for the dashboard core refresh GET set.',
    '',
    'Options:',
    '  --profiles=1,4,8       Concurrent logical clients (default 1,4,8; max 32 each)',
    '  --warm-samples=12      Measured warm refresh rounds per profile (1..200)',
    '  --warmup-samples=3     Unreported warm refresh rounds per profile (0..20)',
    '  --fixture=empty         Synthetic research fixture (empty or representative; default empty)',
    '  --self-check           Run one client with one warmup and one measured warm round',
    '  --help                 Show this help',
    '',
    'Cold means the first measured full refresh on a fresh worker process/server.',
    'Warm means repeated refreshes on that same server after the configured warmup.',
    'All HTTP requests target an ephemeral 127.0.0.1 listener. The Upbit-facing',
    'market calls are fake. The representative fixture writes 95 paper-forward',
    'sessions and 11 five-trade shadow ledgers under OS temp.',
    'Results are synthetic local measurements, not SLOs or deployed capacity claims.'
  ].join('\n') + '\n');
}

function parsePositiveInteger(value, option, { min = 1, max } = {}) {
  if (!/^\d+$/.test(String(value))) {
    throw new TypeError(`${option} must be an integer between ${min} and ${max}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new TypeError(`${option} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function parseProfiles(value) {
  const profiles = String(value).split(',').map(item =>
    parsePositiveInteger(item.trim(), '--profiles', { min: 1, max: MAX_CLIENTS_PER_PROFILE })
  );
  if (profiles.length === 0 || profiles.length > MAX_PROFILES) {
    throw new TypeError(`--profiles must contain 1 to ${MAX_PROFILES} client counts`);
  }
  if (new Set(profiles).size !== profiles.length) {
    throw new TypeError('--profiles must not contain duplicate client counts');
  }
  return profiles.sort((left, right) => left - right);
}

function parseParentArguments(argv) {
  const options = {
    profiles: [1, 4, 8],
    warmSamples: 12,
    warmupSamples: 3,
    fixtureProfile: 'empty',
    selfCheck: false
  };

  for (const argument of argv) {
    if (argument === '--help' || argument === '-h') {
      printUsage();
      process.exit(0);
    }
    if (argument === '--self-check') {
      options.selfCheck = true;
      continue;
    }
    const match = /^--([a-z-]+)=(.*)$/.exec(argument);
    if (!match) throw new TypeError(`Unknown or invalid option: ${argument}`);
    if (match[1] === 'profiles') {
      options.profiles = parseProfiles(match[2]);
    } else if (match[1] === 'warm-samples') {
      options.warmSamples = parsePositiveInteger(match[2], '--warm-samples', { min: 1, max: 200 });
    } else if (match[1] === 'warmup-samples') {
      options.warmupSamples = parsePositiveInteger(match[2], '--warmup-samples', { min: 0, max: 20 });
    } else if (match[1] === 'fixture') {
      if (!['empty', 'representative'].includes(match[2])) {
        throw new TypeError('--fixture must be empty or representative');
      }
      options.fixtureProfile = match[2];
    } else {
      throw new TypeError(`Unknown or invalid option: ${argument}`);
    }
  }

  if (options.selfCheck) {
    options.profiles = [1];
    options.warmSamples = 1;
    options.warmupSamples = 1;
  }

  const totalClientRounds = options.profiles.reduce((sum, clients) => sum + clients, 0) *
    (1 + options.warmupSamples + options.warmSamples);
  const estimatedRequests = totalClientRounds * CORE_REFRESH_ROUTES.length;
  if (estimatedRequests > MAX_TOTAL_REQUESTS) {
    throw new TypeError(
      `This run would issue ${estimatedRequests.toLocaleString()} requests; limit is ${MAX_TOTAL_REQUESTS.toLocaleString()}`
    );
  }
  return { ...options, estimatedRequests };
}

function parseWorkerArguments(argv) {
  const options = { warmSamples: 12, warmupSamples: 3, fixtureProfile: 'empty', profile: null };
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(argument);
    if (!match) throw new TypeError(`Unknown or invalid worker option: ${argument}`);
    if (match[1] === 'worker-profile') {
      options.profile = parsePositiveInteger(match[2], '--worker-profile', {
        min: 1,
        max: MAX_CLIENTS_PER_PROFILE
      });
    } else if (match[1] === 'warm-samples') {
      options.warmSamples = parsePositiveInteger(match[2], '--warm-samples', { min: 1, max: 200 });
    } else if (match[1] === 'warmup-samples') {
      options.warmupSamples = parsePositiveInteger(match[2], '--warmup-samples', { min: 0, max: 20 });
    } else if (match[1] === 'worker-fixture') {
      if (!['empty', 'representative'].includes(match[2])) {
        throw new TypeError('--worker-fixture must be empty or representative');
      }
      options.fixtureProfile = match[2];
    } else {
      throw new TypeError(`Unknown or invalid worker option: ${argument}`);
    }
  }
  if (options.profile === null) throw new TypeError('A worker profile is required.');
  return options;
}

function extractCurrentCoreRefreshRequests(source) {
  const loadCoreIndex = source.indexOf('async function loadCore(');
  if (loadCoreIndex < 0) throw new Error('Could not find the PWA loadCore function.');

  const requestStart = source.indexOf('const requests = {', loadCoreIndex);
  if (requestStart < 0) throw new Error('Could not find the PWA core refresh request object.');
  const bodyStart = source.indexOf('{', requestStart) + 1;
  const bodyEnd = source.indexOf('};', bodyStart);
  if (bodyEnd < 0) throw new Error('Could not find the end of the PWA core refresh request object.');

  const body = source.slice(bodyStart, bodyEnd);
  const requests = {};
  const propertyPattern = /(?:^|,)\s*([A-Za-z][\w]*)\s*:\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)\s*(?=,|$)/g;
  let match;
  while ((match = propertyPattern.exec(body)) !== null) {
    requests[match[1]] = match[2] ?? match[3] ?? match[4];
  }

  const propertyCount = (body.match(/(?:^|,)\s*[A-Za-z][\w]*\s*:/g) || []).length;
  if (Object.keys(requests).length !== propertyCount) {
    throw new Error('The PWA core refresh request object has an unsupported expression or formatting change.');
  }
  return requests;
}

function assertCurrentCoreRefreshContract() {
  const source = fs.readFileSync(CORE_REFRESH_SOURCE, 'utf8');
  const requests = extractCurrentCoreRefreshRequests(source);
  assert.deepEqual(
    requests,
    EXPECTED_CORE_REFRESH_REQUESTS,
    'Update this benchmark when public/pilot-redesign.js changes the core refresh request set.'
  );
  assert.equal(CORE_REFRESH_ROUTES.length, 14);
  assert.equal(CORE_REFRESH_ROUTES.find(route => route.name === 'momentumShadow')?.path, '/api/momentum-shadow');
  assert(CORE_REFRESH_ROUTES.every(route => route.path.startsWith('/api/')));
  return requests;
}

function isInsideDirectory(root, target) {
  let resolved;
  try {
    resolved = path.resolve(Buffer.isBuffer(target) ? target.toString() : String(target));
  } catch {
    return false;
  }
  const relative = path.relative(root, resolved);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function installTemporaryFileAccessGuard(tempRoot) {
  const staticRoot = path.join(PROJECT_ROOT, 'public');
  const readOnlyCodeRoots = [
    path.join(PROJECT_ROOT, 'src'),
    path.join(PROJECT_ROOT, 'node_modules')
  ];
  const packageManifest = path.join(PROJECT_ROOT, 'package.json');
  const outsideAttempts = [];
  const operationCounts = {};
  const successfulReadFileCountsByPath = new Map();
  let publicStaticMetadataChecks = 0;
  let readOnlyCodeReads = 0;
  const restore = [];
  const metadataOnlyOperations = new Set([
    'access', 'accessSync', 'existsSync', 'lstat', 'lstatSync', 'realpath', 'realpathSync',
    'stat', 'statSync'
  ]);
  const readOnlyOperations = new Set([
    'access', 'accessSync', 'existsSync', 'lstat', 'lstatSync', 'readFile', 'readFileSync',
    'open', 'openSync', 'readdir', 'readdirSync', 'realpath', 'realpathSync', 'stat', 'statSync'
  ]);

  const openIsReadOnly = (operation, args) => {
    if (operation !== 'open' && operation !== 'openSync') return true;
    const flags = args[1];
    if (flags === undefined || flags === 'r' || flags === 'rs' || flags === 'sr') return true;
    if (typeof flags === 'number') return (flags & fs.constants.O_ACCMODE) === fs.constants.O_RDONLY;
    return typeof flags === 'string' && flags.startsWith('r') && !flags.includes('+');
  };

  const guardArguments = (operation, args) => {
    const fileArguments = operation === 'rename' || operation === 'renameSync'
      ? args.slice(0, 2)
      : args.slice(0, 1);
    for (const file of fileArguments) {
      if (typeof file !== 'string' && !Buffer.isBuffer(file) && !(file instanceof URL)) continue;
      const value = file instanceof URL ? file.pathname : file;
      if (!isInsideDirectory(tempRoot, value)) {
        if (readOnlyOperations.has(operation) && openIsReadOnly(operation, args) &&
          (readOnlyCodeRoots.some(root => isInsideDirectory(root, value)) ||
            path.resolve(value) === packageManifest)) {
          readOnlyCodeReads += 1;
          continue;
        }
        if (metadataOnlyOperations.has(operation) && isInsideDirectory(staticRoot, value)) {
          publicStaticMetadataChecks += 1;
          continue;
        }
        outsideAttempts.push(operation);
        const error = new Error('Synthetic dashboard benchmark attempted filesystem access outside its OS temporary directory.');
        error.code = 'DASHBOARD_BENCHMARK_TEMP_PATH_VIOLATION';
        throw error;
      }
      operationCounts[operation] = (operationCounts[operation] || 0) + 1;
    }
  };

  const syncOperations = [
    'accessSync', 'existsSync', 'lstatSync', 'openSync', 'readFileSync',
    'readdirSync', 'realpathSync', 'statSync', 'writeFileSync', 'appendFileSync',
    'mkdirSync', 'unlinkSync', 'rmSync', 'renameSync'
  ];
  for (const operation of syncOperations) {
    const original = fs[operation];
    if (typeof original !== 'function') continue;
    fs[operation] = function guardedSyncOperation(...args) {
      guardArguments(operation, args);
      const result = Reflect.apply(original, this, args);
      if (operation === 'readFileSync' && typeof args[0] !== 'number') {
        const rawPath = args[0] instanceof URL ? args[0].pathname : args[0];
        const resolvedPath = path.resolve(Buffer.isBuffer(rawPath) ? rawPath.toString() : String(rawPath));
        if (isInsideDirectory(tempRoot, resolvedPath)) {
          successfulReadFileCountsByPath.set(
            resolvedPath,
            (successfulReadFileCountsByPath.get(resolvedPath) || 0) + 1
          );
        }
      }
      return result;
    };
    restore.push(() => { fs[operation] = original; });
  }

  const promiseOperations = [
    'access', 'lstat', 'open', 'readFile', 'readdir', 'realpath', 'stat', 'writeFile',
    'appendFile', 'mkdir', 'unlink', 'rm', 'rename'
  ];
  for (const operation of promiseOperations) {
    const original = fs.promises?.[operation];
    if (typeof original !== 'function') continue;
    fs.promises[operation] = function guardedPromiseOperation(...args) {
      guardArguments(operation, args);
      return Reflect.apply(original, this, args);
    };
    restore.push(() => { fs.promises[operation] = original; });
  }

  const callbackOperations = [
    'access', 'lstat', 'open', 'readFile', 'readdir', 'realpath', 'stat',
    'writeFile', 'appendFile', 'mkdir', 'unlink', 'rm', 'rename'
  ];
  for (const operation of callbackOperations) {
    const original = fs[operation];
    if (typeof original !== 'function') continue;
    fs[operation] = function guardedCallbackOperation(...args) {
      guardArguments(operation, args);
      return Reflect.apply(original, this, args);
    };
    restore.push(() => { fs[operation] = original; });
  }

  return {
    evidence() {
      return {
        boundary: 'runtime data reads/writes confined to OS temp; source/dependency reads and public static metadata checks are read-only exceptions',
        outsideTempAttempts: outsideAttempts.length,
        publicStaticMetadataChecks,
        readOnlySourceDependencyReads: readOnlyCodeReads,
        guardedOperations: Object.keys(operationCounts).sort(),
        temporaryFileReadCalls: [...successfulReadFileCountsByPath.values()]
          .reduce((sum, count) => sum + count, 0),
        temporaryFileReadAttempts: operationCounts.readFileSync || 0,
        temporaryFileOperationCount: Object.values(operationCounts).reduce((sum, count) => sum + count, 0)
      };
    },
    countSuccessfulReadFileSync(filePath) {
      return successfulReadFileCountsByPath.get(path.resolve(filePath)) || 0;
    },
    restore() {
      for (const restoreOperation of restore.reverse()) restoreOperation();
    }
  };
}

function createFixtureAccounts() {
  return [
    { currency: 'KRW', balance: '1000000', locked: '0' },
    { currency: 'BTC', balance: '0.002', locked: '0', avg_buy_price: '95000000' }
  ];
}

function writeSyntheticJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), 'utf8');
}

function syntheticCohortTrade(index) {
  const entryTimeMs = Date.parse(FIXTURE_SOURCE_AS_OF) - (index + 1) * 60_000;
  const entryPrice = 10_000 + index;
  const exitPrice = entryPrice * 1.002;
  return {
    action: 'CLOSE',
    coin: 'SYNTH',
    entryPrice,
    exitPrice,
    amount: 0.01,
    profit: (exitPrice - entryPrice) * 0.01,
    entryTime: new Date(entryTimeMs).toISOString(),
    exitTime: new Date(entryTimeMs + 60_000).toISOString()
  };
}

function syntheticCohortLedger(sessionIndex) {
  return {
    schema: 'coinpilot.paper-validation.synthetic-benchmark.v1',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-10T00:00:00.000Z',
    active: false,
    state: 'stopped',
    stopReason: 'synthetic_benchmark_fixture',
    configSnapshotComplete: true,
    configSnapshot: { profile: `synthetic-${sessionIndex}`, slippage: 0.001 },
    thresholds: { minDays: 7, minTrades: 20 },
    strictTrades: [syntheticCohortTrade(sessionIndex)],
    strictOpenPositions: {},
    shadow: { closedTrades: [], positions: {} },
    looseShadow: { closedTrades: [], positions: {} },
    winnerShadow: { closedTrades: [], positions: {} }
  };
}

function syntheticShadowTrade(index) {
  const entryTimeMs = Date.parse(FIXTURE_SOURCE_AS_OF) - (index + 2) * 60_000;
  return {
    coin: 'KRW-BTC',
    market: 'KRW-BTC',
    type: 'CLOSE',
    profitPercent: index % 2 === 0 ? 0.2 : -0.1,
    profit: index % 2 === 0 ? 20 : -10,
    entry: { size: 10_000, entryTimeMs },
    exitTs: Math.floor(entryTimeMs / 86_400_000) * 86_400_000,
    executionModel: 'candle_close',
    entryPrice: 10_000,
    exitPrice: 10_020,
    amount: 1
  };
}

function syntheticShadowLedger(bookIndex) {
  return {
    initialBalance: 1_000_000,
    balance: 1_000_005,
    holdings: {},
    positions: {},
    trades: Array.from({ length: REPRESENTATIVE_SHADOW_BOOK_TRADE_COUNT }, (_, tradeIndex) =>
      syntheticShadowTrade(tradeIndex + bookIndex * REPRESENTATIVE_SHADOW_BOOK_TRADE_COUNT)),
    config: {
      mode: 'fixed',
      markets: ['KRW-BTC', 'KRW-ETH', 'KRW-XRP'],
      costPercent: 0.3,
      executionModel: 'candle_close',
      pollMs: 900_000,
      benchmarkMarket: 'KRW-BTC'
    },
    configDrift: null,
    heartbeatAt: FIXTURE_FETCHED_AT,
    runnerState: 'stopped',
    dataQuality: { valid: true, marketCount: 3 },
    observedMddSampleCount: 2,
    observedMddFullSessionCoverage: true,
    observedMddMaxDrawdownPercent: 0.5
  };
}

function createMomentumShadowResearchFixtures(tempRoot, config, fixtureProfile) {
  const paperForwardCohortRootDir = path.join(tempRoot, 'fixtures', 'paper-forward-cohort');
  fs.mkdirSync(paperForwardCohortRootDir, { recursive: true });
  const cohortSessionLedgerFiles = [];
  if (fixtureProfile === 'representative') {
    for (let index = 0; index < REPRESENTATIVE_COHORT_SESSION_COUNT; index += 1) {
      const sessionName = `.paper-forward-synthetic-${String(index).padStart(4, '0')}`;
      const ledgerFile = path.join(paperForwardCohortRootDir, sessionName, 'paper_validation.json');
      writeSyntheticJson(ledgerFile, syntheticCohortLedger(index));
      cohortSessionLedgerFiles.push(ledgerFile);
    }
  }

  const allShadowBookLedgerFiles = MOMENTUM_SHADOW_BOOK_CONFIG_KEYS.map(key =>
    path.join(config[key], 'ledger.json')
  );
  if (fixtureProfile === 'representative') {
    allShadowBookLedgerFiles.forEach((ledgerFile, index) => {
      writeSyntheticJson(ledgerFile, syntheticShadowLedger(index));
    });
  }
  const shadowBookLedgerFiles = fixtureProfile === 'representative'
    ? allShadowBookLedgerFiles
    : [];

  return {
    profile: fixtureProfile,
    paperForwardCohortRootDir,
    cohortSessionLedgerFiles,
    shadowBookLedgerFiles,
    expectedCohortSessionCount: fixtureProfile === 'representative'
      ? REPRESENTATIVE_COHORT_SESSION_COUNT
      : 0,
    expectedShadowBookCount: fixtureProfile === 'representative'
      ? MOMENTUM_SHADOW_BOOK_CONFIG_KEYS.length
      : 0,
    cohortStrictTradeRowsPerSession: fixtureProfile === 'representative'
      ? REPRESENTATIVE_COHORT_TRADES_PER_SESSION
      : 0,
    shadowTradesPerBook: fixtureProfile === 'representative'
      ? REPRESENTATIVE_SHADOW_BOOK_TRADE_COUNT
      : 0
  };
}

function makeFakeTrader(tempRoot, fixtureProfile = 'empty') {
  const fixtureFile = name => path.join(tempRoot, 'fixtures', name);
  const config = {
    targetCoin: 'KRW-BTC',
    virtualPortfolioFile: fixtureFile('virtual-portfolio.json'),
    manualOrderIdempotencyFile: fixtureFile('manual-order-idempotency.json'),
    portfolioHistoryFile: fixtureFile('portfolio-history.json'),
    scalpingValidationOutputFile: fixtureFile('scalping-validation.json'),
    benchmarkOptimizationStateFile: fixtureFile('optimization-state.json'),
    aiMonitoringFile: fixtureFile('ai-monitoring-sessions.json'),
    momentumShadowCandidateDir: fixtureFile('momentum-shadow-candidate'),
    momentumShadowFixedDir: fixtureFile('momentum-shadow-fixed'),
    momentumShadowRegimeDir: fixtureFile('momentum-shadow-regime'),
    momentumShadowBenchmarkDir: fixtureFile('momentum-shadow-benchmark'),
    momentumShadowVolatilityDir: fixtureFile('momentum-shadow-volatility'),
    momentumShadowNextOpenDir: fixtureFile('momentum-shadow-next-open'),
    momentumShadowFixedHoldDir: fixtureFile('momentum-shadow-fixed-hold'),
    momentumShadowFixedHoldLossCapDir: fixtureFile('momentum-shadow-fixed-hold-loss-cap'),
    momentumShadowFixedHoldLossCapNoDogeDir: fixtureFile('momentum-shadow-fixed-hold-loss-cap-no-doge'),
    momentumShadowFixedHoldSpreadDir: fixtureFile('momentum-shadow-fixed-hold-spread'),
    momentumShadowFixedHoldRelativeDir: fixtureFile('momentum-shadow-fixed-hold-relative'),
    momentumShadowFixedHoldQuoteCrossDir: fixtureFile('momentum-shadow-fixed-hold-quote-cross'),
    momentumShadowCandidateSlotFile: fixtureFile('momentum-shadow-candidate-slot.json'),
    momentumShadowQuoteHistoryFile: fixtureFile('momentum-shadow-quote-history.jsonl'),
    momentumShadowQuoteReportFile: fixtureFile('momentum-shadow-quote-quality.json')
  };
  const momentumShadowResearchFixtures = createMomentumShadowResearchFixtures(
    tempRoot,
    config,
    fixtureProfile
  );
  const marketCalls = { getMarkets: 0, readTickers: 0, readCandles: 0 };
  const accounts = createFixtureAccounts();
  const paperValidationStatus = {
    available: true,
    active: false,
    state: 'stopped',
    baselineAssets: 1_000_000,
    currentAssets: 1_000_200,
    realizedProfit: 200,
    lastSnapshotAt: FIXTURE_FETCHED_AT,
    heartbeatAt: FIXTURE_FETCHED_AT,
    strictEvaluation: { positions: [] }
  };
  const paperValidationLedger = {
    snapshots: [
      { timestamp: FIXTURE_FETCHED_AT, totalAssets: 1_000_200, sourceAsOf: FIXTURE_SOURCE_AS_OF, fetchedAt: FIXTURE_FETCHED_AT },
      { timestamp: '2026-09-28T23:55:00.000Z', totalAssets: 1_000_100, sourceAsOf: FIXTURE_SOURCE_AS_OF, fetchedAt: FIXTURE_FETCHED_AT }
    ]
  };

  const upbit = {
    async getMarkets() {
      marketCalls.getMarkets += 1;
      return FIXTURE_MARKETS.map(market => ({ market }));
    }
  };

  const marketDataProvider = new MarketDataProvider({
    async readMarkets() {
      marketCalls.getMarkets += 1;
      return FIXTURE_MARKETS.map(market => ({ market }));
    },
    async readTickers(markets) {
      marketCalls.readTickers += 1;
      const requestedMarkets = Array.isArray(markets) ? markets : [markets];
      return {
        tickers: requestedMarkets.map(market => ({
          market,
          trade_price: MARKET_PRICE_BY_MARKET[market] || 10_000,
          signed_change_rate: 0.002,
          signed_change_price: 200,
          high_price: (MARKET_PRICE_BY_MARKET[market] || 10_000) * 1.01,
          low_price: (MARKET_PRICE_BY_MARKET[market] || 10_000) * 0.99,
          acc_trade_volume_24h: 12,
          acc_trade_price_24h: 1_200_000,
          trade_timestamp: Date.parse(FIXTURE_SOURCE_AS_OF)
        })),
        fetchedAt: FIXTURE_FETCHED_AT
      };
    },
    async readCandles() {
      marketCalls.readCandles += 1;
      return [];
    }
  });

  const trader = {
    readOnlyObserver: true,
    dryRun: true,
    isRunning: false,
    strategyMode: 'synthetic_read_capacity',
    isScalpingMode: true,
    maxPositions: 1,
    targetCoins: [...FIXTURE_MARKETS],
    strategies: new Map(),
    smartTradeHistory: [],
    newsData: [],
    virtualPortfolioFile: config.virtualPortfolioFile,
    liveExecutionEvidenceFile: fixtureFile('live-execution-evidence.jsonl'),
    config,
    upbit,
    virtualPortfolio: { krwBalance: 1_000_000, holdings: new Map() },
    getRuntimeSafetyStatus() {
      return {
        runtimeState: 'STOPPED',
        entriesPaused: true,
        protectiveMonitorActive: false,
        stopReason: 'synthetic_benchmark',
        exchangeStateKnown: true
      };
    },
    getLossCircuitBreakerStatus() {
      return { active: false, count: 0, remainingMs: 0 };
    },
    async getAccountInfo() {
      return accounts.map(account => ({ ...account }));
    },
    getKRWBalance(rows) {
      return Number(rows.find(account => account.currency === 'KRW')?.balance || 0);
    },
    async calculateCumulativePnL({ priceMapOverride = new Map(), accountsOverride = accounts } = {}) {
      const krwBalance = this.getKRWBalance(accountsOverride);
      const coinValue = accountsOverride.reduce((sum, account) => {
        if (account.currency === 'KRW') return sum;
        const amount = Number(account.balance || 0) + Number(account.locked || 0);
        return sum + amount * Number(priceMapOverride.get(`KRW-${account.currency}`) || 0);
      }, 0);
      const totalAssets = krwBalance + coinValue;
      const initialSeedMoney = 1_200_000;
      return {
        initialSeedMoney,
        totalAssets,
        profit: totalAssets - initialSeedMoney,
        profitPercent: (totalAssets / initialSeedMoney - 1) * 100,
        valuationAvailable: true,
        valuationStatus: 'available',
        mode: 'DRY_RUN'
      };
    },
    async getPaperValidationStatus() {
      return structuredClone(paperValidationStatus);
    },
    readPaperValidationLedger() {
      return structuredClone(paperValidationLedger);
    }
  };

  return { trader, marketDataProvider, marketCalls, momentumShadowResearchFixtures };
}

function createDashboardEnvironment(tempRoot) {
  return {
    DASHBOARD_TOKEN: SYNTHETIC_DASHBOARD_TOKEN,
    DASHBOARD_READ_ONLY_TOKEN: '',
    DASHBOARD_HOST: '127.0.0.1',
    DASHBOARD_ALLOW_INSECURE: '',
    DASHBOARD_CORS_ORIGINS: '',
    DASHBOARD_TLS_CERT_FILE: '',
    DASHBOARD_TLS_KEY_FILE: '',
    STAGING_OUTPUT_DIR: path.join(tempRoot, 'staging')
  };
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(ordered.length * fraction) - 1);
  return Number(ordered[index].toFixed(3));
}

function summarizeDelay(histogram) {
  const toMilliseconds = value => Number.isFinite(value) ? Number((value / 1e6).toFixed(3)) : null;
  return {
    p50Ms: toMilliseconds(histogram.percentile(50)),
    p95Ms: toMilliseconds(histogram.percentile(95)),
    p99Ms: toMilliseconds(histogram.percentile(99)),
    maxMs: toMilliseconds(histogram.max)
  };
}

function summarizeRecords(records, durationMs) {
  const latencyValues = records.map(record => record.latencyMs);
  const byteValues = records.map(record => record.responseBytes);
  const errors = records.filter(record => record.error !== null);
  const statusCounts = {};
  const errorCounts = {};
  for (const error of errors) {
    const statusKey = error.statusCode === null ? 'transport' : String(error.statusCode);
    statusCounts[statusKey] = (statusCounts[statusKey] || 0) + 1;
    const errorKey = error.error || 'http_error';
    errorCounts[errorKey] = (errorCounts[errorKey] || 0) + 1;
  }
  const totalBytes = byteValues.reduce((sum, value) => sum + value, 0);
  return {
    requestCount: records.length,
    errorCount: errors.length,
    statusCounts,
    errorCounts,
    latencyMs: {
      p50: percentile(latencyValues, 0.50),
      p95: percentile(latencyValues, 0.95),
      p99: percentile(latencyValues, 0.99),
      max: latencyValues.length ? Number(Math.max(...latencyValues).toFixed(3)) : null
    },
    responseBytes: {
      total: totalBytes,
      mean: byteValues.length ? Number((totalBytes / byteValues.length).toFixed(1)) : null,
      p50: percentile(byteValues, 0.50),
      p95: percentile(byteValues, 0.95),
      p99: percentile(byteValues, 0.99)
    },
    measuredDurationMs: Number(durationMs.toFixed(3)),
    requestsPerSecond: durationMs > 0 ? Number((records.length / (durationMs / 1000)).toFixed(2)) : null
  };
}

function summarizeRoutes(records) {
  return CORE_REFRESH_ROUTES.map(route => {
    const routeRecords = records.filter(record => record.routeName === route.name);
    const summary = {
      name: route.name,
      method: 'GET',
      path: route.path,
      ...summarizeRecords(routeRecords, 0)
    };
    if (route.name === 'momentumShadow') {
      summary.projection = {
        cohortSessionCounts: [...new Set(routeRecords.map(record => record.projectionEvidence?.cohortSessionCount))],
        visibleBookCounts: [...new Set(routeRecords.map(record => record.projectionEvidence?.visibleBookCount))]
      };
    }
    return summary;
  });
}

function createClientAgent() {
  return new http.Agent({
    keepAlive: true,
    maxSockets: CORE_REQUESTS_PER_CLIENT,
    maxFreeSockets: CORE_REQUESTS_PER_CLIENT
  });
}

function requestJson({
  port,
  agent,
  route,
  expectedCohortSessionCount,
  expectedVisibleBookCount
}) {
  const startedAt = performance.now();
  return new Promise(resolve => {
    let settled = false;
    const finish = record => {
      if (settled) return;
      settled = true;
      resolve({ routeName: route.name, ...record });
    };
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: route.path,
      method: 'GET',
      agent,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${SYNTHETIC_DASHBOARD_TOKEN}`
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', error => finish({
        statusCode: response.statusCode || null,
        latencyMs: Number((performance.now() - startedAt).toFixed(3)),
        responseBytes: chunks.reduce((total, chunk) => total + chunk.length, 0),
        error: error.name || 'ResponseError'
      }));
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        let error = null;
        let parsedBody = null;
        try {
          parsedBody = JSON.parse(body.toString('utf8'));
        } catch {
          error = 'invalid_json';
        }
        if (!error && (response.statusCode < 200 || response.statusCode >= 300)) {
          error = 'http_error';
        }
        let projectionEvidence = null;
        if (!error && route.name === 'momentumShadow') {
          projectionEvidence = {
            cohortSessionCount: parsedBody?.paperForwardCohort?.sessionCount ?? null,
            visibleBookCount: Array.isArray(parsedBody?.books) ? parsedBody.books.length : null
          };
          if (projectionEvidence.cohortSessionCount !== expectedCohortSessionCount ||
            projectionEvidence.visibleBookCount !== expectedVisibleBookCount) {
            error = 'projection_contract_mismatch';
          }
        }
        finish({
          statusCode: response.statusCode || null,
          latencyMs: Number((performance.now() - startedAt).toFixed(3)),
          responseBytes: body.length,
          projectionEvidence,
          error
        });
      });
    });
    request.setTimeout(30_000, () => request.destroy(new Error('request_timeout')));
    request.on('error', error => finish({
      statusCode: null,
      latencyMs: Number((performance.now() - startedAt).toFixed(3)),
      responseBytes: 0,
      error: error.message === 'request_timeout' ? 'request_timeout' : (error.code || error.name || 'transport_error')
    }));
    request.end();
  });
}

async function runRefreshWave({
  port,
  agents,
  expectedCohortSessionCount,
  expectedVisibleBookCount
}) {
  const startedAt = performance.now();
  const requests = agents.flatMap(agent => CORE_REFRESH_ROUTES.map(route =>
    requestJson({
      port,
      agent,
      route,
      expectedCohortSessionCount,
      expectedVisibleBookCount
    })
  ));
  const records = await Promise.all(requests);
  return { records, durationMs: performance.now() - startedAt };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function measureRefreshSeries({
  port,
  agents,
  samples,
  expectedCohortSessionCount,
  expectedVisibleBookCount
}) {
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  await delay(20);
  histogram.reset();
  const startedAt = performance.now();
  const records = [];
  const roundDurationsMs = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const result = await runRefreshWave({
      port,
      agents,
      expectedCohortSessionCount,
      expectedVisibleBookCount
    });
    records.push(...result.records);
    roundDurationsMs.push(Number(result.durationMs.toFixed(3)));
  }
  const durationMs = performance.now() - startedAt;
  await delay(20);
  histogram.disable();

  return {
    summary: summarizeRecords(records, durationMs),
    perRoute: summarizeRoutes(records),
    eventLoopDelay: summarizeDelay(histogram),
    roundDurationsMs,
    records
  };
}

function summarizeMomentumShadowFixtureReads(pathGuard, fixture, routeRecords, clientCount, options) {
  const routeRequestCount = clientCount * (1 + options.warmupSamples + options.warmSamples);
  const countReads = files => files.map(file => pathGuard.countSuccessfulReadFileSync(file));
  const cohortReadCounts = countReads(fixture.cohortSessionLedgerFiles);
  const bookReadCounts = countReads(fixture.shadowBookLedgerFiles);
  const cohortFilesRead = cohortReadCounts.filter(count => count > 0).length;
  const shadowBookLedgersRead = bookReadCounts.filter(count => count > 0).length;
  const projectionEvidence = routeRecords.map(record => record.projectionEvidence).filter(Boolean);
  return {
    fixtureProfile: fixture.profile,
    routeProjection: {
      reportedCohortSessionCounts: [...new Set(projectionEvidence.map(item => item.cohortSessionCount))],
      visiblePrimaryBookCounts: [...new Set(projectionEvidence.map(item => item.visibleBookCount))]
    },
    cohort: {
      expectedSessionCount: fixture.expectedCohortSessionCount,
      reportedSessionCounts: [...new Set(projectionEvidence.map(item => item.cohortSessionCount))],
      fixtureLedgerFilesRead: cohortFilesRead,
      fixtureLedgerFileReadCalls: cohortReadCounts.reduce((sum, count) => sum + count, 0),
      ledgerReadCallsPerMomentumShadowRequest: routeRequestCount > 0
        ? Number((cohortReadCounts.reduce((sum, count) => sum + count, 0) / routeRequestCount).toFixed(2))
        : 0,
      strictTradeRowsPerSession: fixture.cohortStrictTradeRowsPerSession
    },
    shadowBooks: {
      expectedFixtureLedgerCount: fixture.expectedShadowBookCount,
      fixtureLedgerFilesRead: shadowBookLedgersRead,
      fixtureLedgerFileReadCalls: bookReadCounts.reduce((sum, count) => sum + count, 0),
      ledgerReadCallsPerMomentumShadowRequest: routeRequestCount > 0
        ? Number((bookReadCounts.reduce((sum, count) => sum + count, 0) / routeRequestCount).toFixed(2))
        : 0,
      closedTradesPerFixtureLedger: fixture.shadowTradesPerBook,
      visiblePrimaryBooksInRouteResponse: MOMENTUM_SHADOW_ROUTE_BOOK_COUNT
    },
    momentumShadowRequestCount: routeRequestCount
  };
}

function assertBoundedMomentumShadowFixtureReads(readSummary, expectedFileCount, requestCount) {
  assert.equal(readSummary.fixtureLedgerFilesRead, expectedFileCount);
  if (expectedFileCount === 0) {
    assert.equal(readSummary.fixtureLedgerFileReadCalls, 0);
    assert.equal(readSummary.ledgerReadCallsPerMomentumShadowRequest, 0);
    return;
  }
  assert(readSummary.fixtureLedgerFileReadCalls >= expectedFileCount);
  assert(readSummary.fixtureLedgerFileReadCalls <= expectedFileCount * requestCount);
  assert(readSummary.ledgerReadCallsPerMomentumShadowRequest <= expectedFileCount);
}

async function runWorker(profile, options) {
  assertCurrentCoreRefreshContract();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-dashboard-read-capacity-'));
  const fixtureRoot = path.join(tempRoot, 'fixtures');
  const paperForwardCohortRootDir = path.join(fixtureRoot, 'paper-forward-cohort');
  fs.mkdirSync(fixtureRoot, { recursive: true });
  fs.mkdirSync(paperForwardCohortRootDir, { recursive: true });

  const pathGuard = installTemporaryFileAccessGuard(tempRoot);
  let dashboard = null;
  let agents = [];
  let result;
  try {
    const {
      trader,
      marketDataProvider,
      marketCalls,
      momentumShadowResearchFixtures
    } = makeFakeTrader(tempRoot, options.fixtureProfile);
    dashboard = new BenchmarkDashboardServer(trader, 0, {
      env: createDashboardEnvironment(tempRoot),
      marketDataProvider,
      paperForwardCohortRootDir: momentumShadowResearchFixtures.paperForwardCohortRootDir
    });
    await dashboard.start();
    const address = dashboard.httpServer.address();
    assert(address && typeof address === 'object' && address.port > 0, 'Dashboard must bind an ephemeral port.');
    const port = address.port;
    agents = Array.from({ length: profile }, () => createClientAgent());

    const cold = await measureRefreshSeries({
      port,
      agents,
      samples: 1,
      expectedCohortSessionCount: momentumShadowResearchFixtures.expectedCohortSessionCount,
      expectedVisibleBookCount: MOMENTUM_SHADOW_ROUTE_BOOK_COUNT
    });
    const warmupRecords = [];
    for (let sample = 0; sample < options.warmupSamples; sample += 1) {
      const warmup = await runRefreshWave({
        port,
        agents,
        expectedCohortSessionCount: momentumShadowResearchFixtures.expectedCohortSessionCount,
        expectedVisibleBookCount: MOMENTUM_SHADOW_ROUTE_BOOK_COUNT
      });
      warmupRecords.push(...warmup.records);
    }
    const warm = await measureRefreshSeries({
      port,
      agents,
      samples: options.warmSamples,
      expectedCohortSessionCount: momentumShadowResearchFixtures.expectedCohortSessionCount,
      expectedVisibleBookCount: MOMENTUM_SHADOW_ROUTE_BOOK_COUNT
    });

    result = {
      clients: profile,
      clientModel: `${CORE_REQUESTS_PER_CLIENT} keep-alive HTTP/1.1 sockets per logical client; all clients refresh concurrently`,
      cold: {
        ...cold.summary,
        perRoute: cold.perRoute,
        eventLoopDelay: cold.eventLoopDelay,
        samples: 1,
        roundDurationsMs: cold.roundDurationsMs
      },
      warmup: {
        samples: options.warmupSamples,
        requestCount: warmupRecords.length,
        errorCount: warmupRecords.filter(record => record.error !== null).length
      },
      warm: {
        ...warm.summary,
        perRoute: warm.perRoute,
        eventLoopDelay: warm.eventLoopDelay,
        samples: options.warmSamples,
        roundDurationsMs: warm.roundDurationsMs
      },
      fixture: {
        source: 'fake trader and MarketDataProvider; fixed synthetic account, ledger, market list, and ticker rows',
        momentumShadow: summarizeMomentumShadowFixtureReads(
          pathGuard,
          momentumShadowResearchFixtures,
          [...cold.records, ...warmupRecords, ...warm.records]
            .filter(record => record.routeName === 'momentumShadow'),
          profile,
          options
        ),
        marketProviderReads: marketCalls.readTickers,
        marketListReads: marketCalls.getMarkets,
        candleReads: marketCalls.readCandles,
        externalMarketCalls: 0,
        ordersSubmitted: 0,
        dashboardWriterLock: 'not acquired; read-only observer'
      },
      filesystemFence: null
    };

    const expectedCohortSessionCount = momentumShadowResearchFixtures.expectedCohortSessionCount;
    const routeEvidence = result.fixture.momentumShadow.routeProjection;
    assert.deepEqual(routeEvidence.reportedCohortSessionCounts, [expectedCohortSessionCount]);
    assert.deepEqual(routeEvidence.visiblePrimaryBookCounts, [MOMENTUM_SHADOW_ROUTE_BOOK_COUNT]);
    assert.equal(result.fixture.externalMarketCalls, 0);
    assert.equal(result.fixture.ordersSubmitted, 0);
    const momentumShadow = result.fixture.momentumShadow;
    if (options.fixtureProfile === 'representative') {
      assertBoundedMomentumShadowFixtureReads(
        momentumShadow.cohort,
        REPRESENTATIVE_COHORT_SESSION_COUNT,
        momentumShadow.momentumShadowRequestCount
      );
      assertBoundedMomentumShadowFixtureReads(
        momentumShadow.shadowBooks,
        MOMENTUM_SHADOW_BOOK_CONFIG_KEYS.length,
        momentumShadow.momentumShadowRequestCount
      );
    }
  } finally {
    for (const agent of agents) agent.destroy();
    try {
      if (dashboard) {
        try {
          await dashboard.stop();
        } finally {
          await dashboard.logger.flush();
        }
      }
    } finally {
      if (result) result.filesystemFence = pathGuard.evidence();
      pathGuard.restore();
      fs.rmSync(tempRoot, { recursive: true, force: true });
      if (result) {
        result.filesystemFence.temporaryDirectoryRemoved = !fs.existsSync(tempRoot);
      }
    }
  }

  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`);
  if (result.filesystemFence.outsideTempAttempts !== 0 || result.warmup.errorCount !== 0 ||
    result.cold.errorCount !== 0 || result.warm.errorCount !== 0 ||
    result.filesystemFence.temporaryDirectoryRemoved !== true) {
    process.exitCode = 1;
  }
}

function createWorkerEnvironment() {
  return {
    PATH: process.env.PATH || '',
    NODE_ENV: 'test',
    TZ: 'UTC',
    DASHBOARD_TOKEN: SYNTHETIC_DASHBOARD_TOKEN,
    DASHBOARD_READ_ONLY_TOKEN: '',
    DASHBOARD_HOST: '127.0.0.1',
    DASHBOARD_ALLOW_INSECURE: '',
    DASHBOARD_CORS_ORIGINS: '',
    DASHBOARD_TLS_CERT_FILE: '',
    DASHBOARD_TLS_KEY_FILE: '',
    SCALP_VALIDATION_OUTPUT_FILE: '',
    MOMO_SHADOW_OWNER_DIRS: '',
    LIVE_EXECUTION_EVIDENCE_FILE: '',
    STAGING_OUTPUT_DIR: ''
  };
}

function runProfileWorker(profile, options) {
  const child = spawnSync(process.execPath, [
    SCRIPT_PATH,
    `--worker-profile=${profile}`,
    `--worker-fixture=${options.fixtureProfile}`,
    `--warm-samples=${options.warmSamples}`,
    `--warmup-samples=${options.warmupSamples}`
  ], {
    encoding: 'utf8',
    env: createWorkerEnvironment(),
    timeout: 300_000,
    maxBuffer: 12 * 1024 * 1024
  });
  if (child.error) throw child.error;
  const resultLine = (child.stdout || '').split(/\r?\n/).find(line => line.startsWith(RESULT_PREFIX));
  if (!resultLine) {
    throw new Error(`Benchmark worker ${profile} did not return results (exit ${child.status}): ${(child.stderr || child.stdout || '').slice(-2_000)}`);
  }
  const result = JSON.parse(resultLine.slice(RESULT_PREFIX.length));
  if (child.status !== 0) result.workerExitCode = child.status;
  return result;
}

function buildFinalReport(options, profiles) {
  const measuredRequests = CORE_REFRESH_ROUTES.map(({ name, path: requestPath }) => ({
    name,
    method: 'GET',
    path: requestPath
  }));
  return {
    benchmark: 'dashboard-read-capacity-local-synthetic',
    generatedAt: new Date().toISOString(),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch
    },
    scope: {
      fixture: 'synthetic only',
      fixtureProfile: options.fixtureProfile,
      listener: 'ephemeral 127.0.0.1 HTTP port',
      upstreamMarketData: 'fake provider; no Upbit network calls',
      externalMarketCalls: 0,
      mutations: 'GET requests only; read-only observer; zero orders submitted',
      filesystem: 'runtime data reads/writes confined to OS temp; source/dependency reads and public static metadata checks are read-only exceptions',
      responseBytesDefinition: 'response body bytes; excludes HTTP headers',
      eventLoopDelayResolutionMs: 10,
      productionCapacityClaim: false,
      slo: false,
      targetThresholdsDefined: false
    },
    coreRefreshSet: {
      source: 'public/pilot-redesign.js loadCore() requests object',
      currentRequestCount: Object.keys(EXPECTED_CORE_REFRESH_REQUESTS).length,
      measuredRequestCount: measuredRequests.length,
      measuredRequests,
      omittedRequests: [],
      defaultPeriodExpansion: 'history period=24h',
      profiles: options.profiles,
      measuredRequestsPerClient: CORE_REFRESH_ROUTES.length,
      estimatedRequests: options.estimatedRequests,
      coldDefinition: 'one first full refresh per profile in a fresh worker process and server',
      warmDefinition: `${options.warmupSamples} unreported full refresh rounds, then ${options.warmSamples} measured rounds per profile`
    },
    profiles
  };
}

function assertSelfCheckReport(report) {
  assert.equal(report.coreRefreshSet.currentRequestCount, 14);
  assert.equal(report.coreRefreshSet.measuredRequestCount, 14);
  assert.deepEqual(report.coreRefreshSet.omittedRequests, []);
  assert.deepEqual(report.profiles.map(profile => profile.clients), [1]);
  const profile = report.profiles[0];
  assert.equal(profile.cold.requestCount, CORE_REFRESH_ROUTES.length);
  assert.equal(profile.warm.requestCount, CORE_REFRESH_ROUTES.length);
  assert.equal(profile.cold.errorCount, 0);
  assert.equal(profile.warm.errorCount, 0);
  assert.equal(profile.warmup.errorCount, 0);
  assert.equal(profile.filesystemFence.outsideTempAttempts, 0);
  assert.equal(profile.filesystemFence.temporaryDirectoryRemoved, true);
  assert(profile.cold.perRoute.every(route => route.errorCount === 0));
  assert(profile.warm.perRoute.every(route => route.errorCount === 0));
  assert(profile.cold.perRoute.some(route => route.path === '/api/momentum-shadow'));
  assert(profile.warm.perRoute.some(route => route.path === '/api/momentum-shadow'));
  assert(profile.fixture.marketProviderReads > 0);
  assert(profile.fixture.marketListReads > 0);
  assert.equal(profile.fixture.externalMarketCalls, 0);
  assert.equal(profile.fixture.ordersSubmitted, 0);
  assert.equal(profile.fixture.dashboardWriterLock, 'not acquired; read-only observer');
  const momentumShadow = profile.fixture.momentumShadow;
  const expectedSessions = report.scope.fixtureProfile === 'representative'
    ? REPRESENTATIVE_COHORT_SESSION_COUNT
    : 0;
  const expectedFixtureBooks = report.scope.fixtureProfile === 'representative'
    ? MOMENTUM_SHADOW_BOOK_CONFIG_KEYS.length
    : 0;
  assert.deepEqual(momentumShadow.routeProjection.reportedCohortSessionCounts, [expectedSessions]);
  assert.deepEqual(momentumShadow.routeProjection.visiblePrimaryBookCounts, [MOMENTUM_SHADOW_ROUTE_BOOK_COUNT]);
  assertBoundedMomentumShadowFixtureReads(
    momentumShadow.cohort,
    expectedSessions,
    momentumShadow.momentumShadowRequestCount
  );
  assertBoundedMomentumShadowFixtureReads(
    momentumShadow.shadowBooks,
    expectedFixtureBooks,
    momentumShadow.momentumShadowRequestCount
  );
  if (report.scope.fixtureProfile === 'representative') {
    assert.equal(momentumShadow.shadowBooks.expectedFixtureLedgerCount, MOMENTUM_SHADOW_BOOK_CONFIG_KEYS.length);
  }
}

async function main() {
  if (process.argv.some(argument => argument.startsWith('--worker-profile='))) {
    const options = parseWorkerArguments(process.argv.slice(2));
    await runWorker(options.profile, options);
    return;
  }

  assertCurrentCoreRefreshContract();
  const options = parseParentArguments(process.argv.slice(2));
  const profiles = [];
  for (const clientCount of options.profiles) {
    profiles.push(runProfileWorker(clientCount, options));
  }
  const report = buildFinalReport(options, profiles);
  if (options.selfCheck) assertSelfCheckReport(report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  const hasFailures = profiles.some(profile => profile.workerExitCode !== undefined ||
    profile.cold.errorCount > 0 || profile.warm.errorCount > 0 ||
    profile.warmup.errorCount > 0 || profile.filesystemFence.outsideTempAttempts > 0);
  if (hasFailures) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`Dashboard read capacity benchmark failed: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
