import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
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
import { getPaperEvidenceMutationLock } from '../research/paperEvidenceMutationGuard.js';
import { resolveDashboardTls } from './dashboardTls.js';
import {
  getMarketDataProvider,
  MARKET_DATA_FRESHNESS,
  UpbitCacheMarketDataProvider
} from './marketDataProvider.js';
import { getMarketDataAdapterKind } from '../market-data/marketDataAdapters.js';
import { readLogTail } from '../utils/readLogTail.js';
import { parseRecentLogErrors } from '../utils/parseRecentLogErrors.js';
import { resolveOptimizationStoragePaths } from '../runtime/optimizationStorage.js';
import { fetchCompleteUpbitCandleHistory } from '../market-data/completeUpbitCandleHistory.js';
import { appendOptimizerHistory } from '../runtime/optimizerHistoryStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// 프로젝트 루트: src/api/ 에서 2단계 상위
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MAX_NEWS_RETENTION_LIMIT = 2000;
const NEWS_ACCUMULATION_BATCH_SIZE = 2000;

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
    this.newsRetentionLimit = newsRetentionLimit;
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

    // SSE 클라이언트 (GET /api/stream). 네이티브 iOS 앱처럼 Socket.IO를 쓰지
    // 않는 클라이언트가 같은 브로드캐스트 이벤트를 받을 수 있게 한다.
    this.sseClients = new Set();
    this.sseHeartbeat = setInterval(() => {
      for (const client of this.sseClients) {
        try {
          client.write(': hb\n\n');
        } catch {
          this.sseClients.delete(client);
        }
      }
    }, 25000);
    this.sseHeartbeat.unref?.();

    // API 응답 캐싱 (rate limit 방지)
    this.cache = new Map();
    this.inFlightAccountRequests = new Map();
    this.inFlightTickerRequests = new Map();
    this.cacheTTL = {
      ticker: 1000,      // 시세: 1초
      account: 1000,     // 계좌: 1초
      statistics: 1000,  // 통계: 1초
      candles: 1000      // 캔들: 1초
    };
    this.marketDataProvider = this.publicMarketDataSource
      ? new UpbitCacheMarketDataProvider(this)
      : (options.marketDataProvider || new UpbitCacheMarketDataProvider(this));

    // 알림 상태 추적
    this.lastSignals = new Map();        // 마지막 신호 저장 (중복 알림 방지)
    this.lastBreakingNews = new Set();   // 마지막 속보 ID (중복 방지)
    this.notificationInterval = null;    // 알림 모니터링 인터벌
    this.notificationInitialTimer = null;

    // 뉴스 누적 저장소 (서버 시작 이후 모든 뉴스 누적)
    this.accumulatedNews = [];           // 최신순으로 정렬된 보존 뉴스
    this.newsSeenKeys = new Set();       // 보존 뉴스의 중복 키 (title+link)
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

    for (let batchStart = 0; batchStart < newsList.length; batchStart += NEWS_ACCUMULATION_BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + NEWS_ACCUMULATION_BATCH_SIZE, newsList.length);
      let batchAdded = false;

      for (let index = batchStart; index < batchEnd; index++) {
        const news = newsList[index];
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
        batchAdded = true;
      }

      // Bound temporary rows and sort/evict once per input batch, rather than
      // sorting the retained array after every incoming article.
      if (batchAdded) {
        this.accumulatedNews.sort((a, b) => {
          const timeA = new Date(a.timestamp || a.accumulatedAt);
          const timeB = new Date(b.timestamp || b.accumulatedAt);
          return timeB - timeA;
        });

        while (this.accumulatedNews.length > this.newsRetentionLimit) {
          const evicted = this.accumulatedNews.pop();
          this.newsSeenKeys.delete(this.generateNewsKey(evicted));
        }
      }
    }

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
  getCacheEntry(key) {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.time < (this.cacheTTL[key.split(':')[0]] || 2000)) {
      return cached;
    }
    return null;
  }

  getCache(key) {
    return this.getCacheEntry(key)?.data ?? null;
  }

  // 캐시 저장
  setCache(key, data, time = Date.now(), metadata = {}) {
    this.cache.set(key, { data, time, ...metadata });
  }

  // Observer GET routes share a short-lived account snapshot. Every caller
  // receives its own array and row objects so a response projection cannot
  // mutate another caller's view or the cached snapshot.
  async getObserverCachedAccountInfo() {
    const cacheKey = 'account';
    const cloneRows = rows => Array.isArray(rows)
      ? rows.map(row => row && typeof row === 'object' ? { ...row } : row)
      : rows;
    const cached = this.getCacheEntry(cacheKey);
    if (cached) return cloneRows(cached.data);

    const inFlight = this.inFlightAccountRequests.get(cacheKey);
    if (inFlight) return cloneRows(await inFlight);

    let request;
    request = Promise.resolve()
      .then(() => this.tradingSystem.getAccountInfo())
      .then(rows => {
        const snapshot = cloneRows(rows);
        this.setCache(cacheKey, snapshot);
        return snapshot;
      })
      .finally(() => {
        if (this.inFlightAccountRequests.get(cacheKey) === request) {
          this.inFlightAccountRequests.delete(cacheKey);
        }
      });
    this.inFlightAccountRequests.set(cacheKey, request);
    return cloneRows(await request);
  }

  // Cache metadata distinguishes exchange source time from local fetch time.
  async getCachedTickerWithMetadata(coins) {
    const requestedCoins = Array.isArray(coins) ? [...coins] : coins;
    const publicMarketDataSource = this.publicMarketDataSource;
    if (publicMarketDataSource && typeof publicMarketDataSource.getTicker !== 'function') {
      throw new TypeError('publicMarketDataSource has no ticker reader.');
    }
    const adapter = this.tradingSystem?.marketDataAdapter;
    if (!publicMarketDataSource && getMarketDataAdapterKind(adapter) === 'fixture') {
      return {
        tickers: await adapter.getTickers(requestedCoins),
        fetchedAt: null
      };
    }
    const coinKey = Array.isArray(requestedCoins) ? [...requestedCoins].sort().join(',') : requestedCoins;
    const cacheKey = `ticker:${coinKey}`;

    const cached = this.getCacheEntry(cacheKey);
    if (cached) {
      return {
        tickers: cached.data,
        fetchedAt: cached.fetchedAt ||
          (Number.isFinite(cached.time) ? new Date(cached.time).toISOString() : null),
        ...(cached.fetchedAtByMarket ? { fetchedAtByMarket: cached.fetchedAtByMarket } : {}),
        ...(cached.snapshotSource ? { snapshotSource: cached.snapshotSource } : {}),
        ...(cached.fallbackReason ? { fallbackReason: cached.fallbackReason } : {})
      };
    }

    const publicSnapshot = publicMarketDataSource?.getCachedTickerSnapshot?.(requestedCoins, {
      maxAgeMs: this.cacheTTL.ticker || 1_000
    });
    if (Array.isArray(publicSnapshot?.tickers) && publicSnapshot.tickers.length > 0) {
      const cachedAt = Date.now();
      this.setCache(cacheKey, publicSnapshot.tickers, cachedAt, {
        fetchedAt: publicSnapshot.fetchedAt,
        fetchedAtByMarket: publicSnapshot.fetchedAtByMarket,
        snapshotSource: 'collector_cache'
      });
      return {
        tickers: publicSnapshot.tickers,
        fetchedAt: publicSnapshot.fetchedAt,
        fetchedAtByMarket: publicSnapshot.fetchedAtByMarket,
        snapshotSource: 'collector_cache'
      };
    }

    const inFlight = this.inFlightTickerRequests.get(cacheKey);
    if (inFlight) return inFlight;

    let request;
    request = Promise.resolve()
      .then(() => publicMarketDataSource
        ? publicMarketDataSource.getTicker(requestedCoins)
        : this.tradingSystem.upbit.getTicker(requestedCoins))
      .then(data => {
        const cachedAt = Date.now();
        this.setCache(cacheKey, data, cachedAt, {
          fetchedAt: new Date(cachedAt).toISOString(),
          snapshotSource: 'upstream'
        });
        return {
          tickers: data,
          fetchedAt: new Date(cachedAt).toISOString(),
          snapshotSource: 'upstream'
        };
      })
      .catch(error => {
        const fallback = publicMarketDataSource?.getLastGoodTickerSnapshot?.(requestedCoins);
        if (!Array.isArray(fallback?.tickers) || fallback.tickers.length === 0) throw error;

        const cachedAt = Date.now();
        const fallbackReason = String(error?.code || error?.response?.status || 'UPSTREAM_UNAVAILABLE')
          .replace(/[^A-Za-z0-9_-]/g, '_')
          .slice(0, 48);
        this.cache.set(cacheKey, {
          data: fallback.tickers,
          time: cachedAt,
          fetchedAt: fallback.fetchedAt,
          fetchedAtByMarket: fallback.fetchedAtByMarket,
          snapshotSource: 'last_good',
          fallbackReason
        });
        return {
          tickers: fallback.tickers,
          fetchedAt: fallback.fetchedAt,
          fetchedAtByMarket: fallback.fetchedAtByMarket,
          snapshotSource: 'last_good',
          fallbackReason
        };
      })
      .finally(() => {
        if (this.inFlightTickerRequests.get(cacheKey) === request) {
          this.inFlightTickerRequests.delete(cacheKey);
        }
      });
    this.inFlightTickerRequests.set(cacheKey, request);
    return request;
  }

  // Keep the existing array-only contract for current callers.
  async getCachedTicker(coins) {
    const result = await this.getCachedTickerWithMetadata(coins);
    return result.tickers;
  }

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
    this.app.get('/api/stream', (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write('retry: 3000\n\n');
      res.write('event: connected\ndata: {"ok":true}\n\n');
      this.sseClients.add(res);
      const cleanup = () => this.sseClients.delete(res);
      req.on('close', cleanup);
      res.on('error', cleanup);
    });

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
            .filter(account => account?.currency && account.currency !== 'KRW')
            .map(account => {
              const amount = Number(account.balance);
              const avgPrice = Number(account.avg_buy_price) || 0;
              return [`KRW-${account.currency}`, { amount, avgPrice }];
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
    this.startNotificationMonitoring();
  }

  /**
   * 자동매매 거래 알림 전송
   */
  emitRealtimeEvent(name, payload) {
    this.io?.emit(name, payload);
    if (this.sseClients.size === 0) return;
    const frame = `event: ${name}\ndata: ${JSON.stringify(payload ?? {})}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(frame);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  emitTradeNotification(tradeInfo) {
    if (!this.io) return;

    const notification = {
      type: 'auto-trade',
      trade: {
        ...tradeInfo,
        timestamp: new Date().toISOString()
      }
    };

    this.emitRealtimeEvent('auto-trade', notification);

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
    this.notificationInitialTimer = setTimeout(() => {
      this.notificationInitialTimer = null;
      this.checkAndEmitNotifications();
    }, 5000);
  }

  /**
   * 새로운 신호와 속보 체크 후 알림 발송
   */
  async checkAndEmitNotifications() {
    if (this.io.engine.clientsCount === 0 && this.sseClients.size === 0) return;

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
            this.emitRealtimeEvent('new-signal', {
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
      const marketDataProvider = getMarketDataProvider(this);

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
      const krwMarkets = markets.filter(m => m.market.startsWith('KRW-')).map(m => m.market);
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
          this.monitoringSessions.ingestNews(news).catch(() => undefined);
          this.emitRealtimeEvent('breaking-news', {
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
  buildReadiness(now = Date.now()) {
    const checks = {
      httpServerListening: this.httpServer?.listening === true,
      marketDataScheduler: this.buildMarketDataSchedulerDiagnostics(),
      publicMarketSnapshot: this.buildPublicMarketSnapshotDiagnostics()
    };
    let ready = checks.httpServerListening;

    const trader = this.tradingSystem;
    if (trader && typeof trader.isRunning === 'boolean') {
      checks.traderRunning = trader.isRunning;
      ready = ready && trader.isRunning;
      let runtimeSafety = null;
      if (typeof trader.getRuntimeSafetyStatus === 'function') {
        try {
          runtimeSafety = trader.getRuntimeSafetyStatus() || null;
        } catch {
          runtimeSafety = null;
        }
      }
      checks.runtimeSafetyAvailable = Boolean(runtimeSafety && typeof runtimeSafety === 'object');
      if (checks.runtimeSafetyAvailable) {
        checks.runtimeState = runtimeSafety.runtimeState;
        checks.entriesPaused = runtimeSafety.entriesPaused;
        checks.protectiveMonitorActive = runtimeSafety.protectiveMonitorActive;
        checks.stopReason = runtimeSafety.stopReason;
        checks.exchangeStateKnown = runtimeSafety.exchangeStateKnown;
        if (runtimeSafety.exchangeStateKnown === false ||
          (trader.dryRun !== true && runtimeSafety.exchangeStateKnown !== true)) ready = false;
      } else {
        ready = false;
      }

      const lastCycleAt = trader.paperValidation?.telemetry?.lastCycleAt || null;
      const lastCycleMs = lastCycleAt ? Date.parse(lastCycleAt) : null;
      checks.lastCycleAt = lastCycleAt;
      if (Number.isFinite(lastCycleMs)) {
        checks.lastCycleAgeSeconds = Math.max(0, Math.floor((now - lastCycleMs) / 1000));
      }

      let analysis = null;
      if (typeof trader.getAnalysisDataHealthStatus === 'function') {
        try {
          analysis = trader.getAnalysisDataHealthStatus(now) || null;
        } catch {
          analysis = null;
        }
      }
      checks.analysisHealthAvailable = Boolean(analysis && typeof analysis === 'object');
      checks.analysisHealthy = Boolean(analysis && typeof analysis.failClosed === 'boolean' &&
        analysis.failClosed === false);
      checks.analysisStaleReason = analysis?.staleReason || null;
      {
        const lastCompleteAt = analysis?.lastCompleteAt || null;
        const lastCompleteMs = lastCompleteAt ? Date.parse(lastCompleteAt) : null;
        const intervalValue = trader.config?.checkInterval;
        const intervalConfigured = intervalValue !== undefined && intervalValue !== null && intervalValue !== '';
        const configuredIntervalMs = intervalConfigured ? Number(intervalValue) : 60_000;
        const intervalValid = Number.isFinite(configuredIntervalMs) &&
          configuredIntervalMs > 0 && configuredIntervalMs <= 60 * 60 * 1000;
        const analysisGapValue = analysis?.maxAnalysisDataGapSeconds;
        const analysisGapConfigured = analysisGapValue !== undefined &&
          analysisGapValue !== null && analysisGapValue !== '';
        const analysisGapSeconds = analysisGapConfigured ? Number(analysisGapValue) : NaN;
        const analysisGapValid = Number.isFinite(analysisGapSeconds) &&
          analysisGapSeconds >= 0 && analysisGapSeconds <= 60 * 60;
        const cycleFreshnessLimitMs = Math.min(
          2 * 60 * 60 * 1000,
          Math.max(
            120_000,
            intervalValid ? configuredIntervalMs * 5 : 0,
            analysisGapValid ? analysisGapSeconds * 1000 : 0
          )
        );
        const hasCompleteCycle = Number.isFinite(lastCompleteMs) && lastCompleteMs <= now;
        const cycleAgeMs = hasCompleteCycle ? now - lastCompleteMs : null;
        checks.analysisCycleConfigValid = intervalValid && analysisGapValid;
        checks.analysisLastCompleteAt = lastCompleteAt;
        checks.analysisFirstCycleComplete = hasCompleteCycle;
        checks.analysisCycleAgeSeconds = cycleAgeMs === null ? null : Math.floor(cycleAgeMs / 1000);
        checks.analysisCycleMaxAgeSeconds = Math.ceil(cycleFreshnessLimitMs / 1000);
        checks.analysisCycleFresh = checks.analysisCycleConfigValid &&
          hasCompleteCycle && cycleAgeMs <= cycleFreshnessLimitMs;
        ready = ready && checks.analysisHealthAvailable && checks.analysisHealthy;
        ready = ready && checks.analysisCycleFresh;
      }
      let risk = null;
      if (typeof trader.getRiskMonitorStatus === 'function') {
        try {
          risk = trader.getRiskMonitorStatus(now) || null;
        } catch {
          risk = null;
        }
      }
      checks.riskHealthAvailable = Boolean(risk && typeof risk === 'object');
      checks.riskHealthy = Boolean(risk && typeof risk.failClosed === 'boolean' &&
        risk.failClosed === false);
      checks.riskStaleReason = risk?.staleReason || null;
      ready = ready && checks.riskHealthAvailable && checks.riskHealthy;
    }

    return {
      ready,
      uptimeSec: Math.floor(process.uptime()),
      timestamp: new Date(now).toISOString(),
      checks
    };
  }

  /**
   * HTTP service readiness is intentionally separate from trading readiness:
   * a stopped or protective-only trader can still serve safe read-only status.
   */
  buildServiceReadiness(now = Date.now()) {
    const checks = {
      httpServerListening: this.httpServer?.listening === true,
      marketDataScheduler: this.buildMarketDataSchedulerDiagnostics(),
      publicMarketSnapshot: this.buildPublicMarketSnapshotDiagnostics()
    };
    return {
      ready: checks.httpServerListening,
      uptimeSec: Math.floor(process.uptime()),
      timestamp: new Date(now).toISOString(),
      checks
    };
  }

  async withRateCoordinatorReadiness(readiness) {
    const upbit = this.tradingSystem?.upbit;
    if (typeof upbit?.getRateCoordinatorStatus !== 'function') return readiness;

    let status;
    try {
      status = await upbit.getRateCoordinatorStatus();
    } catch {
      status = {
        required: upbit.rateCoordinatorRequired === true,
        enabled: upbit.rateCoordinatorRequired === true,
        available: false,
        failureCode: 'UPBIT_RATE_COORDINATOR_UNAVAILABLE'
      };
    }
    const safeInteger = value => {
      if (value === null || value === undefined || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
    };
    const failureCode = typeof status?.failureCode === 'string' &&
      /^UPBIT_RATE_COORDINATOR_[A-Z0-9_]+$/.test(status.failureCode)
      ? status.failureCode
      : null;
    const coordinator = {
      required: status?.required === true,
      enabled: status?.enabled === true,
      available: status?.available === true ? true : status?.available === false ? false : null,
      failureCode,
      queuedTotal: safeInteger(status?.queuedTotal),
      inFlightTotal: safeInteger(status?.inFlightTotal),
      maxInFlight: safeInteger(status?.maxInFlight),
      nextStartInMs: safeInteger(status?.nextStartInMs)
    };
    const checks = { ...readiness.checks, marketDataCoordinator: coordinator };
    return {
      ...readiness,
      ready: readiness.ready && (!coordinator.required || coordinator.available === true),
      checks
    };
  }

  /**
   * Public readiness diagnostics for the process-local market-data scheduler.
   * Scheduler pressure is observable here but does not make the HTTP service
   * unready by itself; trading readiness continues to use the trader's
   * fail-closed analysis and risk health contracts above.
   */
  buildMarketDataSchedulerDiagnostics() {
    const unavailable = { available: false };
    try {
      const upbit = this.tradingSystem?.upbit;
      if (typeof upbit?.getQueueStatus !== 'function') return unavailable;
      const status = upbit.getQueueStatus();
      if (!status || typeof status !== 'object' || Array.isArray(status)) return unavailable;

      const nonNegativeInteger = value => {
        if (value === null || value === undefined || value === '') return null;
        const number = Number(value);
        return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
      };
      const priorityValues = value => ({
        normal: nonNegativeInteger(value?.normal),
        risk: nonNegativeInteger(value?.risk)
      });
      const queuedByPriority = priorityValues(status.queuedByPriority);
      const maxQueuedByPriority = priorityValues(status.maxQueuedByPriority);
      const isQueueSaturated = (queued, maximum) => {
        if (queued === null || maximum === null) return null;
        return maximum === 0 ? queued > 0 : queued >= maximum;
      };
      const normalQueueSaturated = isQueueSaturated(queuedByPriority.normal, maxQueuedByPriority.normal);
      const riskQueueSaturated = isQueueSaturated(queuedByPriority.risk, maxQueuedByPriority.risk);
      const backoffRemainingMs = nonNegativeInteger(status.backoffRemainingMs);

      return {
        available: true,
        queueLength: nonNegativeInteger(status.queueLength),
        queuedByPriority,
        oldestWaitAgeMsByPriority: priorityValues(status.oldestWaitAgeMsByPriority),
        inFlightByPriority: priorityValues(status.inFlightByPriority),
        inFlightTotal: nonNegativeInteger(status.inFlightTotal),
        maxInFlight: nonNegativeInteger(status.maxInFlight),
        maxQueuedByPriority,
        nextStartInMs: nonNegativeInteger(status.nextStartInMs),
        backoffRemainingMs,
        pressure: {
          normalQueueSaturated,
          riskQueueSaturated,
          backoffActive: backoffRemainingMs === null ? null : backoffRemainingMs > 0
        }
      };
    } catch {
      return unavailable;
    }
  }

  buildPublicMarketSnapshotDiagnostics() {
    try {
      const status = this.publicMarketDataSource?.getSnapshotStoreStatus?.();
      if (!status || typeof status !== 'object') return { available: false };
      return {
        available: status.available === true,
        marketCount: Number.isSafeInteger(status.marketCount) && status.marketCount >= 0
          ? status.marketCount
          : null,
        persistedAt: typeof status.persistedAt === 'string' ? status.persistedAt : null,
        dirty: status.dirty === true,
        readOnly: status.readOnly === true,
        persistenceHealthy: status.persistenceHealthy === true,
        loadHealthy: status.loadHealthy === true
      };
    } catch {
      return { available: false };
    }
  }

  /**
   * Entry-capable readiness rejects observer-only runtimes even though they
   * may be fully healthy as an HTTP service.
   */
  buildTradingReadiness(now = Date.now()) {
    const readiness = this.buildReadiness(now);
    const trader = this.tradingSystem;
    const traderCanTrade = Boolean(
      trader && typeof trader.isRunning === 'boolean' &&
      trader.isRunning && trader.readOnlyObserver !== true
    );
    const checks = {
      ...readiness.checks,
      traderCanTrade,
      tradingHealthChecksPassed: Boolean(
        traderCanTrade &&
        readiness.checks.runtimeSafetyAvailable === true &&
        readiness.checks.entriesPaused === false &&
        (trader.dryRun === true || readiness.checks.exchangeStateKnown === true) &&
        readiness.checks.analysisHealthAvailable === true &&
        readiness.checks.analysisHealthy === true &&
        readiness.checks.analysisFirstCycleComplete === true &&
        readiness.checks.analysisCycleFresh === true &&
        readiness.checks.riskHealthAvailable === true &&
        readiness.checks.riskHealthy === true
      )
    };
    return {
      ...readiness,
      ready: readiness.ready && checks.tradingHealthChecksPassed,
      checks
    };
  }

  // 최적화 상태 파일 경로
  getOptimizationStateFile() {
    return this.optimizationStateFile || this.optimizationStoragePaths?.optimizationStateFile.absolutePath || path.join(PROJECT_ROOT, 'optimization_state.json');
  }

  // 비교 이력 파일 경로
  getOptimizationHistoryFile() {
    return this.optimizationHistoryFile || this.optimizationStoragePaths?.optimizationHistoryFile.absolutePath || path.join(PROJECT_ROOT, 'optimization_history.json');
  }

  // active 설정 파일 경로 (읽기 전용)
  getOptimalConfigFile() {
    return this.optimalConfigFile || this.optimizationStoragePaths?.optimalConfigFile.absolutePath || path.join(PROJECT_ROOT, 'optimal_config.json');
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
  saveOptimizationState(state = this.optimizationState) {
    const stateFile = this.getOptimizationStateFile();
    fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
    const tempFile = path.join(
      path.dirname(stateFile),
      `.${path.basename(stateFile)}.${process.pid}.${randomUUID()}.tmp`
    );
    let descriptor = null;
    let tempCreated = false;

    try {
      const saveData = {
        enabled: state.enabled,
        interval: state.interval,
        lastRun: state.lastRun
      };
      descriptor = fs.openSync(tempFile, 'wx', 0o600);
      tempCreated = true;
      fs.writeFileSync(descriptor, JSON.stringify(saveData, null, 2), 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      fs.renameSync(tempFile, stateFile);
      tempCreated = false;
    } catch (error) {
      if (descriptor !== null) {
        try {
          fs.closeSync(descriptor);
        } catch {
          // Preserve the original write/rename error.
        }
      }
      if (tempCreated) {
        try {
          fs.unlinkSync(tempFile);
        } catch {
          // Preserve the original write/rename error.
        }
      }
      console.error('최적화 상태 저장 실패:', error.message);
      throw error;
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
      return { blocked: true, reason: 'optimization_already_running' };
    }

    const mutationLock = getPaperEvidenceMutationLock(this.tradingSystem, 'optimization_cycle');
    if (mutationLock.locked) {
      console.log(`⏸️ paper evidence 보호 중 — 최적화 사이클을 건너뜁니다 (${mutationLock.code}).`);
      this.optimizationState.lastBlocked = {
        at: new Date().toISOString(),
        code: mutationLock.code,
        operation: mutationLock.operation,
        sessionId: mutationLock.sessionId
      };
      return { blocked: true, lock: mutationLock };
    }

    try {
      this.optimizationState.isRunning = true;
      console.log('\n🧬 자동 최적화 사이클 시작...');

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
      const optimizer = await this.createParameterOptimizer({
        populationSize: parseInt(process.env.POPULATION_SIZE) || 20,
        generations: parseInt(process.env.GENERATIONS) || 10,
        mutationRate: parseFloat(process.env.MUTATION_RATE) || 0.2,
        crossoverRate: parseFloat(process.env.CROSSOVER_RATE) || 0.7,
        eliteSize: parseInt(process.env.ELITE_SIZE) || 2
      });

      const result = await optimizer.optimize(candles);

      // 후보 비교 결과는 history에만 기록하고 active 설정이나 trader에는 적용하지 않습니다.
      const historyFile = this.getOptimizationHistoryFile();
      await appendOptimizerHistory(historyFile, history => ({
        timestamp: new Date().toISOString(),
        cycle: history.length + 1,
        targetCoin,
        candleUnit,
        candleCount: candles.length,
        fitness: result.fitness,
        parameters: result.parameters
      }));

      this.optimizationState.lastRun = new Date().toISOString();
      if (this.optimizationState.enabled) {
        this.optimizationState.nextRun = new Date(Date.now() + this.optimizationState.interval).toISOString();
      }
      this.saveOptimizationState();

      console.log('✅ 후보 비교 완료!');
      console.log(`   예상 수익률: ${result.fitness?.toFixed(2)}%`);

    } catch (error) {
      console.error('❌ 최적화 오류:', error.message);
    } finally {
      this.optimizationState.isRunning = false;
    }
  }

  async createParameterOptimizer(options) {
    const { default: ParameterOptimizer } = await import('../optimization/parameterOptimizer.js');
    return new ParameterOptimizer(options);
  }

  // 캔들 데이터 수집 헬퍼
  async collectCandleData(market, unit, totalCount, maxPerRequest = 200) {
    const publicMarketDataSource = this.publicMarketDataSource;
    const adapter = this.tradingSystem?.marketDataAdapter;
    const upbit = this.tradingSystem?.upbit;
    let readCandlePage;

    if (publicMarketDataSource !== undefined && publicMarketDataSource !== null) {
      if (typeof publicMarketDataSource.getMinuteCandles !== 'function') {
        throw new TypeError('Public market data source has no candle reader.');
      }
      readCandlePage = (...args) => publicMarketDataSource.getMinuteCandles(...args);
    } else if (typeof adapter?.getMinuteCandles === 'function') {
      readCandlePage = (...args) => adapter.getMinuteCandles(...args);
    } else if (typeof upbit?.getMinuteCandles === 'function') {
      readCandlePage = (...args) => upbit.getMinuteCandles(...args);
    }

    if (!readCandlePage) {
      throw new TypeError('Upbit minute-candle reader is unavailable.');
    }

    return fetchCompleteUpbitCandleHistory({
      marketDataClient: {
        getMinuteCandles: (targetMarket, intervalMinutes, count, requestOptions = {}) =>
          readCandlePage(targetMarket, intervalMinutes, count, requestOptions)
      },
      market,
      intervalMinutes: unit,
      totalCount,
      maxPerRequest,
      requestSpacingMs: 0
    });
  }

  /**
   * 최적화된 파라미터를 트레이딩 시스템에 즉시 적용 (핫 리로드)
   */
  applyOptimalParameters(params) {
    if (!params || !this.tradingSystem) {
      console.log('⚠️ 파라미터 적용 실패: 트레이딩 시스템 없음');
      return { blocked: true, reason: 'trading_system_unavailable' };
    }

    const mutationLock = getPaperEvidenceMutationLock(this.tradingSystem, 'optimization_apply');
    if (mutationLock.locked) {
      console.log(`⏸️ paper evidence 보호 중 — 최적화 파라미터를 적용하지 않습니다 (${mutationLock.code}).`);
      this.optimizationState.lastBlocked = {
        at: new Date().toISOString(),
        code: mutationLock.code,
        operation: mutationLock.operation,
        sessionId: mutationLock.sessionId
      };
      return { blocked: true, lock: mutationLock };
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
        maxSignalRangePercent: params.maxSignalRangePercent,
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
        maxSignalRangePercent: params.maxSignalRangePercent,
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
            maxSignalRangePercent: params.maxSignalRangePercent,
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
    return { blocked: false };
  }

  stop() {
    this.stopOptimizationScheduler();

    if (this.sseHeartbeat) {
      clearInterval(this.sseHeartbeat);
      this.sseHeartbeat = null;
    }
    for (const client of this.sseClients) {
      try {
        client.end();
      } catch { /* already closed */ }
    }
    this.sseClients.clear();

    if (this.notificationInterval) {
      clearInterval(this.notificationInterval);
      this.notificationInterval = null;
    }
    if (this.notificationInitialTimer) {
      clearTimeout(this.notificationInitialTimer);
      this.notificationInitialTimer = null;
    }

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
