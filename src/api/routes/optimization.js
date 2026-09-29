import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPaperEvidenceMutationLock, respondIfPaperEvidenceMutationBlocked } from '../../research/paperEvidenceMutationGuard.js';

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
        res.json({ message: '과거 거래 비교 기록이 없습니다.' });
      }
    } catch {
      res.status(500).json({ error: '과거 거래 비교 기록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' });
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
        res.json({ exists: false, message: `${req.params.coin} 과거 거래 비교 기록이 없습니다.` });
      }
    } catch {
      res.status(500).json({ error: '과거 거래 비교 기록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' });
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
        res.json({ message: '저장된 비교 설정이 없습니다.' });
      }
    } catch {
      res.status(500).json({ error: '저장된 비교 설정을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' });
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
    } catch {
      res.status(500).json({ error: '설정 비교 기록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' });
    }
  });

  // 자동 최적화 설정 조회
  router.get('/optimization/settings', (req, res) => {
    try {
      res.json({
        ...server.optimizationState,
        evidenceMutationLock: getPaperEvidenceMutationLock(server.tradingSystem, 'optimization')
      });
    } catch {
      res.status(500).json({ error: '자동 후보 비교 설정을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' });
    }
  });

  // 자동 최적화 토글
  router.post('/optimization/toggle', express.json(), (req, res) => {
    if (respondIfPaperEvidenceMutationBlocked(server.tradingSystem, res, 'optimization_toggle')) return;
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
    } catch {
      res.status(500).json({ error: '자동 후보 비교 설정을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.' });
    }
  });

  // 최적화 주기 변경
  router.post('/optimization/interval', express.json(), (req, res) => {
    if (respondIfPaperEvidenceMutationBlocked(server.tradingSystem, res, 'optimization_interval')) return;
    try {
      const { interval } = req.body;
      server.optimizationState.interval = parseInt(interval);

      if (server.optimizationState.enabled) {
        server.stopOptimizationScheduler();
        server.startOptimizationScheduler();
      }

      server.saveOptimizationState();
      res.json({ success: true, ...server.optimizationState });
    } catch {
      res.status(500).json({ error: '비교 간격을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.' });
    }
  });

  // 즉시 최적화 실행
  router.post('/optimization/run-now', async (req, res) => {
    if (respondIfPaperEvidenceMutationBlocked(server.tradingSystem, res, 'optimization_run_now')) return;
    try {
      if (server.optimizationState.isRunning) {
        return res.status(400).json({ error: '설정 비교를 이미 진행 중입니다.' });
      }

      server.runOptimizationCycle();
      res.json({ success: true, message: '설정 후보 비교를 시작했습니다.' });
    } catch {
      res.status(500).json({ error: '설정 후보 비교를 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.' });
    }
  });

  return router;
}
