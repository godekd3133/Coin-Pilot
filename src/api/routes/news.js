import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * 뉴스/로그 관련 라우트
 */
export default function createNewsRoutes(server) {
  const router = express.Router();

  // 뉴스 조회 (누적된 전체 뉴스)
  router.get('/news', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 100;
      const source = req.query.source || null;

      // 새 뉴스 스크랩 시도 (newsMonitor가 있으면)
      if (server.tradingSystem.newsMonitor) {
        try {
          const freshNews = await server.tradingSystem.newsMonitor.fetchAllNews?.() || [];
          server.accumulateNews(freshNews, 'general');
        } catch (e) {
          console.warn('[News] 새 뉴스 스크랩 실패:', e.message);
        }
      }

      // 기존 newsData도 누적
      const newsData = server.tradingSystem.newsData || [];
      server.accumulateNews(newsData, 'system');

      // 누적된 뉴스 반환
      const accumulated = server.getAccumulatedNews({ limit, source });
      const sentiment = server.tradingSystem.newsMonitor?.analyzeMarketSentiment(accumulated.news);

      res.json({
        news: accumulated.news,
        sentiment,
        total: accumulated.total,
        totalAccumulated: accumulated.totalAccumulated,
        accumulatorStartTime: accumulated.accumulatorStartTime
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // 코인별 뉴스 조회 (누적 포함)
  router.get('/news/:coin', async (req, res) => {
    try {
      const coin = req.params.coin.toUpperCase();
      const market = coin.startsWith('KRW-') ? coin : `KRW-${coin}`;
      const limit = parseInt(req.query.limit) || 50;

      if (!server.tradingSystem.newsMonitor) {
        // newsMonitor 없어도 누적된 뉴스에서 필터링
        const accumulated = server.getAccumulatedNews({ limit, coin: market });
        return res.json({
          coin: market,
          news: accumulated.news,
          sentiment: { overall: 'neutral', score: 0 },
          total: accumulated.total,
          totalAccumulated: accumulated.totalAccumulated
        });
      }

      // 새 뉴스 스크랩 및 누적
      const coinNews = await server.tradingSystem.newsMonitor.fetchCoinSpecificNews(market);
      server.accumulateNews(coinNews, `coin:${market}`);

      // 누적된 뉴스에서 해당 코인 필터링
      const accumulated = server.getAccumulatedNews({ limit, coin: market });
      const sentiment = await server.tradingSystem.newsMonitor.getCoinSentiment(market);

      res.json({
        coin: market,
        news: accumulated.news,
        sentiment,
        total: accumulated.total,
        totalAccumulated: accumulated.totalAccumulated,
        sources: {
          twitter: accumulated.news.filter(n => n.isTwitter).length,
          googleNews: accumulated.news.filter(n => n.source?.includes('Google')).length,
          other: accumulated.news.filter(n => !n.isTwitter && !n.source?.includes('Google')).length
        }
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // 누적 뉴스 통계
  router.get('/news-stats', (req, res) => {
    try {
      const accumulated = server.getAccumulatedNews({ limit: 1000 });

      // 소스별 통계
      const sourceStats = {};
      for (const news of server.accumulatedNews) {
        const src = news.source || 'unknown';
        sourceStats[src] = (sourceStats[src] || 0) + 1;
      }

      res.json({
        totalAccumulated: accumulated.totalAccumulated,
        accumulatorStartTime: accumulated.accumulatorStartTime,
        uptimeMinutes: Math.floor((Date.now() - new Date(accumulated.accumulatorStartTime).getTime()) / 60000),
        sourceStats,
        oldestNews: server.accumulatedNews[server.accumulatedNews.length - 1]?.timestamp,
        newestNews: server.accumulatedNews[0]?.timestamp
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // 로그 조회
  router.get('/logs', (req, res) => {
    try {
      const type = req.query.type || 'trading';
      const lines = parseInt(req.query.lines) || 100;

      const logDir = path.join(PROJECT_ROOT, 'logs');
      const today = new Date().toISOString().split('T')[0];

      let logFile;
      if (type === 'error') {
        logFile = path.join(logDir, `error-${today}.log`);
      } else if (type === 'trades') {
        logFile = path.join(logDir, 'trades.log');
      } else {
        logFile = path.join(logDir, `trading-${today}.log`);
      }

      if (fs.existsSync(logFile)) {
        const content = fs.readFileSync(logFile, 'utf8');
        const logLines = content.split('\n').filter(line => line.trim());
        const recentLogs = logLines.slice(-lines);

        res.json({
          logs: recentLogs,
          total: logLines.length
        });
      } else {
        res.json({
          logs: [],
          total: 0,
          message: 'Log file not found'
        });
      }
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
