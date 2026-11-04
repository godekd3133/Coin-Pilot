// 주문하기: manual market buy/sell, conditional (smart) buy/sell, rebalancing
// bundles and buy/sell review. Every order goes through the shared
// idempotent mutation client (ctx.mutate) after an explicit confirmation sheet;
// the request bodies match the server routes exactly:
//   /trade/buy {coin, amount}            /trade/sell {coin, quantity}
//   /trade/smart-buy {totalAmount, minScore, maxCoins}
//   /trade/smart-sell {targetAmount, strategy}
//   /trade/execute-bundle {sellCoin, buyCoin}
import { html, render } from '../../core/dom.js';
import { won, price, quantity, percent, symbolOf, number, hasFiniteValue } from '../../core/format.js';
import { card, button, field, notice, list, listRow, avatar, emptyState, skeleton, badge, attrs, icon, liveBadge } from '../../ui/components.js';
import { lockedNotice } from '../../ui/patterns.js';
import {
  MIN_ORDER_KRW, FEE_RATE, manualOrderGate, isCoreTradingSnapshotReady, marketQuoteFreshnessIssue,
  manualOrderCapacityPresentation, modeBannerPresentation, runtimeCanAcceptOrders, runtimeCanAcceptManualOrders, runtimeBlockReason
} from '../../domain/trading.js';
import { coinPositions } from '../../domain/portfolio.js';
import { marketDisplayName } from '../../domain/records.js';
import { recommendationLabel, signalText } from '../../domain/text.js';

const SMART_SELL_STRATEGIES = [
  { value: 'worst', label: '손실 큰 자산부터' },
  { value: 'best', label: '수익 큰 자산부터' },
  { value: 'overbought', label: 'RSI 과매수 자산부터' }
];

