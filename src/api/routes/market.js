import express from 'express';

// 업비트 전체 KRW 마켓 캐시
let allKrwMarketsCache = null;
let marketsLastFetch = 0;
const MARKETS_CACHE_TTL = 60000; // 1분 캐시

/**
 * 마켓/시세 관련 라우트
 */
export default function createMarketRoutes(server) {
  const router = express.Router();

  // 전체 KRW 마켓 조회 헬퍼
  const getAllKrwMarkets = async () => {
    const now = Date.now();
    if (allKrwMarketsCache && (now - marketsLastFetch) < MARKETS_CACHE_TTL) {
      return allKrwMarketsCache;
    }

    try {
      const markets = await server.tradingSystem.upbit.getMarkets();
      allKrwMarketsCache = markets
        .filter(m => m.market.startsWith('KRW-'))
        .map(m => m.market)
        .sort((a, b) => {
          const priority = ['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL', 'KRW-DOGE'];
          const aIdx = priority.indexOf(a);
          const bIdx = priority.indexOf(b);
          if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
          if (aIdx !== -1) return -1;
          if (bIdx !== -1) return 1;
          return a.localeCompare(b);
        });
      marketsLastFetch = now;
      return allKrwMarketsCache;
    } catch (error) {
      console.error('마켓 조회 오류:', error.message);
      return allKrwMarketsCache || ['KRW-BTC', 'KRW-ETH', 'KRW-XRP'];
    }
  };

  // 타겟 코인 목록 조회
  router.get('/target-coins', async (req, res) => {
    try {
      const coins = await getAllKrwMarkets();
      res.json({
        coins,
        count: coins.length
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // 실시간 시세 조회
  router.get('/market/prices', async (req, res) => {
    try {
      const coins = await getAllKrwMarkets();
      const tickers = await server.getCachedTicker(coins);

      const prices = tickers.map(t => ({
        coin: t.market,
        price: t.trade_price,
        change: t.signed_change_rate * 100,
        changePrice: t.signed_change_price,
        high: t.high_price,
        low: t.low_price,
        volume: t.acc_trade_volume_24h,
        volumeKrw: t.acc_trade_price_24h
      }));

      res.json(prices);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // 캔들 데이터 조회 (차트용)
  router.get('/market/candles/:coin', async (req, res) => {
    try {
      const coin = req.params.coin;
      const unit = parseInt(req.query.unit) || 5;
      const count = parseInt(req.query.count) || 100;

      const candles = await server.tradingSystem.upbit.getMinuteCandles(coin, unit, count);

      const chartData = candles.reverse().map(c => ({
        time: c.candle_date_time_kst,
        open: c.opening_price,
        high: c.high_price,
        low: c.low_price,
        close: c.trade_price,
        volume: c.candle_acc_trade_volume
      }));

      res.json(chartData);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
