// Order-safety rules shared by every screen that can send or describe an
// order. Pure functions: the inputs are the latest server payloads, never
// cached UI flags, so a stale or partial read always fails closed.

import { hasFiniteValue, marketTimestamp, won } from '../core/format.js';

export const MIN_ORDER_KRW = 5000;
export const FEE_RATE = 0.0005;

/** Automatic-loop entry gate. */
export function runtimeCanAcceptOrders(status) {
  if (!status || status.entriesPaused === true || status.runtimeState === 'PROTECTIVE_ONLY' ||
    status.runtimeState === 'SYNC_REQUIRED' || status.exchangeStateKnown === false ||
    status.runtimeState === 'STOPPED' || status.isRunning === false) return false;
  return true;
}

/** Manual orders have their own gate; a LIVE operator stop still allows manual orders. */
export function runtimeCanAcceptManualOrders(status, mode) {
  if (!status || status.runtimeState === 'PROTECTIVE_ONLY' || status.runtimeState === 'SYNC_REQUIRED' ||
    status.exchangeStateKnown === false) return false;
  if (mode !== 'LIVE') return true;
  const operatorStopped = ['operator_stop', 'operator_shutdown'].includes(status.stopReason);
  const manualLivePaused = status.entriesPaused === true || status.runtimeState === 'STOPPED' || status.isRunning === false;
  return !manualLivePaused || operatorStopped;
}

export function runtimeBlockReason(status) {
  if (status?.runtimeState === 'SYNC_REQUIRED' || status?.exchangeStateKnown === false) {
    return '설정한 시장의 거래소 잔고와 미체결 주문을 확인하는 중입니다. 확인이 끝날 때까지 신규 주문을 잠급니다.';
  }
  if (status?.runtimeState === 'PROTECTIVE_ONLY') {
    return status.stopReason === 'risk_data_gap'
      ? '시세 공백으로 분석과 신규 주문을 멈췄습니다. 열린 포지션은 위험 감시를 유지합니다.'
      : '안전 점검으로 신규 주문을 멈췄습니다. 열린 포지션은 위험 감시 중입니다.';
  }
  if (status?.entriesPaused === true || status?.runtimeState === 'STOPPED' || status?.isRunning === false) {
    return '자동매매가 중지되어 신규 주문을 보낼 수 없습니다.';
  }
  return '';
}

export function serverMode(status) {
  return ['DRY_RUN', 'LIVE'].includes(status?.mode) ? status.mode : 'UNKNOWN';
}

/** Mode, account balance and the selected market's price must all be known. */
export function isCoreTradingSnapshotReady({ status, account, marketPrices, selectedCoin }) {
  if (!['DRY_RUN', 'LIVE'].includes(status?.mode)) return false;
  if (account?.mode !== status.mode || account?.krwBalance === null || account?.krwBalance === undefined) return false;
  if (!Number.isFinite(Number(account.krwBalance)) || !Array.isArray(marketPrices)) return false;
  const selectedMarket = marketPrices.find(market => market?.coin === selectedCoin);
  return Number.isFinite(Number(selectedMarket?.price)) && Number(selectedMarket.price) > 0;
}

/** Null when the quote is fresh enough to order against; otherwise the reason. */
export function marketQuoteFreshnessIssue(market, { maxCandleAgeSeconds, snapshotSource, now = Date.now() } = {}) {
  if (!market) return '이 종목의 시세를 확인할 수 없어요.';
  const marketPrice = Number(market.price);
  if (!Number.isFinite(marketPrice) || marketPrice <= 0) return '현재가를 확인할 수 없어 주문할 수 없어요.';
  const configured = Number(maxCandleAgeSeconds);
  const maximumAgeMs = (Number.isFinite(configured) && configured > 0 ? configured : 90) * 1000;
  const sourceTimestamp = Date.parse(market.sourceAsOf || '');
  if (!Number.isFinite(sourceTimestamp)) return '최근 체결 시각을 확인할 수 없어 주문할 수 없어요.';
  if (market.quoteFresh === false && (snapshotSource === 'last_good' || market.quoteFreshnessReason === 'market_snapshot_last_good')) {
    return '저장된 최근 시세를 표시 중이에요. 새 시세를 확인한 뒤 주문해 주세요.';
  }
  const sourceAgeMs = now - sourceTimestamp;
  if (sourceAgeMs < -5000) return '최근 체결 시각이 현재보다 앞서 있어요. 서버 시각을 확인해 주세요.';
  if (sourceAgeMs > maximumAgeMs) return '최근 체결 시각이 오래됐어요. 새로고침 후 다시 시도해 주세요.';
  if (market.quoteFresh === false) return '현재 시세 최신 여부를 확인할 수 없어요.';
  return null;
}

