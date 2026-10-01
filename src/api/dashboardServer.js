import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { Server as SocketIOServer } from 'socket.io';
import Logger, { resolveLogDirectory } from '../utils/logger.js';

// Route modules
import createAccountRoutes from './routes/account.js';
import createLiveCredentialsRoutes from './routes/liveCredentials.js';
import createPortfolioRoutes from './routes/portfolio.js';
import { projectReadOnlyPaperPortfolioAnalysis } from './readOnlyPaperPortfolio.js';
import createNewsRoutes from './routes/news.js';
import createMarketRoutes from './routes/market.js';
import createOptimizationRoutes from './routes/optimization.js';
import createConfigRoutes from './routes/config.js';
import createTradingRoutes from './routes/trading.js';
import createAiRoutes from './routes/ai.js';
import createResearchRoutes from './routes/research.js';
import AIAdvisorService from '../ai/aiAdvisorService.js';
import MonitoringSessionService from '../ai/monitoringSessionService.js';
import { createDashboardAuth, createOriginGuard } from './auth.js';
import { createDefaultManualOrderIdempotencyStore } from './manualOrderIdempotencyStore.js';
import { resolveDashboardTls } from './dashboardTls.js';
import {
  getMarketDataProvider,
  MARKET_DATA_FRESHNESS,
  UpbitCacheMarketDataProvider
} from './marketDataProvider.js';
import { readLogTail } from '../utils/readLogTail.js';
import { parseRecentLogErrors } from '../utils/parseRecentLogErrors.js';
import { resolveOptimizationStoragePaths } from '../runtime/optimizationStorage.js';
import { RealtimeHub } from './realtimeHub.js';
import { NewsAccumulator, MAX_NEWS_RETENTION_LIMIT } from './newsAccumulator.js';
import { DashboardReadCache } from './dashboardReadCache.js';
import { DashboardReadiness } from './dashboardReadiness.js';
import { OptimizationScheduler } from './optimizationScheduler.js';
import { NotificationMonitor } from './notificationMonitor.js';
import { quoteOfSystem } from '../exchange/marketCodes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// 프로젝트 루트: src/api/ 에서 2단계 상위
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

