import { scoreAdviceOutcome } from './monitoringSessionService.js';

export const DEFAULT_ROBUSTNESS_MIN_NON_NEUTRAL = 20;

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function increment(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function summarizeRows(rows = [], neutralBandPercent = 0.3) {
  const summary = {
    responses: 0,
    failures: 0,
    hits: 0,
    misses: 0,
    flat: 0,
    calm: 0,
    abstained: 0,
    vetoGood: 0,
    vetoMissedOpportunity: 0,
    vetoFlat: 0,
    nonNeutral: 0,
    directionalPredictions: 0,
    vetoNetImpactPercent: 0,
    actions: {},
    verdicts: {}
  };

  for (const row of rows) {
    const action = row.action || row.advice?.action || 'WAIT';
    const scored = scoreAdviceOutcome(
      { action, confidence: row.confidence },
      row.priceChangePercent,
      neutralBandPercent,
      row.eventAction || (row.eventType === 'SELL_SIGNAL' ? 'SELL' : row.eventType === 'BUY_SIGNAL' ? 'BUY' : null)
    );
    summary.responses += 1;
    increment(summary.actions, scored.action);
    increment(summary.verdicts, scored.verdict);
    if (scored.verdict === 'HIT') {
      summary.hits += 1;
      summary.directionalPredictions += 1;
      summary.nonNeutral += 1;
    } else if (scored.verdict === 'MISS') {
      summary.misses += 1;
      summary.directionalPredictions += 1;
      summary.nonNeutral += 1;
    } else if (scored.verdict === 'FLAT') {
      summary.flat += 1;
      summary.directionalPredictions += 1;
    } else if (scored.verdict === 'CALM') {
      summary.calm += 1;
    } else if (scored.verdict === 'ABSTAINED') {
      summary.abstained += 1;
    }
    if (scored.vetoVerdict === 'VETO_GOOD') {
      summary.vetoGood += 1;
      summary.nonNeutral += 1;
    } else if (scored.vetoVerdict === 'VETO_MISSED_OPPORTUNITY') {
      summary.vetoMissedOpportunity += 1;
      summary.nonNeutral += 1;
    } else if (scored.vetoVerdict === 'VETO_FLAT') {
      summary.vetoFlat += 1;
    }
    const impact = finite(scored.vetoImpactPercent);
    if (impact !== null) summary.vetoNetImpactPercent += impact;
  }

  summary.hitRate = summary.hits + summary.misses > 0
    ? summary.hits / (summary.hits + summary.misses)
    : null;
  summary.vetoNonFlatSuccessRate = summary.vetoGood + summary.vetoMissedOpportunity > 0
    ? summary.vetoGood / (summary.vetoGood + summary.vetoMissedOpportunity)
    : null;
  return summary;
}

function selectReplayRows(report = {}, scope = 'all') {
  const providerRows = Array.isArray(report.rows) ? report.rows : [];
  const consensusRows = Array.isArray(report.consensusRows) ? report.consensusRows : [];
  if (scope === 'consensus') return consensusRows;
  if (scope === 'providers') return providerRows;
  return [...providerRows, ...consensusRows];
}

export function summarizeReplayReport(report = {}, index = 0, neutralBandPercent = 0.3, scope = 'all') {
  const rows = selectReplayRows(report, scope);
  const summary = summarizeRows(rows, neutralBandPercent);
  const failures = Array.isArray(report.failures) ? report.failures.length : 0;
  summary.failures = failures;
  return {
    id: report.outputFile || report.candleFile || report.generatedAt || `window-${index + 1}`,
    generatedAt: report.generatedAt || null,
    source: report.source || 'historical_replay',
    scope,
    selectedSamples: Number(report.selectedSamples) || rows.length,
    responseCount: Number(report.responseCount) || rows.length,
    ...summary
  };
}

export function assessReplayRobustness(reports = [], options = {}) {
  const neutralBandPercent = Math.max(0, Number(options.neutralBandPercent ?? 0.3) || 0);
  const scope = ['consensus', 'providers', 'all'].includes(options.scope) ? options.scope : 'all';
  const minimumNonNeutralSamples = Math.max(
    1,
    Math.floor(Number(options.minimumNonNeutralSamples ?? DEFAULT_ROBUSTNESS_MIN_NON_NEUTRAL) || DEFAULT_ROBUSTNESS_MIN_NON_NEUTRAL)
  );
  const windows = reports.map((report, index) => summarizeReplayReport(report, index, neutralBandPercent, scope));
  const total = windows.reduce((accumulator, window) => {
    for (const key of [
      'responses', 'failures', 'hits', 'misses', 'flat', 'calm', 'abstained',
      'vetoGood', 'vetoMissedOpportunity', 'vetoFlat', 'nonNeutral',
      'directionalPredictions', 'vetoNetImpactPercent'
    ]) accumulator[key] += Number(window[key]) || 0;
    return accumulator;
  }, {
    responses: 0,
    failures: 0,
    hits: 0,
    misses: 0,
    flat: 0,
    calm: 0,
    abstained: 0,
    vetoGood: 0,
    vetoMissedOpportunity: 0,
    vetoFlat: 0,
    nonNeutral: 0,
    directionalPredictions: 0,
    vetoNetImpactPercent: 0
  });
  total.hitRate = total.hits + total.misses > 0 ? total.hits / (total.hits + total.misses) : null;
  total.vetoNonFlatSuccessRate = total.vetoGood + total.vetoMissedOpportunity > 0
    ? total.vetoGood / (total.vetoGood + total.vetoMissedOpportunity)
    : null;

  const nonNeutralWindows = windows.filter(window => window.nonNeutral > 0);
  const hasPositiveWindow = nonNeutralWindows.some(window => window.vetoNetImpactPercent > 0);
  const hasNegativeWindow = nonNeutralWindows.some(window => window.vetoNetImpactPercent < 0);
  const windowSignConflict = hasPositiveWindow && hasNegativeWindow;
  let status = 'INSUFFICIENT_WINDOWS';
  if (windows.length >= 2 && total.nonNeutral < minimumNonNeutralSamples) status = 'INSUFFICIENT_NON_NEUTRAL';
  else if (windows.length >= 2 && windowSignConflict) status = 'WINDOW_CONFLICT';
  else if (windows.length >= 2 && total.vetoNetImpactPercent > 0) status = 'STABLE_POSITIVE_VETO';
  else if (windows.length >= 2 && total.vetoNetImpactPercent < 0) status = 'STABLE_NEGATIVE_VETO';
  else if (windows.length >= 2) status = 'NO_NON_NEUTRAL_VETO';

  return {
    generatedAt: new Date().toISOString(),
    windowCount: windows.length,
    scope,
    neutralBandPercent,
    minimumNonNeutralSamples,
    status,
    evidenceReady: status === 'STABLE_POSITIVE_VETO' || status === 'STABLE_NEGATIVE_VETO',
    windowSignConflict,
    windows,
    total,
    note: 'historical replay window aggregation only; it does not prove live orders, wallet settlement, or promotion eligibility.'
  };
}

export default assessReplayRobustness;
