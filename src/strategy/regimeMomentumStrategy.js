/**
 * Regime-gated momentum candidate — RESEARCH ONLY.
 *
 * Evidence basis (diagnostic, not promotion):
 * - Earlier 60-day windows suggested a positive result, but those windows were
 *   not sufficient evidence and are superseded by the contiguous ~400-day
 *   audit recorded in scorecard.md and context.md.
 * - On 12 liquid KRW markets after roughly 0.2% round-trip cost, the fixed
 *   72-hour forward contract returned about -10.80% (317 trades, PF 0.91),
 *   while the hold-while-7-day-trend regime variant returned about -12.24%
 *   (177 trades, MDD about 31.4%). Both reduced loss versus buy-and-hold in
 *   that bear-dominated window but failed to create positive absolute alpha.
 * - Entries correlate across markets during recoveries, so per-market trade
 *   counts overstate independent evidence; a portfolio exposure cap is a
 *   required risk constraint, not an optional filter.
 *
 * This class is deliberately self-contained: it consumes COMPLETED candles of
 * the configured unit (default 60 minutes) and exposes pure signal/exit
 * decisions. It is not wired into the live runner. Forward shadow use is
 * diagnostic only, and the current audit treats this family as a regime
 * defense overlay candidate rather than an alpha or promotion candidate.
 */
class RegimeMomentumStrategy {
  constructor(config = {}) {
    this.mode = 'regime_momentum';
    this.candleUnitMinutes = Math.max(1, Number(config.candleUnitMinutes) || 60);
    this.rsiPeriod = Math.max(2, Number(config.rsiPeriod) || 14);
    this.rsiEntryThreshold = Number.isFinite(Number(config.rsiEntryThreshold))
      ? Number(config.rsiEntryThreshold) : 65;
    this.trendLookbackHours = Math.max(1, Number(config.trendLookbackHours) || 168);
    this.requireUpBar = config.requireUpBar !== false;
    this.minUpBars = Math.max(1, Math.floor(Number(config.minUpBars) || 1));
    this.maxHoldHours = Math.max(1, Number(config.maxHoldHours) || 48);
    this.stopLossPercent = Math.max(0, Number(config.stopLossPercent) || 0);
    this.takeProfitPercent = Math.max(0, Number(config.takeProfitPercent) || 0);
    this.lastSignalKey = null;
  }

  /**
   * Minimum completed candles required before any signal can be evaluated.
   * The trailing-trend lookback dominates; +2 covers the RSI warm-up and the
   * previous-bar comparison.
   */
  getMinCandleCount() {
    const lookbackBars = Math.ceil((this.trendLookbackHours * 60) / this.candleUnitMinutes);
    return lookbackBars + this.rsiPeriod + 2;
  }

  /**
   * Wilder-style RSI over completed closes. Returns null until enough data.
   */
  static computeRsi(closes, index, period = 14) {
    if (index < period + 1) return null;
    let gain = 0;
    let loss = 0;
    for (let k = index - period + 1; k <= index; k++) {
      const d = closes[k] - closes[k - 1];
      if (d > 0) gain += d; else loss -= d;
    }
    if (loss === 0) return 100;
    return 100 - 100 / (1 + gain / loss);
  }

  /**
   * Evaluate the newest completed candle as a momentum entry candidate.
   * candles must be chronological completed candles of candleUnitMinutes.
   * Returns { signal: 'BUY', signalKey, rsi, trendPercent } or { signal: null, reason }.
   */
  analyze(candles, now = Date.now()) {
    if (!Array.isArray(candles) || candles.length < this.getMinCandleCount()) {
      return { signal: null, reason: 'insufficient_candles' };
    }
    const i = candles.length - 1;
    const closes = candles.map((c) => Number(c.trade_price ?? c.c ?? c.close));
    if (closes.some((v) => !Number.isFinite(v))) {
      return { signal: null, reason: 'invalid_candle_price' };
    }
    const lookbackBars = Math.ceil((this.trendLookbackHours * 60) / this.candleUnitMinutes);
    const rsi = RegimeMomentumStrategy.computeRsi(closes, i, this.rsiPeriod);
    if (rsi == null) return { signal: null, reason: 'rsi_unavailable' };
    const trendPercent = ((closes[i] - closes[i - lookbackBars]) / closes[i - lookbackBars]) * 100;

    if (rsi < this.rsiEntryThreshold) return { signal: null, reason: 'rsi_below_threshold', rsi, trendPercent };
    if (this.requireUpBar) {
      for (let offset = 0; offset < this.minUpBars; offset += 1) {
        const current = i - offset;
        if (current <= 0 || closes[current] <= closes[current - 1]) {
          return { signal: null, reason: 'bar_not_up', rsi, trendPercent };
        }
      }
    }
    if (trendPercent <= 0) return { signal: null, reason: 'trend_gate_blocked', rsi, trendPercent };

    const ts = candles[i].candle_date_time_utc || candles[i].ts || candles[i].timestamp;
    const signalKey = `${ts}`;
    if (signalKey === this.lastSignalKey) {
      return { signal: null, reason: 'duplicate_signal', rsi, trendPercent };
    }
    return { signal: 'BUY', signalKey, rsi, trendPercent, referencePrice: closes[i], evaluatedAt: now };
  }

  /**
   * Mark a signal key consumed after a confirmed entry so a repeated analysis
   * cycle on the same completed candle cannot double-fire.
   */
  consumeSignal(signalKey) {
    if (!signalKey || signalKey === this.lastSignalKey) return false;
    this.lastSignalKey = signalKey;
    return true;
  }

  /**
   * Exit check for an open momentum position.
   * position: { entryPrice, entryTimeMs }.
   * Returns { exit: 'STOP_LOSS'|'TAKE_PROFIT'|'MAX_HOLD'|null, profitPercent }.
   */
  checkPosition(position, currentPrice, now = Date.now()) {
    const profitPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
    if (this.stopLossPercent > 0 && profitPercent <= -this.stopLossPercent) {
      return { exit: 'STOP_LOSS', profitPercent };
    }
    if (this.takeProfitPercent > 0 && profitPercent >= this.takeProfitPercent) {
      return { exit: 'TAKE_PROFIT', profitPercent };
    }
    if (now - position.entryTimeMs >= this.maxHoldHours * 3600 * 1000) {
      return { exit: 'MAX_HOLD', profitPercent };
    }
    return { exit: null, profitPercent };
  }
}

export default RegimeMomentumStrategy;
