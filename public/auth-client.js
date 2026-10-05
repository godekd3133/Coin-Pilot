/*
 * CoinPilot dashboard auth gate.
 *
 * Must load AFTER the socket.io client bundle and BEFORE app scripts so that
 * both window.fetch and window.io are patched before any call site runs.
 * The token lives in localStorage and is attached to every same-origin /api
 * fetch. Its actual scope is resolved before Socket.IO is allowed to connect.
 */
(function () {
  'use strict';

  const TOKEN_KEY = 'coinpilot.dashboardToken';
  const TOKEN_SCOPE_KEY = 'coinpilot.dashboardTokenScope';
  const TOKEN_SCOPES = new Set(['operator', 'mobile_operator', 'read_only']);
  const rawFetch = window.fetch ? window.fetch.bind(window) : null;
  if (!rawFetch) return;

  const getToken = () => {
    try { return window.localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
  };
  const setToken = token => {
    try { window.localStorage.setItem(TOKEN_KEY, token); } catch { /* private mode */ }
  };
  const setTokenScope = scope => {
    try { window.localStorage.setItem(TOKEN_SCOPE_KEY, scope); } catch { /* private mode */ }
  };
  const clearToken = () => {
    try { window.localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
    try { window.localStorage.removeItem(TOKEN_SCOPE_KEY); } catch { /* ignore */ }
  };

  let authState = {
    authRequired: null,
    tokenScope: null,
    authenticated: false,
    resolved: false,
    verification: 'checking',
    tokenPresent: Boolean(getToken()),
    error: null
  };
  let finishReady;
  const ready = new Promise(resolve => { finishReady = resolve; });
  let readyFinished = false;

  function setAuthState(next, finish = false) {
    authState = { ...authState, ...next };
    if (finish && !readyFinished) {
      readyFinished = true;
      finishReady(authState);
    }
    try {
      window.dispatchEvent?.(new CustomEvent('coinpilot:auth-state', { detail: authState }));
    } catch { /* event notification is optional */ }
    return authState;
  }

  function canUseOperatorSocket() {
    if (authState.resolved === true && authState.authRequired === false && authState.verification === 'not-required') return true;
    return authState.resolved === true && authState.authenticated === true &&
      authState.verification === 'verified' && authState.tokenScope === 'operator';
  }

  // 실시간 스트림(Socket.IO)은 모바일 운영 스코프도 열 수 있다. 서버 측
  // socketMiddleware가 같은 토큰을 수락하며, 브라우저 쓰기 권한은 여전히
  // operator 전용으로 둔다.
  function canOpenRealtimeStream() {
    if (authState.resolved === true && authState.authRequired === false && authState.verification === 'not-required') return true;
    return authState.resolved === true && authState.authenticated === true &&
      authState.verification === 'verified' &&
      (authState.tokenScope === 'operator' || authState.tokenScope === 'mobile_operator');
  }

  window.coinPilotAuth = {
    get state() { return authState; },
    ready,
    get canMutate() { return canUseOperatorSocket(); },
    get canOpenSocket() { return canOpenRealtimeStream(); },
    requestLogin(message = '') { showLogin(message); }
  };

  function isApiUrl(url) {
    try {
      const parsed = new URL(url, window.location.origin);
      return parsed.origin === window.location.origin && parsed.pathname.startsWith('/api/');
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- overlay
  let overlay = null;

  function ensureOverlay() {
    if (overlay) return overlay;

    const style = document.createElement('style');
    style.textContent = `
      #cp-auth-gate{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:24px;background:#f9fafb;font-family:inherit;color:#191f28;overflow-y:auto;box-sizing:border-box}
      #cp-auth-gate[hidden]{display:none}
      #cp-auth-gate .cp-auth-card{width:min(100%,400px);background:#fff;border:1px solid #e5e8eb;border-top:2px solid #027648;border-radius:10px;padding:24px;box-shadow:none;color:#191f28}
      #cp-auth-gate h1{font-size:22px;margin:0 0 8px;font-weight:680;letter-spacing:-.035em}
      #cp-auth-gate p{font-size:14px;line-height:1.55;color:#6b7684;margin:0 0 16px}
      #cp-auth-gate label{display:block;margin:0 0 8px;color:#191f28;font-size:12px;font-weight:650}
      #cp-auth-gate input{width:100%;box-sizing:border-box;min-height:50px;padding:11px 12px;border-radius:8px;border:1px solid #d1d6db;background:#fff;color:#191f28;font-size:14px;outline:none}
      #cp-auth-gate input:focus{border-color:#1b64da;box-shadow:0 0 0 2px rgba(27,100,218,.12)}
      #cp-auth-gate button{width:100%;min-height:48px;margin-top:12px;padding:11px 12px;border:0;border-radius:8px;background:#1b64da;color:#fff;font-size:14px;font-weight:650;cursor:pointer}
      #cp-auth-gate button:disabled{opacity:.5;cursor:default}
      #cp-auth-gate .cp-auth-error{min-height:18px;margin-top:10px;font-size:12px;color:#a51926}
      #cp-auth-gate .cp-auth-hint{margin-top:14px;font-size:12px;color:#6b7684;line-height:1.5}
      #cp-auth-gate .cp-auth-brand{color:#1b64da;font-size:13px;font-weight:700;margin-bottom:18px}
      #cp-auth-gate .cp-auth-benefits{display:grid;gap:10px;padding:0 0 20px;margin:0 0 20px;border-bottom:1px solid #e5e8eb;list-style:none;font-size:13px;line-height:1.5;color:#4e5968}
      #cp-auth-gate .cp-auth-benefits strong{display:block;color:#191f28;font-weight:650}
      #cp-auth-gate .cp-auth-card{margin:auto}
    `;
    document.head.appendChild(style);

    overlay = document.createElement('div');
    overlay.id = 'cp-auth-gate';
    overlay.hidden = true;
    overlay.innerHTML = `
      <form class="cp-auth-card" novalidate>
        <p class="cp-auth-brand">CoinPilot</p>
        <h1>내 자산과 거래를 한눈에</h1>
        <p>연결한 계좌의 변화와 자동매매 상태를 함께 확인하세요.</p>
        <ul class="cp-auth-benefits">
          <li><strong>얼마나 달라졌는지</strong>자산 평가액과 실현 손익을 구분해 확인해요.</li>
          <li><strong>어떤 거래가 있었는지</strong>최근 거래와 보유 코인을 살펴봐요.</li>
          <li><strong>지금 확인할 일이 있는지</strong>시세 갱신과 자동매매 중단 상태를 확인해요.</li>
        </ul>
        <label for="cp-auth-token">서버 접속 토큰</label>
        <input id="cp-auth-token" type="password" name="token" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="cp-auth-help cp-auth-error" placeholder="관리자에게 받은 접속 토큰">
        <button type="submit">연결하고 내 현황 보기</button>
        <div id="cp-auth-error" class="cp-auth-error" role="alert"></div>
        <div id="cp-auth-help" class="cp-auth-hint">토큰은 서버 관리자에게 받을 수 있어요. 거래소 API 키와는 다른 값입니다. 입력한 토큰은 이 브라우저에 저장됩니다.</div>
      </form>`;
    document.body.appendChild(overlay);

    const form = overlay.querySelector('form');
    const input = overlay.querySelector('input');
    const errorBox = overlay.querySelector('.cp-auth-error');
    const button = overlay.querySelector('button');

    form.addEventListener('submit', async event => {
      event.preventDefault();
      const token = input.value.trim();
      const previousToken = getToken();
      if (!token) {
        errorBox.textContent = '접속 토큰을 입력해 주세요.';
        return;
      }
      button.disabled = true;
      button.textContent = '접속 권한 확인 중…';
      errorBox.textContent = '';
      try {
        const response = await rawFetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });
        let data = null;
        try { data = await response.json(); } catch { /* handled as an unrecognized response */ }
        if (response.ok) {
          setToken(token);
          if (data?.authRequired === false) {
            try { window.localStorage.removeItem(TOKEN_SCOPE_KEY); } catch { /* ignore */ }
            setAuthState({ authRequired: false, tokenScope: 'operator', authenticated: true, resolved: true, verification: 'not-required', tokenPresent: true, error: null }, true);
          } else if (TOKEN_SCOPES.has(data?.tokenScope)) {
            setTokenScope(data.tokenScope);
            setAuthState({ authRequired: true, tokenScope: data.tokenScope, authenticated: true, resolved: true, verification: 'verified', tokenPresent: true, error: null }, true);
          } else {
            errorBox.textContent = '접속 권한을 확인하지 못했습니다. 다시 시도해 주세요.';
            return;
          }
          window.location.reload();
          return;
        }
        if (response.status === 401 && token === previousToken) {
          clearToken();
          setAuthState({ authRequired: true, tokenScope: null, authenticated: false, resolved: true, verification: 'invalid', tokenPresent: false, error: 'invalid' }, true);
        }
        errorBox.textContent = response.status === 429
          ? '접속 시도가 많습니다. 잠시 후 다시 시도해 주세요.'
          : response.status === 401 || response.status === 403
            ? '접속 토큰이 맞지 않거나 권한이 없습니다. 관리자에게 토큰을 확인해 주세요.'
            : '서버가 접속 요청을 처리하지 못했습니다. 입력한 토큰은 유지되니 잠시 후 다시 시도해 주세요.';
      } catch {
        errorBox.textContent = '서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.';
        setAuthState({ authRequired: true, tokenScope: null, authenticated: null, resolved: true, verification: 'unavailable', tokenPresent: Boolean(getToken()), error: 'network' }, true);
      } finally {
        button.disabled = false;
        button.textContent = '연결하고 내 현황 보기';
      }
    });

    return overlay;
  }

  function showLogin(message) {
    const gate = ensureOverlay();
    if (message) gate.querySelector('.cp-auth-error').textContent = message;
    gate.hidden = false;
    window.setTimeout(() => gate.querySelector('input')?.focus(), 50);
  }

  function showAuthenticationFailure() {
    const hadSavedToken = Boolean(getToken());
    if (hadSavedToken) {
      clearToken();
      setAuthState({ authRequired: true, tokenScope: null, authenticated: false, resolved: true, verification: 'invalid', tokenPresent: false, error: 'invalid' }, true);
    }
    // A first connection has no token to reject. Keep the prompt, but reserve
    // the red error state for a token that was actually sent and refused.
    showLogin(hadSavedToken ? '저장된 접속 토큰이 맞지 않습니다. 다시 입력해 주세요.' : '');
  }

  // ------------------------------------------------------------- fetch patch
  window.fetch = async function patchedFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const onApi = isApiUrl(url);
    const headers = new Headers(
      init.headers || (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined) || {}
    );
    const token = getToken();
    if (onApi && token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    const response = await rawFetch(input, { ...init, headers });
    if (onApi && response.status === 401) {
      showAuthenticationFailure();
    }
    return response;
  };

  // ----------------------------------------------------------- socket.io wrap
  if (typeof window.io === 'function') {
    const rawIo = window.io.bind(window);

    function openSocket(args) {
      const [urlOrOpts, maybeOpts] = args;
      const opts = typeof urlOrOpts === 'string' ? (maybeOpts || {}) : (urlOrOpts || {});
      const auth = { ...(opts.auth || {}), token: getToken() };
      const socket = typeof urlOrOpts === 'string'
        ? rawIo(urlOrOpts, { ...opts, auth })
        : rawIo({ ...opts, auth });
      socket.on('connect_error', error => {
        if (canOpenRealtimeStream() && /unauthor/i.test(String(error && error.message))) {
          showAuthenticationFailure();
        }
      });
      return socket;
    }

    function createDeferredSocket(args) {
      let socket = null;
      const listeners = [];
      const queuedEmits = [];
      const proxy = {
        on(name, listener) {
          if (socket) socket.on(name, listener);
          else listeners.push([name, listener]);
          return proxy;
        },
        once(name, listener) {
          if (socket) socket.once(name, listener);
          else listeners.push([name, listener, true]);
          return proxy;
        },
        off(name, listener) {
          if (socket) socket.off?.(name, listener);
          else {
            for (let i = listeners.length - 1; i >= 0; i -= 1) {
              if (listeners[i][0] === name && (!listener || listeners[i][1] === listener)) listeners.splice(i, 1);
            }
          }
          return proxy;
        },
        emit(...values) {
          if (socket) socket.emit(...values);
          else queuedEmits.push(values);
          return proxy;
        },
        connect() { socket?.connect?.(); return proxy; },
        disconnect() { socket?.disconnect?.(); return proxy; },
        get connected() { return socket?.connected === true; }
      };

      ready.then(() => {
        if (!canOpenRealtimeStream()) return;
        try {
          socket = openSocket(args);
          listeners.forEach(([name, listener, once]) => socket[once ? 'once' : 'on'](name, listener));
          queuedEmits.forEach(values => socket.emit(...values));
        } catch (error) {
          console.warn('CoinPilot Socket.IO connection could not be created:', error?.message || error);
        }
      });
      return proxy;
    }

    window.io = function wrappedIo(...args) {
      if (!authState.resolved || !canOpenRealtimeStream()) return createDeferredSocket(args);
      return openSocket(args);
    };
    Object.assign(window.io, rawIo);
  }

  // ------------------------------------------------------------------- boot
  async function boot() {
    const savedToken = getToken();
    try {
      const response = await rawFetch('/api/auth/status');
      if (!response.ok) throw new Error(`auth status HTTP ${response.status}`);
      const data = await response.json();
      if (data?.authRequired === false) {
        setAuthState({ authRequired: false, tokenScope: 'operator', authenticated: true, resolved: true, verification: 'not-required', tokenPresent: Boolean(savedToken), error: null }, true);
        return;
      }
      if (data?.authRequired !== true) throw new Error('auth status response was incomplete');
      if (!savedToken) {
        setAuthState({ authRequired: true, tokenScope: null, authenticated: false, resolved: true, verification: 'missing', tokenPresent: false, error: null }, true);
        showLogin('');
        return;
      }

      // Resolve the actual scope on every page load. Older saved tokens may not
      // have a stored scope, and a cached scope must never authorize a socket.
      const scopeResponse = await rawFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: savedToken })
      });
      let scopeData = null;
      try { scopeData = await scopeResponse.json(); } catch { /* fail closed below */ }
      if (scopeResponse.ok && scopeData?.success === true && TOKEN_SCOPES.has(scopeData.tokenScope)) {
        setTokenScope(scopeData.tokenScope);
        setAuthState({ authRequired: true, tokenScope: scopeData.tokenScope, authenticated: true, resolved: true, verification: 'verified', tokenPresent: true, error: null }, true);
        return;
      }
      if (scopeResponse.status === 401) {
        clearToken();
        setAuthState({ authRequired: true, tokenScope: null, authenticated: false, resolved: true, verification: 'invalid', tokenPresent: false, error: 'invalid' }, true);
        showLogin('저장된 접속 토큰이 맞지 않습니다. 다시 입력해 주세요.');
        return;
      }

      // A rate limit, server error, or malformed response is not proof that
      // the token is invalid. Keep it, but leave the client restricted.
      setAuthState({ authRequired: true, tokenScope: null, authenticated: null, resolved: true, verification: 'unavailable', tokenPresent: true, error: 'verification' }, true);
      showLogin(scopeResponse.status === 429
        ? '접속 권한 확인 요청이 많습니다. 잠시 후 다시 시도해 주세요.'
        : '서버에서 접속 권한을 확인하지 못했습니다. 연결을 확인하고 다시 시도해 주세요.');
    } catch {
      // Preserve a saved token on a network failure. The PWA remains blocked
      // until its scope can be verified, without reporting a false rejection.
      setAuthState({ authRequired: savedToken ? true : null, tokenScope: null, authenticated: null, resolved: true, verification: 'unavailable', tokenPresent: Boolean(savedToken), error: 'network' }, true);
      if (savedToken) showLogin('서버에서 접속 권한을 확인하지 못했습니다. 연결을 확인하고 다시 시도해 주세요.');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
