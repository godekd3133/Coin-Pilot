// App-level composites shared by several features (positions, records, the
// scalper engine card, resource loading states).
import { html } from '../core/dom.js';
import { won, signedWon, percent, quantity, price, dateTime, relativeTime, tone, hasFiniteValue, symbolOf } from '../core/format.js';
import { avatar, badge, button, emptyState, engineStatus, listRow, skeleton, notice } from './components.js';
import { marketDisplayName } from '../domain/records.js';
import { runtimeBlockReason } from '../domain/trading.js';
import { toUserText } from '../domain/text.js';

/** Loading/empty/error wrapper for one resource state. */
export function resourceView(state, renderData, { lines = 3, emptyTitle = '자료 없음', isEmpty = data => data === null || data === undefined, errorTitle = '불러오기 실패' } = {}) {
  if (!state || state.status === 'idle' || (state.status === 'loading' && state.data === null)) return skeleton({ lines });
  if (state.data === null && state.status === 'error') {
    const denied = state.error?.status === 401 || state.error?.status === 403;
    return emptyState({ iconName: denied ? 'lock' : 'alert', title: denied ? '조회 권한 없음' : errorTitle, body: toUserText(state.error?.message || '연결 확인 후 재시도.') });
  }
  if (isEmpty(state.data)) return emptyState({ title: emptyTitle });
  const staleNote = state.status === 'error' && state.lastSuccessAt
    ? html`<p class="cp-caption cp-warn">갱신 실패 · ${relativeTime(state.lastSuccessAt)} 자료 표시 중</p>` : '';
  return html`${staleNote}${renderData(state.data)}`;
}

export function coinPositionRow(position, { href } = {}) {
  const coin = position.coin || position.market || '';
  const known = hasFiniteValue(position.currentValue);
  const profitTone = tone(position.profit);
  return listRow({
    leading: avatar(symbolOf(coin)),
    title: marketDisplayName({ coin }),
    subtitle: `${quantity(position.amount)} ${symbolOf(coin)} · 평균 ${price(position.avgPrice || position.entryPrice)}원`,
    value: known ? won(position.currentValue) : '평가 불가',
    valueSub: hasFiniteValue(position.profit) ? `${signedWon(position.profit)} (${percent(position.profitPercent)})` : '평가손익 미확인',
    valueTone: profitTone,
    href: href ?? `#/coins/${encodeURIComponent(coin)}`
  });
}

export function recordRow(item) {
  const title = item.marketLabel || symbolOf(item.coin);
  const detail = item.legs
    ? item.legs.map(leg => `${symbolOf(leg.coin)} ${leg.label} ${leg.amount === null ? '금액 미기록' : won(leg.amount)}`).join(' → ')
    : [item.source, item.reason, item.quantity === null ? null : `${quantity(item.quantity)}${item.asset === 'stock' ? '주' : ''}`, item.price === null ? null : `@${price(item.price)}원`].filter(Boolean).join(' · ');
  const sideTone = item.side === 'sell' ? 'down' : item.side === 'buy' ? 'up' : 'neutral';
  return listRow({
    leading: avatar(item.side === 'sell' ? '매도' : item.side === 'buy' ? '매수' : item.side === 'bundle' ? '묶음' : '기록', { tone: item.side === 'sell' ? 'blue' : item.side === 'buy' ? 'red' : 'neutral' }),
    title: html`${title} ${badge(item.label, sideTone)}`,
    subtitle: `${item.time ? dateTime(item.time) : '시각 미기록'} · ${detail}`,
    value: item.profit !== null ? signedWon(item.profit) : item.amount !== null ? won(item.amount) : '금액 미기록',
    valueSub: item.profit !== null ? '실현 손익' : item.amount !== null ? '수수료 전' : '',
    valueTone: item.profit !== null ? tone(item.profit) : ''
  });
}

