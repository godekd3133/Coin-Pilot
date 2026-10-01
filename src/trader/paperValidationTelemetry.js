// 페이퍼 검증 텔레메트리 레코더 — 신호/차단/신선도/엔트리 확인 카운터.
// paperValidationJournal.js에서 추출 — 저널 상태는 journal 필드를 통해 접근한다.
import { inspectShadowEntryExecution, serializePaperSignalEvidence } from './paperValidationUtils.js';

export class PaperValidationTelemetry {
  constructor(journal) {
    this.journal = journal;
  }




  recordPaperSignalTelemetry(coinAnalyses = [], marketRegime = null) {
    if (!this.journal.owner.dryRun || !this.journal.paperValidation?.active || !Array.isArray(coinAnalyses)) return;

    const telemetry = this.journal.paperValidation.telemetry || {
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
      signalTelemetryCoverageStartedAt: null,
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
      looseShadowCandidates: 0,
      looseShadowCandidatesByCoin: {},
      lastMarketRegime: null,
      lastCycleAt: null,
      lastBuyCandidateAt: null,
      requestStats: {
        batchTickerRequests: 0,
        individualTickerRequests: 0,
        candleRequests: 0,
        batchTickerFailures: 0
      }
    };
    telemetry.reasonCounts = telemetry.reasonCounts || {};
    telemetry.rejectionCounts = telemetry.rejectionCounts || {};
    telemetry.signalTelemetryVersion = Number(telemetry.signalTelemetryVersion) || 1;
    telemetry.signalTelemetryCoverageStartedAt = telemetry.signalTelemetryCoverageStartedAt || new Date().toISOString();
    telemetry.uniqueSignalWindows = Number(telemetry.uniqueSignalWindows) || 0;
    telemetry.uniqueSignalWindowsByCoin = telemetry.uniqueSignalWindowsByCoin || {};
    telemetry.uniqueReasonCounts = telemetry.uniqueReasonCounts || {};
    telemetry.uniqueRejectionCounts = telemetry.uniqueRejectionCounts || {};
    telemetry.lastSignalTelemetryKeyByCoin = telemetry.lastSignalTelemetryKeyByCoin || {};
    telemetry.rsiProximity = telemetry.rsiProximity || {};
    telemetry.rsiProximity.version = Number(telemetry.rsiProximity.version) || 1;
    if (!Number.isFinite(Number(telemetry.rsiProximity.threshold))) {
      telemetry.rsiProximity.threshold = Number(this.journal.owner.config.rsiOversold ?? this.journal.owner.strategyConfig?.rsiOversold ?? 30);
    }
    telemetry.rsiProximity.nearThresholdBand = Number.isFinite(Number(telemetry.rsiProximity.nearThresholdBand))
      ? Number(telemetry.rsiProximity.nearThresholdBand)
      : 5;
    telemetry.rsiProximity.uniqueAvailableWindows = Number(telemetry.rsiProximity.uniqueAvailableWindows) || 0;
    telemetry.rsiProximity.uniqueAvailableWindowsByCoin = telemetry.rsiProximity.uniqueAvailableWindowsByCoin || {};
    telemetry.rsiProximity.minimumPreviousRsi = Number.isFinite(Number(telemetry.rsiProximity.minimumPreviousRsi))
      ? Number(telemetry.rsiProximity.minimumPreviousRsi)
      : null;
    telemetry.rsiProximity.minimumPreviousRsiByCoin = telemetry.rsiProximity.minimumPreviousRsiByCoin || {};
    telemetry.rsiProximity.nearThresholdWindows = Number(telemetry.rsiProximity.nearThresholdWindows) || 0;
    telemetry.rsiProximity.nearThresholdWindowsByCoin = telemetry.rsiProximity.nearThresholdWindowsByCoin || {};
    telemetry.signalFunnel = telemetry.signalFunnel || {};
    telemetry.signalFunnel.version = Number(telemetry.signalFunnel.version) || 1;
    for (const key of [
      'availableWindows',
      'oversoldWindows',
      'bullishWindows',
      'priceReboundWindows',
      'rsiRecoveryWindows',
      'volumeWindows',
      'candleRangeWindows',
      'closeStrengthWindows',
      'trendWindows',
      'previousHighBreakWindows',
      'profileWindows',
      'confirmedWindows'
    ]) {
      telemetry.signalFunnel[key] = Number(telemetry.signalFunnel[key]) || 0;
    }
    telemetry.lastSignalEvidenceByCoin = telemetry.lastSignalEvidenceByCoin || {};
    telemetry.candleFreshnessBlockedSnapshots = Number(telemetry.candleFreshnessBlockedSnapshots) || 0;
    telemetry.candleFreshnessBlockedAnalyses = Number(telemetry.candleFreshnessBlockedAnalyses) || 0;
    telemetry.candleFreshnessBlockReasons = telemetry.candleFreshnessBlockReasons || {};
    telemetry.candleFreshnessBlockedByCoin = telemetry.candleFreshnessBlockedByCoin || {};
    telemetry.candleFreshnessObservedByCoin = telemetry.candleFreshnessObservedByCoin || {};
    telemetry.candleFreshnessAgeStatsByCoin = telemetry.candleFreshnessAgeStatsByCoin || {};
    telemetry.insufficientCandleDataByCoin = telemetry.insufficientCandleDataByCoin || {};
    telemetry.candleFreshnessBlockContexts = telemetry.candleFreshnessBlockContexts || {
      analysis: 0,
      entry_confirmation: 0
    };
    telemetry.candleFreshnessAgeStats = telemetry.candleFreshnessAgeStats || {
      sampleCount: 0,
      minAgeSeconds: null,
      maxObservedAgeSeconds: null,
      totalAgeSeconds: 0
    };
    telemetry.lastCandleFreshnessBlock = telemetry.lastCandleFreshnessBlock || null;
    telemetry.shadowCandidatesByCoin = telemetry.shadowCandidatesByCoin || {};
    telemetry.shadowEntryExecutionBlockedEntries = Number(telemetry.shadowEntryExecutionBlockedEntries) || 0;
    telemetry.looseShadowEntryExecutionBlockedEntries = Number(telemetry.looseShadowEntryExecutionBlockedEntries) || 0;
    telemetry.shadowEntryExecutionBlockReasons = telemetry.shadowEntryExecutionBlockReasons || {};
    telemetry.looseShadowEntryExecutionBlockReasons = telemetry.looseShadowEntryExecutionBlockReasons || {};
    telemetry.winnerShadowCandidates = Number(telemetry.winnerShadowCandidates) || 0;
    telemetry.winnerShadowCandidatesByCoin = telemetry.winnerShadowCandidatesByCoin || {};
    telemetry.winnerShadowCircuitBlockedEntries = Number(telemetry.winnerShadowCircuitBlockedEntries) || 0;
    telemetry.winnerShadowReboundBlockedEntries = Number(telemetry.winnerShadowReboundBlockedEntries) || 0;
    telemetry.oversoldObservations = Number(telemetry.oversoldObservations) || 0;
    telemetry.strictReboundCandidates = Number(telemetry.strictReboundCandidates) || 0;
    telemetry.strictConfirmedCandidates = Number(telemetry.strictConfirmedCandidates) || 0;
    telemetry.entryConfirmationAttempts = Number(telemetry.entryConfirmationAttempts) || 0;
    telemetry.entryConfirmationSucceeded = Number(telemetry.entryConfirmationSucceeded) || 0;
    telemetry.entryConfirmationCancelled = Number(telemetry.entryConfirmationCancelled) || 0;
    telemetry.entryConfirmationReasons = telemetry.entryConfirmationReasons || {};
    telemetry.lastEntryConfirmation = telemetry.lastEntryConfirmation || null;
    telemetry.lastMarketRegime = telemetry.lastMarketRegime || null;
    telemetry.circuitBlockedEntries = Number(telemetry.circuitBlockedEntries) || 0;
    telemetry.candleFreshnessBlockedEntries = Number(telemetry.candleFreshnessBlockedEntries) || 0;
    telemetry.signalWindowBlockedEntries = Number(telemetry.signalWindowBlockedEntries) || 0;
    telemetry.shadowCircuitBlockedEntries = Number(telemetry.shadowCircuitBlockedEntries) || 0;
    telemetry.looseShadowCircuitBlockedEntries = Number(telemetry.looseShadowCircuitBlockedEntries) || 0;
    telemetry.marketRegimeBlockedEntries = Number(telemetry.marketRegimeBlockedEntries) || 0;
    telemetry.shadowMarketRegimeBlockedEntries = Number(telemetry.shadowMarketRegimeBlockedEntries) || 0;
    telemetry.looseShadowMarketRegimeBlockedEntries = Number(telemetry.looseShadowMarketRegimeBlockedEntries) || 0;
    telemetry.looseShadowCandidates = Number(telemetry.looseShadowCandidates) || 0;
    telemetry.looseShadowCandidatesByCoin = telemetry.looseShadowCandidatesByCoin || {};
    telemetry.requestStats = telemetry.requestStats || {
      batchTickerRequests: 0,
      individualTickerRequests: 0,
      candleRequests: 0,
      batchTickerFailures: 0
    };
    const requestStats = this.journal.owner.cycleRequestStats || {};
    for (const key of ['batchTickerRequests', 'individualTickerRequests', 'candleRequests', 'batchTickerFailures']) {
      telemetry.requestStats[key] = (Number(telemetry.requestStats[key]) || 0) + (Number(requestStats[key]) || 0);
    }
    this.journal.owner.cycleRequestStats = null;
    const now = new Date().toISOString();
    const diagnosticShadowsEnabled = this.journal.owner.paperDiagnosticShadowsEnabled !== false;
    this.journal.paperValidation.strictOpenPositions = this.journal.owner.getStrictOpenPositionSnapshot();
    telemetry.cycles += 1;
    telemetry.lastCycleAt = now;
    telemetry.heartbeatAt = now;
    this.journal.paperValidation.heartbeatAt = now;
    if (marketRegime) telemetry.lastMarketRegime = marketRegime;

    for (const analysis of coinAnalyses) {
      const action = analysis?.decision?.action || 'HOLD';
      const coin = analysis?.coin || 'unknown';
      if (action === 'BUY') {
        telemetry.buyCandidates += 1;
        telemetry.lastBuyCandidateAt = now;
      } else if (action === 'SELL') {
        telemetry.sellSignals += 1;
      } else {
        telemetry.holdDecisions += 1;
      }

      const rebound = analysis?.decision?.details?.rebound;
      const candleFreshEnough = analysis?.candleFreshness?.valid !== false &&
        analysis?.decision?.details?.candleFreshness?.valid !== false;
      if (diagnosticShadowsEnabled && candleFreshEnough) {
        this.journal.owner.updateExecutionBoundaryBlockedEntries(analysis, 'shadow', now);
        this.journal.owner.updateExecutionBoundaryBlockedEntries(analysis, 'looseShadow', now);
      }
      const signalKey = rebound?.signalKey ? String(rebound.signalKey) : '';
      const isNewFreshSignalWindow = Boolean(candleFreshEnough && signalKey &&
        telemetry.lastSignalTelemetryKeyByCoin[coin] !== signalKey);
      if (isNewFreshSignalWindow) {
        telemetry.lastSignalTelemetryKeyByCoin[coin] = signalKey;
        telemetry.uniqueSignalWindows += 1;
        telemetry.uniqueSignalWindowsByCoin[coin] =
          (telemetry.uniqueSignalWindowsByCoin[coin] || 0) + 1;
        for (const rejectionReason of new Set(rebound?.rejectionReasons || [])) {
          telemetry.uniqueRejectionCounts[rejectionReason] =
            (telemetry.uniqueRejectionCounts[rejectionReason] || 0) + 1;
        }
        const previousRsi = Number(rebound?.previousRsi);
        const rsiThreshold = Number(telemetry.rsiProximity.threshold);
        const nearThresholdBand = Number(telemetry.rsiProximity.nearThresholdBand);
        if (rebound?.available === true && Number.isFinite(previousRsi)) {
          telemetry.rsiProximity.uniqueAvailableWindows += 1;
          telemetry.rsiProximity.uniqueAvailableWindowsByCoin[coin] =
            (telemetry.rsiProximity.uniqueAvailableWindowsByCoin[coin] || 0) + 1;
          if (!Number.isFinite(telemetry.rsiProximity.minimumPreviousRsi) ||
            previousRsi < telemetry.rsiProximity.minimumPreviousRsi) {
            telemetry.rsiProximity.minimumPreviousRsi = previousRsi;
          }
          const minimumByCoin = telemetry.rsiProximity.minimumPreviousRsiByCoin[coin];
          if (!Number.isFinite(Number(minimumByCoin)) || previousRsi < Number(minimumByCoin)) {
            telemetry.rsiProximity.minimumPreviousRsiByCoin[coin] = previousRsi;
          }
          if (Number.isFinite(rsiThreshold) && Number.isFinite(nearThresholdBand) &&
            previousRsi >= rsiThreshold && previousRsi - rsiThreshold <= nearThresholdBand) {
            telemetry.rsiProximity.nearThresholdWindows += 1;
            telemetry.rsiProximity.nearThresholdWindowsByCoin[coin] =
              (telemetry.rsiProximity.nearThresholdWindowsByCoin[coin] || 0) + 1;
          }
        }
        if (rebound?.available === true) {
          if (candleFreshEnough) {
            const signalEvidence = serializePaperSignalEvidence(analysis, now);
            if (signalEvidence) telemetry.lastSignalEvidenceByCoin[coin] = signalEvidence;
          }
          const funnel = telemetry.signalFunnel;
          funnel.availableWindows += 1;
          const minimumReboundPercent = Number.isFinite(Number(this.journal.owner.strategyConfig.minReboundPercent))
            ? Number(this.journal.owner.strategyConfig.minReboundPercent)
            : 0.15;
          const minimumRsiRecovery = Number.isFinite(Number(this.journal.owner.strategyConfig.minRsiRecovery))
            ? Number(this.journal.owner.strategyConfig.minRsiRecovery)
            : 2;
          let funnelOpen = true;
          const advance = (key, passed) => {
            if (!funnelOpen || passed !== true) {
              funnelOpen = false;
              return;
            }
            funnel[key] += 1;
          };
          advance('oversoldWindows', rebound.previousWasOversold === true);
          advance('bullishWindows', rebound.bullishCandle === true);
          advance(
            'priceReboundWindows',
            Number(rebound.reboundPriceChangePercent ?? rebound.priceChangePercent) >= minimumReboundPercent
          );
          advance('rsiRecoveryWindows', Number(rebound.rsiRecovery) >= minimumRsiRecovery);
          advance('volumeWindows', rebound.volumeConfirmed === true);
          advance(
            'candleRangeWindows',
            rebound.volatilityConfirmed === true && rebound.signalRangeFloorConfirmed === true
          );
          advance('closeStrengthWindows', rebound.closeStrengthConfirmed === true);
          advance('trendWindows', rebound.trendConfirmed === true);
          advance('previousHighBreakWindows', rebound.previousHighBreakConfirmed === true);
          advance(
            'profileWindows',
            rebound.profileConfirmed === true &&
              rebound.reboundOverboughtConfirmed !== false &&
              rebound.reboundCeilingConfirmed !== false
          );
          if (funnelOpen && rebound.reboundConfirmed === true) {
            funnel.confirmedWindows += 1;
          }
        }
      }
      if (candleFreshEnough && rebound?.previousWasOversold === true) {
        telemetry.oversoldObservations += 1;
      }
      if (candleFreshEnough && rebound?.previousWasOversold === true && rebound.bullishCandle === true) {
        telemetry.strictReboundCandidates += 1;
      }
      if (candleFreshEnough && rebound?.reboundConfirmed === true) {
        telemetry.strictConfirmedCandidates += 1;
      }
      for (const rejectionReason of rebound?.rejectionReasons || []) {
        telemetry.rejectionCounts[rejectionReason] =
          (telemetry.rejectionCounts[rejectionReason] || 0) + 1;
      }
      if (diagnosticShadowsEnabled) {
        const regimeAllowsEntry = this.journal.owner.config.marketRegimeEnabled !== true ||
          analysis?.decision?.details?.marketRegime?.confirmed === true;
        const shadowCandidateBeforeRegime = candleFreshEnough && rebound?.available === true &&
          rebound.previousWasOversold === true &&
          rebound.bullishCandle === true &&
          Number(rebound.reboundPriceChangePercent ?? rebound.priceChangePercent) >= 0.1 &&
          Number(rebound.rsiRecovery) >= 1;
        const looseShadowCandidateBeforeRegime = candleFreshEnough && rebound?.available === true &&
          (rebound.previousWasOversold === true || rebound.currentWasOversold === true) &&
          rebound.bullishCandle === true &&
          Number(rebound.reboundPriceChangePercent ?? rebound.priceChangePercent) >= 0.05 &&
          Number(rebound.rsiRecovery) >= 0.5;
        const configuredMaxRetrace = Number(this.journal.owner.maxEntryRetracePercent);
        const configuredMaxChase = Number(this.journal.owner.config.maxEntryChasePercent);
        const shadowEntryExecution = inspectShadowEntryExecution(
          analysis,
          Number.isFinite(configuredMaxRetrace) && configuredMaxRetrace >= 0 ? configuredMaxRetrace : 0.25,
          Number.isFinite(configuredMaxChase) && configuredMaxChase >= 0 ? configuredMaxChase : 0.35
        );
        const shadowCandidate = shadowCandidateBeforeRegime &&
          shadowEntryExecution.valid && regimeAllowsEntry;
        const looseShadowCandidate = looseShadowCandidateBeforeRegime &&
          shadowEntryExecution.valid && regimeAllowsEntry;
        const winnerShadowEnabled = this.journal.owner.winnerShadowExtendMinutes > 0 || this.journal.owner.winnerShadowMaxReboundPercent > 0;
        const winnerShadowReboundWithinCeiling = this.journal.owner.winnerShadowMaxReboundPercent <= 0 ||
          Number(rebound?.reboundPriceChangePercent ?? rebound?.priceChangePercent) <= this.journal.owner.winnerShadowMaxReboundPercent;
        const winnerShadowCandidate = winnerShadowEnabled &&
          candleFreshEnough &&
          action === 'BUY' &&
          rebound?.available === true &&
          rebound.reboundConfirmed === true &&
          winnerShadowReboundWithinCeiling &&
          regimeAllowsEntry;
        if (winnerShadowEnabled && action === 'BUY' && rebound?.reboundConfirmed === true &&
          !winnerShadowReboundWithinCeiling) {
          telemetry.winnerShadowReboundBlockedEntries += 1;
          this.journal.owner.recordWinnerShadowBlockedEntry(analysis, now);
        }
        if (isNewFreshSignalWindow && shadowEntryExecution.enforceable && !shadowEntryExecution.valid) {
          const reason = shadowEntryExecution.reason;
          if (shadowCandidateBeforeRegime) {
            telemetry.shadowEntryExecutionBlockedEntries += 1;
            telemetry.shadowEntryExecutionBlockReasons[reason] =
              (telemetry.shadowEntryExecutionBlockReasons[reason] || 0) + 1;
            this.journal.owner.recordExecutionBoundaryBlockedEntry(analysis, 'shadow', reason, now);
          }
          if (looseShadowCandidateBeforeRegime) {
            telemetry.looseShadowEntryExecutionBlockedEntries += 1;
            telemetry.looseShadowEntryExecutionBlockReasons[reason] =
              (telemetry.looseShadowEntryExecutionBlockReasons[reason] || 0) + 1;
            this.journal.owner.recordExecutionBoundaryBlockedEntry(analysis, 'looseShadow', reason, now);
          }
        }
        if (this.journal.owner.config.marketRegimeEnabled === true && !regimeAllowsEntry) {
          if (shadowCandidateBeforeRegime) telemetry.shadowMarketRegimeBlockedEntries += 1;
          if (looseShadowCandidateBeforeRegime) telemetry.looseShadowMarketRegimeBlockedEntries += 1;
        }
        if (shadowCandidate) {
          telemetry.shadowCandidates += 1;
          telemetry.shadowCandidatesByCoin[coin] = (telemetry.shadowCandidatesByCoin[coin] || 0) + 1;
        }
        if (looseShadowCandidate) {
          telemetry.looseShadowCandidates += 1;
          telemetry.looseShadowCandidatesByCoin[coin] =
            (telemetry.looseShadowCandidatesByCoin[coin] || 0) + 1;
        }
        if (winnerShadowCandidate) {
          telemetry.winnerShadowCandidates += 1;
          telemetry.winnerShadowCandidatesByCoin[coin] =
            (telemetry.winnerShadowCandidatesByCoin[coin] || 0) + 1;
        }

        const shadowResult = this.journal.owner.updatePaperShadowPosition(analysis, shadowCandidate && action !== 'BUY', now);
        const looseShadowResult = this.journal.owner.updatePaperShadowPosition(analysis, looseShadowCandidate && action !== 'BUY', now, 'looseShadow');
        const winnerShadowResult = winnerShadowEnabled
          ? this.journal.owner.updatePaperShadowPosition(analysis, winnerShadowCandidate, now, 'winnerShadow')
          : null;
        if (shadowResult?.blockedByLossCircuit) telemetry.shadowCircuitBlockedEntries += 1;
        if (looseShadowResult?.blockedByLossCircuit) telemetry.looseShadowCircuitBlockedEntries += 1;
        if (winnerShadowResult?.blockedByLossCircuit) telemetry.winnerShadowCircuitBlockedEntries += 1;
      }

      const reason = String(analysis?.decision?.reason || 'unknown').slice(0, 120);
      telemetry.reasonCounts[reason] = (telemetry.reasonCounts[reason] || 0) + 1;
      if (isNewFreshSignalWindow) {
        telemetry.uniqueReasonCounts[reason] = (telemetry.uniqueReasonCounts[reason] || 0) + 1;
      }
    }

    this.journal.paperValidation.telemetry = telemetry;
    const lastPersistedAt = this.journal.paperValidation.lastTelemetryPersistedAt
      ? new Date(this.journal.paperValidation.lastTelemetryPersistedAt).getTime()
      : 0;
    if (Date.now() - lastPersistedAt >= 60_000) {
      this.journal.paperValidation.lastTelemetryPersistedAt = now;
      this.journal.owner.savePaperValidation();
    }
  }


