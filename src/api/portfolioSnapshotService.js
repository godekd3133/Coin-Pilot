import { accountValuationMarkets, readCurrentMarketPrices } from './marketValuation.js';
import { roundQuoteAmount } from './manualOrderLegs.js';
import { PortfolioHistoryFormatError } from './portfolioHistoryStore.js';

const SNAPSHOT_IN_PROGRESS_RESPONSE = {
  success: false,
  recorded: false,
  code: 'snapshot_in_progress',
  error: '자산 기록을 저장하고 있어요. 잠시 후 다시 시도해 주세요.'
};

/** Coordinates strict valuation and persistence for one portfolio snapshot. */
export default class PortfolioSnapshotService {
  constructor({ server, historyStoreFactory, now = () => new Date() } = {}) {
    if (!server || typeof historyStoreFactory !== 'function') {
      throw new TypeError('A server and portfolio history store factory are required');
    }

    this.server = server;
    this.historyStoreFactory = historyStoreFactory;
    this.now = now;
    this.snapshotWriteInProgress = false;
  }

  async recordSnapshot() {
    if (this.snapshotWriteInProgress) {
      return { status: 409, body: { ...SNAPSHOT_IN_PROGRESS_RESPONSE } };
    }

    this.snapshotWriteInProgress = true;
    const { server } = this;
    const tradingSystem = server.tradingSystem;
    try {
      if (!tradingSystem?.upbit ||
          typeof tradingSystem.getAccountInfo !== 'function' ||
          typeof tradingSystem.calculateTotalAssets !== 'function') {
        return {
          status: 503,
          body: {
            success: false,
            recorded: false,
            valuationAvailable: false,
            error: '현재 계좌 평가를 계산할 수 없어 자산 기록을 저장하지 않았어요.'
          }
        };
      }

      const historyStore = this.historyStoreFactory();
      let history;
      try {
        history = historyStore.readAll();
      } catch (error) {
        server.logApiError('/api/portfolio/snapshot/history', error);
        return {
          status: 503,
          body: {
            success: false,
            recorded: false,
            error: error instanceof PortfolioHistoryFormatError
              ? '기존 자산 기록 형식이 달라 새 기록을 저장하지 않았어요.'
              : '기존 자산 기록을 읽지 못해 새 기록을 저장하지 않았어요.'
          }
        };
      }

      let accounts;
      try {
        accounts = await tradingSystem.getAccountInfo();
      } catch (error) {
        server.logApiError('/api/portfolio/snapshot/account', error);
        return {
          status: 503,
          body: {
            success: false,
            recorded: false,
            valuationAvailable: false,
            error: '계좌 정보를 확인하지 못해 자산 기록을 저장하지 않았어요.'
          }
        };
      }
      if (!Array.isArray(accounts)) {
        return {
          status: 503,
          body: {
            success: false,
            recorded: false,
            valuationAvailable: false,
            error: '계좌 정보를 확인하지 못해 자산 기록을 저장하지 않았어요.'
          }
        };
      }

      const krwBalance = tradingSystem.dryRun
        ? Number(tradingSystem.virtualPortfolio?.krwBalance)
        : Number(tradingSystem.getKRWBalance(accounts));
      if (!Number.isFinite(krwBalance) || krwBalance < 0) {
        return {
          status: 503,
          body: {
            success: false,
            recorded: false,
            valuationAvailable: false,
            error: '원화 잔액을 확인하지 못해 자산 기록을 저장하지 않았어요.'
          }
        };
      }

      const valuationMarkets = accountValuationMarkets(tradingSystem, accounts);
      const marketSnapshot = await readCurrentMarketPrices(server, valuationMarkets);
      const usedLastGoodSnapshot = marketSnapshot.snapshotSource === 'last_good';
      if (!marketSnapshot.complete || marketSnapshot.allQuotesFresh !== true || usedLastGoodSnapshot) {
        return {
          status: 503,
          body: {
            success: false,
            recorded: false,
            valuationAvailable: false,
            valuationStatus: marketSnapshot.staleMarkets?.length > 0 || usedLastGoodSnapshot
              ? 'stale' : 'unavailable',
            valuationAsOf: marketSnapshot.asOf,
            sourceAsOf: marketSnapshot.sourceAsOf,
            fetchedAt: marketSnapshot.fetchedAt,
            sourceSkewMs: marketSnapshot.sourceSkewMs ?? null,
            captureSkewMs: marketSnapshot.captureSkewMs ?? null,
            snapshotSource: marketSnapshot.snapshotSource ?? 'upstream',
            staleMarkets: marketSnapshot.staleMarkets || [],
            unavailableMarkets: marketSnapshot.unavailableMarkets,
            dataPoints: history.length,
            error: usedLastGoodSnapshot
              ? '최근 저장한 시세를 표시 중이라 새 기록을 저장하지 않았어요.'
              : marketSnapshot.staleMarkets?.length > 0
                ? '보유 자산의 최근 체결 시각이 오래되어 새 기록을 저장하지 않았어요.'
                : '모든 보유 자산의 시세를 확인하지 못해 새 기록을 저장하지 않았어요.'
          }
        };
      }

      const totalAssets = await tradingSystem.calculateTotalAssets(marketSnapshot.freshPriceMap, {
        allowAveragePriceFallback: false,
        accountsOverride: accounts
      });
      if (!Number.isFinite(totalAssets) || totalAssets < 0) {
        return {
          status: 503,
          body: {
            success: false,
            recorded: false,
            valuationAvailable: false,
            valuationStatus: 'unavailable',
            valuationAsOf: marketSnapshot.asOf,
            sourceAsOf: marketSnapshot.sourceAsOf,
            fetchedAt: marketSnapshot.fetchedAt,
            staleMarkets: marketSnapshot.staleMarkets || [],
            unavailableMarkets: marketSnapshot.unavailableMarkets || [],
            dataPoints: history.length,
            error: '현재 자산 평가를 완료하지 못해 새 기록을 저장하지 않았어요.'
          }
        };
      }

      const capturedAt = this.now().toISOString();
      history.push({
        timestamp: capturedAt,
        capturedAt,
        valuationAsOf: marketSnapshot.asOf,
        sourceAsOf: marketSnapshot.sourceAsOf,
        fetchedAt: marketSnapshot.fetchedAt,
        sourceSkewMs: marketSnapshot.sourceSkewMs ?? null,
        captureSkewMs: marketSnapshot.captureSkewMs ?? null,
        maximumQuoteAgeMs: marketSnapshot.maximumQuoteAgeMs ?? null,
        sourceAsOfByMarket: Object.fromEntries(marketSnapshot.sourceAsOfByMarket || []),
        fetchedAtByMarket: Object.fromEntries(marketSnapshot.fetchedAtByMarket || []),
        snapshotSource: marketSnapshot.snapshotSource ?? 'upstream',
        valuationAvailable: true,
        valuationStatus: 'available',
        valuationSource: tradingSystem.dryRun ? 'paper_virtual_portfolio' : 'exchange_account',
        mode: tradingSystem.dryRun ? 'DRY_RUN' : 'LIVE',
        totalAssets: roundQuoteAmount(tradingSystem, totalAssets),
        krwBalance: roundQuoteAmount(tradingSystem, krwBalance),
        positionCount: valuationMarkets.length
      });

      const dataPoints = historyStore.write(history);

      let paperLedgerSnapshotRecorded = null;
      if (tradingSystem.dryRun && typeof tradingSystem.recordPaperValidationSnapshot === 'function') {
        try {
          const status = await tradingSystem.recordPaperValidationSnapshot(
            'dashboard_snapshot',
            marketSnapshot.freshPriceMap
          );
          paperLedgerSnapshotRecorded = status !== null;
        } catch (error) {
          paperLedgerSnapshotRecorded = false;
          server.logApiError('/api/portfolio/snapshot/paper-ledger', error);
        }
      }

      return {
        status: 200,
        body: {
          success: true,
          recorded: true,
          valuationAvailable: true,
          valuationStatus: 'available',
          valuationAsOf: marketSnapshot.asOf,
          sourceAsOf: marketSnapshot.sourceAsOf,
          fetchedAt: marketSnapshot.fetchedAt,
          capturedAt,
          mode: tradingSystem.dryRun ? 'DRY_RUN' : 'LIVE',
          paperLedgerSnapshotRecorded,
          dataPoints
        }
      };
    } catch (error) {
      server.logApiError('/api/portfolio/snapshot', error);
      return {
        status: 500,
        body: {
          success: false,
          recorded: false,
          error: '자산 기록을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.'
        }
      };
    } finally {
      this.snapshotWriteInProgress = false;
    }
  }
}
