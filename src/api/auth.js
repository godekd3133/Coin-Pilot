import crypto from 'node:crypto';

/**
 * Dashboard access control for the API/socket plane.
 *
 * The static shell stays public (it contains no secrets — every byte of
 * trading data flows through /api/* or Socket.io, both of which require the
 * token when DASHBOARD_TOKEN is set). Keeping the boundary at the data plane
 * avoids cookie/CSRF concerns entirely: the client stores the token in
 * localStorage and sends it as `Authorization: Bearer <token>`.
 */

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost', '0:0:0:0:0:0:0:1']);

const DEFAULT_LOGIN_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_LOGIN_MAX_FAILURES = 10;
const DEFAULT_LOGIN_BLOCK_MS = 5 * 60 * 1000;

const READ_ONLY_PATHS = new Set([
  '/api/status',
  '/api/account',
  '/api/cumulative-pnl',
  '/api/today-summary',
  '/api/market/prices',
  '/api/market/prices/snapshot',
  '/api/paper-validation/summary'
]);
const READ_ONLY_PORTFOLIO_PERIODS = new Set(['24h', '7d', '30d']);

// Native operator access is intentionally narrower than DASHBOARD_TOKEN. It
// can read the trading screens and submit only the controls exposed by the
// native app. A dedicated LIVE setup route can enroll keys, but key retrieval
// and Socket.IO remain full-token-only.
const MOBILE_READ_PATHS = new Set([
  '/api/market/prices/snapshot',
  '/api/positions',
  '/api/target-coins',
  '/api/statistics',
  '/api/portfolio-analysis',
  '/api/paper-validation',
  '/api/parameter-ranges',
  '/api/investment-config',
  '/api/investment-presets',
  '/api/scalping-validation',
  '/api/strategy-readiness',
  '/api/coin-analysis',
  '/api/all-coin-scores',
  '/api/trading-recommendations',
  '/api/bundle-suggestions',
  '/api/news',
  '/api/news-stats',
  '/api/live-execution-evidence',
  '/api/momentum-shadow',
  '/api/strategy-research',
  '/api/backtest/results',
  '/api/optimal-config',
  '/api/optimization-history',
  '/api/optimization/settings',
  '/api/ai/providers',
  '/api/ai/monitoring',
  '/api/ai/events',
  '/api/ai/consultations',
  '/api/ai/effectiveness',
  '/api/ai/sessions',
  '/api/logs'
]);
const MOBILE_CONFIG_KEYS = new Set([
  'investmentRatio',
  'rsiPeriod', 'rsiOversold', 'rsiOverbought', 'oversoldLookback',
  'macdFast', 'macdSlow', 'macdSignal', 'bbPeriod', 'bbStdDev',
  'emaShort', 'emaMid', 'emaLong', 'stopLossPercent', 'takeProfitPercent',
  'buyThreshold', 'sellThreshold', 'volumeMultiplier', 'volumePeriod',
  'minReboundPercent', 'maxReboundPercent', 'minRsiRecovery', 'minVolumeRatio',
  'minCloseStrength', 'trendPeriod', 'trendSlopeLookback', 'minTrendSlopePercent',
  'maxSignalRangePercent', 'minSignalRangePercent', 'positionRiskCheckIntervalMs',
  'entryDelayMinMs', 'entryDelayMaxMs', 'maxEntryRetracePercent', 'maxEntryChasePercent',
  'maxHoldMinutes',
  'breakEvenTriggerPercent',
  'breakEvenOffsetPercent',
  'trailingActivationPercent',
  'trailingStopPercent',
  'maxLosingHoldMinutes',
  'winnerExtendMinutes',
  'winnerExtendMinProfitPercent',
  'maxEntriesPerSignalWindow',
  'marketRegimeEnabled',
  'marketRegimeLookback',
  'marketRegimeMinBreadth',
  'marketRegimeMinReturnPercent',
  'requireReboundBelowOverbought',
  'lossCircuitBreakerCount',
  'lossCircuitBreakerWindowMinutes',
  'lossCircuitBreakerCooldownMinutes',
  'maxRiskDataGapSeconds',
  'maxAnalysisDataGapSeconds',
  'maxCandleAgeSeconds'
]);
const MOBILE_POST_PATHS = new Set([
  '/api/trade/buy',
  '/api/trade/sell',
  '/api/trade/quick',
  '/api/trade/execute',
  '/api/trade/execute-bundle',
  '/api/trade/smart-buy',
  '/api/trade/smart-sell',
  '/api/control/start',
  '/api/control/stop',
  '/api/live/credentials',
  '/api/investment-config/update',
  '/api/config/update',
  '/api/investment-presets/apply',
  '/api/paper-validation/start',
  '/api/paper-validation/stop',
  '/api/portfolio/snapshot',
  '/api/virtual/deposit',
  '/api/virtual/withdraw',
  '/api/virtual/reset',
  '/api/optimization/toggle',
  '/api/optimization/interval',
  '/api/optimization/run-now',
  '/api/ai/sessions',
  '/api/ai/consult'
]);