class DashboardServer {
  constructor(tradingSystem, port = 3000, options = {}) {
    const newsRetentionLimit = options.newsRetentionLimit ?? MAX_NEWS_RETENTION_LIMIT;
    if (!Number.isSafeInteger(newsRetentionLimit) ||
      newsRetentionLimit < 1 || newsRetentionLimit > MAX_NEWS_RETENTION_LIMIT) {
      throw new RangeError(`newsRetentionLimit must be an integer from 1 to ${MAX_NEWS_RETENTION_LIMIT}`);
    }
    this.app = express();
    // The production Nginx proxy connects over loopback. Trust only that hop so
    // req.ip reflects the originating client for login throttling without
    // accepting forwarded-address headers from arbitrary peers.
    this.app.set('trust proxy', options.trustProxy ?? 'loopback');
    this.port = port;
    this.tradingSystem = tradingSystem;
    const publicMarketDataSource = options.publicMarketDataSource;
    if (publicMarketDataSource !== undefined && publicMarketDataSource !== null) {
      const requiredReads = ['getMarkets', 'getTicker', 'getMinuteCandles'];
      const missingRead = requiredReads.find(method => typeof publicMarketDataSource[method] !== 'function');
      if (missingRead) {
        throw new TypeError(`publicMarketDataSource must provide ${requiredReads.join(', ')}.`);
      }
    }
    this.publicMarketDataSource = publicMarketDataSource ?? null;
    const dashboardEnv = options.env || process.env;
    this.optimizationStoragePaths = resolveOptimizationStoragePaths({
      env: dashboardEnv,
      cwd: options.cwd || process.cwd(),
      projectRoot: PROJECT_ROOT,
      legacyBase: 'projectRoot',
      stateDir: options.optimizationStateDir ?? tradingSystem?.config?.stateDir,
      optimizationStateFile: options.optimizationStateFile,
      optimizationHistoryFile: options.optimizationHistoryFile,
      optimalConfigFile: options.optimalConfigFile
    });
    this.optimizationStateFile = this.optimizationStoragePaths.optimizationStateFile.absolutePath;
    this.optimizationHistoryFile = this.optimizationStoragePaths.optimizationHistoryFile.absolutePath;
    this.optimalConfigFile = this.optimizationStoragePaths.optimalConfigFile.absolutePath;
    this.liveCredentialStore = options.liveCredentialStore || null;
    const setupModeFromEnv = ['1', 'true', 'yes', 'on'].includes(
      String(dashboardEnv.DASHBOARD_LIVE_CREDENTIAL_SETUP_MODE || '').trim().toLowerCase()
    );
    this.liveCredentialSetupMode = options.liveCredentialSetupMode === undefined
      ? setupModeFromEnv
      : options.liveCredentialSetupMode === true;
    this.liveCredentialEnrollmentReady = Boolean(
      this.liveCredentialStore &&
      typeof this.liveCredentialStore.setCredentialValidator === 'function' &&
      typeof this.liveCredentialStore.setUpdateCallback === 'function' &&
      typeof options.validateLiveCredentials === 'function' &&
      typeof options.onLiveCredentialsSaved === 'function'
    );
    if (this.liveCredentialStore) {
      this.liveCredentialStore.setCredentialValidator?.(options.validateLiveCredentials || null);
      this.liveCredentialStore.setUpdateCallback?.(options.onLiveCredentialsSaved || null);
    }
    // 뉴스 누적 저장소 (서버 시작 이후 모든 뉴스 누적) — 비-HTTP 책임은
    // NewsAccumulator 모듈이 소유하고 서버는 호환 위임만 유지한다.
    this.newsAccumulator = new NewsAccumulator({ retentionLimit: newsRetentionLimit });
    this.paperForwardCohortRootDir = options.paperForwardCohortRootDir;
    this.momentumShadowProjectionCacheMs = options.momentumShadowProjectionCacheMs;
    const portfolioPath = tradingSystem?.virtualPortfolioFile ||
      tradingSystem?.config?.virtualPortfolioFile ||
      path.join(PROJECT_ROOT, 'dry_portfolio.json');
    const idempotencyFile = tradingSystem?.config?.manualOrderIdempotencyFile ||
      `${path.resolve(portfolioPath)}.manual_order_idempotency.json`;
    this.manualOrderIdempotencyStore = options.manualOrderIdempotencyStore ||
      createDefaultManualOrderIdempotencyStore(tradingSystem, idempotencyFile, {
        writerLockPath: `${path.resolve(portfolioPath)}.manual_order_writer.lock`
      });
    this.releaseManualOrderWriterLockOnStop = options.releaseManualOrderWriterLockOnStop ??
      options.manualOrderIdempotencyStore == null;
    this.logger = options.logger || new Logger('debug', {
      logDir: resolveLogDirectory(PROJECT_ROOT, dashboardEnv.STAGING_OUTPUT_DIR)
    });
    this.tlsConfig = resolveDashboardTls(dashboardEnv, PROJECT_ROOT);
    if (this.tlsConfig.error) {
      throw new Error(this.tlsConfig.error);
    }
    this.protocol = this.tlsConfig.enabled ? 'https' : 'http';

    // API/소켓 데이터 평면 인증. 정적 셸은 공개이며, 대시보드 토큰이 없으면
    // 루프백 전용 바인딩으로 강제된다 (src/api/auth.js 참고).
    this.auth = createDashboardAuth(dashboardEnv, {
      loginRateLimiter: options.loginRateLimiter
    });
    this.originGuard = createOriginGuard(this.auth.corsOrigins);

    // AI 자문은 로컬 구독 CLI를 호출하는 읽기 전용 계층이다. 이 서비스는
    // 주문 객체나 기존 전략 설정을 참조만 하며 자동주문 경로를 소유하지
    // 않는다.
    this.aiAdvisor = new AIAdvisorService({
      workspaceRoot: PROJECT_ROOT,
      config: tradingSystem?.config
    });
    this.monitoringSessions = new MonitoringSessionService({
      workspaceRoot: PROJECT_ROOT,
      config: tradingSystem?.config,
      advisor: this.aiAdvisor
    });

    // HTTP 서버 및 Socket.io 초기화
    this.httpServer = this.tlsConfig.enabled
      ? createHttpsServer({ cert: this.tlsConfig.cert, key: this.tlsConfig.key }, this.app)
      : createServer(this.app);
    this.server = null;
    this.startPromise = null;
    this.io = new SocketIOServer(this.httpServer, {
      // WebSocket 업그레이드는 CORS 대상이 아니므로 Origin을 직접 검사하고,
      // 실제 인가는 handshake auth 토큰(socketMiddleware)이 담당한다.
      cors: { origin: false },
      allowRequest: (req, callback) => {
        callback(null, this.originGuard.isOriginAllowed(req.headers.origin, req.headers.host));
      }
    });

    // SSE+Socket.IO 실시간 브로드캐스트 허브 (GET /api/stream). 네이티브
    // iOS 앱처럼 Socket.IO를 쓰지 않는 클라이언트가 같은 이벤트를 받는다.
    this.realtimeHub = new RealtimeHub({ io: this.io });

    // API 응답 캐싱 (rate limit 방지) — TTL·인플라이트 dedup은 read cache 소유
    this.readCache = this._readCache();
    this.marketDataProvider = this.publicMarketDataSource
      ? new UpbitCacheMarketDataProvider(this)
      : (options.marketDataProvider || new UpbitCacheMarketDataProvider(this));

    // 알림 모니터 — 번들 제안/속보 스캔과 중복 방지 상태는 모니터 소유
    this.notificationMonitor = this._notificationMonitor();

    // 자동 최적화 스케줄러 — 상태 파일/타이머/캔들 수집은 스케줄러 소유
    this.optimizationScheduler = this._optimizationScheduler();
    this.optimizationScheduler.loadState();

    // readiness 계산 — 서비스/트레이딩 준비도 빌더
    this.readiness = this._dashboardReadiness();

    if (this.tradingSystem?.setAnalysisCallback) {
      this.tradingSystem.setAnalysisCallback((cycle) => this.monitoringSessions.ingestCycle(cycle));
    }
    this.monitoringSessions.setUpdateCallback((update) => {
      if (!this.io) return;
      const eventName = update.type === 'consultation'
        ? 'ai-consultation'
        : update.type === 'session'
          ? 'ai-session-update'
          : 'ai-monitoring-event';
      this.emitRealtimeEvent(eventName, update);
    });

    this.setupMiddleware();
    this.setupRoutes();
    this.setupSocketIO();
    this.setupErrorHandler();
  }

