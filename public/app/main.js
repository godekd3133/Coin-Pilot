// Bootstrap: auth gate → store/api/resources → shell chrome → router.
import { createStore } from './core/store.js';
import { APP_BASE } from './core/base.js';
import { createApi } from './core/api.js';
import { createResourceManager, resourceKey } from './core/resources.js';
import { RESOURCE_CATALOG } from './core/resourceCatalog.js';
import { createRouter } from './core/router.js';
import { createDefaultRegistry } from './core/registry.js';
import { connectRealtime } from './core/realtime.js';
import { deriveSession } from './core/session.js';
import { html, render, on, escapeHtml } from './core/dom.js';
import format from './core/format.js';
import ui, { icon, liveBadge, paperBadge, notice, button, skeleton, emptyState, runCountUps, playEntrance, toast } from './ui/components.js';
import {
  createPendingMutationClient, createManualMutationKey, createManualMutationTransport,
  pendingMutationPresentation, protectedMutationError, isTerminalOutcome, outcomeToastTone
} from './core/mutations.js';
import { requestAllowed, mutationBlockReason } from './core/authPolicy.js';
import { toUserText } from './domain/text.js';
import * as trading from './domain/trading.js';

const authClient = window.coinPilotAuth || null;
const defaultAuth = { authRequired: false, tokenScope: 'operator', authenticated: true, resolved: true, verification: 'not-required', tokenPresent: false, error: null };

const store = createStore({
  auth: authClient?.state ? { ...authClient.state } : defaultAuth,
  online: navigator.onLine !== false,
  mutation: { locked: false },
  theme: readTheme(),
  route: null,
  swWaiting: false,
  installPrompt: null
});

const session = () => deriveSession(store.get());

const api = createApi({
  getAuth: () => store.get('auth'),
  getContext: () => ({ online: store.get('online'), readOnlyObserver: session().readOnlyObserver }),
  toUserText
});

const resources = createResourceManager({ store, api, definitions: RESOURCE_CATALOG });

// ----------------------------------------------------------- mutations
function storageOrNull() {
  try { return window.localStorage; } catch { return null; }
}

const mutationClient = createPendingMutationClient({
  storage: storageOrNull(),
  createKey: () => createManualMutationKey(window.crypto),
  sendRequest: createManualMutationTransport({
    fetchImpl: (...args) => window.fetch(...args),
    isAllowed: path => requestAllowed(store.get('auth'), 'POST', path) && !session().readOnlyObserver,
    deniedMessage: () => mutationBlockReason(store.get('auth'), { online: store.get('online'), readOnlyObserver: session().readOnlyObserver })
  }),
  locks: navigator.locks || null,
  onChange: snapshot => store.set({ mutation: snapshot })
});
store.set({ mutation: mutationClient.snapshot() });
window.addEventListener('storage', event => { if (event.key === mutationClient.storageKey) mutationClient.refresh(); });

const MUTATION_REFRESH = ['account', 'trades', 'pnl', 'today', 'prices', 'status'];

async function recordSnapshot() {
  try {
    const result = await api.control.recordSnapshot();
    return result?.recorded === true;
  } catch {
    return false;
  }
}

/**
 * Sends a protected order/wallet mutation through the shared idempotent
 * client and reports the outcome. Returns { ok, outcome, body }.
 */
