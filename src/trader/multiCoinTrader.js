import { PaperValidationJournal, resolveSignalWindowEntryLimit } from './paperValidationJournal.js';
import { VirtualPortfolioStore } from './virtualPortfolioStore.js';
import { PositionRiskMonitor, inspectTraderMarketQuote } from './positionRiskMonitor.js';
import { LiveOrderGateway } from './liveOrderGateway.js';
import { createLossCircuitBreakerState } from '../risk/lossCircuitBreaker.js';
import UpbitAPI from '../api/upbit.js';
import { isPublicMarketDataSource } from '../api/publicMarketDataSource.js';
import {
  getMarketDataAdapterKind,
  UpbitMarketDataAdapter
} from '../market-data/marketDataAdapters.js';
import { comprehensiveAnalysis } from '../analysis/technicalIndicators.js';
import NewsMonitor from '../analysis/newsMonitor.js';
import TradingStrategy from '../strategy/tradingStrategy.js';
import OversoldReactionStrategy from '../strategy/oversoldReactionStrategy.js';
import {
  inspectLatestCandleFreshness,
  resolveMaxCandleAgeSeconds
} from '../risk/candleFreshness.js';
import {
  createRiskMonitorState,
  resolveMaxRiskDataGapSeconds
} from '../risk/riskMonitor.js';
import {
  createAnalysisDataHealthState,
  resolveMaxAnalysisDataGapSeconds
} from '../risk/analysisDataHealth.js';

import { inspectLiveExecutionEvidenceFile } from '../research/liveExecutionEvidence.js';
import { assessScalpingValidationReportFreshness } from '../research/scalpingValidationFreshness.js';
import { LIVE_GATE_COMPARABLE_KEYS } from '../research/scalpingValidationConfig.js';
import fs from 'fs';
import path from 'path';
import os from 'os';




const ANALYSIS_NETWORK_ERROR_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENETRESET'
]);

function analysisNetworkErrorCode(error) {
  const code = String(error?.code || error?.cause?.code || '').toUpperCase();
  return ANALYSIS_NETWORK_ERROR_CODES.has(code) ? code : null;
}

