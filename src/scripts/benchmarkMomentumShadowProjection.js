import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import createResearchRoutes from '../api/routes/research.js';

const DEFAULTS = Object.freeze({
  coldSamples: 5,
  warmSamples: 20,
  warmupSamples: 3,
  cohortSessions: 25,
  cohortTrades: 200,
  bookTrades: 50
});

const LIMITS = Object.freeze({
  coldSamples: 20,
  warmSamples: 200,
  warmupSamples: 20,
  cohortSessions: 250,
  cohortTrades: 20_000,
  bookTrades: 2_000
});
const MAX_TOTAL_SYNTHETIC_TRADES = 300_000;

const BOOKS = Object.freeze([
  ['momentumShadowFixedDir', 'baseline'],
  ['momentumShadowRegimeDir', 'regime'],
  ['momentumShadowBenchmarkDir', 'benchmark'],
  ['momentumShadowVolatilityDir', 'volatility'],
  ['momentumShadowNextOpenDir', 'next-open'],
  ['momentumShadowFixedHoldDir', 'fixed-2d'],
  ['momentumShadowFixedHoldLossCapDir', 'fixed-2d-loss-cap'],
  ['momentumShadowFixedHoldLossCapNoDogeDir', 'fixed-2d-loss-cap-no-doge'],
  ['momentumShadowFixedHoldSpreadDir', 'fixed-2d-spread'],
  ['momentumShadowFixedHoldRelativeDir', 'fixed-2d-relative'],
  ['momentumShadowFixedHoldQuoteCrossDir', 'fixed-2d-quote-cross']
]);

const GUARDED_SYNC_READS = [
  'existsSync', 'readFileSync', 'readdirSync', 'statSync', 'lstatSync',
  'accessSync', 'openSync', 'realpathSync'
];

function printUsage() {
  process.stdout.write([
    'Synthetic-only GET /api/momentum-shadow projection benchmark.',
    '',
    'Options (all counts must be positive integers):',
    '  --cold-samples=N       Fresh router/root first-request trials (default 5, max 20)',
    '  --warm-samples=N       Repeated warm-root trials (default 20, max 200)',
    '  --warmup-samples=N     Unreported warmup requests (default 3, max 20)',
    '  --cohort-sessions=N    Synthetic .paper-forward-* sessions per root (default 25, max 250)',
    '  --cohort-trades=N      Synthetic strict trades per cohort session (default 200, max 20000)',
    '  --book-trades=N        Synthetic closed trades per shadow book (default 50, max 2000)',
    '  --help                 Show this help',
    '',
    'The route is served only on an ephemeral 127.0.0.1 port. All file reads are',
    'fenced to generated OS-temporary fixtures; this is not a production SLO test.'
  ].join('\n') + '\n');
}

function parseArguments(argv) {
  const options = { ...DEFAULTS };
  const optionNames = new Map([
    ['cold-samples', 'coldSamples'],
    ['warm-samples', 'warmSamples'],
    ['warmup-samples', 'warmupSamples'],
    ['cohort-sessions', 'cohortSessions'],
    ['cohort-trades', 'cohortTrades'],
    ['book-trades', 'bookTrades']
  ]);

  for (const argument of argv) {
    if (argument === '--help' || argument === '-h') {
      printUsage();
      process.exit(0);
    }
    const match = /^--([a-z-]+)=(\d+)$/.exec(argument);
    if (!match || !optionNames.has(match[1])) {
      throw new Error(`Unknown or invalid option: ${argument}`);
    }
    const name = optionNames.get(match[1]);
    const value = Number(match[2]);
    if (!Number.isSafeInteger(value) || value < 1 || value > LIMITS[name]) {
      throw new Error(`--${match[1]} must be between 1 and ${LIMITS[name]}`);
    }
    options[name] = value;
  }
  const fixtureCount = options.coldSamples + 1;
  const totalSyntheticTrades = fixtureCount * (
    options.cohortSessions * options.cohortTrades + BOOKS.length * options.bookTrades
  );
  if (totalSyntheticTrades > MAX_TOTAL_SYNTHETIC_TRADES) {
    throw new Error(
      `This run would materialize ${totalSyntheticTrades.toLocaleString()} trades across all fixtures; limit is ${MAX_TOTAL_SYNTHETIC_TRADES.toLocaleString()}`
    );
  }
  return options;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
}

