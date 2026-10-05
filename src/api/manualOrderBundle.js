// /trade/execute-bundle 번들 제안 실행 use-case — manualOrderService.js에서 추출.
// 공유 의존(ctx)은 createManualOrderContext가 조립하고, leg 프리미티브는 manualOrderLegs에서 온다.
import {
  DUST_AMOUNT_THRESHOLD,
  MANUAL_ORDER_FEE_RATE,
  quoteAmountLimits,
  floorQuoteAmount,
  formatQuoteAmount,
  getStrategyFor,
  liveFillFailureResult,
  readLiveHolding,
  reflectStrategyBuyFill
} from './manualOrderLegs.js';
import { appendSmartTradeHistory } from './smartTradeHistory.js';
import {
  executeLiveOrderWithEvidence,
  hasCompleteObservedLiveFill
} from './manualOrderExecution.js';
import { baseOfMarket } from '../exchange/marketCodes.js';

export function createExecuteBundleUseCase(ctx) {
  const { tradingSystem, inspectMarketQuote, marketQuoteBlockResult, readFreshMarketTicker } = ctx;

  async function executeBundle({ sellCoin, sellAmount, buyCoin, buyAmount }, { attachLegIntent = null } = {}) {
    if (!sellCoin || !buyCoin) {
      return { status: 400, body: { error: 'sellCoin과 buyCoin은 필수입니다', success: false } };
    }

    const results = { sell: null, buy: null };
    const isDryRun = tradingSystem.dryRun;

    // Read and validate both legs before the first portfolio/order mutation.
    const [sellTicker, buyTicker] = await Promise.all([
      readFreshMarketTicker(sellCoin),
      readFreshMarketTicker(buyCoin)
    ]);
    const initialQuoteBlock = marketQuoteBlockResult([
      inspectMarketQuote(sellTicker, sellCoin),
      inspectMarketQuote(buyTicker, buyCoin)
    ]);
    if (initialQuoteBlock) return initialQuoteBlock;

    // 1. 매도 실행
    const sellPrice = sellTicker.trade_price;
    let holding = tradingSystem.virtualPortfolio?.holdings.get(sellCoin);
    if (!isDryRun) {
      holding = await readLiveHolding(tradingSystem, sellCoin);
    }
    const requestedSellAmount = Number(sellAmount);
    const actualSellAmount = Number.isFinite(requestedSellAmount) && requestedSellAmount > 0
      ? Math.min(requestedSellAmount, Number(holding?.amount) || 0)
      : Number(holding?.amount) || 0;
    if (actualSellAmount <= 0) {
      return { status: 400, body: { error: '매도할 수량이 없습니다', success: false } };
    }

    const sellValue = actualSellAmount * sellPrice;
    if (isDryRun) {
      // 모의투자 매도 (수수료 적용)
      const sellFee = sellValue * MANUAL_ORDER_FEE_RATE;
      const netSellValue = sellValue - sellFee;
      const portfolio = tradingSystem.virtualPortfolio;
      if (portfolio) {
        portfolio.krwBalance += netSellValue;
        const existingHolding = portfolio.holdings.get(sellCoin);
        const isFullSell = existingHolding && (existingHolding.amount - actualSellAmount) <= DUST_AMOUNT_THRESHOLD;
        if (existingHolding) {
          existingHolding.amount -= actualSellAmount;
          if (existingHolding.amount <= DUST_AMOUNT_THRESHOLD) {
            portfolio.holdings.delete(sellCoin);
          }
        }
        // 전략 포지션도 업데이트 (통계 집계용)
        const sellStrategy = getStrategyFor(tradingSystem, sellCoin);
        if (sellStrategy?.currentPosition) {
          if (isFullSell) {
            sellStrategy.closePosition(sellPrice, '번들 매도');
          } else {
            // 부분 매도 시 recordPartialSell 사용 (수익 기록 포함)
            sellStrategy.recordPartialSell(sellPrice, actualSellAmount, '번들 매도');
          }
        }
      }
      results.sell = { coin: sellCoin, amount: actualSellAmount, price: sellPrice, grossValue: sellValue, fee: sellFee, value: netSellValue };
    } else {
      const sellIntentId = attachLegIntent ? await attachLegIntent('sell') : null;
      if (!sellIntentId) {
        return {
          status: 503,
          body: {
            success: false,
            mode: 'LIVE',
            reason: 'leg_intent_unavailable',
            message: '요청 저널에 매도 주문 식별자를 기록하지 못해 주문을 보내지 않았습니다.'
          }
        };
      }
      const liveExecution = await executeLiveOrderWithEvidence(tradingSystem, {
        market: sellCoin,
        side: 'ask',
        volume: actualSellAmount,
        orderType: 'market',
        requested: { volume: actualSellAmount },
        referencePrice: sellPrice,
        clientIntentId: sellIntentId
      });
      results.sell = {
        ...(liveExecution.orderResult || {}),
        coin: sellCoin,
        fill: liveExecution.fill
      };
      if (!hasCompleteObservedLiveFill(liveExecution)) {
        return liveFillFailureResult(liveExecution, {
          message: '번들 매도가 실제 체결되지 않아 매수로 진행하지 않았습니다.',
          extra: { results }
        });
      }

      const filledSellAmount = Number(liveExecution.fill.executedVolume);
      const filledSellPrice = Number(liveExecution.fill.averagePrice);
      const filledSellFee = liveExecution.fill.paidFee;
      const filledSellValue = filledSellAmount * filledSellPrice;
      const netSellValue = filledSellValue - (Number.isFinite(filledSellFee) ? filledSellFee : 0);
      results.sell = {
        ...results.sell,
        amount: filledSellAmount,
        price: filledSellPrice,
        grossValue: filledSellValue,
        fee: filledSellFee,
        value: netSellValue
      };
      // 실제 체결된 수량/가격만 전략 포지션에 반영한다.
      const isFullSell = holding && (Number(holding.amount) - filledSellAmount) <= DUST_AMOUNT_THRESHOLD;
      const sellStrategy = getStrategyFor(tradingSystem, sellCoin);
      if (sellStrategy?.currentPosition) {
        if (isFullSell) {
          sellStrategy.closePosition(filledSellPrice, '번들 매도');
        } else {
          // 부분 매도 시 실제 체결 수량만 기록한다.
          sellStrategy.recordPartialSell(filledSellPrice, filledSellAmount, '번들 매도');
        }
      }
    }

    // 2. 매수 실행
    const buyQuoteCheck = inspectMarketQuote(buyTicker, buyCoin);
    const buyQuoteBlock = marketQuoteBlockResult([buyQuoteCheck], {
      results,
      message: buyQuoteCheck.reason === 'market_source_stale' ||
        buyQuoteCheck.reason === 'market_source_timestamp_in_future'
        ? '매도는 완료됐지만 매수 종목의 최근 체결 시각이 오래되어 매수는 보내지 않았습니다.'
        : '매도는 완료됐지만 매수 종목의 시세를 확인할 수 없어 매수는 보내지 않았습니다.'
    });
    if (buyQuoteBlock) return buyQuoteBlock;
    const buyPrice = buyTicker.trade_price;
    // 매도 후 실제 잔액 기반으로 매수 (드라이런에서는 수수료 차감된 금액 사용)
    const availableForBuy = results.sell.value;
    const requestedBuyAmount = Number(buyAmount);
    const investAmount = Number.isFinite(requestedBuyAmount) && requestedBuyAmount > 0
      ? requestedBuyAmount
      : floorQuoteAmount(tradingSystem, availableForBuy * 0.95);
    const { minimumBuy } = quoteAmountLimits(tradingSystem);
    if (!Number.isFinite(investAmount) || investAmount < minimumBuy) {
      return {
        status: 400,
        body: {
          success: false,
          mode: isDryRun ? 'DRY_RUN' : 'LIVE',
          message: `매수 금액이 최소 주문 금액(${formatQuoteAmount(tradingSystem, minimumBuy)})보다 작습니다.`,
          results
        }
      };
    }

    if (isDryRun) {
      // 모의투자 매수 (수수료 적용)
      const buyFee = investAmount * MANUAL_ORDER_FEE_RATE;
      const actualInvestment = investAmount - buyFee;
      const buyVolume = actualInvestment / buyPrice;
      const portfolio = tradingSystem.virtualPortfolio;
      if (portfolio) {
        portfolio.krwBalance -= investAmount;
        const existing = portfolio.holdings.get(buyCoin) || { amount: 0, avgPrice: 0, entryTime: null };
        const newAmount = existing.amount + buyVolume;
        const newAvgPrice = ((existing.amount * existing.avgPrice) + (buyVolume * buyPrice)) / newAmount;
        portfolio.holdings.set(buyCoin, {
          amount: newAmount,
          avgPrice: newAvgPrice,
          entryTime: existing.entryTime || new Date().toISOString()
        });
        reflectStrategyBuyFill(getStrategyFor(tradingSystem, buyCoin), buyPrice, buyVolume);
        tradingSystem.saveVirtualPortfolio();
      }
      results.buy = { coin: buyCoin, amount: buyVolume, price: buyPrice, grossValue: investAmount, fee: buyFee, value: actualInvestment };
    } else {
      const buyIntentId = attachLegIntent ? await attachLegIntent('buy') : null;
      if (!buyIntentId) {
        return {
          status: 503,
          body: {
            success: false,
            mode: 'LIVE',
            reason: 'leg_intent_unavailable',
            message: '요청 저널에 매수 주문 식별자를 기록하지 못해 매수를 보내지 않았습니다. 매도 체결은 results.sell에서 확인하세요.',
            results
          }
        };
      }
      const liveExecution = await executeLiveOrderWithEvidence(tradingSystem, {
        market: buyCoin,
        side: 'bid',
        volume: investAmount,
        orderType: 'price',
        requested: { amount: investAmount },
        referencePrice: buyPrice,
        clientIntentId: buyIntentId
      });
      results.buy = {
        ...(liveExecution.orderResult || {}),
        coin: buyCoin,
        fill: liveExecution.fill
      };
      if (!hasCompleteObservedLiveFill(liveExecution)) {
        return liveFillFailureResult(liveExecution, {
          message: '번들 매수가 실제 체결되지 않았습니다. 매도 체결은 results.sell에서 확인하세요.',
          extra: { results }
        });
      }

      const filledBuyVolume = Number(liveExecution.fill.executedVolume);
      const filledBuyPrice = Number(liveExecution.fill.averagePrice);
      const filledBuyFee = liveExecution.fill.paidFee;
      const filledBuyValue = filledBuyVolume * filledBuyPrice;
      const netBuyValue = filledBuyValue - (Number.isFinite(filledBuyFee) ? filledBuyFee : 0);
      results.buy = {
        ...results.buy,
        amount: filledBuyVolume,
        price: filledBuyPrice,
        grossValue: filledBuyValue,
        fee: filledBuyFee,
        value: netBuyValue
      };
      // 실제 체결된 수량/가격만 전략 포지션에 반영한다.
      reflectStrategyBuyFill(getStrategyFor(tradingSystem, buyCoin), filledBuyPrice, filledBuyVolume);
    }

    appendSmartTradeHistory(tradingSystem, {
      type: 'BUNDLE_TRADE',
      sell: results.sell,
      buy: results.buy,
      timestamp: new Date().toISOString(),
      mode: isDryRun ? 'DRY_RUN' : 'LIVE'
    });

    return {
      status: 200,
      body: {
        success: true,
        message: `[${isDryRun ? '모의투자' : '실전'}] ${baseOfMarket(sellCoin)} 매도 → ${baseOfMarket(buyCoin)} 매수 완료`,
        results,
        mode: isDryRun ? 'DRY_RUN' : 'LIVE'
      }
    };
  }

  return executeBundle;
}
