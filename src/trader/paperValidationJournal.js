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
import { PaperValidationStatus } from './paperValidationStatus.js';
import { PaperValidationBlockedEntries } from './paperValidationBlockedEntries.js';
import { PaperValidationTelemetry } from './paperValidationTelemetry.js';
import { PaperValidationShadowBook } from './paperValidationShadowBook.js';
import { PaperValidationSession } from './paperValidationSession.js';
import { PaperValidationSnapshots } from './paperValidationSnapshots.js';
import {
  PaperValidationRiskGate,
  hydrateLossCircuitBreakerState,
  normalizeSignalWindowEntryCounts
} from './paperValidationRiskGate.js';
export { resolveSignalWindowEntryLimit } from './paperValidationRiskGate.js';
import {
  derivePositionExcursion,
  validTimestamp
} from './paperValidationUtils.js';

export class PaperValidationJournal {
  constructor(owner) {
    this.owner = owner;
    this.paperValidation = null;
    this.paperValidationFile = null;
    this.paperMinimumStorageMiB = 1024;
    this.runtimeSignalWindowEntryCounts = new Map();
  }

  _pvRisk() {
    if (!this.__pvRisk) this.__pvRisk = new PaperValidationRiskGate(this);
    return this.__pvRisk;
  }

  _pvShadow() {
    if (!this.__pvShadow) this.__pvShadow = new PaperValidationShadowBook(this);
    return this.__pvShadow;
  }

  _pvSession() {
    if (!this.__pvSession) this.__pvSession = new PaperValidationSession(this);
    return this.__pvSession;
  }

  _pvSnapshots() {
    if (!this.__pvSnapshots) this.__pvSnapshots = new PaperValidationSnapshots(this);
    return this.__pvSnapshots;
  }

  resolveShadowExitConfig(...args) { return this._pvShadow().resolveShadowExitConfig(...args); }
  updatePaperShadowPosition(...args) { return this._pvShadow().updatePaperShadowPosition(...args); }

  applyPaperStrategyRiskState(...args) { return this._pvRisk().applyPaperStrategyRiskState(...args); }
  restorePaperStrategyRiskState(...args) { return this._pvRisk().restorePaperStrategyRiskState(...args); }
  persistPaperStrategyRiskState(...args) { return this._pvRisk().persistPaperStrategyRiskState(...args); }
  getLossCircuitBreakerConfig(...args) { return this._pvRisk().getLossCircuitBreakerConfig(...args); }
  getStrictLossCircuitBreakerState(...args) { return this._pvRisk().getStrictLossCircuitBreakerState(...args); }
  getLossCircuitBreakerStatus(...args) { return this._pvRisk().getLossCircuitBreakerStatus(...args); }
  isStrictEntryBlockedByLossCircuit(...args) { return this._pvRisk().isStrictEntryBlockedByLossCircuit(...args); }
  getStrictSignalWindowEntryCounts(...args) { return this._pvRisk().getStrictSignalWindowEntryCounts(...args); }
  getStrictSignalWindowEntryCount(...args) { return this._pvRisk().getStrictSignalWindowEntryCount(...args); }
  isStrictEntryBlockedBySignalWindow(...args) { return this._pvRisk().isStrictEntryBlockedBySignalWindow(...args); }
  recordStrictSignalWindowEntry(...args) { return this._pvRisk().recordStrictSignalWindowEntry(...args); }
  getStrictSignalWindowStatus(...args) { return this._pvRisk().getStrictSignalWindowStatus(...args); }
  registerRuntimeLoss(...args) { return this._pvRisk().registerRuntimeLoss(...args); }

  startPaperValidationSession(...args) { return this._pvSession().startPaperValidationSession(...args); }
  stopPaperValidationSession(...args) { return this._pvSession().stopPaperValidationSession(...args); }
  recordPaperValidationSnapshot(...args) { return this._pvSession().recordPaperValidationSnapshot(...args); }

  getPaperValidationConfigSnapshot(...args) { return this._pvSnapshots().getPaperValidationConfigSnapshot(...args); }
  getPaperExperimentSnapshot(...args) { return this._pvSnapshots().getPaperExperimentSnapshot(...args); }
  comparePaperExperimentConfig(...args) { return this._pvSnapshots().comparePaperExperimentConfig(...args); }
  getExecutionBoundaryCounterfactualConfig(...args) { return this._pvSnapshots().getExecutionBoundaryCounterfactualConfig(...args); }
  comparePaperValidationConfig(...args) { return this._pvSnapshots().comparePaperValidationConfig(...args); }


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
