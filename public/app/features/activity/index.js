// 활동: unified fills/orders for coins, stocks and horizon portfolios with
// filters, the pending-request lock, per-coin statistics and the automation
// (start/stop/recovery) history.
import { html, render } from '../../core/dom.js';
import { signedWon, tone, dateTime, number } from '../../core/format.js';
import { card, list, emptyState, segmented, skeleton, notice, listRow, avatar, badge, icon, statGrid } from '../../ui/components.js';
import { recordRow } from '../../ui/patterns.js';
import { tradeRecordPresentation, engineTradePresentation, filterRecords } from '../../domain/records.js';
import { pendingMutationPresentation } from '../../core/mutations.js';
import { toUserText } from '../../domain/text.js';

const ASSETS = [{ value: 'all', label: '전체' }, { value: 'coin', label: '코인' }, { value: 'stock', label: '주식' }];
const SIDES = [{ value: 'all', label: '모든 거래' }, { value: 'buy', label: '매수' }, { value: 'sell', label: '매도' }, { value: 'bundle', label: '묶음' }];

export default {
  id: 'activity',
  resources: ['trades', 'stocks', 'horizons', 'statistics', 'automationHistory', 'status'],
  mount(root, ctx) {
    const filters = { asset: 'all', side: 'all', query: '' };
    render(root, html`<div class="cp-page">
      <div data-slot="pending"></div>
      <div class="cp-split">
        <div class="cp-stack">
          ${card({ index: 0, title: '체결 기록', body: html`
            <div class="cp-stack" style="margin-bottom:8px">
              <div class="cp-row">${segmented({ name: 'asset', label: '자산', value: 'all', options: ASSETS })}</div>
              <div class="cp-toolbar">
                <label class="cp-search"><span class="cp-visually-hidden">종목 검색</span>${icon('search', { size: 18 })}<input class="cp-input" type="search" data-input="query" placeholder="종목 검색 (비트코인, BTC, 005930)" autocomplete="off"></label>
                <select class="cp-input" data-input="side" aria-label="거래 유형">${SIDES.map(option => html`<option value="${option.value}">${option.label}</option>`)}</select>
              </div>
              <p class="cp-caption" data-slot="count"></p>
            </div>
            <div data-slot="records"></div>` })}
        </div>
        <div class="cp-stack">
          <div data-slot="stats"></div>
          <div data-slot="automation"></div>
        </div>
      </div>
    </div>`);
    const slot = name => root.querySelector(`[data-slot="${name}"]`);

    function allRecords() {
      const coin = (ctx.data('trades') || []).map(tradeRecordPresentation);
      const stocks = ctx.data('stocks');
      const horizons = ctx.data('horizons');
      const stock = ['paper', 'live'].flatMap(mode => (stocks?.[mode]?.recentTrades || []).map(trade => engineTradePresentation(trade, { asset: 'stock', engine: `주식 ${mode === 'live' ? '실전' : '모의'}` })));
      const horizon = [horizons?.coin, ...Object.values(horizons?.stock || {})].filter(Boolean).flatMap(status => (status.recentTrades || []).map(trade => engineTradePresentation(trade, {
        asset: status.assetClass,
        engine: `기간별 ${status.mode === 'live' ? '실전' : '모의'}`,
        sleeveLabel: status.sleeves?.[trade.sleeve]?.label
      })));
      return [...coin, ...stock, ...horizon];
    }

    function renderRecords() {
      const tradesState = ctx.resource('trades');
      const records = allRecords();
      const rows = filterRecords(records, filters);
      const count = slot('count');
      if (count) count.textContent = `${records.length}개 기록 중 ${rows.length}개 · 코인은 최근 50건`;
      if (tradesState.data === null && tradesState.status !== 'error') { render(slot('records'), skeleton({ lines: 6 })); return; }
      const filtered = filters.side !== 'all' || filters.asset !== 'all' || filters.query.trim();
      render(slot('records'), list(rows.slice(0, 120).map(recordRow), {
        empty: emptyState({ iconName: 'list', title: tradesState.status === 'error' && tradesState.data === null ? '거래 기록 불러오기 실패' : filtered ? '조건에 맞는 기록 없음' : '거래 기록 없음', body: '' })
      }));
    }

    function renderPending() {
      const s = ctx.session();
      const pending = pendingMutationPresentation(s.pending, { online: s.online });
      const intent = s.pending?.intent;
      render(slot('pending'), pending.visible ? card({
        index: 0,
        className: 'cp-pending',
        title: '대기 중인 요청',
        body: html`${notice({ tone: 'warning', title: pending.title, body: pending.copy })}
          ${intent ? html`<p class="cp-caption" style="margin-top:8px">${intent.endpoint} · ${dateTime(intent.createdAt)} 저장 · ${toUserText(intent.lastMessage || '')}</p>` : ''}`
      }) : '');
    }

    function renderStats() {
      const stats = ctx.data('statistics');
      const rows = Array.isArray(stats) ? stats.filter(item => number(item.totalTrades) > 0) : [];
      const total = rows.reduce((sum, item) => sum + number(item.totalProfit), 0);
      const trades = rows.reduce((sum, item) => sum + number(item.totalTrades), 0);
      const wins = rows.reduce((sum, item) => sum + number(item.winningTrades), 0);
      render(slot('stats'), card({
        index: 1,
        title: '코인 거래 통계',
        body: stats === null ? skeleton({ lines: 3 }) : html`${statGrid([
          { label: '실현 손익', value: signedWon(total), tone: tone(total) },
          { label: '청산', value: `${trades}회`, sub: trades ? `승률 ${((wins / trades) * 100).toFixed(1)}%` : null }
        ], { columns: 2 })}
        ${list(rows.sort((a, b) => number(b.totalProfit) - number(a.totalProfit)).slice(0, 10).map(item => listRow({
          leading: avatar(String(item.coin || '').replace(/^KRW-/, '')),
          title: String(item.coin || '').replace(/^KRW-/, ''),
          subtitle: `${item.totalTrades}회 · 승률 ${number(item.winRate).toFixed(1)}%`,
          value: signedWon(item.totalProfit),
          valueTone: tone(item.totalProfit)
        })))}`
      }));
    }

    function renderAutomation() {
      const history = ctx.data('automationHistory');
      const events = Array.isArray(history?.events) ? [...history.events].reverse().slice(0, 20) : [];
      render(slot('automation'), card({
        index: 2,
        title: '자동매매 기록',
        subtitle: '시작·정지·자동 복구 이력',
        body: history === null ? skeleton({ lines: 3 }) : history.available === false ? emptyState({ iconName: 'clock', title: '자동 복구 기록 없음' })
          : list(events.map(event => listRow({
            leading: avatar(event.desiredRunning === false || /stop/i.test(event.type || event.reason || '') ? '정지' : '시작', { tone: /fail|error|gap/i.test(event.type || event.reason || '') ? 'amber' : 'neutral' }),
            title: toUserText(event.label || event.type || event.reason || '상태 변경'),
            subtitle: [dateTime(event.at || event.timestamp || event.createdAt), toUserText(event.source || event.detail || '')].filter(Boolean).join(' · '),
            value: event.runtimeState ? badge(toUserText(event.runtimeState), 'neutral') : ''
          })), { empty: emptyState({ iconName: 'clock', title: '상태 변경 기록 없음' }) })
      }));
    }

    ctx.watch([ctx.res('trades'), ctx.res('stocks'), ctx.res('horizons')], renderRecords);
    ctx.watch(['mutation', 'online'], renderPending);
    ctx.watch([ctx.res('statistics')], renderStats);
    ctx.watch([ctx.res('automationHistory')], renderAutomation);
    ctx.on('click', '[data-segment="asset"]', (event, target) => {
      filters.asset = target.dataset.value;
      root.querySelectorAll('[data-segment="asset"]').forEach(button => button.setAttribute('aria-checked', String(button === target)));
      renderRecords();
    });
    ctx.on('change', '[data-input="side"]', (event, target) => { filters.side = target.value; renderRecords(); });
    ctx.on('input', '[data-input="query"]', (event, target) => { filters.query = target.value; renderRecords(); });
  }
};
