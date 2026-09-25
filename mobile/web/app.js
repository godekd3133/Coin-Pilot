const STORAGE_KEY = 'coinpilot.ios.dashboardUrl';

const form = document.querySelector('#server-form');
const input = document.querySelector('#server-url');
const error = document.querySelector('#form-error');
const saved = document.querySelector('#saved-server');
const savedHost = document.querySelector('#saved-host');
const forgetButton = document.querySelector('#forget-server');

function savedUrl() {
  try {
    return localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function isPrivateIPv4(hostname) {
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }
  return octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 169 && octets[1] === 254);
}

function normalizeDashboardUrl(value) {
  const candidate = value.trim();
  if (!candidate) throw new Error('대시보드 주소를 입력하세요.');

  let url;
  try {
    url = new URL(candidate.includes('://') ? candidate : `https://${candidate}`);
  } catch {
    throw new Error('주소 형식을 확인하세요. 예: https://example.com');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('주소는 HTTPS 또는 같은 Wi-Fi의 로컬 HTTP 주소여야 합니다.');
  }
  if (url.username || url.password) {
    throw new Error('주소에 사용자 이름이나 비밀번호를 넣지 마세요.');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('서버 루트 주소를 입력하세요. 경로·쿼리는 제외합니다.');
  }

  const localHost = url.hostname === 'localhost' ||
    url.hostname.endsWith('.local') ||
    isPrivateIPv4(url.hostname) ||
    url.hostname.startsWith('fc') ||
    url.hostname.startsWith('fd') ||
    url.hostname.startsWith('fe80:');

  if (url.protocol === 'http:' && !localHost) {
    throw new Error('인터넷 주소는 HTTPS를 사용해야 합니다. HTTP는 로컬 네트워크에서만 허용됩니다.');
  }
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    throw new Error('iPhone의 localhost는 iPhone 자신입니다. 서버가 실행 중인 Mac의 로컬 IP를 입력하세요.');
  }

  return url.origin;
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
  try {
    localStorage.setItem(STORAGE_KEY, url);
  } catch {
    // Native builds also persist this URL in iOS UserDefaults.
  }
  if (nativeConnect) {
    nativeConnect.postMessage(url);
  } else {
    window.location.assign(url);
  }
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

renderSavedServer(savedUrl());
