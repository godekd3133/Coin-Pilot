const EPSILON = 1e-12;

export const DEFAULT_QUOTE_EXECUTION_COST_MODEL = Object.freeze({
  tradingFeeRatePerSide: 0.0005,
  adverseSlippageRatePerSide: 0.001,
  assumedRoundTripCostPercent: 0.3
});

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
  tradingFee = DEFAULT_QUOTE_EXECUTION_COST_MODEL.tradingFeeRatePerSide,
  slippage = DEFAULT_QUOTE_EXECUTION_COST_MODEL.adverseSlippageRatePerSide,
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

function quoteHistoryQuantile(values, probability) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(probability * sorted.length) - 1);
  return sorted[index];
}

function quoteHistoryErrorCount(value) {
  if (Array.isArray(value)) return value.length;
  const parsed = finiteNonNegative(value);
  return parsed === null ? 0 : Math.floor(parsed);
}

function normalizeReferenceNotionals(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(finitePositive)
    .filter(value => value !== null))]
    .sort((left, right) => left - right);
}

function normalizeQuoteHistoryRecords(records, now) {
  let invalidRecordCount = 0;
  let futureTimestampCount = 0;
  const validRecords = [];

  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      invalidRecordCount += 1;
      continue;
    }
    const generatedAtMs = Date.parse(record.generatedAt || '');
    if (!Number.isFinite(generatedAtMs)) {
      invalidRecordCount += 1;
      continue;
    }
    if (generatedAtMs > now) {
      futureTimestampCount += 1;
      continue;
    }
    const summary = record.summary && typeof record.summary === 'object' && !Array.isArray(record.summary)
      ? record.summary
      : {};
    const summaryMarkets = summary.markets && typeof summary.markets === 'object' && !Array.isArray(summary.markets)
      ? summary.markets
      : {};
    const errorCount = quoteHistoryErrorCount(record.errors);
    validRecords.push({
      generatedAt: record.generatedAt,
      generatedAtMs,
      complete: record.complete === true && summary.valid === true && errorCount === 0,
      errorCount,
      reportSampleCount: Math.max(0, Number(record.sampleCount) || 0),
      requestedSampleCount: Math.max(0, Number(record.requestedSampleCount) || 0),
      summaryMarkets
    });
  }

  validRecords.sort((left, right) => left.generatedAtMs - right.generatedAtMs);
  return { validRecords, invalidRecordCount, futureTimestampCount };
}

function summarizeQuoteHistoryCadence(records, expectedIntervalSeconds, freshnessLimitSeconds) {
  const gaps = records.slice(1)
    .map((record, index) => (record.generatedAtMs - records[index].generatedAtMs) / 1000)
    .filter(gap => Number.isFinite(gap) && gap >= 0);
  return {
    intervalCount: gaps.length,
    expectedIntervalSeconds,
    medianGapSeconds: quoteHistoryQuantile(gaps, 0.5),
    p95GapSeconds: quoteHistoryQuantile(gaps, 0.95),
    maxGapSeconds: gaps.length ? Math.max(...gaps) : null,
    gapsOverFreshnessLimit: gaps.filter(gap => gap > freshnessLimitSeconds).length
  };
}

