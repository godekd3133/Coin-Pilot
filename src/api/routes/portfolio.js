import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * 포트폴리오/거래이력/가상자금 관련 라우트
 */
export default function createPortfolioRoutes(server) {
  const router = express.Router();

  // 거래 이력 조회
  router.get('/trades', (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 50;
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
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // 누적 손익 조회
  router.get('/cumulative-pnl', async (req, res) => {
    try {
      if (typeof server.tradingSystem.calculateCumulativePnL === 'function') {
        const pnl = await server.tradingSystem.calculateCumulativePnL();
        res.json(pnl);
      } else {
        const accounts = await server.tradingSystem.getAccountInfo();
        let totalAssets = server.tradingSystem.getKRWBalance(accounts) || 0;

        let holdings = new Map();
        if (server.tradingSystem.dryRun) {
          holdings = server.getHoldingsAsMap();
        } else {
          for (const acc of accounts) {
            if (acc.currency !== 'KRW' && parseFloat(acc.balance) > 0) {
              holdings.set(`KRW-${acc.currency}`, {
                amount: parseFloat(acc.balance),
                avgPrice: parseFloat(acc.avg_buy_price) || 0
              });
            }
          }
        }

        const positionCoins = Array.from(holdings.keys());

        if (positionCoins.length > 0 && server.tradingSystem.upbit) {
          try {
            const tickers = await server.getCachedTicker(positionCoins);
            for (const ticker of tickers) {
              const holding = holdings.get(ticker.market);
              if (holding) {
                totalAssets += ticker.trade_price * holding.amount;
              }
            }
          } catch (e) {
            for (const holding of holdings.values()) {
              totalAssets += holding.avgPrice * holding.amount;
            }
          }
        }

        const initialSeedMoney = server.tradingSystem.initialSeedMoney || 10000000;
        const profit = totalAssets - initialSeedMoney;
        const profitPercent = initialSeedMoney > 0
          ? ((totalAssets / initialSeedMoney) - 1) * 100
          : 0;

        res.json({
          initialSeedMoney,
          totalAssets: Math.round(totalAssets),
          profit: Math.round(profit),
          profitPercent,
          mode: server.tradingSystem.dryRun ? 'DRY_RUN' : 'LIVE'
        });
      }
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // 자산 추이 저장 (자동 호출)
  router.post('/portfolio/snapshot', async (req, res) => {
    try {
      if (!server.tradingSystem || !server.tradingSystem.upbit) {
        return res.json({ success: false, message: '거래 시스템 미초기화', dataPoints: 0 });
      }

      const historyFile = path.join(PROJECT_ROOT, 'portfolio_history.json');
      let history = [];

      if (fs.existsSync(historyFile)) {
        try {
          history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
        } catch (e) {
          history = [];
        }
      }

      let totalAssets = 0;
      let krwBalance = 0;

      try {
        const accounts = await server.tradingSystem.getAccountInfo();
        krwBalance = server.tradingSystem.getKRWBalance(accounts) || 0;
        totalAssets = krwBalance;
      } catch (e) {
        if (server.tradingSystem.virtualPortfolio) {
          krwBalance = server.tradingSystem.virtualPortfolio.krwBalance || 0;
          totalAssets = krwBalance;
        }
      }

      const holdingsMap = server.getHoldingsAsMap();
      const positionCoins = Array.from(holdingsMap.keys());

      if (positionCoins.length > 0 && server.tradingSystem.upbit) {
        try {
          const tickers = await server.getCachedTicker(positionCoins);
          for (const ticker of tickers) {
            const holding = holdingsMap.get(ticker.market);
            if (holding) {
              totalAssets += ticker.trade_price * holding.amount;
            }
          }
        } catch (e) {
          for (const holding of holdingsMap.values()) {
            totalAssets += (holding.avgPrice || 0) * (holding.amount || 0);
          }
        }
      }

      history.push({
        timestamp: new Date().toISOString(),
        totalAssets: Math.round(totalAssets),
        krwBalance: Math.round(krwBalance),
        positionCount: positionCoins.length
      });

      if (history.length > 8640) {
        history = history.slice(-8640);
      }

      fs.writeFileSync(historyFile, JSON.stringify(history, null, 2), 'utf8');
      res.json({ success: true, dataPoints: history.length });
    } catch (error) {
      res.json({ success: false, error: error.message, dataPoints: 0 });
    }
  });

  // 자산 추이 조회
  router.get('/portfolio/history', (req, res) => {
    try {
      const historyFile = path.join(PROJECT_ROOT, 'portfolio_history.json');
      const period = req.query.period || '24h';

      if (!fs.existsSync(historyFile)) {
        return res.json({ data: [], period, count: 0 });
      }

      let history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));

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

      const originalHistory = [...history];
      history = history.filter(h => new Date(h.timestamp).getTime() > cutoff);

      if (history.length === 0 && originalHistory.length > 0) {
        history = originalHistory.slice(-10);
      }

      const maxPoints = 100;
      if (history.length > maxPoints) {
        const step = Math.ceil(history.length / maxPoints);
        history = history.filter((_, idx) => idx % step === 0);
      }

      res.json({ data: history, period, count: history.length });
    } catch (error) {
      res.json({ data: [], error: error.message });
    }
  });

  // 모의투자 입금 (드라이 모드 전용)
  router.post('/virtual/deposit', (req, res) => {
    try {
      if (!server.tradingSystem.dryRun) {
        return res.status(400).json({ error: '실전 모드에서는 사용할 수 없습니다', success: false });
      }

      const { amount } = req.body;
      const depositAmount = parseInt(amount);

      if (!depositAmount || depositAmount < 1000) {
        return res.status(400).json({ error: '최소 입금액은 1,000원입니다', success: false });
      }

      if (depositAmount > 100000000) {
        return res.status(400).json({ error: '최대 입금액은 1억원입니다', success: false });
      }

      server.tradingSystem.virtualPortfolio.krwBalance += depositAmount;

      if (server.tradingSystem.initialSeedMoney !== undefined) {
        server.tradingSystem.initialSeedMoney += depositAmount;
      }

      if (server.tradingSystem.saveVirtualPortfolio) {
        server.tradingSystem.saveVirtualPortfolio();
      }

      res.json({
        success: true,
        message: `${depositAmount.toLocaleString()}원이 입금되었습니다 (시드머니 추가)`,
        newBalance: server.tradingSystem.virtualPortfolio.krwBalance,
        newSeedMoney: server.tradingSystem.initialSeedMoney
      });
    } catch (error) {
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // 모의투자 출금 (드라이 모드 전용)
  router.post('/virtual/withdraw', (req, res) => {
    try {
      if (!server.tradingSystem.dryRun) {
        return res.status(400).json({ error: '실전 모드에서는 사용할 수 없습니다', success: false });
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

      server.tradingSystem.virtualPortfolio.krwBalance -= withdrawAmount;

      if (server.tradingSystem.initialSeedMoney !== undefined) {
        server.tradingSystem.initialSeedMoney -= withdrawAmount;
        if (server.tradingSystem.initialSeedMoney < 0) {
          server.tradingSystem.initialSeedMoney = 0;
        }
      }

      if (server.tradingSystem.saveVirtualPortfolio) {
        server.tradingSystem.saveVirtualPortfolio();
      }

      res.json({
        success: true,
        message: `${withdrawAmount.toLocaleString()}원이 출금되었습니다 (시드머니 회수)`,
        newBalance: server.tradingSystem.virtualPortfolio.krwBalance,
        newSeedMoney: server.tradingSystem.initialSeedMoney
      });
    } catch (error) {
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // 모의투자 시드머니 리셋 (드라이 모드 전용)
  router.post('/virtual/reset', (req, res) => {
    try {
      if (!server.tradingSystem.dryRun) {
        return res.status(400).json({ error: '실전 모드에서는 사용할 수 없습니다', success: false });
      }

      const { seedMoney } = req.body;
      const newSeedMoney = parseInt(seedMoney) || 10000000;

      server.tradingSystem.virtualPortfolio.krwBalance = newSeedMoney;
      server.tradingSystem.virtualPortfolio.holdings.clear();
      server.tradingSystem.initialSeedMoney = newSeedMoney;

      if (server.tradingSystem.strategies) {
        for (const strategy of server.tradingSystem.strategies.values()) {
          strategy.currentPosition = null;
          strategy.tradeHistory = [];
        }
      }

      if (server.tradingSystem.saveVirtualPortfolio) {
        server.tradingSystem.saveVirtualPortfolio();
      }

      res.json({
        success: true,
        message: `시드머니가 ${newSeedMoney.toLocaleString()}원으로 리셋되었습니다`,
        newBalance: newSeedMoney,
        initialSeedMoney: newSeedMoney
      });
    } catch (error) {
      res.status(500).json({ error: error.message, success: false });
    }
  });

  return router;
}
