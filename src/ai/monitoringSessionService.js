import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_EVENTS = 240;
const DEFAULT_MAX_CONSULTATIONS = 160;
const DEFAULT_EVALUATION_MINUTES = 5;
const DEFAULT_NEUTRAL_BAND_PERCENT = 0.1;
const DEFAULT_MINIMUM_EVALUATION_SAMPLES = 20;
const DEFAULT_MAX_PRICE_OBSERVATIONS = 5_000;
const EVENT_TYPES = new Set([
  'BUY_SIGNAL',
  'SELL_SIGNAL',
  'REBOUND_CANDIDATE',
  'BREAKING_NEWS',
  'BUNDLE_SUGGESTION',
  'TRADE_EXECUTED'
]);

function truncate(value, maxLength) {
  const text = String(value ?? '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestampMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveEvaluationMinutes(value, fallback = DEFAULT_EVALUATION_MINUTES) {
  const parsed = Number(value);
  const resolved = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.max(1, Math.min(1_440, Math.round(resolved)));
}

function resolveNeutralBandPercent(value, fallback = DEFAULT_NEUTRAL_BAND_PERCENT) {
  const parsed = Number(value);
  const resolved = Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  return Math.max(0, Math.min(10, resolved));
}

function normalizeAdviceAction(value) {
  const action = String(value || '').trim().toUpperCase();
  return ['BUY', 'SELL', 'HOLD', 'WAIT'].includes(action) ? action : 'WAIT';
}

function scoreAdviceOutcome(advice, priceChangePercent, neutralBandPercent = DEFAULT_NEUTRAL_BAND_PERCENT) {
  const action = normalizeAdviceAction(advice?.action);
  const move = numberOrNull(priceChangePercent);
  const neutralBand = resolveNeutralBandPercent(neutralBandPercent);
  if (move === null) {
    return {
      action,
      confidence: numberOrNull(advice?.confidence),
      verdict: 'NOT_EVALUABLE',
      signedMovePercent: null,
      priceChangePercent: null,
      score: null
    };
  }

  if (action === 'BUY' || action === 'SELL') {
    const signedMovePercent = action === 'BUY' ? move : -move;
    const verdict = Math.abs(move) <= neutralBand
      ? 'FLAT'
      : signedMovePercent > 0 ? 'HIT' : 'MISS';
    return {
      action,
      confidence: numberOrNull(advice?.confidence),
      verdict,
      signedMovePercent,
      priceChangePercent: move,
      score: verdict === 'HIT' ? 1 : verdict === 'MISS' ? -1 : 0
    };
  }

  return {
    action,
    confidence: numberOrNull(advice?.confidence),
    verdict: Math.abs(move) <= neutralBand ? 'CALM' : 'ABSTAINED',
    signedMovePercent: null,
    priceChangePercent: move,
    score: null
  };
}

function buildPendingEvaluation(event, session, defaults) {
  const baselinePrice = numberOrNull(event?.price ?? event?.snapshot?.currentPrice);
  const baselineAt = event?.timestamp || null;
  const freshness = event?.snapshot?.freshness || event?.snapshot?.candleFreshness || {};
  const snapshotValid = freshness.valid !== false;
  const evaluationMinutes = resolveEvaluationMinutes(
    session?.evaluationMinutes,
    defaults.evaluationMinutes
  );
  const baselineTimestamp = timestampMs(baselineAt);
  const targetAt = baselineTimestamp === null
    ? null
    : new Date(baselineTimestamp + evaluationMinutes * 60_000).toISOString();
  return {
    status: snapshotValid && baselinePrice !== null && baselinePrice > 0 && baselineTimestamp !== null ? 'PENDING' : 'NOT_EVALUABLE',
    coin: event?.coin ? String(event.coin).toUpperCase() : null,
    snapshotValid,
    baselinePrice,
    baselineAt,
    decisionPrice: null,
    decisionAt: null,
    adviceLatencySeconds: null,
    targetAt,
    horizonMinutes: evaluationMinutes,
    neutralBandPercent: defaults.neutralBandPercent,
    outcomePrice: null,
    outcomeAt: null,
    observedAfterMinutes: null,
    priceChangePercent: null,
    verdicts: [],
    reason: !snapshotValid
      ? `snapshot 신선도 실패(${freshness.reason || 'invalid'})로 평가하지 않습니다.`
      : baselinePrice === null || baselinePrice <= 0 || baselineTimestamp === null
        ? '기준 가격 또는 기준 시간이 없어 미래 가격 대조를 수행할 수 없습니다.'
      : null,
    evaluatedAt: null
  };
}

function compactObject(value, maxKeys = 30) {
  if (!value || typeof value !== 'object') return value ?? null;
  if (Array.isArray(value)) return value.slice(0, 20).map(item => compactObject(item, maxKeys));
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, maxKeys)
      .map(([key, nested]) => [
        key,
        typeof nested === 'string' ? truncate(nested, 260) : compactObject(nested, maxKeys)
      ])
  );
}