export function normalizeMarketPriceSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || !Array.isArray(snapshot.prices)) return null;
  return {
    prices: snapshot.prices,
    complete: typeof snapshot.complete === 'boolean' ? snapshot.complete : null,
    missingMarkets: Array.isArray(snapshot.missingMarkets) ? snapshot.missingMarkets : [],
    unavailableMarkets: Array.isArray(snapshot.unavailableMarkets) ? snapshot.unavailableMarkets : [],
    sourceAsOf: snapshot.sourceAsOf ?? null,
    fetchedAt: snapshot.fetchedAt ?? null,
    snapshotSource: snapshot.snapshotSource ?? null,
    fallbackReason: snapshot.fallbackReason ?? null,
    marketListStale: typeof snapshot.marketListStale === 'boolean' ? snapshot.marketListStale : null,
    marketListFetchedAt: snapshot.marketListFetchedAt ?? null,
    legacyFallback: snapshot.legacyFallback === true
  };
}

function oldestRowTimestamp(prices, field) {
  if (!Array.isArray(prices) || prices.length === 0) return null;
  const timestamps = prices.map(row => {
    const value = row?.[field];
    if (typeof value !== 'string' || !value.trim()) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  });
  if (timestamps.some(value => value === null)) return null;
  return new Date(Math.min(...timestamps)).toISOString();
}

/** Older servers only expose the bare /market/prices array; freshness is then unknown. */
export function buildLegacyMarketPriceSnapshot(legacyPrices, targetCoins) {
  const prices = Array.isArray(legacyPrices) ? legacyPrices : [];
  const listCoins = targetCoins?.coins;
  const listFetchedAt = typeof targetCoins?.fetchedAt === 'string' ? targetCoins.fetchedAt : null;
  const validMarketList = Array.isArray(listCoins) && listCoins.length > 0 &&
    targetCoins?.count === listCoins.length && typeof targetCoins?.stale === 'boolean' &&
    listCoins.every(coin => typeof coin === 'string' && /^[A-Z0-9]+-[A-Z0-9]+$/.test(coin)) &&
    new Set(listCoins).size === listCoins.length && Boolean(listFetchedAt) && Number.isFinite(Date.parse(listFetchedAt));
  const requestedMarkets = validMarketList ? listCoins : [];
  const returnedMarkets = [...new Set(prices.map(row => row?.coin).filter(coin => typeof coin === 'string' && /^[A-Z0-9]+-[A-Z0-9]+$/.test(coin)))];
  const returnedSet = new Set(returnedMarkets);
  const missingMarkets = validMarketList ? requestedMarkets.filter(coin => !returnedSet.has(coin)) : [];
  const rowsVerified = prices.every(row => typeof row?.coin === 'string' && /^[A-Z0-9]+-[A-Z0-9]+$/.test(row.coin)) && returnedMarkets.length === prices.length;
  return {
    requestedMarkets,
    returnedMarkets,
    missingMarkets,
    unavailableMarkets: missingMarkets,
    complete: validMarketList ? rowsVerified && missingMarkets.length === 0 : null,
    sourceAsOf: oldestRowTimestamp(prices, 'sourceAsOf'),
    fetchedAt: oldestRowTimestamp(prices, 'fetchedAt'),
    marketListStale: validMarketList ? targetCoins.stale : null,
    marketListFetchedAt: validMarketList ? listFetchedAt : null,
    prices,
    legacyFallback: true
  };
}

/** Reads /market/prices/snapshot, falling back to the bare list only on 404. */
export async function fetchMarketSnapshot(api) {
  try {
    return await api.get('/market/prices/snapshot');
  } catch (error) {
    if (error?.status !== 404) throw error;
    const [legacy, targetCoins] = await Promise.all([api.get('/market/prices'), api.get('/target-coins').catch(() => null)]);
    return buildLegacyMarketPriceSnapshot(legacy, targetCoins);
  }
}