const MOBILE_ORDER_PATHS = new Set([
  '/api/trade/buy', '/api/trade/sell', '/api/trade/quick', '/api/trade/execute',
  '/api/trade/execute-bundle', '/api/trade/smart-buy', '/api/trade/smart-sell',
  '/api/virtual/deposit', '/api/virtual/withdraw', '/api/virtual/reset'
]);

const AI_EVENT_TYPES = new Set([
  'BUY_SIGNAL', 'SELL_SIGNAL', 'REBOUND_CANDIDATE', 'BREAKING_NEWS',
  'BUNDLE_SUGGESTION', 'TRADE_EXECUTED'
]);

function isTrue(value) {
  return TRUE_VALUES.has(String(value || '').trim().toLowerCase());
}

export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host || '').trim().toLowerCase());
}

/** Constant-time token comparison; both sides are hashed so length never leaks. */
export function safeTokenEqual(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string' || expected.length === 0) {
    return false;
  }
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export function extractBearerToken(req) {
  const header = req.headers?.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function isReadOnlyRequestAllowed(req) {
  if (req.method !== 'GET') return false;

  let url;
  try {
    url = new URL(req.originalUrl || req.url || req.path || '/', 'http://dashboard.local');
  } catch {
    return false;
  }

  if (READ_ONLY_PATHS.has(url.pathname)) return url.searchParams.toString() === '';

  const query = [...url.searchParams.entries()];
  if (url.pathname === '/api/portfolio/history') {
    return query.length === 1 &&
      query[0][0] === 'period' &&
      READ_ONLY_PORTFOLIO_PERIODS.has(query[0][1]);
  }

  if (url.pathname === '/api/trades') {
    if (query.length !== 1 || query[0][0] !== 'limit' || !/^[1-9]\d*$/.test(query[0][1])) {
      return false;
    }
    const limit = Number(query[0][1]);
    return Number.isSafeInteger(limit) && limit >= 1 && limit <= 50;
  }

  return false;
}

function hasOnlyKeys(body, allowedKeys) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const keys = Object.keys(body);
  return keys.length > 0 && keys.every(key => allowedKeys.has(key));
}

function queryIs(url, allowed, required = []) {
  const entries = [...url.searchParams.entries()];
  if (entries.some(([key]) => !allowed.has(key))) return false;
  if (new Set(entries.map(([key]) => key)).size !== entries.length) return false;
  return required.every(key => url.searchParams.has(key));
}

