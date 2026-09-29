/*
 * CoinPilot dashboard auth gate.
 *
 * Must load AFTER the socket.io client bundle and BEFORE app scripts so that
 * both window.fetch and window.io are patched before any call site runs.
 * The token lives in localStorage and is attached to every same-origin /api
 * fetch and every socket.io handshake; a 401 (or an unauthorized socket
 * handshake) brings up the login overlay.
 */
(function () {
  'use strict';

  const TOKEN_KEY = 'coinpilot.dashboardToken';
  const rawFetch = window.fetch ? window.fetch.bind(window) : null;
  if (!rawFetch) return;

  const getToken = () => {
    try { return window.localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
  };
  const setToken = token => {
    try { window.localStorage.setItem(TOKEN_KEY, token); } catch { /* private mode */ }
  };
  const clearToken = () => {
    try { window.localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
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
      #cp-auth-gate{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:24px;background:#f9fafb;font-family:inherit;color:#191f28}
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
    `;
    document.head.appendChild(style);

    overlay = document.createElement('div');
    overlay.id = 'cp-auth-gate';
    overlay.hidden = true;
    overlay.innerHTML = `
      <form class="cp-auth-card" novalidate>
        <h1>서버에 연결</h1>
        <p>서버 토큰을 입력해 주세요. 토큰이 없으면 관리자에게 요청해 주세요.</p>
        <label for="cp-auth-token">서버 접속 토큰</label>
        <input id="cp-auth-token" type="password" name="token" autocomplete="off" placeholder="접속 토큰">
        <button type="submit">접속</button>
        <div class="cp-auth-error" role="alert"></div>
        <div class="cp-auth-hint">입력한 토큰은 이 브라우저에 저장되어 서버 접속에 사용됩니다.</div>
      </form>`;
    document.body.appendChild(overlay);

    const form = overlay.querySelector('form');
    const input = overlay.querySelector('input');
    const errorBox = overlay.querySelector('.cp-auth-error');
    const button = overlay.querySelector('button');

    form.addEventListener('submit', async event => {
      event.preventDefault();
      const token = input.value.trim();
      if (!token) {
        errorBox.textContent = '접속 토큰을 입력해 주세요.';
        return;
      }
      button.disabled = true;
      errorBox.textContent = '';
      try {
        const response = await rawFetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });
        if (response.ok) {
          setToken(token);
          window.location.reload();
          return;
        }
        errorBox.textContent = response.status === 429
          ? '접속 시도가 많습니다. 잠시 후 다시 시도해 주세요.'
          : '접속 토큰이 맞지 않습니다. 다시 확인해 주세요.';
      } catch {
        errorBox.textContent = '서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.';
      } finally {
        button.disabled = false;
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
    if (hadSavedToken) clearToken();
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
    window.io = function wrappedIo(urlOrOpts, maybeOpts) {
      let url;
      let opts;
      if (typeof urlOrOpts === 'string') {
        url = urlOrOpts;
        opts = maybeOpts || {};
      } else {
        opts = urlOrOpts || {};
      }
      const socket = url === undefined
        ? rawIo({ ...opts, auth: { ...(opts.auth || {}), token: getToken() } })
        : rawIo(url, { ...opts, auth: { ...(opts.auth || {}), token: getToken() } });
      socket.on('connect_error', error => {
        if (/unauthor/i.test(String(error && error.message))) {
          showAuthenticationFailure();
        }
      });
      return socket;
    };
  }

  // ------------------------------------------------------------------- boot
  async function boot() {
    try {
      const response = await rawFetch('/api/auth/status');
      const data = await response.json();
      if (data && data.authRequired && !getToken()) {
        showLogin('');
      }
    } catch {
      // 상태 확인 실패는 기존 연결 오류 UI에 맡긴다.
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