function syntheticStrictTrade(index) {
  const entryPrice = 10_000 + index;
  const exitPrice = entryPrice * 1.002;
  return {
    action: 'CLOSE',
    coin: 'SYNTH',
    entryPrice,
    exitPrice,
    amount: 0.01,
    profit: (exitPrice - entryPrice) * 0.01,
    entryTime: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
    exitTime: new Date(Date.UTC(2026, 0, 1) + (index + 1) * 60_000).toISOString()
  };
}

function syntheticShadowTrade(index) {
  const entryTimeMs = Date.now() - (index + 2) * 60_000;
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

function syntheticShadowLedger(tradeCount, index) {
  return {
    initialBalance: 1_000_000,
    balance: 1_000_000 + tradeCount,
    holdings: {},
    positions: {},
    trades: Array.from({ length: tradeCount }, (_, tradeIndex) =>
      syntheticShadowTrade(tradeIndex + index * tradeCount)),
    config: {
      mode: 'fixed',
      markets: ['KRW-BTC', 'KRW-ETH', 'KRW-XRP'],
      costPercent: 0.3,
      executionModel: 'candle_close',
      pollMs: 900_000,
      benchmarkMarket: 'KRW-BTC'
    },
    configDrift: null,
    heartbeatAt: new Date().toISOString(),
    runnerState: 'stopped',
    dataQuality: { valid: true, marketCount: 3 },
    observedMddSampleCount: 2,
    observedMddFullSessionCoverage: true,
    observedMddMaxDrawdownPercent: 0.5
  };
}

function syntheticPaperValidation(sessionIndex, tradeCount) {
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
    strictTrades: Array.from({ length: tradeCount }, (_, tradeIndex) =>
      syntheticStrictTrade(tradeIndex)),
    strictOpenPositions: {},
    shadow: { closedTrades: [], positions: {} },
    looseShadow: { closedTrades: [], positions: {} },
    winnerShadow: { closedTrades: [], positions: {} }
  };
}

function syntheticQuoteQualityReport() {
  const markets = Object.fromEntries(['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL'].map(market => [market, {
    sampleCount: 5,
    p95: 0.1,
    max: 0.12,
    overCeiling: 0,
    topOfBookDepth: {
      requestedSampleCount: 5,
      bidSampleCount: 5,
      askSampleCount: 5,
      minimumBidNotionalKrw: 100_000,
      minimumAskNotionalKrw: 100_000
    }
  }]));
  return {
    generatedAt: new Date().toISOString(),
    complete: true,
    requestedSampleCount: 5,
    samples: Array.from({ length: 5 }, () => ({ quotes: [] })),
    errors: [],
    maxSpreadPercent: 0.5,
    summary: {
      valid: true,
      sampleCount: 5,
      maxSpreadPercent: 0.5,
      overall: { median: 0.08, p95: 0.12, max: 0.12 },
      markets
    }
  };
}

function syntheticQuoteHistory() {
  const records = [];
  const markets = Object.fromEntries(['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL'].map(market => [market, {
    sampleCount: 5,
    p95: 0.1,
    overCeiling: 0,
    topOfBookDepth: {
      requestedSampleCount: 5,
      bidSampleCount: 5,
      askSampleCount: 5,
      minimumBidNotionalKrw: 100_000,
      minimumAskNotionalKrw: 100_000
    }
  }]));
  for (let index = 0; index < 72; index += 1) {
    records.push({
      generatedAt: new Date(Date.now() - (71 - index) * 600_000).toISOString(),
      complete: true,
      errors: 0,
      sampleCount: 5,
      requestedSampleCount: 5,
      summary: { markets }
    });
  }
  return records.map(record => JSON.stringify(record)).join('\n');
}

