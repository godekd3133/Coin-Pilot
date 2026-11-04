// Horizon (chart-analysis) portfolio presentation. The sleeve list always
// comes from the server response (`sleeves` keys + research results), never
// from a hard-coded list, so a new server profile appears automatically.

export const PAUSE_REASON_LABELS = Object.freeze({
  pending_order_unresolved: '확인되지 않은 주문이 있어 신규 진입을 잠갔습니다.',
  exchange_state_unverified: '거래소 잔고를 확인하지 못해 신규 진입을 잠갔습니다.',
  market_closed: '장 운영 시간이 아닙니다.',
  params_unvalidated: '검증된 연구 결과가 없어 신규 진입을 하지 않습니다.'
});

export function pauseReasonLabel(reason) {
  if (!reason) return '';
  return PAUSE_REASON_LABELS[reason] || String(reason);
}

/** Merge sleeve status with its research verdict. */
export function horizonSleeves(status) {
  if (!status || typeof status !== 'object') return [];
  const sleeves = status.sleeves && typeof status.sleeves === 'object' ? status.sleeves : {};
  const research = Array.isArray(status.research?.sleeves) ? status.research.sleeves : [];
  const keys = [...new Set([...Object.keys(sleeves), ...research.map(item => item.horizon).filter(Boolean)])];
  const positions = Array.isArray(status.positions) ? status.positions : [];
  return keys.map(key => {
    const sleeve = sleeves[key] || {};
    const verdict = research.find(item => item.horizon === key) || null;
    const sleevePositions = positions.filter(position => position.sleeve === key);
    const unrealized = sleevePositions.reduce((sum, position) => sum + (Number.isFinite(Number(position.unrealizedProfit)) ? Number(position.unrealizedProfit) : 0), 0);
    return {
      key,
      label: sleeve.label || key,
      enabled: sleeve.enabled === true,
      weight: Number.isFinite(Number(sleeve.weight)) ? Number(sleeve.weight) : null,
      interval: sleeve.interval ?? verdict?.interval ?? null,
      positionCount: Number.isFinite(Number(sleeve.positions)) ? Number(sleeve.positions) : sleevePositions.length,
      positions: sleevePositions,
      realizedProfit: Number.isFinite(Number(sleeve.realizedProfit)) ? Number(sleeve.realizedProfit) : null,
      unrealizedProfit: sleevePositions.some(position => Number.isFinite(Number(position.unrealizedProfit))) ? unrealized : null,
      trades: Number.isFinite(Number(sleeve.trades)) ? Number(sleeve.trades) : null,
      winRate: Number.isFinite(Number(sleeve.winRate)) ? Number(sleeve.winRate) : null,
      lastAnalysis: sleeve.lastAnalysis || null,
      verdict: verdict ? {
        passed: verdict.passed === true,
        outOfSampleReturnPercent: Number.isFinite(Number(verdict.outOfSampleReturnPercent)) ? Number(verdict.outOfSampleReturnPercent) : null,
        worstDrawdownPercent: Number.isFinite(Number(verdict.worstDrawdownPercent)) ? Number(verdict.worstDrawdownPercent) : null,
        trades: Number.isFinite(Number(verdict.trades)) ? Number(verdict.trades) : null
      } : null
    };
  });
}

/** Flattens /api/horizons/status into runtime cards: coin + stock modes. */
export function horizonRuntimes(payload) {
  const runtimes = [];
  if (payload?.coin) runtimes.push({ id: 'coin', asset: 'coin', assetLabel: '코인', status: payload.coin });
  for (const [mode, status] of Object.entries(payload?.stock || {})) {
    if (status) runtimes.push({ id: `stock-${mode}`, asset: 'stock', assetLabel: '주식', mode, status });
  }
  return runtimes;
}

export function horizonRuntimeSummary(status) {
  const mode = status?.mode === 'live' ? 'live' : 'paper';
  const research = status?.research || null;
  const sleeves = horizonSleeves(status);
  const validatedCount = sleeves.filter(sleeve => sleeve.verdict?.passed).length;
  const realized = sleeves.reduce((sum, sleeve) => sum + (sleeve.realizedProfit || 0), 0);
  return {
    mode,
    running: status?.running === true,
    desiredRunning: status?.desiredRunning !== false,
    entriesPaused: status?.entriesPaused === true,
    pauseReason: pauseReasonLabel(status?.pauseReason),
    pendingOrders: Number(status?.pendingOrders) || 0,
    lastCycleAt: status?.lastCycleAt || null,
    lastError: status?.lastError || null,
    paramsValidated: status?.paramsValidated !== false,
    totalAssets: Number.isFinite(Number(status?.totalAssets)) ? Number(status.totalAssets) : null,
    cash: Number.isFinite(Number(status?.cash)) ? Number(status.cash) : null,
    initialSeedMoney: Number.isFinite(Number(status?.initialSeedMoney)) ? Number(status.initialSeedMoney) : null,
    capitalRatio: Number.isFinite(Number(status?.capitalRatio)) ? Number(status.capitalRatio) : null,
    researchGeneratedAt: research?.generatedAt || null,
    researchMarkets: Number.isFinite(Number(research?.markets)) ? Number(research.markets) : null,
    researchRunning: research?.scheduler?.running === true,
    researchError: research?.scheduler?.lastError || null,
    sleeves,
    validatedCount,
    realizedProfit: realized,
    positions: Array.isArray(status?.positions) ? status.positions : [],
    recentTrades: Array.isArray(status?.recentTrades) ? status.recentTrades : []
  };
}
