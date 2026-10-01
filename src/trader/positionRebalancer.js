// PositionRebalancer — 포지션 수 계산·최약 포지션·리밸런스 매도·요약 출력.
//
// MultiCoinTrader에서 추출 — 순수 조합 로직, 상태는 owner 참조.
import { hasCompleteLiveFillResult } from './orderExecutionEngine.js';

export class PositionRebalancer {
  constructor(owner) {
    this.owner = owner;
    this.lastRebalanceTime = null;
  }

  /**
   * 현재 포지션 수 조회
   */
  getCurrentPositionCount() {
    let count = 0;
    for (const strategy of this.owner.strategies.values()) {
      if (strategy.currentPosition) {
        count++;
      }
    }
    return count;
  }

  /**
   * 가장 약한 포지션 찾기 (리밸런싱용)
   * @param {string} excludeCoin - 제외할 코인
   * @param {Array} coinAnalyses - 코인별 분석 결과
   * @returns {Object|null} 가장 약한 포지션 정보
   */
  findWeakestPosition(excludeCoin, coinAnalyses) {
    let weakest = null;
    let lowestScore = Infinity;

    // 최소 보유 시간: 10분 (리밸런싱 루프 방지 - 수수료 손실 최소화)
    const MIN_HOLD_TIME_MS = 10 * 60 * 1000;

    // 리밸런싱 쿨다운: 마지막 리밸런싱 후 5분 대기
    const REBALANCE_COOLDOWN_MS = 5 * 60 * 1000;
    if (this.lastRebalanceTime && (Date.now() - this.lastRebalanceTime) < REBALANCE_COOLDOWN_MS) {
      const remainingCooldown = Math.ceil((REBALANCE_COOLDOWN_MS - (Date.now() - this.lastRebalanceTime)) / 1000);
      console.log(`  ⏳ 리밸런싱 쿨다운 중 (${remainingCooldown}초 남음)`);
      return null;
    }

    for (const [coin, strategy] of this.owner.strategies.entries()) {
      if (coin === excludeCoin || !strategy.currentPosition) continue;

      // 최소 보유 시간 체크 - 방금 산 포지션은 리밸런싱 대상에서 제외
      const holdTime = Date.now() - new Date(strategy.currentPosition.entryTime).getTime();
      if (holdTime < MIN_HOLD_TIME_MS) {
        console.log(`  ⏳ [${coin}] 최소 보유 시간 미달 (${Math.floor(holdTime / 1000)}초/${MIN_HOLD_TIME_MS / 1000}초)`);
        continue;
      }

      // 해당 코인의 분석 결과 찾기
      const analysis = coinAnalyses.find(a => a.coin === coin);
      const score = analysis ? parseFloat(analysis.decision.scores.total) : 50;

      // 현재 수익률 계산
      const currentPrice = analysis?.currentPrice || strategy.currentPosition.entryPrice;
      const profitPercent = ((currentPrice - strategy.currentPosition.entryPrice) / strategy.currentPosition.entryPrice) * 100;

      // 점수가 낮고 수익률도 좋지 않은 포지션 우선
      const weaknessScore = score - (profitPercent * 0.5); // 점수 - (수익률 가중치)

      if (weaknessScore < lowestScore) {
        lowestScore = weaknessScore;
        weakest = {
          coin,
          strategy,
          score,
          profitPercent,
          currentPrice,
          position: strategy.currentPosition
        };
      }
    }

    return weakest;
  }