function classifyAnalysisFailure(error) {
  const code = String(error?.code || error?.cause?.code || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  if (code === 'MARKET_QUOTE_STALE') return 'market_quote_stale';
  if (code === 'MARKET_QUOTE_UNAVAILABLE') return 'market_quote_unavailable';
  if (ANALYSIS_NETWORK_ERROR_CODES.has(code) ||
      /getaddrinfo|dns|timeout|network/.test(message)) {
    return 'network_fetch_failed';
  }
  return 'market_analysis_failed';
}


function createMarketQuoteFreshnessError(market, freshness) {
  const stale = freshness.reason === 'market_source_stale' ||
    freshness.reason === 'market_source_timestamp_in_future';
  const error = new Error(`${market} 거래소 시세를 사용할 수 없습니다: ${freshness.reason}`);
  error.code = stale ? 'MARKET_QUOTE_STALE' : 'MARKET_QUOTE_UNAVAILABLE';
  error.freshness = freshness;
  return error;
}





function hasCompleteLiveFillResult(fillResult) {
  const order = fillResult?.order;
  const hasObservedNumber = value => value !== null && value !== undefined && Number.isFinite(Number(value));
  return fillResult?.filled === true &&
    order &&
    hasObservedNumber(order.executed_volume) && Number(order.executed_volume) > 0 &&
    hasObservedNumber(order.avg_price) && Number(order.avg_price) > 0 &&
    hasObservedNumber(order.paid_fee) && Number(order.paid_fee) >= 0 &&
    hasObservedNumber(order.remaining_volume) && Number(order.remaining_volume) >= 0;
}



/**
 * Add legacy strict losses to the global circuit state when an older ledger
 * does not have the new field yet. Existing state is preserved and duplicate
 * timestamps are removed so a process restart cannot count a loss twice.
 */

function calculateLiveMarketReturn(candles, lookback) {
  const closedCandles = Array.isArray(candles) ? candles.slice(1) : [];
  const currentClose = Number(closedCandles[0]?.trade_price);
  const referenceClose = Number(closedCandles[lookback]?.trade_price);
  if (!Number.isFinite(currentClose) || !Number.isFinite(referenceClose) || referenceClose <= 0) {
    return null;
  }
  return ((currentClose - referenceClose) / referenceClose) * 100;
}


function summarizeLiveMarketRegime(analyses, config = {}) {
  if (config.marketRegimeEnabled !== true) {
    return {
      enabled: false,
      available: true,
      confirmed: true,
      breadth: 1,
      averageReturnPercent: 0,
      marketCount: analyses.length,
      positiveMarketCount: analyses.length
    };
  }

  const minReturnPercent = Number.isFinite(Number(config.marketRegimeMinReturnPercent))
    ? Number(config.marketRegimeMinReturnPercent)
    : -0.2;
  const minBreadth = Math.max(0, Math.min(1, Number.isFinite(Number(config.marketRegimeMinBreadth))
    ? Number(config.marketRegimeMinBreadth)
    : 0.5));
  const returns = analyses
    .map(analysis => Number(analysis?.marketReturnPercent))
    .filter(Number.isFinite);
  const positiveMarketCount = returns.filter(value => value >= minReturnPercent).length;
  const breadth = returns.length > 0 ? positiveMarketCount / returns.length : 0;
  const averageReturnPercent = returns.length > 0
    ? returns.reduce((sum, value) => sum + value, 0) / returns.length
    : 0;
  return {
    enabled: true,
    available: returns.length > 0,
    confirmed: returns.length > 0 && breadth >= minBreadth && averageReturnPercent >= minReturnPercent,
    lookback: Math.max(1, Math.floor(Number(config.marketRegimeLookback) || 5)),
    minBreadth,
    minReturnPercent,
    breadth,
    averageReturnPercent,
    marketCount: returns.length,
    positiveMarketCount
  };
}

class MultiCoinTrader {
  constructor(config, { marketDataAdapter, publicMarketDataSource } = {}) {
    this.config = config;
    // paper 장부는 최상단에서 생성 — 아래 필드 setter들이 journal로 위임된다.
    this._journal = new PaperValidationJournal(this);
    this._vpStore = new VirtualPortfolioStore(this);
    if (marketDataAdapter !== undefined && config.dryRun === false) {
      throw new Error('Injected market data adapters are available in DRY_RUN only.');
    }
    if (marketDataAdapter !== undefined && publicMarketDataSource !== undefined) {
      throw new TypeError('Use either a DRY_RUN fixture adapter or the built-in public market source, not both.');
    }
    if (publicMarketDataSource !== undefined && !isPublicMarketDataSource(publicMarketDataSource)) {
      throw new TypeError('MultiCoinTrader requires the built-in credential-free public market data source.');
    }
    const configuredStorageMiB = config.paperMinimumStorageMiB ?? process.env.SCALP_PAPER_MIN_STORAGE_MIB;
    const parsedStorageMiB = Number(configuredStorageMiB);
    this.paperMinimumStorageMiB = Number.isFinite(parsedStorageMiB) && parsedStorageMiB >= 128
      ? parsedStorageMiB
      : 1024;
    this.upbit = new UpbitAPI(config.accessKey, config.secretKey, {
      requestTimeoutMs: config.upbitRequestTimeoutMs
    });
    this.publicMarketDataSource = publicMarketDataSource ?? null;
    const selectedMarketDataAdapter = marketDataAdapter === undefined
      ? new UpbitMarketDataAdapter(publicMarketDataSource || (() => this.upbit))
      : marketDataAdapter;
    const marketDataAdapterKind = getMarketDataAdapterKind(selectedMarketDataAdapter);
    if (!marketDataAdapterKind) {
      throw new TypeError('MultiCoinTrader requires a built-in market data adapter.');
    }
    // LIVE is always tied to this trader's exchange client; injected adapters
    // remain unavailable if a DRY_RUN trader's mode is later changed.
    Object.defineProperty(this, 'marketDataAdapter', {
      get() {
        if (marketDataAdapter !== undefined && this.dryRun !== true) {
          throw new Error('Injected market data adapters are available in DRY_RUN only.');
        }
        return selectedMarketDataAdapter;
      },
      enumerable: true,
      configurable: false
    });
    this.riskUpbit = publicMarketDataSource
      ? { getTicker: (markets, requestOptions) => publicMarketDataSource.getTicker(markets, requestOptions) }
      : new UpbitAPI(config.accessKey, config.secretKey, {
          requestTimeoutMs: config.upbitRequestTimeoutMs
        });
    this.liveManualPrepareOnBoot = config.liveManualPrepareOnBoot === true && config.dryRun === false;
    this.liveManualRiskProtectionEnabled = config.liveManualRiskProtection === true && config.dryRun === false;
    this.newsMonitor = new NewsMonitor();
    this.strategyMode = config.strategyMode || 'oversold_reaction_scalping';
    this.isScalpingMode = this.strategyMode === 'oversold_reaction_scalping';
    // Research-only forward candidate. It mirrors confirmed strict BUY
    // signals in a separate book and changes only the winner-hold exit rule.
    // Zero keeps the experiment completely disabled.
    this.winnerShadowExtendMinutes = Math.max(0, Number(config.winnerShadowExtendMinutes) || 0);
    this.winnerShadowExtendMinProfitPercent = Math.max(0, Number(config.winnerShadowExtendMinProfitPercent) || 0);
    // Optional entry-side A/B filter. With strict maxReboundPercent=0, this
    // lets winnerShadow mirror only confirmed signals that would survive a
    // rebound-ceiling candidate, without changing strict paper assets.
    this.winnerShadowMaxReboundPercent = Math.max(0, Number(config.winnerShadowMaxReboundPercent) || 0);
    // Forward paper normally keeps relaxed shadow books for filter diagnosis.
    // A strict-only session can disable those books so its strict outcomes can
    // be evaluated as an isolated efficacy cohort after the normal gates pass.
    this.paperDiagnosticShadowsEnabled = config.paperDiagnosticShadowsEnabled !== false;

    // 각 코인별 전략 인스턴스
    this.strategies = new Map();
    this.targetCoins = config.targetCoins || ['KRW-BTC', 'KRW-ETH'];

    // 전략 설정 (공통) - 최적화 파라미터 포함
    this.strategyConfig = {
      stopLossPercent: config.stopLossPercent,
      takeProfitPercent: config.takeProfitPercent,
      buyThreshold: config.buyThreshold || 55,  // 기본값 55로 낮춤 (더 적극적 매수)
      sellThreshold: config.sellThreshold || 55,
      technicalWeight: config.technicalWeight || 0.6,
      newsWeight: config.newsWeight || 0.4,
      buyOnly: config.buyOnly || false,  // 매수 전용 모드
      allowAveraging: this.isScalpingMode ? false : config.allowAveraging !== false,
      rsiPeriod: config.rsiPeriod || 14,
      rsiOversold: config.rsiOversold || 30,
      rsiOverbought: config.rsiOverbought || 70,
      oversoldLookback: config.oversoldLookback || 1,
      entryDelayMinMs: config.entryDelayMinMs,
      entryDelayMaxMs: config.entryDelayMaxMs,
      maxEntryRetracePercent: config.maxEntryRetracePercent,
      maxEntryChasePercent: config.maxEntryChasePercent,
      breakEvenTriggerPercent: config.breakEvenTriggerPercent,
      breakEvenOffsetPercent: config.breakEvenOffsetPercent,
      trailingActivationPercent: config.trailingActivationPercent,
      trailingStopPercent: config.trailingStopPercent,
      maxHoldMinutes: config.maxHoldMinutes,
      maxLosingHoldMinutes: config.maxLosingHoldMinutes,
      winnerExtendMinutes: config.winnerExtendMinutes,
      winnerExtendMinProfitPercent: config.winnerExtendMinProfitPercent,
      maxEntriesPerSignalWindow: resolveSignalWindowEntryLimit(config),
      minReboundPercent: config.minReboundPercent,
      minRsiRecovery: config.minRsiRecovery,
      maxSignalRangePercent: config.maxSignalRangePercent ?? 0,
      minSignalRangePercent: config.minSignalRangePercent ?? 0,
      maxReboundPercent: config.maxReboundPercent ?? 0,
      marketRegimeEnabled: config.marketRegimeEnabled === true,
      marketRegimeLookback: config.marketRegimeLookback,
      marketRegimeMinBreadth: config.marketRegimeMinBreadth,
      marketRegimeMinReturnPercent: config.marketRegimeMinReturnPercent,
      requireReboundBelowOverbought: config.requireReboundBelowOverbought === true,
      cooldownAfterLossMinutes: config.cooldownAfterLossMinutes,
      maxConsecutiveLosses: config.maxConsecutiveLosses,
      lossCircuitBreakerCount: config.lossCircuitBreakerCount,
      lossCircuitBreakerWindowMinutes: config.lossCircuitBreakerWindowMinutes,
      lossCircuitBreakerCooldownMinutes: config.lossCircuitBreakerCooldownMinutes,
      tradingFee: config.tradingFee ?? 0.0005,
      slippage: config.slippage ?? 0.001
    };

    // 추가 매수 허용 옵션 저장
    this.allowAveraging = this.isScalpingMode ? false : config.allowAveraging !== false;

    // 전략은 필요할 때 동적으로 생성 (메모리 효율화)
    // 많은 코인을 분석할 때는 모든 코인에 미리 생성하지 않음
    if (this.targetCoins.length <= 20) {
      this.targetCoins.forEach(coin => {
        this.strategies.set(coin, this.createStrategy());
      });
    }

    this.isRunning = false;
    this.dryRun = config.dryRun !== false;
    this.lastNewsCheck = null;
    this.newsData = null;

    // 리밸런싱 쿨다운 관리
    this.lastRebalanceTime = null;

    // 포트폴리오 관리
    this.maxPositions = config.maxPositions ?? (this.isScalpingMode ? 3 : 1000);
    this.portfolioAllocation = config.portfolioAllocation ?? (this.isScalpingMode ? 0.1 : 0.3);
    this.candleUnit = config.candleUnit || (this.isScalpingMode ? 1 : 5);
    this.candleCount = config.candleCount || 200;
    this.maxCandleAgeSeconds = resolveMaxCandleAgeSeconds(config.maxCandleAgeSeconds, this.candleUnit);
    this.config.maxCandleAgeSeconds = this.maxCandleAgeSeconds;
    this.useNews = config.useNews !== false && !this.isScalpingMode;
    this.entryDelayMinMs = config.entryDelayMinMs ?? 1000;
    this.entryDelayMaxMs = config.entryDelayMaxMs ?? 5000;
    this.maxEntryRetracePercent = config.maxEntryRetracePercent ?? 0.25;
    const configuredRiskInterval = config.positionRiskCheckIntervalMs;
    this.positionRiskCheckIntervalMs = configuredRiskInterval === 0
      ? 0
      : Math.max(250, Number(configuredRiskInterval) || (this.isScalpingMode ? 1000 : 5000));
    // Persist risk timestamps often enough for a read-only observer to see a
    // real last-success boundary, without rewriting the growing ledger on
    // every one-second risk tick.
    this.riskStatePersistIntervalMs = Math.max(
      1000,
      (this.positionRiskCheckIntervalMs || 1000) * 5
    );
    this.lastRiskStatePersistedAt = 0;
    this.maxRiskDataGapSeconds = resolveMaxRiskDataGapSeconds(
      config.maxRiskDataGapSeconds,
      this.isScalpingMode ? 30 : 0
    );
    this.maxAnalysisDataGapSeconds = resolveMaxAnalysisDataGapSeconds(
      config.maxAnalysisDataGapSeconds,
      this.isScalpingMode ? 60 : 0
    );
    this.config.maxAnalysisDataGapSeconds = this.maxAnalysisDataGapSeconds;
    this.positionRiskTimer = null;
    this.analysisWatchdogTimer = null;
    this.analysisCycleProgress = null;
    this.lastAnalysisStatePersistedAt = 0;
    this._riskCheckInProgress = false;
    this._orderInProgress = false;
    this._liveExchangeStateKnown = this.dryRun;
    this._liveAccountStateKnown = this.dryRun;
    this._liveVerifiedOrderMarkets = new Map();
    this._manualOrderReconciliationMarkets = new Set();
    this._liveOrderStateUnknownMarkets = new Set(this.dryRun ? [] : this.targetCoins);
    this._livePendingOrderMarkets = new Set();
    this._exchangeSyncPromise = null;
    this._gracefulShutdownPromise = null;
    this._startPromise = null;
    this.exchangeSyncRetryMs = Math.max(250, Number(config.exchangeSyncRetryMs) || 5000);
    this._lastExchangeSyncAttemptTime = 0;
    this._startupReconciliationPending = false;
    this._startupSafetyHold = false;
    this._stopRequested = false;
    this._entriesPaused = false;
    this.liveManualPrepared = false;
    this._riskMonitorProtectiveOnly = false;
    this._riskMonitorExitInProgress = false;
    this._manualRiskProtection = false;
    this._deferredProtectiveExitIntents = new Map();
    this.stopReason = null;
    this.cycleRequestStats = null;
    this.runtimeSignalWindowEntryCounts = new Map();

    // 드라이 모드 가상 포트폴리오
    this.virtualPortfolio = {
      krwBalance: config.dryRunSeedMoney || 10000000,
      holdings: new Map() // coin -> { amount, avgPrice }
    };
    this.manualOrderIdempotencyRecords = [];

    // 초기 시드머니 저장 (누적손익 계산용)
    if (this.dryRun) {
      this.initialSeedMoney = config.dryRunSeedMoney || 10000000;
    } else {
      // 실전 모드: 환경변수로 설정하거나 자동 계산
      this.initialSeedMoney = config.initialSeedMoney || 0;
    }

    const testStoragePrefix = (process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT)
      ? path.join(os.tmpdir(), `coin-pilot-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
      : null;
    this.virtualPortfolioFile = config.virtualPortfolioFile ||
      process.env.DRY_PORTFOLIO_FILE ||
      (testStoragePrefix ? `${testStoragePrefix}.dry_portfolio.json` : 'dry_portfolio.json');
    this.paperValidationFile = config.paperValidationFile ||
      process.env.PAPER_VALIDATION_FILE ||
      (testStoragePrefix ? `${testStoragePrefix}.paper_validation.json` : 'paper_validation.json');
    this.portfolioHistoryFile = config.portfolioHistoryFile ||
      process.env.PORTFOLIO_HISTORY_FILE ||
      'portfolio_history.json';
    this.liveExecutionEvidenceFile = config.liveExecutionEvidenceFile ||
      process.env.LIVE_EXECUTION_EVIDENCE_FILE ||
      '.coinpilot-runtime/live-execution/evidence.jsonl';
    this.liveExecutionEvidenceWriteError = null;
    this.liveExecutionEvidenceDataError = null;
    this.liveExecutionEvidenceStartup = inspectLiveExecutionEvidenceFile(this.liveExecutionEvidenceFile);
    this.liveOrderIntentEvidenceIndex = this.liveExecutionEvidenceStartup.orderIntentEvidenceIndex || null;
    const startupReconciliation = this.liveExecutionEvidenceStartup.reconciliation;
    const knownSubmittedOrders = startupReconciliation?.knownSubmittedOrders || [];
    this._liveEngineOrderMarkets = new Map(knownSubmittedOrders
      .filter(order => typeof order.orderId === 'string' && typeof order.market === 'string')
      .map(order => [order.orderId, order.market]));
    this._liveEngineOrderIds = new Set(this._liveEngineOrderMarkets.keys());
    this._liveRecordedSubmissionIds = new Set(this._liveEngineOrderIds);
    this._liveRecordedIntentOutcomeKeys = new Set();
    this._liveUsedOrderIntentIds = new Set(startupReconciliation?.knownClientIntentIds || []);
    this._liveOrderClientIntentById = new Map(knownSubmittedOrders
      .filter(order => typeof order.orderId === 'string' && typeof order.clientIntentId === 'string')
      .map(order => [order.orderId, order.clientIntentId]));
    this._liveLatestOrderIntentByMarket = new Map();
    this._liveUnresolvedOrderIds = new Map((startupReconciliation?.unresolvedSubmittedOrders || [])
      .map(order => [order.orderId, order]));
    this._liveUnresolvedOrderIntents = new Map((startupReconciliation?.unresolvedOrderIntents || [])
      .map((intent, index) => [intent.clientIntentId || `legacy:${intent.market || 'unknown'}:${intent.createdAt || index}`, intent]));
    this._liveEvidenceBlockedMarkets = new Set([
      ...[...this._liveUnresolvedOrderIds.values()].map(order => order.market),
      ...[...this._liveUnresolvedOrderIntents.values()].map(intent => intent.market)
    ].filter(Boolean));
    this._liveRecoveredManagedMarkets = new Set(startupReconciliation?.managedMarkets || []);
    this._liveRecoveredPositionStates = new Map(
      (startupReconciliation?.managedOpenPositions || [])
        .filter(position => typeof position.market === 'string')
        .map(position => [position.market, position])
    );
    this._liveOrderStateUnknownMarkets = new Set(this.getLiveManagedMarkets());
    const nonOrderStartupBlocks = this.liveExecutionEvidenceStartup.blockingReasons.filter(reason =>
      !reason.startsWith('unresolved submitted orders:') && !reason.startsWith('unresolved order intents:'));
    if (nonOrderStartupBlocks.length > 0) {
      this.liveExecutionEvidenceDataError = `startup safety block: ${nonOrderStartupBlocks.join('; ')}`;
    }
    // Live mode has no paper ledger, so keep its optional global circuit in
    // memory. DRY_RUN forward sessions replace this reference with their
    // persisted strictRiskState circuit through getStrictLossCircuitBreakerState().
    this.lossCircuitBreaker = createLossCircuitBreakerState();

    // 드라이 모드일 경우 저장된 포트폴리오 로드
    if (this.dryRun) {
      this.loadVirtualPortfolio();
    } else {
      // 실전 모드: 초기 시드머니 파일에서 로드
      this.loadInitialSeedMoney();
    }

    this.paperValidation = this.loadPaperValidation();
    this.riskMonitorState = createRiskMonitorState(this.paperValidation?.riskMonitor);
    this.analysisDataHealthState = createAnalysisDataHealthState(this.paperValidation?.analysisDataHealth);
    this.restorePaperStrategyRiskState();

    // 동적 투자금액 설정 (비율 기반으로 단순화)
    this.investmentRatio = config.investmentRatio ?? 0.05; // 총 자산의 5%를 기본 투자 비율로
    this.MIN_ORDER_AMOUNT = 5000; // 업비트 최소 주문 금액 (고정)

    // 거래 알림 콜백 (대시보드에서 설정)
    this.onTradeCallback = null;
    // 분석 결과를 대시보드/AI 모니터링으로 전달하는 읽기 전용 콜백.
    // 이 콜백은 주문 결정에 참여하지 않으며, 거래 루프를 기다리게 하지 않는다.
    this.onAnalysisCallback = null;
  }

  /**
   * 거래 알림 콜백 설정
   */
  // ── PaperValidationJournal 위임 ─────────────────────────────────
  // Object.create(prototype) 테스트가 생성자를 우회할 수 있으므로 지연 생성.
  _paperJournal() {
    this._journal = this._journal || new PaperValidationJournal(this);
    return this._journal;
  }

  get paperValidation() { return this._paperJournal().paperValidation; }
  set paperValidation(value) { this._paperJournal().paperValidation = value; }
  get paperValidationFile() { return this._paperJournal().paperValidationFile; }
  set paperValidationFile(value) { this._paperJournal().paperValidationFile = value; }
  get paperMinimumStorageMiB() { return this._paperJournal().paperMinimumStorageMiB; }
  set paperMinimumStorageMiB(value) { this._paperJournal().paperMinimumStorageMiB = value; }
  get runtimeSignalWindowEntryCounts() { return this._paperJournal().runtimeSignalWindowEntryCounts; }
  set runtimeSignalWindowEntryCounts(value) { this._paperJournal().runtimeSignalWindowEntryCounts = value; }

  // ── VirtualPortfolioStore 위임 ──────────────────────────────────
  _portfolioStore() {
    this._vpStore = this._vpStore || new VirtualPortfolioStore(this);
    return this._vpStore;
  }

  get virtualPortfolio() { return this._portfolioStore().virtualPortfolio; }
  set virtualPortfolio(value) { this._portfolioStore().virtualPortfolio = value; }
  get virtualPortfolioFile() { return this._portfolioStore().virtualPortfolioFile; }
  set virtualPortfolioFile(value) { this._portfolioStore().virtualPortfolioFile = value; }
  get initialSeedMoney() { return this._portfolioStore().initialSeedMoney; }
  set initialSeedMoney(value) { this._portfolioStore().initialSeedMoney = value; }
  get smartTradeHistory() { return this._portfolioStore().smartTradeHistory; }
  set smartTradeHistory(value) { this._portfolioStore().smartTradeHistory = value; }
  get manualOrderIdempotencyRecords() { return this._portfolioStore().manualOrderIdempotencyRecords; }
  set manualOrderIdempotencyRecords(value) { this._portfolioStore().manualOrderIdempotencyRecords = value; }

  // ── PositionRiskMonitor 위임 ────────────────────────────────────
  // 필드명과 메서드명이 충돌하지 않도록 내부 참조는 _riskMonitorRef.
  _riskMonitor() {
    this._riskMonitorRef = this._riskMonitorRef || new PositionRiskMonitor(this);
    return this._riskMonitorRef;
  }

  // ── LiveOrderGateway 위임 ───────────────────────────────────────
  _liveGateway() {
    this._liveGw = this._liveGw || new LiveOrderGateway(this);
    return this._liveGw;
  }

  get _liveOrderStateUnknownMarkets() { return this._liveGateway()._liveOrderStateUnknownMarkets; }
  set _liveOrderStateUnknownMarkets(v) { this._liveGateway()._liveOrderStateUnknownMarkets = v; }
  get _livePendingOrderMarkets() { return this._liveGateway()._livePendingOrderMarkets; }
  set _livePendingOrderMarkets(v) { this._liveGateway()._livePendingOrderMarkets = v; }
  get _liveUnresolvedOrderIntents() { return this._liveGateway()._liveUnresolvedOrderIntents; }
  set _liveUnresolvedOrderIntents(v) { this._liveGateway()._liveUnresolvedOrderIntents = v; }
  get liveExecutionEvidenceDataError() { return this._liveGateway().liveExecutionEvidenceDataError; }
  set liveExecutionEvidenceDataError(v) { this._liveGateway().liveExecutionEvidenceDataError = v; }
  get _liveEvidenceBlockedMarkets() { return this._liveGateway()._liveEvidenceBlockedMarkets; }
  set _liveEvidenceBlockedMarkets(v) { this._liveGateway()._liveEvidenceBlockedMarkets = v; }
  get _liveAccountStateKnown() { return this._liveGateway()._liveAccountStateKnown; }
  set _liveAccountStateKnown(v) { this._liveGateway()._liveAccountStateKnown = v; }
  get _exchangeSyncPromise() { return this._liveGateway()._exchangeSyncPromise; }
  set _exchangeSyncPromise(v) { this._liveGateway()._exchangeSyncPromise = v; }
  get _liveRecoveredManagedMarkets() { return this._liveGateway()._liveRecoveredManagedMarkets; }
  set _liveRecoveredManagedMarkets(v) { this._liveGateway()._liveRecoveredManagedMarkets = v; }
  get _liveUnresolvedOrderIds() { return this._liveGateway()._liveUnresolvedOrderIds; }
  set _liveUnresolvedOrderIds(v) { this._liveGateway()._liveUnresolvedOrderIds = v; }
  get _liveExchangeStateKnown() { return this._liveGateway()._liveExchangeStateKnown; }
  set _liveExchangeStateKnown(v) { this._liveGateway()._liveExchangeStateKnown = v; }
  get liveExecutionEvidenceFile() { return this._liveGateway().liveExecutionEvidenceFile; }
  set liveExecutionEvidenceFile(v) { this._liveGateway().liveExecutionEvidenceFile = v; }
  get _liveVerifiedOrderMarkets() { return this._liveGateway()._liveVerifiedOrderMarkets; }
  set _liveVerifiedOrderMarkets(v) { this._liveGateway()._liveVerifiedOrderMarkets = v; }
  get _liveUsedOrderIntentIds() { return this._liveGateway()._liveUsedOrderIntentIds; }
  set _liveUsedOrderIntentIds(v) { this._liveGateway()._liveUsedOrderIntentIds = v; }
  get liveExecutionEvidenceWriteError() { return this._liveGateway().liveExecutionEvidenceWriteError; }
  set liveExecutionEvidenceWriteError(v) { this._liveGateway().liveExecutionEvidenceWriteError = v; }
  get liveOrderIntentEvidenceIndex() { return this._liveGateway().liveOrderIntentEvidenceIndex; }
  set liveOrderIntentEvidenceIndex(v) { this._liveGateway().liveOrderIntentEvidenceIndex = v; }
  get _liveEngineOrderIds() { return this._liveGateway()._liveEngineOrderIds; }
  set _liveEngineOrderIds(v) { this._liveGateway()._liveEngineOrderIds = v; }
  get _liveEngineOrderMarkets() { return this._liveGateway()._liveEngineOrderMarkets; }
  set _liveEngineOrderMarkets(v) { this._liveGateway()._liveEngineOrderMarkets = v; }
  get _liveOrderClientIntentById() { return this._liveGateway()._liveOrderClientIntentById; }
  set _liveOrderClientIntentById(v) { this._liveGateway()._liveOrderClientIntentById = v; }
  get _manualOrderReconciliationMarkets() { return this._liveGateway()._manualOrderReconciliationMarkets; }
  set _manualOrderReconciliationMarkets(v) { this._liveGateway()._manualOrderReconciliationMarkets = v; }
  get _lastSyncTime() { return this._liveGateway()._lastSyncTime; }
  set _lastSyncTime(v) { this._liveGateway()._lastSyncTime = v; }
  get _liveRecordedSubmissionIds() { return this._liveGateway()._liveRecordedSubmissionIds; }
  set _liveRecordedSubmissionIds(v) { this._liveGateway()._liveRecordedSubmissionIds = v; }
  get _liveRecordedIntentOutcomeKeys() { return this._liveGateway()._liveRecordedIntentOutcomeKeys; }
  set _liveRecordedIntentOutcomeKeys(v) { this._liveGateway()._liveRecordedIntentOutcomeKeys = v; }
  get _liveEvidenceDirectorySynced() { return this._liveGateway()._liveEvidenceDirectorySynced; }
  set _liveEvidenceDirectorySynced(v) { this._liveGateway()._liveEvidenceDirectorySynced = v; }
  get _liveLatestOrderIntentByMarket() { return this._liveGateway()._liveLatestOrderIntentByMarket; }
  set _liveLatestOrderIntentByMarket(v) { this._liveGateway()._liveLatestOrderIntentByMarket = v; }
  get _startupReconciliationPending() { return this._liveGateway()._startupReconciliationPending; }
  set _startupReconciliationPending(v) { this._liveGateway()._startupReconciliationPending = v; }
  get riskMonitorState() { return this._riskMonitor().riskMonitorState; }
  set riskMonitorState(v) { this._riskMonitor().riskMonitorState = v; }
  get analysisDataHealthState() { return this._riskMonitor().analysisDataHealthState; }
  set analysisDataHealthState(v) { this._riskMonitor().analysisDataHealthState = v; }
  get positionRiskTimer() { return this._riskMonitor().positionRiskTimer; }
  set positionRiskTimer(v) { this._riskMonitor().positionRiskTimer = v; }
  get analysisWatchdogTimer() { return this._riskMonitor().analysisWatchdogTimer; }
  set analysisWatchdogTimer(v) { this._riskMonitor().analysisWatchdogTimer = v; }
  get _riskMonitorProtectiveOnly() { return this._riskMonitor()._riskMonitorProtectiveOnly; }
  set _riskMonitorProtectiveOnly(v) { this._riskMonitor()._riskMonitorProtectiveOnly = v; }
  get _riskMonitorExitInProgress() { return this._riskMonitor()._riskMonitorExitInProgress; }
  set _riskMonitorExitInProgress(v) { this._riskMonitor()._riskMonitorExitInProgress = v; }
  get _riskCheckInProgress() { return this._riskMonitor()._riskCheckInProgress; }
  set _riskCheckInProgress(v) { this._riskMonitor()._riskCheckInProgress = v; }
  get lastRiskStatePersistedAt() { return this._riskMonitor().lastRiskStatePersistedAt; }
  set lastRiskStatePersistedAt(v) { this._riskMonitor().lastRiskStatePersistedAt = v; }
  get lastAnalysisStatePersistedAt() { return this._riskMonitor().lastAnalysisStatePersistedAt; }
  set lastAnalysisStatePersistedAt(v) { this._riskMonitor().lastAnalysisStatePersistedAt = v; }
  get riskStatePersistIntervalMs() { return this._riskMonitor().riskStatePersistIntervalMs; }
  set riskStatePersistIntervalMs(v) { this._riskMonitor().riskStatePersistIntervalMs = v; }
  get analysisCycleProgress() { return this._riskMonitor().analysisCycleProgress; }
  set analysisCycleProgress(v) { this._riskMonitor().analysisCycleProgress = v; }
  get riskUpbit() { return this._riskMonitor().riskUpbit; }
  set riskUpbit(v) { this._riskMonitor().riskUpbit = v; }
  get maxRiskDataGapSeconds() { return this._riskMonitor().maxRiskDataGapSeconds; }
  set maxRiskDataGapSeconds(v) { this._riskMonitor().maxRiskDataGapSeconds = v; }
  get maxAnalysisDataGapSeconds() { return this._riskMonitor().maxAnalysisDataGapSeconds; }
  set maxAnalysisDataGapSeconds(v) { this._riskMonitor().maxAnalysisDataGapSeconds = v; }
  get positionRiskCheckIntervalMs() { return this._riskMonitor().positionRiskCheckIntervalMs; }
  set positionRiskCheckIntervalMs(v) { this._riskMonitor().positionRiskCheckIntervalMs = v; }

  setTradeCallback(callback) {
    this.onTradeCallback = callback;
  }

  /**
   * 분석 cycle을 읽기 전용 소비자에게 전달한다.
   * AI 자문이나 UI 알림이 실패해도 기존 자동매매 경로에는 영향을 주지
   * 않도록 callback을 fire-and-forget으로 실행한다.
   */
  setAnalysisCallback(callback) {
    this.onAnalysisCallback = typeof callback === 'function' ? callback : null;
  }

  notifyAnalysisCycle(cycleInfo) {
    if (!this.onAnalysisCallback) return;
    try {
      Promise.resolve(this.onAnalysisCallback(cycleInfo)).catch(error => {
        console.error('분석 모니터링 콜백 오류:', error.message);
      });
    } catch (error) {
      console.error('분석 모니터링 콜백 오류:', error.message);
    }
  }

  /**
   * 거래 알림 전송
   */
  notifyTrade(tradeInfo) {
    if (this.onTradeCallback) {
      try {
        this.onTradeCallback(tradeInfo);
      } catch (e) {
        console.error('거래 알림 콜백 오류:', e.message);
      }
    }
  }

  recordLiveExecutionEvidence(...args) { return this._liveGateway().recordLiveExecutionEvidence(...args); }

  applyLiveExecutionEvidenceRuntimeState(...args) { return this._liveGateway().applyLiveExecutionEvidenceRuntimeState(...args); }

  clearLiveEvidenceMarketBlockIfResolved(...args) { return this._liveGateway().clearLiveEvidenceMarketBlockIfResolved(...args); }

  createLiveExecutionEvidence(...args) { return this._liveGateway().createLiveExecutionEvidence(...args); }

  cancelLiveOrderIfOpen(...args) { return this._liveGateway().cancelLiveOrderIfOpen(...args); }

  recordLiveSettlementReadback(...args) { return this._liveGateway().recordLiveSettlementReadback(...args); }

  /**
   * 코인별 전략 가져오기 (없으면 동적 생성)
   */
  getStrategy(coin) {
    if (!this.strategies.has(coin)) {
      const strategy = this.createStrategy();
      this.strategies.set(coin, strategy);
      this.applyPaperStrategyRiskState(coin, strategy);
    }
    return this.strategies.get(coin);
  }

  getLiveManagedMarkets() {
    return [...new Set([
      ...this.targetCoins,
      ...(this._liveOrderStateUnknownMarkets?.values?.() || []),
      ...(this._livePendingOrderMarkets?.values?.() || []),
      ...(this._manualOrderReconciliationMarkets?.values?.() || []),
      ...[...this.strategies.entries()]
        .filter(([, strategy]) => strategy?.currentPosition)
        .map(([market]) => market),
      ...(this._liveRecoveredManagedMarkets?.values?.() || [])
    ])];
  }

  /**
   * 대시보드 /api/config/update 경유 런타임 대상 마켓·포지션 상한 갱신.
   * targetCoins: KRW-* 코드 배열 또는 'ALL'(스캘핑에서는 유동성 상위 N개로 해석).
   * LIVE 모드에서는 새 관리 마켓이 다시 미검증 상태로 표시되어 sync gate가
   * 재적용된다.
   */
  async applyRuntimeMarketUniverse({ targetCoins, scalpMaxMarkets, maxPositions } = {}) {
    if (scalpMaxMarkets !== undefined) {
      const value = Number(scalpMaxMarkets);
      if (!Number.isInteger(value) || value < 1 || value > 500) {
        throw new Error('scalpMaxMarkets must be an integer from 1 to 500');
      }
      this.config.maxScalpMarkets = value;
    }
    if (maxPositions !== undefined) {
      const value = Number(maxPositions);
      if (!Number.isInteger(value) || value < 1 || value > 50) {
        throw new Error('maxPositions must be an integer from 1 to 50');
      }
      this.maxPositions = value;
      this.config.maxPositions = value;
    }
    if (targetCoins !== undefined && targetCoins !== null) {
      let resolved;
      if (typeof targetCoins === 'string' && targetCoins.trim().toUpperCase() === 'ALL') {
        resolved = await this.resolveAllKrwMarketUniverse();
      } else if (Array.isArray(targetCoins)) {
        const seen = new Set();
        resolved = [];
        for (const entry of targetCoins) {
          const code = String(entry || '').trim().toUpperCase();
          if (!/^KRW-[A-Z0-9]{2,15}$/.test(code) || seen.has(code)) continue;
          seen.add(code);
          resolved.push(code);
        }
        if (resolved.length === 0) {
          throw new Error('targetCoins must contain at least one valid KRW-* market');
        }
      } else {
        throw new Error('targetCoins must be an array of KRW-* codes or "ALL"');
      }
      this.targetCoins = resolved;
      this.config.targetCoins = [...resolved];
      if (resolved.length <= 20) {
        for (const coin of resolved) this.getStrategy(coin);
      }
      if (!this.dryRun) {
        this._liveOrderStateUnknownMarkets = new Set(this.getLiveManagedMarkets());
      }
    }
    return {
      targetCoins: [...this.targetCoins],
      scalpMaxMarkets: this.config.maxScalpMarkets ?? null,
      maxPositions: this.maxPositions
    };
  }

  async resolveAllKrwMarketUniverse() {
    const markets = await this.marketDataAdapter.getMarkets();
    const krwMarkets = (Array.isArray(markets) ? markets : [])
      .map(entry => entry?.market)
      .filter(market => typeof market === 'string' && market.startsWith('KRW-'));
    if (krwMarkets.length === 0) {
      throw new Error('KRW 마켓 목록을 불러오지 못했습니다.');
    }
    if (!this.isScalpingMode) return krwMarkets;
    const tickers = await this.marketDataAdapter.getTickers(krwMarkets);
    const limit = Math.max(1, Math.floor(Number(this.config.maxScalpMarkets)) || 20);
    const ranked = [...(Array.isArray(tickers) ? tickers : [])]
      .filter(ticker => Number.isFinite(Number(ticker?.acc_trade_price_24h)))
      .sort((a, b) => Number(b.acc_trade_price_24h) - Number(a.acc_trade_price_24h))
      .slice(0, limit)
      .map(ticker => ticker.market);
    if (ranked.length === 0) {
      throw new Error('유동성 상위 스캘핑 마켓을 찾지 못했습니다.');
    }
    return ranked;
  }

  ensureLiveOrderMarketStateVerified(...args) { return this._liveGateway().ensureLiveOrderMarketStateVerified(...args); }

  markLiveMarketOrderUnresolved(...args) { return this._liveGateway().markLiveMarketOrderUnresolved(...args); }

  submitLiveOrder(...args) { return this._liveGateway().submitLiveOrder(...args); }

  waitForLiveOrderFill(...args) { return this._liveGateway().waitForLiveOrderFill(...args); }

  /**
   * Preserve the signal that caused an entry alongside the execution price.
   * This is diagnostic metadata only; it lets forward paper distinguish a
   * weak signal from a loss introduced by delayed execution or slippage.
   */
  decorateEntryPosition(strategy, decision, { executionPrice, delayMs = null } = {}) {
    if (!strategy?.currentPosition) return;
    const rebound = decision?.details?.rebound || {};
    const referencePrice = Number(decision?.entryReferencePrice ?? rebound.referencePrice);
    const price = Number(executionPrice);
    const numeric = value => Number.isFinite(Number(value)) ? Number(value) : null;
    strategy.currentPosition.signalKey = decision?.entrySignalKey || rebound.signalKey || null;
    strategy.currentPosition.signalTime = rebound.candleTime || null;
    strategy.currentPosition.signalReferencePrice = numeric(referencePrice);
    strategy.currentPosition.signalReboundPercent = numeric(rebound.reboundPriceChangePercent ?? rebound.priceChangePercent);
    strategy.currentPosition.signalRsi = numeric(rebound.rsi);
    strategy.currentPosition.signalOversoldRsi = numeric(rebound.oversoldRsi ?? rebound.previousRsi);
    strategy.currentPosition.signalRsiRecovery = numeric(rebound.rsiRecovery);
    strategy.currentPosition.signalVolumeRatio = numeric(rebound.volumeRatio);
    strategy.currentPosition.signalCloseStrength = numeric(rebound.closeStrength);
    strategy.currentPosition.signalTrendSlopePercent = numeric(rebound.trendSlopePercent);
    strategy.currentPosition.signalRangePercent = numeric(rebound.signalRangePercent);
    strategy.currentPosition.entryDelayMs = numeric(delayMs);
    strategy.currentPosition.executionDriftPercent = Number.isFinite(price) && referencePrice > 0
      ? ((price - referencePrice) / referencePrice) * 100
      : null;
  }

  /**
   * 실행 중인 전략 모드에 맞는 전략 인스턴스 생성
   */
  createStrategy() {
    const Strategy = this.isScalpingMode ? OversoldReactionStrategy : TradingStrategy;
    return new Strategy(this.strategyConfig);
  }

  /**
   * 현재 설정으로 기술적 분석을 생성한다.
   * 분석과 지연 후 재검증이 동일한 계산 계약을 사용하도록 한 곳에서 관리한다.
   */
  buildTechnicalAnalysis(candles) {
    return comprehensiveAnalysis(candles, {
      rsiPeriod: this.config.rsiPeriod || 14,
      rsiOversold: this.config.rsiOversold || 30,
      rsiOverbought: this.config.rsiOverbought || 70,
      oversoldLookback: this.config.oversoldLookback || 1,
      macdFast: this.config.macdFast || 12,
      macdSlow: this.config.macdSlow || 26,
      macdSignal: this.config.macdSignal || 9,
      bbPeriod: this.config.bbPeriod || 20,
      bbStdDev: this.config.bbStdDev || 2,
      minReboundPercent: this.config.minReboundPercent || 0.15,
      minRsiRecovery: this.config.minRsiRecovery || 2,
      minVolumeRatio: this.config.minVolumeRatio ?? 1.0,
      volumeLookback: this.config.volumeLookback || 20,
      minCloseStrength: this.config.minCloseStrength ?? 0.65,
      trendPeriod: this.config.trendPeriod || 30,
      trendSlopeLookback: this.config.trendSlopeLookback || 3,
      minTrendSlopePercent: this.config.minTrendSlopePercent ?? -0.2,
      requirePreviousHighBreak: this.config.requirePreviousHighBreak !== false,
      maxSignalRangePercent: this.config.maxSignalRangePercent ?? 0,
      minSignalRangePercent: this.config.minSignalRangePercent ?? 0,
      maxReboundPercent: this.config.maxReboundPercent ?? 0,
      requireReboundBelowOverbought: this.config.requireReboundBelowOverbought === true,
      signalProfile: this.config.signalProfile || 'rsi_rebound',
      emaPeriod: this.config.emaLong || 20
    });
  }

  /**
   * 총 자산 계산 (KRW + 코인 평가액) - 드라이/실전 모드 모두 지원
   */
  async calculateTotalAssets(priceMapOverride = null, {
    allowAveragePriceFallback = true,
    accountsOverride = null
  } = {}) {
    if (this.dryRun) {
      // 드라이 모드: 가상 포트폴리오 사용
      let totalAssets = this.virtualPortfolio.krwBalance;

      const holdingCoins = Array.from(this.virtualPortfolio.holdings.keys());
      if (!allowAveragePriceFallback && holdingCoins.length > 0) {
        const priceMap = priceMapOverride instanceof Map ? new Map(priceMapOverride) : new Map();
        if (!(priceMapOverride instanceof Map)) {
          try {
            const tickers = await this.marketDataAdapter.getTickers(holdingCoins);
            if (Array.isArray(tickers)) {
              for (const ticker of tickers) {
                const price = Number(ticker?.trade_price);
                if (ticker?.market && Number.isFinite(price) && price > 0) {
                  priceMap.set(ticker.market, price);
                }
              }
            }
          } catch {
            return null;
          }
        }

        for (const [coin, holding] of this.virtualPortfolio.holdings.entries()) {
          const currentPrice = Number(priceMap.get(coin));
          if (!Number.isFinite(currentPrice) || currentPrice <= 0) return null;
          totalAssets += currentPrice * holding.amount;
        }
        return totalAssets;
      }

      if (holdingCoins.length > 0) {
        // A shared research snapshot may provide one common mark for every
        // variant. In normal runtime paths this remains null and the method
        // keeps its existing exchange read behavior.
        const priceMap = priceMapOverride instanceof Map
          ? priceMapOverride
          : new Map();

        if (!(priceMapOverride instanceof Map)) {
          try {
            const tickers = await this.marketDataAdapter.getTickers(holdingCoins);
            // ticker 응답을 맵으로 변환
            if (tickers && Array.isArray(tickers)) {
              for (const ticker of tickers) {
                if (ticker && ticker.market && typeof ticker.trade_price === 'number') {
                  priceMap.set(ticker.market, ticker.trade_price);
                }
              }
            }
          } catch {
            // ticker 조회 실패 시 priceMap은 비어있음 → 평균단가로 계산됨
          }
        }

        // 모든 보유 코인에 대해 계산 (현재가 또는 평균단가)
        for (const [coin, holding] of this.virtualPortfolio.holdings.entries()) {
          const currentPrice = priceMap.get(coin);
          if (currentPrice !== undefined) {
            // 현재가로 계산
            totalAssets += currentPrice * holding.amount;
          } else {
            // 현재가 조회 실패 시 평균단가로 계산
            totalAssets += holding.avgPrice * holding.amount;
          }
        }
      }
      return totalAssets;
    } else {
      // 실전 모드: 실제 업비트 계좌 잔액 사용
      const accounts = !allowAveragePriceFallback && Array.isArray(accountsOverride)
        ? accountsOverride
        : await this.upbit.getAccounts({ priority: 'risk' });
      if (!accounts || !Array.isArray(accounts)) {
        console.error('계좌 조회 실패');
        return allowAveragePriceFallback ? 0 : null;
      }

      if (!allowAveragePriceFallback) {
        let totalAssets = 0;
        const krwAccount = accounts.find(acc => acc.currency === 'KRW');
        if (krwAccount) {
          totalAssets += parseFloat(krwAccount.balance || 0) + parseFloat(krwAccount.locked || 0);
        }

        const coinAccounts = accounts.filter(acc => {
          if (acc.currency === 'KRW') return false;
          const balance = parseFloat(acc.balance || 0) + parseFloat(acc.locked || 0);
          return Number.isFinite(balance) && balance > 0;
        });
        if (coinAccounts.length === 0) return totalAssets;

        const coinMarkets = coinAccounts.map(acc => `KRW-${acc.currency}`);
        const priceMap = priceMapOverride instanceof Map ? new Map(priceMapOverride) : new Map();
        if (!(priceMapOverride instanceof Map)) {
          try {
            const tickers = await this.marketDataAdapter.getTickers(coinMarkets);
            if (Array.isArray(tickers)) {
              for (const ticker of tickers) {
                const price = Number(ticker?.trade_price);
                if (ticker?.market && Number.isFinite(price) && price > 0) {
                  priceMap.set(ticker.market, price);
                }
              }
            }
          } catch {
            return null;
          }
        }

        for (const account of coinAccounts) {
          const market = `KRW-${account.currency}`;
          const price = Number(priceMap.get(market));
          if (!Number.isFinite(price) || price <= 0) return null;
          const balance = parseFloat(account.balance || 0) + parseFloat(account.locked || 0);
          totalAssets += price * balance;
        }
        return totalAssets;
      }

      let totalAssets = 0;

      // KRW 잔액
      const krwAccount = accounts.find(acc => acc.currency === 'KRW');
      if (krwAccount) {
        totalAssets += parseFloat(krwAccount.balance) + parseFloat(krwAccount.locked || 0);
      }

      // 보유 코인 평가액
      const coinAccounts = accounts.filter(acc => acc.currency !== 'KRW' && parseFloat(acc.balance) > 0);
      if (coinAccounts.length > 0) {
        const coinMarkets = coinAccounts.map(acc => `KRW-${acc.currency}`);
        try {
          const tickers = await this.marketDataAdapter.getTickers(coinMarkets);
          // ticker 응답 유효성 검사
          if (tickers && Array.isArray(tickers) && tickers.length > 0) {
            for (const ticker of tickers) {
              if (ticker && ticker.market && typeof ticker.trade_price === 'number') {
                const coinSymbol = ticker.market.split('-')[1];
                const coinAccount = accounts.find(acc => acc.currency === coinSymbol);
                if (coinAccount) {
                  const balance = parseFloat(coinAccount.balance) + parseFloat(coinAccount.locked || 0);
                  totalAssets += ticker.trade_price * balance;
                }
              }
            }
          } else {
            // ticker 조회 실패 시 평균매입가로 계산
            for (const acc of coinAccounts) {
              const balance = parseFloat(acc.balance) + parseFloat(acc.locked || 0);
              totalAssets += parseFloat(acc.avg_buy_price || 0) * balance;
            }
          }
        } catch {
          // 현재가 조회 실패 시 평균매입가로 계산
          for (const acc of coinAccounts) {
            const balance = parseFloat(acc.balance) + parseFloat(acc.locked || 0);
            totalAssets += parseFloat(acc.avg_buy_price || 0) * balance;
          }
        }
      }
      return totalAssets;
    }
  }

  /**
   * 현재 보유 중인 코인 목록 반환 (백테스팅용)
   */
  async getHeldCoins() {
    if (this.dryRun) {
      // 드라이 모드: 가상 포트폴리오에서 보유 코인 목록 반환
      return Array.from(this.virtualPortfolio.holdings.keys());
    } else {
      // 실전 모드: 실제 업비트 계좌에서 보유 코인 목록 반환
      try {
        const accounts = await this.upbit.getAccounts({ priority: 'risk' });
        if (!accounts || !Array.isArray(accounts)) {
          return [];
        }
        return accounts
          .filter(acc => acc.currency !== 'KRW' && parseFloat(acc.balance) > 0)
          .map(acc => `KRW-${acc.currency}`);
      } catch (error) {
        console.error('보유 코인 조회 실패:', error.message);
        return [];
      }
    }
  }

  /**
   * 동적 투자금액 계산 (비율 기반으로 단순화)
   * @param {number} totalAssets - 총 자산
   * @param {Object} signalStrength - 신호 강도 { level, multiplier, score }
   */
  async calculateDynamicInvestmentAmount(totalAssets = null, signalStrength = null) {
    const investmentRatio = Number(this.investmentRatio);
    if (!Number.isFinite(investmentRatio) || investmentRatio <= 0) return 0;

    // 총 자산이 전달되지 않으면 계산
    if (totalAssets === null) {
      totalAssets = await this.calculateTotalAssets();
    }

    // 투자금액: 총 자산의 investmentRatio
    let dynamicAmount = totalAssets * investmentRatio;

    // 신호 강도에 따른 배수 적용
    if (signalStrength && signalStrength.multiplier > 0) {
      dynamicAmount *= signalStrength.multiplier;
      console.log(`  📊 신호 강도: ${signalStrength.level} (x${signalStrength.multiplier})`);
    }

    // 최소 주문 금액 체크 (업비트 최소 5,000원)
    dynamicAmount = Math.max(this.MIN_ORDER_AMOUNT, dynamicAmount);

    return Math.floor(dynamicAmount);
  }

  /**
   * 누적손익 계산
   */
  async calculateCumulativePnL(options = {}) {
    const totalAssets = await this.calculateTotalAssets(options.priceMapOverride ?? null, options);
    const valuationAvailable = Number.isFinite(totalAssets);
    const result = {
      initialSeedMoney: this.initialSeedMoney,
      totalAssets: valuationAvailable ? Math.round(totalAssets) : null,
      profit: valuationAvailable ? Math.round(totalAssets - this.initialSeedMoney) : null,
      profitPercent: valuationAvailable && this.initialSeedMoney > 0
        ? ((totalAssets / this.initialSeedMoney) - 1) * 100
        : valuationAvailable ? 0 : null,
      mode: this.dryRun ? 'DRY_RUN' : 'LIVE'
    };

    if (options.allowAveragePriceFallback === false) {
      result.valuationAvailable = valuationAvailable;
      result.valuationStatus = valuationAvailable ? 'available' : 'unavailable';
    }
    return result;
  }

  loadInitialSeedMoney(...args) { return this._portfolioStore().loadInitialSeedMoney(...args); }

  saveInitialSeedMoney(...args) { return this._portfolioStore().saveInitialSeedMoney(...args); }

  mutateAndPersistVirtualPortfolio(...args) { return this._portfolioStore().mutateAndPersistVirtualPortfolio(...args); }

  adjustVirtualWalletBalance(...args) { return this._portfolioStore().adjustVirtualWalletBalance(...args); }

  withPortfolioMutationLock(...args) { return this._portfolioStore().withPortfolioMutationLock(...args); }

  snapshotManualPortfolioState(...args) { return this._portfolioStore().snapshotManualPortfolioState(...args); }

  restoreManualPortfolioState(...args) { return this._portfolioStore().restoreManualPortfolioState(...args); }

  withManualPortfolioTransaction(...args) { return this._portfolioStore().withManualPortfolioTransaction(...args); }

  persistManualOrderIdempotencyRecords(...args) { return this._portfolioStore().persistManualOrderIdempotencyRecords(...args); }

  saveVirtualPortfolio(...args) { return this._portfolioStore().saveVirtualPortfolio(...args); }

  writeJsonAtomically(...args) { return this._portfolioStore().writeJsonAtomically(...args); }

  resetVirtualPortfolio(...args) { return this._portfolioStore().resetVirtualPortfolio(...args); }

  loadVirtualPortfolio(...args) { return this._portfolioStore().loadVirtualPortfolio(...args); }

  loadPaperValidation(...args) { return this._paperJournal().loadPaperValidation(...args); }

  savePaperValidation(...args) { return this._paperJournal().savePaperValidation(...args); }

  getStorageStatus(...args) { return this._paperJournal().getStorageStatus(...args); }

  isProcessAlive(...args) { return this._paperJournal().isProcessAlive(...args); }

  getPaperValidationConfigSnapshot(...args) { return this._paperJournal().getPaperValidationConfigSnapshot(...args); }

  getPaperExperimentSnapshot(...args) { return this._paperJournal().getPaperExperimentSnapshot(...args); }

  comparePaperExperimentConfig(...args) { return this._paperJournal().comparePaperExperimentConfig(...args); }

  getExecutionBoundaryCounterfactualConfig(...args) { return this._paperJournal().getExecutionBoundaryCounterfactualConfig(...args); }

  recordExecutionBoundaryBlockedEntry(...args) { return this._paperJournal().recordExecutionBoundaryBlockedEntry(...args); }

  updateExecutionBoundaryBlockedEntries(...args) { return this._paperJournal().updateExecutionBoundaryBlockedEntries(...args); }

  resolveExecutionBoundaryBlockedEntriesAtStop(...args) { return this._paperJournal().resolveExecutionBoundaryBlockedEntriesAtStop(...args); }

  getExecutionBoundaryBlockedEntrySummary(...args) { return this._paperJournal().getExecutionBoundaryBlockedEntrySummary(...args); }

  recordWinnerShadowBlockedEntry(...args) { return this._paperJournal().recordWinnerShadowBlockedEntry(...args); }

  settleWinnerShadowBlockedEntries(...args) { return this._paperJournal().settleWinnerShadowBlockedEntries(...args); }

  resolveWinnerShadowBlockedEntryAsNotFilled(...args) { return this._paperJournal().resolveWinnerShadowBlockedEntryAsNotFilled(...args); }

  comparePaperValidationConfig(...args) { return this._paperJournal().comparePaperValidationConfig(...args); }

  recordPaperStrictTrade(...args) { return this._paperJournal().recordPaperStrictTrade(...args); }

  applyPaperStrategyRiskState(...args) { return this._paperJournal().applyPaperStrategyRiskState(...args); }

  restorePaperStrategyRiskState(...args) { return this._paperJournal().restorePaperStrategyRiskState(...args); }

  persistPaperStrategyRiskState(...args) { return this._paperJournal().persistPaperStrategyRiskState(...args); }

  getLossCircuitBreakerConfig(...args) { return this._paperJournal().getLossCircuitBreakerConfig(...args); }

  getStrictLossCircuitBreakerState(...args) { return this._paperJournal().getStrictLossCircuitBreakerState(...args); }

  getLossCircuitBreakerStatus(...args) { return this._paperJournal().getLossCircuitBreakerStatus(...args); }

  isStrictEntryBlockedByLossCircuit(...args) { return this._paperJournal().isStrictEntryBlockedByLossCircuit(...args); }

  getStrictSignalWindowEntryCounts(...args) { return this._paperJournal().getStrictSignalWindowEntryCounts(...args); }

  getStrictSignalWindowEntryCount(...args) { return this._paperJournal().getStrictSignalWindowEntryCount(...args); }

  isStrictEntryBlockedBySignalWindow(...args) { return this._paperJournal().isStrictEntryBlockedBySignalWindow(...args); }

  recordStrictSignalWindowEntry(...args) { return this._paperJournal().recordStrictSignalWindowEntry(...args); }

  getStrictSignalWindowStatus(...args) { return this._paperJournal().getStrictSignalWindowStatus(...args); }

  registerRuntimeLoss(...args) { return this._paperJournal().registerRuntimeLoss(...args); }

  startPaperValidationSession(...args) { return this._paperJournal().startPaperValidationSession(...args); }

  stopPaperValidationSession(...args) { return this._paperJournal().stopPaperValidationSession(...args); }

  recordPaperValidationSnapshot(...args) { return this._paperJournal().recordPaperValidationSnapshot(...args); }

  recordPaperSignalTelemetry(...args) { return this._paperJournal().recordPaperSignalTelemetry(...args); }

  recordPaperCircuitBlock(...args) { return this._paperJournal().recordPaperCircuitBlock(...args); }

  recordPaperSignalWindowBlock(...args) { return this._paperJournal().recordPaperSignalWindowBlock(...args); }

  recordPaperMarketRegimeBlock(...args) { return this._paperJournal().recordPaperMarketRegimeBlock(...args); }

  recordInsufficientCandleData(...args) { return this._paperJournal().recordInsufficientCandleData(...args); }

  recordPaperCandleFreshnessObservation(...args) { return this._paperJournal().recordPaperCandleFreshnessObservation(...args); }

  recordPaperCandleFreshnessBlock(...args) { return this._paperJournal().recordPaperCandleFreshnessBlock(...args); }

  recordPaperEntryConfirmation(...args) { return this._paperJournal().recordPaperEntryConfirmation(...args); }

  getStrictOpenPositionSnapshot(...args) { return this._paperJournal().getStrictOpenPositionSnapshot(...args); }

  getPaperDiagnosticOpenPositionSnapshot(...args) { return this._paperJournal().getPaperDiagnosticOpenPositionSnapshot(...args); }

  resolveShadowExitConfig(...args) { return this._paperJournal().resolveShadowExitConfig(...args); }

  updatePaperShadowPosition(...args) { return this._paperJournal().updatePaperShadowPosition(...args); }

  getPaperValidationStatus(...args) { return this._paperJournal().getPaperValidationStatus(...args); }

  /**
   * 다중 코인 자동매매 시작
   */
  get liveCredentialsConfigured() {
    return !this.dryRun &&
      typeof this.upbit?.accessKey === 'string' && this.upbit.accessKey.trim().length > 0 &&
      typeof this.upbit?.secretKey === 'string' && this.upbit.secretKey.trim().length > 0;
  }

  configureUpbitCredentials({ accessKey, secretKey } = {}) {
    const nextAccessKey = typeof accessKey === 'string' ? accessKey.trim() : '';
    const nextSecretKey = typeof secretKey === 'string' ? secretKey.trim() : '';
    if (!nextAccessKey || !nextSecretKey) throw new Error('Upbit Access Key와 Secret Key를 모두 입력하세요.');
    if (this.dryRun) throw new Error('모의투자 서버에는 실계정 키를 등록할 수 없습니다.');
    if (this.isRunning || this._orderInProgress || this._riskCheckInProgress || this._gracefulShutdownPromise) {
      throw new Error('실행 중이거나 주문을 확인 중일 때는 거래소 키를 바꿀 수 없습니다.');
    }
    if (this.liveCredentialsConfigured) {
      throw new Error('이미 LIVE 키가 설정되어 있어 이 경로로 키를 교체할 수 없습니다.');
    }
    const onlyStartupMarketsAreUnverified =
      this._liveAccountStateKnown !== true &&
      this._liveExchangeStateKnown !== true &&
      (this._livePendingOrderMarkets?.size || 0) === 0 &&
      (this._liveEvidenceBlockedMarkets?.size || 0) === 0 &&
      (this._liveUnresolvedOrderIds?.size || 0) === 0 &&
      (this._liveUnresolvedOrderIntents?.size || 0) === 0;
    if (this.getCurrentPositionCount() > 0 ||
        (this.hasUnresolvedLiveOrderState() && !onlyStartupMarketsAreUnverified)) {
      throw new Error('보유 자산이나 확인이 끝나지 않은 주문이 있어 거래소 키를 바꿀 수 없습니다.');
    }

    this.config.accessKey = nextAccessKey;
    this.config.secretKey = nextSecretKey;
    this.upbit.accessKey = nextAccessKey;
    this.upbit.secretKey = nextSecretKey;
    if (this.riskUpbit instanceof UpbitAPI) {
      this.riskUpbit.accessKey = nextAccessKey;
      this.riskUpbit.secretKey = nextSecretKey;
    }
    this._liveAccountStateKnown = false;
    this._liveExchangeStateKnown = false;
    this._liveVerifiedOrderMarkets.clear();
    this._liveOrderStateUnknownMarkets = new Set(this.getLiveManagedMarkets());
    this._livePendingOrderMarkets.clear();
    this._lastSyncTime = 0;
    this.stopReason = 'exchange_state_unverified';
    this._entriesPaused = true;
    this._manualRiskProtection = false;
    this.stopPositionRiskMonitor();
    this.liveManualPrepared = false;
    return { configured: true };
  }

  /**
   * Read-only LIVE account/order reconciliation for a dashboard that starts
   * without the automatic trading loop. Existing exchange orders are left in
   * place and keep their markets locked until they settle or are handled by
   * the user.
   */
  async prepareManualLiveSession() {
    if (this.dryRun) throw new Error('Manual LIVE preparation requires a LIVE server.');
    if (!this.liveManualPrepareOnBoot) throw new Error('Manual LIVE mode is not enabled for this server.');
    if (!this.liveCredentialsConfigured) throw new Error('Upbit credentials have not been registered.');
    if (this.isRunning || this._orderInProgress || this._riskCheckInProgress || this._gracefulShutdownPromise) {
      throw new Error('The LIVE trader is busy and cannot enter manual-only mode.');
    }

    this._stopRequested = false;
    this._entriesPaused = true;
    this._startupReconciliationPending = true;
    this._riskMonitorProtectiveOnly = false;
    this._riskMonitorExitInProgress = false;
    this._manualRiskProtection = false;
    this.stopReason = 'exchange_state_unverified';
    const synchronized = await this.syncWithExchange({ cancelStaleEngineOrders: false });
    if (synchronized !== true || this._liveExchangeStateKnown !== true || this._liveAccountStateKnown !== true) {
      this._startupReconciliationPending = false;
      this._entriesPaused = true;
      this.isRunning = false;
      this.stopReason = 'exchange_state_unverified';
      this.liveManualPrepared = false;
      return { ready: false, reason: 'exchange_state_unverified' };
    }

    this._startupReconciliationPending = false;
    this._entriesPaused = true;
    this.isRunning = false;
    this.stopReason = 'operator_stop';
    this._manualRiskProtection = this.liveManualRiskProtectionEnabled === true &&
      this.positionRiskCheckIntervalMs > 0;
    if (this._manualRiskProtection) {
      this.startPositionRiskMonitor();
      console.log('\n🛡️  수동 LIVE 보호 감시를 시작합니다 - 보유 포지션의 손절·익절·최대보유시간을 감시합니다.');
    } else if (this.liveManualRiskProtectionEnabled) {
      console.warn('\n⚠️  수동 LIVE 보호 감시가 요청됐지만 리스크 감시 간격이 0이라 보호를 시작할 수 없습니다.');
    }
    this.liveManualPrepared = true;
    return {
      ready: true,
      exchangeStateKnown: true,
      pendingOrderMarkets: [...this._livePendingOrderMarkets],
      manualRiskProtection: this._manualRiskProtection
    };
  }

  start() {
    if (this._startPromise) return this._startPromise;
    const startPromise = this.performStart();
    this._startPromise = startPromise;
    startPromise.then(
      () => { if (this._startPromise === startPromise) this._startPromise = null; },
      () => { if (this._startPromise === startPromise) this._startPromise = null; }
    );
    return startPromise;
  }

  async performStart() {
    if (this._riskMonitorProtectiveOnly) {
      throw new Error('보호 전용 상태에서는 자동매매를 다시 시작할 수 없습니다. 열린 LIVE 포지션이 모두 정리된 뒤 새 trader 인스턴스로 시작하세요.');
    }
    this.assertLiveValidationGate();
    this._stopRequested = false;
    this._startupSafetyHold = false;
    this._startupReconciliationPending = !this.dryRun;
    this._entriesPaused = this._startupReconciliationPending;
    this._riskMonitorProtectiveOnly = false;
    this._riskMonitorExitInProgress = false;
    this._manualRiskProtection = false;
    this.stopReason = this._startupReconciliationPending ? 'exchange_state_unverified' : null;
    console.log(`\n🚀 ${this.isScalpingMode ? '과매도 반응 스캘핑' : '다중 코인'} 자동매매 시스템 시작`);
    console.log(`모드: ${this.dryRun ? '모의투자' : '실전투자'}`);

    console.log(`분석 대상: ${this.targetCoins.length}개 코인`);

    console.log(`포지션 제한: ${this.maxPositions}개`);

    // 투자 비율 표시
    console.log(`투자 비율: 총자산의 ${(this.investmentRatio * 100).toFixed(1)}% (최소 ${this.MIN_ORDER_AMOUNT.toLocaleString()}원)`);

    // 실전 모드: 초기 시드머니 자동 기록 (최초 1회)
    if (!this.dryRun && this.initialSeedMoney === 0) {
      await this.saveInitialSeedMoney();
    }

    // 초기 시드머니 표시
    if (this.initialSeedMoney > 0) {
      console.log(`초기 시드머니: ${this.initialSeedMoney.toLocaleString()}원`);
    }

    console.log('─'.repeat(80));

    if (this._startupReconciliationPending) {
      while (!this._liveExchangeStateKnown && !this._stopRequested) {
        while (this._orderInProgress || this._riskCheckInProgress) {
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        const synchronized = await this.syncWithExchange();
        if (synchronized) {
          this._lastSyncTime = Date.now();
          break;
        }
        if (this._liveAccountStateKnown && this.getCurrentPositionCount() > 0) {
          this._startupSafetyHold = true;
          this.pauseForSafetyIncident('exchange_state_unverified');
        }
        if (!this._stopRequested) await this.sleep(this.exchangeSyncRetryMs);
      }

      if (this._stopRequested || this._riskMonitorProtectiveOnly || this._startupSafetyHold) return;
      if (!this._liveExchangeStateKnown) return;
      this._startupReconciliationPending = false;
      this._entriesPaused = false;
      this.stopReason = null;
    }

    this.isRunning = true;
    this.startPositionRiskMonitor();
    this.startAnalysisDataWatchdog();
    if (!this.dryRun && this.getCurrentPositionCount() > 0) {
      await this.monitorOpenPositions();
    }

    // 스캘핑은 뉴스 수집 지연과 장기 감성을 매수 조건에서 제외한다.
    if (this.useNews) {
      await this.updateNews();
    } else {
      this.newsData = null;
      console.log('🧭 스캘핑 모드: 뉴스 분석 없이 가격 반등만 감시합니다.');
    }

    // 주기적 실행
    while (this.isRunning) {
      try {
        await this.executeTradingCycle();
        await this.recordPaperValidationSnapshot('trading_cycle');
        await this.sleep(this.config.checkInterval || 60000);
      } catch (error) {
        console.error('\n❌ 매매 사이클 오류:', error.message);
        await this.sleep(10000);
      }
    }
  }

  /**
   * 스캘핑 실전 주문은 읽기 전용 워크포워드 검증이 전체 마켓에서
   * 통과하기 전까지 시작하지 않는다. DRY_RUN에는 적용하지 않는다.
   */
  assertLiveValidationGate() {
    if (this.dryRun) return;
    if (this.positionRiskCheckIntervalMs <= 0) {
      throw new Error('실전 매매 차단: 포지션 위험 감시를 비활성화할 수 없습니다. SCALP_RISK_CHECK_INTERVAL_MS를 0보다 크게 설정하세요.');
    }
    if (this.maxRiskDataGapSeconds <= 0) {
      throw new Error('실전 매매 차단: 리스크 데이터 공백 감지를 비활성화할 수 없습니다. SCALP_MAX_RISK_DATA_GAP_SECONDS를 0보다 크게 설정하세요.');
    }
    if (!this.isScalpingMode) return;
    if (this.config.requireValidationPassForLive === false) {
      throw Object.assign(
        new Error('실전 스캘핑 차단: 실전 검증 게이트를 비활성화할 수 없습니다. SCALP_REQUIRE_VALIDATION_PASS=true로 설정하고 최신 fixed_config 검증을 통과하세요.'),
        { code: 'live_validation_bypass_not_supported' }
      );
    }

    const reportFile = this.config.scalpingValidationOutputFile ||
      process.env.SCALP_VALIDATION_OUTPUT_FILE ||
      'scalping_validation.json';
    if (!fs.existsSync(reportFile)) {
      throw new Error(`실전 스캘핑 차단: ${path.basename(reportFile)} 검증 리포트가 없습니다. 먼저 npm run validate:scalping을 실행하세요.`);
    }

    let report;
    try {
      report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    } catch (error) {
      throw new Error(`실전 스캘핑 차단: 검증 리포트를 읽을 수 없습니다 (${error.message})`, { cause: error });
    }

    this.validatePromotionReport(report);
  }

  validatePromotionReport(report, { now = Date.now(), maxAgeSeconds } = {}) {
    if (!report || report.validationMode !== 'fixed_config') {
      throw new Error('실전 스캘핑 차단: 현재 runtime 설정을 고정 검증한 fixed_config 리포트가 필요합니다. tuned 리포트는 live 승격에 사용할 수 없습니다.');
    }
    if (report.strategyMode !== this.strategyMode) {
      throw new Error(`실전 스캘핑 차단: validation report 전략 모드가 다릅니다 (${report.strategyMode || 'unknown'}).`);
    }
    if (!Array.isArray(report.markets) || report.markets.length === 0) {
      throw new Error('실전 스캘핑 차단: 검증 대상 market 목록이 비어 있습니다.');
    }

    const currentSnapshot = this.getPaperValidationConfigSnapshot();
    const comparableKeys = LIVE_GATE_COMPARABLE_KEYS;
    const reportConfig = report.config || {};
    const backwardCompatibleReportDefaults = {
      maxRiskDataGapSeconds: 30,
      maxAnalysisDataGapSeconds: this.isScalpingMode ? 60 : 0
    };
    const missingKeys = comparableKeys.filter(key =>
      reportConfig[key] === undefined &&
      !Object.prototype.hasOwnProperty.call(backwardCompatibleReportDefaults, key)
    );
    if (missingKeys.length > 0) {
      throw new Error(`실전 스캘핑 차단: fixed validation report 설정이 불완전합니다 (${missingKeys.join(', ')}).`);
    }
    const configDrift = comparableKeys
      .filter(key => {
        const reportValue = reportConfig[key] === undefined &&
          Object.prototype.hasOwnProperty.call(backwardCompatibleReportDefaults, key)
          ? backwardCompatibleReportDefaults[key]
          : reportConfig[key];
        return JSON.stringify(reportValue) !== JSON.stringify(currentSnapshot[key]);
      });
    if (configDrift.length > 0) {
      throw new Error(`실전 스캘핑 차단: validation report와 현재 runtime 설정이 다릅니다 (${configDrift.join(', ')}). fixed validation을 다시 실행하세요.`);
    }

    const confidenceSummary = report.statisticalConfidence;
    const confidenceRowsComplete = Array.isArray(report.results) &&
      report.results.length === report.markets.length &&
      report.results.every(result => {
        const gate = result.validation?.gate?.statisticalConfidence;
        return gate?.required === true &&
          gate.training?.passed === true &&
          gate.validation?.passed === true;
      });
    if (confidenceSummary?.required !== true ||
      confidenceSummary?.method !== 'one_sided_t_mean' ||
      confidenceSummary?.passed !== true ||
      !confidenceRowsComplete) {
      throw new Error('실전 스캘핑 차단: 95% 거래수익 신뢰도 게이트가 없거나 통과하지 않았습니다. 최신 fixed validation을 다시 실행하세요.');
    }

    if (report.promoted !== true) {
      const promoted = Array.isArray(report.promotedMarkets) ? report.promotedMarkets.length : 0;
      const total = Array.isArray(report.markets) ? report.markets.length : 0;
      throw new Error(`실전 스캘핑 차단: 전체 워크포워드 게이트 미통과 (${promoted}/${total}). DRY_RUN=true로 계속 검증하세요.`);
    }

    const freshness = assessScalpingValidationReportFreshness(report.generatedAt, {
      now,
      ...(maxAgeSeconds === undefined ? {} : { maxAgeSeconds })
    });
    if (!freshness.fresh) {
      const error = new Error(
        `실전 스캘핑 차단: 검증 리포트가 오래되었거나 작성 시각을 확인할 수 없습니다 (${freshness.reason}). 최신 fixed validation을 다시 실행하세요.`
      );
      error.code = 'report_not_current';
      throw error;
    }
  }

  syncRiskMonitorState(...args) { return this._riskMonitor().syncRiskMonitorState(...args); }

  persistRiskMonitorStateIfDue(...args) { return this._riskMonitor().persistRiskMonitorStateIfDue(...args); }

  getRiskMonitorStatus(...args) { return this._riskMonitor().getRiskMonitorStatus(...args); }

  recordRiskMonitorSuccess(...args) { return this._riskMonitor().recordRiskMonitorSuccess(...args); }

  recordRiskMonitorFailure(...args) { return this._riskMonitor().recordRiskMonitorFailure(...args); }

  enforceRiskMonitorFreshness(...args) { return this._riskMonitor().enforceRiskMonitorFreshness(...args); }

  handleRiskMonitorFailure(...args) { return this._riskMonitor().handleRiskMonitorFailure(...args); }

  syncAnalysisDataHealthState(...args) { return this._riskMonitor().syncAnalysisDataHealthState(...args); }

  persistAnalysisDataStateIfDue(...args) { return this._riskMonitor().persistAnalysisDataStateIfDue(...args); }

  beginAnalysisDataCycle(...args) { return this._riskMonitor().beginAnalysisDataCycle(...args); }

  getAnalysisDataHealthStatus(...args) { return this._riskMonitor().getAnalysisDataHealthStatus(...args); }

  enforceAnalysisDataFreshness(...args) { return this._riskMonitor().enforceAnalysisDataFreshness(...args); }

  recordAnalysisDataHealth(...args) { return this._riskMonitor().recordAnalysisDataHealth(...args); }

  recordPaperIncompleteAnalysisTelemetry(...args) { return this._paperJournal().recordPaperIncompleteAnalysisTelemetry(...args); }

  stop(reason = null) {
    console.log('\n⏹️  다중 코인 자동매매 시스템 중지');
    if (reason) this.stopReason = reason;
    this._stopRequested = true;
    this._entriesPaused = true;
    this._riskMonitorProtectiveOnly = false;
    this._manualRiskProtection = false;
    this._riskMonitorExitInProgress = false;
    this.isRunning = false;
    this.stopPositionRiskMonitor();
    this.stopAnalysisDataWatchdog();
  }

  pauseForSafetyIncident(reason) {
    const hasLivePosition = !this.dryRun && this.getCurrentPositionCount() > 0;
    if (!hasLivePosition || this.positionRiskCheckIntervalMs <= 0) {
      this.stop(reason);
      return false;
    }

    if (this._riskMonitorProtectiveOnly) return true;
    console.error(
      `\n🛡️  ${reason} - 분석과 신규 진입을 멈추고 기존 LIVE 포지션의 위험 감시를 유지합니다.`
    );
    this.stopReason = reason;
    this.isRunning = false;
    this._stopRequested = false;
    this._entriesPaused = true;
    this._riskMonitorProtectiveOnly = true;
    this.stopAnalysisDataWatchdog();
    this.startPositionRiskMonitor();
    return true;
  }

  requestGracefulShutdown(reason = 'operator_shutdown') {
    if (this._gracefulShutdownPromise) return this._gracefulShutdownPromise;
    const shutdownPromise = this.performGracefulShutdown(reason);
    this._gracefulShutdownPromise = shutdownPromise;
    shutdownPromise.then(
      () => { if (this._gracefulShutdownPromise === shutdownPromise) this._gracefulShutdownPromise = null; },
      () => { if (this._gracefulShutdownPromise === shutdownPromise) this._gracefulShutdownPromise = null; }
    );
    return shutdownPromise;
  }

  async performGracefulShutdown(reason = 'operator_shutdown') {
    this._stopRequested = true;
    this._entriesPaused = true;
    this.isRunning = false;
    this.stopAnalysisDataWatchdog();

    // Let an already-submitted order finish and reconcile before deciding
    // whether the process is flat. No new order can enter while we wait.
    while (this._orderInProgress || this._riskCheckInProgress) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }

    if (!this.dryRun && this.getCurrentPositionCount() > 0 && !this._riskMonitorProtectiveOnly) {
      this.pauseForSafetyIncident(reason);
    }

    if (!this.dryRun) {
      // A local strategy map can be empty or stale after a restart, lost order
      // response, or partial fill. Do not decide that LIVE is flat until both
      // account balances and target-market open orders have been reconciled.
      while (true) {
        const synchronized = await this.syncWithExchange();
        if (synchronized === true && !this.hasUnresolvedLiveOrderState()) {
          this._lastSyncTime = Date.now();
          break;
        }
        console.error(synchronized === true
          ? '🛑 미해결 LIVE 주문 상태가 남아 있어 종료를 보류하고 재조회합니다.'
          : '🛑 LIVE 거래소 상태를 확인할 수 없어 종료를 보류하고 재조회합니다.');
        await this.sleep(this.exchangeSyncRetryMs);
      }
    }

    if (!this.dryRun && this.getCurrentPositionCount() > 0) {
      if (this.positionRiskCheckIntervalMs <= 0) {
        throw new Error('LIVE 포지션이 남아 있지만 리스크 모니터가 비활성화되어 안전하게 종료할 수 없습니다.');
      }
      return this.pauseForSafetyIncident(reason);
    }
    this.stop(reason);
    return false;
  }

  async waitForProtectiveDrain() {
    while (this._riskMonitorProtectiveOnly) {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return this.getCurrentPositionCount() === 0;
  }

  finishProtectiveMonitoringWhenFlat() {
    if (!this._riskMonitorProtectiveOnly || this.getCurrentPositionCount() > 0) return false;
    this._riskMonitorProtectiveOnly = false;
    if (this._manualRiskProtection) {
      console.log('\n✅ 감시 중이던 LIVE 포지션이 모두 닫혔습니다. 수동 보호 감시는 유지되며 신규 진입은 재개하지 않습니다.');
      return true;
    }
    this.stopPositionRiskMonitor();
    console.log('\n✅ 감시 중이던 LIVE 포지션이 모두 닫혀 위험 감시가 idle 상태가 됐습니다. 신규 진입은 재개하지 않습니다.');
    return true;
  }

  getRuntimeSafetyStatus() {
    return {
      runtimeState: this._riskMonitorProtectiveOnly
        ? 'PROTECTIVE_ONLY'
        : !this.dryRun && !this._liveExchangeStateKnown ? 'SYNC_REQUIRED'
        : this.isRunning ? 'RUNNING' : 'STOPPED',
      entriesPaused: this._entriesPaused || this._stopRequested || (!this.dryRun && !this._liveExchangeStateKnown),
      manualProtectionActive: this._manualRiskProtection === true && this.positionRiskTimer !== null,
      protectiveMonitorActive: this._riskMonitorProtectiveOnly && this.positionRiskTimer !== null,
      stopReason: this.stopReason || (!this.dryRun && !this._liveExchangeStateKnown ? 'exchange_state_unverified' : null),
      exchangeStateKnown: this.dryRun ? null : this._liveExchangeStateKnown
    };
  }

  startAnalysisDataWatchdog(...args) { return this._riskMonitor().startAnalysisDataWatchdog(...args); }

  stopAnalysisDataWatchdog(...args) { return this._riskMonitor().stopAnalysisDataWatchdog(...args); }

  getStrictPaperExecutionCostModel(position = null) {
    if (!this.dryRun || this.paperValidation?.active !== true) return null;

    const version = 'strict_paper_cost_model_v1';
    if (position && position.paperExecutionCostModel !== version) return null;
    if (position && (position.paperEntryFee === null || position.paperEntryFee === undefined ||
      !Number.isFinite(Number(position.paperEntryFee)) || Number(position.paperEntryFee) < 0)) return null;
    if (position && (position.paperExecutionTradingFeeRate === null || position.paperExecutionTradingFeeRate === undefined ||
      !Number.isFinite(Number(position.paperExecutionTradingFeeRate)))) return null;
    const configuredSlippageRate = position
      ? position.paperExecutionSlippageRate
      : this.config?.slippage ?? this.strategyConfig?.slippage;
    const configuredTradingFeeRate = position
      ? position.paperExecutionTradingFeeRate
      : this.config?.tradingFee ?? this.strategyConfig?.tradingFee;
    const slippageRate = Number(configuredSlippageRate);
    const tradingFeeRate = Number(configuredTradingFeeRate);
    if (!Number.isFinite(slippageRate) || slippageRate < 0 || slippageRate >= 1 ||
      !Number.isFinite(tradingFeeRate) || tradingFeeRate < 0 || tradingFeeRate >= 1) return null;

    return { version, slippageRate, tradingFeeRate };
  }

  startPositionRiskMonitor(...args) { return this._riskMonitor().startPositionRiskMonitor(...args); }

  stopPositionRiskMonitor(...args) { return this._riskMonitor().stopPositionRiskMonitor(...args); }

  monitorOpenPositions(...args) { return this._riskMonitor().monitorOpenPositions(...args); }

  syncWithExchange(...args) { return this._liveGateway().syncWithExchange(...args); }

  hasUnresolvedLiveOrderState(...args) { return this._liveGateway().hasUnresolvedLiveOrderState(...args); }

  persistLiveOrderReadback(...args) { return this._liveGateway().persistLiveOrderReadback(...args); }

  resolveUnresolvedLiveOrders(...args) { return this._liveGateway().resolveUnresolvedLiveOrders(...args); }

  refreshLiveEvidenceRecoveryState(...args) { return this._liveGateway().refreshLiveEvidenceRecoveryState(...args); }

  performExchangeSync(...args) { return this._liveGateway().performExchangeSync(...args); }

  cleanupPendingOrders(...args) { return this._liveGateway().cleanupPendingOrders(...args); }

  /**
   * 다중 코인 매매 사이클
   */
  async executeTradingCycle() {
    // 0. 실전 모드: 정기 동기화와 안전 상태 복구를 함께 확인한다.
    if (!this.dryRun) {
      const lastSync = this._lastSyncTime || 0;
      const now = Date.now();
      const globalExchangeStateUnknown = this._liveExchangeStateKnown !== true;
      const scopedOrderStateNeedsRecheck = this._liveEvidenceBlockedMarkets.size > 0 ||
        this._livePendingOrderMarkets.size > 0 || this._liveOrderStateUnknownMarkets.size > 0;
      const exchangeStateNeedsRecheck = globalExchangeStateUnknown || scopedOrderStateNeedsRecheck;
      const syncDue = exchangeStateNeedsRecheck || now - lastSync > 10 * 60 * 1000;
      if (syncDue) {
        const waitingForScopedRetry = scopedOrderStateNeedsRecheck &&
          now - this._lastExchangeSyncAttemptTime < this.exchangeSyncRetryMs;
        const waitingForGlobalRetry = globalExchangeStateUnknown &&
          now - this._lastExchangeSyncAttemptTime < this.exchangeSyncRetryMs;
        if (waitingForGlobalRetry) return false;
        if (!waitingForScopedRetry) {
          this._lastExchangeSyncAttemptTime = now;
          const synchronized = await this.syncWithExchange();
          if (synchronized !== true) {
            if (this.getCurrentPositionCount() > 0) {
              this.pauseForSafetyIncident('exchange_state_unverified');
            }
            console.error('  🛑 거래소 동기화 실패 - 포지션 상태가 확인될 때까지 분석과 신규 매매를 건너뜁니다.');
            return false;
          }
          this._lastSyncTime = Date.now();
          this._lastExchangeSyncAttemptTime = this._lastSyncTime;
        }
      }
    }

    this.beginAnalysisDataCycle();
    const now = new Date();
    console.log(`\n⏰ [${now.toLocaleString('ko-KR')}] 다중 코인 매매 분석 시작`);
    console.log('='.repeat(80));

    // 1. 계좌 조회
    const accounts = await this.getAccountInfo();
    const krwBalance = this.getKRWBalance(accounts);

    console.log(`\n💰 계좌 정보:`);
    console.log(`  KRW: ${Number(krwBalance).toLocaleString()} 원`);

    // 2. 뉴스 업데이트 (스캘핑 모드에서는 비활성화)
    if (this.useNews) {
      await this.updateNews();
    }

    // 뉴스 데이터 없어도 기술적 분석으로 거래 진행
    let newsSentiment;
    if (this.useNews && this.newsData) {
      newsSentiment = this.newsMonitor.analyzeMarketSentiment(this.newsData);
    } else {
      console.log('⚠️  뉴스 데이터 없음 - 기술적 분석만으로 진행');
      // 중립 뉴스 감성으로 대체
      newsSentiment = { overall: 'neutral', score: 0.5, confidence: 0.5 };
    }

    // 3. 각 코인 분석 및 점수 계산
    const coinAnalyses = [];
    const analysisFailureMarkets = [];
    const analysisFailureCounts = {};
    const analysisTransportFailureCodes = {};

    this.cycleRequestStats = {
      batchTickerRequests: 0,
      individualTickerRequests: 0,
      candleRequests: 0,
      batchTickerFailures: 0
    };
    const tickerMap = await this.getTickerMapForCycle();
    for (const coin of this.targetCoins) {
      try {
        const prefetchedTicker = tickerMap?.get(coin);
        const snapshotMarketData = this._snapshotContext?.marketDataByCoin instanceof Map
          ? this._snapshotContext.marketDataByCoin.get(coin)
          : this._snapshotContext?.marketDataByCoin?.[coin];
        const marketData = snapshotMarketData
          ? {
              ...snapshotMarketData,
              ticker: prefetchedTicker || snapshotMarketData.ticker,
              sharedSnapshot: true
            }
          : prefetchedTicker
            ? { ticker: prefetchedTicker }
            : {};
        const analysis = await this.analyzeCoin(
          coin,
          newsSentiment,
          marketData,
          accounts
        );
        coinAnalyses.push(analysis);
        this.analysisCycleProgress?.add(coin);
      } catch (error) {
        console.error(`\n❌ ${coin} 분석 오류:`, error.message);
        const failureCode = classifyAnalysisFailure(error);
        const transportCode = analysisNetworkErrorCode(error);
        analysisFailureMarkets.push(coin);
        analysisFailureCounts[failureCode] = (analysisFailureCounts[failureCode] || 0) + 1;
        if (transportCode) {
          analysisTransportFailureCodes[transportCode] =
            (analysisTransportFailureCodes[transportCode] || 0) + 1;
        }
      }
    }

    const failureCodes = Object.keys(analysisFailureCounts);
    const analysisFailureCode = failureCodes.length === 1
      ? failureCodes[0]
      : failureCodes.length > 1
        ? 'mixed_analysis_failures'
        : null;
    const analysisDataHealth = this.recordAnalysisDataHealth(coinAnalyses, Date.now(), {
      failureCode: analysisFailureCode,
      failureMarkets: analysisFailureMarkets,
      failureCounts: analysisFailureCounts,
      transportFailureCodes: analysisTransportFailureCodes
    });
    if (!analysisDataHealth.complete) {
      this.recordPaperIncompleteAnalysisTelemetry(analysisDataHealth);
      if (analysisDataHealth.failClosed && this.isRunning) {
        console.error(`\n🛑 분석 데이터 공백 ${analysisDataHealth.gapDurationSeconds.toFixed(1)}초 초과 - paper/live 관찰을 중지합니다.`);
        this.pauseForSafetyIncident('analysis_data_gap');
      }
      return;
    }

    const marketRegime = summarizeLiveMarketRegime(coinAnalyses, this.config);
    for (const analysis of coinAnalyses) {
      analysis.marketRegime = {
        ...marketRegime,
        coinReturnPercent: analysis.marketReturnPercent
      };
      analysis.decision.details = {
        ...(analysis.decision.details || {}),
        marketRegime: analysis.marketRegime
      };
    }

    this.recordPaperSignalTelemetry(coinAnalyses, marketRegime);

    // 4. 점수 기준으로 정렬 (매수 우선순위)
    coinAnalyses.sort((a, b) => b.decision.scores.total - a.decision.scores.total);

    // AI monitoring은 동일한 분석 snapshot을 관찰할 뿐, 아래의 기존
    // executeOrder() 흐름과 decision 객체를 변경하지 않는다. 특히
    // 설정값 기반 BUY/SELL 자동 실행은 이 callback과 완전히 분리된다.
    this.notifyAnalysisCycle({
      type: 'monitoring-cycle',
      source: 'trading_cycle',
      timestamp: now.toISOString(),
      mode: this.dryRun ? 'DRY_RUN' : 'LIVE',
      krwBalance,
      currentPositions: this.getCurrentPositionCount(),
      analyses: coinAnalyses
    });

    // 5. 상위 코인부터 매매 실행
    console.log('\n📊 코인별 분석 결과 (점수 순):');
    coinAnalyses.forEach((analysis, index) => {
      const strength = analysis.decision.signalStrength;
      const strengthEmoji = {
        'VERY_STRONG': '🔥🔥',
        'STRONG': '🔥',
        'MEDIUM': '💡',
        'WEAK': '💤',
        'NONE': '⏸️'
      }[strength?.level] || '⏸️';

      console.log(`\n${index + 1}. ${analysis.coin}`);
      console.log(`  현재가: ${analysis.currentPrice.toLocaleString()} 원`);
      console.log(`  점수: ${analysis.decision.scores.total}`);
      console.log(`  추천: ${analysis.decision.action} ${strengthEmoji} ${strength?.level || 'NONE'}`);
      console.log(`  이유: ${analysis.decision.reason}`);
    });

    // 6. 현재 포지션 수 확인
    const currentPositions = this.getCurrentPositionCount();
    console.log(`\n📍 현재 포지션 수: ${currentPositions}개 / 최대 ${this.maxPositions}개`);

    // 7. 매매 실행 (강한 신호 우선)
    for (const analysis of coinAnalyses) {
      let updatedKrwBalance = krwBalance;
      let updatedCoinBalance = analysis.coinBalance;
      let updatedPositions = currentPositions;
      if (analysis.decision?.action !== 'HOLD') {
        // Refresh immediately before actionable orders so manual/external
        // account changes still gate BUY/SELL. HOLD returns before reading
        // either balance, position count, or exchange state.
        const latestAccounts = await this.getAccountInfo();
        updatedKrwBalance = this.getKRWBalance(latestAccounts);
        updatedCoinBalance = this.getCoinBalance(latestAccounts, analysis.coin);
        updatedPositions = this.getCurrentPositionCount();
      }

      await this.executeOrder(
        analysis.coin,
        analysis.decision,
        analysis.currentPrice,
        updatedKrwBalance,
        updatedCoinBalance,
        updatedPositions,
        coinAnalyses,  // 리밸런싱용 전체 분석 결과 전달
        this._snapshotContext
      );
    }

    // 8. 포트폴리오 요약
    this.printPortfolioSummary();
  }

  /**
   * Evaluate one paper cycle against a caller-owned shared market snapshot.
   *
   * This is intentionally research-only. The caller supplies one ticker and
   * candle set per market, and the normal dry-run analysis/order/ledger paths
   * are reused for the individual virtual book. Live traders are rejected so
   * this cannot accidentally turn a comparison runner into an order router.
   */
  async executeTradingCycleFromSnapshot(snapshot) {
    if (!this.dryRun) {
      throw new Error('shared snapshot cycle은 DRY_RUN 연구 세션에서만 사용할 수 있습니다.');
    }
    if (!snapshot || !(snapshot.tickerMap instanceof Map) || !(snapshot.priceMap instanceof Map)) {
      throw new Error('shared snapshot cycle에는 tickerMap과 priceMap이 필요합니다.');
    }
    if (!(snapshot.marketDataByCoin instanceof Map) &&
      (!snapshot.marketDataByCoin || typeof snapshot.marketDataByCoin !== 'object')) {
      throw new Error('shared snapshot cycle에는 marketDataByCoin이 필요합니다.');
    }

    if (!this.isRunning || this._stopRequested) {
      throw new Error('shared snapshot cycle의 trader가 실행 상태가 아닙니다.');
    }
    const previousSnapshotContext = this._snapshotContext;
    this._snapshotContext = {
      ...snapshot,
      sharedSnapshot: true,
      skipConfirmationDelay: true
    };

    try {
      // Risk exits are evaluated from the same snapshot before new entries,
      // matching the normal runner's protection-first ordering without a
      // second ticker request per variant.
      await this.monitorOpenPositions(this._snapshotContext);
      await this.executeTradingCycle();
      return await this.recordPaperValidationSnapshot(
        'shared_snapshot_cycle',
        this._snapshotContext.priceMap
      );
    } finally {
      this._snapshotContext = previousSnapshotContext;
    }
  }

  /**
   * 개별 코인 분석
   */
  async getTickerMapForCycle() {
    if (this._snapshotContext?.sharedSnapshot === true &&
      this._snapshotContext.tickerMap instanceof Map) {
      return this._snapshotContext.tickerMap;
    }
    if (!Array.isArray(this.targetCoins) || this.targetCoins.length === 0) return null;
    this.cycleRequestStats = this.cycleRequestStats || {
      batchTickerRequests: 0,
      individualTickerRequests: 0,
      candleRequests: 0,
      batchTickerFailures: 0
    };
    this.cycleRequestStats.batchTickerRequests += 1;
    try {
      const tickers = await this.marketDataAdapter.getTickers(this.targetCoins);
      if (!Array.isArray(tickers)) return null;
      return new Map(
        tickers
          .filter(ticker => ticker?.market && Number.isFinite(Number(ticker.trade_price)))
          .map(ticker => [ticker.market, ticker])
      );
    } catch (error) {
      // A batch failure falls back to per-market analysis so one transient
      // response cannot erase the cycle's telemetry.
      console.error(`\n⚠️  전체 ticker batch 조회 실패: ${error.message}`);
      this.cycleRequestStats.batchTickerFailures += 1;
      return null;
    }
  }

  async analyzeCoin(coin, newsSentiment, marketData = {}, accountSnapshot) {
    const accounts = accountSnapshot === undefined
      ? await this.getAccountInfo()
      : accountSnapshot;
    const coinBalance = this.getCoinBalance(accounts, coin);

    // 현재가 조회 - null/빈배열 체크
    this.cycleRequestStats = this.cycleRequestStats || {
      batchTickerRequests: 0,
      individualTickerRequests: 0,
      candleRequests: 0,
      batchTickerFailures: 0
    };
    const sharedSnapshot = marketData.sharedSnapshot === true;
    if (!marketData.ticker && !sharedSnapshot) this.cycleRequestStats.individualTickerRequests += 1;
    const ticker = marketData.ticker
      ? [marketData.ticker]
      : sharedSnapshot
        ? null
        : await this.marketDataAdapter.getTickers(coin);
    if (!ticker || !Array.isArray(ticker) || ticker.length === 0) {
      throw new Error(`${coin} 현재가 조회 실패 - 응답 없음`);
    }
    if (!ticker[0] || typeof ticker[0].trade_price !== 'number') {
      throw new Error(`${coin} 현재가 조회 실패 - 유효하지 않은 데이터`);
    }
    const marketQuoteFreshness = inspectTraderMarketQuote(
      ticker[0],
      coin,
      this.maxCandleAgeSeconds
    );
    if (!marketQuoteFreshness.fresh) {
      throw createMarketQuoteFreshnessError(coin, marketQuoteFreshness);
    }
    const currentPrice = ticker[0].trade_price;

    // 캔들 데이터 조회
    if (marketData.candles === undefined && !sharedSnapshot) this.cycleRequestStats.candleRequests += 1;
    const candles = marketData.candles || (sharedSnapshot
      ? null
      : await this.marketDataAdapter.getMinuteCandles(coin, this.candleUnit, this.candleCount));
    const minimumCandleCount = Math.max(50, (this.config.rsiPeriod || 14) + 10);
    if (!candles || !Array.isArray(candles) || candles.length < minimumCandleCount) {
      this.recordInsufficientCandleData(coin, Array.isArray(candles) ? candles.length : 0, minimumCandleCount);
      throw new Error(`${coin} 캔들 데이터 부족 (${candles?.length || 0}개)`);
    }

    // 기술적 분석
    const technicalAnalysis = this.buildTechnicalAnalysis(candles);

    if (!technicalAnalysis) {
      throw new Error(`${coin} 기술적 분석 실패`);
    }

    const candleFreshness = inspectLatestCandleFreshness(candles, {
      candleUnit: this.candleUnit,
      maxAgeSeconds: this.maxCandleAgeSeconds
    });
    this.recordPaperCandleFreshnessObservation(coin, candleFreshness);

    // 코인별 감성 분석 (스캘핑 모드에서는 호출하지 않음)
    let combinedSentiment = { ...newsSentiment };
    try {
      if (!this.useNews) {
        combinedSentiment = { overall: 'neutral', score: 0, confidence: 0 };
      } else {
        const coinSentiment = await this.newsMonitor.getCoinSentiment(coin, 600000);
        if (coinSentiment && coinSentiment.newsCount > 0) {
          // 코인별 감성과 시장 감성을 결합 (코인별 60%, 시장 40%)
          const coinScore = parseFloat(coinSentiment.score) || 0;
          const marketScore = parseFloat(newsSentiment.score) || 0;
          const weightedScore = (coinScore * 0.6) + (marketScore * 0.4);

          combinedSentiment = {
            ...newsSentiment,
            score: weightedScore.toFixed(2),
            coinSpecific: coinSentiment,
            hasCoinNews: true,
            // 코인별 뉴스가 강한 신호면 추천 업데이트
            recommendation: coinSentiment.newsCount >= 3 && Math.abs(coinScore) > 1
              ? coinSentiment.recommendation
              : newsSentiment.recommendation
          };
        }
      }
    } catch {
      // 코인별 뉴스 실패시 시장 감성만 사용
    }

    // 전략 가져오기
    const strategy = this.getStrategy(coin);

    // 캔들 시각을 확인할 수 없거나 허용 나이보다 오래된 경우에는
    // 전략 상태(특히 이미 처리한 signal key)를 변경하지 않고 fail-closed
    // HOLD를 반환한다. 지연 후 재검증에서도 같은 계약을 다시 확인한다.
    let decision;
    if (!candleFreshness.valid) {
      this.recordPaperCandleFreshnessBlock(candleFreshness.reason, candleFreshness, 'analysis', coin);
      decision = {
        action: 'HOLD',
        reason: `캔들 데이터 신선도 부족 - ${candleFreshness.reason}`,
        confidence: '0.00',
        signalStrength: { level: 'NONE', multiplier: 0, score: 0 },
        scores: { technical: '0.00', news: '0.00', total: '0.00' },
        details: {
          rebound: technicalAnalysis?.indicators?.rebound || null,
          candleFreshness
        }
      };
    } else {
      decision = strategy.makeDecision(
        technicalAnalysis,
        combinedSentiment,
        currentPrice
      );
    }
    const marketRegimeLookback = Math.max(1, Math.floor(Number(this.config.marketRegimeLookback) || 5));
    const marketReturnPercent = calculateLiveMarketReturn(candles, marketRegimeLookback);
    decision.details = {
      ...(decision.details || {}),
      candleFreshness,
      marketQuoteFreshness,
      marketReturnPercent
    };

    return {
      coin,
      currentPrice,
      coinBalance,
      technicalAnalysis,
      decision,
      marketReturnPercent,
      candleFreshness,
      marketQuoteFreshness,
      sentiment: combinedSentiment
    };
  }

  /**
   * 반등 후보를 주문 직전에 다시 확인한다.
   * 지연 동안 가격/캔들이 바뀌면 기존 분석 결과를 재사용하지 않는다.
   */
  async confirmScalpingEntry(coin, decision, strategy, marketData = null) {
    const requestedDelay = Number(decision.entryDelayMs);
    const minDelay = Math.max(1000, Number(this.entryDelayMinMs) || 1000);
    const maxDelay = Math.max(minDelay, Number(this.entryDelayMaxMs) || 5000);
    const skipDelay = marketData?.skipConfirmationDelay === true;
    const delayMs = skipDelay
      ? 0
      : Math.min(maxDelay, Math.max(minDelay, Number.isFinite(requestedDelay)
        ? requestedDelay
        : strategy.getEntryDelayMs()));

    this.recordPaperEntryConfirmation(coin, 'attempt', 'pending');
    console.log(`\n⏳ [${coin}] 반등 확인 완료 - ${delayMs}ms 후 주문 재검증`);
    if (!skipDelay) await this.sleep(delayMs);

    if (this._stopRequested || this._entriesPaused) {
      this.recordPaperEntryConfirmation(coin, 'cancelled', 'stop_requested');
      this.resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, 'stop_requested');
      console.log(`  ⛔ [${coin}] 중지 요청으로 진입 취소`);
      return null;
    }

    let ticker;
    let candles;
    try {
      if (marketData?.sharedSnapshot === true) {
        ticker = marketData.ticker ? [marketData.ticker] : null;
        candles = marketData.candles;
      } else {
        [ticker, candles] = await Promise.all([
          this.marketDataAdapter.getTickers(coin),
          this.marketDataAdapter.getMinuteCandles(coin, this.candleUnit, this.candleCount)
        ]);
      }
    } catch (error) {
      this.recordPaperEntryConfirmation(coin, 'cancelled', 'revalidation_request_failed');
      this.resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, 'revalidation_request_failed');
      console.log(`  ⚠️  [${coin}] 지연 후 재검증 조회 실패: ${error.message}`);
      return null;
    }

    const latestTicker = ticker?.[0];
    const latestPrice = latestTicker?.trade_price;
    if (!Number.isFinite(latestPrice) || !Array.isArray(candles)) {
      this.recordPaperEntryConfirmation(coin, 'cancelled', 'invalid_revalidation_payload');
      this.resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, 'invalid_revalidation_payload');
      console.log(`  ⚠️  [${coin}] 지연 후 가격/캔들 데이터가 유효하지 않아 진입 취소`);
      return null;
    }

    const marketQuoteFreshness = inspectTraderMarketQuote(
      latestTicker,
      coin,
      this.maxCandleAgeSeconds
    );
    if (!marketQuoteFreshness.fresh) {
      this.recordPaperEntryConfirmation(coin, 'cancelled', marketQuoteFreshness.reason);
      this.resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, marketQuoteFreshness.reason);
      console.log(`  ⛔ [${coin}] 지연 후 거래소 시세 신선도 실패: ${marketQuoteFreshness.reason}`);
      return null;
    }

    const candleFreshness = inspectLatestCandleFreshness(candles, {
      candleUnit: this.candleUnit,
      maxAgeSeconds: this.maxCandleAgeSeconds
    });
    this.recordPaperCandleFreshnessObservation(coin, candleFreshness);
    if (!candleFreshness.valid) {
      this.recordPaperCandleFreshnessBlock(candleFreshness.reason, candleFreshness, 'entry_confirmation', coin);
      this.recordPaperEntryConfirmation(coin, 'cancelled', candleFreshness.reason);
      this.resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, candleFreshness.reason);
      console.log(`  ⛔ [${coin}] 지연 후 캔들 신선도 실패: ${candleFreshness.reason}`);
      return null;
    }

    const technicalAnalysis = this.buildTechnicalAnalysis(candles);
    const validation = strategy.validateEntry(technicalAnalysis, latestPrice, decision);
    if (!validation.valid) {
      const reason = validation.reason || 'entry_validation_invalid';
      this.recordPaperEntryConfirmation(coin, 'cancelled', reason);
      this.resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, reason);
      console.log(`  ⛔ [${coin}] 지연 후 반등 무효화: ${validation.reason}`);
      return null;
    }

    this.recordPaperEntryConfirmation(coin, 'confirmed', 'entry_revalidation_passed');
    console.log(`  ✅ [${coin}] 지연 후 반등 유지 - 현재가 ${latestPrice.toLocaleString()}원`);
    return {
      currentPrice: latestPrice,
      technicalAnalysis,
      delayMs,
      candleFreshness,
      marketQuoteFreshness
    };
  }

  /**
   * 주문 실행
   * @param {string} coin - 코인
   * @param {Object} decision - 매매 결정
   * @param {number} currentPrice - 현재가
   * @param {number} krwBalance - KRW 잔액
   * @param {number} coinBalance - 코인 잔액
   * @param {number} currentPositions - 현재 포지션 수
   * @param {Array} coinAnalyses - 전체 코인 분석 결과 (리밸런싱용)
   */
  async executeOrder(...args) {
    const execute = async () => {
      if (this._orderInProgress) return null;
      this._orderInProgress = true;
      try {
        return await this._executeOrder(...args);
      } finally {
        this._orderInProgress = false;
      }
    };
    return this.dryRun ? this.withPortfolioMutationLock(execute) : execute();
  }

  canExecuteLiveOrder(coin, decision) {
    if (this.dryRun) return true;
    if (!this._liveAccountStateKnown) return false;
    if (this._liveEvidenceBlockedMarkets.has(coin)) return false;
    if (this._liveOrderStateUnknownMarkets.has(coin) || this._livePendingOrderMarkets.has(coin)) return false;

    const riskMonitorExit = (this._riskMonitorProtectiveOnly || this._manualRiskProtection) &&
      this._riskMonitorExitInProgress &&
      decision?.action === 'SELL';
    const verifiedAt = Number(this._liveVerifiedOrderMarkets.get(coin));
    if (!riskMonitorExit && (!Number.isFinite(verifiedAt) || Date.now() - verifiedAt >= 10 * 60 * 1000)) {
      return false;
    }
    return this._liveExchangeStateKnown || (riskMonitorExit && !this._exchangeSyncPromise);
  }

  async _executeOrder(
    coin,
    decision,
    currentPrice,
    krwBalance,
    coinBalance,
    currentPositions,
    coinAnalyses = [],
    executionContext = null
  ) {
    if (this._stopRequested) return null;
    if (!this.canExecuteLiveOrder(coin, decision)) return null;
    if (this._entriesPaused && !(
      (this._riskMonitorProtectiveOnly || this._manualRiskProtection) &&
      this._riskMonitorExitInProgress &&
      decision?.action === 'SELL'
    )) return null;
    if (!this.dryRun && (this.liveExecutionEvidenceWriteError || this.liveExecutionEvidenceDataError)) {
      const reason = this.liveExecutionEvidenceWriteError || this.liveExecutionEvidenceDataError;
      console.error(`🛑 live execution evidence가 불완전해 신규 주문을 차단합니다: ${reason}`);
      return null;
    }
    const strategy = this.getStrategy(coin);

    if (decision.action === 'HOLD') {
      return;
    }

    if (decision.action === 'BUY') {
      const signalStrength = decision.signalStrength || { level: 'WEAK', multiplier: 1 };
      const isStrongSignal = ['STRONG', 'VERY_STRONG'].includes(signalStrength.level);
      let entryDelayMs = null;

      // 이미 포지션이 있는 경우
      if (strategy.currentPosition) {
        if (!this.allowAveraging) {
          this.resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, 'strict_position_already_open');
          console.log(`\n⚠️  [${coin}] 이미 포지션 보유중 (추가 매수 비활성화)`);
          return;
        }
        // 추가 매수는 STRONG 이상 신호에서만 허용
        if (!isStrongSignal) {
          this.resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, 'averaging_signal_not_strong');
          console.log(`\n⚠️  [${coin}] 포지션 보유중 - 추가 매수는 STRONG 이상 신호 필요 (현재: ${signalStrength.level})`);
          return;
        }
        console.log(`\n📈 [${coin}] 포지션 보유중 - 강한 신호로 추가 매수 진행`);
      }

      if (!strategy.currentPosition && currentPositions >= this.maxPositions) {
        this.resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, 'max_positions_reached');
        console.log(`\n⚠️  [${coin}] 최대 포지션 수(${this.maxPositions}개)에 도달하여 진입하지 않음`);
        return;
      }

      if (!strategy.currentPosition && this.isStrictEntryBlockedByLossCircuit()) {
        const circuit = this.getLossCircuitBreakerStatus('strict');
        const remainingMinutes = Math.ceil((circuit.cooldownRemainingMs || 0) / 60000);
        this.recordPaperCircuitBlock();
        this.resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, 'loss_circuit_breaker');
        console.log(`\n🛑 [${coin}] 전역 손실 회로차단기 쿨다운 중 - 신규 진입 차단 (${remainingMinutes}분 남음)`);
        return;
      }

      const entrySignalKey = decision.entrySignalKey || decision.details?.rebound?.signalKey;
      if (!strategy.currentPosition && this.isScalpingMode &&
        this.isStrictEntryBlockedBySignalWindow(entrySignalKey)) {
        const signalWindow = this.getStrictSignalWindowStatus();
        this.recordPaperSignalWindowBlock();
        this.resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, 'signal_window_limit');
        console.log(`\n🧭 [${coin}] 동일 signal window 동시 진입 상한 도달 - 신규 진입 차단 (${signalWindow.lastEntryCount}/${signalWindow.maxEntriesPerSignalWindow})`);
        return;
      }

      if (this.isScalpingMode && this.config.marketRegimeEnabled === true &&
        decision.details?.marketRegime?.confirmed !== true) {
        this.recordPaperMarketRegimeBlock();
        this.resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, 'market_regime_blocked');
        const regime = decision.details?.marketRegime;
        console.log(`\n⛔ [${coin}] 시장 regime gate 미통과 - breadth ${Number(regime?.breadth || 0).toFixed(2)} / 평균 ${Number(regime?.averageReturnPercent || 0).toFixed(2)}%`);
        return;
      }

      // 스캘핑 매수는 신호 발생 시점의 가격을 사용하지 않고,
      // 1~5초 지연 후 ticker/완료 캔들을 다시 확인한 뒤 진행한다.
      if (this.isScalpingMode) {
        const snapshotMarketData = executionContext?.marketDataByCoin instanceof Map
          ? executionContext.marketDataByCoin.get(coin)
          : executionContext?.marketDataByCoin?.[coin];
        const confirmation = await this.confirmScalpingEntry(
          coin,
          decision,
          strategy,
          snapshotMarketData
            ? {
                ...snapshotMarketData,
                sharedSnapshot: executionContext.sharedSnapshot === true,
                skipConfirmationDelay: executionContext.skipConfirmationDelay === true
              }
            : null
        );
        if (!confirmation) return;

        // 지연 중 수동 주문/다른 경로에서 포지션이 먼저 생겼다면
        // 스캘핑 모드에서는 추가 매수하지 않는다.
        if (strategy.currentPosition && !this.allowAveraging) {
          this.resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, 'position_created_during_confirmation');
          console.log(`  ⛔ [${coin}] 지연 중 포지션이 생성되어 중복 진입 취소`);
          return;
        }

        currentPrice = confirmation.currentPrice;
        entryDelayMs = confirmation.delayMs;
        const latestAccounts = await this.getAccountInfo();
        krwBalance = this.getKRWBalance(latestAccounts);
        currentPositions = this.getCurrentPositionCount();
        if (!strategy.currentPosition && currentPositions >= this.maxPositions) {
          this.resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, 'max_positions_reached_after_confirmation');
          console.log(`  ⛔ [${coin}] 지연 중 최대 포지션 수(${this.maxPositions}개)에 도달하여 진입 취소`);
          return;
        }
      }

      // 동적 투자금액 계산 (시드머니 + 신호 강도 기반)
      const totalAssets = await this.calculateTotalAssets(executionContext?.priceMap);
      const dynamicInvestment = await this.calculateDynamicInvestmentAmount(totalAssets, signalStrength);

      // 잔액 부족 시 강한 신호면 추가 리밸런싱
      if (!this.isScalpingMode && krwBalance < dynamicInvestment && isStrongSignal && currentPositions > 0) {
        console.log(`\n💡 [${coin}] 잔액 부족하지만 강한 신호 - 추가 리밸런싱 검토`);

        const weakestPosition = this.findWeakestPosition(coin, coinAnalyses);
        if (weakestPosition) {
          const soldAmount = await this.sellForRebalancing(weakestPosition, coin);
          if (soldAmount > 0) {
            krwBalance = this.dryRun ? this.virtualPortfolio.krwBalance : soldAmount;
          }
        }
      }

      const maxInvestment = krwBalance * this.portfolioAllocation;
      const investmentAmount = Math.min(
        dynamicInvestment,
        maxInvestment,
        krwBalance * 0.95
      );

      // A LIVE data-gap transition may happen during an awaited confirmation
      // or investment calculation. Recheck immediately before any BUY dispatch.
      if (this._entriesPaused || this._stopRequested) {
        this.resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, 'entries_paused');
        return null;
      }

      const baseInvestment = totalAssets * this.investmentRatio;
      console.log(`  💰 투자금액: ${investmentAmount.toLocaleString()}원`);
      console.log(`     (기본 ${baseInvestment.toLocaleString()}원 × ${signalStrength.multiplier} = ${dynamicInvestment.toLocaleString()}원)`);

      if (investmentAmount < 5000) {
        this.resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, 'investment_below_minimum');
        console.log(`\n⚠️  [${coin}] 매수 불가: 잔액 부족 (${krwBalance.toLocaleString()}원)`);
        return;
      }

      // A sealed paper session applies its configured adverse fill-cost model.
      const paperEntryCostModel = this.getStrictPaperExecutionCostModel();
      const FEE_RATE = paperEntryCostModel?.tradingFeeRate ?? 0.0005;
      const fee = investmentAmount * FEE_RATE;
      const actualInvestment = investmentAmount - fee;
      const entryFillPrice = currentPrice * (1 + (paperEntryCostModel?.slippageRate || 0));
      const volume = actualInvestment / entryFillPrice;

      if (this.dryRun) {
        console.log(`\n🧪 [모의투자] ${coin} 매수 주문`);
        console.log(`  금액: ${investmentAmount.toLocaleString()} 원`);
        console.log(`  수수료: ${fee.toLocaleString()} 원 (${(FEE_RATE * 100).toFixed(2)}%)`);
        console.log(`  실투자: ${actualInvestment.toLocaleString()} 원`);
        console.log(`  수량: ${volume.toFixed(8)}`);
        console.log(`  가격: ${entryFillPrice.toLocaleString()} 원`);

        // 가상 포트폴리오 업데이트 - 마이너스 방지 체크
        const currentBalance = this.virtualPortfolio.krwBalance || 0;
        if (currentBalance < investmentAmount) {
          this.resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, 'balance_insufficient');
          console.log(`\n⚠️  [${coin}] 매수 취소: 실시간 잔액 부족 (${currentBalance.toLocaleString()}원 < ${investmentAmount.toLocaleString()}원)`);
          return;
        }
        this.virtualPortfolio.krwBalance = Math.max(0, currentBalance - investmentAmount);
        const existing = this.virtualPortfolio.holdings.get(coin) || { amount: 0, avgPrice: 0, entryTime: null };
        const newAmount = existing.amount + volume;
        const newAvgPrice = ((existing.amount * existing.avgPrice) + (volume * entryFillPrice)) / newAmount;
        this.virtualPortfolio.holdings.set(coin, {
          amount: newAmount,
          avgPrice: newAvgPrice,
          entryTime: existing.entryTime || new Date().toISOString() // 최초 매수 시간 유지
        });

        strategy.openPosition(entryFillPrice, volume, 'BUY');
        if (paperEntryCostModel && strategy.currentPosition) {
          strategy.currentPosition.paperExecutionCostModel = paperEntryCostModel.version;
          strategy.currentPosition.paperExecutionSlippageRate = paperEntryCostModel.slippageRate;
          strategy.currentPosition.paperExecutionTradingFeeRate = paperEntryCostModel.tradingFeeRate;
          strategy.currentPosition.paperObservedEntryPrice = currentPrice;
          strategy.currentPosition.paperEntryFee = fee;
          strategy.currentPosition.paperInvestmentAmount = investmentAmount;
        }
        this.decorateEntryPosition(strategy, decision, {
          executionPrice: currentPrice,
          delayMs: entryDelayMs
        });
        this.recordStrictSignalWindowEntry(decision.entrySignalKey || decision.details?.rebound?.signalKey);
        this.saveVirtualPortfolio();
        console.log(`  잔여 KRW: ${this.virtualPortfolio.krwBalance.toLocaleString()} 원`);

        // 매수 알림
        this.notifyTrade({
          type: 'BUY',
          coin,
          price: entryFillPrice,
          amount: investmentAmount,
          volume,
          reason: decision.reason,
          signalStrength: signalStrength.level,
          mode: 'DRY_RUN'
        });
      } else {
        console.log(`\n💵 [${coin}] 실제 매수 주문 실행`);
        console.log(`  예상 가격: ${currentPrice.toLocaleString()} 원`);
        console.log(`  투자 금액: ${investmentAmount.toLocaleString()} 원`);

        const orderResult = await this.submitLiveOrder(coin, 'bid', investmentAmount, null, 'price');
        const orderId = orderResult?.data?.uuid || null;
        const submissionEvidenceRecorded = this.recordLiveExecutionEvidence(this.createLiveExecutionEvidence({
          eventType: orderResult?.success === true ? 'ORDER_SUBMITTED' : 'ORDER_REJECTED',
          orderId,
          market: coin,
          side: 'bid',
          orderType: 'price',
          requested: { amount: investmentAmount },
          referencePrice: currentPrice,
          signal: {
            signalKey: decision.entrySignalKey || decision.details?.rebound?.signalKey,
            signalTime: decision.details?.rebound?.candleTime,
            referencePrice: decision.entryReferencePrice ?? decision.details?.rebound?.referencePrice,
            entryDelayMs
          },
          error: orderResult?.success === true ? null : orderResult?.error?.message
        }));

        if (orderResult?.success === true && orderId) {
          console.log(`  📝 주문 접수: ${orderId}`);

          // 주문 체결 대기 (최대 30초)
          console.log(`  ⏳ 체결 대기 중...`);
          const fillResult = await this.waitForLiveOrderFill(coin, orderId, 30000, 1000);

          if (fillResult.filled) {
            const filledOrder = fillResult.order;
            const fillEvidenceRecorded = this.recordLiveExecutionEvidence(this.createLiveExecutionEvidence({
              eventType: fillResult.partial ? 'FILL_PARTIAL' : 'FILL_OBSERVED',
              orderId,
              market: coin,
              side: 'bid',
              orderType: 'price',
              requested: { amount: investmentAmount },
              referencePrice: currentPrice,
              signal: {
                signalKey: decision.entrySignalKey || decision.details?.rebound?.signalKey,
                signalTime: decision.details?.rebound?.candleTime,
                referencePrice: decision.entryReferencePrice ?? decision.details?.rebound?.referencePrice,
                entryDelayMs
              },
              order: filledOrder,
              fillResult
            }));
            if (!submissionEvidenceRecorded || !fillEvidenceRecorded || !hasCompleteLiveFillResult(fillResult)) {
              if (!hasCompleteLiveFillResult(fillResult)) {
                this.liveExecutionEvidenceDataError = 'live fill accounting fields are incomplete';
              }
              if (fillResult.partial && !(await this.cancelLiveOrderIfOpen(orderId, filledOrder))) {
                this.liveExecutionEvidenceDataError = 'live partial order cancellation failed';
              }
              console.error(`🛑 [${coin}] live fill evidence가 불완전해 전략 포지션을 확정하지 않습니다.`);
              return;
            }
            const settlementEvidence = await this.recordLiveSettlementReadback({
              orderId,
              market: coin,
              side: 'bid',
              orderType: 'price',
              requested: { amount: investmentAmount },
              referencePrice: currentPrice,
              order: filledOrder,
              fillResult
            });
            if (!settlementEvidence.recorded) {
              this.liveExecutionEvidenceDataError = 'live settlement evidence write failed';
              console.error(`🛑 [${coin}] settlement evidence가 저장되지 않아 전략 포지션을 확정하지 않습니다.`);
              return;
            }
            const actualVolume = Number(filledOrder.executed_volume);

            // Upbit API는 avg_price 필드로 평균 체결가를 제공
            const actualPrice = Number(filledOrder.avg_price);
            const actualAmount = actualVolume * actualPrice;
            const paidFee = Number(filledOrder.paid_fee);

            // 슬리피지 계산
            const slippage = ((actualPrice - currentPrice) / currentPrice * 100).toFixed(2);

            console.log(`  ✅ 체결 완료!`);
            console.log(`    실제 체결가: ${actualPrice.toLocaleString()} 원`);
            console.log(`    체결 수량: ${actualVolume.toFixed(8)}`);
            console.log(`    체결 금액: ${actualAmount.toLocaleString()} 원`);
            console.log(`    수수료: ${paidFee.toLocaleString()} 원`);
            console.log(`    슬리피지: ${slippage}%`);

            if (fillResult.partial) {
              console.log(`  ⚠️  부분 체결됨 - 잔여: ${filledOrder.remaining_volume}`);
              if (!(await this.cancelLiveOrderIfOpen(orderId, filledOrder))) {
                this.liveExecutionEvidenceDataError = 'live partial order cancellation failed';
                return;
              }
            }

            // 실제 체결 데이터로 포지션 오픈
            strategy.openPosition(actualPrice, actualVolume, 'BUY');
            this.decorateEntryPosition(strategy, decision, {
              executionPrice: actualPrice,
              delayMs: entryDelayMs
            });
            this.recordStrictSignalWindowEntry(decision.entrySignalKey || decision.details?.rebound?.signalKey);

            // 매수 알림 (실제 체결 데이터)
            this.notifyTrade({
              type: 'BUY',
              coin,
              price: actualPrice,
              amount: actualVolume * actualPrice,
              volume: actualVolume,
              reason: decision.reason,
              signalStrength: signalStrength.level,
              mode: 'LIVE',
              orderId,
              slippage: parseFloat(slippage)
            });
          } else {
            const fillEvidenceRecorded = this.recordLiveExecutionEvidence(this.createLiveExecutionEvidence({
              eventType: 'FILL_NOT_OBSERVED',
              orderId,
              market: coin,
              side: 'bid',
              orderType: 'price',
              requested: { amount: investmentAmount },
              referencePrice: currentPrice,
              signal: {
                signalKey: decision.entrySignalKey || decision.details?.rebound?.signalKey,
                signalTime: decision.details?.rebound?.candleTime,
                referencePrice: decision.entryReferencePrice ?? decision.details?.rebound?.referencePrice,
                entryDelayMs
              },
              order: fillResult.order,
              fillResult,
              error: fillResult.error
            }));
            if (!fillEvidenceRecorded) {
              console.error(`🛑 [${coin}] 미체결 evidence 저장 실패를 기록하고 주문 취소 결과를 별도 확인해야 합니다.`);
            }
            // 미체결 - 주문 취소 시도
            console.log(`  ⚠️  체결 실패: ${fillResult.error}`);
            console.log(`  🔄 주문 취소 시도...`);

            try {
              await this.upbit.cancelOrder(orderId, { priority: 'risk' });
              console.log(`  ✅ 주문 취소됨`);
            } catch (cancelError) {
              console.error(`  ❌ 주문 취소 실패: ${cancelError.message}`);
              console.log(`  ⚠️  수동 확인 필요 - 주문 ID: ${orderId}`);
            }
          }
        } else {
          console.error(`  ❌ 주문 실패: ${orderResult.error.message} (${orderResult.error.code})`);
          // 주문 실패 시 포지션 열지 않음 - 상태 일관성 유지
        }
      }
    }

    if (decision.action === 'SELL') {
      if (!strategy.currentPosition && coinBalance === 0) {
        console.log(`\n⚠️  [${coin}] 매도 불가: 보유 수량 없음`);
        return;
      }

      const sellVolume = strategy.currentPosition
        ? strategy.currentPosition.amount
        : coinBalance;

      // 최소 매도 금액 체크 (5000원)
      const paperExitCostModel = this.getStrictPaperExecutionCostModel(strategy.currentPosition);
      const exitFillPrice = currentPrice * (1 - (paperExitCostModel?.slippageRate || 0));
      const estimatedSellAmount = sellVolume * exitFillPrice;
      if (estimatedSellAmount < 5000) {
        console.log(`\n⚠️  [${coin}] 매도 불가: 최소 매도금액(5,000원) 미만 (${estimatedSellAmount.toLocaleString()}원)`);
        return;
      }

      if (this.dryRun) {
        const FEE_RATE = paperExitCostModel?.tradingFeeRate ?? 0.0005;
        const fee = estimatedSellAmount * FEE_RATE;
        const actualReceived = estimatedSellAmount - fee;

        console.log(`\n🧪 [모의투자] ${coin} 매도 주문`);
        console.log(`  수량: ${sellVolume.toFixed(8)}`);
        console.log(`  예상 금액: ${estimatedSellAmount.toLocaleString()} 원`);
        console.log(`  수수료: ${fee.toLocaleString()} 원 (${(FEE_RATE * 100).toFixed(2)}%)`);
        console.log(`  실수령: ${actualReceived.toLocaleString()} 원`);

        // 가상 포트폴리오 업데이트 (수수료 차감)
        this.virtualPortfolio.krwBalance += actualReceived;

        const holding = this.virtualPortfolio.holdings.get(coin);
        if (holding) {
          holding.amount -= sellVolume;
          if (holding.amount <= 0.00000001) {
            this.virtualPortfolio.holdings.delete(coin);
          } else {
            this.virtualPortfolio.holdings.set(coin, holding);
          }
        }

        // 수익률 계산
        const paperEntryFee = paperExitCostModel ? Number(strategy.currentPosition?.paperEntryFee) : null;
        const closeOptions = paperEntryFee !== null && Number.isFinite(paperEntryFee) && paperEntryFee >= 0
          ? { buyFee: paperEntryFee, tradingFeeRate: paperExitCostModel.tradingFeeRate }
          : {};
        if (paperExitCostModel && strategy.currentPosition) {
          strategy.currentPosition.paperObservedExitPrice = currentPrice;
        }
        const closedTrade = strategy.closePosition(exitFillPrice, decision.reason, closeOptions);
        const profitPercent = Number.isFinite(Number(closedTrade?.profitPercent))
          ? Number(closedTrade.profitPercent).toFixed(2)
          : '0.00';
        this.recordPaperStrictTrade(coin, closedTrade, 'CLOSE');
        this.saveVirtualPortfolio();
        console.log(`  잔여 KRW: ${this.virtualPortfolio.krwBalance.toLocaleString()} 원`);

        // 매도 알림
        this.notifyTrade({
          type: 'SELL',
          coin,
          price: exitFillPrice,
          amount: estimatedSellAmount,
          volume: sellVolume,
          reason: decision.reason,
          profitPercent,
          mode: 'DRY_RUN'
        });
      } else {
        console.log(`\n💰 [${coin}] 실제 매도 주문 실행`);
        console.log(`  예상 가격: ${currentPrice.toLocaleString()} 원`);
        console.log(`  매도 수량: ${sellVolume.toFixed(8)}`);

        const orderResult = await this.submitLiveOrder(coin, 'ask', sellVolume, null, 'market');
        const orderId = orderResult?.data?.uuid || null;
        const submissionEvidenceRecorded = this.recordLiveExecutionEvidence(this.createLiveExecutionEvidence({
          eventType: orderResult?.success === true ? 'ORDER_SUBMITTED' : 'ORDER_REJECTED',
          orderId,
          market: coin,
          side: 'ask',
          orderType: 'market',
          requested: { volume: sellVolume },
          referencePrice: currentPrice,
          error: orderResult?.success === true ? null : orderResult?.error?.message
        }));

        if (orderResult?.success === true && orderId) {
          console.log(`  📝 주문 접수: ${orderId}`);

          // 주문 체결 대기 (최대 30초)
          console.log(`  ⏳ 체결 대기 중...`);
          const fillResult = await this.waitForLiveOrderFill(coin, orderId, 30000, 1000);

          if (fillResult.filled) {
            const filledOrder = fillResult.order;
            const fillEvidenceRecorded = this.recordLiveExecutionEvidence(this.createLiveExecutionEvidence({
              eventType: fillResult.partial ? 'FILL_PARTIAL' : 'FILL_OBSERVED',
              orderId,
              market: coin,
              side: 'ask',
              orderType: 'market',
              requested: { volume: sellVolume },
              referencePrice: currentPrice,
              order: filledOrder,
              fillResult
            }));
            if (!submissionEvidenceRecorded || !fillEvidenceRecorded || !hasCompleteLiveFillResult(fillResult)) {
              if (!hasCompleteLiveFillResult(fillResult)) {
                this.liveExecutionEvidenceDataError = 'live fill accounting fields are incomplete';
              }
              if (fillResult.partial && !(await this.cancelLiveOrderIfOpen(orderId, filledOrder))) {
                this.liveExecutionEvidenceDataError = 'live partial order cancellation failed';
              }
              console.error(`🛑 [${coin}] live fill evidence가 불완전해 전략 포지션을 확정하지 않습니다.`);
              return;
            }
            const settlementEvidence = await this.recordLiveSettlementReadback({
              orderId,
              market: coin,
              side: 'ask',
              orderType: 'market',
              requested: { volume: sellVolume },
              referencePrice: currentPrice,
              order: filledOrder,
              fillResult
            });
            if (!settlementEvidence.recorded) {
              this.liveExecutionEvidenceDataError = 'live settlement evidence write failed';
              console.error(`🛑 [${coin}] settlement evidence가 저장되지 않아 전략 포지션을 확정하지 않습니다.`);
              return;
            }
            const actualVolume = Number(filledOrder.executed_volume);

            // Upbit API는 avg_price 필드로 평균 체결가를 제공
            const actualPrice = Number(filledOrder.avg_price);
            const actualAmount = actualVolume * actualPrice;
            const paidFee = Number(filledOrder.paid_fee);

            // 슬리피지 계산
            const slippage = ((actualPrice - currentPrice) / currentPrice * 100).toFixed(2);

            // 수익률 계산 (실제 체결가 기준)
            const entryPrice = strategy.currentPosition?.entryPrice || currentPrice;
            const grossProfit = (actualPrice - entryPrice) * actualVolume;
            const netProfit = grossProfit - paidFee; // 매도 수수료 차감
            const profitPercent = ((actualPrice - entryPrice) / entryPrice * 100).toFixed(2);

            console.log(`  ✅ 체결 완료!`);
            console.log(`    실제 체결가: ${actualPrice.toLocaleString()} 원`);
            console.log(`    체결 수량: ${actualVolume.toFixed(8)}`);
            console.log(`    체결 금액: ${actualAmount.toLocaleString()} 원`);
            console.log(`    수수료: ${paidFee.toLocaleString()} 원`);
            console.log(`    슬리피지: ${slippage}%`);
            console.log(`    순수익: ${profitPercent}% (${netProfit >= 0 ? '+' : ''}${netProfit.toLocaleString()}원)`);

            if (fillResult.partial) {
              const remainingVolume = parseFloat(filledOrder.remaining_volume || 0);
              console.log(`  ⚠️  부분 체결됨 - 미체결 수량: ${remainingVolume.toFixed(8)}`);
              // 부분 체결 시 남은 수량 처리 필요 알림
              console.log(`  ⚠️  미체결 수량은 수동 확인 필요`);
            }

            if (fillResult.partial && !(await this.cancelLiveOrderIfOpen(orderId, filledOrder))) {
              this.liveExecutionEvidenceDataError = 'live partial order cancellation failed';
              return;
            }

            // 실제 체결 데이터로 포지션을 갱신한다. 부분 체결은 잔여
            // 포지션을 유지하고, 취소 후 확인된 수량만 기록한다.
            const isFullSell = !fillResult.partial ||
              actualVolume >= strategy.currentPosition?.amount - 0.00000001;
            const closedTrade = isFullSell
              ? strategy.closePosition(actualPrice, decision.reason)
              : strategy.recordPartialSell(actualPrice, actualVolume, decision.reason);
            this.registerRuntimeLoss(closedTrade);

            // 매도 알림 (실제 체결 데이터)
            this.notifyTrade({
              type: 'SELL',
              coin,
              price: actualPrice,
              amount: actualAmount,
              volume: actualVolume,
              reason: decision.reason,
              profitPercent: parseFloat(profitPercent),
              profitAmount: netProfit,
              fee: paidFee,
              mode: 'LIVE',
              orderId,
              slippage: parseFloat(slippage)
            });
          } else {
            const fillEvidenceRecorded = this.recordLiveExecutionEvidence(this.createLiveExecutionEvidence({
              eventType: 'FILL_NOT_OBSERVED',
              orderId,
              market: coin,
              side: 'ask',
              orderType: 'market',
              requested: { volume: sellVolume },
              referencePrice: currentPrice,
              order: fillResult.order,
              fillResult,
              error: fillResult.error
            }));
            if (!fillEvidenceRecorded) {
              console.error(`🛑 [${coin}] 미체결 evidence 저장 실패를 기록하고 주문 상태를 별도 확인해야 합니다.`);
            }
            // 미체결 - 마켓 주문이므로 이 경우는 드묾
            console.log(`  ⚠️  체결 실패: ${fillResult.error}`);
            console.log(`  ⚠️  포지션 상태 유지됨 - 수동 확인 필요`);
            console.log(`  ⚠️  주문 ID: ${orderId}`);
          }
        } else {
          console.error(`  ❌ 주문 실패: ${orderResult.error.message} (${orderResult.error.code})`);
          // 주문 실패 시 포지션 유지 - 수동 확인 필요
          console.log(`  ⚠️  포지션 상태 유지됨 - 수동 확인 필요`);
        }
      }
    }
  }

  /**
   * 현재 포지션 수 조회
   */
  getCurrentPositionCount() {
    let count = 0;
    for (const strategy of this.strategies.values()) {
      if (strategy.currentPosition) {
        count++;
      }
    }
    return count;
  }

  /**
   * 가장 약한 포지션 찾기 (리밸런싱용)
   * @param {string} excludeCoin - 제외할 코인
   * @param {Array} coinAnalyses - 코인별 분석 결과
   * @returns {Object|null} 가장 약한 포지션 정보
   */
  findWeakestPosition(excludeCoin, coinAnalyses) {
    let weakest = null;
    let lowestScore = Infinity;

    // 최소 보유 시간: 10분 (리밸런싱 루프 방지 - 수수료 손실 최소화)
    const MIN_HOLD_TIME_MS = 10 * 60 * 1000;

    // 리밸런싱 쿨다운: 마지막 리밸런싱 후 5분 대기
    const REBALANCE_COOLDOWN_MS = 5 * 60 * 1000;
    if (this.lastRebalanceTime && (Date.now() - this.lastRebalanceTime) < REBALANCE_COOLDOWN_MS) {
      const remainingCooldown = Math.ceil((REBALANCE_COOLDOWN_MS - (Date.now() - this.lastRebalanceTime)) / 1000);
      console.log(`  ⏳ 리밸런싱 쿨다운 중 (${remainingCooldown}초 남음)`);
      return null;
    }

    for (const [coin, strategy] of this.strategies.entries()) {
      if (coin === excludeCoin || !strategy.currentPosition) continue;

      // 최소 보유 시간 체크 - 방금 산 포지션은 리밸런싱 대상에서 제외
      const holdTime = Date.now() - new Date(strategy.currentPosition.entryTime).getTime();
      if (holdTime < MIN_HOLD_TIME_MS) {
        console.log(`  ⏳ [${coin}] 최소 보유 시간 미달 (${Math.floor(holdTime / 1000)}초/${MIN_HOLD_TIME_MS / 1000}초)`);
        continue;
      }

      // 해당 코인의 분석 결과 찾기
      const analysis = coinAnalyses.find(a => a.coin === coin);
      const score = analysis ? parseFloat(analysis.decision.scores.total) : 50;

      // 현재 수익률 계산
      const currentPrice = analysis?.currentPrice || strategy.currentPosition.entryPrice;
      const profitPercent = ((currentPrice - strategy.currentPosition.entryPrice) / strategy.currentPosition.entryPrice) * 100;

      // 점수가 낮고 수익률도 좋지 않은 포지션 우선
      const weaknessScore = score - (profitPercent * 0.5); // 점수 - (수익률 가중치)

      if (weaknessScore < lowestScore) {
        lowestScore = weaknessScore;
        weakest = {
          coin,
          strategy,
          score,
          profitPercent,
          currentPrice,
          position: strategy.currentPosition
        };
      }
    }

    return weakest;
  }

  /**
   * 리밸런싱을 위한 포지션 매도
   * @param {Object} weakestPosition - 매도할 포지션 정보
   * @param {string} targetCoin - 매수할 코인 (로그용)
   */
  async sellForRebalancing(weakestPosition, targetCoin) {
    const { coin, strategy, currentPrice, profitPercent } = weakestPosition;

    // 리밸런싱 수익성 체크: 손실 중인 포지션만 교체 (수수료 0.1% 고려)
    // 수수료로 인한 최소 손실: 매도 0.05% + 매수 0.05% = 0.1%
    const MIN_LOSS_FOR_REBALANCE = -0.5; // 최소 -0.5% 손실 중이어야 리밸런싱
    if (profitPercent > MIN_LOSS_FOR_REBALANCE) {
      console.log(`\n⛔ [리밸런싱 취소] ${coin} 수익률 ${profitPercent.toFixed(2)}%로 양호함`);
      console.log(`  리밸런싱은 ${MIN_LOSS_FOR_REBALANCE}% 이하 손실 포지션만 대상`);
      return 0;
    }

    console.log(`\n🔄 [리밸런싱] ${coin} 매도 → ${targetCoin} 매수 준비`);
    console.log(`  ${coin} 현재 수익률: ${profitPercent.toFixed(2)}%`);

    const sellVolume = strategy.currentPosition.amount;

    if (this.dryRun) {
      // 수수료 계산 (0.05%)
      const FEE_RATE = 0.0005;
      const sellAmount = sellVolume * currentPrice;
      const fee = sellAmount * FEE_RATE;
      const actualReceived = sellAmount - fee;

      console.log(`  🧪 [모의투자] ${coin} 리밸런싱 매도`);
      console.log(`    수량: ${sellVolume.toFixed(8)}`);
      console.log(`    예상 금액: ${sellAmount.toLocaleString()} 원`);
      console.log(`    수수료: ${fee.toLocaleString()} 원 (0.05%)`);
      console.log(`    실수령: ${actualReceived.toLocaleString()} 원`);

      // 가상 포트폴리오 업데이트 (수수료 차감)
      this.virtualPortfolio.krwBalance += actualReceived;

      const holding = this.virtualPortfolio.holdings.get(coin);
      if (holding) {
        holding.amount -= sellVolume;
        if (holding.amount <= 0.00000001) {
          this.virtualPortfolio.holdings.delete(coin);
        }
      }

      strategy.closePosition(currentPrice, `리밸런싱: ${targetCoin} 강한 매수 신호`);
      this.saveVirtualPortfolio();

      // 리밸런싱 쿨다운 시간 기록
      this.lastRebalanceTime = Date.now();

      return actualReceived;
    } else {
      console.log(`  💰 [실전] ${coin} 리밸런싱 매도 실행`);
      console.log(`    예상 가격: ${currentPrice.toLocaleString()} 원`);
      console.log(`    매도 수량: ${sellVolume.toFixed(8)}`);

      const orderResult = await this.submitLiveOrder(coin, 'ask', sellVolume, null, 'market');
      const orderId = orderResult?.data?.uuid || null;
      const submissionEvidenceRecorded = this.recordLiveExecutionEvidence(this.createLiveExecutionEvidence({
        eventType: orderResult?.success === true ? 'ORDER_SUBMITTED' : 'ORDER_REJECTED',
        orderId,
        market: coin,
        side: 'ask',
        orderType: 'market',
        requested: { volume: sellVolume },
        referencePrice: currentPrice,
        error: orderResult?.success === true ? null : orderResult?.error?.message
      }));

      if (orderResult?.success === true && orderId) {
        console.log(`    📝 주문 접수: ${orderId}`);

        // 주문 체결 대기 (최대 30초)
        console.log(`    ⏳ 체결 대기 중...`);
        const fillResult = await this.waitForLiveOrderFill(coin, orderId, 30000, 1000);

        if (fillResult?.filled === true) {
          const filledOrder = fillResult.order;
          const fillEvidenceRecorded = this.recordLiveExecutionEvidence(this.createLiveExecutionEvidence({
            eventType: fillResult.partial ? 'FILL_PARTIAL' : 'FILL_OBSERVED',
            orderId,
            market: coin,
            side: 'ask',
            orderType: 'market',
            requested: { volume: sellVolume },
            referencePrice: currentPrice,
            order: filledOrder,
            fillResult
          }));
          if (!submissionEvidenceRecorded || !fillEvidenceRecorded || !hasCompleteLiveFillResult(fillResult)) {
            if (!hasCompleteLiveFillResult(fillResult)) {
              this.liveExecutionEvidenceDataError = 'live fill accounting fields are incomplete';
            }
            if (fillResult.partial && !(await this.cancelLiveOrderIfOpen(orderId, filledOrder))) {
              this.liveExecutionEvidenceDataError = 'live partial order cancellation failed';
            }
            console.error(`🛑 [${coin}] 리밸런싱 fill evidence가 불완전해 전략 포지션을 확정하지 않습니다.`);
            return 0;
          }
          const actualVolume = Number(filledOrder.executed_volume);

          // Upbit API는 avg_price 필드로 평균 체결가를 제공
          const actualPrice = Number(filledOrder.avg_price);
          const actualAmount = actualVolume * actualPrice;
          const paidFee = Number(filledOrder.paid_fee);

          const slippage = ((actualPrice - currentPrice) / currentPrice * 100).toFixed(2);

          console.log(`    ✅ 체결 완료!`);
          console.log(`      실제 체결가: ${actualPrice.toLocaleString()} 원`);
          console.log(`      체결 금액: ${actualAmount.toLocaleString()} 원`);
          console.log(`      수수료: ${paidFee.toLocaleString()} 원`);
          console.log(`      슬리피지: ${slippage}%`);

          if (fillResult.partial) {
            console.log(`    ⚠️  부분 체결됨 - 미체결 수량: ${filledOrder.remaining_volume}`);
            if (!(await this.cancelLiveOrderIfOpen(orderId, filledOrder))) {
              this.liveExecutionEvidenceDataError = 'live partial order cancellation failed';
              return 0;
            }
          }

          const isFullSell = !fillResult.partial || actualVolume >= strategy.currentPosition.amount - 0.00000001;
          if (isFullSell) {
            strategy.closePosition(actualPrice, `리밸런싱: ${targetCoin} 강한 매수 신호`);
          } else {
            strategy.recordPartialSell(actualPrice, actualVolume, `리밸런싱: ${targetCoin} 강한 매수 신호`);
          }

          // 리밸런싱 쿨다운 시간 기록
          this.lastRebalanceTime = Date.now();

          // 잔액 확인
          try {
            const accounts = await this.upbit.getAccounts({ priority: 'risk' });
            const krwAccount = accounts.find(acc => acc.currency === 'KRW');
            const assetAccount = accounts.find(acc => acc.currency === coin.split('-')[1]);
            const settlementEvidenceRecorded = this.recordLiveExecutionEvidence(this.createLiveExecutionEvidence({
              eventType: 'SETTLEMENT_READBACK',
              orderId,
              market: coin,
              side: 'ask',
              orderType: 'market',
              requested: { volume: sellVolume },
              referencePrice: currentPrice,
              order: filledOrder,
              fillResult,
              settlementReadback: {
                status: 'observed',
                observedAt: new Date().toISOString(),
                krwBalance: krwAccount?.balance,
                assetBalance: assetAccount?.balance,
                lockedBalance: assetAccount?.locked
              }
            }));
            if (!settlementEvidenceRecorded) {
              this.liveExecutionEvidenceDataError = 'live settlement evidence write failed';
            }
            return krwAccount ? Number(krwAccount.balance) : actualAmount - paidFee;
          } catch (error) {
            console.error(`⚠️ [${coin}] 리밸런싱 wallet readback 실패: ${error.message}`);
            return actualAmount - paidFee;
          }
        } else {
          const fillEvidenceRecorded = this.recordLiveExecutionEvidence(this.createLiveExecutionEvidence({
            eventType: 'FILL_NOT_OBSERVED',
            orderId,
            market: coin,
            side: 'ask',
            orderType: 'market',
            requested: { volume: sellVolume },
            referencePrice: currentPrice,
            order: fillResult?.order,
            fillResult,
            error: fillResult?.error
          }));
          if (!fillEvidenceRecorded || !(await this.cancelLiveOrderIfOpen(orderId, fillResult?.order))) {
            this.liveExecutionEvidenceDataError = 'live unfilled order could not be fully recorded or cancelled';
          }
          console.log(`    ⚠️  체결 실패: ${fillResult.error}`);
          console.log(`    ⚠️  리밸런싱 취소 - 포지션 유지`);
          return 0;
        }
      } else {
        if (!submissionEvidenceRecorded) {
          this.liveExecutionEvidenceDataError = 'live order rejection evidence write failed';
        }
        console.error(`    ❌ 리밸런싱 매도 실패: ${orderResult?.error?.message || 'order_uuid_missing'} (${orderResult?.error?.code || 'unknown'})`);
        return 0;
      }
    }
  }

  /**
   * 포트폴리오 요약
   */
  printPortfolioSummary() {
    console.log('\n' + '='.repeat(80));
    console.log('📊 포트폴리오 요약');
    console.log('='.repeat(80));

    for (const coin of this.targetCoins) {
      const strategy = this.getStrategy(coin);
      const stats = strategy.getStatistics();

      console.log(`\n[${coin}]`);

      if (strategy.currentPosition) {
        console.log(`  📍 포지션: 보유중`);
        console.log(`    진입가: ${strategy.currentPosition.entryPrice.toLocaleString()} 원`);
        console.log(`    수량: ${strategy.currentPosition.amount.toFixed(8)}`);
      } else {
        console.log(`  📍 포지션: 없음`);
      }

      if (stats.totalTrades > 0) {
        console.log(`  거래 통계:`);
        console.log(`    총 거래: ${stats.totalTrades}회`);
        console.log(`    승률: ${stats.winRate}`);
        console.log(`    총 손익: ${stats.totalProfit}`);
      }
    }

    console.log('\n' + '='.repeat(80));
  }

  /**
   * 뉴스 업데이트
   */
  async updateNews() {
    const now = Date.now();
    const newsInterval = this.config.newsCheckInterval || 300000;

    if (!this.lastNewsCheck || (now - this.lastNewsCheck) > newsInterval) {
      console.log('\n📡 뉴스 업데이트 중...');
      this.newsData = await this.newsMonitor.collectAndAnalyzeNews();
      this.lastNewsCheck = now;

      const urgentNews = this.newsMonitor.detectUrgentNews(this.newsData);
      if (urgentNews.length > 0) {
        console.log('\n🚨 긴급 뉴스 감지!');
        urgentNews.slice(0, 3).forEach((news, i) => {
          console.log(`  ${i + 1}. ${news.title}`);
        });
      }
    }
  }

  /**
   * 계좌 정보 조회
   */
  async getAccountInfo() {
    if (this.dryRun) {
      // 가상 포트폴리오에서 잔액 반환
      const accounts = [
        { currency: 'KRW', balance: String(this.virtualPortfolio.krwBalance), locked: '0', avg_buy_price: '0' }
      ];

      // 보유 코인 추가
      for (const [coin, holding] of this.virtualPortfolio.holdings.entries()) {
        const coinSymbol = coin.split('-')[1];
        accounts.push({
          currency: coinSymbol,
          balance: String(holding.amount),
          locked: '0',
          avg_buy_price: String(holding.avgPrice)
        });
      }

      return accounts;
    }
    return await this.upbit.getAccounts({ priority: 'risk' });
  }

  /**
   * KRW 잔액 조회 (사용 가능 금액만)
   */
  getKRWBalance(accounts) {
    const krwAccount = accounts.find(acc => acc.currency === 'KRW');
    if (!krwAccount) return 0;
    // balance는 사용 가능한 금액, locked는 주문 중인 금액 (별도 관리됨)
    return parseFloat(krwAccount.balance) || 0;
  }

  /**
   * KRW 총 잔액 조회 (locked 포함)
   */
  getKRWTotalBalance(accounts) {
    const krwAccount = accounts.find(acc => acc.currency === 'KRW');
    if (!krwAccount) return 0;

    const balance = parseFloat(krwAccount.balance) || 0;
    const locked = parseFloat(krwAccount.locked) || 0;
    return balance + locked;
  }

  /**
   * 코인 잔액 조회
   */
  getCoinBalance(accounts, market) {
    const coinSymbol = market.split('-')[1];
    const coinAccount = accounts.find(acc => acc.currency === coinSymbol);
    return coinAccount ? parseFloat(coinAccount.balance) : 0;
  }

  /**
   * 대기
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default MultiCoinTrader;