  recordPaperCircuitBlock() {
    if (!this.journal.owner.dryRun || !this.journal.paperValidation?.active) return;
    const telemetry = this.journal.paperValidation.telemetry || {};
    telemetry.circuitBlockedEntries = (Number(telemetry.circuitBlockedEntries) || 0) + 1;
    telemetry.lastCircuitBlockedAt = new Date().toISOString();
    this.journal.paperValidation.telemetry = telemetry;
  }


  recordPaperSignalWindowBlock() {
    if (!this.journal.owner.dryRun || !this.journal.paperValidation?.active) return;
    const telemetry = this.journal.paperValidation.telemetry || {};
    telemetry.signalWindowBlockedEntries = (Number(telemetry.signalWindowBlockedEntries) || 0) + 1;
    telemetry.lastSignalWindowBlockedAt = new Date().toISOString();
    this.journal.paperValidation.telemetry = telemetry;
  }


  recordPaperMarketRegimeBlock() {
    if (!this.journal.owner.dryRun || !this.journal.paperValidation?.active) return;
    const telemetry = this.journal.paperValidation.telemetry || {};
    telemetry.marketRegimeBlockedEntries = (Number(telemetry.marketRegimeBlockedEntries) || 0) + 1;
    telemetry.lastMarketRegimeBlockedAt = new Date().toISOString();
    this.journal.paperValidation.telemetry = telemetry;
  }


