import express from 'express';
import path from 'path';
import { projectReadOnlyPaperPortfolioAnalysis } from '../readOnlyPaperPortfolio.js';
import { getMarketDataProvider, MARKET_DATA_FRESHNESS } from '../marketDataProvider.js';
import { readLogTail } from '../../utils/readLogTail.js';
import { parseRecentLogErrors } from '../../utils/parseRecentLogErrors.js';
import { quoteOfSystem } from '../../exchange/marketCodes.js';

// 상태·요약·분석 read-model 라우트 — DashboardServer의 인라인 핸들러에서 추출.
// 서버 소유 상태(tradingSystem, 캐시, logger)는 server 파라미터를 통해 접근한다.
export default function createStatusRoutes(server) {
  const router = express.Router();

  router.get('/system-status', async (req, res) => {
    try {
      const now = new Date();
      const uptime = process.uptime();

      // 마지막 거래 시간 계산
      let lastTradeTime = null;
      if (server.tradingSystem.smartTradeHistory?.length > 0) {
        lastTradeTime = server.tradingSystem.smartTradeHistory[0].timestamp;
      }

      // Keep log reads bounded so a large file cannot block the trading loop.
      const logDir = server.logger.logDir;
      const today = now.toISOString().split('T')[0];
      const errorLogFile = path.join(logDir, `error-${today}.log`);
      let recentErrors = [];

      const errorTail = await readLogTail(errorLogFile, { maxLines: 1000, maxBytes: 512 * 1024 });
      recentErrors = parseRecentLogErrors(errorTail.lines);

      // 다음 분석 예정 시간
      const checkInterval = server.tradingSystem.config?.checkInterval || 60000;
      const nextAnalysis = new Date(now.getTime() + checkInterval);

      // 현재 포지션 수 계산 (여러 소스에서 확인)
      let currentPositions = 0;

      // 1. 전략 기반 포지션 수
      if (server.tradingSystem.getCurrentPositionCount) {
        currentPositions = server.tradingSystem.getCurrentPositionCount();
      }

      // 2. 가상 포트폴리오에서 확인 (드라이 모드)
      if (currentPositions === 0) {
        currentPositions = server.getActiveHoldings().size || 0;
      }

      // 3. strategies에서 직접 확인
      if (currentPositions === 0 && server.tradingSystem.strategies) {
        for (const [, strategy] of server.tradingSystem.strategies.entries()) {
          if (strategy.currentPosition) {
            currentPositions++;
          }
        }
      }

      const runtimeSafety = typeof server.tradingSystem.getRuntimeSafetyStatus === 'function'
        ? server.tradingSystem.getRuntimeSafetyStatus()
        : {};
      res.json({
        isRunning: server.tradingSystem.isRunning,
        mode: server.tradingSystem.dryRun ? 'DRY_RUN' : 'LIVE',
        ...runtimeSafety,
        readOnlyObserver: server.tradingSystem.readOnlyObserver === true,
        strategyMode: server.tradingSystem.strategyMode,
        maxPositions: server.tradingSystem.maxPositions,
        entryDelayMs: server.tradingSystem.isScalpingMode
          ? [server.tradingSystem.entryDelayMinMs, server.tradingSystem.entryDelayMaxMs]
          : null,
        uptime: Math.floor(uptime),
        uptimeFormatted: `${Math.floor(uptime / 3600)}시간 ${Math.floor((uptime % 3600) / 60)}분`,
        lastTradeTime,
        nextAnalysis: nextAnalysis.toISOString(),
        checkInterval,
        targetCoinsCount: server.tradingSystem.targetCoins?.length || 0,
        currentPositions,
        recentErrors,
        hasErrors: recentErrors.length > 0,
        serverTime: now.toISOString()
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/today-summary', async (req, res) => {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      let todayTrades = [];
      let totalBuyAmount = 0;
      let totalSellAmount = 0;
      let buyCount = 0;
      let sellCount = 0;
      let realizedProfit = 0;

      // 스마트 거래 이력에서 오늘 거래 필터링
      if (server.tradingSystem.smartTradeHistory) {
        todayTrades = server.tradingSystem.smartTradeHistory.filter(trade => {
          const tradeDate = new Date(trade.timestamp);
          return tradeDate >= today;
        });

        todayTrades.forEach(trade => {
          if (trade.type === 'BUY') {
            buyCount++;
            totalBuyAmount += trade.amount || 0;
          } else if (trade.type === 'SELL') {
            sellCount++;
            totalSellAmount += trade.amount || 0;
            realizedProfit += trade.profit || 0;
          }
        });
      }

      // 전략별 오늘 거래도 확인 (자동매매 이력)
      // 전략의 tradeHistory는 action: 'OPEN'/'CLOSE' 형식 사용
      if (server.tradingSystem.strategies) {
        const processedTradeIds = new Set(todayTrades.map(t => t.id || t.timestamp));

        for (const strategy of server.tradingSystem.strategies.values()) {
          const history = strategy.tradeHistory || [];
          history.forEach(trade => {
            // 이미 smartTradeHistory에서 처리된 거래는 스킵
            if (trade.id && processedTradeIds.has(trade.id)) return;

            // OPEN (매수) 거래
            if (trade.action === 'OPEN') {
              const tradeDate = new Date(trade.entryTime);
              if (tradeDate >= today) {
                buyCount++;
                // 매수 금액 계산: 진입가 × 수량
                const buyAmount = (trade.entryPrice || 0) * (trade.amount || 0);
                totalBuyAmount += buyAmount;
              }
            }

            // CLOSE (매도) 거래
            if (trade.action === 'CLOSE') {
              const tradeDate = new Date(trade.exitTime);
              if (tradeDate >= today) {
                sellCount++;
                // 매도 금액 계산: 청산가 × 수량
                const sellAmount = (trade.exitPrice || 0) * (trade.amount || 0);
                totalSellAmount += sellAmount;
                realizedProfit += trade.profit || 0;
              }
            }
          });
        }
      }

      res.json({
        date: today.toISOString().split('T')[0],
        totalTrades: buyCount + sellCount,
        buyCount,
        sellCount,
        totalBuyAmount: Math.round(totalBuyAmount),
        totalSellAmount: Math.round(totalSellAmount),
        netFlow: Math.round(totalSellAmount - totalBuyAmount),
        realizedProfit: Math.round(realizedProfit),
        trades: todayTrades.slice(0, 10)
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/portfolio-analysis', async (req, res) => {
    try {
      if (server.tradingSystem.readOnlyObserver === true) {
        if (typeof server.tradingSystem.getPaperValidationStatus !== 'function') {
          return res.status(503).json({ readOnlyObserver: true, error: 'paper ledger status unavailable' });
        }
        const paperStatus = await server.tradingSystem.getPaperValidationStatus();
        return res.json(projectReadOnlyPaperPortfolioAnalysis(paperStatus));
      }

      const holdings = [];
      let totalValue = 0;
      let totalCost = 0;

      // Read holdings from the active account mode. LIVE must never reuse a
      // stale virtual portfolio left on the process.
      const isDryRun = server.tradingSystem.dryRun === true;
      const liveAccounts = isDryRun ? null : await server.tradingSystem.getAccountInfo();
      const portfolioHoldings = isDryRun
        ? server.tradingSystem.virtualPortfolio?.holdings
        : new Map((Array.isArray(liveAccounts) ? liveAccounts : [])
          .filter(account => account?.currency && account.currency !== quoteOfSystem(server.tradingSystem))
          .map(account => {
            const amount = Number(account.balance);
            const avgPrice = Number(account.avg_buy_price) || 0;
            return [`${quoteOfSystem(server.tradingSystem)}-${account.currency}`, { amount, avgPrice }];
          })
          .filter(([, holding]) => Number.isFinite(holding.amount) && holding.amount > 0));

      // Map 또는 Object 모두 처리
      const isMap = portfolioHoldings instanceof Map;
      const holdingsEntries = isMap
        ? Array.from(portfolioHoldings.entries())
        : Object.entries(portfolioHoldings || {});

      const coins = holdingsEntries.map(([coin]) => coin);
      const marketSnapshot = coins.length > 0
        ? await getMarketDataProvider(server).getSnapshot(coins, {
          freshness: MARKET_DATA_FRESHNESS.CACHED
        })
        : {
          tickers: [],
          priceMap: new Map(),
          freshPriceMap: new Map(),
          sourceAsOfByMarket: new Map(),
          quoteFreshnessByMarket: new Map(),
          fetchedAtByMarket: new Map(),
          sourceAsOf: null,
          fetchedAt: null,
          complete: true,
          allQuotesFresh: true,
          freshMarkets: [],
          staleMarkets: [],
          sourceSkewMs: null,
          captureSkewMs: null,
          snapshotSource: 'none',
          fallbackReason: null,
          unavailableMarkets: []
        };

      if (holdingsEntries.length > 0) {
        for (const [coin, holding] of holdingsEntries) {
          const ticker = marketSnapshot.tickers.find(item => item.market === coin) || null;
          const currentPrice = marketSnapshot.freshPriceMap.get(coin) ?? null;
          const valuationAvailable = Number.isFinite(currentPrice) && currentPrice > 0;
          const change24h = ticker?.signed_change_rate;
          const change24hAvailable = change24h !== null && change24h !== undefined &&
            Number.isFinite(Number(change24h));
          const currentValue = valuationAvailable ? holding.amount * currentPrice : null;
          const costBasis = holding.amount * holding.avgPrice;
          const profit = valuationAvailable ? currentValue - costBasis : null;
          const profitPercent = valuationAvailable && costBasis > 0
            ? ((currentValue / costBasis) - 1) * 100
            : null;

          if (valuationAvailable) totalValue += currentValue;
          totalCost += costBasis;

          holdings.push({
            coin,
            symbol: coin.split('-')[1],
            amount: holding.amount,
            avgPrice: holding.avgPrice,
            currentPrice,
            currentValue: currentValue === null ? null : Math.round(currentValue),
            costBasis: Math.round(costBasis),
            profit: profit === null ? null : Math.round(profit),
            profitPercent: profitPercent === null ? null : profitPercent.toFixed(2),
            change24h: change24hAvailable
              ? (Number(change24h) * 100).toFixed(2)
              : null,
            valuationAvailable,
            sourceAsOf: marketSnapshot.sourceAsOfByMarket.get(coin) ?? null,
            quoteFreshnessReason: marketSnapshot.quoteFreshnessByMarket.get(coin)?.reason ?? null,
            fetchedAt: marketSnapshot.fetchedAtByMarket?.get(coin) ?? marketSnapshot.fetchedAt,
            weight: null
          });
        }
      }

      const valuationAvailable = holdings.every(holding => holding.valuationAvailable === true);
      if (!valuationAvailable) totalValue = null;

      // KRW 잔액 추가
      const krwBalance = isDryRun
        ? (server.tradingSystem.virtualPortfolio?.krwBalance || 0)
        : (server.tradingSystem.getKRWBalance(liveAccounts) || 0);

      const totalAssets = valuationAvailable ? totalValue + krwBalance : null;

      // 비중 계산
      if (valuationAvailable) {
        holdings.forEach(h => {
          h.weight = totalAssets > 0 ? ((h.currentValue / totalAssets) * 100).toFixed(1) : '0';
        });
      }

      // 수익률 순 정렬
      const valuedHoldings = holdings.filter(holding => holding.valuationAvailable === true);
      const topGainers = [...valuedHoldings]
        .sort((a, b) => parseFloat(b.profitPercent) - parseFloat(a.profitPercent)).slice(0, 3);
      const topLosers = [...valuedHoldings]
        .sort((a, b) => parseFloat(a.profitPercent) - parseFloat(b.profitPercent)).slice(0, 3);

      // 비중 순 정렬
      const byWeight = valuationAvailable
        ? [...holdings].sort((a, b) => parseFloat(b.weight) - parseFloat(a.weight))
        : holdings;

      res.json({
        holdings: byWeight,
        summary: {
          totalHoldings: holdings.length,
          totalValue: totalValue === null ? null : Math.round(totalValue),
          totalCost: Math.round(totalCost),
          totalProfit: totalValue === null ? null : Math.round(totalValue - totalCost),
          totalProfitPercent: totalValue !== null && totalCost > 0
            ? (((totalValue / totalCost) - 1) * 100).toFixed(2)
            : null,
          krwBalance: Math.round(krwBalance),
          krwWeight: totalAssets !== null && totalAssets > 0
            ? ((krwBalance / totalAssets) * 100).toFixed(1)
            : null,
          totalAssets: totalAssets === null ? null : Math.round(totalAssets),
          valuationAvailable,
          valuationStatus: valuationAvailable
            ? 'available'
            : marketSnapshot.staleMarkets?.length > 0 ? 'stale' : 'unavailable',
          valuationAsOf: marketSnapshot.sourceAsOf,
          sourceAsOf: marketSnapshot.sourceAsOf,
          fetchedAt: marketSnapshot.fetchedAt,
          staleMarkets: marketSnapshot.staleMarkets || [],
          sourceSkewMs: marketSnapshot.sourceSkewMs ?? null,
          captureSkewMs: marketSnapshot.captureSkewMs ?? null,
          snapshotSource: marketSnapshot.snapshotSource ?? 'upstream',
          fallbackReason: marketSnapshot.fallbackReason ?? null,
          unavailableMarkets: marketSnapshot.unavailableMarkets
        },
        topGainers,
        topLosers
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/coin-detail/:coin', async (req, res) => {
    try {
      const coin = req.params.coin;

      // 현재가 조회
      let ticker = null;
      let currentPrice = 0;
      try {
        ticker = await getMarketDataProvider(server).getTickers(coin, {
          freshness: MARKET_DATA_FRESHNESS.FRESH
        });
        currentPrice = ticker?.[0]?.trade_price || 0;
      } catch (tickerErr) {
        console.error(`[coin-detail] 현재가 조회 실패 (${coin}):`, tickerErr.message);
        // 현재가 조회 실패해도 계속 진행
      }

      // 보유 정보
      const holding = server.tradingSystem.virtualPortfolio?.holdings?.get(coin);
      const holdingAmount = holding?.amount || 0;
      const avgPrice = holding?.avgPrice || 0;
      const holdingValue = holdingAmount * currentPrice;
      const costBasis = holdingAmount * avgPrice;
      const profit = holdingValue - costBasis;
      const profitPercent = costBasis > 0 ? ((holdingValue / costBasis) - 1) * 100 : 0;

      // 캔들 데이터로 기술적 분석
      let analysis = null;
      try {
        const candles = await getMarketDataProvider(server).getMinuteCandles(coin, 5, 50);
        if (candles?.length >= 30) {
          const { comprehensiveAnalysis } = await import('../analysis/technicalIndicators.js');
          analysis = comprehensiveAnalysis(candles, {});
        }
      } catch (candleErr) {
        console.error(`[coin-detail] 캔들 데이터 조회 실패 (${coin}):`, candleErr.message);
        // 캔들 조회 실패해도 계속 진행
      }

      // KRW 잔액
      const krwBalance = server.tradingSystem.dryRun
        ? (server.tradingSystem.virtualPortfolio?.krwBalance || 0)
        : 0;

      res.json({
        coin,
        symbol: coin.split('-')[1],
        currentPrice,
        change24h: ticker?.[0]?.signed_change_rate ? (ticker[0].signed_change_rate * 100).toFixed(2) : '0',
        high24h: ticker?.[0]?.high_price || 0,
        low24h: ticker?.[0]?.low_price || 0,
        volume24h: ticker?.[0]?.acc_trade_price_24h || 0,
        holding: {
          amount: holdingAmount,
          avgPrice,
          currentValue: Math.round(holdingValue),
          costBasis: Math.round(costBasis),
          profit: Math.round(profit),
          profitPercent: profitPercent.toFixed(2)
        },
        indicators: analysis?.indicators ? {
          rsi: analysis.indicators.rsi?.toFixed(1) || '-',
          macd: analysis.indicators.macd?.histogram?.toFixed(2) || '-',
          bb: analysis.indicators.bollingerBands?.percentB?.toFixed(2) || '-'
        } : null,
        krwBalance: Math.round(krwBalance),
        maxBuyAmount: Math.floor(krwBalance * 0.95),
        maxSellAmount: Math.round(holdingValue)
      });
    } catch (error) {
      console.error(`[coin-detail] 전체 오류:`, error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
