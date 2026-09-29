(function startCoinPilotIOSApp() {
  'use strict';

  const state = {
    activeScreen: 'home',
    period: '24h',
    status: null,
    account: null,
    pnl: null,
    today: null,
    history: null,
    markets: null,
    trades: null,
    updatedAt: null,
    refreshPromise: null,
    refreshTimer: null
  };

  const byId = id => document.getElementById(id);
  const apiBridge = window.webkit?.messageHandlers?.coinpilotApi;
  const serverSettingsBridge = window.webkit?.messageHandlers?.coinpilotShowServerSettings;

  function finite(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function numberText(value) {
    const parsed = finite(value);
    return parsed === null ? '—' : new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 }).format(parsed);
  }

  function quantityText(value) {
    const parsed = finite(value);
    return parsed === null ? '—' : new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 8 }).format(parsed);
  }

  function won(value) {
    const parsed = finite(value);
    return parsed === null ? '—' : numberText(parsed) + '원';
  }

  function signedWon(value) {
    const parsed = finite(value);
    if (parsed === null) return '손익 미제공';
    const prefix = parsed > 0 ? '+' : parsed < 0 ? '−' : '';
    return prefix + won(Math.abs(parsed));
  }

  function percent(value) {
    const parsed = finite(value);
    if (parsed === null) return '—';
    const prefix = parsed > 0 ? '+' : parsed < 0 ? '−' : '';
    return prefix + Math.abs(parsed).toFixed(2) + '%';
  }

  function safeString(value, fallback) {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function dateText(value) {
    if (!value) return '시각 미제공';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '시각 미제공';
    return new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
  }

  function clockText(value) {
    const date = value ? new Date(value) : null;
    return date && Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit' }).format(date)
      : '시각 미제공';
  }

  byId('today-label').textContent = new Intl.DateTimeFormat('ko-KR', {
    month: 'long', day: 'numeric', weekday: 'long'
  }).format(new Date());

  function showToast(message) {
    const toast = byId('toast');
    toast.textContent = message;
    toast.hidden = false;
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => { toast.hidden = true; }, 2600);
  }

  function setConnectionError(message) {
    byId('connection-error').textContent = message || '인터넷 연결과 서버 주소를 확인해 주세요.';
    byId('connection-banner').hidden = !message;
    byId('settings-server-status').textContent = message ? '연결되지 않음' : '연결됨';
  }

  async function nativeRequest(payload) {
    if (!apiBridge) return { ok: false, status: 0, error: '이 기능은 iOS 앱에서 사용할 수 있습니다.' };
    try {
      const result = await apiBridge.postMessage(payload);
      return result && typeof result === 'object' ? result : { ok: false, status: 0, error: '서버 응답을 읽지 못했습니다. 다시 시도해 주세요.' };
    } catch {
      return { ok: false, status: 0, error: '서버에 연결하지 못했습니다. 인터넷 연결과 서버 주소를 확인해 주세요.' };
    }
  }

  function openLogin(message) {
    byId('connection-banner').hidden = true;
    byId('auth-gate').hidden = false;
    byId('auth-error').textContent = message || '';
    window.setTimeout(() => byId('dashboard-token').focus(), 120);
  }

  function updateMode() {
    const mode = state.status?.mode || state.account?.mode || state.pnl?.mode || '';
    const label = mode === 'LIVE' ? '실거래' : mode === 'DRY_RUN' ? '모의투자' : '거래 모드 확인 중';
    const badge = byId('mode-badge');
    badge.textContent = label;
    badge.classList.toggle('live', mode === 'LIVE');
    byId('engine-mode').textContent = label;
    byId('portfolio-mode').textContent = mode === 'LIVE' ? '실거래 계좌' : mode === 'DRY_RUN' ? '모의투자 계좌' : '거래 모드를 확인할 수 없습니다.';
    byId('settings-mode').textContent = label;
    byId('observer-row').hidden = state.status?.readOnlyObserver !== true && state.account?.readOnlyObserver !== true;
  }

  function renderChart() {
    const svg = byId('equity-chart');
    const empty = byId('chart-empty');
    const points = Array.isArray(state.history?.data)
      ? state.history.data.map(item => ({ time: new Date(item.timestamp).getTime(), value: finite(item.totalAssets) })).filter(item => Number.isFinite(item.time) && item.value !== null)
      : [];
    svg.replaceChildren();
    if (points.length < 2) {
      svg.hidden = true;
      empty.hidden = false;
      return;
    }
    svg.hidden = false;
    empty.hidden = true;
    const values = points.map(item => item.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const spread = Math.max(max - min, Math.abs(max) * 0.002, 1);
    const coords = points.map((point, index) => {
      const x = 2 + (356 * index / (points.length - 1));
      const y = 84 - ((point.value - min) / spread) * 66;
      return [x, y];
    });
    const line = coords.map((point, index) => (index ? 'L' : 'M') + point[0].toFixed(1) + ' ' + point[1].toFixed(1)).join(' ');
    const area = line + ' L 358 100 L 2 100 Z';
    const fill = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    fill.setAttribute('d', area);
    fill.setAttribute('fill', '#e6f6ef');
    const stroke = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    stroke.setAttribute('d', line);
    stroke.setAttribute('fill', 'none');
    stroke.setAttribute('stroke', '#0a7a58');
    stroke.setAttribute('stroke-width', '1.8');
    stroke.setAttribute('stroke-linecap', 'square');
    stroke.setAttribute('stroke-linejoin', 'round');
    svg.append(fill, stroke);
    byId('chart-caption').textContent = state.period === '7d' ? '최근 7일' : state.period === '30d' ? '최근 30일' : '최근 24시간';
  }

  function renderMarkets() {
    const list = byId('market-list');
    const rows = Array.isArray(state.markets) ? state.markets : [];
    const priority = ['KRW-BTC', 'KRW-ETH', 'KRW-XRP'];
    const selected = priority.map(symbol => rows.find(item => item.coin === symbol)).filter(Boolean);
    const markets = selected.length ? selected : rows.slice(0, 3);
    if (!markets.length) {
      list.innerHTML = '<p class="empty-row">시세를 불러오지 못했습니다.</p>';
      return;
    }
    const coinInfo = {
      'KRW-BTC': ['비트코인', 'BTC', 'btc'],
      'KRW-ETH': ['이더리움', 'ETH', 'eth'],
      'KRW-XRP': ['리플', 'XRP', 'xrp']
    };
    list.innerHTML = markets.map(item => {
      const info = coinInfo[item.coin] || [String(item.coin || '').replace('KRW-', ''), String(item.coin || '').replace('KRW-', ''), ''];
      const change = finite(item.change);
      const color = change === null ? '' : change > 0 ? 'positive' : change < 0 ? 'negative' : '';
      return '<article class="market-row"><span class="coin-avatar ' + info[2] + '">' + escapeHtml(info[1].slice(0, 1)) + '</span><div class="market-copy"><strong>' + escapeHtml(info[0]) + '</strong><span>' + escapeHtml(info[1]) + ' · KRW</span></div><strong class="market-value">' + won(item.price) + '<span class="' + color + '">' + percent(change) + '</span></strong></article>';
    }).join('');
    byId('market-updated').textContent = state.updatedAt ? '확인 ' + clockText(state.updatedAt) : '시각 미제공';
  }

  function tradeKind(trade) {
    const raw = String(trade.type || trade.action || trade.side || '').toUpperCase();
    if (raw.includes('BUNDLE_TRADE')) return { label: '묶음 거래', kind: '', glyph: '↔' };
    if (raw.includes('BUY') || raw.includes('OPEN')) return { label: '매수', kind: 'buy', glyph: '＋' };
    if (raw.includes('SELL') || raw.includes('CLOSE')) return { label: '매도', kind: 'sell', glyph: '−' };
    return { label: '거래', kind: '', glyph: '·' };
  }

  function tradeValue(trade) {
    if (trade.source === 'strategy') {
      const profit = finite(trade.profit);
      if (profit !== null) return { value: profit, label: '손익', signed: true };
      const price = finite(trade.price) ?? finite(trade.exitPrice) ?? finite(trade.entryPrice);
      return price === null ? null : { value: price, label: '기준가', signed: false };
    }
    const explicitValue = finite(trade.value) ?? finite(trade.total) ?? finite(trade.amount);
    return explicitValue === null ? null : { value: explicitValue, label: '거래 금액', signed: false };
  }

  function renderTrades() {
    const trades = Array.isArray(state.trades) ? state.trades : [];
    const target = byId('recent-list');
    const activityTarget = byId('activity-list');
    if (!trades.length) {
      const empty = '<p class="empty-row">거래 내역이 없습니다.</p>';
      target.innerHTML = empty;
      activityTarget.innerHTML = empty;
      return;
    }
    const rows = trades.map(trade => {
      const kind = tradeKind(trade);
      const tradeType = String(trade.type || '').toUpperCase();
      const sold = safeString(trade.sell?.coin, '').replace('KRW-', '');
      const bought = safeString(trade.buy?.coin, '').replace('KRW-', '');
      const coin = tradeType === 'BUNDLE_TRADE' && sold && bought
        ? sold + ' → ' + bought
        : safeString(trade.coin, '자산 미제공').replace('KRW-', '');
      const time = dateText(trade.timestamp || trade.entryTime || trade.exitTime);
      const value = tradeValue(trade);
      const amount = value === null ? '금액 미제공' : value.signed ? signedWon(value.value) : won(value.value);
      const amountClass = value === null || !value.signed ? '' : value.value > 0 ? 'positive' : value.value < 0 ? 'negative' : '';
      const amountLabel = value === null ? '' : value.label;
      return '<article class="activity-row"><span class="activity-symbol ' + kind.kind + '">' + kind.glyph + '</span><div class="activity-copy"><strong>' + escapeHtml(coin + ' · ' + kind.label) + '</strong><span>' + escapeHtml(time) + '</span></div><strong class="activity-value ' + amountClass + '">' + escapeHtml(amount) + (amountLabel ? '<span>' + escapeHtml(amountLabel) + '</span>' : '') + '</strong></article>';
    });
    target.innerHTML = rows.slice(0, 3).join('');
    activityTarget.innerHTML = rows.join('');
    byId('activity-updated').textContent = state.updatedAt ? '확인 ' + clockText(state.updatedAt) : '시각 미제공';
  }

  function renderPositions() {
    const positions = Array.isArray(state.account?.positions) ? state.account.positions : [];
    byId('position-count').textContent = positions.length + '개';
    byId('holdings-count').textContent = positions.length + '개';
    byId('cash-value').textContent = won(state.account?.krwBalance);
    if (!positions.length) {
      byId('holdings-list').innerHTML = '<p class="empty-row">현재 보유 중인 코인이 없습니다.</p>';
      return;
    }
    byId('holdings-list').innerHTML = positions.map(position => {
      const symbol = safeString(position.coin, '코인').replace('KRW-', '');
      const value = finite(position.currentValue);
      const gain = finite(position.profit);
      const gainClass = gain === null ? '' : gain > 0 ? 'positive' : gain < 0 ? 'negative' : '';
      const detail = position.amount === null || position.amount === undefined ? '수량 미제공' : '수량 ' + quantityText(position.amount);
      const change = position.profitPercent === null || position.profitPercent === undefined ? '' : '<span class="' + gainClass + '">' + percent(position.profitPercent) + '</span>';
      return '<article class="holding-row"><span class="asset-symbol">' + escapeHtml(symbol.slice(0, 1)) + '</span><div class="asset-main"><strong>' + escapeHtml(symbol) + '</strong><span>' + escapeHtml(detail) + '</span></div><strong class="asset-value">' + (value === null ? '평가액 미제공' : won(value)) + '<span>' + (gain === null ? '손익 미제공' : '<span class="' + gainClass + '">' + signedWon(gain) + '</span>') + change + '</span></strong></article>';
    }).join('');
  }

  function render() {
    const account = state.account || {};
    const pnl = state.pnl || {};
    const observer = state.status?.readOnlyObserver === true || account.readOnlyObserver === true;
    const total = observer ? finite(account.totalAssets) : finite(account.totalAssets) ?? finite(pnl.totalAssets);
    const profit = observer ? finite(account.profit) : finite(account.profit) ?? finite(pnl.profit);
    const change = observer ? finite(account.profitPercent) : finite(account.profitPercent) ?? finite(pnl.profitPercent);
    byId('total-assets').textContent = total === null ? '평가액 미제공' : won(total);
    byId('portfolio-total').textContent = total === null ? '평가액 미제공' : won(total);
    const profitText = profit === null ? '손익 미제공' : signedWon(profit) + (change === null ? '' : ' · ' + percent(change));
    byId('profit-value').textContent = profitText;
    byId('profit-value').classList.toggle('positive', profit !== null && profit > 0);
    byId('profit-value').classList.toggle('negative', profit !== null && profit < 0);
    byId('today-stat-label').textContent = observer ? '평가 기준 시각' : '오늘 손익';
    byId('today-profit').textContent = observer
      ? (account.valuationAsOf ? dateText(account.valuationAsOf) : '시각 미제공')
      : signedWon(state.today?.realizedProfit);
    byId('today-profit').classList.toggle('positive', !observer && finite(state.today?.realizedProfit) > 0);
    byId('today-profit').classList.toggle('negative', !observer && finite(state.today?.realizedProfit) < 0);
    byId('valuation-note').textContent = account.readOnlyObserver === true
      ? (account.valuationAsOf ? '조회 전용 · ' + dateText(account.valuationAsOf) : '조회 전용 계좌')
      : (state.updatedAt ? '마지막 확인 ' + clockText(state.updatedAt) : '');
    byId('engine-status').textContent = observer
      ? '조회 전용 계좌'
      : state.status?.isRunning === true ? '자동매매 실행 중' : state.status?.isRunning === false ? '자동매매 중지' : '자동매매 상태 확인 불가';
    byId('engine-detail').textContent = observer
      ? '이 계좌에서는 주문을 실행하지 않습니다.'
      : state.status?.isRunning === true ? '앱을 닫아도 서버에서 계속 실행됩니다.'
        : state.status?.isRunning === false ? '현재 중지되어 있습니다.'
          : '자동매매 상태를 확인하지 못했습니다.';
    byId('engine-note').textContent = observer
      ? '이 계좌는 조회 전용입니다. 앱에서는 주문을 실행하지 않습니다.'
      : state.status?.isRunning === true
        ? '자동매매가 실행 중입니다. 앱을 닫아도 서버에서 계속 실행됩니다.'
        : state.status?.isRunning === false
          ? '자동매매가 중지되어 있습니다. 앱을 닫아도 다시 시작되지 않습니다.'
          : '자동매매 상태를 확인하지 못했습니다.';
    byId('engine-indicator').classList.toggle('running', state.status?.isRunning === true);
    byId('settings-engine-status').textContent = observer
      ? '조회 전용'
      : state.status?.isRunning === true ? '실행 중' : state.status?.isRunning === false ? '중지' : '확인 불가';
    byId('server-address').textContent = safeString(state.serverAddress, '확인 중');
    byId('settings-server-status').textContent = state.status || state.account ? '연결됨' : '확인 중';
    updateMode();
    renderChart();
    renderMarkets();
    renderPositions();
    renderTrades();
  }

  async function refresh() {
    if (state.refreshPromise) return state.refreshPromise;
    state.refreshPromise = (async () => {
      const server = await nativeRequest({ action: 'server-config' });
      if (server.ok && typeof server.url === 'string') {
        try { state.serverAddress = new URL(server.url).host; } catch { state.serverAddress = server.url; }
      }
      const auth = await nativeRequest({ action: 'auth-status' });
      if (!auth.ok) {
        setConnectionError(auth.error || '서버 주소와 인터넷 연결을 확인해 주세요.');
        byId('settings-server-status').textContent = '연결되지 않음';
        return;
      }
      setConnectionError('');
      if (auth.data?.authRequired && auth.hasToken !== true) {
        openLogin('');
        return;
      }
      byId('auth-gate').hidden = true;
      const paths = [
        ['status', '/api/status'],
        ['account', '/api/account'],
        ['pnl', '/api/cumulative-pnl'],
        ['today', '/api/today-summary'],
        ['history', '/api/portfolio/history?period=' + encodeURIComponent(state.period)],
        ['markets', '/api/market/prices'],
        ['trades', '/api/trades?limit=30']
      ];
      const results = await Promise.all(paths.map(async ([key, path]) => [key, await nativeRequest({ action: 'read', path })]));
      const rejected = results.find(([, result]) => result.status === 401);
      if (rejected) {
        openLogin('서버 인증을 확인할 수 없습니다. 접속 토큰을 다시 입력해 주세요.');
        return;
      }
      let successes = 0;
      for (const [key, result] of results) {
        if (!result.ok) continue;
        state[key] = result.data;
        successes += 1;
      }
      if (!successes) {
        const failure = results.find(([, result]) => result.error)?.[1];
        setConnectionError(failure?.error || '서버에서 계좌 정보를 불러오지 못했습니다.');
        return;
      }
      state.updatedAt = new Date().toISOString();
      setConnectionError('');
      render();
    })().finally(() => { state.refreshPromise = null; });
    return state.refreshPromise;
  }

  function selectScreen(name) {
    state.activeScreen = name;
    document.querySelectorAll('.screen').forEach(screen => {
      const active = screen.dataset.screen === name;
      screen.hidden = !active;
      screen.classList.toggle('active', active);
    });
    document.querySelectorAll('.tab-button').forEach(button => {
      const active = button.dataset.tab === name;
      button.classList.toggle('selected', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    if (name === 'assets' || name === 'activity' || name === 'settings') render();
  }

  document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => selectScreen(button.dataset.tab)));
  document.querySelectorAll('[data-open-screen]').forEach(button => button.addEventListener('click', () => selectScreen(button.dataset.openScreen)));
  document.querySelectorAll('[data-period]').forEach(button => button.addEventListener('click', async () => {
    state.period = button.dataset.period;
    document.querySelectorAll('[data-period]').forEach(item => item.classList.toggle('selected', item === button));
    await refresh();
  }));

  byId('retry').addEventListener('click', refresh);
  byId('change-server').addEventListener('click', () => {
    if (serverSettingsBridge) serverSettingsBridge.postMessage('');
    else showToast('서버 설정은 iOS 앱에서 변경할 수 있습니다.');
  });
  byId('logout').addEventListener('click', async () => {
    const result = await nativeRequest({ action: 'logout' });
    if (!result.ok) {
      showToast(result.error || '서버 접속 정보를 삭제하지 못했습니다.');
      return;
    }
    await refresh();
    if (!byId('auth-gate').hidden) byId('auth-error').textContent = '서버 접속 정보를 삭제했습니다. 다시 연결하려면 토큰을 입력해 주세요.';
    else showToast('서버 접속 정보를 삭제했습니다.');
  });

  byId('auth-form').addEventListener('submit', async event => {
    event.preventDefault();
    const token = byId('dashboard-token').value.trim();
    if (!token) {
      byId('auth-error').textContent = '접속 토큰을 입력해 주세요.';
      return;
    }
    const submit = byId('auth-submit');
    submit.disabled = true;
    byId('auth-error').textContent = '';
    const result = await nativeRequest({ action: 'login', token });
    submit.disabled = false;
    if (!result.ok) {
      byId('auth-error').textContent = result.error || '접속 토큰을 확인해 주세요.';
      return;
    }
    byId('dashboard-token').value = '';
    byId('auth-gate').hidden = true;
    await refresh();
    showToast('서버에 연결했습니다.');
  });

  window.addEventListener('coinpilot-server-config', event => {
    const value = event.detail?.url;
    if (typeof value === 'string' && value) state.serverAddress = value.replace(/^https?:\/\//, '').replace(/\/$/, '');
    render();
  });
  window.coinPilotRefresh = refresh;
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
  window.addEventListener('pageshow', () => refresh());
  state.refreshTimer = window.setInterval(() => {
    if (!document.hidden && !byId('auth-gate').hidden) return;
    if (!document.hidden) refresh();
  }, 30000);

  refresh();
})();
