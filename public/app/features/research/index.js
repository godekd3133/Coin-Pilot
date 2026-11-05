// 점검·검증: live-order readiness, the fixed-config validation report, the
// forward paper session (start / reset-start / stop), backtests, candidate
// comparison history and research-only reports. Research artefacts are shown
// as reference only — none of them can authorise live orders.
import { html, render } from '../../core/dom.js';
import { won, signedWon, percent, tone, fullDateTime, number, hasFiniteValue, symbolOf } from '../../core/format.js';
import { card, kv, badge, button, notice, list, listRow, avatar, emptyState, statGrid, disclosure } from '../../ui/components.js';
import { resourceView } from '../../ui/patterns.js';
import { classifyReadiness, readinessAuditRows, validationReportFreshness } from '../../domain/readiness.js';
import { isCoreTradingSnapshotReady } from '../../domain/trading.js';
import { toUserText } from '../../domain/text.js';

function readinessCard(state) {
  const readiness = state.data;
  const verdict = classifyReadiness(readiness);
  return card({
    index: 0,
    title: '실전 주문 전 점검',
    action: badge(verdict.stateLabel, verdict.tone === 'ok' ? 'ok' : verdict.tone === 'danger' ? 'danger' : verdict.tone === 'info' ? 'info' : 'warning'),
    body: resourceView(state, () => html`
      <p class="cp-headline">${verdict.headline}</p>
      ${verdict.description ? html`<p class="cp-caption" style="margin-top:4px">${verdict.description}</p>` : ''}
      ${verdict.reasons.length ? html`<ul style="margin:10px 0 0;padding-left:18px" class="cp-caption">${verdict.reasons.map(reason => html`<li>${reason}</li>`)}</ul>` : ''}
      <div style="margin-top:12px">${disclosure({ summary: '점검 결과와 사용 범위', meta: '작성 시점과 적용 여부', body: html`${kv(readinessAuditRows(readiness).map(([key, value]) => [key, key === '점검 시각' ? (value ? fullDateTime(value) : '확인 불가') : value]))}<p class="cp-caption" style="margin-top:8px">점검 작성 시점과 현재 주문 조건. 실제 체결·수익 근거 아님.</p>` })}</div>`, { lines: 3 })
  });
}

function validationCard(state) {
  const report = state.data;
  return card({
    index: 1,
    title: '고정 설정 검증 리포트',
    subtitle: '수수료·슬리피지 반영, 시장별 95% 신뢰 기준',
    body: resourceView(state, () => (report.available === false
      ? emptyState({ iconName: 'shield', title: '검증 리포트 없음', body: '서버에서 validate:scalping:fixed 실행 후 표시.' })
      : html`${statGrid([
        { label: '실거래 적용 후보', value: report.promoted ? '예' : '아니요', tone: report.promoted ? 'ok' : 'warn', mono: false },
        { label: '작성', value: validationReportFreshness(report.generatedAt, report.reportFreshness), mono: false },
        { label: '검증 방식', value: report.validationMode === 'fixed_config' ? '고정 설정' : toUserText(report.validationMode || '—'), mono: false },
        { label: '시장', value: `${Array.isArray(report.results) ? report.results.length : 0}개` }
      ])}
      ${list((report.results || []).slice(0, 12).map(result => listRow({
        leading: avatar(symbolOf(result.market || result.coin)),
        title: symbolOf(result.market || result.coin),
        subtitle: `거래 ${result.holdout?.trades ?? result.trades ?? '—'}회 · 승률 ${hasFiniteValue(result.holdout?.winRate ?? result.winRate) ? `${number(result.holdout?.winRate ?? result.winRate).toFixed(1)}%` : '—'}`,
        value: percent(result.holdout?.totalReturnPercent ?? result.holdout?.returnPercent ?? result.returnPercent),
        valueTone: tone(result.holdout?.totalReturnPercent ?? result.holdout?.returnPercent ?? result.returnPercent),
        trailing: badge(result.promoted || result.passed ? '통과' : '미통과', result.promoted || result.passed ? 'ok' : 'neutral')
      })))}`), { lines: 3 })
  });
}

