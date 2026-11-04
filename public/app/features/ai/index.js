// AI 의견: advisory-only signal monitoring sessions and provider opinions.
// Nothing here can place an order; an opinion is never an authorisation.
import { html, render } from '../../core/dom.js';
import { price, fullDateTime, number, relativeTime, symbolOf } from '../../core/format.js';
import { card, button, emptyState, skeleton, badge, list, statGrid, notice, field, attrs, disclosure } from '../../ui/components.js';
import { AI_EVENT_LABELS, aiActionLabel, aiProviderLabel, aiStatusLabel, toUserText } from '../../domain/text.js';

const PROVIDERS = [['gpt', 'ChatGPT'], ['claude', 'Claude']];
const EVENTS = ['BUY_SIGNAL', 'SELL_SIGNAL', 'REBOUND_CANDIDATE', 'BREAKING_NEWS', 'BUNDLE_SUGGESTION', 'TRADE_EXECUTED'];
const coinLabel = coin => (coin ? symbolOf(coin) : '시장 전체');

function providerState(provider) {
  const warning = provider.status === 'READY_WITH_CONFIG_WARNING' || (provider.status === 'CONFIG_ERROR' && provider.canAttemptWithoutUserConfig === true);
  if (provider.ready) return { label: warning ? '연결됨' : '사용 가능', tone: 'ok', help: warning ? '별도 계정 연결로 의견을 받을 수 있어요.' : '의견을 받을 수 있어요.' };
  if (provider.status === 'NOT_AUTHENTICATED') return { label: '로그인 필요', tone: 'warning', help: `${provider.label || aiProviderLabel(provider.id)} 계정에 로그인해 주세요.` };
  return { label: '사용할 수 없음', tone: 'danger', help: provider.status === 'NOT_INSTALLED' ? '연결 프로그램을 찾지 못했어요.' : provider.status === 'DISABLED' ? '현재 사용할 수 없어요.' : '연결 상태를 확인한 뒤 다시 시도해 주세요.' };
}

function consultationView(consultation) {
  const event = consultation.event || {};
  const hasResponse = (consultation.results || []).some(result => result.status === 'COMPLETED');
  const stateLabel = consultation.status === 'DEGRADED' && !hasResponse ? '응답 없음 · 자료 요약' : aiStatusLabel(consultation.status);
  const results = (consultation.results || []).map(result => {
    if (result.status === 'FALLBACK' && result.advice) {
      return html`<div class="cp-ai-advice"><strong>서비스 응답을 받지 못해 서버에서 확인한 정보만 정리했어요.</strong><p class="cp-caption">${result.advice.rationale || ''}</p>${(result.advice.risks || []).length ? html`<ul>${result.advice.risks.map(risk => html`<li>${risk}</li>`)}</ul>` : ''}</div>`;
    }
    if (result.status !== 'COMPLETED' || !result.advice) return html`<p class="cp-caption cp-danger">${aiProviderLabel(result.provider)}: ${toUserText(result.error || '응답 실패')}</p>`;
    const advice = result.advice;
    return html`<div class="cp-ai-advice"><div class="cp-row">${badge(aiActionLabel(advice.action), advice.action === 'BUY' ? 'up' : advice.action === 'SELL' ? 'down' : 'neutral')}<strong>${aiProviderLabel(result.provider)}</strong><span class="cp-caption">${advice.horizon || ''} · 확신 ${number(advice.confidence) <= 1 ? `${Math.round(number(advice.confidence) * 100)}%` : `${advice.confidence}`}</span></div><p class="cp-caption">${advice.rationale || ''}</p>${(advice.risks || []).length ? html`<ul>${advice.risks.map(risk => html`<li>${risk}</li>`)}</ul>` : ''}<p class="cp-micro">다시 확인할 조건: ${advice.invalidation || '추가 확인 필요'}</p></div>`;
  });
  const evaluation = consultation.evaluation;
  return html`<article class="cp-sleeve">
    <div class="cp-sleeve-head"><strong>${coinLabel(event.coin)} · ${AI_EVENT_LABELS[event.type] || '신호'}</strong>${badge(stateLabel, consultation.status === 'COMPLETED' ? 'ok' : consultation.status === 'RUNNING' ? 'info' : 'warning')}</div>
    <p class="cp-caption">${fullDateTime(consultation.createdAt)} · ${(consultation.providerSelection || []).map(aiProviderLabel).join(' + ')} · ${consultation.auto ? '자동 요청' : '직접 요청'}${consultation.aggregate?.quorum === false && consultation.aggregate?.singleProvider ? ' · 단일 의견 (합의 아님)' : ''}</p>
    ${results.length ? results : consultation.status === 'RUNNING' ? html`<p class="cp-caption">응답을 기다리는 중…</p>` : ''}
    ${consultation.error ? html`<p class="cp-caption cp-danger">${toUserText(consultation.error)}</p>` : ''}
    ${evaluation?.status === 'COMPLETED' ? html`<p class="cp-caption"><b>가격 변화 확인</b> · ${number(evaluation.horizonMinutes, 5)}분 후 ${number(evaluation.priceChangePercent).toFixed(2)}% · ${(evaluation.verdicts || []).map(verdict => `${toUserText(verdict.providerLabel || verdict.source)} ${toUserText(verdict.verdict)}`).join(' · ')}</p>`
      : evaluation?.status === 'PENDING' ? html`<p class="cp-caption">가격 확인 대기 중</p>`
        : evaluation?.status === 'NOT_EVALUABLE' ? html`<p class="cp-caption">가격 비교 제외: ${toUserText(evaluation.reason || '기준 가격이나 응답이 없어요.')}</p>` : ''}
  </article>`;
}

