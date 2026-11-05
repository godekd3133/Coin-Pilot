// EngineActivityTracker — "is the engine alive, and why no trades?" for the home screen.
//
// Fed the same read-only analysis cycle the AI monitor gets. It keeps the last
// cycle time and, for the past hour, unique BUY signals (one per market per
// minute, so 5-second cycles are not counted as separate signals).
const HOUR_MS = 60 * 60 * 1000;

export class EngineActivityTracker {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.lastCycleAt = null;
    this.lastCycleMarkets = 0;
    this.lastCycleInactive = 0;
    this.signals = new Map();
  }

  ingestCycle(cycle) {
    const at = Date.parse(cycle?.timestamp) || this.now();
    const analyses = Array.isArray(cycle?.analyses) ? cycle.analyses : [];
    this.lastCycleAt = at;
    this.lastCycleMarkets = analyses.length;
    this.lastCycleInactive = analyses.filter(analysis => analysis?.inactiveMarket).length;
    const minute = Math.floor(at / 60000);
    for (const analysis of analyses) {
      if (analysis?.decision?.action !== 'BUY' || !analysis.coin) continue;
      const key = `${analysis.coin}|${minute}`;
      if (!this.signals.has(key)) this.signals.set(key, { coin: analysis.coin, at });
    }
    this.prune(at);
  }

  prune(nowMs = this.now()) {
    for (const [key, signal] of this.signals) {
      if (nowMs - signal.at > HOUR_MS) this.signals.delete(key);
    }
  }

  /** Entries opened in the past hour, read from strategy trade history. */
  static entriesSince(tradingSystem, sinceMs) {
    let entries = 0;
    for (const strategy of tradingSystem?.strategies?.values?.() || []) {
      for (const trade of strategy.tradeHistory || []) {
        if (trade.action === 'OPEN' && Date.parse(trade.entryTime) >= sinceMs) entries++;
      }
    }
    return entries;
  }

  getStatus(tradingSystem) {
    const nowMs = this.now();
    this.prune(nowMs);
    const lastSync = Number(tradingSystem?._lastSyncTime);
    return {
      lastCycleAt: this.lastCycleAt ? new Date(this.lastCycleAt).toISOString() : null,
      lastCycleMarkets: this.lastCycleMarkets,
      lastCycleInactive: this.lastCycleInactive,
      signalsLastHour: this.signals.size,
      entriesLastHour: EngineActivityTracker.entriesSince(tradingSystem, nowMs - HOUR_MS),
      lastExchangeSyncAt: tradingSystem?.dryRun === false && Number.isFinite(lastSync) && lastSync > 0
        ? new Date(lastSync).toISOString()
        : null
    };
  }
}

export default EngineActivityTracker;