function summarizeQuoteHistoryMarket({
  reports,
  market,
  minimumReports,
  minimumDepthReports,
  minimumSamplesPerReport,
  adverseSlippageBudgetPercent,
  referenceNotionalsKrw = []
}) {
  const rows = reports.map(report => report.summaryMarkets[market]).filter(row =>
    row && typeof row === 'object' && !Array.isArray(row)
  );
  const missingReportCount = reports.length - rows.length;
  const reportP95Values = [];
  const spreadMaxValues = [];
  const bidDepthReportMinimumValues = [];
  const askDepthReportMinimumValues = [];
  const twoSidedDepthReports = [];
  const minimumDepthReportCount = Math.max(1, Math.floor(Number(minimumDepthReports) || 1));
  let underSampledReportCount = 0;
  let reportsAboveSamplerCeiling = 0;

  for (const row of rows) {
    if (Number(row.overCeiling) > 0) reportsAboveSamplerCeiling += 1;
    const sampleCount = Math.max(0, Number(row.sampleCount) || 0);
    const reportP95 = finiteNonNegative(row.p95);
    const reportMax = finiteNonNegative(row.max);
    if (sampleCount < minimumSamplesPerReport || reportP95 === null) {
      underSampledReportCount += 1;
      continue;
    }
    reportP95Values.push(reportP95);
    if (reportMax !== null) spreadMaxValues.push(reportMax);

    const depth = row.topOfBookDepth && typeof row.topOfBookDepth === 'object'
      ? row.topOfBookDepth
      : {};
    const requestedDepthSampleCount = Math.max(0, Number(depth.requestedSampleCount) || 0);
    const bidDepthSampleCount = Math.max(0, Number(depth.bidSampleCount) || 0);
    const askDepthSampleCount = Math.max(0, Number(depth.askSampleCount) || 0);
    const minimumBidNotional = finitePositive(depth.minimumBidNotionalKrw);
    const minimumAskNotional = finitePositive(depth.minimumAskNotionalKrw);
    if (requestedDepthSampleCount >= minimumSamplesPerReport &&
      bidDepthSampleCount === requestedDepthSampleCount && minimumBidNotional !== null) {
      bidDepthReportMinimumValues.push(minimumBidNotional);
    }
    if (requestedDepthSampleCount >= minimumSamplesPerReport &&
      askDepthSampleCount === requestedDepthSampleCount && minimumAskNotional !== null) {
      askDepthReportMinimumValues.push(minimumAskNotional);
    }
    if (requestedDepthSampleCount >= minimumSamplesPerReport &&
      bidDepthSampleCount === requestedDepthSampleCount &&
      askDepthSampleCount === requestedDepthSampleCount &&
      minimumBidNotional !== null && minimumAskNotional !== null) {
      twoSidedDepthReports.push({ bid: minimumBidNotional, ask: minimumAskNotional });
    }
  }

  const reportsAboveBudget = reportP95Values.filter(value =>
    adverseSlippageBudgetPercent !== null &&
    value > adverseSlippageBudgetPercent + EPSILON
  ).length;
  const p95OfReportP95 = quoteHistoryQuantile(reportP95Values, 0.95);
  const status = reportP95Values.length === 0
    ? 'MISSING_QUOTE_HISTORY'
    : reportP95Values.length < minimumReports
      ? 'INSUFFICIENT_REPORT_HISTORY'
      : adverseSlippageBudgetPercent === null
        ? 'INVALID_COST_CONFIG'
        : p95OfReportP95 > adverseSlippageBudgetPercent + EPSILON
        ? 'P95_REPORT_TAIL_ABOVE_SLIPPAGE_BUDGET'
        : 'P95_REPORT_TAIL_WITHIN_SLIPPAGE_BUDGET';

  return {
    market,
    validReportCount: reportP95Values.length,
    minimumReportCount: minimumReports,
    missingReportCount,
    underSampledReportCount,
    medianReportP95SpreadPercent: quoteHistoryQuantile(reportP95Values, 0.5),
    p95OfReportP95SpreadPercent: p95OfReportP95,
    maxReportP95SpreadPercent: reportP95Values.length ? Math.max(...reportP95Values) : null,
    maxObservedSpreadPercent: spreadMaxValues.length ? Math.max(...spreadMaxValues) : null,
    adverseSlippageBudgetPercent,
    reportsAboveBudget: adverseSlippageBudgetPercent === null ? null : reportsAboveBudget,
    reportsAboveBudgetRate: reportP95Values.length ? reportsAboveBudget / reportP95Values.length : null,
    reportsAboveSamplerCeiling,
    topOfBookDepth: {
      bidDepthReportCount: bidDepthReportMinimumValues.length,
      missingBidDepthReportCount: Math.max(0, reports.length - bidDepthReportMinimumValues.length),
      p05PerReportMinimumBidNotionalKrw: quoteHistoryQuantile(bidDepthReportMinimumValues, 0.05),
      medianPerReportMinimumBidNotionalKrw: quoteHistoryQuantile(bidDepthReportMinimumValues, 0.5),
      askDepthReportCount: askDepthReportMinimumValues.length,
      missingAskDepthReportCount: Math.max(0, reports.length - askDepthReportMinimumValues.length),
      p05PerReportMinimumAskNotionalKrw: quoteHistoryQuantile(askDepthReportMinimumValues, 0.05),
      medianPerReportMinimumAskNotionalKrw: quoteHistoryQuantile(askDepthReportMinimumValues, 0.5),
      twoSidedDepthReportCount: twoSidedDepthReports.length,
      minimumDepthReportCount,
      status: twoSidedDepthReports.length >= minimumDepthReportCount
        ? 'TOP_OF_BOOK_REFERENCE_ONLY'
        : 'INSUFFICIENT_DEPTH_REPORT_HISTORY',
      referenceNotionalCoverage: referenceNotionalsKrw.map(notional => {
        const bidReportCount = bidDepthReportMinimumValues.filter(value => value >= notional).length;
        const askReportCount = askDepthReportMinimumValues.filter(value => value >= notional).length;
        const twoSidedReportCount = twoSidedDepthReports.filter(report =>
          report.bid >= notional && report.ask >= notional
        ).length;
        return {
          notionalKrw: notional,
          bidReportCount,
          askReportCount,
          twoSidedReportCount,
          minimumDepthReportCount,
          twoSidedCoverageRate: twoSidedDepthReports.length >= minimumDepthReportCount
            ? twoSidedReportCount / twoSidedDepthReports.length
            : null,
          status: twoSidedDepthReports.length >= minimumDepthReportCount
            ? 'TOP_OF_BOOK_REFERENCE_ONLY'
            : 'INSUFFICIENT_DEPTH_REPORT_HISTORY'
        };
      }),
      note: 'per-report minimum notional across samples at the best quote level only; not full-book depth or a fill'
    },
    status
  };
}