export default {
  id: 'ai',
  resources: ['aiProviders', 'aiMonitoring'],
  mount(root, ctx) {
    const live = { events: [], consultations: [], sessions: [] };
    render(root, html`<div class="cp-page">
      ${notice({ tone: 'neutral', iconName: 'info', title: '참고용 의견', body: 'AI 의견은 주문을 실행하거나 허가하지 않아요. 자동매매는 설정한 전략 조건으로만 주문합니다.' })}
      <div class="cp-split">
        <div class="cp-stack"><div data-slot="events"></div><div data-slot="consultations"></div></div>
        <div class="cp-stack"><div data-slot="providers"></div><div data-slot="effectiveness"></div><div data-slot="sessions"></div><div data-slot="create"></div></div>
      </div>
    </div>`);
    const slot = name => root.querySelector(`[data-slot="${name}"]`);

    const merge = (base, extra) => {
      const seen = new Set();
      return [...extra, ...base].filter(item => item && !seen.has(item.id) && seen.add(item.id));
    };

    function snapshot() {
      const data = ctx.data('aiMonitoring') || {};
      return {
        events: merge(data.events || [], live.events).slice(0, 60),
        consultations: merge(data.consultations || [], live.consultations).slice(0, 40),
        sessions: merge(data.sessions || [], live.sessions),
        effectiveness: data.effectiveness || null,
        updatedAt: data.updatedAt
      };
    }

    function renderProviders() {
      const state = ctx.resource('aiProviders');
      const providers = state.data?.providers || [];
      render(slot('providers'), card({
        index: 0,
        title: '의견 서비스',
        action: button({ label: '다시 확인', size: 'sm', iconName: 'refresh', attrs: { 'data-action': 'refresh-providers' } }),
        body: state.data === null ? (state.status === 'error' ? emptyState({ iconName: 'alert', title: '연결 상태를 확인할 수 없어요' }) : skeleton({ lines: 2 }))
          : providers.length ? list(providers.map(provider => {
            const view = providerState(provider);
            return html`<div class="cp-list-row"><span class="cp-row-main"><span class="cp-row-title">${provider.label || aiProviderLabel(provider.id)}</span><span class="cp-row-sub">${view.help}</span></span>${badge(view.label, view.tone)}</div>`;
          })) : emptyState({ title: '사용할 수 있는 서비스가 없어요' })
      }));
    }

    function renderMonitoring() {
      const data = snapshot();
      const canMutate = ctx.session().canMutate;
      render(slot('events'), card({
        index: 1,
        title: '최근 신호',
        subtitle: data.updatedAt ? `동기화 ${relativeTime(data.updatedAt)}` : null,
        body: ctx.resource('aiMonitoring').data === null && ctx.resource('aiMonitoring').status !== 'error' ? skeleton({ lines: 4 })
          : list(data.events.slice(0, 30).map(event => html`<div class="cp-list-row"><span class="cp-row-main"><span class="cp-row-title">${coinLabel(event.coin)} · ${AI_EVENT_LABELS[event.type] || '신호'} ${badge(aiActionLabel(event.action), event.action === 'BUY' ? 'up' : event.action === 'SELL' ? 'down' : 'neutral')}</span><span class="cp-row-sub">${fullDateTime(event.timestamp)} · ${event.price === null || event.price === undefined ? '—' : `${price(event.price)}원`} · ${toUserText(event.reason || event.snapshot?.title || '신호 상세 없음')}</span></span>${button({ label: '의견 요청', size: 'sm', attrs: { 'data-consult': event.id }, disabled: !canMutate })}</div>`), { empty: emptyState({ iconName: 'spark', title: '새 신호가 생기면 여기에 표시돼요' }) })
      }));
      render(slot('consultations'), card({ index: 2, title: `의견 기록 · ${data.consultations.length}건`, body: data.consultations.length ? html`<div class="cp-stack">${data.consultations.slice(0, 20).map(consultationView)}</div>` : emptyState({ iconName: 'spark', title: '의견을 요청하면 여기에 표시돼요' }) }));
      const effectiveness = data.effectiveness;
      const stats = Object.values(effectiveness?.providerStats || {});
      render(slot('effectiveness'), card({
        index: 3,
        title: '의견 뒤 가격 비교',
        action: badge(effectiveness?.sufficientEvidence ? '자료 충분' : '자료 부족', effectiveness?.sufficientEvidence ? 'ok' : 'warning'),
        body: effectiveness ? html`${statGrid([
          { label: '응답 완료', value: effectiveness.actualProviderCompletions || 0 },
          { label: '가격 확인', value: effectiveness.evaluatedConsultations || 0 },
          { label: '확인률', value: effectiveness.evaluationCoverageRate === null || effectiveness.evaluationCoverageRate === undefined ? '—' : `${(number(effectiveness.evaluationCoverageRate) * 100).toFixed(1)}%` },
          { label: '응답률', value: effectiveness.actualProviderCompletionRate === null || effectiveness.actualProviderCompletionRate === undefined ? '—' : `${(number(effectiveness.actualProviderCompletionRate) * 100).toFixed(1)}%` }
        ], { columns: 2 })}
          ${list(stats.map(stat => html`<div class="cp-list-row"><span class="cp-row-main"><span class="cp-row-title">${toUserText(stat.label || stat.source)}</span><span class="cp-row-sub">가격 확인 ${stat.evaluated || 0}건 · 방향 의견 ${stat.directionalPredictions || 0}건${stat.type === 'consensus' ? ` · 일치 ${stat.hits || 0} · 불일치 ${stat.misses || 0}` : ` · 응답 ${stat.completed || 0}/${stat.attempted || 0}`}</span></span><span class="cp-row-value cp-num">${stat.hitRate === null || stat.hitRate === undefined ? '—' : `${(number(stat.hitRate) * 100).toFixed(1)}%`}</span></div>`))}
          <p class="cp-caption" style="margin-top:8px">방향 일치율은 의견 뒤 가격 움직임을 비교한 값이며 실제 매매 수익률이 아니에요.</p>
          ${effectiveness.evidenceWarning ? html`<p class="cp-caption cp-warn">${toUserText(effectiveness.evidenceWarning)}</p>` : ''}` : skeleton({ lines: 3 })
      }));
      render(slot('sessions'), card({
        index: 4,
        title: '신호 알림',
        subtitle: `알림 중 ${data.sessions.filter(session => session.status === 'RUNNING').length}개 · 전체 ${data.sessions.length}개`,
        body: list(data.sessions.map(session => html`<div class="cp-list-row" style="align-items:flex-start"><span class="cp-row-main"><span class="cp-row-title">${session.name} ${badge(aiStatusLabel(session.status), session.status === 'RUNNING' ? 'ok' : session.status === 'PAUSED' ? 'warning' : 'neutral')}</span><span class="cp-row-sub">${(session.providers || []).map(aiProviderLabel).join(' + ')} · ${(session.eventTypes || []).map(type => AI_EVENT_LABELS[type] || type).join(' · ')}</span><span class="cp-row-sub">${session.coins?.length ? session.coins.map(symbolOf).join(', ') : '전체 코인'} · 신호 ${session.eventCount || 0} · 의견 ${session.consultationCount || 0} · ${session.evaluationMinutes || 5}분 후 가격 확인</span></span>
          <span class="cp-row-trailing cp-row">${session.status === 'RUNNING' ? button({ label: '일시정지', size: 'sm', attrs: { 'data-session': session.id, 'data-session-action': 'pause' }, disabled: !canMutate }) : session.status === 'PAUSED' ? button({ label: '재개', size: 'sm', attrs: { 'data-session': session.id, 'data-session-action': 'resume' }, disabled: !canMutate }) : ''}${session.status !== 'STOPPED' ? button({ label: '종료', size: 'sm', variant: 'danger', attrs: { 'data-session': session.id, 'data-session-action': 'stop' }, disabled: !canMutate }) : ''}</span></div>`), { empty: emptyState({ iconName: 'bell', title: '등록한 알림이 없어요' }) })
      }));
    }

    render(slot('create'), card({
      index: 5,
      title: '새 신호 알림',
      body: disclosure({ summary: '알림 만들기', open: false, body: html`<form class="cp-form" data-form="session">
        ${field({ label: '이름', id: 'cp-ai-name', input: html`<input class="cp-input" id="cp-ai-name" name="name" maxlength="60" value="관심 신호 알림">` })}
        <fieldset class="cp-chips" style="border:0;padding:0;margin:0"><legend class="cp-field-label">의견 서비스</legend>${PROVIDERS.map(([value, label]) => html`<label class="cp-check"><input type="checkbox" name="providers" value="${value}" ${attrs({ checked: value === 'gpt' })}>${label}</label>`)}</fieldset>
        <fieldset class="cp-chips" style="border:0;padding:0;margin:0"><legend class="cp-field-label">알림 항목</legend>${EVENTS.map(value => html`<label class="cp-check"><input type="checkbox" name="eventTypes" value="${value}" ${attrs({ checked: ['BUY_SIGNAL', 'SELL_SIGNAL'].includes(value) })}>${AI_EVENT_LABELS[value]}</label>`)}</fieldset>
        ${field({ label: '코인 (쉼표 구분, 비우면 전체)', id: 'cp-ai-coins', input: html`<input class="cp-input" id="cp-ai-coins" name="coins" placeholder="KRW-BTC, KRW-ETH">` })}
        <div class="cp-grid-2">
          ${field({ label: '재알림 간격 (초)', id: 'cp-ai-cooldown', input: html`<input class="cp-input cp-num" id="cp-ai-cooldown" name="cooldownSeconds" type="number" min="30" value="300">` })}
          ${field({ label: '가격 확인 (분 후)', id: 'cp-ai-eval', input: html`<input class="cp-input cp-num" id="cp-ai-eval" name="evaluationMinutes" type="number" min="1" value="5">` })}
        </div>
        <label class="cp-check"><input type="checkbox" name="autoConsult" checked>신호가 오면 자동으로 의견 요청</label>
        ${button({ label: '알림 시작', variant: 'primary', type: 'submit' })}
      </form>` })
    }));

    async function createSession(form) {
      if (!ctx.session().canMutate) { ctx.ui.toast(ctx.session().mutationBlockedReason, 'warning'); return; }
      const data = new FormData(form);
      const providers = data.getAll('providers');
      const eventTypes = data.getAll('eventTypes');
      if (!providers.length || !eventTypes.length) { ctx.ui.toast('의견을 받을 서비스와 알림 항목을 하나 이상 선택해 주세요.', 'warning'); return; }
      await ctx.control(api => api.post('/ai/sessions', {
        name: data.get('name'), providers, eventTypes, coins: data.get('coins') || '',
        cooldownSeconds: number(data.get('cooldownSeconds'), 300), evaluationMinutes: number(data.get('evaluationMinutes'), 5),
        autoConsult: data.get('autoConsult') === 'on'
      }), { success: '신호 알림을 시작했습니다.', failure: '신호 알림을 시작하지 못했습니다', refresh: ['aiMonitoring'] });
    }

    async function consult(eventId) {
      const providers = [...root.querySelectorAll('[data-form="session"] input[name="providers"]:checked')].map(input => input.value);
      const provider = providers.length === 2 ? 'both' : providers[0] || 'both';
      ctx.ui.toast('의견을 요청하고 있어요…', 'info');
      const result = await ctx.control(api => api.post('/ai/consult', { eventId, provider }, { timeout: 120_000 }).then(response => {
        if (response?.consultation) live.consultations = merge(live.consultations, [response.consultation]);
        const status = response?.consultation?.status;
        return { success: status === 'COMPLETED', message: status === 'COMPLETED' ? '의견을 받았습니다.' : status === 'DEGRADED' ? '서비스 응답을 받지 못해 확인된 정보만 표시했습니다.' : '의견을 받지 못했습니다.' };
      }), { failure: '의견 요청에 실패했습니다', refresh: ['aiMonitoring'] });
      if (result) renderMonitoring();
    }

    ctx.watch([ctx.res('aiProviders')], renderProviders);
    ctx.watch([ctx.res('aiMonitoring'), 'auth', 'online'], renderMonitoring);
    ctx.watch(['aiEvent'], state => { if (state.aiEvent?.value) { live.events = merge(live.events, [state.aiEvent.value]); renderMonitoring(); } }, { immediate: false });
    ctx.watch(['aiConsultation'], state => { if (state.aiConsultation?.value) { live.consultations = merge(live.consultations, [state.aiConsultation.value]); renderMonitoring(); } }, { immediate: false });
    ctx.watch(['aiSession'], state => { if (state.aiSession?.value) { live.sessions = merge(live.sessions, [state.aiSession.value]); renderMonitoring(); } }, { immediate: false });

    ctx.on('click', '[data-action="refresh-providers"]', () => ctx.api.get('/ai/providers?refresh=true').then(() => ctx.resources.refresh('aiProviders')).catch(() => ctx.resources.refresh('aiProviders')));
    ctx.on('submit', '[data-form="session"]', (event, form) => { event.preventDefault(); createSession(form); });
    ctx.on('click', '[data-consult]', (event, target) => consult(target.dataset.consult));
    ctx.on('click', '[data-session-action]', async (event, target) => {
      const action = target.dataset.sessionAction;
      if (action === 'stop' && !(await ctx.confirm({ title: '신호 알림을 종료할까요?', confirmLabel: '종료', tone: 'danger' }))) return;
      await ctx.control(api => api.post(`/ai/sessions/${encodeURIComponent(target.dataset.session)}/${action}`), { success: action === 'stop' ? '신호 알림을 종료했습니다.' : action === 'pause' ? '신호 알림을 일시정지했습니다.' : '신호 알림을 다시 시작했습니다.', failure: '신호 알림 변경 실패', refresh: ['aiMonitoring'] });
    });
  }
};
