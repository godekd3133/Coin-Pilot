import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import Logger from '../utils/logger.js';

// Route modules
import createAccountRoutes from './routes/account.js';
import createPortfolioRoutes from './routes/portfolio.js';
import createNewsRoutes from './routes/news.js';
import createMarketRoutes from './routes/market.js';
import createOptimizationRoutes from './routes/optimization.js';
import createConfigRoutes from './routes/config.js';
import createTradingRoutes from './routes/trading.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// 프로젝트 루트: src/api/ 에서 2단계 상위
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

class DashboardServer {
  constructor(tradingSystem, port = 3000) {
    this.app = express();
    this.port = port;
    this.tradingSystem = tradingSystem;
    this.logger = new Logger('debug');

    // HTTP 서버 및 Socket.io 초기화
    this.httpServer = createServer(this.app);
    this.io = new SocketIOServer(this.httpServer, {
      cors: { origin: '*', methods: ['GET', 'POST'] }
    });

    // API 응답 캐싱 (rate limit 방지)
    this.cache = new Map();
    this.cacheTTL = {
      ticker: 1000,      // 시세: 1초
      account: 1000,     // 계좌: 1초
      statistics: 1000,  // 통계: 1초
      candles: 1000      // 캔들: 1초
    };

    // 알림 상태 추적
    this.lastSignals = new Map();        // 마지막 신호 저장 (중복 알림 방지)
    this.lastBreakingNews = new Set();   // 마지막 속보 ID (중복 방지)
    this.notificationInterval = null;    // 알림 모니터링 인터벌

    // 뉴스 누적 저장소 (서버 시작 이후 모든 뉴스 누적)
    this.accumulatedNews = [];           // 누적된 전체 뉴스
    this.newsSeenKeys = new Set();       // 중복 체크용 키 (title+link 해시)
    this.newsAccumulatorStartTime = new Date();

    // 자동 최적화 상태
    this.optimizationState = {
      enabled: true,  // 기본값: 자동 최적화 활성화
      interval: 21600000,  // 기본 6시간
      isRunning: false,
      lastRun: null,
      nextRun: null
    };
    this.optimizationTimer = null;
    this.loadOptimizationState();

    this.setupMiddleware();
    this.setupRoutes();
    this.setupSocketIO();
    this.setupErrorHandler();
  }

  // holdings를 Map으로 정규화하는 유틸리티 메서드
  getHoldingsAsMap() {
    const holdings = this.tradingSystem?.virtualPortfolio?.holdings;
    if (!holdings) return new Map();
    if (holdings instanceof Map) return holdings;
    // Object를 Map으로 변환
    return new Map(Object.entries(holdings));
  }

  // holdings 항목을 가져오는 유틸리티 (amount > 0인 것만)
  getActiveHoldings() {
    const holdingsMap = this.getHoldingsAsMap();
    const active = new Map();
    for (const [coin, holding] of holdingsMap.entries()) {
      if (holding && holding.amount > 0) {
        active.set(coin, holding);
      }
    }
    return active;
  }

  // 뉴스 고유 키 생성 (중복 체크용)
  generateNewsKey(news) {
    const title = (news.title || '').toLowerCase().trim().slice(0, 100);
    const link = (news.link || '').toLowerCase().trim();
    return `${title}::${link}`;
  }

