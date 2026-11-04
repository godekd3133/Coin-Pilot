// Trade-record normalisation for coins (strategy/smart/bundle records),
// stocks and horizon portfolios, so the activity feed can merge them without
// inventing values that were never recorded.

import { exitReasonLabel } from './text.js';

const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const validTime = value => (Number.isFinite(Date.parse(value || '')) ? value : null);

const MARKET_ALIASES = {
  'KRW-BTC': '비트코인', 'KRW-ETH': '이더리움', 'KRW-XRP': '엑스알피', 'KRW-SOL': '솔라나', 'KRW-DOGE': '도지코인',
  'KRW-ADA': '에이다', 'KRW-AVAX': '아발란체', 'KRW-DOT': '폴카닷', 'KRW-LINK': '체인링크', 'KRW-BCH': '비트코인캐시', 'KRW-ETC': '이더리움클래식'
};
const MARKET_SEARCH_EXTRA = { 'KRW-BTC': 'BITCOIN', 'KRW-ETH': 'ETHEREUM', 'KRW-XRP': 'RIPPLE 리플', 'KRW-SOL': 'SOLANA', 'KRW-DOGE': 'DOGECOIN' };

export function symbolOfMarket(coin) {
  return String(coin || '').replace(/^KRW-/, '');
}

export function marketDisplayName(market) {
  return market?.koreanName || market?.korean_name || market?.name || MARKET_ALIASES[market?.coin] || symbolOfMarket(market?.coin);
}

export function marketSearchText(market) {
  return `${market?.coin || ''} ${marketDisplayName(market)} ${market?.englishName || market?.english_name || ''} ${MARKET_SEARCH_EXTRA[market?.coin] || ''}`.toUpperCase();
}

export function tradeRecordPresentation(trade) {
  if (trade?.type === 'BUNDLE_TRADE') {
    const legs = ['sell', 'buy'].filter(side => trade[side]?.coin).map(side => tradeRecordPresentation({
      ...trade[side], type: side.toUpperCase(), volume: trade[side].amount,
      grossAmount: trade[side].grossValue, timestamp: trade.timestamp, source: 'bundle'
    }));
    return {
      asset: 'coin', coin: legs.map(leg => leg.coin).join(' '), marketLabel: legs.map(leg => symbolOfMarket(leg.coin)).join(' → '),
      side: 'bundle', label: '묶음 매매', time: validTime(trade.timestamp), legs,
      quantity: null, price: null, amount: null, profit: null, source: '묶음 주문 기록', reason: ''
    };
  }
  const rawAction = String(trade?.action || trade?.type || '').toUpperCase();
  const side = ['CLOSE', 'PARTIAL_CLOSE', 'SELL'].includes(rawAction) ? 'sell' : ['OPEN', 'BUY'].includes(rawAction) ? 'buy' : 'other';
  const strategy = trade?.source === 'strategy' || ['OPEN', 'CLOSE', 'PARTIAL_CLOSE'].includes(rawAction);
  const priceValue = side === 'sell' ? trade?.exitPrice ?? trade?.price : trade?.entryPrice ?? trade?.price;
  const quantityValue = strategy ? trade?.amount : trade?.volume ?? trade?.quantity;
  const amount = finite(trade?.grossAmount) ? Number(trade.grossAmount)
    : finite(priceValue) && finite(quantityValue) ? Number(priceValue) * Number(quantityValue) : null;
  const eventTime = trade?.timestamp || (side === 'sell' ? trade?.exitTime || trade?.entryTime : trade?.entryTime || trade?.exitTime);
  return {
    asset: 'coin',
    coin: String(trade?.coin || trade?.market || ''),
    side,
    label: rawAction === 'PARTIAL_CLOSE' ? '부분 매도' : side === 'sell' ? '매도' : side === 'buy' ? '매수' : '거래 기록',
    time: validTime(eventTime),
    quantity: finite(quantityValue) ? Number(quantityValue) : null,
    price: finite(priceValue) ? Number(priceValue) : null,
    amount,
    profit: finite(trade?.profit) ? Number(trade.profit) : null,
    source: strategy ? '전략 기록' : String(trade?.source || '').startsWith('smart') ? '조건 주문 기록' : '주문 기록',
    reason: exitReasonLabel(trade?.reason)
  };
}

/** Stock trader / horizon trades: { action, symbol, quantity, price, profit, at, sleeve? }. */
export function engineTradePresentation(trade, { asset, engine, sleeveLabel } = {}) {
  const action = String(trade?.action || '').toUpperCase();
  const side = action === 'SELL' ? 'sell' : action === 'BUY' ? 'buy' : 'other';
  const amount = finite(trade?.cost) && side === 'buy' ? Number(trade.cost)
    : finite(trade?.proceeds) && side === 'sell' ? Number(trade.proceeds)
      : finite(trade?.price) && finite(trade?.quantity) ? Number(trade.price) * Number(trade.quantity) : null;
  return {
    asset,
    coin: String(trade?.symbol || ''),
    marketLabel: String(trade?.symbol || '').replace(/^KRW-/, ''),
    side,
    label: side === 'sell' ? '매도' : side === 'buy' ? '매수' : '거래 기록',
    time: validTime(trade?.at || trade?.timestamp),
    quantity: finite(trade?.quantity) ? Number(trade.quantity) : null,
    price: finite(trade?.price) ? Number(trade.price) : null,
    amount,
    profit: finite(trade?.profit) ? Number(trade.profit) : null,
    source: [engine, sleeveLabel].filter(Boolean).join(' · '),
    reason: exitReasonLabel(trade?.reason),
    recovered: trade?.recovered === true
  };
}

export function filterRecords(records, { side = 'all', asset = 'all', query = '' } = {}) {
  const search = String(query || '').trim().toUpperCase();
  return (Array.isArray(records) ? records : [])
    .filter(item => asset === 'all' || item.asset === asset)
    .filter(item => side === 'all' || item.side === side || item.legs?.some(leg => leg.side === side))
    .filter(item => !search || (item.legs || [item]).some(leg => `${marketSearchText({ coin: leg.coin })} ${leg.marketLabel || ''}`.toUpperCase().includes(search)))
    .sort((a, b) => (Date.parse(b.time) || 0) - (Date.parse(a.time) || 0));
}

/** Coin records only (kept for the legacy filter semantics). */
export function filteredTradeRecords(trades, filter, query) {
  return filterRecords((Array.isArray(trades) ? trades : []).map(tradeRecordPresentation), { side: filter, query });
}
