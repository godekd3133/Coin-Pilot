import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMomentumShadowEquity } from '../../research/momentumShadowLedger.js';
import { assessMomentumShadowCostFloor } from '../../research/momentumShadowCostFloor.js';
import {
  calculateMomentumShadowRealizedProfit,
  calculateMomentumShadowRealizedReturnPercent,
  calculateMomentumShadowTradeConfidence,
  summarizeMomentumShadowTradesByMarket,
  summarizeMomentumShadowProfitConcentration,
  calculateMomentumShadowObservationDays,
  DEFAULT_MOMENTUM_SHADOW_MIN_RESEARCH_DAYS
} from '../../research/momentumShadowProfitability.js';
import { inspectMomentumShadowCandidate } from '../../research/momentumShadowCandidatePreflight.js';
import {
  resolveMomentumShadowCandidateConfig,
  DEFAULT_MOMENTUM_SHADOW_CANDIDATE_CONFIG
} from '../../research/momentumShadowCandidateConfig.js';
import {
  getMomentumShadowHistoricalEvidence
} from '../../research/momentumShadowCandidateProfiles.js';
import {
  DEFAULT_MOMENTUM_SHADOW_CANDIDATE_SLOT_FILE
} from '../../research/momentumShadowCandidateSlot.js';
import {
  resolveMomentumShadowQuoteRuntimeFile,
  projectMomentumShadowQuoteHistory
} from '../../research/momentumShadowQuoteHistory.js';
import {
  summarizeMomentumShadowBenchmarkObservationCheckpoints,
  calculateMomentumShadowBenchmarkReturnPercent,
  calculateMomentumShadowRelativeMarkedReturnPercent,
  MOMENTUM_SHADOW_BENCHMARK_OBSERVATION_SCHEMA_VERSION
} from '../../research/momentumShadowBenchmark.js';
import {
  summarizeMomentumShadowQuoteExecutionEvidence
} from '../../research/momentumShadowQuoteQuality.js';
import { assessQuoteExecutionCostCompatibility } from '../../research/quoteExecutionCostCompatibility.js';
import { summarizeMomentumShadowTradeCostAudit } from '../../research/momentumShadowTradeCostAudit.js';
import { resolveMomentumShadowExecutionModel } from '../../research/momentumShadowExecutionModel.js';
import {
  summarizeMomentumShadowLossCapCounterfactual
} from '../../research/momentumShadowLossCapCounterfactual.js';
import { summarizePaperForwardCohort } from '../../research/paperForwardCohort.js';
import { assessScalpingValidationReportFreshness } from '../../research/scalpingValidationFreshness.js';
import { getMomentumShadowConfigDriftChanges } from '../../research/momentumShadowRunnerConfig.js';
import {
  projectLiveExecutionEvidenceStatus
} from '../../research/liveExecutionEvidence.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_MOMENTUM_SHADOW_QUOTE_MAX_AGE_SECONDS = 15 * 60;
const DEFAULT_SCALP_QUOTE_COMPATIBILITY_MARKETS = [
  'KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL'
];

function resolveMomentumShadowQuoteHistoryFile(server) {
  const config = server?.tradingSystem?.config || {};
  const configuredHistoryFile = config.momentumShadowQuoteHistoryFile ||
    process.env.MOMO_SHADOW_QUOTE_HISTORY_FILE ||
    resolveMomentumShadowQuoteRuntimeFile('quote-history.jsonl');
  return path.isAbsolute(configuredHistoryFile)
    ? configuredHistoryFile
    : path.resolve(PROJECT_ROOT, configuredHistoryFile);
}

function readMomentumShadowQuoteHistoryRecords(server) {
  const historyFile = resolveMomentumShadowQuoteHistoryFile(server);
  if (!fs.existsSync(historyFile)) {
    return { available: false, records: [], invalidRecordCount: 0, inputReportCount: 0 };
  }
  try {
    const lines = fs.readFileSync(historyFile, 'utf8').split(/\r?\n/).filter(Boolean);
    const records = [];
    let invalidRecordCount = 0;
    for (const line of lines) {
      try { records.push(JSON.parse(line)); } catch { invalidRecordCount += 1; }
    }
    return { available: true, records, invalidRecordCount, inputReportCount: lines.length };
  } catch {
    return { available: false, records: [], invalidRecordCount: 1, inputReportCount: 0 };
  }
}

function projectMomentumShadowTradeCostAudit(ledger, quoteHistorySource) {
  const audit = summarizeMomentumShadowTradeCostAudit({
    ledger,
    quoteHistoryRecords: quoteHistorySource.records,
    invalidQuoteHistoryRecordCount: quoteHistorySource.invalidRecordCount
  });
  return {
    available: audit.ledger.closedTradeCount > 0,
    researchOnly: true,
    promoted: false,
    actualFillsObserved: false,
    executionModel: ledger.config?.executionModel || 'unknown',
    closedTradeCount: audit.ledger.closedTradeCount,
    ledgerCostPercent: audit.ledger.configCostPercent,
    requiredRoundTripCostPercent: audit.ledger.requiredRoundTripCostPercent,
    additionalCostToFloorPercent: audit.ledger.additionalCostToFloorPercent,
    configDrift: audit.ledger.configDrift,
    openPositionCount: audit.ledger.openPositionCount,
    quoteHistory: {
      available: quoteHistorySource.available,
      inputReportCount: quoteHistorySource.inputReportCount,
      usableReportCount: audit.quoteHistory.usableReportCount,
      latestGeneratedAt: audit.quoteHistory.latestGeneratedAt,
      latestAgeSeconds: audit.quoteHistory.latestAgeSeconds,
      latestFresh: audit.quoteHistory.latestFresh,
      latestUsable: audit.quoteHistory.latestUsable,
      invalidRecordCount: audit.quoteHistory.invalidRecordCount
    },
    quoteMatchedTradeCount: audit.quoteMatchedTradeCount,
    unmatchedQuoteTradeCount: audit.unmatchedQuoteTradeCount,
    spreadScenarioTradeCount: audit.spreadScenarioTradeCount,
    unmatchedSpreadCostTradeCount: audit.unmatchedSpreadCostTradeCount,
    fullCohort: audit.fullCohort,
    quoteMatchedSubset: audit.quoteMatchedSubset,
    note: audit.note
  };
}

const csv = value => String(value || '').split(',').map(item => item.trim()).filter(Boolean);

// Every known shadow ledger is a competing API consumer, so each candidate's
// readiness check counts all of them as owners — a live fixed-hold book must
// not be invisible to the baseline or next-open preflights.
function momentumShadowOwnerDirs(config) {
  if (process.env.MOMO_SHADOW_OWNER_DIRS) return csv(process.env.MOMO_SHADOW_OWNER_DIRS);
  return [
    config.momentumShadowFixedDir ||
      process.env.MOMO_SHADOW_FIXED_DIR ||
      path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-v1'),
    config.momentumShadowRegimeDir ||
      process.env.MOMO_SHADOW_REGIME_DIR ||
      path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-regime'),
    config.momentumShadowBenchmarkDir ||
      process.env.MOMO_SHADOW_BENCHMARK_DIR ||
      path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-btc-gate-v1'),
    config.momentumShadowVolatilityDir ||
      process.env.MOMO_SHADOW_VOLATILITY_DIR ||
      path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-vol-target-v1'),
    config.momentumShadowNextOpenDir ||
      process.env.MOMO_SHADOW_NEXT_OPEN_DIR ||
      path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-next-open-v1'),
    config.momentumShadowFixedHoldDir ||
      process.env.MOMO_SHADOW_FIXED_HOLD_DIR ||
      path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-fixed-hold-2d-v1'),
    config.momentumShadowFixedHoldLossCapDir ||
      process.env.MOMO_SHADOW_FIXED_HOLD_LOSS_CAP_DIR ||
      path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-fixed-hold-2d-loss-cap-v1'),
    config.momentumShadowFixedHoldLossCapNoDogeDir ||
      process.env.MOMO_SHADOW_FIXED_HOLD_LOSS_CAP_NO_DOGE_DIR ||
      path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-fixed-hold-2d-loss-cap-no-doge-v1'),
    config.momentumShadowFixedHoldSpreadDir ||
      process.env.MOMO_SHADOW_FIXED_HOLD_SPREAD_DIR ||
      path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-fixed-hold-2d-spread-v1'),
    config.momentumShadowFixedHoldRelativeDir ||
      process.env.MOMO_SHADOW_FIXED_HOLD_RELATIVE_DIR ||
      path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-fixed-hold-2d-relative-v1'),
    config.momentumShadowFixedHoldQuoteCrossDir ||
      process.env.MOMO_SHADOW_FIXED_HOLD_QUOTE_CROSS_DIR ||
      path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-fixed-hold-2d-quote-cross-v1')
  ];
}

