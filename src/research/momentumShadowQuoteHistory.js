import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(__filename), '../..');
export const DEFAULT_MOMENTUM_SHADOW_QUOTE_RUNTIME_DIR =
  path.resolve(PROJECT_ROOT, '.coinpilot-runtime', 'momentum-shadow');
const DEFAULT_MOMENTUM_SHADOW_QUOTE_REPORT_NAME = 'quote-quality.json';
const DEFAULT_MOMENTUM_SHADOW_QUOTE_HISTORY_NAME = 'quote-history.jsonl';
export const DEFAULT_MOMENTUM_SHADOW_QUOTE_REPORT_FILE = path.join(
  DEFAULT_MOMENTUM_SHADOW_QUOTE_RUNTIME_DIR,
  DEFAULT_MOMENTUM_SHADOW_QUOTE_REPORT_NAME
);
export const DEFAULT_MOMENTUM_SHADOW_QUOTE_HISTORY_FILE =
  path.join(DEFAULT_MOMENTUM_SHADOW_QUOTE_RUNTIME_DIR, DEFAULT_MOMENTUM_SHADOW_QUOTE_HISTORY_NAME);
export const DEFAULT_MOMENTUM_SHADOW_QUOTE_HISTORY_LIMIT = 24;

/**
 * Resolve the two default quote evidence files at call time so dotenv-loaded
 * MOMO_SHADOW_RUNTIME_DIR values are honored by both the CLI and the API.
 * Explicit report/history file overrides remain higher priority at their
 * call-sites.
 */
export function resolveMomentumShadowQuoteRuntimeFile(
  fileName,
  env = process.env
) {
  const configuredDir = String(env?.MOMO_SHADOW_RUNTIME_DIR || '').trim();
  const runtimeDir = configuredDir
    ? path.resolve(configuredDir)
    : DEFAULT_MOMENTUM_SHADOW_QUOTE_RUNTIME_DIR;
  return path.join(runtimeDir, fileName);
}

function finiteOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveOrNull(value) {
  const parsed = finiteOrNull(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function quoteHistoryQuantile(values, probability) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const index = Math.max(0, Math.ceil(probability * sorted.length) - 1);
  return sorted[index];
}

function summarizeQuoteHistoryCadence(records, expectedIntervalSeconds, freshnessLimitSeconds) {
  const gaps = records.slice(1)
    .map((record, index) => (record.generatedAtMs - records[index].generatedAtMs) / 1000)
    .filter(gap => Number.isFinite(gap) && gap >= 0);
  return {
    intervalCount: gaps.length,
    expectedIntervalSeconds,
    freshnessLimitSeconds,
    medianGapSeconds: quoteHistoryQuantile(gaps, 0.5),
    p95GapSeconds: quoteHistoryQuantile(gaps, 0.95),
    maxGapSeconds: gaps.length ? Math.max(...gaps) : null,
    gapsOverFreshnessLimit: gaps.filter(gap => gap > freshnessLimitSeconds).length
  };
}

function positiveInteger(value, fallback) {
  const parsed = Math.floor(Number(value));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeHistoryRecord(value, nowMs) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const generatedAtMs = Date.parse(value.generatedAt || '');
  if (!Number.isFinite(generatedAtMs) || generatedAtMs > nowMs) return null;
  return {
    generatedAt: value.generatedAt,
    generatedAtMs,
    complete: value.complete === true,
    errorCount: Math.max(0, Number(value.errors) || 0),
    summary: value.summary && typeof value.summary === 'object' && !Array.isArray(value.summary)
      ? value.summary
      : {}
  };
}

function summarizeQuoteDepthHistory(records, market, {
  minimumDepthReports = 30,
  minimumSamplesPerReport = 5
} = {}) {
  const minimumReports = positiveInteger(minimumDepthReports, 30);
  const minimumSamples = positiveInteger(minimumSamplesPerReport, 5);
  const twoSidedDepth = [];

  for (const record of records) {
    const row = record.summary.markets?.[market];
    const depth = row?.topOfBookDepth;
    if (record.complete !== true || !depth || typeof depth !== 'object' || Array.isArray(depth)) continue;
    const requested = Math.max(0, Number(depth.requestedSampleCount) || 0);
    const bidSamples = Math.max(0, Number(depth.bidSampleCount) || 0);
    const askSamples = Math.max(0, Number(depth.askSampleCount) || 0);
    const minimumBid = positiveOrNull(depth.minimumBidNotionalKrw);
    const minimumAsk = positiveOrNull(depth.minimumAskNotionalKrw);
    if (requested < minimumSamples || bidSamples !== requested || askSamples !== requested ||
      minimumBid === null || minimumAsk === null) continue;
    twoSidedDepth.push({ bid: minimumBid, ask: minimumAsk });
  }

  return {
    twoSidedDepthReportCount: twoSidedDepth.length,
    missingDepthReportCount: Math.max(0, records.length - twoSidedDepth.length),
    minimumDepthReports: minimumReports,
    status: twoSidedDepth.length >= minimumReports
      ? 'TOP_OF_BOOK_REFERENCE_ONLY'
      : 'INSUFFICIENT_DEPTH_REPORT_HISTORY',
    p05PerReportMinimumBidNotionalKrw: quoteHistoryQuantile(
      twoSidedDepth.map(row => row.bid), 0.05
    ),
    medianPerReportMinimumBidNotionalKrw: quoteHistoryQuantile(
      twoSidedDepth.map(row => row.bid), 0.5
    ),
    p05PerReportMinimumAskNotionalKrw: quoteHistoryQuantile(
      twoSidedDepth.map(row => row.ask), 0.05
    ),
    medianPerReportMinimumAskNotionalKrw: quoteHistoryQuantile(
      twoSidedDepth.map(row => row.ask), 0.5
    ),
    note: 'best-quote level only; not full orderbook depth or an observed fill'
  };
}

/**
 * Summarize append-only quote reports without treating quote observations as
 * fills, realized P&L, or an order authorization. Invalid and future-dated
 * records are deliberately excluded from the evidence window.
 */
export function summarizeMomentumShadowQuoteHistory({
  records = [],
  maxReports = DEFAULT_MOMENTUM_SHADOW_QUOTE_HISTORY_LIMIT,
  maxAgeSeconds = 15 * 60,
  minimumDepthReports = 30,
  minimumSamplesPerReport = 5,
  expectedIntervalSeconds = 600,
  freshnessLimitSeconds = 900,
  now = Date.now()
} = {}) {
  const nowMs = Number(now);
  const limit = positiveInteger(maxReports, DEFAULT_MOMENTUM_SHADOW_QUOTE_HISTORY_LIMIT);
  const maxAge = Number.isFinite(Number(maxAgeSeconds)) && Number(maxAgeSeconds) >= 60
    ? Number(maxAgeSeconds)
    : 15 * 60;
  const expectedInterval = Number.isFinite(Number(expectedIntervalSeconds)) && Number(expectedIntervalSeconds) > 0
    ? Number(expectedIntervalSeconds)
    : 600;
  const freshnessLimit = Number.isFinite(Number(freshnessLimitSeconds)) && Number(freshnessLimitSeconds) > 0
    ? Number(freshnessLimitSeconds)
    : 900;
  const validRecords = (Array.isArray(records) ? records : [])
    .map(record => normalizeHistoryRecord(record, nowMs))
    .filter(Boolean)
    .sort((left, right) => left.generatedAtMs - right.generatedAtMs)
    .slice(-limit);
  const latest = validRecords.at(-1) || null;
  const oldest = validRecords[0] || null;
  const marketNames = new Set();
  for (const record of validRecords) {
    const markets = record.summary.markets;
    if (!markets || typeof markets !== 'object' || Array.isArray(markets)) continue;
    for (const market of Object.keys(markets)) marketNames.add(market);
  }

  const markets = Object.fromEntries([...marketNames].sort().map(market => {
    let reportCount = 0;
    let overCeilingReports = 0;
    let latestP95 = null;
    let maxP95 = null;
    for (const record of validRecords) {
      const row = record.summary.markets?.[market];
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      reportCount += 1;
      const p95 = finiteOrNull(row.p95);
      if (p95 !== null) {
        latestP95 = p95;
        maxP95 = maxP95 === null ? p95 : Math.max(maxP95, p95);
      }
      if (Number(row.overCeiling) > 0) overCeilingReports += 1;
    }
    return [market, {
      reportCount,
      overCeilingReports,
      overCeilingRate: reportCount > 0 ? overCeilingReports / reportCount : null,
      latestP95,
      maxP95,
      topOfBookDepth: summarizeQuoteDepthHistory(validRecords, market, {
        minimumDepthReports,
        minimumSamplesPerReport
      })
    }];
  }));

  const ageSeconds = latest && Number.isFinite(nowMs)
    ? Math.max(0, Math.floor((nowMs - latest.generatedAtMs) / 1000))
    : null;
  const fresh = ageSeconds !== null && ageSeconds <= maxAge;
  const latestMarkets = latest?.summary?.markets;
  const latestOverCeilingMarkets = latestMarkets && typeof latestMarkets === 'object'
    ? Object.entries(latestMarkets)
      .filter(([, row]) => Number(row?.overCeiling) > 0)
      .map(([market]) => market)
    : [];
  const repeatedOverCeilingMarkets = Object.entries(markets)
    .filter(([, row]) => row.overCeilingReports >= 2)
    .map(([market]) => market);

  return {
    available: validRecords.length > 0,
    usable: validRecords.length > 0,
    researchOnly: true,
    promoted: false,
    windowLimit: limit,
    minimumDepthReports: positiveInteger(minimumDepthReports, 30),
    cadence: summarizeQuoteHistoryCadence(validRecords, expectedInterval, freshnessLimit),
    reportCount: validRecords.length,
    completeReportCount: validRecords.filter(record => record.complete).length,
    errorReportCount: validRecords.filter(record => !record.complete || record.errorCount > 0).length,
    oldestGeneratedAt: oldest?.generatedAt || null,
    latestGeneratedAt: latest?.generatedAt || null,
    ageSeconds,
    maxAgeSeconds: maxAge,
    fresh,
    freshnessReason: ageSeconds === null
      ? 'quote_quality_history_empty'
      : fresh ? 'quote_quality_history_latest_fresh' : 'quote_quality_history_latest_stale',
    latestOverCeilingMarkets,
    repeatedOverCeilingMarkets,
    markets,
    note: 'repeated orderbook observations are research-only and do not represent fills, realized P&L, or live-order authorization'
  };
}

/**
 * Read a bounded suffix of the local JSONL history. The route exposes only
 * the projection, never the configured filesystem path or raw parse errors.
 */
export function projectMomentumShadowQuoteHistory({
  historyFile = DEFAULT_MOMENTUM_SHADOW_QUOTE_HISTORY_FILE,
  maxReports = DEFAULT_MOMENTUM_SHADOW_QUOTE_HISTORY_LIMIT,
  maxAgeSeconds = 15 * 60,
  minimumDepthReports = 30,
  minimumSamplesPerReport = 5,
  expectedIntervalSeconds = 600,
  freshnessLimitSeconds = 900,
  now = Date.now()
} = {}) {
  const reportFile = path.basename(String(historyFile));
  if (!fs.existsSync(historyFile)) {
    return {
      available: false,
      usable: false,
      researchOnly: true,
      promoted: false,
      reportFile,
      reason: 'quote_quality_history_not_found'
    };
  }

  try {
    const lines = fs.readFileSync(historyFile, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean);
    const limit = positiveInteger(maxReports, DEFAULT_MOMENTUM_SHADOW_QUOTE_HISTORY_LIMIT);
    // Keep a small suffix cushion so malformed trailing lines do not hide all
    // valid rows in the configured window while still bounding parse work.
    const records = lines.slice(-(limit * 2)).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    });
    const projection = summarizeMomentumShadowQuoteHistory({
      records,
      maxReports: limit,
      maxAgeSeconds,
      minimumDepthReports,
      minimumSamplesPerReport,
      expectedIntervalSeconds,
      freshnessLimitSeconds,
      now
    });
    return { ...projection, reportFile };
  } catch {
    return {
      available: false,
      usable: false,
      researchOnly: true,
      promoted: false,
      reportFile,
      reason: 'quote_quality_history_invalid'
    };
  }
}
