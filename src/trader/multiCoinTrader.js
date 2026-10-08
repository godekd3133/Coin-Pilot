import { PaperValidationJournal, resolveSignalWindowEntryLimit } from './paperValidationJournal.js';
import { VirtualPortfolioStore } from './virtualPortfolioStore.js';
import { PositionRiskMonitor } from './positionRiskMonitor.js';
import { LiveOrderGateway } from './liveOrderGateway.js';
import { TradingLifecycle } from './tradingLifecycle.js';
import { OrderExecutionEngine } from './orderExecutionEngine.js';
import { TradingCycleRunner } from './tradingCycleRunner.js';
import { PositionRebalancer } from './positionRebalancer.js';
import { PortfolioValuation } from './portfolioValuation.js';
import { createLossCircuitBreakerState } from '../risk/lossCircuitBreaker.js';
import { createExchangeClient } from '../exchange/exchangeFactory.js';
import { envNumber, envString } from '../config/envConfig.js';
import { isPublicMarketDataSource } from '../api/publicMarketDataSource.js';
import {
  getMarketDataAdapterKind,
  UpbitMarketDataAdapter
} from '../market-data/marketDataAdapters.js';
import { comprehensiveAnalysis } from '../analysis/technicalIndicators.js';
import NewsMonitor from '../analysis/newsMonitor.js';
import TradingStrategy from '../strategy/tradingStrategy.js';
import OversoldReactionStrategy from '../strategy/oversoldReactionStrategy.js';
import { resolveMaxCandleAgeSeconds } from '../risk/candleFreshness.js';
import {
  createRiskMonitorState,
  resolveMaxRiskDataGapSeconds
} from '../risk/riskMonitor.js';
import {
  createAnalysisDataHealthState,
  resolveMaxAnalysisDataGapSeconds
} from '../risk/analysisDataHealth.js';

import { inspectLiveExecutionEvidenceFile } from '../research/liveExecutionEvidence.js';
import path from 'path';
import os from 'os';















