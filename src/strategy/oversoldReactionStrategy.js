import TradingStrategy from './tradingStrategy.js';
import { calculateCostAdjustedBreakEvenPrice } from './protectionPrices.js';

/**
 * 과매도 반응 스캘핑 전략
 *
 * 매수는 다음 순서를 모두 통과해야 한다.
 * 1. 완료된 직전 분봉이 RSI 과매도 상태였을 것
 * 2. 다음 완료 분봉이 양봉이고 직전 종가보다 높을 것
 * 3. RSI가 설정한 폭만큼 회복했을 것
 * 4. 주문 직전 재조회에서도 같은 신호가 유지될 것
 *
 * 주문 지연 자체는 MultiCoinTrader가 수행하고, 이 클래스는 신호의
 * 상태/식별자와 지연 범위를 제공한다. 따라서 전략 단위 테스트와
 * 거래소 주문 실행을 분리할 수 있다.
 */
class OversoldReactionStrategy extends TradingStrategy {
  constructor(config = {}) {
    const stopLossPercent = config.stopLossPercent ?? 1.2;
    const takeProfitPercent = config.takeProfitPercent ?? 1.8;

    super({
      ...config,
      technicalWeight: 1,
      newsWeight: 0,
      stopLossPercent,
      takeProfitPercent,
      buyOnly: false,
      allowAveraging: false
    });

    this.mode = 'oversold_reaction_scalping';
    this.entryDelayMinMs = config.entryDelayMinMs ?? 1000;
    this.entryDelayMaxMs = config.entryDelayMaxMs ?? 5000;
    this.maxEntryRetracePercent = config.maxEntryRetracePercent ?? 0.25;
    this.maxEntryChasePercent = config.maxEntryChasePercent ?? 0.35;
    this.maxHoldMs = (config.maxHoldMinutes ?? 30) * 60 * 1000;
    this.maxLosingHoldMs = Math.max(0, Number(config.maxLosingHoldMinutes) || 0) * 60 * 1000;
    // These protections are opt-in. With zero triggers the historical fixed
    // stop/take contract remains unchanged, so a new experiment cannot alter
    // an existing paper session silently.
    this.breakEvenTriggerPercent = Math.max(0, Number(config.breakEvenTriggerPercent) || 0);
    const breakEvenOffsetPercent = Number(config.breakEvenOffsetPercent);
    this.breakEvenOffsetPercent = Number.isFinite(breakEvenOffsetPercent) && breakEvenOffsetPercent >= 0
      ? breakEvenOffsetPercent
      : 0.05;
    this.trailingActivationPercent = Math.max(0, Number(config.trailingActivationPercent) || 0);
    this.trailingStopPercent = Math.max(0, Number(config.trailingStopPercent) || 0);
    this.tradingFee = Number.isFinite(Number(config.tradingFee)) ? Number(config.tradingFee) : 0.0005;
    this.slippage = Number.isFinite(Number(config.slippage)) ? Number(config.slippage) : 0.001;
    this.cooldownAfterLossMs = (config.cooldownAfterLossMinutes ?? 15) * 60 * 1000;
    this.maxConsecutiveLosses = config.maxConsecutiveLosses ?? 3;
    this.random = typeof config.random === 'function' ? config.random : Math.random;
    this.lastEntryAttemptKey = null;
    this.lastOversoldSignal = null;
    this.cooldownUntil = 0;
    this.consecutiveLosses = 0;
  }

  /**
   * 1~5초 범위의 진입 지연을 선택한다.
   * 테스트에서는 config.random을 주입해 결과를 결정적으로 만들 수 있다.
   */
  getEntryDelayMs() {
    const min = Math.min(this.entryDelayMinMs, this.entryDelayMaxMs);
    const max = Math.max(this.entryDelayMinMs, this.entryDelayMaxMs);
    if (min === max) return min;
    return Math.round(min + (max - min) * this.random());
  }

  /**
   * 신호가 같은 완료 캔들에서 반복 발행되지 않도록 식별자를 소비한다.
   */
  consumeSignal(signalKey) {
    if (!signalKey || this.lastEntryAttemptKey === signalKey) {
      return false;
    }
    this.lastEntryAttemptKey = signalKey;
    return true;
  }

