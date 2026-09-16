import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMomentumShadowEquity } from '../../research/momentumShadowLedger.js';
import { inspectMomentumShadowCandidate } from '../../research/momentumShadowCandidatePreflight.js';
import {
  resolveMomentumShadowCandidateConfig,
  DEFAULT_MOMENTUM_SHADOW_CANDIDATE_CONFIG
} from '../../research/momentumShadowCandidateConfig.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

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
    config.momentumShadowFixedHoldSpreadDir ||
      process.env.MOMO_SHADOW_FIXED_HOLD_SPREAD_DIR ||
      path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-fixed-hold-2d-spread-v1')
  ];
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
    expectedConfig,
    requireBenchmarkOpen: process.env.MOMO_SHADOW_REQUIRE_BENCHMARK_OPEN !== 'false',
    minimumPollMs: Number.isFinite(Number(process.env.MOMO_SHADOW_MIN_POLL_MS))
      ? Number(process.env.MOMO_SHADOW_MIN_POLL_MS)
      : 15 * 60 * 1000
  });
}

function projectMomentumShadowFixedHoldReadiness(server, { spreadGuard = false } = {}) {
  const config = server?.tradingSystem?.config || {};
  const benchmarkDir = config.momentumShadowBenchmarkDir ||
    process.env.MOMO_SHADOW_BENCHMARK_DIR ||
    path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-btc-gate-v1');
  const fixedHoldDir = (spreadGuard
    ? config.momentumShadowFixedHoldSpreadDir ||
      process.env.MOMO_SHADOW_FIXED_HOLD_SPREAD_DIR ||
      path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-fixed-hold-2d-spread-v1')
    : config.momentumShadowFixedHoldDir ||
      process.env.MOMO_SHADOW_FIXED_HOLD_DIR ||
      path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-fixed-hold-2d-v1'));
  const ownerDirs = momentumShadowOwnerDirs(config);
  const expectedConfig = resolveMomentumShadowCandidateConfig({
    MOMO_SHADOW_MODE: 'fixed',
    MOMO_SHADOW_MAX_HOLD_HOURS: '48',
    MOMO_SHADOW_BENCHMARK_MARKET: 'KRW-BTC',
    MOMO_SHADOW_BENCHMARK_TREND_MIN_PERCENT: '1',
    MOMO_SHADOW_TREND_MIN_PERCENT: '2',
    MOMO_SHADOW_BREADTH_MIN: '3',
    MOMO_SHADOW_MIN_UP_BARS: '2',
    MOMO_SHADOW_POSITION_FRACTION: '0.125',
    MOMO_SHADOW_MAX_POSITIONS: '2',
    MOMO_SHADOW_COST_PERCENT: '0.3',
    MOMO_SHADOW_EXIT_ON_BENCHMARK_OFF: 'false',
    MOMO_SHADOW_COOLDOWN_AFTER_LOSS_DAYS: '3',
    MOMO_SHADOW_MAX_PORTFOLIO_DRAWDOWN_PERCENT: '15',
    MOMO_SHADOW_VOLATILITY_LOOKBACK_DAYS: '14',
    MOMO_SHADOW_VOLATILITY_TARGET_PERCENT: '1',
    MOMO_SHADOW_ENTRY_EXECUTION: 'next_open',
    MOMO_SHADOW_MAX_ENTRY_GAP_PERCENT: '0.2',
    MOMO_SHADOW_MAX_DAILY_CANDLE_AGE_HOURS: '36',
    MOMO_SHADOW_MAX_SPREAD_PERCENT: spreadGuard ? '0.5' : '0',
    MOMO_SHADOW_POLL_MS: '900000'
  });
  return inspectMomentumShadowCandidate({
    targetDir: fixedHoldDir,
    benchmarkDir,
    ownerDirs,
    expectedConfig,
    requireBenchmarkOpen: process.env.MOMO_SHADOW_REQUIRE_BENCHMARK_OPEN !== 'false',
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
      key: 'fixed_2d_spread',
      label: '2일·호가 제한 A/B 후보',
      description: 'cost 0.3% · 다음 시가 진입 · 48시간 종료 · spread 0.5% 이하',
      directory: config.momentumShadowFixedHoldSpreadDir ||
        process.env.MOMO_SHADOW_FIXED_HOLD_SPREAD_DIR ||
        path.resolve(PROJECT_ROOT, '.paper-momentum-shadow-fixed-hold-2d-spread-v1')
    }
  ];
};

function ownerAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return null;
  try { process.kill(value, 0); return true; }
  catch { return false; }
}

function realizedProfit(ledger) {
  return (ledger.trades || []).reduce((total, trade) =>
    total + ((Number(trade.profitPercent) || 0) / 100) * (Number(trade.entry?.size) || 0), 0);
}

