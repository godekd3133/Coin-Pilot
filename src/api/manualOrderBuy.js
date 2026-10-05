// /trade/buy 매수 use-case — manualOrderService.js에서 추출.
// 공유 의존(ctx)은 createManualOrderContext가 조립하고, leg 프리미티브는 manualOrderLegs에서 온다.
import {
  MANUAL_ORDER_FEE_RATE,
  quoteAmountLimits,
  formatQuoteAmount,
  applyDryBuy,
  getStrategyFor,
  reflectStrategyBuyFill
} from './manualOrderLegs.js';

export function createBuyUseCase(ctx) {
  const { tradingSystem, requireFreshQuote, runLiveLeg } = ctx;

  async function buy({ coin, amount, clientIntentId = null }) {
    if (!coin || !amount) {
      return { status: 400, body: { error: 'coin과 amount는 필수입니다', success: false } };
    }
    const { minimumBuy } = quoteAmountLimits(tradingSystem);
    if (!Number.isFinite(amount) || amount < minimumBuy) {
      return { status: 400, body: { error: `최소 매수 금액은 ${formatQuoteAmount(tradingSystem, minimumBuy)}입니다`, success: false } };
    }

    const { ticker, block } = await requireFreshQuote(coin);
    if (block) return block;
    const currentPrice = ticker.trade_price;
    const isDryRun = tradingSystem.dryRun;
    let responsePrice = currentPrice;
    let responseVolume;
    let responseFee;
    let liveFill = null;

    if (isDryRun) {
      const applied = applyDryBuy(tradingSystem, { coin, amount, price: currentPrice });
      if (applied.insufficientBalance) {
        return {
          status: 400,
          body: {
            error: `잔액 부족 (보유: ${formatQuoteAmount(tradingSystem, applied.availableBalance)})`,
            success: false
          }
        };
      }
      const fee = amount * MANUAL_ORDER_FEE_RATE;
      const actualInvestment = amount - fee;
      responseVolume = actualInvestment / currentPrice;
      responseFee = fee;
    } else {
      const { execution, failure } = await runLiveLeg({
        market: coin,
        side: 'bid',
        volume: amount,
        orderType: 'price',
        requested: { amount },
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
      // 실제 체결된 수량/가격만 전략 포지션에 반영한다.
      reflectStrategyBuyFill(getStrategyFor(tradingSystem, coin), responsePrice, responseVolume);
    }

    return {
      status: 200,
      body: {
        success: true,
        mode: isDryRun ? 'DRY_RUN' : 'LIVE',
        coin,
        amount,
        fee: responseFee,
        price: responsePrice,
        volume: responseVolume,
        fill: liveFill
      }
    };
  }

  return buy;
}
