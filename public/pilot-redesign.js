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
        coreReady: false,
        online: typeof navigator === 'undefined' || navigator.onLine !== false,
        lastSync: null,
        status: null,
        account: null,
        pnl: null,
        today: null,
        statistics: [],
        validation: null,
        strategyReadiness: null,
        paper: null,
        strategyResearch: null,
        momentumShadow: null,
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
            effectiveness: null,
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

    const $$ = (selector) => Array.from(root.querySelectorAll(selector));
    const byId = (id) => root.querySelector(`#${id}`);
    let networkGeneration = 0;
    let refreshAfterCurrent = false;

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

    function formatOptionalPercent(value, decimals = 2) {
        return Number.isFinite(Number(value)) ? formatPercent(value, decimals) : '—';
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

    function validationReportFreshness(value, apiFreshness = null) {
        if (apiFreshness && typeof apiFreshness.fresh === 'boolean') {
            if (apiFreshness.fresh) return '최근 생성';
            if (apiFreshness.reason === 'future_timestamp' || apiFreshness.reason === 'timestamp_missing_or_invalid') {
                return '최신성 확인 불가';
            }
            const ageSeconds = Number(apiFreshness.ageSeconds);
            const ageDays = Number.isFinite(ageSeconds) && ageSeconds >= 0
                ? Math.max(1, Math.floor(ageSeconds / (24 * 60 * 60)))
                : null;
            return ageDays === null
                ? '최신 raw window 재점검 필요'
                : `최신 raw window 재점검 필요 · ${ageDays}일 전 생성`;
        }
        const generatedMs = Date.parse(value || '');
        if (!Number.isFinite(generatedMs) || generatedMs > Date.now()) {
            return '최신성 확인 불가';
        }
        const ageMs = Date.now() - generatedMs;
        if (ageMs >= 24 * 60 * 60 * 1000) {
            const ageDays = Math.max(1, Math.floor(ageMs / (24 * 60 * 60 * 1000)));
            return `최신 raw window 재점검 필요 · ${ageDays}일 전 생성`;
        }
        return '최근 생성';
    }

    function symbolOf(coin) {
        return String(coin || '').replace(/^KRW-/, '');
    }

    const INTERNAL_TERM_MAP = [
        [/재검증/g, '재확인'],
        [/검증/g, '점검'],
        [/승격/g, '전환'],
        [/표본/g, '관측'],
        [/게이트/g, '점검'],
        [/신뢰도/g, '참고 점수'],
        [/무효화/g, '재검토'],
        [/홀드아웃/g, '별도 구간'],
        [/연구 전용/g, '참고 전용'],
        [/\bdrift\b/gi, '변경'],
        [/\bcohort\b/gi, '그룹'],
        [/\bholdout\b/gi, '별도 구간'],
        [/\bwalk[- ]?forward\b/gi, '구간 점검'],
        [/\bforward\b/gi, '실시간'],
        [/\bledger\b/gi, '기록'],
        [/\bheartbeat\b/gi, '응답'],
        [/\borphan(?:ed)?\b/gi, '연결 끊김'],
        [/\bcounterfactual\b/gi, '가상 정산'],
        [/\bconfidence\b/gi, '참고 점수'],
        [/\bdaily_market_stale\b/g, '일봉 응답이 오래됨'],
        [/\bdaily_market_missing\b/g, '일봉 응답 누락'],
        [/\bdaily_market_grid_not_contiguous\b/g, '일봉 간격 확인 필요'],
        [/\bdaily_market_latest_timestamp_mismatch\b/g, '시장별 일봉 시각 불일치'],
        [/\bsamples?\b/gi, '관측'],
        [/\bpromot(?:ion|ed|e)\b/gi, '전환'],
        [/\bwinnerShadow\b/g, '승자 연장 장부'],
        [/\blooseShadow\b/g, '완화 비교 장부'],
        [/\bshadow\b/gi, '참고 비교'],
        [/\bloose\b/gi, '완화'],
        [/\bstrict\b/gi, '기준'],
        [/\brelaxed\b/gi, '비교'],
        [/\bfail[- ]?closed\b/gi, '안전 중지'],
        [/\bregime\b/gi, '국면'],
        [/\bgate\b/gi, '점검'],
        [/\bbreadth\b/gi, '상승 폭'],
        [/\blookback\b/gi, '조회 구간'],
        [/\bticker\b/gi, '시세'],
        [/\bbreak[- ]?even\b/gi, '본전'],
        [/\btrailing\b/gi, '추적'],
        [/\bbenchmark\b/gi, '기준 시장'],
        [/\bspread\b/gi, '호가차'],
        [/\bcost\b/gi, '비용'],
        [/\bPASS\b/g, '통과'],
        [/\bHOLD\b/g, '보류'],
        [/\bWAIT\b/g, '대기'],
        [/\bRUNNING\b/g, '실행 중'],
        [/\bPAUSED\b/g, '일시정지'],
        [/\bSTOPPED\b/g, '중지'],
        [/\bFAILED\b/g, '실패'],
        [/\bCOMPLETED\b/g, '완료'],
        [/\bvolume_confirmation_failed\b/g, '거래량 확인 실패'],
        [/\bprice_rebound_below_threshold\b/g, '최소 반등률 미달'],
        [/\bprice_rebound_above_threshold\b/g, '과대 반등 상한 초과'],
        [/\bprevious_high_break_failed\b/g, '직전 고가 돌파 실패'],
        [/\bprevious_rsi_not_oversold\b/g, '직전 RSI 과매도 아님'],
        [/\brsi_recovery_below_threshold\b/g, 'RSI 회복폭 미달'],
        [/\bbullish_rebound_not_confirmed\b/g, '양봉 반등 미확인'],
        [/\bclose_strength_failed\b/g, '종가 강도 부족'],
        [/\btrend_filter_failed\b/g, '추세 필터 실패']
    ];

    function toUserText(value) {
        let text = String(value ?? '');
        for (const [pattern, replacement] of INTERNAL_TERM_MAP) text = text.replace(pattern, replacement);
        return text;
    }

    function classForValue(value) {
        return number(value) >= 0 ? 'pilot-positive' : 'pilot-negative';
    }

    function isPaperMode() {
        return state.actualMode === 'DRY_RUN';
    }

    function isCoreTradingSnapshotReady({ status, account, marketPrices, selectedCoin }) {
        if (!['DRY_RUN', 'LIVE'].includes(status?.mode)) return false;
        if (account?.mode !== status.mode || account?.krwBalance === null || account?.krwBalance === undefined) return false;
        if (!Number.isFinite(Number(account.krwBalance)) || !Array.isArray(marketPrices)) return false;
        const selectedMarket = marketPrices.find(market => market?.coin === selectedCoin);
        return Number.isFinite(Number(selectedMarket?.price)) && Number(selectedMarket.price) > 0;
    }

    function isReadOnlyObserver() {
        return state.paper?.readOnlyObserver === true || state.status?.readOnlyObserver === true;
    }

    function readOnlyObserverReason() {
        return state.online === false
            ? '오프라인 상태에서는 계좌·시세·거래 상태를 확인할 수 없어 모든 실행을 잠급니다.'
            : '읽기 전용 관찰 모드입니다. 원본 실행 환경에서만 세션과 거래를 관리할 수 있습니다.';
    }

    function coreTradingReadinessReason() {
        return '서버 모드·계좌·선택 시장의 시세가 확인될 때까지 실행을 잠급니다.';
    }

    function paperEvidenceMutationLock() {
        if (isReadOnlyObserver()) return null;
        const apiLock = state.settings?.investmentConfig?.evidenceMutationLock ||
            state.settings?.optimization?.evidenceMutationLock;
        if (apiLock?.locked === true && apiLock.code === 'paper_evidence_mutation_blocked') return apiLock;
        if (state.paper?.active === true) {
            return {
                locked: true,
                code: 'paper_evidence_mutation_blocked',
                reason: '활성 모의투자 검증 세션의 설정 기록을 보호하기 위해 세션을 중지한 뒤 변경하세요.'
            };
        }
        return null;
    }

    function isPaperEvidenceMutationLocked() {
        return paperEvidenceMutationLock()?.locked === true;
    }

    function paperEvidenceMutationReason() {
        return paperEvidenceMutationLock()?.reason || '활성 모의투자 검증 세션 중에는 설정을 변경할 수 없습니다.';
    }

    function syncObserverControls() {
        const blocked = isReadOnlyObserver();
        const offline = state.online === false;
        const coreReady = state.coreReady === true;
        const mutationSelectors = [
            '[data-pilot-action="start-paper"]',
            '[data-pilot-action="start-paper-reset"]',
            '[data-pilot-action="stop-paper"]',
            '[data-pilot-action="deposit"]',
            '[data-pilot-action="withdraw"]',
            '[data-pilot-action="reset-wallet"]',
            '[data-pilot-action="save-settings"]',
            '[data-pilot-action="run-optimization"]',
            '[data-pilot-action="smart-buy"]',
            '[data-pilot-action="smart-sell"]',
            '[data-pilot-trade-submit]',
            '[data-pilot-preset-id]'
        ].join(',');
        $$(mutationSelectors).forEach(button => {
            const sessionDisabled = button.dataset.pilotSessionDisabled === 'true';
            const coreReadinessBlocked = !coreReady && button.dataset.pilotAction !== 'stop-paper';
            const disabled = blocked || offline || sessionDisabled || coreReadinessBlocked;
            button.disabled = disabled;
            button.setAttribute('aria-disabled', disabled ? 'true' : 'false');
            if (blocked || offline) button.title = readOnlyObserverReason();
            else if (coreReadinessBlocked) button.title = coreTradingReadinessReason();
        });
        const evidenceMutationSelectors = [
            '[data-pilot-action="save-settings"]',
            '[data-pilot-action="run-optimization"]',
            '[data-pilot-preset-id]',
            '[data-pilot-setting-key]',
            '#pilot-auto-optimization',
            '#pilot-optimization-interval'
        ].join(',');
        const evidenceLocked = isPaperEvidenceMutationLocked();
        $$(evidenceMutationSelectors).forEach(control => {
            const sessionDisabled = control.dataset.pilotSessionDisabled === 'true';
            const disabled = blocked || offline || sessionDisabled || evidenceLocked || !coreReady;
            control.disabled = disabled;
            control.setAttribute('aria-disabled', disabled ? 'true' : 'false');
            if (blocked || offline) control.title = readOnlyObserverReason();
            else if (!coreReady) control.title = coreTradingReadinessReason();
            else if (evidenceLocked) control.title = paperEvidenceMutationReason();
        });
    }

    function canTrade() {
        if (state.online === false || state.coreReady !== true || isReadOnlyObserver()) return false;
        if (state.activeMode === 'paper') return isPaperMode();
        return state.actualMode === 'LIVE' && state.liveEligible;
    }

    function tradeBlockReason() {
        if (state.online === false) {
            return '오프라인에서는 계좌·시세·거래 상태를 확인할 수 없어 주문을 실행하지 않습니다.';
        }
        if (isReadOnlyObserver()) return readOnlyObserverReason();
        if (state.coreReady !== true) return coreTradingReadinessReason();
        if (state.activeMode === 'paper' && state.actualMode === 'LIVE') {
            return '현재 서버가 실제투자 모드라 모의 주문을 실행할 수 없습니다.';
        }
        if (state.activeMode === 'live' && state.actualMode !== 'LIVE') {
            return '서버 설정이 모의투자라 실제 주문은 전송되지 않습니다.';
        }
        if (state.activeMode === 'live' && !state.liveEligible) {
            return '사전 점검이 모두 완료되기 전까지 실제 주문은 잠겨 있습니다.';
        }
        return '';
    }

    async function requestJSON(path, options = {}) {
        if (state.online === false) throw new Error(readOnlyObserverReason());
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
            if (state.online === false) throw new Error(readOnlyObserverReason());
            if (!response.ok) {
                const error = new Error(data?.error || `HTTP ${response.status}`);
                error.status = response.status;
                throw error;
            }
            return data;
        } catch (error) {
            if (error?.name === 'AbortError') throw new Error('서버 응답 시간이 초과되었습니다. 연결 상태를 확인해주세요.', { cause: error });
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

    function aiStatusLabel(status) {
        return {
            RUNNING: '실행 중',
            PAUSED: '일시정지',
            STOPPED: '중지',
            COMPLETED: '완료',
            DEGRADED: '제한됨',
            FAILED: '실패'
        }[status] || status || '-';
    }

    function aiDeskMarkup() {
        return `
            <section class="pilot-page pilot-ai-page" data-pilot-page="ai">
                <div class="pilot-page-heading">
                    <div><h1 class="pilot-page-title">AI 자문</h1><p class="pilot-page-description">시장 신호에 대한 AI 의견을 확인합니다.</p></div>
                    <div class="pilot-heading-actions"><span class="pilot-sync-note" id="pilot-ai-sync">마지막 동기화 -</span><button type="button" class="pilot-button" data-pilot-ai-refresh><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> 새로고침</button></div>
                </div>
                <div class="pilot-ai-policy"><div><strong><i class="ph ph-shield-check" aria-hidden="true"></i> AI 자문</strong><span>AI 의견은 참고용이며 자동매매 주문을 실행하지 않습니다.</span></div><span class="pilot-ai-policy-badge">주문 실행 없음</span></div>
                <div class="pilot-ai-grid">
                    <div class="pilot-ai-column">
                        <section class="pilot-panel"><div class="pilot-ai-panel-header"><div><h2 class="pilot-panel-title">연결 상태</h2><p class="pilot-panel-subtitle">사용할 수 있는 AI 서비스</p></div><span class="pilot-status-pill is-warning" id="pilot-ai-provider-policy">연결 상태</span></div><div class="pilot-ai-panel-body"><div id="pilot-ai-providers" class="pilot-ai-providers"><div class="pilot-ai-empty">AI 연결 상태를 불러오는 중입니다.</div></div></div></section>
                        <section class="pilot-panel"><div class="pilot-ai-panel-header"><div><h2 class="pilot-panel-title">자문 결과 추이</h2><p class="pilot-panel-subtitle">자문과 이후 가격 변화를 비교합니다.</p></div><span class="pilot-status-pill is-warning" id="pilot-ai-effectiveness-state">데이터 대기</span></div><div class="pilot-ai-panel-body"><div id="pilot-ai-effectiveness" class="pilot-ai-effectiveness"><div class="pilot-ai-empty">자문 기록이 쌓이면 결과 추이가 표시됩니다.</div></div></div></section>
                        <section class="pilot-panel"><div class="pilot-ai-panel-header"><div><h2 class="pilot-panel-title">장기 모니터링 세션</h2><p class="pilot-panel-subtitle">중지·일시정지·재개와 이력을 보존합니다.</p></div><span class="pilot-status-pill" id="pilot-ai-session-count">0개 실행 중</span></div><div class="pilot-ai-panel-body"><div id="pilot-ai-sessions" class="pilot-ai-session-list"><div class="pilot-ai-empty">아직 모니터링 세션이 없습니다.</div></div></div></section>
                        <section class="pilot-panel"><div class="pilot-ai-panel-header"><div><h2 class="pilot-panel-title">새 세션 열기</h2><p class="pilot-panel-subtitle">감시할 신호와 자문 간격을 선택합니다.</p></div></div><div class="pilot-ai-panel-body"><form class="pilot-ai-session-form" id="pilot-ai-session-form"><label class="pilot-ai-form-label">세션 이름<input class="pilot-ai-form-input" id="pilot-ai-session-name" maxlength="80" value="시장 이벤트 자문" placeholder="예: BTC 반등 감시"></label><div class="pilot-ai-form-label">AI 서비스<div class="pilot-ai-check-grid"><label class="pilot-ai-check"><input type="checkbox" name="pilot-ai-provider" value="gpt" checked> GPT</label><label class="pilot-ai-check"><input type="checkbox" name="pilot-ai-provider" value="claude" checked> Claude</label></div></div><div class="pilot-ai-form-label">감시 이벤트<div class="pilot-ai-check-grid"><label class="pilot-ai-check"><input type="checkbox" name="pilot-ai-event" value="BUY_SIGNAL" checked> 매수 신호</label><label class="pilot-ai-check"><input type="checkbox" name="pilot-ai-event" value="SELL_SIGNAL" checked> 매도 신호</label><label class="pilot-ai-check"><input type="checkbox" name="pilot-ai-event" value="REBOUND_CANDIDATE"> 반등 후보</label><label class="pilot-ai-check"><input type="checkbox" name="pilot-ai-event" value="BREAKING_NEWS"> 속보</label><label class="pilot-ai-check"><input type="checkbox" name="pilot-ai-event" value="BUNDLE_SUGGESTION"> 리밸런싱 제안</label><label class="pilot-ai-check"><input type="checkbox" name="pilot-ai-event" value="TRADE_EXECUTED"> 체결 알림</label></div></div><label class="pilot-ai-form-label">코인 필터 <small>선택 사항 · BTC 또는 KRW-BTC</small><input class="pilot-ai-form-input" id="pilot-ai-session-coins" placeholder="전체 코인 감시"></label><div class="pilot-field-row"><label class="pilot-ai-form-label">재자문 간격 (초)<input class="pilot-ai-form-input" id="pilot-ai-cooldown" type="number" min="30" max="86400" step="30" value="300"></label><label class="pilot-ai-form-label">자동 자문<label class="pilot-ai-check"><input id="pilot-ai-auto-consult" type="checkbox" checked> 이벤트 발생 시 요청</label></label></div><button class="pilot-button is-primary" type="submit"><i class="ph ph-broadcast" aria-hidden="true"></i> 장기 모니터링 시작</button></form></div></section>
                    </div>
                    <div class="pilot-ai-column">
                        <section class="pilot-panel"><div class="pilot-ai-panel-header"><div><h2 class="pilot-panel-title">시장 이벤트</h2><p class="pilot-panel-subtitle">자동매매 분석에서 감지한 신호</p></div><span class="pilot-status-pill is-warning" id="pilot-ai-snapshot-time">수신 대기</span></div><div class="pilot-ai-panel-body"><div id="pilot-ai-events" class="pilot-ai-event-list"><div class="pilot-ai-empty">분석이 완료되면 시장 신호가 표시됩니다.</div></div><div class="pilot-inline-note"><i class="ph ph-cursor-click" aria-hidden="true"></i><span>이벤트별로 AI 의견을 요청할 수 있습니다.</span></div></div></section>
                        <section class="pilot-panel"><div class="pilot-ai-panel-header"><div><h2 class="pilot-panel-title">AI 자문 결과</h2><p class="pilot-panel-subtitle">AI별 의견·이유·위험·재검토 조건</p></div><span class="pilot-status-pill" id="pilot-ai-consultation-count">0건</span></div><div class="pilot-ai-panel-body"><div id="pilot-ai-consultations" class="pilot-ai-consultation-list"><div class="pilot-ai-empty">아직 자문 결과가 없습니다.</div></div></div></section>
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
        const aiForm = byId('pilot-ai-session-form');
        const cooldownRow = byId('pilot-ai-cooldown')?.closest('.pilot-field-row');
        if (aiForm && cooldownRow && !byId('pilot-ai-evaluation-minutes')) {
            const evaluationLabel = document.createElement('label');
            evaluationLabel.className = 'pilot-ai-form-label';
            evaluationLabel.innerHTML = '평가 시점 (분)<input class="pilot-ai-form-input" id="pilot-ai-evaluation-minutes" type="number" min="1" max="1440" step="1" value="5">';
            cooldownRow.parentElement.insertBefore(evaluationLabel, cooldownRow.nextSibling);
        }
    }

    function syncViewNavigation(view) {
        $$('[data-pilot-view]').forEach(button => {
            const isCurrent = button.dataset.pilotView === view;
            button.classList.toggle('is-active', isCurrent);
            if (isCurrent) button.setAttribute('aria-current', 'page');
            else button.removeAttribute('aria-current');
        });
    }

    function activateView(view) {
        const nextView = String(view || 'overview');
        state.view = nextView;
        $$('[data-pilot-page]').forEach(page => page.classList.toggle('is-active', page.dataset.pilotPage === nextView));
        syncViewNavigation(nextView);
        if (nextView === 'ai') loadAiDesk(false);
    }

    function renderAiProviders(status) {
        const container = byId('pilot-ai-providers');
        const policy = byId('pilot-ai-provider-policy');
        if (!container) return;
        if (policy) policy.textContent = 'AI 연결';
        if (!status?.providers?.length) {
            container.innerHTML = '<div class="pilot-ai-empty" style="grid-column:1/-1">AI 연결 상태를 불러오지 못했습니다.</div>';
            return;
        }
        container.innerHTML = status.providers.map(provider => {
            const configWarning = provider.status === 'READY_WITH_CONFIG_WARNING' ||
                (provider.status === 'CONFIG_ERROR' && provider.canAttemptWithoutUserConfig === true);
            const userState = configWarning && provider.ready ? '연결됨' : provider.ready ? '사용 가능' : provider.status === 'NOT_AUTHENTICATED' ? '로그인 필요' : '사용 불가';
            const userClass = provider.ready ? 'is-ready' : provider.status === 'NOT_AUTHENTICATED' ? 'is-warning' : 'is-error';
            return `<article class="pilot-ai-provider ${userClass}"><div class="pilot-ai-provider-head"><span class="pilot-ai-provider-name">${escapeHtml(provider.label || aiProviderLabel(provider.id))}</span><span class="pilot-ai-provider-state ${userClass}">${userState}</span></div></article>`;
        }).join('');
    }

    function renderAiEffectiveness(effectiveness) {
        const container = byId('pilot-ai-effectiveness');
        const statePill = byId('pilot-ai-effectiveness-state');
        if (!container) return;
        const evidenceReady = effectiveness?.sufficientEvidence === true;
        if (statePill) {
            statePill.textContent = evidenceReady ? '충분한 데이터' : '데이터 부족';
            statePill.className = `pilot-status-pill ${evidenceReady ? 'is-ready' : 'is-warning'}`;
        }
        if (!effectiveness) {
            container.innerHTML = '<div class="pilot-ai-empty">성과 지표를 불러오지 못했습니다.</div>';
            return;
        }
        const stats = Object.values(effectiveness.providerStats || {});
        const providerStats = stats.filter(stat => stat.type === 'provider');
        const statMarkup = stats.length
            ? stats.map(stat => {
                const hitRate = stat.hitRate === null || stat.hitRate === undefined ? '-' : `${(number(stat.hitRate) * 100).toFixed(1)}%`;
                const latency = stat.averageLatencyMs === null || stat.averageLatencyMs === undefined ? '-' : `${(number(stat.averageLatencyMs) / 1000).toFixed(1)}s`;
                const veto = (stat.vetoGood || stat.vetoMissedOpportunity || stat.vetoFlat)
                    ? ` · veto ${stat.vetoGood || 0}/${stat.vetoMissedOpportunity || 0}/${stat.vetoFlat || 0}`
                    : '';
                const vetoImpact = stat.vetoNetImpactPercent === null || stat.vetoNetImpactPercent === undefined
                    ? ''
                    : ` · veto net ${number(stat.vetoNetImpactPercent) >= 0 ? '+' : ''}${number(stat.vetoNetImpactPercent).toFixed(2)}%`;
                const resultLine = stat.type === 'consensus'
                    ? `평가 ${stat.evaluated || 0} · actionable ${stat.actionableEvaluations || 0} · 적중 ${stat.hits || 0} · 실패 ${stat.misses || 0}${vetoImpact}`
                    : `응답 ${stat.completed || 0}/${stat.attempted || 0} · 평가 ${stat.evaluated || 0} · actionable ${stat.actionableEvaluations || 0} · 지연 ${latency}${veto}${vetoImpact}`;
                return `<div class="pilot-ai-effectiveness-row"><div><strong>${escapeHtml(stat.label || stat.source)}</strong><span>${escapeHtml(resultLine)}</span></div><b>${escapeHtml(hitRate)}</b></div>`;
            }).join('')
            : '<div class="pilot-ai-empty">아직 실제 AI 응답이 없습니다.</div>';
        const coverage = effectiveness.evaluationCoverageRate === null || effectiveness.evaluationCoverageRate === undefined
            ? '-'
            : `${(number(effectiveness.evaluationCoverageRate) * 100).toFixed(1)}%`;
        const completion = effectiveness.actualProviderCompletionRate === null || effectiveness.actualProviderCompletionRate === undefined
            ? '-'
            : `${(number(effectiveness.actualProviderCompletionRate) * 100).toFixed(1)}%`;
        const warning = effectiveness.evidenceWarning
            ? `<div class="pilot-inline-note"><i class="ph ph-warning" aria-hidden="true"></i><span>${escapeHtml(toUserText(effectiveness.evidenceWarning))}</span></div>`
            : '';
        const actionable = Math.max(...stats.map(stat => Number(stat.actionableEvaluations) || 0), 0);
        container.innerHTML = `<div class="pilot-ai-effectiveness-summary"><div><strong>${escapeHtml(String(effectiveness.actualProviderCompletions || 0))}</strong><span>실제 응답</span></div><div><strong>${escapeHtml(String(effectiveness.evaluatedConsultations || 0))}</strong><span>평가 완료</span></div><div><strong>${escapeHtml(String(actionable))}</strong><span>비중립 응답</span></div><div><strong>${escapeHtml(coverage)}</strong><span>평가 비율</span></div><div><strong>${escapeHtml(completion)}</strong><span>응답 성공률</span></div></div><div class="pilot-ai-effectiveness-list">${statMarkup}</div>${providerStats.length ? '<div class="pilot-inline-note"><i class="ph ph-chart-line-up" aria-hidden="true"></i><span>적중률은 비중립 BUY/SELL 결과와 회피 판정만 집계하고, 중립 결과는 제외합니다.</span></div>' : ''}${warning}`;
    }

    function renderAiSessions(sessions) {
        const container = byId('pilot-ai-sessions');
        const count = byId('pilot-ai-session-count');
        if (!container) return;
        const activeCount = (sessions || []).filter(session => session.status === 'RUNNING').length;
        if (count) count.textContent = `실행 중 ${activeCount}개 / 전체 ${(sessions || []).length}개`;
        if (!sessions?.length) {
            container.innerHTML = '<div class="pilot-ai-empty">아직 모니터링 세션이 없습니다.</div>';
            return;
        }
        container.innerHTML = sessions.map(session => {
            const statusClass = session.status === 'RUNNING' ? '' : session.status === 'PAUSED' ? 'is-paused' : 'is-stopped';
            const statusText = aiStatusLabel(session.status);
            const providers = (session.providers || []).map(aiProviderLabel).join(' + ');
            const events = (session.eventTypes || []).map(type => aiEventLabels[type] || type).join(' · ');
            const coins = session.coins?.length ? session.coins.map(symbolOf).join(', ') : '전체 코인';
            const actions = session.status === 'RUNNING'
                ? `<button type="button" class="pilot-button" data-pilot-ai-session-action="pause" data-session-id="${session.id}">일시정지</button><button type="button" class="pilot-button is-danger" data-pilot-ai-session-action="stop" data-session-id="${session.id}">종료</button>`
                : session.status === 'PAUSED'
                    ? `<button type="button" class="pilot-button" data-pilot-ai-session-action="resume" data-session-id="${session.id}">재개</button><button type="button" class="pilot-button is-danger" data-pilot-ai-session-action="stop" data-session-id="${session.id}">종료</button>`
                    : '';
            return `<article class="pilot-ai-session ${statusClass}"><div class="pilot-ai-session-head"><span class="pilot-ai-session-name">${escapeHtml(session.name)}</span><span class="pilot-ai-provider-state ${session.status === 'RUNNING' ? 'is-ready' : session.status === 'PAUSED' ? 'is-warning' : 'is-error'}">${statusText}</span></div><div class="pilot-ai-session-meta">${escapeHtml(providers)}<br>${escapeHtml(events)}<br>${escapeHtml(coins)} · 이벤트 ${session.eventCount || 0} · 자문 ${session.consultationCount || 0} · 평가 ${session.evaluationMinutes || 5}분</div><div class="pilot-ai-session-meta">시작 ${escapeHtml(formatDateTime(session.startedAt))} · 마지막 이벤트 ${escapeHtml(formatDateTime(session.lastEventAt))}</div><div class="pilot-ai-actions">${actions}</div></article>`;
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
            return `<article class="pilot-ai-event ${eventClass}"><div class="pilot-ai-event-head"><span class="pilot-ai-event-title">${escapeHtml(coin)} · ${escapeHtml(aiEventLabels[event.type] || event.type)}</span><span class="pilot-ai-event-action ${actionClass}">${escapeHtml(toUserText(event.action || 'WAIT'))}</span></div><div class="pilot-ai-event-meta">${escapeHtml(formatDateTime(event.timestamp))} · ${escapeHtml(price)}${event.signalStrength ? ` · ${escapeHtml(event.signalStrength)}` : ''}<br>${escapeHtml(toUserText(event.reason || event.snapshot?.title || '관찰 이벤트'))}</div><div class="pilot-ai-actions"><button type="button" class="pilot-button is-small" data-pilot-ai-consult-event="${event.id}"><i class="ph ph-sparkle" aria-hidden="true"></i> 이 이벤트 자문</button></div></article>`;
        }).join('');
    }

    function renderAiConsultations(consultations) {
        const container = byId('pilot-ai-consultations');
        const count = byId('pilot-ai-consultation-count');
        if (!container) return;
        if (count) count.textContent = `${(consultations || []).length}건`;
        if (!consultations?.length) {
            container.innerHTML = '<div class="pilot-ai-empty">아직 자문 결과가 없습니다.</div>';
            return;
        }
        container.innerHTML = consultations.slice(0, 40).map(consultation => {
            const stateClass = consultation.status === 'COMPLETED'
                ? 'is-completed'
                : consultation.status === 'DEGRADED'
                    ? 'is-degraded'
                    : consultation.status === 'RUNNING' ? '' : 'is-failed';
            const event = consultation.event || {};
            const coin = event.coin ? symbolOf(event.coin) : 'MARKET';
            const results = (consultation.results || []).map(result => {
                if (result.status === 'FALLBACK' && result.advice) {
                    const fallback = result.advice;
                    const risks = (fallback.risks || []).map(risk => `<li>${escapeHtml(risk)}</li>`).join('');
                    return `<div class="pilot-ai-consultation-result"><div class="pilot-ai-advice-action is-wait">로컬<br>요약</div><div class="pilot-ai-rationale"><strong>AI 없음 · 사실 요약</strong><br>${escapeHtml(fallback.rationale || '')}${risks ? `<ul class="pilot-ai-risks">${risks}</ul>` : ''}<div class="pilot-ai-consultation-meta">${escapeHtml(fallback.invalidation || 'provider 연결 후 재자문')}</div></div></div>`;
                }
                if (result.status !== 'COMPLETED' || !result.advice) return `<div class="pilot-ai-rationale" style="color:var(--sl-red)">${escapeHtml(aiProviderLabel(result.provider))}: ${escapeHtml(result.error || '응답 실패')}</div>`;
                const advice = result.advice;
                const actionClass = advice.action === 'SELL' ? 'is-sell' : ['HOLD', 'WAIT'].includes(advice.action) ? 'is-wait' : '';
                const risks = (advice.risks || []).map(risk => `<li>${escapeHtml(risk)}</li>`).join('');
                const configWarning = result.configWarning ? '<div class="pilot-ai-consultation-meta">Codex 사용자 설정 경고 · 격리 실행으로 응답 확인</div>' : '';
                return `<div class="pilot-ai-consultation-result"><div class="pilot-ai-advice-action ${actionClass}">${escapeHtml(toUserText(advice.action))}</div><div class="pilot-ai-rationale"><strong>${escapeHtml(aiProviderLabel(result.provider))}</strong> · ${escapeHtml(advice.horizon || '')}<br>${escapeHtml(advice.rationale || '')}${risks ? `<ul class="pilot-ai-risks">${risks}</ul>` : ''}<div class="pilot-ai-consultation-meta">재검토 조건: ${escapeHtml(advice.invalidation || '추가 확인 필요')}</div>${configWarning}</div></div>`;
            }).join('');
            const pending = consultation.status === 'RUNNING' ? '<div class="pilot-ai-rationale">응답을 기다리는 중…</div>' : '';
            const error = consultation.error ? `<div class="pilot-ai-rationale" style="color:var(--sl-red)">${escapeHtml(consultation.error)}</div>` : '';
            const evaluation = consultation.evaluation;
            const evaluationMarkup = evaluation?.status === 'COMPLETED'
                ? `<div class="pilot-ai-evaluation"><strong>결과 평가</strong><span>${escapeHtml(`${number(evaluation.horizonMinutes, 5)}분 후 ${number(evaluation.priceChangePercent).toFixed(2)}%`)}</span><span>${(evaluation.verdicts || []).map(verdict => `${escapeHtml(toUserText(verdict.providerLabel || verdict.source))} ${escapeHtml(toUserText(verdict.verdict))}`).join(' · ')}</span></div>`
                : evaluation?.status === 'PENDING'
                    ? '<div class="pilot-ai-evaluation is-pending"><strong>결과 평가 대기</strong><span>평가 시점 이후 동일 코인 가격을 기다리는 중</span></div>'
                    : evaluation?.status === 'NOT_EVALUABLE'
                        ? `<div class="pilot-ai-evaluation is-pending"><strong>결과 평가 제외</strong><span>${escapeHtml(toUserText(evaluation.reason || '기준 가격 또는 실제 provider 응답 없음'))}</span></div>`
                        : '';
            return `<article class="pilot-ai-consultation ${stateClass}"><div class="pilot-ai-consultation-head"><span class="pilot-ai-event-title">${escapeHtml(coin)} · ${escapeHtml(aiEventLabels[event.type] || event.type || '자문')}</span><span class="pilot-ai-provider-state ${stateClass === 'is-completed' ? 'is-ready' : stateClass === 'is-failed' ? 'is-error' : 'is-warning'}">${escapeHtml(aiStatusLabel(consultation.status))}</span></div><div class="pilot-ai-consultation-meta">${escapeHtml(formatDateTime(consultation.createdAt))} · ${(consultation.providerSelection || []).map(aiProviderLabel).map(escapeHtml).join(' + ')}${consultation.auto ? ' · 자동 자문' : ' · 수동 자문'}</div>${results || pending || error}${evaluationMarkup}</article>`;
        }).join('');
    }

    function renderAiSnapshot(snapshot) {
        if (!snapshot) return;
        state.ai.sessions = snapshot.sessions || [];
        state.ai.events = snapshot.events || [];
        state.ai.consultations = snapshot.consultations || [];
        state.ai.effectiveness = snapshot.effectiveness || null;
        renderAiSessions(state.ai.sessions);
        renderAiEvents(state.ai.events);
        renderAiConsultations(state.ai.consultations);
        renderAiEffectiveness(state.ai.effectiveness);
        setText('pilot-ai-sync', snapshot.updatedAt ? `동기화 ${formatDateTime(snapshot.updatedAt)}` : '동기화 -');
        setText('pilot-ai-snapshot-time', snapshot.latestSnapshot?.timestamp ? `수신 ${formatTime(snapshot.latestSnapshot.timestamp, true)}` : '수신 대기');
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
                    evaluationMinutes: number(byId('pilot-ai-evaluation-minutes')?.value, 5),
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
            const consultationStatus = result?.consultation?.status;
            showToast(
                consultationStatus === 'COMPLETED'
                    ? 'AI 자문 결과를 받았습니다'
                    : consultationStatus === 'DEGRADED'
                        ? 'provider 미연결 · 사실 기반 WAIT 요약을 저장했습니다'
                        : 'AI 자문이 완료되지 않았습니다',
                consultationStatus === 'COMPLETED' ? 'success' : 'warning'
            );
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

    function initProgressiveInstall() {
        const installButton = byId('pilot-pwa-install');
        const installState = byId('pilot-pwa-state');
        const updateBanner = byId('pilot-pwa-update');
        if (!installButton || !installState) return;

        let deferredInstallPrompt = null;
        let serviceWorkerRegistration = null;
        let serviceWorkerFailed = false;
        let hadServiceWorkerController = typeof navigator !== 'undefined' && Boolean(navigator.serviceWorker?.controller);
        const isSecureContext = window.isSecureContext === true;
        const serviceWorkerSupported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
        const isIos = /iphone|ipad|ipod/i.test(window.navigator.userAgent || '') ||
            (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1);
        const isAndroid = /android/i.test(window.navigator.userAgent || '');
        const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone;

        function openInstallGuide() {
            const platformTitle = isIos ? 'iPhone·iPad' : isAndroid ? 'Android' : '데스크톱 브라우저';
            const secureContextNote = isSecureContext
                ? ''
                : '<p class="pilot-install-guide-note is-warning">현재 접속 주소가 HTTPS가 아니어서 브라우저 설치 메뉴와 service worker를 사용할 수 없습니다. 서버를 HTTPS로 노출한 뒤 같은 주소로 다시 열어주세요. 개발 중에는 localhost 또는 127.0.0.1 주소가 허용됩니다.</p>';
            const serviceWorkerNote = !isIos && !serviceWorkerSupported
                ? '<p class="pilot-install-guide-note is-warning">현재 브라우저는 설치앱에 필요한 service worker를 지원하지 않아 설치 가능 여부를 확인할 수 없습니다. Chrome·Edge·Safari의 최신 버전 또는 지원되는 모바일 브라우저에서 다시 열어주세요.</p>'
                : serviceWorkerFailed
                    ? '<p class="pilot-install-guide-note is-warning">service worker 등록에 실패해 설치 가능 여부를 확인하지 못했습니다. 네트워크와 HTTPS 상태를 확인한 뒤 다시 열어주세요.</p>'
                    : '';
            const steps = isIos
                ? '<ol class="pilot-install-guide-steps"><li>Safari에서 이 CoinPilot 화면을 엽니다.</li><li>하단 또는 상단의 공유 버튼을 누릅니다.</li><li>“홈 화면에 추가”를 선택하고 추가합니다.</li></ol><p class="pilot-install-guide-note">홈 화면의 CoinPilot 아이콘으로 다시 열면 이 화면이 설치앱 모드로 표시됩니다. 계좌·시세·거래 상태는 계속 서버 API에서 확인하며, 오프라인에서는 오래된 거래 상태를 보여주지 않습니다.</p>'
                : `<ol class="pilot-install-guide-steps"><li>${platformTitle} 브라우저의 주소창 또는 메뉴를 엽니다.</li><li>“앱 설치”, “CoinPilot 설치” 또는 “홈 화면에 추가”를 선택합니다.</li><li>설치가 끝난 뒤 생성된 CoinPilot 아이콘으로 다시 엽니다.</li></ol><p class="pilot-install-guide-note">설치 이벤트가 아직 브라우저에 전달되지 않은 경우에도 메뉴에서 직접 설치할 수 있습니다. 설치 후 다시 열면 이 화면이 설치앱 모드로 표시됩니다.</p>`;
            showModal('CoinPilot 설치 안내', `<div class="pilot-install-guide"><div class="pilot-inline-note"><i class="ph ph-device-mobile" aria-hidden="true"></i><span>${platformTitle}용 설치 절차입니다.</span></div>${secureContextNote}${serviceWorkerNote}${steps}</div>`);
        }

        const renderInstallState = (installed = isStandalone()) => {
            if (installed) {
                installState.textContent = '설치앱 모드';
                installState.className = 'pilot-status-pill is-ready pilot-pwa-state';
                installButton.hidden = true;
                return;
            }
            if (!isSecureContext) {
                installState.textContent = 'HTTPS 필요';
                installState.className = 'pilot-status-pill is-warning pilot-pwa-state';
                installButton.hidden = false;
                installButton.textContent = 'HTTPS 설치 안내';
                return;
            }
            if (isIos) {
                installState.textContent = '홈 화면 설치';
                installState.className = 'pilot-status-pill is-warning pilot-pwa-state';
                installButton.hidden = false;
                installButton.textContent = '설치 안내';
                return;
            }
            if (!serviceWorkerSupported || serviceWorkerFailed) {
                installState.textContent = '설치 지원 확인 필요';
                installState.className = 'pilot-status-pill is-warning pilot-pwa-state';
                installButton.hidden = false;
                installButton.textContent = '설치 조건 안내';
                return;
            }
            const installReady = Boolean(deferredInstallPrompt && serviceWorkerRegistration);
            installState.textContent = installReady ? '설치 가능' : serviceWorkerRegistration ? '브라우저 모드' : '설치 확인 중';
            installState.className = `pilot-status-pill ${installReady ? 'is-ready' : 'is-warning'} pilot-pwa-state`;
            installButton.hidden = false;
            installButton.textContent = installReady ? '앱으로 설치' : '설치 조건 안내';
        };

        renderInstallState();
        const refreshInstallState = () => renderInstallState();
        document.addEventListener('visibilitychange', refreshInstallState);
        window.addEventListener('pageshow', refreshInstallState);
        const showPwaUpdate = () => {
            if (!updateBanner) return;
            updateBanner.hidden = false;
        };
        const watchInstallingWorker = worker => {
            if (!worker) return;
            worker.addEventListener('statechange', () => {
                if (worker.state === 'installed' && navigator.serviceWorker.controller) showPwaUpdate();
            });
        };
        const reloadPwa = () => {
            const waiting = serviceWorkerRegistration?.waiting;
            if (!waiting || !navigator.serviceWorker?.addEventListener) {
                window.location.reload();
                return;
            }
            let reloaded = false;
            const reloadOnce = () => {
                if (reloaded) return;
                reloaded = true;
                window.clearTimeout(timeout);
                window.location.reload();
            };
            const timeout = window.setTimeout(reloadOnce, 2000);
            navigator.serviceWorker.addEventListener('controllerchange', reloadOnce, { once: true });
            waiting.postMessage({ type: 'SKIP_WAITING' });
        };
        updateBanner?.querySelector('[data-pilot-action="reload-pwa"]')?.addEventListener('click', reloadPwa);
        if (isSecureContext && serviceWorkerSupported) {
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                if (hadServiceWorkerController) showPwaUpdate();
                else hadServiceWorkerController = true;
            });
            navigator.serviceWorker.register('/sw.js').then(registration => {
                serviceWorkerRegistration = registration;
                watchInstallingWorker(registration.installing);
                registration.addEventListener('updatefound', () => watchInstallingWorker(registration.installing));
                registration.update().catch(() => { /* an offline shell can update on the next visit */ });
                renderInstallState();
            }).catch(error => {
                console.warn('PWA service worker 등록 실패:', error.message);
                serviceWorkerFailed = true;
                deferredInstallPrompt = null;
                renderInstallState();
            });
        }

        window.addEventListener('beforeinstallprompt', event => {
            // iOS/iPadOS uses the Share -> Add to Home Screen flow. Some
            // Chromium user-agent emulations can still emit this event, but
            // routing those clicks to a native prompt leaves the iOS guide
            // unreachable. Keep the platform contract explicit.
            if (isIos || isStandalone() || !isSecureContext || !serviceWorkerSupported || serviceWorkerFailed) return;
            event.preventDefault();
            deferredInstallPrompt = event;
            renderInstallState(false);
        });

        window.addEventListener('appinstalled', () => {
            deferredInstallPrompt = null;
            renderInstallState(true);
            showToast('CoinPilot 설치가 완료되었습니다', 'success');
        });

        installButton.addEventListener('click', async () => {
            if (!deferredInstallPrompt) {
                openInstallGuide();
                return;
            }
            deferredInstallPrompt.prompt();
            const choice = await deferredInstallPrompt.userChoice;
            deferredInstallPrompt = null;
            if (choice?.outcome === 'accepted') {
                installState.textContent = '설치 요청 완료';
                installState.className = 'pilot-status-pill is-ready pilot-pwa-state';
                installButton.hidden = true;
            } else {
                renderInstallState(false);
            }
        });
    }

    function renderShell() {
        root.innerHTML = `
            <div class="pilot-app">
                <aside class="pilot-sidebar">
                    <div class="pilot-brand">
                        <div class="pilot-brand-lockup"><span class="pilot-brand-mark"><i class="ph ph-compass" aria-hidden="true"></i></span><span class="pilot-brand-name">CoinPilot</span></div>
                    </div>
                    <nav class="pilot-sidebar-nav" aria-label="주 메뉴">
                        <div class="pilot-nav-label">메뉴</div>
                        <button type="button" class="pilot-nav-button is-active" data-pilot-view="overview" aria-current="page"><i class="ph ph-chart-line-up" aria-hidden="true"></i><span>대시보드</span></button>
                        <button type="button" class="pilot-nav-button" data-pilot-view="trade"><i class="ph ph-hand-coins" aria-hidden="true"></i><span>거래 실행</span></button>
                        <button type="button" class="pilot-nav-button" data-pilot-view="portfolio"><i class="ph ph-wallet" aria-hidden="true"></i><span>포트폴리오</span></button>
                        <button type="button" class="pilot-nav-button" data-pilot-view="market"><i class="ph ph-binoculars" aria-hidden="true"></i><span>시장 관찰</span></button>
                        <button type="button" class="pilot-nav-button" data-pilot-view="analysis"><i class="ph ph-function" aria-hidden="true"></i><span>전략 분석</span></button>
                        <button type="button" class="pilot-nav-button" data-pilot-view="news"><i class="ph ph-newspaper" aria-hidden="true"></i><span>뉴스 센터</span></button>
                        <div class="pilot-nav-label">관리</div>
                        <button type="button" class="pilot-nav-button" data-pilot-view="settings"><i class="ph ph-sliders-horizontal" aria-hidden="true"></i><span>설정</span></button>
                        <button type="button" class="pilot-nav-button" data-pilot-view="history"><i class="ph ph-clipboard-text" aria-hidden="true"></i><span>준비 현황</span></button>
                    </nav>
                    <div class="pilot-sidebar-bottom"><button type="button" class="pilot-nav-button" data-pilot-view="settings"><i class="ph ph-gear" aria-hidden="true"></i><span>환경 설정</span></button></div>
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
                            <div class="pilot-mode-banner-copy"><i class="ph ph-lock-key" aria-hidden="true"></i><div><strong id="pilot-mode-banner-title">실전 주문 잠금</strong><span id="pilot-mode-banner-copy">사전 점검이 완료될 때까지 실제 주문은 실행할 수 없습니다.</span></div></div>
                            <div class="pilot-mode-banner-actions"><span class="pilot-status-pill is-warning pilot-pwa-state" id="pilot-pwa-state">브라우저 모드</span><button type="button" class="pilot-button pilot-pwa-install" id="pilot-pwa-install">앱으로 설치</button><button type="button" class="pilot-button" data-pilot-go="history">준비 현황 보기 <i class="ph ph-arrow-right" aria-hidden="true"></i></button></div>
                        </section>
                        <section class="pilot-pwa-update" id="pilot-pwa-update" role="status" aria-live="polite" hidden><i class="ph ph-arrows-clockwise" aria-hidden="true"></i><div><strong>새 버전이 준비되었습니다.</strong><span>최신 설치앱 화면을 적용하려면 지금 새로고침하세요. 현재 paper/live 상태는 변경되지 않습니다.</span></div><button type="button" class="pilot-button is-small" data-pilot-action="reload-pwa">지금 업데이트</button></section>
                        <section class="pilot-offline-banner" id="pilot-offline-banner" role="status" aria-live="polite" hidden><i class="ph ph-cloud-slash" aria-hidden="true"></i><div><strong>오프라인 모드</strong><span>화면 껍데기만 표시합니다. 계좌·시세·거래 상태는 서버에 다시 연결된 뒤 확인하며, 주문·설정 변경은 잠깁니다.</span></div><button type="button" class="pilot-button is-small" data-pilot-action="refresh-core">다시 연결</button></section>

                    <main class="pilot-content">
                        <section class="pilot-page is-active" data-pilot-page="overview">
                            <div class="pilot-page-heading"><div><h1 class="pilot-page-title">대시보드</h1><p class="pilot-page-description">자산과 보유 현황을 확인합니다.</p></div><div class="pilot-heading-actions"><span class="pilot-sync-note" id="pilot-overview-sync">마지막 동기화 -</span><button type="button" class="pilot-button" data-pilot-action="refresh-core"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> 새로고침</button></div></div>
                            <div class="pilot-gate-grid">
                                <button type="button" class="pilot-gate-card" data-pilot-view="history"><span class="pilot-gate-icon" id="pilot-gate-validation-icon"><i class="ph ph-check" aria-hidden="true"></i></span><span><strong class="pilot-gate-title">사전 점검</strong><span class="pilot-gate-detail" id="pilot-gate-validation-detail">확인 중</span></span><i class="ph ph-caret-right pilot-gate-arrow" aria-hidden="true"></i></button>
                                <button type="button" class="pilot-gate-card" data-pilot-view="history"><span class="pilot-gate-icon is-pending" id="pilot-gate-paper-icon"><i class="ph ph-hourglass-medium" aria-hidden="true"></i></span><span><strong class="pilot-gate-title">모의투자 세션</strong><span class="pilot-gate-detail" id="pilot-gate-paper-detail">세션 확인 중</span></span><i class="ph ph-caret-right pilot-gate-arrow" aria-hidden="true"></i></button>
                                <button type="button" class="pilot-gate-card" data-pilot-view="history"><span class="pilot-gate-icon is-pending" id="pilot-gate-freshness-icon"><i class="ph ph-database" aria-hidden="true"></i></span><span><strong class="pilot-gate-title">데이터 상태</strong><span class="pilot-gate-detail" id="pilot-gate-freshness-detail">수집 상태 확인 중</span></span><i class="ph ph-caret-right pilot-gate-arrow" aria-hidden="true"></i></button>
                            </div>
                            <div class="pilot-workspace-grid">
                                <section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">자산 추이</h2><p class="pilot-panel-subtitle">실현·평가 자산의 변화를 동일한 기준선에서 확인합니다.</p></div><div class="pilot-chart-toolbar"><div class="pilot-chart-legend"><span><i class="pilot-legend-dot"></i>총 평가자산</span><span><i class="pilot-legend-dot is-muted"></i>시작 자산</span></div><div class="pilot-range-tabs"><button type="button" class="pilot-tab-button" data-pilot-chart-period="1h">1H</button><button type="button" class="pilot-tab-button is-active" data-pilot-chart-period="24h">1D</button><button type="button" class="pilot-tab-button" data-pilot-chart-period="7d">1W</button><button type="button" class="pilot-tab-button" data-pilot-chart-period="30d">1M</button></div></div></div><div class="pilot-chart-wrap"><canvas id="pilot-equity-chart" class="pilot-chart-canvas" aria-label="총 평가자산 추이 차트"></canvas><div class="pilot-chart-empty" id="pilot-equity-empty" hidden>자산 추이를 수집 중입니다.</div></div><div class="pilot-chart-footnote"><span id="pilot-equity-period-label">24시간 기준</span><span id="pilot-equity-source-label">-</span></div><div class="pilot-stat-strip"><div class="pilot-stat-cell"><span class="pilot-stat-label">총 평가자산</span><strong class="pilot-stat-value" id="pilot-total-assets">-</strong><span class="pilot-stat-caption" id="pilot-total-assets-caption">-</span></div><div class="pilot-stat-cell"><span class="pilot-stat-label">오늘의 손익</span><strong class="pilot-stat-value" id="pilot-today-profit">-</strong><span class="pilot-stat-caption" id="pilot-today-profit-caption">-</span></div><div class="pilot-stat-cell"><span class="pilot-stat-label">누적 손익</span><strong class="pilot-stat-value" id="pilot-cumulative-profit">-</strong><span class="pilot-stat-caption" id="pilot-cumulative-profit-caption">-</span></div><div class="pilot-stat-cell"><span class="pilot-stat-label">승률</span><strong class="pilot-stat-value" id="pilot-win-rate">-</strong><span class="pilot-stat-caption" id="pilot-trade-count-caption">-</span></div></div></section>
                                ${tradePanelMarkup('overview', '실행 전 현재 모드를 먼저 확인하세요.')}
                            </div>
                            <div class="pilot-section-spacer"></div>
                            <section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">보유 포지션</h2><p class="pilot-panel-subtitle">현재 평가손익과 다음으로 취할 수 있는 안전한 행동입니다.</p></div><button type="button" class="pilot-link-button" data-pilot-view="portfolio">전체 포트폴리오 보기 <i class="ph ph-arrow-right" aria-hidden="true"></i></button></div><div class="pilot-table-wrap"><table class="pilot-table"><thead><tr><th>자산</th><th class="pilot-table-number">수량</th><th class="pilot-table-number">평균 진입가</th><th class="pilot-table-number">현재가</th><th class="pilot-table-number">평가손익</th><th class="pilot-table-number">수익률</th><th>관리</th></tr></thead><tbody id="pilot-overview-positions"></tbody></table></div></section>
                            <div class="pilot-section-spacer"></div>
                            <div class="pilot-split-grid"><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">최근 활동</h2><p class="pilot-panel-subtitle">최근 주문과 신호</p></div><button type="button" class="pilot-link-button" data-pilot-view="history">전체 기록 <i class="ph ph-arrow-right" aria-hidden="true"></i></button></div><div class="pilot-panel-body"><div class="pilot-evidence-list" id="pilot-activity-list"></div></div></section><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">리스크 상태</h2></div><i class="ph ph-shield-check" style="color: var(--sl-green); font-size: 21px;" aria-hidden="true"></i></div><div class="pilot-panel-body" id="pilot-risk-summary"></div></section></div>
                        </section>

                        <section class="pilot-page" data-pilot-page="trade"><div class="pilot-page-heading"><div><h1 class="pilot-page-title">거래 실행</h1><p class="pilot-page-description">현재 모드에서 주문을 실행합니다.</p></div><div class="pilot-heading-actions"><span class="pilot-sync-note" id="pilot-trade-sync">-</span><button type="button" class="pilot-button" data-pilot-action="refresh-core"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> 잔액 새로고침</button></div></div><div class="pilot-split-grid">${tradePanelMarkup('trade', '수량·금액을 검토한 뒤 한 번만 실행합니다.')}<section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">스마트 주문</h2><p class="pilot-panel-subtitle">금액과 조건을 선택합니다.</p></div><span class="pilot-status-pill">모의투자 기준</span></div><div class="pilot-panel-body"><div class="pilot-inline-note"><i class="ph ph-info" aria-hidden="true"></i><span>스마트 주문은 거래량 상위 마켓과 현재 전략 점수를 사용합니다. 결과가 보장되는 추천이 아닙니다.</span></div><div class="pilot-section-spacer"></div><div class="pilot-wallet-action"><h3>스마트 매수</h3><label class="pilot-field"><span class="pilot-field-label">총 투자금액 <span class="pilot-field-hint" id="pilot-smart-buy-balance">가용 잔액 -</span></span><input class="pilot-input" type="number" id="pilot-smart-buy-amount" min="5000" step="1000" value="100000"></label><div class="pilot-field-row" style="margin-top:9px"><label class="pilot-field"><span class="pilot-field-label">최소 점수</span><input class="pilot-input" type="number" id="pilot-smart-buy-score" min="0" max="100" value="60"></label><label class="pilot-field"><span class="pilot-field-label">최대 종목</span><input class="pilot-input" type="number" id="pilot-smart-buy-max" min="1" max="30" value="10"></label></div><button type="button" class="pilot-button is-success" style="width:100%; margin-top:12px" data-pilot-action="smart-buy"><i class="ph ph-stack" aria-hidden="true"></i> 스마트 매수 검토</button></div><div class="pilot-section-spacer"></div><div class="pilot-wallet-action"><h3>스마트 매도</h3><label class="pilot-field"><span class="pilot-field-label">목표 매도금액 <span class="pilot-field-hint" id="pilot-smart-sell-holding">보유 평가액 -</span></span><input class="pilot-input" type="number" id="pilot-smart-sell-amount" min="1000" step="1000" value="100000"></label><label class="pilot-field" style="margin-top:9px"><span class="pilot-field-label">매도 우선순위</span><select class="pilot-select" id="pilot-smart-sell-strategy"><option value="worst">손실 큰 자산부터</option><option value="best">수익 큰 자산부터</option><option value="overbought">RSI 과매수부터</option></select></label><button type="button" class="pilot-button is-danger" style="width:100%; margin-top:12px" data-pilot-action="smart-sell"><i class="ph ph-arrow-circle-down" aria-hidden="true"></i> 스마트 매도 검토</button></div></div></section></div><div class="pilot-section-spacer"></div><div class="pilot-split-grid"><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">매수 관심 종목</h2><p class="pilot-panel-subtitle">임계값에 가까운 종목을 확인하고 주문 패널로 넘깁니다.</p></div><button type="button" class="pilot-button is-small" data-pilot-action="load-recommendations">분석 새로고침</button></div><div class="pilot-panel-body"><div id="pilot-buy-recommendations" class="pilot-evidence-list"><div class="pilot-inline-empty">분석 새로고침을 눌러 최신 추천을 확인하세요.</div></div></div></section><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">매도 관심 포지션</h2><p class="pilot-panel-subtitle">보유 자산 중 리스크 신호가 가까운 종목입니다.</p></div><span class="pilot-status-pill is-warning">판단 보조</span></div><div class="pilot-panel-body"><div id="pilot-sell-recommendations" class="pilot-evidence-list"><div class="pilot-inline-empty">분석 새로고침을 눌러 최신 추천을 확인하세요.</div></div></div></section></div></section>

                        <section class="pilot-page" data-pilot-page="portfolio"><div class="pilot-page-heading"><div><h1 class="pilot-page-title">포트폴리오</h1><p class="pilot-page-description">잔액과 보유 자산을 확인합니다.</p></div><div class="pilot-heading-actions"><button type="button" class="pilot-button" data-pilot-action="refresh-core"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> 새로고침</button></div></div><div class="pilot-history-summary"><div class="pilot-history-metric"><span>총 평가자산</span><strong id="pilot-portfolio-assets">-</strong></div><div class="pilot-history-metric"><span>누적 손익</span><strong id="pilot-portfolio-profit">-</strong></div><div class="pilot-history-metric"><span>현금 잔액</span><strong id="pilot-portfolio-cash">-</strong></div><div class="pilot-history-metric"><span>보유 종목</span><strong id="pilot-portfolio-count">-</strong></div></div><div class="pilot-split-grid"><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">자산 구성</h2><p class="pilot-panel-subtitle">보유 자산과 현금의 현재 비중</p></div></div><div class="pilot-panel-body" style="display:grid; grid-template-columns:170px minmax(0,1fr); gap:22px; align-items:center"><canvas id="pilot-allocation-chart" style="width:170px;height:170px" aria-label="자산 구성 차트"></canvas><div id="pilot-allocation-legend"></div></div></section><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">계좌 요약</h2><p class="pilot-panel-subtitle">현재 모드의 계좌 상태</p></div></div><div class="pilot-panel-body" id="pilot-account-summary"></div></section></div><div class="pilot-section-spacer"></div><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">자산 추이</h2><p class="pilot-panel-subtitle">기간을 바꿔 평가자산의 변화를 확인합니다.</p></div><div class="pilot-range-tabs"><button type="button" class="pilot-tab-button" data-pilot-portfolio-period="1h">1H</button><button type="button" class="pilot-tab-button is-active" data-pilot-portfolio-period="24h">1D</button><button type="button" class="pilot-tab-button" data-pilot-portfolio-period="7d">1W</button><button type="button" class="pilot-tab-button" data-pilot-portfolio-period="30d">1M</button></div></div><div class="pilot-chart-wrap"><canvas id="pilot-portfolio-chart" class="pilot-chart-canvas" aria-label="포트폴리오 자산 추이"></canvas><div class="pilot-chart-empty" id="pilot-portfolio-empty" hidden>자산 추이를 수집 중입니다.</div></div></section><div class="pilot-section-spacer"></div><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">보유 포지션 상세</h2><p class="pilot-panel-subtitle">부분 매도와 전량 청산은 각각 확인 단계를 거칩니다.</p></div></div><div class="pilot-table-wrap"><table class="pilot-table"><thead><tr><th>자산</th><th class="pilot-table-number">수량</th><th class="pilot-table-number">평단</th><th class="pilot-table-number">현재가</th><th class="pilot-table-number">평가액</th><th class="pilot-table-number">평가손익</th><th>관리</th></tr></thead><tbody id="pilot-portfolio-positions"></tbody></table></div></section><div class="pilot-section-spacer"></div><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">모의투자 지갑</h2><p class="pilot-panel-subtitle">실제 계좌에는 영향을 주지 않는 시드머니 관리입니다.</p></div><span class="pilot-status-pill" id="pilot-wallet-mode">DRY RUN 전용</span></div><div class="pilot-panel-body"><div class="pilot-wallet"><div class="pilot-wallet-action"><h3>입금</h3><div class="pilot-wallet-action-row"><input class="pilot-input" type="number" id="pilot-deposit-amount" min="1000" step="1000" placeholder="금액 (원)"><button type="button" class="pilot-button is-success" data-pilot-action="deposit">입금</button></div><div class="pilot-wallet-presets"><button type="button" class="pilot-filter-chip" data-pilot-deposit="100000">+10만</button><button type="button" class="pilot-filter-chip" data-pilot-deposit="500000">+50만</button><button type="button" class="pilot-filter-chip" data-pilot-deposit="1000000">+100만</button></div></div><div class="pilot-wallet-action"><h3>출금</h3><div class="pilot-wallet-action-row"><input class="pilot-input" type="number" id="pilot-withdraw-amount" min="1000" step="1000" placeholder="금액 (원)"><button type="button" class="pilot-button is-danger" data-pilot-action="withdraw">출금</button></div><div class="pilot-wallet-presets"><button type="button" class="pilot-filter-chip" data-pilot-withdraw="100000">-10만</button><button type="button" class="pilot-filter-chip" data-pilot-withdraw="500000">-50만</button></div></div></div><div class="pilot-inline-note" style="margin-top:10px"><i class="ph ph-warning" aria-hidden="true"></i><span>시드머니 리셋은 기존 모의 포트폴리오와 전략 포지션을 초기화합니다. 실행 전 확인합니다.</span><button type="button" class="pilot-button is-small" data-pilot-action="reset-wallet">시드 리셋</button></div></div></section></section>

                        <section class="pilot-page" data-pilot-page="market"><div class="pilot-page-heading"><div><h1 class="pilot-page-title">시장 관찰</h1><p class="pilot-page-description">선택한 마켓의 가격·캔들·거래량을 보고, 같은 화면에서 모의 주문을 검토합니다.</p></div><div class="pilot-heading-actions"><label class="pilot-field" style="min-width:200px"><span class="pilot-visually-hidden">마켓 검색</span><input class="pilot-input pilot-market-search" id="pilot-market-search" type="search" placeholder="마켓 검색 (BTC, ETH)"></label><button type="button" class="pilot-button" data-pilot-action="refresh-market"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> 시세 새로고침</button></div></div><div class="pilot-market-layout"><section class="pilot-panel"><div class="pilot-market-quote"><div><span class="pilot-market-symbol" id="pilot-market-symbol">BTC/KRW</span><span class="pilot-market-name" id="pilot-market-name">선택된 마켓</span></div><div><span class="pilot-market-price" id="pilot-market-price">-</span><span class="pilot-market-change" id="pilot-market-change">-</span></div></div><div class="pilot-market-metrics"><div><span class="pilot-market-metric-label">24H 고가</span><strong class="pilot-market-metric-value" id="pilot-market-high">-</strong></div><div><span class="pilot-market-metric-label">24H 저가</span><strong class="pilot-market-metric-value" id="pilot-market-low">-</strong></div><div><span class="pilot-market-metric-label">거래대금</span><strong class="pilot-market-metric-value" id="pilot-market-volume">-</strong></div><div><span class="pilot-market-metric-label">보유 평가</span><strong class="pilot-market-metric-value" id="pilot-market-holding">-</strong></div></div><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">가격 차트</h2><p class="pilot-panel-subtitle">현재가와 완료 캔들을 분리해 표시합니다.</p></div><div class="pilot-market-toolbar"><button type="button" class="pilot-market-interval" data-pilot-candle-interval="1">1m</button><button type="button" class="pilot-market-interval is-active" data-pilot-candle-interval="5">5m</button><button type="button" class="pilot-market-interval" data-pilot-candle-interval="15">15m</button><button type="button" class="pilot-market-interval" data-pilot-candle-interval="60">1h</button></div></div><div class="pilot-market-chart-wrap"><canvas id="pilot-market-chart" class="pilot-market-chart" aria-label="선택 마켓 캔들 차트"></canvas><div class="pilot-chart-empty" id="pilot-market-empty" hidden>캔들 데이터를 불러오는 중입니다.</div></div></section>${tradePanelMarkup('market', '선택한 마켓과 보유 수량을 기준으로 계산합니다.')}</div><div class="pilot-section-spacer"></div><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">실시간 마켓</h2><p class="pilot-panel-subtitle">행을 선택하면 차트와 주문 패널이 함께 바뀝니다.</p></div><div class="pilot-filter-bar"><select class="pilot-select" style="width:auto" id="pilot-market-sort"><option value="volume">거래대금순</option><option value="change_desc">상승률순</option><option value="change_asc">하락률순</option><option value="name">이름순</option></select></div></div><div class="pilot-market-list" id="pilot-market-list"></div></section></section>

                        <section class="pilot-page" data-pilot-page="analysis"><div class="pilot-page-heading"><div><h1 class="pilot-page-title">전략 분석</h1><p class="pilot-page-description">시장별 신호와 지표를 확인합니다.</p></div><div class="pilot-heading-actions"><select class="pilot-select" style="width:auto" id="pilot-analysis-filter"><option value="all">전체 판정</option><option value="BUY">매수</option><option value="SELL">매도</option><option value="HOLD">관망</option></select><select class="pilot-select" style="width:auto" id="pilot-analysis-sort"><option value="score">총점순</option><option value="buy">매수점수순</option><option value="sell">매도점수순</option><option value="volume">거래대금순</option><option value="change">변동률순</option></select><button type="button" class="pilot-button" data-pilot-action="load-analysis"><i class="ph ph-play" aria-hidden="true"></i> 분석 실행</button></div></div><section class="pilot-panel"><div class="pilot-analysis-summary"><div class="pilot-analysis-stat"><strong id="pilot-analysis-total">-</strong><span>분석 마켓</span></div><div class="pilot-analysis-stat is-buy"><strong id="pilot-analysis-buy">-</strong><span>매수 판정</span></div><div class="pilot-analysis-stat is-sell"><strong id="pilot-analysis-sell">-</strong><span>매도 판정</span></div><div class="pilot-analysis-stat is-watch"><strong id="pilot-analysis-hold">-</strong><span>관망</span></div><div class="pilot-analysis-stat"><strong id="pilot-analysis-strong">-</strong><span>강한 신호</span></div></div><div class="pilot-analysis-table pilot-table-wrap"><table class="pilot-table"><thead><tr><th>자산</th><th class="pilot-table-number">현재가</th><th class="pilot-table-number">24H</th><th class="pilot-table-number">RSI</th><th>MACD</th><th class="pilot-table-number">점수</th><th>판정</th><th>관리</th></tr></thead><tbody id="pilot-analysis-rows"></tbody></table></div></section></section>

                        <section class="pilot-page" data-pilot-page="news"><div class="pilot-page-heading"><div><h1 class="pilot-page-title">뉴스 센터</h1><p class="pilot-page-description">시장 뉴스를 확인합니다.</p></div><div class="pilot-heading-actions"><select class="pilot-select" style="width:auto" id="pilot-news-filter"><option value="all">전체 감성</option><option value="positive">긍정</option><option value="negative">부정</option><option value="neutral">중립</option></select><button type="button" class="pilot-button" data-pilot-action="load-news"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> 뉴스 새로고침</button></div></div><section class="pilot-panel"><div class="pilot-news-sentiment"><div class="pilot-sentiment-score is-neutral" id="pilot-news-score">-</div><div><div class="pilot-sentiment-title" id="pilot-news-sentiment-title">시장 심리 확인 전</div><div class="pilot-sentiment-description" id="pilot-news-sentiment-copy">새로고침하면 누적 뉴스의 감성을 계산합니다.</div></div><span class="pilot-status-pill is-warning">참고 정보</span></div><div class="pilot-news-list" id="pilot-news-list"><div class="pilot-inline-empty">뉴스 새로고침을 눌러 최신 기사를 확인하세요.</div></div></section></section>

                        <section class="pilot-page" data-pilot-page="settings"><div class="pilot-page-heading"><div><h1 class="pilot-page-title">환경 설정</h1><p class="pilot-page-description">전략·리스크·자동 최적화 설정을 한 번에 조정합니다. 변경 전 현재 모드와 영향 범위를 확인하세요.</p></div><div class="pilot-heading-actions"><button type="button" class="pilot-button" data-pilot-action="reload-settings"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> 서버에서 다시 로드</button><button type="button" class="pilot-button is-primary" data-pilot-action="save-settings"><i class="ph ph-check" aria-hidden="true"></i> 변경사항 적용</button></div></div><div class="pilot-settings-grid"><div><section class="pilot-panel pilot-settings-section"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">자동 최적화</h2><p class="pilot-panel-subtitle">최적화는 후보 탐색이며 결과가 자동으로 실전에 반영되지 않습니다.</p></div><span class="pilot-status-pill is-warning" id="pilot-optimization-status">확인 중</span></div><div class="pilot-panel-body" id="pilot-optimization-controls"></div></section><div class="pilot-section-spacer"></div><section class="pilot-panel pilot-settings-section"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">투자 성향 프리셋</h2><p class="pilot-panel-subtitle">프리셋 적용은 현재 전략 설정을 즉시 변경합니다.</p></div></div><div class="pilot-panel-body"><div class="pilot-preset-grid" id="pilot-preset-grid"><div class="pilot-inline-empty">설정을 불러오는 중입니다.</div></div></div></section></div><section class="pilot-panel pilot-settings-section"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">전략·리스크 파라미터</h2><p class="pilot-panel-subtitle">값을 바꾼 뒤 하단의 적용 버튼으로 서버에 저장합니다.</p></div></div><div class="pilot-panel-body"><div class="pilot-settings-list" id="pilot-settings-list"><div class="pilot-inline-empty">설정을 불러오는 중입니다.</div></div></div></section></div></section>

                        <section class="pilot-page" data-pilot-page="history"><div class="pilot-page-heading"><div><h1 class="pilot-page-title">실전 준비 현황</h1><p class="pilot-page-description">전략과 모의투자 상태를 확인합니다.</p></div><div class="pilot-heading-actions"><button type="button" class="pilot-button" data-pilot-action="refresh-history"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> 새로고침</button></div></div><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">전략 사전 점검</h2><p class="pilot-panel-subtitle" id="pilot-validation-meta">리포트 확인 중</p></div><span class="pilot-status-pill is-warning" id="pilot-validation-status-pill">확인 중</span></div><div id="pilot-validation-detail"></div></section><div class="pilot-section-spacer"></div><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">모의투자 세션</h2><p class="pilot-panel-subtitle" id="pilot-paper-meta">세션 확인 중</p></div><div class="pilot-heading-actions"><button type="button" class="pilot-button is-small" data-pilot-action="start-paper">새 세션 시작</button><button type="button" class="pilot-button is-small is-danger" data-pilot-action="stop-paper">세션 중지</button></div></div><div class="pilot-paper-status" id="pilot-paper-detail"></div></section></section>
                    </main>
                    <footer class="pilot-footer"><span><strong>CoinPilot</strong></span></footer>
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
            analysisPanel.insertAdjacentHTML('afterbegin', '<div class="pilot-inline-note pilot-analysis-advisory"><i class="ph ph-info" aria-hidden="true"></i><span>분석 신호는 주문을 실행하지 않습니다.</span></div>');
        }

    }

    renderShell();
    mountAiDesk();
    mountPageEnhancements();
    initProgressiveInstall();
    bindAiDesk();
    initializeAiSocket();
    activateView(state.view);

    function updateClock() {
        setText('pilot-clock', new Date().toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }));
    }

    function setConnection(connected, message = '') {
        const connection = byId('pilot-connection');
        if (!connection) return;
        if (state.online === false) {
            connection.classList.add('is-warn');
            connection.classList.remove('is-error');
            setText('pilot-connection-label', '오프라인 · 동적 상태 확인 불가');
            return;
        }
        connection.classList.toggle('is-warn', !connected);
        connection.classList.toggle('is-error', message === '오류');
        setText('pilot-connection-label', connected ? '연결됨' : (message || '연결 대기'));
    }

    function renderOfflineBanner() {
        const banner = byId('pilot-offline-banner');
        if (banner) banner.hidden = state.online !== false;
    }

    function renderMode() {
        const paper = state.activeMode === 'paper';
        const liveReady = state.actualMode === 'LIVE' && state.liveEligible;
        const offline = state.online === false;
        const corePending = !offline && state.coreReady !== true;
        $$('[data-pilot-mode]').forEach(button => {
            const mode = button.dataset.pilotMode;
            button.classList.toggle('is-active', mode === state.activeMode);
            button.classList.toggle('is-locked', mode === 'live' && !liveReady);
            button.setAttribute('aria-pressed', mode === state.activeMode ? 'true' : 'false');
        });

        if (offline) {
            setText('pilot-mode-title', '오프라인 모드');
            setText('pilot-mode-subtitle', '서버에 다시 연결될 때까지 계좌·시세·거래 상태를 표시하지 않습니다.');
        } else if (corePending) {
            setText('pilot-mode-title', '연결 확인 중');
            setText('pilot-mode-subtitle', coreTradingReadinessReason());
        } else if (paper) {
            setText('pilot-mode-title', state.actualMode === 'LIVE' ? '모의투자 보기' : '모의투자 진행 중');
            setText('pilot-mode-subtitle', state.actualMode === 'LIVE'
                ? '현재 서버는 실제투자 모드입니다. 모의 주문은 실행되지 않습니다.'
                : '실제 자금이 아닌 가상 자금으로 전략을 관찰하고 있습니다.');
        } else {
            setText('pilot-mode-title', liveReady ? '실제투자 활성' : '실제투자 잠금');
            setText('pilot-mode-subtitle', liveReady
                ? '사전 점검을 통과한 실제 주문만 현재 계좌에 전송됩니다.'
                : '사전 점검이 모두 완료되기 전까지 실제 주문은 잠겨 있습니다.');
        }

        const banner = byId('pilot-mode-banner');
        const bannerIcon = banner?.querySelector('.pilot-mode-banner-copy > i');
        banner?.classList.toggle('is-live', !paper && liveReady);
        if (bannerIcon) bannerIcon.className = offline
            ? 'ph ph-cloud-slash'
            : !paper && liveReady ? 'ph ph-shield-check' : 'ph ph-lock-key';
        setText('pilot-mode-banner-title', offline ? '오프라인 · 주문 잠금' : corePending ? '연결 확인 중 · 주문 잠금' : !paper && liveReady ? '실제투자 활성' : '실전 주문 잠금');
        setText('pilot-mode-banner-copy', offline
            ? '서버에 다시 연결될 때까지 금융 상태를 표시하지 않으며 모든 실행을 잠급니다.'
            : corePending
            ? coreTradingReadinessReason()
            : !paper && liveReady
            ? '주문 전 자산·수량·리스크를 다시 확인하세요. 실전 체결 결과는 별도 확인이 필요합니다.'
            : tradeBlockReason() || '사전 점검이 완료될 때까지 실제 주문은 실행할 수 없습니다.');
        renderOfflineBanner();
    }

    function renderGateIcon(id, tone, icon) {
        const element = byId(id);
        if (!element) return;
        element.className = `pilot-gate-icon${tone ? ` is-${tone}` : ''}`;
        element.innerHTML = `<i class="ph ph-${icon}" aria-hidden="true"></i>`;
    }

    function renderGateCards() {
        const readiness = state.strategyReadiness;
        const gate = readiness?.liveGate || {};
        const ready = readiness?.source === 'configured_scalping_validation_report' && readiness?.currentEvidence === true && readiness?.status === 'READY' && gate.checked === true && gate.passed === true && readiness?.report?.freshness?.fresh === true;
        const blocked = gate.checked === true && gate.passed === false;
        setText('pilot-gate-validation-detail', ready ? '전략 점검 통과' : blocked ? '전략 점검 보류' : '점검 상태 확인 필요');
        renderGateIcon('pilot-gate-validation-icon', ready ? '' : 'pending', ready ? 'check' : 'warning');

        const paper = state.paper;
        const paperState = paper?.state || (paper?.active ? 'RUNNING' : 'STOPPED');
        setText('pilot-gate-paper-detail', !paper?.available
            ? '세션 없음 · 시작 필요'
            : `${paperState === 'RUNNING' ? '진행 중' : '중지됨'} · 청산 ${number(paper.closedTradeCount)}회`);
        renderGateIcon('pilot-gate-paper-icon', paperState === 'PASS' ? '' : paperState === 'RUNNING' ? 'pending' : 'blocked', paperState === 'PASS' ? 'check' : paperState === 'RUNNING' ? 'hourglass-medium' : 'pause');

        const dataProblem = paper?.orphaned === true || paper?.analysisDataHealth?.failClosed === true || paper?.riskMonitor?.failClosed === true;
        setText('pilot-gate-freshness-detail', !paper?.available ? '세션 없음' : dataProblem ? '데이터 확인 필요' : '데이터 정상');
        renderGateIcon('pilot-gate-freshness-icon', !paper?.available || dataProblem ? 'pending' : '', dataProblem ? 'warning' : 'database');
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
        const paper = state.paper || {};
        const paperLedgerVisible = paper.available === true &&
            (paper.active === true || number(paper.closedTradeCount) > 0);
        const totalAssets = number(account.totalAssets || pnl.totalAssets);
        const totalProfit = number(pnl.profit);
        const todayProfit = number(today.realizedProfit);
        const statistics = Array.isArray(state.statistics) ? state.statistics : [];
        const strategyTradeCount = statistics.reduce((sum, row) => sum + number(row.totalTrades || row.trades || row.tradeCount), 0);
        const totalTrades = paperLedgerVisible ? number(paper.closedTradeCount) : strategyTradeCount;
        const wins = paperLedgerVisible
            ? number(paper.strictEvaluation?.winningTrades)
            : statistics.reduce((sum, row) => sum + number(row.winningTrades || row.wins), 0);
        const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : null;
        setText('pilot-total-assets', formatWon(totalAssets));
        setText('pilot-total-assets-caption', `${formatPercent(pnl.profitPercent)} · 기준 ${formatWon(pnl.initialSeedMoney || account.initialSeedMoney)}`);
        setText('pilot-today-profit', formatSignedWon(todayProfit));
        setText('pilot-today-profit-caption', `매수 ${today.buyCount || 0} · 매도 ${today.sellCount || 0}`);
        setText('pilot-cumulative-profit', formatSignedWon(totalProfit));
        setText('pilot-cumulative-profit-caption', formatPercent(pnl.profitPercent));
        setText('pilot-win-rate', winRate === null ? '-' : `${winRate.toFixed(1)}%`);
        setText('pilot-trade-count-caption', paperLedgerVisible
            ? `모의투자 청산 ${totalTrades}회`
            : `집계 거래 ${totalTrades || today.totalTrades || 0}회`);
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
        if (state.paper?.active) activity.push({ time: state.paper.updatedAt || state.paper.lastHeartbeat || state.paper.heartbeatAt, title: '모의투자 세션 관찰 중', detail: `청산 ${state.paper.closedTradeCount || 0}회 · 중단 ${state.paper.interruptionCount || state.paper.interruptions?.length || 0}회`, value: state.paper.state || 'RUNNING' });
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
        const analysisHealth = paper.analysisDataHealth || {};
        const circuit = paper.lossCircuitBreaker || state.status?.lossCircuitBreaker || {};
        const stale = number(freshness.blockedSnapshots) + number(freshness.blockedAnalyses) + number(freshness.blockedEntries);
        const analysisGap = number(analysisHealth.currentGapDurationSeconds);
        const analysisIncomplete = number(paper.telemetry?.analysisIncompleteCycles);
        const analysisTone = analysisHealth.failClosed || analysisHealth.continuityEligible === false
            ? 'danger'
            : analysisGap > 0 || analysisIncomplete > 0 ? 'warning' : 'ok';
        const analysisStartedAt = Date.parse(analysisHealth.analysisStartedAt || '');
        const analysisAge = Number.isFinite(analysisStartedAt)
            ? Math.max(0, (Date.now() - analysisStartedAt) / 1000)
            : 0;
        const analysisDetail = analysisHealth.failClosed
            ? `공백 ${analysisGap.toFixed(1)}초 · 관찰 중지`
            : analysisHealth.analysisActive === true
                ? `분석 진행 중 · ${analysisAge.toFixed(1)}초`
            : analysisGap > 0
                ? `부분 응답 재시도 · 공백 ${analysisGap.toFixed(1)}초`
                : analysisIncomplete > 0
                    ? `부분 응답 ${analysisIncomplete}회 기록`
                    : '전체 대상 시장 분석 수신 정상';
        const items = [
            { title: '실행 모드', detail: state.actualMode === 'LIVE' ? '서버 실제투자 · 주문 전 확인 필요' : '서버 모의투자 · 실제 자금 미사용', tone: state.actualMode === 'LIVE' ? 'warning' : 'ok' },
            { title: '시세 데이터', detail: stale ? `${stale}회 진입 데이터 차단 기록` : `허용 지연 ${formatPrice(freshness.maxAgeSeconds || 90)}초`, tone: stale ? 'warning' : 'ok' },
            { title: '분석 데이터 상태', detail: analysisDetail, tone: analysisTone },
            { title: '연속 손실 차단', detail: circuit.enabled ? `${circuit.lossCount || 0}/${circuit.maxLosses || 0}회 · ${circuit.coolingDown ? '차단 중' : '대기 중'}` : '비활성화', tone: circuit.coolingDown ? 'danger' : circuit.enabled ? 'warning' : 'ok' },
            { title: '관찰 연속성', detail: paper.continuityEligible === false ? '공백 기록으로 전환 보류' : paper.available ? '현재 세션 기준 확인 중' : '세션 없음', tone: paper.continuityEligible === false ? 'danger' : paper.available ? 'ok' : 'warning' }
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
        const selectedBefore = prefix === 'market' ? state.selectedCoin : (select.value || state.selectedCoin);
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
        if (lockCopy) lockCopy.textContent = canTrade() ? (state.activeMode === 'live' ? '사전 점검 통과 상태입니다. 실행 전 최종 확인이 필요합니다.' : '가상 자금으로 주문 흐름을 확인합니다.') : tradeBlockReason();
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
            ctx.font = '11px Manrope, "Noto Sans KR", sans-serif'; ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(20, 41, 73, 0.12)'; ctx.fillStyle = '#66707f';
            for (let row = 0; row <= 4; row += 1) { const y = padding.top + (row / 4) * innerHeight; ctx.beginPath(); ctx.moveTo(padding.left, y); ctx.lineTo(width - padding.right, y); ctx.stroke(); ctx.fillText(formatWon(max - (row / 4) * range, ''), 8, y + 4); }
            const pointAt = (index, value) => ({ x: padding.left + (index / Math.max(1, values.length - 1)) * innerWidth, y: padding.top + innerHeight - ((value - min) / range) * innerHeight });
            const base = pointAt(0, seed).y; ctx.setLineDash([4, 5]); ctx.strokeStyle = '#a5adb7'; ctx.beginPath(); ctx.moveTo(padding.left, base); ctx.lineTo(width - padding.right, base); ctx.stroke(); ctx.setLineDash([]);
            const coords = values.map((value, index) => pointAt(index, value)); ctx.beginPath(); coords.forEach((point, index) => index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)); ctx.lineWidth = 2.5; ctx.strokeStyle = '#1268d6'; ctx.stroke();
            const last = coords[coords.length - 1];
            if (last) { ctx.fillStyle = '#1268d6'; ctx.beginPath(); ctx.arc(last.x, last.y, 4, 0, Math.PI * 2); ctx.fill(); ctx.font = '700 12px Manrope, "Noto Sans KR", sans-serif'; ctx.fillText(formatWon(values[values.length - 1]), Math.min(width - padding.right - 105, last.x + 8), Math.max(18, last.y - 10)); }
            ctx.fillStyle = '#66707f'; ctx.font = '10px Manrope, "Noto Sans KR", sans-serif'; if (points[0]?.timestamp) ctx.fillText(formatTime(points[0].timestamp), padding.left, height - 8); if (points[points.length - 1]?.timestamp) ctx.fillText(formatTime(points[points.length - 1].timestamp), Math.max(padding.left, width - padding.right - 40), height - 8);
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
            items.forEach((item, index) => { const sweep = (item.value / total) * Math.PI * 2; ctx.beginPath(); ctx.moveTo(center, center); ctx.arc(center, center, radius, start, start + sweep); ctx.closePath(); ctx.fillStyle = index === 0 ? '#1268d6' : index === 1 ? '#0a7a58' : index === 2 ? '#e6a12d' : '#b9c0c9'; ctx.fill(); start += sweep; });
            ctx.fillStyle = '#142949'; ctx.font = '700 15px Manrope, "Noto Sans KR", sans-serif'; ctx.textAlign = 'center'; ctx.fillText(total ? formatWon(total, '') : '0', center, center + 5); ctx.textAlign = 'left';
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
            ctx.font = '10px Manrope, "Noto Sans KR", sans-serif'; ctx.fillStyle = '#66707f'; ctx.strokeStyle = 'rgba(20, 41, 73, 0.12)'; ctx.lineWidth = 1;
            for (let row = 0; row <= 4; row += 1) { const lineY = padding.top + (row / 4) * innerHeight; ctx.beginPath(); ctx.moveTo(padding.left, lineY); ctx.lineTo(width - padding.right, lineY); ctx.stroke(); ctx.fillText(formatPrice(high - (row / 4) * range), width - padding.right + 7, lineY + 4); }
            const step = innerWidth / candles.length; const bodyWidth = Math.max(2, Math.min(12, step * 0.62));
            candles.forEach((candle, index) => { const x = padding.left + step * index + step / 2; const open = number(candle.open); const close = number(candle.close); const highValue = number(candle.high); const lowValue = number(candle.low); const bullish = close >= open; ctx.strokeStyle = bullish ? '#0a7a58' : '#b5433e'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, y(highValue)); ctx.lineTo(x, y(lowValue)); ctx.stroke(); ctx.fillStyle = bullish ? '#0a7a58' : '#b5433e'; const top = y(Math.max(open, close)); const bottom = y(Math.min(open, close)); ctx.fillRect(x - bodyWidth / 2, top, bodyWidth, Math.max(1, bottom - top)); });
            ctx.fillStyle = '#66707f'; if (candles[0]?.time) ctx.fillText(formatTime(candles[0].time), padding.left, height - 7); if (candles[candles.length - 1]?.time) ctx.fillText(formatTime(candles[candles.length - 1].time), Math.max(padding.left, width - padding.right - 42), height - 7);
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
        target.innerHTML = `<div class="pilot-market-row pilot-market-row-head" aria-hidden="true"><span class="pilot-market-row-label">마켓</span><span class="pilot-market-row-label" style="text-align:right">현재가</span><span class="pilot-market-row-label" style="text-align:right">24H</span><span class="pilot-market-row-label" style="text-align:right">거래량</span><span></span></div>${list.slice(0, 80).map(item => `<div class="pilot-market-row ${item.coin === state.selectedCoin ? 'is-selected' : ''}" role="button" tabindex="0" data-pilot-market-row="${escapeHtml(item.coin)}"><span class="pilot-market-row-symbol">${escapeHtml(symbolOf(item.coin))}/KRW</span><span class="pilot-market-row-price">${formatPrice(item.price)}</span><span class="pilot-market-row-change ${classForValue(item.change)}">${formatPercent(item.change)}</span><span class="pilot-market-row-volume">${formatWon(item.volumeKrw)}</span><span><i class="ph ph-arrow-up-right" aria-hidden="true"></i></span></div>`).join('')}`;
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
        const readiness = state.strategyReadiness;
        const report = readiness?.report;
        const target = byId('pilot-validation-detail');
        const pill = byId('pilot-validation-status-pill');
        if (!target || !pill) return;
        byId('pilot-validation-confidence')?.remove();
        const gate = readiness?.liveGate || {};
        const ready = readiness?.source === 'configured_scalping_validation_report' && readiness?.currentEvidence === true && readiness?.status === 'READY' && gate.checked === true && gate.passed === true && report?.freshness?.fresh === true;
        const blocked = gate.checked === true && gate.passed === false;
        pill.textContent = ready ? '통과' : blocked ? '보류' : '확인 필요';
        pill.className = `pilot-status-pill${ready ? '' : ' is-warning'}`;
        setText('pilot-validation-meta', report?.generatedAt ? `마지막 점검 ${formatDateTime(report.generatedAt)}` : '점검 상태를 확인할 수 없습니다.');
        const headline = ready ? '전략 점검을 통과했습니다.' : blocked ? '현재 전략은 실제투자 준비가 되지 않았습니다.' : '현재 점검 상태를 확인할 수 없습니다.';
        const description = ready ? '실제 주문 가능 여부는 현재 모드와 모의투자 상태도 함께 따릅니다.' : blocked ? '최신 전략 점검을 확인한 뒤 다시 검토하세요.' : '실제투자 준비 여부를 확인할 때까지 주문은 잠겨 있습니다.';
        target.innerHTML = `<div class="pilot-validation-detail"><div><div class="pilot-validation-headline">${headline}</div><div class="pilot-validation-copy">${description}</div></div></div>`;
    }

    function renderPaperDetail() {
        const status = state.paper;
        const target = byId('pilot-paper-detail');
        if (!target) return;
        byId('pilot-paper-confidence')?.remove();
        const running = status?.available === true && status?.active === true;
        const readOnly = status?.readOnlyObserver === true;
        const headerStart = root.querySelector('.pilot-panel-header [data-pilot-action="start-paper"]');
        const headerStop = root.querySelector('.pilot-panel-header [data-pilot-action="stop-paper"]');
        if (headerStart) {
            headerStart.dataset.pilotSessionDisabled = String(running);
            headerStart.disabled = running || readOnly;
        }
        if (headerStop) {
            headerStop.dataset.pilotSessionDisabled = String(!running);
            headerStop.disabled = !running || readOnly;
        }
        if (!status?.available) {
            setText('pilot-paper-meta', '진행 중인 세션이 없습니다.');
            target.innerHTML = '<div class="pilot-paper-status"><div class="pilot-paper-status-head"><strong class="pilot-paper-state is-stopped">모의투자 세션 없음</strong></div><div class="pilot-paper-meta">기존 가상 자산을 유지하거나 새 자산으로 다시 시작할 수 있습니다.</div><div class="pilot-paper-actions"><button type="button" class="pilot-button" data-pilot-action="start-paper">현재 상태로 시작</button><button type="button" class="pilot-button is-danger" data-pilot-action="start-paper-reset">초기화 후 시작</button></div><div class="pilot-inline-note">초기화하면 기존 모의 포트폴리오와 포지션이 지워집니다.</div></div>';
            syncObserverControls();
            return;
        }
        const stateLabel = running ? '모의투자 진행 중' : '모의투자 중지';
        const hasProblem = status.orphaned === true || status.riskMonitor?.failClosed === true || status.analysisDataHealth?.failClosed === true;
        const configChanged = status.configConsistent === false;
        const openCount = number(status.strictEvaluation?.activePositions);
        setText('pilot-paper-meta', `마지막 갱신 ${formatDateTime(status.updatedAt || status.heartbeatAt || status.lastHeartbeat)}`);
        target.innerHTML = `<div class="pilot-paper-status"><div class="pilot-paper-status-head"><strong class="pilot-paper-state ${running ? '' : 'is-stopped'}">${stateLabel}</strong><span class="pilot-status-pill ${hasProblem ? 'is-danger' : running ? '' : 'is-warning'}">${hasProblem ? '상태 확인 필요' : running ? '진행 중' : '중지'}</span></div><div class="pilot-paper-meta">가상 자산 ${formatWon(status.currentAssets)} · 수익률 ${formatPercent(status.returnPercent)}<br>실현 손익 ${formatSignedWon(status.realizedProfit)} · 청산 ${number(status.closedTradeCount)}회 · 보유 ${openCount}개</div>${hasProblem ? '<div class="pilot-paper-orphan-alert">세션 연결 또는 시세 상태를 확인하세요. 새 거래가 중지되었습니다.</div>' : ''}${configChanged ? '<div class="pilot-inline-note">설정이 바뀌어 이 세션을 다시 확인해야 합니다.</div>' : ''}</div>`;
        syncObserverControls();
    }

    function renderSettings() {
        const settings = state.settings; if (!settings) return;
        const ranges = settings.ranges || {}; const values = settings.values || {}; const list = byId('pilot-settings-list');
        if (list) {
            const toggles = [
                { key: 'marketRegimeEnabled', label: '시장 방향성 필터', description: '전체 시장 방향이 약할 때 신규 진입을 차단하는 설정입니다.', value: settings.investmentConfig?.scalping?.marketRegimeEnabled === true },
                { key: 'requireReboundBelowOverbought', label: '반등 과매수 보호', description: '반등 확정 시 RSI가 과매수이면 늦은 진입을 막는 설정입니다.', value: settings.investmentConfig?.scalping?.requireReboundBelowOverbought === true }
            ];
            const toggleHtml = toggles.map(item => `<div class="pilot-setting-row"><div><span class="pilot-setting-label">${escapeHtml(toUserText(item.label))}</span><span class="pilot-setting-description">${escapeHtml(toUserText(item.description))}</span></div><label class="pilot-switch"><input type="checkbox" data-pilot-setting-key="${item.key}" ${item.value ? 'checked' : ''}><span class="pilot-switch-track"></span></label></div>`).join('');
            const rangeHtml = Object.keys(ranges).map(key => { const range = ranges[key] || {}; const raw = values[key] ?? range.min ?? 0; const display = key === 'investmentRatio' ? number(raw) * 100 : raw; return `<div class="pilot-setting-row"><div><span class="pilot-setting-label">${escapeHtml(toUserText(range.label || key))}</span><span class="pilot-setting-description">${escapeHtml(toUserText(range.description || ''))}</span></div><div class="pilot-setting-control"><input class="pilot-input" type="number" data-pilot-setting-key="${escapeHtml(key)}" data-pilot-setting-kind="number" data-pilot-setting-display="${key === 'investmentRatio' ? 'percent' : 'raw'}" min="${escapeHtml(key === 'investmentRatio' ? number(range.min) * 100 : range.min)}" max="${escapeHtml(key === 'investmentRatio' ? number(range.max) * 100 : range.max)}" step="${escapeHtml(key === 'investmentRatio' ? number(range.step) * 100 : range.step)}" value="${escapeHtml(display)}"></div></div>`; }).join('');
            const lock = paperEvidenceMutationLock();
            const lockNote = lock
                ? `<div class="pilot-inline-note" style="margin-bottom:12px; border-color:var(--sl-amber);"><i class="ph ph-lock-key" aria-hidden="true"></i><span>모의투자 검증 세션 보호 중입니다. 세션을 중지하기 전까지 설정·프리셋·자동 최적화 변경을 잠급니다.</span></div>`
                : '';
            list.innerHTML = lockNote + toggleHtml + rangeHtml;
        }
        const presetGrid = byId('pilot-preset-grid');
        if (presetGrid) { const presets = settings.presets || []; presetGrid.innerHTML = presets.length ? presets.map(preset => `<button type="button" class="pilot-preset-card" data-pilot-preset-id="${escapeHtml(preset.id)}"><span><span class="pilot-preset-name">${escapeHtml(preset.name)}</span><span class="pilot-preset-en">${escapeHtml(preset.nameEn)}</span></span><span class="pilot-preset-risk">${'●'.repeat(number(preset.riskLevel))}${'○'.repeat(Math.max(0, 5 - number(preset.riskLevel)))}</span></button>`).join('') : '<div class="pilot-inline-empty">프리셋이 없습니다.</div>'; }
        const optimization = settings.optimization || {}; const controls = byId('pilot-optimization-controls');
        if (controls) {
            controls.innerHTML = `<div class="pilot-control-row"><div class="pilot-control-copy"><strong>자동 최적화</strong><span>주기적으로 파라미터를 탐색합니다. 실제투자 전환과는 별개입니다.</span></div><label class="pilot-switch"><input type="checkbox" id="pilot-auto-optimization" ${optimization.enabled ? 'checked' : ''}><span class="pilot-switch-track"></span></label></div><div class="pilot-control-row"><div class="pilot-control-copy"><strong>최적화 주기</strong><span>다음 실행: ${escapeHtml(formatDateTime(optimization.nextRun))}</span></div><select class="pilot-select" style="max-width:140px" id="pilot-optimization-interval"><option value="3600000">1시간</option><option value="7200000">2시간</option><option value="10800000">3시간</option><option value="21600000">6시간</option><option value="43200000">12시간</option><option value="86400000">24시간</option></select></div><div class="pilot-control-row"><div class="pilot-control-copy"><strong>수동 최적화</strong><span>현재 설정을 기준으로 후보 탐색을 시작합니다.</span></div><button type="button" class="pilot-button is-small is-primary" data-pilot-action="run-optimization">최적화 시작</button></div>`;
            const interval = byId('pilot-optimization-interval'); if (interval && optimization.interval) interval.value = String(optimization.interval);
        }
        syncObserverControls();
    }

    function renderHistoryTables() {
        const historyTarget = byId('pilot-optimization-history'); const backtestTarget = byId('pilot-backtest-results'); const optimization = state.settings?.optimizationHistory || []; const backtest = state.settings?.backtestResults || [];
        if (historyTarget) historyTarget.innerHTML = optimization.length ? optimization.slice(0, 8).map(item => `<div class="pilot-evidence-row"><span class="pilot-evidence-time">${escapeHtml(formatTime(item.timestamp || item.date))}</span><div><strong class="pilot-evidence-title">${escapeHtml(item.type || item.strategy || '최적화 실행')}</strong><div class="pilot-evidence-detail">${escapeHtml(toUserText(item.description || item.message || '후보 파라미터 기록'))}</div></div><span class="pilot-evidence-value">${escapeHtml(String(item.fitness ?? item.score ?? '-'))}</span></div>`).join('') : '<div class="pilot-inline-empty">최적화 이력이 없습니다.</div>';
        if (backtestTarget) backtestTarget.innerHTML = backtest.length ? `<div class="pilot-evidence-list">${backtest.slice(0, 8).map(item => `<div class="pilot-evidence-row"><span class="pilot-evidence-time">${escapeHtml(symbolOf(item.coin || item.market || '-'))}</span><div><strong class="pilot-evidence-title">${escapeHtml(item.strategy || item.name || '백테스트')}</strong><div class="pilot-evidence-detail">거래 ${item.totalTrades || item.tradeCount || 0}회 · PF ${item.profitFactor ?? '-'}</div></div><span class="pilot-evidence-value ${classForValue(item.totalReturnPercent || item.returnPercent)}">${formatPercent(item.totalReturnPercent || item.returnPercent)}</span></div>`).join('')}</div>` : '<div class="pilot-inline-empty">백테스트 결과가 없습니다.</div>';
        renderStrategyResearch();
        renderMomentumShadow();
    }

    function renderStrategyResearch() {
        const target = byId('pilot-strategy-research');
        const meta = byId('pilot-strategy-research-meta');
        if (!target) return;
        const report = state.strategyResearch;
        if (!report?.available) {
            if (meta) meta.textContent = report?.reason === 'research_report_not_found'
                ? '지정한 비교 리포트를 찾을 수 없습니다.'
                : '비교 리포트가 설정되지 않았습니다.';
            target.innerHTML = '<div class="pilot-inline-empty">장기 기간 비교 결과는 별도 리포트를 지정하면 표시됩니다. 이 영역은 실전 전환과 무관합니다.</div>';
            return;
        }
        const variants = Array.isArray(report.variants) ? report.variants : [];
        if (report.study === 'same_window_scalping_variant_comparison') {
            const variantEntries = Object.entries(report.variants || {});
            const requestedMarketCount = number(report.requestedMarketCount, Array.isArray(report.markets) ? report.markets.length : 0);
            const freshnessLabel = validationReportFreshness(report.generatedAt, report.reportFreshness);
            const staleNote = report.reportFreshness?.fresh === false
                ? `<div class="pilot-inline-note" style="border-color:var(--sl-amber);"><i class="ph ph-clock-countdown" aria-hidden="true"></i><span>이 비교 report는 ${escapeHtml(freshnessLabel)} 상태입니다. 최신 raw window를 다시 생성하기 전까지 현재 수익성 근거로 사용하지 않습니다.</span></div>`
                : '';
            if (meta) meta.textContent = `참고용 · 동일 candle window · 요청 시장 ${requestedMarketCount}개 · ${freshnessLabel} · 실제 주문·전환과 무관`;
            target.innerHTML = variantEntries.length
                ? `${staleNote}<div class="pilot-inline-note"><i class="ph ph-flask" aria-hidden="true"></i><span>동일 window 후보 비교 결과입니다. invalid 시장이 하나라도 있거나 training gate가 실패하면 실전 전환 근거로 사용할 수 없습니다. 이 결과는 실제 주문·모의투자 기본값을 변경하지 않습니다.</span></div><div class="pilot-evidence-list">${variantEntries.slice(0, 12).map(([name, variant]) => { const summary = variant?.summary || {}; const attempted = number(summary.attemptedMarketCount, requestedMarketCount); const valid = number(summary.marketCount); const invalid = number(summary.invalidMarketCount); const invalidMarkets = Array.isArray(summary.invalidMarkets) ? summary.invalidMarkets.map(item => `${item.market || '-'}: ${toUserText(item.error || '검증 불가')}`).join(' · ') : ''; const returnLabel = formatPercent(summary.sumHoldoutReturnPercent); const detail = `유효 시장 ${valid}/${attempted} · invalid ${invalid}개 · 거래 ${number(summary.holdoutTradeCount)}회 · training gate 실패 ${number(summary.trainingGateFailures)}회${invalidMarkets ? ` · ${invalidMarkets}` : ''}`; return `<div class="pilot-evidence-row"><span class="pilot-evidence-time">참고 보류</span><div><strong class="pilot-evidence-title">${escapeHtml(name)} · 합산 ${escapeHtml(returnLabel)}</strong><div class="pilot-evidence-detail">${escapeHtml(detail)}</div></div><span class="pilot-evidence-value pilot-negative">전환 불가</span></div>`; }).join('')}</div>`
                : '<div class="pilot-inline-empty">표시할 variant study가 없습니다.</div>';
            return;
        }
        if (report.study === 'daily_momentum_robustness_grid') {
            const shortlist = Array.isArray(report.shortlist) ? report.shortlist : [];
            const nearMisses = Array.isArray(report.nearMisses) ? report.nearMisses : [];
            const items = shortlist.length ? shortlist : nearMisses;
            const statusLabel = status => status === 'SHADOW_CANDIDATE_WITH_STOP'
                ? '보호중단 모의 후보'
                : status === 'SHADOW_CANDIDATE' ? '별도 모의 후보' : '보류';
            const blockerLabel = blocker => ({
                unknown_boundary_position: '구간 경계 미청산',
                segment_data_unavailable: '구간 데이터 부족',
                full_return_below_floor: '전체 수익률 기준 미달',
                drawdown_above_limit: 'MDD 기준 초과',
                worst_segment_below_floor: '최악 구간 기준 미달',
                trade_sample_below_minimum: '거래 수 부족'
            }[blocker] || '추가 확인 필요');
            const labelFor = item => {
                const config = item.config || {};
                return `추세 ${formatPercent(config.trendMinPercent)} · 시장 수 ${number(config.breadthMin)} · 비중 ${formatPercent(number(config.positionFraction) * 100)} · 최대 ${number(config.maxPositions)}종목`;
            };
            const statusSummaryLabel = status => status === 'SHADOW_CANDIDATE_WITH_STOP'
                ? '보호중단 후보'
                : status === 'SHADOW_CANDIDATE' ? '일반 후보' : '보류';
            const thresholdSummary = report.benchmarkThresholdSummary
                ? Object.entries(report.benchmarkThresholdSummary)
                    .map(([threshold, counts]) => `${threshold}% ${Object.entries(counts).map(([status, count]) => `${statusSummaryLabel(status)} ${count}개`).join(' · ')}`)
                    .join(' / ')
                : '임계값 비교 없음';
            if (meta) meta.textContent = `참고용 · ${escapeHtml({ continuous: '연속', segments: '분할' }[report.segmentMode] || report.segmentMode || '연속')} 구간 · 통과 후보 ${shortlist.length}개 · 근접 후보 ${nearMisses.length}개 · ${escapeHtml(thresholdSummary)}`;
            target.innerHTML = items.length
                ? `<div class="pilot-inline-note"><i class="ph ph-flask" aria-hidden="true"></i><span>동일 완료 일봉의 위험 범위를 비교한 참고 결과입니다. 실제 주문·실전 전환·모의투자 기본값을 변경하지 않습니다. 최악 구간과 보호중단 발동 여부를 함께 확인하세요.<br>기준 시장 임계값 비교: ${escapeHtml(thresholdSummary)}</span></div><div class="pilot-evidence-list">${items.slice(0, 8).map(item => { const metrics = item.fullMetrics || {}; const blockers = Array.isArray(item.eligibilityBlockers) ? item.eligibilityBlockers.map(blockerLabel).join(' · ') : ''; const risk = item.drawdownStopTriggered ? ' · 보호중단 발동' : ''; const detail = `${labelFor(item)} · PF ${Number.isFinite(Number(metrics.profitFactor)) ? Number(metrics.profitFactor).toFixed(2) : '∞'} · MDD ${formatPercent(metrics.maxDrawdownPercent)} · 최악 구간 ${formatPercent(item.worstSegmentReturnPercent)} · 거래 ${number(metrics.tradeCount)}회${risk}${blockers ? ` · ${blockers}` : ''}`; return `<div class="pilot-evidence-row"><span class="pilot-evidence-time">${escapeHtml(statusLabel(item.status))}</span><div><strong class="pilot-evidence-title">전체 ${formatPercent(metrics.totalReturnPercent)} · ${escapeHtml(labelFor(item))}</strong><div class="pilot-evidence-detail">${escapeHtml(detail)}</div></div><span class="pilot-evidence-value ${item.status === 'HOLD' ? 'pilot-negative' : 'pilot-positive'}">${escapeHtml(statusLabel(item.status))}</span></div>`; }).join('')}</div>`
                : '<div class="pilot-inline-empty">기준을 통과한 후보가 없습니다. 조건에 근접한 후보와 차단 사유를 확인하세요.</div>';
            return;
        }
        if (meta) meta.textContent = `참고용 · 생성 ${formatDateTime(report.generatedAt)} · ${report.markets?.length || 0}개 시장`;
        target.innerHTML = variants.length
            ? `<div class="pilot-inline-note"><i class="ph ph-flask" aria-hidden="true"></i><span>이 결과는 전략 비교·참고용입니다. <strong>실제 주문으로 이어지지 않으며</strong> 실제투자 전환 조건도 변경하지 않습니다.</span></div><div class="pilot-evidence-list">${variants.slice(0, 8).map(variant => { const metrics = variant.portfolio?.metrics || variant.fullAggregate || {}; const status = variant.eligibleForFurtherShadow === true && variant.portfolio?.unknownBoundaryPositionCount === 0 ? '모의 검토' : '보류'; return `<div class="pilot-evidence-row"><span class="pilot-evidence-time">${escapeHtml(String(variant.name || 'variant'))}</span><div><strong class="pilot-evidence-title">통합 모의 ${formatPercent(metrics.totalReturnPercent)} · ${number(metrics.tradeCount)}회</strong><div class="pilot-evidence-detail">PF ${Number.isFinite(Number(metrics.profitFactor)) ? Number(metrics.profitFactor).toFixed(2) : '∞'} · MDD ${formatPercent(metrics.maxDrawdownPercent)} · 시장 구간 ${variant.allMarketFoldsPassed === true ? '통과' : '미달'} · 경계 미청산 ${number(variant.portfolio?.unknownBoundaryPositionCount)}건</div></div><span class="pilot-evidence-value ${status === '모의 검토' ? 'pilot-positive' : 'pilot-negative'}">${status}</span></div>`; }).join('')}</div>`
            : '<div class="pilot-inline-empty">표시할 비교 결과가 없습니다.</div>';
    }

    function renderMomentumShadow() {
        const target = byId('pilot-momentum-shadow');
        const meta = byId('pilot-momentum-shadow-meta');
        if (!target) return;
        const projection = state.momentumShadow;
        if (!projection?.available) {
            if (meta) meta.textContent = '모의투자 상태를 확인할 수 없습니다.';
            target.innerHTML = '<div class="pilot-inline-empty">모의투자 기록이 아직 없습니다.</div>';
            return;
        }
        const books = Array.isArray(projection.books) ? projection.books : [];
        const readiness = projection.candidateReadiness;
        const blockers = Array.isArray(readiness?.blockers)
            ? readiness.blockers.map(blocker => ({
                benchmark_gate_closed: '기준 시장 조건을 충족하지 않았습니다.',
                benchmark_heartbeat_stale: '기준 시장 시세가 오래되었습니다.',
                benchmark_data_quality_invalid: '기준 시장 데이터가 불완전합니다.',
                target_owner_already_running: '이미 관찰 중인 세션이 있습니다.',
                candidate_slot_occupied: '다른 모의투자 세션이 실행 중입니다.',
                benchmark_positions_open: '보유 포지션이 있어 새 세션을 시작할 수 없습니다.',
                benchmark_trades_exist: '기존 거래 기록을 정리한 뒤 다시 시도하세요.',
                benchmark_pending_entries: '진행 중인 주문이 있어 새 세션을 시작할 수 없습니다.'
            }[blocker] || '모의투자를 시작하기 전에 확인이 필요합니다.'))
            : [];
        const readinessHtml = readiness
            ? `<div class="pilot-momentum-shadow-preflight"><strong>모의투자 ${readiness.launchAllowed ? '시작 가능' : '시작 대기'}</strong>${blockers.length ? `<p>${blockers.join(' · ')}</p>` : ''}</div>`
            : '';
        if (meta) meta.textContent = '가상 자금으로 관찰하는 기록입니다. 실제 주문은 실행되지 않습니다.';
        target.innerHTML = readinessHtml + (books.length
            ? books.map(book => {
                const statusClass = book.status === '관찰 중' ? 'is-warning' : book.status === '중지' ? 'is-danger' : 'is-warning';
                const positions = Array.isArray(book.openPositions) && book.openPositions.length
                    ? book.openPositions.map(position => `${escapeHtml(position.asset)} ${formatPrice(position.entryPrice)} → ${position.markPrice === null ? '—' : formatPrice(position.markPrice)} (${formatOptionalPercent(position.markProfitPercent)})`).join('<br>')
                    : '현재 보유 없음';
                const warning = book.configurationWarning
                    ? '<span class="pilot-momentum-shadow-warning">설정이 변경되어 관찰을 다시 확인해야 합니다.</span>'
                    : '';
                return `<article class="pilot-momentum-shadow-card"><div class="pilot-momentum-shadow-card-head"><strong>${escapeHtml(toUserText(book.label))}</strong><span class="pilot-status-pill ${statusClass}">${escapeHtml(toUserText(book.status || '확인 필요'))}</span></div><div class="pilot-momentum-shadow-equity ${classForValue(book.markedReturnPercent)}">${book.available === true ? formatWon(book.markedEquity) : '데이터 없음'}</div><div class="pilot-momentum-shadow-return ${classForValue(book.markedReturnPercent)}">${book.available === true ? `${formatOptionalPercent(book.markedReturnPercent)} 평가수익률` : '관찰 시작 대기'}</div><div class="pilot-momentum-shadow-stats"><span>실현 손익 ${formatSignedWon(book.realizedProfit)}</span><span>청산 ${number(book.closedTradeCount)}회</span></div>${warning}<div class="pilot-momentum-shadow-positions"><span>보유 포지션</span><strong>${positions}</strong></div></article>`;
            }).join('')
            : '<div class="pilot-inline-empty">모의투자 기록이 아직 없습니다.</div>');
    }

    function renderAll() {
        renderMode(); renderGateCards(); renderChartPeriodButtons(); renderCoreStats(); renderPositionRows('pilot-overview-positions'); renderPositionRows('pilot-portfolio-positions'); renderActivity(); renderRiskSummary(); renderTradePanels(); drawEquityChart('pilot-equity-chart', 'pilot-equity-empty', state.portfolioHistory); renderPortfolio(); renderMarketHeader(); renderMarketList(); renderAnalysis(); renderNews(); renderValidationDetail(); renderPaperDetail(); renderStrategyResearch(); renderMomentumShadow(); syncObserverControls();
    }

    async function loadCore({ quiet = false } = {}) {
        if (state.refreshing) {
            refreshAfterCurrent = true;
            return;
        }
        if (state.online === false) {
            state.coreReady = false;
            renderAll();
            return;
        }
        const requestGeneration = networkGeneration;
        state.refreshing = true;
        state.coreReady = false;
        syncObserverControls();
        if (!quiet) setConnection(false, '연결 확인 중');
        const period = encodeURIComponent(state.chartPeriod || '24h');
        const requests = { status: '/status', account: '/account', pnl: '/cumulative-pnl', today: '/today-summary', statistics: '/statistics', validation: '/scalping-validation', strategyReadiness: '/strategy-readiness', paper: '/paper-validation', momentumShadow: '/momentum-shadow', portfolioAnalysis: '/portfolio-analysis', history: `/portfolio/history?period=${period}`, trades: '/trades?limit=12', marketPrices: '/market/prices', targetCoins: '/target-coins' };
        const settled = await Promise.all(Object.entries(requests).map(async ([key, path]) => { try { return [key, await requestJSON(path)]; } catch (error) { return [key, null, error]; } }));
        if (state.online === false || requestGeneration !== networkGeneration) {
            state.refreshing = false;
            renderAll();
            if (state.online !== false && refreshAfterCurrent) {
                refreshAfterCurrent = false;
                return loadCore({ quiet: true });
            }
            return;
        }
        const loaded = Object.fromEntries(settled.map(([key, data]) => [key, data !== null]));
        settled.forEach(([key, data]) => { if (key === 'strategyReadiness') { state.strategyReadiness = data; return; } if (data === null) return; if (key === 'history') state.portfolioHistory = Array.isArray(data?.data) ? data.data : []; else if (key === 'targetCoins') state.targetCoins = Array.isArray(data?.coins) ? data.coins : []; else state[key] = data; });
        if (state.status?.mode) state.actualMode = state.status.mode === 'LIVE' ? 'LIVE' : 'DRY_RUN';
        if (!state.marketPrices.some(item => item.coin === state.selectedCoin)) state.selectedCoin = state.marketPrices[0]?.coin || state.targetCoins[0] || state.selectedCoin;
        state.coreReady = isCoreTradingSnapshotReady({
            status: loaded.status ? state.status : null,
            account: loaded.account ? state.account : null,
            marketPrices: loaded.marketPrices ? state.marketPrices : null,
            selectedCoin: state.selectedCoin
        });
        state.activeMode = state.actualMode === 'LIVE' ? 'live' : 'paper'; state.liveEligible = state.coreReady && state.actualMode === 'LIVE' && state.validation?.promoted === true && state.strategyReadiness?.status === 'READY' && state.strategyReadiness?.currentEvidence === true && state.strategyReadiness?.liveGate?.passed === true;
        state.connected = Boolean(state.status || state.account || state.marketPrices?.length); state.lastSync = new Date(); state.refreshing = false; setConnection(state.connected, state.connected ? '' : '오류'); renderAll();
        if (refreshAfterCurrent) {
            refreshAfterCurrent = false;
            return loadCore({ quiet: true });
        }
        if (state.view === 'market' && state.selectedCoin) await loadCandles(true);
    }

    function clearDynamicStateForOffline() {
        for (const key of [
            'status', 'account', 'pnl', 'today', 'validation', 'strategyReadiness', 'paper',
            'strategyResearch', 'momentumShadow', 'portfolioAnalysis',
            'analysis', 'news', 'settings'
        ]) state[key] = null;
        state.statistics = [];
        state.portfolioHistory = [];
        state.trades = [];
        state.marketPrices = [];
        state.targetCoins = [];
        state.candles = [];
        state.candlesCoin = null;
        state.connected = false;
        state.lastSync = null;
        state.liveEligible = false;
        state.coreReady = false;
        state.activeMode = 'paper';
        state.actualMode = 'OFFLINE';
        state.settingsLoaded = false;
        state.historyLoaded = false;
        state.viewLoading.clear();
        state.ai.providers = null;
        state.ai.sessions = [];
        state.ai.events = [];
        state.ai.consultations = [];
        state.ai.effectiveness = null;
        state.ai.loading = false;
    }

    function enterOfflineMode() {
        if (state.online === false) return;
        state.online = false;
        networkGeneration += 1;
        clearDynamicStateForOffline();
        setConnection(false, '오프라인');
        renderAll();
    }

    function recoverOnline() {
        if (state.online !== false) return;
        state.online = true;
        setConnection(false, '연결 복구 중');
        renderAll();
        loadCore().catch(error => {
            setConnection(false, '오류');
            showToast(`연결 복구에 실패했습니다: ${error.message}`, 'warning');
        });
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
        try { state.analysis = await requestJSON('/all-coin-scores?limit=60'); renderAnalysis(); showToast(`전략 분석 결과 ${state.analysis?.totalAnalyzed || 0}개를 갱신했습니다.`, 'success'); } catch (error) { showToast(`분석을 불러오지 못했습니다: ${error.message}`, 'error'); } finally { state.viewLoading.delete('analysis'); if (button) { button.disabled = false; button.innerHTML = '<i class="ph ph-play" aria-hidden="true"></i> 분석 실행'; } }
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
            const [validation, strategyReadiness, paper, momentumShadow, optimizationHistory, backtestResults, strategyResearch] = await Promise.all([requestJSON('/scalping-validation'), requestJSON('/strategy-readiness').catch(() => null), requestJSON('/paper-validation'), requestJSON('/momentum-shadow'), requestJSON('/optimization-history'), requestJSON('/backtest/results'), requestJSON('/strategy-research')]);
            state.validation = validation; state.strategyReadiness = strategyReadiness; state.paper = paper; state.momentumShadow = momentumShadow; state.strategyResearch = strategyResearch; state.settings = state.settings || {}; state.settings.optimizationHistory = Array.isArray(optimizationHistory) ? optimizationHistory : optimizationHistory?.history || []; state.settings.backtestResults = Array.isArray(backtestResults) ? backtestResults : backtestResults?.results || []; state.historyLoaded = true; renderGateCards(); renderValidationDetail(); renderPaperDetail(); renderHistoryTables();
        } catch (error) { state.strategyReadiness = null; renderGateCards(); renderValidationDetail(); showToast(`점검 기록을 불러오지 못했습니다: ${error.message}`, 'error'); }
    }

    function showView(view) {
        if (!view) return; state.view = view; localStorage.setItem('currentPilotView', view); clearToasts(); window.scrollTo({ top: 0, behavior: 'auto' }); $$('[data-pilot-page]').forEach(page => page.classList.toggle('is-active', page.dataset.pilotPage === view)); syncViewNavigation(view);
        if (view === 'market') loadCandles(true); if (view === 'analysis' && !state.analysis) loadAnalysis(); if (view === 'news' && !state.news) loadNews(); if (view === 'settings') loadSettings(); if (view === 'history') { loadHistory(); loadSettings(); } renderAll();
    }

    async function executeTrade(prefix) {
        const trade = state.trade[prefix]; const select = root.querySelector(`[data-pilot-trade-coin="${prefix}"]`); const input = root.querySelector(`[data-pilot-trade-amount="${prefix}"]`); if (!trade || !select || !input) return;
        const coin = select.value; const amount = number(input.value); const market = currentMarket(coin) || {}; const holding = currentPosition(coin) || {};
        if (!canTrade()) { showToast(tradeBlockReason(), 'warning'); return; }
        if (!coin || amount <= 0) { showToast('자산과 주문 금액을 확인해주세요.', 'warning'); return; }
        if (trade.side === 'buy' && amount < 5000) { showToast('최소 매수 금액은 5,000원입니다.', 'warning'); return; }
        const quantity = market.price > 0 ? amount / market.price : amount / number(holding.currentPrice); const actionText = trade.side === 'buy' ? '매수' : '매도'; const detail = trade.side === 'buy' ? `${formatWon(amount)} 주문` : `${formatQuantity(quantity)}개 매도`;
        if (!window.confirm(`${symbolOf(coin)} ${actionText}를 실행할까요?\n${detail}\n현재 모드: ${state.activeMode === 'paper' ? '모의투자' : '실제투자'}`)) {
            showToast(`${symbolOf(coin)} ${actionText}를 취소했습니다`, 'info');
            return;
        }
        try { const path = trade.side === 'buy' ? '/trade/buy' : '/trade/sell'; const body = trade.side === 'buy' ? { coin, amount: Math.floor(amount) } : { coin, quantity }; const result = await requestJSON(path, { method: 'POST', body: JSON.stringify(body) }); showToast(result.message || `${symbolOf(coin)} ${actionText} 완료`, 'success'); await loadCore(); } catch (error) { showToast(`${actionText} 실패: ${error.message}`, 'error'); }
    }

    async function executeSmart(kind) {
        if (!canTrade()) { showToast(tradeBlockReason(), 'warning'); return; }
        const buy = kind === 'buy'; const amount = number(byId(buy ? 'pilot-smart-buy-amount' : 'pilot-smart-sell-amount')?.value); if (!amount || amount < (buy ? 5000 : 1000)) { showToast(`최소 ${formatWon(buy ? 5000 : 1000)} 이상 입력해주세요.`, 'warning'); return; }
        const description = buy ? `상위 마켓에 ${formatWon(amount)} 분산 매수` : `보유 자산에서 ${formatWon(amount)} 목표 매도`; if (!window.confirm(`${description}를 실행할까요?\n현재 모드: ${state.activeMode === 'paper' ? '모의투자' : '실제투자'}`)) return;
        try {
            const body = buy ? { totalAmount: Math.floor(amount), minScore: number(byId('pilot-smart-buy-score')?.value, 60), maxCoins: number(byId('pilot-smart-buy-max')?.value, 10) } : { targetAmount: Math.floor(amount), strategy: byId('pilot-smart-sell-strategy')?.value || 'worst' };
            const result = await requestJSON(buy ? '/trade/smart-buy' : '/trade/smart-sell', { method: 'POST', body: JSON.stringify(body) });
            const failureCount = Array.isArray(result.failures) ? result.failures.length : 0;
            const toastMessage = failureCount > 0
                ? `${result.message || '스마트 주문이 완료되었습니다.'} 실패 ${failureCount}건`
                : result.message || '스마트 주문이 완료되었습니다.';
            showToast(toastMessage, result.success === false ? 'warning' : 'success');
            await loadCore();
        } catch (error) { showToast(`스마트 주문 실패: ${error.message}`, 'error'); }
    }

    async function walletAction(kind) {
        if (isReadOnlyObserver()) { showToast(readOnlyObserverReason(), 'warning'); return; }
        if (!isPaperMode()) { showToast('실제투자 모드에서는 모의투자 지갑을 조작할 수 없습니다.', 'warning'); return; }
        const input = byId(kind === 'deposit' ? 'pilot-deposit-amount' : 'pilot-withdraw-amount'); const amount = number(input?.value); if (!amount || amount < 1000) { showToast('최소 1,000원 이상 입력해주세요.', 'warning'); return; }
        try { const result = await requestJSON(`/virtual/${kind}`, { method: 'POST', body: JSON.stringify({ amount: Math.floor(amount) }) }); showToast(result.message || '지갑을 업데이트했습니다.', 'success'); if (input) input.value = ''; await loadCore(); } catch (error) { showToast(`지갑 변경 실패: ${error.message}`, 'error'); }
    }

    async function resetWallet() {
        if (isReadOnlyObserver()) { showToast(readOnlyObserverReason(), 'warning'); return; }
        if (!isPaperMode()) { showToast('실제투자 모드에서는 지갑을 리셋할 수 없습니다.', 'warning'); return; }
        const seed = number(window.prompt('새 시드머니를 입력하세요 (원)', String(state.account?.initialSeedMoney || 10000000))); if (!seed || seed < 100000) return; if (!window.confirm(`모의 포트폴리오와 전략 포지션을 ${formatWon(seed)} 기준으로 초기화할까요?`)) return;
        try { const result = await requestJSON('/virtual/reset', { method: 'POST', body: JSON.stringify({ seedMoney: Math.floor(seed) }) }); showToast(result.message || '모의투자 지갑을 리셋했습니다.', 'success'); await loadCore(); } catch (error) { showToast(`리셋 실패: ${error.message}`, 'error'); }
    }

    async function startPaper(reset = false) {
        if (isReadOnlyObserver()) { showToast(readOnlyObserverReason(), 'warning'); return; }
        const message = reset ? '새 시드로 초기화 후 모의투자 관찰 세션을 시작할까요? 기존 모의 자산이 덮어써질 수 있습니다.' : '현재 상태 기준으로 모의투자 관찰 세션을 시작할까요?'; if (!window.confirm(message)) return;
        try { const result = await requestJSON('/paper-validation/start', { method: 'POST', body: JSON.stringify(reset ? { reset: true } : {}) }); state.paper = result.status; renderGateCards(); renderPaperDetail(); showToast('모의투자 관찰 세션을 시작했습니다.', 'success'); } catch (error) { showToast(`모의투자 세션 시작 실패: ${error.message}`, 'error'); }
    }

    async function stopPaper() {
        if (isReadOnlyObserver()) { showToast(readOnlyObserverReason(), 'warning'); return; }
        if (!window.confirm('현재 모의투자 관찰 세션을 중지할까요?')) return;
        try { const result = await requestJSON('/paper-validation/stop', { method: 'POST' }); state.paper = result.status; renderGateCards(); renderPaperDetail(); showToast('모의투자 관찰 세션을 중지했습니다.', 'success'); } catch (error) { showToast(`모의투자 세션 중지 실패: ${error.message}`, 'error'); }
    }

    function settingPayload() {
        const payload = {};
        $$('[data-pilot-setting-key]').forEach(input => { const key = input.dataset.pilotSettingKey; if (input.type === 'checkbox') payload[key] = input.checked; else { const raw = number(input.value); payload[key] = input.dataset.pilotSettingDisplay === 'percent' ? raw / 100 : raw; } });
        return payload;
    }

    async function saveSettings() {
        if (isReadOnlyObserver()) { showToast(readOnlyObserverReason(), 'warning'); return; }
        if (isPaperEvidenceMutationLocked()) { showToast(paperEvidenceMutationReason(), 'warning'); return; }
        const payload = settingPayload();
        try { const investmentRatio = payload.investmentRatio; delete payload.investmentRatio; await requestJSON('/config/update', { method: 'POST', body: JSON.stringify(payload) }); if (investmentRatio !== undefined) await requestJSON('/investment-config/update', { method: 'POST', body: JSON.stringify({ investmentRatio }) }); state.settingsLoaded = false; await loadSettings(); showToast('설정을 적용했습니다. 다음 점검에서 다시 확인하세요.', 'success'); } catch (error) { showToast(`설정 적용 실패: ${error.message}`, 'error'); }
    }

    async function applyPreset(presetId) {
        if (isReadOnlyObserver()) { showToast(readOnlyObserverReason(), 'warning'); return; }
        if (isPaperEvidenceMutationLocked()) { showToast(paperEvidenceMutationReason(), 'warning'); return; }
        const preset = state.settings?.presets?.find(item => item.id === presetId); if (!preset) return; if (!window.confirm(`${preset.name} 프리셋을 적용할까요? 현재 전략 파라미터가 변경됩니다.`)) return;
        try { await requestJSON('/investment-presets/apply', { method: 'POST', body: JSON.stringify({ presetId, config: preset.config }) }); state.settingsLoaded = false; await loadSettings(); showToast(`${preset.name} 프리셋을 적용했습니다.`, 'success'); } catch (error) { showToast(`프리셋 적용 실패: ${error.message}`, 'error'); }
    }

    async function runOptimization() {
        if (isReadOnlyObserver()) { showToast(readOnlyObserverReason(), 'warning'); return; }
        if (isPaperEvidenceMutationLocked()) { showToast(paperEvidenceMutationReason(), 'warning'); return; }
        if (!window.confirm('현재 설정으로 최적화 탐색을 시작할까요?')) return;
        try { const result = await requestJSON('/optimization/run-now', { method: 'POST' }); showToast(result.message || '최적화를 시작했습니다.', 'success'); } catch (error) { showToast(`최적화 실행 실패: ${error.message}`, 'error'); }
    }

    function openNews(index) {
        const filter = state.newsFilter || 'all'; const list = (state.news?.news || []).filter(news => filter === 'all' || sentimentInfo({ overall: news.sentiment, score: news.sentimentScore || news.score }).key === filter); const item = list[index]; if (!item) return;
        const info = sentimentInfo({ overall: item.sentiment, score: item.sentimentScore || item.score }); const link = item.link || item.url;
        showModal('뉴스 분석', `<div class="pilot-inline-note"><i class="ph ph-newspaper" aria-hidden="true"></i><span>${escapeHtml(item.source || '출처 미상')} · ${escapeHtml(formatDateTime(item.timestamp || item.pubDate || item.publishedAt))}</span></div><div style="margin-top:16px"><h3 style="margin:0;color:var(--sl-ink);font-size:18px;line-height:1.4">${escapeHtml(item.title || '제목 없음')}</h3><p style="margin:14px 0 0;color:var(--sl-ink-soft);line-height:1.7;font-size:13px">${escapeHtml(item.description || item.content || '요약 내용이 없습니다.')}</p></div><div class="pilot-inline-note" style="margin-top:16px"><i class="ph ph-info" aria-hidden="true"></i><span>감성: ${escapeHtml(info.label)} · 본 분석은 자동 분류 참고 정보이며 투자 결정을 대신하지 않습니다.</span></div>`, link ? `<a class="pilot-button is-primary" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">원문 보기 <i class="ph ph-arrow-square-out" aria-hidden="true"></i></a><button type="button" class="pilot-button" data-pilot-modal-close>닫기</button>` : '');
    }

    function setMode(mode) {
        if (mode === 'live') { if (state.actualMode !== 'LIVE') { showToast('현재 서버가 모의투자 모드라 실제투자로 전환할 수 없습니다.', 'warning'); return; } if (!state.liveEligible) { showToast('사전 점검이 모두 완료되기 전까지 실제투자는 잠겨 있습니다.', 'warning'); showView('history'); return; } }
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

    // Market rows are clickable divs; expose them to keyboard users by
    // forwarding Enter/Space to the existing delegated click handler.
    root.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const marketRow = event.target.closest?.('[data-pilot-market-row]');
        if (!marketRow) return;
        event.preventDefault();
        marketRow.click();
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
            liveSocket.on('new-signal', () => { showToast('새로운 신호가 도착했습니다. 전략 분석에서 확인하세요.', 'info'); if (state.view === 'analysis') loadAnalysis(); });
            liveSocket.on('breaking-news', news => { showToast(`속보: ${news?.title || '새로운 뉴스'}`, 'warning'); if (state.view === 'news') loadNews(); });
        } catch (error) { console.warn('Signal Ledger socket init failed:', error.message); }
    }

    window.addEventListener('resize', () => { drawEquityChart('pilot-equity-chart', 'pilot-equity-empty', state.portfolioHistory); drawEquityChart('pilot-portfolio-chart', 'pilot-portfolio-empty', state.portfolioHistory); drawAllocationChart(); drawMarketChart(); });
    window.setInterval(updateClock, 1000);
    window.setInterval(() => { if (!document.hidden) loadCore({ quiet: true }); }, 10000);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) loadCore({ quiet: true }).catch(() => {});
    });
    window.addEventListener('offline', enterOfflineMode);
    window.addEventListener('online', recoverOnline);

    updateClock();
    const savedView = localStorage.getItem('currentPilotView');
    if (savedView && root.querySelector(`[data-pilot-page="${savedView}"]`)) showView(savedView);
    loadCore().catch(error => { setConnection(false, '오류'); showToast(`초기 데이터를 불러오지 못했습니다: ${error.message}`, 'error'); });

})();