async function mutate(endpoint, body, { label = '요청', snapshot = false } = {}) {
  const current = session();
  if (!current.canMutate) { toast(current.mutationBlockedReason, 'warning'); return { ok: false }; }
  const outcome = await mutationClient.submit(endpoint, body);
  if (!isTerminalOutcome(outcome)) {
    toast(protectedMutationError(outcome, `${label}을 처리하지 못했습니다.`, { toUserText, symbolOf: format.symbolOf }), outcomeToastTone(outcome));
    resources.refresh('account');
    return { ok: false, outcome };
  }
  const result = outcome.body || {};
  const partial = Array.isArray(result.trades) && result.trades.length > 0;
  if (result.success === false && !partial) {
    toast(protectedMutationError(outcome, `${label}을 처리하지 못했습니다.`, { toUserText, symbolOf: format.symbolOf }), 'warning');
    MUTATION_REFRESH.forEach(name => resources.refresh(name));
    return { ok: false, outcome, body: result };
  }
  const failures = Array.isArray(result.failures) ? result.failures.length : 0;
  toast(`${toUserText(result.message || `${label}을 완료했습니다.`)}${failures ? ` 실패 ${failures}건` : ''}`, result.success === false || failures ? 'warning' : 'success');
  if (outcome.kind === 'terminal-locked') { toast(outcome.message, 'warning'); return { ok: true, outcome, body: result }; }
  if (snapshot && !(await recordSnapshot())) toast('거래는 완료됐지만 자산 추이를 기록하지 못했습니다.', 'warning');
  MUTATION_REFRESH.forEach(name => resources.refresh(name));
  resources.refresh('history');
  return { ok: true, outcome, body: result };
}

async function retryPendingMutation() {
  const current = session();
  if (!current.canMutate) { toast(current.mutationBlockedReason, 'warning'); return; }
  const outcome = await mutationClient.retry();
  if (isTerminalOutcome(outcome)) {
    toast(toUserText(outcome.body?.message || '저장된 요청 결과를 확인했습니다.'), outcome.body?.success === false ? 'warning' : 'success');
    if (outcome.kind === 'terminal-locked') toast(outcome.message, 'warning');
    MUTATION_REFRESH.forEach(name => resources.refresh(name));
  } else {
    toast(protectedMutationError(outcome, '같은 요청 결과를 확인하지 못했습니다.', { toUserText, symbolOf: format.symbolOf }), outcomeToastTone(outcome));
  }
}

/** Engine/settings controls (non-order POSTs) behind a confirmation sheet. */
async function control(run, { success, failure = '요청을 처리하지 못했습니다', refresh = [] } = {}) {
  const current = session();
  if (!current.canMutate) { toast(current.mutationBlockedReason, 'warning'); return null; }
  try {
    const result = await run(api);
    if (result && result.success === false) toast(toUserText(result.message || result.error || failure), 'warning');
    else toast(toUserText(result?.message || success || '요청을 처리했습니다.'), 'success');
    refresh.forEach(name => resources.refresh(name));
    return result;
  } catch (error) {
    toast(`${failure}: ${error.message}`, 'error');
    refresh.forEach(name => resources.refresh(name));
    return null;
  }
}

