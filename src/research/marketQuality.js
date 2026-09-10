const DEFAULT_MIN_OBSERVATIONS = 100;
const DEFAULT_MAX_FRESHNESS_BLOCK_RATE = 0.05;

function nonNegativeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function boundedRate(value, fallback = DEFAULT_MAX_FRESHNESS_BLOCK_RATE) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : fallback;
}

function normalizeMarkets(markets = [], telemetry = {}) {
  const observedByCoin = telemetry?.candleFreshnessObservedByCoin || {};
  const blockedByCoin = telemetry?.candleFreshnessBlockedByCoin || {};
  const ageStatsByCoin = telemetry?.candleFreshnessAgeStatsByCoin || {};
  const requested = Array.isArray(markets) ? markets : [];
  const discovered = [
    ...Object.keys(observedByCoin),
    ...Object.keys(blockedByCoin),
    ...Object.keys(ageStatsByCoin)
  ];
  const source = requested.length > 0 ? requested : discovered;
  return [...new Set(source.map(market => String(market || '').trim().toUpperCase()).filter(Boolean))];
}

/**
 * Convert persisted forward-paper freshness counters into comparable rows.
 * This is a diagnostic contract only; it never decides live eligibility.
 */
export function summarizeMarketFreshness({ markets = [], telemetry = {} } = {}) {
  const observedByCoin = telemetry?.candleFreshnessObservedByCoin || {};
  const blockedByCoin = telemetry?.candleFreshnessBlockedByCoin || {};
  const ageStatsByCoin = telemetry?.candleFreshnessAgeStatsByCoin || {};

  return normalizeMarkets(markets, telemetry).map((market, order) => {
    const observed = nonNegativeNumber(observedByCoin[market]);
    const blocked = Math.min(observed, nonNegativeNumber(blockedByCoin[market]));
    const ageStats = ageStatsByCoin[market] || {};
    const averageAgeSeconds = observed > 0 && Number.isFinite(Number(ageStats.totalAgeSeconds))
      ? Number(ageStats.totalAgeSeconds) / observed
      : null;
    return {
      market,
      order,
      observed,
      freshnessBlocks: blocked,
      freshnessBlockRate: observed > 0 ? blocked / observed : null,
      validRate: observed > 0 ? (observed - blocked) / observed : null,
      averageAgeSeconds,
      maxObservedAgeSeconds: Number.isFinite(Number(ageStats.maxObservedAgeSeconds))
        ? Number(ageStats.maxObservedAgeSeconds)
        : null,
      missingTimestampCount: nonNegativeNumber(ageStats.missingTimestampCount),
      sufficientObservations: false,
      freshEnough: false
    };
  });
}

/**
 * Select a reproducible, previously observed freshness cohort from a paper
 * ledger. Markets with too few observations or an unknown block rate are
 * excluded fail-closed. The returned selected list keeps the source order so
 * portfolio signal ordering does not change as a side effect of ranking.
 */
export function selectFreshMarketCohort({
  markets = [],
  telemetry = {},
  minObservations = DEFAULT_MIN_OBSERVATIONS,
  maxFreshnessBlockRate = DEFAULT_MAX_FRESHNESS_BLOCK_RATE,
  maxMarkets = Infinity
} = {}) {
  const minimumObservations = Math.max(1, Math.floor(nonNegativeNumber(minObservations, DEFAULT_MIN_OBSERVATIONS)));
  const maximumBlockRate = boundedRate(maxFreshnessBlockRate);
  const marketLimit = Number.isFinite(Number(maxMarkets))
    ? Math.max(1, Math.floor(Number(maxMarkets)))
    : Infinity;
  const rows = summarizeMarketFreshness({ markets, telemetry });
  const eligibleRows = rows
    .map(row => ({
      ...row,
      sufficientObservations: row.observed >= minimumObservations,
      freshEnough: row.freshnessBlockRate !== null && row.freshnessBlockRate <= maximumBlockRate
    }))
    .filter(row => row.sufficientObservations && row.freshEnough)
    .sort((a, b) =>
      (a.freshnessBlockRate - b.freshnessBlockRate) ||
      ((a.averageAgeSeconds ?? Infinity) - (b.averageAgeSeconds ?? Infinity)) ||
      a.market.localeCompare(b.market)
    )
    .slice(0, marketLimit);
  const selectedSet = new Set(eligibleRows.map(row => row.market));
  const selectedRows = rows
    .map(row => eligibleRows.find(candidate => candidate.market === row.market) || row)
    .filter(row => selectedSet.has(row.market));

  return {
    minObservations: minimumObservations,
    maxFreshnessBlockRate: maximumBlockRate,
    maxMarkets: marketLimit,
    selectedMarkets: selectedRows.map(row => row.market),
    selectedRows,
    excludedRows: rows.filter(row => !selectedSet.has(row.market)).map(row => ({
      ...row,
      exclusionReason: row.observed < minimumObservations
        ? 'insufficient_observations'
        : row.freshnessBlockRate === null
          ? 'freshness_rate_unavailable'
          : row.freshnessBlockRate > maximumBlockRate
            ? 'freshness_block_rate_too_high'
            : 'market_limit'
    }))
  };
}

export const MARKET_QUALITY_DEFAULTS = Object.freeze({
  minObservations: DEFAULT_MIN_OBSERVATIONS,
  maxFreshnessBlockRate: DEFAULT_MAX_FRESHNESS_BLOCK_RATE
});
