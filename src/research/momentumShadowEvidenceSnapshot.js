export const MOMENTUM_SHADOW_EVIDENCE_SNAPSHOT_SCHEMA =
  'coinpilot.momentum-shadow.evidence.v1';
export const DEFAULT_MOMENTUM_SHADOW_EVIDENCE_MAX_AGE_SECONDS = 15 * 60;
export const DEFAULT_MOMENTUM_SHADOW_EVIDENCE_SNAPSHOT_FILE =
  '/private/tmp/coinpilot-momentum-shadow-evidence-current.json';

const PRIVATE_FIELDS = new Set([
  'targetDir',
  'directory',
  'reportFile',
  'ownerPid',
  'runnerPid',
  'pid',
  'candidateSlotFile'
]);

/**
 * Remove local paths, owner identity, and sensitive fields before a
 * read-only API projection is persisted as a shareable evidence artifact.
 * This is intentionally independent from ledger loading and never mutates
 * the source projection.
 */
export function sanitizeMomentumShadowEvidenceValue(value, key = '') {
  if (PRIVATE_FIELDS.has(key)) return undefined;
  if (/api[_-]?key|secret|access[_-]?key|private[_-]?key|token/i.test(key)) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value
      .map(item => sanitizeMomentumShadowEvidenceValue(item))
      .filter(item => item !== undefined);
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .map(([field, nested]) => [field, sanitizeMomentumShadowEvidenceValue(nested, field)])
    .filter(([, nested]) => nested !== undefined));
}

function collectViolations(value, path = '', violations = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectViolations(item, `${path}[${index}]`, violations));
    return violations;
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && (/\/Users\//.test(value) || /\.paper-momentum-shadow/.test(value))) {
      violations.push(`${path}:internal_path_value`);
    }
    return violations;
  }
  for (const [key, nested] of Object.entries(value)) {
    const nextPath = path ? `${path}.${key}` : key;
    if (PRIVATE_FIELDS.has(key)) violations.push(`${nextPath}:private_field`);
    if (/api[_-]?key|secret|access[_-]?key|private[_-]?key|token/i.test(key)) {
      violations.push(`${nextPath}:sensitive_field`);
    }
    collectViolations(nested, nextPath, violations);
  }
  return violations;
}

function timestampOrNull(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Verify a browser-exported momentum-shadow evidence snapshot without
 * reading any ledger or changing any process. The verifier is deliberately
 * stricter than the API projection because it is an artifact boundary.
 */
export function verifyMomentumShadowEvidenceSnapshot(
  snapshot,
  now = Date.now(),
  maxAgeSeconds = DEFAULT_MOMENTUM_SHADOW_EVIDENCE_MAX_AGE_SECONDS
) {
  const errors = [];
  const ageLimitSeconds = Number.isFinite(Number(maxAgeSeconds)) && Number(maxAgeSeconds) >= 60
    ? Number(maxAgeSeconds)
    : DEFAULT_MOMENTUM_SHADOW_EVIDENCE_MAX_AGE_SECONDS;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return { valid: false, errors: ['snapshot_invalid'] };
  }
  if (snapshot.schema !== MOMENTUM_SHADOW_EVIDENCE_SNAPSHOT_SCHEMA) {
    errors.push('schema_invalid');
  }
  if (snapshot.researchOnly !== true) errors.push('research_only_required');
  if (snapshot.promoted !== false) errors.push('promoted_must_be_false');
  if (snapshot.source !== 'read-only /api/momentum-shadow projection') {
    errors.push('source_invalid');
  }
  const exportedAtMs = timestampOrNull(snapshot.exportedAt);
  if (exportedAtMs === null) {
    errors.push('exported_at_invalid');
  } else if (exportedAtMs > Number(now)) {
    errors.push('exported_at_in_future');
  }
  const projection = snapshot.projection;
  if (!projection || typeof projection !== 'object' || Array.isArray(projection)) {
    errors.push('projection_invalid');
  } else {
    if (projection.researchOnly !== true) errors.push('projection_research_only_required');
    if (projection.promoted !== false) errors.push('projection_promoted_must_be_false');
    if (!Array.isArray(projection.books)) errors.push('books_invalid');
  }
  const violations = collectViolations(snapshot);
  errors.push(...violations);

  const books = Array.isArray(projection?.books) ? projection.books : [];
  const availableBookCount = books.filter(book => book?.available === true).length;
  const unverifiableHeartbeatCount = books.filter(book =>
    book?.available === true && book?.heartbeatAgeSeconds === null
  ).length;
  const staleHeartbeatCount = books.filter(book => {
    if (book?.available !== true || book?.heartbeatAgeSeconds === null ||
      book?.heartbeatAgeSeconds === undefined) return false;
    const age = Number(book.heartbeatAgeSeconds);
    return Number.isFinite(age) && age > ageLimitSeconds;
  }).length;
  const heartbeatTimes = books
    .map(book => timestampOrNull(book?.heartbeatAt))
    .filter(value => value !== null);
  const ageSeconds = exportedAtMs === null || !Number.isFinite(Number(now))
    ? null
    : Math.max(0, Math.floor((Number(now) - exportedAtMs) / 1000));
  const fresh = exportedAtMs !== null && exportedAtMs <= Number(now) &&
    ageSeconds !== null && ageSeconds <= ageLimitSeconds &&
    unverifiableHeartbeatCount === 0 && staleHeartbeatCount === 0;
  const freshnessReason = exportedAtMs === null
    ? 'exported_at_invalid'
    : !Number.isFinite(Number(now))
      ? 'now_invalid'
    : exportedAtMs > Number(now)
      ? 'exported_at_in_future'
      : ageSeconds > ageLimitSeconds
        ? 'snapshot_stale'
        : unverifiableHeartbeatCount > 0
          ? 'heartbeat_unverifiable'
          : staleHeartbeatCount > 0
            ? 'heartbeat_stale_at_export'
            : 'fresh';
  return {
    valid: errors.length === 0,
    fresh,
    freshnessReason,
    maxAgeSeconds: ageLimitSeconds,
    errors: [...new Set(errors)],
    schema: snapshot.schema || null,
    exportedAt: snapshot.exportedAt || null,
    ageSeconds,
    researchOnly: snapshot.researchOnly === true,
    promoted: snapshot.promoted === true,
    bookCount: books.length,
    availableBookCount,
    unverifiableHeartbeatCount,
    staleHeartbeatCount,
    latestHeartbeatAt: heartbeatTimes.length
      ? new Date(Math.max(...heartbeatTimes)).toISOString()
      : null
  };
}