function createFixture(rootDir, options, fixtureName) {
  const fixtureRoot = path.join(rootDir, fixtureName);
  const artifactsDir = path.join(fixtureRoot, 'artifacts');
  const cohortRoot = path.join(fixtureRoot, 'paper-cohort');
  const bookDirs = BOOKS.map(([, name]) => path.join(fixtureRoot, 'books', name));
  const ownerDirs = bookDirs.slice(0, 11);
  const candidateDir = path.join(fixtureRoot, 'candidate-target');
  const quoteHistoryFile = path.join(artifactsDir, 'quote-history.jsonl');
  const quoteReportFile = path.join(artifactsDir, 'quote-quality.json');
  const liveEvidenceFile = path.join(artifactsDir, 'live-execution-evidence.jsonl');
  const candidateSlotFile = path.join(artifactsDir, 'candidate-slot.json');

  for (let index = 0; index < options.cohortSessions; index += 1) {
    const sessionDir = path.join(cohortRoot, `.paper-forward-synthetic-${String(index).padStart(4, '0')}`);
    writeJson(path.join(sessionDir, 'paper_validation.json'), syntheticPaperValidation(index, options.cohortTrades));
  }

  for (let index = 0; index < bookDirs.length; index += 1) {
    writeJson(path.join(bookDirs[index], 'ledger.json'), syntheticShadowLedger(options.bookTrades, index));
  }

  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.writeFileSync(quoteHistoryFile, syntheticQuoteHistory(), 'utf8');
  writeJson(quoteReportFile, syntheticQuoteQualityReport());
  fs.writeFileSync(liveEvidenceFile, '', 'utf8');
  writeJson(candidateSlotFile, {});

  const config = {
    momentumShadowCandidateDir: candidateDir,
    momentumShadowBenchmarkDir: bookDirs[2],
    momentumShadowQuoteHistoryFile: quoteHistoryFile,
    momentumShadowQuoteReportFile: quoteReportFile,
    momentumShadowCandidateSlotFile: candidateSlotFile,
    momentumShadowMinTrades: 20,
    momentumShadowMinResearchDays: 7
  };
  BOOKS.forEach(([configKey], index) => { config[configKey] = bookDirs[index]; });
  const server = {
    tradingSystem: {
      config,
      dryRun: true,
      liveExecutionEvidenceFile: liveEvidenceFile
    }
  };

  const redirectedPaths = [
    fixtureRoot,
    cohortRoot,
    candidateDir,
    quoteHistoryFile,
    quoteReportFile,
    liveEvidenceFile,
    candidateSlotFile,
    ...bookDirs,
    ...ownerDirs
  ];
  for (const item of redirectedPaths) {
    assertContained(rootDir, item);
  }

  return {
    fixtureRoot,
    cohortRoot,
    ownerDirs,
    server,
    routeOptions: { paperForwardCohortRootDir: cohortRoot }
  };
}

