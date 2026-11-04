// 기간별 포트폴리오 브로커 어댑터.
// 공통 인터페이스
//   getPrices(symbols)                → Map<symbol, price>
//   getAvailableCash(ledger)          → number (주문 가능 현금)
//   getAccountEquity(priceMap)        → number (실전: 계좌 전체 평가액)
//   getHeldQuantities()               → { symbol: quantity } (실전)
//   getOtherEngineQuantities()        → { symbol: quantity } (같은 계좌의 스캘퍼 보유분)
//   buy(symbol, amount, price, order, ledger)  → { quantity, price, cost } | { pendingOrderId } | { quantity: 0 }
//   sell(symbol, quantity, price, order, ledger) → { quantity, price, proceeds } | { pendingOrderId } | { belowMinimum: true }
//   resolveOrder(order)               → fill | { notFound: true } | { unresolved: true }
// order.clientOrderId는 매니저가 주문 전 장부에 먼저 기록한 멱등 식별자다.

import { ASSET_COSTS } from './horizonProfiles.js';
import { toNumber } from '../stock/tossInvestClient.js';

const COIN_MIN_ORDER = 5000;

/** 모의투자: 실시간 시세에 비용(수수료·슬리피지·거래세)을 적용해 장부에서 체결. */
export class PaperBroker {
  constructor({ assetClass, priceSource, costs = ASSET_COSTS[assetClass] }) {
    this.assetClass = assetClass;
    this.priceSource = priceSource;
    this.costs = costs;
  }

  getPrices(symbols) {
    return this.priceSource(symbols);
  }

  async getAvailableCash(ledger) {
    return Math.max(0, Number(ledger.cash) || 0);
  }

  async buy(symbol, amount, price, _order, ledger) {
    const budget = Math.min(amount, ledger.cash);
    if (this.assetClass === 'stock') {
      const quantity = Math.floor(budget / (price * (1 + this.costs.buyCostRate)));
      if (quantity <= 0) return { quantity: 0 };
      const cost = quantity * price * (1 + this.costs.buyCostRate);
      ledger.cash -= cost;
      return { quantity, price, cost };
    }
    if (budget < COIN_MIN_ORDER) return { quantity: 0 };
    const quantity = (budget * (1 - this.costs.buyCostRate)) / price;
    ledger.cash -= budget;
    return { quantity, price, cost: budget };
  }

  async sell(_symbol, quantity, price, _order, ledger) {
    const gross = quantity * price;
    if (this.assetClass === 'coin' && gross < COIN_MIN_ORDER) return { belowMinimum: true };
    const proceeds = gross * (1 - this.costs.sellCostRate);
    ledger.cash += proceeds;
    return { quantity, price, proceeds };
  }

  async resolveOrder() {
    return { notFound: true };
  }
}

/** 업비트 실전. 주문/계좌는 스캘퍼와 같은 인증 클라이언트(trader.upbit)를 사용한다. */
export class UpbitLiveBroker {
  constructor({ trader, quoteAsset = 'KRW', fillTimeoutMs = 20000 }) {
    this.trader = trader;
    this.quote = quoteAsset;
    this.fillTimeoutMs = fillTimeoutMs;
  }

  get upbit() {
    const client = this.trader.upbit;
    if (!this.trader.liveCredentialsConfigured) throw new Error('업비트 실거래 키가 등록되지 않았습니다.');
    return client;
  }

  async getPrices(symbols) {
    const markets = [...new Set(symbols.filter(Boolean))];
    const prices = new Map();
    for (let i = 0; i < markets.length; i += 100) {
      const tickers = await this.trader.upbit.getTicker(markets.slice(i, i + 100));
      for (const ticker of Array.isArray(tickers) ? tickers : []) {
        const price = Number(ticker?.trade_price);
        if (ticker?.market && Number.isFinite(price) && price > 0) prices.set(ticker.market, price);
      }
    }
    return prices;
  }

  async _accounts() {
    const accounts = await this.upbit.getAccounts();
    if (!Array.isArray(accounts)) throw new Error('업비트 계좌 응답이 올바르지 않습니다.');
    return accounts;
  }

