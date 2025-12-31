import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * 백테스트/최적화 관련 라우트
 */
export default function createOptimizationRoutes(server) {
  const router = express.Router();

  // 백테스팅 결과 조회
  router.get('/backtest/results', (req, res) => {
    try {
      const resultsFile = path.join(PROJECT_ROOT, 'backtest_results.json');

      if (fs.existsSync(resultsFile)) {
        const results = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
        res.json(results);
      } else {
        res.json({ message: 'No backtest results found' });
      }
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // 코인별 백테스트 결과 조회
  router.get('/backtest/results/:coin', (req, res) => {
    try {
      const coin = req.params.coin.replace('-', '_');
      const resultsFile = path.join(PROJECT_ROOT, `backtest_results_${coin}.json`);

      if (fs.existsSync(resultsFile)) {
        const results = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
        res.json(results);
      } else {
        res.json({ exists: false, message: `No backtest results for ${req.params.coin}` });
      }
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // 최적 파라미터 조회
  router.get('/optimal-config', (req, res) => {
    try {
      const configFile = path.join(PROJECT_ROOT, 'optimal_config.json');

      if (fs.existsSync(configFile)) {
        const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        res.json(config);
      } else {
        res.json({ message: 'No optimal config found' });
      }
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // 최적화 이력 조회
  router.get('/optimization-history', (req, res) => {
    try {
      const historyFile = path.join(PROJECT_ROOT, 'optimization_history.json');

      if (fs.existsSync(historyFile)) {
        const history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
        const recentHistory = Array.isArray(history) ? history.slice(-20).reverse() : [];
        res.json(recentHistory);
      } else {
        res.json([]);
      }
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // 자동 최적화 설정 조회
  router.get('/optimization/settings', (req, res) => {
    try {
      res.json(server.optimizationState);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // 자동 최적화 토글
  router.post('/optimization/toggle', express.json(), (req, res) => {
    try {
      const { enabled } = req.body;
      server.optimizationState.enabled = enabled;

      if (enabled) {
        server.startOptimizationScheduler();
      } else {
        server.stopOptimizationScheduler();
      }

      server.saveOptimizationState();
      res.json({ success: true, ...server.optimizationState });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // 최적화 주기 변경
  router.post('/optimization/interval', express.json(), (req, res) => {
    try {
      const { interval } = req.body;
      server.optimizationState.interval = parseInt(interval);

      if (server.optimizationState.enabled) {
        server.stopOptimizationScheduler();
        server.startOptimizationScheduler();
      }

      server.saveOptimizationState();
      res.json({ success: true, ...server.optimizationState });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // 즉시 최적화 실행
  router.post('/optimization/run-now', async (req, res) => {
    try {
      if (server.optimizationState.isRunning) {
        return res.status(400).json({ error: '이미 최적화가 실행 중입니다.' });
      }

      server.runOptimizationCycle();
      res.json({ success: true, message: '최적화가 시작되었습니다.' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
