// OrderExecutionEngine — 스캘핑 엔트리 확인과 주문 실행 파이프라인.
//
// MultiCoinTrader에서 추출. 소유 범위:
// - confirmScalpingEntry 지연 재검증(1~5초, 신선도/신호 유지/추격 한도)
// - executeOrder/_executeOrder의 DRY_RUN 가상 체결과 LIVE 게이트웨이 디스패치
// - LIVE 주문 가능 여부 판정(canExecuteLiveOrder)
//
// 상태는 전부 owner(트레이더)를 통해 조회한다 — 순수 오케스트레이션.
import { inspectLatestCandleFreshness } from '../risk/candleFreshness.js';
import { inspectTraderMarketQuote } from './positionRiskMonitor.js';

export function hasCompleteLiveFillResult(fillResult) {
  const order = fillResult?.order;
  const hasObservedNumber = value => value !== null && value !== undefined && Number.isFinite(Number(value));
  return fillResult?.filled === true &&
    order &&
    hasObservedNumber(order.executed_volume) && Number(order.executed_volume) > 0 &&
    hasObservedNumber(order.avg_price) && Number(order.avg_price) > 0 &&
    hasObservedNumber(order.paid_fee) && Number(order.paid_fee) >= 0 &&
    hasObservedNumber(order.remaining_volume) && Number(order.remaining_volume) >= 0;
}

export class OrderExecutionEngine {
  constructor(owner) {
    this.owner = owner;
  }

  /**
   * 반등 후보를 주문 직전에 다시 확인한다.
   * 지연 동안 가격/캔들이 바뀌면 기존 분석 결과를 재사용하지 않는다.
   */
  async confirmScalpingEntry(coin, decision, strategy, marketData = null) {
    const requestedDelay = Number(decision.entryDelayMs);
    const minDelay = Math.max(1000, Number(this.owner.entryDelayMinMs) || 1000);
    const maxDelay = Math.max(minDelay, Number(this.owner.entryDelayMaxMs) || 5000);
    const skipDelay = marketData?.skipConfirmationDelay === true;
    const delayMs = skipDelay
      ? 0
      : Math.min(maxDelay, Math.max(minDelay, Number.isFinite(requestedDelay)
        ? requestedDelay
        : strategy.getEntryDelayMs()));

    this.owner.recordPaperEntryConfirmation(coin, 'attempt', 'pending');
    console.log(`\n⏳ [${coin}] 반등 확인 완료 - ${delayMs}ms 후 주문 재검증`);
    if (!skipDelay) await this.owner.sleep(delayMs);

    if (this.owner._stopRequested || this.owner._entriesPaused) {
      this.owner.recordPaperEntryConfirmation(coin, 'cancelled', 'stop_requested');
      this.owner.resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, 'stop_requested');
      console.log(`  ⛔ [${coin}] 중지 요청으로 진입 취소`);
      return null;
    }