export function marketSnapshotPresentation(snapshot, loaded, prices, freshnessOptions = {}) {
  const rows = Array.isArray(prices) ? prices : [];
  const hasPrices = rows.length > 0;
  const missingCount = Math.max(
    Array.isArray(snapshot?.missingMarkets) ? snapshot.missingMarkets.length : 0,
    Array.isArray(snapshot?.unavailableMarkets) ? snapshot.unavailableMarkets.length : 0
  );
  const usingLastGood = snapshot?.snapshotSource === 'last_good' || rows.some(row => row?.quoteFreshnessReason === 'market_snapshot_last_good');
  const issue = row => marketQuoteFreshnessIssue(row, { ...freshnessOptions, snapshotSource: snapshot?.snapshotSource });
  let label;
  let tone;
  if (!loaded) {
    label = hasPrices ? '시세를 새로 불러오지 못해 이전 가격을 표시합니다' : '시세를 불러오지 못했습니다';
    tone = 'unavailable';
  } else if (!hasPrices) {
    label = '표시할 시세가 없습니다';
    tone = 'unavailable';
  } else if (usingLastGood) {
    label = missingCount > 0
      ? `거래소 응답이 없어 저장된 최근 시세를 표시합니다 · ${missingCount}개 시장 누락`
      : '거래소 응답이 없어 저장된 최근 시세를 표시합니다';
    tone = 'stale';
  } else if (snapshot?.complete === false || missingCount > 0) {
    label = missingCount > 0 ? `${missingCount}개 시장 시세를 확인할 수 없습니다` : '일부 시장 시세를 확인할 수 없습니다';
    tone = 'partial';
  } else if (snapshot?.complete === true && rows.some(row => issue(row))) {
    label = `${rows.filter(row => issue(row)).length}개 시장의 시세가 오래됐어요`;
    tone = 'stale';
  } else if (snapshot?.complete === true) {
    label = '모든 시장의 시세를 확인했어요';
    tone = 'complete';
  } else {
    label = '시세 상태를 확인할 수 없습니다';
    tone = 'unavailable';
  }
  const state = tone === 'complete' && (snapshot?.legacyFallback === true || snapshot?.marketListStale !== false) ? 'stale' : tone;
  const marketListStatus = !loaded
    ? '시장 목록을 확인할 수 없어요'
    : snapshot?.marketListStale === true
      ? '시장 목록을 새로 확인해야 해요'
      : snapshot?.marketListStale === false ? '시장 목록을 확인했어요' : '시장 목록을 확인할 수 없어요';
  const listTime = marketTimestamp(snapshot?.marketListFetchedAt);
  const freshnessNote = snapshot?.legacyFallback === true ? '시세의 최신 여부는 확인할 수 없습니다' : null;
  const detailLabel = [label, freshnessNote].filter(Boolean).join(' · ');
  return {
    state,
    label,
    // Legacy tone vocabulary: complete | partial | unavailable | warning.
    tone: state === 'stale' || snapshot?.legacyFallback === true ? 'warning' : tone,
    detail: `${detailLabel} · ${marketListStatus}`,
    pageDetail: `${detailLabel} · ${marketListStatus} · ${loaded ? '목록 확인' : '마지막 목록 확인'} ${listTime}`,
    listTime
  };
}

export function marketRowQuotePresentation(marketData, latestReadSucceeded, freshnessOptions = {}) {
  const fetchedAt = marketTimestamp(marketData?.fetchedAt ?? marketData?.sourceAsOf);
  if (latestReadSucceeded !== true) return { label: `갱신 실패 · 마지막 수집 ${fetchedAt}`, state: 'stale' };
  const quoteIssue = marketQuoteFreshnessIssue(marketData, freshnessOptions);
  if (!quoteIssue) return { label: `최근 시세 · 수집 ${fetchedAt}`, state: 'current' };
  if (quoteIssue.includes('저장된 최근 시세')) return { label: `저장 시세 · 수집 ${fetchedAt}`, state: 'stale' };
  if (quoteIssue.includes('오래됐')) return { label: `오래된 시세 · ${fetchedAt}`, state: 'stale' };
  return { label: `시세 확인 필요 · ${fetchedAt}`, state: 'unavailable' };
}

