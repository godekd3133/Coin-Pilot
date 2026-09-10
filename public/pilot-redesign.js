/*
 * CoinPilot Signal Ledger redesign
 * --------------------------------
 * The legacy dashboard in public/index.html owns the original compatibility
 * loaders. This module owns the visible UI and talks to the same API contract.
 * Keeping the surfaces separate lets us redesign the experience without
 * changing the trading engine or silently changing the meaning of a mode.
 */

(() => {
    'use strict';

    const root = document.getElementById('pilot-redesign-root');
    if (!root) return;

    const state = {
        view: 'overview',
        activeMode: 'paper',
        actualMode: 'DRY_RUN',
        liveEligible: false,
        connected: false,
        lastSync: null,
        status: null,
        account: null,
        pnl: null,
        today: null,
        statistics: [],
        validation: null,
        paper: null,
        portfolioAnalysis: null,
        portfolioHistory: [],
        trades: [],
        marketPrices: [],
        targetCoins: [],
        selectedCoin: localStorage.getItem('selectedCoin') || 'KRW-BTC',
        candles: [],
        candleInterval: 5,
        chartPeriod: '24h',
        analysis: null,
        analysisFilter: 'all',
        analysisSort: 'score',
        news: null,
        newsFilter: 'all',
        ai: {
            providers: null,
            sessions: [],
            events: [],
            consultations: [],
            loading: false
        },
        settings: null,
        settingsLoaded: false,
        historyLoaded: false,
        trade: {
            overview: { side: 'buy', amount: 50000 },
            market: { side: 'buy', amount: 50000 },
            trade: { side: 'buy', amount: 50000 }
        },
        refreshing: false,
        viewLoading: new Set()
    };

    const $ = (selector) => root.querySelector(selector);
    const $$ = (selector) => Array.from(root.querySelectorAll(selector));
    const byId = (id) => root.querySelector(`#${id}`);

    function number(value, fallback = 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function formatWon(value, suffix = '원') {
        return `${Math.round(number(value)).toLocaleString('ko-KR')}${suffix}`;
    }

    function formatPrice(value) {
        const parsed = number(value);
        if (parsed === 0) return '0';
        const digits = parsed < 1 ? 8 : parsed < 100 ? 4 : 0;
        return parsed.toLocaleString('ko-KR', { maximumFractionDigits: digits });
    }

    function formatQuantity(value) {
        return number(value).toLocaleString('ko-KR', { maximumFractionDigits: 8 });
    }

    function formatPercent(value, decimals = 2) {
        const parsed = number(value);
        return `${parsed >= 0 ? '+' : ''}${parsed.toFixed(decimals)}%`;
    }

    function formatSignedWon(value) {
        const parsed = number(value);
        return `${parsed >= 0 ? '+' : ''}${formatWon(parsed)}`;
    }

    function formatTime(value, withSeconds = false) {
        if (!value) return '-';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '-';
        return date.toLocaleTimeString('ko-KR', {
            hour: '2-digit',
            minute: '2-digit',
            ...(withSeconds ? { second: '2-digit' } : {})
        });
    }

    function formatDateTime(value) {
        if (!value) return '-';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '-';
        return date.toLocaleString('ko-KR', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit'
        });
    }

    function symbolOf(coin) {
        return String(coin || '').replace(/^KRW-/, '');
    }

    function classForValue(value) {
        return number(value) >= 0 ? 'pilot-positive' : 'pilot-negative';
    }

    function isPaperMode() {
        return state.actualMode !== 'LIVE';
    }

    function canTrade() {
        if (state.activeMode === 'paper') return isPaperMode();
        return state.actualMode === 'LIVE' && state.liveEligible;
    }

    function tradeBlockReason() {
        if (state.activeMode === 'paper' && state.actualMode === 'LIVE') {
            return '현재 서버가 실제투자 모드라 모의 주문을 실행할 수 없습니다.';
        }
        if (state.activeMode === 'live' && state.actualMode !== 'LIVE') {
            return '서버 설정이 모의투자라 실제 주문은 전송되지 않습니다.';
        }
        if (state.activeMode === 'live' && !state.liveEligible) {
            return '검증 게이트를 모두 통과하기 전까지 실제 주문은 잠깁니다.';
        }
        return '';
    }

    async function requestJSON(path, options = {}) {
        const timeoutMs = Number(options.timeoutMs) || 12000;
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
        const { timeoutMs: _timeoutMs, signal: externalSignal, ...fetchOptions } = options;
        try {
            const response = await fetch(`/api${path}`, {
                ...fetchOptions,
                signal: externalSignal || controller.signal,
                headers: {
                    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
                    ...(options.headers || {})
                }
            });
            let data = null;
            try {
                data = await response.json();
            } catch {
                data = null;
            }
            if (!response.ok) {
                const error = new Error(data?.error || `HTTP ${response.status}`);
                error.status = response.status;
                throw error;
            }
            return data;
        } catch (error) {
            if (error?.name === 'AbortError') throw new Error('서버 응답 시간이 초과되었습니다. 연결 상태를 확인해주세요.');
            throw error;
        } finally {
            window.clearTimeout(timeoutId);
        }
    }

    function setText(id, value) {
        const element = byId(id);
        if (element) element.textContent = value;
    }

    function showToast(message, type = 'info') {
        const stack = byId('pilot-toast-stack');
        if (!stack) return;
        const icon = type === 'success' ? 'check-circle' : type === 'error' ? 'warning-circle' : type === 'warning' ? 'warning' : 'info';
        const toast = document.createElement('div');
        toast.className = `pilot-toast is-${type}`;
        toast.innerHTML = `<i class="ph ph-${icon}" aria-hidden="true"></i><span>${escapeHtml(message)}</span>`;
        stack.appendChild(toast);
        window.setTimeout(() => toast.remove(), 4800);
    }

    function clearToasts() {
        const stack = byId('pilot-toast-stack');
        if (stack) stack.innerHTML = '';
    }

    function showModal(title, body, footer = '') {
        const modalRoot = byId('pilot-modal-root');
        if (!modalRoot) return;
        modalRoot.innerHTML = `
            <div class="pilot-modal-backdrop" data-pilot-modal-close>
                <section class="pilot-modal" role="dialog" aria-modal="true" aria-labelledby="pilot-modal-title">
                    <header class="pilot-modal-header">
                        <h2 class="pilot-modal-title" id="pilot-modal-title">${escapeHtml(title)}</h2>
                        <button type="button" class="pilot-icon-button" data-pilot-modal-close aria-label="닫기"><i class="ph ph-x" aria-hidden="true"></i></button>
                    </header>
                    <div class="pilot-modal-body">${body}</div>
                    <footer class="pilot-modal-footer">${footer || '<button type="button" class="pilot-button" data-pilot-modal-close>닫기</button>'}</footer>
                </section>
            </div>
        `;
    }

    function closeModal() {
        const modalRoot = byId('pilot-modal-root');
        if (modalRoot) modalRoot.innerHTML = '';
    }

    function tradePanelMarkup(prefix, subtitle) {
        return `
            <aside class="pilot-panel pilot-execution-panel" data-pilot-trade-panel="${prefix}">
                <div class="pilot-panel-header">
                    <div>
                        <h2 class="pilot-panel-title">거래하기</h2>
                        <p class="pilot-panel-subtitle">${escapeHtml(subtitle)}</p>
                    </div>
                    <span class="pilot-status-pill" data-pilot-trade-mode-label="${prefix}">모의투자</span>
                </div>
                <div class="pilot-trade-lock" data-pilot-trade-lock="${prefix}">
                    <i class="ph ph-lock-key-open" aria-hidden="true"></i>
                    <div data-pilot-trade-lock-copy="${prefix}">가상 자금으로 주문 흐름을 확인합니다.</div>
                </div>
                <div class="pilot-trade-tabs" role="tablist" aria-label="거래 방향">
                    <button type="button" class="pilot-trade-tab is-active" data-pilot-trade-side="${prefix}" data-trade-side="buy">매수</button>
                    <button type="button" class="pilot-trade-tab" data-pilot-trade-side="${prefix}" data-trade-side="sell">매도</button>
                </div>
                <div class="pilot-form">
                    <label class="pilot-field">
                        <span class="pilot-field-label">자산 <span class="pilot-field-hint">시장가 기준</span></span>
                        <select class="pilot-select" data-pilot-trade-coin="${prefix}" aria-label="거래 자산"></select>
                    </label>
                    <label class="pilot-field">
                        <span class="pilot-field-label"><span data-pilot-trade-amount-label="${prefix}">주문 금액 (KRW)</span><span class="pilot-field-hint" data-pilot-trade-balance="${prefix}">잔액 -</span></span>
                        <input class="pilot-input" type="number" min="1000" step="1000" value="50000" data-pilot-trade-amount="${prefix}" aria-label="주문 금액">
                    </label>
                    <div class="pilot-amount-presets" aria-label="주문 금액 빠른 선택">
                        <button type="button" class="pilot-filter-chip" data-pilot-trade-preset="${prefix}" data-pilot-preset="25">25%</button>
                        <button type="button" class="pilot-filter-chip" data-pilot-trade-preset="${prefix}" data-pilot-preset="50">50%</button>
                        <button type="button" class="pilot-filter-chip" data-pilot-trade-preset="${prefix}" data-pilot-preset="75">75%</button>
                        <button type="button" class="pilot-filter-chip" data-pilot-trade-preset="${prefix}" data-pilot-preset="100">전액</button>
                    </div>
                    <div class="pilot-trade-summary">
                        <div class="pilot-trade-summary-item"><span class="pilot-trade-summary-label">현재가</span><strong class="pilot-trade-summary-value" data-pilot-trade-price="${prefix}">-</strong></div>
                        <div class="pilot-trade-summary-item"><span class="pilot-trade-summary-label">예상 수량</span><strong class="pilot-trade-summary-value" data-pilot-trade-quantity="${prefix}">-</strong></div>
                        <div class="pilot-trade-summary-item"><span class="pilot-trade-summary-label">보유 평가</span><strong class="pilot-trade-summary-value" data-pilot-trade-holding="${prefix}">-</strong></div>
                        <div class="pilot-trade-summary-item"><span class="pilot-trade-summary-label">예상 수수료</span><strong class="pilot-trade-summary-value" data-pilot-trade-fee="${prefix}">-</strong></div>
                    </div>
                    <button type="button" class="pilot-trade-submit" data-pilot-trade-submit="${prefix}" data-trade-side="buy">모의 주문 실행</button>
                    <div class="pilot-trade-disclaimer" data-pilot-trade-disclaimer="${prefix}">주문 전 자산·수량·모드를 다시 확인하세요.</div>
                </div>
            </aside>
        `;
    }

    const aiEventLabels = {
        BUY_SIGNAL: '매수 신호',
        SELL_SIGNAL: '매도 신호',
        REBOUND_CANDIDATE: '반등 후보',
        BREAKING_NEWS: '속보',
        BUNDLE_SUGGESTION: '리밸런싱 제안',
        TRADE_EXECUTED: '체결 알림'
    };

    function aiProviderLabel(provider) {
        return provider === 'gpt' ? 'GPT / Codex' : provider === 'claude' ? 'Claude' : String(provider || '-');
    }

    function aiDeskMarkup() {
        return `
            <section class="pilot-page pilot-ai-page" data-pilot-page="ai">
                <div class="pilot-page-heading">
                    <div><div class="pilot-kicker">AI advisory / long-run watch</div><h1 class="pilot-page-title">AI 판단 데스크</h1><p class="pilot-page-description">특정 이벤트가 생길 때 GPT·Claude 구독 세션에 빠르게 자문을 요청합니다. AI 의견은 읽기 전용이며 기존 설정값 기반 자동 주문과 분리됩니다.</p></div>
                    <div class="pilot-heading-actions"><span class="pilot-sync-note" id="pilot-ai-sync">마지막 동기화 -</span><button type="button" class="pilot-button" data-pilot-ai-refresh><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> 새로고침</button></div>
                </div>
                <div class="pilot-ai-policy"><div><strong><i class="ph ph-shield-check" aria-hidden="true"></i> 자문 전용 경계</strong><span>AI의 BUY/SELL은 기록되는 의견일 뿐 주문 명령이 아닙니다. 기존 자동매매는 설정값 계약으로만 실행됩니다.</span></div><span class="pilot-ai-policy-badge">advisory only · no order routing</span></div>
                <div class="pilot-ai-grid">
                    <div class="pilot-ai-column">
                        <section class="pilot-panel"><div class="pilot-ai-panel-header"><div><h2 class="pilot-panel-title">구독 provider</h2><p class="pilot-panel-subtitle">로컬 로그인 세션의 현재 상태</p></div><span class="pilot-status-pill is-warning" id="pilot-ai-provider-policy">API key 미사용</span></div><div class="pilot-ai-panel-body"><div id="pilot-ai-providers" class="pilot-ai-providers"><div class="pilot-ai-empty">provider 상태를 확인하는 중입니다.</div></div><div class="pilot-inline-note"><i class="ph ph-info" aria-hidden="true"></i><span>GPT는 Codex CLI, Claude는 Claude CLI의 인증 상태만 사용합니다.</span></div></div></section>
                        <section class="pilot-panel"><div class="pilot-ai-panel-header"><div><h2 class="pilot-panel-title">장기 모니터링 세션</h2><p class="pilot-panel-subtitle">중지·일시정지·재개와 이력을 보존합니다.</p></div><span class="pilot-status-pill" id="pilot-ai-session-count">0 active</span></div><div class="pilot-ai-panel-body"><div id="pilot-ai-sessions" class="pilot-ai-session-list"><div class="pilot-ai-empty">아직 모니터링 세션이 없습니다.</div></div></div></section>
                <section class="pilot-panel"><div class="pilot-ai-panel-header"><div><h2 class="pilot-panel-title">새 세션 열기</h2><p class="pilot-panel-subtitle">이벤트와 자동 자문 간격을 직접 선택합니다.</p></div></div><div class="pilot-ai-panel-body"><form class="pilot-ai-session-form" id="pilot-ai-session-form"><label class="pilot-ai-form-label">세션 이름<input class="pilot-ai-form-input" id="pilot-ai-session-name" maxlength="80" value="시장 이벤트 자문" placeholder="예: BTC 반등 감시"></label><div class="pilot-ai-form-label">provider<div class="pilot-ai-check-grid"><label class="pilot-ai-check"><input type="checkbox" name="pilot-ai-provider" value="gpt" checked> GPT / Codex</label><label class="pilot-ai-check"><input type="checkbox" name="pilot-ai-provider" value="claude" checked> Claude</label></div></div><div class="pilot-ai-form-label">감시 이벤트<div class="pilot-ai-check-grid"><label class="pilot-ai-check"><input type="checkbox" name="pilot-ai-event" value="BUY_SIGNAL" checked> 매수 신호</label><label class="pilot-ai-check"><input type="checkbox" name="pilot-ai-event" value="SELL_SIGNAL" checked> 매도 신호</label><label class="pilot-ai-check"><input type="checkbox" name="pilot-ai-event" value="REBOUND_CANDIDATE"> 반등 후보</label><label class="pilot-ai-check"><input type="checkbox" name="pilot-ai-event" value="BREAKING_NEWS"> 속보</label><label class="pilot-ai-check"><input type="checkbox" name="pilot-ai-event" value="BUNDLE_SUGGESTION"> 리밸런싱 제안</label><label class="pilot-ai-check"><input type="checkbox" name="pilot-ai-event" value="TRADE_EXECUTED"> 체결 알림</label></div></div><label class="pilot-ai-form-label">코인 필터 <small>선택 사항 · BTC 또는 KRW-BTC</small><input class="pilot-ai-form-input" id="pilot-ai-session-coins" placeholder="전체 코인 감시"></label><div class="pilot-field-row"><label class="pilot-ai-form-label">재자문 간격 (초)<input class="pilot-ai-form-input" id="pilot-ai-cooldown" type="number" min="30" max="86400" step="30" value="300"></label><label class="pilot-ai-form-label">자동 자문<label class="pilot-ai-check"><input id="pilot-ai-auto-consult" type="checkbox" checked> 이벤트 즉시 요청</label></label></div><button class="pilot-button is-primary" type="submit"><i class="ph ph-broadcast" aria-hidden="true"></i> 장기 모니터링 시작</button><div class="pilot-inline-note"><i class="ph ph-database" aria-hidden="true"></i><span>세션·이벤트·자문 결과는 <code>ai_monitoring_sessions.json</code>에 기록됩니다.</span></div></form></div></section>
                    </div>
                    <div class="pilot-ai-column">
                        <section class="pilot-panel"><div class="pilot-ai-panel-header"><div><h2 class="pilot-panel-title">실시간 이벤트</h2><p class="pilot-panel-subtitle">자동매매 분석 snapshot에서 생성된 관찰 이벤트</p></div><span class="pilot-status-pill is-warning" id="pilot-ai-snapshot-time">snapshot 대기</span></div><div class="pilot-ai-panel-body"><div id="pilot-ai-events" class="pilot-ai-event-list"><div class="pilot-ai-empty">자동매매 루프가 분석을 완료하면 이벤트가 여기에 표시됩니다.</div></div><div class="pilot-inline-note"><i class="ph ph-cursor-click" aria-hidden="true"></i><span>카드의 자문 버튼은 선택한 provider에만 snapshot을 보냅니다.</span></div></div></section>
                        <section class="pilot-panel"><div class="pilot-ai-panel-header"><div><h2 class="pilot-panel-title">AI 자문 결과</h2><p class="pilot-panel-subtitle">provider별 의견·근거·위험·무효화 조건</p></div><span class="pilot-status-pill" id="pilot-ai-consultation-count">0 consultations</span></div><div class="pilot-ai-panel-body"><div id="pilot-ai-consultations" class="pilot-ai-consultation-list"><div class="pilot-ai-empty">아직 자문 결과가 없습니다.</div></div></div></section>
                    </div>
                </div>
            </section>
        `;
    }

    function mountAiDesk() {
        const newsNav = root.querySelector('[data-pilot-view="news"]');
        if (newsNav) newsNav.insertAdjacentHTML('beforebegin', '<button type="button" class="pilot-nav-button" data-pilot-view="ai"><i class="ph ph-sparkle" aria-hidden="true"></i><span>AI 자문</span></button>');
        const newsPage = root.querySelector('[data-pilot-page="news"]');
        if (newsPage) newsPage.insertAdjacentHTML('beforebegin', aiDeskMarkup());
    }

    function activateView(view) {
        const nextView = String(view || 'overview');
        state.view = nextView;
        $$('[data-pilot-page]').forEach(page => page.classList.toggle('is-active', page.dataset.pilotPage === nextView));
        $$('[data-pilot-view]').forEach(button => button.classList.toggle('is-active', button.dataset.pilotView === nextView));
        if (nextView === 'ai') loadAiDesk(false);
    }

    function renderAiProviders(status) {
        const container = byId('pilot-ai-providers');
        const policy = byId('pilot-ai-provider-policy');
        if (!container) return;
        if (policy) policy.textContent = status?.usesApiKeys === false ? 'API key 미사용' : '로컬 세션 확인';
        if (!status?.providers?.length) {
            container.innerHTML = '<div class="pilot-ai-empty" style="grid-column:1/-1">provider 상태를 불러오지 못했습니다.</div>';
            return;
        }
        container.innerHTML = status.providers.map(provider => {
            const stateClass = provider.ready ? 'is-ready' : provider.status === 'NOT_AUTHENTICATED' ? 'is-warning' : 'is-error';
            const stateText = provider.ready ? 'READY' : provider.status === 'NOT_AUTHENTICATED' ? 'LOGIN NEEDED' : provider.status || 'UNAVAILABLE';
            return `<article class="pilot-ai-provider ${stateClass}"><div class="pilot-ai-provider-head"><span class="pilot-ai-provider-name">${escapeHtml(provider.label || aiProviderLabel(provider.id))}</span><span class="pilot-ai-provider-state ${stateClass}">${escapeHtml(stateText)}</span></div><div class="pilot-ai-provider-detail">${escapeHtml(provider.detail || provider.subscriptionLabel || '')}</div><div class="pilot-ai-provider-detail" style="margin-top:4px;font-family:'SFMono-Regular',Consolas,monospace;font-size:10px">${provider.ready ? 'subscription session available' : 'check local CLI login'}</div></article>`;
        }).join('');
    }

    function renderAiSessions(sessions) {
        const container = byId('pilot-ai-sessions');
        const count = byId('pilot-ai-session-count');
        if (!container) return;
        const activeCount = (sessions || []).filter(session => session.status === 'RUNNING').length;
        if (count) count.textContent = `${activeCount} active / ${(sessions || []).length} total`;
        if (!sessions?.length) {
            container.innerHTML = '<div class="pilot-ai-empty">아직 모니터링 세션이 없습니다.</div>';
            return;
        }
        container.innerHTML = sessions.map(session => {
            const statusClass = session.status === 'RUNNING' ? '' : session.status === 'PAUSED' ? 'is-paused' : 'is-stopped';
            const statusText = session.status === 'RUNNING' ? 'RUNNING' : session.status === 'PAUSED' ? 'PAUSED' : 'STOPPED';
            const providers = (session.providers || []).map(aiProviderLabel).join(' + ');
            const events = (session.eventTypes || []).map(type => aiEventLabels[type] || type).join(' · ');
            const coins = session.coins?.length ? session.coins.map(symbolOf).join(', ') : '전체 코인';
            const actions = session.status === 'RUNNING'
                ? `<button type="button" class="pilot-button" data-pilot-ai-session-action="pause" data-session-id="${session.id}">일시정지</button><button type="button" class="pilot-button is-danger" data-pilot-ai-session-action="stop" data-session-id="${session.id}">종료</button>`
                : session.status === 'PAUSED'
                    ? `<button type="button" class="pilot-button" data-pilot-ai-session-action="resume" data-session-id="${session.id}">재개</button><button type="button" class="pilot-button is-danger" data-pilot-ai-session-action="stop" data-session-id="${session.id}">종료</button>`
                    : '';
            return `<article class="pilot-ai-session ${statusClass}"><div class="pilot-ai-session-head"><span class="pilot-ai-session-name">${escapeHtml(session.name)}</span><span class="pilot-ai-provider-state ${session.status === 'RUNNING' ? 'is-ready' : session.status === 'PAUSED' ? 'is-warning' : 'is-error'}">${statusText}</span></div><div class="pilot-ai-session-meta">${escapeHtml(providers)}<br>${escapeHtml(events)}<br>${escapeHtml(coins)} · 이벤트 ${session.eventCount || 0} · 자문 ${session.consultationCount || 0}</div><div class="pilot-ai-session-meta">시작 ${escapeHtml(formatDateTime(session.startedAt))} · 마지막 이벤트 ${escapeHtml(formatDateTime(session.lastEventAt))}</div><div class="pilot-ai-actions">${actions}</div></article>`;
        }).join('');
    }

    function renderAiEvents(events) {
        const container = byId('pilot-ai-events');
        if (!container) return;
        if (!events?.length) {
            container.innerHTML = '<div class="pilot-ai-empty">자동매매 루프가 분석을 완료하면 이벤트가 여기에 표시됩니다.</div>';
            return;
        }
        container.innerHTML = events.slice(0, 40).map(event => {
            const eventClass = event.type === 'SELL_SIGNAL' ? 'is-sell' : event.type === 'BREAKING_NEWS' ? 'is-news' : 'is-buy';
            const actionClass = event.action === 'SELL' ? 'is-sell' : event.action === 'BUY' ? 'is-buy' : '';
            const coin = event.coin ? symbolOf(event.coin) : 'MARKET';
            const price = event.price === null || event.price === undefined ? '-' : `${formatPrice(event.price)}원`;
            return `<article class="pilot-ai-event ${eventClass}"><div class="pilot-ai-event-head"><span class="pilot-ai-event-title">${escapeHtml(coin)} · ${escapeHtml(aiEventLabels[event.type] || event.type)}</span><span class="pilot-ai-event-action ${actionClass}">${escapeHtml(event.action || 'WAIT')}</span></div><div class="pilot-ai-event-meta">${escapeHtml(formatDateTime(event.timestamp))} · ${escapeHtml(price)}${event.signalStrength ? ` · ${escapeHtml(event.signalStrength)}` : ''}<br>${escapeHtml(event.reason || event.snapshot?.title || '관찰 이벤트')}</div><div class="pilot-ai-actions"><button type="button" class="pilot-button is-small" data-pilot-ai-consult-event="${event.id}"><i class="ph ph-sparkle" aria-hidden="true"></i> 이 이벤트 자문</button></div></article>`;
        }).join('');
    }

    function renderAiConsultations(consultations) {
        const container = byId('pilot-ai-consultations');
        const count = byId('pilot-ai-consultation-count');
        if (!container) return;
        if (count) count.textContent = `${(consultations || []).length} consultations`;
        if (!consultations?.length) {
            container.innerHTML = '<div class="pilot-ai-empty">아직 자문 결과가 없습니다.</div>';
            return;
        }
        container.innerHTML = consultations.slice(0, 40).map(consultation => {
            const stateClass = consultation.status === 'COMPLETED' ? 'is-completed' : consultation.status === 'RUNNING' ? '' : 'is-failed';
            const event = consultation.event || {};
            const coin = event.coin ? symbolOf(event.coin) : 'MARKET';
            const results = (consultation.results || []).map(result => {
                if (result.status !== 'COMPLETED' || !result.advice) return `<div class="pilot-ai-rationale" style="color:var(--sl-red)">${escapeHtml(aiProviderLabel(result.provider))}: ${escapeHtml(result.error || '응답 실패')}</div>`;
                const advice = result.advice;
                const actionClass = advice.action === 'SELL' ? 'is-sell' : ['HOLD', 'WAIT'].includes(advice.action) ? 'is-wait' : '';
                const risks = (advice.risks || []).map(risk => `<li>${escapeHtml(risk)}</li>`).join('');
                return `<div class="pilot-ai-consultation-result"><div class="pilot-ai-advice-action ${actionClass}">${escapeHtml(advice.action)}<br><small>${number(advice.confidence)}%</small></div><div class="pilot-ai-rationale"><strong>${escapeHtml(aiProviderLabel(result.provider))}</strong> · ${escapeHtml(advice.horizon || '')}<br>${escapeHtml(advice.rationale || '')}${risks ? `<ul class="pilot-ai-risks">${risks}</ul>` : ''}<div class="pilot-ai-consultation-meta">무효화 조건: ${escapeHtml(advice.invalidation || '추가 확인 필요')}</div></div></div>`;
            }).join('');
            const pending = consultation.status === 'RUNNING' ? '<div class="pilot-ai-rationale">응답을 기다리는 중…</div>' : '';
            const error = consultation.error ? `<div class="pilot-ai-rationale" style="color:var(--sl-red)">${escapeHtml(consultation.error)}</div>` : '';
            return `<article class="pilot-ai-consultation ${stateClass}"><div class="pilot-ai-consultation-head"><span class="pilot-ai-event-title">${escapeHtml(coin)} · ${escapeHtml(aiEventLabels[event.type] || event.type || '자문')}</span><span class="pilot-ai-provider-state ${stateClass === 'is-completed' ? 'is-ready' : stateClass === 'is-failed' ? 'is-error' : 'is-warning'}">${escapeHtml(consultation.status || '-')}</span></div><div class="pilot-ai-consultation-meta">${escapeHtml(formatDateTime(consultation.createdAt))} · ${(consultation.providerSelection || []).map(aiProviderLabel).map(escapeHtml).join(' + ')}${consultation.auto ? ' · 자동 자문' : ' · 수동 자문'}</div>${results || pending || error}</article>`;
        }).join('');
    }

    function renderAiSnapshot(snapshot) {
        if (!snapshot) return;
        state.ai.sessions = snapshot.sessions || [];
        state.ai.events = snapshot.events || [];
        state.ai.consultations = snapshot.consultations || [];
        renderAiSessions(state.ai.sessions);
        renderAiEvents(state.ai.events);
        renderAiConsultations(state.ai.consultations);
        setText('pilot-ai-sync', snapshot.updatedAt ? `동기화 ${formatDateTime(snapshot.updatedAt)}` : '동기화 -');
        setText('pilot-ai-snapshot-time', snapshot.latestSnapshot?.timestamp ? `snapshot ${formatTime(snapshot.latestSnapshot.timestamp, true)}` : 'snapshot 대기');
    }

    async function loadAiDesk(force = false) {
        if (state.ai.loading) return;
        state.ai.loading = true;
        try {
            const providerPath = force ? '/ai/providers?refresh=true' : '/ai/providers';
            const [providers, snapshot] = await Promise.all([requestJSON(providerPath), requestJSON('/ai/monitoring?limit=40')]);
            state.ai.providers = providers;
            renderAiProviders(providers);
            renderAiSnapshot(snapshot);
        } catch (error) {
            showToast(`AI Desk를 불러오지 못했습니다: ${error.message}`, 'error');
        } finally {
            state.ai.loading = false;
        }
    }

    async function createAiSession(event) {
        event.preventDefault();
        const providers = $$('input[name="pilot-ai-provider"]:checked').map(input => input.value);
        const eventTypes = $$('input[name="pilot-ai-event"]:checked').map(input => input.value);
        if (!providers.length || !eventTypes.length) {
            showToast('provider와 감시 이벤트를 하나 이상 선택해주세요', 'warning');
            return;
        }
        try {
            await requestJSON('/ai/sessions', {
                method: 'POST',
                body: JSON.stringify({
                    name: byId('pilot-ai-session-name')?.value,
                    providers,
                    eventTypes,
                    coins: byId('pilot-ai-session-coins')?.value || '',
                    cooldownSeconds: number(byId('pilot-ai-cooldown')?.value, 300),
                    autoConsult: byId('pilot-ai-auto-consult')?.checked !== false
                })
            });
            showToast('장기 AI 모니터링 세션을 시작했습니다', 'success');
            await loadAiDesk(false);
        } catch (error) {
            showToast(`AI session 시작 실패: ${error.message}`, 'error');
        }
    }

    async function updateAiSession(sessionId, action) {
        try {
            await requestJSON(`/ai/sessions/${sessionId}/${action}`, { method: 'POST' });
            showToast(action === 'stop' ? 'AI 모니터링 세션을 종료했습니다' : `session을 ${action === 'pause' ? '일시정지' : '재개'}했습니다`, 'success');
            await loadAiDesk(false);
        } catch (error) {
            showToast(`session 상태 변경 실패: ${error.message}`, 'error');
        }
    }

    async function requestAiConsultation(eventId) {
        const providers = $$('input[name="pilot-ai-provider"]:checked').map(input => input.value);
        const provider = providers.length === 2 ? 'both' : providers[0] || 'both';
        showToast('AI 자문 요청 중…', 'info');
        try {
            const result = await requestJSON('/ai/consult', { method: 'POST', body: JSON.stringify({ eventId, provider }) });
            if (result?.consultation) handleAiConsultationUpdate(result.consultation);
            showToast(result?.consultation?.status === 'COMPLETED' ? 'AI 자문 결과를 받았습니다' : 'AI 자문이 완료되지 않았습니다', result?.consultation?.status === 'COMPLETED' ? 'success' : 'warning');
        } catch (error) {
            showToast(`AI 자문 실패: ${error.message}`, 'error');
        }
    }

    function handleAiMonitoringEvent(event) {
        state.ai.events = [event, ...state.ai.events.filter(item => item.id !== event.id)].slice(0, 80);
        if (state.view === 'ai') renderAiEvents(state.ai.events);
        if (['BUY_SIGNAL', 'SELL_SIGNAL'].includes(event.type)) showToast(`AI Desk 이벤트 · ${symbolOf(event.coin) || 'MARKET'} ${aiEventLabels[event.type]}`, event.type === 'SELL_SIGNAL' ? 'error' : 'info');
    }

    function handleAiConsultationUpdate(consultation) {
        state.ai.consultations = [consultation, ...state.ai.consultations.filter(item => item.id !== consultation.id)].slice(0, 80);
        if (state.view === 'ai') renderAiConsultations(state.ai.consultations);
    }

    function handleAiSessionUpdate(session) {
        state.ai.sessions = [session, ...state.ai.sessions.filter(item => item.id !== session.id)].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        if (state.view === 'ai') renderAiSessions(state.ai.sessions);
    }

    function bindAiDesk() {
        root.addEventListener('click', event => {
            const viewButton = event.target.closest('[data-pilot-view], [data-pilot-go]');
            if (viewButton && root.contains(viewButton)) {
                const view = viewButton.dataset.pilotView || viewButton.dataset.pilotGo;
                if (view) {
                    event.preventDefault();
                    activateView(view);
                    return;
                }
            }
            const refresh = event.target.closest('[data-pilot-ai-refresh]');
            if (refresh) {
                event.preventDefault();
                loadAiDesk(true);
                return;
            }
            const sessionAction = event.target.closest('[data-pilot-ai-session-action]');
            if (sessionAction) {
                event.preventDefault();
                updateAiSession(sessionAction.dataset.sessionId, sessionAction.dataset.pilotAiSessionAction);
                return;
            }
            const consult = event.target.closest('[data-pilot-ai-consult-event]');
            if (consult) {
                event.preventDefault();
                requestAiConsultation(consult.dataset.pilotAiConsultEvent);
            }
        });
        byId('pilot-ai-session-form')?.addEventListener('submit', createAiSession);
    }

    function initializeAiSocket() {
        if (typeof window.io !== 'function') return;
        const aiSocket = window.io();
        aiSocket.on('ai-monitoring-event', data => { if (data?.event) handleAiMonitoringEvent(data.event); });
        aiSocket.on('ai-consultation', data => { if (data?.consultation) handleAiConsultationUpdate(data.consultation); });
        aiSocket.on('ai-session-update', data => { if (data?.session) handleAiSessionUpdate(data.session); });
    }

    function renderShell() {
        root.innerHTML = `
            <div class="pilot-app">
                <aside class="pilot-sidebar" aria-label="주 메뉴">
                    <div class="pilot-brand">
                        <div class="pilot-brand-lockup"><span class="pilot-brand-mark"><i class="ph ph-compass" aria-hidden="true"></i></span><span class="pilot-brand-name">CoinPilot</span></div>
                        <p class="pilot-brand-subtitle">Better decisions<br>safer trading</p>
                    </div>
                    <nav class="pilot-sidebar-nav">
                        <div class="pilot-nav-label">Workspace</div>
                        <button type="button" class="pilot-nav-button is-active" data-pilot-view="overview"><i class="ph ph-chart-line-up" aria-hidden="true"></i><span>근거 로그</span></button>
                        <button type="button" class="pilot-nav-button" data-pilot-view="trade"><i class="ph ph-hand-coins" aria-hidden="true"></i><span>거래 실행</span></button>
                        <button type="button" class="pilot-nav-button" data-pilot-view="portfolio"><i class="ph ph-wallet" aria-hidden="true"></i><span>포트폴리오</span></button>
                        <button type="button" class="pilot-nav-button" data-pilot-view="market"><i class="ph ph-binoculars" aria-hidden="true"></i><span>시장 관찰</span></button>
                        <button type="button" class="pilot-nav-button" data-pilot-view="analysis"><i class="ph ph-function" aria-hidden="true"></i><span>전략 연구</span></button>
                        <button type="button" class="pilot-nav-button" data-pilot-view="news"><i class="ph ph-newspaper" aria-hidden="true"></i><span>뉴스 센터</span></button>
                        <div class="pilot-nav-label">Control</div>
                        <button type="button" class="pilot-nav-button" data-pilot-view="settings"><i class="ph ph-sliders-horizontal" aria-hidden="true"></i><span>설정</span></button>
                        <button type="button" class="pilot-nav-button" data-pilot-view="history"><i class="ph ph-clipboard-text" aria-hidden="true"></i><span>검증 기록</span></button>
                    </nav>
                    <div class="pilot-sidebar-bottom"><p class="pilot-sidebar-note">데이터로 더 나은 판단을,<br>더 안전한 거래를.</p><button type="button" class="pilot-nav-button" data-pilot-view="settings"><i class="ph ph-gear" aria-hidden="true"></i><span>환경 설정</span></button></div>
                </aside>

                <div class="pilot-main">
                    <header class="pilot-topbar">
                        <div class="pilot-mode-switch" role="group" aria-label="투자 모드">
                            <button type="button" class="pilot-mode-button is-active" data-pilot-mode="paper"><i class="ph ph-file-dashed" aria-hidden="true"></i><span>모의투자</span></button>
                            <button type="button" class="pilot-mode-button is-locked" data-pilot-mode="live"><i class="ph ph-lock-key" aria-hidden="true"></i><span>실제투자</span></button>
                        </div>
                        <div class="pilot-top-copy"><strong class="pilot-top-title" id="pilot-mode-title">모의투자 진행 중</strong><span class="pilot-top-subtitle" id="pilot-mode-subtitle">실제 자금이 아닌 가상 자금으로 전략을 관찰하고 있습니다.</span></div>
                        <div class="pilot-top-meta"><span class="pilot-connection is-warn" id="pilot-connection"><span class="pilot-connection-dot"></span><span id="pilot-connection-label">연결 확인 중</span></span><span id="pilot-clock">-</span><span class="pilot-user-chip"><span class="pilot-user-avatar">OP</span>운영자</span></div>
                    </header>

                    <section class="pilot-mode-banner" id="pilot-mode-banner" aria-live="polite">
                        <div class="pilot-mode-banner-copy"><i class="ph ph-lock-key" aria-hidden="true"></i><div><strong id="pilot-mode-banner-title">실전 주문 잠금</strong><span id="pilot-mode-banner-copy">검증 게이트가 통과될 때까지 실제 주문은 실행할 수 없습니다.</span></div></div>
                        <button type="button" class="pilot-button" data-pilot-go="history">검증 게이트 보기 <i class="ph ph-arrow-right" aria-hidden="true"></i></button>
                    </section>

                    <main class="pilot-content">
                        <section class="pilot-page is-active" data-pilot-page="overview">
                            <div class="pilot-page-heading"><div><div class="pilot-kicker">Decision workspace</div><h1 class="pilot-page-title">근거 로그</h1><p class="pilot-page-description">전략의 판단과 결과를 시간순으로 기록합니다. 수익률보다 먼저, 어떤 데이터로 어떤 결정을 했는지 확인하세요.</p></div><div class="pilot-heading-actions"><span class="pilot-sync-note" id="pilot-overview-sync">마지막 동기화 -</span><button type="button" class="pilot-button" data-pilot-action="refresh-core"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> 새로고침</button></div></div>
                            <div class="pilot-gate-grid">
                                <button type="button" class="pilot-gate-card" data-pilot-view="history"><span class="pilot-gate-icon" id="pilot-gate-validation-icon"><i class="ph ph-check" aria-hidden="true"></i></span><span><strong class="pilot-gate-title">검증 게이트</strong><span class="pilot-gate-detail" id="pilot-gate-validation-detail">확인 중</span></span><i class="ph ph-caret-right pilot-gate-arrow" aria-hidden="true"></i></button>
                                <button type="button" class="pilot-gate-card" data-pilot-view="history"><span class="pilot-gate-icon is-pending" id="pilot-gate-paper-icon"><i class="ph ph-hourglass-medium" aria-hidden="true"></i></span><span><strong class="pilot-gate-title">Forward paper</strong><span class="pilot-gate-detail" id="pilot-gate-paper-detail">세션 확인 중</span></span><i class="ph ph-caret-right pilot-gate-arrow" aria-hidden="true"></i></button>
                                <button type="button" class="pilot-gate-card" data-pilot-view="history"><span class="pilot-gate-icon is-pending" id="pilot-gate-freshness-icon"><i class="ph ph-database" aria-hidden="true"></i></span><span><strong class="pilot-gate-title">데이터 최신성</strong><span class="pilot-gate-detail" id="pilot-gate-freshness-detail">수집 상태 확인 중</span></span><i class="ph ph-caret-right pilot-gate-arrow" aria-hidden="true"></i></button>
                            </div>
                            <div class="pilot-workspace-grid">
                                <section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">자산 추이</h2><p class="pilot-panel-subtitle">실현·평가 자산의 변화를 동일한 기준선에서 확인합니다.</p></div><div class="pilot-chart-toolbar"><div class="pilot-chart-legend"><span><i class="pilot-legend-dot"></i>총 평가자산</span><span><i class="pilot-legend-dot is-muted"></i>시작 자산</span></div><div class="pilot-range-tabs"><button type="button" class="pilot-tab-button" data-pilot-chart-period="1h">1H</button><button type="button" class="pilot-tab-button is-active" data-pilot-chart-period="24h">1D</button><button type="button" class="pilot-tab-button" data-pilot-chart-period="7d">1W</button><button type="button" class="pilot-tab-button" data-pilot-chart-period="30d">1M</button></div></div></div><div class="pilot-chart-wrap"><canvas id="pilot-equity-chart" class="pilot-chart-canvas" aria-label="총 평가자산 추이 차트"></canvas><div class="pilot-chart-empty" id="pilot-equity-empty" hidden>자산 추이를 수집 중입니다.</div></div><div class="pilot-chart-footnote"><span id="pilot-equity-period-label">24시간 기준</span><span id="pilot-equity-source-label">-</span></div><div class="pilot-stat-strip"><div class="pilot-stat-cell"><span class="pilot-stat-label">총 평가자산</span><strong class="pilot-stat-value" id="pilot-total-assets">-</strong><span class="pilot-stat-caption" id="pilot-total-assets-caption">-</span></div><div class="pilot-stat-cell"><span class="pilot-stat-label">오늘의 손익</span><strong class="pilot-stat-value" id="pilot-today-profit">-</strong><span class="pilot-stat-caption" id="pilot-today-profit-caption">-</span></div><div class="pilot-stat-cell"><span class="pilot-stat-label">누적 손익</span><strong class="pilot-stat-value" id="pilot-cumulative-profit">-</strong><span class="pilot-stat-caption" id="pilot-cumulative-profit-caption">-</span></div><div class="pilot-stat-cell"><span class="pilot-stat-label">승률</span><strong class="pilot-stat-value" id="pilot-win-rate">-</strong><span class="pilot-stat-caption" id="pilot-trade-count-caption">-</span></div></div></section>
                                ${tradePanelMarkup('overview', '실행 전 모드와 검증 상태를 먼저 확인하세요.')}
                            </div>
                            <div class="pilot-section-spacer"></div>
                            <section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">보유 포지션</h2><p class="pilot-panel-subtitle">현재 평가손익과 다음으로 취할 수 있는 안전한 행동입니다.</p></div><button type="button" class="pilot-link-button" data-pilot-view="portfolio">전체 포트폴리오 보기 <i class="ph ph-arrow-right" aria-hidden="true"></i></button></div><div class="pilot-table-wrap"><table class="pilot-table"><thead><tr><th>자산</th><th class="pilot-table-number">수량</th><th class="pilot-table-number">평균 진입가</th><th class="pilot-table-number">현재가</th><th class="pilot-table-number">평가손익</th><th class="pilot-table-number">수익률</th><th>관리</th></tr></thead><tbody id="pilot-overview-positions"></tbody></table></div></section>
                            <div class="pilot-section-spacer"></div>
                            <div class="pilot-split-grid"><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">최근 활동</h2><p class="pilot-panel-subtitle">주문·신호·세션 상태의 최신 기록</p></div><button type="button" class="pilot-link-button" data-pilot-view="history">전체 기록 <i class="ph ph-arrow-right" aria-hidden="true"></i></button></div><div class="pilot-panel-body"><div class="pilot-evidence-list" id="pilot-activity-list"></div></div></section><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">리스크 체크</h2><p class="pilot-panel-subtitle">신규 진입을 막는 조건도 결과의 일부입니다.</p></div><i class="ph ph-shield-check" style="color: var(--sl-green); font-size: 21px;" aria-hidden="true"></i></div><div class="pilot-panel-body" id="pilot-risk-summary"></div></section></div>
                        </section>

                        <section class="pilot-page" data-pilot-page="trade"><div class="pilot-page-heading"><div><div class="pilot-kicker">Execution workspace</div><h1 class="pilot-page-title">거래 실행</h1><p class="pilot-page-description">단일 주문과 자동 분산 주문을 한 화면에서 검토합니다. 모든 실행은 현재 서버 모드와 동일한 계좌 기준을 사용합니다.</p></div><div class="pilot-heading-actions"><span class="pilot-sync-note" id="pilot-trade-sync">-</span><button type="button" class="pilot-button" data-pilot-action="refresh-core"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> 잔액 새로고침</button></div></div><div class="pilot-split-grid">${tradePanelMarkup('trade', '수량·금액을 검토한 뒤 한 번만 실행합니다.')}<section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">스마트 주문</h2><p class="pilot-panel-subtitle">조건을 정하고 서버의 자동 분산 계약을 호출합니다.</p></div><span class="pilot-status-pill">모의투자 기준</span></div><div class="pilot-panel-body"><div class="pilot-inline-note"><i class="ph ph-info" aria-hidden="true"></i><span>스마트 주문은 거래량 상위 마켓과 현재 전략 점수를 사용합니다. 결과가 보장되는 추천이 아닙니다.</span></div><div class="pilot-section-spacer"></div><div class="pilot-wallet-action"><h3>스마트 매수</h3><label class="pilot-field"><span class="pilot-field-label">총 투자금액 <span class="pilot-field-hint" id="pilot-smart-buy-balance">가용 잔액 -</span></span><input class="pilot-input" type="number" id="pilot-smart-buy-amount" min="5000" step="1000" value="100000"></label><div class="pilot-field-row" style="margin-top:9px"><label class="pilot-field"><span class="pilot-field-label">최소 점수</span><input class="pilot-input" type="number" id="pilot-smart-buy-score" min="0" max="100" value="60"></label><label class="pilot-field"><span class="pilot-field-label">최대 종목</span><input class="pilot-input" type="number" id="pilot-smart-buy-max" min="1" max="30" value="10"></label></div><button type="button" class="pilot-button is-success" style="width:100%; margin-top:12px" data-pilot-action="smart-buy"><i class="ph ph-stack" aria-hidden="true"></i> 스마트 매수 검토</button></div><div class="pilot-section-spacer"></div><div class="pilot-wallet-action"><h3>스마트 매도</h3><label class="pilot-field"><span class="pilot-field-label">목표 매도금액 <span class="pilot-field-hint" id="pilot-smart-sell-holding">보유 평가액 -</span></span><input class="pilot-input" type="number" id="pilot-smart-sell-amount" min="1000" step="1000" value="100000"></label><label class="pilot-field" style="margin-top:9px"><span class="pilot-field-label">매도 우선순위</span><select class="pilot-select" id="pilot-smart-sell-strategy"><option value="worst">손실 큰 자산부터</option><option value="best">수익 큰 자산부터</option><option value="overbought">RSI 과매수부터</option></select></label><button type="button" class="pilot-button is-danger" style="width:100%; margin-top:12px" data-pilot-action="smart-sell"><i class="ph ph-arrow-circle-down" aria-hidden="true"></i> 스마트 매도 검토</button></div></div></section></div><div class="pilot-section-spacer"></div><div class="pilot-split-grid"><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">매수 관심 종목</h2><p class="pilot-panel-subtitle">임계값에 가까운 종목을 확인하고 주문 패널로 넘깁니다.</p></div><button type="button" class="pilot-button is-small" data-pilot-action="load-recommendations">분석 새로고침</button></div><div class="pilot-panel-body"><div id="pilot-buy-recommendations" class="pilot-evidence-list"><div class="pilot-inline-empty">분석 새로고침을 눌러 최신 추천을 확인하세요.</div></div></div></section><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">매도 관심 포지션</h2><p class="pilot-panel-subtitle">보유 자산 중 리스크 신호가 가까운 종목입니다.</p></div><span class="pilot-status-pill is-warning">판단 보조</span></div><div class="pilot-panel-body"><div id="pilot-sell-recommendations" class="pilot-evidence-list"><div class="pilot-inline-empty">분석 새로고침을 눌러 최신 추천을 확인하세요.</div></div></div></section></div></section>

                        <section class="pilot-page" data-pilot-page="portfolio"><div class="pilot-page-heading"><div><div class="pilot-kicker">Capital overview</div><h1 class="pilot-page-title">포트폴리오</h1><p class="pilot-page-description">현금·보유 자산·평가손익을 하나의 기준선으로 읽고, 모의투자 지갑은 실제 계좌와 분리해 관리합니다.</p></div><div class="pilot-heading-actions"><button type="button" class="pilot-button" data-pilot-action="refresh-core"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> 새로고침</button></div></div><div class="pilot-history-summary"><div class="pilot-history-metric"><span>총 평가자산</span><strong id="pilot-portfolio-assets">-</strong></div><div class="pilot-history-metric"><span>누적 손익</span><strong id="pilot-portfolio-profit">-</strong></div><div class="pilot-history-metric"><span>현금 잔액</span><strong id="pilot-portfolio-cash">-</strong></div><div class="pilot-history-metric"><span>보유 종목</span><strong id="pilot-portfolio-count">-</strong></div></div><div class="pilot-split-grid"><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">자산 구성</h2><p class="pilot-panel-subtitle">보유 자산과 현금의 현재 비중</p></div></div><div class="pilot-panel-body" style="display:grid; grid-template-columns:170px minmax(0,1fr); gap:22px; align-items:center"><canvas id="pilot-allocation-chart" style="width:170px;height:170px" aria-label="자산 구성 차트"></canvas><div id="pilot-allocation-legend"></div></div></section><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">계좌 요약</h2><p class="pilot-panel-subtitle">현재 모드의 계좌 상태</p></div></div><div class="pilot-panel-body" id="pilot-account-summary"></div></section></div><div class="pilot-section-spacer"></div><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">자산 추이</h2><p class="pilot-panel-subtitle">기간을 바꿔 평가자산의 변화를 확인합니다.</p></div><div class="pilot-range-tabs"><button type="button" class="pilot-tab-button" data-pilot-portfolio-period="1h">1H</button><button type="button" class="pilot-tab-button is-active" data-pilot-portfolio-period="24h">1D</button><button type="button" class="pilot-tab-button" data-pilot-portfolio-period="7d">1W</button><button type="button" class="pilot-tab-button" data-pilot-portfolio-period="30d">1M</button></div></div><div class="pilot-chart-wrap"><canvas id="pilot-portfolio-chart" class="pilot-chart-canvas" aria-label="포트폴리오 자산 추이"></canvas><div class="pilot-chart-empty" id="pilot-portfolio-empty" hidden>자산 추이를 수집 중입니다.</div></div></section><div class="pilot-section-spacer"></div><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">보유 포지션 상세</h2><p class="pilot-panel-subtitle">부분 매도와 전량 청산은 각각 확인 단계를 거칩니다.</p></div></div><div class="pilot-table-wrap"><table class="pilot-table"><thead><tr><th>자산</th><th class="pilot-table-number">수량</th><th class="pilot-table-number">평단</th><th class="pilot-table-number">현재가</th><th class="pilot-table-number">평가액</th><th class="pilot-table-number">평가손익</th><th>관리</th></tr></thead><tbody id="pilot-portfolio-positions"></tbody></table></div></section><div class="pilot-section-spacer"></div><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">모의투자 지갑</h2><p class="pilot-panel-subtitle">실제 계좌에는 영향을 주지 않는 시드머니 관리입니다.</p></div><span class="pilot-status-pill" id="pilot-wallet-mode">DRY RUN 전용</span></div><div class="pilot-panel-body"><div class="pilot-wallet"><div class="pilot-wallet-action"><h3>입금</h3><div class="pilot-wallet-action-row"><input class="pilot-input" type="number" id="pilot-deposit-amount" min="1000" step="1000" placeholder="금액 (원)"><button type="button" class="pilot-button is-success" data-pilot-action="deposit">입금</button></div><div class="pilot-wallet-presets"><button type="button" class="pilot-filter-chip" data-pilot-deposit="100000">+10만</button><button type="button" class="pilot-filter-chip" data-pilot-deposit="500000">+50만</button><button type="button" class="pilot-filter-chip" data-pilot-deposit="1000000">+100만</button></div></div><div class="pilot-wallet-action"><h3>출금</h3><div class="pilot-wallet-action-row"><input class="pilot-input" type="number" id="pilot-withdraw-amount" min="1000" step="1000" placeholder="금액 (원)"><button type="button" class="pilot-button is-danger" data-pilot-action="withdraw">출금</button></div><div class="pilot-wallet-presets"><button type="button" class="pilot-filter-chip" data-pilot-withdraw="100000">-10만</button><button type="button" class="pilot-filter-chip" data-pilot-withdraw="500000">-50만</button></div></div></div><div class="pilot-inline-note" style="margin-top:10px"><i class="ph ph-warning" aria-hidden="true"></i><span>시드머니 리셋은 기존 모의 포트폴리오와 전략 포지션을 초기화합니다. 실행 전 확인합니다.</span><button type="button" class="pilot-button is-small" data-pilot-action="reset-wallet">시드 리셋</button></div></div></section></section>

                        <section class="pilot-page" data-pilot-page="market"><div class="pilot-page-heading"><div><div class="pilot-kicker">Market observatory</div><h1 class="pilot-page-title">시장 관찰</h1><p class="pilot-page-description">선택한 마켓의 가격·캔들·거래량을 보고, 같은 화면에서 모의 주문을 검토합니다.</p></div><div class="pilot-heading-actions"><label class="pilot-field" style="min-width:200px"><span class="pilot-visually-hidden">마켓 검색</span><input class="pilot-input pilot-market-search" id="pilot-market-search" type="search" placeholder="마켓 검색 (BTC, ETH)"></label><button type="button" class="pilot-button" data-pilot-action="refresh-market"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> 시세 새로고침</button></div></div><div class="pilot-market-layout"><section class="pilot-panel"><div class="pilot-market-quote"><div><span class="pilot-market-symbol" id="pilot-market-symbol">BTC/KRW</span><span class="pilot-market-name" id="pilot-market-name">선택된 마켓</span></div><div><span class="pilot-market-price" id="pilot-market-price">-</span><span class="pilot-market-change" id="pilot-market-change">-</span></div></div><div class="pilot-market-metrics"><div><span class="pilot-market-metric-label">24H 고가</span><strong class="pilot-market-metric-value" id="pilot-market-high">-</strong></div><div><span class="pilot-market-metric-label">24H 저가</span><strong class="pilot-market-metric-value" id="pilot-market-low">-</strong></div><div><span class="pilot-market-metric-label">거래대금</span><strong class="pilot-market-metric-value" id="pilot-market-volume">-</strong></div><div><span class="pilot-market-metric-label">보유 평가</span><strong class="pilot-market-metric-value" id="pilot-market-holding">-</strong></div></div><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">가격 차트</h2><p class="pilot-panel-subtitle">현재가와 완료 캔들을 분리해 표시합니다.</p></div><div class="pilot-market-toolbar"><button type="button" class="pilot-market-interval" data-pilot-candle-interval="1">1m</button><button type="button" class="pilot-market-interval is-active" data-pilot-candle-interval="5">5m</button><button type="button" class="pilot-market-interval" data-pilot-candle-interval="15">15m</button><button type="button" class="pilot-market-interval" data-pilot-candle-interval="60">1h</button></div></div><div class="pilot-market-chart-wrap"><canvas id="pilot-market-chart" class="pilot-market-chart" aria-label="선택 마켓 캔들 차트"></canvas><div class="pilot-chart-empty" id="pilot-market-empty" hidden>캔들 데이터를 불러오는 중입니다.</div></div></section>${tradePanelMarkup('market', '선택한 마켓과 보유 수량을 기준으로 계산합니다.')}</div><div class="pilot-section-spacer"></div><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">실시간 마켓</h2><p class="pilot-panel-subtitle">행을 선택하면 차트와 주문 패널이 함께 바뀝니다.</p></div><div class="pilot-filter-bar"><select class="pilot-select" style="width:auto" id="pilot-market-sort"><option value="volume">거래대금순</option><option value="change_desc">상승률순</option><option value="change_asc">하락률순</option><option value="name">이름순</option></select></div></div><div class="pilot-market-list" id="pilot-market-list"></div></section></section>

                        <section class="pilot-page" data-pilot-page="analysis"><div class="pilot-page-heading"><div><div class="pilot-kicker">Strategy research</div><h1 class="pilot-page-title">전략 연구</h1><p class="pilot-page-description">신호를 실행 명령으로 오해하지 않도록, 기술 지표·점수·판정 근거를 분리해서 보여줍니다.</p></div><div class="pilot-heading-actions"><select class="pilot-select" style="width:auto" id="pilot-analysis-filter"><option value="all">전체 판정</option><option value="BUY">매수</option><option value="SELL">매도</option><option value="HOLD">관망</option></select><select class="pilot-select" style="width:auto" id="pilot-analysis-sort"><option value="score">총점순</option><option value="buy">매수점수순</option><option value="sell">매도점수순</option><option value="volume">거래대금순</option><option value="change">변동률순</option></select><button type="button" class="pilot-button" data-pilot-action="load-analysis"><i class="ph ph-play" aria-hidden="true"></i> 분석 실행</button></div></div><section class="pilot-panel"><div class="pilot-analysis-summary"><div class="pilot-analysis-stat"><strong id="pilot-analysis-total">-</strong><span>분석 마켓</span></div><div class="pilot-analysis-stat is-buy"><strong id="pilot-analysis-buy">-</strong><span>매수 판정</span></div><div class="pilot-analysis-stat is-sell"><strong id="pilot-analysis-sell">-</strong><span>매도 판정</span></div><div class="pilot-analysis-stat is-watch"><strong id="pilot-analysis-hold">-</strong><span>관망</span></div><div class="pilot-analysis-stat"><strong id="pilot-analysis-strong">-</strong><span>강한 신호</span></div></div><div class="pilot-analysis-table pilot-table-wrap"><table class="pilot-table"><thead><tr><th>자산</th><th class="pilot-table-number">현재가</th><th class="pilot-table-number">24H</th><th class="pilot-table-number">RSI</th><th>MACD</th><th class="pilot-table-number">점수</th><th>판정</th><th>관리</th></tr></thead><tbody id="pilot-analysis-rows"></tbody></table></div></section></section>

                        <section class="pilot-page" data-pilot-page="news"><div class="pilot-page-heading"><div><div class="pilot-kicker">News center</div><h1 class="pilot-page-title">뉴스 센터</h1><p class="pilot-page-description">뉴스 감성은 의사결정 보조 정보입니다. 자동 주문의 승인 근거와 혼동하지 않도록 별도 영역에서 확인합니다.</p></div><div class="pilot-heading-actions"><select class="pilot-select" style="width:auto" id="pilot-news-filter"><option value="all">전체 감성</option><option value="positive">긍정</option><option value="negative">부정</option><option value="neutral">중립</option></select><button type="button" class="pilot-button" data-pilot-action="load-news"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> 뉴스 새로고침</button></div></div><section class="pilot-panel"><div class="pilot-news-sentiment"><div class="pilot-sentiment-score is-neutral" id="pilot-news-score">-</div><div><div class="pilot-sentiment-title" id="pilot-news-sentiment-title">시장 심리 확인 전</div><div class="pilot-sentiment-description" id="pilot-news-sentiment-copy">새로고침하면 누적 뉴스의 감성을 계산합니다.</div></div><span class="pilot-status-pill is-warning">참고 정보</span></div><div class="pilot-news-list" id="pilot-news-list"><div class="pilot-inline-empty">뉴스 새로고침을 눌러 최신 기사를 확인하세요.</div></div></section></section>

                        <section class="pilot-page" data-pilot-page="settings"><div class="pilot-page-heading"><div><div class="pilot-kicker">Control room</div><h1 class="pilot-page-title">환경 설정</h1><p class="pilot-page-description">전략·리스크·자동 최적화 설정을 한 번에 조정합니다. 변경 전 현재 모드와 검증 영향을 확인하세요.</p></div><div class="pilot-heading-actions"><button type="button" class="pilot-button" data-pilot-action="reload-settings"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> 서버에서 다시 로드</button><button type="button" class="pilot-button is-primary" data-pilot-action="save-settings"><i class="ph ph-check" aria-hidden="true"></i> 변경사항 적용</button></div></div><div class="pilot-settings-grid"><div><section class="pilot-panel pilot-settings-section"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">자동 최적화</h2><p class="pilot-panel-subtitle">최적화는 후보 탐색이며, live gate를 자동으로 통과시키지 않습니다.</p></div><span class="pilot-status-pill is-warning" id="pilot-optimization-status">확인 중</span></div><div class="pilot-panel-body" id="pilot-optimization-controls"></div></section><div class="pilot-section-spacer"></div><section class="pilot-panel pilot-settings-section"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">투자 성향 프리셋</h2><p class="pilot-panel-subtitle">프리셋 적용은 현재 전략 설정을 즉시 변경합니다.</p></div></div><div class="pilot-panel-body"><div class="pilot-preset-grid" id="pilot-preset-grid"><div class="pilot-inline-empty">설정을 불러오는 중입니다.</div></div></div></section></div><section class="pilot-panel pilot-settings-section"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">전략·리스크 파라미터</h2><p class="pilot-panel-subtitle">값을 바꾼 뒤 하단의 적용 버튼으로 서버에 저장합니다.</p></div></div><div class="pilot-panel-body"><div class="pilot-settings-list" id="pilot-settings-list"><div class="pilot-inline-empty">설정을 불러오는 중입니다.</div></div></div></section></div></section>

                        <section class="pilot-page" data-pilot-page="history"><div class="pilot-page-heading"><div><div class="pilot-kicker">Validation ledger</div><h1 class="pilot-page-title">검증 기록</h1><p class="pilot-page-description">워크포워드 리포트와 forward paper 세션을 분리해 확인합니다. 작은 표본의 손익은 승격 근거가 아닙니다.</p></div><div class="pilot-heading-actions"><button type="button" class="pilot-button" data-pilot-action="refresh-history"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> 검증 새로고침</button></div></div><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">워크포워드 검증</h2><p class="pilot-panel-subtitle" id="pilot-validation-meta">리포트 확인 중</p></div><span class="pilot-status-pill is-warning" id="pilot-validation-status-pill">확인 중</span></div><div id="pilot-validation-detail"></div></section><div class="pilot-section-spacer"></div><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">Forward paper 세션</h2><p class="pilot-panel-subtitle" id="pilot-paper-meta">세션 확인 중</p></div><div class="pilot-heading-actions"><button type="button" class="pilot-button is-small" data-pilot-action="start-paper">새 세션 시작</button><button type="button" class="pilot-button is-small is-danger" data-pilot-action="stop-paper">세션 중지</button></div></div><div class="pilot-paper-status" id="pilot-paper-detail"></div></section><div class="pilot-section-spacer"></div><div class="pilot-split-grid"><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">최적화 이력</h2><p class="pilot-panel-subtitle">후보 탐색 기록</p></div></div><div class="pilot-panel-body" id="pilot-optimization-history"><div class="pilot-inline-empty">기록을 불러오는 중입니다.</div></div></section><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">백테스트 결과</h2><p class="pilot-panel-subtitle">전략별 진단 결과</p></div></div><div class="pilot-panel-body" id="pilot-backtest-results"><div class="pilot-inline-empty">결과를 불러오는 중입니다.</div></div></section></div></section>
                    </main>
                    <footer class="pilot-footer"><span><strong>CoinPilot</strong> <span aria-hidden="true">·</span> Discipline Today, A Safer Tomorrow.</span><span>시장은 늘 변합니다. 검증된 근거로, 더 나은 결정을.</span></footer>
                </div>
            </div>
            <div class="pilot-toast-stack" id="pilot-toast-stack" aria-live="polite" aria-atomic="true"></div>
            <div id="pilot-modal-root"></div>
        `;
    }

    function mountPageEnhancements() {
        const analysisPage = root.querySelector('[data-pilot-page="analysis"]');
        const analysisPanel = analysisPage?.querySelector('.pilot-panel');
        if (analysisPanel && !analysisPanel.querySelector('.pilot-analysis-advisory')) {
            analysisPanel.insertAdjacentHTML('afterbegin', '<div class="pilot-inline-note pilot-analysis-advisory"><i class="ph ph-info" aria-hidden="true"></i><span>이 페이지의 신호는 판단 보조 자료입니다. 특정 자산의 매수·매도를 승인하지 않으며, 최종 실행은 현재 모드와 리스크 규칙을 따릅니다.</span></div>');
        }

        const newsPage = root.querySelector('[data-pilot-page="news"]');
        if (newsPage && !newsPage.querySelector('.pilot-news-context')) {
            newsPage.classList.add('pilot-news-page');
            newsPage.querySelector('.pilot-panel')?.classList.add('pilot-news-main-panel');
            newsPage.insertAdjacentHTML('beforeend', '<aside class="pilot-panel pilot-news-context"><div class="pilot-news-context-kicker">Context over noise</div><h2>뉴스는 판단의 맥락을 제공합니다</h2><p>뉴스는 시장을 이해하는 데 도움이 되는 참고 정보입니다. 자동매매 승인 신호가 아니며, CoinPilot의 주문은 사전에 설정된 전략과 리스크 규칙에 따라 독립적으로 실행됩니다.</p><div class="pilot-news-context-quote"><span class="pilot-news-quote-mark">“</span><strong>최종 결정은 투자자에게 있습니다.</strong></div><div class="pilot-news-context-check"><h3>자동 주문 승인과 분리</h3><div><i class="ph ph-check-circle" aria-hidden="true"></i>뉴스는 참고 정보만 제공합니다</div><div><i class="ph ph-check-circle" aria-hidden="true"></i>자동 주문에는 영향을 주지 않습니다</div><div><i class="ph ph-check-circle" aria-hidden="true"></i>투자 판단과 주문 승인은 별개입니다</div></div></aside>');
        }

        const settingsPage = root.querySelector('[data-pilot-page="settings"]');
        const settingsGrid = settingsPage?.querySelector('.pilot-settings-grid');
        if (settingsGrid && !settingsGrid.querySelector('.pilot-settings-impact')) {
            settingsGrid.insertAdjacentHTML('beforeend', '<aside class="pilot-panel pilot-settings-impact"><div class="pilot-settings-impact-head"><h2>변경 영향</h2><p>설정 항목이 시스템에 미치는 영향을 미리 확인하세요.</p></div><div class="pilot-impact-group is-signal"><h3><i class="ph ph-chart-line-up" aria-hidden="true"></i> 신호 생성에 영향</h3><ul><li>RSI 매수/매도 기준</li><li>이동평균 단기/장기</li><li>변동성 필터·ATR 배수</li></ul><p>진입 신호의 발생 빈도와 타이밍이 변경됩니다.</p></div><div class="pilot-impact-group is-risk"><h3><i class="ph ph-warning-circle" aria-hidden="true"></i> 리스크 청산에 영향</h3><ul><li>익절·손절 비율</li><li>추적 손절 비율</li><li>일일 최대 손실 한도</li></ul><p>포지션 청산 타이밍과 실현 손익의 분포가 달라집니다.</p></div><div class="pilot-impact-group is-data"><h3><i class="ph ph-database" aria-hidden="true"></i> 데이터 신선도에 영향</h3><ul><li>캔들 최신도 예산</li><li>분석 주기</li><li>지연 후 재검증</li></ul><p>오래된 데이터는 안전하게 신규 진입을 차단합니다.</p></div><div class="pilot-impact-group is-live"><h3><i class="ph ph-lock-key" aria-hidden="true"></i> 실전 전환에 영향</h3><ul><li>주요 전략 파라미터 전체</li><li>리스크 관리 설정 전체</li></ul><p>설정 변경 시 기존 검증은 무효화될 수 있어 새 검증이 필요합니다.</p></div></aside>');
        }

        const historyPage = root.querySelector('[data-pilot-page="history"]');
        if (historyPage && !historyPage.querySelector('.pilot-history-warning')) {
            historyPage.querySelector('.pilot-page-heading')?.insertAdjacentHTML('afterend', '<div class="pilot-history-warning"><i class="ph ph-warning" aria-hidden="true"></i><div><strong>작은 표본의 손익은 승격 근거가 아닙니다.</strong><span>충분한 기간과 거래 수, 연속성, 리스크 지표가 일관되게 확인될 때만 다음 단계를 검토합니다.</span></div></div>');
        }
    }

    renderShell();
    mountAiDesk();
    mountPageEnhancements();
    bindAiDesk();
    initializeAiSocket();
    activateView(state.view);

    function updateClock() {
        setText('pilot-clock', new Date().toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }));
    }

    function setConnection(connected, message = '') {
        const connection = byId('pilot-connection');
        if (!connection) return;
        connection.classList.toggle('is-warn', !connected);
        connection.classList.toggle('is-error', message === '오류');
        setText('pilot-connection-label', connected ? 'API 연결됨' : (message || '연결 대기'));
    }

    function renderMode() {
        const paper = state.activeMode === 'paper';
        const liveReady = state.actualMode === 'LIVE' && state.liveEligible;
        $$('[data-pilot-mode]').forEach(button => {
            const mode = button.dataset.pilotMode;
            button.classList.toggle('is-active', mode === state.activeMode);
            button.classList.toggle('is-locked', mode === 'live' && !liveReady);
            button.setAttribute('aria-pressed', mode === state.activeMode ? 'true' : 'false');
        });

        if (paper) {
            setText('pilot-mode-title', state.actualMode === 'LIVE' ? '모의투자 보기' : '모의투자 진행 중');
            setText('pilot-mode-subtitle', state.actualMode === 'LIVE'
                ? '현재 서버는 실제투자 모드입니다. 모의 주문은 실행되지 않습니다.'
                : '실제 자금이 아닌 가상 자금으로 전략을 관찰하고 있습니다.');
        } else {
            setText('pilot-mode-title', liveReady ? '실제투자 활성' : '실제투자 잠금');
            setText('pilot-mode-subtitle', liveReady
                ? '검증 게이트를 통과한 실제 주문만 현재 계좌에 전송됩니다.'
                : '검증 게이트를 모두 통과하기 전까지 실제 주문은 잠겨 있습니다.');
        }

        const banner = byId('pilot-mode-banner');
        const bannerIcon = banner?.querySelector('.pilot-mode-banner-copy > i');
        banner?.classList.toggle('is-live', !paper && liveReady);
        if (bannerIcon) bannerIcon.className = !paper && liveReady ? 'ph ph-shield-check' : 'ph ph-lock-key';
        setText('pilot-mode-banner-title', !paper && liveReady ? '실제투자 활성' : '실전 주문 잠금');
        setText('pilot-mode-banner-copy', !paper && liveReady
            ? '주문 전 자산·수량·리스크를 다시 확인하세요. 실전 체결 결과는 별도 확인이 필요합니다.'
            : tradeBlockReason() || '검증 게이트가 통과될 때까지 실제 주문은 실행할 수 없습니다.');
    }

    function renderGateIcon(id, tone, icon) {
        const element = byId(id);
        if (!element) return;
        element.className = `pilot-gate-icon${tone ? ` is-${tone}` : ''}`;
        element.innerHTML = `<i class="ph ph-${icon}" aria-hidden="true"></i>`;
    }

    function renderGateCards() {
        const report = state.validation;
        const results = report?.results || [];
        const promotedMarkets = report?.promotedMarkets || [];
        const passed = report?.available === true && report?.promoted === true;
        setText('pilot-gate-validation-detail', !report?.available
            ? '리포트 없음 · 승격 보류'
            : `${promotedMarkets.length}/${results.length || 0} 마켓 통과 · ${report.validationMode === 'fixed_config' ? '현재 설정 고정' : '튜닝 후보'}`);
        renderGateIcon('pilot-gate-validation-icon', passed ? '' : 'pending', passed ? 'check' : 'warning');

        const paper = state.paper;
        const paperState = paper?.state || (paper?.active ? 'RUNNING' : 'STOPPED');
        setText('pilot-gate-paper-detail', !paper?.available
            ? '세션 없음 · 시작 필요'
            : `${paperState === 'PASS' ? '조건 충족' : paperState === 'RUNNING' ? '관찰 중' : '중지됨'} · 청산 ${paper.closedTradeCount || 0}회`);
        renderGateIcon('pilot-gate-paper-icon', paperState === 'PASS' ? '' : paperState === 'RUNNING' ? 'pending' : 'blocked', paperState === 'PASS' ? 'check' : paperState === 'RUNNING' ? 'hourglass-medium' : 'pause');

        const freshness = paper?.candleFreshness || {};
        const freshnessBlocks = number(freshness.blockedSnapshots) + number(freshness.blockedAnalyses) + number(freshness.blockedEntries);
        setText('pilot-gate-freshness-detail', !paper
            ? 'paper 세션 확인 필요'
            : freshnessBlocks > 0
                ? `차단 ${freshnessBlocks}회 · 최대 age ${formatPrice(freshness.ageStats?.maxObservedAgeSeconds || 0)}초`
                : `최대 허용 ${formatPrice(freshness.maxAgeSeconds || paper.configSnapshot?.maxCandleAgeSeconds || 90)}초`);
        renderGateIcon('pilot-gate-freshness-icon', !paper ? 'pending' : freshnessBlocks > 0 ? 'pending' : '', freshnessBlocks > 0 ? 'warning' : 'database');
    }

    function renderChartPeriodButtons() {
        $$('[data-pilot-chart-period]').forEach(button => button.classList.toggle('is-active', button.dataset.pilotChartPeriod === state.chartPeriod));
        $$('[data-pilot-portfolio-period]').forEach(button => button.classList.toggle('is-active', button.dataset.pilotPortfolioPeriod === state.chartPeriod));
        setText('pilot-equity-period-label', `${state.chartPeriod === '24h' ? '24시간' : state.chartPeriod} 기준`);
    }

    function renderCoreStats() {
        const account = state.account || {};
        const pnl = state.pnl || {};
        const today = state.today || {};
        const totalAssets = number(account.totalAssets || pnl.totalAssets);
        const totalProfit = number(pnl.profit);
        const todayProfit = number(today.realizedProfit);
        const statistics = Array.isArray(state.statistics) ? state.statistics : [];
        const totalTrades = statistics.reduce((sum, row) => sum + number(row.totalTrades || row.trades || row.tradeCount), 0);
        const wins = statistics.reduce((sum, row) => sum + number(row.winningTrades || row.wins), 0);
        const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : null;
        setText('pilot-total-assets', formatWon(totalAssets));
        setText('pilot-total-assets-caption', `${formatPercent(pnl.profitPercent)} · 기준 ${formatWon(pnl.initialSeedMoney || account.initialSeedMoney)}`);
        setText('pilot-today-profit', formatSignedWon(todayProfit));
        setText('pilot-today-profit-caption', `매수 ${today.buyCount || 0} · 매도 ${today.sellCount || 0}`);
        setText('pilot-cumulative-profit', formatSignedWon(totalProfit));
        setText('pilot-cumulative-profit-caption', formatPercent(pnl.profitPercent));
        setText('pilot-win-rate', winRate === null ? '-' : `${winRate.toFixed(1)}%`);
        setText('pilot-trade-count-caption', `집계 거래 ${totalTrades || today.totalTrades || 0}회`);
        setText('pilot-overview-sync', state.lastSync ? `마지막 동기화 ${formatTime(state.lastSync, true)}` : '마지막 동기화 -');
        setText('pilot-trade-sync', state.lastSync ? `잔액 확인 ${formatTime(state.lastSync, true)}` : '-');
        setText('pilot-equity-source-label', state.portfolioHistory.length ? `${state.portfolioHistory.length}개 관측값` : '관측값 수집 중');
        ['pilot-today-profit', 'pilot-cumulative-profit'].forEach(id => {
            const element = byId(id);
            if (element) element.className = `pilot-stat-value ${id === 'pilot-today-profit' ? classForValue(todayProfit) : classForValue(totalProfit)}`;
        });
    }

    function positions() {
        if (Array.isArray(state.account?.positions)) return state.account.positions;
        if (Array.isArray(state.portfolioAnalysis?.holdings)) return state.portfolioAnalysis.holdings;
        return [];
    }

    function currentMarket(coin = state.selectedCoin) {
        return state.marketPrices.find(item => item.coin === coin) || null;
    }

    function currentPosition(coin = state.selectedCoin) {
        return positions().find(item => item.coin === coin) || null;
    }

    function renderPositionRows(targetId) {
        const target = byId(targetId);
        if (!target) return;
        const rows = positions();
        if (!rows.length) {
            target.innerHTML = '<tr><td colspan="7"><div class="pilot-inline-empty">현재 보유 포지션이 없습니다.</div></td></tr>';
            return;
        }
        target.innerHTML = rows.map((position, index) => {
            const coin = position.coin || position.market || '';
            const profit = number(position.profit);
            const profitPercent = number(position.profitPercent);
            const color = index % 3 === 1 ? 'green' : index % 3 === 2 ? 'amber' : '';
            return `<tr><td><span class="pilot-asset-name"><i class="pilot-asset-dot" data-color="${color}" aria-hidden="true"></i>${escapeHtml(symbolOf(coin))}</span></td><td class="pilot-table-number">${formatQuantity(position.amount)}</td><td class="pilot-table-number">${formatPrice(position.avgPrice || position.entryPrice)}원</td><td class="pilot-table-number">${formatPrice(position.currentPrice)}원</td><td class="pilot-table-number ${classForValue(profit)}">${formatSignedWon(profit)}</td><td class="pilot-table-number ${classForValue(profitPercent)}">${formatPercent(profitPercent)}</td><td><button type="button" class="pilot-table-action" data-pilot-position-action="sell" data-pilot-coin="${escapeHtml(coin)}">매도 패널</button></td></tr>`;
        }).join('');
    }

    function renderActivity() {
        const target = byId('pilot-activity-list');
        if (!target) return;
        const trades = Array.isArray(state.trades) ? state.trades.slice(0, 6) : [];
        const activity = [];
        if (state.paper?.active) activity.push({ time: state.paper.updatedAt || state.paper.lastHeartbeat, title: 'Forward paper 세션 관찰 중', detail: `청산 ${state.paper.closedTradeCount || 0}회 · 중단 ${state.paper.interruptions || 0}회`, value: state.paper.state || 'RUNNING' });
        trades.forEach(trade => {
            const action = trade.type || trade.action || '기록';
            const coin = symbolOf(trade.coin);
            activity.push({ time: trade.timestamp || trade.entryTime || trade.exitTime, title: `${coin} ${action === 'BUY' || action === 'OPEN' ? '매수' : action === 'SELL' || action === 'CLOSE' ? '매도' : action}`, detail: trade.source === 'strategy' ? '전략 기록' : '수동·스마트 주문 기록', value: trade.profit !== undefined ? formatSignedWon(trade.profit) : formatWon(trade.amount || trade.currentValue) });
        });
        target.innerHTML = activity.length ? activity.slice(0, 7).map(item => `<div class="pilot-evidence-row"><span class="pilot-evidence-time">${escapeHtml(formatTime(item.time))}</span><div><strong class="pilot-evidence-title">${escapeHtml(item.title)}</strong><div class="pilot-evidence-detail">${escapeHtml(item.detail)}</div></div><span class="pilot-evidence-value">${escapeHtml(String(item.value))}</span></div>`).join('') : '<div class="pilot-inline-empty">아직 표시할 활동이 없습니다.</div>';
    }

    function renderRiskSummary() {
        const target = byId('pilot-risk-summary');
        if (!target) return;
        const paper = state.paper || {};
        const freshness = paper.candleFreshness || {};
        const circuit = paper.lossCircuitBreaker || state.status?.lossCircuitBreaker || {};
        const stale = number(freshness.blockedSnapshots) + number(freshness.blockedAnalyses) + number(freshness.blockedEntries);
        const items = [
            { title: '모드 경계', detail: state.actualMode === 'LIVE' ? '서버 실제투자 · 주문 전 검증 필요' : '서버 모의투자 · 실제 자금 미사용', tone: state.actualMode === 'LIVE' ? 'warning' : 'ok' },
            { title: '캔들 신선도', detail: stale ? `${stale}회 진입 데이터 차단 기록` : `허용 age ${formatPrice(freshness.maxAgeSeconds || 90)}초`, tone: stale ? 'warning' : 'ok' },
            { title: '손실 회로차단기', detail: circuit.enabled ? `${circuit.lossCount || 0}/${circuit.maxLosses || 0}회 · ${circuit.coolingDown ? '차단 중' : '대기 중'}` : '비활성화', tone: circuit.coolingDown ? 'danger' : circuit.enabled ? 'warning' : 'ok' },
            { title: '연속성 게이트', detail: paper.continuityEligible === false ? '공백 기록으로 승격 보류' : paper.available ? '현재 세션 기준 확인 중' : 'paper 세션 없음', tone: paper.continuityEligible === false ? 'danger' : paper.available ? 'ok' : 'warning' }
        ];
        target.innerHTML = items.map(item => `<div class="pilot-control-row"><div class="pilot-control-copy"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.detail)}</span></div><span class="pilot-status-pill ${item.tone === 'danger' ? 'is-danger' : item.tone === 'warning' ? 'is-warning' : ''}">${item.tone === 'danger' ? '차단' : item.tone === 'warning' ? '확인' : '정상'}</span></div>`).join('');
    }

    function marketOptions() {
        const source = state.marketPrices.length ? state.marketPrices.map(item => item.coin) : state.targetCoins;
        return [...new Set([state.selectedCoin, ...source].filter(Boolean))].slice(0, 120);
    }

    function renderTradePanel(prefix) {
        const trade = state.trade[prefix];
        if (!trade) return;
        const select = root.querySelector(`[data-pilot-trade-coin="${prefix}"]`);
        const input = root.querySelector(`[data-pilot-trade-amount="${prefix}"]`);
        const submit = root.querySelector(`[data-pilot-trade-submit="${prefix}"]`);
        if (!select || !input || !submit) return;
        const selectedBefore = select.value || state.selectedCoin;
        const options = marketOptions();
        select.innerHTML = options.map(coin => `<option value="${escapeHtml(coin)}">${escapeHtml(symbolOf(coin))}/KRW</option>`).join('');
        const selectedCoin = options.includes(selectedBefore) ? selectedBefore : (options[0] || state.selectedCoin);
        select.value = selectedCoin || '';
        if (prefix === 'market') state.selectedCoin = selectedCoin || state.selectedCoin;
        const market = currentMarket(selectedCoin) || {};
        const position = currentPosition(selectedCoin) || {};
        const price = number(market.price || position.currentPrice);
        const holdingValue = number(position.currentValue);
        const maxAmount = trade.side === 'buy' ? number(state.account?.krwBalance) : holdingValue;
        const amount = number(trade.amount);
        const quantity = price > 0 ? amount / price : 0;
        const fee = amount * 0.0005;
        if (document.activeElement !== input) input.value = amount || '';
        input.max = maxAmount > 0 ? String(Math.floor(maxAmount)) : '';
        const modeLabel = root.querySelector(`[data-pilot-trade-mode-label="${prefix}"]`);
        const lockCopy = root.querySelector(`[data-pilot-trade-lock-copy="${prefix}"]`);
        const lockIcon = root.querySelector(`[data-pilot-trade-lock="${prefix}"] i`);
        const amountLabel = root.querySelector(`[data-pilot-trade-amount-label="${prefix}"]`);
        const balance = root.querySelector(`[data-pilot-trade-balance="${prefix}"]`);
        if (modeLabel) { modeLabel.textContent = state.activeMode === 'live' ? '실제투자' : '모의투자'; modeLabel.className = `pilot-status-pill${state.activeMode === 'live' && !state.liveEligible ? ' is-warning' : ''}`; }
        if (lockCopy) lockCopy.textContent = canTrade() ? (state.activeMode === 'live' ? '검증 게이트 통과 상태입니다. 실행 전 최종 확인이 필요합니다.' : '가상 자금으로 주문 흐름을 확인합니다.') : tradeBlockReason();
        if (lockIcon) lockIcon.className = `ph ${canTrade() ? (state.activeMode === 'live' ? 'ph-shield-check' : 'ph-lock-key-open') : 'ph-lock-key'}`;
        if (amountLabel) amountLabel.textContent = trade.side === 'buy' ? '주문 금액 (KRW)' : '매도 금액 기준 (KRW)';
        if (balance) balance.textContent = trade.side === 'buy' ? `잔액 ${formatWon(state.account?.krwBalance)}` : `보유 ${formatWon(holdingValue)}`;
        const setTradeText = (field, value) => {
            const element = root.querySelector(`[data-pilot-trade-${field}="${prefix}"]`);
            if (element) element.textContent = value;
        };
        setTradeText('price', price ? `${formatPrice(price)}원` : '-');
        setTradeText('quantity', quantity ? formatQuantity(quantity) : '-');
        setTradeText('holding', holdingValue ? formatWon(holdingValue) : '없음');
        setTradeText('fee', amount ? formatWon(fee) : '-');
        submit.textContent = trade.side === 'buy' ? (state.activeMode === 'live' ? '실제 주문 실행' : '모의 주문 실행') : (state.activeMode === 'live' ? '실제 매도 실행' : '모의 매도 실행');
        submit.disabled = !canTrade() || !selectedCoin || amount <= 0 || (trade.side === 'sell' && holdingValue <= 0) || (trade.side === 'buy' && amount < 5000);
        const disclaimer = root.querySelector(`[data-pilot-trade-disclaimer="${prefix}"]`);
        if (disclaimer) disclaimer.textContent = canTrade() ? `수수료 0.05% 기준 예상치 · ${state.activeMode === 'live' ? '실제 체결가는 달라질 수 있습니다.' : '가상 체결로 기록됩니다.'}` : '현재 상태에서는 주문 버튼이 잠겨 있습니다.';
        $$(`[data-pilot-trade-side="${prefix}"]`).forEach(button => button.classList.toggle('is-active', button.dataset.tradeSide === trade.side));
    }

    function renderTradePanels() {
        ['overview', 'market', 'trade'].forEach(renderTradePanel);
    }

    function drawCanvas(canvas, height, draw) {
        if (!canvas) return;
        const dpr = window.devicePixelRatio || 1;
        const width = Math.max(1, canvas.clientWidth || 600);
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
        canvas.style.height = `${height}px`;
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
        draw(ctx, width, height);
    }

    function drawEquityChart(canvasId, emptyId, history = []) {
        const canvas = byId(canvasId);
        const empty = byId(emptyId);
        if (!canvas) return;
        const points = Array.isArray(history) ? history.filter(item => Number.isFinite(Number(item.totalAssets))) : [];
        if (empty) empty.hidden = points.length > 0;
        drawCanvas(canvas, 302, (ctx, width, height) => {
            if (!points.length) return;
            const values = points.map(item => number(item.totalAssets));
            const seed = number(state.pnl?.initialSeedMoney || state.account?.initialSeedMoney || values[0]);
            const min = Math.min(seed, ...values); const max = Math.max(seed, ...values); const range = max - min || 1;
            const padding = { top: 26, right: 32, bottom: 28, left: 70 };
            const innerWidth = Math.max(10, width - padding.left - padding.right); const innerHeight = Math.max(10, height - padding.top - padding.bottom);
            ctx.font = '11px "DM Sans", sans-serif'; ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(20, 41, 73, 0.12)'; ctx.fillStyle = '#7a8698';
            for (let row = 0; row <= 4; row += 1) { const y = padding.top + (row / 4) * innerHeight; ctx.beginPath(); ctx.moveTo(padding.left, y); ctx.lineTo(width - padding.right, y); ctx.stroke(); ctx.fillText(formatWon(max - (row / 4) * range, ''), 8, y + 4); }
            const pointAt = (index, value) => ({ x: padding.left + (index / Math.max(1, values.length - 1)) * innerWidth, y: padding.top + innerHeight - ((value - min) / range) * innerHeight });
            const base = pointAt(0, seed).y; ctx.setLineDash([4, 5]); ctx.strokeStyle = '#a5adb7'; ctx.beginPath(); ctx.moveTo(padding.left, base); ctx.lineTo(width - padding.right, base); ctx.stroke(); ctx.setLineDash([]);
            const coords = values.map((value, index) => pointAt(index, value)); ctx.beginPath(); coords.forEach((point, index) => index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)); ctx.lineWidth = 2.5; ctx.strokeStyle = '#1268d6'; ctx.stroke();
            const last = coords[coords.length - 1];
            if (last) { ctx.fillStyle = '#1268d6'; ctx.beginPath(); ctx.arc(last.x, last.y, 4, 0, Math.PI * 2); ctx.fill(); ctx.font = '700 12px "DM Sans", sans-serif'; ctx.fillText(formatWon(values[values.length - 1]), Math.min(width - padding.right - 105, last.x + 8), Math.max(18, last.y - 10)); }
            ctx.fillStyle = '#7a8698'; ctx.font = '10px "DM Sans", sans-serif'; if (points[0]?.timestamp) ctx.fillText(formatTime(points[0].timestamp), padding.left, height - 8); if (points[points.length - 1]?.timestamp) ctx.fillText(formatTime(points[points.length - 1].timestamp), Math.max(padding.left, width - padding.right - 40), height - 8);
        });
    }

    function drawAllocationChart() {
        const canvas = byId('pilot-allocation-chart');
        const holdings = state.portfolioAnalysis?.holdings || positions();
        const cash = number(state.portfolioAnalysis?.summary?.krwBalance || state.account?.krwBalance);
        const items = [...holdings.map(item => ({ name: symbolOf(item.coin), value: number(item.currentValue) })), { name: 'KRW', value: cash }].filter(item => item.value > 0);
        const total = items.reduce((sum, item) => sum + item.value, 0);
        drawCanvas(canvas, 170, (ctx, width, height) => {
            const center = width / 2; const radius = Math.min(width, height) / 2 - 12; let start = -Math.PI / 2;
            if (!total) { ctx.strokeStyle = '#dfe4ea'; ctx.lineWidth = 18; ctx.beginPath(); ctx.arc(center, center, radius, 0, Math.PI * 2); ctx.stroke(); }
            items.forEach((item, index) => { const sweep = (item.value / total) * Math.PI * 2; ctx.beginPath(); ctx.moveTo(center, center); ctx.arc(center, center, radius, start, start + sweep); ctx.closePath(); ctx.fillStyle = index === 0 ? '#1268d6' : index === 1 ? '#0d8f68' : index === 2 ? '#e6a12d' : '#b9c0c9'; ctx.fill(); start += sweep; });
            ctx.fillStyle = '#142949'; ctx.font = '700 15px "DM Sans", sans-serif'; ctx.textAlign = 'center'; ctx.fillText(total ? formatWon(total, '') : '0', center, center + 5); ctx.textAlign = 'left';
        });
        const legend = byId('pilot-allocation-legend');
        if (!legend) return;
        legend.innerHTML = items.length ? items.slice(0, 6).map((item, index) => `<div class="pilot-control-row"><div class="pilot-control-copy"><strong><i class="pilot-asset-dot" data-color="${index === 1 ? 'green' : index === 2 ? 'amber' : ''}" aria-hidden="true"></i> ${escapeHtml(item.name)}</strong><span>${formatWon(item.value)}</span></div><span class="pilot-status-pill">${total ? ((item.value / total) * 100).toFixed(1) : '0.0'}%</span></div>`).join('') : '<div class="pilot-inline-empty">구성 데이터가 없습니다.</div>';
    }

    function drawMarketChart() {
        const canvas = byId('pilot-market-chart'); const empty = byId('pilot-market-empty');
        const candles = Array.isArray(state.candles) ? state.candles.filter(item => Number.isFinite(Number(item.open)) && Number.isFinite(Number(item.close))) : [];
        if (empty) empty.hidden = candles.length > 0;
        drawCanvas(canvas, 398, (ctx, width, height) => {
            if (!candles.length) return;
            const padding = { top: 18, right: 54, bottom: 26, left: 16 }; const innerWidth = Math.max(10, width - padding.left - padding.right); const innerHeight = Math.max(10, height - padding.top - padding.bottom);
            const high = Math.max(...candles.map(item => number(item.high)), ...candles.map(item => number(item.close))); const low = Math.min(...candles.map(item => number(item.low)), ...candles.map(item => number(item.close))); const range = high - low || 1; const y = value => padding.top + innerHeight - ((value - low) / range) * innerHeight;
            ctx.font = '10px "DM Sans", sans-serif'; ctx.fillStyle = '#7a8698'; ctx.strokeStyle = 'rgba(20, 41, 73, 0.12)'; ctx.lineWidth = 1;
            for (let row = 0; row <= 4; row += 1) { const lineY = padding.top + (row / 4) * innerHeight; ctx.beginPath(); ctx.moveTo(padding.left, lineY); ctx.lineTo(width - padding.right, lineY); ctx.stroke(); ctx.fillText(formatPrice(high - (row / 4) * range), width - padding.right + 7, lineY + 4); }
            const step = innerWidth / candles.length; const bodyWidth = Math.max(2, Math.min(12, step * 0.62));
            candles.forEach((candle, index) => { const x = padding.left + step * index + step / 2; const open = number(candle.open); const close = number(candle.close); const highValue = number(candle.high); const lowValue = number(candle.low); const bullish = close >= open; ctx.strokeStyle = bullish ? '#0d8f68' : '#c94b46'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, y(highValue)); ctx.lineTo(x, y(lowValue)); ctx.stroke(); ctx.fillStyle = bullish ? '#0d8f68' : '#c94b46'; const top = y(Math.max(open, close)); const bottom = y(Math.min(open, close)); ctx.fillRect(x - bodyWidth / 2, top, bodyWidth, Math.max(1, bottom - top)); });
            ctx.fillStyle = '#7a8698'; if (candles[0]?.time) ctx.fillText(formatTime(candles[0].time), padding.left, height - 7); if (candles[candles.length - 1]?.time) ctx.fillText(formatTime(candles[candles.length - 1].time), Math.max(padding.left, width - padding.right - 42), height - 7);
        });
    }

    function renderMarketHeader() {
        const market = currentMarket() || {}; const position = currentPosition() || {}; const symbol = symbolOf(state.selectedCoin);
        setText('pilot-market-symbol', `${symbol}/KRW`); setText('pilot-market-name', market ? 'Upbit KRW 마켓 · 실시간 시세' : '선택된 마켓'); setText('pilot-market-price', market.price ? `${formatPrice(market.price)}원` : '-');
        const change = number(market.change); const changeElement = byId('pilot-market-change');
        if (changeElement) { changeElement.textContent = market.price ? formatPercent(change) : '-'; changeElement.className = `pilot-market-change ${classForValue(change)}`; }
        setText('pilot-market-high', market.high ? `${formatPrice(market.high)}원` : '-'); setText('pilot-market-low', market.low ? `${formatPrice(market.low)}원` : '-'); setText('pilot-market-volume', market.volumeKrw ? formatWon(market.volumeKrw) : '-'); setText('pilot-market-holding', position.currentValue ? formatWon(position.currentValue) : '없음');
        $$('[data-pilot-candle-interval]').forEach(button => button.classList.toggle('is-active', number(button.dataset.pilotCandleInterval) === state.candleInterval));
    }

    function sortedMarketPrices() {
        const query = String(state.marketSearch || '').trim().toUpperCase();
        let list = state.marketPrices.filter(item => !query || symbolOf(item.coin).includes(query) || item.coin.includes(query));
        const sort = state.marketSort || 'volume';
        list = [...list].sort((a, b) => sort === 'change_desc' ? number(b.change) - number(a.change) : sort === 'change_asc' ? number(a.change) - number(b.change) : sort === 'name' ? String(a.coin).localeCompare(String(b.coin)) : number(b.volumeKrw) - number(a.volumeKrw));
        return list;
    }

    function renderMarketList() {
        const target = byId('pilot-market-list'); if (!target) return;
        const list = sortedMarketPrices();
        if (!list.length) { target.innerHTML = '<div class="pilot-empty-panel"><i class="ph ph-chart-line" aria-hidden="true"></i>시세를 불러오지 못했거나 검색 결과가 없습니다.</div>'; return; }
        target.innerHTML = `<div class="pilot-market-row" aria-hidden="true"><span class="pilot-market-row-label">마켓</span><span class="pilot-market-row-label" style="text-align:right">현재가</span><span class="pilot-market-row-label" style="text-align:right">24H</span><span class="pilot-market-row-label" style="text-align:right">거래량</span><span></span></div>${list.slice(0, 80).map(item => `<div class="pilot-market-row ${item.coin === state.selectedCoin ? 'is-selected' : ''}" data-pilot-market-row="${escapeHtml(item.coin)}"><span class="pilot-market-row-symbol">${escapeHtml(symbolOf(item.coin))}/KRW</span><span class="pilot-market-row-price">${formatPrice(item.price)}</span><span class="pilot-market-row-change ${classForValue(item.change)}">${formatPercent(item.change)}</span><span class="pilot-market-row-volume">${formatWon(item.volumeKrw)}</span><span><i class="ph ph-arrow-up-right" aria-hidden="true"></i></span></div>`).join('')}`;
    }

    function renderPortfolio() {
        const summary = state.portfolioAnalysis?.summary || {};
        setText('pilot-portfolio-assets', formatWon(summary.totalAssets || state.account?.totalAssets));
        const totalProfit = number(summary.totalProfit || state.pnl?.profit); const profitEl = byId('pilot-portfolio-profit');
        if (profitEl) { profitEl.textContent = formatSignedWon(totalProfit); profitEl.className = classForValue(totalProfit); }
        setText('pilot-portfolio-cash', formatWon(summary.krwBalance || state.account?.krwBalance)); setText('pilot-portfolio-count', `${summary.totalHoldings ?? positions().length}개`);
        const summaryTarget = byId('pilot-account-summary');
        if (summaryTarget) summaryTarget.innerHTML = [['모드', state.actualMode === 'LIVE' ? '실제투자' : '모의투자'], ['현금 잔액', formatWon(state.account?.krwBalance)], ['총 평가자산', formatWon(state.account?.totalAssets)], ['시작 자산', formatWon(state.account?.initialSeedMoney || state.pnl?.initialSeedMoney)], ['누적 수익률', formatPercent(state.pnl?.profitPercent)]].map(([label, value]) => `<div class="pilot-control-row"><div class="pilot-control-copy"><strong>${escapeHtml(label)}</strong></div><span style="font-size:12px;font-weight:700;color:var(--sl-ink)">${escapeHtml(value)}</span></div>`).join('');
        renderPositionRows('pilot-portfolio-positions'); drawAllocationChart(); drawEquityChart('pilot-portfolio-chart', 'pilot-portfolio-empty', state.portfolioHistory); renderChartPeriodButtons();
        const walletMode = byId('pilot-wallet-mode'); if (walletMode) { walletMode.textContent = isPaperMode() ? 'DRY RUN 전용' : '실제투자 잠금'; walletMode.className = `pilot-status-pill${isPaperMode() ? '' : ' is-warning'}`; }
    }

    function renderAnalysis() {
        const result = state.analysis || {}; const coins = Array.isArray(result.coins) ? result.coins : []; const filter = state.analysisFilter || 'all';
        let filtered = coins.filter(item => filter === 'all' || item.recommendation === filter); const sort = state.analysisSort || 'score';
        filtered = [...filtered].sort((a, b) => sort === 'buy' ? number(b.buyScore) - number(a.buyScore) : sort === 'sell' ? number(b.sellScore) - number(a.sellScore) : sort === 'volume' ? number(b.volume24h) - number(a.volume24h) : sort === 'change' ? number(b.change24h) - number(a.change24h) : number(b.totalScore) - number(a.totalScore));
        setText('pilot-analysis-total', result.totalAnalyzed ?? coins.length); setText('pilot-analysis-buy', coins.filter(item => item.recommendation === 'BUY').length); setText('pilot-analysis-sell', coins.filter(item => item.recommendation === 'SELL').length); setText('pilot-analysis-hold', coins.filter(item => item.recommendation === 'HOLD').length); setText('pilot-analysis-strong', coins.filter(item => ['STRONG', 'VERY_STRONG'].includes(item.signalStrength)).length);
        const target = byId('pilot-analysis-rows'); if (!target) return;
        if (!filtered.length) { target.innerHTML = '<tr><td colspan="8"><div class="pilot-empty-panel"><i class="ph ph-function" aria-hidden="true"></i>분석 실행 후 신호가 표시됩니다.</div></td></tr>'; return; }
        target.innerHTML = filtered.slice(0, 80).map(item => { const action = item.recommendation || 'HOLD'; const tone = action === 'BUY' ? '' : action === 'SELL' ? 'is-danger' : 'is-warning'; return `<tr><td><span class="pilot-asset-name"><i class="pilot-asset-dot" aria-hidden="true"></i>${escapeHtml(item.symbol || symbolOf(item.coin))}</span></td><td class="pilot-table-number">${formatPrice(item.currentPrice)}</td><td class="pilot-table-number ${classForValue(item.change24h)}">${formatPercent(item.change24h)}</td><td class="pilot-table-number">${number(item.indicators?.rsi).toFixed(1)}</td><td>${escapeHtml(item.indicators?.macdSignal || '-')}</td><td class="pilot-table-number"><strong>${number(item.totalScore).toFixed(0)}</strong></td><td><span class="pilot-status-pill ${tone}">${escapeHtml(action)}</span></td><td><button type="button" class="pilot-table-action" data-pilot-analysis-coin="${escapeHtml(item.coin)}">거래 검토</button></td></tr>`; }).join('');
    }

    function sentimentInfo(sentiment) {
        const overall = String(sentiment?.overall || sentiment?.label || 'neutral').toLowerCase(); const score = number(sentiment?.score || sentiment?.sentimentScore);
        if (overall.includes('positive') || overall.includes('긍정') || score > 0.15) return { key: 'positive', label: '긍정적', className: '', copy: '누적 뉴스 기준 긍정 신호가 우세합니다.' };
        if (overall.includes('negative') || overall.includes('부정') || score < -0.15) return { key: 'negative', label: '부정적', className: 'is-negative', copy: '누적 뉴스 기준 부정 신호가 우세합니다.' };
        return { key: 'neutral', label: '중립', className: 'is-neutral', copy: '누적 뉴스 기준 뚜렷한 방향성이 확인되지 않습니다.' };
    }

    function renderNews() {
        const data = state.news || {}; const sentiment = sentimentInfo(data.sentiment); const score = number(data.sentiment?.score || data.sentiment?.sentimentScore); const scoreElement = byId('pilot-news-score');
        if (scoreElement) { scoreElement.textContent = score >= 0 ? `+${score.toFixed(2)}` : score.toFixed(2); scoreElement.className = `pilot-sentiment-score ${sentiment.className}`; }
        setText('pilot-news-sentiment-title', `${sentiment.label} 시장 심리`); setText('pilot-news-sentiment-copy', `${sentiment.copy} ${data.totalAccumulated || data.total || 0}개 누적 기사`);
        const filter = state.newsFilter || 'all'; const news = (Array.isArray(data.news) ? data.news : []).filter(item => filter === 'all' || sentimentInfo({ overall: item.sentiment, score: item.sentimentScore || item.score }).key === filter); const target = byId('pilot-news-list'); if (!target) return;
        if (!news.length) { target.innerHTML = '<div class="pilot-empty-panel"><i class="ph ph-newspaper" aria-hidden="true"></i>표시할 뉴스가 없습니다.</div>'; return; }
        target.innerHTML = news.slice(0, 80).map((item, index) => { const info = sentimentInfo({ overall: item.sentiment, score: item.sentimentScore || item.score }); return `<button type="button" class="pilot-news-row" data-pilot-news-index="${index}"><span><strong class="pilot-news-title">${escapeHtml(item.title || '제목 없음')}</strong><span class="pilot-news-meta">${escapeHtml(item.source || item.publisher || '출처 미상')} · ${escapeHtml(formatDateTime(item.timestamp || item.pubDate || item.publishedAt))}</span></span><span class="pilot-news-sentiment-pill ${info.className}">${escapeHtml(info.label)}</span></button>`; }).join('');
    }

    function renderValidationDetail() {
        const report = state.validation; const target = byId('pilot-validation-detail'); const pill = byId('pilot-validation-status-pill'); if (!target || !pill) return;
        if (!report?.available) { pill.textContent = '리포트 없음'; pill.className = 'pilot-status-pill is-warning'; setText('pilot-validation-meta', '읽기 전용 워크포워드 리포트가 없습니다.'); target.innerHTML = '<div class="pilot-empty-panel"><i class="ph ph-file-dashed" aria-hidden="true"></i><div>검증 리포트가 없으면 실제 주문 승격을 판단할 수 없습니다.</div></div>'; return; }
        const results = report.results || []; const promotedMarkets = report.promotedMarkets || []; const passed = report.promoted === true; pill.textContent = passed ? '승격 가능' : '전체 보류'; pill.className = `pilot-status-pill${passed ? '' : ' is-warning'}`; setText('pilot-validation-meta', `${report.validationMode === 'fixed_config' ? '현재 설정 고정 검증' : '학습 구간 튜닝 검증'} · 생성 ${formatDateTime(report.generatedAt)} · ${report.candleCount || '-'}개 캔들`);
        target.innerHTML = `<div class="pilot-validation-detail"><div class="pilot-validation-ring ${passed ? 'is-pass' : ''}">${escapeHtml(`${promotedMarkets.length}/${results.length}`)}</div><div><div class="pilot-validation-headline">${passed ? '모든 대상 마켓이 게이트를 통과했습니다.' : '실전 승격을 보류하고 계속 관찰하세요.'}</div><div class="pilot-validation-copy">이 리포트는 실전 주문을 자동 승인하지 않습니다. paper 기간·리스크·연속성 조건을 함께 확인해야 합니다.</div></div></div><div class="pilot-validation-market-list">${results.length ? results.map(result => { const metric = result.validation?.validation; const marketPassed = result.validation?.promoted === true; return `<div class="pilot-validation-market-card ${marketPassed ? 'is-pass' : 'is-hold'}"><div class="pilot-validation-market-name"><span>${escapeHtml(result.market || '-')}</span><span class="pilot-status-pill ${marketPassed ? '' : 'is-warning'}">${marketPassed ? 'PASS' : 'HOLD'}</span></div><div class="pilot-validation-market-meta">${metric ? `수익률 ${formatPercent(metric.totalReturnPercent)} · 거래 ${metric.tradeCount || 0}회<br>승률 ${formatPercent(metric.winRate)} · PF ${Number.isFinite(metric.profitFactor) ? metric.profitFactor.toFixed(2) : '∞'} · MDD ${formatPercent(metric.maxDrawdownPercent)}` : escapeHtml(result.error || result.validation?.reason || '데이터 부족')}</div></div>`; }).join('') : '<div class="pilot-empty-panel">마켓 결과가 없습니다.</div>'}</div>`;
    }

    function renderPaperDetail() {
        const status = state.paper; const target = byId('pilot-paper-detail'); if (!target) return;
        if (!status?.available) { setText('pilot-paper-meta', '세션 없음 · 기존 모의 포트폴리오를 자동 초기화하지 않습니다.'); target.innerHTML = '<div class="pilot-paper-status"><div class="pilot-paper-status-head"><strong class="pilot-paper-state is-stopped">PAPER 세션 없음</strong><span class="pilot-status-pill is-warning">시작 필요</span></div><div class="pilot-paper-meta">현재 상태 기준으로 시작하거나 새 시드로 초기화할 수 있습니다. 초기화는 기존 dry portfolio 데이터를 덮어쓸 수 있으므로 실행 전 확인합니다.</div><div class="pilot-paper-actions"><button type="button" class="pilot-button" data-pilot-action="start-paper">현재 상태 기준 시작</button><button type="button" class="pilot-button is-danger" data-pilot-action="start-paper-reset">새 시드로 초기화 후 시작</button></div></div>'; return; }
        const paperState = status.state || (status.active ? 'RUNNING' : 'STOPPED'); const paperClass = paperState === 'PASS' ? 'is-pass' : paperState === 'STOPPED' ? 'is-stopped' : ''; const riskMonitor = status.riskMonitor || {}; const riskLabel = riskMonitor.failClosed ? '중지 필요' : riskMonitor.currentOutageDurationSeconds > 0 ? '재시도 중' : '정상'; const riskGap = number(riskMonitor.currentOutageDurationSeconds); setText('pilot-paper-meta', `시작 ${formatDateTime(status.startedAt)} · 마지막 갱신 ${formatDateTime(status.updatedAt || status.lastHeartbeat)}`);
        target.innerHTML = `<div class="pilot-paper-status"><div class="pilot-paper-status-head"><strong class="pilot-paper-state ${paperClass}">${paperState === 'PASS' ? 'PAPER PASS' : paperState === 'RUNNING' ? 'PAPER 관찰 중' : 'PAPER 중지'}</strong><span class="pilot-status-pill ${paperState === 'PASS' ? '' : paperState === 'RUNNING' ? 'is-warning' : 'is-danger'}">${escapeHtml(paperState)}</span></div><div class="pilot-paper-meta">경과 ${number(status.elapsedDays).toFixed(2)}일 · 자산 ${formatWon(status.currentAssets)} · 수익률 ${formatPercent(status.returnPercent)}<br>청산 거래 ${status.closedTradeCount || 0}회 · 실현손익 ${formatSignedWon(status.realizedProfit)} · MDD ${formatPercent(status.maxDrawdownPercent)}<br>strict 현재 포지션 ${status.strictEvaluation?.activePositions || 0}개 · 캔들 최신성 차단 ${number(status.candleFreshness?.blockedSnapshots) + number(status.candleFreshness?.blockedAnalyses) + number(status.candleFreshness?.blockedEntries)}회<br>리스크 ticker ${escapeHtml(riskLabel)} · 연속 실패 ${number(riskMonitor.consecutiveFailures)}회 · 시세 공백 ${riskGap.toFixed(1)}초</div><div class="pilot-paper-actions"><button type="button" class="pilot-button" data-pilot-action="refresh-history">새로고침</button>${status.active ? '<button type="button" class="pilot-button is-danger" data-pilot-action="stop-paper">세션 중지</button>' : '<button type="button" class="pilot-button" data-pilot-action="start-paper">새 세션 시작</button>'}</div></div>`;
    }

    function renderSettings() {
        const settings = state.settings; if (!settings) return;
        const ranges = settings.ranges || {}; const values = settings.values || {}; const list = byId('pilot-settings-list');
        if (list) {
            const toggles = [
                { key: 'marketRegimeEnabled', label: '시장 regime gate', description: '전체 마켓 방향성이 약할 때 신규 진입을 차단하는 후보입니다.', value: settings.investmentConfig?.scalping?.marketRegimeEnabled === true },
                { key: 'requireReboundBelowOverbought', label: '반등 과매수 보호', description: '반등 확정 시 RSI가 과매수이면 늦은 진입을 막는 후보입니다.', value: settings.investmentConfig?.scalping?.requireReboundBelowOverbought === true }
            ];
            const toggleHtml = toggles.map(item => `<div class="pilot-setting-row"><div><span class="pilot-setting-label">${escapeHtml(item.label)}</span><span class="pilot-setting-description">${escapeHtml(item.description)}</span></div><label class="pilot-switch"><input type="checkbox" data-pilot-setting-key="${item.key}" ${item.value ? 'checked' : ''}><span class="pilot-switch-track"></span></label></div>`).join('');
            const rangeHtml = Object.keys(ranges).map(key => { const range = ranges[key] || {}; const raw = values[key] ?? range.min ?? 0; const display = key === 'investmentRatio' ? number(raw) * 100 : raw; return `<div class="pilot-setting-row"><div><span class="pilot-setting-label">${escapeHtml(range.label || key)}</span><span class="pilot-setting-description">${escapeHtml(range.description || '')}</span></div><div class="pilot-setting-control"><input class="pilot-input" type="number" data-pilot-setting-key="${escapeHtml(key)}" data-pilot-setting-kind="number" data-pilot-setting-display="${key === 'investmentRatio' ? 'percent' : 'raw'}" min="${escapeHtml(key === 'investmentRatio' ? number(range.min) * 100 : range.min)}" max="${escapeHtml(key === 'investmentRatio' ? number(range.max) * 100 : range.max)}" step="${escapeHtml(key === 'investmentRatio' ? number(range.step) * 100 : range.step)}" value="${escapeHtml(display)}"></div></div>`; }).join('');
            list.innerHTML = toggleHtml + rangeHtml;
        }
        const presetGrid = byId('pilot-preset-grid');
        if (presetGrid) { const presets = settings.presets || []; presetGrid.innerHTML = presets.length ? presets.map(preset => `<button type="button" class="pilot-preset-card" data-pilot-preset-id="${escapeHtml(preset.id)}"><span><span class="pilot-preset-name">${escapeHtml(preset.name)}</span><span class="pilot-preset-en">${escapeHtml(preset.nameEn)}</span></span><span class="pilot-preset-risk">${'●'.repeat(number(preset.riskLevel))}${'○'.repeat(Math.max(0, 5 - number(preset.riskLevel)))}</span></button>`).join('') : '<div class="pilot-inline-empty">프리셋이 없습니다.</div>'; }
        const optimization = settings.optimization || {}; const controls = byId('pilot-optimization-controls');
        if (controls) {
            controls.innerHTML = `<div class="pilot-control-row"><div class="pilot-control-copy"><strong>자동 최적화</strong><span>주기적으로 후보 파라미터를 탐색합니다. live gate와는 별개입니다.</span></div><label class="pilot-switch"><input type="checkbox" id="pilot-auto-optimization" ${optimization.enabled ? 'checked' : ''}><span class="pilot-switch-track"></span></label></div><div class="pilot-control-row"><div class="pilot-control-copy"><strong>최적화 주기</strong><span>다음 실행: ${escapeHtml(formatDateTime(optimization.nextRun))}</span></div><select class="pilot-select" style="max-width:140px" id="pilot-optimization-interval"><option value="3600000">1시간</option><option value="7200000">2시간</option><option value="10800000">3시간</option><option value="21600000">6시간</option><option value="43200000">12시간</option><option value="86400000">24시간</option></select></div><div class="pilot-control-row"><div class="pilot-control-copy"><strong>즉시 실행</strong><span>현재 설정을 기준으로 후보 탐색을 시작합니다.</span></div><button type="button" class="pilot-button is-small is-primary" data-pilot-action="run-optimization">지금 실행</button></div>`;
            const interval = byId('pilot-optimization-interval'); if (interval && optimization.interval) interval.value = String(optimization.interval);
        }
    }

    function renderHistoryTables() {
        const historyTarget = byId('pilot-optimization-history'); const backtestTarget = byId('pilot-backtest-results'); const optimization = state.settings?.optimizationHistory || []; const backtest = state.settings?.backtestResults || [];
        if (historyTarget) historyTarget.innerHTML = optimization.length ? optimization.slice(0, 8).map(item => `<div class="pilot-evidence-row"><span class="pilot-evidence-time">${escapeHtml(formatTime(item.timestamp || item.date))}</span><div><strong class="pilot-evidence-title">${escapeHtml(item.type || item.strategy || '최적화 실행')}</strong><div class="pilot-evidence-detail">${escapeHtml(item.description || item.message || '후보 파라미터 기록')}</div></div><span class="pilot-evidence-value">${escapeHtml(String(item.fitness ?? item.score ?? '-'))}</span></div>`).join('') : '<div class="pilot-inline-empty">최적화 이력이 없습니다.</div>';
        if (backtestTarget) backtestTarget.innerHTML = backtest.length ? `<div class="pilot-evidence-list">${backtest.slice(0, 8).map(item => `<div class="pilot-evidence-row"><span class="pilot-evidence-time">${escapeHtml(symbolOf(item.coin || item.market || '-'))}</span><div><strong class="pilot-evidence-title">${escapeHtml(item.strategy || item.name || '백테스트')}</strong><div class="pilot-evidence-detail">거래 ${item.totalTrades || item.tradeCount || 0}회 · PF ${item.profitFactor ?? '-'}</div></div><span class="pilot-evidence-value ${classForValue(item.totalReturnPercent || item.returnPercent)}">${formatPercent(item.totalReturnPercent || item.returnPercent)}</span></div>`).join('')}</div>` : '<div class="pilot-inline-empty">백테스트 결과가 없습니다.</div>';
    }

    function renderAll() {
        renderMode(); renderGateCards(); renderChartPeriodButtons(); renderCoreStats(); renderPositionRows('pilot-overview-positions'); renderPositionRows('pilot-portfolio-positions'); renderActivity(); renderRiskSummary(); renderTradePanels(); drawEquityChart('pilot-equity-chart', 'pilot-equity-empty', state.portfolioHistory); renderPortfolio(); renderMarketHeader(); renderMarketList(); renderAnalysis(); renderNews(); renderValidationDetail(); renderPaperDetail();
    }

    async function loadCore({ quiet = false } = {}) {
        if (state.refreshing) return;
        state.refreshing = true;
        if (!quiet) setConnection(false, '연결 확인 중');
        const period = encodeURIComponent(state.chartPeriod || '24h');
        const requests = { status: '/status', account: '/account', pnl: '/cumulative-pnl', today: '/today-summary', statistics: '/statistics', validation: '/scalping-validation', paper: '/paper-validation', portfolioAnalysis: '/portfolio-analysis', history: `/portfolio/history?period=${period}`, trades: '/trades?limit=12', marketPrices: '/market/prices', targetCoins: '/target-coins' };
        const settled = await Promise.all(Object.entries(requests).map(async ([key, path]) => { try { return [key, await requestJSON(path)]; } catch (error) { return [key, null, error]; } }));
        settled.forEach(([key, data]) => { if (data === null) return; if (key === 'history') state.portfolioHistory = Array.isArray(data?.data) ? data.data : []; else if (key === 'targetCoins') state.targetCoins = Array.isArray(data?.coins) ? data.coins : []; else state[key] = data; });
        if (state.status?.mode) state.actualMode = state.status.mode === 'LIVE' ? 'LIVE' : 'DRY_RUN';
        state.activeMode = state.actualMode === 'LIVE' ? 'live' : 'paper'; state.liveEligible = state.actualMode === 'LIVE' && state.validation?.promoted === true;
        if (!state.marketPrices.some(item => item.coin === state.selectedCoin)) state.selectedCoin = state.marketPrices[0]?.coin || state.targetCoins[0] || state.selectedCoin;
        state.connected = Boolean(state.status || state.account || state.marketPrices?.length); state.lastSync = new Date(); state.refreshing = false; setConnection(state.connected, state.connected ? '' : '오류'); renderAll();
        if (state.view === 'market' && state.selectedCoin) await loadCandles(true);
    }

    async function loadCandles(force = false) {
        if (!state.selectedCoin || (!force && state.candles.length && state.candlesCoin === state.selectedCoin && state.candlesInterval === state.candleInterval)) { renderMarketHeader(); drawMarketChart(); return; }
        state.candles = []; state.candlesCoin = state.selectedCoin; state.candlesInterval = state.candleInterval; drawMarketChart();
        try { state.candles = await requestJSON(`/market/candles/${encodeURIComponent(state.selectedCoin)}?unit=${state.candleInterval}&count=100`); } catch (error) { state.candles = []; if (!force) showToast(`캔들 데이터를 불러오지 못했습니다: ${error.message}`, 'warning'); }
        renderMarketHeader(); drawMarketChart();
    }

    async function loadAnalysis() {
        if (state.viewLoading.has('analysis')) return;
        state.viewLoading.add('analysis');
        const button = root.querySelector('[data-pilot-action="load-analysis"]'); if (button) { button.disabled = true; button.innerHTML = '<i class="ph ph-spinner-gap" aria-hidden="true"></i> 분석 중'; }
        try { state.analysis = await requestJSON('/all-coin-scores?limit=60'); renderAnalysis(); showToast(`전략 연구 결과 ${state.analysis?.totalAnalyzed || 0}개를 갱신했습니다.`, 'success'); } catch (error) { showToast(`분석을 불러오지 못했습니다: ${error.message}`, 'error'); } finally { state.viewLoading.delete('analysis'); if (button) { button.disabled = false; button.innerHTML = '<i class="ph ph-play" aria-hidden="true"></i> 분석 실행'; } }
    }

    async function loadNews() {
        if (state.viewLoading.has('news')) return;
        state.viewLoading.add('news');
        const button = root.querySelector('[data-pilot-action="load-news"]'); if (button) { button.disabled = true; button.innerHTML = '<i class="ph ph-spinner-gap" aria-hidden="true"></i> 수집 중'; }
        try { state.news = await requestJSON('/news?limit=80'); renderNews(); showToast(`뉴스 ${state.news?.news?.length || 0}건을 갱신했습니다.`, 'success'); } catch (error) { showToast(`뉴스를 불러오지 못했습니다: ${error.message}`, 'error'); } finally { state.viewLoading.delete('news'); if (button) { button.disabled = false; button.innerHTML = '<i class="ph ph-arrows-clockwise" aria-hidden="true"></i> 뉴스 새로고침'; } }
    }

    async function loadRecommendations() {
        const buy = byId('pilot-buy-recommendations'); const sell = byId('pilot-sell-recommendations'); if (buy) buy.innerHTML = '<div class="pilot-inline-empty">거래량 상위 마켓을 분석 중입니다.</div>'; if (sell) sell.innerHTML = '<div class="pilot-inline-empty">보유 포지션을 분석 중입니다.</div>';
        try {
            const data = await requestJSON('/trading-recommendations');
            const renderRecommendation = (item, side) => `<div class="pilot-evidence-row"><span class="pilot-evidence-time">${escapeHtml(item.symbol || symbolOf(item.coin))}</span><div><strong class="pilot-evidence-title">${escapeHtml(item.recommendation || 'MONITOR')}</strong><div class="pilot-evidence-detail">${escapeHtml((item.signals || []).join(' · ') || item.investmentNote || item.sellNote || '추가 판단 필요')}</div></div><span class="pilot-evidence-value">${side === 'buy' ? formatWon(item.suggestedInvestment) : formatWon(item.suggestedSellValue)}</span></div>`;
            if (buy) buy.innerHTML = data.buyRecommendations?.length ? data.buyRecommendations.slice(0, 8).map(item => renderRecommendation(item, 'buy')).join('') : '<div class="pilot-inline-empty">현재 매수 관심 종목이 없습니다.</div>';
            if (sell) sell.innerHTML = data.sellRecommendations?.length ? data.sellRecommendations.slice(0, 8).map(item => renderRecommendation(item, 'sell')).join('') : '<div class="pilot-inline-empty">현재 매도 관심 포지션이 없습니다.</div>';
            showToast('추천 데이터를 갱신했습니다. 추천은 실행 명령이 아닙니다.', 'success');
        } catch (error) { if (buy) buy.innerHTML = `<div class="pilot-inline-empty">오류: ${escapeHtml(error.message)}</div>`; if (sell) sell.innerHTML = `<div class="pilot-inline-empty">오류: ${escapeHtml(error.message)}</div>`; showToast(`추천을 불러오지 못했습니다: ${error.message}`, 'error'); }
    }

    async function loadSettings() {
        if (state.settingsLoaded && state.settings) { renderSettings(); return; }
        try {
            const [ranges, optimal, investmentConfig, presets, optimization, optimizationHistory, backtestResults] = await Promise.all([requestJSON('/parameter-ranges'), requestJSON('/optimal-config'), requestJSON('/investment-config'), requestJSON('/investment-presets'), requestJSON('/optimization/settings'), requestJSON('/optimization-history'), requestJSON('/backtest/results')]);
            const values = { ...(optimal?.parameters || {}), ...(investmentConfig?.scalping || {}), investmentRatio: investmentConfig?.investmentRatio ?? optimal?.parameters?.investmentRatio };
            state.settings = { ranges: ranges || {}, optimal, investmentConfig, presets: presets?.presets || [], optimization, values, optimizationHistory: Array.isArray(optimizationHistory) ? optimizationHistory : optimizationHistory?.history || [], backtestResults: Array.isArray(backtestResults) ? backtestResults : backtestResults?.results || [] }; state.settingsLoaded = true; renderSettings();
        } catch (error) { showToast(`설정을 불러오지 못했습니다: ${error.message}`, 'error'); }
    }

    async function loadHistory() {
        try {
            const [validation, paper, optimizationHistory, backtestResults] = await Promise.all([requestJSON('/scalping-validation'), requestJSON('/paper-validation'), requestJSON('/optimization-history'), requestJSON('/backtest/results')]);
            state.validation = validation; state.paper = paper; state.settings = state.settings || {}; state.settings.optimizationHistory = Array.isArray(optimizationHistory) ? optimizationHistory : optimizationHistory?.history || []; state.settings.backtestResults = Array.isArray(backtestResults) ? backtestResults : backtestResults?.results || []; state.historyLoaded = true; renderGateCards(); renderValidationDetail(); renderPaperDetail(); renderHistoryTables();
        } catch (error) { showToast(`검증 기록을 불러오지 못했습니다: ${error.message}`, 'error'); }
    }

    function showView(view) {
        if (!view) return; state.view = view; localStorage.setItem('currentPilotView', view); clearToasts(); window.scrollTo({ top: 0, behavior: 'auto' }); $$('[data-pilot-page]').forEach(page => page.classList.toggle('is-active', page.dataset.pilotPage === view)); $$('[data-pilot-view]').forEach(button => button.classList.toggle('is-active', button.dataset.pilotView === view));
        if (view === 'market') loadCandles(true); if (view === 'analysis' && !state.analysis) loadAnalysis(); if (view === 'news' && !state.news) loadNews(); if (view === 'settings') loadSettings(); if (view === 'history') { loadHistory(); loadSettings(); } renderAll();
    }

    async function executeTrade(prefix) {
        const trade = state.trade[prefix]; const select = root.querySelector(`[data-pilot-trade-coin="${prefix}"]`); const input = root.querySelector(`[data-pilot-trade-amount="${prefix}"]`); if (!trade || !select || !input) return;
        const coin = select.value; const amount = number(input.value); const market = currentMarket(coin) || {}; const holding = currentPosition(coin) || {};
        if (!canTrade()) { showToast(tradeBlockReason(), 'warning'); return; }
        if (!coin || amount <= 0) { showToast('자산과 주문 금액을 확인해주세요.', 'warning'); return; }
        if (trade.side === 'buy' && amount < 5000) { showToast('최소 매수 금액은 5,000원입니다.', 'warning'); return; }
        const quantity = market.price > 0 ? amount / market.price : amount / number(holding.currentPrice); const actionText = trade.side === 'buy' ? '매수' : '매도'; const detail = trade.side === 'buy' ? `${formatWon(amount)} 주문` : `${formatQuantity(quantity)}개 매도`;
        if (!window.confirm(`${symbolOf(coin)} ${actionText}를 실행할까요?\n${detail}\n현재 모드: ${state.activeMode === 'paper' ? '모의투자' : '실제투자'}`)) return;
        try { const path = trade.side === 'buy' ? '/trade/buy' : '/trade/sell'; const body = trade.side === 'buy' ? { coin, amount: Math.floor(amount) } : { coin, quantity }; const result = await requestJSON(path, { method: 'POST', body: JSON.stringify(body) }); showToast(result.message || `${symbolOf(coin)} ${actionText} 완료`, 'success'); await loadCore(); } catch (error) { showToast(`${actionText} 실패: ${error.message}`, 'error'); }
    }

    async function executeSmart(kind) {
        if (!canTrade()) { showToast(tradeBlockReason(), 'warning'); return; }
        const buy = kind === 'buy'; const amount = number(byId(buy ? 'pilot-smart-buy-amount' : 'pilot-smart-sell-amount')?.value); if (!amount || amount < (buy ? 5000 : 1000)) { showToast(`최소 ${formatWon(buy ? 5000 : 1000)} 이상 입력해주세요.`, 'warning'); return; }
        const description = buy ? `상위 마켓에 ${formatWon(amount)} 분산 매수` : `보유 자산에서 ${formatWon(amount)} 목표 매도`; if (!window.confirm(`${description}를 실행할까요?\n현재 모드: ${state.activeMode === 'paper' ? '모의투자' : '실제투자'}`)) return;
        try { const body = buy ? { totalAmount: Math.floor(amount), minScore: number(byId('pilot-smart-buy-score')?.value, 60), maxCoins: number(byId('pilot-smart-buy-max')?.value, 10) } : { targetAmount: Math.floor(amount), strategy: byId('pilot-smart-sell-strategy')?.value || 'worst' }; const result = await requestJSON(buy ? '/trade/smart-buy' : '/trade/smart-sell', { method: 'POST', body: JSON.stringify(body) }); showToast(result.message || '스마트 주문이 완료되었습니다.', 'success'); await loadCore(); } catch (error) { showToast(`스마트 주문 실패: ${error.message}`, 'error'); }
    }

    async function walletAction(kind) {
        if (!isPaperMode()) { showToast('실제투자 모드에서는 모의투자 지갑을 조작할 수 없습니다.', 'warning'); return; }
        const input = byId(kind === 'deposit' ? 'pilot-deposit-amount' : 'pilot-withdraw-amount'); const amount = number(input?.value); if (!amount || amount < 1000) { showToast('최소 1,000원 이상 입력해주세요.', 'warning'); return; }
        try { const result = await requestJSON(`/virtual/${kind}`, { method: 'POST', body: JSON.stringify({ amount: Math.floor(amount) }) }); showToast(result.message || '지갑을 업데이트했습니다.', 'success'); if (input) input.value = ''; await loadCore(); } catch (error) { showToast(`지갑 변경 실패: ${error.message}`, 'error'); }
    }

    async function resetWallet() {
        if (!isPaperMode()) { showToast('실제투자 모드에서는 지갑을 리셋할 수 없습니다.', 'warning'); return; }
        const seed = number(window.prompt('새 시드머니를 입력하세요 (원)', String(state.account?.initialSeedMoney || 10000000))); if (!seed || seed < 100000) return; if (!window.confirm(`모의 포트폴리오와 전략 포지션을 ${formatWon(seed)} 기준으로 초기화할까요?`)) return;
        try { const result = await requestJSON('/virtual/reset', { method: 'POST', body: JSON.stringify({ seedMoney: Math.floor(seed) }) }); showToast(result.message || '모의투자 지갑을 리셋했습니다.', 'success'); await loadCore(); } catch (error) { showToast(`리셋 실패: ${error.message}`, 'error'); }
    }

    async function startPaper(reset = false) {
        const message = reset ? '새 시드로 초기화 후 forward paper 세션을 시작할까요? 기존 dry portfolio가 덮어써질 수 있습니다.' : '현재 상태 기준으로 forward paper 세션을 시작할까요?'; if (!window.confirm(message)) return;
        try { const result = await requestJSON('/paper-validation/start', { method: 'POST', body: JSON.stringify(reset ? { reset: true } : {}) }); state.paper = result.status; renderGateCards(); renderPaperDetail(); showToast('forward paper 세션을 시작했습니다.', 'success'); } catch (error) { showToast(`paper 세션 시작 실패: ${error.message}`, 'error'); }
    }

    async function stopPaper() {
        if (!window.confirm('현재 forward paper 세션을 중지할까요?')) return;
        try { const result = await requestJSON('/paper-validation/stop', { method: 'POST' }); state.paper = result.status; renderGateCards(); renderPaperDetail(); showToast('forward paper 세션을 중지했습니다.', 'success'); } catch (error) { showToast(`paper 세션 중지 실패: ${error.message}`, 'error'); }
    }

    function settingPayload() {
        const payload = {};
        $$('[data-pilot-setting-key]').forEach(input => { const key = input.dataset.pilotSettingKey; if (input.type === 'checkbox') payload[key] = input.checked; else { const raw = number(input.value); payload[key] = input.dataset.pilotSettingDisplay === 'percent' ? raw / 100 : raw; } });
        return payload;
    }

    async function saveSettings() {
        const payload = settingPayload();
        try { const investmentRatio = payload.investmentRatio; delete payload.investmentRatio; const result = await requestJSON('/config/update', { method: 'POST', body: JSON.stringify(payload) }); if (investmentRatio !== undefined) await requestJSON('/investment-config/update', { method: 'POST', body: JSON.stringify({ investmentRatio }) }); state.settingsLoaded = false; await loadSettings(); showToast(result.message || '설정을 적용했습니다. 다음 검증에서 다시 확인하세요.', 'success'); } catch (error) { showToast(`설정 적용 실패: ${error.message}`, 'error'); }
    }

    async function applyPreset(presetId) {
        const preset = state.settings?.presets?.find(item => item.id === presetId); if (!preset) return; if (!window.confirm(`${preset.name} 프리셋을 적용할까요? 현재 전략 파라미터가 변경됩니다.`)) return;
        try { await requestJSON('/investment-presets/apply', { method: 'POST', body: JSON.stringify({ presetId, config: preset.config }) }); state.settingsLoaded = false; await loadSettings(); showToast(`${preset.name} 프리셋을 적용했습니다.`, 'success'); } catch (error) { showToast(`프리셋 적용 실패: ${error.message}`, 'error'); }
    }

    async function runOptimization() {
        if (!window.confirm('현재 설정으로 최적화 후보 탐색을 시작할까요?')) return;
        try { const result = await requestJSON('/optimization/run-now', { method: 'POST' }); showToast(result.message || '최적화를 시작했습니다.', 'success'); } catch (error) { showToast(`최적화 실행 실패: ${error.message}`, 'error'); }
    }

    function openNews(index) {
        const filter = state.newsFilter || 'all'; const list = (state.news?.news || []).filter(news => filter === 'all' || sentimentInfo({ overall: news.sentiment, score: news.sentimentScore || news.score }).key === filter); const item = list[index]; if (!item) return;
        const info = sentimentInfo({ overall: item.sentiment, score: item.sentimentScore || item.score }); const link = item.link || item.url;
        showModal('뉴스 분석', `<div class="pilot-inline-note"><i class="ph ph-newspaper" aria-hidden="true"></i><span>${escapeHtml(item.source || '출처 미상')} · ${escapeHtml(formatDateTime(item.timestamp || item.pubDate || item.publishedAt))}</span></div><div style="margin-top:16px"><h3 style="margin:0;color:var(--sl-ink);font-size:18px;line-height:1.4">${escapeHtml(item.title || '제목 없음')}</h3><p style="margin:14px 0 0;color:var(--sl-ink-soft);line-height:1.7;font-size:13px">${escapeHtml(item.description || item.content || '요약 내용이 없습니다.')}</p></div><div class="pilot-inline-note" style="margin-top:16px"><i class="ph ph-info" aria-hidden="true"></i><span>감성: ${escapeHtml(info.label)} · 본 분석은 자동 분류 참고 정보이며 투자 결정을 대신하지 않습니다.</span></div>`, link ? `<a class="pilot-button is-primary" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">원문 보기 <i class="ph ph-arrow-square-out" aria-hidden="true"></i></a><button type="button" class="pilot-button" data-pilot-modal-close>닫기</button>` : '');
    }

    function setMode(mode) {
        if (mode === 'live') { if (state.actualMode !== 'LIVE') { showToast('현재 서버가 모의투자 모드라 실제투자로 전환할 수 없습니다.', 'warning'); return; } if (!state.liveEligible) { showToast('검증 게이트를 모두 통과하기 전까지 실제투자는 잠겨 있습니다.', 'warning'); showView('history'); return; } }
        if (mode === 'paper' && state.actualMode === 'LIVE') { showToast('현재 서버가 실제투자 모드입니다. 모의 주문은 실행되지 않습니다.', 'warning'); return; }
        state.activeMode = mode; renderMode(); renderTradePanels();
    }

    async function handleAction(action) {
        if (action === 'refresh-core') return loadCore(); if (action === 'refresh-market') { await loadCore(); return loadCandles(true); } if (action === 'load-analysis') return loadAnalysis(); if (action === 'load-news') return loadNews(); if (action === 'load-recommendations') return loadRecommendations(); if (action === 'smart-buy') return executeSmart('buy'); if (action === 'smart-sell') return executeSmart('sell'); if (action === 'deposit') return walletAction('deposit'); if (action === 'withdraw') return walletAction('withdraw'); if (action === 'reset-wallet') return resetWallet(); if (action === 'start-paper') return startPaper(false); if (action === 'start-paper-reset') return startPaper(true); if (action === 'stop-paper') return stopPaper(); if (action === 'reload-settings') { state.settingsLoaded = false; return loadSettings(); } if (action === 'save-settings') return saveSettings(); if (action === 'run-optimization') return runOptimization(); if (action === 'refresh-history') { await loadCore(); return loadHistory(); }
    }

    root.addEventListener('click', async event => {
        const close = event.target.closest('[data-pilot-modal-close]');
        if (close) { if (close.matches('.pilot-modal-backdrop') && event.target.closest('.pilot-modal')) return; closeModal(); return; }
        const viewButton = event.target.closest('[data-pilot-view]');
        if (viewButton) { showView(viewButton.dataset.pilotView); return; }
        const goButton = event.target.closest('[data-pilot-go]');
        if (goButton) { showView(goButton.dataset.pilotGo); return; }
        const modeButton = event.target.closest('[data-pilot-mode]');
        if (modeButton) { setMode(modeButton.dataset.pilotMode); return; }
        const actionButton = event.target.closest('[data-pilot-action]');
        if (actionButton) { await handleAction(actionButton.dataset.pilotAction); return; }
        const sideButton = event.target.closest('[data-pilot-trade-side]');
        if (sideButton) { const prefix = sideButton.dataset.pilotTradeSide; state.trade[prefix].side = sideButton.dataset.tradeSide; renderTradePanel(prefix); return; }
        const presetButton = event.target.closest('[data-pilot-trade-preset]');
        if (presetButton) { const prefix = presetButton.dataset.pilotTradePreset; const max = state.trade[prefix].side === 'buy' ? number(state.account?.krwBalance) : number(currentPosition(state.selectedCoin)?.currentValue); state.trade[prefix].amount = Math.floor(max * (number(presetButton.dataset.pilotPreset) / 100)); renderTradePanel(prefix); return; }
        const submitButton = event.target.closest('[data-pilot-trade-submit]');
        if (submitButton) { await executeTrade(submitButton.dataset.pilotTradeSubmit); return; }
        const periodButton = event.target.closest('[data-pilot-chart-period], [data-pilot-portfolio-period]');
        if (periodButton) { state.chartPeriod = periodButton.dataset.pilotChartPeriod || periodButton.dataset.pilotPortfolioPeriod; renderChartPeriodButtons(); await loadCore(); return; }
        const intervalButton = event.target.closest('[data-pilot-candle-interval]');
        if (intervalButton) { state.candleInterval = number(intervalButton.dataset.pilotCandleInterval, 5); state.candles = []; await loadCandles(true); return; }
        const marketRow = event.target.closest('[data-pilot-market-row]');
        if (marketRow) { state.selectedCoin = marketRow.dataset.pilotMarketRow; localStorage.setItem('selectedCoin', state.selectedCoin); renderMarketList(); renderTradePanels(); await loadCandles(true); return; }
        const positionAction = event.target.closest('[data-pilot-position-action]');
        if (positionAction) { state.selectedCoin = positionAction.dataset.pilotCoin; state.trade.trade.side = 'sell'; showView('trade'); renderTradePanels(); return; }
        const analysisCoin = event.target.closest('[data-pilot-analysis-coin]');
        if (analysisCoin) { state.selectedCoin = analysisCoin.dataset.pilotAnalysisCoin; state.trade.trade.side = 'buy'; showView('trade'); renderTradePanels(); return; }
        const newsRow = event.target.closest('[data-pilot-news-index]');
        if (newsRow) { openNews(number(newsRow.dataset.pilotNewsIndex)); return; }
        const deposit = event.target.closest('[data-pilot-deposit]');
        if (deposit) { const input = byId('pilot-deposit-amount'); if (input) input.value = deposit.dataset.pilotDeposit; return; }
        const withdraw = event.target.closest('[data-pilot-withdraw]');
        if (withdraw) { const input = byId('pilot-withdraw-amount'); if (input) input.value = withdraw.dataset.pilotWithdraw; return; }
        const preset = event.target.closest('[data-pilot-preset-id]');
        if (preset) { await applyPreset(preset.dataset.pilotPresetId); return; }
    });

    root.addEventListener('input', event => {
        const amount = event.target.closest('[data-pilot-trade-amount]');
        if (amount) { const prefix = amount.dataset.pilotTradeAmount; state.trade[prefix].amount = number(amount.value); renderTradePanel(prefix); return; }
        if (event.target.id === 'pilot-market-search') { state.marketSearch = event.target.value; renderMarketList(); }
    });

    root.addEventListener('change', async event => {
        const coin = event.target.closest('[data-pilot-trade-coin]');
        if (coin) { const prefix = coin.dataset.pilotTradeCoin; state.trade[prefix].amount = number(root.querySelector(`[data-pilot-trade-amount="${prefix}"]`)?.value || 50000); if (prefix === 'market') { state.selectedCoin = coin.value; localStorage.setItem('selectedCoin', state.selectedCoin); state.candles = []; await loadCandles(true); } renderTradePanel(prefix); return; }
        if (event.target.id === 'pilot-market-sort') { state.marketSort = event.target.value; renderMarketList(); return; }
        if (event.target.id === 'pilot-analysis-filter') { state.analysisFilter = event.target.value; renderAnalysis(); return; }
        if (event.target.id === 'pilot-analysis-sort') { state.analysisSort = event.target.value; renderAnalysis(); return; }
        if (event.target.id === 'pilot-news-filter') { state.newsFilter = event.target.value; renderNews(); return; }
        if (event.target.id === 'pilot-auto-optimization') {
            try { await requestJSON('/optimization/toggle', { method: 'POST', body: JSON.stringify({ enabled: event.target.checked }) }); showToast('자동 최적화 설정을 업데이트했습니다.', 'success'); } catch (error) { showToast(`최적화 설정 실패: ${error.message}`, 'error'); }
        }
        if (event.target.id === 'pilot-optimization-interval') {
            try { await requestJSON('/optimization/interval', { method: 'POST', body: JSON.stringify({ interval: number(event.target.value) }) }); showToast('최적화 주기를 업데이트했습니다.', 'success'); } catch (error) { showToast(`최적화 주기 변경 실패: ${error.message}`, 'error'); }
        }
    });

    if (window.io) {
        try {
            const liveSocket = window.io();
            liveSocket.on('connect', () => setConnection(true));
            liveSocket.on('disconnect', () => setConnection(Boolean(state.connected), '실시간 알림 대기'));
            liveSocket.on('auto-trade', payload => { const trade = payload?.trade || payload; showToast(`${trade?.coin ? symbolOf(trade.coin) : '자동'} ${trade?.type === 'SELL' ? '매도' : '매수'} 알림`, trade?.type === 'SELL' ? 'warning' : 'success'); loadCore({ quiet: true }); });
            liveSocket.on('new-signal', () => { showToast('새로운 신호가 도착했습니다. 전략 연구에서 근거를 확인하세요.', 'info'); if (state.view === 'analysis') loadAnalysis(); });
            liveSocket.on('breaking-news', news => { showToast(`속보: ${news?.title || '새로운 뉴스'}`, 'warning'); if (state.view === 'news') loadNews(); });
        } catch (error) { console.warn('Signal Ledger socket init failed:', error.message); }
    }

    window.addEventListener('resize', () => { drawEquityChart('pilot-equity-chart', 'pilot-equity-empty', state.portfolioHistory); drawEquityChart('pilot-portfolio-chart', 'pilot-portfolio-empty', state.portfolioHistory); drawAllocationChart(); drawMarketChart(); });
    window.setInterval(updateClock, 1000);
    window.setInterval(() => { if (!document.hidden) loadCore({ quiet: true }); }, 10000);

    updateClock();
    const savedView = localStorage.getItem('currentPilotView');
    if (savedView && root.querySelector(`[data-pilot-page="${savedView}"]`)) showView(savedView);
    loadCore().catch(error => { setConnection(false, '오류'); showToast(`초기 데이터를 불러오지 못했습니다: ${error.message}`, 'error'); });

})();
