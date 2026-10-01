// 모니터링 세션 이벤트 모델 — monitoringSessionService.js에서 추출.
// 이벤트/상담의 정규화·직렬화·점수화 순수 함수; 상태 없음.
import { randomUUID } from 'node:crypto';


export function truncate(value, maxLength) {
  const text = String(value ?? '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}


export function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}


export function timestampMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}


export function resolveEvaluationMinutes(value, fallback = DEFAULT_EVALUATION_MINUTES) {
  const parsed = Number(value);
  const resolved = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.max(1, Math.min(1_440, Math.round(resolved)));
}


export function resolveNeutralBandPercent(value, fallback = DEFAULT_NEUTRAL_BAND_PERCENT) {
  const parsed = Number(value);
  const resolved = Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  return Math.max(0, Math.min(10, resolved));
}


export function normalizeAdviceAction(value) {
  const action = String(value || '').trim().toUpperCase();
  return ['BUY', 'SELL', 'HOLD', 'WAIT'].includes(action) ? action : 'WAIT';
}


export function scoreAdviceOutcome(advice, priceChangePercent, neutralBandPercent = DEFAULT_NEUTRAL_BAND_PERCENT, eventAction = null) {
  const action = normalizeAdviceAction(advice?.action);
  const move = numberOrNull(priceChangePercent);
  const neutralBand = resolveNeutralBandPercent(neutralBandPercent);
  const sourceAction = normalizeAdviceAction(eventAction);
  let vetoImpactPercent = null;
  const vetoVerdict = move !== null && (action === 'WAIT' || action === 'HOLD') &&
    (sourceAction === 'BUY' || sourceAction === 'SELL')
    ? (() => {
      const signedMove = sourceAction === 'BUY' ? move : -move;
      const excessMove = Math.max(0, Math.abs(signedMove) - neutralBand);
      if (excessMove === 0) {
        vetoImpactPercent = 0;
        return 'VETO_FLAT';
      }
      if (signedMove < 0) {
        vetoImpactPercent = excessMove;
        return 'VETO_GOOD';
      }
      vetoImpactPercent = -excessMove;
      return 'VETO_MISSED_OPPORTUNITY';
    })()
    : null;
  if (move === null) {
    return {
      action,
      confidence: numberOrNull(advice?.confidence),
      verdict: 'NOT_EVALUABLE',
      signedMovePercent: null,
      priceChangePercent: null,
      score: null,
      vetoVerdict: null,
      vetoImpactPercent: null
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
      score: verdict === 'HIT' ? 1 : verdict === 'MISS' ? -1 : 0,
      vetoVerdict: null,
      vetoImpactPercent: null
    };
  }

  return {
    action,
    confidence: numberOrNull(advice?.confidence),
    verdict: Math.abs(move) <= neutralBand ? 'CALM' : 'ABSTAINED',
    signedMovePercent: null,
    priceChangePercent: move,
    score: null,
    vetoVerdict,
    vetoImpactPercent
  };
}


export function buildPendingEvaluation(event, session, defaults) {
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


export function compactObject(value, maxKeys = 30) {
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


export function normalizeEventTypes(value) {
  const types = Array.isArray(value) ? value : value ? [value] : [];
  const normalized = types
    .map(type => String(type).trim().toUpperCase())
    .filter(type => EVENT_TYPES.has(type));
  return [...new Set(normalized)];
}


export function normalizeCoins(value) {
  const coins = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return [...new Set(coins
    .map(coin => String(coin).trim().toUpperCase())
    .filter(Boolean)
    .map(coin => coin.startsWith('KRW-') ? coin : `KRW-${coin}`))].slice(0, 100);
}


export function normalizeProviderValue(value, fallback = ['gpt', 'claude']) {
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


export function compactRebound(rebound) {
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


export function compactAnalysis(analysis) {
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


export function eventKeyForAnalysis(analysis, eventType) {
  const decision = analysis?.decision || {};
  const rebound = decision.details?.rebound || analysis?.technicalAnalysis?.indicators?.rebound || {};
  const signalKey = decision.entrySignalKey || rebound.signalKey || rebound.candleTime;
  if (signalKey) return `${eventType}:${analysis.coin}:${signalKey}`;
  const reason = truncate(decision.reason || 'unknown', 80);
  const price = numberOrNull(analysis.currentPrice);
  return `${eventType}:${analysis.coin}:${reason}:${price === null ? 'na' : Math.round(price * 100) / 100}`;
}


export function eventFromAnalysis(analysis, timestamp) {
  if (!analysis?.coin) return null;
  const action = String(analysis.decision?.action || 'HOLD').toUpperCase();
  const rebound = analysis.decision?.details?.rebound || analysis.technicalAnalysis?.indicators?.rebound;
  if (analysis.decision?.details?.signalAlreadyProcessed === true) return null;
  const reboundCandidate = rebound?.available === true && (
    rebound.reboundConfirmed === true ||
    rebound.previousWasOversold === true ||
    rebound.currentWasOversold === true
  );
  const type = action === 'BUY'
    ? 'BUY_SIGNAL'
    : action === 'SELL'
      ? 'SELL_SIGNAL'
      : reboundCandidate
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


export function eventFromNews(news, timestamp) {
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


export function eventFromTrade(trade, timestamp) {
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


export function eventFromBundle(bundle, timestamp) {
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


export function emptyState() {
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


export const SCHEMA_VERSION = 1;

export const DEFAULT_MAX_EVENTS = 240;

export const DEFAULT_MAX_CONSULTATIONS = 160;

export const DEFAULT_EVALUATION_MINUTES = 5;
// Default neutral band reflects two exchange fees plus adverse slippage
// (0.05% fee and 0.10% slippage on each side), not raw price noise alone.

export const DEFAULT_NEUTRAL_BAND_PERCENT = 0.3;

export const DEFAULT_MINIMUM_EVALUATION_SAMPLES = 20;

export const DEFAULT_MAX_PRICE_OBSERVATIONS = 5_000;

export const EVENT_TYPES = new Set([
  'BUY_SIGNAL',
  'SELL_SIGNAL',
  'REBOUND_CANDIDATE',
  'BREAKING_NEWS',
  'BUNDLE_SUGGESTION',
  'TRADE_EXECUTED'
]);
