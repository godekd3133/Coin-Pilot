export const DEFAULT_SCALPING_VALIDATION_REPORT_MAX_AGE_SECONDS = 24 * 60 * 60;

/**
 * Describe the age of a fixed-config validation report. Readiness clients use
 * this metadata to avoid presenting old research as current market evidence,
 * and the same boundary is enforced before LIVE startup.
 */
export function assessScalpingValidationReportFreshness(
  generatedAt,
  {
    now = Date.now(),
    maxAgeSeconds = DEFAULT_SCALPING_VALIDATION_REPORT_MAX_AGE_SECONDS
  } = {}
) {
  const generatedAtMs = Date.parse(generatedAt || '');
  const nowMs = Number(now);
  const maxAge = Number.isFinite(Number(maxAgeSeconds)) && Number(maxAgeSeconds) >= 0
    ? Number(maxAgeSeconds)
    : DEFAULT_SCALPING_VALIDATION_REPORT_MAX_AGE_SECONDS;

  if (!Number.isFinite(generatedAtMs) || !Number.isFinite(nowMs)) {
    return {
      fresh: false,
      reason: 'timestamp_missing_or_invalid',
      generatedAt: generatedAt || null,
      ageSeconds: null,
      maxAgeSeconds: maxAge
    };
  }
  if (generatedAtMs > nowMs) {
    return {
      fresh: false,
      reason: 'future_timestamp',
      generatedAt: generatedAt || null,
      ageSeconds: null,
      maxAgeSeconds: maxAge
    };
  }

  const ageSeconds = Math.floor((nowMs - generatedAtMs) / 1000);
  return {
    fresh: ageSeconds <= maxAge,
    reason: ageSeconds <= maxAge ? 'fresh' : 'stale',
    generatedAt: generatedAt || null,
    ageSeconds,
    maxAgeSeconds: maxAge
  };
}
