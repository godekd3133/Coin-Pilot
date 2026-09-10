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
  if (eventTypes.length === 0) throw new Error('최소 하나의 monitoring event를 선택해주세요');

  const name = String(body.name || '').trim();
  if (name.length > 80) throw new Error('session 이름은 80자 이내로 입력해주세요');

  const cooldownSeconds = Number(body.cooldownSeconds ?? 300);
  if (!Number.isFinite(cooldownSeconds) || cooldownSeconds < 30 || cooldownSeconds > 86_400) {
    throw new Error('cooldownSeconds는 30~86400 범위여야 합니다');
  }

  return {
    ...body,
    name: name || 'CoinPilot AI 모니터링',
    eventTypes,
    autoConsult: parseBoolean(body.autoConsult, true),
    cooldownSeconds
  };
}

export default function createAiRoutes(server) {
  const router = express.Router();
  const sessions = server.monitoringSessions;

  router.get('/ai/providers', async (req, res) => {
    try {
      const status = await server.aiAdvisor.getProviderStatus({ force: req.query.refresh === 'true' });
      return res.json(status);
    } catch (error) {
      return res.status(500).json({ enabled: false, providers: [], error: error.message });
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
    if (!session) return res.status(404).json({ success: false, error: 'monitoring session을 찾지 못했습니다' });
    return res.json({
      session: sessions.publicSession(session),
      ...sessions.getSnapshot({ limit: Number(req.query.limit) || 60, sessionId: session.id })
    });
  });

  router.post('/ai/sessions/:sessionId/:action', (req, res) => {
    const actionMap = { pause: 'PAUSED', resume: 'RUNNING', stop: 'STOPPED' };
    const status = actionMap[req.params.action];
    if (!status) return res.status(404).json({ success: false, error: '지원하지 않는 session action입니다' });
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
        return res.status(400).json({ success: false, error: 'eventId 또는 event가 필요합니다' });
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
