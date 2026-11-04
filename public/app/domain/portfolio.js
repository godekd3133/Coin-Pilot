// Asset aggregation for the home screen and portfolio allocation.

const isKnownAmount = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));

/**
 * Composition percentages only when every item and the cash balance are
 * known; a missing valuation never becomes a 0% slice.
 */
export function portfolioAllocationPresentation(holdings, cashBalance) {
  const holdingsKnown = Array.isArray(holdings);
  const holdingItems = holdingsKnown
    ? holdings.map(item => ({ name: String(item?.name || '보유 자산'), value: isKnownAmount(item?.value) ? Number(item.value) : null }))
    : [{ name: '보유 종목', value: null }];
  const cash = isKnownAmount(cashBalance) ? Number(cashBalance) : null;
  const items = [...holdingItems, { name: 'KRW', value: cash }];
  const holdingsComplete = holdingsKnown && holdingItems.every(item => item.value !== null && item.value >= 0);
  const cashComplete = cash !== null && cash >= 0;
  if (!holdingsComplete || !cashComplete) {
    const unknownParts = [];
    if (!holdingsKnown) unknownParts.push('보유 종목');
    else if (!holdingsComplete) unknownParts.push('일부 종목 평가액');
    if (!cashComplete) unknownParts.push('현금 잔액');
    return { kind: 'partial', items, total: null, message: `${unknownParts.join('과 ')}을 확인할 수 없어 자산 비율을 표시하지 않습니다.` };
  }
  const positiveItems = items.filter(item => item.value > 0);
  const total = positiveItems.reduce((sum, item) => sum + item.value, 0);
  if (positiveItems.length === 0) return { kind: 'zero', items, total: 0, message: '확인된 자산 평가액이 0원이라 구성 비율을 표시하지 않습니다.' };
  const allocated = positiveItems.map(item => ({ ...item, percentage: (item.value / total) * 100 }));
  return { kind: allocated.length === 1 ? 'single' : 'multi', items: allocated, total, message: null };
}

export function hasUsableHistoryTrend(points) {
  if (!Array.isArray(points) || points.length < 2) return false;
  const timestamps = new Set();
  for (const point of points) {
    const timestamp = Date.parse(point?.timestamp ?? point?.capturedAt ?? '');
    if (Number.isFinite(timestamp)) timestamps.add(timestamp);
    if (timestamps.size >= 2) return true;
  }
  return false;
}

/**
 * Combined total across engines. Each part is {label, value, known}. The total
 * is only reported when every enabled part is known; otherwise `partial`.
 */
export function combinedAssets(parts) {
  const enabled = (parts || []).filter(part => part && part.enabled !== false);
  const known = enabled.filter(part => isKnownAmount(part.value));
  const total = known.reduce((sum, part) => sum + Number(part.value), 0);
  return {
    total: enabled.length > 0 && known.length === enabled.length ? total : null,
    knownTotal: known.length ? total : null,
    partial: known.length !== enabled.length,
    missing: enabled.filter(part => !isKnownAmount(part.value)).map(part => part.label),
    parts: enabled.map(part => ({ ...part, value: isKnownAmount(part.value) ? Number(part.value) : null }))
  };
}

/** Coin positions from /api/account (strategy, holdings or exchange). */
export function coinPositions(account) {
  return Array.isArray(account?.positions) ? account.positions : [];
}

/**
 * Asset parts for the current workspace. In LIVE the coin horizon sleeves hold
 * coins in the same exchange account the scalper values, so they are not
 * added again (no double counting). Paper engines keep separate ledgers.
 */
export function workspaceAssetParts({ mode, account, stocks, horizons }) {
  const live = mode === 'LIVE';
  const stockMode = live ? 'live' : 'paper';
  const parts = [{ id: 'coin', label: '코인', value: account?.totalAssets ?? null, enabled: true, route: 'coins' }];
  if (stocks?.enabled) {
    const trader = stocks[stockMode];
    if (trader) parts.push({ id: 'stock', label: '주식', value: trader.totalAssets ?? null, enabled: true, route: 'stocks', note: live ? '실전 주식 평가액은 증권 계좌에서 확인합니다.' : null });
  }
  if (horizons?.coin && !live) parts.push({ id: 'horizon-coin', label: '기간별 코인', value: horizons.coin.totalAssets ?? null, enabled: true, route: 'portfolios' });
  const stockHorizon = horizons?.stock?.[stockMode];
  if (stockHorizon && !live) parts.push({ id: 'horizon-stock', label: '기간별 주식', value: stockHorizon.totalAssets ?? null, enabled: true, route: 'portfolios' });
  return parts;
}
