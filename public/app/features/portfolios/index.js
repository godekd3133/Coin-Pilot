// 포트폴리오: chart-analysis horizon sleeves for coins and stocks. Sleeves are
// rendered from the server response (status.sleeves + research.sleeves), so a
// new server profile shows up without a client change.
import { html, render } from '../../core/dom.js';
import { won, signedWon, percent, ratio, tone, relativeTime, fullDateTime, price, quantity, symbolOf } from '../../core/format.js';
import { card, heroValue, badge, button, emptyState, notice, skeleton, list, listRow, avatar, liveBadge, engineStatus, disclosure } from '../../ui/components.js';
import { recordRow } from '../../ui/patterns.js';
import { horizonRuntimes, horizonRuntimeSummary } from '../../domain/horizons.js';
import { engineTradePresentation } from '../../domain/records.js';
import { toUserText } from '../../domain/text.js';

const REGIME_LABELS = { uptrend: '상승 추세', downtrend: '하락 추세', sideways: '횡보', bullish: '상승', bearish: '하락', neutral: '중립' };
const INTERVAL_LABELS = { '60m': '1시간봉', '240m': '4시간봉', '1d': '일봉', '1w': '주봉', day: '일봉', week: '주봉', minute60: '1시간봉', minute240: '4시간봉' };

function sleeveCard(sleeve, summary) {
  const verdict = sleeve.verdict;
  const verdictBadge = verdict ? badge(verdict.passed ? '검증 통과' : '검증 실패', verdict.passed ? 'ok' : 'danger') : badge('검증 전', 'warning');
  return html`<article class="cp-sleeve">
    <div class="cp-sleeve-head"><strong>${sleeve.label}</strong>${verdictBadge}${sleeve.enabled ? badge('운용', 'info') : badge('비중 0', 'neutral')}</div>
    <div>
      <div class="cp-row-between cp-caption"><span>목표 비중</span><b class="cp-num">${sleeve.weight === null ? '—' : ratio(sleeve.weight)}</b></div>
      <div class="cp-weight" role="img" aria-label="목표 비중 ${sleeve.weight ?? 0}%"><span style="width:${Math.max(0, Math.min(100, sleeve.weight || 0))}%"></span></div>
    </div>
    <dl class="cp-mini-kv">
      <dt>표본 외 수익</dt><dd class="${verdict ? `cp-${tone(verdict.outOfSampleReturnPercent)}` : ''}">${verdict ? percent(verdict.outOfSampleReturnPercent) : '—'}</dd>
      <dt>최악 낙폭</dt><dd>${verdict && verdict.worstDrawdownPercent !== null ? `${Number(verdict.worstDrawdownPercent).toFixed(1)}%` : '—'}</dd>
      <dt>검증 거래</dt><dd>${verdict?.trades ?? '—'}</dd>
      <dt>보유</dt><dd>${sleeve.positionCount}</dd>
      <dt>실현 손익</dt><dd class="cp-${tone(sleeve.realizedProfit)}">${signedWon(sleeve.realizedProfit)}</dd>
      <dt>평가 손익</dt><dd class="cp-${tone(sleeve.unrealizedProfit)}">${signedWon(sleeve.unrealizedProfit)}</dd>
      <dt>청산 / 승률</dt><dd>${sleeve.trades ?? 0}회 · ${sleeve.trades ? `${Number(sleeve.winRate).toFixed(1)}%` : '—'}</dd>
      <dt>봉 간격</dt><dd>${INTERVAL_LABELS[sleeve.interval] || sleeve.interval || '—'}</dd>
    </dl>
    ${sleeve.lastAnalysis ? html`<p class="cp-caption">기준 시장 ${REGIME_LABELS[sleeve.lastAnalysis.benchmarkRegime] || toUserText(sleeve.lastAnalysis.benchmarkRegime || '확인 전')} · 상위 ${(sleeve.lastAnalysis.top || []).slice(0, 3).map(item => `${symbolOf(item.symbol)} ${item.score}`).join(', ') || '—'}</p>` : ''}
    ${!summary.paramsValidated && summary.mode === 'live' ? html`<p class="cp-caption cp-warn">검증된 연구 결과 없음 · 신규 진입 안 함.</p>` : ''}
  </article>`;
}

