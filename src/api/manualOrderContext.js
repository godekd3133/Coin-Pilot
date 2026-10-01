// 수동 주문 공유 컨텍스트 — manualOrderService.js에서 추출.
// 시세 신선도 read-model과 LIVE leg 실행기를 한 번 묶어 use-case에 주입한다.
import { inspectMarketQuoteFreshness } from './marketQuoteFreshness.js';
import { MARKET_DATA_FRESHNESS } from './marketDataProvider.js';
import {
  executeLiveOrderWithEvidence,
  hasCompleteObservedLiveFill
} from './manualOrderExecution.js';
import { liveFillFailureResult } from './manualOrderLegs.js';

export function createManualOrderContext({ tradingSystem, marketDataProvider }) {
  const readFreshTickers = markets => marketDataProvider.getTickers(markets, {
    freshness: MARKET_DATA_FRESHNESS.FRESH
  });
  const readFreshMarketTicker = async market => {
    const tickers = await readFreshTickers([market]);
    return tickers.find(ticker => ticker?.market === market) || null;
  };
  const readMinuteCandles = (...args) => marketDataProvider.getMinuteCandles(...args);

  const inspectMarketQuote = (ticker, market, now = Date.now()) => {
    if (ticker?.market !== market) {
      return {
        fresh: false,
        market,
        sourceAsOf: null,
        ageMs: null,
        maximumAgeMs: null,
        reason: 'market_quote_unavailable'
      };
    }
    return inspectMarketQuoteFreshness(ticker, {
      now,
      maximumAgeSeconds: tradingSystem.maxCandleAgeSeconds
    });
  };

  const marketQuoteBlockResult = (marketQuotes, additionalBody = {}) => {
    const issues = marketQuotes.filter(entry => !entry.fresh);
    if (issues.length === 0) return null;
    const stale = issues.some(entry => entry.reason === 'market_source_stale' ||
      entry.reason === 'market_source_timestamp_in_future');
    return {
      status: 409,
      body: {
        success: false,
        code: stale ? 'MARKET_QUOTE_STALE' : 'MARKET_QUOTE_UNAVAILABLE',
        message: stale
          ? '선택한 종목의 최근 체결 시각이 오래되어 주문을 보내지 않았습니다.'
          : '선택한 종목의 시세와 원본 시각을 확인할 수 없어 주문을 보내지 않았습니다.',
        ...additionalBody,
        markets: issues.map(({ market, reason, sourceAsOf, ageMs, maximumAgeMs }) => ({
          market, reason, sourceAsOf, ageMs, maximumAgeMs
        }))
      }
    };
  };

  const requireFreshQuote = async (coin) => {
    const ticker = await readFreshMarketTicker(coin);
    const block = marketQuoteBlockResult([inspectMarketQuote(ticker, coin)]);
    return { ticker, block };
  };

  // LIVE 단일 레그 실행. 완전 체결 관측 시 execution을, 아니면 failure result를 반환.
  const runLiveLeg = async (params, { failureMessage, failureExtra } = {}) => {
    const execution = await executeLiveOrderWithEvidence(tradingSystem, params);
    if (hasCompleteObservedLiveFill(execution)) return { execution, failure: null };
    return {
      execution,
      failure: liveFillFailureResult(execution, { message: failureMessage, extra: failureExtra })
    };
  };

  return {
    tradingSystem,
    marketDataProvider,
    readFreshTickers,
    readFreshMarketTicker,
    readMinuteCandles,
    inspectMarketQuote,
    marketQuoteBlockResult,
    requireFreshQuote,
    runLiveLeg
  };
}
