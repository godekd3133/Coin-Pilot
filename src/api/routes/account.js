import express from 'express';
import { accountValuationMarkets, readCurrentMarketPrices } from '../marketValuation.js';
import { projectReadOnlyPaperAccount, projectReadOnlyPaperPositions } from '../readOnlyPaperPortfolio.js';
import { quoteOfSystem } from '../../exchange/marketCodes.js';
import { quoteAmountLimits, roundQuoteAmount } from '../manualOrderLegs.js';

async function getObserverAccountInfo(server) {
  if (typeof server.getObserverCachedAccountInfo === 'function') {
    return server.getObserverCachedAccountInfo();
  }
  // Preserve direct reads for legacy route adapters that predate DashboardServer's cache.
  return server.tradingSystem.getAccountInfo();
}

/**
 * 계좌/포지션/통계 관련 라우트
 */
export default function createAccountRoutes(server) {
  const router = express.Router();

  // 시스템 상태 조회
  router.get('/status', (req, res) => {
    try {
      const runtimeSafety = typeof server.tradingSystem.getRuntimeSafetyStatus === 'function'
        ? server.tradingSystem.getRuntimeSafetyStatus()
        : {};
      res.json({
        isRunning: server.tradingSystem.isRunning,
        mode: server.tradingSystem.dryRun ? 'DRY_RUN' : 'LIVE',
        exchange: server.tradingSystem.exchange || 'upbit',
        quoteCurrency: server.tradingSystem.quoteAsset || 'KRW',
        ...runtimeSafety,
        liveManualPrepared: server.tradingSystem.liveManualPrepared === true,
        liveManualPrepareOnBoot: server.tradingSystem.liveManualPrepareOnBoot === true,
        liveManualRiskProtection: server.tradingSystem.liveManualRiskProtectionEnabled === true,
        upbitCredentialsConfigured: server.liveCredentialStore?.status?.() === true ||
          server.tradingSystem?.liveCredentialsConfigured === true,
        readOnlyObserver: server.tradingSystem.readOnlyObserver === true,
        strategyMode: server.tradingSystem.strategyMode,
        maxPositions: server.tradingSystem.maxPositions,
        maxCandleAgeSeconds: server.tradingSystem.maxCandleAgeSeconds,
        entryDelayMs: server.tradingSystem.isScalpingMode
          ? [server.tradingSystem.entryDelayMinMs, server.tradingSystem.entryDelayMaxMs]
          : null,
        lossCircuitBreaker: typeof server.tradingSystem.getLossCircuitBreakerStatus === 'function'
          ? server.tradingSystem.getLossCircuitBreakerStatus('strict')
          : null,
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
      if (server.tradingSystem.readOnlyObserver === true) {
        if (typeof server.tradingSystem.getPaperValidationStatus !== 'function') {
          return res.status(503).json({ readOnlyObserver: true, error: 'paper ledger status unavailable' });
        }
        const paperStatus = await server.tradingSystem.getPaperValidationStatus();
        return res.json(projectReadOnlyPaperAccount(paperStatus));
      }

      const accounts = await getObserverAccountInfo(server);
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
      if (server.tradingSystem.dryRun && server.tradingSystem.virtualPortfolio?.holdings) {
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

      if (!server.tradingSystem.dryRun) {
        // The asset screen must describe the exchange account, including funds
        // reserved by open orders. A previous paper wallet or strategy position
        // cannot supply the current LIVE quantity or create an absent holding.
        const strategyPositions = new Map(positions.map(position => [position.coin, position]));
        positions.length = 0;
        positionCoins.length = 0;
        const quote = quoteOfSystem(server.tradingSystem);
        for (const account of accounts) {
          if (!account?.currency || account.currency === quote) continue;
          const amount = Number(account.balance || 0) + Number(account.locked || 0);
          if (!Number.isFinite(amount) || amount <= 0) continue;
          const coin = `${quote}-${account.currency}`;
          const avgPrice = Number(account.avg_buy_price || 0);
          positions.push({
            ...strategyPositions.get(coin),
            coin,
            amount,
            avgPrice,
            entryPrice: avgPrice,
            source: 'exchange'
          });
          positionCoins.push(coin);
        }
      }

      const valuationMarkets = accountValuationMarkets(server.tradingSystem, accounts, positionCoins);
      const marketSnapshot = await readCurrentMarketPrices(server, valuationMarkets);
      const totalAssetsCandidate = await server.tradingSystem.calculateTotalAssets(marketSnapshot.freshPriceMap, {
        allowAveragePriceFallback: false,
        accountsOverride: accounts
      });
      const totalAssets = marketSnapshot.allQuotesFresh === true ? totalAssetsCandidate : null;
      const valuationAvailable = Number.isFinite(totalAssets);

      positions.forEach(pos => {
        const currentPrice = marketSnapshot.freshPriceMap.get(pos.coin);
        const amount = Number(pos.amount);
        const averagePrice = Number(pos.avgPrice ?? pos.entryPrice);
        const costBasis = Number.isFinite(amount) && Number.isFinite(averagePrice) && averagePrice > 0
          ? roundQuoteAmount(server.tradingSystem, amount * averagePrice)
          : null;

        if (Number.isFinite(currentPrice) && Number.isFinite(amount) && amount >= 0) {
          const positionValue = amount * currentPrice;
          pos.currentPrice = currentPrice;
          pos.currentValue = roundQuoteAmount(server.tradingSystem, positionValue);
          pos.costBasis = costBasis;
          pos.profit = costBasis === null ? null : roundQuoteAmount(server.tradingSystem, positionValue - costBasis);
          pos.profitPercent = costBasis > 0
            ? (((positionValue / costBasis) - 1) * 100).toFixed(2)
            : null;
          pos.valuationAvailable = true;
          pos.valuationAsOf = marketSnapshot.asOf;
          pos.sourceAsOf = marketSnapshot.sourceAsOf;
          pos.fetchedAt = marketSnapshot.fetchedAtByMarket?.get(pos.coin) ?? marketSnapshot.fetchedAt;
          pos.quoteFreshnessReason = marketSnapshot.quoteFreshnessByMarket?.get(pos.coin)?.reason ?? null;
        } else {
          pos.currentPrice = null;
          pos.currentValue = null;
          pos.costBasis = costBasis;
          pos.profit = null;
          pos.profitPercent = null;
          pos.valuationAvailable = false;
          pos.valuationAsOf = null;
          pos.sourceAsOf = marketSnapshot.sourceAsOf;
          pos.fetchedAt = marketSnapshot.fetchedAtByMarket?.get(pos.coin) ?? marketSnapshot.fetchedAt;
          pos.quoteFreshnessReason = marketSnapshot.quoteFreshnessByMarket?.get(pos.coin)?.reason ?? null;
        }
      });

      const initialSeedMoney = server.tradingSystem.initialSeedMoney || quoteAmountLimits(server.tradingSystem).defaultSeed;
      const mode = server.tradingSystem.dryRun ? 'DRY_RUN' : 'LIVE';
      const effectiveKrwBalance = server.tradingSystem.dryRun
        ? (server.tradingSystem.virtualPortfolio?.krwBalance || 0)
        : krwBalance;

      res.json({
        krwBalance: effectiveKrwBalance,
        totalAssets: valuationAvailable ? roundQuoteAmount(server.tradingSystem, totalAssets) : null,
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
        fallbackReason: marketSnapshot.fallbackReason ?? null,
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
      if (server.tradingSystem.readOnlyObserver === true) {
        if (typeof server.tradingSystem.getPaperValidationStatus !== 'function') {
          return res.status(503).json({ readOnlyObserver: true, error: 'paper ledger status unavailable' });
        }
        const paperStatus = await server.tradingSystem.getPaperValidationStatus();
        return res.json({
          readOnlyObserver: true,
          valuationBasis: 'paper_ledger_snapshot',
          holdings: projectReadOnlyPaperPositions(paperStatus),
          totalValue: null,
          count: Array.isArray(paperStatus?.strictEvaluation?.positions)
            ? paperStatus.strictEvaluation.positions.length
            : 0,
          mode: 'DRY_RUN'
        });
      }

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
        const accounts = await getObserverAccountInfo(server);
        for (const acc of accounts) {
          if (acc.currency !== quoteOfSystem(server.tradingSystem) && parseFloat(acc.balance) > 0) {
            coinList.push({
              coin: `${quoteOfSystem(server.tradingSystem)}-${acc.currency}`,
              amount: parseFloat(acc.balance),
              avgPrice: parseFloat(acc.avg_buy_price) || 0
            });
          }
        }
      }

      let marketSnapshot = null;
      if (coinList.length > 0) {
        const coins = coinList.map(c => c.coin);
        marketSnapshot = await readCurrentMarketPrices(server, coins);
        const priceMap = marketSnapshot.freshPriceMap;
        let completeValuation = true;

        for (const item of coinList) {
          const quotedPrice = Number(priceMap.get(item.coin));
          const valuationAvailable = Number.isFinite(quotedPrice) && quotedPrice > 0;
          const currentPrice = valuationAvailable ? quotedPrice : null;
          const currentValue = valuationAvailable ? item.amount * currentPrice : null;
          const costBasis = item.amount * item.avgPrice;
          const profit = valuationAvailable ? currentValue - costBasis : null;
          const profitPercent = valuationAvailable && costBasis > 0
            ? ((profit / costBasis) * 100).toFixed(2)
            : null;

          if (!valuationAvailable) completeValuation = false;
          else totalValue += currentValue;

          holdings.push({
            coin: item.coin,
            amount: item.amount,
            avgPrice: item.avgPrice,
            currentPrice,
            currentValue: currentValue === null ? null : roundQuoteAmount(server.tradingSystem, currentValue),
            profit: profit === null ? null : roundQuoteAmount(server.tradingSystem, profit),
            profitPercent,
            valuationAvailable,
            sourceAsOf: marketSnapshot.sourceAsOfByMarket.get(item.coin) ?? null,
            fetchedAt: marketSnapshot.fetchedAtByMarket?.get(item.coin) ?? marketSnapshot.fetchedAt,
            quoteFreshnessReason: marketSnapshot.quoteFreshnessByMarket?.get(item.coin)?.reason ?? null
          });
        }
        if (!completeValuation) totalValue = null;
      }

      holdings.sort((a, b) => parseFloat(b.profitPercent) - parseFloat(a.profitPercent));

      res.json({
        holdings,
        totalValue: totalValue === null ? null : roundQuoteAmount(server.tradingSystem, totalValue),
        valuationAvailable: totalValue !== null,
        valuationStatus: totalValue !== null
          ? 'available'
          : marketSnapshot?.snapshotSource === 'last_good' || marketSnapshot?.staleMarkets?.length > 0
            ? 'stale' : 'unavailable',
        valuationAsOf: marketSnapshot?.sourceAsOf ?? null,
        sourceAsOf: marketSnapshot?.sourceAsOf ?? null,
        fetchedAt: marketSnapshot?.fetchedAt ?? null,
        snapshotSource: marketSnapshot?.snapshotSource ?? 'upstream',
        fallbackReason: marketSnapshot?.fallbackReason ?? null,
        staleMarkets: marketSnapshot?.staleMarkets || [],
        unavailableMarkets: marketSnapshot?.unavailableMarkets || [],
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