  // 뉴스 누적 (중복 제거)
  accumulateNews(newsList, source = 'general') {
    if (!Array.isArray(newsList)) return 0;

    let addedCount = 0;
    const now = new Date();

    for (const news of newsList) {
      if (!news || !news.title) continue;

      const key = this.generateNewsKey(news);
      if (this.newsSeenKeys.has(key)) continue;

      this.newsSeenKeys.add(key);
      this.accumulatedNews.push({
        ...news,
        accumulatedAt: now,
        sourceCategory: source,
        id: `news_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
      });
      addedCount++;
    }

    // 최신순 정렬
    this.accumulatedNews.sort((a, b) => {
      const timeA = new Date(a.timestamp || a.accumulatedAt);
      const timeB = new Date(b.timestamp || b.accumulatedAt);
      return timeB - timeA;
    });

    // 로그
    if (addedCount > 0) {
      console.log(`[NewsAccumulator] ${addedCount}개 뉴스 추가됨 (총 ${this.accumulatedNews.length}개)`);
    }

    return addedCount;
  }

  // 누적된 뉴스 조회
  getAccumulatedNews(options = {}) {
    const { limit = 100, coin = null, source = null } = options;

    let filtered = this.accumulatedNews;

    // 코인 필터
    if (coin) {
      const symbol = coin.replace('KRW-', '').toLowerCase();
      filtered = filtered.filter(news => {
        const title = (news.title || '').toLowerCase();
        const content = (news.content || '').toLowerCase();
        return title.includes(symbol) || content.includes(symbol);
      });
    }

    // 소스 필터
    if (source) {
      filtered = filtered.filter(news =>
        (news.source || '').toLowerCase().includes(source.toLowerCase()) ||
        (news.sourceCategory || '').toLowerCase().includes(source.toLowerCase())
      );
    }

    return {
      news: filtered.slice(0, limit),
      total: filtered.length,
      totalAccumulated: this.accumulatedNews.length,
      accumulatorStartTime: this.newsAccumulatorStartTime
    };
  }

  // 캐시 조회 (TTL 체크)
  getCache(key) {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.time < (this.cacheTTL[key.split(':')[0]] || 2000)) {
      return cached.data;
    }
    return null;
  }

  // 캐시 저장
  setCache(key, data) {
    this.cache.set(key, { data, time: Date.now() });
  }

  // 캐싱된 Ticker 조회
  async getCachedTicker(coins) {
    const coinKey = Array.isArray(coins) ? coins.sort().join(',') : coins;
    const cacheKey = `ticker:${coinKey}`;

    const cached = this.getCache(cacheKey);
    if (cached) return cached;

    const data = await this.tradingSystem.upbit.getTicker(coins);
    this.setCache(cacheKey, data);
    return data;
  }

  setupMiddleware() {
    this.app.use(cors());
    this.app.use(express.json());
    this.app.use(express.static(path.join(PROJECT_ROOT, 'public')));
  }

  setupRoutes() {
    // ========================================
    // 모듈화된 라우트 마운트
    // ========================================
    this.app.use('/api', createAccountRoutes(this));
    this.app.use('/api', createPortfolioRoutes(this));
    this.app.use('/api', createNewsRoutes(this));
    this.app.use('/api', createMarketRoutes(this));
    this.app.use('/api', createOptimizationRoutes(this));
    this.app.use('/api', createConfigRoutes(this));
    this.app.use('/api', createTradingRoutes(this));

    // ========================================
    // 추가 라우트 (dashboardServer 전용)
    // 기존 모듈로 분리된 라우트는 위에서 마운트됨
    // 아래는 dashboardServer에만 있는 추가 라우트
    // ========================================
    // 시스템 상태 상세 조회
    this.app.get('/api/system-status', async (req, res) => {
      try {
        const now = new Date();
        const uptime = process.uptime();

        // 마지막 거래 시간 계산
        let lastTradeTime = null;
        if (this.tradingSystem.smartTradeHistory?.length > 0) {
          lastTradeTime = this.tradingSystem.smartTradeHistory[0].timestamp;
        }

        // 에러 로그 확인
        const logDir = path.join(PROJECT_ROOT, 'logs');
        const today = now.toISOString().split('T')[0];
        const errorLogFile = path.join(logDir, `error-${today}.log`);
        let recentErrors = [];

        if (fs.existsSync(errorLogFile)) {
          const content = fs.readFileSync(errorLogFile, 'utf8');
          // 타임스탬프 패턴으로 에러 항목 분리 (멀티라인 JSON 포함)
          // 에러 로그 형식: [2025-12-29T05:19:16.515Z] [ERROR] message\n{json...}
          const timestampPattern = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/;
          const lines = content.split('\n');
          const errorEntries = [];
          let currentEntry = '';

          for (const line of lines) {
            if (timestampPattern.test(line)) {
              // 새 에러 항목 시작
              if (currentEntry.trim()) {
                errorEntries.push(currentEntry.trim());
              }
              currentEntry = line;
            } else if (currentEntry) {
              // 현재 에러에 이어지는 줄 (JSON 등)
              currentEntry += '\n' + line;
            }
          }
          // 마지막 항목 추가
          if (currentEntry.trim()) {
            errorEntries.push(currentEntry.trim());
          }

          // 최근 10개 에러, 각 에러당 최대 2000자
          recentErrors = errorEntries.slice(-10).map(entry => {
            return entry.length > 2000 ? entry.substring(0, 2000) + '...(truncated)' : entry;
          });
        }

        // 다음 분석 예정 시간
        const checkInterval = this.tradingSystem.config?.checkInterval || 60000;
        const nextAnalysis = new Date(now.getTime() + checkInterval);

        // 현재 포지션 수 계산 (여러 소스에서 확인)
        let currentPositions = 0;

        // 1. 전략 기반 포지션 수
        if (this.tradingSystem.getCurrentPositionCount) {
          currentPositions = this.tradingSystem.getCurrentPositionCount();
        }

        // 2. 가상 포트폴리오에서 확인 (드라이 모드)
        if (currentPositions === 0) {
          currentPositions = this.getActiveHoldings().size || 0;
        }

        // 3. strategies에서 직접 확인
        if (currentPositions === 0 && this.tradingSystem.strategies) {
          for (const [, strategy] of this.tradingSystem.strategies.entries()) {
            if (strategy.currentPosition) {
              currentPositions++;
            }
          }
        }

        res.json({
          isRunning: this.tradingSystem.isRunning,
          mode: this.tradingSystem.dryRun ? 'DRY_RUN' : 'LIVE',
          uptime: Math.floor(uptime),
          uptimeFormatted: `${Math.floor(uptime / 3600)}시간 ${Math.floor((uptime % 3600) / 60)}분`,
          lastTradeTime,
          nextAnalysis: nextAnalysis.toISOString(),
          checkInterval,
          targetCoinsCount: this.tradingSystem.targetCoins?.length || 0,
          currentPositions,
          recentErrors,
          hasErrors: recentErrors.length > 0,
          serverTime: now.toISOString()
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // 오늘의 거래 요약
    this.app.get('/api/today-summary', async (req, res) => {
      try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        let todayTrades = [];
        let totalBuyAmount = 0;
        let totalSellAmount = 0;
        let buyCount = 0;
        let sellCount = 0;
        let realizedProfit = 0;

        // 스마트 거래 이력에서 오늘 거래 필터링
        if (this.tradingSystem.smartTradeHistory) {
          todayTrades = this.tradingSystem.smartTradeHistory.filter(trade => {
            const tradeDate = new Date(trade.timestamp);
            return tradeDate >= today;
          });

          todayTrades.forEach(trade => {
            if (trade.type === 'BUY') {
              buyCount++;
              totalBuyAmount += trade.amount || 0;
            } else if (trade.type === 'SELL') {
              sellCount++;
              totalSellAmount += trade.amount || 0;
              realizedProfit += trade.profit || 0;
            }
          });
        }

        // 전략별 오늘 거래도 확인 (자동매매 이력)
        // 전략의 tradeHistory는 action: 'OPEN'/'CLOSE' 형식 사용
        if (this.tradingSystem.strategies) {
          const processedTradeIds = new Set(todayTrades.map(t => t.id || t.timestamp));

          for (const [coin, strategy] of this.tradingSystem.strategies.entries()) {
            const history = strategy.tradeHistory || [];
            history.forEach(trade => {
              // 이미 smartTradeHistory에서 처리된 거래는 스킵
              if (trade.id && processedTradeIds.has(trade.id)) return;

              // OPEN (매수) 거래
              if (trade.action === 'OPEN') {
                const tradeDate = new Date(trade.entryTime);
                if (tradeDate >= today) {
                  buyCount++;
                  // 매수 금액 계산: 진입가 × 수량
                  const buyAmount = (trade.entryPrice || 0) * (trade.amount || 0);
                  totalBuyAmount += buyAmount;
                }
              }

              // CLOSE (매도) 거래
              if (trade.action === 'CLOSE') {
                const tradeDate = new Date(trade.exitTime);
                if (tradeDate >= today) {
                  sellCount++;
                  // 매도 금액 계산: 청산가 × 수량
                  const sellAmount = (trade.exitPrice || 0) * (trade.amount || 0);
                  totalSellAmount += sellAmount;
                  realizedProfit += trade.profit || 0;
                }
              }
            });
          }
        }

        res.json({
          date: today.toISOString().split('T')[0],
          totalTrades: buyCount + sellCount,
          buyCount,
          sellCount,
          totalBuyAmount: Math.round(totalBuyAmount),
          totalSellAmount: Math.round(totalSellAmount),
          netFlow: Math.round(totalSellAmount - totalBuyAmount),
          realizedProfit: Math.round(realizedProfit),
          trades: todayTrades.slice(0, 10)
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // 포트폴리오 상세 분석
    this.app.get('/api/portfolio-analysis', async (req, res) => {
      try {
        const holdings = [];
        let totalValue = 0;
        let totalCost = 0;

        // 가상 포트폴리오 또는 실제 포트폴리오 분석
        const portfolioHoldings = this.tradingSystem.virtualPortfolio?.holdings;

        // Map 또는 Object 모두 처리
        const isMap = portfolioHoldings instanceof Map;
        const holdingsEntries = isMap
          ? Array.from(portfolioHoldings.entries())
          : Object.entries(portfolioHoldings || {});

        if (holdingsEntries.length > 0) {
          const coins = holdingsEntries.map(([coin]) => coin);
          const tickers = await this.getCachedTicker(coins);
          const priceMap = {};
          tickers.forEach(t => { priceMap[t.market] = t; });

          for (const [coin, holding] of holdingsEntries) {
            const ticker = priceMap[coin];
            const currentPrice = ticker?.trade_price || holding.avgPrice;
            const currentValue = holding.amount * currentPrice;
            const costBasis = holding.amount * holding.avgPrice;
            const profit = currentValue - costBasis;
            const profitPercent = costBasis > 0 ? ((currentValue / costBasis) - 1) * 100 : 0;

            totalValue += currentValue;
            totalCost += costBasis;

            holdings.push({
              coin,
              symbol: coin.split('-')[1],
              amount: holding.amount,
              avgPrice: holding.avgPrice,
              currentPrice,
              currentValue: Math.round(currentValue),
              costBasis: Math.round(costBasis),
              profit: Math.round(profit),
              profitPercent: profitPercent.toFixed(2),
              change24h: ticker?.signed_change_rate ? (ticker.signed_change_rate * 100).toFixed(2) : '0',
              weight: 0 // 아래에서 계산
            });
          }
        }

        // KRW 잔액 추가
        const krwBalance = this.tradingSystem.dryRun
          ? (this.tradingSystem.virtualPortfolio?.krwBalance || 0)
          : 0;

        const totalAssets = totalValue + krwBalance;

        // 비중 계산
        holdings.forEach(h => {
          h.weight = totalAssets > 0 ? ((h.currentValue / totalAssets) * 100).toFixed(1) : '0';
        });

        // 수익률 순 정렬
        const topGainers = [...holdings].sort((a, b) => parseFloat(b.profitPercent) - parseFloat(a.profitPercent)).slice(0, 3);
        const topLosers = [...holdings].sort((a, b) => parseFloat(a.profitPercent) - parseFloat(b.profitPercent)).slice(0, 3);

        // 비중 순 정렬
        const byWeight = [...holdings].sort((a, b) => parseFloat(b.weight) - parseFloat(a.weight));

        res.json({
          holdings: byWeight,
          summary: {
            totalHoldings: holdings.length,
            totalValue: Math.round(totalValue),
            totalCost: Math.round(totalCost),
            totalProfit: Math.round(totalValue - totalCost),
            totalProfitPercent: totalCost > 0 ? (((totalValue / totalCost) - 1) * 100).toFixed(2) : '0',
            krwBalance: Math.round(krwBalance),
            krwWeight: totalAssets > 0 ? ((krwBalance / totalAssets) * 100).toFixed(1) : '0',
            totalAssets: Math.round(totalAssets)
          },
          topGainers,
          topLosers
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // 특정 코인 상세 정보 (매수/매도 시 참조용)
    this.app.get('/api/coin-detail/:coin', async (req, res) => {
      try {
        const coin = req.params.coin;

        // upbit API 객체 확인
        if (!this.tradingSystem?.upbit) {
          return res.status(500).json({ error: 'Upbit API not initialized' });
        }

        // 현재가 조회
        let ticker = null;
        let currentPrice = 0;
        try {
          ticker = await this.tradingSystem.upbit.getTicker(coin);
          currentPrice = ticker?.[0]?.trade_price || 0;
        } catch (tickerErr) {
          console.error(`[coin-detail] 현재가 조회 실패 (${coin}):`, tickerErr.message);
          // 현재가 조회 실패해도 계속 진행
        }

        // 보유 정보
        const holding = this.tradingSystem.virtualPortfolio?.holdings?.get(coin);
        const holdingAmount = holding?.amount || 0;
        const avgPrice = holding?.avgPrice || 0;
        const holdingValue = holdingAmount * currentPrice;
        const costBasis = holdingAmount * avgPrice;
        const profit = holdingValue - costBasis;
        const profitPercent = costBasis > 0 ? ((holdingValue / costBasis) - 1) * 100 : 0;

        // 캔들 데이터로 기술적 분석
        let analysis = null;
        try {
          const candles = await this.tradingSystem.upbit.getMinuteCandles(coin, 5, 50);
          if (candles?.length >= 30) {
            const { comprehensiveAnalysis } = await import('../analysis/technicalIndicators.js');
            analysis = comprehensiveAnalysis(candles, {});
          }
        } catch (candleErr) {
          console.error(`[coin-detail] 캔들 데이터 조회 실패 (${coin}):`, candleErr.message);
          // 캔들 조회 실패해도 계속 진행
        }

        // KRW 잔액
        const krwBalance = this.tradingSystem.dryRun
          ? (this.tradingSystem.virtualPortfolio?.krwBalance || 0)
          : 0;

        res.json({
          coin,
          symbol: coin.split('-')[1],
          currentPrice,
          change24h: ticker?.[0]?.signed_change_rate ? (ticker[0].signed_change_rate * 100).toFixed(2) : '0',
          high24h: ticker?.[0]?.high_price || 0,
          low24h: ticker?.[0]?.low_price || 0,
          volume24h: ticker?.[0]?.acc_trade_price_24h || 0,
          holding: {
            amount: holdingAmount,
            avgPrice,
            currentValue: Math.round(holdingValue),
            costBasis: Math.round(costBasis),
            profit: Math.round(profit),
            profitPercent: profitPercent.toFixed(2)
          },
          indicators: analysis?.indicators ? {
            rsi: analysis.indicators.rsi?.toFixed(1) || '-',
            macd: analysis.indicators.macd?.histogram?.toFixed(2) || '-',
            bb: analysis.indicators.bollingerBands?.percentB?.toFixed(2) || '-'
          } : null,
          krwBalance: Math.round(krwBalance),
          maxBuyAmount: Math.floor(krwBalance * 0.95),
          maxSellAmount: Math.round(holdingValue)
        });
      } catch (error) {
        console.error(`[coin-detail] 전체 오류:`, error);
        res.status(500).json({ error: error.message });
      }
    });
  }

  /**
   * 전역 에러 핸들링 미들웨어 설정
   */
  setupErrorHandler() {
    // 404 에러 핸들러
    this.app.use((req, res, next) => {
      // Chrome DevTools, favicon 등 무시할 요청 패턴
      const ignorePaths = [
        '/.well-known/',
        '/favicon.ico',
        '/apple-touch-icon',
        '/robots.txt'
      ];

      if (ignorePaths.some(path => req.originalUrl.startsWith(path))) {
        return res.status(404).end();
      }

      const error = new Error(`Not Found - ${req.originalUrl}`);
      error.status = 404;
      next(error);
    });

    // 전역 에러 핸들러
    this.app.use((err, req, res, next) => {
      const statusCode = err.status || 500;
      const message = err.message || 'Internal Server Error';

      // 에러 로그 기록
      this.logger.error(`[${req.method}] ${req.originalUrl} - ${message}`, {
        statusCode,
        method: req.method,
        url: req.originalUrl,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        body: req.body,
        stack: err.stack
      });

      res.status(statusCode).json({
        success: false,
        error: message,
        path: req.originalUrl,
        timestamp: new Date().toISOString()
      });
    });
  }

  /**
   * API 에러 로깅 헬퍼
   */
  logApiError(endpoint, error, additionalData = {}) {
    this.logger.error(`API Error [${endpoint}]: ${error.message}`, {
      endpoint,
      error: error.message,
      stack: error.stack,
      ...additionalData
    });
  }

  /**
   * Socket.io 설정 및 실시간 알림 시스템
   */
  setupSocketIO() {
    this.io.on('connection', (socket) => {
      console.log('📡 클라이언트 연결:', socket.id);

      socket.on('disconnect', () => {
        console.log('📡 클라이언트 연결 해제:', socket.id);
      });

      // 알림 설정 변경 수신
      socket.on('notification-settings', (settings) => {
        socket.notificationSettings = settings;
      });
    });

    // 알림 모니터링 시작 (30초마다)
    this.startNotificationMonitoring();
  }

  /**
   * 자동매매 거래 알림 전송
   */
  emitTradeNotification(tradeInfo) {
    if (!this.io) return;

    const notification = {
      type: 'auto-trade',
      trade: {
        ...tradeInfo,
        timestamp: new Date().toISOString()
      }
    };

    this.io.emit('auto-trade', notification);

    const emoji = tradeInfo.type === 'BUY' ? '🟢' : '🔴';
    const modeLabel = tradeInfo.mode === 'DRY_RUN' ? '[모의]' : '[실전]';
    console.log(`${emoji} ${modeLabel} 자동매매 알림: ${tradeInfo.type} ${tradeInfo.coin} @ ${tradeInfo.price?.toLocaleString()}원`);
  }

  /**
   * 알림 모니터링 시작
   */
  startNotificationMonitoring() {
    // 초기 실행 후 30초마다 반복
    this.notificationInterval = setInterval(async () => {
      try {
        await this.checkAndEmitNotifications();
      } catch (error) {
        this.logger.error('알림 모니터링 오류:', error.message);
      }
    }, 30000);

    // 서버 시작 5초 후 첫 번째 체크
    setTimeout(() => this.checkAndEmitNotifications(), 5000);
  }

  /**
   * 새로운 신호와 속보 체크 후 알림 발송
   */
  async checkAndEmitNotifications() {
    if (!this.tradingSystem?.upbit || this.io.engine.clientsCount === 0) return;

    try {
      // 1. 번들 제안 체크
      const bundleSuggestions = await this.generateBundleSuggestions();
      if (bundleSuggestions.length > 0) {
        for (const bundle of bundleSuggestions) {
          const bundleKey = `${bundle.sell?.coin || 'NEW'}->${bundle.buy.coin}`;
          const lastEmit = this.lastSignals.get(bundleKey);

          // 5분 내 동일 제안 중복 방지
          if (!lastEmit || Date.now() - lastEmit > 5 * 60 * 1000) {
            this.io.emit('new-signal', {
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

  /**
   * 번들 제안 생성 (A코인 매도 → B코인 매수)
   */
  async generateBundleSuggestions() {
    const bundles = [];

    try {
      if (!this.tradingSystem.upbit) return bundles;

      // 보유 포지션 확인
      const holdings = this.getActiveHoldings();

      if (holdings.size === 0) return bundles;

      // 현재가 조회
      const holdingCoins = Array.from(holdings.keys());
      const tickers = await this.tradingSystem.upbit.getTicker(holdingCoins);
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
          const candles = await this.tradingSystem.upbit.getMinuteCandles(coin, 5, 50);
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
        } catch (e) { /* skip */ }
        await new Promise(r => setTimeout(r, 100));
      }

      if (sellCandidates.length === 0) return bundles;

      // 상위 거래량 코인에서 매수 후보 탐색
      const markets = await this.tradingSystem.upbit.getMarkets();
      const krwMarkets = markets.filter(m => m.market.startsWith('KRW-')).map(m => m.market);
      const allTickers = await this.tradingSystem.upbit.getTicker(krwMarkets);
      const topCoins = [...allTickers]
        .filter(t => !holdings.has(t.market))
        .sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h)
        .slice(0, 20)
        .map(t => t.market);

      const buyCandidates = [];

      for (const coin of topCoins) {
        try {
          const ticker = allTickers.find(t => t.market === coin);
          const candles = await this.tradingSystem.upbit.getMinuteCandles(coin, 5, 50);
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
        } catch (e) { /* skip */ }
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
              summary: `${sellCandidate.coin.replace('KRW-', '')} 매도 → ${buyCandidate.coin.replace('KRW-', '')} 매수`,
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

  /**
   * 속보 체크 및 알림
   */
  async checkBreakingNews() {
    try {
      if (!this.tradingSystem.newsMonitor) return;

      const newsData = this.tradingSystem.newsData || [];
      const urgentNews = this.tradingSystem.newsMonitor.detectUrgentNews(newsData);

      for (const news of urgentNews) {
        const newsKey = news.title.substring(0, 50);

        if (!this.lastBreakingNews.has(newsKey)) {
          this.io.emit('breaking-news', {
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

  start() {
    // 거래 알림 콜백 설정
    if (this.tradingSystem?.setTradeCallback) {
      this.tradingSystem.setTradeCallback((tradeInfo) => {
        this.emitTradeNotification(tradeInfo);
      });
      console.log('   🔔 자동매매 알림 콜백 설정됨');
    }

    this.server = this.httpServer.listen(this.port, () => {
      console.log(`\n🌐 대시보드 서버 시작: http://localhost:${this.port}`);
      console.log(`   API 엔드포인트: http://localhost:${this.port}/api`);
      console.log(`   📡 실시간 알림: Socket.io 활성화`);
      this.logger.info(`Dashboard server started on port ${this.port}`);
    });

    // 서버 에러 핸들링
    this.server.on('error', (error) => {
      this.logger.error('Server error', {
        error: error.message,
        code: error.code,
        stack: error.stack
      });

      if (error.code === 'EADDRINUSE') {
        this.logger.error(`Port ${this.port} is already in use`);
      }
    });

    return this.server;
  }

  // 최적화 상태 파일 경로
  getOptimizationStateFile() {
    return path.join(PROJECT_ROOT, 'optimization_state.json');
  }

  // 최적화 상태 로드
  loadOptimizationState() {
    try {
      const stateFile = this.getOptimizationStateFile();
      if (fs.existsSync(stateFile)) {
        const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        this.optimizationState = { ...this.optimizationState, ...saved };

        // 서버 재시작 시 스케줄러 복원
        if (this.optimizationState.enabled) {
          this.startOptimizationScheduler();
        }
      }
    } catch (error) {
      console.error('최적화 상태 로드 실패:', error.message);
    }
  }

  // 최적화 상태 저장
  saveOptimizationState() {
    try {
      const stateFile = this.getOptimizationStateFile();
      const saveData = {
        enabled: this.optimizationState.enabled,
        interval: this.optimizationState.interval,
        lastRun: this.optimizationState.lastRun
      };
      fs.writeFileSync(stateFile, JSON.stringify(saveData, null, 2), 'utf8');
    } catch (error) {
      console.error('최적화 상태 저장 실패:', error.message);
    }
  }

  // 최적화 스케줄러 시작
  startOptimizationScheduler() {
    this.stopOptimizationScheduler(); // 기존 타이머 정리

    const interval = this.optimizationState.interval;
    this.optimizationState.nextRun = new Date(Date.now() + interval).toISOString();

    console.log(`🧬 자동 최적화 스케줄러 시작 (주기: ${interval / 3600000}시간)`);

    this.optimizationTimer = setInterval(() => {
      this.runOptimizationCycle();
    }, interval);
  }

  // 최적화 스케줄러 중지
  stopOptimizationScheduler() {
    if (this.optimizationTimer) {
      clearInterval(this.optimizationTimer);
      this.optimizationTimer = null;
    }
    this.optimizationState.nextRun = null;
    console.log('🧬 자동 최적화 스케줄러 중지');
  }

  // 최적화 사이클 실행
  async runOptimizationCycle() {
    if (this.optimizationState.isRunning) {
      console.log('⚠️ 이미 최적화가 실행 중입니다.');
      return;
    }

    try {
      this.optimizationState.isRunning = true;
      console.log('\n🧬 자동 최적화 사이클 시작...');

      // 동적 import로 최적화 모듈 로드
      const { default: ParameterOptimizer } = await import('../optimization/parameterOptimizer.js');

      const targetCoin = process.env.TARGET_COIN || 'KRW-BTC';
      const candleUnit = parseInt(process.env.BACKTEST_CANDLE_UNIT) || 15;
      const candleCount = parseInt(process.env.BACKTEST_CANDLE_COUNT) || 500;

      // 캔들 데이터 수집
      console.log(`📊 ${candleUnit}분봉 데이터 수집 중...`);
      const candles = await this.collectCandleData(targetCoin, candleUnit, candleCount);

      if (candles.length < 250) {
        console.log(`⚠️ 데이터 부족 (${candles.length}개), 최적화 건너뜀`);
        return;
      }

      // 최적화 실행
      const optimizer = new ParameterOptimizer({
        populationSize: parseInt(process.env.POPULATION_SIZE) || 20,
        generations: parseInt(process.env.GENERATIONS) || 10,
        mutationRate: parseFloat(process.env.MUTATION_RATE) || 0.2,
        crossoverRate: parseFloat(process.env.CROSSOVER_RATE) || 0.7,
        eliteSize: parseInt(process.env.ELITE_SIZE) || 2
      });

      const result = await optimizer.optimize(candles);

      // 결과 저장
      const config = {
        updatedAt: new Date().toISOString(),
        targetCoin,
        candleUnit,
        candleCount: candles.length,
        fitness: result.fitness,
        parameters: result.parameters,
        note: '자동 최적화를 통해 생성된 파라미터입니다.'
      };

      fs.writeFileSync(
        path.join(PROJECT_ROOT, 'optimal_config.json'),
        JSON.stringify(config, null, 2),
        'utf8'
      );

      // 히스토리 업데이트
      const historyFile = path.join(PROJECT_ROOT, 'optimization_history.json');
      let history = [];
      if (fs.existsSync(historyFile)) {
        history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
      }
      history.push({
        timestamp: new Date().toISOString(),
        cycle: history.length + 1,
        fitness: result.fitness,
        parameters: result.parameters
      });
      if (history.length > 100) history = history.slice(-100);
      fs.writeFileSync(historyFile, JSON.stringify(history, null, 2), 'utf8');

      this.optimizationState.lastRun = new Date().toISOString();
      if (this.optimizationState.enabled) {
        this.optimizationState.nextRun = new Date(Date.now() + this.optimizationState.interval).toISOString();
      }
      this.saveOptimizationState();

      // 🔥 트레이딩 시스템에 새 파라미터 즉시 적용 (핫 리로드)
      this.applyOptimalParameters(result.parameters);

      console.log('✅ 자동 최적화 완료!');
      console.log(`   예상 수익률: ${result.fitness?.toFixed(2)}%`);

    } catch (error) {
      console.error('❌ 최적화 오류:', error.message);
    } finally {
      this.optimizationState.isRunning = false;
    }
  }

  // 캔들 데이터 수집 헬퍼
  async collectCandleData(market, unit, totalCount) {
    const axios = (await import('axios')).default;
    const maxPerRequest = 200;
    const allCandles = [];
    let to = null;

    while (allCandles.length < totalCount) {
      const count = Math.min(maxPerRequest, totalCount - allCandles.length);

      try {
        const params = { market, count };
        if (to) params.to = to;

        const response = await axios.get(
          `https://api.upbit.com/v1/candles/minutes/${unit}`,
          { params }
        );

        const candles = response.data;
        if (!candles || candles.length === 0) break;

        allCandles.push(...candles);
        to = candles[candles.length - 1].candle_date_time_utc;

        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        console.error(`캔들 데이터 수집 오류:`, error.message);
        break;
      }
    }

    return allCandles;
  }

  /**
   * 최적화된 파라미터를 트레이딩 시스템에 즉시 적용 (핫 리로드)
   */
  applyOptimalParameters(params) {
    if (!params || !this.tradingSystem) {
      console.log('⚠️ 파라미터 적용 실패: 트레이딩 시스템 없음');
      return;
    }

    console.log('🔄 새 파라미터를 트레이딩 시스템에 적용 중...');

    // 1. 트레이딩 시스템 config 업데이트 (19개 전체 파라미터)
    if (this.tradingSystem.config) {
      Object.assign(this.tradingSystem.config, {
        // RSI
        rsiPeriod: params.rsiPeriod,
        rsiOversold: params.rsiOversold,
        rsiOverbought: params.rsiOverbought,
        // MACD
        macdFast: params.macdFast,
        macdSlow: params.macdSlow,
        macdSignal: params.macdSignal,
        // 볼린저 밴드
        bbPeriod: params.bbPeriod,
        bbStdDev: params.bbStdDev,
        // EMA
        emaShort: params.emaShort,
        emaMid: params.emaMid,
        emaLong: params.emaLong,
        // 리스크 관리
        stopLossPercent: params.stopLossPercent,
        takeProfitPercent: params.takeProfitPercent,
        trailingStopPercent: params.trailingStopPercent,
        // 매매 임계값
        buyThreshold: params.buyThreshold,
        sellThreshold: params.sellThreshold,
        // 거래량
        volumeMultiplier: params.volumeMultiplier,
        volumePeriod: params.volumePeriod
      });
    }

    // 2. strategyConfig 업데이트 (새로 생성되는 전략에 적용)
    if (this.tradingSystem.strategyConfig) {
      Object.assign(this.tradingSystem.strategyConfig, {
        stopLossPercent: params.stopLossPercent,
        takeProfitPercent: params.takeProfitPercent,
        trailingStopPercent: params.trailingStopPercent,
        buyThreshold: params.buyThreshold,
        sellThreshold: params.sellThreshold,
        technicalWeight: params.technicalWeight,
        newsWeight: params.technicalWeight ? (1 - params.technicalWeight) : undefined
      });
    }

    // 3. 기존 전략 인스턴스들 업데이트
    if (this.tradingSystem.strategies) {
      for (const [, strategy] of this.tradingSystem.strategies.entries()) {
        if (strategy.config) {
          Object.assign(strategy.config, {
            stopLossPercent: params.stopLossPercent,
            takeProfitPercent: params.takeProfitPercent,
            trailingStopPercent: params.trailingStopPercent,
            buyThreshold: params.buyThreshold,
            sellThreshold: params.sellThreshold,
            technicalWeight: params.technicalWeight,
            newsWeight: params.technicalWeight ? (1 - params.technicalWeight) : undefined
          });
        }
      }
    }

    // 4. 투자 비율 업데이트
    if (params.investmentRatio !== undefined) {
      this.tradingSystem.investmentRatio = params.investmentRatio;
    }

    console.log('✅ 새 파라미터 적용 완료 (19개 파라미터)');
    console.log(`   RSI: ${params.rsiPeriod}/${params.rsiOversold}/${params.rsiOverbought}`);
    console.log(`   MACD: ${params.macdFast}/${params.macdSlow}/${params.macdSignal}`);
    console.log(`   BB: ${params.bbPeriod}/±${params.bbStdDev}`);
    console.log(`   EMA: ${params.emaShort}/${params.emaMid}/${params.emaLong}`);
    console.log(`   손절/익절/트레일링: ${params.stopLossPercent}%/${params.takeProfitPercent}%/${params.trailingStopPercent}%`);
    console.log(`   매매 임계: 매수 ${params.buyThreshold} / 매도 ${params.sellThreshold}`);
    console.log(`   거래량: ×${params.volumeMultiplier}/${params.volumePeriod}기간`);
    if (params.technicalWeight) {
      console.log(`   가중치: 기술 ${(params.technicalWeight * 100).toFixed(0)}% / 뉴스 ${((1 - params.technicalWeight) * 100).toFixed(0)}%`);
    }
    if (params.investmentRatio) {
      console.log(`   투자비율: ${(params.investmentRatio * 100).toFixed(1)}%`);
    }
  }

  stop() {
    // 최적화 스케줄러 중지
    this.stopOptimizationScheduler();

    // 알림 모니터링 중지
    if (this.notificationInterval) {
      clearInterval(this.notificationInterval);
      this.notificationInterval = null;
    }

    if (this.server) {
      this.server.close(() => {
        console.log('\n🌐 대시보드 서버 종료');
        this.logger.info('Dashboard server stopped');
      });
    }
  }
}

export default DashboardServer;