/**
 * Summarize report-level spread tails and quote-sampler cadence over rolling
 * windows. This is research-only; it never changes markets or launches a
 * baseline/candidate. The aggregate p95 is the p95 of each report's p95,
 * not a fill price, realized cost, or wallet result.
 */
export function summarizeQuoteExecutionCostHistory({
  records = [],
  invalidRecordCount = 0,
  markets = [],
  windowsHours = [24, 72],
  tradingFee = 0.0005,
  slippage = 0.001,
  minimumReports = 30,
  minimumDepthReports = 30,
  minimumSamplesPerReport = 5,
  expectedIntervalSeconds = 600,
  freshnessLimitSeconds = 900,
  referenceNotionalsKrw = [],
  now = Date.now()
} = {}) {
  const requestedNow = Number(now);
  const nowMs = Number.isFinite(requestedNow) ? requestedNow : Date.now();
  const fee = finiteNonNegative(tradingFee);
  const adverseSlippage = finiteNonNegative(slippage);
  const minimumReportCount = Math.max(1, Math.floor(Number(minimumReports) || 1));
  const minimumDepthReportCount = Math.max(1, Math.floor(Number(minimumDepthReports) || 1));
  const minimumSampleCount = Math.max(1, Math.floor(Number(minimumSamplesPerReport) || 1));
  const scheduleSeconds = finitePositive(expectedIntervalSeconds) || 600;
  const freshnessSeconds = finitePositive(freshnessLimitSeconds) || 900;
  const referenceNotionals = normalizeReferenceNotionals(referenceNotionalsKrw);
  const adverseSlippageBudgetPercent = adverseSlippage === null ? null : adverseSlippage * 2 * 100;
  const assumedRoundTripCostPercent = fee === null || adverseSlippage === null
    ? null
    : (fee * 2 + adverseSlippage * 2) * 100;
  const normalized = normalizeQuoteHistoryRecords(records, nowMs);
  const validRecords = normalized.validRecords;
  const latest = validRecords.at(-1) || null;
  const latestAgeSeconds = latest && Number.isFinite(nowMs)
    ? Math.max(0, Math.floor((nowMs - latest.generatedAtMs) / 1000))
    : null;
  const latestFresh = latestAgeSeconds !== null && latestAgeSeconds <= freshnessSeconds;
  const latestSampler = {
    generatedAt: latest?.generatedAt || null,
    ageSeconds: latestAgeSeconds,
    fresh: latestFresh,
    complete: latest?.complete === true,
    errorCount: latest?.errorCount ?? null,
    sampleCount: latest?.reportSampleCount ?? null,
    requestedSampleCount: latest?.requestedSampleCount ?? null,
    marketCount: Object.keys(latest?.summaryMarkets || {}).length,
    contractReady: latestFresh && latest?.complete === true
  };
  const normalizedMarkets = normalizeMarkets(markets);
  const marketNames = normalizedMarkets.length > 0
    ? normalizedMarkets
    : [...new Set(validRecords.flatMap(record => Object.keys(record.summaryMarkets)))].sort();
  const normalizedWindowsHours = [...new Set((Array.isArray(windowsHours) ? windowsHours : [24, 72])
    .map(value => Number(value))
    .filter(value => Number.isFinite(value) && value > 0))]
    .sort((left, right) => left - right);
  const windows = [
    ...normalizedWindowsHours.map(hours => ({ label: `last_${hours}h`, hours, durationMs: hours * 60 * 60 * 1000 })),
    { label: 'all_loaded', hours: null, durationMs: null }
  ].map(window => {
    const windowRecords = window.durationMs === null
      ? validRecords
      : validRecords.filter(record => record.generatedAtMs >= nowMs - window.durationMs);
    const completeReports = windowRecords.filter(record => record.complete);
    const latestWindowReport = windowRecords.at(-1) || null;
    return {
      label: window.label,
      hours: window.hours,
      from: windowRecords[0]?.generatedAt || null,
      to: latestWindowReport?.generatedAt || null,
      reportCount: windowRecords.length,
      completeReportCount: completeReports.length,
      incompleteReportCount: windowRecords.length - completeReports.length,
      errorReportCount: windowRecords.filter(record => record.errorCount > 0).length,
      cadence: summarizeQuoteHistoryCadence(windowRecords, scheduleSeconds, freshnessSeconds),
      markets: Object.fromEntries(marketNames.map(market => [market, summarizeQuoteHistoryMarket({
        reports: completeReports,
        market,
        minimumReports: minimumReportCount,
        minimumDepthReports: minimumDepthReportCount,
        minimumSamplesPerReport: minimumSampleCount,
        adverseSlippageBudgetPercent,
        referenceNotionalsKrw: referenceNotionals
      })]))
    };
  });

  return {
    generatedAt: new Date(nowMs).toISOString(),
    researchOnly: true,
    promoted: false,
    historyRecordCount: Array.isArray(records) ? records.length : 0,
    invalidRecordCount: Math.max(0, Math.floor(Number.isFinite(Number(invalidRecordCount))
      ? Number(invalidRecordCount)
      : 0)) + normalized.invalidRecordCount,
    futureTimestampCount: normalized.futureTimestampCount,
    expectedIntervalSeconds: scheduleSeconds,
    freshnessLimitSeconds: freshnessSeconds,
    minimumReportCount: minimumReportCount,
    minimumDepthReportCount,
    minimumSamplesPerReport: minimumSampleCount,
    referenceNotionalsKrw: referenceNotionals,
    costModel: {
      tradingFeeRatePerSide: fee,
      slippageRatePerSide: adverseSlippage,
      assumedRoundTripCostPercent,
      adverseSlippageBudgetPercent
    },
    latestSampler,
    windows,
    note: 'The p95 is the p95 of per-report p95 spread observations. Spread and top-of-book depth are not a fill or realized-cost record; depth summarizes only sampled best levels, not full-book depth. Fee/slippage assumptions do not establish realized cost or P&L, and this report is not an order or promotion gate.'
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
