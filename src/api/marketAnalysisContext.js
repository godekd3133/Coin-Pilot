// 대시보드 분석 read-model의 공유 읽기 — marketAnalysisQueries.js에서 추출.
// 신선 시세, 캔들, 잔고·보유 조회를 한 번 묶어 쿼리 use-case에 주입한다.
import { MARKET_DATA_FRESHNESS } from './marketDataProvider.js';
import { quoteOfSystem } from '../exchange/marketCodes.js';

export function createMarketAnalysisContext({ tradingSystem, marketDataProvider }) {
  const readFreshTickers = markets => marketDataProvider.getTickers(markets, {
    freshness: MARKET_DATA_FRESHNESS.FRESH
  });
  const readMinuteCandles = (...args) => marketDataProvider.getMinuteCandles(...args);

  const readKrwBalance = async () => {
    try {
      const accounts = await tradingSystem.getAccountInfo();
      return tradingSystem.getKRWBalance(accounts) || 0;
    } catch (e) {
      console.error('잔액 조회 실패:', e.message);
      return 0;
    }
  };

  // 보유 포지션 확인 (매도 추천용) - 실전/드라이 모드 모두 지원
  const readHoldings = async () => {
    const holdings = new Map();
    if (tradingSystem.dryRun) {
      const holdingsData = tradingSystem.virtualPortfolio?.holdings;
      const holdingsEntries = holdingsData instanceof Map
        ? Array.from(holdingsData.entries())
        : Object.entries(holdingsData || {});
      for (const [coin, holding] of holdingsEntries) {
        if (holding.amount > 0) {
          holdings.set(coin, holding);
        }
      }
      return holdings;
    }
    const accounts = await tradingSystem.getAccountInfo();
    for (const acc of accounts) {
      const quote = quoteOfSystem(tradingSystem);
      if (acc.currency !== quote && parseFloat(acc.balance) > 0) {
        holdings.set(`${quote}-${acc.currency}`, {
          amount: parseFloat(acc.balance),
          avgPrice: parseFloat(acc.avg_buy_price) || 0
        });
      }
    }
    return holdings;
  };

  return {
    tradingSystem,
    marketDataProvider,
    readFreshTickers,
    readMinuteCandles,
    readKrwBalance,
    readHoldings
  };
}
