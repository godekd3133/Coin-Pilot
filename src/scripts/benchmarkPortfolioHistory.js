import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import PortfolioHistoryStore, {
  PORTFOLIO_HISTORY_RETENTION_LIMIT
} from '../api/portfolioHistoryStore.js';

function parseIterations(value) {
  const iterations = value === undefined ? 50 : Number(value);
  if (!Number.isSafeInteger(iterations) || iterations < 5 || iterations > 1000) {
    throw new TypeError('iterations must be an integer between 5 and 1000');
  }
  return iterations;
}

function summarize(samples) {
  const ordered = [...samples].sort((left, right) => left - right);
  const percentile = fraction => ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
  return {
    p50Ms: Number(percentile(0.50).toFixed(3)),
    p95Ms: Number(percentile(0.95).toFixed(3)),
    p99Ms: Number(percentile(0.99).toFixed(3)),
    maxMs: Number(ordered.at(-1).toFixed(3))
  };
}

function measure(operation) {
  const startedAt = performance.now();
  operation();
  return performance.now() - startedAt;
}

const iterations = parseIterations(process.argv[2]);
const now = Date.now();
const history = Array.from({ length: PORTFOLIO_HISTORY_RETENTION_LIMIT }, (_, index) => {
  const capturedAt = new Date(now - ((PORTFOLIO_HISTORY_RETENTION_LIMIT - index - 1) * 10_000)).toISOString();
  return {
    timestamp: capturedAt,
    capturedAt,
    sourceAsOf: capturedAt,
    fetchedAt: capturedAt,
    valuationStatus: 'available',
    valuationSource: 'paper_virtual_portfolio',
    mode: 'DRY_RUN',
    totalAssets: 10_000_000 + index,
    krwBalance: 8_000_000,
    positionCount: 3
  };
});

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-portfolio-history-benchmark-'));
const historyFile = path.join(temporaryDirectory, 'portfolio_history.json');
const store = new PortfolioHistoryStore({ filePath: historyFile });

try {
  store.write(history);
  store.readPeriod('24h', { now });

  const readDurations = [];
  const writeDurations = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    readDurations.push(measure(() => store.readPeriod('24h', { now })));
    writeDurations.push(measure(() => store.write(history)));
  }

  const result = {
    benchmark: 'portfolio-history-json-local-single-process',
    fixture: {
      records: history.length,
      retentionLimit: PORTFOLIO_HISTORY_RETENTION_LIMIT,
      fileBytes: fs.statSync(historyFile).size,
      iterations,
      concurrency: 1,
      storage: 'OS temporary directory; synthetic rows; no network or account data'
    },
    readPeriod24h: summarize(readDurations),
    atomicFsyncWrite: summarize(writeDurations),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch
    },
    scope: 'microbenchmark only; not an API, concurrency, or service SLO measurement'
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
