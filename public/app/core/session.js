// Derived, read-only view of "where am I and what may I do" computed from the
// latest server reads + auth + connectivity. Pure, so it is unit-tested and
// every screen agrees on the workspace (모의/실전) and on order locks.

import { canMutate, canRead, isReadOnlyScope, mutationBlockReason } from './authPolicy.js';
import { resourceKey } from './resources.js';
import { normalizeMarketPriceSnapshot, paperEvidenceMutationLock, serverMode } from '../domain/trading.js';

const dataOf = (state, name) => state[resourceKey(name)]?.data ?? null;

export function deriveSession(state) {
  const status = dataOf(state, 'status');
  const account = dataOf(state, 'account');
  const paper = dataOf(state, 'paper');
  const auth = state.auth || null;
  const online = state.online !== false;
  const mode = serverMode(status);
  const readOnlyObserver = status?.readOnlyObserver === true || paper?.readOnlyObserver === true;
  const mutationAllowed = canMutate(auth, { readOnlyObserver }) && online;
  const snapshot = normalizeMarketPriceSnapshot(dataOf(state, 'prices'));
  const pricesState = state[resourceKey('prices')];
  const evidenceLock = paperEvidenceMutationLock({
    readOnlyObserver,
    investmentConfig: dataOf(state, 'investmentConfig'),
    optimization: dataOf(state, 'optimization'),
    paper
  });
  return {
    auth,
    online,
    status,
    account,
    paper,
    mode,
    modeKnown: mode !== 'UNKNOWN',
    isLive: mode === 'LIVE',
    isPaper: mode === 'DRY_RUN',
    readOnlyObserver,
    readOnlyScope: isReadOnlyScope(auth),
    canRead: canRead(auth),
    canMutate: mutationAllowed,
    mutationBlockedReason: mutationAllowed ? '' : mutationBlockReason(auth, { online, readOnlyObserver }),
    pending: state.mutation || { locked: false },
    pendingLocked: state.mutation?.locked === true,
    evidenceLock,
    marketSnapshot: snapshot,
    marketPrices: snapshot?.prices || [],
    marketPricesLoaded: pricesState?.status === 'ready' && Boolean(snapshot),
    freshnessOptions: { maxCandleAgeSeconds: status?.maxCandleAgeSeconds, snapshotSource: snapshot?.snapshotSource }
  };
}

export function workspaceLabel(session) {
  if (!session.modeKnown) return { label: '모드 확인 중', tone: 'neutral' };
  return session.isLive ? { label: '실전', tone: 'live' } : { label: '모의투자', tone: 'info' };
}
