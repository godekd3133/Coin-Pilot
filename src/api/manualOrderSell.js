// /trade/sell 매도 use-case — manualOrderService.js에서 추출.
// 공유 의존(ctx)은 createManualOrderContext가 조립하고, leg 프리미티브는 manualOrderLegs에서 온다.
import {
  DUST_AMOUNT_THRESHOLD,
  MANUAL_ORDER_FEE_RATE,
  applyDrySell,
  getStrategyFor,
  readLiveHolding
} from './manualOrderLegs.js';

export function createSellUseCase(ctx) {
  const { tradingSystem, requireFreshQuote, runLiveLeg } = ctx;

  async function sell({ coin, quantity, clientIntentId = null }) {
    if (!coin || !quantity) {
      return { status: 400, body: { error: 'coin과 quantity는 필수입니다', success: false } };
    }

    const { ticker, block } = await requireFreshQuote(coin);
    if (block) return block;
    const currentPrice = ticker.trade_price;
    const isDryRun = tradingSystem.dryRun;

    // 보유량 확인
    const holding = isDryRun
      ? tradingSystem.virtualPortfolio?.holdings?.get(coin)
      : await readLiveHolding(tradingSystem, coin);

    if (!holding || holding.amount <= 0) {
      return { status: 400, body: { error: '보유 수량이 없습니다', success: false } };
    }

    const sellVolume = Math.min(quantity, holding.amount);
    let responsePrice = currentPrice;
    let responseVolume = sellVolume;
    let responseGrossAmount = sellVolume * currentPrice;
    let responseFee = responseGrossAmount * MANUAL_ORDER_FEE_RATE;
    let responseReceivedAmount = responseGrossAmount - responseFee;
    let liveFill = null;

    if (isDryRun) {
      applyDrySell(tradingSystem, {
        coin,
        volume: sellVolume,
        price: currentPrice,
        reason: '수동 매도'
      });
    } else {
      const { execution, failure } = await runLiveLeg({
        market: coin,
        side: 'ask',
        volume: sellVolume,
        orderType: 'market',
        requested: { volume: sellVolume },
        referencePrice: currentPrice,
        clientIntentId
      });
      liveFill = execution.fill;
      if (failure) {
        return { status: failure.status, body: { ...failure.body, coin } };
      }
      responsePrice = liveFill.averagePrice;
      responseVolume = liveFill.executedVolume;
      responseFee = liveFill.paidFee;
      responseGrossAmount = responsePrice * responseVolume;
      responseReceivedAmount = responseGrossAmount - responseFee;
      // 실제 체결된 수량/가격만 전략 포지션에 반영한다.
      const strategy = getStrategyFor(tradingSystem, coin);
      const isFullSell = holding.amount - responseVolume <= DUST_AMOUNT_THRESHOLD;
      if (strategy?.currentPosition) {
        if (isFullSell) strategy.closePosition(responsePrice, '수동 매도');
        else strategy.recordPartialSell(responsePrice, responseVolume, '수동 매도');
      }
    }

    return {
      status: 200,
      body: {
        success: true,
        mode: isDryRun ? 'DRY_RUN' : 'LIVE',
        coin,
        quantity: responseVolume,
        price: responsePrice,
        grossAmount: Math.round(responseGrossAmount),
        fee: Math.round(responseFee),
        receivedAmount: Math.round(responseReceivedAmount),
        fill: liveFill
      }
    };
  }

  return sell;
}