function runtimeSection(runtime, ctx, index) {
  const status = runtime.status;
  const summary = horizonRuntimeSummary(status);
  const live = summary.mode === 'live';
  const s = ctx.session();
  const name = `${runtime.assetLabel} ${live ? '실전' : '모의'}`;
  const notices = [];
  if (summary.lastError) notices.push(notice({ tone: 'danger', title: '최근 오류', body: toUserText(summary.lastError) }));
  if (summary.entriesPaused && summary.pauseReason) notices.push(notice({ tone: 'warning', title: '신규 진입 잠금', body: summary.pauseReason }));
  if (summary.pendingOrders > 0) notices.push(notice({ tone: 'warning', title: '확인되지 않은 주문', body: `${summary.pendingOrders}건 체결 확인 전까지 신규 진입 잠금.` }));
  if (!summary.researchGeneratedAt) notices.push(notice({ tone: live ? 'warning' : 'neutral', title: '연구 결과 없음', body: live ? '검증된 연구 결과 전까지 실전 슬리브 진입 안 함.' : '연구 전에는 기본 설정으로 모의 운용.' }));
  const actions = s.canMutate ? (summary.running
    ? button({ label: `${runtime.assetLabel} 포트폴리오 정지`, iconName: 'stop', attrs: { 'data-horizon': runtime.asset, 'data-horizon-action': 'stop' } })
    : button({ label: `${runtime.assetLabel} 포트폴리오 시작`, variant: 'primary', iconName: 'play', attrs: { 'data-horizon': runtime.asset, 'data-horizon-action': 'start' } })) : '';
  const trades = summary.recentTrades.slice(0, 8).map(trade => engineTradePresentation(trade, { asset: runtime.asset, engine: name, sleeveLabel: status.sleeves?.[trade.sleeve]?.label }));
  return html`<section class="cp-stack" aria-label="${name} 포트폴리오">
    ${card({
      index,
      tone: live ? 'live' : undefined,
      title: `기간별 ${name} 포트폴리오`,
      action: live ? liveBadge() : badge('모의', 'info'),
      body: html`<div class="cp-grid-2">
        <div>${heroValue({ label: live ? '운용 자산 (거래소 계좌 내 예약분)' : '포트폴리오 총자산', value: summary.totalAssets, key: `horizon-${runtime.id}`, change: summary.totalAssets !== null && summary.initialSeedMoney ? summary.totalAssets - summary.initialSeedMoney : null, changePercent: summary.totalAssets !== null && summary.initialSeedMoney ? ((summary.totalAssets / summary.initialSeedMoney) - 1) * 100 : null, sub: live ? `계좌의 ${summary.capitalRatio !== null ? ratio(summary.capitalRatio * 100, 0) : '일부'}를 운용 · 실현 손익 ${signedWon(summary.realizedProfit)}` : `시작 금액 ${won(summary.initialSeedMoney)} · 현금 ${won(summary.cash)}` })}</div>
        <div>${engineStatus({
          name: '엔진',
          running: summary.running,
          tone: summary.lastError ? 'warning' : summary.running ? (summary.entriesPaused ? 'warning' : 'ok') : 'neutral',
          stateLabel: summary.running ? (summary.entriesPaused ? '진입 잠금' : '실행 중') : '정지',
          detail: `검증 통과 ${summary.validatedCount}/${summary.sleeves.length} 슬리브 · 보유 ${summary.positions.length}`,
          meta: [summary.lastCycleAt ? `마지막 분석 ${relativeTime(summary.lastCycleAt)}` : '분석 기록 없음', summary.researchGeneratedAt ? `연구 ${fullDateTime(summary.researchGeneratedAt)} · ${summary.researchMarkets ?? '—'}개 시장` : null, summary.researchRunning ? '재연구 진행 중' : null].filter(Boolean).join(' · '),
          actions
        })}</div>
      </div>`
    })}
    ${notices}
    ${card({
      index: index + 1,
      title: '슬리브',
      subtitle: '표본 외 3구간: 복리 수익 > 0, 2구간 이상 무손실, 최악 낙폭 한도 이내일 때만 비중.',
      body: summary.sleeves.length ? html`<div class="cp-sleeve-grid">${summary.sleeves.map(sleeve => sleeveCard(sleeve, summary))}</div>` : emptyState({ iconName: 'layers', title: '슬리브 정보 없음' })
    })}
    <div class="cp-grid-2">
      ${card({
        index: index + 2,
        title: '보유',
        body: list(summary.positions.map(position => listRow({
          leading: avatar(symbolOf(position.symbol), { tone: 'green' }),
          title: symbolOf(position.symbol),
          subtitle: `${status.sleeves?.[position.sleeve]?.label || position.sleeve} · ${quantity(position.quantity)} · 손절 ${price(position.stopPrice)}원${position.stuckBelowMinimum ? ' · 최소 주문 미만' : ''}`,
          value: position.lastPrice ? `${price(position.lastPrice)}원` : '시세 대기',
          valueSub: position.unrealizedProfit !== null ? signedWon(position.unrealizedProfit) : '',
          valueTone: tone(position.unrealizedProfit)
        })), { empty: emptyState({ iconName: 'layers', title: '보유 없음' }) })
      })}
      ${card({ index: index + 3, title: '최근 거래', body: list(trades.map(recordRow), { empty: emptyState({ iconName: 'list', title: '거래 기록 없음' }) }) })}
    </div>
    ${summary.researchError ? disclosure({ summary: '재연구 오류', body: html`<p class="cp-caption">${toUserText(summary.researchError)}</p>` }) : ''}
  </section>`;
}

