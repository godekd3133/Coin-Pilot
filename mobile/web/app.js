const STORAGE_KEY = 'coinpilot.ios.dashboardUrl';
const { normalizeDashboardUrl } = window.CoinPilotServerUrlPolicy;

const form = document.querySelector('#server-form');
const input = document.querySelector('#server-url');
const error = document.querySelector('#form-error');
const saved = document.querySelector('#saved-server');
const savedHost = document.querySelector('#saved-host');
const forgetButton = document.querySelector('#forget-server');
const nativeApi = window.webkit?.messageHandlers?.coinpilotApi;

function savedUrl() {
  try {
    return localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function renderSavedServer(value) {
  if (!value) {
    saved.hidden = true;
    forgetButton.hidden = true;
    return;
  }

  const url = new URL(value);
  savedHost.textContent = url.host;
  input.value = value;
  saved.hidden = false;
  forgetButton.hidden = false;
}

function openDashboard(value) {
  const url = normalizeDashboardUrl(value);
  const nativeConnect = window.webkit?.messageHandlers?.coinpilotConnect;
  if (nativeConnect) {
    // UserDefaults is authoritative in the native app. Avoid a second,
    // potentially stale copy in WKWebView's file-origin localStorage.
    nativeConnect.postMessage(url);
    return;
  }

  try {
    localStorage.setItem(STORAGE_KEY, url);
  } catch {
    // Browser storage may be disabled; navigation can still proceed.
  }
  window.location.assign(url);
}

form.addEventListener('submit', event => {
  event.preventDefault();
  error.textContent = '';
  try {
    openDashboard(input.value);
  } catch (cause) {
    error.textContent = cause instanceof Error ? cause.message : '주소를 저장하지 못했습니다.';
  }
});

forgetButton.addEventListener('click', () => {
  window.webkit?.messageHandlers?.coinpilotForget?.postMessage('');
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // The native preference is cleared above.
  }
  input.value = '';
  error.textContent = '';
  renderSavedServer('');
  input.focus();
});

window.addEventListener('coinpilot-native-server-config', event => {
  const detail = event.detail || {};
  if (!detail.hasSavedServer) return;

  if (typeof detail.url === 'string' && detail.url) {
    try {
      localStorage.setItem(STORAGE_KEY, detail.url);
    } catch {
      // The native preference remains authoritative in WKWebView.
    }
    renderSavedServer(detail.url);
    return;
  }

  input.value = '';
  savedHost.textContent = '저장된 주소를 사용할 수 없습니다. 지우고 다시 등록하세요.';
  saved.hidden = false;
  forgetButton.hidden = false;
});

renderSavedServer(savedUrl());

if (nativeApi) {
  nativeApi.postMessage({ action: 'server-config' }).then(result => {
    if (!result?.ok || result.hasSavedServer !== true || typeof result.url !== 'string') return;
    try {
      renderSavedServer(normalizeDashboardUrl(result.url));
    } catch {
      renderSavedServer('');
    }
  }).catch(() => {});
}