function boundedIntegerQuery(url, name, { min, max, fallback } = {}) {
  const raw = url.searchParams.get(name);
  if (raw === null && fallback !== undefined) return true;
  if (raw === null || !/^[1-9]\d*$/.test(raw)) return false;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function isMobileGetAllowed(url) {
  if (MOBILE_READ_PATHS.has(url.pathname)) return url.searchParams.size === 0;

  if (url.pathname === '/api/portfolio/history') {
    return queryIs(url, new Set(['period']), ['period']) &&
      new Set(['1h', '24h', '7d', '30d']).has(url.searchParams.get('period'));
  }

  if (/^\/api\/market\/candles\/KRW-[A-Z0-9]{2,15}$/.test(url.pathname)) {
    if (!queryIs(url, new Set(['unit', 'count']), ['unit', 'count'])) return false;
    return ['1', '5', '15', '60'].includes(url.searchParams.get('unit')) &&
      ['30', '60', '100'].includes(url.searchParams.get('count'));
  }

  if (url.pathname === '/api/all-coin-scores') {
    return queryIs(url, new Set(['limit']), ['limit']) &&
      boundedIntegerQuery(url, 'limit', { min: 1, max: 100 });
  }

  if (url.pathname === '/api/news') {
    return queryIs(url, new Set(['limit', 'source']), ['limit']) &&
      boundedIntegerQuery(url, 'limit', { min: 1, max: 200 }) &&
      (!url.searchParams.has('source') || ['general', 'system'].includes(url.searchParams.get('source')));
  }

  if (/^\/api\/news\/KRW-[A-Z0-9]{2,15}$/.test(url.pathname)) {
    return queryIs(url, new Set(['limit']), []) &&
      boundedIntegerQuery(url, 'limit', { min: 1, max: 100, fallback: 50 });
  }

  if (url.pathname === '/api/ai/providers') {
    return queryIs(url, new Set(['refresh']), []) &&
      (!url.searchParams.has('refresh') || url.searchParams.get('refresh') === 'true');
  }

  if (['/api/ai/monitoring', '/api/ai/events', '/api/ai/consultations', '/api/ai/effectiveness'].includes(url.pathname)) {
    if (!queryIs(url, new Set(['limit', 'sessionId']), [])) return false;
    return (!url.searchParams.has('limit') || boundedIntegerQuery(url, 'limit', { min: 1, max: 100 })) &&
      (!url.searchParams.has('sessionId') || /^[A-Za-z0-9_-]{1,128}$/.test(url.searchParams.get('sessionId')));
  }

  if (/^\/api\/ai\/sessions\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname)) {
    return queryIs(url, new Set(['limit']), []) &&
      (!url.searchParams.has('limit') || boundedIntegerQuery(url, 'limit', { min: 1, max: 100 }));
  }

  if (/^\/api\/backtest\/results\/[A-Z0-9_-]{1,40}$/.test(url.pathname)) {
    return url.searchParams.size === 0;
  }

  if (url.pathname === '/api/logs') {
    if (!queryIs(url, new Set(['type', 'lines']), [])) return false;
    return (!url.searchParams.has('type') || ['trading', 'error', 'trades'].includes(url.searchParams.get('type'))) &&
      (!url.searchParams.has('lines') || boundedIntegerQuery(url, 'lines', { min: 1, max: 500 }));
  }

  return false;
}

function hasValidMobileIdempotencyKey(req) {
  const key = String(req.headers?.['idempotency-key'] || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);
}

function isMarketCode(value) {
  return typeof value === 'string' && /^KRW-[A-Z0-9]{2,15}$/.test(value);
}

function isFiniteNumber(value, minimum = -Infinity, maximum = Infinity) {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function optionalPositiveNumber(body, key) {
  return body[key] === undefined || isFiniteNumber(body[key], Number.MIN_VALUE, Number.MAX_SAFE_INTEGER);
}

function isValidAiSessionBody(body) {
  const keys = new Set([
    'name', 'providers', 'eventTypes', 'autoConsultEventTypes', 'autoConsult',
    'coins', 'cooldownSeconds', 'evaluationMinutes'
  ]);
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !keys.has(key))) return false;
  const eventTypes = Array.isArray(body.eventTypes) ? body.eventTypes : body.eventTypes ? [body.eventTypes] : [];
  const providers = Array.isArray(body.providers) ? body.providers : body.providers ? [body.providers] : ['gpt', 'claude'];
  const validProviders = new Set(['gpt', 'claude', 'openai', 'anthropic', 'chatgpt', 'codex', 'both', 'all']);
  const coinsValid = body.coins === undefined || (typeof body.coins === 'string' && body.coins.length <= 1000 &&
    body.coins.split(',').every(coin => !coin.trim() || /^(?:KRW-)?[A-Z0-9]{2,15}$/i.test(coin.trim())));
  return eventTypes.length > 0 && eventTypes.every(type => AI_EVENT_TYPES.has(String(type).toUpperCase())) &&
    providers.length > 0 && providers.every(provider => validProviders.has(String(provider).toLowerCase())) && coinsValid &&
    (body.name === undefined || (typeof body.name === 'string' && body.name.length <= 80)) &&
    (body.autoConsult === undefined || typeof body.autoConsult === 'boolean') &&
    (body.cooldownSeconds === undefined || isFiniteNumber(body.cooldownSeconds, 30, 86_400)) &&
    (body.evaluationMinutes === undefined || isFiniteNumber(body.evaluationMinutes, 1, 1_440));
}

