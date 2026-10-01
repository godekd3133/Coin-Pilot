// 전체 코인 점수 read-model — marketAnalysisQueries.js에서 추출.
import { API_READ_QUERY_LIMITS, parseBoundedIntegerQuery } from './queryLimits.js';
import { baseOfMarket, marketsForQuote, quoteOfSystem } from '../exchange/marketCodes.js';

export function createMarketAnalysisScoresQuery(ctx) {
  const { tradingSystem, marketDataProvider, readFreshTickers, readMinuteCandles } = ctx;

  async function allCoinScores({ limit } = {}) {
    if (!tradingSystem.upbit) {
      return { status: 200, body: { coins: [], message: '거래 시스템 미초기화' } };
    }

    const { comprehensiveAnalysis } = await import('../analysis/technicalIndicators.js');

    // 전체 KRW 마켓
    const markets = await marketDataProvider.getMarkets();
    const krwMarkets = marketsForQuote(markets, quoteOfSystem(tradingSystem));
    const tickers = await readFreshTickers(krwMarkets);

    // 거래량 기준 정렬
    const sortedByVolume = [...tickers].sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h);

    // 상위 limit개 코인 분석
    const resolvedLimit = parseBoundedIntegerQuery(limit, API_READ_QUERY_LIMITS.allCoinScores);
    const topCoins = sortedByVolume.slice(0, resolvedLimit);

    const coinScores = [];
    const buyThreshold = tradingSystem.config?.buyThreshold || 50;
    const sellThreshold = tradingSystem.config?.sellThreshold || 50;

    for (const ticker of topCoins) {
      try {
        const coin = ticker.market;
        const currentPrice = ticker.trade_price;
        const change24h = ticker.signed_change_rate * 100;
        const volume24h = ticker.acc_trade_price_24h;

        // 캔들 데이터
        const candles = await readMinuteCandles(coin, 5, 100);
        if (!candles || candles.length < 30) continue;

        // 기술적 분석
        const analysis = comprehensiveAnalysis(candles, {
          rsiPeriod: tradingSystem.config?.rsiPeriod || 14,
          rsiOversold: tradingSystem.config?.rsiOversold || 30,
          rsiOverbought: tradingSystem.config?.rsiOverbought || 70
        });

        if (!analysis?.indicators) continue;

        // comprehensiveAnalysis의 반환값 구조에 맞게 파싱
        const rsi = parseFloat(analysis.indicators.rsi) || 50;
        const macd = analysis.indicators.macd;
        const bb = analysis.indicators.bollingerBands;

        // BB percentB 계산 (current가 upper-lower 범위 내 어디에 있는지)
        let bbPercentB = 0.5;
        if (bb && bb.upper && bb.lower && bb.current) {
          const upper = parseFloat(bb.upper);
          const lower = parseFloat(bb.lower);
          const current = parseFloat(bb.current);
          if (upper !== lower) {
            bbPercentB = (current - lower) / (upper - lower);
          }
        }

        // MACD 값 파싱
        const macdHistogram = macd?.histogram ? parseFloat(macd.histogram) : 0;
        const macdValue = macd?.macd ? parseFloat(macd.macd) : 0;
        const macdSignalValue = macd?.signal ? parseFloat(macd.signal) : 0;

        // 매수/매도 점수 계산
        let buyScore = 0;
        let sellScore = 0;
        const signals = [];

        // RSI (숫자로 비교)
        if (rsi < 30) {
          buyScore += 35;
          signals.push(`RSI 과매도 (${rsi.toFixed(1)})`);
        } else if (rsi > 70) {
          sellScore += 35;
          signals.push(`RSI 과매수 (${rsi.toFixed(1)})`);
        }

        // MACD (파싱된 숫자로 비교)
        let macdSignal = 'NEUTRAL';
        if (macdHistogram > 0 && macdValue > macdSignalValue) {
          buyScore += 25;
          macdSignal = 'BULLISH';
          signals.push(`MACD 상승 (${macdHistogram.toFixed(2)})`);
        } else if (macdHistogram < 0 && macdValue < macdSignalValue) {
          sellScore += 25;
          macdSignal = 'BEARISH';
          signals.push(`MACD 하락 (${macdHistogram.toFixed(2)})`);
        }

        // 볼린저 밴드
        if (bbPercentB < 0.1) {
          buyScore += 20;
          signals.push(`BB 하단 터치 (${(bbPercentB * 100).toFixed(0)}%)`);
        } else if (bbPercentB > 0.9) {
          sellScore += 20;
          signals.push(`BB 상단 터치 (${(bbPercentB * 100).toFixed(0)}%)`);
        }

        // 24시간 변동률
        if (change24h < -5) {
          buyScore += 15;
          signals.push(`24H 급락 (${change24h.toFixed(1)}%)`);
        } else if (change24h > 8) {
          sellScore += 15;
          signals.push(`24H 급등 (+${change24h.toFixed(1)}%)`);
        }

        // 종합 점수 (기술적 분석 60% + 중립 뉴스 40%)
        const technicalScore = buyScore > sellScore ? 50 + (buyScore - sellScore) / 2 : 50 - (sellScore - buyScore) / 2;
        const totalScore = technicalScore * 0.6 + 50 * 0.4;

        // 추천 결정
        let recommendation = 'HOLD';
        let signalStrength = 'WEAK';
        if (buyScore > sellScore && buyScore >= 20) {
          recommendation = 'BUY';
          if (buyScore >= 60) signalStrength = 'VERY_STRONG';
          else if (buyScore >= 45) signalStrength = 'STRONG';
          else if (buyScore >= 30) signalStrength = 'MEDIUM';
          else signalStrength = 'WEAK';
        } else if (sellScore > buyScore && sellScore >= 20) {
          recommendation = 'SELL';
          if (sellScore >= 60) signalStrength = 'VERY_STRONG';
          else if (sellScore >= 45) signalStrength = 'STRONG';
          else if (sellScore >= 30) signalStrength = 'MEDIUM';
          else signalStrength = 'WEAK';
        }

        coinScores.push({
          coin,
          symbol: baseOfMarket(coin),
          currentPrice,
          change24h: change24h.toFixed(2),
          volume24h,
          indicators: {
            rsi,
            macdSignal,
            bbPercent: bbPercentB
          },
          buyScore,
          sellScore,
          totalScore: Math.round(totalScore),
          recommendation,
          signalStrength,
          signals
        });

        // API 속도 제한 (50ms)
        await new Promise(r => setTimeout(r, 50));
      } catch {
        // 개별 코인 분석 오류는 무시하고 다음으로
      }
    }

    // 총점 기준 정렬
    coinScores.sort((a, b) => b.totalScore - a.totalScore);

    return {
      status: 200,
      body: {
        coins: coinScores,
        totalAnalyzed: coinScores.length,
        totalMarkets: krwMarkets.length,
        thresholds: { buyThreshold, sellThreshold },
        timestamp: new Date().toISOString()
      }
    };
  }

  return allCoinScores;
}