  recordInsufficientCandleData(coin, receivedCount, requiredCount) {
    if (!this.journal.owner.dryRun || !this.journal.paperValidation?.active || !coin) return;
    const telemetry = this.journal.paperValidation.telemetry || {};
    telemetry.insufficientCandleDataByCoin = telemetry.insufficientCandleDataByCoin || {};
    const current = telemetry.insufficientCandleDataByCoin[coin] || {
      count: 0,
      minReceivedCount: null,
      lastReceivedCount: null,
      requiredCount: null,
      lastAt: null
    };
    const received = Math.max(0, Number(receivedCount) || 0);
    const required = Math.max(1, Number(requiredCount) || 1);
    current.count = (Number(current.count) || 0) + 1;
    current.minReceivedCount = current.minReceivedCount === null
      ? received
      : Math.min(Number(current.minReceivedCount), received);
    current.lastReceivedCount = received;
    current.requiredCount = required;
    current.lastAt = new Date().toISOString();
    telemetry.insufficientCandleDataByCoin[coin] = current;
    this.journal.paperValidation.telemetry = telemetry;
  }


  recordPaperCandleFreshnessObservation(coin, freshness) {
    if (!this.journal.owner.dryRun || !this.journal.paperValidation?.active || !coin) return;
    const telemetry = this.journal.paperValidation.telemetry || {};
    telemetry.candleFreshnessObservedByCoin = telemetry.candleFreshnessObservedByCoin || {};
    telemetry.candleFreshnessAgeStatsByCoin = telemetry.candleFreshnessAgeStatsByCoin || {};
    telemetry.candleFreshnessObservedByCoin[coin] =
      (Number(telemetry.candleFreshnessObservedByCoin[coin]) || 0) + 1;

    const stats = telemetry.candleFreshnessAgeStatsByCoin[coin] || {
      sampleCount: 0,
      validCount: 0,
      blockedCount: 0,
      missingTimestampCount: 0,
      minAgeSeconds: null,
      maxObservedAgeSeconds: null,
      totalAgeSeconds: 0
    };
    const ageSeconds = Number(freshness?.ageMs) / 1000;
    stats.sampleCount = (Number(stats.sampleCount) || 0) + 1;
    if (freshness?.valid === true) stats.validCount = (Number(stats.validCount) || 0) + 1;
    if (freshness?.reason === 'stale_candle_snapshot') {
      stats.blockedCount = (Number(stats.blockedCount) || 0) + 1;
    }
    if (freshness?.reason === 'missing_candle_timestamp') {
      stats.missingTimestampCount = (Number(stats.missingTimestampCount) || 0) + 1;
    }
    if (Number.isFinite(ageSeconds) && ageSeconds >= 0) {
      stats.minAgeSeconds = stats.minAgeSeconds === null
        ? ageSeconds
        : Math.min(Number(stats.minAgeSeconds), ageSeconds);
      stats.maxObservedAgeSeconds = stats.maxObservedAgeSeconds === null
        ? ageSeconds
        : Math.max(Number(stats.maxObservedAgeSeconds), ageSeconds);
      stats.totalAgeSeconds = (Number(stats.totalAgeSeconds) || 0) + ageSeconds;
    }
    telemetry.candleFreshnessAgeStatsByCoin[coin] = stats;
    this.journal.paperValidation.telemetry = telemetry;
  }


