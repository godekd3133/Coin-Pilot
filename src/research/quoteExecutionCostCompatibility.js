const EPSILON = 1e-12;

function finiteNonNegative(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function finitePositive(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeMarkets(markets) {
  return [...new Set((Array.isArray(markets) ? markets : [])
    .map(market => String(market).trim().toUpperCase())
    .filter(Boolean))];
}

function projectAgeSeconds(value, now) {
  const generatedAtMs = Date.parse(value || '');
  if (!Number.isFinite(generatedAtMs) || !Number.isFinite(Number(now))) return null;
  const ageMs = Number(now) - generatedAtMs;
  return ageMs >= 0 ? Math.floor(ageMs / 1000) : null;
}

/**
 * Compare repeated best-level spread observations with a scalping model's
 * adverse-slippage budget. This is an execution-boundary diagnostic only:
 * spread observations are not fills, realized P&L, or wallet settlement.
 */
export function assessQuoteExecutionCostCompatibility({
  report = null,
  markets = [],
  tradingFee = 0.0005,
  slippage = 0.001,
  minimumSamples = 5,
  maxAgeSeconds = null,
  now = Date.now()
} = {}) {
  const selectedMarkets = normalizeMarkets(markets);
  const fee = finiteNonNegative(tradingFee);
  const adverseSlippage = finiteNonNegative(slippage);
  const minimumSampleCount = Math.max(1, Math.floor(Number(minimumSamples) || 1));
  const summary = report?.summary && typeof report.summary === 'object'
    ? report.summary
    : null;
  const summaryMarkets = summary?.markets && typeof summary.markets === 'object'
    ? summary.markets
    : {};
  const complete = report?.complete === true && summary?.valid === true;
  const ageSeconds = projectAgeSeconds(report?.generatedAt, now);
  const configuredMaxAge = finiteNonNegative(maxAgeSeconds);
  const fresh = configuredMaxAge === null
    ? null
    : ageSeconds !== null && ageSeconds <= configuredMaxAge;
  const adverseSlippageBudgetPercent = adverseSlippage === null
    ? null
    : adverseSlippage * 2 * 100;
  const assumedRoundTripCostPercent = fee === null || adverseSlippage === null
    ? null
    : (fee * 2 + adverseSlippage * 2) * 100;

  const rows = selectedMarkets.map(market => {
    const source = summaryMarkets[market];
    const sampleCount = Math.max(0, Number(source?.sampleCount) || 0);
    const p95 = finiteNonNegative(source?.p95);
    const max = finiteNonNegative(source?.max);
    const sampleSufficient = sampleCount >= minimumSampleCount;
    const p95WithinBudget = p95 !== null && adverseSlippageBudgetPercent !== null &&
      p95 <= adverseSlippageBudgetPercent + EPSILON;
    let status;
    if (!source || p95 === null) {
      status = 'MISSING_QUOTE_SUMMARY';
    } else if (!sampleSufficient) {
      status = 'INSUFFICIENT_SAMPLES';
    } else if (adverseSlippageBudgetPercent === null) {
      status = 'INVALID_COST_CONFIG';
    } else if (!p95WithinBudget) {
      status = 'P95_ABOVE_ADVERSE_SLIPPAGE_BUDGET';
    } else {
      status = 'P95_WITHIN_ADVERSE_SLIPPAGE_BUDGET';
    }
    return {
      market,
      sampleCount,
      minimumSampleCount,
      observedP95SpreadPercent: p95,
      observedMaxSpreadPercent: max,
      adverseSlippageBudgetPercent,
      p95WithinAdverseSlippageBudget: p95WithinBudget,
      status
    };
  });

  const invalidReport = !summary || selectedMarkets.length === 0;
  const hasUnavailableRows = rows.some(row => row.status === 'MISSING_QUOTE_SUMMARY' ||
    row.status === 'INSUFFICIENT_SAMPLES');
  const hasBudgetBreaches = rows.some(row =>
    row.status === 'P95_ABOVE_ADVERSE_SLIPPAGE_BUDGET');
  const ready = !invalidReport && complete && (fresh !== false) &&
    fee !== null && adverseSlippage !== null && !hasUnavailableRows && !hasBudgetBreaches;
  const reason = invalidReport
    ? 'quote_compatibility_input_invalid'
    : !complete
      ? 'quote_quality_report_incomplete'
      : fresh === false
        ? 'quote_quality_report_stale'
        : fee === null || adverseSlippage === null
          ? 'quote_compatibility_cost_config_invalid'
          : hasUnavailableRows
            ? 'quote_compatibility_market_samples_insufficient_or_missing'
            : hasBudgetBreaches
              ? 'quote_compatibility_p95_above_adverse_slippage_budget'
              : 'quote_compatibility_within_observed_budget';

  return {
    ready,
    reason,
    researchOnly: true,
    promoted: false,
    reportComplete: complete,
    generatedAt: report?.generatedAt || null,
    ageSeconds,
    maxAgeSeconds: configuredMaxAge,
    fresh,
    markets: selectedMarkets,
    tradingFee: fee,
    slippage: adverseSlippage,
    adverseSlippageBudgetPercent,
    assumedRoundTripCostPercent,
    rows,
    note: 'Observed p95/max are best bid/ask spread statistics. They are not fills, realized P&L, wallet settlement, or live-order authorization; the modeled round-trip cost is kept separate from observed spread.'
  };
}

export function parseCompatibilityMarkets(value, fallback = []) {
  const explicitMarkets = normalizeMarkets(String(value || '').split(','));
  return explicitMarkets.length > 0 ? explicitMarkets : normalizeMarkets(fallback);
}

export function finiteCompatibilityNumber(value, fallback) {
  const parsed = finiteNonNegative(value);
  return parsed === null ? fallback : parsed;
}

export function positiveCompatibilityNumber(value, fallback) {
  const parsed = finitePositive(value);
  return parsed === null ? fallback : parsed;
}