/** Scalper (1-minute coin engine) status with start/stop. */
export function scalperEngine(session, { compact = false } = {}) {
  const status = session.status;
  if (!status) {
    return engineStatus({ name: '코인 스캘퍼', stateLabel: '확인 중', tone: 'neutral', detail: '상태 불러오는 중' });
  }
  const state = status.runtimeState;
  const running = status.isRunning === true || state === 'RUNNING';
  const toneValue = state === 'PROTECTIVE_ONLY' ? 'danger' : state === 'SYNC_REQUIRED' ? 'warning' : running ? 'ok' : 'neutral';
  const stateLabel = state === 'PROTECTIVE_ONLY' ? '위험 감시 전용' : state === 'SYNC_REQUIRED' ? '거래소 확인 중' : running ? '실행 중' : '정지';
  const breaker = status.lossCircuitBreaker;
  const detail = state === 'PROTECTIVE_ONLY' || state === 'SYNC_REQUIRED' ? runtimeBlockReason(status)
    : running ? `${(status.targetCoins || []).length}개 시장 감시 · 최대 ${status.maxPositions ?? '—'}개 보유 · 1분봉 과매도 반등`
      : status.stopReason ? `중지 사유: ${stopReasonLabel(status.stopReason)}` : '자동매매 꺼짐';
  const activity = status.engineActivity;
  const meta = [
    activity?.lastCycleAt ? `마지막 분석 ${relativeTime(activity.lastCycleAt)}` : null,
    activity ? `최근 1시간 신호 ${activity.signalsLastHour ?? 0}건 · 진입 ${activity.entriesLastHour ?? 0}건` : null,
    activity?.lastExchangeSyncAt ? `거래소 확인 ${relativeTime(activity.lastExchangeSyncAt)}` : null,
    status.accountLossGuard?.blocked
      ? (status.accountLossGuard.blockedReason === 'daily_loss_limit'
        ? `오늘 손실 한도 도달(${signedWon(status.accountLossGuard.realizedToday)}) · 신규 매수 중지`
        : `계좌 하한 미만(${won(status.accountLossGuard.equity)}) · 신규 매수 중지`)
      : status.accountLossGuard?.enabled
        ? `손실 가드 · 오늘 ${signedWon(status.accountLossGuard.realizedToday)}${status.accountLossGuard.dailyLossLimitKrw ? ` / 한도 -${won(status.accountLossGuard.dailyLossLimitKrw)}` : ''}`
        : null,
    breaker?.enabled ? `연속 손실 차단 ${breaker.lossCount || 0}/${breaker.maxLosses || 0}${breaker.coolingDown ? ' · 차단 중' : ''}` : null,
    status.autoRecovery?.desiredRunning === true && !running ? '자동 복구 대기' : null
  ].filter(Boolean).join(' · ');
  const actions = compact ? null : session.canMutate
    ? (running || state === 'PROTECTIVE_ONLY'
      ? button({ label: '자동매매 정지', size: 'sm', iconName: 'stop', attrs: { 'data-engine': 'scalper', 'data-engine-action': 'stop' } })
      : button({ label: '자동매매 시작', size: 'sm', variant: 'primary', iconName: 'play', attrs: { 'data-engine': 'scalper', 'data-engine-action': 'start' } }))
    : null;
  return engineStatus({ name: '코인 스캘퍼', running, stateLabel, tone: toneValue, detail, meta, actions, live: session.isLive });
}

export function stopReasonLabel(reason) {
  return ({
    operator_stop: '운영자 중지', operator_shutdown: '운영자 종료', risk_data_gap: '시세 공백으로 안전 중지',
    analysis_data_gap: '분석 자료 공백으로 안전 중지', exchange_state_unverified: '거래소 상태 미확인', graceful_shutdown: '서버 종료'
  })[reason] || toUserText(reason);
}

/** Confirmation + call for the scalper engine. */
export async function confirmScalper(ctx, action) {
  const current = ctx.session();
  if (action === 'start') {
    const ok = await ctx.confirm({
      title: '코인 자동매매 시작',
      message: current.isLive ? '실제 자금 1분봉 스캘핑. 시작 전 계좌·미체결 주문 확인.' : '가상 자금 1분봉 스캘핑.',
      details: [['작업공간', current.isLive ? '실전' : '모의투자'], ['감시 시장', `${(current.status?.targetCoins || []).length}개`], ['최대 보유', `${current.status?.maxPositions ?? '—'}개`]],
      confirmLabel: '시작',
      live: current.isLive
    });
    if (!ok) return;
    await ctx.control(api => api.control.startScalper(), { success: '자동매매 시작 요청됨', failure: '자동매매 시작 실패', refresh: ['status'] });
  } else {
    const ok = await ctx.confirm({
      title: '코인 자동매매 정지',
      message: '신규 진입 중지. 보유 포지션은 위험 감시 유지.',
      confirmLabel: '정지',
      tone: 'danger',
      live: current.isLive
    });
    if (!ok) return;
    await ctx.control(api => api.control.stopScalper(), { success: '자동매매 정지 요청됨', failure: '자동매매 정지 실패', refresh: ['status'] });
  }
}

export function lockedNotice(reason) {
  return notice({ tone: 'neutral', iconName: 'lock', body: reason });
}
