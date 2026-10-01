// 매수/매도 추천 read-model — marketAnalysisQueries.js에서 추출.
import { baseOfMarket, marketsForQuote, quoteOfSystem } from '../exchange/marketCodes.js';

export function createMarketAnalysisRecommendationsQuery(ctx) {
  const { tradingSystem, marketDataProvider, readFreshTickers, readMinuteCandles, readHoldings } = ctx;

  async function tradingRecommendations() {
    if (!tradingSystem.upbit) {
      return { status: 200, body: { buyRecommendations: [], sellRecommendations: [], message: '거래 시스템 미초기화' } };
    }

    const { comprehensiveAnalysis } = await import('../analysis/technicalIndicators.js');

    // 설정값 로드
    const config = tradingSystem.config || {};
    const buyThreshold = config.buyThreshold || 60;
    const sellThreshold = config.sellThreshold || 60;
    const investmentRatio = tradingSystem.investmentRatio || 0.05;

    // 총 자산 계산
    const totalAssets = await tradingSystem.calculateTotalAssets();
    const baseInvestment = totalAssets * investmentRatio;

    // KRW 잔액
    let krwBalance;
    if (tradingSystem.dryRun) {
      krwBalance = tradingSystem.virtualPortfolio?.krwBalance || 0;
    } else {
      const accounts = await tradingSystem.getAccountInfo();
      krwBalance = tradingSystem.getKRWBalance(accounts) || 0;
    }

    // 보유 포지션 조회
    const holdings = await readHoldings();

    // 전체 마켓 조회
    const markets = await marketDataProvider.getMarkets();
    const krwMarkets = marketsForQuote(markets, quoteOfSystem(tradingSystem));
    const tickers = await readFreshTickers(krwMarkets);

    // 거래량 기준 상위 50개 분석
    const sortedByVolume = [...tickers].sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h);
    const topCoins = sortedByVolume.slice(0, 50).map(t => t.market);

    const buyRecommendations = [];
    const sellRecommendations = [];

    for (const coin of topCoins) {
      try {
        const ticker = tickers.find(t => t.market === coin);
        const currentPrice = ticker.trade_price;
        const change24h = ticker.signed_change_rate * 100;
        const volume24h = ticker.acc_trade_price_24h;

        // 캔들 데이터
        const candles = await readMinuteCandles(coin, 5, 100);
        if (!candles || candles.length < 50) continue;

        // 기술적 분석
        const analysis = comprehensiveAnalysis(candles, {
          rsiPeriod: config.rsiPeriod || 14,
          rsiOversold: config.rsiOversold || 30,
          rsiOverbought: config.rsiOverbought || 70
        });

        if (!analysis?.indicators) continue;

        const rsi = analysis.indicators.rsi;
        const macd = analysis.indicators.macd;
        const bb = analysis.indicators.bollingerBands;

        // ===== 매수 점수 계산 =====
        let buyScore = 50; // 중립 시작
        const buySignals = [];

        // RSI
        if (rsi < 25) { buyScore += 25; buySignals.push(`RSI 극과매도(${rsi.toFixed(0)})`); }
        else if (rsi < 35) { buyScore += 20; buySignals.push(`RSI 과매도(${rsi.toFixed(0)})`); }
        else if (rsi < 45) { buyScore += 10; buySignals.push(`RSI 낮음(${rsi.toFixed(0)})`); }
        else if (rsi > 65) { buyScore -= 15; }

        // MACD
        if (macd?.histogram > 0) { buyScore += 15; buySignals.push('MACD 상승'); }
        else if (macd?.histogram < 0) { buyScore -= 10; }

        // 볼린저 밴드
        if (bb?.percentB < 0.1) { buyScore += 15; buySignals.push('BB 하단'); }
        else if (bb?.percentB < 0.25) { buyScore += 10; buySignals.push('BB 하단근접'); }
        else if (bb?.percentB > 0.85) { buyScore -= 15; }

        // 24시간 변동
        if (change24h < -8) { buyScore += 10; buySignals.push(`24h ${change24h.toFixed(1)}%`); }
        else if (change24h < -5) { buyScore += 5; buySignals.push(`24h ${change24h.toFixed(1)}%`); }

        // ===== 매도 점수 계산 (보유 코인용) =====
        let sellScore = 50;
        const sellSignals = [];

        if (rsi > 75) { sellScore += 25; sellSignals.push(`RSI 극과매수(${rsi.toFixed(0)})`); }
        else if (rsi > 65) { sellScore += 15; sellSignals.push(`RSI 과매수(${rsi.toFixed(0)})`); }
        else if (rsi > 55) { sellScore += 5; }
        else if (rsi < 35) { sellScore -= 15; }

        if (macd?.histogram < 0) { sellScore += 15; sellSignals.push('MACD 하락'); }
        else if (macd?.histogram > 0) { sellScore -= 10; }

        if (bb?.percentB > 0.95) { sellScore += 15; sellSignals.push('BB 상단이탈'); }
        else if (bb?.percentB > 0.85) { sellScore += 10; sellSignals.push('BB 상단근접'); }
        else if (bb?.percentB < 0.15) { sellScore -= 15; }

        if (change24h > 10) { sellScore += 10; sellSignals.push(`24h +${change24h.toFixed(1)}%`); }
        else if (change24h > 6) { sellScore += 5; }

        const holding = holdings.get(coin);
        const hasPosition = !!holding;

        // ===== 매수 추천 (임계값 근접) =====
        // buyThreshold의 70~95% 범위면 "지켜볼만한" 추천
        const buyThresholdLow = buyThreshold * 0.70;
        const proximityToBuy = Math.min(100, (buyScore / buyThreshold) * 100);

        if (!hasPosition && buyScore >= buyThresholdLow && buyScore < buyThreshold) {
          // 신호 강도에 따른 투자금액 계산
          let signalMultiplier = 0.8; // 기본 (WEAK)
          const scoreDiff = buyScore - buyThresholdLow;
          const range = buyThreshold - buyThresholdLow;
          const progressPercent = (scoreDiff / range) * 100;

          if (progressPercent >= 80) signalMultiplier = 1.5; // 거의 임계값
          else if (progressPercent >= 60) signalMultiplier = 1.2;
          else if (progressPercent >= 40) signalMultiplier = 1.0;

          const suggestedInvestment = Math.floor(baseInvestment * signalMultiplier);
          const cappedInvestment = Math.min(suggestedInvestment, krwBalance * 0.25);
          const finalInvestment = Math.max(5000, cappedInvestment);

          buyRecommendations.push({
            coin,
            symbol: baseOfMarket(coin),
            currentPrice,
            change24h: change24h.toFixed(2),
            volume24h,
            score: buyScore,
            threshold: buyThreshold,
            proximityPercent: proximityToBuy.toFixed(1),
            progressToThreshold: progressPercent.toFixed(0),
            signals: buySignals,
            indicators: {
              rsi: rsi.toFixed(1),
              macd: macd?.histogram?.toFixed(2) || 'N/A',
              bb: bb?.percentB?.toFixed(2) || 'N/A'
            },
            recommendation: progressPercent >= 60 ? 'WATCH_CLOSELY' : 'MONITOR',
            suggestedInvestment: finalInvestment,
            suggestedQuantity: (finalInvestment / currentPrice).toFixed(8),
            investmentNote: `총자산 ${(investmentRatio * 100).toFixed(0)}% × ${signalMultiplier}배 = ${finalInvestment.toLocaleString()}원`
          });
        }

        // ===== 매도 추천 (보유 코인 중 약세 신호) =====
        if (hasPosition) {
          const profitPercent = ((currentPrice - holding.avgPrice) / holding.avgPrice) * 100;
          const holdingValue = holding.amount * currentPrice;

          // 매도 점수가 임계값의 70~95%이면 추천
          const sellThresholdLow = sellThreshold * 0.70;
          const proximityToSell = Math.min(100, (sellScore / sellThreshold) * 100);

          // 수익 중이면서 매도 신호 근접, 또는 손실 중이면서 약세 신호
          const shouldRecommendSell = (
            (sellScore >= sellThresholdLow && sellScore < sellThreshold) ||
            (profitPercent < -3 && sellScore >= sellThresholdLow * 0.85)
          );

          if (shouldRecommendSell) {
            const scoreDiff = sellScore - sellThresholdLow;
            const range = sellThreshold - sellThresholdLow;
            const progressPercent = Math.max(0, (scoreDiff / range) * 100);

            // 매도 비율 계산 (신호 강도에 따라)
            let sellRatio = 0.3; // 기본 30%
            if (progressPercent >= 80) sellRatio = 0.7;
            else if (progressPercent >= 60) sellRatio = 0.5;
            else if (progressPercent >= 40) sellRatio = 0.4;

            // 손실 중이면 매도 비율 증가
            if (profitPercent < -5) sellRatio = Math.min(1.0, sellRatio + 0.2);

            const suggestedSellAmount = holding.amount * sellRatio;
            const suggestedSellValue = suggestedSellAmount * currentPrice;

            sellRecommendations.push({
              coin,
              symbol: baseOfMarket(coin),
              currentPrice,
              avgPrice: holding.avgPrice,
              holdingAmount: holding.amount,
              holdingValue: Math.round(holdingValue),
              profitPercent: profitPercent.toFixed(2),
              score: sellScore,
              threshold: sellThreshold,
              proximityPercent: proximityToSell.toFixed(1),
              progressToThreshold: progressPercent.toFixed(0),
              signals: sellSignals,
              indicators: {
                rsi: rsi.toFixed(1),
                macd: macd?.histogram?.toFixed(2) || 'N/A',
                bb: bb?.percentB?.toFixed(2) || 'N/A'
              },
              recommendation: profitPercent < -3 ? 'CONSIDER_STOP_LOSS' : (progressPercent >= 60 ? 'WATCH_CLOSELY' : 'MONITOR'),
              suggestedSellRatio: (sellRatio * 100).toFixed(0) + '%',
              suggestedSellAmount: suggestedSellAmount.toFixed(8),
              suggestedSellValue: Math.round(suggestedSellValue),
              sellNote: `보유량의 ${(sellRatio * 100).toFixed(0)}% 매도 권장`
            });
          }
        }

        await new Promise(r => setTimeout(r, 50));
      } catch {
        // 개별 코인 오류 무시
      }
    }

    // 정렬: 임계값에 가까운 순
    buyRecommendations.sort((a, b) => parseFloat(b.progressToThreshold) - parseFloat(a.progressToThreshold));
    sellRecommendations.sort((a, b) => parseFloat(b.progressToThreshold) - parseFloat(a.progressToThreshold));

    return {
      status: 200,
      body: {
        buyRecommendations: buyRecommendations.slice(0, 10),
        sellRecommendations: sellRecommendations.slice(0, 10),
        summary: {
          totalAssets: Math.round(totalAssets),
          krwBalance: Math.round(krwBalance),
          baseInvestment: Math.round(baseInvestment),
          investmentRatio: (investmentRatio * 100).toFixed(1) + '%',
          buyThreshold,
          sellThreshold,
          holdingsCount: holdings.size
        },
        legend: {
          WATCH_CLOSELY: '임계값 근접 - 주시 필요',
          MONITOR: '관심 종목 - 모니터링',
          CONSIDER_STOP_LOSS: '손절 고려 권장'
        },
        note: '매수/매도 임계값(threshold)의 70~95% 범위에 있는 코인들입니다. 실제 매매 전에 추가 분석을 권장합니다.',
        timestamp: new Date().toISOString()
      }
    };
  }

  return tradingRecommendations;
}
