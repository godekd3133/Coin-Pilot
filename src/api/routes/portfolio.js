import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { accountValuationMarkets, readCurrentMarketPrices } from '../marketValuation.js';
import { createManualOrderIdempotencyMiddleware } from '../manualOrderIdempotencyMiddleware.js';
import PortfolioHistoryStore, { PortfolioHistoryFormatError } from '../portfolioHistoryStore.js';
import PortfolioSnapshotService from '../portfolioSnapshotService.js';
import { projectPaperValidationMobileSummary } from '../paperValidationMobileSummary.js';
import { summarizePaperStrictTradeCostAudit } from '../../research/paperStrictTradeCostAudit.js';
import { summarizePaperForwardCohort } from '../../research/paperForwardCohort.js';
import { respondIfPaperEvidenceMutationBlocked } from '../../research/paperEvidenceMutationGuard.js';
import { API_READ_QUERY_LIMITS, parseBoundedIntegerQuery } from '../queryLimits.js';
import { quoteOfSystem } from '../../exchange/marketCodes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

async function getObserverAccountInfo(server) {
  if (typeof server.getObserverCachedAccountInfo === 'function') {
    return server.getObserverCachedAccountInfo();
  }
  // Preserve direct reads for legacy route adapters that predate DashboardServer's cache.
  return server.tradingSystem.getAccountInfo();
}

/**
 * 포트폴리오/거래이력/가상자금 관련 라우트
 */