    let ticker;
    let candles;
    try {
      if (marketData?.sharedSnapshot === true) {
        ticker = marketData.ticker ? [marketData.ticker] : null;
        candles = marketData.candles;
      } else {
        [ticker, candles] = await Promise.all([
          this.owner.marketDataAdapter.getTickers(coin),
          this.owner.marketDataAdapter.getMinuteCandles(coin, this.owner.candleUnit, this.owner.candleCount)
        ]);
      }
    } catch (error) {
      this.owner.recordPaperEntryConfirmation(coin, 'cancelled', 'revalidation_request_failed');
      this.owner.resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, 'revalidation_request_failed');
      console.log(`  ⚠️  [${coin}] 지연 후 재검증 조회 실패: ${error.message}`);
      return null;
    }

    const latestTicker = ticker?.[0];
    const latestPrice = latestTicker?.trade_price;
    if (!Number.isFinite(latestPrice) || !Array.isArray(candles)) {
      this.owner.recordPaperEntryConfirmation(coin, 'cancelled', 'invalid_revalidation_payload');
      this.owner.resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, 'invalid_revalidation_payload');
      console.log(`  ⚠️  [${coin}] 지연 후 가격/캔들 데이터가 유효하지 않아 진입 취소`);
      return null;
    }

    const marketQuoteFreshness = inspectTraderMarketQuote(
      latestTicker,
      coin,
      this.owner.maxCandleAgeSeconds
    );
    if (!marketQuoteFreshness.fresh) {
      this.owner.recordPaperEntryConfirmation(coin, 'cancelled', marketQuoteFreshness.reason);
      this.owner.resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, marketQuoteFreshness.reason);
      console.log(`  ⛔ [${coin}] 지연 후 거래소 시세 신선도 실패: ${marketQuoteFreshness.reason}`);
      return null;
    }

    const candleFreshness = inspectLatestCandleFreshness(candles, {
      candleUnit: this.owner.candleUnit,
      maxAgeSeconds: this.owner.maxCandleAgeSeconds
    });
    this.owner.recordPaperCandleFreshnessObservation(coin, candleFreshness);
    if (!candleFreshness.valid) {
      this.owner.recordPaperCandleFreshnessBlock(candleFreshness.reason, candleFreshness, 'entry_confirmation', coin);
      this.owner.recordPaperEntryConfirmation(coin, 'cancelled', candleFreshness.reason);
      this.owner.resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, candleFreshness.reason);
      console.log(`  ⛔ [${coin}] 지연 후 캔들 신선도 실패: ${candleFreshness.reason}`);
      return null;
    }

    const technicalAnalysis = this.owner.buildTechnicalAnalysis(candles);
    const validation = strategy.validateEntry(technicalAnalysis, latestPrice, decision);
    if (!validation.valid) {
      const reason = validation.reason || 'entry_validation_invalid';
      this.owner.recordPaperEntryConfirmation(coin, 'cancelled', reason);
      this.owner.resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, reason);
      console.log(`  ⛔ [${coin}] 지연 후 반등 무효화: ${validation.reason}`);
      return null;
    }

    this.owner.recordPaperEntryConfirmation(coin, 'confirmed', 'entry_revalidation_passed');
    console.log(`  ✅ [${coin}] 지연 후 반등 유지 - 현재가 ${latestPrice.toLocaleString()}원`);
    return {
      currentPrice: latestPrice,
      technicalAnalysis,
      delayMs,
      candleFreshness,
      marketQuoteFreshness
    };
  }

  /**
   * 주문 실행
   * @param {string} coin - 코인
   * @param {Object} decision - 매매 결정
   * @param {number} currentPrice - 현재가
   * @param {number} krwBalance - KRW 잔액
   * @param {number} coinBalance - 코인 잔액
   * @param {number} currentPositions - 현재 포지션 수
   * @param {Array} coinAnalyses - 전체 코인 분석 결과 (리밸런싱용)
   */
  async executeOrder(...args) {
    const execute = async () => {
      if (this.owner._orderInProgress) return null;
      this.owner._orderInProgress = true;
      try {
        return await this.owner._executeOrder(...args);
      } finally {
        this.owner._orderInProgress = false;
      }
    };
    return this.owner.dryRun ? this.owner.withPortfolioMutationLock(execute) : execute();
  }

  canExecuteLiveOrder(coin, decision) {
    if (this.owner.dryRun) return true;
    if (!this.owner._liveAccountStateKnown) return false;
    if (this.owner._liveEvidenceBlockedMarkets.has(coin)) return false;
    if (this.owner._liveOrderStateUnknownMarkets.has(coin) || this.owner._livePendingOrderMarkets.has(coin)) return false;

    const riskMonitorExit = (this.owner._riskMonitorProtectiveOnly || this.owner._manualRiskProtection) &&
      this.owner._riskMonitorExitInProgress &&
      decision?.action === 'SELL';
    const verifiedAt = Number(this.owner._liveVerifiedOrderMarkets.get(coin));
    if (!riskMonitorExit && (!Number.isFinite(verifiedAt) || Date.now() - verifiedAt >= 10 * 60 * 1000)) {
      return false;
    }
    return this.owner._liveExchangeStateKnown || (riskMonitorExit && !this.owner._exchangeSyncPromise);
  }

  async _executeOrder(
    coin,
    decision,
    currentPrice,
    krwBalance,
    coinBalance,
    currentPositions,
    coinAnalyses = [],
    executionContext = null
  ) {
    if (this.owner._stopRequested) return null;
    if (!this.owner.canExecuteLiveOrder(coin, decision)) return null;
    if (this.owner._entriesPaused && !(
      (this.owner._riskMonitorProtectiveOnly || this.owner._manualRiskProtection) &&
      this.owner._riskMonitorExitInProgress &&
      decision?.action === 'SELL'
    )) return null;
    if (!this.owner.dryRun && (this.owner.liveExecutionEvidenceWriteError || this.owner.liveExecutionEvidenceDataError)) {
      const reason = this.owner.liveExecutionEvidenceWriteError || this.owner.liveExecutionEvidenceDataError;
      console.error(`🛑 live execution evidence가 불완전해 신규 주문을 차단합니다: ${reason}`);
      return null;
    }
    const strategy = this.owner.getStrategy(coin);

    if (decision.action === 'HOLD') {
      return;
    }

    if (decision.action === 'BUY') {
      const signalStrength = decision.signalStrength || { level: 'WEAK', multiplier: 1 };
      const isStrongSignal = ['STRONG', 'VERY_STRONG'].includes(signalStrength.level);
      let entryDelayMs = null;

      // 이미 포지션이 있는 경우
      if (strategy.currentPosition) {
        if (!this.owner.allowAveraging) {
          this.owner.resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, 'strict_position_already_open');
          console.log(`\n⚠️  [${coin}] 이미 포지션 보유중 (추가 매수 비활성화)`);
          return;
        }
        // 추가 매수는 STRONG 이상 신호에서만 허용
        if (!isStrongSignal) {
          this.owner.resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, 'averaging_signal_not_strong');
          console.log(`\n⚠️  [${coin}] 포지션 보유중 - 추가 매수는 STRONG 이상 신호 필요 (현재: ${signalStrength.level})`);
          return;
        }
        console.log(`\n📈 [${coin}] 포지션 보유중 - 강한 신호로 추가 매수 진행`);
      }

      if (!strategy.currentPosition && currentPositions >= this.owner.maxPositions) {
        this.owner.resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, 'max_positions_reached');
        console.log(`\n⚠️  [${coin}] 최대 포지션 수(${this.owner.maxPositions}개)에 도달하여 진입하지 않음`);
        return;
      }

      if (!strategy.currentPosition && this.owner.isStrictEntryBlockedByLossCircuit()) {
        const circuit = this.owner.getLossCircuitBreakerStatus('strict');
        const remainingMinutes = Math.ceil((circuit.cooldownRemainingMs || 0) / 60000);
        this.owner.recordPaperCircuitBlock();
        this.owner.resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, 'loss_circuit_breaker');
        console.log(`\n🛑 [${coin}] 전역 손실 회로차단기 쿨다운 중 - 신규 진입 차단 (${remainingMinutes}분 남음)`);
        return;
      }

      const entrySignalKey = decision.entrySignalKey || decision.details?.rebound?.signalKey;
      if (!strategy.currentPosition && this.owner.isScalpingMode &&
        this.owner.isStrictEntryBlockedBySignalWindow(entrySignalKey)) {
        const signalWindow = this.owner.getStrictSignalWindowStatus();
        this.owner.recordPaperSignalWindowBlock();
        this.owner.resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, 'signal_window_limit');
        console.log(`\n🧭 [${coin}] 동일 signal window 동시 진입 상한 도달 - 신규 진입 차단 (${signalWindow.lastEntryCount}/${signalWindow.maxEntriesPerSignalWindow})`);
        return;
      }

      if (this.owner.isScalpingMode && this.owner.config.marketRegimeEnabled === true &&
        decision.details?.marketRegime?.confirmed !== true) {
        this.owner.recordPaperMarketRegimeBlock();
        this.owner.resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, 'market_regime_blocked');
        const regime = decision.details?.marketRegime;
        console.log(`\n⛔ [${coin}] 시장 regime gate 미통과 - breadth ${Number(regime?.breadth || 0).toFixed(2)} / 평균 ${Number(regime?.averageReturnPercent || 0).toFixed(2)}%`);
        return;
      }

      // 스캘핑 매수는 신호 발생 시점의 가격을 사용하지 않고,
      // 1~5초 지연 후 ticker/완료 캔들을 다시 확인한 뒤 진행한다.
      if (this.owner.isScalpingMode) {
        const snapshotMarketData = executionContext?.marketDataByCoin instanceof Map
          ? executionContext.marketDataByCoin.get(coin)
          : executionContext?.marketDataByCoin?.[coin];
        const confirmation = await this.owner.confirmScalpingEntry(
          coin,
          decision,
          strategy,
          snapshotMarketData
            ? {
                ...snapshotMarketData,
                sharedSnapshot: executionContext.sharedSnapshot === true,
                skipConfirmationDelay: executionContext.skipConfirmationDelay === true
              }
            : null
        );
        if (!confirmation) return;

        // 지연 중 수동 주문/다른 경로에서 포지션이 먼저 생겼다면
        // 스캘핑 모드에서는 추가 매수하지 않는다.
        if (strategy.currentPosition && !this.owner.allowAveraging) {
          this.owner.resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, 'position_created_during_confirmation');
          console.log(`  ⛔ [${coin}] 지연 중 포지션이 생성되어 중복 진입 취소`);
          return;
        }

        currentPrice = confirmation.currentPrice;
        entryDelayMs = confirmation.delayMs;
        const latestAccounts = await this.owner.getAccountInfo();
        krwBalance = this.owner.getKRWBalance(latestAccounts);
        currentPositions = this.owner.getCurrentPositionCount();
        if (!strategy.currentPosition && currentPositions >= this.owner.maxPositions) {
          this.owner.resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, 'max_positions_reached_after_confirmation');
          console.log(`  ⛔ [${coin}] 지연 중 최대 포지션 수(${this.owner.maxPositions}개)에 도달하여 진입 취소`);
          return;
        }
      }

      // 동적 투자금액 계산 (시드머니 + 신호 강도 기반)
      const totalAssets = await this.owner.calculateTotalAssets(executionContext?.priceMap);
      const dynamicInvestment = await this.owner.calculateDynamicInvestmentAmount(totalAssets, signalStrength);

      // 잔액 부족 시 강한 신호면 추가 리밸런싱
      if (!this.owner.isScalpingMode && krwBalance < dynamicInvestment && isStrongSignal && currentPositions > 0) {
        console.log(`\n💡 [${coin}] 잔액 부족하지만 강한 신호 - 추가 리밸런싱 검토`);

        const weakestPosition = this.owner.findWeakestPosition(coin, coinAnalyses);
        if (weakestPosition) {
          const soldAmount = await this.owner.sellForRebalancing(weakestPosition, coin);
          if (soldAmount > 0) {
            krwBalance = this.owner.dryRun ? this.owner.virtualPortfolio.krwBalance : soldAmount;
          }
        }
      }

      const maxInvestment = krwBalance * this.owner.portfolioAllocation;
      const investmentAmount = Math.min(
        dynamicInvestment,
        maxInvestment,
        krwBalance * 0.95
      );

      // A LIVE data-gap transition may happen during an awaited confirmation
      // or investment calculation. Recheck immediately before any BUY dispatch.
      if (this.owner._entriesPaused || this.owner._stopRequested) {
        this.owner.resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, 'entries_paused');
        return null;
      }

      const baseInvestment = totalAssets * this.owner.investmentRatio;
      console.log(`  💰 투자금액: ${investmentAmount.toLocaleString()}원`);
      console.log(`     (기본 ${baseInvestment.toLocaleString()}원 × ${signalStrength.multiplier} = ${dynamicInvestment.toLocaleString()}원)`);

      if (investmentAmount < 5000) {
        this.owner.resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, 'investment_below_minimum');
        console.log(`\n⚠️  [${coin}] 매수 불가: 잔액 부족 (${krwBalance.toLocaleString()}원)`);
        return;
      }

      // A sealed paper session applies its configured adverse fill-cost model.
      const paperEntryCostModel = this.owner.getStrictPaperExecutionCostModel();
      const FEE_RATE = paperEntryCostModel?.tradingFeeRate ?? 0.0005;
      const fee = investmentAmount * FEE_RATE;
      const actualInvestment = investmentAmount - fee;
      const entryFillPrice = currentPrice * (1 + (paperEntryCostModel?.slippageRate || 0));
      const volume = actualInvestment / entryFillPrice;

      if (this.owner.dryRun) {
        console.log(`\n🧪 [모의투자] ${coin} 매수 주문`);
        console.log(`  금액: ${investmentAmount.toLocaleString()} 원`);
        console.log(`  수수료: ${fee.toLocaleString()} 원 (${(FEE_RATE * 100).toFixed(2)}%)`);
        console.log(`  실투자: ${actualInvestment.toLocaleString()} 원`);
        console.log(`  수량: ${volume.toFixed(8)}`);
        console.log(`  가격: ${entryFillPrice.toLocaleString()} 원`);

        // 가상 포트폴리오 업데이트 - 마이너스 방지 체크
        const currentBalance = this.owner.virtualPortfolio.krwBalance || 0;
        if (currentBalance < investmentAmount) {
          this.owner.resolveWinnerShadowBlockedEntryAsNotFilled(coin, decision, 'balance_insufficient');
          console.log(`\n⚠️  [${coin}] 매수 취소: 실시간 잔액 부족 (${currentBalance.toLocaleString()}원 < ${investmentAmount.toLocaleString()}원)`);
          return;
        }
        this.owner.virtualPortfolio.krwBalance = Math.max(0, currentBalance - investmentAmount);
        const existing = this.owner.virtualPortfolio.holdings.get(coin) || { amount: 0, avgPrice: 0, entryTime: null };
        const newAmount = existing.amount + volume;
        const newAvgPrice = ((existing.amount * existing.avgPrice) + (volume * entryFillPrice)) / newAmount;
        this.owner.virtualPortfolio.holdings.set(coin, {
          amount: newAmount,
          avgPrice: newAvgPrice,
          entryTime: existing.entryTime || new Date().toISOString() // 최초 매수 시간 유지
        });

        strategy.openPosition(entryFillPrice, volume, 'BUY');
        if (paperEntryCostModel && strategy.currentPosition) {
          strategy.currentPosition.paperExecutionCostModel = paperEntryCostModel.version;
          strategy.currentPosition.paperExecutionSlippageRate = paperEntryCostModel.slippageRate;
          strategy.currentPosition.paperExecutionTradingFeeRate = paperEntryCostModel.tradingFeeRate;
          strategy.currentPosition.paperObservedEntryPrice = currentPrice;
          strategy.currentPosition.paperEntryFee = fee;
          strategy.currentPosition.paperInvestmentAmount = investmentAmount;
        }
        this.owner.decorateEntryPosition(strategy, decision, {
          executionPrice: currentPrice,
          delayMs: entryDelayMs
        });
        this.owner.recordStrictSignalWindowEntry(decision.entrySignalKey || decision.details?.rebound?.signalKey);
        this.owner.saveVirtualPortfolio();
        console.log(`  잔여 KRW: ${this.owner.virtualPortfolio.krwBalance.toLocaleString()} 원`);

        // 매수 알림
        this.owner.notifyTrade({
          type: 'BUY',
          coin,
          price: entryFillPrice,
          amount: investmentAmount,
          volume,
          reason: decision.reason,
          signalStrength: signalStrength.level,
          mode: 'DRY_RUN'
        });
      } else {
        console.log(`\n💵 [${coin}] 실제 매수 주문 실행`);
        console.log(`  예상 가격: ${currentPrice.toLocaleString()} 원`);
        console.log(`  투자 금액: ${investmentAmount.toLocaleString()} 원`);

        const orderResult = await this.owner.submitLiveOrder(coin, 'bid', investmentAmount, null, 'price');
        const orderId = orderResult?.data?.uuid || null;
        const submissionEvidenceRecorded = this.owner.recordLiveExecutionEvidence(this.owner.createLiveExecutionEvidence({
          eventType: orderResult?.success === true ? 'ORDER_SUBMITTED' : 'ORDER_REJECTED',
          orderId,
          market: coin,
          side: 'bid',
          orderType: 'price',
          requested: { amount: investmentAmount },
          referencePrice: currentPrice,
          signal: {
            signalKey: decision.entrySignalKey || decision.details?.rebound?.signalKey,
            signalTime: decision.details?.rebound?.candleTime,
            referencePrice: decision.entryReferencePrice ?? decision.details?.rebound?.referencePrice,
            entryDelayMs
          },
          error: orderResult?.success === true ? null : orderResult?.error?.message
        }));

        if (orderResult?.success === true && orderId) {
          console.log(`  📝 주문 접수: ${orderId}`);

          // 주문 체결 대기 (최대 30초)
          console.log(`  ⏳ 체결 대기 중...`);
          const fillResult = await this.owner.waitForLiveOrderFill(coin, orderId, 30000, 1000);

          if (fillResult.filled) {
            const filledOrder = fillResult.order;
            const fillEvidenceRecorded = this.owner.recordLiveExecutionEvidence(this.owner.createLiveExecutionEvidence({
              eventType: fillResult.partial ? 'FILL_PARTIAL' : 'FILL_OBSERVED',
              orderId,
              market: coin,
              side: 'bid',
              orderType: 'price',
              requested: { amount: investmentAmount },
              referencePrice: currentPrice,
              signal: {
                signalKey: decision.entrySignalKey || decision.details?.rebound?.signalKey,
                signalTime: decision.details?.rebound?.candleTime,
                referencePrice: decision.entryReferencePrice ?? decision.details?.rebound?.referencePrice,
                entryDelayMs
              },
              order: filledOrder,
              fillResult
            }));
            if (!submissionEvidenceRecorded || !fillEvidenceRecorded || !hasCompleteLiveFillResult(fillResult)) {
              if (!hasCompleteLiveFillResult(fillResult)) {
                this.owner.liveExecutionEvidenceDataError = 'live fill accounting fields are incomplete';
              }
              if (fillResult.partial && !(await this.owner.cancelLiveOrderIfOpen(orderId, filledOrder))) {
                this.owner.liveExecutionEvidenceDataError = 'live partial order cancellation failed';
              }
              console.error(`🛑 [${coin}] live fill evidence가 불완전해 전략 포지션을 확정하지 않습니다.`);
              return;
            }
            const settlementEvidence = await this.owner.recordLiveSettlementReadback({
              orderId,
              market: coin,
              side: 'bid',
              orderType: 'price',
              requested: { amount: investmentAmount },
              referencePrice: currentPrice,
              order: filledOrder,
              fillResult
            });
            if (!settlementEvidence.recorded) {
              this.owner.liveExecutionEvidenceDataError = 'live settlement evidence write failed';
              console.error(`🛑 [${coin}] settlement evidence가 저장되지 않아 전략 포지션을 확정하지 않습니다.`);
              return;
            }
            const actualVolume = Number(filledOrder.executed_volume);

            // Upbit API는 avg_price 필드로 평균 체결가를 제공
            const actualPrice = Number(filledOrder.avg_price);
            const actualAmount = actualVolume * actualPrice;
            const paidFee = Number(filledOrder.paid_fee);

            // 슬리피지 계산
            const slippage = ((actualPrice - currentPrice) / currentPrice * 100).toFixed(2);

            console.log(`  ✅ 체결 완료!`);
            console.log(`    실제 체결가: ${actualPrice.toLocaleString()} 원`);
            console.log(`    체결 수량: ${actualVolume.toFixed(8)}`);
            console.log(`    체결 금액: ${actualAmount.toLocaleString()} 원`);
            console.log(`    수수료: ${paidFee.toLocaleString()} 원`);
            console.log(`    슬리피지: ${slippage}%`);

            if (fillResult.partial) {
              console.log(`  ⚠️  부분 체결됨 - 잔여: ${filledOrder.remaining_volume}`);
              if (!(await this.owner.cancelLiveOrderIfOpen(orderId, filledOrder))) {
                this.owner.liveExecutionEvidenceDataError = 'live partial order cancellation failed';
                return;
              }
            }

            // 실제 체결 데이터로 포지션 오픈
            strategy.openPosition(actualPrice, actualVolume, 'BUY');
            this.owner.decorateEntryPosition(strategy, decision, {
              executionPrice: actualPrice,
              delayMs: entryDelayMs
            });
            this.owner.recordStrictSignalWindowEntry(decision.entrySignalKey || decision.details?.rebound?.signalKey);

            // 매수 알림 (실제 체결 데이터)
            this.owner.notifyTrade({
              type: 'BUY',
              coin,
              price: actualPrice,
              amount: actualVolume * actualPrice,
              volume: actualVolume,
              reason: decision.reason,
              signalStrength: signalStrength.level,
              mode: 'LIVE',
              orderId,
              slippage: parseFloat(slippage)
            });
          } else {
            const fillEvidenceRecorded = this.owner.recordLiveExecutionEvidence(this.owner.createLiveExecutionEvidence({
              eventType: 'FILL_NOT_OBSERVED',
              orderId,
              market: coin,
              side: 'bid',
              orderType: 'price',
              requested: { amount: investmentAmount },
              referencePrice: currentPrice,
              signal: {
                signalKey: decision.entrySignalKey || decision.details?.rebound?.signalKey,
                signalTime: decision.details?.rebound?.candleTime,
                referencePrice: decision.entryReferencePrice ?? decision.details?.rebound?.referencePrice,
                entryDelayMs
              },
              order: fillResult.order,
              fillResult,
              error: fillResult.error
            }));
            if (!fillEvidenceRecorded) {
              console.error(`🛑 [${coin}] 미체결 evidence 저장 실패를 기록하고 주문 취소 결과를 별도 확인해야 합니다.`);
            }
            // 미체결 - 주문 취소 시도
            console.log(`  ⚠️  체결 실패: ${fillResult.error}`);
            console.log(`  🔄 주문 취소 시도...`);

            try {
              await this.owner.upbit.cancelOrder(orderId, { priority: 'risk' });
              console.log(`  ✅ 주문 취소됨`);
            } catch (cancelError) {
              console.error(`  ❌ 주문 취소 실패: ${cancelError.message}`);
              console.log(`  ⚠️  수동 확인 필요 - 주문 ID: ${orderId}`);
            }
          }
        } else {
          console.error(`  ❌ 주문 실패: ${orderResult.error.message} (${orderResult.error.code})`);
          // 주문 실패 시 포지션 열지 않음 - 상태 일관성 유지
        }
      }
    }

    if (decision.action === 'SELL') {
      if (!strategy.currentPosition && coinBalance === 0) {
        console.log(`\n⚠️  [${coin}] 매도 불가: 보유 수량 없음`);
        return;
      }

      const sellVolume = strategy.currentPosition
        ? strategy.currentPosition.amount
        : coinBalance;

      // 최소 매도 금액 체크 (5000원)
      const paperExitCostModel = this.owner.getStrictPaperExecutionCostModel(strategy.currentPosition);
      const exitFillPrice = currentPrice * (1 - (paperExitCostModel?.slippageRate || 0));
      const estimatedSellAmount = sellVolume * exitFillPrice;
      if (estimatedSellAmount < 5000) {
        console.log(`\n⚠️  [${coin}] 매도 불가: 최소 매도금액(5,000원) 미만 (${estimatedSellAmount.toLocaleString()}원)`);
        return;
      }

      if (this.owner.dryRun) {
        const FEE_RATE = paperExitCostModel?.tradingFeeRate ?? 0.0005;
        const fee = estimatedSellAmount * FEE_RATE;
        const actualReceived = estimatedSellAmount - fee;

        console.log(`\n🧪 [모의투자] ${coin} 매도 주문`);
        console.log(`  수량: ${sellVolume.toFixed(8)}`);
        console.log(`  예상 금액: ${estimatedSellAmount.toLocaleString()} 원`);
        console.log(`  수수료: ${fee.toLocaleString()} 원 (${(FEE_RATE * 100).toFixed(2)}%)`);
        console.log(`  실수령: ${actualReceived.toLocaleString()} 원`);

        // 가상 포트폴리오 업데이트 (수수료 차감)
        this.owner.virtualPortfolio.krwBalance += actualReceived;

        const holding = this.owner.virtualPortfolio.holdings.get(coin);
        if (holding) {
          holding.amount -= sellVolume;
          if (holding.amount <= 0.00000001) {
            this.owner.virtualPortfolio.holdings.delete(coin);
          } else {
            this.owner.virtualPortfolio.holdings.set(coin, holding);
          }
        }

        // 수익률 계산
        const paperEntryFee = paperExitCostModel ? Number(strategy.currentPosition?.paperEntryFee) : null;
        const closeOptions = paperEntryFee !== null && Number.isFinite(paperEntryFee) && paperEntryFee >= 0
          ? { buyFee: paperEntryFee, tradingFeeRate: paperExitCostModel.tradingFeeRate }
          : {};
        if (paperExitCostModel && strategy.currentPosition) {
          strategy.currentPosition.paperObservedExitPrice = currentPrice;
        }
        const closedTrade = strategy.closePosition(exitFillPrice, decision.reason, closeOptions);
        const profitPercent = Number.isFinite(Number(closedTrade?.profitPercent))
          ? Number(closedTrade.profitPercent).toFixed(2)
          : '0.00';
        this.owner.recordPaperStrictTrade(coin, closedTrade, 'CLOSE');
        this.owner.saveVirtualPortfolio();
        console.log(`  잔여 KRW: ${this.owner.virtualPortfolio.krwBalance.toLocaleString()} 원`);

        // 매도 알림
        this.owner.notifyTrade({
          type: 'SELL',
          coin,
          price: exitFillPrice,
          amount: estimatedSellAmount,
          volume: sellVolume,
          reason: decision.reason,
          profitPercent,
          mode: 'DRY_RUN'
        });
      } else {
        console.log(`\n💰 [${coin}] 실제 매도 주문 실행`);
        console.log(`  예상 가격: ${currentPrice.toLocaleString()} 원`);
        console.log(`  매도 수량: ${sellVolume.toFixed(8)}`);

        const orderResult = await this.owner.submitLiveOrder(coin, 'ask', sellVolume, null, 'market');
        const orderId = orderResult?.data?.uuid || null;
        const submissionEvidenceRecorded = this.owner.recordLiveExecutionEvidence(this.owner.createLiveExecutionEvidence({
          eventType: orderResult?.success === true ? 'ORDER_SUBMITTED' : 'ORDER_REJECTED',
          orderId,
          market: coin,
          side: 'ask',
          orderType: 'market',
          requested: { volume: sellVolume },
          referencePrice: currentPrice,
          error: orderResult?.success === true ? null : orderResult?.error?.message
        }));

        if (orderResult?.success === true && orderId) {
          console.log(`  📝 주문 접수: ${orderId}`);

          // 주문 체결 대기 (최대 30초)
          console.log(`  ⏳ 체결 대기 중...`);
          const fillResult = await this.owner.waitForLiveOrderFill(coin, orderId, 30000, 1000);

          if (fillResult.filled) {
            const filledOrder = fillResult.order;
            const fillEvidenceRecorded = this.owner.recordLiveExecutionEvidence(this.owner.createLiveExecutionEvidence({
              eventType: fillResult.partial ? 'FILL_PARTIAL' : 'FILL_OBSERVED',
              orderId,
              market: coin,
              side: 'ask',
              orderType: 'market',
              requested: { volume: sellVolume },
              referencePrice: currentPrice,
              order: filledOrder,
              fillResult
            }));
            if (!submissionEvidenceRecorded || !fillEvidenceRecorded || !hasCompleteLiveFillResult(fillResult)) {
              if (!hasCompleteLiveFillResult(fillResult)) {
                this.owner.liveExecutionEvidenceDataError = 'live fill accounting fields are incomplete';
              }
              if (fillResult.partial && !(await this.owner.cancelLiveOrderIfOpen(orderId, filledOrder))) {
                this.owner.liveExecutionEvidenceDataError = 'live partial order cancellation failed';
              }
              console.error(`🛑 [${coin}] live fill evidence가 불완전해 전략 포지션을 확정하지 않습니다.`);
              return;
            }
            const settlementEvidence = await this.owner.recordLiveSettlementReadback({
              orderId,
              market: coin,
              side: 'ask',
              orderType: 'market',
              requested: { volume: sellVolume },
              referencePrice: currentPrice,
              order: filledOrder,
              fillResult
            });
            if (!settlementEvidence.recorded) {
              this.owner.liveExecutionEvidenceDataError = 'live settlement evidence write failed';
              console.error(`🛑 [${coin}] settlement evidence가 저장되지 않아 전략 포지션을 확정하지 않습니다.`);
              return;
            }
            const actualVolume = Number(filledOrder.executed_volume);

            // Upbit API는 avg_price 필드로 평균 체결가를 제공
            const actualPrice = Number(filledOrder.avg_price);
            const actualAmount = actualVolume * actualPrice;
            const paidFee = Number(filledOrder.paid_fee);

            // 슬리피지 계산
            const slippage = ((actualPrice - currentPrice) / currentPrice * 100).toFixed(2);

            // 수익률 계산 (실제 체결가 기준)
            const entryPrice = strategy.currentPosition?.entryPrice || currentPrice;
            const grossProfit = (actualPrice - entryPrice) * actualVolume;
            const netProfit = grossProfit - paidFee; // 매도 수수료 차감
            const profitPercent = ((actualPrice - entryPrice) / entryPrice * 100).toFixed(2);

            console.log(`  ✅ 체결 완료!`);
            console.log(`    실제 체결가: ${actualPrice.toLocaleString()} 원`);
            console.log(`    체결 수량: ${actualVolume.toFixed(8)}`);
            console.log(`    체결 금액: ${actualAmount.toLocaleString()} 원`);
            console.log(`    수수료: ${paidFee.toLocaleString()} 원`);
            console.log(`    슬리피지: ${slippage}%`);
            console.log(`    순수익: ${profitPercent}% (${netProfit >= 0 ? '+' : ''}${netProfit.toLocaleString()}원)`);

            if (fillResult.partial) {
              const remainingVolume = parseFloat(filledOrder.remaining_volume || 0);
              console.log(`  ⚠️  부분 체결됨 - 미체결 수량: ${remainingVolume.toFixed(8)}`);
              // 부분 체결 시 남은 수량 처리 필요 알림
              console.log(`  ⚠️  미체결 수량은 수동 확인 필요`);
            }

            if (fillResult.partial && !(await this.owner.cancelLiveOrderIfOpen(orderId, filledOrder))) {
              this.owner.liveExecutionEvidenceDataError = 'live partial order cancellation failed';
              return;
            }

            // 실제 체결 데이터로 포지션을 갱신한다. 부분 체결은 잔여
            // 포지션을 유지하고, 취소 후 확인된 수량만 기록한다.
            const isFullSell = !fillResult.partial ||
              actualVolume >= strategy.currentPosition?.amount - 0.00000001;
            const closedTrade = isFullSell
              ? strategy.closePosition(actualPrice, decision.reason)
              : strategy.recordPartialSell(actualPrice, actualVolume, decision.reason);
            this.owner.registerRuntimeLoss(closedTrade);

            // 매도 알림 (실제 체결 데이터)
            this.owner.notifyTrade({
              type: 'SELL',
              coin,
              price: actualPrice,
              amount: actualAmount,
              volume: actualVolume,
              reason: decision.reason,
              profitPercent: parseFloat(profitPercent),
              profitAmount: netProfit,
              fee: paidFee,
              mode: 'LIVE',
              orderId,
              slippage: parseFloat(slippage)
            });
          } else {
            const fillEvidenceRecorded = this.owner.recordLiveExecutionEvidence(this.owner.createLiveExecutionEvidence({
              eventType: 'FILL_NOT_OBSERVED',
              orderId,
              market: coin,
              side: 'ask',
              orderType: 'market',
              requested: { volume: sellVolume },
              referencePrice: currentPrice,
              order: fillResult.order,
              fillResult,
              error: fillResult.error
            }));
            if (!fillEvidenceRecorded) {
              console.error(`🛑 [${coin}] 미체결 evidence 저장 실패를 기록하고 주문 상태를 별도 확인해야 합니다.`);
            }
            // 미체결 - 마켓 주문이므로 이 경우는 드묾
            console.log(`  ⚠️  체결 실패: ${fillResult.error}`);
            console.log(`  ⚠️  포지션 상태 유지됨 - 수동 확인 필요`);
            console.log(`  ⚠️  주문 ID: ${orderId}`);
          }
        } else {
          console.error(`  ❌ 주문 실패: ${orderResult.error.message} (${orderResult.error.code})`);
          // 주문 실패 시 포지션 유지 - 수동 확인 필요
          console.log(`  ⚠️  포지션 상태 유지됨 - 수동 확인 필요`);
        }
      }
    }
  }
}
