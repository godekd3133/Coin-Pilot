// 페이퍼 검증 설정 스냅샷과 config 드리프트 비교.
// paperValidationJournal.js에서 추출; 저널 상태는 journal을 통해 접근한다.
import {
  resolveLossCircuitBreakerConfig,
  resolveSignalWindowEntryLimit
} from './paperValidationRiskGate.js';

export class PaperValidationSnapshots {
  constructor(journal) {
    this.journal = journal;
  }



  getPaperValidationConfigSnapshot() {
    const config = this.journal.owner.config || {};
    const numericOrNull = value => value === null || value === undefined || value === ''
      ? null
      : Number.isFinite(Number(value)) ? Number(value) : null;
    const lossCircuitConfig = resolveLossCircuitBreakerConfig(config);
    return {
      strategyMode: this.journal.owner.strategyMode,
      signalProfile: config.signalProfile || 'rsi_rebound',
      targetCoins: [...this.journal.owner.targetCoins].sort(),
      candleUnit: numericOrNull(this.journal.owner.candleUnit),
      candleCount: numericOrNull(this.journal.owner.candleCount),
      maxCandleAgeSeconds: numericOrNull(this.journal.owner.maxCandleAgeSeconds),
      rsiPeriod: numericOrNull(config.rsiPeriod),
      rsiOversold: numericOrNull(config.rsiOversold),
      rsiOverbought: numericOrNull(config.rsiOverbought),
      oversoldLookback: numericOrNull(config.oversoldLookback),
      minReboundPercent: numericOrNull(config.minReboundPercent),
      minRsiRecovery: numericOrNull(config.minRsiRecovery),
      minVolumeRatio: numericOrNull(config.minVolumeRatio),
      volumeLookback: numericOrNull(config.volumeLookback),
      minCloseStrength: numericOrNull(config.minCloseStrength),
      trendPeriod: numericOrNull(config.trendPeriod),
      trendSlopeLookback: numericOrNull(config.trendSlopeLookback),
      minTrendSlopePercent: numericOrNull(config.minTrendSlopePercent),
      requirePreviousHighBreak: config.requirePreviousHighBreak !== false,
      maxSignalRangePercent: numericOrNull(config.maxSignalRangePercent),
      minSignalRangePercent: numericOrNull(config.minSignalRangePercent),
      maxReboundPercent: numericOrNull(config.maxReboundPercent ?? 0),
      marketRegimeEnabled: config.marketRegimeEnabled === true,
      marketRegimeLookback: numericOrNull(config.marketRegimeLookback ?? 5),
      marketRegimeMinBreadth: numericOrNull(config.marketRegimeMinBreadth ?? 0.5),
      marketRegimeMinReturnPercent: numericOrNull(config.marketRegimeMinReturnPercent ?? -0.2),
      requireReboundBelowOverbought: config.requireReboundBelowOverbought === true,
      stopLossPercent: numericOrNull(config.stopLossPercent),
      takeProfitPercent: numericOrNull(config.takeProfitPercent),
      maxHoldMinutes: numericOrNull(config.maxHoldMinutes),
      maxLosingHoldMinutes: numericOrNull(config.maxLosingHoldMinutes ?? 0),
      winnerExtendMinutes: numericOrNull(config.winnerExtendMinutes ?? 0),
      winnerExtendMinProfitPercent: numericOrNull(config.winnerExtendMinProfitPercent ?? 0),
      maxEntriesPerSignalWindow: resolveSignalWindowEntryLimit(config),
      cooldownAfterLossMinutes: numericOrNull(config.cooldownAfterLossMinutes),
      maxConsecutiveLosses: numericOrNull(config.maxConsecutiveLosses),
      lossCircuitBreakerCount: lossCircuitConfig.maxLosses,
      lossCircuitBreakerWindowMinutes: lossCircuitConfig.windowMinutes,
      lossCircuitBreakerCooldownMinutes: lossCircuitConfig.cooldownMinutes,
      investmentRatio: numericOrNull(this.journal.owner.investmentRatio ?? config.investmentRatio),
      tradingFee: numericOrNull(config.tradingFee ?? 0.0005),
      slippage: numericOrNull(config.slippage ?? 0.001),
      maxPositions: numericOrNull(this.journal.owner.maxPositions),
      portfolioAllocation: numericOrNull(this.journal.owner.portfolioAllocation),
      bbPeriod: numericOrNull(config.bbPeriod || 20),
      bbStdDev: numericOrNull(config.bbStdDev || 2),
      emaPeriod: numericOrNull(config.emaLong || 20),
      requireNextCandleBullish: config.requireNextCandleBullish === true,
      entryDelayMinMs: numericOrNull(config.entryDelayMinMs),
      entryDelayMaxMs: numericOrNull(config.entryDelayMaxMs),
      maxRiskDataGapSeconds: numericOrNull(this.journal.owner.maxRiskDataGapSeconds),
      maxAnalysisDataGapSeconds: numericOrNull(this.journal.owner.maxAnalysisDataGapSeconds),
      maxEntryRetracePercent: numericOrNull(config.maxEntryRetracePercent),
      maxEntryChasePercent: numericOrNull(config.maxEntryChasePercent),
      breakEvenTriggerPercent: numericOrNull(config.breakEvenTriggerPercent),
      breakEvenOffsetPercent: numericOrNull(config.breakEvenOffsetPercent),
      trailingActivationPercent: numericOrNull(config.trailingActivationPercent),
      trailingStopPercent: numericOrNull(config.trailingStopPercent),
      positionRiskCheckIntervalMs: numericOrNull(this.journal.owner.positionRiskCheckIntervalMs)
    };
  }



