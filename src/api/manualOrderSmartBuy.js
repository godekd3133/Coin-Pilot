// /trade/smart-buy 스마트 분할 매수 use-case — manualOrderService.js에서 추출.
// 공유 의존(ctx)은 createManualOrderContext가 조립하고, leg 프리미티브는 manualOrderLegs에서 온다.
import {
  MANUAL_ORDER_FEE_RATE,
  MIN_BUY_KRW,
  getStrategyFor,
  readKrwBalance,
  reflectStrategyBuyFill
} from './manualOrderLegs.js';
import { appendSmartTradeHistory } from './smartTradeHistory.js';
import {
  executeLiveOrderWithEvidence,
  hasCompleteObservedLiveFill
} from './manualOrderExecution.js';
import { marketsForQuote, quoteOfSystem } from '../exchange/marketCodes.js';

export function createSmartBuyUseCase(ctx) {
  const { tradingSystem, marketDataProvider, inspectMarketQuote, marketQuoteBlockResult, readFreshTickers, readMinuteCandles } = ctx;

  async function smartBuy({ totalAmount, minScore = 60, maxCoins = 10 }, { attachLegIntent = null } = {}) {
    if (!totalAmount || totalAmount < MIN_BUY_KRW) {
      return { status: 400, body: { error: '최소 금액은 5,000원입니다', success: false } };
    }
    if (!tradingSystem.upbit) {
      return { status: 400, body: { error: '거래 시스템 미초기화', success: false } };
    }

    // 보유 현금 확인 및 자동 조절
    const availableBalance = await readKrwBalance(tradingSystem);

    // 요청 금액이 보유 현금을 초과하면 최대 가용 금액으로 자동 조절
    const originalAmount = totalAmount;
    let amountWasAdjusted = false;
    if (totalAmount > availableBalance * 0.98) { // 2% 여유분 확보
      totalAmount = Math.floor(availableBalance * 0.95); // 95%까지만 사용
      amountWasAdjusted = true;
      console.log(`⚠️ 스마트 매수 금액 자동 조절: ${originalAmount.toLocaleString()}원 → ${totalAmount.toLocaleString()}원 (보유: ${availableBalance.toLocaleString()}원)`);
    }
    if (totalAmount < MIN_BUY_KRW) {
      return {
        status: 400,
        body: {
          error: `보유 현금 부족 (${availableBalance.toLocaleString()}원). 최소 5,000원 이상 필요합니다.`,
          success: false,
          availableBalance
        }
      };
    }

    const { comprehensiveAnalysis } = await import('../analysis/technicalIndicators.js');

    // 상위 거래량 코인 분석 (상위 30개)
    const markets = await marketDataProvider.getMarkets();
    const krwMarkets = marketsForQuote(markets, quoteOfSystem(tradingSystem));
    const requestedTickers = await readFreshTickers(krwMarkets);
    const tickers = requestedTickers.filter(ticker =>
      inspectMarketQuote(ticker, ticker?.market).fresh
    );
    if (tickers.length === 0) {
      const quoteBlock = marketQuoteBlockResult(requestedTickers.map(ticker =>
        inspectMarketQuote(ticker, ticker?.market)
      ));
      return quoteBlock || {
        status: 409,
        body: {
          success: false,
          code: 'MARKET_QUOTE_UNAVAILABLE',
          message: '최근 시세를 확인할 수 있는 종목이 없어 주문을 보내지 않았습니다.'
        }
      };
    }
    const tickerByMarket = new Map(tickers.map(ticker => [ticker.market, ticker]));

    // 상위 30개 거래량 코인 분석
    const analyzeCount = Math.min(30, krwMarkets.length);
    const topCoins = tickers
      .sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h)
      .slice(0, analyzeCount)
      .map(t => t.market);

    // 각 코인 분석 및 점수 계산
    const coinScores = [];
    for (const coin of topCoins) {
      try {
        const ticker = tickers.find(t => t.market === coin);
        const candles = await readMinuteCandles(coin, 5, 100);
        if (!candles || candles.length < 50) continue;

        const analysis = comprehensiveAnalysis(candles, {
          rsiPeriod: tradingSystem.config.rsiPeriod || 14,
          rsiOversold: tradingSystem.config.rsiOversold || 30,
          rsiOverbought: tradingSystem.config.rsiOverbought || 70
        });
        if (!analysis?.indicators) continue;

        const rsi = typeof analysis.indicators.rsi === 'number' ? analysis.indicators.rsi : null;
        const macd = analysis.indicators.macd;
        const bb = analysis.indicators.bollingerBands;

        // 매수 적합도 점수
        let score = 50;
        if (rsi !== null) {
          if (rsi < 30) score += 25;
          else if (rsi < 40) score += 15;
          else if (rsi > 70) score -= 20;
        }
        if (macd?.histogram > 0 && macd?.macdLine > macd?.signalLine) score += 20;
        if (bb?.percentB < 0.2) score += 15;

        const change24h = ticker.signed_change_rate * 100;
        if (change24h < -3) score += 10;

        coinScores.push({
          coin,
          score,
          price: ticker.trade_price,
          change24h,
          rsi,
          volume: ticker.acc_trade_price_24h
        });
        await new Promise(r => setTimeout(r, 50));
      } catch {
        // 개별 코인 오류 무시
      }
    }

    // 점수 순 정렬
    coinScores.sort((a, b) => b.score - a.score);

    // 최소 점수 이상인 코인 선택 (maxCoins 제한 적용)
    let selectedCoins = coinScores.filter(c => c.score >= minScore);
    // 조건 충족 코인이 없으면 상위 3개 선택 (폴백)
    if (selectedCoins.length === 0) {
      selectedCoins = coinScores.slice(0, 3);
    }
    if (maxCoins > 0 && selectedCoins.length > maxCoins) {
      selectedCoins = selectedCoins.slice(0, maxCoins);
    }
    // 코인당 최소 5000원 이상 투자할 수 있는 개수로 제한
    const maxAffordable = Math.floor(totalAmount / MIN_BUY_KRW);
    if (selectedCoins.length > maxAffordable) {
      selectedCoins = selectedCoins.slice(0, maxAffordable);
    }

    const selectedQuoteBlock = marketQuoteBlockResult(selectedCoins.map(coinData =>
      inspectMarketQuote(tickerByMarket.get(coinData.coin), coinData.coin)
    ));
    if (selectedQuoteBlock) return selectedQuoteBlock;
    if (selectedCoins.length === 0) {
      return {
        status: 409,
        body: {
          success: false,
          code: 'NO_SMART_BUY_CANDIDATES',
          message: '주문 조건을 충족하는 종목이 없어 주문을 보내지 않았습니다.'
        }
      };
    }

    const amountPerCoin = Math.floor(totalAmount / selectedCoins.length);
    const orders = [];
    const liveFailures = [];
    const isDryRun = tradingSystem.dryRun;
    let runningBalance = availableBalance; // 실행 중 잔액 추적

    for (const coinData of selectedCoins) {
      if (amountPerCoin < MIN_BUY_KRW) continue;

      const dispatchQuoteCheck = inspectMarketQuote(tickerByMarket.get(coinData.coin), coinData.coin);
      if (!dispatchQuoteCheck.fresh) {
        liveFailures.push({ coin: coinData.coin, reason: dispatchQuoteCheck.reason, orderDispatched: false });
        continue;
      }

      // 실시간 잔액 체크 (마이너스 방지)
      if (isDryRun && runningBalance < amountPerCoin) {
        console.log(`⚠️ 잔액 부족으로 ${coinData.coin} 스킵 (필요: ${amountPerCoin}, 잔액: ${runningBalance})`);
        continue;
      }

      const fee = amountPerCoin * MANUAL_ORDER_FEE_RATE;
      const actualInvestment = amountPerCoin - fee;
      const volume = actualInvestment / coinData.price;
      let executedPrice = coinData.price;
      let executedVolume = volume;
      let executedFee = fee;
      let executionFill = null;

      if (isDryRun) {
        const portfolio = tradingSystem.virtualPortfolio;
        if (portfolio) {
          // 이중 안전장치: 실제 잔액 다시 확인
          const actualBalance = portfolio.krwBalance || 0;
          if (actualBalance < amountPerCoin) {
            console.log(`⚠️ 실제 잔액 부족으로 ${coinData.coin} 스킵`);
            continue;
          }
          portfolio.krwBalance = Math.max(0, actualBalance - amountPerCoin);
          runningBalance = portfolio.krwBalance; // 업데이트
          const existing = portfolio.holdings.get(coinData.coin) || { amount: 0, avgPrice: 0, entryTime: null };
          const newAmount = existing.amount + volume;
          const newAvgPrice = ((existing.amount * existing.avgPrice) + (volume * coinData.price)) / newAmount;
          portfolio.holdings.set(coinData.coin, {
            amount: newAmount,
            avgPrice: newAvgPrice,
            entryTime: existing.entryTime || new Date().toISOString()
          });
          reflectStrategyBuyFill(getStrategyFor(tradingSystem, coinData.coin), coinData.price, volume);
        }
      } else {
        const legIntentId = attachLegIntent ? await attachLegIntent(`buy:${coinData.coin}`) : null;
        if (!legIntentId) {
          liveFailures.push({
            coin: coinData.coin,
            reason: 'leg_intent_unavailable',
            orderDispatched: false
          });
          continue;
        }
        const liveExecution = await executeLiveOrderWithEvidence(tradingSystem, {
          market: coinData.coin,
          side: 'bid',
          volume: amountPerCoin,
          orderType: 'price',
          requested: { amount: amountPerCoin },
          referencePrice: coinData.price,
          clientIntentId: legIntentId
        });
        executionFill = liveExecution.fill;
        if (!hasCompleteObservedLiveFill(liveExecution)) {
          liveFailures.push({
            coin: coinData.coin,
            fill: executionFill,
            reason: liveExecution.reason || executionFill?.error || 'fill_not_observed'
          });
          continue;
        }
        executedPrice = executionFill.averagePrice;
        executedVolume = executionFill.executedVolume;
        executedFee = executionFill.paidFee;
        // 실제 체결된 수량/가격만 전략 포지션에 반영한다.
        reflectStrategyBuyFill(getStrategyFor(tradingSystem, coinData.coin), executedPrice, executedVolume);
      }

      const tradeRecord = {
        coin: coinData.coin,
        amount: isDryRun ? amountPerCoin : executedPrice * executedVolume + executedFee,
        price: executedPrice,
        volume: executedVolume,
        fee: executedFee,
        score: coinData.score,
        rsi: typeof coinData.rsi === 'number' ? coinData.rsi.toFixed(1) : '-',
        change24h: typeof coinData.change24h === 'number' ? coinData.change24h.toFixed(2) : '-',
        type: 'BUY',
        source: 'smart-buy',
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

    // 실제 투자된 총액 계산
    const totalInvested = orders.reduce((sum, o) => sum + o.amount, 0);
    const responseStatus = liveFailures.length > 0
      ? orders.length === 0 ? 409 : 207
      : 200;
    return {
      status: responseStatus,
      body: {
        success: liveFailures.length === 0,
        mode: isDryRun ? 'DRY_RUN' : 'LIVE',
        totalAmount,
        totalInvested,
        originalAmount,
        amountWasAdjusted,
        availableBalance,
        analyzedCoins: coinScores.length,
        qualifiedCoins: coinScores.filter(c => c.score >= minScore).length,
        trades: orders,
        failures: liveFailures,
        message: liveFailures.length > 0
          ? `${orders.length}개 체결 · ${liveFailures.length}개 미체결/실패. 체결되지 않은 주문은 전략 포지션에 반영하지 않았습니다.`
          : amountWasAdjusted
          ? `${orders.length}개 코인에 자동 매수 완료 (금액 자동 조절: ${originalAmount.toLocaleString()}원 → ${totalAmount.toLocaleString()}원)`
          : `${orders.length}개 코인에 자동 매수 완료 (점수 ${minScore}점 이상)`
      }
    };
  }

  return smartBuy;
}
