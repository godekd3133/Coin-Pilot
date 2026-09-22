function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function marketOf(trade) {
  const market = trade?.coin || trade?.market;
  return typeof market === 'string' && market.trim() ? market.trim() : null;
}

function signalKeyOf(trade) {
  const signalKey = trade?.signalKey || trade?.entrySignalKey || trade?.signal?.signalKey;
  return signalKey === null || signalKey === undefined || String(signalKey).trim() === ''
    ? null
    : String(signalKey);
}

function exitTimeOf(trade) {
  return trade?.exitTime || trade?.exitTimestamp || null;
}

function entryTimeOf(trade) {
  return trade?.entryTime || trade?.entryTimestamp || null;
}

function indexTrades(trades, profitField) {
  const index = new Map();
  for (const trade of Array.isArray(trades) ? trades : []) {
    const market = marketOf(trade);
    const signalKey = signalKeyOf(trade);
    const profit = finiteNumber(trade?.[profitField]);
    if (!market || !signalKey || profit === null) continue;
    const key = `${market}:${signalKey}`;
    const entries = index.get(key) || [];
    entries.push({ trade, market, signalKey, profit });
    index.set(key, entries);
  }
  return index;
}

function compareBook({
  strictTrades,
  diagnosticTrades,
  diagnosticBook,
  diagnosticProfitField
}) {
  const strictIndex = indexTrades(strictTrades, 'profit');
  const diagnosticIndex = indexTrades(diagnosticTrades, diagnosticProfitField);
  const keys = [...new Set([...strictIndex.keys(), ...diagnosticIndex.keys()])].sort();
  const rows = [];
  let ambiguousPairCount = 0;

  for (const key of keys) {
    const strictEntries = strictIndex.get(key) || [];
    const diagnosticEntries = diagnosticIndex.get(key) || [];
    if (strictEntries.length !== 1 || diagnosticEntries.length !== 1) {
      if (strictEntries.length > 0 && diagnosticEntries.length > 0) ambiguousPairCount += 1;
      continue;
    }
    const strict = strictEntries[0];
    const diagnostic = diagnosticEntries[0];
    const strictProfitPositive = strict.profit > 0;
    const diagnosticProfitPositive = diagnostic.profit > 0;
    const strictProfitPercent = finiteNumber(strict.trade?.profitPercent);
    const diagnosticProfitPercent = finiteNumber(diagnostic.trade?.profitPercent);
    rows.push({
      market: strict.market,
      signalKey: strict.signalKey,
      strictProfit: strict.profit,
      diagnosticProfit: diagnostic.profit,
      strictProfitPercent,
      diagnosticProfitPercent,
      diagnosticMinusStrictProfit: diagnostic.profit - strict.profit,
      diagnosticMinusStrictProfitPercent: strictProfitPercent !== null &&
        diagnosticProfitPercent !== null
        ? diagnosticProfitPercent - strictProfitPercent
        : null,
      strictOutcome: strictProfitPositive ? 'positive' : 'non_positive',
      diagnosticOutcome: diagnosticProfitPositive ? 'positive' : 'non_positive',
      signChanged: strictProfitPositive !== diagnosticProfitPositive,
      strictEntryDelayMs: finiteNumber(strict.trade?.entryDelayMs),
      diagnosticEntryDelayMs: finiteNumber(diagnostic.trade?.entryDelayMs),
      strictExecutionDriftPercent: finiteNumber(strict.trade?.executionDriftPercent),
      diagnosticExecutionDriftPercent: finiteNumber(diagnostic.trade?.executionDriftPercent),
      strictEntryTime: entryTimeOf(strict.trade),
      diagnosticEntryTime: entryTimeOf(diagnostic.trade),
      strictExitTime: exitTimeOf(strict.trade),
      diagnosticExitTime: exitTimeOf(diagnostic.trade)
    });
  }

  const pairedKeys = new Set(rows.map(row => `${row.market}:${row.signalKey}`));
  const strictCandidateCount = [...strictIndex.keys()].length;
  const diagnosticCandidateCount = [...diagnosticIndex.keys()].length;
  const signFlipRows = rows.filter(row => row.signChanged);
  const strictPositiveDiagnosticNegativeRows = rows.filter(row =>
    row.strictOutcome === 'positive' && row.diagnosticOutcome === 'non_positive'
  );
  const strictNonPositiveDiagnosticPositiveRows = rows.filter(row =>
    row.strictOutcome === 'non_positive' && row.diagnosticOutcome === 'positive'
  );
  const strictPairProfit = rows.reduce((sum, row) => sum + row.strictProfit, 0);
  const diagnosticPairProfit = rows.reduce((sum, row) => sum + row.diagnosticProfit, 0);
  const diagnosticMinusStrictProfit = diagnosticPairProfit - strictPairProfit;
  const percentDeltas = rows
    .map(row => row.diagnosticMinusStrictProfitPercent)
    .filter(value => value !== null);

  return {
    diagnosticBook,
    diagnosticProfitField,
    pairedCount: rows.length,
    strictCandidateCount,
    diagnosticCandidateCount,
    unmatchedStrictCount: [...strictIndex.keys()]
      .filter(key => !pairedKeys.has(key)).length,
    unmatchedDiagnosticCount: [...diagnosticIndex.keys()]
      .filter(key => !pairedKeys.has(key)).length,
    ambiguousPairCount,
    signFlipCount: signFlipRows.length,
    strictPositiveDiagnosticNegativeCount: strictPositiveDiagnosticNegativeRows.length,
    strictNonPositiveDiagnosticPositiveCount: strictNonPositiveDiagnosticPositiveRows.length,
    strictPairProfit,
    diagnosticPairProfit,
    diagnosticMinusStrictProfit,
    averageDiagnosticMinusStrictProfit: rows.length > 0
      ? diagnosticMinusStrictProfit / rows.length
      : null,
    averageDiagnosticMinusStrictProfitPercent: percentDeltas.length > 0
      ? percentDeltas.reduce((sum, value) => sum + value, 0) / percentDeltas.length
      : null,
    rows: rows.slice(-100),
    note: '같은 시장·signalKey를 가진 paper 장부의 modeled outcome 비교입니다. 실제 fill, partial fill, wallet settlement, 또는 live 수익성을 의미하지 않습니다.'
  };
}