// The shared candidate slot lives at the repository root; anchor it like the
// ledger dirs so an API process started outside the project root still
// inspects the same file the launcher claims.
function momentumShadowCandidateSlotFile(config) {
  return config.momentumShadowCandidateSlotFile ||
    process.env.MOMO_SHADOW_CANDIDATE_SLOT_FILE ||
    path.resolve(PROJECT_ROOT, DEFAULT_MOMENTUM_SHADOW_CANDIDATE_SLOT_FILE);
}

function finiteOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeOrFallback(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// Project the latest repeated orderbook observation without exposing the
// local path or raw error messages. This is evidence for the UI only: it
// never authorizes an order and is deliberately independent of any running
// spread-guard ledger.
function projectMomentumShadowQuoteQualitySnapshot(server) {
  const config = server?.tradingSystem?.config || {};
  const configuredFile = config.momentumShadowQuoteReportFile ||
    process.env.MOMO_SHADOW_QUOTE_REPORT_FILE ||
    resolveMomentumShadowQuoteRuntimeFile('quote-quality.json');
  const reportFile = path.isAbsolute(configuredFile)
    ? configuredFile
    : path.resolve(PROJECT_ROOT, configuredFile);
  const configuredMaxAge = config.momentumShadowQuoteMaxAgeSeconds ??
    process.env.MOMO_SHADOW_QUOTE_MAX_AGE_SECONDS;
  const maxAgeSeconds = Number.isFinite(Number(configuredMaxAge)) && Number(configuredMaxAge) >= 60
    ? Number(configuredMaxAge)
    : DEFAULT_MOMENTUM_SHADOW_QUOTE_MAX_AGE_SECONDS;
  const historyFile = resolveMomentumShadowQuoteHistoryFile(server);
  const history = projectMomentumShadowQuoteHistory({
    historyFile,
    maxReports: 48,
    maxAgeSeconds,
    minimumDepthReports: 30,
    minimumSamplesPerReport: 5,
    expectedIntervalSeconds: 600,
    freshnessLimitSeconds: 900
  });
  const unavailable = reason => ({
    available: false,
    researchOnly: true,
    promoted: false,
    reportFile: path.basename(reportFile),
    reason,
    history
  });

  if (!fs.existsSync(reportFile)) return unavailable('quote_quality_report_not_found');

  try {
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    if (!report || typeof report !== 'object' || Array.isArray(report)) {
      return unavailable('quote_quality_report_invalid');
    }
    const summary = report.summary && typeof report.summary === 'object'
      ? report.summary
      : {};
    const rawMarkets = summary.markets && typeof summary.markets === 'object'
      ? summary.markets
      : {};
    const positiveNotionalOrNull = value => {
      if (value === null || value === undefined || value === '') return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    };
    const markets = Object.fromEntries(Object.entries(rawMarkets).map(([market, row]) => [market, {
      sampleCount: Math.max(0, Number(row?.sampleCount) || 0),
      p95: finiteOrNull(row?.p95),
      max: finiteOrNull(row?.max),
      overCeiling: Math.max(0, Number(row?.overCeiling) || 0),
      topOfBookDepth: row?.topOfBookDepth && typeof row.topOfBookDepth === 'object'
        ? {
          requestedSampleCount: Math.max(0, Number(row.topOfBookDepth.requestedSampleCount) || 0),
          bidSampleCount: Math.max(0, Number(row.topOfBookDepth.bidSampleCount) || 0),
          askSampleCount: Math.max(0, Number(row.topOfBookDepth.askSampleCount) || 0),
          minimumBidNotionalKrw: positiveNotionalOrNull(row.topOfBookDepth.minimumBidNotionalKrw),
          minimumAskNotionalKrw: positiveNotionalOrNull(row.topOfBookDepth.minimumAskNotionalKrw)
        }
        : null
    }]));
    const overCeilingMarkets = Object.entries(markets)
      .filter(([, row]) => row.overCeiling > 0)
      .map(([market]) => market);
    const requestedSampleCount = Math.max(0, Number(report.requestedSampleCount) || 0);
    const sampleCount = Math.max(0, Number(summary.sampleCount) || Number(report.samples?.length) || 0);
    const errorCount = Array.isArray(report.errors)
      ? report.errors.length
      : Math.max(0, Number(report.errors) || 0);
    const generatedAtMs = Date.parse(report.generatedAt || '');
    const now = Date.now();
    const ageSeconds = Number.isFinite(generatedAtMs) && now >= generatedAtMs
      ? Math.floor((now - generatedAtMs) / 1000)
      : null;
    const fresh = ageSeconds !== null && ageSeconds <= maxAgeSeconds;
    const compatibilityMarkets = csv(
      config.scalpingQuoteCompatibilityMarkets ||
      process.env.SCALP_QUOTE_COMPATIBILITY_MARKETS ||
      DEFAULT_SCALP_QUOTE_COMPATIBILITY_MARKETS.join(',')
    );
    const compatibilityTradingFee = nonNegativeOrFallback(
      config.tradingFee ?? process.env.SCALP_VALIDATION_FEE,
      0.0005
    );
    const compatibilitySlippage = nonNegativeOrFallback(
      config.slippage ?? process.env.SCALP_VALIDATION_SLIPPAGE,
      0.001
    );
    const compatibilityMinimumSamples = Math.max(1, Math.floor(nonNegativeOrFallback(
      config.scalpingQuoteCompatibilityMinSamples ??
        process.env.SCALP_QUOTE_COMPATIBILITY_MIN_SAMPLES,
      5
    )));
    const quoteCostCompatibility = assessQuoteExecutionCostCompatibility({
      report,
      markets: compatibilityMarkets,
      tradingFee: compatibilityTradingFee,
      slippage: compatibilitySlippage,
      minimumSamples: compatibilityMinimumSamples,
      maxAgeSeconds,
      now
    });
    const allObservedMarketCostCompatibility = assessQuoteExecutionCostCompatibility({
      report,
      markets: Object.keys(rawMarkets),
      tradingFee: compatibilityTradingFee,
      slippage: compatibilitySlippage,
      minimumSamples: compatibilityMinimumSamples,
      maxAgeSeconds,
      now
    });
    return {
      available: true,
      researchOnly: true,
      promoted: false,
      reportFile: path.basename(reportFile),
      generatedAt: report.generatedAt || null,
      complete: report.complete === true && summary.valid === true,
      fresh,
      ageSeconds,
      maxAgeSeconds,
      freshnessReason: ageSeconds === null
        ? Number.isFinite(generatedAtMs)
          ? 'quote_quality_report_future_timestamp'
          : 'quote_quality_report_timestamp_missing'
        : fresh ? 'quote_quality_report_fresh' : 'quote_quality_report_stale',
      requestedSampleCount,
      sampleCount,
      errorCount,
      maxSpreadPercent: Math.max(0, Number(report.maxSpreadPercent) || Number(summary.maxSpreadPercent) || 0),
      overall: {
        median: finiteOrNull(summary.overall?.median),
        p95: finiteOrNull(summary.overall?.p95),
        max: finiteOrNull(summary.overall?.max)
      },
      markets,
      overCeilingMarkets,
      costCompatibility: quoteCostCompatibility,
      allObservedMarketCostCompatibility,
      history,
      note: '호가 관측치는 참고 자료입니다. 실제 체결이나 실현 손익을 뜻하지 않으며, 실제 주문을 허용하지 않습니다.'
    };
  } catch {
    return unavailable('quote_quality_report_invalid');
  }
}

function projectMomentumShadowCandidateReadiness(server) {
  const config = server?.tradingSystem?.config || {};
  const benchmarkDir = config.momentumShadowBenchmarkDir ||
    process.env.MOMO_SHADOW_BENCHMARK_DIR ||
    path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-btc-gate-v1');
  const ownerDirs = momentumShadowOwnerDirs(config);
  return inspectMomentumShadowCandidate({
    targetDir: config.momentumShadowCandidateDir ||
      process.env.MOMO_SHADOW_CANDIDATE_DIR ||
      path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-btc-gate-v2'),
    benchmarkDir,
    ownerDirs,
    candidateSlotFile: momentumShadowCandidateSlotFile(config),
    expectedConfig: resolveMomentumShadowCandidateConfig(),
    requireBenchmarkOpen: process.env.MOMO_SHADOW_REQUIRE_BENCHMARK_OPEN !== 'false',
    minimumPollMs: Number.isFinite(Number(process.env.MOMO_SHADOW_MIN_POLL_MS))
      ? Number(process.env.MOMO_SHADOW_MIN_POLL_MS)
      : 15 * 60 * 1000
  });
}

function projectMomentumShadowVolatilityReadiness(server) {
  const config = server?.tradingSystem?.config || {};
  const benchmarkDir = config.momentumShadowBenchmarkDir ||
    process.env.MOMO_SHADOW_BENCHMARK_DIR ||
    path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-btc-gate-v1');
  const volatilityDir = config.momentumShadowVolatilityDir ||
    process.env.MOMO_SHADOW_VOLATILITY_DIR ||
    path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-vol-target-v1');
  const ownerDirs = momentumShadowOwnerDirs(config);
  // Variant contracts are sealed against ambient env: only the candidate's
  // documented pins apply, and every unpinned knob resolves to the shared
  // default contract. A stray MOMO_SHADOW_* from another candidate's launch
  // env must not rewrite this projection's expectedConfig or gate threshold.
  const expectedConfig = resolveMomentumShadowCandidateConfig({
    MOMO_SHADOW_VOLATILITY_LOOKBACK_DAYS: '14',
    MOMO_SHADOW_VOLATILITY_TARGET_PERCENT: '1',
    MOMO_SHADOW_COST_PERCENT: '0.3'
  });
  return inspectMomentumShadowCandidate({
    targetDir: volatilityDir,
    benchmarkDir,
    ownerDirs,
    candidateSlotFile: momentumShadowCandidateSlotFile(config),
    expectedConfig,
    requireBenchmarkOpen: process.env.MOMO_SHADOW_REQUIRE_BENCHMARK_OPEN !== 'false',
    minimumPollMs: Number.isFinite(Number(process.env.MOMO_SHADOW_MIN_POLL_MS))
      ? Number(process.env.MOMO_SHADOW_MIN_POLL_MS)
      : 15 * 60 * 1000
  });
}

function projectMomentumShadowNextOpenReadiness(server) {
  const config = server?.tradingSystem?.config || {};
  const benchmarkDir = config.momentumShadowBenchmarkDir ||
    process.env.MOMO_SHADOW_BENCHMARK_DIR ||
    path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-btc-gate-v1');
  const nextOpenDir = config.momentumShadowNextOpenDir ||
    process.env.MOMO_SHADOW_NEXT_OPEN_DIR ||
    path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-next-open-v1');
  const ownerDirs = momentumShadowOwnerDirs(config);
  const expectedConfig = resolveMomentumShadowCandidateConfig({
    MOMO_SHADOW_BENCHMARK_TREND_MIN_PERCENT: '1',
    MOMO_SHADOW_TREND_MIN_PERCENT: '2',
    MOMO_SHADOW_BREADTH_MIN: '3',
    MOMO_SHADOW_MIN_UP_BARS: '2',
    MOMO_SHADOW_POSITION_FRACTION: '0.125',
    MOMO_SHADOW_MAX_POSITIONS: '2',
    MOMO_SHADOW_COST_PERCENT: '0.3',
    MOMO_SHADOW_VOLATILITY_LOOKBACK_DAYS: '14',
    MOMO_SHADOW_VOLATILITY_TARGET_PERCENT: '1',
    MOMO_SHADOW_ENTRY_EXECUTION: 'next_open',
    MOMO_SHADOW_MAX_ENTRY_GAP_PERCENT: '0.2',
    MOMO_SHADOW_MAX_DAILY_CANDLE_AGE_HOURS: '36',
    MOMO_SHADOW_COOLDOWN_AFTER_LOSS_DAYS: '3',
    MOMO_SHADOW_MAX_PORTFOLIO_DRAWDOWN_PERCENT: '15',
    MOMO_SHADOW_POLL_MS: '900000'
  });
  return inspectMomentumShadowCandidate({
    targetDir: nextOpenDir,
    benchmarkDir,
    ownerDirs,
    candidateSlotFile: momentumShadowCandidateSlotFile(config),
    expectedConfig,
    requireBenchmarkOpen: process.env.MOMO_SHADOW_REQUIRE_BENCHMARK_OPEN !== 'false',
    minimumPollMs: Number.isFinite(Number(process.env.MOMO_SHADOW_MIN_POLL_MS))
      ? Number(process.env.MOMO_SHADOW_MIN_POLL_MS)
      : 15 * 60 * 1000
  });
}

function projectMomentumShadowFixedHoldReadiness(server, {
  spreadGuard = false,
  relativeTrendMinPercent = null,
  quoteCross = false,
  stopLossPercent = 0,
  excludeDoge = false
} = {}) {
  const config = server?.tradingSystem?.config || {};
  const benchmarkDir = config.momentumShadowBenchmarkDir ||
    process.env.MOMO_SHADOW_BENCHMARK_DIR ||
    path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-btc-gate-v1');
  const fixedHoldDir = excludeDoge
    ? config.momentumShadowFixedHoldLossCapNoDogeDir ||
      process.env.MOMO_SHADOW_FIXED_HOLD_LOSS_CAP_NO_DOGE_DIR ||
      path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-fixed-hold-2d-loss-cap-no-doge-v1')
    : quoteCross
    ? config.momentumShadowFixedHoldQuoteCrossDir ||
      process.env.MOMO_SHADOW_FIXED_HOLD_QUOTE_CROSS_DIR ||
      path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-fixed-hold-2d-quote-cross-v1')
    : stopLossPercent > 0
    ? config.momentumShadowFixedHoldLossCapDir ||
      process.env.MOMO_SHADOW_FIXED_HOLD_LOSS_CAP_DIR ||
      path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-fixed-hold-2d-loss-cap-v1')
    : relativeTrendMinPercent !== null
    ? config.momentumShadowFixedHoldRelativeDir ||
      process.env.MOMO_SHADOW_FIXED_HOLD_RELATIVE_DIR ||
      path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-fixed-hold-2d-relative-v1')
    : spreadGuard
      ? config.momentumShadowFixedHoldSpreadDir ||
        process.env.MOMO_SHADOW_FIXED_HOLD_SPREAD_DIR ||
        path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-fixed-hold-2d-spread-v1')
      : config.momentumShadowFixedHoldDir ||
        process.env.MOMO_SHADOW_FIXED_HOLD_DIR ||
        path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-fixed-hold-2d-v1');
  const ownerDirs = momentumShadowOwnerDirs(config);
  const expectedConfig = resolveMomentumShadowCandidateConfig({
    MOMO_SHADOW_MODE: 'fixed',
    MOMO_SHADOW_MAX_HOLD_HOURS: '48',
    MOMO_SHADOW_BENCHMARK_MARKET: 'KRW-BTC',
    MOMO_SHADOW_BENCHMARK_TREND_MIN_PERCENT: '1',
    ...(excludeDoge ? {
      MOMO_SHADOW_MARKETS: 'KRW-BTC,KRW-ETH,KRW-XRP,KRW-SOL,KRW-ADA,KRW-DOT,KRW-LINK,KRW-ATOM,KRW-NEAR,KRW-ETC,KRW-SUI'
    } : {}),
    ...(relativeTrendMinPercent === null ? {} : {
      MOMO_SHADOW_RELATIVE_TREND_MIN_PERCENT: String(relativeTrendMinPercent)
    }),
    MOMO_SHADOW_TREND_MIN_PERCENT: '2',
    MOMO_SHADOW_BREADTH_MIN: '3',
    MOMO_SHADOW_MIN_UP_BARS: '2',
    MOMO_SHADOW_POSITION_FRACTION: '0.125',
    MOMO_SHADOW_MAX_POSITIONS: '2',
    MOMO_SHADOW_COST_PERCENT: '0.3',
    // The fixed-hold A/B contracts use the same benchmark-off protection as
    // the historical candidate and the launcher. Keeping this explicit seals
    // the read-only readiness projection to the runner's contract instead of
    // inheriting the raw runner's legacy default.
    MOMO_SHADOW_EXIT_ON_BENCHMARK_OFF: 'true',
    MOMO_SHADOW_COOLDOWN_AFTER_LOSS_DAYS: '3',
    MOMO_SHADOW_MAX_PORTFOLIO_DRAWDOWN_PERCENT: '15',
    MOMO_SHADOW_VOLATILITY_LOOKBACK_DAYS: '14',
    MOMO_SHADOW_VOLATILITY_TARGET_PERCENT: '1',
    MOMO_SHADOW_ENTRY_EXECUTION: 'next_open',
    MOMO_SHADOW_EXECUTION_MODEL: quoteCross ? 'quote_cross' : 'candle_close',
    MOMO_SHADOW_MAX_ENTRY_GAP_PERCENT: '0.2',
    MOMO_SHADOW_MAX_DAILY_CANDLE_AGE_HOURS: '36',
    MOMO_SHADOW_MAX_SPREAD_PERCENT: spreadGuard || quoteCross ? '0.5' : '0',
    MOMO_SHADOW_STOP_LOSS_PERCENT: String(stopLossPercent),
    MOMO_SHADOW_TAKE_PROFIT_PERCENT: '0',
    MOMO_SHADOW_POLL_MS: '900000'
  });
  return inspectMomentumShadowCandidate({
    targetDir: fixedHoldDir,
    benchmarkDir,
    ownerDirs,
    candidateSlotFile: momentumShadowCandidateSlotFile(config),
    expectedConfig,
    requireBenchmarkOpen: process.env.MOMO_SHADOW_REQUIRE_BENCHMARK_OPEN !== 'false',
    requireQuoteQuality: spreadGuard || quoteCross,
    quoteReportFile: config.momentumShadowQuoteReportFile ||
      process.env.MOMO_SHADOW_QUOTE_REPORT_FILE ||
      resolveMomentumShadowQuoteRuntimeFile('quote-quality.json'),
    quoteMaxAgeSeconds: Number.isFinite(Number(process.env.MOMO_SHADOW_QUOTE_MAX_AGE_SECONDS))
      ? Number(process.env.MOMO_SHADOW_QUOTE_MAX_AGE_SECONDS)
      : 15 * 60,
    minimumPollMs: Number.isFinite(Number(process.env.MOMO_SHADOW_MIN_POLL_MS))
      ? Number(process.env.MOMO_SHADOW_MIN_POLL_MS)
      : 15 * 60 * 1000
  });
}

const momentumShadowBookDefinitions = server => {
  const config = server?.tradingSystem?.config || {};
  return [
    {
      key: 'fixed',
      label: '진입 후 72시간 유지',
      description: '현재 진입계약 · 72시간 종료',
      directory: config.momentumShadowFixedDir ||
        process.env.MOMO_SHADOW_FIXED_DIR ||
        path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-v1')
    },
    {
      key: 'regime',
      label: '추세 약화 시 청산',
      description: '현재 진입계약 · 추세 off 종료',
      directory: config.momentumShadowRegimeDir ||
        process.env.MOMO_SHADOW_REGIME_DIR ||
        path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-regime')
    },
    {
      key: 'benchmark',
      label: '비트코인 추세 필터',
      description: 'BTC 7일 추세 gate · benchmark off 청산',
      directory: config.momentumShadowBenchmarkDir ||
        process.env.MOMO_SHADOW_BENCHMARK_DIR ||
        path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-btc-gate-v1')
    },
    {
      key: 'volatility',
      label: '변동성에 따라 비중 조절',
      description: '목표 일변동성 1% · 고변동 종목 비중 축소',
      directory: config.momentumShadowVolatilityDir ||
        process.env.MOMO_SHADOW_VOLATILITY_DIR ||
        path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-vol-target-v1')
    },
    {
      key: 'next_open',
      label: '거래 비용 반영 · 다음 날 시가 진입',
      description: 'cost 0.3% · 다음 일봉 시작가 체결',
      directory: config.momentumShadowNextOpenDir ||
        process.env.MOMO_SHADOW_NEXT_OPEN_DIR ||
        path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-next-open-v1')
    },
    {
      key: 'fixed_2d',
      label: '2일 뒤 청산',
      description: 'cost 0.3% · 다음 시가 진입 · 48시간 종료',
      directory: config.momentumShadowFixedHoldDir ||
        process.env.MOMO_SHADOW_FIXED_HOLD_DIR ||
        path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-fixed-hold-2d-v1')
    },
    {
      key: 'fixed_2d_loss_cap',
      label: '2일 보유 · 종가 기준 손실 제한',
      description: 'cost 0.3% · 다음 시가 진입 · 48시간 종료 · 완료 일봉 종가 손실 상한 4%',
      directory: config.momentumShadowFixedHoldLossCapDir ||
        process.env.MOMO_SHADOW_FIXED_HOLD_LOSS_CAP_DIR ||
        path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-fixed-hold-2d-loss-cap-v1')
    },
    {
      key: 'fixed_2d_spread',
      label: '2일 보유 · 호가 제한',
      description: 'cost 0.3% · 다음 시가 진입 · 48시간 종료 · spread 0.5% 이하',
      directory: config.momentumShadowFixedHoldSpreadDir ||
        process.env.MOMO_SHADOW_FIXED_HOLD_SPREAD_DIR ||
        path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-fixed-hold-2d-spread-v1')
    },
    {
      key: 'fixed_2d_relative',
      label: '2일 보유 · 비트코인 대비 강한 추세',
      description: 'cost 0.3% · 다음 시가 진입 · 48시간 종료 · BTC 대비 상대추세 우위',
      directory: config.momentumShadowFixedHoldRelativeDir ||
        process.env.MOMO_SHADOW_FIXED_HOLD_RELATIVE_DIR ||
        path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-fixed-hold-2d-relative-v1')
    },
    {
      key: 'fixed_2d_quote_cross',
      label: '2일 보유 · 매수·매도 호가 기준',
      description: 'cost 0.3% · 다음 시가 진입 · 48시간 종료 · best ask 매수 · best bid 매도/평가',
      directory: config.momentumShadowFixedHoldQuoteCrossDir ||
        process.env.MOMO_SHADOW_FIXED_HOLD_QUOTE_CROSS_DIR ||
        path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-fixed-hold-2d-quote-cross-v1')
    }
  ];
};

function ownerAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return null;
  try { process.kill(value, 0); return true; }
  catch { return false; }
}

