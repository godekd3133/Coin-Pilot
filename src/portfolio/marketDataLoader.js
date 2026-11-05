// 기간별 포트폴리오용 봉 데이터 로더.
// - 코인: 업비트 공개 시세 API(키 불필요) — 60m/240m/일봉, 주봉은 일봉 집계
// - 주식: 토스증권 Open API — 일봉(1d), 주봉은 일봉 집계
// 모든 결과는 시간순 완료 봉 { time, open, high, low, close, volume } 배열이며
// 진행 중인 최신 봉은 제외한다.

import { aggregateWeekly, STOCK_WEEK_CLOSE_OFFSET_MS } from './chartAnalysis.js';
import { INTERVAL_MS } from './horizonProfiles.js';
import { toNumber } from '../stock/tossInvestClient.js';

// 가격이 고정된 스테이블코인은 차트 분석 대상에서 제외한다.
export const STABLECOINS = new Set(['USDT', 'USDC', 'USDS', 'DAI', 'TUSD', 'FDUSD', 'USDE', 'PYUSD', 'USD1']);

export function upbitCandleToBar(candle) {
  // candle_date_time_utc는 봉 시작 시각(UTC, 'Z' 없음)
  const time = Date.parse(`${candle.candle_date_time_utc}Z`);
  return {
    time,
    open: Number(candle.opening_price),
    high: Number(candle.high_price),
    low: Number(candle.low_price),
    close: Number(candle.trade_price),
    volume: Number(candle.candle_acc_trade_price ?? candle.candle_acc_trade_volume ?? 0)
  };
}

function dropIncomplete(bars, intervalMs, nowMs) {
  return bars.filter(bar => Number.isFinite(bar.time) && bar.time + intervalMs <= nowMs &&
    [bar.open, bar.high, bar.low, bar.close].every(v => Number.isFinite(v) && v > 0));
}

/**
 * 업비트 봉 로더. 모든 요청은 UpbitAPI(공유 rate limit/코디네이터)를 거친다 —
 * 같은 IP의 스캘퍼와 요청 예산을 나눠 쓰므로 직접 HTTP 호출을 하지 않는다.
 */
export class UpbitPublicCandleLoader {
  constructor({ upbit, now = Date.now } = {}) {
    if (!upbit) throw new Error('UpbitPublicCandleLoader requires an UpbitAPI client.');
    this.upbit = upbit;
    this.now = now;
  }

  async getKrwMarketsByTurnover(limit = 30) {
    const markets = (await this.upbit.getMarkets())
      .filter(m => m?.market?.startsWith('KRW-') && m.market_warning !== 'CAUTION' && m.market_event?.warning !== true)
      .map(m => m.market);
    const tickers = [];
    for (let i = 0; i < markets.length; i += 100) {
      tickers.push(...await this.upbit.getTicker(markets.slice(i, i + 100)));
    }
    return tickers
      .filter(t => t?.market && !STABLECOINS.has(t.market.split('-')[1]))
      .sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h)
      .slice(0, limit)
      .map(t => t.market);
  }

  async getPrices(markets) {
    const unique = [...new Set(markets.filter(Boolean))];
    const prices = new Map();
    for (let i = 0; i < unique.length; i += 100) {
      const tickers = await this.upbit.getTicker(unique.slice(i, i + 100));
      for (const ticker of Array.isArray(tickers) ? tickers : []) {
        const price = Number(ticker?.trade_price);
        if (ticker?.market && Number.isFinite(price) && price > 0) prices.set(ticker.market, price);
      }
    }
    return prices;
  }

  async _page(market, interval, to) {
    const options = to ? { to } : {};
    if (interval === '1d') return this.upbit.getDayCandles(market, 200, options);
    return this.upbit.getMinuteCandles(market, Number(interval.replace('m', '')), 200, options);
  }

  /**
   * @param {string} market
   * @param {'60m'|'240m'|'1d'|'1w'} interval
   * @param {number} count 필요한 완료 봉 수
   */
  async getBars(market, interval, count) {
    if (interval === '1w') {
      const daily = await this.getBars(market, '1d', count * 7 + 14);
      const weeks = aggregateWeekly(daily);
      // 마지막 주가 아직 끝나지 않았으면 제외
      return dropIncomplete(weeks, INTERVAL_MS['1w'], this.now()).slice(-count);
    }
    const collected = new Map();
    let to = null;
    while (collected.size < count + 1) {
      const page = await this._page(market, interval, to);
      if (!Array.isArray(page) || page.length === 0) break;
      for (const candle of page) {
        const bar = upbitCandleToBar(candle);
        collected.set(bar.time, bar);
      }
      const oldest = page.at(-1)?.candle_date_time_utc;
      if (!oldest || page.length < 200 || `${oldest}Z` === to) break;
      to = `${oldest}Z`;
    }
    const bars = [...collected.values()].sort((a, b) => a.time - b.time);
    return dropIncomplete(bars, INTERVAL_MS[interval], this.now()).slice(-count);
  }
}

/** 토스 일봉(최신순, timestamp=거래일 00:00 KST)을 시간순 봉으로. */
export function tossDailyToBar(candle) {
  return {
    time: Date.parse(candle.timestamp),
    open: toNumber(candle.openPrice),
    high: toNumber(candle.highPrice),
    low: toNumber(candle.lowPrice),
    close: toNumber(candle.closePrice),
    volume: toNumber(candle.volume, 0) * (toNumber(candle.closePrice, 0) || 0)
  };
}

export class TossCandleLoader {
  constructor({ client, now = Date.now }) {
    this.client = client;
    this.now = now;
  }

  async getBars(symbol, interval, count) {
    if (interval === '1w') {
      const daily = await this.getBars(symbol, '1d', count * 5 + 10);
      // KST 달력 주(월~금)로 묶고, 금요일 15:30 KST 마감 후에만 그 주를 완료로 본다.
      return dropIncomplete(aggregateWeekly(daily, { assetClass: 'stock' }), STOCK_WEEK_CLOSE_OFFSET_MS, this.now()).slice(-count);
    }
    if (interval !== '1d') throw new Error(`토스 주식은 ${interval} 봉을 지원하지 않습니다 (1d/1w만 사용).`);
    const raw = await this.client.getDailyCandles(symbol, count + 1);
    const bars = [...new Map(raw.map(tossDailyToBar).map(bar => [bar.time, bar])).values()]
      .sort((a, b) => a.time - b.time);
    // 국내 정규장 종료(15:30 KST) 이후에만 당일 봉을 완료로 본다.
    const closeOffset = (15 * 60 + 30) * 60 * 1000;
    return bars.filter(bar => Number.isFinite(bar.time) && bar.time + closeOffset <= this.now() &&
      [bar.open, bar.high, bar.low, bar.close].every(v => Number.isFinite(v) && v > 0)).slice(-count);
  }
}