  holdDecision(reason, rebound = null) {
    return {
      action: 'HOLD',
      reason,
      confidence: '0.00',
      signalStrength: { level: 'NONE', multiplier: 0, score: 0 },
      scores: {
        technical: rebound?.reboundConfirmed ? '50.00' : '0.00',
        news: '50.00',
        total: rebound?.reboundConfirmed ? '50.00' : '0.00'
      },
      details: { rebound }
    };
  }

  /**
   * 스캘핑 매매 결정. 뉴스/종합 점수는 사용하지 않고 반등 상태만 본다.
   */
  makeDecision(technicalAnalysis, _newsSentiment, currentPrice) {
    const rebound = technicalAnalysis?.indicators?.rebound;
    if (!rebound?.available) {
      return this.holdDecision('완료 캔들 부족 - 반등 확인 대기', rebound);
    }

    if (rebound.oversold) {
      this.lastOversoldSignal = {
        signalKey: rebound.signalKey,
        observedAt: Date.now(),
        rsi: rebound.oversoldRsi ?? rebound.rsi,
        price: rebound.oversoldReferenceClose ?? rebound.currentClose
      };
    }

    if (this.currentPosition) {
      const positionCheck = this.checkPosition(currentPrice);
      if (positionCheck.shouldClose) {
        return {
          action: 'SELL',
          reason: positionCheck.reason,
          confidence: '1.00',
          signalStrength: { level: 'STRONG', multiplier: 1, score: 100 },
          scores: { technical: '0.00', news: '50.00', total: '0.00' },
          details: { rebound, positionCheck }
        };
      }

      return this.holdDecision('포지션 보유 중 - 다음 반등 신호 대기', rebound);
    }

    if (Date.now() < this.cooldownUntil) {
      const remainingMinutes = Math.ceil((this.cooldownUntil - Date.now()) / 60000);
      return this.holdDecision(`직전 손실 후 쿨다운 중 (${remainingMinutes}분 남음)`, rebound);
    }

    if (this.consecutiveLosses >= this.maxConsecutiveLosses) {
      this.consecutiveLosses = 0;
      this.cooldownUntil = 0;
    }

    if (!rebound.reboundConfirmed) {
      if (rebound.oversold || rebound.signalProfile === 'momentum_breakout') {
        const reasonLabels = {
          bullish_rebound_not_confirmed: '양봉/고가 돌파 대기',
          price_rebound_below_threshold: '최소 반등률 미달',
          rsi_recovery_below_threshold: 'RSI 회복폭 미달',
          volume_confirmation_failed: '거래량 확인 실패',
          close_strength_failed: '종가 강도 부족',
          trend_filter_failed: '추세 필터 미통과',
          previous_high_break_failed: '직전 고가 돌파 대기',
          signal_range_too_wide: '신호 캔들 변동폭 과다',
          signal_range_too_narrow: '신호 캔들 변동폭 부족',
          bb_reclaim_profile_failed: '볼린저 재진입 대기',
          trend_rebound_profile_failed: '추세선 회복 대기',
          momentum_breakout_profile_failed: 'EMA/고가 돌파 조건 대기',
          breakout_move_below_threshold: '돌파 폭 미달',
          rsi_overbought_blocked: 'RSI 과열로 진입 차단'
        };
        const rejection = (rebound.rejectionReasons || [])
          .map(reason => reasonLabels[reason] || reason)
          .slice(0, 2)
          .join(', ');
        const prefix = rebound.signalProfile === 'momentum_breakout' ? '돌파 후보 확인' : '과매도 확인';
        return this.holdDecision(`${prefix} - ${rejection || '반등 확인 대기'}`, rebound);
      }
      return this.holdDecision(
        rebound.signalProfile === 'momentum_breakout' ? '돌파 조건 없음 - 관망' : '과매도 조건 없음 - 관망',
        rebound
      );
    }

    if (!this.consumeSignal(rebound.signalKey)) {
      return this.holdDecision('동일 완료 캔들 신호는 이미 처리됨', rebound);
    }

    const reboundScore = Math.min(
      100,
      50 + Math.max(0, rebound.reboundPriceChangePercent ?? rebound.priceChangePercent) * 100 + Math.max(0, rebound.rsiRecovery) * 5
    );

    const isMomentumBreakout = rebound.signalProfile === 'momentum_breakout';
    const priceMove = Number(rebound.reboundPriceChangePercent ?? rebound.priceChangePercent);
    const rsiDescription = isMomentumBreakout
      ? `RSI ${rebound.rsi.toFixed(2)}`
      : `RSI ${(rebound.oversoldRsi ?? rebound.previousRsi).toFixed(2)} → ${rebound.rsi.toFixed(2)}`;

    return {
      action: 'BUY',
      reason: isMomentumBreakout
        ? `추세 돌파 확인 (${rsiDescription}, 가격 +${priceMove.toFixed(2)}%, 직전 고가 돌파)`
        : `과매도 후 반등 확인 (${rsiDescription}, 가격 +${priceMove.toFixed(2)}%, ${rebound.oversoldCandleAge ?? 1}봉 경과)`,
      confidence: (reboundScore / 100).toFixed(2),
      signalStrength: {
        level: reboundScore >= 75 ? 'STRONG' : 'MEDIUM',
        // 스캘핑은 반등 강도에 따라 투자 배수를 키우지 않는다.
        multiplier: 1,
        score: reboundScore
      },
      scores: {
        technical: reboundScore.toFixed(2),
        news: '50.00',
        total: reboundScore.toFixed(2)
      },
      entryDelayMs: this.getEntryDelayMs(),
      entrySignalKey: rebound.signalKey,
      entryReferencePrice: rebound.referencePrice,
      details: { rebound }
    };
  }