/** Last N valid OHLC candles; invalid rows are dropped and the input is not mutated. */
export function getDisplayedCandles(candles, displayRange) {
  const range = [30, 60, 100].includes(Number(displayRange)) ? Number(displayRange) : 60;
  if (!Array.isArray(candles)) return [];
  const valid = candles.filter(candle => {
    if (!candle || typeof candle !== 'object') return false;
    const open = Number(candle.open);
    const high = Number(candle.high);
    const low = Number(candle.low);
    const close = Number(candle.close);
    return [open, high, low, close].every(value => Number.isFinite(value) && value > 0) &&
      high >= low && high >= Math.max(open, close) && low <= Math.min(open, close);
  });
  return valid.slice(-range);
}

export function completeHoldingsValuation(holdings, holdingsKnown, coreReady) {
  if (coreReady !== true || holdingsKnown !== true || !Array.isArray(holdings)) return null;
  if (holdings.length === 0) return 0;
  const values = holdings.map(holding => holding?.currentValue);
  if (values.some(value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) || Number(value) < 0)) return null;
  const total = values.reduce((sum, value) => sum + Number(value), 0);
  return Number.isFinite(total) ? total : null;
}

export function manualOrderCapacityPresentation({ account, holdings, holdingsKnown, coreReady }) {
  const balanceLabel = coreReady === true && hasFiniteValue(account?.krwBalance)
    ? `사용 가능 잔액 ${won(account.krwBalance)}`
    : '사용 가능 잔액 확인 불가';
  const holdingValue = completeHoldingsValuation(holdings, holdingsKnown, coreReady);
  const holdingLabel = holdingValue === null ? '보유 평가액 확인 불가' : `보유 평가액 ${won(holdingValue)}`;
  return { balanceLabel, holdingLabel, holdingValue };
}

/**
 * Single source of truth for whether a manual order may be sent now and why
 * not. `ctx` is built from the latest server reads.
 */
export function manualOrderGate(ctx) {
  const {
    online = true, coreReady = false, status = null, mutationBlocked = false, mutationBlockedReason = '',
    evidenceLock = null, pendingLocked = false, market = undefined, freshnessOptions = {}
  } = ctx;
  const mode = serverMode(status);
  if (online === false) return { allowed: false, reason: '서버 연결이 끊겨 계좌와 시세를 확인할 수 없습니다. 다시 연결될 때까지 주문할 수 없습니다.' };
  if (pendingLocked) return { allowed: false, reason: '처리 중인 요청의 결과를 확인한 뒤 새 주문을 할 수 있습니다.' };
  if (mutationBlocked) return { allowed: false, reason: mutationBlockedReason };
  if (evidenceLock?.locked === true) return { allowed: false, reason: evidenceLock.reason || '모의투자 실행 중에는 설정을 바꿀 수 없습니다.' };
  if (status && !runtimeCanAcceptManualOrders(status, mode)) {
    return { allowed: false, reason: runtimeBlockReason(status) || '거래소 상태를 확인할 때까지 주문할 수 없습니다.' };
  }
  if (coreReady !== true) return { allowed: false, reason: '서버 모드와 계좌, 선택한 시장의 시세를 확인할 때까지 주문할 수 없습니다.' };
  if (mode === 'UNKNOWN') return { allowed: false, reason: '서버의 거래 모드를 확인할 때까지 주문할 수 없습니다.' };
  if (market !== undefined) {
    const issue = marketQuoteFreshnessIssue(market, freshnessOptions);
    if (issue) return { allowed: false, reason: issue };
  }
  return { allowed: true, reason: '', live: mode === 'LIVE' };
}

/**
 * Workspace banner (mode + order lock), most severe state first. `isLive` is
 * true only when automatic LIVE trading is fully ready (legacy contract);
 * manual LIVE access is signalled by tone 'danger'.
 */
