// PaperValidationJournal — DRY_RUN 페이퍼 검증 장부의 상태와 기록 수명주기.
//
// MultiCoinTrader에서 추출된 모듈로, 다음을 소유한다:
// - paperValidation 원장 상태와 파일 영속화(load/save)
// - 신호/거부/체결 텔레메트리(record*)
// - shadow/looseShadow/winnerShadow 진단 장부
// - 실행 경계·winner 차단 entry의 반사실(counterfactual) 정산
// - 손실 회로차단기·신호 윈도우 엔트리 제한 상태
//
// 트레이더 필드(config/dryRun/upbit/포지션 등)는 owner를 통해 조회한다.
import fs from 'fs';
import { envNumber } from '../config/envConfig.js';
import path from 'path';
import {
  calculateTradeReturnConfidence,
  evaluateStatisticalConfidenceGate
} from '../backtest/tradeConfidence.js';;
import {
  MARKET_QUALITY_DEFAULTS,
  selectFreshMarketCohort
} from '../research/marketQuality.js';
import {
  DEFAULT_PAPER_EXECUTION_MIN_PAIRS,
  evaluatePaperExecutionRobustnessGate,
  summarizePaperExecutionComparison
} from '../research/paperExecutionComparison.js';
import {
  PAPER_EXIT_EVIDENCE_SCHEMA,
  summarizePaperExitEvidence
} from '../research/paperExitEvidence.js';
import { createAnalysisDataHealthState } from '../risk/analysisDataHealth.js';
import {
  createLossCircuitBreakerState,
  getLossCircuitBreakerStatus,
  isLossCircuitCoolingDown,
  registerLoss
} from '../risk/lossCircuitBreaker.js';
import { createRiskMonitorState } from '../risk/riskMonitor.js';
import { calculateCostAdjustedBreakEvenPrice } from '../strategy/protectionPrices.js';

function derivePositionExcursion(position = {}) {
  const entryPrice = Number(position.entryPrice);
  const validEntryPrice = Number.isFinite(entryPrice) && entryPrice > 0 ? entryPrice : null;
  const highestPrice = validEntryPrice === null
    ? null
    : Number.isFinite(Number(position.highestPrice)) && Number(position.highestPrice) > 0
      ? Number(position.highestPrice)
      : validEntryPrice;
  const lowestPrice = validEntryPrice === null
    ? null
    : Number.isFinite(Number(position.lowestPrice)) && Number(position.lowestPrice) > 0
      ? Number(position.lowestPrice)
      : validEntryPrice;
  return {
    highestPrice,
    lowestPrice,
    maxFavorableExcursionPercent: validEntryPrice !== null && highestPrice !== null
      ? ((highestPrice - validEntryPrice) / validEntryPrice) * 100
      : null,
    maxAdverseExcursionPercent: validEntryPrice !== null && lowestPrice !== null
      ? ((lowestPrice - validEntryPrice) / validEntryPrice) * 100
      : null
  };
}

function updatePositionExcursion(position, currentPrice) {
  if (!position || typeof position !== 'object') return derivePositionExcursion(position);
  const latestPrice = Number(currentPrice);
  const entryPrice = Number(position.entryPrice);
  if (Number.isFinite(latestPrice) && latestPrice > 0 && Number.isFinite(entryPrice) && entryPrice > 0) {
    const current = derivePositionExcursion(position);
    position.highestPrice = Math.max(current.highestPrice ?? entryPrice, latestPrice);
    position.lowestPrice = Math.min(current.lowestPrice ?? entryPrice, latestPrice);
  }
  const excursion = derivePositionExcursion(position);
  position.highestPrice = excursion.highestPrice;
  position.lowestPrice = excursion.lowestPrice;
  position.maxFavorableExcursionPercent = excursion.maxFavorableExcursionPercent;
  position.maxAdverseExcursionPercent = excursion.maxAdverseExcursionPercent;
  return excursion;
}

function validTimestamp(value) {
  const timestamp = value instanceof Date ? value.getTime() : new Date(value || 0).getTime();
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function serializePaperSignalEvidence(analysis, observedAt) {
  const rebound = analysis?.decision?.details?.rebound;
  if (!rebound || rebound.available !== true) return null;
  const numericOrNull = value => Number.isFinite(Number(value)) ? Number(value) : null;
  return {
    observedAt,
    signalKey: rebound.signalKey ? String(rebound.signalKey) : null,
    candleTime: rebound.candleTime || null,
    action: analysis?.decision?.action || 'HOLD',
    reason: String(analysis?.decision?.reason || 'unknown').slice(0, 120),
    currentPrice: numericOrNull(analysis?.currentPrice),
    previousRsi: numericOrNull(rebound.previousRsi),
    rsi: numericOrNull(rebound.rsi),
    previousWasOversold: rebound.previousWasOversold === true,
    currentWasOversold: rebound.currentWasOversold === true,
    bullishCandle: rebound.bullishCandle === true,
    reboundPriceChangePercent: numericOrNull(rebound.reboundPriceChangePercent ?? rebound.priceChangePercent),
    rsiRecovery: numericOrNull(rebound.rsiRecovery),
    volumeRatio: numericOrNull(rebound.volumeRatio),
    closeStrength: numericOrNull(rebound.closeStrength),
    trendSlopePercent: numericOrNull(rebound.trendSlopePercent),
    previousHighBreak: rebound.previousHighBreak === true,
    volumeConfirmed: rebound.volumeConfirmed === true,
    volatilityConfirmed: rebound.volatilityConfirmed === true,
    signalRangeFloorConfirmed: rebound.signalRangeFloorConfirmed === true,
    closeStrengthConfirmed: rebound.closeStrengthConfirmed === true,
    trendConfirmed: rebound.trendConfirmed === true,
    previousHighBreakConfirmed: rebound.previousHighBreakConfirmed === true,
    reboundConfirmed: rebound.reboundConfirmed === true,
    signalProfile: rebound.signalProfile || null,
    rejectionReasons: [...new Set(Array.isArray(rebound.rejectionReasons) ? rebound.rejectionReasons : [])]
      .map(reason => String(reason).slice(0, 80))
      .slice(0, 12)
  };
}

function hydrateLossCircuitBreakerState(existingState, historicalLossTimes, config) {
  const state = existingState && typeof existingState === 'object'
    ? existingState
    : createLossCircuitBreakerState();
  const timestamps = [
    ...(Array.isArray(state.lossTimestamps) ? state.lossTimestamps : []),
    ...(Array.isArray(historicalLossTimes) ? historicalLossTimes : [])
  ]
    .map(validTimestamp)
    .filter(timestamp => timestamp !== null);
  state.lossTimestamps = [...new Set(timestamps)].sort((a, b) => a - b).slice(-2000);
  state.cooldownUntil = Math.max(0, Number(state.cooldownUntil) || 0);

  const circuitConfig = resolveLossCircuitBreakerConfig(config);
  if (circuitConfig.maxLosses > 0) {
    const now = Date.now();
    const windowMs = circuitConfig.windowMinutes * 60 * 1000;
    state.lossTimestamps = state.lossTimestamps.filter(timestamp => timestamp > now - windowMs);
    if (state.lossTimestamps.length >= circuitConfig.maxLosses) {
      const latestLoss = state.lossTimestamps.at(-1);
      state.cooldownUntil = Math.max(
        state.cooldownUntil,
        latestLoss + circuitConfig.cooldownMinutes * 60 * 1000
      );
    }
  }

  return state;
}

function normalizeSignalWindowEntryCounts(existing) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) return {};
  return Object.fromEntries(
    Object.entries(existing)
      .filter(([, count]) => Number.isFinite(Number(count)) && Number(count) > 0)
      .map(([signalKey, count]) => [signalKey, Math.floor(Number(count))])
      .slice(-2000)
  );
}

export function resolveSignalWindowEntryLimit(config = {}) {
  const configuredLimit = Number(config.maxEntriesPerSignalWindow);
  return Number.isFinite(configuredLimit) && configuredLimit > 0
    ? Math.min(100, Math.max(1, Math.floor(configuredLimit)))
    : 0;
}

function resolveLossCircuitBreakerConfig(config = {}) {
  const configuredCount = Number(config.lossCircuitBreakerCount);
  const configuredWindow = Number(config.lossCircuitBreakerWindowMinutes);
  const configuredCooldown = Number(config.lossCircuitBreakerCooldownMinutes);
  return {
    maxLosses: Number.isFinite(configuredCount) && configuredCount > 0
      ? Math.max(1, Math.floor(configuredCount))
      : 0,
    windowMinutes: Number.isFinite(configuredWindow) && configuredWindow > 0
      ? configuredWindow
      : 30,
    cooldownMinutes: Number.isFinite(configuredCooldown) && configuredCooldown > 0
      ? configuredCooldown
      : 60
  };
}

function inspectShadowEntryExecution(analysis, maxRetracePercent, maxChasePercent) {
  const rebound = analysis?.decision?.details?.rebound;
  const currentPrice = Number(analysis?.currentPrice);
  const referencePrice = Number(rebound?.referencePrice);
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return { valid: false, enforceable: true, reason: 'entry_price_invalid' };
  }
  // Some legacy diagnostic fixtures do not carry a rebound reference price.
  // Keep those rows observable rather than fabricating a drift value; the
  // strict BUY path always supplies a reference before execution.
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
    return { valid: true, enforceable: false, reason: 'entry_reference_price_unavailable' };
  }

  const retracePercent = ((referencePrice - currentPrice) / referencePrice) * 100;
  if (retracePercent > maxRetracePercent) {
    return {
      valid: false,
      enforceable: true,
      reason: 'entry_retrace_exceeded',
      retracePercent,
      chasePercent: ((currentPrice - referencePrice) / referencePrice) * 100
    };
  }

  const chasePercent = ((currentPrice - referencePrice) / referencePrice) * 100;
  if (chasePercent > maxChasePercent) {
    return {
      valid: false,
      enforceable: true,
      reason: 'entry_chase_exceeded',
      retracePercent,
      chasePercent
    };
  }

  return { valid: true, enforceable: true, reason: null, retracePercent, chasePercent };
}

export class PaperValidationJournal {
  constructor(owner) {
    this.owner = owner;
    this.paperValidation = null;
    this.paperValidationFile = null;
    this.paperMinimumStorageMiB = 1024;
    this.runtimeSignalWindowEntryCounts = new Map();
  }


  loadPaperValidation() {
    if (!this.owner.dryRun || !this.paperValidationFile || !fs.existsSync(this.paperValidationFile)) {
      return null;
    }

    try {
      const data = JSON.parse(fs.readFileSync(this.paperValidationFile, 'utf8'));
      let strictTradeSchemaMigrated = false;
      if (Array.isArray(data.strictTrades)) {
        data.strictTrades = data.strictTrades.map(trade => {
          const isClose = trade?.action === 'CLOSE' || trade?.action === 'PARTIAL_CLOSE';
          if (isClose && trade.type !== 'CLOSE') {
            strictTradeSchemaMigrated = true;
            return { ...trade, type: 'CLOSE' };
          }
          return trade;
        });
        if (strictTradeSchemaMigrated) {
          data.strictTradeSchemaMigratedAt = new Date().toISOString();
        }
      }
      const cooldownAfterLossMinutes = Number(this.owner.config.cooldownAfterLossMinutes) || 15;
      const maxConsecutiveLosses = Number(this.owner.config.maxConsecutiveLosses) || 3;
      const cooldownUntilByCoin = {};
      const consecutiveLossesByCoin = {};
      const historicalCloses = (Array.isArray(data.strictTrades) ? data.strictTrades : [])
        .filter(trade => (trade?.action === 'CLOSE' || trade?.action === 'PARTIAL_CLOSE') && trade.coin)
        .sort((a, b) => new Date(a.exitTime || 0) - new Date(b.exitTime || 0));
      const historicalLossTimes = [];
      for (const trade of historicalCloses) {
        const coin = trade.coin;
        const profit = Number(trade.profit) || 0;
        if (profit < 0) {
          const consecutiveLosses = (Number(consecutiveLossesByCoin[coin]) || 0) + 1;
          const cooldownMinutes = consecutiveLosses >= maxConsecutiveLosses
            ? Math.max(cooldownAfterLossMinutes, 60)
            : cooldownAfterLossMinutes;
          consecutiveLossesByCoin[coin] = consecutiveLosses;
          const exitTime = validTimestamp(trade.exitTime);
          if (exitTime !== null) {
            historicalLossTimes.push(exitTime);
            cooldownUntilByCoin[coin] = exitTime + cooldownMinutes * 60 * 1000;
          } else {
            cooldownUntilByCoin[coin] = 0;
          }
        } else {
          consecutiveLossesByCoin[coin] = 0;
          cooldownUntilByCoin[coin] = 0;
        }
      }

      const hadRiskState = data.strictRiskState && typeof data.strictRiskState === 'object';
      const riskState = hadRiskState
        ? data.strictRiskState
        : { cooldownUntilByCoin, consecutiveLossesByCoin };
      riskState.cooldownUntilByCoin = riskState.cooldownUntilByCoin || cooldownUntilByCoin;
      riskState.consecutiveLossesByCoin = riskState.consecutiveLossesByCoin || consecutiveLossesByCoin;
      const hadCircuitState = riskState.lossCircuitBreaker && typeof riskState.lossCircuitBreaker === 'object';
      const hadSignalWindowState = riskState.signalWindowEntryCountsByKey &&
        typeof riskState.signalWindowEntryCountsByKey === 'object' &&
        !Array.isArray(riskState.signalWindowEntryCountsByKey);
      riskState.signalWindowEntryCountsByKey = normalizeSignalWindowEntryCounts(
        riskState.signalWindowEntryCountsByKey
      );
      riskState.lossCircuitBreaker = hydrateLossCircuitBreakerState(
        riskState.lossCircuitBreaker,
        historicalLossTimes,
        this.owner.config
      );
      data.strictRiskState = riskState;
      if (!hadRiskState || !hadCircuitState || !hadSignalWindowState) {
        data.strictRiskStateMigratedAt = new Date().toISOString();
      }
      for (const stateKey of ['shadow', 'looseShadow', 'winnerShadow']) {
        const shadow = data[stateKey];
        if (!shadow || typeof shadow !== 'object') continue;
        if (stateKey !== 'winnerShadow') {
          shadow.executionBoundaryBlockedEntries = Array.isArray(shadow.executionBoundaryBlockedEntries)
            ? shadow.executionBoundaryBlockedEntries
            : [];
        }
        const shadowLossTimes = (Array.isArray(shadow.closedTrades) ? shadow.closedTrades : [])
          .filter(trade => Number(trade?.netProfit) < 0)
          .map(trade => trade.exitTimestamp || trade.exitTime)
          .map(validTimestamp)
          .filter(timestamp => timestamp !== null);
        shadow.lossCircuitBreaker = hydrateLossCircuitBreakerState(
          shadow.lossCircuitBreaker,
          shadowLossTimes,
          this.owner.config
        );
      }
      return data;
    } catch (error) {
      console.log('⚠️  Paper validation ledger 로드 실패:', error.message);
      return null;
    }
  }


  savePaperValidation() {
    if (!this.owner.dryRun || !this.paperValidation) return;
    this.owner.writeJsonAtomically(this.paperValidationFile, this.paperValidation);
  }


  getStorageStatus() {
    const minimumBytes = this.paperMinimumStorageMiB * 1024 * 1024;
    try {
      if (typeof fs.statfsSync !== 'function') {
        return { available: false, healthy: true, minimumBytes };
      }
      const ledgerDirectory = path.dirname(path.resolve(this.paperValidationFile));
      const stats = fs.statfsSync(ledgerDirectory);
      const availableBytes = Number(stats.bavail) * Number(stats.bsize);
      return {
        available: Number.isFinite(availableBytes),
        healthy: Number.isFinite(availableBytes) && availableBytes >= minimumBytes,
        availableBytes,
        availableMiB: Number.isFinite(availableBytes) ? availableBytes / 1024 / 1024 : null,
        minimumBytes,
        minimumMiB: minimumBytes / 1024 / 1024
      };
    } catch (error) {
      return {
        available: false,
        healthy: false,
        minimumBytes,
        error: error.message
      };
    }
  }


  isProcessAlive(processId) {
    const pid = Number(processId);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (pid === process.pid) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }


  getPaperValidationConfigSnapshot() {
    const config = this.owner.config || {};
    const numericOrNull = value => value === null || value === undefined || value === ''
      ? null
      : Number.isFinite(Number(value)) ? Number(value) : null;
    const lossCircuitConfig = resolveLossCircuitBreakerConfig(config);
    return {
      strategyMode: this.owner.strategyMode,
      signalProfile: config.signalProfile || 'rsi_rebound',
      targetCoins: [...this.owner.targetCoins].sort(),
      candleUnit: numericOrNull(this.owner.candleUnit),
      candleCount: numericOrNull(this.owner.candleCount),
      maxCandleAgeSeconds: numericOrNull(this.owner.maxCandleAgeSeconds),
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
      investmentRatio: numericOrNull(this.owner.investmentRatio ?? config.investmentRatio),
      tradingFee: numericOrNull(config.tradingFee ?? 0.0005),
      slippage: numericOrNull(config.slippage ?? 0.001),
      maxPositions: numericOrNull(this.owner.maxPositions),
      portfolioAllocation: numericOrNull(this.owner.portfolioAllocation),
      bbPeriod: numericOrNull(config.bbPeriod || 20),
      bbStdDev: numericOrNull(config.bbStdDev || 2),
      emaPeriod: numericOrNull(config.emaLong || 20),
      requireNextCandleBullish: config.requireNextCandleBullish === true,
      entryDelayMinMs: numericOrNull(config.entryDelayMinMs),
      entryDelayMaxMs: numericOrNull(config.entryDelayMaxMs),
      maxRiskDataGapSeconds: numericOrNull(this.owner.maxRiskDataGapSeconds),
      maxAnalysisDataGapSeconds: numericOrNull(this.owner.maxAnalysisDataGapSeconds),
      maxEntryRetracePercent: numericOrNull(config.maxEntryRetracePercent),
      maxEntryChasePercent: numericOrNull(config.maxEntryChasePercent),
      breakEvenTriggerPercent: numericOrNull(config.breakEvenTriggerPercent),
      breakEvenOffsetPercent: numericOrNull(config.breakEvenOffsetPercent),
      trailingActivationPercent: numericOrNull(config.trailingActivationPercent),
      trailingStopPercent: numericOrNull(config.trailingStopPercent),
      positionRiskCheckIntervalMs: numericOrNull(this.owner.positionRiskCheckIntervalMs)
    };
  }


  getPaperExperimentSnapshot() {
    const winnerShadowEnabled = this.owner.winnerShadowExtendMinutes > 0 || this.owner.winnerShadowMaxReboundPercent > 0;
    return {
      diagnosticShadows: {
        enabled: this.owner.paperDiagnosticShadowsEnabled
      },
      winnerShadow: {
        enabled: winnerShadowEnabled,
        entryContract: this.owner.winnerShadowMaxReboundPercent > 0
          ? 'strict_confirmed_buy_signal_with_optional_rebound_ceiling'
          : 'strict_confirmed_buy_signal',
        winnerExtendMinutes: this.owner.winnerShadowExtendMinutes,
        winnerExtendMinProfitPercent: this.owner.winnerShadowExtendMinProfitPercent,
        entryMaxReboundPercent: this.owner.winnerShadowMaxReboundPercent
      }
    };
  }


  comparePaperExperimentConfig(recordedSnapshot) {
    const current = this.owner.getPaperExperimentSnapshot();
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
    const config = this.owner.config || {};
    const numberOr = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
    const baselineAssets = Number(this.paperValidation?.baselineAssets);
    const investmentRatio = Number.isFinite(Number(this.owner.investmentRatio))
      ? Number(this.owner.investmentRatio)
      : numberOr(config.investmentRatio, 0.02);
    return {
      baselineAssets: Number.isFinite(baselineAssets) && baselineAssets > 0
        ? baselineAssets
        : numberOr(this.owner.initialSeedMoney, 1_000_000),
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
  recordExecutionBoundaryBlockedEntry(analysis, stateKey, reason, timestamp = new Date().toISOString()) {
    if (!this.owner.dryRun || !this.paperValidation?.active || !['shadow', 'looseShadow'].includes(stateKey)) return false;
    const coin = analysis?.coin;
    const rebound = analysis?.decision?.details?.rebound;
    const signalKey = rebound?.signalKey ? String(rebound.signalKey) : '';
    const currentPrice = Number(analysis?.currentPrice);
    if (!coin || !signalKey || !Number.isFinite(currentPrice) || currentPrice <= 0) return false;

    const shadow = this.paperValidation[stateKey] || {};
    shadow.executionBoundaryBlockedEntries = Array.isArray(shadow.executionBoundaryBlockedEntries)
      ? shadow.executionBoundaryBlockedEntries
      : [];
    const key = `${coin}:${signalKey}`;
    if (shadow.executionBoundaryBlockedEntries.some(entry => entry.key === key)) {
      this.paperValidation[stateKey] = shadow;
      return false;
    }

    const counterfactualConfig = this.owner.getExecutionBoundaryCounterfactualConfig();
    const referencePrice = Number(rebound.referencePrice);
    const retracePercent = Number.isFinite(referencePrice) && referencePrice > 0
      ? ((referencePrice - currentPrice) / referencePrice) * 100
      : null;
    const chasePercent = Number.isFinite(referencePrice) && referencePrice > 0
      ? ((currentPrice - referencePrice) / referencePrice) * 100
      : null;
    const investAmount = Math.min(
      counterfactualConfig.baselineAssets * counterfactualConfig.investmentRatio,
      counterfactualConfig.baselineAssets * 0.95
    );
    const entryPrice = currentPrice * (1 + counterfactualConfig.slippage);
    shadow.executionBoundaryBlockedEntries.push({
      key,
      coin,
      signalKey,
      blockedAt: new Date(timestamp).toISOString(),
      status: 'pending',
      blockedReason: String(reason || 'entry_boundary_exceeded'),
      entryPrice,
      investAmount,
      signalTime: rebound.candleTime || null,
      signalReferencePrice: Number.isFinite(referencePrice) && referencePrice > 0 ? referencePrice : null,
      signalReboundPercent: Number(rebound.reboundPriceChangePercent ?? rebound.priceChangePercent) || null,
      signalRsi: Number(rebound.rsi) || null,
      signalOversoldRsi: Number(rebound.oversoldRsi ?? rebound.previousRsi) || null,
      signalRsiRecovery: Number(rebound.rsiRecovery) || null,
      signalVolumeRatio: Number(rebound.volumeRatio) || null,
      signalCloseStrength: Number(rebound.closeStrength) || null,
      signalTrendSlopePercent: Number(rebound.trendSlopePercent) || null,
      signalRangePercent: Number(rebound.signalRangePercent) || null,
      executionBoundary: {
        retracePercent,
        chasePercent,
        maxRetracePercent: Number(this.owner.maxEntryRetracePercent) || 0.25,
        maxChasePercent: Number(this.owner.config.maxEntryChasePercent) || 0.35
      },
      tradingFee: counterfactualConfig.tradingFee,
      slippage: counterfactualConfig.slippage,
      stopLossPercent: counterfactualConfig.stopLossPercent,
      takeProfitPercent: counterfactualConfig.takeProfitPercent,
      maxHoldMinutes: counterfactualConfig.maxHoldMinutes,
      highestPrice: currentPrice,
      lowestPrice: currentPrice,
      maxFavorableExcursionPercent: 0,
      maxAdverseExcursionPercent: 0,
      lastPrice: currentPrice,
      lastObservedAt: new Date(timestamp).toISOString(),
      counterfactual: null
    });
    shadow.executionBoundaryBlockedEntries = shadow.executionBoundaryBlockedEntries.slice(-1000);
    this.paperValidation[stateKey] = shadow;
    return true;
  }

  /**
   * Advance pending boundary counterfactuals using only later fresh prices.
   * Settled values stay outside shadow/loose realized P&L and promotion stats.
   */
  updateExecutionBoundaryBlockedEntries(analysis, stateKey, timestamp = new Date().toISOString()) {
    if (!this.owner.dryRun || !this.paperValidation?.active || !['shadow', 'looseShadow'].includes(stateKey)) return 0;
    const shadow = this.paperValidation[stateKey];
    if (!shadow || !Array.isArray(shadow.executionBoundaryBlockedEntries)) return 0;
    const currentPrice = Number(analysis?.currentPrice);
    const coin = analysis?.coin;
    const nowMs = validTimestamp(timestamp) || Date.now();
    if (!coin || !Number.isFinite(currentPrice) || currentPrice <= 0) return 0;

    let settledCount = 0;
    for (const entry of shadow.executionBoundaryBlockedEntries) {
      if (entry?.status !== 'pending' || entry.coin !== coin) continue;
      const blockedAtMs = validTimestamp(entry.blockedAt);
      if (blockedAtMs === null || nowMs <= blockedAtMs) continue;

      updatePositionExcursion(entry, currentPrice);
      entry.lastPrice = currentPrice;
      entry.lastObservedAt = new Date(nowMs).toISOString();
      const entryPrice = Number(entry.entryPrice);
      const tradingFee = Number.isFinite(Number(entry.tradingFee)) ? Number(entry.tradingFee) : 0.0005;
      const slippage = Number.isFinite(Number(entry.slippage)) ? Number(entry.slippage) : 0.001;
      const stopLossPercent = Number(entry.stopLossPercent) || 0;
      const takeProfitPercent = Number(entry.takeProfitPercent) || 0;
      const maxHoldMinutes = Number(entry.maxHoldMinutes) || 0;
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) continue;

      let exitReason = null;
      if (stopLossPercent > 0 && currentPrice <= entryPrice * (1 - stopLossPercent / 100)) {
        exitReason = 'STOP_LOSS';
      } else if (takeProfitPercent > 0 && currentPrice >= entryPrice * (1 + takeProfitPercent / 100)) {
        exitReason = 'TAKE_PROFIT';
      } else if (maxHoldMinutes > 0 && nowMs - blockedAtMs >= maxHoldMinutes * 60 * 1000) {
        exitReason = 'MAX_HOLD_TIME';
      }
      if (!exitReason) continue;

      const investAmount = Number(entry.investAmount);
      if (!Number.isFinite(investAmount) || investAmount <= 0) {
        entry.status = 'unresolved';
        entry.resolvedAt = new Date(nowMs).toISOString();
        entry.resolution = 'invalid_counterfactual_investment';
        continue;
      }
      const buyFee = investAmount * tradingFee;
      const amount = (investAmount - buyFee) / entryPrice;
      const exitPrice = currentPrice * (1 - slippage);
      const grossAmount = amount * exitPrice;
      const sellFee = grossAmount * tradingFee;
      const netProfit = grossAmount - sellFee - investAmount;
      entry.status = 'settled';
      entry.settledAt = new Date(nowMs).toISOString();
      entry.counterfactual = {
        exitReason,
        exitMarketPrice: currentPrice,
        exitPrice,
        buyFee,
        sellFee,
        netProfit,
        profitPercent: (netProfit / investAmount) * 100,
        maxFavorableExcursionPercent: entry.maxFavorableExcursionPercent,
        maxAdverseExcursionPercent: entry.maxAdverseExcursionPercent
      };
      settledCount += 1;
    }
    this.paperValidation[stateKey] = shadow;
    return settledCount;
  }


  resolveExecutionBoundaryBlockedEntriesAtStop(timestamp = new Date().toISOString()) {
    if (!this.paperValidation) return 0;
    let resolvedCount = 0;
    for (const stateKey of ['shadow', 'looseShadow']) {
      const shadow = this.paperValidation[stateKey];
      if (!shadow || !Array.isArray(shadow.executionBoundaryBlockedEntries)) continue;
      for (const entry of shadow.executionBoundaryBlockedEntries) {
        if (entry.status !== 'pending') continue;
        entry.status = 'unresolved';
        entry.resolvedAt = new Date(timestamp).toISOString();
        entry.resolution = 'session_stopped_before_counterfactual_exit';
        entry.counterfactual = null;
        resolvedCount += 1;
      }
    }
    return resolvedCount;
  }


  getExecutionBoundaryBlockedEntrySummary(shadow = {}) {
    const entries = Array.isArray(shadow.executionBoundaryBlockedEntries)
      ? shadow.executionBoundaryBlockedEntries
      : [];
    const settled = entries.filter(entry => entry.status === 'settled' && entry.counterfactual);
    const pending = entries.filter(entry => entry.status === 'pending');
    const unresolved = entries.filter(entry => entry.status === 'unresolved');
    const counterfactualRealizedProfit = settled.reduce(
      (sum, entry) => sum + (Number(entry.counterfactual?.netProfit) || 0),
      0
    );
    const winners = settled.filter(entry => Number(entry.counterfactual?.netProfit) > 0).length;
    const losers = settled.length - winners;
    const grossProfit = settled
      .filter(entry => Number(entry.counterfactual?.netProfit) > 0)
      .reduce((sum, entry) => sum + Number(entry.counterfactual.netProfit), 0);
    const grossLoss = Math.abs(settled
      .filter(entry => Number(entry.counterfactual?.netProfit) <= 0)
      .reduce((sum, entry) => sum + Number(entry.counterfactual.netProfit), 0));
    const counterfactualLossEntries = settled
      .filter(entry => Number(entry.counterfactual?.netProfit) < 0);
    const counterfactualProfitEntries = settled
      .filter(entry => Number(entry.counterfactual?.netProfit) > 0);
    const reasonGroups = new Map();
    for (const entry of entries) {
      const reason = String(entry.blockedReason || 'unknown');
      const group = reasonGroups.get(reason) || {
        reason,
        blockedCount: 0,
        pendingCount: 0,
        settledCount: 0,
        unresolvedCount: 0,
        counterfactualRealizedProfit: 0
      };
      group.blockedCount += 1;
      if (entry.status === 'pending') group.pendingCount += 1;
      if (entry.status === 'unresolved') group.unresolvedCount += 1;
      if (entry.status === 'settled' && entry.counterfactual) {
        group.settledCount += 1;
        group.counterfactualRealizedProfit += Number(entry.counterfactual.netProfit) || 0;
      }
      reasonGroups.set(reason, group);
    }
    return {
      blockedEntryCount: entries.length,
      pendingCount: pending.length,
      settledCount: settled.length,
      unresolvedCount: unresolved.length,
      counterfactualRealizedProfit,
      counterfactualWinningTrades: winners,
      counterfactualLosingTrades: losers,
      counterfactualWinRate: settled.length > 0 ? (winners / settled.length) * 100 : 0,
      counterfactualProfitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
      counterfactualLossAvoidanceCount: counterfactualLossEntries.length,
      counterfactualLossAvoidanceAmount: Math.abs(counterfactualLossEntries.reduce(
        (sum, entry) => sum + Number(entry.counterfactual.netProfit),
        0
      )),
      counterfactualMissedProfitCount: counterfactualProfitEntries.length,
      counterfactualMissedProfitAmount: counterfactualProfitEntries.reduce(
        (sum, entry) => sum + Number(entry.counterfactual.netProfit),
        0
      ),
      reasonOutcomes: [...reasonGroups.values()]
        .sort((a, b) => b.blockedCount - a.blockedCount || a.reason.localeCompare(b.reason)),
      recentEntries: entries.slice(-5).map(entry => ({
        key: entry.key,
        coin: entry.coin,
        status: entry.status,
        blockedAt: entry.blockedAt,
        blockedReason: entry.blockedReason,
        executionBoundary: entry.executionBoundary,
        counterfactual: entry.counterfactual,
        maxFavorableExcursionPercent: entry.maxFavorableExcursionPercent,
        maxAdverseExcursionPercent: entry.maxAdverseExcursionPercent
      }))
    };
  }


  recordWinnerShadowBlockedEntry(analysis, timestamp = new Date().toISOString()) {
    if (!this.owner.dryRun || !this.paperValidation?.active || this.owner.winnerShadowMaxReboundPercent <= 0) return;
    const coin = analysis?.coin;
    const rebound = analysis?.decision?.details?.rebound;
    const signalKey = rebound?.signalKey ? String(rebound.signalKey) : '';
    const currentPrice = Number(analysis?.currentPrice);
    if (!coin || !signalKey || !Number.isFinite(currentPrice) || currentPrice <= 0) return;

    const shadow = this.paperValidation.winnerShadow || {};
    shadow.blockedEntries = Array.isArray(shadow.blockedEntries) ? shadow.blockedEntries : [];
    const key = `${coin}:${signalKey}`;
    if (shadow.blockedEntries.some(entry => entry.key === key)) {
      this.paperValidation.winnerShadow = shadow;
      return;
    }
    const tradingFee = Number.isFinite(Number(this.owner.config.tradingFee))
      ? Number(this.owner.config.tradingFee)
      : 0.0005;
    const slippage = Number.isFinite(Number(this.owner.config.slippage))
      ? Number(this.owner.config.slippage)
      : 0.001;
    const baselineAssets = Number(this.paperValidation.baselineAssets) || this.owner.initialSeedMoney;
    const investmentRatio = Number.isFinite(Number(this.owner.investmentRatio))
      ? Number(this.owner.investmentRatio)
      : 0.02;
    const investAmount = Math.min(baselineAssets * investmentRatio, baselineAssets * 0.95);
    shadow.blockedEntries.push({
      key,
      coin,
      signalKey,
      blockedAt: timestamp,
      status: 'pending',
      entryPrice: currentPrice * (1 + slippage),
      investAmount,
      signalTime: rebound.candleTime || null,
      signalReboundPercent: Number(rebound.reboundPriceChangePercent ?? rebound.priceChangePercent) || null,
      signalRsi: Number(rebound.rsi) || null,
      signalOversoldRsi: Number(rebound.oversoldRsi ?? rebound.previousRsi) || null,
      signalRsiRecovery: Number(rebound.rsiRecovery) || null,
      signalVolumeRatio: Number(rebound.volumeRatio) || null,
      signalCloseStrength: Number(rebound.closeStrength) || null,
      signalTrendSlopePercent: Number(rebound.trendSlopePercent) || null,
      signalRangePercent: Number(rebound.signalRangePercent) || null,
      counterfactual: null,
      tradingFee,
      slippage
    });
    shadow.blockedEntries = shadow.blockedEntries.slice(-1000);
    this.paperValidation.winnerShadow = shadow;
  }


  settleWinnerShadowBlockedEntries(coin, trade) {
    if (!this.owner.dryRun || !this.paperValidation?.active || !coin || !trade) return 0;
    const shadow = this.paperValidation.winnerShadow;
    if (!shadow || !Array.isArray(shadow.blockedEntries)) return 0;
    const signalKey = trade.signalKey ? String(trade.signalKey) : '';
    const exitMarketPrice = Number(trade.exitPrice);
    if (!signalKey || !Number.isFinite(exitMarketPrice) || exitMarketPrice <= 0) return 0;
    const settledAt = new Date(trade.exitTime || Date.now()).toISOString();
    let settledCount = 0;
    for (const entry of shadow.blockedEntries) {
      if (entry.status !== 'pending' || entry.coin !== coin || entry.signalKey !== signalKey) continue;
      const entryPrice = Number(entry.entryPrice);
      const investAmount = Number(entry.investAmount);
      const tradingFee = Number.isFinite(Number(entry.tradingFee)) ? Number(entry.tradingFee) : 0.0005;
      const slippage = Number.isFinite(Number(entry.slippage)) ? Number(entry.slippage) : 0.001;
      if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(investAmount) || investAmount <= 0) continue;
      const buyFee = investAmount * tradingFee;
      const amount = (investAmount - buyFee) / entryPrice;
      const exitPrice = exitMarketPrice * (1 - slippage);
      const grossAmount = amount * exitPrice;
      const sellFee = grossAmount * tradingFee;
      const netProfit = grossAmount - sellFee - investAmount;
      entry.status = 'settled';
      entry.settledAt = settledAt;
      entry.counterfactual = {
        exitReason: trade.reason || 'STRICT_EXIT',
        strictExitTimestamp: settledAt,
        exitMarketPrice,
        exitPrice,
        netProfit,
        profitPercent: (netProfit / investAmount) * 100,
        strictNetProfit: Number.isFinite(Number(trade.profit)) ? Number(trade.profit) : null,
        deltaVsStrict: Number.isFinite(Number(trade.profit)) ? netProfit - Number(trade.profit) : null
      };
      settledCount += 1;
    }
    return settledCount;
  }


  resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, reason, timestamp = new Date().toISOString()) {
    if (!this.owner.dryRun || !this.paperValidation?.active || !coin) return 0;
    const signalKey = decision?.entrySignalKey || decision?.details?.rebound?.signalKey;
    if (!signalKey) return 0;
    const shadow = this.paperValidation.winnerShadow;
    if (!shadow || !Array.isArray(shadow.blockedEntries)) return 0;
    const resolvedAt = new Date(timestamp).toISOString();
    const resolutionReason = String(reason || 'strict_entry_not_filled').slice(0, 160);
    let resolvedCount = 0;
    for (const entry of shadow.blockedEntries) {
      if (entry.status !== 'pending' || entry.coin !== coin || entry.signalKey !== String(signalKey)) continue;
      entry.status = 'not_filled';
      entry.resolvedAt = resolvedAt;
      entry.resolution = 'strict_entry_not_filled';
      entry.resolutionReason = resolutionReason;
      entry.counterfactual = null;
      resolvedCount += 1;
    }
    if (resolvedCount > 0) {
      this.paperValidation.winnerShadow = shadow;
      this.owner.savePaperValidation();
    }
    return resolvedCount;
  }


  comparePaperValidationConfig(recordedSnapshot) {
    if (!recordedSnapshot || typeof recordedSnapshot !== 'object') {
      return { consistent: null, drift: ['config_snapshot_missing'] };
    }

    const currentSnapshot = this.owner.getPaperValidationConfigSnapshot();
    const backwardCompatibleDefaults = {
      maxEntriesPerSignalWindow: 0,
      maxRiskDataGapSeconds: this.owner.isScalpingMode ? 30 : 0,
      maxAnalysisDataGapSeconds: this.owner.isScalpingMode ? 60 : 0
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
  recordPaperStrictTrade(coin, trade, action = 'CLOSE') {
    if (!this.owner.dryRun || !trade) return;
    if (!this.paperValidation?.active) {
      // The forward ledger is optional. Keep the runtime safety brake active
      // for ordinary DRY_RUN sessions even when no paper session is recording.
      this.owner.registerRuntimeLoss(trade);
      return;
    }

    const exitTime = new Date(trade.exitTime || Date.now()).toISOString();
    const entryTime = trade.entryTime
      ? new Date(trade.entryTime).toISOString()
      : null;
    const ledgerKey = `${coin}:${trade.id ?? 'no-id'}:${exitTime}:${action}`;
    const strictTrades = Array.isArray(this.paperValidation.strictTrades)
      ? this.paperValidation.strictTrades
      : [];
    if (strictTrades.some(item => item.ledgerKey === ledgerKey)) return;

    strictTrades.push({
      ...trade,
      type: action === 'CLOSE' || action === 'PARTIAL_CLOSE' ? 'CLOSE' : trade.type,
      action,
      coin,
      entryTime,
      exitTime,
      ledgerKey
    });
    this.paperValidation.strictTrades = strictTrades.slice(-2000);
    this.owner.settleWinnerShadowBlockedEntries(coin, trade);
    this.owner.registerRuntimeLoss({
      ...trade,
      exitTime
    });
    const strategy = this.owner.strategies.get(coin);
    if (strategy) this.owner.persistPaperStrategyRiskState(coin, strategy);
    // A strict risk-monitor close happens outside the normal analysis cycle.
    // Refresh the durable snapshot before saving so a crash/restart between
    // this close and the next cycle cannot resurrect the already-closed
    // position from a stale strictOpenPositions array.
    this.paperValidation.strictOpenPositions = this.owner.getStrictOpenPositionSnapshot();
    this.owner.savePaperValidation();
  }


  applyPaperStrategyRiskState(coin, strategy) {
    if (!strategy || !this.paperValidation?.strictRiskState) return;
    const riskState = this.paperValidation.strictRiskState;
    const cooldownUntil = Number(riskState.cooldownUntilByCoin?.[coin]);
    const consecutiveLosses = Number(riskState.consecutiveLossesByCoin?.[coin]);
    if (Number.isFinite(cooldownUntil)) strategy.cooldownUntil = cooldownUntil;
    if (Number.isFinite(consecutiveLosses)) strategy.consecutiveLosses = consecutiveLosses;
  }


  restorePaperStrategyRiskState() {
    if (!this.paperValidation?.strictRiskState) return;
    for (const [coin, strategy] of this.owner.strategies.entries()) {
      this.owner.applyPaperStrategyRiskState(coin, strategy);
    }
  }


  persistPaperStrategyRiskState(coin, strategy) {
    if (!this.paperValidation || !strategy) return;
    const riskState = this.paperValidation.strictRiskState || {
      cooldownUntilByCoin: {},
      consecutiveLossesByCoin: {},
      signalWindowEntryCountsByKey: {},
      lossCircuitBreaker: createLossCircuitBreakerState()
    };
    riskState.cooldownUntilByCoin = riskState.cooldownUntilByCoin || {};
    riskState.consecutiveLossesByCoin = riskState.consecutiveLossesByCoin || {};
    riskState.lossCircuitBreaker = riskState.lossCircuitBreaker || createLossCircuitBreakerState();
    riskState.cooldownUntilByCoin[coin] = Number(strategy.cooldownUntil) || 0;
    riskState.consecutiveLossesByCoin[coin] = Number(strategy.consecutiveLosses) || 0;
    this.paperValidation.strictRiskState = riskState;
  }


  getLossCircuitBreakerConfig() {
    return resolveLossCircuitBreakerConfig(this.owner.config);
  }


  getStrictLossCircuitBreakerState() {
    if (this.owner.dryRun && this.paperValidation) {
      const riskState = this.paperValidation.strictRiskState || {
        cooldownUntilByCoin: {},
        consecutiveLossesByCoin: {},
        signalWindowEntryCountsByKey: {},
        lossCircuitBreaker: createLossCircuitBreakerState()
      };
      riskState.lossCircuitBreaker = riskState.lossCircuitBreaker || createLossCircuitBreakerState();
      this.paperValidation.strictRiskState = riskState;
      return riskState.lossCircuitBreaker;
    }
    return this.owner.lossCircuitBreaker;
  }


  getLossCircuitBreakerStatus(stateKey = 'strict') {
    let state;
    if (stateKey === 'strict') {
      state = this.owner.getStrictLossCircuitBreakerState();
    } else {
      state = this.paperValidation?.[stateKey]?.lossCircuitBreaker || null;
    }
    return getLossCircuitBreakerStatus(state, Date.now(), this.owner.getLossCircuitBreakerConfig());
  }


  isStrictEntryBlockedByLossCircuit(now = Date.now()) {
    return isLossCircuitCoolingDown(
      this.owner.getStrictLossCircuitBreakerState(),
      now,
      this.owner.getLossCircuitBreakerConfig()
    );
  }


  getStrictSignalWindowEntryCounts() {
    if (this.owner.dryRun && this.paperValidation) {
      const riskState = this.paperValidation.strictRiskState || {
        cooldownUntilByCoin: {},
        consecutiveLossesByCoin: {},
        signalWindowEntryCountsByKey: {},
        lossCircuitBreaker: createLossCircuitBreakerState()
      };
      riskState.signalWindowEntryCountsByKey = normalizeSignalWindowEntryCounts(
        riskState.signalWindowEntryCountsByKey
      );
      this.paperValidation.strictRiskState = riskState;
      return riskState.signalWindowEntryCountsByKey;
    }

    if (!(this.runtimeSignalWindowEntryCounts instanceof Map)) {
      this.runtimeSignalWindowEntryCounts = new Map();
    }
    return Object.fromEntries(this.runtimeSignalWindowEntryCounts.entries());
  }


  getStrictSignalWindowEntryCount(signalKey) {
    if (!signalKey) return 0;
    const counts = this.owner.getStrictSignalWindowEntryCounts();
    return Number(counts[String(signalKey)]) || 0;
  }


  isStrictEntryBlockedBySignalWindow(signalKey) {
    const limit = resolveSignalWindowEntryLimit(this.owner.config);
    return limit > 0 && Boolean(signalKey) &&
      this.owner.getStrictSignalWindowEntryCount(signalKey) >= limit;
  }


  recordStrictSignalWindowEntry(signalKey) {
    const limit = resolveSignalWindowEntryLimit(this.owner.config);
    if (limit <= 0 || !signalKey) return;

    const normalizedKey = String(signalKey);
    if (this.owner.dryRun && this.paperValidation) {
      const counts = this.owner.getStrictSignalWindowEntryCounts();
      counts[normalizedKey] = (Number(counts[normalizedKey]) || 0) + 1;
      const trimmed = Object.entries(counts).slice(-2000);
      this.paperValidation.strictRiskState.signalWindowEntryCountsByKey = Object.fromEntries(trimmed);
      if (this.paperValidation.active) this.owner.savePaperValidation();
      return;
    }

    const current = this.runtimeSignalWindowEntryCounts.get(normalizedKey) || 0;
    this.runtimeSignalWindowEntryCounts.set(normalizedKey, current + 1);
    while (this.runtimeSignalWindowEntryCounts.size > 2000) {
      const oldestKey = this.runtimeSignalWindowEntryCounts.keys().next().value;
      this.runtimeSignalWindowEntryCounts.delete(oldestKey);
    }
  }


  getStrictSignalWindowStatus() {
    const maxEntriesPerSignalWindow = resolveSignalWindowEntryLimit(this.owner.config);
    const entries = Object.entries(this.owner.getStrictSignalWindowEntryCounts());
    const [lastSignalKey, lastEntryCount] = entries.at(-1) || [];
    return {
      enabled: maxEntriesPerSignalWindow > 0,
      maxEntriesPerSignalWindow,
      lastSignalKey: lastSignalKey || null,
      lastEntryCount: Number(lastEntryCount) || 0,
      blockedEntries: Number(this.paperValidation?.telemetry?.signalWindowBlockedEntries) || 0
    };
  }


  registerRuntimeLoss(trade) {
    const profit = Number(trade?.profit);
    if (!trade || !Number.isFinite(profit) || profit >= 0) {
      return { triggered: false, lossCount: 0, cooldownUntil: 0 };
    }

    const state = this.owner.getStrictLossCircuitBreakerState();
    const result = registerLoss(state, trade.exitTime || Date.now(), this.owner.getLossCircuitBreakerConfig());
    if (result.triggered) {
      console.log(`\n🛑 전역 손실 회로차단기 발동: 최근 손실 ${result.lossCount}회 · ${this.owner.getLossCircuitBreakerConfig().cooldownMinutes}분 신규 진입 차단`);
    }
    if (this.owner.dryRun && this.paperValidation) {
      this.paperValidation.strictRiskState = this.paperValidation.strictRiskState || {};
      this.paperValidation.strictRiskState.lossCircuitBreaker = state;
    }
    return result;
  }


  async startPaperValidationSession(options = {}) {
    if (!this.owner.dryRun) {
      throw new Error('실거래 모드에서는 모의투자 세션을 시작할 수 없습니다.');
    }

    const previousDiagnosticOpenPositions = this.owner.getPaperDiagnosticOpenPositionSnapshot();
    const previousContinuityInvalid = this.paperValidation?.riskMonitor?.continuityEligible === false ||
      this.paperValidation?.analysisDataHealth?.continuityEligible === false ||
      this.paperValidation?.continuityEligible === false;
    const previousSessionUnsettled = this.paperValidation?.endedWithOpenPositions === true ||
      this.paperValidation?.endedWithDiagnosticOpenPositions === true ||
      previousDiagnosticOpenPositions.length > 0 ||
      previousContinuityInvalid;
    if (this.paperValidation?.active === false && previousSessionUnsettled &&
      options.reset !== true && options.allowUnsettledResume !== true) {
      const strictCoins = (this.paperValidation.strictOpenPositions || [])
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
      const seedMoney = Number(options.seedMoney) > 0 ? Number(options.seedMoney) : this.owner.initialSeedMoney;
      this.owner.resetVirtualPortfolio(seedMoney);
    }

    const baselineAssets = await this.owner.calculateTotalAssets();
    const startedAt = new Date().toISOString();
    this.owner.stopReason = null;
    this.owner.riskMonitorState = createRiskMonitorState();
    this.owner.lastRiskStatePersistedAt = 0;
    this.owner.analysisDataHealthState = createAnalysisDataHealthState();
    this.owner.analysisCycleProgress = null;
    this.owner.lastAnalysisStatePersistedAt = 0;
    this.paperValidation = {
      schemaVersion: 4,
      sessionId: `paper-${Date.now()}`,
      active: true,
      startedAt,
      endedAt: null,
      processId: process.pid,
      heartbeatAt: startedAt,
      strategyMode: this.owner.strategyMode,
      strategyProfile: this.owner.config.signalProfile || 'rsi_rebound',
      targetCoins: [...this.owner.targetCoins],
      configSnapshot: this.owner.getPaperValidationConfigSnapshot(),
      configSnapshotComplete: true,
      paperExperiments: this.owner.getPaperExperimentSnapshot(),
      baselineAssets,
      baselineIncludesHoldings: this.owner.virtualPortfolio.holdings.size > 0,
      thresholds: {
        minDays: Number(options.minDays) || this.owner.config.paperValidationMinDays || 7,
        minTrades: Number(options.minTrades) || this.owner.config.paperValidationMinTrades || 20,
        minReturnPercent: Number(options.minReturnPercent) || this.owner.config.paperValidationMinReturnPercent || 0.2,
        maxDrawdownPercent: Number(options.maxDrawdownPercent) || this.owner.config.paperValidationMaxDrawdownPercent || 15,
        maxHeartbeatGapMinutes: Number(options.maxHeartbeatGapMinutes) || this.owner.config.paperValidationMaxHeartbeatGapMinutes || 15
      },
      interruptions: [],
      riskMonitor: { ...this.owner.riskMonitorState },
      analysisDataHealth: { ...this.owner.analysisDataHealthState },
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
          threshold: Number(this.owner.config.rsiOversold ?? this.owner.strategyConfig?.rsiOversold ?? 30),
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
        analysisDataHealth: { ...this.owner.analysisDataHealthState },
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
    this.owner.savePaperValidation();
    return this.owner.getPaperValidationStatus();
  }


  async stopPaperValidationSession() {
    if (!this.paperValidation) {
      return { available: false, active: false };
    }
    const pendingCounterfactualCount = ['shadow', 'looseShadow']
      .reduce((count, stateKey) => count + (this.paperValidation[stateKey]?.executionBoundaryBlockedEntries || [])
        .filter(entry => entry?.status === 'pending').length, 0);
    this.owner.resolveExecutionBoundaryBlockedEntriesAtStop(new Date().toISOString());
    const strictOpenPositions = this.owner.getStrictOpenPositionSnapshot();
    const diagnosticOpenPositions = this.owner.getPaperDiagnosticOpenPositionSnapshot();
    this.paperValidation.strictOpenPositions = strictOpenPositions;
    this.paperValidation.endedWithOpenPositions = strictOpenPositions.length > 0;
    this.paperValidation.endedWithDiagnosticOpenPositions = diagnosticOpenPositions.length > 0;
    this.paperValidation.diagnosticOpenPositionsAtStop = diagnosticOpenPositions;
    this.paperValidation.pendingCounterfactualCountAtStop = pendingCounterfactualCount;
    const continuityStopReason = this.paperValidation.riskMonitor?.continuityEligible === false
      ? 'risk_data_gap'
      : this.paperValidation.analysisDataHealth?.continuityEligible === false
        ? 'analysis_data_gap'
        : null;
    this.paperValidation.stopReason = this.owner.stopReason || continuityStopReason ||
      (this.paperValidation.endedWithOpenPositions
        ? 'stopped_with_unsettled_strict_positions'
        : diagnosticOpenPositions.length > 0
          ? 'stopped_with_unsettled_diagnostic_positions'
          : pendingCounterfactualCount > 0
            ? 'stopped_with_unsettled_boundary_counterfactuals'
          : 'stopped_cleanly');
    this.paperValidation.active = false;
    this.paperValidation.endedAt = new Date().toISOString();
    this.owner.savePaperValidation();
    return this.owner.getPaperValidationStatus();
  }


  async recordPaperValidationSnapshot(reason = 'periodic', priceMapOverride = null) {
    if (!this.owner.dryRun || !this.paperValidation?.active) return null;

    const now = Date.now();
    const lastSnapshot = this.paperValidation.snapshots?.at(-1);
    if (lastSnapshot && now - new Date(lastSnapshot.timestamp).getTime() < 60_000) {
      return this.owner.getPaperValidationStatus();
    }

    const totalAssets = await this.owner.calculateTotalAssets(priceMapOverride);
    this.paperValidation.snapshots = [
      ...(this.paperValidation.snapshots || []),
      { timestamp: new Date(now).toISOString(), totalAssets, reason }
    ].slice(-10000);
    this.owner.savePaperValidation();
    return this.owner.getPaperValidationStatus();
  }


  recordPaperSignalTelemetry(coinAnalyses = [], marketRegime = null) {
    if (!this.owner.dryRun || !this.paperValidation?.active || !Array.isArray(coinAnalyses)) return;

    const telemetry = this.paperValidation.telemetry || {
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
        threshold: Number(this.owner.config.rsiOversold ?? this.owner.strategyConfig?.rsiOversold ?? 30),
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
      telemetry.rsiProximity.threshold = Number(this.owner.config.rsiOversold ?? this.owner.strategyConfig?.rsiOversold ?? 30);
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
    const requestStats = this.owner.cycleRequestStats || {};
    for (const key of ['batchTickerRequests', 'individualTickerRequests', 'candleRequests', 'batchTickerFailures']) {
      telemetry.requestStats[key] = (Number(telemetry.requestStats[key]) || 0) + (Number(requestStats[key]) || 0);
    }
    this.owner.cycleRequestStats = null;
    const now = new Date().toISOString();
    const diagnosticShadowsEnabled = this.owner.paperDiagnosticShadowsEnabled !== false;
    this.paperValidation.strictOpenPositions = this.owner.getStrictOpenPositionSnapshot();
    telemetry.cycles += 1;
    telemetry.lastCycleAt = now;
    telemetry.heartbeatAt = now;
    this.paperValidation.heartbeatAt = now;
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
        this.owner.updateExecutionBoundaryBlockedEntries(analysis, 'shadow', now);
        this.owner.updateExecutionBoundaryBlockedEntries(analysis, 'looseShadow', now);
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
          const minimumReboundPercent = Number.isFinite(Number(this.owner.strategyConfig.minReboundPercent))
            ? Number(this.owner.strategyConfig.minReboundPercent)
            : 0.15;
          const minimumRsiRecovery = Number.isFinite(Number(this.owner.strategyConfig.minRsiRecovery))
            ? Number(this.owner.strategyConfig.minRsiRecovery)
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
        const regimeAllowsEntry = this.owner.config.marketRegimeEnabled !== true ||
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
        const configuredMaxRetrace = Number(this.owner.maxEntryRetracePercent);
        const configuredMaxChase = Number(this.owner.config.maxEntryChasePercent);
        const shadowEntryExecution = inspectShadowEntryExecution(
          analysis,
          Number.isFinite(configuredMaxRetrace) && configuredMaxRetrace >= 0 ? configuredMaxRetrace : 0.25,
          Number.isFinite(configuredMaxChase) && configuredMaxChase >= 0 ? configuredMaxChase : 0.35
        );
        const shadowCandidate = shadowCandidateBeforeRegime &&
          shadowEntryExecution.valid && regimeAllowsEntry;
        const looseShadowCandidate = looseShadowCandidateBeforeRegime &&
          shadowEntryExecution.valid && regimeAllowsEntry;
        const winnerShadowEnabled = this.owner.winnerShadowExtendMinutes > 0 || this.owner.winnerShadowMaxReboundPercent > 0;
        const winnerShadowReboundWithinCeiling = this.owner.winnerShadowMaxReboundPercent <= 0 ||
          Number(rebound?.reboundPriceChangePercent ?? rebound?.priceChangePercent) <= this.owner.winnerShadowMaxReboundPercent;
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
          this.owner.recordWinnerShadowBlockedEntry(analysis, now);
        }
        if (isNewFreshSignalWindow && shadowEntryExecution.enforceable && !shadowEntryExecution.valid) {
          const reason = shadowEntryExecution.reason;
          if (shadowCandidateBeforeRegime) {
            telemetry.shadowEntryExecutionBlockedEntries += 1;
            telemetry.shadowEntryExecutionBlockReasons[reason] =
              (telemetry.shadowEntryExecutionBlockReasons[reason] || 0) + 1;
            this.owner.recordExecutionBoundaryBlockedEntry(analysis, 'shadow', reason, now);
          }
          if (looseShadowCandidateBeforeRegime) {
            telemetry.looseShadowEntryExecutionBlockedEntries += 1;
            telemetry.looseShadowEntryExecutionBlockReasons[reason] =
              (telemetry.looseShadowEntryExecutionBlockReasons[reason] || 0) + 1;
            this.owner.recordExecutionBoundaryBlockedEntry(analysis, 'looseShadow', reason, now);
          }
        }
        if (this.owner.config.marketRegimeEnabled === true && !regimeAllowsEntry) {
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

        const shadowResult = this.owner.updatePaperShadowPosition(analysis, shadowCandidate && action !== 'BUY', now);
        const looseShadowResult = this.owner.updatePaperShadowPosition(analysis, looseShadowCandidate && action !== 'BUY', now, 'looseShadow');
        const winnerShadowResult = winnerShadowEnabled
          ? this.owner.updatePaperShadowPosition(analysis, winnerShadowCandidate, now, 'winnerShadow')
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

    this.paperValidation.telemetry = telemetry;
    const lastPersistedAt = this.paperValidation.lastTelemetryPersistedAt
      ? new Date(this.paperValidation.lastTelemetryPersistedAt).getTime()
      : 0;
    if (Date.now() - lastPersistedAt >= 60_000) {
      this.paperValidation.lastTelemetryPersistedAt = now;
      this.owner.savePaperValidation();
    }
  }


  recordPaperCircuitBlock() {
    if (!this.owner.dryRun || !this.paperValidation?.active) return;
    const telemetry = this.paperValidation.telemetry || {};
    telemetry.circuitBlockedEntries = (Number(telemetry.circuitBlockedEntries) || 0) + 1;
    telemetry.lastCircuitBlockedAt = new Date().toISOString();
    this.paperValidation.telemetry = telemetry;
  }


  recordPaperSignalWindowBlock() {
    if (!this.owner.dryRun || !this.paperValidation?.active) return;
    const telemetry = this.paperValidation.telemetry || {};
    telemetry.signalWindowBlockedEntries = (Number(telemetry.signalWindowBlockedEntries) || 0) + 1;
    telemetry.lastSignalWindowBlockedAt = new Date().toISOString();
    this.paperValidation.telemetry = telemetry;
  }


  recordPaperMarketRegimeBlock() {
    if (!this.owner.dryRun || !this.paperValidation?.active) return;
    const telemetry = this.paperValidation.telemetry || {};
    telemetry.marketRegimeBlockedEntries = (Number(telemetry.marketRegimeBlockedEntries) || 0) + 1;
    telemetry.lastMarketRegimeBlockedAt = new Date().toISOString();
    this.paperValidation.telemetry = telemetry;
  }


  recordInsufficientCandleData(coin, receivedCount, requiredCount) {
    if (!this.owner.dryRun || !this.paperValidation?.active || !coin) return;
    const telemetry = this.paperValidation.telemetry || {};
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
    this.paperValidation.telemetry = telemetry;
  }


  recordPaperCandleFreshnessObservation(coin, freshness) {
    if (!this.owner.dryRun || !this.paperValidation?.active || !coin) return;
    const telemetry = this.paperValidation.telemetry || {};
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
    this.paperValidation.telemetry = telemetry;
  }


  recordPaperCandleFreshnessBlock(reason = 'unknown', freshness = null, context = 'entry_confirmation', coin = null) {
    if (!this.owner.dryRun || !this.paperValidation?.active) return;
    const telemetry = this.paperValidation.telemetry || {};
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
        : this.owner.maxCandleAgeSeconds
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
    this.paperValidation.telemetry = telemetry;
  }


  recordPaperEntryConfirmation(coin, outcome, reason = 'unknown') {
    if (!this.owner.dryRun || !this.paperValidation?.active) return;
    const telemetry = this.paperValidation.telemetry || {};
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
    this.paperValidation.telemetry = telemetry;
  }


  getStrictOpenPositionSnapshot() {
    return [...this.owner.strategies.entries()]
      .filter(([, strategy]) => strategy?.currentPosition)
      .map(([coin, strategy]) => {
        const position = strategy.currentPosition;
        const numericOrNull = value => Number.isFinite(Number(value)) ? Number(value) : null;
        const excursion = derivePositionExcursion(position);
        return {
          coin,
          entryPrice: Number(position.entryPrice) || null,
          amount: Number(position.amount) || null,
          entryTime: position.entryTime instanceof Date
            ? position.entryTime.toISOString()
            : position.entryTime || null,
          highestPrice: excursion.highestPrice,
          lowestPrice: excursion.lowestPrice,
          maxFavorableExcursionPercent: excursion.maxFavorableExcursionPercent,
          maxAdverseExcursionPercent: excursion.maxAdverseExcursionPercent,
          breakEvenArmed: position.breakEvenArmed === true,
          trailingArmed: position.trailingArmed === true,
          signalKey: position.signalKey || null,
          signalTime: position.signalTime || null,
          signalReferencePrice: numericOrNull(position.signalReferencePrice),
          signalReboundPercent: numericOrNull(position.signalReboundPercent),
          signalRsi: numericOrNull(position.signalRsi),
          signalOversoldRsi: numericOrNull(position.signalOversoldRsi),
          signalRsiRecovery: numericOrNull(position.signalRsiRecovery),
          signalVolumeRatio: numericOrNull(position.signalVolumeRatio),
          signalCloseStrength: numericOrNull(position.signalCloseStrength),
          signalTrendSlopePercent: numericOrNull(position.signalTrendSlopePercent),
          signalRangePercent: numericOrNull(position.signalRangePercent),
          entryDelayMs: numericOrNull(position.entryDelayMs),
          executionDriftPercent: numericOrNull(position.executionDriftPercent),
          paperExecutionCostModel: position.paperExecutionCostModel || null,
          paperExecutionSlippageRate: numericOrNull(position.paperExecutionSlippageRate),
          paperExecutionTradingFeeRate: numericOrNull(position.paperExecutionTradingFeeRate),
          paperObservedEntryPrice: numericOrNull(position.paperObservedEntryPrice),
          paperObservedExitPrice: numericOrNull(position.paperObservedExitPrice),
          paperEntryFee: numericOrNull(position.paperEntryFee),
          paperInvestmentAmount: numericOrNull(position.paperInvestmentAmount)
        };
      })
      .sort((a, b) => a.coin.localeCompare(b.coin));
  }


  getPaperDiagnosticOpenPositionSnapshot() {
    if (!this.paperValidation) return [];
    const positions = [];
    for (const stateKey of ['shadow', 'looseShadow', 'winnerShadow']) {
      const book = this.paperValidation[stateKey];
      for (const [coin, position] of Object.entries(book?.positions || {})) {
        if (!position || typeof position !== 'object') continue;
        positions.push({
          book: stateKey,
          coin: position.coin || coin,
          ...position
        });
      }
    }
    return positions.sort((a, b) => `${a.book}:${a.coin}`.localeCompare(`${b.book}:${b.coin}`));
  }

  /**
   * Resolve the exit contract for a diagnostic book. The winner-shadow
   * sidecar runs its own winner-hold candidate values; every other book
   * shares the strict config. The mapping must live here — the risk-monitor
   * path previously dropped it by omitting the call-site override, which
   * silently closed the experiment at the strict max-hold boundary. An
   * explicit configOverride still wins for callers that deliberately
   * simulate a different contract.
   */
  resolveShadowExitConfig(stateKey, configOverride) {
    const derived = stateKey === 'winnerShadow'
      ? {
          winnerExtendMinutes: this.owner.winnerShadowExtendMinutes,
          winnerExtendMinProfitPercent: this.owner.winnerShadowExtendMinProfitPercent
        }
      : {};
    return {
      ...this.owner.config,
      ...derived,
      ...(configOverride && typeof configOverride === 'object' ? configOverride : {})
    };
  }

  /**
   * Relaxed shadow cohort for diagnosing filter starvation.
   *
   * This book is deliberately separate from the real virtual portfolio. It
   * enters on the observed ticker snapshot (plus adverse slippage), uses the
   * same stop/take/time limits, and never contributes to live promotion. Its
   * purpose is to answer whether rejected candidates are worth a new
   * holdout study instead of silently loosening production filters.
   */
  updatePaperShadowPosition(analysis, canEnter, timestamp, stateKey = 'shadow', configOverride = {}) {
    const result = {
      entered: false,
      closed: false,
      blockedByLossCircuit: false,
      circuitTriggered: false
    };
    if (!this.paperValidation?.active || !analysis?.coin) return result;

    const shadow = this.paperValidation[stateKey] || {
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
    };
    shadow.positions = shadow.positions || {};
    shadow.lastSignalByCoin = shadow.lastSignalByCoin || {};
    shadow.executionBoundaryBlockedEntries = Array.isArray(shadow.executionBoundaryBlockedEntries)
      ? shadow.executionBoundaryBlockedEntries
      : [];
    shadow.closedTrades = Array.isArray(shadow.closedTrades) ? shadow.closedTrades : [];
    shadow.entryCount = Number(shadow.entryCount) || 0;
    shadow.realizedProfit = Number(shadow.realizedProfit) || 0;
    shadow.totalInvested = Number(shadow.totalInvested) || 0;
    shadow.winningTrades = Number(shadow.winningTrades) || 0;
    shadow.losingTrades = Number(shadow.losingTrades) || 0;
    shadow.cooldownUntilByCoin = shadow.cooldownUntilByCoin || {};
    shadow.consecutiveLossesByCoin = shadow.consecutiveLossesByCoin || {};
    shadow.lossCircuitBreaker = shadow.lossCircuitBreaker || createLossCircuitBreakerState();

    const coin = analysis.coin;
    const currentPrice = Number(analysis.currentPrice);
    const numericOrNull = value => Number.isFinite(Number(value)) ? Number(value) : null;
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      this.paperValidation[stateKey] = shadow;
      return result;
    }

    const exitConfig = this.owner.resolveShadowExitConfig(stateKey, configOverride);
    const tradingFee = Number.isFinite(Number(exitConfig.tradingFee))
      ? Number(exitConfig.tradingFee)
      : 0.0005;
    const slippage = Number.isFinite(Number(exitConfig.slippage))
      ? Number(exitConfig.slippage)
      : 0.001;
    const stopLossPercent = Number.isFinite(Number(exitConfig.stopLossPercent))
      ? Number(exitConfig.stopLossPercent)
      : 1.2;
    const takeProfitPercent = Number.isFinite(Number(exitConfig.takeProfitPercent))
      ? Number(exitConfig.takeProfitPercent)
      : 1.8;
    const maxHoldMinutes = Number.isFinite(Number(exitConfig.maxHoldMinutes))
      ? Number(exitConfig.maxHoldMinutes)
      : 30;
    const maxLosingHoldMinutes = Number.isFinite(Number(exitConfig.maxLosingHoldMinutes))
      ? Number(exitConfig.maxLosingHoldMinutes)
      : 0;
    const winnerExtendMinutes = Number.isFinite(Number(exitConfig.winnerExtendMinutes))
      ? Number(exitConfig.winnerExtendMinutes)
      : 0;
    const winnerExtendMinProfitPercent = Number.isFinite(Number(exitConfig.winnerExtendMinProfitPercent))
      ? Number(exitConfig.winnerExtendMinProfitPercent)
      : 0;
    const cooldownAfterLossMinutes = Number.isFinite(Number(exitConfig.cooldownAfterLossMinutes))
      ? Number(exitConfig.cooldownAfterLossMinutes)
      : 15;
    const maxConsecutiveLosses = Number.isFinite(Number(exitConfig.maxConsecutiveLosses))
      ? Number(exitConfig.maxConsecutiveLosses)
      : 3;
    const breakEvenTriggerPercent = Math.max(0, Number(exitConfig.breakEvenTriggerPercent) || 0);
    const configuredBreakEvenOffset = Number(exitConfig.breakEvenOffsetPercent);
    const breakEvenOffsetPercent = Number.isFinite(configuredBreakEvenOffset) && configuredBreakEvenOffset >= 0
      ? configuredBreakEvenOffset
      : 0.05;
    const trailingActivationPercent = Math.max(0, Number(exitConfig.trailingActivationPercent) || 0);
    const trailingStopPercent = Math.max(0, Number(exitConfig.trailingStopPercent) || 0);
    const nowMs = new Date(timestamp).getTime();
    const position = shadow.positions[coin];
    let closedThisCycle = false;

    if (position) {
      const entryTimestamp = new Date(position.entryTimestamp).getTime();
      const stopPrice = position.entryPrice * (1 - stopLossPercent / 100);
      const takePrice = position.entryPrice * (1 + takeProfitPercent / 100);
      updatePositionExcursion(position, currentPrice);
      const gainPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
      if (breakEvenTriggerPercent > 0 && gainPercent >= breakEvenTriggerPercent) {
        position.breakEvenArmed = true;
      }
      if (trailingActivationPercent > 0 && trailingStopPercent > 0 && gainPercent >= trailingActivationPercent) {
        position.trailingArmed = true;
      }
      let protectiveStopPrice = stopPrice;
      let protectiveType = 'STOP_LOSS';
      if (position.breakEvenArmed || position.trailingArmed) {
        const breakEvenStopPrice = calculateCostAdjustedBreakEvenPrice(position.entryPrice, {
          tradingFee,
          slippage,
          offsetPercent: breakEvenOffsetPercent
        });
        if (Number.isFinite(breakEvenStopPrice) && breakEvenStopPrice > protectiveStopPrice) {
          protectiveStopPrice = breakEvenStopPrice;
          protectiveType = 'BREAK_EVEN_STOP';
        }
      }
      if (position.trailingArmed) {
        const trailingStopPrice = position.highestPrice * (1 - trailingStopPercent / 100);
        if (trailingStopPrice > protectiveStopPrice) {
          protectiveStopPrice = trailingStopPrice;
          protectiveType = 'TRAILING_STOP';
        }
      }
      let exitReason = null;
      if (currentPrice <= protectiveStopPrice) exitReason = protectiveType;
      else if (currentPrice >= takePrice) exitReason = 'TAKE_PROFIT';
      else if (maxLosingHoldMinutes > 0 && Number.isFinite(entryTimestamp) &&
        nowMs - entryTimestamp >= maxLosingHoldMinutes * 60 * 1000 &&
        currentPrice <= position.entryPrice) {
        exitReason = 'MAX_LOSING_HOLD_TIME';
      }
      else if (maxHoldMinutes > 0 && Number.isFinite(entryTimestamp) &&
        nowMs - entryTimestamp >= maxHoldMinutes * 60 * 1000) {
        const holdMs = nowMs - entryTimestamp;
        const extensionMs = winnerExtendMinutes * 60 * 1000;
        if (extensionMs > 0 && holdMs < maxHoldMinutes * 60 * 1000 + extensionMs) {
          if (position.winnerExtended === true) {
            exitReason = null;
          } else if (gainPercent >= winnerExtendMinProfitPercent) {
            position.winnerExtended = true;
            position.breakEvenArmed = true;
          } else {
            exitReason = 'MAX_HOLD_TIME';
          }
        } else {
          exitReason = 'MAX_HOLD_TIME';
        }
      }

      if (exitReason) {
        const exitPrice = currentPrice * (1 - slippage);
        const grossAmount = position.amount * exitPrice;
        const sellFee = grossAmount * tradingFee;
        const netProfit = grossAmount - sellFee - position.investAmount;
        const closedTrade = {
          type: 'CLOSE',
          coin,
          reason: exitReason,
          entryPrice: position.entryPrice,
          exitPrice,
          amount: position.amount,
          investAmount: position.investAmount,
          netProfit,
          profitPercent: position.investAmount > 0 ? (netProfit / position.investAmount) * 100 : 0,
          entryTimestamp: position.entryTimestamp,
          exitTimestamp: timestamp,
          signalKey: position.signalKey || null,
          signalTime: position.signalTime || null,
          signalReferencePrice: numericOrNull(position.signalReferencePrice),
          signalReboundPercent: numericOrNull(position.signalReboundPercent),
          signalRsi: numericOrNull(position.signalRsi),
          signalOversoldRsi: numericOrNull(position.signalOversoldRsi),
          signalRsiRecovery: numericOrNull(position.signalRsiRecovery),
          signalVolumeRatio: numericOrNull(position.signalVolumeRatio),
          signalCloseStrength: numericOrNull(position.signalCloseStrength),
          signalTrendSlopePercent: numericOrNull(position.signalTrendSlopePercent),
          signalRangePercent: numericOrNull(position.signalRangePercent),
          entryDelayMs: numericOrNull(position.entryDelayMs),
          executionDriftPercent: numericOrNull(position.executionDriftPercent),
          lowestPrice: numericOrNull(position.lowestPrice),
          maxFavorableExcursionPercent: numericOrNull(position.maxFavorableExcursionPercent),
          maxAdverseExcursionPercent: numericOrNull(position.maxAdverseExcursionPercent),
          winnerExtended: position.winnerExtended === true,
          rejectionReasons: Array.isArray(position.rejectionReasons)
            ? position.rejectionReasons
            : []
        };
        shadow.closedTrades = [...shadow.closedTrades, closedTrade].slice(-1000);
        shadow.realizedProfit += netProfit;
        if (netProfit > 0) {
          shadow.winningTrades += 1;
          shadow.consecutiveLossesByCoin[coin] = 0;
          shadow.cooldownUntilByCoin[coin] = 0;
        } else {
          shadow.losingTrades += 1;
          const consecutiveLosses = (Number(shadow.consecutiveLossesByCoin[coin]) || 0) + 1;
          const cooldownMinutes = consecutiveLosses >= maxConsecutiveLosses
            ? Math.max(cooldownAfterLossMinutes, 60)
            : cooldownAfterLossMinutes;
          shadow.consecutiveLossesByCoin[coin] = consecutiveLosses;
          shadow.cooldownUntilByCoin[coin] = nowMs + cooldownMinutes * 60 * 1000;
        }
        shadow.lastExitAt = timestamp;
        delete shadow.positions[coin];
        closedThisCycle = true;
        result.closed = true;
        if (netProfit < 0) {
          const circuitResult = registerLoss(
            shadow.lossCircuitBreaker,
            nowMs,
            this.owner.getLossCircuitBreakerConfig()
          );
          result.circuitTriggered = circuitResult.triggered;
        }
      }
    }

    if (!closedThisCycle && !shadow.positions[coin] && canEnter) {
      const rebound = analysis.decision?.details?.rebound;
      const signalKey = String(rebound?.signalKey || '');
      if (signalKey && shadow.lastSignalByCoin[coin] !== signalKey) {
        const cooldownUntil = Number(shadow.cooldownUntilByCoin[coin]) || 0;
        if (nowMs < cooldownUntil) {
          this.paperValidation[stateKey] = shadow;
          return result;
        }
        if ((Number(shadow.consecutiveLossesByCoin[coin]) || 0) >= maxConsecutiveLosses) {
          shadow.consecutiveLossesByCoin[coin] = 0;
          shadow.cooldownUntilByCoin[coin] = 0;
        }

        const activePositionCount = Object.keys(shadow.positions).length;
        const configuredMaxPositions = Number(this.owner.maxPositions);
        const maxPositions = Number.isFinite(configuredMaxPositions)
          ? Math.max(0, configuredMaxPositions)
          : 3;
        if (activePositionCount < maxPositions) {
          if (isLossCircuitCoolingDown(
            shadow.lossCircuitBreaker,
            nowMs,
            this.owner.getLossCircuitBreakerConfig()
          )) {
            result.blockedByLossCircuit = true;
            this.paperValidation[stateKey] = shadow;
            return result;
          }
          const baselineAssets = Number(this.paperValidation.baselineAssets) || this.owner.initialSeedMoney;
          const investmentRatio = Number.isFinite(Number(this.owner.investmentRatio))
            ? Number(this.owner.investmentRatio)
            : 0.02;
          const investAmount = Math.min(baselineAssets * investmentRatio, baselineAssets * 0.95);
          const entryPrice = currentPrice * (1 + slippage);
          const buyFee = investAmount * tradingFee;
          const amount = (investAmount - buyFee) / entryPrice;
          if (investAmount >= this.owner.MIN_ORDER_AMOUNT && amount > 0) {
            shadow.positions[coin] = {
              coin,
              entryPrice,
              amount,
              investAmount,
              entryTimestamp: timestamp,
              signalKey,
              signalTime: rebound.candleTime || null,
              signalReferencePrice: Number(rebound.referencePrice) || null,
              signalReboundPercent: Number(rebound.reboundPriceChangePercent ?? rebound.priceChangePercent) || null,
              signalRsi: Number(rebound.rsi) || null,
              signalOversoldRsi: Number(rebound.oversoldRsi ?? rebound.previousRsi) || null,
              signalRsiRecovery: Number(rebound.rsiRecovery) || null,
              signalVolumeRatio: Number(rebound.volumeRatio) || null,
              signalCloseStrength: Number(rebound.closeStrength) || null,
              signalTrendSlopePercent: Number(rebound.trendSlopePercent) || null,
              signalRangePercent: Number(rebound.signalRangePercent) || null,
              entryDelayMs: Number(analysis.decision?.entryDelayMs) || null,
              executionDriftPercent: Number.isFinite(currentPrice) && Number(rebound.referencePrice) > 0
                ? ((currentPrice - Number(rebound.referencePrice)) / Number(rebound.referencePrice)) * 100
                : null,
              highestPrice: currentPrice,
              lowestPrice: currentPrice,
              maxFavorableExcursionPercent: 0,
              maxAdverseExcursionPercent: 0,
              winnerExtended: false,
              breakEvenArmed: false,
              trailingArmed: false,
              rejectionReasons: Array.isArray(rebound?.rejectionReasons)
                ? rebound.rejectionReasons.slice()
                : []
            };
            shadow.lastSignalByCoin[coin] = signalKey;
            shadow.entryCount += 1;
            shadow.totalInvested += investAmount;
            shadow.lastEntryAt = timestamp;
            result.entered = true;
          }
        }
      }
    }

    this.paperValidation[stateKey] = shadow;
    return result;
  }


  async getPaperValidationStatus({ includeCurrentAssets = true } = {}) {
    const session = this.paperValidation;
    if (!session) {
      return {
        available: false,
        active: false,
        eligible: false,
        reason: 'paper_validation_session_not_started'
      };
    }

    const persistedAssets = session.snapshots?.at(-1)?.totalAssets ?? session.baselineAssets;
    const currentAssets = includeCurrentAssets
      ? await this.owner.calculateTotalAssets()
      : persistedAssets !== null && persistedAssets !== undefined && Number.isFinite(Number(persistedAssets))
        ? Number(persistedAssets)
        : null;
    const startedAtMs = new Date(session.startedAt).getTime();
    const elapsedDays = Math.max(0, (Date.now() - startedAtMs) / 86_400_000);
    const heartbeatAt = session.telemetry?.heartbeatAt || session.startedAt;
    const heartbeatMs = new Date(heartbeatAt).getTime();
    // 미래·누락·비정형 heartbeat는 검증 불가 — 신선하다고 간주하지 않는다.
    const heartbeatAgeMs = Number.isFinite(heartbeatMs) && Date.now() >= heartbeatMs
      ? Date.now() - heartbeatMs
      : null;
    const heartbeatLimitMs = Math.max(120_000, (Number(this.owner.config.checkInterval) || 60_000) * 5);
    const ownerProcessAlive = this.owner.isProcessAlive(session.processId);
    const orphaned = session.active === true &&
      (ownerProcessAlive === false || heartbeatAgeMs === null || heartbeatAgeMs > heartbeatLimitMs);
    const orphanReason = orphaned
      ? ownerProcessAlive === false ? 'owner_process_missing' : 'heartbeat_stale'
      : null;
    const configComparison = this.owner.comparePaperValidationConfig(session.configSnapshot);
    const experimentComparison = this.owner.comparePaperExperimentConfig(session.paperExperiments);
    const configSnapshotComplete = session.configSnapshotComplete === true;
    const snapshots = [
      { timestamp: session.startedAt, totalAssets: session.baselineAssets },
      ...(session.snapshots || [])
    ].filter(snapshot => Number.isFinite(Number(snapshot.totalAssets)));
    let peak = 0;
    let maxDrawdownPercent = 0;
    for (const snapshot of snapshots) {
      const assets = Number(snapshot.totalAssets);
      peak = Math.max(peak, assets);
      if (peak > 0) maxDrawdownPercent = Math.max(maxDrawdownPercent, ((peak - assets) / peak) * 100);
    }

    const startedTrades = [];
    const startedAtTime = new Date(session.startedAt).getTime();
    const strictLedgerTrades = Array.isArray(session.strictTrades)
      ? session.strictTrades
      : [];
    const seenTradeKeys = new Set();
    for (const trade of strictLedgerTrades) {
      const exitTime = new Date(trade.exitTime || 0).getTime();
      const exitKey = Number.isFinite(exitTime) ? new Date(exitTime).toISOString() : String(trade.exitTime || '');
      const key = trade.ledgerKey || `${trade.coin || 'unknown'}:${trade.id || 'no-id'}:${exitKey}:${trade.action || 'CLOSE'}`;
      if ((trade.action === 'CLOSE' || trade.action === 'PARTIAL_CLOSE') &&
        exitTime >= startedAtTime && !seenTradeKeys.has(key)) {
        startedTrades.push(trade);
        seenTradeKeys.add(key);
      }
    }
    for (const [coin, strategy] of this.owner.strategies.entries()) {
      for (const trade of strategy.tradeHistory || []) {
        const exitTime = new Date(trade.exitTime || 0).getTime();
        const exitKey = Number.isFinite(exitTime) ? new Date(exitTime).toISOString() : String(trade.exitTime || '');
        const key = trade.ledgerKey || `${coin}:${trade.id || 'no-id'}:${exitKey}:${trade.action || 'CLOSE'}`;
        if ((trade.action === 'CLOSE' || trade.action === 'PARTIAL_CLOSE') &&
          exitTime >= startedAtTime && !seenTradeKeys.has(key)) {
          trade.coin = trade.coin || coin;
          startedTrades.push(trade);
          seenTradeKeys.add(key);
        }
      }
    }

    const hasLiveStrategyState = this.owner.strategies.size > 0;
    const strictOpenPositions = hasLiveStrategyState
      ? this.owner.getStrictOpenPositionSnapshot()
      : (Array.isArray(session.strictOpenPositions) ? session.strictOpenPositions : []);

    const realizedProfit = startedTrades.reduce((sum, trade) => sum + (Number(trade.profit) || 0), 0);
    const strictWinningTrades = startedTrades.filter(trade => Number(trade.profit) > 0).length;
    const strictLosingTrades = startedTrades.filter(trade => Number(trade.profit) <= 0).length;
    const strictRecentTrades = startedTrades.slice(-5).map(trade => ({
      action: trade.action || 'CLOSE',
      coin: trade.coin || null,
      reason: trade.reason || null,
      entryPrice: Number.isFinite(Number(trade.entryPrice)) ? Number(trade.entryPrice) : null,
      exitPrice: Number.isFinite(Number(trade.exitPrice)) ? Number(trade.exitPrice) : null,
      profit: Number.isFinite(Number(trade.profit)) ? Number(trade.profit) : null,
      profitPercent: Number.isFinite(Number(trade.profitPercent)) ? Number(trade.profitPercent) : null,
      maxFavorableExcursionPercent: Number.isFinite(Number(trade.maxFavorableExcursionPercent))
        ? Number(trade.maxFavorableExcursionPercent)
        : null,
      maxAdverseExcursionPercent: Number.isFinite(Number(trade.maxAdverseExcursionPercent))
        ? Number(trade.maxAdverseExcursionPercent)
        : null,
      exitTime: trade.exitTime || null
    }));
    const shadow = session.shadow || {};
    const shadowClosedTrades = Array.isArray(shadow.closedTrades) ? shadow.closedTrades : [];
    const shadowRealizedProfit = Number(shadow.realizedProfit) || 0;
    const shadowTotalInvested = Number(shadow.totalInvested) || 0;
    const shadowWinners = Number(shadow.winningTrades) || shadowClosedTrades.filter(trade => Number(trade.netProfit) > 0).length;
    const shadowLosers = Number(shadow.losingTrades) || shadowClosedTrades.filter(trade => Number(trade.netProfit) <= 0).length;
    const shadowProfitFactor = shadowLosers > 0
      ? shadowClosedTrades.filter(trade => Number(trade.netProfit) > 0).reduce((sum, trade) => sum + Number(trade.netProfit), 0) /
        Math.abs(shadowClosedTrades.filter(trade => Number(trade.netProfit) <= 0).reduce((sum, trade) => sum + Number(trade.netProfit), 0))
      : shadowWinners > 0 ? Infinity : 0;
    const looseShadow = session.looseShadow || {};
    const looseClosedTrades = Array.isArray(looseShadow.closedTrades) ? looseShadow.closedTrades : [];
    const exitEvidence = {
      schema: PAPER_EXIT_EVIDENCE_SCHEMA,
      researchOnly: true,
      promoted: false,
      strict: summarizePaperExitEvidence(startedTrades, { profitField: 'profit' }),
      shadow: summarizePaperExitEvidence(shadowClosedTrades, { profitField: 'netProfit' }),
      looseShadow: summarizePaperExitEvidence(looseClosedTrades, { profitField: 'netProfit' }),
      note: '실제 종료 경로를 집계한 읽기 전용 paper evidence입니다. 조기 청산·실제 fill·wallet settlement·수익성은 추정하지 않습니다.'
    };
    const executionOutcomeComparison = summarizePaperExecutionComparison({
      strictTrades: startedTrades,
      shadowTrades: shadowClosedTrades,
      looseShadowTrades: looseClosedTrades
    });
    const diagnosticShadowsEnabled = session.paperExperiments?.diagnosticShadows?.enabled !== false;
    const executionRobustnessGate = evaluatePaperExecutionRobustnessGate(
      executionOutcomeComparison,
      {
        required: diagnosticShadowsEnabled,
        minimumPairs: Number(session.thresholds?.minExecutionPairs) || DEFAULT_PAPER_EXECUTION_MIN_PAIRS
      }
    );
    const looseRealizedProfit = Number(looseShadow.realizedProfit) || 0;
    const looseTotalInvested = Number(looseShadow.totalInvested) || 0;
    const looseWinners = Number(looseShadow.winningTrades) || looseClosedTrades.filter(trade => Number(trade.netProfit) > 0).length;
    const looseLosers = Number(looseShadow.losingTrades) || looseClosedTrades.filter(trade => Number(trade.netProfit) <= 0).length;
    const looseProfitFactor = looseLosers > 0
      ? looseClosedTrades.filter(trade => Number(trade.netProfit) > 0).reduce((sum, trade) => sum + Number(trade.netProfit), 0) /
        Math.abs(looseClosedTrades.filter(trade => Number(trade.netProfit) <= 0).reduce((sum, trade) => sum + Number(trade.netProfit), 0))
      : looseWinners > 0 ? Infinity : 0;
    const winnerShadow = session.winnerShadow || {};
    const winnerShadowClosedTrades = Array.isArray(winnerShadow.closedTrades) ? winnerShadow.closedTrades : [];
    const winnerShadowRealizedProfit = Number(winnerShadow.realizedProfit) || 0;
    const winnerShadowTotalInvested = Number(winnerShadow.totalInvested) || 0;
    const winnerShadowWinners = Number(winnerShadow.winningTrades) || winnerShadowClosedTrades.filter(trade => Number(trade.netProfit) > 0).length;
    const winnerShadowLosers = Number(winnerShadow.losingTrades) || winnerShadowClosedTrades.filter(trade => Number(trade.netProfit) <= 0).length;
    const winnerShadowProfitFactor = winnerShadowLosers > 0
      ? winnerShadowClosedTrades.filter(trade => Number(trade.netProfit) > 0).reduce((sum, trade) => sum + Number(trade.netProfit), 0) /
        Math.abs(winnerShadowClosedTrades.filter(trade => Number(trade.netProfit) <= 0).reduce((sum, trade) => sum + Number(trade.netProfit), 0))
      : winnerShadowWinners > 0 ? Infinity : 0;
    const summarizeDiagnosticTrades = trades => trades.slice(-5).map(trade => ({
      coin: trade.coin || null,
      reason: trade.reason || null,
      entryPrice: Number.isFinite(Number(trade.entryPrice)) ? Number(trade.entryPrice) : null,
      exitPrice: Number.isFinite(Number(trade.exitPrice)) ? Number(trade.exitPrice) : null,
      netProfit: Number.isFinite(Number(trade.netProfit)) ? Number(trade.netProfit) : null,
      profitPercent: Number.isFinite(Number(trade.profitPercent)) ? Number(trade.profitPercent) : null,
      maxFavorableExcursionPercent: Number.isFinite(Number(trade.maxFavorableExcursionPercent))
        ? Number(trade.maxFavorableExcursionPercent)
        : null,
      maxAdverseExcursionPercent: Number.isFinite(Number(trade.maxAdverseExcursionPercent))
        ? Number(trade.maxAdverseExcursionPercent)
        : null,
      exitTimestamp: trade.exitTimestamp || trade.exitTime || null,
      winnerExtended: trade.winnerExtended === true,
      rejectionReasons: Array.isArray(trade.rejectionReasons) ? trade.rejectionReasons.slice() : []
    }));
    const shadowRecentTrades = summarizeDiagnosticTrades(shadowClosedTrades);
    const looseRecentTrades = summarizeDiagnosticTrades(looseClosedTrades);
    const winnerShadowRecentTrades = summarizeDiagnosticTrades(winnerShadowClosedTrades);
    const summarizeDiagnosticPositions = book => Object.entries(book?.positions || {})
      .map(([coin, position]) => ({
        coin: position?.coin || coin,
        entryPrice: Number.isFinite(Number(position?.entryPrice)) ? Number(position.entryPrice) : null,
        investAmount: Number.isFinite(Number(position?.investAmount)) ? Number(position.investAmount) : null,
        entryTimestamp: position?.entryTimestamp || position?.entryTime || null,
        signalKey: position?.signalKey || null,
        maxFavorableExcursionPercent: Number.isFinite(Number(position?.maxFavorableExcursionPercent))
          ? Number(position.maxFavorableExcursionPercent)
          : null,
        maxAdverseExcursionPercent: Number.isFinite(Number(position?.maxAdverseExcursionPercent))
          ? Number(position.maxAdverseExcursionPercent)
          : null,
        rejectionReasons: Array.isArray(position?.rejectionReasons) ? position.rejectionReasons.slice() : []
      }))
      .sort((left, right) => String(left.coin).localeCompare(String(right.coin)));
    const shadowOpenPositions = summarizeDiagnosticPositions(shadow);
    const looseOpenPositions = summarizeDiagnosticPositions(looseShadow);
    const winnerShadowOpenPositions = summarizeDiagnosticPositions(winnerShadow);
    const winnerShadowBlockedEntries = Array.isArray(winnerShadow.blockedEntries)
      ? winnerShadow.blockedEntries
      : [];
    const winnerShadowSettledBlockedEntries = winnerShadowBlockedEntries
      .filter(entry => entry?.status === 'settled' && entry.counterfactual);
    const winnerShadowPendingBlockedEntries = winnerShadowBlockedEntries
      .filter(entry => entry?.status === 'pending');
    const winnerShadowNotFilledBlockedEntries = winnerShadowBlockedEntries
      .filter(entry => entry?.status === 'not_filled');
    const winnerShadowCounterfactualProfit = winnerShadowSettledBlockedEntries
      .reduce((sum, entry) => sum + (Number(entry.counterfactual?.netProfit) || 0), 0);
    const winnerShadowCounterfactualWinners = winnerShadowSettledBlockedEntries
      .filter(entry => Number(entry.counterfactual?.netProfit) > 0).length;
    const winnerShadowCounterfactualLosers = winnerShadowSettledBlockedEntries.length - winnerShadowCounterfactualWinners;
    const winnerShadowCounterfactualProfitFactor = winnerShadowCounterfactualLosers > 0
      ? winnerShadowSettledBlockedEntries
        .filter(entry => Number(entry.counterfactual?.netProfit) > 0)
        .reduce((sum, entry) => sum + Number(entry.counterfactual.netProfit), 0) /
        Math.abs(winnerShadowSettledBlockedEntries
          .filter(entry => Number(entry.counterfactual?.netProfit) <= 0)
          .reduce((sum, entry) => sum + Number(entry.counterfactual.netProfit), 0))
      : winnerShadowCounterfactualWinners > 0 ? Infinity : 0;
    const summarizeRejectionOutcomes = closedTrades => {
      const grouped = new Map();
      for (const trade of closedTrades) {
        for (const reason of Array.isArray(trade.rejectionReasons) ? trade.rejectionReasons : []) {
          const entry = grouped.get(reason) || {
            reason,
            tradeCount: 0,
            winningTrades: 0,
            losingTrades: 0,
            netProfit: 0
          };
          const netProfit = Number(trade.netProfit) || 0;
          entry.tradeCount += 1;
          entry.netProfit += netProfit;
          if (netProfit > 0) entry.winningTrades += 1;
          else entry.losingTrades += 1;
          grouped.set(reason, entry);
        }
      }
      return [...grouped.values()]
        .map(entry => ({
          ...entry,
          winRate: entry.tradeCount > 0 ? (entry.winningTrades / entry.tradeCount) * 100 : 0,
          profitFactor: entry.losingTrades > 0
            ? (closedTrades
              .filter(trade => Array.isArray(trade.rejectionReasons) && trade.rejectionReasons.includes(entry.reason) && Number(trade.netProfit) > 0)
              .reduce((sum, trade) => sum + Number(trade.netProfit), 0) /
              Math.abs(closedTrades
                .filter(trade => Array.isArray(trade.rejectionReasons) && trade.rejectionReasons.includes(entry.reason) && Number(trade.netProfit) <= 0)
                .reduce((sum, trade) => sum + Number(trade.netProfit), 0)))
            : entry.winningTrades > 0 ? Infinity : 0
        }))
        .sort((a, b) => b.tradeCount - a.tradeCount || b.netProfit - a.netProfit);
    };
    const shadowRejectionOutcomes = summarizeRejectionOutcomes(shadowClosedTrades);
    const looseRejectionOutcomes = summarizeRejectionOutcomes(looseClosedTrades);
    const shadowExecutionBoundary = this.owner.getExecutionBoundaryBlockedEntrySummary(shadow);
    const looseExecutionBoundary = this.owner.getExecutionBoundaryBlockedEntrySummary(looseShadow);
    const strictLossCircuitBreaker = this.owner.getLossCircuitBreakerStatus('strict');
    const shadowLossCircuitBreaker = this.owner.getLossCircuitBreakerStatus('shadow');
    const looseShadowLossCircuitBreaker = this.owner.getLossCircuitBreakerStatus('looseShadow');
    const winnerShadowLossCircuitBreaker = this.owner.getLossCircuitBreakerStatus('winnerShadow');
    const baselineAssets = Number(session.baselineAssets) || 0;
    const returnPercent = baselineAssets > 0 ? ((currentAssets / baselineAssets) - 1) * 100 : 0;
    const thresholds = session.thresholds || {};
    const strictTradeConfidence = calculateTradeReturnConfidence(startedTrades);
    const strictConfidenceGate = evaluateStatisticalConfidenceGate({
      tradeReturnConfidence: strictTradeConfidence
    }, {
      required: true,
      minimumTrades: Number(thresholds.minTrades) || 20,
      minimumLowerBoundPercent: Number.isFinite(Number(thresholds.minConfidenceLowerBoundPercent))
        ? Number(thresholds.minConfidenceLowerBoundPercent)
        : 0
    });
    const interruptions = Array.isArray(session.interruptions) ? session.interruptions : [];
    const maxHeartbeatGapMinutes = Number(thresholds.maxHeartbeatGapMinutes) || 15;
    const maxAllowedHeartbeatGapMs = maxHeartbeatGapMinutes * 60 * 1000;
    const heartbeatContinuityEligible = !orphaned && interruptions.every(interruption =>
      Number(interruption.gapMs) <= maxAllowedHeartbeatGapMs
    );
    const riskMonitor = this.owner.getRiskMonitorStatus();
    const analysisDataHealth = this.owner.getAnalysisDataHealthStatus();
    const currentDiagnosticOpenPositions = this.owner.getPaperDiagnosticOpenPositionSnapshot();
    const endedWithOpenPositions = session.endedWithOpenPositions === true ||
      (orphaned && strictOpenPositions.length > 0);
    const endedWithDiagnosticOpenPositions = session.endedWithDiagnosticOpenPositions === true ||
      ((session.active === false || orphaned) && currentDiagnosticOpenPositions.length > 0);
    const continuityEligible = heartbeatContinuityEligible &&
      riskMonitor.continuityEligible &&
      analysisDataHealth.continuityEligible;
    const minimumResearchDays = Number(thresholds.minDays) || 7;
    const minimumResearchTrades = Number(thresholds.minTrades) || 20;
    const minimumReturnPercent = Number(thresholds.minReturnPercent) || 0.2;
    const maximumDrawdownPercent = Number(thresholds.maxDrawdownPercent) || 15;
    const eligible = session.active !== true &&
      !orphaned &&
      continuityEligible &&
      !endedWithDiagnosticOpenPositions &&
      configSnapshotComplete &&
      configComparison.consistent === true &&
      experimentComparison.consistent === true &&
      elapsedDays >= minimumResearchDays &&
      startedTrades.length >= minimumResearchTrades &&
      strictConfidenceGate.passed &&
      executionRobustnessGate.passed &&
      returnPercent >= minimumReturnPercent &&
      maxDrawdownPercent <= maximumDrawdownPercent;
    const promotionBlockers = [];
    if (session.active === true) {
      promotionBlockers.push('관찰 세션이 아직 진행 중이라 최종 수익성 판정을 할 수 없습니다.');
    }
    if (orphaned) {
      promotionBlockers.push(orphanReason === 'heartbeat_stale'
        ? 'owner heartbeat가 오래되어 관찰 연속성을 확인할 수 없습니다.'
        : 'owner process가 현재 관찰 중 상태가 아닙니다.');
    }
    if (!configSnapshotComplete) {
      promotionBlockers.push('전략 설정 snapshot이 불완전해 동일 조건을 재현할 수 없습니다.');
    }
    if (configComparison.consistent !== true) {
      promotionBlockers.push('전략 설정 변경 이력이 있어 동일 조건 비교를 할 수 없습니다.');
    }
    if (experimentComparison.consistent !== true) {
      promotionBlockers.push('paper 연구 실험 설정이 달라 동일 조건 비교를 할 수 없습니다.');
    }
    if (!executionRobustnessGate.passed) {
      if (executionRobustnessGate.reason === 'execution_comparison_pairs_insufficient') {
        promotionBlockers.push(`실행 경계 비교 표본이 ${executionRobustnessGate.pairedCount}/${executionRobustnessGate.minimumPairs}쌍으로 부족합니다.`);
      } else if (executionRobustnessGate.reason === 'execution_positive_to_negative_flip_detected') {
        promotionBlockers.push(`동일 신호에서 strict 양수·shadow 음수 부호 변경 ${executionRobustnessGate.strictPositiveDiagnosticNegativeCount}건이 확인되었습니다.`);
      } else if (executionRobustnessGate.reason === 'diagnostic_pair_profit_not_positive') {
        promotionBlockers.push('동일 신호 paired diagnostic 손익이 양수가 아니어서 실행 경계 강건성을 확인할 수 없습니다.');
      } else if (executionRobustnessGate.reason === 'execution_outcome_sign_flip_detected') {
        promotionBlockers.push(`동일 신호 실행 결과 부호 변경 ${executionRobustnessGate.signFlipCount}건이 확인되었습니다.`);
      }
    }
    if (continuityEligible !== true) {
      promotionBlockers.push('시세·분석·heartbeat 연속성이 깨져 관찰을 증명할 수 없습니다.');
    }
    if (elapsedDays < minimumResearchDays) {
      promotionBlockers.push(`관찰 기간 ${elapsedDays.toFixed(2)}/${minimumResearchDays}일로 부족합니다.`);
    }
    if (startedTrades.length < minimumResearchTrades) {
      promotionBlockers.push(`청산 표본이 ${startedTrades.length}/${minimumResearchTrades}회로 부족합니다.`);
    }
    if (strictConfidenceGate.passed !== true) {
      if (strictTradeConfidence.sampleCount < minimumResearchTrades) {
        promotionBlockers.push(`거래수익 95% 통계 하한을 계산할 유효 표본이 ${strictTradeConfidence.sampleCount}/${minimumResearchTrades}건으로 부족합니다.`);
      } else if (!Number.isFinite(Number(strictTradeConfidence.lowerBoundPercent))) {
        promotionBlockers.push('거래수익 95% 통계 하한을 계산할 수 없습니다.');
      } else if (Number(strictTradeConfidence.lowerBoundPercent) < 0) {
        promotionBlockers.push('거래수익 95% 하한이 0% 미만이라 안정적인 양수 수익을 확인할 수 없습니다.');
      }
    }
    if (returnPercent < minimumReturnPercent) {
      promotionBlockers.push(`실현 순수익률 ${returnPercent.toFixed(2)}%가 기준 ${minimumReturnPercent}%보다 낮습니다.`);
    }
    if (maxDrawdownPercent > maximumDrawdownPercent) {
      promotionBlockers.push(`최대 낙폭 ${maxDrawdownPercent.toFixed(2)}%가 기준 ${maximumDrawdownPercent}%를 초과합니다.`);
    }
    if (strictOpenPositions.length > 0) {
      promotionBlockers.push(`미청산 strict 포지션 ${strictOpenPositions.length}개가 있어 평가손익만으로는 전환할 수 없습니다.`);
    }
    if (endedWithDiagnosticOpenPositions) {
      promotionBlockers.push('미청산 diagnostic 포지션이 있어 비교 장부를 완결할 수 없습니다.');
    }
    const telemetry = session.telemetry || null;
    // Freshness cohort selection is deliberately diagnostic-only. It makes
    // the next isolated paper run reproducible when a universe contains
    // inactive markets, but it never changes this session's target list,
    // strict metrics, or live-promotion gate.
    const configuredMinimumMarketObservations = envNumber('SCALP_MARKET_QUALITY_MIN_OBSERVATIONS');
    const configuredMaximumFreshnessBlockRate = envNumber('SCALP_MARKET_QUALITY_MAX_STALE_RATE');
    const marketFreshnessCohort = selectFreshMarketCohort({
      markets: session.targetCoins || this.owner.targetCoins,
      telemetry: telemetry || {},
      minObservations: Number.isFinite(configuredMinimumMarketObservations) && configuredMinimumMarketObservations > 0
        ? configuredMinimumMarketObservations
        : MARKET_QUALITY_DEFAULTS.minObservations,
      maxFreshnessBlockRate: Number.isFinite(configuredMaximumFreshnessBlockRate) && configuredMaximumFreshnessBlockRate >= 0 && configuredMaximumFreshnessBlockRate <= 1
        ? configuredMaximumFreshnessBlockRate
        : MARKET_QUALITY_DEFAULTS.maxFreshnessBlockRate,
      maxMarkets: session.targetCoins?.length || this.owner.targetCoins.length || Infinity
    });
    const signalTelemetryAvailable = telemetry?.signalTelemetryVersion === 1 &&
      Boolean(telemetry.signalTelemetryCoverageStartedAt);
    const uniqueSignalWindows = signalTelemetryAvailable
      ? Number(telemetry.uniqueSignalWindows) || 0
      : null;
    const uniqueSignalWindowsByCoin = signalTelemetryAvailable
      ? telemetry.uniqueSignalWindowsByCoin || {}
      : {};
    const uniqueReasonCounts = signalTelemetryAvailable
      ? telemetry.uniqueReasonCounts || {}
      : {};
    const uniqueRejectionCounts = signalTelemetryAvailable
      ? telemetry.uniqueRejectionCounts || {}
      : {};
    const strictReboundCandidates = telemetry && Number.isFinite(Number(telemetry.strictReboundCandidates))
      ? Number(telemetry.strictReboundCandidates)
      : Number(telemetry?.shadowCandidates) || 0;
    const strictConfirmedCandidates = telemetry && Number.isFinite(Number(telemetry.strictConfirmedCandidates))
      ? Number(telemetry.strictConfirmedCandidates)
      : 0;
    const oversoldObservations = telemetry && Number.isFinite(Number(telemetry.oversoldObservations))
      ? Number(telemetry.oversoldObservations)
      : strictReboundCandidates;
    // A quiet market (no prior oversold + bullish rebound candidates) is not
    // filter starvation. Only show tuning guidance when a real strict
    // rebound candidate existed, no strict candidate was confirmed, and no
    // BUY was emitted. This prevents automatic-looking advice from turning a
    // normal lack of setups into an unjustified parameter relaxation.
    const filterStarvation = Boolean(telemetry && telemetry.cycles >= 20 &&
      telemetry.buyCandidates === 0 && strictReboundCandidates > 0 &&
      strictConfirmedCandidates === 0);
    const marketQuiet = Boolean(telemetry && telemetry.cycles >= 20 &&
      telemetry.buyCandidates === 0 && strictReboundCandidates === 0 &&
      strictConfirmedCandidates === 0 && oversoldObservations === 0);
    const oversoldObservedNoRebound = Boolean(telemetry && telemetry.cycles >= 20 &&
      telemetry.buyCandidates === 0 && oversoldObservations > 0 &&
      strictReboundCandidates === 0 && strictConfirmedCandidates === 0);
    const rsiProximityTelemetry = telemetry?.rsiProximity || {};
    const configuredRsiOversold = Number(this.owner.config.rsiOversold ?? this.owner.strategyConfig?.rsiOversold ?? 30);
    const rsiProximity = {
      version: Number(rsiProximityTelemetry.version) || 1,
      threshold: Number.isFinite(Number(rsiProximityTelemetry.threshold))
        ? Number(rsiProximityTelemetry.threshold)
        : Number.isFinite(configuredRsiOversold) ? configuredRsiOversold : null,
      nearThresholdBand: Number.isFinite(Number(rsiProximityTelemetry.nearThresholdBand))
        ? Number(rsiProximityTelemetry.nearThresholdBand)
        : 5,
      uniqueAvailableWindows: Number(rsiProximityTelemetry.uniqueAvailableWindows) || 0,
      uniqueAvailableWindowsByCoin: rsiProximityTelemetry.uniqueAvailableWindowsByCoin || {},
      minimumPreviousRsi: Number.isFinite(Number(rsiProximityTelemetry.minimumPreviousRsi))
        ? Number(rsiProximityTelemetry.minimumPreviousRsi)
        : null,
      minimumPreviousRsiByCoin: rsiProximityTelemetry.minimumPreviousRsiByCoin || {},
      nearThresholdWindows: Number(rsiProximityTelemetry.nearThresholdWindows) || 0,
      nearThresholdWindowsByCoin: rsiProximityTelemetry.nearThresholdWindowsByCoin || {}
    };
    const signalFunnelTelemetry = telemetry?.signalFunnel || {};
    const signalFunnel = {
      version: Number(signalFunnelTelemetry.version) || 1,
      availableWindows: Number(signalFunnelTelemetry.availableWindows) || 0,
      oversoldWindows: Number(signalFunnelTelemetry.oversoldWindows) || 0,
      bullishWindows: Number(signalFunnelTelemetry.bullishWindows) || 0,
      priceReboundWindows: Number(signalFunnelTelemetry.priceReboundWindows) || 0,
      rsiRecoveryWindows: Number(signalFunnelTelemetry.rsiRecoveryWindows) || 0,
      volumeWindows: Number(signalFunnelTelemetry.volumeWindows) || 0,
      candleRangeWindows: Number(signalFunnelTelemetry.candleRangeWindows) || 0,
      closeStrengthWindows: Number(signalFunnelTelemetry.closeStrengthWindows) || 0,
      trendWindows: Number(signalFunnelTelemetry.trendWindows) || 0,
      previousHighBreakWindows: Number(signalFunnelTelemetry.previousHighBreakWindows) || 0,
      profileWindows: Number(signalFunnelTelemetry.profileWindows) || 0,
      confirmedWindows: Number(signalFunnelTelemetry.confirmedWindows) || 0
    };
    const lastSignalEvidenceByCoin = telemetry?.lastSignalEvidenceByCoin || {};
    const suggestedAdjustments = [];
    if (filterStarvation) {
      const reasonCounts = signalTelemetryAvailable && Object.keys(uniqueReasonCounts).length > 0
        ? uniqueReasonCounts
        : telemetry.reasonCounts || {};
      const reasonText = Object.keys(reasonCounts).join(' ');
      const rejectionCounts = signalTelemetryAvailable && Object.keys(uniqueRejectionCounts).length > 0
        ? uniqueRejectionCounts
        : telemetry.rejectionCounts || {};
      const rejectionSuggestions = {
        previous_rsi_not_oversold: 'oversoldLookback=3 후보를 별도 holdout 검증',
        volume_confirmation_failed: 'minVolumeRatio=0.8 후보를 별도 holdout 검증',
        price_rebound_below_threshold: 'minReboundPercent=0.10 후보를 별도 holdout 검증',
        price_rebound_above_threshold: 'maxReboundPercent=0.40 후보를 별도 holdout 검증',
        previous_high_break_failed: '직전 고가 돌파 필터 유지/완화 프로파일을 병렬 비교',
        rsi_recovery_below_threshold: 'minRsiRecovery=1 후보를 별도 holdout 검증',
        close_strength_failed: 'minCloseStrength=0.55 후보를 별도 holdout 검증',
        trend_filter_failed: 'minTrendSlopePercent=-0.5 후보를 별도 holdout 검증',
        signal_range_too_narrow: 'minSignalRangePercent=0.2/0.4 후보를 별도 holdout 검증'
      };
      const keepFilterSuggestions = {
        previous_rsi_not_oversold: '현재 RSI 과매도 필터 유지',
        volume_confirmation_failed: 'minVolumeRatio=1.0 필터 유지',
        price_rebound_below_threshold: 'minReboundPercent=0.15 필터 유지',
        price_rebound_above_threshold: '과대 반등 상한은 별도 검증 전 적용 금지',
        previous_high_break_failed: '직전 고가 돌파 필터 유지',
        rsi_recovery_below_threshold: 'minRsiRecovery=2 필터 유지',
        close_strength_failed: 'minCloseStrength=0.65 필터 유지',
        trend_filter_failed: 'minTrendSlopePercent=-0.2 필터 유지',
        signal_range_too_narrow: '신호 변동폭 하한은 별도 검증 전 비활성 유지'
      };
      const shadowOutcomeByReason = new Map(
        shadowRejectionOutcomes.map(outcome => [outcome.reason, outcome])
      );
      const rankedRejections = Object.entries(rejectionCounts)
        .sort((a, b) => b[1] - a[1]);
      const outcomeBackedRejections = rankedRejections
        .filter(([reason]) => {
          const outcome = shadowOutcomeByReason.get(reason);
          return outcome?.tradeCount >= 3 && outcome.netProfit < 0;
        });
      const reasonsToSuggest = [
        ...outcomeBackedRejections,
        ...rankedRejections
      ].filter(([reason], index, entries) => entries.findIndex(([candidate]) => candidate === reason) === index)
        .slice(0, 3);
      reasonsToSuggest
        .forEach(([reason, count]) => {
          const outcome = shadowOutcomeByReason.get(reason);
          if (outcome?.tradeCount >= 3 && outcome.netProfit < 0) {
            suggestedAdjustments.push(`${keepFilterSuggestions[reason] || reason} · shadow ${outcome.tradeCount}회 손익 ${outcome.netProfit.toFixed(2)}원/PF ${Number.isFinite(outcome.profitFactor) ? outcome.profitFactor.toFixed(2) : '∞'} → 완화 금지 (${count}회 거절)`);
          } else if (rejectionSuggestions[reason]) {
            suggestedAdjustments.push(`${rejectionSuggestions[reason]} (${count}회)`);
          }
        });
      if (suggestedAdjustments.length === 0 && reasonText.includes('최소 반등률')) {
        suggestedAdjustments.push('다음 홀드아웃에서 minReboundPercent=0.10 후보를 별도 검증');
      }
      if (suggestedAdjustments.length === 0 && reasonText.includes('거래량')) {
        suggestedAdjustments.push('다음 홀드아웃에서 minVolumeRatio=0.8 후보를 별도 검증');
      }
      if (suggestedAdjustments.length === 0 && reasonText.includes('고가 돌파')) {
        suggestedAdjustments.push('직전 고가 돌파 필터를 유지/완화한 두 프로파일을 병렬 비교');
      }
      if (suggestedAdjustments.length === 0) {
        suggestedAdjustments.push('현재 시장에는 유효한 반등 후보가 없음; 파라미터 자동 완화 금지');
      }
    }

    return {
      available: true,
      active: session.active === true && !orphaned,
      eligible,
      state: eligible ? 'PASS' : session.active === false || orphaned ? 'STOPPED' : 'RUNNING',
      orphaned,
      sessionId: session.sessionId,
      strategyMode: session.strategyMode,
      strategyProfile: session.strategyProfile,
      configSnapshot: session.configSnapshot || null,
      paperExperiments: session.paperExperiments || null,
      paperExperimentConsistent: experimentComparison.consistent,
      paperExperimentDrift: experimentComparison.drift,
      configConsistent: configComparison.consistent,
      configDrift: configComparison.drift,
      configSchemaDrift: configComparison.schemaDrift,
      configValueDrift: configComparison.valueDrift,
      configBackwardCompatibleMissing: configComparison.backwardCompatibleMissing,
      configSnapshotComplete,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      processId: session.processId || null,
      processAlive: ownerProcessAlive,
      elapsedDays,
      orphanReason,
      promotionBlockers,
      baselineAssets,
      currentAssets,
      returnPercent,
      realizedProfit,
      closedTradeCount: startedTrades.length,
      strictRecentTrades,
      maxDrawdownPercent,
      baselineIncludesHoldings: session.baselineIncludesHoldings === true,
      endedWithOpenPositions,
      endedWithDiagnosticOpenPositions,
      diagnosticOpenPositions: currentDiagnosticOpenPositions,
      diagnosticOpenPositionsAtStop: Array.isArray(session.diagnosticOpenPositionsAtStop)
        ? session.diagnosticOpenPositionsAtStop
        : [],
      pendingCounterfactualCountAtStop: Number(session.pendingCounterfactualCountAtStop) || 0,
      stopReason: session.stopReason || null,
      terminalError: session.terminalError || session.lastError || null,
      thresholds,
      snapshotCount: snapshots.length,
      lastSnapshotAt: snapshots.at(-1)?.timestamp || session.startedAt,
      strictLedgerTradeCount: strictLedgerTrades.length,
      strictRiskState: session.strictRiskState || null,
      strictTradeConfidence,
      strictConfidenceGate,
      exitEvidence,
      signalWindow: this.owner.getStrictSignalWindowStatus(),
      lossCircuitBreaker: strictLossCircuitBreaker,
      strictEvaluation: {
        activePositions: strictOpenPositions.length,
        positions: strictOpenPositions,
        closedTradeCount: startedTrades.length,
        signalWindowCoverage: exitEvidence.strict.signalWindowCoverage,
        realizedProfit,
        winningTrades: strictWinningTrades,
        losingTrades: strictLosingTrades,
        winRate: startedTrades.length > 0 ? (strictWinningTrades / startedTrades.length) * 100 : null,
        recentTrades: strictRecentTrades,
        tradeReturnConfidence: strictTradeConfidence,
        confidenceGate: strictConfidenceGate,
        lossCircuitBreaker: strictLossCircuitBreaker,
        note: '현재 프로세스의 strict 전략 포지션 snapshot입니다. 청산 전 손익은 currentAssets/returnPercent에 평가손익으로 반영됩니다.'
      },
      executionOutcomeComparison,
      executionRobustnessGate,
      heartbeatAt,
      heartbeatAgeMs,
      heartbeatContinuityEligible,
      continuityEligible,
      riskMonitor,
      analysisDataHealth,
      interruptionCount: interruptions.length,
      maxInterruptionMinutes: interruptions.length > 0
        ? Math.max(...interruptions.map(interruption => Number(interruption.gapMs) || 0)) / 60000
        : 0,
      storage: this.owner.getStorageStatus(),
      candleFreshness: {
        maxAgeSeconds: this.owner.maxCandleAgeSeconds,
        blockedSnapshots: Number(telemetry?.candleFreshnessBlockedSnapshots) || 0,
        blockedAnalyses: Number(telemetry?.candleFreshnessBlockedAnalyses) || 0,
        blockedEntries: Number(telemetry?.candleFreshnessBlockedEntries) || 0,
        blockReasons: telemetry?.candleFreshnessBlockReasons || {},
        blockedByCoin: telemetry?.candleFreshnessBlockedByCoin || {},
        observedByCoin: telemetry?.candleFreshnessObservedByCoin || {},
        ageStatsByCoin: Object.fromEntries(
          Object.entries(telemetry?.candleFreshnessAgeStatsByCoin || {})
            .map(([coin, ageStats]) => {
              const sampleCount = Number(ageStats?.sampleCount) || 0;
              return [coin, {
                sampleCount,
                validCount: Number(ageStats?.validCount) || 0,
                blockedCount: Number(ageStats?.blockedCount) || 0,
                missingTimestampCount: Number(ageStats?.missingTimestampCount) || 0,
                minAgeSeconds: Number.isFinite(Number(ageStats?.minAgeSeconds))
                  ? Number(ageStats.minAgeSeconds)
                  : null,
                maxObservedAgeSeconds: Number.isFinite(Number(ageStats?.maxObservedAgeSeconds))
                  ? Number(ageStats.maxObservedAgeSeconds)
                  : null,
                averageAgeSeconds: sampleCount > 0
                  ? (Number(ageStats?.totalAgeSeconds) || 0) / sampleCount
                  : null
              }];
            })
        ),
        blockContexts: telemetry?.candleFreshnessBlockContexts || {},
        ageStats: (() => {
          const ageStats = telemetry?.candleFreshnessAgeStats || {};
          const sampleCount = Number(ageStats.sampleCount) || 0;
          return {
            sampleCount,
            minAgeSeconds: Number.isFinite(Number(ageStats.minAgeSeconds))
              ? Number(ageStats.minAgeSeconds)
              : null,
            maxObservedAgeSeconds: Number.isFinite(Number(ageStats.maxObservedAgeSeconds))
              ? Number(ageStats.maxObservedAgeSeconds)
              : null,
            averageAgeSeconds: sampleCount > 0
              ? (Number(ageStats.totalAgeSeconds) || 0) / sampleCount
              : null
          };
        })(),
        lastBlock: telemetry?.lastCandleFreshnessBlock || null
      },
      candleDataQuality: {
        insufficientByCoin: telemetry?.insufficientCandleDataByCoin || {},
        minimumCandleCount: Math.max(50, (Number(this.owner.config?.rsiPeriod) || 14) + 10)
      },
      marketFreshnessCohort: {
        diagnosticOnly: true,
        minObservations: marketFreshnessCohort.minObservations,
        maxFreshnessBlockRate: marketFreshnessCohort.maxFreshnessBlockRate,
        maxMarkets: marketFreshnessCohort.maxMarkets,
        observedMarketCount: marketFreshnessCohort.selectedRows.length + marketFreshnessCohort.excludedRows.length,
        ready: marketFreshnessCohort.selectedMarkets.length > 0,
        selectedMarkets: marketFreshnessCohort.selectedMarkets,
        selectedRows: marketFreshnessCohort.selectedRows,
        excludedRows: marketFreshnessCohort.excludedRows
      },
      telemetry,
      signalTelemetry: {
        available: signalTelemetryAvailable,
        coverageStartedAt: signalTelemetryAvailable
          ? telemetry.signalTelemetryCoverageStartedAt
          : null,
        dedupeKey: 'coin:rebound.signalKey',
        uniqueSignalWindows,
        uniqueSignalWindowsByCoin,
        uniqueReasonCounts,
        uniqueRejectionCounts,
        note: 'cycle 반복을 제거한 고유 완료 캔들 window 기준입니다. 구버전 ledger는 새 source로 다시 관측할 때부터 집계합니다.'
      },
      shadowEvaluation: {
        activePositions: Object.keys(shadow.positions || {}).length,
        entryCount: Number(shadow.entryCount) || 0,
        closedTradeCount: shadowClosedTrades.length,
        realizedProfit: shadowRealizedProfit,
        realizedReturnPercent: shadowTotalInvested > 0 ? (shadowRealizedProfit / shadowTotalInvested) * 100 : 0,
        winningTrades: shadowWinners,
        losingTrades: shadowLosers,
        winRate: shadowClosedTrades.length > 0 ? (shadowWinners / shadowClosedTrades.length) * 100 : 0,
        profitFactor: shadowProfitFactor,
        positions: shadowOpenPositions,
        lossCircuitBreaker: shadowLossCircuitBreaker,
        rejectionOutcomes: shadowRejectionOutcomes,
        executionBoundary: shadowExecutionBoundary,
        recentTrades: shadowRecentTrades,
        lastEntryAt: shadow.lastEntryAt || null,
        lastExitAt: shadow.lastExitAt || null,
        note: 'soft 후보를 별도 가상 장부로 추적한 참고치이며 strict paper 자산과 실전 승격 판정에는 포함하지 않습니다. 미청산 positions는 entry와 MFE/MAE만 표시하고 실현손익에 합산하지 않습니다.'
      },
      looseShadowEvaluation: {
        activePositions: Object.keys(looseShadow.positions || {}).length,
        entryCount: Number(looseShadow.entryCount) || 0,
        closedTradeCount: looseClosedTrades.length,
        realizedProfit: looseRealizedProfit,
        realizedReturnPercent: looseTotalInvested > 0 ? (looseRealizedProfit / looseTotalInvested) * 100 : 0,
        winningTrades: looseWinners,
        losingTrades: looseLosers,
        winRate: looseClosedTrades.length > 0 ? (looseWinners / looseClosedTrades.length) * 100 : 0,
        profitFactor: looseProfitFactor,
        positions: looseOpenPositions,
        lossCircuitBreaker: looseShadowLossCircuitBreaker,
        rejectionOutcomes: looseRejectionOutcomes,
        executionBoundary: looseExecutionBoundary,
        recentTrades: looseRecentTrades,
        lastEntryAt: looseShadow.lastEntryAt || null,
        lastExitAt: looseShadow.lastExitAt || null,
        note: '더 완화된 후보를 별도 추적한 진단용 장부이며 strict paper 자산·승격 판정에 포함하지 않습니다. 미청산 positions는 entry와 MFE/MAE만 표시하고 실현손익에 합산하지 않습니다.'
      },
      winnerShadowEvaluation: {
        enabled: session.paperExperiments?.winnerShadow?.enabled === true ||
          this.owner.winnerShadowExtendMinutes > 0 || this.owner.winnerShadowMaxReboundPercent > 0,
        entryContract: session.paperExperiments?.winnerShadow?.entryContract ||
          (this.owner.winnerShadowMaxReboundPercent > 0
            ? 'strict_confirmed_buy_signal_with_optional_rebound_ceiling'
            : 'strict_confirmed_buy_signal'),
        winnerExtendMinutes: Number(session.paperExperiments?.winnerShadow?.winnerExtendMinutes ?? this.owner.winnerShadowExtendMinutes) || 0,
        winnerExtendMinProfitPercent: Number(session.paperExperiments?.winnerShadow?.winnerExtendMinProfitPercent ?? this.owner.winnerShadowExtendMinProfitPercent) || 0,
        entryMaxReboundPercent: Number(session.paperExperiments?.winnerShadow?.entryMaxReboundPercent ?? this.owner.winnerShadowMaxReboundPercent) || 0,
        activePositions: Object.keys(winnerShadow.positions || {}).length,
        entryCount: Number(winnerShadow.entryCount) || 0,
        closedTradeCount: winnerShadowClosedTrades.length,
        realizedProfit: winnerShadowRealizedProfit,
        realizedReturnPercent: winnerShadowTotalInvested > 0 ? (winnerShadowRealizedProfit / winnerShadowTotalInvested) * 100 : 0,
        winningTrades: winnerShadowWinners,
        losingTrades: winnerShadowLosers,
        winRate: winnerShadowClosedTrades.length > 0 ? (winnerShadowWinners / winnerShadowClosedTrades.length) * 100 : 0,
        profitFactor: winnerShadowProfitFactor,
        positions: winnerShadowOpenPositions,
        lossCircuitBreaker: winnerShadowLossCircuitBreaker,
        reboundBlockedEntries: Number(telemetry?.winnerShadowReboundBlockedEntries) || 0,
        blockedEntryCount: winnerShadowBlockedEntries.length,
        pendingBlockedEntryCount: winnerShadowPendingBlockedEntries.length,
        notFilledBlockedEntryCount: winnerShadowNotFilledBlockedEntries.length,
        resolvedBlockedEntryCount: winnerShadowSettledBlockedEntries.length + winnerShadowNotFilledBlockedEntries.length,
        settledBlockedEntryCount: winnerShadowSettledBlockedEntries.length,
        counterfactualRealizedProfit: winnerShadowCounterfactualProfit,
        counterfactualWinningTrades: winnerShadowCounterfactualWinners,
        counterfactualLosingTrades: winnerShadowCounterfactualLosers,
        counterfactualProfitFactor: winnerShadowCounterfactualProfitFactor,
        recentBlockedEntries: winnerShadowBlockedEntries.slice(-5),
        recentTrades: winnerShadowRecentTrades,
        lastEntryAt: winnerShadow.lastEntryAt || null,
        lastExitAt: winnerShadow.lastExitAt || null,
        note: 'strict confirmed BUY 신호를 같은 entry 장부로 재생하고 winner-hold exit 후보만 적용하는 연구용 장부입니다. strict 자산·승격 판정에는 포함하지 않습니다.'
      },
      filterStarvation,
      marketQuiet,
      oversoldObservedNoRebound,
      signalAvailability: {
        oversoldObservations,
        strictReboundCandidates,
        strictConfirmedCandidates,
        uniqueSignalWindows,
        rsiProximity,
        signalFunnel,
        lastSignalEvidenceByCoin
      },
      suggestedAdjustments
    };
  }


  recordPaperIncompleteAnalysisTelemetry(analysisHealth) {
    if (!this.owner.dryRun || !this.paperValidation?.active || analysisHealth?.complete === true) return;
    const telemetry = this.paperValidation.telemetry || {};
    telemetry.analysisIncompleteCycles = Number(telemetry.analysisIncompleteCycles) || 0;
    telemetry.analysisMissingMarkets = Number(telemetry.analysisMissingMarkets) || 0;
    telemetry.analysisIncompleteCycles += 1;
    telemetry.analysisMissingMarkets += analysisHealth.missingMarkets?.length || 0;
    telemetry.lastIncompleteAnalysis = {
      at: new Date().toISOString(),
      expectedMarketCount: analysisHealth.expectedMarketCount,
      analyzedMarketCount: analysisHealth.analyzedMarketCount,
      missingMarkets: analysisHealth.missingMarkets || [],
      gapDurationSeconds: analysisHealth.gapDurationSeconds,
      failClosed: analysisHealth.failClosed === true,
      failureCode: analysisHealth.failureCode || null,
      failureMarkets: analysisHealth.failureMarkets || [],
      failureCounts: analysisHealth.status?.failureCounts || {},
      transportFailureCodes: analysisHealth.transportFailureCodes || {}
    };
    telemetry.reasonCounts = telemetry.reasonCounts || {};
    const reason = `분석 데이터 불완전 - ${analysisHealth.missingMarkets?.join(', ') || '시장 응답 없음'}`;
    telemetry.reasonCounts[reason] = (telemetry.reasonCounts[reason] || 0) + 1;
    telemetry.requestStats = telemetry.requestStats || {
      batchTickerRequests: 0,
      individualTickerRequests: 0,
      candleRequests: 0,
      batchTickerFailures: 0
    };
    const requestStats = this.owner.cycleRequestStats || {};
    for (const key of ['batchTickerRequests', 'individualTickerRequests', 'candleRequests', 'batchTickerFailures']) {
      telemetry.requestStats[key] = (Number(telemetry.requestStats[key]) || 0) + (Number(requestStats[key]) || 0);
    }
    this.owner.cycleRequestStats = null;
    const now = new Date().toISOString();
    telemetry.cycles = (Number(telemetry.cycles) || 0) + 1;
    telemetry.lastCycleAt = now;
    telemetry.heartbeatAt = now;
    this.paperValidation.heartbeatAt = now;
    telemetry.analysisDataHealth = { ...this.owner.analysisDataHealthState };
    this.paperValidation.telemetry = telemetry;
    this.paperValidation.lastTelemetryPersistedAt = now;
    this.owner.savePaperValidation();
  }
}