function normalizeEventTypes(value) {
  const types = Array.isArray(value) ? value : value ? [value] : [];
  const normalized = types
    .map(type => String(type).trim().toUpperCase())
    .filter(type => EVENT_TYPES.has(type));
  return [...new Set(normalized)];
}

function normalizeCoins(value) {
  const coins = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return [...new Set(coins
    .map(coin => String(coin).trim().toUpperCase())
    .filter(Boolean)
    .map(coin => coin.startsWith('KRW-') ? coin : `KRW-${coin}`))].slice(0, 100);
}

function normalizeProviderValue(value, fallback = ['gpt', 'claude']) {
  const providers = Array.isArray(value) ? value : value ? [value] : fallback;
  const normalized = providers.flatMap(provider => {
    const key = String(provider).trim().toLowerCase();
    if (key === 'both' || key === 'all') return ['gpt', 'claude'];
    if (key === 'openai' || key === 'chatgpt' || key === 'codex') return ['gpt'];
    if (key === 'anthropic') return ['claude'];
    return ['gpt', 'claude'].includes(key) ? [key] : [];
  });
  return [...new Set(normalized)];
}

function compactRebound(rebound) {
  if (!rebound || typeof rebound !== 'object') return null;
  const keys = [
    'available',
    'oversold',
    'previousWasOversold',
    'currentWasOversold',
    'bullishCandle',
    'reboundConfirmed',
    'priceChangePercent',
    'reboundPriceChangePercent',
    'rsi',
    'previousRsi',
    'oversoldRsi',
    'rsiRecovery',
    'volumeRatio',
    'closeStrength',
    'trendSlopePercent',
    'signalRangePercent',
    'signalKey',
    'candleTime',
    'rejectionReasons'
  ];
  return Object.fromEntries(keys
    .filter(key => rebound[key] !== undefined)
    .map(key => [key, Array.isArray(rebound[key])
      ? rebound[key].slice(0, 8).map(item => truncate(item, 120))
      : typeof rebound[key] === 'string' ? truncate(rebound[key], 160) : rebound[key]]));
}

function compactAnalysis(analysis) {
  const decision = analysis?.decision || {};
  const technical = analysis?.technicalAnalysis?.indicators || {};
  const rebound = decision.details?.rebound || technical.rebound || null;
  const position = analysis?.position || {};
  return {
    coin: analysis?.coin || null,
    currentPrice: numberOrNull(analysis?.currentPrice),
    coinBalance: numberOrNull(analysis?.coinBalance),
    action: decision.action || 'HOLD',
    reason: truncate(decision.reason || '', 240),
    confidence: decision.confidence ?? null,
    signalStrength: decision.signalStrength?.level || null,
    scores: compactObject(decision.scores, 8),
    indicators: {
      rsi: numberOrNull(technical.rsi ?? rebound?.rsi),
      macd: compactObject(technical.macd, 6),
      bollingerBands: compactObject(technical.bollingerBands, 8),
      crossover: technical.crossover || null,
      volume: compactObject(technical.volume, 8),
      rebound: compactRebound(rebound)
    },
    position: {
      hasPosition: position.hasPosition === true || numberOrNull(analysis?.coinBalance) > 0,
      avgPrice: numberOrNull(position.avgPrice),
      profitPercent: numberOrNull(position.profitPercent)
    },
    freshness: compactObject(analysis?.candleFreshness || decision.details?.candleFreshness, 10),
    marketRegime: compactObject(analysis?.marketRegime || decision.details?.marketRegime, 12),
    sentiment: compactObject(analysis?.sentiment, 12)
  };
}