function paperCard(ctx) {
  const state = ctx.resource('paper');
  const status = state.data;
  const s = ctx.session();
  const notStarted = status?.available === false && status?.reason === 'paper_validation_session_not_started';
  const known = status?.available === true || notStarted;
  const running = status?.available === true && status?.active === true;
  const readOnly = status?.readOnlyObserver === true;
  const coreReady = isCoreTradingSnapshotReady({ status: s.status, account: s.account, marketPrices: s.marketPricesLoaded ? s.marketPrices : null, selectedCoin: s.marketPrices[0]?.coin });
  const exchangeUnsafe = s.status?.runtimeState === 'SYNC_REQUIRED' || s.status?.runtimeState === 'PROTECTIVE_ONLY' || s.status?.exchangeStateKnown === false;
  const startBlocked = !s.canMutate || readOnly || !known || running || !s.isPaper || !coreReady || exchangeUnsafe;
  const startReason = !s.canMutate ? s.mutationBlockedReason : !s.isPaper ? '모의투자 서버 전용' : !known ? '모의투자 상태 확인 불가 · 시작/초기화 불가' : exchangeUnsafe ? '거래소 상태 확인 중' : !coreReady ? '계좌·시세 확인 후 시작 가능' : '';
  const actions = readOnly ? '' : html`<div class="cp-actions" style="margin-top:12px">
    ${running ? button({ label: '모의투자 중지', iconName: 'stop', attrs: { 'data-paper': 'stop' }, disabled: !s.canMutate }) : html`
      ${button({ label: '현재 자산으로 시작', variant: 'primary', iconName: 'play', attrs: { 'data-paper': 'start' }, disabled: startBlocked, title: startReason || undefined })}
      ${button({ label: '초기화 후 시작', variant: 'danger', attrs: { 'data-paper': 'reset' }, disabled: startBlocked, title: startReason || undefined })}`}
  </div>${startBlocked && !running && startReason ? html`<p class="cp-caption" style="margin-top:6px">${startReason}</p>` : ''}`;

  if (!status) return card({ index: 2, title: '모의투자 실행', body: resourceView(state, () => '', { lines: 3 }) });
  if (notStarted) {
    return card({ index: 2, title: '모의투자 실행', action: badge('시작 전', 'neutral'), body: html`<p>진행 중인 모의투자 없음.</p>${actions}<p class="cp-caption" style="margin-top:8px">초기화 시 가상 잔액·보유 코인·전략별 포지션·매매 기록 삭제.</p>` });
  }
  if (!known) return card({ index: 2, title: '모의투자 실행', action: badge('확인 필요', 'warning'), body: html`<p class="cp-caption">모의투자 상태 불러오기 실패 · 시작/초기화 불가</p>` });

  const problem = status.orphaned === true || status.riskMonitor?.failClosed === true || status.analysisDataHealth?.failClosed === true;
  const openCount = hasFiniteValue(status.strictEvaluation?.activePositions) ? Number(status.strictEvaluation.activePositions) : null;
  const closedCount = hasFiniteValue(status.strictEvaluation?.closedTradeCount ?? status.closedTradeCount) ? Number(status.strictEvaluation?.closedTradeCount ?? status.closedTradeCount) : null;
  const funnel = status.signalAvailability?.signalFunnel || {};
  const funnelKeys = ['availableWindows', 'oversoldWindows', 'bullishWindows', 'priceReboundWindows', 'confirmedWindows'];
  const funnelAvailable = status.signalTelemetry?.available === true && Number(funnel.version) === 1 && funnelKeys.every(key => hasFiniteValue(funnel[key]));
  const confirmations = status.telemetry || {};
  const gapMs = Number(status.riskMonitor?.maxWatchdogTickGapMs);
  return card({
    index: 2,
    title: '모의투자 실행',
    action: badge(problem ? '상태 확인 필요' : running ? '진행 중' : '중지', problem ? 'danger' : running ? 'ok' : 'warning'),
    body: html`
      ${statGrid([
        { label: '평가 자산', value: won(status.currentAssets) },
        { label: '평가 수익률', value: percent(status.returnPercent), tone: tone(status.returnPercent) },
        { label: readOnly ? '수수료 반영 기록' : '실현 손익', value: signedWon(status.realizedProfit), tone: tone(status.realizedProfit) },
        { label: '청산 / 보유', value: `${closedCount ?? '—'}회 / ${openCount ?? '—'}개` }
      ])}
      <div style="margin-top:12px">${kv([
        ['시작', fullDateTime(status.startedAt)],
        ['마지막 갱신', fullDateTime(status.updatedAt || status.heartbeatAt || status.lastHeartbeat)],
        ['위험 점검 최대 간격', number(status.riskMonitor?.watchdogTelemetryVersion) >= 1 && Number.isFinite(gapMs) ? (gapMs >= 1000 ? `${(gapMs / 1000).toFixed(1)}초` : `${Math.round(gapMs)}밀리초`) : '이전 세션 기록 없음'],
        ['기록 연속성', status.continuityEligible === false ? '공백 기록으로 근거 제외' : '정상'],
        ['진입 재확인', hasFiniteValue(confirmations.entryConfirmationAttempts) ? `시도 ${confirmations.entryConfirmationAttempts} · 성공 ${confirmations.entryConfirmationSucceeded ?? 0} · 취소 ${confirmations.entryConfirmationCancelled ?? 0}` : '—']
      ])}</div>
      ${openCount > 0 ? html`<p class="cp-caption" style="margin-top:8px">평가 자산·수익률은 미청산 평가손익 포함. 실현 손익은 청산분만.</p>` : ''}
      ${funnelAvailable ? html`<div style="margin-top:12px"><p class="cp-caption" style="margin-bottom:6px">신호 흐름 · 완료된 캔들 기준 집계 · 참고용</p><div class="cp-funnel">${[['분석 완료', funnel.availableWindows], ['과매도', funnel.oversoldWindows], ['양봉 확인', funnel.bullishWindows], ['반등', funnel.priceReboundWindows], ['확정', funnel.confirmedWindows]].map(([label, value]) => html`<div><span>${label}</span><strong>${number(value)}</strong></div>`)}</div><p class="cp-caption" style="margin-top:6px">거래 횟수·수익 아님. 이 수치로 조건을 자동 완화하지 않음.</p></div>` : ''}
      ${problem ? html`<div style="margin-top:12px">${notice({ tone: 'danger', body: '연결·시세 문제로 신규 매매 중지.' })}</div>` : ''}
      ${status.configConsistent === false ? html`<div style="margin-top:12px">${notice({ tone: 'warning', body: '설정 변경됨 · 이 기록은 현재 설정과 불일치.' })}</div>` : ''}
      ${actions}`
  });
}