  async getAvailableCash() {
    const account = (await this._accounts()).find(acc => acc.currency === this.quote);
    return account ? Number(account.balance) || 0 : 0;
  }

  async getAccountEquity(priceMap) {
    let equity = 0;
    const missing = [];
    const accounts = await this._accounts();
    for (const acc of accounts) {
      const total = (Number(acc.balance) || 0) + (Number(acc.locked) || 0);
      if (acc.currency === this.quote) { equity += total; continue; }
      const market = `${this.quote}-${acc.currency}`;
      const price = priceMap.get(market);
      if (Number.isFinite(price)) equity += total * price;
      else missing.push({ market, total, avg: Number(acc.avg_buy_price) || 0 });
    }
    if (missing.length > 0) {
      const prices = await this.getPrices(missing.map(item => item.market)).catch(() => new Map());
      for (const item of missing) equity += item.total * (prices.get(item.market) ?? item.avg);
    }
    return equity;
  }

  async getHeldQuantities() {
    const held = {};
    for (const acc of await this._accounts()) {
      if (acc.currency === this.quote) continue;
      held[`${this.quote}-${acc.currency}`] = (Number(acc.balance) || 0) + (Number(acc.locked) || 0);
    }
    return held;
  }

  async getOtherEngineQuantities() {
    const quantities = {};
    for (const [market, strategy] of this.trader.strategies || []) {
      const amount = Number(strategy?.currentPosition?.amount);
      if (Number.isFinite(amount) && amount > 0) quantities[market] = amount;
    }
    return quantities;
  }

  _fillFromOrder(order, side) {
    const volume = Number(order?.executed_volume) || 0;
    if (volume <= 0) return { quantity: 0 };
    let price = Number(order.avg_price);
    if (!Number.isFinite(price) || price <= 0) {
      const trades = Array.isArray(order.trades) ? order.trades : [];
      const funds = trades.reduce((s, t) => s + (Number(t.funds) || 0), 0);
      price = funds > 0 ? funds / volume : NaN;
    }
    if (!Number.isFinite(price) || price <= 0) return { unresolved: true };
    const fee = Number(order.paid_fee) || 0;
    return side === 'BUY'
      ? { quantity: volume, price, cost: volume * price + fee }
      : { quantity: volume, price, proceeds: volume * price - fee };
  }

  async _dispatch(market, side, args, order) {
    const result = await this.upbit.order(market, side === 'BUY' ? 'bid' : 'ask', args.volume, null, side === 'BUY' ? 'price' : 'market', order.clientOrderId);
    if (!result?.success) {
      // 거래소로 전송되지 않았거나 거절이 확정된 주문은 체결 없음으로 끝낸다.
      throw Object.assign(new Error(result?.error?.message || '주문 실패'), { definitive: true, code: result?.error?.code });
    }
    const uuid = result.data?.uuid;
    try {
      const fill = await this.upbit.waitForOrderFill(uuid, this.fillTimeoutMs);
      if (!fill?.order) return { pendingOrderId: order.clientOrderId };
      const parsed = this._fillFromOrder(fill.order, side);
      return parsed.unresolved ? { pendingOrderId: order.clientOrderId } : parsed;
    } catch {
      return { pendingOrderId: order.clientOrderId };
    }
  }

  async buy(market, amount, _price, order) {
    try {
      return await this._dispatch(market, 'BUY', { volume: Math.floor(amount) }, order);
    } catch (error) {
      if (error.definitive) return { quantity: 0, error: error.message };
      return { pendingOrderId: order.clientOrderId };
    }
  }

  async sell(market, quantity, price, order) {
    if (quantity * price < COIN_MIN_ORDER) return { belowMinimum: true };
    try {
      return await this._dispatch(market, 'SELL', { volume: Number(quantity.toFixed(8)) }, order);
    } catch (error) {
      if (error.definitive) return { quantity: 0, error: error.message };
      return { pendingOrderId: order.clientOrderId };
    }
  }

