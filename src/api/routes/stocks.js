import express from 'express';

// 주식(토스증권) 자동매매 상태/제어. 인증된 /api 평면 아래에서만 노출된다.
export default function createStockRoutes(server) {
  const router = express.Router();
  const service = () => server.stockTradingService || null;

  router.get('/stocks/status', (req, res) => {
    const stocks = service();
    if (!stocks) return res.json({ enabled: false, provider: 'tossinvest' });
    return res.json(stocks.getStatus());
  });

  router.post('/stocks/:mode/start', async (req, res) => {
    const stocks = service();
    if (!stocks) return res.status(404).json({ success: false, error: '주식 자동매매가 비활성화되어 있습니다 (STOCK_TRADING_ENABLED).' });
    try {
      const status = await stocks.startTrader(req.params.mode);
      return res.json({ success: true, status });
    } catch (error) {
      return res.status(error.status || 400).json({ success: false, error: error.message });
    }
  });

  router.post('/stocks/:mode/stop', (req, res) => {
    const stocks = service();
    if (!stocks) return res.status(404).json({ success: false, error: '주식 자동매매가 비활성화되어 있습니다.' });
    try {
      return res.json({ success: true, status: stocks.stopTrader(req.params.mode) });
    } catch (error) {
      return res.status(error.status || 400).json({ success: false, error: error.message });
    }
  });

  router.post('/stocks/paper/reset', (req, res) => {
    const stocks = service();
    if (!stocks) return res.status(404).json({ success: false, error: '주식 자동매매가 비활성화되어 있습니다.' });
    try {
      const seedMoney = Number(req.body?.seedMoney);
      if (req.body?.seedMoney !== undefined && (!Number.isFinite(seedMoney) || seedMoney < 1000)) {
        return res.status(400).json({ success: false, error: '시드머니는 1,000원 이상이어야 합니다.' });
      }
      return res.json({ success: true, status: stocks.getTrader('paper').resetPaper(req.body?.seedMoney) });
    } catch (error) {
      return res.status(error.status || 409).json({ success: false, error: error.message });
    }
  });

  return router;
}
