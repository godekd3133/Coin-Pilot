import { DEFAULT_QUOTE_EXECUTION_COST_MODEL } from './quoteExecutionCostCompatibility.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_QUOTE_FRESHNESS_SECONDS = 900;

function nonNegative(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function finiteNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveInteger(value, fallback) {
  const parsed = Math.floor(Number(value));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function timestampMs(value) {
  if (value instanceof Date) {
    const parsed = value.getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()))) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed < 100_000_000_000 ? parsed * 1000 : parsed;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  const hasTimezone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(text);
  const parsed = Date.parse(hasTimezone ? text : `${text}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function errorCount(value) {
  if (Array.isArray(value)) return value.length;
  const parsed = nonNegative(value);
  return parsed === null ? null : Math.floor(parsed);
}

function normalizeQuoteReports(records, nowMs, minimumSamples) {
  const input = Array.isArray(records) ? records : [];
  const reports = [];
  let latestObservedReport = null;
  let invalidRecordCount = 0;
  let futureTimestampCount = 0;
  let incompleteReportCount = 0;
  let undersampledReportCount = 0;

  for (const record of input) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      invalidRecordCount += 1;
      continue;
    }
    const generatedAtMs = timestampMs(record.generatedAt);
    if (generatedAtMs === null) {
      invalidRecordCount += 1;
      continue;
    }
    if (generatedAtMs > nowMs) {
      futureTimestampCount += 1;
      continue;
    }
    const reportMetadata = {
      generatedAt: record.generatedAt,
      generatedAtMs,
      usable: false
    };
    if (!latestObservedReport || generatedAtMs >= latestObservedReport.generatedAtMs) {
      latestObservedReport = reportMetadata;
    }
    const sampleCount = nonNegative(record.sampleCount);
    const requestedSampleCount = nonNegative(record.requestedSampleCount);
    const errors = errorCount(record.errors);
    const enoughSamples = sampleCount !== null && sampleCount >= minimumSamples &&
      (requestedSampleCount === null || sampleCount >= requestedSampleCount);
    if (record.complete !== true || errors !== 0) {
      incompleteReportCount += 1;
      continue;
    }
    if (!enoughSamples) {
      undersampledReportCount += 1;
      continue;
    }
    const markets = record.summary?.markets;
    if (!markets || typeof markets !== 'object' || Array.isArray(markets)) {
      invalidRecordCount += 1;
      continue;
    }
    reports.push({
      generatedAt: record.generatedAt,
      generatedAtMs,
      sampleCount,
      markets
    });
    reportMetadata.usable = true;
  }

  reports.sort((left, right) => left.generatedAtMs - right.generatedAtMs);
  return {
    reports,
    latestObservedReport,
    invalidRecordCount,
    futureTimestampCount,
    incompleteReportCount,
    undersampledReportCount
  };
}

function marketSpread(row) {
  const median = nonNegative(row?.median);
  const p95 = nonNegative(row?.p95);
  if (median === null || p95 === null || p95 < median) return null;
  return { median, p95 };
}

function matchPriorQuote(reports, targetMs, market, maxAgeMs) {
  if (targetMs === null) {
    return { available: false, reason: 'event_timestamp_unavailable' };
  }
  const normalizedMarket = String(market || '').trim().toUpperCase();
  if (!normalizedMarket) return { available: false, reason: 'market_unavailable' };

  let matched = null;
  for (const report of reports) {
    if (report.generatedAtMs > targetMs) break;
    const ageMs = targetMs - report.generatedAtMs;
    if (ageMs > maxAgeMs) continue;
    const spread = marketSpread(report.markets[normalizedMarket]);
    if (!spread) continue;
    matched = {
      available: true,
      reportGeneratedAt: report.generatedAt,
      ageSeconds: ageMs / 1000,
      sampleCount: report.sampleCount,
      medianSpreadPercent: spread.median,
      reportP95SpreadPercent: spread.p95
    };
  }
  return matched || { available: false, reason: 'no_prior_complete_quote_within_freshness_limit' };
}

function sumNullable(values) {
  if (values.length === 0) return null;
  if (values.some(value => value === null || !Number.isFinite(Number(value)))) return null;
  return values.reduce((total, value) => total + Number(value), 0);
}

function buildTradeAudit(trade, reports, {
  maxAgeMs,
  requiredCostPercent,
  ledgerCostPercent,
  dailyCandleMs
} = {}) {
  const market = String(trade?.market || trade?.coin || '').trim().toUpperCase() || null;
  const entry = trade?.entry && typeof trade.entry === 'object' ? trade.entry : {};
  // entryTimeMs is the actual owner decision time. entryTs is only the signal
  // candle key, so using it as a fallback would introduce timing lookahead.
  const entryTimeMs = timestampMs(entry.entryTimeMs);
  const exitCandleStartMs = timestampMs(trade?.exitTs);
  const exitExecutionTimeMs = exitCandleStartMs === null
    ? null
    : exitCandleStartMs + dailyCandleMs;
  const entryQuoteMatch = matchPriorQuote(reports, entryTimeMs, market, maxAgeMs);
  const exitQuoteMatch = matchPriorQuote(reports, exitExecutionTimeMs, market, maxAgeMs);
  const quoteTimesMatched = entryQuoteMatch.available && exitQuoteMatch.available;
  const executionModel = typeof trade?.executionModel === 'string'
    ? trade.executionModel
    : 'unknown';
  const profitPercent = finiteNumber(trade?.profitPercent);
  const positionNotionalKrw = nonNegative(entry.size);
  const additionalCostToFloorPercent = ledgerCostPercent === null || requiredCostPercent === null
    ? null
    : Math.max(0, requiredCostPercent - ledgerCostPercent);
  const currentNetPnlKrw = profitPercent === null || positionNotionalKrw === null
    ? null
    : positionNotionalKrw * profitPercent / 100;
  const costFloorStressNetPercent = profitPercent === null || additionalCostToFloorPercent === null
    ? null
    : profitPercent - additionalCostToFloorPercent;
  const costFloorStressNetKrw = costFloorStressNetPercent === null || positionNotionalKrw === null
    ? null
    : positionNotionalKrw * costFloorStressNetPercent / 100;
  const quoteSpreadAdjustmentAllowed = quoteTimesMatched && executionModel === 'candle_close';
  const roundTripSpreadMedianProxyPercent = quoteSpreadAdjustmentAllowed
    ? (entryQuoteMatch.medianSpreadPercent + exitQuoteMatch.medianSpreadPercent) / 2
    : null;
  const roundTripSpreadReportP95ProxyPercent = quoteSpreadAdjustmentAllowed
    ? (entryQuoteMatch.reportP95SpreadPercent + exitQuoteMatch.reportP95SpreadPercent) / 2
    : null;
  const medianSpreadScenarioNetPercent = costFloorStressNetPercent === null ||
    roundTripSpreadMedianProxyPercent === null
    ? null
    : costFloorStressNetPercent - roundTripSpreadMedianProxyPercent;
  const reportP95SpreadScenarioNetPercent = costFloorStressNetPercent === null ||
    roundTripSpreadReportP95ProxyPercent === null
    ? null
    : costFloorStressNetPercent - roundTripSpreadReportP95ProxyPercent;

  return {
    market,
    executionModel,
    entryTime: entryTimeMs === null ? null : new Date(entryTimeMs).toISOString(),
    exitCandleStart: exitCandleStartMs === null ? null : new Date(exitCandleStartMs).toISOString(),
    exitExecutionTime: exitExecutionTimeMs === null ? null : new Date(exitExecutionTimeMs).toISOString(),
    positionNotionalKrw,
    ledgerNetProfitPercent: profitPercent,
    currentNetPnlKrw,
    entryQuoteMatch,
    exitQuoteMatch,
    additionalCostToFloorPercent: additionalCostToFloorPercent,
    costFloorStressNetPercent,
    costFloorStressNetKrw,
    roundTripSpreadMedianProxyPercent,
    roundTripSpreadReportP95ProxyPercent,
    medianSpreadScenarioNetPercent,
    medianSpreadScenarioNetKrw: medianSpreadScenarioNetPercent === null || positionNotionalKrw === null
      ? null
      : positionNotionalKrw * medianSpreadScenarioNetPercent / 100,
    reportP95SpreadScenarioNetPercent,
    reportP95SpreadScenarioNetKrw: reportP95SpreadScenarioNetPercent === null || positionNotionalKrw === null
      ? null
      : positionNotionalKrw * reportP95SpreadScenarioNetPercent / 100,
    quoteMatchAvailable: quoteTimesMatched,
    spreadScenarioUnavailableReason: !quoteTimesMatched
      ? 'both_prior_quote_matches_required'
      : executionModel !== 'candle_close'
        ? 'execution_model_already_uses_or_does_not_identify_candle_close'
        : null
  };
}

/**
 * Join closed daily-shadow trades to the last complete quote-history summary
 * observed before each entry and completed-bar exit. This is a stress
 * diagnostic only: report medians/p95s are not raw quotes or actual fills.
 */
export function summarizeMomentumShadowTradeCostAudit({
  ledger = null,
  quoteHistoryRecords = [],
  invalidQuoteHistoryRecordCount = 0,
  now = Date.now(),
  maxQuoteAgeSeconds = DEFAULT_QUOTE_FRESHNESS_SECONDS,
  minimumSamplesPerReport = 5,
  dailyCandleMs = DAY_MS,
  requiredRoundTripCostPercent = DEFAULT_QUOTE_EXECUTION_COST_MODEL.assumedRoundTripCostPercent
} = {}) {
  const nowValue = Number(now);
  const nowMs = Number.isFinite(nowValue) ? nowValue : Date.now();
  const maxAgeSeconds = Number.isFinite(Number(maxQuoteAgeSeconds)) && Number(maxQuoteAgeSeconds) >= 0
    ? Number(maxQuoteAgeSeconds)
    : DEFAULT_QUOTE_FRESHNESS_SECONDS;
  const maxAgeMs = maxAgeSeconds * 1000;
  const sampleFloor = positiveInteger(minimumSamplesPerReport, 5);
  const dailyDurationMs = nonNegative(dailyCandleMs);
  const candleDurationMs = dailyDurationMs === null || dailyDurationMs <= 0 ? DAY_MS : dailyDurationMs;
  const requiredCost = nonNegative(requiredRoundTripCostPercent);
  const ledgerCost = nonNegative(ledger?.config?.costPercent);
  const normalized = normalizeQuoteReports(quoteHistoryRecords, nowMs, sampleFloor);
  const latestReport = normalized.latestObservedReport;
  const latestAgeSeconds = latestReport
    ? Math.max(0, Math.floor((nowMs - latestReport.generatedAtMs) / 1000))
    : null;
  const trades = Array.isArray(ledger?.trades) ? ledger.trades : [];
  const audits = trades.map(trade => buildTradeAudit(trade, normalized.reports, {
    maxAgeMs,
    requiredCostPercent: requiredCost,
    ledgerCostPercent: ledgerCost,
    dailyCandleMs: candleDurationMs
  }));
  const tradePnl = audit => audit.currentNetPnlKrw;
  const floorPnl = audit => audit.costFloorStressNetKrw;
  const quoteMatchedAudits = audits.filter(audit => audit.quoteMatchAvailable);
  const matchedSpreadAudits = audits.filter(audit =>
    audit.roundTripSpreadMedianProxyPercent !== null &&
    audit.roundTripSpreadReportP95ProxyPercent !== null
  );
  const unmatchedSpreadCostTradeCount = Math.max(0, audits.length - matchedSpreadAudits.length);
  const fullCohortQuoteSpreadAdjusted = audits.length > 0 && unmatchedSpreadCostTradeCount === 0;

  return {
    schema: 'coinpilot.momentum-shadow.trade-cost-audit.v1',
    generatedAt: new Date(nowMs).toISOString(),
    researchOnly: true,
    promoted: false,
    promotionAllowed: false,
    actualFillsObserved: false,
    ledger: {
      active: ledger?.runnerState === 'running' || ledger?.active === true,
      configCostPercent: ledgerCost,
      requiredRoundTripCostPercent: requiredCost,
      additionalCostToFloorPercent: ledgerCost === null || requiredCost === null
        ? null
        : Math.max(0, requiredCost - ledgerCost),
      configDrift: Boolean(ledger?.configDrift),
      openPositionCount: Object.keys(ledger?.positions || {}).length,
      closedTradeCount: trades.length
    },
    quoteHistory: {
      inputReportCount: Array.isArray(quoteHistoryRecords) ? quoteHistoryRecords.length : 0,
      usableReportCount: normalized.reports.length,
      invalidRecordCount: Math.max(0, Number(invalidQuoteHistoryRecordCount) || 0) + normalized.invalidRecordCount,
      futureTimestampCount: normalized.futureTimestampCount,
      incompleteReportCount: normalized.incompleteReportCount,
      undersampledReportCount: normalized.undersampledReportCount,
      latestGeneratedAt: latestReport?.generatedAt || null,
      latestAgeSeconds,
      maxAgeSeconds,
      latestFresh: latestAgeSeconds !== null && latestAgeSeconds <= maxAgeSeconds &&
        normalized.futureTimestampCount === 0,
      latestUsable: latestReport?.usable === true && normalized.futureTimestampCount === 0
    },
    quoteMatchedTradeCount: quoteMatchedAudits.length,
    unmatchedQuoteTradeCount: Math.max(0, audits.length - quoteMatchedAudits.length),
    spreadScenarioTradeCount: matchedSpreadAudits.length,
    unmatchedSpreadCostTradeCount: Math.max(0, audits.length - matchedSpreadAudits.length),
    fullCohort: {
      paperNetPnlKrw: sumNullable(audits.map(tradePnl)),
      costFloorStressNetPnlKrw: sumNullable(audits.map(floorPnl)),
      quoteSpreadAdjustedMedianScenarioNetPnlKrw: fullCohortQuoteSpreadAdjusted
        ? sumNullable(audits.map(audit => audit.medianSpreadScenarioNetKrw))
        : null,
      quoteSpreadAdjustedReportP95ScenarioNetPnlKrw: fullCohortQuoteSpreadAdjusted
        ? sumNullable(audits.map(audit => audit.reportP95SpreadScenarioNetKrw))
        : null,
      unmatchedSpreadCostTradeCount,
      note: 'full-cohort quote-adjusted P&L is unavailable while any closed trade lacks a valid prior quote match or candle-close spread scenario; unmatched spread cost is never filled with zero'
    },
    quoteMatchedSubset: {
      tradeCount: matchedSpreadAudits.length,
      paperNetPnlKrw: sumNullable(matchedSpreadAudits.map(tradePnl)),
      costFloorStressNetPnlKrw: sumNullable(matchedSpreadAudits.map(floorPnl)),
      medianSpreadCostKrw: sumNullable(matchedSpreadAudits.map(audit =>
        audit.positionNotionalKrw === null ? null :
          audit.positionNotionalKrw * audit.roundTripSpreadMedianProxyPercent / 100
      )),
      medianSpreadScenarioNetPnlKrw: sumNullable(matchedSpreadAudits.map(audit =>
        audit.medianSpreadScenarioNetKrw
      )),
      reportP95SpreadCostKrw: sumNullable(matchedSpreadAudits.map(audit =>
        audit.positionNotionalKrw === null ? null :
          audit.positionNotionalKrw * audit.roundTripSpreadReportP95ProxyPercent / 100
      )),
      reportP95SpreadScenarioNetPnlKrw: sumNullable(matchedSpreadAudits.map(audit =>
        audit.reportP95SpreadScenarioNetKrw
      )),
      note: 'matched candle-close subset only; report-level median/p95 spread proxies are not fills and omit full-book depth, queueing, and unobserved slippage'
    },
    trades: audits,
    note: 'daily exit timestamps are advanced by one completed candle interval before prior-only matching; this audit is a cost sensitivity, not realized execution evidence, profitability proof, or promotion approval'
  };
}