export const DEFAULT_PAPER_EXECUTION_MIN_PAIRS = 10;

/**
 * Pair strict delayed-confirmation outcomes with the diagnostic books by the
 * exact market and signal key. Ambiguous duplicate keys are excluded instead
 * of selecting an optimistic match.
 */
export function summarizePaperExecutionComparison({
  strictTrades = [],
  shadowTrades = [],
  looseShadowTrades = []
} = {}) {
  const strictVsShadow = compareBook({
    strictTrades,
    diagnosticTrades: shadowTrades,
    diagnosticBook: 'shadow',
    diagnosticProfitField: 'netProfit'
  });
  const strictVsLooseShadow = compareBook({
    strictTrades,
    diagnosticTrades: looseShadowTrades,
    diagnosticBook: 'looseShadow',
    diagnosticProfitField: 'netProfit'
  });
  return {
    available: strictVsShadow.pairedCount > 0 || strictVsLooseShadow.pairedCount > 0,
    researchOnly: true,
    promoted: false,
    strictVsShadow,
    strictVsLooseShadow,
    note: '동일 시장·signalKey 기준의 실행 경계 모델 비교입니다. 실제 체결·지갑 정산·live profitability 증거가 아닙니다.'
  };
}

/**
 * Conservative research-promotion guard for the primary diagnostic shadow.
 * It is intentionally not a live-order gate and is not required for a
 * strict-only session, where the relaxed book is deliberately disabled.
 */
export function evaluatePaperExecutionRobustnessGate(comparison, {
  required = true,
  minimumPairs = DEFAULT_PAPER_EXECUTION_MIN_PAIRS
} = {}) {
  const minimumPairCount = Math.max(1, Math.floor(Number(minimumPairs) || DEFAULT_PAPER_EXECUTION_MIN_PAIRS));
  const primary = comparison?.strictVsShadow || {};
  const pairedCount = Math.max(0, Number(primary.pairedCount) || 0);
  const signFlipCount = Math.max(0, Number(primary.signFlipCount) || 0);
  const strictPositiveDiagnosticNegativeCount = Math.max(
    0,
    Number(primary.strictPositiveDiagnosticNegativeCount) || 0
  );
  const diagnosticPairProfit = Number.isFinite(Number(primary.diagnosticPairProfit))
    ? Number(primary.diagnosticPairProfit)
    : null;
  const passed = required !== true || (
    pairedCount >= minimumPairCount &&
    signFlipCount === 0 &&
    diagnosticPairProfit !== null &&
    diagnosticPairProfit > 0
  );
  const reason = required !== true
    ? 'execution_robustness_not_required'
    : pairedCount < minimumPairCount
      ? 'execution_comparison_pairs_insufficient'
      : strictPositiveDiagnosticNegativeCount > 0
        ? 'execution_positive_to_negative_flip_detected'
        : signFlipCount > 0
          ? 'execution_outcome_sign_flip_detected'
          : diagnosticPairProfit === null || diagnosticPairProfit <= 0
            ? 'diagnostic_pair_profit_not_positive'
            : 'execution_comparison_passed';
  return {
    required: required === true,
    passed,
    reason,
    diagnosticBook: 'shadow',
    minimumPairs: minimumPairCount,
    pairedCount,
    signFlipCount,
    strictPositiveDiagnosticNegativeCount,
    diagnosticPairProfit,
    researchOnly: true,
    promoted: false,
    note: 'paper execution robustness is a modeled same-signal diagnostic, not an observed fill, wallet settlement, or live-order gate'
  };
}