  recordPaperCandleFreshnessBlock(reason = 'unknown', freshness = null, context = 'entry_confirmation', coin = null) {
    if (!this.journal.owner.dryRun || !this.journal.paperValidation?.active) return;
    const telemetry = this.journal.paperValidation.telemetry || {};
    const blockedAt = new Date().toISOString();
    const normalizedContext = context === 'analysis' ? 'analysis' : 'entry_confirmation';
    telemetry.candleFreshnessBlockedSnapshots = Number(telemetry.candleFreshnessBlockedSnapshots) || 0;
    telemetry.candleFreshnessBlockedAnalyses = Number(telemetry.candleFreshnessBlockedAnalyses) || 0;
    telemetry.candleFreshnessBlockedEntries = Number(telemetry.candleFreshnessBlockedEntries) || 0;
    telemetry.candleFreshnessBlockedSnapshots += 1;
    if (normalizedContext === 'analysis') {
      telemetry.candleFreshnessBlockedAnalyses += 1;
    } else {
      telemetry.candleFreshnessBlockedEntries += 1;
    }
    telemetry.candleFreshnessBlockContexts = telemetry.candleFreshnessBlockContexts || {
      analysis: 0,
      entry_confirmation: 0
    };
    telemetry.candleFreshnessBlockContexts[normalizedContext] =
      (Number(telemetry.candleFreshnessBlockContexts[normalizedContext]) || 0) + 1;
    telemetry.candleFreshnessBlockReasons = telemetry.candleFreshnessBlockReasons || {};
    telemetry.candleFreshnessBlockedByCoin = telemetry.candleFreshnessBlockedByCoin || {};
    telemetry.candleFreshnessAgeStats = telemetry.candleFreshnessAgeStats || {
      sampleCount: 0,
      minAgeSeconds: null,
      maxObservedAgeSeconds: null,
      totalAgeSeconds: 0
    };
    telemetry.candleFreshnessBlockReasons[reason] =
      (Number(telemetry.candleFreshnessBlockReasons[reason]) || 0) + 1;
    if (coin) {
      telemetry.candleFreshnessBlockedByCoin[coin] =
        (Number(telemetry.candleFreshnessBlockedByCoin[coin]) || 0) + 1;
    }
    telemetry.lastCandleFreshnessBlockAt = blockedAt;
    telemetry.lastCandleFreshnessBlock = {
      at: blockedAt,
      reason,
      context: normalizedContext,
      coin: coin || null,
      timestamp: freshness?.timestamp || null,
      source: freshness?.source || null,
      ageMs: Number.isFinite(Number(freshness?.ageMs)) ? Number(freshness.ageMs) : null,
      ageSeconds: Number.isFinite(Number(freshness?.ageMs))
        ? Number(freshness.ageMs) / 1000
        : null,
      maxAgeSeconds: Number.isFinite(Number(freshness?.maxAgeSeconds))
        ? Number(freshness.maxAgeSeconds)
        : this.journal.owner.maxCandleAgeSeconds
    };
    const ageSeconds = telemetry.lastCandleFreshnessBlock.ageSeconds;
    if (Number.isFinite(ageSeconds) && ageSeconds >= 0) {
      const ageStats = telemetry.candleFreshnessAgeStats;
      ageStats.sampleCount = (Number(ageStats.sampleCount) || 0) + 1;
      ageStats.minAgeSeconds = ageStats.minAgeSeconds === null
        ? ageSeconds
        : Math.min(Number(ageStats.minAgeSeconds), ageSeconds);
      ageStats.maxObservedAgeSeconds = ageStats.maxObservedAgeSeconds === null
        ? ageSeconds
        : Math.max(Number(ageStats.maxObservedAgeSeconds), ageSeconds);
      ageStats.totalAgeSeconds = (Number(ageStats.totalAgeSeconds) || 0) + ageSeconds;
    }
    this.journal.paperValidation.telemetry = telemetry;
  }


