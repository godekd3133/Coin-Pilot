/**
 * Response and log hardening for the dashboard's HTTP surface.
 *
 * The bearer token lives in localStorage, so an injected script is the main way
 * to lose it. The CSP keeps same-origin scripts (the shell still has inline
 * blocks) but refuses to send data anywhere else or be framed.
 */

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

export function securityHeadersMiddleware(req, res, next) {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
}

const SENSITIVE_KEY = /(^|[-_])(token|secret|password|passwd|authorization|apikey|api[-_]key|access[-_]?key|secret[-_]?key|cookie)($|[-_])|accessKey|secretKey|apiKey/i;
const TEXT_SCRUBBERS = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+)?/g, '[redacted-token]'],
  [/\b(token|secret|password|access[_-]?key|secret[_-]?key|api[_-]?key)=[^\s&"']+/gi, '$1=[redacted]']
];
const INTERNAL_DETAIL = [
  [/https?:\/\/[^\s"')]+/gi, '[url]'],
  [/(?:\/(?:Users|home|var|etc|tmp|private|opt|srv|root|app)\/[^\s"':,)]+)/g, '[path]'],
  [/\b[A-Za-z]:\\[^\s"':,)]+/g, '[path]']
];

export function scrubSecrets(text) {
  return TEXT_SCRUBBERS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), String(text));
}

/** Text safe to return to a client: no credentials, file paths or upstream URLs. */
export function scrubClientErrorText(text) {
  return INTERNAL_DETAIL.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), scrubSecrets(text));
}

/** Deep copy for logging. Sensitive fields keep their key so the event stays diagnosable. */
export function redactForLog(value, seen = new WeakSet()) {
  if (typeof value === 'string') return scrubSecrets(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    return { name: value.name, message: scrubSecrets(value.message), stack: value.stack ? scrubSecrets(value.stack) : undefined };
  }
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => redactForLog(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SENSITIVE_KEY.test(key) && item !== null && item !== undefined && typeof item !== 'boolean' ? '[redacted]' : redactForLog(item, seen)
  ]));
}

/** Route handlers report upstream failures verbatim; scrub 5xx text at the single exit. */
export function scrubServerErrorResponses(req, res, next) {
  const json = res.json.bind(res);
  res.json = body => {
    if (res.statusCode >= 500 && body && typeof body === 'object' && !Array.isArray(body)) {
      const copy = { ...body };
      for (const key of ['error', 'message', 'reason']) {
        if (typeof copy[key] === 'string') copy[key] = scrubClientErrorText(copy[key]);
      }
      return json(copy);
    }
    return json(body);
  };
  next();
}

/**
 * Terminal Express handler. The request body never reaches the log (it can hold
 * exchange keys or a login token) and a 5xx reveals only a generic message.
 */
export function createDashboardErrorHandler(logger) {
  return (err, req, res, _next) => {
    const malformedBody = err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large';
    const statusCode = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    const urlPath = req.originalUrl?.split('?')[0] || '';
    logger.error(`[${req.method}] ${urlPath} - ${scrubSecrets(err?.message || 'Internal Server Error')}`, {
      statusCode,
      method: req.method,
      path: urlPath,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      bodyKeys: req.body && typeof req.body === 'object' ? Object.keys(req.body).filter(key => !SENSITIVE_KEY.test(key)) : undefined,
      stack: err?.stack ? scrubSecrets(err.stack) : undefined
    });
    if (res.headersSent) return res.end();
    const message = malformedBody
      ? (err.type === 'entity.too.large' ? '요청 본문이 너무 큽니다.' : '요청 본문을 해석할 수 없습니다.')
      : statusCode >= 500 ? '서버에서 요청을 처리하지 못했습니다.' : scrubClientErrorText(err?.message || '요청을 처리하지 못했습니다.');
    return res.status(statusCode).json({ success: false, error: message, path: urlPath, timestamp: new Date().toISOString() });
  };
}
