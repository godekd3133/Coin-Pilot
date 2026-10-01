import { MARKET_DATA_FRESHNESS } from './marketDataProvider.js';
import { API_READ_QUERY_LIMITS, parseBoundedIntegerQuery } from './queryLimits.js';
import { baseOfMarket, marketsForQuote, quoteOfSystem } from '../exchange/marketCodes.js';

/**
 * 대시보드 분석 화면의 read-model 쿼리. 표시 전용이며 전략 인스턴스의
 * 신호 식별자를 소비하지 않는다 (자동매매와 동일한 반등 계약은
 * buildTechnicalAnalysis의 순수 기술적 분석 결과로만 표시한다).
 * 각 메서드는 {status, body}를 반환한다.
 */
export function createMarketAnalysisQueries({ tradingSystem, marketDataProvider }) {
  const readFreshTickers = markets => marketDataProvider.getTickers(markets, {
    freshness: MARKET_DATA_FRESHNESS.FRESH
  });
  const readMinuteCandles = (...args) => marketDataProvider.getMinuteCandles(...args);

  const readKrwBalance = async () => {
    try {
      const accounts = await tradingSystem.getAccountInfo();
      return tradingSystem.getKRWBalance(accounts) || 0;
    } catch (e) {
      console.error('잔액 조회 실패:', e.message);
      return 0;
    }
  };

  // 보유 포지션 확인 (매도 추천용) - 실전/드라이 모드 모두 지원
  const readHoldings = async () => {
    const holdings = new Map();
    if (tradingSystem.dryRun) {
      const holdingsData = tradingSystem.virtualPortfolio?.holdings;
      const holdingsEntries = holdingsData instanceof Map
        ? Array.from(holdingsData.entries())
        : Object.entries(holdingsData || {});
      for (const [coin, holding] of holdingsEntries) {
        if (holding.amount > 0) {
          holdings.set(coin, holding);
        }
      }
      return holdings;
    }
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
    return holdings;
  };

  async function coinAnalysis() {
    if (!tradingSystem.upbit) {
      return { status: 200, body: { recommendations: [], message: '거래 시스템 미초기화' } };
    }

    const krwBalance = await readKrwBalance();
    const holdings = await readHoldings();

    // 자동매매와 동일한 반등 계약을 대시보드에서도 보여준다.
    // 전략 인스턴스의 makeDecision()을 호출하면 신호 식별자를 소비할 수
    // 있으므로, 순수 기술적 분석만 사용해 표시용 결과를 만든다.
    if (tradingSystem.isScalpingMode) {
      const targetCoins = tradingSystem.targetCoins || [];
      const tickers = await readFreshTickers(targetCoins);
      const recommendations = [];

      for (const ticker of tickers || []) {
        const coin = ticker.market;
        try {
          const candles = await readMinuteCandles(
            coin,
            tradingSystem.candleUnit,
            tradingSystem.candleCount
          );
          const analysis = tradingSystem.buildTechnicalAnalysis(candles);
          const rebound = analysis?.indicators?.rebound;
          if (!rebound?.available) continue;

          const holding = holdings.get(coin);
          const hasPosition = !!holding;
          let action = 'WAIT';
          if (rebound.reboundConfirmed && !hasPosition) action = 'BUY_DELAYED';
          if (hasPosition) action = 'HOLD';

          recommendations.push({
            coin,
            action,
            category: action === 'BUY_DELAYED' ? 'OVERSOLD_REBOUND' : 'SCALPING_WAIT',
            currentPrice: ticker.trade_price,
            confidence: rebound.reboundConfirmed ? 80 : 0,
            reason: rebound.reboundConfirmed
              ? `과매도 후 반등 확인, ${tradingSystem.entryDelayMinMs}~${tradingSystem.entryDelayMaxMs}ms 지연 재검증 예정`
              : rebound.oversold
                ? '과매도 확인 - 양봉 반등과 RSI 회복 대기'
                : '과매도 반응 신호 없음',
            indicators: {
              rsi: rebound.rsi?.toFixed(2),
              previousRsi: rebound.previousRsi?.toFixed(2),
              rsiRecovery: rebound.rsiRecovery?.toFixed(2),
              reboundPercent: rebound.priceChangePercent?.toFixed(2),
              reboundConfirmed: rebound.reboundConfirmed
            },
            hasPosition,
            avgPrice: holding?.avgPrice,
            profitPercent: hasPosition && holding.avgPrice
              ? (((ticker.trade_price - holding.avgPrice) / holding.avgPrice) * 100).toFixed(2)
              : null
          });
        } catch {
          // 개별 마켓 표시 오류는 전체 대시보드 응답을 막지 않는다.
        }
      }

      recommendations.sort((a, b) => {
        if (a.action === 'BUY_DELAYED' && b.action !== 'BUY_DELAYED') return -1;
        if (a.action !== 'BUY_DELAYED' && b.action === 'BUY_DELAYED') return 1;
        return 0;
      });

      return {
        status: 200,
        body: {
          strategyMode: tradingSystem.strategyMode,
          recommendations,
          analyzedCoins: targetCoins.length,
          totalMarkets: targetCoins.length,
          krwBalance,
          categories: {
            OVERSOLD_REBOUND: '과매도 후 반등 확인 - 지연 재검증 대상',
            SCALPING_WAIT: '과매도 반응 대기'
          },
          note: '표시용 분석이며 실제 주문은 자동매매 루프에서 지연 후 다시 검증합니다.',
          timestamp: new Date().toISOString()
        }
      };
    }

    // 전체 KRW 마켓에서 기회 탐색 (레거시 종합점수 경로)
    const markets = await marketDataProvider.getMarkets();
    const krwMarkets = marketsForQuote(markets, quoteOfSystem(tradingSystem));
    const { comprehensiveAnalysis } = await import('../analysis/technicalIndicators.js');
    const tickers = await readFreshTickers(krwMarkets);

    // 거래량 기준 정렬 및 통계
    const sortedByVolume = [...tickers].sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h);
    const medianVolume = sortedByVolume[Math.floor(sortedByVolume.length / 2)]?.acc_trade_price_24h || 0;

    // 상위 50개 분석 (리스크 있는 코인도 포함하기 위해 확장)
    const topCoins = sortedByVolume.slice(0, 50).map(t => t.market);
    const recommendations = [];

    for (const coin of topCoins) {
      try {
        const ticker = tickers.find(t => t.market === coin);
        const currentPrice = ticker.trade_price;
        const volume24h = ticker.acc_trade_price_24h;
        const change24h = ticker.signed_change_rate * 100;

        // 캔들 데이터
        const candles = await readMinuteCandles(coin, 5, 100);
        if (!candles || candles.length < 50) continue;

        // 기술적 분석
        const analysis = comprehensiveAnalysis(candles, {
          rsiPeriod: tradingSystem.config.rsiPeriod || 14,
          rsiOversold: tradingSystem.config.rsiOversold || 30,
          rsiOverbought: tradingSystem.config.rsiOverbought || 70
        });

        if (!analysis?.indicators) continue;

        const rsi = analysis.indicators.rsi;
        const macd = analysis.indicators.macd;
        const bb = analysis.indicators.bollingerBands;

        // ===== 리스크 요소 평가 =====
        const riskFactors = [];
        let riskScore = 0;

        // 1. 거래량 리스크 (유동성)
        const volumeRank = sortedByVolume.findIndex(t => t.market === coin) + 1;
        if (volume24h < medianVolume * 0.3) {
          riskFactors.push(`거래량 매우 적음 (${volumeRank}위)`);
          riskScore += 30;
        } else if (volume24h < medianVolume * 0.7) {
          riskFactors.push(`거래량 적음 (${volumeRank}위)`);
          riskScore += 15;
        }

        // 2. 변동성 리스크
        const highLowRange = ((ticker.high_price - ticker.low_price) / ticker.low_price) * 100;
        if (highLowRange > 15) {
          riskFactors.push(`고변동성 (일중 ${highLowRange.toFixed(1)}%)`);
          riskScore += 25;
        } else if (highLowRange > 10) {
          riskFactors.push(`변동성 높음 (일중 ${highLowRange.toFixed(1)}%)`);
          riskScore += 12;
        }

        // 3. 급격한 가격 변동
        if (Math.abs(change24h) > 15) {
          riskFactors.push(`급변동 (24h ${change24h > 0 ? '+' : ''}${change24h.toFixed(1)}%)`);
          riskScore += 30;
        } else if (Math.abs(change24h) > 10) {
          riskFactors.push(`큰 변동 (24h ${change24h > 0 ? '+' : ''}${change24h.toFixed(1)}%)`);
          riskScore += 15;
        }

        // ===== 매수/매도 신호 점수 계산 =====
        let buyScore = 0;
        let sellScore = 0;
        const buyReasons = [];
        const sellReasons = [];
        const uncertainReasons = [];

        // RSI 분석
        if (rsi < 25) {
          buyScore += 40;
          buyReasons.push(`RSI 극과매도(${rsi.toFixed(1)})`);
        } else if (rsi < 30) {
          buyScore += 35;
          buyReasons.push(`RSI 과매도(${rsi.toFixed(1)})`);
        } else if (rsi < 40) {
          buyScore += 20;
          buyReasons.push(`RSI 낮음(${rsi.toFixed(1)})`);
        } else if (rsi > 75) {
          sellScore += 40;
          sellReasons.push(`RSI 극과매수(${rsi.toFixed(1)})`);
        } else if (rsi > 70) {
          sellScore += 35;
          sellReasons.push(`RSI 과매수(${rsi.toFixed(1)})`);
        } else if (rsi > 60) {
          sellScore += 20;
          sellReasons.push(`RSI 높음(${rsi.toFixed(1)})`);
        } else {
          uncertainReasons.push(`RSI 중립(${rsi.toFixed(1)})`);
        }

        // MACD 분석
        if (macd?.histogram > 0 && macd?.macdLine > macd?.signalLine) {
          buyScore += 25;
          buyReasons.push('MACD 상승세');
        } else if (macd?.histogram < 0 && macd?.macdLine < macd?.signalLine) {
          sellScore += 25;
          sellReasons.push('MACD 하락세');
        } else if (Math.abs(macd?.histogram || 0) < 50) {
          uncertainReasons.push('MACD 교차 임박');
        }

        // 볼린저 밴드
        if (bb?.percentB !== undefined) {
          if (bb.percentB < 0.05) {
            buyScore += 25;
            buyReasons.push('하단밴드 이탈');
          } else if (bb.percentB < 0.1) {
            buyScore += 20;
            buyReasons.push('하단밴드 터치');
          } else if (bb.percentB > 0.95) {
            sellScore += 25;
            sellReasons.push('상단밴드 이탈');
          } else if (bb.percentB > 0.9) {
            sellScore += 20;
            sellReasons.push('상단밴드 터치');
          } else if (bb.percentB > 0.3 && bb.percentB < 0.7) {
            uncertainReasons.push(`밴드 중간(${(bb.percentB * 100).toFixed(0)}%)`);
          }
        }

        // 24시간 변동률
        if (change24h < -8) {
          buyScore += 20;
          buyReasons.push(`24h ${change24h.toFixed(1)}% 급락`);
        } else if (change24h < -5) {
          buyScore += 15;
          buyReasons.push(`24h ${change24h.toFixed(1)}% 하락`);
        } else if (change24h > 12) {
          sellScore += 20;
          sellReasons.push(`24h +${change24h.toFixed(1)}% 급등`);
        } else if (change24h > 8) {
          sellScore += 15;
          sellReasons.push(`24h +${change24h.toFixed(1)}% 급등`);
        } else if (change24h > -2 && change24h < 2) {
          uncertainReasons.push(`24h ${change24h >= 0 ? '+' : ''}${change24h.toFixed(1)}% 횡보`);
        }

        // 보유 중인 코인 체크
        const holding = holdings.get(coin);
        const hasPosition = !!holding;

        // ===== 애매한 경우 판단 (확장된 기준) =====
        const scoreDiff = Math.abs(buyScore - sellScore);
        const maxScore = Math.max(buyScore, sellScore);
        const hasRisk = riskScore >= 20;
        const hasStrongSignal = maxScore >= 55;

        // 케이스 1: 약한 신호
        const isWeakSignal = (
          (buyScore >= 20 && buyScore < 55 && sellScore < 20) ||
          (sellScore >= 20 && sellScore < 55 && buyScore < 20)
        );

        // 케이스 2: 혼조세 (매수/매도 신호 비슷)
        const isMixedSignal = (buyScore >= 20 && sellScore >= 20 && scoreDiff < 25);

        // 케이스 3: 강한 신호 + 리스크 요소 (기회이지만 주의 필요!)
        const isHighRiskOpportunity = (hasStrongSignal && hasRisk);

        // 케이스 4: 중간 신호 + 리스크
        const isMediumRiskSignal = (maxScore >= 35 && maxScore < 55 && riskScore >= 15);

        const shouldRecommend = isWeakSignal || isMixedSignal || isHighRiskOpportunity || isMediumRiskSignal;
        if (!shouldRecommend) continue;

        // 추천 타입 결정
        let action, confidence, reasons;
        let category = 'UNCERTAIN';

        if (isHighRiskOpportunity) {
          // 강한 신호 + 리스크
          if (buyScore > sellScore) {
            action = hasPosition ? 'HOLD_RISKY' : 'BUY_RISKY';
            category = 'HIGH_RISK_OPPORTUNITY';
          } else {
            action = hasPosition ? 'SELL_RISKY' : 'AVOID';
            category = 'HIGH_RISK_WARNING';
          }
          confidence = maxScore;
          reasons = buyScore > sellScore
            ? [...buyReasons, ...riskFactors]
            : [...sellReasons, ...riskFactors];
        } else if (isMixedSignal) {
          action = hasPosition ? 'HOLD_OR_SELL' : 'HOLD_OR_BUY';
          category = 'MIXED_SIGNAL';
          confidence = maxScore;
          reasons = [...buyReasons, ...sellReasons, ...uncertainReasons];
        } else if (isWeakSignal || isMediumRiskSignal) {
          if (buyScore > sellScore && !hasPosition && krwBalance > 5000) {
            action = hasRisk ? 'BUY_CAUTIOUS' : 'BUY_CONSIDER';
            category = hasRisk ? 'RISKY_BUY' : 'WEAK_BUY';
          } else if (sellScore > buyScore && hasPosition) {
            action = hasRisk ? 'SELL_CAUTIOUS' : 'SELL_CONSIDER';
            category = hasRisk ? 'RISKY_SELL' : 'WEAK_SELL';
          } else {
            continue;
          }
          confidence = maxScore;
          reasons = buyScore > sellScore
            ? [...buyReasons, ...uncertainReasons, ...riskFactors]
            : [...sellReasons, ...uncertainReasons, ...riskFactors];
        } else {
          continue;
        }

        // 제안 금액 계산 (리스크에 따라 조절)
        let suggestedAmount, suggestedQuantity;
        const riskMultiplier = hasRisk ? 0.5 : 1;
        if (action.includes('BUY')) {
          suggestedAmount = Math.floor(krwBalance * 0.1 * riskMultiplier);
          suggestedAmount = Math.max(5000, Math.min(suggestedAmount, krwBalance * 0.15));
          suggestedQuantity = suggestedAmount / currentPrice;
        } else if (hasPosition) {
          suggestedAmount = Math.floor(holding.amount * currentPrice * 0.5 * riskMultiplier);
          suggestedQuantity = holding.amount * 0.5 * riskMultiplier;
        }

        recommendations.push({
          coin,
          action,
          category,
          currentPrice,
          confidence,
          riskScore,
          riskFactors: riskFactors.slice(0, 3),
          reason: reasons.slice(0, 4).join(' | ') || '복합 신호',
          uncertaintyNote: `매수: ${buyScore}점 | 매도: ${sellScore}점 | 리스크: ${riskScore}점`,
          suggestedAmount: suggestedAmount ? Math.floor(suggestedAmount) : null,
          suggestedQuantity: suggestedQuantity?.toFixed(8),
          indicators: {
            rsi: rsi?.toFixed(1),
            macd: macd?.histogram?.toFixed(2),
            bb: bb?.percentB?.toFixed(2),
            buyScore,
            sellScore,
            riskScore
          },
          change24h: change24h.toFixed(2),
          highLowRange: highLowRange.toFixed(2),
          volume24h,
          volumeRank,
          hasPosition,
          avgPrice: holding?.avgPrice,
          profitPercent: hasPosition ? (((currentPrice - holding.avgPrice) / holding.avgPrice) * 100).toFixed(2) : null
        });

        // API 속도 제한 방지
        await new Promise(r => setTimeout(r, 50));
      } catch {
        // 개별 코인 오류는 무시
      }
    }

    // 정렬: 리스크 기회 > 혼조세 > 약한 신호 순
    const categoryOrder = {
      'HIGH_RISK_OPPORTUNITY': 1,
      'HIGH_RISK_WARNING': 2,
      'MIXED_SIGNAL': 3,
      'RISKY_BUY': 4,
      'RISKY_SELL': 4,
      'WEAK_BUY': 5,
      'WEAK_SELL': 5
    };
    recommendations.sort((a, b) => {
      const catDiff = (categoryOrder[a.category] || 10) - (categoryOrder[b.category] || 10);
      if (catDiff !== 0) return catDiff;
      return b.confidence - a.confidence;
    });

    return {
      status: 200,
      body: {
        recommendations: recommendations.slice(0, 15),
        analyzedCoins: 50,
        totalMarkets: krwMarkets.length,
        krwBalance,
        categories: {
          HIGH_RISK_OPPORTUNITY: '강한 신호 + 리스크 (기회/주의)',
          MIXED_SIGNAL: '혼조세 (매수/매도 신호 혼재)',
          RISKY_BUY: '매수 고려 (리스크 있음)',
          RISKY_SELL: '매도 고려 (리스크 있음)',
          WEAK_BUY: '약한 매수 신호',
          WEAK_SELL: '약한 매도 신호'
        },
        note: '신호는 좋지만 리스크 요소가 있는 코인, 혼조세 코인 등 사용자 판단이 필요한 경우를 표시합니다.',
        timestamp: new Date().toISOString()
      }
    };
  }

  // 전체 코인 AI 평가 점수 (Analysis 탭용)
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

  // 매수/매도 추천 (임계값 근접 코인 + 투자금액 제안)
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

  return {
    coinAnalysis,
    allCoinScores,
    tradingRecommendations
  };
}
