import express from 'express';

// 기간별 포트폴리오(단기/스윙/중기/장기) 상태·제어. 인증된 /api 평면에서만 노출된다.
// 이 프로세스의 프로필 모드(모의/실전)에 해당하는 코인·주식 엔진을 다룬다.
export default function createHorizonRoutes(server) {
  const router = express.Router();

  const runtimesFor = asset => {
    if (asset === 'coin') return server.coinHorizon ? [server.coinHorizon] : [];
    if (asset === 'stock') return Object.values(server.stockTradingService?.horizons || {});
    return [];
  };

  router.get('/horizons/status', (req, res) => {
    res.json({
      coin: server.coinHorizon?.getStatus() ?? null,
      stock: Object.fromEntries(
        Object.entries(server.stockTradingService?.horizons || {}).map(([mode, runtime]) => [mode, runtime.getStatus()])
      )
    });
  });

  router.post('/horizons/:asset/:action', async (req, res) => {
    const { asset, action } = req.params;
    if (!['start', 'stop'].includes(action)) return res.status(404).json({ success: false, error: '지원하지 않는 동작입니다.' });
    const runtimes = runtimesFor(asset);
    if (runtimes.length === 0) {
      return res.status(404).json({ success: false, error: '기간별 포트폴리오가 비활성화되어 있습니다 (HORIZON_TRADING_ENABLED).' });
    }
    try {
      const statuses = [];
      for (const runtime of runtimes) {
        if (action === 'start') await runtime.manager.start({ source: 'operator' });
        else runtime.manager.stop({ source: 'operator' });
        statuses.push(runtime.getStatus());
      }
      return res.json({ success: true, statuses });
    } catch (error) {
      return res.status(400).json({ success: false, error: error.message });
    }
  });

  return router;
}
