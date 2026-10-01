// 실행 경계·위너 쉐도우 차단 엔트리 원장 — 차단 사유와 counterfactual 결산.
// paperValidationJournal.js에서 추출 — 저널 상태는 journal 필드를 통해 접근한다.
import { updatePositionExcursion, validTimestamp } from './paperValidationUtils.js';

export class PaperValidationBlockedEntries {
  constructor(journal) {
    this.journal = journal;
  }


  recordExecutionBoundaryBlockedEntry(analysis, stateKey, reason, timestamp = new Date().toISOString()) {
    if (!this.journal.owner.dryRun || !this.journal.paperValidation?.active || !['shadow', 'looseShadow'].includes(stateKey)) return false;
    const coin = analysis?.coin;
    const rebound = analysis?.decision?.details?.rebound;
    const signalKey = rebound?.signalKey ? String(rebound.signalKey) : '';
    const currentPrice = Number(analysis?.currentPrice);
    if (!coin || !signalKey || !Number.isFinite(currentPrice) || currentPrice <= 0) return false;

    const shadow = this.journal.paperValidation[stateKey] || {};
    shadow.executionBoundaryBlockedEntries = Array.isArray(shadow.executionBoundaryBlockedEntries)
      ? shadow.executionBoundaryBlockedEntries
      : [];
    const key = `${coin}:${signalKey}`;
    if (shadow.executionBoundaryBlockedEntries.some(entry => entry.key === key)) {
      this.journal.paperValidation[stateKey] = shadow;
      return false;
    }

    const counterfactualConfig = this.journal.owner.getExecutionBoundaryCounterfactualConfig();
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
        maxRetracePercent: Number(this.journal.owner.maxEntryRetracePercent) || 0.25,
        maxChasePercent: Number(this.journal.owner.config.maxEntryChasePercent) || 0.35
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
    this.journal.paperValidation[stateKey] = shadow;
    return true;
  }

  /**
   * Advance pending boundary counterfactuals using only later fresh prices.
   * Settled values stay outside shadow/loose realized P&L and promotion stats.
   */
  updateExecutionBoundaryBlockedEntries(analysis, stateKey, timestamp = new Date().toISOString()) {
    if (!this.journal.owner.dryRun || !this.journal.paperValidation?.active || !['shadow', 'looseShadow'].includes(stateKey)) return 0;
    const shadow = this.journal.paperValidation[stateKey];
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
    this.journal.paperValidation[stateKey] = shadow;
    return settledCount;
  }


  resolveExecutionBoundaryBlockedEntriesAtStop(timestamp = new Date().toISOString()) {
    if (!this.journal.paperValidation) return 0;
    let resolvedCount = 0;
    for (const stateKey of ['shadow', 'looseShadow']) {
      const shadow = this.journal.paperValidation[stateKey];
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
    if (!this.journal.owner.dryRun || !this.journal.paperValidation?.active || this.journal.owner.winnerShadowMaxReboundPercent <= 0) return;
    const coin = analysis?.coin;
    const rebound = analysis?.decision?.details?.rebound;
    const signalKey = rebound?.signalKey ? String(rebound.signalKey) : '';
    const currentPrice = Number(analysis?.currentPrice);
    if (!coin || !signalKey || !Number.isFinite(currentPrice) || currentPrice <= 0) return;

    const shadow = this.journal.paperValidation.winnerShadow || {};
    shadow.blockedEntries = Array.isArray(shadow.blockedEntries) ? shadow.blockedEntries : [];
    const key = `${coin}:${signalKey}`;
    if (shadow.blockedEntries.some(entry => entry.key === key)) {
      this.journal.paperValidation.winnerShadow = shadow;
      return;
    }
    const tradingFee = Number.isFinite(Number(this.journal.owner.config.tradingFee))
      ? Number(this.journal.owner.config.tradingFee)
      : 0.0005;
    const slippage = Number.isFinite(Number(this.journal.owner.config.slippage))
      ? Number(this.journal.owner.config.slippage)
      : 0.001;
    const baselineAssets = Number(this.journal.paperValidation.baselineAssets) || this.journal.owner.initialSeedMoney;
    const investmentRatio = Number.isFinite(Number(this.journal.owner.investmentRatio))
      ? Number(this.journal.owner.investmentRatio)
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
    this.journal.paperValidation.winnerShadow = shadow;
  }


  settleWinnerShadowBlockedEntries(coin, trade) {
    if (!this.journal.owner.dryRun || !this.journal.paperValidation?.active || !coin || !trade) return 0;
    const shadow = this.journal.paperValidation.winnerShadow;
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
    if (!this.journal.owner.dryRun || !this.journal.paperValidation?.active || !coin) return 0;
    const signalKey = decision?.entrySignalKey || decision?.details?.rebound?.signalKey;
    if (!signalKey) return 0;
    const shadow = this.journal.paperValidation.winnerShadow;
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
      this.journal.paperValidation.winnerShadow = shadow;
      this.journal.owner.savePaperValidation();
    }
    return resolvedCount;
  }
}