/**
 * Add legacy strict losses to the global circuit state when an older ledger
 * does not have the new field yet. Existing state is preserved and duplicate
 * timestamps are removed so a process restart cannot count a loss twice.
 */




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
    const configuredStorageMiB = config.paperMinimumStorageMiB ?? envNumber('SCALP_PAPER_MIN_STORAGE_MIB');
    const parsedStorageMiB = Number(configuredStorageMiB);
    this.paperMinimumStorageMiB = Number.isFinite(parsedStorageMiB) && parsedStorageMiB >= 128
      ? parsedStorageMiB
      : 1024;
    this.exchange = config.exchange || 'upbit';
    this.quoteAsset = config.quoteAsset || 'KRW';
    this.upbit = createExchangeClient(config);
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
      : createExchangeClient(config);
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
    this.targetCoins = config.targetCoins || [`${this.quoteAsset}-BTC`, `${this.quoteAsset}-ETH`];

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
      tradingFee: config.tradingFee ?? (this.exchange === 'binance' ? 0.001 : 0.0005),
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
    // index.js가 부착하는 자동 복구 감시자와 LIVE 검증 리포트 리프레셔.
    // 테스트/스크립트에서는 null이다.
    this.autoRecovery = null;
    this.liveValidationRefresher = null;

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
      envString('DRY_PORTFOLIO_FILE') ||
      (testStoragePrefix ? `${testStoragePrefix}.dry_portfolio.json` : 'dry_portfolio.json');
    this.paperValidationFile = config.paperValidationFile ||
      envString('PAPER_VALIDATION_FILE') ||
      (testStoragePrefix ? `${testStoragePrefix}.paper_validation.json` : 'paper_validation.json');
    this.portfolioHistoryFile = config.portfolioHistoryFile ||
      envString('PORTFOLIO_HISTORY_FILE') ||
      'portfolio_history.json';
    this.liveExecutionEvidenceFile = config.liveExecutionEvidenceFile ||
      envString('LIVE_EXECUTION_EVIDENCE_FILE') ||
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
    // 복구 가능한 항목(미해결 주문/intent, 불완전 체결 기록)은 readback이
    // 다시 기록을 써야 해소된다 — startup writer를 막으면 복구 자체가
    // 불가능해진다. 시장 차단은 _liveEvidenceBlockedMarkets가 별도로 유지.
    const nonOrderStartupBlocks = this.liveExecutionEvidenceStartup.blockingReasons.filter(reason =>
      !reason.startsWith('unresolved submitted orders:') &&
      !reason.startsWith('unresolved order intents:') &&
      !reason.startsWith('incomplete fill records:'));
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

  // ── TradingLifecycle 위임 ───────────────────────────────────────
  _lifecycle() {
    this._lifecycleRef = this._lifecycleRef || new TradingLifecycle(this);
    return this._lifecycleRef;
  }

  _orderEngine() {
    this._orderEngineRef = this._orderEngineRef || new OrderExecutionEngine(this);
    return this._orderEngineRef;
  }

  _cycleRunner() {
    this._cycleRunnerRef = this._cycleRunnerRef || new TradingCycleRunner(this);
    return this._cycleRunnerRef;
  }

  _rebalancer() {
    this._rebalancerRef = this._rebalancerRef || new PositionRebalancer(this);
    return this._rebalancerRef;
  }

  _valuation() {
    this._valuationRef = this._valuationRef || new PortfolioValuation(this);
    return this._valuationRef;
  }

  get _snapshotContext() { return this._cycleRunner()._snapshotContext; }
  set _snapshotContext(v) { this._cycleRunner()._snapshotContext = v; }
  get cycleRequestStats() { return this._cycleRunner().cycleRequestStats; }
  set cycleRequestStats(v) { this._cycleRunner().cycleRequestStats = v; }
  get _lastExchangeSyncAttemptTime() { return this._cycleRunner()._lastExchangeSyncAttemptTime; }
  set _lastExchangeSyncAttemptTime(v) { this._cycleRunner()._lastExchangeSyncAttemptTime = v; }
  get exchangeSyncRetryMs() { return this._cycleRunner().exchangeSyncRetryMs; }
  set exchangeSyncRetryMs(v) { this._cycleRunner().exchangeSyncRetryMs = v; }
  get lastRebalanceTime() { return this._rebalancer().lastRebalanceTime; }
  set lastRebalanceTime(v) { this._rebalancer().lastRebalanceTime = v; }

  get isRunning() { return this._lifecycle().isRunning; }
  set isRunning(v) { this._lifecycle().isRunning = v; }
  get _entriesPaused() { return this._lifecycle()._entriesPaused; }
  set _entriesPaused(v) { this._lifecycle()._entriesPaused = v; }
  get _gracefulShutdownPromise() { return this._lifecycle()._gracefulShutdownPromise; }
  set _gracefulShutdownPromise(v) { this._lifecycle()._gracefulShutdownPromise = v; }
  get stopReason() { return this._lifecycle().stopReason; }
  set stopReason(v) { this._lifecycle().stopReason = v; }
  get _stopRequested() { return this._lifecycle()._stopRequested; }
  set _stopRequested(v) { this._lifecycle()._stopRequested = v; }
  get _startPromise() { return this._lifecycle()._startPromise; }
  set _startPromise(v) { this._lifecycle()._startPromise = v; }
  get _orderInProgress() { return this._lifecycle()._orderInProgress; }
  set _orderInProgress(v) { this._lifecycle()._orderInProgress = v; }
  get liveManualPrepared() { return this._lifecycle().liveManualPrepared; }
  set liveManualPrepared(v) { this._lifecycle().liveManualPrepared = v; }
  get _manualRiskProtection() { return this._lifecycle()._manualRiskProtection; }
  set _manualRiskProtection(v) { this._lifecycle()._manualRiskProtection = v; }
  get _deferredProtectiveExitIntents() { return this._lifecycle()._deferredProtectiveExitIntents; }
  set _deferredProtectiveExitIntents(v) { this._lifecycle()._deferredProtectiveExitIntents = v; }
  get _startupSafetyHold() { return this._lifecycle()._startupSafetyHold; }
  set _startupSafetyHold(v) { this._lifecycle()._startupSafetyHold = v; }
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

  getLiveManagedMarkets(...args) { return this._lifecycle().getLiveManagedMarkets(...args); }

  applyRuntimeMarketUniverse(...args) { return this._lifecycle().applyRuntimeMarketUniverse(...args); }

  assertRuntimeMarketUniverseUpdateAllowed(...args) { return this._lifecycle().assertRuntimeMarketUniverseUpdateAllowed(...args); }

  resolveAllKrwMarketUniverse(...args) { return this._lifecycle().resolveAllKrwMarketUniverse(...args); }

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

  calculateTotalAssets(...args) { return this._valuation().calculateTotalAssets(...args); }

  getHeldCoins(...args) { return this._valuation().getHeldCoins(...args); }

  calculateDynamicInvestmentAmount(...args) { return this._valuation().calculateDynamicInvestmentAmount(...args); }

  calculateCumulativePnL(...args) { return this._valuation().calculateCumulativePnL(...args); }

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

  configureUpbitCredentials(...args) { return this._lifecycle().configureUpbitCredentials(...args); }

  prepareManualLiveSession(...args) { return this._lifecycle().prepareManualLiveSession(...args); }

  start(...args) { return this._lifecycle().start(...args); }

  performStart(...args) { return this._lifecycle().performStart(...args); }

  assertLiveValidationGate(...args) { return this._lifecycle().assertLiveValidationGate(...args); }

  validatePromotionReport(...args) { return this._lifecycle().validatePromotionReport(...args); }

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

  stop(...args) { return this._lifecycle().stop(...args); }

  pauseForSafetyIncident(...args) { return this._lifecycle().pauseForSafetyIncident(...args); }

  requestGracefulShutdown(...args) { return this._lifecycle().requestGracefulShutdown(...args); }

  performGracefulShutdown(...args) { return this._lifecycle().performGracefulShutdown(...args); }

  waitForProtectiveDrain(...args) { return this._lifecycle().waitForProtectiveDrain(...args); }

  finishProtectiveMonitoringWhenFlat(...args) { return this._lifecycle().finishProtectiveMonitoringWhenFlat(...args); }

  getRuntimeSafetyStatus(...args) { return this._lifecycle().getRuntimeSafetyStatus(...args); }

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

  executeTradingCycle(...args) { return this._cycleRunner().executeTradingCycle(...args); }

  executeTradingCycleFromSnapshot(...args) { return this._cycleRunner().executeTradingCycleFromSnapshot(...args); }

  getTickerMapForCycle(...args) { return this._cycleRunner().getTickerMapForCycle(...args); }

  analyzeCoin(...args) { return this._cycleRunner().analyzeCoin(...args); }

  confirmScalpingEntry(...args) { return this._orderEngine().confirmScalpingEntry(...args); }

  executeOrder(...args) { return this._orderEngine().executeOrder(...args); }

  canExecuteLiveOrder(...args) { return this._orderEngine().canExecuteLiveOrder(...args); }

  _executeOrder(...args) { return this._orderEngine()._executeOrder(...args); }

  getCurrentPositionCount(...args) { return this._rebalancer().getCurrentPositionCount(...args); }

  findWeakestPosition(...args) { return this._rebalancer().findWeakestPosition(...args); }

  sellForRebalancing(...args) { return this._rebalancer().sellForRebalancing(...args); }

  printPortfolioSummary(...args) { return this._rebalancer().printPortfolioSummary(...args); }

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

  getAccountInfo(...args) { return this._valuation().getAccountInfo(...args); }

  getKRWBalance(...args) { return this._valuation().getKRWBalance(...args); }

  getKRWTotalBalance(...args) { return this._valuation().getKRWTotalBalance(...args); }

  getCoinBalance(...args) { return this._valuation().getCoinBalance(...args); }

  /**
   * 대기
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default MultiCoinTrader;
