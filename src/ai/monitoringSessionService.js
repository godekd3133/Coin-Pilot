import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { envRaw } from '../config/envConfig.js';
import {
DEFAULT_EVALUATION_MINUTES,
  DEFAULT_MAX_CONSULTATIONS,
  DEFAULT_MAX_EVENTS,
  DEFAULT_MAX_PRICE_OBSERVATIONS,
  DEFAULT_MINIMUM_EVALUATION_SAMPLES,
  DEFAULT_NEUTRAL_BAND_PERCENT,
  EVENT_TYPES,
  SCHEMA_VERSION,
  buildPendingEvaluation,
  compactAnalysis,
  compactObject,
  emptyState,
  eventFromAnalysis,
  eventFromBundle,
  eventFromNews,
  eventFromTrade,
  normalizeCoins,
  normalizeEventTypes,
  normalizeProviderValue,
  numberOrNull,
  resolveEvaluationMinutes,
  resolveNeutralBandPercent,
  scoreAdviceOutcome,
  timestampMs,
  truncate
} from './monitoringEventModel.js';
import { MonitoringConsultations } from './monitoringConsultations.js';
export class MonitoringSessionService {
  constructor(options = {}) {
    this.workspaceRoot = options.workspaceRoot || process.cwd();
    this.stateFile = options.stateFile || options.config?.aiMonitoringFile || envRaw('AI_MONITORING_FILE') ||
      path.join(this.workspaceRoot, 'ai_monitoring_sessions.json');
    this.advisor = options.advisor;
    this.maxEvents = Math.max(40, Number(options.maxEvents || DEFAULT_MAX_EVENTS));
    this.maxConsultations = Math.max(40, Number(options.maxConsultations || DEFAULT_MAX_CONSULTATIONS));
    this.maxPriceObservations = Math.max(500, Number(options.maxPriceObservations || DEFAULT_MAX_PRICE_OBSERVATIONS));
    this.defaultEvaluationMinutes = resolveEvaluationMinutes(
      options.defaultEvaluationMinutes ?? options.config?.aiEvaluationMinutes ?? envRaw('AI_EVALUATION_MINUTES'),
      DEFAULT_EVALUATION_MINUTES
    );
    this.evaluationNeutralBandPercent = resolveNeutralBandPercent(
      options.evaluationNeutralBandPercent ?? options.config?.aiEvaluationNeutralBandPercent ?? envRaw('AI_EVALUATION_NEUTRAL_BAND_PERCENT'),
      DEFAULT_NEUTRAL_BAND_PERCENT
    );
    this.minimumEvaluationSamples = Math.max(1, Math.min(10_000, Number(
      options.minimumEvaluationSamples ?? options.config?.aiEvaluationMinSamples ?? envRaw('AI_EVALUATION_MIN_SAMPLES')
    ) || DEFAULT_MINIMUM_EVALUATION_SAMPLES));
    this.onUpdate = null;
    this.pendingConsultations = new Map();
    this.ingestQueue = Promise.resolve();
    this.state = this.loadState();
  }

  _consult() {
    if (!this.__consultations) this.__consultations = new MonitoringConsultations(this);
    return this.__consultations;
  }

  actualProviderResults(...args) { return this._consult().actualProviderResults(...args); }
  findEvaluationObservation(...args) { return this._consult().findEvaluationObservation(...args); }
  findLatestPriceObservation(...args) { return this._consult().findLatestPriceObservation(...args); }
  refreshConsultationEvaluation(...args) { return this._consult().refreshConsultationEvaluation(...args); }
  evaluatePendingConsultations(...args) { return this._consult().evaluatePendingConsultations(...args); }


