import express from 'express';
import fs from 'fs';
import path from 'node:path';
import { assessScalpingValidationReportFreshness } from '../../research/scalpingValidationFreshness.js';
import { getStrategyReadiness } from '../../research/strategyReadiness.js';
import { createManualOrderIdempotencyMiddleware } from '../manualOrderIdempotencyMiddleware.js';
import { getMarketDataProvider } from '../marketDataProvider.js';
import { envString } from '../../config/envConfig.js';
import { createManualOrderService } from '../manualOrderService.js';
import { createMarketAnalysisQueries } from '../marketAnalysisQueries.js';
import {
  attachLiveLegIntent,
  LIVE_MULTI_LEG_PATHS,
  recoverManualLiveOrderRequest
} from '../manualOrderExecution.js';

function respondWithResult(res, result) {
  return res.status(result.status).json(result.body);
}

/**
 * 거래 관련 라우트 (분석, 매수/매도, 스마트 트레이딩, 번들)
 *
 * 주문 실행 규칙(시세 신선도 게이트, DRY/LIVE 체결, 전략 포지션 반영)은
 * manualOrderService가, 분석 read-model은 marketAnalysisQueries가 소유한다.
 * 이 파일은 요청 검증과 HTTP 응답 매핑만 담당한다.
 */
export default function createTradingRoutes(server) {
  const router = express.Router();
  const marketDataProvider = getMarketDataProvider(server);
  const orderService = createManualOrderService({
    tradingSystem: server.tradingSystem,
    marketDataProvider
  });
  const analysisQueries = createMarketAnalysisQueries({
    tradingSystem: server.tradingSystem,
    marketDataProvider
  });

  router.use(createManualOrderIdempotencyMiddleware(server, {
    paths: new Set([
      '/trade/execute-bundle',
      '/trade/execute',
      '/trade/smart-buy',
      '/trade/smart-sell',
      '/trade/quick',
      '/trade/buy',
      '/trade/sell'
    ]),
    liveReconciliationPaths: new Set([
      '/trade/buy',
      '/trade/sell',
      '/trade/execute',
      '/trade/quick'
    ]),
    liveMultiLegPaths: LIVE_MULTI_LEG_PATHS,
    recoverLiveRequest: recoverManualLiveOrderRequest
  }));

  // 마지막 읽기 전용 스캘핑 워크포워드 검증 결과
  router.get('/scalping-validation', (req, res) => {
    const configuredReportFile = server?.tradingSystem?.config?.scalpingValidationOutputFile ||
      envString('SCALP_VALIDATION_OUTPUT_FILE') ||
      'scalping_validation.json';
    const reportFile = path.isAbsolute(configuredReportFile)
      ? configuredReportFile
      : path.resolve(process.cwd(), configuredReportFile);
    if (!fs.existsSync(reportFile)) {
      return res.json({ available: false, promoted: false, results: [] });
    }

    try {
      const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
      return res.json({
        available: true,
        ...report,
        reportFreshness: assessScalpingValidationReportFreshness(report.generatedAt)
      });
    } catch (error) {
      return res.status(500).json({ available: false, promoted: false, error: error.message });
    }
  });

  // 현재 설정된 validation report와 runtime live gate를 읽기 전용으로 판정한다.
  router.get('/strategy-readiness', (req, res) => {
    res.json(getStrategyReadiness(server?.tradingSystem));
  });

  router.get('/coin-analysis', async (req, res) => {
    try {
      return respondWithResult(res, await analysisQueries.coinAnalysis());
    } catch (error) {
      server.logApiError('/api/coin-analysis', error);
      res.status(500).json({ error: error.message });
    }
  });

  // 전체 코인 AI 평가 점수 조회 (Analysis 탭용)
  router.get('/all-coin-scores', async (req, res) => {
    try {
      return respondWithResult(res, await analysisQueries.allCoinScores({ limit: req.query.limit }));
    } catch (error) {
      server.logApiError('/api/all-coin-scores', error);
      res.status(500).json({ error: error.message });
    }
  });

  // 번들 제안 조회 (A코인 매도 → B코인 매수 묶음)
  router.get('/bundle-suggestions', async (req, res) => {
    try {
      const bundles = await server.generateBundleSuggestions();

      res.json({
        bundles,
        count: bundles.length,
        note: '보유 코인 중 매도 신호가 있는 코인과, 매수 신호가 있는 코인을 묶어서 리밸런싱 제안을 합니다.',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      server.logApiError('/api/bundle-suggestions', error);
      res.status(500).json({ error: error.message });
    }
  });

  // 번들 제안 실행 (매도 후 매수)
  router.post('/trade/execute-bundle', express.json(), async (req, res) => {
    try {
      return respondWithResult(res, await orderService.executeBundle(req.body || {}, {
        attachLegIntent: leg => attachLiveLegIntent(server.manualOrderIdempotencyStore, req, leg)
      }));
    } catch (error) {
      server.logApiError('/api/trade/execute-bundle', error);
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // 수동 매매 실행
  router.post('/trade/execute', express.json(), async (req, res) => {
    try {
      const { coin, action, amount } = req.body || {};
      return respondWithResult(res, await orderService.execute({
        coin,
        action,
        amount,
        clientIntentId: req.manualOrderClientIntentId
      }));
    } catch (error) {
      server.logApiError('/api/trade/execute', error, { coin: req.body?.coin, action: req.body?.action });
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // 스마트 자동 매수
  router.post('/trade/smart-buy', express.json(), async (req, res) => {
    try {
      return respondWithResult(res, await orderService.smartBuy(req.body || {}, {
        attachLegIntent: leg => attachLiveLegIntent(server.manualOrderIdempotencyStore, req, leg)
      }));
    } catch (error) {
      server.logApiError('/api/trade/smart-buy', error, { totalAmount: req.body?.totalAmount });
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // 스마트 자동 매도 (목표 금액만큼 분할 매도)
  router.post('/trade/smart-sell', express.json(), async (req, res) => {
    try {
      return respondWithResult(res, await orderService.smartSell(req.body || {}, {
        attachLegIntent: leg => attachLiveLegIntent(server.manualOrderIdempotencyStore, req, leg)
      }));
    } catch (error) {
      server.logApiError('/api/trade/smart-sell', error, { targetAmount: req.body?.targetAmount });
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // 즉시 단일 코인 매수/매도
  router.post('/trade/quick', express.json(), async (req, res) => {
    try {
      const { coin, action, amount } = req.body || {};
      return respondWithResult(res, await orderService.quick({
        coin,
        action,
        amount,
        clientIntentId: req.manualOrderClientIntentId
      }));
    } catch (error) {
      server.logApiError('/api/trade/quick', error, { coin: req.body?.coin, action: req.body?.action });
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // 개별 코인 수동 매수
  router.post('/trade/buy', express.json(), async (req, res) => {
    try {
      const { coin, amount } = req.body || {};
      return respondWithResult(res, await orderService.buy({
        coin,
        amount,
        clientIntentId: req.manualOrderClientIntentId
      }));
    } catch (error) {
      server.logApiError('/api/trade/buy', error, { coin: req.body?.coin, amount: req.body?.amount });
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // 개별 코인 수동 매도 (수량 지정)
  router.post('/trade/sell', express.json(), async (req, res) => {
    try {
      const { coin, quantity } = req.body || {};
      return respondWithResult(res, await orderService.sell({
        coin,
        quantity,
        clientIntentId: req.manualOrderClientIntentId
      }));
    } catch (error) {
      server.logApiError('/api/trade/sell', error, { coin: req.body?.coin, quantity: req.body?.quantity });
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // 매수/매도 추천 (임계값 근접 코인 + 투자금액 제안)
  router.get('/trading-recommendations', async (req, res) => {
    try {
      return respondWithResult(res, await analysisQueries.tradingRecommendations());
    } catch (error) {
      server.logApiError('/api/trading-recommendations', error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
