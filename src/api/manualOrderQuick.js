// /trade/quick 시장가 퀵 주문 use-case — manualOrderService.js에서 추출.
// 공유 의존(ctx)은 createManualOrderContext가 조립하고, leg 프리미티브는 manualOrderLegs에서 온다.
import {
  DUST_AMOUNT_THRESHOLD,
  MANUAL_ORDER_FEE_RATE,
  MIN_BUY_KRW,
  applyDryBuy,
  applyDrySell,
  getStrategyFor,
  readKrwBalance,
  readLiveHolding,
  reflectStrategyBuyFill,
  reflectStrategySellFill
} from './manualOrderLegs.js';

export function createQuickUseCase(ctx) {
  const { tradingSystem, requireFreshQuote, runLiveLeg } = ctx;

  async function quick({ coin, action, amount, clientIntentId = null }) {
    if (!coin || !action || !amount) {
      return { status: 400, body: { error: 'coin, action, amount 필수', success: false } };
    }
    if (action === 'BUY' && amount < MIN_BUY_KRW) {
      return { status: 400, body: { error: '최소 매수 금액은 5,000원입니다', success: false } };
    }

    const { ticker, block } = await requireFreshQuote(coin);
    if (block) return block;
    const currentPrice = ticker.trade_price;
    const isDryRun = tradingSystem.dryRun;

    if (action === 'BUY') {
      // 보유 현금 확인 및 자동 조절
      let buyAmount = amount;
      let buyWasAdjusted = false;
      const availableBalance = await readKrwBalance(tradingSystem);

      // 금액이 보유 현금을 초과하면 최대 가용 금액으로 자동 조절
      if (buyAmount > availableBalance * 0.98) {
        buyAmount = Math.floor(availableBalance * 0.95);
        buyWasAdjusted = true;
        console.log(`⚠️ 빠른 매수 금액 자동 조절: ${amount.toLocaleString()}원 → ${buyAmount.toLocaleString()}원`);
      }
      if (buyAmount < MIN_BUY_KRW) {
        return {
          status: 400,
          body: {
            error: `보유 현금 부족 (${availableBalance.toLocaleString()}원). 최소 5,000원 이상 필요합니다.`,
            success: false,
            availableBalance
          }
        };
      }

      const fee = buyAmount * MANUAL_ORDER_FEE_RATE;
      const actualInvestment = buyAmount - fee;
      const volume = actualInvestment / currentPrice;
      let responsePrice = currentPrice;
      let responseVolume = volume;
      let responseFee = fee;
      let liveFill = null;

      if (isDryRun) {
        const applied = applyDryBuy(tradingSystem, { coin, amount: buyAmount, price: currentPrice });
        if (applied.insufficientBalance) {
          return {
            status: 400,
            body: {
              error: `잔액 부족 (보유: ${applied.availableBalance.toLocaleString()}원, 요청: ${buyAmount.toLocaleString()}원)`,
              success: false,
              availableBalance: applied.availableBalance
            }
          };
        }
      } else {
        const { execution, failure } = await runLiveLeg({
          market: coin,
          side: 'bid',
          volume: buyAmount,
          orderType: 'price',
          requested: { amount: buyAmount },
          referencePrice: currentPrice,
          clientIntentId
        });
        if (failure) return failure;
        const actualPrice = Number(execution.fill.averagePrice);
        const actualVolume = Number(execution.fill.executedVolume);
        liveFill = execution.fill;
        reflectStrategyBuyFill(getStrategyFor(tradingSystem, coin), actualPrice, actualVolume);
        responsePrice = actualPrice;
        responseVolume = actualVolume;
        responseFee = execution.fill.paidFee;
      }

      return {
        status: 200,
        body: {
          success: true,
          mode: isDryRun ? 'DRY_RUN' : 'LIVE',
          action: 'BUY',
          coin,
          amount: buyAmount,
          originalAmount: amount,
          amountWasAdjusted: buyWasAdjusted,
          price: responsePrice,
          volume: responseVolume,
          fee: responseFee,
          fill: liveFill,
          message: buyWasAdjusted
            ? `매수 완료 (금액 자동 조절: ${amount.toLocaleString()}원 → ${buyAmount.toLocaleString()}원, 수수료 ${(isDryRun ? fee : responseFee || 0).toFixed(0)}원)`
            : `매수 완료 (수수료 ${(isDryRun ? fee : responseFee || 0).toFixed(0)}원)`
        }
      };
    }

    // SELL
    let holding = isDryRun
      ? tradingSystem.virtualPortfolio?.holdings?.get(coin)
      : await readLiveHolding(tradingSystem, coin);
    if (!holding || holding.amount <= 0) {
      return { status: 400, body: { error: '보유 수량이 없습니다', success: false } };
    }

    const maxHoldingValue = holding.amount * currentPrice;
    let sellWasAdjusted = false;

    // amount가 퍼센트인 경우 (100 이하)
    let sellVolume;
    if (amount <= 100) {
      sellVolume = holding.amount * (amount / 100);
    } else {
      sellVolume = amount / currentPrice;
      if (sellVolume > holding.amount) {
        sellVolume = holding.amount;
        sellWasAdjusted = true;
        console.log(`⚠️ 빠른 매도 수량 자동 조절: 요청 ${(amount / currentPrice).toFixed(8)} → 최대 ${holding.amount.toFixed(8)}`);
      }
    }

    let responsePrice = currentPrice;
    let responseVolume = sellVolume;
    let responseFee = sellVolume * currentPrice * MANUAL_ORDER_FEE_RATE;
    let liveFill = null;

    if (isDryRun) {
      applyDrySell(tradingSystem, {
        coin,
        volume: sellVolume,
        price: currentPrice,
        reason: '빠른 매도'
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
      if (failure) return failure;
      const actualPrice = Number(execution.fill.averagePrice);
      const actualVolume = Number(execution.fill.executedVolume);
      const actualFee = execution.fill.paidFee;
      const strategy = getStrategyFor(tradingSystem, coin);
      reflectStrategySellFill(
        strategy,
        actualPrice,
        actualVolume,
        '빠른 매도',
        (strategy?.currentPosition?.amount ?? 0) - actualVolume <= DUST_AMOUNT_THRESHOLD
      );
      responsePrice = actualPrice;
      responseVolume = actualVolume;
      responseFee = actualFee;
      liveFill = execution.fill;
    }

    return {
      status: 200,
      body: {
        success: true,
        mode: isDryRun ? 'DRY_RUN' : 'LIVE',
        action: 'SELL',
        coin,
        volume: responseVolume,
        price: responsePrice,
        grossAmount: responsePrice * responseVolume,
        fee: responseFee,
        amount: responsePrice * responseVolume - (Number.isFinite(responseFee) ? responseFee : 0),
        originalAmount: amount,
        amountWasAdjusted: sellWasAdjusted,
        fill: liveFill,
        maxHoldingValue: Math.round(maxHoldingValue),
        message: sellWasAdjusted
          ? `매도 완료 (최대 보유액 ${Math.round(maxHoldingValue).toLocaleString()}원으로 조절, 수수료 ${(isDryRun ? responseFee : responseFee || 0).toFixed(0)}원)`
          : `매도 완료 (수수료 ${(isDryRun ? responseFee : responseFee || 0).toFixed(0)}원)`
      }
    };
  }

  return quick;
}
