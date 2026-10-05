// /trade/execute 단일 BUY/SELL use-case — manualOrderService.js에서 추출.
// 공유 의존(ctx)은 createManualOrderContext가 조립하고, leg 프리미티브는 manualOrderLegs에서 온다.
import {
  DUST_AMOUNT_THRESHOLD,
  quoteAmountLimits,
  formatQuoteAmount,
  applyDryBuy,
  applyDrySell,
  getStrategyFor,
  reflectStrategySellFill
} from './manualOrderLegs.js';

export function createExecuteUseCase(ctx) {
  const { tradingSystem, requireFreshQuote, runLiveLeg } = ctx;

  async function execute({ coin, action, amount, clientIntentId = null }) {
    if (!coin || !action) {
      return { status: 400, body: { error: 'coin과 action은 필수입니다', success: false } };
    }
    if (!['BUY', 'SELL'].includes(action.toUpperCase())) {
      return { status: 400, body: { error: 'action은 BUY 또는 SELL이어야 합니다', success: false } };
    }
    if (!tradingSystem.upbit) {
      return { status: 400, body: { error: '거래 시스템이 초기화되지 않았습니다', success: false } };
    }

    // 전략 가져오기 (없으면 동적 생성하여 통계 추적 보장)
    const strategy = getStrategyFor(tradingSystem, coin);
    const isDryRun = tradingSystem.dryRun;
    const side = action.toUpperCase();

    if (side === 'BUY') {
      const { minimumBuy, defaultBuy } = quoteAmountLimits(tradingSystem);
      const investmentAmount = amount ?? defaultBuy;
      if (!Number.isFinite(investmentAmount) || investmentAmount < minimumBuy) {
        return { status: 400, body: { error: `최소 투자금액은 ${formatQuoteAmount(tradingSystem, minimumBuy)}입니다`, success: false } };
      }
      const { ticker, block } = await requireFreshQuote(coin);
      if (block) return block;
      const currentPrice = ticker.trade_price;

      if (isDryRun) {
        // 모의투자 - 가상 포트폴리오 업데이트 (수수료 0.05%)
        const applied = applyDryBuy(tradingSystem, {
          coin,
          amount: investmentAmount,
          price: currentPrice,
          reflectStrategy: false
        });
        if (applied.insufficientBalance) {
          return {
            status: 400,
            body: {
              error: `잔액 부족 (보유: ${formatQuoteAmount(tradingSystem, applied.availableBalance)}, 요청: ${formatQuoteAmount(tradingSystem, investmentAmount)})`,
              success: false,
              availableBalance: applied.availableBalance
            }
          };
        }
        // 이 라우트의 기존 계약: 포트폴리오 유무와 무관하게 포지션을 새로 연다.
        if (strategy) strategy.openPosition(currentPrice, applied.volume, 'BUY');
        return {
          status: 200,
          body: {
            success: true,
            message: `[모의투자] ${coin} ${formatQuoteAmount(tradingSystem, investmentAmount)} 매수 완료 (수수료 ${formatQuoteAmount(tradingSystem, applied.fee)})`,
            order: {
              coin,
              action: 'BUY',
              price: currentPrice,
              volume: applied.volume,
              amount: investmentAmount,
              fee: applied.fee,
              mode: 'DRY_RUN'
            }
          }
        };
      }

      // 실전투자: 접수만으로 포지션을 열지 않고 실제 fill을 확인한다.
      const { execution, failure } = await runLiveLeg({
        market: coin,
        side: 'bid',
        volume: investmentAmount,
        orderType: 'price',
        requested: { amount: investmentAmount },
        referencePrice: currentPrice,
        clientIntentId
      });
      if (failure) return failure;
      const actualPrice = Number(execution.fill.averagePrice);
      const actualVolume = Number(execution.fill.executedVolume);
      if (strategy) strategy.openPosition(actualPrice, actualVolume, 'BUY');
      return {
        status: 200,
        body: {
          success: true,
          mode: 'LIVE',
          message: `${coin} 매수 체결 완료`,
          order: { ...(execution.orderResult || {}), mode: 'LIVE' },
          fill: execution.fill,
          price: actualPrice,
          volume: actualVolume,
          fee: execution.fill.paidFee
        }
      };
    }

    // SELL
    const accounts = await tradingSystem.getAccountInfo();
    const coinSymbol = coin.split('-')[1];
    const coinAccount = accounts.find(acc => acc.currency === coinSymbol);
    const coinBalance = coinAccount ? parseFloat(coinAccount.balance) : 0;
    const sellVolume = strategy?.currentPosition?.amount || coinBalance;
    if (sellVolume <= 0) {
      return { status: 400, body: { error: '매도할 수량이 없습니다', success: false } };
    }

    const { ticker, block } = await requireFreshQuote(coin);
    if (block) return block;
    const currentPrice = ticker.trade_price;

    if (isDryRun) {
      // 모의투자 - 가상 포트폴리오 업데이트 (수수료 0.05%)
      const applied = applyDrySell(tradingSystem, {
        coin,
        volume: sellVolume,
        price: currentPrice,
        reason: '수동 매도',
        reflectStrategy: false
      });
      // 이 라우트의 기존 계약: 전략 포지션은 항상 전량 종료한다.
      if (strategy) strategy.closePosition(currentPrice, '수동 매도');
      return {
        status: 200,
        body: {
          success: true,
          message: `[모의투자] ${coin} ${sellVolume.toFixed(8)} 매도 완료 (+${formatQuoteAmount(tradingSystem, applied.netSellAmount)}, 수수료 ${formatQuoteAmount(tradingSystem, applied.fee)})`,
          order: {
            coin,
            action: 'SELL',
            price: currentPrice,
            volume: sellVolume,
            grossAmount: applied.grossSellAmount,
            fee: applied.fee,
            amount: applied.netSellAmount,
            mode: 'DRY_RUN'
          }
        }
      };
    }

    // 실전투자: 실제 체결 수량만 전략 포지션에 반영한다.
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
    if (strategy?.currentPosition) {
      const isFullSell = strategy.currentPosition.amount - actualVolume <= DUST_AMOUNT_THRESHOLD;
      reflectStrategySellFill(strategy, actualPrice, actualVolume, '수동 매도', isFullSell);
    }
    return {
      status: 200,
      body: {
        success: true,
        mode: 'LIVE',
        message: `${coin} 매도 체결 완료`,
        order: { ...(execution.orderResult || {}), mode: 'LIVE' },
        fill: execution.fill,
        price: actualPrice,
        volume: actualVolume,
        fee: execution.fill.paidFee,
        grossAmount: actualPrice * actualVolume,
        amount: actualPrice * actualVolume - (Number.isFinite(execution.fill.paidFee) ? execution.fill.paidFee : 0)
      }
    };
  }

  return execute;
}