// ----------------------------------------------------------- theme
function readTheme() {
  try { const value = localStorage.getItem('coinpilot.theme'); return value === 'light' || value === 'dark' ? value : 'system'; } catch { return 'system'; }
}
function setTheme(theme) {
  const value = theme === 'light' || theme === 'dark' ? theme : 'system';
  try { if (value === 'system') localStorage.removeItem('coinpilot.theme'); else localStorage.setItem('coinpilot.theme', value); } catch { /* ignore */ }
  if (value === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = value;
  store.set({ theme: value });
}

// ----------------------------------------------------------- shell
const registry = createDefaultRegistry();
const app = document.getElementById('cp-app');

app.innerHTML = String(html`
  <nav class="cp-sidebar" aria-label="주요 메뉴">
    <a class="cp-brand" href="#/home"><span class="cp-brand-mark">${icon('bolt', { size: 18 })}</span>CoinPilot</a>
    <div class="cp-nav" data-nav="sidebar"></div>
    <div class="cp-nav-section">도구</div>
    <div class="cp-nav" data-nav="tools"></div>
    <div class="cp-sidebar-footer" data-slot="workspace"></div>
  </nav>
  <div class="cp-main">
    <header class="cp-topbar">
      <h1 class="cp-topbar-title" data-slot="title">CoinPilot</h1>
      <div class="cp-topbar-actions" data-slot="topbar"></div>
    </header>
    <div class="cp-banners" data-slot="banners" aria-live="polite"></div>
    <main class="cp-content" id="cp-content" tabindex="-1"></main>
  </div>
  <nav class="cp-tabbar" aria-label="하단 메뉴" data-nav="tabbar"></nav>
`);
app.removeAttribute('aria-busy');
const content = document.getElementById('cp-content');

function renderNav(route) {
  const active = route?.id || 'home';
  const moreActive = !registry.mobileTabs().some(feature => feature.id === active);
  render(app.querySelector('[data-nav="sidebar"]'), registry.sidebar().map(feature => html`<a class="cp-nav-link" href="#/${feature.id}" ${ui.attrs({ 'aria-current': feature.id === active ? 'page' : undefined })}>${icon(feature.icon, { size: 20 })}<span>${feature.label}</span></a>`));
  render(app.querySelector('[data-nav="tools"]'), registry.tools().map(feature => html`<a class="cp-nav-link is-tool" href="#/${feature.id}" ${ui.attrs({ 'aria-current': feature.id === active ? 'page' : undefined })}>${icon(feature.icon, { size: 18 })}<span>${feature.label}</span></a>`));
  render(app.querySelector('[data-nav="tabbar"]'), [
    ...registry.mobileTabs().map(feature => html`<a class="cp-tab" href="#/${feature.id}" ${ui.attrs({ 'aria-current': feature.id === active ? 'page' : undefined })}>${icon(feature.icon)}<span>${feature.label}</span></a>`),
    html`<a class="cp-tab" href="#/more" ${ui.attrs({ 'aria-current': moreActive ? 'page' : undefined })}>${icon('grid')}<span>더보기</span></a>`
  ]);
}

function renderChrome() {
  const current = session();
  const route = store.get('route');
  const entry = route ? registry.get(route.id) : null;
  const titleSlot = app.querySelector('[data-slot="title"]');
  titleSlot.textContent = entry?.label || 'CoinPilot';
  document.title = entry && entry.id !== 'home' ? `${entry.label} · CoinPilot` : 'CoinPilot';
  const realtime = store.get('realtime');
  render(app.querySelector('[data-slot="topbar"]'), html`
    ${current.modeKnown ? (current.isLive ? liveBadge() : paperBadge()) : ''}
    <span class="cp-conn ${current.online && realtime?.connected ? 'is-ok' : !current.online ? 'is-bad' : ''}" title="${current.online ? (realtime?.connected ? '실시간 연결됨' : '주기적으로 갱신 중') : '오프라인'}"><i></i><span class="cp-visually-hidden">${current.online ? '온라인' : '오프라인'}</span></span>
    <button type="button" class="cp-icon-btn" data-action="refresh" aria-label="새로고침">${icon('refresh', { size: 20 })}</button>`);
  render(app.querySelector('[data-slot="workspace"]'), html`
    <div class="${current.isLive ? 'cp-workspace is-live' : 'cp-workspace'}">
      ${current.isLive ? liveBadge() : current.modeKnown ? paperBadge() : ''}
      <div><strong>${current.isLive ? '실전 작업공간' : current.isPaper ? '모의투자 작업공간' : '작업공간 확인 중'}</strong><span>${current.isLive ? '실제 자금으로 주문합니다' : current.isPaper ? '가상 자금으로만 주문합니다' : '서버 모드를 확인하고 있어요'}</span></div>
    </div>`);
  document.documentElement.dataset.workspace = current.isLive ? 'live' : current.isPaper ? 'paper' : 'unknown';
  renderBanners(current);
}

function renderBanners(current) {
  const banners = [];
  const auth = current.auth;
  if (!current.online) {
    banners.push(notice({ tone: 'danger', title: '오프라인 · 주문 잠금', body: '서버 연결이 복구될 때까지 최신 자산과 시세를 확인할 수 없으며 주문을 중지합니다.' }));
  }
  if (auth?.authRequired === true && auth.resolved === true && auth.tokenScope === 'read_only') {
    banners.push(notice({ tone: 'neutral', iconName: 'lock', title: '읽기 전용 접속', body: '자산과 손익만 조회할 수 있습니다. 주문, 설정 변경, 엔진 제어는 운영자 토큰이 필요합니다.', action: button({ label: '토큰 변경', size: 'sm', attrs: { 'data-action': 'login' } }) }));
  } else if (auth?.authRequired === true && auth.resolved === true && auth.tokenScope === 'mobile_operator') {
    banners.push(notice({ tone: 'warning', iconName: 'lock', title: '모바일 앱 전용 토큰', body: '이 토큰은 모바일 앱에서만 사용할 수 있습니다. 브라우저에서는 운영자 토큰으로 다시 연결해 주세요.', action: button({ label: '토큰 변경', size: 'sm', attrs: { 'data-action': 'login' } }) }));
  } else if (auth?.authRequired === true && auth.resolved === true && auth.verification === 'unavailable') {
    banners.push(notice({ tone: 'warning', title: '접속 권한 확인 필요', body: mutationBlockReason(auth, { online: current.online }), action: button({ label: '다시 연결', size: 'sm', attrs: { 'data-action': 'login' } }) }));
  }
  if (current.readOnlyObserver) {
    banners.push(notice({ tone: 'neutral', iconName: 'lock', title: '읽기 전용 관찰 서버', body: '기록된 모의투자 결과를 보여주는 관찰용 서버입니다. 주문과 설정 변경은 비활성화되어 있습니다.' }));
  }
  const pending = pendingMutationPresentation(current.pending, { online: current.online });
  if (pending.visible) {
    banners.push(html`<div class="cp-notice is-warning cp-pending" role="alert">${icon('clock', { size: 20 })}<div class="cp-notice-body"><strong>${pending.title}</strong><p>${pending.copy}</p></div>${pending.retryVisible ? html`<div class="cp-notice-action">${button({ label: pending.retryLabel, size: 'sm', variant: 'primary', disabled: pending.retryDisabled, attrs: { 'data-action': 'retry-mutation' } })}</div>` : ''}</div>`);
  }
  if (current.status?.runtimeState === 'PROTECTIVE_ONLY' || current.status?.runtimeState === 'SYNC_REQUIRED' || current.status?.exchangeStateKnown === false) {
    banners.push(notice({ tone: current.status.runtimeState === 'PROTECTIVE_ONLY' ? 'danger' : 'warning', title: current.status.runtimeState === 'PROTECTIVE_ONLY' ? '위험 감시 전용 · 신규 주문 잠금' : '거래소 상태 확인 중 · 주문 잠금', body: trading.runtimeBlockReason(current.status) }));
  }
  if (store.get('swWaiting')) {
    banners.push(notice({ tone: 'info', iconName: 'refresh', title: '새 버전이 준비됐어요', body: '업데이트하면 최신 화면으로 다시 불러옵니다.', action: button({ label: '업데이트', size: 'sm', variant: 'primary', attrs: { 'data-action': 'sw-update' } }) }));
  }
  render(app.querySelector('[data-slot="banners"]'), banners);
}

on(app, 'click', '[data-action]', async (event, target) => {
  const action = target.dataset.action;
  if (action === 'refresh') {
    target.classList.add('is-spinning');
    await resources.refreshActive();
    target.classList.remove('is-spinning');
  } else if (action === 'retry-mutation') {
    await retryPendingMutation();
  } else if (action === 'login') {
    authClient?.requestLogin?.('');
  } else if (action === 'sw-update') {
    swRegistration?.waiting?.postMessage({ type: 'SKIP_WAITING' });
  }
});

window.addEventListener('scroll', () => app.querySelector('.cp-topbar')?.classList.toggle('is-scrolled', window.scrollY > 4), { passive: true });

// ----------------------------------------------------------- router
function createContext({ route, entry, root }) {
  const disposers = [];
  const ctx = {
    route,
    entry,
    root,
    store,
    api,
    resources,
    registry,
    router: null,
    ui,
    format,
    html,
    render,
    session,
    mutate,
    control,
    toUserText,
    confirm: ui.confirmSheet,
    /** Re-runs fn when any of the store keys (or resource names via res()) change. */
    watch(keys, fn, { immediate = true } = {}) {
      const unsubscribe = store.subscribe([].concat(keys), () => fn(store.get()));
      disposers.push(unsubscribe);
      if (immediate) fn(store.get());
      return unsubscribe;
    },
    res: name => resourceKey(name),
    data: name => store.get(resourceKey(name))?.data ?? null,
    resource: name => resources.getState(name),
    use: names => { const release = resources.use(names); disposers.push(release); return release; },
    on(type, selector, handler) { disposers.push(on(root, type, selector, handler)); },
    after(fn) { disposers.push(fn); },
    enhance(target = root) { runCountUps(target); },
    navigate: (id, params, query) => router.navigate(id, params, query),
    dispose() { while (disposers.length) { try { disposers.pop()(); } catch { /* ignore */ } } }
  };
  ctx.router = { navigate: (id, params, query) => router.navigate(id, params, query) };
  return ctx;
}

const router = createRouter({
  registry,
  defaultId: 'home',
  getRoot: () => content,
  resources,
  createContext,
  onRouteChange(route, entry, { loading } = {}) {
    store.set({ route });
    renderNav(route);
    renderChrome();
    if (loading) {
      render(content, html`<div class="cp-route-loading">${ui.card({ body: skeleton({ hero: true, lines: 2 }) })}${ui.card({ body: skeleton({ lines: 4 }) })}</div>`);
    } else if (loading === false) {
      playEntrance(content);
      runCountUps(content);
      if (document.activeElement === document.body) content.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: 'auto' });
    }
  },
  onError(error, entry) {
    console.error(error);
    render(content, ui.card({ body: emptyState({ iconName: 'alert', title: `${entry?.label || '화면'}을 열지 못했어요`, body: '네트워크 연결을 확인한 뒤 다시 시도해 주세요.', action: button({ label: '다시 시도', variant: 'primary', attrs: { 'data-action': 'reload-route' } }) }) }));
  }
});
on(content, 'click', '[data-action="reload-route"]', () => router.resolve());

