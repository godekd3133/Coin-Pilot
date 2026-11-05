// 홈: total assets across engines, today's P&L, composition, engine status,
// recent fills and attention items.
import { html, render } from '../../core/dom.js';
import { won, signedWon, percent, tone, relativeTime, compactWon } from '../../core/format.js';
import { card, heroValue, statGrid, allocationBar, areaChart, notice, linkButton, list, engineStatus, segmented, skeleton, emptyState } from '../../ui/components.js';
import { scalperEngine, confirmScalper, recordRow, resourceView } from '../../ui/patterns.js';
import { combinedAssets, workspaceAssetParts, hasUsableHistoryTrend, coinPositions } from '../../domain/portfolio.js';
import { tradeRecordPresentation, engineTradePresentation, filterRecords } from '../../domain/records.js';
import { stockTraderSummary } from '../../domain/stocks.js';
import { horizonRuntimeSummary } from '../../domain/horizons.js';
import { marketSnapshotPresentation } from '../../domain/trading.js';
import { classifyReadiness } from '../../domain/readiness.js';

const PERIODS = [{ value: '24h', label: '1일' }, { value: '7d', label: '1주' }, { value: '30d', label: '1달' }];

function attentionItems(ctx, s) {
  const items = [];
  const paper = ctx.data('paper');
  const readiness = ctx.data('readiness');
  if (s.pendingLocked) items.push(notice({ tone: 'warning', title: '이전 요청의 결과를 확인해 주세요', body: '주문이 처리됐을 수 있어요. 위의 안내에서 같은 요청 결과를 확인한 뒤 다음 주문을 진행해 주세요.' }));
  if (s.marketPricesLoaded) {
    const market = marketSnapshotPresentation(s.marketSnapshot, true, s.marketPrices, s.freshnessOptions);
    if (market.state !== 'complete') items.push(notice({ tone: 'warning', title: '시세 확인 필요', body: market.detail, action: linkButton({ label: '시세 보기', href: '#/coins' }) }));
  }
  if (paper?.orphaned || paper?.analysisDataHealth?.failClosed || paper?.riskMonitor?.failClosed || paper?.continuityEligible === false) {
    items.push(notice({ tone: 'danger', title: '모의투자가 안전을 위해 중단됐어요', body: '시세나 분석 자료 공백이 있어 기록을 유효한 근거에서 제외했습니다. 실행 상태를 확인하세요.', action: linkButton({ label: '확인', href: '#/research' }) }));
  }
  if (s.isLive && readiness) {
    const verdict = classifyReadiness(readiness);
    if (!verdict.ready && !verdict.optional) items.push(notice({ tone: verdict.tone === 'danger' ? 'danger' : 'warning', title: `실전 점검 ${verdict.stateLabel}`, body: verdict.reasons.join(' ') || verdict.headline, action: linkButton({ label: '점검 보기', href: '#/research' }) }));
  }
  const stocks = ctx.data('stocks');
  const stockTrader = stocks?.enabled ? stockTraderSummary(stocks[s.isLive ? 'live' : 'paper']) : null;
  if (stockTrader?.lastError) items.push(notice({ tone: 'warning', title: '주식 엔진 오류', body: ctx.toUserText(stockTrader.lastError), action: linkButton({ label: '주식', href: '#/stocks' }) }));
  if (stocks?.enabled && stocks.credentialsConfigured === false) items.push(notice({ tone: 'neutral', title: '증권 API 키가 없어요', body: '주식 자동매매를 시작하려면 서버에 증권사 API 키를 설정해야 합니다.' }));
  const horizons = ctx.data('horizons');
  for (const status of [horizons?.coin, ...Object.values(horizons?.stock || {})].filter(Boolean)) {
    const summary = horizonRuntimeSummary(status);
    if (summary.lastError) items.push(notice({ tone: 'warning', title: `기간별 ${status.assetClass === 'coin' ? '코인' : '주식'} 포트폴리오 오류`, body: ctx.toUserText(summary.lastError), action: linkButton({ label: '확인', href: '#/portfolios' }) }));
    if (summary.pendingOrders > 0) items.push(notice({ tone: 'warning', title: '확인되지 않은 포트폴리오 주문', body: `${summary.pendingOrders}건의 주문 결과를 확인하는 동안 신규 진입을 잠갔습니다.` }));
  }
  return items;
}