function historyCard(ctx) {
  const optimization = ctx.resource('optimizationHistory');
  const backtest = ctx.resource('backtestResults');
  return card({
    index: 3,
    title: '과거 데이터 점검 · 후보 비교',
    body: html`<p class="cp-section-title" style="margin-bottom:4px">백테스트</p>
      ${resourceView(backtest, rows => list(rows.slice(0, 8).map(item => listRow({
        leading: avatar(symbolOf(item.coin || item.market || '-')),
        title: toUserText(item.strategy || item.name || '과거 데이터 점검'),
        subtitle: `거래 ${item.totalTrades || item.tradeCount || 0}회 · 이익/손실 비율 ${item.profitFactor ?? '—'} · 최대 낙폭 ${hasFiniteValue(item.maxDrawdown) ? `${number(item.maxDrawdown).toFixed(1)}%` : '—'}`,
        value: percent(item.totalReturnPercent ?? item.returnPercent),
        valueTone: tone(item.totalReturnPercent ?? item.returnPercent)
      })), { empty: html`<p class="cp-caption">과거 데이터 점검 결과 없음</p>` }), { lines: 2 })}
      <p class="cp-section-title" style="margin:14px 0 4px">설정 후보 비교 기록</p>
      ${resourceView(optimization, rows => list(rows.slice(0, 8).map(item => listRow({
        leading: avatar('비교', { tone: 'neutral' }),
        title: toUserText(item.type || item.strategy || '설정 비교'),
        subtitle: `${fullDateTime(item.timestamp || item.date)} · ${toUserText(item.description || item.message || '비교한 설정 기록')}`,
        value: String(item.fitness ?? item.score ?? '—')
      })), { empty: html`<p class="cp-caption">설정 비교 기록 없음</p>` }), { lines: 2 })}`
  });
}