function formatRunnerStopReason(reason) {
  const labels = {
    'signal:SIGINT': '사용자 중지',
    'signal:SIGTERM': '프로세스 종료 신호',
    heartbeat_timeout: '갱신이 늦어 자동으로 중지됨',
    cycle_timeout: '처리 시간이 너무 오래 걸려 중지됨',
    candidate_slot_lost: '후보 실행 권한을 잃어 중지됨',
    lock_lost: '실행 잠금을 잃어 중지됨',
    before_exit: '실행 종료 감지',
    startup_failure: '시작 실패',
    uncaught_exception: '처리되지 않은 오류',
    unhandled_rejection: '처리되지 않은 비동기 오류',
    stopped_cleanly: '정상 중지'
  };
  return labels[reason] || (reason ? '종료 원인 확인 필요' : null);
}

function projectMomentumShadowRunnerLifecycle(ledger) {
  const events = Array.isArray(ledger.runnerEvents) ? ledger.runnerEvents : [];
  let latestStartIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'started') {
      latestStartIndex = index;
      break;
    }
  }
  if (latestStartIndex <= 0) return null;

  let previousStop = null;
  for (let index = latestStartIndex - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'stopped') {
      previousStop = events[index];
      break;
    }
  }
  if (!previousStop) return null;

  const latestStart = events[latestStartIndex];
  return {
    previousStopReason: previousStop.reason || null,
    previousStopReasonLabel: formatRunnerStopReason(previousStop.reason),
    previousStopAt: previousStop.at || null,
    restartedAt: latestStart.at || null,
    currentOpenPositionCount: Object.keys(ledger.positions || {}).length
  };
}

