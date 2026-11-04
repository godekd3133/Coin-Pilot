// 코인: scalper engine, holdings, searchable market list, and a market detail
// (#/coins/KRW-BTC) with candles, indicators and order entry points.
import { html, render } from '../../core/dom.js';
import { won, signedWon, percent, price, tone, compactWon, quantity, symbolOf, marketTimestamp, hasFiniteValue } from '../../core/format.js';
import { card, list, listRow, avatar, badge, segmented, emptyState, skeleton, button, linkButton, statGrid, candleChart, notice, icon } from '../../ui/components.js';
import { scalperEngine, confirmScalper, coinPositionRow, resourceView } from '../../ui/patterns.js';
import { marketDisplayName, marketSearchText } from '../../domain/records.js';
import { marketSnapshotPresentation, marketRowQuotePresentation, marketQuoteFreshnessIssue, getDisplayedCandles } from '../../domain/trading.js';
import { coinPositions } from '../../domain/portfolio.js';

const PAGE = 40;
const SORTS = [{ value: 'volume', label: '거래대금' }, { value: 'change', label: '상승률' }, { value: 'fall', label: '하락률' }, { value: 'name', label: '이름' }];
const INTERVALS = [{ value: 1, label: '1분' }, { value: 5, label: '5분' }, { value: 15, label: '15분' }, { value: 60, label: '1시간' }, { value: 240, label: '4시간' }];
const RANGES = [{ value: 30, label: '30개' }, { value: 60, label: '60개' }, { value: 100, label: '100개' }];

function sortedMarkets(prices, sort, query) {
  const search = String(query || '').trim().toUpperCase();
  const rows = (prices || []).filter(row => !search || marketSearchText(row).includes(search));
  const by = {
    volume: (a, b) => (Number(b.volumeKrw) || 0) - (Number(a.volumeKrw) || 0),
    change: (a, b) => (Number(b.change) || 0) - (Number(a.change) || 0),
    fall: (a, b) => (Number(a.change) || 0) - (Number(b.change) || 0),
    name: (a, b) => marketDisplayName(a).localeCompare(marketDisplayName(b), 'ko')
  };
  return [...rows].sort(by[sort] || by.volume);
}

