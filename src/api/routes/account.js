import express from 'express';

/**
 * 계좌/포지션/통계 관련 라우트
 */
export default function createAccountRoutes(server) {
  const router = express.Router();

  // 시스템 상태 조회
  router.get('/status', (req, res) => {
    try {
      res.json({
        isRunning: server.tradingSystem.isRunning,
        mode: server.tradingSystem.dryRun ? 'DRY_RUN' : 'LIVE',
        targetCoins: server.tradingSystem.targetCoins || [server.tradingSystem.config.targetCoin],
        lastUpdate: new Date().toISOString()
      });
    } catch (error) {
      server.logApiError('/api/status', error);
      res.status(500).json({ error: error.message });
    }
  });

  // 계좌 정보 조회
  router.get('/account', async (req, res) => {
    try {
      const accounts = await server.tradingSystem.getAccountInfo();
      const krwBalance = server.tradingSystem.getKRWBalance(accounts);

      const positions = [];
      const positionCoins = [];
      const addedCoins = new Set();

      // 1. 전략 기반 포지션 (자동매매)
      if (server.tradingSystem.strategies) {
        for (const [coin, strategy] of server.tradingSystem.strategies.entries()) {
          if (strategy.currentPosition) {
            positions.push({
              coin,
              ...strategy.currentPosition,
              source: 'strategy'
            });
            positionCoins.push(coin);
            addedCoins.add(coin);
          }
        }
      } else if (server.tradingSystem.strategy?.currentPosition) {
        const coin = server.tradingSystem.config.targetCoin;
        positions.push({
          coin,
          ...server.tradingSystem.strategy.currentPosition,
          source: 'strategy'
        });
        positionCoins.push(coin);
        addedCoins.add(coin);
      }

      // 2. 가상 포트폴리오 holdings (스마트 매수 등)
      // 중요: holdings의 amount가 strategy보다 정확함 (추가 매수 반영)
      if (server.tradingSystem.virtualPortfolio?.holdings) {
        const holdingsData = server.tradingSystem.virtualPortfolio.holdings;
        const holdingsEntries = holdingsData instanceof Map
          ? Array.from(holdingsData.entries())
          : Object.entries(holdingsData || {});
        for (const [coin, holding] of holdingsEntries) {
          if (holding.amount > 0) {
            // 이미 strategy에서 추가된 코인이면 amount/avgPrice를 holdings 값으로 업데이트
            const existingIdx = positions.findIndex(p => p.coin === coin);
            if (existingIdx >= 0) {
              // holdings의 amount가 더 정확 (추가 매수 포함)
              positions[existingIdx].amount = holding.amount;
              positions[existingIdx].avgPrice = holding.avgPrice;
              // entryPrice는 strategy 값 유지 (최초 매수가)
            } else {
              positions.push({
                coin,
                entryPrice: holding.avgPrice,
                amount: holding.amount,
                entryTime: holding.entryTime || new Date().toISOString(),
                source: 'holdings'
              });
              positionCoins.push(coin);
              addedCoins.add(coin);
            }
          }
        }
      }

      // 실시간 현재가 조회 및 총 평가자산 계산
      let totalAssets = server.tradingSystem.dryRun
        ? (server.tradingSystem.virtualPortfolio?.krwBalance || 0)
        : krwBalance;

      if (positionCoins.length > 0 && server.tradingSystem.upbit) {
        try {
          const tickers = await server.getCachedTicker(positionCoins);
          const priceMap = {};
          tickers.forEach(t => {
            priceMap[t.market] = t.trade_price;
          });

          positions.forEach(pos => {
            if (priceMap[pos.coin]) {
              pos.currentPrice = priceMap[pos.coin];
              const positionValue = pos.amount * pos.currentPrice;
              totalAssets += positionValue;

              // avgPrice (평균단가)를 우선 사용 - 추가 매수 반영된 값
              const avgPrice = pos.avgPrice || pos.entryPrice || pos.currentPrice;
              const costBasis = pos.amount * avgPrice;
              pos.currentValue = Math.round(positionValue);
              pos.costBasis = Math.round(costBasis);
              pos.profit = Math.round(positionValue - costBasis);
              pos.profitPercent = costBasis > 0 ? (((positionValue / costBasis) - 1) * 100).toFixed(2) : '0.00';
            }
          });
        } catch (tickerError) {
          console.error('Failed to fetch current prices:', tickerError.message);
          positions.forEach(pos => {
            const entryPrice = pos.entryPrice || pos.avgPrice || 0;
            const positionValue = pos.amount * entryPrice;
            totalAssets += positionValue;
            pos.currentPrice = entryPrice;
            pos.currentValue = Math.round(positionValue);
            pos.costBasis = Math.round(positionValue);
            pos.profit = 0;
            pos.profitPercent = '0.00';
          });
        }
      }

      const initialSeedMoney = server.tradingSystem.initialSeedMoney || 10000000;
      const mode = server.tradingSystem.dryRun ? 'DRY_RUN' : 'LIVE';
      const effectiveKrwBalance = server.tradingSystem.dryRun
        ? (server.tradingSystem.virtualPortfolio?.krwBalance || 0)
        : krwBalance;

      res.json({
        krwBalance: effectiveKrwBalance,
        totalAssets: Math.round(totalAssets),
        initialSeedMoney,
        positions,
        accounts,
        mode
      });
    } catch (error) {
      server.logApiError('/api/account', error);
      res.status(500).json({ error: error.message });
    }
  });

  // 보유 포지션 조회 (수동 매매용)
  router.get('/positions', async (req, res) => {
    try {
      const holdings = [];
      let totalValue = 0;
      const isDryRun = server.tradingSystem.dryRun;

      const coinList = [];

      if (isDryRun) {
        if (server.tradingSystem.virtualPortfolio?.holdings) {
          const holdingsData = server.tradingSystem.virtualPortfolio.holdings;
          const holdingsEntries = holdingsData instanceof Map
            ? Array.from(holdingsData.entries())
            : Object.entries(holdingsData || {});
          for (const [coin, holding] of holdingsEntries) {
            if (holding.amount > 0) {
              coinList.push({ coin, amount: holding.amount, avgPrice: holding.avgPrice });
            }
          }
        }
      } else {
        const accounts = await server.tradingSystem.getAccountInfo();
        for (const acc of accounts) {
          if (acc.currency !== 'KRW' && parseFloat(acc.balance) > 0) {
            coinList.push({
              coin: `KRW-${acc.currency}`,
              amount: parseFloat(acc.balance),
              avgPrice: parseFloat(acc.avg_buy_price) || 0
            });
          }
        }
      }

      if (coinList.length > 0) {
        const coins = coinList.map(c => c.coin);
        const tickers = await server.getCachedTicker(coins);
        const priceMap = {};
        tickers.forEach(t => { priceMap[t.market] = t.trade_price; });

        for (const item of coinList) {
          const currentPrice = priceMap[item.coin] || item.avgPrice;
          const currentValue = item.amount * currentPrice;
          const costBasis = item.amount * item.avgPrice;
          const profit = currentValue - costBasis;
          const profitPercent = costBasis > 0 ? ((profit / costBasis) * 100).toFixed(2) : '0.00';

          holdings.push({
            coin: item.coin,
            amount: item.amount,
            avgPrice: item.avgPrice,
            currentPrice,
            currentValue: Math.round(currentValue),
            profit: Math.round(profit),
            profitPercent
          });

          totalValue += currentValue;
        }
      }

      holdings.sort((a, b) => parseFloat(b.profitPercent) - parseFloat(a.profitPercent));

      res.json({
        holdings,
        totalValue: Math.round(totalValue),
        count: holdings.length,
        mode: isDryRun ? 'DRY_RUN' : 'LIVE'
      });
    } catch (error) {
      server.logApiError('/api/positions', error);
      res.status(500).json({ error: error.message, holdings: [], totalValue: 0 });
    }
  });

  // 거래 통계 조회
  router.get('/statistics', (req, res) => {
    try {
      const stats = [];

      if (server.tradingSystem.strategies) {
        for (const [coin, strategy] of server.tradingSystem.strategies.entries()) {
          stats.push({
            coin,
            ...strategy.getStatistics()
          });
        }
      } else if (server.tradingSystem.strategy) {
        stats.push({
          coin: server.tradingSystem.config.targetCoin,
          ...server.tradingSystem.strategy.getStatistics()
        });
      }

      res.json(stats);
    } catch (error) {
      server.logApiError('/api/statistics', error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
