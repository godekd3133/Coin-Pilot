import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMomentumShadowEquity } from '../../research/momentumShadowLedger.js';
import {
  calculateMomentumShadowRealizedProfit,
  calculateMomentumShadowRealizedReturnPercent,
  calculateMomentumShadowTradeConfidence,
  summarizeMomentumShadowTradesByMarket,
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
import { resolveMomentumShadowExecutionModel } from '../../research/momentumShadowExecutionModel.js';
import {
  summarizeMomentumShadowLossCapCounterfactual
} from '../../research/momentumShadowLossCapCounterfactual.js';
import { summarizePaperForwardCohort } from '../../research/paperForwardCohort.js';
import { assessScalpingValidationReportFreshness } from '../../research/scalpingValidationFreshness.js';
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
  const configuredHistoryFile = config.momentumShadowQuoteHistoryFile ||
    process.env.MOMO_SHADOW_QUOTE_HISTORY_FILE ||
    resolveMomentumShadowQuoteRuntimeFile('quote-history.jsonl');
  const historyFile = path.isAbsolute(configuredHistoryFile)
    ? configuredHistoryFile
    : path.resolve(PROJECT_ROOT, configuredHistoryFile);
  const history = projectMomentumShadowQuoteHistory({
    historyFile,
    maxAgeSeconds
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
    const markets = Object.fromEntries(Object.entries(rawMarkets).map(([market, row]) => [market, {
      sampleCount: Math.max(0, Number(row?.sampleCount) || 0),
      p95: finiteOrNull(row?.p95),
      max: finiteOrNull(row?.max),
      overCeiling: Math.max(0, Number(row?.overCeiling) || 0)
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
      history,
      note: 'orderbook quote observations are research-only and do not represent fills, realized P&L, or live-order authorization'
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
      label: '고정 72시간',
      description: '현재 진입계약 · 72시간 종료',
      directory: config.momentumShadowFixedDir ||
        process.env.MOMO_SHADOW_FIXED_DIR ||
        path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-v1')
    },
    {
      key: 'regime',
      label: '추세 전환',
      description: '현재 진입계약 · 추세 off 종료',
      directory: config.momentumShadowRegimeDir ||
        process.env.MOMO_SHADOW_REGIME_DIR ||
        path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-regime')
    },
    {
      key: 'benchmark',
      label: 'BTC gate 방어 후보',
      description: 'BTC 7일 추세 gate · benchmark off 청산',
      directory: config.momentumShadowBenchmarkDir ||
        process.env.MOMO_SHADOW_BENCHMARK_DIR ||
        path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-btc-gate-v1')
    },
    {
      key: 'volatility',
      label: '변동성 제한 A/B 후보',
      description: '목표 일변동성 1% · 고변동 종목 비중 축소',
      directory: config.momentumShadowVolatilityDir ||
        process.env.MOMO_SHADOW_VOLATILITY_DIR ||
        path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-vol-target-v1')
    },
    {
      key: 'next_open',
      label: '비용 대응·다음 시가 후보',
      description: 'cost 0.3% · 다음 일봉 시작가 체결',
      directory: config.momentumShadowNextOpenDir ||
        process.env.MOMO_SHADOW_NEXT_OPEN_DIR ||
        path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-next-open-v1')
    },
    {
      key: 'fixed_2d',
      label: '2일 고정 종료 A/B 후보',
      description: 'cost 0.3% · 다음 시가 진입 · 48시간 종료',
      directory: config.momentumShadowFixedHoldDir ||
        process.env.MOMO_SHADOW_FIXED_HOLD_DIR ||
        path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-fixed-hold-2d-v1')
    },
    {
      key: 'fixed_2d_loss_cap',
      label: '2일·종가 손실 상한 A/B 후보',
      description: 'cost 0.3% · 다음 시가 진입 · 48시간 종료 · 완료 일봉 종가 손실 상한 4%',
      directory: config.momentumShadowFixedHoldLossCapDir ||
        process.env.MOMO_SHADOW_FIXED_HOLD_LOSS_CAP_DIR ||
        path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-fixed-hold-2d-loss-cap-v1')
    },
    {
      key: 'fixed_2d_spread',
      label: '2일·호가 제한 A/B 후보',
      description: 'cost 0.3% · 다음 시가 진입 · 48시간 종료 · spread 0.5% 이하',
      directory: config.momentumShadowFixedHoldSpreadDir ||
        process.env.MOMO_SHADOW_FIXED_HOLD_SPREAD_DIR ||
        path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-fixed-hold-2d-spread-v1')
    },
    {
      key: 'fixed_2d_relative',
      label: '2일·상대추세 A/B 후보',
      description: 'cost 0.3% · 다음 시가 진입 · 48시간 종료 · BTC 대비 상대추세 우위',
      directory: config.momentumShadowFixedHoldRelativeDir ||
        process.env.MOMO_SHADOW_FIXED_HOLD_RELATIVE_DIR ||
        path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-fixed-hold-2d-relative-v1')
    },
    {
      key: 'fixed_2d_quote_cross',
      label: '2일·호가 경계 모델 A/B 후보',
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
    heartbeat_timeout: '갱신 지연 자동 중지',
    cycle_timeout: 'cycle 처리 시간 초과',
    candidate_slot_lost: '후보 실행 슬롯 소유권 상실',
    lock_lost: '잠금 소유권 상실 감지',
    before_exit: '실행 종료 감지',
    startup_failure: '시작 실패',
    uncaught_exception: '처리되지 않은 오류',
    unhandled_rejection: '처리되지 않은 비동기 오류',
    stopped_cleanly: '정상 중지'
  };
  return labels[reason] || (reason ? '종료 원인 확인 필요' : null);
}

function projectMomentumShadowBook(definition, fallbackInitialBalance, server) {
  const ledgerFile = path.join(definition.directory, 'ledger.json');
  if (!fs.existsSync(ledgerFile)) {
    return {
      key: definition.key,
      label: definition.label,
      description: definition.description,
      available: false,
      status: '데이터 없음',
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
    const promotionBlockers = [];
    if (ledger.configDrift) {
      promotionBlockers.push('설정 변경 이력이 있어 동일 조건 비교를 할 수 없습니다.');
    }
    if (trades.length < minimumResearchTrades) {
      promotionBlockers.push(`청산 표본이 ${trades.length}/${minimumResearchTrades}회로 부족합니다.`);
    }
    if (tradeReturnConfidence.sampleCount < trades.length) {
      promotionBlockers.push(`유효한 청산 수익률이 ${tradeReturnConfidence.sampleCount}/${trades.length}건으로 부족합니다.`);
    }
    if (tradeReturnConfidence.sampleCount >= minimumResearchTrades &&
      (tradeReturnConfidence.lowerBoundPercent === null ||
        tradeReturnConfidence.lowerBoundPercent < 0)) {
      promotionBlockers.push('거래수익 95% 하한이 0% 미만이라 안정적인 양수 수익을 확인할 수 없습니다.');
    }
    if (tradeReturnConfidence.sampleCount >= minimumResearchTrades &&
      (realizedReturnPercent === null ||
        !Number.isFinite(Number(realizedReturnPercent)) ||
        Number(realizedReturnPercent) <= 0)) {
      promotionBlockers.push('실현 순수익률이 0% 이하라 실제 순수익으로 이어졌다고 확인할 수 없습니다.');
    }
    if (observationDays === null) {
      promotionBlockers.push('관찰 시작/종료 시각을 확인할 수 없어 관찰 기간을 증명할 수 없습니다.');
    } else if (observationDays < minimumResearchDays) {
      promotionBlockers.push(`관찰 기간 ${observationDays.toFixed(2)}/${minimumResearchDays}일로 부족합니다.`);
    }
    if (active) {
      promotionBlockers.push('관찰 세션이 아직 진행 중이라 최종 수익성 판정을 할 수 없습니다.');
    }
    if (ledger.runnerState !== 'running' || live !== true) {
      promotionBlockers.push('owner process가 현재 관찰 중 상태가 아닙니다.');
    }
    if (heartbeatAgeSeconds === null || heartbeatAgeSeconds * 1000 > heartbeatLimitMs) {
      promotionBlockers.push('owner heartbeat가 오래되어 관찰 연속성을 확인할 수 없습니다.');
    }
    const openPositionCount = Object.keys(ledger.positions || {}).length;
    if (openPositionCount > 0) {
      promotionBlockers.push(`미청산 포지션 ${openPositionCount}개가 있어 평가손익만으로는 전환할 수 없습니다.`);
    }
    if (ledger.networkFetchCircuitOpen === true) {
      promotionBlockers.push('시세 수집 회로가 현재 열려 있어 관찰 연속성이 끊겼습니다.');
    } else if (Number(ledger.networkFetchFailureStreak) > 0) {
      promotionBlockers.push(`시세 수집이 현재 ${Number(ledger.networkFetchFailureStreak)}회 연속 실패 중입니다.`);
    }
    if (ledger.quoteQuality?.enabled === true && ledger.quoteQuality.valid !== true) {
      promotionBlockers.push('호가 품질이 현재 유효하지 않아 실제 체결 비용을 확인할 수 없습니다.');
    }
    if (executionModel === 'quote_cross' && ledger.quoteQuality?.executionReady !== true) {
      promotionBlockers.push('quote_cross 실행 모델에 필요한 호가 경계가 유효하지 않습니다.');
    }
    if (Number(ledger.config?.maxSpreadPercent) > 0 && trades.length > 0 &&
      quoteExecution.availableCount < trades.length) {
      promotionBlockers.push(`호가 경계 evidence가 ${quoteExecution.availableCount}/${trades.length}건으로 부족해 체결 비용을 확인할 수 없습니다.`);
    }
    const executionModelBlockedCount =
      (Number(ledger.executionModelEntryBlocked) || 0) +
      (Number(ledger.executionModelExitBlocked) || 0) +
      (Number(ledger.executionModelMarkBlocked) || 0) +
      (Number(ledger.pendingEntryExecutionBlocked) || 0);
    if (executionModelBlockedCount > 0) {
      promotionBlockers.push(`가격 실행 모델 차단 ${executionModelBlockedCount}회가 있어 해당 paper 표본을 완전한 관찰로 사용할 수 없습니다.`);
    }
    if (!ledger.dataQuality || ledger.dataQuality.valid !== true) {
      promotionBlockers.push('일봉 데이터 grid가 불완전해 신규 진입이 차단되었습니다.');
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
          `일봉 품질 실패 ${dataQualityInvalidCycles}/${Math.max(1, dataQualityObservationCycles)} cycle`
        );
      }
      if (dataQualityBlockedChecks > 0) {
        qualityHistory.push(
          `시장 검토 차단 ${dataQualityBlockedChecks}회${dataQualityBlockedChecksAttribution === 'legacy_unclassified'
            ? ' · 과거 owner 원인 미분류'
            : ''}`
        );
      }
      promotionBlockers.push(
        `일봉 품질·시장 검토 이력(${qualityHistory.join(' · ')})으로 인해 동일 조건의 연속 관찰을 입증할 수 없습니다.`
      );
    }

    return {
      key: definition.key,
      label: definition.label,
      description: definition.description,
      available: true,
      status: ledger.configDrift
        ? '증거 보류'
        : active ? '관찰 중' : ledger.runnerStopReason ? '중지' : '상태 확인 필요',
      statusReason: ledger.configDrift
        ? '설정 변경 이력으로 A/B·승격 증거 사용 불가'
        : active ? null : formatRunnerStopReason(ledger.runnerStopReason),
      cycleDiagnostics: {
        active: Boolean(ledger.currentCycleStage),
        stage: ledger.currentCycleStage || null,
        market: ledger.currentCycleMarket || null,
        stopReason: ledger.runnerStopReason || null,
        stoppedAt: ledger.runnerStoppedAt || null
      },
      researchOnly: true,
      promoted: false,
      executionModel,
      executionModelNote: executionModel === 'quote_cross'
        ? 'best ask entry · best bid exit/mark 모델이며 실제 fill·wallet settlement가 아닙니다.'
        : '완료 일봉 종가 기반 paper 가격 모델입니다.',
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
      lossCapCounterfactual: summarizeMomentumShadowLossCapCounterfactual(ledger),
      unrealizedProfit: equity.unrealizedProfit,
      closedTradeCount: trades.length,
      winningTrades,
      losingTrades: trades.length - winningTrades,
      configurationWarning: ledger.configDrift
        ? '중간 설정 변경 이력이 있어 이 장부는 A/B 비교와 승격에 사용할 수 없습니다.'
        : null,
      promotionStatus: '승격 보류',
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
      status: '읽기 실패',
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
    const books = momentumShadowBookDefinitions(server)
      .map(definition => projectMomentumShadowBook(definition, fallbackInitialBalance, server));
    const candidateReadiness = projectMomentumShadowCandidateReadiness(server);
    const paperForwardCohort = summarizePaperForwardCohort({ rootDir: PROJECT_ROOT });
    const lossCapNoDogeReadiness = projectMomentumShadowFixedHoldReadiness(server, {
      stopLossPercent: 4,
      excludeDoge: true
    });
    lossCapNoDogeReadiness.historicalEvidence = getMomentumShadowHistoricalEvidence('loss_cap_no_doge');
    const candidateReadinessVariants = [
      { key: 'baseline', label: '기본 후보', readiness: candidateReadiness },
      {
        key: 'volatility',
        label: '변동성 제한 A/B 후보',
        readiness: projectMomentumShadowVolatilityReadiness(server)
      },
      {
        key: 'next_open',
        label: '비용 대응·다음 시가 후보',
        readiness: projectMomentumShadowNextOpenReadiness(server)
      },
      {
        key: 'fixed_2d',
        label: '2일 고정 종료 A/B 후보',
        readiness: projectMomentumShadowFixedHoldReadiness(server)
      },
      {
        key: 'fixed_2d_loss_cap',
        label: '2일·종가 손실 상한 A/B 후보',
        readiness: projectMomentumShadowFixedHoldReadiness(server, { stopLossPercent: 4 })
      },
      {
        key: 'fixed_2d_loss_cap_no_doge',
        label: '2일·DOGE 제외 손실 상한 후보',
        readiness: lossCapNoDogeReadiness
      },
      {
      key: 'fixed_2d_relative',
        label: '2일·상대추세 A/B 후보',
        readiness: projectMomentumShadowFixedHoldReadiness(server, {
          relativeTrendMinPercent: 0
        })
      },
      {
        key: 'fixed_2d_spread',
        label: '2일·호가 제한 A/B 후보',
        readiness: projectMomentumShadowFixedHoldReadiness(server, { spreadGuard: true })
      },
      {
        key: 'fixed_2d_quote_cross',
        label: '2일·호가 경계 모델 A/B 후보',
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