function isMobileRequestAllowed(req) {
  let url;
  try {
    url = new URL(req.originalUrl || req.url || req.path || '/', 'http://dashboard.local');
  } catch {
    return false;
  }

  if (req.method === 'GET') {
    if (isReadOnlyRequestAllowed(req)) return true;
    return isMobileGetAllowed(url);
  }
  if (req.method !== 'POST') return false;

  if (url.searchParams.size !== 0 || !MOBILE_POST_PATHS.has(url.pathname)) {
    if (req.path === '/ai/sessions' || req.originalUrl === '/api/ai/sessions') return false;
    const sessionAction = /^\/api\/ai\/sessions\/[A-Za-z0-9_-]{1,128}\/(pause|resume|stop)$/.test(url.pathname);
    if (!sessionAction || url.searchParams.size !== 0) return false;
  }
  const requestPathname = url.pathname;
  const body = req.body;

  if (requestPathname === '/api/live/credentials') {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    const keys = Object.keys(body).sort();
    return keys.length === 2 && keys[0] === 'accessKey' && keys[1] === 'secretKey' &&
      typeof body.accessKey === 'string' && body.accessKey.length > 0 && body.accessKey.length <= 512 &&
      typeof body.secretKey === 'string' && body.secretKey.length > 0 && body.secretKey.length <= 512;
  }

  if (MOBILE_ORDER_PATHS.has(requestPathname) && !hasValidMobileIdempotencyKey(req)) return false;
  if (requestPathname === '/api/trade/buy') return hasOnlyKeys(body, new Set(['coin', 'amount'])) && isMarketCode(body.coin) && isFiniteNumber(body.amount, 5_000);
  if (requestPathname === '/api/trade/sell') return hasOnlyKeys(body, new Set(['coin', 'quantity'])) && isMarketCode(body.coin) && isFiniteNumber(body.quantity, Number.MIN_VALUE);
  if (requestPathname === '/api/trade/quick') {
    return hasOnlyKeys(body, new Set(['coin', 'action', 'amount'])) && isMarketCode(body.coin) &&
      ['BUY', 'SELL'].includes(String(body.action).toUpperCase()) && isFiniteNumber(body.amount, 1);
  }
  if (requestPathname === '/api/trade/execute') {
    return hasOnlyKeys(body, new Set(['coin', 'action', 'amount'])) && isMarketCode(body.coin) &&
      ['BUY', 'SELL'].includes(String(body.action).toUpperCase()) && optionalPositiveNumber(body, 'amount');
  }
  if (requestPathname === '/api/trade/smart-buy') {
    return hasOnlyKeys(body, new Set(['totalAmount', 'minScore', 'maxCoins'])) && isFiniteNumber(body.totalAmount, 5_000) &&
      (body.minScore === undefined || isFiniteNumber(body.minScore, 0, 100)) &&
      (body.maxCoins === undefined || isFiniteNumber(body.maxCoins, 1, 30));
  }
  if (requestPathname === '/api/trade/smart-sell') {
    return hasOnlyKeys(body, new Set(['targetAmount', 'strategy'])) && isFiniteNumber(body.targetAmount, 1_000) &&
      (body.strategy === undefined || ['worst', 'best', 'overbought'].includes(body.strategy));
  }
  if (requestPathname === '/api/trade/execute-bundle') {
    return hasOnlyKeys(body, new Set(['sellCoin', 'sellAmount', 'buyCoin', 'buyAmount'])) &&
      isMarketCode(body.sellCoin) && isMarketCode(body.buyCoin) && body.sellCoin !== body.buyCoin &&
      optionalPositiveNumber(body, 'sellAmount') && optionalPositiveNumber(body, 'buyAmount');
  }
  if (requestPathname === '/api/config/update') {
    return hasOnlyKeys(body, MOBILE_CONFIG_KEYS) && Object.entries(body).every(([key, value]) => {
      if (key === 'investmentRatio') return isFiniteNumber(value, 0.01, 1);
      if (key === 'marketRegimeEnabled' || key === 'requireReboundBelowOverbought') {
        return typeof value === 'boolean' || value === 'true' || value === 'false';
      }
      return typeof value === 'number' && Number.isFinite(value);
    });
  }
  if (requestPathname === '/api/investment-config/update') {
    return hasOnlyKeys(body, new Set(['investmentRatio'])) && isFiniteNumber(body.investmentRatio, 0.01, 1);
  }
  if (requestPathname === '/api/control/start' || requestPathname === '/api/control/stop' || requestPathname === '/api/paper-validation/stop' || requestPathname === '/api/portfolio/snapshot' || requestPathname === '/api/optimization/run-now') {
    return body === undefined || (body && typeof body === 'object' &&
      !Array.isArray(body) && Object.keys(body).length === 0);
  }
  if (requestPathname === '/api/paper-validation/start') {
    if (body === undefined) return true;
    return hasOnlyKeys(body, new Set(['reset'])) && typeof body.reset === 'boolean';
  }
  if (requestPathname === '/api/virtual/reset') return hasOnlyKeys(body, new Set(['seedMoney'])) && isFiniteNumber(body.seedMoney, 100_000);
  if (requestPathname === '/api/virtual/deposit' || requestPathname === '/api/virtual/withdraw') {
    return hasOnlyKeys(body, new Set(['amount'])) && isFiniteNumber(body.amount, 1_000);
  }
  if (requestPathname === '/api/investment-presets/apply') return hasOnlyKeys(body, new Set(['presetId'])) && ['aggressive', 'conservative', 'shortterm', 'scalping', 'longterm', 'balanced'].includes(body.presetId);
  if (requestPathname === '/api/optimization/toggle') return hasOnlyKeys(body, new Set(['enabled'])) && typeof body.enabled === 'boolean';
  if (requestPathname === '/api/optimization/interval') {
    return hasOnlyKeys(body, new Set(['interval'])) &&
      [3_600_000, 7_200_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000].includes(Number(body.interval));
  }
  if (requestPathname === '/api/ai/sessions') return isValidAiSessionBody(body);
  if (requestPathname === '/api/ai/consult') return hasOnlyKeys(body, new Set(['eventId', 'event', 'provider', 'providers', 'sessionId']));
  if (/^\/api\/ai\/sessions\/[A-Za-z0-9_-]{1,128}\/(pause|resume|stop)$/.test(requestPathname)) {
    return body === undefined || (body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0);
  }
  return false;
}