  // ── 지연 모듈 팩토리 ─────────────────────────────────────────────
  // 테스트가 Object.create(prototype)로 생성자를 우회해 부분 필드만
  // 채운 인스턴스를 만들 수 있으므로, 추출된 모듈은 첫 사용 시 생성한다.
  _newsAccumulator() {
    this.newsAccumulator = this.newsAccumulator ||
      new NewsAccumulator({ retentionLimit: MAX_NEWS_RETENTION_LIMIT });
    return this.newsAccumulator;
  }

  _readCache() {
    this.readCache = this.readCache || new DashboardReadCache({
      getTradingSystem: () => this.tradingSystem,
      getPublicMarketDataSource: () => this.publicMarketDataSource
    });
    return this.readCache;
  }

  _realtimeHub() {
    this.realtimeHub = this.realtimeHub || new RealtimeHub({ io: this.io });
    return this.realtimeHub;
  }

  _notificationMonitor() {
    this.notificationMonitor = this.notificationMonitor || new NotificationMonitor({
      getTradingSystem: () => this.tradingSystem,
      logger: this.logger || console,
      monitoringSessions: this.monitoringSessions,
      realtimeHub: this._realtimeHub(),
      getActiveHoldings: () => this.getActiveHoldings(),
      marketDataServer: this
    });
    return this.notificationMonitor;
  }

  _optimizationScheduler() {
    this.optimizationScheduler = this.optimizationScheduler || new OptimizationScheduler({
      getTradingSystem: () => this.tradingSystem,
      getPublicMarketDataSource: () => this.publicMarketDataSource,
      optimizationStoragePaths: this.optimizationStoragePaths,
      getStateFile: () => this.optimizationStateFile,
      getHistoryFile: () => this.optimizationHistoryFile,
      getOptimalConfigFile: () => this.optimalConfigFile,
      collectCandleData: (market, unit, totalCount, maxPerRequest) =>
        this.collectCandleData(market, unit, totalCount, maxPerRequest),
      createParameterOptimizer: options => this.createParameterOptimizer(options),
      applyOptimalParameters: params => this.applyOptimalParameters(params),
      projectRoot: PROJECT_ROOT,
      logger: this.logger || console
    });
    return this.optimizationScheduler;
  }

