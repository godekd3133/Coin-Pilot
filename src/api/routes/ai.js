import express from 'express';

const EVENT_TYPES = new Set([
  'BUY_SIGNAL',
  'SELL_SIGNAL',
  'REBOUND_CANDIDATE',
  'BREAKING_NEWS',
  'BUNDLE_SUGGESTION',
  'TRADE_EXECUTED'
]);

function parseBoolean(value, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return fallback;
}

function validateSessionInput(body = {}) {
  const rawEventTypes = Array.isArray(body.eventTypes) ? body.eventTypes : body.eventTypes ? [body.eventTypes] : [];
  const eventTypes = [...new Set(rawEventTypes
    .map(type => String(type).trim().toUpperCase())
    .filter(type => EVENT_TYPES.has(type)))];
  const rawAutoConsultEventTypes = Array.isArray(body.autoConsultEventTypes)
    ? body.autoConsultEventTypes
    : body.autoConsultEventTypes ? [body.autoConsultEventTypes] : null;
  const autoConsultEventTypes = rawAutoConsultEventTypes === null
    ? undefined
    : [...new Set(rawAutoConsultEventTypes
      .map(type => String(type).trim().toUpperCase())
      .filter(type => eventTypes.includes(type)))];
  if (eventTypes.length === 0) throw new Error('관심 신호를 하나 이상 선택해 주세요.');

  const name = String(body.name || '').trim();
  if (name.length > 80) throw new Error('이름은 80자 이내로 입력해 주세요.');

  const cooldownSeconds = Number(body.cooldownSeconds ?? 300);
  if (!Number.isFinite(cooldownSeconds) || cooldownSeconds < 30 || cooldownSeconds > 86_400) {
    throw new Error('같은 신호 재요청 간격은 30초~24시간 사이로 설정해 주세요.');
  }

  const hasEvaluationMinutes = body.evaluationMinutes !== undefined;
  const evaluationMinutes = hasEvaluationMinutes ? Number(body.evaluationMinutes) : null;
  if (hasEvaluationMinutes && (!Number.isFinite(evaluationMinutes) || evaluationMinutes < 1 || evaluationMinutes > 1_440)) {
    throw new Error('가격 확인 시점은 1분~24시간 사이로 설정해 주세요.');
  }

  return {
    ...body,
    name: name || '시장 신호 알림',
    eventTypes,
    ...(autoConsultEventTypes === undefined ? {} : { autoConsultEventTypes }),
    autoConsult: parseBoolean(body.autoConsult, true),
    cooldownSeconds,
    ...(hasEvaluationMinutes ? { evaluationMinutes } : {})
  };
}

export default function createAiRoutes(server) {
  const router = express.Router();
  const sessions = server.monitoringSessions;

  router.get('/ai/providers', async (req, res) => {
    try {
      const status = await server.aiAdvisor.getProviderStatus({ force: req.query.refresh === 'true' });
      return res.json(status);
    } catch {
      return res.status(500).json({ enabled: false, providers: [], error: '서비스 연결 상태를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' });
    }
  });

  router.get('/ai/monitoring', (req, res) => {
    const limit = Number(req.query.limit) || 40;
    const sessionId = req.query.sessionId ? String(req.query.sessionId) : null;
    return res.json(sessions.getSnapshot({ limit, sessionId }));
  });

  router.get('/ai/events', (req, res) => {
    const snapshot = sessions.getSnapshot({
      limit: Number(req.query.limit) || 40,
      sessionId: req.query.sessionId ? String(req.query.sessionId) : null
    });
    return res.json({ events: snapshot.events, updatedAt: snapshot.updatedAt });
  });

  router.get('/ai/consultations', (req, res) => {
    const snapshot = sessions.getSnapshot({
      limit: Number(req.query.limit) || 40,
      sessionId: req.query.sessionId ? String(req.query.sessionId) : null
    });
    return res.json({ consultations: snapshot.consultations, updatedAt: snapshot.updatedAt });
  });

  router.get('/ai/effectiveness', (req, res) => {
    const sessionId = req.query.sessionId ? String(req.query.sessionId) : null;
    return res.json(sessions.getEffectiveness({ sessionId }));
  });

  router.get('/ai/sessions', (req, res) => {
    return res.json({ sessions: sessions.getSessions(), updatedAt: sessions.getSnapshot({ limit: 1 }).updatedAt });
  });

  router.post('/ai/sessions', (req, res) => {
    try {
      const input = validateSessionInput(req.body || {});
      const session = sessions.createSession(input);
      return res.status(201).json({ success: true, session });
    } catch (error) {
      return res.status(400).json({ success: false, error: error.message });
    }
  });

  router.get('/ai/sessions/:sessionId', (req, res) => {
    const session = sessions.findSession(req.params.sessionId);
    if (!session) return res.status(404).json({ success: false, error: '관심 신호 설정을 찾지 못했습니다. 새로고침한 뒤 다시 시도해 주세요.' });
    return res.json({
      session: sessions.publicSession(session),
      ...sessions.getSnapshot({ limit: Number(req.query.limit) || 60, sessionId: session.id })
    });
  });

  router.post('/ai/sessions/:sessionId/:action', (req, res) => {
    const actionMap = { pause: 'PAUSED', resume: 'RUNNING', stop: 'STOPPED' };
    const status = actionMap[req.params.action];
    if (!status) return res.status(404).json({ success: false, error: '요청한 동작을 처리할 수 없습니다. 새로고침한 뒤 다시 시도해 주세요.' });
    try {
      const session = sessions.updateSessionStatus(req.params.sessionId, status);
      return res.json({ success: true, session });
    } catch (error) {
      return res.status(400).json({ success: false, error: error.message });
    }
  });

  router.post('/ai/consult', async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.eventId && !body.event) {
        return res.status(400).json({ success: false, error: '의견을 요청할 신호를 선택해 주세요.' });
      }
      const consultation = await sessions.requestConsultation({
        sessionId: body.sessionId ? String(body.sessionId) : null,
        eventId: body.eventId ? String(body.eventId) : null,
        event: body.event || null,
        provider: body.provider || body.providers || null,
        auto: false
      });
      return res.json({ success: consultation.status === 'COMPLETED', consultation });
    } catch (error) {
      return res.status(400).json({ success: false, error: error.message });
    }
  });

  return router;
}
