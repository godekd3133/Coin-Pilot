function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundOrNull(value) {
  const parsed = finiteNumber(value);
  return parsed === null ? null : Math.round(parsed);
}

export function projectReadOnlyPaperPositions(status) {
  const positions = Array.isArray(status?.strictEvaluation?.positions)
    ? status.strictEvaluation.positions
    : [];

  return positions.map(position => ({
    ...position,
    coin: position.coin || position.market || '',
    source: 'paper_ledger',
    currentPrice: null,
    currentValue: null,
    costBasis: null,
    profit: null,
    profitPercent: null,
    valuationStatus: 'mark_not_persisted'
  }));
}

export function projectReadOnlyPaperAccount(status) {
  const currentAssets = finiteNumber(status?.currentAssets);
  const baselineAssets = finiteNumber(status?.baselineAssets);
  const profit = currentAssets === null || baselineAssets === null
    ? null
    : currentAssets - baselineAssets;
  const profitPercent = profit === null || baselineAssets <= 0
    ? null
    : (currentAssets / baselineAssets - 1) * 100;

  return {
    readOnlyObserver: true,
    valuationBasis: 'paper_ledger_snapshot',
    valuationAsOf: status?.lastSnapshotAt || status?.heartbeatAt || null,
    mode: 'DRY_RUN',
    krwBalance: null,
    totalAssets: roundOrNull(currentAssets),
    initialSeedMoney: roundOrNull(baselineAssets),
    realizedProfit: roundOrNull(status?.realizedProfit),
    profit: roundOrNull(profit),
    profitPercent,
    positions: projectReadOnlyPaperPositions(status),
    accounts: null
  };
}

export function projectReadOnlyPaperPortfolioAnalysis(status) {
  const account = projectReadOnlyPaperAccount(status);
  const holdings = account.positions.map(position => ({
    ...position,
    symbol: position.coin.split('-')[1] || position.coin,
    avgPrice: position.avgPrice ?? position.entryPrice ?? null,
    weight: null
  }));

  return {
    readOnlyObserver: true,
    valuationBasis: account.valuationBasis,
    valuationAsOf: account.valuationAsOf,
    allocationAvailable: false,
    realizedProfit: account.realizedProfit,
    holdings,
    summary: {
      totalHoldings: holdings.length,
      totalValue: null,
      totalCost: null,
      totalProfit: account.profit,
      totalProfitPercent: account.profitPercent === null
        ? null
        : account.profitPercent.toFixed(2),
      krwBalance: null,
      krwWeight: null,
      totalAssets: account.totalAssets
    },
    topGainers: [],
    topLosers: []
  };
}