  loadState() {
    if (!fs.existsSync(this.stateFile)) return emptyState();
    try {
      const saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      const initial = emptyState();
      return {
        ...initial,
        ...saved,
        schemaVersion: SCHEMA_VERSION,
        events: Array.isArray(saved.events)
          ? saved.events.slice(-this.maxEvents).map(event => ({
            ...event,
            sessionIds: Array.isArray(event.sessionIds) ? event.sessionIds : []
          }))
          : [],
        consultations: Array.isArray(saved.consultations) ? saved.consultations.slice(-this.maxConsultations) : [],
        priceObservations: Array.isArray(saved.priceObservations)
          ? saved.priceObservations.slice(-this.maxPriceObservations).filter(observation =>
            observation && typeof observation === 'object' && observation.coin &&
            numberOrNull(observation.price) !== null && timestampMs(observation.timestamp) !== null
          )
          : [],
        sessions: Array.isArray(saved.sessions) ? saved.sessions.map(session => ({
          ...session,
          providers: normalizeProviderValue(session.providers),
          eventTypes: normalizeEventTypes(session.eventTypes),
          autoConsultEventTypes: session.autoConsultEventTypes === undefined
            ? normalizeEventTypes(session.eventTypes)
            : normalizeEventTypes(session.autoConsultEventTypes)
              .filter(type => normalizeEventTypes(session.eventTypes).includes(type)),
          coins: normalizeCoins(session.coins),
          evaluationMinutes: resolveEvaluationMinutes(session.evaluationMinutes, this.defaultEvaluationMinutes),
          seenEventKeys: Array.isArray(session.seenEventKeys) ? session.seenEventKeys : [],
          lastConsultByEventKey: session.lastConsultByEventKey && typeof session.lastConsultByEventKey === 'object'
            ? session.lastConsultByEventKey
            : {}
        })) : []
      };
    } catch {
      // A corrupted history must not stop market monitoring. Keep a clean
      // in-memory state and let the next successful write replace the file.
      return emptyState();
    }
  }

  saveState() {
    const directory = path.dirname(this.stateFile);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryFile = `${this.stateFile}.tmp-${process.pid}`;
    fs.writeFileSync(temporaryFile, JSON.stringify(this.state, null, 2), 'utf8');
    fs.renameSync(temporaryFile, this.stateFile);
  }

  setUpdateCallback(callback) {
    this.onUpdate = typeof callback === 'function' ? callback : null;
  }

  emitUpdate(type, payload) {
    if (!this.onUpdate) return;
    try {
      this.onUpdate({ type, ...payload });
    } catch {
      // UI notification failures must never affect trading or persistence.
    }
  }

  publicSession(session) {
    if (!session) return null;
    const { seenEventKeys, lastConsultByEventKey, ...publicData } = session;
    return {
      ...publicData,
      providers: [...(session.providers || [])],
      eventTypes: [...(session.eventTypes || [])],
      autoConsultEventTypes: [...(session.autoConsultEventTypes || [])],
      coins: [...(session.coins || [])]
    };
  }

  getSessions() {
    return this.state.sessions
      .slice()
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .map(session => this.publicSession(session));
  }

