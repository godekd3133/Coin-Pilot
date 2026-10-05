// /trade/smart-sell 스마트 분할 매도 use-case — manualOrderService.js에서 추출.
// 공유 의존(ctx)은 createManualOrderContext가 조립하고, leg 프리미티브는 manualOrderLegs에서 온다.
import {
  DUST_AMOUNT_THRESHOLD,
  MANUAL_ORDER_FEE_RATE,
  quoteAmountLimits,
  roundQuoteAmount,
  formatQuoteAmount,
  getStrategyFor
} from './manualOrderLegs.js';
import { appendSmartTradeHistory } from './smartTradeHistory.js';
import {
  executeLiveOrderWithEvidence,
  hasCompleteObservedLiveFill
} from './manualOrderExecution.js';
import { quoteOfSystem } from '../exchange/marketCodes.js';

export function createSmartSellUseCase(ctx) {
  const { tradingSystem, inspectMarketQuote, marketQuoteBlockResult, readFreshTickers, readMinuteCandles } = ctx;

  async function smartSell({ targetAmount, strategy = 'worst' }, { attachLegIntent = null } = {}) {
    const { minimumSmartSell } = quoteAmountLimits(tradingSystem);
    if (!Number.isFinite(targetAmount) || targetAmount < minimumSmartSell) {
      return { status: 400, body: { error: `목표 매도 금액은 최소 ${formatQuoteAmount(tradingSystem, minimumSmartSell)} 이상이어야 합니다`, success: false } };
    }
    if (!tradingSystem.upbit) {
      return { status: 400, body: { error: '거래 시스템 미초기화', success: false } };
    }

    // 실전/드라이 모드에 따라 보유 코인 조회
    let holdings = new Map();
    const isDryRunMode = tradingSystem.dryRun;
    if (isDryRunMode) {
      // Analysis awaits ticker/candle reads. Keep a value snapshot for the
      // ranking pass and re-read the shared holding immediately before each
      // mutation so a concurrent portfolio update cannot over-credit KRW.
      const portfolioHoldings = tradingSystem.virtualPortfolio?.holdings;
      holdings = portfolioHoldings instanceof Map
        ? new Map(Array.from(portfolioHoldings.entries(), ([coin, holding]) => [coin, { ...holding }]))
        : new Map();
    } else {
      const accounts = await tradingSystem.getAccountInfo();
      for (const acc of accounts) {
        const quote = quoteOfSystem(tradingSystem);
        if (acc.currency !== quote && parseFloat(acc.balance) > 0) {
          holdings.set(`${quote}-${acc.currency}`, {
            amount: parseFloat(acc.balance),
            avgPrice: parseFloat(acc.avg_buy_price) || 0
          });
        }
      }
    }
    if (holdings.size === 0) {
      return { status: 400, body: { error: '보유 중인 코인이 없습니다', success: false } };
    }

    const { comprehensiveAnalysis } = await import('../analysis/technicalIndicators.js');

    // 보유 코인 분석
    const holdingCoins = Array.from(holdings.keys());
    const tickers = await readFreshTickers(holdingCoins);
    const tickerByMarket = new Map(tickers
      .filter(ticker => typeof ticker?.market === 'string')
      .map(ticker => [ticker.market, ticker]));
    const holdingQuoteBlock = marketQuoteBlockResult(holdingCoins.map(coin =>
      inspectMarketQuote(tickerByMarket.get(coin), coin)
    ));
    if (holdingQuoteBlock) return holdingQuoteBlock;

    const coinAnalysis = [];
    let totalHoldingValue = 0;
    for (const coin of holdingCoins) {
      const holding = holdings.get(coin);
      const ticker = tickers.find(t => t.market === coin);
      if (!ticker) continue;

      const currentValue = ticker.trade_price * holding.amount;
      const costBasis = holding.avgPrice * holding.amount;
      const profit = currentValue - costBasis;
      const profitPercent = costBasis > 0 ? ((currentValue / costBasis) - 1) * 100 : 0;
      totalHoldingValue += currentValue;

      // RSI 분석
      let rsi = 50;
      try {
        const candles = await readMinuteCandles(coin, 5, 50);
        if (candles && candles.length >= 30) {
          const analysis = comprehensiveAnalysis(candles, {});
          rsi = analysis?.indicators?.rsi || 50;
        }
      } catch {
        // RSI 조회 실패 시 기본값 유지
      }

      coinAnalysis.push({
        coin,
        holding,
        currentPrice: ticker.trade_price,
        currentValue,
        costBasis,
        profit,
        profitPercent,
        rsi,
        change24h: ticker.signed_change_rate * 100
      });
      await new Promise(r => setTimeout(r, 50));
    }

    // 목표 금액이 총 보유 금액보다 크면 전량 매도
    const actualTargetAmount = Math.min(targetAmount, totalHoldingValue);

    // 전략에 따라 정렬
    if (strategy === 'worst') {
      // 손실 큰 순 (손절)
      coinAnalysis.sort((a, b) => a.profitPercent - b.profitPercent);
    } else if (strategy === 'best') {
      // 수익 큰 순 (익절)
      coinAnalysis.sort((a, b) => b.profitPercent - a.profitPercent);
    } else if (strategy === 'overbought') {
      // RSI 높은 순
      coinAnalysis.sort((a, b) => b.rsi - a.rsi);
    }

    const plannedQuoteBlock = marketQuoteBlockResult(coinAnalysis.map(data =>
      inspectMarketQuote(tickerByMarket.get(data.coin), data.coin)
    ));
    if (plannedQuoteBlock) return plannedQuoteBlock;

    const orders = [];
    const liveFailures = [];
    const isDryRun = tradingSystem.dryRun;
    let totalSellAmount = 0;
    let remainingTarget = actualTargetAmount;

    for (const data of coinAnalysis) {
      if (remainingTarget <= 0) break;

      const dispatchQuoteCheck = inspectMarketQuote(tickerByMarket.get(data.coin), data.coin);
      if (!dispatchQuoteCheck.fresh) {
        liveFailures.push({ coin: data.coin, reason: dispatchQuoteCheck.reason, orderDispatched: false });
        continue;
      }

      const currentHolding = isDryRun
        ? tradingSystem.virtualPortfolio?.holdings?.get(data.coin)
        : data.holding;
      const currentHoldingAmount = Number(currentHolding?.amount);
      const currentPrice = Number(data.currentPrice);
      if (!Number.isFinite(currentHoldingAmount) || currentHoldingAmount <= 0 ||
        !Number.isFinite(currentPrice) || currentPrice <= 0) continue;

      // The analysis snapshot may predate an automatic or manual holding
      // change. Clamp its planned value to the holding that exists now.
      const analyzedSellAmount = Math.min(data.currentValue, remainingTarget);
      const currentHoldingValue = currentHoldingAmount * currentPrice;
      const sellAmount = Math.min(analyzedSellAmount, currentHoldingValue);
      if (sellAmount < minimumSmartSell) continue;

      const sellVolume = Math.min(currentHoldingAmount, sellAmount / currentPrice);
      const actualGrossSellAmount = sellVolume * currentPrice;
      const sellRatio = sellVolume / currentHoldingAmount;
      const fee = actualGrossSellAmount * MANUAL_ORDER_FEE_RATE;
      const netSellAmount = actualGrossSellAmount - fee;
      let executedPrice = currentPrice;
      let executedVolume = sellVolume;
      let executedFee = fee;
      let executedSellAmount = actualGrossSellAmount;
      let executedNetSellAmount = netSellAmount;
      let executedSellRatio = sellRatio;
      const averageEntryPrice = Number(currentHolding.avgPrice);
      let executedProfit = Number.isFinite(averageEntryPrice) && averageEntryPrice > 0
        ? (currentPrice - averageEntryPrice) * sellVolume - executedFee
        : (data.profit * executedSellRatio) - executedFee;
      let executedProfitPercent = Number.isFinite(averageEntryPrice) && averageEntryPrice > 0
        ? ((currentPrice / averageEntryPrice) - 1) * 100
        : data.profitPercent;
      let executionFill = null;

      if (isDryRun) {
        const portfolio = tradingSystem.virtualPortfolio;
        if (portfolio) {
          portfolio.krwBalance += netSellAmount;
          const holding = portfolio.holdings.get(data.coin);
          const isFullSell = holding && (Number(holding.amount) - sellVolume) <= DUST_AMOUNT_THRESHOLD;
          if (holding) {
            holding.amount = Math.max(0, Number(holding.amount) - sellVolume);
            if (holding.amount <= DUST_AMOUNT_THRESHOLD) {
              portfolio.holdings.delete(data.coin);
            }
          }
          // 전략 포지션도 업데이트 (통계 집계용)
          const strategyObj = getStrategyFor(tradingSystem, data.coin);
          if (strategyObj?.currentPosition) {
            if (isFullSell) {
              // 전량 매도 시 포지션 종료 (수익 계산 포함)
              strategyObj.closePosition(currentPrice, '스마트 매도');
            } else {
              // 부분 매도 시 recordPartialSell 사용 (수익 기록 포함)
              strategyObj.recordPartialSell(currentPrice, sellVolume, '스마트 매도');
            }
          }
        }
      } else {
        const legIntentId = attachLegIntent ? await attachLegIntent(`sell:${data.coin}`) : null;
        if (!legIntentId) {
          liveFailures.push({
            coin: data.coin,
            reason: 'leg_intent_unavailable',
            orderDispatched: false
          });
          continue;
        }
        const liveExecution = await executeLiveOrderWithEvidence(tradingSystem, {
          market: data.coin,
          side: 'ask',
          volume: sellVolume,
          orderType: 'market',
          requested: { volume: sellVolume },
          referencePrice: currentPrice,
          clientIntentId: legIntentId
        });
        executionFill = liveExecution.fill;
        if (!hasCompleteObservedLiveFill(liveExecution)) {
          liveFailures.push({
            coin: data.coin,
            fill: executionFill,
            reason: liveExecution.reason || executionFill?.error || 'fill_not_observed'
          });
          continue;
        }
        executedPrice = executionFill.averagePrice;
        executedVolume = executionFill.executedVolume;
        executedFee = executionFill.paidFee;
        executedSellAmount = executedPrice * executedVolume;
        executedNetSellAmount = executedSellAmount - executedFee;
        executedSellRatio = data.holding.amount > 0
          ? executedVolume / data.holding.amount
          : sellRatio;
        const liveAverageEntryPrice = Number(currentHolding.avgPrice);
        executedProfit = Number.isFinite(liveAverageEntryPrice) && liveAverageEntryPrice > 0
          ? (executedPrice - liveAverageEntryPrice) * executedVolume - executedFee
          : (data.profit * executedSellRatio) - executedFee;
        executedProfitPercent = Number.isFinite(liveAverageEntryPrice) && liveAverageEntryPrice > 0
          ? ((executedPrice / liveAverageEntryPrice) - 1) * 100
          : data.profitPercent;
        // 실제 체결된 수량/가격만 전략 포지션에 반영한다.
        const isFullSell = (currentHolding.amount - executedVolume) <= DUST_AMOUNT_THRESHOLD;
        const strategyObj = getStrategyFor(tradingSystem, data.coin);
        if (strategyObj?.currentPosition) {
          if (isFullSell) {
            strategyObj.closePosition(executedPrice, '스마트 매도');
          } else {
            // 부분 매도 시 실제 체결 수량만 기록한다.
            strategyObj.recordPartialSell(executedPrice, executedVolume, '스마트 매도');
          }
        }
      }

      totalSellAmount += isDryRun ? netSellAmount : executedNetSellAmount;
      remainingTarget -= executedSellAmount; // 실제 gross 체결액 기준으로 차감

      const tradeRecord = {
        coin: data.coin,
        volume: executedVolume,
        price: executedPrice,
        grossAmount: roundQuoteAmount(tradingSystem, executedSellAmount),
        fee: roundQuoteAmount(tradingSystem, executedFee),
        amount: roundQuoteAmount(tradingSystem, executedNetSellAmount),
        profit: roundQuoteAmount(tradingSystem, executedProfit),
        profitPercent: Number(executedProfitPercent).toFixed(2),
        type: 'SELL',
        source: 'smart-sell',
        timestamp: new Date().toISOString(),
        fill: executionFill
      };
      orders.push(tradeRecord);
      // 스마트 거래 이력 저장
      appendSmartTradeHistory(tradingSystem, tradeRecord);
    }

    if (isDryRun && tradingSystem.saveVirtualPortfolio) {
      tradingSystem.saveVirtualPortfolio();
    }

    const sellWasAdjusted = targetAmount > totalHoldingValue;
    const responseStatus = liveFailures.length > 0
      ? orders.length === 0 ? 409 : 207
      : 200;
    return {
      status: responseStatus,
      body: {
        success: liveFailures.length === 0,
        mode: isDryRun ? 'DRY_RUN' : 'LIVE',
        targetAmount,
        actualTargetAmount: roundQuoteAmount(tradingSystem, actualTargetAmount),
        totalHoldingValue: roundQuoteAmount(tradingSystem, totalHoldingValue),
        amountWasAdjusted: sellWasAdjusted,
        strategy,
        totalReceived: roundQuoteAmount(tradingSystem, totalSellAmount),
        trades: orders,
        failures: liveFailures,
        message: liveFailures.length > 0
          ? `${orders.length}건 체결 · ${liveFailures.length}건 미체결/실패. 미체결 주문은 전략 포지션과 손익에 반영하지 않았습니다.`
          : sellWasAdjusted
          ? `${orders.length}개 코인에서 ${formatQuoteAmount(tradingSystem, totalSellAmount)} 매도 완료 (목표 ${formatQuoteAmount(tradingSystem, targetAmount)} → 최대 보유액 ${formatQuoteAmount(tradingSystem, totalHoldingValue)}으로 조절)`
          : `${orders.length}개 코인에서 ${formatQuoteAmount(tradingSystem, totalSellAmount)} 매도 완료`
      }
    };
  }

  return smartSell;
}
