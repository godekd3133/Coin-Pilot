export const DEFAULT_STAGING_CHECK_INTERVAL_MS = 30_000;

export function resolveStagingCheckIntervalMs(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_STAGING_CHECK_INTERVAL_MS;
}