export default {
  id: 'home',
  resources: ['status', 'account', 'pnl', 'today', 'history', 'trades', 'stocks', 'horizons', 'paper', 'prices', 'readiness'],
  mount(root, ctx) {
    let period = ctx.resources.getParams('history') || '24h';
    if (ctx.session().readOnlyScope && !PERIODS.some(item => item.value === period)) period = '24h';

    render(root, html`<div class="cp-page">
      <div data-slot="hero"></div>
      <div data-slot="attention" class="cp-stack"></div>
      <div class="cp-split">
        <div class="cp-stack">
          <div data-slot="chart"></div>
          <div data-slot="recent"></div>
        </div>
        <div class="cp-stack">
          <div data-slot="engines"></div>
          <div data-slot="today"></div>
        </div>
      </div>
    </div>`);
    const slot = name => root.querySelector(`[data-slot="${name}"]`);

    function renderHero() {
      const s = ctx.session();
      const accountState = ctx.resource('account');
      if (accountState.data === null && accountState.status !== 'error') { render(slot('hero'), card({ index: 0, body: skeleton({ hero: true, lines: 2 }) })); return; }
      const parts = workspaceAssetParts({ mode: s.mode, account: s.account, stocks: ctx.data('stocks'), horizons: ctx.data('horizons') });
      const combined = combinedAssets(parts);
      const pnl = ctx.data('pnl');
      const coinPositionCount = coinPositions(s.account).length;
      const heroLabel = parts.length > 1 ? '총자산 (코인·주식·포트폴리오)' : '총자산';
      const sub = combined.partial
        ? `${combined.missing.join(', ')} 평가액을 확인할 수 없어 확인된 금액만 표시해요`
        : s.account?.valuationStatus === 'stale' ? '일부 시세가 오래돼 평가액을 확정하지 않았어요' : `${s.isLive ? '실전 계좌' : '모의투자'} · ${relativeTime(accountState.lastSuccessAt)} 갱신`;
      render(slot('hero'), card({
        index: 0,
        tone: s.isLive ? 'live' : undefined,
        body: html`
          ${heroValue({ label: heroLabel, value: combined.total ?? combined.knownTotal, key: 'home-total', change: pnl?.valuationAvailable ? pnl.profit : null, changePercent: pnl?.valuationAvailable ? pnl.profitPercent : null, sub })}
          ${pnl?.valuationAvailable ? html`<p class="cp-caption" style="margin-top:6px">코인 누적 손익 · 시작 금액 ${won(pnl.initialSeedMoney)} 대비</p>` : ''}
          <div style="margin-top:16px">${allocationBar(combined.parts.filter(part => part.value !== null).map(part => ({ label: part.label, value: part.value })), { label: '엔진별 자산 구성' })}</div>
          ${parts.length > 1 ? html`<div style="margin-top:14px">${statGrid(combined.parts.map(part => ({ label: part.label, value: part.value === null ? '확인 불가' : compactWon(part.value) + '원', sub: part.note || null })))}</div>` : html`<div style="margin-top:14px">${statGrid([
            { label: '보유 현금', value: won(s.account?.krwBalance), countup: { value: s.account?.krwBalance, key: 'home-cash' } },
            { label: '보유 코인', value: `${coinPositionCount}개` }
          ])}</div>`}`
      }));
      ctx.enhance(slot('hero'));
    }

    function renderChart() {
      const state = ctx.resource('history');
      const points = (state.data?.data || []).map(point => ({ t: point.timestamp, v: Number(point.totalAssets) }));
      const segments = segmented({ name: 'period', label: '기간', value: period, options: PERIODS });
      render(slot('chart'), card({
        index: 1,
        title: '코인 자산 추이',
        action: segments,
        body: resourceView(state, () => hasUsableHistoryTrend(state.data?.data)
          ? areaChart(points, { formatValue: value => compactWon(value) })
          : emptyState({ iconName: 'chart', title: '자산 기록이 아직 적어요', body: '자산 평가가 두 번 이상 기록되면 흐름을 보여드려요.' }), { lines: 4 })
      }));
    }

    function renderEngines() {
      const s = ctx.session();
      const stocks = ctx.data('stocks');
      const horizons = ctx.data('horizons');
      const stockMode = s.isLive ? 'live' : 'paper';
      const stockTrader = stocks?.enabled ? stockTraderSummary(stocks[stockMode]) : null;
      const rows = [scalperEngine(s)];
      if (stocks) {
        rows.push(stocks.enabled
          ? engineStatus({
            name: `주식 ${stockMode === 'live' ? '실전' : '모의'} 트레이더`,
            running: stockTrader?.running,
            tone: stockTrader?.lastError ? 'warning' : stockTrader?.running ? 'ok' : 'neutral',
            detail: stockTrader ? `${stockTrader.market.label} · 보유 ${stockTrader.positions.length}종목` : '트레이더가 비활성화되어 있어요.',
            meta: stockTrader?.lastCycleAt ? `마지막 실행 ${relativeTime(stockTrader.lastCycleAt)}` : null,
            live: stockMode === 'live',
            actions: linkButton({ label: '주식 보기', href: '#/stocks' })
          })
          : engineStatus({ name: '주식 트레이더', stateLabel: '꺼짐', detail: '서버에서 주식 자동매매가 비활성화되어 있어요.' }));
      }
      const horizonList = [horizons?.coin, horizons?.stock?.[stockMode]].filter(Boolean);
      for (const status of horizonList) {
        const summary = horizonRuntimeSummary(status);
        rows.push(engineStatus({
          name: `기간별 ${status.assetClass === 'coin' ? '코인' : '주식'} 포트폴리오`,
          running: summary.running,
          tone: summary.lastError ? 'warning' : summary.entriesPaused ? 'warning' : summary.running ? 'ok' : 'neutral',
          stateLabel: summary.running ? (summary.entriesPaused ? '진입 잠금' : '실행 중') : '정지',
          detail: `검증 통과 슬리브 ${summary.validatedCount}/${summary.sleeves.length} · 보유 ${summary.positions.length}`,
          meta: summary.lastCycleAt ? `마지막 분석 ${relativeTime(summary.lastCycleAt)}` : null,
          live: summary.mode === 'live',
          actions: linkButton({ label: '포트폴리오', href: '#/portfolios' })
        }));
      }
      render(slot('engines'), card({ index: 2, title: '엔진 상태', body: html`${rows}` }));
    }

    function renderToday() {
      const today = ctx.data('today');
      const pnl = ctx.data('pnl');
      render(slot('today'), card({
        index: 3,
        title: '오늘',
        body: resourceView(ctx.resource('today'), () => statGrid([
          { label: '실현 손익', value: signedWon(today.realizedProfit), tone: tone(today.realizedProfit), countup: { value: today.realizedProfit, key: 'home-today-profit', format: 'signedWon' } },
          { label: '거래', value: `${today.totalTrades ?? 0}건` },
          { label: '매수 금액', value: won(today.totalBuyAmount), countup: { value: today.totalBuyAmount, key: 'home-today-buy' } },
          { label: '매도 금액', value: won(today.totalSellAmount), countup: { value: today.totalSellAmount, key: 'home-today-sell' } },
          pnl?.valuationAvailable ? { label: '누적 수익률', value: percent(pnl.profitPercent), tone: tone(pnl.profitPercent), countup: { value: pnl.profitPercent, key: 'home-pnl-percent', format: 'percent' } } : null
        ].filter(Boolean), { columns: 2 }), { lines: 2 })
      }));
    }

    function renderRecent() {
      const s = ctx.session();
      const trades = (ctx.data('trades') || []).map(tradeRecordPresentation);
      const stocks = ctx.data('stocks');
      const horizons = ctx.data('horizons');
      const stockMode = s.isLive ? 'live' : 'paper';
      const stockTrades = (stocks?.[stockMode]?.recentTrades || []).map(trade => engineTradePresentation(trade, { asset: 'stock', engine: '주식 트레이더' }));
      const horizonTrades = [horizons?.coin, horizons?.stock?.[stockMode]].filter(Boolean).flatMap(status => (status.recentTrades || []).map(trade => engineTradePresentation(trade, { asset: status.assetClass, engine: '기간별 포트폴리오', sleeveLabel: status.sleeves?.[trade.sleeve]?.label })));
      const merged = filterRecords([...trades, ...stockTrades, ...horizonTrades]).slice(0, 5);
      const tradesState = ctx.resource('trades');
      render(slot('recent'), card({
        index: 4,
        title: '최근 체결',
        action: linkButton({ label: '전체 보기', href: '#/activity', variant: 'ghost' }),
        body: tradesState.data === null && tradesState.status !== 'error' ? skeleton({ lines: 3 })
          : list(merged.map(recordRow), { empty: emptyState({ iconName: 'list', title: '아직 체결이 없어요', body: '조건에 맞는 거래가 생기면 여기에 표시돼요.' }) })
      }));
    }

    function renderAttention() {
      render(slot('attention'), attentionItems(ctx, ctx.session()));
    }

    ctx.watch([ctx.res('account'), ctx.res('pnl'), ctx.res('stocks'), ctx.res('horizons'), ctx.res('status')], renderHero);
    ctx.watch([ctx.res('history')], renderChart);
    ctx.watch([ctx.res('status'), ctx.res('stocks'), ctx.res('horizons'), 'auth', 'online', ctx.res('paper')], renderEngines);
    ctx.watch([ctx.res('today'), ctx.res('pnl')], renderToday);
    ctx.watch([ctx.res('trades'), ctx.res('stocks'), ctx.res('horizons')], renderRecent);
    ctx.watch([ctx.res('paper'), ctx.res('readiness'), ctx.res('prices'), ctx.res('stocks'), ctx.res('horizons'), 'mutation', ctx.res('status')], renderAttention);

    ctx.on('click', '[data-segment="period"]', (event, target) => {
      period = target.dataset.value;
      ctx.resources.setParams('history', period);
      renderChart();
    });
    ctx.on('click', '[data-engine="scalper"]', (event, target) => confirmScalper(ctx, target.dataset.engineAction));
    return null;
  }
};
