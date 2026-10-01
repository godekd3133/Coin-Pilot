import { getMarketDataProvider, MARKET_DATA_FRESHNESS } from './marketDataProvider.js';
import { baseOfMarket, marketsForQuote, quoteOfSystem } from '../exchange/marketCodes.js';

const NOTIFICATION_INTERVAL_MS = 30_000;
const NOTIFICATION_INITIAL_DELAY_MS = 5_000;

/**
 * 대시보드 알림 모니터 — 보유 포지션과 시세를 주기적으로 스캔해 번들 제안과
 * 속보를 실시간 허브로 방송한다.
 *
 * 진단/표시 전용 레인이다: 점수 계산은 알림용이며 트레이딩 결정이나
 * 라이브 게이트를 소유하지 않는다.
 */
export class NotificationMonitor {
  constructor({
    tradingSystem,
    logger,
    monitoringSessions,
    realtimeHub,
    getActiveHoldings,
    marketDataServer,
    getTradingSystem = null
  } = {}) {
    this._getTradingSystem = getTradingSystem || (() => tradingSystem);
    this.logger = logger;
    this.monitoringSessions = monitoringSessions;
    this.realtimeHub = realtimeHub;
    this.getActiveHoldings = getActiveHoldings;
    // marketDataProvider가 서버 자체를 래핑하므로 서버 참조를 보존한다.
    this.marketDataServer = marketDataServer;

    this.lastSignals = new Map();        // 마지막 신호 저장 (중복 알림 방지)
    this.lastBreakingNews = new Set();   // 마지막 속보 ID (중복 방지)
    this.interval = null;
    this.initialTimer = null;
  }

  emitTradeNotification(tradeInfo) {
    const notification = {
      type: 'auto-trade',
      trade: {
        ...tradeInfo,
        timestamp: new Date().toISOString()
      }
    };

    this.realtimeHub.emit('auto-trade', notification);

    const emoji = tradeInfo.type === 'BUY' ? '🟢' : '🔴';
    const modeLabel = tradeInfo.mode === 'DRY_RUN' ? '[모의]' : '[실전]';
    console.log(`${emoji} ${modeLabel} 자동매매 알림: ${tradeInfo.type} ${tradeInfo.coin} @ ${tradeInfo.price?.toLocaleString()}원`);
  }

