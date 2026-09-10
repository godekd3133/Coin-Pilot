(() => {
    'use strict';

    const host = document.getElementById('ai-desk-root');
    if (!host) return;

    const labels = {
        BUY_SIGNAL: '매수 신호',
        SELL_SIGNAL: '매도 신호',
        REBOUND_CANDIDATE: '반등 후보',
        BREAKING_NEWS: '속보',
        BUNDLE_SUGGESTION: '리밸런싱 제안',
        TRADE_EXECUTED: '체결 알림'
    };
    const state = { providers: null, sessions: [], events: [], consultations: [], loading: false };
    const $ = selector => host.querySelector(selector);
    const $$ = selector => [...host.querySelectorAll(selector)];
    const esc = value => String(value ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    const n = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
    const symbol = coin => String(coin || '').replace(/^KRW-/, '');
    const providerName = provider => provider === 'gpt' ? 'GPT / Codex' : provider === 'claude' ? 'Claude' : String(provider || '-');
    const time = value => {
        if (!value) return '-';
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    };
    const won = value => n(value).toLocaleString('ko-KR', { maximumFractionDigits: 4 });

    function request(path, options = {}) {
        return fetch(`/api${path}`, {
            ...options,
            headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
        }).then(async response => {
            const data = await response.json().catch(() => null);
            if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
            return data;
        });
    }

    function toast(message, type = 'info') {
        if (typeof window.showToast === 'function') {
            window.showToast(message, type);
            return;
        }
        console.log(`[AI Desk/${type}] ${message}`);
    }

    function mountMarkup() {
        host.innerHTML = `
            <section class="ai-desk-hero">
                <div><div class="ai-desk-kicker">AI ADVISORY / LONG-RUN WATCH</div><h2 class="ai-desk-title">판단이 필요한 순간만, 빠르게 자문</h2><p class="ai-desk-copy">모니터링 이벤트를 고르고 GPT·Claude 구독 세션에 읽기 전용 자문을 요청합니다. AI 의견은 기록되지만 기존 설정값 기반 자동 매수·매도에는 연결되지 않습니다.</p></div>
                <div class="ai-desk-stamp">ADVISORY ONLY<br>NO ORDER ROUTING</div>
            </section>
            <div class="ai-desk-grid">
                <div class="ai-desk-column">
                    <div class="ai-desk-section-title"><h3>연결 상태</h3><button type="button" class="ai-desk-button" data-ai-refresh>새로고침</button></div>
                    <div class="ai-desk-provider-grid" data-ai-providers><div class="ai-desk-empty">provider 상태 확인 중...</div></div>
                    <div class="ai-desk-note">GPT는 Codex CLI, Claude는 Claude CLI의 구독 로그인 상태를 사용합니다. 앱에는 API key를 저장하지 않습니다.</div>

                    <div class="ai-desk-section-title" style="margin-top:20px"><h3>장기 모니터링 세션</h3><small data-ai-session-count>0 active</small></div>
                    <div class="ai-desk-list" data-ai-sessions><div class="ai-desk-empty">아직 만든 session이 없습니다.</div></div>

                    <div class="ai-desk-section-title" style="margin-top:20px"><h3>새 세션 열기</h3><small>persistent</small></div>
                    <form class="ai-desk-form" data-ai-session-form>
                        <label class="ai-desk-label">세션 이름<input class="ai-desk-input" name="name" maxlength="80" value="시장 이벤트 자문" placeholder="예: BTC 반등 감시"></label>
                        <div class="ai-desk-label">provider<div class="ai-desk-check-grid"><label class="ai-desk-check"><input type="checkbox" name="provider" value="gpt" checked> GPT / Codex</label><label class="ai-desk-check"><input type="checkbox" name="provider" value="claude" checked> Claude</label></div></div>
                        <div class="ai-desk-label">감시 이벤트<div class="ai-desk-check-grid"><label class="ai-desk-check"><input type="checkbox" name="eventType" value="BUY_SIGNAL" checked> 매수 신호</label><label class="ai-desk-check"><input type="checkbox" name="eventType" value="SELL_SIGNAL" checked> 매도 신호</label><label class="ai-desk-check"><input type="checkbox" name="eventType" value="REBOUND_CANDIDATE"> 반등 후보</label><label class="ai-desk-check"><input type="checkbox" name="eventType" value="BREAKING_NEWS"> 속보</label><label class="ai-desk-check"><input type="checkbox" name="eventType" value="BUNDLE_SUGGESTION"> 리밸런싱 제안</label><label class="ai-desk-check"><input type="checkbox" name="eventType" value="TRADE_EXECUTED"> 체결 알림</label></div></div>
                        <label class="ai-desk-label">코인 필터<input class="ai-desk-input" name="coins" placeholder="전체 코인 · BTC 또는 KRW-BTC"></label>
                        <label class="ai-desk-label">동일 이벤트 재자문 간격 (초)<input class="ai-desk-input" type="number" name="cooldownSeconds" min="30" max="86400" step="30" value="300"></label>
                        <label class="ai-desk-check"><input type="checkbox" name="autoConsult" checked> 이벤트 발생 시 자동 자문</label>
                        <button type="submit" class="ai-desk-button primary">장기 모니터링 시작</button>
                    </form>
                </div>
                <div class="ai-desk-column">
                    <div class="ai-desk-section-title"><h3>실시간 이벤트</h3><small data-ai-snapshot>snapshot 대기</small></div>
                    <div class="ai-desk-list" data-ai-events><div class="ai-desk-empty">자동매매 루프가 분석을 완료하면 이벤트가 여기에 표시됩니다.</div></div>
                    <div class="ai-desk-note">이벤트 카드에서 선택한 provider에 수동 자문을 요청할 수 있습니다.</div>
                    <div class="ai-desk-section-title" style="margin-top:20px"><h3>AI 자문 결과</h3><small data-ai-consultation-count>0 consultations</small></div>
                    <div class="ai-desk-list" data-ai-consultations><div class="ai-desk-empty">아직 자문 결과가 없습니다.</div></div>
                </div>
            </div>`;
    }

    function renderProviders() {
        const container = $('[data-ai-providers]');
        if (!container) return;
        if (!state.providers?.providers?.length) {
            container.innerHTML = '<div class="ai-desk-empty">provider 상태를 불러오지 못했습니다.</div>';
            return;
        }
        container.innerHTML = state.providers.providers.map(provider => {
            const statusClass = provider.ready ? 'ready' : provider.status === 'NOT_AUTHENTICATED' ? 'warn' : 'error';
            const text = provider.ready ? 'READY' : provider.status === 'NOT_AUTHENTICATED' ? 'LOGIN NEEDED' : provider.status || 'UNAVAILABLE';
            return `<article class="ai-desk-provider ${statusClass}"><div class="ai-desk-item-head"><span class="ai-desk-name">${esc(provider.label || providerName(provider.id))}</span><span class="ai-desk-state ${statusClass}">${esc(text)}</span></div><div class="ai-desk-detail">${esc(provider.detail || provider.subscriptionLabel || '')}</div><div class="ai-desk-detail" style="margin-top:5px;font:10px/1.3 'SFMono-Regular',Consolas,monospace">${provider.ready ? 'subscription session available' : 'check local CLI login'}</div></article>`;
        }).join('');
    }

    function renderSessions() {
        const container = $('[data-ai-sessions]');
        const count = $('[data-ai-session-count]');
        if (!container) return;
        const active = state.sessions.filter(session => session.status === 'RUNNING').length;
        if (count) count.textContent = `${active} active / ${state.sessions.length} total`;
        if (!state.sessions.length) {
            container.innerHTML = '<div class="ai-desk-empty">아직 만든 session이 없습니다.</div>';
            return;
        }
        container.innerHTML = state.sessions.map(session => {
            const statusClass = session.status === 'PAUSED' ? 'paused' : session.status === 'STOPPED' ? 'stopped' : '';
            const statusText = session.status === 'RUNNING' ? 'RUNNING' : session.status;
            const actions = session.status === 'RUNNING'
                ? `<button type="button" class="ai-desk-button" data-ai-session-action="pause" data-session-id="${esc(session.id)}">일시정지</button><button type="button" class="ai-desk-button danger" data-ai-session-action="stop" data-session-id="${esc(session.id)}">종료</button>`
                : session.status === 'PAUSED'
                    ? `<button type="button" class="ai-desk-button" data-ai-session-action="resume" data-session-id="${esc(session.id)}">재개</button><button type="button" class="ai-desk-button danger" data-ai-session-action="stop" data-session-id="${esc(session.id)}">종료</button>`
                    : '';
            return `<article class="ai-desk-session ${statusClass}"><div class="ai-desk-item-head"><span class="ai-desk-name">${esc(session.name)}</span><span class="ai-desk-state ${statusClass === 'stopped' ? 'error' : statusClass === 'paused' ? 'warn' : 'ready'}">${statusText}</span></div><div class="ai-desk-detail">${esc((session.providers || []).map(providerName).join(' + '))}<br>${esc((session.eventTypes || []).map(type => labels[type] || type).join(' · '))}<br>${esc(session.coins?.length ? session.coins.map(symbol).join(', ') : '전체 코인')} · 이벤트 ${session.eventCount || 0} · 자문 ${session.consultationCount || 0}</div><div class="ai-desk-detail">시작 ${esc(time(session.startedAt))} · 마지막 이벤트 ${esc(time(session.lastEventAt))}</div><div class="ai-desk-actions">${actions}</div></article>`;
        }).join('');
    }

    function renderEvents() {
        const container = $('[data-ai-events]');
        if (!container) return;
        if (!state.events.length) {
            container.innerHTML = '<div class="ai-desk-empty">자동매매 루프가 분석을 완료하면 이벤트가 여기에 표시됩니다.</div>';
            return;
        }
        container.innerHTML = state.events.slice(0, 40).map(event => {
            const typeClass = event.type === 'SELL_SIGNAL' ? 'sell' : event.type === 'BREAKING_NEWS' ? 'news' : '';
            return `<article class="ai-desk-event ${typeClass}"><div class="ai-desk-item-head"><span class="ai-desk-event-title">${esc(event.coin ? symbol(event.coin) : 'MARKET')} · ${esc(labels[event.type] || event.type)}</span><span class="ai-desk-state ${event.action === 'SELL' ? 'error' : event.action === 'BUY' ? 'ready' : 'warn'}">${esc(event.action || 'WAIT')}</span></div><div class="ai-desk-event-meta">${esc(time(event.timestamp))} · ${event.price == null ? '-' : `${esc(won(event.price))}원`}${event.signalStrength ? ` · ${esc(event.signalStrength)}` : ''}<br>${esc(event.reason || event.snapshot?.title || '관찰 이벤트')}</div><div class="ai-desk-actions"><button type="button" class="ai-desk-button" data-ai-consult-event="${esc(event.id)}">이 이벤트 자문</button></div></article>`;
        }).join('');
    }

    function renderConsultations() {
        const container = $('[data-ai-consultations]');
        const count = $('[data-ai-consultation-count]');
        if (!container) return;
        if (count) count.textContent = `${state.consultations.length} consultations`;
        if (!state.consultations.length) {
            container.innerHTML = '<div class="ai-desk-empty">아직 자문 결과가 없습니다.</div>';
            return;
        }
        container.innerHTML = state.consultations.slice(0, 40).map(consultation => {
            const statusClass = consultation.status === 'COMPLETED' ? 'completed' : consultation.status === 'RUNNING' ? '' : 'failed';
            const event = consultation.event || {};
            const results = (consultation.results || []).map(result => {
                if (result.status !== 'COMPLETED' || !result.advice) return `<div class="ai-desk-rationale" style="color:var(--ai-red)">${esc(providerName(result.provider))}: ${esc(result.error || '응답 실패')}</div>`;
                const advice = result.advice;
                const actionClass = advice.action === 'SELL' ? 'sell' : ['HOLD', 'WAIT'].includes(advice.action) ? 'wait' : '';
                const risks = (advice.risks || []).map(risk => `<li>${esc(risk)}</li>`).join('');
                return `<div class="ai-desk-advice"><div class="ai-desk-action ${actionClass}">${esc(advice.action)}<br><small>${n(advice.confidence)}%</small></div><div class="ai-desk-rationale"><strong>${esc(providerName(result.provider))}</strong> · ${esc(advice.horizon || '')}<br>${esc(advice.rationale || '')}${risks ? `<ul class="ai-desk-risks">${risks}</ul>` : ''}<div class="ai-desk-detail">무효화 조건: ${esc(advice.invalidation || '추가 확인 필요')}</div></div></div>`;
            }).join('');
            return `<article class="ai-desk-consultation ${statusClass}"><div class="ai-desk-item-head"><span class="ai-desk-event-title">${esc(event.coin ? symbol(event.coin) : 'MARKET')} · ${esc(labels[event.type] || event.type || '자문')}</span><span class="ai-desk-state ${statusClass === 'completed' ? 'ready' : statusClass === 'failed' ? 'error' : 'warn'}">${esc(consultation.status || '-')}</span></div><div class="ai-desk-consultation-meta">${esc(time(consultation.createdAt))} · ${(consultation.providerSelection || []).map(providerName).map(esc).join(' + ')}${consultation.auto ? ' · 자동 자문' : ' · 수동 자문'}</div>${results || (consultation.status === 'RUNNING' ? '<div class="ai-desk-rationale">응답을 기다리는 중…</div>' : '')}${consultation.error ? `<div class="ai-desk-rationale" style="color:var(--ai-red)">${esc(consultation.error)}</div>` : ''}</article>`;
        }).join('');
    }

    function renderSnapshot(snapshot) {
        if (!snapshot) return;
        state.sessions = snapshot.sessions || [];
        state.events = snapshot.events || [];
        state.consultations = snapshot.consultations || [];
        renderSessions();
        renderEvents();
        renderConsultations();
        const snapshotElement = $('[data-ai-snapshot]');
        if (snapshotElement) snapshotElement.textContent = snapshot.latestSnapshot?.timestamp ? `snapshot ${time(snapshot.latestSnapshot.timestamp)}` : 'snapshot 대기';
        const sync = $('#ai-desk-root')?.querySelector?.('[data-ai-snapshot]');
        if (sync && snapshot.updatedAt) sync.title = `동기화 ${time(snapshot.updatedAt)}`;
    }

    async function load(force = false) {
        if (state.loading) return;
        state.loading = true;
        try {
            const [providers, snapshot] = await Promise.all([request(force ? '/ai/providers?refresh=true' : '/ai/providers'), request('/ai/monitoring?limit=40')]);
            state.providers = providers;
            renderProviders();
            renderSnapshot(snapshot);
        } catch (error) {
            toast(`AI Desk 로드 실패: ${error.message}`, 'error');
        } finally {
            state.loading = false;
        }
    }

    async function createSession(event) {
        event.preventDefault();
        const form = event.currentTarget;
        const providers = $$('input[name="provider"]:checked').map(input => input.value);
        const eventTypes = $$('input[name="eventType"]:checked').map(input => input.value);
        if (!providers.length || !eventTypes.length) return toast('provider와 감시 이벤트를 하나 이상 선택해주세요', 'warning');
        try {
            await request('/ai/sessions', { method: 'POST', body: JSON.stringify({ name: form.name.value, providers, eventTypes, coins: form.coins.value, cooldownSeconds: Number(form.cooldownSeconds.value), autoConsult: form.autoConsult.checked }) });
            toast('장기 AI 모니터링 세션을 시작했습니다', 'success');
            await load(false);
        } catch (error) {
            toast(`AI session 시작 실패: ${error.message}`, 'error');
        }
    }

    async function updateSession(sessionId, action) {
        try {
            await request(`/ai/sessions/${sessionId}/${action}`, { method: 'POST' });
            toast(action === 'stop' ? 'AI 모니터링 세션을 종료했습니다' : `session을 ${action === 'pause' ? '일시정지' : '재개'}했습니다`, 'success');
            await load(false);
        } catch (error) {
            toast(`session 상태 변경 실패: ${error.message}`, 'error');
        }
    }

    async function consult(eventId) {
        const providers = $$('input[name="provider"]:checked').map(input => input.value);
        try {
            const result = await request('/ai/consult', { method: 'POST', body: JSON.stringify({ eventId, provider: providers.length === 2 ? 'both' : providers[0] || 'both' }) });
            if (result?.consultation) {
                state.consultations = [result.consultation, ...state.consultations.filter(item => item.id !== result.consultation.id)].slice(0, 80);
                renderConsultations();
            }
            toast(result?.consultation?.status === 'COMPLETED' ? 'AI 자문 결과를 받았습니다' : 'AI 자문이 완료되지 않았습니다', result?.consultation?.status === 'COMPLETED' ? 'success' : 'warning');
        } catch (error) {
            toast(`AI 자문 실패: ${error.message}`, 'error');
        }
    }

    function bind() {
        $('[data-ai-refresh]')?.addEventListener('click', () => load(true));
        $('[data-ai-session-form]')?.addEventListener('submit', createSession);
        host.addEventListener('click', event => {
            const sessionAction = event.target.closest('[data-ai-session-action]');
            if (sessionAction) return updateSession(sessionAction.dataset.sessionId, sessionAction.dataset.aiSessionAction);
            const consultButton = event.target.closest('[data-ai-consult-event]');
            if (consultButton) consult(consultButton.dataset.aiConsultEvent);
        });
        if (typeof window.io === 'function') {
            const socket = window.io();
            socket.on('ai-monitoring-event', data => { if (data?.event) { state.events = [data.event, ...state.events.filter(item => item.id !== data.event.id)].slice(0, 80); renderEvents(); } });
            socket.on('ai-consultation', data => { if (data?.consultation) { state.consultations = [data.consultation, ...state.consultations.filter(item => item.id !== data.consultation.id)].slice(0, 80); renderConsultations(); } });
            socket.on('ai-session-update', data => { if (data?.session) { state.sessions = [data.session, ...state.sessions.filter(item => item.id !== data.session.id)]; renderSessions(); } });
        }
    }

    mountMarkup();
    const legacyContainer = document.querySelector('body > .container');
    if (legacyContainer) legacyContainer.prepend(host);
    bind();
    load(false);
})();
