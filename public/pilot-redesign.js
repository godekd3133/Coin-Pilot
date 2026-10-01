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
    if (!root) {
        document.body?.classList.remove('pilot-redesign-shell');
        return;
    }

    const MOBILE_CORE_VIEWS = new Set(['overview', 'trade', 'portfolio', 'market']);
    const CORE_REFRESH_INTERVAL_MS = 30_000;
    const READ_ONLY_PWA_GET_PATHS = new Set([
        '/status', '/account', '/cumulative-pnl', '/today-summary', '/market/prices/snapshot'
    ]);
    const READ_ONLY_PWA_PORTFOLIO_PERIODS = new Set(['24h', '7d', '30d']);
    const PWA_MUTATION_CONTROL_SELECTOR = [
        '[data-pilot-action="retry-pending-mutation"]',
        '[data-pilot-action="start-paper"]', '[data-pilot-action="start-paper-reset"]', '[data-pilot-action="stop-paper"]',
        '[data-pilot-action="smart-buy"]', '[data-pilot-action="smart-sell"]',
        '[data-pilot-action="deposit"]', '[data-pilot-action="withdraw"]', '[data-pilot-action="reset-wallet"]',
        '[data-pilot-action="record-snapshot"]', '[data-pilot-action="save-settings"]', '[data-pilot-action="run-optimization"]',
        '[data-pilot-trade-submit]', '[data-pilot-trade-side]', '[data-pilot-trade-coin]', '[data-pilot-trade-amount]',
        '[data-pilot-trade-preset]', '[data-pilot-preset-id]', '[data-pilot-setting-key]',
        '#pilot-deposit-amount', '#pilot-withdraw-amount',
        '#pilot-smart-buy-amount', '#pilot-smart-buy-score', '#pilot-smart-buy-max',
        '#pilot-smart-sell-amount', '#pilot-smart-sell-strategy',
        '#pilot-auto-optimization', '#pilot-optimization-interval',
        '#pilot-ai-session-form input', '#pilot-ai-session-form button[type="submit"]',
        '[data-pilot-ai-session-action]', '[data-pilot-ai-consult-event]'
    ].join(',');
    const PWA_SCOPE_ONLY_CONTROL_SELECTOR = [
        '[data-pilot-trade-side]', '[data-pilot-trade-coin]', '[data-pilot-trade-amount]', '[data-pilot-trade-preset]',
        '#pilot-deposit-amount', '#pilot-withdraw-amount',
        '#pilot-smart-buy-amount', '#pilot-smart-buy-score', '#pilot-smart-buy-max',
        '#pilot-smart-sell-amount', '#pilot-smart-sell-strategy',
        '#pilot-ai-session-form input', '#pilot-ai-session-form button[type="submit"]',
        '[data-pilot-ai-session-action]', '[data-pilot-ai-consult-event]'
    ].join(',');
    const authClient = window.coinPilotAuth || null;

    const state = {
        auth: authClient?.state ? { ...authClient.state } : {
            authRequired: false,
            tokenScope: 'operator',
            authenticated: true,
            resolved: true,
            verification: 'not-required',
            tokenPresent: false,
            error: null
        },
        view: 'overview',
        activeMode: 'paper',
        actualMode: 'UNKNOWN',
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
        statisticsLoaded: false,
        validation: null,
        strategyReadiness: null,
        paper: null,
        strategyResearch: null,
        strategyResearchLoaded: false,
        strategyResearchLoading: false,
        strategyResearchError: null,
        strategyResearchRequest: null,
        momentumShadow: null,
        portfolioAnalysis: null,
        portfolioHistory: [],
        portfolioHistoryError: null,
        snapshotSaving: false,
        pendingMutation: { intent: null, sending: false, storageError: null, locked: false },
        trades: [],
        tradesLoaded: false,
        marketPrices: [],
        marketPricesLoaded: false,
        marketSnapshot: null,
        targetCoins: [],
        selectedCoin: localStorage.getItem('selectedCoin') || 'KRW-BTC',
        candles: [],
        candlesError: false,
        candlesLoading: false,
        candlesRequestSequence: 0,
        candleInterval: 5,
        candleDisplayRange: 60,
        chartPeriod: '24h',
        analysis: null,
        analysisError: null,
        analysisFilter: 'all',
        analysisSort: 'score',
        news: null,
        newsError: false,
        newsLoading: false,
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
    let modalReturnFocus = null;
    let modalReturnFocusKey = null;
    let modalReturnFocusIndex = null;

    const PENDING_MUTATION_STORAGE_KEY = 'coinpilot.pending-mutation.v1';
    const PENDING_MUTATION_LOCK_NAME = 'coinpilot.pending-mutation.v1';
    const PENDING_MUTATION_ENDPOINTS = new Set([
        '/trade/execute-bundle',
        '/trade/execute',
        '/trade/buy',
        '/trade/sell',
        '/trade/smart-buy',
        '/trade/smart-sell',
        '/virtual/deposit',
        '/virtual/withdraw',
        '/virtual/reset'
    ]);

    function createPendingMutationClient({ storage, createKey, sendRequest, onChange = () => {}, locks = null } = {}) {
        let isSending = false;
        let storageError = null;
        let volatileIntent = null;

        function readStoredIntent() {
            if (!storage || typeof storage.getItem !== 'function') {
                return { intent: volatileIntent, error: 'unavailable' };
            }
            try {
                const raw = storage.getItem(PENDING_MUTATION_STORAGE_KEY);
                if (raw === null || raw === undefined) {
                    if (!storageError) volatileIntent = null;
                    return { intent: null, error: storageError };
                }
                const intent = JSON.parse(raw);
                const valid = intent?.version === 1
                    && typeof intent.idempotencyKey === 'string'
                    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(intent.idempotencyKey)
                    && PENDING_MUTATION_ENDPOINTS.has(intent.endpoint)
                    && typeof intent.body === 'string';
                if (!valid) return { intent: volatileIntent, error: 'invalid' };
                volatileIntent = intent;
                return { intent, error: storageError };
            } catch {
                return { intent: volatileIntent, error: 'unavailable' };
            }
        }

        function snapshot() {
            const { intent, error } = readStoredIntent();
            return {
                intent: intent ? { ...intent } : null,
                sending: isSending,
                storageError: error,
                locked: isSending || Boolean(intent) || Boolean(error)
            };
        }

        function publish() {
            onChange(snapshot());
        }

        function writeIntent(intent) {
            if (!storage || typeof storage.setItem !== 'function') {
                storageError = 'unavailable';
                return false;
            }
            try {
                storage.setItem(PENDING_MUTATION_STORAGE_KEY, JSON.stringify(intent));
                volatileIntent = intent;
                storageError = null;
                return true;
            } catch {
                storageError = 'write_failed';
                return false;
            }
        }

        function clearIntent() {
            if (!storage || typeof storage.removeItem !== 'function') {
                storageError = 'clear_failed';
                return false;
            }
            try {
                storage.removeItem(PENDING_MUTATION_STORAGE_KEY);
                volatileIntent = null;
                storageError = null;
                return true;
            } catch {
                storageError = 'clear_failed';
                return false;
            }
        }

        async function withMutationLock(callback) {
            if (locks && typeof locks.request === 'function') {
                return locks.request(PENDING_MUTATION_LOCK_NAME, { mode: 'exclusive' }, callback);
            }
            return callback();
        }

        function blockedResult(intent, message = '먼저 저장된 요청의 결과를 확인해 주세요.') {
            return { kind: 'blocked', intent: intent || null, message };
        }

        async function transmit(intent) {
            const sendingIntent = { ...intent, phase: 'sending', lastOutcome: 'sending' };
            writeIntent(sendingIntent);
            publish();

            let response;
            try {
                response = await sendRequest({
                    endpoint: intent.endpoint,
                    idempotencyKey: intent.idempotencyKey,
                    body: intent.body
                });
            } catch (error) {
                const pendingIntent = {
                    ...intent,
                    phase: 'pending',
                    lastOutcome: 'unknown',
                    lastStatus: null,
                    lastMessage: error?.name === 'AbortError'
                        ? '서버 응답이 늦어 요청 결과를 확인할 수 없습니다.'
                        : '연결이 끊겨 요청 결과를 확인할 수 없습니다.'
                };
                writeIntent(pendingIntent);
                publish();
                return { kind: 'pending', intent: pendingIntent, message: pendingIntent.lastMessage };
            }

            const status = Number(response?.status);
            const body = response?.body;
            const parsed = response?.parsed === true && body !== null && typeof body === 'object';
            const idempotencyStatus = String(response?.idempotencyStatus || '').trim().toLowerCase();
            const errorCode = typeof body?.error?.code === 'string' ? body.error.code : '';
            let outcome;
            let message;

            if (!Number.isInteger(status) || !parsed) {
                outcome = 'unknown';
                message = '서버 응답을 확인할 수 없어 요청 결과를 보류했습니다.';
            } else if (idempotencyStatus === 'conflict' || errorCode === 'idempotency_key_conflict' || (status === 409 && idempotencyStatus !== 'completed')) {
                outcome = 'conflict';
                message = '서버 기록과 저장된 요청이 일치하지 않습니다. 새 변경을 잠갔습니다.';
            } else if (status === 428 || errorCode === 'idempotency_key_required') {
                outcome = 'key_missing';
                message = '서버가 요청 키를 확인하지 못했습니다. 새 변경을 잠갔습니다.';
            } else if (idempotencyStatus === 'unknown' || (status >= 500 && idempotencyStatus !== 'completed')) {
                outcome = 'unknown';
                message = '서버가 요청 결과를 확인하지 못해 변경을 잠갔습니다.';
            } else if (status === 202 || body.pending === true || idempotencyStatus === 'pending') {
                outcome = 'processing';
                message = '서버가 요청을 처리 중입니다. 같은 요청을 다시 보내 확인할 수 있습니다.';
            } else if (status >= 200 && status < 300) {
                if (!clearIntent()) {
                    publish();
                    return {
                        kind: 'terminal-locked',
                        status,
                        body,
                        intent: snapshot().intent || sendingIntent,
                        message: '요청은 처리됐지만 안전 기록을 정리하지 못했습니다. 같은 요청으로 결과를 다시 확인하세요.'
                    };
                }
                publish();
                return { kind: 'terminal', status, body, intent };
            } else if (status >= 400 && status < 500) {
                if (!clearIntent()) {
                    publish();
                    return {
                        kind: 'terminal-locked',
                        status,
                        body,
                        intent: snapshot().intent || sendingIntent,
                        message: '서버가 요청을 거절했지만 안전 기록을 정리하지 못했습니다.'
                    };
                }
                publish();
                return { kind: 'rejected', status, body, intent };
            } else if (status >= 500 && idempotencyStatus === 'completed') {
                if (!clearIntent()) {
                    publish();
                    return {
                        kind: 'terminal-locked',
                        status,
                        body,
                        intent: snapshot().intent || sendingIntent,
                        message: '요청 결과는 기록됐지만 안전 기록을 정리하지 못했습니다.'
                    };
                }
                publish();
                return { kind: 'rejected', status, body, intent };
            } else {
                outcome = 'unknown';
                message = '예상하지 못한 서버 응답이라 요청 결과를 보류했습니다.';
            }

            const pendingIntent = {
                ...intent,
                phase: 'pending',
                lastOutcome: outcome,
                lastStatus: Number.isInteger(status) ? status : null,
                lastMessage: message
            };
            writeIntent(pendingIntent);
            publish();
            return { kind: 'pending', status: Number.isInteger(status) ? status : null, body: parsed ? body : null, intent: pendingIntent, message };
        }

        async function submit(endpoint, bodyValue) {
            if (isSending) return blockedResult(snapshot().intent, '다른 요청을 처리 중입니다.');
            isSending = true;
            publish();
            try {
                return await withMutationLock(async () => {
                    const current = snapshot();
                    if (current.storageError) return { kind: 'storage-error', message: '요청을 안전하게 저장할 수 없어 전송하지 않았습니다.' };
                    if (current.intent) return blockedResult(current.intent);
                    if (!PENDING_MUTATION_ENDPOINTS.has(endpoint)) {
                        return { kind: 'invalid', message: '보호되지 않은 변경 경로입니다.' };
                    }

                    let body;
                    try {
                        body = typeof bodyValue === 'string' ? bodyValue : JSON.stringify(bodyValue);
                    } catch {
                        return { kind: 'invalid', message: '요청 내용을 직렬화하지 못했습니다.' };
                    }
                    if (typeof body !== 'string') return { kind: 'invalid', message: '요청 내용이 비어 있습니다.' };

                    let idempotencyKey;
                    try {
                        idempotencyKey = createKey();
                    } catch {
                        return { kind: 'storage-error', message: '안전한 요청 키를 만들 수 없어 전송하지 않았습니다.' };
                    }
                    if (typeof idempotencyKey !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
                        return { kind: 'storage-error', message: '유효한 요청 키를 만들지 못해 전송하지 않았습니다.' };
                    }
                    const intent = {
                        version: 1,
                        idempotencyKey,
                        endpoint,
                        body,
                        phase: 'pending',
                        lastOutcome: 'new',
                        lastStatus: null,
                        lastMessage: null,
                        createdAt: Date.now()
                    };
                    if (!writeIntent(intent)) {
                        publish();
                        return { kind: 'storage-error', message: '요청 기록을 저장하지 못해 전송하지 않았습니다.' };
                    }
                    publish();
                    return transmit(intent);
                });
            } catch {
                return { kind: 'storage-error', message: '요청 잠금을 확인하지 못해 변경 요청을 보내지 않았습니다.' };
            } finally {
                isSending = false;
                publish();
            }
        }

        async function retry() {
            if (isSending) return blockedResult(snapshot().intent, '같은 요청을 확인 중입니다.');
            isSending = true;
            publish();
            try {
                return await withMutationLock(async () => {
                    const current = snapshot();
                    if (current.storageError && !current.intent) {
                        return { kind: 'storage-error', message: '저장된 요청 기록을 읽을 수 없어 재확인하지 못했습니다.' };
                    }
                    if (!current.intent) return { kind: 'empty', message: '확인할 요청이 없습니다.' };
                    if (['conflict', 'key_missing'].includes(current.intent.lastOutcome)) {
                        return { kind: 'resolution-required', intent: current.intent, message: current.intent.lastMessage };
                    }
                    return transmit(current.intent);
                });
            } catch {
                return { kind: 'pending', intent: snapshot().intent, message: '요청 잠금을 확인하지 못했습니다. 저장된 같은 요청은 보존했습니다.' };
            } finally {
                isSending = false;
                publish();
            }
        }

        function refresh() {
            publish();
            return snapshot();
        }

        return { submit, retry, snapshot, refresh, storageKey: PENDING_MUTATION_STORAGE_KEY };
    }

    function createManualMutationKey() {
        const cryptoApi = window.crypto;
        if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
        if (typeof cryptoApi?.getRandomValues !== 'function') throw new Error('Secure random UUID unavailable');
        const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    async function sendManualMutationRequest({ endpoint, idempotencyKey, body }) {
        const apiPath = endpoint.startsWith('/api/') ? endpoint.slice(4) : endpoint;
        if (!pwaAuthRequestPolicy(state.auth, 'POST', apiPath)) {
            return {
                status: 403,
                body: { success: false, error: readOnlyObserverReason() },
                parsed: true,
                idempotencyStatus: null
            };
        }
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), 12_000);
        try {
            const response = await fetch(`/api${endpoint}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Idempotency-Key': idempotencyKey
                },
                body,
                signal: controller.signal
            });
            try {
                return {
                    status: response.status,
                    body: await response.json(),
                    parsed: true,
                    idempotencyStatus: response.headers?.get?.('Idempotency-Status') || null
                };
            } catch {
                return {
                    status: response.status,
                    body: null,
                    parsed: false,
                    idempotencyStatus: response.headers?.get?.('Idempotency-Status') || null
                };
            }
        } finally {
            window.clearTimeout(timeoutId);
        }
    }

    function getLocalStorageSafely() {
        try {
            return window.localStorage;
        } catch {
            return null;
        }
    }

    const manualMutationClient = createPendingMutationClient({
        storage: getLocalStorageSafely(),
        createKey: createManualMutationKey,
        sendRequest: sendManualMutationRequest,
        locks: window.navigator?.locks || null,
        onChange: snapshot => {
            state.pendingMutation = snapshot;
            renderPendingMutationBanner(snapshot);
            syncObserverControls();
        }
    });
    state.pendingMutation = manualMutationClient.snapshot();
    window.CoinPilotMutationClient = manualMutationClient;

    function manualMutationActionName(intent) {
        return intent?.endpoint?.startsWith('/virtual/') ? '가상 지갑 변경' : '주문';
    }

    function renderPendingMutationBanner(snapshot = state.pendingMutation) {
        const banner = byId('pilot-pending-mutation');
        const title = byId('pilot-pending-mutation-title');
        const copy = byId('pilot-pending-mutation-copy');
        const retryButton = byId('pilot-pending-mutation-retry');
        if (!banner || !snapshot) return;
        const intent = snapshot.intent;
        const visible = Boolean(snapshot.locked || snapshot.storageError);
        banner.hidden = !visible;
        if (!visible) return;

        let titleText = '요청 결과 확인 필요';
        let copyText = '요청이 처리됐을 수 있어 새 주문과 가상 지갑 변경을 잠갔습니다.';
        if (snapshot.storageError === 'invalid') {
            titleText = '저장된 요청 기록을 읽을 수 없습니다';
            copyText = '요청 기록을 확인할 수 없어 새 주문과 가상 지갑 변경을 차단했습니다. 앱 데이터를 지우지 말고 기존 요청 결과를 확인해 주세요.';
        } else if (snapshot.storageError === 'unavailable' && !intent) {
            titleText = '요청 기록 저장소를 사용할 수 없습니다';
            copyText = '안전 기록을 읽거나 저장하지 못해 변경 요청을 보내지 않았습니다. 브라우저 저장 공간을 확인해 주세요.';
        } else if (snapshot.storageError === 'write_failed' && !intent) {
            titleText = '요청을 저장하지 못했습니다';
            copyText = '안전 기록을 저장하지 못해 요청을 전송하지 않았습니다. 브라우저 저장 공간을 확인한 뒤 다시 시도해 주세요.';
        } else if (snapshot.sending) {
            titleText = `${manualMutationActionName(intent)} 전송 중`;
            copyText = '서버 응답을 기다리는 동안 다른 주문과 가상 지갑 변경을 잠갔습니다.';
        } else if (intent?.lastOutcome === 'processing') {
            titleText = `${manualMutationActionName(intent)} 처리 중`;
            copyText = '서버가 요청을 처리 중입니다. 새 변경은 잠겨 있습니다. 아래 버튼은 저장된 같은 키와 내용으로 결과를 다시 확인합니다.';
        } else if (intent?.lastOutcome === 'conflict') {
            titleText = '서버 기록과 저장된 요청이 다릅니다';
            copyText = '서버가 다른 요청 내용으로 이 키를 사용 중이라고 답했습니다. 새 주문과 지갑 변경은 잠겨 있습니다. 운영자 확인이 필요합니다.';
        } else if (intent?.lastOutcome === 'key_missing') {
            titleText = '서버에서 요청 키를 확인하지 못했습니다';
            copyText = '키가 누락된 요청으로 거절되었습니다. 서버 설정을 확인할 때까지 새 주문과 지갑 변경을 잠갔습니다.';
        } else if (snapshot.storageError === 'clear_failed') {
            titleText = `${manualMutationActionName(intent)} 결과는 받았지만 요청 잠금을 해제하지 못했습니다`;
            copyText = '같은 요청을 다시 확인하면 서버의 저장된 결과를 재생하고 잠금을 정리할 수 있습니다.';
        } else if (intent?.lastOutcome === 'unknown') {
            titleText = `${manualMutationActionName(intent)} 결과 확인 필요`;
            copyText = '요청이 처리됐을 수 있습니다. 새 주문과 지갑 변경은 잠겨 있으며 아래 작업은 같은 키와 내용으로만 재전송합니다.';
        }
        if (title) title.textContent = titleText;
        if (copy) copy.textContent = copyText;
        if (retryButton) {
            const operatorResolutionRequired = ['conflict', 'key_missing'].includes(intent?.lastOutcome);
            retryButton.hidden = !intent || operatorResolutionRequired;
            retryButton.disabled = !intent || snapshot.sending || state.online === false;
            retryButton.textContent = snapshot.sending
                ? '요청 중…'
                : state.online === false ? '연결 후 다시 확인' : '같은 요청 결과 다시 확인';
        }
    }

    function number(value, fallback = 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function getDisplayedCandles(candles, displayRange) {
        const range = [30, 60, 100].includes(Number(displayRange)) ? Number(displayRange) : 60;
        if (!Array.isArray(candles)) return [];
        const validCandles = candles.filter(candle => {
            if (!candle || typeof candle !== 'object') return false;
            const open = Number(candle.open);
            const high = Number(candle.high);
            const low = Number(candle.low);
            const close = Number(candle.close);
            return [open, high, low, close].every(value => Number.isFinite(value) && value > 0)
                && high >= low
                && high >= Math.max(open, close)
                && low <= Math.min(open, close);
        });
        return validCandles.slice(-range);
    }

    function hasFiniteValue(value) {
        return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
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
        if (!hasFiniteValue(value)) return '—';
        return `${Math.round(Number(value)).toLocaleString('ko-KR')}${suffix}`;
    }

    function formatPrice(value) {
        if (!hasFiniteValue(value)) return '—';
        const parsed = Number(value);
        if (parsed === 0) return '0';
        const digits = parsed < 1 ? 8 : parsed < 100 ? 4 : 0;
        return parsed.toLocaleString('ko-KR', { maximumFractionDigits: digits });
    }

    function formatQuantity(value) {
        if (!hasFiniteValue(value)) return '—';
        return Number(value).toLocaleString('ko-KR', { maximumFractionDigits: 8 });
    }

    function formatPercent(value, decimals = 2) {
        if (!hasFiniteValue(value)) return '—';
        const parsed = Number(value);
        return `${parsed >= 0 ? '+' : ''}${parsed.toFixed(decimals)}%`;
    }

    function formatOptionalPercent(value, decimals = 2) {
        if (value === null || value === undefined || value === '') return '—';
        return Number.isFinite(Number(value)) ? formatPercent(value, decimals) : '—';
    }

    function formatSignedWon(value) {
        if (!hasFiniteValue(value)) return '—';
        const parsed = Number(value);
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

    function hasUsableHistoryTrend(points) {
        if (!Array.isArray(points) || points.length < 2) return false;
        const timestamps = new Set();
        for (const point of points) {
            const timestamp = Date.parse(point?.timestamp ?? point?.capturedAt ?? '');
            if (Number.isFinite(timestamp)) timestamps.add(timestamp);
            if (timestamps.size >= 2) return true;
        }
        return false;
    }

    function formatMarketTimestamp(value) {
        if (value === null || value === undefined || value === '' ||
            (typeof value === 'string' && value.trim() === '')) {
            return '시각 정보 미제공';
        }
        if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) {
            return '시각 형식 오류';
        }
        const date = value instanceof Date ? value : new Date(value);
        if (!Number.isFinite(date.getTime())) return '시각 형식 오류';
        return date.toLocaleString('ko-KR', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });
    }

    function normalizeMarketPriceSnapshot(snapshot) {
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || !Array.isArray(snapshot.prices)) {
            return null;
        }
        return {
            prices: snapshot.prices,
            complete: typeof snapshot.complete === 'boolean' ? snapshot.complete : null,
            missingMarkets: Array.isArray(snapshot.missingMarkets) ? snapshot.missingMarkets : [],
            unavailableMarkets: Array.isArray(snapshot.unavailableMarkets) ? snapshot.unavailableMarkets : [],
            sourceAsOf: snapshot.sourceAsOf ?? null,
            fetchedAt: snapshot.fetchedAt ?? null,
            snapshotSource: snapshot.snapshotSource ?? null,
            fallbackReason: snapshot.fallbackReason ?? null,
            marketListStale: typeof snapshot.marketListStale === 'boolean' ? snapshot.marketListStale : null,
            marketListFetchedAt: snapshot.marketListFetchedAt ?? null,
            legacyFallback: snapshot.legacyFallback === true
        };
    }

    function oldestLegacyRowTimestamp(prices, field) {
        if (!Array.isArray(prices) || prices.length === 0) return null;
        const timestamps = prices.map(row => {
            const value = row?.[field];
            if (typeof value !== 'string' || !value.trim()) return null;
            const milliseconds = Date.parse(value);
            return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : null;
        });
        if (timestamps.some(value => value === null)) return null;
        return new Date(Math.min(...timestamps)).toISOString();
    }

    function buildLegacyMarketPriceSnapshot(legacyPrices, targetCoins) {
        const prices = Array.isArray(legacyPrices) ? legacyPrices : [];
        const listCoins = targetCoins?.coins;
        const listFetchedAt = typeof targetCoins?.fetchedAt === 'string' ? targetCoins.fetchedAt : null;
        const validMarketList = Array.isArray(listCoins) && listCoins.length > 0 &&
            targetCoins?.count === listCoins.length && typeof targetCoins?.stale === 'boolean' &&
            listCoins.every(coin => typeof coin === 'string' && /^[A-Z0-9]+-[A-Z0-9]+$/.test(coin)) &&
            new Set(listCoins).size === listCoins.length && Boolean(listFetchedAt) && Number.isFinite(Date.parse(listFetchedAt));
        const requestedMarkets = validMarketList ? listCoins : [];
        const returnedMarkets = [...new Set(prices
            .map(row => row?.coin)
            .filter(coin => typeof coin === 'string' && /^[A-Z0-9]+-[A-Z0-9]+$/.test(coin)))];
        const returnedSet = new Set(returnedMarkets);
        const missingMarkets = validMarketList
            ? requestedMarkets.filter(coin => !returnedSet.has(coin))
            : [];
        const rowsVerified = prices.every(row => typeof row?.coin === 'string' &&
            /^[A-Z0-9]+-[A-Z0-9]+$/.test(row.coin)) && returnedMarkets.length === prices.length;

        return {
            requestedMarkets,
            returnedMarkets,
            missingMarkets,
            unavailableMarkets: missingMarkets,
            complete: validMarketList ? rowsVerified && missingMarkets.length === 0 : null,
            sourceAsOf: oldestLegacyRowTimestamp(prices, 'sourceAsOf'),
            fetchedAt: oldestLegacyRowTimestamp(prices, 'fetchedAt'),
            marketListStale: validMarketList ? targetCoins.stale : null,
            marketListFetchedAt: validMarketList ? listFetchedAt : null,
            prices,
            legacyFallback: true
        };
    }

    async function loadLegacyMarketSnapshotOn404(error, targetCoins, readJSON) {
        if (error?.status !== 404) throw error;
        const legacyPrices = await readJSON('/market/prices');
        return buildLegacyMarketPriceSnapshot(legacyPrices, targetCoins);
    }

    function marketQuoteFreshnessIssue(market, now = Date.now()) {
        if (!market) return '이 종목의 시세를 확인할 수 없어요.';
        const marketPrice = Number(market.price);
        if (!Number.isFinite(marketPrice) || marketPrice <= 0) return '현재가를 확인할 수 없어 주문할 수 없어요.';
        const configuredMaximumAge = Number(state.status?.maxCandleAgeSeconds);
        const maximumAgeMs = (Number.isFinite(configuredMaximumAge) && configuredMaximumAge > 0
            ? configuredMaximumAge
            : 90) * 1000;
        const sourceTimestamp = Date.parse(market.sourceAsOf || '');
        if (!Number.isFinite(sourceTimestamp)) return '최근 체결 시각을 확인할 수 없어 주문할 수 없어요.';
        if (market.quoteFresh === false && (
            state.marketSnapshot?.snapshotSource === 'last_good' ||
            market.quoteFreshnessReason === 'market_snapshot_last_good'
        )) {
            return '저장된 최근 시세를 표시 중이에요. 새 시세를 확인한 뒤 주문해 주세요.';
        }
        const sourceAgeMs = now - sourceTimestamp;
        if (sourceAgeMs < -5000) return '최근 체결 시각이 현재보다 앞서 있어요. 서버 시각을 확인해 주세요.';
        if (sourceAgeMs > maximumAgeMs) return '최근 체결 시각이 오래됐어요. 새로고침 후 다시 시도해 주세요.';
        if (market.quoteFresh === false) return '현재 시세 최신 여부를 확인할 수 없어요.';
        return null;
    }

    function marketSnapshotPresentation(snapshot, loaded, prices) {
        const rows = Array.isArray(prices) ? prices : [];
        const hasPrices = rows.length > 0;
        const missingCount = Math.max(
            Array.isArray(snapshot?.missingMarkets) ? snapshot.missingMarkets.length : 0,
            Array.isArray(snapshot?.unavailableMarkets) ? snapshot.unavailableMarkets.length : 0
        );
        const usingLastGood = snapshot?.snapshotSource === 'last_good' ||
            rows.some(row => row?.quoteFreshnessReason === 'market_snapshot_last_good');
        const marketListStatus = !loaded
            ? '시장 목록을 확인할 수 없어요'
            : snapshot?.marketListStale === true
                ? '시장 목록을 새로 확인해야 해요'
                : snapshot?.marketListStale === false
                    ? '시장 목록을 확인했어요'
                    : '시장 목록을 확인할 수 없어요';
        const marketListTime = formatMarketTimestamp(snapshot?.marketListFetchedAt);
        const listDetail = `${marketListStatus} · ${loaded ? '목록 확인' : '마지막 목록 확인'} ${marketListTime}`;
        let stateLabel;
        let tone;

        if (!loaded) {
            stateLabel = hasPrices ? '시세를 새로 불러오지 못해 이전 가격을 표시합니다' : '시세를 불러오지 못했습니다';
            tone = 'unavailable';
        } else if (!hasPrices) {
            stateLabel = '표시할 시세가 없습니다';
            tone = 'unavailable';
        } else if (usingLastGood) {
            stateLabel = missingCount > 0
                ? `거래소 응답이 없어 저장된 최근 시세를 표시합니다 · ${missingCount}개 시장 누락`
                : '거래소 응답이 없어 저장된 최근 시세를 표시합니다';
            tone = 'stale';
        } else if (snapshot?.complete === false || missingCount > 0) {
            stateLabel = missingCount > 0
                ? `${missingCount}개 시장 시세를 확인할 수 없습니다`
                : '일부 시장 시세를 확인할 수 없습니다';
            tone = 'partial';
        } else if (snapshot?.complete === true && rows.some(row => marketQuoteFreshnessIssue(row))) {
            const staleCount = rows.filter(row => marketQuoteFreshnessIssue(row)).length;
            stateLabel = `${staleCount}개 시장의 시세가 오래됐어요`;
            tone = 'stale';
        } else if (snapshot?.complete === true) {
            stateLabel = '모든 시장의 시세를 확인했어요';
            tone = 'complete';
        } else {
            stateLabel = '시세 상태를 확인할 수 없습니다';
            tone = 'unavailable';
        }

        const marketState = tone === 'complete' && (snapshot?.legacyFallback === true || snapshot?.marketListStale !== false) ? 'stale' : tone;
        const visualTone = marketState === 'stale' || snapshot?.legacyFallback === true ? 'warning' : tone;
        const freshnessNote = snapshot?.legacyFallback === true ? '시세의 최신 여부는 확인할 수 없습니다' : null;
        const detailLabel = [stateLabel, freshnessNote].filter(Boolean).join(' · ');

        return {
            state: marketState,
            label: stateLabel,
            tone: visualTone,
            detail: `${detailLabel} · ${marketListStatus}`,
            pageDetail: `${detailLabel} · ${listDetail}`
        };
    }

    function selectedMarketQuotePresentation(
        marketData,
        snapshotPresentation,
        latestReadSucceeded = true,
        now = Date.now()
    ) {
        if (!marketData) {
            return {
                label: snapshotPresentation.label,
                state: snapshotPresentation.state
            };
        }
        if (latestReadSucceeded !== true) {
            const fetchedAt = formatMarketTimestamp(marketData.fetchedAt ?? marketData.sourceAsOf);
            return {
                label: `새로고침 실패 · 마지막 수집 ${fetchedAt}`,
                state: 'stale'
            };
        }
        const quoteIssue = marketQuoteFreshnessIssue(marketData, now);
        if (quoteIssue) {
            return {
                label: quoteIssue,
                state: quoteIssue.includes('오래') ? 'stale' : 'unavailable'
            };
        }
        return { label: '현재 시세', state: 'complete' };
    }

    function marketRowQuotePresentation(marketData, latestReadSucceeded, now = Date.now()) {
        const fetchedAt = formatMarketTimestamp(marketData?.fetchedAt ?? marketData?.sourceAsOf);
        if (latestReadSucceeded !== true) {
            return { label: `갱신 실패 · 마지막 수집 ${fetchedAt}`, state: 'stale' };
        }
        const quoteIssue = marketQuoteFreshnessIssue(marketData, now);
        if (!quoteIssue) {
            return { label: `최근 시세 · 수집 ${fetchedAt}`, state: 'current' };
        }
        if (quoteIssue.includes('저장된 최근 시세')) {
            return { label: `저장 시세 · 수집 ${fetchedAt}`, state: 'stale' };
        }
        if (quoteIssue.includes('오래됐')) {
            return { label: `오래된 시세 · ${fetchedAt}`, state: 'stale' };
        }
        return { label: `시세 확인 필요 · ${fetchedAt}`, state: 'unavailable' };
    }

    function updateMarketAnnouncement(elementId, message, { repeat = false } = {}) {
        const element = byId(elementId);
        if (!element) return;
        if (!repeat && element.textContent === message) return;
        if (repeat && element.textContent === message) {
            element.textContent = '';
            globalThis.setTimeout(() => {
                if (element.isConnected) element.textContent = message;
            }, 25);
            return;
        }
        element.textContent = message;
    }

    function announceManualMarketRefresh() {
        const marketData = currentMarket();
        const marketPresentation = marketSnapshotPresentation(state.marketSnapshot, state.marketPricesLoaded, state.marketPrices);
        const selectedPresentation = selectedMarketQuotePresentation(
            marketData,
            marketPresentation,
            state.marketPricesLoaded
        );
        const symbol = symbolOf(state.selectedCoin);
        const fetchedAt = state.marketSnapshot?.fetchedAt
            ? ` · 서버 수집 ${formatMarketTimestamp(state.marketSnapshot.fetchedAt)}`
            : '';
        updateMarketAnnouncement(
            'pilot-market-refresh-announcement',
            `시세 새로고침 결과 · ${symbol}/KRW · ${selectedPresentation.label}${fetchedAt}`,
            { repeat: true }
        );
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
                return '작성 시각을 확인할 수 없습니다.';
            }
            const ageSeconds = Number(apiFreshness.ageSeconds);
            const ageDays = Number.isFinite(ageSeconds) && ageSeconds >= 0
                ? Math.max(1, Math.floor(ageSeconds / (24 * 60 * 60)))
                : null;
            return ageDays === null
                ? '최신 데이터로 다시 점검하세요.'
                : `${ageDays}일 전에 만든 결과입니다. 최신 데이터로 다시 점검하세요.`;
        }
        const generatedMs = Date.parse(value || '');
        if (!Number.isFinite(generatedMs) || generatedMs > Date.now()) {
            return '작성 시각을 확인할 수 없습니다.';
        }
        const ageMs = Date.now() - generatedMs;
        if (ageMs >= 24 * 60 * 60 * 1000) {
            const ageDays = Math.max(1, Math.floor(ageMs / (24 * 60 * 60 * 1000)));
            return `${ageDays}일 전에 만든 결과입니다. 최신 데이터로 다시 점검하세요.`;
        }
        return '최근 생성';
    }

    function classifyReadiness(readiness) {
        const report = readiness?.report;
        const gate = readiness?.liveGate || {};
        const freshness = report?.freshness;
        const blockerCodes = [
            ...(Array.isArray(readiness?.blockerDetails)
                ? readiness.blockerDetails.map(detail => typeof detail === 'string' ? detail : detail?.code).filter(Boolean)
                : []),
            gate.code
        ].filter(Boolean);
        const ready = readiness?.source === 'configured_scalping_validation_report' &&
            readiness?.currentEvidence === true &&
            readiness?.status === 'READY' &&
            gate.checked === true &&
            gate.passed === true &&
            freshness?.fresh === true;
        const blocked = gate.checked === true && gate.passed === false;
        const stale = freshness?.fresh === false && freshness?.reason === 'stale';
        const responseKnown = readiness?.source === 'configured_scalping_validation_report' &&
            ['READY', 'BLOCKED'].includes(readiness?.status) &&
            typeof readiness?.currentEvidence === 'boolean';
        const unreadable = blockerCodes.includes('report_unreadable');
        const missing = blockerCodes.includes('report_missing') || (report?.available === false && !unreadable);
        const validatorUnavailable = blockerCodes.includes('validator_unavailable') || gate.code === 'validator_unavailable';
        const freshnessUnknown = report?.available === true && (
            typeof freshness?.fresh !== 'boolean' ||
            ['future_timestamp', 'timestamp_missing_or_invalid'].includes(freshness?.reason)
        );
        const knownBlocker = missing || stale || blocked || blockerCodes.some(code => [
            'runtime_config_mismatch', 'fixed_config_required',
            'confidence_gate_failed', 'promotion_gate_failed', 'report_not_promoted',
            'markets_missing', 'report_config_incomplete', 'promotion_validation_failed',
            'live_validation_bypass_not_supported'
        ].includes(code)) || (blockerCodes.includes('report_not_current') && !freshnessUnknown);
        const unknown = !responseKnown || (!knownBlocker && (
            unreadable || validatorUnavailable || freshnessUnknown || gate.checked !== true
        ));
        const currentEvidence = readiness?.currentEvidence === true;
        const stateLabel = ready ? '통과' : unknown ? '확인 필요' : '보류';
        const headline = ready
            ? '실제 주문 전 점검을 통과했습니다.'
            : unknown ? '실제 주문 가능 여부를 확인할 수 없습니다.' : '실제 주문 조건을 충족하지 못했습니다.';
        const reasonLabels = {
            report_missing: '전략 점검 결과가 없습니다.',
            report_not_current: '점검 결과가 오래됐습니다.',
            live_validation_bypass_not_supported: '실전 스캘핑은 점검을 건너뛸 수 없습니다. 설정을 확인하세요.',
            runtime_config_mismatch: '현재 설정과 점검 당시 설정이 다릅니다. 현재 설정으로 다시 점검하세요.',
            fixed_config_required: '현재 설정으로 점검을 다시 실행해야 합니다.',
            report_config_incomplete: '점검에 필요한 설정 정보가 빠져 있습니다.',
            confidence_gate_failed: '전략 점검 기준을 충족하지 못했습니다.',
            promotion_gate_failed: '전략 점검 기준을 충족하지 못했습니다.',
            report_not_promoted: '전략을 실제 거래에 적용할 수 있는 상태가 아닙니다.',
            markets_missing: '점검 결과에 확인한 시장이 없습니다.',
            promotion_validation_failed: '전략 점검 기준을 충족하지 못했습니다.'
        };
        const reasons = [];
        if (stale || (blockerCodes.includes('report_not_current') && !freshnessUnknown)) reasons.push(reasonLabels.report_not_current);
        if (blockerCodes.includes('runtime_config_mismatch')) reasons.push(reasonLabels.runtime_config_mismatch);
        if (blockerCodes.includes('report_config_incomplete')) reasons.push(reasonLabels.report_config_incomplete);
        if (missing) reasons.push(reasonLabels.report_missing);
        ['fixed_config_required', 'confidence_gate_failed', 'promotion_gate_failed', 'markets_missing',
            'promotion_validation_failed', 'report_not_promoted', 'live_validation_bypass_not_supported'].forEach(code => {
            if (blockerCodes.includes(code) && reasonLabels[code]) reasons.push(reasonLabels[code]);
        });
        if (blocked && reasons.length === 0) reasons.push('전략 점검 기준을 충족하지 못했습니다.');
        if (unknown && reasons.length === 0) {
            reasons.push(unreadable
                ? '점검 결과를 읽을 수 없습니다.'
                : freshnessUnknown ? '작성 시각을 확인할 수 없습니다.'
                    : validatorUnavailable ? '점검을 완료하지 못했습니다.'
                        : '점검 결과를 불러오지 못했습니다.');
        }
        return {
            report,
            gate,
            ready,
            blocked: stateLabel === '보류',
            stale,
            missing,
            currentEvidence,
            stateLabel,
            headline,
            description: ready
                ? '실제 주문 가능 여부는 서버 모드와 모의투자 상태에 따라 달라집니다.'
                : '',
            reasons: [...new Set(reasons)].slice(0, 2)
        };
    }

    function symbolOf(coin) {
        return String(coin || '').replace(/^KRW-/, '');
    }

    function recommendationLabel(value, side) {
        switch (String(value || '').toUpperCase()) {
        case 'WATCH_CLOSELY': return side === 'buy' ? '매수 조건에 가까움' : '매도 조건에 가까움';
        case 'MONITOR': return '관찰';
        case 'CONSIDER_STOP_LOSS': return '손절 검토';
        case 'STRONG_BUY': return '강한 매수 신호';
        case 'BUY': return '매수 신호';
        case 'HOLD': return '보유';
        case 'SELL': return '매도 신호';
        case 'STRONG_SELL': return '강한 매도 신호';
        default: return '추가 확인 필요';
        }
    }

    function analysisRecommendationLabel(value) {
        return ({ BUY: '매수 신호', SELL: '매도 신호', HOLD: '관망' })[String(value || '').toUpperCase()] || '확인 필요';
    }

    function macdSignalLabel(value) {
        return ({ BULLISH: '상승', BEARISH: '하락', NEUTRAL: '중립' })[String(value || '').toUpperCase()] || '확인 필요';
    }

    function signalText(value) {
        return toUserText(String(value || '')
            .replace(/RSI\s*극과매도/gi, 'RSI 과매도 상태가 강함')
            .replace(/\bBB\b/gi, '볼린저 밴드')
            .replace(/\b24H\b/gi, '최근 24시간'));
    }

    function aiActionLabel(value) {
        return ({
            BUY: '매수',
            SELL: '매도',
            HOLD: '보유',
            WAIT: '관망'
        }[String(value || '').toUpperCase()] || '관망');
    }

    function marketNameOrAll(coin) {
        return coin ? symbolOf(coin) : '시장 전체';
    }

    function executionModelLabel(value) {
        return ({
            candle_close: '일봉 종가 기준 계산',
            quote_cross: '매수·매도 호가 기준 계산'
        }[String(value || '')] || (value === 'paper' ? '모의투자' : '계산 방식 확인 필요'));
    }

    const INTERNAL_TERM_MAP = [
        [/재검증/g, '다시 점검'],
        [/검증/g, '점검'],
        [/승격/g, '실거래 적용'],
        [/게이트/g, '조건'],
        [/무효화/g, '비교에서 제외'],
        [/홀드아웃/g, '평가 구간'],
        [/연구 전용/g, '참고용'],
        [/\braw window\b/gi, '원본 데이터 구간'],
        [/\btraining gate\b/gi, '학습 구간 기준'],
        [/\bvariant study\b/gi, '조건별 비교 결과'],
        [/\bquote-history\b/gi, '호가 기록'],
        [/\bbest[- ]?level\b/gi, '1단계 호가'],
        [/\bfull[- ]session\b/gi, '전체 기간'],
        [/\bwalk[- ]?forward\b/gi, '구간별 점검'],
        [/\bpreflight\b/gi, '시작 전 점검'],
        [/\btraining\b/gi, '학습 구간'],
        [/\bvariant\b/gi, '조건 후보'],
        [/\binvalid\b/gi, '유효하지 않은'],
        [/\braw\b/gi, '원본'],
        [/\bwindow\b/gi, '구간'],
        [/\breport\b/gi, '자료'],
        [/\bprovider\b/gi, '의견 서비스'],
        [/\bsession\b/gi, '실행'],
        [/\bforward\b/gi, '추가 관찰'],
        [/\bledger\b/gi, '거래 기록'],
        [/\bheartbeat\b/gi, '최근 응답'],
        [/\borphan(?:ed)?\b/gi, '연결이 끊긴'],
        [/\bcounterfactual\b/gi, '가정 비교'],
        [/\bconfidence intervals?\b/gi, '신뢰 구간'],
        [/\bconfidence\b/gi, '신뢰도'],
        [/\bevidence\b/gi, '확인 자료'],
        [/\bcohort\b/gi, '비교 그룹'],
        [/\bdrift\b/gi, '변경'],
        [/\bowner\b/gi, '실행 중인 작업'],
        [/\bpaper\b/gi, '모의투자'],
        [/\bpromot(?:ion|ed|e)\b/gi, '실거래 적용'],
        [/\bwinnerShadow\b/g, '수익 상위 거래 비교'],
        [/\blooseShadow\b/g, '조건 완화 비교'],
        [/\bshadow\b/gi, '비교용'],
        [/\bloose\b/gi, '완화 조건'],
        [/\bstrict\b/gi, '기본 조건'],
        [/\brelaxed\b/gi, '완화 조건'],
        [/\bfail[- ]?closed\b/gi, '안전을 위해 중지'],
        [/\bregime\b/gi, '시장 흐름'],
        [/\bgate\b/gi, '조건'],
        [/\bbreadth\b/gi, '상승 종목 비율'],
        [/\blookback\b/gi, '기준 기간'],
        [/\bticker\b/gi, '시세'],
        [/\bbreak[- ]?even\b/gi, '손익분기점'],
        [/\btrailing\b/gi, '추적 손절'],
        [/\bbenchmark\b/gi, '기준 시장'],
        [/\bspread\b/gi, '호가 차이'],
        [/\bquote\b/gi, '호가'],
        [/\bdepth\b/gi, '호가 잔량'],
        [/\bfill\b/gi, '체결'],
        [/\bcost floor\b/gi, '거래 비용 하한'],
        [/\bcost\b/gi, '비용'],
        [/\bcoverage\b/gi, '자료 충족률'],
        [/\bMDD\b/g, '최대 낙폭'],
        [/\bPF\b/g, '수익·손실 비율'],
        [/\bP95\b/g, '95백분위'],
        [/\bP05\b/g, '5백분위'],
        [/\bsamples?\b/gi, '자료'],
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
        [/\bbullish_rebound_not_confirmed\b/g, '양봉 확인 반등 미확인'],
        [/\bclose_strength_failed\b/g, '종가 강도 부족'],
        [/\btrend_filter_failed\b/g, '추세 필터 실패'],
        [/\bdaily_market_stale\b/g, '일봉 자료가 오래됨'],
        [/\bdaily_market_missing\b/g, '일봉 자료 누락'],
        [/\bdaily_market_grid_not_contiguous\b/g, '일봉 간격 확인 필요'],
        [/\bdaily_market_latest_timestamp_mismatch\b/g, '시장별 일봉 시각 불일치']
    ];

    function toUserText(value) {
        let text = String(value ?? '');
        text = text.replace(/실제 provider 응답이 없어 평가할 표본이 없습니다\./gi, '응답 기록이 없어 의견 결과를 평가할 수 없습니다.');
        text = text.replace(/아직 (\d+)개 비중립 방향성\/veto 평가 표본이 필요합니다\. 현재 (\d+)개입니다\./i,
            (_match, required, current) => `매수·매도 의견이나 주문 보류 기록이 ${required}건 이상 있어야 비교할 수 있습니다. 현재 ${current}건입니다.`);
        for (const [pattern, replacement] of INTERNAL_TERM_MAP) text = text.replace(pattern, replacement);
        return text;
    }

    function classForValue(value) {
        if (!hasFiniteValue(value)) return '';
        return Number(value) >= 0 ? 'pilot-positive' : 'pilot-negative';
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

    function isReadOnlyPwaScope() {
        return state.auth?.authRequired === true && state.auth?.resolved === true &&
            state.auth?.verification === 'verified' && state.auth?.tokenScope === 'read_only';
    }

    function isMobileOperatorPwaScope() {
        return state.auth?.authRequired === true && state.auth?.resolved === true &&
            state.auth?.verification === 'verified' && state.auth?.tokenScope === 'mobile_operator';
    }

    function pwaAuthRequestPolicy(auth, method, path) {
        if (!auth) return true;
        const verb = String(method || 'GET').toUpperCase();
        if (auth.authRequired !== true) {
            return auth.resolved === true && (auth.verification === 'not-required' ||
                (auth.verification === 'verified' && auth.tokenScope === 'operator'));
        }
        if (auth.resolved !== true || auth.verification !== 'verified') return false;
        if (auth.tokenScope === 'operator') return true;
        if (auth.tokenScope !== 'read_only' || verb !== 'GET') return false;

        let url;
        try { url = new URL(path, 'https://coinpilot.invalid'); } catch { return false; }
        if (READ_ONLY_PWA_GET_PATHS.has(url.pathname)) return url.searchParams.size === 0;
        if (url.pathname === '/portfolio/history') {
            return url.searchParams.size === 1 && READ_ONLY_PWA_PORTFOLIO_PERIODS.has(url.searchParams.get('period'));
        }
        if (url.pathname === '/trades') {
            if (url.searchParams.size !== 1 || !/^[1-9]\d*$/.test(url.searchParams.get('limit') || '')) return false;
            const limit = Number(url.searchParams.get('limit'));
            return Number.isSafeInteger(limit) && limit <= 50;
        }
        return false;
    }

    async function waitForPwaAuth() {
        if (authClient?.ready) {
            try {
                const verifiedState = await authClient.ready;
                state.auth = { ...(authClient.state || verifiedState || state.auth) };
            } catch {
                state.auth = { ...state.auth, resolved: true, verification: 'unavailable', authenticated: null, error: 'network' };
            }
        }
        syncAuthScopeNotice();
        syncObserverControls();
        return state.auth;
    }

    function isPwaMutationBlocked() {
        return !pwaAuthRequestPolicy(state.auth, 'POST', '/pwa-scope-check') || isReadOnlyObserver();
    }

    function readOnlyObserverReason() {
        if (state.auth?.resolved !== true && state.auth?.authRequired !== false) {
            return '접속 권한을 확인하는 중입니다. 확인될 때까지 주문과 설정 변경을 잠갔습니다.';
        }
        if (state.auth?.authRequired === true && state.auth?.verification === 'unavailable') {
            return '접속 권한을 확인할 수 없습니다. 저장된 토큰은 보관했으며, 확인될 때까지 주문과 설정 변경을 잠갔습니다.';
        }
        if (state.auth?.authRequired === true && state.auth?.tokenScope === 'read_only') {
            return '읽기 전용 토큰으로 접속했습니다. 주문, 설정 변경, 저장 기능은 사용할 수 없습니다.';
        }
        if (state.auth?.authRequired === true && state.auth?.tokenScope === 'mobile_operator') {
            return '모바일 운영 토큰은 모바일 앱 전용입니다. 브라우저에서는 주문과 설정 변경을 사용할 수 없습니다.';
        }
        if (state.auth?.authRequired === true && ['missing', 'invalid'].includes(state.auth?.verification)) {
            return '유효한 서버 접속 토큰이 필요합니다. 로그인 창에서 토큰을 입력해 주세요.';
        }
        return state.online === false
            ? '서버에 연결되면 상태를 불러오고 주문할 수 있습니다.'
            : '읽기 전용 모드에서는 내용을 변경할 수 없습니다.';
    }

    function syncAuthScopeNotice() {
        const banner = byId('pilot-auth-scope-banner');
        if (!banner) return;
        const title = byId('pilot-auth-scope-title');
        const copy = byId('pilot-auth-scope-copy');
        const changeTokenButton = byId('pilot-auth-change-token');
        const verification = state.auth?.verification;
        let heading = '';
        let message = '';
        if (state.auth?.authRequired === true && verification === 'checking') {
            heading = '접속 권한 확인 중';
            message = '확인이 끝날 때까지 서버 데이터와 변경 기능을 잠급니다.';
        } else if (state.auth?.authRequired === true && verification === 'unavailable') {
            heading = '접속 권한 확인 필요';
            message = '저장된 토큰은 보관했습니다. 권한을 확인할 수 있을 때까지 서버 데이터와 변경 기능을 잠급니다.';
        } else if (isReadOnlyPwaScope()) {
            heading = '조회 전용 연결';
            message = readOnlyObserverReason();
        } else if (isMobileOperatorPwaScope()) {
            heading = '모바일 앱 전용 토큰';
            message = '이 토큰은 모바일 앱에서만 사용할 수 있습니다. 브라우저 대시보드 데이터는 불러오지 않습니다.';
        }
        banner.hidden = !message;
        if (changeTokenButton) changeTokenButton.hidden = !(isReadOnlyPwaScope() || isMobileOperatorPwaScope());
        if (title) title.textContent = heading;
        if (copy) copy.textContent = message;
    }

    function syncScopedMutationControls() {
        if (isPwaMutationBlocked()) {
            const reason = readOnlyObserverReason();
            $$(PWA_MUTATION_CONTROL_SELECTOR).forEach(control => {
                control.disabled = true;
                control.setAttribute('aria-disabled', 'true');
                control.title = reason;
            });
            return;
        }
        // These inputs and AI actions have no other readiness gate. The action
        // buttons with runtime/evidence gates are restored by syncObserverControls.
        $$(PWA_SCOPE_ONLY_CONTROL_SELECTOR).forEach(control => {
            control.disabled = false;
            control.setAttribute('aria-disabled', 'false');
            control.removeAttribute('title');
        });
    }

    function clearUnavailablePwaData() {
        state.status = null;
        state.account = null;
        state.pnl = null;
        state.today = null;
        state.statistics = [];
        state.statisticsLoaded = false;
        state.validation = null;
        state.strategyReadiness = null;
        state.paper = null;
        state.strategyResearch = null;
        state.strategyResearchLoaded = false;
        state.strategyResearchError = null;
        state.momentumShadow = null;
        state.portfolioAnalysis = null;
        state.portfolioHistory = [];
        state.portfolioHistoryError = true;
        state.trades = [];
        state.tradesLoaded = false;
        state.marketPrices = [];
        state.marketPricesLoaded = false;
        state.marketSnapshot = null;
        state.targetCoins = [];
        state.candles = [];
        state.candlesError = false;
        state.analysis = null;
        state.analysisError = null;
        state.news = null;
        state.newsError = false;
        state.settings = null;
        state.settingsLoaded = false;
        state.historyLoaded = false;
        state.ai = { providers: null, sessions: [], events: [], consultations: [], effectiveness: null, loading: false };
        state.lastSync = null;
        state.coreReady = false;
        state.connected = false;
        state.actualMode = 'UNKNOWN';
    }

    window.addEventListener('coinpilot:auth-state', event => {
        if (event.detail) state.auth = { ...event.detail };
        if (state.auth?.verification === 'invalid' || state.auth?.verification === 'unavailable' ||
            isMobileOperatorPwaScope()) clearUnavailablePwaData();
        syncAuthScopeNotice();
        syncObserverControls();
        if (state.auth?.verification === 'invalid' || state.auth?.verification === 'unavailable' ||
            isMobileOperatorPwaScope()) renderAll();
    });

    function coreTradingReadinessReason() {
        return '서버 모드와 계좌, 선택한 시장의 시세를 확인할 때까지 주문할 수 없습니다.';
    }

    function paperEvidenceMutationLock() {
        if (isReadOnlyObserver()) return null;
        const apiLock = state.settings?.investmentConfig?.evidenceMutationLock ||
            state.settings?.optimization?.evidenceMutationLock;
        if (apiLock?.locked === true) return apiLock;
        if (state.paper?.active === true) {
            return {
                locked: true,
                code: 'paper_evidence_mutation_blocked',
                reason: '모의투자 실행 중에는 설정을 바꿀 수 없습니다.'
            };
        }
        return null;
    }

    function isPaperEvidenceMutationLocked() {
        return paperEvidenceMutationLock()?.locked === true;
    }

    function paperEvidenceMutationReason() {
        return paperEvidenceMutationLock()?.reason || '모의투자 실행 중에는 설정을 바꿀 수 없습니다.';
    }

    function syncObserverControls() {
        const blocked = isPwaMutationBlocked();
        const offline = state.online === false;
        const coreReady = state.coreReady === true;
        const runtimeBlocked = !runtimeCanAcceptOrders(state.status);
        const manualRuntimeBlocked = !runtimeCanAcceptManualOrders(state.status, state.actualMode);
        const exchangeStateUnsafe = state.status?.runtimeState === 'SYNC_REQUIRED' ||
            state.status?.runtimeState === 'PROTECTIVE_ONLY' || state.status?.exchangeStateKnown === false;
        const tradingLoopRunning = state.status?.isRunning === true || state.status?.runtimeState === 'RUNNING';
        const paperMode = isPaperMode();
        const evidenceLocked = isPaperEvidenceMutationLocked();
        const mutationLocked = state.pendingMutation?.locked === true;
        const orderMutationSelectors = [
            '[data-pilot-action="start-paper"]',
            '[data-pilot-action="start-paper-reset"]',
            '[data-pilot-action="stop-paper"]'
        ].join(',');
        $$(orderMutationSelectors).forEach(button => {
            const sessionDisabled = button.dataset.pilotSessionDisabled === 'true';
            const action = button.dataset.pilotAction;
            const isPaperStop = action === 'stop-paper';
            const isPaperStart = action === 'start-paper' || action === 'start-paper-reset';
            const paperStopInactive = isPaperStop && state.paper?.active !== true;
            const coreReadinessBlocked = isPaperStop ? paperStopInactive :
                !coreReady || exchangeStateUnsafe || (isPaperStart && !paperMode) ||
                (!isPaperStart && runtimeBlocked);
            const disabled = blocked || offline || sessionDisabled || coreReadinessBlocked;
            button.disabled = disabled;
            button.setAttribute('aria-disabled', disabled ? 'true' : 'false');
            if (blocked || offline) button.title = readOnlyObserverReason();
            else if (paperStopInactive) button.title = '모의투자 실행 중에만 사용할 수 있습니다.';
            else if (coreReadinessBlocked) button.title = exchangeStateUnsafe || runtimeBlocked ? runtimeBlockReason() : coreTradingReadinessReason();
            else if (!disabled) button.removeAttribute('title');
        });

        const manualOrderSelectors = [
            '[data-pilot-action="smart-buy"]',
            '[data-pilot-action="smart-sell"]',
            '[data-pilot-trade-submit]'
        ].join(',');
        const manualModeReady = state.activeMode === 'paper'
            ? paperMode
            : state.activeMode === 'live' && state.actualMode === 'LIVE';
        const manualOrderBlocked = !coreReady || exchangeStateUnsafe || manualRuntimeBlocked ||
            evidenceLocked || !manualModeReady || mutationLocked;
        $$(manualOrderSelectors).forEach(button => {
            const sessionDisabled = button.dataset.pilotSessionDisabled === 'true';
            const prefix = button.dataset.pilotTradeSubmit;
            const marketSelect = prefix ? root.querySelector(`[data-pilot-trade-coin="${prefix}"]`) : null;
            const quoteIssue = prefix ? marketQuoteFreshnessIssue(currentMarket(marketSelect?.value)) : null;
            const disabled = blocked || offline || sessionDisabled || manualOrderBlocked || Boolean(quoteIssue);
            button.disabled = disabled;
            button.setAttribute('aria-disabled', disabled ? 'true' : 'false');
            if (blocked || offline) button.title = readOnlyObserverReason();
            else if (mutationLocked) button.title = '처리 중인 요청 결과를 확인한 뒤 새 주문을 할 수 있습니다.';
            else if (evidenceLocked) button.title = paperEvidenceMutationReason();
            else if (quoteIssue) button.title = quoteIssue;
            else if (manualOrderBlocked) button.title = tradeBlockReason();
            else if (!disabled) button.removeAttribute('title');
        });

        const walletSelectors = [
            '[data-pilot-action="deposit"]',
            '[data-pilot-action="withdraw"]',
            '[data-pilot-action="reset-wallet"]'
        ].join(',');
        $$(walletSelectors).forEach(control => {
            const sessionDisabled = control.dataset.pilotSessionDisabled === 'true';
            const disabled = blocked || offline || !paperMode || exchangeStateUnsafe ||
                tradingLoopRunning || evidenceLocked || mutationLocked || sessionDisabled;
            control.disabled = disabled;
            control.setAttribute('aria-disabled', disabled ? 'true' : 'false');
            if (blocked || offline) control.title = readOnlyObserverReason();
            else if (mutationLocked) control.title = '처리 중인 요청 결과를 확인한 뒤 가상 지갑을 변경할 수 있습니다.';
            else if (!paperMode) control.title = '모의투자 모드에서만 사용할 수 있습니다.';
            else if (exchangeStateUnsafe || tradingLoopRunning) control.title = tradingLoopRunning
                ? '자동매매를 중지한 뒤 모의 잔액을 변경할 수 있습니다.'
                : runtimeBlockReason();
            else if (evidenceLocked) control.title = paperEvidenceMutationReason();
            else if (!disabled) control.removeAttribute('title');
        });

        const settingsSelectors = [
            '[data-pilot-action="save-settings"]',
            '[data-pilot-action="run-optimization"]',
            '[data-pilot-preset-id]',
            '[data-pilot-setting-key]',
            '#pilot-auto-optimization',
            '#pilot-optimization-interval'
        ].join(',');
        const settingsDisabled = blocked || offline || !state.settingsLoaded || evidenceLocked ||
            tradingLoopRunning;
        $$(settingsSelectors).forEach(control => {
            const sessionDisabled = control.dataset.pilotSessionDisabled === 'true';
            const disabled = settingsDisabled || sessionDisabled;
            control.disabled = disabled;
            control.setAttribute('aria-disabled', disabled ? 'true' : 'false');
            if (blocked || offline) control.title = readOnlyObserverReason();
            else if (!state.settingsLoaded) control.title = '설정을 불러오는 중입니다.';
            else if (evidenceLocked) control.title = paperEvidenceMutationReason();
            else if (tradingLoopRunning) control.title = '자동매매를 중지한 뒤 설정을 변경할 수 있습니다.';
            else if (!disabled) control.removeAttribute('title');
        });
        syncSnapshotControls();
        syncScopedMutationControls();
    }

    function syncSnapshotControls() {
        const observerBlocked = isPwaMutationBlocked();
        const offline = state.online === false;
        const disabled = observerBlocked || offline || state.snapshotSaving;
        $$('[data-pilot-action="record-snapshot"]').forEach(button => {
            button.disabled = disabled;
            button.setAttribute('aria-disabled', disabled ? 'true' : 'false');
            if (observerBlocked) button.title = readOnlyObserverReason();
            else if (offline) button.title = '서버 연결 후 자산 기록을 저장할 수 있습니다.';
            else if (state.snapshotSaving) button.title = '자산 기록을 저장하고 있습니다.';
            else button.removeAttribute('title');
        });
    }

    function canTrade(market = null) {
        if (state.online === false || state.coreReady !== true ||
            !runtimeCanAcceptManualOrders(state.status, state.actualMode) || isPwaMutationBlocked() ||
            isPaperEvidenceMutationLocked() || state.pendingMutation?.locked === true) return false;
        const modeReady = state.activeMode === 'paper'
            ? isPaperMode()
            : state.activeMode === 'live' && state.actualMode === 'LIVE';
        if (!modeReady) return false;
        return market === null || marketQuoteFreshnessIssue(currentMarket(market)) === null;
    }

    function runtimeCanAcceptOrders(status) {
        if (!status || status.entriesPaused === true || status.runtimeState === 'PROTECTIVE_ONLY' ||
            status.runtimeState === 'SYNC_REQUIRED' || status.exchangeStateKnown === false ||
            status.runtimeState === 'STOPPED' || status.isRunning === false) return false;
        return true;
    }

    function runtimeCanAcceptManualOrders(status, mode) {
        if (!status || status.runtimeState === 'PROTECTIVE_ONLY' || status.runtimeState === 'SYNC_REQUIRED' ||
            status.exchangeStateKnown === false) return false;
        if (mode !== 'LIVE') return true;

        const operatorStopped = ['operator_stop', 'operator_shutdown'].includes(status.stopReason);
        const manualLivePaused = status.entriesPaused === true || status.runtimeState === 'STOPPED' ||
            status.isRunning === false;
        return !manualLivePaused || operatorStopped;
    }

    function runtimeBlockReason() {
        if (state.status?.runtimeState === 'SYNC_REQUIRED' || state.status?.exchangeStateKnown === false) {
            return '설정한 시장의 거래소 잔고와 미체결 주문을 확인하는 중입니다. 확인이 끝날 때까지 신규 주문을 잠급니다.';
        }
        if (state.status?.runtimeState === 'PROTECTIVE_ONLY') {
            return state.status.stopReason === 'risk_data_gap'
                ? '시세 공백으로 분석과 신규 주문을 멈췄습니다. 열린 포지션은 위험 감시를 유지합니다.'
                : '안전 점검으로 신규 주문을 멈췄습니다. 열린 포지션은 위험 감시 중입니다.';
        }
        if (state.status?.entriesPaused === true || state.status?.runtimeState === 'STOPPED' || state.status?.isRunning === false) {
            return '자동매매가 중지되어 신규 주문을 보낼 수 없습니다.';
        }
        return '';
    }

    function tradeBlockReason(market = null) {
        if (state.online === false) {
            return '서버 연결이 끊겨 계좌와 시세를 확인할 수 없습니다. 다시 연결될 때까지 주문할 수 없습니다.';
        }
        if (state.pendingMutation?.locked) return '처리 중인 요청의 결과를 확인한 뒤 새 주문을 할 수 있습니다.';
        if (isPwaMutationBlocked()) return readOnlyObserverReason();
        if (isPaperEvidenceMutationLocked()) return paperEvidenceMutationReason();
        if (state.status && !runtimeCanAcceptManualOrders(state.status, state.actualMode)) {
            return runtimeBlockReason() || '거래소 상태를 확인할 때까지 주문할 수 없습니다.';
        }
        if (state.coreReady !== true) return coreTradingReadinessReason();
        if (state.activeMode === 'paper' && state.actualMode === 'LIVE') {
            return '서버가 실거래 모드여서 모의 주문을 보낼 수 없습니다.';
        }
        if (state.activeMode === 'live' && state.actualMode !== 'LIVE') {
            return '서버가 모의투자여서 실제 주문은 나가지 않습니다.';
        }
        if (market !== null) return marketQuoteFreshnessIssue(currentMarket(market)) || '';
        return '';
    }

    function getModeBannerPresentation({
        paper,
        modeKnown,
        liveReady,
        offline,
        readOnly,
        protectiveOnly,
        exchangeStateUnknown,
        evidenceLocked,
        corePending,
        runtimeBlocked,
        manualOrdersAllowed,
        runtimeReason,
        readOnlyReason,
        coreReadinessReason,
        tradeReason
    }) {
        if (offline) {
            return {
                title: '오프라인 · 주문 잠금',
                copy: '서버 연결이 복구될 때까지 계좌와 시세를 표시하지 않으며 주문을 중지합니다.',
                icon: 'cloud-slash',
                isLive: false
            };
        }
        if (readOnly) {
            return {
                title: '읽기 전용 · 주문 잠금',
                copy: readOnlyReason || '읽기 전용 모드에서는 내용을 변경할 수 없습니다.',
                icon: 'lock-key',
                isLive: false
            };
        }
        if (protectiveOnly) {
            return {
                title: '위험 감시 전용 · 신규 주문 잠금',
                copy: runtimeReason,
                icon: 'lock-key',
                isLive: false
            };
        }
        if (exchangeStateUnknown) {
            return {
                title: '거래소 상태 확인 중 · 주문 잠금',
                copy: runtimeReason || '거래소 상태를 확인할 때까지 신규 주문을 잠급니다.',
                icon: 'lock-key',
                isLive: false
            };
        }
        if (evidenceLocked) {
            return {
                title: '모의투자 기록 보호 · 신규 주문 잠금',
                copy: tradeReason || '모의투자 실행 기록을 보호하고 있습니다. 세션이 끝날 때까지 주문할 수 없습니다.',
                icon: 'lock-key',
                isLive: false
            };
        }
        if (corePending) {
            return {
                title: '연결 확인 중 · 주문 잠금',
                copy: coreReadinessReason,
                icon: 'lock-key',
                isLive: false
            };
        }
        if (!modeKnown) {
            return {
                title: '거래 모드 확인 중 · 주문 잠금',
                copy: '서버의 거래 모드를 확인할 때까지 주문할 수 없습니다.',
                icon: 'lock-key',
                isLive: false
            };
        }
        if (runtimeBlocked && manualOrdersAllowed) {
            return paper
                ? {
                    title: '자동매매 중지 · 모의 주문 가능',
                    copy: '자동매매는 중지되어 있습니다. 수동 주문은 모의투자로 기록되며 실제 자금은 사용되지 않습니다.',
                    icon: 'lock-key-open',
                    isLive: false
                }
                : {
                    title: '자동매매 중지 · 실거래 가능',
                    copy: '운영자가 자동매매를 중지했습니다. 거래소 상태 확인이 끝난 상태에서 수동 주문을 보낼 수 있습니다. 주문 전 자산, 수량, 위험 한도를 확인하세요.',
                    icon: 'lock-key-open',
                    isLive: false
                };
        }
        if (runtimeBlocked) {
            return {
                title: '매매 중지 · 신규 주문 잠금',
                copy: runtimeReason || '자동매매가 중지되어 신규 주문을 보낼 수 없습니다.',
                icon: 'lock-key',
                isLive: false
            };
        }
        if (!paper && liveReady) {
            return {
                title: '실거래 활성',
                copy: '주문 전 자산, 수량, 위험 한도를 확인하세요. 실제 체결 여부는 거래 내역에서 확인할 수 있습니다.',
                icon: 'shield-check',
                isLive: true
            };
        }
        if (paper && manualOrdersAllowed) {
            return {
                title: '모의투자 · 실제 주문 잠금',
                copy: '수동 주문은 모의투자로 기록되며 실제 자금은 사용되지 않습니다.',
                icon: 'lock-key-open',
                isLive: false
            };
        }
        if (!paper && manualOrdersAllowed) {
            return {
                title: '실거래 · 수동 주문 가능',
                copy: '실거래 수동 주문이 허용된 상태입니다. 자동매매 승인 상태는 별도 점검 결과를 따릅니다.',
                icon: 'lock-key-open',
                isLive: false
            };
        }
        return {
            title: '실거래 주문 잠금',
            copy: tradeReason || '실제 주문 전 점검을 마칠 때까지 주문할 수 없습니다.',
            icon: 'lock-key',
            isLive: false
        };
    }

    async function requestJSON(path, options = {}) {
        await waitForPwaAuth();
        if (state.online === false) throw new Error(readOnlyObserverReason());
        const method = String(options.method || 'GET').toUpperCase();
        if (!pwaAuthRequestPolicy(state.auth, method, path)) {
            const error = new Error(readOnlyObserverReason());
            error.status = 403;
            error.code = 'pwa_auth_scope_blocked';
            throw error;
        }
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
                const serverMessage = data?.message || data?.error;
                const fallbackMessage = response.status >= 500
                    ? '서버에서 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'
                    : '요청을 처리하지 못했습니다. 다시 시도해 주세요.';
                const error = new Error(toUserText(serverMessage || fallbackMessage));
                error.status = response.status;
                error.reason = typeof data?.reason === 'string' ? data.reason : null;
                throw error;
            }
            return data;
        } catch (error) {
            if (error?.name === 'AbortError') throw new Error('서버 응답이 늦습니다. 연결 상태를 확인한 뒤 다시 시도하세요.', { cause: error });
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
        toast.innerHTML = `<i class="ph ph-${icon}" aria-hidden="true"></i><span>${escapeHtml(toUserText(message))}</span>`;
        stack.appendChild(toast);
        window.setTimeout(() => toast.remove(), 4800);
    }

    function clearToasts() {
        const stack = byId('pilot-toast-stack');
        if (stack) stack.innerHTML = '';
    }

    function getModalFocusableElements(dialog) {
        return Array.from(dialog.querySelectorAll('a[href], button, input, select, textarea, [tabindex]'))
            .filter(element => !element.disabled
                && !element.hidden
                && element.tabIndex >= 0
                && !element.closest?.('[hidden], [inert], [aria-hidden="true"]')
                && (typeof element.getClientRects !== 'function' || element.getClientRects().length > 0));
    }

    function focusModalElement(element) {
        if (!element || typeof element.focus !== 'function') return;
        try {
            element.focus({ preventScroll: true });
        } catch {
            element.focus();
        }
    }

    function handleModalKeydown(event, dialog, documentRef = document) {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeModal();
            return true;
        }
        if (event.key !== 'Tab') return false;

        const focusable = getModalFocusableElements(dialog);
        if (!focusable.length) {
            event.preventDefault();
            focusModalElement(dialog);
            return true;
        }

        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const activeElement = documentRef.activeElement;
        if (!focusable.includes(activeElement)) {
            event.preventDefault();
            focusModalElement(event.shiftKey ? last : first);
            return true;
        }
        if (event.shiftKey && activeElement === first) {
            event.preventDefault();
            focusModalElement(last);
            return true;
        }
        if (!event.shiftKey && activeElement === last) {
            event.preventDefault();
            focusModalElement(first);
            return true;
        }
        return false;
    }

    function showModal(title, body, footer = '', {
        returnFocusTo = document.activeElement,
        returnFocusKey = null,
        returnFocusIndex = null
    } = {}) {
        const modalRoot = byId('pilot-modal-root');
        if (!modalRoot) return;
        if (!modalRoot.querySelector('.pilot-modal')) {
            modalReturnFocus = returnFocusTo;
            modalReturnFocusKey = returnFocusKey;
            modalReturnFocusIndex = returnFocusIndex;
        }
        modalRoot.innerHTML = `
            <div class="pilot-modal-backdrop" data-pilot-modal-close>
                <section class="pilot-modal" role="dialog" aria-modal="true" aria-labelledby="pilot-modal-title" tabindex="-1">
                    <header class="pilot-modal-header">
                        <h2 class="pilot-modal-title" id="pilot-modal-title" tabindex="-1">${escapeHtml(title)}</h2>
                        <button type="button" class="pilot-icon-button" data-pilot-modal-close aria-label="닫기"><i class="ph ph-x" aria-hidden="true"></i></button>
                    </header>
                    <div class="pilot-modal-body">${body}</div>
                    <footer class="pilot-modal-footer">${footer || '<button type="button" class="pilot-button" data-pilot-modal-close>닫기</button>'}</footer>
                </section>
            </div>
        `;
        focusModalElement(modalRoot.querySelector('.pilot-modal-title'));
    }

    function closeModal() {
        const modalRoot = byId('pilot-modal-root');
        if (modalRoot) modalRoot.innerHTML = '';
        const returnFocusTo = modalReturnFocus;
        const returnFocusKey = modalReturnFocusKey;
        const returnFocusIndex = modalReturnFocusIndex;
        modalReturnFocus = null;
        modalReturnFocusKey = null;
        modalReturnFocusIndex = null;
        if (returnFocusTo?.isConnected) {
            focusModalElement(returnFocusTo);
        } else if (returnFocusKey !== null) {
            const newsRows = Array.from(root.querySelectorAll('.pilot-news-row[data-pilot-news-key]'));
            const replacement = findNewsFocusTarget(newsRows, returnFocusKey, returnFocusIndex);
            if (replacement) focusModalElement(replacement);
        }
    }

    function tradePanelMarkup(prefix) {
        return `
            <aside class="pilot-panel pilot-execution-panel" data-pilot-trade-panel="${prefix}">
                <div class="pilot-panel-header">
                    <div>
                        <h2 class="pilot-panel-title">거래하기</h2>
                    </div>
                    <span class="pilot-status-pill" data-pilot-trade-mode-label="${prefix}">모의투자</span>
                </div>
                <div class="pilot-trade-lock" data-pilot-trade-lock="${prefix}">
                    <i class="ph ph-lock-key-open" aria-hidden="true"></i>
                    <div data-pilot-trade-lock-copy="${prefix}">모의투자 주문입니다.</div>
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
        return provider === 'gpt' ? 'ChatGPT' : provider === 'claude' ? 'Claude' : '의견 서비스';
    }

    function aiEventLabel(eventType) {
        return aiEventLabels[eventType] || '기타 신호';
    }

    function aiStatusLabel(status) {
        return {
            RUNNING: '진행 중',
            PAUSED: '일시정지',
            STOPPED: '중지',
            COMPLETED: '완료',
            DEGRADED: '일부 응답',
            FAILED: '실패'
        }[status] || '확인 필요';
    }

    function aiDeskMarkup() {
        return `
            <section class="pilot-page pilot-ai-page" data-pilot-page="ai">
                <div class="pilot-page-heading">
                    <div><h1 class="pilot-page-title">시장 의견</h1></div>
                    <div class="pilot-heading-actions"><span class="pilot-sync-note" id="pilot-ai-sync">마지막 동기화 -</span><button type="button" class="pilot-button" data-pilot-ai-refresh><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> 새로고침</button></div>
                </div>
                <div class="pilot-ai-policy"><div><strong><i class="ph ph-shield-check" aria-hidden="true"></i> 참고 의견</strong><span>이 의견은 자동매매 주문에 반영되지 않습니다.</span></div></div>
                <div id="pilot-ai-load-error" class="pilot-ai-load-error" role="status" hidden></div>
                <div class="pilot-ai-grid">
                    <div class="pilot-ai-column">
                        <section class="pilot-panel"><div class="pilot-ai-panel-header"><div><h2 class="pilot-panel-title">연결 상태</h2></div><span class="pilot-status-pill is-warning" id="pilot-ai-provider-policy">서비스 확인</span></div><div class="pilot-ai-panel-body"><div id="pilot-ai-providers" class="pilot-ai-providers"><div class="pilot-ai-empty">연결 상태를 불러오는 중입니다.</div></div></div></section>
                        <section class="pilot-panel"><div class="pilot-ai-panel-header"><div><h2 class="pilot-panel-title">의견 이후 가격 변화</h2><p class="pilot-panel-subtitle">의견을 받은 뒤의 가격 움직임을 확인합니다.</p></div><span class="pilot-status-pill is-warning" id="pilot-ai-effectiveness-state">데이터 대기</span></div><div class="pilot-ai-panel-body"><div id="pilot-ai-effectiveness" class="pilot-ai-effectiveness"><div class="pilot-ai-empty">의견 기록이 쌓이면 이후 가격 움직임을 확인할 수 있습니다.</div></div></div></section>
                        <section class="pilot-panel"><div class="pilot-ai-panel-header"><div><h2 class="pilot-panel-title">관심 신호 알림</h2></div><span class="pilot-status-pill" id="pilot-ai-session-count">알림 중 0개</span></div><div class="pilot-ai-panel-body"><div id="pilot-ai-sessions" class="pilot-ai-session-list"><div class="pilot-ai-empty">등록한 알림이 없습니다.</div></div></div></section>
                        <section class="pilot-panel"><div class="pilot-ai-panel-header"><div><h2 class="pilot-panel-title">알림 설정</h2></div></div><div class="pilot-ai-panel-body"><form class="pilot-ai-session-form" id="pilot-ai-session-form"><label class="pilot-ai-form-label">이름<input class="pilot-ai-form-input" id="pilot-ai-session-name" maxlength="80" value="시장 신호 알림" placeholder="예: BTC 반등 신호"></label><div class="pilot-ai-form-label">의견을 받을 서비스<div class="pilot-ai-check-grid"><label class="pilot-ai-check"><input type="checkbox" name="pilot-ai-provider" value="gpt" checked> ChatGPT</label><label class="pilot-ai-check"><input type="checkbox" name="pilot-ai-provider" value="claude" checked> Claude</label></div></div><div class="pilot-ai-form-label">알림 받을 항목<div class="pilot-ai-check-grid"><label class="pilot-ai-check"><input type="checkbox" name="pilot-ai-event" value="BUY_SIGNAL" checked> 매수 신호</label><label class="pilot-ai-check"><input type="checkbox" name="pilot-ai-event" value="SELL_SIGNAL" checked> 매도 신호</label><label class="pilot-ai-check"><input type="checkbox" name="pilot-ai-event" value="REBOUND_CANDIDATE"> 반등 후보</label><label class="pilot-ai-check"><input type="checkbox" name="pilot-ai-event" value="BREAKING_NEWS"> 속보</label><label class="pilot-ai-check"><input type="checkbox" name="pilot-ai-event" value="BUNDLE_SUGGESTION"> 리밸런싱 제안</label><label class="pilot-ai-check"><input type="checkbox" name="pilot-ai-event" value="TRADE_EXECUTED"> 체결 알림</label></div></div><label class="pilot-ai-form-label">코인 선택 <small>선택 사항 · BTC 또는 KRW-BTC</small><input class="pilot-ai-form-input" id="pilot-ai-session-coins" placeholder="전체 코인"></label><div class="pilot-field-row"><label class="pilot-ai-form-label">같은 신호 의견 요청 간격 (초)<input class="pilot-ai-form-input" id="pilot-ai-cooldown" type="number" min="30" max="86400" step="30" value="300"></label><label class="pilot-ai-form-label">의견 자동 요청<label class="pilot-ai-check"><input id="pilot-ai-auto-consult" type="checkbox" checked> 선택한 신호가 생기면 요청</label></label></div><button class="pilot-button is-primary" type="submit"><i class="ph ph-broadcast" aria-hidden="true"></i> 신호 알림 시작</button></form></div></section>
                    </div>
                    <div class="pilot-ai-column">
                        <section class="pilot-panel"><div class="pilot-ai-panel-header"><div><h2 class="pilot-panel-title">시장 신호와 뉴스</h2><p class="pilot-panel-subtitle">매수·매도 신호와 주요 뉴스가 표시됩니다.</p></div><span class="pilot-status-pill is-warning" id="pilot-ai-snapshot-time">새 신호 대기</span></div><div class="pilot-ai-panel-body"><div id="pilot-ai-events" class="pilot-ai-event-list"><div class="pilot-ai-empty">새 신호와 주요 뉴스를 기다리고 있습니다.</div></div><div class="pilot-inline-note"><i class="ph ph-cursor-click" aria-hidden="true"></i><span>신호를 선택해 의견을 요청할 수 있습니다.</span></div></div></section>
                        <section class="pilot-panel"><div class="pilot-ai-panel-header"><div><h2 class="pilot-panel-title">최근 의견</h2><p class="pilot-panel-subtitle">서비스별 의견, 주의할 점, 다시 확인할 조건</p></div><span class="pilot-status-pill" id="pilot-ai-consultation-count">0건</span></div><div class="pilot-ai-panel-body"><div id="pilot-ai-consultations" class="pilot-ai-consultation-list"><div class="pilot-ai-empty">의견을 요청하면 여기에 표시됩니다.</div></div></div></section>
                    </div>
                </div>
            </section>
        `;
    }

    function mountAiDesk() {
        const newsNav = root.querySelector('[data-pilot-view="news"]');
        if (newsNav) newsNav.insertAdjacentHTML('beforebegin', '<button type="button" class="pilot-nav-button" data-pilot-view="ai"><i class="ph ph-chat-text" aria-hidden="true"></i><span>의견</span></button>');
        const newsPage = root.querySelector('[data-pilot-page="news"]');
        if (newsPage) newsPage.insertAdjacentHTML('beforebegin', aiDeskMarkup());
        const aiForm = byId('pilot-ai-session-form');
        const cooldownRow = byId('pilot-ai-cooldown')?.closest('.pilot-field-row');
        if (aiForm && cooldownRow && !byId('pilot-ai-evaluation-minutes')) {
            const evaluationLabel = document.createElement('label');
            evaluationLabel.className = 'pilot-ai-form-label';
            evaluationLabel.innerHTML = '가격 확인 시점 (분)<input class="pilot-ai-form-input" id="pilot-ai-evaluation-minutes" type="number" min="1" max="1440" step="1" value="5">';
            cooldownRow.parentElement.insertBefore(evaluationLabel, cooldownRow.nextSibling);
        }
    }

    function closeMobileNavigationMenu() {
        const menu = byId('pilot-mobile-menu');
        const moreButton = byId('pilot-mobile-more');
        if (!menu?.open) return;
        if (typeof menu.close === 'function') {
            menu.close();
            return;
        }
        menu.removeAttribute('open');
        moreButton?.setAttribute('aria-expanded', 'false');
        moreButton?.focus({ preventScroll: true });
    }

    function mountMobileNavigation() {
        const moreButton = byId('pilot-mobile-more');
        const menu = byId('pilot-mobile-menu');
        const menuNav = menu?.querySelector('.pilot-mobile-menu-nav');
        if (!moreButton || !menu || !menuNav) return;

        const remainingDestinations = Array.from(root.querySelectorAll('.pilot-sidebar-nav [data-pilot-view]'))
            .filter(button => !MOBILE_CORE_VIEWS.has(button.dataset.pilotView));
        remainingDestinations.forEach(button => {
            const menuItem = button.cloneNode(true);
            menuItem.classList.remove('is-active');
            menuItem.removeAttribute('aria-current');
            menuItem.classList.add('pilot-mobile-menu-item');
            menuNav.append(menuItem);
        });

        moreButton.addEventListener('click', () => {
            if (menu.open) return;
            if (typeof menu.showModal === 'function') menu.showModal();
            else menu.setAttribute('open', '');
            moreButton.setAttribute('aria-expanded', 'true');
            const firstDestination = menuNav.querySelector('[data-pilot-view]');
            (firstDestination || menu.querySelector('[data-pilot-mobile-close]'))?.focus({ preventScroll: true });
        });

        menu.querySelector('[data-pilot-mobile-close]')?.addEventListener('click', closeMobileNavigationMenu);
        menu.addEventListener('cancel', event => {
            event.preventDefault();
            closeMobileNavigationMenu();
        });
        menu.addEventListener('click', event => {
            if (event.target === menu) closeMobileNavigationMenu();
        });
        menu.addEventListener('close', () => {
            moreButton.setAttribute('aria-expanded', 'false');
            moreButton.focus({ preventScroll: true });
        });
    }

    function syncViewNavigation(view) {
        $$('[data-pilot-view]').forEach(button => {
            const isCurrent = button.dataset.pilotView === view;
            button.classList.toggle('is-active', isCurrent);
            if (isCurrent) button.setAttribute('aria-current', 'page');
            else button.removeAttribute('aria-current');
        });

        const moreButton = byId('pilot-mobile-more');
        if (moreButton) {
            const currentMenuItem = $$('.pilot-mobile-menu-nav [data-pilot-view]')
                .find(button => button.dataset.pilotView === view);
            const currentLabel = currentMenuItem?.querySelector('span')?.textContent?.trim();
            const hiddenCurrentView = !MOBILE_CORE_VIEWS.has(view);
            moreButton.classList.toggle('is-active', hiddenCurrentView);
            moreButton.setAttribute(
                'aria-label',
                hiddenCurrentView && currentLabel ? `더보기, 현재 선택: ${currentLabel}` : '더보기'
            );
        }
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
        if (policy) policy.textContent = '연결 상태';
        if (!status?.providers?.length) {
            container.innerHTML = '<div class="pilot-ai-empty" style="grid-column:1/-1">서비스 연결 상태를 불러오지 못했습니다.</div>';
            return;
        }
        container.innerHTML = status.providers.map(provider => {
            const configWarning = provider.status === 'READY_WITH_CONFIG_WARNING' ||
                (provider.status === 'CONFIG_ERROR' && provider.canAttemptWithoutUserConfig === true);
            const userState = configWarning && provider.ready ? '연결됨' : provider.ready ? '사용 가능' : provider.status === 'NOT_AUTHENTICATED' ? '계정 로그인 필요' : '사용할 수 없음';
            const userClass = provider.ready ? 'is-ready' : provider.status === 'NOT_AUTHENTICATED' ? 'is-warning' : 'is-error';
            const providerName = provider.label || aiProviderLabel(provider.id);
            const helpText = provider.ready
                ? configWarning ? '별도 계정 연결로 의견을 받을 수 있습니다.' : '의견을 받을 수 있습니다.'
                : provider.status === 'NOT_AUTHENTICATED'
                    ? `${providerName} 계정에 로그인해 주세요.`
                    : provider.status === 'NOT_INSTALLED'
                        ? `${providerName} 연결 프로그램을 찾지 못했습니다.`
                        : provider.status === 'DISABLED'
                            ? '현재 사용할 수 없습니다.'
                            : '연결 상태를 확인한 뒤 다시 시도해 주세요.';
            return `<article class="pilot-ai-provider ${userClass}"><div class="pilot-ai-provider-head"><span class="pilot-ai-provider-name">${escapeHtml(providerName)}</span><span class="pilot-ai-provider-state ${userClass}">${userState}</span></div><span class="pilot-ai-provider-help">${escapeHtml(helpText)}</span></article>`;
        }).join('');
    }

    function renderAiEffectiveness(effectiveness) {
        const container = byId('pilot-ai-effectiveness');
        const statePill = byId('pilot-ai-effectiveness-state');
        if (!container) return;
        const evidenceReady = effectiveness?.sufficientEvidence === true;
        if (statePill) {
            statePill.textContent = evidenceReady ? '가격 비교 자료 충분' : '가격 비교 자료 부족';
            statePill.className = `pilot-status-pill ${evidenceReady ? 'is-ready' : 'is-warning'}`;
        }
        if (!effectiveness) {
            container.innerHTML = '<div class="pilot-ai-empty">가격 비교 자료를 불러오지 못했습니다.</div>';
            return;
        }
        const stats = Object.values(effectiveness.providerStats || {});
        const providerStats = stats.filter(stat => stat.type === 'provider');
        const statMarkup = stats.length
            ? stats.map(stat => {
                const hitRate = stat.hitRate === null || stat.hitRate === undefined ? '-' : `${(number(stat.hitRate) * 100).toFixed(1)}%`;
                const latency = stat.averageLatencyMs === null || stat.averageLatencyMs === undefined ? '-' : `${(number(stat.averageLatencyMs) / 1000).toFixed(1)}초`;
            const veto = (stat.vetoGood || stat.vetoMissedOpportunity || stat.vetoFlat)
                    ? ` · 보류 뒤 가격 변화: 하락 ${stat.vetoGood || 0}건 · 상승 ${stat.vetoMissedOpportunity || 0}건 · 중립 ${stat.vetoFlat || 0}건`
                    : '';
                const directionalPredictions = Number(stat.directionalPredictions) || 0;
                const vetoImpact = stat.vetoNetImpactPercent === null || stat.vetoNetImpactPercent === undefined
                    ? ''
                    : ` · 주문 보류 후 가격 움직임 기준 영향 ${number(stat.vetoNetImpactPercent) >= 0 ? '+' : ''}${number(stat.vetoNetImpactPercent).toFixed(2)}%`;
                const resultLine = stat.type === 'consensus'
                    ? `가격 확인 ${stat.evaluated || 0}건 · 방향 의견 ${directionalPredictions}건 · 일치 ${stat.hits || 0}건 · 불일치 ${stat.misses || 0}건${vetoImpact}`
                    : `응답 ${stat.completed || 0}/${stat.attempted || 0}회 · 가격 확인 ${stat.evaluated || 0}건 · 방향 의견 ${directionalPredictions}건 · 평균 응답 ${latency}${veto}${vetoImpact}`;
                return `<div class="pilot-ai-effectiveness-row"><div><strong>${escapeHtml(stat.label || stat.source)}</strong><span>${escapeHtml(resultLine)}</span></div><b aria-label="가격 방향 일치율"><span>방향 일치</span>${escapeHtml(hitRate)}</b></div>`;
            }).join('')
            : '<div class="pilot-ai-empty">아직 의견 기록이 없습니다.</div>';
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
        container.innerHTML = `<div class="pilot-ai-effectiveness-summary"><div><strong>${escapeHtml(String(effectiveness.actualProviderCompletions || 0))}</strong><span>응답 완료</span></div><div><strong>${escapeHtml(String(effectiveness.evaluatedConsultations || 0))}</strong><span>이후 가격 확인</span></div><div><strong>${escapeHtml(String(actionable))}</strong><span>가격을 비교할 수 있는 매수·매도 의견</span></div><div><strong>${escapeHtml(coverage)}</strong><span>이후 가격 확인률</span></div><div><strong>${escapeHtml(completion)}</strong><span>응답 완료율</span></div></div><div class="pilot-ai-effectiveness-list">${statMarkup}</div>${providerStats.length ? '<div class="pilot-inline-note"><i class="ph ph-chart-line-up" aria-hidden="true"></i><span>방향 일치율은 의견 뒤 가격 움직임을 비교한 값이며 실제 매매 수익률이 아닙니다. 매수·매도 의견 없이 관망한 경우는 별도로 집계합니다.</span></div>' : ''}${warning}`;
    }

    function renderAiSessions(sessions) {
        const container = byId('pilot-ai-sessions');
        const count = byId('pilot-ai-session-count');
        if (!container) return;
        const activeCount = (sessions || []).filter(session => session.status === 'RUNNING').length;
        if (count) count.textContent = `알림 중 ${activeCount}개 · 전체 ${(sessions || []).length}개`;
        if (!sessions?.length) {
            container.innerHTML = '<div class="pilot-ai-empty">등록한 알림이 없습니다.</div>';
            return;
        }
        container.innerHTML = sessions.map(session => {
            const statusClass = session.status === 'RUNNING' ? '' : session.status === 'PAUSED' ? 'is-paused' : 'is-stopped';
            const statusText = aiStatusLabel(session.status);
            const providers = (session.providers || []).map(aiProviderLabel).join(' + ');
            const events = (session.eventTypes || []).map(type => aiEventLabel(type)).join(' · ');
            const coins = session.coins?.length ? session.coins.map(symbolOf).join(', ') : '전체 코인';
            const actions = session.status === 'RUNNING'
                ? `<button type="button" class="pilot-button" data-pilot-ai-session-action="pause" data-session-id="${session.id}">일시정지</button><button type="button" class="pilot-button is-danger" data-pilot-ai-session-action="stop" data-session-id="${session.id}">종료</button>`
                : session.status === 'PAUSED'
                    ? `<button type="button" class="pilot-button" data-pilot-ai-session-action="resume" data-session-id="${session.id}">재개</button><button type="button" class="pilot-button is-danger" data-pilot-ai-session-action="stop" data-session-id="${session.id}">종료</button>`
                    : '';
            return `<article class="pilot-ai-session ${statusClass}"><div class="pilot-ai-session-head"><span class="pilot-ai-session-name">${escapeHtml(session.name)}</span><span class="pilot-ai-provider-state ${session.status === 'RUNNING' ? 'is-ready' : session.status === 'PAUSED' ? 'is-warning' : 'is-error'}">${statusText}</span></div><div class="pilot-ai-session-meta">${escapeHtml(providers)}<br>${escapeHtml(events)}<br>${escapeHtml(coins)} · 받은 신호 ${session.eventCount || 0}건 · 요청한 의견 ${session.consultationCount || 0}회 · 가격 확인 ${session.evaluationMinutes || 5}분 후</div><div class="pilot-ai-session-meta">시작 ${escapeHtml(formatDateTime(session.startedAt))} · 최근 신호 ${escapeHtml(formatDateTime(session.lastEventAt))}</div><div class="pilot-ai-actions">${actions}</div></article>`;
        }).join('');
    }

    function renderAiEvents(events) {
        const container = byId('pilot-ai-events');
        if (!container) return;
        if (!events?.length) {
            container.innerHTML = '<div class="pilot-ai-empty">새 매수·매도 신호가 생기면 여기에 표시됩니다.</div>';
            return;
        }
        container.innerHTML = events.slice(0, 40).map(event => {
            const eventClass = event.type === 'SELL_SIGNAL' ? 'is-sell' : event.type === 'BREAKING_NEWS' ? 'is-news' : 'is-buy';
            const actionClass = event.action === 'SELL' ? 'is-sell' : event.action === 'BUY' ? 'is-buy' : '';
            const coin = marketNameOrAll(event.coin);
            const price = event.price === null || event.price === undefined ? '-' : `${formatPrice(event.price)}원`;
            return `<article class="pilot-ai-event ${eventClass}"><div class="pilot-ai-event-head"><span class="pilot-ai-event-title">${escapeHtml(coin)} · ${escapeHtml(aiEventLabel(event.type))}</span><span class="pilot-ai-event-action ${actionClass}">${escapeHtml(aiActionLabel(event.action))}</span></div><div class="pilot-ai-event-meta">${escapeHtml(formatDateTime(event.timestamp))} · ${escapeHtml(price)}${event.signalStrength ? ` · ${escapeHtml(event.signalStrength)}` : ''}<br>${escapeHtml(toUserText(event.reason || event.snapshot?.title || '신호 상세 없음'))}</div><div class="pilot-ai-actions"><button type="button" class="pilot-button is-small" data-pilot-ai-consult-event="${event.id}"><i class="ph ph-chat-text" aria-hidden="true"></i> 이 신호에 의견 요청</button></div></article>`;
        }).join('');
    }

    function renderAiConsultations(consultations) {
        const container = byId('pilot-ai-consultations');
        const count = byId('pilot-ai-consultation-count');
        if (!container) return;
        if (count) count.textContent = `${(consultations || []).length}건`;
        if (!consultations?.length) {
            container.innerHTML = '<div class="pilot-ai-empty">의견을 요청하면 여기에 표시됩니다.</div>';
            return;
        }
        container.innerHTML = consultations.slice(0, 40).map(consultation => {
            const hasProviderResponse = (consultation.results || []).some(result => result.status === 'COMPLETED');
            const statusText = consultation.status === 'DEGRADED' && !hasProviderResponse
                ? '응답 없음 · 자료 요약'
                : aiStatusLabel(consultation.status);
            const stateClass = consultation.status === 'COMPLETED'
                ? 'is-completed'
                : consultation.status === 'DEGRADED'
                    ? 'is-degraded'
                    : consultation.status === 'RUNNING' ? '' : 'is-failed';
            const event = consultation.event || {};
            const coin = marketNameOrAll(event.coin);
            const results = (consultation.results || []).map(result => {
                if (result.status === 'FALLBACK' && result.advice) {
                    const fallback = result.advice;
                    const risks = (fallback.risks || []).map(risk => `<li>${escapeHtml(risk)}</li>`).join('');
                    return `<div class="pilot-ai-consultation-result"><div class="pilot-ai-advice-action is-wait">확인한<br>정보</div><div class="pilot-ai-rationale"><strong>서비스 응답을 받지 못해 서버에서 확인한 정보만 정리했습니다.</strong><br>${escapeHtml(fallback.rationale || '')}${risks ? `<ul class="pilot-ai-risks">${risks}</ul>` : ''}<div class="pilot-ai-consultation-meta">${escapeHtml(fallback.invalidation || '서비스에 연결한 뒤 다시 요청할 수 있습니다.')}</div></div></div>`;
                }
                if (result.status !== 'COMPLETED' || !result.advice) return `<div class="pilot-ai-rationale" style="color:var(--sl-red)">${escapeHtml(aiProviderLabel(result.provider))}: ${escapeHtml(toUserText(result.error || '응답 실패'))}</div>`;
                const advice = result.advice;
                const actionClass = advice.action === 'SELL' ? 'is-sell' : ['HOLD', 'WAIT'].includes(advice.action) ? 'is-wait' : '';
                const risks = (advice.risks || []).map(risk => `<li>${escapeHtml(risk)}</li>`).join('');
                const configWarning = result.configWarning ? '<div class="pilot-ai-consultation-meta">앱에서 사용하는 계정 설정과 별도로 연결했습니다.</div>' : '';
                return `<div class="pilot-ai-consultation-result"><div class="pilot-ai-advice-action ${actionClass}">${escapeHtml(aiActionLabel(advice.action))}</div><div class="pilot-ai-rationale"><strong>${escapeHtml(aiProviderLabel(result.provider))}</strong> · ${escapeHtml(advice.horizon || '')}<br>${escapeHtml(advice.rationale || '')}${risks ? `<ul class="pilot-ai-risks">${risks}</ul>` : ''}<div class="pilot-ai-consultation-meta">다시 확인할 조건: ${escapeHtml(advice.invalidation || '추가 확인 필요')}</div>${configWarning}</div></div>`;
            }).join('');
            const pending = consultation.status === 'RUNNING' ? '<div class="pilot-ai-rationale">응답을 기다리는 중…</div>' : '';
            const error = consultation.error ? `<div class="pilot-ai-rationale" style="color:var(--sl-red)">${escapeHtml(toUserText(consultation.error))}</div>` : '';
            const evaluation = consultation.evaluation;
            const evaluationMarkup = evaluation?.status === 'COMPLETED'
            ? `<div class="pilot-ai-evaluation"><strong>가격 변화 확인</strong><span>${escapeHtml(`${number(evaluation.horizonMinutes, 5)}분 후 ${number(evaluation.priceChangePercent).toFixed(2)}%`)}</span><span>${(evaluation.verdicts || []).map(verdict => `${escapeHtml(toUserText(verdict.providerLabel || verdict.source))} ${escapeHtml(toUserText(verdict.verdict))}`).join(' · ')}</span></div>`
                : evaluation?.status === 'PENDING'
                    ? '<div class="pilot-ai-evaluation is-pending"><strong>가격 확인 대기</strong><span>평가 시점 이후 가격을 확인하고 있습니다.</span></div>'
                    : evaluation?.status === 'NOT_EVALUABLE'
                        ? `<div class="pilot-ai-evaluation is-pending"><strong>가격 비교 제외</strong><span>${escapeHtml(toUserText(evaluation.reason || '기준 가격이나 응답이 없어 비교할 수 없습니다.'))}</span></div>`
                        : '';
            return `<article class="pilot-ai-consultation ${stateClass}"><div class="pilot-ai-consultation-head"><span class="pilot-ai-event-title">${escapeHtml(coin)} · ${escapeHtml(aiEventLabel(event.type))}</span><span class="pilot-ai-provider-state ${stateClass === 'is-completed' ? 'is-ready' : stateClass === 'is-failed' ? 'is-error' : 'is-warning'}">${escapeHtml(statusText)}</span></div><div class="pilot-ai-consultation-meta">${escapeHtml(formatDateTime(consultation.createdAt))} · ${(consultation.providerSelection || []).map(aiProviderLabel).map(escapeHtml).join(' + ')}${consultation.auto ? ' · 자동 요청' : ' · 직접 요청'}</div>${results || pending || error}${evaluationMarkup}</article>`;
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
        setText('pilot-ai-snapshot-time', snapshot.latestSnapshot?.timestamp ? `수신 ${formatTime(snapshot.latestSnapshot.timestamp, true)}` : '새 신호 대기');
    }

    async function loadAiDesk(force = false) {
        if (state.ai.loading) return;
        state.ai.loading = true;
        try {
            const providerPath = force ? '/ai/providers?refresh=true' : '/ai/providers';
            const [providers, snapshot] = await Promise.all([requestJSON(providerPath), requestJSON('/ai/monitoring?limit=40')]);
            const loadError = byId('pilot-ai-load-error');
            if (loadError) loadError.hidden = true;
            state.ai.providers = providers;
            renderAiProviders(providers);
            renderAiSnapshot(snapshot);
        } catch {
            const loadError = byId('pilot-ai-load-error');
            if (loadError) {
                loadError.textContent = '의견 정보를 불러오지 못했습니다. 연결 상태를 확인하거나 새로고침해 주세요.';
                loadError.hidden = false;
            }
            setText('pilot-ai-provider-policy', '확인 필요');
            const providers = byId('pilot-ai-providers');
            if (providers) providers.innerHTML = '<div class="pilot-ai-empty">서비스 연결 상태를 확인할 수 없습니다.</div>';
        } finally {
            state.ai.loading = false;
        }
    }

    async function createAiSession(event) {
        event.preventDefault();
        if (isPwaMutationBlocked()) { showToast(readOnlyObserverReason(), 'warning'); return; }
        const providers = $$('input[name="pilot-ai-provider"]:checked').map(input => input.value);
        const eventTypes = $$('input[name="pilot-ai-event"]:checked').map(input => input.value);
        if (!providers.length || !eventTypes.length) {
            showToast('의견을 받을 서비스와 알림 항목을 하나 이상 선택해 주세요.', 'warning');
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
            showToast('신호 알림을 시작했습니다.', 'success');
            await loadAiDesk(false);
        } catch (error) {
            showToast(`신호 알림을 시작하지 못했습니다: ${error.message}`, 'error');
        }
    }

    async function updateAiSession(sessionId, action) {
        if (isPwaMutationBlocked()) { showToast(readOnlyObserverReason(), 'warning'); return; }
        try {
            await requestJSON(`/ai/sessions/${sessionId}/${action}`, { method: 'POST' });
            showToast(action === 'stop' ? '신호 알림을 종료했습니다.' : `신호 알림을 ${action === 'pause' ? '일시정지' : '다시 시작'}했습니다`, 'success');
            await loadAiDesk(false);
        } catch (error) {
            showToast(`신호 알림 변경 실패: ${error.message}`, 'error');
        }
    }

    async function requestAiConsultation(eventId) {
        if (isPwaMutationBlocked()) { showToast(readOnlyObserverReason(), 'warning'); return; }
        const providers = $$('input[name="pilot-ai-provider"]:checked').map(input => input.value);
        const provider = providers.length === 2 ? 'both' : providers[0] || 'both';
        showToast('의견을 요청하고 있습니다…', 'info');
        try {
            const result = await requestJSON('/ai/consult', { method: 'POST', body: JSON.stringify({ eventId, provider }) });
            if (result?.consultation) handleAiConsultationUpdate(result.consultation);
            const consultationStatus = result?.consultation?.status;
            showToast(
                consultationStatus === 'COMPLETED'
                    ? '의견을 받았습니다.'
                    : consultationStatus === 'DEGRADED'
                        ? '서비스 응답을 받지 못해 확인된 정보만 표시했습니다.'
                        : '의견을 받지 못했습니다.',
                consultationStatus === 'COMPLETED' ? 'success' : 'warning'
            );
        } catch (error) {
            showToast(`의견 요청에 실패했습니다: ${error.message}`, 'error');
        }
    }

    function handleAiMonitoringEvent(event) {
        state.ai.events = [event, ...state.ai.events.filter(item => item.id !== event.id)].slice(0, 80);
        if (state.view === 'ai') renderAiEvents(state.ai.events);
        if (['BUY_SIGNAL', 'SELL_SIGNAL'].includes(event.type)) showToast(`자동매매 신호 · ${marketNameOrAll(event.coin)} ${aiEventLabels[event.type]}`, event.type === 'SELL_SIGNAL' ? 'error' : 'info');
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
                : '<p class="pilot-install-guide-note is-warning">이 주소에서는 설치할 수 없습니다. 보안 연결(HTTPS) 주소로 다시 여세요.</p>';
            const serviceWorkerNote = !isIos && !serviceWorkerSupported
                ? '<p class="pilot-install-guide-note is-warning">설치 상태를 확인할 수 없습니다. 브라우저 메뉴에서 설치 항목을 확인하세요.</p>'
                : serviceWorkerFailed
                    ? '<p class="pilot-install-guide-note is-warning">설치를 확인하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도하세요.</p>'
                    : '';
            const steps = isIos
                ? '<ol class="pilot-install-guide-steps"><li>Safari에서 CoinPilot을 엽니다.</li><li>공유 버튼을 누릅니다.</li><li>“홈 화면에 추가”를 선택합니다.</li></ol><p class="pilot-install-guide-note">홈 화면 아이콘으로 CoinPilot을 열 수 있습니다.</p>'
                : `<ol class="pilot-install-guide-steps"><li>${platformTitle} 브라우저의 주소창 또는 메뉴를 엽니다.</li><li>“앱 설치”, “CoinPilot 설치” 또는 “홈 화면에 추가”를 선택합니다.</li><li>설치가 끝나면 CoinPilot 아이콘을 엽니다.</li></ol><p class="pilot-install-guide-note">설치한 뒤에는 아이콘으로 CoinPilot을 열 수 있습니다.</p>`;
            showModal('CoinPilot 설치 방법', `<div class="pilot-install-guide"><div class="pilot-inline-note"><i class="ph ph-device-mobile" aria-hidden="true"></i><span>${platformTitle} 설치 방법</span></div>${secureContextNote}${serviceWorkerNote}${steps}</div>`);
        }

        const renderInstallState = (installed = isStandalone()) => {
            if (installed) {
                installState.hidden = true;
                installButton.hidden = true;
                return;
            }
            installState.hidden = false;
            if (!isSecureContext) {
                installState.textContent = 'HTTPS 필요';
                installState.className = 'pilot-status-pill is-warning pilot-pwa-state';
                installButton.hidden = false;
                installButton.textContent = '설치 방법';
                return;
            }
            if (isIos) {
                installState.textContent = '홈 화면에 추가';
                installState.className = 'pilot-status-pill is-warning pilot-pwa-state';
                installButton.hidden = false;
                installButton.textContent = '설치 방법';
                return;
            }
            if (!serviceWorkerSupported || serviceWorkerFailed) {
                installState.textContent = '설치 상태 확인 불가';
                installState.className = 'pilot-status-pill is-warning pilot-pwa-state';
                installButton.hidden = false;
                installButton.textContent = '설치 방법';
                return;
            }
            const installReady = Boolean(deferredInstallPrompt && serviceWorkerRegistration);
            installState.textContent = installReady ? '설치 가능' : serviceWorkerRegistration ? '설치 메뉴에서 추가' : '설치 확인 중';
            installState.className = `pilot-status-pill ${installReady ? 'is-ready' : 'is-warning'} pilot-pwa-state`;
            installButton.hidden = false;
            installButton.textContent = installReady ? '앱으로 설치' : '설치 방법';
        };

        renderInstallState();
        const refreshInstallState = () => renderInstallState();
        document.addEventListener('visibilitychange', refreshInstallState);
        window.addEventListener('pageshow', refreshInstallState);
        const showPwaUpdate = () => {
            if (!updateBanner || !serviceWorkerRegistration?.waiting || !navigator.serviceWorker?.controller) return;
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
            navigator.serviceWorker.register('/sw.js').then(registration => {
                serviceWorkerRegistration = registration;
                watchInstallingWorker(registration.installing);
                registration.addEventListener('updatefound', () => watchInstallingWorker(registration.installing));
                if (registration.waiting && navigator.serviceWorker.controller) showPwaUpdate();
                registration.update().then(updatedRegistration => {
                    if (updatedRegistration.waiting && navigator.serviceWorker.controller) showPwaUpdate();
                }).catch(() => { /* an offline shell can update on the next visit */ });
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
                        <div class="pilot-brand-lockup"><span class="pilot-brand-mark"><i class="ph ph-chart-line-up" aria-hidden="true"></i></span><span class="pilot-brand-name">CoinPilot</span></div>
                    </div>
                    <nav class="pilot-sidebar-nav" aria-label="주 메뉴">
                        <div class="pilot-nav-label">메뉴</div>
                        <button type="button" class="pilot-nav-button is-active" data-pilot-view="overview" aria-current="page"><i class="ph ph-chart-line-up" aria-hidden="true"></i><span>대시보드</span></button>
                        <button type="button" class="pilot-nav-button" data-pilot-view="trade"><i class="ph ph-hand-coins" aria-hidden="true"></i><span>거래</span></button>
                        <button type="button" class="pilot-nav-button" data-pilot-view="portfolio"><i class="ph ph-wallet" aria-hidden="true"></i><span>포트폴리오</span></button>
                        <button type="button" class="pilot-nav-button" data-pilot-view="market"><i class="ph ph-binoculars" aria-hidden="true"></i><span>시장 현황</span></button>
                        <button type="button" class="pilot-nav-button" data-pilot-view="analysis"><i class="ph ph-function" aria-hidden="true"></i><span>전략 분석</span></button>
                        <button type="button" class="pilot-nav-button" data-pilot-view="news"><i class="ph ph-newspaper" aria-hidden="true"></i><span>뉴스</span></button>
                        <div class="pilot-nav-label">관리</div>
                        <button type="button" class="pilot-nav-button" data-pilot-view="settings"><i class="ph ph-sliders-horizontal" aria-hidden="true"></i><span>설정</span></button>
                        <button type="button" class="pilot-nav-button" data-pilot-view="history"><i class="ph ph-clipboard-text" aria-hidden="true"></i><span>주문 전 점검</span></button>
                        <button type="button" class="pilot-nav-button pilot-mobile-more" id="pilot-mobile-more" aria-label="더보기" aria-haspopup="dialog" aria-expanded="false" aria-controls="pilot-mobile-menu"><i class="ph ph-list" aria-hidden="true"></i><span>더보기</span></button>
                    </nav>
                    <dialog class="pilot-mobile-menu" id="pilot-mobile-menu" aria-labelledby="pilot-mobile-menu-title" aria-modal="true">
                        <div class="pilot-mobile-menu-sheet">
                            <div class="pilot-mobile-menu-heading">
                                <div><span>메뉴</span><h2 id="pilot-mobile-menu-title">전체 메뉴</h2></div>
                                <button type="button" class="pilot-mobile-menu-close" data-pilot-mobile-close aria-label="전체 메뉴 닫기"><i class="ph ph-x" aria-hidden="true"></i></button>
                            </div>
                            <nav class="pilot-mobile-menu-nav" aria-label="추가 메뉴"></nav>
                        </div>
                    </dialog>

                </aside>

                <div class="pilot-main">
                    <header class="pilot-topbar">
                        <div class="pilot-mode-switch" role="group" aria-label="투자 모드">
                            <button type="button" class="pilot-mode-button is-active" data-pilot-mode="paper"><i class="ph ph-file-dashed" aria-hidden="true"></i><span>모의투자</span></button>
                            <button type="button" class="pilot-mode-button is-locked" data-pilot-mode="live"><i class="ph ph-lock-key" aria-hidden="true"></i><span>실거래</span></button>
                        </div>
                        <div class="pilot-top-meta"><span class="pilot-connection is-warn" id="pilot-connection"><span class="pilot-connection-dot"></span><span id="pilot-connection-label">연결 확인 중</span></span><span id="pilot-clock">-</span><div class="pilot-pwa-update" id="pilot-pwa-update" role="status" aria-live="polite" hidden><span class="pilot-visually-hidden">새 버전이 나왔습니다. 업데이트를 눌러 적용하세요.</span><button type="button" class="pilot-button is-small" data-pilot-action="reload-pwa" aria-label="새 버전 적용"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i><span aria-hidden="true">업데이트</span></button></div></div>
                    </header>

                        <section class="pilot-mode-banner" id="pilot-mode-banner" aria-live="polite">
                <div class="pilot-mode-banner-copy"><i class="ph ph-lock-key" aria-hidden="true"></i><div><strong id="pilot-mode-banner-title">실거래 주문 잠금</strong><span id="pilot-mode-banner-copy">실제 주문 전 점검을 마칠 때까지 주문할 수 없습니다.</span></div></div>
                            <div class="pilot-mode-banner-actions"><span class="pilot-status-pill is-warning pilot-pwa-state" id="pilot-pwa-state">설치 메뉴에서 추가</span><button type="button" class="pilot-button pilot-pwa-install" id="pilot-pwa-install">앱으로 설치</button><button type="button" class="pilot-button" data-pilot-go="history">주문 전 점검 보기 <i class="ph ph-arrow-right" aria-hidden="true"></i></button></div>
                        </section>
                        <section class="pilot-offline-banner pilot-auth-scope-banner" id="pilot-auth-scope-banner" role="status" aria-live="polite" hidden><i class="ph ph-shield-check" aria-hidden="true"></i><div><strong id="pilot-auth-scope-title"></strong><span id="pilot-auth-scope-copy"></span></div><button type="button" class="pilot-button is-small" id="pilot-auth-change-token" hidden>다른 토큰으로 접속</button></section>
                        <section class="pilot-offline-banner" id="pilot-offline-banner" role="status" aria-live="polite" hidden><i class="ph ph-cloud-slash" aria-hidden="true"></i><div><strong>오프라인 모드</strong><span>계좌와 시세를 불러올 수 없습니다. 연결이 복구될 때까지 주문과 설정을 사용할 수 없습니다.</span></div><button type="button" class="pilot-button is-small" data-pilot-action="refresh-core">다시 연결</button></section>
                        <section class="pilot-pending-mutation" id="pilot-pending-mutation" role="status" aria-live="polite" hidden><i class="ph ph-clock-countdown" aria-hidden="true"></i><div><strong id="pilot-pending-mutation-title">요청 결과 확인 필요</strong><span id="pilot-pending-mutation-copy">요청이 처리됐을 수 있어 새 주문과 가상 지갑 변경을 잠갔습니다.</span></div><button type="button" class="pilot-button is-small" id="pilot-pending-mutation-retry" data-pilot-action="retry-pending-mutation" hidden>같은 요청 결과 다시 확인</button></section>

                    <main class="pilot-content">
                        <section class="pilot-page is-active" data-pilot-page="overview">
                            <div class="pilot-page-heading"><div><h1 class="pilot-page-title">대시보드</h1></div><div class="pilot-heading-actions"><span class="pilot-sync-note" id="pilot-overview-sync">마지막 동기화 -</span><button type="button" class="pilot-button" data-pilot-action="refresh-core"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> 새로고침</button></div></div>
                            <div class="pilot-overview-lead">
                                <section class="pilot-overview-balance" aria-labelledby="pilot-overview-assets-title">
                                    <span class="pilot-overview-balance-eyebrow">계좌 가치</span>
                                    <h2 class="pilot-overview-balance-title" id="pilot-overview-assets-title">총 자산 평가액</h2>
                                    <strong class="pilot-overview-balance-value" id="pilot-total-assets">-</strong>
                                    <span class="pilot-overview-balance-caption" id="pilot-total-assets-caption">-</span>
                                    <div class="pilot-stat-strip pilot-overview-supporting-stats" aria-label="추가 성과 지표">
                                        <div class="pilot-stat-cell"><span class="pilot-stat-label">오늘의 손익</span><strong class="pilot-stat-value" id="pilot-today-profit">-</strong><span class="pilot-stat-caption" id="pilot-today-profit-caption">-</span></div>
                                        <div class="pilot-stat-cell"><span class="pilot-stat-label">누적 손익</span><strong class="pilot-stat-value" id="pilot-cumulative-profit">-</strong><span class="pilot-stat-caption" id="pilot-cumulative-profit-caption">-</span></div>
                                        <div class="pilot-stat-cell"><span class="pilot-stat-label">승률</span><strong class="pilot-stat-value" id="pilot-win-rate">-</strong><span class="pilot-stat-caption" id="pilot-trade-count-caption">-</span></div>
                                    </div>
                                </section>
                                <aside class="pilot-overview-next" aria-labelledby="pilot-overview-next-title">
                                    <span class="pilot-overview-next-eyebrow">다음 단계</span>
                                    <h2 class="pilot-overview-next-title" id="pilot-overview-next-title">주문 전 점검</h2>
                                    <p class="pilot-overview-next-copy">주문 조건과 모의투자·시세 상태를 한 곳에서 확인합니다.</p>
                                    <button type="button" class="pilot-button is-primary pilot-overview-next-action" data-pilot-go="history">점검 상태 살펴보기 <i class="ph ph-arrow-right" aria-hidden="true"></i></button>
                                    <ul class="pilot-overview-readiness" aria-label="현재 상태">
                                        <li class="pilot-overview-readiness-row"><span class="pilot-gate-icon" id="pilot-gate-validation-icon"><i class="ph ph-check" aria-hidden="true"></i></span><span><strong class="pilot-gate-title">주문 전 점검</strong><span class="pilot-gate-detail" id="pilot-gate-validation-detail">확인 중</span></span></li>
                                        <li class="pilot-overview-readiness-row"><span class="pilot-gate-icon is-pending" id="pilot-gate-paper-icon"><i class="ph ph-hourglass-medium" aria-hidden="true"></i></span><span><strong class="pilot-gate-title">모의투자</strong><span class="pilot-gate-detail" id="pilot-gate-paper-detail">실행 상태 확인 중</span></span></li>
                                        <li class="pilot-overview-readiness-row"><span class="pilot-gate-icon is-pending" id="pilot-gate-freshness-icon"><i class="ph ph-database" aria-hidden="true"></i></span><span><strong class="pilot-gate-title">데이터 최신성</strong><span class="pilot-gate-detail" id="pilot-gate-freshness-detail">수집 상태 확인 중</span></span></li>
                                    </ul>
                                </aside>
                            </div>
                            <section class="pilot-panel pilot-overview-chart"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">자산 추이</h2></div><div class="pilot-chart-toolbar"><div class="pilot-chart-legend"><span><i class="pilot-legend-dot"></i>총 자산 평가액</span><span><i class="pilot-legend-dot is-muted"></i>시작 자산</span></div><div class="pilot-range-tabs"><button type="button" class="pilot-tab-button" data-pilot-chart-period="1h">1시간</button><button type="button" class="pilot-tab-button is-active" data-pilot-chart-period="24h">1일</button><button type="button" class="pilot-tab-button" data-pilot-chart-period="7d">1주</button><button type="button" class="pilot-tab-button" data-pilot-chart-period="30d">1개월</button></div></div></div><div class="pilot-chart-wrap"><canvas id="pilot-equity-chart" class="pilot-chart-canvas" aria-label="총 자산 평가액 추이 차트"></canvas><div class="pilot-chart-empty" id="pilot-equity-empty" hidden>자산 기록이 없습니다.</div></div><div class="pilot-chart-footnote"><span id="pilot-equity-period-label">24시간 기준</span><span id="pilot-equity-source-label">-</span></div></section>
                            <div class="pilot-section-spacer"></div>
                            <section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">보유 포지션</h2></div><button type="button" class="pilot-link-button" data-pilot-view="portfolio">전체 포트폴리오 보기 <i class="ph ph-arrow-right" aria-hidden="true"></i></button></div><div class="pilot-table-wrap"><table class="pilot-table"><thead><tr><th>자산</th><th class="pilot-table-number">수량</th><th class="pilot-table-number">평균 진입가</th><th class="pilot-table-number">현재가</th><th class="pilot-table-number">평가액</th><th class="pilot-table-number">평가손익</th><th>상태</th></tr></thead><tbody id="pilot-overview-positions"></tbody></table></div></section>
                            <div class="pilot-section-spacer"></div>
                            <div class="pilot-split-grid"><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">최근 거래</h2><p class="pilot-panel-subtitle">서버에 저장된 거래 기록</p></div><button type="button" class="pilot-link-button" data-pilot-view="history">전체 기록 <i class="ph ph-arrow-right" aria-hidden="true"></i></button></div><div class="pilot-panel-body"><div class="pilot-evidence-list" id="pilot-activity-list"></div></div></section><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">리스크 상태</h2></div><i class="ph ph-shield-check" style="color: var(--sl-green); font-size: 21px;" aria-hidden="true"></i></div><div class="pilot-panel-body" id="pilot-risk-summary"></div></section></div>
                        </section>

                        <section class="pilot-page" data-pilot-page="trade"><div class="pilot-page-heading"><div><h1 class="pilot-page-title">거래</h1></div><div class="pilot-heading-actions"><span class="pilot-sync-note" id="pilot-trade-sync">-</span><button type="button" class="pilot-button" data-pilot-action="refresh-core"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> 잔액 새로고침</button></div></div><div class="pilot-split-grid">${tradePanelMarkup('trade')}<section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">조건에 따른 매매</h2></div><span class="pilot-status-pill">모의투자 전용</span></div><div class="pilot-panel-body"><div class="pilot-inline-note"><i class="ph ph-info" aria-hidden="true"></i><span>거래대금이 많은 시장에서 매수 점수가 높은 자산부터 매수합니다.</span></div><div class="pilot-section-spacer"></div><div class="pilot-wallet-action"><h3>조건 매수</h3><label class="pilot-field"><span class="pilot-field-label">총 투자금액 <span class="pilot-field-hint" id="pilot-smart-buy-balance">사용 가능 잔액 -</span></span><input class="pilot-input" type="number" id="pilot-smart-buy-amount" min="5000" step="1000" value="100000"></label><div class="pilot-field-row" style="margin-top:9px"><label class="pilot-field"><span class="pilot-field-label">최소 점수</span><input class="pilot-input" type="number" id="pilot-smart-buy-score" min="0" max="100" value="60"></label><label class="pilot-field"><span class="pilot-field-label">최대 종목</span><input class="pilot-input" type="number" id="pilot-smart-buy-max" min="1" max="30" value="10"></label></div><button type="button" class="pilot-button is-success" style="width:100%; margin-top:12px" data-pilot-action="smart-buy"><i class="ph ph-stack" aria-hidden="true"></i> 조건 매수 실행</button></div><div class="pilot-section-spacer"></div><div class="pilot-wallet-action"><h3>정해진 기준으로 매도</h3><label class="pilot-field"><span class="pilot-field-label">목표 매도금액 <span class="pilot-field-hint" id="pilot-smart-sell-holding">보유 평가액 -</span></span><input class="pilot-input" type="number" id="pilot-smart-sell-amount" min="1000" step="1000" value="100000"></label><label class="pilot-field" style="margin-top:9px"><span class="pilot-field-label">매도 우선순위</span><select class="pilot-select" id="pilot-smart-sell-strategy"><option value="worst">손실 큰 자산부터</option><option value="best">수익 큰 자산부터</option><option value="overbought">RSI 과매수 자산부터</option></select></label><button type="button" class="pilot-button is-danger" style="width:100%; margin-top:12px" data-pilot-action="smart-sell"><i class="ph ph-arrow-circle-down" aria-hidden="true"></i> 우선순위 매도 실행</button></div></div></section></div><div class="pilot-section-spacer"></div><div class="pilot-split-grid"><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">매수 검토</h2></div><button type="button" class="pilot-button is-small" data-pilot-action="load-recommendations">분석 새로고침</button></div><div class="pilot-panel-body"><div id="pilot-buy-recommendations" class="pilot-evidence-list"><div class="pilot-inline-empty">분석을 새로고침하면 매수 검토 결과가 표시됩니다.</div></div></div></section><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">매도 검토</h2></div><div class="pilot-panel-body"><div id="pilot-sell-recommendations" class="pilot-evidence-list"><div class="pilot-inline-empty">분석을 새로고침하면 매도 검토 결과가 표시됩니다.</div></div></div></section></div></section>

                        <section class="pilot-page" data-pilot-page="portfolio"><div class="pilot-page-heading"><div><h1 class="pilot-page-title">포트폴리오</h1></div><div class="pilot-heading-actions"><button type="button" class="pilot-button" data-pilot-action="refresh-core"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> 새로고침</button></div></div><div class="pilot-history-summary"><div class="pilot-history-metric"><span>총 자산 평가액</span><strong id="pilot-portfolio-assets">-</strong></div><div class="pilot-history-metric"><span>누적 손익</span><strong id="pilot-portfolio-profit">-</strong></div><div class="pilot-history-metric"><span>현금 잔액</span><strong id="pilot-portfolio-cash">-</strong></div><div class="pilot-history-metric"><span>보유 종목</span><strong id="pilot-portfolio-count">-</strong></div></div><div class="pilot-split-grid" id="pilot-portfolio-allocation-grid"><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">자산 구성</h2></div></div><div class="pilot-panel-body" style="display:grid; grid-template-columns:170px minmax(0,1fr); gap:22px; align-items:center"><canvas id="pilot-allocation-chart" style="width:170px;height:170px" aria-label="자산 구성 차트"></canvas><div id="pilot-allocation-legend"></div></div></section><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">계좌 요약</h2></div></div><div class="pilot-panel-body" id="pilot-account-summary"></div></section></div><div class="pilot-section-spacer"></div><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">자산 추이</h2></div><div class="pilot-range-tabs"><button type="button" class="pilot-tab-button" data-pilot-portfolio-period="1h">1시간</button><button type="button" class="pilot-tab-button is-active" data-pilot-portfolio-period="24h">1일</button><button type="button" class="pilot-tab-button" data-pilot-portfolio-period="7d">1주</button><button type="button" class="pilot-tab-button" data-pilot-portfolio-period="30d">1개월</button></div></div><div class="pilot-chart-wrap"><canvas id="pilot-portfolio-chart" class="pilot-chart-canvas" aria-label="포트폴리오 자산 추이"></canvas><div class="pilot-chart-empty" id="pilot-portfolio-empty" hidden>자산 추이를 수집 중입니다.</div></div><div class="pilot-chart-footnote"><span id="pilot-portfolio-history-source-label">-</span></div></section><div class="pilot-section-spacer"></div><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">보유 포지션 상세</h2></div></div><div class="pilot-table-wrap"><table class="pilot-table"><thead><tr><th>자산</th><th class="pilot-table-number">수량</th><th class="pilot-table-number">평단</th><th class="pilot-table-number">현재가</th><th class="pilot-table-number">평가액</th><th class="pilot-table-number">평가손익</th><th>관리</th></tr></thead><tbody id="pilot-portfolio-positions"></tbody></table></div></section><div class="pilot-section-spacer"></div><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">모의투자 지갑</h2></div><span class="pilot-status-pill" id="pilot-wallet-mode">모의투자 전용</span></div><div class="pilot-panel-body"><div class="pilot-wallet"><div class="pilot-wallet-action"><h3>입금</h3><div class="pilot-wallet-action-row"><input class="pilot-input" type="number" id="pilot-deposit-amount" min="1000" step="1000" placeholder="금액 (원)"><button type="button" class="pilot-button is-success" data-pilot-action="deposit">입금</button></div><div class="pilot-wallet-presets"><button type="button" class="pilot-filter-chip" data-pilot-deposit="100000">+10만</button><button type="button" class="pilot-filter-chip" data-pilot-deposit="500000">+50만</button><button type="button" class="pilot-filter-chip" data-pilot-deposit="1000000">+100만</button></div></div><div class="pilot-wallet-action"><h3>출금</h3><div class="pilot-wallet-action-row"><input class="pilot-input" type="number" id="pilot-withdraw-amount" min="1000" step="1000" placeholder="금액 (원)"><button type="button" class="pilot-button is-danger" data-pilot-action="withdraw">출금</button></div><div class="pilot-wallet-presets"><button type="button" class="pilot-filter-chip" data-pilot-withdraw="100000">-10만</button><button type="button" class="pilot-filter-chip" data-pilot-withdraw="500000">-50만</button></div></div></div><div class="pilot-inline-note" style="margin-top:10px"><i class="ph ph-warning" aria-hidden="true"></i><span>초기화하면 보유 코인과 전략별 포지션·매매 기록이 사라집니다.</span><button type="button" class="pilot-button is-small" data-pilot-action="reset-wallet">모의 계좌 초기화</button></div></div></section></section>

                        <section class="pilot-page" data-pilot-page="market"><div class="pilot-page-heading"><div><h1 class="pilot-page-title">시장 현황</h1></div><div class="pilot-heading-actions"><label class="pilot-field" style="min-width:200px"><span class="pilot-visually-hidden">시장 검색</span><input class="pilot-input pilot-market-search" id="pilot-market-search" type="search" placeholder="시장 검색 (BTC, ETH)"></label><button type="button" class="pilot-button" data-pilot-action="refresh-market"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> 시세 새로고침</button></div></div><div class="pilot-market-layout"><section class="pilot-panel"><div class="pilot-market-quote"><div><span class="pilot-market-symbol" id="pilot-market-symbol">BTC/KRW</span><span class="pilot-market-name" id="pilot-market-name">업비트 원화 시장</span><span class="pilot-market-status" id="pilot-market-status">시세 확인 중</span><span class="pilot-visually-hidden" id="pilot-market-status-announcement" role="status" aria-live="polite" aria-atomic="true"></span><span class="pilot-visually-hidden" id="pilot-market-refresh-announcement" role="status" aria-live="polite" aria-atomic="true"></span></div><div><span class="pilot-market-price" id="pilot-market-price">-</span><span class="pilot-market-change" id="pilot-market-change">-</span></div></div><div class="pilot-market-time-meta"><div class="pilot-market-time-item"><span class="pilot-market-time-label">최근 체결 시각</span><span class="pilot-market-time-value" id="pilot-market-source-asof">시각 정보 미제공</span></div><div class="pilot-market-time-item"><span class="pilot-market-time-label">서버 시세 수집 시각</span><span class="pilot-market-time-value" id="pilot-market-fetched-at">시각 정보 미제공</span></div></div><div class="pilot-market-metrics"><div><span class="pilot-market-metric-label">24시간 고가</span><strong class="pilot-market-metric-value" id="pilot-market-high">-</strong></div><div><span class="pilot-market-metric-label">24시간 저가</span><strong class="pilot-market-metric-value" id="pilot-market-low">-</strong></div><div><span class="pilot-market-metric-label">거래대금</span><strong class="pilot-market-metric-value" id="pilot-market-volume">-</strong></div><div><span class="pilot-market-metric-label">보유 평가</span><strong class="pilot-market-metric-value" id="pilot-market-holding">-</strong></div></div><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">가격 차트</h2></div><div class="pilot-market-toolbar"><div class="pilot-market-control-group" role="group" aria-label="캔들 간격"><button type="button" class="pilot-market-interval" data-pilot-candle-interval="1" aria-pressed="false">1분</button><button type="button" class="pilot-market-interval is-active" data-pilot-candle-interval="5" aria-pressed="true">5분</button><button type="button" class="pilot-market-interval" data-pilot-candle-interval="15" aria-pressed="false">15분</button><button type="button" class="pilot-market-interval" data-pilot-candle-interval="60" aria-pressed="false">1시간</button></div><div class="pilot-market-control-group" role="group" aria-label="표시 캔들 수"><button type="button" class="pilot-market-range" data-pilot-candle-range="30" aria-pressed="false">30개</button><button type="button" class="pilot-market-range is-active" data-pilot-candle-range="60" aria-pressed="true">60개</button><button type="button" class="pilot-market-range" data-pilot-candle-range="100" aria-pressed="false">100개</button></div></div></div><div class="pilot-market-chart-wrap"><canvas id="pilot-market-chart" class="pilot-market-chart" aria-label="선택한 시장 캔들 차트"></canvas><div class="pilot-chart-empty" id="pilot-market-empty" hidden>캔들 데이터를 불러오는 중입니다.</div></div><div class="pilot-market-candle-status" id="pilot-market-candle-status" hidden></div><details class="pilot-market-candle-data" id="pilot-market-candle-data" hidden><summary>최근 캔들 값</summary><p class="pilot-market-candle-data-note" id="pilot-market-candle-data-note"></p><div class="pilot-market-data-table-wrap" id="pilot-market-data-table"></div></details></section>${tradePanelMarkup('market')}</div><div class="pilot-section-spacer"></div><section class="pilot-panel"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">시장 목록</h2></div><div class="pilot-filter-bar"><select class="pilot-select" style="width:auto" id="pilot-market-sort"><option value="volume">거래대금순</option><option value="change_desc">상승률순</option><option value="change_asc">하락률순</option><option value="name">이름순</option></select></div></div><div class="pilot-market-list" id="pilot-market-list"></div></section></section>

                        <section class="pilot-page" data-pilot-page="analysis"><div class="pilot-page-heading"><div><h1 class="pilot-page-title">전략 분석</h1></div><div class="pilot-heading-actions"><select class="pilot-select" style="width:auto" id="pilot-analysis-filter"><option value="all">전체 결과</option><option value="BUY">매수</option><option value="SELL">매도</option><option value="HOLD">관망</option></select><select class="pilot-select" style="width:auto" id="pilot-analysis-sort"><option value="score">총점순</option><option value="buy">매수점수순</option><option value="sell">매도점수순</option><option value="volume">거래대금순</option><option value="change">변동률순</option></select><button type="button" class="pilot-button" data-pilot-action="load-analysis"><i class="ph ph-play" aria-hidden="true"></i> 분석 실행</button></div></div><section class="pilot-panel"><div class="pilot-analysis-summary"><div class="pilot-analysis-stat"><strong id="pilot-analysis-total">—</strong><span>분석한 종목</span></div><div class="pilot-analysis-stat is-buy"><strong id="pilot-analysis-buy">—</strong><span>매수 판정</span></div><div class="pilot-analysis-stat is-sell"><strong id="pilot-analysis-sell">—</strong><span>매도 판정</span></div><div class="pilot-analysis-stat is-watch"><strong id="pilot-analysis-hold">—</strong><span>관망</span></div><div class="pilot-analysis-stat"><strong id="pilot-analysis-strong">—</strong><span>강한 신호</span></div></div><div class="pilot-analysis-table pilot-table-wrap"><table class="pilot-table"><thead><tr><th>자산</th><th class="pilot-table-number">현재가</th><th class="pilot-table-number">24시간 변동</th><th class="pilot-table-number">RSI</th><th>MACD</th><th class="pilot-table-number">신호 점수 (0~100)</th><th>판정</th><th>관리</th></tr></thead><tbody id="pilot-analysis-rows"></tbody></table></div></section></section>

                        <section class="pilot-page" data-pilot-page="news"><div class="pilot-page-heading"><div><h1 class="pilot-page-title">뉴스</h1></div><div class="pilot-heading-actions"><select class="pilot-select" style="width:auto" id="pilot-news-filter"><option value="all">전체 감성</option><option value="positive">긍정</option><option value="negative">부정</option><option value="neutral">중립</option></select><button type="button" class="pilot-button" data-pilot-action="load-news"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> 뉴스 새로고침</button></div></div><section class="pilot-panel"><div class="pilot-news-sentiment"><div class="pilot-sentiment-score is-neutral" id="pilot-news-score">-</div><div><div class="pilot-sentiment-title" id="pilot-news-sentiment-title">기사 분석 전</div><div class="pilot-sentiment-description" id="pilot-news-sentiment-copy">새로고침을 누르면 최신 기사를 분석합니다.</div></div><span class="pilot-status-pill is-warning">참고 정보</span></div><div class="pilot-news-list" id="pilot-news-list"><div class="pilot-inline-empty">뉴스 새로고침을 눌러 최신 기사를 확인하세요.</div></div></section></section>

                        <section class="pilot-page" data-pilot-page="settings"><div class="pilot-page-heading"><div><h1 class="pilot-page-title">거래 설정</h1></div><div class="pilot-heading-actions"><button type="button" class="pilot-button" data-pilot-action="reload-settings"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> 서버에서 다시 불러오기</button><button type="button" class="pilot-button is-primary" data-pilot-action="save-settings"><i class="ph ph-check" aria-hidden="true"></i> 변경 사항 적용</button></div></div><div class="pilot-settings-grid"><div><section class="pilot-panel pilot-settings-section"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">설정 후보 비교</h2><p class="pilot-panel-subtitle">비교 결과는 현재 설정이나 실거래 조건에 반영되지 않습니다.</p></div><span class="pilot-status-pill is-warning" id="pilot-optimization-status">확인 중</span></div><div class="pilot-panel-body" id="pilot-optimization-controls"></div></section><div class="pilot-section-spacer"></div><section class="pilot-panel pilot-settings-section"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">투자 성향</h2><p class="pilot-panel-subtitle">선택하면 현재 전략 설정이 바뀝니다. 성향 단계는 현재 계좌 위험도 평가값이 아닙니다.</p></div></div><div class="pilot-panel-body"><div class="pilot-preset-grid" id="pilot-preset-grid"><div class="pilot-inline-empty">설정을 불러오는 중입니다.</div></div></div></section></div><section class="pilot-panel pilot-settings-section"><div class="pilot-panel-header"><div><h2 class="pilot-panel-title">전략과 위험 관리</h2><p class="pilot-panel-subtitle">바꾼 설정은 변경 사항 적용을 눌러 저장하세요.</p></div></div><div class="pilot-panel-body"><div class="pilot-settings-list" id="pilot-settings-list"><div class="pilot-inline-empty">설정을 불러오는 중입니다.</div></div></div></section></div></section>

                        <section class="pilot-page" data-pilot-page="history">
                            <div class="pilot-page-heading">
                                <div><h1 class="pilot-page-title">실제 주문 전 점검</h1></div>
                                <div class="pilot-heading-actions"><button type="button" class="pilot-button" data-pilot-action="refresh-history"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> 새로고침</button></div>
                            </div>
                            <section class="pilot-panel">
                                <div class="pilot-panel-header"><div><h2 class="pilot-panel-title">전략 점검</h2><p class="pilot-panel-subtitle" id="pilot-validation-meta">점검 결과를 불러오는 중</p></div><span class="pilot-status-pill is-warning" id="pilot-validation-status-pill">확인 중</span></div>
                                <div id="pilot-validation-detail"></div>
                            </section>
                            <div class="pilot-section-spacer"></div>
                            <section class="pilot-panel pilot-quote-cost-panel">
                                <div class="pilot-panel-header">
                                    <div><h2 class="pilot-panel-title">호가와 거래 비용</h2><p class="pilot-panel-subtitle" id="pilot-quote-cost-meta">호가 자료를 확인하는 중</p></div>
                                    <span class="pilot-status-pill is-warning" id="pilot-quote-cost-status">확인 중</span>
                                </div>
                                <div id="pilot-quote-cost-detail"><div class="pilot-inline-empty">호가 자료를 확인하는 중입니다.</div></div>
                            </section>
                            <div class="pilot-section-spacer"></div>
                            <section class="pilot-panel">
                                <div class="pilot-panel-header"><div><h2 class="pilot-panel-title">모의투자 실행</h2><p class="pilot-panel-subtitle" id="pilot-paper-meta">실행 상태 확인 중</p></div><div class="pilot-heading-actions"><button type="button" class="pilot-button is-small" data-pilot-action="start-paper">모의투자 시작</button><button type="button" class="pilot-button is-small is-danger" data-pilot-action="stop-paper">모의투자 중지</button></div></div>
                                <div class="pilot-paper-status" id="pilot-paper-detail"></div>
                            </section>
                        </section>
                    </main>
                    <footer class="pilot-footer"><span><strong>CoinPilot</strong></span></footer>
                </div>
            </div>
            <div class="pilot-toast-stack" id="pilot-toast-stack" aria-live="polite" aria-atomic="true"></div>
            <div id="pilot-modal-root"></div>
        `;
    }

    function mountPageEnhancements() {
        const settingsPage = root.querySelector('[data-pilot-page="settings"]');
        const settingsGrid = settingsPage?.querySelector('.pilot-settings-grid');
        if (settingsGrid) settingsGrid.id = 'pilot-settings-grid';
        const settingsHeading = settingsPage?.querySelector('.pilot-page-heading');
        if (settingsHeading && !settingsPage.querySelector('#pilot-settings-error')) {
            settingsHeading.insertAdjacentHTML('afterend', '<div id="pilot-settings-error" class="pilot-settings-error" role="status" hidden></div>');
        }
        const analysisPage = root.querySelector('[data-pilot-page="analysis"]');
        const analysisPanel = analysisPage?.querySelector('.pilot-panel');
        if (analysisPanel && !analysisPanel.querySelector('.pilot-analysis-advisory')) {
            analysisPanel.insertAdjacentHTML('afterbegin', '<div class="pilot-inline-note pilot-analysis-advisory"><i class="ph ph-info" aria-hidden="true"></i><span>분석 신호는 주문을 실행하지 않습니다.</span></div>');
        }
        if (analysisPage && !analysisPage.querySelector('.pilot-analysis-research-panels')) {
            analysisPage.insertAdjacentHTML('beforeend', `
                <div class="pilot-analysis-research-panels">
                    <section class="pilot-panel pilot-strategy-research-panel">
                        <div class="pilot-panel-header"><div><h2 class="pilot-panel-title">과거 전략 비교</h2><p class="pilot-panel-subtitle" id="pilot-strategy-research-meta">과거 시장 자료로 전략 결과를 비교합니다.</p></div><span class="pilot-status-pill is-warning">참고용</span></div>
                        <div id="pilot-strategy-research"><div class="pilot-inline-empty">비교 자료를 불러오는 중입니다.</div></div>
                    </section>
                    <section class="pilot-panel pilot-momentum-shadow-panel">
                        <div class="pilot-panel-header"><div><h2 class="pilot-panel-title">일봉 모의투자 성과</h2><p class="pilot-panel-subtitle" id="pilot-momentum-shadow-meta">완료 일봉 가격 모델 · 실제 체결·정산은 증명되지 않습니다.</p></div><span class="pilot-status-pill is-warning" id="pilot-momentum-shadow-status">연구 전용</span></div>
                        <div id="pilot-momentum-shadow"><div class="pilot-inline-empty">모의투자 성과를 불러오는 중입니다.</div></div>
                    </section>
                </div>`);
        }
    }

    window.addEventListener('storage', event => {
        if (event.key === manualMutationClient.storageKey || event.key === null) {
            state.pendingMutation = manualMutationClient.refresh();
        }
    });

    renderShell();
    renderPendingMutationBanner();
    mountAiDesk();
    mountMobileNavigation();
    mountPageEnhancements();
    syncAuthScopeNotice();
    syncObserverControls();
    byId('pilot-auth-change-token')?.addEventListener('click', () => {
        authClient?.requestLogin?.('브라우저 대시보드용 토큰을 입력해 주세요.');
    });
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
            setText('pilot-connection-label', '오프라인 · 상태를 갱신할 수 없음');
            return;
        }
        const runtimeMessage = runtimeBlockReason();
        if (runtimeMessage && (state.status?.runtimeState === 'SYNC_REQUIRED' || state.status?.exchangeStateKnown === false)) {
            connection.classList.add('is-warn');
            connection.classList.remove('is-error');
            setText('pilot-connection-label', '거래소 상태 확인 중');
            return;
        }
        if (runtimeMessage && state.status?.runtimeState === 'PROTECTIVE_ONLY') {
            connection.classList.add('is-warn');
            connection.classList.remove('is-error');
            setText('pilot-connection-label', '위험 감시 전용');
            return;
        }
        if (runtimeMessage && state.status?.isRunning === false) {
            connection.classList.add('is-warn');
            connection.classList.remove('is-error');
            setText('pilot-connection-label', '매매 중지');
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
        const modeKnown = ['DRY_RUN', 'LIVE'].includes(state.actualMode);
        const liveReady = state.actualMode === 'LIVE' && state.liveEligible;
        const offline = state.online === false;
        const corePending = !offline && state.coreReady !== true;
        const protectiveOnly = state.status?.runtimeState === 'PROTECTIVE_ONLY';
        const exchangeStateUnknown = state.status?.runtimeState === 'SYNC_REQUIRED' || state.status?.exchangeStateKnown === false;
        const runtimeBlocked = !runtimeCanAcceptOrders(state.status);
        const bannerPresentation = getModeBannerPresentation({
            paper,
            modeKnown,
            liveReady,
            offline,
            readOnly: isReadOnlyObserver(),
            protectiveOnly,
            exchangeStateUnknown,
            evidenceLocked: isPaperEvidenceMutationLocked(),
            corePending,
            runtimeBlocked,
            manualOrdersAllowed: canTrade(),
            runtimeReason: runtimeBlockReason(),
            readOnlyReason: readOnlyObserverReason(),
            coreReadinessReason: coreTradingReadinessReason(),
            tradeReason: tradeBlockReason()
        });
        $$('[data-pilot-mode]').forEach(button => {
            const mode = button.dataset.pilotMode;
            button.classList.toggle('is-active', modeKnown && mode === state.activeMode);
            button.classList.toggle('is-locked', mode === 'live' && !liveReady);
            button.disabled = !modeKnown;
            button.setAttribute('aria-pressed', modeKnown && mode === state.activeMode ? 'true' : 'false');
        });

        const banner = byId('pilot-mode-banner');
        const bannerIcon = banner?.querySelector('.pilot-mode-banner-copy > i');
        banner?.classList.toggle('is-live', bannerPresentation.isLive);
        if (bannerIcon) bannerIcon.className = `ph ph-${bannerPresentation.icon}`;
        setText('pilot-mode-banner-title', bannerPresentation.title);
        setText('pilot-mode-banner-copy', bannerPresentation.copy);
        renderOfflineBanner();
    }

    function renderGateIcon(id, tone, icon) {
        const element = byId(id);
        if (!element) return;
        element.className = `pilot-gate-icon${tone ? ` is-${tone}` : ''}`;
        element.innerHTML = `<i class="ph ph-${icon}" aria-hidden="true"></i>`;
    }

    function renderGateCards() {
        const readiness = classifyReadiness(state.strategyReadiness);
        const ready = readiness.stateLabel === '통과';
        const blocked = readiness.stateLabel === '보류';
        setText('pilot-gate-validation-detail', ready ? '점검 통과' : blocked ? '주문 조건 미충족' : '확인 필요');
        renderGateIcon('pilot-gate-validation-icon', ready ? '' : blocked ? 'blocked' : 'pending', ready ? 'check' : 'warning');

        const paper = state.paper;
        const paperState = paper?.state || (paper?.active ? 'RUNNING' : 'STOPPED');
        const paperNotStarted = paper?.available === false && paper?.reason === 'paper_validation_session_not_started';
        const paperKnown = paper?.available === true || paperNotStarted;
        const paperStatePresentation = {
            PASS: { label: '완료', tone: '', icon: 'check' },
            RUNNING: { label: '진행 중', tone: 'pending', icon: 'hourglass-medium' },
            STOPPED: { label: '중지됨', tone: 'neutral', icon: 'pause' }
        }[paperState] || null;
        const paperStatusKnown = paperKnown && paperStatePresentation !== null;
        const paperDetail = paperNotStarted
            ? '실행 기록 없음 · 시작 가능'
            : !paperStatusKnown
                ? '상태 확인 필요'
                : `${paperStatePresentation.label} · 청산 ${number(paper.closedTradeCount)}회`;
        const paperTone = paperStatusKnown ? paperStatePresentation.tone : 'blocked';
        const paperIcon = paperStatusKnown ? paperStatePresentation.icon : 'warning';
        setText('pilot-gate-paper-detail', paperDetail);
        renderGateIcon('pilot-gate-paper-icon', paperTone, paperIcon);

        const protectiveOnly = state.status?.runtimeState === 'PROTECTIVE_ONLY';
        const marketPresentation = marketSnapshotPresentation(state.marketSnapshot, state.marketPricesLoaded, state.marketPrices);
        const marketNeedsReview = marketPresentation.state !== 'complete';
        const marketWarning = marketPresentation.state === 'partial'
            ? '일부 시세 확인 필요'
            : marketPresentation.state === 'stale'
                ? '시세 최신 여부 확인 필요'
                : '시세 상태 확인 필요';
        const dataProblem = protectiveOnly || marketNeedsReview || paper?.orphaned === true || paper?.analysisDataHealth?.failClosed === true || paper?.riskMonitor?.failClosed === true;
        setText('pilot-gate-freshness-detail', protectiveOnly
            ? '보호 감시 전용 · 신규 진입 잠금'
            : marketNeedsReview ? marketWarning
                : paperNotStarted ? '모의투자 시작 후 확인' : !paperKnown || dataProblem ? '데이터 확인 필요' : '데이터 정상');
        renderGateIcon('pilot-gate-freshness-icon', dataProblem ? 'blocked' : !paperKnown ? 'pending' : '', dataProblem || !paperKnown ? 'warning' : 'database');
    }

    function renderChartPeriodButtons() {
        $$('[data-pilot-chart-period]').forEach(button => button.classList.toggle('is-active', button.dataset.pilotChartPeriod === state.chartPeriod));
        $$('[data-pilot-portfolio-period]').forEach(button => button.classList.toggle('is-active', button.dataset.pilotPortfolioPeriod === state.chartPeriod));
        setText('pilot-equity-period-label', `${state.chartPeriod === '24h' ? '24시간' : state.chartPeriod} 기준`);
    }

    function portfolioHistorySourceLabel() {
        const history = Array.isArray(state.portfolioHistory) ? state.portfolioHistory : [];
        const unknownCount = history.filter(point => point?.valuationStatus === 'unknown_legacy').length;
        if (state.portfolioHistoryError) {
            return history.length
                ? `이전 기록 ${history.length}개 · 새로고침 실패`
                : '기록 불러오기 실패';
        }
        if (!history.length) return '기록 없음';
        return unknownCount > 0
            ? `${history.length}개 기록 · 과거 평가 근거 미확인 ${unknownCount}개`
            : `${history.length}개 기록`;
    }

    function renderCoreStats() {
        const account = state.account || {};
        const pnl = state.pnl || {};
        const today = state.today || {};
        const paper = state.paper || {};
        const observer = isReadOnlyObserver();
        const paperLedgerVisible = paper.available === true;
        const totalAssets = observer
            ? hasFiniteValue(account.totalAssets) ? Number(account.totalAssets) : null
            : hasFiniteValue(account.totalAssets) ? Number(account.totalAssets)
                : hasFiniteValue(pnl.totalAssets) ? Number(pnl.totalAssets) : null;
        const totalProfit = observer
            ? hasFiniteValue(account.profit) ? Number(account.profit)
                : hasFiniteValue(account.realizedProfit) ? Number(account.realizedProfit) : null
            : hasFiniteValue(pnl.profit) ? Number(pnl.profit)
                : hasFiniteValue(account.profit) ? Number(account.profit) : null;
        const profitPercent = observer
            ? hasFiniteValue(account.profitPercent) ? Number(account.profitPercent) : null
            : hasFiniteValue(pnl.profitPercent) ? Number(pnl.profitPercent)
                : hasFiniteValue(account.profitPercent) ? Number(account.profitPercent) : null;
        const todayProfit = hasFiniteValue(today.realizedProfit) ? Number(today.realizedProfit) : null;
        const statistics = Array.isArray(state.statistics) ? state.statistics : [];
        const strategyTradeCounts = statistics.map(row => {
            const value = row.totalTrades ?? row.trades ?? row.tradeCount;
            return hasFiniteValue(value) ? Number(value) : null;
        });
        const strategyWins = statistics.map(row => {
            const value = row.winningTrades ?? row.wins;
            return hasFiniteValue(value) ? Number(value) : null;
        });
        const strategyTradeCount = strategyTradeCounts.every(value => value !== null)
            ? strategyTradeCounts.reduce((sum, value) => sum + value, 0) : null;
        const strategyWinCount = strategyWins.every(value => value !== null)
            ? strategyWins.reduce((sum, value) => sum + value, 0) : null;
        const totalTrades = paperLedgerVisible
            ? hasFiniteValue(paper.closedTradeCount) ? Number(paper.closedTradeCount) : null
            : state.statisticsLoaded ? strategyTradeCount : null;
        const wins = paperLedgerVisible
            ? hasFiniteValue(paper.strictEvaluation?.winningTrades) ? Number(paper.strictEvaluation.winningTrades) : totalTrades === 0 ? 0 : null
            : state.statisticsLoaded ? strategyWinCount : null;
        const winRate = totalTrades > 0 && wins !== null ? (wins / totalTrades) * 100 : null;
        const startAmount = hasFiniteValue(pnl.initialSeedMoney) ? Number(pnl.initialSeedMoney)
            : hasFiniteValue(account.initialSeedMoney) ? Number(account.initialSeedMoney) : null;
        setText('pilot-total-assets', totalAssets === null ? '—' : formatWon(totalAssets));
        setText('pilot-total-assets-caption', `${profitPercent === null ? '수익률 미제공' : formatPercent(profitPercent)} · ${startAmount === null ? '시작 금액 미제공' : `시작 금액 ${formatWon(startAmount)} 대비`}`);
        const todayLabel = byId('pilot-today-profit')?.closest('.pilot-stat-cell')?.querySelector('.pilot-stat-label');
        if (todayLabel) todayLabel.textContent = '오늘 실현 손익';
        setText('pilot-today-profit', todayProfit === null ? '—' : formatSignedWon(todayProfit));
        setText('pilot-today-profit-caption', hasFiniteValue(today.buyCount) && hasFiniteValue(today.sellCount)
            ? `매수 ${today.buyCount} · 매도 ${today.sellCount}`
            : '거래 건수 미제공');
        const cumulativeLabel = byId('pilot-cumulative-profit')?.closest('.pilot-stat-cell')?.querySelector('.pilot-stat-label');
        if (cumulativeLabel) cumulativeLabel.textContent = observer
            ? hasFiniteValue(account.profit) ? '평가 손익' : hasFiniteValue(account.realizedProfit) ? '실현 손익' : '기록 손익'
            : '누적 손익';
        setText('pilot-cumulative-profit', totalProfit === null ? '—' : formatSignedWon(totalProfit));
        setText('pilot-cumulative-profit-caption', profitPercent === null ? '수익률 미제공' : formatPercent(profitPercent));
        setText('pilot-win-rate', winRate === null ? '-' : `${winRate.toFixed(1)}%`);
        setText('pilot-trade-count-caption', totalTrades === null
            ? '거래 횟수 미제공'
            : paperLedgerVisible ? `모의투자 청산 ${totalTrades}회` : `집계 거래 ${totalTrades}회`);
        setText('pilot-overview-sync', state.lastSync ? `마지막 확인 ${formatTime(state.lastSync, true)}` : '마지막 확인 —');
        setText('pilot-trade-sync', state.lastSync ? `잔액 확인 ${formatTime(state.lastSync, true)}` : '잔액 미확인');
        setText('pilot-equity-source-label', portfolioHistorySourceLabel());
        ['pilot-today-profit', 'pilot-cumulative-profit'].forEach(id => {
            const element = byId(id);
            if (element) {
                const value = id === 'pilot-today-profit' ? todayProfit : totalProfit;
                element.className = value === null ? 'pilot-stat-value' : `pilot-stat-value ${classForValue(value)}`;
            }
        });
    }

    function positions() {
        if (isReadOnlyObserver() && Array.isArray(state.paper?.strictEvaluation?.positions)) {
            return state.paper.strictEvaluation.positions;
        }
        if (Array.isArray(state.account?.positions)) return state.account.positions;
        if (Array.isArray(state.portfolioAnalysis?.holdings)) return state.portfolioAnalysis.holdings;
        return [];
    }

    function completeHoldingsValuation(holdings, holdingsKnown, coreReady) {
        if (coreReady !== true || holdingsKnown !== true || !Array.isArray(holdings)) return null;
        if (holdings.length === 0) return 0;
        const values = holdings.map(holding => holding?.currentValue);
        if (values.some(value => value === null || value === undefined || value === '' ||
            !Number.isFinite(Number(value)) || Number(value) < 0)) return null;
        const total = values.reduce((sum, value) => sum + Number(value), 0);
        return Number.isFinite(total) ? total : null;
    }

    function manualOrderCapacityPresentation({ account, holdings, holdingsKnown, coreReady }) {
        const balanceLabel = coreReady === true && hasFiniteValue(account?.krwBalance)
            ? `사용 가능 잔액 ${formatWon(account.krwBalance)}`
            : '사용 가능 잔액 확인 불가';
        const holdingValue = completeHoldingsValuation(holdings, holdingsKnown, coreReady);
        const holdingLabel = holdingValue === null
            ? '보유 평가액 확인 불가'
            : `보유 평가액 ${formatWon(holdingValue)}`;
        return { balanceLabel, holdingLabel, holdingValue };
    }

    function positionDataKnown() {
        return (isReadOnlyObserver() && Array.isArray(state.paper?.strictEvaluation?.positions)) ||
            Array.isArray(state.account?.positions) ||
            Array.isArray(state.portfolioAnalysis?.holdings);
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
        target.closest('table')?.classList.toggle('is-position-empty', rows.length === 0);
        if (!rows.length) {
            const message = positionDataKnown() ? '현재 보유 포지션이 없습니다.' : '보유 정보를 불러오지 못했습니다.';
            target.innerHTML = `<tr><td colspan="7"><div class="pilot-inline-empty">${message}</div></td></tr>`;
            return;
        }
        target.innerHTML = rows.map((position, index) => {
            const coin = position.coin || position.market || '';
            const hasCurrentPrice = hasFiniteValue(position.currentPrice);
            const hasCurrentValue = hasFiniteValue(position.currentValue);
            const hasProfit = hasFiniteValue(position.profit);
            const profit = hasProfit ? Number(position.profit) : null;
            const color = index % 3 === 1 ? 'green' : index % 3 === 2 ? 'amber' : '';
            const profitText = hasProfit
                ? `${formatSignedWon(profit)} · ${formatOptionalPercent(position.profitPercent)}`
                : '미기록';
            const stateCell = isReadOnlyObserver()
                ? '관찰 중'
                : `<button type="button" class="pilot-table-action" data-pilot-position-action="sell" data-pilot-coin="${escapeHtml(coin)}">매도 검토</button>`;
            return `<tr><td><span class="pilot-asset-name"><i class="pilot-asset-dot" data-color="${color}" aria-hidden="true"></i>${escapeHtml(symbolOf(coin))}</span></td><td class="pilot-table-number">${formatQuantity(position.amount)}</td><td class="pilot-table-number">${hasFiniteValue(position.avgPrice || position.entryPrice) ? `${formatPrice(position.avgPrice || position.entryPrice)}원` : '미기록'}</td><td class="pilot-table-number">${hasCurrentPrice ? `${formatPrice(position.currentPrice)}원` : '미기록'}</td><td class="pilot-table-number">${hasCurrentValue ? formatWon(position.currentValue) : '미기록'}</td><td class="pilot-table-number ${hasProfit ? classForValue(profit) : ''}">${profitText}</td><td>${stateCell}</td></tr>`;
        }).join('');
    }

    function renderPositionHeaders() {
        const labels = ['자산', '수량', '평균 진입가', '현재가', '평가액', '평가손익', '상태'];
        ['pilot-overview-positions', 'pilot-portfolio-positions'].forEach(targetId => {
            const headers = byId(targetId)?.closest('table')?.querySelectorAll('thead th');
            if (headers?.length === labels.length) {
                headers.forEach((header, index) => { header.textContent = labels[index]; });
            }
        });
    }

    function renderActivity() {
        const target = byId('pilot-activity-list');
        if (!target) return;
        const trades = Array.isArray(state.trades) ? state.trades.slice(0, 6) : [];
        const activity = [];
        if (state.paper?.active) {
            const closedCount = hasFiniteValue(state.paper.closedTradeCount) ? `${Number(state.paper.closedTradeCount)}회` : '미기록';
            const interruptionCount = hasFiniteValue(state.paper.interruptionCount)
                ? Number(state.paper.interruptionCount)
                : Array.isArray(state.paper.interruptions) ? state.paper.interruptions.length : null;
            activity.push({ time: state.paper.updatedAt || state.paper.lastHeartbeat || state.paper.heartbeatAt, title: '모의투자 실행 중', detail: `청산 ${closedCount} · 중단 ${interruptionCount === null ? '미기록' : `${interruptionCount}회`}`, value: state.paper.state || 'RUNNING' });
        }
        trades.forEach(trade => {
            const action = trade.type || trade.action || '기록';
            const coin = symbolOf(trade.coin);
            const value = hasFiniteValue(trade.profit) ? formatSignedWon(trade.profit)
                : hasFiniteValue(trade.amount) ? formatWon(trade.amount)
                    : formatWon(trade.currentValue);
            activity.push({ time: trade.timestamp || trade.entryTime || trade.exitTime, title: `${coin} ${action === 'BUY' || action === 'OPEN' ? '매수' : action === 'SELL' || action === 'CLOSE' ? '매도' : action}`, detail: trade.source === 'strategy' ? '전략 기록' : '직접·조건 주문 기록', value });
        });
        target.innerHTML = activity.length
            ? activity.slice(0, 7).map(item => `<div class="pilot-evidence-row"><span class="pilot-evidence-time">${escapeHtml(formatTime(item.time))}</span><div><strong class="pilot-evidence-title">${escapeHtml(item.title)}</strong><div class="pilot-evidence-detail">${escapeHtml(item.detail)}</div></div><span class="pilot-evidence-value">${escapeHtml(String(item.value))}</span></div>`).join('')
            : `<div class="pilot-inline-empty">${state.tradesLoaded ? '거래 기록이 없습니다.' : '거래 기록을 불러오지 못했습니다.'}</div>`;
    }

    function renderRiskSummary() {
        const target = byId('pilot-risk-summary');
        if (!target) return;
        const paper = state.paper || {};
        const freshness = paper.candleFreshness || {};
        const analysisHealth = paper.analysisDataHealth || {};
        const circuit = paper.lossCircuitBreaker || state.status?.lossCircuitBreaker || {};
        const modeKnown = ['DRY_RUN', 'LIVE'].includes(state.actualMode);
        const protectiveOnly = state.status?.runtimeState === 'PROTECTIVE_ONLY';
        const paperNotStarted = paper.available === false && paper.reason === 'paper_validation_session_not_started';
        const paperKnown = paper.available === true || paperNotStarted;
        const circuitKnown = typeof circuit.enabled === 'boolean';
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
        const analysisStatusKnown = paperKnown && !paperNotStarted && (
            analysisHealth.failClosed !== undefined || analysisHealth.analysisActive !== undefined ||
            hasFiniteValue(analysisHealth.currentGapDurationSeconds) || hasFiniteValue(paper.telemetry?.analysisIncompleteCycles)
        );
        const analysisDetail = paperNotStarted
            ? '모의투자를 시작한 뒤 확인할 수 있습니다.'
            : !paperKnown || !analysisStatusKnown
                ? '분석 상태를 확인할 수 없습니다.'
                : analysisHealth.failClosed
                    ? `공백 ${analysisGap.toFixed(1)}초 · 관찰 중지`
                    : analysisHealth.analysisActive === true
                        ? `분석 진행 중 · ${analysisAge.toFixed(1)}초`
                        : analysisGap > 0
                            ? `부분 응답 재시도 · 공백 ${analysisGap.toFixed(1)}초`
                            : analysisIncomplete > 0
                                ? `부분 응답 ${analysisIncomplete}회 기록`
                                : '전체 대상 시장 분석 수신 정상';
        const marketPresentation = marketSnapshotPresentation(state.marketSnapshot, state.marketPricesLoaded, state.marketPrices);
        const marketDetail = protectiveOnly && state.status?.stopReason === 'risk_data_gap'
            ? '허용 시세 공백 발생 · 연속성 확인 필요'
            : marketPresentation.detail;
        const items = [
            { title: '실행 모드', detail: protectiveOnly ? 'LIVE · 위험 감시 전용 · 신규 주문 잠금' : state.actualMode === 'LIVE' ? '서버 실거래 · 주문 전 확인 필요' : state.actualMode === 'DRY_RUN' ? '서버 모의투자 · 실제 자금 미사용' : '거래 모드를 확인할 수 없습니다.', tone: protectiveOnly ? 'danger' : modeKnown && state.actualMode !== 'LIVE' ? 'ok' : 'warning' },
            { title: '시세 데이터', detail: state.marketPricesLoaded && stale > 0 ? `${stale}회 신규 진입 차단 기록` : marketDetail, tone: protectiveOnly && state.status?.stopReason === 'risk_data_gap' ? 'danger' : stale > 0 ? 'warning' : marketPresentation.tone === 'complete' && state.marketSnapshot?.marketListStale === false ? 'ok' : 'warning' },
            { title: '분석 데이터 상태', detail: analysisDetail, tone: analysisStatusKnown ? analysisTone : 'warning' },
            { title: '연속 손실 차단', detail: !circuitKnown ? '설정 상태를 확인할 수 없습니다.' : circuit.enabled ? `${circuit.lossCount || 0}/${circuit.maxLosses || 0}회 · ${circuit.coolingDown ? '차단 중' : '대기 중'}` : '비활성화', tone: !circuitKnown ? 'warning' : circuit.coolingDown ? 'danger' : circuit.enabled ? 'warning' : 'ok' },
            { title: '기록 연속성', detail: paper.continuityEligible === false ? '공백 기록으로 전환 보류' : paperNotStarted ? '모의투자 기록 없음' : paper.available === true ? '현재 실행 기록 확인 중' : '상태를 확인할 수 없습니다.', tone: paper.continuityEligible === false ? 'danger' : paper.available === true ? 'ok' : 'warning' }
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
        const position = currentPosition(selectedCoin);
        const quoteIssue = marketQuoteFreshnessIssue(market);
        const price = quoteIssue === null && hasFiniteValue(market.price) ? Number(market.price) : null;
        const holdingValue = hasFiniteValue(position?.currentValue) ? Number(position.currentValue) : null;
        const maxAmount = trade.side === 'buy'
            ? hasFiniteValue(state.account?.krwBalance) ? Number(state.account.krwBalance) : null
            : holdingValue;
        const amount = number(trade.amount);
        const quantity = price !== null && price > 0 ? amount / price : null;
        const fee = amount * 0.0005;
        if (document.activeElement !== input) input.value = amount || '';
        input.max = maxAmount !== null && maxAmount > 0 ? String(Math.floor(maxAmount)) : '';
        const modeLabel = root.querySelector(`[data-pilot-trade-mode-label="${prefix}"]`);
        const lockCopy = root.querySelector(`[data-pilot-trade-lock-copy="${prefix}"]`);
        const lockIcon = root.querySelector(`[data-pilot-trade-lock="${prefix}"] i`);
        const amountLabel = root.querySelector(`[data-pilot-trade-amount-label="${prefix}"]`);
        const balance = root.querySelector(`[data-pilot-trade-balance="${prefix}"]`);
        const modeKnown = ['DRY_RUN', 'LIVE'].includes(state.actualMode);
        if (modeLabel) {
            modeLabel.textContent = !modeKnown ? '모드 확인 필요' : state.activeMode === 'live' ? '실거래' : '모의투자';
            modeLabel.className = `pilot-status-pill${!modeKnown || state.activeMode === 'live' && !state.liveEligible ? ' is-warning' : ''}`;
        }
        if (lockCopy) lockCopy.textContent = canTrade(selectedCoin) ? (state.activeMode === 'live' ? '사전 점검 통과 상태입니다. 실행 전 최종 확인이 필요합니다.' : '모의투자 주문입니다.') : tradeBlockReason(selectedCoin);
        if (lockIcon) lockIcon.className = `ph ${canTrade(selectedCoin) ? (state.activeMode === 'live' ? 'ph-shield-check' : 'ph-lock-key-open') : 'ph-lock-key'}`;
        if (amountLabel) amountLabel.textContent = trade.side === 'buy' ? '주문 금액 (원)' : '매도할 금액 (원)';
        if (balance) balance.textContent = trade.side === 'buy'
            ? `잔액 ${hasFiniteValue(state.account?.krwBalance) ? formatWon(state.account.krwBalance) : '미제공'}`
            : `보유 ${holdingValue !== null ? formatWon(holdingValue) : positionDataKnown() ? '평가액 미제공' : '자산 미제공'}`;
        const setTradeText = (field, value) => {
            const element = root.querySelector(`[data-pilot-trade-${field}="${prefix}"]`);
            if (element) element.textContent = value;
        };
        setTradeText('price', price !== null && price > 0 ? `${formatPrice(price)}원` : '미제공');
        setTradeText('quantity', quantity !== null ? formatQuantity(quantity) : '미제공');
        setTradeText('holding', holdingValue !== null ? formatWon(holdingValue) : position ? '평가액 미제공' : positionDataKnown() ? '보유 자산 없음' : '자산 미제공');
        setTradeText('fee', amount ? formatWon(fee) : '-');
        submit.textContent = !modeKnown ? '거래 모드 확인 필요' : trade.side === 'buy' ? (state.activeMode === 'live' ? '실제 주문 실행' : '모의 주문 실행') : (state.activeMode === 'live' ? '실제 매도 실행' : '모의 매도 실행');
        submit.disabled = !canTrade(selectedCoin) || state.pendingMutation?.locked === true || !selectedCoin || amount <= 0 || (trade.side === 'sell' && (!holdingValue || holdingValue <= 0)) || (trade.side === 'buy' && amount < 5000);
        const disclaimer = root.querySelector(`[data-pilot-trade-disclaimer="${prefix}"]`);
        if (disclaimer) disclaimer.textContent = canTrade(selectedCoin) ? `수수료 0.05% 기준 예상치 · ${state.activeMode === 'live' ? '실제 체결 가격은 예상과 다를 수 있습니다.' : '모의 체결로 기록됩니다.'}` : tradeBlockReason(selectedCoin);
        $$(`[data-pilot-trade-side="${prefix}"]`).forEach(button => button.classList.toggle('is-active', button.dataset.tradeSide === trade.side));
    }

    function renderTradePanels() {
        ['market', 'trade'].forEach(renderTradePanel);
    }

    function renderManualOrderCapacity() {
        const presentation = manualOrderCapacityPresentation({
            account: state.account,
            holdings: positions(),
            holdingsKnown: positionDataKnown(),
            coreReady: state.coreReady === true
        });
        setText('pilot-smart-buy-balance', presentation.balanceLabel);
        setText('pilot-smart-sell-holding', presentation.holdingLabel);
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
        const chartWrap = canvas.parentElement;
        const hasTrend = hasUsableHistoryTrend(points);
        canvas.hidden = !hasTrend;
        chartWrap?.classList.toggle('is-empty', !hasTrend);
        if (empty) {
            empty.hidden = hasTrend;
            if (!hasTrend) {
                empty.setAttribute('role', 'status');
                empty.setAttribute('aria-live', 'polite');
                const isHistoryError = state.portfolioHistoryError === true;
                const hasUnusableHistory = history.length > 0;
                const hasSingleValuation = points.length === 1 && history.length === 1;
                const isLoading = state.refreshing && !isHistoryError && !hasUnusableHistory;
                const canRecordSnapshot = !isHistoryError && !isLoading &&
                    state.online !== false && state.coreReady === true && !isReadOnlyObserver();
                const title = isHistoryError ? '자산 기록을 불러오지 못했습니다'
                    : hasSingleValuation ? '저장된 평가 기록 1건'
                    : hasUnusableHistory ? '표시할 수 있는 평가 기록이 없습니다'
                    : isLoading ? '자산 기록을 확인하고 있습니다'
                    : isReadOnlyObserver() ? '아직 자산 기록이 없습니다'
                    : '자산 흐름을 기록해 보세요';
                const description = isHistoryError ? '연결을 확인한 뒤 새로고침해 주세요.'
                    : hasSingleValuation ? `${formatWon(points[0].totalAssets)} · ${formatTime(points[0].timestamp ?? points[0].capturedAt, true)} 저장. 다른 시점의 평가를 기록하면 추이를 볼 수 있습니다.`
                    : hasUnusableHistory ? '현재 가치가 확인된 기록만 추이에 표시됩니다.'
                    : isLoading ? '선택한 기간의 평가 기록을 불러오고 있습니다.'
                    : isReadOnlyObserver() ? '서버에 평가 기록이 쌓이면 선택한 기간의 변화를 볼 수 있습니다.'
                    : state.coreReady === true ? '현재 계좌 평가를 저장하면 선택한 기간의 변화가 시작됩니다.'
                    : '서버와 계좌, 최신 시세를 확인하면 현재 평가를 기록할 수 있습니다.';
                const recordAction = canRecordSnapshot
                    ? '<button type="button" class="pilot-button is-small is-primary" data-pilot-action="record-snapshot">현재 평가 기록</button>'
                    : '';
                empty.innerHTML = `<span class="pilot-chart-empty-mark" aria-hidden="true"><i class="ph ph-chart-line-up"></i></span><span class="pilot-chart-empty-copy"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(description)}</span></span>${recordAction}`;
            }
        }
        drawCanvas(canvas, 302, (ctx, width, height) => {
            if (!hasTrend) return;
            const values = points.map(item => number(item.totalAssets));
            const seed = number(state.pnl?.initialSeedMoney || state.account?.initialSeedMoney || values[0]);
            const min = Math.min(seed, ...values); const max = Math.max(seed, ...values); const range = max - min || 1;
            const padding = { top: 26, right: 32, bottom: 28, left: 70 };
            const innerWidth = Math.max(10, width - padding.left - padding.right); const innerHeight = Math.max(10, height - padding.top - padding.bottom);
            ctx.font = '11px -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif'; ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(2, 9, 19, 0.12)'; ctx.fillStyle = '#6b7684';
            for (let row = 0; row <= 4; row += 1) { const y = padding.top + (row / 4) * innerHeight; ctx.beginPath(); ctx.moveTo(padding.left, y); ctx.lineTo(width - padding.right, y); ctx.stroke(); ctx.fillText(formatWon(max - (row / 4) * range, ''), 8, y + 4); }
            const pointAt = (index, value) => ({ x: padding.left + (index / Math.max(1, values.length - 1)) * innerWidth, y: padding.top + innerHeight - ((value - min) / range) * innerHeight });
            const base = pointAt(0, seed).y; ctx.setLineDash([4, 5]); ctx.strokeStyle = '#a5adb7'; ctx.beginPath(); ctx.moveTo(padding.left, base); ctx.lineTo(width - padding.right, base); ctx.stroke(); ctx.setLineDash([]);
            const coords = values.map((value, index) => pointAt(index, value)); ctx.beginPath(); coords.forEach((point, index) => index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)); ctx.lineWidth = 2.5; ctx.strokeStyle = '#1b64da'; ctx.stroke();
            const last = coords[coords.length - 1];
            if (last) { ctx.fillStyle = '#1b64da'; ctx.beginPath(); ctx.arc(last.x, last.y, 4, 0, Math.PI * 2); ctx.fill(); ctx.font = '700 12px -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif'; ctx.fillText(formatWon(values[values.length - 1]), Math.min(width - padding.right - 105, last.x + 8), Math.max(18, last.y - 10)); }
            ctx.fillStyle = '#6b7684'; ctx.font = '10px -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif'; if (points[0]?.timestamp) ctx.fillText(formatTime(points[0].timestamp), padding.left, height - 8); if (points[points.length - 1]?.timestamp) ctx.fillText(formatTime(points[points.length - 1].timestamp), Math.max(padding.left, width - padding.right - 40), height - 8);
        });
    }

    function portfolioAllocationPresentation(holdings, cashBalance) {
        const isKnownAmount = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
        const holdingsKnown = Array.isArray(holdings);
        const holdingItems = holdingsKnown
            ? holdings.map(item => ({
                name: String(item?.name || '보유 자산'),
                value: isKnownAmount(item?.value) ? Number(item.value) : null
            }))
            : [{ name: '보유 종목', value: null }];
        const cashKnown = isKnownAmount(cashBalance);
        const cash = cashKnown ? Number(cashBalance) : null;
        const items = [...holdingItems, { name: 'KRW', value: cash }];
        const holdingsComplete = holdingsKnown && holdingItems.every(item => item.value !== null && item.value >= 0);
        const cashComplete = cash !== null && cash >= 0;

        if (!holdingsComplete || !cashComplete) {
            const unknownParts = [];
            if (!holdingsKnown) unknownParts.push('보유 종목');
            else if (!holdingsComplete) unknownParts.push('일부 종목 평가액');
            if (!cashComplete) unknownParts.push('현금 잔액');
            return {
                kind: 'partial',
                items,
                total: null,
                message: `${unknownParts.join('과 ')}을 확인할 수 없어 자산 비율을 표시하지 않습니다.`
            };
        }

        const positiveItems = items.filter(item => item.value > 0);
        const total = positiveItems.reduce((sum, item) => sum + item.value, 0);
        if (positiveItems.length === 0) {
            return {
                kind: 'zero',
                items,
                total: 0,
                message: '확인된 자산 평가액이 0원이라 구성 비율을 표시하지 않습니다.'
            };
        }

        const allocatedItems = positiveItems.map(item => ({
            ...item,
            percentage: item.value / total * 100
        }));
        return {
            kind: allocatedItems.length === 1 ? 'single' : 'multi',
            items: allocatedItems,
            total,
            message: null
        };
    }

    function drawAllocationChart() {
        const canvas = byId('pilot-allocation-chart');
        const legend = byId('pilot-allocation-legend');
        const allocationGrid = byId('pilot-portfolio-allocation-grid');
        const hideChart = message => {
            allocationGrid?.classList.remove('is-allocation-single', 'is-allocation-zero');
            if (canvas) canvas.hidden = true;
            if (canvas?.parentElement) canvas.parentElement.style.gridTemplateColumns = 'minmax(0, 1fr)';
            if (legend) legend.innerHTML = message
                ? `<div class="pilot-inline-note"><i class="ph ph-info" aria-hidden="true"></i><span>${escapeHtml(message)}</span></div>`
                : '';
        };
        if (isReadOnlyObserver()) {
            hideChart('이 기록에는 현금 잔액과 종목별 현재 평가액이 없어 자산 구성을 계산하지 않습니다.');
            return;
        }
        const hasAccountSnapshot = hasFiniteValue(state.account?.totalAssets) ||
            hasFiniteValue(state.account?.krwBalance) || Array.isArray(state.account?.positions);
        const hasPortfolioSnapshot = hasFiniteValue(state.portfolioAnalysis?.summary?.totalAssets) ||
            hasFiniteValue(state.portfolioAnalysis?.summary?.krwBalance) || Array.isArray(state.portfolioAnalysis?.holdings);
        if (!hasAccountSnapshot && !hasPortfolioSnapshot) {
            hideChart('자산 구성을 불러오지 못했습니다.');
            return;
        }

        const analysisHoldings = Array.isArray(state.portfolioAnalysis?.holdings)
            ? state.portfolioAnalysis.holdings
            : null;
        const accountHoldingsKnown = positionDataKnown();
        const accountHoldings = accountHoldingsKnown ? positions() : null;
        const holdings = analysisHoldings?.length
            ? analysisHoldings
            : accountHoldings ?? analysisHoldings;
        const normalizedHoldings = holdings === null
            ? null
            : holdings.map(item => ({ name: symbolOf(item?.coin || item?.market), value: item?.currentValue }));
        const cash = hasFiniteValue(state.portfolioAnalysis?.summary?.krwBalance)
            ? Number(state.portfolioAnalysis.summary.krwBalance)
            : hasFiniteValue(state.account?.krwBalance) ? Number(state.account.krwBalance) : null;
        const allocation = portfolioAllocationPresentation(normalizedHoldings, cash);
        allocationGrid?.classList.toggle('is-allocation-single', allocation.kind === 'single');
        allocationGrid?.classList.toggle('is-allocation-zero', allocation.kind === 'zero');
        const chartVisible = allocation.kind === 'multi';
        if (canvas) canvas.hidden = !chartVisible;
        if (canvas?.parentElement) canvas.parentElement.style.gridTemplateColumns = chartVisible
            ? '170px minmax(0, 1fr)'
            : 'minmax(0, 1fr)';

        const rows = allocation.items.map((item, index) => {
            const amount = item.value === null ? '평가액 미제공' : formatWon(item.value);
            const percentage = Number.isFinite(item.percentage)
                ? `<span class="pilot-status-pill">${item.percentage.toFixed(1)}%</span>`
                : '';
            return `<div class="pilot-control-row"><div class="pilot-control-copy"><strong><i class="pilot-asset-dot" data-color="${index === 1 ? 'green' : index === 2 ? 'amber' : ''}" aria-hidden="true"></i> ${escapeHtml(item.name)}</strong><span>${amount}</span></div>${percentage}</div>`;
        }).join('');
        if (legend) {
            const message = allocation.message
                ? `<div class="pilot-inline-note"><i class="ph ph-info" aria-hidden="true"></i><span>${escapeHtml(allocation.message)}</span></div>`
                : '';
            legend.innerHTML = `${message}<div class="pilot-allocation-list">${rows || '<div class="pilot-inline-empty">보유 자산이 없습니다.</div>'}</div>`;
        }

        if (!chartVisible) return;
        drawCanvas(canvas, 170, (ctx, width, height) => {
            const center = width / 2; const radius = Math.min(width, height) / 2 - 12; let start = -Math.PI / 2;
            allocation.items.forEach((item, index) => { const sweep = (item.value / allocation.total) * Math.PI * 2; ctx.beginPath(); ctx.moveTo(center, center); ctx.arc(center, center, radius, start, start + sweep); ctx.closePath(); ctx.fillStyle = index === 0 ? '#1b64da' : index === 1 ? '#027648' : index === 2 ? '#ed6700' : '#b0b8c1'; ctx.fill(); start += sweep; });
            ctx.fillStyle = '#191f28'; ctx.font = '700 15px -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif'; ctx.textAlign = 'center'; ctx.fillText(formatWon(allocation.total, ''), center, center + 5); ctx.textAlign = 'left';
        });
    }

    function drawMarketChart() {
        const canvas = byId('pilot-market-chart'); const empty = byId('pilot-market-empty');
        const candles = getDisplayedCandles(state.candles, state.candleDisplayRange);
        const candleDataDetails = byId('pilot-market-candle-data');
        const candleDataNote = byId('pilot-market-candle-data-note');
        const candleDataTable = byId('pilot-market-data-table');
        const candleDataStatus = byId('pilot-market-candle-status');
        const hasLastKnownCandles = Array.isArray(state.candles)
            && state.candles.length > 0
            && state.candlesCoin === state.selectedCoin
            && state.candlesInterval === state.candleInterval;
        if (candleDataStatus) {
            candleDataStatus.hidden = !state.candlesError && !(hasLastKnownCandles && state.candlesLoading);
            if (state.candlesError) {
                candleDataStatus.setAttribute('role', 'status');
                candleDataStatus.setAttribute('aria-live', 'polite');
            } else {
                candleDataStatus.removeAttribute('role');
                candleDataStatus.removeAttribute('aria-live');
            }
            candleDataStatus.textContent = state.candlesError
                ? hasLastKnownCandles
                    ? '최신 캔들을 불러오지 못했습니다. 마지막 정상 자료를 표시합니다.'
                    : '최신 캔들을 불러오지 못했습니다.'
                : state.candlesLoading ? '최신 캔들을 확인하는 동안 마지막 정상 자료를 표시합니다.' : '';
        }
        if (candleDataDetails && candleDataNote && candleDataTable) {
            const recentCandles = candles.slice(-20).reverse();
            candleDataDetails.hidden = recentCandles.length === 0;
            candleDataNote.textContent = recentCandles.length
                ? state.candlesError
                    ? `최신 자료를 불러오지 못했습니다. 화면에 표시한 ${candles.length}개 중 마지막 정상 조회 자료 ${recentCandles.length}개 · 시각은 기기 현지 시간입니다.`
                    : state.candlesLoading
                        ? `최신 자료를 확인하는 중입니다. 화면에 표시한 ${candles.length}개 중 마지막 정상 조회 자료 ${recentCandles.length}개 · 시각은 기기 현지 시간입니다.`
                        : `화면에 표시한 ${candles.length}개 중 최신 ${recentCandles.length}개 · 시각은 기기 현지 시간입니다.`
                : '';
            const tableMarkup = recentCandles.length
                ? `<table class="pilot-table pilot-market-data-table"><caption class="pilot-visually-hidden">선택 종목 최신 캔들 OHLCV 기록</caption><thead><tr><th scope="col">시각</th><th class="pilot-table-number" scope="col">시가</th><th class="pilot-table-number" scope="col">고가</th><th class="pilot-table-number" scope="col">저가</th><th class="pilot-table-number" scope="col">종가</th><th class="pilot-table-number" scope="col">거래량</th></tr></thead><tbody>${recentCandles.map(candle => `<tr><th scope="row">${escapeHtml(formatDateTime(candle.time))}</th><td class="pilot-table-number">${formatPrice(candle.open)}</td><td class="pilot-table-number">${formatPrice(candle.high)}</td><td class="pilot-table-number">${formatPrice(candle.low)}</td><td class="pilot-table-number">${formatPrice(candle.close)}</td><td class="pilot-table-number">${formatQuantity(candle.volume)}</td></tr>`).join('')}</tbody></table>`
                : '';
            if (candleDataTable.innerHTML !== tableMarkup) candleDataTable.innerHTML = tableMarkup;
        }
        if (empty) {
            empty.hidden = candles.length > 0;
            if (!candles.length) empty.textContent = state.candlesError
                ? '가격 자료를 불러오지 못했습니다. 다시 시도해 주세요.'
                : state.candlesLoading ? '가격 자료를 불러오는 중입니다.' : '표시할 가격 자료가 없습니다.';
        }
        const chartWrap = canvas?.parentElement;
        const configuredHeight = chartWrap && typeof window.getComputedStyle === 'function'
            ? Number.parseFloat(window.getComputedStyle(chartWrap).getPropertyValue('--pilot-market-chart-height'))
            : NaN;
        const chartHeight = Number.isFinite(configuredHeight) && configuredHeight > 0
            ? configuredHeight
            : chartWrap?.clientHeight || 398;
        drawCanvas(canvas, chartHeight, (ctx, width, height) => {
            if (!candles.length) return;
            const padding = { top: 18, right: 54, bottom: 26, left: 16 };
            const high = Math.max(...candles.map(item => number(item.high)), ...candles.map(item => number(item.close)));
            const low = Math.min(...candles.map(item => number(item.low)), ...candles.map(item => number(item.close)));
            const range = high - low || 1;
            ctx.font = '10px -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif'; ctx.fillStyle = '#6b7684'; ctx.strokeStyle = 'rgba(2, 9, 19, 0.12)'; ctx.lineWidth = 1;
            const tickLabels = Array.from({ length: 5 }, (_, row) => formatPrice(high - (row / 4) * range));
            const axisLabelGap = 7;
            const axisLabelEdge = 4;
            const widestAxisLabel = Math.max(...tickLabels.map(label => ctx.measureText(label).width));
            padding.right = Math.max(padding.right, Math.ceil(widestAxisLabel + axisLabelGap + axisLabelEdge));
            const innerWidth = Math.max(10, width - padding.left - padding.right);
            const innerHeight = Math.max(10, height - padding.top - padding.bottom);
            const y = value => padding.top + innerHeight - ((value - low) / range) * innerHeight;
            for (let row = 0; row <= 4; row += 1) { const lineY = padding.top + (row / 4) * innerHeight; ctx.beginPath(); ctx.moveTo(padding.left, lineY); ctx.lineTo(width - padding.right, lineY); ctx.stroke(); ctx.fillText(tickLabels[row], width - padding.right + axisLabelGap, lineY + 4); }
            const step = innerWidth / candles.length; const bodyWidth = Math.max(2, Math.min(12, step * 0.62));
            candles.forEach((candle, index) => { const x = padding.left + step * index + step / 2; const open = number(candle.open); const close = number(candle.close); const highValue = number(candle.high); const lowValue = number(candle.low); const bullish = close >= open; ctx.strokeStyle = bullish ? '#027648' : '#a51926'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, y(highValue)); ctx.lineTo(x, y(lowValue)); ctx.stroke(); ctx.fillStyle = bullish ? '#027648' : '#a51926'; const top = y(Math.max(open, close)); const bottom = y(Math.min(open, close)); ctx.fillRect(x - bodyWidth / 2, top, bodyWidth, Math.max(1, bottom - top)); });
            ctx.fillStyle = '#6b7684';
            if (candles[0]?.time) ctx.fillText(formatTime(candles[0].time), padding.left, height - 7);
            if (candles[candles.length - 1]?.time) {
                const lastTimeLabel = formatTime(candles[candles.length - 1].time);
                const lastTimeWidth = ctx.measureText(lastTimeLabel).width;
                const lastTimeX = Math.max(padding.left, width - padding.right - lastTimeWidth);
                ctx.fillText(lastTimeLabel, lastTimeX, height - 7);
            }
        });
    }

    function renderCandleControls() {
        $$('[data-pilot-candle-interval]').forEach(button => {
            const selected = number(button.dataset.pilotCandleInterval) === state.candleInterval;
            button.classList.toggle('is-active', selected);
            button.setAttribute('aria-pressed', String(selected));
        });
        $$('[data-pilot-candle-range]').forEach(button => {
            const selected = number(button.dataset.pilotCandleRange) === state.candleDisplayRange;
            button.classList.toggle('is-active', selected);
            button.setAttribute('aria-pressed', String(selected));
        });
    }

    function renderMarketHeader() {
        const marketData = currentMarket(); const market = marketData || {}; const position = currentPosition(); const symbol = symbolOf(state.selectedCoin);
        const priceKnown = hasFiniteValue(market.price);
        const marketPresentation = marketSnapshotPresentation(state.marketSnapshot, state.marketPricesLoaded, state.marketPrices);
        const selectedMarketPresentation = selectedMarketQuotePresentation(
            marketData,
            marketPresentation,
            state.marketPricesLoaded
        );
        const marketName = byId('pilot-market-name');
        const marketStatus = byId('pilot-market-status');
        const marketStatusLabel = selectedMarketPresentation.label;
        setText('pilot-market-symbol', `${symbol}/KRW`);
        if (marketName && marketName.textContent !== '업비트 원화 시장') marketName.textContent = '업비트 원화 시장';
        if (marketStatus && marketStatus.textContent !== marketStatusLabel) marketStatus.textContent = marketStatusLabel;
        updateMarketAnnouncement('pilot-market-status-announcement', `${symbol}/KRW · ${marketStatusLabel}`);
        if (marketStatus) marketStatus.dataset.marketState = selectedMarketPresentation.state;
        setText('pilot-market-price', priceKnown ? `${formatPrice(market.price)}원` : '미제공');
        const sourceTimeElement = byId('pilot-market-source-asof');
        const fetchedTimeElement = byId('pilot-market-fetched-at');
        if (sourceTimeElement?.previousElementSibling) sourceTimeElement.previousElementSibling.textContent = marketData ? '최근 체결 시각' : '전체 시세 기준 시각';
        if (fetchedTimeElement?.previousElementSibling) fetchedTimeElement.previousElementSibling.textContent = state.marketPricesLoaded ? '서버 시세 수집 시각' : '마지막 서버 시세 수집 시각';
        setText('pilot-market-source-asof', formatMarketTimestamp(marketData?.sourceAsOf));
        setText('pilot-market-fetched-at', formatMarketTimestamp(marketData?.fetchedAt ?? state.marketSnapshot?.fetchedAt));
        const changeElement = byId('pilot-market-change');
        if (changeElement) { changeElement.textContent = priceKnown && hasFiniteValue(market.change) ? formatPercent(market.change) : '미제공'; changeElement.className = `pilot-market-change ${classForValue(market.change)}`; }
        setText('pilot-market-high', hasFiniteValue(market.high) ? `${formatPrice(market.high)}원` : '미제공'); setText('pilot-market-low', hasFiniteValue(market.low) ? `${formatPrice(market.low)}원` : '미제공'); setText('pilot-market-volume', hasFiniteValue(market.volumeKrw) ? formatWon(market.volumeKrw) : '미제공');
        setText('pilot-market-holding', !position ? '보유 포지션 없음' : hasFiniteValue(position.currentValue)
            ? formatWon(position.currentValue)
            : isReadOnlyObserver() ? '보유 · 평가액 미기록' : '보유');
        renderCandleControls();
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
        if (!list.length) {
            const query = String(state.marketSearch || '').trim();
            const emptyMessage = !state.marketPricesLoaded
                ? '시세를 불러오지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.'
                : state.marketPrices.length > 0 && query ? '검색 결과가 없습니다.' : '표시할 시세가 없습니다.';
            target.innerHTML = `<div class="pilot-empty-panel"><i class="ph ph-chart-line" aria-hidden="true"></i>${escapeHtml(emptyMessage)}</div>`;
            return;
        }
        target.innerHTML = `<div class="pilot-market-row pilot-market-row-head" aria-hidden="true"><span class="pilot-market-row-label">시장</span><span class="pilot-market-row-label" style="text-align:right">현재가</span><span class="pilot-market-row-label" style="text-align:right">24시간</span><span class="pilot-market-row-label" style="text-align:right">거래량</span><span></span></div>${list.slice(0, 80).map(item => {
            const quote = marketRowQuotePresentation(item, state.marketPricesLoaded);
            return `<div class="pilot-market-row ${item.coin === state.selectedCoin ? 'is-selected' : ''}" role="button" tabindex="0" aria-pressed="${item.coin === state.selectedCoin ? 'true' : 'false'}" data-pilot-market-row="${escapeHtml(item.coin)}"><span class="pilot-market-row-market"><span class="pilot-market-row-symbol">${escapeHtml(symbolOf(item.coin))}/KRW</span><span class="pilot-market-row-freshness is-${quote.state}">${escapeHtml(quote.label)}</span></span><span class="pilot-market-row-price">${formatPrice(item.price)}</span><span class="pilot-market-row-change ${classForValue(item.change)}">${formatPercent(item.change)}</span><span class="pilot-market-row-volume">${formatWon(item.volumeKrw)}</span><span><i class="ph ph-arrow-up-right" aria-hidden="true"></i></span></div>`;
        }).join('')}`;
    }

    function renderPortfolio() {
        const observer = isReadOnlyObserver();
        const paper = state.paper || {};
        const summary = state.portfolioAnalysis?.summary || {};
        const paperAssets = hasFiniteValue(paper.currentAssets) ? Number(paper.currentAssets) : null;
        const paperBaseline = hasFiniteValue(paper.baselineAssets)
            ? Number(paper.baselineAssets)
            : hasFiniteValue(state.account?.initialSeedMoney) ? Number(state.account.initialSeedMoney) : null;
        const currentAssets = observer
            ? (paperAssets ?? state.account?.totalAssets)
            : hasFiniteValue(summary.totalAssets) ? Number(summary.totalAssets)
                : hasFiniteValue(state.account?.totalAssets) ? Number(state.account.totalAssets) : null;
        const totalProfit = observer && paperAssets !== null && paperBaseline !== null
            ? paperAssets - paperBaseline
            : observer ? null
                : hasFiniteValue(summary.totalProfit) ? Number(summary.totalProfit)
                    : hasFiniteValue(state.pnl?.profit) ? Number(state.pnl.profit) : null;
        const positionCount = positions().length;
        const cashBalance = observer ? null
            : hasFiniteValue(summary.krwBalance) ? Number(summary.krwBalance)
                : hasFiniteValue(state.account?.krwBalance) ? Number(state.account.krwBalance) : null;
        const holdingCount = observer ? positionDataKnown() ? positionCount : null
            : hasFiniteValue(summary.totalHoldings) ? Number(summary.totalHoldings)
                : positionDataKnown() ? positionCount : null;
        setText('pilot-portfolio-assets', currentAssets === null || currentAssets === undefined ? '—' : formatWon(currentAssets));
        const profitEl = byId('pilot-portfolio-profit');
        if (profitEl) {
            profitEl.textContent = totalProfit === null ? '미기록' : formatSignedWon(totalProfit);
            profitEl.className = totalProfit === null ? '' : classForValue(totalProfit);
            if (profitEl.previousElementSibling) {
                profitEl.previousElementSibling.textContent = observer ? '기록 평가손익' : '누적 손익';
            }
        }
        setText('pilot-portfolio-profit-label', observer ? '기록 평가손익' : '누적 손익');
        setText('pilot-portfolio-cash', observer ? '기록 없음' : cashBalance === null ? '—' : formatWon(cashBalance));
        setText('pilot-portfolio-count', holdingCount === null ? '—' : `${holdingCount}개`);
        const summaryTarget = byId('pilot-account-summary');
        if (summaryTarget) {
            const summaryRows = observer
                ? [
                    ['기록 기준', '모의투자 기록'],
                    ['기준 자산', paperBaseline === null ? '미기록' : formatWon(paperBaseline)],
                    ['마지막 평가 시각', paper.lastSnapshotAt ? formatDateTime(paper.lastSnapshotAt) : '미기록'],
                    ['수수료 반영 기록', hasFiniteValue(paper.realizedProfit) ? formatSignedWon(paper.realizedProfit) : '미기록'],
                    ['현금 잔액', '기록 없음']
                ]
                : [['모드', state.actualMode === 'LIVE' ? '실거래' : state.actualMode === 'DRY_RUN' ? '모의투자' : '확인 불가'], ['현금 잔액', hasFiniteValue(state.account?.krwBalance) ? formatWon(state.account.krwBalance) : '미기록'], ['총 자산 평가액', hasFiniteValue(state.account?.totalAssets) ? formatWon(state.account.totalAssets) : '미기록'], ['시작 자산', hasFiniteValue(state.account?.initialSeedMoney) ? formatWon(state.account.initialSeedMoney) : hasFiniteValue(state.pnl?.initialSeedMoney) ? formatWon(state.pnl.initialSeedMoney) : '미기록'], ['누적 수익률', hasFiniteValue(state.pnl?.profitPercent) ? formatPercent(state.pnl.profitPercent) : '미기록']];
            summaryTarget.innerHTML = summaryRows.map(([label, value]) => `<div class="pilot-control-row"><div class="pilot-control-copy"><strong>${escapeHtml(label)}</strong></div><span style="font-size:12px;font-weight:700;color:var(--sl-ink)">${escapeHtml(value)}</span></div>`).join('');
        }
        renderPositionHeaders(); renderPositionRows('pilot-portfolio-positions'); drawAllocationChart(); drawEquityChart('pilot-portfolio-chart', 'pilot-portfolio-empty', state.portfolioHistory); renderChartPeriodButtons(); setText('pilot-portfolio-history-source-label', portfolioHistorySourceLabel());
        const walletMode = byId('pilot-wallet-mode');
        if (walletMode) {
            const modeKnown = ['LIVE', 'DRY_RUN'].includes(state.actualMode);
            walletMode.textContent = observer ? '조회 전용' : !modeKnown ? '상태 확인 필요' : isPaperMode() ? '모의투자 전용' : '실거래 잠금';
            walletMode.className = `pilot-status-pill${!observer && (!modeKnown || !isPaperMode()) ? ' is-warning' : ''}`;
            const walletPanel = walletMode.closest('.pilot-panel');
            if (walletPanel) walletPanel.hidden = observer || !modeKnown || !isPaperMode();
        }
    }

    function renderAnalysis() {
        const result = state.analysis || {}; const loaded = state.analysis !== null && state.analysis !== undefined; const coins = Array.isArray(result.coins) ? result.coins : []; const filter = state.analysisFilter || 'all';
        let filtered = coins.filter(item => filter === 'all' || item.recommendation === filter); const sort = state.analysisSort || 'score';
        filtered = [...filtered].sort((a, b) => sort === 'buy' ? number(b.buyScore) - number(a.buyScore) : sort === 'sell' ? number(b.sellScore) - number(a.sellScore) : sort === 'volume' ? number(b.volume24h) - number(a.volume24h) : sort === 'change' ? number(b.change24h) - number(a.change24h) : number(b.totalScore) - number(a.totalScore));
        setText('pilot-analysis-total', loaded && !state.analysisError ? result.totalAnalyzed ?? coins.length : '—'); setText('pilot-analysis-buy', loaded && !state.analysisError ? coins.filter(item => item.recommendation === 'BUY').length : '—'); setText('pilot-analysis-sell', loaded && !state.analysisError ? coins.filter(item => item.recommendation === 'SELL').length : '—'); setText('pilot-analysis-hold', loaded && !state.analysisError ? coins.filter(item => item.recommendation === 'HOLD').length : '—'); setText('pilot-analysis-strong', loaded && !state.analysisError ? coins.filter(item => ['STRONG', 'VERY_STRONG'].includes(item.signalStrength)).length : '—');
        const target = byId('pilot-analysis-rows'); if (!target) return;
        if (state.analysisError || !loaded || !filtered.length) {
            const analyzedCount = hasFiniteValue(result.totalAnalyzed) ? Number(result.totalAnalyzed) : coins.length;
            const emptyMessage = state.analysisError
                ? '분석 결과를 불러오지 못했습니다. 다시 시도해 주세요.'
                : !loaded ? '분석 실행을 누르면 결과가 표시됩니다.'
                    : analyzedCount === 0 ? '분석할 종목이 없습니다. 거래 대상 설정을 확인해 주세요.'
                        : filter !== 'all' ? '선택한 판정에 해당하는 종목이 없습니다.' : '조건에 맞는 신호가 없습니다.';
            target.innerHTML = `<tr><td colspan="8"><div class="pilot-empty-panel"><i class="ph ph-function" aria-hidden="true"></i>${escapeHtml(emptyMessage)}</div></td></tr>`;
            return;
        }
        target.innerHTML = filtered.slice(0, 80).map(item => { const action = item.recommendation || 'HOLD'; const tone = action === 'BUY' ? '' : action === 'SELL' ? 'is-danger' : 'is-warning'; const price = hasFiniteValue(item.currentPrice) ? `${formatPrice(item.currentPrice)}원` : '미제공'; const change = hasFiniteValue(item.change24h) ? formatPercent(item.change24h) : '미제공'; const rsi = hasFiniteValue(item.indicators?.rsi) ? Number(item.indicators.rsi).toFixed(1) : '—'; const score = hasFiniteValue(item.totalScore) ? Number(item.totalScore).toFixed(0) : '—'; return `<tr><td><span class="pilot-asset-name"><i class="pilot-asset-dot" aria-hidden="true"></i>${escapeHtml(item.symbol || symbolOf(item.coin))}</span></td><td class="pilot-table-number">${price}</td><td class="pilot-table-number ${hasFiniteValue(item.change24h) ? classForValue(item.change24h) : ''}">${change}</td><td class="pilot-table-number">${rsi}</td><td>${escapeHtml(macdSignalLabel(item.indicators?.macdSignal))}</td><td class="pilot-table-number"><strong>${score}</strong></td><td><span class="pilot-status-pill ${tone}">${escapeHtml(analysisRecommendationLabel(action))}</span></td><td><button type="button" class="pilot-table-action" data-pilot-analysis-coin="${escapeHtml(item.coin)}">거래 검토</button></td></tr>`; }).join('');
    }

    function sentimentInfo(sentiment) {
        const overall = String(sentiment?.overall || sentiment?.label || 'neutral').toLowerCase(); const score = number(sentiment?.score || sentiment?.sentimentScore);
        if (overall.includes('positive') || overall.includes('긍정') || score > 0.15) return { key: 'positive', label: '긍정적', className: '', copy: '분석한 기사에서는 긍정 의견이 더 많습니다.' };
        if (overall.includes('negative') || overall.includes('부정') || score < -0.15) return { key: 'negative', label: '부정적', className: 'is-negative', copy: '분석한 기사에서는 부정 의견이 더 많습니다.' };
        return { key: 'neutral', label: '중립', className: 'is-neutral', copy: '분석한 기사에서 뚜렷한 방향이 보이지 않습니다.' };
    }

    function articleSentimentInfo(item) {
        const raw = item?.sentiment;
        const overall = typeof raw === 'string' ? raw : raw?.overall || raw?.label;
        const score = raw?.score ?? raw?.sentimentScore ?? item?.sentimentScore ?? item?.score;
        if (!overall && !hasFiniteValue(score)) return null;
        return sentimentInfo({ overall, score });
    }

    function newsFocusKey(item, index) {
        const identity = item?.id ?? item?.guid ?? item?.link ?? item?.url ?? item?.title;
        return identity === null || identity === undefined || String(identity).trim() === ''
            ? `position:${index}`
            : `article:${String(identity)}`;
    }

    function findNewsFocusTarget(newsRows, returnFocusKey, returnFocusIndex) {
        const matchingRow = newsRows.find(row => row.dataset.pilotNewsKey === returnFocusKey);
        const nearestRowIndex = Math.min(Math.max(Number(returnFocusIndex) || 0, 0), newsRows.length - 1);
        return matchingRow || newsRows[nearestRowIndex] || null;
    }

    function renderNews() {
        const data = state.news; const loaded = data !== null && data !== undefined; const allNews = Array.isArray(data?.news) ? data.news : [];
        const sentimentRaw = data?.sentiment;
        const sentimentOverall = typeof sentimentRaw === 'string' ? sentimentRaw : sentimentRaw?.overall || sentimentRaw?.label;
        const sentimentScore = sentimentRaw?.score ?? sentimentRaw?.sentimentScore ?? data?.sentimentScore ?? data?.score;
        const hasSentiment = hasFiniteValue(sentimentScore) || Boolean(sentimentOverall);
        const sentiment = loaded && allNews.length > 0 && hasSentiment ? sentimentInfo({ overall: sentimentOverall, score: sentimentScore }) : null;
        const scoreElement = byId('pilot-news-score');
        if (scoreElement) {
            const score = hasFiniteValue(sentimentScore) ? Number(sentimentScore) : null;
            scoreElement.textContent = score === null || !allNews.length ? '—' : score >= 0 ? `+${score.toFixed(2)}` : score.toFixed(2);
            scoreElement.className = `pilot-sentiment-score ${sentiment?.className || ''}`;
        }
        const sentimentTitle = state.newsError ? '최신 뉴스를 확인하지 못했습니다.'
            : !loaded ? state.newsLoading ? '뉴스를 불러오는 중입니다.' : '뉴스가 아직 조회되지 않았습니다.'
                : !allNews.length ? '분석할 뉴스가 없습니다.'
                    : !sentiment ? '기사 분위기 미제공' : `${sentiment.label} 기사 분위기`;
        const sentimentCopy = state.newsError ? loaded && allNews.length ? '아래 내용은 마지막으로 받은 자료입니다. 연결 후 새로고침해 주세요.' : '연결 상태를 확인한 뒤 새로고침해 주세요.'
            : !loaded ? state.newsLoading ? '잠시만 기다려 주세요.' : '뉴스를 확인하려면 새로고침을 눌러 주세요.'
                : !allNews.length ? '새로 확인된 뉴스가 없습니다.'
                    : !sentiment ? `기사 ${allNews.length}건의 분위기를 확인할 수 없습니다.`
                        : `${sentiment.copy} · 분석 기사 ${allNews.length}건`;
        setText('pilot-news-sentiment-title', sentimentTitle);
        setText('pilot-news-sentiment-copy', sentimentCopy);
        const filter = state.newsFilter || 'all'; const news = allNews.filter(item => filter === 'all' || articleSentimentInfo(item)?.key === filter); const target = byId('pilot-news-list'); if (!target) return;
        if (!news.length) {
            const emptyMessage = state.newsError ? '뉴스를 불러오지 못했습니다. 연결 상태를 확인해 주세요.'
                : !loaded ? state.newsLoading ? '뉴스를 불러오는 중입니다.' : '뉴스를 확인하려면 새로고침을 눌러 주세요.'
                    : allNews.length ? '선택한 분류의 뉴스가 없습니다.' : '표시할 뉴스가 없습니다.';
            target.innerHTML = `<div class="pilot-empty-panel"><i class="ph ph-newspaper" aria-hidden="true"></i>${escapeHtml(emptyMessage)}</div>`;
            return;
        }
        target.innerHTML = news.slice(0, 80).map((item, index) => { const info = articleSentimentInfo(item); return `<button type="button" class="pilot-news-row" data-pilot-news-index="${index}" data-pilot-news-key="${escapeHtml(newsFocusKey(item, index))}"><span><strong class="pilot-news-title">${escapeHtml(item.title || '제목 없음')}</strong><span class="pilot-news-meta">${escapeHtml(item.source || item.publisher || '출처 미상')} · ${escapeHtml(formatDateTime(item.timestamp || item.pubDate || item.publishedAt))}</span></span><span class="pilot-news-sentiment-pill ${info?.className || ''}">${escapeHtml(info?.label || '분류 없음')}</span></button>`; }).join('');
    }

    function formatReadinessAge(seconds) {
        if (seconds === null || seconds === undefined || seconds === '') return '확인 불가';
        const value = Number(seconds);
        if (!Number.isFinite(value) || value < 0) return '확인 불가';
        const wholeSeconds = Math.floor(value);
        if (wholeSeconds < 60) return `${wholeSeconds}초`;
        const wholeMinutes = Math.floor(wholeSeconds / 60);
        if (wholeMinutes < 60) return `${wholeMinutes}분`;
        return `${Math.floor(wholeMinutes / 60)}시간 ${wholeMinutes % 60}분`;
    }

    function renderGateAuditDetails(readiness) {
        const report = readiness?.report || {};
        const freshness = report.freshness || {};
        const gate = readiness?.liveGate || {};
        const runtime = readiness?.runtime || {};
        const freshnessLabel = freshness.fresh === true
            ? '최근 생성'
            : freshness.fresh === false ? '오래됨' : '확인 불가';
        const freshnessReasonLabels = {
            fresh: '최근 생성 기준 충족',
            stale: '다시 점검해야 함',
            future_timestamp: '작성 시각을 확인할 수 없음',
            timestamp_missing_or_invalid: '작성 시각을 확인할 수 없음'
        };
        const freshnessReason = freshnessReasonLabels[freshness.reason] || '추가 정보 없음';
        const gateResult = gate.checked === true
            ? gate.passed === true ? '통과' : '미통과'
            : '점검할 수 없음';
        const gateApplicability = gate.enforced === true
            ? '실제 주문에서 이 점검을 사용함'
            : gate.enforced === false ? '실제 주문에서는 이 점검을 사용하지 않음' : '적용 여부 확인 불가';
        const freshnessEnforcement = gate.enforcedFreshness === true
            ? '점검 자료의 작성 시점을 주문 조건에 반영함'
            : gate.enforcedFreshness === false ? '점검 자료의 작성 시점을 주문 조건에 반영하지 않음' : '확인 불가';
        const runtimeMode = runtime.dryRun === true
            ? '모의투자'
            : runtime.dryRun === false ? '실거래' : '확인 불가';
        const validationMode = report.validationMode === 'fixed_config'
            ? '고정 설정'
            : report.validationMode ? '확인 필요' : '확인 불가';
        const promoted = report.promoted === true
            ? '리포트에 적용 후보 표시 있음'
            : report.promoted === false ? '리포트에 적용 후보 표시 없음' : '확인 불가';
        const currentEvidence = readiness?.currentEvidence === true
            ? '주문 전 점검 통과'
            : readiness?.currentEvidence === false ? '주문 전 점검 미통과' : '확인 불가';
        const age = formatReadinessAge(freshness.ageSeconds);
        const maxAge = formatReadinessAge(freshness.maxAgeSeconds);

        return `
            <details class="pilot-validation-audit">
                <summary><span>점검 결과와 사용 범위</span><span class="pilot-validation-audit-hint">작성 시점과 적용 여부</span></summary>
                <dl class="pilot-validation-audit-grid">
                    <div><dt>점검 자료</dt><dd>${report.filename ? '리포트에 포함됨' : '확인 불가'}</dd></div>
                    <div><dt>점검 시각</dt><dd>${escapeHtml(report.generatedAt ? formatDateTime(report.generatedAt) : '확인 불가')}</dd></div>
                    <div><dt>작성 시점</dt><dd><span class="pilot-validation-audit-state ${freshness.fresh === true ? 'is-good' : freshness.fresh === false ? 'is-caution' : ''}">${freshnessLabel}</span><span>${escapeHtml(age)} / ${escapeHtml(maxAge)} 기준 · ${escapeHtml(freshnessReason)}</span></dd></div>
                    <div><dt>점검 설정</dt><dd>${validationMode} · ${promoted}</dd></div>
                    <div><dt>실제 주문 조건 확인</dt><dd><span class="pilot-validation-audit-state ${gate.checked === true && gate.passed === true ? 'is-good' : gate.checked === true ? 'is-caution' : ''}">${gateResult}</span><span>${gateApplicability}</span></dd></div>
                    <div><dt>작성 시점 반영 여부</dt><dd>${freshnessEnforcement}</dd></div>
                    <div><dt>현재 거래 모드</dt><dd>${runtimeMode}</dd></div>
                    <div><dt>점검 종합 결과</dt><dd>${currentEvidence}</dd></div>
                </dl>
                <p class="pilot-validation-audit-note">이 화면은 점검 결과의 작성 시점과 현재 주문 조건을 보여줍니다. 실제 체결 여부나 지속적인 수익은 확인할 수 없습니다.</p>
            </details>`;
    }

    function renderValidationDetail() {
        const readiness = state.strategyReadiness;
        const classification = classifyReadiness(readiness);
        const { report, ready, blocked, stateLabel, headline, description, reasons } = classification;
        const target = byId('pilot-validation-detail');
        const pill = byId('pilot-validation-status-pill');
        if (!target || !pill) return;
        const auditWasOpen = target.querySelector('.pilot-validation-audit')?.open === true;
        byId('pilot-validation-confidence')?.remove();
        pill.textContent = stateLabel;
        pill.className = `pilot-status-pill ${ready ? 'is-ready' : blocked ? 'is-danger' : 'is-warning'}`;
        setText('pilot-validation-meta', report?.generatedAt ? `마지막 점검 ${formatDateTime(report.generatedAt)}` : '점검 작성 시각 확인 불가');

        const reasonsMarkup = reasons.length
            ? `<ul class="pilot-validation-blockers">${reasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>`
            : '';
        const mark = ready ? '✓' : blocked ? '!' : '?';
        target.innerHTML = `
            <div class="pilot-validation-detail">
                <div class="pilot-validation-overview">
                    <span class="pilot-validation-mark ${ready ? 'is-ready' : blocked ? 'is-blocked' : ''}" aria-hidden="true">${mark}</span>
                    <div><div class="pilot-validation-headline">${headline}</div>${description ? `<div class="pilot-validation-copy">${description}</div>` : ''}</div>
                </div>
                ${reasonsMarkup}
                ${renderGateAuditDetails(readiness)}
            </div>`;
        if (auditWasOpen) {
            const audit = target.querySelector('.pilot-validation-audit');
            if (audit) audit.open = true;
        }
    }

    function renderPaperDetail() {
        const status = state.paper;
        const target = byId('pilot-paper-detail');
        if (!target) return;
        byId('pilot-paper-confidence')?.remove();
        const notStarted = status?.available === false && status?.reason === 'paper_validation_session_not_started';
        const knownStatus = status?.available === true || notStarted;
        const running = status?.available === true && status?.active === true;
        const readOnly = status?.readOnlyObserver === true;
        const headerStart = root.querySelector('.pilot-panel-header [data-pilot-action="start-paper"]');
        const headerStop = root.querySelector('.pilot-panel-header [data-pilot-action="stop-paper"]');
        if (headerStart) {
            headerStart.dataset.pilotSessionDisabled = String(!knownStatus || running);
            headerStart.disabled = !knownStatus || running || readOnly;
        }
        if (headerStop) {
            headerStop.dataset.pilotSessionDisabled = String(!running);
            headerStop.disabled = !running || readOnly;
        }
        if (notStarted) {
            setText('pilot-paper-meta', '아직 시작하지 않음');
            target.innerHTML = '<div class="pilot-paper-status"><div class="pilot-paper-status-head"><strong class="pilot-paper-state is-stopped">진행 중인 모의투자가 없습니다.</strong></div><div class="pilot-paper-meta">현재 가상 자산을 유지하거나 처음 금액으로 다시 시작할 수 있습니다.</div><div class="pilot-paper-actions"><button type="button" class="pilot-button" data-pilot-action="start-paper">현재 자산으로 시작</button><button type="button" class="pilot-button is-danger" data-pilot-action="start-paper-reset">초기화 후 시작</button></div><div class="pilot-inline-note">초기화하면 가상 잔액과 보유 코인, 전략별 포지션·매매 기록이 삭제됩니다.</div></div>';
            syncObserverControls();
            return;
        }
        if (!knownStatus) {
            setText('pilot-paper-meta', '상태를 확인할 수 없습니다.');
            target.innerHTML = '<div class="pilot-paper-status"><div class="pilot-paper-status-head"><strong class="pilot-paper-state is-stopped">모의투자 상태 확인 필요</strong></div><div class="pilot-paper-meta">모의투자 상태를 불러오지 못해 시작하거나 초기화할 수 없습니다.</div></div>';
            syncObserverControls();
            return;
        }
        const stateLabel = running ? '모의투자 실행 중' : '모의투자 중지됨';
        const hasProblem = status.orphaned === true || status.riskMonitor?.failClosed === true || status.analysisDataHealth?.failClosed === true;
        const configChanged = status.configConsistent === false;
        const openCountValue = status.strictEvaluation?.activePositions;
        const openCount = hasFiniteValue(openCountValue) ? Number(openCountValue) : null;
        const closedTradeCountValue = status.strictEvaluation?.closedTradeCount ?? status.closedTradeCount;
        const closedTradeCount = hasFiniteValue(closedTradeCountValue) ? Number(closedTradeCountValue) : null;
        const signalWindowCoverage = status.strictEvaluation?.signalWindowCoverage || null;
        const signalWindowCoverageText = closedTradeCount > 0
            ? !signalWindowCoverage
                ? ' · 신호 시점 구분 불가'
                : signalWindowCoverage.unlinkedTradeCount > 0
                    ? ` · 신호 시점 연결 ${number(signalWindowCoverage.linkedTradeCount)}/${number(signalWindowCoverage.tradeCount)}건`
                    : ` · 고유 신호 시점 ${number(signalWindowCoverage.uniqueSignalWindowCount)}개${number(signalWindowCoverage.clusteredTradeCount) > 0 ? ` · 같은 시점 추가 ${number(signalWindowCoverage.clusteredTradeCount)}건` : ''}`
            : '';
        const riskMonitor = status.riskMonitor || {};
        const recordedProfitLabel = readOnly ? '수수료 반영 기록' : '실현 손익';
        const watchdogTelemetryAvailable = number(riskMonitor.watchdogTelemetryVersion) >= 1 &&
            hasFiniteValue(riskMonitor.maxWatchdogTickGapMs);
        const watchdogGapMs = Number(riskMonitor.maxWatchdogTickGapMs);
        const watchdogGapLabel = watchdogTelemetryAvailable
            ? watchdogGapMs >= 1000 ? `${(watchdogGapMs / 1000).toFixed(1)}초` : `${Math.round(watchdogGapMs)}밀리초`
            : '이전 세션 기록 없음';
        const signalFunnel = status.signalAvailability?.signalFunnel || {};
        const signalFunnelAvailable = status.signalTelemetry?.available === true &&
            Number(signalFunnel.version) === 1 &&
            ['availableWindows', 'oversoldWindows', 'bullishWindows', 'priceReboundWindows', 'confirmedWindows']
                .every(key => hasFiniteValue(signalFunnel[key]));
        const signalFunnelStages = [
            ['분석 완료', signalFunnel.availableWindows],
            ['과매도', signalFunnel.oversoldWindows],
            ['양봉 확인', signalFunnel.bullishWindows],
            ['반등', signalFunnel.priceReboundWindows],
            ['확정', signalFunnel.confirmedWindows]
        ];
        const signalFunnelMarkup = signalFunnelAvailable
            ? `<div class="pilot-paper-signal-funnel" role="group" aria-label="완료된 캔들별 매수 조건 점검"><div class="pilot-paper-signal-funnel-head"><strong>신호 흐름</strong><span>완료된 캔들 기준 집계 · 참고용</span></div><div class="pilot-paper-signal-funnel-steps">${signalFunnelStages.map(([label, value]) => `<div class="pilot-paper-signal-step"><span>${label}</span><strong>${number(value)}</strong></div>`).join('')}</div><p>완료된 캔들 중 각 조건에 해당한 횟수입니다. 거래 횟수나 수익을 뜻하지 않으며, 이 수치에 따라 조건을 자동으로 낮추지 않습니다.</p></div>`
            : '';
        const openPositionMarkNote = openCount === null
            ? '<div class="pilot-inline-note pilot-paper-mark-note">보유 포지션 수를 확인할 수 없어 평가손익 범위를 표시하지 않았습니다.</div>'
            : openCount > 0
                ? '<div class="pilot-inline-note pilot-paper-mark-note">평가 자산·수익률에는 미청산 포지션 평가손익이 포함됩니다. 실현 손익은 청산된 거래만 반영합니다.</div>'
                : '';
        const costAudit = status.strictExecutionCostAudit;
        const costAuditFullyApplied = costAudit?.slippageAppliedToStrictPaperLedger === true;
        const unmodeledExecutionTradeCount = hasFiniteValue(costAudit?.unmodeledExecutionTradeCount)
            ? Number(costAudit.unmodeledExecutionTradeCount) : null;
        const configuredSlippage = hasFiniteValue(costAudit?.configuredSlippagePercent)
            ? `${Number(costAudit.configuredSlippagePercent).toFixed(2)}%` : '미제공';
        const costAuditHeadline = costAuditFullyApplied
            ? `예상 체결 가격 차이 반영 손익 ${formatSignedWon(costAudit?.recordedNetPnlKrw)}`
            : `기록 손익 ${formatSignedWon(costAudit?.recordedNetPnlKrw)} · 미반영 거래 ${unmodeledExecutionTradeCount === null ? '미제공' : `${unmodeledExecutionTradeCount}건`}에 양방향 가격 차이 ${configuredSlippage} 적용 시 ${formatSignedWon(costAudit?.costStressedNetPnlKrw)}`;
        const costAuditExplanation = costAuditFullyApplied
            ? '예상 체결 가격 차이는 모의투자 기록에 반영되어 있습니다. 실제 체결 결과와 호가 차이는 확인되지 않았습니다.'
            : '기록된 수량에 가정한 가격 차이를 적용한 참고 계산입니다. 실제 체결 결과와 호가 차이는 포함하지 않습니다.';
        const breakEvenSlippageRate = Number(costAudit?.breakEvenAdditionalSlippagePerSidePercent);
        const breakEvenSlippageLine = costAudit?.breakEvenAdditionalSlippagePerSidePercent !== null &&
            costAudit?.breakEvenAdditionalSlippagePerSidePercent !== undefined &&
            Number.isFinite(breakEvenSlippageRate)
            ? `<br>기록 손익이 0이 되는 추가 가격 차이: 매수·매도 각각 ${breakEvenSlippageRate.toFixed(3)}%`
            : '';
        const strictCostAuditNote = readOnly && closedTradeCount === null
            ? '<div class="pilot-inline-note pilot-paper-mark-note"><span>청산 거래 수를 확인할 수 없어 비용 비교를 표시하지 않았습니다.</span></div>'
            : readOnly && closedTradeCount > 0
                ? costAudit?.available === true && hasFiniteValue(costAudit.evaluatedTradeCount) && Number(costAudit.evaluatedTradeCount) > 0
                    ? `<div class="pilot-inline-note pilot-paper-mark-note"><span><strong>${costAuditHeadline}</strong><br>${costAuditExplanation}${breakEvenSlippageLine}</span></div>`
                    : '<div class="pilot-inline-note pilot-paper-mark-note"><span>비용 민감도를 계산할 자료가 충분하지 않습니다. 기록 손익만으로 수익성을 판단하지 않습니다.</span></div>'
                : '';
        const forwardCohort = state.momentumShadow?.paperForwardCohort;
        const cohortEligibleValue = forwardCohort?.profitabilityEvidenceSessionCount;
        const cohortEligibleSessions = hasFiniteValue(cohortEligibleValue) ? Number(cohortEligibleValue) : null;
        const cohortConfigValue = forwardCohort?.profitabilityEvidenceConfigCount;
        const cohortConfigCount = hasFiniteValue(cohortConfigValue) ? Number(cohortConfigValue) : null;
        const cohortSessionValue = forwardCohort?.sessionCount;
        const cohortSessionCount = hasFiniteValue(cohortSessionValue) ? Number(cohortSessionValue) : null;
        const cohortStrictTradeValue = forwardCohort?.strictTradeCount;
        const cohortStrictTradeCount = hasFiniteValue(cohortStrictTradeValue) ? Number(cohortStrictTradeValue) : null;
        const cohortNetPnl = hasFiniteValue(forwardCohort?.profitabilityEvidenceProfit)
            ? formatSignedWon(forwardCohort.profitabilityEvidenceProfit)
            : cohortEligibleSessions === null ? '비교 가능한 실행 수를 확인할 수 없습니다.'
                : cohortEligibleSessions === 0 ? '아직 비교 기준을 모두 통과한 실행이 없습니다.'
                    : cohortConfigCount !== null && cohortConfigCount > 1 ? '설정이 달라 손익을 합쳐 계산하지 않았습니다.' : '수익 여부를 판단하기에 자료가 부족합니다.';
        const cohortFillLabel = forwardCohort?.actualFillsObserved === true ? '관측됨' : forwardCohort?.actualFillsObserved === false ? '미관측' : '확인 불가';
        const cohortUnverifiedTrades = hasFiniteValue(forwardCohort?.strictCostUnverifiedTradeCount)
            ? `${number(forwardCohort.strictCostUnverifiedTradeCount)}건`
            : '확인 불가';
        const profitabilityCohortNote = readOnly && forwardCohort
            ? `<div class="pilot-inline-note pilot-paper-mark-note"><span><strong>모의투자 실행 ${cohortSessionCount === null ? '미제공' : `${cohortSessionCount}회`} · 기본 조건 거래 종료 ${cohortStrictTradeCount === null ? '미제공' : `${cohortStrictTradeCount}건`}</strong><br>수익성 검증에 포함된 실행 ${cohortEligibleSessions === null ? '미제공' : `${cohortEligibleSessions}회`} · 손익 ${cohortNetPnl}<br>실제 체결 기록 ${cohortFillLabel} · 비용 확인 불가 ${cohortUnverifiedTrades}</span></div>`
            : '';
        setText('pilot-paper-meta', `마지막 갱신 ${formatDateTime(status.updatedAt || status.heartbeatAt || status.lastHeartbeat)}`);
        target.innerHTML = `<div class="pilot-paper-status"><div class="pilot-paper-status-head"><strong class="pilot-paper-state ${running ? '' : 'is-stopped'}">${stateLabel}</strong><span class="pilot-status-pill ${hasProblem ? 'is-danger' : running ? '' : 'is-warning'}">${hasProblem ? '상태 확인 필요' : running ? '진행 중' : '중지'}</span></div><div class="pilot-paper-meta">평가 자산 ${formatWon(status.currentAssets)} · 평가 수익률 ${formatPercent(status.returnPercent)}<br>${recordedProfitLabel} ${formatSignedWon(status.realizedProfit)} · 청산 ${closedTradeCount === null ? '미제공' : `${closedTradeCount}회`}${signalWindowCoverageText} · 보유 ${openCount === null ? '미제공' : `${openCount}개`}<br>위험 점검 사이 최대 간격 ${watchdogGapLabel}</div>${openPositionMarkNote}${strictCostAuditNote}${profitabilityCohortNote}${signalFunnelMarkup}${hasProblem ? '<div class="pilot-paper-orphan-alert">연결이나 시세에 문제가 있어 새 매매를 중지했습니다.</div>' : ''}${configChanged ? '<div class="pilot-inline-note">설정이 바뀌어 이 모의투자 기록은 현재 설정과 일치하지 않습니다.</div>' : ''}</div>`;
        syncObserverControls();
    }

    function renderSettings() {
        const settings = state.settings; if (!settings) return;
        const ranges = settings.ranges || {}; const values = settings.values || {}; const list = byId('pilot-settings-list');
        if (list) {
            const toggles = [
                { key: 'marketRegimeEnabled', label: '시장 방향성 필터', description: '전체 시장 방향이 약할 때 신규 진입을 차단하는 설정입니다.', value: settings.investmentConfig?.scalping?.marketRegimeEnabled === true },
                { key: 'requireReboundBelowOverbought', label: '반등 과매수 보호', description: '반등 매수 조건 충족 시 RSI가 과매수이면 늦은 진입을 막는 설정입니다.', value: settings.investmentConfig?.scalping?.requireReboundBelowOverbought === true }
            ];
            const toggleHtml = toggles.map(item => `<div class="pilot-setting-row"><div><span class="pilot-setting-label">${escapeHtml(toUserText(item.label))}</span><span class="pilot-setting-description">${escapeHtml(toUserText(item.description))}</span></div><label class="pilot-switch"><input type="checkbox" data-pilot-setting-key="${item.key}" ${item.value ? 'checked' : ''}><span class="pilot-switch-track"></span></label></div>`).join('');
            const rangeCategories = {
                Investment: { label: '투자 규모', description: '한 번의 매매에 사용할 자금을 정합니다.', order: 0, open: true },
                Trading: { label: '매매 기준', description: '기본 매수·매도 판단 기준입니다.', order: 1, open: false },
                Scalping: { label: '진입과 청산', description: '반등 확인, 재진입, 보유 시간 조건입니다.', order: 2, open: true },
                Risk: { label: '위험 관리', description: '시세 공백과 손실 상황에서 동작을 제한합니다.', order: 3, open: true },
                RSI: { label: 'RSI 지표', description: '과매도·과매수와 회복을 계산합니다.', order: 4, open: false },
                MACD: { label: 'MACD 지표', description: '추세 변화 신호를 계산합니다.', order: 5, open: false },
                '볼린저 밴드': { label: '볼린저 밴드', description: '가격 변동 범위를 계산합니다.', order: 6, open: false },
                EMA: { label: '이동 평균', description: '짧은 흐름부터 긴 흐름까지 비교합니다.', order: 7, open: false },
                Volume: { label: '거래량', description: '시장 거래 활동을 기준으로 삼습니다.', order: 8, open: false }
            };
            const groupedRanges = new Map();
            Object.entries(ranges).forEach(([key, range]) => {
                const category = range?.category || 'Other';
                if (!groupedRanges.has(category)) groupedRanges.set(category, []);
                groupedRanges.get(category).push([key, range || {}]);
            });
            const rangeHtml = [...groupedRanges.entries()]
                .sort(([left], [right]) => (rangeCategories[left]?.order ?? 99) - (rangeCategories[right]?.order ?? 99))
                .map(([category, entries]) => {
                    const meta = rangeCategories[category] || { label: '기타 설정', description: '추가 전략 조정 항목입니다.', open: false };
                    const rows = entries.map(([key, range]) => {
                        const raw = values[key] ?? range.min ?? 0;
                        const display = key === 'investmentRatio' ? number(raw) * 100 : raw;
                        return `<div class="pilot-setting-row"><div><span class="pilot-setting-label">${escapeHtml(toUserText(range.label || key))}</span><span class="pilot-setting-description">${escapeHtml(toUserText(range.description || ''))}</span></div><div class="pilot-setting-control"><input class="pilot-input" type="number" data-pilot-setting-key="${escapeHtml(key)}" data-pilot-setting-kind="number" data-pilot-setting-display="${key === 'investmentRatio' ? 'percent' : 'raw'}" min="${escapeHtml(key === 'investmentRatio' ? number(range.min) * 100 : range.min)}" max="${escapeHtml(key === 'investmentRatio' ? number(range.max) * 100 : range.max)}" step="${escapeHtml(key === 'investmentRatio' ? number(range.step) * 100 : range.step)}" value="${escapeHtml(display)}"></div></div>`;
                    }).join('');
                    return `<details class="pilot-settings-category" data-pilot-settings-category="${escapeHtml(category)}"${meta.open ? ' open' : ''}><summary><span class="pilot-settings-category-copy"><strong>${escapeHtml(meta.label)}</strong><small>${escapeHtml(meta.description)}</small></span><span class="pilot-settings-category-count">${entries.length}개</span></summary><div class="pilot-settings-category-body">${rows}</div></details>`;
                }).join('');
            const toggleSection = `<details class="pilot-settings-category" data-pilot-settings-category="filters" open><summary><span class="pilot-settings-category-copy"><strong>시장 필터</strong><small>신규 진입 조건을 제한하는 추가 보호입니다.</small></span><span class="pilot-settings-category-count">${toggles.length}개</span></summary><div class="pilot-settings-category-body">${toggleHtml}</div></details>`;
            const lock = paperEvidenceMutationLock();
            const lockNote = lock
                ? `<div class="pilot-inline-note" style="margin-bottom:12px; border-color:var(--sl-amber);"><i class="ph ph-lock-key" aria-hidden="true"></i><span>${escapeHtml(lock.reason || paperEvidenceMutationReason())}</span></div>`
                : '';
            list.innerHTML = lockNote + toggleSection + rangeHtml;
        }
        const presetGrid = byId('pilot-preset-grid');
        if (presetGrid) {
            const presets = settings.presets || [];
            presetGrid.innerHTML = presets.length
                ? presets.map(preset => {
                    const riskLevel = Number(preset.riskLevel);
                    const riskLabel = Number.isFinite(riskLevel) ? `위험 성향 ${riskLevel}/5` : '위험 성향 정보 없음';
                    return `<button type="button" class="pilot-preset-card" data-pilot-preset-id="${escapeHtml(preset.id)}"><span><span class="pilot-preset-name">${escapeHtml(preset.name)}</span></span><span class="pilot-preset-risk" aria-label="${escapeHtml(riskLabel)}">${escapeHtml(riskLabel)}</span></button>`;
                }).join('')
                : '<div class="pilot-inline-empty">프리셋이 없습니다.</div>';
        }
        const optimization = settings.optimization || {}; const controls = byId('pilot-optimization-controls');
        if (controls) {
            controls.innerHTML = `<div class="pilot-control-row"><div class="pilot-control-copy"><strong>자동 후보 비교</strong><span>정한 간격으로 다른 설정을 비교합니다. 결과는 자동으로 적용되지 않습니다.</span></div><label class="pilot-switch"><input type="checkbox" id="pilot-auto-optimization" ${optimization.enabled ? 'checked' : ''}><span class="pilot-switch-track"></span></label></div><div class="pilot-control-row"><div class="pilot-control-copy"><strong>비교 간격</strong><span>다음 확인: ${escapeHtml(formatDateTime(optimization.nextRun))}</span></div><select class="pilot-select" style="max-width:140px" id="pilot-optimization-interval"><option value="3600000">1시간</option><option value="7200000">2시간</option><option value="10800000">3시간</option><option value="21600000">6시간</option><option value="43200000">12시간</option><option value="86400000">24시간</option></select></div><div class="pilot-control-row pilot-optimization-run-row"><div class="pilot-control-copy"><strong>지금 후보 비교</strong><span>현재 설정과 다른 후보의 결과를 비교합니다.</span></div><button type="button" class="pilot-button is-small is-primary" data-pilot-action="run-optimization">비교 시작</button></div>`;
            const interval = byId('pilot-optimization-interval'); if (interval && optimization.interval) interval.value = String(optimization.interval);
        }
        syncObserverControls();
    }

    function renderHistoryTables() {
        const historyTarget = byId('pilot-optimization-history'); const backtestTarget = byId('pilot-backtest-results'); const optimization = state.settings?.optimizationHistory || []; const backtest = state.settings?.backtestResults || [];
        if (historyTarget) historyTarget.innerHTML = optimization.length ? optimization.slice(0, 8).map(item => `<div class="pilot-evidence-row"><span class="pilot-evidence-time">${escapeHtml(formatTime(item.timestamp || item.date))}</span><div><strong class="pilot-evidence-title">${escapeHtml(item.type || item.strategy || '설정 비교')}</strong><div class="pilot-evidence-detail">${escapeHtml(toUserText(item.description || item.message || '비교한 설정 기록'))}</div></div><span class="pilot-evidence-value">${escapeHtml(String(item.fitness ?? item.score ?? '-'))}</span></div>`).join('') : '<div class="pilot-inline-empty">설정 비교 기록이 없습니다.</div>';
        if (backtestTarget) backtestTarget.innerHTML = backtest.length ? `<div class="pilot-evidence-list">${backtest.slice(0, 8).map(item => `<div class="pilot-evidence-row"><span class="pilot-evidence-time">${escapeHtml(symbolOf(item.coin || item.market || '-'))}</span><div><strong class="pilot-evidence-title">${escapeHtml(item.strategy || item.name || '과거 데이터 점검')}</strong><div class="pilot-evidence-detail">거래 ${item.totalTrades || item.tradeCount || 0}회 · 이익/손실 비율 ${item.profitFactor ?? '-'}</div></div><span class="pilot-evidence-value ${classForValue(item.totalReturnPercent || item.returnPercent)}">${formatPercent(item.totalReturnPercent || item.returnPercent)}</span></div>`).join('')}</div>` : '<div class="pilot-inline-empty">과거 데이터 점검 결과가 없습니다.</div>';
        renderStrategyResearch();
        renderMomentumShadow();
        renderQuoteExecutionEvidence();
    }

    function renderQuoteExecutionEvidence() {
        const target = byId('pilot-quote-cost-detail');
        const meta = byId('pilot-quote-cost-meta');
        const status = byId('pilot-quote-cost-status');
        if (!target || !status) return;
        const expandedBeforeRefresh = target.querySelector('.pilot-quote-cost-markets')?.open === true;
        const expandedCandidatesBeforeRefresh = target.querySelector('.pilot-quote-cost-candidates')?.open === true;
        const candidateReadiness = state.momentumShadow?.candidateReadiness;
        const executionCost = candidateReadiness?.executionCost;
        const percentLabel = value => {
            if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) {
                return '확인 불가';
            }
            return `${Number(value).toFixed(3)}%`;
        };
        const candidateBlockerLabels = (Array.isArray(candidateReadiness?.blockers)
            ? candidateReadiness.blockers
            : []).map(blocker => {
                if (blocker === 'candidate_cost_below_round_trip_cost_floor') {
                    return '왕복 거래 비용 가정이 최소 기준에 못 미칩니다.';
                }
                if (blocker === 'quote_quality_report_missing') return '최근 호가 자료가 없어 비교를 시작하지 않습니다.';
                if (blocker === 'quote_quality_report_stale') return '호가 자료가 오래되어 비교를 시작하지 않습니다.';
                if (blocker === 'quote_quality_report_timestamp_invalid') return '호가 자료 시각을 확인할 수 없습니다.';
                if (blocker === 'quote_quality_report_incomplete' || blocker === 'quote_quality_report_errors') {
                    return '호가 수집이 완료되지 않아 비교를 시작하지 않습니다.';
                }
                if (blocker === 'quote_quality_samples_incomplete') return '호가 표본이 충분하지 않습니다.';
                if (blocker === 'quote_quality_market_set_incomplete') return '비교 대상 시장의 호가 자료가 빠져 있습니다.';
                const liveOwnerMatch = String(blocker).match(/^existing_live_owner_count:(\d+)$/);
                if (liveOwnerMatch) return `같은 조건의 비교 작업 ${liveOwnerMatch[1]}개가 이미 실행 중입니다.`;
                if (blocker === 'benchmark_gate_closed') return '기준 시장 자료를 기다리는 중입니다.';
                if (blocker === 'benchmark_heartbeat_stale') return '기준 시장 자료가 오래되었습니다.';
                return null;
            }).filter(Boolean).slice(0, 2);
        const candidatePreflightHtml = executionCost
            ? `<div class="pilot-quote-cost-preflight ${candidateReadiness.launchAllowed ? 'is-ready' : 'is-blocked'}"><div><strong>비교 실행 조건 · ${candidateReadiness.launchAllowed ? '시작 조건 충족' : '시작 조건 미충족'}</strong><span>왕복 비용 가정 ${escapeHtml(percentLabel(executionCost.candidateRoundTripCostPercent))} · 필요 비용 기준 ${escapeHtml(percentLabel(executionCost.requiredRoundTripCostPercent))}</span></div><small>${candidateBlockerLabels.join(' · ') || (candidateReadiness.launchAllowed ? '이 점검은 연구용이며 모의투자 비교용이며 실제 주문 승인과는 별개입니다.' : '추가 시작 조건을 충족하지 못했습니다.')}</small></div>`
            : '';
        const snapshot = state.momentumShadow?.quoteQualitySnapshot;
        const history = snapshot?.history || {};
        const cadence = history.cadence || {};
        const historyStartMs = Date.parse(history.oldestGeneratedAt || '');
        const historyEndMs = Date.parse(history.latestGeneratedAt || '');
        const historyReportCount = Math.max(0, Number(history.reportCount) || 0);
        const historySpanSeconds = historyReportCount > 1 &&
            Number.isFinite(historyStartMs) && Number.isFinite(historyEndMs) && historyEndMs >= historyStartMs
            ? (historyEndMs - historyStartMs) / 1000
            : null;
        const historySpanLabel = historyReportCount === 0
            ? '없음'
            : historySpanSeconds === null ? `${historyReportCount}건` : formatReadinessAge(historySpanSeconds);
        const historyCompleteReportCount = Math.max(0, Number(history.completeReportCount) || 0);
        const historyErrorCount = Math.max(0, Number(history.errorReportCount) || 0);
        const cadenceMaxGap = formatReadinessAge(cadence.maxGapSeconds);
        const cadenceHistorySummary = history.available === true
            ? `<div class="pilot-inline-note"><i class="ph ph-clock-countdown" aria-hidden="true"></i><span>최근 수집 범위 ${escapeHtml(historySpanLabel)} · 정상 ${historyCompleteReportCount}/${historyReportCount}건 · 오류 ${historyErrorCount}건 · 최장 간격 ${escapeHtml(cadenceMaxGap)} · 900초 초과 ${Math.max(0, Number(cadence.gapsOverFreshnessLimit) || 0)}회</span></div>`
            : '';
        if (!snapshot || snapshot.available !== true) {
            if (meta) meta.textContent = '호가 자료를 확인할 수 없음';
            status.textContent = '확인 필요';
            status.className = 'pilot-status-pill is-warning';
            target.innerHTML = `<div class="pilot-inline-empty">호가 자료가 없거나 오래되어 예상 체결 비용을 계산할 수 없습니다.</div>${cadenceHistorySummary}${candidatePreflightHtml}`;
            return;
        }

        const compatibility = snapshot.costCompatibility || {};
        const allMarketCompatibility = snapshot.allObservedMarketCostCompatibility || {};
        const marketRows = Object.entries(snapshot.markets || {});
        const historyMarkets = history.markets || {};
        const depthMinimumReports = Math.max(1, Number(history.minimumDepthReports) || 30);
        const depthCounts = Object.values(historyMarkets).map(row =>
            Math.max(0, Number(row?.topOfBookDepth?.twoSidedDepthReportCount) || 0)
        );
        const minDepthReports = depthCounts.length ? Math.min(...depthCounts) : 0;
        const maxDepthReports = depthCounts.length ? Math.max(...depthCounts) : 0;
        const freshnessLabel = snapshot.fresh === true
            ? '최신'
            : snapshot.fresh === false ? '오래됨' : '확인 불가';
        const requestedSamples = Math.max(0, Number(snapshot.requestedSampleCount) || 0);
        const observedSamples = Math.max(0, Number(snapshot.sampleCount) || 0);
        const errorCount = snapshot.errorCount === null || snapshot.errorCount === undefined
            ? null
            : Math.max(0, Number(snapshot.errorCount) || 0);
        const sampleComplete = snapshot.complete === true && errorCount === 0 &&
            requestedSamples > 0 && observedSamples === requestedSamples;
        const sampleStatus = snapshot.fresh === true && sampleComplete;
        const costRows = new Map((Array.isArray(allMarketCompatibility.rows) ? allMarketCompatibility.rows : [])
            .map(row => [row.market, row]));
        const depthRangeLabel = minDepthReports === maxDepthReports
            ? `${minDepthReports}/${depthMinimumReports}건`
            : `${minDepthReports}–${maxDepthReports}/${depthMinimumReports}건`;
        const fractionPercentLabel = value => value === null || value === undefined || value === ''
            ? '확인 불가'
            : percentLabel(Number(value) * 100);
        const costStatusLabel = code => ({
            P95_WITHIN_ADVERSE_SLIPPAGE_BUDGET: '호가 차이가 설정 기준 이내',
            P95_ABOVE_ADVERSE_SLIPPAGE_BUDGET: '호가 차이가 설정 기준을 초과',
            INSUFFICIENT_SAMPLES: '비용을 비교할 자료가 부족합니다.',
            MISSING_QUOTE_SUMMARY: '비용 자료 없음',
            INVALID_COST_CONFIG: '거래 비용 설정 확인 필요'
        }[code] || '비용 비교 미설정');
        const costStatusClass = code => code === 'P95_ABOVE_ADVERSE_SLIPPAGE_BUDGET'
            ? 'is-caution'
            : code === 'P95_WITHIN_ADVERSE_SLIPPAGE_BUDGET' ? 'is-observed' : '';
        const readinessVariants = Array.isArray(state.momentumShadow?.candidateReadinessVariants)
            ? state.momentumShadow.candidateReadinessVariants
            : [];
        const readyVariantCount = readinessVariants.filter(variant =>
            variant?.readiness?.launchAllowed === true
        ).length;
        const readinessReasonLabel = blocker => {
            const value = String(blocker || '');
            if (value === 'candidate_cost_below_round_trip_cost_floor') return '왕복 비용 가정 미달';
                const ownerMatch = value.match(/^existing_live_owner_count:(\d+)$/);
                if (ownerMatch) return `같은 조건의 비교 작업 ${ownerMatch[1]}개가 이미 실행 중입니다.`;
                if (value === 'benchmark_gate_closed') return '기준 시장 자료를 기다리는 중입니다.';
                if (value === 'benchmark_heartbeat_stale') return '기준 시장 자료가 오래됨';
                if (value === 'benchmark_data_quality_invalid' || value === 'benchmark_data_quality_unverified') {
                    return '기준 시장 자료가 빠졌거나 유효하지 않습니다.';
                }
                if (value === 'target_owner_already_running' || value === 'candidate_slot_occupied') {
                    return '다른 모의투자 비교 작업이 이미 실행 중입니다.';
                }
                if (value === 'benchmark_positions_open') return '아직 정리되지 않은 거래가 있어 새 모의투자를 시작할 수 없습니다.';
                if (value === 'benchmark_trades_exist') return '기존 거래 기록이 있습니다. 먼저 기록을 확인하세요.';
                if (value === 'benchmark_pending_entries') return '주문 처리 중이라 새 모의투자를 시작할 수 없습니다.';
                if (value === 'quote_quality_report_missing') return '최근 호가 자료가 없어 비교를 시작하지 않습니다.';
                if (value === 'quote_quality_report_stale') return '호가 자료가 오래되었습니다.';
                if (value === 'quote_quality_report_timestamp_invalid') return '호가 자료 시각을 확인할 수 없습니다.';
            if (value === 'quote_quality_report_incomplete' || value === 'quote_quality_report_errors') {
                return '호가 자료가 일부 빠졌습니다.';
            }
                if (value === 'quote_quality_samples_incomplete') return '호가 표본이 충분하지 않습니다.';
                if (value === 'quote_quality_market_set_incomplete') return '비교 대상 시장의 호가 자료가 빠져 있습니다.';
            if (value.startsWith('quote_quality_over_ceiling_markets:')) {
                return `호가 차이 기준을 넘은 시장 ${value.split(':').slice(1).join(':').replaceAll('KRW-', '')}`;
            }
            if (value.startsWith('target_config_drift:')) return '비교 대상 설정이 변경됨';
            return '추가 시작 조건을 충족하지 못했습니다.';
        };
        const readinessVariantCards = readinessVariants.map(variant => {
            const readiness = variant?.readiness || {};
            const candidateConfig = readiness.candidateConfig || {};
            const cost = readiness.executionCost;
            const allowed = readiness.launchAllowed === true;
            const blockerReasons = (Array.isArray(readiness.blockers) ? readiness.blockers : [])
                .map(readinessReasonLabel);
            const warningReasons = (Array.isArray(readiness.warnings) ? readiness.warnings : [])
                .map(readinessReasonLabel);
            const reasons = [...new Set([...blockerReasons, ...warningReasons])].slice(0, 3);
            const costValue = Number.isFinite(Number(cost?.candidateRoundTripCostPercent))
                ? cost.candidateRoundTripCostPercent
                : candidateConfig.costPercent;
            const requiredCost = Number.isFinite(Number(cost?.requiredRoundTripCostPercent))
                ? cost.requiredRoundTripCostPercent
                : null;
            const costText = requiredCost === null
                ? `왕복 비용 ${escapeHtml(percentLabel(costValue))}`
                : `왕복 비용 ${escapeHtml(percentLabel(costValue))} · 하한 ${escapeHtml(percentLabel(requiredCost))}`;
            const reasonsText = reasons.length
                ? reasons.join(' · ')
                : allowed ? '모의투자는 시작할 수 있지만 수익성을 확인한 것은 아닙니다.' : '사전 조건 확인 필요';
            return `<article class="pilot-quote-cost-candidate ${allowed ? 'is-ready' : 'is-blocked'}"><div class="pilot-quote-cost-candidate-head"><strong>${escapeHtml(toUserText(variant.label || variant.key || '후보'))}</strong><span>${allowed ? '시작 조건 충족' : '대기'}</span></div><small>${costText}</small><p>${escapeHtml(reasonsText)}</p></article>`;
        }).join('');
        const readinessVariantsHtml = readinessVariants.length
            ? `<details class="pilot-quote-cost-candidates" ${expandedCandidatesBeforeRefresh ? 'open' : ''}><summary><span>모의투자 조건별 사전 확인</span><span class="pilot-quote-cost-candidates-hint">${readyVariantCount}/${readinessVariants.length}개 조건 충족 · 참고용</span></summary><div class="pilot-quote-cost-candidate-grid">${readinessVariantCards}</div><p class="pilot-quote-cost-note">이 조건은 모의투자 비교를 시작할 수 있는지만 확인합니다. 실제 주문·체결이나 수익을 보장하지 않습니다.</p></details>`
            : '';

        if (meta) {
            const generatedAt = snapshot.generatedAt ? formatDateTime(snapshot.generatedAt) : '작성 시각 확인 불가';
            meta.textContent = snapshot.generatedAt
                ? `${generatedAt} 기준 · 자료를 받은 지 ${formatReadinessAge(snapshot.ageSeconds)} 전`
                : '작성 시각 확인 불가';
        }
        status.textContent = sampleStatus ? '최근 자료 확인됨' : '자료 확인 필요';
        status.className = `pilot-status-pill ${sampleStatus ? 'is-warning' : 'is-danger'}`;

        const models = `수수료 ${fractionPercentLabel(compatibility.tradingFee)} (매수·매도 각각) · 예상 가격 차이 ${fractionPercentLabel(compatibility.slippage)} (각각) · 왕복 비용 ${percentLabel(compatibility.assumedRoundTripCostPercent)} · 비교 기준 ${percentLabel(compatibility.adverseSlippageBudgetPercent)}`;
        const marketCards = marketRows.map(([market, row]) => {
            const cost = costRows.get(market);
            const depth = historyMarkets[market]?.topOfBookDepth;
            const depthCount = Math.max(0, Number(depth?.twoSidedDepthReportCount) || 0);
            const depthStatus = depth?.status === 'TOP_OF_BOOK_REFERENCE_ONLY'
                ? `매수 잔량 하위 5% 기준 ${formatWon(depth.p05PerReportMinimumBidNotionalKrw)} · 매도 잔량 ${formatWon(depth.p05PerReportMinimumAskNotionalKrw)}`
                : `양쪽 호가 잔량 ${depthCount}/${depthMinimumReports}건 · 확인 필요`;
            const latestDepth = row?.topOfBookDepth;
            const latestDepthRequested = Math.max(0, Number(latestDepth?.requestedSampleCount) || 0);
            const latestBidSamples = Math.max(0, Number(latestDepth?.bidSampleCount) || 0);
            const latestAskSamples = Math.max(0, Number(latestDepth?.askSampleCount) || 0);
            const latestMinBid = Number(latestDepth?.minimumBidNotionalKrw);
            const latestMinAsk = Number(latestDepth?.minimumAskNotionalKrw);
            const latestDepthComplete = latestDepthRequested > 0 &&
                latestBidSamples === latestDepthRequested && latestAskSamples === latestDepthRequested &&
                Number.isFinite(latestMinBid) && latestMinBid > 0 &&
                Number.isFinite(latestMinAsk) && latestMinAsk > 0;
            const latestDepthLabel = latestDepthComplete
                ? `최근 ${latestDepthRequested}회 중 최저 잔량 · 매수 ${formatWon(latestMinBid)} · 매도 ${formatWon(latestMinAsk)}`
                : `호가 잔량 자료 누락 · 매수 ${latestBidSamples}/${latestDepthRequested}회 · 매도 ${latestAskSamples}/${latestDepthRequested}회`;
            const p95 = Number.isFinite(Number(row?.p95)) ? `${Number(row.p95).toFixed(3)}%` : '—';
            const overCeiling = Math.max(0, Number(row?.overCeiling) || 0);
            const costCode = cost?.status || null;
            return `<article class="pilot-quote-cost-market ${costStatusClass(costCode)}"><div class="pilot-quote-cost-market-head"><strong>${escapeHtml(symbolOf(market))}</strong><span>호가 차이 상위 5% ${escapeHtml(p95)}</span></div><p>${escapeHtml(costStatusLabel(costCode))} · 기준 초과 ${overCeiling}/${Math.max(0, Number(row?.sampleCount) || 0)}회</p><small>${escapeHtml(depthStatus)} · ${escapeHtml(latestDepthLabel)}</small></article>`;
        }).join('');
        const depthText = depthCounts.length
            ? depthRangeLabel
            : '호가 잔량 자료 없음';
        const cadenceText = `기록 범위 ${historySpanLabel} · 수집 주기 ${formatReadinessAge(cadence.expectedIntervalSeconds)} · 최신 자료 기준 ${formatReadinessAge(cadence.freshnessLimitSeconds)}`;
        const cadenceDetail = `${historyCompleteReportCount}/${historyReportCount}건 정상 · 오류 ${historyErrorCount}건 · 상위 5% 간격 ${formatReadinessAge(cadence.p95GapSeconds)} · 최장 간격 ${cadenceMaxGap} · 900초 초과 ${Math.max(0, Number(cadence.gapsOverFreshnessLimit) || 0)}회`;
        const overCeilingMarkets = Array.isArray(snapshot.overCeilingMarkets)
            ? snapshot.overCeilingMarkets.map(symbolOf).join(', ')
            : '';
        const note = '호가 차이와 1단계 잔량만으로 실제 체결이나 실현 손익을 알 수 없습니다. 계산에는 수수료와 예상 체결 가격 차이를 별도로 적용합니다. 이 자료만으로 주문을 허용하거나 막지 않습니다.';
        target.innerHTML = `
            <div class="pilot-quote-cost-overview">
                <div><span>최근 호가 자료</span><strong>${sampleComplete ? `${observedSamples}/${requestedSamples} · ${marketRows.length}마켓` : '불완전 또는 오류'}</strong><small>${freshnessLabel} · ${errorCount === null ? '오류 수 확인 불가' : `오류 ${errorCount}건`}</small></div>
                <div><span>전체 호가 차이</span><strong>상위 5% ${escapeHtml(percentLabel(snapshot.overall?.p95))}</strong><small>최대 ${escapeHtml(percentLabel(snapshot.overall?.max))}</small></div>
                <div><span>왕복 거래 비용 가정</span><strong>${escapeHtml(percentLabel(compatibility.assumedRoundTripCostPercent))}</strong><small>${escapeHtml(models)}</small></div>
                <div><span>매수·매도 호가 잔량</span><strong>${escapeHtml(depthText)}</strong><small>비율은 최소 ${depthMinimumReports}건 수집 후 표시</small></div>
                <div><span>자료 수집 상태</span><strong>${escapeHtml(cadenceText)}</strong><small>${escapeHtml(cadenceDetail)}</small></div>
            </div>
            ${candidatePreflightHtml}
            ${readinessVariantsHtml}
            <details class="pilot-quote-cost-markets">
                <summary><span>시장별 호가 차이와 잔량</span><span class="pilot-quote-cost-markets-hint">${marketRows.length}개 · 참고용</span></summary>
                <div class="pilot-quote-cost-market-grid">${marketCards || '<div class="pilot-inline-empty">시장별 표본이 없습니다.</div>'}</div>
                ${overCeilingMarkets ? `<p class="pilot-quote-cost-note">현재 수집 기준 초과: ${escapeHtml(overCeilingMarkets)}</p>` : ''}
            </details>
            <p class="pilot-quote-cost-note">${note}</p>`;
        if (expandedBeforeRefresh) {
            const disclosure = target.querySelector('.pilot-quote-cost-markets');
            if (disclosure) disclosure.open = true;
        }
        if (expandedCandidatesBeforeRefresh) {
            const disclosure = target.querySelector('.pilot-quote-cost-candidates');
            if (disclosure) disclosure.open = true;
        }
    }

    function renderStrategyResearch() {
        const target = byId('pilot-strategy-research');
        const meta = byId('pilot-strategy-research-meta');
        if (!target) return;
        if (state.strategyResearchLoading) {
            if (meta) meta.textContent = '참고용 · 과거 자료 확인 중';
            target.innerHTML = '<div class="pilot-inline-empty">과거 전략 비교 자료를 불러오고 있습니다.</div>';
            return;
        }
        if (state.strategyResearchError) {
            if (state.strategyResearchError.offline === true) {
                if (meta) meta.textContent = '서버 연결 필요';
                target.innerHTML = '<div class="pilot-inline-empty">서버에 연결한 뒤 과거 전략 비교 자료를 확인할 수 있습니다.</div>';
            } else {
                if (meta) meta.textContent = '비교 자료를 불러오지 못했습니다.';
                target.innerHTML = '<div class="pilot-inline-empty">비교 자료를 불러오지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요. <button type="button" class="pilot-link-button" data-pilot-action="reload-strategy-research">다시 불러오기</button></div>';
            }
            return;
        }
        const report = state.strategyResearch;
        if (!report?.available) {
            if (meta) meta.textContent = report?.reason === 'research_report_not_found'
                ? '지정한 비교 자료를 찾을 수 없습니다.'
                : '비교 자료가 아직 등록되지 않았습니다.';
            target.innerHTML = '<div class="pilot-inline-empty">장기 기간 비교 결과는 별도 리포트를 지정하면 표시됩니다. 이 영역은 실제 주문 조건에 반영되지 않습니다.</div>';
            return;
        }
        const variants = Array.isArray(report.variants) ? report.variants : [];
        if (report.study === 'same_window_scalping_variant_comparison') {
            const variantEntries = Object.entries(report.variants || {});
            const requestedMarketCount = number(report.requestedMarketCount, Array.isArray(report.markets) ? report.markets.length : 0);
            const freshnessLabel = validationReportFreshness(report.generatedAt, report.reportFreshness);
            const staleNote = report.reportFreshness?.fresh === false
                ? `<div class="pilot-inline-note" style="border-color:var(--sl-amber);"><i class="ph ph-clock-countdown" aria-hidden="true"></i><span>이 비교 결과는 ${escapeHtml(freshnessLabel)} 상태입니다. 최신 데이터를 다시 모으기 전까지 수익성을 판단하는 데 쓰지 마세요.</span></div>`
                : '';
            if (meta) meta.textContent = `참고용 · 같은 기간 자료 · 대상 시장 ${requestedMarketCount}개 · ${freshnessLabel} · 실제 주문 조건에는 반영되지 않음`;
            target.innerHTML = variantEntries.length
                ? `${staleNote}<div class="pilot-inline-note"><i class="ph ph-flask" aria-hidden="true"></i><span>같은 기간의 시장 자료로 설정별 결과를 비교합니다. 유효하지 않은 시장이 있거나 학습 구간 기준을 통과하지 못한 결과는 실제 거래 적용 여부를 판단하는 데 쓸 수 없습니다. 비교 결과는 실제 주문이나 모의투자 기본 설정을 바꾸지 않습니다.</span></div><div class="pilot-evidence-list">${variantEntries.slice(0, 12).map(([name, variant]) => { const summary = variant?.summary || {}; const attempted = number(summary.attemptedMarketCount, requestedMarketCount); const valid = number(summary.marketCount); const invalid = number(summary.invalidMarketCount); const invalidMarkets = Array.isArray(summary.invalidMarkets) ? summary.invalidMarkets.map(item => `${item.market || '-'}: ${toUserText(item.error || '점검 불가')}`).join(' · ') : ''; const returnLabel = formatPercent(summary.sumHoldoutReturnPercent); const detail = `유효 시장 ${valid}/${attempted} · 제외된 시장 ${invalid}개 · 거래 ${number(summary.holdoutTradeCount)}회 · 학습 구간 기준 미달 ${number(summary.trainingGateFailures)}회${invalidMarkets ? ` · ${invalidMarkets}` : ''}`; return `<div class="pilot-evidence-row"><span class="pilot-evidence-time">참고용</span><div><strong class="pilot-evidence-title">${escapeHtml(toUserText(name))} · 합산 ${escapeHtml(returnLabel)}</strong><div class="pilot-evidence-detail">${escapeHtml(detail)}</div></div><span class="pilot-evidence-value pilot-negative">이 결과만으로는 적용 여부를 판단할 수 없습니다.</span></div>`; }).join('')}</div>`
                : '<div class="pilot-inline-empty">표시할 설정 비교 결과가 없습니다.</div>';
            return;
        }
        if (report.study === 'daily_momentum_robustness_grid') {
            const shortlist = Array.isArray(report.shortlist) ? report.shortlist : [];
            const nearMisses = Array.isArray(report.nearMisses) ? report.nearMisses : [];
            const items = shortlist.length ? shortlist : nearMisses;
            const statusLabel = status => status === 'SHADOW_CANDIDATE_WITH_STOP'
                ? '손실 제한을 둔 모의투자 후보'
                : status === 'SHADOW_CANDIDATE' ? '모의투자 비교 후보' : '보류';
            const blockerLabel = blocker => ({
                unknown_boundary_position: '구간 경계 미청산',
                segment_data_unavailable: '구간 데이터 부족',
                full_return_below_floor: '전체 수익률 기준 미달',
                drawdown_above_limit: '최대 낙폭 기준 초과',
                worst_segment_below_floor: '가장 많이 하락한 구간이 기준 미달',
                trade_sample_below_minimum: '거래 수 부족'
            }[blocker] || '추가 확인 필요');
            const labelFor = item => {
                const config = item.config || {};
                return `추세 기준 ${formatPercent(config.trendMinPercent)} · 상승 종목 비율 ${(number(config.breadthMin) * 100).toFixed(1)}% 이상 · 투자 비중 ${formatPercent(number(config.positionFraction) * 100)} · 보유 한도 ${number(config.maxPositions)}종목`;
            };
            const statusSummaryLabel = status => status === 'SHADOW_CANDIDATE_WITH_STOP'
                ? '손실 제한 후보'
                : status === 'SHADOW_CANDIDATE' ? '일반 비교 후보' : '보류';
            const thresholdSummary = report.benchmarkThresholdSummary
                ? Object.entries(report.benchmarkThresholdSummary)
                    .map(([threshold, counts]) => `${threshold}% ${Object.entries(counts).map(([status, count]) => `${statusSummaryLabel(status)} ${count}개`).join(' · ')}`)
                    .join(' / ')
                : '비교 기준 없음';
            if (meta) meta.textContent = `참고용 · ${escapeHtml({ continuous: '연속', segments: '분할' }[report.segmentMode] || report.segmentMode || '연속')} 구간 · 통과 후보 ${shortlist.length}개 · 근접 후보 ${nearMisses.length}개 · ${escapeHtml(thresholdSummary)}`;
            target.innerHTML = items.length
                ? `<div class="pilot-inline-note"><i class="ph ph-flask" aria-hidden="true"></i><span>완료된 일봉 자료로 위험 수준을 비교한 참고 결과입니다. 실제 주문이나 모의투자 설정에는 반영되지 않습니다. 크게 하락한 구간과 손실 제한이 작동한 시점을 함께 확인하세요.<br>기준 시장의 상승률별 비교: ${escapeHtml(thresholdSummary)}</span></div><div class="pilot-evidence-list">${items.slice(0, 8).map(item => { const metrics = item.fullMetrics || {}; const blockers = Array.isArray(item.eligibilityBlockers) ? item.eligibilityBlockers.map(blockerLabel).join(' · ') : ''; const risk = item.drawdownStopTriggered ? ' · 손실 제한 작동' : ''; const detail = `${labelFor(item)} · 이익/손실 비율 ${Number.isFinite(Number(metrics.profitFactor)) ? Number(metrics.profitFactor).toFixed(2) : '∞'} · 최대 낙폭 ${formatPercent(metrics.maxDrawdownPercent)} · 가장 많이 하락한 구간 ${formatPercent(item.worstSegmentReturnPercent)} · 거래 ${number(metrics.tradeCount)}회${risk}${blockers ? ` · ${blockers}` : ''}`; return `<div class="pilot-evidence-row"><span class="pilot-evidence-time">${escapeHtml(statusLabel(item.status))}</span><div><strong class="pilot-evidence-title">전체 ${formatPercent(metrics.totalReturnPercent)} · ${escapeHtml(labelFor(item))}</strong><div class="pilot-evidence-detail">${escapeHtml(detail)}</div></div><span class="pilot-evidence-value ${item.status === 'HOLD' ? 'pilot-negative' : 'pilot-positive'}">${escapeHtml(statusLabel(item.status))}</span></div>`; }).join('')}</div>`
                : '<div class="pilot-inline-empty">기준을 통과한 후보가 없습니다. 조건에 근접한 후보와 차단 사유를 확인하세요.</div>';
            return;
        }
        if (meta) meta.textContent = `참고용 · 생성 ${formatDateTime(report.generatedAt)} · ${report.markets?.length || 0}개 시장`;
        target.innerHTML = variants.length
            ? `<div class="pilot-inline-note"><i class="ph ph-flask" aria-hidden="true"></i><span>과거 데이터로 설정별 결과를 비교한 자료입니다. 실제 주문을 내거나 실거래 조건을 바꾸지는 않습니다.</span></div><div class="pilot-evidence-list">${variants.slice(0, 8).map(variant => { const metrics = variant.portfolio?.metrics || variant.fullAggregate || {}; const status = variant.eligibleForFurtherShadow === true && variant.portfolio?.unknownBoundaryPositionCount === 0 ? '모의투자 검토 후보' : '보류'; return `<div class="pilot-evidence-row"><span class="pilot-evidence-time">${escapeHtml(toUserText(String(variant.name || '설정 후보')))}</span><div><strong class="pilot-evidence-title">모의투자 합산 ${formatPercent(metrics.totalReturnPercent)} · ${number(metrics.tradeCount)}회</strong><div class="pilot-evidence-detail">이익/손실 비율 ${Number.isFinite(Number(metrics.profitFactor)) ? Number(metrics.profitFactor).toFixed(2) : '∞'} · 최대 낙폭 ${formatPercent(metrics.maxDrawdownPercent)} · 시장별 구간 ${variant.allMarketFoldsPassed === true ? '통과' : '미달'} · 구간 끝에 남은 포지션 ${number(variant.portfolio?.unknownBoundaryPositionCount)}건</div></div><span class="pilot-evidence-value ${status === '모의투자 검토 후보' ? 'pilot-positive' : 'pilot-negative'}">${status}</span></div>`; }).join('')}</div>`
            : '<div class="pilot-inline-empty">표시할 비교 결과가 없습니다.</div>';
    }

    function loadStrategyResearch({ force = false } = {}) {
        if (!force && state.strategyResearchLoaded) return Promise.resolve(state.strategyResearch);
        if (state.strategyResearchRequest) return state.strategyResearchRequest;
        if (state.online === false) {
            state.strategyResearchError = { offline: true };
            renderStrategyResearch();
            return Promise.resolve(null);
        }

        const requestGeneration = networkGeneration;
        state.strategyResearchLoading = true;
        state.strategyResearchError = null;
        renderStrategyResearch();

        let request;
        request = requestJSON('/strategy-research')
            .then(report => {
                if (requestGeneration !== networkGeneration || state.online === false) return null;
                state.strategyResearch = report;
                state.strategyResearchLoaded = true;
                return report;
            })
            .catch(error => {
                if (requestGeneration === networkGeneration && state.online !== false) {
                    state.strategyResearchError = error;
                }
                return null;
            })
            .finally(() => {
                if (state.strategyResearchRequest === request) {
                    state.strategyResearchRequest = null;
                    state.strategyResearchLoading = false;
                    renderStrategyResearch();
                }
            });
        state.strategyResearchRequest = request;
        return request;
    }

    function renderMomentumShadow() {
        const target = byId('pilot-momentum-shadow');
        const meta = byId('pilot-momentum-shadow-meta');
        const overallStatus = byId('pilot-momentum-shadow-status');
        if (!target) return;
        const expandedCostAuditBooks = new Set(
            [...target.querySelectorAll('details.pilot-momentum-shadow-cost-audit[open]')]
                .map(details => details.dataset.shadowAuditBook)
                .filter(Boolean)
        );
        const projection = state.momentumShadow;
        if (!projection?.available) {
            if (meta) meta.textContent = '모의투자 상태를 불러올 수 없습니다.';
            if (overallStatus) {
                overallStatus.textContent = '확인 필요';
                overallStatus.className = 'pilot-status-pill is-warning';
            }
            target.innerHTML = '<div class="pilot-inline-empty">모의투자 기록이 아직 없습니다.</div>';
            return;
        }
        const books = (Array.isArray(projection.books) ? projection.books : [])
            .filter(book => book?.available === true);
        if (meta) meta.textContent = '완료된 일봉 가격으로 계산한 모의 결과입니다. 실제 주문 체결이나 계좌 정산 내역은 포함하지 않습니다.';
        if (overallStatus) {
            overallStatus.textContent = projection.researchOnly === true && projection.promoted === false
                ? '참고용 · 실거래 적용 보류'
                : '확인 필요';
            overallStatus.className = 'pilot-status-pill is-warning';
        }
        target.innerHTML = books.length
            ? `<div class="pilot-momentum-shadow-grid">${books.map(book => {
                const statusClass = book.status === '관찰 중' ? 'is-warning' : book.status === '중지' ? 'is-danger' : 'is-warning';
                const positions = Array.isArray(book.openPositions) && book.openPositions.length
                    ? book.openPositions.map(position => `${escapeHtml(position.asset)} ${formatPrice(position.entryPrice)} → ${position.markPrice === null ? '—' : formatPrice(position.markPrice)} (${formatOptionalPercent(position.markProfitPercent)})`).join('<br>')
                    : '현재 보유 없음';
                const warning = book.configurationWarning
                    ? '<span class="pilot-momentum-shadow-warning">설정이 바뀌어 이 기록은 현재 설정과 일치하지 않습니다.</span>'
                    : '';
                const confidence = book.realizedTradeConfidence || {};
                const validTradeCount = Math.max(0, Number(confidence.sampleCount) || 0);
                const minimumTradeCount = Math.max(1, Number(book.minimumResearchTrades) || 20);
                const observationDays = Number.isFinite(Number(book.observationDays))
                    ? Number(book.observationDays).toFixed(1)
                    : '확인 불가';
                const minimumResearchDays = Math.max(1, Number(book.minimumResearchDays) || 14);
                const riskControls = book.riskControls || {};
                const currentDrawdownValue = riskControls.drawdownPercent;
                const currentDrawdownNumber = Number(currentDrawdownValue);
                const currentDrawdownLabel = currentDrawdownValue !== null &&
                    currentDrawdownValue !== undefined && currentDrawdownValue !== '' &&
                    Number.isFinite(currentDrawdownNumber) && currentDrawdownNumber >= 0
                    ? `${currentDrawdownNumber.toFixed(2)}%`
                    : '미기록';
                const drawdownLimitNumber = Number(riskControls.maxPortfolioDrawdownPercent);
                const drawdownLimitLabel = Number.isFinite(drawdownLimitNumber) && drawdownLimitNumber > 0
                    ? `${drawdownLimitNumber.toFixed(2)}%`
                    : '미설정';
                const drawdownStopLabel = riskControls.drawdownStopTriggered === true ? ' · 보호 중단 발동' : '';
                const observedDrawdown = book.observedDrawdown || {};
                const observedMddSampleCount = Math.max(0, Number(observedDrawdown.sampleCount) || 0);
                const observedMddValue = observedDrawdown.available === true
                    ? formatOptionalPercent(observedDrawdown.maxDrawdownPercent)
                    : '미기록';
                const observedMddCoverage = observedDrawdown.fullSessionCoverage === true
                    ? observedDrawdown.available === true ? '전체 실행 기간 자료 있음' : '자료 수집 중'
                    : '자료가 일부 빠짐';
                const observedMddIntervalSeconds = observedDrawdown.samplingIntervalMs === null ||
                    observedDrawdown.samplingIntervalMs === undefined ||
                    !Number.isFinite(Number(observedDrawdown.samplingIntervalMs))
                    ? null
                    : Number(observedDrawdown.samplingIntervalMs) / 1000;
                const observedMddMethod = observedMddSampleCount > 0
                    ? `표시 주기 ${observedMddIntervalSeconds === null ? '확인 불가' : formatReadinessAge(observedMddIntervalSeconds)} · 장중 최고점은 포함하지 않음`
                    : '이 거래 기록에는 시간대별 낙폭 자료가 없습니다.';
                const blockers = Array.isArray(book.promotionBlockers) ? book.promotionBlockers : [];
            const blockerSummary = blockers.length
                    ? `${blockers.slice(0, 3).map(reason => escapeHtml(toUserText(reason))).join(' · ')}${blockers.length > 3 ? ` · 외 ${blockers.length - 3}개` : ''}`
                    : '필요한 거래 수는 채웠습니다. 실거래 적용 여부는 별도로 검토해야 합니다.';
                const entryCostFloor = book.entryCostFloor || {};
                const entryCostFloorAvailable = typeof entryCostFloor.ready === 'boolean';
                const entryCostFloorStatus = !entryCostFloorAvailable
                    ? '비용 하한 상태 확인 불가'
                    : entryCostFloor.runtimeGuardActive === true
                        ? entryCostFloor.ready === true
                        ? '비용 기준 통과'
                        : `비용 기준 미달로 새 신호 ${number(entryCostFloor.blockedEntrySignals)}건과 대기 주문 ${number(entryCostFloor.blockedPendingEntries)}건을 막았습니다. 보유 중인 자산 감시는 계속합니다.`
                        : entryCostFloor.ready === true
                            ? '비용 하한 충족 · 주문 차단 조건 적용 기록 없음'
                            : '이전 실행 기록 · 비용 하한 미달 · 차단 조건 적용 여부 확인 불가';
                const entryCostFloorMarkup = `<span>신규 진입 비용 조건 ${formatOptionalPercent(entryCostFloor.configuredCostPercent)} / 하한 ${formatOptionalPercent(entryCostFloor.requiredCostPercent)} · ${escapeHtml(entryCostFloorStatus)}</span>`;
                const profitConcentration = book.profitConcentration || {};
                const profitConcentrationMarkup = profitConcentration.available === true
                    ? `<span>수익 상위 거래 비중 (승리 ${number(profitConcentration.winningTradeCount)}건): 가장 큰 수익 1건 ${formatOptionalPercent(profitConcentration.topWinnerShareOfPositivePnlPercent)} · 가장 큰 수익 2건 ${formatOptionalPercent(profitConcentration.topTwoWinnersShareOfPositivePnlPercent)}</span><span>최대 승리 1건 제외: 95% 신뢰 구간 하한 ${formatOptionalPercent(profitConcentration.confidenceWithoutTopWinner?.lowerBoundPercent)} (${number(profitConcentration.confidenceWithoutTopWinner?.sampleCount)}건) · 결과 확인용이며 실거래 적용 기준은 아님</span>`
                    : '<span>수익 상위 거래 비중: 실현 이익 없음 · 결과 확인용이며 실거래 적용 기준은 아님</span>';
                const profitabilityGate = `<div class="pilot-momentum-shadow-profitability-gate"><strong>${escapeHtml(toUserText(book.promotionStatus || '실거래 적용 보류'))}</strong><span>조건을 충족한 청산 ${validTradeCount}/${minimumTradeCount}회 · 거래 수익률 95% 신뢰 구간 하한 ${formatOptionalPercent(confidence.lowerBoundPercent)} · 관찰 ${observationDays}/${minimumResearchDays}일</span>${entryCostFloorMarkup}${profitConcentrationMarkup}<span>현재 최대 낙폭 ${currentDrawdownLabel} · 손실 제한 ${drawdownLimitLabel}${drawdownStopLabel}</span><span>전체 관측 최대 낙폭 ${observedMddValue} · 자료 ${observedMddSampleCount}건 · ${observedMddCoverage}</span><span>${escapeHtml(observedMddMethod)}</span><span>${blockerSummary}</span></div>`;
                const executionNote = book.executionModelNote
                    ? `<small class="pilot-momentum-shadow-execution-note">${escapeHtml(toUserText(book.executionModelNote))}</small>`
                    : '';
                const costAudit = book.tradeCostAudit;
                let tradeCostAuditHtml = '';
                if (costAudit?.available === true && book.executionModel === 'candle_close') {
                    const bookKey = String(book.key || '');
                    const costAuditOpen = expandedCostAuditBooks.has(bookKey) ? ' open' : '';
                    const full = costAudit.fullCohort || {};
                    const history = costAudit.quoteHistory || {};
                    const matchedCount = Math.max(0, Number(costAudit.quoteMatchedTradeCount) || 0);
                    const closedCount = Math.max(0, Number(costAudit.closedTradeCount) || 0);
                    const unmatchedCount = Math.max(0, Number(costAudit.unmatchedSpreadCostTradeCount) || 0);
                    const optionalWon = value => value === null || value === undefined ||
                        value === '' || !Number.isFinite(Number(value)) ? '—' : formatSignedWon(value);
                    const fullQuoteMedian = full.quoteSpreadAdjustedMedianScenarioNetPnlKrw;
                    const fullQuoteP95 = full.quoteSpreadAdjustedReportP95ScenarioNetPnlKrw;
                    const fullQuoteText = fullQuoteMedian === null || fullQuoteMedian === undefined ||
                        fullQuoteP95 === null || fullQuoteP95 === undefined
                        ? `계산 미완료 · 호가 자료가 맞지 않는 거래 ${unmatchedCount}건`
                        : `중앙값 ${optionalWon(fullQuoteMedian)} · 95백분위 ${optionalWon(fullQuoteP95)}`;
                    const historyText = history.latestFresh === true && history.latestUsable === true
                        ? `호가 기록 최신 업데이트: ${formatReadinessAge(history.latestAgeSeconds)} 전`
                        : '호가 기록 시점을 확인할 수 없음';
                    const ledgerCost = formatOptionalPercent(costAudit.ledgerCostPercent);
                    const requiredCost = formatOptionalPercent(costAudit.requiredRoundTripCostPercent);
                    tradeCostAuditHtml = `<details class="pilot-momentum-shadow-cost-audit" data-shadow-audit-book="${escapeHtml(bookKey)}"${costAuditOpen}><summary><span>호가를 반영한 비용 비교</span><span>${matchedCount}/${closedCount}건 거래 시각 일치 · 참고용</span></summary><div class="pilot-momentum-shadow-cost-grid"><div><span>최소 비용만 뺀 손익</span><strong>${optionalWon(full.costFloorStressNetPnlKrw)}</strong><small>비용 가정 ${ledgerCost} → ${requiredCost} · 호가 차이 제외</small></div><div><span>호가를 반영한 손익</span><strong>${escapeHtml(fullQuoteText)}</strong><small>${historyText}</small></div></div><p class="pilot-momentum-shadow-cost-note">이 비교는 이전 1단계 호가 자료를 사용한 가정입니다. 실제 체결이나 계좌 정산 내역은 아니며, 호가 자료가 없는 거래의 비용은 0으로 계산하지 않았습니다.</p></details>`;
                }
                return `<article class="pilot-momentum-shadow-card"><div class="pilot-momentum-shadow-card-head"><div><strong>${escapeHtml(toUserText(book.label))}</strong><span>${escapeHtml(executionModelLabel(book.executionModel || 'paper'))}</span></div><span class="pilot-status-pill ${statusClass}">${escapeHtml(toUserText(book.status || '확인 필요'))}</span></div><div class="pilot-momentum-shadow-equity ${classForValue(book.markedReturnPercent)}">${formatWon(book.markedEquity)}</div><div class="pilot-momentum-shadow-return ${classForValue(book.markedReturnPercent)}">${formatOptionalPercent(book.markedReturnPercent)} 평가 수익률</div><div class="pilot-momentum-shadow-stats"><span>실현 손익 ${formatSignedWon(book.realizedProfit)}</span><span>실현 수익률 ${formatOptionalPercent(book.realizedReturnPercent)}</span><span>정리된 거래 ${number(book.closedTradeCount)}건</span><span>이익 거래 / 손실 거래 ${number(book.winningTrades)} / ${number(book.losingTrades)}</span></div>${profitabilityGate}${tradeCostAuditHtml}${executionNote}${warning}<div class="pilot-momentum-shadow-positions"><span>비교 거래에서 보유 중인 포지션</span><strong>${positions}</strong></div></article>`;
            }).join('')}</div>`
            : '<div class="pilot-inline-empty">모의투자 기록이 아직 없습니다.</div>';
    }

    function renderAll() {
        renderMode(); renderGateCards(); renderChartPeriodButtons(); renderCoreStats(); renderPositionRows('pilot-overview-positions'); renderPositionRows('pilot-portfolio-positions'); renderActivity(); renderRiskSummary(); renderTradePanels(); renderManualOrderCapacity(); drawEquityChart('pilot-equity-chart', 'pilot-equity-empty', state.portfolioHistory); renderPortfolio(); renderMarketHeader(); renderMarketList(); renderAnalysis(); renderNews(); renderValidationDetail(); renderPaperDetail(); renderStrategyResearch(); renderMomentumShadow(); renderQuoteExecutionEvidence(); syncObserverControls();
    }

    async function loadCore({ quiet = false, afterNetworkRestore = false } = {}) {
        await waitForPwaAuth();
        if (state.refreshing) {
            if (afterNetworkRestore) refreshAfterCurrent = true;
            return;
        }
        const pwaScopeMayRead = state.auth?.authRequired === false && state.auth?.verification === 'not-required' ||
            state.auth?.authRequired === true && state.auth?.resolved === true && state.auth?.verification === 'verified' &&
                ['operator', 'read_only'].includes(state.auth?.tokenScope);
        if (!pwaScopeMayRead || isMobileOperatorPwaScope()) {
            clearUnavailablePwaData();
            renderAll();
            return;
        }
        if (state.online === false) {
            state.coreReady = false;
            state.connected = false;
            renderAll();
            return;
        }
        const requestGeneration = networkGeneration;
        state.refreshing = true;
        syncObserverControls();
        if (!quiet) setConnection(state.coreReady, state.coreReady ? '' : '연결 확인 중');
        const readOnlyScope = isReadOnlyPwaScope();
        if (readOnlyScope && !READ_ONLY_PWA_PORTFOLIO_PERIODS.has(state.chartPeriod)) {
            state.chartPeriod = '24h';
            renderChartPeriodButtons();
        }
        const period = encodeURIComponent(state.chartPeriod || '24h');
        const requests = readOnlyScope
            ? { status: '/status', account: '/account', pnl: '/cumulative-pnl', today: '/today-summary', history: `/portfolio/history?period=${period}`, trades: '/trades?limit=12', marketPrices: '/market/prices/snapshot' }
            : { status: '/status', account: '/account', pnl: '/cumulative-pnl', today: '/today-summary', statistics: '/statistics', validation: '/scalping-validation', strategyReadiness: '/strategy-readiness', paper: '/paper-validation', momentumShadow: '/momentum-shadow', portfolioAnalysis: '/portfolio-analysis', history: `/portfolio/history?period=${period}`, trades: '/trades?limit=12', marketPrices: '/market/prices/snapshot', targetCoins: '/target-coins' };
        const settled = await Promise.all(Object.entries(requests).map(async ([key, path]) => { try { return [key, await requestJSON(path)]; } catch (error) { return [key, null, error]; } }));
        const marketPricesIndex = settled.findIndex(([key]) => key === 'marketPrices');
        const marketPricesError = settled[marketPricesIndex]?.[2];
        if (marketPricesError?.status === 404 && state.online !== false && requestGeneration === networkGeneration) {
            const targetCoins = settled.find(([key]) => key === 'targetCoins')?.[1] || null;
            try {
                const legacySnapshot = await loadLegacyMarketSnapshotOn404(marketPricesError, targetCoins, requestJSON);
                settled[marketPricesIndex] = ['marketPrices', legacySnapshot];
            } catch (error) {
                settled[marketPricesIndex] = ['marketPrices', null, error];
            }
        }
        if (state.online === false || requestGeneration !== networkGeneration) {
            const shouldRefreshAfterCurrent = refreshAfterCurrent;
            refreshAfterCurrent = false;
            state.refreshing = false;
            renderAll();
            if (state.online !== false && shouldRefreshAfterCurrent) {
                return loadCore({ quiet: true });
            }
            return;
        }
        const currentSnapshot = Object.fromEntries(settled.map(([key, data]) => [key, data]));
        const loaded = Object.fromEntries(Object.entries(currentSnapshot).map(([key, data]) => [key, data !== null]));
        const marketSnapshot = normalizeMarketPriceSnapshot(loaded.marketPrices ? currentSnapshot.marketPrices : null);
        const marketSnapshotLoaded = Boolean(loaded.marketPrices && marketSnapshot);
        const historyEntry = settled.find(([key]) => key === 'history');
        state.portfolioHistoryError = Boolean(historyEntry?.[2] || historyEntry?.[1]?.error);
        state.statisticsLoaded = loaded.statistics;
        state.tradesLoaded = loaded.trades;
        state.marketPricesLoaded = marketSnapshotLoaded;
        if (marketSnapshot) state.marketSnapshot = marketSnapshot;
        settled.forEach(([key, data]) => { if (key === 'strategyReadiness') { state.strategyReadiness = data; return; } if (key === 'marketPrices') { if (marketSnapshot) state.marketPrices = marketSnapshot.prices; return; } if (data === null) return; if (key === 'history') state.portfolioHistory = Array.isArray(data?.data) ? data.data : []; else if (key === 'targetCoins') state.targetCoins = Array.isArray(data?.coins) ? data.coins : []; else state[key] = data; });
        const deniedReadKeys = settled.filter(([, , error]) => error?.status === 401 || error?.status === 403);
        deniedReadKeys.forEach(([key]) => {
            if (key === 'history') state.portfolioHistory = [];
            else if (key === 'marketPrices') { state.marketPrices = []; state.marketSnapshot = null; }
            else if (key === 'targetCoins') state.targetCoins = [];
            else if (key === 'statistics') { state.statistics = []; state.statisticsLoaded = false; }
            else if (key === 'trades') { state.trades = []; state.tradesLoaded = false; }
            else if (['status', 'account', 'pnl', 'today', 'validation', 'strategyReadiness', 'paper', 'momentumShadow', 'portfolioAnalysis'].includes(key)) state[key] = null;
        });
        if (deniedReadKeys.length) state.lastSync = null;
        if (!loaded.paper) state.paper = null;
        state.actualMode = loaded.status && ['DRY_RUN', 'LIVE'].includes(currentSnapshot.status?.mode)
            ? currentSnapshot.status.mode
            : 'UNKNOWN';
        if (!state.marketPrices.some(item => item.coin === state.selectedCoin)) state.selectedCoin = state.marketPrices[0]?.coin || state.targetCoins[0] || state.selectedCoin;
        state.coreReady = isCoreTradingSnapshotReady({
            status: loaded.status ? currentSnapshot.status : null,
            account: loaded.account ? currentSnapshot.account : null,
            marketPrices: marketSnapshotLoaded ? marketSnapshot.prices : null,
            selectedCoin: state.selectedCoin
        });
        state.activeMode = state.actualMode === 'LIVE' ? 'live' : 'paper'; state.liveEligible = state.coreReady && runtimeCanAcceptOrders(state.status) && state.actualMode === 'LIVE' && state.validation?.promoted === true && state.strategyReadiness?.status === 'READY' && state.strategyReadiness?.currentEvidence === true && state.strategyReadiness?.liveGate?.passed === true;
        state.connected = state.coreReady;
        if (state.coreReady) state.lastSync = new Date();
        state.refreshing = false;
        setConnection(state.connected, state.connected ? '' : '필수 정보 확인 필요');
        renderAll();
        if (state.view === 'analysis' && state.strategyResearchError?.offline === true) {
            void loadStrategyResearch();
        }
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
        state.strategyResearchLoaded = false;
        state.strategyResearchLoading = false;
        state.strategyResearchError = { offline: true };
        state.strategyResearchRequest = null;
        state.analysisError = false;
        state.statistics = [];
        state.statisticsLoaded = false;
        state.analysisError = false;
        state.newsError = false;
        state.newsLoading = false;
        state.portfolioHistory = [];
        state.portfolioHistoryError = null;
        state.trades = [];
        state.tradesLoaded = false;
        state.marketPrices = [];
        state.marketPricesLoaded = false;
        state.marketSnapshot = null;
        state.targetCoins = [];
        state.candles = [];
        state.candlesError = false;
        state.candlesLoading = false;
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
        state.newsError = false;
        state.newsLoading = false;
    }

    function enterOfflineMode() {
        if (state.online === false) return;
        state.online = false;
        networkGeneration += 1;
        refreshAfterCurrent = false;
        clearDynamicStateForOffline();
        setConnection(false, '오프라인');
        renderAll();
    }

    function recoverOnline() {
        if (state.online !== false) return;
        state.online = true;
        setConnection(false, '연결 복구 중');
        renderAll();
        loadCore({ afterNetworkRestore: true }).catch(error => {
            setConnection(false, '오류');
            showToast(`연결 복구에 실패했습니다: ${error.message}`, 'warning');
        });
    }

    async function loadCandles(force = false) {
        if (!state.selectedCoin || (!force && state.candles.length && state.candlesCoin === state.selectedCoin && state.candlesInterval === state.candleInterval)) { renderMarketHeader(); drawMarketChart(); return; }
        const coin = state.selectedCoin;
        const interval = state.candleInterval;
        const hasLastKnownCandles = Array.isArray(state.candles)
            && state.candles.length > 0
            && state.candlesCoin === coin
            && state.candlesInterval === interval;
        const requestSequence = ++state.candlesRequestSequence;
        const isCurrentRequest = () => requestSequence === state.candlesRequestSequence
            && coin === state.selectedCoin
            && interval === state.candleInterval;
        if (!hasLastKnownCandles) state.candles = [];
        state.candlesError = false; state.candlesLoading = true; state.candlesCoin = coin; state.candlesInterval = interval; drawMarketChart();
        try {
            const candles = await requestJSON(`/market/candles/${encodeURIComponent(coin)}?unit=${interval}&count=100`);
            if (!isCurrentRequest()) return;
            state.candles = candles;
        } catch (error) {
            if (!isCurrentRequest()) return;
            if (!hasLastKnownCandles) state.candles = [];
            state.candlesError = true;
            if (!force) showToast(`가격 자료를 불러오지 못했습니다: ${error.message}`, 'warning');
        } finally {
            if (isCurrentRequest()) state.candlesLoading = false;
        }
        if (!isCurrentRequest()) return;
        renderMarketHeader(); drawMarketChart();
    }

    async function loadAnalysis() {
        if (state.viewLoading.has('analysis')) return;
        state.viewLoading.add('analysis');
        const button = root.querySelector('[data-pilot-action="load-analysis"]'); if (button) { button.disabled = true; button.innerHTML = '<i class="ph ph-spinner-gap" aria-hidden="true"></i> 분석 중'; }
        try {
            state.analysis = await requestJSON('/all-coin-scores?limit=60');
            state.analysisError = false;
            renderAnalysis();
            const analyzedCount = hasFiniteValue(state.analysis?.totalAnalyzed) ? Number(state.analysis.totalAnalyzed) : Array.isArray(state.analysis?.coins) ? state.analysis.coins.length : 0;
            showToast(analyzedCount > 0 ? `${analyzedCount}개 종목의 분석을 마쳤습니다.` : '분석할 종목이 없습니다. 거래 대상 설정을 확인해 주세요.', analyzedCount > 0 ? 'success' : 'warning');
        } catch (error) { state.analysisError = true; renderAnalysis(); showToast(`분석을 불러오지 못했습니다: ${error.message}`, 'error'); } finally { state.viewLoading.delete('analysis'); if (button) { button.disabled = false; button.innerHTML = '<i class="ph ph-play" aria-hidden="true"></i> 분석 실행'; } }
    }

    async function loadNews() {
        if (state.viewLoading.has('news')) return;
        state.viewLoading.add('news');
        state.newsError = false;
        state.newsLoading = true;
        renderNews();
        const button = root.querySelector('[data-pilot-action="load-news"]'); if (button) { button.disabled = true; button.innerHTML = '<i class="ph ph-spinner-gap" aria-hidden="true"></i> 수집 중'; }
        try {
            state.news = await requestJSON('/news?limit=80');
            state.newsError = false;
            showToast(`뉴스 ${state.news?.news?.length || 0}건을 불러왔습니다.`, 'success');
        } catch {
            state.newsError = true;
        } finally {
            state.newsLoading = false;
            state.viewLoading.delete('news');
            if (button) { button.disabled = false; button.innerHTML = '<i class="ph ph-arrows-clockwise" aria-hidden="true"></i> 뉴스 새로고침'; }
            renderNews();
        }
    }

    async function loadRecommendations() {
        const buy = byId('pilot-buy-recommendations'); const sell = byId('pilot-sell-recommendations'); if (buy) buy.innerHTML = '<div class="pilot-inline-empty">거래대금이 많은 시장을 분석하고 있습니다.</div>'; if (sell) sell.innerHTML = '<div class="pilot-inline-empty">보유 포지션을 분석 중입니다.</div>';
        try {
            const data = await requestJSON('/trading-recommendations');
            const renderRecommendation = (item, side) => `<div class="pilot-evidence-row"><span class="pilot-evidence-time">${escapeHtml(item.symbol || symbolOf(item.coin))}</span><div><strong class="pilot-evidence-title">${escapeHtml(recommendationLabel(item.recommendation, side))}</strong><div class="pilot-evidence-detail">${escapeHtml((item.signals || []).map(signalText).join(' · ') || item.investmentNote || item.sellNote || '추가 판단 필요')}</div></div><span class="pilot-evidence-value">${side === 'buy' ? formatWon(item.suggestedInvestment) : formatWon(item.suggestedSellValue)}</span></div>`;
            if (buy) buy.innerHTML = data.buyRecommendations?.length ? data.buyRecommendations.slice(0, 8).map(item => renderRecommendation(item, 'buy')).join('') : '<div class="pilot-inline-empty">매수 조건에 맞는 종목이 없습니다.</div>';
            if (sell) sell.innerHTML = data.sellRecommendations?.length ? data.sellRecommendations.slice(0, 8).map(item => renderRecommendation(item, 'sell')).join('') : '<div class="pilot-inline-empty">매도할 자산이 없습니다.</div>';
            showToast('매수·매도 검토 결과를 갱신했습니다. 결과를 확인한 뒤 직접 주문하세요.', 'success');
        } catch (error) { if (buy) buy.innerHTML = `<div class="pilot-inline-empty">오류: ${escapeHtml(toUserText(error.message))}</div>`; if (sell) sell.innerHTML = `<div class="pilot-inline-empty">오류: ${escapeHtml(toUserText(error.message))}</div>`; showToast(`추천을 불러오지 못했습니다: ${error.message}`, 'error'); }
    }

    async function loadSettings() {
        if (state.settingsLoaded && state.settings) { renderSettings(); return; }
        const errorNotice = byId('pilot-settings-error');
        const settingsGrid = byId('pilot-settings-grid');
        if (errorNotice) errorNotice.hidden = true;
        if (settingsGrid) settingsGrid.hidden = false;
        try {
            const [ranges, optimal, investmentConfig, presets, optimization, optimizationHistory, backtestResults] = await Promise.all([requestJSON('/parameter-ranges'), requestJSON('/optimal-config'), requestJSON('/investment-config'), requestJSON('/investment-presets'), requestJSON('/optimization/settings'), requestJSON('/optimization-history'), requestJSON('/backtest/results')]);
            const values = { ...(optimal?.parameters || {}), ...(investmentConfig?.scalping || {}), investmentRatio: investmentConfig?.investmentRatio ?? optimal?.parameters?.investmentRatio };
            state.settings = { ranges: ranges || {}, optimal, investmentConfig, presets: presets?.presets || [], optimization, values, optimizationHistory: Array.isArray(optimizationHistory) ? optimizationHistory : optimizationHistory?.history || [], backtestResults: Array.isArray(backtestResults) ? backtestResults : backtestResults?.results || [] }; state.settingsLoaded = true; renderSettings();
        } catch {
            if (settingsGrid) settingsGrid.hidden = true;
            if (errorNotice) {
                errorNotice.textContent = '거래 설정을 불러오지 못했습니다. 서버 연결을 확인한 뒤 다시 불러와 주세요.';
                errorNotice.hidden = false;
            }
        }
    }

    async function loadHistory() {
        try {
            const [validation, strategyReadiness, paper, momentumShadow, optimizationHistory, backtestResults] = await Promise.all([requestJSON('/scalping-validation'), requestJSON('/strategy-readiness').catch(() => null), requestJSON('/paper-validation'), requestJSON('/momentum-shadow'), requestJSON('/optimization-history'), requestJSON('/backtest/results')]);
            state.validation = validation; state.strategyReadiness = strategyReadiness; state.paper = paper; state.momentumShadow = momentumShadow; state.settings = state.settings || {}; state.settings.optimizationHistory = Array.isArray(optimizationHistory) ? optimizationHistory : optimizationHistory?.history || []; state.settings.backtestResults = Array.isArray(backtestResults) ? backtestResults : backtestResults?.results || []; state.historyLoaded = true; renderGateCards(); renderValidationDetail(); renderPaperDetail(); renderHistoryTables();
        } catch (error) { state.strategyReadiness = null; renderGateCards(); renderValidationDetail(); showToast(`점검 기록을 불러오지 못했습니다: ${error.message}`, 'error'); }
    }

    function showView(view) {
        if (!view) return; closeMobileNavigationMenu(); state.view = view; localStorage.setItem('currentPilotView', view); clearToasts(); window.scrollTo({ top: 0, behavior: 'auto' }); $$('[data-pilot-page]').forEach(page => page.classList.toggle('is-active', page.dataset.pilotPage === view)); syncViewNavigation(view);
        if (view === 'market') loadCandles(true); if (view === 'analysis') { if (!state.analysis) loadAnalysis(); if (!state.strategyResearchLoaded) void loadStrategyResearch(); } if (view === 'news' && !state.news) loadNews(); if (view === 'ai') loadAiDesk(false); if (view === 'settings') loadSettings(); if (view === 'history') { loadHistory(); loadSettings(); } renderAll();
    }

    function protectedMutationError(outcome, fallback) {
        const body = outcome?.body;
        if (body?.code === 'MARKET_QUOTE_STALE' && Array.isArray(body.markets) && body.markets.length > 0) {
            const details = body.markets.map(item => {
                const market = symbolOf(item.market);
                const ageSeconds = Number(item.ageMs) / 1000;
                const maximumSeconds = Number(item.maximumAgeMs) / 1000;
                if (!Number.isFinite(ageSeconds) || !Number.isFinite(maximumSeconds)) return market;
                const ageLabel = ageSeconds >= 60
                    ? `${Math.floor(ageSeconds / 60)}분 ${Math.floor(ageSeconds % 60)}초 전`
                    : `${Math.floor(ageSeconds)}초 전`;
                return `${market} 최근 체결 ${ageLabel} · 허용 ${Math.floor(maximumSeconds)}초`;
            });
            return `${details.join(' / ')}. 최신 시세를 확인한 뒤 다시 시도해 주세요.`;
        }
        const error = outcome?.body?.error;
        if (error?.code === 'idempotency_key_required') return '서버가 요청 키를 확인하지 못했습니다. 결과를 확인할 때까지 새 변경은 잠겨 있습니다.';
        if (error?.code === 'idempotency_key_conflict') return '서버 기록과 저장된 요청이 일치하지 않습니다. 새 변경은 잠겨 있습니다.';
        if (typeof outcome?.body?.message === 'string') return toUserText(outcome.body.message);
        if (typeof error?.message === 'string') return toUserText(error.message);
        if (typeof error === 'string') return toUserText(error);
        return outcome?.message || fallback;
    }

    function reportProtectedMutationOutcome(outcome, fallback) {
        if (outcome?.kind === 'terminal' || outcome?.kind === 'terminal-locked') return true;
        const message = protectedMutationError(outcome, fallback);
        showToast(message, outcome?.kind === 'rejected' || outcome?.kind === 'storage-error' || outcome?.kind === 'invalid' ? 'error' : 'warning');
        return false;
    }

    async function retryPendingMutation() {
        if (isPwaMutationBlocked()) {
            showToast(readOnlyObserverReason(), 'warning');
            return;
        }
        if (state.online === false) {
            showToast('연결이 복구된 뒤 같은 요청을 다시 확인할 수 있습니다.', 'warning');
            return;
        }
        const outcome = await manualMutationClient.retry();
        if (outcome.kind === 'terminal') {
            showToast(outcome.body?.message || '저장된 요청 결과를 확인했습니다.', outcome.body?.success === false ? 'warning' : 'success');
        } else if (outcome.kind === 'terminal-locked') {
            showToast(outcome.body?.message || '저장된 요청 결과를 확인했습니다.', outcome.body?.success === false ? 'warning' : 'success');
            showToast(outcome.message, 'warning');
        } else {
            reportProtectedMutationOutcome(outcome, '같은 요청 결과를 확인하지 못했습니다.');
        }
    }

    async function recordCurrentPortfolioSnapshot({ quiet = false, refresh = true } = {}) {
        if (isPwaMutationBlocked() || state.online === false || state.snapshotSaving) return false;
        state.snapshotSaving = true;
        syncObserverControls();
        try {
            const result = await requestJSON('/portfolio/snapshot', { method: 'POST' });
            if (result?.recorded !== true) {
                throw new Error(toUserText(result?.error || '현재 자산 평가를 저장하지 못했습니다.'));
            }
            if (!quiet) showToast('현재 자산 평가를 기록했습니다.', 'success');
            if (refresh) await loadCore({ quiet: true });
            return true;
        } catch (error) {
            if (!quiet) showToast(`자산 기록을 저장하지 못했습니다: ${error.message}`, 'warning');
            return false;
        } finally {
            state.snapshotSaving = false;
            syncObserverControls();
        }
    }

    async function executeTrade(prefix) {
        const trade = state.trade[prefix]; const select = root.querySelector(`[data-pilot-trade-coin="${prefix}"]`); const input = root.querySelector(`[data-pilot-trade-amount="${prefix}"]`); if (!trade || !select || !input) return;
        const coin = select.value; const amount = number(input.value); const market = currentMarket(coin) || {}; const holding = currentPosition(coin) || {};
        if (!canTrade(coin)) { showToast(tradeBlockReason(coin), 'warning'); return; }
        if (!coin || amount <= 0) { showToast('자산과 주문 금액을 확인해주세요.', 'warning'); return; }
        if (trade.side === 'buy' && amount < 5000) { showToast('최소 매수 금액은 5,000원입니다.', 'warning'); return; }
        const quantity = market.price > 0 ? amount / market.price : amount / number(holding.currentPrice); const actionText = trade.side === 'buy' ? '매수' : '매도'; const detail = trade.side === 'buy' ? `${formatWon(amount)} 주문` : `${formatQuantity(quantity)}개 매도`;
        if (!window.confirm(`${symbolOf(coin)} ${actionText}를 실행할까요?\n${detail}\n현재 모드: ${state.activeMode === 'paper' ? '모의투자' : '실거래'}`)) {
            showToast(`${symbolOf(coin)} ${actionText}를 취소했습니다`, 'info');
            return;
        }
        try {
            const path = trade.side === 'buy' ? '/trade/buy' : '/trade/sell';
            const body = trade.side === 'buy' ? { coin, amount: Math.floor(amount) } : { coin, quantity };
            const outcome = await manualMutationClient.submit(path, body);
            if (!reportProtectedMutationOutcome(outcome, `${actionText} 요청을 처리하지 못했습니다.`)) return;
            const result = outcome.body || {};
            if (result.success === false) {
                showToast(protectedMutationError(outcome, `${actionText} 요청을 처리하지 못했습니다.`), 'warning');
                await loadCore({ quiet: true });
                return;
            }
            showToast(result.message || `${symbolOf(coin)} ${actionText} 완료`, 'success');
            if (outcome.kind === 'terminal-locked') {
                showToast(outcome.message, 'warning');
                return;
            }
            const snapshotRecorded = await recordCurrentPortfolioSnapshot({ quiet: true, refresh: false });
            if (!snapshotRecorded) showToast('거래는 완료됐지만 자산 추이를 기록하지 못했습니다.', 'warning');
            await loadCore();
        } catch (error) { showToast(`${actionText} 실패: ${error.message}`, 'error'); }
    }

    async function executeSmart(kind) {
        if (!canTrade()) { showToast(tradeBlockReason(), 'warning'); return; }
        const buy = kind === 'buy'; const amount = number(byId(buy ? 'pilot-smart-buy-amount' : 'pilot-smart-sell-amount')?.value); if (!amount || amount < (buy ? 5000 : 1000)) { showToast(`최소 ${formatWon(buy ? 5000 : 1000)} 이상 입력해주세요.`, 'warning'); return; }
        const description = buy ? `상위 마켓에 ${formatWon(amount)} 분산 매수` : `보유 자산에서 ${formatWon(amount)} 목표 매도`; if (!window.confirm(`${description}를 실행할까요?\n현재 모드: ${state.activeMode === 'paper' ? '모의투자' : '실거래'}`)) return;
        try {
            const body = buy ? { totalAmount: Math.floor(amount), minScore: number(byId('pilot-smart-buy-score')?.value, 60), maxCoins: number(byId('pilot-smart-buy-max')?.value, 10) } : { targetAmount: Math.floor(amount), strategy: byId('pilot-smart-sell-strategy')?.value || 'worst' };
            const outcome = await manualMutationClient.submit(buy ? '/trade/smart-buy' : '/trade/smart-sell', body);
            if (!reportProtectedMutationOutcome(outcome, '조건 주문을 처리하지 못했습니다.')) return;
            const result = outcome.body || {};
            const failureCount = Array.isArray(result.failures) ? result.failures.length : 0;
            const completedTrades = Array.isArray(result.trades) ? result.trades.length : 0;
            if (result.success === false && completedTrades === 0) {
                showToast(protectedMutationError(outcome, '조건 주문을 처리하지 못했습니다.'), 'warning');
                await loadCore({ quiet: true });
                return;
            }
            const toastMessage = failureCount > 0
                ? `${result.message || '조건에 맞는 주문을 완료했습니다.'} 실패 ${failureCount}건`
                : result.message || '조건에 맞는 주문을 완료했습니다.';
            showToast(toastMessage, result.success === false ? 'warning' : 'success');
            if (outcome.kind === 'terminal-locked') {
                showToast(outcome.message, 'warning');
                return;
            }
            const snapshotRecorded = await recordCurrentPortfolioSnapshot({ quiet: true, refresh: false });
            if (!snapshotRecorded) showToast('조건 주문은 완료됐지만 자산 추이를 기록하지 못했습니다.', 'warning');
            await loadCore();
        } catch (error) { showToast(`조건 주문 실패: ${error.message}`, 'error'); }
    }

    async function walletAction(kind) {
        if (isPwaMutationBlocked()) { showToast(readOnlyObserverReason(), 'warning'); return; }
        if (!isPaperMode()) { showToast('실거래 모드에서는 모의투자 지갑을 조작할 수 없습니다.', 'warning'); return; }
        if (state.pendingMutation?.locked) { showToast('처리 중인 요청 결과를 확인한 뒤 가상 지갑을 변경할 수 있습니다.', 'warning'); return; }
        const input = byId(kind === 'deposit' ? 'pilot-deposit-amount' : 'pilot-withdraw-amount'); const amount = number(input?.value); if (!amount || amount < 1000) { showToast('최소 1,000원 이상 입력해주세요.', 'warning'); return; }
        try {
            const outcome = await manualMutationClient.submit(`/virtual/${kind}`, { amount: Math.floor(amount) });
            if (!reportProtectedMutationOutcome(outcome, '지갑 변경을 처리하지 못했습니다.')) return;
            const result = outcome.body || {};
            showToast(result.message || '지갑을 업데이트했습니다.', result.success === false ? 'warning' : 'success');
            if (outcome.kind === 'terminal-locked') { showToast(outcome.message, 'warning'); return; }
            if (input) input.value = '';
            await loadCore();
        } catch (error) { showToast(`지갑 변경 실패: ${error.message}`, 'error'); }
    }

    async function resetWallet() {
        if (isPwaMutationBlocked()) { showToast(readOnlyObserverReason(), 'warning'); return; }
        if (!isPaperMode()) { showToast('실거래 모드에서는 지갑을 리셋할 수 없습니다.', 'warning'); return; }
        if (state.pendingMutation?.locked) { showToast('처리 중인 요청 결과를 확인한 뒤 가상 지갑을 변경할 수 있습니다.', 'warning'); return; }
        const seed = number(window.prompt('모의 계좌를 얼마로 다시 시작할까요? (원)', String(state.account?.initialSeedMoney || 10000000))); if (!seed || seed < 100000) return; if (!window.confirm(`모의 계좌를 ${formatWon(seed)}으로 다시 시작할까요?\n보유 코인과 전략별 포지션·매매 기록은 사라집니다.`)) return;
        try {
            const outcome = await manualMutationClient.submit('/virtual/reset', { seedMoney: Math.floor(seed) });
            if (!reportProtectedMutationOutcome(outcome, '초기화 요청을 처리하지 못했습니다.')) return;
            const result = outcome.body || {};
            showToast(result.message || `모의 계좌를 ${formatWon(seed)}으로 초기화했습니다.`, result.success === false ? 'warning' : 'success');
            if (outcome.kind === 'terminal-locked') { showToast(outcome.message, 'warning'); return; }
            await loadCore();
        } catch (error) { showToast(`초기화 실패: ${error.message}`, 'error'); }
    }

    async function startPaper(reset = false) {
        if (isPwaMutationBlocked()) { showToast(readOnlyObserverReason(), 'warning'); return; }
        const seed = number(state.account?.initialSeedMoney);
        const startingAmount = seed > 0 ? `초기 금액 ${formatWon(seed)}` : '저장된 초기 금액';
        const message = reset ? `${startingAmount}으로 새 모의투자를 시작할까요?\n보유 코인과 전략별 포지션·매매 기록은 사라집니다.` : '현재 가상 자산과 포지션을 유지한 채 모의투자 실행을 시작합니다. 계속할까요?'; if (!window.confirm(message)) return;
        try { const result = await requestJSON('/paper-validation/start', { method: 'POST', body: JSON.stringify(reset ? { reset: true } : {}) }); state.paper = result.status; renderGateCards(); renderPaperDetail(); showToast(reset ? '초기화 후 모의투자를 시작했습니다.' : '모의투자를 시작했습니다.', 'success'); } catch (error) { showToast(`모의투자 시작 실패: ${error.message}`, 'error'); }
    }

    async function stopPaper() {
        if (isPwaMutationBlocked()) { showToast(readOnlyObserverReason(), 'warning'); return; }
        if (!window.confirm('현재 모의투자를 중지할까요?')) return;
        try { const result = await requestJSON('/paper-validation/stop', { method: 'POST' }); state.paper = result.status; renderGateCards(); renderPaperDetail(); showToast('모의투자를 중지했습니다.', 'success'); } catch (error) { showToast(`모의투자 중지 실패: ${error.message}`, 'error'); }
    }

    function settingPayload() {
        const payload = {};
        $$('[data-pilot-setting-key]').forEach(input => { const key = input.dataset.pilotSettingKey; if (input.type === 'checkbox') payload[key] = input.checked; else { const raw = number(input.value); payload[key] = input.dataset.pilotSettingDisplay === 'percent' ? raw / 100 : raw; } });
        return payload;
    }

    async function saveSettings() {
        if (isPwaMutationBlocked()) { showToast(readOnlyObserverReason(), 'warning'); return; }
        if (isPaperEvidenceMutationLocked()) { showToast(paperEvidenceMutationReason(), 'warning'); return; }
        const payload = settingPayload();
        try { const investmentRatio = payload.investmentRatio; delete payload.investmentRatio; await requestJSON('/config/update', { method: 'POST', body: JSON.stringify(payload) }); if (investmentRatio !== undefined) await requestJSON('/investment-config/update', { method: 'POST', body: JSON.stringify({ investmentRatio }) }); state.settingsLoaded = false; await loadSettings(); showToast('설정을 적용했습니다. 다음 점검에서 다시 확인하세요.', 'success'); } catch (error) { showToast(`설정 적용 실패: ${error.message}`, 'error'); }
    }

    async function applyPreset(presetId) {
        if (isPwaMutationBlocked()) { showToast(readOnlyObserverReason(), 'warning'); return; }
        if (isPaperEvidenceMutationLocked()) { showToast(paperEvidenceMutationReason(), 'warning'); return; }
        const preset = state.settings?.presets?.find(item => item.id === presetId); if (!preset) return; if (!window.confirm(`${preset.name} 설정을 적용할까요? 현재 전략 설정이 바뀝니다.`)) return;
        try { await requestJSON('/investment-presets/apply', { method: 'POST', body: JSON.stringify({ presetId, config: preset.config }) }); state.settingsLoaded = false; await loadSettings(); showToast(`${preset.name} 설정을 적용했습니다.`, 'success'); } catch (error) { showToast(`설정을 적용하지 못했습니다: ${error.message}`, 'error'); }
    }

    async function runOptimization() {
        if (isPwaMutationBlocked()) { showToast(readOnlyObserverReason(), 'warning'); return; }
        if (isPaperEvidenceMutationLocked()) { showToast(paperEvidenceMutationReason(), 'warning'); return; }
        if (!window.confirm('현재 설정과 다른 후보의 결과를 비교할까요?')) return;
        try { const result = await requestJSON('/optimization/run-now', { method: 'POST' }); showToast(result.message || '설정 후보 비교를 시작했습니다.', 'success'); } catch (error) { showToast(`설정 후보를 비교하지 못했습니다: ${error.message}`, 'error'); }
    }

    function openNews(index, returnFocusTo = document.activeElement) {
        const filter = state.newsFilter || 'all'; const list = (state.news?.news || []).filter(news => filter === 'all' || articleSentimentInfo(news)?.key === filter); const item = list[index]; if (!item) return;
        const info = articleSentimentInfo(item); const link = item.link || item.url;
        showModal('뉴스 확인', `<div class="pilot-inline-note"><i class="ph ph-newspaper" aria-hidden="true"></i><span>${escapeHtml(item.source || '출처 미상')} · ${escapeHtml(formatDateTime(item.timestamp || item.pubDate || item.publishedAt))}</span></div><div style="margin-top:16px"><h3 style="margin:0;color:var(--sl-ink);font-size:18px;line-height:1.4">${escapeHtml(item.title || '제목 없음')}</h3><p style="margin:14px 0 0;color:var(--sl-ink-soft);line-height:1.7;font-size:13px">${escapeHtml(item.description || item.content || '요약이 없습니다.')}</p></div><div class="pilot-inline-note" style="margin-top:16px"><i class="ph ph-info" aria-hidden="true"></i><span>기사 분위기: ${escapeHtml(info?.label || '분류 자료 없음')}</span></div>`, link ? `<a class="pilot-button is-primary" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">원문 보기 <i class="ph ph-arrow-square-out" aria-hidden="true"></i></a><button type="button" class="pilot-button" data-pilot-modal-close>닫기</button>` : '', {
            returnFocusTo,
            returnFocusKey: newsFocusKey(item, index),
            returnFocusIndex: index
        });
    }

    function setMode(mode) {
        if (mode === 'live') {
            if (!['DRY_RUN', 'LIVE'].includes(state.actualMode)) { showToast('서버 거래 모드를 확인할 수 없습니다. 연결 상태를 확인해 주세요.', 'warning'); return; }
            if (state.actualMode !== 'LIVE') { showToast('현재 서버는 모의투자 모드입니다. 실거래로 전환할 수 없습니다.', 'warning'); return; }
            if (!state.liveEligible) { showToast('사전 점검이 모두 완료되기 전까지 실거래는 잠겨 있습니다.', 'warning'); showView('history'); return; }
        }
        if (mode === 'paper' && state.actualMode === 'LIVE') { showToast('현재 서버가 실거래 모드입니다. 모의 주문은 실행되지 않습니다.', 'warning'); return; }
        state.activeMode = mode; renderMode(); renderTradePanels();
    }

    async function handleAction(action) {
        if (action === 'retry-pending-mutation') return retryPendingMutation(); if (action === 'refresh-core') return loadCore(); if (action === 'refresh-market') { await loadCore(); announceManualMarketRefresh(); return; } if (action === 'load-analysis') return loadAnalysis(); if (action === 'load-news') return loadNews(); if (action === 'load-recommendations') return loadRecommendations(); if (action === 'reload-strategy-research') return loadStrategyResearch({ force: true }); if (action === 'smart-buy') return executeSmart('buy'); if (action === 'smart-sell') return executeSmart('sell'); if (action === 'deposit') return walletAction('deposit'); if (action === 'withdraw') return walletAction('withdraw'); if (action === 'reset-wallet') return resetWallet(); if (action === 'start-paper') return startPaper(false); if (action === 'start-paper-reset') return startPaper(true); if (action === 'stop-paper') return stopPaper(); if (action === 'record-snapshot') return recordCurrentPortfolioSnapshot(); if (action === 'reload-settings') { state.settingsLoaded = false; return loadSettings(); } if (action === 'save-settings') return saveSettings(); if (action === 'run-optimization') return runOptimization(); if (action === 'refresh-history') { await loadCore(); return loadHistory(); }
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
        const rangeButton = event.target.closest('[data-pilot-candle-range]');
        if (rangeButton) {
            const range = number(rangeButton.dataset.pilotCandleRange);
            if ([30, 60, 100].includes(range) && range !== state.candleDisplayRange) {
                state.candleDisplayRange = range;
                renderCandleControls();
                drawMarketChart();
            }
            return;
        }
        const marketRow = event.target.closest('[data-pilot-market-row]');
        if (marketRow) { state.selectedCoin = marketRow.dataset.pilotMarketRow; localStorage.setItem('selectedCoin', state.selectedCoin); renderMarketList(); renderTradePanels(); await loadCandles(true); return; }
        const positionAction = event.target.closest('[data-pilot-position-action]');
        if (positionAction) { state.selectedCoin = positionAction.dataset.pilotCoin; state.trade.trade.side = 'sell'; showView('trade'); renderTradePanels(); return; }
        const analysisCoin = event.target.closest('[data-pilot-analysis-coin]');
        if (analysisCoin) { state.selectedCoin = analysisCoin.dataset.pilotAnalysisCoin; state.trade.trade.side = 'buy'; showView('trade'); renderTradePanels(); return; }
        const newsRow = event.target.closest('[data-pilot-news-index]');
        if (newsRow) { openNews(number(newsRow.dataset.pilotNewsIndex), newsRow); return; }
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
        const dialog = byId('pilot-modal-root')?.querySelector('.pilot-modal');
        if (dialog) handleModalKeydown(event, dialog);
    });

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
            try { await requestJSON('/optimization/toggle', { method: 'POST', body: JSON.stringify({ enabled: event.target.checked }) }); showToast('자동 후보 비교 설정을 저장했습니다.', 'success'); } catch (error) { showToast(`자동 후보 비교 설정을 저장하지 못했습니다: ${error.message}`, 'error'); }
        }
        if (event.target.id === 'pilot-optimization-interval') {
            try { await requestJSON('/optimization/interval', { method: 'POST', body: JSON.stringify({ interval: number(event.target.value) }) }); showToast('비교 간격을 저장했습니다.', 'success'); } catch (error) { showToast(`비교 간격을 저장하지 못했습니다: ${error.message}`, 'error'); }
        }
    });

    if (window.io) {
        try {
            const liveSocket = window.io();
            liveSocket.on('connect', () => setConnection(true));
            liveSocket.on('disconnect', () => setConnection(Boolean(state.connected), '실시간 알림 대기'));
            liveSocket.on('auto-trade', payload => { const trade = payload?.trade || payload; showToast(`${trade?.coin ? symbolOf(trade.coin) : '자동'} ${trade?.type === 'SELL' ? '매도' : '매수'} 알림`, trade?.type === 'SELL' ? 'warning' : 'success'); loadCore({ quiet: true }); });
            liveSocket.on('new-signal', () => { showToast('새 신호가 도착했습니다. 전략 분석에서 확인하세요.', 'info'); if (state.view === 'analysis') loadAnalysis(); });
            liveSocket.on('breaking-news', news => { showToast(`속보: ${news?.title || '새로운 뉴스'}`, 'warning'); if (state.view === 'news') loadNews(); });
        } catch (error) { console.warn('Signal Ledger socket init failed:', error.message); }
    }

    window.addEventListener('resize', () => { drawEquityChart('pilot-equity-chart', 'pilot-equity-empty', state.portfolioHistory); drawEquityChart('pilot-portfolio-chart', 'pilot-portfolio-empty', state.portfolioHistory); drawAllocationChart(); drawMarketChart(); });
    window.setInterval(updateClock, 1000);
    window.setInterval(() => { if (!document.hidden) loadCore({ quiet: true }); }, CORE_REFRESH_INTERVAL_MS);
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