  getEffectiveness({ sessionId = null } = {}) {
    const consultations = this.state.consultations.filter(consultation =>
      !sessionId || consultation.sessionId === sessionId
    );
    const providerStats = new Map();
    const ensureStats = (source, label, type = 'provider') => {
      if (!providerStats.has(source)) {
        providerStats.set(source, {
          source,
          label,
          type,
          attempted: 0,
          completed: 0,
          failed: 0,
          evaluated: 0,
          actionableEvaluations: 0,
          directionalPredictions: 0,
          hits: 0,
          misses: 0,
          flat: 0,
          calm: 0,
          abstained: 0,
          vetoGood: 0,
          vetoMissedOpportunity: 0,
          vetoFlat: 0,
          vetoImpactPercentTotal: 0,
          latencyMsTotal: 0,
          signedMovePercentTotal: 0
        });
      }
      return providerStats.get(source);
    };

    let actualProviderAttempts = 0;
    let actualProviderCompletions = 0;
    let evaluatedConsultations = 0;
    let pendingEvaluations = 0;
    let notEvaluableConsultations = 0;

    for (const consultation of consultations) {
      for (const result of Array.isArray(consultation.results) ? consultation.results : []) {
        if (!result?.provider || result.provider === 'local-brief') continue;
        const stats = ensureStats(result.provider, result.providerLabel || result.provider);
        stats.attempted += 1;
        actualProviderAttempts += 1;
        if (result.status === 'COMPLETED' && result.advice) {
          stats.completed += 1;
          actualProviderCompletions += 1;
          stats.latencyMsTotal += Number(result.latencyMs) || 0;
        } else {
          stats.failed += 1;
        }
      }

      const evaluation = consultation.evaluation;
      if (evaluation?.status === 'COMPLETED') {
        evaluatedConsultations += 1;
        for (const verdict of evaluation.verdicts || []) {
          const stats = ensureStats(
            verdict.source,
            verdict.providerLabel || verdict.source,
            verdict.source === 'consensus' ? 'consensus' : 'provider'
          );
          stats.evaluated += 1;
          const signedMove = numberOrNull(verdict.signedMovePercent);
          if (signedMove !== null) stats.signedMovePercentTotal += signedMove;
          if (verdict.verdict === 'HIT') {
            stats.hits += 1;
            stats.directionalPredictions += 1;
            stats.actionableEvaluations += 1;
          } else if (verdict.verdict === 'MISS') {
            stats.misses += 1;
            stats.directionalPredictions += 1;
            stats.actionableEvaluations += 1;
          } else if (verdict.verdict === 'FLAT') {
            stats.flat += 1;
            stats.directionalPredictions += 1;
          } else if (verdict.verdict === 'CALM') {
            stats.calm += 1;
          } else if (verdict.verdict === 'ABSTAINED') {
            stats.abstained += 1;
          }
          if (verdict.vetoVerdict === 'VETO_GOOD') {
            stats.vetoGood += 1;
            stats.actionableEvaluations += 1;
          }
          if (verdict.vetoVerdict === 'VETO_MISSED_OPPORTUNITY') {
            stats.vetoMissedOpportunity += 1;
            stats.actionableEvaluations += 1;
          }
          if (verdict.vetoVerdict === 'VETO_FLAT') {
            stats.vetoFlat += 1;
          }
          if (Number.isFinite(Number(verdict.vetoImpactPercent))) {
            stats.vetoImpactPercentTotal += Number(verdict.vetoImpactPercent);
          }
        }
      } else if (evaluation?.status === 'PENDING') {
        pendingEvaluations += 1;
      } else if (evaluation?.status === 'NOT_EVALUABLE') {
        notEvaluableConsultations += 1;
      }
    }

    const toPublicStats = stats => {
      const scored = stats.hits + stats.misses;
      const outcomeEligible = stats.actionableEvaluations > 0;
      return {
        ...stats,
        completionRate: stats.attempted > 0 ? stats.completed / stats.attempted : null,
        averageLatencyMs: stats.completed > 0 ? Math.round(stats.latencyMsTotal / stats.completed) : null,
        hitRate: scored > 0 ? stats.hits / scored : null,
        averageSignedMovePercent: stats.directionalPredictions > 0
          ? stats.signedMovePercentTotal / stats.directionalPredictions
          : null,
        vetoNetImpactPercent: stats.vetoImpactPercentTotal,
        vetoNonFlatSuccessRate: (stats.vetoGood + stats.vetoMissedOpportunity) > 0
          ? stats.vetoGood / (stats.vetoGood + stats.vetoMissedOpportunity)
          : null,
        sufficientEvidence: outcomeEligible && stats.actionableEvaluations >= this.minimumEvaluationSamples
      };
    };

    const publicStats = Object.fromEntries([...providerStats.entries()]
      .map(([source, stats]) => [source, toPublicStats(stats)]));
    const maximumActionableEvaluations = Object.values(publicStats)
      .reduce((maximum, stats) => Math.max(maximum, stats.actionableEvaluations || 0), 0);
    const outcomeEligibleConsultations = evaluatedConsultations + pendingEvaluations;
    return {
      sessionId,
      generatedAt: new Date().toISOString(),
      totalConsultations: consultations.length,
      actualProviderAttempts,
      actualProviderCompletions,
      actualProviderCompletionRate: actualProviderAttempts > 0
        ? actualProviderCompletions / actualProviderAttempts
        : null,
      evaluatedConsultations,
      pendingEvaluations,
      notEvaluableConsultations,
      evaluationCoverageRate: outcomeEligibleConsultations > 0
        ? evaluatedConsultations / outcomeEligibleConsultations
        : null,
      providerStats: publicStats,
      method: {
        horizonMinutes: this.defaultEvaluationMinutes,
        neutralBandPercent: this.evaluationNeutralBandPercent,
        minimumEvaluationSamples: this.minimumEvaluationSamples,
        actionableSampleDefinition: '매수·매도 의견의 가격 방향 일치 여부와 주문 보류 뒤의 가격 변화를 평가합니다.',
        vetoImpactDefinition: '주문 보류 뒤 중립 범위를 넘는 가격 변화를 비교합니다. 실제 손익을 뜻하지 않습니다.',
        hitDefinition: '매수·매도 의견과 확인 시점 이후의 가격 방향이 일치하면 일치로 계산합니다.',
        waitDefinition: '보유·관망 의견은 매수·매도 방향 예측과 분리해 집계합니다.',
        source: '같은 신호 시점의 기준 가격과 설정한 확인 시점 이후 첫 가격'
      },
      sufficientEvidence: Object.values(publicStats).some(stats => stats.sufficientEvidence === true),
      evidenceWarning: Object.keys(publicStats).length === 0
        ? '가격을 비교할 자료가 없습니다.'
        : maximumActionableEvaluations < this.minimumEvaluationSamples
          ? `매수·매도 방향 또는 주문 보류 결과 ${this.minimumEvaluationSamples}건 이상이 있어야 평가할 수 있습니다. 현재 ${maximumActionableEvaluations}건입니다.`
          : null
    };
  }