  /**
   * 리밸런싱을 위한 포지션 매도
   * @param {Object} weakestPosition - 매도할 포지션 정보
   * @param {string} targetCoin - 매수할 코인 (로그용)
   */
  async sellForRebalancing(weakestPosition, targetCoin) {
    const { coin, strategy, currentPrice, profitPercent } = weakestPosition;

    // 리밸런싱 수익성 체크: 손실 중인 포지션만 교체 (수수료 0.1% 고려)
    // 수수료로 인한 최소 손실: 매도 0.05% + 매수 0.05% = 0.1%
    const MIN_LOSS_FOR_REBALANCE = -0.5; // 최소 -0.5% 손실 중이어야 리밸런싱
    if (profitPercent > MIN_LOSS_FOR_REBALANCE) {
      console.log(`\n⛔ [리밸런싱 취소] ${coin} 수익률 ${profitPercent.toFixed(2)}%로 양호함`);
      console.log(`  리밸런싱은 ${MIN_LOSS_FOR_REBALANCE}% 이하 손실 포지션만 대상`);
      return 0;
    }

    console.log(`\n🔄 [리밸런싱] ${coin} 매도 → ${targetCoin} 매수 준비`);
    console.log(`  ${coin} 현재 수익률: ${profitPercent.toFixed(2)}%`);

    const sellVolume = strategy.currentPosition.amount;

    if (this.owner.dryRun) {
      // 수수료 계산 (0.05%)
      const FEE_RATE = 0.0005;
      const sellAmount = sellVolume * currentPrice;
      const fee = sellAmount * FEE_RATE;
      const actualReceived = sellAmount - fee;

      console.log(`  🧪 [모의투자] ${coin} 리밸런싱 매도`);
      console.log(`    수량: ${sellVolume.toFixed(8)}`);
      console.log(`    예상 금액: ${sellAmount.toLocaleString()} 원`);
      console.log(`    수수료: ${fee.toLocaleString()} 원 (0.05%)`);
      console.log(`    실수령: ${actualReceived.toLocaleString()} 원`);

      // 가상 포트폴리오 업데이트 (수수료 차감)
      this.owner.virtualPortfolio.krwBalance += actualReceived;

      const holding = this.owner.virtualPortfolio.holdings.get(coin);
      if (holding) {
        holding.amount -= sellVolume;
        if (holding.amount <= 0.00000001) {
          this.owner.virtualPortfolio.holdings.delete(coin);
        }
      }

      strategy.closePosition(currentPrice, `리밸런싱: ${targetCoin} 강한 매수 신호`);
      this.owner.saveVirtualPortfolio();

      // 리밸런싱 쿨다운 시간 기록
      this.lastRebalanceTime = Date.now();

      return actualReceived;
    } else {
      console.log(`  💰 [실전] ${coin} 리밸런싱 매도 실행`);
      console.log(`    예상 가격: ${currentPrice.toLocaleString()} 원`);
      console.log(`    매도 수량: ${sellVolume.toFixed(8)}`);

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
        console.log(`    📝 주문 접수: ${orderId}`);

        // 주문 체결 대기 (최대 30초)
        console.log(`    ⏳ 체결 대기 중...`);
        const fillResult = await this.owner.waitForLiveOrderFill(coin, orderId, 30000, 1000);

        if (fillResult?.filled === true) {
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
            console.error(`🛑 [${coin}] 리밸런싱 fill evidence가 불완전해 전략 포지션을 확정하지 않습니다.`);
            return 0;
          }
          const actualVolume = Number(filledOrder.executed_volume);

          // Upbit API는 avg_price 필드로 평균 체결가를 제공
          const actualPrice = Number(filledOrder.avg_price);
          const actualAmount = actualVolume * actualPrice;
          const paidFee = Number(filledOrder.paid_fee);

          const slippage = ((actualPrice - currentPrice) / currentPrice * 100).toFixed(2);

          console.log(`    ✅ 체결 완료!`);
          console.log(`      실제 체결가: ${actualPrice.toLocaleString()} 원`);
          console.log(`      체결 금액: ${actualAmount.toLocaleString()} 원`);
          console.log(`      수수료: ${paidFee.toLocaleString()} 원`);
          console.log(`      슬리피지: ${slippage}%`);

          if (fillResult.partial) {
            console.log(`    ⚠️  부분 체결됨 - 미체결 수량: ${filledOrder.remaining_volume}`);
            if (!(await this.owner.cancelLiveOrderIfOpen(orderId, filledOrder))) {
              this.owner.liveExecutionEvidenceDataError = 'live partial order cancellation failed';
              return 0;
            }
          }

          const isFullSell = !fillResult.partial || actualVolume >= strategy.currentPosition.amount - 0.00000001;
          if (isFullSell) {
            strategy.closePosition(actualPrice, `리밸런싱: ${targetCoin} 강한 매수 신호`);
          } else {
            strategy.recordPartialSell(actualPrice, actualVolume, `리밸런싱: ${targetCoin} 강한 매수 신호`);
          }

          // 리밸런싱 쿨다운 시간 기록
          this.lastRebalanceTime = Date.now();

          // 잔액 확인
          try {
            const accounts = await this.owner.upbit.getAccounts({ priority: 'risk' });
            const krwAccount = accounts.find(acc => acc.currency === this.owner.quoteAsset);
            const assetAccount = accounts.find(acc => acc.currency === coin.split('-')[1]);
            const settlementEvidenceRecorded = this.owner.recordLiveExecutionEvidence(this.owner.createLiveExecutionEvidence({
              eventType: 'SETTLEMENT_READBACK',
              orderId,
              market: coin,
              side: 'ask',
              orderType: 'market',
              requested: { volume: sellVolume },
              referencePrice: currentPrice,
              order: filledOrder,
              fillResult,
              settlementReadback: {
                status: 'observed',
                observedAt: new Date().toISOString(),
                krwBalance: krwAccount?.balance,
                assetBalance: assetAccount?.balance,
                lockedBalance: assetAccount?.locked
              }
            }));
            if (!settlementEvidenceRecorded) {
              this.owner.liveExecutionEvidenceDataError = 'live settlement evidence write failed';
            }
            return krwAccount ? Number(krwAccount.balance) : actualAmount - paidFee;
          } catch (error) {
            console.error(`⚠️ [${coin}] 리밸런싱 wallet readback 실패: ${error.message}`);
            return actualAmount - paidFee;
          }
        } else {
          const fillEvidenceRecorded = this.owner.recordLiveExecutionEvidence(this.owner.createLiveExecutionEvidence({
            eventType: 'FILL_NOT_OBSERVED',
            orderId,
            market: coin,
            side: 'ask',
            orderType: 'market',
            requested: { volume: sellVolume },
            referencePrice: currentPrice,
            order: fillResult?.order,
            fillResult,
            error: fillResult?.error
          }));
          if (!fillEvidenceRecorded || !(await this.owner.cancelLiveOrderIfOpen(orderId, fillResult?.order))) {
            this.owner.liveExecutionEvidenceDataError = 'live unfilled order could not be fully recorded or cancelled';
          }
          console.log(`    ⚠️  체결 실패: ${fillResult.error}`);
          console.log(`    ⚠️  리밸런싱 취소 - 포지션 유지`);
          return 0;
        }
      } else {
        if (!submissionEvidenceRecorded) {
          this.owner.liveExecutionEvidenceDataError = 'live order rejection evidence write failed';
        }
        console.error(`    ❌ 리밸런싱 매도 실패: ${orderResult?.error?.message || 'order_uuid_missing'} (${orderResult?.error?.code || 'unknown'})`);
        return 0;
      }
    }
  }

  /**
   * 포트폴리오 요약
   */
  printPortfolioSummary() {
    console.log('\n' + '='.repeat(80));
    console.log('📊 포트폴리오 요약');
    console.log('='.repeat(80));

    for (const coin of this.owner.targetCoins) {
      const strategy = this.owner.getStrategy(coin);
      const stats = strategy.getStatistics();

      console.log(`\n[${coin}]`);

      if (strategy.currentPosition) {
        console.log(`  📍 포지션: 보유중`);
        console.log(`    진입가: ${strategy.currentPosition.entryPrice.toLocaleString()} 원`);
        console.log(`    수량: ${strategy.currentPosition.amount.toFixed(8)}`);
      } else {
        console.log(`  📍 포지션: 없음`);
      }

      if (stats.totalTrades > 0) {
        console.log(`  거래 통계:`);
        console.log(`    총 거래: ${stats.totalTrades}회`);
        console.log(`    승률: ${stats.winRate}`);
        console.log(`    총 손익: ${stats.totalProfit}`);
      }
    }

    console.log('\n' + '='.repeat(80));
  }
}