  _dashboardReadiness() {
    this.readiness = this.readiness || new DashboardReadiness({
      getTradingSystem: () => this.tradingSystem,
      getPublicMarketDataSource: () => this.publicMarketDataSource,
      isHttpListening: () => this.httpServer?.listening === true
    });
    return this.readiness;
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

  // ── NewsAccumulator 위임 (하위 호환) ────────────────────────────
  get accumulatedNews() { return this._newsAccumulator().items; }
  set accumulatedNews(value) { this._newsAccumulator().items = value; }
  get newsSeenKeys() { return this._newsAccumulator().seenKeys; }
  set newsSeenKeys(value) { this._newsAccumulator().seenKeys = value; }
  get newsAccumulatorStartTime() { return this._newsAccumulator().startedAt; }
  set newsAccumulatorStartTime(value) { this._newsAccumulator().startedAt = value; }
  get newsRetentionLimit() { return this._newsAccumulator().retentionLimit; }
  set newsRetentionLimit(value) { this._newsAccumulator().retentionLimit = value; }

  // 뉴스 고유 키 생성 (중복 체크용)
  generateNewsKey(news) { return this._newsAccumulator().generateKey(news); }

  // 뉴스 누적 (중복 제거)
  accumulateNews(newsList, source = 'general') {
    return this._newsAccumulator().add(newsList, source);
  }

  // 누적된 뉴스 조회
  getAccumulatedNews(options = {}) {
    return this._newsAccumulator().getNews(options);
  }

  // ── DashboardReadCache 위임 (하위 호환) ─────────────────────────
  get cache() { return this._readCache().cache; }
  set cache(value) { this._readCache().cache = value; }
  get cacheTTL() { return this._readCache().ttl; }
  set cacheTTL(value) { this._readCache().ttl = value; }
  get inFlightAccountRequests() { return this._readCache().inFlightAccountRequests; }
  set inFlightAccountRequests(value) { this._readCache().inFlightAccountRequests = value; }
  get inFlightTickerRequests() { return this._readCache().inFlightTickerRequests; }
  set inFlightTickerRequests(value) { this._readCache().inFlightTickerRequests = value; }

  // 캐시 조회 (TTL 체크)
  getCacheEntry(key) { return this._readCache().getEntry(key); }
  getCache(key) { return this._readCache().get(key); }
  setCache(key, data, time = Date.now(), metadata = {}) {
    return this._readCache().set(key, data, time, metadata);
  }
  async getObserverCachedAccountInfo() { return this._readCache().getObserverAccountInfo(); }
  async getCachedTickerWithMetadata(coins) { return this._readCache().getTickerWithMetadata(coins); }
  async getCachedTicker(coins) { return this._readCache().getTicker(coins); }

  setupMiddleware() {
    // Read-only credential scope must run before CORS can answer an API preflight.
    this.app.use('/api', this.auth.readOnlyScopeMiddleware);
    this.app.use(this.originGuard.middleware);
    this.app.use(express.json());
    this.app.use(express.static(path.join(PROJECT_ROOT, 'public')));
  }

  setupRoutes() {
    // 인프라 프로브는 /api 네임스페이스 밖, 토큰 게이트 밖에 둔다.
    // 프로세스/런타임 boolean만 담고 포지션·설정·계좌 정보는 노출하지 않는다.
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        uptimeSec: Math.floor(process.uptime()),
        pid: process.pid,
        timestamp: new Date().toISOString()
      });
    });
    this.app.get('/ready', (req, res) => {
      this.withRateCoordinatorReadiness(this.buildReadiness())
        .then(readiness => res.status(readiness.ready ? 200 : 503).json(readiness));
    });
    this.app.get('/service-ready', (req, res) => {
      this.withRateCoordinatorReadiness(this.buildServiceReadiness())
        .then(readiness => res.status(readiness.ready ? 200 : 503).json(readiness));
    });
    this.app.get('/trading-ready', (req, res) => {
      this.withRateCoordinatorReadiness(this.buildTradingReadiness())
        .then(readiness => res.status(readiness.ready ? 200 : 503).json(readiness));
    });

    // 공개 인증 엔드포인트는 가드보다 먼저 마운트한다.
    this.app.get('/api/auth/status', this.auth.statusHandler);
    this.app.post('/api/auth/login', this.auth.loginHandler);
    this.app.use('/api', this.auth.middleware);

    if (this.tradingSystem?.readOnlyObserver) {
      this.app.use('/api', (req, res, next) => {
        // Portfolio snapshots are allowed because the observer redirects them
        // to its isolated history file; every other non-read request could
        // mutate the mock wallet, config, paper session, or invoke an order.
        if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) ||
          (req.method === 'POST' && req.path === '/portfolio/snapshot')) {
          return next();
        }
        return res.status(403).json({
          success: false,
          readOnlyObserver: true,
          error: '읽기 전용 forward ledger observer에서는 변경 요청을 사용할 수 없습니다.'
        });
      });
    }

    // ========================================
    // 모듈화된 라우트 마운트
    // ========================================
    this.app.use('/api', createAccountRoutes(this));
    this.app.use('/api', createLiveCredentialsRoutes(this));
    this.app.use('/api', createPortfolioRoutes(this));
    this.app.use('/api', createNewsRoutes(this));
    this.app.use('/api', createMarketRoutes(this));
    this.app.use('/api', createOptimizationRoutes(this));
    this.app.use('/api', createConfigRoutes(this));
    this.app.use('/api', createTradingRoutes(this));
    this.app.use('/api', createAiRoutes(this));
    this.app.use('/api', createResearchRoutes(this, {
      paperForwardCohortRootDir: this.paperForwardCohortRootDir,
      momentumShadowProjectionCacheMs: this.momentumShadowProjectionCacheMs
    }));

    // ========================================
    // 추가 라우트 (dashboardServer 전용)
    // 기존 모듈로 분리된 라우트는 위에서 마운트됨
    // 아래는 dashboardServer에만 있는 추가 라우트
    // ========================================
    // 서버발송 이벤트 스트림 — Socket.IO 브로드캐스트와 동일한 이벤트를
    // 인증된 클라이언트(모바일 토큰 포함)에게 SSE로 전달한다.
    this.app.get('/api/stream', (req, res) => this._realtimeHub().addSseClient(req, res));

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

        // Keep log reads bounded so a large file cannot block the trading loop.
        const logDir = this.logger.logDir;
        const today = now.toISOString().split('T')[0];
        const errorLogFile = path.join(logDir, `error-${today}.log`);
        let recentErrors = [];

        const errorTail = await readLogTail(errorLogFile, { maxLines: 1000, maxBytes: 512 * 1024 });
        recentErrors = parseRecentLogErrors(errorTail.lines);

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

        const runtimeSafety = typeof this.tradingSystem.getRuntimeSafetyStatus === 'function'
          ? this.tradingSystem.getRuntimeSafetyStatus()
          : {};
        res.json({
          isRunning: this.tradingSystem.isRunning,
          mode: this.tradingSystem.dryRun ? 'DRY_RUN' : 'LIVE',
          ...runtimeSafety,
          readOnlyObserver: this.tradingSystem.readOnlyObserver === true,
          strategyMode: this.tradingSystem.strategyMode,
          maxPositions: this.tradingSystem.maxPositions,
          entryDelayMs: this.tradingSystem.isScalpingMode
            ? [this.tradingSystem.entryDelayMinMs, this.tradingSystem.entryDelayMaxMs]
            : null,
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

          for (const strategy of this.tradingSystem.strategies.values()) {
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
        if (this.tradingSystem.readOnlyObserver === true) {
          if (typeof this.tradingSystem.getPaperValidationStatus !== 'function') {
            return res.status(503).json({ readOnlyObserver: true, error: 'paper ledger status unavailable' });
          }
          const paperStatus = await this.tradingSystem.getPaperValidationStatus();
          return res.json(projectReadOnlyPaperPortfolioAnalysis(paperStatus));
        }

        const holdings = [];
        let totalValue = 0;
        let totalCost = 0;

        // Read holdings from the active account mode. LIVE must never reuse a
        // stale virtual portfolio left on the process.
        const isDryRun = this.tradingSystem.dryRun === true;
        const liveAccounts = isDryRun ? null : await this.tradingSystem.getAccountInfo();
        const portfolioHoldings = isDryRun
          ? this.tradingSystem.virtualPortfolio?.holdings
          : new Map((Array.isArray(liveAccounts) ? liveAccounts : [])
            .filter(account => account?.currency && account.currency !== quoteOfSystem(this.tradingSystem))
            .map(account => {
              const amount = Number(account.balance);
              const avgPrice = Number(account.avg_buy_price) || 0;
              return [`${quoteOfSystem(this.tradingSystem)}-${account.currency}`, { amount, avgPrice }];
            })
            .filter(([, holding]) => Number.isFinite(holding.amount) && holding.amount > 0));

        // Map 또는 Object 모두 처리
        const isMap = portfolioHoldings instanceof Map;
        const holdingsEntries = isMap
          ? Array.from(portfolioHoldings.entries())
          : Object.entries(portfolioHoldings || {});

        const coins = holdingsEntries.map(([coin]) => coin);
        const marketSnapshot = coins.length > 0
          ? await getMarketDataProvider(this).getSnapshot(coins, {
            freshness: MARKET_DATA_FRESHNESS.CACHED
          })
          : {
            tickers: [],
            priceMap: new Map(),
            freshPriceMap: new Map(),
            sourceAsOfByMarket: new Map(),
            quoteFreshnessByMarket: new Map(),
            fetchedAtByMarket: new Map(),
            sourceAsOf: null,
            fetchedAt: null,
            complete: true,
            allQuotesFresh: true,
            freshMarkets: [],
            staleMarkets: [],
            sourceSkewMs: null,
            captureSkewMs: null,
            snapshotSource: 'none',
            fallbackReason: null,
            unavailableMarkets: []
          };

        if (holdingsEntries.length > 0) {
          for (const [coin, holding] of holdingsEntries) {
            const ticker = marketSnapshot.tickers.find(item => item.market === coin) || null;
            const currentPrice = marketSnapshot.freshPriceMap.get(coin) ?? null;
            const valuationAvailable = Number.isFinite(currentPrice) && currentPrice > 0;
            const change24h = ticker?.signed_change_rate;
            const change24hAvailable = change24h !== null && change24h !== undefined &&
              Number.isFinite(Number(change24h));
            const currentValue = valuationAvailable ? holding.amount * currentPrice : null;
            const costBasis = holding.amount * holding.avgPrice;
            const profit = valuationAvailable ? currentValue - costBasis : null;
            const profitPercent = valuationAvailable && costBasis > 0
              ? ((currentValue / costBasis) - 1) * 100
              : null;

            if (valuationAvailable) totalValue += currentValue;
            totalCost += costBasis;

            holdings.push({
              coin,
              symbol: coin.split('-')[1],
              amount: holding.amount,
              avgPrice: holding.avgPrice,
              currentPrice,
              currentValue: currentValue === null ? null : Math.round(currentValue),
              costBasis: Math.round(costBasis),
              profit: profit === null ? null : Math.round(profit),
              profitPercent: profitPercent === null ? null : profitPercent.toFixed(2),
              change24h: change24hAvailable
                ? (Number(change24h) * 100).toFixed(2)
                : null,
              valuationAvailable,
              sourceAsOf: marketSnapshot.sourceAsOfByMarket.get(coin) ?? null,
              quoteFreshnessReason: marketSnapshot.quoteFreshnessByMarket.get(coin)?.reason ?? null,
              fetchedAt: marketSnapshot.fetchedAtByMarket?.get(coin) ?? marketSnapshot.fetchedAt,
              weight: null
            });
          }
        }

        const valuationAvailable = holdings.every(holding => holding.valuationAvailable === true);
        if (!valuationAvailable) totalValue = null;

        // KRW 잔액 추가
        const krwBalance = isDryRun
          ? (this.tradingSystem.virtualPortfolio?.krwBalance || 0)
          : (this.tradingSystem.getKRWBalance(liveAccounts) || 0);

        const totalAssets = valuationAvailable ? totalValue + krwBalance : null;

        // 비중 계산
        if (valuationAvailable) {
          holdings.forEach(h => {
            h.weight = totalAssets > 0 ? ((h.currentValue / totalAssets) * 100).toFixed(1) : '0';
          });
        }

        // 수익률 순 정렬
        const valuedHoldings = holdings.filter(holding => holding.valuationAvailable === true);
        const topGainers = [...valuedHoldings]
          .sort((a, b) => parseFloat(b.profitPercent) - parseFloat(a.profitPercent)).slice(0, 3);
        const topLosers = [...valuedHoldings]
          .sort((a, b) => parseFloat(a.profitPercent) - parseFloat(b.profitPercent)).slice(0, 3);

        // 비중 순 정렬
        const byWeight = valuationAvailable
          ? [...holdings].sort((a, b) => parseFloat(b.weight) - parseFloat(a.weight))
          : holdings;

        res.json({
          holdings: byWeight,
          summary: {
            totalHoldings: holdings.length,
            totalValue: totalValue === null ? null : Math.round(totalValue),
            totalCost: Math.round(totalCost),
            totalProfit: totalValue === null ? null : Math.round(totalValue - totalCost),
            totalProfitPercent: totalValue !== null && totalCost > 0
              ? (((totalValue / totalCost) - 1) * 100).toFixed(2)
              : null,
            krwBalance: Math.round(krwBalance),
            krwWeight: totalAssets !== null && totalAssets > 0
              ? ((krwBalance / totalAssets) * 100).toFixed(1)
              : null,
            totalAssets: totalAssets === null ? null : Math.round(totalAssets),
            valuationAvailable,
            valuationStatus: valuationAvailable
              ? 'available'
              : marketSnapshot.staleMarkets?.length > 0 ? 'stale' : 'unavailable',
            valuationAsOf: marketSnapshot.sourceAsOf,
            sourceAsOf: marketSnapshot.sourceAsOf,
            fetchedAt: marketSnapshot.fetchedAt,
            staleMarkets: marketSnapshot.staleMarkets || [],
            sourceSkewMs: marketSnapshot.sourceSkewMs ?? null,
            captureSkewMs: marketSnapshot.captureSkewMs ?? null,
            snapshotSource: marketSnapshot.snapshotSource ?? 'upstream',
            fallbackReason: marketSnapshot.fallbackReason ?? null,
            unavailableMarkets: marketSnapshot.unavailableMarkets
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

        // 현재가 조회
        let ticker = null;
        let currentPrice = 0;
        try {
          ticker = await getMarketDataProvider(this).getTickers(coin, {
            freshness: MARKET_DATA_FRESHNESS.FRESH
          });
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
          const candles = await getMarketDataProvider(this).getMinuteCandles(coin, 5, 50);
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
    this.app.use((err, req, res, _next) => {
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
    this.io.use(this.auth.socketMiddleware);

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
    this._notificationMonitor().start();
  }

  // ── RealtimeHub / NotificationMonitor 위임 (하위 호환) ──────────
  get sseClients() { return this._realtimeHub().sseClients; }
  set sseClients(value) { this._realtimeHub().sseClients = value; }
  get lastSignals() { return this._notificationMonitor().lastSignals; }
  set lastSignals(value) { this._notificationMonitor().lastSignals = value; }
  get lastBreakingNews() { return this._notificationMonitor().lastBreakingNews; }
  set lastBreakingNews(value) { this._notificationMonitor().lastBreakingNews = value; }

  emitRealtimeEvent(name, payload) {
    this._realtimeHub().emit(name, payload);
  }

  /**
   * 자동매매 거래 알림 전송
   */
  emitTradeNotification(tradeInfo) {
    this._notificationMonitor().emitTradeNotification(tradeInfo);
  }

  /**
   * 알림 모니터링 시작
   */
  startNotificationMonitoring() {
    this._notificationMonitor().start();
  }

  /**
   * 새로운 신호와 속보 체크 후 알림 발송
   */
  async checkAndEmitNotifications() {
    return this._notificationMonitor().checkAndEmit();
  }

  /**
   * 번들 제안 생성 (A코인 매도 → B코인 매수)
   */
  async generateBundleSuggestions() {
    return this._notificationMonitor().generateBundleSuggestions();
  }

  /**
   * 속보 체크 및 알림
   */
  async checkBreakingNews() {
    return this._notificationMonitor().checkBreakingNews();
  }

  start() {
    if (this.startPromise) return this.startPromise;
    if (this.httpServer.listening) {
      this.server = this.httpServer;
      this.startPromise = Promise.resolve(this.server);
      return this.startPromise;
    }

    // 거래 알림 콜백 설정
    if (this.tradingSystem?.setTradeCallback) {
      this.tradingSystem.setTradeCallback((tradeInfo) => {
        this.emitTradeNotification(tradeInfo);
        this.monitoringSessions.ingestTrade(tradeInfo).catch(() => undefined);
      });
      console.log('   🔔 자동매매 알림 콜백 설정됨');
    }

    for (const warning of this.auth.warnings) {
      console.warn(`⚠️  ${warning}`);
      this.logger.warn(warning);
    }

    const server = this.httpServer;
    this.server = server;
    let listening = false;
    const startAttempt = new Promise((resolve, reject) => {
      // Attach before listen(): a bind error must reject startup instead of
      // leaving callers to mistake a constructed HTTP server for a ready one.
      server.on('error', error => {
        this.logger.error('Server error', {
          error: error.message,
          code: error.code,
          stack: error.stack
        });

        if (error.code === 'EADDRINUSE') {
          this.logger.error(`Port ${this.port} is already in use`);
        }

        if (!listening) reject(error);
      });

      Promise.resolve()
        .then(async () => {
          const trader = this.tradingSystem;
          if (typeof trader?.upbit?.assertRateCoordinatorReady === 'function') {
            await trader.upbit.assertRateCoordinatorReady();
          }
          const mutableTrader = trader && trader.readOnlyObserver !== true &&
            (typeof trader.dryRun === 'boolean' ||
              typeof trader.withManualPortfolioTransaction === 'function' ||
              typeof trader.submitLiveOrder === 'function');
          if (mutableTrader) {
            if (typeof this.manualOrderIdempotencyStore?.initialize !== 'function') {
              const error = new Error('Mutable dashboard requires profile writer lock initialization.');
              error.code = 'MANUAL_ORDER_WRITER_LOCK_UNAVAILABLE';
              throw error;
            }
            // Claim and validate this profile before listening. The startup
            // failure path below calls stop(), which releases an acquired lock.
            await this.manualOrderIdempotencyStore.initialize();
          }

          server.listen(this.port, this.auth.host, () => {
            listening = true;
            const address = server.address();
            const boundPort = typeof address === 'object' && address ? address.port : this.port;
            console.log(`\n🌐 대시보드 서버 시작: ${this.protocol}://${this.auth.host}:${boundPort}`);
            console.log(`   API 엔드포인트: ${this.protocol}://${this.auth.host}:${boundPort}/api`);
            console.log(`   🔐 인증: ${this.auth.enabled ? '대시보드 토큰 필요' : '비활성 (루프백 전용)'}`);
            console.log(`   📡 실시간 알림: Socket.io 활성화`);
            this.logger.info(`Dashboard server started on ${this.auth.host}:${boundPort} (auth=${this.auth.enabled})`);
            resolve(server);
          });
        })
        .catch(reject);
    });

    this.startPromise = startAttempt.catch(async error => {
      // Release Socket.IO, HTTP, and any scheduler initialized by the
      // constructor before surfacing the original bind/startup error.
      try {
        await this.stop();
      } catch (cleanupError) {
        this.logger.error('Dashboard startup cleanup failed', {
          error: cleanupError.message
        });
      }
      throw error;
    });

    return this.startPromise;
  }

  /**
   * Readiness verdict for infra probes. Reuses the trader's own fail-closed
   * accessors (risk data gap / analysis cycle gap) instead of re-deriving
   * freshness, so a stalled or stale loop reports not-ready the same way the
   * trading loop stops itself. Dashboard-only observers without an isRunning
   * trader report ready purely on the HTTP listener.
   */
  // ── DashboardReadiness 위임 (하위 호환) ─────────────────────────
  // 테스트가 Object.create(prototype)으로 생성자를 우회할 수 있으므로
  // 의존 모듈은 지연 생성한다.
  buildReadiness(now = Date.now()) {
    return this._dashboardReadiness().build(now);
  }

  /**
   * HTTP service readiness is intentionally separate from trading readiness:
   * a stopped or protective-only trader can still serve safe read-only status.
   */
  buildServiceReadiness(now = Date.now()) {
    return this._dashboardReadiness().buildService(now);
  }

  async withRateCoordinatorReadiness(readiness) {
    return this._dashboardReadiness().withRateCoordinator(readiness);
  }

  /**
   * Public readiness diagnostics for the process-local market-data scheduler.
   * Scheduler pressure is observable here but does not make the HTTP service
   * unready by itself; trading readiness continues to use the trader's
   * fail-closed analysis and risk health contracts above.
   */
  buildMarketDataSchedulerDiagnostics() {
    return this._dashboardReadiness().buildMarketDataSchedulerDiagnostics();
  }

  buildPublicMarketSnapshotDiagnostics() {
    return this._dashboardReadiness().buildPublicMarketSnapshotDiagnostics();
  }

  /**
   * Entry-capable readiness rejects observer-only runtimes even though they
   * may be fully healthy as an HTTP service.
   */
  buildTradingReadiness(now = Date.now()) {
    return this._dashboardReadiness().buildTrading(now);
  }

  // ── OptimizationScheduler 위임 (하위 호환) ──────────────────────
  get optimizationState() { return this._optimizationScheduler().state; }
  set optimizationState(value) { this._optimizationScheduler().state = value; }
  get optimizationTimer() { return this._optimizationScheduler().timer; }
  set optimizationTimer(value) { this._optimizationScheduler().timer = value; }

  // 최적화 상태 파일 경로
  getOptimizationStateFile() { return this._optimizationScheduler().stateFile; }
  // 비교 이력 파일 경로
  getOptimizationHistoryFile() { return this._optimizationScheduler().historyFile; }
  // active 설정 파일 경로 (읽기 전용)
  getOptimalConfigFile() { return this._optimizationScheduler().optimalConfigFile; }
  loadOptimizationState() { return this._optimizationScheduler().loadState(); }
  saveOptimizationState(state = this.optimizationState) {
    return this._optimizationScheduler().save(state);
  }
  startOptimizationScheduler() { return this._optimizationScheduler().start(); }
  stopOptimizationScheduler() { return this._optimizationScheduler().stop(); }
  async runOptimizationCycle() { return this._optimizationScheduler().runCycle(); }
  async createParameterOptimizer(options) {
    return this._optimizationScheduler().createParameterOptimizer(options);
  }
  async collectCandleData(market, unit, totalCount, maxPerRequest = 200) {
    return this._optimizationScheduler().collectCandleData(market, unit, totalCount, maxPerRequest);
  }
  applyOptimalParameters(params) {
    return this._optimizationScheduler().applyOptimalParameters(params);
  }

  stop() {
    this.optimizationScheduler?.stop();
    this.realtimeHub?.stop();
    this.notificationMonitor?.stop();

    return new Promise(resolve => {
      const logClosed = async () => {
        try {
          await this.publicMarketDataSource?.flushSnapshot?.();
        } catch (error) {
          this.logger.error('Public market snapshot flush failed', {
            error: error.message,
            code: error.code
          });
        }
        try {
          if (this.releaseManualOrderWriterLockOnStop) {
            this.manualOrderIdempotencyStore?.releaseWriterLock?.();
          }
        } catch (error) {
          this.logger.error('Manual order writer lock release failed', {
            error: error.message,
            code: error.code
          });
        }
        console.log('\n🌐 대시보드 서버 종료');
        this.logger.info('Dashboard server stopped');
        resolve();
      };
      // io.close() also closes the bound HTTP server after disconnecting sockets.
      if (this.io) {
        this.io.close(logClosed);
        this.io = null;
        this.server = null;
      } else if (this.server) {
        this.server.close(logClosed);
        this.server = null;
      } else {
        logClosed().finally(resolve);
      }
    });
  }
}

export default DashboardServer;
