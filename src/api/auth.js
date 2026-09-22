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

/**
 * Resolve dashboard auth + bind policy from env.
 *
 * - DASHBOARD_TOKEN set      → auth required, default bind 0.0.0.0 (LAN/mobile)
 * - DASHBOARD_TOKEN missing  → auth disabled, bind forced to 127.0.0.1 unless
 *                              DASHBOARD_ALLOW_INSECURE=true (explicit opt-out)
 * - DASHBOARD_HOST           → explicit bind host; a non-loopback host without
 *                              a token is still refused unless the insecure
 *                              escape hatch is set
 * - DASHBOARD_CORS_ORIGINS   → extra cross-origin allowlist (same-origin is
 *                              always allowed)
 */
export function resolveDashboardAuth(env = {}) {
  const token = String(env.DASHBOARD_TOKEN || '').trim();
  const enabled = token.length > 0;
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

  return { enabled, token, host, requestedHost, allowInsecure, corsOrigins, warnings };
}

/**
 * In-memory login-attempt limiter. Enough to blunt LAN brute force without a
 * dependency; per-IP failures in a sliding window trigger a temporary block.
 */
export function createLoginRateLimiter({
  windowMs = DEFAULT_LOGIN_WINDOW_MS,
  maxFailures = DEFAULT_LOGIN_MAX_FAILURES,
  blockMs = DEFAULT_LOGIN_BLOCK_MS,
  now = () => Date.now()
} = {}) {
  const attempts = new Map();

  function entryFor(key) {
    const entry = attempts.get(key) || { failures: [], blockedUntil: 0 };
    attempts.set(key, entry);
    return entry;
  }

  function prune(entry, at) {
    entry.failures = entry.failures.filter(ts => at - ts <= windowMs);
    if (entry.blockedUntil < at) entry.blockedUntil = 0;
  }

  return {
    blockedUntil(key) {
      const at = now();
      const entry = entryFor(key);
      prune(entry, at);
      return entry.blockedUntil > at ? entry.blockedUntil : 0;
    },
    recordFailure(key) {
      const at = now();
      const entry = entryFor(key);
      prune(entry, at);
      entry.failures.push(at);
      if (entry.failures.length >= maxFailures) {
        entry.blockedUntil = at + blockMs;
        entry.failures = [];
      }
    },
    recordSuccess(key) {
      attempts.delete(key);
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
    res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
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
    if (safeTokenEqual(extractBearerToken(req), resolved.token)) return next();
    return unauthorized(res);
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
    if (safeTokenEqual(String(req.body?.token || ''), resolved.token)) {
      limiter.recordSuccess(key);
      return res.json({ success: true });
    }
    limiter.recordFailure(key);
    return unauthorized(res);
  };

  return {
    ...resolved,
    middleware,
    socketMiddleware,
    statusHandler,
    loginHandler,
    verify(candidate) {
      return resolved.enabled && safeTokenEqual(candidate, resolved.token);
    }
  };
}