  getSnapshot({ limit = 40, sessionId = null } = {}) {
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 40));
    const events = this.state.events
      .filter(event => !sessionId || event.sessionIds?.includes(sessionId))
      .slice(-safeLimit)
      .reverse();
    const consultations = this.state.consultations
      .filter(consultation => !sessionId || consultation.sessionId === sessionId)
      .slice(-safeLimit)
      .reverse();
    return {
      updatedAt: this.state.updatedAt,
      latestSnapshot: this.state.latestSnapshot,
      sessions: this.getSessions(),
      events,
      consultations,
      effectiveness: this.getEffectiveness({ sessionId })
    };
  }

  findSession(sessionId) {
    return this.state.sessions.find(session => session.id === sessionId) || null;
  }

  findEvent(eventId) {
    return this.state.events.find(event => event.id === eventId) || null;
  }

  createSession(input = {}) {
    const eventTypes = normalizeEventTypes(input.eventTypes);
    const providers = normalizeProviderValue(input.providers ?? input.provider);
    const autoConsultEventTypes = input.autoConsultEventTypes === undefined
      ? eventTypes
      : normalizeEventTypes(input.autoConsultEventTypes).filter(type => eventTypes.includes(type));
    if (eventTypes.length === 0) throw new Error('관심 신호를 하나 이상 선택해 주세요.');
    if (providers.length === 0) throw new Error('의견을 받을 서비스를 하나 이상 선택해 주세요.');

    const now = new Date().toISOString();
    const session = {
      id: randomUUID(),
      name: truncate(input.name || '시장 신호 알림', 80),
      status: 'RUNNING',
      providers,
      eventTypes,
      autoConsultEventTypes,
      coins: normalizeCoins(input.coins),
      autoConsult: input.autoConsult !== false,
      cooldownSeconds: Math.max(30, Math.min(86_400, Number(input.cooldownSeconds) || 300)),
      evaluationMinutes: resolveEvaluationMinutes(input.evaluationMinutes, this.defaultEvaluationMinutes),
      horizon: truncate(input.horizon || 'short-term', 80),
      createdAt: now,
      startedAt: now,
      pausedAt: null,
      endedAt: null,
      lastEventAt: null,
      lastConsultAt: null,
      eventCount: 0,
      consultationCount: 0,
      seenEventKeys: [],
      lastConsultByEventKey: {}
    };

    this.state.sessions.push(session);
    this.state.updatedAt = now;
    this.saveState();
    this.emitUpdate('session', { session: this.publicSession(session) });
    return this.publicSession(session);
  }

  updateSessionStatus(sessionId, status) {
    const session = this.findSession(sessionId);
    if (!session) throw new Error('관심 신호 설정을 찾지 못했습니다. 새로고침한 뒤 다시 시도해 주세요.');
    if (!['RUNNING', 'PAUSED', 'STOPPED'].includes(status)) throw new Error('요청한 상태를 변경할 수 없습니다.');
    if (session.status === 'STOPPED' && status !== 'STOPPED') {
      throw new Error('종료된 알림은 다시 시작할 수 없습니다. 새 알림을 만들어 주세요.');
    }

    const now = new Date().toISOString();
    session.status = status;
    if (status === 'RUNNING') {
      session.startedAt = session.startedAt || now;
      session.pausedAt = null;
    } else if (status === 'PAUSED') {
      session.pausedAt = now;
    } else if (status === 'STOPPED') {
      session.endedAt = now;
    }
    this.state.updatedAt = now;
    this.saveState();
    this.emitUpdate('session', { session: this.publicSession(session) });
    return this.publicSession(session);
  }

  sessionMatches(session, event) {
    if (session.status !== 'RUNNING') return false;
    if (!session.eventTypes?.includes(event.type)) return false;
    if (session.coins?.length > 0 && event.coin && !session.coins.includes(event.coin)) return false;
    if (session.coins?.length > 0 && !event.coin) return false;
    return true;
  }

  enqueue(work) {
    const result = this.ingestQueue.then(work);
    this.ingestQueue = result.catch(() => undefined);
    return result;
  }

  async waitForPendingConsultations(timeoutMs = 30_000) {
    const pending = [...this.pendingConsultations.values()];
    if (pending.length === 0) return { pendingCount: 0, timedOut: false };
    let timer = null;
    const timedOut = await Promise.race([
      Promise.allSettled(pending).then(() => false),
      new Promise(resolve => {
        timer = setTimeout(() => resolve(true), Math.max(0, Number(timeoutMs) || 30_000));
      })
    ]);
    if (timer) clearTimeout(timer);
    return { pendingCount: pending.length, timedOut };
  }

  ingestCycle(cycle = {}) {
    return this.enqueue(() => this._ingestCycle(cycle));
  }

  async _ingestCycle(cycle) {
    const timestamp = cycle.timestamp || new Date().toISOString();
    const analyses = Array.isArray(cycle.analyses) ? cycle.analyses : [];
    this.state.latestSnapshot = {
      timestamp,
      source: cycle.source || 'trading_cycle',
      mode: cycle.mode || null,
      krwBalance: numberOrNull(cycle.krwBalance),
      currentPositions: numberOrNull(cycle.currentPositions),
      marketRegime: compactObject(cycle.marketRegime, 12),
      analyses: analyses.slice(0, 80).map(compactAnalysis)
    };
    this.recordPriceObservations(analyses, timestamp);
    this.evaluatePendingConsultations();
    const events = analyses.map(analysis => eventFromAnalysis(analysis, timestamp)).filter(Boolean);
    const result = this._ingestEvents(events);
    this.state.updatedAt = new Date().toISOString();
    try {
      this.saveState();
    } catch {
      // Keep the live loop alive; the API can still expose in-memory state.
    }
    return result;
  }

  recordPriceObservations(analyses = [], timestamp) {
    const observationTimestamp = timestamp || new Date().toISOString();
    if (timestampMs(observationTimestamp) === null) return;
    for (const analysis of Array.isArray(analyses) ? analyses : []) {
      const coin = String(analysis?.coin || '').trim().toUpperCase();
      const price = numberOrNull(analysis?.currentPrice);
      if (!coin || price === null || price <= 0) continue;
      const previous = this.state.priceObservations.at(-1);
      if (previous?.coin === coin && previous.timestamp === observationTimestamp) {
        previous.price = price;
        continue;
      }
      this.state.priceObservations.push({ coin, price, timestamp: observationTimestamp });
    }
    this.state.priceObservations = this.state.priceObservations.slice(-this.maxPriceObservations);
  }
  ingestNews(news) {
    return this.enqueue(() => this._ingestEvents([eventFromNews(news, new Date().toISOString())].filter(Boolean)));
  }

  ingestTrade(trade) {
    return this.enqueue(() => this._ingestEvents([eventFromTrade(trade, new Date().toISOString())].filter(Boolean)));
  }

  ingestBundle(bundle) {
    return this.enqueue(() => this._ingestEvents([eventFromBundle(bundle, new Date().toISOString())].filter(Boolean)));
  }

  _ingestEvents(events) {
    const created = [];
    const autoConsultations = [];
    const nowMs = Date.now();

    for (const incoming of events) {
      let event = this.state.events.find(candidate => candidate.key === incoming.key);
      if (!event) {
        event = {
          ...incoming,
          sessionIds: []
        };
        this.state.events.push(event);
        created.push(event);
      }

      for (const session of this.state.sessions) {
        if (!this.sessionMatches(session, event)) continue;
        session.seenEventKeys = Array.isArray(session.seenEventKeys) ? session.seenEventKeys : [];
        if (session.seenEventKeys.includes(event.key)) continue;

        session.seenEventKeys.push(event.key);
        if (session.seenEventKeys.length > 240) session.seenEventKeys = session.seenEventKeys.slice(-240);
        if (!event.sessionIds.includes(session.id)) event.sessionIds.push(session.id);
        session.eventCount = (Number(session.eventCount) || 0) + 1;
        session.lastEventAt = event.timestamp;

        const autoConsultEventTypes = Array.isArray(session.autoConsultEventTypes)
          ? session.autoConsultEventTypes
          : session.eventTypes;
        if (session.autoConsult && autoConsultEventTypes.includes(event.type)) {
          session.lastConsultByEventKey = session.lastConsultByEventKey || {};
          const lastRequested = Number(session.lastConsultByEventKey[event.key]) || 0;
          const cooldownMs = Number(session.cooldownSeconds || 300) * 1000;
          if (nowMs - lastRequested >= cooldownMs) {
            session.lastConsultByEventKey[event.key] = nowMs;
            autoConsultations.push({ sessionId: session.id, eventId: event.id, provider: session.providers, auto: true });
          }
        }
        this.emitUpdate('session', { session: this.publicSession(session) });
      }

      if (created.includes(event)) {
        this.emitUpdate('event', { event });
      }
    }

    this.state.events = this.state.events.slice(-this.maxEvents);
    this.state.updatedAt = new Date().toISOString();
    try {
      this.saveState();
    } catch {
      // Persistence is best effort for the live notification lane.
    }

    for (const request of autoConsultations) {
      this.requestConsultation(request).catch(() => undefined);
    }
    return { events: created, autoConsultationCount: autoConsultations.length };
  }

  addManualEvent(eventInput) {
    const event = {
      id: eventInput?.id || randomUUID(),
      key: eventInput?.key || `MANUAL:${Date.now()}:${randomUUID()}`,
      type: EVENT_TYPES.has(String(eventInput?.type).toUpperCase()) ? String(eventInput.type).toUpperCase() : 'REBOUND_CANDIDATE',
      action: ['BUY', 'SELL'].includes(String(eventInput?.action).toUpperCase()) ? String(eventInput.action).toUpperCase() : 'WAIT',
      coin: eventInput?.coin ? String(eventInput.coin).toUpperCase() : null,
      price: numberOrNull(eventInput?.price ?? eventInput?.snapshot?.currentPrice),
      confidence: eventInput?.confidence ?? null,
      signalStrength: eventInput?.signalStrength || null,
      reason: truncate(eventInput?.reason || '사용자 지정 의견 요청', 240),
      signalKey: eventInput?.signalKey || null,
      timestamp: eventInput?.timestamp || new Date().toISOString(),
      source: 'manual',
      snapshot: compactObject(eventInput?.snapshot || eventInput, 30),
      sessionIds: []
    };
    this.state.events.push(event);
    this.state.events = this.state.events.slice(-this.maxEvents);
    this.state.updatedAt = new Date().toISOString();
    this.saveState();
    this.emitUpdate('event', { event });
    return event;
  }

  requestConsultation({ sessionId = null, eventId = null, event = null, provider = null, auto = false } = {}) {
    const session = sessionId ? this.findSession(sessionId) : null;
    if (sessionId && !session) return Promise.reject(new Error('관심 신호 설정을 찾지 못했습니다.'));

    let selectedEvent = eventId ? this.findEvent(eventId) : event;
    if (!selectedEvent && event && typeof event === 'object') selectedEvent = this.addManualEvent(event);
    if (!selectedEvent) return Promise.reject(new Error('의견을 요청할 신호를 찾지 못했습니다.'));

    const providers = normalizeProviderValue(provider ?? session?.providers);
    if (providers.length === 0) return Promise.reject(new Error('의견을 받을 서비스를 하나 이상 선택해 주세요.'));
    const pendingKey = `${sessionId || 'manual'}:${selectedEvent.id}:${providers.join(',')}`;
    if (this.pendingConsultations.has(pendingKey)) return this.pendingConsultations.get(pendingKey);

    const consultation = {
      id: randomUUID(),
      sessionId,
      eventId: selectedEvent.id,
      providerSelection: providers,
      auto,
      status: 'RUNNING',
      createdAt: new Date().toISOString(),
      completedAt: null,
      results: [],
      consensus: null,
      error: null,
      evaluation: buildPendingEvaluation(selectedEvent, session, {
        evaluationMinutes: this.defaultEvaluationMinutes,
        neutralBandPercent: this.evaluationNeutralBandPercent
      }),
      event: selectedEvent
    };
    this.state.consultations.push(consultation);
    this.state.consultations = this.state.consultations.slice(-this.maxConsultations);
    if (session) {
      session.consultationCount = (Number(session.consultationCount) || 0) + 1;
      session.lastConsultAt = consultation.createdAt;
    }
    this.state.updatedAt = consultation.createdAt;
    try {
      this.saveState();
    } catch {
      // The request may still complete; the final state will retry persistence.
    }
    this.emitUpdate('consultation', { consultation: { ...consultation } });

    const work = (async () => {
      try {
        if (!this.advisor) throw new Error('현재 의견 기능을 사용할 수 없습니다.');
        const response = await this.advisor.ask({
          provider: providers,
          event: selectedEvent,
          context: {
            latestSnapshot: this.state.latestSnapshot,
            recentEvents: this.state.events.slice(-8),
            evaluation: {
              horizonMinutes: session?.evaluationMinutes ?? this.defaultEvaluationMinutes,
              neutralBandPercent: this.evaluationNeutralBandPercent
            }
          },
          session: session || {}
        });
        consultation.status = response.status || 'FAILED';
        consultation.requestId = response.requestId || null;
        consultation.results = Array.isArray(response.results) ? response.results : [];
        consultation.consensus = response.consensus || null;
        consultation.error = response.error || null;
      } catch (error) {
        consultation.status = 'FAILED';
        consultation.error = truncate(error?.message || error, 500);
      }
      consultation.completedAt = new Date().toISOString();
      this.refreshConsultationEvaluation(consultation);
      this.state.updatedAt = consultation.completedAt;
      try {
        this.saveState();
      } catch {
        // Keep the completed result in memory and expose the error via status.
      }
      this.emitUpdate('consultation', { consultation: { ...consultation } });
      // The future price observation may have arrived while the provider was
      // still running. Re-evaluate immediately so effectiveness does not wait
      // for an unrelated later market cycle.
      this.evaluatePendingConsultations();
      return { ...consultation };
    })().finally(() => {
      this.pendingConsultations.delete(pendingKey);
    });

    this.pendingConsultations.set(pendingKey, work);
    return work;
  }
}

export {
  EVENT_TYPES,
  compactAnalysis,
  eventFromAnalysis,
  eventFromNews,
  eventFromTrade,
  eventFromBundle,
  scoreAdviceOutcome,
  normalizeEventTypes,
  normalizeCoins,
  normalizeProviderValue
};

export default MonitoringSessionService;
