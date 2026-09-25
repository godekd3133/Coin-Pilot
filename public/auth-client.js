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
      #cp-auth-gate{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(10,12,20,.92);backdrop-filter:blur(6px);font-family:inherit}
      #cp-auth-gate[hidden]{display:none}
      #cp-auth-gate .cp-auth-card{width:min(92vw,360px);background:#171a26;border:1px solid #2a2f45;border-radius:14px;padding:28px 24px;box-shadow:0 18px 60px rgba(0,0,0,.5);color:#e8eaf2}
      #cp-auth-gate h1{font-size:18px;margin:0 0 6px;font-weight:700}
      #cp-auth-gate p{font-size:13px;line-height:1.5;color:#9aa1b8;margin:0 0 16px}
      #cp-auth-gate input{width:100%;box-sizing:border-box;padding:11px 12px;border-radius:9px;border:1px solid #343a55;background:#10131e;color:#e8eaf2;font-size:14px;outline:none}
      #cp-auth-gate input:focus{border-color:#5b8cff}
      #cp-auth-gate button{width:100%;margin-top:12px;padding:11px 12px;border:0;border-radius:9px;background:#5b8cff;color:#fff;font-size:14px;font-weight:600;cursor:pointer}
      #cp-auth-gate button:disabled{opacity:.5;cursor:default}
      #cp-auth-gate .cp-auth-error{min-height:18px;margin-top:10px;font-size:12px;color:#ff7b72}
      #cp-auth-gate .cp-auth-hint{margin-top:14px;font-size:11px;color:#6b7191;line-height:1.5;word-break:break-all}
    `;
    document.head.appendChild(style);

    overlay = document.createElement('div');
    overlay.id = 'cp-auth-gate';
    overlay.hidden = true;
    overlay.innerHTML = `
      <form class="cp-auth-card" novalidate>
        <h1>CoinPilot 접속</h1>
        <p>대시보드에 접속하려면 서버 토큰이 필요합니다.<br>서버 <code>.env</code> 파일의 <code>DASHBOARD_TOKEN</code> 값을 입력하세요.</p>
        <input type="password" name="token" autocomplete="off" placeholder="DASHBOARD_TOKEN" aria-label="대시보드 토큰">
        <button type="submit">확인</button>
        <div class="cp-auth-error" role="alert"></div>
        <div class="cp-auth-hint">토큰은 이 브라우저에 저장되고, 대시보드가 서버로 보내는 요청에 함께 전송됩니다.</div>
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
        errorBox.textContent = '토큰을 입력하세요.';
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
        const data = await response.json().catch(() => ({}));
        errorBox.textContent = response.status === 429
          ? (data?.error || '시도가 너무 많습니다. 잠시 후 다시 시도하세요.')
          : '토큰이 올바르지 않습니다.';
      } catch {
        errorBox.textContent = '서버에 연결할 수 없습니다.';
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
      clearToken();
      showLogin('인증이 필요합니다. 대시보드 토큰을 다시 입력하세요.');
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
          showLogin('실시간 연결 인증에 실패했습니다. 토큰을 확인하세요.');
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