export default {
  id: 'trade',
  resources: ['status', 'account', 'prices', 'paper', 'investmentConfig'],
  mount(root, ctx) {
    const query = ctx.route.query || {};
    let selectedCoin = /^[A-Z0-9]+-[A-Z0-9]+$/.test(query.coin || '') ? query.coin : (localStorage.getItem('selectedCoin') || 'KRW-BTC');
    let side = query.side === 'sell' ? 'sell' : 'buy';
    let amount = 50_000;

    render(root, html`<div class="cp-page">
      <div data-slot="banner"></div>
      <div class="cp-split">
        <div class="cp-stack">
          <div data-slot="order"></div>
          <div data-slot="bundles"></div>
        </div>
        <div class="cp-stack">
          <div data-slot="smart"></div>
          <div data-slot="review"></div>
        </div>
      </div>
    </div>`);
    const slot = name => root.querySelector(`[data-slot="${name}"]`);

    function context(market) {
      const s = ctx.session();
      const coreReady = isCoreTradingSnapshotReady({ status: s.status, account: s.account, marketPrices: s.marketPricesLoaded ? s.marketPrices : null, selectedCoin });
      return {
        s,
        coreReady,
        gate: manualOrderGate({
          online: s.online, coreReady, status: s.status, mutationBlocked: !s.canMutate, mutationBlockedReason: s.mutationBlockedReason,
          evidenceLock: s.evidenceLock, pendingLocked: s.pendingLocked, market, freshnessOptions: s.freshnessOptions
        })
      };
    }

    function renderBanner() {
      const s = ctx.session();
      const coreReady = isCoreTradingSnapshotReady({ status: s.status, account: s.account, marketPrices: s.marketPricesLoaded ? s.marketPrices : null, selectedCoin });
      const presentation = modeBannerPresentation({
        paper: s.isPaper,
        modeKnown: s.modeKnown,
        liveReady: s.isLive && runtimeCanAcceptOrders(s.status),
        offline: !s.online,
        readOnly: !s.canMutate && s.online,
        protectiveOnly: s.status?.runtimeState === 'PROTECTIVE_ONLY',
        exchangeStateUnknown: s.status?.runtimeState === 'SYNC_REQUIRED' || s.status?.exchangeStateKnown === false,
        evidenceLocked: s.evidenceLock?.locked === true,
        corePending: !coreReady,
        runtimeBlocked: !runtimeCanAcceptOrders(s.status),
        manualOrdersAllowed: runtimeCanAcceptManualOrders(s.status, s.mode),
        runtimeReason: runtimeBlockReason(s.status),
        readOnlyReason: s.mutationBlockedReason,
        coreReadinessReason: '서버 모드와 계좌, 선택한 시장의 시세를 확인할 때까지 주문할 수 없습니다.',
        tradeReason: s.evidenceLock?.reason
      });
      render(slot('banner'), notice({ tone: presentation.tone, iconName: presentation.tone === 'danger' ? 'alert' : presentation.tone === 'info' ? 'unlock' : 'lock', title: presentation.title, body: presentation.copy }));
    }

    function renderOrder() {
      const s = ctx.session();
      const markets = s.marketPrices;
      const options = [...new Set([selectedCoin, ...markets.map(row => row.coin)])].filter(Boolean).slice(0, 150);
      const market = markets.find(row => row.coin === selectedCoin) || null;
      const position = coinPositions(s.account).find(row => row.coin === selectedCoin) || null;
      const { gate } = context(market);
      const quoteIssue = market ? marketQuoteFreshnessIssue(market, s.freshnessOptions) : '이 종목의 시세를 확인할 수 없어요.';
      const marketPrice = quoteIssue === null ? Number(market.price) : null;
      const holdingValue = hasFiniteValue(position?.currentValue) ? Number(position.currentValue) : null;
      const estQuantity = marketPrice ? amount / marketPrice : null;
      const blocked = !gate.allowed || amount <= 0 || (side === 'buy' && amount < MIN_ORDER_KRW) || (side === 'sell' && !(holdingValue > 0));
      const capacity = side === 'buy' ? `잔액 ${won(s.account?.krwBalance)}` : `보유 ${holdingValue !== null ? won(holdingValue) : position ? '평가액 미제공' : '없음'}`;
      const submitLabel = !s.modeKnown ? '거래 모드 확인 필요' : side === 'buy' ? (s.isLive ? '실제 매수 주문' : '모의 매수 주문') : (s.isLive ? '실제 매도 주문' : '모의 매도 주문');
      render(slot('order'), card({
        index: 1,
        title: '직접 주문',
        tone: s.isLive ? 'live' : undefined,
        action: s.isLive ? liveBadge() : badge('모의투자', 'info'),
        body: html`<div class="cp-form">
          <div class="cp-side-toggle" role="group" aria-label="주문 방향">
            <button type="button" data-side="buy" ${attrs({ 'aria-pressed': String(side === 'buy') })}>매수</button>
            <button type="button" data-side="sell" ${attrs({ 'aria-pressed': String(side === 'sell') })}>매도</button>
          </div>
          ${field({ label: '종목', hint: '시장가', id: 'cp-order-coin', input: html`<select class="cp-input" id="cp-order-coin" data-input="coin">${options.map(coin => html`<option value="${coin}" ${attrs({ selected: coin === selectedCoin })}>${marketDisplayName({ coin })} (${symbolOf(coin)})</option>`)}</select>` })}
          ${field({ label: side === 'buy' ? '주문 금액 (원)' : '매도할 금액 (원)', hint: capacity, id: 'cp-order-amount', input: html`<input class="cp-input cp-num" id="cp-order-amount" data-input="amount" type="number" inputmode="numeric" min="1000" step="1000" value="${amount || ''}">` })}
          <div class="cp-chips" role="group" aria-label="금액 빠른 선택">${[25, 50, 75, 100].map(pct => html`<button type="button" class="cp-chip" data-preset="${pct}">${pct === 100 ? '전액' : `${pct}%`}</button>`)}</div>
          <div class="cp-preview">
            <div><span>현재가</span><strong>${marketPrice ? `${price(marketPrice)}원` : '미제공'}</strong></div>
            <div><span>예상 수량</span><strong>${estQuantity !== null ? quantity(estQuantity) : '미제공'}</strong></div>
            <div><span>보유 평가</span><strong>${holdingValue !== null ? won(holdingValue) : position ? '평가액 미제공' : '보유 없음'}</strong></div>
            <div><span>예상 수수료 (0.05%)</span><strong>${amount ? won(amount * FEE_RATE) : '—'}</strong></div>
          </div>
          <p class="cp-lock-line">${icon(gate.allowed ? (s.isLive ? 'alert' : 'unlock') : 'lock', { size: 16 })}<span>${gate.allowed ? (s.isLive ? '실제 자금으로 체결됩니다. 체결 가격은 예상과 다를 수 있어요.' : '모의 체결로 기록되며 실제 자금은 사용되지 않아요.') : gate.reason}</span></p>
          ${button({ label: submitLabel, variant: side === 'buy' ? 'up' : 'down', size: 'block', attrs: { 'data-action': 'submit-order' }, disabled: blocked })}
        </div>`
      }));
    }

    function updatePreviewOnly() {
      // Re-render without losing the focused amount input.
      const input = root.querySelector('[data-input="amount"]');
      const caret = input === document.activeElement ? input.selectionStart : null;
      renderOrder();
      if (caret !== null) {
        const next = root.querySelector('[data-input="amount"]');
        next.focus();
        try { next.setSelectionRange(caret, caret); } catch { /* number inputs */ }
      }
    }

    function renderSmart() {
      const s = ctx.session();
      const coreReady = isCoreTradingSnapshotReady({ status: s.status, account: s.account, marketPrices: s.marketPricesLoaded ? s.marketPrices : null, selectedCoin });
      const capacity = manualOrderCapacityPresentation({ account: s.account, holdings: coinPositions(s.account), holdingsKnown: Array.isArray(s.account?.positions), coreReady });
      const { gate } = context(undefined);
      const existing = slot('smart').querySelector('[data-form="smart-buy"]');
      if (existing) {
        render(slot('smart').querySelector('[data-slot="smart-lock"]'), gate.allowed ? '' : lockedNotice(gate.reason));
        const buyHint = slot('smart').querySelector('label[for="cp-smart-buy-amount"] .cp-field-hint');
        const sellHint = slot('smart').querySelector('label[for="cp-smart-sell-amount"] .cp-field-hint');
        if (buyHint) buyHint.textContent = capacity.balanceLabel;
        if (sellHint) sellHint.textContent = capacity.holdingLabel;
        slot('smart').querySelectorAll('button[type="submit"]').forEach(control => { control.disabled = !gate.allowed; });
        return;
      }
      render(slot('smart'), card({
        index: 2,
        title: '조건 주문',
        subtitle: '거래대금 상위 시장에서 점수 순으로 분산 매수하거나, 정한 우선순위로 매도해요.',
        body: html`<div class="cp-stack">
          <div data-slot="smart-lock">${gate.allowed ? '' : lockedNotice(gate.reason)}</div>
          <form class="cp-form" data-form="smart-buy">
            <strong>조건 매수</strong>
            ${field({ label: '총 투자금액', hint: capacity.balanceLabel, id: 'cp-smart-buy-amount', input: html`<input class="cp-input cp-num" id="cp-smart-buy-amount" name="totalAmount" type="number" min="5000" step="1000" value="100000" inputmode="numeric">` })}
            <div class="cp-grid-2">
              ${field({ label: '최소 점수', id: 'cp-smart-buy-score', input: html`<input class="cp-input cp-num" id="cp-smart-buy-score" name="minScore" type="number" min="0" max="100" value="60">` })}
              ${field({ label: '최대 종목', id: 'cp-smart-buy-max', input: html`<input class="cp-input cp-num" id="cp-smart-buy-max" name="maxCoins" type="number" min="1" max="30" value="10">` })}
            </div>
            ${button({ label: '조건 매수 실행', variant: 'up', type: 'submit', disabled: !gate.allowed })}
          </form>
          <form class="cp-form" data-form="smart-sell">
            <strong>우선순위 매도</strong>
            ${field({ label: '목표 매도금액', hint: capacity.holdingLabel, id: 'cp-smart-sell-amount', input: html`<input class="cp-input cp-num" id="cp-smart-sell-amount" name="targetAmount" type="number" min="1000" step="1000" value="100000" inputmode="numeric">` })}
            ${field({ label: '매도 우선순위', id: 'cp-smart-sell-strategy', input: html`<select class="cp-input" id="cp-smart-sell-strategy" name="strategy">${SMART_SELL_STRATEGIES.map(option => html`<option value="${option.value}">${option.label}</option>`)}</select>` })}
            ${button({ label: '우선순위 매도 실행', variant: 'down', type: 'submit', disabled: !gate.allowed })}
          </form>
        </div>`
      }));
    }

    function renderBundles() {
      const state = ctx.resource('bundles');
      const { gate } = context(undefined);
      const bundles = state.data?.bundles || [];
      render(slot('bundles'), card({
        index: 3,
        title: '리밸런싱 제안',
        subtitle: '매도 신호가 있는 보유 코인과 매수 신호가 있는 코인을 묶어 제안해요.',
        action: button({ label: state.status === 'loading' ? '분석 중…' : '제안 받기', size: 'sm', iconName: 'refresh', attrs: { 'data-action': 'load-bundles' }, disabled: state.status === 'loading' }),
        body: state.status === 'idle' ? emptyState({ iconName: 'swap', title: '제안을 받아 보세요', body: '보유 코인과 시장 신호를 분석합니다. 주문은 직접 확인한 뒤에만 실행돼요.' })
          : state.status === 'loading' && !state.data ? skeleton({ lines: 3 })
            : state.status === 'error' && !state.data ? emptyState({ iconName: 'alert', title: '제안을 불러오지 못했어요', body: ctx.toUserText(state.error?.message || '') })
              : list(bundles.slice(0, 5).map((bundle, index) => html`<div class="cp-list-row">
                  <span class="cp-row-main"><span class="cp-row-title">${bundle.summary || `${symbolOf(bundle.sell?.coin)} → ${symbolOf(bundle.buy?.coin)}`}</span>
                  <span class="cp-row-sub">${ctx.toUserText(bundle.rationale || '')} · 점수 ${bundle.totalScore ?? '—'} · 매도 ${won(bundle.sell?.value)}</span></span>
                  ${button({ label: '실행', size: 'sm', variant: 'primary', disabled: !gate.allowed, attrs: { 'data-bundle': index } })}
                </div>`), { empty: emptyState({ iconName: 'check', title: '지금은 제안이 없어요', body: ctx.toUserText(state.data?.note || '') }) })
      }));
    }

    function renderReview() {
      const state = ctx.resource('recommendations');
      const data = state.data;
      const rows = (items, which) => (items || []).slice(0, 8).map(item => listRow({
        leading: avatar(item.symbol || symbolOf(item.coin), { tone: which === 'buy' ? 'red' : 'blue' }),
        title: recommendationLabel(item.recommendation, which),
        subtitle: (item.signals || []).map(signalText).join(' · ') || item.investmentNote || item.sellNote || '추가 판단 필요',
        value: which === 'buy' ? won(item.suggestedInvestment) : won(item.suggestedSellValue),
        href: `#/trade?coin=${encodeURIComponent(item.coin)}&side=${which}`
      }));
      render(slot('review'), card({
        index: 4,
        title: '매수·매도 검토',
        action: button({ label: state.status === 'loading' ? '분석 중…' : '분석', size: 'sm', iconName: 'refresh', attrs: { 'data-action': 'load-review' }, disabled: state.status === 'loading' }),
        body: state.status === 'idle' ? emptyState({ iconName: 'pulse', title: '검토 결과를 받아 보세요', body: '거래대금이 많은 시장과 보유 포지션을 분석해요. 결과는 참고용이며 주문은 직접 실행해요.' })
          : !data ? (state.status === 'error' ? emptyState({ iconName: 'alert', title: '검토 결과를 불러오지 못했어요', body: ctx.toUserText(state.error?.message || '') }) : skeleton({ lines: 4 }))
            : html`<p class="cp-section-title" style="margin-bottom:4px">매수 검토</p>${list(rows(data.buyRecommendations, 'buy'), { empty: html`<p class="cp-caption">매수 조건에 맞는 종목이 없습니다.</p>` })}
              <p class="cp-section-title" style="margin:12px 0 4px">매도 검토</p>${list(rows(data.sellRecommendations, 'sell'), { empty: html`<p class="cp-caption">매도할 자산이 없습니다.</p>` })}`
      }));
    }

    async function submitOrder() {
      const s = ctx.session();
      const market = s.marketPrices.find(row => row.coin === selectedCoin) || null;
      const position = coinPositions(s.account).find(row => row.coin === selectedCoin) || null;
      const { gate } = context(market);
      if (!gate.allowed) { ctx.ui.toast(gate.reason, 'warning'); return; }
      if (!selectedCoin || amount <= 0) { ctx.ui.toast('자산과 주문 금액을 확인해주세요.', 'warning'); return; }
      if (side === 'buy' && amount < MIN_ORDER_KRW) { ctx.ui.toast('최소 매수 금액은 5,000원입니다.', 'warning'); return; }
      const unitPrice = Number(market?.price) > 0 ? Number(market.price) : number(position?.currentPrice);
      const sellQuantity = unitPrice > 0 ? amount / unitPrice : 0;
      if (side === 'sell' && !(sellQuantity > 0)) { ctx.ui.toast('매도할 수량을 계산할 수 없습니다.', 'warning'); return; }
      const actionText = side === 'buy' ? '매수' : '매도';
      const confirmed = await ctx.confirm({
        title: `${symbolOf(selectedCoin)} ${actionText}를 실행할까요?`,
        message: side === 'buy' ? `${won(amount)} 시장가 매수 주문입니다.` : `${quantity(sellQuantity)} ${symbolOf(selectedCoin)} 시장가 매도 주문입니다.`,
        details: [
          ['작업공간', s.isLive ? '실전 (실제 자금)' : '모의투자'],
          ['종목', `${marketDisplayName({ coin: selectedCoin })} (${symbolOf(selectedCoin)})`],
          ['현재가', `${price(unitPrice)}원`],
          side === 'buy' ? ['주문 금액', won(amount)] : ['매도 수량', quantity(sellQuantity)],
          ['예상 수수료', won(amount * FEE_RATE)]
        ],
        confirmLabel: `${s.isLive ? '실제 ' : ''}${actionText} 실행`,
        live: s.isLive
      });
      if (!confirmed) { ctx.ui.toast(`${symbolOf(selectedCoin)} ${actionText}를 취소했습니다`, 'info'); return; }
      const endpoint = side === 'buy' ? '/trade/buy' : '/trade/sell';
      const body = side === 'buy' ? { coin: selectedCoin, amount: Math.floor(amount) } : { coin: selectedCoin, quantity: sellQuantity };
      await ctx.mutate(endpoint, body, { label: `${actionText} 요청`, snapshot: true });
    }

    async function submitSmart(kind, form) {
      const s = ctx.session();
      const { gate } = context(undefined);
      if (!gate.allowed) { ctx.ui.toast(gate.reason, 'warning'); return; }
      const values = Object.fromEntries(new FormData(form).entries());
      const buy = kind === 'buy';
      const value = number(buy ? values.totalAmount : values.targetAmount);
      if (!value || value < (buy ? 5000 : 1000)) { ctx.ui.toast(`최소 ${won(buy ? 5000 : 1000)} 이상 입력해주세요.`, 'warning'); return; }
      const strategyLabel = SMART_SELL_STRATEGIES.find(option => option.value === values.strategy)?.label;
      const confirmed = await ctx.confirm({
        title: buy ? '조건 매수를 실행할까요?' : '우선순위 매도를 실행할까요?',
        message: buy ? `상위 마켓에 ${won(value)}을 분산 매수합니다.` : `보유 자산에서 ${won(value)}을 목표로 매도합니다.`,
        details: buy
          ? [['작업공간', s.isLive ? '실전 (실제 자금)' : '모의투자'], ['최소 점수', values.minScore], ['최대 종목', `${values.maxCoins}개`]]
          : [['작업공간', s.isLive ? '실전 (실제 자금)' : '모의투자'], ['우선순위', strategyLabel || values.strategy]],
        confirmLabel: '실행',
        live: s.isLive
      });
      if (!confirmed) { ctx.ui.toast('조건 주문을 취소했습니다', 'info'); return; }
      const body = buy
        ? { totalAmount: Math.floor(value), minScore: number(values.minScore, 60), maxCoins: number(values.maxCoins, 10) }
        : { targetAmount: Math.floor(value), strategy: values.strategy || 'worst' };
      await ctx.mutate(buy ? '/trade/smart-buy' : '/trade/smart-sell', body, { label: '조건 주문', snapshot: true });
    }

    async function executeBundle(index) {
      const bundle = ctx.resource('bundles').data?.bundles?.[index];
      if (!bundle) return;
      const s = ctx.session();
      const { gate } = context(undefined);
      if (!gate.allowed) { ctx.ui.toast(gate.reason, 'warning'); return; }
      const confirmed = await ctx.confirm({
        title: `${symbolOf(bundle.sell?.coin)} 매도 → ${symbolOf(bundle.buy?.coin)} 매수`,
        message: '보유 코인을 매도한 뒤 그 금액으로 다른 코인을 매수합니다.',
        details: [['작업공간', s.isLive ? '실전 (실제 자금)' : '모의투자'], ['매도 예상 금액', won(bundle.sell?.value)], ['매수 예상 금액', won(bundle.buy?.suggestedAmount)], ['평가 손익률', percent(bundle.sell?.profitPercent)]],
        confirmLabel: '묶음 주문 실행',
        live: s.isLive
      });
      if (!confirmed) { ctx.ui.toast('묶음 주문을 취소했습니다', 'info'); return; }
      const result = await ctx.mutate('/trade/execute-bundle', { sellCoin: bundle.sell?.coin, buyCoin: bundle.buy?.coin }, { label: '묶음 주문', snapshot: true });
      if (result.ok) ctx.resources.refresh('bundles');
    }

    ctx.use(['bundles', 'recommendations']);
    ctx.watch([ctx.res('status'), ctx.res('account'), ctx.res('prices'), 'mutation', 'auth', 'online', ctx.res('paper'), ctx.res('investmentConfig')], () => {
      renderBanner();
      updatePreviewOnly();
      renderSmart();
      renderBundles();
    });
    ctx.watch([ctx.res('bundles')], renderBundles);
    ctx.watch([ctx.res('recommendations')], renderReview);

    ctx.on('click', '[data-side]', (event, target) => { side = target.dataset.side; renderOrder(); });
    ctx.on('change', '[data-input="coin"]', (event, target) => {
      selectedCoin = target.value;
      try { localStorage.setItem('selectedCoin', selectedCoin); } catch { /* ignore */ }
      renderOrder();
    });
    ctx.on('input', '[data-input="amount"]', (event, target) => { amount = number(target.value); updatePreviewOnly(); });
    ctx.on('click', '[data-preset]', (event, target) => {
      const s = ctx.session();
      const position = coinPositions(s.account).find(row => row.coin === selectedCoin);
      const max = side === 'buy' ? number(s.account?.krwBalance) : number(position?.currentValue);
      amount = Math.floor(max * (number(target.dataset.preset) / 100));
      renderOrder();
    });
    ctx.on('click', '[data-action="submit-order"]', () => submitOrder());
    ctx.on('submit', '[data-form="smart-buy"]', (event, form) => { event.preventDefault(); submitSmart('buy', form); });
    ctx.on('submit', '[data-form="smart-sell"]', (event, form) => { event.preventDefault(); submitSmart('sell', form); });
    ctx.on('click', '[data-action="load-bundles"]', () => ctx.resources.refresh('bundles'));
    ctx.on('click', '[data-action="load-review"]', () => ctx.resources.refresh('recommendations'));
    ctx.on('click', '[data-bundle]', (event, target) => executeBundle(Number(target.dataset.bundle)));
  }
};