  /**
   * 지연 후 주문 직전 재검증.
   * 같은 완료 캔들 신호가 유지되고, 현재가가 기준가에서 과도하게
   * 되밀리지 않았을 때만 주문을 허용한다.
   */
  validateEntry(technicalAnalysis, currentPrice, decision = {}) {
    const rebound = technicalAnalysis?.indicators?.rebound;
    if (!rebound?.available || !rebound.reboundConfirmed) {
      return { valid: false, reason: '지연 중 반등 확인 조건이 해제됨' };
    }

    if (decision.entrySignalKey && rebound.signalKey !== decision.entrySignalKey) {
      return { valid: false, reason: '새 완료 캔들로 신호가 변경됨' };
    }

    const referencePrice = Number(decision.entryReferencePrice ?? rebound.referencePrice);
    const latestPrice = Number(currentPrice);
    if (!Number.isFinite(referencePrice) || !Number.isFinite(latestPrice) || referencePrice <= 0) {
      return { valid: false, reason: '지연 후 가격 데이터가 유효하지 않음' };
    }

    const retracePercent = ((referencePrice - latestPrice) / referencePrice) * 100;
    if (retracePercent > this.maxEntryRetracePercent) {
      return {
        valid: false,
        reason: `반등 되밀림 ${retracePercent.toFixed(2)}% > 허용 ${this.maxEntryRetracePercent.toFixed(2)}%`
      };
    }

    const chasePercent = ((latestPrice - referencePrice) / referencePrice) * 100;
    if (chasePercent > this.maxEntryChasePercent) {
      return {
        valid: false,
        reason: `반등 추격 ${chasePercent.toFixed(2)}% > 허용 ${this.maxEntryChasePercent.toFixed(2)}%`
      };
    }

    return { valid: true, rebound, retracePercent, chasePercent };
  }

