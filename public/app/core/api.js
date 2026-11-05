// fetch wrapper for the authenticated /api plane. The Bearer token is attached
// by auth-client.js (it patches window.fetch); this layer adds the client scope
// policy, a finite timeout and normalised errors. Screens never call fetch.

import { requestAllowed, mutationBlockReason } from './authPolicy.js';
import { apiUrl } from './base.js';

export class ApiError extends Error {
  constructor(message, { status = null, code = null, body = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
  get denied() { return this.status === 401 || this.status === 403; }
}

export function createApi({ fetchImpl = (...args) => globalThis.fetch(...args), getAuth = () => null, getContext = () => ({}), timeoutMs = 12_000, toUserText = value => value } = {}) {
  async function request(path, { method = 'GET', body, headers = {}, timeout = timeoutMs, signal } = {}) {
    const verb = String(method).toUpperCase();
    const auth = getAuth();
    if (!requestAllowed(auth, verb, path)) {
      throw new ApiError(mutationBlockReason(auth, getContext()), { status: 403, code: 'client_scope_blocked' });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const onAbort = () => controller.abort();
    signal?.addEventListener?.('abort', onAbort);
    try {
      const response = await fetchImpl(apiUrl(path), {
        method: verb,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
        signal: controller.signal
      });
      let data = null;
      try { data = await response.json(); } catch { data = null; }
      if (!response.ok) {
        const serverMessage = data?.message || (typeof data?.error === 'string' ? data.error : data?.error?.message);
        const fallback = response.status >= 500
          ? '서버 요청 처리 실패. 잠시 후 재시도.'
          : '요청 처리 실패. 재시도 필요.';
        throw new ApiError(toUserText(serverMessage || fallback), { status: response.status, code: data?.code || data?.error?.code || null, body: data });
      }
      return data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error?.name === 'AbortError') {
        throw new ApiError('서버 응답 지연. 연결 확인 후 재시도.', { code: 'timeout', cause: error });
      }
      throw new ApiError('서버 연결 실패. 연결 확인 필요.', { code: 'network', cause: error });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  const get = (path, options) => request(path, { ...options, method: 'GET' });
  const post = (path, body, options) => request(path, { ...options, method: 'POST', body: body === undefined ? {} : body });

  return {
    request,
    get,
    post,
    allowed: (method, path) => requestAllowed(getAuth(), method, path),
    // Engine controls (non-idempotent but server-side guarded; always behind a confirmation sheet).
    control: {
      startScalper: () => post('/control/start'),
      stopScalper: () => post('/control/stop'),
      startStock: mode => post(`/stocks/${encodeURIComponent(mode)}/start`),
      stopStock: mode => post(`/stocks/${encodeURIComponent(mode)}/stop`),
      resetStockPaper: seedMoney => post('/stocks/paper/reset', seedMoney === undefined ? {} : { seedMoney }),
      startHorizon: asset => post(`/horizons/${encodeURIComponent(asset)}/start`),
      stopHorizon: asset => post(`/horizons/${encodeURIComponent(asset)}/stop`),
      startPaper: reset => post('/paper-validation/start', reset ? { reset: true } : {}),
      stopPaper: () => post('/paper-validation/stop'),
      recordSnapshot: () => post('/portfolio/snapshot')
    }
  };
}
