// 페이퍼 검증 쉐도우 북 — shadow/looseShadow/winnerShadow 진단 포지션의 오픈·종료 시뮬레이션.
// paperValidationJournal.js에서 추출; 저널 상태는 journal을 통해 접근한다.
import {
  calculateCostAdjustedBreakEvenPrice
} from '../strategy/protectionPrices.js';
import {
  createLossCircuitBreakerState,
  isLossCircuitCoolingDown,
  registerLoss
} from '../risk/lossCircuitBreaker.js';
import {
  updatePositionExcursion
} from './paperValidationUtils.js';

export class PaperValidationShadowBook {
  constructor(journal) {
    this.journal = journal;
  }

  resolveShadowExitConfig(stateKey, configOverride) {
    const derived = stateKey === 'winnerShadow'
      ? {
          winnerExtendMinutes: this.journal.owner.winnerShadowExtendMinutes,
          winnerExtendMinProfitPercent: this.journal.owner.winnerShadowExtendMinProfitPercent
        }
      : {};
    return {
      ...this.journal.owner.config,
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
    if (!this.journal.paperValidation?.active || !analysis?.coin) return result;

    const shadow = this.journal.paperValidation[stateKey] || {
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
      this.journal.paperValidation[stateKey] = shadow;
      return result;
    }

    const exitConfig = this.journal.owner.resolveShadowExitConfig(stateKey, configOverride);
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
            this.journal.owner.getLossCircuitBreakerConfig()
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
          this.journal.paperValidation[stateKey] = shadow;
          return result;
        }
        if ((Number(shadow.consecutiveLossesByCoin[coin]) || 0) >= maxConsecutiveLosses) {
          shadow.consecutiveLossesByCoin[coin] = 0;
          shadow.cooldownUntilByCoin[coin] = 0;
        }

        const activePositionCount = Object.keys(shadow.positions).length;
        const configuredMaxPositions = Number(this.journal.owner.maxPositions);
        const maxPositions = Number.isFinite(configuredMaxPositions)
          ? Math.max(0, configuredMaxPositions)
          : 3;
        if (activePositionCount < maxPositions) {
          if (isLossCircuitCoolingDown(
            shadow.lossCircuitBreaker,
            nowMs,
            this.journal.owner.getLossCircuitBreakerConfig()
          )) {
            result.blockedByLossCircuit = true;
            this.journal.paperValidation[stateKey] = shadow;
            return result;
          }
          const baselineAssets = Number(this.journal.paperValidation.baselineAssets) || this.journal.owner.initialSeedMoney;
          const investmentRatio = Number.isFinite(Number(this.journal.owner.investmentRatio))
            ? Number(this.journal.owner.investmentRatio)
            : 0.02;
          const investAmount = Math.min(baselineAssets * investmentRatio, baselineAssets * 0.95);
          const entryPrice = currentPrice * (1 + slippage);
          const buyFee = investAmount * tradingFee;
          const amount = (investAmount - buyFee) / entryPrice;
          if (investAmount >= this.journal.owner.MIN_ORDER_AMOUNT && amount > 0) {
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

    this.journal.paperValidation[stateKey] = shadow;
    return result;
  }
}