  checkPosition(currentPrice) {
    if (this.currentPosition && Number.isFinite(Number(currentPrice)) && Number(currentPrice) > 0) {
      const position = this.currentPosition;
      const latestPrice = Number(currentPrice);
      position.highestPrice = Math.max(Number(position.highestPrice) || position.entryPrice, latestPrice);
      const gainPercent = ((latestPrice - position.entryPrice) / position.entryPrice) * 100;

      if (this.breakEvenTriggerPercent > 0 && gainPercent >= this.breakEvenTriggerPercent) {
        position.breakEvenArmed = true;
      }
      if (this.trailingActivationPercent > 0 && this.trailingStopPercent > 0 &&
        gainPercent >= this.trailingActivationPercent) {
        position.trailingArmed = true;
      }

      const fixedStopPrice = position.entryPrice * (1 - this.config.stopLossPercent / 100);
      let protectiveStopPrice = fixedStopPrice;
      let protectiveType = 'STOP_LOSS';
      if (position.breakEvenArmed || position.trailingArmed) {
        const breakEvenStopPrice = calculateCostAdjustedBreakEvenPrice(position.entryPrice, {
          tradingFee: this.tradingFee,
          slippage: this.slippage,
          offsetPercent: this.breakEvenOffsetPercent
        });
        if (breakEvenStopPrice > protectiveStopPrice) {
          protectiveStopPrice = breakEvenStopPrice;
          protectiveType = 'BREAK_EVEN_STOP';
        }
      }
      if (position.trailingArmed) {
        const trailingStopPrice = position.highestPrice * (1 - this.trailingStopPercent / 100);
        if (trailingStopPrice > protectiveStopPrice) {
          protectiveStopPrice = trailingStopPrice;
          protectiveType = 'TRAILING_STOP';
        }
      }
      if (latestPrice <= protectiveStopPrice && protectiveStopPrice > fixedStopPrice) {
        return {
          shouldClose: true,
          reason: protectiveType === 'TRAILING_STOP'
            ? `트레일링 보호 출구 (${(((latestPrice - position.entryPrice) / position.entryPrice) * 100).toFixed(2)}%)`
            : `브레이크이븐 보호 출구 (${(((latestPrice - position.entryPrice) / position.entryPrice) * 100).toFixed(2)}%)`,
          type: protectiveType
        };
      }
    }

    const baseCheck = super.checkPosition(currentPrice);
    if (baseCheck.shouldClose) return baseCheck;

    if (this.currentPosition && this.maxLosingHoldMs > 0) {
      const entryTime = new Date(this.currentPosition.entryTime).getTime();
      const holdingLoss = Number(currentPrice) <= this.currentPosition.entryPrice;
      if (Number.isFinite(entryTime) && holdingLoss && Date.now() - entryTime >= this.maxLosingHoldMs) {
        return {
          shouldClose: true,
          reason: `손실 포지션 조기 청산 (${Math.round(this.maxLosingHoldMs / 60000)}분 초과)`,
          type: 'MAX_LOSING_HOLD_TIME'
        };
      }
    }

    if (this.currentPosition && this.maxHoldMs > 0) {
      const entryTime = new Date(this.currentPosition.entryTime).getTime();
      if (Number.isFinite(entryTime) && Date.now() - entryTime >= this.maxHoldMs) {
        return {
          shouldClose: true,
          reason: `스캘핑 최대 보유시간 초과 (${Math.round(this.maxHoldMs / 60000)}분)`,
          type: 'MAX_HOLD_TIME'
        };
      }
    }

    return { shouldClose: false };
  }

  closePosition(price, reason, options = {}) {
    const closed = super.closePosition(price, reason, options);
    if (!closed) return closed;

    if (closed.profit < 0) {
      this.consecutiveLosses += 1;
      const cooldownMs = this.consecutiveLosses >= this.maxConsecutiveLosses
        ? Math.max(this.cooldownAfterLossMs, 60 * 60 * 1000)
        : this.cooldownAfterLossMs;
      this.cooldownUntil = Date.now() + cooldownMs;
    } else {
      this.consecutiveLosses = 0;
      this.cooldownUntil = 0;
    }

    return closed;
  }

  openPosition(price, amount, type = 'BUY') {
    super.openPosition(price, amount, type);
    if (!this.currentPosition) return;
    this.currentPosition.highestPrice = Number(price);
    this.currentPosition.breakEvenArmed = false;
    this.currentPosition.trailingArmed = false;
  }
}

export default OversoldReactionStrategy;