function projectMomentumShadowBook(definition, fallbackInitialBalance, server, quoteHistorySource) {
  const ledgerFile = path.join(definition.directory, 'ledger.json');
  if (!fs.existsSync(ledgerFile)) {
    return {
      key: definition.key,
      label: definition.label,
      description: definition.description,
      available: false,
      status: '기록 없음',
      researchOnly: true,
      promoted: false
    };
  }

  try {
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    const heartbeatMs = Date.parse(ledger.heartbeatAt);
    // A future heartbeat is clock-skewed, not fresh — unverifiable freshness
    // must not keep a book marked as actively observing.
    const heartbeatAgeSeconds = Number.isFinite(heartbeatMs) && Date.now() >= heartbeatMs
      ? Math.round((Date.now() - heartbeatMs) / 1000)
      : null;
    const pollMs = Number(ledger.config?.pollMs) ||
      Number(process.env.MOMO_SHADOW_POLL_MS) ||
      (definition.key === 'benchmark' ? 15 * 60 * 1000 : 5 * 60 * 1000);
    const heartbeatLimitMs = Math.max(600_000, pollMs * 5);
    const live = ownerAlive(ledger.ownerPid);
    const active = ledger.runnerState === 'running' && live === true &&
      heartbeatAgeSeconds !== null && heartbeatAgeSeconds * 1000 <= heartbeatLimitMs;
    const equity = getMomentumShadowEquity(ledger, fallbackInitialBalance);
    const trades = Array.isArray(ledger.trades) ? ledger.trades : [];
    const tradeCostAudit = trades.length > 0
      ? projectMomentumShadowTradeCostAudit(ledger, quoteHistorySource)
      : null;
    const executionModel = resolveMomentumShadowExecutionModel(ledger.config?.executionModel);
    const quoteExecution = summarizeMomentumShadowQuoteExecutionEvidence(trades);
    const winningTrades = trades.filter(trade => Number(trade.profitPercent) > 0).length;
    const realizedProfitAmount = calculateMomentumShadowRealizedProfit(ledger);
    const realizedByMarket = summarizeMomentumShadowTradesByMarket(ledger);
    const tradeReturnConfidence = calculateMomentumShadowTradeConfidence(ledger);
    const realizedReturnPercent = calculateMomentumShadowRealizedReturnPercent(
      ledger,
      fallbackInitialBalance
    );
    const benchmarkObservationSchemaVersion = ledger.benchmarkObservationSchemaVersion === null ||
      ledger.benchmarkObservationSchemaVersion === undefined ||
      ledger.benchmarkObservationSchemaVersion === ''
      ? null
      : Number(ledger.benchmarkObservationSchemaVersion);
    const benchmarkObservationTelemetryReady =
      benchmarkObservationSchemaVersion === MOMENTUM_SHADOW_BENCHMARK_OBSERVATION_SCHEMA_VERSION;
    const benchmarkObservationReturnPercent = calculateMomentumShadowBenchmarkReturnPercent(
      ledger.benchmarkObservationStartPrice,
      ledger.benchmarkObservationMarkPrice
    );
    const benchmarkObservationAvailable = benchmarkObservationTelemetryReady &&
      ledger.benchmarkObservationAvailable === true &&
      typeof ledger.benchmarkObservationStartTs === 'string' &&
      ledger.benchmarkObservationStartTs.trim().length > 0 &&
      typeof ledger.benchmarkObservationMarkTs === 'string' &&
      ledger.benchmarkObservationMarkTs.trim().length > 0 &&
      benchmarkObservationReturnPercent !== null;
    const relativeMarkedReturnPercent = benchmarkObservationAvailable
      ? calculateMomentumShadowRelativeMarkedReturnPercent(
        equity.markedReturnPercent,
        benchmarkObservationReturnPercent
      )
      : null;
    const benchmarkObservationCheckpoints =
      summarizeMomentumShadowBenchmarkObservationCheckpoints(
        benchmarkObservationTelemetryReady
          ? ledger.benchmarkObservationCheckpoints
          : []
      );
    const minimumResearchTrades = Math.max(
      1,
      Number(server?.tradingSystem?.config?.momentumShadowMinTrades) || 20
    );
    const minimumResearchDays = Math.max(
      1,
      Number(server?.tradingSystem?.config?.momentumShadowMinResearchDays) ||
        Number(process.env.MOMO_SHADOW_MIN_RESEARCH_DAYS) ||
        DEFAULT_MOMENTUM_SHADOW_MIN_RESEARCH_DAYS
    );
    const observationDays = calculateMomentumShadowObservationDays(ledger);
    const observedMddSampleCount = Math.max(0, Number(ledger.observedMddSampleCount) || 0);
    const observedMddFullSessionCoverage = ledger.observedMddFullSessionCoverage === true;
    const observedMddAvailable = observedMddSampleCount >= 2 &&
      ledger.observedMddMaxDrawdownPercent !== null &&
      ledger.observedMddMaxDrawdownPercent !== undefined &&
      Number.isFinite(Number(ledger.observedMddMaxDrawdownPercent));
    const costFloorStatus = assessMomentumShadowCostFloor(ledger.config?.costPercent);
    const entryCostFloor = {
      ...costFloorStatus,
      runtimeGuardActive: Number(ledger.costFloorGuardVersion) === 1,
      blockedEntrySignals: Math.max(0, Number(ledger.costFloorBlockedEntries) || 0),
      blockedPendingEntries: Math.max(0, Number(ledger.costFloorBlockedPendingEntries) || 0),
      note: '거래 비용이 최소 기준에 못 미치면 새 매수 신호와 대기 주문을 막습니다. 이미 보유한 자산은 계속 감시합니다. 이전 실행 기록은 차단 조건 적용 여부를 확인하지 못할 수 있습니다.'
    };
    const promotionBlockers = [];
    if (!costFloorStatus.ready) {
      const configuredCostLabel = costFloorStatus.configuredCostPercent === null
        ? '확인 불가'
        : `${costFloorStatus.configuredCostPercent.toFixed(2)}%`;
      promotionBlockers.push(
        `왕복 거래 비용 가정 ${configuredCostLabel}가 최소 기준 ${costFloorStatus.requiredCostPercent.toFixed(2)}%보다 낮거나 확인되지 않았습니다.`
      );
    }
    if (ledger.configDrift) {
      promotionBlockers.push('설정 변경 이력이 있어 동일 조건 비교를 할 수 없습니다.');
    }
    if (!observedMddAvailable || !observedMddFullSessionCoverage) {
      promotionBlockers.push('최대 낙폭 기록이 없거나 관찰 기간의 기록이 빠져 있어 위험 대비 수익성을 비교할 수 없습니다.');
    }
    if (trades.length < minimumResearchTrades) {
      promotionBlockers.push(`종료된 거래가 ${trades.length}/${minimumResearchTrades}건으로, 비교에 필요한 수보다 적습니다.`);
    }
    if (tradeReturnConfidence.sampleCount < trades.length) {
      promotionBlockers.push(`수익률을 계산할 수 있는 종료 거래가 ${tradeReturnConfidence.sampleCount}/${trades.length}건뿐입니다.`);
    }
    if (tradeReturnConfidence.sampleCount >= minimumResearchTrades &&
      (tradeReturnConfidence.lowerBoundPercent === null ||
        tradeReturnConfidence.lowerBoundPercent < 0)) {
      promotionBlockers.push('수익률을 보수적으로 계산했을 때 0%를 밑돌아, 안정적인 수익으로 보기 어렵습니다.');
    }
    if (tradeReturnConfidence.sampleCount >= minimumResearchTrades &&
      (realizedReturnPercent === null ||
        !Number.isFinite(Number(realizedReturnPercent)) ||
        Number(realizedReturnPercent) <= 0)) {
      promotionBlockers.push('기록된 모의 거래 수익률이 0% 이하입니다.');
    }
    if (observationDays === null) {
      promotionBlockers.push('관찰 시작일이나 종료일을 확인할 수 없어 관찰 기간을 계산할 수 없습니다.');
    } else if (observationDays < minimumResearchDays) {
      promotionBlockers.push(`관찰 기간이 ${observationDays.toFixed(2)}/${minimumResearchDays}일로, 필요한 기간에 못 미칩니다.`);
    }
    if (active) {
      promotionBlockers.push('관찰 세션이 아직 진행 중이라 최종 수익성 판정을 할 수 없습니다.');
    }
    if (ledger.runnerState !== 'running' || live !== true) {
      promotionBlockers.push('관찰을 실행하는 프로그램이 실행 중 상태가 아닙니다.');
    }
    if (heartbeatAgeSeconds === null || heartbeatAgeSeconds * 1000 > heartbeatLimitMs) {
      promotionBlockers.push('실행 중 프로그램의 최근 갱신 시각이 오래되어 관찰이 계속 이어졌는지 확인할 수 없습니다.');
    }
    const openPositionCount = Object.keys(ledger.positions || {}).length;
    if (openPositionCount > 0) {
      promotionBlockers.push(`아직 종료되지 않은 포지션이 ${openPositionCount}개 있어 평가손익만으로 수익성을 판단할 수 없습니다.`);
    }
    if (ledger.networkFetchCircuitOpen === true) {
      promotionBlockers.push('시세 수집이 중단되어 관찰 기록이 이어지지 않았습니다.');
    } else if (Number(ledger.networkFetchFailureStreak) > 0) {
      promotionBlockers.push(`시세를 ${Number(ledger.networkFetchFailureStreak)}회 연속 가져오지 못했습니다.`);
    }
    if (ledger.quoteQuality?.enabled === true && ledger.quoteQuality.valid !== true) {
      promotionBlockers.push('최근 호가 정보가 유효하지 않아 예상 거래 비용을 계산할 수 없습니다.');
    }
    if (executionModel === 'quote_cross' && ledger.quoteQuality?.executionReady !== true) {
      promotionBlockers.push('매수·매도 호가를 기준으로 계산하는 방식에 필요한 호가 정보가 유효하지 않습니다.');
    }
    if (Number(ledger.config?.maxSpreadPercent) > 0 && trades.length > 0 &&
      quoteExecution.availableCount < trades.length) {
      promotionBlockers.push(`매수·매도 호가 기록이 ${quoteExecution.availableCount}/${trades.length}건뿐이라 예상 거래 비용을 계산할 자료가 부족합니다.`);
    }
    const executionModelBlockedCount =
      (Number(ledger.executionModelEntryBlocked) || 0) +
      (Number(ledger.executionModelExitBlocked) || 0) +
      (Number(ledger.executionModelMarkBlocked) || 0) +
      (Number(ledger.pendingEntryExecutionBlocked) || 0);
    if (executionModelBlockedCount > 0) {
      promotionBlockers.push(`가격 모델이 ${executionModelBlockedCount}회 진입을 막아 이 모의 거래 기록을 연속된 관찰 자료로 보기 어렵습니다.`);
    }
    if (!ledger.dataQuality || ledger.dataQuality.valid !== true) {
      promotionBlockers.push('일봉 시세 기록이 불완전해 신규 진입을 막았습니다.');
    }
    const dataQualityObservationCycles = Math.max(
      0,
      Number(ledger.dataQualityObservationCycles) || 0
    );
    const dataQualityInvalidCycles = Math.max(
      0,
      Number(ledger.dataQualityInvalidCycles) || 0
    );
    const dataQualityBlockedChecks = Math.max(
      0,
      Number(ledger.dataQualityBlocked) || 0
    );
    const dataQualityBlockedChecksAttribution = dataQualityBlockedChecks === 0
      ? 'none'
      : dataQualityInvalidCycles > 0 || ledger.dataQuality?.valid !== true
        ? 'quality_history'
        : dataQualityObservationCycles > 0
          ? 'legacy_unclassified'
          : 'unclassified';
    if (dataQualityInvalidCycles > 0 || dataQualityBlockedChecks > 0) {
      const qualityHistory = [];
      if (dataQualityInvalidCycles > 0) {
        qualityHistory.push(
          `일봉 시세 오류 ${dataQualityInvalidCycles}/${Math.max(1, dataQualityObservationCycles)}회`
        );
      }
      if (dataQualityBlockedChecks > 0) {
        qualityHistory.push(
          `시장 검토 차단 ${dataQualityBlockedChecks}회${dataQualityBlockedChecksAttribution === 'legacy_unclassified'
            ? ' · 과거 실행 원인 미분류'
            : ''}`
        );
      }
      promotionBlockers.push(
        `일봉 시세 오류와 시장 확인 기록(${qualityHistory.join(' · ')}) 때문에 같은 조건으로 관찰이 이어졌는지 확인할 수 없습니다.`
      );
    }

    return {
      key: definition.key,
      label: definition.label,
      description: definition.description,
      available: true,
      status: ledger.configDrift
        ? '설정 변경 · 확인 필요'
        : active ? '관찰 중' : ledger.runnerStopReason ? '중지' : '상태 확인 필요',
      statusReason: ledger.configDrift
        ? '설정이 바뀌어 이 기록은 다른 전략과 비교하거나 실제 거래를 검토하는 데 사용할 수 없습니다.'
        : active ? null : formatRunnerStopReason(ledger.runnerStopReason),
      cycleDiagnostics: {
        active: Boolean(ledger.currentCycleStage),
        stage: ledger.currentCycleStage || null,
        market: ledger.currentCycleMarket || null,
        stopReason: ledger.runnerStopReason || null,
        stoppedAt: ledger.runnerStoppedAt || null
      },
      runnerLifecycle: projectMomentumShadowRunnerLifecycle(ledger),
      researchOnly: true,
      promoted: false,
      executionModel,
      executionModelNote: executionModel === 'quote_cross'
        ? '매수할 때는 가장 낮은 매도 호가, 매도·평가할 때는 가장 높은 매수 호가를 적용한 가격 모델입니다. 실제 체결이나 계좌 정산 기록은 아닙니다.'
        : '완료된 일봉의 종가를 기준으로 계산한 모의 거래 가격입니다.',
      executionModelBlockedCount,
      heartbeatAt: ledger.heartbeatAt || null,
      heartbeatAgeSeconds,
      cycles: Number(ledger.cycles) || 0,
      markets: Array.isArray(ledger.config?.markets) ? ledger.config.markets.length : 0,
      observationDays,
      minimumResearchTrades,
      minimumResearchDays,
      initialBalance: equity.initialBalance,
      cash: equity.balance,
      markedEquity: equity.markedEquity,
      markedReturnPercent: equity.markedReturnPercent,
      realizedProfit: realizedProfitAmount,
      realizedReturnPercent,
      realizedByMarket,
      realizedTradeConfidence: tradeReturnConfidence,
      entryCostFloor,
      profitConcentration: summarizeMomentumShadowProfitConcentration(ledger),
      lossCapCounterfactual: summarizeMomentumShadowLossCapCounterfactual(ledger),
      unrealizedProfit: equity.unrealizedProfit,
      observedDrawdown: {
        available: observedMddAvailable,
        fullSessionCoverage: observedMddFullSessionCoverage,
        coverageReasons: Array.isArray(ledger.observedMddCoverageReasons)
          ? ledger.observedMddCoverageReasons
          : [],
        sampleCount: observedMddSampleCount,
        startedAt: ledger.observedMddStartedAt || null,
        lastObservedAt: ledger.observedMddLastAt || null,
        samplingIntervalMs: Number.isFinite(Number(ledger.observedMddSamplingIntervalMs))
          ? Number(ledger.observedMddSamplingIntervalMs)
          : null,
        observedPeakEquity: Number.isFinite(Number(ledger.observedMddPeakEquity))
          ? Number(ledger.observedMddPeakEquity)
          : null,
        currentDrawdownPercent: Number.isFinite(Number(ledger.observedMddCurrentDrawdownPercent))
          ? Number(ledger.observedMddCurrentDrawdownPercent)
          : null,
        maxDrawdownPercent: observedMddAvailable
          ? Number(ledger.observedMddMaxDrawdownPercent)
          : null,
        maxDrawdownAt: ledger.observedMddMaxDrawdownAt || null,
        maxDrawdownPeakEquity: Number.isFinite(Number(ledger.observedMddMaxDrawdownPeakEquity))
          ? Number(ledger.observedMddMaxDrawdownPeakEquity)
          : null,
        maxDrawdownTroughEquity: Number.isFinite(Number(ledger.observedMddMaxDrawdownTroughEquity))
          ? Number(ledger.observedMddMaxDrawdownTroughEquity)
          : null,
        note: '일정 간격으로 기록한 평가자산 기준 최대 낙폭입니다. 장중의 세밀한 가격 변동은 포함하지 않습니다.'
      },
      closedTradeCount: trades.length,
      winningTrades,
      losingTrades: trades.length - winningTrades,
      configurationWarning: ledger.configDrift
        ? '관찰 중 설정이 바뀌어 이 기록은 같은 조건의 전략 비교나 실제 거래 판단에 사용할 수 없습니다.'
        : null,
      configurationDriftChanges: ledger.configDrift?.previous && ledger.config
        ? getMomentumShadowConfigDriftChanges(ledger.configDrift.previous, ledger.config)
        : [],
      promotionStatus: '실거래 적용 보류',
      promotionBlockers,
      dataQuality: ledger.dataQuality ? {
        valid: ledger.dataQuality.valid === true,
        reason: ledger.dataQuality.reason || null,
        marketCount: Number(ledger.dataQuality.marketCount) || 0,
        missingMarkets: Array.isArray(ledger.dataQuality.missingMarkets)
          ? ledger.dataQuality.missingMarkets
          : [],
        invalidMarkets: Array.isArray(ledger.dataQuality.invalidMarkets)
          ? ledger.dataQuality.invalidMarkets
          : [],
        unalignedMarkets: Array.isArray(ledger.dataQuality.unalignedMarkets)
          ? ledger.dataQuality.unalignedMarkets
          : [],
        staleMarkets: Array.isArray(ledger.dataQuality.staleMarkets)
          ? ledger.dataQuality.staleMarkets
          : [],
        latestTimestamp: ledger.dataQuality.latestTimestamp || null,
        latestAgeSecondsByMarket: ledger.dataQuality.latestAgeSecondsByMarket || {},
        maxAgeHours: Number.isFinite(Number(ledger.dataQuality.maxAgeHours))
          ? Number(ledger.dataQuality.maxAgeHours)
          : null,
        observationCycles: dataQualityObservationCycles,
        validCycles: Math.max(0, Number(ledger.dataQualityValidCycles) || 0),
        invalidCycles: dataQualityInvalidCycles,
        invalidReasonCounts: ledger.dataQualityInvalidReasonCounts &&
          typeof ledger.dataQualityInvalidReasonCounts === 'object'
          ? ledger.dataQualityInvalidReasonCounts
          : {},
        // Legacy ledgers called this counter dataQualityBlocked, but the
        // runner increments it once per market review, not once per order.
        // Keep the old field for consumers while exposing the precise name.
        blockedEntries: dataQualityBlockedChecks,
        blockedChecks: dataQualityBlockedChecks,
        blockedChecksAttribution: dataQualityBlockedChecksAttribution
      } : null,
      benchmark: ledger.config?.benchmarkMarket ? {
        configured: true,
        market: String(ledger.config.benchmarkMarket).replace(/^KRW-/, ''),
        trendPercent: Number.isFinite(Number(ledger.benchmarkTrendPercent))
          ? Number(ledger.benchmarkTrendPercent)
          : null,
        gateOpen: ledger.benchmarkGateOpen === true,
        available: ledger.benchmarkAvailable !== false,
        blockedEntries: Number(ledger.benchmarkBlocked) || 0,
        observationSchemaVersion: benchmarkObservationSchemaVersion,
        observationTelemetryReady: benchmarkObservationTelemetryReady,
        observationAvailable: benchmarkObservationAvailable,
        observationStartTs: ledger.benchmarkObservationStartTs || null,
        observationMarkTs: ledger.benchmarkObservationMarkTs || null,
        observationReturnPercent: benchmarkObservationAvailable
          ? benchmarkObservationReturnPercent
          : null,
        relativeMarkedReturnPercent,
        observationCheckpoints: benchmarkObservationCheckpoints,
        observationReason: benchmarkObservationAvailable
          ? ledger.benchmarkObservationReason || null
          : !benchmarkObservationTelemetryReady
            ? 'benchmark_observation_telemetry_legacy'
            : ledger.benchmarkObservationReason || 'benchmark_observation_not_recorded'
      } : { configured: false },
      quoteQuality: ledger.quoteQuality ? {
        enabled: ledger.quoteQuality.enabled === true,
        valid: ledger.quoteQuality.valid === true,
        executionModel: ledger.quoteQuality.executionModel || executionModel,
        executionRequired: ledger.quoteQuality.executionRequired === true,
        executionReady: ledger.quoteQuality.executionReady !== false,
        reason: ledger.quoteQuality.reason || null,
        maxSpreadPercent: Number(ledger.quoteQuality.maxSpreadPercent) || 0,
        marketCount: Number(ledger.quoteQuality.marketCount) || 0,
        missingMarkets: Array.isArray(ledger.quoteQuality.missingMarkets)
          ? ledger.quoteQuality.missingMarkets
          : [],
        invalidMarkets: Array.isArray(ledger.quoteQuality.invalidMarkets)
          ? ledger.quoteQuality.invalidMarkets
          : [],
        blockedMarkets: Array.isArray(ledger.quoteQuality.blockedMarkets)
          ? ledger.quoteQuality.blockedMarkets
          : []
      } : null,
      quoteExecution,
      tradeCostAudit,
      network: {
        fetchErrors: Number(ledger.fetchErrors) || 0,
        circuitOpen: ledger.networkFetchCircuitOpen === true,
        failureStreak: Number(ledger.networkFetchFailureStreak) || 0,
        maxConsecutiveFailures: Number(ledger.networkFetchMaxConsecutiveFailures) || 3,
        maxCycleDurationMs: Number.isFinite(Number(ledger.networkFetchMaxCycleDurationMs))
          ? Number(ledger.networkFetchMaxCycleDurationMs)
          : null,
        circuitBreaks: Number(ledger.networkFetchCircuitBreaks) || 0,
        failureCount: Number(ledger.networkFetchFailureCount) || 0,
        lastErrorCode: ledger.lastNetworkFetchError?.code || null,
        lastErrorMarket: ledger.lastNetworkFetchError?.market || null,
        lastErrorAt: ledger.lastNetworkFetchError?.at || null
      },
      riskControls: {
        configured: Object.prototype.hasOwnProperty.call(ledger.config || {}, 'cooldownAfterLossDays') ||
          Object.prototype.hasOwnProperty.call(ledger.config || {}, 'maxPortfolioDrawdownPercent') ||
          Object.prototype.hasOwnProperty.call(ledger.config || {}, 'maxSpreadPercent') ||
          Object.prototype.hasOwnProperty.call(ledger.config || {}, 'executionModel'),
        cooldownAfterLossDays: Number(ledger.config?.cooldownAfterLossDays) || 0,
        maxPortfolioDrawdownPercent: Number(ledger.config?.maxPortfolioDrawdownPercent) || 0,
        drawdownStopTriggered: ledger.drawdownStopTriggered === true,
        drawdownStopAt: ledger.drawdownStopAt || null,
        drawdownPercent: Number.isFinite(Number(ledger.drawdownPercent)) ? Number(ledger.drawdownPercent) : null,
        peakEquity: Number.isFinite(Number(ledger.peakEquity)) ? Number(ledger.peakEquity) : null,
        cooldownBlockedEntries: Number(ledger.cooldownBlocked) || 0,
        drawdownBlockedEntries: Number(ledger.drawdownBlocked) || 0,
        duplicateSignalBlockedEntries: Number(ledger.duplicateSignalBlocked) || 0,
        pendingEntryCount: Array.isArray(ledger.pendingEntries) ? ledger.pendingEntries.length : 0,
        pendingEntryBlocked: Number(ledger.pendingEntryBlocked) || 0,
        pendingEntryDataQualityBlocked: Number(ledger.pendingEntryDataQualityBlocked) || 0,
        pendingEntryGapBlocked: Number(ledger.pendingEntryGapBlocked) || 0,
        pendingEntryQuoteBlocked: Number(ledger.pendingEntryQuoteBlocked) || 0,
        pendingEntryExecutionBlocked: Number(ledger.pendingEntryExecutionBlocked) || 0,
        spreadBlockedEntries: Number(ledger.spreadBlocked) || 0,
        relativeTrendBlockedEntries: Number(ledger.relativeTrendBlocked) || 0,
        executionModelEntryBlocked: Number(ledger.executionModelEntryBlocked) || 0,
        executionModelExitBlocked: Number(ledger.executionModelExitBlocked) || 0,
        executionModelMarkBlocked: Number(ledger.executionModelMarkBlocked) || 0
      },
      openPositions: Object.entries(ledger.positions || {}).map(([market, position]) => ({
        asset: String(market).replace(/^KRW-/, ''),
        entryPrice: Number(position.entryPrice) || null,
        decisionEntryPrice: Number.isFinite(Number(position.decisionEntryPrice))
          ? Number(position.decisionEntryPrice)
          : null,
        executionModel: resolveMomentumShadowExecutionModel(position.executionModel || executionModel),
        executionPriceSource: position.executionPriceSource || null,
        markPrice: Number.isFinite(Number(position.markPrice)) ? Number(position.markPrice) : null,
        markPriceSource: position.markPriceSource || null,
        markProfitPercent: Number.isFinite(Number(position.markProfitPercent))
          ? Number(position.markProfitPercent)
          : null,
        entryTs: position.entryTs || null
      })),
      contract: {
        costPercent: Number(ledger.config?.costPercent) || 0,
        trendMinPercent: Number(ledger.config?.trendMinPercent) || 0,
        breadthMin: Number(ledger.config?.breadthMin) || 0,
        maxHoldHours: Number(ledger.config?.maxHoldHours) || 0,
        positionFraction: Number(ledger.config?.positionFraction) || 0,
        maxPositions: Number(ledger.config?.maxPositions) || 0,
        benchmarkMarket: ledger.config?.benchmarkMarket
          ? String(ledger.config.benchmarkMarket).replace(/^KRW-/, '')
          : null,
        benchmarkTrendMinPercent: Number.isFinite(Number(ledger.config?.benchmarkTrendMinPercent))
          ? Number(ledger.config.benchmarkTrendMinPercent)
          : null,
        relativeTrendMinPercent: ledger.config?.relativeTrendMinPercent === null ||
          ledger.config?.relativeTrendMinPercent === undefined ||
          ledger.config?.relativeTrendMinPercent === ''
          ? null
          : Number.isFinite(Number(ledger.config.relativeTrendMinPercent))
            ? Number(ledger.config.relativeTrendMinPercent)
            : null,
        exitOnBenchmarkOff: ledger.config?.exitOnBenchmarkOff === true,
        cooldownAfterLossDays: Number(ledger.config?.cooldownAfterLossDays) || 0,
        maxPortfolioDrawdownPercent: Number(ledger.config?.maxPortfolioDrawdownPercent) || 0,
        volatilityLookbackDays: Number(ledger.config?.volatilityLookbackDays) || null,
        volatilityTargetPercent: Number.isFinite(Number(ledger.config?.volatilityTargetPercent)) &&
          Number(ledger.config.volatilityTargetPercent) > 0
          ? Number(ledger.config.volatilityTargetPercent)
          : null,
        entryExecution: ledger.config?.entryExecution === 'next_open' ? 'next_open' : 'close',
        executionModel,
        maxEntryGapPercent: Number(ledger.config?.maxEntryGapPercent) || 0,
        // Ledgers written before the freshness knob existed omit the key, but
        // every current runner enforces the shared default. Show the enforced
        // contract instead of reporting a misleading 0-hour ceiling.
        maxDailyCandleAgeHours: Number.isFinite(Number(ledger.config?.maxDailyCandleAgeHours))
          ? Number(ledger.config.maxDailyCandleAgeHours)
          : DEFAULT_MOMENTUM_SHADOW_CANDIDATE_CONFIG.maxDailyCandleAgeHours,
        maxSpreadPercent: Number(ledger.config?.maxSpreadPercent) || 0
      }
    };
  } catch (error) {
    return {
      key: definition.key,
      label: definition.label,
      description: definition.description,
      available: false,
      status: '기록을 불러오지 못함',
      researchOnly: true,
      promoted: false,
      error: error.message
    };
  }
}