function eventKeyForAnalysis(analysis, eventType) {
  const decision = analysis?.decision || {};
  const rebound = decision.details?.rebound || analysis?.technicalAnalysis?.indicators?.rebound || {};
  const signalKey = decision.entrySignalKey || rebound.signalKey || rebound.candleTime;
  if (signalKey) return `${eventType}:${analysis.coin}:${signalKey}`;
  const reason = truncate(decision.reason || 'unknown', 80);
  const price = numberOrNull(analysis.currentPrice);
  return `${eventType}:${analysis.coin}:${reason}:${price === null ? 'na' : Math.round(price * 100) / 100}`;
}

function eventFromAnalysis(analysis, timestamp) {
  if (!analysis?.coin) return null;
  const action = String(analysis.decision?.action || 'HOLD').toUpperCase();
  const rebound = analysis.decision?.details?.rebound || analysis.technicalAnalysis?.indicators?.rebound;
  const type = action === 'BUY'
    ? 'BUY_SIGNAL'
    : action === 'SELL'
      ? 'SELL_SIGNAL'
      : rebound?.reboundConfirmed === true
        ? 'REBOUND_CANDIDATE'
        : null;
  if (!type) return null;

  const compact = compactAnalysis(analysis);
  return {
    id: randomUUID(),
    key: eventKeyForAnalysis(analysis, type),
    type,
    action: action === 'BUY' || action === 'SELL' ? action : 'WAIT',
    coin: analysis.coin,
    price: numberOrNull(analysis.currentPrice),
    confidence: analysis.decision?.confidence ?? null,
    signalStrength: analysis.decision?.signalStrength?.level || null,
    reason: truncate(analysis.decision?.reason || '', 240),
    signalKey: rebound?.signalKey || analysis.decision?.entrySignalKey || null,
    timestamp,
    source: 'trading_cycle',
    snapshot: compact
  };
}

function eventFromNews(news, timestamp) {
  if (!news || !news.title) return null;
  const title = truncate(news.title, 180);
  return {
    id: randomUUID(),
    key: `BREAKING_NEWS:${title}:${news.link || news.url || ''}`,
    type: 'BREAKING_NEWS',
    action: 'WAIT',
    coin: news.coin ? (String(news.coin).startsWith('KRW-') ? String(news.coin).toUpperCase() : `KRW-${String(news.coin).toUpperCase()}`) : null,
    price: null,
    confidence: null,
    signalStrength: null,
    reason: title,
    signalKey: null,
    timestamp: news.timestamp || timestamp,
    source: 'breaking_news',
    snapshot: {
      title,
      description: truncate(news.description || news.summary || '', 500),
      source: truncate(news.source || '', 100),
      url: truncate(news.url || news.link || '', 500),
      sentiment: numberOrNull(news.sentiment)
    }
  };
}

function eventFromTrade(trade, timestamp) {
  if (!trade?.coin || !trade?.type) return null;
  const action = String(trade.type).toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
  const price = numberOrNull(trade.price);
  return {
    id: randomUUID(),
    key: `TRADE_EXECUTED:${trade.orderId || trade.timestamp || timestamp}:${trade.coin}:${action}`,
    type: 'TRADE_EXECUTED',
    action,
    coin: String(trade.coin).toUpperCase(),
    price,
    confidence: null,
    signalStrength: trade.signalStrength || null,
    reason: truncate(trade.reason || '', 240),
    signalKey: null,
    timestamp: trade.timestamp || timestamp,
    source: 'trade_callback',
    snapshot: {
      mode: trade.mode || null,
      amount: numberOrNull(trade.amount),
      volume: numberOrNull(trade.volume),
      profitPercent: numberOrNull(trade.profitPercent),
      profitAmount: numberOrNull(trade.profitAmount),
      fee: numberOrNull(trade.fee)
    }
  };
}