function formatRunnerStopReason(reason) {
  const labels = {
    'signal:SIGINT': '사용자 중지',
    'signal:SIGTERM': '프로세스 종료 신호',
    heartbeat_timeout: '갱신 지연 자동 중지',
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
    const winningTrades = trades.filter(trade => Number(trade.profitPercent) > 0).length;
    const minimumResearchTrades = Math.max(
      1,
      Number(server?.tradingSystem?.config?.momentumShadowMinTrades) || 20
    );
    const promotionBlockers = [];
    if (ledger.configDrift) {
      promotionBlockers.push('설정 drift가 있어 비교 cohort가 깨끗하지 않습니다.');
    }
    if (trades.length < minimumResearchTrades) {
      promotionBlockers.push(`청산 표본이 ${trades.length}/${minimumResearchTrades}회로 부족합니다.`);
    }
    if (ledger.runnerState !== 'running' || live !== true) {
      promotionBlockers.push('owner process가 현재 관찰 중 상태가 아닙니다.');
    }
    if (ledger.dataQuality?.valid === false) {
      promotionBlockers.push('일봉 데이터 grid가 불완전해 신규 진입이 차단되었습니다.');
    }

    return {
      key: definition.key,
      label: definition.label,
      description: definition.description,
      available: true,
      status: active ? '관찰 중' : ledger.runnerStopReason ? '중지' : '상태 확인 필요',
      statusReason: active ? null : formatRunnerStopReason(ledger.runnerStopReason),
      researchOnly: true,
      promoted: false,
      heartbeatAt: ledger.heartbeatAt || null,
      heartbeatAgeSeconds,
      cycles: Number(ledger.cycles) || 0,
      markets: Array.isArray(ledger.config?.markets) ? ledger.config.markets.length : 0,
      initialBalance: equity.initialBalance,
      cash: equity.balance,
      markedEquity: equity.markedEquity,
      markedReturnPercent: equity.markedReturnPercent,
      realizedProfit: realizedProfit(ledger),
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
          : null
      } : null,
      benchmark: ledger.config?.benchmarkMarket ? {
        configured: true,
        market: String(ledger.config.benchmarkMarket).replace(/^KRW-/, ''),
        trendPercent: Number.isFinite(Number(ledger.benchmarkTrendPercent))
          ? Number(ledger.benchmarkTrendPercent)
          : null,
        gateOpen: ledger.benchmarkGateOpen === true,
        available: ledger.benchmarkAvailable !== false,
        blockedEntries: Number(ledger.benchmarkBlocked) || 0
      } : { configured: false },
      quoteQuality: ledger.quoteQuality ? {
        enabled: ledger.quoteQuality.enabled === true,
        valid: ledger.quoteQuality.valid === true,
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
      riskControls: {
        configured: Object.prototype.hasOwnProperty.call(ledger.config || {}, 'cooldownAfterLossDays') ||
          Object.prototype.hasOwnProperty.call(ledger.config || {}, 'maxPortfolioDrawdownPercent') ||
          Object.prototype.hasOwnProperty.call(ledger.config || {}, 'maxSpreadPercent'),
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
        spreadBlockedEntries: Number(ledger.spreadBlocked) || 0
      },
      openPositions: Object.entries(ledger.positions || {}).map(([market, position]) => ({
        asset: String(market).replace(/^KRW-/, ''),
        entryPrice: Number(position.entryPrice) || null,
        markPrice: Number.isFinite(Number(position.markPrice)) ? Number(position.markPrice) : null,
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
        exitOnBenchmarkOff: ledger.config?.exitOnBenchmarkOff === true,
        cooldownAfterLossDays: Number(ledger.config?.cooldownAfterLossDays) || 0,
        maxPortfolioDrawdownPercent: Number(ledger.config?.maxPortfolioDrawdownPercent) || 0,
        volatilityLookbackDays: Number(ledger.config?.volatilityLookbackDays) || null,
        volatilityTargetPercent: Number.isFinite(Number(ledger.config?.volatilityTargetPercent)) &&
          Number(ledger.config.volatilityTargetPercent) > 0
          ? Number(ledger.config.volatilityTargetPercent)
          : null,
        entryExecution: ledger.config?.entryExecution === 'next_open' ? 'next_open' : 'close',
        maxEntryGapPercent: Number(ledger.config?.maxEntryGapPercent) || 0,
        // Ledgers written before the freshness knob existed omit the key, but
        // every current runner enforces the shared default. Show the enforced
        // contract instead of reporting a misleading 0-hour ceiling.
        maxDailyCandleAgeHours: Number.isFinite(Number(ledger.config?.maxDailyCandleAgeHours))
          ? Number(ledger.config.maxDailyCandleAgeHours)
          : DEFAULT_MOMENTUM_SHADOW_CANDIDATE_CONFIG.maxDailyCandleAgeHours,
        maxSpreadPercent: Number(ledger.config?.maxSpreadPercent) || 0
      },
      heartbeatAgeSeconds
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
  const configured = server?.tradingSystem?.config?.higherTimeframeMomentumReportFile ||
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

  router.get('/momentum-shadow', (req, res) => {
    const fallbackInitialBalance = Number(process.env.MOMO_SHADOW_INITIAL_BALANCE) || 100_000_000;
    const books = momentumShadowBookDefinitions(server)
      .map(definition => projectMomentumShadowBook(definition, fallbackInitialBalance, server));
    const candidateReadiness = projectMomentumShadowCandidateReadiness(server);
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
        key: 'fixed_2d_spread',
        label: '2일·호가 제한 A/B 후보',
        readiness: projectMomentumShadowFixedHoldReadiness(server, { spreadGuard: true })
      }
    ];
    return res.json({
      available: books.some(book => book.available),
      researchOnly: true,
      promoted: false,
      projectionReason: 'momentum_shadow_is_diagnostic_only_and_never_authorizes_orders',
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