export default function createPortfolioRoutes(server) {
  const router = express.Router();
  router.use(createManualOrderIdempotencyMiddleware(server, {
    paths: new Set(['/virtual/deposit', '/virtual/withdraw', '/virtual/reset'])
  }));
  const createPortfolioHistoryStore = () => new PortfolioHistoryStore({
    filePath: server.tradingSystem.portfolioHistoryFile ||
      path.join(PROJECT_ROOT, 'portfolio_history.json')
  });
  const portfolioSnapshotService = new PortfolioSnapshotService({
    server,
    historyStoreFactory: createPortfolioHistoryStore
  });
  const paperForwardCohortCache = { summary: null, capturedAtMs: 0 };
  const paperForwardCohortCacheMs = 60_000;

  function readMobilePaperForwardCohort() {
    const now = Date.now();
    if (!paperForwardCohortCache.summary || now - paperForwardCohortCache.capturedAtMs >= paperForwardCohortCacheMs) {
      try {
        paperForwardCohortCache.summary = summarizePaperForwardCohort({ rootDir: PROJECT_ROOT });
        paperForwardCohortCache.capturedAtMs = Date.now();
      } catch {
        if (!paperForwardCohortCache.summary) return null;
      }
    }
    return {
      summary: paperForwardCohortCache.summary,
      capturedAt: paperForwardCohortCache.capturedAtMs > 0
        ? new Date(paperForwardCohortCache.capturedAtMs).toISOString()
        : null,
      fresh: Date.now() - paperForwardCohortCache.capturedAtMs < paperForwardCohortCacheMs
    };
  }

  // 거래 이력 조회
  router.get('/trades', (req, res) => {
    try {
      const limit = parseBoundedIntegerQuery(req.query.limit, API_READ_QUERY_LIMITS.trades);
      let allTrades = [];

      // 1. 전략 기반 거래 이력 (자동매매)
      if (server.tradingSystem.strategies) {
        for (const [coin, strategy] of server.tradingSystem.strategies.entries()) {
          const trades = strategy.getTradeHistory(limit).map(trade => ({
            coin,
            ...trade,
            source: 'strategy'
          }));
          allTrades.push(...trades);
        }
      } else if (server.tradingSystem.strategy) {
        allTrades = server.tradingSystem.strategy.getTradeHistory(limit).map(trade => ({
          coin: server.tradingSystem.config.targetCoin,
          ...trade,
          source: 'strategy'
        }));
      }

      // 2. 스마트 거래 이력
      if (server.tradingSystem.smartTradeHistory) {
        allTrades.push(...server.tradingSystem.smartTradeHistory);
      }

      // 시간순 정렬 (최신 먼저)
      allTrades.sort((a, b) => {
        const timeA = new Date(a.timestamp || a.entryTime || a.exitTime || 0);
        const timeB = new Date(b.timestamp || b.entryTime || b.exitTime || 0);
        return timeB - timeA;
      });

      res.json(allTrades.slice(0, limit));
    } catch {
      res.status(500).json({ error: '거래 내역을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' });
    }
  });

  // 누적 손익 조회
  router.get('/cumulative-pnl', async (req, res) => {
    try {
      if (typeof server.tradingSystem.calculateCumulativePnL === 'function') {
        const accounts = await getObserverAccountInfo(server);
        const marketSnapshot = await readCurrentMarketPrices(
          server,
          accountValuationMarkets(server.tradingSystem, accounts)
        );
        const pnl = await server.tradingSystem.calculateCumulativePnL({
          allowAveragePriceFallback: false,
          priceMapOverride: marketSnapshot.freshPriceMap,
          accountsOverride: accounts
        });
        const valuationAvailable = marketSnapshot.allQuotesFresh === true &&
          pnl.valuationAvailable !== false && pnl.totalAssets !== null &&
          pnl.totalAssets !== undefined && Number.isFinite(Number(pnl.totalAssets));
        res.json({
          ...pnl,
          totalAssets: valuationAvailable ? pnl.totalAssets : null,
          profit: valuationAvailable ? pnl.profit : null,
          profitPercent: valuationAvailable ? pnl.profitPercent : null,
          valuationAvailable,
          valuationStatus: valuationAvailable
            ? 'available'
            : marketSnapshot.staleMarkets?.length > 0 ? 'stale' : 'unavailable',
          valuationAsOf: marketSnapshot.asOf,
          sourceAsOf: marketSnapshot.sourceAsOf,
          fetchedAt: marketSnapshot.fetchedAt,
          staleMarkets: marketSnapshot.staleMarkets || [],
          unavailableMarkets: marketSnapshot.unavailableMarkets || [],
          sourceSkewMs: marketSnapshot.sourceSkewMs ?? null,
          captureSkewMs: marketSnapshot.captureSkewMs ?? null,
          snapshotSource: marketSnapshot.snapshotSource ?? 'upstream',
          fallbackReason: marketSnapshot.fallbackReason ?? null
        });
      } else {
        const accounts = await getObserverAccountInfo(server);
        let totalAssets = server.tradingSystem.dryRun
          ? Number(server.tradingSystem.virtualPortfolio?.krwBalance || 0)
          : Number(server.tradingSystem.getKRWBalance(accounts) || 0);

        let holdings = new Map();
        if (server.tradingSystem.dryRun) {
          holdings = server.getHoldingsAsMap();
        } else {
          for (const acc of accounts) {
            const amount = parseFloat(acc.balance || 0) + parseFloat(acc.locked || 0);
            if (acc.currency !== 'KRW' && Number.isFinite(amount) && amount > 0) {
              holdings.set(`${quoteOfSystem(server.tradingSystem)}-${acc.currency}`, {
                amount,
                avgPrice: parseFloat(acc.avg_buy_price) || 0
              });
            }
          }
        }

        const positionCoins = Array.from(holdings.keys());
        const marketSnapshot = await readCurrentMarketPrices(server, positionCoins);
        let valuationAvailable = true;
        for (const [market, holding] of holdings.entries()) {
          const price = marketSnapshot.freshPriceMap.get(market);
          if (!Number.isFinite(price) || price <= 0) {
            valuationAvailable = false;
            break;
          }
          totalAssets += price * holding.amount;
        }

        const initialSeedMoney = server.tradingSystem.initialSeedMoney || 10000000;
        const profit = valuationAvailable ? totalAssets - initialSeedMoney : null;
        const profitPercent = valuationAvailable && initialSeedMoney > 0
          ? ((totalAssets / initialSeedMoney) - 1) * 100
          : valuationAvailable ? 0 : null;

        res.json({
          initialSeedMoney,
          totalAssets: valuationAvailable ? Math.round(totalAssets) : null,
          profit: profit === null ? null : Math.round(profit),
          profitPercent,
          valuationAvailable,
          valuationStatus: valuationAvailable ? 'available' : 'unavailable',
          valuationAsOf: marketSnapshot.asOf,
          sourceAsOf: marketSnapshot.sourceAsOf,
          fetchedAt: marketSnapshot.fetchedAt,
          staleMarkets: marketSnapshot.staleMarkets || [],
          unavailableMarkets: marketSnapshot.unavailableMarkets || [],
          sourceSkewMs: marketSnapshot.sourceSkewMs ?? null,
          captureSkewMs: marketSnapshot.captureSkewMs ?? null,
          snapshotSource: marketSnapshot.snapshotSource ?? 'upstream',
          fallbackReason: marketSnapshot.fallbackReason ?? null,
          mode: server.tradingSystem.dryRun ? 'DRY_RUN' : 'LIVE'
        });
      }
    } catch {
      res.status(500).json({ error: '누적 손익 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' });
    }
  });

  // 독립 forward paper validation ledger
  router.get('/paper-validation', async (req, res) => {
    try {
      if (typeof server.tradingSystem.getPaperValidationStatus !== 'function') {
        return res.json({ available: false, active: false, eligible: false, reason: 'unsupported' });
      }
      return res.json(await server.tradingSystem.getPaperValidationStatus());
    } catch {
      return res.status(500).json({ available: false, active: false, eligible: false, error: '모의투자 상태를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' });
    }
  });

  // 단말 조회용 모의투자 요약. 전체 ledger와 전략 설정은 전달하지 않습니다.
  router.get('/paper-validation/summary', async (req, res) => {
    try {
      const trader = server.tradingSystem;
      if (typeof trader.getPaperValidationStatus !== 'function') {
        return res.json(projectPaperValidationMobileSummary({ available: false }));
      }

      // The mobile summary must not cause a new ticker request during a routine UI refresh.
      const status = await trader.getPaperValidationStatus({ includeCurrentAssets: false });
      let ledger = trader.paperValidation || null;
      if (trader.readOnlyObserver === true && typeof trader.readPaperValidationLedger === 'function') {
        try {
          ledger = trader.readPaperValidationLedger();
        } catch {
          ledger = null;
        }
      }
      const costAudit = status?.strictExecutionCostAudit ||
        summarizePaperStrictTradeCostAudit(ledger);
      return res.json(projectPaperValidationMobileSummary(
        status,
        costAudit,
        readMobilePaperForwardCohort()
      ));
    } catch {
      return res.status(500).json(projectPaperValidationMobileSummary({ available: false }));
    }
  });

  router.post('/paper-validation/start', async (req, res) => {
    try {
      if (typeof server.tradingSystem.startPaperValidationSession !== 'function') {
        return res.status(400).json({ success: false, error: '이 서버에서는 모의투자를 시작할 수 없습니다.' });
      }
      const status = await server.tradingSystem.startPaperValidationSession(req.body || {});
      return res.json({ success: true, status });
    } catch (error) {
      const errorMessage = String(error?.message || '');
      const knownUserMessage = errorMessage.startsWith('실거래 모드에서는 모의투자 세션') ||
        errorMessage.startsWith('이전 모의투자 기록을 이어서 사용할 수 없습니다.');
      return res.status(400).json({
        success: false,
        error: knownUserMessage ? errorMessage : '모의투자를 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.'
      });
    }
  });

  router.post('/paper-validation/stop', async (req, res) => {
    try {
      if (typeof server.tradingSystem.stopPaperValidationSession !== 'function') {
        return res.status(400).json({ success: false, error: '이 서버에서는 모의투자를 중지할 수 없습니다.' });
      }
      const status = await server.tradingSystem.stopPaperValidationSession();
      return res.json({ success: true, status });
    } catch {
      return res.status(400).json({ success: false, error: '모의투자를 중지하지 못했습니다. 잠시 후 다시 시도해 주세요.' });
    }
  });

  // 자산 추이 저장 (자동 호출)
  router.post('/portfolio/snapshot', async (req, res) => {
    try {
      const tradingSystem = server.tradingSystem;

      if (tradingSystem.readOnlyObserver === true) {
        if (typeof tradingSystem.readPaperValidationLedger !== 'function') {
          return res.status(503).json({ success: false, readOnlyObserver: true, error: '모의투자 기록을 불러올 수 없습니다.' });
        }
        const ledger = tradingSystem.readPaperValidationLedger();
        const snapshots = Array.isArray(ledger.snapshots) ? ledger.snapshots : [];
        return res.json({
          success: true,
          readOnlyObserver: true,
          recorded: false,
          message: '이 계좌는 기록 조회 전용입니다. 새 자산 기록은 저장하지 않습니다.',
          dataPoints: snapshots.length
        });
      }

      const result = await portfolioSnapshotService.recordSnapshot();
      return res.status(result.status).json(result.body);
    } catch (error) {
      server.logApiError('/api/portfolio/snapshot', error);
      return res.status(500).json({
        success: false,
        recorded: false,
        error: '자산 기록을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.'
      });
    }
  });

  // 자산 추이 조회
  router.get('/portfolio/history', (req, res) => {
    try {
      const period = req.query.period || '24h';
      let history;
      if (server.tradingSystem.readOnlyObserver === true) {
        if (typeof server.tradingSystem.readPaperValidationLedger !== 'function') {
          return res.status(503).json({ data: [], period, count: 0, readOnlyObserver: true, error: '자산 기록을 불러올 수 없습니다.' });
        }
        const ledger = server.tradingSystem.readPaperValidationLedger();
        history = (Array.isArray(ledger.snapshots) ? ledger.snapshots : [])
          .map(snapshot => ({
            timestamp: snapshot.timestamp,
            totalAssets: snapshot.totalAssets,
            ...(snapshot.capturedAt ? { capturedAt: snapshot.capturedAt } : {}),
            ...(snapshot.valuationAsOf ? { valuationAsOf: snapshot.valuationAsOf } : {}),
            ...(snapshot.sourceAsOf ? { sourceAsOf: snapshot.sourceAsOf } : {}),
            ...(snapshot.fetchedAt ? { fetchedAt: snapshot.fetchedAt } : {})
          }))
          .filter(snapshot => snapshot.timestamp && Number.isFinite(Number(snapshot.totalAssets)));
      } else {
        return res.json(createPortfolioHistoryStore().readPeriod(period));
      }

      const now = Date.now();
      let cutoff;
      switch (period) {
        case '10s': cutoff = now - 10 * 1000; break;
        case '30s': cutoff = now - 30 * 1000; break;
        case '1m': cutoff = now - 60 * 1000; break;
        case '5m': cutoff = now - 5 * 60 * 1000; break;
        case '15m': cutoff = now - 15 * 60 * 1000; break;
        case '30m': cutoff = now - 30 * 60 * 1000; break;
        case '1h': cutoff = now - 60 * 60 * 1000; break;
        case '24h': cutoff = now - 24 * 60 * 60 * 1000; break;
        case '7d': cutoff = now - 7 * 24 * 60 * 60 * 1000; break;
        case '30d': cutoff = now - 30 * 24 * 60 * 60 * 1000; break;
        default: cutoff = now - 24 * 60 * 60 * 1000;
      }

      history = history.filter(h => h && typeof h === 'object' && new Date(h.timestamp).getTime() > cutoff);

      const maxPoints = 100;
      if (history.length > maxPoints) {
        const step = Math.ceil(history.length / maxPoints);
        history = history.filter((_, idx) => idx % step === 0);
      }

      res.json({
        data: history,
        period,
        count: history.length,
        ...(server.tradingSystem.readOnlyObserver === true ? { readOnlyObserver: true } : {})
      });
    } catch (error) {
      if (error instanceof PortfolioHistoryFormatError) {
        return res.status(500).json({
          data: [],
          period: req.query.period || '24h',
          count: 0,
          error: '자산 기록 형식이 올바르지 않습니다.'
        });
      }
      res.status(500).json({ data: [], error: '자산 기록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' });
    }
  });

  // 모의투자 입금 (드라이 모드 전용)
  router.post('/virtual/deposit', (req, res) => {
    if (respondIfPaperEvidenceMutationBlocked(server.tradingSystem, res, 'virtual_deposit')) return;
    try {
      if (!server.tradingSystem.dryRun) {
        return res.status(400).json({ error: '실거래 모드에서는 모의투자 잔액을 바꿀 수 없습니다.', success: false });
      }

      const { amount } = req.body;
      const depositAmount = parseInt(amount);

      if (!depositAmount || depositAmount < 1000) {
        return res.status(400).json({ error: '최소 입금액은 1,000원입니다', success: false });
      }

      if (depositAmount > 100000000) {
        return res.status(400).json({ error: '최대 입금액은 1억원입니다', success: false });
      }

      server.tradingSystem.adjustVirtualWalletBalance(depositAmount);

      const seedMessage = server.tradingSystem.initialSeedMoney !== undefined
        ? ` 수익률 기준 금액은 ${server.tradingSystem.initialSeedMoney.toLocaleString()}원입니다.`
        : '';
      res.json({
        success: true,
        message: `모의투자 잔액에 ${depositAmount.toLocaleString()}원을 추가했습니다.${seedMessage}`,
        newBalance: server.tradingSystem.virtualPortfolio.krwBalance,
        newSeedMoney: server.tradingSystem.initialSeedMoney
      });
    } catch {
      res.status(500).json({ error: '모의투자 잔액을 변경하지 못했습니다. 잠시 후 다시 시도해 주세요.', success: false });
    }
  });

  // 모의투자 출금 (드라이 모드 전용)
  router.post('/virtual/withdraw', (req, res) => {
    if (respondIfPaperEvidenceMutationBlocked(server.tradingSystem, res, 'virtual_withdraw')) return;
    try {
      if (!server.tradingSystem.dryRun) {
        return res.status(400).json({ error: '실거래 모드에서는 모의투자 잔액을 바꿀 수 없습니다.', success: false });
      }

      const { amount } = req.body;
      const withdrawAmount = parseInt(amount);

      if (!withdrawAmount || withdrawAmount < 1000) {
        return res.status(400).json({ error: '최소 출금액은 1,000원입니다', success: false });
      }

      const currentBalance = server.tradingSystem.virtualPortfolio.krwBalance;
      if (withdrawAmount > currentBalance) {
        return res.status(400).json({
          error: `출금 가능 금액이 부족합니다 (잔액: ${currentBalance.toLocaleString()}원)`,
          success: false
        });
      }

      server.tradingSystem.adjustVirtualWalletBalance(-withdrawAmount);

      const seedMessage = server.tradingSystem.initialSeedMoney !== undefined
        ? ` 수익률 기준 금액은 ${server.tradingSystem.initialSeedMoney.toLocaleString()}원입니다.`
        : '';
      res.json({
        success: true,
        message: `모의투자 잔액에서 ${withdrawAmount.toLocaleString()}원을 출금했습니다.${seedMessage}`,
        newBalance: server.tradingSystem.virtualPortfolio.krwBalance,
        newSeedMoney: server.tradingSystem.initialSeedMoney
      });
    } catch {
      res.status(500).json({ error: '모의투자 잔액을 변경하지 못했습니다. 잠시 후 다시 시도해 주세요.', success: false });
    }
  });

  // 모의투자 시드머니 리셋 (드라이 모드 전용)
  router.post('/virtual/reset', (req, res) => {
    if (respondIfPaperEvidenceMutationBlocked(server.tradingSystem, res, 'virtual_reset')) return;
    try {
      if (!server.tradingSystem.dryRun) {
        return res.status(400).json({ error: '실거래 모드에서는 모의투자를 초기화할 수 없습니다.', success: false });
      }

      const { seedMoney } = req.body;
      const newSeedMoney = parseInt(seedMoney) || 10000000;

      if (typeof server.tradingSystem.resetVirtualPortfolio !== 'function' ||
          server.tradingSystem.resetVirtualPortfolio(newSeedMoney) !== true) {
        throw new Error('가상 계좌 초기화를 완료하지 못했습니다.');
      }

      res.json({
        success: true,
        message: `모의투자 잔액과 수익률 계산 시작 금액을 ${newSeedMoney.toLocaleString()}원으로 초기화했습니다.`,
        newBalance: newSeedMoney,
        initialSeedMoney: newSeedMoney
      });
    } catch {
      res.status(500).json({ error: '모의투자 계좌를 초기화하지 못했습니다. 잠시 후 다시 시도해 주세요.', success: false });
    }
  });

  return router;
}