function forbiddenReadOnly(res) {
  return res.status(403).json({
    success: false,
    error: '읽기 전용 대시보드에서는 허용되지 않은 요청입니다.'
  });
}

/**
 * Resolve dashboard auth + bind policy from env.
 *
 * - any dashboard token set → auth required, default bind 0.0.0.0 (LAN/mobile)
 * - all tokens missing      → auth disabled, bind forced to 127.0.0.1 unless
 *                              DASHBOARD_ALLOW_INSECURE=true (explicit opt-out)
 * - DASHBOARD_HOST           → explicit bind host; a non-loopback host without
 *                              a token is still refused unless the insecure
 *                              escape hatch is set
 * - DASHBOARD_CORS_ORIGINS   → extra cross-origin allowlist (same-origin is
 *                              always allowed)
 */
export function resolveDashboardAuth(env = {}) {
  const token = String(env.DASHBOARD_TOKEN || '').trim();
  const readOnlyToken = String(env.DASHBOARD_READ_ONLY_TOKEN || '').trim();
  const mobileToken = String(env.DASHBOARD_MOBILE_TOKEN || '').trim();
  if (token && readOnlyToken && token === readOnlyToken) {
    throw new Error('DASHBOARD_READ_ONLY_TOKEN must differ from DASHBOARD_TOKEN.');
  }
  if (mobileToken && [token, readOnlyToken].some(value => value && mobileToken === value)) {
    throw new Error('DASHBOARD_MOBILE_TOKEN must differ from dashboard tokens.');
  }
  const enabled = token.length > 0 || readOnlyToken.length > 0 || mobileToken.length > 0;
  const allowInsecure = isTrue(env.DASHBOARD_ALLOW_INSECURE);
  const requestedHost = String(env.DASHBOARD_HOST || '').trim();
  const corsOrigins = String(env.DASHBOARD_CORS_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

  const warnings = [];
  let host;
  if (!enabled && !allowInsecure) {
    host = '127.0.0.1';
    warnings.push(
      'DASHBOARD_TOKEN이 설정되지 않아 대시보드가 127.0.0.1에만 바인딩됩니다. ' +
      '모바일/LAN 접속은 .env에 DASHBOARD_TOKEN을 설정한 뒤 다시 시작하세요.'
    );
    if (requestedHost && !isLoopbackHost(requestedHost)) {
      warnings.push(
        `DASHBOARD_HOST=${requestedHost} 요청을 무시했습니다. 인증 없이 비루프백 바인딩은 허용되지 않습니다 ` +
        '(의도적이라면 DASHBOARD_ALLOW_INSECURE=true).'
      );
    }
  } else {
    host = requestedHost || '0.0.0.0';
    if (!enabled) {
      warnings.push(
        'DASHBOARD_TOKEN 없이 모든 인터페이스에 바인딩됩니다 (DASHBOARD_ALLOW_INSECURE). ' +
        '같은 네트워크의 누구나 봇을 제어할 수 있으니 가능한 빨리 토큰을 설정하세요.'
      );
    }
  }

  return {
    enabled,
    token,
    mobileToken,
    readOnlyToken,
    // Full and mobile operator credentials represent the same server-side
    // account. Keep manual-order idempotency stable across token rotation.
    writeProfileId: 'operator',
    host,
    requestedHost,
    allowInsecure,
    corsOrigins,
    warnings
  };
}

/**
 * In-memory login-attempt limiter. Enough to blunt LAN brute force without a
 * dependency; per-IP failures in a sliding window trigger a temporary block.
 */
export function createLoginRateLimiter({
  windowMs = DEFAULT_LOGIN_WINDOW_MS,
  maxFailures = DEFAULT_LOGIN_MAX_FAILURES,
  blockMs = DEFAULT_LOGIN_BLOCK_MS,
  maxTrackedIps = 10_000,
  now = () => Date.now()
} = {}) {
  if (!Number.isSafeInteger(maxTrackedIps) || maxTrackedIps < 1) {
    throw new RangeError('maxTrackedIps must be a positive safe integer');
  }
  const attempts = new Map();
  let lastCapacitySweepAt = Number.NEGATIVE_INFINITY;

  function prune(entry, at) {
    entry.failures = entry.failures.filter(ts => at - ts <= windowMs);
    if (entry.blockedUntil <= at) entry.blockedUntil = 0;
  }

  function pruneExpiredEntries(at) {
    for (const [key, entry] of attempts) {
      prune(entry, at);
      if (entry.failures.length === 0 && entry.blockedUntil === 0) attempts.delete(key);
    }
  }

  return {
    blockedUntil(key) {
      const at = now();
      const entry = attempts.get(key);
      if (!entry) return 0;
      prune(entry, at);
      if (entry.failures.length === 0 && entry.blockedUntil === 0) {
        attempts.delete(key);
        return 0;
      }
      return entry.blockedUntil;
    },
    recordFailure(key) {
      const at = now();
      let entry = attempts.get(key);
      if (entry) {
        prune(entry, at);
      } else if (attempts.size >= maxTrackedIps) {
        if (at - lastCapacitySweepAt >= windowMs) {
          pruneExpiredEntries(at);
          lastCapacitySweepAt = at;
        }
        if (attempts.size >= maxTrackedIps) return false;
        entry = { failures: [], blockedUntil: 0 };
        attempts.set(key, entry);
      } else {
        entry = { failures: [], blockedUntil: 0 };
        attempts.set(key, entry);
      }
      entry.failures.push(at);
      if (entry.failures.length >= maxFailures) {
        entry.blockedUntil = at + blockMs;
        entry.failures = [];
      }
      return true;
    },
    recordSuccess(key) {
      attempts.delete(key);
    },
    capacityRetryAfterSeconds() {
      const at = now();
      let earliestAvailableAt = Number.POSITIVE_INFINITY;
      for (const entry of attempts.values()) {
        const availableAt = entry.blockedUntil > at
          ? entry.blockedUntil
          : (entry.failures.at(-1) ?? at) + windowMs;
        earliestAvailableAt = Math.min(earliestAvailableAt, availableAt);
      }
      return Number.isFinite(earliestAvailableAt)
        ? Math.max(1, Math.ceil((earliestAvailableAt - at) / 1000))
        : Math.max(1, Math.ceil(windowMs / 1000));
    }
  };
}

/**
 * Same-origin-only CORS guard replacing the previous wildcard `cors()`.
 * Requests without an Origin header (curl, same-origin GETs) pass; browser
 * cross-origin calls must match the request Host or the configured allowlist.
 */
export function createOriginGuard(extraOrigins = []) {
  const allowed = new Set(extraOrigins);

  function isOriginAllowed(origin, host) {
    if (!origin) return true;
    try {
      const parsed = new URL(origin);
      return parsed.host === host || allowed.has(origin);
    } catch {
      return false;
    }
  }

  function middleware(req, res, next) {
    const origin = req.headers.origin;
    if (!origin) return next();
    if (!isOriginAllowed(origin, req.headers.host)) {
      return res.status(403).json({
        success: false,
        error: '허용되지 않은 Origin입니다.'
      });
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Idempotency-Key');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  }

  return { middleware, isOriginAllowed };
}

/**
 * Assemble the auth surface: /api guard, socket.io guard, login + status
 * handlers. When `resolved.enabled` is false every guard is a pass-through.
 */
export function createDashboardAuth(env = {}, options = {}) {
  const resolved = resolveDashboardAuth(env);
  const limiter = createLoginRateLimiter(options.loginRateLimiter);
  const unauthorized = res => res
    .status(401)
    .set('WWW-Authenticate', 'Bearer realm="coinpilot-dashboard"')
    .json({ success: false, authRequired: true, error: '인증이 필요합니다.' });

  const middleware = (req, res, next) => {
    if (!resolved.enabled) return next();
    const candidate = extractBearerToken(req);
    if (safeTokenEqual(candidate, resolved.token)) {
      req.dashboardAuthRole = 'operator';
      return next();
    }
    if (safeTokenEqual(candidate, resolved.mobileToken)) {
      if (!isMobileRequestAllowed(req)) {
        return res.status(403).json({
          success: false,
          error: '모바일 운영 토큰에서 허용되지 않은 요청입니다.'
        });
      }
      req.dashboardAuthRole = 'mobile_operator';
      return next();
    }
    if (safeTokenEqual(candidate, resolved.readOnlyToken)) {
      if (!isReadOnlyRequestAllowed(req)) return forbiddenReadOnly(res);
      req.dashboardAuthRole = 'read_only';
      return next();
    }
    return unauthorized(res);
  };

  // Public auth endpoints retain their existing unauthenticated behavior, but
  // a read-only credential cannot use them as an out-of-scope API route.
  const readOnlyScopeMiddleware = (req, res, next) => {
    const readOnlyToken = String(env.DASHBOARD_READ_ONLY_TOKEN || '').trim();
    if (safeTokenEqual(extractBearerToken(req), readOnlyToken) && !isReadOnlyRequestAllowed(req)) {
      return forbiddenReadOnly(res);
    }
    return next();
  };

  const socketMiddleware = (socket, next) => {
    if (!resolved.enabled) return next();
    const authHeader = socket.handshake?.headers?.authorization || '';
    const token = socket.handshake?.auth?.token
      || (authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '');
    if (safeTokenEqual(token, resolved.token)) return next();
    return next(new Error('unauthorized'));
  };

  const statusHandler = (req, res) => {
    res.json({ success: true, authRequired: resolved.enabled });
  };

  const loginHandler = (req, res) => {
    if (!resolved.enabled) return res.json({ success: true, authRequired: false });
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const blockedUntil = limiter.blockedUntil(key);
    if (blockedUntil) {
      return res.status(429).json({
        success: false,
        error: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.',
        retryAfterSeconds: Math.ceil((blockedUntil - Date.now()) / 1000)
      });
    }
    const candidate = String(req.body?.token || '');
    let tokenScope = null;
    if (safeTokenEqual(candidate, resolved.token)) tokenScope = 'operator';
    else if (safeTokenEqual(candidate, resolved.mobileToken)) tokenScope = 'mobile_operator';
    else if (safeTokenEqual(candidate, resolved.readOnlyToken)) tokenScope = 'read_only';
    if (tokenScope) {
      limiter.recordSuccess(key);
      return res.json({ success: true, tokenScope });
    }
    if (!limiter.recordFailure(key)) {
      return res.status(429).json({
        success: false,
        error: '로그인 보호 용량에 도달했습니다. 잠시 후 다시 시도하세요.',
        retryAfterSeconds: limiter.capacityRetryAfterSeconds()
      });
    }
    return unauthorized(res);
  };

  return {
    ...resolved,
    readOnlyScopeMiddleware,
    middleware,
    socketMiddleware,
    statusHandler,
    loginHandler,
    verify(candidate) {
      return resolved.enabled && safeTokenEqual(candidate, resolved.token);
    }
  };
}