  recordPaperEntryConfirmation(coin, outcome, reason = 'unknown') {
    if (!this.journal.owner.dryRun || !this.journal.paperValidation?.active) return;
    const telemetry = this.journal.paperValidation.telemetry || {};
    telemetry.entryConfirmationAttempts = Number(telemetry.entryConfirmationAttempts) || 0;
    telemetry.entryConfirmationSucceeded = Number(telemetry.entryConfirmationSucceeded) || 0;
    telemetry.entryConfirmationCancelled = Number(telemetry.entryConfirmationCancelled) || 0;
    telemetry.entryConfirmationReasons = telemetry.entryConfirmationReasons || {};
    const normalizedOutcome = outcome === 'confirmed' ? 'confirmed' : 'cancelled';
    const normalizedReason = String(reason || 'unknown').slice(0, 160);
    if (outcome === 'attempt') {
      telemetry.entryConfirmationAttempts += 1;
    } else if (normalizedOutcome === 'confirmed') {
      telemetry.entryConfirmationSucceeded += 1;
    } else {
      telemetry.entryConfirmationCancelled += 1;
    }
    if (outcome !== 'attempt') {
      telemetry.entryConfirmationReasons[normalizedReason] =
        (Number(telemetry.entryConfirmationReasons[normalizedReason]) || 0) + 1;
    }
    telemetry.lastEntryConfirmation = {
      at: new Date().toISOString(),
      coin: coin || null,
      outcome: outcome === 'attempt' ? 'attempt' : normalizedOutcome,
      reason: normalizedReason
    };
    this.journal.paperValidation.telemetry = telemetry;
  }
}
