// 페이퍼 검증 세션 수명주기 — 시작/종료/주기 스냅샷.
// paperValidationJournal.js에서 추출; 저널 상태는 journal을 통해 접근한다.
import {
  createAnalysisDataHealthState
} from '../risk/analysisDataHealth.js';
import {
  createLossCircuitBreakerState
} from '../risk/lossCircuitBreaker.js';
import {
  createRiskMonitorState
} from '../risk/riskMonitor.js';

export class PaperValidationSession {
  constructor(journal) {
    this.journal = journal;
  }



  async startPaperValidationSession(options = {}) {
    if (!this.journal.owner.dryRun) {
      throw new Error('실거래 모드에서는 모의투자 세션을 시작할 수 없습니다.');
    }

    const previousDiagnosticOpenPositions = this.journal.owner.getPaperDiagnosticOpenPositionSnapshot();
    const previousContinuityInvalid = this.journal.paperValidation?.riskMonitor?.continuityEligible === false ||
      this.journal.paperValidation?.analysisDataHealth?.continuityEligible === false ||
      this.journal.paperValidation?.continuityEligible === false;
    const previousSessionUnsettled = this.journal.paperValidation?.endedWithOpenPositions === true ||
      this.journal.paperValidation?.endedWithDiagnosticOpenPositions === true ||
      previousDiagnosticOpenPositions.length > 0 ||
      previousContinuityInvalid;
    if (this.journal.paperValidation?.active === false && previousSessionUnsettled &&
      options.reset !== true && options.allowUnsettledResume !== true) {
      const strictCoins = (this.journal.paperValidation.strictOpenPositions || [])
        .map(position => position.coin)
        .filter(Boolean);
      const diagnosticCoins = previousDiagnosticOpenPositions
        .map(position => `${position.book}:${position.coin}`)
        .filter(Boolean);
      const details = [
        strictCoins.length > 0 ? `정리되지 않은 포지션: ${strictCoins.join(', ')}` : null,
        diagnosticCoins.length > 0 ? `비교 기록에 정리되지 않은 포지션 ${diagnosticCoins.length}개` : null,
        previousContinuityInvalid ? '기록이 끊긴 구간이 있습니다' : null
      ].filter(Boolean).join(', ');
      throw new Error(`이전 모의투자 기록을 이어서 사용할 수 없습니다.${details ? ` ${details}.` : ''} 기록을 확인해 주세요. 초기화하려면 '초기화 후 시작'을 선택하세요. 기존 가상 잔액·보유 자산·거래 기록이 삭제됩니다.`);
    }

    const shouldReset = options.reset === true;
    if (shouldReset) {
      const seedMoney = Number(options.seedMoney) > 0 ? Number(options.seedMoney) : this.journal.owner.initialSeedMoney;
      this.journal.owner.resetVirtualPortfolio(seedMoney);
    }

    const baselineAssets = await this.journal.owner.calculateTotalAssets();
    const startedAt = new Date().toISOString();
    this.journal.owner.stopReason = null;
    this.journal.owner.riskMonitorState = createRiskMonitorState();
    this.journal.owner.lastRiskStatePersistedAt = 0;
    this.journal.owner.analysisDataHealthState = createAnalysisDataHealthState();
    this.journal.owner.analysisCycleProgress = null;
    this.journal.owner.lastAnalysisStatePersistedAt = 0;
    this.journal.paperValidation = {
      schemaVersion: 4,
      sessionId: `paper-${Date.now()}`,
      active: true,
      startedAt,
      endedAt: null,
      processId: process.pid,
      heartbeatAt: startedAt,
      strategyMode: this.journal.owner.strategyMode,
      strategyProfile: this.journal.owner.config.signalProfile || 'rsi_rebound',
      targetCoins: [...this.journal.owner.targetCoins],
      configSnapshot: this.journal.owner.getPaperValidationConfigSnapshot(),
      configSnapshotComplete: true,
      paperExperiments: this.journal.owner.getPaperExperimentSnapshot(),
      baselineAssets,
      baselineIncludesHoldings: this.journal.owner.virtualPortfolio.holdings.size > 0,
      thresholds: {
        minDays: Number(options.minDays) || this.journal.owner.config.paperValidationMinDays || 7,
        minTrades: Number(options.minTrades) || this.journal.owner.config.paperValidationMinTrades || 20,
        minReturnPercent: Number(options.minReturnPercent) || this.journal.owner.config.paperValidationMinReturnPercent || 0.2,
        maxDrawdownPercent: Number(options.maxDrawdownPercent) || this.journal.owner.config.paperValidationMaxDrawdownPercent || 15,
        maxHeartbeatGapMinutes: Number(options.maxHeartbeatGapMinutes) || this.journal.owner.config.paperValidationMaxHeartbeatGapMinutes || 15
      },
      interruptions: [],
      riskMonitor: { ...this.journal.owner.riskMonitorState },
      analysisDataHealth: { ...this.journal.owner.analysisDataHealthState },
      telemetry: {
        cycles: 0,
        buyCandidates: 0,
        candleFreshnessBlockedSnapshots: 0,
        candleFreshnessBlockedAnalyses: 0,
        candleFreshnessBlockedEntries: 0,
        candleFreshnessBlockReasons: {},
        candleFreshnessBlockedByCoin: {},
        candleFreshnessObservedByCoin: {},
        candleFreshnessAgeStatsByCoin: {},
        insufficientCandleDataByCoin: {},
        candleFreshnessBlockContexts: {
          analysis: 0,
          entry_confirmation: 0
        },
        candleFreshnessAgeStats: {
          sampleCount: 0,
          minAgeSeconds: null,
          maxObservedAgeSeconds: null,
          totalAgeSeconds: 0
        },
        lastCandleFreshnessBlock: null,
        circuitBlockedEntries: 0,
        signalWindowBlockedEntries: 0,
        shadowCircuitBlockedEntries: 0,
        looseShadowCircuitBlockedEntries: 0,
        marketRegimeBlockedEntries: 0,
        shadowMarketRegimeBlockedEntries: 0,
        looseShadowMarketRegimeBlockedEntries: 0,
        shadowCandidates: 0,
        shadowEntryExecutionBlockedEntries: 0,
        looseShadowEntryExecutionBlockedEntries: 0,
        shadowEntryExecutionBlockReasons: {},
        looseShadowEntryExecutionBlockReasons: {},
        winnerShadowCandidates: 0,
        winnerShadowCandidatesByCoin: {},
        winnerShadowCircuitBlockedEntries: 0,
        winnerShadowReboundBlockedEntries: 0,
        oversoldObservations: 0,
        strictReboundCandidates: 0,
        strictConfirmedCandidates: 0,
        entryConfirmationAttempts: 0,
        entryConfirmationSucceeded: 0,
        entryConfirmationCancelled: 0,
        entryConfirmationReasons: {},
        lastEntryConfirmation: null,
        sellSignals: 0,
        holdDecisions: 0,
        reasonCounts: {},
        rejectionCounts: {},
        signalTelemetryVersion: 1,
        signalTelemetryCoverageStartedAt: startedAt,
        uniqueSignalWindows: 0,
        uniqueSignalWindowsByCoin: {},
        uniqueReasonCounts: {},
        uniqueRejectionCounts: {},
        lastSignalTelemetryKeyByCoin: {},
        rsiProximity: {
          version: 1,
          threshold: Number(this.journal.owner.config.rsiOversold ?? this.journal.owner.strategyConfig?.rsiOversold ?? 30),
          nearThresholdBand: 5,
          uniqueAvailableWindows: 0,
          uniqueAvailableWindowsByCoin: {},
          minimumPreviousRsi: null,
          minimumPreviousRsiByCoin: {},
          nearThresholdWindows: 0,
          nearThresholdWindowsByCoin: {}
        },
        signalFunnel: {
          version: 1,
          availableWindows: 0,
          oversoldWindows: 0,
          bullishWindows: 0,
          priceReboundWindows: 0,
          rsiRecoveryWindows: 0,
          volumeWindows: 0,
          candleRangeWindows: 0,
          closeStrengthWindows: 0,
          trendWindows: 0,
          previousHighBreakWindows: 0,
          profileWindows: 0,
          confirmedWindows: 0
        },
        lastSignalEvidenceByCoin: {},
        shadowCandidatesByCoin: {},
        lastMarketRegime: null,
        analysisIncompleteCycles: 0,
        analysisMissingMarkets: 0,
        lastIncompleteAnalysis: null,
        analysisDataHealth: { ...this.journal.owner.analysisDataHealthState },
        lastCycleAt: null,
        lastBuyCandidateAt: null,
        requestStats: {
          batchTickerRequests: 0,
          individualTickerRequests: 0,
          candleRequests: 0,
          batchTickerFailures: 0
        }
      },
      // 청산 거래는 프로세스 재시작 후에도 forward 검증에 포함되어야
      // 하므로 strict paper 장부에 별도로 보존한다.
      strictTrades: [],
      strictRiskState: {
        cooldownUntilByCoin: {},
        consecutiveLossesByCoin: {},
        signalWindowEntryCountsByKey: {},
        lossCircuitBreaker: createLossCircuitBreakerState()
      },
      strictOpenPositions: [],
      // Strict paper trades are kept in the virtual portfolio. This separate
      // shadow book measures the relaxed candidate cohort without changing
      // that portfolio or affecting live-order eligibility.
      shadow: {
        positions: {},
        lastSignalByCoin: {},
        executionBoundaryBlockedEntries: [],
        closedTrades: [],
        entryCount: 0,
        realizedProfit: 0,
        totalInvested: 0,
        winningTrades: 0,
        losingTrades: 0,
        cooldownUntilByCoin: {},
        consecutiveLossesByCoin: {},
        lossCircuitBreaker: createLossCircuitBreakerState(),
        lastEntryAt: null,
        lastExitAt: null
      },
      looseShadow: {
        positions: {},
        lastSignalByCoin: {},
        executionBoundaryBlockedEntries: [],
        closedTrades: [],
        entryCount: 0,
        realizedProfit: 0,
        totalInvested: 0,
        winningTrades: 0,
        losingTrades: 0,
        cooldownUntilByCoin: {},
        consecutiveLossesByCoin: {},
        lossCircuitBreaker: createLossCircuitBreakerState(),
        lastEntryAt: null,
        lastExitAt: null
      },
      // Optional candidate book. It mirrors only confirmed strict BUY signals
      // and applies the explicitly configured winner-hold experiment. It is
      // never included in strict assets or promotion metrics.
      winnerShadow: {
        positions: {},
        lastSignalByCoin: {},
        blockedEntries: [],
        closedTrades: [],
        entryCount: 0,
        realizedProfit: 0,
        totalInvested: 0,
        winningTrades: 0,
        losingTrades: 0,
        cooldownUntilByCoin: {},
        consecutiveLossesByCoin: {},
        lossCircuitBreaker: createLossCircuitBreakerState(),
        lastEntryAt: null,
        lastExitAt: null
      },
      snapshots: [{ timestamp: startedAt, totalAssets: baselineAssets, reason: 'session_start' }]
    };
    this.journal.owner.savePaperValidation();
    return this.journal.owner.getPaperValidationStatus();
  }