export default {
  id: 'portfolios',
  resources: ['horizons', 'status'],
  mount(root, ctx) {
    function renderPage() {
      const state = ctx.resource('horizons');
      if (!state.data) {
        render(root, state.status === 'error'
          ? card({ body: emptyState({ iconName: 'alert', title: '포트폴리오 상태 불러오기 실패', body: toUserText(state.error?.message || '') }) })
          : html`<div class="cp-page">${card({ body: skeleton({ hero: true, lines: 2 }) })}${card({ body: skeleton({ lines: 5 }) })}</div>`);
        return;
      }
      const runtimes = horizonRuntimes(state.data);
      if (!runtimes.length) {
        render(root, card({ index: 0, body: emptyState({ iconName: 'layers', title: '기간별 포트폴리오 꺼짐', body: '서버 설정 HORIZON_TRADING_ENABLED 필요.' }) }));
        return;
      }
      render(root, html`<div class="cp-page">${runtimes.map((runtime, position) => runtimeSection(runtime, ctx, position * 4))}</div>`);
      ctx.enhance(root);
    }

    async function act(asset, action) {
      const live = ctx.session().isLive;
      const label = asset === 'coin' ? '코인' : '주식';
      const ok = await ctx.confirm(action === 'start'
        ? { title: `기간별 ${label} 포트폴리오 시작`, message: live ? '검증 통과 슬리브만 실제 자금 진입. 시작 시 거래소 잔고·장부 대사.' : '가상 자금 운용', confirmLabel: '시작', live }
        : { title: `기간별 ${label} 포트폴리오 정지`, message: '신규 진입·청산 판단 중지. 보유 종목 유지.', confirmLabel: '정지', tone: 'danger', live });
      if (!ok) return;
      await ctx.control(api => (action === 'start' ? api.control.startHorizon(asset) : api.control.stopHorizon(asset)), { success: action === 'start' ? '포트폴리오를 시작했습니다.' : '포트폴리오를 정지했습니다.', failure: '포트폴리오 상태를 바꾸지 못했습니다', refresh: ['horizons'] });
    }

    ctx.watch([ctx.res('horizons'), 'auth', 'online', ctx.res('status')], renderPage);
    ctx.on('click', '[data-horizon-action]', (event, target) => act(target.dataset.horizon, target.dataset.horizonAction));
  }
};