  /** 알림 모니터링 시작 (30초 간격, 시작 5초 후 첫 체크) */
  start() {
    this.interval = setInterval(async () => {
      try {
        await this.checkAndEmit();
      } catch (error) {
        this.logger.error('알림 모니터링 오류:', error.message);
      }
    }, NOTIFICATION_INTERVAL_MS);

    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      this.checkAndEmit();
    }, NOTIFICATION_INITIAL_DELAY_MS);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
  }

  /** 새로운 신호와 속보 체크 후 알림 발송 */
  async checkAndEmit() {
    if (!this.realtimeHub.hasClients()) return;

    try {
      // 1. 번들 제안 체크
      const bundleSuggestions = await this.generateBundleSuggestions();
      if (bundleSuggestions.length > 0) {
        for (const bundle of bundleSuggestions) {
          const bundleKey = `${bundle.sell?.coin || 'NEW'}->${bundle.buy.coin}`;
          const lastEmit = this.lastSignals.get(bundleKey);

          // 5분 내 동일 제안 중복 방지
          if (!lastEmit || Date.now() - lastEmit > 5 * 60 * 1000) {
            this.monitoringSessions.ingestBundle(bundle).catch(() => undefined);
            this.realtimeHub.emit('new-signal', {
              type: 'bundle',
              bundle,
              timestamp: new Date().toISOString()
            });
            this.lastSignals.set(bundleKey, Date.now());
            console.log('🔔 번들 제안 알림 발송:', bundleKey);
          }
        }
      }

      // 2. 속보 체크
      await this.checkBreakingNews();
    } catch (error) {
      this.logger.error('알림 체크 오류:', error.message);
    }
  }

  /** 번들 제안 생성 (A코인 매도 → B코인 매수) */
  async generateBundleSuggestions() {
    const bundles = [];

    try {
      const marketDataProvider = getMarketDataProvider(this.marketDataServer);

      // 보유 포지션 확인
      const holdings = this.getActiveHoldings();

      if (holdings.size === 0) return bundles;

      // 현재가 조회
      const holdingCoins = Array.from(holdings.keys());
      const tickers = await marketDataProvider.getTickers(holdingCoins, {
        freshness: MARKET_DATA_FRESHNESS.FRESH
      });
      if (!tickers || !Array.isArray(tickers)) return bundles;
      const priceMap = new Map(tickers.map(t => [t.market, t]));

      // 보유 코인 분석 (매도 후보)
      const sellCandidates = [];
      const { comprehensiveAnalysis } = await import('../analysis/technicalIndicators.js');

      for (const [coin, holding] of holdings.entries()) {
        const ticker = priceMap.get(coin);
        if (!ticker) continue;

        const currentPrice = ticker.trade_price;
        const profitPercent = ((currentPrice - holding.avgPrice) / holding.avgPrice) * 100;

        try {
          const candles = await marketDataProvider.getMinuteCandles(coin, 5, 50);
          if (!candles || candles.length < 30) continue;

          const analysis = comprehensiveAnalysis(candles, {
            rsiPeriod: 14, rsiOversold: 30, rsiOverbought: 70
          });

          if (!analysis?.indicators) continue;

          const rsi = analysis.indicators.rsi;
          let sellScore = 0;
          const sellReasons = [];

          // 매도 신호 점수 계산
          if (rsi > 75) { sellScore += 40; sellReasons.push(`RSI 과매수(${rsi.toFixed(1)})`); }
          else if (rsi > 70) { sellScore += 30; sellReasons.push(`RSI 높음(${rsi.toFixed(1)})`); }

          if (profitPercent > 10) { sellScore += 25; sellReasons.push(`수익률 +${profitPercent.toFixed(1)}%`); }
          else if (profitPercent < -5) { sellScore += 20; sellReasons.push(`손실 ${profitPercent.toFixed(1)}%`); }

          if (analysis.indicators.macd?.histogram < 0) {
            sellScore += 15; sellReasons.push('MACD 하락세');
          }

          if (sellScore >= 35) {
            sellCandidates.push({
              coin,
              holding,
              currentPrice,
              profitPercent,
              sellScore,
              sellReasons,
              sellValue: holding.amount * currentPrice
            });
          }
        } catch { /* skip */ }
        await new Promise(r => setTimeout(r, 100));
      }

      if (sellCandidates.length === 0) return bundles;

      // 상위 거래량 코인에서 매수 후보 탐색
      const markets = await marketDataProvider.getMarkets();
      if (!markets || !Array.isArray(markets)) return bundles;
      const krwMarkets = marketsForQuote(markets, quoteOfSystem(this._getTradingSystem()));
      const allTickers = await marketDataProvider.getTickers(krwMarkets, {
        freshness: MARKET_DATA_FRESHNESS.FRESH
      });
      if (!allTickers || !Array.isArray(allTickers)) return bundles;
      const topCoins = [...allTickers]
        .filter(t => !holdings.has(t.market))
        .sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h)
        .slice(0, 20)
        .map(t => t.market);

      const buyCandidates = [];

      for (const coin of topCoins) {
        try {
          const ticker = allTickers.find(t => t.market === coin);
          const candles = await marketDataProvider.getMinuteCandles(coin, 5, 50);
          if (!candles || candles.length < 30) continue;

          const analysis = comprehensiveAnalysis(candles, {
            rsiPeriod: 14, rsiOversold: 30, rsiOverbought: 70
          });

          if (!analysis?.indicators) continue;

          const rsi = analysis.indicators.rsi;
          const change24h = ticker.signed_change_rate * 100;
          let buyScore = 0;
          const buyReasons = [];

          // 매수 신호 점수 계산
          if (rsi < 25) { buyScore += 40; buyReasons.push(`RSI 극과매도(${rsi.toFixed(1)})`); }
          else if (rsi < 35) { buyScore += 30; buyReasons.push(`RSI 과매도(${rsi.toFixed(1)})`); }

          if (change24h < -8) { buyScore += 25; buyReasons.push(`24h ${change24h.toFixed(1)}% 급락`); }
          else if (change24h < -5) { buyScore += 15; buyReasons.push(`24h ${change24h.toFixed(1)}% 하락`); }

          if (analysis.indicators.macd?.histogram > 0) {
            buyScore += 15; buyReasons.push('MACD 상승세');
          }

          if (analysis.indicators.bollingerBands?.percentB < 0.1) {
            buyScore += 20; buyReasons.push('하단밴드 터치');
          }

          if (buyScore >= 40) {
            buyCandidates.push({
              coin,
              currentPrice: ticker.trade_price,
              change24h,
              buyScore,
              buyReasons,
              volume24h: ticker.acc_trade_price_24h
            });
          }
        } catch { /* skip */ }
        await new Promise(r => setTimeout(r, 100));
      }

      // 매도 + 매수 번들 생성
      for (const sellCandidate of sellCandidates) {
        for (const buyCandidate of buyCandidates) {
          // 점수 합산이 높은 조합만 제안
          const totalScore = sellCandidate.sellScore + buyCandidate.buyScore;
          if (totalScore >= 80) {
            bundles.push({
              type: 'REBALANCE',
              sell: {
                coin: sellCandidate.coin,
                amount: sellCandidate.holding.amount,
                currentPrice: sellCandidate.currentPrice,
                value: Math.round(sellCandidate.sellValue),
                profitPercent: sellCandidate.profitPercent.toFixed(2),
                score: sellCandidate.sellScore,
                reasons: sellCandidate.sellReasons
              },
              buy: {
                coin: buyCandidate.coin,
                currentPrice: buyCandidate.currentPrice,
                suggestedAmount: Math.round(sellCandidate.sellValue * 0.95), // 수수료 고려
                score: buyCandidate.buyScore,
                reasons: buyCandidate.buyReasons
              },
              totalScore,
              summary: `${baseOfMarket(sellCandidate.coin)} 매도 → ${baseOfMarket(buyCandidate.coin)} 매수`,
              rationale: `${sellCandidate.sellReasons[0]} → ${buyCandidate.buyReasons[0]}`
            });
          }
        }
      }

      // 점수 순 정렬, 상위 3개만
      bundles.sort((a, b) => b.totalScore - a.totalScore);
      return bundles.slice(0, 3);

    } catch (error) {
      this.logger.error('번들 제안 생성 오류:', error.message);
      return [];
    }
  }

  /** 속보 체크 및 알림 */
  async checkBreakingNews() {
    try {
      const trader = this._getTradingSystem();
      if (!trader?.newsMonitor) return;

      const newsData = trader.newsData || [];
      const urgentNews = trader.newsMonitor.detectUrgentNews(newsData);

      for (const news of urgentNews) {
        const newsKey = news.title.substring(0, 50);

        if (!this.lastBreakingNews.has(newsKey)) {
          this.monitoringSessions.ingestNews(news).catch(() => undefined);
          this.realtimeHub.emit('breaking-news', {
            title: news.title,
            source: news.source,
            url: news.url,
            sentiment: news.sentiment,
            timestamp: news.timestamp || new Date().toISOString()
          });
          this.lastBreakingNews.add(newsKey);
          console.log('🚨 속보 알림 발송:', news.title.substring(0, 30));

          // 오래된 뉴스 키 정리 (최대 100개 유지)
          if (this.lastBreakingNews.size > 100) {
            const keys = Array.from(this.lastBreakingNews);
            keys.slice(0, 50).forEach(k => this.lastBreakingNews.delete(k));
          }
        }
      }
    } catch (error) {
      this.logger.error('속보 체크 오류:', error.message);
    }
  }
}

export default NotificationMonitor;
