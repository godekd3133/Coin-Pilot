// 페이퍼 검증 리스크 게이트 — 손실 회로차단기와 신호 윈도우 엔트리 제한.
// paperValidationJournal.js에서 추출; 저널 상태는 journal을 통해 접근한다.
import {
  createLossCircuitBreakerState,
  getLossCircuitBreakerStatus,
  isLossCircuitCoolingDown,
  registerLoss
} from '../risk/lossCircuitBreaker.js';
import { validTimestamp } from './paperValidationUtils.js';

export function hydrateLossCircuitBreakerState(existingState, historicalLossTimes, config) {
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

export function normalizeSignalWindowEntryCounts(existing) {
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

export function resolveLossCircuitBreakerConfig(config = {}) {
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

export class PaperValidationRiskGate {
  constructor(journal) {
    this.journal = journal;
  }



  applyPaperStrategyRiskState(coin, strategy) {
    if (!strategy || !this.journal.paperValidation?.strictRiskState) return;
    const riskState = this.journal.paperValidation.strictRiskState;
    const cooldownUntil = Number(riskState.cooldownUntilByCoin?.[coin]);
    const consecutiveLosses = Number(riskState.consecutiveLossesByCoin?.[coin]);
    if (Number.isFinite(cooldownUntil)) strategy.cooldownUntil = cooldownUntil;
    if (Number.isFinite(consecutiveLosses)) strategy.consecutiveLosses = consecutiveLosses;
  }



  restorePaperStrategyRiskState() {
    if (!this.journal.paperValidation?.strictRiskState) return;
    for (const [coin, strategy] of this.journal.owner.strategies.entries()) {
      this.journal.owner.applyPaperStrategyRiskState(coin, strategy);
    }
  }



  persistPaperStrategyRiskState(coin, strategy) {
    if (!this.journal.paperValidation || !strategy) return;
    const riskState = this.journal.paperValidation.strictRiskState || {
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
    this.journal.paperValidation.strictRiskState = riskState;
  }



  getLossCircuitBreakerConfig() {
    return resolveLossCircuitBreakerConfig(this.journal.owner.config);
  }



  getStrictLossCircuitBreakerState() {
    if (this.journal.owner.dryRun && this.journal.paperValidation) {
      const riskState = this.journal.paperValidation.strictRiskState || {
        cooldownUntilByCoin: {},
        consecutiveLossesByCoin: {},
        signalWindowEntryCountsByKey: {},
        lossCircuitBreaker: createLossCircuitBreakerState()
      };
      riskState.lossCircuitBreaker = riskState.lossCircuitBreaker || createLossCircuitBreakerState();
      this.journal.paperValidation.strictRiskState = riskState;
      return riskState.lossCircuitBreaker;
    }
    return this.journal.owner.lossCircuitBreaker;
  }



  getLossCircuitBreakerStatus(stateKey = 'strict') {
    let state;
    if (stateKey === 'strict') {
      state = this.journal.owner.getStrictLossCircuitBreakerState();
    } else {
      state = this.journal.paperValidation?.[stateKey]?.lossCircuitBreaker || null;
    }
    return getLossCircuitBreakerStatus(state, Date.now(), this.journal.owner.getLossCircuitBreakerConfig());
  }



  isStrictEntryBlockedByLossCircuit(now = Date.now()) {
    return isLossCircuitCoolingDown(
      this.journal.owner.getStrictLossCircuitBreakerState(),
      now,
      this.journal.owner.getLossCircuitBreakerConfig()
    );
  }



  getStrictSignalWindowEntryCounts() {
    if (this.journal.owner.dryRun && this.journal.paperValidation) {
      const riskState = this.journal.paperValidation.strictRiskState || {
        cooldownUntilByCoin: {},
        consecutiveLossesByCoin: {},
        signalWindowEntryCountsByKey: {},
        lossCircuitBreaker: createLossCircuitBreakerState()
      };
      riskState.signalWindowEntryCountsByKey = normalizeSignalWindowEntryCounts(
        riskState.signalWindowEntryCountsByKey
      );
      this.journal.paperValidation.strictRiskState = riskState;
      return riskState.signalWindowEntryCountsByKey;
    }

    if (!(this.journal.runtimeSignalWindowEntryCounts instanceof Map)) {
      this.journal.runtimeSignalWindowEntryCounts = new Map();
    }
    return Object.fromEntries(this.journal.runtimeSignalWindowEntryCounts.entries());
  }



  getStrictSignalWindowEntryCount(signalKey) {
    if (!signalKey) return 0;
    const counts = this.journal.owner.getStrictSignalWindowEntryCounts();
    return Number(counts[String(signalKey)]) || 0;
  }



  isStrictEntryBlockedBySignalWindow(signalKey) {
    const limit = resolveSignalWindowEntryLimit(this.journal.owner.config);
    return limit > 0 && Boolean(signalKey) &&
      this.journal.owner.getStrictSignalWindowEntryCount(signalKey) >= limit;
  }



  recordStrictSignalWindowEntry(signalKey) {
    const limit = resolveSignalWindowEntryLimit(this.journal.owner.config);
    if (limit <= 0 || !signalKey) return;

    const normalizedKey = String(signalKey);
    if (this.journal.owner.dryRun && this.journal.paperValidation) {
      const counts = this.journal.owner.getStrictSignalWindowEntryCounts();
      counts[normalizedKey] = (Number(counts[normalizedKey]) || 0) + 1;
      const trimmed = Object.entries(counts).slice(-2000);
      this.journal.paperValidation.strictRiskState.signalWindowEntryCountsByKey = Object.fromEntries(trimmed);
      if (this.journal.paperValidation.active) this.journal.owner.savePaperValidation();
      return;
    }

    const current = this.journal.runtimeSignalWindowEntryCounts.get(normalizedKey) || 0;
    this.journal.runtimeSignalWindowEntryCounts.set(normalizedKey, current + 1);
    while (this.journal.runtimeSignalWindowEntryCounts.size > 2000) {
      const oldestKey = this.journal.runtimeSignalWindowEntryCounts.keys().next().value;
      this.journal.runtimeSignalWindowEntryCounts.delete(oldestKey);
    }
  }



  getStrictSignalWindowStatus() {
    const maxEntriesPerSignalWindow = resolveSignalWindowEntryLimit(this.journal.owner.config);
    const entries = Object.entries(this.journal.owner.getStrictSignalWindowEntryCounts());
    const [lastSignalKey, lastEntryCount] = entries.at(-1) || [];
    return {
      enabled: maxEntriesPerSignalWindow > 0,
      maxEntriesPerSignalWindow,
      lastSignalKey: lastSignalKey || null,
      lastEntryCount: Number(lastEntryCount) || 0,
      blockedEntries: Number(this.journal.paperValidation?.telemetry?.signalWindowBlockedEntries) || 0
    };
  }



  registerRuntimeLoss(trade) {
    const profit = Number(trade?.profit);
    if (!trade || !Number.isFinite(profit) || profit >= 0) {
      return { triggered: false, lossCount: 0, cooldownUntil: 0 };
    }

    const state = this.journal.owner.getStrictLossCircuitBreakerState();
    const result = registerLoss(state, trade.exitTime || Date.now(), this.journal.owner.getLossCircuitBreakerConfig());
    if (result.triggered) {
      console.log(`\n🛑 전역 손실 회로차단기 발동: 최근 손실 ${result.lossCount}회 · ${this.journal.owner.getLossCircuitBreakerConfig().cooldownMinutes}분 신규 진입 차단`);
    }
    if (this.journal.owner.dryRun && this.journal.paperValidation) {
      this.journal.paperValidation.strictRiskState = this.journal.paperValidation.strictRiskState || {};
      this.journal.paperValidation.strictRiskState.lossCircuitBreaker = state;
    }
    return result;
  }
}
