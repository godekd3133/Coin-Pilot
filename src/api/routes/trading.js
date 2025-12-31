import express from 'express';

/**
 * 거래 관련 라우트 (분석, 매수/매도, 스마트 트레이딩, 번들)
 */
export default function createTradingRoutes(server) {
  const router = express.Router();

  // 코인 분석 (애매한 신호 포함)
  router.get('/coin-analysis', async (req, res) => {
    try {
      const recommendations = [];

      if (!server.tradingSystem.upbit) {
        return res.json({ recommendations: [], message: '거래 시스템 미초기화' });
      }

      // KRW 잔액 조회
      let krwBalance = 0;
      try {
        const accounts = await server.tradingSystem.getAccountInfo();
        krwBalance = server.tradingSystem.getKRWBalance(accounts) || 0;
      } catch (e) {
        console.error('잔액 조회 실패:', e.message);
      }

      // 보유 포지션 확인 (매도 추천용) - 실전/드라이 모드 모두 지원
      const holdings = new Map();
      if (server.tradingSystem.dryRun) {
        // 드라이 모드: 가상 포트폴리오에서 조회
        if (server.tradingSystem.virtualPortfolio?.holdings) {
          const holdingsData = server.tradingSystem.virtualPortfolio.holdings;
          const holdingsEntries = holdingsData instanceof Map
            ? Array.from(holdingsData.entries())
            : Object.entries(holdingsData || {});
          for (const [coin, holding] of holdingsEntries) {
            if (holding.amount > 0) {
              holdings.set(coin, holding);
            }
          }
        }
      } else {
        // 실전 모드: 실제 계좌에서 보유 코인 조회
        const accounts = await server.tradingSystem.getAccountInfo();
        for (const acc of accounts) {
          if (acc.currency !== 'KRW' && parseFloat(acc.balance) > 0) {
            holdings.set(`KRW-${acc.currency}`, {
              amount: parseFloat(acc.balance),
              avgPrice: parseFloat(acc.avg_buy_price) || 0
            });
          }
        }
      }

      // 전체 KRW 마켓에서 기회 탐색
      const markets = await server.tradingSystem.upbit.getMarkets();
      const krwMarkets = markets.filter(m => m.market.startsWith('KRW-')).map(m => m.market);

      const { comprehensiveAnalysis } = await import('../../analysis/technicalIndicators.js');

      // 상위 거래량 코인 우선 분석
      const tickers = await server.tradingSystem.upbit.getTicker(krwMarkets);

      // 거래량 기준 정렬 및 통계
      const sortedByVolume = [...tickers].sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h);
      const medianVolume = sortedByVolume[Math.floor(sortedByVolume.length / 2)]?.acc_trade_price_24h || 0;

      // 상위 50개 분석 (리스크 있는 코인도 포함하기 위해 확장)
      const topCoins = sortedByVolume.slice(0, 50).map(t => t.market);

      for (const coin of topCoins) {
        try {
          const ticker = tickers.find(t => t.market === coin);
          const currentPrice = ticker.trade_price;
          const volume24h = ticker.acc_trade_price_24h;
          const change24h = ticker.signed_change_rate * 100;

          // 캔들 데이터
          const candles = await server.tradingSystem.upbit.getMinuteCandles(coin, 5, 100);
          if (!candles || candles.length < 50) continue;

          // 기술적 분석
          const analysis = comprehensiveAnalysis(candles, {
            rsiPeriod: server.tradingSystem.config.rsiPeriod || 14,
            rsiOversold: server.tradingSystem.config.rsiOversold || 30,
            rsiOverbought: server.tradingSystem.config.rsiOverbought || 70
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
        } catch (coinError) {
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

      res.json({
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
      });
    } catch (error) {
      server.logApiError('/api/coin-analysis', error);
      res.status(500).json({ error: error.message });
    }
  });

  // 전체 코인 AI 평가 점수 조회 (Analysis 탭용)
  router.get('/all-coin-scores', async (req, res) => {
    try {
      if (!server.tradingSystem.upbit) {
        return res.json({ coins: [], message: '거래 시스템 미초기화' });
      }

      const { comprehensiveAnalysis } = await import('../../analysis/technicalIndicators.js');

      // 전체 KRW 마켓
      const markets = await server.tradingSystem.upbit.getMarkets();
      const krwMarkets = markets.filter(m => m.market.startsWith('KRW-')).map(m => m.market);
      const tickers = await server.tradingSystem.upbit.getTicker(krwMarkets);

      // 거래량 기준 정렬
      const sortedByVolume = [...tickers].sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h);

      // 상위 100개 코인 분석
      const limit = parseInt(req.query.limit) || 100;
      const topCoins = sortedByVolume.slice(0, limit);

      const coinScores = [];
      const buyThreshold = server.tradingSystem.config?.buyThreshold || 50;
      const sellThreshold = server.tradingSystem.config?.sellThreshold || 50;

      for (const ticker of topCoins) {
        try {
          const coin = ticker.market;
          const currentPrice = ticker.trade_price;
          const change24h = ticker.signed_change_rate * 100;
          const volume24h = ticker.acc_trade_price_24h;

          // 캔들 데이터
          const candles = await server.tradingSystem.upbit.getMinuteCandles(coin, 5, 100);
          if (!candles || candles.length < 30) continue;

          // 기술적 분석
          const analysis = comprehensiveAnalysis(candles, {
            rsiPeriod: server.tradingSystem.config?.rsiPeriod || 14,
            rsiOversold: server.tradingSystem.config?.rsiOversold || 30,
            rsiOverbought: server.tradingSystem.config?.rsiOverbought || 70
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
            symbol: coin.replace('KRW-', ''),
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
        } catch (e) {
          // 개별 코인 분석 오류는 무시하고 다음으로
        }
      }

      // 총점 기준 정렬
      coinScores.sort((a, b) => b.totalScore - a.totalScore);

      res.json({
        coins: coinScores,
        totalAnalyzed: coinScores.length,
        totalMarkets: krwMarkets.length,
        thresholds: { buyThreshold, sellThreshold },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      server.logApiError('/api/all-coin-scores', error);
      res.status(500).json({ error: error.message });
    }
  });

  // 번들 제안 조회 (A코인 매도 → B코인 매수 묶음)
  router.get('/bundle-suggestions', async (req, res) => {
    try {
      const bundles = await server.generateBundleSuggestions();

      res.json({
        bundles,
        count: bundles.length,
        note: '보유 코인 중 매도 신호가 있는 코인과, 매수 신호가 있는 코인을 묶어서 리밸런싱 제안을 합니다.',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      server.logApiError('/api/bundle-suggestions', error);
      res.status(500).json({ error: error.message });
    }
  });

  // 번들 제안 실행 (매도 후 매수)
  router.post('/trade/execute-bundle', express.json(), async (req, res) => {
    try {
      const { sellCoin, sellAmount, buyCoin, buyAmount } = req.body;

      if (!sellCoin || !buyCoin) {
        return res.status(400).json({ error: 'sellCoin과 buyCoin은 필수입니다', success: false });
      }

      const results = { sell: null, buy: null };
      const isDryRun = server.tradingSystem.dryRun;

      // 1. 매도 실행
      const sellTicker = await server.tradingSystem.upbit.getTicker(sellCoin);
      const sellPrice = sellTicker[0].trade_price;
      const holding = server.tradingSystem.virtualPortfolio?.holdings.get(sellCoin);
      const actualSellAmount = sellAmount || holding?.amount || 0;

      if (actualSellAmount <= 0) {
        return res.status(400).json({ error: '매도할 수량이 없습니다', success: false });
      }

      const sellValue = actualSellAmount * sellPrice;

      // 수수료율
      const FEE_RATE = 0.0005;

      if (isDryRun) {
        // 모의투자 매도 (수수료 적용)
        const sellFee = sellValue * FEE_RATE;
        const netSellValue = sellValue - sellFee;

        if (server.tradingSystem.virtualPortfolio) {
          server.tradingSystem.virtualPortfolio.krwBalance += netSellValue;
          const existingHolding = server.tradingSystem.virtualPortfolio.holdings.get(sellCoin);
          const isFullSell = existingHolding && (existingHolding.amount - actualSellAmount) <= 0.00000001;
          if (existingHolding) {
            existingHolding.amount -= actualSellAmount;
            if (existingHolding.amount <= 0.00000001) {
              server.tradingSystem.virtualPortfolio.holdings.delete(sellCoin);
            }
          }

          // 전략 포지션도 업데이트 (통계 집계용)
          const sellStrategy = server.tradingSystem.strategies?.get(sellCoin) ||
                               server.tradingSystem.getStrategy?.(sellCoin);
          if (sellStrategy && sellStrategy.currentPosition) {
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
        const sellOrder = await server.tradingSystem.upbit.order(sellCoin, 'ask', actualSellAmount, null, 'market');
        results.sell = { ...sellOrder, coin: sellCoin };

        // 전략 포지션도 업데이트 (통계 집계용) - LIVE 모드도 동일하게 처리
        const isFullSell = holding && (holding.amount - actualSellAmount) <= 0.00000001;
        const sellStrategy = server.tradingSystem.strategies?.get(sellCoin) ||
                             server.tradingSystem.getStrategy?.(sellCoin);
        if (sellStrategy && sellStrategy.currentPosition) {
          if (isFullSell) {
            sellStrategy.closePosition(sellPrice, '번들 매도');
          } else {
            // 부분 매도 시 recordPartialSell 사용 (수익 기록 포함)
            sellStrategy.recordPartialSell(sellPrice, actualSellAmount, '번들 매도');
          }
        }
      }

      // 2. 매수 실행
      const buyTicker = await server.tradingSystem.upbit.getTicker(buyCoin);
      const buyPrice = buyTicker[0].trade_price;
      // 매도 후 실제 잔액 기반으로 매수 (드라이런에서는 수수료 차감된 금액 사용)
      const availableForBuy = isDryRun ? results.sell.value : sellValue;
      const investAmount = buyAmount || Math.floor(availableForBuy * 0.95);

      if (isDryRun) {
        // 모의투자 매수 (수수료 적용)
        const buyFee = investAmount * FEE_RATE;
        const actualInvestment = investAmount - buyFee;
        const buyVolume = actualInvestment / buyPrice;

        if (server.tradingSystem.virtualPortfolio) {
          server.tradingSystem.virtualPortfolio.krwBalance -= investAmount;
          const existing = server.tradingSystem.virtualPortfolio.holdings.get(buyCoin) || { amount: 0, avgPrice: 0, entryTime: null };
          const newAmount = existing.amount + buyVolume;
          const newAvgPrice = ((existing.amount * existing.avgPrice) + (buyVolume * buyPrice)) / newAmount;
          server.tradingSystem.virtualPortfolio.holdings.set(buyCoin, {
            amount: newAmount,
            avgPrice: newAvgPrice,
            entryTime: existing.entryTime || new Date().toISOString()
          });

          // 전략 포지션도 업데이트 (통계 집계용)
          const buyStrategy = server.tradingSystem.strategies?.get(buyCoin) ||
                              server.tradingSystem.getStrategy?.(buyCoin);
          if (buyStrategy) {
            if (!buyStrategy.currentPosition) {
              buyStrategy.openPosition(buyPrice, buyVolume, 'BUY');
            } else {
              // 추가 매수 시 평균단가 업데이트
              const existingPos = buyStrategy.currentPosition;
              const totalAmount = existingPos.amount + buyVolume;
              const newAvgPricePos = ((existingPos.amount * existingPos.entryPrice) + (buyVolume * buyPrice)) / totalAmount;
              buyStrategy.currentPosition.amount = totalAmount;
              buyStrategy.currentPosition.entryPrice = newAvgPricePos;
            }
          }

          server.tradingSystem.saveVirtualPortfolio();
        }
        results.buy = { coin: buyCoin, amount: buyVolume, price: buyPrice, grossValue: investAmount, fee: buyFee, value: actualInvestment };
      } else {
        const buyOrder = await server.tradingSystem.upbit.order(buyCoin, 'bid', investAmount, null, 'price');
        results.buy = { ...buyOrder, coin: buyCoin };

        // 전략 포지션도 업데이트 (통계 집계용) - LIVE 모드도 동일하게 처리
        const buyFee = investAmount * FEE_RATE;
        const actualInvestment = investAmount - buyFee;
        const buyVolume = actualInvestment / buyPrice;
        const buyStrategy = server.tradingSystem.strategies?.get(buyCoin) ||
                            server.tradingSystem.getStrategy?.(buyCoin);
        if (buyStrategy) {
          if (!buyStrategy.currentPosition) {
            buyStrategy.openPosition(buyPrice, buyVolume, 'BUY');
          } else {
            const existingPos = buyStrategy.currentPosition;
            const totalAmount = existingPos.amount + buyVolume;
            const newAvgPricePos = ((existingPos.amount * existingPos.entryPrice) + (buyVolume * buyPrice)) / totalAmount;
            buyStrategy.currentPosition.amount = totalAmount;
            buyStrategy.currentPosition.entryPrice = newAvgPricePos;
          }
        }
      }

      // 스마트 거래 이력에 추가
      if (!server.tradingSystem.smartTradeHistory) {
        server.tradingSystem.smartTradeHistory = [];
      }
      server.tradingSystem.smartTradeHistory.push({
        type: 'BUNDLE_TRADE',
        sell: results.sell,
        buy: results.buy,
        timestamp: new Date().toISOString(),
        mode: isDryRun ? 'DRY_RUN' : 'LIVE'
      });

      res.json({
        success: true,
        message: `[${isDryRun ? '모의투자' : '실전'}] ${sellCoin.replace('KRW-', '')} 매도 → ${buyCoin.replace('KRW-', '')} 매수 완료`,
        results,
        mode: isDryRun ? 'DRY_RUN' : 'LIVE'
      });
    } catch (error) {
      server.logApiError('/api/trade/execute-bundle', error);
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // 수동 매매 실행
  router.post('/trade/execute', express.json(), async (req, res) => {
    try {
      const { coin, action, amount } = req.body;

      if (!coin || !action) {
        return res.status(400).json({ error: 'coin과 action은 필수입니다', success: false });
      }

      if (!['BUY', 'SELL'].includes(action.toUpperCase())) {
        return res.status(400).json({ error: 'action은 BUY 또는 SELL이어야 합니다', success: false });
      }

      if (!server.tradingSystem.upbit) {
        return res.status(400).json({ error: '거래 시스템이 초기화되지 않았습니다', success: false });
      }

      // 전략 가져오기 (없으면 동적 생성하여 통계 추적 보장)
      const strategy = server.tradingSystem.strategies?.get(coin) ||
                       server.tradingSystem.getStrategy?.(coin);
      const isDryRun = server.tradingSystem.dryRun;

      if (action.toUpperCase() === 'BUY') {
        const investmentAmount = amount || 50000;

        if (investmentAmount < 5000) {
          return res.status(400).json({ error: '최소 투자금액은 5000원입니다', success: false });
        }

        // 현재가 조회
        const ticker = await server.tradingSystem.upbit.getTicker(coin);
        const currentPrice = ticker[0].trade_price;

        if (isDryRun) {
          // 모의투자 - 가상 포트폴리오 업데이트
          // 수수료 계산 (0.05%)
          const FEE_RATE = 0.0005;
          const fee = investmentAmount * FEE_RATE;
          const actualInvestment = investmentAmount - fee;
          const actualVolume = actualInvestment / currentPrice;

          if (server.tradingSystem.virtualPortfolio) {
            // 잔액 체크 및 마이너스 방지
            const currentBalance = server.tradingSystem.virtualPortfolio.krwBalance || 0;
            if (currentBalance < investmentAmount) {
              return res.status(400).json({
                error: `잔액 부족 (보유: ${currentBalance.toLocaleString()}원, 요청: ${investmentAmount.toLocaleString()}원)`,
                success: false,
                availableBalance: currentBalance
              });
            }
            server.tradingSystem.virtualPortfolio.krwBalance = Math.max(0, currentBalance - investmentAmount);
            const existing = server.tradingSystem.virtualPortfolio.holdings.get(coin) || { amount: 0, avgPrice: 0, entryTime: null };
            const newAmount = existing.amount + actualVolume;
            const newAvgPrice = ((existing.amount * existing.avgPrice) + (actualVolume * currentPrice)) / newAmount;
            server.tradingSystem.virtualPortfolio.holdings.set(coin, {
              amount: newAmount,
              avgPrice: newAvgPrice,
              entryTime: existing.entryTime || new Date().toISOString()
            });
            server.tradingSystem.saveVirtualPortfolio();
          }
          if (strategy) {
            strategy.openPosition(currentPrice, actualVolume, 'BUY');
          }
          res.json({
            success: true,
            message: `[모의투자] ${coin} ${investmentAmount.toLocaleString()}원 매수 완료 (수수료 ${fee.toFixed(0)}원)`,
            order: {
              coin,
              action: 'BUY',
              price: currentPrice,
              volume: actualVolume,
              amount: investmentAmount,
              fee: fee,
              mode: 'DRY_RUN'
            }
          });
        } else {
          // 실전투자
          const order = await server.tradingSystem.upbit.order(coin, 'bid', investmentAmount, null, 'price');
          if (strategy) {
            // 수수료를 고려한 예상 체결량으로 포지션 기록 (DRY_RUN과 일관성 유지)
            const FEE_RATE = 0.0005;
            const estimatedVolume = (investmentAmount * (1 - FEE_RATE)) / currentPrice;
            strategy.openPosition(currentPrice, estimatedVolume, 'BUY');
          }
          res.json({
            success: true,
            message: `${coin} 매수 주문 완료`,
            order: {
              ...order,
              mode: 'LIVE'
            }
          });
        }
      } else {
        // SELL
        const accounts = await server.tradingSystem.getAccountInfo();
        const coinSymbol = coin.split('-')[1];
        const coinAccount = accounts.find(acc => acc.currency === coinSymbol);
        const coinBalance = coinAccount ? parseFloat(coinAccount.balance) : 0;

        const sellVolume = strategy?.currentPosition?.amount || coinBalance;

        if (sellVolume <= 0) {
          return res.status(400).json({ error: '매도할 수량이 없습니다', success: false });
        }

        // 현재가 조회
        const ticker = await server.tradingSystem.upbit.getTicker(coin);
        const currentPrice = ticker[0].trade_price;

        if (isDryRun) {
          // 모의투자 - 가상 포트폴리오 업데이트
          // 수수료 계산 (0.05%)
          const FEE_RATE = 0.0005;
          const grossSellAmount = sellVolume * currentPrice;
          const fee = grossSellAmount * FEE_RATE;
          const netSellAmount = grossSellAmount - fee;

          if (server.tradingSystem.virtualPortfolio) {
            server.tradingSystem.virtualPortfolio.krwBalance += netSellAmount;
            const holding = server.tradingSystem.virtualPortfolio.holdings.get(coin);
            if (holding) {
              holding.amount -= sellVolume;
              if (holding.amount <= 0.00000001) {
                server.tradingSystem.virtualPortfolio.holdings.delete(coin);
              }
            }
            server.tradingSystem.saveVirtualPortfolio();
          }
          if (strategy) {
            strategy.closePosition(currentPrice, '수동 매도');
          }
          res.json({
            success: true,
            message: `[모의투자] ${coin} ${sellVolume.toFixed(8)} 매도 완료 (+${netSellAmount.toLocaleString()}원, 수수료 ${fee.toFixed(0)}원)`,
            order: {
              coin,
              action: 'SELL',
              price: currentPrice,
              volume: sellVolume,
              grossAmount: grossSellAmount,
              fee: fee,
              amount: netSellAmount,
              mode: 'DRY_RUN'
            }
          });
        } else {
          // 실전투자
          const order = await server.tradingSystem.upbit.order(coin, 'ask', sellVolume, null, 'market');
          if (strategy) {
            strategy.closePosition(currentPrice, '수동 매도');
          }
          res.json({
            success: true,
            message: `${coin} 매도 주문 완료`,
            order: {
              ...order,
              mode: 'LIVE'
            }
          });
        }
      }
    } catch (error) {
      server.logApiError('/api/trade/execute', error, { coin: req.body?.coin, action: req.body?.action });
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // 스마트 자동 매수
  router.post('/trade/smart-buy', express.json(), async (req, res) => {
    try {
      let { totalAmount, minScore = 60, maxCoins = 10, strategy = 'score' } = req.body;

      if (!totalAmount || totalAmount < 5000) {
        return res.status(400).json({ error: '최소 금액은 5,000원입니다', success: false });
      }

      if (!server.tradingSystem.upbit) {
        return res.status(400).json({ error: '거래 시스템 미초기화', success: false });
      }

      // 보유 현금 확인 및 자동 조절
      let availableBalance;
      const isDryRunMode = server.tradingSystem.dryRun;

      if (isDryRunMode) {
        availableBalance = server.tradingSystem.virtualPortfolio?.krwBalance || 0;
      } else {
        const accounts = await server.tradingSystem.getAccountInfo();
        availableBalance = server.tradingSystem.getKRWBalance(accounts) || 0;
      }

      // 요청 금액이 보유 현금을 초과하면 최대 가용 금액으로 자동 조절
      const originalAmount = totalAmount;
      let amountWasAdjusted = false;

      if (totalAmount > availableBalance * 0.98) { // 2% 여유분 확보
        totalAmount = Math.floor(availableBalance * 0.95); // 95%까지만 사용
        amountWasAdjusted = true;
        console.log(`⚠️ 스마트 매수 금액 자동 조절: ${originalAmount.toLocaleString()}원 → ${totalAmount.toLocaleString()}원 (보유: ${availableBalance.toLocaleString()}원)`);
      }

      if (totalAmount < 5000) {
        return res.status(400).json({
          error: `보유 현금 부족 (${availableBalance.toLocaleString()}원). 최소 5,000원 이상 필요합니다.`,
          success: false,
          availableBalance
        });
      }

      const { comprehensiveAnalysis } = await import('../../analysis/technicalIndicators.js');

      // 상위 거래량 코인 분석 (상위 30개)
      const markets = await server.tradingSystem.upbit.getMarkets();
      const krwMarkets = markets.filter(m => m.market.startsWith('KRW-')).map(m => m.market);
      const tickers = await server.tradingSystem.upbit.getTicker(krwMarkets);

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
          const candles = await server.tradingSystem.upbit.getMinuteCandles(coin, 5, 100);
          if (!candles || candles.length < 50) continue;

          const analysis = comprehensiveAnalysis(candles, {
            rsiPeriod: server.tradingSystem.config.rsiPeriod || 14,
            rsiOversold: server.tradingSystem.config.rsiOversold || 30,
            rsiOverbought: server.tradingSystem.config.rsiOverbought || 70
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
        } catch (e) {
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

      // maxCoins 제한 적용
      if (maxCoins > 0 && selectedCoins.length > maxCoins) {
        selectedCoins = selectedCoins.slice(0, maxCoins);
      }

      // 코인당 최소 5000원 이상 투자할 수 있는 개수로 제한
      const maxAffordable = Math.floor(totalAmount / 5000);
      if (selectedCoins.length > maxAffordable) {
        selectedCoins = selectedCoins.slice(0, maxAffordable);
      }

      const amountPerCoin = Math.floor(totalAmount / selectedCoins.length);

      const orders = [];
      const isDryRun = server.tradingSystem.dryRun;
      let runningBalance = availableBalance; // 실행 중 잔액 추적

      for (const coinData of selectedCoins) {
        if (amountPerCoin < 5000) continue;

        // 실시간 잔액 체크 (마이너스 방지)
        if (isDryRun && runningBalance < amountPerCoin) {
          console.log(`⚠️ 잔액 부족으로 ${coinData.coin} 스킵 (필요: ${amountPerCoin}, 잔액: ${runningBalance})`);
          continue;
        }

        // 수수료 적용 (0.05%)
        const FEE_RATE = 0.0005;
        const fee = amountPerCoin * FEE_RATE;
        const actualInvestment = amountPerCoin - fee;
        const volume = actualInvestment / coinData.price;

        if (isDryRun) {
          // 모의투자 (수수료 적용)
          if (server.tradingSystem.virtualPortfolio) {
            // 이중 안전장치: 실제 잔액 다시 확인
            const actualBalance = server.tradingSystem.virtualPortfolio.krwBalance || 0;
            if (actualBalance < amountPerCoin) {
              console.log(`⚠️ 실제 잔액 부족으로 ${coinData.coin} 스킵`);
              continue;
            }
            server.tradingSystem.virtualPortfolio.krwBalance = Math.max(0, actualBalance - amountPerCoin);
            runningBalance = server.tradingSystem.virtualPortfolio.krwBalance; // 업데이트
            const existing = server.tradingSystem.virtualPortfolio.holdings.get(coinData.coin) || { amount: 0, avgPrice: 0, entryTime: null };
            const newAmount = existing.amount + volume;
            const newAvgPrice = ((existing.amount * existing.avgPrice) + (volume * coinData.price)) / newAmount;
            server.tradingSystem.virtualPortfolio.holdings.set(coinData.coin, {
              amount: newAmount,
              avgPrice: newAvgPrice,
              entryTime: existing.entryTime || new Date().toISOString()
            });

            // 전략 포지션도 업데이트 (통계 집계용)
            const strategy = server.tradingSystem.strategies?.get(coinData.coin) ||
                             server.tradingSystem.getStrategy?.(coinData.coin);
            if (strategy) {
              if (!strategy.currentPosition) {
                // 기존 포지션이 없으면 새로 열기
                strategy.openPosition(coinData.price, volume, 'BUY');
              } else {
                // 기존 포지션이 있으면 평균단가 업데이트 (추가 매수)
                const existingPos = strategy.currentPosition;
                const totalAmount = existingPos.amount + volume;
                const newAvgPricePos = ((existingPos.amount * existingPos.entryPrice) + (volume * coinData.price)) / totalAmount;
                strategy.currentPosition.amount = totalAmount;
                strategy.currentPosition.entryPrice = newAvgPricePos;
              }
            }
          }
        } else {
          // 실전투자
          await server.tradingSystem.upbit.order(coinData.coin, 'bid', amountPerCoin, null, 'price');

          // 전략 포지션도 업데이트 (통계 집계용) - LIVE 모드도 동일하게 처리
          const strategy = server.tradingSystem.strategies?.get(coinData.coin) ||
                           server.tradingSystem.getStrategy?.(coinData.coin);
          if (strategy) {
            if (!strategy.currentPosition) {
              strategy.openPosition(coinData.price, volume, 'BUY');
            } else {
              const existingPos = strategy.currentPosition;
              const totalAmountPos = existingPos.amount + volume;
              const newAvgPricePos = ((existingPos.amount * existingPos.entryPrice) + (volume * coinData.price)) / totalAmountPos;
              strategy.currentPosition.amount = totalAmountPos;
              strategy.currentPosition.entryPrice = newAvgPricePos;
            }
          }
        }

        const tradeRecord = {
          coin: coinData.coin,
          amount: amountPerCoin,
          price: coinData.price,
          volume,
          score: coinData.score,
          rsi: typeof coinData.rsi === 'number' ? coinData.rsi.toFixed(1) : '-',
          change24h: typeof coinData.change24h === 'number' ? coinData.change24h.toFixed(2) : '-',
          type: 'BUY',
          source: 'smart-buy',
          timestamp: new Date().toISOString()
        };

        orders.push(tradeRecord);

        // 스마트 거래 이력 저장
        if (!server.tradingSystem.smartTradeHistory) {
          server.tradingSystem.smartTradeHistory = [];
        }
        server.tradingSystem.smartTradeHistory.unshift(tradeRecord);
        // 최대 100개 유지
        if (server.tradingSystem.smartTradeHistory.length > 100) {
          server.tradingSystem.smartTradeHistory = server.tradingSystem.smartTradeHistory.slice(0, 100);
        }
      }

      if (isDryRun && server.tradingSystem.saveVirtualPortfolio) {
        server.tradingSystem.saveVirtualPortfolio();
      }

      // 실제 투자된 총액 계산
      const totalInvested = orders.reduce((sum, o) => sum + o.amount, 0);

      res.json({
        success: true,
        mode: isDryRun ? 'DRY_RUN' : 'LIVE',
        totalAmount,
        totalInvested,
        originalAmount,
        amountWasAdjusted,
        availableBalance,
        analyzedCoins: coinScores.length,
        qualifiedCoins: coinScores.filter(c => c.score >= minScore).length,
        trades: orders,
        message: amountWasAdjusted
          ? `${orders.length}개 코인에 자동 매수 완료 (금액 자동 조절: ${originalAmount.toLocaleString()}원 → ${totalAmount.toLocaleString()}원)`
          : `${orders.length}개 코인에 자동 매수 완료 (점수 ${minScore}점 이상)`
      });
    } catch (error) {
      server.logApiError('/api/trade/smart-buy', error, { totalAmount: req.body?.totalAmount });
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // 스마트 자동 매도 (목표 금액만큼 분할 매도)
  router.post('/trade/smart-sell', express.json(), async (req, res) => {
    try {
      const { targetAmount, strategy = 'worst' } = req.body; // targetAmount: 목표 매도 금액 (KRW)

      if (!targetAmount || targetAmount < 1000) {
        return res.status(400).json({ error: '목표 매도 금액은 최소 1,000원 이상이어야 합니다', success: false });
      }

      if (!server.tradingSystem.upbit) {
        return res.status(400).json({ error: '거래 시스템 미초기화', success: false });
      }

      // 실전/드라이 모드에 따라 보유 코인 조회
      let holdings = new Map();
      const isDryRunMode = server.tradingSystem.dryRun;

      if (isDryRunMode) {
        // 드라이 모드: 가상 포트폴리오에서 조회
        holdings = server.tradingSystem.virtualPortfolio?.holdings || new Map();
      } else {
        // 실전 모드: 실제 계좌에서 보유 코인 조회
        const accounts = await server.tradingSystem.getAccountInfo();
        for (const acc of accounts) {
          if (acc.currency !== 'KRW' && parseFloat(acc.balance) > 0) {
            holdings.set(`KRW-${acc.currency}`, {
              amount: parseFloat(acc.balance),
              avgPrice: parseFloat(acc.avg_buy_price) || 0
            });
          }
        }
      }

      if (holdings.size === 0) {
        return res.status(400).json({ error: '보유 중인 코인이 없습니다', success: false });
      }

      const { comprehensiveAnalysis } = await import('../../analysis/technicalIndicators.js');

      // 보유 코인 분석
      const holdingCoins = Array.from(holdings.keys());
      const tickers = await server.tradingSystem.upbit.getTicker(holdingCoins);

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
          const candles = await server.tradingSystem.upbit.getMinuteCandles(coin, 5, 50);
          if (candles && candles.length >= 30) {
            const analysis = comprehensiveAnalysis(candles, {});
            rsi = analysis?.indicators?.rsi || 50;
          }
        } catch (e) {}

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

      const orders = [];
      const isDryRun = server.tradingSystem.dryRun;
      let totalSellAmount = 0;
      let remainingTarget = actualTargetAmount;

      for (const data of coinAnalysis) {
        if (remainingTarget <= 0) break;

        // 이 코인에서 얼마나 매도할지 결정
        let sellAmount;
        if (data.currentValue <= remainingTarget) {
          // 전량 매도
          sellAmount = data.currentValue;
        } else {
          // 일부만 매도
          sellAmount = remainingTarget;
        }

        if (sellAmount < 1000) continue; // 최소 금액

        const sellRatio = sellAmount / data.currentValue;
        const sellVolume = data.holding.amount * sellRatio;

        // 수수료 적용 (0.05%)
        const FEE_RATE = 0.0005;
        const fee = sellAmount * FEE_RATE;
        const netSellAmount = sellAmount - fee;

        if (isDryRun) {
          // 모의투자 (수수료 적용)
          if (server.tradingSystem.virtualPortfolio) {
            server.tradingSystem.virtualPortfolio.krwBalance += netSellAmount;
            const holding = server.tradingSystem.virtualPortfolio.holdings.get(data.coin);
            const isFullSell = holding && (holding.amount - sellVolume) <= 0.00000001;
            if (holding) {
              holding.amount -= sellVolume;
              if (holding.amount <= 0.00000001) {
                server.tradingSystem.virtualPortfolio.holdings.delete(data.coin);
              }
            }

            // 전략 포지션도 업데이트 (통계 집계용)
            const strategy = server.tradingSystem.strategies?.get(data.coin) ||
                             server.tradingSystem.getStrategy?.(data.coin);
            if (strategy && strategy.currentPosition) {
              if (isFullSell) {
                // 전량 매도 시 포지션 종료 (수익 계산 포함)
                strategy.closePosition(data.currentPrice, '스마트 매도');
              } else {
                // 부분 매도 시 recordPartialSell 사용 (수익 기록 포함)
                strategy.recordPartialSell(data.currentPrice, sellVolume, '스마트 매도');
              }
            }
          }
        } else {
          // 실전투자
          await server.tradingSystem.upbit.order(data.coin, 'ask', sellVolume, null, 'market');

          // 전략 포지션도 업데이트 (통계 집계용) - LIVE 모드도 동일하게 처리
          const isFullSell = (data.holding.amount - sellVolume) <= 0.00000001;
          const strategyObj = server.tradingSystem.strategies?.get(data.coin) ||
                           server.tradingSystem.getStrategy?.(data.coin);
          if (strategyObj && strategyObj.currentPosition) {
            if (isFullSell) {
              strategyObj.closePosition(data.currentPrice, '스마트 매도');
            } else {
              // 부분 매도 시 recordPartialSell 사용 (수익 기록 포함)
              strategyObj.recordPartialSell(data.currentPrice, sellVolume, '스마트 매도');
            }
          }
        }

        totalSellAmount += netSellAmount;
        remainingTarget -= sellAmount; // 목표는 gross 금액 기준으로 차감

        const tradeRecord = {
          coin: data.coin,
          volume: sellVolume,
          price: data.currentPrice,
          grossAmount: Math.round(sellAmount),
          fee: Math.round(fee),
          amount: Math.round(netSellAmount),
          profit: Math.round((data.profit * sellRatio) - fee),
          profitPercent: data.profitPercent.toFixed(2),
          type: 'SELL',
          source: 'smart-sell',
          timestamp: new Date().toISOString()
        };

        orders.push(tradeRecord);

        // 스마트 거래 이력 저장
        if (!server.tradingSystem.smartTradeHistory) {
          server.tradingSystem.smartTradeHistory = [];
        }
        server.tradingSystem.smartTradeHistory.unshift(tradeRecord);
        if (server.tradingSystem.smartTradeHistory.length > 100) {
          server.tradingSystem.smartTradeHistory = server.tradingSystem.smartTradeHistory.slice(0, 100);
        }
      }

      if (isDryRun && server.tradingSystem.saveVirtualPortfolio) {
        server.tradingSystem.saveVirtualPortfolio();
      }

      const sellWasAdjusted = targetAmount > totalHoldingValue;

      res.json({
        success: true,
        mode: isDryRun ? 'DRY_RUN' : 'LIVE',
        targetAmount,
        actualTargetAmount: Math.round(actualTargetAmount),
        totalHoldingValue: Math.round(totalHoldingValue),
        amountWasAdjusted: sellWasAdjusted,
        strategy,
        totalReceived: Math.round(totalSellAmount),
        trades: orders,
        message: sellWasAdjusted
          ? `${orders.length}개 코인에서 ${Math.round(totalSellAmount).toLocaleString()}원 매도 완료 (목표 ${targetAmount.toLocaleString()}원 → 최대 보유액 ${Math.round(totalHoldingValue).toLocaleString()}원으로 조절)`
          : `${orders.length}개 코인에서 ${Math.round(totalSellAmount).toLocaleString()}원 매도 완료`
      });
    } catch (error) {
      server.logApiError('/api/trade/smart-sell', error, { targetAmount: req.body?.targetAmount });
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // 즉시 단일 코인 매수/매도
  router.post('/trade/quick', express.json(), async (req, res) => {
    try {
      const { coin, action, amount } = req.body;

      if (!coin || !action || !amount) {
        return res.status(400).json({ error: 'coin, action, amount 필수', success: false });
      }

      if (action === 'BUY' && amount < 5000) {
        return res.status(400).json({ error: '최소 매수 금액은 5,000원입니다', success: false });
      }

      const ticker = await server.tradingSystem.upbit.getTicker(coin);
      const currentPrice = ticker[0].trade_price;
      const isDryRun = server.tradingSystem.dryRun;

      if (action === 'BUY') {
        // 보유 현금 확인 및 자동 조절
        let buyAmount = amount;
        let buyWasAdjusted = false;
        let availableBalance;

        if (isDryRun) {
          availableBalance = server.tradingSystem.virtualPortfolio?.krwBalance || 0;
        } else {
          const accounts = await server.tradingSystem.getAccountInfo();
          availableBalance = server.tradingSystem.getKRWBalance(accounts) || 0;
        }

        // 금액이 보유 현금을 초과하면 최대 가용 금액으로 자동 조절
        if (buyAmount > availableBalance * 0.98) {
          buyAmount = Math.floor(availableBalance * 0.95);
          buyWasAdjusted = true;
          console.log(`⚠️ 빠른 매수 금액 자동 조절: ${amount.toLocaleString()}원 → ${buyAmount.toLocaleString()}원`);
        }

        if (buyAmount < 5000) {
          return res.status(400).json({
            error: `보유 현금 부족 (${availableBalance.toLocaleString()}원). 최소 5,000원 이상 필요합니다.`,
            success: false,
            availableBalance
          });
        }

        // 수수료 적용 (0.05%)
        const FEE_RATE = 0.0005;
        const fee = buyAmount * FEE_RATE;
        const actualInvestment = buyAmount - fee;
        const volume = actualInvestment / currentPrice;

        if (isDryRun) {
          if (server.tradingSystem.virtualPortfolio) {
            // 마이너스 방지: 차감 직전 최종 확인
            const currentBalance = server.tradingSystem.virtualPortfolio.krwBalance || 0;
            if (currentBalance < buyAmount) {
              return res.status(400).json({
                error: `잔액 부족 (보유: ${currentBalance.toLocaleString()}원, 요청: ${buyAmount.toLocaleString()}원)`,
                success: false,
                availableBalance: currentBalance
              });
            }
            server.tradingSystem.virtualPortfolio.krwBalance = Math.max(0, currentBalance - buyAmount);
            const existing = server.tradingSystem.virtualPortfolio.holdings.get(coin) || { amount: 0, avgPrice: 0, entryTime: null };
            const newAmount = existing.amount + volume;
            const newAvgPrice = ((existing.amount * existing.avgPrice) + (volume * currentPrice)) / newAmount;
            server.tradingSystem.virtualPortfolio.holdings.set(coin, {
              amount: newAmount,
              avgPrice: newAvgPrice,
              entryTime: existing.entryTime || new Date().toISOString()
            });

            // 전략 포지션도 업데이트 (통계 집계용)
            const strategy = server.tradingSystem.strategies?.get(coin) ||
                             server.tradingSystem.getStrategy?.(coin);
            if (strategy) {
              if (!strategy.currentPosition) {
                strategy.openPosition(currentPrice, volume, 'BUY');
              } else {
                // 추가 매수 시 평균단가 업데이트
                const existingPos = strategy.currentPosition;
                const totalAmount = existingPos.amount + volume;
                const newAvgPricePos = ((existingPos.amount * existingPos.entryPrice) + (volume * currentPrice)) / totalAmount;
                strategy.currentPosition.amount = totalAmount;
                strategy.currentPosition.entryPrice = newAvgPricePos;
              }
            }

            server.tradingSystem.saveVirtualPortfolio();
          }
        } else {
          await server.tradingSystem.upbit.order(coin, 'bid', buyAmount, null, 'price');

          // 전략 포지션도 업데이트 (통계 집계용) - LIVE 모드도 동일하게 처리
          const strategy = server.tradingSystem.strategies?.get(coin) ||
                           server.tradingSystem.getStrategy?.(coin);
          if (strategy) {
            if (!strategy.currentPosition) {
              strategy.openPosition(currentPrice, volume, 'BUY');
            } else {
              const existingPos = strategy.currentPosition;
              const totalAmount = existingPos.amount + volume;
              const newAvgPricePos = ((existingPos.amount * existingPos.entryPrice) + (volume * currentPrice)) / totalAmount;
              strategy.currentPosition.amount = totalAmount;
              strategy.currentPosition.entryPrice = newAvgPricePos;
            }
          }
        }

        res.json({
          success: true,
          mode: isDryRun ? 'DRY_RUN' : 'LIVE',
          action: 'BUY',
          coin,
          amount: buyAmount,
          fee: fee,
          originalAmount: amount,
          amountWasAdjusted: buyWasAdjusted,
          price: currentPrice,
          volume,
          message: buyWasAdjusted
            ? `매수 완료 (금액 자동 조절: ${amount.toLocaleString()}원 → ${buyAmount.toLocaleString()}원, 수수료 ${fee.toFixed(0)}원)`
            : `매수 완료 (수수료 ${fee.toFixed(0)}원)`
        });
      } else {
        // SELL
        const holding = server.tradingSystem.virtualPortfolio?.holdings?.get(coin);
        if (!holding || holding.amount <= 0) {
          return res.status(400).json({ error: '보유 수량이 없습니다', success: false });
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

        const grossSellAmount = sellVolume * currentPrice;

        // 수수료 적용 (0.05%)
        const FEE_RATE = 0.0005;
        const fee = grossSellAmount * FEE_RATE;
        const netSellAmount = grossSellAmount - fee;

        if (isDryRun) {
          const isFullSell = (holding.amount - sellVolume) <= 0.00000001;
          server.tradingSystem.virtualPortfolio.krwBalance += netSellAmount;
          holding.amount -= sellVolume;
          if (holding.amount <= 0.00000001) {
            server.tradingSystem.virtualPortfolio.holdings.delete(coin);
          }

          // 전략 포지션도 업데이트 (통계 집계용)
          const strategy = server.tradingSystem.strategies?.get(coin) ||
                           server.tradingSystem.getStrategy?.(coin);
          if (strategy && strategy.currentPosition) {
            if (isFullSell) {
              strategy.closePosition(currentPrice, '빠른 매도');
            } else {
              // 부분 매도 시 recordPartialSell 사용 (수익 기록 포함)
              strategy.recordPartialSell(currentPrice, sellVolume, '빠른 매도');
            }
          }

          server.tradingSystem.saveVirtualPortfolio();
        } else {
          await server.tradingSystem.upbit.order(coin, 'ask', sellVolume, null, 'market');

          // 전략 포지션도 업데이트 (통계 집계용) - LIVE 모드도 동일하게 처리
          const isFullSell = (holding.amount - sellVolume) <= 0.00000001;
          const strategy = server.tradingSystem.strategies?.get(coin) ||
                           server.tradingSystem.getStrategy?.(coin);
          if (strategy && strategy.currentPosition) {
            if (isFullSell) {
              strategy.closePosition(currentPrice, '빠른 매도');
            } else {
              // 부분 매도 시 recordPartialSell 사용 (수익 기록 포함)
              strategy.recordPartialSell(currentPrice, sellVolume, '빠른 매도');
            }
          }
        }

        res.json({
          success: true,
          mode: isDryRun ? 'DRY_RUN' : 'LIVE',
          action: 'SELL',
          coin,
          volume: sellVolume,
          price: currentPrice,
          grossAmount: grossSellAmount,
          fee: fee,
          amount: netSellAmount,
          originalAmount: amount,
          amountWasAdjusted: sellWasAdjusted,
          maxHoldingValue: Math.round(maxHoldingValue),
          message: sellWasAdjusted
            ? `매도 완료 (최대 보유액 ${Math.round(maxHoldingValue).toLocaleString()}원으로 조절, 수수료 ${fee.toFixed(0)}원)`
            : `매도 완료 (수수료 ${fee.toFixed(0)}원)`
        });
      }
    } catch (error) {
      server.logApiError('/api/trade/quick', error, { coin: req.body?.coin, action: req.body?.action });
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // 개별 코인 수동 매수
  router.post('/trade/buy', express.json(), async (req, res) => {
    try {
      const { coin, amount } = req.body;

      if (!coin || !amount) {
        return res.status(400).json({ error: 'coin과 amount는 필수입니다', success: false });
      }

      if (amount < 5000) {
        return res.status(400).json({ error: '최소 매수 금액은 5,000원입니다', success: false });
      }

      const ticker = await server.tradingSystem.upbit.getTicker(coin);
      const currentPrice = ticker[0].trade_price;
      const isDryRun = server.tradingSystem.dryRun;

      // 수수료 적용 (0.05%)
      const FEE_RATE = 0.0005;
      const fee = amount * FEE_RATE;
      const actualInvestment = amount - fee;
      const volume = actualInvestment / currentPrice;

      if (isDryRun) {
        // 드라이 모드 (수수료 적용)
        if (server.tradingSystem.virtualPortfolio) {
          const currentBalance = server.tradingSystem.virtualPortfolio.krwBalance || 0;
          if (currentBalance < amount) {
            return res.status(400).json({
              error: `잔액 부족 (보유: ${currentBalance.toLocaleString()}원)`,
              success: false
            });
          }
          server.tradingSystem.virtualPortfolio.krwBalance = Math.max(0, currentBalance - amount);
          const existing = server.tradingSystem.virtualPortfolio.holdings.get(coin) || { amount: 0, avgPrice: 0, entryTime: null };
          const newAmount = existing.amount + volume;
          const newAvgPrice = ((existing.amount * existing.avgPrice) + (volume * currentPrice)) / newAmount;
          server.tradingSystem.virtualPortfolio.holdings.set(coin, {
            amount: newAmount,
            avgPrice: newAvgPrice,
            entryTime: existing.entryTime || new Date().toISOString()
          });

          // 전략 포지션도 업데이트 (통계 집계용)
          const strategy = server.tradingSystem.strategies?.get(coin) ||
                           server.tradingSystem.getStrategy?.(coin);
          if (strategy) {
            if (!strategy.currentPosition) {
              strategy.openPosition(currentPrice, volume, 'BUY');
            } else {
              // 추가 매수 시 평균단가 업데이트
              const existingPos = strategy.currentPosition;
              const totalAmount = existingPos.amount + volume;
              const newAvgPricePos = ((existingPos.amount * existingPos.entryPrice) + (volume * currentPrice)) / totalAmount;
              strategy.currentPosition.amount = totalAmount;
              strategy.currentPosition.entryPrice = newAvgPricePos;
            }
          }

          server.tradingSystem.saveVirtualPortfolio();
        }
      } else {
        // 실전 모드
        await server.tradingSystem.upbit.order(coin, 'bid', amount, null, 'price');

        // 전략 포지션도 업데이트 (통계 집계용) - LIVE 모드도 동일하게 처리
        const strategy = server.tradingSystem.strategies?.get(coin) ||
                         server.tradingSystem.getStrategy?.(coin);
        if (strategy) {
          if (!strategy.currentPosition) {
            strategy.openPosition(currentPrice, volume, 'BUY');
          } else {
            // 추가 매수 시 평균단가 업데이트
            const existingPos = strategy.currentPosition;
            const totalAmount = existingPos.amount + volume;
            const newAvgPricePos = ((existingPos.amount * existingPos.entryPrice) + (volume * currentPrice)) / totalAmount;
            strategy.currentPosition.amount = totalAmount;
            strategy.currentPosition.entryPrice = newAvgPricePos;
          }
        }
      }

      res.json({
        success: true,
        mode: isDryRun ? 'DRY_RUN' : 'LIVE',
        coin,
        amount,
        fee,
        price: currentPrice,
        volume
      });
    } catch (error) {
      server.logApiError('/api/trade/buy', error, { coin: req.body?.coin, amount: req.body?.amount });
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // 개별 코인 수동 매도 (수량 지정)
  router.post('/trade/sell', express.json(), async (req, res) => {
    try {
      const { coin, quantity } = req.body;

      if (!coin || !quantity) {
        return res.status(400).json({ error: 'coin과 quantity는 필수입니다', success: false });
      }

      const ticker = await server.tradingSystem.upbit.getTicker(coin);
      const currentPrice = ticker[0].trade_price;
      const isDryRun = server.tradingSystem.dryRun;

      // 보유량 확인
      let holding;
      if (isDryRun) {
        holding = server.tradingSystem.virtualPortfolio?.holdings?.get(coin);
      } else {
        const accounts = await server.tradingSystem.getAccountInfo();
        const coinSymbol = coin.split('-')[1];
        const coinAccount = accounts.find(acc => acc.currency === coinSymbol);
        if (coinAccount) {
          holding = { amount: parseFloat(coinAccount.balance), avgPrice: parseFloat(coinAccount.avg_buy_price) || 0 };
        }
      }

      if (!holding || holding.amount <= 0) {
        return res.status(400).json({ error: '보유 수량이 없습니다', success: false });
      }

      const sellVolume = Math.min(quantity, holding.amount);
      const grossSellAmount = sellVolume * currentPrice;

      // 수수료 적용 (0.05%)
      const FEE_RATE = 0.0005;
      const fee = grossSellAmount * FEE_RATE;
      const netSellAmount = grossSellAmount - fee;

      if (isDryRun) {
        if (server.tradingSystem.virtualPortfolio) {
          const remaining = holding.amount - sellVolume;
          const isFullSell = remaining <= 0.00000001;

          server.tradingSystem.virtualPortfolio.krwBalance = (server.tradingSystem.virtualPortfolio.krwBalance || 0) + netSellAmount;
          if (isFullSell) {
            server.tradingSystem.virtualPortfolio.holdings.delete(coin);
          } else {
            server.tradingSystem.virtualPortfolio.holdings.set(coin, {
              amount: remaining,
              avgPrice: holding.avgPrice,
              entryTime: holding.entryTime
            });
          }

          // 전략 포지션도 업데이트 (통계 집계용)
          const strategy = server.tradingSystem.strategies?.get(coin) ||
                           server.tradingSystem.getStrategy?.(coin);
          if (strategy && strategy.currentPosition) {
            if (isFullSell) {
              strategy.closePosition(currentPrice, '수동 매도');
            } else {
              // 부분 매도 시 recordPartialSell 사용 (수익 기록 포함)
              strategy.recordPartialSell(currentPrice, sellVolume, '수동 매도');
            }
          }

          server.tradingSystem.saveVirtualPortfolio();
        }
      } else {
        await server.tradingSystem.upbit.order(coin, 'ask', sellVolume, null, 'market');

        // 전략 포지션도 업데이트 (통계 집계용) - LIVE 모드도 동일하게 처리
        const remaining = holding.amount - sellVolume;
        const isFullSell = remaining <= 0.00000001;
        const strategy = server.tradingSystem.strategies?.get(coin) ||
                         server.tradingSystem.getStrategy?.(coin);
        if (strategy && strategy.currentPosition) {
          if (isFullSell) {
            strategy.closePosition(currentPrice, '수동 매도');
          } else {
            // 부분 매도 시 recordPartialSell 사용 (수익 기록 포함)
            strategy.recordPartialSell(currentPrice, sellVolume, '수동 매도');
          }
        }
      }

      res.json({
        success: true,
        mode: isDryRun ? 'DRY_RUN' : 'LIVE',
        coin,
        quantity: sellVolume,
        price: currentPrice,
        grossAmount: Math.round(grossSellAmount),
        fee: Math.round(fee),
        receivedAmount: Math.round(netSellAmount)
      });
    } catch (error) {
      server.logApiError('/api/trade/sell', error, { coin: req.body?.coin, quantity: req.body?.quantity });
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // ========================================
  // 매수/매도 추천 (임계값 근접 코인 + 투자금액 제안)
  // ========================================
  router.get('/trading-recommendations', async (req, res) => {
    try {
      if (!server.tradingSystem.upbit) {
        return res.json({ buyRecommendations: [], sellRecommendations: [], message: '거래 시스템 미초기화' });
      }

      const { comprehensiveAnalysis } = await import('../../analysis/technicalIndicators.js');

      // 설정값 로드
      const config = server.tradingSystem.config || {};
      const buyThreshold = config.buyThreshold || 60;
      const sellThreshold = config.sellThreshold || 60;
      const investmentRatio = server.tradingSystem.investmentRatio || 0.05;

      // 총 자산 계산
      const totalAssets = await server.tradingSystem.calculateTotalAssets();
      const baseInvestment = totalAssets * investmentRatio;

      // KRW 잔액
      let krwBalance = 0;
      if (server.tradingSystem.dryRun) {
        krwBalance = server.tradingSystem.virtualPortfolio?.krwBalance || 0;
      } else {
        const accounts = await server.tradingSystem.getAccountInfo();
        krwBalance = server.tradingSystem.getKRWBalance(accounts) || 0;
      }

      // 보유 포지션 조회
      const holdings = new Map();
      if (server.tradingSystem.dryRun) {
        const holdingsData = server.tradingSystem.virtualPortfolio?.holdings;
        if (holdingsData) {
          const entries = holdingsData instanceof Map
            ? Array.from(holdingsData.entries())
            : Object.entries(holdingsData || {});
          for (const [coin, holding] of entries) {
            if (holding.amount > 0) holdings.set(coin, holding);
          }
        }
      } else {
        const accounts = await server.tradingSystem.getAccountInfo();
        for (const acc of accounts) {
          if (acc.currency !== 'KRW' && parseFloat(acc.balance) > 0) {
            holdings.set(`KRW-${acc.currency}`, {
              amount: parseFloat(acc.balance),
              avgPrice: parseFloat(acc.avg_buy_price) || 0
            });
          }
        }
      }

      // 전체 마켓 조회
      const markets = await server.tradingSystem.upbit.getMarkets();
      const krwMarkets = markets.filter(m => m.market.startsWith('KRW-')).map(m => m.market);
      const tickers = await server.tradingSystem.upbit.getTicker(krwMarkets);

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
          const candles = await server.tradingSystem.upbit.getMinuteCandles(coin, 5, 100);
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
              symbol: coin.replace('KRW-', ''),
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
                symbol: coin.replace('KRW-', ''),
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
        } catch (coinError) {
          // 개별 코인 오류 무시
        }
      }

      // 정렬: 임계값에 가까운 순
      buyRecommendations.sort((a, b) => parseFloat(b.progressToThreshold) - parseFloat(a.progressToThreshold));
      sellRecommendations.sort((a, b) => parseFloat(b.progressToThreshold) - parseFloat(a.progressToThreshold));

      res.json({
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
      });
    } catch (error) {
      server.logApiError('/api/trading-recommendations', error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