export function modeBannerPresentation({ paper, modeKnown, liveReady, offline, readOnly, protectiveOnly, exchangeStateUnknown, evidenceLocked, corePending, runtimeBlocked, manualOrdersAllowed, runtimeReason, readOnlyReason, coreReadinessReason, tradeReason }) {
  if (offline) return { title: '오프라인 · 주문 잠금', copy: '서버 연결이 복구될 때까지 계좌와 시세를 표시하지 않으며 주문을 중지합니다.', tone: 'danger', isLive: false };
  if (readOnly) return { title: '읽기 전용 · 주문 잠금', copy: readOnlyReason || '읽기 전용 모드에서는 내용을 변경할 수 없습니다.', tone: 'warning', isLive: false };
  if (protectiveOnly) return { title: '위험 감시 전용 · 신규 주문 잠금', copy: runtimeReason, tone: 'danger', isLive: false };
  if (exchangeStateUnknown) return { title: '거래소 상태 확인 중 · 주문 잠금', copy: runtimeReason || '거래소 상태를 확인할 때까지 신규 주문을 잠급니다.', tone: 'warning', isLive: false };
  if (evidenceLocked) return { title: '모의투자 기록 보호 · 신규 주문 잠금', copy: tradeReason || '모의투자 실행 기록을 보호하고 있습니다. 세션이 끝날 때까지 주문할 수 없습니다.', tone: 'warning', isLive: false };
  if (corePending) return { title: '연결 확인 중 · 주문 잠금', copy: coreReadinessReason, tone: 'warning', isLive: false };
  if (!modeKnown) return { title: '거래 모드 확인 중 · 주문 잠금', copy: '서버의 거래 모드를 확인할 때까지 주문할 수 없습니다.', tone: 'warning', isLive: false };
  if (runtimeBlocked && manualOrdersAllowed) {
    return paper
      ? { title: '자동매매 중지 · 모의 주문 가능', copy: '자동매매는 중지되어 있습니다. 수동 주문은 모의투자로 기록되며 실제 자금은 사용되지 않습니다.', tone: 'info', isLive: false }
      : { title: '자동매매 중지 · 실거래 가능', copy: '운영자가 자동매매를 중지했습니다. 거래소 상태 확인이 끝난 상태에서 수동 주문을 보낼 수 있습니다. 주문 전 자산, 수량, 위험 한도를 확인하세요.', tone: 'danger', isLive: false };
  }
  if (runtimeBlocked) return { title: '매매 중지 · 신규 주문 잠금', copy: runtimeReason || '자동매매가 중지되어 신규 주문을 보낼 수 없습니다.', tone: 'warning', isLive: false };
  if (!paper && liveReady) return { title: '실거래 활성', copy: '주문 전 자산, 수량, 위험 한도를 확인하세요. 실제 체결 여부는 거래 내역에서 확인할 수 있습니다.', tone: 'danger', isLive: true };
  if (paper && manualOrdersAllowed) return { title: '모의투자 · 실제 주문 잠금', copy: '수동 주문은 모의투자로 기록되며 실제 자금은 사용되지 않습니다.', tone: 'info', isLive: false };
  if (!paper && manualOrdersAllowed) return { title: '실거래 · 수동 주문 가능', copy: '실거래 수동 주문이 허용된 상태입니다. 자동매매 승인 상태는 별도 점검 결과를 따릅니다.', tone: 'danger', isLive: false };
  return { title: '실거래 주문 잠금', copy: tradeReason || '실제 주문 전 점검을 마칠 때까지 주문할 수 없습니다.', tone: 'warning', isLive: false };
}

/** Paper-evidence lock reported by the server (or an active paper session). */
export function paperEvidenceMutationLock({ readOnlyObserver = false, investmentConfig, optimization, paper } = {}) {
  if (readOnlyObserver) return null;
  const apiLock = investmentConfig?.evidenceMutationLock || optimization?.evidenceMutationLock;
  if (apiLock?.locked === true) return apiLock;
  if (paper?.active === true) {
    return { locked: true, code: 'paper_evidence_mutation_blocked', reason: '모의투자 실행 중에는 설정을 바꿀 수 없습니다.' };
  }
  return null;
}

/** Estimated order preview; never reports a quantity without a fresh price. */
export function orderPreview({ side, amount, market, position, quoteIssue }) {
  const value = Number(amount) || 0;
  const priceValue = quoteIssue === null && hasFiniteValue(market?.price) ? Number(market.price) : null;
  const quantity = priceValue && priceValue > 0 ? value / priceValue : null;
  const holdingValue = hasFiniteValue(position?.currentValue) ? Number(position.currentValue) : null;
  return {
    price: priceValue,
    quantity,
    fee: value * FEE_RATE,
    holdingValue,
    sellQuantity: side === 'sell' && priceValue ? value / priceValue : null
  };
}