function resolveReportFile(server) {
  const configured = server?.tradingSystem?.config?.scalpingVariantReportFile ||
    process.env.SCALP_VARIANT_REPORT_FILE ||
    server?.tradingSystem?.config?.higherTimeframeMomentumReportFile ||
    process.env.SCALP_HTF_MOMENTUM_REPORT_FILE ||
    process.env.SCALP_HTF_MOMENTUM_OUTPUT_FILE ||
    process.env.DAILY_MOMENTUM_ROBUSTNESS_REPORT_FILE ||
    '';
  if (!configured) return null;
  return path.isAbsolute(configured) ? configured : path.resolve(PROJECT_ROOT, configured);
}

/**
 * Read-only strategy research projection. This endpoint intentionally forces
 * the promotion boundary to false even if a hand-edited report contains a
 * truthy value; research artifacts never authorize orders.
 */
export default function createResearchRoutes(server) {
  const router = express.Router();

  const getLiveExecutionEvidenceStatus = () => projectLiveExecutionEvidenceStatus({
    filePath: server?.tradingSystem?.liveExecutionEvidenceFile ||
      process.env.LIVE_EXECUTION_EVIDENCE_FILE ||
      '.coinpilot-runtime/live-execution/evidence.jsonl',
    liveMode: server?.tradingSystem?.dryRun === false,
    runtimeWriteError: server?.tradingSystem?.liveExecutionEvidenceWriteError,
    runtimeDataError: server?.tradingSystem?.liveExecutionEvidenceDataError
  });

  router.get('/live-execution-evidence', (req, res) => {
    return res.json(getLiveExecutionEvidenceStatus());
  });

  router.get('/momentum-shadow', (req, res) => {
    const fallbackInitialBalance = Number(process.env.MOMO_SHADOW_INITIAL_BALANCE) || 100_000_000;
    const quoteHistorySource = readMomentumShadowQuoteHistoryRecords(server);
    const books = momentumShadowBookDefinitions(server)
      .map(definition => projectMomentumShadowBook(
        definition,
        fallbackInitialBalance,
        server,
        quoteHistorySource
      ));
    const candidateReadiness = projectMomentumShadowCandidateReadiness(server);
    const paperForwardCohort = summarizePaperForwardCohort({ rootDir: PROJECT_ROOT });
    const lossCapNoDogeReadiness = projectMomentumShadowFixedHoldReadiness(server, {
      stopLossPercent: 4,
      excludeDoge: true
    });
    lossCapNoDogeReadiness.historicalEvidence = getMomentumShadowHistoricalEvidence('loss_cap_no_doge');
    const candidateReadinessVariants = [
      { key: 'baseline', label: '기본 전략', readiness: candidateReadiness },
      {
        key: 'volatility',
        label: '변동성에 따라 비중 조절',
        readiness: projectMomentumShadowVolatilityReadiness(server)
      },
      {
        key: 'next_open',
        label: '거래 비용 반영 · 다음 날 시가 진입',
        readiness: projectMomentumShadowNextOpenReadiness(server)
      },
      {
        key: 'fixed_2d',
        label: '2일 뒤 청산',
        readiness: projectMomentumShadowFixedHoldReadiness(server)
      },
      {
        key: 'fixed_2d_loss_cap',
        label: '2일 보유 · 종가 기준 손실 제한',
        readiness: projectMomentumShadowFixedHoldReadiness(server, { stopLossPercent: 4 })
      },
      {
        key: 'fixed_2d_loss_cap_no_doge',
        label: '2일 보유 · 도지코인 제외 · 손실 제한',
        readiness: lossCapNoDogeReadiness
      },
      {
      key: 'fixed_2d_relative',
        label: '2일 보유 · 비트코인 대비 강한 추세',
        readiness: projectMomentumShadowFixedHoldReadiness(server, {
          relativeTrendMinPercent: 0
        })
      },
      {
        key: 'fixed_2d_spread',
        label: '2일 보유 · 호가 제한',
        readiness: projectMomentumShadowFixedHoldReadiness(server, { spreadGuard: true })
      },
      {
        key: 'fixed_2d_quote_cross',
        label: '2일 보유 · 매수·매도 호가 기준',
        readiness: projectMomentumShadowFixedHoldReadiness(server, { quoteCross: true })
      }
    ];
    return res.json({
      available: books.some(book => book.available),
      researchOnly: true,
      promoted: false,
      projectionReason: 'momentum_shadow_is_diagnostic_only_and_never_authorizes_orders',
      liveExecutionEvidence: getLiveExecutionEvidenceStatus(),
      quoteQualitySnapshot: projectMomentumShadowQuoteQualitySnapshot(server),
      paperForwardCohort,
      candidateReadiness,
      candidateReadinessVariants,
      books
    });
  });

  router.get('/strategy-research', (req, res) => {
    const reportFile = resolveReportFile(server);
    if (!reportFile) {
      return res.json({
        available: false,
        researchOnly: true,
        promoted: false,
        reason: 'research_report_not_configured'
      });
    }
    // Project only the basename — the absolute report path is local
    // filesystem detail, not dashboard evidence.
    const reportFileName = path.basename(reportFile);
    if (!fs.existsSync(reportFile)) {
      return res.json({
        available: false,
        researchOnly: true,
        promoted: false,
        reportFile: reportFileName,
        reason: 'research_report_not_found'
      });
    }

    try {
      const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
      if (!report || typeof report !== 'object' || Array.isArray(report)) {
        throw new Error('research report 형식이 잘못되었습니다.');
      }
      return res.json({
        ...report,
        available: true,
        researchOnly: true,
        promoted: false,
        reportFile: reportFileName,
        reportFreshness: assessScalpingValidationReportFreshness(report.generatedAt),
        projectionReason: 'research_artifact_never_authorizes_live_orders'
      });
    } catch (error) {
      return res.status(500).json({
        available: false,
        researchOnly: true,
        promoted: false,
        reportFile: reportFileName,
        reason: 'research_report_invalid',
        error: error.message
      });
    }
  });

  return router;
}