  getPaperExperimentSnapshot() {
    const winnerShadowEnabled = this.journal.owner.winnerShadowExtendMinutes > 0 || this.journal.owner.winnerShadowMaxReboundPercent > 0;
    return {
      diagnosticShadows: {
        enabled: this.journal.owner.paperDiagnosticShadowsEnabled
      },
      winnerShadow: {
        enabled: winnerShadowEnabled,
        entryContract: this.journal.owner.winnerShadowMaxReboundPercent > 0
          ? 'strict_confirmed_buy_signal_with_optional_rebound_ceiling'
          : 'strict_confirmed_buy_signal',
        winnerExtendMinutes: this.journal.owner.winnerShadowExtendMinutes,
        winnerExtendMinProfitPercent: this.journal.owner.winnerShadowExtendMinProfitPercent,
        entryMaxReboundPercent: this.journal.owner.winnerShadowMaxReboundPercent
      }
    };
  }



  comparePaperExperimentConfig(recordedSnapshot) {
    const current = this.journal.owner.getPaperExperimentSnapshot();
    const drift = [];
    const recordedDiagnosticShadows = recordedSnapshot?.diagnosticShadows;
    // Ledgers created before the strict-only switch existed are interpreted as
    // the historical default: diagnostic shadows enabled. Disabling them on a
    // resumed old ledger must be explicit and therefore fails closed.
    const recordedDiagnosticShadowsEnabled = recordedDiagnosticShadows && typeof recordedDiagnosticShadows === 'object'
      ? recordedDiagnosticShadows.enabled !== false
      : true;
    if (recordedDiagnosticShadowsEnabled !== current.diagnosticShadows.enabled) {
      drift.push('diagnosticShadows.enabled');
    }
    const recorded = recordedSnapshot?.winnerShadow;
    if (!recorded || typeof recorded !== 'object') {
      const disabled = current.winnerShadow.enabled === false &&
        current.winnerShadow.winnerExtendMinutes === 0 &&
        current.winnerShadow.winnerExtendMinProfitPercent === 0;
      return {
        consistent: disabled && drift.length === 0,
        drift: [
          ...(disabled ? [] : ['winnerShadow.snapshot_missing']),
          ...drift
        ]
      };
    }

    const keys = ['enabled', 'entryContract', 'winnerExtendMinutes', 'winnerExtendMinProfitPercent', 'entryMaxReboundPercent'];
    drift.push(...keys.filter(key =>
      JSON.stringify(recorded[key]) !== JSON.stringify(current.winnerShadow[key])
    ));
    return { consistent: drift.length === 0, drift };
  }