store.subscribe([resourceKey('status'), resourceKey('account'), resourceKey('paper'), 'auth', 'online', 'mutation', 'swWaiting', 'realtime'], () => renderChrome());

// ----------------------------------------------------------- connectivity
window.addEventListener('offline', () => store.set({ online: false }));
window.addEventListener('online', () => { store.set({ online: true }); resources.refreshActive(); });
window.addEventListener('coinpilot:auth-state', event => {
  const previous = store.get('auth');
  store.set({ auth: { ...event.detail } });
  if (previous?.verification !== event.detail?.verification || previous?.tokenScope !== event.detail?.tokenScope) resources.refreshActive();
});

// ----------------------------------------------------------- PWA
let swRegistration = null;
function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
  navigator.serviceWorker.register(`${APP_BASE}sw.js`, { scope: APP_BASE }).then(registration => {
    swRegistration = registration;
    const markWaiting = () => store.set({ swWaiting: Boolean(registration.waiting && navigator.serviceWorker.controller) });
    markWaiting();
    registration.addEventListener('updatefound', () => {
      registration.installing?.addEventListener('statechange', markWaiting);
    });
  }).catch(() => { /* PWA offline cache is optional */ });
}
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); store.set({ installPrompt: event }); });
window.addEventListener('appinstalled', () => store.set({ installPrompt: null }));

// expose theme control to features via store action
store.setTheme = setTheme;
window.CoinPilotApp = { store, resources, router, registry, version: '2.0.0' };

async function boot() {
  if (authClient?.ready) {
    try {
      const verified = await authClient.ready;
      store.set({ auth: { ...(authClient.state || verified) } });
    } catch {
      store.set({ auth: { ...store.get('auth'), resolved: true, verification: 'unavailable', authenticated: null } });
    }
  }
  // Global reads: workspace mode + order locks need these on every screen.
  resources.use(['status', 'account']);
  connectRealtime({ store, resources, toast });
  initServiceWorker();
  await router.start();
}

boot().catch(error => {
  console.error(error);
  content.innerHTML = `<div class="cp-card"><p>${escapeHtml('앱을 시작하지 못했습니다. 새로고침해 주세요.')}</p></div>`;
});
