import fs from 'node:fs';
import { writeDurableJson, appendDurableJsonLine } from './durableJson.js';

export class AutomationTrackingStore {
  constructor(trader, file) {
    this.trader = trader;
    this.file = file;
    this.mode = trader.dryRun ? 'DRY_RUN' : 'LIVE';
    this.error = null;
    this.state = { version: 1, mode: this.mode, events: [], latest: null };
    if (file && fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.version !== 1 || saved.mode !== this.mode || !Array.isArray(saved.events)) {
        throw new Error('자동매매 추적 기록의 형식 또는 계좌 모드가 다릅니다.');
      }
      this.state = saved;
      const journal = `${file}.events.jsonl`;
      if (!fs.existsSync(journal)) {
        for (const event of saved.events) appendDurableJsonLine(journal, { ...event, mode: this.mode, recoveredFromCheckpoint: true });
      }
      // Live holdings and quote freshness must always reconcile afresh. Only
      // historical risk counters are restored, never an executable order/cursor.
      if (saved.latest?.strategyRisk) {
        for (const [market, risk] of Object.entries(saved.latest.strategyRisk)) {
          const strategy = trader.getStrategy?.(market);
          if (!strategy) continue;
          if (Number.isFinite(risk.cooldownUntil)) strategy.cooldownUntil = Math.max(0, risk.cooldownUntil);
          if (Number.isInteger(risk.consecutiveLosses)) strategy.consecutiveLosses = Math.max(0, risk.consecutiveLosses);
          if (Array.isArray(risk.tradeHistory)) strategy.tradeHistory = risk.tradeHistory;
          trader.persistPaperStrategyRiskState?.(market, strategy);
        }
        if (saved.latest.lossCircuitBreaker) {
          trader.lossCircuitBreaker = saved.latest.lossCircuitBreaker;
          if (trader.dryRun && trader.paperValidation) {
            trader.paperValidation.strictRiskState ||= {};
            trader.paperValidation.strictRiskState.lossCircuitBreaker = saved.latest.lossCircuitBreaker;
          }
        }
        if (saved.latest.signalWindowEntryCounts) {
          if (trader.dryRun && trader.paperValidation) {
            trader.paperValidation.strictRiskState ||= {};
            trader.paperValidation.strictRiskState.signalWindowEntryCountsByKey = saved.latest.signalWindowEntryCounts;
          } else trader.runtimeSignalWindowEntryCounts = new Map(Object.entries(saved.latest.signalWindowEntryCounts));
        }
      }
    }
  }

  record(type, details = {}) {
    if (!this.file) return;
    const trader = this.trader;
    const strategyRisk = {};
    for (const [market, strategy] of trader.strategies || []) {
      strategyRisk[market] = {
        cooldownUntil: strategy.cooldownUntil || 0,
        consecutiveLosses: strategy.consecutiveLosses || 0,
        tradeHistory: strategy.tradeHistory || []
      };
    }
    const observedAt = new Date().toISOString();
    const safety = trader.getRuntimeSafetyStatus?.() || {};
    // Avoid recursively persisting supervisor status / arbitrary credential data.
    const next = {
      ...this.state,
      events: [...this.state.events, { type, details, observedAt }].slice(-1000),
      latest: {
        observedAt, mode: this.mode, isRunning: trader.isRunning === true,
        runtimeState: safety.runtimeState || null, stopReason: trader.stopReason || null,
        lastCycleAt: trader.paperValidation?.telemetry?.lastCycleAt || trader.lastCycleAt || null,
        targetCoins: [...(trader.targetCoins || [])],
        positionCount: trader.getCurrentPositionCount?.() || 0,
        analysis: trader.getAnalysisDataHealthStatus?.() || null,
        risk: trader.getRiskMonitorStatus?.() || null,
        strategyRisk,
        signalWindowEntryCounts: trader.getStrictSignalWindowEntryCounts?.() || Object.fromEntries(trader.runtimeSignalWindowEntryCounts || []),
        lossCircuitBreaker: trader.getStrictLossCircuitBreakerState?.() || trader.lossCircuitBreaker || null
      }
    };
    try {
      appendDurableJsonLine(`${this.file}.events.jsonl`, {
        ...next.events.at(-1), mode: this.mode,
        runtimeState: next.latest.runtimeState, isRunning: next.latest.isRunning,
        positionCount: next.latest.positionCount
      });
      writeDurableJson(this.file, next);
      this.state = next;
      this.error = null;
    } catch (error) { this.error = error.message; throw error; }
  }

  summary() {
    return { available: Boolean(this.file), savedAt: this.state.latest?.observedAt || null,
      eventCount: this.state.events.length, error: this.error };
  }
}