  async resolveOrder(order) {
    try {
      const found = await this.upbit.getOrder(order.clientOrderId, { identifier: true });
      if (!found) return { notFound: true };
      if (found.state === 'wait' || found.state === 'watch') return { unresolved: true };
      return this._fillFromOrder(found, order.side);
    } catch (error) {
      const status = error?.response?.status;
      if (status === 404) return { notFound: true };
      return { unresolved: true };
    }
  }
}

/** 토스증권 실전(국내주식). */
export class TossLiveBroker {
  constructor({ client, otherEngineQuantities = () => ({}) }) {
    this.client = client;
    this.otherEngineQuantitiesFn = otherEngineQuantities;
  }

  async getPrices(symbols) {
    const quotes = await this.client.getPrices(symbols.filter(Boolean));
    return new Map([...quotes].map(([symbol, quote]) => [symbol, quote.price]));
  }

  async getAvailableCash() {
    const cash = await this.client.getCashBuyingPower();
    if (cash === null) throw new Error('토스 매수 가능 금액을 확인할 수 없습니다.');
    return cash;
  }

  async getAccountEquity() {
    const cash = await this.getAvailableCash();
    const holdings = await this.client.getHoldings();
    return cash + holdings.reduce((sum, item) => sum + (toNumber(item?.marketValue?.amount, 0) || 0), 0);
  }

  async getHeldQuantities() {
    const held = {};
    for (const item of await this.client.getHoldings()) held[item.symbol] = Math.floor(toNumber(item.quantity, 0));
    return held;
  }

  async getOtherEngineQuantities() {
    return this.otherEngineQuantitiesFn() || {};
  }

  async _order(symbol, side, quantity, order) {
    let created;
    try {
      created = await this.client.createMarketOrder({ symbol, side, quantity, clientOrderId: order.clientOrderId });
    } catch (error) {
      // 4xx 응답은 접수 거절이 확정된 것으로 본다. 네트워크/5xx는 접수 여부 불명.
      if (error?.status >= 400 && error.status < 500) return { quantity: 0, error: error.message };
      return { pendingOrderId: order.clientOrderId };
    }
    order.orderId = created?.orderId || null;
    try {
      const fill = await this.client.waitForOrderFill(order.orderId);
      const qty = Math.floor(fill.filledQuantity || 0);
      if (qty <= 0) return { quantity: 0 };
      const price = fill.averageFilledPrice;
      if (!price) return { pendingOrderId: order.clientOrderId, orderId: order.orderId };
      return side === 'BUY'
        ? { quantity: qty, price, cost: qty * price + (fill.commission || 0) }
        : { quantity: qty, price, proceeds: qty * price - (fill.commission || 0) - (fill.tax || 0) };
    } catch {
      return { pendingOrderId: order.clientOrderId, orderId: order.orderId };
    }
  }

  async buy(symbol, amount, price, order) {
    const quantity = Math.floor(amount / (price * 1.002));
    if (quantity <= 0) return { quantity: 0 };
    return this._order(symbol, 'BUY', quantity, order);
  }

  async sell(symbol, quantity, _price, order) {
    const qty = Math.floor(quantity);
    if (qty <= 0) return { quantity: 0 };
    return this._order(symbol, 'SELL', qty, order);
  }

  async resolveOrder(order) {
    if (!order.orderId) return { unresolved: true };
    try {
      const fill = await this.client.waitForOrderFill(order.orderId, { timeoutMs: 3000 });
      const qty = Math.floor(fill.filledQuantity || 0);
      if (!['FILLED', 'CANCELED', 'REJECTED', 'REPLACED'].includes(fill.status)) return { unresolved: true };
      if (qty <= 0) return { quantity: 0 };
      const price = fill.averageFilledPrice;
      return order.side === 'BUY'
        ? { quantity: qty, price, cost: qty * price + (fill.commission || 0) }
        : { quantity: qty, price, proceeds: qty * price - (fill.commission || 0) - (fill.tax || 0) };
    } catch {
      return { unresolved: true };
    }
  }
}
