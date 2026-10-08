import express from 'express';
import { manualTradeNotifications } from '../orderPushService.js';

export function createNotificationRoutes(server) {
  const router = express.Router();
  router.get('/notifications/status', (req, res) => res.json(server.orderPush.summary()));
  router.post('/notifications/register', (req, res) => {
    try { res.json({ success: true, ...server.orderPush.register(req.body || {}) }); }
    catch { res.status(400).json({ success: false, error: '알림 기기를 등록하지 못했습니다.' }); }
  });
  router.post('/notifications/unregister', (req, res) => {
    try { server.orderPush.unregister(req.body?.deviceId); res.json({ success: true }); }
    catch { res.status(500).json({ success: false, error: '알림 기기 해제를 저장하지 못했습니다.' }); }
  });
  router.get('/automation/history', (req, res) => {
    const tracking = server.tradingSystem.autoRecovery?.tracking;
    res.json({ available: Boolean(tracking), latest: tracking?.state.latest || null,
      events: tracking?.state.events.slice(-200) || [], persistence: tracking?.summary() || null });
  });
  return router;
}

export function manualNotificationMiddleware(server) {
  return (req, res, next) => {
    if (req.method !== 'POST' || !req.path.startsWith('/trade/')) return next();
    const original = res.json;
    let result;
    res.json = function (body) { result = body; return original.call(this, body); };
    res.once('finish', () => {
      try {
        for (const trade of manualTradeNotifications(result, req, server.tradingSystem.dryRun ? 'DRY_RUN' : 'LIVE')) {
          server.emitTradeNotification(trade);
        }
      } catch (error) { server.orderPush.error = error.message; }
    });
    next();
  };
}