function assertContained(rootDir, filePath) {
  const root = path.resolve(rootDir);
  const target = path.resolve(filePath);
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Fixture path escapes the generated temporary root: ${target}`);
  }
}

function createCounter(rootDir, phase) {
  return {
    phase,
    rootDir,
    operationCounts: Object.create(null),
    readFileCalls: 0,
    readFileBytes: 0,
    paths: new Map()
  };
}

function recordOperation(counter, operation, filePath) {
  const resolved = path.resolve(filePath);
  assertContained(counter.rootDir, resolved);
  counter.operationCounts[operation] = (counter.operationCounts[operation] || 0) + 1;
  const item = counter.paths.get(resolved) || { operations: Object.create(null), readFileCalls: 0, readFileBytes: 0 };
  item.operations[operation] = (item.operations[operation] || 0) + 1;
  counter.paths.set(resolved, item);
  return item;
}

function installReadFence(rootDir, counters, getActivePhase) {
  const originals = new Map();
  for (const name of GUARDED_SYNC_READS) {
    const original = fs[name];
    if (typeof original !== 'function') continue;
    originals.set(name, original);
    fs[name] = function guardedRead(filePath, ...args) {
      const phase = getActivePhase();
      if (!phase || typeof filePath === 'number') {
        throw new Error(`Unexpected ${name} call without a benchmark phase`);
      }
      const resolved = path.resolve(Buffer.isBuffer(filePath) ? filePath.toString() : String(filePath));
      assertContained(rootDir, resolved);
      const counter = counters[phase];
      if (!counter) throw new Error(`Unknown benchmark phase ${phase}`);
      const item = recordOperation(counter, name, resolved);
      if (name === 'readFileSync') {
        counter.readFileCalls += 1;
        item.readFileCalls += 1;
      }
      const result = Reflect.apply(original, fs, [filePath, ...args]);
      if (name === 'readFileSync') {
        const bytes = Buffer.isBuffer(result) ? result.byteLength : Buffer.byteLength(result);
        counter.readFileBytes += bytes;
        item.readFileBytes += bytes;
      }
      return result;
    };
  }
  return () => {
    for (const [name, original] of originals) fs[name] = original;
  };
}

function summarizeCounter(counter) {
  const rows = [...counter.paths.entries()].map(([filePath, value]) => ({
    path: path.relative(counter.rootDir, filePath),
    operations: value.operations,
    readFileCalls: value.readFileCalls,
    readFileBytes: value.readFileBytes
  }));
  const readPaths = rows.filter(row => row.readFileCalls > 0);
  const accessCounts = rows.map(row => Object.values(row.operations).reduce((sum, count) => sum + count, 0));
  return {
    operationCounts: counter.operationCounts,
    readFileCalls: counter.readFileCalls,
    readFileBytes: counter.readFileBytes,
    distinctReadFilePaths: readPaths.length,
    reusedReadFilePaths: readPaths.filter(row => row.readFileCalls > 1).length,
    maxReadFileCallsPerPath: Math.max(0, ...readPaths.map(row => row.readFileCalls)),
    distinctAccessPaths: rows.length,
    maxOperationsPerPath: Math.max(0, ...accessCounts),
    mostReusedReadPaths: [...readPaths]
      .sort((left, right) => right.readFileCalls - left.readFileCalls || left.path.localeCompare(right.path))
      .slice(0, 12)
  };
}

function percentile(values, ratio) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ratio * ordered.length) - 1)];
}

function summarizeNumbers(values) {
  return {
    sampleCount: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: values.length ? Math.max(...values) : null
  };
}

function histogramSummary(histogram) {
  const asMs = value => Number.isFinite(value) ? value / 1e6 : null;
  return {
    resolutionMs: 10,
    p50Ms: asMs(histogram.percentile(50)),
    p95Ms: asMs(histogram.percentile(95)),
    p99Ms: asMs(histogram.percentile(99)),
    maxMs: asMs(histogram.max),
    meanMs: asMs(histogram.mean),
    sampleCount: Number.isFinite(histogram.count) ? histogram.count : null
  };
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function timedRequest(port, pathname, expectedCohortRootName = null) {
  const startedAt = performance.now();
  const { body, statusCode } = await new Promise((resolve, reject) => {
    const request = http.get({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      agent: false,
      headers: { connection: 'close' }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('error', reject);
      response.on('end', () => resolve({
        body: Buffer.concat(chunks),
        statusCode: response.statusCode || 0
      }));
    });
    request.on('error', reject);
  });
  const elapsedMs = performance.now() - startedAt;
  if (statusCode !== 200) {
    throw new Error(`Synthetic route returned HTTP ${statusCode}: ${body.toString('utf8').slice(0, 500)}`);
  }
  const parsed = JSON.parse(body.toString('utf8'));
  if (parsed.researchOnly !== true || parsed.promoted !== false || !Array.isArray(parsed.books)) {
    throw new Error('Synthetic route response did not match the read-only projection contract');
  }
  if (expectedCohortRootName && parsed.paperForwardCohort?.rootName !== expectedCohortRootName) {
    throw new Error(`Paper cohort root was not redirected to the fixture: ${parsed.paperForwardCohort?.rootName}`);
  }
  return { elapsedMs, responseBytes: body.byteLength };
}

function sanitizeMomentumShadowEnvironment() {
  const saved = new Map();
  for (const key of Object.keys(process.env)) {
    if (/^MOMO_SHADOW_/.test(key) || key === 'LIVE_EXECUTION_EVIDENCE_FILE') {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  }
  return () => {
    for (const key of Object.keys(process.env)) {
      if (/^MOMO_SHADOW_/.test(key) || key === 'LIVE_EXECUTION_EVIDENCE_FILE') delete process.env[key];
    }
    for (const [key, value] of saved) process.env[key] = value;
  };
}

function environmentDescription() {
  return {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    osRelease: os.release(),
    cpuModel: os.cpus()[0]?.model || 'unavailable',
    logicalCpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    processExecArgv: [...process.execArgv]
  };
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}

async function run() {
  const options = parseArguments(process.argv.slice(2));
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-momentum-shadow-bench-'));
  const restoreEnvironment = sanitizeMomentumShadowEnvironment();
  const fixtures = [];
  const counters = {
    cold: createCounter(temporaryRoot, 'cold'),
    warmup: createCounter(temporaryRoot, 'warmup'),
    warm: createCounter(temporaryRoot, 'warm')
  };
  let activePhase = null;
  let restoreReadFence = () => {};
  let httpServer = null;
  try {
    for (let index = 0; index < options.coldSamples; index += 1) {
      fixtures.push(createFixture(temporaryRoot, options, `cold-${index}`));
    }
    const warmFixture = createFixture(temporaryRoot, options, 'warm');
    fixtures.push(warmFixture);

    const app = express();
    fixtures.slice(0, options.coldSamples).forEach((fixture, index) => {
      app.use(`/cold-${index}`, createResearchRoutes(fixture.server, fixture.routeOptions));
    });
    app.use('/warm', createResearchRoutes(warmFixture.server, warmFixture.routeOptions));
    httpServer = http.createServer(app);

    // The route's complete runtime file-input inventory is redirected here:
    // 10 book ledgers, quote history/report, live-execution evidence,
    // candidate target/benchmark/owners/slot, and the paper cohort root.
    // Candidate profile history is an in-memory constant. The guarded sync
    // filesystem operations fail before any path outside temporaryRoot opens.
    for (const fixture of fixtures) {
      assertContained(temporaryRoot, fixture.cohortRoot);
      for (const ownerDir of fixture.ownerDirs) assertContained(temporaryRoot, ownerDir);
    }

    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', resolve);
    });
    const port = httpServer.address().port;
    restoreReadFence = installReadFence(temporaryRoot, counters, () => activePhase);

    const coldLatencies = [];
    const coldResponseBytes = [];
    activePhase = 'cold';
    const coldDelay = monitorEventLoopDelay({ resolution: 10 });
    coldDelay.enable();
    await sleep(25);
    for (let index = 0; index < options.coldSamples; index += 1) {
      const fixture = fixtures[index];
      const response = await timedRequest(
        port,
        `/cold-${index}/momentum-shadow`,
        path.basename(fixture.cohortRoot)
      );
      coldLatencies.push(response.elapsedMs);
      coldResponseBytes.push(response.responseBytes);
    }
    await sleep(25);
    coldDelay.disable();

    activePhase = 'warmup';
    for (let index = 0; index < options.warmupSamples; index += 1) {
      await timedRequest(port, '/warm/momentum-shadow', path.basename(warmFixture.cohortRoot));
    }

    const warmLatencies = [];
    const warmResponseBytes = [];
    activePhase = 'warm';
    const warmDelay = monitorEventLoopDelay({ resolution: 10 });
    warmDelay.enable();
    await sleep(25);
    for (let index = 0; index < options.warmSamples; index += 1) {
      const response = await timedRequest(
        port,
        '/warm/momentum-shadow',
        path.basename(warmFixture.cohortRoot)
      );
      warmLatencies.push(response.elapsedMs);
      warmResponseBytes.push(response.responseBytes);
    }
    await sleep(25);
    warmDelay.disable();
    activePhase = null;

    const guardReadAttempts = Object.values(counters).reduce((sum, counter) =>
      sum + Object.values(counter.operationCounts).reduce((phaseSum, count) => phaseSum + count, 0), 0);
    const report = {
      schema: 'coinpilot.momentum-shadow-projection-benchmark.v1',
      generatedAt: new Date().toISOString(),
      environment: environmentDescription(),
      fixture: {
        mode: 'synthetic-only',
        requestTarget: `http://127.0.0.1:${port}`,
        coldSamples: options.coldSamples,
        warmSamples: options.warmSamples,
        warmupSamples: options.warmupSamples,
        cohortSessionsPerRoot: options.cohortSessions,
        strictTradesPerCohortSession: options.cohortTrades,
        tradesPerShadowBook: options.bookTrades,
        shadowBookCount: BOOKS.length,
        isolatedFixtureRootCount: fixtures.length,
        totalSyntheticTradeRows: fixtures.length * (
          options.cohortSessions * options.cohortTrades + BOOKS.length * options.bookTrades
        ),
        maxTotalSyntheticTradeRows: MAX_TOTAL_SYNTHETIC_TRADES
      },
      cold: {
        definition: 'first route request for each separately generated fixture root and newly mounted router; OS page cache is not cleared',
        latencyMs: summarizeNumbers(coldLatencies),
        responseBytes: summarizeNumbers(coldResponseBytes),
        fileAccess: summarizeCounter(counters.cold),
        eventLoopDelay: histogramSummary(coldDelay)
      },
      warm: {
        definition: 'repeated requests to one already-used router and fixture root after excluded warmup requests; no route cache is assumed',
        latencyMs: summarizeNumbers(warmLatencies),
        responseBytes: summarizeNumbers(warmResponseBytes),
        fileAccess: summarizeCounter(counters.warm),
        warmupFileAccess: summarizeCounter(counters.warmup),
        eventLoopDelay: histogramSummary(warmDelay)
      },
      pathFence: {
        temporaryRootName: path.basename(temporaryRoot),
        guardedOperations: GUARDED_SYNC_READS,
        routeFilesystemOperationsObserved: guardReadAttempts,
        externalPathAttempts: 0,
        behavior: 'throws before an out-of-root synchronous filesystem read or metadata operation'
      },
      limits: [
        'The benchmark exercises the full read-only route in one local Node process against synthetic JSON files; it makes no external API or Upbit calls and places no orders.',
        'Cold means first request per newly mounted router and fixture tree. Kernel filesystem cache state is not cleared or controlled.',
        'Latency includes loopback HTTP request/response, JSON projection, serialization, and synthetic file reads.',
        'Event-loop delay is process-wide monitorEventLoopDelay at 10 ms resolution during each phase; it is not a deployed event-loop SLO.',
        'Results do not represent production data shape, concurrent clients, account activity, deployed hardware, or service-level capacity.'
      ]
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    activePhase = null;
    restoreReadFence();
    await closeServer(httpServer);
    restoreEnvironment();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

run().catch(error => {
  process.stderr.write(`benchmark: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