function eventFromBundle(bundle, timestamp) {
  if (!bundle?.buy?.coin) return null;
  const sellCoin = bundle.sell?.coin || 'NEW';
  const buyCoin = String(bundle.buy.coin).toUpperCase();
  const rationale = truncate(bundle.rationale || bundle.summary || '리밸런싱 제안', 180);
  return {
    id: randomUUID(),
    key: `BUNDLE_SUGGESTION:${sellCoin}->${buyCoin}:${rationale}`,
    type: 'BUNDLE_SUGGESTION',
    action: 'BUY',
    coin: buyCoin,
    price: numberOrNull(bundle.buy.currentPrice),
    confidence: numberOrNull(bundle.totalScore),
    signalStrength: null,
    reason: rationale,
    signalKey: null,
    timestamp,
    source: 'bundle_suggestion',
    snapshot: {
      sell: compactObject(bundle.sell, 12),
      buy: compactObject(bundle.buy, 12),
      totalScore: numberOrNull(bundle.totalScore),
      summary: truncate(bundle.summary || '', 220)
    }
  };
}

function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    latestSnapshot: null,
    events: [],
    consultations: [],
    priceObservations: [],
    sessions: []
  };
}

export class MonitoringSessionService {
  constructor(options = {}) {
    this.workspaceRoot = options.workspaceRoot || process.cwd();
    this.stateFile = options.stateFile || options.config?.aiMonitoringFile || process.env.AI_MONITORING_FILE ||
      path.join(this.workspaceRoot, 'ai_monitoring_sessions.json');
    this.advisor = options.advisor;
    this.maxEvents = Math.max(40, Number(options.maxEvents || DEFAULT_MAX_EVENTS));
    this.maxConsultations = Math.max(40, Number(options.maxConsultations || DEFAULT_MAX_CONSULTATIONS));
    this.maxPriceObservations = Math.max(500, Number(options.maxPriceObservations || DEFAULT_MAX_PRICE_OBSERVATIONS));
    this.defaultEvaluationMinutes = resolveEvaluationMinutes(
      options.defaultEvaluationMinutes ?? options.config?.aiEvaluationMinutes ?? process.env.AI_EVALUATION_MINUTES,
      DEFAULT_EVALUATION_MINUTES
    );
    this.evaluationNeutralBandPercent = resolveNeutralBandPercent(
      options.evaluationNeutralBandPercent ?? options.config?.aiEvaluationNeutralBandPercent ?? process.env.AI_EVALUATION_NEUTRAL_BAND_PERCENT,
      DEFAULT_NEUTRAL_BAND_PERCENT
    );
    this.minimumEvaluationSamples = Math.max(1, Math.min(10_000, Number(
      options.minimumEvaluationSamples ?? options.config?.aiEvaluationMinSamples ?? process.env.AI_EVALUATION_MIN_SAMPLES
    ) || DEFAULT_MINIMUM_EVALUATION_SAMPLES));
    this.onUpdate = null;
    this.pendingConsultations = new Map();
    this.ingestQueue = Promise.resolve();
    this.state = this.loadState();
  }

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
          directionalPredictions: 0,
          hits: 0,
          misses: 0,
          flat: 0,
          calm: 0,
          abstained: 0,
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
          } else if (verdict.verdict === 'MISS') {
            stats.misses += 1;
            stats.directionalPredictions += 1;
          } else if (verdict.verdict === 'FLAT') {
            stats.flat += 1;
            stats.directionalPredictions += 1;
          } else if (verdict.verdict === 'CALM') {
            stats.calm += 1;
          } else if (verdict.verdict === 'ABSTAINED') {
            stats.abstained += 1;
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
      const outcomeEligible = stats.evaluated > 0;
      return {
        ...stats,
        completionRate: stats.attempted > 0 ? stats.completed / stats.attempted : null,
        averageLatencyMs: stats.completed > 0 ? Math.round(stats.latencyMsTotal / stats.completed) : null,
        hitRate: scored > 0 ? stats.hits / scored : null,
        averageSignedMovePercent: stats.directionalPredictions > 0
          ? stats.signedMovePercentTotal / stats.directionalPredictions
          : null,
        sufficientEvidence: outcomeEligible && stats.evaluated >= this.minimumEvaluationSamples
      };
    };

    const publicStats = Object.fromEntries([...providerStats.entries()]
      .map(([source, stats]) => [source, toPublicStats(stats)]));
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
        hitDefinition: 'BUY/SELL 방향이 neutral band를 넘어 미래 기준 시점 가격과 일치하면 HIT',
        waitDefinition: 'HOLD/WAIT는 방향 예측이 아니므로 CALM/ABSTAINED로 별도 집계',
        source: '동일 event의 기준 가격과 horizon 이후 첫 관측 가격'
      },
      sufficientEvidence: Object.values(publicStats).some(stats => stats.sufficientEvidence === true),
      evidenceWarning: Object.keys(publicStats).length === 0
        ? '실제 provider 응답이 없어 평가할 표본이 없습니다.'
        : evaluatedConsultations < this.minimumEvaluationSamples
          ? `아직 ${this.minimumEvaluationSamples}개 평가 표본이 필요합니다. 현재 ${evaluatedConsultations}개입니다.`
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
    if (eventTypes.length === 0) throw new Error('최소 하나의 monitoring event를 선택해주세요');
    if (providers.length === 0) throw new Error('최소 하나의 AI provider를 선택해주세요');

    const now = new Date().toISOString();
    const session = {
      id: randomUUID(),
      name: truncate(input.name || 'CoinPilot AI 모니터링', 80),
      status: 'RUNNING',
      providers,
      eventTypes,
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
    if (!session) throw new Error('monitoring session을 찾지 못했습니다');
    if (!['RUNNING', 'PAUSED', 'STOPPED'].includes(status)) throw new Error('지원하지 않는 session 상태입니다');
    if (session.status === 'STOPPED' && status !== 'STOPPED') {
      throw new Error('종료된 session은 재개할 수 없습니다. 새 session을 시작해주세요');
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

  actualProviderResults(consultation) {
    return (Array.isArray(consultation?.results) ? consultation.results : [])
      .filter(result => result?.provider && result.provider !== 'local-brief' && result.status === 'COMPLETED' && result.advice);
  }

  findEvaluationObservation(evaluation) {
    const targetTimestamp = timestampMs(evaluation?.targetAt);
    if (targetTimestamp === null) return null;
    const coin = String(evaluation.coin || '').toUpperCase();
    return this.state.priceObservations.find(observation =>
      observation.coin === coin && timestampMs(observation.timestamp) !== null &&
      timestampMs(observation.timestamp) >= targetTimestamp
    ) || null;
  }

  findLatestPriceObservation(coin, atMs) {
    const normalizedCoin = String(coin || '').toUpperCase();
    if (!normalizedCoin || !Number.isFinite(atMs)) return null;
    return this.state.priceObservations
      .filter(observation => observation.coin === normalizedCoin)
      .filter(observation => {
        const observedAt = timestampMs(observation.timestamp);
        return observedAt !== null && observedAt <= atMs;
      })
      .sort((a, b) => timestampMs(b.timestamp) - timestampMs(a.timestamp))[0] || null;
  }

  refreshConsultationEvaluation(consultation) {
    if (!consultation?.evaluation || consultation.status === 'RUNNING') return false;
    const evaluation = consultation.evaluation;
    if (evaluation.snapshotValid === false) {
      const reason = evaluation.reason || 'snapshot 신선도가 유효하지 않아 결과를 평가하지 않습니다.';
      if (evaluation.status !== 'NOT_EVALUABLE' || evaluation.reason !== reason) {
        evaluation.status = 'NOT_EVALUABLE';
        evaluation.reason = reason;
        evaluation.evaluatedAt = new Date().toISOString();
        return true;
      }
      return false;
    }
    const actualResults = this.actualProviderResults(consultation);
    if (actualResults.length === 0) {
      if (evaluation.status !== 'NOT_EVALUABLE' || evaluation.reason !== '실제 AI provider 응답이 없어 결과를 평가하지 않습니다.') {
        evaluation.status = 'NOT_EVALUABLE';
        evaluation.reason = '실제 AI provider 응답이 없어 결과를 평가하지 않습니다.';
        evaluation.evaluatedAt = new Date().toISOString();
        return true;
      }
      return false;
    }
    if (evaluation.baselinePrice === null || evaluation.baselinePrice <= 0 || timestampMs(evaluation.baselineAt) === null) {
      evaluation.status = 'NOT_EVALUABLE';
      evaluation.reason = '기준 가격 또는 기준 시간이 없어 미래 가격 대조를 수행할 수 없습니다.';
      evaluation.evaluatedAt = new Date().toISOString();
      return true;
    }

    if (!evaluation.decisionAt || evaluation.decisionPrice === null) {
      const completedTimestamp = timestampMs(consultation.completedAt);
      const decisionObservation = this.findLatestPriceObservation(evaluation.coin, completedTimestamp);
      evaluation.decisionPrice = numberOrNull(decisionObservation?.price) ?? evaluation.baselinePrice;
      evaluation.decisionAt = decisionObservation?.timestamp || evaluation.baselineAt;
      const eventTimestamp = timestampMs(evaluation.baselineAt);
      const decisionTimestamp = timestampMs(evaluation.decisionAt);
      evaluation.adviceLatencySeconds = eventTimestamp === null || decisionTimestamp === null
        ? null
        : Math.max(0, (decisionTimestamp - eventTimestamp) / 1_000);
      const targetTimestamp = timestampMs(evaluation.decisionAt);
      evaluation.targetAt = targetTimestamp === null
        ? null
        : new Date(targetTimestamp + evaluation.horizonMinutes * 60_000).toISOString();
    }

    const observation = this.findEvaluationObservation(evaluation);
    if (!observation) {
      evaluation.status = 'PENDING';
      return false;
    }

    const outcomePrice = numberOrNull(observation.price);
    const decisionPrice = numberOrNull(evaluation.decisionPrice);
    const priceChangePercent = outcomePrice === null || decisionPrice === null || decisionPrice === 0
      ? null
      : ((outcomePrice - decisionPrice) / decisionPrice) * 100;
    const verdicts = actualResults.map(result => ({
      source: result.provider,
      providerLabel: result.providerLabel || result.provider,
      ...scoreAdviceOutcome(result.advice, priceChangePercent, evaluation.neutralBandPercent)
    }));
    if (consultation.consensus && consultation.consensus.providerCount > 0 && consultation.consensus.quorum === true) {
      verdicts.push({
        source: 'consensus',
        providerLabel: 'Provider consensus',
        ...scoreAdviceOutcome(consultation.consensus, priceChangePercent, evaluation.neutralBandPercent)
      });
    }

    const baselineTimestamp = timestampMs(evaluation.baselineAt);
    const outcomeTimestamp = timestampMs(observation.timestamp);
    evaluation.status = 'COMPLETED';
    evaluation.outcomePrice = outcomePrice;
    evaluation.outcomeAt = observation.timestamp;
    evaluation.observedAfterMinutes = outcomeTimestamp === null || baselineTimestamp === null
      ? null
      : (outcomeTimestamp - baselineTimestamp) / 60_000;
    evaluation.priceChangePercent = priceChangePercent;
    evaluation.verdicts = verdicts;
    evaluation.reason = null;
    evaluation.evaluatedAt = new Date().toISOString();
    return true;
  }

  evaluatePendingConsultations() {
    const changedConsultations = [];
    for (const consultation of this.state.consultations) {
      if (consultation.evaluation?.status !== 'PENDING') continue;
      if (this.refreshConsultationEvaluation(consultation)) {
        changedConsultations.push(consultation);
      }
    }
    if (changedConsultations.length > 0) {
      this.state.updatedAt = new Date().toISOString();
      try {
        this.saveState();
      } catch {
        // Keep the in-memory evaluation available even when persistence is
        // temporarily unavailable; the next cycle can retry the write.
      }
      for (const consultation of changedConsultations) {
        this.emitUpdate('consultation', { consultation: { ...consultation } });
      }
    }
    return changedConsultations.length > 0;
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

        if (session.autoConsult) {
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
      reason: truncate(eventInput?.reason || '사용자 지정 자문 이벤트', 240),
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
    if (sessionId && !session) return Promise.reject(new Error('monitoring session을 찾지 못했습니다'));

    let selectedEvent = eventId ? this.findEvent(eventId) : event;
    if (!selectedEvent && event && typeof event === 'object') selectedEvent = this.addManualEvent(event);
    if (!selectedEvent) return Promise.reject(new Error('자문할 event를 찾지 못했습니다'));

    const providers = normalizeProviderValue(provider ?? session?.providers);
    if (providers.length === 0) return Promise.reject(new Error('AI provider를 선택해주세요'));
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
        if (!this.advisor) throw new Error('AI advisor가 초기화되지 않았습니다');
        const response = await this.advisor.ask({
          provider: providers,
          event: selectedEvent,
          context: {
            latestSnapshot: this.state.latestSnapshot,
            recentEvents: this.state.events.slice(-8)
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
  normalizeEventTypes,
  normalizeCoins,
  normalizeProviderValue
};

export default MonitoringSessionService;
