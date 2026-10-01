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
import path from 'path';
import { createAnalysisDataHealthState } from '../risk/analysisDataHealth.js';
import { PaperValidationStatus } from './paperValidationStatus.js';
import { PaperValidationBlockedEntries } from './paperValidationBlockedEntries.js';
import { PaperValidationTelemetry } from './paperValidationTelemetry.js';
import {
  derivePositionExcursion,
  updatePositionExcursion,
  validTimestamp
} from './paperValidationUtils.js';
import {
  createLossCircuitBreakerState,
  getLossCircuitBreakerStatus,
  isLossCircuitCoolingDown,
  registerLoss
} from '../risk/lossCircuitBreaker.js';
import { createRiskMonitorState } from '../risk/riskMonitor.js';
import { calculateCostAdjustedBreakEvenPrice } from '../strategy/protectionPrices.js';

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

export class PaperValidationJournal {
  constructor(owner) {
    this.owner = owner;
    this.paperValidation = null;
    this.paperValidationFile = null;
    this.paperMinimumStorageMiB = 1024;
    this.runtimeSignalWindowEntryCounts = new Map();
  }

  _pvStatus() {
    if (!this.__pvStatus) this.__pvStatus = new PaperValidationStatus(this);
    return this.__pvStatus;
  }

  _pvBlocked() {
    if (!this.__pvBlocked) this.__pvBlocked = new PaperValidationBlockedEntries(this);
    return this.__pvBlocked;
  }

  _pvTelemetry() {
    if (!this.__pvTelemetry) this.__pvTelemetry = new PaperValidationTelemetry(this);
    return this.__pvTelemetry;
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
  getPaperValidationStatus(...args) { return this._pvStatus().getPaperValidationStatus(...args); }

  recordExecutionBoundaryBlockedEntry(...args) { return this._pvBlocked().recordExecutionBoundaryBlockedEntry(...args); }
  updateExecutionBoundaryBlockedEntries(...args) { return this._pvBlocked().updateExecutionBoundaryBlockedEntries(...args); }
  resolveExecutionBoundaryBlockedEntriesAtStop(...args) { return this._pvBlocked().resolveExecutionBoundaryBlockedEntriesAtStop(...args); }
  getExecutionBoundaryBlockedEntrySummary(...args) { return this._pvBlocked().getExecutionBoundaryBlockedEntrySummary(...args); }
  recordWinnerShadowBlockedEntry(...args) { return this._pvBlocked().recordWinnerShadowBlockedEntry(...args); }
  settleWinnerShadowBlockedEntries(...args) { return this._pvBlocked().settleWinnerShadowBlockedEntries(...args); }
  resolveWinnerShadowBlockedEntryAsNotFilled(...args) { return this._pvBlocked().resolveWinnerShadowBlockedEntryAsNotFilled(...args); }

  recordPaperSignalTelemetry(...args) { return this._pvTelemetry().recordPaperSignalTelemetry(...args); }
  recordPaperCircuitBlock(...args) { return this._pvTelemetry().recordPaperCircuitBlock(...args); }
  recordPaperSignalWindowBlock(...args) { return this._pvTelemetry().recordPaperSignalWindowBlock(...args); }
  recordPaperMarketRegimeBlock(...args) { return this._pvTelemetry().recordPaperMarketRegimeBlock(...args); }
  recordInsufficientCandleData(...args) { return this._pvTelemetry().recordInsufficientCandleData(...args); }
  recordPaperCandleFreshnessObservation(...args) { return this._pvTelemetry().recordPaperCandleFreshnessObservation(...args); }
  recordPaperCandleFreshnessBlock(...args) { return this._pvTelemetry().recordPaperCandleFreshnessBlock(...args); }
  recordPaperEntryConfirmation(...args) { return this._pvTelemetry().recordPaperEntryConfirmation(...args); }

}