  getExecutionBoundaryCounterfactualConfig() {
    const config = this.journal.owner.config || {};
    const numberOr = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
    const baselineAssets = Number(this.journal.paperValidation?.baselineAssets);
    const investmentRatio = Number.isFinite(Number(this.journal.owner.investmentRatio))
      ? Number(this.journal.owner.investmentRatio)
      : numberOr(config.investmentRatio, 0.02);
    return {
      baselineAssets: Number.isFinite(baselineAssets) && baselineAssets > 0
        ? baselineAssets
        : numberOr(this.journal.owner.initialSeedMoney, 1_000_000),
      investmentRatio,
      tradingFee: numberOr(config.tradingFee, 0.0005),
      slippage: numberOr(config.slippage, 0.001),
      stopLossPercent: numberOr(config.stopLossPercent, 1.2),
      takeProfitPercent: numberOr(config.takeProfitPercent, 1.8),
      maxHoldMinutes: numberOr(config.maxHoldMinutes, 30)
    };
  }

  /**
   * Record a signal rejected by the strict delayed-entry price boundary.
   * This is not a shadow fill: it is a separate counterfactual position whose
   * only purpose is to measure whether the boundary avoided a later loss.
   */

  comparePaperValidationConfig(recordedSnapshot) {
    if (!recordedSnapshot || typeof recordedSnapshot !== 'object') {
      return { consistent: null, drift: ['config_snapshot_missing'] };
    }

    const currentSnapshot = this.journal.owner.getPaperValidationConfigSnapshot();
    const backwardCompatibleDefaults = {
      maxEntriesPerSignalWindow: 0,
      maxRiskDataGapSeconds: this.journal.owner.isScalpingMode ? 30 : 0,
      maxAnalysisDataGapSeconds: this.journal.owner.isScalpingMode ? 60 : 0
    };
    const recordedKeys = new Set(Object.keys(recordedSnapshot));
    const currentKeys = new Set(Object.keys(currentSnapshot));
    const missingKeys = [...currentKeys]
      .filter(key => !recordedKeys.has(key));
    const removedKeys = [...recordedKeys]
      .filter(key => !currentKeys.has(key));
    const backwardCompatibleMissing = missingKeys
      .filter(key => Object.prototype.hasOwnProperty.call(backwardCompatibleDefaults, key))
      .sort();
    const schemaDrift = [
      ...missingKeys.filter(key => !backwardCompatibleMissing.includes(key)),
      ...removedKeys
    ].sort();
    const keys = new Set([
      ...Object.keys(recordedSnapshot),
      ...Object.keys(currentSnapshot)
    ]);
    const drift = [...keys]
      .sort()
      .filter(key => {
        const recordedValue = recordedSnapshot[key] === undefined &&
          Object.prototype.hasOwnProperty.call(backwardCompatibleDefaults, key)
          ? backwardCompatibleDefaults[key]
          : recordedSnapshot[key];
        return JSON.stringify(recordedValue) !== JSON.stringify(currentSnapshot[key]);
      });
    const valueDrift = [...keys]
      .filter(key => recordedKeys.has(key) && currentKeys.has(key))
      .sort()
      .filter(key => JSON.stringify(recordedSnapshot[key]) !== JSON.stringify(currentSnapshot[key]));
    return {
      consistent: drift.length === 0,
      drift,
      schemaDrift,
      valueDrift,
      backwardCompatibleMissing
    };
  }

  /**
   * Persist a strict DRY_RUN close so a process restart cannot erase the
   * forward validation trade count or realized P&L.
   */
}
