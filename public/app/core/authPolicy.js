// Client-side request policy for the dashboard token scopes. The server is the
// authority; this module only refuses requests the server would reject anyway
// so a read-only browser session never even attempts a mutation.
//
//  - no auth required: allowed once resolved (verification 'not-required')
//  - operator: every request
//  - read_only: an explicit allow-list of GET reads
//  - mobile_operator: native app only, nothing from the browser
//  - unresolved / unavailable / invalid: nothing

export const READ_ONLY_GET_PATHS = new Set([
  '/status', '/account', '/cumulative-pnl', '/today-summary', '/market/prices/snapshot'
]);
export const READ_ONLY_PORTFOLIO_PERIODS = new Set(['24h', '7d', '30d']);

export function requestAllowed(auth, method, path) {
  if (!auth) return true;
  const verb = String(method || 'GET').toUpperCase();
  if (auth.authRequired !== true) {
    return auth.resolved === true && (auth.verification === 'not-required' ||
      (auth.verification === 'verified' && auth.tokenScope === 'operator'));
  }
  if (auth.resolved !== true || auth.verification !== 'verified') return false;
  if (auth.tokenScope === 'operator') return true;
  if (auth.tokenScope !== 'read_only' || verb !== 'GET') return false;

  let url;
  try { url = new URL(path, 'https://coinpilot.invalid'); } catch { return false; }
  if (READ_ONLY_GET_PATHS.has(url.pathname)) return url.searchParams.size === 0;
  if (url.pathname === '/portfolio/history') {
    return url.searchParams.size === 1 && READ_ONLY_PORTFOLIO_PERIODS.has(url.searchParams.get('period'));
  }
  if (url.pathname === '/trades') {
    if (url.searchParams.size !== 1 || !/^[1-9]\d*$/.test(url.searchParams.get('limit') || '')) return false;
    const limit = Number(url.searchParams.get('limit'));
    return Number.isSafeInteger(limit) && limit <= 50;
  }
  return false;
}

export function canMutate(auth, { readOnlyObserver = false } = {}) {
  return requestAllowed(auth, 'POST', '/scope-check') && readOnlyObserver !== true;
}

export function canRead(auth) {
  if (!auth) return true;
  if (auth.authRequired === false) return auth.verification === 'not-required';
  return auth.resolved === true && auth.verification === 'verified' && ['operator', 'read_only'].includes(auth.tokenScope);
}

export function isReadOnlyScope(auth) {
  return auth?.authRequired === true && auth?.resolved === true && auth?.verification === 'verified' && auth?.tokenScope === 'read_only';
}

export function isMobileOperatorScope(auth) {
  return auth?.authRequired === true && auth?.resolved === true && auth?.verification === 'verified' && auth?.tokenScope === 'mobile_operator';
}

/** User-facing explanation of why changes are locked. */
export function mutationBlockReason(auth, { online = true, readOnlyObserver = false } = {}) {
  if (auth?.resolved !== true && auth?.authRequired !== false) {
    return '접속 권한을 확인하는 중입니다. 확인될 때까지 주문과 설정 변경을 잠갔습니다.';
  }
  if (auth?.authRequired === true && auth?.verification === 'unavailable') {
    return '접속 권한을 확인할 수 없습니다. 저장된 토큰은 보관했으며, 확인될 때까지 주문과 설정 변경을 잠갔습니다.';
  }
  if (auth?.authRequired === true && auth?.tokenScope === 'read_only') {
    return '읽기 전용 토큰으로 접속했습니다. 주문, 설정 변경, 저장 기능은 사용할 수 없습니다.';
  }
  if (auth?.authRequired === true && auth?.tokenScope === 'mobile_operator') {
    return '모바일 운영 토큰은 모바일 앱 전용입니다. 브라우저에서는 주문과 설정 변경을 사용할 수 없습니다.';
  }
  if (auth?.authRequired === true && ['missing', 'invalid'].includes(auth?.verification)) {
    return '유효한 서버 접속 토큰이 필요합니다. 로그인 창에서 다시 로그인해 주세요.';
  }
  if (readOnlyObserver) return '읽기 전용 관찰 서버입니다. 주문과 설정을 변경할 수 없습니다.';
  return online === false
    ? '서버에 연결되면 상태를 불러오고 주문할 수 있습니다.'
    : '읽기 전용 모드에서는 내용을 변경할 수 없습니다.';
}
