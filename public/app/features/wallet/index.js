// 모의 지갑: virtual-wallet deposit / withdraw / reset (DRY_RUN only) and a
// manual asset-snapshot record. Wallet changes use the same idempotent
// mutation client as orders: /virtual/deposit|withdraw {amount}, /virtual/reset {seedMoney}.
import { html, render } from '../../core/dom.js';
import { won, number, relativeTime } from '../../core/format.js';
import { card, heroValue, statGrid, button, emptyState, field, notice } from '../../ui/components.js';
import { lockedNotice } from '../../ui/patterns.js';

export default {
  id: 'wallet',
  resources: ['account', 'status', 'pnl', 'paper'],
  mount(root, ctx) {
    render(root, html`<div class="cp-page" data-slot="page"></div>`);
    const page = root.querySelector('[data-slot="page"]');

    function walletLock(s) {
      if (!s.canMutate) return s.mutationBlockedReason;
      if (!s.isPaper) return s.modeKnown ? '실거래 모드에서는 모의투자 지갑을 조작할 수 없습니다.' : '서버 거래 모드를 확인하고 있어요.';
      if (s.pendingLocked) return '처리 중인 요청 결과를 확인한 뒤 가상 지갑을 변경할 수 있습니다.';
      return null;
    }

    let layout = null;

    function renderLayout(kind) {
      layout = kind;
      if (kind === 'live') {
        render(page, card({ index: 0, body: emptyState({ iconName: 'wallet', title: '실전 작업공간이에요', body: '모의 지갑은 모의투자 서버에서만 사용할 수 있어요. 실전 계좌의 입출금은 거래소에서 해 주세요.' }) }));
        return;
      }
      render(page, html`
        <div data-slot="hero"></div>
        <div data-slot="lock"></div>
        <div class="cp-grid-2">
          ${card({ index: 1, title: '입금', body: html`<form class="cp-form" data-form="deposit">${field({ label: '금액 (원)', id: 'cp-deposit', input: html`<input class="cp-input cp-num" id="cp-deposit" name="amount" type="number" min="1000" step="1000" inputmode="numeric" placeholder="최소 1,000원">` })}
            <div class="cp-chips">${[100_000, 500_000, 1_000_000].map(value => html`<button type="button" class="cp-chip" data-fill="deposit" data-value="${value}">+${value / 10000}만</button>`)}</div>
            ${button({ label: '입금', variant: 'primary', type: 'submit', attrs: { 'data-wallet-control': '' } })}</form>` })}
          ${card({ index: 2, title: '출금', body: html`<form class="cp-form" data-form="withdraw">${field({ label: '금액 (원)', id: 'cp-withdraw', input: html`<input class="cp-input cp-num" id="cp-withdraw" name="amount" type="number" min="1000" step="1000" inputmode="numeric" placeholder="최소 1,000원">` })}
            <div class="cp-chips">${[100_000, 500_000].map(value => html`<button type="button" class="cp-chip" data-fill="withdraw" data-value="${value}">-${value / 10000}만</button>`)}</div>
            ${button({ label: '출금', type: 'submit', attrs: { 'data-wallet-control': '' } })}</form>` })}
        </div>
        ${card({ index: 3, title: '계좌 초기화', body: html`${notice({ tone: 'warning', body: '초기화하면 가상 잔액과 보유 코인, 전략별 포지션·매매 기록이 모두 사라져요.' })}
          <div class="cp-actions" style="margin-top:12px">${button({ label: '모의 계좌 초기화', variant: 'danger', attrs: { 'data-action': 'reset', 'data-wallet-control': '' } })}${button({ label: '현재 자산 기록', iconName: 'chart', attrs: { 'data-action': 'snapshot', 'data-mutate-control': '' } })}</div>` })}`);
    }

    function renderPage() {
      const s = ctx.session();
      const kind = s.isLive ? 'live' : 'paper';
      if (layout !== kind) renderLayout(kind);
      if (kind === 'live') return;
      const lock = walletLock(s);
      const pnl = ctx.data('pnl');
      render(page.querySelector('[data-slot="hero"]'), card({ index: 0, body: html`${heroValue({ label: '모의 계좌 현금', value: s.account?.krwBalance, key: 'wallet-cash', sub: `시작 금액 ${won(s.account?.initialSeedMoney)} · ${relativeTime(ctx.resource('account').lastSuccessAt)} 갱신` })}
          <div style="margin-top:14px">${statGrid([{ label: '총자산', value: won(s.account?.totalAssets), countup: { value: s.account?.totalAssets, key: 'wallet-total' } }, { label: '누적 손익', value: pnl?.valuationAvailable ? won(pnl.profit) : '—', countup: pnl?.valuationAvailable ? { value: pnl.profit, key: 'wallet-pnl' } : undefined }])}</div>` }));
      render(page.querySelector('[data-slot="lock"]'), lock ? lockedNotice(lock) : '');
      page.querySelectorAll('[data-wallet-control]').forEach(control => { control.disabled = Boolean(lock); });
      page.querySelectorAll('[data-mutate-control]').forEach(control => { control.disabled = !s.canMutate; });
      ctx.enhance(page.querySelector('[data-slot="hero"]'));
    }

    async function walletAction(kind, form) {
      const s = ctx.session();
      const lock = walletLock(s);
      if (lock) { ctx.ui.toast(lock, 'warning'); return; }
      const amount = number(new FormData(form).get('amount'));
      if (!amount || amount < 1000) { ctx.ui.toast('최소 1,000원 이상 입력해주세요.', 'warning'); return; }
      const ok = await ctx.confirm({ title: kind === 'deposit' ? '모의 계좌에 입금할까요?' : '모의 계좌에서 출금할까요?', details: [['금액', won(Math.floor(amount))], ['현재 현금', won(s.account?.krwBalance)]], confirmLabel: kind === 'deposit' ? '입금' : '출금' });
      if (!ok) return;
      const result = await ctx.mutate(`/virtual/${kind}`, { amount: Math.floor(amount) }, { label: '지갑 변경' });
      if (result.ok) form.reset();
    }

    async function resetWallet() {
      const s = ctx.session();
      const lock = walletLock(s);
      if (lock) { ctx.ui.toast(lock, 'warning'); return; }
      const values = await ctx.ui.formSheet({
        title: '모의 계좌 초기화',
        message: '모의 계좌를 얼마로 다시 시작할까요?',
        fields: [{ name: 'seedMoney', label: '시작 금액 (원)', type: 'number', value: s.account?.initialSeedMoney || 10_000_000, min: 100000, step: 100000 }],
        confirmLabel: '다음',
        validate: input => (Number(input.seedMoney) >= 100000 ? null : '시작 금액은 100,000원 이상이어야 합니다.')
      });
      if (!values) return;
      const seed = Math.floor(Number(values.seedMoney));
      const ok = await ctx.confirm({ title: `${won(seed)}으로 다시 시작할까요?`, message: '보유 코인과 전략별 포지션·매매 기록은 사라집니다. 되돌릴 수 없어요.', confirmLabel: '초기화', tone: 'danger' });
      if (!ok) return;
      await ctx.mutate('/virtual/reset', { seedMoney: seed }, { label: '초기화 요청' });
    }

    async function snapshot() {
      const result = await ctx.control(api => api.control.recordSnapshot().then(data => {
        if (data?.recorded !== true) throw new Error(ctx.toUserText(data?.error || '현재 자산 평가를 저장하지 못했습니다.'));
        return { success: true, message: '현재 자산 평가를 기록했습니다.' };
      }), { failure: '자산 기록을 저장하지 못했습니다', refresh: ['history'] });
      return result;
    }

    ctx.watch([ctx.res('account'), ctx.res('status'), ctx.res('pnl'), 'mutation', 'auth', 'online'], renderPage);
    ctx.on('submit', '[data-form]', (event, form) => { event.preventDefault(); walletAction(form.dataset.form, form); });
    ctx.on('click', '[data-fill]', (event, target) => { const input = root.querySelector(`[data-form="${target.dataset.fill}"] input[name="amount"]`); if (input) input.value = target.dataset.value; });
    ctx.on('click', '[data-action="reset"]', () => resetWallet());
    ctx.on('click', '[data-action="snapshot"]', () => snapshot());
  }
};
