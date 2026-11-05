// 주식: paper / live stock traders (KRX via the securities Open API) —
// status, market session, holdings, statistics, signals, start/stop and paper reset.
import { html, render } from '../../core/dom.js';
import { won, signedWon, price, tone, relativeTime, dateTime, number } from '../../core/format.js';
import { card, heroValue, statGrid, list, listRow, avatar, badge, button, emptyState, notice, skeleton, segmented, engineStatus, liveBadge } from '../../ui/components.js';
import { recordRow } from '../../ui/patterns.js';
import { stockTraderSummary, stockPaperResetAllowed } from '../../domain/stocks.js';
import { engineTradePresentation } from '../../domain/records.js';
import { toUserText } from '../../domain/text.js';

export default {
  id: 'stocks',
  resources: ['stocks', 'status'],
  mount(root, ctx) {
    let mode = null;
    render(root, html`<div class="cp-page" data-slot="page"></div>`);
    const page = root.querySelector('[data-slot="page"]');

    function availableModes(stocks) {
      return ['paper', 'live'].filter(key => stocks?.[key]);
    }

    function renderPage() {
      const s = ctx.session();
      const state = ctx.resource('stocks');
      const stocks = state.data;
      if (!stocks) {
        render(page, state.status === 'error'
          ? card({ body: emptyState({ iconName: 'alert', title: '주식 상태 불러오기 실패', body: toUserText(state.error?.message || '') }) })
          : html`${card({ body: skeleton({ hero: true, lines: 2 }) })}${card({ body: skeleton({ lines: 4 }) })}`);
        return;
      }
      if (stocks.enabled === false) {
        render(page, card({ index: 0, body: emptyState({ iconName: 'chart', title: '주식 자동매매 꺼짐', body: '서버 설정 STOCK_TRADING_ENABLED 필요.' }) }));
        return;
      }
      const modes = availableModes(stocks);
      if (!mode || !modes.includes(mode)) mode = modes.includes(s.isLive ? 'live' : 'paper') ? (s.isLive ? 'live' : 'paper') : modes[0];
      const trader = stockTraderSummary(stocks[mode]);
      const live = mode === 'live';
      const notices = [];
      if (stocks.credentialsConfigured === false) notices.push(notice({ tone: 'warning', title: '증권 API 키 필요', body: '서버에 TOSS_CLIENT_ID/TOSS_CLIENT_SECRET 설정 필요.' }));
      if (stocks.universeError) notices.push(notice({ tone: 'warning', title: '종목 목록 갱신 실패', body: toUserText(stocks.universeError) }));
      if (trader?.lastError) notices.push(notice({ tone: 'danger', title: '최근 오류', body: toUserText(trader.lastError) }));
      if (trader?.pendingOrders > 0) notices.push(notice({ tone: 'warning', title: '확인되지 않은 주문', body: `${trader.pendingOrders}건의 체결 결과를 확인할 때까지 신규 진입을 잠갔습니다.` }));
      if (trader?.entriesPaused && trader.pauseReason === 'exchange_state_unverified') notices.push(notice({ tone: 'warning', title: '보유잔고 확인 필요', body: '증권 계좌 보유잔고를 확인하지 못해 신규 진입을 잠갔습니다.' }));

      const stats = trader?.statistics || {};
      const trades = (trader?.recentTrades || []).map(trade => engineTradePresentation(trade, { asset: 'stock', engine: live ? '실전' : '모의' }));
      const running = trader?.running === true;
      const controls = s.canMutate ? html`${running
        ? button({ label: '자동매매 정지', iconName: 'stop', attrs: { 'data-stock-action': 'stop' } })
        : button({ label: '자동매매 시작', variant: 'primary', iconName: 'play', attrs: { 'data-stock-action': 'start' }, disabled: stocks.credentialsConfigured === false })}
        ${!live ? button({ label: '모의 계좌 초기화', variant: 'secondary', attrs: { 'data-stock-action': 'reset' }, disabled: !stockPaperResetAllowed(trader), title: stockPaperResetAllowed(trader) ? undefined : '보유 종목 있음 · 초기화 불가' }) : ''}` : html`<p class="cp-caption">${s.mutationBlockedReason}</p>`;

      render(page, html`
        ${modes.length > 1 ? html`<div>${segmented({ name: 'stock-mode', label: '주식 작업공간', value: mode, options: modes.map(key => ({ value: key, label: key === 'live' ? '실전' : '모의' })) })}</div>` : ''}
        ${notices}
        <div class="cp-split">
          <div class="cp-stack">
            ${card({
              index: 0,
              tone: live ? 'live' : undefined,
              action: live ? liveBadge() : badge('모의투자', 'info'),
              body: html`${heroValue({ label: live ? '실전 주식 (평가액은 증권 계좌 기준)' : '모의 주식 총자산', value: trader?.totalAssets, key: `stock-${mode}`, change: live ? null : (trader?.totalAssets !== null && trader?.initialSeedMoney ? trader.totalAssets - trader.initialSeedMoney : null), changePercent: !live && trader?.initialSeedMoney ? ((trader.totalAssets / trader.initialSeedMoney) - 1) * 100 : null, sub: live ? '이 엔진이 연 포지션만 표시. 실전 계좌 평가액은 증권사 앱 기준.' : `시작 금액 ${won(trader?.initialSeedMoney)}` })}
                <div style="margin-top:14px">${statGrid([
                  { label: '현금', value: live ? '증권 계좌' : won(trader?.cash), mono: !live },
                  { label: '평가손익', value: signedWon(trader?.unrealizedProfit), tone: tone(trader?.unrealizedProfit) },
                  { label: '실현 손익', value: signedWon(stats.totalProfit), tone: tone(stats.totalProfit) },
                  { label: '승률', value: stats.totalTrades ? `${number(stats.winRate).toFixed(1)}%` : '—', sub: `청산 ${stats.totalTrades || 0}회` }
                ])}</div>`
            })}
            ${card({
              index: 2,
              title: '보유 종목',
              subtitle: `최대 ${trader?.maxPositions ?? '—'}종목 · 장 마감 전 전량 정리`,
              body: list((trader?.positions || []).map(position => listRow({
                leading: avatar(position.symbol?.slice(-3) || '주', { tone: 'green' }),
                title: position.symbol,
                subtitle: `${position.quantity}주 · 매수 ${price(position.entryPrice)}원 · ${relativeTime(position.entryTime)}`,
                value: position.lastPrice ? `${price(position.lastPrice)}원` : '시세 대기',
                valueSub: position.unrealizedProfit !== null && position.unrealizedProfit !== undefined ? signedWon(position.unrealizedProfit) : '',
                valueTone: tone(position.unrealizedProfit)
              })), { empty: emptyState({ iconName: 'chart', title: '보유 없음', body: '정규장 조건 매수, 마감 전 전량 정리.' }) })
            })}
            ${card({ index: 4, title: '최근 거래', body: list(trades.map(recordRow), { empty: emptyState({ iconName: 'list', title: '거래 기록 없음' }) }) })}
          </div>
          <div class="cp-stack">
            ${card({
              index: 1,
              title: '엔진',
              body: html`${engineStatus({
                name: `주식 ${live ? '실전' : '모의'} 트레이더`,
                running,
                tone: trader?.lastError ? 'warning' : running ? (trader.entriesPaused ? 'warning' : 'ok') : 'neutral',
                stateLabel: running ? (trader.entriesPaused ? '진입 잠금' : '실행 중') : '정지',
                detail: trader?.market?.label,
                meta: trader?.lastCycleAt ? `마지막 실행 ${relativeTime(trader.lastCycleAt)} · ${dateTime(trader.lastCycleAt)}` : '실행 기록 없음',
                live
              })}
              <div class="cp-actions" style="margin-top:8px">${controls}</div>`
            })}
            ${card({
              index: 3,
              title: '장 운영',
              body: html`${statGrid([
                { label: '상태', value: trader?.market?.label || '확인 전', mono: false, tone: trader?.market?.tone === 'ok' ? 'ok' : trader?.market?.tone === 'warning' ? 'warn' : undefined },
                { label: '신규 진입', value: trader?.market?.canEnter ? '가능' : '불가', mono: false },
                { label: '마감 정리', value: trader?.market?.mustFlatten ? '진행 중' : '대기', mono: false },
                { label: '감시 종목', value: `${(stocks.universe || []).length}개`, sub: stocks.universeUpdatedAt ? `${relativeTime(stocks.universeUpdatedAt)} 갱신` : null }
              ], { columns: 2 })}`
            })}
            ${card({
              index: 5,
              title: '최근 신호',
              body: list((trader?.recentSignals || []).map(signal => listRow({
                leading: avatar(signal.valid === false ? '보류' : '신호', { tone: signal.valid === false ? 'neutral' : 'red' }),
                title: signal.symbol || '—',
                subtitle: toUserText(signal.rejection || signal.reason || ''),
                value: relativeTime(signal.at)
              })), { empty: emptyState({ iconName: 'pulse', title: '최근 신호 없음' }) })
            })}
          </div>
        </div>`);
      ctx.enhance(page);
    }

    async function act(action) {
      const live = mode === 'live';
      if (action === 'start') {
        const ok = await ctx.confirm({ title: `주식 ${live ? '실전' : '모의'} 자동매매 시작`, message: live ? '실제 자금으로 시장가 주문을 냅니다. 시작 전에 증권 계좌 보유잔고와 장부를 대사합니다.' : '가상 자금으로 실시간 시세에 모의 체결합니다.', details: [['작업공간', live ? '실전' : '모의'], ['장 마감', '마감 전 전량 정리 (오버나이트 없음)']], confirmLabel: '시작', live });
        if (!ok) return;
        await ctx.control(api => api.control.startStock(mode), { success: '주식 자동매매를 시작했습니다.', failure: '주식 자동매매를 시작하지 못했습니다', refresh: ['stocks'] });
      } else if (action === 'stop') {
        const ok = await ctx.confirm({ title: `주식 ${live ? '실전' : '모의'} 자동매매 정지`, message: '신규 주문 중지. 보유 종목은 유지.', confirmLabel: '정지', tone: 'danger', live });
        if (!ok) return;
        await ctx.control(api => api.control.stopStock(mode), { success: '주식 자동매매를 정지했습니다.', failure: '주식 자동매매를 정지하지 못했습니다', refresh: ['stocks'] });
      } else if (action === 'reset') {
        const trader = stockTraderSummary(ctx.data('stocks')?.paper);
        const values = await ctx.ui.formSheet({
          title: '모의 주식 계좌 초기화',
          message: '가상 현금·거래 기록 삭제 후 입력 금액으로 재시작. 보유 종목 있으면 불가.',
          fields: [{ name: 'seedMoney', label: '시작 금액 (원)', type: 'number', value: trader?.initialSeedMoney || 10_000_000, min: 1000, step: 10000 }],
          confirmLabel: '초기화',
          tone: 'danger',
          validate: input => (Number(input.seedMoney) >= 1000 ? null : '시드머니는 1,000원 이상이어야 합니다.')
        });
        if (!values) return;
        const ok = await ctx.confirm({ title: '초기화', message: `모의 주식 계좌를 ${won(values.seedMoney)}으로 재시작. 되돌릴 수 없음.`, confirmLabel: '초기화', tone: 'danger' });
        if (!ok) return;
        await ctx.control(api => api.control.resetStockPaper(Math.floor(Number(values.seedMoney))), { success: '모의 주식 계좌를 초기화했습니다.', failure: '초기화하지 못했습니다', refresh: ['stocks'] });
      }
    }

    ctx.watch([ctx.res('stocks'), ctx.res('status'), 'auth', 'online'], renderPage);
    ctx.on('click', '[data-segment="stock-mode"]', (event, target) => { mode = target.dataset.value; renderPage(); });
    ctx.on('click', '[data-stock-action]', (event, target) => act(target.dataset.stockAction));
  }
};