  async stopPaperValidationSession() {
    if (!this.journal.paperValidation) {
      return { available: false, active: false };
    }
    const pendingCounterfactualCount = ['shadow', 'looseShadow']
      .reduce((count, stateKey) => count + (this.journal.paperValidation[stateKey]?.executionBoundaryBlockedEntries || [])
        .filter(entry => entry?.status === 'pending').length, 0);
    this.journal.owner.resolveExecutionBoundaryBlockedEntriesAtStop(new Date().toISOString());
    const strictOpenPositions = this.journal.owner.getStrictOpenPositionSnapshot();
    const diagnosticOpenPositions = this.journal.owner.getPaperDiagnosticOpenPositionSnapshot();
    this.journal.paperValidation.strictOpenPositions = strictOpenPositions;
    this.journal.paperValidation.endedWithOpenPositions = strictOpenPositions.length > 0;
    this.journal.paperValidation.endedWithDiagnosticOpenPositions = diagnosticOpenPositions.length > 0;
    this.journal.paperValidation.diagnosticOpenPositionsAtStop = diagnosticOpenPositions;
    this.journal.paperValidation.pendingCounterfactualCountAtStop = pendingCounterfactualCount;
    const continuityStopReason = this.journal.paperValidation.riskMonitor?.continuityEligible === false
      ? 'risk_data_gap'
      : this.journal.paperValidation.analysisDataHealth?.continuityEligible === false
        ? 'analysis_data_gap'
        : null;
    this.journal.paperValidation.stopReason = this.journal.owner.stopReason || continuityStopReason ||
      (this.journal.paperValidation.endedWithOpenPositions
        ? 'stopped_with_unsettled_strict_positions'
        : diagnosticOpenPositions.length > 0
          ? 'stopped_with_unsettled_diagnostic_positions'
          : pendingCounterfactualCount > 0
            ? 'stopped_with_unsettled_boundary_counterfactuals'
          : 'stopped_cleanly');
    this.journal.paperValidation.active = false;
    this.journal.paperValidation.endedAt = new Date().toISOString();
    this.journal.owner.savePaperValidation();
    return this.journal.owner.getPaperValidationStatus();
  }



  async recordPaperValidationSnapshot(reason = 'periodic', priceMapOverride = null) {
    if (!this.journal.owner.dryRun || !this.journal.paperValidation?.active) return null;

    const now = Date.now();
    const lastSnapshot = this.journal.paperValidation.snapshots?.at(-1);
    if (lastSnapshot && now - new Date(lastSnapshot.timestamp).getTime() < 60_000) {
      return this.journal.owner.getPaperValidationStatus();
    }

    const totalAssets = await this.journal.owner.calculateTotalAssets(priceMapOverride);
    this.journal.paperValidation.snapshots = [
      ...(this.journal.paperValidation.snapshots || []),
      { timestamp: new Date(now).toISOString(), totalAssets, reason }
    ].slice(-10000);
    this.journal.owner.savePaperValidation();
    return this.journal.owner.getPaperValidationStatus();
  }
}