function researchCard(ctx) {
  const state = ctx.resource('strategyResearch');
  const shadow = ctx.resource('momentumShadow');
  const report = state.data;
  const cohort = shadow.data?.paperForwardCohort;
  return card({
    index: 4,
    title: '연구 자료',
    subtitle: '참고용 · 주문 조건 미반영',
    body: html`${resourceView(state, () => (report?.available ? html`${kv([
      ['자료', toUserText(report.study || report.reportFile || '연구 리포트')],
      ['작성', `${fullDateTime(report.generatedAt)} · ${validationReportFreshness(report.generatedAt, report.reportFreshness)}`],
      ['대상 시장', `${number(report.requestedMarketCount, Array.isArray(report.markets) ? report.markets.length : 0)}개`],
      ['조건 후보', `${Array.isArray(report.variants) ? report.variants.length : Object.keys(report.variants || {}).length}개`],
      ['실거래 적용', '불가 (연구 전용)']
    ])}${report.reportFreshness?.fresh === false ? html`<div style="margin-top:8px">${notice({ tone: 'warning', body: '오래된 비교 결과 · 수익성 판단에 사용 불가.' })}</div>` : ''}`
      : emptyState({ iconName: 'shield', title: report?.reason === 'research_report_not_found' ? '지정한 연구 자료 없음' : '연구 자료 없음', body: '서버에서 리포트 지정 시 표시.' })), { lines: 2 })}
      ${cohort ? html`<div style="margin-top:12px">${disclosure({ summary: '모의투자 누적 비교 그룹', body: kv([
        ['실행', `${cohort.sessionCount ?? '—'}회`],
        ['기본 조건 청산', `${cohort.strictTradeCount ?? '—'}건`],
        ['수익성 근거 포함 실행', `${cohort.profitabilityEvidenceSessionCount ?? '—'}회`],
        ['근거 손익', hasFiniteValue(cohort.profitabilityEvidenceProfit) ? signedWon(cohort.profitabilityEvidenceProfit) : '판단 자료 부족'],
        ['실제 체결 기록', cohort.actualFillsObserved === true ? '관측됨' : cohort.actualFillsObserved === false ? '미관측' : '확인 불가']
      ]) })}</div>` : ''}`
  });
}

export default {
  id: 'research',
  resources: ['readiness', 'validation', 'paper', 'status', 'account', 'prices', 'optimizationHistory', 'backtestResults', 'strategyResearch', 'momentumShadow'],
  mount(root, ctx) {
    render(root, html`<div class="cp-page"><div class="cp-split"><div class="cp-stack" data-slot="left"></div><div class="cp-stack" data-slot="right"></div></div></div>`);
    const left = root.querySelector('[data-slot="left"]');
    const right = root.querySelector('[data-slot="right"]');

    function renderAll() {
      render(left, html`${readinessCard(ctx.resource('readiness'))}${paperCard(ctx)}${historyCard(ctx)}`);
      render(right, html`${validationCard(ctx.resource('validation'))}${researchCard(ctx)}`);
    }

    async function paperAction(kind) {
      const s = ctx.session();
      if (!s.canMutate) { ctx.ui.toast(s.mutationBlockedReason, 'warning'); return; }
      if (kind === 'stop') {
        const ok = await ctx.confirm({ title: '모의투자 중지', message: '중지 시 보유 포지션은 기록에 남고, 같은 기록에서 자동 재시작하지 않음.', confirmLabel: '중지', tone: 'danger' });
        if (!ok) return;
        await ctx.control(api => api.control.stopPaper(), { success: '모의투자를 중지했습니다.', failure: '모의투자 중지 실패', refresh: ['paper', 'status'] });
        return;
      }
      const reset = kind === 'reset';
      const seed = number(s.account?.initialSeedMoney);
      const ok = await ctx.confirm({
        title: reset ? '초기화 후 새 모의투자 시작' : '모의투자 시작',
        message: reset ? `${seed > 0 ? `초기 금액 ${won(seed)}` : '저장된 초기 금액'}으로 새 모의투자를 시작합니다. 보유 코인과 전략별 포지션·매매 기록은 사라집니다.` : '현재 가상 자산과 포지션을 유지한 채 모의투자 실행을 시작합니다.',
        confirmLabel: reset ? '초기화 후 시작' : '시작',
        tone: reset ? 'danger' : 'primary'
      });
      if (!ok) return;
      await ctx.control(api => api.control.startPaper(reset), { success: reset ? '초기화 후 모의투자를 시작했습니다.' : '모의투자를 시작했습니다.', failure: '모의투자 시작 실패', refresh: ['paper', 'status', 'account'] });
    }

    ctx.watch([ctx.res('readiness'), ctx.res('validation'), ctx.res('paper'), ctx.res('status'), ctx.res('account'), ctx.res('prices'), ctx.res('optimizationHistory'), ctx.res('backtestResults'), ctx.res('strategyResearch'), ctx.res('momentumShadow'), 'auth', 'online'], renderAll);
    ctx.on('click', '[data-paper]', (event, target) => paperAction(target.dataset.paper));
  }
};
