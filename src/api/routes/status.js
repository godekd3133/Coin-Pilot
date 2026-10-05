import express from 'express';
import path from 'path';
import { projectReadOnlyPaperPortfolioAnalysis } from '../readOnlyPaperPortfolio.js';
import { getMarketDataProvider, MARKET_DATA_FRESHNESS } from '../marketDataProvider.js';
import { readLogTail } from '../../utils/readLogTail.js';
import { parseRecentLogErrors } from '../../utils/parseRecentLogErrors.js';
import { quoteOfSystem } from '../../exchange/marketCodes.js';
import { roundQuoteAmount, floorQuoteAmount } from '../manualOrderLegs.js';

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
        totalBuyAmount: roundQuoteAmount(server.tradingSystem, totalBuyAmount),
        totalSellAmount: roundQuoteAmount(server.tradingSystem, totalSellAmount),
        netFlow: roundQuoteAmount(server.tradingSystem, totalSellAmount - totalBuyAmount),
        realizedProfit: roundQuoteAmount(server.tradingSystem, realizedProfit),
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
            currentValue: currentValue === null ? null : roundQuoteAmount(server.tradingSystem, currentValue),
            costBasis: roundQuoteAmount(server.tradingSystem, costBasis),
            profit: profit === null ? null : roundQuoteAmount(server.tradingSystem, profit),
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
          totalValue: totalValue === null ? null : roundQuoteAmount(server.tradingSystem, totalValue),
          totalCost: roundQuoteAmount(server.tradingSystem, totalCost),
          totalProfit: totalValue === null ? null : roundQuoteAmount(server.tradingSystem, totalValue - totalCost),
          totalProfitPercent: totalValue !== null && totalCost > 0
            ? (((totalValue / totalCost) - 1) * 100).toFixed(2)
            : null,
          krwBalance: roundQuoteAmount(server.tradingSystem, krwBalance),
          krwWeight: totalAssets !== null && totalAssets > 0
            ? ((krwBalance / totalAssets) * 100).toFixed(1)
            : null,
          totalAssets: totalAssets === null ? null : roundQuoteAmount(server.tradingSystem, totalAssets),
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

      const tradingSystem = server.tradingSystem;
      let marketSnapshot = {
        tickers: [], freshPriceMap: new Map(), staleMarkets: [],
        sourceAsOfByMarket: new Map(), fetchedAtByMarket: new Map()
      };
      try {
        marketSnapshot = await getMarketDataProvider(server).getSnapshot([coin], {
          freshness: MARKET_DATA_FRESHNESS.FRESH
        });
      } catch (tickerErr) {
        console.error(`[coin-detail] 현재가 조회 실패 (${coin}):`, tickerErr.message);
      }
      const ticker = marketSnapshot.tickers.find(row => row.market === coin);
      const currentPrice = marketSnapshot.freshPriceMap.get(coin) ?? null;
      const quoteAvailable = Number.isFinite(currentPrice) && currentPrice > 0;

      let holdingAmount = null;
      let avgPrice = null;
      let krwBalance = null;
      let accountAvailable = false;
      try {
        if (tradingSystem.dryRun === true) {
          const holdings = tradingSystem.virtualPortfolio?.holdings;
          const holding = holdings instanceof Map ? holdings.get(coin) : holdings?.[coin];
          holdingAmount = Number(holding?.amount ?? 0);
          avgPrice = Number(holding?.avgPrice ?? 0);
          krwBalance = Number(tradingSystem.virtualPortfolio?.krwBalance);
        } else {
          const accounts = typeof server.getObserverCachedAccountInfo === 'function'
            ? await server.getObserverCachedAccountInfo()
            : await tradingSystem.getAccountInfo();
          if (!Array.isArray(accounts)) throw new TypeError('Account data is unavailable.');
          const holding = accounts.find(row => row.currency === coin.split('-')[1]);
          holdingAmount = Number(holding?.balance ?? 0);
          avgPrice = Number(holding?.avg_buy_price ?? 0);
          krwBalance = Number(tradingSystem.getKRWBalance(accounts));
        }
        accountAvailable = Number.isFinite(holdingAmount) && holdingAmount >= 0 &&
          Number.isFinite(krwBalance) && krwBalance >= 0;
      } catch (accountError) {
        server.logApiError?.('/api/coin-detail/account', accountError);
      }
      if (!accountAvailable) {
        holdingAmount = null;
        avgPrice = null;
        krwBalance = null;
      }
      const valuationAvailable = accountAvailable && quoteAvailable;
      const holdingValue = valuationAvailable ? holdingAmount * currentPrice : null;
      const costBasis = accountAvailable && (holdingAmount === 0 || (Number.isFinite(avgPrice) && avgPrice > 0))
        ? holdingAmount * avgPrice : null;
      const profit = holdingValue !== null && costBasis !== null ? holdingValue - costBasis : null;
      const profitPercent = profit !== null && costBasis > 0 ? (profit / costBasis) * 100 : null;

      // 캔들 데이터로 기술적 분석
      let analysis = null;
      try {
        const candles = await getMarketDataProvider(server).getMinuteCandles(coin, 5, 50);
        if (candles?.length >= 30) {
          const { comprehensiveAnalysis } = await import('../../analysis/technicalIndicators.js');
          analysis = comprehensiveAnalysis(candles, {});
        }
      } catch (candleErr) {
        console.error(`[coin-detail] 캔들 데이터 조회 실패 (${coin}):`, candleErr.message);
        // 캔들 조회 실패해도 계속 진행
      }

      const finiteValue = value => {
        if (value === undefined || value === null || value === '') return null;
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : null;
      };
      const fixedIndicator = (value, digits) => finiteValue(value)?.toFixed(digits) ?? null;
      const bands = analysis?.indicators?.bollingerBands;
      const upper = finiteValue(bands?.upper);
      const lower = finiteValue(bands?.lower);
      const bandCurrent = finiteValue(bands?.current);
      const percentB = upper !== null && lower !== null && bandCurrent !== null && upper > lower
        ? (bandCurrent - lower) / (upper - lower) : null;

      res.json({
        coin,
        symbol: coin.split('-')[1],
        currentPrice,
        valuationAvailable,
        valuationStatus: valuationAvailable ? 'available' : marketSnapshot.staleMarkets.length > 0 ? 'stale' : 'unavailable',
        accountAvailable,
        sourceAsOf: marketSnapshot.sourceAsOfByMarket.get(coin) ?? null,
        fetchedAt: marketSnapshot.fetchedAtByMarket.get(coin) ?? null,
        change24h: quoteAvailable ? fixedIndicator(finiteValue(ticker?.signed_change_rate) === null ? null : ticker.signed_change_rate * 100, 2) : null,
        high24h: quoteAvailable ? finiteValue(ticker?.high_price) : null,
        low24h: quoteAvailable ? finiteValue(ticker?.low_price) : null,
        volume24h: quoteAvailable ? finiteValue(ticker?.acc_trade_price_24h) : null,
        holding: {
          amount: holdingAmount,
          avgPrice,
          currentValue: holdingValue === null ? null : roundQuoteAmount(tradingSystem, holdingValue),
          costBasis: costBasis === null ? null : roundQuoteAmount(tradingSystem, costBasis),
          profit: profit === null ? null : roundQuoteAmount(tradingSystem, profit),
          profitPercent: profitPercent === null ? null : profitPercent.toFixed(2)
        },
        indicators: analysis?.indicators ? {
          rsi: fixedIndicator(analysis.indicators.rsi, 1),
          macd: fixedIndicator(analysis.indicators.macd?.histogram, 2),
          bb: fixedIndicator(percentB, 2)
        } : null,
        krwBalance: krwBalance === null ? null : roundQuoteAmount(tradingSystem, krwBalance),
        maxBuyAmount: valuationAvailable ? floorQuoteAmount(tradingSystem, krwBalance * 0.95) : null,
        maxSellAmount: holdingValue === null ? null : roundQuoteAmount(tradingSystem, holdingValue)
      });
    } catch (error) {
      console.error(`[coin-detail] 전체 오류:`, error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