function mountList(root, ctx) {
  const state = { sort: 'volume', query: '', visible: PAGE };
  render(root, html`<div class="cp-page">
    <div class="cp-grid-2">
      <div data-slot="engine"></div>
      <div data-slot="holdings"></div>
    </div>
    <div data-slot="markets"></div>
  </div>`);
  const slot = name => root.querySelector(`[data-slot="${name}"]`);

  render(slot('markets'), card({
    index: 2,
    title: '시장',
    subtitle: '원화 마켓 · 시세 갱신 15초',
    body: html`<div class="cp-toolbar" style="margin-bottom:12px">
        <label class="cp-search"><span class="cp-visually-hidden">종목 검색</span>${icon('search', { size: 18 })}<input class="cp-input" type="search" data-input="search" placeholder="이름·심볼 검색 (비트코인, BTC)" autocomplete="off"></label>
        <select class="cp-input" data-input="sort" aria-label="정렬">${SORTS.map(option => html`<option value="${option.value}">${option.label}</option>`)}</select>
      </div>
      <p class="cp-caption" data-slot="market-status" aria-live="polite"></p>
      <div data-slot="market-list"></div>`
  }));

  function renderEngine() {
    render(slot('engine'), card({ index: 0, title: '자동매매', body: scalperEngine(ctx.session()) }));
  }

  function renderHoldings() {
    const s = ctx.session();
    const accountState = ctx.resource('account');
    render(slot('holdings'), card({
      index: 1,
      title: '보유 코인',
      subtitle: s.account ? `현금 ${won(s.account.krwBalance)}` : null,
      action: linkButton({ label: '주문하기', href: '#/trade', variant: 'primary' }),
      body: resourceView(accountState, account => list(coinPositions(account).map(position => coinPositionRow(position)), {
        empty: emptyState({ iconName: 'coin', title: '보유한 코인이 없어요', body: '자동매매나 직접 주문으로 매수하면 여기에 표시돼요.' })
      }), { lines: 3 })
    }));
  }

  function renderMarkets() {
    const s = ctx.session();
    const pricesState = ctx.resource('prices');
    const presentation = marketSnapshotPresentation(s.marketSnapshot, s.marketPricesLoaded, s.marketPrices, s.freshnessOptions);
    const statusEl = slot('market-status');
    if (statusEl) {
      statusEl.className = `cp-caption ${presentation.tone === 'complete' ? '' : presentation.tone === 'unavailable' ? 'cp-danger' : 'cp-warn'}`;
      statusEl.textContent = pricesState.data === null && pricesState.status !== 'error' ? '시세를 불러오는 중이에요' : `${presentation.detail} · 목록 ${presentation.listTime}`;
    }
    const target = slot('market-list');
    if (!target) return;
    if (pricesState.data === null) { render(target, pricesState.status === 'error' ? emptyState({ iconName: 'alert', title: '시세를 불러오지 못했어요', body: ctx.toUserText(pricesState.error?.message || '') }) : skeleton({ lines: 6 })); return; }
    const owned = new Set(coinPositions(s.account).map(position => position.coin));
    const rows = sortedMarkets(s.marketPrices, state.sort, state.query);
    const shown = rows.slice(0, state.visible);
    render(target, html`${list(shown.map(row => {
      const quote = marketRowQuotePresentation(row, s.marketPricesLoaded, s.freshnessOptions);
      return listRow({
        leading: avatar(symbolOf(row.coin), { tone: owned.has(row.coin) ? 'green' : 'blue' }),
        title: html`${marketDisplayName(row)} ${owned.has(row.coin) ? badge('보유', 'ok') : ''}`,
        subtitle: `${symbolOf(row.coin)} · 거래대금 ${compactWon(row.volumeKrw)}원${quote.state === 'current' ? '' : ` · ${quote.label}`}`,
        value: `${price(row.price)}원`,
        valueSub: percent(row.change),
        valueTone: tone(row.change),
        href: `#/coins/${encodeURIComponent(row.coin)}`
      });
    }), { empty: emptyState({ iconName: 'search', title: state.query ? '검색 결과가 없어요' : '표시할 시세가 없어요', action: state.query ? button({ label: '검색 초기화', attrs: { 'data-action': 'reset-search' } }) : null }) })}
    ${rows.length > shown.length ? html`<div style="margin-top:12px">${button({ label: `더 보기 (${shown.length}/${rows.length})`, attrs: { 'data-action': 'more' }, variant: 'secondary' })}</div>` : rows.length ? html`<p class="cp-caption" style="margin-top:8px">${rows.length}개 시장 표시</p>` : ''}`);
  }

  ctx.watch([ctx.res('status'), 'auth', 'online'], renderEngine);
  ctx.watch([ctx.res('account')], () => { renderHoldings(); renderMarkets(); });
  ctx.watch([ctx.res('prices')], renderMarkets);
  ctx.on('input', '[data-input="search"]', (event, target) => { state.query = target.value; state.visible = PAGE; renderMarkets(); });
  ctx.on('change', '[data-input="sort"]', (event, target) => { state.sort = target.value; state.visible = PAGE; renderMarkets(); });
  ctx.on('click', '[data-action="more"]', () => { state.visible += PAGE; renderMarkets(); });
  ctx.on('click', '[data-action="reset-search"]', () => { state.query = ''; const input = root.querySelector('[data-input="search"]'); if (input) { input.value = ''; input.focus(); } renderMarkets(); });
  ctx.on('click', '[data-engine="scalper"]', (event, target) => confirmScalper(ctx, target.dataset.engineAction));
}

function mountDetail(root, ctx, coin) {
  const view = { unit: Number(localStorage.getItem('coinpilot.candleUnit')) || 5, range: 60 };
  let requestSequence = 0;
  let candles = { coin: null, unit: null, rows: [], error: null, loading: false };

  render(root, html`<div class="cp-page">
    <a class="cp-btn is-ghost" href="#/coins" style="justify-self:start">← 코인 목록</a>
    <div data-slot="header"></div>
    <div class="cp-split">
      <div class="cp-stack"><div data-slot="chart"></div><div data-slot="indicators"></div></div>
      <div class="cp-stack"><div data-slot="position"></div></div>
    </div>
  </div>`);
  const slot = name => root.querySelector(`[data-slot="${name}"]`);

  async function loadCandles() {
    const sequence = ++requestSequence;
    const unit = view.unit;
    const keepPrevious = candles.coin === coin && candles.unit === unit && candles.rows.length > 0;
    candles = { ...candles, coin, unit, loading: true, error: null, rows: keepPrevious ? candles.rows : [] };
    renderChart();
    try {
      const rows = await ctx.api.get(`/market/candles/${encodeURIComponent(coin)}?unit=${unit}&count=100`);
      if (sequence !== requestSequence) return; // a newer request owns the chart
      candles = { coin, unit, rows: Array.isArray(rows) ? rows : [], error: null, loading: false };
    } catch (error) {
      if (sequence !== requestSequence) return;
      candles = { ...candles, loading: false, error };
    }
    renderChart();
  }

  function renderHeader() {
    const s = ctx.session();
    const market = s.marketPrices.find(row => row.coin === coin) || null;
    const issue = market ? marketQuoteFreshnessIssue(market, s.freshnessOptions) : null;
    render(slot('header'), card({
      index: 0,
      body: html`<div class="cp-row-between" style="align-items:flex-start">
        <div class="cp-hero">
          <p class="cp-hero-label">${marketDisplayName({ coin, ...(market || {}) })} · ${symbolOf(coin)}/KRW</p>
          <p class="cp-hero-value cp-num">${market ? `${price(market.price)}원` : '—'}</p>
          ${market ? html`<p class="cp-hero-change cp-num cp-${tone(market.change)}">${percent(market.change)} ${hasFiniteValue(market.changePrice) ? `(${signedWon(market.changePrice)})` : ''}</p>` : ''}
          <p class="cp-hero-sub">${market ? (issue ? issue : `최근 체결 ${marketTimestamp(market.sourceAsOf)}`) : s.marketPricesLoaded ? '이 시장의 시세가 없어요' : '시세를 불러오는 중이에요'}</p>
        </div>
      </div>
      ${market ? html`<div style="margin-top:14px">${statGrid([
        { label: '고가', value: `${price(market.high)}원` },
        { label: '저가', value: `${price(market.low)}원` },
        { label: '24시간 거래대금', value: `${compactWon(market.volumeKrw)}원` },
        { label: '시세 상태', value: issue ? '확인 필요' : '최신', tone: issue ? 'warn' : 'ok', mono: false }
      ])}</div>` : ''}
      <div class="cp-actions" style="margin-top:16px">
        ${linkButton({ label: '매수', href: `#/trade?coin=${encodeURIComponent(coin)}&side=buy`, variant: 'up' })}
        ${linkButton({ label: '매도', href: `#/trade?coin=${encodeURIComponent(coin)}&side=sell`, variant: 'down' })}
      </div>`
    }));
  }

  function renderChart() {
    const shown = getDisplayedCandles(candles.rows, view.range);
    const target = slot('chart');
    if (!target) return;
    render(target, card({
      index: 1,
      title: '가격',
      action: button({ label: '새로고침', size: 'sm', iconName: 'refresh', attrs: { 'data-action': 'reload-candles' } }),
      body: html`<div class="cp-row" style="margin-bottom:12px">${segmented({ name: 'unit', label: '캔들 간격', value: view.unit, options: INTERVALS })}${segmented({ name: 'range', label: '표시 구간', value: view.range, options: RANGES })}</div>
        ${candles.error ? notice({ tone: 'warning', body: shown.length ? '가격 자료를 새로 불러오지 못해 마지막 자료를 표시합니다.' : `가격 자료를 불러오지 못했어요: ${ctx.toUserText(candles.error.message)}` }) : ''}
        ${shown.length >= 2 ? candleChart(shown, { formatValue: value => price(value) }) : candles.loading ? skeleton({ lines: 5 }) : emptyState({ iconName: 'chart', title: '표시할 캔들이 없어요' })}
        ${shown.length ? html`<p class="cp-caption" style="margin-top:8px">${INTERVALS.find(item => item.value === view.unit)?.label} 캔들 ${shown.length}개 · 마지막 ${shown.at(-1)?.time ? shown.at(-1).time.replace('T', ' ').slice(0, 16) : ''}</p>` : ''}`
    }));
  }

  function renderPosition() {
    const s = ctx.session();
    const position = coinPositions(s.account).find(row => row.coin === coin) || null;
    render(slot('position'), card({
      index: 2,
      title: '내 보유',
      body: position ? html`${statGrid([
        { label: '평가액', value: won(position.currentValue) },
        { label: '평가손익', value: signedWon(position.profit), tone: tone(position.profit), sub: percent(position.profitPercent) },
        { label: '수량', value: quantity(position.amount) },
        { label: '평균 매수가', value: `${price(position.avgPrice || position.entryPrice)}원` }
      ], { columns: 2 })}<p class="cp-caption" style="margin-top:10px">${position.source === 'strategy' ? '자동매매 포지션' : position.source === 'exchange' ? '거래소 잔고 기준' : '직접 주문 포지션'}</p>`
        : emptyState({ iconName: 'coin', title: '보유하고 있지 않아요', body: `사용 가능 현금 ${won(s.account?.krwBalance)}` })
    }));
  }

  function renderIndicators() {
    const state = ctx.resource('coinDetail');
    const detail = state.data?.coin === coin ? state.data : null;
    render(slot('indicators'), card({
      index: 3,
      title: '지표',
      subtitle: '기술 지표 요약 · 참고용',
      body: detail?.indicators ? statGrid([
        { label: 'RSI', value: detail.indicators.rsi ?? '—', sub: Number(detail.indicators.rsi) <= 30 ? '과매도' : Number(detail.indicators.rsi) >= 70 ? '과매수' : '중립' },
        { label: 'MACD 히스토그램', value: detail.indicators.macd ?? '—', tone: tone(detail.indicators.macd) },
        { label: '볼린저 %B', value: detail.indicators.bb ?? '—' },
        { label: '최대 매수 가능', value: won(detail.maxBuyAmount) }
      ]) : state.status === 'loading' || state.data === null && state.status !== 'error' ? skeleton({ lines: 2 }) : emptyState({ title: '지표를 계산하지 못했어요', body: '시세 또는 캔들 자료가 부족할 수 있어요.' })
    }));
  }

  ctx.watch([ctx.res('prices')], renderHeader);
  ctx.watch([ctx.res('account')], renderPosition);
  ctx.watch([ctx.res('coinDetail')], renderIndicators);
  renderChart();
  loadCandles();
  ctx.resources.setParams('coinDetail', coin);

  ctx.on('click', '[data-segment="unit"]', (event, target) => {
    view.unit = Number(target.dataset.value);
    try { localStorage.setItem('coinpilot.candleUnit', String(view.unit)); } catch { /* ignore */ }
    loadCandles();
  });
  ctx.on('click', '[data-segment="range"]', (event, target) => {
    const next = Number(target.dataset.value);
    if (next !== view.range) { view.range = next; renderChart(); } // display range never refetches
  });
  ctx.on('click', '[data-action="reload-candles"]', () => loadCandles());
  const timer = setInterval(() => { if (!document.hidden) loadCandles(); }, 60_000);
  ctx.after(() => { clearInterval(timer); requestSequence += 1; });
}

export default {
  id: 'coins',
  resources: ['status', 'account', 'prices', 'targetCoins'],
  mount(root, ctx) {
    const coin = ctx.route.params[0];
    if (coin && /^[A-Z0-9]+-[A-Z0-9]+$/.test(coin)) mountDetail(root, ctx, coin);
    else mountList(root, ctx);
  }
};
